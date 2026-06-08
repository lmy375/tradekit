// Tests for the metrics module. Two layers:
//   1) Pure formatting: label escaping, sample formatting, full
//      Prometheus text output. No DB involvement.
//   2) Snapshot collection: populate a test DB + engine status file,
//      assert that gatherMetricsSnapshot() returns the expected families
//      with the expected sample counts + labels.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-metrics-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  escapeLabelValue,
  formatSample,
  formatPrometheus,
  gatherMetricsSnapshot,
  renderMetricsResponse,
} = await import("./metrics.js");
const {
  insertOrder,
  insertSchedule,
  insertRebalancePlan,
  insertTrade,
  insertAudit,
  markOrderFilled,
  markOrderFailed,
  markOrderExpired,
  cancelOrder: dbCancelOrder,
  pauseSchedule: dbPauseSchedule,
  pauseRebalancePlan,
  openDb,
  closeDb,
} = await import("./db.js");
import type { RebalanceTarget } from "./db.js";
import { ENGINE_STATUS_FILE } from "./engine.js";

beforeAll(() => {
  openDb();
});

afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset every table the metrics surface reads. Keeps assertions
  // deterministic across tests.
  const db = openDb();
  db.exec("DELETE FROM orders");
  db.exec("DELETE FROM schedules");
  db.exec("DELETE FROM rebalance_plans");
  db.exec("DELETE FROM trades");
  db.exec("DELETE FROM audit_log");
  // Also clear the engine status file if one was written by a prior test.
  try {
    rmSync(ENGINE_STATUS_FILE, { force: true });
  } catch {
    /* ignore */
  }
});

// ── pure formatting ─────────────────────────────────────────

describe("escapeLabelValue", () => {
  it("escapes backslash + double-quote + newline per the spec", () => {
    expect(escapeLabelValue("hello")).toBe("hello");
    expect(escapeLabelValue('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeLabelValue("line1\nline2")).toBe("line1\\nline2");
    expect(escapeLabelValue("path\\to\\file")).toBe("path\\\\to\\\\file");
    expect(escapeLabelValue('mix\\of"all\nthree')).toBe('mix\\\\of\\"all\\nthree');
  });
});

describe("formatSample", () => {
  it("unlabeled sample renders as 'name value'", () => {
    expect(formatSample({ name: "x", labels: {}, value: 42 })).toBe("x 42");
  });

  it("labeled sample renders as 'name{k=\"v\",...} value'", () => {
    expect(
      formatSample({ name: "x", labels: { a: "1", b: "two" }, value: 7 }),
    ).toBe('x{a="1",b="two"} 7');
  });

  it("numeric label values are stringified", () => {
    expect(formatSample({ name: "x", labels: { count: 3 }, value: 1 })).toBe('x{count="3"} 1');
  });

  it("non-finite values clamp to 0 (output stays well-formed)", () => {
    expect(formatSample({ name: "x", labels: {}, value: Number.NaN })).toBe("x 0");
    expect(formatSample({ name: "x", labels: {}, value: Number.POSITIVE_INFINITY })).toBe("x 0");
    expect(formatSample({ name: "x", labels: {}, value: Number.NEGATIVE_INFINITY })).toBe("x 0");
  });

  it("label values with metacharacters are escaped", () => {
    expect(
      formatSample({ name: "x", labels: { msg: 'say "hi"' }, value: 1 }),
    ).toBe('x{msg="say \\"hi\\""} 1');
  });
});

describe("formatPrometheus", () => {
  it("emits well-formed text: # HELP, # TYPE, samples, trailing newline", () => {
    const out = formatPrometheus({
      timestamp: "2026-05-30T12:00:00Z",
      elapsedMs: 1,
      families: [
        {
          name: "test_total",
          help: "A test counter",
          type: "counter",
          samples: [
            { name: "test_total", labels: { status: "ok" }, value: 5 },
            { name: "test_total", labels: { status: "fail" }, value: 1 },
          ],
        },
      ],
    });
    expect(out).toContain("# HELP test_total A test counter");
    expect(out).toContain("# TYPE test_total counter");
    expect(out).toContain('test_total{status="ok"} 5');
    expect(out).toContain('test_total{status="fail"} 1');
    expect(out.endsWith("\n")).toBe(true);
  });

  it("info type renders as 'gauge' for compatibility with strict scrapers", () => {
    const out = formatPrometheus({
      timestamp: "x",
      elapsedMs: 0,
      families: [
        {
          name: "build_info",
          help: "build info",
          type: "info",
          samples: [{ name: "build_info", labels: { version: "1.0" }, value: 1 }],
        },
      ],
    });
    expect(out).toContain("# TYPE build_info gauge");
    expect(out).not.toContain("# TYPE build_info info");
  });

  it("families are sorted by name (deterministic output)", () => {
    const out = formatPrometheus({
      timestamp: "x",
      elapsedMs: 0,
      families: [
        { name: "zzz", help: "z", type: "counter", samples: [{ name: "zzz", labels: {}, value: 0 }] },
        { name: "aaa", help: "a", type: "counter", samples: [{ name: "aaa", labels: {}, value: 0 }] },
      ],
    });
    const aaaIdx = out.indexOf("# HELP aaa");
    const zzzIdx = out.indexOf("# HELP zzz");
    expect(aaaIdx).toBeGreaterThanOrEqual(0);
    expect(zzzIdx).toBeGreaterThan(aaaIdx);
  });
});

// ── snapshot collection ────────────────────────────────────

describe("gatherMetricsSnapshot — populated DB", () => {
  // Helper fixtures matching the existing orders/schedules/etc. tests.
  function tradeFixture(overrides: Partial<Parameters<typeof insertTrade>[0]> = {}) {
    return {
      timestamp: new Date().toISOString(),
      chain: "base",
      account: "main",
      direction: "buy" as const,
      base_token: "0x4200000000000000000000000000000000000006",
      base_symbol: "WETH",
      base_amount: "0.05",
      quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      quote_symbol: "USDC",
      quote_amount: "100",
      price: "2000",
      tx_hash: "0x" + Math.random().toString(16).slice(2).padStart(64, "0"),
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      ...overrides,
    };
  }
  function orderFixture(overrides: Partial<Parameters<typeof insertOrder>[0]> = {}) {
    return {
      side: "buy" as const,
      trigger_type: "price_below" as const,
      target_price_usd: 3000,
      chain: "base",
      account: "main",
      base_token: "0x4200000000000000000000000000000000000006",
      base_symbol: "WETH",
      quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      quote_symbol: "USDC",
      base_amount: null,
      quote_amount: "100",
      slippage_bps: 50,
      auto_slippage: false,
      expires_at: null,
      strategy: null,
      note: null,
      trail_pct: null,
      group_id: null,
      ...overrides,
    };
  }
  function scheduleFixture(overrides: Partial<Parameters<typeof insertSchedule>[0]> = {}) {
    return {
      name: "dca-eth",
      cron_expr: "0 10 * * 1",
      next_run_at: "2026-06-01T10:00:00.000Z",
      side: "buy" as const,
      chain: "base",
      account: "main",
      base_token: "0x4200000000000000000000000000000000000006",
      base_symbol: "WETH",
      quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      quote_symbol: "USDC",
      base_amount: null,
      quote_amount: "100",
      slippage_bps: 50,
      auto_slippage: false,
      start_at: null,
      end_at: null,
      max_runs: null,
      strategy: null,
      note: null,
      ...overrides,
    };
  }
  function planFixture(overrides: Partial<Parameters<typeof insertRebalancePlan>[0]> = {}) {
    return {
      name: "core",
      account: "main",
      chain: "base",
      quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      quote_symbol: "USDC",
      targets: [
        { token: "ETH", targetPct: 60 },
        { token: "USDC", targetPct: 40 },
      ] as RebalanceTarget[],
      drift_threshold_pct: 5,
      min_trade_usd: 10,
      cron_expr: "0 */6 * * *",
      next_run_at: "2026-06-01T00:00:00.000Z",
      start_at: null,
      end_at: null,
      max_runs: null,
      slippage_bps: null,
      auto_slippage: false,
      strategy: null,
      note: null,
      ...overrides,
    };
  }

  it("emits the info family with version + node", () => {
    const snap = gatherMetricsSnapshot();
    const info = snap.families.find((f) => f.name === "tradekit_build_info");
    expect(info).toBeDefined();
    expect(info!.type).toBe("info");
    expect(info!.samples.length).toBe(1);
    expect(info!.samples[0].labels).toMatchObject({ node: process.versions.node });
    expect(info!.samples[0].value).toBe(1);
  });

  it("trades counter labeled by chain + status", () => {
    insertTrade(tradeFixture({ chain: "base", status: "success" }));
    insertTrade(tradeFixture({ chain: "base", status: "success" }));
    insertTrade(tradeFixture({ chain: "arbitrum", status: "failed" }));
    insertTrade(tradeFixture({ chain: "base", status: "pending" }));

    const snap = gatherMetricsSnapshot();
    const trades = snap.families.find((f) => f.name === "tradekit_trades_total")!;
    const byKey = (chain: string, status: string) =>
      trades.samples.find((s) => s.labels.chain === chain && s.labels.status === status)?.value ?? 0;
    expect(byKey("base", "success")).toBe(2);
    expect(byKey("arbitrum", "failed")).toBe(1);
    expect(byKey("base", "pending")).toBe(1);
  });

  it("pending-trades gauge", () => {
    insertTrade(tradeFixture({ status: "pending" }));
    insertTrade(tradeFixture({ status: "pending" }));
    insertTrade(tradeFixture({ status: "success" }));
    const snap = gatherMetricsSnapshot();
    const pending = snap.families.find((f) => f.name === "tradekit_pending_trades")!;
    expect(pending.type).toBe("gauge");
    expect(pending.samples[0].value).toBe(2);
  });

  it("orders counter emits a sample per known status (zeros included)", () => {
    const a = insertOrder(orderFixture());
    const b = insertOrder(orderFixture());
    const c = insertOrder(orderFixture());
    markOrderFilled(a, { tx_hash: "0x" + "ab".repeat(32), fill_price: 1, base_amount: "1", quote_amount: "1" });
    markOrderFailed(b, "TX_REVERTED", "test");
    dbCancelOrder(c);
    insertOrder(orderFixture()); // one still-active

    const snap = gatherMetricsSnapshot();
    const orders = snap.families.find((f) => f.name === "tradekit_orders_total")!;
    // Always 5 samples (one per known status), even when count is 0.
    expect(orders.samples.length).toBe(5);
    const counts = Object.fromEntries(orders.samples.map((s) => [s.labels.status as string, s.value]));
    expect(counts).toEqual({
      active: 1,
      filled: 1,
      cancelled: 1,
      expired: 0,
      failed: 1,
    });
  });

  it("schedules counter + total fires sum", () => {
    const a = insertSchedule(scheduleFixture());
    const b = insertSchedule(scheduleFixture());
    dbPauseSchedule(a);
    // Use a direct SQL update to set run_count instead of importing a helper.
    const db = openDb();
    db.prepare(`UPDATE schedules SET run_count = ? WHERE id = ?`).run(7, a);
    db.prepare(`UPDATE schedules SET run_count = ? WHERE id = ?`).run(3, b);

    const snap = gatherMetricsSnapshot();
    const sched = snap.families.find((f) => f.name === "tradekit_schedules_total")!;
    const counts = Object.fromEntries(sched.samples.map((s) => [s.labels.status as string, s.value]));
    expect(counts).toEqual({ active: 1, paused: 1, completed: 0, cancelled: 0 });
    const fires = snap.families.find((f) => f.name === "tradekit_schedule_fires_total")!;
    expect(fires.samples[0].value).toBe(10);
  });

  it("rebalance plans counter + total runs sum", () => {
    const a = insertRebalancePlan(planFixture());
    const b = insertRebalancePlan(planFixture());
    pauseRebalancePlan(a);
    const db = openDb();
    db.prepare(`UPDATE rebalance_plans SET run_count = ? WHERE id = ?`).run(2, a);
    db.prepare(`UPDATE rebalance_plans SET run_count = ? WHERE id = ?`).run(5, b);

    const snap = gatherMetricsSnapshot();
    const plans = snap.families.find((f) => f.name === "tradekit_rebalance_plans_total")!;
    const counts = Object.fromEntries(plans.samples.map((s) => [s.labels.status as string, s.value]));
    expect(counts).toEqual({ active: 1, paused: 1, completed: 0, cancelled: 0 });
    const runs = snap.families.find((f) => f.name === "tradekit_rebalance_runs_total")!;
    expect(runs.samples[0].value).toBe(7);
  });

  it("audit_rows_total labeled by ok/err", () => {
    insertAudit({
      timestamp: new Date().toISOString(), caller: "cli", tool: "x", account: null, chain: null,
      params_json: null, simulation_json: null, result: "ok", error_code: null, error_message: null, tx_hash: null,
    });
    insertAudit({
      timestamp: new Date().toISOString(), caller: "cli", tool: "x", account: null, chain: null,
      params_json: null, simulation_json: null, result: "err", error_code: "INVALID_PARAMS", error_message: "bad", tx_hash: null,
    });
    const snap = gatherMetricsSnapshot();
    const audit = snap.families.find((f) => f.name === "tradekit_audit_rows_total")!;
    const counts = Object.fromEntries(audit.samples.map((s) => [s.labels.result as string, s.value]));
    expect(counts.ok).toBe(1);
    expect(counts.err).toBe(1);
  });

  it("audit_errors_total surfaces the top error codes; tail bucketed as 'other'", () => {
    // Insert 22 distinct error codes so we exceed the top-20 cap and
    // trigger the 'other' bucket. Each code gets one row; the first
    // ones inserted have the highest count (we make code "A" appear
    // many times so it tops the ranking).
    insertAudit({
      timestamp: new Date().toISOString(), caller: "cli", tool: "x", account: null, chain: null,
      params_json: null, simulation_json: null, result: "err", error_code: "A", error_message: "x", tx_hash: null,
    });
    insertAudit({
      timestamp: new Date().toISOString(), caller: "cli", tool: "x", account: null, chain: null,
      params_json: null, simulation_json: null, result: "err", error_code: "A", error_message: "x", tx_hash: null,
    });
    for (let i = 1; i <= 21; i++) {
      insertAudit({
        timestamp: new Date().toISOString(), caller: "cli", tool: "x", account: null, chain: null,
        params_json: null, simulation_json: null, result: "err", error_code: `CODE_${i}`, error_message: "x", tx_hash: null,
      });
    }
    const snap = gatherMetricsSnapshot();
    const errors = snap.families.find((f) => f.name === "tradekit_audit_errors_total")!;
    const codes = errors.samples.map((s) => s.labels.error_code as string);
    expect(codes).toContain("A"); // top
    expect(codes).toContain("other"); // overflow bucket
    expect(errors.samples.length).toBeLessThanOrEqual(21); // 20 top + 1 other
    const aSample = errors.samples.find((s) => s.labels.error_code === "A")!;
    expect(aSample.value).toBe(2);
    const otherSample = errors.samples.find((s) => s.labels.error_code === "other")!;
    expect(otherSample.value).toBeGreaterThan(0);
  });

  it("engine_running = 0 when no status file exists", () => {
    const snap = gatherMetricsSnapshot();
    const running = snap.families.find((f) => f.name === "tradekit_engine_running")!;
    expect(running.samples[0].value).toBe(0);
  });

  it("engine_running + uptime + per-worker metrics read from the status file", () => {
    // Simulate a running engine by writing a status file with our own pid
    // (so the pidAlive probe succeeds).
    const status = {
      pid: process.pid,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      updatedAt: new Date().toISOString(),
      stopping: false,
      workers: [
        {
          name: "orders",
          enabled: true,
          intervalMs: 30_000,
          ticks: 10,
          successes: 9,
          failures: 1,
          lastTickAt: new Date(Date.now() - 2_000).toISOString(),
          lastTickData: null,
          lastError: null,
          nextTickDueAt: new Date().toISOString(),
        },
        {
          name: "schedules",
          enabled: true,
          intervalMs: 60_000,
          ticks: 5,
          successes: 5,
          failures: 0,
          lastTickAt: null, // never ticked
          lastTickData: null,
          lastError: null,
          nextTickDueAt: null,
        },
      ],
    };
    writeFileSync(ENGINE_STATUS_FILE, JSON.stringify(status));

    const snap = gatherMetricsSnapshot();
    const running = snap.families.find((f) => f.name === "tradekit_engine_running")!;
    expect(running.samples[0].value).toBe(1); // pid alive (it's our own) + not stopping

    const uptime = snap.families.find((f) => f.name === "tradekit_engine_uptime_seconds")!;
    expect(uptime.samples[0].value).toBeGreaterThanOrEqual(4);
    expect(uptime.samples[0].value).toBeLessThanOrEqual(10);

    const ticks = snap.families.find((f) => f.name === "tradekit_engine_worker_ticks_total")!;
    const byWorker = Object.fromEntries(ticks.samples.map((s) => [s.labels.worker as string, s.value]));
    expect(byWorker.orders).toBe(10);
    expect(byWorker.schedules).toBe(5);

    const fails = snap.families.find((f) => f.name === "tradekit_engine_worker_failures_total")!;
    const failsByWorker = Object.fromEntries(fails.samples.map((s) => [s.labels.worker as string, s.value]));
    expect(failsByWorker.orders).toBe(1);
    expect(failsByWorker.schedules).toBe(0);

    const staleness = snap.families.find((f) => f.name === "tradekit_engine_worker_last_tick_seconds_ago")!;
    const stalenessByWorker = Object.fromEntries(
      staleness.samples.map((s) => [s.labels.worker as string, s.value]),
    );
    // orders last ticked ~2s ago
    expect(stalenessByWorker.orders).toBeGreaterThanOrEqual(1);
    expect(stalenessByWorker.orders).toBeLessThanOrEqual(5);
    // schedules never ticked → -1 sentinel
    expect(stalenessByWorker.schedules).toBe(-1);
  });

  it("engine_running = 0 when stopping flag is true (graceful shutdown in progress)", () => {
    const status = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stopping: true,
      workers: [],
    };
    writeFileSync(ENGINE_STATUS_FILE, JSON.stringify(status));
    const snap = gatherMetricsSnapshot();
    const running = snap.families.find((f) => f.name === "tradekit_engine_running")!;
    expect(running.samples[0].value).toBe(0);
  });
});

// ── renderMetricsResponse ──────────────────────────────────

describe("renderMetricsResponse", () => {
  it("returns the canonical Prometheus content type + a well-formed body", () => {
    const r = renderMetricsResponse();
    expect(r.contentType).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(r.body).toContain("# HELP tradekit_build_info");
    expect(r.body).toContain("# TYPE tradekit_build_info gauge");
    expect(r.body.endsWith("\n")).toBe(true);
  });
});
