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

/* ────────────────────────────────────────────────────────────────────────
 * Trade EDGE (v121) — the ONE derivation of "does this strategy have an edge?"
 *
 * The edge arc (v114 live strategy-compare → v115 promote-check → v120
 * backtest) put profit factor / payoff / expectancy at every trust gate. But
 * the DERIVATION (classify each closed round-trip as win/loss by an epsilon,
 * accumulate gross win/loss, divide into the ratios) was written twice —
 * inline in computeStrategyComparison and again in tradeEdgeFromFires — each
 * hand-matched to the other. That match is the same structural debt this
 * module was created to kill for cost basis (above): a later change to the
 * flat-epsilon, the no-losses null rule, or the payoff guard in one site would
 * silently drift from the other, and "edge reads identically at every gate"
 * (the whole point of the arc) would quietly stop being true.
 *
 * So the win/loss math lives here, defined once. Callers do their own
 * cost-basis walk (each prices trades differently — value_usd vs quote≈USD)
 * and hand this the realized $ of each CLOSED round-trip; the edge can't
 * diverge across surfaces by construction. Pure, no IO.
 * ──────────────────────────────────────────────────────────────────────── */

/** Below this |USD| a realized round-trip is treated as flat — neither win nor
 *  loss. Shared so every edge surface uses the same flatness threshold. */
export const EDGE_FLAT_USD = 1e-6;

export interface EdgeMetrics {
  /** Closed round-trips fed in (includes flat ones — they're still closes). */
  closes: number;
  wins: number;
  losses: number;
  /** wins / (wins + losses) × 100. Null when nothing decisive closed. */
  winRatePct: number | null;
  /** Sum of all realized $ across closes (the bottom line). */
  realizedUsd: number;
  /** Gross winning $ and gross losing $ (abs) — the profit-factor basis. */
  grossWinUsd: number;
  grossLossUsd: number;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  /** grossWin / grossLoss. > 1 = profitable edge. Null when there are no
   *  losses (undefined ratio — a glance at wins/losses tells the rest). */
  profitFactor: number | null;
  /** avgWin / avgLoss — the win/loss size asymmetry. Null until both exist. */
  payoffRatio: number | null;
  /** realized $ ÷ closes — per-trade expectancy. Null when no closes. */
  expectancyUsd: number | null;
}

/**
 * Derive trade-edge metrics from the realized P&L (USD) of each CLOSED
 * round-trip. Always returns a value (a zero/empty book reads as 0 closes,
 * null ratios) so callers can map it straight onto their public shape.
 */
export function computeEdge(realizedPerClose: readonly number[]): EdgeMetrics {
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let realizedUsd = 0;
  for (const r of realizedPerClose) {
    if (!Number.isFinite(r)) continue;
    realizedUsd += r;
    if (r > EDGE_FLAT_USD) {
      wins += 1;
      grossWin += r;
    } else if (r < -EDGE_FLAT_USD) {
      losses += 1;
      grossLoss += -r;
    }
  }
  const closes = realizedPerClose.length;
  return {
    closes,
    wins,
    losses,
    winRatePct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : null,
    realizedUsd,
    grossWinUsd: grossWin,
    grossLossUsd: grossLoss,
    avgWinUsd: wins > 0 ? grossWin / wins : null,
    avgLossUsd: losses > 0 ? grossLoss / losses : null,
    profitFactor: grossLoss > EDGE_FLAT_USD ? grossWin / grossLoss : null,
    payoffRatio: wins > 0 && losses > 0 ? grossWin / wins / (grossLoss / losses) : null,
    expectancyUsd: closes > 0 ? realizedUsd / closes : null,
  };
}
