/**
 * Execution quality report (v44).
 *
 * Trade execution is THE core of this tool, and every real fill
 * already records its forensics: realized_slippage_bps (iter641 —
 * signed, POSITIVE = unfavorable vs the quote), the aggregator that
 * served it, gas_cost_native, and the USD-pegged quote amount. This
 * module is the first surface that turns that record into the
 * production decisions it can answer:
 *
 *   - "Which aggregator actually serves me better?" → mode:first vs
 *     mode:best, or reorder the aggregator list.
 *   - "Does my slippage grow with order size?" → split larger orders.
 *   - "Is execution quality degrading?" → the offline twin of the
 *     slippage_trend alert, with the prior window as the baseline.
 *
 * Real trades only — paper fills carry SIMULATED slippage, and
 * judging execution from a simulation is circular (same rule as the
 * v40 cost calibration). Transfers / incoming rows are excluded:
 * they aren't swaps, so they have no execution quality to measure.
 *
 * Deterministic + offline: one indexed DB scan, no oracle calls. Gas
 * stays in NATIVE units (converting to USD would need a live price —
 * that honesty matters more than one merged number).
 */

import { recentTrades, type TradeRow } from "./db.js";

export interface SlippageStats {
  /** Fills that carried a recorded realized_slippage_bps. */
  samples: number;
  /** Signed bps — positive = unfavorable vs the quote. */
  avgBps: number | null;
  medianBps: number | null;
  /** 90th percentile (tail badness). */
  p90Bps: number | null;
}

export interface AggregatorCut {
  aggregator: string;
  fills: number;
  /** Fraction of all fills, percent. */
  sharePct: number;
  usdVolume: number;
  /** success / (success + failed) attempts routed to this aggregator. */
  successRatePct: number | null;
  slippage: SlippageStats;
  avgGasNative: number | null;
}

export interface PairCut {
  baseSymbol: string;
  fills: number;
  usdVolume: number;
  slippage: SlippageStats;
}

export interface SizeBucketCut {
  label: string;
  minUsd: number;
  maxUsd: number | null;
  fills: number;
  slippage: SlippageStats;
}

export interface ExecutionTrend {
  /** Median over the trailing `recentDays`. */
  recent: SlippageStats;
  /** Median over the window BEFORE the recent slice. */
  prior: SlippageStats;
  recentDays: number;
  /** recentMedian − priorMedian (positive = getting worse). Null when
   *  either side lacks samples. */
  deltaMedianBps: number | null;
}

export interface ExecutionReport {
  generatedAt: string;
  windowLabel: string;
  windowStart: string | null;
  chain: string | null;
  account: string | null;
  totals: {
    attempts: number;
    fills: number;
    failed: number;
    pending: number;
    successRatePct: number | null;
    usdVolume: number;
    slippage: SlippageStats;
    /** Fills carrying recorded slippage / fills, percent. Low coverage
     *  means the verdicts below rest on a thin sample — `tradekit
     *  reconcile` backfills it from receipts. */
    slippageCoveragePct: number | null;
    /** Per chain: total + average gas in NATIVE units. */
    gasByChain: Array<{ chain: string; totalNative: number; avgNative: number; samples: number }>;
  };
  byAggregator: AggregatorCut[];
  byPair: PairCut[];
  bySize: SizeBucketCut[];
  trend: ExecutionTrend | null;
  /** Deterministic, threshold-gated hints. Empty = no actionable signal. */
  recommendations: string[];
}

const SIZE_BUCKETS: Array<{ label: string; min: number; max: number | null }> = [
  { label: "<$100", min: 0, max: 100 },
  { label: "$100–1k", min: 100, max: 1000 },
  { label: "$1k–10k", min: 1000, max: 10_000 },
  { label: "≥$10k", min: 10_000, max: null },
];

/** Not real swaps — no execution quality to measure. */
const NON_SWAP_AGGREGATORS = new Set(["transfer", "incoming"]);

const TREND_RECENT_DAYS = 7;
/** Minimum samples per side before a comparison earns a verdict. */
const MIN_COMPARE_SAMPLES = 5;
const MIN_AGGREGATOR_SAMPLES = 10;

export function median(sorted: number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(sorted: number[], q: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  return sorted[Math.min(n - 1, Math.ceil(q * n) - 1)];
}

export function slippageStats(values: number[]): SlippageStats {
  if (values.length === 0) return { samples: 0, avgBps: null, medianBps: null, p90Bps: null };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return {
    samples: values.length,
    avgBps: avg,
    medianBps: median(sorted),
    p90Bps: percentile(sorted, 0.9),
  };
}

function slippageOf(rows: TradeRow[]): number[] {
  return rows
    .map((r) => r.realized_slippage_bps)
    .filter((v): v is number => v != null && Number.isFinite(v));
}

function usdOf(r: TradeRow): number {
  const v = parseFloat(r.quote_amount);
  return Number.isFinite(v) ? v : 0;
}

export function gatherExecutionReport(args: {
  windowLabel: string;
  sinceIso?: string;
  chain?: string;
  account?: string;
  now?: Date;
}): ExecutionReport {
  const now = args.now ?? new Date();
  const rows = recentTrades({
    chain: args.chain,
    account: args.account,
    since: args.sinceIso,
    limit: 10_000,
  }).filter((r) => !NON_SWAP_AGGREGATORS.has(r.aggregator ?? ""));

  const fills = rows.filter((r) => r.status === "success");
  const failed = rows.filter((r) => r.status === "failed");
  const pending = rows.filter((r) => r.status === "pending");
  const decided = fills.length + failed.length;

  const allSlippage = slippageOf(fills);
  const usdVolume = fills.reduce((s, r) => s + usdOf(r), 0);

  // ── gas per chain (native units — no oracle) ──
  const gasMap = new Map<string, { total: number; samples: number }>();
  for (const r of fills) {
    const g = r.gas_cost_native != null ? parseFloat(r.gas_cost_native) : NaN;
    if (!Number.isFinite(g)) continue;
    const cur = gasMap.get(r.chain) ?? { total: 0, samples: 0 };
    cur.total += g;
    cur.samples++;
    gasMap.set(r.chain, cur);
  }
  const gasByChain = [...gasMap.entries()]
    .map(([chain, g]) => ({ chain, totalNative: g.total, avgNative: g.total / g.samples, samples: g.samples }))
    .sort((a, b) => b.samples - a.samples);

  // ── by aggregator ──
  const aggOf = (r: TradeRow) => r.aggregator ?? "(unknown)";
  const aggNames = [...new Set(rows.map(aggOf))];
  const byAggregator: AggregatorCut[] = aggNames
    .map((name) => {
      const aggFills = fills.filter((r) => aggOf(r) === name);
      const aggFailed = failed.filter((r) => aggOf(r) === name);
      const aggDecided = aggFills.length + aggFailed.length;
      const gas = aggFills
        .map((r) => (r.gas_cost_native != null ? parseFloat(r.gas_cost_native) : NaN))
        .filter((g) => Number.isFinite(g));
      return {
        aggregator: name,
        fills: aggFills.length,
        sharePct: fills.length > 0 ? (aggFills.length / fills.length) * 100 : 0,
        usdVolume: aggFills.reduce((s, r) => s + usdOf(r), 0),
        successRatePct: aggDecided > 0 ? (aggFills.length / aggDecided) * 100 : null,
        slippage: slippageStats(slippageOf(aggFills)),
        avgGasNative: gas.length > 0 ? gas.reduce((s, g) => s + g, 0) / gas.length : null,
      };
    })
    .filter((c) => c.fills > 0 || c.successRatePct != null)
    .sort((a, b) => b.fills - a.fills);

  // ── by pair (top 8 by volume) ──
  const pairNames = [...new Set(fills.map((r) => r.base_symbol ?? "(unknown)"))];
  const byPair: PairCut[] = pairNames
    .map((sym) => {
      const pairFills = fills.filter((r) => (r.base_symbol ?? "(unknown)") === sym);
      return {
        baseSymbol: sym,
        fills: pairFills.length,
        usdVolume: pairFills.reduce((s, r) => s + usdOf(r), 0),
        slippage: slippageStats(slippageOf(pairFills)),
      };
    })
    .sort((a, b) => b.usdVolume - a.usdVolume)
    .slice(0, 8);

  // ── by size ──
  const bySize: SizeBucketCut[] = SIZE_BUCKETS.map((b) => {
    const inBucket = fills.filter((r) => {
      const usd = usdOf(r);
      return usd >= b.min && (b.max == null || usd < b.max);
    });
    return {
      label: b.label,
      minUsd: b.min,
      maxUsd: b.max,
      fills: inBucket.length,
      slippage: slippageStats(slippageOf(inBucket)),
    };
  }).filter((b) => b.fills > 0);

  // ── trend: trailing 7d vs the rest of the window ──
  let trend: ExecutionTrend | null = null;
  {
    const cutoff = new Date(now.getTime() - TREND_RECENT_DAYS * 86_400_000).toISOString();
    const recentRows = fills.filter((r) => r.timestamp >= cutoff);
    const priorRows = fills.filter((r) => r.timestamp < cutoff);
    const recent = slippageStats(slippageOf(recentRows));
    const prior = slippageStats(slippageOf(priorRows));
    if (recent.samples > 0 || prior.samples > 0) {
      trend = {
        recent,
        prior,
        recentDays: TREND_RECENT_DAYS,
        deltaMedianBps:
          recent.samples >= MIN_COMPARE_SAMPLES && prior.samples >= MIN_COMPARE_SAMPLES
            ? recent.medianBps! - prior.medianBps!
            : null,
      };
    }
  }

  const slippageCoveragePct = fills.length > 0 ? (allSlippage.length / fills.length) * 100 : null;

  // ── deterministic recommendations (threshold-gated) ──
  const recommendations: string[] = [];
  {
    const ranked = byAggregator.filter((c) => c.slippage.samples >= MIN_AGGREGATOR_SAMPLES && c.slippage.medianBps != null);
    if (ranked.length >= 2) {
      const sorted = [...ranked].sort((a, b) => a.slippage.medianBps! - b.slippage.medianBps!);
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      if (worst.slippage.medianBps! - best.slippage.medianBps! >= 10) {
        recommendations.push(
          `${best.aggregator} fills at median ${best.slippage.medianBps!.toFixed(1)}bps vs ${worst.aggregator}'s ${worst.slippage.medianBps!.toFixed(1)}bps (≥${MIN_AGGREGATOR_SAMPLES} fills each) — consider \`aggregator.mode: "best"\` or moving ${best.aggregator} up the aggregator list.`,
        );
      }
    }
    const sized = bySize.filter((b) => b.slippage.samples >= MIN_COMPARE_SAMPLES && b.slippage.medianBps != null);
    if (sized.length >= 2) {
      const smallest = sized[0];
      const largest = sized[sized.length - 1];
      if (largest.slippage.medianBps! - smallest.slippage.medianBps! >= 15) {
        recommendations.push(
          `Slippage grows with size: median ${largest.slippage.medianBps!.toFixed(1)}bps in ${largest.label} vs ${smallest.slippage.medianBps!.toFixed(1)}bps in ${smallest.label} — price impact is visible; consider splitting larger orders (e.g. a schedule with smaller per-fire amounts).`,
        );
      }
    }
    if (trend?.deltaMedianBps != null && trend.deltaMedianBps >= 10) {
      recommendations.push(
        `Execution quality is degrading: last ${trend.recentDays}d median ${trend.recent.medianBps!.toFixed(1)}bps vs prior ${trend.prior.medianBps!.toFixed(1)}bps (+${trend.deltaMedianBps.toFixed(1)}). Check RPC health, pool depth, and the slippage_trend alert rule.`,
      );
    }
    if (slippageCoveragePct != null && slippageCoveragePct < 50 && fills.length >= 10) {
      recommendations.push(
        `Only ${slippageCoveragePct.toFixed(0)}% of fills carry recorded slippage — run \`tradekit reconcile\` to backfill realized_slippage_bps from receipts before trusting these numbers.`,
      );
    }
  }

  return {
    generatedAt: now.toISOString(),
    windowLabel: args.windowLabel,
    windowStart: args.sinceIso ?? null,
    chain: args.chain ?? null,
    account: args.account ?? null,
    totals: {
      attempts: rows.length,
      fills: fills.length,
      failed: failed.length,
      pending: pending.length,
      successRatePct: decided > 0 ? (fills.length / decided) * 100 : null,
      usdVolume,
      slippage: slippageStats(allSlippage),
      slippageCoveragePct,
      gasByChain,
    },
    byAggregator,
    byPair,
    bySize,
    trend,
    recommendations,
  };
}

// ── rendering ────────────────────────────────────────────────

function fmtBps(v: number | null): string {
  return v == null ? "—" : `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(1)}`;
}

function fmtStats(s: SlippageStats): string {
  if (s.samples === 0) return "no slippage samples";
  return `median ${fmtBps(s.medianBps)}bps · avg ${fmtBps(s.avgBps)} · p90 ${fmtBps(s.p90Bps)} (${s.samples} sample${s.samples === 1 ? "" : "s"})`;
}

export function renderExecutionReport(r: ExecutionReport): string {
  const lines: string[] = [];
  const t = r.totals;
  lines.push(`Execution quality — last ${r.windowLabel}${r.chain ? ` · chain ${r.chain}` : ""}${r.account ? ` · account ${r.account}` : ""}`);
  lines.push(``);
  if (t.attempts === 0) {
    lines.push(`  No real swaps in window. (Paper fills are excluded — simulated slippage isn't execution quality.)`);
    return lines.join("\n");
  }
  lines.push(`  Attempts:   ${t.attempts} (${t.fills} filled / ${t.failed} failed / ${t.pending} pending)${t.successRatePct != null ? `   success ${t.successRatePct.toFixed(1)}%` : ""}`);
  lines.push(`  Volume:     $${t.usdVolume.toFixed(2)}`);
  lines.push(`  Slippage:   ${fmtStats(t.slippage)}${t.slippageCoveragePct != null ? `   coverage ${t.slippageCoveragePct.toFixed(0)}% of fills` : ""}`);
  lines.push(`              (signed: positive = worse than quoted)`);
  for (const g of t.gasByChain) {
    lines.push(`  Gas (${g.chain}): ${g.totalNative.toPrecision(4)} native total · avg ${g.avgNative.toPrecision(3)}/fill over ${g.samples}`);
  }

  if (r.byAggregator.length > 0) {
    lines.push(``);
    lines.push(`  By aggregator:`);
    const w = Math.max(10, ...r.byAggregator.map((c) => c.aggregator.length)) + 2;
    lines.push(`    ${"NAME".padEnd(w)} ${"FILLS".padStart(5)}  ${"SHARE".padStart(6)}  ${"MEDIAN".padStart(7)}  ${"P90".padStart(6)}  ${"SUCCESS".padStart(8)}  ${"VOLUME".padStart(11)}`);
    for (const c of r.byAggregator) {
      lines.push(
        `    ${c.aggregator.padEnd(w)} ${String(c.fills).padStart(5)}  ${`${c.sharePct.toFixed(0)}%`.padStart(6)}  ${`${fmtBps(c.slippage.medianBps)}`.padStart(7)}  ${`${fmtBps(c.slippage.p90Bps)}`.padStart(6)}  ${(c.successRatePct != null ? `${c.successRatePct.toFixed(0)}%` : "—").padStart(8)}  ${`$${c.usdVolume.toFixed(0)}`.padStart(11)}`,
      );
    }
  }

  if (r.byPair.length > 0) {
    lines.push(``);
    lines.push(`  By pair (top by volume):`);
    for (const p of r.byPair) {
      lines.push(`    ${p.baseSymbol.padEnd(10)} ${String(p.fills).padStart(4)} fills  $${p.usdVolume.toFixed(0).padStart(9)}   ${fmtStats(p.slippage)}`);
    }
  }

  if (r.bySize.length > 0) {
    lines.push(``);
    lines.push(`  By order size:`);
    for (const b of r.bySize) {
      lines.push(`    ${b.label.padEnd(10)} ${String(b.fills).padStart(4)} fills   ${fmtStats(b.slippage)}`);
    }
  }

  if (r.trend) {
    lines.push(``);
    const d = r.trend.deltaMedianBps;
    lines.push(
      `  Trend: last ${r.trend.recentDays}d ${fmtStats(r.trend.recent)} vs prior ${fmtStats(r.trend.prior)}` +
        (d != null ? `  → ${d >= 0 ? "worse" : "better"} by ${Math.abs(d).toFixed(1)}bps` : `  (too few samples for a verdict)`),
    );
  }

  lines.push(``);
  if (r.recommendations.length === 0) {
    lines.push(`  Recommendations: (none — no threshold-crossing signal in this window)`);
  } else {
    lines.push(`  Recommendations:`);
    for (const rec of r.recommendations) lines.push(`    ⚠ ${rec}`);
  }
  return lines.join("\n");
}
