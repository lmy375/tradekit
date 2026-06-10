import {
  formatUnits,
  parseUnits,
  type Address,
  type PublicClient,
  type WalletClient,
  type Account,
  type Transport,
  type Chain,
} from "viem";
import { ERC20_ABI } from "./constants.js";
import { parseSizingSentinel, applyFractionBig, describeSentinel } from "./sizing.js";
import { ToolError, toToolError, classifyReason, type NextAction } from "./errors.js";
import { aggregateQuote, type AggregatorQuote, type ProviderName } from "./aggregator.js";
import { simulateTx, type SimulationResult } from "./simulate.js";
import { enforceSafety, enforcePreflightSafety } from "./safety.js";
import { getCurrentPrice } from "./price.js";
import { getToken, isNativeSentinel, NATIVE_TOKEN } from "./tokens.js";
import { waitForReceiptWithTimeout } from "./receipt.js";
import { withAccountLock, accountLockKey } from "./accountLock.js";
import { compactMessage } from "./format.js";
import type { ChainProfile } from "./chains.js";
import type { Config } from "./config.js";
import { sanitizeForLogLine, type Logger } from "./logger.js";

export interface TradeRequest {
  /** "buy" the base token (spending quote), or "sell" the base token (receiving quote). */
  direction: "buy" | "sell";
  /** Base token address, or "ETH"/"NATIVE" for the chain's native asset. */
  base: Address | "ETH";
  /** Quote token address (must be ERC20; e.g. USDC). */
  quote: Address;
  /** Exact base amount (decimal string). Mutually exclusive with quoteAmount. */
  baseAmount?: string;
  /** Exact quote amount (decimal string). Mutually exclusive with baseAmount. */
  quoteAmount?: string;
  slippageBps?: number;
  /** If true, simulate only; do not send tx. */
  simulate?: boolean;
  /** Free-form note recorded alongside the trade row (e.g. agent run-id, intent). */
  note?: string;
  /**
   * Iter620: bypass the gas-budget safety check (safety.gas.maxGasPctOfTrade /
   * maxGasNativePerChain). Use only when the operator has accepted the cost
   * explicitly — e.g. a small trade on L1 they NEED to execute right now and
   * gas economics aren't the priority. Bypass is logged at warn level so it
   * shows up in the audit trail. Other safety rails (slippage, USD limits,
   * blacklists) are NOT affected — this flag is gas-budget-specific.
   */
  forceGas?: boolean;
  /**
   * Iter625: lock-in protection. When set, the trade flow compares the live
   * re-quoted amountOut against `expectedAmountOut` (typically the amountOut
   * the caller received from a prior `quote` call). If the live quote is
   * worse than expected by more than `maxQuoteDeviationBps` (default 100 bps),
   * the trade aborts with QUOTE_DEVIATION_EXCEEDED.
   *
   * Decimal string (e.g. "2998.5") — same shape as quote.amountOut output so
   * an agent capturing the quote's response can pass it straight back.
   *
   * Opt-in: omitting `expectedAmountOut` skips the check entirely (pre-iter625
   * behavior — backward compatible).
   */
  expectedAmountOut?: string;
  /** Iter625: tolerance in basis points. Default 100 (1%). */
  maxQuoteDeviationBps?: number;
  /**
   * Iter642: when true AND `slippageBps` is undefined, derive a slippage cap
   * from the operator's own realized slippage history on the canonical pair
   * (iter641-stored `realized_slippage_bps`). Falls back to the operator's
   * default when sample size is below the threshold (need at least 5 samples
   * on the same pair). Ignored when slippageBps is explicitly set.
   *
   * Use to remove manual slippage guessing — the operator's own history
   * tells them what to budget.
   */
  autoSlippage?: boolean;
  /**
   * Iter648: strategy tag stored on the trade row. Different from `note` —
   * `strategy` is indexed for cross-cut queries ("show me PnL for the dca-eth
   * strategy"); `note` is free-text. Common patterns: "dca-eth", "rebal-q1",
   * "swing-pepe", "manual".
   */
  strategy?: string;
}

/**
 * Iter625: default deviation tolerance. 100 bps = 1%. Operators with volatile
 * trades will want to raise this; operators trading stable pairs may set it
 * lower (e.g. 25 bps) to catch even small drifts.
 */
export const DEFAULT_QUOTE_DEVIATION_BPS = 100;

/**
 * Iter625: pure helper. Compare a live re-quoted amountOut against the
 * caller's expected. The DIRECTION matters: we only fail when the live quote
 * is WORSE than expected (less out). Beating the expected (more out) is
 * always fine — that's the router finding better routing between quote and
 * execute.
 *
 * Returns { ok: true } when the deviation is within tolerance OR the new
 * quote is better. Returns { ok: false, actualBps } when the deviation
 * exceeds the cap.
 *
 * Inputs are decimal strings (matches the on-the-wire shape from quote
 * responses). Returns { ok: true } for unparseable inputs — we don't want
 * a malformed expected value to silently block trades; the caller can pre-
 * validate if they need strict parsing.
 *
 * Exported for unit testing without standing up the full trade stack.
 */
export function checkQuoteDeviation(args: {
  expectedAmountOut: string;
  actualAmountOut: string;
  maxBps: number;
}): { ok: true } | { ok: false; actualBps: number; expected: number; actual: number } {
  const expected = parseFloat(args.expectedAmountOut);
  const actual = parseFloat(args.actualAmountOut);
  if (!Number.isFinite(expected) || expected <= 0) return { ok: true };
  if (!Number.isFinite(actual) || actual <= 0) return { ok: true };
  // Better than expected = ok.
  if (actual >= expected) return { ok: true };
  // Worse than expected: compute the deviation in bps.
  // deviation = (expected - actual) / expected * 10000
  const actualBps = ((expected - actual) / expected) * 10000;
  if (actualBps > args.maxBps) {
    return { ok: false, actualBps, expected, actual };
  }
  return { ok: true };
}

export interface TradeContext {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
  profile: ChainProfile;
  config: Config;
  logger: Logger;
  /** Active account label (for audit log + db). */
  accountLabel: string;
}

export interface TradeResult {
  ok: boolean;
  simulated: boolean;
  /** ISO timestamp when the trade was executed (or simulated). Lets downstream
   *  consumers correlate with the DB trade row, log lines, and external systems. */
  timestamp: string;
  /** Iter915: wall-clock from executeTrade entry to return (same value as
   *  phaseTiming.totalMs, surfaced at top-level for parity with the rest of
   *  the MCP tool convention — agents tailing trade responses read
   *  `response.elapsedMs` uniformly without descending into phaseTiming).
   *  Best-effort; absent on legacy paths that haven't been instrumented. */
  elapsedMs?: number;
  direction: "buy" | "sell";
  baseToken: Address;
  baseSymbol?: string;
  quoteToken: Address;
  quoteSymbol?: string;
  baseAmount: string;
  quoteAmount: string;
  /** quote per base, decimal string. */
  price: string;
  /** USD value of the trade (best-effort). */
  estimatedUsd?: number;
  /** Fraction (0..1+) of the relevant input-token balance this trade is spending.
   *  >0.5 = caller should double-check; >1 = exceeds balance (will revert). */
  balanceFraction?: number;
  /** Iter408: when "max" was used on a native base ("sell max" with --base ETH),
   *  the amount we reserved for swap gas (decimal native units). Matches iter407's
   *  TransferResult.gasReserveNative shape so consumers get the same field name
   *  across transfer and trade. Absent for ERC20 sell max + explicit-amount trades. */
  gasReserveNative?: string;
  aggregator: string;
  allowanceTarget: Address;
  to: Address;
  txHash?: string;
  status?: "success" | "failed";
  gasUsed?: string;
  gasCostNative?: string;
  /** Gas cost in USD (best-effort; null when native-token price isn't known).
   *  Populated for BOTH simulated quotes (from simulation.gasCostNative × native price)
   *  AND executed trades (from receipt.gasUsed × effectiveGasPrice × native price). */
  gasCostUsd?: number;
  simulation?: SimulationResult;
  nextActions?: NextAction[];
  /** Block-explorer URL for the tx, populated whenever a hash exists (success OR
   *  revert). Pre-iter482 the URL only appeared inside `decoded.explorerUrl`, which is
   *  only computed for status="success" — so a reverted trade left the operator with
   *  just a bare hash and no actionable click-target to inspect the revert reason. */
  explorerUrl?: string;
  /** Populated for non-simulate trades that landed on chain: decoded Transfer events,
   *  net token deltas, and a one-line `summary`. See decodeTx.ts. */
  decoded?: import("./decodeTx.js").DecodedTx;
  /**
   * Iter638: per-phase wall-clock timing in milliseconds. Lets operators
   * debugging slow trades see WHERE the latency is — pre-iter638 the only
   * signal was total wall-clock.
   *
   * Phases:
   *   - quoteMs: aggregateQuote fetch (initial + any fallback attempts summed)
   *   - simulateMs: simulateTx (zero when approval is needed, since we skip
   *     simulate on that path; sum across fallback attempts)
   *   - sendMs: sendTransaction (broadcast to mempool)
   *   - receiptMs: waitForReceiptWithTimeout (the typical long-pole)
   *   - totalMs: wall-clock from executeTrade entry to return
   *
   * All times are best-effort and may be 0 for phases that didn't run (e.g.
   * simulate=true never sends, so sendMs / receiptMs are 0). The timing
   * doesn't include the safety-check / rate-limit / gas-budget phases — those
   * are CPU-bound + sub-ms; bundling them into a single "preflightMs" would
   * lump trivial work with the I/O-bound phases that actually move latency.
   */
  phaseTiming?: {
    quoteMs: number;
    simulateMs: number;
    sendMs: number;
    receiptMs: number;
    totalMs: number;
  };
  /**
   * Iter644: when autoSlippage=true was passed, this surfaces the resolved
   * suggestion (suggestedBps used + reason + sampleCount + percentile data).
   * Lets operators verify what auto-slippage decided without parsing logs.
   * Undefined when autoSlippage wasn't used.
   */
  slippageSuggestion?: import("./slippageSuggest.js").SlippageSuggestion;
  /**
   * Iter682: predictive failure pattern for the trade's base/quote pair on
   * this chain. Surfaced when the operator has recent (7d) failures on the
   * SAME pair that share a dominant reason (>=3 occurrences, >=50% of
   * failures). Empty/absent when there's no pattern or no recent failures.
   *
   * Operators dispatching via MCP can branch on `dominantReason` — e.g.
   * agents preferring `--auto-slippage` when the pattern is "Too little
   * received". CLI text mode renders this as a prominent warning.
   *
   * The pattern is informational: it does NOT block the trade. iter641 +
   * iter642 + iter682 form a 3-layer slippage defense — historical
   * suggestion, opt-in auto-derivation, predictive warning.
   */
  recentFailurePattern?: {
    /** Total failures on this pair in the lookback window. */
    total: number;
    /** Lookback window in days (currently fixed at 7). */
    windowDays: number;
    /** The dominant reason — most common across the failures, ≥50% share. */
    dominantReason: string;
    /** Count of failures with the dominant reason. */
    dominantCount: number;
    /** Iter700: ISO timestamp of the most recent failure with this dominant
     *  reason. Lets the operator/agent distinguish an ongoing pattern (last
     *  failure was 20 min ago — same root cause still hitting) from a stale
     *  one (last failure was 5 days ago — issue may already be resolved).
     *  Optional only because the iter669 row may not have had a timestamp
     *  in upstream paths — in practice every persisted trade has one. */
    dominantLastSeen?: string;
    /** Iter686: structured next actions derived from running classifyReason
     *  on dominantReason. Empty / absent when no pattern matches the
     *  classifier table. Format mirrors ToolError.nextActions so MCP agents
     *  can dispatch the same shape they already know — e.g. SLIPPAGE_EXCEEDED
     *  → "Re-quote with higher slippageBps", NEEDS_APPROVAL → "Re-approve",
     *  etc. Empty array distinguishes "we tried to classify but no rule
     *  matched" from undefined ("we didn't classify"). */
    suggestedActions?: NextAction[];
  };
}

// ── token metadata helpers ───────────────────────────────────
// Decimals & symbol come from tokens.getToken which caches by (chainId, address).

/**
 * Iter642: best-effort canonical pair key from what we know before getToken
 * has resolved symbols. Used by the auto-slippage path which runs BEFORE
 * the metadata fetch (we want auto-slippage to inform the safety pre-flight,
 * which is also pre-metadata). When a native symbol is known we use it;
 * for ERC20 we use the address (uppercased) which is stable across calls.
 *
 * Limitation: rows matching by symbol won't be picked up when the request
 * uses raw addresses (vs. resolved symbols). In practice this is fine —
 * most callers (CLI / MCP) resolve the symbol upstream via resolveTradePair
 * and feed it through, but a programmatic caller passing only addresses
 * gets a smaller sample set.
 */
function canonicalGuessPair(
  baseSym: string | null,
  baseAddr: string,
  quoteSym: string,
  quoteAddr: string,
): string {
  const b = (baseSym ?? baseAddr).toUpperCase();
  const q = (quoteSym ?? quoteAddr).toUpperCase();
  return b < q ? `${b}/${q}` : `${q}/${b}`;
}

/** Lowercase-canonical address pair "0xbase/0xquote" lexicographically sorted. */
function canonicalAddressPair(addrA: string, addrB: string): string {
  const a = addrA.toLowerCase();
  const b = addrB.toLowerCase();
  return a < b ? `${a}/${b}` : `${b}/${a}`;
}

// ── approval ─────────────────────────────────────────────────

async function ensureApproval(
  ctx: TradeContext,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  const allowance = (await ctx.publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [ctx.walletClient.account.address, spender],
  })) as bigint;

  if (allowance >= amount) return;

  ctx.logger.info(`Approving ${token} → ${spender} for ${amount}`);
  const hash = await ctx.walletClient.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount * 2n],
  });
  await waitForReceiptWithTimeout(ctx.publicClient, hash, ctx.profile);
  ctx.logger.info(`Approve tx: ${hash}`);
}

// ── main entry ───────────────────────────────────────────────

export async function executeTrade(req: TradeRequest, ctx: TradeContext): Promise<TradeResult> {
  // Iter28: global engine kill switch. Simulations are exempt
  // (read-only, no state change); real trades hard-reject with
  // ENGINE_LOCKED so the operator sees a clean rejection vs. a
  // silent skip. Check BEFORE the per-account lock to fail fast.
  if (!req.simulate) {
    const { assertEngineNotLocked } = await import("./engineLock.js");
    assertEngineNotLocked({ context: `manual trade ${req.direction} ${req.base}/${req.quote}` });
  }
  // Simulations are read-only — no budget impact, no race — so let them run in parallel.
  // Real trades serialize per account so the safety check + DB insert window is atomic;
  // otherwise two concurrent trades each pass the daily-USD cap and both land.
  if (req.simulate) return executeTradeInner(req, ctx);
  return withAccountLock(accountLockKey(ctx.accountLabel), () => executeTradeInner(req, ctx));
}

async function executeTradeInner(req: TradeRequest, ctx: TradeContext): Promise<TradeResult> {
  // Iter638: phase timing — start the total clock + accumulators per phase.
  // Each accumulator is incremented around the corresponding I/O call.
  const t0 = Date.now();
  const timing = { quoteMs: 0, simulateMs: 0, sendMs: 0, receiptMs: 0 };

  // ── 1. Resolve tokens & amounts ──
  const baseIsNative = typeof req.base === "string" && (req.base === "ETH" || req.base.toUpperCase() === "ETH" || req.base.toUpperCase() === "NATIVE");
  const baseAddr: Address = baseIsNative ? NATIVE_TOKEN : (req.base as Address);
  const quoteAddr: Address = req.quote;

  if ((req.baseAmount == null) === (req.quoteAmount == null)) {
    const bothSet = req.baseAmount != null && req.quoteAmount != null;
    const requiredField = req.direction === "buy" ? "quoteAmount" : "baseAmount";
    const otherField = req.direction === "buy" ? "baseAmount" : "quoteAmount";
    throw new ToolError(
      "INVALID_PARAMS",
      bothSet
        ? `Both baseAmount and quoteAmount provided — ${req.direction} accepts only ${requiredField}. Drop ${otherField}.`
        : `Missing amount — ${req.direction} requires ${requiredField} (the amount of ${req.direction === "buy" ? "quote to SPEND" : "base to SELL"}).`,
      {
        details: { direction: req.direction, requiredField, providedBaseAmount: req.baseAmount, providedQuoteAmount: req.quoteAmount },
        nextActions: [
          {
            tool: req.direction,
            params: { [requiredField]: "<amount>" },
            reason: `Re-call ${req.direction} with only ${requiredField} (CLI: \`tradekit trade ${req.direction} --${requiredField === "quoteAmount" ? "quoteAmount" : "baseAmount"} <amount>\`).`,
          },
        ],
      },
    );
  }
  // Iter372: reject same-token swap up front. Pre-iter372 a typo like
  //   `tradekit trade buy --base USDC --quote USDC`
  // sailed past resolution (both resolve to the same address), into the aggregator
  // (which rejects with a vague "no route" or "insufficient liquidity"), and the
  // operator burned a quote-fetch roundtrip plus saw a misleading error. Catch the
  // degenerate case at the boundary. Note: ETH↔WETH wrap is NOT blocked here because
  // baseIsNative makes baseAddr === NATIVE_TOKEN sentinel which is distinct from
  // profile.weth — operators using the trade flow to wrap/unwrap (a legitimate use)
  // sail through to the aggregator's native handling.
  if (!baseIsNative && baseAddr.toLowerCase() === quoteAddr.toLowerCase()) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Base and quote tokens are identical (${baseAddr}); a same-token swap is degenerate. Use different tokens, or transfer if you want to move the same asset.`,
      {
        details: { base: baseAddr, quote: quoteAddr },
        nextActions: [
          {
            tool: "transfer",
            params: { token: baseAddr },
            reason: `If you wanted to move the same asset to another address, use transfer (CLI: \`tradekit transfer --token <addr-or-symbol> --to <recipient> --amount <amount>\`).`,
          },
        ],
      },
    );
  }

  // Iter642: resolve slippage. Priority: explicit > auto-suggest > default.
  // When req.autoSlippage is set AND req.slippageBps is undefined, pull
  // history for the canonical pair and compute a suggestion (iter641 made
  // this cheap by storing realized_slippage_bps per row).
  let slippageBps = req.slippageBps ?? ctx.config.defaultSlippageBps;
  let slippageSuggestion: import("./slippageSuggest.js").SlippageSuggestion | undefined;
  if (req.autoSlippage && req.slippageBps == null) {
    try {
      const { recentTrades } = await import("./db.js");
      const { extractPairSamples, suggestSlippageBps, SUGGEST_DEFAULT_LOOKBACK_DAYS } = await import(
        "./slippageSuggest.js"
      );
      const sinceIso = new Date(Date.now() - SUGGEST_DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
      const rows = recentTrades({ account: ctx.accountLabel, since: sinceIso, limit: 1000 });
      // Symbols aren't yet resolved at this stage (getToken runs later) so
      // we match by ADDRESS canonical key only for ERC20-only pairs, or by
      // SYMBOL when one side is the chain's native (whose symbol we always
      // know via profile.nativeSymbol).
      const pairAddress = canonicalAddressPair(baseAddr, quoteAddr);
      const pairSymbol = baseIsNative
        ? canonicalGuessPair(ctx.profile.nativeSymbol, baseAddr, "", quoteAddr)
        : undefined;
      const samples = extractPairSamples({ rows, pairSymbol, pairAddress });
      slippageSuggestion = suggestSlippageBps({
        samples,
        defaultBps: ctx.config.defaultSlippageBps,
        maxBps: ctx.config.safety.maxSlippageBps,
      });
      slippageBps = slippageSuggestion.suggestedBps;
      ctx.logger.info(
        `Auto-slippage: ${slippageBps} bps (${slippageSuggestion.reason}, ${slippageSuggestion.sampleCount} samples)`,
      );
    } catch (e) {
      ctx.logger.debug(`auto-slippage failed, using default: ${(e as Error).message}`);
    }
  }
  // Iter403/404/405: pre-flight cheap safety checks (slippage cap + token whitelist/
  // blacklist) before the aggregator HTTP roundtrip. Iter404 first inlined these in
  // trade.ts; iter405 extracted them into enforcePreflightSafety in safety.ts so
  // there's a single canonical implementation. enforceSafety at step 5 runs the full
  // 5-check sequence (preflight + contract whitelist + per-tx USD + daily USD) —
  // defense in depth, covers callers bypassing executeTradeInner directly.
  // Iter425: static import — same module already pulled in at top of file for
  // enforceSafety; the dynamic import here was needless overhead on the hot path.
  enforcePreflightSafety(
    { chain: ctx.profile.name, tokenIn: baseAddr, tokenOut: quoteAddr, slippageBps },
    ctx.config,
    ctx.logger,
  );

  // Auto-honeypot probe (v15). Opt-in via safety.autoTokenCheck.enabled.
  // Runs the buy+sell roundtrip simulation for BOTH base + quote tokens.
  // Native/USDC/WETH/WBTC + operator whitelist short-circuit; the rest
  // get cache-aware probed (24h cache by default → near-zero amortized
  // cost). honeypot verdict always blocks; suspicious blocks when
  // failOnSuspicious=true. Simulations are exempt — a simulate-only
  // request doesn't move funds + operators rely on `quote --simulate`
  // to test arbitrary tokens without the probe overhead.
  if (!req.simulate && ctx.config.safety.autoTokenCheck?.enabled) {
    const { enforceTokenSafety } = await import("./autoTokenCheck.js");
    // Both sides — a honeypot can be on either the input (can't get
    // out of the position) or the output (can't sell what you bought).
    // We probe both, but only when they're non-native (the baseline-
    // trusted-set check inside enforceTokenSafety short-circuits these
    // automatically — calling it for native is a no-op).
    if (!baseIsNative) {
      await enforceTokenSafety({
        chain: ctx.profile.name,
        profile: ctx.profile,
        tokenAddress: baseAddr as string,
        config: ctx.config,
        logger: ctx.logger,
        publicClient: ctx.publicClient,
        walletAddress: ctx.walletClient.account.address,
        side: req.direction === "buy" ? "output" : "input",
      });
    }
    await enforceTokenSafety({
      chain: ctx.profile.name,
      profile: ctx.profile,
      tokenAddress: quoteAddr as string,
      config: ctx.config,
      logger: ctx.logger,
      publicClient: ctx.publicClient,
      walletAddress: ctx.walletClient.account.address,
      side: req.direction === "buy" ? "input" : "output",
    });
  }

  // Iter633: rate-limit guard. Same opt-in pattern as iter620 gas budget —
  // skipped when safety.minTradeIntervalMs is null. Looks up the account's
  // most-recent trade timestamp from the DB; throws SAFEGUARD_TRIGGERED with
  // `reason: "rate_limited"` + `waitMs` when too recent. Skipped on simulate
  // (a dry-run doesn't move funds, no rate concern).
  if (!req.simulate) {
    const { enforceRateLimit } = await import("./safety.js");
    const { mostRecentTradeTimestamp } = await import("./db.js");
    const lastTs = mostRecentTradeTimestamp(ctx.accountLabel, ctx.profile.name);
    enforceRateLimit(
      {
        account: ctx.accountLabel,
        chain: ctx.profile.name,
        lastTradeTimestamp: lastTs,
      },
      ctx.config,
      ctx.logger,
    );
  }

  // Fetch base + quote metadata in parallel — they're independent reads, and the
  // iter81 in-flight dedup will share the call if e.g. holdings was already reading
  // the same token at the same time.
  const [baseMeta, quoteMeta] = await Promise.all([
    baseIsNative
      ? Promise.resolve({ decimals: 18, symbol: ctx.profile.nativeSymbol })
      : getToken(ctx.publicClient, ctx.profile, baseAddr),
    getToken(ctx.publicClient, ctx.profile, quoteAddr),
  ]);
  const baseDec = baseMeta.decimals;
  const quoteDec = quoteMeta.decimals;
  const baseSym = baseMeta.symbol;
  const quoteSym = quoteMeta.symbol;

  // ── 2. Build the input for the aggregator ──
  // Direction semantics:
  //   buy  → tokenIn = quote, tokenOut = base
  //   sell → tokenIn = base,  tokenOut = quote
  // exactInput mode (we always pass an exact input amount to the aggregator).
  //
  // If user gave the OUTPUT side (e.g. "buy with quoteAmount" or "sell for quoteAmount"),
  // that already matches exactInput on a different side, so we re-interpret.
  let tokenIn: Address;
  let tokenOut: Address;
  let amountIn: bigint;
  // Iter408: function-scope holder so the sell-max native gas reserve can flow into
  // the TradeResult below (parity with iter407's transfer gasReserveNative).
  let gasReserveNative: string | undefined;

  if (req.direction === "buy") {
    // tokenIn = quote, tokenOut = base
    tokenIn = quoteAddr;
    tokenOut = baseAddr;
    if (req.quoteAmount != null) {
      // "max" → full quote-token balance; "N%" → that fraction of it
      // (v35.5 — ERC20 case; native-quote is unusual but we'd need a
      // gas reserve for it).
      const quoteSentinel = parseSizingSentinel(req.quoteAmount);
      if (quoteSentinel) {
        const spendable = (await ctx.publicClient.readContract({
          address: quoteAddr,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [ctx.walletClient.account.address],
        })) as bigint;
        amountIn = applyFractionBig(spendable, quoteSentinel);
        if (amountIn === 0n) {
          throw new ToolError(
            "INSUFFICIENT_BALANCE",
            `Zero spendable balance of ${quoteSym ?? quoteAddr}; cannot buy with ${describeSentinel(quoteSentinel)}.`,
            {
              details: { balance: "0", required: "any positive amount", symbol: quoteSym ?? quoteAddr },
              nextActions: [
                {
                  tool: "holdings",
                  params: { chains: [ctx.profile.name], account: ctx.accountLabel },
                  reason: `Check the quote-token balance — run \`tradekit holdings --chains ${ctx.profile.name} --account ${ctx.accountLabel}\` to see what's actually held on this chain, then top up the quote token before retrying buy --quoteAmount max.`,
                },
              ],
            },
          );
        }
        req = { ...req, quoteAmount: formatUnits(amountIn, quoteDec) };
        ctx.logger.info(`buy ${describeSentinel(quoteSentinel)} → using ${req.quoteAmount} ${quoteSym ?? "quote"}`);
      } else {
        amountIn = parseUnits(req.quoteAmount, quoteDec);
      }
    } else {
      // Want exact baseAmount — use exact output. Aggregators typically only support exact-input,
      // so we approximate by first quoting amountOut for amountIn=1 unit of base × quote price,
      // then iterate? Simpler: rely on aggregator's exact-output behaviour by overshooting.
      // For now, throw a clear error if user requests exact baseAmount on buy.
      throw new ToolError(
        "INVALID_PARAMS",
        "Aggregator path supports exactInput only. For 'buy', specify quoteAmount (the amount to spend) instead of baseAmount.",
        {
          nextActions: [
            { tool: "buy", params: { quoteAmount: "<amount>" }, reason: "Re-call buy with quoteAmount set to the amount of quote token to SPEND (CLI: `tradekit trade buy --quoteAmount <amount>`)." },
          ],
        },
      );
    }
  } else {
    // sell: tokenIn = base, tokenOut = quote
    tokenIn = baseAddr;
    tokenOut = quoteAddr;
    if (req.baseAmount != null) {
      // "max" resolves to the spendable base balance (with a gas
      // reserve when native); "N%" (v35.5) to that fraction of it.
      const baseSentinel = parseSizingSentinel(req.baseAmount);
      if (baseSentinel) {
        // Iter326: track the pre-reserve balance so the success-log can name the
        // reservation amount honestly. Pre-iter326 the log said "using full balance"
        // when the amount was already post-reserve — a subtle untruth that confused
        // operators who tried to reconcile the sent amount against their wallet.
        // Iter408: also capture the reserve for the result struct so --json consumers
        // see what was held back (parity with iter407's TransferResult.gasReserveNative).
        let nativeFullBalance: bigint | undefined;
        if (baseIsNative) {
          // Balance and current fees are independent reads — fire both in parallel
          // so "sell max" doesn't do back-to-back RPC roundtrips before sizing the
          // gas reserve.
          const [bal, fees] = await Promise.all([
            ctx.publicClient.getBalance({ address: ctx.walletClient.account.address }),
            ctx.publicClient.estimateFeesPerGas().catch(() => null),
          ]);
          let gpw = fees?.maxFeePerGas ?? fees?.gasPrice ?? 0n;
          if (gpw === 0n) {
            try { gpw = await ctx.publicClient.getGasPrice(); } catch { gpw = 0n; }
          }
          // Reserve enough native for the swap itself (~300K gas at the current max-fee × 2 safety).
          const reserve = 300000n * gpw * 2n;
          gasReserveNative = formatUnits(reserve, 18);
          const spendable = bal > reserve ? bal - reserve : 0n;
          amountIn = applyFractionBig(spendable, baseSentinel);
          if (amountIn === 0n) {
            throw new ToolError(
              "INSUFFICIENT_BALANCE",
              `Native balance ${formatUnits(bal, 18)} leaves nothing spendable after the gas reserve (${formatUnits(reserve, 18)}); cannot sell ${describeSentinel(baseSentinel)}.`,
              {
                details: {
                  balance: formatUnits(bal, 18),
                  required: formatUnits(reserve, 18),
                  symbol: baseSym ?? "native",
                  reserve: formatUnits(reserve, 18),
                },
                nextActions: [
                  {
                    tool: "holdings",
                    params: { chains: [ctx.profile.name], account: ctx.accountLabel },
                    reason: `Check the native balance — run \`tradekit holdings --chains ${ctx.profile.name} --account ${ctx.accountLabel}\` to see the gas budget, then top up so sell-max has enough to cover gas plus a non-zero sell amount.`,
                  },
                ],
              },
            );
          }
          nativeFullBalance = bal;
        } else {
          const spendable = (await ctx.publicClient.readContract({
            address: baseAddr,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [ctx.walletClient.account.address],
          })) as bigint;
          amountIn = applyFractionBig(spendable, baseSentinel);
          if (amountIn === 0n) {
            throw new ToolError(
              "INSUFFICIENT_BALANCE",
              `Zero spendable balance of ${baseSym ?? baseAddr}; cannot sell ${describeSentinel(baseSentinel)}.`,
              {
                details: { balance: "0", required: "any positive amount", symbol: baseSym ?? baseAddr },
                nextActions: [
                  {
                    tool: "holdings",
                    params: { chains: [ctx.profile.name], account: ctx.accountLabel },
                    reason: `Check the base-token balance — run \`tradekit holdings --chains ${ctx.profile.name} --account ${ctx.accountLabel}\` to see what's actually held on this chain, then transfer the base token in or pick a different one to sell.`,
                  },
                ],
              },
            );
          }
        }
        // Reflect the resolved amount in the request for downstream display.
        req = { ...req, baseAmount: formatUnits(amountIn, baseDec) };
        if (nativeFullBalance != null && nativeFullBalance > amountIn) {
          const reserved = nativeFullBalance - amountIn;
          ctx.logger.info(
            `sell ${describeSentinel(baseSentinel)} → keeping ${formatUnits(reserved, baseDec)} ${baseSym ?? "base"} (gas reserve${baseSentinel.kind === "pct" ? " + unsold fraction" : ""}); selling ${req.baseAmount} (full balance was ${formatUnits(nativeFullBalance, baseDec)}).`,
          );
        } else {
          ctx.logger.info(`sell ${describeSentinel(baseSentinel)} → using ${req.baseAmount} ${baseSym ?? "base"}`);
        }
      } else {
        amountIn = parseUnits(req.baseAmount, baseDec);
      }
    } else {
      throw new ToolError(
        "INVALID_PARAMS",
        "Aggregator path supports exactInput only. For 'sell', specify baseAmount (the amount of base to sell).",
        {
          nextActions: [
            { tool: "sell", params: { baseAmount: "<amount>" }, reason: "Re-call sell with baseAmount set to the amount of base token to SELL (CLI: `tradekit trade sell --baseAmount <amount>`)." },
          ],
        },
      );
    }
  }

  // Iter280: guard against a positive-looking amount that rounds to 0 raw units.
  // Example: `quoteAmount="0.0000001"` on a 6-decimal token → parseUnits returns 0n.
  // Aggregators may either reject (confusing 4xx) or echo back a zero-amount quote
  // that doesn't actually move tokens. Fail fast with an actionable hint instead.
  if (amountIn === 0n) {
    const decUsed = req.direction === "buy" ? quoteDec : baseDec;
    const amtStr = req.direction === "buy" ? req.quoteAmount : req.baseAmount;
    const minRepresentable = formatUnits(1n, decUsed);
    const requiredField = req.direction === "buy" ? "quoteAmount" : "baseAmount";
    throw new ToolError(
      "INVALID_PARAMS",
      `Amount "${amtStr}" rounds to 0 raw units at ${decUsed} decimals — too small to trade. Use at least the minimum representable amount (${minRepresentable}).`,
      {
        details: { providedAmount: amtStr, decimals: decUsed, minRepresentable, direction: req.direction },
        nextActions: [
          {
            tool: req.direction,
            params: { [requiredField]: minRepresentable },
            reason: `Re-call ${req.direction} with at least ${minRepresentable} ${req.direction === "buy" ? "quote" : "base"} units (CLI: \`tradekit trade ${req.direction} --${requiredField === "quoteAmount" ? "quoteAmount" : "baseAmount"} ${minRepresentable}\`).`,
          },
        ],
      },
    );
  }

  // ── 2b. Start the "fraction of balance" read in parallel with the quote ──
  // Knowing that a trade uses 78% of your wallet's USDC catches fat-finger mistakes
  // that pass all USD/contract guards. Not blocking — just an advisory field. Kick
  // the balance fetch off here so it overlaps with the aggregator HTTP call below.
  const balancePromise: Promise<bigint | null> = (async () => {
    try {
      return isNativeSentinel(tokenIn)
        ? await ctx.publicClient.getBalance({ address: ctx.walletClient.account.address })
        : ((await ctx.publicClient.readContract({
            address: tokenIn,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [ctx.walletClient.account.address],
          })) as bigint);
    } catch {
      return null;
    }
  })();

  // ── 3. Get aggregator quote + USD price (in parallel) ──
  // Quote and price are independent — the USD-per-quote-token lookup only needs the
  // quote-token address (known here) not the actual quoted amount. Kicking the price
  // fetch off now means by the time the aggregator returns we don't add another
  // ~200-500ms of HTTP latency before the safety check can run. Track providers we've
  // already tried so the simulate-revert retry loop can exclude them.
  const triedProviders: ProviderName[] = [];
  const quoteUsdP = getCurrentPrice(quoteAddr, ctx.logger).catch(() => null);
  // Native USD price for gas → USD conversion. Cached (60s success / 15s null cache
  // via iter132) so this is usually a cheap memory hit. Fire alongside quoteUsd so
  // neither stalls the other.
  const nativeUsdP = getCurrentPrice(ctx.profile.weth, ctx.logger).catch(() => null);
  let quote: AggregatorQuote;
  try {
    // Iter638: time the initial quote phase.
    const tQuote = Date.now();
    quote = await aggregateQuote(
      {
        profile: ctx.profile,
        tokenIn,
        tokenOut,
        amountIn,
        slippageBps,
        from: ctx.walletClient.account.address,
      },
      ctx.config,
      ctx.logger,
    );
    timing.quoteMs += Date.now() - tQuote;
    triedProviders.push(quote.provider as ProviderName);
  } catch (e) {
    throw toToolError(e, "AGGREGATOR_FAILED");
  }

  const baseAmountBn = req.direction === "buy" ? quote.amountOut : quote.amountIn;
  const quoteAmountBn = req.direction === "buy" ? quote.amountIn : quote.amountOut;
  const baseAmount = formatUnits(baseAmountBn, baseDec);
  const quoteAmount = formatUnits(quoteAmountBn, quoteDec);
  const baseAmountNum = parseFloat(baseAmount) || 0;
  const quoteAmountNum = parseFloat(quoteAmount) || 0;
  const price = baseAmountNum > 0 ? (quoteAmountNum / baseAmountNum).toFixed(8) : "0";

  // ── 4. Estimate USD value (for safety limits) + finalize balanceFraction ──
  // Both in-flight promises are now joined: by the time we get here typically both
  // have resolved already (we kicked them off before the slower aggregator HTTP call).
  const [quoteUsd, balance, nativeUsd] = await Promise.all([quoteUsdP, balancePromise, nativeUsdP]);
  let estimatedUsd: number | undefined =
    quoteUsd != null ? quoteAmountNum * quoteUsd : undefined;
  // Fall back: if quote is a stablecoin (symbol contains USD), assume 1:1
  if (estimatedUsd == null && quoteSym && /USD/i.test(quoteSym)) {
    estimatedUsd = quoteAmountNum;
  }
  let balanceFraction: number | undefined;
  if (balance != null && balance > 0n) {
    const dec = req.direction === "buy" ? quoteDec : baseDec;
    const balNum = parseFloat(formatUnits(balance, dec));
    const amtNum = parseFloat(formatUnits(amountIn, dec));
    if (balNum > 0) balanceFraction = amtNum / balNum;
  }

  // Fail-fast on insufficient balance using the parallel balance fetch we already
  // have in hand — costs no extra RPC. Without this the trade proceeds to approval +
  // submit; the swap reverts on-chain, burning approval gas (when fresh allowance was
  // needed) and the failed-tx gas itself. Simulation catches the same condition for
  // ERC20→ERC20 trades with pre-existing allowance (shouldSimulate=true), but the
  // approval-needed path skips simulate (estimateGas would fail at transferFrom
  // before the swap itself), so this is the only pre-submit balance gate for that
  // case. Null balance (RPC error during the fetch) → skip the check; simulate /
  // submit will surface the failure with the original error context.
  if (balance != null && balance < amountIn) {
    const dec = req.direction === "buy" ? quoteDec : baseDec;
    const sym = req.direction === "buy" ? (quoteSym ?? "quote token") : (baseSym ?? "base token");
    throw new ToolError(
      "INSUFFICIENT_BALANCE",
      `Wallet has ${formatUnits(balance, dec)} ${sym} but the trade needs ${formatUnits(amountIn, dec)} — top up or reduce the amount.`,
      {
        details: {
          balance: formatUnits(balance, dec),
          required: formatUnits(amountIn, dec),
          symbol: sym,
        },
        nextActions: [
          // Iter492: `holdings` works on every surface (CLI / MCP / web). The earlier
          // `wallet` referred to the CLI command — an MCP / web agent receiving this
          // error couldn't dispatch to a tool by that name.
          // Iter495: scope params to the trade's actual chain + account so an agent
          // can mechanically dispatch to the right scope without re-deriving them
          // from session state. CLI users pasting `tradekit holdings --chains <X>
          // --account <Y>` get the same scope at the prompt.
          {
            tool: "holdings",
            params: { chains: [ctx.profile.name], account: ctx.accountLabel },
            // Iter508: embed the copy-paste CLI form in the reason (iter435 convention).
            // CLI text mode only renders tool + reason; without the command line a
            // CLI user has to manually translate params into `--chains`/`--account`
            // flags. MCP / web agents still read structured params from the field.
            reason: `Check the input-token balance — run \`tradekit holdings --chains ${ctx.profile.name} --account ${ctx.accountLabel}\` to see balances on this chain, then top up or reduce the trade size.`,
          },
        ],
      },
    );
  }

  // ── 5. Safety guardrails ──
  enforceSafety(
    {
      chain: ctx.profile.name,
      account: ctx.accountLabel,
      tokenIn,
      tokenOut,
      toContract: quote.to,
      estimatedUsd,
      slippageBps,
    },
    ctx.config,
    ctx.logger,
  );

  // ── 5a. Portfolio-aware position limits ──
  //
  // Plugs into the same safety pipeline but is async (needs a portfolio
  // RPC roundtrip). Skipped entirely when `safety.positionLimits` is
  // empty / undefined → no overhead for installs that don't use the
  // feature. The check uses the existing iter641 estimatedUsd; if it's
  // null (unpriced trade), the position check soft-skips with a warning
  // — same posture as the existing per-tx/daily USD limits when USD
  // pricing is missing.
  if (ctx.config.safety.positionLimits && ctx.config.safety.positionLimits.length > 0) {
    const { enforcePositionLimits, deltaForSwap, chainHoldingsToSnapshot } = await import("./positionLimits.js");
    const delta = deltaForSwap({
      chain: ctx.profile.name,
      direction: req.direction,
      estimatedUsd,
      baseAddress: baseIsNative ? "ETH" : baseAddr,
      baseIsNative,
      quoteAddress: quoteAddr,
    });
    await enforcePositionLimits({
      chain: ctx.profile.name,
      delta,
      config: ctx.config,
      logger: ctx.logger,
      fetchPortfolio: async () => {
        // Fetch the holdings snapshot for the operator's owner across
        // (a) the current chain ALWAYS, plus (b) every chain referenced
        // by a wildcard limit. Wildcard limits aggregate across chains,
        // so a base-only fetch would understate WBTC exposure when the
        // operator has WBTC on multiple chains.
        const { holdingsOnChain, holdingsMultiChain } = await import("./holdings.js");
        const limits = ctx.config.safety.positionLimits!;
        const hasWildcard = limits.some((l) => l.chain === "*");
        const owner = ctx.walletClient.account.address;
        let reports: import("./holdings.js").ChainHoldings[];
        if (hasWildcard) {
          const multi = await holdingsMultiChain(owner, ctx.config, ctx.logger);
          reports = multi.reports;
        } else {
          reports = [await holdingsOnChain(owner, ctx.profile.name, ctx.config, ctx.logger)];
        }
        return chainHoldingsToSnapshot(reports);
      },
    });
  }

  // ── 5a-ter. Drawdown circuit breaker (iter20) ──
  //
  // State-aware safety: the first guardrail that tracks the operator's
  // actual capital trajectory over time. When portfolio USD falls > N%
  // below all-time peak, refuse new trades until manual reset (or
  // auto-resume when configured).
  //
  // Skipped on --simulate (dry runs don't change the trajectory) and
  // when the feature isn't configured. Uses owner-wide holdings — same
  // fetch shape position limits uses, so we hit the RPC at most once
  // for the trade regardless of how many safety layers need it.
  //
  // Fetches portfolio across (current chain) plus any chains the
  // operator's portfolio actually has assets on — the snapshot's
  // priced USD total feeds the breaker. Unpriced portfolios (oracle
  // down) soft-skip — same posture as the existing per-tx USD limits.
  if (!req.simulate && ctx.config.safety.drawdownCircuitBreaker?.enabled) {
    const { holdingsMultiChain } = await import("./holdings.js");
    const owner = ctx.walletClient.account.address;
    let currentUsd = 0;
    try {
      const multi = await holdingsMultiChain(owner, ctx.config, ctx.logger);
      // Sum priced USD across every chain's reports. Unpriced positions
      // contribute zero — under-estimating drawdown errs toward NOT
      // tripping, which matches the soft-skip-on-missing-data posture
      // the rest of the safety stack uses.
      for (const r of multi.reports) {
        for (const b of r.balances) {
          if (b.usd != null && Number.isFinite(b.usd)) currentUsd += b.usd;
        }
      }
    } catch (e) {
      ctx.logger.warn(
        `Drawdown breaker: portfolio fetch failed (${(e as Error).message}); skipping check this trade.`,
      );
      currentUsd = 0;
    }
    if (currentUsd > 0) {
      const { enforceDrawdownCircuitBreaker } = await import("./drawdown.js");
      enforceDrawdownCircuitBreaker({ currentUsd, config: ctx.config });
    }
  }

  // ── 5a-bis. Per-strategy budget enforcement (iter19) ──
  //
  // The global per-tx + daily USD caps in step 5 are operator-wide;
  // this layer scopes caps to a specific `strategy` tag (or a
  // wildcard pattern like "playbook:*"). When a trade carries a
  // strategy tag, look up matching rules in safety.strategyBudgets +
  // check the cumulative spend so far against the configured cap.
  //
  // Skipped when:
  //   - no strategyBudgets configured (no-op for un-configured installs)
  //   - the trade has no strategy tag (manual trades without a label)
  //   - estimatedUsd is null (we can't budget what we can't price)
  // Throws STRATEGY_BUDGET_EXCEEDED on a trip — error carries the
  // tripped rule, window (lifetime/daily/perFire), spent USD, and
  // predicted USD for an agent to disposition.
  if (
    ctx.config.safety.strategyBudgets &&
    ctx.config.safety.strategyBudgets.length > 0 &&
    estimatedUsd != null
  ) {
    const { enforceStrategyBudget } = await import("./strategyBudget.js");
    enforceStrategyBudget({
      strategyTag: req.strategy ?? null,
      predictedUsd: estimatedUsd,
      budgets: ctx.config.safety.strategyBudgets,
    });
  }

  // ── 5b. Predictive failure pattern check (iter682) ──
  // Query recent failures (last 7d) for THIS base/quote pair on this chain
  // + account. If a dominant reason has emerged, surface as a warning BEFORE
  // we send — gives operators (and agents via the result field) a chance to
  // switch strategy (--auto-slippage, different aggregator, etc.) before
  // committing the same kind of trade that's been failing.
  //
  // Thresholds: ≥3 failures total AND dominant reason ≥50% share. Lower
  // and we'd warn on noise; higher and operators wouldn't see real patterns
  // until they'd already failed many trades. NULL ("(unknown)") reasons are
  // EXCLUDED from the dominant pick — they signal a backfill gap (iter670),
  // not a fixable trade-time issue.
  let recentFailurePattern: TradeResult["recentFailurePattern"];
  try {
    const { recentPairFailureHistogram } = await import("./db.js");
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const pattern = recentPairFailureHistogram({
      chain: ctx.profile.name,
      account: ctx.accountLabel,
      baseToken: baseAddr,
      quoteToken: quoteAddr,
      sinceIso: sevenDaysAgo,
    });
    if (pattern.total >= 3) {
      const dominant = pattern.reasons.find(
        (r) => r.reason !== "(unknown)" && r.count >= Math.ceil(pattern.total / 2),
      );
      if (dominant) {
        // Iter686: classify the dominant reason against the existing
        // ERROR_PATTERNS table. classifyReason returns null when no rule
        // matches (legitimate — not every revert string is in our table).
        // We surface the structured nextActions either way: undefined when
        // no classification, [...] when one matched. Agents branch on the
        // first action's `tool` to decide what to do.
        const classified = classifyReason(dominant.reason);
        recentFailurePattern = {
          total: pattern.total,
          windowDays: 7,
          dominantReason: dominant.reason,
          dominantCount: dominant.count,
          // Iter700: dominant reason's most-recent timestamp (from iter699).
          ...(dominant.lastSeen ? { dominantLastSeen: dominant.lastSeen } : {}),
          ...(classified?.nextActions ? { suggestedActions: classified.nextActions } : {}),
        };
        const lastBit = dominant.lastSeen ? ` (last: ${dominant.lastSeen.slice(0, 16).replace("T", " ")})` : "";
        ctx.logger.warn(
          `⚠ Recent failure pattern on ${baseSym ?? "?"}/${quoteSym ?? "?"}: ${dominant.count}/${pattern.total} failures in last 7d show "${dominant.reason}"${lastBit}. Consider --auto-slippage or a different aggregator.`,
        );
      }
    }
  } catch (e) {
    ctx.logger.debug(`iter682 pattern check failed: ${(e as Error).message}`);
  }

  // ── 6. Simulate ──
  // For simulation accuracy we need approval to already be in place, otherwise estimateGas
  // will fail on transferFrom. We can't simulate the approval cleanly without state overrides,
  // so we check & approve BEFORE simulating in non-simulate mode; in simulate-only mode we skip
  // approval (caller is informed via next_actions if approval is needed).
  const tokenInIsNative = isNativeSentinel(tokenIn);
  let needsApproval = false;
  if (!tokenInIsNative) {
    const allowance = (await ctx.publicClient.readContract({
      address: tokenIn,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [ctx.walletClient.account.address, quote.allowanceTarget],
    })) as bigint;
    needsApproval = allowance < amountIn;
  }

  // Simulate; if it would revert AND the input wasn't a known-good native ETH approval
  // shortage, retry up to MAX_FALLBACKS times with the next aggregator. This catches
  // pool-state drift (e.g. KyberSwap router "Call failed" from inner sub-route slip)
  // and gracefully recovers instead of failing the entire trade.
  //
  // We run the pre-flight simulation for BOTH dry-runs (req.simulate=true) AND real
  // trades. For real trades it's a cheap quality gate — better to swap providers now
  // than pay gas on a revert. The only case we skip it: when approval is still needed,
  // because estimateGas would fail at the transferFrom step before the swap, masking
  // any real failure.
  const MAX_FALLBACKS = 2;
  const shouldSimulate = !needsApproval;
  let simulation: Awaited<ReturnType<typeof simulateTx>> | undefined;
  if (shouldSimulate) {
    // Iter638: time the initial simulate.
    const tSim = Date.now();
    simulation = await simulateTx({
      publicClient: ctx.publicClient,
      from: ctx.walletClient.account.address,
      to: quote.to,
      data: quote.data,
      value: quote.value,
      logger: ctx.logger,
    }).catch((e) => {
      // Iter476: sanitize before logging (iter474 helper) — viem multi-line.
      ctx.logger.error(sanitizeForLogLine(`simulate error: ${(e as Error).message}`));
      return undefined;
    });
    timing.simulateMs += Date.now() - tSim;
  }

  if (shouldSimulate && simulation && !simulation.ok) {
    // Genuine revert (not just missing approval). Retry with the next aggregator.
    for (let attempt = 0; attempt < MAX_FALLBACKS; attempt++) {
      const lastRevert = compactMessage(simulation?.revertReason, 80) || "unknown";
      ctx.logger.warn(
        `Simulation reverted for ${quote.provider}: ${lastRevert}. Trying next aggregator…`,
      );
      let nextQuote: AggregatorQuote;
      // Iter638: time the fallback re-quote.
      const tFbQuote = Date.now();
      try {
        nextQuote = await aggregateQuote(
          {
            profile: ctx.profile,
            tokenIn,
            tokenOut,
            amountIn,
            slippageBps,
            from: ctx.walletClient.account.address,
          },
          ctx.config,
          ctx.logger,
          triedProviders,
        );
      } catch {
        timing.quoteMs += Date.now() - tFbQuote;
        // No more aggregators to try
        break;
      }
      timing.quoteMs += Date.now() - tFbQuote;
      triedProviders.push(nextQuote.provider as ProviderName);
      quote = nextQuote;
      // Iter638: time the fallback simulate.
      const tFbSim = Date.now();
      simulation = await simulateTx({
        publicClient: ctx.publicClient,
        from: ctx.walletClient.account.address,
        to: quote.to,
        data: quote.data,
        value: quote.value,
        logger: ctx.logger,
      }).catch((e) => {
        // Iter476: sanitize before logging (iter474 helper) — viem multi-line.
        ctx.logger.error(sanitizeForLogLine(`simulate error: ${(e as Error).message}`));
        return undefined;
      });
      timing.simulateMs += Date.now() - tFbSim;
      if (simulation?.ok) break;
    }
  }

  // For REAL trades only: if every aggregator's simulation reverted, refuse to send.
  // Sending would just burn gas on an inevitable revert. The dry-run path below
  // returns the failed simulation as data instead, so the user/agent can decide.
  if (!req.simulate && shouldSimulate && simulation && !simulation.ok) {
    // Run the revert reason through the same classifier toToolError uses on thrown
    // errors. If the matcher recognizes the reason (slippage, insufficient balance,
    // needs approval, etc.) we surface the SPECIFIC code + hint instead of a generic
    // SIMULATION_FAILED. Pre-iter145 a simulated balance-exceeded revert got the
    // "re-quote with higher slippage" hint, which was actively wrong.
    const classified = simulation.revertReason ? classifyReason(simulation.revertReason) : null;
    const code = classified?.code ?? "SIMULATION_FAILED";
    const nextActions: NextAction[] = classified?.nextActions ?? [
      {
        tool: "quote",
        reason: "Re-quote with a higher slippageBps, or wait for pool state to settle, then retry.",
      },
    ];
    // Grammar + show WHICH providers were tried, not just how many. Pre-iter179 said
    // "on all 1 aggregator(s)" (ungrammatical) and omitted the provider names — agent
    // / operator couldn't tell whether the failure was provider-specific or universal.
    const n = triedProviders.length;
    const providersLabel = n === 1 ? `aggregator (${triedProviders[0]})` : `${n} aggregators (${triedProviders.join(", ")})`;
    throw new ToolError(
      code,
      `Pre-flight simulation reverted on ${providersLabel}: ${simulation.revertReason ?? "unknown"}. Refusing to send (would waste gas).`,
      {
        details: {
          providersTried: triedProviders,
          revertReason: simulation.revertReason,
        },
        nextActions,
      },
    );
  }

  // ── 6.4 Quote deviation guard (iter625) ──
  // When the caller passes expectedAmountOut (typically captured from a prior
  // `quote` response), compare it to the live re-quoted amountOut and abort
  // if the live quote is worse than expected by more than the tolerance.
  // Skipped when expectedAmountOut is undefined (the default — backward
  // compatible).
  //
  // Run AFTER the simulate-and-fallback loop so we compare against the FINAL
  // winning quote (the loop may have switched aggregators on simulation
  // revert). Direction matters: for buy the trader RECEIVES base (quote.amountOut
  // = base bigint); for sell the trader receives quote (quote.amountOut = quote
  // bigint). The decimals to format with mirror the direction.
  if (req.expectedAmountOut != null) {
    const liveOutDecimals = req.direction === "buy" ? baseDec : quoteDec;
    const liveAmountOut = formatUnits(quote.amountOut, liveOutDecimals);
    const maxBps = req.maxQuoteDeviationBps ?? DEFAULT_QUOTE_DEVIATION_BPS;
    const check = checkQuoteDeviation({
      expectedAmountOut: req.expectedAmountOut,
      actualAmountOut: liveAmountOut,
      maxBps,
    });
    if (!check.ok) {
      throw new ToolError(
        "QUOTE_DEVIATION_EXCEEDED",
        `Live re-quote diverged from expectedAmountOut by ${check.actualBps.toFixed(1)} bps (cap ${maxBps} bps). Expected ${check.expected}, got ${check.actual}.`,
        {
          details: {
            chain: ctx.profile.name,
            direction: req.direction,
            expectedAmountOut: req.expectedAmountOut,
            actualAmountOut: liveAmountOut,
            actualBps: check.actualBps,
            maxQuoteDeviationBps: maxBps,
            reason: "quote_drift_between_preview_and_execute",
          },
          nextActions: [
            {
              // Agent path: re-quote (cheap) to refresh the expectedAmountOut,
              // then re-submit with the fresh value.
              tool: "quote",
              reason: `Market moved between the prior quote and execution. Re-quote now to refresh expectedAmountOut, then call buy/sell again with the new value. If the divergence is acceptable, retry without expectedAmountOut OR raise maxQuoteDeviationBps above ${Math.ceil(check.actualBps)}.`,
            },
          ],
        },
      );
    }
    ctx.logger.debug(
      `Quote deviation check passed: expected=${req.expectedAmountOut}, actual=${liveAmountOut}, cap=${maxBps} bps.`,
    );
  }

  // ── 6.5 Gas budget guard (iter620) ──
  // Run AFTER simulation (so we have gas estimate) and BEFORE both simulate-return
  // and the actual send. Skipped on the approval-needed path (simulation was
  // skipped, so we have no gas estimate). req.forceGas bypasses with a warn —
  // mirrors the iter282-ish override pattern for safety bypasses.
  if (simulation?.gasCostNative != null) {
    if (req.forceGas) {
      ctx.logger.warn(`Gas budget check BYPASSED via forceGas=true. Estimated gas: ${simulation.gasCostNative} native.`);
    } else {
      const gasNative = parseFloat(simulation.gasCostNative);
      if (Number.isFinite(gasNative)) {
        const gasUsd = nativeUsd != null ? gasNative * nativeUsd : undefined;
        const { enforceGasBudget } = await import("./safety.js");
        enforceGasBudget(
          {
            chain: ctx.profile.name,
            estimatedGasNative: gasNative,
            estimatedGasUsd: gasUsd,
            estimatedTradeUsd: estimatedUsd,
          },
          ctx.config,
          ctx.logger,
        );
      }
    }
  }

  // If simulate=true, return without sending.
  if (req.simulate) {
    // Convert the simulator's gas-in-native to USD when we know the native price.
    // Lets quote / simulate output show "Gas: 150000 (~0.0005 ETH ≈ $1.50)" instead
    // of just the abstract native amount, which is hard to compare across chains.
    let simGasUsd: number | undefined;
    if (simulation?.gasCostNative && nativeUsd != null) {
      const n = parseFloat(simulation.gasCostNative);
      if (Number.isFinite(n)) simGasUsd = n * nativeUsd;
    }
    const result: TradeResult = {
      ok: simulation?.ok !== false && !needsApproval,
      simulated: true,
      timestamp: new Date().toISOString(),
      direction: req.direction,
      baseToken: baseAddr,
      baseSymbol: baseSym,
      quoteToken: quoteAddr,
      quoteSymbol: quoteSym,
      baseAmount,
      quoteAmount,
      price,
      estimatedUsd,
      balanceFraction,
      gasReserveNative,
      aggregator: quote.provider,
      allowanceTarget: quote.allowanceTarget,
      to: quote.to,
      simulation,
      gasCostUsd: simGasUsd,
      // Iter638: phase timing for simulate-only path. sendMs/receiptMs stay 0
      // since the simulate path never actually sends.
      phaseTiming: { ...timing, totalMs: Date.now() - t0 },
      // Iter915: top-level elapsedMs mirrors phaseTiming.totalMs for
      // MCP-tool envelope parity. Agents read response.elapsedMs uniformly.
      elapsedMs: Date.now() - t0,
      // Iter644: surface the auto-slippage suggestion when used.
      ...(slippageSuggestion ? { slippageSuggestion } : {}),
      // Iter682: surface the predictive failure pattern on the simulate
      // result so quote consumers see the warning BEFORE running the real
      // trade. Agents using MCP can branch on this — e.g. retry the quote
      // with --auto-slippage when the dominant reason is slippage-related.
      ...(recentFailurePattern ? { recentFailurePattern } : {}),
    };
    if (needsApproval) {
      result.nextActions = [
        {
          tool: "approve",
          params: { token: tokenIn, spender: quote.allowanceTarget, amount: amountIn.toString() },
          reason: "Approval is required before the swap can be executed.",
        },
      ];
    }
    return result;
  }

  // ── 7. Approve if needed ──
  if (needsApproval) {
    await ensureApproval(ctx, tokenIn, quote.allowanceTarget, amountIn);
  }

  // ── 8. Send tx ──
  let txHash: `0x${string}`;
  // Iter638: time the send phase.
  const tSend = Date.now();
  try {
    txHash = await ctx.walletClient.sendTransaction({
      to: quote.to,
      data: quote.data,
      value: quote.value,
    });
    timing.sendMs = Date.now() - tSend;
    ctx.logger.info(`Swap tx sent: ${txHash}`);
  } catch (e) {
    timing.sendMs = Date.now() - tSend;
    throw toToolError(e, "TX_REVERTED");
  }

  // Persist the trade as soon as the hash is known. If waitForReceipt then times out
  // the row stays as status="pending" — without this, a TX_TIMEOUT would silently
  // discard a real, gas-paid transaction from history and PnL.
  //
  // Critically, recordRow must NEVER throw. The tx has already landed (or is about to)
  // — losing the txHash because of a downstream SQLite error would be catastrophic.
  // On DB failure we log an error and continue; the caller can recover via
  // `tradekit trade import <hash>` to backfill manually.
  // Iter641: recordRow now returns the inserted row id so the success path
  // can issue a follow-up UPDATE with realized slippage once decode completes.
  // Iter646: optional gasCostUsd captured at trade time for historical PnL.
  // Returns null when the DB write failed — that's already a logged-error
  // condition and the slippage backfill is best-effort.
  const recordRow = (
    status: "success" | "failed" | "pending",
    gasUsed: string | null,
    gasCostNative: string | null,
    // Iter635: optional receipt block — passed when the success path observes it.
    // Pending writes don't have a block yet; recordRow with status=success passes
    // receipt.blockNumber.
    blockNumber: number | null = null,
    // Iter646: gas USD at trade time. Operators need historical accuracy
    // (gas at $X/ETH last month ≠ same native amount × today's $Y/ETH).
    gasUsdAtTrade: number | null = null,
    // Iter676: revert reason for direct-failure rows. Pre-iter676 only the
    // reconcile-pending path (iter669) persisted reasons — trades that hit
    // receipt.status="reverted" at first call missed the capture. Caller
    // extracts via extractRevertReasonByHash and passes through here.
    revertReason: string | null = null,
  ): number | null => {
    try {
      return ctx.logger.recordTrade({
        timestamp: new Date().toISOString(),
        chain: ctx.profile.name,
        account: ctx.accountLabel,
        direction: req.direction,
        base_token: baseAddr,
        base_symbol: baseSym ?? null,
        base_amount: baseAmount,
        quote_token: quoteAddr,
        quote_symbol: quoteSym ?? null,
        quote_amount: quoteAmount,
        price,
        tx_hash: txHash,
        status,
        gas_used: gasUsed,
        gas_price_wei: null,
        gas_cost_native: gasCostNative,
        aggregator: quote.provider,
        fee_tier: null,
        notes: req.note ?? null,
        block_number: blockNumber,
        gas_cost_usd_at_trade: gasUsdAtTrade,
        strategy: req.strategy ?? null,
        revert_reason: revertReason,
      });
    } catch (e) {
      // Iter476: sanitize before logging — sqlite errors usually one-line but
      // the iter474 helper is cheap defense-in-depth.
      ctx.logger.error(sanitizeForLogLine(
        `Trade persisted on-chain but DB write failed: ${txHash} status=${status}. ` +
          `Recover with: tradekit trade import ${txHash}. Cause: ${(e as Error).message}`,
      ));
      return null;
    }
  };

  let receipt: Awaited<ReturnType<typeof waitForReceiptWithTimeout>>;
  // Iter638: time the receipt-wait phase (typically the long pole).
  const tRecv = Date.now();
  try {
    receipt = await waitForReceiptWithTimeout(ctx.publicClient, txHash, ctx.profile);
    timing.receiptMs = Date.now() - tRecv;
  } catch (e) {
    timing.receiptMs = Date.now() - tRecv;
    // Receipt timed out or some other RPC error after the tx was already broadcast.
    // Record as "pending" so PnL/history still see it; re-throw so the agent learns it
    // can't trust the swap completed.
    recordRow("pending", null, null);
    throw e;
  }
  const status: "success" | "failed" = receipt.status === "success" ? "success" : "failed";
  const gasUsed = receipt.gasUsed.toString();
  const gasCostWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
  const gasCostNative = formatUnits(gasCostWei, 18);
  // Convert actual gas spend to USD using the same native price we already fetched.
  // Surfaces the bottom-line cost of the trade in dollars next to the native amount.
  let gasCostUsd: number | undefined;
  if (nativeUsd != null) {
    const n = parseFloat(gasCostNative);
    if (Number.isFinite(n)) gasCostUsd = n * nativeUsd;
  }
  // Iter635: capture receipt block number for reorg-depth filtering downstream.
  // receipt.blockNumber is bigint on viem; Number() is safe — block numbers fit
  // in JS-safe int range for the foreseeable future of EVM chains.
  // Iter646: gasCostUsd computed above (line ~1115) was at trade time using the
  // native price we already fetched. Pass it through so PnL math has the
  // historically-accurate value.
  // Iter676: for direct-failure trades, extract the revert reason now via
  // the same eth_call replay the analyzer + reconcile-pending path use.
  // Best-effort — never block the trade record on the enrichment.
  let directFailRevertReason: string | null = null;
  if (status === "failed") {
    try {
      const { extractRevertReasonByHash } = await import("./tradeAnalysis.js");
      const reason = await extractRevertReasonByHash({
        publicClient: ctx.publicClient,
        txHash,
        blockNumber: Number(receipt.blockNumber),
        logger: ctx.logger,
      });
      if (reason) directFailRevertReason = reason;
    } catch (e) {
      ctx.logger.debug(`iter676 revert-reason extraction failed: ${(e as Error).message}`);
    }
  }
  const rowId = recordRow(
    status,
    gasUsed,
    gasCostNative,
    Number(receipt.blockNumber),
    gasCostUsd ?? null,
    directFailRevertReason,
  );

  // After a successful tx, decode the receipt's Transfer events to surface the actual
  // token deltas — what the user / agent really got, which can differ from the quote
  // when prices drift between build and execution. Best-effort: if decode fails we just
  // omit the `decoded` field. We already have the receipt — pass it through to skip
  // the duplicate fetch inside decodeTx.
  let decoded: import("./decodeTx.js").DecodedTx | undefined;
  if (status === "success") {
    try {
      const { decodeTx } = await import("./decodeTx.js");
      decoded = await decodeTx(ctx.publicClient, ctx.profile, txHash, receipt);
    } catch (e) {
      ctx.logger.debug(`post-trade decode failed: ${(e as Error).message}`);
    }
  }

  // Iter641: compute realized slippage from decoded vs quoted, persist to DB
  // for cheap downstream queries (iter623 aggregator stats, iter634 pair
  // stats). Best-effort: skipped on decode failure / no_match / failed status.
  if (status === "success" && decoded && rowId != null) {
    try {
      const actualBaseDelta = decoded.moves.find(
        (m) => (m.token === baseAddr || (baseIsNative && m.token === "NATIVE")),
      );
      const actualQuoteDelta = decoded.moves.find((m) => m.token === quoteAddr);
      if (actualBaseDelta && actualQuoteDelta) {
        // Iter641: reuse iter619's pure compareTradeExecution helper — same
        // semantics + sign convention (positive bps = unfavorable). Absolute
        // values for the magnitudes since the helper expects positives.
        const { compareTradeExecution } = await import("./tradeAnalysis.js");
        const actualBase = Math.abs(parseFloat(actualBaseDelta.amount.replace(/^[+-]/, "")));
        const actualQuote = Math.abs(parseFloat(actualQuoteDelta.amount.replace(/^[+-]/, "")));
        const cmp = compareTradeExecution({
          direction: req.direction,
          quotedBase: parseFloat(baseAmount),
          quotedQuote: parseFloat(quoteAmount),
          actualBase,
          actualQuote,
        });
        if (cmp.finding.code !== "unknown") {
          const { updateTradeStatus } = await import("./db.js");
          updateTradeStatus(rowId, status, {
            gas_used: gasUsed,
            gas_cost_native: gasCostNative,
            block_number: Number(receipt.blockNumber),
            realized_slippage_bps: cmp.slippageBps,
          });
        }
      }
    } catch (e) {
      // Slippage persistence is best-effort — never block the trade flow on it.
      ctx.logger.debug(`realized slippage persist failed: ${(e as Error).message}`);
    }
  }

  // On a reverted trade, fire a `trade.failed` notification (best-effort,
  // never blocks). When this trade was triggered by the order engine the
  // order's own `order.failed` will also fire — operators that want a
  // single event per failure can scope the channel to one of the two via
  // the channel.events allowlist. We emit at the trade layer too because
  // direct CLI / MCP trades (no order) are otherwise invisible to push
  // notifications. dedupKey on txHash means the same trade reverting can't
  // emit twice within the dedup window.
  if (status === "failed") {
    try {
      const { tryNotify } = await import("./notify.js");
      await tryNotify(
        {
          event: "trade.failed",
          severity: "warn",
          title: `Trade reverted on-chain · ${req.direction} ${baseSym ?? "base"} / ${quoteSym ?? "quote"}`,
          body: directFailRevertReason ?? "trade reverted on-chain",
          fields: {
            chain: ctx.profile.name,
            account: ctx.accountLabel,
            direction: req.direction,
            base: baseSym ?? baseAddr,
            quote: quoteSym ?? quoteAddr,
            baseAmount,
            quoteAmount,
            txHash,
            aggregator: quote.provider,
          },
          link: ctx.profile.explorer ? `${ctx.profile.explorer}/tx/${txHash}` : undefined,
          dedupKey: `trade.failed:${txHash}`,
        },
        ctx.config,
        ctx.logger,
      );
    } catch (e) {
      ctx.logger.debug(`trade.failed notify dispatch threw: ${(e as Error).message}`);
    }
  }

  return {
    ok: status === "success",
    simulated: false,
    timestamp: new Date().toISOString(),
    direction: req.direction,
    baseToken: baseAddr,
    baseSymbol: baseSym,
    quoteToken: quoteAddr,
    quoteSymbol: quoteSym,
    baseAmount,
    quoteAmount,
    price,
    estimatedUsd,
    balanceFraction,
    gasReserveNative,
    aggregator: quote.provider,
    allowanceTarget: quote.allowanceTarget,
    to: quote.to,
    txHash,
    status,
    gasUsed,
    gasCostNative,
    gasCostUsd,
    explorerUrl: ctx.profile.explorer ? `${ctx.profile.explorer}/tx/${txHash}` : undefined,
    decoded,
    // On revert, give the operator a click-path: viewTx confirms the failure
    // status + token moves (often none for a reverted swap), and the explorerUrl
    // field on this result leads to the block explorer where the on-chain revert
    // reason is available. Pre-iter482 the operator got a bare hash and had to
    // construct the explorer URL themselves.
    // Iter494: drop "above" — confused JSON / MCP consumers where there's no
    // spatial relationship; now names the field explicitly.
    // Iter513: embed the copy-paste CLI command in the reason so a CLI user
    // gets a paste-ready follow-up without translating params (iter435/508/512
    // convention). MCP / web agents still read structured params from the field.
    // Iter531: add chain to params. Pre-iter531 only txHash was in the structured
    // params; an MCP agent dispatching viewTx without explicit chain would fall
    // back to config.activeChain — which may have changed since the trade ran (esp.
    // for long-lived agent sessions). The CLI reason text already includes --chain,
    // so this just brings the structured form to parity with the paste-ready command.
    nextActions: status === "failed"
      ? [{ tool: "viewTx", params: { txHash, chain: ctx.profile.name }, reason: `Re-confirm the failed status + token deltas — run \`tradekit viewTx ${txHash} --chain ${ctx.profile.name}\`. For the on-chain revert reason, open the explorerUrl field of this result.` }]
      : undefined,
    // Iter638: phase timing for the real-send path.
    phaseTiming: { ...timing, totalMs: Date.now() - t0 },
    // Iter915: top-level elapsedMs mirrors phaseTiming.totalMs for
    // MCP-tool envelope parity.
    elapsedMs: Date.now() - t0,
    // Iter644: surface the auto-slippage suggestion when used.
    ...(slippageSuggestion ? { slippageSuggestion } : {}),
    // Iter682: surface the predictive failure pattern on the real-send
    // result too. Post-hoc value: when the trade succeeded despite the
    // pattern, the operator sees "we warned about this and it worked
    // anyway" — and when it failed, they have the historical context
    // already in the result without needing a separate health call.
    ...(recentFailurePattern ? { recentFailurePattern } : {}),
  };
}
