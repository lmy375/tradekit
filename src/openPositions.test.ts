/**
 * Open-position review tests (v65). The holding-period → projected-tax-term
 * logic (long if held >365d, short + days-to-long otherwise, the approaching
 * flag) is the load-bearing new bit; cost basis + unrealized come from the
 * shared walker. Deterministic: paper fills seeded into a temp DB + an
 * injected mark price + a fixed `now`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-openpos-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { gatherOpenPositions, APPROACHING_LONG_TERM_DAYS } = await import("./openPositions.js");
const { openDb, closeDb, recordPaperTrade } = await import("./db.js");
const { __clearSeriesCache } = await import("./backtest.js");

const WETH = "0x4200000000000000000000000000000000000006";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NOW = new Date("2026-06-14T00:00:00Z");
const DAY = 86_400_000;
const day = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();

beforeAll(() => { openDb(); });
afterAll(() => { closeDb(); rmSync(tmpDataDir, { recursive: true, force: true }); });
beforeEach(() => { openDb().exec("DELETE FROM paper_trades"); __clearSeriesCache(); });

function trade(o: { ts: string; dir: "buy" | "sell"; base?: string; sym?: string; amount: string; quote: string }) {
  recordPaperTrade({
    timestamp: o.ts, source_type: "manual", source_id: null, chain: "base", account: "default",
    direction: o.dir, base_token: o.base ?? WETH, base_symbol: o.sym ?? "WETH", base_amount: o.amount,
    quote_token: USDC, quote_symbol: "USDC", quote_amount: o.quote, price: "0", slippage_bps: null,
    strategy: "p", notes: null,
  });
}

const mark = (price: number | null) => async () => price;
const gather = (markPrice: number | null = 3000) =>
  gatherOpenPositions({ mode: "paper", markPriceFn: mark(markPrice), now: NOW });

describe("gatherOpenPositions", () => {
  it("a position held >365d projects long-term with no days-to-long", async () => {
    trade({ ts: day(-400), dir: "buy", amount: "1", quote: "2000" });
    const r = await gather(3000);
    expect(r.positions).toHaveLength(1);
    const p = r.positions[0];
    expect(p.projectedTerm).toBe("long");
    expect(p.daysToLongTerm).toBeNull();
    expect(p.holdingDays).toBeCloseTo(400, 0);
    expect(p.costBasisQuote).toBeCloseTo(2000, 6);
    expect(p.valueQuote).toBeCloseTo(3000, 6);
    expect(p.unrealizedQuote).toBeCloseTo(1000, 6);
    expect(p.unrealizedPct).toBeCloseTo(50, 6);
    expect(p.acquiredAt).toBe(day(-400));
  });

  it("a position held <365d projects short-term with days-to-long-term", async () => {
    trade({ ts: day(-350), dir: "buy", amount: "1", quote: "2000" });
    const p = (await gather(2000)).positions[0];
    expect(p.projectedTerm).toBe("short");
    expect(p.daysToLongTerm).toBeCloseTo(15, 0); // 365 − 350
  });

  it("flags positions approaching long-term (within the window)", async () => {
    trade({ ts: day(-350), dir: "buy", amount: "1", quote: "2000" }); // 15d to long → approaching
    trade({ ts: day(-100), dir: "buy", base: WBTC, sym: "WBTC", amount: "1", quote: "40000" }); // 265d → not
    const r = await gather(1);
    expect(APPROACHING_LONG_TERM_DAYS).toBe(30);
    expect(r.approachingLongTerm).toBe(1);
  });

  it("weighted-average acquisition date blends multiple buys", async () => {
    trade({ ts: day(-300), dir: "buy", amount: "1", quote: "2000" });
    trade({ ts: day(-100), dir: "buy", amount: "1", quote: "2000" }); // blend → day(-200)
    const p = (await gather(2500)).positions[0];
    expect(p.acquiredAt).toBe(day(-200));
    expect(p.holdingDays).toBeCloseTo(200, 0);
    expect(p.amount).toBeCloseTo(2, 6);
    expect(p.costBasisQuote).toBeCloseTo(4000, 6);
  });

  it("excludes fully-closed positions", async () => {
    trade({ ts: day(-100), dir: "buy", amount: "1", quote: "2000" });
    trade({ ts: day(-50), dir: "sell", amount: "1", quote: "2500" });
    const r = await gather(3000);
    expect(r.positions).toHaveLength(0);
  });

  it("handles an unpriced position (null mark) without breaking", async () => {
    trade({ ts: day(-10), dir: "buy", amount: "1", quote: "2000" });
    const r = await gather(null);
    const p = r.positions[0];
    expect(p.currentPriceQuote).toBeNull();
    expect(p.valueQuote).toBeNull();
    expect(p.unrealizedQuote).toBeNull();
    expect(r.unpricedCount).toBe(1);
    // Cost basis + holding period are exact even without a mark.
    expect(p.costBasisQuote).toBeCloseTo(2000, 6);
    expect(p.projectedTerm).toBe("short");
  });

  it("withContext attaches price context for mapped tokens, null for unmapped", async () => {
    trade({ ts: day(-30), dir: "buy", amount: "1", quote: "2000" }); // WETH → coinId ethereum
    trade({ ts: day(-30), dir: "buy", base: WBTC, sym: "WBTC", amount: "1", quote: "40000" }); // no mapping
    const prices: [number, number][] = [100, 110, 120, 130, 140].map((p, i) => [NOW.getTime() - (4 - i) * DAY, p]);
    const r = await gatherOpenPositions({
      mode: "paper", markPriceFn: mark(3000), now: NOW,
      withContext: true, seriesFetchImpl: async () => ({ prices }),
    });
    const weth = r.positions.find((p) => p.symbol === "WETH")!;
    const wbtc = r.positions.find((p) => p.symbol === "WBTC")!;
    expect(weth.priceContext).not.toBeNull();
    expect(weth.priceContext!.rangePositionPct).toBeCloseTo(100, 0); // current at the high
    expect(weth.priceContext!.changePctWindow).toBeCloseTo(40, 0);
    expect(weth.priceContext!.summary).toMatch(/over 7d/);
    expect(wbtc.priceContext).toBeNull(); // no CoinGecko mapping → graceful null
  });

  it("omits priceContext entirely when withContext is off (default)", async () => {
    trade({ ts: day(-30), dir: "buy", amount: "1", quote: "2000" });
    const r = await gather(3000);
    expect(r.positions[0].priceContext).toBeUndefined();
  });

  it("aggregates portfolio totals across positions", async () => {
    trade({ ts: day(-400), dir: "buy", amount: "1", quote: "2000" }); // WETH
    trade({ ts: day(-30), dir: "buy", base: WBTC, sym: "WBTC", amount: "1", quote: "40000" });
    const r = await gather(3000); // both marked at 3000/unit
    expect(r.totalCostBasisQuote).toBeCloseTo(42000, 6);
    expect(r.totalValueQuote).toBeCloseTo(6000, 6); // 2 positions × 3000
    expect(r.totalUnrealizedQuote).toBeCloseTo(6000 - 42000, 6);
  });
});
