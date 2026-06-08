// Tests for bulkOps.ts (iter37). Two layers:
//
//   1. planHalt/planResume — pure DB read + classification. Tests
//      assert the resulting plan's shape: which actions get
//      cancel/pause/resume/skip, the summary counts, the filter
//      requirement.
//
//   2. executeHalt/executeResume — end-to-end against a seeded DB.
//      Asserts post-state of every row + that errors are
//      collected (not thrown), and that partial failures don't
//      undo the successful operations.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-bulk-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  planHalt,
  executeHalt,
  planResume,
  executeResume,
} = await import("./bulkOps.js");
const {
  openDb,
  closeDb,
  insertOrder,
  insertSchedule,
  insertRebalancePlan,
  getOrderById,
  getScheduleById,
  getRebalancePlanById,
  markOrderFilled,
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
});

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function seedOrder(over: Record<string, unknown> = {}): number {
  return insertOrder({
    side: "sell",
    trigger_type: "price_below",
    target_price_usd: 1900,
    trail_pct: null,
    chain: "base",
    account: "default",
    base_token: WETH,
    base_symbol: "ETH",
    quote_token: USDC,
    quote_symbol: "USDC",
    base_amount: "1",
    quote_amount: null,
    slippage_bps: 50,
    auto_slippage: false,
    expires_at: null,
    strategy: "dca-eth",
    note: null,
    group_id: null,
    ...over,
  });
}

function seedSchedule(over: Record<string, unknown> = {}): number {
  return insertSchedule({
    name: "dca-test",
    cron_expr: "0 10 * * *",
    next_run_at: "2026-06-01T10:00:00Z",
    side: "buy",
    chain: "base",
    account: "default",
    base_token: WETH,
    base_symbol: "ETH",
    quote_token: USDC,
    quote_symbol: "USDC",
    base_amount: null,
    quote_amount: "100",
    slippage_bps: 50,
    auto_slippage: false,
    start_at: null,
    end_at: null,
    max_runs: null,
    strategy: "dca-eth",
    note: null,
    ...over,
  });
}

function seedRebalance(over: Record<string, unknown> = {}): number {
  return insertRebalancePlan({
    name: "rebal-q1",
    account: "default",
    chain: "base",
    quote_token: USDC,
    quote_symbol: "USDC",
    targets: [{ token: WETH, targetPct: 50 }],
    drift_threshold_pct: 5,
    min_trade_usd: 10,
    cron_expr: "0 12 * * 1",
    next_run_at: "2026-06-01T12:00:00Z",
    start_at: null,
    end_at: null,
    max_runs: null,
    slippage_bps: 50,
    auto_slippage: false,
    strategy: "dca-eth",
    note: null,
    ...over,
  });
}

// ── filter validation ──────────────────────────────────────

describe("planHalt — filter validation", () => {
  it("rejects unscoped halt without --all", () => {
    expect(() => planHalt({})).toThrow(/requires at least one of/);
  });

  it("accepts unscoped halt with --all", () => {
    expect(() => planHalt({ all: true })).not.toThrow();
  });

  it("accepts a single filter", () => {
    expect(() => planHalt({ strategy: "x" })).not.toThrow();
    expect(() => planHalt({ chain: "base" })).not.toThrow();
    expect(() => planHalt({ account: "alice" })).not.toThrow();
  });
});

describe("planResume — filter validation", () => {
  it("rejects 'orders' in types", () => {
    expect(() => planResume({ strategy: "x", types: ["orders"] })).toThrow(/cannot include 'orders'/);
  });
});

// ── plan classification ────────────────────────────────────

describe("planHalt — classification", () => {
  it("classifies an active order as cancel", () => {
    const id = seedOrder();
    const plan = planHalt({ strategy: "dca-eth" });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ type: "order", id, operation: "cancel", currentStatus: "active" });
    expect(plan.summary.byType.orders.wouldCancel).toBe(1);
  });

  it("classifies a filled order as skip with reason", () => {
    const id = seedOrder();
    markOrderFilled(id, { tx_hash: "0xabc", fill_price: 1900, base_amount: "1", quote_amount: "1900" });
    const plan = planHalt({ strategy: "dca-eth" });
    expect(plan.actions[0]).toMatchObject({ operation: "skip", currentStatus: "filled" });
    expect(plan.actions[0].reason).toMatch(/already filled/);
    expect(plan.summary.byType.orders.skipped).toBe(1);
    expect(plan.summary.wouldAffect).toBe(0);
  });

  it("classifies an active schedule as pause", () => {
    const id = seedSchedule();
    const plan = planHalt({ strategy: "dca-eth" });
    expect(plan.actions[0]).toMatchObject({ type: "schedule", id, operation: "pause" });
    expect(plan.summary.byType.schedules.wouldPause).toBe(1);
  });

  it("classifies an already-paused schedule as skip", () => {
    const id = seedSchedule();
    const db = openDb();
    db.prepare(`UPDATE schedules SET status = 'paused' WHERE id = ?`).run(id);
    const plan = planHalt({ strategy: "dca-eth" });
    expect(plan.actions[0].operation).toBe("skip");
    expect(plan.actions[0].reason).toMatch(/already paused/);
  });

  it("classifies an active rebalance as pause", () => {
    seedRebalance();
    const plan = planHalt({ strategy: "dca-eth" });
    expect(plan.actions[0]).toMatchObject({ type: "rebalance", operation: "pause" });
  });

  it("respects --types filter", () => {
    seedOrder();
    seedSchedule();
    seedRebalance();
    const plan = planHalt({ strategy: "dca-eth", types: ["schedules"] });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe("schedule");
  });

  it("combines multiple primitive types in one plan", () => {
    seedOrder();
    seedSchedule();
    seedRebalance();
    const plan = planHalt({ strategy: "dca-eth" });
    expect(plan.actions).toHaveLength(3);
    expect(plan.summary.wouldAffect).toBe(3);
  });

  it("narrows scope by chain", () => {
    seedOrder({ chain: "base" });
    seedOrder({ chain: "arbitrum" });
    const plan = planHalt({ chain: "base" });
    expect(plan.actions).toHaveLength(1);
  });

  it("narrows scope by account", () => {
    seedOrder({ account: "alice" });
    seedOrder({ account: "bob" });
    const plan = planHalt({ account: "alice" });
    expect(plan.actions).toHaveLength(1);
  });

  it("normalizes chain filter to lowercase", () => {
    seedOrder({ chain: "base" });
    const plan = planHalt({ chain: "BASE" });
    expect(plan.actions).toHaveLength(1);
  });

  it("summary.skippedReasons aggregates per reason", () => {
    const a = seedOrder();
    markOrderFilled(a, { tx_hash: "0xa", fill_price: 1900, base_amount: "1", quote_amount: "1900" });
    const b = seedOrder();
    markOrderFilled(b, { tx_hash: "0xb", fill_price: 1900, base_amount: "1", quote_amount: "1900" });
    const plan = planHalt({ strategy: "dca-eth" });
    expect(plan.summary.skippedReasons["already filled"]).toBe(2);
  });

  it("--all halts every primitive globally", () => {
    seedOrder({ strategy: "s1", chain: "base" });
    seedOrder({ strategy: "s2", chain: "arbitrum" });
    seedOrder({ strategy: "s3", account: "alice" });
    const plan = planHalt({ all: true });
    expect(plan.actions).toHaveLength(3);
    expect(plan.summary.wouldAffect).toBe(3);
  });
});

// ── plan: resume ───────────────────────────────────────────

describe("planResume — classification", () => {
  it("resumes a paused schedule", () => {
    const id = seedSchedule();
    const db = openDb();
    db.prepare(`UPDATE schedules SET status = 'paused' WHERE id = ?`).run(id);
    const plan = planResume({ strategy: "dca-eth" });
    expect(plan.actions[0]).toMatchObject({ operation: "resume", currentStatus: "paused" });
  });

  it("skips an active schedule with clear reason", () => {
    seedSchedule();
    const plan = planResume({ strategy: "dca-eth" });
    expect(plan.actions[0].operation).toBe("skip");
    expect(plan.actions[0].reason).toMatch(/not paused/);
  });

  it("resumes paused rebalances", () => {
    const id = seedRebalance();
    const db = openDb();
    db.prepare(`UPDATE rebalance_plans SET status = 'paused' WHERE id = ?`).run(id);
    const plan = planResume({ strategy: "dca-eth" });
    expect(plan.actions[0]).toMatchObject({ type: "rebalance", operation: "resume" });
  });
});

// ── executeHalt ────────────────────────────────────────────

describe("executeHalt — end-to-end", () => {
  it("cancels active orders + pauses active schedules + pauses active rebalances in one shot", () => {
    const orderId = seedOrder();
    const schedId = seedSchedule();
    const rebalId = seedRebalance();
    const plan = planHalt({ strategy: "dca-eth" });
    const result = executeHalt(plan);
    expect(result.ok).toBe(true);
    expect(result.applied).toHaveLength(3);
    expect(getOrderById(orderId)?.status).toBe("cancelled");
    expect(getScheduleById(schedId)?.status).toBe("paused");
    expect(getRebalancePlanById(rebalId)?.status).toBe("paused");
  });

  it("skips already-terminal rows without erroring", () => {
    const orderId = seedOrder();
    markOrderFilled(orderId, { tx_hash: "0x", fill_price: 1900, base_amount: "1", quote_amount: "1900" });
    const plan = planHalt({ strategy: "dca-eth" });
    const result = executeHalt(plan);
    expect(result.ok).toBe(true);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(getOrderById(orderId)?.status).toBe("filled"); // unchanged
  });

  it("collects per-row errors without aborting the batch", () => {
    seedOrder();
    seedSchedule();
    const plan = planHalt({ strategy: "dca-eth" });
    // Mutate the plan to include a NON-EXISTENT id for one of the
    // rows so cancelOrderById throws. The rest of the batch should
    // still apply.
    plan.actions.push({
      type: "order",
      id: 999_999,
      operation: "cancel",
      currentStatus: "active",
      reason: "fabricated for test",
      summary: "fake",
    });
    const result = executeHalt(plan);
    expect(result.applied.length).toBeGreaterThanOrEqual(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].id).toBe(999_999);
    expect(result.ok).toBe(false);
  });

  it("multi-strategy + per-strategy halt: only matching strategy is touched", async () => {
    seedOrder({ strategy: "dca-eth" });
    seedOrder({ strategy: "swing-btc" });
    const plan = planHalt({ strategy: "dca-eth" });
    const result = executeHalt(plan);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].type).toBe("order");
    // The swing-btc order should NOT have been touched.
    const swing = (await import("./db.js")).listOrders({});
    expect(swing.some((o) => o.strategy === "swing-btc" && o.status === "active")).toBe(true);
  });

  it("--types orders only cancels orders (schedules + rebalances untouched)", () => {
    seedOrder();
    const schedId = seedSchedule();
    const rebalId = seedRebalance();
    const plan = planHalt({ strategy: "dca-eth", types: ["orders"] });
    executeHalt(plan);
    expect(getScheduleById(schedId)?.status).toBe("active");
    expect(getRebalancePlanById(rebalId)?.status).toBe("active");
  });
});

describe("executeResume — end-to-end", () => {
  it("resumes paused schedules + rebalances", () => {
    const db = openDb();
    const schedId = seedSchedule();
    db.prepare(`UPDATE schedules SET status = 'paused' WHERE id = ?`).run(schedId);
    const rebalId = seedRebalance();
    db.prepare(`UPDATE rebalance_plans SET status = 'paused' WHERE id = ?`).run(rebalId);

    const plan = planResume({ strategy: "dca-eth" });
    const result = executeResume(plan);
    expect(result.ok).toBe(true);
    expect(result.applied).toHaveLength(2);
    expect(getScheduleById(schedId)?.status).toBe("active");
    expect(getRebalancePlanById(rebalId)?.status).toBe("active");
  });

  it("skips already-active rows", () => {
    seedSchedule(); // status=active
    const plan = planResume({ strategy: "dca-eth" });
    const result = executeResume(plan);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });
});

// ── idempotency ────────────────────────────────────────────

describe("idempotency", () => {
  it("running halt twice is a safe no-op the second time", () => {
    seedOrder();
    seedSchedule();
    const first = executeHalt(planHalt({ strategy: "dca-eth" }));
    expect(first.applied).toHaveLength(2);

    // Second run sees both rows as already-terminal / already-paused.
    const second = executeHalt(planHalt({ strategy: "dca-eth" }));
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toHaveLength(2);
  });
});
