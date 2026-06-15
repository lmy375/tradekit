/**
 * Cost-basis core tests (v71). Two jobs:
 *  1. Pin the shared reducer (applyBuy / applySell) in isolation — accrual,
 *     weighted-average realization, the over-sell cap + untracked overflow,
 *     the cost floor, the flat-position edge.
 *  2. The COHERENCE guard: feed an identical fill sequence to BOTH the MTM
 *     walker (computePaperPnlMtm — the P&L / open_positions surface) and
 *     netPosition (the position-cap / sizing surface) and assert they agree
 *     on net amount + cost basis. This is the invariant the two surfaces have
 *     always claimed by comment; now it's tested, and (post-refactor) true by
 *     construction since both reduce through this module.
 */

import { describe, it, expect } from "vitest";
import { applyBuy, applySell, computeEdge, FLAT_EPSILON, type CostBasisState } from "./costBasis.js";
import { computePaperPnlMtm, type PaperPriceFetcher } from "./paperPnl.js";
import { netPosition, type FillRowLite } from "./positionCaps.js";
import { enrichTradesForExport, quoteUsdAtTradeForExport } from "./tradeExport.js";
import { computeStrategyComparison, type StrategyTradeLite } from "./strategyCompare.js";
import { tradeEdgeFromFires } from "./backtestMetrics.js";
import type { BacktestFire } from "./backtest.js";
import type { PaperTradeRow, TradeRow } from "./db.js";

// ── unit: the shared reducer ───────────────────────────────

describe("applyBuy / applySell", () => {
  it("buys accrue amount and cost; no realization", () => {
    const s: CostBasisState = { amount: 0, cost: 0 };
    applyBuy(s, 1, 2000);
    applyBuy(s, 1, 3000);
    expect(s.amount).toBe(2);
    expect(s.cost).toBe(5000); // avg 2500
  });

  it("a sell realizes against the weighted-average and reduces both legs", () => {
    const s: CostBasisState = { amount: 2, cost: 5000 }; // avg 2500
    const out = applySell(s, 1);
    expect(out.avgCost).toBeCloseTo(2500);
    expect(out.sold).toBe(1);
    expect(out.untracked).toBe(0);
    expect(out.costRemoved).toBeCloseTo(2500);
    expect(s.amount).toBe(1);
    expect(s.cost).toBeCloseTo(2500);
  });

  it("over-selling caps at holdings; the overflow is untracked, cost floors at 0", () => {
    const s: CostBasisState = { amount: 1, cost: 2000 };
    const out = applySell(s, 3); // only 1 is tracked
    expect(out.sold).toBe(1);
    expect(out.untracked).toBe(2);
    expect(s.amount).toBe(0);
    expect(s.cost).toBe(0);
  });

  it("selling a flat position is a pure no-op on cost; everything is untracked", () => {
    const s: CostBasisState = { amount: 0, cost: 0 };
    const out = applySell(s, 5);
    expect(out.avgCost).toBe(0);
    expect(out.sold).toBe(0);
    expect(out.untracked).toBe(5);
    expect(s.amount).toBe(0);
    expect(s.cost).toBe(0);
  });

  it("FLAT_EPSILON is the shared flatness threshold", () => {
    expect(FLAT_EPSILON).toBe(1e-9);
  });
});

// ── coherence: walker vs netPosition agree on identical fills ──

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

let nextId = 1;
/** One logical fill, expressed for BOTH engines from the same source. */
interface Fill { dir: "buy" | "sell"; base: string; quote: string; ts: string }

function walkerRows(fills: Fill[]): PaperTradeRow[] {
  return fills.map((f) => ({
    id: nextId++,
    timestamp: f.ts,
    source_type: "manual",
    source_id: null,
    chain: "base",
    account: "default",
    direction: f.dir,
    base_token: WETH,
    base_symbol: "WETH",
    base_amount: f.base,
    quote_token: USDC,
    quote_symbol: "USDC",
    quote_amount: f.quote,
    price: "0",
    slippage_bps: null,
    strategy: "dca-eth",
    notes: null,
    value_usd: null,
  }));
}

function capRows(fills: Fill[]): FillRowLite[] {
  return fills.map((f) => ({
    timestamp: f.ts,
    direction: f.dir,
    base_token: WETH,
    base_symbol: "WETH",
    base_amount: f.base,
    quote_amount: f.quote,
  }));
}

const noPrice: PaperPriceFetcher = async () => null; // marks irrelevant to net amount/cost

async function walkerNet(fills: Fill[]): Promise<{ amount: number; cost: number }> {
  const { summaries } = await computePaperPnlMtm(walkerRows(fills), noPrice);
  // Sum the open positions for the (single) strategy — amount + cost basis.
  const positions = summaries.flatMap((s) => s.positions);
  let amount = 0;
  let cost = 0;
  for (const p of positions) {
    amount += p.amount;
    cost += p.amount * p.avgCostQuote; // cost basis = held units × avg unit cost
  }
  return { amount, cost };
}

describe("coherence: MTM walker ≡ netPosition (shared cost-basis core)", () => {
  const SCENARIOS: Record<string, Fill[]> = {
    "single buy": [{ dir: "buy", base: "2", quote: "4000", ts: "2026-06-01T00:00:00Z" }],
    "two buys → weighted average": [
      { dir: "buy", base: "1", quote: "2000", ts: "2026-06-01T00:00:00Z" },
      { dir: "buy", base: "1", quote: "3000", ts: "2026-06-02T00:00:00Z" },
    ],
    "partial sell keeps remainder": [
      { dir: "buy", base: "2", quote: "5000", ts: "2026-06-01T00:00:00Z" },
      { dir: "sell", base: "1", quote: "2800", ts: "2026-06-03T00:00:00Z" },
    ],
    "round trip → flat": [
      { dir: "buy", base: "1", quote: "2000", ts: "2026-06-01T00:00:00Z" },
      { dir: "sell", base: "1", quote: "2500", ts: "2026-06-02T00:00:00Z" },
    ],
    "over-sell beyond holdings": [
      { dir: "buy", base: "1", quote: "2000", ts: "2026-06-01T00:00:00Z" },
      { dir: "sell", base: "3", quote: "7500", ts: "2026-06-02T00:00:00Z" },
    ],
    "buy, sell all, buy again": [
      { dir: "buy", base: "2", quote: "4000", ts: "2026-06-01T00:00:00Z" },
      { dir: "sell", base: "2", quote: "5000", ts: "2026-06-02T00:00:00Z" },
      { dir: "buy", base: "3", quote: "9000", ts: "2026-06-03T00:00:00Z" },
    ],
    "fractional amounts": [
      { dir: "buy", base: "0.37", quote: "1110", ts: "2026-06-01T00:00:00Z" },
      { dir: "buy", base: "0.13", quote: "455", ts: "2026-06-02T00:00:00Z" },
      { dir: "sell", base: "0.2", quote: "640", ts: "2026-06-03T00:00:00Z" },
    ],
  };

  for (const [name, fills] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const walker = await walkerNet(fills);
      const cap = netPosition(capRows(fills), { token: WETH });
      expect(cap.baseAmount).toBeCloseTo(walker.amount, 9);
      expect(cap.costQuote).toBeCloseTo(walker.cost, 6);
    });
  }
});

// v82: extend the guard to the REAL-money realized PnL surfaces consolidated
// this iteration — the tax export (tradeExport) must book the SAME realized
// gain the MTM walker does for the same fills. (pnl.ts now shares the reducer
// too; its realized math is pinned by pnl.test.ts behavior-preservation.)
function exportRows(fills: Fill[]): TradeRow[] {
  return fills.map((f, i) => ({
    id: i + 1,
    timestamp: f.ts,
    chain: "base",
    account: "default",
    direction: f.dir,
    base_token: WETH,
    base_symbol: "WETH",
    base_amount: f.base,
    quote_token: USDC,
    quote_symbol: "USDC",
    quote_amount: f.quote,
    price: "0",
    tx_hash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
    status: "success",
    gas_used: null,
    gas_price_wei: null,
    gas_cost_native: null,
    aggregator: null,
    fee_tier: null,
    notes: null,
  }));
}

async function walkerRealized(fills: Fill[]): Promise<number> {
  const { summaries } = await computePaperPnlMtm(walkerRows(fills), noPrice);
  return summaries.reduce((s, x) => s + x.realizedQuote, 0);
}

describe("coherence: tax export ≡ MTM walker realized PnL (shared cost-basis core, v82)", () => {
  const SCENARIOS: Record<string, Fill[]> = {
    "single sell at a gain": [
      { dir: "buy", base: "2", quote: "4000", ts: "2026-06-01T00:00:00Z" },
      { dir: "sell", base: "1", quote: "2500", ts: "2026-06-03T00:00:00Z" }, // avg 2000, +500
    ],
    "two buys then sell (weighted avg)": [
      { dir: "buy", base: "1", quote: "2000", ts: "2026-06-01T00:00:00Z" },
      { dir: "buy", base: "1", quote: "3000", ts: "2026-06-02T00:00:00Z" }, // avg 2500
      { dir: "sell", base: "1", quote: "2800", ts: "2026-06-03T00:00:00Z" }, // +300
    ],
    "sell at a loss": [
      { dir: "buy", base: "1", quote: "3000", ts: "2026-06-01T00:00:00Z" },
      { dir: "sell", base: "1", quote: "2400", ts: "2026-06-02T00:00:00Z" }, // -600
    ],
    "over-sell beyond holdings": [
      { dir: "buy", base: "1", quote: "2000", ts: "2026-06-01T00:00:00Z" },
      { dir: "sell", base: "3", quote: "7500", ts: "2026-06-02T00:00:00Z" }, // only 1 tracked
    ],
    "fractional round trip": [
      { dir: "buy", base: "0.37", quote: "1110", ts: "2026-06-01T00:00:00Z" },
      { dir: "buy", base: "0.13", quote: "455", ts: "2026-06-02T00:00:00Z" },
      { dir: "sell", base: "0.2", quote: "640", ts: "2026-06-03T00:00:00Z" },
    ],
  };

  for (const [name, fills] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const enriched = enrichTradesForExport(exportRows(fills), quoteUsdAtTradeForExport, new Map());
      const exportRealized = enriched.reduce((s, r) => s + (r.realized_pnl_usd ?? 0), 0);
      const walker = await walkerRealized(fills);
      expect(exportRealized).toBeCloseTo(walker, 6);
    });
  }
});

// ── unit: the shared edge derivation (v121) ─────────────────
describe("computeEdge", () => {
  it("derives profit factor / payoff / expectancy / win rate from realized closes", () => {
    const e = computeEdge([500, 200, -200]); // 2 wins (+700), 1 loss (-200)
    expect(e.closes).toBe(3);
    expect(e.wins).toBe(2);
    expect(e.losses).toBe(1);
    expect(e.winRatePct).toBeCloseTo(200 / 3, 4);
    expect(e.realizedUsd).toBeCloseTo(500, 6);
    expect(e.grossWinUsd).toBeCloseTo(700, 6);
    expect(e.grossLossUsd).toBeCloseTo(200, 6);
    expect(e.avgWinUsd).toBeCloseTo(350, 6);
    expect(e.avgLossUsd).toBeCloseTo(200, 6);
    expect(e.profitFactor).toBeCloseTo(3.5, 6);
    expect(e.payoffRatio).toBeCloseTo(1.75, 6);
    expect(e.expectancyUsd).toBeCloseTo(500 / 3, 6);
  });

  it("no losses → profitFactor & payoff null; flat closes count but don't decide", () => {
    const allWins = computeEdge([100, 50]);
    expect(allWins.profitFactor).toBeNull();
    expect(allWins.payoffRatio).toBeNull();
    expect(allWins.avgLossUsd).toBeNull();
    // A sub-epsilon close is still a close, but neither a win nor a loss.
    const withFlat = computeEdge([100, 1e-9, -40]);
    expect(withFlat.closes).toBe(3);
    expect(withFlat.wins).toBe(1);
    expect(withFlat.losses).toBe(1);
    expect(withFlat.winRatePct).toBeCloseTo(50, 6);
  });

  it("empty → 0 closes, all ratios null (maps onto a no-trades strategy)", () => {
    const e = computeEdge([]);
    expect(e.closes).toBe(0);
    expect(e.realizedUsd).toBe(0);
    expect(e.winRatePct).toBeNull();
    expect(e.profitFactor).toBeNull();
    expect(e.payoffRatio).toBeNull();
    expect(e.expectancyUsd).toBeNull();
  });
});

// ── coherence: live strategy-compare ≡ backtest edge (shared computeEdge, v121) ──
// The whole point of the edge arc is that "does this strategy have an edge?"
// reads identically at every trust gate. This pins it: the SAME round-trips,
// fed through the live comparison (StrategyTradeLite → cost-basis walk) and the
// backtest (BacktestFire → cost-basis walk), must yield identical edge metrics.
describe("coherence: strategy-compare edge ≡ backtest edge (same round-trips)", () => {
  // Each entry: buy `base` for `usd`, later sell the same base for `usd`.
  const ROUND_TRIPS: Array<{ base: number; buyUsd: number; sellUsd: number }> = [
    { base: 1, buyUsd: 2000, sellUsd: 2500 }, // +500 win
    { base: 2, buyUsd: 3000, sellUsd: 3300 }, // +300 win
    { base: 1, buyUsd: 2000, sellUsd: 1750 }, // -250 loss
    { base: 0.5, buyUsd: 900, sellUsd: 900 }, // flat
  ];

  it("identical profit factor / payoff / win rate / expectancy / closes", () => {
    // Live path: USDC-quoted lite rows (tradeUsd = quote, $1 stable model).
    const lite: StrategyTradeLite[] = [];
    let day = 1;
    const ts = () => `2026-03-${String(day++).padStart(2, "0")}T00:00:00Z`;
    for (const rt of ROUND_TRIPS) {
      lite.push({ strategy: "edge-coherence", chain: "base", direction: "buy", base_token: "0xWETH", base_symbol: "WETH", base_amount: String(rt.base), quote_amount: String(rt.buyUsd), quote_symbol: "USDC", value_usd: null, timestamp: ts() });
      lite.push({ strategy: "edge-coherence", chain: "base", direction: "sell", base_token: "0xWETH", base_symbol: "WETH", base_amount: String(rt.base), quote_amount: String(rt.sellUsd), quote_symbol: "USDC", value_usd: null, timestamp: ts() });
    }
    const live = computeStrategyComparison(lite, { now: new Date("2026-03-31T00:00:00Z") }).strategies[0];

    // Backtest path: fires with quote ≈ USD (buy quoteDelta negative, sell positive).
    const fires: BacktestFire[] = [];
    day = 1;
    for (const rt of ROUND_TRIPS) {
      fires.push({ ts: ts(), action: "fill", priceUsd: rt.buyUsd / rt.base, baseDelta: rt.base, quoteDelta: -rt.buyUsd });
      fires.push({ ts: ts(), action: "fill", priceUsd: rt.sellUsd / rt.base, baseDelta: -rt.base, quoteDelta: rt.sellUsd });
    }
    const edge = tradeEdgeFromFires(fires)!;

    expect(live.closes).toBe(edge.closes);
    expect(live.wins).toBe(edge.wins);
    expect(live.losses).toBe(edge.losses);
    expect(live.winRatePct).toBeCloseTo(edge.winRatePct!, 9);
    expect(live.profitFactor).toBeCloseTo(edge.profitFactor!, 9);
    expect(live.payoffRatio).toBeCloseTo(edge.payoffRatio!, 9);
    expect(live.avgWinUsd).toBeCloseTo(edge.avgWinUsd!, 9);
    expect(live.avgLossUsd).toBeCloseTo(edge.avgLossUsd!, 9);
    expect(live.avgRealizedPerClose).toBeCloseTo(edge.expectancyUsd!, 9);
    expect(live.realizedUsd).toBeCloseTo(edge.realizedUsd, 9);
  });
});
