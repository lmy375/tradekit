/**
 * Rebalance backtest simulator tests. Pure — synthetic series, no
 * network, no DB.
 *
 * Covers the mechanics that are easy to get subtly wrong:
 *   - drift math + fire/in-band gating
 *   - sells-fund-buys anchor conservation (no money minting)
 *   - minTradeUsd leg skips + anchor clamping
 *   - maxRuns cap
 *   - HODL counterfactual
 *   - worst-case slippage drag
 *   - misaligned series timestamps (at-or-before lookup)
 *   - validation errors
 */

import { describe, it, expect } from "vitest";
import type { PriceSeries } from "./backtest.js";
import {
  simulateRebalance,
  validateRebalanceBacktestSpec,
  constantSeries,
  defaultInitialBalance,
  type RebalanceBacktestSpec,
} from "./backtestRebalance.js";

/** Build a daily series from (dayOffset → price) pairs starting at a
 *  fixed epoch. */
const T0 = Date.parse("2026-01-01T00:00:00Z");
function series(prices: number[], opts: { stepMs?: number; offsetMs?: number } = {}): PriceSeries {
  const step = opts.stepMs ?? 86_400_000;
  const offset = opts.offsetMs ?? 0;
  return {
    coinId: "test",
    daysRequested: prices.length,
    points: prices.map((p, i) => ({ ts: new Date(T0 + offset + i * step).toISOString(), priceUsd: p })),
  };
}

const SPEC_60_40: RebalanceBacktestSpec = {
  targets: [
    { symbol: "ETH", targetPct: 60 },
    { symbol: "USDC", targetPct: 40 },
  ],
  driftThresholdPct: 5,
  minTradeUsd: 10,
  cron: "0 0 * * *", // daily at midnight — aligns with the synthetic series
};

function usdcFlat(days: number): PriceSeries {
  return series(Array.from({ length: days }, () => 1));
}

function portfolioUsd(balance: Record<string, number>, prices: Record<string, number>): number {
  return Object.entries(balance).reduce((acc, [sym, units]) => acc + units * (prices[sym] ?? 0), 0);
}

describe("simulateRebalance — drift gating", () => {
  it("flat prices → balanced book never fires", () => {
    const r = simulateRebalance({
      spec: SPEC_60_40,
      initialBalance: { ETH: 3, USDC: 4000 }, // 3×2000=6000 / 4000 at ETH=2000 → exactly 60/40
      series: { ETH: series([2000, 2000, 2000, 2000]), USDC: usdcFlat(4) },
    });
    expect(r.fires).toEqual([]);
    expect(r.evaluations).toBeGreaterThan(0);
    expect(r.skippedInBand).toBe(r.evaluations);
    expect(r.pnlUsd).toBeCloseTo(0, 6);
  });

  it("price doubling breaches the threshold → sells ETH into USDC, restores weights", () => {
    const r = simulateRebalance({
      spec: SPEC_60_40,
      initialBalance: { ETH: 3, USDC: 4000 },
      series: { ETH: series([2000, 4000, 4000, 4000]), USDC: usdcFlat(4) },
    });
    expect(r.fires.length).toBe(1);
    const fire = r.fires[0];
    // ETH at 4000: 12000/16000 = 75% vs 60% target → 15pt drift.
    expect(fire.maxDriftPct).toBeCloseTo(15, 5);
    expect(fire.legs).toHaveLength(1);
    expect(fire.legs[0].side).toBe("sell");
    expect(fire.legs[0].symbol).toBe("ETH");
    expect(fire.legs[0].amountUsd).toBeCloseTo(2400, 3); // 75% → 60% of 16k
    // Post-fire weights restored: 9600/16000 = 60%.
    const after = portfolioUsd(r.finalBalance, { ETH: 4000, USDC: 1 });
    expect((r.finalBalance["ETH"] * 4000) / after).toBeCloseTo(0.6, 6);
    // Subsequent evaluations are in-band — exactly one fire total.
    expect(r.skippedInBand).toBe(r.evaluations - 1);
  });

  it("USD is conserved across a fire (sells exactly fund buys, zero slippage)", () => {
    const r = simulateRebalance({
      spec: SPEC_60_40,
      initialBalance: { ETH: 3, USDC: 4000 },
      series: { ETH: series([2000, 4000]), USDC: usdcFlat(2) },
    });
    const f = r.fires[0];
    expect(f.portfolioUsdAfter).toBeCloseTo(f.portfolioUsdBefore, 6);
  });

  it("price crash fires a BUY leg funded from the anchor", () => {
    const r = simulateRebalance({
      spec: SPEC_60_40,
      initialBalance: { ETH: 3, USDC: 4000 },
      series: { ETH: series([2000, 1000]), USDC: usdcFlat(2) },
    });
    expect(r.fires.length).toBe(1);
    const legs = r.fires[0].legs;
    expect(legs).toHaveLength(1);
    expect(legs[0].side).toBe("buy");
    expect(legs[0].symbol).toBe("ETH");
    // ETH at 1000: 3000/7000 ≈ 42.86% vs 60 → buy ≈ 1200 USD.
    expect(legs[0].amountUsd).toBeCloseTo(7000 * 0.6 - 3000, 3);
    expect(r.finalBalance["USDC"]).toBeCloseTo(4000 - legs[0].amountUsd, 3);
  });
});

describe("simulateRebalance — leg edge cases", () => {
  it("legs below minTradeUsd skip (economically in-band)", () => {
    const r = simulateRebalance({
      spec: { ...SPEC_60_40, driftThresholdPct: 1, minTradeUsd: 5000 },
      initialBalance: { ETH: 3, USDC: 4000 },
      series: { ETH: series([2000, 2200]), USDC: usdcFlat(2) },
    });
    // Drift breaches 1% but the corrective leg (< 5000 USD) skips →
    // counted as in-band, not a fire.
    expect(r.fires).toEqual([]);
  });

  it("buy leg clamps to the available anchor instead of minting", () => {
    // With 2 assets the anchor always covers the buy by conservation;
    // the shortfall needs ≥3 assets + slippage drag: the ETH sell
    // delivers only half its notional into the anchor (50% slip), so
    // the WBTC buy demand exceeds what's available → clamp.
    const r = simulateRebalance({
      spec: {
        targets: [
          { symbol: "ETH", targetPct: 45 },
          { symbol: "WBTC", targetPct: 45 },
          { symbol: "USDC", targetPct: 10 },
        ],
        driftThresholdPct: 5,
        minTradeUsd: 1,
        cron: "0 0 * * *",
        slippageBps: 5000, // 50% — extreme on purpose
        maxRuns: 1,
      },
      initialBalance: { ETH: 1, WBTC: 0, USDC: 100 },
      series: { ETH: series([3000]), WBTC: series([30_000]), USDC: usdcFlat(1) },
    });
    expect(r.fires.length).toBe(1);
    const buy = r.fires[0].legs.find((l) => l.side === "buy")!;
    expect(buy.symbol).toBe("WBTC");
    expect(buy.clamped).toBe(true);
    // Total 3100 → WBTC target 1395; anchor after the slipped ETH
    // sell: 100 + 1605×0.5 = 902.5 — the buy clamps to that.
    expect(buy.amountUsd).toBeCloseTo(902.5, 3);
    expect(r.finalBalance["USDC"]).toBeCloseTo(0, 6);
    expect(r.notes.some((n) => n.includes("clamped"))).toBe(true);
  });

  it("maxRuns caps lifetime fires", () => {
    // Oscillating price would fire repeatedly; cap at 1.
    const r = simulateRebalance({
      spec: { ...SPEC_60_40, maxRuns: 1 },
      initialBalance: { ETH: 3, USDC: 4000 },
      series: { ETH: series([2000, 4000, 1000, 4000, 1000]), USDC: usdcFlat(5) },
    });
    expect(r.fires.length).toBe(1);
    expect(r.notes.some((n) => n.includes("max-runs"))).toBe(true);
  });

  it("worst-case slippage drags the post-fire portfolio below conservation", () => {
    const noSlip = simulateRebalance({
      spec: SPEC_60_40,
      initialBalance: { ETH: 3, USDC: 4000 },
      series: { ETH: series([2000, 4000]), USDC: usdcFlat(2) },
    });
    const withSlip = simulateRebalance({
      spec: { ...SPEC_60_40, slippageBps: 100 }, // 1%
      initialBalance: { ETH: 3, USDC: 4000 },
      series: { ETH: series([2000, 4000]), USDC: usdcFlat(2) },
    });
    expect(withSlip.finalUsd).toBeLessThan(noSlip.finalUsd);
    // Sell leg of ~2400 USD at 1% slip → ~24 USD drag.
    expect(noSlip.finalUsd - withSlip.finalUsd).toBeCloseTo(24, 1);
  });
});

describe("simulateRebalance — counterfactual + window", () => {
  it("HODL counterfactual values the INITIAL units at window-end prices", () => {
    const r = simulateRebalance({
      spec: SPEC_60_40,
      initialBalance: { ETH: 3, USDC: 4000 },
      series: { ETH: series([2000, 4000, 3000]), USDC: usdcFlat(3) },
    });
    // HODL: 3 ETH × 3000 + 4000 = 13000; initial = 10000.
    expect(r.holdFinalUsd).toBeCloseTo(13_000, 3);
    expect(r.holdPnlUsd).toBeCloseTo(3_000, 3);
    // Rebalanced path sold ETH at 4000 → different final.
    expect(r.finalUsd).not.toBeCloseTo(r.holdFinalUsd, 1);
  });

  it("misaligned series timestamps price at-or-before each evaluation", () => {
    // USDC samples lag ETH by 7 hours; daily cron at midnight must
    // still price both (ETH exactly at midnight, USDC from the
    // previous day's sample).
    const r = simulateRebalance({
      spec: SPEC_60_40,
      initialBalance: { ETH: 3, USDC: 4000 },
      series: {
        ETH: series([2000, 4000, 4000]),
        USDC: series([1, 1, 1], { offsetMs: -7 * 3600_000 }),
      },
    });
    expect(r.evaluations).toBeGreaterThan(0);
    expect(r.fires.length).toBe(1);
  });

  it("occurrences before a symbol's first sample are skipped, not errored", () => {
    const r = simulateRebalance({
      spec: SPEC_60_40,
      initialBalance: { ETH: 3, USDC: 4000 },
      series: {
        ETH: series([2000, 2000, 2000, 2000]),
        // USDC's first sample lands 2 days late.
        USDC: series([1, 1], { offsetMs: 2 * 86_400_000 }),
      },
    });
    expect(r.notes.some((n) => n.includes("skipped before every symbol"))).toBe(true);
    expect(r.evaluations).toBeGreaterThan(0);
  });
});

describe("validation + helpers", () => {
  it("rejects targets that don't sum to 100, duplicates, <2 targets", () => {
    expect(() =>
      validateRebalanceBacktestSpec({ targets: [{ symbol: "ETH", targetPct: 60 }, { symbol: "USDC", targetPct: 50 }] }),
    ).toThrow(/sum/);
    expect(() =>
      validateRebalanceBacktestSpec({ targets: [{ symbol: "ETH", targetPct: 50 }, { symbol: "eth", targetPct: 50 }] }),
    ).toThrow(/duplicate/);
    expect(() => validateRebalanceBacktestSpec({ targets: [{ symbol: "ETH", targetPct: 100 }] })).toThrow(/at least 2/);
  });

  it("rejects bad threshold / minTrade / slippage / maxRuns", () => {
    const targets = SPEC_60_40.targets;
    expect(() => validateRebalanceBacktestSpec({ targets, driftThresholdPct: 0 })).toThrow(/driftThresholdPct/);
    expect(() => validateRebalanceBacktestSpec({ targets, minTradeUsd: -1 })).toThrow(/minTradeUsd/);
    expect(() => validateRebalanceBacktestSpec({ targets, slippageBps: 20_000 })).toThrow(/slippageBps/);
    expect(() => validateRebalanceBacktestSpec({ targets, maxRuns: 0 })).toThrow(/maxRuns/);
  });

  it("simulateRebalance rejects a missing series or unpriceable initial balance", () => {
    expect(() =>
      simulateRebalance({ spec: SPEC_60_40, initialBalance: {}, series: { ETH: series([1]) } }),
    ).toThrow(/missing price series for USDC/);
    expect(() =>
      simulateRebalance({
        spec: SPEC_60_40,
        initialBalance: { PEPE: 5 },
        series: { ETH: series([2000]), USDC: usdcFlat(1) },
      }),
    ).toThrow(/PEPE/);
  });

  it("constantSeries spans the window at price 1", () => {
    const s = constantSeries("USDC", "2026-01-01T00:00:00.000Z", "2026-01-04T12:00:00.000Z");
    expect(s.points[0].priceUsd).toBe(1);
    expect(s.points[0].ts).toBe("2026-01-01T00:00:00.000Z");
    expect(s.points[s.points.length - 1].ts >= "2026-01-04T12:00:00.000Z").toBe(true);
  });

  it("defaultInitialBalance splits totalUsd at target weights using first-sample prices", () => {
    const bal = defaultInitialBalance({
      spec: SPEC_60_40,
      series: { ETH: series([2000, 4000]), USDC: usdcFlat(2) },
      totalUsd: 10_000,
    });
    expect(bal["ETH"]).toBeCloseTo(3, 9); // 6000 / 2000
    expect(bal["USDC"]).toBeCloseTo(4000, 9);
  });
});
