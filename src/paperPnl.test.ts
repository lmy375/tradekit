/**
 * Paper mark-to-market P&L core tests.
 *
 * computePaperPnlMtm() is pure modulo the injected price fetcher, so
 * everything here runs offline with literal PaperTradeRow fixtures —
 * no DB, no network, no mocks of module boundaries.
 *
 * Covers the parts that are easy to get subtly wrong:
 *   - weighted-average cost basis (buy/sell/partial-sell math)
 *   - the oversell cap (deposit-seeded inventory realizes nothing)
 *   - chronological re-sort (listPaperTrades returns newest-first;
 *     cost basis is path-dependent)
 *   - non-stablecoin-quote exclusion
 *   - unpriced positions (oracle returns null / throws)
 *   - per-(chain,token) price memoization across strategy buckets
 *   - legacy-field parity with summarizePaperPnl
 */

import { describe, it, expect } from "vitest";
import type { PaperTradeRow } from "./db.js";
import { computePaperPnlMtm, type PaperPriceFetcher } from "./paperPnl.js";
import { summarizePaperPnl } from "./paperTrade.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PEPE = "0x6982508145454ce325ddbe47a25d4ec3d2311933";

let nextId = 1;

function row(overrides: Partial<PaperTradeRow>): PaperTradeRow {
  return {
    id: nextId++,
    timestamp: "2026-06-01T00:00:00.000Z",
    source_type: "manual",
    source_id: null,
    chain: "base",
    account: "default",
    direction: "buy",
    base_token: WETH,
    base_symbol: "WETH",
    base_amount: "1",
    quote_token: USDC,
    quote_symbol: "USDC",
    quote_amount: "2000",
    price: "2000",
    slippage_bps: null,
    strategy: "dca-eth",
    notes: null,
    value_usd: null,
    ...overrides,
  };
}

/** Price fetcher stub: fixed price map keyed by lowercase token, with a
 *  call counter for memoization assertions. */
function stubPrices(prices: Record<string, number | null>): { fetch: PaperPriceFetcher; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (chain, token) => {
      calls.push(`${chain}:${token.toLowerCase()}`);
      const p = prices[token.toLowerCase()];
      return p ?? null;
    },
  };
}

describe("computePaperPnlMtm — cost basis", () => {
  it("single buy: open position at avg cost, unrealized = amount × (mark − cost)", async () => {
    const rows = [row({ base_amount: "2", quote_amount: "4000", timestamp: "2026-06-01T00:00:00Z" })];
    const { fetch } = stubPrices({ [WETH.toLowerCase()]: 2500 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);

    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.strategy).toBe("dca-eth");
    expect(s.realizedQuote).toBe(0);
    expect(s.positions).toHaveLength(1);
    const p = s.positions[0];
    expect(p.amount).toBeCloseTo(2);
    expect(p.avgCostQuote).toBeCloseTo(2000);
    expect(p.currentPriceQuote).toBe(2500);
    expect(p.unrealizedQuote).toBeCloseTo(2 * 500);
    expect(p.valueQuote).toBeCloseTo(5000);
    expect(s.unrealizedQuote).toBeCloseTo(1000);
    expect(s.totalQuote).toBeCloseTo(1000);
    expect(s.openValueQuote).toBeCloseTo(5000);
  });

  it("partial sell realizes against weighted-average cost and keeps the remainder open", async () => {
    // Buy 1 @ 2000, buy 1 @ 3000 → avg 2500. Sell 1 @ 2800 → realized +300.
    const rows = [
      row({ base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      row({ base_amount: "1", quote_amount: "3000", timestamp: "2026-06-02T00:00:00Z" }),
      row({ direction: "sell", base_amount: "1", quote_amount: "2800", timestamp: "2026-06-03T00:00:00Z" }),
    ];
    const { fetch } = stubPrices({ [WETH.toLowerCase()]: 2600 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const s = summaries[0];
    expect(s.realizedQuote).toBeCloseTo(300);
    const p = s.positions[0];
    expect(p.amount).toBeCloseTo(1);
    expect(p.avgCostQuote).toBeCloseTo(2500); // cost basis unchanged by the sell
    expect(p.unrealizedQuote).toBeCloseTo(100); // 1 × (2600 − 2500)
    expect(s.totalQuote).toBeCloseTo(400);
  });

  it("full round-trip leaves a flat position with unrealizedQuote 0 for the bucket", async () => {
    const rows = [
      row({ base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "1", quote_amount: "2500", timestamp: "2026-06-02T00:00:00Z" }),
    ];
    const { fetch, calls } = stubPrices({ [WETH.toLowerCase()]: 9999 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const s = summaries[0];
    expect(s.realizedQuote).toBeCloseTo(500);
    expect(s.unrealizedQuote).toBe(0); // no open positions → 0, not null
    expect(s.totalQuote).toBeCloseTo(500);
    expect(s.openValueQuote).toBe(0);
    expect(calls).toHaveLength(0); // flat positions are never priced
    expect(s.positions[0].amount).toBeCloseTo(0);
  });

  it("oversell (deposit-seeded inventory) caps realization and reports the untracked portion", async () => {
    // No paper buy ever happened — the operator deposited 1 ETH and the
    // strategy sold it. Cost basis is unknown: realize NOTHING, surface
    // the proceeds via untrackedSellQuote.
    const rows = [row({ direction: "sell", base_amount: "1", quote_amount: "3000" })];
    const { fetch } = stubPrices({});
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const s = summaries[0];
    expect(s.realizedQuote).toBe(0);
    const p = s.positions[0];
    expect(p.untrackedSellBase).toBeCloseTo(1);
    expect(p.untrackedSellQuote).toBeCloseTo(3000);
    // Legacy cash-flow fields still see the full proceeds.
    expect(s.quoteReceived).toBeCloseTo(3000);
    expect(s.netQuote).toBeCloseTo(3000);
  });

  it("mixed oversell: tracked part realizes, excess is untracked", async () => {
    // Buy 1 @ 2000, sell 1.5 @ 2400/unit (quote 3600). Tracked 1 realizes
    // +400; the 0.5 excess (1200 proceeds) is untracked.
    const rows = [
      row({ base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "1.5", quote_amount: "3600", timestamp: "2026-06-02T00:00:00Z" }),
    ];
    const { fetch } = stubPrices({});
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const s = summaries[0];
    expect(s.realizedQuote).toBeCloseTo(400);
    const p = s.positions[0];
    expect(p.amount).toBeCloseTo(0);
    expect(p.untrackedSellBase).toBeCloseTo(0.5);
    expect(p.untrackedSellQuote).toBeCloseTo(1200);
  });

  it("re-sorts newest-first input chronologically before walking (path-dependent math)", async () => {
    // listPaperTrades returns DESC. Delivered in that order, a naive walk
    // would process the sell first (oversell) and the buy second (open
    // position) — realized 0, position 1. Correct chronological walk:
    // realized +500, flat.
    const rows = [
      row({ direction: "sell", base_amount: "1", quote_amount: "2500", timestamp: "2026-06-02T00:00:00Z" }),
      row({ base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
    ];
    const { fetch } = stubPrices({});
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const s = summaries[0];
    expect(s.realizedQuote).toBeCloseTo(500);
    expect(s.positions[0].amount).toBeCloseTo(0);
    expect(s.positions[0].untrackedSellBase).toBe(0);
  });

  it("same-timestamp fills break ties by id", async () => {
    const ts = "2026-06-01T00:00:00Z";
    const buy = row({ base_amount: "1", quote_amount: "2000", timestamp: ts });
    const sell = row({ direction: "sell", base_amount: "1", quote_amount: "2600", timestamp: ts });
    // buy got the lower id (created first) — even shuffled, buy walks first.
    const { fetch } = stubPrices({});
    const { summaries } = await computePaperPnlMtm([sell, buy], fetch);
    expect(summaries[0].realizedQuote).toBeCloseTo(600);
  });
});

describe("computePaperPnlMtm — quote + pricing edge cases", () => {
  it("non-stablecoin-quote fills are excluded from cost basis and counted", async () => {
    const rows = [
      row({ base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      // PEPE/WETH fill — volatile quote, no USD anchor at trade time.
      row({
        base_token: PEPE,
        base_symbol: "PEPE",
        base_amount: "1000000",
        quote_token: WETH,
        quote_symbol: "WETH",
        quote_amount: "0.5",
        timestamp: "2026-06-02T00:00:00Z",
      }),
    ];
    const { fetch } = stubPrices({ [WETH.toLowerCase()]: 2000 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const s = summaries[0];
    expect(s.skippedNonStableQuote).toBe(1);
    // Only the USDC-quoted WETH position exists.
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0].token).toBe(WETH);
    // Legacy fields still count BOTH fills (cash-flow semantics).
    expect(s.fills).toBe(2);
  });

  it("unpriced open position: null unrealized, bucket counts it, total stays partial", async () => {
    const rows = [
      row({ base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      row({
        base_token: PEPE,
        base_symbol: "PEPE",
        base_amount: "1000",
        quote_amount: "100",
        timestamp: "2026-06-02T00:00:00Z",
      }),
    ];
    // WETH priced, PEPE not.
    const { fetch } = stubPrices({ [WETH.toLowerCase()]: 2500 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const s = summaries[0];
    expect(s.unpricedPositionCount).toBe(1);
    const weth = s.positions.find((p) => p.token === WETH)!;
    const pepe = s.positions.find((p) => p.token === PEPE)!;
    expect(weth.unrealizedQuote).toBeCloseTo(500);
    expect(pepe.unrealizedQuote).toBeNull();
    expect(pepe.valueQuote).toBeNull();
    // Partial sum: only the priced position contributes.
    expect(s.unrealizedQuote).toBeCloseTo(500);
  });

  it("unrealizedQuote is null (not 0) when EVERY open position is unpriced", async () => {
    const rows = [row({ base_amount: "1", quote_amount: "2000" })];
    const { fetch } = stubPrices({}); // oracle has nothing
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const s = summaries[0];
    expect(s.unrealizedQuote).toBeNull();
    expect(s.totalQuote).toBeCloseTo(0); // realized only
    expect(s.unpricedPositionCount).toBe(1);
  });

  it("a throwing price fetcher degrades to unpriced instead of failing the report", async () => {
    const rows = [row({ base_amount: "1", quote_amount: "2000" })];
    const fetch: PaperPriceFetcher = async () => {
      throw new Error("oracle down");
    };
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    expect(summaries[0].unpricedPositionCount).toBe(1);
    expect(summaries[0].positions[0].currentPriceQuote).toBeNull();
  });

  it("non-positive oracle prices are treated as unpriced", async () => {
    const rows = [row({ base_amount: "1", quote_amount: "2000" })];
    const { fetch } = stubPrices({ [WETH.toLowerCase()]: 0 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    expect(summaries[0].positions[0].currentPriceQuote).toBeNull();
    expect(summaries[0].unpricedPositionCount).toBe(1);
  });

  it("memoizes price calls per (chain, token) across strategy buckets", async () => {
    const rows = [
      row({ strategy: "alpha", base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      row({ strategy: "beta", base_amount: "2", quote_amount: "4000", timestamp: "2026-06-01T01:00:00Z" }),
      row({ strategy: "gamma", base_amount: "3", quote_amount: "6000", timestamp: "2026-06-01T02:00:00Z" }),
    ];
    const { fetch, calls } = stubPrices({ [WETH.toLowerCase()]: 2500 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    expect(summaries).toHaveLength(3);
    expect(calls).toHaveLength(1); // one oracle call for WETH, shared by all 3 buckets
    for (const s of summaries) expect(s.positions[0].currentPriceQuote).toBe(2500);
  });

  it("positions on different chains are tracked (and priced) separately", async () => {
    const rows = [
      row({ chain: "base", base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      row({ chain: "arbitrum", base_amount: "1", quote_amount: "2100", timestamp: "2026-06-01T01:00:00Z" }),
    ];
    const { fetch, calls } = stubPrices({ [WETH.toLowerCase()]: 2500 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const s = summaries[0];
    expect(s.positions).toHaveLength(2);
    expect(calls.sort()).toEqual([`arbitrum:${WETH.toLowerCase()}`, `base:${WETH.toLowerCase()}`]);
    expect(s.positions.map((p) => p.avgCostQuote).sort((a, b) => a - b)).toEqual([2000, 2100]);
  });
});

describe("computePaperPnlMtm — bucket semantics", () => {
  it("strategies bucket independently; null strategy folds into (unattributed)", async () => {
    const rows = [
      row({ strategy: "alpha", base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      row({ strategy: null, base_amount: "1", quote_amount: "3000", timestamp: "2026-06-01T01:00:00Z" }),
      row({ strategy: null, direction: "sell", base_amount: "1", quote_amount: "3300", timestamp: "2026-06-01T02:00:00Z" }),
    ];
    const { fetch } = stubPrices({ [WETH.toLowerCase()]: 2500 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const names = summaries.map((s) => s.strategy).sort();
    expect(names).toEqual(["(unattributed)", "alpha"]);
    const unattr = summaries.find((s) => s.strategy === "(unattributed)")!;
    expect(unattr.realizedQuote).toBeCloseTo(300);
    const alpha = summaries.find((s) => s.strategy === "alpha")!;
    expect(alpha.realizedQuote).toBe(0);
    expect(alpha.unrealizedQuote).toBeCloseTo(500);
  });

  it("legacy fields exactly match summarizePaperPnl for the same rows", async () => {
    const rows = [
      row({ strategy: "alpha", base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      row({ strategy: "alpha", direction: "sell", base_amount: "0.5", quote_amount: "1300", timestamp: "2026-06-02T00:00:00Z" }),
      row({ strategy: "beta", base_amount: "2", quote_amount: "5000", timestamp: "2026-06-03T00:00:00Z" }),
    ];
    const { fetch } = stubPrices({ [WETH.toLowerCase()]: 2500 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const legacy = summarizePaperPnl(rows);
    for (const l of legacy) {
      const m = summaries.find((s) => s.strategy === l.strategy)!;
      expect(m.fills).toBe(l.fills);
      expect(m.buys).toBe(l.buys);
      expect(m.sells).toBe(l.sells);
      expect(m.quoteSpent).toBeCloseTo(l.quoteSpent);
      expect(m.quoteReceived).toBeCloseTo(l.quoteReceived);
      expect(m.netQuote).toBeCloseTo(l.netQuote);
      expect(m.firstFillAt).toBe(l.firstFillAt);
      expect(m.lastFillAt).toBe(l.lastFillAt);
    }
  });

  it("summaries sort busiest-first (same ordering contract as the legacy summary)", async () => {
    const rows = [
      row({ strategy: "quiet", base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      row({ strategy: "busy", base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T01:00:00Z" }),
      row({ strategy: "busy", base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T02:00:00Z" }),
    ];
    const { fetch } = stubPrices({ [WETH.toLowerCase()]: 2000 });
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    expect(summaries[0].strategy).toBe("busy");
  });

  it("empty input → empty report", async () => {
    const { fetch, calls } = stubPrices({});
    const { summaries, timestamp } = await computePaperPnlMtm([], fetch);
    expect(summaries).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(typeof timestamp).toBe("string");
  });

  it("respects opts.nowIso for a deterministic report timestamp", async () => {
    const { fetch } = stubPrices({});
    const report = await computePaperPnlMtm([], fetch, { nowIso: "2026-06-10T12:00:00.000Z" });
    expect(report.timestamp).toBe("2026-06-10T12:00:00.000Z");
  });
});

// ── v31: realized trajectory ─────────────────────────────────

describe("computePaperPnlMtm — realizedTimeline", () => {
  it("emits one cumulative point per realizing sell, chronological", async () => {
    const rows = [
      row({ base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "0.5", quote_amount: "1200", timestamp: "2026-06-02T00:00:00Z" }), // +200
      row({ direction: "sell", base_amount: "0.5", quote_amount: "900", timestamp: "2026-06-03T00:00:00Z" }),  // -100 → cum +100
    ];
    const { fetch } = stubPrices({});
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const tl = summaries[0].realizedTimeline;
    expect(tl).toHaveLength(2);
    expect(tl[0]).toEqual({ at: "2026-06-02T00:00:00Z", cumulativeRealizedQuote: expect.closeTo(200, 6) });
    expect(tl[1].cumulativeRealizedQuote).toBeCloseTo(100, 6);
    // Final point equals the bucket's realizedQuote.
    expect(tl[1].cumulativeRealizedQuote).toBeCloseTo(summaries[0].realizedQuote, 9);
  });

  it("buys and fully-untracked sells contribute no points", async () => {
    const rows = [
      row({ base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }),
      // Pure deposit-inventory sell on a DIFFERENT token: nothing tracked.
      row({ direction: "sell", base_token: PEPE, base_symbol: "PEPE", base_amount: "100", quote_amount: "50", timestamp: "2026-06-02T00:00:00Z" }),
    ];
    const { fetch } = stubPrices({});
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    expect(summaries[0].realizedTimeline).toEqual([]);
  });

  it("cumulative is bucket-wide across multiple positions interleaved", async () => {
    const rows = [
      row({ base_amount: "1", quote_amount: "2000", timestamp: "2026-06-01T00:00:00Z" }), // WETH buy
      row({ base_token: PEPE, base_symbol: "PEPE", base_amount: "100", quote_amount: "100", timestamp: "2026-06-01T01:00:00Z" }), // PEPE buy
      row({ direction: "sell", base_amount: "1", quote_amount: "2300", timestamp: "2026-06-02T00:00:00Z" }), // WETH +300
      row({ direction: "sell", base_token: PEPE, base_symbol: "PEPE", base_amount: "100", quote_amount: "80", timestamp: "2026-06-03T00:00:00Z" }), // PEPE -20 → cum +280
    ];
    const { fetch } = stubPrices({});
    const { summaries } = await computePaperPnlMtm(rows, fetch);
    const tl = summaries[0].realizedTimeline;
    expect(tl.map((t) => t.cumulativeRealizedQuote)).toEqual([
      expect.closeTo(300, 6),
      expect.closeTo(280, 6),
    ]);
  });
});
