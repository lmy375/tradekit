/**
 * Status dashboard tests.
 *
 * Layers:
 *   1. Pure helpers — computeThreshold, computePctToFire (no DB)
 *   2. Per-section gatherers — each with seeded DB state
 *   3. Section filter — only requested sections populated
 *   4. Edge cases — empty DB, stale heartbeats
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-status-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  gatherStatusReport,
  computeThreshold,
  computePctToFire,
  formatDurationSeconds,
  healthMarker,
} = await import("./status.js");
const {
  openDb,
  closeDb,
  insertOrder,
  insertSchedule,
  insertPlaybook,
  upsertDrawdownState,
  insertAudit,
  upsertStrategyAlertState,
  insertAlertEvent,
  recordPaperTrade,
} = await import("./db.js");
type OrderRow = import("./db.js").OrderRow;
const { ENGINE_STATUS_FILE } = await import("./engine.js");

beforeAll(() => {
  openDb();
});
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM orders");
  db.exec("DELETE FROM schedules");
  db.exec("DELETE FROM rebalance_plans");
  db.exec("DELETE FROM playbooks");
  db.exec("DELETE FROM drawdown_state");
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM trades");
  db.exec("DELETE FROM strategy_alert_state");
  db.exec("DELETE FROM alert_events");
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM paper_balances");
  if (existsSync(ENGINE_STATUS_FILE)) unlinkSync(ENGINE_STATUS_FILE);
});

// ── pure helpers (no DB) ─────────────────────────────────────

describe("formatDurationSeconds", () => {
  it("seconds < 60", () => { expect(formatDurationSeconds(45)).toBe("45s"); });
  it("minutes 1-59", () => { expect(formatDurationSeconds(120)).toBe("2m"); });
  it("hours include minutes", () => { expect(formatDurationSeconds(3661)).toBe("1h 1m"); });
  it("days include hours", () => { expect(formatDurationSeconds(2 * 86400 + 5 * 3600)).toBe("2d 5h"); });
  it("handles negative values", () => { expect(formatDurationSeconds(-90)).toBe("-1m"); });
});

describe("healthMarker", () => {
  it("maps each health state to a marker", () => {
    expect(healthMarker("ok")).toBe("●");
    expect(healthMarker("warn")).toBe("◐");
    expect(healthMarker("stale")).toBe("✕");
    expect(healthMarker("never-ticked")).toBe("○");
  });
});

function mkOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    on_fill_json: null,
    status: "active",
    side: "sell",
    trigger_type: "price_above",
    target_price_usd: 3000,
    trail_pct: null,
    water_mark_usd: null,
    chain: "base",
    account: "default",
    base_token: "0xeeee",
    base_symbol: "ETH",
    quote_token: "0xqqqq",
    quote_symbol: "USDC",
    base_amount: "1",
    quote_amount: null,
    slippage_bps: null,
    auto_slippage: 0,
    expires_at: null,
    strategy: null,
    note: null,
    attempts: 0,
    last_checked_at: null,
    last_checked_price: null,
    last_error_code: null,
    last_error_message: null,
    filled_at: null,
    fill_tx_hash: null,
    fill_price: null,
    fill_base_amount: null,
    fill_quote_amount: null,
    ...overrides,
  };
}

describe("computeThreshold", () => {
  it("price_above uses target as threshold", () => {
    expect(computeThreshold(mkOrder({ trigger_type: "price_above", target_price_usd: 3000 }))).toBe(3000);
  });
  it("price_below uses target as threshold", () => {
    expect(computeThreshold(mkOrder({ trigger_type: "price_below", target_price_usd: 2000 }))).toBe(2000);
  });
  it("trailing sell uses water_mark × (1 - trail/100)", () => {
    expect(computeThreshold(mkOrder({
      trigger_type: "trailing", side: "sell", water_mark_usd: 1000, trail_pct: 5,
    }))).toBe(950);
  });
  it("trailing buy uses water_mark × (1 + trail/100)", () => {
    expect(computeThreshold(mkOrder({
      trigger_type: "trailing", side: "buy", water_mark_usd: 1000, trail_pct: 5,
    }))).toBe(1050);
  });
  it("trailing without water_mark returns null", () => {
    expect(computeThreshold(mkOrder({
      trigger_type: "trailing", water_mark_usd: null, trail_pct: 5,
    }))).toBeNull();
  });
  it("trailing without trail_pct returns null", () => {
    expect(computeThreshold(mkOrder({
      trigger_type: "trailing", water_mark_usd: 1000, trail_pct: null,
    }))).toBeNull();
  });
});

describe("computePctToFire", () => {
  it("price_above — current below target → distance to rise", () => {
    const pct = computePctToFire(mkOrder({
      trigger_type: "price_above", target_price_usd: 3000, last_checked_price: 2700,
    }));
    expect(pct).toBeCloseTo(((3000 - 2700) / 2700) * 100, 5);
  });
  it("price_above — current already past → 0", () => {
    expect(computePctToFire(mkOrder({
      trigger_type: "price_above", target_price_usd: 3000, last_checked_price: 3100,
    }))).toBe(0);
  });
  it("price_below — current above target → distance to drop", () => {
    const pct = computePctToFire(mkOrder({
      trigger_type: "price_below", target_price_usd: 2000, last_checked_price: 2200,
    }));
    expect(pct).toBeCloseTo(((2200 - 2000) / 2200) * 100, 5);
  });
  it("trailing sell — distance from current down to threshold", () => {
    const pct = computePctToFire(mkOrder({
      trigger_type: "trailing", side: "sell",
      water_mark_usd: 1000, trail_pct: 5, last_checked_price: 980,
    }));
    expect(pct).toBeCloseTo(((980 - 950) / 980) * 100, 5);
  });
  it("trailing buy — distance from current up to threshold", () => {
    const pct = computePctToFire(mkOrder({
      trigger_type: "trailing", side: "buy",
      water_mark_usd: 1000, trail_pct: 5, last_checked_price: 1020,
    }));
    expect(pct).toBeCloseTo(((1050 - 1020) / 1020) * 100, 5);
  });
  it("returns null when no last_checked_price", () => {
    expect(computePctToFire(mkOrder({ last_checked_price: null }))).toBeNull();
  });
  it("returns null when threshold can't be computed", () => {
    expect(computePctToFire(mkOrder({
      trigger_type: "trailing", water_mark_usd: null, trail_pct: 5, last_checked_price: 1000,
    }))).toBeNull();
  });
});

// ── DB seeders ───────────────────────────────────────────────

/** Insert an order + post-write the last_checked fields (insertOrder
 *  doesn't expose them in its signature since they're engine-managed). */
function seedOrder(overrides: {
  trigger_type?: "price_above" | "price_below" | "trailing";
  target_price_usd?: number | null;
  side?: "buy" | "sell";
  trail_pct?: number | null;
  last_checked_price?: number | null;
  last_checked_at?: string | null;
  base_symbol?: string;
  quote_symbol?: string;
}): number {
  const id = insertOrder({
    side: overrides.side ?? "sell",
    trigger_type: overrides.trigger_type ?? "price_above",
    target_price_usd: overrides.target_price_usd ?? 3000,
    trail_pct: overrides.trail_pct ?? null,
    chain: "base",
    account: "default",
    base_token: "0x4200000000000000000000000000000000000006",
    base_symbol: overrides.base_symbol ?? "ETH",
    quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    quote_symbol: overrides.quote_symbol ?? "USDC",
    base_amount: "1",
    quote_amount: null,
    slippage_bps: null,
    auto_slippage: false,
    expires_at: null,
    strategy: null,
    note: null,
    group_id: null,
  });
  if (overrides.last_checked_at !== undefined || overrides.last_checked_price !== undefined) {
    const db = openDb();
    db.prepare(`UPDATE orders SET last_checked_at = ?, last_checked_price = ? WHERE id = ?`).run(
      overrides.last_checked_at ?? null,
      overrides.last_checked_price ?? null,
      id,
    );
  }
  return id;
}

function seedSchedule(overrides: { name?: string; cron_expr?: string; next_run_at?: string; side?: "buy" | "sell" } = {}): number {
  return insertSchedule({
    name: overrides.name ?? null,
    cron_expr: overrides.cron_expr ?? "0 0 * * *",
    next_run_at: overrides.next_run_at ?? "2026-06-01T00:00:00Z",
    side: overrides.side ?? "buy",
    chain: "base",
    account: "default",
    base_token: "0x4200000000000000000000000000000000000006",
    base_symbol: "ETH",
    quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    quote_symbol: "USDC",
    base_amount: null,
    quote_amount: "100",
    slippage_bps: null,
    auto_slippage: false,
    start_at: null,
    end_at: null,
    max_runs: null,
    strategy: null,
    note: null,
  });
}

// ── engine section ───────────────────────────────────────────

describe("gatherStatusReport — engine section", () => {
  it("reports notStarted=true when status file missing", () => {
    const report = gatherStatusReport({ now: new Date("2026-05-30T12:00:00Z") });
    expect(report.engine.notStarted).toBe(true);
    expect(report.engine.workers).toEqual([]);
  });

  it("reads workers from engine status file with health classification", () => {
    writeFileSync(
      ENGINE_STATUS_FILE,
      JSON.stringify({
        pid: 1234,
        startedAt: "2026-05-30T10:00:00Z",
        updatedAt: "2026-05-30T11:59:50Z",
        stopping: false,
        workers: [
          {
            name: "orders",
            enabled: true,
            intervalMs: 30000,
            ticks: 100, successes: 98, failures: 2,
            lastTickAt: "2026-05-30T11:59:50Z",
            lastTickData: null, lastError: null,
            nextTickDueAt: "2026-05-30T12:00:20Z",
          },
          {
            name: "schedules",
            enabled: true, intervalMs: 30000,
            ticks: 0, successes: 0, failures: 0,
            lastTickAt: null,
            lastTickData: null, lastError: null,
            nextTickDueAt: null,
          },
        ],
      }) + "\n",
    );
    const now = new Date("2026-05-30T12:00:00Z");
    const report = gatherStatusReport({ now });
    expect(report.engine.notStarted).toBe(false);
    expect(report.engine.workers.length).toBe(2);
    expect(report.engine.workers[0].name).toBe("orders");
    expect(report.engine.workers[0].health).toBe("ok");
    expect(report.engine.workers[0].lastTickAgeSec).toBe(10);
    expect(report.engine.workers[1].health).toBe("never-ticked");
  });

  it("classifies stale heartbeat correctly (> 4× interval)", () => {
    writeFileSync(
      ENGINE_STATUS_FILE,
      JSON.stringify({
        pid: 1234,
        startedAt: "2026-05-30T10:00:00Z",
        updatedAt: "2026-05-30T11:55:00Z",
        stopping: false,
        workers: [{
          name: "orders",
          enabled: true, intervalMs: 30000,
          ticks: 100, successes: 100, failures: 0,
          lastTickAt: "2026-05-30T11:55:00Z", // 5 min ago, interval 30s → 600s = 20×
          lastTickData: null, lastError: null,
          nextTickDueAt: null,
        }],
      }) + "\n",
    );
    const now = new Date("2026-05-30T12:00:00Z");
    const report = gatherStatusReport({ now });
    expect(report.engine.workers[0].health).toBe("stale");
  });

  it("classifies warn (2× < age <= 4×)", () => {
    writeFileSync(
      ENGINE_STATUS_FILE,
      JSON.stringify({
        pid: 1234,
        startedAt: "2026-05-30T10:00:00Z",
        updatedAt: "2026-05-30T11:58:30Z",
        stopping: false,
        workers: [{
          name: "orders",
          enabled: true, intervalMs: 30000,
          ticks: 100, successes: 100, failures: 0,
          lastTickAt: "2026-05-30T11:58:30Z", // 90s ago, 3× 30s interval = warn
          lastTickData: null, lastError: null,
          nextTickDueAt: null,
        }],
      }) + "\n",
    );
    const now = new Date("2026-05-30T12:00:00Z");
    const report = gatherStatusReport({ now });
    expect(report.engine.workers[0].health).toBe("warn");
  });
});

// ── orders section ───────────────────────────────────────────

describe("gatherStatusReport — orders section", () => {
  it("counts by status + reports near-trigger sorted by proximity", () => {
    const now = new Date("2026-05-30T12:00:00Z");
    const checkedAt = "2026-05-30T11:59:00Z";
    seedOrder({ target_price_usd: 3000, last_checked_price: 2700, last_checked_at: checkedAt }); // 11.1% away
    seedOrder({ target_price_usd: 3000, last_checked_price: 2950, last_checked_at: checkedAt }); //  1.7% away (closest)
    seedOrder({ target_price_usd: 3000, last_checked_price: 2850, last_checked_at: checkedAt }); //  5.3% away

    const report = gatherStatusReport({ now, sections: ["orders"] });
    expect(report.orders.counts.active).toBe(3);
    expect(report.orders.nearTrigger.length).toBe(3);
    expect(report.orders.nearTrigger[0].lastPriceUsd).toBe(2950);
    expect(report.orders.nearTrigger[1].lastPriceUsd).toBe(2850);
    expect(report.orders.nearTrigger[2].lastPriceUsd).toBe(2700);
  });

  it("limits near-trigger to top 5", () => {
    const now = new Date("2026-05-30T12:00:00Z");
    const checkedAt = "2026-05-30T11:59:00Z";
    for (let i = 0; i < 10; i++) {
      seedOrder({ target_price_usd: 3000, last_checked_price: 2000 + 50 * i, last_checked_at: checkedAt });
    }
    const report = gatherStatusReport({ now, sections: ["orders"] });
    expect(report.orders.nearTrigger.length).toBe(5);
  });

  it("excludes orders with no last_checked_price", () => {
    const now = new Date("2026-05-30T12:00:00Z");
    seedOrder({ target_price_usd: 3000, last_checked_price: null, last_checked_at: null });
    seedOrder({ target_price_usd: 3000, last_checked_price: 2800, last_checked_at: "2026-05-30T11:59:00Z" });

    const report = gatherStatusReport({ now, sections: ["orders"] });
    expect(report.orders.counts.active).toBe(2);
    expect(report.orders.nearTrigger.length).toBe(1);
    expect(report.orders.nearTrigger[0].lastPriceUsd).toBe(2800);
  });

  it("flags stale check (>1h old) on near-trigger entries", () => {
    const now = new Date("2026-05-30T12:00:00Z");
    seedOrder({
      target_price_usd: 3000, last_checked_price: 2900,
      last_checked_at: "2026-05-30T10:00:00Z", // 2h ago
    });
    const report = gatherStatusReport({ now, sections: ["orders"] });
    expect(report.orders.nearTrigger[0].staleCheck).toBe(true);
  });
});

// ── schedules section ────────────────────────────────────────

describe("gatherStatusReport — schedules section", () => {
  it("lists next fires sorted soonest-first", () => {
    const now = new Date("2026-05-30T12:00:00Z");
    seedSchedule({ name: "weekly", cron_expr: "0 0 * * 0", next_run_at: "2026-06-03T00:00:00Z" });
    seedSchedule({ name: "hourly", cron_expr: "0 * * * *", next_run_at: "2026-05-30T13:00:00Z" });
    seedSchedule({ name: "daily", cron_expr: "0 0 * * *", next_run_at: "2026-05-31T00:00:00Z" });

    const report = gatherStatusReport({ now, sections: ["schedules"] });
    expect(report.schedules.counts.active).toBe(3);
    expect(report.schedules.nextFires.map((s) => s.name)).toEqual(["hourly", "daily", "weekly"]);
    expect(report.schedules.nextFires[0].secondsUntilFire).toBe(3600);
  });

  it("flags overdue schedules with negative seconds", () => {
    const now = new Date("2026-05-30T12:00:00Z");
    seedSchedule({ name: "overdue", next_run_at: "2026-05-30T11:00:00Z" });
    const report = gatherStatusReport({ now, sections: ["schedules"] });
    expect(report.schedules.nextFires[0].secondsUntilFire).toBe(-3600);
  });
});

// ── drawdown section ─────────────────────────────────────────

describe("gatherStatusReport — drawdown section", () => {
  it("reports configured=false when no config set", () => {
    const report = gatherStatusReport({ sections: ["drawdown"] });
    expect(report.drawdown.configured).toBe(false);
    expect(report.drawdown.states).toEqual([]);
  });

  it("hydrates persisted state with drawdown %", () => {
    upsertDrawdownState({
      scopeKey: "global", peakUsd: 1000, peakAt: "2026-05-01T00:00:00Z",
      trippedAt: null, lastValueUsd: 850,
    });
    const report = gatherStatusReport({ sections: ["drawdown"] });
    expect(report.drawdown.states.length).toBe(1);
    expect(report.drawdown.states[0].drawdownPct).toBeCloseTo(15, 5);
    expect(report.drawdown.states[0].tripped).toBe(false);
  });

  it("marks tripped state", () => {
    upsertDrawdownState({
      scopeKey: "global", peakUsd: 1000, peakAt: "2026-05-01T00:00:00Z",
      trippedAt: "2026-05-15T00:00:00Z", lastValueUsd: 700,
    });
    const report = gatherStatusReport({ sections: ["drawdown"] });
    expect(report.drawdown.states[0].tripped).toBe(true);
    expect(report.drawdown.states[0].drawdownPct).toBeCloseTo(30, 5);
  });
});

// ── playbooks section ────────────────────────────────────────

describe("gatherStatusReport — playbooks section", () => {
  it("reports counts + recent deployments", () => {
    insertPlaybook({ name: "pb-a", sourcePath: "/path/a.json", sourceHash: "h1", specJson: "{}" });
    insertPlaybook({ name: "pb-b", sourcePath: "/path/b.json", sourceHash: "h2", specJson: "{}" });
    const report = gatherStatusReport({ sections: ["playbooks"] });
    // Both rows are in 'deploying' state until updatePlaybookStatus flips them.
    expect(report.playbooks.counts.deploying).toBe(2);
    expect(report.playbooks.recent.length).toBe(2);
  });
});

// ── activity section ─────────────────────────────────────────

describe("gatherStatusReport — activity section", () => {
  it("aggregates audit summary + top errors", () => {
    const now = new Date("2026-05-30T12:00:00Z");
    insertAudit({
      timestamp: "2026-05-30T11:30:00Z",
      caller: "cli", tool: "trade.buy", account: "default", chain: "base",
      params_json: "{}", simulation_json: null, result: null,
      error_code: "SLIPPAGE_TOO_HIGH", error_message: "boom", tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-05-30T11:31:00Z",
      caller: "cli", tool: "trade.buy", account: "default", chain: "base",
      params_json: "{}", simulation_json: null, result: null,
      error_code: "SLIPPAGE_TOO_HIGH", error_message: "boom2", tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-05-30T11:32:00Z",
      caller: "cli", tool: "trade.buy", account: "default", chain: "base",
      params_json: "{}", simulation_json: null, result: "ok",
      error_code: null, error_message: null, tx_hash: null,
    });

    const report = gatherStatusReport({ now, sections: ["activity"] });
    expect(report.activity.summary.totalRows).toBe(3);
    expect(report.activity.summary.errorRows).toBe(2);
    expect(report.activity.topErrors.length).toBe(1);
    expect(report.activity.topErrors[0].code).toBe("SLIPPAGE_TOO_HIGH");
    expect(report.activity.topErrors[0].count).toBe(2);
  });
});

// ── section filter ───────────────────────────────────────────

describe("gatherStatusReport — section filter", () => {
  it("only requested sections populated; others empty", () => {
    seedOrder({ target_price_usd: 3000, last_checked_price: 2900, last_checked_at: "2026-05-30T11:59:00Z" });
    upsertDrawdownState({
      scopeKey: "global", peakUsd: 1000, peakAt: "2026-04-01T00:00:00Z",
      trippedAt: null, lastValueUsd: 950,
    });

    const report = gatherStatusReport({ sections: ["orders"] });
    expect(report.orders.counts.active).toBe(1);
    expect(report.drawdown.states).toEqual([]);
    expect(report.activity.summary.totalRows).toBe(0);
  });

  it("all sections populated by default", () => {
    seedOrder({ target_price_usd: 3000, last_checked_price: 2900, last_checked_at: "2026-05-30T11:59:00Z" });
    upsertDrawdownState({
      scopeKey: "global", peakUsd: 1000, peakAt: "2026-04-01T00:00:00Z",
      trippedAt: null, lastValueUsd: 950,
    });
    const report = gatherStatusReport({});
    expect(report.orders.counts.active).toBe(1);
    expect(report.drawdown.states.length).toBe(1);
  });
});

// ── empty-DB graceful ────────────────────────────────────────

describe("gatherStatusReport — empty DB", () => {
  it("returns shape with zero counts + empty arrays", () => {
    const report = gatherStatusReport({ now: new Date("2026-05-30T12:00:00Z") });
    expect(report.engine.notStarted).toBe(true);
    expect(report.orders.counts.active).toBe(0);
    expect(report.orders.nearTrigger).toEqual([]);
    expect(report.schedules.counts.active).toBe(0);
    expect(report.rebalance.counts.active).toBe(0);
    expect(report.playbooks.counts.deployed).toBe(0);
    expect(report.drawdown.states).toEqual([]);
    expect(report.budgets.rules).toEqual([]);
    expect(report.activity.summary.totalRows).toBe(0);
  });
});

// ── alerts + paper sections (v30) ────────────────────────────

describe("gatherStatusReport — alerts section", () => {
  it("empty install → zero alerts, empty transitions", () => {
    const r = gatherStatusReport({ sections: ["alerts"] });
    expect(r.alerts.activeCount).toBe(0);
    expect(r.alerts.active).toEqual([]);
    expect(r.alerts.recentTransitions).toEqual([]);
  });

  it("surfaces currently-firing alerts + recent 24h transitions", () => {
    const now = new Date("2026-06-11T12:00:00Z");
    upsertStrategyAlertState({
      tag: "dca-eth",
      ruleType: "failure_streak",
      active: true,
      firstTriggeredAt: "2026-06-11T10:00:00Z",
      lastEvaluatedAt: "2026-06-11T11:00:00Z",
      lastValueJson: '{"streak":3}',
    });
    insertAlertEvent({ at: "2026-06-11T10:00:00Z", tag: "dca-eth", ruleType: "failure_streak", event: "fired", severity: "critical" });
    insertAlertEvent({ at: "2026-06-09T10:00:00Z", tag: "old", ruleType: "staleness", event: "fired", severity: "warn" }); // > 24h — excluded

    const r = gatherStatusReport({ sections: ["alerts"], now });
    expect(r.alerts.activeCount).toBe(1);
    expect(r.alerts.active[0]).toMatchObject({ tag: "dca-eth", ruleType: "failure_streak" });
    expect(r.alerts.recentTransitions).toHaveLength(1);
    expect(r.alerts.recentTransitions[0]).toMatchObject({ event: "fired", tag: "dca-eth" });
  });

  it("section filter: alerts excluded → empty shape", () => {
    upsertStrategyAlertState({
      tag: "x", ruleType: "staleness", active: true,
      firstTriggeredAt: "2026-06-11T10:00:00Z", lastEvaluatedAt: "2026-06-11T10:00:00Z", lastValueJson: null,
    });
    const r = gatherStatusReport({ sections: ["engine"] });
    expect(r.alerts.activeCount).toBe(0);
  });
});

describe("gatherStatusReport — paper section", () => {
  const WETH2 = "0x4200000000000000000000000000000000000006";
  const USDC2 = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  it("counts the book, live paper primitives, and 24h fills", async () => {
    const { setPaperBalance } = await import("./paperTrade.js");
    const now = new Date("2026-06-11T12:00:00Z");
    setPaperBalance({ account: "default", chain: "base", token: USDC2, decimals: 6, amount: "1000" });
    setPaperBalance({ account: "alt", chain: "base", token: USDC2, decimals: 6, amount: "500" });
    insertOrder({
      side: "sell", trigger_type: "trailing", target_price_usd: null, trail_pct: 5,
      chain: "base", account: "default",
      base_token: WETH2, base_symbol: "ETH", quote_token: USDC2, quote_symbol: "USDC",
      base_amount: "1", quote_amount: null, slippage_bps: 50, auto_slippage: false,
      expires_at: null, strategy: "t", note: null, group_id: null, paper: true,
    } as never);
    recordPaperTrade({
      timestamp: "2026-06-11T11:00:00Z", source_type: "order", source_id: 1,
      chain: "base", account: "default", direction: "sell",
      base_token: WETH2, base_symbol: "ETH", base_amount: "0.1",
      quote_token: USDC2, quote_symbol: "USDC", quote_amount: "200", price: "2000",
      slippage_bps: 0, strategy: "t", notes: null,
    });
    recordPaperTrade({
      timestamp: "2026-06-09T11:00:00Z", source_type: "order", source_id: 1,
      chain: "base", account: "default", direction: "sell",
      base_token: WETH2, base_symbol: "ETH", base_amount: "0.1",
      quote_token: USDC2, quote_symbol: "USDC", quote_amount: "200", price: "2000",
      slippage_bps: 0, strategy: "t", notes: null,
    }); // > 24h

    const r = gatherStatusReport({ sections: ["paper"], now });
    expect(r.paper.balanceRows).toBe(2);
    expect(r.paper.bookScopes).toBe(2);
    expect(r.paper.activePaper.orders).toBe(1);
    expect(r.paper.fills24h).toBe(1);
  });
});
