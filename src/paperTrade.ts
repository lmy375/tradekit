// ──────────────────────────────────────────────────────────────────
// Paper trading (iter30): a parallel execution path to executeTrade
// that fires against a virtual book instead of submitting an
// on-chain transaction.
//
// Use case: validate a new strategy (an OCO ladder, a DCA cadence,
// a trailing-stop level) against REAL-TIME market conditions —
// real price polling, real triggers, real volatility — WITHOUT
// risking real capital. This bridges the gap between iter16's
// historical backtest (which uses past data and may miss regime
// changes) and live deployment (which uses real money).
//
// Design constraints:
//
//  1. Mirror the executeTrade interface so call-sites only differ
//     at the branch point. orders.ts / schedules.ts read
//     `primitive.paper`, pick which fn to call, and consume the
//     same `TradeResult` shape.
//
//  2. SKIP the capital-tracking safety rails (drawdown breaker,
//     strategy budgets, daily/per-tx USD caps, position limits).
//     Those track REAL capital; paper trades shouldn't deplete
//     real budgets. The engine lock IS still honored — the
//     operator may want to halt paper too.
//
//  3. Don't ever touch the on-chain wallet — paper code paths
//     should be safe to invoke without a loaded keystore. This
//     means we DON'T use viem's WalletClient, and we don't
//     decrypt any private keys.
//
//  4. Slippage model: worst-case. spot × (1 ± slippageBps/10000)
//     in the trader-unfavorable direction. Real fills sometimes
//     beat spot (router finds better route); pessimistic
//     accounting tells the operator how the strategy would have
//     performed if liquidity worked AGAINST them — the answer
//     operators care about for risk sizing.
//
//  5. Synthetic tx hash: "paper:<id>:<timestamp>" — distinct
//     enough that nobody mistakes it for a real on-chain hash,
//     stable enough to use as an idempotency key downstream.
//
// What's NOT modeled (deliberate v1 scope):
//  - Gas. Paper trades are gas-free. Real strategies that are
//    only profitable when gas is cheap should still backtest
//    against historical gas data via iter16.
//  - MEV / front-running. We assume the operator's quote is
//    honored.
//  - Failed transactions. Paper trades always succeed (unless
//    they're rejected upstream by price-unavailable / virtual-
//    insufficient-balance). Real life has reverts; iter16
//    backtests can model some of them.
//  - Routing changes. Same spot price for both directions.
// ──────────────────────────────────────────────────────────────────

import {
  formatUnits,
  parseUnits,
  type Address,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { ToolError } from "./errors.js";
import { getCurrentPrice } from "./price.js";
import { getToken, isNativeSentinel, NATIVE_TOKEN } from "./tokens.js";
import type { ChainProfile } from "./chains.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import {
  recordPaperTrade,
  getPaperBalance,
  upsertPaperBalance,
} from "./db.js";

/** Request shape for executePaperTrade. Mirrors the meaningful
 *  subset of TradeRequest — fields that don't apply to paper mode
 *  (simulate, forceGas, expectedAmountOut) are intentionally
 *  absent. */
export interface PaperTradeRequest {
  direction: "buy" | "sell";
  base: Address | "ETH";
  quote: Address;
  /** Exactly one of baseAmount / quoteAmount is required (matching
   *  the executeTrade contract). */
  baseAmount?: string;
  quoteAmount?: string;
  /** Slippage in basis points. Defaults to config.safety.defaultSlippageBps
   *  when omitted, falling back to 50 if neither is set. */
  slippageBps?: number;
  /** Free-form note recorded on the paper_trades row. */
  note?: string;
  /** Strategy tag (matches executeTrade's strategy field). */
  strategy?: string;
  /** What spawned this trade — used for paper_trades.source_type
   *  + source_id attribution. */
  source: {
    type: "order" | "schedule" | "manual";
    id: number | null;
  };
}

export interface PaperTradeContext {
  /** Used only for decimals + symbol metadata via getToken — paper
   *  trades NEVER submit transactions, so no WalletClient is
   *  needed. The caller passes whichever publicClient they already
   *  have (typically the one from ensureWallet). */
  publicClient: PublicClient<Transport, Chain>;
  profile: ChainProfile;
  config: Config;
  logger: Logger;
  /** Account label — used as the paper_balances key. Same string
   *  format as ctx.accountLabel on TradeContext, so paper trade
   *  history and real trade history line up cleanly. */
  accountLabel: string;
}

/** Shape returned by executePaperTrade. Compatible with the
 *  subset of TradeResult that orders.ts / schedules.ts consume
 *  after a successful fire — same field names, same units. */
export interface PaperTradeResult {
  ok: true;
  /** Always false — paper trades aren't simulations, they DO
   *  affect state (the virtual book). */
  simulated: false;
  /** Always true — paper trades record the paper_trades row but
   *  no real on-chain tx. */
  paper: true;
  timestamp: string;
  direction: "buy" | "sell";
  baseToken: Address;
  baseSymbol?: string;
  quoteToken: Address;
  quoteSymbol?: string;
  baseAmount: string;
  quoteAmount: string;
  /** quote per base, decimal string. */
  price: string;
  /** USD value at the spot price (pre-slippage) — best-effort. */
  estimatedUsd?: number;
  /** Always "paper" so dashboards rendering the aggregator field
   *  can pivot on it. */
  aggregator: "paper";
  /** Synthetic hash so downstream code that stores fill_tx_hash
   *  has SOMETHING to write. Distinguishable from real hashes:
   *  the "paper:" prefix breaks the 0x.. assumption every
   *  explorer-link helper makes. */
  txHash: string;
  /** Always "success" — paper trades never revert. */
  status: "success";
  /** Final slippage in bps as actually applied. */
  slippageBps: number;
  /** id of the paper_trades row just inserted. */
  paperTradeId: number;
}

// ── slippage math (pure, testable) ──────────────────────────

/**
 * Apply worst-case slippage to a spot price.
 *
 * BUY direction: caller PAYS quote, RECEIVES base. Adverse =
 *   higher effective quote-per-base → spot × (1 + slip).
 *
 * SELL direction: caller PAYS base, RECEIVES quote. Adverse =
 *   lower effective quote-per-base → spot × (1 - slip).
 *
 * Exported for unit testing.
 */
export function applyWorstCaseSlippage(
  spotPrice: number,
  direction: "buy" | "sell",
  slippageBps: number,
): number {
  const slip = slippageBps / 10_000;
  return direction === "buy" ? spotPrice * (1 + slip) : spotPrice * (1 - slip);
}

/**
 * Compute (baseAmount, quoteAmount) given exactly one of them and
 * the effective price (quote per base, post-slippage). Pure.
 *
 * Exported for unit testing.
 */
export function computeOppositeAmount(args: {
  baseAmount: string | null;
  quoteAmount: string | null;
  effectivePrice: number;
}): { baseAmount: string; quoteAmount: string } {
  const { baseAmount, quoteAmount, effectivePrice } = args;
  if (baseAmount != null && quoteAmount != null) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Both baseAmount and quoteAmount provided; paper trade accepts only one.",
    );
  }
  if (baseAmount == null && quoteAmount == null) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Missing amount; paper trade requires either baseAmount or quoteAmount.",
    );
  }
  if (baseAmount != null) {
    const base = parseFloat(baseAmount);
    if (!Number.isFinite(base) || base <= 0) {
      throw new ToolError("INVALID_PARAMS", `Invalid baseAmount "${baseAmount}".`);
    }
    const quote = base * effectivePrice;
    return { baseAmount, quoteAmount: trimTrailingZeros(quote.toFixed(18)) };
  }
  const quote = parseFloat(quoteAmount as string);
  if (!Number.isFinite(quote) || quote <= 0) {
    throw new ToolError("INVALID_PARAMS", `Invalid quoteAmount "${quoteAmount}".`);
  }
  const base = quote / effectivePrice;
  return {
    baseAmount: trimTrailingZeros(base.toFixed(18)),
    quoteAmount: quoteAmount as string,
  };
}

function trimTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

// ── balance helpers (BigInt arithmetic via parseUnits) ───────

/**
 * Read the virtual balance for (account, chain, token). Returns
 * BigInt 0 when the row doesn't exist yet — paper trading
 * starts every account at zero by default; operators credit
 * the virtual book via deposits-from-real-holdings or
 * `paper reset --seed` (planned in #135) before firing trades.
 *
 * Exported for testing.
 */
export function readVirtualBalance(
  account: string,
  chain: string,
  token: string,
  decimals: number,
): bigint {
  const row = getPaperBalance(account, chain, token);
  if (!row) return 0n;
  try {
    return parseUnits(row.balance, decimals);
  } catch {
    // Defensive: corrupted row → treat as zero. The next upsert
    // will overwrite with a clean value.
    return 0n;
  }
}

function writeVirtualBalance(
  account: string,
  chain: string,
  token: string,
  decimals: number,
  amount: bigint,
): void {
  upsertPaperBalance({
    account,
    chain,
    token,
    balance: formatUnits(amount, decimals),
  });
}

// ── price resolution ─────────────────────────────────────────

/**
 * Derive the quote-per-base spot price from two independent USD
 * prices. For USDC / DAI / USDT quote tokens this collapses to
 * the base's USD price; for cross pairs (e.g. WETH/WBTC) we
 * divide.
 *
 * Returns null when either price is unavailable — paper trade
 * fails gracefully in that case so the operator notices the
 * data gap rather than firing against bogus prices.
 */
async function resolveSpotPrice(args: {
  baseAddress: Address;
  quoteAddress: Address;
  logger: Logger;
}): Promise<{ baseUsd: number; quoteUsd: number; spot: number } | null> {
  const baseUsd = await getCurrentPrice(args.baseAddress, args.logger);
  if (baseUsd == null || baseUsd <= 0) return null;
  const quoteUsd = await getCurrentPrice(args.quoteAddress, args.logger);
  if (quoteUsd == null || quoteUsd <= 0) return null;
  return { baseUsd, quoteUsd, spot: baseUsd / quoteUsd };
}

// ── main entry ───────────────────────────────────────────────

const DEFAULT_PAPER_SLIPPAGE_BPS = 50;

export async function executePaperTrade(
  req: PaperTradeRequest,
  ctx: PaperTradeContext,
): Promise<PaperTradeResult> {
  // Engine lock — paper trades also honor it. Reason: the operator
  // may want a global halt that covers paper too (e.g. during
  // major incidents where they're chasing logs and don't want
  // background noise).
  const { assertEngineNotLocked } = await import("./engineLock.js");
  assertEngineNotLocked({
    context: `paper trade ${req.direction} ${req.base}/${req.quote}`,
  });

  if ((req.baseAmount == null) === (req.quoteAmount == null)) {
    const requiredField = req.direction === "buy" ? "quoteAmount" : "baseAmount";
    throw new ToolError(
      "INVALID_PARAMS",
      `Paper ${req.direction} requires exactly one of baseAmount / quoteAmount (preferably ${requiredField}).`,
    );
  }

  // Resolve tokens (decimals + symbol).
  const baseIsNative =
    typeof req.base === "string" &&
    (req.base === "ETH" ||
      req.base.toUpperCase() === "ETH" ||
      req.base.toUpperCase() === "NATIVE");
  const baseAddr: Address = baseIsNative ? NATIVE_TOKEN : (req.base as Address);
  const quoteAddr: Address = req.quote;
  if (!baseIsNative && baseAddr.toLowerCase() === quoteAddr.toLowerCase()) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Base and quote are identical (${baseAddr}); paper trade rejected.`,
    );
  }

  const baseMeta = await getToken(ctx.publicClient, ctx.profile, baseAddr);
  const quoteMeta = await getToken(ctx.publicClient, ctx.profile, quoteAddr);

  // Spot price.
  const priceLookup = await resolveSpotPrice({
    baseAddress: baseAddr,
    quoteAddress: quoteAddr,
    logger: ctx.logger,
  });
  if (!priceLookup) {
    throw new ToolError(
      "PRICE_UNAVAILABLE",
      `Cannot determine spot price for ${baseMeta.symbol}/${quoteMeta.symbol}; paper trade aborted. Real-time prices are required so the virtual book reflects actual market conditions.`,
    );
  }
  const { baseUsd, spot } = priceLookup;

  // Slippage resolution.
  const slipBps =
    req.slippageBps ?? ctx.config.defaultSlippageBps ?? DEFAULT_PAPER_SLIPPAGE_BPS;
  const effectivePrice = applyWorstCaseSlippage(spot, req.direction, slipBps);

  // Amount math.
  const amounts = computeOppositeAmount({
    baseAmount: req.baseAmount ?? null,
    quoteAmount: req.quoteAmount ?? null,
    effectivePrice,
  });

  const baseAmountBig = parseUnits(amounts.baseAmount, baseMeta.decimals);
  const quoteAmountBig = parseUnits(amounts.quoteAmount, quoteMeta.decimals);

  // Virtual balance enforcement: the operator must have enough
  // of the INPUT token in the virtual book.
  //   BUY  → spends quote, receives base. Input = quote.
  //   SELL → spends base, receives quote. Input = base.
  const chain = ctx.profile.name.toLowerCase();
  const inputToken = req.direction === "buy" ? quoteAddr : baseAddr;
  const inputDecimals = req.direction === "buy" ? quoteMeta.decimals : baseMeta.decimals;
  const inputAmount = req.direction === "buy" ? quoteAmountBig : baseAmountBig;
  const inputSymbol = req.direction === "buy" ? quoteMeta.symbol : baseMeta.symbol;

  const inputBalance = readVirtualBalance(
    ctx.accountLabel,
    chain,
    inputToken,
    inputDecimals,
  );
  if (inputBalance < inputAmount) {
    throw new ToolError(
      "PAPER_INSUFFICIENT_BALANCE",
      `Virtual ${inputSymbol} balance ${formatUnits(inputBalance, inputDecimals)} is less than ${formatUnits(inputAmount, inputDecimals)} required to ${req.direction} ${baseMeta.symbol}/${quoteMeta.symbol}. Use \`tradekit paper deposit\` (#135) to seed the virtual book.`,
      {
        details: {
          chain,
          account: ctx.accountLabel,
          token: inputToken,
          required: formatUnits(inputAmount, inputDecimals),
          available: formatUnits(inputBalance, inputDecimals),
        },
      },
    );
  }

  // Apply the trade to the virtual book. Sequential to keep the
  // before/after deltas auditable in the log.
  const outputToken = req.direction === "buy" ? baseAddr : quoteAddr;
  const outputDecimals = req.direction === "buy" ? baseMeta.decimals : quoteMeta.decimals;
  const outputAmount = req.direction === "buy" ? baseAmountBig : quoteAmountBig;
  const outputBalance = readVirtualBalance(
    ctx.accountLabel,
    chain,
    outputToken,
    outputDecimals,
  );

  writeVirtualBalance(
    ctx.accountLabel,
    chain,
    inputToken,
    inputDecimals,
    inputBalance - inputAmount,
  );
  writeVirtualBalance(
    ctx.accountLabel,
    chain,
    outputToken,
    outputDecimals,
    outputBalance + outputAmount,
  );

  const timestamp = new Date().toISOString();
  const paperTradeId = recordPaperTrade({
    timestamp,
    source_type: req.source.type,
    source_id: req.source.id,
    chain,
    account: ctx.accountLabel,
    direction: req.direction,
    base_token: baseAddr,
    base_symbol: baseMeta.symbol,
    base_amount: amounts.baseAmount,
    quote_token: quoteAddr,
    quote_symbol: quoteMeta.symbol,
    quote_amount: amounts.quoteAmount,
    price: trimTrailingZeros(effectivePrice.toFixed(18)),
    slippage_bps: slipBps,
    strategy: req.strategy ?? null,
    notes: req.note ?? null,
  });

  const txHash = `paper:${paperTradeId}:${Date.parse(timestamp)}`;

  ctx.logger.info(
    `[paper] ${req.direction} ${amounts.baseAmount} ${baseMeta.symbol} ` +
      `@ ${trimTrailingZeros(effectivePrice.toFixed(8))} ${quoteMeta.symbol} ` +
      `(spot ${trimTrailingZeros(spot.toFixed(8))}, slip ${slipBps}bps) ` +
      `→ paper_trades #${paperTradeId}`,
  );

  return {
    ok: true,
    simulated: false,
    paper: true,
    timestamp,
    direction: req.direction,
    baseToken: baseAddr,
    baseSymbol: baseMeta.symbol,
    quoteToken: quoteAddr,
    quoteSymbol: quoteMeta.symbol,
    baseAmount: amounts.baseAmount,
    quoteAmount: amounts.quoteAmount,
    price: trimTrailingZeros(effectivePrice.toFixed(18)),
    estimatedUsd: baseUsd * parseFloat(amounts.baseAmount),
    aggregator: "paper",
    txHash,
    status: "success",
    slippageBps: slipBps,
    paperTradeId,
  };
}

// ── deposit / withdraw helpers (manual virtual-book mgmt) ────
//
// Operators need a way to SEED the virtual book before firing
// paper trades — otherwise every paper buy hits
// PAPER_INSUFFICIENT_BALANCE. Two options:
//
//   1. Manual deposit:    operator says "credit 10,000 USDC".
//   2. Mirror real holds: operator says "match my actual
//      holdings on this account/chain". (Useful when paper-
//      testing a strategy AGAINST your real portfolio shape
//      without actually trading it.)
//
// Both end in the same place: upsertPaperBalance. These helpers
// just centralize the BigInt arithmetic.

/** Credit (positive amount) or debit (negative amount) a virtual
 *  balance. Amount is a decimal string in the token's native units.
 *  Returns the post-operation balance as a decimal string. Throws
 *  PAPER_INSUFFICIENT_BALANCE on a debit that would go negative. */
export function adjustPaperBalance(args: {
  account: string;
  chain: string;
  token: string;
  decimals: number;
  delta: string; // signed decimal string
}): string {
  const chain = args.chain.toLowerCase();
  const sign = args.delta.startsWith("-") ? -1n : 1n;
  const absStr = args.delta.replace(/^-/, "");
  let absBig: bigint;
  try {
    absBig = parseUnits(absStr, args.decimals);
  } catch {
    throw new ToolError("INVALID_PARAMS", `Invalid delta "${args.delta}" for ${args.decimals}-decimal token.`);
  }
  const delta = sign * absBig;
  const current = readVirtualBalance(args.account, chain, args.token, args.decimals);
  const next = current + delta;
  if (next < 0n) {
    throw new ToolError(
      "PAPER_INSUFFICIENT_BALANCE",
      `Debit ${args.delta} would push virtual balance below zero (current ${formatUnits(current, args.decimals)}).`,
    );
  }
  writeVirtualBalance(args.account, chain, args.token, args.decimals, next);
  return formatUnits(next, args.decimals);
}

/** Set a virtual balance to an exact value. Used by `paper deposit
 *  --set` and by tests. */
export function setPaperBalance(args: {
  account: string;
  chain: string;
  token: string;
  decimals: number;
  amount: string;
}): void {
  let big: bigint;
  try {
    big = parseUnits(args.amount, args.decimals);
  } catch {
    throw new ToolError("INVALID_PARAMS", `Invalid amount "${args.amount}" for ${args.decimals}-decimal token.`);
  }
  if (big < 0n) {
    throw new ToolError("INVALID_PARAMS", `Amount cannot be negative ("${args.amount}").`);
  }
  writeVirtualBalance(args.account, args.chain.toLowerCase(), args.token, args.decimals, big);
}

// Defensive: surface isNativeSentinel so callers don't have to
// re-derive native handling.
export { isNativeSentinel };
