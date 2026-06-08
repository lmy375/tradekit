// Trailing-stop logic — pure functions for the orders engine's `trailing`
// trigger type. Separate module so the math is unit-testable without DB /
// RPC infrastructure; the orders engine in src/orders.ts imports these
// helpers and wires the state machine.
//
// Concept:
//
//   Sell-trailing (most common — locks in gains as price rises, fires on
//   a retracement):
//     - water_mark_usd tracks the HIGHEST price seen since trail activation.
//     - Fire threshold = water_mark_usd × (1 - trail_pct / 100).
//     - Fire when current_price ≤ threshold.
//
//   Buy-trailing (symmetric — accumulates on a dip, fires on the bounce):
//     - water_mark_usd tracks the LOWEST price seen since trail activation.
//     - Fire threshold = water_mark_usd × (1 + trail_pct / 100).
//     - Fire when current_price ≥ threshold.
//
// Activation gate (optional, stored in target_price_usd):
//   - When non-null, the trail doesn't begin tracking until current_price
//     reaches the gate.
//   - For sells: current_price ≥ target_price_usd activates. Useful for
//     "trail after ETH hits $3500".
//   - For buys: current_price ≤ target_price_usd activates. Useful for
//     "trail after ETH drops to $2500".
//   - When null, the trail tracks from the first tick.
//
// Persistence model:
//   - water_mark_usd is null until first tracking tick.
//   - The engine updates it only when the mark strictly improves
//     (strictly increases for sells, strictly decreases for buys) — keeps
//     the DB write count down and the updated_at timestamp meaningful.
//   - Once an order fires + flips to "filled", the water_mark_usd remains
//     in the row as a historical record (operators can see the peak the
//     order tracked).

import { ToolError } from "./errors.js";
import type { OrderRow, OrderSide } from "./db.js";

// ── inputs / outputs ─────────────────────────────────────────

/** Slimmed view of an order — the bits we actually need for trail eval. */
export type TrailingOrderView = Pick<
  OrderRow,
  "side" | "trigger_type" | "target_price_usd" | "trail_pct" | "water_mark_usd"
>;

export interface TrailingEvaluation {
  /** Whether the trail is currently tracking (= activated and trail_pct
   *  configured). When false, the engine should not update water_mark_usd. */
  tracking: boolean;
  /** Why the trail isn't tracking, when tracking=false. Surfaced into
   *  the engine's debug log + `order show` so operators can answer
   *  "why isn't my trailing order moving?". */
  notTrackingReason?: "not_trailing" | "missing_trail_pct" | "below_activation" | "above_activation" | "invalid_price";
  /** The new water mark after considering the current price. NULL when
   *  the order isn't tracking. When tracking, the value is either the
   *  prior water mark (unchanged) or the strictly improved one. */
  nextWaterMark: number | null;
  /** True iff the engine should write back nextWaterMark to the DB
   *  (i.e. the mark improved). False when unchanged. */
  waterMarkChanged: boolean;
  /** The fire threshold given the (potentially-updated) water mark.
   *  NULL when not tracking. */
  fireThreshold: number | null;
  /** True iff the current_price has crossed the fire threshold. The
   *  engine routes through executeTrade when this is true. */
  triggered: boolean;
}

// ── pure evaluation ──────────────────────────────────────────

/** Single source of truth for the trailing-stop predicate. Pure — takes
 *  an order view + current price + returns the full evaluation. Engine
 *  callers use the result fields to decide DB writes + fire actions.
 *
 *  `null` current price returns tracking=false (the engine logs the
 *  price-fetch failure separately via setOrderError; this helper just
 *  refuses to make a decision without data). */
export function evaluateTrailingTrigger(order: TrailingOrderView, currentPriceUsd: number | null): TrailingEvaluation {
  if (order.trigger_type !== "trailing") {
    return {
      tracking: false,
      notTrackingReason: "not_trailing",
      nextWaterMark: order.water_mark_usd ?? null,
      waterMarkChanged: false,
      fireThreshold: null,
      triggered: false,
    };
  }
  if (currentPriceUsd == null || !Number.isFinite(currentPriceUsd) || currentPriceUsd <= 0) {
    return {
      tracking: false,
      notTrackingReason: "invalid_price",
      nextWaterMark: order.water_mark_usd ?? null,
      waterMarkChanged: false,
      fireThreshold: null,
      triggered: false,
    };
  }
  if (order.trail_pct == null || !Number.isFinite(order.trail_pct) || order.trail_pct <= 0 || order.trail_pct > 100) {
    return {
      tracking: false,
      notTrackingReason: "missing_trail_pct",
      nextWaterMark: order.water_mark_usd ?? null,
      waterMarkChanged: false,
      fireThreshold: null,
      triggered: false,
    };
  }
  // Activation gate: when target_price_usd is set, we only start tracking
  // once the gate is crossed. The direction depends on side:
  //   sell-trail: current must reach UP to target (price has rallied).
  //   buy-trail:  current must reach DOWN to target (price has dipped).
  if (order.target_price_usd != null && order.water_mark_usd == null) {
    if (order.side === "sell" && currentPriceUsd < order.target_price_usd) {
      return {
        tracking: false,
        notTrackingReason: "below_activation",
        nextWaterMark: null,
        waterMarkChanged: false,
        fireThreshold: null,
        triggered: false,
      };
    }
    if (order.side === "buy" && currentPriceUsd > order.target_price_usd) {
      return {
        tracking: false,
        notTrackingReason: "above_activation",
        nextWaterMark: null,
        waterMarkChanged: false,
        fireThreshold: null,
        triggered: false,
      };
    }
    // Crossed the gate this tick — fall through to start tracking.
  }
  // Tracking. Update the water mark if this tick improves it.
  const prior = order.water_mark_usd ?? currentPriceUsd;
  let nextWaterMark: number;
  let waterMarkChanged: boolean;
  if (order.side === "sell") {
    if (currentPriceUsd > prior) {
      nextWaterMark = currentPriceUsd;
      waterMarkChanged = true;
    } else {
      nextWaterMark = prior;
      waterMarkChanged = order.water_mark_usd == null; // first-tick write
    }
  } else {
    if (currentPriceUsd < prior) {
      nextWaterMark = currentPriceUsd;
      waterMarkChanged = true;
    } else {
      nextWaterMark = prior;
      waterMarkChanged = order.water_mark_usd == null;
    }
  }
  // Fire threshold computed from the FRESH water mark — a tick that
  // both updates the mark AND crosses the threshold isn't possible for
  // a well-formed trail (raising the HWM moves the threshold upward),
  // but compute defensively.
  const fireThreshold =
    order.side === "sell"
      ? nextWaterMark * (1 - order.trail_pct / 100)
      : nextWaterMark * (1 + order.trail_pct / 100);
  const triggered =
    order.side === "sell"
      ? currentPriceUsd <= fireThreshold
      : currentPriceUsd >= fireThreshold;
  return {
    tracking: true,
    nextWaterMark,
    waterMarkChanged,
    fireThreshold,
    triggered,
  };
}

// ── creation-time validation ─────────────────────────────────

export interface TrailingCreateArgs {
  side: OrderSide;
  trailPct?: number;
  activationPriceUsd?: number;
}

/**
 * Validate a trailing-order create request. Returns the canonical
 * (trail_pct, target_price_usd) pair the DB row needs, or throws
 * ToolError("INVALID_PARAMS") on a bad request.
 *
 * Rules:
 *   - trailPct is required, in (0, 100]. Trail percentages over 100
 *     are nonsense (the fire threshold would be negative or worse).
 *   - activationPriceUsd is optional, must be > 0 when set.
 *   - When activationPriceUsd is set, it must be in the "correct"
 *     direction relative to the side: a sell-trail's activation gate
 *     should be ABOVE the current intent ("wait for the price to rally
 *     above $X before starting to trail"). We don't actually validate
 *     "above current price" here because we don't fetch the price; the
 *     trail's first eval tick naturally enforces this (`below_activation`
 *     state). Validation here is structural only.
 */
export function validateTrailingCreate(args: TrailingCreateArgs): {
  trail_pct: number;
  target_price_usd: number | null;
} {
  if (args.trailPct == null) {
    throw new ToolError(
      "INVALID_PARAMS",
      `trailing orders require --trail-pct (% retracement that triggers the fill).`,
    );
  }
  if (!Number.isFinite(args.trailPct) || args.trailPct <= 0 || args.trailPct > 100) {
    throw new ToolError(
      "INVALID_PARAMS",
      `trailPct must be a number in (0, 100] (got ${args.trailPct}).`,
    );
  }
  let target: number | null = null;
  if (args.activationPriceUsd != null) {
    if (!Number.isFinite(args.activationPriceUsd) || args.activationPriceUsd <= 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `activationPriceUsd must be a positive number (got ${args.activationPriceUsd}).`,
      );
    }
    target = args.activationPriceUsd;
  }
  return { trail_pct: args.trailPct, target_price_usd: target };
}

// ── narrative renderer ──────────────────────────────────────

/**
 * Human-readable summary of a trailing order's current state. Used by
 * `order show` (text mode) so operators see "tracking $3450 HWM, 5%
 * trail → fires at $3277.50" without computing it themselves.
 */
export function describeTrailingState(order: TrailingOrderView, baseSymbol: string | null): string {
  if (order.trigger_type !== "trailing") return "";
  const sym = baseSymbol ?? "base";
  const trailPct = order.trail_pct ?? 0;
  if (order.water_mark_usd == null) {
    if (order.target_price_usd != null) {
      const dir = order.side === "sell" ? "above" : "below";
      return `Trailing ${order.side} (${trailPct}% trail) — awaiting activation when ${sym} crosses ${dir} \$${order.target_price_usd}`;
    }
    return `Trailing ${order.side} (${trailPct}% trail) — engine will start tracking on its next tick`;
  }
  const threshold =
    order.side === "sell"
      ? order.water_mark_usd * (1 - trailPct / 100)
      : order.water_mark_usd * (1 + trailPct / 100);
  const direction = order.side === "sell" ? "drops to" : "rises to";
  const markLabel = order.side === "sell" ? "HWM" : "LWM";
  return `Trailing ${order.side} (${trailPct}% trail) — ${markLabel} \$${order.water_mark_usd.toFixed(4)}, fires when ${sym} ${direction} ~\$${threshold.toFixed(4)}`;
}
