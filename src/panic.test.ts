/**
 * Emergency-stop tests.
 *
 * Layers:
 *   1. executePanic — engine lock + pause-everything (tagged AND
 *      untagged), idempotent re-panic, cancel-orders variant,
 *      critical notification shape
 *   2. releasePanic — unlock-only default vs --resume-all
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-panic-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { executePanic, releasePanic } = await import("./panic.js");
const {
  openDb,
  closeDb,
  insertOrder,
  insertSchedule,
  insertRebalancePlan,
  getOrderById,
  getScheduleById,
  getRebalancePlanById,
} = await import("./db.js");
const { getEngineLockState, isEngineLockedFromRow } = await import("./engineLock.js");
const { loadConfig } = await import("./config.js");
import type { Logger } from "./logger.js";
import type { InsertOrderArgs, InsertScheduleArgs, InsertRebalancePlanArgs } from "./db.js";

const stubLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as unknown as Logger;

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
  db.exec("DELETE FROM orders; DELETE FROM schedules; DELETE FROM rebalance_plans; DELETE FROM engine_lock");
});

function seedOrder(over: Partial<InsertOrderArgs> = {}): number {
  return insertOrder({
    side: "buy", trigger_type: "price_below", target_price_usd: 1800, trail_pct: null,
    chain: "base", account: "default",
    base_token: WETH, base_symbol: "WETH", quote_token: USDC, quote_symbol: "USDC",
    base_amount: null, quote_amount: "100",
    slippage_bps: 50, auto_slippage: false, expires_at: null,
    strategy: null, note: null, group_id: null, paper: true,
    ...over,
  });
}

function seedSchedule(over: Partial<InsertScheduleArgs> = {}): number {
  return insertSchedule({
    name: "dca", cron_expr: "0 */6 * * *", next_run_at: PAST,
    side: "buy", chain: "base", account: "default",
    base_token: WETH, base_symbol: "WETH", quote_token: USDC, quote_symbol: "USDC",
    base_amount: null, quote_amount: "100",
    slippage_bps: 50, auto_slippage: false,
    start_at: null, end_at: null, max_runs: null,
    strategy: "playbook:1", note: null, paper: true,
    ...over,
  });
}

function seedPlan(over: Partial<InsertRebalancePlanArgs> = {}): number {
  return insertRebalancePlan({
    name: "folio", account: "default", chain: "base",
    quote_token: USDC, quote_symbol: "USDC",
    targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }],
    drift_threshold_pct: 5, min_trade_usd: 10,
    cron_expr: "0 */6 * * *", next_run_at: PAST,
    start_at: null, end_at: null, max_runs: null,
    slippage_bps: 50, auto_slippage: false, strategy: null, note: null,
    ...over,
  });
}

describe("executePanic", () => {
  it("locks the engine and pauses EVERYTHING active — tagged and untagged", async () => {
    const o1 = seedOrder({ strategy: null });          // untagged — strategy pause can't reach it
    const o2 = seedOrder({ strategy: "playbook:7" });
    const s1 = seedSchedule();
    const r1 = seedPlan();
    const notifyFn = vi.fn();
    const report = await executePanic({ reason: "compromised key suspicion", config: loadConfig(), logger: stubLogger, notifyFn });

    expect(isEngineLockedFromRow(getEngineLockState())).toBe(true);
    expect(getEngineLockState().reason).toMatch(/PANIC: compromised key suspicion/);
    expect(report.paused.orders.sort()).toEqual([o1, o2].sort());
    expect(report.paused.schedules).toEqual([s1]);
    expect(report.paused.rebalances).toEqual([r1]);
    expect(report.totalStopped).toBe(4);
    expect(report.cancelledOrders).toEqual([]);

    expect(getOrderById(o1)?.status).toBe("paused");
    expect(getScheduleById(s1)?.status).toBe("paused");
    expect(getRebalancePlanById(r1)?.status).toBe("paused");

    // Critical notification with the counts.
    const evt = notifyFn.mock.calls.find((c) => c[0].event === "engine.panic")?.[0];
    expect(evt).toBeDefined();
    expect(evt.severity).toBe("critical");
    expect(evt.fields.ordersPaused).toBe(2);
  });

  it("re-panic is idempotent and reports alreadyLocked", async () => {
    seedOrder();
    const cfg = loadConfig();
    const first = await executePanic({ config: cfg, logger: stubLogger, notifyFn: vi.fn() });
    expect(first.alreadyLocked).toBe(false);
    const second = await executePanic({ config: cfg, logger: stubLogger, notifyFn: vi.fn() });
    expect(second.alreadyLocked).toBe(true);
    expect(second.totalStopped).toBe(0); // everything already paused
  });

  it("cancelOrders cancels orders (terminal) while schedules/rebalance still pause", async () => {
    const o = seedOrder();
    const s = seedSchedule();
    const report = await executePanic({ cancelOrders: true, config: loadConfig(), logger: stubLogger, notifyFn: vi.fn() });
    expect(report.cancelledOrders).toEqual([o]);
    expect(report.paused.orders).toEqual([]);
    expect(getOrderById(o)?.status).toBe("cancelled");
    expect(getScheduleById(s)?.status).toBe("paused");
  });
});

describe("releasePanic", () => {
  it("default release unlocks but leaves everything paused", async () => {
    const o = seedOrder();
    const cfg = loadConfig();
    await executePanic({ config: cfg, logger: stubLogger, notifyFn: vi.fn() });
    const report = await releasePanic({ config: cfg, logger: stubLogger, notifyFn: vi.fn() });
    expect(report.unlocked).toBe(true);
    expect(isEngineLockedFromRow(getEngineLockState())).toBe(false);
    expect(getOrderById(o)?.status).toBe("paused"); // selective resume is the operator's job
    expect(report.resumed.orders).toEqual([]);
  });

  it("--resume-all resumes everything and recomputes schedule slots", async () => {
    const o = seedOrder();
    const s = seedSchedule();
    const r = seedPlan();
    const cfg = loadConfig();
    await executePanic({ config: cfg, logger: stubLogger, notifyFn: vi.fn() });
    const report = await releasePanic({ resumeAll: true, config: cfg, logger: stubLogger, notifyFn: vi.fn() });
    expect(report.resumed.orders).toEqual([o]);
    expect(report.resumed.schedules).toEqual([s]);
    expect(report.resumed.rebalances).toEqual([r]);
    expect(getOrderById(o)?.status).toBe("active");
    const sched = getScheduleById(s)!;
    expect(sched.status).toBe("active");
    // next_run_at recomputed from now (skip, don't backfill) — the
    // stale PAST slot is gone.
    expect(Date.parse(sched.next_run_at)).toBeGreaterThan(Date.now());
  });
});
