/**
 * Backtest risk metrics (v41).
 *
 * PnL alone is half a deploy decision. "+$50 vs hold's +$30" reads
 * as a win until you see the strategy spent the window at 2× hold's
 * drawdown — risk-adjusted comparison is the load-bearing signal,
 * and it requires computing the SAME metrics for the hold
 * counterfactual (different scales aren't comparable).
 *
 * Pure post-processing: given the initial balance, the fire timeline
 * (with per-fill deltas + gas), and the price series, rebuild the
 * mark-to-market equity curve point by point and derive:
 *   - max drawdown (% + USD + peak/trough timestamps)
 *   - annualized volatility + Sharpe (rf=0) from per-period returns
 *   - time-in-market (fraction of the window with base exposure)
 *   - a downsampled equity curve (≤100 points) for JSON/web consumers
 *
 * No simulator loop changes needed — this works identically for
 * order / schedule / playbook sims because they all emit the same
 * fire shape. Same quote-is-USD-pegged assumption as the simulator.
 *
 * Gas semantics mirror v40: per-fill gasCostUsd accumulates and is
 * charged against equity from the fill's timestamp onward (slippage
 * needs no handling here — it already lives in the fire deltas).
 */

import type { BacktestFire, PriceSeries, SymbolBalance } from "./backtest.js";

export interface EquityPoint {
  ts: string;
  equityUsd: number;
}

export interface BacktestMetrics {
  /** equityEnd / equityStart − 1, percent. */
  returnPct: number;
  /** Max peak-to-trough drawdown, percent (≥0; 0 = never below a peak). */
  maxDrawdownPct: number;
  /** Same drawdown in USD (peak equity − trough equity). */
  maxDrawdownUsd: number;
  /** Timestamp of the peak the max drawdown fell from (null if no drawdown). */
  peakTs: string | null;
  /** Timestamp of the trough of the max drawdown (null if no drawdown). */
  troughTs: string | null;
  /** Annualized stddev of per-period returns, percent. Null when the
   *  series has <3 points (no meaningful return sample). */
  volatilityPctAnnual: number | null;
  /** Annualized Sharpe ratio, rf=0. Null when volatility is null/zero
   *  (a flat curve has no risk to adjust for). */
  sharpe: number | null;
  /** Fraction of datapoints where base exposure ≥1% of equity, percent.
   *  "How long was this strategy actually in the market" — a stop that
   *  exits day 2 of 30 had 27 days of zero crypto risk. */
  timeInMarketPct: number;
  equityStartUsd: number;
  equityEndUsd: number;
  /** Equity curve downsampled to ≤100 points (endpoints always kept). */
  curve: EquityPoint[];
}

const CURVE_MAX_POINTS = 100;
/** Base exposure below 1% of equity counts as "out of the market" —
 *  dust from rounding must not read as full exposure. */
const IN_MARKET_FRACTION = 0.01;

/**
 * Rebuild the mark-to-market equity curve. Fires apply at their
 * datapoint timestamp BEFORE that point is valued (the sim fills at
 * the point's price, so the point's equity reflects the post-fill
 * book). OCO-cascade / halt rows carry zero deltas and no gas — they
 * pass through harmlessly.
 */
export function buildEquityCurve(args: {
  initialBalance: SymbolBalance;
  fires: BacktestFire[];
  series: PriceSeries;
  baseSymbol: string;
  quoteSymbol: string;
}): EquityPoint[] {
  const { initialBalance, fires, series, baseSymbol, quoteSymbol } = args;
  let base = initialBalance[baseSymbol] ?? 0;
  let quote = initialBalance[quoteSymbol] ?? 0;
  let gasPaid = 0;

  // Fires arrive in chronological order from every simulator, but
  // sort defensively — the walk below is a two-pointer merge.
  const sorted = [...fires].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  let fi = 0;

  const curve: EquityPoint[] = [];
  for (const pt of series.points) {
    while (fi < sorted.length && sorted[fi].ts <= pt.ts) {
      const f = sorted[fi];
      base += f.baseDelta;
      quote += f.quoteDelta;
      gasPaid += f.gasCostUsd ?? 0;
      fi++;
    }
    curve.push({ ts: pt.ts, equityUsd: base * pt.priceUsd + quote - gasPaid });
  }
  return curve;
}

export function computeBacktestMetrics(args: {
  initialBalance: SymbolBalance;
  fires: BacktestFire[];
  series: PriceSeries;
  baseSymbol: string;
  quoteSymbol: string;
}): BacktestMetrics | null {
  const { series } = args;
  if (series.points.length === 0) return null;
  const curve = buildEquityCurve(args);

  // ── time in market flags (per point) ──
  const inMarketFlags: boolean[] = [];
  {
    let base = (args.initialBalance[args.baseSymbol] ?? 0);
    const sorted = [...args.fires].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let fi = 0;
    for (let i = 0; i < series.points.length; i++) {
      const pt = series.points[i];
      while (fi < sorted.length && sorted[fi].ts <= pt.ts) {
        base += sorted[fi].baseDelta;
        fi++;
      }
      const equity = curve[i].equityUsd;
      inMarketFlags.push(equity > 0 && base * pt.priceUsd >= equity * IN_MARKET_FRACTION);
    }
  }

  return metricsFromCurve({ curve, inMarketFlags });
}

/**
 * v43: derive the full metric set from an already-built equity curve.
 * Extracted so the multi-pair playbook sim (which builds its curve
 * inline during the merged-timeline walk — fires don't carry their
 * base, so post-hoc reconstruction is impossible there) shares the
 * exact math with the single-pair path.
 */
export function metricsFromCurve(args: {
  curve: EquityPoint[];
  /** Per-point "base exposure ≥1% of equity" flags. Same length as
   *  curve; defaults to all-false when omitted. */
  inMarketFlags?: boolean[];
}): BacktestMetrics | null {
  const { curve } = args;
  if (curve.length === 0) return null;

  // ── drawdown: running-peak walk (same model as src/equity.ts) ──
  let peak = curve[0].equityUsd;
  let peakTs = curve[0].ts;
  let maxDdPct = 0;
  let maxDdUsd = 0;
  let ddPeakTs: string | null = null;
  let ddTroughTs: string | null = null;
  for (const p of curve) {
    if (p.equityUsd > peak) {
      peak = p.equityUsd;
      peakTs = p.ts;
    } else if (peak > 0) {
      const ddUsd = peak - p.equityUsd;
      const ddPct = (ddUsd / peak) * 100;
      if (ddPct > maxDdPct) {
        maxDdPct = ddPct;
        maxDdUsd = ddUsd;
        ddPeakTs = peakTs;
        ddTroughTs = p.ts;
      }
    }
  }

  // ── per-period returns → volatility + Sharpe ──
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equityUsd;
    if (prev > 0) returns.push(curve[i].equityUsd / prev - 1);
  }
  let volatilityPctAnnual: number | null = null;
  let sharpe: number | null = null;
  if (returns.length >= 2) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const sd = Math.sqrt(variance);
    const periodsPerYear = inferPeriodsPerYearFromTimestamps(curve.map((p) => p.ts));
    volatilityPctAnnual = sd * Math.sqrt(periodsPerYear) * 100;
    // A zero-vol curve has no risk to adjust for — sharpe stays null
    // rather than ±Infinity.
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : null;
  }

  const flags = args.inMarketFlags ?? [];
  const inMarket = flags.filter(Boolean).length;

  const equityStartUsd = curve[0].equityUsd;
  const equityEndUsd = curve[curve.length - 1].equityUsd;
  return {
    returnPct: equityStartUsd > 0 ? (equityEndUsd / equityStartUsd - 1) * 100 : 0,
    maxDrawdownPct: maxDdPct,
    maxDrawdownUsd: maxDdUsd,
    peakTs: ddPeakTs,
    troughTs: ddTroughTs,
    volatilityPctAnnual,
    sharpe,
    timeInMarketPct: (inMarket / curve.length) * 100,
    equityStartUsd,
    equityEndUsd,
    curve: downsampleCurve(curve, CURVE_MAX_POINTS),
  };
}

/** Median spacing between points → periods per year. Robust to the
 *  occasional gap in CoinGecko data (mean would skew on one hole). */
export function inferPeriodsPerYear(series: PriceSeries): number {
  return inferPeriodsPerYearFromTimestamps(series.points.map((p) => p.ts));
}

export function inferPeriodsPerYearFromTimestamps(ts: string[]): number {
  if (ts.length < 2) return 365;
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const dt = Date.parse(ts[i]) - Date.parse(ts[i - 1]);
    if (dt > 0) gaps.push(dt);
  }
  if (gaps.length === 0) return 365;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return (365 * 86_400_000) / median;
}

/** Evenly downsample to ≤max points, always keeping both endpoints —
 *  the curve is for eyeballing shape, not re-deriving the metrics. */
export function downsampleCurve(curve: EquityPoint[], max: number): EquityPoint[] {
  if (curve.length <= max) return curve;
  const out: EquityPoint[] = [];
  const step = (curve.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(curve[Math.round(i * step)]);
  }
  return out;
}
