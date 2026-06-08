// Iter634: per-pair slippage scorecard. iter623 buckets realized slippage by
// AGGREGATOR (kyberswap vs openocean) to answer "which aggregator gives me
// better fills?". This module buckets by PAIR (base/quote) to answer the
// orthogonal question "are my ETH→PEPE fills bad because of route quality
// or because PEPE itself is illiquid/volatile?".
//
// Same pure-helper / orchestrator split as iter623:
//   - computePairStats(rows, analyses) is pure → trivially testable
//   - CLI/MCP layer fetches the inputs (trades + iter619 analyses) and calls
//     the pure compute
//
// Why pair-level matters orthogonal to aggregator-level:
//   - A single bad aggregator on a great pair (USDC↔USDT) ≠ a great
//     aggregator on a bad pair (PEPE↔newcoin). Per-aggregator stats average
//     over pairs and hide the latter.
//   - Operators trading mixed strategies (stablecoin pairs + volatile pairs)
//     want to see "stablecoin pairs are tight; volatile pairs are 80 bps
//     median" — that's the strategy-tuning signal.
//
// PAIR canonicalization: we use BASE/QUOTE in lexicographic order so a
// "buy ETH with USDC" and "sell ETH for USDC" both bucket as "ETH/USDC".
// Direction-specific stats can be added later if operators ask; for now,
// the round-trip view is the most useful first cut.

import type { TradeRow } from "./db.js";
import { failureReasonHistogram } from "./db.js";
import type { AnalyzedTrade } from "./tradeAnalysis.js";
import { percentile } from "./aggregatorStats.js";

export interface PairStat {
  /** Canonical "BASE/QUOTE" key, uppercased + sorted lexicographically. */
  pair: string;
  /** Distinct base symbols contributing to this pair (uppercased). Same with
   *  quote — when canonicalization collapses both directions into one pair,
   *  these track which symbols actually appeared. */
  baseSymbols: string[];
  quoteSymbols: string[];
  /** Total trades attempted for this pair in the scoped window. */
  tradeCount: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
  /** successCount / tradeCount (0..1). Null when tradeCount = 0 (unreachable
   *  in practice — we filter out empty pairs before returning). */
  successRate: number | null;
  /** Median realized slippage in basis points across analyzed trades for
   *  this pair. Null when no trade has an analysis. */
  medianSlippageBps: number | null;
  /** 95th-percentile slippage. Null when count < 5 (small samples not
   *  meaningful). */
  p95SlippageBps: number | null;
  /** Mean of analyzed slippage. */
  avgSlippageBps: number | null;
  /** Sum of USD volume for SUCCESS trades on this pair (stablecoin quotes
   *  only; non-stable quote rows skipped — see volumeNotePartial). */
  totalUsdVolume: number;
  /** True when ANY success trade on this pair had a non-stable quote that
   *  couldn't be USD-priced — totalUsdVolume is then a lower bound. */
  volumeNotePartial: boolean;
  /** Number of analyzed trades — the basis for slippage stats. */
  analyzedCount: number;
  /** iter619 verdict distribution: excellent/ok/minor_slip/major_slip/extreme_slip/etc. */
  byVerdict: Record<string, number>;
  /** Iter702: ISO timestamp of the most-recent trade on this pair.
   *  Operators answering "am I still trading this pair?" get the answer
   *  inline. Absent only when bucketRows is empty (unreachable in
   *  practice). */
  lastSeen?: string;
  /** Iter673: revert reason histogram for this pair's failed trades.
   *  Same shape as iter672's per-aggregator histogram — NULL bucketed as
   *  "(unknown)", sorted by count desc. Distinguishes "ETH/PEPE fails
   *  with slippage" (price gaps on illiquid pair) from "ETH/PEPE fails
   *  with allowance" (operator hasn't approved this token). Different
   *  remediation. Empty array when pair had no failures.
   *  Iter699: each entry may carry `lastSeen` from row timestamps. */
  failureReasons: Array<{ reason: string; count: number; lastSeen?: string }>;
}

export interface PairStatsReport {
  timestamp: string;
  since?: string;
  totalTrades: number;
  /** One entry per pair. Sorted by tradeCount desc (most-active first). */
  byPair: PairStat[];
  /**
   * Iter690: symmetric to iter688's aggregator warnings. Flags pairs that
   * lag peers on slippage OR have heavy single-reason failure concentration.
   * Both rules gate on the underperformer side having ≥10 trades. Empty
   * when no pair stands out; absent only when there were too few eligible
   * pairs to compare. Operators read these as "raise slippage for this
   * pair" or "this pair is structurally hard".
   */
  warnings: string[];
  /** Iter758: wall-clock ms for the computePairStats call. Symmetric with
   *  iter744 aggregator stats elapsedMs. computePairStats is CPU-only but
   *  the upstream CLI orchestrator runs analyzeStoredTrade (RPC-heavy) per
   *  success row before calling here — operators tracking cron compute
   *  cost over time get the pure-compute slice via this field, full
   *  end-to-end via process-level timing (or by wrapping the orchestrator). */
  elapsedMs?: number;
  /** Iter803: worst-bucket severity. "warn" when any pair underperformer
   *  warning fired; "ok" otherwise. Symmetric with iter786/787/788/801. */
  severity: "ok" | "warn";
  /** Iter836: structured dispatch. Emitted when warnings fire — suggests
   *  analyze_trade scoped to the worst pair for systemic investigation.
   *  Always present (empty when no warnings). Symmetric with iter835. */
  recommendedActions: import("./errors.js").NextAction[];
}

/** Same stablecoin recognizer aggregatorStats.ts uses. */
function isStablecoin(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return /^(USDC|USDT|DAI|BUSD|FRAX|USDP|TUSD|USDC\.e)$/i.test(symbol);
}

/**
 * Iter634: canonicalize a trade row to a pair key. We use the SYMBOL pair
 * sorted lexicographically + uppercased so both directions (buy ETH/USDC and
 * sell ETH/USDC) bucket together. When a symbol is missing (legacy/imported
 * rows), falls back to "(unknown)".
 *
 * Exported pure for unit testing without standing up trade rows.
 */
export function canonicalPairKey(baseSymbol: string | null | undefined, quoteSymbol: string | null | undefined): string {
  // Keep the (unknown) sentinel lowercase so it's visually distinct from
  // legitimate uppercased symbols at a glance.
  const norm = (s: string | null | undefined): string => (s == null ? "(unknown)" : s.toUpperCase());
  const b = norm(baseSymbol);
  const q = norm(quoteSymbol);
  return b < q ? `${b}/${q}` : `${q}/${b}`;
}

/**
 * Iter634: pure compute. Takes (rows × analyses) → per-pair stats.
 *
 * `analyses` keyed by tx_hash. Same shape as aggregatorStats.ts — rows
 * without matching analyses still count toward counts/USD volume but don't
 * contribute to slippage stats.
 *
 * Pure: no I/O. Returns a NEW report.
 */
export function computePairStats(
  rows: readonly TradeRow[],
  analyses: readonly AnalyzedTrade[],
  options?: { since?: string },
): PairStatsReport {
  // Iter758: pure-compute wall-clock. Typically <10ms on a few-thousand-row
  // history; sized small enough that the field is a sentinel ("did the
  // report actually run") + a sanity bound for very large histories.
  const t0 = Date.now();
  const analysisByHash = new Map<string, AnalyzedTrade>();
  for (const a of analyses) {
    analysisByHash.set(a.txHash.toLowerCase(), a);
  }

  type WorkingPair = {
    pair: string;
    baseSymbols: Set<string>;
    quoteSymbols: Set<string>;
    tradeCount: number;
    successCount: number;
    failedCount: number;
    pendingCount: number;
    totalUsdVolume: number;
    volumeNotePartial: boolean;
    slips: number[];
    byVerdict: Record<string, number>;
    // Iter673: per-pair failure rows kept so the iter675 shared histogram
    // helper can bucket them at the end (instead of inlining the same logic
    // four places).
    failedRows: TradeRow[];
    // Iter702: MAX(timestamp) for the pair — updated in the row loop.
    lastSeen?: string;
  };

  const buckets = new Map<string, WorkingPair>();
  for (const row of rows) {
    const pair = canonicalPairKey(row.base_symbol, row.quote_symbol);
    let bucket = buckets.get(pair);
    if (!bucket) {
      bucket = {
        pair,
        baseSymbols: new Set(),
        quoteSymbols: new Set(),
        tradeCount: 0,
        successCount: 0,
        failedCount: 0,
        pendingCount: 0,
        totalUsdVolume: 0,
        volumeNotePartial: false,
        slips: [],
        byVerdict: {},
        failedRows: [],
      };
      buckets.set(pair, bucket);
    }
    bucket.tradeCount++;
    if (row.base_symbol) bucket.baseSymbols.add(row.base_symbol.toUpperCase());
    if (row.quote_symbol) bucket.quoteSymbols.add(row.quote_symbol.toUpperCase());
    // Iter702: track MAX(timestamp) per pair for the lastSeen surface.
    if (!bucket.lastSeen || row.timestamp > bucket.lastSeen) bucket.lastSeen = row.timestamp;

    if (row.status === "success") bucket.successCount++;
    else if (row.status === "failed") {
      bucket.failedCount++;
      bucket.failedRows.push(row);
    }
    else if (row.status === "pending") bucket.pendingCount++;

    // USD volume: success only, stablecoin quotes only (matches iter623's
    // estimateRowUsdVolume model).
    if (row.status === "success") {
      if (isStablecoin(row.quote_symbol)) {
        const q = parseFloat(row.quote_amount);
        if (Number.isFinite(q)) bucket.totalUsdVolume += q;
      } else {
        bucket.volumeNotePartial = true;
      }
    }

    // Iter641: prefer stored realized_slippage_bps; fall back to live analysis
    // for legacy rows.
    const analysis = analysisByHash.get(row.tx_hash.toLowerCase());
    if (row.realized_slippage_bps != null && Number.isFinite(row.realized_slippage_bps)) {
      bucket.slips.push(row.realized_slippage_bps);
      if (analysis) bucket.byVerdict[analysis.finding.code] = (bucket.byVerdict[analysis.finding.code] ?? 0) + 1;
    } else if (analysis) {
      bucket.byVerdict[analysis.finding.code] = (bucket.byVerdict[analysis.finding.code] ?? 0) + 1;
      if (analysis.comparison) bucket.slips.push(analysis.comparison.slippageBps);
    }
  }

  const byPair: PairStat[] = [];
  for (const b of buckets.values()) {
    const sortedSlips = [...b.slips].sort((x, y) => x - y);
    const median = percentile(sortedSlips, 50);
    const p95 = sortedSlips.length >= 5 ? percentile(sortedSlips, 95) : null;
    const avg = sortedSlips.length > 0
      ? sortedSlips.reduce((s, n) => s + n, 0) / sortedSlips.length
      : null;
    const successRate = b.tradeCount > 0 ? b.successCount / b.tradeCount : null;
    // Iter673/iter675: failure histogram via the shared helper.
    const failureReasons = failureReasonHistogram(b.failedRows);
    byPair.push({
      pair: b.pair,
      baseSymbols: [...b.baseSymbols].sort(),
      quoteSymbols: [...b.quoteSymbols].sort(),
      tradeCount: b.tradeCount,
      successCount: b.successCount,
      failedCount: b.failedCount,
      pendingCount: b.pendingCount,
      successRate,
      medianSlippageBps: median,
      p95SlippageBps: p95,
      avgSlippageBps: avg,
      totalUsdVolume: b.totalUsdVolume,
      volumeNotePartial: b.volumeNotePartial,
      analyzedCount: sortedSlips.length,
      byVerdict: b.byVerdict,
      failureReasons,
      ...(b.lastSeen ? { lastSeen: b.lastSeen } : {}),
    });
  }
  byPair.sort((a, b) => b.tradeCount - a.tradeCount);

  const warnings = derivePairWarnings(byPair);
  // Iter836: structured dispatch when warnings fire. Picks the pair with
  // the worst median slippage (highest bps) for the investigation target —
  // that's the most-likely systemic-issue candidate. byPair is non-empty
  // when warnings exist (warnings are derived from byPair).
  const recommendedActions: import("./errors.js").NextAction[] = [];
  if (warnings.length > 0) {
    const worstByPair = [...byPair]
      .filter((p) => p.medianSlippageBps != null && p.tradeCount >= 10)
      .sort((a, b) => (b.medianSlippageBps ?? 0) - (a.medianSlippageBps ?? 0))[0];
    if (worstByPair) {
      recommendedActions.push({
        tool: "analyze_trade",
        params: { recent: 20 },
        reason: `${warnings.length} pair underperformer warning${warnings.length === 1 ? "" : "s"} — worst pair '${worstByPair.pair}' has median slippage ${worstByPair.medianSlippageBps?.toFixed(1)} bps. Analyze recent trades to find the systemic cause.`,
      });
    }
  }
  return {
    timestamp: new Date().toISOString(),
    since: options?.since,
    totalTrades: rows.length,
    byPair,
    warnings,
    elapsedMs: Date.now() - t0,
    // Iter803: severity from warnings.
    severity: warnings.length > 0 ? "warn" : "ok",
    recommendedActions,
  };
}

/**
 * Iter690: symmetric to iter688's deriveWarnings for aggregator stats.
 * Two rules, each gated on the underperformer pair having ≥10 trades:
 *
 *   1. Median slippage ≥50 bps WORSE than the BEST pair median across
 *      the eligible set. Same threshold as iter688 — meaningful gap
 *      operators can act on (raise per-pair slippage, deprioritize pair).
 *   2. Failure concentration ≥80% on one non-unknown reason with ≥3
 *      failures. Signals "this pair fails the same way every time" —
 *      operators can apply a targeted fix (allowance, slippage cap) or
 *      stop trading the pair.
 *
 * The rules can compound (a pair triggering both gets two warning lines).
 * (unknown) reasons are excluded from the concentration rule — same
 * convention as iter671 (NULL revert_reason is a backfill signal, not
 * operational).
 *
 * Exported for unit testing.
 */
export function derivePairWarnings(pairs: readonly PairStat[]): string[] {
  const eligible = pairs.filter((p) => p.tradeCount >= 10);
  if (eligible.length < 2) return [];
  const warnings: string[] = [];

  // Iter704: iter702 lastSeen suffix for the slippage rule. For the
  // concentration rule we prefer the iter699 reason-level lastSeen (more
  // precise than the pair's global lastSeen — operators want to know when
  // the dominant reason last hit, not when the pair last traded).
  const pairLastBit = (p: PairStat) =>
    p.lastSeen ? ` (last: ${p.lastSeen.slice(0, 10)})` : "";

  // Rule 1: median slippage outlier.
  const withMedian = eligible.filter(
    (p) => p.medianSlippageBps != null && p.analyzedCount >= 10,
  );
  if (withMedian.length >= 2) {
    const bestMedian = Math.min(...withMedian.map((p) => p.medianSlippageBps ?? Infinity));
    for (const p of withMedian) {
      if (p.medianSlippageBps == null) continue;
      const gap = p.medianSlippageBps - bestMedian;
      if (gap >= 50) {
        warnings.push(
          `${p.pair} has high median slippage: ${p.medianSlippageBps.toFixed(1)} bps across ${p.analyzedCount} analyzed trades${pairLastBit(p)} (${gap.toFixed(1)} bps worse than the best pair at ${bestMedian.toFixed(1)} bps). Consider --auto-slippage or a wider --slippage for this pair.`,
        );
      }
    }
  }

  // Rule 2: failure-reason concentration (single reason dominates).
  for (const p of eligible) {
    if (p.failedCount < 3) continue;
    const reasonsNoUnknown = p.failureReasons.filter((r) => r.reason !== "(unknown)");
    if (reasonsNoUnknown.length === 0) continue;
    const top = reasonsNoUnknown[0];
    // Concentration calculated over ALL failures (including unknown) so a
    // pair with 8 known + 2 unknown failures shows 80% concentration, not
    // 100%. The unknown rows are real failures whose attribution we lack.
    const concentration = top.count / p.failedCount;
    if (top.count >= 3 && concentration >= 0.8) {
      // Iter704: prefer the reason's own lastSeen (iter699) — tells the
      // operator when the dominant reason last hit specifically, not when
      // the pair last traded at all.
      const reasonLastBit = top.lastSeen
        ? ` (last: ${top.lastSeen.slice(0, 10)})`
        : "";
      warnings.push(
        `${p.pair} fails predominantly with "${top.reason}": ${top.count} of ${p.failedCount} failures (${(concentration * 100).toFixed(0)}%)${reasonLastBit}. Investigate root cause or deprioritize this pair.`,
      );
    }
  }

  return warnings;
}
