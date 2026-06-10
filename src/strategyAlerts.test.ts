// Tests for strategy alerts (iter32). Three layers:
//
//   1. Pure rule evaluators — each tested against a synthetic
//      StrategyReport, no DB.
//   2. Reconciler — transitions OK→active fire, active→OK resolve,
//      no-change paths stay silent.
//   3. End-to-end runAlertTick — seeded DB, mocked notify fn,
//      asserts a fire emits + state persists, second tick is silent,
//      condition clears + resolution emits.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-strategy-alerts-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  evaluateStaleness,
  evaluateSlippageTrend,
  evaluateSuccessRateDrop,
  evaluateFailureStreak,
  evaluateBudgetApproach,
  evaluateDrawdownThreshold,
  evaluateTriggerProximity,
  evaluateDriftProximity,
  evaluateFundingRunway,
  evaluateAllRules,
  reconcileAlertState,
  ruleAppliesToTag,
  sectionsForRules,
  runAlertTick,
  enumerateActiveTags,
} = await import("./strategyAlerts.js");
const {
  openDb,
  closeDb,
  insertOrder,
  insertTrade,
  insertPlaybook,
  upsertStrategyAlertState,
  getStrategyAlertState,
  listStrategyAlertStates,
  upsertDrawdownState,
  listAlertEvents,
} = await import("./db.js");

beforeAll(() => openDb());
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM orders");
  db.exec("DELETE FROM schedules");
  db.exec("DELETE FROM rebalance_plans");
  db.exec("DELETE FROM trades");
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM playbooks");
  db.exec("DELETE FROM drawdown_state");
  db.exec("DELETE FROM order_check_log");
  db.exec("DELETE FROM strategy_alert_state");
  db.exec("DELETE FROM alert_events");
  vi.clearAllMocks();
});

// Synthetic report builder used by the pure-evaluator tests.
function makeReport(over: Record<string, unknown> = {}): never {
  return {
    tag: "playbook:1",
    mode: "real",
    window: "30d",
    generatedAt: "2026-05-31T00:00:00Z",
    identity: {
      displayName: "test-strategy",
      playbookId: 1,
      playbookStatus: "deployed",
      sourcePath: null,
      sourceHash: null,
      deployedAt: "2026-04-01T00:00:00Z",
      destroyedAt: null,
      ageSeconds: 30 * 86400,
    },
    composition: {
      totals: { orders: 1, schedules: 0, rebalances: 0 },
      lifecycle: { active: 1, filled: 0, failed: 0, expired: 0, cancelled: 0, paused: 0, completed: 0 },
      primitives: [],
    },
    performance: {
      windowSinceIso: null,
      fills: 0,
      failures: 0,
      successRate: null,
      buyCount: 0,
      sellCount: 0,
      realizedQuoteSpent: 0,
      realizedQuoteReceived: 0,
      realizedNetQuote: 0,
      avgSlippageBps: null,
      maxSlippageBps: null,
      p50SlippageBps: null,
      p95SlippageBps: null,
    },
    position: { positions: [] },
    risk: { budgets: [], drawdown: null },
    activity: { recentFills: [], recentFailures: [], recentJournal: [] },
    forward: { nextScheduleAt: null, nextScheduleId: null, pendingTriggers: [] },
    ...over,
  } as never;
}

// ── 1) tag matching ─────────────────────────────────────────

describe("ruleAppliesToTag", () => {
  it("matches when appliesTo is empty/missing", () => {
    expect(ruleAppliesToTag({ type: "staleness", thresholdSeconds: 60 } as never, "anything")).toBe(true);
    expect(ruleAppliesToTag({ type: "staleness", thresholdSeconds: 60, appliesTo: [] } as never, "anything")).toBe(true);
  });
  it("matches literal tags", () => {
    expect(
      ruleAppliesToTag({ type: "staleness", thresholdSeconds: 60, appliesTo: ["playbook:1"] } as never, "playbook:1"),
    ).toBe(true);
    expect(
      ruleAppliesToTag({ type: "staleness", thresholdSeconds: 60, appliesTo: ["playbook:1"] } as never, "playbook:2"),
    ).toBe(false);
  });
  it("matches `prefix*` wildcards", () => {
    expect(
      ruleAppliesToTag({ type: "staleness", thresholdSeconds: 60, appliesTo: ["playbook:*"] } as never, "playbook:7"),
    ).toBe(true);
    expect(
      ruleAppliesToTag({ type: "staleness", thresholdSeconds: 60, appliesTo: ["playbook:*"] } as never, "dca-eth"),
    ).toBe(false);
  });
});

// ── 2) sectionsForRules ─────────────────────────────────────

describe("sectionsForRules", () => {
  it("includes identity by default", () => {
    const s = sectionsForRules([]);
    expect(s.has("identity")).toBe(true);
  });
  it("picks the union of required sections", () => {
    const s = sectionsForRules([
      { type: "staleness", thresholdSeconds: 60 } as never,
      { type: "slippage_trend", baselineBps: 50, alertMultiplier: 1.5, minSampleSize: 5 } as never,
    ]);
    expect(s.has("activity")).toBe(true);
    expect(s.has("composition")).toBe(true);
    expect(s.has("performance")).toBe(true);
  });
});

// ── 3) evaluateStaleness ────────────────────────────────────

describe("evaluateStaleness", () => {
  const rule = { type: "staleness" as const, thresholdSeconds: 86400 };

  it("returns inapplicable when activity section missing", () => {
    const ev = evaluateStaleness({
      tag: "x",
      rule,
      report: makeReport({ activity: undefined }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("returns inapplicable when no fills + no active primitives", () => {
    const ev = evaluateStaleness({
      tag: "x",
      rule,
      report: makeReport({
        activity: { recentFills: [], recentFailures: [], recentJournal: [] },
        composition: {
          totals: { orders: 0, schedules: 0, rebalances: 0 },
          lifecycle: { active: 0, filled: 0, failed: 0, expired: 0, cancelled: 0, paused: 0, completed: 0 },
          primitives: [],
        },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("returns applicable but not violated for young deployment with no fills", () => {
    const ev = evaluateStaleness({
      tag: "x",
      rule,
      report: makeReport({
        activity: { recentFills: [], recentFailures: [], recentJournal: [] },
        identity: { displayName: "y", playbookId: null, playbookStatus: null, sourcePath: null, sourceHash: null, deployedAt: null, destroyedAt: null, ageSeconds: 3600 },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(false);
  });

  it("violates when last fill is older than threshold", () => {
    const now = new Date("2026-05-31T00:00:00Z");
    const ev = evaluateStaleness({
      tag: "x",
      rule,
      report: makeReport({
        activity: {
          recentFills: [{ at: "2026-05-29T00:00:00Z", kind: "fill", summary: "", primitiveType: "trade", primitiveId: 1, txHash: "0x" }],
          recentFailures: [],
          recentJournal: [],
        },
      }),
      now,
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(true);
    expect((ev.value as { secondsSinceLastFill: number }).secondsSinceLastFill).toBeGreaterThanOrEqual(86400);
  });

  it("does not violate when last fill is recent", () => {
    const now = new Date("2026-05-31T00:00:00Z");
    const ev = evaluateStaleness({
      tag: "x",
      rule,
      report: makeReport({
        activity: {
          recentFills: [{ at: "2026-05-30T23:30:00Z", kind: "fill", summary: "", primitiveType: "trade", primitiveId: 1, txHash: "0x" }],
          recentFailures: [],
          recentJournal: [],
        },
      }),
      now,
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(false);
  });
});

// ── 4) evaluateSlippageTrend ────────────────────────────────

describe("evaluateSlippageTrend", () => {
  const rule = { type: "slippage_trend" as const, baselineBps: 50, alertMultiplier: 1.5, minSampleSize: 5 };

  it("inapplicable when no slippage samples", () => {
    const ev = evaluateSlippageTrend({
      tag: "x",
      rule,
      report: makeReport(),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("inapplicable when below sample size", () => {
    const ev = evaluateSlippageTrend({
      tag: "x",
      rule,
      report: makeReport({
        performance: {
          windowSinceIso: null,
          fills: 3,
          failures: 0,
          successRate: 1,
          buyCount: 3,
          sellCount: 0,
          realizedQuoteSpent: 0,
          realizedQuoteReceived: 0,
          realizedNetQuote: 0,
          avgSlippageBps: 100,
          maxSlippageBps: 120,
          p50SlippageBps: 90,
          p95SlippageBps: 115,
        },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("violates when avg exceeds baseline × multiplier", () => {
    const ev = evaluateSlippageTrend({
      tag: "x",
      rule,
      report: makeReport({
        performance: {
          windowSinceIso: null,
          fills: 10,
          failures: 0,
          successRate: 1,
          buyCount: 5,
          sellCount: 5,
          realizedQuoteSpent: 0,
          realizedQuoteReceived: 0,
          realizedNetQuote: 0,
          avgSlippageBps: 85,
          maxSlippageBps: 120,
          p50SlippageBps: 80,
          p95SlippageBps: 115,
        },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(true);
    expect((ev.value as { thresholdBps: number }).thresholdBps).toBe(75);
  });

  it("does not violate when within threshold", () => {
    const ev = evaluateSlippageTrend({
      tag: "x",
      rule,
      report: makeReport({
        performance: {
          windowSinceIso: null,
          fills: 10,
          failures: 0,
          successRate: 1,
          buyCount: 5,
          sellCount: 5,
          realizedQuoteSpent: 0,
          realizedQuoteReceived: 0,
          realizedNetQuote: 0,
          avgSlippageBps: 60,
          maxSlippageBps: 80,
          p50SlippageBps: 55,
          p95SlippageBps: 75,
        },
      }),
      now: new Date(),
    });
    expect(ev.violated).toBe(false);
  });
});

// ── 5) evaluateSuccessRateDrop ──────────────────────────────

describe("evaluateSuccessRateDrop", () => {
  const rule = { type: "success_rate_drop" as const, minRate: 0.8, minSampleSize: 10 };

  const perfBase = {
    windowSinceIso: null,
    fills: 0,
    failures: 0,
    successRate: 0,
    buyCount: 0,
    sellCount: 0,
    realizedQuoteSpent: 0,
    realizedQuoteReceived: 0,
    realizedNetQuote: 0,
    avgSlippageBps: null,
    maxSlippageBps: null,
    p50SlippageBps: null,
    p95SlippageBps: null,
  };

  it("inapplicable below sample size", () => {
    const ev = evaluateSuccessRateDrop({
      tag: "x",
      rule,
      report: makeReport({
        performance: { ...perfBase, fills: 5, failures: 0, successRate: 1 },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("violates when rate drops below minRate", () => {
    const ev = evaluateSuccessRateDrop({
      tag: "x",
      rule,
      report: makeReport({
        performance: { ...perfBase, fills: 7, failures: 5, successRate: 7 / 12 },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(true);
  });

  it("does not violate when above minRate", () => {
    const ev = evaluateSuccessRateDrop({
      tag: "x",
      rule,
      report: makeReport({
        performance: { ...perfBase, fills: 10, failures: 2, successRate: 10 / 12 },
      }),
      now: new Date(),
    });
    expect(ev.violated).toBe(false);
  });
});

// ── 6) evaluateFailureStreak ────────────────────────────────

describe("evaluateFailureStreak", () => {
  const rule = { type: "failure_streak" as const, alertCount: 3 };
  const fillEntry = (at: string, id: number) =>
    ({ at, kind: "fill" as const, summary: "", primitiveType: "trade" as const, primitiveId: id, txHash: "0x" });
  const failEntry = (at: string, id: number) =>
    ({ at, kind: "failure" as const, summary: "", primitiveType: "trade" as const, primitiveId: id, txHash: "0x" });

  it("inapplicable when no terminal trades", () => {
    const ev = evaluateFailureStreak({
      tag: "x",
      rule,
      report: makeReport(),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("counts consecutive failures from newest", () => {
    const ev = evaluateFailureStreak({
      tag: "x",
      rule,
      report: makeReport({
        activity: {
          recentFills: [fillEntry("2026-05-25T00:00:00Z", 1)],
          recentFailures: [
            failEntry("2026-05-28T00:00:00Z", 2),
            failEntry("2026-05-29T00:00:00Z", 3),
            failEntry("2026-05-30T00:00:00Z", 4),
          ],
          recentJournal: [],
        },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(true);
    expect((ev.value as { streak: number }).streak).toBe(3);
  });

  it("resets streak after a successful fill", () => {
    const ev = evaluateFailureStreak({
      tag: "x",
      rule,
      report: makeReport({
        activity: {
          recentFills: [fillEntry("2026-05-30T00:00:00Z", 99)],
          recentFailures: [failEntry("2026-05-29T00:00:00Z", 1), failEntry("2026-05-28T00:00:00Z", 2)],
          recentJournal: [],
        },
      }),
      now: new Date(),
    });
    expect(ev.violated).toBe(false);
    expect((ev.value as { streak: number }).streak).toBe(0);
  });
});

// ── 7) evaluateBudgetApproach ───────────────────────────────

describe("evaluateBudgetApproach", () => {
  const rule = { type: "budget_approach" as const, warnPct: 0.8 };

  it("inapplicable when no budgets matched", () => {
    const ev = evaluateBudgetApproach({
      tag: "x",
      rule,
      report: makeReport(),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("violates when ANY lifetime/daily consumption ≥ warnPct", () => {
    const ev = evaluateBudgetApproach({
      tag: "x",
      rule,
      report: makeReport({
        risk: {
          budgets: [{
            pattern: "playbook:1",
            lifetimeUsd: 1000,
            lifetimeSpentUsd: 850,
            lifetimePctUsed: 85,
            dailyUsd: null,
            dailySpentUsd: null,
            dailyPctUsed: null,
            perFireUsd: null,
          }],
          drawdown: null,
        },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(true);
  });

  it("does not violate when below warnPct", () => {
    const ev = evaluateBudgetApproach({
      tag: "x",
      rule,
      report: makeReport({
        risk: {
          budgets: [{
            pattern: "playbook:1",
            lifetimeUsd: 1000,
            lifetimeSpentUsd: 300,
            lifetimePctUsed: 30,
            dailyUsd: null,
            dailySpentUsd: null,
            dailyPctUsed: null,
            perFireUsd: null,
          }],
          drawdown: null,
        },
      }),
      now: new Date(),
    });
    expect(ev.violated).toBe(false);
  });
});

// ── 8) evaluateDrawdownThreshold ────────────────────────────

describe("evaluateDrawdownThreshold", () => {
  const rule = { type: "drawdown_threshold" as const, alertPct: 10 };

  it("inapplicable when no per-strategy drawdown row", () => {
    const ev = evaluateDrawdownThreshold({
      tag: "x",
      rule,
      report: makeReport(),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("violates when drawdown ≥ alertPct", () => {
    const ev = evaluateDrawdownThreshold({
      tag: "x",
      rule,
      report: makeReport({
        risk: {
          budgets: [],
          drawdown: {
            scopeKey: "strategy:x",
            peakUsd: 10000,
            peakAt: "2026-01-01T00:00:00Z",
            lastValueUsd: 8500,
            drawdownPct: 15,
            tripped: false,
            trippedAt: null,
          },
        },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(true);
  });
});

// ── 9) evaluateTriggerProximity ─────────────────────────────

describe("evaluateTriggerProximity", () => {
  const rule = { type: "trigger_proximity" as const, alertDistancePct: 2 };

  it("inapplicable when forward section missing", () => {
    const ev = evaluateTriggerProximity({
      tag: "x",
      rule,
      report: makeReport({ forward: undefined }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("inapplicable when no pending triggers", () => {
    const ev = evaluateTriggerProximity({
      tag: "x",
      rule,
      report: makeReport(),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("inapplicable when no live prices (every distance is null)", () => {
    const ev = evaluateTriggerProximity({
      tag: "x",
      rule,
      report: makeReport({
        forward: {
          nextScheduleAt: null,
          nextScheduleId: null,
          pendingTriggers: [{
            orderId: 1, trigger: "price_below", side: "sell",
            currentPriceUsd: null, fireThresholdUsd: 2000, distancePct: null,
            wouldFireNow: false, trailingWaterMarkUsd: null, trailingTracking: null,
          }],
        },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(false);
  });

  it("violates when closest order distance ≤ alertDistancePct", () => {
    const ev = evaluateTriggerProximity({
      tag: "x",
      rule,
      report: makeReport({
        forward: {
          nextScheduleAt: null,
          nextScheduleId: null,
          pendingTriggers: [
            { orderId: 1, trigger: "price_below", side: "sell", currentPriceUsd: 2000, fireThresholdUsd: 1990, distancePct: -0.5, wouldFireNow: false, trailingWaterMarkUsd: null, trailingTracking: null },
            { orderId: 2, trigger: "price_below", side: "sell", currentPriceUsd: 2000, fireThresholdUsd: 1800, distancePct: -10, wouldFireNow: false, trailingWaterMarkUsd: null, trailingTracking: null },
          ],
        },
      }),
      now: new Date(),
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(true);
    expect((ev.value as { orderId: number }).orderId).toBe(1);
  });

  it("does not violate when nothing close", () => {
    const ev = evaluateTriggerProximity({
      tag: "x",
      rule,
      report: makeReport({
        forward: {
          nextScheduleAt: null,
          nextScheduleId: null,
          pendingTriggers: [{ orderId: 1, trigger: "price_below", side: "sell", currentPriceUsd: 2000, fireThresholdUsd: 1500, distancePct: -25, wouldFireNow: false, trailingWaterMarkUsd: null, trailingTracking: null }],
        },
      }),
      now: new Date(),
    });
    expect(ev.violated).toBe(false);
  });
});

// ── 10) evaluateAllRules + tag filter ───────────────────────

describe("evaluateAllRules", () => {
  it("only evaluates rules that apply to the tag", () => {
    const rules = [
      { type: "staleness" as const, thresholdSeconds: 60, appliesTo: ["playbook:1"] },
      { type: "staleness" as const, thresholdSeconds: 60, appliesTo: ["other-tag"] },
    ];
    const evals = evaluateAllRules({
      tag: "playbook:1",
      rules: rules as never,
      report: makeReport(),
      now: new Date(),
    });
    expect(evals).toHaveLength(1);
  });
});

// ── 11) reconcileAlertState ─────────────────────────────────

describe("reconcileAlertState", () => {
  const inapplicable = { tag: "x", ruleType: "staleness" as const, rule: {} as never, applicable: false, violated: false, message: "", value: {} };
  const violated = { tag: "x", ruleType: "staleness" as const, rule: {} as never, applicable: true, violated: true, message: "v", value: {} };
  const ok = { tag: "x", ruleType: "staleness" as const, rule: {} as never, applicable: true, violated: false, message: "ok", value: {} };

  it("inapplicable → skip", () => {
    const ts = reconcileAlertState({
      evaluations: [inapplicable],
      stateLookup: () => null,
      now: new Date(),
    });
    expect(ts[0].kind).toBe("skip");
  });

  it("no prior state + violated → fire", () => {
    const ts = reconcileAlertState({
      evaluations: [violated],
      stateLookup: () => null,
      now: new Date(),
    });
    expect(ts[0].kind).toBe("fire");
  });

  it("active prior + violated → still_active", () => {
    const ts = reconcileAlertState({
      evaluations: [violated],
      stateLookup: () => ({
        tag: "x", rule_type: "staleness", active: 1,
        first_triggered_at: "2026-05-30T00:00:00Z", last_evaluated_at: "2026-05-30T01:00:00Z", last_value_json: null,
      }),
      now: new Date(),
    });
    expect(ts[0].kind).toBe("still_active");
  });

  it("active prior + ok → resolve", () => {
    const ts = reconcileAlertState({
      evaluations: [ok],
      stateLookup: () => ({
        tag: "x", rule_type: "staleness", active: 1,
        first_triggered_at: "2026-05-30T00:00:00Z", last_evaluated_at: "2026-05-30T01:00:00Z", last_value_json: null,
      }),
      now: new Date(),
    });
    expect(ts[0].kind).toBe("resolve");
  });

  it("no prior + ok → still_ok", () => {
    const ts = reconcileAlertState({
      evaluations: [ok],
      stateLookup: () => null,
      now: new Date(),
    });
    expect(ts[0].kind).toBe("still_ok");
  });
});

// ── 12) end-to-end runAlertTick ─────────────────────────────

describe("runAlertTick — end-to-end", () => {
  const ETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  function seedRealStrategy(tag: string) {
    insertOrder({
      side: "sell",
      trigger_type: "price_below",
      target_price_usd: 1900,
      trail_pct: null,
      chain: "base",
      account: "default",
      base_token: ETH,
      base_symbol: "ETH",
      quote_token: USDC,
      quote_symbol: "USDC",
      base_amount: "1",
      quote_amount: null,
      slippage_bps: 50,
      auto_slippage: false,
      expires_at: null,
      strategy: tag,
      note: null,
      group_id: null,
    });
  }

  it("disabled config → no-op tick", async () => {
    const config = baseConfig({ enabled: false, rules: [] });
    const r = await runAlertTick({
      config: config as never,
      logger: silentLogger(),
      notifyFn: vi.fn(),
    });
    expect(r.evaluations).toHaveLength(0);
    expect(r.fired).toBe(0);
  });

  it("empty rules → no-op tick even when enabled", async () => {
    seedRealStrategy("playbook:1");
    const config = baseConfig({ enabled: true, rules: [] });
    const notifyFn = vi.fn();
    const r = await runAlertTick({
      config: config as never,
      logger: silentLogger(),
      notifyFn,
    });
    expect(r.fired).toBe(0);
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("violates → fires + persists state + dedup on second tick", async () => {
    seedRealStrategy("dca-test");
    // Seed a trade with high slippage so slippage_trend fires.
    for (let i = 0; i < 6; i++) {
      insertTrade({
        timestamp: `2026-05-${20 + i}T00:00:00Z`,
        chain: "base",
        account: "default",
        direction: "buy",
        base_token: ETH,
        base_symbol: "ETH",
        base_amount: "0.1",
        quote_token: USDC,
        quote_symbol: "USDC",
        quote_amount: "250",
        price: "2500",
        tx_hash: `0x${i}`,
        status: "success",
        gas_used: null,
        gas_price_wei: null,
        gas_cost_native: null,
        aggregator: "kyberswap",
        fee_tier: null,
        notes: null,
        strategy: "dca-test",
        realized_slippage_bps: 200,
      });
    }
    const config = baseConfig({
      enabled: true,
      rules: [
        { type: "slippage_trend", baselineBps: 50, alertMultiplier: 1.5, minSampleSize: 5 } as never,
      ],
    });
    const notifyFn = vi.fn();
    const r1 = await runAlertTick({
      config: config as never,
      logger: silentLogger(),
      notifyFn,
      onlyTags: ["dca-test"],
    });
    expect(r1.fired).toBe(1);
    expect(notifyFn).toHaveBeenCalledTimes(1);
    const fireCall = notifyFn.mock.calls[0][0];
    expect(fireCall.event).toBe("strategy.alert.slippage_trend");
    expect(fireCall.severity).toBe("warn");

    // State row should now be active=1.
    const state = getStrategyAlertState("dca-test", "slippage_trend");
    expect(state?.active).toBe(1);
    expect(state?.first_triggered_at).toBeTruthy();

    // Second tick: still violating → still_active, no new notify.
    notifyFn.mockClear();
    const r2 = await runAlertTick({
      config: config as never,
      logger: silentLogger(),
      notifyFn,
      onlyTags: ["dca-test"],
    });
    expect(r2.fired).toBe(0);
    expect(r2.stillActive).toBe(1);
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("active → resolved emits resolution notification", async () => {
    seedRealStrategy("dca-test");
    // Seed a prior active state row.
    upsertStrategyAlertState({
      tag: "dca-test",
      ruleType: "drawdown_threshold",
      active: true,
      firstTriggeredAt: "2026-05-29T00:00:00Z",
      lastEvaluatedAt: "2026-05-30T00:00:00Z",
      lastValueJson: '{"drawdownPct":15}',
    });
    // Seed a drawdown row with low pct so the rule does NOT violate now.
    upsertDrawdownState({
      scopeKey: "strategy:dca-test",
      peakUsd: 10000,
      peakAt: "2026-05-01T00:00:00Z",
      lastValueUsd: 9900,
      trippedAt: null,
    });
    const config = baseConfig({
      enabled: true,
      rules: [
        { type: "drawdown_threshold", alertPct: 10 } as never,
      ],
    });
    const notifyFn = vi.fn();
    const r = await runAlertTick({
      config: config as never,
      logger: silentLogger(),
      notifyFn,
      onlyTags: ["dca-test"],
    });
    expect(r.resolved).toBe(1);
    expect(notifyFn).toHaveBeenCalledTimes(1);
    expect(notifyFn.mock.calls[0][0].event).toBe("strategy.alert.resolved.drawdown_threshold");
    const after = getStrategyAlertState("dca-test", "drawdown_threshold");
    expect(after?.active).toBe(0);
    expect(after?.first_triggered_at).toBeNull();
  });

  it("inapplicable rule (no samples) does not write a state row", async () => {
    seedRealStrategy("empty-strategy");
    const config = baseConfig({
      enabled: true,
      rules: [{ type: "slippage_trend", baselineBps: 50, alertMultiplier: 1.5, minSampleSize: 5 } as never],
    });
    const notifyFn = vi.fn();
    const r = await runAlertTick({
      config: config as never,
      logger: silentLogger(),
      notifyFn,
      onlyTags: ["empty-strategy"],
    });
    expect(r.fired).toBe(0);
    expect(r.skipped).toBe(1);
    expect(listStrategyAlertStates({ tag: "empty-strategy" })).toHaveLength(0);
  });

  it("enumerates only strategies with active primitives or trades", () => {
    // No data → empty.
    expect(enumerateActiveTags()).toEqual([]);
    // Seed a strategy.
    seedRealStrategy("tag-a");
    seedRealStrategy("tag-b");
    const tags = enumerateActiveTags();
    expect(tags).toEqual(["tag-a", "tag-b"]);
  });

  // ── v28: alert_events durable journal ─────────────────────

  it("fire writes a 'fired' journal row; still_active ticks do NOT", async () => {
    seedRealStrategy("dca-test");
    for (let i = 0; i < 6; i++) {
      insertTrade({
        timestamp: `2026-05-${20 + i}T00:00:00Z`,
        chain: "base",
        account: "default",
        direction: "buy",
        base_token: ETH,
        base_symbol: "ETH",
        base_amount: "0.1",
        quote_token: USDC,
        quote_symbol: "USDC",
        quote_amount: "250",
        price: "2500",
        tx_hash: `0x${i}`,
        status: "success",
        gas_used: null,
        gas_price_wei: null,
        gas_cost_native: null,
        aggregator: "kyberswap",
        fee_tier: null,
        notes: null,
        strategy: "dca-test",
        realized_slippage_bps: 200,
      });
    }
    const config = baseConfig({
      enabled: true,
      rules: [{ type: "slippage_trend", baselineBps: 50, alertMultiplier: 1.5, minSampleSize: 5 } as never],
    });
    await runAlertTick({ config: config as never, logger: silentLogger(), notifyFn: vi.fn(), onlyTags: ["dca-test"] });
    // Second tick is still_active — must not append a second row.
    await runAlertTick({ config: config as never, logger: silentLogger(), notifyFn: vi.fn(), onlyTags: ["dca-test"] });

    const events = listAlertEvents({ tag: "dca-test" });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("fired");
    expect(events[0].rule_type).toBe("slippage_trend");
    expect(events[0].severity).toBe("warn");
    expect(events[0].message).toBeTruthy();
    expect(events[0].value_json).toBeTruthy();
    expect(events[0].duration_seconds).toBeNull();
  });

  it("resolve writes a 'resolved' journal row with the alerting duration", async () => {
    seedRealStrategy("dca-test");
    upsertStrategyAlertState({
      tag: "dca-test",
      ruleType: "drawdown_threshold",
      active: true,
      firstTriggeredAt: "2026-05-29T00:00:00Z",
      lastEvaluatedAt: "2026-05-30T00:00:00Z",
      lastValueJson: '{"drawdownPct":15}',
    });
    upsertDrawdownState({
      scopeKey: "strategy:dca-test",
      peakUsd: 10000,
      peakAt: "2026-05-01T00:00:00Z",
      lastValueUsd: 9900,
      trippedAt: null,
    });
    const config = baseConfig({ enabled: true, rules: [{ type: "drawdown_threshold", alertPct: 10 } as never] });
    await runAlertTick({ config: config as never, logger: silentLogger(), notifyFn: vi.fn(), onlyTags: ["dca-test"] });

    const events = listAlertEvents({ tag: "dca-test", event: "resolved" });
    expect(events).toHaveLength(1);
    expect(events[0].rule_type).toBe("drawdown_threshold");
    expect(events[0].severity).toBe("info");
    // first_triggered_at was 2026-05-29; duration must be positive.
    expect(events[0].duration_seconds).toBeGreaterThan(0);
  });

  it("listAlertEvents filters by tag / event / limit, newest first", async () => {
    const { insertAlertEvent } = await import("./db.js");
    insertAlertEvent({ at: "2026-06-01T00:00:00Z", tag: "a", ruleType: "staleness", event: "fired", severity: "warn" });
    insertAlertEvent({ at: "2026-06-02T00:00:00Z", tag: "a", ruleType: "staleness", event: "resolved", severity: "info", durationSeconds: 60 });
    insertAlertEvent({ at: "2026-06-03T00:00:00Z", tag: "b", ruleType: "failure_streak", event: "fired", severity: "critical" });

    expect(listAlertEvents({})).toHaveLength(3);
    expect(listAlertEvents({ tag: "a" })).toHaveLength(2);
    expect(listAlertEvents({ event: "fired" })).toHaveLength(2);
    expect(listAlertEvents({ tag: "a", event: "fired" })).toHaveLength(1);
    const limited = listAlertEvents({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].tag).toBe("b"); // newest first
    expect(listAlertEvents({ sinceIso: "2026-06-02T00:00:00Z", untilIso: "2026-06-02T23:59:59Z" })).toHaveLength(1);
  });

  it("multiple strategies + per-rule appliesTo filters", async () => {
    seedRealStrategy("playbook:1");
    seedRealStrategy("dca-eth");
    // Seed a tripped drawdown for ONLY playbook:1.
    upsertDrawdownState({
      scopeKey: "strategy:playbook:1",
      peakUsd: 10000,
      peakAt: "2026-05-01T00:00:00Z",
      lastValueUsd: 8000,
      trippedAt: null,
    });
    const config = baseConfig({
      enabled: true,
      rules: [
        { type: "drawdown_threshold", alertPct: 10, appliesTo: ["playbook:*"] } as never,
      ],
    });
    const notifyFn = vi.fn();
    const r = await runAlertTick({
      config: config as never,
      logger: silentLogger(),
      notifyFn,
    });
    expect(r.fired).toBe(1);
    expect(notifyFn.mock.calls[0][0].fields.tag).toBe("playbook:1");
  });
});

// ── helpers ─────────────────────────────────────────────────

function silentLogger(): never {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;
}

function baseConfig(over: { enabled: boolean; rules: unknown[] }) {
  return {
    activeChain: "base",
    activeAccount: "default",
    defaultSlippageBps: 50,
    chains: {},
    aggregator: { preferred: ["kyberswap"], mode: "first" },
    safety: {
      enabled: true,
      maxSlippageBps: 500,
      allowInfiniteApprovals: false,
      strategyBudgets: [],
      strategyAlerts: {
        enabled: over.enabled,
        rules: over.rules,
        eventPrefix: "strategy.alert",
      },
    },
    notifications: { channels: [], dedupWindowMs: 60_000 },
    engine: {},
    mev: {},
  };
}

// ── drift_proximity rule ─────────────────────────────────────

describe("evaluateDriftProximity", () => {
  const evalDrift = evaluateDriftProximity;
  const rule = { type: "drift_proximity", alertPctOfThreshold: 80 } as never;

  function reportWithDrift(entries: Array<Record<string, unknown>>): never {
    return {
      tag: "t",
      mode: "real",
      window: "30d",
      generatedAt: "x",
      forward: { nextScheduleAt: null, nextScheduleId: null, pendingTriggers: [], rebalanceDrift: entries },
    } as never;
  }

  it("violates when the hottest plan reaches the pct-of-threshold gate", () => {
    const r = evalDrift({
      tag: "t",
      rule,
      report: reportWithDrift([
        { planId: 1, lastDriftPct: 1, thresholdPct: 5, pctOfThreshold: 20 },
        { planId: 2, lastDriftPct: 4.2, thresholdPct: 5, pctOfThreshold: 84 },
      ]),
      now: new Date(),
    });
    expect(r.applicable).toBe(true);
    expect(r.violated).toBe(true);
    expect(r.message).toContain("Plan #2");
    expect(r.value.pctOfThreshold).toBe(84);
  });

  it("stays OK below the gate (reports the hottest plan)", () => {
    const r = evalDrift({
      tag: "t",
      rule,
      report: reportWithDrift([{ planId: 1, lastDriftPct: 2, thresholdPct: 5, pctOfThreshold: 40 }]),
      now: new Date(),
    });
    expect(r.applicable).toBe(true);
    expect(r.violated).toBe(false);
    expect(r.message).toContain("40% of threshold");
  });

  it("inapplicable: no plans / never-evaluated plans / missing section", () => {
    expect(evalDrift({ tag: "t", rule, report: reportWithDrift([]), now: new Date() }).applicable).toBe(false);
    expect(
      evalDrift({
        tag: "t",
        rule,
        report: reportWithDrift([{ planId: 1, lastDriftPct: null, thresholdPct: 5, pctOfThreshold: null }]),
        now: new Date(),
      }).applicable,
    ).toBe(false);
    expect(
      evalDrift({ tag: "t", rule, report: { tag: "t", mode: "real", window: "30d", generatedAt: "x" } as never, now: new Date() }).applicable,
    ).toBe(false);
  });
});

describe("runAlertTick — drift_proximity end-to-end", () => {
  it("fires when a seeded plan's persisted drift crosses the gate", async () => {
    const { insertRebalancePlan } = await import("./db.js");
    const planId = insertRebalancePlan({
      name: "hot-folio",
      account: "default",
      chain: "base",
      quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      quote_symbol: "USDC",
      targets: [
        { token: "ETH", targetPct: 60 },
        { token: "USDC", targetPct: 40 },
      ],
      drift_threshold_pct: 5,
      min_trade_usd: 10,
      cron_expr: "0 */6 * * *",
      next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
      start_at: null,
      end_at: null,
      max_runs: null,
      slippage_bps: null,
      auto_slippage: false,
      strategy: "drift-test",
      note: null,
    });
    openDb()
      .prepare(`UPDATE rebalance_plans SET last_run_max_drift_pct = 4.5, last_run_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), planId);

    const config = baseConfig({
      enabled: true,
      rules: [{ type: "drift_proximity", alertPctOfThreshold: 80 } as never],
    });
    const notifyFn = vi.fn();
    const r = await runAlertTick({
      config: config as never,
      logger: silentLogger(),
      notifyFn,
      onlyTags: ["drift-test"],
    });
    expect(r.fired).toBe(1);
    expect(notifyFn).toHaveBeenCalledTimes(1);
    const call = notifyFn.mock.calls[0][0];
    expect(call.event).toBe("strategy.alert.drift_proximity");
    expect(call.title).toContain("90% of its 5% threshold");
  });
});

// ── circuit breaker (rule action: "pause") ──────────────────

describe("runAlertTick — circuit breaker", () => {
  const ETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  function seedBreakerFixture(tag: string) {
    // One active order owned by the tag (the primitive the breaker pauses).
    insertOrder({
      side: "sell", trigger_type: "price_below", target_price_usd: 1900, trail_pct: null,
      chain: "base", account: "default",
      base_token: ETH, base_symbol: "ETH", quote_token: USDC, quote_symbol: "USDC",
      base_amount: "1", quote_amount: null, slippage_bps: 50, auto_slippage: false,
      expires_at: null, strategy: tag, note: null, group_id: null,
    });
    // Six high-slippage trades so slippage_trend fires.
    for (let i = 0; i < 6; i++) {
      insertTrade({
        timestamp: `2026-05-${20 + i}T00:00:00Z`,
        chain: "base", account: "default", direction: "buy",
        base_token: ETH, base_symbol: "ETH", base_amount: "0.1",
        quote_token: USDC, quote_symbol: "USDC", quote_amount: "250",
        price: "2500", tx_hash: `0xbrk${i}`, status: "success",
        gas_used: null, gas_price_wei: null, gas_cost_native: null,
        aggregator: "kyberswap", fee_tier: null, notes: null,
        strategy: tag, realized_slippage_bps: 200,
      });
    }
  }

  const breakerRules = [
    { type: "slippage_trend", baselineBps: 50, alertMultiplier: 1.5, minSampleSize: 5, action: "pause" } as never,
  ];

  it("fire with action=pause pauses the strategy's primitives + notifies + journals", async () => {
    seedBreakerFixture("dca-test");
    const { getOrderById } = await import("./db.js");
    const config = baseConfig({ enabled: true, rules: breakerRules });
    const notifyFn = vi.fn();
    const r = await runAlertTick({
      config: config as never,
      logger: silentLogger(),
      notifyFn,
      onlyTags: ["dca-test"],
    });
    expect(r.fired).toBe(1);
    expect(r.breakers).toHaveLength(1);
    expect(r.breakers[0].tag).toBe("dca-test");
    expect(r.breakers[0].orders).toHaveLength(1);
    expect(r.breakers[0].total).toBe(1);
    expect(r.breakers[0].error).toBeUndefined();

    // The owned order is actually paused.
    expect(getOrderById(r.breakers[0].orders[0])?.status).toBe("paused");

    // Two notifications: the alert fire + the breaker (critical).
    expect(notifyFn).toHaveBeenCalledTimes(2);
    const breakerCall = notifyFn.mock.calls[1][0];
    expect(breakerCall.event).toBe("strategy.alert.circuit_breaker");
    expect(breakerCall.severity).toBe("critical");
    expect(breakerCall.body).toMatch(/strategy resume dca-test/);

    // Journal: a breaker_paused event alongside the fired event.
    const events = listAlertEvents({ tag: "dca-test" });
    const kinds = events.map((e) => e.event).sort();
    expect(kinds).toContain("fired");
    expect(kinds).toContain("breaker_paused");
  });

  it("still_active does NOT re-pause — an operator's resume sticks while the rule stays violated", async () => {
    seedBreakerFixture("dca-test");
    const { getOrderById } = await import("./db.js");
    const { resumeStrategyPrimitives } = await import("./strategyControl.js");
    const config = baseConfig({ enabled: true, rules: breakerRules });
    const notifyFn = vi.fn();
    const r1 = await runAlertTick({
      config: config as never, logger: silentLogger(), notifyFn, onlyTags: ["dca-test"],
    });
    expect(r1.breakers).toHaveLength(1);
    const orderId = r1.breakers[0].orders[0];

    // Operator investigates + deliberately resumes.
    resumeStrategyPrimitives("dca-test");
    expect(getOrderById(orderId)?.status).toBe("active");

    // Rule is STILL violated on the next tick → still_active, no re-pause.
    notifyFn.mockClear();
    const r2 = await runAlertTick({
      config: config as never, logger: silentLogger(), notifyFn, onlyTags: ["dca-test"],
    });
    expect(r2.fired).toBe(0);
    expect(r2.stillActive).toBe(1);
    expect(r2.breakers).toHaveLength(0);
    expect(notifyFn).not.toHaveBeenCalled();
    expect(getOrderById(orderId)?.status).toBe("active");
  });

  it("action omitted (default notify) never touches primitives", async () => {
    seedBreakerFixture("dca-test");
    const { listOrders } = await import("./db.js");
    const config = baseConfig({
      enabled: true,
      rules: [{ type: "slippage_trend", baselineBps: 50, alertMultiplier: 1.5, minSampleSize: 5 } as never],
    });
    const r = await runAlertTick({
      config: config as never, logger: silentLogger(), notifyFn: vi.fn(), onlyTags: ["dca-test"],
    });
    expect(r.fired).toBe(1);
    expect(r.breakers).toHaveLength(0);
    expect(listOrders({ status: "paused" })).toHaveLength(0);
  });
});

// ── funding_runway evaluator ────────────────────────────────

describe("evaluateFundingRunway", () => {
  const rule = { type: "funding_runway", thresholdDays: 7 } as never;
  const NOW2 = new Date("2026-06-10T00:00:00Z");

  function bucket(over: Record<string, unknown> = {}) {
    return {
      account: "default", chain: "base", paper: false,
      token: "0xusdc", symbol: "USDC",
      balance: 300, oneShotReserved: 0, burn30d: 400,
      totalFiresInHorizon: 8, firesCovered: 3,
      exhaustsAt: "2026-06-14T00:00:00.000Z", runwayDays: 4,
      obligations: [],
      ...over,
    };
  }

  function reportWith(buckets: unknown[], skipped: unknown[] = []) {
    return {
      tag: "dca-test", mode: "real", window: "30d", generatedAt: NOW2.toISOString(),
      runway: { generatedAt: NOW2.toISOString(), horizonDays: 90, buckets, skipped },
    } as never;
  }

  it("inapplicable when the runway section is missing", () => {
    const ev = evaluateFundingRunway({ tag: "t", rule, report: { tag: "t" } as never, now: NOW2 });
    expect(ev.applicable).toBe(false);
    expect(ev.message).toMatch(/runway section missing/);
  });

  it("fires when the shortest runway is within thresholdDays", () => {
    const ev = evaluateFundingRunway({ tag: "t", rule, report: reportWith([bucket()]), now: NOW2 });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(true);
    expect(ev.message).toMatch(/USDC runs out in 4.0d/);
    expect(ev.value.runwayDays).toBe(4);
    expect(ev.value.firesCovered).toBe(3);
  });

  it("does not fire when the runway exceeds the threshold", () => {
    const ev = evaluateFundingRunway({
      tag: "t", rule,
      report: reportWith([bucket({ runwayDays: 30, exhaustsAt: "2026-07-10T00:00:00.000Z" })]),
      now: NOW2,
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(false);
    expect(ev.message).toMatch(/shortest runway 30.0d/);
  });

  it("survives-the-horizon buckets are applicable + ok", () => {
    const ev = evaluateFundingRunway({
      tag: "t", rule,
      report: reportWith([bucket({ runwayDays: null, exhaustsAt: null })]),
      now: NOW2,
    });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(false);
    expect(ev.message).toMatch(/survive the 90d horizon/);
  });

  it("unknown-balance buckets are skipped — a dead RPC must not page", () => {
    const ev = evaluateFundingRunway({
      tag: "t", rule,
      report: reportWith([bucket({ balance: null, runwayDays: 2 })]),
      now: NOW2,
    });
    expect(ev.applicable).toBe(false);
    expect(ev.message).toMatch(/no recurring spend|balances unknown/);
  });

  it("picks the SHORTEST runway across buckets", () => {
    const ev = evaluateFundingRunway({
      tag: "t", rule,
      report: reportWith([
        bucket({ token: "0xa", symbol: "AAA", runwayDays: 20, exhaustsAt: "2026-06-30T00:00:00.000Z" }),
        bucket({ token: "0xb", symbol: "BBB", runwayDays: 3, exhaustsAt: "2026-06-13T00:00:00.000Z" }),
      ]),
      now: NOW2,
    });
    expect(ev.violated).toBe(true);
    expect(ev.value.symbol).toBe("BBB");
  });

  it("sectionsForRules maps funding_runway → runway section", () => {
    const needed = sectionsForRules([rule]);
    expect(needed.has("runway")).toBe(true);
  });
});

// ── funding_runway × gas buckets (v34.5) ────────────────────

describe("evaluateFundingRunway — gas buckets", () => {
  const rule = { type: "funding_runway", thresholdDays: 7 } as never;
  const NOW3 = new Date("2026-06-10T00:00:00Z");

  function reportWithGas(gas: unknown[], buckets: unknown[] = []) {
    return {
      tag: "t", mode: "real", window: "30d", generatedAt: NOW3.toISOString(),
      runway: { generatedAt: NOW3.toISOString(), horizonDays: 90, buckets, gas, skipped: [] },
    } as never;
  }

  const gasBucket = (over: Record<string, unknown> = {}) => ({
    account: "default", chain: "base",
    balance: 0.002, avgGasPerFire: 0.001, gasSamples: 40,
    totalFiresInHorizon: 10, oneShotOrders: 0, firesCovered: 2,
    exhaustsAt: "2026-06-14T00:00:00.000Z", runwayDays: 4,
    ...over,
  });

  it("a gas bucket inside the threshold fires the rule", () => {
    const ev = evaluateFundingRunway({ tag: "t", rule, report: reportWithGas([gasBucket()]), now: NOW3 });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(true);
    expect(ev.message).toMatch(/gas \(base\) runs out in 4.0d/);
    expect(ev.value.kind).toBe("gas");
  });

  it("a no-estimate gas bucket never pages (no guess)", () => {
    const ev = evaluateFundingRunway({
      tag: "t", rule,
      report: reportWithGas([gasBucket({ avgGasPerFire: null, runwayDays: 2 })]),
      now: NOW3,
    });
    expect(ev.applicable).toBe(false);
  });

  it("the shortest fuse wins across token AND gas candidates", () => {
    const tokenBucket = {
      account: "default", chain: "base", paper: false,
      token: "0xusdc", symbol: "USDC",
      balance: 300, oneShotReserved: 0, burn30d: 400,
      totalFiresInHorizon: 8, firesCovered: 6,
      exhaustsAt: "2026-06-30T00:00:00.000Z", runwayDays: 20,
      obligations: [],
    };
    const ev = evaluateFundingRunway({
      tag: "t", rule,
      report: reportWithGas([gasBucket()], [tokenBucket]),
      now: NOW3,
    });
    expect(ev.violated).toBe(true);
    expect(ev.value.kind).toBe("gas"); // 4d < 20d
  });
});

// ── v37: dry-run ─────────────────────────────────────────────

describe("runAlertTick — dry-run", () => {
  it("counts would-be fires with ZERO side effects (no notify, no state, no journal, no breaker)", async () => {
    seedBreakerFixture2("dry-test");
    const { getOrderById, listAlertEvents: lae } = await import("./db.js");
    const config = baseConfig({
      enabled: true,
      rules: [{ type: "slippage_trend", baselineBps: 50, alertMultiplier: 1.5, minSampleSize: 5, action: "pause" } as never],
    });
    const notifyFn = vi.fn();
    const dry = await runAlertTick({
      config: config as never, logger: silentLogger(), notifyFn, onlyTags: ["dry-test"], dryRun: true,
    });
    expect(dry.fired).toBe(1); // the would-be fire is visible…
    expect(notifyFn).not.toHaveBeenCalled(); // …but nothing was sent
    expect(getStrategyAlertState("dry-test", "slippage_trend")).toBeNull(); // no state row
    expect(lae({ tag: "dry-test" })).toHaveLength(0); // no journal
    expect(dry.breakers).toHaveLength(0); // breaker never engaged
    // The armed order is still ACTIVE — pause never ran.
    const orders = (await import("./db.js")).listOrders({ status: "active", strategy: "dry-test" });
    expect(orders).toHaveLength(1);

    // The REAL run afterwards still sees the fresh ok→active edge.
    const real = await runAlertTick({
      config: config as never, logger: silentLogger(), notifyFn, onlyTags: ["dry-test"],
    });
    expect(real.fired).toBe(1);
    expect(notifyFn).toHaveBeenCalled();
  });

  function seedBreakerFixture2(tag: string) {
    const ETH2 = "0x4200000000000000000000000000000000000006";
    const USDC2 = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    insertOrder({
      side: "sell", trigger_type: "price_below", target_price_usd: 1900, trail_pct: null,
      chain: "base", account: "default",
      base_token: ETH2, base_symbol: "ETH", quote_token: USDC2, quote_symbol: "USDC",
      base_amount: "1", quote_amount: null, slippage_bps: 50, auto_slippage: false,
      expires_at: null, strategy: tag, note: null, group_id: null,
    });
    for (let i = 0; i < 6; i++) {
      insertTrade({
        timestamp: `2026-05-${20 + i}T00:00:00Z`,
        chain: "base", account: "default", direction: "buy",
        base_token: ETH2, base_symbol: "ETH", base_amount: "0.1",
        quote_token: USDC2, quote_symbol: "USDC", quote_amount: "250",
        price: "2500", tx_hash: `0xdry${i}`, status: "success",
        gas_used: null, gas_price_wei: null, gas_cost_native: null,
        aggregator: "kyberswap", fee_tier: null, notes: null,
        strategy: tag, realized_slippage_bps: 200,
      });
    }
  }
});

// ── position_cap_approach (v38) ──────────────────────────────

describe("evaluatePositionCapApproach", () => {
  const rule = { type: "position_cap_approach", warnPct: 0.8 } as never;
  const NOW4 = new Date("2026-06-11T00:00:00Z");

  function reportWithCaps(positionCaps: unknown[]) {
    return {
      tag: "t", mode: "paper", window: "30d", generatedAt: NOW4.toISOString(),
      risk: { budgets: [], drawdown: null, positionCaps },
    } as never;
  }
  const capUtil = (over: Record<string, unknown> = {}) => ({
    pattern: "t", token: "WETH",
    currentBaseAmount: 1.7, maxBaseAmount: 2, basePctUsed: 85,
    currentCostQuote: 3400, maxCostQuote: null, costPctUsed: null,
    ...over,
  });

  it("fires when the hottest cap utilization crosses warnPct", async () => {
    const { evaluatePositionCapApproach } = await import("./strategyAlerts.js");
    const ev = evaluatePositionCapApproach({ tag: "t", rule, report: reportWithCaps([capUtil()]), now: NOW4 });
    expect(ev.applicable).toBe(true);
    expect(ev.violated).toBe(true);
    expect(ev.message).toMatch(/WETH at 85% of its base cap/);
    expect(ev.value.axis).toBe("base");
  });

  it("cost axis competes for hottest", async () => {
    const { evaluatePositionCapApproach } = await import("./strategyAlerts.js");
    const ev = evaluatePositionCapApproach({
      tag: "t", rule,
      report: reportWithCaps([capUtil({ basePctUsed: 40, costPctUsed: 92, maxCostQuote: 5000 })]),
      now: NOW4,
    });
    expect(ev.violated).toBe(true);
    expect(ev.value.axis).toBe("cost");
    expect(ev.value.pctUsed).toBe(92);
  });

  it("below threshold → applicable, not violated; no caps → inapplicable", async () => {
    const { evaluatePositionCapApproach } = await import("./strategyAlerts.js");
    const ok2 = evaluatePositionCapApproach({
      tag: "t", rule, report: reportWithCaps([capUtil({ basePctUsed: 50 })]), now: NOW4,
    });
    expect(ok2.applicable).toBe(true);
    expect(ok2.violated).toBe(false);
    const none = evaluatePositionCapApproach({ tag: "t", rule, report: reportWithCaps([]), now: NOW4 });
    expect(none.applicable).toBe(false);
  });

  it("sectionsForRules maps it to risk", () => {
    expect(sectionsForRules([rule]).has("risk")).toBe(true);
  });
});
