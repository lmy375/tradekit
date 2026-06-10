/**
 * Order decision journal — forensic record of state-changing
 * evaluations on conditional orders.
 *
 * Powers `tradekit order replay <id>` — operators answer "why did
 * this order fire HERE and not earlier?". Pre-iter25 the answer
 * required scanning engine stdout + audit_log + inferring from the
 * single-snapshot `last_checked_at` / `last_checked_price` columns.
 *
 * Sampling philosophy. The orders engine ticks every 30s; a naively
 * complete journal would write a row per tick per active order
 * (millions of rows/year). State-change sampling writes only when
 * the evaluation MEANS something different from the prior entry:
 *
 *   - tracking_started     first tick where a trailing order's
 *                          activation gate is met + HWM seeded
 *   - hwm_advanced         water mark moved (sell: rose; buy: fell)
 *   - near_threshold       price first crossed within proximityPct
 *                          of the fire threshold
 *   - triggered_fired      engine fired the order
 *   - triggered_skipped    trigger satisfied but engine declined
 *   - error                engine path error during check
 *   - expired              engine retired the order (now >= expires_at)
 *   - activation_pending   first observation where trailing's
 *                          activation gate isn't yet reached
 *
 * The pure `shouldLogCheck` predicate compares the prior journal
 * entry to the current evaluation; ~95% of ticks produce no log row
 * because nothing has changed. Operators get the full decision
 * timeline at <1% of the cardinality.
 *
 * Opt-in via `engine.orderJournal.enabled` config (default false) —
 * installs that don't need replay pay zero cost.
 */

import {
  insertOrderCheckEntry,
  getLatestOrderCheckEntry,
  replayOrderEntries,
  countOrderCheckEntries,
  type OrderCheckDecision,
  type OrderCheckLogRow,
  type OrderRow,
} from "./db.js";
import { evaluateTrailingTrigger, type TrailingOrderView } from "./trailingStop.js";
import { isOrderTriggered } from "./orders.js";

// ── types ────────────────────────────────────────────────────

/** Snapshot of an order's evaluation at a tick. The engine builds
 *  this after running the trigger predicate; the journal layer
 *  decides whether to persist it. */
export interface OrderCheckObservation {
  orderId: number;
  /** Engine wall-clock timestamp for this tick. */
  checkedAt: string;
  /** Current USD price observed at this tick. Null = price fetch
   *  failed; the journal still records an "error" entry with the
   *  reason in notes. */
  priceUsd: number | null;
  /** For trailing orders: HWM/LWM AFTER any update from this tick.
   *  For non-trailing: null. */
  waterMarkUsd: number | null;
  /** For trailing: derived fire threshold (HWM × (1 ± trail_pct/100)).
   *  For price triggers: target_price_usd. Null when not computable
   *  (e.g. trailing pre-activation). */
  thresholdUsd: number | null;
  decision: OrderCheckDecision;
  /** Optional free-form note — error message, peer cascade reason,
   *  etc. */
  notes?: string | null;
}

export interface OrderJournalConfig {
  enabled: boolean;
  /** Percent — log a "near_threshold" entry when price comes within
   *  this percentage of the fire threshold (proximity crossing). */
  proximityPct: number;
}

// ── sampling predicate ───────────────────────────────────────

/**
 * Should the engine persist this check to the journal?
 *
 * Returns true when the current observation represents a meaningful
 * state change vs. the prior journal entry:
 *
 *   - prior is null         → always log (first journal entry)
 *   - decision changed      → log (transitions are significant)
 *   - HWM advanced          → log (water mark moved)
 *   - near-threshold cross  → log (proximity crossing)
 *   - terminal decision     → log (fired / errored, regardless of
 *                            whether the prior was the same code)
 *
 * Routine "still tracking, no change" ticks return false — most of
 * the cardinality.
 *
 * Pure: takes observation + prior + config, returns bool. Tested
 * extensively without DB.
 */
export function shouldLogCheck(args: {
  current: OrderCheckObservation;
  prior: OrderCheckLogRow | null;
  config: OrderJournalConfig;
}): boolean {
  const { current, prior, config } = args;
  if (!config.enabled) return false;

  // First entry — always log.
  if (prior === null) return true;

  // Terminal decisions always log (fires + errors are too important
  // to deduplicate, even if the prior was the same code — e.g.
  // multiple errors in a row each have distinct context in `notes`).
  if (
    current.decision === "triggered_fired" ||
    current.decision === "triggered_skipped" ||
    current.decision === "error" ||
    current.decision === "expired"
  ) {
    return true;
  }

  // Decision-state changed.
  if (current.decision !== prior.decision) return true;

  // HWM advanced (compare current's water mark to prior's). Strict
  // inequality; equal HWM = no change. Treat null<->number as a
  // change (activation/deactivation transitions).
  const priorHwm = prior.water_mark_usd;
  const currentHwm = current.waterMarkUsd;
  if (priorHwm == null && currentHwm != null) return true;
  if (priorHwm != null && currentHwm == null) return true;
  if (priorHwm != null && currentHwm != null && priorHwm !== currentHwm) return true;

  // Proximity crossing: current is within proximityPct of threshold,
  // prior was not. Only relevant when both observations have a
  // threshold + price.
  if (
    current.priceUsd != null &&
    current.thresholdUsd != null &&
    prior.price_usd != null &&
    prior.threshold_usd != null
  ) {
    const currentProx = relativeDistancePct(current.priceUsd, current.thresholdUsd);
    const priorProx = relativeDistancePct(prior.price_usd, prior.threshold_usd);
    const within = currentProx <= config.proximityPct;
    const wasWithin = priorProx <= config.proximityPct;
    if (within && !wasWithin) return true;
  }

  return false;
}

/** Absolute relative distance between current price and threshold,
 *  as a percentage of current. Used for proximity detection.
 *  Symmetric — direction doesn't matter for "close to threshold?". */
function relativeDistancePct(currentPrice: number, threshold: number): number {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return Infinity;
  if (!Number.isFinite(threshold) || threshold <= 0) return Infinity;
  return (Math.abs(currentPrice - threshold) / currentPrice) * 100;
}

// ── observation building ─────────────────────────────────────

/**
 * Compose the observation an engine tick should report.
 *
 * For trailing orders: uses `evaluateTrailingTrigger` to compute the
 * post-tick HWM + threshold + tracking state.
 *
 * For price triggers: uses `isOrderTriggered` to decide if the
 * order would fire; threshold = target_price_usd.
 *
 * Called by the engine integration AFTER the trigger predicate
 * runs, with the same inputs.
 */
export function buildObservation(args: {
  order: OrderRow;
  priceUsd: number | null;
  checkedAt: string;
  /** True when the engine FIRED the order this tick — overrides the
   *  computed decision to `triggered_fired`. */
  fired?: boolean;
  /** True when the engine declined to fire despite a trigger match
   *  (rate-limit, balance, safety) — sets decision to
   *  `triggered_skipped`. Notes carry the reason. */
  skipped?: boolean;
  /** Optional free-form context for skipped / expired entries (the
   *  lock reason, the expiry boundary, …). Ignored when errorMessage
   *  is set (errorMessage IS the note on the error path). */
  notes?: string;
  /** True when the engine retired the order because now >= expires_at —
   *  decision = "expired". Terminal: the replay timeline ends here. */
  expired?: boolean;
  /** Set on engine-path errors — decision = "error". */
  errorMessage?: string;
}): OrderCheckObservation {
  const { order, priceUsd, checkedAt } = args;

  if (args.errorMessage) {
    return {
      orderId: order.id!,
      checkedAt,
      priceUsd,
      waterMarkUsd: order.water_mark_usd,
      thresholdUsd: deriveThreshold(order, order.water_mark_usd),
      decision: "error",
      notes: args.errorMessage,
    };
  }

  if (args.expired) {
    return {
      orderId: order.id!,
      checkedAt,
      priceUsd,
      waterMarkUsd: order.water_mark_usd,
      thresholdUsd: deriveThreshold(order, order.water_mark_usd),
      decision: "expired",
      notes: args.notes ?? (order.expires_at ? `expires_at ${order.expires_at}` : null),
    };
  }

  if (args.fired) {
    return {
      orderId: order.id!,
      checkedAt,
      priceUsd,
      waterMarkUsd: order.water_mark_usd,
      thresholdUsd: deriveThreshold(order, order.water_mark_usd),
      decision: "triggered_fired",
    };
  }
  if (args.skipped) {
    return {
      orderId: order.id!,
      checkedAt,
      priceUsd,
      waterMarkUsd: order.water_mark_usd,
      thresholdUsd: deriveThreshold(order, order.water_mark_usd),
      decision: "triggered_skipped",
      notes: args.notes ?? null,
    };
  }

  // Non-terminal path: compute the tick's effective state.
  if (order.trigger_type === "trailing") {
    const view: TrailingOrderView = {
      side: order.side,
      trigger_type: "trailing",
      target_price_usd: order.target_price_usd,
      trail_pct: order.trail_pct,
      water_mark_usd: order.water_mark_usd,
    };
    const evalRes = evaluateTrailingTrigger(view, priceUsd);
    // Determine post-tick decision.
    let decision: OrderCheckDecision;
    if (!evalRes.tracking) {
      if (evalRes.notTrackingReason === "below_activation" || evalRes.notTrackingReason === "above_activation") {
        decision = "activation_pending";
      } else {
        // missing_trail_pct / invalid_price / not_trailing — record
        // these as activation_pending too (operator's view: it's not
        // yet tracking) with a note.
        decision = "activation_pending";
      }
    } else if (order.water_mark_usd == null) {
      // Was previously not tracking (no HWM); now tracking →
      // tracking_started.
      decision = "tracking_started";
    } else if (evalRes.waterMarkChanged) {
      decision = "hwm_advanced";
    } else {
      // Tracking, HWM unchanged — "near_threshold" or no-op. We
      // emit "near_threshold" as a generic "still active" code; the
      // predicate decides whether to log based on prior state.
      decision = "near_threshold";
    }
    return {
      orderId: order.id!,
      checkedAt,
      priceUsd,
      waterMarkUsd: evalRes.nextWaterMark,
      thresholdUsd: evalRes.fireThreshold,
      decision,
      notes: !evalRes.tracking && evalRes.notTrackingReason ? evalRes.notTrackingReason : null,
    };
  }

  // price_above / price_below — non-trailing path.
  const triggered = isOrderTriggered(
    { trigger_type: order.trigger_type, target_price_usd: order.target_price_usd },
    priceUsd,
  );
  // A trigger-satisfied observation that reaches this non-terminal path
  // means the engine evaluated "would fire" but the caller didn't flag
  // fired/skipped. Record it honestly as triggered_skipped (trigger met,
  // no fire happened) instead of mislabeling it near_threshold — pre-fix
  // this was a no-op ternary that wrote near_threshold for BOTH branches,
  // so replay couldn't distinguish "approaching" from "met but unfired".
  return {
    orderId: order.id!,
    checkedAt,
    priceUsd,
    waterMarkUsd: null,
    thresholdUsd: order.target_price_usd,
    decision: triggered ? "triggered_skipped" : "near_threshold",
    notes: triggered ? "trigger satisfied; engine did not flag fired/skipped" : null,
  };
}

function deriveThreshold(order: OrderRow, waterMark: number | null): number | null {
  if (order.trigger_type === "trailing") {
    if (waterMark == null || order.trail_pct == null) return null;
    return order.side === "sell"
      ? waterMark * (1 - order.trail_pct / 100)
      : waterMark * (1 + order.trail_pct / 100);
  }
  return order.target_price_usd;
}

// ── DB-backed entry recording ────────────────────────────────

/**
 * Thin wrapper: build the observation (caller has already), apply
 * the sampling predicate, write the row when warranted. The engine
 * calls this once per check.
 *
 * `priorLookup` is an injection seam for tests; defaults to the DB
 * query.
 */
export function recordCheckEntry(args: {
  observation: OrderCheckObservation;
  config: OrderJournalConfig;
  priorLookup?: (orderId: number) => OrderCheckLogRow | null;
}): { wrote: boolean; rowId: number | null } {
  if (!args.config.enabled) return { wrote: false, rowId: null };
  const prior = (args.priorLookup ?? getLatestOrderCheckEntry)(args.observation.orderId);
  if (!shouldLogCheck({ current: args.observation, prior, config: args.config })) {
    return { wrote: false, rowId: null };
  }
  const rowId = insertOrderCheckEntry({
    orderId: args.observation.orderId,
    checkedAt: args.observation.checkedAt,
    priceUsd: args.observation.priceUsd,
    waterMarkUsd: args.observation.waterMarkUsd,
    thresholdUsd: args.observation.thresholdUsd,
    decision: args.observation.decision,
    notes: args.observation.notes ?? null,
  });
  return { wrote: true, rowId };
}

// ── replay query ─────────────────────────────────────────────

export interface ReplayTimeline {
  orderId: number;
  totalEntries: number;
  entries: OrderCheckLogRow[];
}

/** Read every journal entry for an order, return a structured
 *  timeline. The CLI renders this; programmatic consumers can use
 *  it directly. */
export function replayOrder(orderId: number, limit?: number): ReplayTimeline {
  const totalEntries = countOrderCheckEntries(orderId);
  const entries = replayOrderEntries(orderId, limit);
  return { orderId, totalEntries, entries };
}

// ── decision marker (exported for renderer) ──────────────────

/** Operator-facing marker for each decision type. Renders adjacent
 *  to each timeline row. */
export function decisionMarker(d: OrderCheckDecision): string {
  switch (d) {
    case "activation_pending": return "○";
    case "tracking_started":   return "⚙";
    case "hwm_advanced":       return "⚙";
    case "near_threshold":     return "⚠";
    case "triggered_fired":    return "🔥";
    case "triggered_skipped":  return "⏸";
    case "error":              return "✕";
    case "edited_by_operator": return "✎";
    case "expired":            return "⌛";
    case "hook_created":       return "↳";
    case "hook_failed":        return "↯";
  }
}

/** Operator-facing label for each decision type. */
export function decisionLabel(d: OrderCheckDecision): string {
  switch (d) {
    case "activation_pending": return "waiting for activation";
    case "tracking_started":   return "tracking started, HWM seeded";
    case "hwm_advanced":       return "HWM advanced";
    case "near_threshold":     return "near threshold";
    case "triggered_fired":    return "FIRED";
    case "triggered_skipped":  return "trigger skipped";
    case "error":              return "error";
    case "hook_created":       return "on-fill hook created follow-up";
    case "hook_failed":        return "on-fill hook FAILED (fill kept)";
    case "edited_by_operator": return "edited by operator";
    case "expired":            return "expired";
  }
}
