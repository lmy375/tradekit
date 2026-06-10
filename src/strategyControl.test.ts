/**
 * Strategy-level bulk pause/resume tests.
 *
 * Layers:
 *   1. pauseStrategyPrimitives — pauses every ACTIVE primitive owned
 *      by the tag across all three kinds; tag isolation; idempotence
 *   2. resumeStrategyPrimitives — resumes only PAUSED rows; schedule
 *      + rebalance next_run_at recompute; blanket-by-tag semantics
 *   3. order pause/resume primitives (db + wrapper guards)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-strategyControl-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  pauseStrategyPrimitives,
  resumeStrategyPrimitives,
  strategyPrimitiveCounts,
} = await import("./strategyControl.js");
const {
  openDb,
  closeDb,
  insertOrder,
  insertSchedule,
  insertRebalancePlan,
  getOrderById,
  getScheduleById,
  getRebalancePlanById,
  pauseOrder,
  resumeOrder,
} = await import("./db.js");
import type { InsertOrderArgs, InsertScheduleArgs, InsertRebalancePlanArgs } from "./db.js";
const { pauseOrderById, resumeOrderById } = await import("./orders.js");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAST = "2026-01-01T00:00:00.000Z";

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM orders; DELETE FROM schedules; DELETE FROM rebalance_plans");
});

function seedOrder(over: Partial<InsertOrderArgs> = {}): number {
  return insertOrder({
    side: "buy",
    trigger_type: "price_below",
    target_price_usd: 2100,
    trail_pct: null,
    chain: "base",
    account: "default",
    base_token: WETH,
    base_symbol: "WETH",
    quote_token: USDC,
    quote_symbol: "USDC",
    base_amount: null,
    quote_amount: "100",
    slippage_bps: 50,
    auto_slippage: false,
    expires_at: null,
    strategy: "playbook:7",
    note: null,
    group_id: null,
    paper: true,
    ...over,
  });
}

function seedSchedule(over: Partial<InsertScheduleArgs> = {}): number {
  return insertSchedule({
    name: "dca-test",
    cron_expr: "0 */6 * * *",
    next_run_at: PAST,
    side: "buy",
    chain: "base",
    account: "default",
    base_token: WETH,
    base_symbol: "WETH",
    quote_token: USDC,
    quote_symbol: "USDC",
    base_amount: null,
    quote_amount: "100",
    slippage_bps: 50,
    auto_slippage: false,
    start_at: null,
    end_at: null,
    max_runs: null,
    strategy: "playbook:7",
    note: null,
    paper: true,
    ...over,
  });
}

function seedPlan(over: Partial<InsertRebalancePlanArgs> = {}): number {
  return insertRebalancePlan({
    name: "folio",
    account: "default",
    chain: "base",
    quote_token: USDC,
    quote_symbol: "USDC",
    targets: [
      { token: "ETH", targetPct: 60 },
      { token: "USDC", targetPct: 40 },
    ],
    drift_threshold_pct: 5,
    min_trade_usd: 10,
    cron_expr: "0 */6 * * *",
    next_run_at: PAST,
    start_at: null,
    end_at: null,
    max_runs: null,
    slippage_bps: 50,
    auto_slippage: false,
    strategy: "playbook:7",
    note: null,
    ...over,
  });
}

// ── pauseStrategyPrimitives ─────────────────────────────────

describe("pauseStrategyPrimitives", () => {
  it("pauses every active primitive owned by the tag, across all three kinds", () => {
    const o1 = seedOrder();
    const o2 = seedOrder();
    const s1 = seedSchedule();
    const r1 = seedPlan();

    const result = pauseStrategyPrimitives("playbook:7");
    expect(result.action).toBe("pause");
    expect(result.orders.sort()).toEqual([o1, o2].sort());
    expect(result.schedules).toEqual([s1]);
    expect(result.rebalances).toEqual([r1]);
    expect(result.total).toBe(4);

    expect(getOrderById(o1)?.status).toBe("paused");
    expect(getOrderById(o2)?.status).toBe("paused");
    expect(getScheduleById(s1)?.status).toBe("paused");
    expect(getRebalancePlanById(r1)?.status).toBe("paused");
  });

  it("tag isolation — other strategies' primitives are untouched", () => {
    const mine = seedOrder({ strategy: "playbook:7" });
    const theirs = seedOrder({ strategy: "playbook:8" });
    const untagged = seedOrder({ strategy: null });

    const result = pauseStrategyPrimitives("playbook:7");
    expect(result.orders).toEqual([mine]);
    expect(getOrderById(theirs)?.status).toBe("active");
    expect(getOrderById(untagged)?.status).toBe("active");
  });

  it("terminal + already-paused rows are skipped (idempotent re-pause)", () => {
    const filled = seedOrder();
    openDb().prepare(`UPDATE orders SET status = 'filled' WHERE id = ?`).run(filled);
    const active = seedOrder();

    const first = pauseStrategyPrimitives("playbook:7");
    expect(first.orders).toEqual([active]);
    expect(first.total).toBe(1);

    const second = pauseStrategyPrimitives("playbook:7");
    expect(second.total).toBe(0);
    expect(second.skipped).toBe(1); // the now-paused order
    expect(getOrderById(filled)?.status).toBe("filled"); // terminal stays
  });

  it("rejects an empty tag", () => {
    expect(() => pauseStrategyPrimitives("")).toThrow(/non-empty/);
  });
});

// ── resumeStrategyPrimitives ────────────────────────────────

describe("resumeStrategyPrimitives", () => {
  it("resumes paused primitives and recomputes schedule/rebalance next_run_at from now", () => {
    const o1 = seedOrder();
    const s1 = seedSchedule();
    const r1 = seedPlan();
    pauseStrategyPrimitives("playbook:7");

    const now = new Date("2026-06-10T01:00:00.000Z");
    const result = resumeStrategyPrimitives("playbook:7", now);
    expect(result.total).toBe(3);
    expect(result.orders).toEqual([o1]);

    expect(getOrderById(o1)?.status).toBe("active");
    const sched = getScheduleById(s1)!;
    expect(sched.status).toBe("active");
    // "skip, don't backfill": next_run_at moved off the stale PAST
    // value onto the next natural cron slot after `now`.
    expect(sched.next_run_at! > now.toISOString()).toBe(true);
    const plan = getRebalancePlanById(r1)!;
    expect(plan.status).toBe("active");
    expect(plan.next_run_at! > now.toISOString()).toBe(true);
  });

  it("active rows are skipped, not errored (blanket resume is idempotent)", () => {
    const o1 = seedOrder();
    const result = resumeStrategyPrimitives("playbook:7");
    expect(result.total).toBe(0);
    expect(result.skipped).toBe(1);
    expect(getOrderById(o1)?.status).toBe("active");
  });
});

// ── strategyPrimitiveCounts ─────────────────────────────────

describe("strategyPrimitiveCounts", () => {
  it("reports active/paused per kind", () => {
    seedOrder();
    const paused = seedOrder();
    pauseOrder(paused);
    seedSchedule();

    const counts = strategyPrimitiveCounts("playbook:7");
    expect(counts.active).toEqual({ orders: 1, schedules: 1, rebalances: 0 });
    expect(counts.paused).toEqual({ orders: 1, schedules: 0, rebalances: 0 });
  });
});

// ── order pause/resume primitives ───────────────────────────

describe("order pause/resume — db + wrapper guards", () => {
  it("pauseOrder: active → paused; resumeOrder: paused → active", () => {
    const id = seedOrder();
    expect(pauseOrder(id)).toBe(1);
    expect(getOrderById(id)?.status).toBe("paused");
    expect(resumeOrder(id)).toBe(1);
    expect(getOrderById(id)?.status).toBe("active");
  });

  it("status guards return -1 on wrong-state transitions", () => {
    const id = seedOrder();
    expect(resumeOrder(id)).toBe(-1); // active can't resume
    pauseOrder(id);
    expect(pauseOrder(id)).toBe(-1); // paused can't re-pause
    expect(pauseOrder(99999)).toBe(0); // not found
  });

  it("pauseOrderById/resumeOrderById throw structured errors on bad transitions", () => {
    const id = seedOrder();
    expect(() => resumeOrderById(id)).toThrow(/only paused orders/);
    const row = pauseOrderById(id);
    expect(row.status).toBe("paused");
    expect(() => pauseOrderById(id)).toThrow(/only active orders/);
    expect(() => pauseOrderById(99999)).toThrow(/not found/);
  });

  it("a filled order can be neither paused nor resumed", () => {
    const id = seedOrder();
    openDb().prepare(`UPDATE orders SET status = 'filled' WHERE id = ?`).run(id);
    expect(() => pauseOrderById(id)).toThrow(/is filled/);
    expect(() => resumeOrderById(id)).toThrow(/is filled/);
  });
});
