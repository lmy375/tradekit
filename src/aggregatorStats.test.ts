// Iter623: tests for the pure helpers in aggregatorStats.ts. Pure-core
// pinning: percentile math, USD volume estimator, the recommendation
// heuristic. The CLI/MCP orchestrator is HTTP-bound + covered indirectly
// by smoke tests.

import { describe, expect, it } from "vitest";
import {
  computeAggregatorStats,
  deriveRecommendation,
  deriveRecommendationStructured,
  deriveAggregatorTuning,
  deriveWarnings,
  estimateRowUsdVolume,
  percentile,
  type AggregatorStat,
} from "./aggregatorStats.js";
import type { TradeRow } from "./db.js";
import type { AnalyzedTrade } from "./tradeAnalysis.js";

// ── percentile ─────────────────────────────────────────────

describe("percentile", () => {
  it("returns null for empty input", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("p0 returns minimum, p100 returns maximum", () => {
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
  });

  it("p50 is the median for odd-length", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("p50 interpolates for even-length", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });

  it("p95 lands in the upper tail", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(arr, 95)).toBeCloseTo(95.05, 1);
  });
});

// ── estimateRowUsdVolume ───────────────────────────────────

describe("estimateRowUsdVolume", () => {
  function row(overrides: Partial<TradeRow>): TradeRow {
    return {
      id: 1,
      timestamp: "2026-05-29T00:00:00Z",
      chain: "base",
      account: "alice",
      direction: "buy",
      base_token: "NATIVE",
      base_symbol: "ETH",
      base_amount: "1.0",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      quote_amount: "3000",
      price: "3000",
      tx_hash: "0xabc",
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      ...overrides,
    };
  }

  it("returns quote_amount for stablecoin quotes", () => {
    expect(estimateRowUsdVolume(row({ quote_symbol: "USDC", quote_amount: "100" }))).toBe(100);
    expect(estimateRowUsdVolume(row({ quote_symbol: "USDT", quote_amount: "500" }))).toBe(500);
  });

  it("returns null for non-stable quotes (no USD anchor)", () => {
    expect(estimateRowUsdVolume(row({ quote_symbol: "ETH", quote_amount: "1.5" }))).toBeNull();
    expect(estimateRowUsdVolume(row({ quote_symbol: null, quote_amount: "100" }))).toBeNull();
  });

  it("returns null when quote_amount is unparseable", () => {
    expect(estimateRowUsdVolume(row({ quote_symbol: "USDC", quote_amount: "not-a-number" }))).toBeNull();
  });
});

// ── deriveRecommendation ───────────────────────────────────

describe("deriveRecommendation", () => {
  function stat(overrides: Partial<AggregatorStat>): AggregatorStat {
    return {
      aggregator: "test",
      tradeCount: 10,
      successCount: 10,
      failedCount: 0,
      pendingCount: 0,
      successRate: 1,
      medianSlippageBps: 20,
      p95SlippageBps: 50,
      avgSlippageBps: 25,
      totalUsdVolume: 1000,
      volumeNotePartial: false,
      analyzedCount: 10,
      byVerdict: {},
      failureReasons: [],
      ...overrides,
    };
  }

  it("returns undefined when only one aggregator has enough data", () => {
    const stats = [
      stat({ aggregator: "kyberswap", analyzedCount: 50, medianSlippageBps: 10 }),
      stat({ aggregator: "openocean", analyzedCount: 3, medianSlippageBps: 30 }),
    ];
    expect(deriveRecommendation(stats)).toBeUndefined();
  });

  it("recommends median-slippage winner with >=10 bps margin", () => {
    const stats = [
      stat({ aggregator: "kyberswap", analyzedCount: 50, medianSlippageBps: 10 }),
      stat({ aggregator: "openocean", analyzedCount: 50, medianSlippageBps: 30 }),
    ];
    expect(deriveRecommendation(stats)).toMatch(/^kyberswap leads on median/);
  });

  it("does NOT recommend when margin is <10 bps (noise threshold)", () => {
    const stats = [
      stat({ aggregator: "kyberswap", analyzedCount: 50, medianSlippageBps: 20, successRate: 0.95 }),
      stat({ aggregator: "openocean", analyzedCount: 50, medianSlippageBps: 25, successRate: 0.93 }),
    ];
    expect(deriveRecommendation(stats)).toBeUndefined();
  });

  it("falls back to success-rate winner when median margin is below threshold", () => {
    const stats = [
      stat({ aggregator: "kyberswap", analyzedCount: 50, medianSlippageBps: 20, successRate: 0.99 }),
      stat({ aggregator: "openocean", analyzedCount: 50, medianSlippageBps: 25, successRate: 0.85 }),
    ];
    expect(deriveRecommendation(stats)).toMatch(/^kyberswap has highest success rate/);
  });

  it("returns undefined when neither rule fires", () => {
    const stats = [
      stat({ aggregator: "kyberswap", analyzedCount: 50, medianSlippageBps: 20, successRate: 0.95 }),
      stat({ aggregator: "openocean", analyzedCount: 50, medianSlippageBps: 22, successRate: 0.94 }),
    ];
    expect(deriveRecommendation(stats)).toBeUndefined();
  });

  it("iter733: structured variant returns winner name + dimension when median-slippage rule fires", () => {
    const stats = [
      stat({ aggregator: "kyberswap", analyzedCount: 50, medianSlippageBps: 10 }),
      stat({ aggregator: "openocean", analyzedCount: 50, medianSlippageBps: 35 }),
    ];
    const r = deriveRecommendationStructured(stats);
    expect(r?.aggregator).toBe("kyberswap");
    expect(r?.dimension).toBe("slippage");
    expect(r?.message).toMatch(/kyberswap leads/);
  });

  it("iter733: structured variant returns winner name + dimension when success-rate rule fires", () => {
    const stats = [
      stat({ aggregator: "kyberswap", analyzedCount: 50, medianSlippageBps: 20, successRate: 0.85 }),
      stat({ aggregator: "openocean", analyzedCount: 50, medianSlippageBps: 22, successRate: 0.94 }),
    ];
    const r = deriveRecommendationStructured(stats);
    expect(r?.aggregator).toBe("openocean");
    expect(r?.dimension).toBe("success_rate");
    expect(r?.message).toMatch(/openocean has highest success rate/);
  });

  it("iter733: structured variant returns undefined under the same conditions as the prose variant", () => {
    const stats = [
      stat({ aggregator: "a", analyzedCount: 50, medianSlippageBps: 20, successRate: 0.9 }),
      stat({ aggregator: "b", analyzedCount: 50, medianSlippageBps: 22, successRate: 0.91 }),
    ];
    expect(deriveRecommendationStructured(stats)).toBeUndefined();
    expect(deriveRecommendation(stats)).toBeUndefined();
  });
});

// ── computeAggregatorStats ─────────────────────────────────

describe("computeAggregatorStats", () => {
  function row(overrides: Partial<TradeRow>): TradeRow {
    return {
      id: 1,
      timestamp: "2026-05-29T00:00:00Z",
      chain: "base",
      account: "alice",
      direction: "buy",
      base_token: "NATIVE",
      base_symbol: "ETH",
      base_amount: "1.0",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      quote_amount: "3000",
      price: "3000",
      tx_hash: "0xabc",
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      ...overrides,
    };
  }
  function analysis(txHash: string, slippageBps: number): AnalyzedTrade {
    return {
      txHash,
      chain: "base",
      direction: "buy",
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      finding: { code: "ok", message: "x" },
      comparison: {
        quoted: { baseAmount: 1, quoteAmount: 3000, pricePerBase: 3000 },
        actual: { baseAmount: 1, quoteAmount: 3000 - slippageBps / 10, pricePerBase: 0 },
        slippageBps,
        outputDelta: 0,
        finding: { code: "ok", message: "x" },
      },
    };
  }

  it("returns empty byAggregator on empty input", () => {
    const r = computeAggregatorStats([], []);
    expect(r.totalTrades).toBe(0);
    expect(r.byAggregator).toEqual([]);
    expect(r.recommendation).toBeUndefined();
  });

  it("iter744: report carries elapsedMs (wall-clock timing)", () => {
    const r = computeAggregatorStats([], []);
    expect(typeof r.elapsedMs).toBe("number");
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(r.elapsedMs).toBeLessThan(1000);
  });

  it("groups by aggregator + collapses null/empty to 'unknown'", () => {
    const r = computeAggregatorStats(
      [
        row({ tx_hash: "0x1", aggregator: "kyberswap" }),
        row({ tx_hash: "0x2", aggregator: "openocean" }),
        row({ tx_hash: "0x3", aggregator: null }),
        row({ tx_hash: "0x4", aggregator: "" }),
      ],
      [],
    );
    expect(r.byAggregator.find((s) => s.aggregator === "kyberswap")?.tradeCount).toBe(1);
    expect(r.byAggregator.find((s) => s.aggregator === "openocean")?.tradeCount).toBe(1);
    expect(r.byAggregator.find((s) => s.aggregator === "unknown")?.tradeCount).toBe(2);
  });

  it("counts success/failed/pending separately", () => {
    const r = computeAggregatorStats(
      [
        row({ tx_hash: "0x1", status: "success" }),
        row({ tx_hash: "0x2", status: "success" }),
        row({ tx_hash: "0x3", status: "failed" }),
        row({ tx_hash: "0x4", status: "pending" }),
      ],
      [],
    );
    const s = r.byAggregator[0];
    expect(s.successCount).toBe(2);
    expect(s.failedCount).toBe(1);
    expect(s.pendingCount).toBe(1);
    expect(s.successRate).toBe(0.5);
  });

  it("sorts byAggregator by tradeCount desc (most-used first)", () => {
    const r = computeAggregatorStats(
      [
        row({ tx_hash: "0x1", aggregator: "kyberswap" }),
        row({ tx_hash: "0x2", aggregator: "openocean" }),
        row({ tx_hash: "0x3", aggregator: "openocean" }),
        row({ tx_hash: "0x4", aggregator: "openocean" }),
      ],
      [],
    );
    expect(r.byAggregator[0].aggregator).toBe("openocean");
    expect(r.byAggregator[0].tradeCount).toBe(3);
  });

  it("computes median + p95 slippage from analyses", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ tx_hash: `0x${i}`, aggregator: "kyberswap" }));
    // Bps values: 0,10,20,30,40,50,60,70,80,90 — median=45, p95≈85.5
    const analyses = rows.map((r, i) => analysis(r.tx_hash, i * 10));
    const report = computeAggregatorStats(rows, analyses);
    const s = report.byAggregator[0];
    expect(s.medianSlippageBps).toBeCloseTo(45, 1);
    expect(s.p95SlippageBps).toBeCloseTo(85.5, 1);
    expect(s.analyzedCount).toBe(10);
  });

  it("omits p95 for tiny analysis sets (<5)", () => {
    const rows = Array.from({ length: 3 }, (_, i) => row({ tx_hash: `0x${i}`, aggregator: "kyberswap" }));
    const analyses = rows.map((r) => analysis(r.tx_hash, 20));
    const report = computeAggregatorStats(rows, analyses);
    expect(report.byAggregator[0].p95SlippageBps).toBeNull();
    expect(report.byAggregator[0].medianSlippageBps).toBe(20);
  });

  it("flags volumeNotePartial when ANY success row had non-stable quote", () => {
    const r = computeAggregatorStats(
      [
        row({ tx_hash: "0x1", quote_symbol: "USDC", quote_amount: "100" }),
        row({ tx_hash: "0x2", quote_symbol: "ETH", quote_amount: "0.05" }), // non-stable
      ],
      [],
    );
    expect(r.byAggregator[0].volumeNotePartial).toBe(true);
    expect(r.byAggregator[0].totalUsdVolume).toBe(100); // only the stable row counts
  });

  it("byVerdict tracks iter619 verdict bucket distribution", () => {
    const rows = [
      row({ tx_hash: "0x1" }),
      row({ tx_hash: "0x2" }),
      row({ tx_hash: "0x3" }),
    ];
    const analyses: AnalyzedTrade[] = [
      { ...analysis("0x1", 5), finding: { code: "excellent", message: "x" } },
      { ...analysis("0x2", 50), finding: { code: "minor_slip", message: "x" } },
      { ...analysis("0x3", 200), finding: { code: "major_slip", message: "x" } },
    ];
    const report = computeAggregatorStats(rows, analyses);
    expect(report.byAggregator[0].byVerdict).toEqual({ excellent: 1, minor_slip: 1, major_slip: 1 });
  });

  it("rows with no matching analysis still count toward tradeCount/successCount", () => {
    const report = computeAggregatorStats(
      [
        row({ tx_hash: "0x1", status: "success" }),
        row({ tx_hash: "0x2", status: "success" }),
      ],
      [], // no analyses
    );
    expect(report.byAggregator[0].tradeCount).toBe(2);
    expect(report.byAggregator[0].successCount).toBe(2);
    expect(report.byAggregator[0].medianSlippageBps).toBeNull();
    expect(report.byAggregator[0].analyzedCount).toBe(0);
  });

  it("preserves `since` in the output for caching/observability", () => {
    const report = computeAggregatorStats([], [], { since: "2026-01-01T00:00:00Z" });
    expect(report.since).toBe("2026-01-01T00:00:00Z");
  });

  it("iter641: prefers stored realized_slippage_bps over live analysis", () => {
    const rows = [
      row({ tx_hash: "0x1", aggregator: "kyberswap", realized_slippage_bps: 25 }),
      row({ tx_hash: "0x2", aggregator: "kyberswap", realized_slippage_bps: 50 }),
    ];
    // Even when an analysis WITH a DIFFERENT slippage exists, stored value wins.
    const analyses = [
      { ...analysis("0x1", 999), finding: { code: "extreme_slip" as const, message: "x" } },
      { ...analysis("0x2", 999), finding: { code: "extreme_slip" as const, message: "x" } },
    ];
    const report = computeAggregatorStats(rows, analyses);
    expect(report.byAggregator[0].medianSlippageBps).toBeCloseTo(37.5, 1);
    // Stored value contributes; analysis verdict still tallies for byVerdict.
    expect(report.byAggregator[0].byVerdict).toEqual({ extreme_slip: 2 });
  });

  it("iter641: falls back to live analysis for rows without stored slippage", () => {
    const rows = [
      row({ tx_hash: "0x1", aggregator: "kyberswap" }), // no stored
      row({ tx_hash: "0x2", aggregator: "kyberswap", realized_slippage_bps: 100 }),
    ];
    const analyses = [analysis("0x1", 40)];
    const report = computeAggregatorStats(rows, analyses);
    expect(report.byAggregator[0].analyzedCount).toBe(2);
    // median of [40, 100] = 70
    expect(report.byAggregator[0].medianSlippageBps).toBe(70);
  });

  it("iter672: buckets failed-row revert_reason per aggregator, sorted desc", () => {
    const rows = [
      row({ tx_hash: "0x1", aggregator: "openocean", status: "failed", revert_reason: "Too little received" }),
      row({ tx_hash: "0x2", aggregator: "openocean", status: "failed", revert_reason: "Too little received" }),
      row({ tx_hash: "0x3", aggregator: "openocean", status: "failed", revert_reason: "Panic: division/modulo by zero (0x12)" }),
      row({ tx_hash: "0x4", aggregator: "kyberswap", status: "failed", revert_reason: "STF" }),
      row({ tx_hash: "0x5", aggregator: "kyberswap", status: "success" }), // no failure → no reason
    ];
    const report = computeAggregatorStats(rows, []);
    const oo = report.byAggregator.find((s) => s.aggregator === "openocean");
    const ks = report.byAggregator.find((s) => s.aggregator === "kyberswap");
    // Iter699: failureReason entries may carry lastSeen — use partial match.
    expect(oo?.failureReasons).toMatchObject([
      { reason: "Too little received", count: 2 },
      { reason: "Panic: division/modulo by zero (0x12)", count: 1 },
    ]);
    expect(ks?.failureReasons).toMatchObject([{ reason: "STF", count: 1 }]);
  });

  it("iter672: NULL revert_reason on failed rows buckets to '(unknown)'", () => {
    const rows = [
      row({ tx_hash: "0x1", aggregator: "openocean", status: "failed", revert_reason: null }),
      row({ tx_hash: "0x2", aggregator: "openocean", status: "failed", revert_reason: null }),
      row({ tx_hash: "0x3", aggregator: "openocean", status: "failed", revert_reason: "Real reason" }),
    ];
    const report = computeAggregatorStats(rows, []);
    const oo = report.byAggregator.find((s) => s.aggregator === "openocean");
    // Iter699: lastSeen may be present — check by extracting matching entries.
    const unk = oo?.failureReasons.find((r) => r.reason === "(unknown)");
    const real = oo?.failureReasons.find((r) => r.reason === "Real reason");
    expect(unk?.count).toBe(2);
    expect(real?.count).toBe(1);
  });

  it("iter701: AggregatorStat carries lastSeen (MAX timestamp per aggregator)", () => {
    const rows = [
      row({ tx_hash: "0x1", aggregator: "openocean", timestamp: "2026-05-01T00:00:00Z" }),
      row({ tx_hash: "0x2", aggregator: "openocean", timestamp: "2026-05-15T12:00:00Z" }), // latest for openocean
      row({ tx_hash: "0x3", aggregator: "openocean", timestamp: "2026-05-10T00:00:00Z" }),
      row({ tx_hash: "0x4", aggregator: "kyberswap", timestamp: "2026-05-20T00:00:00Z" }),
    ];
    const report = computeAggregatorStats(rows, []);
    const oo = report.byAggregator.find((s) => s.aggregator === "openocean");
    const ks = report.byAggregator.find((s) => s.aggregator === "kyberswap");
    expect(oo?.lastSeen).toBe("2026-05-15T12:00:00Z");
    expect(ks?.lastSeen).toBe("2026-05-20T00:00:00Z");
  });

  it("iter672: empty failureReasons for aggregators with no failures", () => {
    const rows = [
      row({ tx_hash: "0x1", aggregator: "openocean", status: "success" }),
      row({ tx_hash: "0x2", aggregator: "openocean", status: "success" }),
    ];
    const report = computeAggregatorStats(rows, []);
    expect(report.byAggregator[0].failureReasons).toEqual([]);
  });
});

// ── deriveWarnings (iter688) ───────────────────────────────

describe("deriveWarnings", () => {
  function stat(overrides: Partial<AggregatorStat>): AggregatorStat {
    return {
      aggregator: "test",
      tradeCount: 20,
      successCount: 20,
      failedCount: 0,
      pendingCount: 0,
      successRate: 1,
      medianSlippageBps: 20,
      p95SlippageBps: 50,
      avgSlippageBps: 25,
      totalUsdVolume: 1000,
      volumeNotePartial: false,
      analyzedCount: 20,
      byVerdict: {},
      failureReasons: [],
      ...overrides,
    };
  }

  it("returns empty array when fewer than 2 aggregators meet the trade-count threshold", () => {
    expect(deriveWarnings([])).toEqual([]);
    expect(deriveWarnings([stat({ tradeCount: 50 })])).toEqual([]);
    // Two aggregators but one below the threshold (<10 trades).
    const stats = [
      stat({ aggregator: "a", tradeCount: 50, successRate: 1 }),
      stat({ aggregator: "b", tradeCount: 5, successRate: 0.5 }),
    ];
    expect(deriveWarnings(stats)).toEqual([]);
  });

  it("flags a success-rate underperformer with ≥15 pct gap", () => {
    const stats = [
      stat({ aggregator: "kyberswap", tradeCount: 30, successRate: 0.97 }),
      stat({ aggregator: "openocean", tradeCount: 20, successRate: 0.80 }), // 17pct below
    ];
    const warnings = deriveWarnings(stats);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/openocean/);
    expect(warnings[0]).toMatch(/success rate/);
    expect(warnings[0]).toMatch(/80\.0%/);
  });

  it("does NOT flag when success-rate gap is below threshold", () => {
    const stats = [
      stat({ aggregator: "a", tradeCount: 30, successRate: 0.97 }),
      stat({ aggregator: "b", tradeCount: 30, successRate: 0.85 }), // 12pct below — under threshold
    ];
    expect(deriveWarnings(stats)).toEqual([]);
  });

  it("flags a median-slippage underperformer with ≥50 bps gap", () => {
    const stats = [
      stat({ aggregator: "kyberswap", tradeCount: 30, analyzedCount: 30, medianSlippageBps: 15 }),
      stat({ aggregator: "openocean", tradeCount: 20, analyzedCount: 20, medianSlippageBps: 80 }), // 65bps worse
    ];
    const warnings = deriveWarnings(stats);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/openocean/);
    expect(warnings[0]).toMatch(/median slippage/);
  });

  it("iter704: warning string includes the underperformer's lastSeen when present", () => {
    const stats = [
      stat({ aggregator: "good", tradeCount: 30, successRate: 0.98, lastSeen: "2026-05-30T12:00:00Z" }),
      stat({ aggregator: "bad", tradeCount: 20, successRate: 0.75, lastSeen: "2026-05-29T08:00:00Z" }),
    ];
    const warnings = deriveWarnings(stats);
    const successWarning = warnings.find((w) => /success rate/.test(w));
    expect(successWarning).toMatch(/last: 2026-05-29/);
    expect(successWarning).toMatch(/bad/);
  });

  it("iter704: warning string omits lastSeen suffix when stat has no lastSeen (back-compat)", () => {
    const stats = [
      stat({ aggregator: "good", tradeCount: 30, successRate: 0.98 }), // no lastSeen
      stat({ aggregator: "bad", tradeCount: 20, successRate: 0.75 }),
    ];
    const warnings = deriveWarnings(stats);
    expect(warnings[0]).not.toMatch(/last:/);
  });

  it("flags both rules independently when both trigger", () => {
    const stats = [
      stat({ aggregator: "good", tradeCount: 30, analyzedCount: 30, successRate: 0.98, medianSlippageBps: 10 }),
      stat({ aggregator: "bad", tradeCount: 20, analyzedCount: 20, successRate: 0.70, medianSlippageBps: 100 }),
    ];
    const warnings = deriveWarnings(stats);
    // One warning per rule (so 2 total — both flag the same aggregator).
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toMatch(/bad.*success rate/);
    expect(warnings[1]).toMatch(/bad.*median slippage/);
  });

  it("skips slippage rule when underperformer has <10 analyzed trades", () => {
    // tradeCount qualifies for success-rate rule, but analyzedCount doesn't
    // for slippage. Slippage warning should not fire.
    const stats = [
      stat({ aggregator: "good", tradeCount: 30, analyzedCount: 30, successRate: 1, medianSlippageBps: 10 }),
      stat({ aggregator: "bad", tradeCount: 15, analyzedCount: 3, successRate: 0.95, medianSlippageBps: 200 }),
    ];
    const warnings = deriveWarnings(stats);
    expect(warnings).toEqual([]); // success rate gap is too small AND slippage rule gated out
  });

  it("computeAggregatorStats surfaces warnings in the report", () => {
    // Inline row builder — the `row` helper lives in the
    // computeAggregatorStats describe scope, so we recreate the minimal
    // shape here.
    function mkRow(o: Partial<TradeRow>): TradeRow {
      return {
        id: 1,
        timestamp: "2026-05-29T00:00:00Z",
        chain: "base",
        account: "alice",
        direction: "buy",
        base_token: "NATIVE",
        base_symbol: "ETH",
        base_amount: "1.0",
        quote_token: "0xusdc",
        quote_symbol: "USDC",
        quote_amount: "3000",
        price: "3000",
        tx_hash: "0xabc",
        status: "success",
        gas_used: null,
        gas_price_wei: null,
        gas_cost_native: null,
        aggregator: "kyberswap",
        fee_tier: null,
        notes: null,
        ...o,
      };
    }
    const rows = [
      ...Array.from({ length: 20 }, (_, i) =>
        mkRow({ tx_hash: "0x" + (1000 + i).toString(16).padStart(64, "0"), aggregator: "good", status: "success", realized_slippage_bps: 10 }),
      ),
      ...Array.from({ length: 18 }, (_, i) =>
        mkRow({ tx_hash: "0x" + (2000 + i).toString(16).padStart(64, "0"), aggregator: "bad", status: "success", realized_slippage_bps: 100 }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        mkRow({ tx_hash: "0x" + (3000 + i).toString(16).padStart(64, "0"), aggregator: "bad", status: "failed" }),
      ),
    ];
    const report = computeAggregatorStats(rows, []);
    expect(report.warnings).toBeDefined();
    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
  });
});

// ── deriveAggregatorTuning (v58) ───────────────────────────

describe("deriveAggregatorTuning", () => {
  function stat(overrides: Partial<AggregatorStat>): AggregatorStat {
    return {
      aggregator: "kyberswap",
      tradeCount: 20,
      successCount: 20,
      failedCount: 0,
      pendingCount: 0,
      successRate: 1,
      medianSlippageBps: 20,
      p95SlippageBps: 50,
      avgSlippageBps: 25,
      totalUsdVolume: 1000,
      volumeNotePartial: false,
      analyzedCount: 20,
      byVerdict: {},
      failureReasons: [],
      ...overrides,
    };
  }

  it("ranks reliability-first: a higher success rate beats lower slippage", () => {
    const t = deriveAggregatorTuning({
      stats: [
        // kyberswap: great slippage but flaky fills.
        stat({ aggregator: "kyberswap", successRate: 0.85, successCount: 17, medianSlippageBps: 5 }),
        // openocean: slightly worse slippage but reliable.
        stat({ aggregator: "openocean", successRate: 1.0, medianSlippageBps: 12 }),
      ],
      currentPreferred: ["kyberswap", "openocean"],
      currentMode: "first",
    });
    expect(t.recommendedPreferred[0]).toBe("openocean"); // reliability wins
    expect(t.changed).toBe(true);
    expect(t.ranking.find((r) => r.aggregator === "openocean")?.rank).toBe(1);
  });

  it("within the success band, lower median slippage wins the tiebreak", () => {
    const t = deriveAggregatorTuning({
      stats: [
        stat({ aggregator: "kyberswap", successRate: 1.0, medianSlippageBps: 18 }),
        stat({ aggregator: "openocean", successRate: 0.995, medianSlippageBps: 6 }), // same band, better slippage
      ],
      currentPreferred: ["kyberswap"],
      currentMode: "first",
    });
    expect(t.recommendedPreferred[0]).toBe("openocean");
  });

  it("aggregators below the trade floor are not ranked on merit", () => {
    const t = deriveAggregatorTuning({
      stats: [
        stat({ aggregator: "kyberswap", tradeCount: 20, successRate: 0.9, successCount: 18 }),
        stat({ aggregator: "openocean", tradeCount: 3, successCount: 3, successRate: 1, medianSlippageBps: 1 }),
      ],
      currentPreferred: ["kyberswap", "openocean"],
      currentMode: "first",
    });
    expect(t.insufficient).toBe(true); // only 1 eligible
    const oo = t.ranking.find((r) => r.aggregator === "openocean")!;
    expect(oo.eligible).toBe(false);
    expect(oo.rank).toBeNull();
    expect(oo.note).toMatch(/< 10/);
  });

  it("recommends mode 'best' when the eligible slippage spread is wide", () => {
    const t = deriveAggregatorTuning({
      stats: [
        stat({ aggregator: "kyberswap", successRate: 1, medianSlippageBps: 8 }),
        stat({ aggregator: "openocean", successRate: 1, medianSlippageBps: 30 }), // 22bps spread ≥ 15
      ],
      currentPreferred: ["kyberswap"],
      currentMode: "first",
    });
    expect(t.recommendedMode).toBe("best");
    expect(t.modeReason).toMatch(/races every quote/);
  });

  it("does NOT recommend a mode change when already on 'best' or spread is narrow", () => {
    const narrow = deriveAggregatorTuning({
      stats: [
        stat({ aggregator: "kyberswap", successRate: 1, medianSlippageBps: 10 }),
        stat({ aggregator: "openocean", successRate: 1, medianSlippageBps: 14 }), // 4bps < 15
      ],
      currentPreferred: ["kyberswap"],
      currentMode: "first",
    });
    expect(narrow.recommendedMode).toBeNull();
    const onBest = deriveAggregatorTuning({
      stats: [
        stat({ aggregator: "kyberswap", successRate: 1, medianSlippageBps: 8 }),
        stat({ aggregator: "openocean", successRate: 1, medianSlippageBps: 30 }),
      ],
      currentPreferred: ["kyberswap"],
      currentMode: "best",
    });
    expect(onBest.recommendedMode).toBeNull(); // already racing
  });

  it("changed=false when the data already matches the configured order", () => {
    const t = deriveAggregatorTuning({
      stats: [
        stat({ aggregator: "kyberswap", successRate: 1, medianSlippageBps: 8 }),
        stat({ aggregator: "openocean", successRate: 1, medianSlippageBps: 12 }),
      ],
      currentPreferred: ["kyberswap", "openocean"],
      currentMode: "first",
    });
    expect(t.recommendedPreferred).toEqual(["kyberswap", "openocean"]);
    expect(t.changed).toBe(false);
  });
});
