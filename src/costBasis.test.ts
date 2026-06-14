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
import { applyBuy, applySell, FLAT_EPSILON, type CostBasisState } from "./costBasis.js";
import { computePaperPnlMtm, type PaperPriceFetcher } from "./paperPnl.js";
import { netPosition, type FillRowLite } from "./positionCaps.js";
import type { PaperTradeRow } from "./db.js";

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
