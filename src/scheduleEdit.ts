// ──────────────────────────────────────────────────────────────────
// Schedule edit (iter34): in-place modification of an active/paused
// schedule without losing run_count, total_base_filled, or the
// recurring cadence's chronological context.
//
// Symmetric with orderEdit.ts: same shape (validateScheduleEdit pure
// + editSchedule transactional). Differences:
//
//  * Editable fields tailored to schedule semantics: cron_expr (with
//    automatic next_run_at recomputation), end_at, max_runs,
//    on_fill_json, in addition to slippage/amounts/strategy/note/paper.
//
//  * Edits are legal on both 'active' AND 'paused' schedules (paused
//    is a deliberate operator state; re-tuning before resume is the
//    normal flow). Terminal states (completed / cancelled) reject.
//
//  * Cron change → recompute next_run_at from the moment of the
//    edit. Operator-driven cron edits should fire on the NEXT
//    natural occurrence, not preserve the (now-stale) prior
//    next_run_at.
//
//  * max_runs validation: an edit cannot push max_runs below the
//    current run_count — that would put the schedule into an
//    illegal state ("already past the cap"). Operator can SET
//    max_runs to exactly run_count to end after the next fire.
//
//  * on_fill_json: re-validates via scheduleHooks.validateOnFillSpec
//    against the schedule's chain + account + base/quote — same
//    contract as create-time.
// ──────────────────────────────────────────────────────────────────

import { ToolError } from "./errors.js";
import { validateSpendAmounts } from "./orders.js";
import { loadConfig, type Config } from "./config.js";
import {
  getScheduleById,
  updateScheduleEditable,
  type ScheduleRow,
  type ScheduleEditableFields,
} from "./db.js";
import { parseCron, nextRun, durationToCron } from "./cron.js";
import { validateOnFillSpec } from "./scheduleHooks.js";
import type { Address } from "viem";

/** Operator-facing edit shape. */
export interface ScheduleEditChanges {
  /** New cron expression. Mutually exclusive with `every`. Triggers
   *  next_run_at recomputation from `now`. */
  cron?: string;
  /** Duration shorthand (30m, 1h, 1d, 7d). Compiled to cron via
   *  durationToCron; mutually exclusive with `cron`. */
  every?: string;
  baseAmount?: string | null;
  quoteAmount?: string | null;
  slippageBps?: number | null;
  autoSlippage?: boolean;
  endAt?: string | null;
  maxRuns?: number | null;
  strategy?: string | null;
  note?: string | null;
  paper?: boolean;
  /** Parsed on_fill spec object (NOT a JSON string). Pass null to
   *  remove an existing hook. */
  onFill?: unknown;
}

export interface EditScheduleArgs {
  id: number;
  changes: ScheduleEditChanges;
  config?: Config;
  nowFn?: () => Date;
}

export interface EditScheduleResult {
  schedule: ScheduleRow;
  diff: ScheduleFieldDiff[];
}

export interface ScheduleFieldDiff {
  field: keyof ScheduleEditChanges | "cronExpr" | "nextRunAt";
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

/** Pure validator. Same shape as validateOrderEdit; returns the DB
 *  changes + the per-field diff for journaling/rendering. Exported
 *  for tests. */
export function validateScheduleEdit(args: {
  schedule: ScheduleRow;
  changes: ScheduleEditChanges;
  config: Config;
  now: Date;
}): {
  dbChanges: ScheduleEditableFields;
  diff: ScheduleFieldDiff[];
} {
  const { schedule, changes, config, now } = args;

  if (schedule.status !== "active" && schedule.status !== "paused") {
    throw new ToolError(
      "INVALID_PARAMS",
      `Schedule #${schedule.id} is ${schedule.status}; only active/paused schedules are editable. To start over, cancel + create a new one.`,
      { details: { id: schedule.id, status: schedule.status } },
    );
  }

  const dbChanges: ScheduleEditableFields = {};
  const diff: ScheduleFieldDiff[] = [];

  // ── cron / every (mutually exclusive) ────────────────────
  const hasCron = changes.cron != null && changes.cron !== "";
  const hasEvery = changes.every != null && changes.every !== "";
  if (hasCron && hasEvery) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Specify exactly one of cron / every on an edit.",
    );
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
    if (cronExpr !== schedule.cron_expr) {
      dbChanges.cron_expr = cronExpr;
      diff.push({ field: "cronExpr", oldValue: schedule.cron_expr, newValue: cronExpr });
      // Always recompute next_run_at when the cron changes.
      dbChanges.next_run_at = nextAt.toISOString();
      diff.push({ field: "nextRunAt", oldValue: schedule.next_run_at, newValue: nextAt.toISOString() });
    }
  }

  // ── base/quote amount (exactly-one invariant) ────────────
  const afterBase =
    "baseAmount" in changes ? changes.baseAmount ?? null : schedule.base_amount;
  const afterQuote =
    "quoteAmount" in changes ? changes.quoteAmount ?? null : schedule.quote_amount;
  if ("baseAmount" in changes || "quoteAmount" in changes) {
    const hasBase = afterBase != null && afterBase !== "";
    const hasQuote = afterQuote != null && afterQuote !== "";
    if (hasBase === hasQuote) {
      throw new ToolError(
        "INVALID_PARAMS",
        hasBase && hasQuote
          ? "Specify exactly one of baseAmount / quoteAmount; cannot have both set."
          : "Specify exactly one of baseAmount / quoteAmount; cannot have both unset.",
      );
    }
    // v35.5: same validation as create — positive decimal OR a
    // spend-side dynamic sentinel ("max" / "N%"). Pre-fix the edit
    // path rejected valid sentinels (parseFloat("max") is NaN) AND
    // accepted invalid ones ("150%" parsed as 150 plain tokens).
    const normalizedAmounts = validateSpendAmounts({
      side: schedule.side,
      baseAmount: hasBase ? (afterBase as string) : null,
      quoteAmount: hasQuote ? (afterQuote as string) : null,
      context: "schedule edit",
    });
    const baseToStore = hasBase ? normalizedAmounts.baseAmount : null;
    const quoteToStore = hasQuote ? normalizedAmounts.quoteAmount : null;
    if ("baseAmount" in changes && !fieldEqual(schedule.base_amount, baseToStore)) {
      dbChanges.base_amount = baseToStore;
      diff.push({ field: "baseAmount", oldValue: schedule.base_amount, newValue: baseToStore });
    }
    if ("quoteAmount" in changes && !fieldEqual(schedule.quote_amount, quoteToStore)) {
      dbChanges.quote_amount = quoteToStore;
      diff.push({ field: "quoteAmount", oldValue: schedule.quote_amount, newValue: quoteToStore });
    }
  }

  // ── slippage_bps ──────────────────────────────────────────
  if ("slippageBps" in changes) {
    const v = changes.slippageBps;
    if (v != null) {
      if (!Number.isInteger(v) || v <= 0 || v > 10_000) {
        throw new ToolError(
          "INVALID_PARAMS",
          `slippageBps must be an integer in (0, 10000] (got ${v}).`,
        );
      }
      const cap = config.safety?.maxSlippageBps ?? 5000;
      if (v > cap) {
        throw new ToolError(
          "SLIPPAGE_TOO_HIGH",
          `slippageBps ${v} exceeds safety.maxSlippageBps ${cap}.`,
          { details: { requested: v, cap } },
        );
      }
    }
    if (!fieldEqual(schedule.slippage_bps, v ?? null)) {
      dbChanges.slippage_bps = v ?? null;
      diff.push({ field: "slippageBps", oldValue: schedule.slippage_bps, newValue: v ?? null });
    }
  }

  // ── auto_slippage ─────────────────────────────────────────
  if ("autoSlippage" in changes) {
    const v = changes.autoSlippage === true;
    const current = schedule.auto_slippage === 1;
    if (current !== v) {
      dbChanges.auto_slippage = v;
      diff.push({ field: "autoSlippage", oldValue: current, newValue: v });
    }
  }

  // ── end_at ────────────────────────────────────────────────
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
    if (!fieldEqual(schedule.end_at, v ?? null)) {
      dbChanges.end_at = v ?? null;
      diff.push({ field: "endAt", oldValue: schedule.end_at, newValue: v ?? null });
    }
  }

  // ── max_runs ──────────────────────────────────────────────
  if ("maxRuns" in changes) {
    const v = changes.maxRuns;
    if (v != null) {
      if (!Number.isInteger(v) || v < 1) {
        throw new ToolError("INVALID_PARAMS", `maxRuns must be a positive integer (got ${v}).`);
      }
      if (v < schedule.run_count) {
        throw new ToolError(
          "INVALID_PARAMS",
          `maxRuns (${v}) cannot be less than the current run_count (${schedule.run_count}). Set it equal to ${schedule.run_count} to retire after the next fire, or cancel the schedule.`,
          { details: { requested: v, runCount: schedule.run_count } },
        );
      }
    }
    if (!fieldEqual(schedule.max_runs, v ?? null)) {
      dbChanges.max_runs = v ?? null;
      diff.push({ field: "maxRuns", oldValue: schedule.max_runs, newValue: v ?? null });
    }
  }

  // ── strategy / note ──────────────────────────────────────
  if ("strategy" in changes) {
    const normalized = normalizeNullableString(changes.strategy);
    if (!fieldEqual(schedule.strategy ?? null, normalized)) {
      dbChanges.strategy = normalized;
      diff.push({ field: "strategy", oldValue: schedule.strategy ?? null, newValue: normalized });
    }
  }
  if ("note" in changes) {
    const normalized = normalizeNullableString(changes.note);
    if (!fieldEqual(schedule.note ?? null, normalized)) {
      dbChanges.note = normalized;
      diff.push({ field: "note", oldValue: schedule.note ?? null, newValue: normalized });
    }
  }

  // ── paper ─────────────────────────────────────────────────
  if ("paper" in changes) {
    const v = changes.paper === true;
    const current = (schedule.paper ?? 0) === 1;
    if (current !== v) {
      dbChanges.paper = v;
      diff.push({ field: "paper", oldValue: current, newValue: v });
    }
  }

  // ── on_fill spec ─────────────────────────────────────────
  if ("onFill" in changes) {
    const v = changes.onFill;
    if (v == null) {
      if (schedule.on_fill_json) {
        dbChanges.on_fill_json = null;
        diff.push({ field: "onFill", oldValue: schedule.on_fill_json, newValue: null });
      }
    } else {
      // Re-validate against the schedule's pair (immutable).
      validateOnFillSpec({
        raw: v,
        chain: schedule.chain,
        account: schedule.account,
        config,
        baseAddress: schedule.base_token as Address | "ETH",
        quoteAddress: schedule.quote_token as Address,
      });
      const serialized = JSON.stringify(v);
      if (schedule.on_fill_json !== serialized) {
        dbChanges.on_fill_json = serialized;
        diff.push({ field: "onFill", oldValue: schedule.on_fill_json ?? null, newValue: serialized });
      }
    }
  }

  return { dbChanges, diff };
}

// ── main entry ──────────────────────────────────────────────

export function editSchedule(args: EditScheduleArgs): EditScheduleResult {
  const config = args.config ?? loadConfig();
  const now = (args.nowFn ?? (() => new Date()))();

  const before = getScheduleById(args.id);
  if (!before) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Schedule #${args.id} not found.`,
      { details: { id: args.id } },
    );
  }

  const { dbChanges, diff } = validateScheduleEdit({
    schedule: before,
    changes: args.changes,
    config,
    now,
  });

  if (diff.length === 0) {
    return { schedule: before, diff: [] };
  }

  const changed = updateScheduleEditable(args.id, dbChanges);
  if (changed === 0) {
    const after = getScheduleById(args.id);
    throw new ToolError(
      "INVALID_PARAMS",
      `Schedule #${args.id} is no longer in an editable status (${after?.status ?? "(deleted)"}). Edit aborted to avoid silently overwriting engine state.`,
      { details: { id: args.id, currentStatus: after?.status ?? null } },
    );
  }

  const after = getScheduleById(args.id);
  if (!after) {
    throw new ToolError("INTERNAL_ERROR", `Schedule #${args.id} disappeared immediately after edit.`);
  }
  return { schedule: after, diff };
}

/** Compact JSON renderer for the per-field diff. Mirrors
 *  orderEdit.renderDiffForJournal so CLI text output stays
 *  consistent across order/schedule. */
export function renderScheduleDiff(diff: ScheduleFieldDiff[]): string {
  const obj: Record<string, [unknown, unknown]> = {};
  for (const d of diff) {
    obj[d.field] = [d.oldValue, d.newValue];
  }
  return JSON.stringify(obj);
}
