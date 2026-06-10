/**
 * Operational status dashboard — `tradekit status`.
 *
 * Composes the engine's live state across every subsystem into ONE
 * situational-awareness view. Pre-iter23 an operator wanting to know
 * "is everything OK?" had to run nine separate commands:
 *
 *   tradekit engine status   (worker heartbeats)
 *   tradekit order list      (active orders)
 *   tradekit schedule list   (active schedules)
 *   tradekit rebalance list  (active plans)
 *   tradekit playbook list   (deployed playbooks)
 *   tradekit safety drawdown (breaker state)
 *   tradekit strategies --budget  (budget consumption)
 *   tradekit pending         (stuck txs)
 *   tradekit audit           (recent errors)
 *
 * …and assemble the picture mentally. This module gathers all that
 * data with a single in-process composer, separates rendering, and
 * surfaces a structured `StatusReport` the CLI renders as text or
 * JSON.
 *
 * Different from `tradekit health` — health is a FINANCIAL summary
 * (portfolio + 7d PnL + approvals + recommendations). Status is an
 * OPERATIONAL view ("what is the engine doing RIGHT NOW + what's
 * near-trigger + what's near-tripping the safety stack").
 *
 * Performance: ~10 indexed DB queries + 1 status-file read.
 * Sub-100ms on a typical install. Zero RPC (every "current price"
 * shown is the stored last_checked_price from the orders engine —
 * the price observed on the engine's most recent tick).
 */

import {
  readEngineStatus,
  type EngineStatus,
  type EngineWorkerStatus,
  tickStalenessSeconds,
} from "./engine.js";
import {
  listOrders,
  orderCountsByStatus,
  listSchedules,
  scheduleCountsByStatus,
  listRebalancePlans,
  rebalancePlanCountsByStatus,
  listPlaybooks,
  playbookCountsByStatus,
  listDrawdownStates,
  getEngineLock,
  auditSummary,
  listStrategyAlertStates,
  listAlertEvents,
  listPaperBalances,
  listPaperTrades,
  type OrderRow,
  type ScheduleRow,
  type RebalanceRow,
  type PlaybookRow,
  type DrawdownStateRow,
  type AuditSummary,
} from "./db.js";
import { computeBudgetConsumption, type BudgetConsumption, type BudgetRule } from "./strategyBudget.js";
import { loadConfig, type Config } from "./config.js";

// ── output shape ─────────────────────────────────────────────

export type SectionName =
  | "engine"
  | "orders"
  | "schedules"
  | "rebalance"
  | "playbooks"
  | "drawdown"
  | "budgets"
  | "activity"
  | "alerts"
  | "paper";

export const ALL_SECTIONS: SectionName[] = [
  "engine",
  "orders",
  "schedules",
  "rebalance",
  "playbooks",
  "drawdown",
  "budgets",
  "activity",
  "alerts",
  "paper",
];

export interface EngineSection {
  /** Set when the engine has never run / status file absent. */
  notStarted: boolean;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  stopping: boolean | null;
  workers: Array<{
    name: string;
    enabled: boolean;
    intervalMs: number;
    lastTickAt: string | null;
    lastTickAgeSec: number | null;
    /** "ok" when fresh, "warn" when within 2× interval, "stale" beyond. */
    health: "ok" | "warn" | "stale" | "never-ticked";
    successes: number;
    failures: number;
    lastError: string | null;
  }>;
  /** Iter28: global kill switch state. When `locked=true`, ALL
   *  trading paths are blocked. */
  lock: {
    locked: boolean;
    reason: string | null;
    lockedAt: string | null;
    lockedBy: string | null;
  };
}

export interface NearTriggerOrder {
  id: number;
  side: "buy" | "sell";
  base: string | null;
  quote: string | null;
  triggerType: string;
  /** Human-readable trigger label: "price_above $3000" / "trailing 5% (HWM $2980)". */
  triggerLabel: string;
  /** Last observed USD price (from the engine's most recent tick). */
  lastPriceUsd: number | null;
  /** Computed threshold the price must reach to fire. NULL for trailing
   *  orders that haven't been activated yet (no water mark). */
  thresholdUsd: number | null;
  /** Percent the price needs to move to fire. Positive = needs to
   *  move in the firing direction. NULL when unknown. */
  pctToFire: number | null;
  /** ISO timestamp of the most recent engine check. */
  lastCheckedAt: string | null;
  /** True iff lastCheckedAt is older than 1 hour — engine likely not running. */
  staleCheck: boolean;
}

export interface OrdersSection {
  counts: { active: number; filled: number; cancelled: number; expired: number; failed: number };
  /** Top 5 active orders by proximity to firing. Excludes orders with
   *  no usable price data (last_checked_price null / trailing pre-
   *  activation). */
  nearTrigger: NearTriggerOrder[];
}

export interface SchedulesSection {
  counts: { active: number; paused: number; completed: number; cancelled: number };
  /** Top 5 active schedules by next-fire-time soonest. */
  nextFires: Array<{
    id: number;
    name: string | null;
    side: "buy" | "sell";
    base: string | null;
    quote: string | null;
    cron: string;
    nextRunAt: string;
    /** Seconds until next run. Negative = overdue (engine not firing). */
    secondsUntilFire: number;
    runCount: number;
    maxRuns: number | null;
  }>;
}

export interface RebalanceSection {
  counts: { active: number; paused: number; completed: number; cancelled: number };
  plans: Array<{
    id: number;
    name: string | null;
    chain: string;
    cron: string;
    driftThresholdPct: number;
    nextRunAt: string;
    secondsUntilEval: number;
    runCount: number;
    lastResultSummary: string | null;
  }>;
}

export interface PlaybooksSection {
  counts: { deploying: number; deployed: number; destroyed: number; failed: number };
  recent: Array<{
    id: number;
    name: string;
    status: string;
    deployedAt: string;
    destroyedAt: string | null;
  }>;
}

export interface DrawdownSection {
  configured: boolean;
  enabled: boolean;
  maxDrawdownPct: number | null;
  autoResumeAtPct: number | null;
  states: Array<{
    scope: string;
    peakUsd: number;
    peakAt: string;
    lastValueUsd: number | null;
    drawdownPct: number | null;
    tripped: boolean;
    trippedAt: string | null;
  }>;
}

export interface BudgetsSection {
  configured: boolean;
  rules: BudgetConsumption[];
}

export interface ActivitySection {
  /** Audit summary over the last 24h. */
  summary: AuditSummary;
  /** Top 5 error codes by count. */
  topErrors: Array<{ code: string; count: number; lastSeen: string }>;
}

/** v28/v30: currently-firing strategy alerts + the most recent
 *  transitions. The "right now" complement to digest's windowed
 *  alert counts — an operator opening the dashboard wants "is
 *  anything alerting?" before anything else. */
export interface AlertsStatusSection {
  activeCount: number;
  active: Array<{
    tag: string;
    ruleType: string;
    firstTriggeredAt: string | null;
    lastValueJson: string | null;
  }>;
  /** Last 5 transitions from the v28 journal (24h). */
  recentTransitions: Array<{
    at: string;
    tag: string;
    ruleType: string;
    event: "fired" | "resolved" | "breaker_paused";
  }>;
}

/** Paper-trading snapshot: book size + live paper primitives +
 *  24h fill activity. Dry-run strategies were invisible on the
 *  dashboard before this. */
export interface PaperStatusSection {
  balanceRows: number;
  /** Distinct (account, chain) book scopes. */
  bookScopes: number;
  /** ACTIVE primitives flagged paper=1, by type. */
  activePaper: { orders: number; schedules: number; rebalances: number };
  fills24h: number;
}

export interface StatusReport {
  /** When the composer ran. */
  generatedAt: string;
  engine: EngineSection;
  orders: OrdersSection;
  schedules: SchedulesSection;
  rebalance: RebalanceSection;
  playbooks: PlaybooksSection;
  drawdown: DrawdownSection;
  budgets: BudgetsSection;
  activity: ActivitySection;
  alerts: AlertsStatusSection;
  paper: PaperStatusSection;
}

// ── orchestrator ─────────────────────────────────────────────

/**
 * Compose the full status report. Pure read-side aggregation — no DB
 * writes, no RPC. Each per-section gather is independent; one
 * section's failure doesn't block the rest (each is wrapped in
 * try/catch internally for robustness, though in practice indexed
 * DB queries don't fail).
 *
 * `now` is injectable for deterministic tests.
 */
export function gatherStatusReport(opts: {
  config?: Config;
  now?: Date;
  /** Optional section filter — when set, only the named sections are
   *  populated; others have empty/skipped values. The composer still
   *  builds the full shape so the rendering layer doesn't need a
   *  parallel "what's present" map. */
  sections?: SectionName[];
} = {}): StatusReport {
  const now = opts.now ?? new Date();
  const config = opts.config ?? loadConfig();
  const wanted = new Set<SectionName>(opts.sections ?? ALL_SECTIONS);

  return {
    generatedAt: now.toISOString(),
    engine: wanted.has("engine") ? gatherEngine(now) : emptyEngine(),
    orders: wanted.has("orders") ? gatherOrders(now) : emptyOrders(),
    schedules: wanted.has("schedules") ? gatherSchedules(now) : emptySchedules(),
    rebalance: wanted.has("rebalance") ? gatherRebalance(now) : emptyRebalance(),
    playbooks: wanted.has("playbooks") ? gatherPlaybooks() : emptyPlaybooks(),
    drawdown: wanted.has("drawdown") ? gatherDrawdown(config) : emptyDrawdown(),
    budgets: wanted.has("budgets") ? gatherBudgets(config) : emptyBudgets(),
    activity: wanted.has("activity") ? gatherActivity(now) : emptyActivity(),
    alerts: wanted.has("alerts") ? gatherAlertsStatus(now) : emptyAlertsStatus(),
    paper: wanted.has("paper") ? gatherPaperStatus(now) : emptyPaperStatus(),
  };
}

// ── alerts (v30) ─────────────────────────────────────────────

function gatherAlertsStatus(now: Date): AlertsStatusSection {
  try {
    const active = listStrategyAlertStates({ active: true });
    const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const recent = listAlertEvents({ sinceIso: since, limit: 5 });
    return {
      activeCount: active.length,
      active: active.map((a) => ({
        tag: a.tag,
        ruleType: a.rule_type,
        firstTriggeredAt: a.first_triggered_at,
        lastValueJson: a.last_value_json,
      })),
      recentTransitions: recent.map((e) => ({
        at: e.at,
        tag: e.tag,
        ruleType: e.rule_type,
        event: e.event,
      })),
    };
  } catch {
    return emptyAlertsStatus();
  }
}

function emptyAlertsStatus(): AlertsStatusSection {
  return { activeCount: 0, active: [], recentTransitions: [] };
}

// ── paper (v30) ──────────────────────────────────────────────

function gatherPaperStatus(now: Date): PaperStatusSection {
  try {
    const balances = listPaperBalances({});
    const scopes = new Set(balances.map((b) => `${b.account}:${b.chain}`));
    const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const fills24h = listPaperTrades({ sinceIso: since, limit: 5000 }).length;
    const activePaper = {
      orders: listOrders({ status: "active" }).filter((o) => (o.paper ?? 0) === 1).length,
      schedules: listSchedules({ status: "active" }).filter((sc) => (sc.paper ?? 0) === 1).length,
      rebalances: listRebalancePlans({ status: "active" }).filter((r) => (r.paper ?? 0) === 1).length,
    };
    return { balanceRows: balances.length, bookScopes: scopes.size, activePaper, fills24h };
  } catch {
    return emptyPaperStatus();
  }
}

function emptyPaperStatus(): PaperStatusSection {
  return { balanceRows: 0, bookScopes: 0, activePaper: { orders: 0, schedules: 0, rebalances: 0 }, fills24h: 0 };
}

// ── engine ───────────────────────────────────────────────────

function gatherEngine(now: Date): EngineSection {
  const lockRow = getEngineLock();
  const lockSummary = {
    locked: lockRow.active === 1,
    reason: lockRow.reason,
    lockedAt: lockRow.locked_at,
    lockedBy: lockRow.locked_by,
  };
  const status = readEngineStatus();
  if (!status) {
    return {
      notStarted: true,
      pid: null,
      startedAt: null,
      updatedAt: null,
      stopping: null,
      workers: [],
      lock: lockSummary,
    };
  }
  return {
    notStarted: false,
    pid: status.pid,
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    stopping: status.stopping,
    workers: status.workers.map((w) => mapWorker(w, now)),
    lock: lockSummary,
  };
}

function mapWorker(w: EngineWorkerStatus, now: Date): EngineSection["workers"][number] {
  const lastTickAgeSec = tickStalenessSeconds(w.lastTickAt, now);
  let health: "ok" | "warn" | "stale" | "never-ticked";
  if (lastTickAgeSec === null) {
    health = "never-ticked";
  } else if (lastTickAgeSec <= (w.intervalMs / 1000) * 2) {
    health = "ok";
  } else if (lastTickAgeSec <= (w.intervalMs / 1000) * 4) {
    health = "warn";
  } else {
    health = "stale";
  }
  return {
    name: w.name,
    enabled: w.enabled,
    intervalMs: w.intervalMs,
    lastTickAt: w.lastTickAt,
    lastTickAgeSec,
    health,
    successes: w.successes,
    failures: w.failures,
    lastError: w.lastError,
  };
}

function emptyEngine(): EngineSection {
  return {
    notStarted: true, pid: null, startedAt: null, updatedAt: null,
    stopping: null, workers: [],
    lock: { locked: false, reason: null, lockedAt: null, lockedBy: null },
  };
}

// ── orders + near-trigger ────────────────────────────────────

const STALE_CHECK_THRESHOLD_MS = 60 * 60 * 1000; // 1h
const NEAR_TRIGGER_LIMIT = 5;

function gatherOrders(now: Date): OrdersSection {
  const counts = orderCountsByStatus();
  // Filter to active + sort by pctToFire ascending (smallest = closest).
  const active = listOrders({ status: "active", limit: 200 });
  const candidates: NearTriggerOrder[] = [];
  for (const o of active) {
    const trig = describeOrderTrigger(o);
    const pct = computePctToFire(o);
    if (pct === null) continue; // unactivated trailing / missing price
    candidates.push({
      id: o.id!,
      side: o.side,
      base: o.base_symbol,
      quote: o.quote_symbol,
      triggerType: o.trigger_type,
      triggerLabel: trig,
      lastPriceUsd: o.last_checked_price,
      thresholdUsd: computeThreshold(o),
      pctToFire: pct,
      lastCheckedAt: o.last_checked_at,
      staleCheck: o.last_checked_at
        ? now.getTime() - Date.parse(o.last_checked_at) > STALE_CHECK_THRESHOLD_MS
        : true,
    });
  }
  candidates.sort((a, b) => (a.pctToFire ?? Infinity) - (b.pctToFire ?? Infinity));
  return {
    counts,
    nearTrigger: candidates.slice(0, NEAR_TRIGGER_LIMIT),
  };
}

/** Compute the threshold USD price at which this order would fire,
 *  given its current state (trail water mark + trail_pct OR
 *  target_price_usd). Returns null when no usable threshold exists
 *  (e.g. trailing pre-activation with no water mark). */
export function computeThreshold(order: OrderRow): number | null {
  if (order.trigger_type === "trailing") {
    if (order.water_mark_usd == null || order.trail_pct == null) return null;
    return order.side === "sell"
      ? order.water_mark_usd * (1 - order.trail_pct / 100)
      : order.water_mark_usd * (1 + order.trail_pct / 100);
  }
  return order.target_price_usd;
}

/** Percent the current price needs to move (in the firing direction)
 *  to trigger. Convention: always positive when the price still needs
 *  to move; null when the order can't be evaluated (no last_checked
 *  price, no threshold). */
export function computePctToFire(order: OrderRow): number | null {
  const threshold = computeThreshold(order);
  if (threshold == null) return null;
  const current = order.last_checked_price;
  if (current == null || !Number.isFinite(current) || current <= 0) return null;
  // Determine firing direction based on trigger + side.
  let needsRise: boolean;
  if (order.trigger_type === "price_above") needsRise = true;
  else if (order.trigger_type === "price_below") needsRise = false;
  else if (order.trigger_type === "trailing") {
    // Sell-trailing fires when price DROPS past threshold; buy-trailing
    // fires when price RISES past threshold.
    needsRise = order.side === "buy";
  } else {
    return null;
  }
  if (needsRise) {
    if (current >= threshold) return 0; // already past trigger
    return ((threshold - current) / current) * 100;
  }
  if (current <= threshold) return 0; // already past trigger
  return ((current - threshold) / current) * 100;
}

function describeOrderTrigger(order: OrderRow): string {
  if (order.trigger_type === "trailing") {
    const trail = order.trail_pct != null ? `${order.trail_pct}%` : "?%";
    if (order.water_mark_usd != null) {
      return `trailing ${trail} (HWM $${order.water_mark_usd.toFixed(2)})`;
    }
    if (order.target_price_usd != null) {
      return `trailing ${trail} (activation $${order.target_price_usd.toFixed(2)})`;
    }
    return `trailing ${trail}`;
  }
  const t = order.target_price_usd != null ? order.target_price_usd.toFixed(2) : "?";
  return `${order.trigger_type} $${t}`;
}

function emptyOrders(): OrdersSection {
  return {
    counts: { active: 0, filled: 0, cancelled: 0, expired: 0, failed: 0 },
    nearTrigger: [],
  };
}

// ── schedules ────────────────────────────────────────────────

function gatherSchedules(now: Date): SchedulesSection {
  const counts = scheduleCountsByStatus();
  const active = listSchedules({ status: "active", limit: 200 });
  const sorted = active
    .map((s): SchedulesSection["nextFires"][number] => ({
      id: s.id!,
      name: s.name,
      side: s.side,
      base: s.base_symbol,
      quote: s.quote_symbol,
      cron: s.cron_expr,
      nextRunAt: s.next_run_at,
      secondsUntilFire: Math.floor((Date.parse(s.next_run_at) - now.getTime()) / 1000),
      runCount: s.run_count,
      maxRuns: s.max_runs,
    }))
    .sort((a, b) => a.secondsUntilFire - b.secondsUntilFire);
  return {
    counts,
    nextFires: sorted.slice(0, 5),
  };
}

function emptySchedules(): SchedulesSection {
  return {
    counts: { active: 0, paused: 0, completed: 0, cancelled: 0 },
    nextFires: [],
  };
}

// ── rebalance ────────────────────────────────────────────────

function gatherRebalance(now: Date): RebalanceSection {
  const counts = rebalancePlanCountsByStatus();
  const active = listRebalancePlans({ status: "active", limit: 200 });
  return {
    counts,
    plans: active.map((p): RebalanceSection["plans"][number] => ({
      id: p.id!,
      name: p.name,
      chain: p.chain,
      cron: p.cron_expr,
      driftThresholdPct: p.drift_threshold_pct,
      nextRunAt: p.next_run_at,
      secondsUntilEval: Math.floor((Date.parse(p.next_run_at) - now.getTime()) / 1000),
      runCount: p.run_count,
      lastResultSummary: summarizeRebalanceLastRun(p),
    })),
  };
}

function summarizeRebalanceLastRun(p: RebalanceRow): string | null {
  if (p.last_run_at == null) return null;
  if (p.last_error_code) return `last run errored: ${p.last_error_code}`;
  const drift = p.last_run_max_drift_pct != null ? `${p.last_run_max_drift_pct.toFixed(2)}%` : "?";
  const legs = p.last_run_executed_count != null ? `${p.last_run_executed_count} legs` : "0 legs";
  return `last drift ${drift}, ${legs}`;
}

function emptyRebalance(): RebalanceSection {
  return { counts: { active: 0, paused: 0, completed: 0, cancelled: 0 }, plans: [] };
}

// ── playbooks ────────────────────────────────────────────────

function gatherPlaybooks(): PlaybooksSection {
  const counts = playbookCountsByStatus();
  const recent = listPlaybooks({ limit: 5 });
  return {
    counts,
    recent: recent.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      deployedAt: r.deployed_at,
      destroyedAt: r.destroyed_at,
    })),
  };
}

function emptyPlaybooks(): PlaybooksSection {
  return {
    counts: { deploying: 0, deployed: 0, destroyed: 0, failed: 0 },
    recent: [],
  };
}

// ── drawdown breaker ─────────────────────────────────────────

function gatherDrawdown(config: Config): DrawdownSection {
  const cfg = config.safety.drawdownCircuitBreaker;
  const states = listDrawdownStates();
  return {
    configured: cfg != null,
    enabled: cfg?.enabled ?? false,
    maxDrawdownPct: cfg?.maxDrawdownPct ?? null,
    autoResumeAtPct: cfg?.autoResumeAtPct ?? null,
    states: states.map((s) => hydrateDrawdownState(s)),
  };
}

function hydrateDrawdownState(s: DrawdownStateRow): DrawdownSection["states"][number] {
  const drawdownPct =
    s.last_value_usd != null && s.peak_usd > 0
      ? ((s.peak_usd - s.last_value_usd) / s.peak_usd) * 100
      : null;
  return {
    scope: s.scope_key,
    peakUsd: s.peak_usd,
    peakAt: s.peak_at,
    lastValueUsd: s.last_value_usd,
    drawdownPct,
    tripped: s.tripped_at != null,
    trippedAt: s.tripped_at,
  };
}

function emptyDrawdown(): DrawdownSection {
  return {
    configured: false,
    enabled: false,
    maxDrawdownPct: null,
    autoResumeAtPct: null,
    states: [],
  };
}

// ── strategy budgets ─────────────────────────────────────────

function gatherBudgets(config: Config): BudgetsSection {
  const rules: BudgetRule[] = config.safety.strategyBudgets ?? [];
  if (rules.length === 0) {
    return { configured: false, rules: [] };
  }
  return {
    configured: true,
    rules: computeBudgetConsumption({ budgets: rules }),
  };
}

function emptyBudgets(): BudgetsSection {
  return { configured: false, rules: [] };
}

// ── 24h activity ─────────────────────────────────────────────

function gatherActivity(now: Date): ActivitySection {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const summary = auditSummary({ since });
  const topErrors = summary.byErrorCode.slice(0, 5).map((e) => ({
    code: e.errorCode,
    count: e.count,
    lastSeen: e.lastSeen,
  }));
  return { summary, topErrors };
}

function emptyActivity(): ActivitySection {
  return {
    summary: {
      totalRows: 0,
      errorRows: 0,
      earliest: null,
      latest: null,
      byTool: [],
      byCaller: [],
      byErrorCode: [],
      byChain: [],
      elapsedMs: 0,
      recommendedActions: [],
    },
    topErrors: [],
  };
}

// ── helpers (exported for the renderer) ──────────────────────

/** Human-readable duration in seconds → "Xs / Xm / Xh / Xd". */
export function formatDurationSeconds(secs: number): string {
  if (!Number.isFinite(secs)) return "—";
  const sign = secs < 0 ? "-" : "";
  const a = Math.abs(secs);
  if (a < 60) return `${sign}${Math.round(a)}s`;
  if (a < 3600) return `${sign}${Math.floor(a / 60)}m`;
  if (a < 86400) return `${sign}${Math.floor(a / 3600)}h ${Math.floor((a % 3600) / 60)}m`;
  return `${sign}${Math.floor(a / 86400)}d ${Math.floor((a % 86400) / 3600)}h`;
}

/** Health marker character. */
export function healthMarker(h: "ok" | "warn" | "stale" | "never-ticked"): string {
  switch (h) {
    case "ok": return "●";
    case "warn": return "◐";
    case "stale": return "✕";
    case "never-ticked": return "○";
  }
}
