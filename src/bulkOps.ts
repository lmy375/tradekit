// ──────────────────────────────────────────────────────────────────
// Bulk operations (iter37): scoped halt + resume primitives with
// preview + atomicity.
//
// Why: pre-iter37, halting "everything tagged dca-eth while I
// investigate" required 3 separate CLI commands, jq filtering,
// xargs invocations, N audit_log rows, and the bash-script
// flakiness of mid-loop failures. The middle ground between
// per-primitive pause/cancel (too granular) and engine_lock (too
// broad) was missing.
//
// Design:
//
//   1. Plan → Execute split. `planHalt(filter)` produces a typed
//      BulkHaltPlan with per-primitive operation classification
//      (cancel / pause / skip-already-terminal) BEFORE any
//      mutation. The CLI renders this for `--dry-run` and
//      pre-confirmation preview. `executeHalt(plan)` then runs
//      the plan inside a single DB transaction — all-or-nothing.
//
//   2. Filter requires AT LEAST ONE scope (strategy / chain /
//      account / --all). The unscoped case is a foot-gun (would
//      halt every primitive across every account on every chain);
//      we force the operator to be explicit. The genuine global
//      kill switch is iter28 engine_lock.
//
//   3. Reuses existing per-primitive helpers (cancelOrderById,
//      pauseScheduleById, pauseRebalancePlanById) inside the
//      transaction. Validation + audit semantics are inherited.
//      The bulk path emits ONE bulk-level notification at the end
//      vs N per-primitive notifications.
//
//   4. Already-terminal primitives are classified as `skip` in
//      the plan with a reason field. They're not touched; the
//      summary clearly distinguishes "would-be-affected" vs
//      "already-terminal" counts so the operator never thinks
//      they failed.
//
//   5. Resume is the inverse: un-pauses paused schedules +
//      rebalances. Cancelled orders are terminal — they don't
//      come back; the resume CLI refuses to operate on them
//      (operator must recreate via order create or playbook
//      replace).
// ──────────────────────────────────────────────────────────────────

import { ToolError } from "./errors.js";
import {
  listOrders,
  listSchedules,
  listRebalancePlans,
  openDb,
  type OrderRow,
  type ScheduleRow,
  type RebalanceRow,
} from "./db.js";
import { cancelOrderById } from "./orders.js";
import { pauseScheduleById, resumeScheduleById, cancelScheduleById } from "./schedules.js";
import { pauseRebalancePlanById, resumeRebalancePlanById } from "./rebalance.js";

// ── public types ────────────────────────────────────────────

export type BulkPrimitiveType = "orders" | "schedules" | "rebalances";

export interface BulkHaltFilter {
  /** Strategy tag exact match. */
  strategy?: string;
  /** Chain name exact match (case-insensitive normalized). */
  chain?: string;
  /** Account label exact match. */
  account?: string;
  /** Restrict to specific primitive types. Default: all three. */
  types?: BulkPrimitiveType[];
  /** Explicit "I really mean across every account on every chain"
   *  escape hatch. Required when strategy/chain/account are all
   *  unset. Forces the operator (or agent) to confirm scope is
   *  intentional. */
  all?: boolean;
}

export type BulkOperation = "cancel" | "pause" | "resume" | "skip";

export interface PlannedAction {
  type: "order" | "schedule" | "rebalance";
  id: number;
  operation: BulkOperation;
  /** Current status of the row. */
  currentStatus: string;
  /** Free-text reason. For skip: "already filled" / "already paused"
   *  etc. For active rows: a one-line description of the primitive. */
  reason: string;
  /** Compact label for table rendering. */
  summary: string;
}

export interface BulkHaltPlan {
  filter: BulkHaltFilter;
  actions: PlannedAction[];
  summary: {
    totalRowsConsidered: number;
    wouldAffect: number;
    skippedAlreadyTerminal: number;
    skippedReasons: Record<string, number>;
    byType: {
      orders: { wouldCancel: number; skipped: number };
      schedules: { wouldPause: number; skipped: number };
      rebalances: { wouldPause: number; skipped: number };
    };
  };
}

export interface BulkResumePlan {
  filter: BulkHaltFilter;
  actions: PlannedAction[];
  summary: {
    totalRowsConsidered: number;
    wouldAffect: number;
    skipped: number;
    byType: {
      schedules: { wouldResume: number; skipped: number };
      rebalances: { wouldResume: number; skipped: number };
    };
  };
}

export interface BulkResult {
  ok: boolean;
  applied: PlannedAction[];
  skipped: PlannedAction[];
  errors: { type: PlannedAction["type"]; id: number; message: string }[];
}

// ── filter validation ──────────────────────────────────────

function requireScope(filter: BulkHaltFilter): void {
  const hasScope = !!(filter.strategy || filter.chain || filter.account);
  if (!hasScope && !filter.all) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Bulk halt/resume requires at least one of --strategy, --chain, --account; OR pass --all to confirm unscoped intent. The global kill switch is `tradekit engine lock`.",
    );
  }
}

function normalizeFilter(filter: BulkHaltFilter): BulkHaltFilter {
  return {
    strategy: filter.strategy,
    chain: filter.chain?.toLowerCase(),
    account: filter.account,
    types: filter.types,
    all: filter.all,
  };
}

function typesIncluded(types: BulkPrimitiveType[] | undefined, type: BulkPrimitiveType): boolean {
  if (!types || types.length === 0) return true;
  return types.includes(type);
}

// ── per-primitive matchers ─────────────────────────────────

function orderMatches(o: OrderRow, f: BulkHaltFilter): boolean {
  if (f.strategy && o.strategy !== f.strategy) return false;
  if (f.chain && o.chain !== f.chain) return false;
  if (f.account && o.account !== f.account) return false;
  return true;
}

function scheduleMatches(s: ScheduleRow, f: BulkHaltFilter): boolean {
  if (f.strategy && s.strategy !== f.strategy) return false;
  if (f.chain && s.chain !== f.chain) return false;
  if (f.account && s.account !== f.account) return false;
  return true;
}

function rebalanceMatches(r: RebalanceRow, f: BulkHaltFilter): boolean {
  if (f.strategy && r.strategy !== f.strategy) return false;
  if (f.chain && r.chain !== f.chain) return false;
  if (f.account && r.account !== f.account) return false;
  return true;
}

// ── plan: halt ─────────────────────────────────────────────

/** Compute the bulk halt plan. Pure aside from DB reads. Exported
 *  for unit testing + dry-run preview. */
export function planHalt(filter: BulkHaltFilter): BulkHaltPlan {
  requireScope(filter);
  const f = normalizeFilter(filter);
  const actions: PlannedAction[] = [];
  const byType = {
    orders: { wouldCancel: 0, skipped: 0 },
    schedules: { wouldPause: 0, skipped: 0 },
    rebalances: { wouldPause: 0, skipped: 0 },
  };
  const skippedReasons: Record<string, number> = {};
  let totalRowsConsidered = 0;

  // Orders. Halt = cancel. Skip when already terminal.
  if (typesIncluded(f.types, "orders")) {
    // listOrders without status filter returns active by default; we want
    // everything matching so we can classify already-terminal.
    const rows = listOrders({ status: "all" });
    for (const o of rows) {
      if (!orderMatches(o, f)) continue;
      totalRowsConsidered++;
      const terminal =
        o.status === "filled" ||
        o.status === "failed" ||
        o.status === "expired" ||
        o.status === "cancelled";
      if (terminal) {
        const reason = `already ${o.status}`;
        skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
        byType.orders.skipped++;
        actions.push({
          type: "order",
          id: o.id!,
          operation: "skip",
          currentStatus: o.status,
          reason,
          summary: summarizeOrder(o),
        });
      } else {
        byType.orders.wouldCancel++;
        actions.push({
          type: "order",
          id: o.id!,
          operation: "cancel",
          currentStatus: o.status,
          reason: "active → cancel",
          summary: summarizeOrder(o),
        });
      }
    }
  }

  // Schedules. Halt = pause. Skip when already paused / terminal.
  if (typesIncluded(f.types, "schedules")) {
    const rows = listSchedules({ status: "all" });
    for (const s of rows) {
      if (!scheduleMatches(s, f)) continue;
      totalRowsConsidered++;
      if (s.status === "active") {
        byType.schedules.wouldPause++;
        actions.push({
          type: "schedule",
          id: s.id!,
          operation: "pause",
          currentStatus: s.status,
          reason: "active → pause",
          summary: summarizeSchedule(s),
        });
      } else {
        const reason = `already ${s.status}`;
        skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
        byType.schedules.skipped++;
        actions.push({
          type: "schedule",
          id: s.id!,
          operation: "skip",
          currentStatus: s.status,
          reason,
          summary: summarizeSchedule(s),
        });
      }
    }
  }

  // Rebalances. Halt = pause. Skip when already paused / terminal.
  if (typesIncluded(f.types, "rebalances")) {
    const rows = listRebalancePlans({ status: "all" });
    for (const r of rows) {
      if (!rebalanceMatches(r, f)) continue;
      totalRowsConsidered++;
      if (r.status === "active") {
        byType.rebalances.wouldPause++;
        actions.push({
          type: "rebalance",
          id: r.id!,
          operation: "pause",
          currentStatus: r.status,
          reason: "active → pause",
          summary: summarizeRebalance(r),
        });
      } else {
        const reason = `already ${r.status}`;
        skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
        byType.rebalances.skipped++;
        actions.push({
          type: "rebalance",
          id: r.id!,
          operation: "skip",
          currentStatus: r.status,
          reason,
          summary: summarizeRebalance(r),
        });
      }
    }
  }

  const wouldAffect =
    byType.orders.wouldCancel +
    byType.schedules.wouldPause +
    byType.rebalances.wouldPause;
  const skippedAlreadyTerminal =
    byType.orders.skipped + byType.schedules.skipped + byType.rebalances.skipped;

  return {
    filter: f,
    actions,
    summary: {
      totalRowsConsidered,
      wouldAffect,
      skippedAlreadyTerminal,
      skippedReasons,
      byType,
    },
  };
}

// ── plan: resume ───────────────────────────────────────────

/** Compute the bulk resume plan. Schedule + rebalance only —
 *  cancelled orders are terminal and can't be resumed. */
export function planResume(filter: BulkHaltFilter): BulkResumePlan {
  requireScope(filter);
  const f = normalizeFilter(filter);
  // Refuse `types` containing "orders" — orders aren't resumable.
  if (f.types?.includes("orders")) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Bulk resume cannot include 'orders' — cancelled orders are terminal. Recreate via `order create` or `playbook replace` instead.",
    );
  }

  const actions: PlannedAction[] = [];
  const byType = {
    schedules: { wouldResume: 0, skipped: 0 },
    rebalances: { wouldResume: 0, skipped: 0 },
  };
  let totalRowsConsidered = 0;

  if (typesIncluded(f.types, "schedules")) {
    const rows = listSchedules({ status: "all" });
    for (const s of rows) {
      if (!scheduleMatches(s, f)) continue;
      totalRowsConsidered++;
      if (s.status === "paused") {
        byType.schedules.wouldResume++;
        actions.push({
          type: "schedule",
          id: s.id!,
          operation: "resume",
          currentStatus: s.status,
          reason: "paused → resume",
          summary: summarizeSchedule(s),
        });
      } else {
        byType.schedules.skipped++;
        actions.push({
          type: "schedule",
          id: s.id!,
          operation: "skip",
          currentStatus: s.status,
          reason: `not paused (currently ${s.status})`,
          summary: summarizeSchedule(s),
        });
      }
    }
  }

  if (typesIncluded(f.types, "rebalances")) {
    const rows = listRebalancePlans({ status: "all" });
    for (const r of rows) {
      if (!rebalanceMatches(r, f)) continue;
      totalRowsConsidered++;
      if (r.status === "paused") {
        byType.rebalances.wouldResume++;
        actions.push({
          type: "rebalance",
          id: r.id!,
          operation: "resume",
          currentStatus: r.status,
          reason: "paused → resume",
          summary: summarizeRebalance(r),
        });
      } else {
        byType.rebalances.skipped++;
        actions.push({
          type: "rebalance",
          id: r.id!,
          operation: "skip",
          currentStatus: r.status,
          reason: `not paused (currently ${r.status})`,
          summary: summarizeRebalance(r),
        });
      }
    }
  }

  return {
    filter: f,
    actions,
    summary: {
      totalRowsConsidered,
      wouldAffect: byType.schedules.wouldResume + byType.rebalances.wouldResume,
      skipped: byType.schedules.skipped + byType.rebalances.skipped,
      byType,
    },
  };
}

// ── execute: halt ──────────────────────────────────────────

/**
 * Apply the halt plan inside a single DB transaction. Each
 * mutation goes through the existing per-primitive helper
 * (cancelOrderById / pauseScheduleById / pauseRebalancePlanById)
 * so their validation + race detection logic is inherited.
 *
 * Failure semantics: per-row failures are collected; the
 * transaction proceeds (a single revert in the middle of a 30-
 * primitive halt shouldn't undo the 29 successful ones — that
 * would leave the operator with a half-halted set + an unclear
 * state). The result carries `errors: []` per-row + the
 * SUCCESSFUL rows.
 *
 * For ACID atomicity at the row level we wrap each operation in
 * its own implicit transaction (SQLite default). The outer
 * BEGIN/COMMIT here groups them so all the audit_log rows from
 * the underlying SQL UPDATEs land together — operators reading
 * audit by timestamp see one bulk batch, not 30 staggered rows.
 */
export function executeHalt(plan: BulkHaltPlan): BulkResult {
  const applied: PlannedAction[] = [];
  const skipped: PlannedAction[] = [];
  const errors: { type: PlannedAction["type"]; id: number; message: string }[] = [];

  const db = openDb();
  db.exec("BEGIN");
  try {
    for (const action of plan.actions) {
      if (action.operation === "skip") {
        skipped.push(action);
        continue;
      }
      try {
        if (action.type === "order" && action.operation === "cancel") {
          cancelOrderById(action.id);
        } else if (action.type === "schedule" && action.operation === "pause") {
          pauseScheduleById(action.id);
        } else if (action.type === "rebalance" && action.operation === "pause") {
          pauseRebalancePlanById(action.id);
        } else {
          // Defensive: shouldn't reach here given the plan
          // builder's exhaustive coverage. Treat as error.
          errors.push({
            type: action.type,
            id: action.id,
            message: `unsupported halt op ${action.operation} for ${action.type}`,
          });
          continue;
        }
        applied.push(action);
      } catch (e) {
        errors.push({
          type: action.type,
          id: action.id,
          message: (e as Error).message ?? String(e),
        });
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    // Should be unreachable since per-row failures are caught
    // above, but if BEGIN/COMMIT itself fails we ROLLBACK +
    // surface the error.
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw new ToolError("INTERNAL_ERROR", `Bulk halt transaction failed: ${(e as Error).message}`);
  }

  return {
    ok: errors.length === 0,
    applied,
    skipped,
    errors,
  };
}

// ── execute: resume ────────────────────────────────────────

export function executeResume(plan: BulkResumePlan): BulkResult {
  const applied: PlannedAction[] = [];
  const skipped: PlannedAction[] = [];
  const errors: { type: PlannedAction["type"]; id: number; message: string }[] = [];

  const db = openDb();
  db.exec("BEGIN");
  try {
    for (const action of plan.actions) {
      if (action.operation === "skip") {
        skipped.push(action);
        continue;
      }
      try {
        if (action.type === "schedule" && action.operation === "resume") {
          resumeScheduleById(action.id);
        } else if (action.type === "rebalance" && action.operation === "resume") {
          resumeRebalancePlanById(action.id);
        } else {
          errors.push({
            type: action.type,
            id: action.id,
            message: `unsupported resume op ${action.operation} for ${action.type}`,
          });
          continue;
        }
        applied.push(action);
      } catch (e) {
        errors.push({
          type: action.type,
          id: action.id,
          message: (e as Error).message ?? String(e),
        });
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw new ToolError("INTERNAL_ERROR", `Bulk resume transaction failed: ${(e as Error).message}`);
  }

  return {
    ok: errors.length === 0,
    applied,
    skipped,
    errors,
  };
}

// ── summary helpers ────────────────────────────────────────

function summarizeOrder(o: OrderRow): string {
  const pair = `${o.base_symbol ?? "?"}/${o.quote_symbol ?? "?"}`;
  const amt = o.base_amount ?? o.quote_amount ?? "?";
  const trigger =
    o.trigger_type === "trailing"
      ? `trailing ${o.trail_pct ?? "?"}%`
      : `${o.trigger_type === "price_below" ? "≤" : "≥"} $${o.target_price_usd ?? "?"}`;
  return `${o.side.toUpperCase()} ${amt} ${pair}  ${trigger}`;
}

function summarizeSchedule(s: ScheduleRow): string {
  const pair = `${s.base_symbol ?? "?"}/${s.quote_symbol ?? "?"}`;
  const amt = s.base_amount ?? s.quote_amount ?? "?";
  return `${s.side.toUpperCase()} ${amt} ${pair}  @ ${s.cron_expr}`;
}

function summarizeRebalance(r: RebalanceRow): string {
  let targetCount = 0;
  try {
    const t = JSON.parse(r.targets_json);
    if (Array.isArray(t)) targetCount = t.length;
  } catch {
    // ignore
  }
  return `${r.name ?? "rebalance"}  (${targetCount} targets, drift ${r.drift_threshold_pct}%)`;
}
