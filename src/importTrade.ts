import {
  formatEther,
  type Address,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { decodeTx, type TokenMove, type DecodedTx } from "./decodeTx.js";
import { insertTrade, type TradeRow } from "./db.js";
import { ToolError } from "./errors.js";
import { ROUTER_BY_ADDRESS } from "./routers.js";
import type { ChainProfile } from "./chains.js";
import { sanitizeForLogLine, type Logger } from "./logger.js";
// v85: the "which side is the stablecoin quote" check shares the one canonical
// registry — so import classification can't disagree with the P&L surfaces.
import { isStablecoin as isStable } from "./stablecoins.js";

export interface ImportResult {
  /** "inserted" if a new row was added, "duplicate" if already in trades by tx_hash. */
  status: "inserted" | "duplicate" | "skipped";
  /** Why this was skipped, when status==="skipped". */
  reason?: string;
  /** Inserted row id (when inserted). */
  rowId?: number;
  /** The decoded movements that the classifier looked at. */
  decoded?: DecodedTx;
  /** The trade row that was inserted (or would have been). */
  trade?: TradeRow;
}

/**
 * Classify a decoded tx into a synthetic trade row.
 *
 * Heuristic:
 *   - We need at least one debit and one credit on the wallet for it to be a swap.
 *   - The stablecoin side (if any) becomes "quote"; the other becomes "base".
 *   - If both sides are stable (e.g. USDC → DAI) we still record it: pick the larger
 *     absolute amount as the "base" so PnL has *something* sensible.
 *   - If neither side is stable, we still record it (base/quote = larger-side/smaller-side
 *     by absolute amount); price field then represents the *exchange rate*, not USD.
 *   - Pure transfers (one debit, no credit) get recorded with direction="sell" and
 *     aggregator="transfer", matching the live transfer.ts behaviour.
 *
 * `timestamp` is the canonical trade time stored on the row. Iter243: caller passes the
 * BLOCK timestamp for historical imports so the row lands in the right slot for PnL
 * ordering — pre-iter243 every import got `new Date().toISOString()` and a 6-month-old
 * trade was filed under today's date.
 */
export function classify(decoded: DecodedTx, chainName: string, account: string, timestamp: string): TradeRow | { skip: string } {
  const debits = decoded.moves.filter((m) => m.delta < 0n);
  const credits = decoded.moves.filter((m) => m.delta > 0n);

  // No movements (or only gas) — nothing to import.
  if (debits.length === 0 && credits.length === 0) {
    return { skip: "tx has no token movements involving the sender" };
  }

  // Transfer-out (only debits)
  if (credits.length === 0 && debits.length >= 1) {
    const main = debits[0];
    return {
      timestamp,
      chain: chainName,
      account,
      direction: "sell",
      base_token: main.token === "NATIVE" ? "" : (main.token as string),
      base_symbol: main.symbol,
      base_amount: main.amount.replace(/^-/, ""),
      quote_token: "",
      quote_symbol: null,
      quote_amount: "0",
      price: "0",
      tx_hash: decoded.hash,
      status: decoded.status === "success" ? "success" : "failed",
      gas_used: decoded.gasUsed ?? null,
      gas_price_wei: null,
      gas_cost_native: decoded.gasUsed
        ? formatEther(BigInt(decoded.gasUsed) * BigInt(decoded.effectiveGasPriceGwei ?? "0"))
        : null,
      aggregator: "transfer",
      fee_tier: null,
      notes: "imported via trade import — outbound transfer",
      // Iter635: capture block_number on imported success rows.
      block_number: decoded.block ?? null,
    };
  }

  // Receive-only (only credits): an airdrop, claim, or reward. Record as a buy with quote=0.
  if (debits.length === 0 && credits.length >= 1) {
    const main = credits[0];
    return {
      timestamp,
      chain: chainName,
      account,
      direction: "buy",
      base_token: main.token === "NATIVE" ? "" : (main.token as string),
      base_symbol: main.symbol,
      base_amount: main.amount.replace(/^\+/, ""),
      quote_token: "",
      quote_symbol: null,
      quote_amount: "0",
      price: "0",
      tx_hash: decoded.hash,
      status: decoded.status === "success" ? "success" : "failed",
      gas_used: decoded.gasUsed ?? null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "incoming",
      fee_tier: null,
      notes: "imported via trade import — incoming-only (airdrop / claim / reward)",
      // Iter635: capture block_number on imported success rows.
      block_number: decoded.block ?? null,
    };
  }

  // Swap: pick the stable side as quote if available, else the larger-by-amount side as base.
  let baseMove: TokenMove;
  let quoteMove: TokenMove;
  let direction: "buy" | "sell";

  const debitMain = debits[0];
  const creditMain = credits[0];
  const debitIsStable = isStable(debitMain.symbol);
  const creditIsStable = isStable(creditMain.symbol);

  if (debitIsStable && !creditIsStable) {
    // Sold stable for non-stable → buy base
    quoteMove = debitMain;
    baseMove = creditMain;
    direction = "buy";
  } else if (creditIsStable && !debitIsStable) {
    // Sold non-stable for stable → sell base
    baseMove = debitMain;
    quoteMove = creditMain;
    direction = "sell";
  } else {
    // Neither (or both) stable: pick base as the side with larger amount magnitude (after abs).
    // This is best-effort — PnL on these rows will be noisy.
    const debitAbs = Math.abs(parseFloat(debitMain.amount));
    const creditAbs = Math.abs(parseFloat(creditMain.amount));
    if (creditAbs >= debitAbs) {
      baseMove = creditMain;
      quoteMove = debitMain;
      direction = "buy";
    } else {
      baseMove = debitMain;
      quoteMove = creditMain;
      direction = "sell";
    }
  }

  const baseAmount = baseMove.amount.replace(/^[+-]/, "");
  const quoteAmount = quoteMove.amount.replace(/^[+-]/, "");
  const baseN = parseFloat(baseAmount);
  const quoteN = parseFloat(quoteAmount);
  const price = baseN > 0 ? (quoteN / baseN).toFixed(8) : "0";

  return {
    timestamp,
    chain: chainName,
    account,
    direction,
    base_token: baseMove.token === "NATIVE" ? "" : (baseMove.token as string),
    base_symbol: baseMove.symbol,
    base_amount: baseAmount,
    quote_token: quoteMove.token === "NATIVE" ? "" : (quoteMove.token as string),
    quote_symbol: quoteMove.symbol,
    quote_amount: quoteAmount,
    price,
    tx_hash: decoded.hash,
    status: decoded.status === "success" ? "success" : "failed",
    gas_used: decoded.gasUsed ?? null,
    gas_price_wei: null,
    gas_cost_native: null,
    aggregator: classifyAggregator(decoded.to),
    fee_tier: null,
    notes: "imported via trade import",
    // Iter635: capture block_number on imported swap rows.
    block_number: decoded.block ?? null,
  };
}

/** Best-effort: name the router the tx went through, based on well-known addresses. */
function classifyAggregator(to: Address | null): string {
  if (!to) return "unknown";
  return ROUTER_BY_ADDRESS.get(to.toLowerCase())?.aggregator ?? "unknown";
}

export async function importTradeFromTx(
  publicClient: PublicClient<Transport, Chain>,
  profile: ChainProfile,
  txHash: `0x${string}`,
  account: string,
  logger: Logger,
): Promise<ImportResult> {
  // Pre-check duplicate via tx_hash
  const { openDb } = await import("./db.js");
  const existing = openDb().prepare("SELECT id FROM trades WHERE tx_hash = ?").get(txHash) as { id: number } | undefined;
  if (existing) {
    return { status: "duplicate", reason: `tx already in trades (id=${existing.id})` };
  }

  let decoded: DecodedTx;
  try {
    decoded = await decodeTx(publicClient, profile, txHash);
  } catch (e) {
    // Iter300: include chain name + common causes so the operator can retry with the
    // right chain rather than dig through viem's deep error to figure out what went wrong.
    throw new ToolError(
      "TX_NOT_FOUND",
      `Could not fetch ${txHash} on ${profile.name}: ${(e as Error).message}. Possible causes: tx on a different chain, tx very recent and not propagated, or wrong hash.`,
    );
  }

  if (decoded.status === "pending") {
    return { status: "skipped", reason: "tx is pending — wait for confirmation before importing", decoded };
  }

  // Iter243: resolve the block timestamp so historical imports land at the right point
  // in the trade timeline. Pre-iter243 every import was stamped `new Date()` — a 6-month-
  // old tx looked like it happened today, breaking PnL ordering and any time-bounded
  // trade-history queries. If the block fetch fails (RPC down, very old block on a
  // pruned node), we fall back to "now" with a logged warning rather than refusing the
  // import — the trade row is still useful for PnL even with a fuzzy timestamp.
  let timestamp = new Date().toISOString();
  if (decoded.block != null) {
    try {
      const block = await publicClient.getBlock({ blockNumber: BigInt(decoded.block) });
      timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
    } catch (e) {
      // Iter479: sanitize before logging — viem multi-line getBlock errors.
      logger.warn(sanitizeForLogLine(
        `Block ${decoded.block} timestamp fetch failed (${(e as Error).message}); using now() — PnL ordering may be approximate.`,
      ));
    }
  }
  const classified = classify(decoded, profile.name, account, timestamp);
  if ("skip" in classified) {
    return { status: "skipped", reason: classified.skip, decoded };
  }

  logger.info(`Importing tx ${txHash} as ${classified.direction} via ${classified.aggregator}`);
  const rowId = insertTrade(classified);
  return { status: "inserted", rowId, decoded, trade: classified };
}
