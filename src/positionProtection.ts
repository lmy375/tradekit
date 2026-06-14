/**
 * Position protection audit (v76) — "which of my open positions have NO
 * downside protection, and how much value is exposed?"
 *
 * An autonomous agent accumulates spot positions. A position with no
 * protective exit (a trailing stop or a stop-loss) is fully exposed to a
 * crash — a single unguarded holding can crater the book. tradekit already
 * tracks open positions (v65) and conditional orders (trailing / price_below /
 * price_above) separately, but NOTHING cross-references them: the agent can
 * hold $5k of a token with zero automated downside exit and no surface says so.
 *
 * This joins the two: for each open position, find the active SELL orders that
 * would exit it on a downside move (trailing stop, or price_below stop-loss),
 * sum their covered amount, and report the unprotected remainder + its value at
 * risk. Take-profit orders (price_above sells) are counted separately — they're
 * an upside exit, NOT crash protection.
 *
 * The join is pure + unit-tested; the IO (open positions + orders) is injected.
 */

import { parseSizingSentinel } from "./sizing.js";
import type { Config } from "./config.js";
import type { PaperPriceFetcher } from "./paperPnl.js";

export type ProtectionStatus = "protected" | "partial" | "unprotected";

/** Minimal open-position shape the audit needs. */
export interface ProtPositionLite {
  chain: string;
  token: string;
  symbol: string | null;
  amount: number;
  currentPriceQuote: number | null;
  valueQuote: number | null;
}

/** Minimal order shape the audit needs (active sell-side orders). */
export interface ProtOrderLite {
  id: number;
  chain: string;
  base_token: string;
  side: string;
  trigger_type: string;
  base_amount: string | null;
  trail_pct: number | null;
  target_price_usd: number | null;
}

export interface ProtectingOrder {
  id: number;
  triggerType: string;
  /** Base units this order would sell (capped at the held amount). */
  coversAmount: number;
  trailPct: number | null;
  targetPriceUsd: number | null;
}

export interface PositionProtection {
  chain: string;
  token: string;
  symbol: string | null;
  heldAmount: number;
  heldValueUsd: number | null;
  /** Base units covered by downside-protective sell orders (trailing / stop). */
  protectedAmount: number;
  unprotectedAmount: number;
  /** unprotectedAmount × current price. null when the position is unpriced. */
  unprotectedValueUsd: number | null;
  status: ProtectionStatus;
  protectingOrders: ProtectingOrder[];
  /** Count of price_above sells on this token — an UPSIDE exit, not protection. */
  takeProfitOrders: number;
}

export interface PositionProtectionReport {
  positions: PositionProtection[];
  totalValueUsd: number | null;
  /** Sum of unprotectedValueUsd across priced positions. */
  totalUnprotectedValueUsd: number | null;
  unprotectedCount: number;
  partialCount: number;
  /** Positions whose value couldn't be priced (excluded from value-at-risk). */
  unpricedCount: number;
  summary: string;
  generatedAt: string;
}

/** A sell order is downside protection iff it exits on a fall: a trailing
 *  stop, or a price_below (stop-loss). price_above is take-profit (upside). */
function isDownsideProtective(o: ProtOrderLite): boolean {
  return o.side === "sell" && (o.trigger_type === "trailing" || o.trigger_type === "price_below");
}

/** How many base units a protective order covers, given the held amount.
 *  Dynamic sentinels: "max" → the whole position; "N%" → that fraction.
 *  A fixed decimal → its value. Always capped at `held` by the caller. */
function coveredAmount(orderAmount: string | null, held: number): number {
  if (orderAmount == null) return 0;
  const sentinel = parseSizingSentinel(orderAmount);
  if (sentinel) {
    return sentinel.kind === "max" ? held : held * sentinel.fraction;
  }
  const n = parseFloat(orderAmount);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Below this fraction of the held amount, coverage gaps / leftovers are noise. */
const COVERAGE_EPSILON = 0.01;

/**
 * Pure: cross-reference open positions against active sell orders to find
 * unprotected downside exposure. `now` only stamps the report.
 */
export function computeProtection(
  positions: readonly ProtPositionLite[],
  orders: readonly ProtOrderLite[],
  now?: Date,
): PositionProtectionReport {
  const out: PositionProtection[] = [];
  let totalValue = 0;
  let totalUnprotected = 0;
  let pricedAny = false;
  let unprotectedCount = 0;
  let partialCount = 0;
  let unpricedCount = 0;

  for (const pos of positions) {
    const held = pos.amount;
    // Orders on the same chain + base token.
    const matching = orders.filter(
      (o) => o.chain.toLowerCase() === pos.chain.toLowerCase() && o.base_token.toLowerCase() === pos.token.toLowerCase(),
    );
    const protective = matching.filter(isDownsideProtective);
    const takeProfitOrders = matching.filter((o) => o.side === "sell" && o.trigger_type === "price_above").length;

    const protectingOrders: ProtectingOrder[] = protective.map((o) => ({
      id: o.id,
      triggerType: o.trigger_type,
      coversAmount: Math.min(held, coveredAmount(o.base_amount, held)),
      trailPct: o.trail_pct,
      targetPriceUsd: o.target_price_usd,
    }));
    const protectedAmount = Math.min(
      held,
      protectingOrders.reduce((s, o) => s + o.coversAmount, 0),
    );
    const unprotectedAmount = Math.max(0, held - protectedAmount);

    const status: ProtectionStatus =
      protectedAmount >= held * (1 - COVERAGE_EPSILON)
        ? "protected"
        : protectedAmount <= held * COVERAGE_EPSILON
          ? "unprotected"
          : "partial";

    const price = pos.currentPriceQuote;
    const unprotectedValueUsd = price != null && Number.isFinite(price) ? unprotectedAmount * price : null;

    if (pos.valueQuote != null) {
      totalValue += pos.valueQuote;
      pricedAny = true;
    }
    if (unprotectedValueUsd != null) totalUnprotected += unprotectedValueUsd;
    else if (price == null) unpricedCount += 1;

    if (status === "unprotected") unprotectedCount += 1;
    else if (status === "partial") partialCount += 1;

    out.push({
      chain: pos.chain,
      token: pos.token,
      symbol: pos.symbol,
      heldAmount: held,
      heldValueUsd: pos.valueQuote,
      protectedAmount,
      unprotectedAmount,
      unprotectedValueUsd,
      status,
      protectingOrders,
      takeProfitOrders,
    });
  }

  // Worst (most exposed) first.
  out.sort((a, b) => (b.unprotectedValueUsd ?? 0) - (a.unprotectedValueUsd ?? 0));

  const totalUnprotectedValueUsd = pricedAny || totalUnprotected > 0 ? totalUnprotected : null;
  const exposed = unprotectedCount + partialCount;
  const summary =
    out.length === 0
      ? "No open positions to protect."
      : exposed === 0
        ? `All ${out.length} position${out.length === 1 ? "" : "s"} have downside protection.`
        : `${exposed} of ${out.length} position${out.length === 1 ? "" : "s"} lack full downside protection` +
          (totalUnprotectedValueUsd != null ? ` — $${totalUnprotectedValueUsd.toFixed(2)} exposed with no stop.` : ".");

  return {
    positions: out,
    totalValueUsd: pricedAny ? totalValue : null,
    totalUnprotectedValueUsd,
    unprotectedCount,
    partialCount,
    unpricedCount,
    summary,
    generatedAt: (now ?? new Date()).toISOString(),
  };
}

/**
 * DB-backed gatherer: open positions (v65 walker) × active sell orders →
 * the protection audit. mode 'real' (default) audits real holdings; 'paper'
 * audits the virtual book. markPriceFn is injectable for tests; production
 * uses the live fetcher so value-at-risk is real.
 */
export async function gatherPositionProtection(args: {
  mode?: "real" | "paper";
  account?: string;
  chain?: string;
  config?: Config;
  markPriceFn?: PaperPriceFetcher;
  now?: Date;
}): Promise<PositionProtectionReport> {
  const { gatherOpenPositions } = await import("./openPositions.js");
  const { listOrders } = await import("./db.js");
  const posReport = await gatherOpenPositions({
    mode: args.mode ?? "real",
    account: args.account,
    chain: args.chain,
    config: args.config,
    markPriceFn: args.markPriceFn,
    now: args.now,
  });
  const orders = listOrders({ status: "active", account: args.account, chain: args.chain });
  const positions: ProtPositionLite[] = posReport.positions.map((p) => ({
    chain: p.chain,
    token: p.token,
    symbol: p.symbol,
    amount: p.amount,
    currentPriceQuote: p.currentPriceQuote,
    valueQuote: p.valueQuote,
  }));
  const orderLites: ProtOrderLite[] = orders
    .filter((o) => o.side === "sell")
    .map((o) => ({
      id: o.id ?? 0,
      chain: o.chain,
      base_token: o.base_token,
      side: o.side,
      trigger_type: o.trigger_type,
      base_amount: o.base_amount,
      trail_pct: o.trail_pct,
      target_price_usd: o.target_price_usd,
    }));
  return computeProtection(positions, orderLites, args.now);
}

export function renderPositionProtection(r: PositionProtectionReport): string {
  const lines: string[] = [];
  lines.push("Position protection audit — open positions vs. active stop/trailing orders");
  lines.push(`  ${r.summary}`);
  if (r.positions.length === 0) return lines.join("\n");
  lines.push("");
  lines.push("  Status        Symbol      Held         Protected    Unprotected  At risk $   Stops");
  lines.push("  " + "-".repeat(92));
  const badge = (s: ProtectionStatus) =>
    s === "protected" ? "🟢 protected " : s === "partial" ? "🟡 partial   " : "🔴 UNPROTECTED";
  for (const p of r.positions) {
    const held = p.heldAmount.toPrecision(4);
    const prot = p.protectedAmount.toPrecision(4);
    const unprot = p.unprotectedAmount.toPrecision(4);
    const risk = p.unprotectedValueUsd != null ? `$${p.unprotectedValueUsd.toFixed(0)}` : "—";
    const stops = p.protectingOrders.length + (p.takeProfitOrders > 0 ? ` (+${p.takeProfitOrders} TP)` : "");
    lines.push(
      `  ${badge(p.status)} ${(p.symbol ?? "?").padEnd(10)} ${held.padStart(11)} ${prot.padStart(11)} ${unprot.padStart(11)} ${risk.padStart(9)}  ${stops}`,
    );
  }
  return lines.join("\n");
}
