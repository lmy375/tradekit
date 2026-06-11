/**
 * Backtest risk-metrics tests (v41) — pure math, hand-computed
 * expectations.
 */

import { describe, it, expect } from "vitest";
import {
  buildEquityCurve,
  computeBacktestMetrics,
  inferPeriodsPerYear,
  downsampleCurve,
  type EquityPoint,
} from "./backtestMetrics.js";
import type { BacktestFire, PriceSeries } from "./backtest.js";

function dailySeries(startIso: string, prices: number[]): PriceSeries {
  const start = new Date(startIso).getTime();
  return {
    coinId: "ethereum",
    daysRequested: prices.length,
    points: prices.map((p, i) => ({
      ts: new Date(start + i * 86_400_000).toISOString(),
      priceUsd: p,
    })),
  };
}

function fill(ts: string, baseDelta: number, quoteDelta: number, gasCostUsd?: number): BacktestFire {
  return { ts, action: "fill", priceUsd: 0, baseDelta, quoteDelta, gasCostUsd };
}

describe("buildEquityCurve", () => {
  it("marks balances to market at every point; fires apply AT their point", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2500, 2000]);
    // Buy 1 ETH for 2000 USDC at point 0.
    const fires = [fill(series.points[0].ts, 1, -2000)];
    const curve = buildEquityCurve({
      initialBalance: { ETH: 0, USDC: 2000 },
      fires, series, baseSymbol: "ETH", quoteSymbol: "USDC",
    });
    expect(curve.map((p) => p.equityUsd)).toEqual([2000, 2500, 2000]);
  });

  it("gas accumulates from the fill's point onward", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000, 2000]);
    const fires = [fill(series.points[1].ts, 0.5, -1000, 3)];
    const curve = buildEquityCurve({
      initialBalance: { ETH: 0, USDC: 1000 },
      fires, series, baseSymbol: "ETH", quoteSymbol: "USDC",
    });
    // Point 0: untouched 1000. Points 1-2: 0.5×2000 + 0 − 3 = 997.
    expect(curve.map((p) => p.equityUsd)).toEqual([1000, 997, 997]);
  });

  it("zero-delta rows (halt / OCO cascade) pass through harmlessly", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000]);
    const fires: BacktestFire[] = [
      { ts: series.points[0].ts, action: "halt", priceUsd: 2000, baseDelta: 0, quoteDelta: 0 },
    ];
    const curve = buildEquityCurve({
      initialBalance: { USDC: 500 }, fires, series, baseSymbol: "ETH", quoteSymbol: "USDC",
    });
    expect(curve.map((p) => p.equityUsd)).toEqual([500, 500]);
  });
});

describe("computeBacktestMetrics — drawdown", () => {
  it("hand-computed max drawdown with peak/trough timestamps", () => {
    // Hold 1 ETH: equity 2000 → 3000 (peak) → 1800 (trough, −40%) → 2400.
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 3000, 1800, 2400]);
    const m = computeBacktestMetrics({
      initialBalance: { ETH: 1, USDC: 0 },
      fires: [], series, baseSymbol: "ETH", quoteSymbol: "USDC",
    })!;
    expect(m.maxDrawdownPct).toBeCloseTo(40, 9);
    expect(m.maxDrawdownUsd).toBeCloseTo(1200, 9);
    expect(m.peakTs).toBe(series.points[1].ts);
    expect(m.troughTs).toBe(series.points[2].ts);
    expect(m.returnPct).toBeCloseTo(20, 9); // 2000 → 2400
  });

  it("a monotonically rising curve has zero drawdown and null peak/trough", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200]);
    const m = computeBacktestMetrics({
      initialBalance: { ETH: 1 }, fires: [], series, baseSymbol: "ETH", quoteSymbol: "USDC",
    })!;
    expect(m.maxDrawdownPct).toBe(0);
    expect(m.peakTs).toBeNull();
    expect(m.troughTs).toBeNull();
  });

  it("an exit cuts strategy drawdown below hold's — the deploy-decision case", () => {
    // 1 ETH held into a crash vs selling at the first point.
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000, 1000, 1000]);
    const exit = computeBacktestMetrics({
      initialBalance: { ETH: 1, USDC: 0 },
      fires: [fill(series.points[1].ts, -1, 2000)],
      series, baseSymbol: "ETH", quoteSymbol: "USDC",
    })!;
    const hold = computeBacktestMetrics({
      initialBalance: { ETH: 1, USDC: 0 },
      fires: [], series, baseSymbol: "ETH", quoteSymbol: "USDC",
    })!;
    expect(hold.maxDrawdownPct).toBeCloseTo(50, 9);
    expect(exit.maxDrawdownPct).toBe(0); // flat in USDC through the crash
  });
});

describe("computeBacktestMetrics — volatility / sharpe", () => {
  it("a flat curve has zero volatility and null sharpe (no ±Infinity)", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000, 2000, 2000]);
    const m = computeBacktestMetrics({
      initialBalance: { ETH: 1 }, fires: [], series, baseSymbol: "ETH", quoteSymbol: "USDC",
    })!;
    expect(m.volatilityPctAnnual).toBeCloseTo(0, 12);
    expect(m.sharpe).toBeNull();
  });

  it("hand-computed daily vol annualizes by √365", () => {
    // Returns: +10%, −10% → mean 0, sample sd = sqrt(((0.1)^2+(−0.1)^2)/1) ≈ 0.141421.
    const series = dailySeries("2026-04-01T00:00:00Z", [1000, 1100, 990]);
    const m = computeBacktestMetrics({
      initialBalance: { ETH: 1 }, fires: [], series, baseSymbol: "ETH", quoteSymbol: "USDC",
    })!;
    const sd = Math.sqrt((0.1 ** 2 + 0.1 ** 2) / 1);
    expect(m.volatilityPctAnnual).toBeCloseTo(sd * Math.sqrt(365) * 100, 6);
    expect(m.sharpe).toBeCloseTo(0, 6); // mean return 0
  });

  it("too few points → null vol and sharpe", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2100]);
    const m = computeBacktestMetrics({
      initialBalance: { ETH: 1 }, fires: [], series, baseSymbol: "ETH", quoteSymbol: "USDC",
    })!;
    expect(m.volatilityPctAnnual).toBeNull();
    expect(m.sharpe).toBeNull();
  });
});

describe("computeBacktestMetrics — time in market", () => {
  it("buy at the midpoint → ~half the window in market", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000, 2000, 2000]);
    // All-quote until a buy at point 2.
    const m = computeBacktestMetrics({
      initialBalance: { ETH: 0, USDC: 1000 },
      fires: [fill(series.points[2].ts, 0.5, -1000)],
      series, baseSymbol: "ETH", quoteSymbol: "USDC",
    })!;
    expect(m.timeInMarketPct).toBeCloseTo(50, 9); // points 2,3 of 4
  });

  it("dust below 1% of equity counts as OUT of the market", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000]);
    const m = computeBacktestMetrics({
      initialBalance: { ETH: 0.000001, USDC: 1000 }, // $0.002 of ETH
      fires: [], series, baseSymbol: "ETH", quoteSymbol: "USDC",
    })!;
    expect(m.timeInMarketPct).toBe(0);
  });
});

describe("inferPeriodsPerYear / downsampleCurve", () => {
  it("daily spacing → 365; hourly → 8760; robust to one gap", () => {
    expect(inferPeriodsPerYear(dailySeries("2026-04-01T00:00:00Z", [1, 1, 1]))).toBeCloseTo(365, 6);
    const hourly: PriceSeries = {
      coinId: "x", daysRequested: 1,
      points: [0, 1, 2, 3].map((i) => ({ ts: new Date(Date.UTC(2026, 3, 1, i)).toISOString(), priceUsd: 1 })),
    };
    expect(inferPeriodsPerYear(hourly)).toBeCloseTo(8760, 6);
    // One 5-day hole in otherwise-daily data: median stays daily.
    const gappy = dailySeries("2026-04-01T00:00:00Z", [1, 1, 1, 1]);
    gappy.points.push({ ts: new Date(Date.parse(gappy.points[3].ts) + 5 * 86_400_000).toISOString(), priceUsd: 1 });
    expect(inferPeriodsPerYear(gappy)).toBeCloseTo(365, 6);
  });

  it("downsample keeps both endpoints and caps the length", () => {
    const curve: EquityPoint[] = Array.from({ length: 1000 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      equityUsd: i,
    }));
    const ds = downsampleCurve(curve, 100);
    expect(ds.length).toBe(100);
    expect(ds[0]).toEqual(curve[0]);
    expect(ds[ds.length - 1]).toEqual(curve[curve.length - 1]);
    // Short curves pass through untouched.
    expect(downsampleCurve(curve.slice(0, 50), 100)).toHaveLength(50);
  });

  it("empty series → null metrics", () => {
    expect(computeBacktestMetrics({
      initialBalance: { ETH: 1 },
      fires: [],
      series: { coinId: "x", daysRequested: 1, points: [] },
      baseSymbol: "ETH", quoteSymbol: "USDC",
    })).toBeNull();
  });
});
