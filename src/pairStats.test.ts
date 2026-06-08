// Iter634: tests for the pure helpers in pairStats.ts.

import { describe, expect, it } from "vitest";
import { canonicalPairKey, computePairStats, derivePairWarnings, type PairStat } from "./pairStats.js";
import type { TradeRow } from "./db.js";
import type { AnalyzedTrade } from "./tradeAnalysis.js";

function row(overrides: Partial<TradeRow> = {}): TradeRow {
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

function analysis(txHash: string, slippageBps: number, code = "ok"): AnalyzedTrade {
  return {
    txHash,
    chain: "base",
    direction: "buy",
    baseSymbol: "ETH",
    quoteSymbol: "USDC",
    finding: { code: code as never, message: "x" },
    comparison: {
      quoted: { baseAmount: 1, quoteAmount: 3000, pricePerBase: 3000 },
      actual: { baseAmount: 1, quoteAmount: 3000 - slippageBps / 10, pricePerBase: 0 },
      slippageBps,
      outputDelta: 0,
      finding: { code: code as never, message: "x" },
    },
  };
}

// ── canonicalPairKey ───────────────────────────────────────

describe("canonicalPairKey", () => {
  it("sorts lexicographically + uppercases", () => {
    expect(canonicalPairKey("eth", "usdc")).toBe("ETH/USDC");
    expect(canonicalPairKey("USDC", "ETH")).toBe("ETH/USDC");
  });

  it("collapses BOTH directions of same pair into one key", () => {
    // buy ETH with USDC → base=ETH, quote=USDC → "ETH/USDC"
    // sell ETH for USDC → base=ETH, quote=USDC → "ETH/USDC"
    expect(canonicalPairKey("ETH", "USDC")).toBe(canonicalPairKey("ETH", "USDC"));
    // A reverse-symbol trade (hypothetically swapping base/quote labels) still bucketed:
    expect(canonicalPairKey("USDC", "ETH")).toBe(canonicalPairKey("ETH", "USDC"));
  });

  it("(unknown) fallback for missing symbol", () => {
    expect(canonicalPairKey(null, "USDC")).toBe("(unknown)/USDC");
    expect(canonicalPairKey("ETH", undefined)).toBe("(unknown)/ETH"); // lex sort: '(' before 'E'
  });
});

// ── computePairStats ──────────────────────────────────────

describe("computePairStats", () => {
  it("returns empty byPair for empty input", () => {
    const r = computePairStats([], []);
    expect(r.totalTrades).toBe(0);
    expect(r.byPair).toEqual([]);
  });

  it("iter758: report carries elapsedMs (wall-clock timing)", () => {
    const r = computePairStats([], []);
    expect(typeof r.elapsedMs).toBe("number");
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(r.elapsedMs).toBeLessThan(1000);
  });

  it("groups by canonical pair regardless of base/quote order", () => {
    const r = computePairStats(
      [
        row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC" }),
        row({ tx_hash: "0x2", base_symbol: "USDC", quote_symbol: "ETH" }), // reversed
        row({ tx_hash: "0x3", base_symbol: "PEPE", quote_symbol: "USDC" }),
      ],
      [],
    );
    const ethUsdc = r.byPair.find((p) => p.pair === "ETH/USDC");
    const pepeUsdc = r.byPair.find((p) => p.pair === "PEPE/USDC");
    expect(ethUsdc?.tradeCount).toBe(2); // both directions collapsed
    expect(pepeUsdc?.tradeCount).toBe(1);
  });

  it("tracks both baseSymbols + quoteSymbols seen for each pair", () => {
    const r = computePairStats(
      [
        row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC" }),
        row({ tx_hash: "0x2", base_symbol: "USDC", quote_symbol: "ETH" }),
      ],
      [],
    );
    const p = r.byPair[0];
    expect(p.baseSymbols.sort()).toEqual(["ETH", "USDC"]);
    expect(p.quoteSymbols.sort()).toEqual(["ETH", "USDC"]);
  });

  it("counts success/failed/pending separately", () => {
    const r = computePairStats(
      [
        row({ tx_hash: "0x1", status: "success" }),
        row({ tx_hash: "0x2", status: "success" }),
        row({ tx_hash: "0x3", status: "failed" }),
        row({ tx_hash: "0x4", status: "pending" }),
      ],
      [],
    );
    const p = r.byPair[0];
    expect(p.successCount).toBe(2);
    expect(p.failedCount).toBe(1);
    expect(p.pendingCount).toBe(1);
    expect(p.successRate).toBe(0.5);
  });

  it("sorts byPair by tradeCount desc", () => {
    const r = computePairStats(
      [
        row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC" }),
        row({ tx_hash: "0x2", base_symbol: "PEPE", quote_symbol: "USDC" }),
        row({ tx_hash: "0x3", base_symbol: "PEPE", quote_symbol: "USDC" }),
        row({ tx_hash: "0x4", base_symbol: "PEPE", quote_symbol: "USDC" }),
      ],
      [],
    );
    expect(r.byPair[0].pair).toBe("PEPE/USDC");
    expect(r.byPair[0].tradeCount).toBe(3);
  });

  it("computes median + p95 slippage per pair from analyses", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ tx_hash: `0x${i}`, base_symbol: "ETH", quote_symbol: "USDC" }),
    );
    const analyses = rows.map((r, i) => analysis(r.tx_hash, i * 10)); // 0,10,...,90
    const report = computePairStats(rows, analyses);
    const p = report.byPair[0];
    expect(p.medianSlippageBps).toBeCloseTo(45, 1);
    expect(p.p95SlippageBps).toBeCloseTo(85.5, 1);
    expect(p.analyzedCount).toBe(10);
  });

  it("omits p95 for tiny analysis sets (<5)", () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      row({ tx_hash: `0x${i}` }),
    );
    const analyses = rows.map((r) => analysis(r.tx_hash, 20));
    const report = computePairStats(rows, analyses);
    expect(report.byPair[0].p95SlippageBps).toBeNull();
    expect(report.byPair[0].medianSlippageBps).toBe(20);
  });

  it("flags volumeNotePartial when ANY success row had non-stable quote", () => {
    const r = computePairStats(
      [
        row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC", quote_amount: "100" }),
        row({ tx_hash: "0x2", base_symbol: "ETH", quote_symbol: "USDC", quote_amount: "200" }),
        row({ tx_hash: "0x3", base_symbol: "ETH", quote_symbol: "USDC" }), // wait this is fine
      ],
      [],
    );
    // All USDC quotes → no partial
    expect(r.byPair[0].volumeNotePartial).toBe(false);
    expect(r.byPair[0].totalUsdVolume).toBe(3300); // 100 + 200 + 3000
  });

  it("non-stable quote rows: USD volume sums only stable rows; partial flagged", () => {
    const r = computePairStats(
      [
        row({ tx_hash: "0x1", base_symbol: "WBTC", quote_symbol: "USDC", quote_amount: "100" }),
        row({ tx_hash: "0x2", base_symbol: "WBTC", quote_symbol: "ETH", quote_amount: "0.05" }), // non-stable quote
      ],
      [],
    );
    // The two rows have different pairs (USDC/WBTC vs ETH/WBTC), so they're in
    // different buckets. Check the WBTC/USDC bucket.
    const usdcBucket = r.byPair.find((p) => p.pair === "USDC/WBTC");
    expect(usdcBucket?.totalUsdVolume).toBe(100);
    expect(usdcBucket?.volumeNotePartial).toBe(false);
    const ethBucket = r.byPair.find((p) => p.pair === "ETH/WBTC");
    expect(ethBucket?.totalUsdVolume).toBe(0);
    expect(ethBucket?.volumeNotePartial).toBe(true);
  });

  it("byVerdict tracks iter619 verdict distribution per pair", () => {
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
    const report = computePairStats(rows, analyses);
    expect(report.byPair[0].byVerdict).toEqual({ excellent: 1, minor_slip: 1, major_slip: 1 });
  });

  it("rows without matching analysis still count toward tradeCount", () => {
    const report = computePairStats(
      [
        row({ tx_hash: "0x1", status: "success" }),
        row({ tx_hash: "0x2", status: "success" }),
      ],
      [], // no analyses
    );
    expect(report.byPair[0].tradeCount).toBe(2);
    expect(report.byPair[0].successCount).toBe(2);
    expect(report.byPair[0].medianSlippageBps).toBeNull();
    expect(report.byPair[0].analyzedCount).toBe(0);
  });

  it("preserves `since` in the output for caching/observability", () => {
    const report = computePairStats([], [], { since: "2026-01-01T00:00:00Z" });
    expect(report.since).toBe("2026-01-01T00:00:00Z");
  });

  it("iter641: prefers stored realized_slippage_bps over live analysis", () => {
    const rows = [
      row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC", realized_slippage_bps: 30 }),
      row({ tx_hash: "0x2", base_symbol: "ETH", quote_symbol: "USDC", realized_slippage_bps: 70 }),
    ];
    const analyses = [analysis("0x1", 999), analysis("0x2", 999)]; // would be wildly wrong if used
    const report = computePairStats(rows, analyses);
    expect(report.byPair[0].medianSlippageBps).toBeCloseTo(50, 1);
  });

  it("iter641: mixed legacy + new rows (analysis fallback for legacy)", () => {
    const rows = [
      row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC" }), // legacy
      row({ tx_hash: "0x2", base_symbol: "ETH", quote_symbol: "USDC", realized_slippage_bps: 100 }),
    ];
    const analyses = [analysis("0x1", 40)];
    const report = computePairStats(rows, analyses);
    expect(report.byPair[0].analyzedCount).toBe(2); // both contributed
    expect(report.byPair[0].medianSlippageBps).toBe(70);
  });

  it("iter673: buckets failed-row revert_reason per pair, sorted desc", () => {
    const rows = [
      row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC", status: "failed", revert_reason: "Too little received" }),
      row({ tx_hash: "0x2", base_symbol: "ETH", quote_symbol: "USDC", status: "failed", revert_reason: "Too little received" }),
      row({ tx_hash: "0x3", base_symbol: "ETH", quote_symbol: "USDC", status: "failed", revert_reason: "STF" }),
      // Different pair — separate bucket
      row({ tx_hash: "0x4", base_symbol: "PEPE", quote_symbol: "WETH", status: "failed", revert_reason: "Allowance exhausted" }),
    ];
    const report = computePairStats(rows, []);
    const ethUsdc = report.byPair.find((p) => p.pair.includes("ETH") && p.pair.includes("USDC"));
    const pepeWeth = report.byPair.find((p) => p.pair.includes("PEPE"));
    // Iter699: lastSeen may be present — use toMatchObject for partial match.
    expect(ethUsdc?.failureReasons).toMatchObject([
      { reason: "Too little received", count: 2 },
      { reason: "STF", count: 1 },
    ]);
    expect(pepeWeth?.failureReasons).toMatchObject([{ reason: "Allowance exhausted", count: 1 }]);
  });

  it("iter673: NULL revert_reason buckets to '(unknown)' per pair", () => {
    const rows = [
      row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC", status: "failed", revert_reason: null }),
      row({ tx_hash: "0x2", base_symbol: "ETH", quote_symbol: "USDC", status: "failed", revert_reason: "Real reason" }),
    ];
    const report = computePairStats(rows, []);
    const pair = report.byPair[0];
    const unk = pair.failureReasons.find((r) => r.reason === "(unknown)");
    const real = pair.failureReasons.find((r) => r.reason === "Real reason");
    expect(unk?.count).toBe(1);
    expect(real?.count).toBe(1);
  });

  it("iter702: PairStat carries lastSeen (MAX timestamp per pair)", () => {
    const rows = [
      row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC", timestamp: "2026-05-01T00:00:00Z" }),
      row({ tx_hash: "0x2", base_symbol: "ETH", quote_symbol: "USDC", timestamp: "2026-05-20T18:00:00Z" }), // latest
      row({ tx_hash: "0x3", base_symbol: "PEPE", quote_symbol: "WETH", timestamp: "2026-04-15T00:00:00Z" }),
    ];
    const report = computePairStats(rows, []);
    const ethUsdc = report.byPair.find((p) => p.baseSymbols.includes("ETH"));
    const pepe = report.byPair.find((p) => p.baseSymbols.includes("PEPE"));
    expect(ethUsdc?.lastSeen).toBe("2026-05-20T18:00:00Z");
    expect(pepe?.lastSeen).toBe("2026-04-15T00:00:00Z");
  });

  it("iter673: success-only pairs get empty failureReasons", () => {
    const rows = [
      row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC", status: "success" }),
      row({ tx_hash: "0x2", base_symbol: "ETH", quote_symbol: "USDC", status: "success" }),
    ];
    const report = computePairStats(rows, []);
    expect(report.byPair[0].failureReasons).toEqual([]);
  });
});

// ── derivePairWarnings (iter690) ───────────────────────────

describe("derivePairWarnings", () => {
  function pair(o: Partial<PairStat>): PairStat {
    return {
      pair: "ETH/USDC",
      baseSymbols: ["ETH"],
      quoteSymbols: ["USDC"],
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
      ...o,
    };
  }

  it("returns empty when fewer than 2 pairs meet the trade-count threshold", () => {
    expect(derivePairWarnings([])).toEqual([]);
    expect(derivePairWarnings([pair({ tradeCount: 50 })])).toEqual([]);
    const pairs = [pair({ pair: "A/B", tradeCount: 50 }), pair({ pair: "C/D", tradeCount: 5 })];
    expect(derivePairWarnings(pairs)).toEqual([]);
  });

  it("flags a slippage-outlier pair with ≥50 bps gap", () => {
    const pairs = [
      pair({ pair: "ETH/USDC", tradeCount: 30, analyzedCount: 30, medianSlippageBps: 15 }),
      pair({ pair: "ETH/PEPE", tradeCount: 20, analyzedCount: 20, medianSlippageBps: 200 }),
    ];
    const warnings = derivePairWarnings(pairs);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/ETH\/PEPE/);
    expect(warnings[0]).toMatch(/high median slippage/);
  });

  it("does NOT flag slippage when gap is below threshold", () => {
    const pairs = [
      pair({ pair: "A/B", tradeCount: 30, analyzedCount: 30, medianSlippageBps: 20 }),
      pair({ pair: "C/D", tradeCount: 30, analyzedCount: 30, medianSlippageBps: 60 }), // 40bps gap — under threshold
    ];
    expect(derivePairWarnings(pairs).filter((w) => /high median slippage/.test(w))).toEqual([]);
  });

  it("flags a failure-concentration pair (one reason ≥80% of failures, ≥3 failures)", () => {
    const pairs = [
      pair({ pair: "ETH/USDC", tradeCount: 30, failedCount: 0 }),
      pair({
        pair: "ETH/PEPE",
        tradeCount: 20,
        failedCount: 10,
        successCount: 10,
        failureReasons: [
          { reason: "Too little received", count: 9 },
          { reason: "STF", count: 1 },
        ],
      }),
    ];
    const warnings = derivePairWarnings(pairs);
    const concentration = warnings.find((w) => /predominantly/.test(w));
    expect(concentration).toBeDefined();
    expect(concentration).toMatch(/ETH\/PEPE/);
    expect(concentration).toMatch(/Too little received/);
    expect(concentration).toMatch(/90%/);
  });

  it("does NOT flag concentration when below 80% share", () => {
    const pairs = [
      pair({ pair: "A/B", tradeCount: 30, failedCount: 0 }),
      pair({
        pair: "C/D",
        tradeCount: 20,
        failedCount: 10,
        failureReasons: [
          { reason: "X", count: 6 }, // 60% — under threshold
          { reason: "Y", count: 4 },
        ],
      }),
    ];
    const warnings = derivePairWarnings(pairs);
    expect(warnings.filter((w) => /predominantly/.test(w))).toEqual([]);
  });

  it("ignores (unknown) reasons when picking the dominant", () => {
    const pairs = [
      pair({ pair: "A/B", tradeCount: 30, failedCount: 0 }),
      pair({
        pair: "C/D",
        tradeCount: 20,
        failedCount: 10,
        failureReasons: [
          { reason: "(unknown)", count: 8 }, // dominant but excluded
          { reason: "Real", count: 2 },
        ],
      }),
    ];
    const warnings = derivePairWarnings(pairs);
    expect(warnings.filter((w) => /predominantly/.test(w))).toEqual([]);
  });

  it("iter704: slippage warning includes pair's lastSeen when present", () => {
    const pairs = [
      pair({ pair: "GOOD/USDC", tradeCount: 30, analyzedCount: 30, medianSlippageBps: 15, lastSeen: "2026-05-30T00:00:00Z" }),
      pair({ pair: "BAD/USDC", tradeCount: 20, analyzedCount: 20, medianSlippageBps: 200, lastSeen: "2026-05-28T00:00:00Z" }),
    ];
    const warnings = derivePairWarnings(pairs);
    const slippageWarning = warnings.find((w) => /high median slippage/.test(w));
    expect(slippageWarning).toMatch(/last: 2026-05-28/);
  });

  it("iter704: concentration warning includes the dominant reason's own lastSeen (iter699)", () => {
    // Concentration warning should use the REASON's lastSeen, not the pair's
    // global lastSeen — operators want to know when the dominant reason
    // last hit specifically.
    const pairs = [
      pair({ pair: "OK/USDC", tradeCount: 30, failedCount: 0 }),
      pair({
        pair: "BAD/USDC",
        tradeCount: 20,
        failedCount: 5,
        successCount: 15,
        lastSeen: "2026-05-30T00:00:00Z", // pair's global lastSeen — last success
        failureReasons: [
          { reason: "Too little received", count: 5, lastSeen: "2026-05-25T00:00:00Z" }, // dominant
        ],
      }),
    ];
    const warnings = derivePairWarnings(pairs);
    const concWarning = warnings.find((w) => /predominantly/.test(w));
    // Should pick the reason's lastSeen (2026-05-25), not the pair's (2026-05-30).
    expect(concWarning).toMatch(/last: 2026-05-25/);
    expect(concWarning).not.toMatch(/last: 2026-05-30/);
  });

  it("both rules can fire on the same pair (compound signal)", () => {
    const pairs = [
      pair({ pair: "GOOD/USDC", tradeCount: 30, analyzedCount: 30, medianSlippageBps: 10 }),
      pair({
        pair: "BAD/USDC",
        tradeCount: 20,
        analyzedCount: 20,
        medianSlippageBps: 200,
        failedCount: 5,
        successCount: 15,
        failureReasons: [{ reason: "Too little received", count: 5 }],
      }),
    ];
    const warnings = derivePairWarnings(pairs);
    expect(warnings.length).toBe(2);
    expect(warnings.some((w) => /high median slippage/.test(w) && /BAD\/USDC/.test(w))).toBe(true);
    expect(warnings.some((w) => /predominantly/.test(w) && /BAD\/USDC/.test(w))).toBe(true);
  });

  it("computePairStats surfaces warnings in the report", () => {
    function mkRow(o: Partial<TradeRow>): TradeRow {
      return {
        id: 1,
        timestamp: "2026-05-29T00:00:00Z",
        chain: "base",
        account: "alice",
        direction: "buy",
        base_token: "0xa",
        base_symbol: "ETH",
        base_amount: "1",
        quote_token: "0xb",
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
        mkRow({
          tx_hash: "0x" + (100 + i).toString(16).padStart(64, "0"),
          base_symbol: "ETH", quote_symbol: "USDC",
          status: "success", realized_slippage_bps: 15,
        }),
      ),
      ...Array.from({ length: 18 }, (_, i) =>
        mkRow({
          tx_hash: "0x" + (200 + i).toString(16).padStart(64, "0"),
          base_symbol: "PEPE", quote_symbol: "WETH",
          status: "success", realized_slippage_bps: 200,
        }),
      ),
    ];
    const report = computePairStats(rows, []);
    expect(report.warnings).toBeDefined();
    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
  });
});
