/**
 * Strategy budget tests.
 *
 * Three layers:
 *   1. Pure tag matcher (ruleMatchesTag, rulesMatchingTag) — exact +
 *      glob wildcard
 *   2. Pure evaluator (evaluateRule, evaluateBudget) — threshold +
 *      multi-rule semantics
 *   3. Throwing enforcer (enforceStrategyBudget) — error shape, hot-
 *      path short-circuits, lookup-injection seam
 *   4. DB integration (usdSpentUnderStrategy) — real trades table,
 *      strategy + window queries against the v18 index
 *   5. Inspection view (computeBudgetConsumption) — wildcard tag
 *      enumeration + remaining USD math
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-strategybudget-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  ruleMatchesTag,
  rulesMatchingTag,
  evaluateRule,
  evaluateBudget,
  enforceStrategyBudget,
  computeBudgetConsumption,
} = await import("./strategyBudget.js");
const { ToolError } = await import("./errors.js");
const { openDb, closeDb, insertTrade, usdSpentUnderStrategy } = await import("./db.js");

beforeAll(() => {
  openDb();
});
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM trades");
});

// ── tag matching ─────────────────────────────────────────────

describe("ruleMatchesTag", () => {
  it("matches exact literal tags", () => {
    expect(ruleMatchesTag({ tag: "arb-bot" }, "arb-bot")).toBe(true);
    expect(ruleMatchesTag({ tag: "arb-bot" }, "arb-bot-v2")).toBe(false);
    expect(ruleMatchesTag({ tag: "arb-bot" }, "rb-bot")).toBe(false);
  });

  it("matches suffix wildcard", () => {
    expect(ruleMatchesTag({ tag: "playbook:*" }, "playbook:1")).toBe(true);
    expect(ruleMatchesTag({ tag: "playbook:*" }, "playbook:42")).toBe(true);
    expect(ruleMatchesTag({ tag: "playbook:*" }, "playbookx")).toBe(false);
    // Wildcard requires AT LEAST ONE char after the prefix — bare
    // "playbook:" alone shouldn't match, but "playbook:1" should.
    expect(ruleMatchesTag({ tag: "playbook:*" }, "playbook:")).toBe(false);
  });

  it("rejects null / empty tags", () => {
    expect(ruleMatchesTag({ tag: "anything" }, null)).toBe(false);
    expect(ruleMatchesTag({ tag: "anything" }, undefined)).toBe(false);
    expect(ruleMatchesTag({ tag: "anything" }, "")).toBe(false);
  });

  it("supports a bare '*' tag matching anything non-empty", () => {
    expect(ruleMatchesTag({ tag: "*" }, "anything")).toBe(true);
    expect(ruleMatchesTag({ tag: "*" }, "playbook:1")).toBe(true);
    expect(ruleMatchesTag({ tag: "*" }, "")).toBe(false);
  });
});

describe("rulesMatchingTag", () => {
  const rules = [
    { tag: "playbook:*", perFireUsd: 100 },
    { tag: "arb-bot", lifetimeUsd: 500 },
    { tag: "specific-tag", dailyUsd: 50 },
  ];
  it("returns rules whose tag pattern matches", () => {
    expect(rulesMatchingTag(rules, "playbook:1")).toEqual([rules[0]]);
    expect(rulesMatchingTag(rules, "arb-bot")).toEqual([rules[1]]);
    expect(rulesMatchingTag(rules, "specific-tag")).toEqual([rules[2]]);
  });
  it("returns empty for unmatched tags", () => {
    expect(rulesMatchingTag(rules, "something-else")).toEqual([]);
  });
  it("returns empty for null tag", () => {
    expect(rulesMatchingTag(rules, null)).toEqual([]);
  });
  it("returns multiple rules when several patterns match", () => {
    const overlapping = [
      { tag: "playbook:*", perFireUsd: 100 },
      { tag: "playbook:1", lifetimeUsd: 5000 },
      { tag: "*", dailyUsd: 1000 },
    ];
    expect(rulesMatchingTag(overlapping, "playbook:1")).toEqual(overlapping);
  });
});

// ── evaluator (pure) ─────────────────────────────────────────

describe("evaluateRule — perFire", () => {
  const rule = { tag: "x", perFireUsd: 100 };
  it("allows trades at or under cap", () => {
    expect(evaluateRule({ rule, predictedUsd: 50, spentLifetimeUsd: 0, spentDailyUsd: 0 }).allowed).toBe(true);
    expect(evaluateRule({ rule, predictedUsd: 100, spentLifetimeUsd: 0, spentDailyUsd: 0 }).allowed).toBe(true);
  });
  it("blocks trades strictly over cap", () => {
    const r = evaluateRule({ rule, predictedUsd: 101, spentLifetimeUsd: 0, spentDailyUsd: 0 });
    expect(r.allowed).toBe(false);
    expect(r.trippedWindow).toBe("perFire");
    expect(r.capUsd).toBe(100);
    expect(r.predictedUsd).toBe(101);
  });
});

describe("evaluateRule — daily", () => {
  const rule = { tag: "x", dailyUsd: 200 };
  it("allows when current + predicted is within cap", () => {
    expect(evaluateRule({ rule, predictedUsd: 50, spentLifetimeUsd: 0, spentDailyUsd: 100 }).allowed).toBe(true);
    expect(evaluateRule({ rule, predictedUsd: 100, spentLifetimeUsd: 0, spentDailyUsd: 100 }).allowed).toBe(true);
  });
  it("blocks when current + predicted strictly exceeds cap", () => {
    const r = evaluateRule({ rule, predictedUsd: 101, spentLifetimeUsd: 0, spentDailyUsd: 100 });
    expect(r.allowed).toBe(false);
    expect(r.trippedWindow).toBe("daily");
    expect(r.spentUsd).toBe(100);
    expect(r.capUsd).toBe(200);
  });
});

describe("evaluateRule — lifetime", () => {
  const rule = { tag: "x", lifetimeUsd: 1000 };
  it("allows under cap", () => {
    expect(evaluateRule({ rule, predictedUsd: 100, spentLifetimeUsd: 800, spentDailyUsd: 0 }).allowed).toBe(true);
  });
  it("blocks at or over", () => {
    expect(evaluateRule({ rule, predictedUsd: 101, spentLifetimeUsd: 900, spentDailyUsd: 0 }).allowed).toBe(false);
    const r = evaluateRule({ rule, predictedUsd: 200, spentLifetimeUsd: 900, spentDailyUsd: 0 });
    expect(r.trippedWindow).toBe("lifetime");
    expect(r.spentUsd).toBe(900);
  });
});

describe("evaluateRule — combined caps (most restrictive wins)", () => {
  it("perFire trips first when both perFire + daily would", () => {
    const r = evaluateRule({
      rule: { tag: "x", perFireUsd: 50, dailyUsd: 200 },
      predictedUsd: 100,
      spentLifetimeUsd: 0,
      spentDailyUsd: 0,
    });
    expect(r.trippedWindow).toBe("perFire");
  });
  it("daily trips before lifetime when both would", () => {
    const r = evaluateRule({
      rule: { tag: "x", dailyUsd: 200, lifetimeUsd: 5000 },
      predictedUsd: 300,
      spentLifetimeUsd: 100,
      spentDailyUsd: 100,
    });
    expect(r.trippedWindow).toBe("daily");
  });
});

describe("evaluateBudget — multi-rule", () => {
  it("blocks if any matching rule trips", () => {
    const rules = [
      { tag: "*", perFireUsd: 1000 }, // permissive
      { tag: "x", dailyUsd: 100 }, // strict
    ];
    const r = evaluateBudget({
      matchingRules: rules,
      predictedUsd: 150,
      spentLifetimeUsd: 0,
      spentDailyUsd: 0,
    });
    expect(r.allowed).toBe(false);
    expect(r.trippedRule).toBe(rules[1]);
  });
  it("returns first failure (rule order matters for error reporting)", () => {
    const rules = [
      { tag: "x", perFireUsd: 50 },
      { tag: "x", perFireUsd: 30 },
    ];
    const r = evaluateBudget({
      matchingRules: rules,
      predictedUsd: 100,
      spentLifetimeUsd: 0,
      spentDailyUsd: 0,
    });
    expect(r.trippedRule).toBe(rules[0]);
  });
  it("allowed=true when no rules match (caller filtered)", () => {
    expect(evaluateBudget({
      matchingRules: [],
      predictedUsd: 1_000_000,
      spentLifetimeUsd: 0,
      spentDailyUsd: 0,
    }).allowed).toBe(true);
  });
  it("allowed=true when all rules pass", () => {
    const rules = [
      { tag: "x", perFireUsd: 1000 },
      { tag: "x", dailyUsd: 1000 },
      { tag: "x", lifetimeUsd: 1000 },
    ];
    expect(evaluateBudget({
      matchingRules: rules,
      predictedUsd: 100,
      spentLifetimeUsd: 200,
      spentDailyUsd: 200,
    }).allowed).toBe(true);
  });
});

// ── enforcer (throwing) ──────────────────────────────────────

describe("enforceStrategyBudget — short-circuits", () => {
  it("no-op when budgets array is undefined", () => {
    expect(() =>
      enforceStrategyBudget({
        strategyTag: "anything",
        predictedUsd: 1_000_000,
        budgets: undefined,
      }),
    ).not.toThrow();
  });

  it("no-op when budgets array is empty", () => {
    expect(() =>
      enforceStrategyBudget({
        strategyTag: "anything",
        predictedUsd: 1_000_000,
        budgets: [],
      }),
    ).not.toThrow();
  });

  it("no-op when strategy tag is null / undefined / empty", () => {
    const budgets = [{ tag: "*", perFireUsd: 50 }];
    expect(() => enforceStrategyBudget({ strategyTag: null, predictedUsd: 100, budgets })).not.toThrow();
    expect(() => enforceStrategyBudget({ strategyTag: undefined, predictedUsd: 100, budgets })).not.toThrow();
    expect(() => enforceStrategyBudget({ strategyTag: "", predictedUsd: 100, budgets })).not.toThrow();
  });

  it("no-op when no rule matches the tag", () => {
    const budgets = [{ tag: "specific", perFireUsd: 1 }];
    expect(() =>
      enforceStrategyBudget({ strategyTag: "other", predictedUsd: 1_000_000, budgets }),
    ).not.toThrow();
  });

  it("no-op for non-positive / NaN predictedUsd", () => {
    const budgets = [{ tag: "*", perFireUsd: 1 }];
    expect(() => enforceStrategyBudget({ strategyTag: "x", predictedUsd: 0, budgets })).not.toThrow();
    expect(() => enforceStrategyBudget({ strategyTag: "x", predictedUsd: -5, budgets })).not.toThrow();
    expect(() => enforceStrategyBudget({ strategyTag: "x", predictedUsd: NaN, budgets })).not.toThrow();
  });
});

describe("enforceStrategyBudget — throws on trip", () => {
  it("throws STRATEGY_BUDGET_EXCEEDED with structured details", () => {
    const budgets = [{ tag: "arb", perFireUsd: 50 }];
    let err: { code?: string; details?: Record<string, unknown> } | undefined;
    try {
      enforceStrategyBudget({
        strategyTag: "arb",
        predictedUsd: 100,
        budgets,
        spentLookup: () => 0,
      });
    } catch (e) {
      err = e as { code?: string; details?: Record<string, unknown> };
    }
    expect(err?.code).toBe("STRATEGY_BUDGET_EXCEEDED");
    expect(err?.details?.tag).toBe("arb");
    expect(err?.details?.window).toBe("perFire");
    expect(err?.details?.capUsd).toBe(50);
    expect(err?.details?.predictedUsd).toBe(100);
  });

  it("calls lookup ONLY for the windows it actually needs", () => {
    const calls: Array<{ tag: string; sinceIso?: string }> = [];
    const stub = (tag: string, sinceIso?: string) => {
      calls.push({ tag, sinceIso });
      return 0;
    };
    // perFire-only rule: lookup should NOT be called.
    enforceStrategyBudget({
      strategyTag: "x",
      predictedUsd: 10,
      budgets: [{ tag: "*", perFireUsd: 100 }],
      spentLookup: stub,
    });
    expect(calls.length).toBe(0);
  });

  it("calls lookup once each for lifetime + daily when both are configured", () => {
    const calls: Array<{ tag: string; hasSince: boolean }> = [];
    const stub = (tag: string, sinceIso?: string) => {
      calls.push({ tag, hasSince: sinceIso != null });
      return 0;
    };
    enforceStrategyBudget({
      strategyTag: "x",
      predictedUsd: 10,
      budgets: [{ tag: "*", lifetimeUsd: 1000, dailyUsd: 100 }],
      spentLookup: stub,
    });
    expect(calls.length).toBe(2);
    // One without sinceIso (lifetime), one with (daily window).
    expect(calls.filter((c) => !c.hasSince).length).toBe(1);
    expect(calls.filter((c) => c.hasSince).length).toBe(1);
  });

  it("error message names the strategy tag + window + cap", () => {
    let msg = "";
    try {
      enforceStrategyBudget({
        strategyTag: "arb-bot",
        predictedUsd: 250,
        budgets: [{ tag: "arb-bot", dailyUsd: 200 }],
        spentLookup: () => 50, // already spent $50 today
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/arb-bot/);
    expect(msg).toMatch(/\$250/);
    expect(msg).toMatch(/24h/);
    expect(msg).toMatch(/\$200/);
    expect(msg).toMatch(/\$50/); // current spend included
  });

  it("nextActions surfaces strategies_list + config", () => {
    let err: { nextActions?: Array<{ tool: string }> } | undefined;
    try {
      enforceStrategyBudget({
        strategyTag: "arb",
        predictedUsd: 100,
        budgets: [{ tag: "arb", perFireUsd: 50 }],
      });
    } catch (e) {
      err = e as { nextActions?: Array<{ tool: string }> };
    }
    const tools = err?.nextActions?.map((a) => a.tool) ?? [];
    expect(tools).toContain("strategies_list");
    expect(tools).toContain("config");
  });
});

// ── DB integration: usdSpentUnderStrategy ────────────────────

function insertSuccessTrade(args: {
  strategy: string | null;
  quoteAmount: string;
  timestamp: string;
}): void {
  insertTrade({
    timestamp: args.timestamp,
    chain: "base",
    account: "default",
    direction: "buy",
    base_token: "0xeeee",
    base_symbol: "ETH",
    base_amount: "1",
    quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    quote_symbol: "USDC",
    quote_amount: args.quoteAmount,
    price: args.quoteAmount,
    tx_hash: "0x" + Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64),
    status: "success",
    gas_used: null,
    gas_price_wei: null,
    gas_cost_native: null,
    aggregator: null,
    fee_tier: null,
    notes: null,
    strategy: args.strategy,
  });
}

describe("usdSpentUnderStrategy — lifetime", () => {
  it("returns 0 for unknown tag", () => {
    expect(usdSpentUnderStrategy("never-used")).toBe(0);
  });

  it("sums quote_amount across all matching strategy rows", () => {
    insertSuccessTrade({ strategy: "tag-a", quoteAmount: "100", timestamp: "2026-01-01T00:00:00Z" });
    insertSuccessTrade({ strategy: "tag-a", quoteAmount: "250", timestamp: "2026-02-01T00:00:00Z" });
    insertSuccessTrade({ strategy: "tag-b", quoteAmount: "999", timestamp: "2026-03-01T00:00:00Z" });
    expect(usdSpentUnderStrategy("tag-a")).toBe(350);
    expect(usdSpentUnderStrategy("tag-b")).toBe(999);
  });
});

describe("usdSpentUnderStrategy — 24h window", () => {
  it("filters by since timestamp", () => {
    const now = Date.now();
    const farPast = new Date(now - 48 * 3_600_000).toISOString();
    const recentPast = new Date(now - 12 * 3_600_000).toISOString();
    insertSuccessTrade({ strategy: "windowed", quoteAmount: "100", timestamp: farPast });
    insertSuccessTrade({ strategy: "windowed", quoteAmount: "50", timestamp: recentPast });
    const sinceIso = new Date(now - 24 * 3_600_000).toISOString();
    expect(usdSpentUnderStrategy("windowed", sinceIso)).toBe(50);
    expect(usdSpentUnderStrategy("windowed")).toBe(150);
  });
});

describe("end-to-end with real DB", () => {
  it("blocks a trade that pushes lifetime past cap", () => {
    insertSuccessTrade({ strategy: "tag", quoteAmount: "900", timestamp: "2026-01-01T00:00:00Z" });
    expect(() =>
      enforceStrategyBudget({
        strategyTag: "tag",
        predictedUsd: 200,
        budgets: [{ tag: "tag", lifetimeUsd: 1000 }],
      }),
    ).toThrow(/lifetime/i);
  });

  it("allows a trade that stays under both caps", () => {
    insertSuccessTrade({ strategy: "tag", quoteAmount: "500", timestamp: new Date().toISOString() });
    expect(() =>
      enforceStrategyBudget({
        strategyTag: "tag",
        predictedUsd: 100,
        budgets: [{ tag: "tag", lifetimeUsd: 1000, dailyUsd: 1000 }],
      }),
    ).not.toThrow();
  });

  it("wildcard rule matches any playbook tag", () => {
    insertSuccessTrade({ strategy: "playbook:42", quoteAmount: "900", timestamp: "2026-01-01T00:00:00Z" });
    expect(() =>
      enforceStrategyBudget({
        strategyTag: "playbook:42",
        predictedUsd: 200,
        budgets: [{ tag: "playbook:*", lifetimeUsd: 1000 }],
      }),
    ).toThrow(/Strategy budget exceeded/);
  });
});

// ── computeBudgetConsumption ─────────────────────────────────

describe("computeBudgetConsumption", () => {
  it("returns 0/null fields when no spend exists", () => {
    const result = computeBudgetConsumption({
      budgets: [{ tag: "fresh", lifetimeUsd: 1000 }],
      spentLookup: () => 0,
    });
    expect(result.length).toBe(1);
    expect(result[0].lifetimeSpentUsd).toBe(0);
    expect(result[0].remaining.lifetime).toBe(1000);
    expect(result[0].dailySpentUsd).toBe(null);
    expect(result[0].remaining.daily).toBe(null);
  });

  it("computes remaining = cap - spent, clamped to zero", () => {
    const result = computeBudgetConsumption({
      budgets: [{ tag: "over", lifetimeUsd: 100, dailyUsd: 50 }],
      // current spend ABOVE cap → clamped to 0
      spentLookup: () => 500,
    });
    expect(result[0].remaining.lifetime).toBe(0);
    expect(result[0].remaining.daily).toBe(0);
  });

  it("enumerates wildcard matches via distinctStrategiesFn", () => {
    const result = computeBudgetConsumption({
      budgets: [{ tag: "playbook:*", lifetimeUsd: 5000 }],
      distinctStrategiesFn: () => ["playbook:1", "playbook:2", "manual-x"],
      // 100 USD per matching tag — playbook:1 and playbook:2 match
      spentLookup: () => 100,
    });
    expect(result[0].matchedTags).toEqual(["playbook:1", "playbook:2"]);
    expect(result[0].lifetimeSpentUsd).toBe(200); // 100 * 2
    expect(result[0].remaining.lifetime).toBe(4800);
  });

  it("perFire-only rules report null lifetime/daily + perFire cap", () => {
    const result = computeBudgetConsumption({
      budgets: [{ tag: "fast", perFireUsd: 25 }],
      spentLookup: () => 999,
    });
    expect(result[0].lifetimeSpentUsd).toBe(null);
    expect(result[0].dailySpentUsd).toBe(null);
    expect(result[0].remaining.perFire).toBe(25);
  });
});
