/**
 * Safety-headroom tests (v53). Each active limit's used/remaining/
 * utilization + status (ok/approaching/exhausted/tripped) pinned one at
 * a time, plus the binding-constraint selection. Fully pure: configs
 * from configSchema.parse({}) + every DB read replaced by an injection
 * seam, so no SQLite and no clock except the injected `now`.
 */

import { describe, it, expect } from "vitest";
import { configSchema, type Config } from "./config.js";
import {
  gatherSafetyHeadroom,
  renderSafetyHeadroom,
  APPROACHING_PCT,
} from "./safetyHeadroom.js";
import type { FillRowLite } from "./positionCaps.js";
import type { DrawdownStateRow } from "./db.js";

const NOW = new Date("2026-06-14T12:00:00Z");
const base = configSchema.parse({});

function cfg(overrides: Partial<Config["safety"]> = {}): Config {
  return { ...base, safety: { ...base.safety, ...overrides } } as Config;
}

/** Defaults for every seam — overridden per test. */
const seams = {
  dailyVolumeFn: () => 0,
  spentLookup: () => 0,
  distinctStrategiesFn: () => [] as string[],
  drawdownLookup: () => null as DrawdownStateRow | null,
  lastTradeAtFn: () => new Map<string, string>(),
  fillRowsLookup: () => [] as FillRowLite[],
};

const head = (safety: Partial<Config["safety"]>, over: Record<string, unknown> = {}) =>
  gatherSafetyHeadroom({ config: cfg(safety), now: NOW, ...seams, ...over });

function entry(r: ReturnType<typeof head>, key: string) {
  return r.entries.find((e) => e.key === key);
}

describe("daily USD cap", () => {
  it("computes used / remaining / utilization and an ok status", () => {
    const r = head({ dailyUsdLimit: 1000 }, { dailyVolumeFn: () => 250 });
    const e = entry(r, "dailyUsd")!;
    expect(e.used).toBe(250);
    expect(e.remaining).toBe(750);
    expect(e.utilizationPct).toBeCloseTo(25, 6);
    expect(e.status).toBe("ok");
  });

  it("flags approaching at ≥80% and exhausted at ≥100%", () => {
    expect(entry(head({ dailyUsdLimit: 1000 }, { dailyVolumeFn: () => 850 }), "dailyUsd")!.status).toBe("approaching");
    const ex = entry(head({ dailyUsdLimit: 1000 }, { dailyVolumeFn: () => 1100 }), "dailyUsd")!;
    expect(ex.status).toBe("exhausted");
    expect(ex.remaining).toBe(0); // floored
  });

  it("scopes to the account × chain", () => {
    const r = gatherSafetyHeadroom({ config: cfg({ dailyUsdLimit: 100 }), now: NOW, ...seams, account: "bot", chain: "Arbitrum" });
    expect(r.account).toBe("bot");
    expect(r.chain).toBe("arbitrum");
    expect(entry(r, "dailyUsd")!.scope).toMatch(/account:bot × arbitrum/);
  });
});

describe("per-tx ceiling (informational)", () => {
  it("reports the static cap with no utilization", () => {
    const e = entry(head({ perTxUsdLimit: 500 }), "perTxUsd")!;
    expect(e.limit).toBe(500);
    expect(e.utilizationPct).toBeNull();
    expect(e.status).toBe("ok");
  });
});

describe("strategy budgets (reuses computeBudgetConsumption)", () => {
  it("lifetime + 24h remaining, perFire static", () => {
    const r = head(
      { strategyBudgets: [{ tag: "dca", lifetimeUsd: 1000, dailyUsd: 100, perFireUsd: 25 }] },
      { spentLookup: (_tag: string, since?: string) => (since ? 90 : 600) },
    );
    const life = entry(r, "strategyBudget:lifetime:dca")!;
    expect(life.used).toBe(600);
    expect(life.remaining).toBe(400);
    expect(life.status).toBe("ok");
    const daily = entry(r, "strategyBudget:daily:dca")!;
    expect(daily.used).toBe(90);
    expect(daily.status).toBe("approaching"); // 90%
    const fire = entry(r, "strategyBudget:perFire:dca")!;
    expect(fire.utilizationPct).toBeNull();
  });
});

describe("drawdown distance-to-trip", () => {
  const ddCfg = { drawdownCircuitBreaker: { enabled: true, maxDrawdownPct: 20, autoResumeAtPct: null, scope: "global" as const } };

  it("computes current DD% as a fraction of the trip threshold", () => {
    // peak 1000, last 900 → 10% drawdown, threshold 20% → 50% utilization.
    const st: DrawdownStateRow = { scope_key: "global", peak_usd: 1000, peak_at: "x", tripped_at: null, last_value_usd: 900, updated_at: "x" };
    const e = entry(head(ddCfg, { drawdownLookup: () => st }), "drawdown")!;
    expect(e.used).toBeCloseTo(10, 6);
    expect(e.remaining).toBeCloseTo(10, 6); // 20 − 10 pp
    expect(e.utilizationPct).toBeCloseTo(50, 6);
    expect(e.status).toBe("ok");
  });

  it("surfaces a tripped breaker as tripped regardless of value", () => {
    const st: DrawdownStateRow = { scope_key: "global", peak_usd: 1000, peak_at: "x", tripped_at: "2026-06-13T00:00:00Z", last_value_usd: 700, updated_at: "x" };
    const e = entry(head(ddCfg, { drawdownLookup: () => st }), "drawdown")!;
    expect(e.status).toBe("tripped");
    expect(e.detail).toMatch(/TRIPPED/);
  });
});

describe("rate limit readiness", () => {
  const rlCfg = { minTradeIntervalMs: 60_000 };

  it("ready when enough time has elapsed", () => {
    const last = new Date(NOW.getTime() - 120_000).toISOString();
    const e = entry(head(rlCfg, { lastTradeAtFn: () => new Map([["default", last]]) }), "rateLimit")!;
    expect(e.status).toBe("ok");
    expect(e.remaining).toBe(0);
  });

  it("must wait when the last trade is too recent", () => {
    const last = new Date(NOW.getTime() - 20_000).toISOString(); // 20s ago, need 60s
    const e = entry(head(rlCfg, { lastTradeAtFn: () => new Map([["default", last]]) }), "rateLimit")!;
    expect(e.status).toBe("approaching");
    expect(e.remaining).toBe(40_000);
  });
});

describe("position caps (net exposure)", () => {
  const fills: FillRowLite[] = [
    { timestamp: "x", direction: "buy", base_token: "0xweth", base_symbol: "WETH", base_amount: "0.8", quote_amount: "1600" },
  ];

  it("computes net base vs the cap and flags approaching", () => {
    const r = head(
      { positionCaps: [{ pattern: "dca", token: "WETH", maxBaseAmount: 1 }] },
      { fillRowsLookup: () => fills },
    );
    const e = entry(r, "positionCap:dca:WETH")!;
    expect(e.used).toBeCloseTo(0.8, 6);
    expect(e.remaining).toBeCloseTo(0.2, 6);
    expect(e.utilizationPct).toBeCloseTo(80, 6);
    expect(e.status).toBe("approaching");
  });

  it("expands wildcard patterns to each matching tag", () => {
    const r = head(
      { positionCaps: [{ pattern: "playbook:*", token: "WETH", maxBaseAmount: 1 }] },
      { distinctStrategiesFn: () => ["playbook:1", "playbook:2", "other"], fillRowsLookup: () => fills },
    );
    expect(entry(r, "positionCap:playbook:1:WETH")).toBeDefined();
    expect(entry(r, "positionCap:playbook:2:WETH")).toBeDefined();
    expect(entry(r, "positionCap:other:WETH")).toBeUndefined();
  });
});

describe("binding constraint + rendering", () => {
  it("picks the tightest active constraint (tripped > exhausted > approaching > ok)", () => {
    const st: DrawdownStateRow = { scope_key: "global", peak_usd: 1000, peak_at: "x", tripped_at: "2026-06-13T00:00:00Z", last_value_usd: 700, updated_at: "x" };
    const r = head(
      { dailyUsdLimit: 1000, drawdownCircuitBreaker: { enabled: true, maxDrawdownPct: 20, autoResumeAtPct: null, scope: "global" } },
      { dailyVolumeFn: () => 500, drawdownLookup: () => st },
    );
    expect(r.binding!.key).toBe("drawdown"); // tripped beats the 50%-used daily cap
    expect(r.counts.tripped).toBe(1);
  });

  it("highest utilization wins among same-status entries", () => {
    const r = head(
      { dailyUsdLimit: 1000, perTxUsdLimit: 100, strategyBudgets: [{ tag: "dca", lifetimeUsd: 1000 }] },
      { dailyVolumeFn: () => 300, spentLookup: () => 700 },
    );
    // daily 30% vs strategy-lifetime 70% → strategy binds.
    expect(r.binding!.key).toBe("strategyBudget:lifetime:dca");
  });

  it("no quantitative limits → empty + null binding + helpful render", () => {
    const r = head({});
    expect(r.entries).toEqual([]);
    expect(r.binding).toBeNull();
    expect(renderSafetyHeadroom(r)).toMatch(/unbounded/);
  });

  it("renders the binding line, counts, and per-entry detail", () => {
    const text = renderSafetyHeadroom(head({ dailyUsdLimit: 1000 }, { dailyVolumeFn: () => 850 }));
    expect(text).toMatch(/Safety headroom — account:default/);
    expect(text).toMatch(/Binding constraint:/);
    expect(text).toMatch(/approaching/);
  });

  it("APPROACHING_PCT is the documented 80% boundary", () => {
    expect(APPROACHING_PCT).toBe(80);
    expect(entry(head({ dailyUsdLimit: 1000 }, { dailyVolumeFn: () => 800 }), "dailyUsd")!.status).toBe("approaching");
    expect(entry(head({ dailyUsdLimit: 1000 }, { dailyVolumeFn: () => 799 }), "dailyUsd")!.status).toBe("ok");
  });
});
