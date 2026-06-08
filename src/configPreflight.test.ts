// Tests for configPreflight.ts (iter35). Entirely pure — no DB, no
// file I/O. We construct synthetic Config + ActiveState objects and
// assert the computed ConfigImpact.

import { describe, it, expect } from "vitest";
import { computeConfigImpact, type ActiveState } from "./configPreflight.js";
import { configSchema, type Config } from "./config.js";

const baseCfg: Config = configSchema.parse({
  safety: {
    enabled: true,
    maxSlippageBps: 500,
    allowInfiniteApprovals: false,
  },
});

function withSafety(over: Partial<Config["safety"]>): Config {
  return configSchema.parse({
    safety: {
      enabled: true,
      maxSlippageBps: 500,
      allowInfiniteApprovals: false,
      ...over,
    },
  });
}

function withEngine(over: Partial<Config["engine"]>): Config {
  return configSchema.parse({
    engine: {
      ...over,
    },
    safety: {
      enabled: true,
      maxSlippageBps: 500,
      allowInfiniteApprovals: false,
    },
  });
}

// Synthetic order row builder.
function order(over: Record<string, unknown> = {}): import("./db.js").OrderRow {
  return {
    id: 1,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    status: "active",
    side: "sell",
    trigger_type: "price_below",
    target_price_usd: 1900,
    trail_pct: null,
    water_mark_usd: null,
    chain: "base",
    account: "default",
    base_token: "0xeth",
    base_symbol: "ETH",
    quote_token: "0xusdc",
    quote_symbol: "USDC",
    base_amount: "1",
    quote_amount: null,
    slippage_bps: 300,
    auto_slippage: 0,
    expires_at: null,
    strategy: null,
    note: null,
    attempts: 0,
    last_checked_at: null,
    last_checked_price: null,
    last_error_code: null,
    last_error_message: null,
    filled_at: null,
    fill_tx_hash: null,
    fill_price: null,
    fill_base_amount: null,
    fill_quote_amount: null,
    ...over,
  } as never;
}

// ── maxSlippageBps ──────────────────────────────────────────

describe("computeConfigImpact — maxSlippageBps", () => {
  it("returns no warnings when value is unchanged", () => {
    const r = computeConfigImpact({ oldConfig: baseCfg, newConfig: baseCfg });
    expect(r.warnings).toEqual([]);
    expect(r.diff).toEqual([]);
  });

  it("classifies tightening + flags offending active orders as critical", () => {
    const oldC = baseCfg;
    const newC = withSafety({ maxSlippageBps: 200 });
    const state: ActiveState = {
      orders: [order({ id: 1, slippage_bps: 300 }), order({ id: 2, slippage_bps: 150 })],
    };
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC, state });
    expect(r.diff[0]).toMatchObject({ path: "safety.maxSlippageBps", kind: "tightened", oldValue: 500, newValue: 200 });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].severity).toBe("critical");
    expect(r.warnings[0].affected).toHaveLength(1);
    expect(r.warnings[0].affected[0].id).toBe(1);
  });

  it("tightening with no offenders surfaces as info", () => {
    const oldC = baseCfg;
    const newC = withSafety({ maxSlippageBps: 200 });
    const state: ActiveState = { orders: [order({ id: 1, slippage_bps: 150 })] };
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC, state });
    expect(r.warnings[0].severity).toBe("info");
  });

  it("loosening produces a diff but no warning", () => {
    const oldC = baseCfg;
    const newC = withSafety({ maxSlippageBps: 1000 });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.diff[0].kind).toBe("loosened");
    expect(r.warnings).toEqual([]);
  });
});

// ── perTxUsdLimit / dailyUsdLimit ───────────────────────────

describe("computeConfigImpact — USD limits", () => {
  it("adds perTxUsdLimit as a warn", () => {
    const oldC = baseCfg;
    const newC = withSafety({ perTxUsdLimit: 1000 });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.find((w) => w.rule === "per_tx_usd_tightened")?.severity).toBe("warn");
  });

  it("loosening perTxUsdLimit produces a loosened diff + no warning", () => {
    const oldC = withSafety({ perTxUsdLimit: 1000 });
    const newC = withSafety({ perTxUsdLimit: 5000 });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.diff[0].kind).toBe("loosened");
    expect(r.warnings.filter((w) => w.severity !== "info")).toEqual([]);
  });

  it("tightening dailyUsdLimit emits a warn", () => {
    const oldC = withSafety({ dailyUsdLimit: 5000 });
    const newC = withSafety({ dailyUsdLimit: 1000 });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.some((w) => w.rule === "daily_usd_tightened" && w.severity === "warn")).toBe(true);
  });
});

// ── tokenBlacklist ──────────────────────────────────────────

// Valid 40-hex addresses for the safety config (Zod validates).
const BAD = "0xbadbadbadbadbadbadbadbadbadbadbadbadbad0";
const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("computeConfigImpact — tokenBlacklist", () => {
  it("flags active orders referencing newly-blacklisted tokens as critical", () => {
    const oldC = baseCfg;
    const newC = withSafety({ tokenBlacklist: { base: [BAD] } });
    const state: ActiveState = {
      orders: [order({ id: 1, base_token: BAD, chain: "base" })],
    };
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC, state });
    const w = r.warnings.find((x) => x.rule === "token_blacklist_added");
    expect(w).toBeDefined();
    expect(w!.severity).toBe("critical");
    expect(w!.affected[0].id).toBe(1);
  });

  it("blacklist addition with no offenders is info severity", () => {
    const oldC = baseCfg;
    const newC = withSafety({ tokenBlacklist: { base: [BAD] } });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC, state: { orders: [] } });
    const w = r.warnings.find((x) => x.rule === "token_blacklist_added");
    expect(w?.severity).toBe("info");
  });

  it("removing from blacklist produces no warning", () => {
    const oldC = withSafety({ tokenBlacklist: { base: [BAD] } });
    const newC = baseCfg;
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.filter((w) => w.rule === "token_blacklist_added")).toEqual([]);
  });
});

// ── tokenWhitelist ──────────────────────────────────────────

describe("computeConfigImpact — tokenWhitelist", () => {
  it("enabling whitelist with offenders is critical", () => {
    const oldC = baseCfg;
    const newC = withSafety({ tokenWhitelist: { base: [USDC] } });
    const state: ActiveState = {
      orders: [order({ id: 1, base_token: ETH, chain: "base" })],
    };
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC, state });
    const w = r.warnings.find((x) => x.rule === "token_whitelist_tightened");
    expect(w?.severity).toBe("critical");
  });

  it("removing whitelist (going from set → unset) is info severity", () => {
    const oldC = withSafety({ tokenWhitelist: { base: [ETH] } });
    const newC = baseCfg;
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.find((x) => x.rule === "token_whitelist_tightened")?.severity).toBe("info");
  });

  it("loosening (adding token to whitelist) emits no warning", () => {
    const oldC = withSafety({ tokenWhitelist: { base: [ETH] } });
    const newC = withSafety({ tokenWhitelist: { base: [ETH, USDC] } });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.filter((w) => w.rule === "token_whitelist_tightened")).toEqual([]);
  });
});

// ── strategyBudgets ─────────────────────────────────────────

describe("computeConfigImpact — strategyBudgets", () => {
  it("adding a new budget rule emits a warn", () => {
    const oldC = baseCfg;
    const newC = withSafety({
      strategyBudgets: [{ tag: "dca-eth", lifetimeUsd: 1000 }],
    });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.find((w) => w.rule === "strategy_budget_added")?.severity).toBe("warn");
  });

  it("tightening an existing budget emits a warn", () => {
    const oldC = withSafety({
      strategyBudgets: [{ tag: "dca-eth", lifetimeUsd: 1000 }],
    });
    const newC = withSafety({
      strategyBudgets: [{ tag: "dca-eth", lifetimeUsd: 500 }],
    });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    const w = r.warnings.find((w) => w.rule === "strategy_budget_tightened");
    expect(w?.severity).toBe("warn");
    expect(w!.message).toMatch(/lifetimeUsd/);
  });

  it("removing a budget rule produces a removed-diff + no warning", () => {
    const oldC = withSafety({
      strategyBudgets: [{ tag: "dca-eth", lifetimeUsd: 1000 }],
    });
    const newC = baseCfg;
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.diff.find((d) => d.kind === "removed")).toBeDefined();
    expect(r.warnings.filter((w) => w.rule === "strategy_budget_tightened")).toEqual([]);
  });
});

// ── drawdownCircuitBreaker ──────────────────────────────────

describe("computeConfigImpact — drawdownCircuitBreaker", () => {
  it("enabling with existing drawdown past threshold is critical", () => {
    const oldC = baseCfg;
    const newC = withSafety({
      drawdownCircuitBreaker: { enabled: true, maxDrawdownPct: 10, autoResumeAtPct: null, scope: "global" },
    });
    const state: ActiveState = {
      drawdowns: [
        {
          scope_key: "global",
          peak_usd: 10000,
          peak_at: "2026-05-01T00:00:00Z",
          last_value_usd: 8500,
          tripped_at: null,
          updated_at: "2026-05-15T00:00:00Z",
        } as never,
      ],
    };
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC, state });
    const w = r.warnings.find((x) => x.rule === "drawdown_threshold_tightened");
    expect(w?.severity).toBe("critical");
    expect(w!.affected[0].id).toBe("global");
  });

  it("tightening threshold below current drawdown is critical", () => {
    const oldC = withSafety({
      drawdownCircuitBreaker: { enabled: true, maxDrawdownPct: 20, autoResumeAtPct: null, scope: "global" },
    });
    const newC = withSafety({
      drawdownCircuitBreaker: { enabled: true, maxDrawdownPct: 10, autoResumeAtPct: null, scope: "global" },
    });
    const state: ActiveState = {
      drawdowns: [
        {
          scope_key: "global",
          peak_usd: 10000,
          peak_at: "2026-05-01T00:00:00Z",
          last_value_usd: 8500,
          tripped_at: null,
          updated_at: "2026-05-15T00:00:00Z",
        } as never,
      ],
    };
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC, state });
    const w = r.warnings.find((x) => x.rule === "drawdown_threshold_tightened");
    expect(w?.severity).toBe("critical");
  });

  it("disabling drawdown breaker is info severity", () => {
    const oldC = withSafety({
      drawdownCircuitBreaker: { enabled: true, maxDrawdownPct: 15, autoResumeAtPct: null, scope: "global" },
    });
    const newC = withSafety({
      drawdownCircuitBreaker: { enabled: false, maxDrawdownPct: 15, autoResumeAtPct: null, scope: "global" },
    });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.find((x) => x.rule === "drawdown_threshold_tightened")?.severity).toBe("info");
  });
});

// ── engine workers ──────────────────────────────────────────

describe("computeConfigImpact — engine workers", () => {
  it("disabling a worker emits warn", () => {
    const oldC = baseCfg;
    const newC = withEngine({
      workers: {
        orders: { enabled: false, intervalMs: 30_000 },
        schedules: { enabled: true, intervalMs: 60_000 },
        reconcile: { enabled: true, intervalMs: 60_000 },
        rebalance: { enabled: true, intervalMs: 300_000 },
        alerts: { enabled: true, intervalMs: 300_000 },
        db_maintenance: { enabled: false, intervalMs: 3_600_000 },
      },
    });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.find((w) => w.rule === "engine_worker_disabled")?.message).toMatch(/orders/);
  });

  it("interval change emits info", () => {
    const oldC = baseCfg;
    const newC = withEngine({
      workers: {
        orders: { enabled: true, intervalMs: 60_000 },
        schedules: { enabled: true, intervalMs: 60_000 },
        reconcile: { enabled: true, intervalMs: 60_000 },
        rebalance: { enabled: true, intervalMs: 300_000 },
        alerts: { enabled: true, intervalMs: 300_000 },
        db_maintenance: { enabled: false, intervalMs: 3_600_000 },
      },
    });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.find((w) => w.rule === "engine_interval_changed")?.severity).toBe("info");
  });
});

// ── strategyAlerts ──────────────────────────────────────────

describe("computeConfigImpact — strategyAlerts", () => {
  it("disabling alerts emits warn", () => {
    const oldC = withSafety({
      strategyAlerts: { enabled: true, rules: [{ type: "staleness", thresholdSeconds: 86400 }], eventPrefix: "strategy.alert" },
    });
    const newC = withSafety({
      strategyAlerts: { enabled: false, rules: [{ type: "staleness", thresholdSeconds: 86400 }], eventPrefix: "strategy.alert" },
    });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.find((w) => w.rule === "alerts_disabled")?.severity).toBe("warn");
  });

  it("adding a rule emits info", () => {
    const oldC = withSafety({
      strategyAlerts: { enabled: true, rules: [], eventPrefix: "strategy.alert" },
    });
    const newC = withSafety({
      strategyAlerts: {
        enabled: true,
        rules: [{ type: "drawdown_threshold", alertPct: 10 }],
        eventPrefix: "strategy.alert",
      },
    });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.find((w) => w.rule === "alerts_rule_added")?.severity).toBe("info");
  });
});

// ── resilience ──────────────────────────────────────────────

describe("computeConfigImpact — resilience", () => {
  it("disabling resilience is warn severity", () => {
    const oldC = withEngine({
      resilience: { enabled: true, thresholdFailures: 3, backoffMultiplier: 2, maxBackoffMs: 600_000, tickTimingWindow: 20 },
    });
    const newC = withEngine({
      resilience: { enabled: false, thresholdFailures: 3, backoffMultiplier: 2, maxBackoffMs: 600_000, tickTimingWindow: 20 },
    });
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC });
    expect(r.warnings.find((w) => w.rule === "resilience_disabled")?.severity).toBe("warn");
  });
});

// ── summary aggregation ─────────────────────────────────────

describe("computeConfigImpact — summary", () => {
  it("aggregates severity counts + affected primitive counts", () => {
    const oldC = baseCfg;
    const newC = withSafety({
      maxSlippageBps: 100,
      perTxUsdLimit: 500,
      tokenBlacklist: { base: [BAD] },
    });
    const state: ActiveState = {
      orders: [
        order({ id: 1, slippage_bps: 200 }),
        order({ id: 2, slippage_bps: 50, base_token: BAD }),
      ],
    };
    const r = computeConfigImpact({ oldConfig: oldC, newConfig: newC, state });
    expect(r.summary.totalDiffs).toBeGreaterThanOrEqual(3);
    expect(r.summary.criticalCount).toBeGreaterThanOrEqual(2);
    expect(r.summary.affectedOrders).toBe(2);
  });

  it("empty result when nothing changed", () => {
    const r = computeConfigImpact({ oldConfig: baseCfg, newConfig: baseCfg });
    expect(r.summary).toEqual({
      totalDiffs: 0,
      criticalCount: 0,
      warnCount: 0,
      infoCount: 0,
      affectedOrders: 0,
      affectedSchedules: 0,
      affectedRebalances: 0,
    });
  });
});
