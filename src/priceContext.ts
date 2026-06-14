/**
 * Price context (v64) — "where does the current price sit, and which way
 * has it been going?"
 *
 * The agent's market-data surface had SPOT price (check_price) and DISCOVERY
 * (trending by volume/liquidity), but nothing to time an entry/exit: is the
 * token near the top or bottom of its recent range? trending up or down? how
 * volatile? Buying near a recent high vs a recent low is a very different
 * decision, and the agent had no way to tell. This composes the recent price
 * series (the same CoinGecko market_chart fetchPriceSeries the backtester
 * uses) into range / trend / position / volatility — the context an agent
 * (or operator) actually needs to decide WHEN, not just whether the token is
 * safe/liquid.
 *
 * Deterministic given the series: the compute is pure (exported + unit-
 * tested); the only IO is the series fetch, injectable for tests. Degrades
 * honestly: a token with no CoinGecko mapping returns null (not an error).
 */

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { fetchPriceSeries, type PricePoint } from "./backtest.js";

/** Range-position thresholds (% of the low→high band) for the plain-language
 *  verdict. Documented constants — not vibes. */
export const NEAR_HIGH_PCT = 80;
export const NEAR_LOW_PCT = 20;

/** A window move steeper than this (absolute %) is a strong trend — a buy into
 *  a steep decline is a falling-knife risk; a sell into a steep rise is selling
 *  into strength. Documented constant. */
export const STEEP_TREND_PCT = 15;
/** Period-return volatility at/above this (%) is "elevated" — surfaced as a
 *  sizing note, not a verdict driver on its own. */
export const ELEVATED_VOL_PCT = 12;

export interface PriceContextReport {
  coinId: string;
  windowDays: number;
  samples: number;
  currentPriceUsd: number;
  low: number;
  high: number;
  /** Where current sits in the low→high band (0 = at low, 100 = at high).
   *  Null when the window was perfectly flat (high == low). */
  rangePositionPct: number | null;
  /** current vs the window's first sample. */
  changePctWindow: number;
  /** current vs the sample closest to 24h before the last. Null when the
   *  window is shorter than ~24h or has too few points. */
  changePct24h: number | null;
  /** (high − low) / current × 100 — how wide the recent band is. */
  rangeWidthPct: number;
  /** Stddev of consecutive point-to-point % returns × 100. Null when < 2
   *  samples. A rough "how choppy" gauge, not annualized. */
  volatilityPct: number | null;
  /** Plain-language one-liner an agent/operator can read at a glance. */
  summary: string;
  generatedAt: string;
}

function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Pure: derive range / trend / position / volatility from a price series.
 * `points` must be ascending by timestamp (fetchPriceSeries guarantees it).
 * `now` is a seam for the 24h-ago lookup in tests.
 */
export function computePriceContext(
  points: readonly PricePoint[],
  windowDays: number,
  now?: Date,
): PriceContextReport {
  if (points.length === 0) {
    throw new Error("computePriceContext requires at least one price point");
  }
  const prices = points.map((p) => p.priceUsd);
  const current = prices[prices.length - 1];
  const first = prices[0];
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const rangePositionPct = high > low ? ((current - low) / (high - low)) * 100 : null;
  const changePctWindow = first > 0 ? ((current - first) / first) * 100 : 0;
  const rangeWidthPct = current > 0 ? ((high - low) / current) * 100 : 0;

  // 24h change: the sample closest to (lastTs − 24h).
  const lastMs = (now ?? new Date(points[points.length - 1].ts)).getTime();
  const targetMs = lastMs - 86_400_000;
  let changePct24h: number | null = null;
  // Only meaningful when the window actually spans ≥ ~24h.
  if (Date.parse(points[0].ts) <= targetMs) {
    let closest = points[0];
    let bestDelta = Infinity;
    for (const p of points) {
      const d = Math.abs(Date.parse(p.ts) - targetMs);
      if (d < bestDelta) { bestDelta = d; closest = p; }
    }
    if (closest.priceUsd > 0) {
      changePct24h = ((current - closest.priceUsd) / closest.priceUsd) * 100;
    }
  }

  // Period-return volatility.
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const sd = stddev(returns);
  const volatilityPct = sd != null ? sd * 100 : null;

  const position =
    rangePositionPct == null
      ? "flat range"
      : rangePositionPct >= NEAR_HIGH_PCT
        ? `near the ${windowDays}d high`
        : rangePositionPct <= NEAR_LOW_PCT
          ? `near the ${windowDays}d low`
          : `mid-range`;
  const trendArrow = changePctWindow > 0 ? "+" : "";
  const summary =
    `$${current.toLocaleString("en-US", { maximumFractionDigits: current < 1 ? 6 : 2 })} · ` +
    `${trendArrow}${changePctWindow.toFixed(1)}% over ${windowDays}d · ` +
    `${rangePositionPct != null ? `${rangePositionPct.toFixed(0)}% of range (${position})` : position}` +
    `${changePct24h != null ? ` · 24h ${changePct24h >= 0 ? "+" : ""}${changePct24h.toFixed(1)}%` : ""}`;

  return {
    coinId: "",
    windowDays,
    samples: points.length,
    currentPriceUsd: current,
    low,
    high,
    rangePositionPct,
    changePctWindow,
    changePct24h,
    rangeWidthPct,
    volatilityPct,
    summary,
    generatedAt: (now ?? new Date()).toISOString(),
  };
}

/**
 * Fetch the recent series for a token and compute its context. Returns null
 * when the token has no CoinGecko mapping (no price history available) —
 * the caller surfaces that as advice, not an error.
 */
export async function gatherPriceContext(args: {
  tokenAddress: string;
  windowDays: number;
  config?: Config;
  logger?: Logger;
  now?: Date;
  /** Test seam — defaults to fetchPriceSeries' live CoinGecko fetch. */
  fetchImpl?: (url: string) => Promise<unknown>;
}): Promise<PriceContextReport | null> {
  const series = await fetchPriceSeries(args.tokenAddress, args.windowDays, args.fetchImpl);
  if (series == null || series.points.length === 0) return null;
  const ctx = computePriceContext(series.points, args.windowDays, args.now);
  ctx.coinId = series.coinId;
  return ctx;
}

/** A direction-aware read of whether NOW is a good moment for THIS trade. */
export type TradeTimingFlag = "favorable" | "neutral" | "caution";

export interface TradeTimingAssessment {
  timing: TradeTimingFlag;
  /** Plain-language reasons behind the flag (may be empty for neutral). */
  notes: string[];
}

/**
 * Interpret a price context FOR a specific trade direction. The same context
 * means opposite things depending on what you're about to do: near the recent
 * high is a caution to BUY (buying the top) but favorable to SELL (taking the
 * top); near the low is the inverse. A steep decline is a falling-knife caution
 * for a buy; a steep rise is "selling into strength" for a sell.
 *
 * Pure + deterministic. `caution` if any caution signal fires; else `favorable`
 * if any favorable signal fires; else `neutral`. Volatility is a sizing note
 * that never drives the flag on its own.
 */
export function assessTradeTiming(
  ctx: PriceContextReport,
  direction: "buy" | "sell",
): TradeTimingAssessment {
  const notes: string[] = [];
  let caution = false;
  let favorable = false;
  const pos = ctx.rangePositionPct;
  const N = ctx.windowDays;
  const trend = ctx.changePctWindow;

  if (direction === "buy") {
    if (pos != null && pos >= NEAR_HIGH_PCT) {
      caution = true;
      notes.push(`buying near the ${N}d high (${pos.toFixed(0)}% of range) — chasing the top`);
    } else if (pos != null && pos <= NEAR_LOW_PCT) {
      favorable = true;
      notes.push(`near the ${N}d low (${pos.toFixed(0)}% of range) — favorable entry zone`);
    }
    if (trend <= -STEEP_TREND_PCT) {
      caution = true;
      notes.push(`down ${Math.abs(trend).toFixed(1)}% over ${N}d — falling-knife risk, the move down may not be finished`);
    }
  } else {
    if (pos != null && pos >= NEAR_HIGH_PCT) {
      favorable = true;
      notes.push(`near the ${N}d high (${pos.toFixed(0)}% of range) — favorable exit zone`);
    } else if (pos != null && pos <= NEAR_LOW_PCT) {
      caution = true;
      notes.push(`selling near the ${N}d low (${pos.toFixed(0)}% of range) — locking in a weak price`);
    }
    if (trend >= STEEP_TREND_PCT) {
      favorable = true;
      notes.push(`up ${trend.toFixed(1)}% over ${N}d — selling into strength`);
    }
  }

  // Volatility: informational sizing note, not a verdict driver.
  if (ctx.volatilityPct != null && ctx.volatilityPct >= ELEVATED_VOL_PCT) {
    notes.push(`elevated volatility (${ctx.volatilityPct.toFixed(1)}% period stddev) — wider swings, size accordingly`);
  }

  const timing: TradeTimingFlag = caution ? "caution" : favorable ? "favorable" : "neutral";
  return { timing, notes };
}

export function renderPriceContext(r: PriceContextReport, label: string): string {
  const lines: string[] = [];
  const fmt = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 })}`;
  lines.push(`Price context — ${label} (${r.coinId}) over ${r.windowDays}d`);
  lines.push(`  ${r.summary}`);
  lines.push(``);
  lines.push(`  Current:     ${fmt(r.currentPriceUsd)}`);
  lines.push(`  ${r.windowDays}d range:   ${fmt(r.low)} → ${fmt(r.high)}  (width ${r.rangeWidthPct.toFixed(1)}% of current)`);
  if (r.rangePositionPct != null) {
    lines.push(`  Position:    ${r.rangePositionPct.toFixed(0)}% of the range (0 = low, 100 = high)`);
  }
  lines.push(`  Trend:       ${r.changePctWindow >= 0 ? "+" : ""}${r.changePctWindow.toFixed(1)}% over ${r.windowDays}d${r.changePct24h != null ? ` · ${r.changePct24h >= 0 ? "+" : ""}${r.changePct24h.toFixed(1)}% over 24h` : ""}`);
  if (r.volatilityPct != null) {
    lines.push(`  Volatility:  ${r.volatilityPct.toFixed(2)}% (stddev of period returns) · ${r.samples} samples`);
  }
  return lines.join("\n");
}
