/**
 * Pre-trade limit-projection tests (v54). The whole value of this module
 * is ZERO DIVERGENCE from execution — so the tests drive the REAL
 * enforcers against a seeded DB and assert that the projection's
 * pass/fail + structured codes match what a real buy/sell would hit:
 * AMOUNT_EXCEEDS_LIMIT (per-tx/daily), STRATEGY_BUDGET_EXCEEDED,
 * POSITION_CAP_EXCEEDED, SAFEGUARD_TRIGGERED (rate limit),
 * GAS_BUDGET_EXCEEDED.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-admissibility-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { projectTradeLimits } = await import("./tradeAdmissibility.js");
const { configSchema } = await import("./config.js");
const { openDb, closeDb, insertTrade } = await import("./db.js");

type Cfg = import("./config.js").Config;
const base = configSchema.parse({});
const WETH = "0x4200000000000000000000000000000000000006" as `0x${string}`;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as `0x${string}`;
const ROUTER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const NOW = new Date("2026-06-14T12:00:00Z");

const noopLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => noopLogger, recordAudit: () => {}, close: () => {},
} as unknown as import("./logger.js").Logger;

beforeAll(() => { openDb(); });
afterAll(() => { closeDb(); rmSync(tmpDataDir, { recursive: true, force: true }); });
beforeEach(() => { openDb().exec("DELETE FROM trades"); });

function cfg(overrides: Partial<Cfg["safety"]> = {}): Cfg {
  return { ...base, safety: { ...base.safety, ...overrides } } as Cfg;
}

function seedTrade(opts: { strategy?: string; quoteUsd?: number; baseAmount?: string; direction?: "buy" | "sell" }) {
  insertTrade({
    timestamp: new Date(NOW.getTime() - 3_600_000).toISOString(),
    chain: "base", account: "default", direction: opts.direction ?? "buy",
    base_token: WETH, base_symbol: "WETH", base_amount: opts.baseAmount ?? "0.1",
    quote_token: USDC, quote_symbol: "USDC", quote_amount: String(opts.quoteUsd ?? 100),
    price: "2000", tx_hash: `0x${Math.random().toString(16).slice(2)}`, status: "success",
    gas_used: null, gas_price_wei: null, gas_cost_native: "0.001",
    aggregator: "kyberswap", fee_tier: null, notes: null,
    strategy: opts.strategy ?? null, realized_slippage_bps: 20,
  });
}

const project = (config: Cfg, over: Record<string, unknown> = {}) =>
  projectTradeLimits({
    config, logger: noopLogger,
    chain: "base", account: "default",
    tokenIn: USDC, tokenOut: WETH, toContract: ROUTER,
    baseToken: WETH, baseSymbol: "WETH",
    estimatedUsd: 100, slippageBps: 100, direction: "buy",
    lastTradeAtFn: () => new Map(),
    now: NOW,
    ...over,
  });

function check(r: ReturnType<typeof project>, name: string) {
  return r.checks.find((c) => c.name === name);
}

describe("core safety (per-tx + daily USD)", () => {
  it("admissible when no dollar limits configured", () => {
    const r = project(cfg());
    expect(r.admissible).toBe(true);
    expect(check(r, "core_safety")!.passes).toBe(true);
  });

  it("per-tx limit: a trade over the cap projects AMOUNT_EXCEEDS_LIMIT", () => {
    const r = project(cfg({ perTxUsdLimit: 50 }), { estimatedUsd: 200 });
    expect(r.admissible).toBe(false);
    expect(check(r, "core_safety")!.code).toBe("AMOUNT_EXCEEDS_LIMIT");
    expect(r.blocking.map((b) => b.name)).toContain("core_safety");
  });

  it("daily limit: prior volume + this trade over the cap → AMOUNT_EXCEEDS_LIMIT", () => {
    seedTrade({ quoteUsd: 900 });
    const r = project(cfg({ dailyUsdLimit: 1000 }), { estimatedUsd: 200 });
    expect(r.admissible).toBe(false);
    expect(check(r, "core_safety")!.code).toBe("AMOUNT_EXCEEDS_LIMIT");
  });
});

describe("rate limit", () => {
  it("a too-recent last trade projects SAFEGUARD_TRIGGERED", () => {
    const recent = new Date(NOW.getTime() - 5_000).toISOString();
    const r = project(cfg({ minTradeIntervalMs: 60_000 }), {
      lastTradeAtFn: () => new Map([["default", recent]]),
    });
    expect(check(r, "rate_limit")!.passes).toBe(false);
    expect(check(r, "rate_limit")!.code).toBe("SAFEGUARD_TRIGGERED");
    expect(r.admissible).toBe(false);
  });

  it("ready when enough time elapsed", () => {
    const old = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const r = project(cfg({ minTradeIntervalMs: 60_000 }), {
      lastTradeAtFn: () => new Map([["default", old]]),
    });
    expect(check(r, "rate_limit")!.passes).toBe(true);
  });
});

describe("strategy budget", () => {
  it("projects STRATEGY_BUDGET_EXCEEDED for a tagged trade over its lifetime cap", () => {
    seedTrade({ strategy: "dca", quoteUsd: 600 });
    const r = project(cfg({ strategyBudgets: [{ tag: "dca", lifetimeUsd: 1000 }] }), {
      strategy: "dca", estimatedUsd: 500,
    });
    expect(check(r, "strategy_budget")!.code).toBe("STRATEGY_BUDGET_EXCEEDED");
    expect(r.admissible).toBe(false);
  });

  it("untagged trades skip the budget check entirely", () => {
    const r = project(cfg({ strategyBudgets: [{ tag: "dca", lifetimeUsd: 10 }] }), { strategy: null });
    expect(check(r, "strategy_budget")).toBeUndefined();
  });
});

describe("position cap", () => {
  it("projects POSITION_CAP_EXCEEDED when net + this buy exceeds the cap", () => {
    seedTrade({ strategy: "dca", baseAmount: "0.8", direction: "buy" });
    const r = project(cfg({ positionCaps: [{ pattern: "dca", token: "WETH", maxBaseAmount: 1 }] }), {
      strategy: "dca", addBaseAmount: 0.3, addCostQuote: 600,
    });
    expect(check(r, "position_cap")!.code).toBe("POSITION_CAP_EXCEEDED");
    expect(r.admissible).toBe(false);
  });

  it("a sell never triggers a position-cap projection", () => {
    const r = project(cfg({ positionCaps: [{ pattern: "dca", token: "WETH", maxBaseAmount: 1 }] }), {
      strategy: "dca", direction: "sell", addBaseAmount: null, addCostQuote: null,
    });
    expect(check(r, "position_cap")).toBeUndefined();
  });
});

describe("gas budget", () => {
  it("projects GAS_BUDGET_EXCEEDED when gas % exceeds the cap", () => {
    const r = project(cfg({ gas: { maxGasPctOfTrade: 5 } }), {
      gas: { chain: "base", estimatedGasNative: 0.01, estimatedGasUsd: 20, estimatedTradeUsd: 100 }, // 20%
    });
    expect(check(r, "gas_budget")!.code).toBe("GAS_BUDGET_EXCEEDED");
    expect(r.admissible).toBe(false);
  });
});

describe("composite admissibility", () => {
  it("all checks pass → admissible with empty blocking", () => {
    const r = project(cfg({ perTxUsdLimit: 1000, dailyUsdLimit: 5000, minTradeIntervalMs: 1000 }), {
      lastTradeAtFn: () => new Map(),
    });
    expect(r.admissible).toBe(true);
    expect(r.blocking).toEqual([]);
  });

  it("multiple limits fail → all surface in blocking", () => {
    seedTrade({ strategy: "dca", quoteUsd: 600 });
    const r = project(
      cfg({ perTxUsdLimit: 50, strategyBudgets: [{ tag: "dca", lifetimeUsd: 1000 }] }),
      { strategy: "dca", estimatedUsd: 500 },
    );
    const names = r.blocking.map((b) => b.name).sort();
    expect(names).toContain("core_safety");
    expect(names).toContain("strategy_budget");
    expect(r.admissible).toBe(false);
  });
});
