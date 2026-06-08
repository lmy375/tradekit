// ──────────────────────────────────────────────────────────────────
// Order edit (iter34): in-place modification of an active order
// without losing trailing HWM, attempt counter, or journal continuity.
//
// Why: pre-iter34, adjusting a deployed order's parameters required
// `order cancel` + `order create`. For trailing stops this is acute:
// the HWM has been tracking for hours/days and gets thrown away
// because the operator wants to bump the trail by 2 points. iter34
// fixes the most common production adjustment.
//
// What's editable (intentionally narrow): target_price_usd, trail_pct,
// base/quote amount, slippage_bps, auto_slippage, expires_at,
// strategy, note, paper.
//
// What's FROZEN (changing means a different order; force destroy+
// recreate): side, chain, account, base/quote token, trigger_type,
// OCO group. Engine-managed columns (water_mark_usd, attempts,
// last_checked_*, fill_*) — operators don't edit these, the engine
// owns them.
//
// Atomicity: the DB-layer UPDATE is guarded on `status='active'` so
// a concurrent engine tick that flips the order to filled/failed/
// expired between read and write doesn't lose the operator's edit
// silently — the UPDATE returns 0 rows + this layer throws with the
// current status.
//
// Forensic continuity: every successful edit appends a row to
// order_check_log (iter25 journal) with decision="edited_by_operator"
// and notes holding the JSON-encoded field diff. The order's lifetime
// timeline shows operator edits inline with engine ticks.
// ──────────────────────────────────────────────────────────────────

import { ToolError } from "./errors.js";
import { loadConfig, type Config } from "./config.js";
import {
  getOrderById,
  insertOrderCheckEntry,
  updateOrderEditable,
  type OrderRow,
  type OrderEditableFields,
} from "./db.js";

/** Operator-supplied edit shape. Every field is optional + each
 *  follows the create-time semantics (string number → number after
 *  parsing; etc.). The orderEdit layer normalizes to the DB
 *  `OrderEditableFields` shape. */
export interface OrderEditChanges {
  targetPriceUsd?: number | null;
  trailPct?: number | null;
  baseAmount?: string | null;
  quoteAmount?: string | null;
  slippageBps?: number | null;
  autoSlippage?: boolean;
  expiresAt?: string | null;
  strategy?: string | null;
  note?: string | null;
  paper?: boolean;
}

export interface EditOrderArgs {
  id: number;
  changes: OrderEditChanges;
  config?: Config;
  /** Override `now` for deterministic testing. */
  nowFn?: () => Date;
}

export interface EditOrderResult {
  /** The order row AFTER the edit. */
  order: OrderRow;
  /** Per-field summary of what changed (old → new). Used by the CLI
   *  for the "edited X fields" rendering + by the journal note. */
  diff: FieldDiff[];
}

export interface FieldDiff {
  field: keyof OrderEditChanges;
  oldValue: number | string | boolean | null;
  newValue: number | string | boolean | null;
}

// ── helpers ─────────────────────────────────────────────────

function normalizeNullableString(s: unknown): string | null {
  if (s == null) return null;
  if (typeof s !== "string") return String(s);
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
}

function fieldEqual(a: number | string | boolean | null, b: number | string | boolean | null): boolean {
  if (a === b) return true;
  // Special: null/undefined treated as equal for diffing.
  if (a == null && b == null) return true;
  return false;
}

// ── validation ──────────────────────────────────────────────

/** Validate the proposed edit against the order's CURRENT state.
 *  Pure — no DB writes. Returns the normalized OrderEditableFields
 *  shape that the DB layer accepts. Throws ToolError for any
 *  validation failure. Exported for testing. */
export function validateOrderEdit(args: {
  order: OrderRow;
  changes: OrderEditChanges;
  config: Config;
  now: Date;
}): {
  dbChanges: OrderEditableFields;
  diff: FieldDiff[];
} {
  const { order, changes, config, now } = args;

  if (order.status !== "active") {
    throw new ToolError(
      "INVALID_PARAMS",
      `Order #${order.id} is ${order.status}; only active orders are editable. To start over, cancel + create a new one.`,
      { details: { id: order.id, status: order.status } },
    );
  }

  const dbChanges: OrderEditableFields = {};
  const diff: FieldDiff[] = [];

  // ── targetPriceUsd ────────────────────────────────────────
  if ("targetPriceUsd" in changes) {
    const v = changes.targetPriceUsd;
    if (v == null) {
      // Clearing the target. Only legal for trailing (where it's
      // the optional activation gate). For price_below / above the
      // target IS the trigger — clearing it would leave the order
      // un-evaluable.
      if (order.trigger_type !== "trailing") {
        throw new ToolError(
          "INVALID_PARAMS",
          `targetPriceUsd is required for ${order.trigger_type} orders; cannot unset.`,
        );
      }
      if (order.target_price_usd != null) {
        dbChanges.target_price_usd = null;
        diff.push({ field: "targetPriceUsd", oldValue: order.target_price_usd, newValue: null });
      }
    } else {
      if (!Number.isFinite(v) || v <= 0) {
        throw new ToolError(
          "INVALID_PARAMS",
          `targetPriceUsd must be a positive number (got ${v}).`,
        );
      }
      if (!fieldEqual(order.target_price_usd, v)) {
        dbChanges.target_price_usd = v;
        diff.push({ field: "targetPriceUsd", oldValue: order.target_price_usd, newValue: v });
      }
    }
  }

  // ── trailPct ──────────────────────────────────────────────
  if ("trailPct" in changes) {
    if (order.trigger_type !== "trailing") {
      throw new ToolError(
        "INVALID_PARAMS",
        `trailPct only applies to trailing orders; this order is ${order.trigger_type}.`,
      );
    }
    const v = changes.trailPct;
    if (v == null) {
      throw new ToolError(
        "INVALID_PARAMS",
        `trailPct is required for trailing orders; cannot unset.`,
      );
    }
    if (!Number.isFinite(v) || v <= 0 || v > 100) {
      throw new ToolError(
        "INVALID_PARAMS",
        `trailPct must be a number in (0, 100] (got ${v}).`,
      );
    }
    if (!fieldEqual(order.trail_pct, v)) {
      dbChanges.trail_pct = v;
      diff.push({ field: "trailPct", oldValue: order.trail_pct, newValue: v });
    }
  }

  // ── base/quote amount ────────────────────────────────────
  // Maintain the create-time invariant: exactly one of
  // base_amount / quote_amount is set at any time. The edit may
  // swap which side is set, but never end up with both or
  // neither. We compute the AFTER state and validate.
  const afterBase =
    "baseAmount" in changes ? changes.baseAmount ?? null : order.base_amount;
  const afterQuote =
    "quoteAmount" in changes ? changes.quoteAmount ?? null : order.quote_amount;
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
    if (hasBase) {
      const parsed = parseFloat(afterBase as string);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new ToolError("INVALID_PARAMS", `baseAmount must be a positive decimal string (got "${afterBase}").`);
      }
    }
    if (hasQuote) {
      const parsed = parseFloat(afterQuote as string);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new ToolError("INVALID_PARAMS", `quoteAmount must be a positive decimal string (got "${afterQuote}").`);
      }
    }
    if ("baseAmount" in changes && !fieldEqual(order.base_amount, afterBase)) {
      dbChanges.base_amount = afterBase;
      diff.push({ field: "baseAmount", oldValue: order.base_amount, newValue: afterBase });
    }
    if ("quoteAmount" in changes && !fieldEqual(order.quote_amount, afterQuote)) {
      dbChanges.quote_amount = afterQuote;
      diff.push({ field: "quoteAmount", oldValue: order.quote_amount, newValue: afterQuote });
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
      // Also enforce the global safety cap so an edit can't bypass
      // safety.maxSlippageBps. (Same rule create enforces upstream.)
      const cap = config.safety?.maxSlippageBps ?? 5000;
      if (v > cap) {
        throw new ToolError(
          "SLIPPAGE_TOO_HIGH",
          `slippageBps ${v} exceeds safety.maxSlippageBps ${cap}. Raise the cap or use a lower slippage.`,
          { details: { requested: v, cap } },
        );
      }
    }
    if (!fieldEqual(order.slippage_bps, v ?? null)) {
      dbChanges.slippage_bps = v ?? null;
      diff.push({ field: "slippageBps", oldValue: order.slippage_bps, newValue: v ?? null });
    }
  }

  // ── auto_slippage ─────────────────────────────────────────
  if ("autoSlippage" in changes) {
    const v = changes.autoSlippage === true;
    const current = order.auto_slippage === 1;
    if (current !== v) {
      dbChanges.auto_slippage = v;
      diff.push({ field: "autoSlippage", oldValue: current, newValue: v });
    }
  }

  // ── expires_at ────────────────────────────────────────────
  if ("expiresAt" in changes) {
    const v = changes.expiresAt;
    if (v != null) {
      const t = Date.parse(v);
      if (!Number.isFinite(t)) {
        throw new ToolError("INVALID_PARAMS", `expiresAt must be a valid ISO-8601 timestamp (got "${v}").`);
      }
      if (t <= now.getTime()) {
        throw new ToolError("INVALID_PARAMS", `expiresAt must be in the future (got "${v}"; now is "${now.toISOString()}").`);
      }
    }
    if (!fieldEqual(order.expires_at, v ?? null)) {
      dbChanges.expires_at = v ?? null;
      diff.push({ field: "expiresAt", oldValue: order.expires_at, newValue: v ?? null });
    }
  }

  // ── strategy ──────────────────────────────────────────────
  if ("strategy" in changes) {
    const normalized = normalizeNullableString(changes.strategy);
    if (!fieldEqual(order.strategy ?? null, normalized)) {
      dbChanges.strategy = normalized;
      diff.push({ field: "strategy", oldValue: order.strategy ?? null, newValue: normalized });
    }
  }

  // ── note ──────────────────────────────────────────────────
  if ("note" in changes) {
    const normalized = normalizeNullableString(changes.note);
    if (!fieldEqual(order.note ?? null, normalized)) {
      dbChanges.note = normalized;
      diff.push({ field: "note", oldValue: order.note ?? null, newValue: normalized });
    }
  }

  // ── paper ─────────────────────────────────────────────────
  if ("paper" in changes) {
    const v = changes.paper === true;
    const current = (order.paper ?? 0) === 1;
    if (current !== v) {
      dbChanges.paper = v;
      diff.push({ field: "paper", oldValue: current, newValue: v });
    }
  }

  return { dbChanges, diff };
}

// ── main entry ──────────────────────────────────────────────

export function editOrder(args: EditOrderArgs): EditOrderResult {
  const config = args.config ?? loadConfig();
  const now = (args.nowFn ?? (() => new Date()))();

  const before = getOrderById(args.id);
  if (!before) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Order #${args.id} not found.`,
      { details: { id: args.id } },
    );
  }

  const { dbChanges, diff } = validateOrderEdit({
    order: before,
    changes: args.changes,
    config,
    now,
  });

  if (diff.length === 0) {
    // No-op edit — operator passed the SAME values that already
    // exist. Don't journal, don't update updated_at, just return
    // the current row. This makes idempotent retries cheap.
    return { order: before, diff: [] };
  }

  const changed = updateOrderEditable(args.id, dbChanges);
  if (changed === 0) {
    // Race-loss: the order moved out of 'active' between our SELECT
    // and the UPDATE. Refetch + report the new status so the
    // operator knows EXACTLY what happened (vs a confusing "0 rows
    // updated" error).
    const after = getOrderById(args.id);
    throw new ToolError(
      "INVALID_PARAMS",
      `Order #${args.id} is no longer active (status ${after?.status ?? "(deleted)"}); edit aborted to avoid silently overwriting engine state.`,
      { details: { id: args.id, currentStatus: after?.status ?? null } },
    );
  }

  // Forensic continuity: append the journal row so `order replay`
  // shows the edit alongside trigger evaluations. Cheap: one INSERT
  // bound to the SAME orderId. Failure here would be defensive
  // (the edit itself succeeded), so it shouldn't roll back —
  // wrap in try/catch so a journal hiccup doesn't break the edit.
  try {
    insertOrderCheckEntry({
      orderId: args.id,
      checkedAt: now.toISOString(),
      priceUsd: null,
      waterMarkUsd: before.water_mark_usd, // unchanged by edit
      thresholdUsd: dbChanges.target_price_usd ?? before.target_price_usd,
      decision: "edited_by_operator",
      notes: renderDiffForJournal(diff),
    });
  } catch {
    // Best-effort. Journal is a debugging aid; if the order_check_log
    // table is missing (corrupted DB), the edit still wins.
  }

  const after = getOrderById(args.id);
  if (!after) {
    // Shouldn't happen — UPDATE just succeeded against this id —
    // but be defensive.
    throw new ToolError("INTERNAL_ERROR", `Order #${args.id} disappeared immediately after edit.`);
  }
  return { order: after, diff };
}

/** Render the diff as a compact JSON string fitting the journal
 *  notes column. Format: `{"trailPct":[5,7],"slippageBps":[50,75]}`.
 *  Exported for tests. */
export function renderDiffForJournal(diff: FieldDiff[]): string {
  const obj: Record<string, [unknown, unknown]> = {};
  for (const d of diff) {
    obj[d.field] = [d.oldValue, d.newValue];
  }
  return JSON.stringify(obj);
}
