// ──────────────────────────────────────────────────────────────────
// Strategy alerts (iter32): proactive notifications when a strategy
// crosses operator-defined health thresholds.
//
// The data layer for this is already in place — iter31's strategy
// report aggregates every signal we need. This module adds:
//
//   1. Pure rule evaluators: one per rule type, each takes the
//      report + the rule config and returns an `AlertEvaluation`
//      describing whether the rule is currently in violation +
//      the measured value.
//
//   2. State reconciler: diffs the current evaluation against the
//      DB row (v25 strategy_alert_state) and classifies into
//      transitions: OK→active = fire, active→OK = resolved,
//      no-change = silent.
//
//   3. Tick runner: orchestrates the full cycle — enumerate
//      strategies, build report (cheap section subset), evaluate
//      rules, reconcile, emit notifications, persist state.
//
// Design constraints:
//
//  * EXACTLY ONE notification per state transition. No fire-every-
//    tick spam. The dedup state row enforces this; even if the
//    operator disables + re-enables the notification dedup window,
//    we still won't fire twice for the same transition.
//
//  * Resolution events match the fire event 1:1 — when a previously-
//    alerting rule returns to OK, we emit a `<eventPrefix>.resolved`
//    notification with the same fields shape so dashboards / agents
//    can pair them.
//
//  * Pure rule evaluators have NO side effects — they only inspect
//    the report. The DB / notify I/O is restricted to the runner.
//    This makes the rule logic trivially testable without a fixture
//    DB.
//
//  * Rules that can't be evaluated (missing sections, no live price
//    for trigger_proximity, no trades for slippage_trend) return
//    `applicable: false`. Inapplicable rules NEVER fire or resolve;
//    they're skipped silently.
//
//  * Tag matching for appliesTo supports exact equality + the same
//    `prefix*` wildcard convention as strategyBudgets.
// ──────────────────────────────────────────────────────────────────

import {
  listOrders,
  listSchedules,
  listRebalancePlans,
  getStrategyAlertState,
  listStrategyAlertStates,
  upsertStrategyAlertState,
  insertAlertEvent,
  recentTrades,
  listPaperTrades,
  listDistinctStrategies,
  type StrategyAlertStateRow,
  type TradeRow,
  type PaperTradeRow,
} from "./db.js";
import type { Config } from "./config.js";
import type { StrategyAlertRule } from "./config.js";
import {
  buildStrategyReport,
  type StrategyReport,
} from "./strategyReport.js";
import { tryNotify, type NotificationEvent } from "./notify.js";
import type { Logger } from "./logger.js";

// ── types ───────────────────────────────────────────────────

/** Result of evaluating one rule against one strategy report. */
export interface AlertEvaluation {
  tag: string;
  ruleType: StrategyAlertRule["type"];
  rule: StrategyAlertRule;
  /** False when the rule literally can't be checked right now
   *  (insufficient sample size, missing live price, etc.). The
   *  reconciler skips inapplicable rules — they neither fire nor
   *  resolve, leaving any prior state intact for the next tick. */
  applicable: boolean;
  /** True when the rule is currently in VIOLATION (the alert
   *  condition is met). */
  violated: boolean;
  /** Human-readable one-liner for the notification title. */
  message: string;
  /** Structured payload for the notification fields + the
   *  last_value_json column. Rule-specific shape — every evaluator
   *  documents its own keys. */
  value: Record<string, string | number | boolean | null>;
}

/** Reconciler output for one (tag, rule) pair. */
export type AlertTransition =
  | { kind: "fire"; evaluation: AlertEvaluation; previousState: StrategyAlertStateRow | null }
  | { kind: "resolve"; evaluation: AlertEvaluation; previousState: StrategyAlertStateRow }
  | { kind: "still_active"; evaluation: AlertEvaluation; previousState: StrategyAlertStateRow }
  | { kind: "still_ok"; evaluation: AlertEvaluation; previousState: StrategyAlertStateRow | null }
  | { kind: "skip"; evaluation: AlertEvaluation };

/** Final report from one tick: counts + per-strategy list of fired
 *  notifications. Returned by runAlertTick so the CLI can render +
 *  the test suite can assert. */
export interface AlertTickReport {
  startedAt: string;
  evaluations: AlertEvaluation[];
  transitions: AlertTransition[];
  fired: number;
  resolved: number;
  stillActive: number;
  skipped: number;
}

// ── tag matching (mirrors strategyBudget.ts) ────────────────

/** A rule's appliesTo list filters which tags it evaluates against.
 *  Empty / missing list = applies to ALL tags. Each pattern matches
 *  literal equality OR `prefix*` wildcard. Exported for tests. */
export function ruleAppliesToTag(rule: StrategyAlertRule, tag: string): boolean {
  const patterns = rule.appliesTo;
  if (!patterns || patterns.length === 0) return true;
  for (const p of patterns) {
    if (p.endsWith("*")) {
      const prefix = p.slice(0, -1);
      if (tag.startsWith(prefix)) return true;
    } else if (p === tag) {
      return true;
    }
  }
  return false;
}

// ── pure rule evaluators ────────────────────────────────────
//
// Each takes a StrategyReport (built with whatever sections the
// runner requested) + the rule config and returns an
// AlertEvaluation. Pure functions — no I/O, no Date.now() —
// `now` is injected so tests can pin time.

type EvaluateFn<R extends StrategyAlertRule> = (args: {
  tag: string;
  rule: R;
  report: StrategyReport;
  now: Date;
}) => AlertEvaluation;

/** staleness: no fills (success rows) in the last N seconds. Uses
 *  the activity section's recentFills for freshness. Inapplicable
 *  when activity section was excluded from the report. */
export const evaluateStaleness: EvaluateFn<
  Extract<StrategyAlertRule, { type: "staleness" }>
> = ({ tag, rule, report, now }) => {
  const evaluation = (over: Partial<AlertEvaluation>): AlertEvaluation => ({
    tag,
    ruleType: rule.type,
    rule,
    applicable: false,
    violated: false,
    message: "",
    value: {},
    ...over,
  });
  const fills = report.activity?.recentFills;
  if (!fills) return evaluation({ message: "activity section missing" });
  // Strategies with no fills ever: if at least one primitive is
  // active, we DO consider this stale (the strategy has been
  // deployed long enough that the user expects fires). If there
  // are no active primitives, the rule is inapplicable.
  const hasActive = (report.composition?.lifecycle.active ?? 0) > 0;
  if (fills.length === 0) {
    if (!hasActive) return evaluation({ message: "no active primitives" });
    // Use identity.deployedAt or ageSeconds to decide; if the
    // strategy is younger than thresholdSeconds we don't alert.
    const age = report.identity?.ageSeconds ?? null;
    if (age == null || age < rule.thresholdSeconds) {
      return evaluation({ applicable: true, violated: false, message: "deployed but young", value: { ageSeconds: age ?? -1 } });
    }
    return evaluation({
      applicable: true,
      violated: true,
      message: `No fills since deployment ${Math.floor(age / 3600)}h ago (threshold ${Math.floor(rule.thresholdSeconds / 3600)}h)`,
      value: { lastFillAt: null, ageSeconds: age, thresholdSeconds: rule.thresholdSeconds },
    });
  }
  const lastFill = fills[0];
  const lastTs = Date.parse(lastFill.at);
  if (!Number.isFinite(lastTs)) {
    return evaluation({ message: "malformed timestamp" });
  }
  const sinceSec = Math.floor((now.getTime() - lastTs) / 1000);
  const violated = sinceSec >= rule.thresholdSeconds;
  return evaluation({
    applicable: true,
    violated,
    message: violated
      ? `No fills in ${Math.floor(sinceSec / 3600)}h (last: ${lastFill.at}; threshold ${Math.floor(rule.thresholdSeconds / 3600)}h)`
      : `Last fill ${Math.floor(sinceSec / 60)}m ago`,
    value: {
      lastFillAt: lastFill.at,
      secondsSinceLastFill: sinceSec,
      thresholdSeconds: rule.thresholdSeconds,
    },
  });
};

/** slippage_trend: observed avg slippage ≥ baselineBps × alertMultiplier. */
export const evaluateSlippageTrend: EvaluateFn<
  Extract<StrategyAlertRule, { type: "slippage_trend" }>
> = ({ tag, rule, report }) => {
  const evaluation = (over: Partial<AlertEvaluation>): AlertEvaluation => ({
    tag,
    ruleType: rule.type,
    rule,
    applicable: false,
    violated: false,
    message: "",
    value: {},
    ...over,
  });
  const perf = report.performance;
  if (!perf) return evaluation({ message: "performance section missing" });
  if (perf.avgSlippageBps == null) return evaluation({ message: "no slippage samples (paper or empty window)" });
  if (perf.fills < rule.minSampleSize) {
    return evaluation({ message: `insufficient samples (${perf.fills} < ${rule.minSampleSize})` });
  }
  const threshold = rule.baselineBps * rule.alertMultiplier;
  const violated = perf.avgSlippageBps >= threshold;
  return evaluation({
    applicable: true,
    violated,
    message: violated
      ? `Avg slippage ${perf.avgSlippageBps.toFixed(1)} bps ≥ threshold ${threshold.toFixed(1)} bps`
      : `Avg slippage ${perf.avgSlippageBps.toFixed(1)} bps`,
    value: {
      observedAvgBps: perf.avgSlippageBps,
      baselineBps: rule.baselineBps,
      thresholdBps: threshold,
      samples: perf.fills,
    },
  });
};

/** success_rate_drop: fills / (fills+failures) < minRate. */
export const evaluateSuccessRateDrop: EvaluateFn<
  Extract<StrategyAlertRule, { type: "success_rate_drop" }>
> = ({ tag, rule, report }) => {
  const evaluation = (over: Partial<AlertEvaluation>): AlertEvaluation => ({
    tag,
    ruleType: rule.type,
    rule,
    applicable: false,
    violated: false,
    message: "",
    value: {},
    ...over,
  });
  const perf = report.performance;
  if (!perf) return evaluation({ message: "performance section missing" });
  const total = perf.fills + perf.failures;
  if (total < rule.minSampleSize) {
    return evaluation({ message: `insufficient samples (${total} < ${rule.minSampleSize})` });
  }
  if (perf.successRate == null) return evaluation({ message: "successRate not computed" });
  const violated = perf.successRate < rule.minRate;
  return evaluation({
    applicable: true,
    violated,
    message: violated
      ? `Success rate ${(perf.successRate * 100).toFixed(1)}% < ${(rule.minRate * 100).toFixed(0)}%`
      : `Success rate ${(perf.successRate * 100).toFixed(1)}%`,
    value: {
      successRate: perf.successRate,
      minRate: rule.minRate,
      totalTrades: total,
    },
  });
};

/** failure_streak: walks recentFills + recentFailures chronologically
 *  newest-first, counting consecutive failures until the first fill
 *  or the bottom of the list. */
export const evaluateFailureStreak: EvaluateFn<
  Extract<StrategyAlertRule, { type: "failure_streak" }>
> = ({ tag, rule, report }) => {
  const evaluation = (over: Partial<AlertEvaluation>): AlertEvaluation => ({
    tag,
    ruleType: rule.type,
    rule,
    applicable: false,
    violated: false,
    message: "",
    value: {},
    ...over,
  });
  const activity = report.activity;
  if (!activity) return evaluation({ message: "activity section missing" });
  // Merge fills + failures, sorted newest-first.
  const merged = [...activity.recentFills, ...activity.recentFailures].sort((a, b) =>
    a.at < b.at ? 1 : -1,
  );
  if (merged.length === 0) return evaluation({ message: "no terminal trades in window" });
  let streak = 0;
  for (const entry of merged) {
    if (entry.kind === "failure") {
      streak += 1;
    } else {
      break;
    }
  }
  const violated = streak >= rule.alertCount;
  return evaluation({
    applicable: true,
    violated,
    message: violated
      ? `${streak} consecutive failures (threshold ${rule.alertCount})`
      : `Current failure streak: ${streak}`,
    value: { streak, threshold: rule.alertCount },
  });
};

/** budget_approach: ANY matching budget rule consumed ≥ warnPct. */
export const evaluateBudgetApproach: EvaluateFn<
  Extract<StrategyAlertRule, { type: "budget_approach" }>
> = ({ tag, rule, report }) => {
  const evaluation = (over: Partial<AlertEvaluation>): AlertEvaluation => ({
    tag,
    ruleType: rule.type,
    rule,
    applicable: false,
    violated: false,
    message: "",
    value: {},
    ...over,
  });
  const budgets = report.risk?.budgets;
  if (!budgets || budgets.length === 0) {
    return evaluation({ message: "no matching budgets configured" });
  }
  const offenders: { pattern: string; pct: number; window: "lifetime" | "daily" }[] = [];
  for (const b of budgets) {
    if (b.lifetimePctUsed != null && b.lifetimePctUsed >= rule.warnPct * 100) {
      offenders.push({ pattern: b.pattern, pct: b.lifetimePctUsed, window: "lifetime" });
    }
    if (b.dailyPctUsed != null && b.dailyPctUsed >= rule.warnPct * 100) {
      offenders.push({ pattern: b.pattern, pct: b.dailyPctUsed, window: "daily" });
    }
  }
  const violated = offenders.length > 0;
  return evaluation({
    applicable: true,
    violated,
    message: violated
      ? `Budget ${offenders[0].pattern} ${offenders[0].window} consumed ${offenders[0].pct.toFixed(0)}%`
      : `All budgets below ${(rule.warnPct * 100).toFixed(0)}%`,
    value: {
      offenderCount: offenders.length,
      // For the FIRST offender we record full detail; others are
      // implicit (the operator can run `strategies list --budget` if
      // multiple rules trip simultaneously).
      firstOffenderPattern: offenders[0]?.pattern ?? null,
      firstOffenderPct: offenders[0]?.pct ?? null,
      firstOffenderWindow: offenders[0]?.window ?? null,
    },
  });
};

/** drawdown_threshold: per-strategy drawdown_pct ≥ alertPct. */
export const evaluateDrawdownThreshold: EvaluateFn<
  Extract<StrategyAlertRule, { type: "drawdown_threshold" }>
> = ({ tag, rule, report }) => {
  const evaluation = (over: Partial<AlertEvaluation>): AlertEvaluation => ({
    tag,
    ruleType: rule.type,
    rule,
    applicable: false,
    violated: false,
    message: "",
    value: {},
    ...over,
  });
  const dd = report.risk?.drawdown;
  if (!dd) return evaluation({ message: "no per-strategy drawdown state" });
  if (dd.drawdownPct == null) return evaluation({ message: "drawdown not yet computed (no last_value)" });
  const violated = dd.drawdownPct >= rule.alertPct;
  return evaluation({
    applicable: true,
    violated,
    message: violated
      ? `Drawdown ${dd.drawdownPct.toFixed(2)}% ≥ ${rule.alertPct}%`
      : `Drawdown ${dd.drawdownPct.toFixed(2)}%`,
    value: {
      drawdownPct: dd.drawdownPct,
      thresholdPct: rule.alertPct,
      peakUsd: dd.peakUsd,
      lastValueUsd: dd.lastValueUsd,
    },
  });
};

/** trigger_proximity: any active order's |distance_to_trigger| ≤
 *  alertDistancePct. Requires the forward section + live prices. */
export const evaluateTriggerProximity: EvaluateFn<
  Extract<StrategyAlertRule, { type: "trigger_proximity" }>
> = ({ tag, rule, report }) => {
  const evaluation = (over: Partial<AlertEvaluation>): AlertEvaluation => ({
    tag,
    ruleType: rule.type,
    rule,
    applicable: false,
    violated: false,
    message: "",
    value: {},
    ...over,
  });
  const forward = report.forward;
  if (!forward) return evaluation({ message: "forward section missing" });
  if (forward.pendingTriggers.length === 0) {
    return evaluation({ message: "no active pending orders" });
  }
  // Find the closest. Distance must be present (live price was
  // available); rule is inapplicable if no order has a distance.
  let closest: { orderId: number; distancePct: number } | null = null;
  for (const t of forward.pendingTriggers) {
    if (t.distancePct == null) continue;
    const abs = Math.abs(t.distancePct);
    if (!closest || abs < Math.abs(closest.distancePct)) {
      closest = { orderId: t.orderId, distancePct: t.distancePct };
    }
  }
  if (!closest) return evaluation({ message: "no live prices for pending orders" });
  const absClosest = Math.abs(closest.distancePct);
  const violated = absClosest <= rule.alertDistancePct;
  return evaluation({
    applicable: true,
    violated,
    message: violated
      ? `Order #${closest.orderId} within ${absClosest.toFixed(2)}% of firing`
      : `Closest order #${closest.orderId} at ${absClosest.toFixed(2)}% from firing`,
    value: {
      orderId: closest.orderId,
      distancePct: closest.distancePct,
      thresholdPct: rule.alertDistancePct,
    },
  });
};

// Dispatch table — narrowed by the rule.type discriminator at each
// call site. The `as never` casts are safe given the discriminated-
// union guarantee that `rule.type` matches the evaluator's expected
// rule shape.
/** v29 follow-up: rebalance drift proximity. Reads the forward
 *  section's persisted drift telemetry (no oracle call — the engine
 *  measured the drift on its last evaluation). Violated when ANY
 *  owned live plan's last drift reaches ≥ alertPctOfThreshold percent
 *  OF ITS OWN THRESHOLD; ≥100 means the next evaluation would fire.
 *  Gives operators the "rebalance is about to trade" heads-up the
 *  trigger_proximity rule gives for orders. */
export const evaluateDriftProximity: EvaluateFn<
  Extract<StrategyAlertRule, { type: "drift_proximity" }>
> = ({ tag, rule, report }) => {
  const evaluation = (over: Partial<AlertEvaluation>): AlertEvaluation => ({
    tag,
    ruleType: rule.type,
    rule,
    applicable: false,
    violated: false,
    message: "",
    value: {},
    ...over,
  });
  const forward = report.forward;
  if (!forward) return evaluation({ message: "forward section missing" });
  if (forward.rebalanceDrift.length === 0) {
    return evaluation({ message: "no live rebalance plans" });
  }
  let hottest: { planId: number; pct: number; drift: number; threshold: number } | null = null;
  for (const d of forward.rebalanceDrift) {
    if (d.pctOfThreshold == null || d.lastDriftPct == null) continue;
    if (!hottest || d.pctOfThreshold > hottest.pct) {
      hottest = { planId: d.planId, pct: d.pctOfThreshold, drift: d.lastDriftPct, threshold: d.thresholdPct };
    }
  }
  if (!hottest) return evaluation({ message: "no plan has been evaluated yet" });
  const violated = hottest.pct >= rule.alertPctOfThreshold;
  return evaluation({
    applicable: true,
    violated,
    message: violated
      ? `Plan #${hottest.planId} drift ${hottest.drift.toFixed(2)}% is at ${hottest.pct.toFixed(0)}% of its ${hottest.threshold}% threshold`
      : `hottest plan #${hottest.planId} at ${hottest.pct.toFixed(0)}% of threshold (< ${rule.alertPctOfThreshold}%)`,
    value: {
      planId: hottest.planId,
      lastDriftPct: hottest.drift,
      thresholdPct: hottest.threshold,
      pctOfThreshold: hottest.pct,
    },
  });
};

const EVALUATORS = {
  staleness: evaluateStaleness,
  slippage_trend: evaluateSlippageTrend,
  success_rate_drop: evaluateSuccessRateDrop,
  failure_streak: evaluateFailureStreak,
  budget_approach: evaluateBudgetApproach,
  drawdown_threshold: evaluateDrawdownThreshold,
  trigger_proximity: evaluateTriggerProximity,
  drift_proximity: evaluateDriftProximity,
} as const;

/** Evaluate every applicable rule against a single strategy's
 *  report. Exported for testing. */
export function evaluateAllRules(args: {
  tag: string;
  rules: StrategyAlertRule[];
  report: StrategyReport;
  now: Date;
}): AlertEvaluation[] {
  const results: AlertEvaluation[] = [];
  for (const rule of args.rules) {
    if (!ruleAppliesToTag(rule, args.tag)) continue;
    const evaluator = EVALUATORS[rule.type] as EvaluateFn<typeof rule>;
    results.push(evaluator({ tag: args.tag, rule, report: args.report, now: args.now }));
  }
  return results;
}

// ── reconciler ──────────────────────────────────────────────

/** Diff each evaluation against the prior DB state. Pure — returns
 *  the classification + any state-row writes the caller should
 *  apply. Exported for testing. */
export function reconcileAlertState(args: {
  evaluations: AlertEvaluation[];
  stateLookup: (tag: string, ruleType: string) => StrategyAlertStateRow | null;
  now: Date;
}): AlertTransition[] {
  const transitions: AlertTransition[] = [];
  for (const ev of args.evaluations) {
    const prev = args.stateLookup(ev.tag, ev.ruleType);
    if (!ev.applicable) {
      transitions.push({ kind: "skip", evaluation: ev });
      continue;
    }
    if (ev.violated) {
      if (prev && prev.active === 1) {
        transitions.push({ kind: "still_active", evaluation: ev, previousState: prev });
      } else {
        transitions.push({ kind: "fire", evaluation: ev, previousState: prev });
      }
    } else {
      if (prev && prev.active === 1) {
        transitions.push({ kind: "resolve", evaluation: ev, previousState: prev });
      } else {
        transitions.push({ kind: "still_ok", evaluation: ev, previousState: prev });
      }
    }
  }
  return transitions;
}

// ── notification rendering ──────────────────────────────────

function buildFireNotification(args: {
  ev: AlertEvaluation;
  eventPrefix: string;
  displayName: string;
}): NotificationEvent {
  const { ev, eventPrefix, displayName } = args;
  const severity = SEVERITY_BY_RULE[ev.ruleType];
  // Flatten value into the fields. Notification fields accept
  // string|number|boolean|null|undefined — coerce arrays/objects
  // through JSON.stringify (rule value payloads are flat by design
  // but defensive).
  const flatFields: Record<string, string | number | boolean | null | undefined> = {
    tag: ev.tag,
    rule: ev.ruleType,
  };
  for (const [k, v] of Object.entries(ev.value)) {
    if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      flatFields[k] = v;
    } else {
      flatFields[k] = JSON.stringify(v);
    }
  }
  if (ev.rule.note) flatFields.note = ev.rule.note;
  return {
    event: `${eventPrefix}.${ev.ruleType}`,
    severity,
    title: `Strategy alert: ${displayName} — ${ev.message}`,
    body: ev.rule.note,
    fields: flatFields,
    dedupKey: `${eventPrefix}.${ev.ruleType}:${ev.tag}`,
  };
}

function buildResolveNotification(args: {
  ev: AlertEvaluation;
  eventPrefix: string;
  displayName: string;
  firstTriggeredAt: string | null;
  now: Date;
}): NotificationEvent {
  const { ev, eventPrefix, displayName, firstTriggeredAt, now } = args;
  let durationSec: number | null = null;
  if (firstTriggeredAt) {
    const t = Date.parse(firstTriggeredAt);
    if (Number.isFinite(t)) durationSec = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  }
  return {
    event: `${eventPrefix}.resolved.${ev.ruleType}`,
    severity: "info",
    title: `Strategy alert resolved: ${displayName} — ${ev.ruleType}`,
    body: durationSec != null ? `Was alerting for ${Math.floor(durationSec / 60)}m.` : undefined,
    fields: {
      tag: ev.tag,
      rule: ev.ruleType,
      durationSeconds: durationSec,
      ...ev.value,
    },
    dedupKey: `${eventPrefix}.resolved.${ev.ruleType}:${ev.tag}:${firstTriggeredAt ?? "?"}`,
  };
}

/** Per-rule severity. Operators wanting to override globally can
 *  use channel minSeverity to filter. */
const SEVERITY_BY_RULE: Record<StrategyAlertRule["type"], NotificationEvent["severity"]> = {
  staleness: "warn",
  slippage_trend: "warn",
  success_rate_drop: "warn",
  failure_streak: "critical",
  budget_approach: "warn",
  drawdown_threshold: "critical",
  trigger_proximity: "info",
  drift_proximity: "info",
};

// ── runner ──────────────────────────────────────────────────

export interface RunAlertTickArgs {
  config: Config;
  logger: Logger;
  /** When set, restrict evaluation to this tag list (otherwise
   *  every deployed strategy is scanned). Useful for the CLI's
   *  `strategy alerts run --tag X` mode. */
  onlyTags?: string[];
  /** Inject for tests / for runs that want to skip the actual
   *  notify network call. Defaults to tryNotify. */
  notifyFn?: typeof tryNotify;
  /** Inject "now" — defaults to new Date(). */
  nowFn?: () => Date;
  /** Inject the report builder — defaults to the real
   *  buildStrategyReport. Tests override to skip the live price
   *  lookup. */
  reportBuilder?: typeof buildStrategyReport;
}

/** Enumerate every distinct strategy tag visible to the engine.
 *  Sources are merged: distinct trades.strategy + active
 *  orders.strategy + active schedules.strategy + active
 *  rebalance_plans.strategy. Pure-DB read. */
export function enumerateActiveTags(): string[] {
  const seen = new Set<string>();
  for (const row of listDistinctStrategies({})) {
    if (row.strategy) seen.add(row.strategy);
  }
  for (const o of listOrders({})) {
    if (o.status === "active" && o.strategy) seen.add(o.strategy);
  }
  for (const s of listSchedules({})) {
    if (s.status === "active" && s.strategy) seen.add(s.strategy);
  }
  for (const r of listRebalancePlans({})) {
    if (r.status === "active" && r.strategy) seen.add(r.strategy);
  }
  return Array.from(seen).sort();
}

/** End-to-end alert tick: enumerate strategies, build cheap
 *  reports (only sections the configured rules actually need),
 *  evaluate, reconcile, notify, persist. Returns a typed report
 *  for the CLI / tests. */
export async function runAlertTick(args: RunAlertTickArgs): Promise<AlertTickReport> {
  const startedAt = new Date();
  const now = (args.nowFn ?? (() => new Date()))();
  const cfg = args.config.safety.strategyAlerts;
  const evaluations: AlertEvaluation[] = [];
  const transitions: AlertTransition[] = [];
  const report: AlertTickReport = {
    startedAt: startedAt.toISOString(),
    evaluations,
    transitions,
    fired: 0,
    resolved: 0,
    stillActive: 0,
    skipped: 0,
  };

  if (!cfg || !cfg.enabled || cfg.rules.length === 0) {
    args.logger.debug("strategyAlerts: disabled or no rules configured; skipping tick");
    return report;
  }

  // Determine which sections each configured rule needs. Allows
  // building cheaper reports — e.g. if only trigger_proximity is
  // configured we don't need to compute slippage stats.
  const sectionsNeeded = sectionsForRules(cfg.rules);

  const tags = args.onlyTags && args.onlyTags.length > 0 ? args.onlyTags : enumerateActiveTags();
  const buildReport = args.reportBuilder ?? buildStrategyReport;

  for (const tag of tags) {
    // Pre-filter: skip when no rule appliesTo matches this tag.
    const applicableRules = cfg.rules.filter((r) => ruleAppliesToTag(r, tag));
    if (applicableRules.length === 0) continue;
    // Determine sections required by JUST the applicable rules
    // (rules that don't apply to this tag don't influence section
    // choice).
    const sections = sectionsForRules(applicableRules);
    let strategyReport: StrategyReport;
    try {
      strategyReport = await buildReport({
        tag,
        window: "30d",
        mode: "auto",
        sections: Array.from(sections),
        nowFn: () => now,
        config: args.config,
      });
    } catch (e) {
      args.logger.warn(`strategyAlerts: report build failed for ${tag}: ${(e as Error).message}`);
      continue;
    }
    const tagEvaluations = evaluateAllRules({
      tag,
      rules: applicableRules,
      report: strategyReport,
      now,
    });
    evaluations.push(...tagEvaluations);

    const tagTransitions = reconcileAlertState({
      evaluations: tagEvaluations,
      stateLookup: getStrategyAlertState,
      now,
    });
    transitions.push(...tagTransitions);

    // Per-transition action: emit notification + write state row.
    for (const t of tagTransitions) {
      const ev = t.evaluation;
      const lastValueJson = ev.applicable ? JSON.stringify(ev.value) : null;
      const lastEvaluatedAt = now.toISOString();
      switch (t.kind) {
        case "fire": {
          report.fired += 1;
          const displayName = strategyReport.identity?.displayName ?? tag;
          const notification = buildFireNotification({
            ev,
            eventPrefix: cfg.eventPrefix,
            displayName,
          });
          const notify = args.notifyFn ?? tryNotify;
          await notify(notification, args.config, args.logger);
          upsertStrategyAlertState({
            tag,
            ruleType: ev.ruleType,
            active: true,
            firstTriggeredAt: lastEvaluatedAt,
            lastEvaluatedAt,
            lastValueJson,
          });
          // v28: durable transition journal — the timeline reads this
          // instead of reconstructing fires from the state row. Best-
          // effort: a journal hiccup must not break the alert tick
          // (the notification + state write above are the contract).
          try {
            insertAlertEvent({
              at: lastEvaluatedAt,
              tag,
              ruleType: ev.ruleType,
              event: "fired",
              severity: notification.severity,
              message: ev.message,
              valueJson: lastValueJson,
            });
          } catch (e) {
            args.logger.debug(`alert_events journal write failed (fired ${tag}/${ev.ruleType}): ${(e as Error).message}`);
          }
          break;
        }
        case "resolve": {
          report.resolved += 1;
          const displayName = strategyReport.identity?.displayName ?? tag;
          const notification = buildResolveNotification({
            ev,
            eventPrefix: cfg.eventPrefix,
            displayName,
            firstTriggeredAt: t.previousState.first_triggered_at,
            now,
          });
          const notify = args.notifyFn ?? tryNotify;
          await notify(notification, args.config, args.logger);
          upsertStrategyAlertState({
            tag,
            ruleType: ev.ruleType,
            active: false,
            firstTriggeredAt: null,
            lastEvaluatedAt,
            lastValueJson,
          });
          // v28: durable transition journal (see the fire branch).
          // duration mirrors the notification's durationSeconds field.
          try {
            const ft = t.previousState.first_triggered_at;
            const ftMs = ft ? Date.parse(ft) : NaN;
            insertAlertEvent({
              at: lastEvaluatedAt,
              tag,
              ruleType: ev.ruleType,
              event: "resolved",
              severity: "info",
              message: ev.message,
              valueJson: lastValueJson,
              durationSeconds: Number.isFinite(ftMs) ? Math.max(0, Math.floor((now.getTime() - ftMs) / 1000)) : null,
            });
          } catch (e) {
            args.logger.debug(`alert_events journal write failed (resolved ${tag}/${ev.ruleType}): ${(e as Error).message}`);
          }
          break;
        }
        case "still_active": {
          report.stillActive += 1;
          // Refresh lastEvaluatedAt + last_value_json so the CLI can
          // see the watcher is still touching this row.
          upsertStrategyAlertState({
            tag,
            ruleType: ev.ruleType,
            active: true,
            firstTriggeredAt: t.previousState.first_triggered_at,
            lastEvaluatedAt,
            lastValueJson,
          });
          break;
        }
        case "still_ok": {
          // Touch last_evaluated_at + value so operators can see the
          // rule was evaluated. Don't overwrite a missing prior row
          // (would create noise in the listing).
          if (t.previousState) {
            upsertStrategyAlertState({
              tag,
              ruleType: ev.ruleType,
              active: false,
              firstTriggeredAt: null,
              lastEvaluatedAt,
              lastValueJson,
            });
          }
          break;
        }
        case "skip": {
          report.skipped += 1;
          break;
        }
      }
    }
  }

  return report;
}

/** Determine which report sections are needed to evaluate a given
 *  rule set. Exported for testing. */
export function sectionsForRules(rules: StrategyAlertRule[]) {
  const needed = new Set<"identity" | "composition" | "performance" | "position" | "risk" | "activity" | "forward">();
  // Always include identity for the displayName in notifications.
  needed.add("identity");
  for (const rule of rules) {
    switch (rule.type) {
      case "staleness":
        needed.add("activity");
        needed.add("composition");
        break;
      case "slippage_trend":
      case "success_rate_drop":
        needed.add("performance");
        break;
      case "failure_streak":
        needed.add("activity");
        break;
      case "budget_approach":
      case "drawdown_threshold":
        needed.add("risk");
        break;
      case "trigger_proximity":
      case "drift_proximity":
        needed.add("forward");
        break;
    }
  }
  return needed;
}

// ── re-exports for unused-warning suppression in tests ──────

export type { TradeRow, PaperTradeRow };

// Keep the lookup helpers re-exportable so tests can mock w/o
// importing from db.js directly.
export { listStrategyAlertStates, recentTrades, listPaperTrades };
