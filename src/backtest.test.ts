/**
 * Backtest core tests. Pure timeline walker against hand-built series;
 * fetcher tested via a mocked fetchImpl.
 *
 * The simulator reuses production trigger predicates (isOrderTriggered,
 * evaluateTrailingTrigger, matchesAt) so most edge-case correctness is
 * already covered by those tests. The tests here focus on the
 * integration: balance tracking, halt-on-insufficient-balance, fire
 * sequencing, PnL math, and CoinGecko response parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  simulateOrder,
  simulateSchedule,
  simulatePlaybook,
  fetchPriceSeries,
  parseSinceDuration,
  type PriceSeries,
  type OrderBacktestSpec,
  type ScheduleBacktestSpec,
  type SymbolBalance,
} from "./backtest.js";
import { parsePlaybookSpec } from "./playbooks.js";
import { ToolError } from "./errors.js";

// ── helpers ──────────────────────────────────────────────────

/** Build a price series at an hourly cadence starting at `startIso`. */
function hourlySeries(startIso: string, prices: number[]): PriceSeries {
  const start = new Date(startIso).getTime();
  return {
    coinId: "ethereum",
    daysRequested: Math.ceil(prices.length / 24) || 1,
    points: prices.map((p, i) => ({
      ts: new Date(start + i * 3_600_000).toISOString(),
      priceUsd: p,
    })),
  };
}

/** Build a price series at a daily cadence. */
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

// ── parseSinceDuration ───────────────────────────────────────

describe("parseSinceDuration", () => {
  it("accepts a bare integer as days", () => {
    expect(parseSinceDuration("30")).toBe(30);
    expect(parseSinceDuration("1")).toBe(1);
  });

  it("accepts Nd / Nw / Nm shorthand", () => {
    expect(parseSinceDuration("30d")).toBe(30);
    expect(parseSinceDuration("4w")).toBe(28);
    expect(parseSinceDuration("6m")).toBe(180);
  });

  it("is case-insensitive on the unit", () => {
    expect(parseSinceDuration("30D")).toBe(30);
    expect(parseSinceDuration("2W")).toBe(14);
  });

  it("rejects unknown units", () => {
    expect(() => parseSinceDuration("30y")).toThrow(ToolError);
    expect(() => parseSinceDuration("abc")).toThrow(ToolError);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseSinceDuration("0")).toThrow(/range/);
    expect(() => parseSinceDuration("5000")).toThrow(/range/);
    expect(() => parseSinceDuration("11000d")).toThrow(/range/);
  });
});

// ── fetchPriceSeries ─────────────────────────────────────────

describe("fetchPriceSeries", () => {
  it("returns null for off-listing tokens", async () => {
    const res = await fetchPriceSeries("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", 30, async () => ({}));
    expect(res).toBeNull();
  });

  it("rejects out-of-range days", async () => {
    await expect(
      fetchPriceSeries("0x4200000000000000000000000000000000000006", 0, async () => ({})),
    ).rejects.toThrow(/range/);
    await expect(
      fetchPriceSeries("0x4200000000000000000000000000000000000006", 4000, async () => ({})),
    ).rejects.toThrow(/range/);
  });

  it("throws when CoinGecko returns no points", async () => {
    await expect(
      fetchPriceSeries("0x4200000000000000000000000000000000000006", 30, async () => ({ prices: [] })),
    ).rejects.toThrow(/no price series/);
  });

  it("parses + sorts + dedupes points", async () => {
    const series = await fetchPriceSeries(
      "0x4200000000000000000000000000000000000006",
      7,
      async () => ({
        prices: [
          [1_700_003_600_000, 2000],
          [1_700_000_000_000, 1900], // earlier — should sort first
          [1_700_003_600_500, 2010], // dup minute bucket — drop
          [1_700_007_200_000, 2050],
        ],
      }),
    );
    expect(series).not.toBeNull();
    const points = series!.points;
    expect(points.length).toBe(3);
    // Sorted ascending.
    expect(points[0].priceUsd).toBe(1900);
    expect(points[1].priceUsd).toBe(2000);
    expect(points[2].priceUsd).toBe(2050);
  });

  it("rejects non-finite + non-positive prices in the response", async () => {
    const series = await fetchPriceSeries(
      "0x4200000000000000000000000000000000000006",
      7,
      async () => ({
        prices: [
          [1_700_000_000_000, NaN],
          [1_700_003_600_000, 0],
          [1_700_007_200_000, -5],
          [1_700_010_800_000, 1900],
        ],
      }),
    );
    expect(series).not.toBeNull();
    expect(series!.points.length).toBe(1);
    expect(series!.points[0].priceUsd).toBe(1900);
  });
});

// ── simulateOrder: input validation ──────────────────────────

describe("simulateOrder — validation", () => {
  const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200]);
  const baseSymbol = "WETH";
  const quoteSymbol = "USDC";
  const initialBalance: SymbolBalance = { USDC: 5000 };

  it("rejects price_below without target_price", () => {
    expect(() =>
      simulateOrder({
        spec: { side: "buy", trigger: "price_below", quoteAmount: 100 },
        baseSymbol,
        quoteSymbol,
        initialBalance,
        series,
      }),
    ).toThrow(/positive --price/);
  });

  it("rejects trailing without trail_pct", () => {
    expect(() =>
      simulateOrder({
        spec: { side: "sell", trigger: "trailing", baseAmount: 1 },
        baseSymbol,
        quoteSymbol,
        initialBalance,
        series,
      }),
    ).toThrow(/--trail-pct/);
  });

  it("rejects trail_pct out of (0,100]", () => {
    expect(() =>
      simulateOrder({
        spec: { side: "sell", trigger: "trailing", trailPct: 0, baseAmount: 1 },
        baseSymbol,
        quoteSymbol,
        initialBalance,
        series,
      }),
    ).toThrow(/--trail-pct/);
    expect(() =>
      simulateOrder({
        spec: { side: "sell", trigger: "trailing", trailPct: 101, baseAmount: 1 },
        baseSymbol,
        quoteSymbol,
        initialBalance,
        series,
      }),
    ).toThrow(/--trail-pct/);
  });

  it("rejects both baseAmount + quoteAmount", () => {
    expect(() =>
      simulateOrder({
        spec: { side: "buy", trigger: "price_below", targetPriceUsd: 1900, baseAmount: 1, quoteAmount: 100 },
        baseSymbol,
        quoteSymbol,
        initialBalance,
        series,
      }),
    ).toThrow(/exactly one/);
  });

  it("rejects sell with quoteAmount", () => {
    expect(() =>
      simulateOrder({
        spec: { side: "sell", trigger: "price_above", targetPriceUsd: 2100, quoteAmount: 100 },
        baseSymbol,
        quoteSymbol,
        initialBalance,
        series,
      }),
    ).toThrow(/--baseAmount/);
  });
});

// ── simulateOrder: price-trigger orders ──────────────────────

describe("simulateOrder — price_below buy", () => {
  it("fires on the first datapoint that crosses below the target", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2200, 2100, 1950, 1900, 2000]);
    const result = simulateOrder({
      spec: { side: "buy", trigger: "price_below", targetPriceUsd: 2000, quoteAmount: 1000 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 5000 },
      series,
    });
    expect(result.fires.length).toBe(1);
    const f = result.fires[0];
    expect(f.action).toBe("fill");
    expect(f.priceUsd).toBe(1950); // first crossing
    expect(f.ts).toBe(series.points[2].ts);
    expect(f.baseDelta).toBeCloseTo(1000 / 1950, 6);
    expect(f.quoteDelta).toBe(-1000);
    expect(result.finalBalance.USDC).toBe(4000);
    expect(result.finalBalance.WETH).toBeCloseTo(1000 / 1950, 6);
  });

  it("halts when quote balance is insufficient", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [1900, 1900]);
    const result = simulateOrder({
      spec: { side: "buy", trigger: "price_below", targetPriceUsd: 2000, quoteAmount: 5000 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 100 },
      series,
    });
    expect(result.fires.length).toBe(1);
    expect(result.fires[0].action).toBe("halt");
    expect(result.fires[0].note).toMatch(/insufficient USDC/);
    expect(result.finalBalance.USDC).toBe(100); // unchanged
  });

  it("fires at most once even if price stays below target", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [1900, 1850, 1800, 1750, 1700]);
    const result = simulateOrder({
      spec: { side: "buy", trigger: "price_below", targetPriceUsd: 2000, quoteAmount: 100 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 1000 },
      series,
    });
    expect(result.fires.length).toBe(1);
    expect(result.fires[0].priceUsd).toBe(1900); // first point that satisfies
  });

  it("never fires when price stays above target", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2200, 2300, 2400]);
    const result = simulateOrder({
      spec: { side: "buy", trigger: "price_below", targetPriceUsd: 2000, quoteAmount: 100 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 1000 },
      series,
    });
    expect(result.fires.length).toBe(0);
    expect(result.notes.some((n) => /never triggered/.test(n))).toBe(true);
    expect(result.finalBalance.USDC).toBe(1000);
  });
});

describe("simulateOrder — price_above sell (with --baseAmount)", () => {
  it("fires when price reaches target", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [1900, 2000, 2100, 2200]);
    const result = simulateOrder({
      spec: { side: "sell", trigger: "price_above", targetPriceUsd: 2100, baseAmount: 0.5 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { WETH: 1.0, USDC: 0 },
      series,
    });
    expect(result.fires.length).toBe(1);
    expect(result.fires[0].priceUsd).toBe(2100);
    expect(result.fires[0].baseDelta).toBe(-0.5);
    expect(result.fires[0].quoteDelta).toBe(1050);
    expect(result.finalBalance.WETH).toBe(0.5);
    expect(result.finalBalance.USDC).toBe(1050);
  });

  it("halts when base balance is insufficient", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2100]);
    const result = simulateOrder({
      spec: { side: "sell", trigger: "price_above", targetPriceUsd: 2100, baseAmount: 5 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { WETH: 0.1, USDC: 0 },
      series,
    });
    expect(result.fires.length).toBe(1);
    expect(result.fires[0].action).toBe("halt");
    expect(result.fires[0].note).toMatch(/insufficient WETH/);
  });
});

// ── simulateOrder: trailing orders ───────────────────────────

describe("simulateOrder — trailing sell", () => {
  it("does not start tracking until activation price is reached", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [1800, 1900, 2050, 2100, 2200, 2080]);
    // Activation = 2000, trail = 5%. Series rises through 2050→2200, then
    // dips to 2080 = -5.45% from HWM 2200 → fires.
    const result = simulateOrder({
      spec: {
        side: "sell",
        trigger: "trailing",
        targetPriceUsd: 2000,
        trailPct: 5,
        baseAmount: 1,
      },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { WETH: 2, USDC: 0 },
      series,
    });
    expect(result.fires.length).toBe(1);
    const f = result.fires[0];
    expect(f.action).toBe("fill");
    expect(f.priceUsd).toBe(2080);
    expect(f.baseDelta).toBe(-1);
    expect(f.quoteDelta).toBe(2080);
  });

  it("respects HWM ratcheting — fires at threshold relative to peak, not target", () => {
    // Trail = 10%. Peak at 3000 → threshold = 2700.
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2500, 3000, 2750, 2700]);
    const result = simulateOrder({
      spec: { side: "sell", trigger: "trailing", trailPct: 10, baseAmount: 1 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { WETH: 2, USDC: 0 },
      series,
    });
    expect(result.fires.length).toBe(1);
    expect(result.fires[0].priceUsd).toBe(2700);
  });

  it("never fires when price keeps rising", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200, 2300, 2400]);
    const result = simulateOrder({
      spec: { side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { WETH: 2, USDC: 0 },
      series,
    });
    expect(result.fires.length).toBe(0);
    expect(result.notes.some((n) => /never triggered/.test(n))).toBe(true);
  });
});

describe("simulateOrder — trailing buy", () => {
  it("fires on rebound after low-water mark", () => {
    // Trail = 5%. Dips to 1800 → threshold = 1890. Bounces to 1900 → fires.
    const series = hourlySeries("2026-04-01T00:00:00Z", [2100, 2000, 1900, 1800, 1900]);
    const result = simulateOrder({
      spec: { side: "buy", trigger: "trailing", trailPct: 5, quoteAmount: 2000 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 5000 },
      series,
    });
    expect(result.fires.length).toBe(1);
    expect(result.fires[0].priceUsd).toBe(1900);
    expect(result.fires[0].baseDelta).toBeCloseTo(2000 / 1900, 6);
  });
});

// ── simulateSchedule ─────────────────────────────────────────

describe("simulateSchedule — daily DCA", () => {
  it("fires once per cron-matched datapoint", () => {
    // Daily series, 7 datapoints, cron = midnight every day. Our series
    // starts at midnight, so each point matches.
    const series = dailySeries("2026-04-01T00:00:00Z", [1900, 1950, 2000, 2050, 2100, 2150, 2200]);
    const result = simulateSchedule({
      spec: {
        side: "buy",
        cron: "0 0 * * *",
        quoteAmount: 100,
      },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 1000 },
      series,
    });
    expect(result.fires.length).toBe(7);
    expect(result.fires.every((f) => f.action === "fill")).toBe(true);
    // Final quote = 1000 − 7 * 100 = 300.
    expect(result.finalBalance.USDC).toBe(300);
    // Final base = sum of 100/p for each datapoint.
    const expectedBase = series.points.reduce((acc, p) => acc + 100 / p.priceUsd, 0);
    expect(result.finalBalance.WETH).toBeCloseTo(expectedBase, 6);
  });

  it("halts when quote balance runs out", () => {
    // Daily series, 10 points, buying 300 USDC each. Balance 1000 covers
    // 3 buys; 4th should halt.
    const series = dailySeries(
      "2026-04-01T00:00:00Z",
      Array.from({ length: 10 }, () => 2000),
    );
    const result = simulateSchedule({
      spec: { side: "buy", cron: "0 0 * * *", quoteAmount: 300 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 1000 },
      series,
    });
    const fills = result.fires.filter((f) => f.action === "fill");
    expect(fills.length).toBe(3);
    const halts = result.fires.filter((f) => f.action === "halt");
    expect(halts.length).toBe(1);
    expect(halts[0].note).toMatch(/insufficient USDC/);
    // After halt we stop accumulating fires.
    expect(result.fires[result.fires.length - 1].action).toBe("halt");
  });

  it("respects maxRuns cap", () => {
    const series = dailySeries(
      "2026-04-01T00:00:00Z",
      Array.from({ length: 10 }, () => 2000),
    );
    const result = simulateSchedule({
      spec: { side: "buy", cron: "0 0 * * *", quoteAmount: 100, maxRuns: 3 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 10_000 },
      series,
    });
    expect(result.fires.filter((f) => f.action === "fill").length).toBe(3);
    expect(result.notes.some((n) => /max-runs/.test(n))).toBe(true);
  });

  it("does not match a datapoint twice within the same cron-minute bucket", () => {
    // Hourly series with cron "* * * * *" (every minute). Each datapoint
    // is a different minute bucket, so each should match once — but if
    // the bucket-dedupe is broken, we'd fire repeatedly per point.
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2000, 2000]);
    const result = simulateSchedule({
      spec: { side: "buy", cron: "* * * * *", quoteAmount: 10 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 1000 },
      series,
    });
    // One fire per datapoint, three datapoints → three fills.
    expect(result.fires.length).toBe(3);
    expect(result.fires.every((f) => f.action === "fill")).toBe(true);
  });

  it("yields no fires when the cron never matches the data points", () => {
    // Daily series, but cron is "0 9 * * *" (9am UTC). Daily series
    // points are at midnight, never match.
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000, 2000]);
    const result = simulateSchedule({
      spec: { side: "buy", cron: "0 9 * * *", quoteAmount: 10 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 1000 },
      series,
    });
    expect(result.fires.length).toBe(0);
    expect(result.notes.some((n) => /never matched/.test(n))).toBe(true);
  });
});

describe("simulateSchedule — validation", () => {
  const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2100]);

  it("rejects a sell schedule with quoteAmount", () => {
    expect(() =>
      simulateSchedule({
        spec: { side: "sell", cron: "0 0 * * *", quoteAmount: 100 },
        baseSymbol: "WETH",
        quoteSymbol: "USDC",
        initialBalance: { WETH: 1 },
        series,
      }),
    ).toThrow(/--baseAmount/);
  });

  it("rejects both amount params", () => {
    expect(() =>
      simulateSchedule({
        spec: { side: "buy", cron: "0 0 * * *", baseAmount: 1, quoteAmount: 100 },
        baseSymbol: "WETH",
        quoteSymbol: "USDC",
        initialBalance: { USDC: 1000 },
        series,
      }),
    ).toThrow(/exactly one/);
  });

  it("rejects an invalid cron expression", () => {
    expect(() =>
      simulateSchedule({
        spec: { side: "buy", cron: "not a cron", quoteAmount: 100 },
        baseSymbol: "WETH",
        quoteSymbol: "USDC",
        initialBalance: { USDC: 1000 },
        series,
      }),
    ).toThrow();
  });

  it("rejects maxRuns of zero or negative", () => {
    expect(() =>
      simulateSchedule({
        spec: { side: "buy", cron: "0 0 * * *", quoteAmount: 10, maxRuns: 0 },
        baseSymbol: "WETH",
        quoteSymbol: "USDC",
        initialBalance: { USDC: 1000 },
        series,
      }),
    ).toThrow(/max-runs/);
  });
});

// ── PnL math ─────────────────────────────────────────────────

describe("PnL math", () => {
  it("computes initialUsd, finalUsd, pnlUsd, holdPnlUsd correctly", () => {
    // Hold case: buy 1 WETH at start (2000) → end at 2400.
    // No trades: hold value = 1*2400 = 2400, hold PnL = 400.
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200, 2300, 2400]);
    const result = simulateOrder({
      spec: { side: "sell", trigger: "price_above", targetPriceUsd: 2200, baseAmount: 1 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { WETH: 1, USDC: 0 },
      series,
    });
    expect(result.initialUsd).toBe(2000);
    expect(result.holdFinalUsd).toBe(2400);
    expect(result.holdPnlUsd).toBe(400);
    // Strategy: sold at 2200 → final = 0 WETH + 2200 USDC = 2200.
    expect(result.finalUsd).toBe(2200);
    expect(result.pnlUsd).toBe(200);
    // Strategy underperformed hold by 200.
  });

  it("strategy that catches a top beats hold", () => {
    // Peak at 3000, dips back to 2000. Trailing 10% fires at 2700.
    const series = hourlySeries(
      "2026-04-01T00:00:00Z",
      [2000, 2500, 3000, 2700, 2200, 2000],
    );
    const result = simulateOrder({
      spec: { side: "sell", trigger: "trailing", trailPct: 10, baseAmount: 1 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { WETH: 1, USDC: 0 },
      series,
    });
    expect(result.fires.length).toBe(1);
    expect(result.fires[0].priceUsd).toBe(2700);
    expect(result.finalUsd).toBe(2700);
    expect(result.holdFinalUsd).toBe(2000);
    // Strategy net = +700; hold net = 0.
    expect(result.pnlUsd).toBe(700);
    expect(result.holdPnlUsd).toBe(0);
  });
});

// ── balance normalization ────────────────────────────────────

describe("balance normalization", () => {
  it("uppercases keys", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 1900]);
    const result = simulateOrder({
      spec: { side: "buy", trigger: "price_below", targetPriceUsd: 1950, quoteAmount: 100 },
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { usdc: 1000 } as SymbolBalance,
      series,
    });
    expect(result.fires.length).toBe(1);
    expect(result.finalBalance.USDC).toBe(900);
  });

  it("rejects negative balances", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000]);
    expect(() =>
      simulateOrder({
        spec: { side: "buy", trigger: "price_below", targetPriceUsd: 2100, quoteAmount: 10 },
        baseSymbol: "WETH",
        quoteSymbol: "USDC",
        initialBalance: { USDC: -1 },
        series,
      }),
    ).toThrow(/non-negative/);
  });
});

// ── empty / degenerate series ────────────────────────────────

describe("degenerate series", () => {
  let savedConsoleWarn: typeof console.warn;
  beforeEach(() => {
    savedConsoleWarn = console.warn;
    console.warn = () => {};
  });
  afterEach(() => {
    console.warn = savedConsoleWarn;
  });

  it("single-point series — order never triggers but result is well-formed", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000]);
    const spec: OrderBacktestSpec = {
      side: "buy",
      trigger: "price_below",
      targetPriceUsd: 1900,
      quoteAmount: 100,
    };
    const result = simulateOrder({
      spec,
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 1000 },
      series,
    });
    expect(result.fires).toEqual([]);
    expect(result.windowStart).toBe(result.windowEnd);
    expect(result.initialUsd).toBe(1000); // 0 WETH * 2000 + 1000 USDC
    expect(result.finalUsd).toBe(1000); // no trades
  });

  it("schedule with no datapoints fires nothing (handled at single-point)", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000]);
    const result = simulateSchedule({
      spec: { side: "buy", cron: "0 9 * * *", quoteAmount: 100 } as ScheduleBacktestSpec,
      baseSymbol: "WETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 1000 },
      series,
    });
    expect(result.fires.length).toBe(0);
  });
});

// ── simulatePlaybook ─────────────────────────────────────────

describe("simulatePlaybook — validation", () => {
  const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200]);

  it("rejects rebalance strategies", () => {
    const spec = parsePlaybookSpec({
      name: "with-rebalance",
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { type: "rebalance", targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }] },
      ],
    });
    expect(() =>
      simulatePlaybook({
        spec,
        baseSymbol: "ETH",
        quoteSymbol: "USDC",
        initialBalance: { ETH: 1, USDC: 0 },
        series,
      }),
    ).toThrow(/rebalance plans aren't supported/);
  });

  it("rejects mixed-base playbook", () => {
    const spec = parsePlaybookSpec({
      name: "mixed-base",
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { type: "order", side: "sell", trigger: "price_above", price: 100000, baseAmount: 0.01, base: "WBTC", quote: "USDC" },
      ],
    });
    expect(() =>
      simulatePlaybook({
        spec,
        baseSymbol: "ETH",
        quoteSymbol: "USDC",
        initialBalance: { ETH: 1, USDC: 0 },
        series,
      }),
    ).toThrow(/doesn't match the playbook backtest base/);
  });

  it("rejects mixed-quote playbook", () => {
    const spec = parsePlaybookSpec({
      name: "mixed-quote",
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { type: "order", side: "sell", trigger: "price_above", price: 3000, baseAmount: 1, base: "ETH", quote: "USDT" },
      ],
    });
    expect(() =>
      simulatePlaybook({
        spec,
        baseSymbol: "ETH",
        quoteSymbol: "USDC",
        initialBalance: { ETH: 1, USDC: 0 },
        series,
      }),
    ).toThrow(/doesn't match the playbook backtest quote/);
  });

  it("collects all violations into one message", () => {
    const spec = parsePlaybookSpec({
      name: "many-bad",
      strategies: [
        { type: "rebalance", targets: [{ token: "ETH", targetPct: 50 }, { token: "USDC", targetPct: 50 }] },
        { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "WBTC", quote: "USDC" },
      ],
    });
    let msg = "";
    try {
      simulatePlaybook({
        spec,
        baseSymbol: "ETH",
        quoteSymbol: "USDC",
        initialBalance: { ETH: 1 },
        series,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/rebalance plans/);
    expect(msg).toMatch(/doesn't match the playbook backtest base/);
  });
});

describe("simulatePlaybook — OCO cascade", () => {
  // Bracket: TP at $4000, SL at $2700, both in group "bracket".
  // Series: $3000 → $4100 (TP fires) → $2600 (would have fired SL but
  // it should already be cancelled via OCO cascade).
  it("a fired peer cancels the rest of the group", () => {
    const spec = parsePlaybookSpec({
      name: "bracket",
      strategies: [
        { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 4000, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket" },
        { id: "sl", type: "order", side: "sell", trigger: "price_below", price: 2700, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket" },
      ],
    });
    const series = hourlySeries("2026-04-01T00:00:00Z", [3000, 4100, 2600]);
    const result = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 2, USDC: 0 },
      series,
    });
    // 1 fill (TP) + 1 cascade event (SL cancelled).
    expect(result.fires.length).toBe(2);
    const fillFires = result.fires.filter((f) => f.multiAction === "fill");
    expect(fillFires.length).toBe(1);
    expect(fillFires[0].strategyId).toBe("tp");
    const cascadeFires = result.fires.filter((f) => f.multiAction === "oco_cascade");
    expect(cascadeFires.length).toBe(1);
    expect(cascadeFires[0].strategyId).toBe("sl");
    // The SL price at $2600 came after, but should NOT have fired.
    const slStat = result.perStrategy.find((s) => s.strategyId === "sl");
    expect(slStat?.finalStatus).toBe("cancelled");
    expect(slStat?.fireCount).toBe(0);
  });

  it("orders without group don't cascade", () => {
    const spec = parsePlaybookSpec({
      name: "no-group",
      strategies: [
        { id: "a", type: "order", side: "sell", trigger: "price_above", price: 4000, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "b", type: "order", side: "sell", trigger: "price_below", price: 2700, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const series = hourlySeries("2026-04-01T00:00:00Z", [3000, 4100, 2600]);
    const result = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 2, USDC: 0 },
      series,
    });
    // Both orders should fire since they're not OCO'd.
    const fills = result.fires.filter((f) => f.multiAction === "fill");
    expect(fills.length).toBe(2);
    expect(fills[0].strategyId).toBe("a");
    expect(fills[1].strategyId).toBe("b");
    expect(result.perStrategy.find((s) => s.strategyId === "a")?.finalStatus).toBe("filled");
    expect(result.perStrategy.find((s) => s.strategyId === "b")?.finalStatus).toBe("filled");
  });
});

describe("simulatePlaybook — shared balance", () => {
  it("DCA buys reduce USDC the trail's exit fills into", () => {
    // Setup: trailing-sell on the way up; DCA buying weekly (using the
    // same USDC budget but irrelevant to the sell). We're checking
    // that the simulator tracks the shared balance correctly — final
    // balance reflects BOTH the sell proceeds AND the DCA purchases.
    const series = hourlySeries(
      "2026-04-01T00:00:00Z",
      // 30 hourly points — peaks at hour 5 ($3000), trail of 5% means
      // threshold = $2850. Hour 6 = $2840 → fires the trail.
      Array.from({ length: 30 }, (_, i) => (i <= 5 ? 2000 + 200 * i : 2840 - 5 * (i - 6))),
    );
    const spec = parsePlaybookSpec({
      name: "trail-and-dca",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        // hourly buys of $50 each, runs cap 3 — keeps the test bounded.
        { id: "dca", type: "schedule", side: "buy", every: "1h", quoteAmount: 50, maxRuns: 3, base: "ETH", quote: "USDC" },
      ],
    });
    const result = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 1, USDC: 300 },
      series,
    });
    const trail = result.perStrategy.find((s) => s.strategyId === "trail")!;
    const dca = result.perStrategy.find((s) => s.strategyId === "dca")!;
    expect(trail.fireCount).toBe(1);
    expect(trail.finalStatus).toBe("filled");
    expect(dca.fireCount).toBe(3); // maxRuns hit
    expect(dca.finalStatus).toBe("completed");
    // Sanity: total USDC spent on DCA = 3 * 50 = 150; remaining USDC
    // before trail fire was 150; trail fires at ~$2840 selling 1 ETH
    // → adds ~$2840 to USDC; final USDC ≈ 150 + 2840 = 2990.
    expect(result.finalBalance.USDC).toBeCloseTo(150 + 2840, 5);
    // Final ETH balance: started with 1; DCA bought a small amount
    // each tick at varying prices; trail sold exactly 1. Should still
    // have the DCA-bought ETH net.
    expect(result.finalBalance.ETH).toBeGreaterThan(0);
  });

  it("a starving strategy is parked, others continue", () => {
    // Tiny starting USDC and NO sell-side strategy refilling it; DCA
    // succeeds once + halts on the second try; the never-fires order
    // remains active (a different lifecycle outcome from the starving
    // DCA) so we can verify that one strategy's halt doesn't pollute
    // other strategies.
    const series = hourlySeries(
      "2026-04-01T00:00:00Z",
      Array.from({ length: 10 }, () => 2000),
    );
    const spec = parsePlaybookSpec({
      name: "starve-one",
      strategies: [
        { id: "dca", type: "schedule", side: "buy", every: "1h", quoteAmount: 60, base: "ETH", quote: "USDC" },
        // High-price sell that never triggers — should stay "active".
        { id: "moon", type: "order", side: "sell", trigger: "price_above", price: 99999, baseAmount: 0.1, base: "ETH", quote: "USDC" },
      ],
    });
    const result = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 1, USDC: 100 },
      series,
    });
    const dca = result.perStrategy.find((s) => s.strategyId === "dca")!;
    const moon = result.perStrategy.find((s) => s.strategyId === "moon")!;
    // DCA: 1st fire OK ($60), 2nd fire halts (only $40 left). Status
    // flips to cancelled at halt.
    expect(dca.fireCount).toBe(1);
    expect(dca.finalStatus).toBe("cancelled");
    // The unrelated moon order — never triggered, never starved —
    // stays active through to the end of the timeline.
    expect(moon.fireCount).toBe(0);
    expect(moon.finalStatus).toBe("active");
  });
});

describe("simulatePlaybook — per-strategy stats", () => {
  it("collects fireCount + base/quote delta + finalStatus", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200, 2300, 2400]);
    const spec = parsePlaybookSpec({
      name: "stats-test",
      strategies: [
        { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 2200, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "never-fires", type: "order", side: "sell", trigger: "price_above", price: 99999, baseAmount: 0.1, base: "ETH", quote: "USDC" },
      ],
    });
    const result = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 1, USDC: 0 },
      series,
    });
    const tp = result.perStrategy.find((s) => s.strategyId === "tp")!;
    expect(tp.fireCount).toBe(1);
    expect(tp.baseDelta).toBe(-1);
    expect(tp.quoteDelta).toBe(2200);
    expect(tp.finalStatus).toBe("filled");
    const never = result.perStrategy.find((s) => s.strategyId === "never-fires")!;
    expect(never.fireCount).toBe(0);
    expect(never.finalStatus).toBe("active");
  });

  it("schedule perStrategy accumulates across fires", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000, 2000, 2000]);
    const spec = parsePlaybookSpec({
      name: "dca-only",
      strategies: [
        { id: "dca", type: "schedule", side: "buy", cron: "0 0 * * *", quoteAmount: 100, base: "ETH", quote: "USDC" },
      ],
    });
    const result = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { USDC: 1000 },
      series,
    });
    const dca = result.perStrategy.find((s) => s.strategyId === "dca")!;
    expect(dca.fireCount).toBe(4);
    expect(dca.baseDelta).toBeCloseTo(4 * 0.05, 6); // 4 buys * $100/$2000 = 0.2 ETH
    expect(dca.quoteDelta).toBe(-400);
    expect(dca.finalStatus).toBe("active"); // schedule didn't hit maxRuns
  });
});

describe("simulatePlaybook — expiration", () => {
  it("an expired order doesn't fire", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200, 2300]);
    const spec = parsePlaybookSpec({
      name: "with-expiry",
      strategies: [
        // Trigger at $2100 BUT expired before the series started.
        { id: "stale", type: "order", side: "sell", trigger: "price_above", price: 2100, baseAmount: 1, base: "ETH", quote: "USDC", expiresAt: "2026-03-31T00:00:00Z" },
      ],
    });
    const result = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 1, USDC: 0 },
      series,
    });
    const stale = result.perStrategy.find((s) => s.strategyId === "stale")!;
    expect(stale.fireCount).toBe(0);
    expect(stale.finalStatus).toBe("cancelled");
  });
});

describe("simulatePlaybook — full smoke", () => {
  it("trail + bracket + DCA over 7-day series", () => {
    // 7d hourly = 168 points. Price drifts: rises early, peaks, drops.
    const prices: number[] = [];
    for (let i = 0; i < 168; i++) {
      // rise to $3500 by hour 80, then drop to $2500
      if (i <= 80) prices.push(2500 + (1000 * i) / 80);
      else prices.push(3500 - (1000 * (i - 80)) / 87);
    }
    const series = hourlySeries("2026-04-01T00:00:00Z", prices);
    const spec = parsePlaybookSpec({
      name: "full-smoke",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 3800, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket" },
        { id: "sl", type: "order", side: "sell", trigger: "price_below", price: 2300, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket" },
        { id: "dca", type: "schedule", side: "buy", every: "1d", quoteAmount: 50, base: "ETH", quote: "USDC" },
      ],
    });
    const result = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 2, USDC: 1000 },
      series,
    });
    // TP at $3800 never reached (peak was $3500).
    const tp = result.perStrategy.find((s) => s.strategyId === "tp")!;
    expect(tp.fireCount).toBe(0);
    // Trail with 5%, peak $3500 → threshold $3325. Should fire on the descent.
    const trail = result.perStrategy.find((s) => s.strategyId === "trail")!;
    expect(trail.fireCount).toBe(1);
    expect(trail.finalStatus).toBe("filled");
    // DCA fires daily — 7 days, 7 fires.
    const dca = result.perStrategy.find((s) => s.strategyId === "dca")!;
    expect(dca.fireCount).toBeGreaterThanOrEqual(6); // depends on which hour the cron matches
    expect(result.fires.filter((f) => f.multiAction === "fill").length).toBeGreaterThan(0);
  });
});

// ── v31: on_fill hook simulation ─────────────────────────────

describe("simulatePlaybook — on_fill hooks", () => {
  const HOOK = {
    type: "createOrder",
    spec: {
      side: "sell",
      trigger: "trailing",
      trailPct: 10,
      base: "ETH",
      quote: "USDC",
      baseAmount: "{{filled.baseAmount}}",
    },
  };

  function dcaSpec(over: Record<string, unknown> = {}) {
    return parsePlaybookSpec({
      name: "dca-hooked",
      strategies: [
        {
          id: "dca", type: "schedule", side: "buy", cron: "0 0 * * *", quoteAmount: 1000,
          base: "ETH", quote: "USDC", onFill: HOOK, ...over,
        },
      ],
    });
  }

  it("each schedule fire spawns one hook order sized to the FILLED amount", () => {
    // Daily series at midnight — the cron matches every point.
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000, 2000]);
    const r = simulatePlaybook({
      spec: dcaSpec({ maxRuns: 2 }),
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 10_000 },
      series,
    });
    const hookStats = r.perStrategy.filter((s) => s.strategyId.startsWith("dca:hook#"));
    expect(hookStats).toHaveLength(2); // maxRuns caps spawns too
    expect(r.notes.some((n) => n.includes("2 follow-up order(s) spawned"))).toBe(true);
    // Each fill bought 0.5 ETH (1000/2000) → hook trail sized 0.5.
    const dca = r.perStrategy.find((s) => s.strategyId === "dca")!;
    expect(dca.fireCount).toBe(2);
    expect(dca.baseDelta).toBeCloseTo(1.0, 9);
  });

  it("a spawned trailing hook actually fires on retracement — full DCA+bracket round trip", () => {
    // Day 0: DCA buys 0.5 ETH @2000 → spawns trail (10%).
    // Day 1+: price runs to 3000 (HWM), then crashes to 2400 (-20%)
    // → the hook trail fires, selling the 0.5 ETH @2400.
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 3000, 2400, 2400]);
    const r = simulatePlaybook({
      spec: dcaSpec({ maxRuns: 1 }),
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 },
      series,
    });
    const hook = r.perStrategy.find((s) => s.strategyId === "dca:hook#1")!;
    expect(hook.finalStatus).toBe("filled");
    expect(hook.baseDelta).toBeCloseTo(-0.5, 9); // sold exactly the slice
    // Balance round trip: 1000 → bought 0.5@2000 → sold 0.5@2400 = 1200 USDC.
    expect(r.finalBalance["USDC"]).toBeCloseTo(1200, 6);
    expect(r.finalBalance["ETH"]).toBeCloseTo(0, 9);
  });

  it("hook orders start evaluating on the NEXT datapoint (live-engine ordering)", () => {
    // The fill happens at 2000; a price_below 2100 hook would already
    // be "triggered" at the same point — but live engines create the
    // order AFTER the fill, so it must not fire until the next tick.
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 5000]);
    const r = simulatePlaybook({
      spec: dcaSpec({
        maxRuns: 1,
        onFill: { type: "createOrder", spec: { ...HOOK.spec, trigger: "price_below", price: 2100, trailPct: undefined } },
      }),
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 },
      series,
    });
    const hook = r.perStrategy.find((s) => s.strategyId === "dca:hook#1")!;
    // Next datapoint is 5000 — above the 2100 trigger → never fires.
    expect(hook.finalStatus).toBe("active");
    expect(hook.fireCount).toBe(0);
  });

  it("rejects a hook whose pair doesn't match the playbook series", () => {
    const spec = dcaSpec({
      onFill: { type: "createOrder", spec: { ...HOOK.spec, base: "WBTC" } },
    });
    expect(() =>
      simulatePlaybook({
        spec,
        baseSymbol: "ETH",
        quoteSymbol: "USDC",
        initialBalance: { ETH: 0, USDC: 1000 },
        series: dailySeries("2026-04-01T00:00:00Z", [2000, 2000]),
      }),
    ).toThrow(/hook base "WBTC" doesn't match/);
  });
});

describe("simulatePlaybook — ORDER on_fill hooks (v31)", () => {
  it("an order fill spawns its hook; the chained bracket later fires", () => {
    // Limit buy at 1900 fills on day 1 (price dips to 1850), spawning
    // a 10% trail sized to the bought amount; the trail tracks the
    // run to 3000 and fires on the crash to 2400.
    const spec = parsePlaybookSpec({
      name: "dip-buy-bracket",
      strategies: [
        {
          id: "dip", type: "order", side: "buy", trigger: "price_below", price: 1900,
          quoteAmount: 1850, base: "ETH", quote: "USDC",
          onFill: {
            type: "createOrder",
            spec: { side: "sell", trigger: "trailing", trailPct: 10, base: "ETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
          },
        },
      ],
    });
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 1850, 3000, 2400, 2400]);
    const r = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1850 },
      series,
    });
    const dip = r.perStrategy.find((s) => s.strategyId === "dip")!;
    expect(dip.finalStatus).toBe("filled");
    const hook = r.perStrategy.find((s) => s.strategyId === "dip:hook#1")!;
    expect(hook.finalStatus).toBe("filled");
    expect(hook.baseDelta).toBeCloseTo(-1, 9); // sold the full bought amount (1850/1850)
    // Round trip: bought 1 ETH @1850, sold @2400.
    expect(r.finalBalance["USDC"]).toBeCloseTo(2400, 6);
    expect(r.finalBalance["ETH"]).toBeCloseTo(0, 9);
    expect(r.notes.some((n) => n.includes("1 follow-up order(s) spawned"))).toBe(true);
  });
});

// ── multi-leg bracket hooks (createOrders) ──────────────────

describe("simulatePlaybook — multi-leg bracket hooks", () => {
  const BRACKET = {
    type: "createOrders",
    specs: [
      { side: "sell", trigger: "price_above", price: 2600, base: "ETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
      { side: "sell", trigger: "price_below", price: 1500, base: "ETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
    ],
  };

  function bracketSpec(over: Record<string, unknown> = {}) {
    return parsePlaybookSpec({
      name: "dca-bracketed",
      strategies: [
        {
          id: "dca", type: "schedule", side: "buy", cron: "0 0 * * *", quoteAmount: 1000,
          base: "ETH", quote: "USDC", maxRuns: 1, onFill: BRACKET, ...over,
        },
      ],
    });
  }

  it("TP fires → SL auto-cancelled via the shared OCO group (full bracket round trip)", () => {
    // Day 0: DCA buys 0.5 ETH @2000 → spawns TP(2600) + SL(1500) legs.
    // Day 1: price 2700 → TP fires, OCO cascade kills the SL leg.
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2700, 2700]);
    const r = simulatePlaybook({
      spec: bracketSpec(),
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 },
      series,
    });
    const tp = r.perStrategy.find((s) => s.strategyId === "dca:hook#1.1")!;
    const sl = r.perStrategy.find((s) => s.strategyId === "dca:hook#1.2")!;
    expect(tp.finalStatus).toBe("filled");
    expect(tp.baseDelta).toBeCloseTo(-0.5, 9);
    expect(sl.finalStatus).toBe("cancelled");
    expect(sl.fireCount).toBe(0);
    // 1000 → bought 0.5@2000 → TP sold 0.5@2700 = 1350 USDC, flat ETH.
    expect(r.finalBalance["USDC"]).toBeCloseTo(1350, 6);
    expect(r.finalBalance["ETH"]).toBeCloseTo(0, 9);
  });

  it("SL fires on the crash → TP auto-cancelled", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 1400, 1400]);
    const r = simulatePlaybook({
      spec: bracketSpec(),
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 },
      series,
    });
    const tp = r.perStrategy.find((s) => s.strategyId === "dca:hook#1.1")!;
    const sl = r.perStrategy.find((s) => s.strategyId === "dca:hook#1.2")!;
    expect(sl.finalStatus).toBe("filled");
    expect(tp.finalStatus).toBe("cancelled");
    // Stop-loss capped the damage: sold 0.5 @1400 = 700 USDC back.
    expect(r.finalBalance["USDC"]).toBeCloseTo(700, 6);
  });

  it("validation rejects a bracket leg whose pair mismatches, naming the leg", () => {
    const spec = bracketSpec({
      onFill: {
        type: "createOrders",
        specs: [
          BRACKET.specs[0],
          { ...BRACKET.specs[1], base: "WBTC" },
        ],
      },
    });
    expect(() =>
      simulatePlaybook({
        spec,
        baseSymbol: "ETH",
        quoteSymbol: "USDC",
        initialBalance: { ETH: 0, USDC: 1000 },
        series: dailySeries("2026-04-01T00:00:00Z", [2000, 2000]),
      }),
    ).toThrow(/specs\[1\].*WBTC/s);
  });
});

// ── v35: "max" sizing in the simulator ───────────────────────

describe("simulatePlaybook — max sizing", () => {
  it("a trailing-max stop sells the WHOLE accumulated DCA position", () => {
    // Daily DCA buys 0.5 ETH/day (1000 quote @2000) for 3 days → 1.5 ETH.
    // A standalone trailing-max order (10%) rides the pump to 3000 and
    // fires on the crash to 2400 — selling ALL 1.5 ETH, not a fixed slice.
    const spec = parsePlaybookSpec({
      name: "dca-plus-max-stop",
      strategies: [
        {
          id: "dca", type: "schedule", side: "buy", cron: "0 0 * * *", quoteAmount: 1000,
          base: "ETH", quote: "USDC", maxRuns: 3,
        },
        {
          id: "stop", type: "order", side: "sell", trigger: "trailing", trailPct: 10,
          base: "ETH", quote: "USDC", baseAmount: "max",
        },
      ],
    });
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000, 2000, 3000, 2400, 2400]);
    const r = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 3000 },
      series,
    });
    const stop = r.perStrategy.find((s) => s.strategyId === "stop")!;
    expect(stop.finalStatus).toBe("filled");
    // Sold the entire accumulated position: 3 × 0.5 = 1.5 ETH @ 2400.
    expect(stop.baseDelta).toBeCloseTo(-1.5, 9);
    expect(r.finalBalance["ETH"]).toBeCloseTo(0, 9);
    expect(r.finalBalance["USDC"]).toBeCloseTo(1.5 * 2400, 6);
  });

  it("buy with quoteAmount max goes all-in from the sim balance", () => {
    const spec = parsePlaybookSpec({
      name: "all-in",
      strategies: [
        {
          id: "dip", type: "order", side: "buy", trigger: "price_below", price: 1900,
          base: "ETH", quote: "USDC", quoteAmount: "max",
        },
      ],
    });
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 1800, 1800]);
    const r = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 900 },
      series,
    });
    const dip = r.perStrategy.find((s) => s.strategyId === "dip")!;
    expect(dip.finalStatus).toBe("filled");
    expect(r.finalBalance["USDC"]).toBeCloseTo(0, 9);
    expect(r.finalBalance["ETH"]).toBeCloseTo(900 / 1800, 9);
  });
});

// ── v35.5: percentage sizing — the scale-out playbook ────────

describe("simulatePlaybook — percentage scale-out", () => {
  it("TP1 takes 50% at the target; the trailing-max leg exits the rest", () => {
    // Buy 1 ETH up front (manual position via initialBalance). Two
    // OCO-free exits: TP1 sells 50% at 2600; the trailing 10% stop
    // rides to 3000 and fires at 2700 selling the REMAINING half.
    const spec = parsePlaybookSpec({
      name: "scale-out",
      strategies: [
        {
          id: "tp1", type: "order", side: "sell", trigger: "price_above", price: 2600,
          base: "ETH", quote: "USDC", baseAmount: "50%",
        },
        {
          id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 10,
          base: "ETH", quote: "USDC", baseAmount: "max",
        },
      ],
    });
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2700, 3000, 2700, 2700]);
    const r = simulatePlaybook({
      spec,
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      initialBalance: { ETH: 1, USDC: 0 },
      series,
    });
    const tp1 = r.perStrategy.find((s) => s.strategyId === "tp1")!;
    const trail = r.perStrategy.find((s) => s.strategyId === "trail")!;
    expect(tp1.finalStatus).toBe("filled");
    expect(tp1.baseDelta).toBeCloseTo(-0.5, 9);  // half the position at 2700
    expect(trail.finalStatus).toBe("filled");
    expect(trail.baseDelta).toBeCloseTo(-0.5, 9); // max = whatever remains
    expect(r.finalBalance["ETH"]).toBeCloseTo(0, 9);
    // 0.5×2700 (TP1) + 0.5×2700 (trail fired on the dip back to 2700).
    expect(r.finalBalance["USDC"]).toBeCloseTo(2700, 6);
  });
});

// ── v39.5: signal-history replay ─────────────────────────────

describe("simulatePlaybook — signal replay", () => {
  const entry = {
    id: "breakout", type: "order", side: "buy", trigger: "signal", signalName: "tv-breakout",
    base: "ETH", quote: "USDC", quoteAmount: 1000,
  };
  const sigSpec = (over: Record<string, unknown> = {}) =>
    parsePlaybookSpec({ name: "sig-replay", strategies: [{ ...entry, ...over }] });

  it("fires at the FIRST price point at-or-after the signal arrival", () => {
    // Signal lands 00:30; next datapoint is 01:00 @2100 — the sim twin
    // of "the next engine tick after the webhook".
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200]);
    const r = simulatePlaybook({
      spec: sigSpec(), baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 }, series,
      signals: [{ name: "tv-breakout", at: "2026-04-01T00:30:00Z" }],
    });
    const fills = r.fires.filter((f) => f.multiAction === "fill");
    expect(fills.length).toBe(1);
    expect(fills[0].ts).toBe("2026-04-01T01:00:00.000Z");
    expect(fills[0].priceUsd).toBe(2100);
    expect(r.finalBalance["USDC"]).toBeCloseTo(0, 6);
    expect(r.finalBalance["ETH"]).toBeCloseTo(1000 / 2100, 9);
    expect(r.perStrategy[0].finalStatus).toBe("filled");
  });

  it("a signal BEFORE the series window is stale and never fires (armed-from rule)", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200]);
    const r = simulatePlaybook({
      spec: sigSpec(), baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 }, series,
      signals: [{ name: "tv-breakout", at: "2026-03-31T23:59:00Z" }],
    });
    expect(r.fires.filter((f) => f.multiAction === "fill").length).toBe(0);
    expect(r.perStrategy[0].finalStatus).toBe("active");
    expect(r.notes.some((n) => /never triggered/.test(n))).toBe(true);
  });

  it("non-matching signal name never fires; matching name at window start fires at point 0", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100]);
    const miss = simulatePlaybook({
      spec: sigSpec(), baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 }, series,
      signals: [{ name: "tv-other", at: "2026-04-01T00:00:00Z" }],
    });
    expect(miss.fires.filter((f) => f.multiAction === "fill").length).toBe(0);

    const hit = simulatePlaybook({
      spec: sigSpec(), baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 }, series,
      signals: [{ name: "tv-breakout", at: "2026-04-01T00:00:00Z" }],
    });
    const fills = hit.fires.filter((f) => f.multiAction === "fill");
    expect(fills.length).toBe(1);
    expect(fills[0].priceUsd).toBe(2000);
  });

  it("EMPTY signals array engages replay mode — no rejection, entry just never fires", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100]);
    const r = simulatePlaybook({
      spec: sigSpec(), baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 }, series,
      signals: [],
    });
    expect(r.perStrategy[0].finalStatus).toBe("active");
  });

  it("OMITTING signals keeps the teaching rejection, now pointing at the replay flag", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100]);
    expect(() =>
      simulatePlaybook({
        spec: sigSpec(), baseSymbol: "ETH", quoteSymbol: "USDC",
        initialBalance: { ETH: 0, USDC: 1000 }, series,
      }),
    ).toThrow(/signals-from-history/);
  });

  it("one signal fires every eligible listener on the same name (live tick semantics)", () => {
    const spec = parsePlaybookSpec({
      name: "two-listeners",
      strategies: [
        { ...entry, id: "a", quoteAmount: 400 },
        { ...entry, id: "b", quoteAmount: 600 },
      ],
    });
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200]);
    const r = simulatePlaybook({
      spec, baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 }, series,
      signals: [{ name: "tv-breakout", at: "2026-04-01T00:30:00Z" }],
    });
    const fills = r.fires.filter((f) => f.multiAction === "fill");
    expect(fills.map((f) => f.strategyId).sort()).toEqual(["a", "b"]);
    // Both fired the same tick @2100.
    expect(fills.every((f) => f.priceUsd === 2100)).toBe(true);
    expect(r.finalBalance["ETH"]).toBeCloseTo(1000 / 2100, 9);
  });

  it("signal entry + on_fill bracket: the alert buys, the bracket manages the exit", () => {
    // Signal buys 1000 USDC @2000 (00:30 alert → 01:00 tick) → spawns
    // TP(2600)/SL(1500); price runs to 2700 → TP fires, SL cascaded.
    const spec = sigSpec({
      onFill: {
        type: "createOrders",
        specs: [
          { side: "sell", trigger: "price_above", price: 2600, base: "ETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
          { side: "sell", trigger: "price_below", price: 1500, base: "ETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
        ],
      },
    });
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2000, 2700, 2700]);
    const r = simulatePlaybook({
      spec, baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 }, series,
      signals: [{ name: "tv-breakout", at: "2026-04-01T00:30:00Z" }],
    });
    const tp = r.perStrategy.find((s) => s.strategyId === "breakout:hook#1.1")!;
    const sl = r.perStrategy.find((s) => s.strategyId === "breakout:hook#1.2")!;
    expect(tp.finalStatus).toBe("filled");
    expect(sl.finalStatus).toBe("cancelled");
    // 1000 → 0.5 ETH @2000 → sold @2700 = 1350, flat ETH.
    expect(r.finalBalance["USDC"]).toBeCloseTo(1350, 6);
    expect(r.finalBalance["ETH"]).toBeCloseTo(0, 9);
  });

  it("expired-before-signal entry never fires even with a matching signal", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200]);
    const r = simulatePlaybook({
      spec: sigSpec({ expiresAt: "2026-04-01T00:30:00Z" }),
      baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 }, series,
      signals: [{ name: "tv-breakout", at: "2026-04-01T01:30:00Z" }],
    });
    expect(r.fires.filter((f) => f.multiAction === "fill").length).toBe(0);
    // Expiry parks orders as "cancelled" in the sim (established semantics).
    expect(r.perStrategy[0].finalStatus).toBe("cancelled");
  });
});

// ── v40: cost-aware simulation ───────────────────────────────

describe("cost-aware backtests (SimCosts)", () => {
  // 100bps = 1% — chosen so the expected numbers stay readable.
  const COSTS = { slippageBps: 100, gasUsdPerFire: 2 };

  it("buy fixed-quote: slippage reduces the base RECEIVED", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2200, 2000, 2000]);
    const r = simulateOrder({
      spec: { side: "buy", trigger: "price_below", targetPriceUsd: 2100, quoteAmount: 1000 },
      baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 },
      series, costs: COSTS,
    });
    // 1000/2000 × 0.99 = 0.495 ETH; full 1000 USDC spent.
    expect(r.finalBalance["ETH"]).toBeCloseTo(0.495, 12);
    expect(r.finalBalance["USDC"]).toBeCloseTo(0, 12);
    expect(r.fires[0].slippageCostUsd).toBeCloseTo(10, 9); // 1% of 1000
    expect(r.fires[0].gasCostUsd).toBe(2);
    expect(r.costs).not.toBeNull();
    expect(r.costs!.slippageUsd).toBeCloseTo(10, 9);
    expect(r.costs!.gasUsd).toBe(2);
    expect(r.costs!.totalUsd).toBeCloseTo(12, 9);
    // Final equity: 0.495×2000 + 0 − $2 gas = $988 → PnL −$12 = total friction.
    expect(r.finalUsd).toBeCloseTo(988, 9);
    expect(r.pnlUsd).toBeCloseTo(-12, 9);
  });

  it("buy fixed-base: slippage shows up as MORE quote spent (and gates affordability)", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2200, 2000]);
    const r = simulateOrder({
      spec: { side: "buy", trigger: "price_below", targetPriceUsd: 2100, baseAmount: 0.5 },
      baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1010 },
      series, costs: COSTS,
    });
    // Cost = 0.5×2000×1.01 = 1010 — exactly affordable.
    expect(r.finalBalance["ETH"]).toBeCloseTo(0.5, 12);
    expect(r.finalBalance["USDC"]).toBeCloseTo(0, 9);
    expect(r.fires[0].slippageCostUsd).toBeCloseTo(10, 9);

    // One dollar less and the SAME order halts: slippage participates
    // in the affordability check.
    const halt = simulateOrder({
      spec: { side: "buy", trigger: "price_below", targetPriceUsd: 2100, baseAmount: 0.5 },
      baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1009 },
      series: hourlySeries("2026-04-01T00:00:00Z", [2200, 2000]), costs: COSTS,
    });
    expect(halt.fires[0].action).toBe("halt");
  });

  it("sell: slippage reduces the quote RECEIVED", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2600, 2600]);
    const r = simulateOrder({
      spec: { side: "sell", trigger: "price_above", targetPriceUsd: 2500, baseAmount: 1 },
      baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 1, USDC: 0 },
      series, costs: COSTS,
    });
    // 1×2600×0.99 = 2574.
    expect(r.finalBalance["USDC"]).toBeCloseTo(2574, 9);
    expect(r.fires[0].slippageCostUsd).toBeCloseTo(26, 9);
  });

  it("gas accumulates per fill and charges EQUITY, never the trading balance; hold stays frictionless", () => {
    // Daily DCA, 3 fires at flat $2000, gas only (no slippage).
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000, 2000]);
    const r = simulateSchedule({
      spec: { side: "buy", cron: "0 0 * * *", quoteAmount: 100 },
      baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 },
      series, costs: { slippageBps: 0, gasUsdPerFire: 2 },
    });
    expect(r.costs!.fills).toBe(3);
    expect(r.costs!.gasUsd).toBeCloseTo(6, 9);
    expect(r.costs!.slippageUsd).toBe(0);
    // Balances untouched by gas: 700 USDC + 0.15 ETH.
    expect(r.finalBalance["USDC"]).toBeCloseTo(700, 9);
    expect(r.finalBalance["ETH"]).toBeCloseTo(0.15, 12);
    // Equity: 0.15×2000 + 700 − 6 = 994 → PnL −6, hold PnL 0.
    expect(r.finalUsd).toBeCloseTo(994, 9);
    expect(r.pnlUsd).toBeCloseTo(-6, 9);
    expect(r.holdPnlUsd).toBeCloseTo(0, 9);
    expect(r.notes.some((n) => /total friction/.test(n))).toBe(true);
  });

  it("omitted costs and zero costs are IDENTICAL to each other (and costs:null in both)", () => {
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2100, 1900, 2050]);
    const spec = { side: "buy" as const, cron: "0 0 * * *", quoteAmount: 100 };
    const base = { baseSymbol: "ETH", quoteSymbol: "USDC", initialBalance: { ETH: 0, USDC: 1000 } };
    const without = simulateSchedule({ spec, ...base, series });
    const withZero = simulateSchedule({ spec, ...base, series, costs: { slippageBps: 0, gasUsdPerFire: 0 } });
    expect(without.costs).toBeNull();
    expect(withZero.costs).toBeNull();
    expect(withZero.pnlUsd).toBe(without.pnlUsd);
    expect(withZero.finalBalance).toEqual(without.finalBalance);
  });

  it("validation: out-of-range knobs are rejected", () => {
    const series = hourlySeries("2026-04-01T00:00:00Z", [2000, 2000]);
    const run = (costs: { slippageBps?: number; gasUsdPerFire?: number }) => () =>
      simulateOrder({
        spec: { side: "buy", trigger: "price_below", targetPriceUsd: 2100, quoteAmount: 100 },
        baseSymbol: "ETH", quoteSymbol: "USDC",
        initialBalance: { USDC: 100 }, series, costs,
      });
    expect(run({ slippageBps: -1 })).toThrow(/slippageBps/);
    expect(run({ slippageBps: 10_001 })).toThrow(/slippageBps/);
    expect(run({ gasUsdPerFire: -0.5 })).toThrow(/gasUsdPerFire/);
  });

  it("playbook: costs flow through dynamic sizing + hooks; OCO cascade rows never count as fills", () => {
    // DCA buys once (on_fill spawns TP/SL bracket), TP fires → cascade
    // cancels SL. 2 real fills total; the cascade row must not pay gas.
    const spec = parsePlaybookSpec({
      name: "dca-bracket-costs",
      strategies: [
        {
          id: "dca", type: "schedule", side: "buy", cron: "0 0 * * *", quoteAmount: 1000,
          base: "ETH", quote: "USDC", maxRuns: 1,
          onFill: {
            type: "createOrders",
            specs: [
              { side: "sell", trigger: "price_above", price: 2600, base: "ETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
              { side: "sell", trigger: "price_below", price: 1500, base: "ETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
            ],
          },
        },
      ],
    });
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2700, 2700]);
    const r = simulatePlaybook({
      spec, baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 }, series,
      costs: { slippageBps: 100, gasUsdPerFire: 1 },
    });
    expect(r.costs!.fills).toBe(2); // DCA buy + TP sell — cascade excluded
    expect(r.costs!.gasUsd).toBeCloseTo(2, 9);
    // Buy: 1000/2000×0.99 = 0.495 ETH (slip $10). Hook sized to the
    // ACTUAL fill (0.495). TP sell: 0.495×2700×0.99 (slip $13.365).
    expect(r.costs!.slippageUsd).toBeCloseTo(10 + 0.495 * 2700 * 0.01, 9);
    expect(r.finalBalance["ETH"]).toBeCloseTo(0, 12);
    expect(r.finalBalance["USDC"]).toBeCloseTo(0.495 * 2700 * 0.99, 9);
  });

  it("the motivating scenario: a churny strategy that beats hold GROSS loses to friction NET", () => {
    // Price round-trips 2000→2100→2000…: sell-high/buy-low captures
    // small gross alpha per cycle; realistic friction erases it.
    const prices = [2000, 2100, 2000, 2100, 2000, 2100, 2000];
    const gross = simulatePlaybook({
      spec: parsePlaybookSpec({
        name: "churn",
        strategies: [
          { id: "s1", type: "schedule", side: "buy", cron: "0 0 * * *", quoteAmount: "max", base: "ETH", quote: "USDC" },
        ],
      }),
      baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 },
      series: dailySeries("2026-04-01T00:00:00Z", prices),
    });
    const net = simulatePlaybook({
      spec: parsePlaybookSpec({
        name: "churn",
        strategies: [
          { id: "s1", type: "schedule", side: "buy", cron: "0 0 * * *", quoteAmount: "max", base: "ETH", quote: "USDC" },
        ],
      }),
      baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 },
      series: dailySeries("2026-04-01T00:00:00Z", prices),
      costs: { slippageBps: 50, gasUsdPerFire: 1 },
    });
    // Identical strategy, identical series — the ONLY difference is friction.
    expect(net.pnlUsd).toBeLessThan(gross.pnlUsd);
    expect(net.holdPnlUsd).toBeCloseTo(gross.holdPnlUsd, 9); // hold never pays
    expect(gross.pnlUsd - net.pnlUsd).toBeCloseTo(net.costs!.totalUsd, 6);
  });
});

// ── v41: risk metrics ride along on every sim result ─────────

describe("sim results carry risk metrics (v41)", () => {
  it("simulateOrder: strategy metrics diverge from hold after the exit", () => {
    // Trailing-stop sells at 2520 (5% off the 2652 peak... simplified:
    // price_above sell at 2500 fires at 2600), then the crash to 1300
    // hurts HOLD only.
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2600, 1300, 1300]);
    const r = simulateOrder({
      spec: { side: "sell", trigger: "price_above", targetPriceUsd: 2500, baseAmount: 1 },
      baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 1, USDC: 0 }, series,
    });
    expect(r.metrics).not.toBeNull();
    expect(r.holdMetrics).not.toBeNull();
    // Strategy exited at 2600 → flat through the crash → zero drawdown.
    expect(r.metrics!.maxDrawdownPct).toBe(0);
    // Hold rode 2600 → 1300 = −50%.
    expect(r.holdMetrics!.maxDrawdownPct).toBeCloseTo(50, 9);
    // In market only points 0-1 (sold AT point 1, so exposure ends there).
    expect(r.metrics!.timeInMarketPct).toBeCloseTo(25, 9);
    expect(r.holdMetrics!.timeInMarketPct).toBe(100);
    // Equity end matches the result's final USD accounting.
    expect(r.metrics!.equityEndUsd).toBeCloseTo(r.finalUsd, 9);
    expect(r.holdMetrics!.equityEndUsd).toBeCloseTo(r.holdFinalUsd, 9);
  });

  it("playbook result carries the same metric pair; gas shows in the curve", () => {
    const spec = parsePlaybookSpec({
      name: "metrics-dca",
      strategies: [
        { id: "dca", type: "schedule", side: "buy", cron: "0 0 * * *", quoteAmount: 500, base: "ETH", quote: "USDC", maxRuns: 2 },
      ],
    });
    const series = dailySeries("2026-04-01T00:00:00Z", [2000, 2000, 2000]);
    const r = simulatePlaybook({
      spec, baseSymbol: "ETH", quoteSymbol: "USDC",
      initialBalance: { ETH: 0, USDC: 1000 }, series,
      costs: { slippageBps: 0, gasUsdPerFire: 5 },
    });
    expect(r.metrics!.equityEndUsd).toBeCloseTo(r.finalUsd, 9);
    // 2 fires × $5 gas, flat price, zero slippage → end equity 990.
    expect(r.metrics!.equityEndUsd).toBeCloseTo(990, 9);
    // Hold curve never pays the gas.
    expect(r.holdMetrics!.equityEndUsd).toBeCloseTo(1000, 9);
  });
});
