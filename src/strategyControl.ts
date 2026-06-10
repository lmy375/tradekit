/**
 * Strategy-level bulk control: pause / resume every primitive owned
 * by a strategy tag in one operation.
 *
 * Why this exists. Primitives (orders / schedules / rebalance plans)
 * are individually pausable, but a strategy IS the unit an operator
 * reasons about — "stop playbook:42" should not require hand-listing
 * its 12 orders, 2 schedules, and a rebalance plan. This module is
 * also the action arm of the alert circuit breaker (iter: alert
 * rules with `action: "pause"` call pauseStrategyPrimitives when
 * they fire — the system protects itself instead of waiting for a
 * 3am operator).
 *
 * Semantics:
 *  - pause: every ACTIVE primitive with `strategy = tag` flips to
 *    paused. Already-paused / terminal rows are untouched (idempotent
 *    re-pause reports zero changes, not an error).
 *  - resume: every PAUSED primitive flips back. Schedules + rebalance
 *    plans recompute next_run_at from now (the "skip, don't backfill"
 *    DCA semantic); orders re-enter trigger evaluation on the next
 *    tick with trailing watermarks preserved.
 *  - Resume is blanket by tag: it cannot distinguish a primitive the
 *    operator paused by hand from one a circuit breaker paused.
 *    Operators who hand-pause a single primitive inside a strategy
 *    and then bulk-resume the tag will resume that one too —
 *    documented behavior, not a bug.
 *
 * Pure DB state transitions — no notifications here. Callers (CLI,
 * MCP, the alerts worker) own the messaging for their context.
 */

import {
  listOrders,
  listSchedules,
  listRebalancePlans,
  pauseOrder,
  resumeOrder,
  pauseSchedule,
  pauseRebalancePlan,
} from "./db.js";
import { resumeScheduleById } from "./schedules.js";
import { resumeRebalancePlanById } from "./rebalance.js";
import { ToolError } from "./errors.js";

export interface StrategyControlResult {
  tag: string;
  action: "pause" | "resume";
  /** Primitive ids that actually transitioned. */
  orders: number[];
  schedules: number[];
  rebalances: number[];
  /** Total transitions across all three primitive kinds. */
  total: number;
  /** Counts of rows that matched the tag but were NOT transitioned
   *  (wrong status for the action — e.g. already paused on pause,
   *  active on resume, or terminal). */
  skipped: number;
}

/** Pause every active primitive owned by `tag`. Idempotent. */
export function pauseStrategyPrimitives(tag: string): StrategyControlResult {
  requireTag(tag);
  const result: StrategyControlResult = {
    tag, action: "pause", orders: [], schedules: [], rebalances: [], total: 0, skipped: 0,
  };

  for (const o of listOrders({ status: "all", strategy: tag })) {
    if (o.id == null) continue;
    if (o.status !== "active") { if (o.status === "paused") result.skipped += 1; continue; }
    if (pauseOrder(o.id) > 0) result.orders.push(o.id);
  }
  for (const s of listSchedules({ status: "all", strategy: tag })) {
    if (s.id == null) continue;
    if (s.status !== "active") { if (s.status === "paused") result.skipped += 1; continue; }
    if (pauseSchedule(s.id) > 0) result.schedules.push(s.id);
  }
  for (const r of listRebalancePlans({ status: "all", strategy: tag })) {
    if (r.id == null) continue;
    if (r.status !== "active") { if (r.status === "paused") result.skipped += 1; continue; }
    if (pauseRebalancePlan(r.id) > 0) result.rebalances.push(r.id);
  }

  result.total = result.orders.length + result.schedules.length + result.rebalances.length;
  return result;
}

/** Resume every paused primitive owned by `tag`. Schedules and
 *  rebalance plans recompute next_run_at from `now`. Idempotent. */
export function resumeStrategyPrimitives(tag: string, now: Date = new Date()): StrategyControlResult {
  requireTag(tag);
  const result: StrategyControlResult = {
    tag, action: "resume", orders: [], schedules: [], rebalances: [], total: 0, skipped: 0,
  };

  for (const o of listOrders({ status: "all", strategy: tag })) {
    if (o.id == null) continue;
    if (o.status !== "paused") { if (o.status === "active") result.skipped += 1; continue; }
    if (resumeOrder(o.id) > 0) result.orders.push(o.id);
  }
  for (const s of listSchedules({ status: "all", strategy: tag })) {
    if (s.id == null) continue;
    if (s.status !== "paused") { if (s.status === "active") result.skipped += 1; continue; }
    resumeScheduleById(s.id, now);
    result.schedules.push(s.id);
  }
  for (const r of listRebalancePlans({ status: "all", strategy: tag })) {
    if (r.id == null) continue;
    if (r.status !== "paused") { if (r.status === "active") result.skipped += 1; continue; }
    resumeRebalancePlanById(r.id, now);
    result.rebalances.push(r.id);
  }

  result.total = result.orders.length + result.schedules.length + result.rebalances.length;
  return result;
}

/** Counts of live primitives per kind for a tag — used by the CLI to
 *  preview what a pause would touch and by `strategy pause --json`
 *  consumers to verify scope before acting. */
export function strategyPrimitiveCounts(tag: string): {
  tag: string;
  active: { orders: number; schedules: number; rebalances: number };
  paused: { orders: number; schedules: number; rebalances: number };
} {
  requireTag(tag);
  const orders = listOrders({ status: "all", strategy: tag });
  const schedules = listSchedules({ status: "all", strategy: tag });
  const rebalances = listRebalancePlans({ status: "all", strategy: tag });
  const count = (rows: Array<{ status: string }>, status: string) =>
    rows.filter((r) => r.status === status).length;
  return {
    tag,
    active: {
      orders: count(orders, "active"),
      schedules: count(schedules, "active"),
      rebalances: count(rebalances, "active"),
    },
    paused: {
      orders: count(orders, "paused"),
      schedules: count(schedules, "paused"),
      rebalances: count(rebalances, "paused"),
    },
  };
}

function requireTag(tag: string): void {
  if (typeof tag !== "string" || tag.trim() === "") {
    throw new ToolError("INVALID_PARAMS", "strategy tag must be a non-empty string.");
  }
}
