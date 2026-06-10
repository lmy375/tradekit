// ──────────────────────────────────────────────────────────────────
// Rebalance-plan edit: in-place modification of an active/paused
// plan without losing run_count / max_runs accounting or last-run
// telemetry.
//
// Completes the primitive-edit triangle: orders got in-place edit in
// iter34 (preserving trailing HWM), schedules followed (preserving
// run counters) — rebalance plans were the holdout. Pre-this-module,
// re-weighting a 60/40 plan to 70/30 meant cancel + create: run_count
// reset (max_runs lifetime cap re-armed), last-run telemetry lost,
// and playbook replace had to recreate the row and manually carry the
// counters across.
//
// What's editable (mirrors the create-time knobs that don't change
// the plan's IDENTITY):
//   targets            — the re-weighting case. Same validation as
//                        create (validateTargets: sum exactly 100,
//                        no dupes, pct in (0,100]). Token SET changes
//                        are allowed here (the validator doesn't pin
//                        the old set) — drift math reads targets_json
//                        fresh each tick, so adding/dropping a target
//                        is semantically safe; the next tick simply
//                        evaluates the new composition.
//   driftThresholdPct  — (0, 100)
//   minTradeUsd        — >= 0
//   cron / every       — recompute next_run_at from now (same
//                        semantics as schedule edit: the new cadence
//                        fires at its next natural occurrence)
//   endAt              — must be in the future (null clears)
//   maxRuns            — must be >= current run_count (null clears)
//   slippageBps        — capped by safety.maxSlippageBps
//   autoSlippage, strategy, note, name, paper
//
// What's FROZEN (changing means a different plan; cancel + create):
//   chain, account     — a plan is scoped to ONE (chain, account)
//   quoteToken         — the routing anchor; every historical leg
//                        priced through it. Changing it mid-life
//                        would silently re-route corrective trades.
//   startAt            — activation gate is a create-time decision
//
// Atomicity: the DB UPDATE is guarded on status IN ('active',
// 'paused') so a concurrent engine tick that completes/cancels the
// plan between read and write surfaces as a structured error rather
// than a silent lost edit. Same race discipline as order/schedule
// edit.
// ──────────────────────────────────────────────────────────────────

import { ToolError } from "./errors.js";
import { loadConfig, type Config } from "./config.js";
import {
  getRebalancePlanById,
  updateRebalanceEditable,
  type RebalanceRow,
  type RebalanceEditableFields,
} from "./db.js";
import { parseCron, nextRun, durationToCron } from "./cron.js";
import { validateTargets, type RebalanceTarget } from "./rebalance.js";

/** Operator-facing edit shape. Every field optional; only supplied
 *  fields are validated + written. */
export interface RebalanceEditChanges {
  /** Replacement target list. Validated like create: sums to exactly
   *  100, no duplicate tokens, every pct in (0, 100]. */
  targets?: RebalanceTarget[];
  driftThresholdPct?: number;
  minTradeUsd?: number;
  /** New cron expression. Mutually exclusive with `every`. Triggers
   *  next_run_at recomputation from `now`. */
  cron?: string;
  /** Duration shorthand (6h, 1d, 7d). Compiled via durationToCron;
   *  mutually exclusive with `cron`. */
  every?: string;
  endAt?: string | null;
  maxRuns?: number | null;
  slippageBps?: number | null;
  autoSlippage?: boolean;
  strategy?: string | null;
  note?: string | null;
  name?: string | null;
  paper?: boolean;
}

export interface EditRebalanceArgs {
  id: number;
  changes: RebalanceEditChanges;
  config?: Config;
  nowFn?: () => Date;
}

export interface EditRebalanceResult {
  plan: RebalanceRow;
  diff: RebalanceFieldDiff[];
}

export interface RebalanceFieldDiff {
  field: keyof RebalanceEditChanges | "cronExpr" | "nextRunAt";
  oldValue: string | number | boolean | null;
  newValue: string | number | boolean | null;
}

// ── helpers ─────────────────────────────────────────────────

function normalizeNullableString(s: unknown): string | null {
  if (s == null) return null;
  if (typeof s !== "string") return String(s);
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
}

function fieldEqual(a: string | number | boolean | null, b: string | number | boolean | null): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return false;
}

// ── validation ──────────────────────────────────────────────

/** Pure validator. Same shape as validateOrderEdit /
 *  validateScheduleEdit; returns the DB changes + the per-field diff
 *  for rendering. Exported for tests and for playbook-replace's
 *  pre-mutation validation pass. */
export function validateRebalanceEdit(args: {
  plan: RebalanceRow;
  changes: RebalanceEditChanges;
  config: Config;
  now: Date;
}): {
  dbChanges: RebalanceEditableFields;
  diff: RebalanceFieldDiff[];
} {
  const { plan, changes, config, now } = args;

  if (plan.status !== "active" && plan.status !== "paused") {
    throw new ToolError(
      "INVALID_PARAMS",
      `Rebalance plan #${plan.id} is ${plan.status}; only active/paused plans are editable. To start over, cancel + create a new one.`,
      { details: { id: plan.id, status: plan.status } },
    );
  }

  const dbChanges: RebalanceEditableFields = {};
  const diff: RebalanceFieldDiff[] = [];

  // ── targets ───────────────────────────────────────────────
  if ("targets" in changes) {
    const raw = changes.targets;
    if (raw == null || !Array.isArray(raw) || raw.length === 0) {
      throw new ToolError("INVALID_PARAMS", "targets must be a non-empty array; a plan cannot exist without targets.");
    }
    // Same validation gate as create. Throws structured INVALID_PARAMS
    // on sum != 100, duplicates, non-positive pct.
    const validated = validateTargets(raw);
    const serialized = JSON.stringify(validated);
    if (serialized !== plan.targets_json) {
      dbChanges.targets_json = serialized;
      diff.push({ field: "targets", oldValue: plan.targets_json, newValue: serialized });
    }
  }

  // ── driftThresholdPct ─────────────────────────────────────
  if ("driftThresholdPct" in changes) {
    const v = changes.driftThresholdPct;
    if (v == null || !Number.isFinite(v) || v <= 0 || v >= 100) {
      throw new ToolError("INVALID_PARAMS", `driftThresholdPct must be a number in (0, 100) (got ${v}).`);
    }
    if (!fieldEqual(plan.drift_threshold_pct, v)) {
      dbChanges.drift_threshold_pct = v;
      diff.push({ field: "driftThresholdPct", oldValue: plan.drift_threshold_pct, newValue: v });
    }
  }

  // ── minTradeUsd ───────────────────────────────────────────
  if ("minTradeUsd" in changes) {
    const v = changes.minTradeUsd;
    if (v == null || !Number.isFinite(v) || v < 0) {
      throw new ToolError("INVALID_PARAMS", `minTradeUsd must be a non-negative number (got ${v}).`);
    }
    if (!fieldEqual(plan.min_trade_usd, v)) {
      dbChanges.min_trade_usd = v;
      diff.push({ field: "minTradeUsd", oldValue: plan.min_trade_usd, newValue: v });
    }
  }

  // ── cron / every (mutually exclusive) ─────────────────────
  const hasCron = changes.cron != null && changes.cron !== "";
  const hasEvery = changes.every != null && changes.every !== "";
  if (hasCron && hasEvery) {
    throw new ToolError("INVALID_PARAMS", "Specify exactly one of cron / every on an edit.");
  }
  if (hasCron || hasEvery) {
    const cronExpr = hasCron ? (changes.cron as string) : durationToCron(changes.every as string);
    let parsed: ReturnType<typeof parseCron>;
    try {
      parsed = parseCron(cronExpr);
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `Invalid cron expression: ${(e as Error).message}`);
    }
    const nextAt = nextRun(parsed, now);
    if (cronExpr !== plan.cron_expr) {
      dbChanges.cron_expr = cronExpr;
      diff.push({ field: "cronExpr", oldValue: plan.cron_expr, newValue: cronExpr });
      dbChanges.next_run_at = nextAt.toISOString();
      diff.push({ field: "nextRunAt", oldValue: plan.next_run_at, newValue: nextAt.toISOString() });
    }
  }

  // ── endAt ─────────────────────────────────────────────────
  if ("endAt" in changes) {
    const v = changes.endAt;
    if (v != null) {
      const t = Date.parse(v);
      if (!Number.isFinite(t)) {
        throw new ToolError("INVALID_PARAMS", `endAt must be a valid ISO-8601 timestamp (got "${v}").`);
      }
      if (t <= now.getTime()) {
        throw new ToolError("INVALID_PARAMS", `endAt must be in the future (got "${v}").`);
      }
    }
    if (!fieldEqual(plan.end_at, v ?? null)) {
      dbChanges.end_at = v ?? null;
      diff.push({ field: "endAt", oldValue: plan.end_at, newValue: v ?? null });
    }
  }

  // ── maxRuns ───────────────────────────────────────────────
  if ("maxRuns" in changes) {
    const v = changes.maxRuns;
    if (v != null) {
      if (!Number.isInteger(v) || v < 1) {
        throw new ToolError("INVALID_PARAMS", `maxRuns must be a positive integer (got ${v}).`);
      }
      if (v < plan.run_count) {
        throw new ToolError(
          "INVALID_PARAMS",
          `maxRuns (${v}) cannot be less than the current run_count (${plan.run_count}). Set it equal to ${plan.run_count} to retire after the next run, or cancel the plan.`,
          { details: { requested: v, runCount: plan.run_count } },
        );
      }
    }
    if (!fieldEqual(plan.max_runs, v ?? null)) {
      dbChanges.max_runs = v ?? null;
      diff.push({ field: "maxRuns", oldValue: plan.max_runs, newValue: v ?? null });
    }
  }

  // ── slippageBps ───────────────────────────────────────────
  if ("slippageBps" in changes) {
    const v = changes.slippageBps;
    if (v != null) {
      if (!Number.isInteger(v) || v <= 0 || v > 10_000) {
        throw new ToolError("INVALID_PARAMS", `slippageBps must be an integer in (0, 10000] (got ${v}).`);
      }
      const cap = config.safety?.maxSlippageBps ?? 5000;
      if (v > cap) {
        throw new ToolError("SLIPPAGE_TOO_HIGH", `slippageBps ${v} exceeds safety.maxSlippageBps ${cap}.`, {
          details: { requested: v, cap },
        });
      }
    }
    if (!fieldEqual(plan.slippage_bps, v ?? null)) {
      dbChanges.slippage_bps = v ?? null;
      diff.push({ field: "slippageBps", oldValue: plan.slippage_bps, newValue: v ?? null });
    }
  }

  // ── autoSlippage ──────────────────────────────────────────
  if ("autoSlippage" in changes) {
    const v = changes.autoSlippage === true;
    const current = plan.auto_slippage === 1;
    if (current !== v) {
      dbChanges.auto_slippage = v;
      diff.push({ field: "autoSlippage", oldValue: current, newValue: v });
    }
  }

  // ── strategy / note / name ────────────────────────────────
  if ("strategy" in changes) {
    const normalized = normalizeNullableString(changes.strategy);
    if (!fieldEqual(plan.strategy ?? null, normalized)) {
      dbChanges.strategy = normalized;
      diff.push({ field: "strategy", oldValue: plan.strategy ?? null, newValue: normalized });
    }
  }
  if ("note" in changes) {
    const normalized = normalizeNullableString(changes.note);
    if (!fieldEqual(plan.note ?? null, normalized)) {
      dbChanges.note = normalized;
      diff.push({ field: "note", oldValue: plan.note ?? null, newValue: normalized });
    }
  }
  if ("name" in changes) {
    const normalized = normalizeNullableString(changes.name);
    if (!fieldEqual(plan.name ?? null, normalized)) {
      dbChanges.name = normalized;
      diff.push({ field: "name", oldValue: plan.name ?? null, newValue: normalized });
    }
  }

  // ── paper ─────────────────────────────────────────────────
  if ("paper" in changes) {
    const v = changes.paper === true;
    const current = (plan.paper ?? 0) === 1;
    if (current !== v) {
      dbChanges.paper = v;
      diff.push({ field: "paper", oldValue: current, newValue: v });
    }
  }

  return { dbChanges, diff };
}

// ── main entry ──────────────────────────────────────────────

export function editRebalancePlan(args: EditRebalanceArgs): EditRebalanceResult {
  const config = args.config ?? loadConfig();
  const now = (args.nowFn ?? (() => new Date()))();

  const before = getRebalancePlanById(args.id);
  if (!before) {
    throw new ToolError("INVALID_PARAMS", `Rebalance plan #${args.id} not found.`, { details: { id: args.id } });
  }

  const { dbChanges, diff } = validateRebalanceEdit({
    plan: before,
    changes: args.changes,
    config,
    now,
  });

  if (diff.length === 0) {
    // No-op edit — same values as current. Idempotent retries are cheap.
    return { plan: before, diff: [] };
  }

  const changed = updateRebalanceEditable(args.id, dbChanges);
  if (changed === 0) {
    // Race-loss: the plan left active/paused between our SELECT and
    // the guarded UPDATE. Refetch + report the actual status.
    const after = getRebalancePlanById(args.id);
    throw new ToolError(
      "INVALID_PARAMS",
      `Rebalance plan #${args.id} is no longer in an editable status (${after?.status ?? "(deleted)"}). Edit aborted to avoid silently overwriting engine state.`,
      { details: { id: args.id, currentStatus: after?.status ?? null } },
    );
  }

  const after = getRebalancePlanById(args.id);
  if (!after) {
    throw new ToolError("INTERNAL_ERROR", `Rebalance plan #${args.id} disappeared immediately after edit.`);
  }
  return { plan: after, diff };
}

/** Compact JSON renderer for the per-field diff. Mirrors
 *  orderEdit.renderDiffForJournal / scheduleEdit.renderScheduleDiff
 *  so CLI text output stays consistent across all three primitives. */
export function renderRebalanceDiff(diff: RebalanceFieldDiff[]): string {
  const obj: Record<string, [unknown, unknown]> = {};
  for (const d of diff) {
    obj[d.field] = [d.oldValue, d.newValue];
  }
  return JSON.stringify(obj);
}
