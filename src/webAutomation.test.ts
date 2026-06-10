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
  app.use(express.json());
  const { registerSignalWebhook } = await import("./webAutomation.js");
  registerSignalWebhook(app, { info: () => {} });
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

describe("/api/dashboard", () => {
  it("returns the full status report with the sections filter", async () => {
    upsertStrategyAlertState({
      tag: "web-test",
      ruleType: "staleness",
      active: true,
      firstTriggeredAt: new Date().toISOString(),
      lastEvaluatedAt: new Date().toISOString(),
      lastValueJson: null,
    });
    const r = await get("/api/dashboard?sections=alerts,paper");
    expect(r.status).toBe(200);
    const report = r.body.report as { alerts: { activeCount: number }; orders: { active?: unknown[] } };
    expect(report.alerts.activeCount).toBe(1);
    expect(r.body.sections).toEqual(["alerts", "paper"]);

    const bad = await get("/api/dashboard?sections=bogus");
    expect(bad.status).toBe(400);
  });
});

// ── kind-registry sync (v33 drift regression) ────────────────

describe("/api/timeline — kind registry", () => {
  it("accepts every kind in ALL_EVENT_KINDS (incl. alert.breaker, which the old hand-copied list missed)", async () => {
    const { ALL_EVENT_KINDS } = await import("./timeline.js");
    expect(ALL_EVENT_KINDS).toContain("alert.breaker");
    const r = await get(`/api/timeline?kinds=${ALL_EVENT_KINDS.join(",")}&since=1h`);
    expect(r.status).toBe(200);
  });
});

// ── /api/runway ──────────────────────────────────────────────

describe("/api/runway", () => {
  it("forecasts paper buckets offline (paper book is the balance source)", async () => {
    seedSchedule(); // paper buy, 100 USDC per fire, 6h cron
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "250" });
    const r = await get("/api/runway?days=30");
    expect(r.status).toBe(200);
    const buckets = r.body.buckets as Array<{ token: string; paper: boolean; balance: number; firesCovered: number; exhaustsAt: string | null }>;
    expect(buckets).toHaveLength(1);
    expect(buckets[0].paper).toBe(true);
    expect(buckets[0].token).toBe(USDC);
    expect(buckets[0].balance).toBe(250);
    // 250 covers 2 × 100 fires; the 3rd exhausts.
    expect(buckets[0].firesCovered).toBe(2);
    expect(buckets[0].exhaustsAt).not.toBeNull();
  });

  it("rejects an out-of-range days param", async () => {
    const r = await get("/api/runway?days=9999");
    expect(r.status).toBe(400);
  });

  it("strategy filter scopes the forecast", async () => {
    seedSchedule(); // strategy web-test
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "1000" });
    const r = await get("/api/runway?strategy=other-tag");
    expect(r.status).toBe(200);
    expect((r.body.buckets as unknown[])).toHaveLength(0);
  });
});

// ── /api/strategies + strategy-report sections ───────────────

describe("/api/strategies", () => {
  it("unions trade-history tags with live-primitive tags (zero-fill playbooks appear)", async () => {
    const { insertTrade } = await import("./db.js");
    // A tag with trade history but no live primitives…
    insertTrade({
      timestamp: "2026-06-01T00:00:00Z",
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "ETH", base_amount: "0.1",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "200",
      price: "2000", tx_hash: "0xs1", status: "success",
      gas_used: null, gas_price_wei: null, gas_cost_native: null,
      aggregator: "kyberswap", fee_tier: null, notes: null,
      strategy: "old-tag", realized_slippage_bps: null,
    });
    // …and a freshly deployed schedule with zero fills.
    seedSchedule(); // strategy web-test, active
    const r = await get("/api/strategies");
    expect(r.status).toBe(200);
    const strategies = r.body.strategies as Array<{ tag: string; live: boolean; tradeCount: number }>;
    const oldTag = strategies.find((s) => s.tag === "old-tag")!;
    const fresh = strategies.find((s) => s.tag === "web-test")!;
    expect(oldTag.live).toBe(false);
    expect(oldTag.tradeCount).toBe(1);
    expect(fresh.live).toBe(true);
    expect(fresh.tradeCount).toBe(0);
    // Live tags sort first.
    expect(strategies.indexOf(fresh)).toBeLessThan(strategies.indexOf(oldTag));
  });
});

describe("/api/strategy-report/:tag — sections", () => {
  it("subsets to the requested core sections", async () => {
    seedSchedule();
    const r = await get("/api/strategy-report/web-test?sections=identity,forward");
    expect(r.status).toBe(200);
    const report = r.body.report as Record<string, unknown>;
    expect(report.identity).toBeDefined();
    expect(report.forward).toBeDefined();
    expect(report.performance).toBeUndefined();
  });

  it("rejects non-core sections (valuation/runway need IO this route refuses)", async () => {
    const r = await get("/api/strategy-report/web-test?sections=valuation");
    expect(r.status).toBe(400);
  });
});

// ── /api/equity ──────────────────────────────────────────────

describe("/api/equity", () => {
  it("serves the curve from seeded snapshots", async () => {
    const { insertPortfolioSnapshot } = await import("./db.js");
    insertPortfolioSnapshot({
      timestamp: "2026-06-01T00:00:00Z", total_usd: 1000,
      accounts_key: "default", chains_key: "base",
      token_count: 2, note: null, data: "{}",
    });
    insertPortfolioSnapshot({
      timestamp: "2026-06-02T00:00:00Z", total_usd: 1300,
      accounts_key: "default", chains_key: "base",
      token_count: 2, note: null, data: "{}",
    });
    const r = await get("/api/equity");
    expect(r.status).toBe(200);
    expect((r.body.points as unknown[]).length).toBe(2);
    expect(r.body.changeAbs).toBe(300);
    expect(r.body.scopeSource).toBe("defaulted");
  });

  it("rejects bad maxPoints", async () => {
    const r = await get("/api/equity?maxPoints=99999");
    expect(r.status).toBe(400);
  });
});

// ── v35: signal webhook ──────────────────────────────────────

describe("POST /api/signal/:name", () => {
  async function post(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("404s when no signalSecret is configured (endpoint indistinguishable from absent)", async () => {
    const r = await post("/api/signal/tv-breakout?key=whatever");
    expect(r.status).toBe(404);
  });

  it("authenticates with the shared secret and records the event", async () => {
    const { loadConfig, saveConfig } = await import("./config.js");
    const cfg = loadConfig();
    saveConfig({ ...cfg, webhooks: { signalSecret: "super-secret-test-key" } } as never);
    try {
      const bad = await post("/api/signal/tv-breakout?key=wrong-secret-here!");
      expect(bad.status).toBe(401);

      const badName = await post("/api/signal/bad%20name?key=super-secret-test-key");
      expect(badName.status).toBe(400);

      const ok2 = await post("/api/signal/tv-breakout?key=super-secret-test-key", { price: 2701 });
      expect(ok2.status).toBe(200);
      expect(ok2.body.name).toBe("tv-breakout");

      const { listSignalEvents, openDb } = await import("./db.js");
      const events = listSignalEvents({ name: "tv-breakout" });
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe("webhook");
      expect(events[0].payload_json).toContain("2701");
      openDb().exec("DELETE FROM signal_events");
    } finally {
      saveConfig(cfg);
    }
  });
});
