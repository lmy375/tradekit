/**
 * Web automation API tests. Spins a BARE express app with only
 * registerAutomationRoutes (no auth, no wallet, no static bundle) on
 * an ephemeral port and exercises every route over real HTTP against
 * a seeded SQLite — the same offline discipline as the engine tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-webauto-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const express = (await import("express")).default;
const { registerAutomationRoutes } = await import("./webAutomation.js");
const {
  openDb,
  closeDb,
  insertOrder,
  insertSchedule,
  insertRebalancePlan,
  insertPlaybook,
  recordPaperTrade,
  insertAlertEvent,
  insertScheduleCheckEntry,
  insertRebalanceCheckEntry,
  upsertStrategyAlertState,
} = await import("./db.js");
const { setPaperBalance } = await import("./paperTrade.js");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

let server: Server;
let base: string;

beforeAll(async () => {
  openDb();
  const app = express();
  registerAutomationRoutes(app);
  // Error handler mirroring web.ts: ToolError → 400 JSON. Express
  // identifies error middleware by arity — all four params required.
  const errorHandler: import("express").ErrorRequestHandler = (err, _req, res, _next) => {
    const code = (err as { code?: string }).code ?? "INTERNAL_ERROR";
    res.status(code === "INVALID_PARAMS" ? 400 : 500).json({ ok: false, error: { code, message: (err as Error).message } });
  };
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = openDb();
  for (const t of [
    "orders", "schedules", "rebalance_plans", "playbooks", "paper_trades", "paper_balances",
    "order_check_log", "schedule_check_log", "rebalance_check_log", "alert_events", "strategy_alert_state",
    "trades", "audit_log",
  ]) {
    db.exec(`DELETE FROM ${t}`);
  }
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function seedOrder(over: Record<string, unknown> = {}): number {
  return insertOrder({
    side: "sell",
    trigger_type: "trailing",
    target_price_usd: null,
    trail_pct: 5,
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
    strategy: "web-test",
    note: null,
    group_id: null,
    ...over,
  } as never);
}

function seedSchedule(): number {
  return insertSchedule({
    name: "web-dca",
    cron_expr: "0 */6 * * *",
    next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
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
    strategy: "web-test",
    note: null,
    paper: true,
  });
}

function seedPlan(): number {
  return insertRebalancePlan({
    name: "web-folio",
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
    next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
    start_at: null,
    end_at: null,
    max_runs: null,
    slippage_bps: null,
    auto_slippage: false,
    strategy: "web-test",
    note: null,
  });
}

describe("/api/engine", () => {
  it("reports not-running + unlocked on a fresh install", async () => {
    const { status, body } = await get("/api/engine");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.running).toBe(false);
    expect((body.lock as { active: boolean }).active).toBe(false);
  });
});

describe("/api/orders", () => {
  it("lists active orders with filters; detail includes the journal tail", async () => {
    const id = seedOrder();
    seedOrder({ strategy: "other" });
    const list = await get("/api/orders?strategy=web-test");
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(1);

    const { insertOrderCheckEntry } = await import("./db.js");
    insertOrderCheckEntry({
      orderId: id,
      checkedAt: new Date().toISOString(),
      priceUsd: 2000,
      waterMarkUsd: 2100,
      thresholdUsd: 1995,
      decision: "hwm_advanced",
      notes: null,
    });
    const detail = await get(`/api/orders/${id}`);
    expect(detail.status).toBe(200);
    expect((detail.body.order as { id: number }).id).toBe(id);
    expect((detail.body.journal as unknown[]).length).toBe(1);
  });

  it("404-shape for unknown id (400 INVALID_PARAMS contract)", async () => {
    const r = await get("/api/orders/99999");
    expect(r.status).toBe(400);
    expect((r.body.error as { code: string }).code).toBe("INVALID_PARAMS");
  });
});

describe("/api/schedules + /api/rebalance", () => {
  it("schedule detail carries the v29 journal tail", async () => {
    const id = seedSchedule();
    insertScheduleCheckEntry({ scheduleId: id, checkedAt: new Date().toISOString(), decision: "fired", runNumber: 1 });
    const r = await get(`/api/schedules/${id}`);
    expect(r.status).toBe(200);
    expect((r.body.schedule as { id: number }).id).toBe(id);
    expect((r.body.journal as Array<{ decision: string }>)[0].decision).toBe("fired");
  });

  it("rebalance detail carries the drift history", async () => {
    const id = seedPlan();
    insertRebalanceCheckEntry({ planId: id, checkedAt: new Date().toISOString(), decision: "in_band", maxDriftPct: 3.2, thresholdPct: 5 });
    const r = await get(`/api/rebalance/${id}`);
    expect(r.status).toBe(200);
    expect((r.body.plan as { id: number }).id).toBe(id);
    expect((r.body.journal as Array<{ max_drift_pct: number }>)[0].max_drift_pct).toBeCloseTo(3.2);
  });

  it("list endpoints respect status filter defaults (active)", async () => {
    const id = seedSchedule();
    openDb().prepare(`UPDATE schedules SET status = 'cancelled' WHERE id = ?`).run(id);
    const r = await get("/api/schedules");
    expect(r.body.count).toBe(0);
    const all = await get("/api/schedules?status=all");
    expect(all.body.count).toBe(1);
  });
});

describe("/api/playbooks", () => {
  it("lists deployed playbooks + detail returns spec and owned primitives", async () => {
    const pbId = insertPlaybook({
      name: "web-pb",
      sourcePath: null,
      sourceHash: "h",
      specJson: JSON.stringify({ name: "web-pb", strategies: [{ type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" }] }),
    });
    const { updatePlaybookStatus } = await import("./db.js");
    updatePlaybookStatus(pbId, "deployed");
    seedOrder({ strategy: `playbook:${pbId}` });

    const list = await get("/api/playbooks");
    expect(list.body.count).toBe(1);
    const detail = await get(`/api/playbooks/${pbId}`);
    expect(detail.status).toBe(200);
    expect((detail.body.playbook as { id: number }).id).toBe(pbId);
    expect(((detail.body.primitives as { orders: unknown[] }).orders).length).toBe(1);
  });
});

describe("/api/paper", () => {
  it("returns balances + realized pnl from the shared core", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "1000" });
    recordPaperTrade({
      timestamp: new Date().toISOString(),
      source_type: "manual",
      source_id: null,
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: WETH,
      base_symbol: "ETH",
      base_amount: "0.1",
      quote_token: USDC,
      quote_symbol: "USDC",
      quote_amount: "200",
      price: "2000",
      slippage_bps: 0,
      strategy: "web-test",
      notes: null,
    });
    const r = await get("/api/paper");
    expect(r.status).toBe(200);
    expect((r.body.balances as unknown[]).length).toBe(1);
    const pnl = r.body.pnl as Array<{ strategy: string; netQuote: number }>;
    expect(pnl[0].strategy).toBe("web-test");
    expect(pnl[0].netQuote).toBeCloseTo(-200, 6);
  });
});

describe("/api/timeline", () => {
  it("merges sources with kinds filter + validates unknown kinds", async () => {
    const sid = seedSchedule();
    insertScheduleCheckEntry({ scheduleId: sid, checkedAt: new Date().toISOString(), decision: "fired", runNumber: 1 });
    const r = await get("/api/timeline?kinds=schedule.journal&since=4h");
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    expect((r.body.events as Array<{ kind: string }>)[0].kind).toBe("schedule.journal");

    const bad = await get("/api/timeline?kinds=bogus.kind");
    expect(bad.status).toBe(400);
    const badSince = await get("/api/timeline?since=not-a-duration");
    expect(badSince.status).toBe(400);
  });
});

describe("/api/alerts", () => {
  it("returns active states + the v28 history journal", async () => {
    upsertStrategyAlertState({
      tag: "web-test",
      ruleType: "failure_streak",
      active: true,
      firstTriggeredAt: new Date().toISOString(),
      lastEvaluatedAt: new Date().toISOString(),
      lastValueJson: '{"streak":3}',
    });
    insertAlertEvent({
      at: new Date().toISOString(),
      tag: "web-test",
      ruleType: "failure_streak",
      event: "fired",
      severity: "critical",
    });
    const r = await get("/api/alerts?tag=web-test");
    expect(r.status).toBe(200);
    expect((r.body.active as unknown[]).length).toBe(1);
    expect((r.body.history as Array<{ event: string }>)[0].event).toBe("fired");
  });
});

describe("/api/strategy-report/:tag", () => {
  it("builds the offline report (auto mode, no prices)", async () => {
    seedOrder();
    const r = await get("/api/strategy-report/web-test?window=7d");
    expect(r.status).toBe(200);
    const report = r.body.report as { tag: string; composition?: { totals: { orders: number } } };
    expect(report.tag).toBe("web-test");
    expect(report.composition?.totals.orders).toBe(1);
  });

  it("validates window + mode params", async () => {
    expect((await get("/api/strategy-report/x?window=2y")).status).toBe(400);
    expect((await get("/api/strategy-report/x?mode=fake")).status).toBe(400);
  });
});
