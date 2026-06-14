/**
 * Price-context tests (v64). The compute is pinned in isolation (range,
 * trend, position, 24h, volatility, the plain-language summary, and the
 * flat/single-point edges), then gatherPriceContext is checked end-to-end
 * with an injected CoinGecko fetch — including the no-mapping → null degrade.
 */

import { describe, it, expect } from "vitest";
import { computePriceContext, gatherPriceContext, NEAR_HIGH_PCT, NEAR_LOW_PCT } from "./priceContext.js";
import type { PricePoint } from "./backtest.js";

const DAY = 86_400_000;
const NOW = new Date("2026-06-14T00:00:00Z");
// Build ascending day-spaced points ending at NOW.
const series = (prices: number[]): PricePoint[] =>
  prices.map((p, i) => ({
    ts: new Date(NOW.getTime() - (prices.length - 1 - i) * DAY).toISOString(),
    priceUsd: p,
  }));

describe("computePriceContext", () => {
  it("rising series → near the high, positive trend", () => {
    const r = computePriceContext(series([100, 110, 120, 130, 140]), 7, NOW);
    expect(r.currentPriceUsd).toBe(140);
    expect(r.low).toBe(100);
    expect(r.high).toBe(140);
    expect(r.rangePositionPct).toBeCloseTo(100, 6); // at the high
    expect(r.changePctWindow).toBeCloseTo(40, 6); // 100 → 140
    expect(r.summary).toMatch(/near the 7d high/);
    expect(r.rangePositionPct!).toBeGreaterThanOrEqual(NEAR_HIGH_PCT);
  });

  it("series that fell back to the low → near the low", () => {
    const r = computePriceContext(series([100, 150, 120, 100]), 7, NOW);
    expect(r.rangePositionPct).toBeCloseTo(0, 6); // current 100 == low
    expect(r.summary).toMatch(/near the 7d low/);
    expect(r.rangePositionPct!).toBeLessThanOrEqual(NEAR_LOW_PCT);
  });

  it("mid-range current sits between low and high", () => {
    const r = computePriceContext(series([100, 200, 150]), 7, NOW);
    expect(r.rangePositionPct).toBeCloseTo(50, 6); // 150 is halfway 100..200
    expect(r.summary).toMatch(/mid-range/);
  });

  it("flat series → null range position, zero volatility, 'flat range'", () => {
    const r = computePriceContext(series([100, 100, 100]), 7, NOW);
    expect(r.rangePositionPct).toBeNull();
    expect(r.volatilityPct).toBeCloseTo(0, 9);
    expect(r.changePctWindow).toBeCloseTo(0, 9);
    expect(r.summary).toMatch(/flat range/);
  });

  it("computes a 24h change when the window spans ≥24h, null when it doesn't", () => {
    // 5 day-spaced points → the point ~24h before the last is 130.
    const wide = computePriceContext(series([100, 110, 120, 130, 140]), 7, NOW);
    expect(wide.changePct24h).toBeCloseTo(((140 - 130) / 130) * 100, 6);

    // Two points 1h apart → window < 24h → null.
    const tight: PricePoint[] = [
      { ts: new Date(NOW.getTime() - 3_600_000).toISOString(), priceUsd: 100 },
      { ts: NOW.toISOString(), priceUsd: 105 },
    ];
    expect(computePriceContext(tight, 1, NOW).changePct24h).toBeNull();
  });

  it("volatility is the stddev of period returns (×100)", () => {
    // returns: +10%, then -? ... use a clean case: 100→110→121 = +10%,+10% → stddev 0.
    const steady = computePriceContext(series([100, 110, 121]), 7, NOW);
    expect(steady.volatilityPct).toBeCloseTo(0, 6);
    // mixed returns → non-zero.
    const choppy = computePriceContext(series([100, 120, 100, 120]), 7, NOW);
    expect(choppy.volatilityPct!).toBeGreaterThan(0);
  });

  it("single point degrades without throwing", () => {
    const r = computePriceContext(series([100]), 7, NOW);
    expect(r.currentPriceUsd).toBe(100);
    expect(r.rangePositionPct).toBeNull(); // low == high
    expect(r.volatilityPct).toBeNull(); // < 2 samples
    expect(r.changePctWindow).toBeCloseTo(0, 9);
  });
});

describe("gatherPriceContext", () => {
  const WETH_BASE = "0x4200000000000000000000000000000000000006"; // → coinId "ethereum"

  it("fetches + computes for a CoinGecko-mapped token (injected fetch)", async () => {
    const prices: [number, number][] = [100, 110, 120, 130, 140].map((p, i) => [
      NOW.getTime() - (4 - i) * DAY,
      p,
    ]);
    const r = await gatherPriceContext({
      tokenAddress: WETH_BASE,
      windowDays: 7,
      now: NOW,
      fetchImpl: async () => ({ prices }),
    });
    expect(r).not.toBeNull();
    expect(r!.coinId).toBe("ethereum");
    expect(r!.currentPriceUsd).toBe(140);
    expect(r!.changePctWindow).toBeCloseTo(40, 6);
  });

  it("returns null for a token with no CoinGecko mapping (graceful degrade)", async () => {
    const r = await gatherPriceContext({
      tokenAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      windowDays: 7,
      // fetch should never be called — getCoinGeckoId gates first.
      fetchImpl: async () => { throw new Error("should not fetch an unmapped token"); },
    });
    expect(r).toBeNull();
  });
});
