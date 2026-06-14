// Iter621: `tradekit health` — operator dashboard. Composition layer over
// iter605 portfolio + iter615 PnL + iter606 allowance audit + iter617 freshness
// + iter619 trade analysis + recent_trades. Replaces the 5-command scatter
// (`portfolio` + `pnl` + `allowances audit` + `recent_trades` + `audit`) with
// one cohesive read-only morning briefing.
//
// Design priorities:
//   1. Per-section failure isolation — a single bad RPC must not break the
//      whole report. Each section's data carries an `error?: string` field;
//      callers (CLI text mode) render error-state in place of the data.
//   2. Parallel execution — sections run via Promise.allSettled so end-to-end
//      latency = slowest section, not sum of sections.
//   3. Pure-helper split — number-crunching (deltas, formatters) lives in
//      separate exported functions so unit tests can pin behavior without
//      mocking the full RPC stack.
//   4. No new core capabilities — every datum already exists elsewhere; this
//      module is composition, not invention.
//
// What it deliberately does NOT include (out of scope, separate features):
//   - Setting price alerts
//   - Auto-executing recommended actions
//   - Persisting dashboards over time
//   - Comparing vs other accounts

import type { Address } from "viem";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { PortfolioReport, AccountResolution } from "./portfolio.js";
import type { PnLReport } from "./pnl.js";
import type { AllowanceAuditReport } from "./approvalAudit.js";
import type { AnalyzedTrade } from "./tradeAnalysis.js";
import type { TradeRow } from "./db.js";
import { failureReasonHistogram } from "./db.js";
import { computeAggregatorStats } from "./aggregatorStats.js";
import { reviewSafety } from "./safetyReview.js";
import type { SafetyHeadroomReport } from "./safetyHeadroom.js";
import { computePairStats } from "./pairStats.js";

export interface HealthSectionError {
  /** Stable code an agent can branch on. */
  code: "portfolio_failed" | "pnl_failed" | "approvals_failed" | "trades_failed" | "snapshots_failed" | "safety_failed";
  /** Human-readable error message. */
  message: string;
}

export interface PortfolioSection {
  totalUsd: number;
  /** Number of priced positions. */
  positionCount: number;
  /** Number of unpriced positions (excluded from totalUsd). */
  unpricedCount: number;
  /** Top N holdings by USD. */
  top: Array<{ symbol: string; totalUsd: number; percentOfPortfolio: number }>;
  /** Top-1 / top-3 / top-5 cumulative %. */
  concentration: { top1: number; top3: number; top5: number };
  /** Iter618: when a recent snapshot exists, the 24h / 7d delta vs the closest
   *  past snapshot. Null when no comparable snapshot exists yet. */
  delta24h?: { totalUsdDelta: number; pct: number | null; snapshotId: number };
  delta7d?: { totalUsdDelta: number; pct: number | null; snapshotId: number };
  /** ISO timestamp of the most recent snapshot (any scope), for "stale-snapshot" warnings. */
  lastSnapshotAt?: string;
}

export interface PnLSection {
  /** Realized PnL over the last 7 days (USD). */
  realized7dUsd: number;
  /** Unrealized PnL (current state — windowing not meaningful). */
  unrealizedUsd: number;
  /** Total gas spent in the last 7d (USD). */
  gas7dUsd: number;
  /** Net = realized - gas (USD). */
  netAfterGas7dUsd: number;
  /** Top winner + loser by realized PnL in the 7d window (per-symbol).
   *  Pre-iter640 these were the only PnL detail. Useful for "which token
   *  made/lost me money" but doesn't distinguish strategies (ETH/USDC and
   *  ETH/PEPE both contribute to ETH's symbol-level number). */
  topWinner?: { symbol: string; chain: string; realizedUsd: number };
  topLoser?: { symbol: string; chain: string; realizedUsd: number };
  /** Iter640: top 3 winning pairs + worst 2 losing pairs from iter639 byPair.
   *  Pair-level detail surfaces strategy attribution — same operator with
   *  ETH/USDC up + ETH/PEPE down sees BOTH stories instead of a single net.
   *  Sorted by realizedUsd; missing/empty arrays when no pair data. */
  topWinnerPairs?: Array<{ pair: string; realizedUsd: number; tradeCount: number }>;
  topLoserPairs?: Array<{ pair: string; realizedUsd: number; tradeCount: number }>;
  /** Iter650: top winning + losing strategy from iter649 byStrategy. Symmetric
   *  with topWinnerPairs/topLoserPairs but bucketed by user-supplied tag.
   *  "(none)" bucket is filtered — only tagged strategies appear here. Top 2
   *  winners + worst 1 loser; missing when no tagged data. */
  topWinnerStrategies?: Array<{ strategy: string; realizedUsd: number; tradeCount: number }>;
  topLoserStrategies?: Array<{ strategy: string; realizedUsd: number; tradeCount: number }>;
}

export interface TradesSection {
  /** Total trades attempted in the last 7d. */
  total: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
  /** Iter619: median + avg realized slippage across the last 7d's success trades. */
  medianSlippageBps?: number;
  avgSlippageBps?: number;
  /** Verdict bucket distribution (iter619). */
  byVerdict: Record<string, number>;
  /** Iter671: failure reason histogram for the last 7d's failed trades.
   *  Sourced from the iter669-persisted revert_reason column. Rows with
   *  NULL revert_reason are bucketed under "(unknown)". Sorted by count
   *  desc so the dominant failure mode is first. Empty array when no
   *  failures occurred or none have reasons.
   *  Iter699: each entry now carries optional `lastSeen` from the row
   *  timestamps — operators see "when was that?" inline. */
  failureReasons: Array<{ reason: string; count: number; lastSeen?: string }>;
  /** Iter689: aggregator underperformer warnings from running iter688
   *  deriveWarnings against the last 7d's rows. Each string flags a
   *  specific aggregator on a specific dimension (success-rate gap or
   *  slippage gap). Empty when no aggregator stands out as bad. */
  aggregatorWarnings: string[];
  /** Iter691: pair underperformer warnings from iter690 derivePairWarnings.
   *  Each string flags a specific pair (high median slippage gap OR
   *  failure-reason concentration). Empty when no pair stands out. */
  pairWarnings: string[];
}

export interface SecuritySection {
  /** Total standing approvals (across the wallet's chains, summed). */
  totalApprovals: number;
  criticalCount: number;
  warnCount: number;
  /** Iter617: count of approvals older than the freshness threshold. Undefined
   *  when freshness wasn't scanned (operator didn't pass --lookback-blocks). */
  staleCount?: number;
  /** Critical + warn allowances (one line each), capped at N for display. */
  topConcerns: Array<{
    symbol: string;
    spenderLabel: string | null;
    spender: Address;
    severity: "critical" | "warn" | "ok";
    chain: string;
  }>;
}

/** v55: the safety dimension of the dashboard — composes the v51 config
 *  posture (what protects me) with the v53 runtime binding constraint
 *  (how much room is left), so `health` answers "is my agent bounded AND
 *  not about to hit a wall?" without the operator running two more tools. */
export interface HealthSafetySection {
  /** v51 config posture: hardened | moderate | exposed. */
  postureVerdict: "hardened" | "moderate" | "exposed";
  criticalGaps: number;
  warnGaps: number;
  /** Worst-severity gap finding, for the one-line summary. */
  topGap?: string;
  /** v53 binding (tightest active) runtime limit. Absent when no
   *  quantitative limit is configured. */
  binding?: {
    label: string;
    scope: string;
    utilizationPct: number | null;
    status: "ok" | "approaching" | "exhausted" | "tripped";
    detail: string;
  };
}

export interface NextAction {
  code:
    | "reconcile_pending"
    | "revoke_critical"
    | "stale_snapshot"
    | "audit_approvals"
    | "take_snapshot"
    // Iter655: backfill recommendations — fire when post-upgrade legacy row
    // counts exceed thresholds. Each code maps to a specific reconcile mode.
    | "backfill_blocks"
    | "backfill_slippage"
    | "backfill_gas_usd"
    // Iter670: revert-reason backfill for legacy failed trades.
    | "backfill_revert_reasons"
    // Iter671: dominant revert reason among recent failures — signals a
    // systemic issue (slippage cap, liquidity, allowance) the operator can
    // address vs investigate-each-failure-individually.
    | "frequent_failure_reason"
    // Iter689: a specific aggregator lags peers by ≥15 pct success rate
    // OR ≥50 bps median slippage. Actionable via config.aggregator.preferred
    // reordering.
    | "aggregator_underperformer"
    // Iter691: a specific pair has bad fills (high median slippage OR
    // failure-reason concentration). Operator-side action: --auto-slippage
    // for that pair, or stop trading the pair.
    | "pair_underperformer"
    // Iter743: sync bookmark hasn't advanced past the freshness threshold
    // (48h default — same as PnLReport.dataFreshness). Cron likely broken;
    // PnL silently incomplete.
    | "stale_sync"
    // v55: the wallet's safety CONFIG posture has a CRITICAL gap (safety
    // disabled, or no per-tx AND no daily USD ceiling) — agent trading is
    // effectively unbounded. Surfaced from the v51 safety_review.
    | "safety_exposed"
    // v55: an active runtime guardrail is near (or past) its limit — daily
    // USD nearly spent, a strategy budget/position cap approaching, or the
    // drawdown breaker tripped. Surfaced from the v53 safety_headroom.
    | "limit_near_exhaustion";
  /** Imperative description an operator can act on. */
  message: string;
  /** Suggested CLI invocation. */
  command: string;
  /** Iter693: severity tier. Pre-iter693 the priority order was implicit
   *  (rule emit order in deriveNextActions). With 12 codes that can fire
   *  simultaneously, operators need critical signals surfaced first.
   *
   *  - critical: pending trades (funds in limbo), critical approvals (drain risk)
   *  - high: revert-pattern detection (systemic issue), aggregator/pair
   *    underperformer (active losses), frequent_failure_reason
   *  - medium: snapshot freshness, take_snapshot, warn-level approvals
   *  - low: backfill_* (housekeeping, no urgency)
   *
   *  CLI sorts by severity before render. JSON consumers can resort. */
  severity: "critical" | "high" | "medium" | "low";
}

export interface HealthReport {
  timestamp: string;
  /** Iter729: wall-clock ms for the full health orchestration (portfolio +
   *  pnl + analyses + approvals fan-out + compose). Both CLI and MCP
   *  orchestrators measure externally and pass via composeHealthReport's
   *  elapsedMs arg — the compose itself is pure but the orchestration is
   *  RPC-heavy and worth surfacing. */
  elapsedMs?: number;
  /** Optional global accounts scope. Empty array when scope = active wallet only. */
  scope: { accounts: AccountResolution[]; chains: string[] };
  portfolio?: PortfolioSection;
  pnl?: PnLSection;
  trades?: TradesSection;
  security?: SecuritySection;
  /** v55: config posture (v51) + binding runtime limit (v53). */
  safety?: HealthSafetySection;
  errors: HealthSectionError[];
  /** Composed list of next-action suggestions derived from the section data
   *  (e.g. "you have 2 pending trades — run reconcile"). Empty array when
   *  everything's healthy. Ordered: highest-urgency first. */
  nextActions: NextAction[];
  /** Iter764: pre-computed severity counts over nextActions. Saves dashboard
   *  / monitoring consumers from iterating the array to compute bucket
   *  counts. Always present (zeros when nextActions is empty); the four
   *  buckets are exhaustive over the NextAction.severity union. Useful for
   *  dashboard widgets that render "3 critical · 2 high · 0 medium · 0 low"
   *  without parsing the action list itself. */
  nextActionsSummary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  /** Iter786: top-level worst-bucket signal derived from nextActionsSummary.
   *  Lets dashboards render a single status indicator ("currently: critical")
   *  without computing the max bucket. Always present.
   *  Values: "ok" (no nextActions), "critical" / "high" / "medium" / "low"
   *  (matches the highest non-zero bucket — same priority order
   *  deriveNextActions's SEVERITY_RANK uses to sort). */
  severity: "ok" | "critical" | "high" | "medium" | "low";
  /** Iter827: pre-filtered slice of nextActions where severity==="critical".
   *  Dashboards rendering "what to do NOW" / pager triggers branch on this
   *  field directly. Matches iter734 --quiet filter logic (same severity
   *  threshold). Symmetric with iter825 doctor / iter826 verify failedChecks
   *  — every monitoring report now exposes its "actionable subset" as a
   *  pre-filtered list. Always present (empty when no critical actions). */
  criticalActions: NextAction[];
}

/**
 * Iter621: pure helper. Given a section's raw inputs, derive the next-action
 * list. Each action is generated by an independent rule so a section's data
 * absence (per-section error) cleanly skips its rules instead of crashing.
 *
 * Exported for unit testing.
 */
export function deriveNextActions(args: {
  portfolio?: PortfolioSection;
  trades?: TradesSection;
  security?: SecuritySection;
  /** Days since the last portfolio snapshot. Undefined when no snapshot exists. */
  daysSinceLastSnapshot?: number;
  /** Iter655: counts of rows needing backfill. Each rule fires when the
   *  count exceeds a threshold — a handful of legacy rows isn't worth
   *  bothering an operator about, but hundreds is real upgrade signal. */
  legacyBackfillCounts?: {
    missingBlockNumber: number;
    missingSlippage: number;
    missingGasUsd: number;
    /** Iter670: failed-trade rows with NULL revert_reason but a captured block. */
    missingRevertReason: number;
  };
  /** Iter743: stale sync bookmarks from the PnLReport.dataFreshness signal.
   *  When non-empty, fires the stale_sync rule (high severity) so cron-watch
   *  operators see the cron-broken signal in their nextActions stream. */
  staleBookmarks?: Array<{ chain: string; account: string; ageHours: number }>;
  /** v55: the safety dimension — drives safety_exposed (config posture
   *  has a critical gap) + limit_near_exhaustion (a runtime guardrail is
   *  near/past its limit). */
  safety?: HealthSafetySection;
}): NextAction[] {
  const actions: NextAction[] = [];

  // Rule 1 (critical urgency): pending trades need reconcile.
  if (args.trades && args.trades.pendingCount > 0) {
    actions.push({
      code: "reconcile_pending",
      message: `${args.trades.pendingCount} pending trade${args.trades.pendingCount === 1 ? "" : "s"} need on-chain verification.`,
      command: "tradekit reconcile",
      severity: "critical",
    });
  }

  // Iter743 rule (high urgency): stale sync bookmark. Daily-cron operators
  // running `tradekit health --watch` need the broken-cron signal in the
  // same stream as reconcile_pending — otherwise the PnL section silently
  // lies for days. Fired once per stale (chain, account) tuple; identifies
  // the most stale entry in the message so the operator's first action
  // (which cron / which account) is clear from one line. Severity high
  // (between critical reconcile and medium snapshot) — incomplete data is
  // important but not unsafe.
  if (args.staleBookmarks && args.staleBookmarks.length > 0) {
    // Pick the OLDEST one for the inline reference — that's the most-
    // important-to-investigate. Other stale entries still travel through
    // PnLReport.dataFreshness for JSON consumers.
    const sorted = [...args.staleBookmarks].sort((a, b) => b.ageHours - a.ageHours);
    const oldest = sorted[0];
    const ageStr =
      oldest.ageHours >= 24
        ? `${(oldest.ageHours / 24).toFixed(1)}d`
        : `${oldest.ageHours.toFixed(1)}h`;
    const more =
      sorted.length > 1
        ? ` (+${sorted.length - 1} more)`
        : "";
    actions.push({
      code: "stale_sync",
      message: `Sync bookmark for ${oldest.chain}/${oldest.account} hasn't advanced in ${ageStr}${more} — PnL may be incomplete.`,
      command: `tradekit trades sync --chain ${oldest.chain} --account ${oldest.account}`,
      severity: "high",
    });
  }

  // Rule 2 (high urgency): critical approvals are the wallet-drain vector.
  if (args.security && args.security.criticalCount > 0) {
    actions.push({
      code: "revoke_critical",
      message: `${args.security.criticalCount} critical approval${args.security.criticalCount === 1 ? "" : "s"} — likely wallet-drain vectors. Revoke before they're abused.`,
      command: "tradekit allowances audit",
      severity: "critical",
    });
  }

  // Rule 3 (medium urgency): stale snapshot — operator's portfolio diff loses
  // resolution. Only surfaces when there's at least ONE snapshot.
  if (args.daysSinceLastSnapshot != null && args.daysSinceLastSnapshot > 30) {
    actions.push({
      code: "stale_snapshot",
      message: `Last portfolio snapshot is ${args.daysSinceLastSnapshot} days old — diff resolution is degrading.`,
      command: "tradekit portfolio snapshot",
      severity: "medium",
    });
  }

  // Rule 4 (medium urgency): no snapshot at all → start the series.
  if (args.daysSinceLastSnapshot == null && args.portfolio && args.portfolio.totalUsd > 0) {
    actions.push({
      code: "take_snapshot",
      message: "No portfolio snapshots saved yet. Capture one now so future runs can show portfolio drift.",
      command: "tradekit portfolio snapshot",
      severity: "medium",
    });
  }

  // Rule 5 (medium urgency): >5 warn-level approvals → schedule an audit pass.
  if (args.security && args.security.warnCount >= 5) {
    actions.push({
      code: "audit_approvals",
      message: `${args.security.warnCount} approvals at warn level. Review and revoke any you don't actively use.`,
      command: "tradekit allowances audit",
      severity: "medium",
    });
  }

  // Iter655: backfill recommendations. Each rule fires when the count of
  // legacy rows exceeds a threshold. Threshold is 50: a handful of rows
  // isn't worth a backfill ceremony, but enough to fill a `--limit 500`
  // run is. Operators with HUNDREDS of legacy rows see these EVERY health
  // run until they backfill — discoverability over silence.
  const backfill = args.legacyBackfillCounts;
  if (backfill) {
    if (backfill.missingBlockNumber >= 50) {
      actions.push({
        code: "backfill_blocks",
        message: `${backfill.missingBlockNumber} legacy success trade${backfill.missingBlockNumber === 1 ? "" : "s"} missing block_number — iter635 reorg-depth filtering won't cover them until backfilled.`,
        command: "tradekit reconcile --backfill-blocks 500",
        severity: "low",
      });
    }
    if (backfill.missingSlippage >= 50) {
      actions.push({
        code: "backfill_slippage",
        message: `${backfill.missingSlippage} legacy success swap${backfill.missingSlippage === 1 ? "" : "s"} missing realized_slippage_bps — iter642 auto-slippage suggestions use less data than they could.`,
        command: "tradekit reconcile --backfill-slippage 200",
        severity: "low",
      });
    }
    if (backfill.missingGasUsd >= 50) {
      actions.push({
        code: "backfill_gas_usd",
        message: `${backfill.missingGasUsd} legacy success trade${backfill.missingGasUsd === 1 ? "" : "s"} missing gas_cost_usd_at_trade — tax-quarter PnL valuing gas at current native price (not historically accurate).`,
        command: "tradekit reconcile --backfill-gas-usd 200",
        severity: "low",
      });
    }
    // Iter670: revert-reason backfill. Threshold is lower (10 vs 50) because
    // failed trades are inherently rarer than success — 10 unexplained
    // failures is enough signal that pattern detection (future iter671) would
    // benefit from the backfill.
    if (backfill.missingRevertReason >= 10) {
      actions.push({
        code: "backfill_revert_reasons",
        message: `${backfill.missingRevertReason} legacy failed trade${backfill.missingRevertReason === 1 ? "" : "s"} missing revert_reason — investigation/pattern-detection won't surface why they failed.`,
        command: "tradekit reconcile --backfill-revert-reasons 200",
        severity: "low",
      });
    }
  }

  // Iter671: frequent revert reason in last 7d. Threshold is 3: random one-
  // off failures don't warrant attention, but when the SAME reason hits 3+
  // times, there's a systemic issue worth surfacing (slippage too tight,
  // liquidity gap, expired allowance). Don't fire on "(unknown)" — that's a
  // backfill signal, not an operational one. iter670 already covers it.
  if (args.trades?.failureReasons) {
    const dominant = args.trades.failureReasons.find(
      (r) => r.reason !== "(unknown)" && r.count >= 3,
    );
    if (dominant) {
      // Iter700: include the dominant reason's lastSeen so operators distinguish
      // ongoing patterns (last failure 20 min ago — still hot) from stale ones
      // (last failure 5 days ago — issue may be resolved).
      const lastBit = dominant.lastSeen
        ? ` (last: ${dominant.lastSeen.slice(0, 16).replace("T", " ")})`
        : "";
      actions.push({
        code: "frequent_failure_reason",
        message: `${dominant.count} failures with "${dominant.reason}" in last 7d${lastBit} — same root cause, worth investigating instead of one-by-one.`,
        command: `tradekit trades --status=failed --since=7d`,
        severity: "high",
      });
    }
  }

  // Iter689/iter692: aggregator underperformer signal. Pre-iter692 we
  // emitted one nextAction per warning string, which exploded the output
  // when several aggregators triggered. Iter692 collapses to ONE summary
  // signal per code — the structured underperformer details still live on
  // TradesSection.aggregatorWarnings for JSON consumers / agents.
  if (args.trades?.aggregatorWarnings && args.trades.aggregatorWarnings.length > 0) {
    const warnings = args.trades.aggregatorWarnings;
    const message =
      warnings.length === 1
        ? warnings[0]
        : `${warnings.length} aggregator warnings (worst: ${warnings[0]}). Full list on trades.aggregatorWarnings.`;
    actions.push({
      code: "aggregator_underperformer",
      message,
      command: `tradekit aggregator stats   # then: tradekit config push aggregator.preferred <best-aggregator>`,
      severity: "high",
    });
  }

  // Iter691/iter692: pair underperformer signal — same consolidation
  // pattern as aggregator above.
  if (args.trades?.pairWarnings && args.trades.pairWarnings.length > 0) {
    const warnings = args.trades.pairWarnings;
    const message =
      warnings.length === 1
        ? warnings[0]
        : `${warnings.length} pair warnings (worst: ${warnings[0]}). Full list on trades.pairWarnings.`;
    actions.push({
      code: "pair_underperformer",
      message,
      command: `tradekit pairs stats   # then use --auto-slippage when trading the flagged pair`,
      severity: "high",
    });
  }

  // v55 rule (critical): the config posture is EXPOSED — a critical
  // guardrail gap (safety disabled, or no USD ceiling at all) means agent
  // trading is unbounded. This belongs in the operator's primary dashboard,
  // not only in a `safety review` they have to remember to run.
  if (args.safety && args.safety.postureVerdict === "exposed") {
    actions.push({
      code: "safety_exposed",
      message: `Wallet safety posture is EXPOSED (${args.safety.criticalGaps} critical gap${args.safety.criticalGaps === 1 ? "" : "s"})${args.safety.topGap ? `: ${args.safety.topGap}` : ""}.`,
      command: "tradekit safety review",
      severity: "critical",
    });
  }

  // v55 rule: a runtime guardrail is near or past its limit. Severity
  // tracks how close: a tripped drawdown breaker (trading halted) is
  // critical, an exhausted cap high, an approaching one medium.
  if (args.safety?.binding && args.safety.binding.status !== "ok") {
    const b = args.safety.binding;
    const severity: NextAction["severity"] =
      b.status === "tripped" ? "critical" : b.status === "exhausted" ? "high" : "medium";
    actions.push({
      code: "limit_near_exhaustion",
      message: `${b.label} (${b.scope}) is ${b.status}${b.utilizationPct != null ? ` at ${b.utilizationPct.toFixed(0)}%` : ""} — ${b.detail}`,
      command: "tradekit safety headroom",
      severity,
    });
  }

  // Iter693: sort by severity so the CLI render (which iterates in order)
  // shows critical signals first. Stable sort preserves relative order
  // within the same severity tier — operators get a deterministic display.
  const SEVERITY_RANK: Record<NextAction["severity"], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  actions.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return actions;
}

/**
 * Iter621: pure helper. Median + average of a numeric array, ignoring non-finite
 * entries. Used to roll up slippage bps from the trade-analysis batch.
 * Returns null for empty / all-non-finite input rather than NaN.
 */
export function medianAndAvg(values: readonly number[]): {
  median: number | null;
  avg: number | null;
  count: number;
} {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return { median: null, avg: null, count: 0 };
  const sorted = [...clean].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const avg = sorted.reduce((s, n) => s + n, 0) / sorted.length;
  return { median, avg, count: sorted.length };
}

/**
 * Iter621: distill PortfolioReport → PortfolioSection. Pure.
 * `limit` caps the top[] display rows (default 5).
 */
export function buildPortfolioSection(report: PortfolioReport, limit = 5): PortfolioSection {
  return {
    totalUsd: report.totalUsd,
    positionCount: report.tokens.length,
    unpricedCount: report.unpricedPositionCount,
    top: report.tokens.slice(0, limit).map((t) => ({
      symbol: t.symbol,
      totalUsd: t.totalUsd ?? 0,
      percentOfPortfolio: t.percentOfPortfolio ?? 0,
    })),
    concentration: report.concentration,
  };
}

/**
 * Iter621: distill TradeRow batch + AnalyzedTrade batch → TradesSection. Pure.
 * The `since7d` filter (ISO timestamp lower bound) is applied here so callers
 * don't need to pre-filter; we walk the full set once.
 */
export function buildTradesSection(args: {
  rows: readonly TradeRow[];
  analyses: readonly AnalyzedTrade[];
  since7d: string;
}): TradesSection {
  const recent = args.rows.filter((r) => r.timestamp >= args.since7d);
  const successCount = recent.filter((r) => r.status === "success").length;
  const failedCount = recent.filter((r) => r.status === "failed").length;
  const pendingCount = recent.filter((r) => r.status === "pending").length;

  // Iter653: prefer iter641-stored realized_slippage_bps over iter619 live
  // analyses. Stored is the SAME number (both computed via iter619's
  // compareTradeExecution) but doesn't require per-row RPC. Analyses fill in
  // only for rows that lack stored data (legacy + import-only + reverted).
  // byVerdict still comes from analyses — verdict bucketing requires a
  // comparison object analyses provide.
  const slips: number[] = [];
  const seenInStored = new Set<string>();
  for (const r of recent) {
    if (r.realized_slippage_bps != null && Number.isFinite(r.realized_slippage_bps)) {
      slips.push(r.realized_slippage_bps);
      seenInStored.add(r.tx_hash.toLowerCase());
    }
  }
  const byVerdict: Record<string, number> = {};
  for (const a of args.analyses) {
    byVerdict[a.finding.code] = (byVerdict[a.finding.code] ?? 0) + 1;
    // Iter653: only consult analysis slippage for rows that DIDN'T already
    // contribute via stored — prevents double-counting in mixed datasets.
    if (a.comparison && !seenInStored.has(a.txHash.toLowerCase())) {
      slips.push(a.comparison.slippageBps);
    }
  }
  const { median, avg } = medianAndAvg(slips);

  // Iter671/iter675: failure-reason histogram via the shared helper.
  // Operators investigating a wave of failures don't need to walk the rows
  // themselves — health surfaces the dominant reasons up-front.
  const failureReasons = failureReasonHistogram(recent);

  // Iter689: aggregator underperformer warnings — reuse iter688's
  // deriveWarnings on the recent rows. We pass analyses through (some
  // warnings rely on the iter641 stored slippage which is on the row,
  // others use analysis-derived data). computeAggregatorStats is pure +
  // synchronous so this stays cheap.
  let aggregatorWarnings: string[] = [];
  try {
    const stats = computeAggregatorStats(recent, args.analyses);
    aggregatorWarnings = stats.warnings;
  } catch {
    // Defensive: bad data shouldn't break the trades section. Empty list
    // → no nextActions get surfaced from this signal.
  }

  // Iter691: pair underperformer warnings — same pattern as the aggregator
  // case above. computePairStats is also pure + synchronous.
  let pairWarnings: string[] = [];
  try {
    const stats = computePairStats(recent, args.analyses);
    pairWarnings = stats.warnings;
  } catch {
    /* defensive */
  }

  return {
    total: recent.length,
    successCount,
    failedCount,
    pendingCount,
    medianSlippageBps: median ?? undefined,
    avgSlippageBps: avg ?? undefined,
    byVerdict,
    failureReasons,
    aggregatorWarnings,
    pairWarnings,
  };
}

/**
 * Iter621: distill a single-chain AllowanceAuditReport → partial SecuritySection.
 * Caller sums across multiple chains (one audit report per chain).
 *
 * `topN` caps the topConcerns list across the merged result.
 */
export function buildSecuritySection(reports: readonly AllowanceAuditReport[], topN = 5): SecuritySection {
  let totalApprovals = 0;
  let criticalCount = 0;
  let warnCount = 0;
  let staleCount: number | undefined;
  const concerns: SecuritySection["topConcerns"] = [];

  for (const report of reports) {
    totalApprovals += report.counts.total;
    criticalCount += report.counts.critical;
    warnCount += report.counts.warn;
    for (const a of report.allowances) {
      if (a.severity === "critical" || a.severity === "warn") {
        concerns.push({
          symbol: a.symbol,
          spenderLabel: a.spenderLabel,
          spender: a.spender,
          severity: a.severity,
          chain: report.chain,
        });
      }
      // Iter617: count stale_approval findings.
      if (a.findings.some((f) => f.code === "stale_approval")) {
        staleCount = (staleCount ?? 0) + 1;
      }
    }
  }

  // Sort concerns: critical first, then warn; within each by symbol for
  // deterministic display order.
  concerns.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });

  return {
    totalApprovals,
    criticalCount,
    warnCount,
    staleCount,
    topConcerns: concerns.slice(0, topN),
  };
}

/**
 * Iter621: distill PnLReport → PnLSection. Pure.
 *
 * `windowLabel` selects which window's realized number to surface. When the
 * report doesn't carry the requested window (caller forgot to ask for it),
 * realized7d falls back to the report's total realized. The function never
 * throws — partial data is preferable to an empty section.
 */
export function buildPnLSection(report: PnLReport, windowLabel = "7d"): PnLSection {
  const window = report.windows?.find((w) => w.label === windowLabel);

  // Top winner / loser by realized PnL in the window (or report-wide).
  const windowPositions = window?.positions ?? [];
  let topWinner: PnLSection["topWinner"];
  let topLoser: PnLSection["topLoser"];
  for (const p of windowPositions) {
    if (p.realizedUsd > 0 && (topWinner == null || p.realizedUsd > topWinner.realizedUsd)) {
      topWinner = { symbol: p.symbol, chain: p.chain, realizedUsd: p.realizedUsd };
    }
    if (p.realizedUsd < 0 && (topLoser == null || p.realizedUsd < topLoser.realizedUsd)) {
      topLoser = { symbol: p.symbol, chain: p.chain, realizedUsd: p.realizedUsd };
    }
  }

  // Iter640: top winners + losers by canonical pair (iter639). Sort by
  // realizedUsd desc → first 3 are winners (positive realized); reverse
  // tail gives the worst 2 losers. Empty arrays when no pair data.
  const byPair = report.byPair ?? [];
  const topWinnerPairs = byPair.filter((p) => p.realizedUsd > 0).slice(0, 3);
  const topLoserPairs = [...byPair]
    .filter((p) => p.realizedUsd < 0)
    .sort((a, b) => a.realizedUsd - b.realizedUsd) // most-negative first
    .slice(0, 2);

  // Iter650: top winners + loser by strategy (iter649). Filter "(none)" so
  // only explicitly-tagged strategies appear — the section is about strategy
  // attribution, not "did my untagged trades make money".
  const byStrategy = (report.byStrategy ?? []).filter((s) => s.strategy !== "(none)");
  const topWinnerStrategies = byStrategy.filter((s) => s.realizedUsd > 0).slice(0, 2);
  const topLoserStrategies = [...byStrategy]
    .filter((s) => s.realizedUsd < 0)
    .sort((a, b) => a.realizedUsd - b.realizedUsd)
    .slice(0, 1);

  return {
    realized7dUsd: window?.realizedUsd ?? report.totalRealizedUsd,
    unrealizedUsd: report.totalUnrealizedUsd,
    gas7dUsd: window?.totalGasUsd ?? report.totalGasUsd,
    netAfterGas7dUsd: window?.realizedAfterGasUsd ?? report.totalRealizedAfterGasUsd,
    topWinner,
    topLoser,
    ...(topWinnerPairs.length > 0 ? { topWinnerPairs } : {}),
    ...(topLoserPairs.length > 0 ? { topLoserPairs } : {}),
    ...(topWinnerStrategies.length > 0 ? { topWinnerStrategies } : {}),
    ...(topLoserStrategies.length > 0 ? { topLoserStrategies } : {}),
  };
}

/**
 * Iter621: compute a HealthReport. Composes 4-5 RPC + DB reads in parallel via
 * Promise.allSettled — per-section failure is captured into errors[] instead
 * of aborting the whole report.
 *
 * `chains` / `accounts` mirror the portfolio command's flag semantics.
 *
 * NOTE: This function is the ORCHESTRATOR. It does not directly do any chain
 * I/O — instead it takes pre-computed reports from each domain (portfolio,
 * pnl, audits, analyses). The CLI/MCP layer is responsible for fetching those
 * via the existing primitives so that each surface controls its own error/
 * retry strategy. This keeps health.ts pure-compose and easily testable.
 */
/**
 * v55: compose the safety dimension from the v51 config posture +
 * (optional) v53 runtime headroom. Pure — reviewSafety reads config only;
 * the headroom (which reads the DB) is computed by the caller and passed in.
 */
export function buildSafetySection(
  config: Config,
  headroom?: SafetyHeadroomReport,
): HealthSafetySection {
  const posture = reviewSafety(config);
  // Worst-severity gap finding for the one-liner (critical before warn).
  const worst =
    posture.gaps.find((g) => g.severity === "critical") ??
    posture.gaps.find((g) => g.severity === "warn");
  const section: HealthSafetySection = {
    postureVerdict: posture.verdict,
    criticalGaps: posture.counts.critical,
    warnGaps: posture.counts.warn,
    ...(worst ? { topGap: worst.finding } : {}),
  };
  if (headroom?.binding) {
    const b = headroom.binding;
    section.binding = {
      label: b.label,
      scope: b.scope,
      utilizationPct: b.utilizationPct,
      status: b.status,
      detail: b.detail,
    };
  }
  return section;
}

export function composeHealthReport(args: {
  scope: { accounts: AccountResolution[]; chains: string[] };
  portfolio?: PortfolioReport | { error: string };
  pnl?: PnLReport | { error: string };
  approvalAudits?: AllowanceAuditReport[] | { error: string };
  analyses?: AnalyzedTrade[] | { error: string };
  recentRows?: TradeRow[] | { error: string };
  since7d: string;
  daysSinceLastSnapshot?: number;
  portfolioDelta24h?: PortfolioSection["delta24h"];
  portfolioDelta7d?: PortfolioSection["delta7d"];
  lastSnapshotAt?: string;
  /** Iter655/iter670: counts of legacy rows needing backfill. When supplied,
   *  deriveNextActions adds backfill recommendations. */
  legacyBackfillCounts?: {
    missingBlockNumber: number;
    missingSlippage: number;
    missingGasUsd: number;
    missingRevertReason: number;
  };
  /** Iter729: wall-clock ms measured by the CLI/MCP orchestrator covering
   *  the full fan-out (portfolio + pnl + analyses + approvals) + compose.
   *  Optional so existing callers that don't measure don't need updates. */
  elapsedMs?: number;
  /** v55: config for the safety-posture review (pure, config-only). When
   *  supplied, the report gains a `safety` section + safety_exposed rule. */
  config?: Config;
  /** v55: pre-computed runtime headroom (reads the DB, so the CLI/MCP layer
   *  computes it — same orchestrator contract as portfolio/pnl). Drives the
   *  binding-constraint summary + limit_near_exhaustion rule. */
  headroom?: SafetyHeadroomReport | { error: string };
}): HealthReport {
  const errors: HealthSectionError[] = [];

  let portfolio: PortfolioSection | undefined;
  if (args.portfolio && "error" in args.portfolio) {
    errors.push({ code: "portfolio_failed", message: args.portfolio.error });
  } else if (args.portfolio) {
    portfolio = buildPortfolioSection(args.portfolio);
    portfolio.delta24h = args.portfolioDelta24h;
    portfolio.delta7d = args.portfolioDelta7d;
    portfolio.lastSnapshotAt = args.lastSnapshotAt;
  }

  let pnl: PnLSection | undefined;
  if (args.pnl && "error" in args.pnl) {
    errors.push({ code: "pnl_failed", message: args.pnl.error });
  } else if (args.pnl) {
    pnl = buildPnLSection(args.pnl);
  }

  let security: SecuritySection | undefined;
  if (args.approvalAudits && !Array.isArray(args.approvalAudits) && "error" in args.approvalAudits) {
    errors.push({ code: "approvals_failed", message: args.approvalAudits.error });
  } else if (Array.isArray(args.approvalAudits)) {
    security = buildSecuritySection(args.approvalAudits);
  }

  let trades: TradesSection | undefined;
  const rowsErr = args.recentRows && !Array.isArray(args.recentRows) && "error" in args.recentRows;
  const analysesErr = args.analyses && !Array.isArray(args.analyses) && "error" in args.analyses;
  if (rowsErr || analysesErr) {
    errors.push({
      code: "trades_failed",
      message: [
        rowsErr ? (args.recentRows as { error: string }).error : null,
        analysesErr ? (args.analyses as { error: string }).error : null,
      ]
        .filter(Boolean)
        .join("; "),
    });
  } else {
    trades = buildTradesSection({
      rows: Array.isArray(args.recentRows) ? args.recentRows : [],
      analyses: Array.isArray(args.analyses) ? args.analyses : [],
      since7d: args.since7d,
    });
  }

  // Iter743: extract staleBookmarks from the pnl report when it's the live
  // shape (not an error placeholder). Maps to deriveNextActions's narrow
  // signal type so the rule layer stays decoupled from the full PnLReport.
  const staleBookmarks = args.pnl && !("error" in args.pnl)
    ? args.pnl.dataFreshness?.staleBookmarks.map((s) => ({
        chain: s.chain,
        account: s.account,
        ageHours: s.ageHours,
      }))
    : undefined;

  // v55: safety posture (pure config review) + binding runtime headroom.
  let safety: HealthSafetySection | undefined;
  if (args.headroom && "error" in args.headroom) {
    errors.push({ code: "safety_failed", message: args.headroom.error });
  }
  if (args.config) {
    const headroom = args.headroom && !("error" in args.headroom) ? args.headroom : undefined;
    safety = buildSafetySection(args.config, headroom);
  }

  const nextActions = deriveNextActions({
    portfolio,
    trades,
    security,
    daysSinceLastSnapshot: args.daysSinceLastSnapshot,
    legacyBackfillCounts: args.legacyBackfillCounts,
    ...(staleBookmarks && staleBookmarks.length > 0 ? { staleBookmarks } : {}),
    ...(safety ? { safety } : {}),
  });

  // Iter764: pre-compute severity counts so dashboard consumers don't have to.
  // Cheap O(n) over a small (≤12) array — does not warrant memoization or any
  // structural caching. Always emit zero-baseline so consumers can read every
  // key without a presence check.
  const nextActionsSummary = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of nextActions) nextActionsSummary[a.severity]++;

  // Iter786: derive the worst-bucket severity from the summary. Priority
  // order matches deriveNextActions's SEVERITY_RANK (critical > high >
  // medium > low). Defaults to "ok" when there are no actions.
  const severity: HealthReport["severity"] =
    nextActionsSummary.critical > 0
      ? "critical"
      : nextActionsSummary.high > 0
        ? "high"
        : nextActionsSummary.medium > 0
          ? "medium"
          : nextActionsSummary.low > 0
            ? "low"
            : "ok";

  // Iter827: pre-filter critical actions for dashboards. Cheap O(n) over
  // ≤12 entries; same predicate iter734 --quiet uses to filter rendered
  // output.
  const criticalActions = nextActions.filter((a) => a.severity === "critical");

  return {
    timestamp: new Date().toISOString(),
    // Iter729: orchestrator-measured elapsed (compose is pure; the fan-out
    // wrapping it is what takes time).
    ...(args.elapsedMs !== undefined ? { elapsedMs: args.elapsedMs } : {}),
    scope: args.scope,
    portfolio,
    pnl,
    trades,
    security,
    ...(safety ? { safety } : {}),
    errors,
    nextActions,
    nextActionsSummary,
    severity,
    criticalActions,
  };
}

/**
 * Iter621: format a USD delta with sign and an optional pct suffix.
 * Pure helper exported for the CLI text mode + tests.
 */
export function formatUsdDelta(delta: number, pct?: number | null): string {
  const sign = delta >= 0 ? "+" : "-";
  const abs = Math.abs(delta);
  const usdStr = abs < 0.01 ? "$0.00" : `$${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const pctStr = pct == null ? "" : ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
  return `${sign}${usdStr}${pctStr}`;
}
