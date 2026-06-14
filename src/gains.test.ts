/**
 * Realized-gains report tests (v36).
 *
 * Layers:
 *   1. Walker realizations (computePaperPnlMtm.realizations) — exact
 *      weighted-average math per sell, oversell untracked split
 *   2. gatherRealizedGains — real-mode adapter (success-only,
 *      tx_hash rides along), FULL-history basis with windowed
 *      output, paper mode, filters
 *   3. gainsToCsv — header, escaping, precision
 *   4. yearWindow
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-gains-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { gatherRealizedGains, gainsToCsv, yearWindow } = await import("./gains.js");
const { computePaperPnlMtm } = await import("./paperPnl.js");
const { openDb, closeDb, insertTrade, recordPaperTrade } = await import("./db.js");
import type { PaperTradeRow } from "./db.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  openDb().exec("DELETE FROM trades; DELETE FROM paper_trades");
});

function mkRow(over: Partial<PaperTradeRow> & { id: number; timestamp: string; direction: string; base_amount: string; quote_amount: string }): PaperTradeRow {
  return {
    source_type: "manual",
    source_id: null,
    chain: "base",
    account: "default",
    base_token: WETH,
    base_symbol: "WETH",
    quote_token: USDC,
    quote_symbol: "USDC",
    price: "0",
    slippage_bps: null,
    strategy: "tax-test",
    notes: null,
    ...over,
  } as PaperTradeRow;
}

// ── walker realizations ──────────────────────────────────────

describe("computePaperPnlMtm — realizations", () => {
  it("weighted-average math, exact per sell", async () => {
    const rows = [
      mkRow({ id: 1, timestamp: "2026-01-01T00:00:00Z", direction: "buy", base_amount: "1", quote_amount: "2000" }),
      mkRow({ id: 2, timestamp: "2026-02-01T00:00:00Z", direction: "buy", base_amount: "1", quote_amount: "3000" }),
      // avg cost now 2500. Sell 1 @ 2800 → gain 300.
      mkRow({ id: 3, timestamp: "2026-03-01T00:00:00Z", direction: "sell", base_amount: "1", quote_amount: "2800" }),
    ];
    const report = await computePaperPnlMtm(rows, async () => null);
    expect(report.realizations).toHaveLength(1);
    const r = report.realizations[0];
    expect(r.soldAmount).toBe(1);
    expect(r.avgCostQuote).toBeCloseTo(2500, 9);
    expect(r.sellPriceQuote).toBeCloseTo(2800, 9);
    expect(r.proceedsQuote).toBeCloseTo(2800, 9);
    expect(r.costBasisQuote).toBeCloseTo(2500, 9);
    expect(r.gainQuote).toBeCloseTo(300, 9);
    expect(r.untrackedAmount).toBe(0);
    expect(r.strategy).toBe("tax-test");
  });

  it("the remaining position keeps the avg basis for the NEXT sell", async () => {
    const rows = [
      mkRow({ id: 1, timestamp: "2026-01-01T00:00:00Z", direction: "buy", base_amount: "2", quote_amount: "4000" }), // avg 2000
      mkRow({ id: 2, timestamp: "2026-02-01T00:00:00Z", direction: "sell", base_amount: "1", quote_amount: "2500" }), // gain 500
      mkRow({ id: 3, timestamp: "2026-03-01T00:00:00Z", direction: "sell", base_amount: "1", quote_amount: "1800" }), // gain -200
    ];
    const report = await computePaperPnlMtm(rows, async () => null);
    expect(report.realizations).toHaveLength(2);
    expect(report.realizations[0].gainQuote).toBeCloseTo(500, 9);
    expect(report.realizations[1].gainQuote).toBeCloseTo(-200, 9);
    expect(report.realizations[1].avgCostQuote).toBeCloseTo(2000, 9);
  });

  it("oversell splits into tracked gain + untracked proceeds", async () => {
    const rows = [
      mkRow({ id: 1, timestamp: "2026-01-01T00:00:00Z", direction: "buy", base_amount: "1", quote_amount: "2000" }),
      // Sell 1.5: 1 tracked (gain vs 2000), 0.5 untracked.
      mkRow({ id: 2, timestamp: "2026-02-01T00:00:00Z", direction: "sell", base_amount: "1.5", quote_amount: "3600" }), // 2400/unit
    ];
    const report = await computePaperPnlMtm(rows, async () => null);
    const r = report.realizations[0];
    expect(r.soldAmount).toBeCloseTo(1, 9);
    expect(r.gainQuote).toBeCloseTo(400, 9); // (2400-2000)×1
    expect(r.untrackedAmount).toBeCloseTo(0.5, 9);
    expect(r.untrackedProceedsQuote).toBeCloseTo(1200, 9);
  });
});

// ── gatherRealizedGains ──────────────────────────────────────

function seedRealTrade(over: Record<string, unknown>): void {
  insertTrade({
    chain: "base", account: "default",
    base_token: WETH, base_symbol: "WETH",
    quote_token: USDC, quote_symbol: "USDC",
    price: "0",
    gas_used: null, gas_price_wei: null, gas_cost_native: null,
    aggregator: "kyberswap", fee_tier: null, notes: null,
    strategy: "tax-test", realized_slippage_bps: null,
    status: "success",
    ...over,
  } as never);
}

describe("gatherRealizedGains", () => {
  it("real mode: success-only, tx_hash rides along, totals exact", async () => {
    seedRealTrade({ timestamp: "2026-01-10T00:00:00Z", direction: "buy", base_amount: "1", quote_amount: "2000", tx_hash: "0xbuy1" });
    seedRealTrade({ timestamp: "2026-04-10T00:00:00Z", direction: "sell", base_amount: "1", quote_amount: "2600", tx_hash: "0xsell1" });
    // A failed trade must NOT enter the basis.
    seedRealTrade({ timestamp: "2026-02-10T00:00:00Z", direction: "buy", base_amount: "5", quote_amount: "1", tx_hash: "0xfail", status: "failed" });

    const r = await gatherRealizedGains({ mode: "real" });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].txHash).toBe("0xsell1");
    expect(r.records[0].gainQuote).toBeCloseTo(600, 9);
    expect(r.totalGainQuote).toBeCloseTo(600, 9);
    expect(r.totalProceedsQuote).toBeCloseTo(2600, 9);
    expect(r.totalCostBasisQuote).toBeCloseTo(2000, 9);
  });

  it("window filters OUTPUT records but the basis walk sees full history", async () => {
    // 2025 buy funds the 2026 sell's basis.
    seedRealTrade({ timestamp: "2025-06-01T00:00:00Z", direction: "buy", base_amount: "1", quote_amount: "1000", tx_hash: "0xold" });
    seedRealTrade({ timestamp: "2026-06-01T00:00:00Z", direction: "sell", base_amount: "1", quote_amount: "1500", tx_hash: "0xnew" });
    const w = yearWindow(2026);
    const r = await gatherRealizedGains({ mode: "real", sinceIso: w.sinceIso, untilIso: w.untilIso });
    expect(r.records).toHaveLength(1);
    // Gain computed against the 2025 basis — NOT an untracked sell.
    expect(r.records[0].gainQuote).toBeCloseTo(500, 9);
    expect(r.records[0].untrackedAmount).toBe(0);

    // The 2025 window shows zero realizations (the buy realized nothing).
    const w25 = yearWindow(2025);
    const r25 = await gatherRealizedGains({ mode: "real", sinceIso: w25.sinceIso, untilIso: w25.untilIso });
    expect(r25.records).toHaveLength(0);
  });

  it("paper mode walks the virtual fills", async () => {
    recordPaperTrade({
      timestamp: "2026-01-01T00:00:00Z", source_type: "manual", source_id: null,
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "WETH", base_amount: "1",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "2000",
      price: "2000", slippage_bps: null, strategy: "p", notes: null,
    });
    recordPaperTrade({
      timestamp: "2026-02-01T00:00:00Z", source_type: "manual", source_id: null,
      chain: "base", account: "default", direction: "sell",
      base_token: WETH, base_symbol: "WETH", base_amount: "1",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "2300",
      price: "2300", slippage_bps: null, strategy: "p", notes: null,
    });
    const r = await gatherRealizedGains({ mode: "paper" });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].gainQuote).toBeCloseTo(300, 9);
    expect(r.records[0].txHash).toBeNull(); // paper fills have no chain tx
  });
});

// ── CSV + window helpers ─────────────────────────────────────

describe("gainsToCsv", () => {
  it("escapes commas and quotes, keeps full precision", () => {
    const csv = gainsToCsv([
      {
        at: "2026-03-01T00:00:00Z", strategy: 'has,comma "and" quotes', chain: "base",
        token: WETH, symbol: "WETH",
        soldAmount: 0.123456789, sellPriceQuote: 2800, avgCostQuote: 2500,
        proceedsQuote: 345.679, costBasisQuote: 308.642, gainQuote: 37.037,
        untrackedAmount: 0, untrackedProceedsQuote: 0, txHash: "0xabc",
        acquiredAt: "2025-01-01T00:00:00.000Z", holdingDays: 424, term: "long",
      },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toMatch(/^date,strategy,chain,token,symbol/);
    expect(lines[1]).toContain('"has,comma ""and"" quotes"');
    expect(lines[1]).toContain("0.123456789");
  });
});

describe("yearWindow", () => {
  it("UTC calendar bounds + validation", () => {
    const w = yearWindow(2026);
    expect(w.sinceIso).toBe("2026-01-01T00:00:00.000Z");
    expect(w.untilIso).toBe("2026-12-31T23:59:59.999Z");
    expect(() => yearWindow(99)).toThrow(/calendar year/);
  });
});

// ── v60: holding period + short/long-term classification ─────

describe("walker holding-period + term", () => {
  // Day offsets from a fixed UTC anchor → deterministic timestamps.
  const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
  const buy = (id: number, t: string, base: string, quote: string) =>
    mkRow({ id, timestamp: t, direction: "buy", base_amount: base, quote_amount: quote });
  const sell = (id: number, t: string, base: string, quote: string) =>
    mkRow({ id, timestamp: t, direction: "sell", base_amount: base, quote_amount: quote });

  it("classifies a >365d hold as long-term with the acquisition date + holding days", async () => {
    const rows = [buy(1, day(0), "1", "2000"), sell(2, day(400), "1", "3000")];
    const { realizations } = await computePaperPnlMtm(rows, async () => null);
    const r = realizations[0];
    expect(r.term).toBe("long");
    expect(r.holdingDays).toBeCloseTo(400, 6);
    expect(r.acquiredAt).toBe(day(0));
  });

  it("classifies a ≤365d hold as short-term", async () => {
    const rows = [buy(1, day(0), "1", "2000"), sell(2, day(90), "1", "2500")];
    const { realizations } = await computePaperPnlMtm(rows, async () => null);
    expect(realizations[0].term).toBe("short");
    expect(realizations[0].holdingDays).toBeCloseTo(90, 6);
  });

  it("blends the acquisition date weighted by amount across multiple buys", async () => {
    // 1 ETH at day 0 + 1 ETH at day 100 → weighted-avg acquisition = day 50.
    const rows = [buy(1, day(0), "1", "2000"), buy(2, day(100), "1", "2000"), sell(3, day(200), "1", "3000")];
    const { realizations } = await computePaperPnlMtm(rows, async () => null);
    expect(realizations[0].acquiredAt).toBe(day(50));
    expect(realizations[0].holdingDays).toBeCloseTo(150, 6); // day200 − day50
    expect(realizations[0].term).toBe("short");
  });

  it("resets the acquisition clock after the position goes flat", async () => {
    // Buy+fully-sell, then a fresh buy much later + sell → the second sale's
    // holding period must count from the SECOND buy, not the first.
    const rows = [
      buy(1, day(0), "1", "2000"),
      sell(2, day(10), "1", "2100"),
      buy(3, day(400), "1", "2000"),
      sell(4, day(410), "1", "2200"),
    ];
    const { realizations } = await computePaperPnlMtm(rows, async () => null);
    expect(realizations).toHaveLength(2);
    expect(realizations[1].acquiredAt).toBe(day(400));
    expect(realizations[1].holdingDays).toBeCloseTo(10, 6);
    expect(realizations[1].term).toBe("short");
  });

  it("marks a sell with no tracked basis as 'untracked' (null acquisition)", async () => {
    const rows = [sell(1, day(5), "1", "2500")]; // oversell from zero
    const { realizations } = await computePaperPnlMtm(rows, async () => null);
    expect(realizations[0].term).toBe("untracked");
    expect(realizations[0].acquiredAt).toBeNull();
    expect(realizations[0].holdingDays).toBeNull();
  });
});

describe("gatherRealizedGains — byTerm split + byToken rollup", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
  const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";

  const pt = (over: { timestamp: string; direction: "buy" | "sell"; base_token: string; base_symbol: string; base_amount: string; quote_amount: string }) =>
    recordPaperTrade({
      source_type: "manual", source_id: null, chain: "base", account: "default",
      quote_token: USDC, quote_symbol: "USDC", price: "0", slippage_bps: null, strategy: "tax-test", notes: null,
      ...over,
    });

  it("splits gains into short/long subtotals and rolls up by token", async () => {
    // WETH: long-term winner (held 400d). WBTC: short-term (held 30d).
    pt({ timestamp: day(0), direction: "buy", base_token: WETH, base_symbol: "WETH", base_amount: "1", quote_amount: "2000" });
    pt({ timestamp: day(400), direction: "sell", base_token: WETH, base_symbol: "WETH", base_amount: "1", quote_amount: "3000" });
    pt({ timestamp: day(0), direction: "buy", base_token: WBTC, base_symbol: "WBTC", base_amount: "1", quote_amount: "40000" });
    pt({ timestamp: day(30), direction: "sell", base_token: WBTC, base_symbol: "WBTC", base_amount: "1", quote_amount: "41000" });

    const r = await gatherRealizedGains({ mode: "paper" });
    expect(r.byTerm.long.gainQuote).toBeCloseTo(1000, 6); // WETH +1000
    expect(r.byTerm.long.realizations).toBe(1);
    expect(r.byTerm.short.gainQuote).toBeCloseTo(1000, 6); // WBTC +1000
    expect(r.byTerm.short.realizations).toBe(1);

    // by-token rollup, gain-descending (tie → stable); both present.
    expect(r.byToken).toHaveLength(2);
    const weth = r.byToken.find((t) => t.symbol === "WETH")!;
    const wbtc = r.byToken.find((t) => t.symbol === "WBTC")!;
    expect(weth.gainQuote).toBeCloseTo(1000, 6);
    expect(wbtc.proceedsQuote).toBeCloseTo(41000, 6);
  });
});
