/**
 * Execution quality report tests (v44) — seeded DB, exact aggregates.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-execreport-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { gatherExecutionReport, renderExecutionReport, slippageStats, median, percentile } =
  await import("./executionReport.js");
const { openDb, closeDb, insertTrade } = await import("./db.js");
import type { TradeRow } from "./db.js";

const NOW = new Date("2026-06-11T12:00:00Z");

function trade(over: Partial<TradeRow> = {}): Omit<TradeRow, "id"> {
  return {
    timestamp: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(), // 3d ago (inside 7d "recent")
    chain: "base",
    account: "default",
    direction: "buy",
    base_token: "0xweth",
    base_symbol: "WETH",
    base_amount: "0.1",
    quote_token: "0xusdc",
    quote_symbol: "USDC",
    quote_amount: "200",
    price: "2000",
    tx_hash: "0x" + Math.random().toString(16).slice(2).padStart(64, "0"),
    status: "success",
    gas_used: null,
    gas_price_wei: null,
    gas_cost_native: null,
    aggregator: "kyberswap",
    fee_tier: null,
    notes: null,
    realized_slippage_bps: null,
    ...over,
  };
}

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => { openDb().exec("DELETE FROM trades"); });

const gather = (over: Record<string, unknown> = {}) =>
  gatherExecutionReport({ windowLabel: "30d", sinceIso: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(), now: NOW, ...over });

describe("stat helpers", () => {
  it("median: odd middle, even midpoint-average; percentile p90 by ceil-rank", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    // 10 values 1..10: p90 = ceil(0.9×10)=9th element (index 8) = 9.
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5], 0.9)).toBe(5);
  });

  it("slippageStats keeps the SIGN (positive = unfavorable)", () => {
    const s = slippageStats([10, -5, 25]);
    expect(s.samples).toBe(3);
    expect(s.avgBps).toBeCloseTo(10, 9);
    expect(s.medianBps).toBe(10);
  });
});

describe("gatherExecutionReport — totals", () => {
  it("counts attempts/fills/failed, computes signed slippage stats and coverage", () => {
    insertTrade(trade({ realized_slippage_bps: 10 }));
    insertTrade(trade({ realized_slippage_bps: 20 }));
    insertTrade(trade({ realized_slippage_bps: null })); // fill without slippage → coverage 2/3
    insertTrade(trade({ status: "failed" }));
    const r = gather();
    expect(r.totals.attempts).toBe(4);
    expect(r.totals.fills).toBe(3);
    expect(r.totals.failed).toBe(1);
    expect(r.totals.successRatePct).toBeCloseTo(75, 9);
    expect(r.totals.usdVolume).toBeCloseTo(600, 9);
    expect(r.totals.slippage.samples).toBe(2);
    expect(r.totals.slippage.medianBps).toBe(15);
    expect(r.totals.slippageCoveragePct).toBeCloseTo((2 / 3) * 100, 6);
  });

  it("transfers/incoming and paper-free discipline: non-swap rows never count", () => {
    insertTrade(trade({ aggregator: "transfer" }));
    insertTrade(trade({ aggregator: "incoming" }));
    insertTrade(trade({ realized_slippage_bps: 12 }));
    const r = gather();
    expect(r.totals.attempts).toBe(1);
    expect(r.totals.fills).toBe(1);
  });

  it("gas aggregates per chain in native units", () => {
    insertTrade(trade({ gas_cost_native: "0.001" }));
    insertTrade(trade({ gas_cost_native: "0.003" }));
    insertTrade(trade({ chain: "arbitrum", gas_cost_native: "0.0001" }));
    const r = gather();
    const base = r.totals.gasByChain.find((g) => g.chain === "base")!;
    expect(base.totalNative).toBeCloseTo(0.004, 12);
    expect(base.avgNative).toBeCloseTo(0.002, 12);
    expect(base.samples).toBe(2);
    expect(r.totals.gasByChain.find((g) => g.chain === "arbitrum")!.samples).toBe(1);
  });
});

describe("gatherExecutionReport — cuts", () => {
  it("by aggregator: share, per-aggregator success rate, median slippage", () => {
    for (let i = 0; i < 3; i++) insertTrade(trade({ aggregator: "kyberswap", realized_slippage_bps: 10 + i }));
    insertTrade(trade({ aggregator: "kyberswap", status: "failed" }));
    insertTrade(trade({ aggregator: "odos", realized_slippage_bps: 30 }));
    const r = gather();
    const kyber = r.byAggregator.find((c) => c.aggregator === "kyberswap")!;
    expect(kyber.fills).toBe(3);
    expect(kyber.sharePct).toBeCloseTo(75, 9);
    expect(kyber.successRatePct).toBeCloseTo(75, 9);
    expect(kyber.slippage.medianBps).toBe(11);
    const odos = r.byAggregator.find((c) => c.aggregator === "odos")!;
    expect(odos.fills).toBe(1);
    expect(odos.successRatePct).toBe(100);
  });

  it("by size: bucket boundaries are [min, max)", () => {
    insertTrade(trade({ quote_amount: "99.99", realized_slippage_bps: 5 }));
    insertTrade(trade({ quote_amount: "100", realized_slippage_bps: 10 }));   // lands in $100–1k
    insertTrade(trade({ quote_amount: "999.99", realized_slippage_bps: 12 }));
    insertTrade(trade({ quote_amount: "10000", realized_slippage_bps: 50 })); // ≥$10k
    const r = gather();
    expect(r.bySize.find((b) => b.label === "<$100")!.fills).toBe(1);
    const mid = r.bySize.find((b) => b.label === "$100–1k")!;
    expect(mid.fills).toBe(2);
    expect(mid.slippage.medianBps).toBe(11);
    expect(r.bySize.find((b) => b.label === "≥$10k")!.fills).toBe(1);
    expect(r.bySize.find((b) => b.label === "$1k–10k")).toBeUndefined(); // empty buckets dropped
  });

  it("by pair: top-by-volume ordering", () => {
    insertTrade(trade({ base_symbol: "WETH", quote_amount: "100" }));
    insertTrade(trade({ base_symbol: "WBTC", quote_amount: "5000" }));
    const r = gather();
    expect(r.byPair[0].baseSymbol).toBe("WBTC");
    expect(r.byPair[1].baseSymbol).toBe("WETH");
  });
});

describe("gatherExecutionReport — trend + recommendations", () => {
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

  it("trend: trailing 7d vs prior, delta only with ≥5 samples per side", () => {
    for (let i = 0; i < 5; i++) insertTrade(trade({ timestamp: daysAgo(2), realized_slippage_bps: 20 }));
    for (let i = 0; i < 5; i++) insertTrade(trade({ timestamp: daysAgo(14), realized_slippage_bps: 8 }));
    const r = gather();
    expect(r.trend!.recent.medianBps).toBe(20);
    expect(r.trend!.prior.medianBps).toBe(8);
    expect(r.trend!.deltaMedianBps).toBeCloseTo(12, 9);
    // Degradation ≥10bps → recommendation fires.
    expect(r.recommendations.some((x) => /degrading/.test(x))).toBe(true);
  });

  it("trend delta withholds a verdict below the sample floor", () => {
    insertTrade(trade({ timestamp: daysAgo(2), realized_slippage_bps: 50 }));
    insertTrade(trade({ timestamp: daysAgo(14), realized_slippage_bps: 5 }));
    const r = gather();
    expect(r.trend!.deltaMedianBps).toBeNull();
    expect(r.recommendations.some((x) => /degrading/.test(x))).toBe(false);
  });

  it("aggregator recommendation: needs ≥10 samples EACH and ≥10bps spread", () => {
    for (let i = 0; i < 10; i++) insertTrade(trade({ aggregator: "kyberswap", realized_slippage_bps: 8 }));
    for (let i = 0; i < 10; i++) insertTrade(trade({ aggregator: "odos", realized_slippage_bps: 30 }));
    const r = gather();
    expect(r.recommendations.some((x) => /kyberswap fills at median 8.0bps vs odos/.test(x))).toBe(true);

    // Below the spread threshold → silent.
    openDb().exec("DELETE FROM trades");
    for (let i = 0; i < 10; i++) insertTrade(trade({ aggregator: "kyberswap", realized_slippage_bps: 8 }));
    for (let i = 0; i < 10; i++) insertTrade(trade({ aggregator: "odos", realized_slippage_bps: 12 }));
    expect(gather().recommendations.some((x) => /consider/.test(x))).toBe(false);
  });

  it("size-impact recommendation fires on ≥15bps growth across buckets", () => {
    for (let i = 0; i < 5; i++) insertTrade(trade({ quote_amount: "50", realized_slippage_bps: 5 }));
    for (let i = 0; i < 5; i++) insertTrade(trade({ quote_amount: "5000", realized_slippage_bps: 40 }));
    const r = gather();
    expect(r.recommendations.some((x) => /grows with size/.test(x))).toBe(true);
  });

  it("low-coverage recommendation: <50% recorded slippage over ≥10 fills", () => {
    for (let i = 0; i < 8; i++) insertTrade(trade({ realized_slippage_bps: null }));
    for (let i = 0; i < 4; i++) insertTrade(trade({ realized_slippage_bps: 10 }));
    const r = gather();
    expect(r.totals.slippageCoveragePct).toBeCloseTo((4 / 12) * 100, 6);
    expect(r.recommendations.some((x) => /tradekit reconcile/.test(x))).toBe(true);
  });

  it("chain/account scoping filters the report", () => {
    insertTrade(trade({ chain: "base", realized_slippage_bps: 10 }));
    insertTrade(trade({ chain: "arbitrum", realized_slippage_bps: 99 }));
    insertTrade(trade({ account: "other", realized_slippage_bps: 50 }));
    const r = gather({ chain: "base", account: "default" });
    expect(r.totals.fills).toBe(1);
    expect(r.totals.slippage.medianBps).toBe(10);
  });
});

describe("renderExecutionReport", () => {
  it("renders the full layout with the sign legend and recommendations", () => {
    for (let i = 0; i < 10; i++) insertTrade(trade({ aggregator: "kyberswap", realized_slippage_bps: 8, gas_cost_native: "0.001" }));
    for (let i = 0; i < 10; i++) insertTrade(trade({ aggregator: "odos", realized_slippage_bps: 30 }));
    const text = renderExecutionReport(gather());
    expect(text).toMatch(/Execution quality — last 30d/);
    expect(text).toMatch(/positive = worse than quoted/);
    expect(text).toMatch(/By aggregator:/);
    expect(text).toMatch(/kyberswap/);
    expect(text).toMatch(/Gas \(base\):/);
    expect(text).toMatch(/Recommendations:/);
    expect(text).toMatch(/⚠ kyberswap fills at median/);
  });

  it("empty window renders the honest paper-exclusion note", () => {
    const text = renderExecutionReport(gather());
    expect(text).toMatch(/No real swaps in window/);
    expect(text).toMatch(/Paper fills are excluded/);
  });
});
