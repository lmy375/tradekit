/**
 * Cost-basis core (v71) — the ONE weighted-average position reducer.
 *
 * The product has several surfaces that must agree on "how much of token X
 * does strategy Y hold, and at what cost basis": the MTM walker
 * (computePaperPnlMtm — feeds pnl / gains / open_positions) and netPosition
 * (positionCaps — feeds the position-cap enforcer + v70 trade sizing). Both
 * implemented the SAME weighted-average arithmetic independently, each with a
 * comment promising it matched the other. That promise was structural debt: a
 * fix to one (the over-sell cap, the cost floor, an epsilon) could silently
 * drift from the other, and the position-cap enforcer would then act on a
 * number that open_positions never showed — the worst kind of trust bug,
 * because every individual surface looks self-consistent.
 *
 * This module is that arithmetic, defined once. Both callers reduce through
 * applyBuy / applySell, so they cannot disagree by construction. The model:
 *
 *   buy  → amount and cost both accrue (no realization)
 *   sell → realize against the WEIGHTED-AVERAGE unit cost; the sold amount is
 *          capped at current holdings (the overflow is "untracked" — e.g.
 *          deposit-seeded inventory that never had a tracked basis); cost is
 *          floored at 0 so float dust from repeated reductions can't drive it
 *          negative.
 *
 * Pure — no IO, no clock, no exceptions on normal inputs. Callers keep their
 * own concerns (token filtering, input validation, holding-period blending,
 * realization records); this owns only the amount/cost transition.
 */

/** Below this (base units) a position is treated as flat — guards against
 *  float dust from repeated avg-cost reductions registering as a phantom
 *  holding. Shared so every surface uses the same flatness threshold. */
export const FLAT_EPSILON = 1e-9;

export interface CostBasisState {
  /** Net base units held (decimal). */
  amount: number;
  /** Tracked cost basis in quote units (≈ USD for stable quotes). */
  cost: number;
}

/** Apply a buy: amount and cost both accrue. Mutates `state`. */
export function applyBuy(state: CostBasisState, baseAmount: number, quoteAmount: number): void {
  state.amount += baseAmount;
  state.cost += quoteAmount;
}

export interface SellOutcome {
  /** Weighted-average unit cost at the moment of sale (0 when flat). */
  avgCost: number;
  /** Base units actually drawn from the tracked position (capped at holdings). */
  sold: number;
  /** Base units sold beyond what was tracked (deposit-seeded / over-sell). */
  untracked: number;
  /** Cost basis removed from the position (avgCost × sold). */
  costRemoved: number;
}

/**
 * Apply a sell using weighted-average cost. Caps the sold amount at current
 * holdings (the overflow is `untracked`), floors the remaining cost at 0.
 * Mutates `state`; returns the realization detail callers need to compute
 * realized P&L / holding period.
 */
export function applySell(state: CostBasisState, baseAmount: number): SellOutcome {
  const avgCost = state.amount > 0 ? state.cost / state.amount : 0;
  const sold = Math.min(baseAmount, Math.max(0, state.amount));
  const untracked = baseAmount - sold;
  const costRemoved = avgCost * sold;
  state.amount -= sold;
  state.cost = Math.max(0, state.cost - costRemoved);
  return { avgCost, sold, untracked, costRemoved };
}
