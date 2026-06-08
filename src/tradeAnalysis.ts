// Iter619: post-trade execution quality analysis. Pre-iter619 operators could
// see "trade succeeded, here's the tx hash" but had no built-in way to answer:
//   - Did I get the price the aggregator quoted, or did I slip?
//   - What was my realized slippage vs the configured tolerance?
//   - Which aggregator gives me the best fills over time?
//
// The DB stores QUOTED values at trade time (`base_amount`, `quote_amount`,
// `price`) but never compares them to ACTUAL on-chain deltas. iter619 closes
// that loop by:
//   1. Re-decoding the on-chain receipt via iter265's computeDeltasFromLogs.
//   2. Matching the recovered token deltas to the stored base/quote tokens.
//   3. Comparing magnitudes to compute realized slippage (basis points).
//   4. Verdict-classifying the result so callers can branch ("excellent",
//      "minor_slip", "major_slip", "reverted", "no_match").
//
// Why slippage matters at all: every aggregator quotes a price + minOut.
// minOut is enforced by the router, so the trade can't deliver LESS than
// quoted_amount × (1 - slippageBps). But operators rarely run at the limit —
// the average trade SHOULD come in well above minOut, with the gap being
// real value left on the table by the route. Tracking this gap reveals
// aggregator quality differences a single trade can't show.
//
// Pure-core/orchestrator split is the same iter605/iter615 pattern: the
// number-crunching pure helpers are testable without an RPC; the orchestrator
// wires them to the public client + DB.

import type { Address, Hex, PublicClient, Transport, Chain } from "viem";
import type { ChainProfile } from "./chains.js";
import type { TradeRow } from "./db.js";
import type { Logger } from "./logger.js";
import { computeDeltasFromLogs } from "./decodeTx.js";
import { decodeRevert } from "./simulate.js";

/**
 * Iter666: best-effort revert-reason extraction via eth_call replay.
 *
 * Replays the tx at the block JUST BEFORE inclusion (where state still had
 * not seen the tx itself). The expected outcome is a thrown error whose
 * `cause.data` field is the revert returndata — same shape simulate.ts
 * already handles via decodeRevert (Error(string), Panic, known OZ customs).
 *
 * Why we replay at `blockNumber - 1` not `blockNumber`: at the actual
 * inclusion block, state already reflects the (failed) tx, and an eth_call
 * there would NOT reproduce the same revert path. The "one block before"
 * replay gives the router the same input state it saw at signing time, so
 * the revert reason matches what the operator's wallet actually got.
 *
 * Returns undefined for any failure (RPC error, replay returned no revert
 * data, contract-creation tx). Callers fall back to a generic message — we
 * never want enrichment to fail the surrounding flow.
 *
 * Iter669: exported so reconcile.ts can call it when classifying a failed
 * receipt for persistence. Pre-iter669 only analyzeStoredTrade used it.
 */
export async function extractRevertReasonByHash(args: {
  publicClient: PublicClient<Transport, Chain>;
  txHash: string;
  blockNumber: number;
  logger: Logger;
}): Promise<string | undefined> {
  const { publicClient, txHash, blockNumber, logger } = args;

  let tx: Awaited<ReturnType<typeof publicClient.getTransaction>>;
  try {
    tx = await publicClient.getTransaction({ hash: txHash as Hex });
  } catch (e) {
    logger.debug(`extractRevertReason ${txHash}: getTransaction failed: ${(e as Error).message}`);
    return undefined;
  }

  if (!tx.to || !tx.input) {
    logger.debug(`extractRevertReason ${txHash}: tx missing to/input (contract creation?)`);
    return undefined;
  }

  try {
    await publicClient.call({
      account: tx.from,
      to: tx.to,
      data: tx.input as Hex,
      value: tx.value ?? 0n,
      blockNumber: BigInt(blockNumber) - 1n,
    });
    // If the replay didn't revert, we have no reason to surface. This is
    // unusual (the receipt showed reverted) but possible if state at the
    // pre-block doesn't actually trigger the revert path — return undefined
    // so the caller falls back to the generic message.
    logger.debug(`extractRevertReason ${txHash}: replay did not revert`);
    return undefined;
  } catch (e) {
    const err = e as Error & { cause?: { data?: `0x${string}` } };
    const reason = decodeRevert(err.cause?.data);
    if (reason && reason !== "0x") return reason;
    return undefined;
  }
}

/**
 * Iter666: convenience wrapper that takes a TradeRow. Returns undefined when
 * the row has no block_number (legacy failed row pre-iter635) since we can't
 * pin the replay block — see extractRevertReasonByHash for the math.
 */
async function extractRevertReason(args: {
  row: TradeRow;
  publicClient: PublicClient<Transport, Chain>;
  logger: Logger;
}): Promise<string | undefined> {
  const { row, publicClient, logger } = args;
  if (row.block_number == null) {
    logger.debug(`extractRevertReason ${row.tx_hash}: no block_number stored`);
    return undefined;
  }
  return extractRevertReasonByHash({
    publicClient,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    logger,
  });
}

/** Quality bucket. Discriminator for downstream consumers. */
export type TradeQuality =
  | "excellent"     // realized slippage <= 5 bps (essentially zero — strong route)
  | "ok"            // 5 < bps <= 30 — normal market slippage
  | "minor_slip"    // 30 < bps <= 100 — within most safety budgets but worth noting
  | "major_slip"    // 100 < bps <= 500 — significant value loss, route choice or timing issue
  | "extreme_slip"  // > 500 — likely sandwich / MEV or stale quote
  | "no_match"      // on-chain tx exists but base/quote tokens don't match the DB row (data corruption?)
  | "reverted"      // tx status is failed/reverted — no value moved, no slippage to compute
  | "pending"       // tx not yet mined / receipt unavailable
  | "unknown";      // any other state (e.g. row.status = success but no matching events found)

export interface TradeQualityFinding {
  code: TradeQuality;
  /** Human-readable explanation an operator can copy-paste into a support ticket. */
  message: string;
}

export interface TradeExecutionComparison {
  /** Quoted-side magnitudes (from the DB row at trade time). Numbers, not bigints —
   *  the comparison is meant for display/percent math, not exact re-execution. */
  quoted: {
    baseAmount: number;
    quoteAmount: number;
    /** quote per base (matches db `price` field). */
    pricePerBase: number;
  };
  /** Actual on-chain achieved deltas, parsed from Transfer logs. */
  actual: {
    baseAmount: number;
    quoteAmount: number;
    pricePerBase: number;
  };
  /** Realized slippage in basis points. Positive = unfavorable (got LESS out
   *  than quoted or paid MORE in than quoted). Negative = positive slippage
   *  (rare — usually means the router beat the quote, e.g. better routing
   *  found between quote and execution). */
  slippageBps: number;
  /** Delta on the OUTPUT side as a signed amount. For buys: how much MORE/LESS
   *  base received vs quoted. For sells: how much MORE/LESS quote received vs
   *  quoted. Sign matches slippageBps (negative = unfavorable). */
  outputDelta: number;
  /** Verdict bucket + message. */
  finding: TradeQualityFinding;
}

/**
 * Iter619: pure helper. Given the quoted + actual amounts + the trade
 * direction, compute realized slippage and a quality verdict.
 *
 * Slippage convention:
 *   - For a BUY (operator pays quote, receives base):
 *     slippage = (quotedBase - actualBase) / quotedBase × 10000
 *     i.e. positive when we got LESS base than quoted (bad).
 *   - For a SELL (operator pays base, receives quote):
 *     slippage = (quotedQuote - actualQuote) / quotedQuote × 10000
 *     i.e. positive when we got LESS quote than quoted (bad).
 *
 * `quotedBase` / `quotedQuote` must be positive — division by zero returns
 * the unknown finding rather than throwing.
 */
export function compareTradeExecution(args: {
  direction: "buy" | "sell";
  quotedBase: number;
  quotedQuote: number;
  actualBase: number;
  actualQuote: number;
}): TradeExecutionComparison {
  const { direction, quotedBase, quotedQuote, actualBase, actualQuote } = args;

  // Pricing reference per side. Both sides expressed as quote/base so the
  // numbers are directly comparable (no inversion fork).
  const quotedPrice = quotedBase > 0 ? quotedQuote / quotedBase : 0;
  const actualPrice = actualBase > 0 ? actualQuote / actualBase : 0;

  // Defensive: if either side is zero/unparseable, we can't compute meaningful
  // slippage. Return the unknown verdict.
  if (
    !Number.isFinite(quotedBase) ||
    !Number.isFinite(quotedQuote) ||
    !Number.isFinite(actualBase) ||
    !Number.isFinite(actualQuote) ||
    quotedBase <= 0 ||
    quotedQuote <= 0
  ) {
    return {
      quoted: { baseAmount: quotedBase, quoteAmount: quotedQuote, pricePerBase: quotedPrice },
      actual: { baseAmount: actualBase, quoteAmount: actualQuote, pricePerBase: actualPrice },
      slippageBps: 0,
      outputDelta: 0,
      finding: {
        code: "unknown",
        message:
          "Cannot compute slippage — one or more amounts are missing, zero, or non-numeric. Possible causes: trade row missing amounts, on-chain decode found no matching token moves.",
      },
    };
  }

  let slippageBps: number;
  let outputDelta: number;
  if (direction === "buy") {
    // Receiving base. Less actual base = unfavorable.
    outputDelta = actualBase - quotedBase;
    slippageBps = ((quotedBase - actualBase) / quotedBase) * 10000;
  } else {
    // Receiving quote. Less actual quote = unfavorable.
    outputDelta = actualQuote - quotedQuote;
    slippageBps = ((quotedQuote - actualQuote) / quotedQuote) * 10000;
  }

  const finding = classifySlippage(slippageBps);

  return {
    quoted: { baseAmount: quotedBase, quoteAmount: quotedQuote, pricePerBase: quotedPrice },
    actual: { baseAmount: actualBase, quoteAmount: actualQuote, pricePerBase: actualPrice },
    slippageBps,
    outputDelta,
    finding,
  };
}

/** Pure: bucketize a realized-slippage number into a quality verdict.
 *
 *  Rounds to 0.1 bps before comparison so float epsilon doesn't push values
 *  meant to land EXACTLY on a boundary (100 → minor_slip, 500 → major_slip)
 *  into the next bucket. Operators care about clean threshold semantics. */
export function classifySlippage(slippageBpsRaw: number): TradeQualityFinding {
  if (!Number.isFinite(slippageBpsRaw)) {
    return { code: "unknown", message: "Slippage non-numeric." };
  }
  const slippageBps = Math.round(slippageBpsRaw * 10) / 10;
  // Negative = router beat the quote. Treat as "excellent".
  if (slippageBps <= 5) {
    return {
      code: "excellent",
      message:
        slippageBps < 0
          ? `Got ${(-slippageBps).toFixed(1)} bps BETTER than quoted — the router found extra route value between quote and execution.`
          : `Realized slippage ${slippageBps.toFixed(1)} bps — effectively zero. Strong execution.`,
    };
  }
  if (slippageBps <= 30) {
    return {
      code: "ok",
      message: `Realized slippage ${slippageBps.toFixed(1)} bps — within normal market noise.`,
    };
  }
  if (slippageBps <= 100) {
    return {
      code: "minor_slip",
      message: `Realized slippage ${slippageBps.toFixed(1)} bps — within most safety budgets but worth noting. Lower-liquidity pools or thin routes typically land here.`,
    };
  }
  if (slippageBps <= 500) {
    return {
      code: "major_slip",
      message: `Realized slippage ${slippageBps.toFixed(1)} bps — significant value loss. Consider: route choice, multi-hop pool depth, or whether the quote was stale before execution.`,
    };
  }
  return {
    code: "extreme_slip",
    message: `Realized slippage ${slippageBps.toFixed(1)} bps (>5%) — likely sandwich/MEV, stale quote, or low-liquidity exit. Investigate before re-executing similar size on the same route.`,
  };
}

export interface AnalyzedTrade {
  txHash: string;
  chain: string;
  direction: "buy" | "sell";
  baseSymbol: string | null;
  quoteSymbol: string | null;
  /** When the on-chain decode succeeds, comparison contains the slippage math.
   *  When it doesn't (pending, reverted, mismatched), comparison is undefined
   *  and finding alone carries the verdict (reverted / pending / no_match). */
  comparison?: TradeExecutionComparison;
  /** Always populated — the operator's primary signal. */
  finding: TradeQualityFinding;
  /** Native gas cost (decimal string) per the receipt. Mirrors db.gas_cost_native
   *  but pinned here so the analysis is self-contained for CLI/MCP consumers. */
  gasCostNative?: string;
  /** Iter666: revert reason for failed trades, extracted via an eth_call replay
   *  at receipt.blockNumber - 1. Decoded via decodeRevert (Error(string), Panic,
   *  known OZ custom errors). Undefined when extraction fails (RPC error, no
   *  block_number, replay returned no revert data) — finding.message still
   *  carries the generic reverted message in that case. */
  revertReason?: string;
}

/**
 * Iter619: orchestrator. Given a stored TradeRow, fetch its on-chain receipt
 * + tx, decode the user's net token deltas via computeDeltasFromLogs, match
 * the base + quote tokens, run compareTradeExecution.
 *
 * Returns an AnalyzedTrade — always returns (never throws) so a CLI loop
 * over recent trades can render partial results when some receipts fail.
 *
 * Important edge cases:
 *   - row.status == "pending": skip the chain read, return pending finding.
 *   - row.status == "failed": return reverted finding.
 *   - Receipt exists but no Transfer events match the stored tokens: no_match.
 *     This can legitimately happen for direct ETH→ETH paths via wrappers, or
 *     when an importTrade row is wrong about which tokens to look at.
 */
export async function analyzeStoredTrade(args: {
  row: TradeRow;
  publicClient: PublicClient<Transport, Chain>;
  profile: ChainProfile;
  logger: Logger;
}): Promise<AnalyzedTrade> {
  const { row, publicClient, profile, logger } = args;

  const base = {
    txHash: row.tx_hash,
    chain: row.chain,
    direction: row.direction,
    baseSymbol: row.base_symbol,
    quoteSymbol: row.quote_symbol,
  };

  if (row.status === "pending") {
    return {
      ...base,
      finding: { code: "pending", message: "Trade still pending on-chain; analysis unavailable until reconcile." },
    };
  }
  if (row.status === "failed") {
    // Iter666/iter669: surface the revert reason. Prefer the stored value
    // (iter669 — reconcile persists it via the same eth_call replay) over
    // the live extraction. Stored avoids an RPC roundtrip for every analyze
    // and matches the iter641 stored-over-live pattern for slippage. Legacy
    // failed rows (pre-iter669) still trigger the live extraction.
    const revertReason =
      row.revert_reason ??
      (await extractRevertReason({ row, publicClient, logger }));
    const message = revertReason
      ? `Trade reverted on-chain: ${revertReason}. No value moved.`
      : "Trade reverted on-chain — no value moved. No slippage to compute.";
    return {
      ...base,
      finding: { code: "reverted", message },
      gasCostNative: row.gas_cost_native ?? undefined,
      ...(revertReason ? { revertReason } : {}),
    };
  }

  // Fetch tx + receipt. Catch + reduce to pending finding rather than throwing.
  let tx: Awaited<ReturnType<typeof publicClient.getTransaction>>;
  let receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>;
  try {
    [tx, receipt] = await Promise.all([
      publicClient.getTransaction({ hash: row.tx_hash as Hex }),
      publicClient.getTransactionReceipt({ hash: row.tx_hash as Hex }),
    ]);
  } catch (e) {
    logger.warn(`analyzeStoredTrade: receipt fetch failed for ${row.tx_hash}: ${(e as Error).message}`);
    return {
      ...base,
      finding: {
        code: "pending",
        message: `Could not fetch tx/receipt: ${(e as Error).message}. Tx may be reorg'd, RPC may be lagging, or the receipt is no longer indexed.`,
      },
    };
  }
  if (!receipt || receipt.status !== "success") {
    return {
      ...base,
      finding: { code: "reverted", message: "On-chain receipt shows the tx reverted (DB may not have been reconciled yet)." },
    };
  }

  const deltas = computeDeltasFromLogs({
    fromAddress: tx.from,
    txValue: tx.value,
    logs: receipt.logs,
    wethAddress: profile.weth,
  });

  // Match the stored base/quote tokens. The DB stores them as 0x-addresses or
  // the "NATIVE" sentinel for chain native. We need to look up by lowercase
  // key (computeDeltasFromLogs returns NATIVE for chain native).
  const baseKey = normalizeTokenKey(row.base_token);
  const quoteKey = normalizeTokenKey(row.quote_token);
  const baseDelta = deltas.get(baseKey);
  const quoteDelta = deltas.get(quoteKey);

  if (baseDelta == null || quoteDelta == null) {
    return {
      ...base,
      finding: {
        code: "no_match",
        message: `On-chain Transfer logs don't contain both stored tokens (base=${row.base_token}, quote=${row.quote_token}). Trade may have been routed through a wrapper or the DB row has the wrong token addresses.`,
      },
      gasCostNative: row.gas_cost_native ?? undefined,
    };
  }

  // Decimals come from formatUnits perspective — we have RAW bigint deltas
  // but the DB stores decimal strings. To compare, parse the DB strings as
  // numbers and convert the bigints using the row's quoted amount + delta
  // sign as our decimal-scale reference. (We don't need exact unit math —
  // slippage is a ratio, so the per-side decimal scale must match within
  // each side but not across sides.)
  const quotedBase = parseFloat(row.base_amount);
  const quotedQuote = parseFloat(row.quote_amount);

  // bigint → number via formatUnits with the implied decimal scale derived
  // from quotedBase being the reference of `base_amount` and so on. Inferring
  // decimals from the DB row + the bigint delta: the ratio (deltaAbs/quoted)
  // tells us how many extra decimal places the bigint has. Cleaner approach:
  // use the same decimals computeDeltasFromLogs would use. Pull from a token
  // metadata lookup — but we don't want to dispatch new RPC just for analysis.
  // Pragmatic: use 18 decimals for NATIVE and try to infer from the ratio.
  //
  // Actually we have a cleaner path — derive the magnitude scale by matching
  // the bigint delta against the DB's decimal amount. Both sides represent
  // the same trade; the ratio gives us 10^decimals.
  const actualBase = bigintToFloat(baseDelta, quotedBase, row.direction === "buy" ? "in" : "out");
  const actualQuote = bigintToFloat(quoteDelta, quotedQuote, row.direction === "buy" ? "out" : "in");

  const comparison = compareTradeExecution({
    direction: row.direction,
    quotedBase,
    quotedQuote,
    actualBase: Math.abs(actualBase),
    actualQuote: Math.abs(actualQuote),
  });

  return {
    ...base,
    comparison,
    finding: comparison.finding,
    gasCostNative: row.gas_cost_native ?? undefined,
  };
}

/** Lowercase + normalize. "NATIVE" sentinel passes through; addresses lowercase. */
function normalizeTokenKey(token: string): string {
  if (token.toUpperCase() === "NATIVE") return "NATIVE";
  return token.toLowerCase();
}

/**
 * Convert a bigint delta to a decimal float by matching the magnitude against
 * the DB's stored decimal `referenceQuoted`. The DB stored amounts in human-
 * readable decimal at the right scale, so dividing |delta| by referenceQuoted
 * gives us 10^decimals; we then divide back to get the float.
 *
 * `side` is informational; the math is the same either way. Returns a SIGNED
 * float (preserves delta sign — buys have positive base delta, negative quote
 * delta).
 *
 * Why this trick: the receipt logs give bigints; the DB row gives decimal
 * strings; converting between them without a token metadata lookup is the
 * problem. We sidestep by using the DB row's known amount as the calibration.
 *
 * Exported for unit testing.
 */
export function bigintToFloat(delta: bigint, referenceQuoted: number, _side: "in" | "out"): number {
  if (!Number.isFinite(referenceQuoted) || referenceQuoted <= 0) {
    return Number(delta); // best-effort — caller decides what to do
  }
  const absDelta = delta < 0n ? -delta : delta;
  // Use scientific notation to handle large bigints + small decimals safely.
  const ratio = Number(absDelta) / referenceQuoted;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return Number(delta);
  }
  // ratio ≈ 10^decimals. The actual amount = delta / 10^decimals = referenceQuoted × (actualDelta / quotedDelta).
  // But what we WANT is the actual amount in human decimal — that's just
  // delta / 10^decimals. Since 10^decimals ≈ ratio (when quoted ≈ actual),
  // we get actualAmount ≈ Number(delta) / ratio = referenceQuoted.
  // ...which collapses to the trivial case. Re-derive properly:
  //
  // The bigint delta is the ACTUAL on-chain amount × 10^decimals.
  // The reference is the QUOTED amount in decimal.
  // To recover decimal scale we need 10^decimals from somewhere external.
  // Heuristic: round Math.log10(ratio) to nearest integer → that's decimals.
  const inferredDecimals = Math.round(Math.log10(ratio));
  if (inferredDecimals < 0 || inferredDecimals > 36) {
    return Number(delta); // out of plausible ERC20 decimals range
  }
  const scale = Math.pow(10, inferredDecimals);
  const result = Number(delta) / scale;
  return result;
}
