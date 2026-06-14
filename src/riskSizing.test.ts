/**
 * Risk-based sizing tests (v105). The core formula (risk ÷ stop distance), the
 * resolution of the risk budget (absolute vs %-of-portfolio) and the stop
 * distance (stop-loss vs trail %), the clamp against the v70 safety ceiling,
 * the effective-risk math, and the honest errors. Pure: config from
 * configSchema.parse({}) + injected sizing seams (no DB).
 */

import { describe, it, expect } from "vitest";
import { configSchema, type Config } from "./config.js";
import { recommendedRiskSize, gatherRiskSize } from "./riskSizing.js";
import type { FillRowLite } from "./positionCaps.js";

const NOW = new Date("2026-06-14T12:00:00Z");
const base = configSchema.parse({});
function cfg(overrides: Partial<Config["safety"]> = {}): Config {
  return { ...base, safety: { ...base.safety, ...overrides } } as Config;
}
const seams = {
  dailyVolumeFn: () => 0,
  spentLookup: () => 0,
  fillRowsLookup: () => [] as FillRowLite[],
};
const sizeRisk = (safety: Partial<Config["safety"]>, over: Record<string, unknown> = {}) =>
  gatherRiskSize({ direction: "buy", config: cfg(safety), now: NOW, ...seams, ...over });

describe("recommendedRiskSize (the core formula)", () => {
  it("risk ÷ stop distance: $50 at a 5% stop → $1000", () => {
    expect(recommendedRiskSize({ riskUsd: 50, stopDistancePct: 5 })).toBe(1000);
  });
  it("tighter stop → bigger position for the same risk", () => {
    expect(recommendedRiskSize({ riskUsd: 50, stopDistancePct: 2 })).toBe(2500);
  });
  it("non-positive risk or stop → null (nothing to size)", () => {
    expect(recommendedRiskSize({ riskUsd: 0, stopDistancePct: 5 })).toBeNull();
    expect(recommendedRiskSize({ riskUsd: 50, stopDistancePct: 0 })).toBeNull();
  });
});

describe("gatherRiskSize — budget + stop resolution", () => {
  it("absolute riskUsd + stopLossPct, no safety ceiling → recommended, bound by risk", () => {
    const r = sizeRisk({}, { riskUsd: 50, stopLossPct: 5 });
    expect(r.recommendedUsd).toBe(1000);
    expect(r.finalUsd).toBe(1000);
    expect(r.boundBy).toBe("risk_budget");
    expect(r.stopSource).toBe("stop_loss");
    expect(r.effectiveRiskUsd).toBeCloseTo(50, 6);
  });

  it("riskPct × portfolioUsd resolves the budget (1% of $10k = $100 → $2000 at 5%)", () => {
    const r = sizeRisk({}, { riskPct: 1, portfolioUsd: 10_000, stopLossPct: 5 });
    expect(r.riskUsd).toBeCloseTo(100, 6);
    expect(r.recommendedUsd).toBe(2000);
  });

  it("trailPct is accepted as the stop distance (the protect-on-entry trail)", () => {
    const r = sizeRisk({}, { riskUsd: 50, trailPct: 5 });
    expect(r.stopSource).toBe("trailing_stop");
    expect(r.recommendedUsd).toBe(1000);
  });

  it("converts finalUsd to a base amount when a price is supplied", () => {
    const r = sizeRisk({}, { riskUsd: 50, stopLossPct: 5, priceUsd: 2000 });
    expect(r.baseAmount).toBeCloseTo(0.5, 6); // $1000 / $2000
  });
});

describe("gatherRiskSize — clamp against the safety ceiling", () => {
  it("a tighter per-tx cap clamps the size and lowers effective risk below budget", () => {
    // risk $50 @ 5% → wants $1000, but per-tx cap is $500.
    const r = sizeRisk({ perTxUsdLimit: 500 }, { riskUsd: 50, stopLossPct: 5 });
    expect(r.recommendedUsd).toBe(1000);
    expect(r.ceilingUsd).toBe(500);
    expect(r.finalUsd).toBe(500);
    expect(r.boundBy).toBe("per_tx");
    // at $500 with a 5% stop you only risk $25 — less than the $50 budget.
    expect(r.effectiveRiskUsd).toBeCloseTo(25, 6);
    expect(r.caveats.some((c) => /caps the trade/.test(c))).toBe(true);
  });

  it("a generous ceiling above the recommendation does NOT clamp", () => {
    const r = sizeRisk({ perTxUsdLimit: 5000 }, { riskUsd: 50, stopLossPct: 5 });
    expect(r.finalUsd).toBe(1000);
    expect(r.boundBy).toBe("risk_budget");
  });

  it("daily-cap remaining can be the binding clamp", () => {
    // daily cap $1000, already used $800 → $200 remaining < $1000 recommended.
    const r = sizeRisk({ dailyUsdLimit: 1000 }, { riskUsd: 50, stopLossPct: 5, dailyVolumeFn: () => 800 });
    expect(r.finalUsd).toBe(200);
    expect(r.boundBy).toBe("daily");
  });
});

describe("gatherRiskSize — honest errors", () => {
  it("no risk source → throws", () => {
    expect(() => sizeRisk({}, { stopLossPct: 5 })).toThrow(/riskUsd/);
  });
  it("riskPct without portfolioUsd → throws", () => {
    expect(() => sizeRisk({}, { riskPct: 1, stopLossPct: 5 })).toThrow(/portfolioUsd/);
  });
  it("no stop distance → throws", () => {
    expect(() => sizeRisk({}, { riskUsd: 50 })).toThrow(/stopLossPct/);
  });
});
