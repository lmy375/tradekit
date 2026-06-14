/**
 * Trade-sizing tests (v70). The max-admissible-spend solve: each USD
 * constraint's ceiling pinned one at a time, the min-selection (binding
 * constraint), the strategy-budget inverse, the buy-only position-cap fold,
 * the wallet ceiling, token-amount conversion, and the honest caveats
 * (unbounded, exhausted, missing strategy/token/price). Pure: configs from
 * configSchema.parse({}) + every DB read replaced by an injection seam.
 */

import { describe, it, expect } from "vitest";
import { configSchema, type Config } from "./config.js";
import {
  gatherTradeSizing,
  selectBindingConstraint,
  budgetConstraints,
  type SizingConstraint,
} from "./tradeSizing.js";
import type { FillRowLite } from "./positionCaps.js";
import type { BudgetRule } from "./strategyBudget.js";

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

const size = (safety: Partial<Config["safety"]>, over: Record<string, unknown> = {}) =>
  gatherTradeSizing({ direction: "buy", config: cfg(safety), now: NOW, ...seams, ...over });

// ── pure helpers ───────────────────────────────────────────

describe("selectBindingConstraint", () => {
  const c = (kind: string, capUsd: number): SizingConstraint => ({
    kind: kind as SizingConstraint["kind"], label: kind, capUsd, scope: "", detail: "",
  });

  it("empty → unbounded (null)", () => {
    const r = selectBindingConstraint([]);
    expect(r.maxTradeUsd).toBeNull();
    expect(r.binding).toBeNull();
  });

  it("picks the smallest cap as the binding constraint", () => {
    const r = selectBindingConstraint([c("per_tx", 500), c("daily", 120), c("wallet_balance", 900)]);
    expect(r.maxTradeUsd).toBe(120);
    expect(r.binding!.kind).toBe("daily");
    expect(r.sorted.map((x) => x.capUsd)).toEqual([120, 500, 900]);
  });
});

describe("budgetConstraints (inverse of evaluateRule)", () => {
  it("per-fire is a static ceiling; lifetime/daily are remaining (floored)", () => {
    const rule: BudgetRule = { tag: "dca", perFireUsd: 50, lifetimeUsd: 1000, dailyUsd: 200 };
    const cs = budgetConstraints(rule, /*lifetime spent*/ 950, /*daily spent*/ 220);
    expect(cs.find((x) => x.kind === "strategy_per_fire")!.capUsd).toBe(50);
    expect(cs.find((x) => x.kind === "strategy_lifetime")!.capUsd).toBe(50); // 1000 − 950
    expect(cs.find((x) => x.kind === "strategy_daily")!.capUsd).toBe(0); // 200 − 220 floored
  });
});

// ── gatherTradeSizing ──────────────────────────────────────

describe("gatherTradeSizing — single binding limits", () => {
  it("per-tx cap alone sets the ceiling", () => {
    const r = size({ perTxUsdLimit: 250 });
    expect(r.maxTradeUsd).toBe(250);
    expect(r.binding!.kind).toBe("per_tx");
  });

  it("daily remaining binds when tighter than per-tx", () => {
    const r = size({ perTxUsdLimit: 500, dailyUsdLimit: 1000 }, { dailyVolumeFn: () => 900 });
    expect(r.maxTradeUsd).toBe(100); // 1000 − 900 < 500
    expect(r.binding!.kind).toBe("daily");
  });

  it("no USD-denominated limit configured → unbounded by policy (null)", () => {
    const r = size({});
    expect(r.maxTradeUsd).toBeNull();
    expect(r.binding).toBeNull();
    expect(r.constraints).toHaveLength(0);
  });
});

describe("gatherTradeSizing — strategy budgets", () => {
  it("folds the matching budget's tightest window into the ceiling", () => {
    const r = size(
      { perTxUsdLimit: 1000, strategyBudgets: [{ tag: "dca-eth", dailyUsd: 300 }] as BudgetRule[] },
      { strategy: "dca-eth", spentLookup: () => 250 },
    );
    expect(r.maxTradeUsd).toBe(50); // 300 − 250 daily remaining
    expect(r.binding!.kind).toBe("strategy_daily");
  });

  it("a non-matching strategy tag pulls in no budget constraint", () => {
    const r = size(
      { perTxUsdLimit: 1000, strategyBudgets: [{ tag: "dca-eth", dailyUsd: 300 }] as BudgetRule[] },
      { strategy: "other", spentLookup: () => 250 },
    );
    expect(r.maxTradeUsd).toBe(1000); // only per-tx applies
    expect(r.constraints.some((c) => c.kind.startsWith("strategy"))).toBe(false);
  });

  it("budgets configured but no strategy tag → caveat, budget not folded", () => {
    const r = size({ perTxUsdLimit: 1000, strategyBudgets: [{ tag: "dca", dailyUsd: 10 }] as BudgetRule[] });
    expect(r.maxTradeUsd).toBe(1000);
    expect(r.caveats.some((c) => /no .?strategy.? tag/i.test(c))).toBe(true);
  });
});

describe("gatherTradeSizing — net-exposure position caps (buy only)", () => {
  const fills = (): FillRowLite[] => [
    { timestamp: "2026-06-01T00:00:00Z", direction: "buy", base_token: "0xweth", base_symbol: "WETH", base_amount: "1", quote_amount: "2000" },
  ];

  it("cost-quote cap remaining binds on a buy", () => {
    const r = gatherTradeSizing({
      direction: "buy", config: cfg({ positionCaps: [{ pattern: "dca", token: "WETH", maxCostQuote: 2500 }] }),
      now: NOW, strategy: "dca", token: "WETH", ...seams, fillRowsLookup: fills,
    });
    expect(r.maxTradeUsd).toBe(500); // 2500 − 2000 held
    expect(r.binding!.kind).toBe("position_cap_cost");
  });

  it("sells skip position caps entirely (sells reduce exposure)", () => {
    const r = gatherTradeSizing({
      direction: "sell", config: cfg({ perTxUsdLimit: 9999, positionCaps: [{ pattern: "dca", token: "WETH", maxCostQuote: 2500 }] }),
      now: NOW, strategy: "dca", token: "WETH", ...seams, fillRowsLookup: fills,
    });
    expect(r.constraints.some((c) => c.kind === "position_cap_cost")).toBe(false);
    expect(r.maxTradeUsd).toBe(9999);
  });

  it("a base-amount cap with no price → caveat, not folded into the USD ceiling", () => {
    const r = gatherTradeSizing({
      direction: "buy", config: cfg({ perTxUsdLimit: 1000, positionCaps: [{ pattern: "dca", token: "WETH", maxBaseAmount: 5 }] }),
      now: NOW, strategy: "dca", token: "WETH", ...seams, fillRowsLookup: fills,
    });
    expect(r.maxTradeUsd).toBe(1000); // per-tx only; base cap not converted
    expect(r.caveats.some((c) => /base-amount/i.test(c))).toBe(true);
  });

  it("a base-amount cap WITH a price is converted to USD and folded in", () => {
    const r = gatherTradeSizing({
      direction: "buy", config: cfg({ perTxUsdLimit: 100000, positionCaps: [{ pattern: "dca", token: "WETH", maxBaseAmount: 5 }] }),
      now: NOW, strategy: "dca", token: "WETH", priceUsd: 2000, ...seams, fillRowsLookup: fills,
    });
    // 5 − 1 held = 4 base units × $2000 = $8000
    expect(r.maxTradeUsd).toBe(8000);
    expect(r.binding!.kind).toBe("position_cap_cost");
  });
});

describe("gatherTradeSizing — wallet, conversion, caveats", () => {
  it("wallet balance binds when it's the tightest", () => {
    const r = size({ perTxUsdLimit: 500 }, { walletUsd: 73.5 });
    expect(r.maxTradeUsd).toBe(73.5);
    expect(r.binding!.kind).toBe("wallet_balance");
  });

  it("converts maxTradeUsd to a base amount when a price is given", () => {
    const r = size({ perTxUsdLimit: 600 }, { priceUsd: 3000 });
    expect(r.maxBaseAmount).toBeCloseTo(0.2, 9); // 600 / 3000
  });

  it("always recommends running the chosen size through preflight", () => {
    const r = size({ perTxUsdLimit: 100 });
    expect(r.caveats.some((c) => /preflight_trade/.test(c))).toBe(true);
  });

  it("a fully-consumed limit yields maxTradeUsd 0 + an explicit caveat", () => {
    const r = size({ dailyUsdLimit: 500 }, { dailyVolumeFn: () => 500 });
    expect(r.maxTradeUsd).toBe(0);
    expect(r.caveats.some((c) => /\$0/.test(c))).toBe(true);
  });
});
