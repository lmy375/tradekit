// Iter623: aggregator quality scorecard. Pre-iter623 a trader using multiple
// aggregators (config.aggregator.preferred = ["kyberswap", "openocean", ...])
// had no way to retrospectively answer "which aggregator gave me the best
// fills?". The data was in the DB — every trade row stores its `aggregator`
// field; iter619 analysis surfaces realized slippage per tx — but the roll-up
// didn't exist.
//
// This module is pure composition: it takes (rows × analyses) → per-aggregator
// stats. CLI/MCP layer fetches both inputs and calls the pure compute. Pure
// because:
//   1. Aggregator selection is config-dependent and per-trader; doing math in
//      the IO layer would make the rules untestable.
//   2. Operators auditing their fills via JSON output want a stable contract.
//      Pure-compute makes that contract easy to pin in tests.
//
// Why median + p95 instead of mean: realized slippage has heavy right-tail
// (occasional MEV / sandwich attacks). Mean gets pulled by the outliers and
// hides the typical experience. Median shows the typical fill; p95 shows the
// "bad day" exposure. Operators care about both.

import type { TradeRow } from "./db.js";
import { isStablecoin } from "./stablecoins.js";
import { failureReasonHistogram } from "./db.js";
import type { AnalyzedTrade } from "./tradeAnalysis.js";
import { resolveAggregatorOrder, type ProviderName } from "./aggregator.js";

export interface AggregatorStat {
  /** Aggregator name as stored in trades.aggregator (e.g. "kyberswap"). */
  aggregator: string;
  /** Total trades attempted via this aggregator in the scoped window. */
  tradeCount: number;
  /** Trades with status="success". */
  successCount: number;
  /** Trades with status="failed". */
  failedCount: number;
  /** Trades still status="pending" — not yet reconciled. */
  pendingCount: number;
  /** successCount / tradeCount (0..1). Null when tradeCount == 0. */
  successRate: number | null;
  /** Median realized slippage in basis points across analyzed trades.
   *  Null when no trade has an analysis. Lower = better. */
  medianSlippageBps: number | null;
  /** 95th-percentile slippage — your "bad day" exposure. Null when count < 5
   *  (the percentile is meaningless on tiny samples). */
  p95SlippageBps: number | null;
  /** Mean of analyzed slippage. Pulled by outliers; reported alongside
   *  median so operators can spot heavy-tail patterns. Null when no analysis. */
  avgSlippageBps: number | null;
  /** Sum of USD volume traded via this aggregator (from quote_amount × 1 for
   *  stables; volatile quote tokens skipped — see `volumeNotePartial`). */
  totalUsdVolume: number;
  /** True when some success trades couldn't be USD-priced and so the
   *  totalUsdVolume understates true volume. Flagged so consumers don't take
   *  the number at face value. */
  volumeNotePartial: boolean;
  /** Number of analyzed trades — the basis for slippage stats. */
  analyzedCount: number;
  /** Verdict-bucket distribution from iter619 — same code set:
   *  excellent / ok / minor_slip / major_slip / extreme_slip / no_match /
   *  reverted / pending / unknown. */
  byVerdict: Record<string, number>;
  /** Iter701: ISO timestamp of the most-recent trade via this aggregator.
   *  Operators asking "is openocean still in my flow?" get the answer
   *  inline instead of scanning recent_trades. Absent only when bucketRows
   *  is empty (unreachable in practice — buckets are non-empty by
   *  construction in computeAggregatorStats). */
  lastSeen?: string;
  /** Iter672: revert reason histogram for this aggregator's failed trades.
   *  Sourced from the iter669-persisted revert_reason column. Sorted by
   *  count desc; NULL bucketed as "(unknown)". Empty array when this
   *  aggregator had no failures (or none with reasons). Use to differentiate
   *  "this aggregator fails on slippage" vs "this aggregator fails on
   *  liquidity" — different remediation paths.
   *  Iter699: each entry may carry `lastSeen` from row timestamps. */
  failureReasons: Array<{ reason: string; count: number; lastSeen?: string }>;
}

export interface AggregatorStatsReport {
  /** ISO timestamp the report was computed. */
  timestamp: string;
  /** ISO timestamp lower bound used for the row filter. Useful for caching
   *  and for downstream "stats over time" tooling. */
  since?: string;
  /** Total rows considered (across all aggregators). */
  totalTrades: number;
  /** One entry per aggregator that appears in the row set. Sorted by
   *  tradeCount desc (most-used first). */
  byAggregator: AggregatorStat[];
  /**
   * Optional one-line recommendation surfaced when the data supports it:
   *   - "kyberswap leads on median slippage (N bps) across M trades"
   *   - "openocean has highest success rate at X%"
   * Omitted entirely when the sample sizes are too small to recommend.
   */
  recommendation?: string;
  /**
   * Iter733: structured aggregator name behind `recommendation`. Operators
   * (and agents) can compare directly against `config.aggregator.preferred[0]`
   * to detect config drift without parsing the prose. Absent when
   * recommendation is undefined.
   */
  recommendedAggregator?: string;
  /**
   * Iter688: symmetric warnings about underperforming aggregators. Each
   * string flags a specific aggregator that lags peers by a meaningful
   * margin — success rate gap ≥15 pct or median slippage gap ≥50 bps.
   * Both rules require ≥10 trades on the underperformer side to filter
   * noise. Empty array when no aggregator stands out as bad; absent only
   * when the input had too few eligible aggregators to compare.
   */
  warnings: string[];
  /** Iter744: wall-clock ms for the computeAggregatorStats call. Symmetric
   *  with iter725/727/728/729/736 elapsedMs across reconcile/pnl/portfolio/
   *  health/trades_sync. Compute is CPU-only, so values are typically tiny
   *  (<10ms on a few-thousand-row trade history); useful for cron operators
   *  tracking compute cost over time + as a flag for "did the report
   *  actually run" in pipelines that may short-circuit on empty inputs. */
  elapsedMs?: number;
  /** Iter803: worst-bucket severity. "warn" when any aggregator
   *  underperformer warning fired; "ok" otherwise. Lets dashboards branch
   *  on one field instead of checking warnings.length > 0. Symmetric with
   *  iter786/787/788/801 severity fields across other report types. */
  severity: "ok" | "warn";
  /** Iter835: structured dispatch. Emitted when there's a clear next step:
   *  recommendedAggregator differs from config preference (suggest config
   *  rotation) OR underperformer warnings fired (suggest investigation via
   *  pair stats / trades analyze). Always present. */
  recommendedActions: import("./errors.js").NextAction[];
}

/**
 * Iter623: pure percentile helper. Walks a sorted-ascending array and returns
 * the value at the requested percentile (0..100). Returns null for empty
 * input. Linear interpolation between bracket values for non-integer indexes.
 *
 * Exported for unit testing without setting up trade rows.
 */
export function percentile(sortedAsc: readonly number[], pct: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (pct <= 0) return sortedAsc[0];
  if (pct >= 100) return sortedAsc[sortedAsc.length - 1];
  const idx = (pct / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}


/**
 * Iter623: estimate USD volume contributed by a single trade row. Same
 * conservative model as pnl.ts: stablecoin quote = $1 per unit; non-stable
 * quote = unknown (returns null). The caller decides what to do with nulls
 * (we surface volumeNotePartial when ANY row in an aggregator's set is null).
 *
 * Exported for unit testing.
 */
export function estimateRowUsdVolume(row: TradeRow): number | null {
  if (!isStablecoin(row.quote_symbol)) return null;
  const q = parseFloat(row.quote_amount);
  return Number.isFinite(q) ? q : null;
}

/**
 * Iter623: build per-aggregator stats from a flat row set + optional analyses.
 *
 * `analyses` keyed by tx_hash. When a row has a matching analysis with a
 * `comparison`, its slippageBps contributes to the median/avg/p95 numbers.
 * Rows without analyses still count toward tradeCount/successCount/etc — they
 * just don't move the slippage bucket.
 *
 * Pure: no I/O, no logger. Returns a NEW report — operators can call this on
 * any time-window slice without worrying about mutation.
 */
export function computeAggregatorStats(
  rows: readonly TradeRow[],
  analyses: readonly AnalyzedTrade[],
  options?: { since?: string },
): AggregatorStatsReport {
  // Iter744: wall-clock timing. Closes out the timing-observability sequence
  // started with iter725 reconcile. Compute is CPU-only (no RPC), so this is
  // typically <10ms — but cron operators tracking compute cost over time
  // benefit from the symmetric field.
  const t0 = Date.now();
  // Index analyses by tx_hash. We could iterate `rows × analyses` but rows can
  // be large; the map lookup makes it linear.
  const analysisByHash = new Map<string, AnalyzedTrade>();
  for (const a of analyses) {
    analysisByHash.set(a.txHash.toLowerCase(), a);
  }

  // Bucket rows by aggregator. NULL or empty aggregator strings collapse into
  // "unknown" — we want to surface that some trades have no aggregator metadata,
  // not silently drop them.
  const buckets = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const key = row.aggregator?.trim() || "unknown";
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }

  const byAggregator: AggregatorStat[] = [];
  for (const [aggregator, bucketRows] of buckets.entries()) {
    const tradeCount = bucketRows.length;
    let successCount = 0;
    let failedCount = 0;
    let pendingCount = 0;
    let totalUsdVolume = 0;
    let volumeNotePartial = false;
    const slips: number[] = [];
    const byVerdict: Record<string, number> = {};

    for (const row of bucketRows) {
      if (row.status === "success") successCount++;
      else if (row.status === "failed") failedCount++;
      else if (row.status === "pending") pendingCount++;

      // Volume — only count success rows so we don't inflate by failed/pending
      // attempts.
      if (row.status === "success") {
        const usd = estimateRowUsdVolume(row);
        if (usd != null) {
          totalUsdVolume += usd;
        } else {
          volumeNotePartial = true;
        }
      }

      // Iter641: prefer the stored realized_slippage_bps over live analysis.
      // The DB value was computed at trade time from the same comparison
      // logic — no per-row RPC cost. Live analysis is the fallback for legacy
      // rows that don't have it.
      const analysis = analysisByHash.get(row.tx_hash.toLowerCase());
      if (row.realized_slippage_bps != null && Number.isFinite(row.realized_slippage_bps)) {
        slips.push(row.realized_slippage_bps);
        // byVerdict still benefits from the analysis when present.
        if (analysis) byVerdict[analysis.finding.code] = (byVerdict[analysis.finding.code] ?? 0) + 1;
      } else if (analysis) {
        byVerdict[analysis.finding.code] = (byVerdict[analysis.finding.code] ?? 0) + 1;
        if (analysis.comparison) {
          slips.push(analysis.comparison.slippageBps);
        }
      }
    }

    const sortedSlips = [...slips].sort((a, b) => a - b);
    const median = percentile(sortedSlips, 50);
    const p95 = sortedSlips.length >= 5 ? percentile(sortedSlips, 95) : null;
    const avg = sortedSlips.length > 0
      ? sortedSlips.reduce((s, n) => s + n, 0) / sortedSlips.length
      : null;
    const successRate = tradeCount > 0 ? successCount / tradeCount : null;
    // Iter672/iter675: per-aggregator failure histogram via the shared helper.
    const failureReasons = failureReasonHistogram(bucketRows);
    // Iter701: MAX(timestamp) per aggregator — when did this aggregator
    // last execute a trade? ISO strings are lex-comparable in UTC.
    let lastSeen: string | undefined;
    for (const r of bucketRows) {
      if (!lastSeen || r.timestamp > lastSeen) lastSeen = r.timestamp;
    }

    byAggregator.push({
      aggregator,
      tradeCount,
      successCount,
      failedCount,
      pendingCount,
      successRate,
      medianSlippageBps: median,
      p95SlippageBps: p95,
      avgSlippageBps: avg,
      totalUsdVolume,
      volumeNotePartial,
      analyzedCount: slips.length,
      byVerdict,
      failureReasons,
      ...(lastSeen ? { lastSeen } : {}),
    });
  }

  // Sort most-used first — operators looking at the report scan the top row.
  byAggregator.sort((a, b) => b.tradeCount - a.tradeCount);

  // Iter733: derive recommendation once + capture both the prose AND the
  // structured winner name. Pre-iter733 callers parsing recommendation prose
  // for the winner have always been fragile; this gives them a typed field.
  const recoStruct = deriveRecommendationStructured(byAggregator);
  const warnings = deriveWarnings(byAggregator);
  // Iter835: structured dispatch. Recommendation-side: when the
  // structured recommended aggregator exists, emit a config rotation
  // dispatch (agents can compare against config and act). Warning-side:
  // when underperformers exist, emit one action pointing at trades analyze
  // to investigate specific failing aggregator's recent trades.
  const recommendedActions: import("./errors.js").NextAction[] = [];
  if (recoStruct) {
    recommendedActions.push({
      tool: "config",
      params: { action: "show" },
      reason: `${recoStruct.message}. Compare against config.aggregator.preferred[0] and rotate via config set if it differs.`,
    });
  }
  if (warnings.length > 0) {
    // Find the first underperforming aggregator by parsing the warning string
    // for the lagging aggregator's name. Falls back to the lowest-success
    // entry if parsing fails. Empty byAggregator can't fire warnings, so
    // byAggregator[0] is safe.
    const worst = [...byAggregator].sort((a, b) => (a.successRate ?? 1) - (b.successRate ?? 1))[0];
    recommendedActions.push({
      tool: "analyze_trade",
      params: { aggregator: worst.aggregator, recent: 20 },
      reason: `${warnings.length} aggregator underperformer warning${warnings.length === 1 ? "" : "s"} — investigate the worst (${worst.aggregator}) via per-trade analysis.`,
    });
  }
  return {
    timestamp: new Date().toISOString(),
    since: options?.since,
    totalTrades: rows.length,
    byAggregator,
    ...(recoStruct ? { recommendation: recoStruct.message, recommendedAggregator: recoStruct.aggregator } : {}),
    warnings,
    elapsedMs: Date.now() - t0,
    // Iter803: severity reflects worst-bucket from warnings.
    severity: warnings.length > 0 ? "warn" : "ok",
    recommendedActions,
  };
}

/**
 * Iter623: pure recommendation logic. Returns a one-line suggestion when the
 * data supports it, undefined otherwise. The thresholds are intentionally
 * conservative — we don't want to recommend kyberswap over openocean on a
 * 3-trade sample where the difference could be noise.
 *
 * Two rules, both require N>=10 analyzed trades per aggregator being compared:
 *   1. Lowest median slippage by at least 10 bps margin → recommend it
 *   2. Highest success rate by at least 5 pct margin → recommend it
 *
 * Returns the FIRST matching rule (median wins over success rate when both
 * fire — slippage is the operator's per-trade lossy signal).
 *
 * Exported for unit testing the heuristic.
 */
/**
 * Iter688: symmetric to deriveRecommendation — flag aggregators that lag
 * peers by a meaningful margin. Two rules, both gated on the underperformer
 * having ≥10 trades (small samples produce noise):
 *
 *   1. Success rate ≥15 pct below the BEST peer's rate. We compare against
 *      the best (not the average) because the "best" is the bar an operator
 *      could realistically hit by switching aggregator order.
 *   2. Median slippage ≥50 bps WORSE than the BEST peer. Same rationale.
 *
 * Returns 0+ warning strings (one per aggregator that triggers any rule).
 * Empty array when nothing stands out OR when there are <2 eligible
 * aggregators to compare. The recommendation surfaces the winner; warnings
 * surface the losers — together they let an operator reorder
 * config.aggregator.preferred based on real data.
 *
 * Exported for unit testing the heuristic without trade rows.
 */
export function deriveWarnings(stats: readonly AggregatorStat[]): string[] {
  const eligible = stats.filter((s) => s.tradeCount >= 10);
  if (eligible.length < 2) return [];
  const warnings: string[] = [];

  // Iter704: when iter701 lastSeen is present on the underperformer, append
  // "(last: YYYY-MM-DD)" to the warning so operators distinguish fresh
  // problems from stale data. Same pattern as iter700 for failure patterns.
  const lastBit = (s: AggregatorStat) =>
    s.lastSeen ? ` (last: ${s.lastSeen.slice(0, 10)})` : "";

  // Rule 1: success-rate underperformer.
  const withSuccess = eligible.filter((s) => s.successRate != null);
  if (withSuccess.length >= 2) {
    const bestRate = Math.max(...withSuccess.map((s) => s.successRate ?? 0));
    for (const s of withSuccess) {
      if (s.successRate == null) continue;
      const gapPct = (bestRate - s.successRate) * 100;
      if (gapPct >= 15) {
        warnings.push(
          `${s.aggregator} is underperforming on success rate: ${(s.successRate * 100).toFixed(1)}% across ${s.tradeCount} trades${lastBit(s)} (${gapPct.toFixed(1)} pct below the best peer at ${(bestRate * 100).toFixed(1)}%).`,
        );
      }
    }
  }

  // Rule 2: median-slippage underperformer. analyzedCount (not tradeCount)
  // gates this rule because slippage is only meaningful for analyzed rows.
  const withMedian = eligible.filter(
    (s) => s.medianSlippageBps != null && s.analyzedCount >= 10,
  );
  if (withMedian.length >= 2) {
    const bestMedian = Math.min(...withMedian.map((s) => s.medianSlippageBps ?? Infinity));
    for (const s of withMedian) {
      if (s.medianSlippageBps == null) continue;
      const gap = s.medianSlippageBps - bestMedian;
      if (gap >= 50) {
        warnings.push(
          `${s.aggregator} is underperforming on median slippage: ${s.medianSlippageBps.toFixed(1)} bps across ${s.analyzedCount} analyzed trades${lastBit(s)} (${gap.toFixed(1)} bps worse than the best peer at ${bestMedian.toFixed(1)} bps).`,
        );
      }
    }
  }

  return warnings;
}

export function deriveRecommendation(stats: readonly AggregatorStat[]): string | undefined {
  return deriveRecommendationStructured(stats)?.message;
}

// ── v58: aggregator tuning — close the execution-quality learning loop ──
//
// aggregatorStats DESCRIBES per-aggregator fill quality; deriveRecommendation
// NAMES the single best one; health NUDGES the operator to reorder
// config.aggregator.preferred. The missing piece was turning that realized-
// fill data into the actual routing config — a full ranked `preferred` order
// + a mode recommendation, applyable in one step. This is that piece.

/** Min trades before an aggregator's quality is trusted for ranking;
 *  below this it's appended in the fallback order, not ranked on merit. */
export const TUNE_MIN_TRADES = 10;
/** Median-slippage spread (bps) across eligible aggregators above which
 *  racing every quote ("best" mode) beats betting on a fixed order. */
export const TUNE_MODE_SPREAD_BPS = 15;
/** Success-rate band width (fraction): aggregators within this band are
 *  treated as tied on reliability, so median slippage breaks the tie.
 *  Prevents a 0.5%-success-rate noise difference from dominating routing. */
export const TUNE_SUCCESS_BAND = 0.02;

const KNOWN_PROVIDERS: ProviderName[] = ["kyberswap", "openocean", "0x", "1inch"];

export interface AggregatorRankEntry {
  aggregator: string;
  /** 1-based rank among ELIGIBLE aggregators; null when ineligible. */
  rank: number | null;
  successRate: number | null;
  medianSlippageBps: number | null;
  tradeCount: number;
  analyzedCount: number;
  eligible: boolean;
  note: string;
}

export interface AggregatorTuning {
  /** Aggregators we have evidence for, best-first — what `--apply` writes
   *  to config.aggregator.preferred (routing appends the rest by default). */
  recommendedPreferred: string[];
  /** Full resolved order (recommendedPreferred + default tail), for display. */
  recommendedOrder: string[];
  /** The current resolved order (resolveAggregatorOrder of the config). */
  currentOrder: string[];
  /** recommendedOrder differs from currentOrder. */
  changed: boolean;
  ranking: AggregatorRankEntry[];
  /** "best" when the eligible slippage spread warrants racing and the
   *  operator is on "first"; null = keep the current mode. */
  recommendedMode: "first" | "best" | null;
  modeReason: string | null;
  eligibleCount: number;
  /** True when there isn't enough evidence (< 2 eligible) to recommend a
   *  reorder — the recommendation then equals the current config. */
  insufficient: boolean;
}

/**
 * Pure: rank aggregators by realized fill quality into an optimal
 * `preferred` order. Ranking is reliability-first (a failed fill wastes
 * gas AND misses the trade — strictly worse than a few bps of slippage),
 * then slippage as the tiebreak:
 *   1. success rate, bucketed into TUNE_SUCCESS_BAND bands (so noise
 *      doesn't reorder routing), higher first;
 *   2. within a band, lower median realized slippage first.
 * Only aggregators with ≥ TUNE_MIN_TRADES are ranked on merit; the rest
 * keep the current/default order behind them (no evidence → no opinion).
 */
export function deriveAggregatorTuning(args: {
  stats: readonly AggregatorStat[];
  currentPreferred: readonly string[];
  currentMode: "first" | "best";
}): AggregatorTuning {
  const currentPreferred = args.currentPreferred.filter((p): p is ProviderName =>
    (KNOWN_PROVIDERS as string[]).includes(p),
  ) as ProviderName[];
  const currentOrder = resolveAggregatorOrder(currentPreferred, []);

  const byName = new Map(args.stats.map((s) => [s.aggregator, s]));
  const eligible = args.stats.filter(
    (s) => (KNOWN_PROVIDERS as string[]).includes(s.aggregator) && s.tradeCount >= TUNE_MIN_TRADES && s.successRate != null,
  );

  // Reliability-first, slippage-tiebreak ordering.
  const band = (rate: number) => Math.round(rate / TUNE_SUCCESS_BAND);
  const ranked = [...eligible].sort((a, b) => {
    const bandDiff = band(b.successRate ?? 0) - band(a.successRate ?? 0);
    if (bandDiff !== 0) return bandDiff;
    const aSlip = a.medianSlippageBps ?? Infinity;
    const bSlip = b.medianSlippageBps ?? Infinity;
    return aSlip - bSlip;
  });

  const recommendedPreferred = ranked.map((s) => s.aggregator);
  const recommendedOrder =
    recommendedPreferred.length > 0
      ? resolveAggregatorOrder(recommendedPreferred as ProviderName[], [])
      : currentOrder;
  const changed = recommendedOrder.join(",") !== currentOrder.join(",");
  const insufficient = ranked.length < 2;

  // Ranking detail (eligible ranked first, then the rest noted).
  const rankOf = new Map(ranked.map((s, i) => [s.aggregator, i + 1]));
  const ranking: AggregatorRankEntry[] = KNOWN_PROVIDERS.filter((p) => byName.has(p)).map((p) => {
    const s = byName.get(p)!;
    const eligibleHere = ranked.includes(s);
    return {
      aggregator: p,
      rank: rankOf.get(p) ?? null,
      successRate: s.successRate,
      medianSlippageBps: s.medianSlippageBps,
      tradeCount: s.tradeCount,
      analyzedCount: s.analyzedCount,
      eligible: eligibleHere,
      note: eligibleHere
        ? `${((s.successRate ?? 0) * 100).toFixed(1)}% success · ${s.medianSlippageBps != null ? `${s.medianSlippageBps.toFixed(1)}bps median` : "slippage n/a"}`
        : `only ${s.tradeCount} trade(s) (< ${TUNE_MIN_TRADES}) — not ranked on merit`,
    };
  });

  // Mode: a wide slippage spread means a fixed order leaves money on the
  // table — racing (best) captures the cheapest fill per trade.
  let recommendedMode: AggregatorTuning["recommendedMode"] = null;
  let modeReason: string | null = null;
  const medians = ranked.map((s) => s.medianSlippageBps).filter((v): v is number => v != null);
  if (medians.length >= 2) {
    const spread = Math.max(...medians) - Math.min(...medians);
    if (args.currentMode === "first" && spread >= TUNE_MODE_SPREAD_BPS) {
      recommendedMode = "best";
      modeReason = `eligible aggregators span ${spread.toFixed(1)}bps of median slippage (≥ ${TUNE_MODE_SPREAD_BPS}bps) — mode "best" races every quote and takes the cheapest fill per trade instead of betting on a fixed order.`;
    }
  }

  return {
    recommendedPreferred,
    recommendedOrder,
    currentOrder,
    changed,
    ranking,
    recommendedMode,
    modeReason,
    eligibleCount: ranked.length,
    insufficient,
  };
}

/**
 * Iter733: structured recommendation. Same heuristic as deriveRecommendation
 * but returns the winner's name + dimension alongside the prose. Lets
 * downstream consumers (CLI config-mismatch hint, MCP agents reordering
 * config.aggregator.preferred) act on the result without parsing strings.
 *
 * Exported so the CLI / MCP can reuse for the iter733 mismatch detection
 * without re-running the heuristic.
 */
export function deriveRecommendationStructured(
  stats: readonly AggregatorStat[],
): { aggregator: string; dimension: "slippage" | "success_rate"; message: string } | undefined {
  const eligible = stats.filter((s) => s.analyzedCount >= 10);
  if (eligible.length < 2) return undefined; // need at least 2 to compare

  // Rule 1: median slippage winner with >=10 bps margin.
  const byMedian = [...eligible]
    .filter((s) => s.medianSlippageBps != null)
    .sort((a, b) => (a.medianSlippageBps ?? 0) - (b.medianSlippageBps ?? 0));
  if (byMedian.length >= 2) {
    const best = byMedian[0];
    const second = byMedian[1];
    if (best.medianSlippageBps != null && second.medianSlippageBps != null) {
      const margin = second.medianSlippageBps - best.medianSlippageBps;
      if (margin >= 10) {
        return {
          aggregator: best.aggregator,
          dimension: "slippage",
          message: `${best.aggregator} leads on median realized slippage (${best.medianSlippageBps.toFixed(1)} bps over ${best.analyzedCount} trades, ${margin.toFixed(1)} bps better than ${second.aggregator}).`,
        };
      }
    }
  }

  // Rule 2: highest success rate with >=5 pct margin.
  const bySuccess = [...eligible]
    .filter((s) => s.successRate != null)
    .sort((a, b) => (b.successRate ?? 0) - (a.successRate ?? 0));
  if (bySuccess.length >= 2) {
    const best = bySuccess[0];
    const second = bySuccess[1];
    if (best.successRate != null && second.successRate != null) {
      const margin = (best.successRate - second.successRate) * 100;
      if (margin >= 5) {
        return {
          aggregator: best.aggregator,
          dimension: "success_rate",
          message: `${best.aggregator} has highest success rate (${(best.successRate * 100).toFixed(1)}%, ${margin.toFixed(1)} pct over ${second.aggregator}).`,
        };
      }
    }
  }

  return undefined;
}
