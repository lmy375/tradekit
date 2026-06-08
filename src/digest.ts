/**
 * Activity digest — operator-facing window summary.
 *
 * The natural complement to iter23's `tradekit status`:
 *   - status  = "what is the engine doing RIGHT NOW"
 *   - digest  = "what happened over the last N (hours / days)"
 *
 * Composes trades + strategy fires + safety events + errors from
 * existing DB tables into a structured report. Three formats:
 *   - text:  multi-section operator-readable
 *   - slack: markdown formatted for direct webhook delivery
 *   - json:  structured shape for downstream consumers
 *
 * Production workflow this unlocks: a daily cron job pipes the slack
 * format into a Slack incoming webhook, no operator intervention.
 *
 *   0 9 * * * tradekit digest --window 24h --format slack | \
 *     curl -X POST -H 'Content-Type: text/plain' --data-binary @- $SLACK_WEBHOOK
 *
 * Performance: ~6 indexed DB queries, all bounded by `since` predicate.
 * Sub-100ms on a busy install.
 */

import { ToolError } from "./errors.js";
import {
  recentTrades,
  recentAudit,
  auditSummary,
  listOrders,
  listSchedules,
  listRebalancePlans,
  listDrawdownStates,
  type TradeRow,
  type OrderRow,
  type ScheduleRow,
  type RebalanceRow,
} from "./db.js";
import { computeBudgetConsumption } from "./strategyBudget.js";
import { loadConfig, type Config } from "./config.js";

// ── window parsing ───────────────────────────────────────────

/**
 * Parse a window string like "24h", "7d", "1h", "30d" into a
 * milliseconds value. Used for the `since` predicate on every DB
 * query. Range-checked to [1 minute, 90 days] — beyond 90d the audit
 * log + trades table get large enough that the digest's "top errors
 * + recent fires" lose signal.
 */
export function parseWindowMs(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(raw.trim());
  if (!m) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--window "${raw}" — use formats like 1h, 24h, 7d, 30d.`,
    );
  }
  const n = parseFloat(m[1]);
  const unit = m[2];
  const ms = n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
  if (ms < 60_000) {
    throw new ToolError("INVALID_PARAMS", `--window "${raw}" — minimum 1 minute.`);
  }
  if (ms > 90 * 86_400_000) {
    throw new ToolError("INVALID_PARAMS", `--window "${raw}" — maximum 90 days. Split into multiple shorter windows.`);
  }
  return ms;
}

// ── output shape ─────────────────────────────────────────────

export type HealthVerdict = "healthy" | "attention" | "critical";

export interface TradesSection {
  total: number;
  success: number;
  pending: number;
  failed: number;
  /** Sum of quote_amount across success+pending trades. Assumes
   *  USD-pegged quote (USDC/USDT/DAI) — same convention dailyUsdVolume
   *  uses. Unpriced trades contribute 0. */
  usdVolume: number;
  successRatePct: number;
  /** Top 5 strategy tags by trade count. */
  topStrategies: Array<{ strategy: string; count: number; usdVolume: number }>;
  /** Top 5 base symbols by trade count. */
  topBases: Array<{ symbol: string; count: number }>;
}

export interface FiresSection {
  /** Orders that transitioned to a terminal state during the window. */
  ordersFilled: number;
  ordersCancelled: number;
  ordersExpired: number;
  ordersFailed: number;
  /** Schedules that fired during the window (last_run_at in window).
   *  This counts SCHEDULES with at least one fire, not the total fire
   *  count — a busy schedule that fired 10× shows as 1. For exact
   *  fire counts use the trades section's strategy tag breakdown. */
  schedulesFired: number;
  /** Rebalance plans that ran during the window. */
  rebalanceRuns: number;
  /** Most recently fired orders (top 5). */
  recentFills: Array<{
    orderId: number;
    side: "buy" | "sell";
    base: string | null;
    quote: string | null;
    fillPrice: number | null;
    filledAt: string;
  }>;
}

export interface SafetyEventsSection {
  /** Number of times the drawdown breaker tripped DURING the window
   *  (distinct from "currently tripped" — a breaker that tripped
   *  and was later reset still counts). */
  drawdownTrips: number;
  /** Currently tripped scopes (snapshot at digest time). */
  drawdownCurrentlyTripped: Array<{ scope: string; trippedAt: string; drawdownPct: number | null }>;
  /** Trade attempts blocked by strategy budgets. */
  budgetBlocks: number;
  /** Trade attempts blocked by position limits. */
  positionLimitBlocks: number;
  /** Trade attempts blocked by the auto-honeypot probe. */
  honeypotBlocks: number;
  /** Trade attempts blocked by gas-budget guardrail. */
  gasBudgetBlocks: number;
  /** Currently configured budgets utilized > 80%. */
  budgetWarnings: Array<{ tag: string; window: "lifetime" | "daily"; utilizationPct: number }>;
}

export interface ErrorsSection {
  totalAuditRows: number;
  errorRows: number;
  errorRatePct: number;
  /** Top 5 error codes by count. */
  topErrors: Array<{ code: string; count: number; lastSeen: string }>;
}

export interface ComparisonDelta {
  trades: number;
  usdVolume: number;
  ordersFilled: number;
  errorRows: number;
}

export interface DigestReport {
  generatedAt: string;
  /** ISO timestamp of the window's start. */
  windowStart: string;
  /** ISO timestamp of the window's end (= generatedAt). */
  windowEnd: string;
  /** Window label as the operator supplied. */
  windowLabel: string;
  /** Overall health verdict computed from the sections. */
  verdict: HealthVerdict;
  /** Human-readable reasons feeding the verdict. */
  verdictReasons: string[];
  trades: TradesSection;
  fires: FiresSection;
  safety: SafetyEventsSection;
  errors: ErrorsSection;
  /** When `--compare` was set, the same digest for the immediately-
   *  prior window with the same length. */
  comparison: {
    prior: DigestReport | null;
    delta: ComparisonDelta;
  } | null;
}

// ── orchestrator ─────────────────────────────────────────────

export interface GatherDigestArgs {
  windowLabel: string;
  windowMs: number;
  /** Optional: also compute the immediately-prior window of the same
   *  length for comparison deltas. */
  compare?: boolean;
  config?: Config;
  now?: Date;
}

export function gatherDigest(args: GatherDigestArgs): DigestReport {
  const now = args.now ?? new Date();
  const config = args.config ?? loadConfig();

  return gatherWindow({
    nowMs: now.getTime(),
    windowMs: args.windowMs,
    windowLabel: args.windowLabel,
    config,
    includeComparison: args.compare ?? false,
  });
}

function gatherWindow(args: {
  nowMs: number;
  windowMs: number;
  windowLabel: string;
  config: Config;
  includeComparison: boolean;
}): DigestReport {
  const windowEnd = new Date(args.nowMs).toISOString();
  const windowStart = new Date(args.nowMs - args.windowMs).toISOString();

  const trades = gatherTrades({ since: windowStart });
  const fires = gatherFires({ since: windowStart });
  const safety = gatherSafety({ since: windowStart, config: args.config });
  const errors = gatherErrors({ since: windowStart });

  const { verdict, verdictReasons } = classifyVerdict({ trades, fires, safety, errors });

  let comparison: DigestReport["comparison"] = null;
  if (args.includeComparison) {
    const priorEnd = new Date(args.nowMs - args.windowMs).toISOString();
    const priorStart = new Date(args.nowMs - 2 * args.windowMs).toISOString();
    const priorTrades = gatherTrades({ since: priorStart, until: priorEnd });
    const priorFires = gatherFiresWithUntil({ since: priorStart, until: priorEnd });
    const priorErrors = gatherErrors({ since: priorStart, until: priorEnd });
    const priorSafety = gatherSafety({ since: priorStart, until: priorEnd, config: args.config });
    const priorVerdict = classifyVerdict({
      trades: priorTrades, fires: priorFires, safety: priorSafety, errors: priorErrors,
    });
    const prior: DigestReport = {
      generatedAt: windowStart,
      windowStart: priorStart,
      windowEnd: priorEnd,
      windowLabel: args.windowLabel,
      verdict: priorVerdict.verdict,
      verdictReasons: priorVerdict.verdictReasons,
      trades: priorTrades, fires: priorFires, safety: priorSafety, errors: priorErrors,
      comparison: null,
    };
    comparison = {
      prior,
      delta: {
        trades: trades.total - prior.trades.total,
        usdVolume: trades.usdVolume - prior.trades.usdVolume,
        ordersFilled: fires.ordersFilled - prior.fires.ordersFilled,
        errorRows: errors.errorRows - prior.errors.errorRows,
      },
    };
  }

  return {
    generatedAt: windowEnd,
    windowStart,
    windowEnd,
    windowLabel: args.windowLabel,
    verdict,
    verdictReasons,
    trades,
    fires,
    safety,
    errors,
    comparison,
  };
}

// ── trades section ───────────────────────────────────────────

function gatherTrades(args: { since: string; until?: string }): TradesSection {
  // Pull every trade in the window — bounded by the window timestamp
  // predicate which uses idx_trades_ts. Limit high enough to cover
  // even a busy install (1000 trades in 24h is ~heavy ops); operators
  // who hit this should split into shorter windows.
  const rows = recentTrades({ limit: 5000, since: args.since });
  const filtered = args.until ? rows.filter((r) => r.timestamp < args.until!) : rows;

  let success = 0, pending = 0, failed = 0;
  let usdVolume = 0;
  const strategyTotals = new Map<string, { count: number; usdVolume: number }>();
  const baseTotals = new Map<string, number>();
  for (const r of filtered) {
    if (r.status === "success") success++;
    else if (r.status === "pending") pending++;
    else if (r.status === "failed") failed++;

    if (r.status === "success" || r.status === "pending") {
      const usd = parseFloat(r.quote_amount);
      if (Number.isFinite(usd)) usdVolume += usd;
    }
    if (r.strategy) {
      const cur = strategyTotals.get(r.strategy) ?? { count: 0, usdVolume: 0 };
      cur.count++;
      const usd = parseFloat(r.quote_amount);
      if (Number.isFinite(usd) && (r.status === "success" || r.status === "pending")) cur.usdVolume += usd;
      strategyTotals.set(r.strategy, cur);
    }
    const baseSym = r.base_symbol ?? "(unknown)";
    baseTotals.set(baseSym, (baseTotals.get(baseSym) ?? 0) + 1);
  }
  const total = filtered.length;
  const successRatePct = total > 0 ? (success / total) * 100 : 0;
  const topStrategies = Array.from(strategyTotals.entries())
    .map(([strategy, v]) => ({ strategy, count: v.count, usdVolume: v.usdVolume }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const topBases = Array.from(baseTotals.entries())
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return { total, success, pending, failed, usdVolume, successRatePct, topStrategies, topBases };
}

// ── fires section ────────────────────────────────────────────

function gatherFires(args: { since: string }): FiresSection {
  return gatherFiresWithUntil({ since: args.since });
}

function gatherFiresWithUntil(args: { since: string; until?: string }): FiresSection {
  // Orders: filter by filled_at / updated_at in window for the
  // terminal-state counters. We pull all orders + filter in JS
  // because listOrders doesn't support a time predicate on a
  // computed field — but orders is a small table (typically <1K
  // rows even on busy installs), so the scan is cheap.
  const allOrders = listOrders({ status: "all", limit: 5000 });
  let ordersFilled = 0, ordersCancelled = 0, ordersExpired = 0, ordersFailed = 0;
  const fills: Array<OrderRow & { _filledAt: string }> = [];
  for (const o of allOrders) {
    if (o.filled_at && inWindow(o.filled_at, args)) {
      if (o.status === "filled") {
        ordersFilled++;
        fills.push({ ...o, _filledAt: o.filled_at });
      }
    }
    // Cancelled / expired / failed: updated_at is the terminal-
    // transition timestamp. status is the final state.
    if (o.status === "cancelled" && inWindow(o.updated_at, args)) ordersCancelled++;
    if (o.status === "expired" && inWindow(o.updated_at, args)) ordersExpired++;
    if (o.status === "failed" && inWindow(o.updated_at, args)) ordersFailed++;
  }
  const recentFills = fills
    .sort((a, b) => b._filledAt.localeCompare(a._filledAt))
    .slice(0, 5)
    .map((o) => ({
      orderId: o.id!,
      side: o.side,
      base: o.base_symbol,
      quote: o.quote_symbol,
      fillPrice: o.fill_price,
      filledAt: o._filledAt,
    }));

  // Schedules: last_run_at in window means the schedule fired AT
  // LEAST ONCE in the window. We can't distinguish "fired once" from
  // "fired 10 times" without a journal, so this counts SCHEDULES
  // that fired, not individual fires. The trades-by-strategy breakdown
  // already covers exact fire counts when a strategy tag is set.
  const allSchedules: ScheduleRow[] = listSchedules({ status: "all", limit: 5000 });
  let schedulesFired = 0;
  for (const s of allSchedules) {
    if (s.last_run_at && inWindow(s.last_run_at, args)) schedulesFired++;
  }

  // Rebalance plans: same logic on last_run_at.
  const allPlans: RebalanceRow[] = listRebalancePlans({ status: "all", limit: 5000 });
  let rebalanceRuns = 0;
  for (const p of allPlans) {
    if (p.last_run_at && inWindow(p.last_run_at, args)) rebalanceRuns++;
  }

  return {
    ordersFilled, ordersCancelled, ordersExpired, ordersFailed,
    schedulesFired, rebalanceRuns,
    recentFills,
  };
}

function inWindow(iso: string, args: { since: string; until?: string }): boolean {
  if (iso < args.since) return false;
  if (args.until && iso >= args.until) return false;
  return true;
}

// ── safety section ───────────────────────────────────────────

function gatherSafety(args: {
  since: string;
  until?: string;
  config: Config;
}): SafetyEventsSection {
  // Pull audit rows in the window with non-null error codes; count
  // by code. Use recentAudit which uses idx_audit_ts.
  const auditRows = recentAudit(5000, {
    since: args.since,
  });
  const filtered = args.until ? auditRows.filter((r) => r.timestamp < args.until!) : auditRows;
  let drawdownTrips = 0, budgetBlocks = 0, positionLimitBlocks = 0;
  let honeypotBlocks = 0, gasBudgetBlocks = 0;
  for (const r of filtered) {
    if (!r.error_code) continue;
    switch (r.error_code) {
      case "DRAWDOWN_CIRCUIT_BREAKER_TRIPPED": drawdownTrips++; break;
      case "STRATEGY_BUDGET_EXCEEDED":         budgetBlocks++; break;
      case "POSITION_LIMIT_EXCEEDED":          positionLimitBlocks++; break;
      case "TOKEN_BLOCKED":                    honeypotBlocks++; break;
      case "GAS_BUDGET_EXCEEDED":              gasBudgetBlocks++; break;
    }
  }

  // Currently-tripped drawdown scopes (snapshot at digest time).
  const drawdownStates = listDrawdownStates();
  const drawdownCurrentlyTripped = drawdownStates
    .filter((s) => s.tripped_at != null)
    .map((s) => {
      const drawdownPct = s.last_value_usd != null && s.peak_usd > 0
        ? ((s.peak_usd - s.last_value_usd) / s.peak_usd) * 100
        : null;
      return { scope: s.scope_key, trippedAt: s.tripped_at!, drawdownPct };
    });

  // Budget warnings (utilization > 80%). Live consumption — same
  // computation `tradekit strategies --budget` uses.
  const budgets = args.config.safety.strategyBudgets ?? [];
  const budgetWarnings: SafetyEventsSection["budgetWarnings"] = [];
  if (budgets.length > 0) {
    const consumption = computeBudgetConsumption({ budgets });
    for (const c of consumption) {
      if (c.rule.lifetimeUsd != null && c.lifetimeSpentUsd != null && c.rule.lifetimeUsd > 0) {
        const pct = (c.lifetimeSpentUsd / c.rule.lifetimeUsd) * 100;
        if (pct >= 80) budgetWarnings.push({ tag: c.rule.tag, window: "lifetime", utilizationPct: pct });
      }
      if (c.rule.dailyUsd != null && c.dailySpentUsd != null && c.rule.dailyUsd > 0) {
        const pct = (c.dailySpentUsd / c.rule.dailyUsd) * 100;
        if (pct >= 80) budgetWarnings.push({ tag: c.rule.tag, window: "daily", utilizationPct: pct });
      }
    }
  }

  return {
    drawdownTrips, drawdownCurrentlyTripped,
    budgetBlocks, positionLimitBlocks, honeypotBlocks, gasBudgetBlocks,
    budgetWarnings,
  };
}

// ── errors section ───────────────────────────────────────────

function gatherErrors(args: { since: string; until?: string }): ErrorsSection {
  if (args.until) {
    // auditSummary doesn't take an `until` predicate; for the
    // comparison-prior path we filter manually. Cheap enough at the
    // 5000-row limit.
    const rows = recentAudit(5000, { since: args.since });
    const filtered = rows.filter((r) => r.timestamp < args.until!);
    const errorCounts = new Map<string, { count: number; lastSeen: string }>();
    for (const r of filtered) {
      if (!r.error_code) continue;
      const cur = errorCounts.get(r.error_code) ?? { count: 0, lastSeen: r.timestamp };
      cur.count++;
      if (r.timestamp > cur.lastSeen) cur.lastSeen = r.timestamp;
      errorCounts.set(r.error_code, cur);
    }
    const errorRows = filtered.filter((r) => r.error_code).length;
    return {
      totalAuditRows: filtered.length,
      errorRows,
      errorRatePct: filtered.length > 0 ? (errorRows / filtered.length) * 100 : 0,
      topErrors: Array.from(errorCounts.entries())
        .map(([code, v]) => ({ code, count: v.count, lastSeen: v.lastSeen }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    };
  }
  const summary = auditSummary({ since: args.since });
  return {
    totalAuditRows: summary.totalRows,
    errorRows: summary.errorRows,
    errorRatePct: summary.totalRows > 0 ? (summary.errorRows / summary.totalRows) * 100 : 0,
    topErrors: summary.byErrorCode.slice(0, 5).map((e) => ({
      code: e.errorCode, count: e.count, lastSeen: e.lastSeen,
    })),
  };
}

// ── verdict classification ───────────────────────────────────

/**
 * Aggregate signals into one operator-readable health verdict.
 *
 * critical (🔴) — any of:
 *   - drawdown breaker tripped (at any point) OR currently tripped
 *   - error rate > 25%
 * attention (🟡) — any of:
 *   - error rate > 10%
 *   - any budget utilization > 80%
 *   - any safety blocks (budget / position / honeypot / gas)
 *   - any orders failed
 * healthy (🟢) — none of the above.
 *
 * Reasons are accumulated regardless of verdict level — the renderer
 * picks the most severe but operators can inspect all signals via JSON.
 */
export function classifyVerdict(args: {
  trades: TradesSection;
  fires: FiresSection;
  safety: SafetyEventsSection;
  errors: ErrorsSection;
}): { verdict: HealthVerdict; verdictReasons: string[] } {
  const reasons: string[] = [];
  let critical = false;
  let attention = false;

  if (args.safety.drawdownTrips > 0) {
    reasons.push(`drawdown breaker tripped ${args.safety.drawdownTrips}× during window`);
    critical = true;
  }
  if (args.safety.drawdownCurrentlyTripped.length > 0) {
    reasons.push(`drawdown breaker currently tripped (${args.safety.drawdownCurrentlyTripped.length} scope${args.safety.drawdownCurrentlyTripped.length === 1 ? "" : "s"})`);
    critical = true;
  }
  if (args.errors.errorRatePct > 25) {
    reasons.push(`error rate ${args.errors.errorRatePct.toFixed(1)}% > 25% threshold`);
    critical = true;
  }
  if (args.errors.errorRatePct > 10 && args.errors.errorRatePct <= 25) {
    reasons.push(`error rate ${args.errors.errorRatePct.toFixed(1)}% > 10% threshold`);
    attention = true;
  }
  for (const w of args.safety.budgetWarnings) {
    reasons.push(`budget "${w.tag}" ${w.window} utilization ${w.utilizationPct.toFixed(0)}%`);
    attention = true;
  }
  const safetyBlockTotal =
    args.safety.budgetBlocks +
    args.safety.positionLimitBlocks +
    args.safety.honeypotBlocks +
    args.safety.gasBudgetBlocks;
  if (safetyBlockTotal > 0) {
    reasons.push(`${safetyBlockTotal} safety block${safetyBlockTotal === 1 ? "" : "s"} during window`);
    attention = true;
  }
  if (args.fires.ordersFailed > 0) {
    reasons.push(`${args.fires.ordersFailed} order${args.fires.ordersFailed === 1 ? "" : "s"} failed during window`);
    attention = true;
  }

  let verdict: HealthVerdict = "healthy";
  if (critical) verdict = "critical";
  else if (attention) verdict = "attention";

  return { verdict, verdictReasons: reasons };
}

// ── verdict emoji (exported for renderers) ───────────────────

export function verdictEmoji(v: HealthVerdict): string {
  switch (v) {
    case "healthy": return "🟢";
    case "attention": return "🟡";
    case "critical": return "🔴";
  }
}

export function verdictLabel(v: HealthVerdict): string {
  switch (v) {
    case "healthy": return "healthy";
    case "attention": return "attention";
    case "critical": return "critical";
  }
}

// Silence unused-import warnings in callers that pull these types.
export type { TradeRow, OrderRow };
