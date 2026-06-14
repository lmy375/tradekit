/**
 * Digest tests.
 *
 * Layers:
 *   1. parseWindowMs — accept / reject / clamp
 *   2. Trades section — counts, USD volume, top strategies / bases
 *   3. Fires section — orders terminal-state classification by window
 *   4. Safety section — error code counts by category, currently-tripped
 *   5. Errors section — top errors + rate
 *   6. Verdict classification — every escalation path
 *   7. Comparison — prior window deltas
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-digest-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  parseWindowMs,
  gatherDigest,
  classifyVerdict,
  verdictEmoji,
  verdictLabel,
} = await import("./digest.js");
const {
  openDb,
  closeDb,
  insertTrade,
  insertOrder,
  insertSchedule,
  insertRebalancePlan,
  upsertDrawdownState,
  insertAudit,
  insertScheduleCheckEntry,
  insertRebalanceCheckEntry,
  insertAlertEvent,
  recordPaperTrade,
  insertPlaybook,
  updatePlaybookStatus,
  upsertStrategyAlertState,
  markOrderFilled,
  cancelOrder,
  markOrderExpired,
  markOrderFailed,
} = await import("./db.js");

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM trades");
  db.exec("DELETE FROM orders");
  db.exec("DELETE FROM schedules");
  db.exec("DELETE FROM rebalance_plans");
  db.exec("DELETE FROM drawdown_state");
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM schedule_check_log");
  db.exec("DELETE FROM rebalance_check_log");
  db.exec("DELETE FROM alert_events");
  db.exec("DELETE FROM strategy_alert_state");
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM playbooks");
});

// ── parseWindowMs ────────────────────────────────────────────

describe("parseWindowMs", () => {
  it("accepts m/h/d units", async () => {    expect(parseWindowMs("60m")).toBe(60 * 60_000);
    expect(parseWindowMs("24h")).toBe(24 * 3_600_000);
    expect(parseWindowMs("7d")).toBe(7 * 86_400_000);
  });
  it("accepts fractional values", async () => {    expect(parseWindowMs("1.5h")).toBe(1.5 * 3_600_000);
  });
  it("rejects unknown units", async () => {    expect(() => parseWindowMs("1y")).toThrow(/--window/);
  });
  it("rejects bare numbers", async () => {    expect(() => parseWindowMs("24")).toThrow(/--window/);
  });
  it("rejects sub-minute windows", async () => {    expect(() => parseWindowMs("30m")).not.toThrow();
    // 30 seconds = 0.5m — but the regex only accepts integer/decimal m/h/d.
    // Let's use a smaller test: "0.5m" = 30s < 1min → reject
    expect(() => parseWindowMs("0.5m")).toThrow(/minimum 1 minute/);
  });
  it("rejects > 90 day windows", async () => {    expect(() => parseWindowMs("100d")).toThrow(/maximum 90 days/);
  });
});

// ── trade fixture helper ─────────────────────────────────────

let txCounter = 0;
function freshTxHash(): string {
  txCounter++;
  return "0x" + txCounter.toString(16).padStart(64, "0");
}

function seedTrade(args: {
  timestamp: string;
  status?: "success" | "pending" | "failed";
  quoteAmount?: string;
  strategy?: string | null;
  baseSymbol?: string;
}): number {
  return insertTrade({
    timestamp: args.timestamp,
    chain: "base", account: "default", direction: "buy",
    base_token: "0xeeee", base_symbol: args.baseSymbol ?? "ETH",
    base_amount: "1",
    quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", quote_symbol: "USDC",
    quote_amount: args.quoteAmount ?? "100",
    price: "100",
    tx_hash: freshTxHash(),
    status: args.status ?? "success",
    gas_used: null, gas_price_wei: null, gas_cost_native: null,
    aggregator: null, fee_tier: null, notes: null,
    strategy: args.strategy ?? null,
  });
}

function seedAudit(args: { timestamp: string; errorCode?: string | null }): void {
  insertAudit({
    timestamp: args.timestamp,
    caller: "cli", tool: "trade.buy", account: "default", chain: "base",
    params_json: "{}", simulation_json: null,
    result: args.errorCode ? null : "ok",
    error_code: args.errorCode ?? null,
    error_message: args.errorCode ? "boom" : null,
    tx_hash: null,
  });
}

// ── trades section ───────────────────────────────────────────

describe("gatherDigest — trades section", () => {
  it("counts by status + sums USD volume", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    seedTrade({ timestamp: "2026-05-30T11:00:00Z", status: "success", quoteAmount: "150" });
    seedTrade({ timestamp: "2026-05-30T10:00:00Z", status: "success", quoteAmount: "200" });
    seedTrade({ timestamp: "2026-05-30T09:00:00Z", status: "failed" });
    seedTrade({ timestamp: "2026-05-30T08:00:00Z", status: "pending", quoteAmount: "50" });

    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.trades.total).toBe(4);
    expect(r.trades.success).toBe(2);
    expect(r.trades.pending).toBe(1);
    expect(r.trades.failed).toBe(1);
    // success + pending USD: 150 + 200 + 50 = 400
    expect(r.trades.usdVolume).toBe(400);
    expect(r.trades.successRatePct).toBe(50);
  });

  it("excludes trades older than window", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    seedTrade({ timestamp: "2026-05-29T12:00:00Z" }); // outside 1h
    seedTrade({ timestamp: "2026-05-30T11:30:00Z" }); // inside 1h
    const r = await gatherDigest({ windowLabel: "1h", windowMs: 3_600_000, now });
    expect(r.trades.total).toBe(1);
  });

  it("ranks top strategies by count", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    seedTrade({ timestamp: "2026-05-30T11:00:00Z", strategy: "playbook:1", quoteAmount: "100" });
    seedTrade({ timestamp: "2026-05-30T11:01:00Z", strategy: "playbook:1", quoteAmount: "100" });
    seedTrade({ timestamp: "2026-05-30T11:02:00Z", strategy: "manual-dca", quoteAmount: "50" });

    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.trades.topStrategies[0].strategy).toBe("playbook:1");
    expect(r.trades.topStrategies[0].count).toBe(2);
    expect(r.trades.topStrategies[0].usdVolume).toBe(200);
    expect(r.trades.topStrategies[1].strategy).toBe("manual-dca");
    expect(r.trades.topStrategies[1].count).toBe(1);
  });

  it("ranks top base symbols", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    seedTrade({ timestamp: "2026-05-30T11:00:00Z", baseSymbol: "ETH" });
    seedTrade({ timestamp: "2026-05-30T11:01:00Z", baseSymbol: "ETH" });
    seedTrade({ timestamp: "2026-05-30T11:02:00Z", baseSymbol: "WBTC" });
    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.trades.topBases[0]).toEqual({ symbol: "ETH", count: 2 });
    expect(r.trades.topBases[1]).toEqual({ symbol: "WBTC", count: 1 });
  });
});

// ── fires section ────────────────────────────────────────────

function seedOrderInWindow(opts: { side?: "buy" | "sell" } = {}): number {
  return insertOrder({
    side: opts.side ?? "sell",
    trigger_type: "price_above", target_price_usd: 3000,
    trail_pct: null,
    chain: "base", account: "default",
    base_token: "0x4200000000000000000000000000000000000006", base_symbol: "ETH",
    quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", quote_symbol: "USDC",
    base_amount: "1", quote_amount: null,
    slippage_bps: null, auto_slippage: false,
    expires_at: null, strategy: null, note: null, group_id: null,
  });
}

describe("gatherDigest — fires section", () => {
  it("counts orders that transitioned to filled in window", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    const id1 = seedOrderInWindow();
    markOrderFilled(id1, {
      tx_hash: freshTxHash(), fill_price: 3000, base_amount: "1", quote_amount: "3000",
    });
    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.fires.ordersFilled).toBe(1);
    expect(r.fires.recentFills.length).toBe(1);
    expect(r.fires.recentFills[0].orderId).toBe(id1);
  });

  it("counts cancelled / expired / failed by transition time", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    const id1 = seedOrderInWindow();
    const id2 = seedOrderInWindow();
    const id3 = seedOrderInWindow();
    cancelOrder(id1);
    markOrderExpired(id2);
    markOrderFailed(id3, "TX_REVERTED", "boom");
    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.fires.ordersCancelled).toBe(1);
    expect(r.fires.ordersExpired).toBe(1);
    expect(r.fires.ordersFailed).toBe(1);
  });

  it("excludes orders that transitioned BEFORE the window", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    const id = seedOrderInWindow();
    markOrderFilled(id, {
      tx_hash: freshTxHash(), fill_price: 3000, base_amount: "1", quote_amount: "3000",
    });
    // Roll back updated_at + filled_at to a time outside the window.
    const db = openDb();
    db.prepare(`UPDATE orders SET updated_at = ?, filled_at = ? WHERE id = ?`).run(
      "2026-05-28T12:00:00Z", "2026-05-28T12:00:00Z", id,
    );
    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.fires.ordersFilled).toBe(0);
  });
});

// ── safety section ───────────────────────────────────────────

describe("gatherDigest — safety section", () => {
  it("counts safety blocks by code", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    seedAudit({ timestamp: "2026-05-30T11:00:00Z", errorCode: "DRAWDOWN_CIRCUIT_BREAKER_TRIPPED" });
    seedAudit({ timestamp: "2026-05-30T11:01:00Z", errorCode: "STRATEGY_BUDGET_EXCEEDED" });
    seedAudit({ timestamp: "2026-05-30T11:02:00Z", errorCode: "STRATEGY_BUDGET_EXCEEDED" });
    seedAudit({ timestamp: "2026-05-30T11:03:00Z", errorCode: "POSITION_LIMIT_EXCEEDED" });
    seedAudit({ timestamp: "2026-05-30T11:04:00Z", errorCode: "TOKEN_BLOCKED" });
    seedAudit({ timestamp: "2026-05-30T11:05:00Z", errorCode: "GAS_BUDGET_EXCEEDED" });

    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.safety.drawdownTrips).toBe(1);
    expect(r.safety.budgetBlocks).toBe(2);
    expect(r.safety.positionLimitBlocks).toBe(1);
    expect(r.safety.honeypotBlocks).toBe(1);
    expect(r.safety.gasBudgetBlocks).toBe(1);
  });

  it("includes currently-tripped drawdown scopes", async () => {    upsertDrawdownState({
      scopeKey: "global", peakUsd: 1000, peakAt: "2026-05-01T00:00:00Z",
      trippedAt: "2026-05-29T00:00:00Z", lastValueUsd: 700,
    });
    const now = new Date("2026-05-30T12:00:00Z");
    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.safety.drawdownCurrentlyTripped.length).toBe(1);
    expect(r.safety.drawdownCurrentlyTripped[0].scope).toBe("global");
    expect(r.safety.drawdownCurrentlyTripped[0].drawdownPct).toBeCloseTo(30, 5);
  });

  it("does not count trips outside the window", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    seedAudit({ timestamp: "2026-05-28T11:00:00Z", errorCode: "DRAWDOWN_CIRCUIT_BREAKER_TRIPPED" });
    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.safety.drawdownTrips).toBe(0);
  });
});

// ── errors section ───────────────────────────────────────────

describe("gatherDigest — errors section", () => {
  it("ranks top error codes + computes rate", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    seedAudit({ timestamp: "2026-05-30T11:01:00Z", errorCode: "SLIPPAGE_TOO_HIGH" });
    seedAudit({ timestamp: "2026-05-30T11:02:00Z", errorCode: "SLIPPAGE_TOO_HIGH" });
    seedAudit({ timestamp: "2026-05-30T11:03:00Z", errorCode: "SLIPPAGE_TOO_HIGH" });
    seedAudit({ timestamp: "2026-05-30T11:04:00Z", errorCode: "RPC_FAILED" });
    seedAudit({ timestamp: "2026-05-30T11:05:00Z" }); // success row

    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.errors.totalAuditRows).toBe(5);
    expect(r.errors.errorRows).toBe(4);
    expect(r.errors.errorRatePct).toBe(80);
    expect(r.errors.topErrors[0].code).toBe("SLIPPAGE_TOO_HIGH");
    expect(r.errors.topErrors[0].count).toBe(3);
  });

  it("zero-state when no audit rows", async () => {    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now: new Date("2026-05-30T12:00:00Z") });
    expect(r.errors.totalAuditRows).toBe(0);
    expect(r.errors.errorRatePct).toBe(0);
    expect(r.errors.topErrors).toEqual([]);
  });
});

// ── verdict classification ───────────────────────────────────

const emptyTrades = () => ({
  total: 0, success: 0, pending: 0, failed: 0,
  usdVolume: 0, successRatePct: 0,
  topStrategies: [], topBases: [],
});
const emptyFires = () => ({
  ordersFilled: 0, ordersCancelled: 0, ordersExpired: 0, ordersFailed: 0,
  schedulesFired: 0, rebalanceRuns: 0,
  scheduleJournalEnabled: false, scheduleFireCount: 0, scheduleFireFailures: 0, scheduleHookFailures: 0,
  rebalanceJournalEnabled: false, rebalanceExecutedCount: 0, rebalanceInBandCount: 0, rebalanceFailureCount: 0,
    signalsReceived: 0,
    signalsFired: 0,
  recentFills: [],
});
const emptyAlerts = () => ({ fired: 0, resolved: 0, currentlyActive: 0, topRules: [] });
const emptyPaper = () => ({ fills: 0, buys: 0, sells: 0, quoteVolume: 0, topStrategies: [] });
const emptySafety = () => ({
  drawdownTrips: 0, drawdownCurrentlyTripped: [] as { scope: string; trippedAt: string; drawdownPct: number | null }[],
  budgetBlocks: 0, positionLimitBlocks: 0, honeypotBlocks: 0, gasBudgetBlocks: 0,
  budgetWarnings: [] as { tag: string; window: "lifetime" | "daily"; utilizationPct: number }[],
});
const emptyErrors = () => ({
  totalAuditRows: 0, errorRows: 0, errorRatePct: 0,
  topErrors: [],
});

describe("classifyVerdict", () => {
  it("healthy on clean state", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(), safety: emptySafety(), errors: emptyErrors(), alerts: emptyAlerts(), paper: emptyPaper(),
    });
    expect(r.verdict).toBe("healthy");
    expect(r.verdictReasons).toEqual([]);
  });

  it("v57: EXPOSED posture lifts a clean window to attention", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(), safety: emptySafety(), errors: emptyErrors(), alerts: emptyAlerts(), paper: emptyPaper(),
      posture: { verdict: "exposed", criticalGaps: 1, warnGaps: 0, topGap: "no per-trade OR daily USD ceiling", binding: null },
    });
    expect(r.verdict).toBe("attention");
    expect(r.verdictReasons.some((x) => /posture EXPOSED/.test(x))).toBe(true);
  });

  it("v57: moderate posture does NOT elevate a clean window", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(), safety: emptySafety(), errors: emptyErrors(), alerts: emptyAlerts(), paper: emptyPaper(),
      posture: { verdict: "moderate", criticalGaps: 0, warnGaps: 1, topGap: "no token allow/deny list", binding: null },
    });
    expect(r.verdict).toBe("healthy");
  });

  it("v57: a binding limit approaching/exhausted → attention", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(), safety: emptySafety(), errors: emptyErrors(), alerts: emptyAlerts(), paper: emptyPaper(),
      posture: { verdict: "hardened", criticalGaps: 0, warnGaps: 0, topGap: null, binding: { label: "Daily USD cap", scope: "account:default × base", status: "approaching", utilizationPct: 92 } },
    });
    expect(r.verdict).toBe("attention");
    expect(r.verdictReasons.some((x) => /Daily USD cap.*approaching/.test(x))).toBe(true);
  });

  it("v57: a tripped DRAWDOWN binding is NOT double-counted (left to drawdownCurrentlyTripped)", async () => {    // Drawdown trips are already a critical signal; the posture binding rule
    // must skip drawdown to avoid a duplicate reason. With a clean safety
    // section, a drawdown-labelled binding contributes nothing.
    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(), safety: emptySafety(), errors: emptyErrors(), alerts: emptyAlerts(), paper: emptyPaper(),
      posture: { verdict: "hardened", criticalGaps: 0, warnGaps: 0, topGap: null, binding: { label: "Drawdown circuit breaker", scope: "global", status: "tripped", utilizationPct: 100 } },
    });
    expect(r.verdict).toBe("healthy");
    expect(r.verdictReasons).toEqual([]);
  });

  it("critical on drawdown trip in window", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(),
      safety: { ...emptySafety(), drawdownTrips: 1 },
      errors: emptyErrors(), alerts: emptyAlerts(), paper: emptyPaper(),
    });
    expect(r.verdict).toBe("critical");
  });

  it("critical on currently-tripped drawdown", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(),
      safety: { ...emptySafety(), drawdownCurrentlyTripped: [{ scope: "global", trippedAt: "x", drawdownPct: 20 }] },
      errors: emptyErrors(), alerts: emptyAlerts(), paper: emptyPaper(),
    });
    expect(r.verdict).toBe("critical");
  });

  it("critical on > 25% error rate", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(), safety: emptySafety(),
      errors: { ...emptyErrors(), errorRatePct: 30, totalAuditRows: 10, errorRows: 3 },
      alerts: emptyAlerts(), paper: emptyPaper(),
    });
    expect(r.verdict).toBe("critical");
  });

  it("attention on 10-25% error rate", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(), safety: emptySafety(),
      errors: { ...emptyErrors(), errorRatePct: 15, totalAuditRows: 20, errorRows: 3 },
      alerts: emptyAlerts(), paper: emptyPaper(),
    });
    expect(r.verdict).toBe("attention");
  });

  it("attention on budget utilization > 80%", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(),
      safety: { ...emptySafety(), budgetWarnings: [{ tag: "playbook:*", window: "lifetime", utilizationPct: 85 }] },
      errors: emptyErrors(), alerts: emptyAlerts(), paper: emptyPaper(),
    });
    expect(r.verdict).toBe("attention");
  });

  it("attention on safety blocks during window", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(),
      safety: { ...emptySafety(), positionLimitBlocks: 2 },
      errors: emptyErrors(), alerts: emptyAlerts(), paper: emptyPaper(),
    });
    expect(r.verdict).toBe("attention");
  });

  it("attention on failed orders", async () => {    const r = classifyVerdict({
      trades: emptyTrades(),
      fires: { ...emptyFires(), ordersFailed: 1 },
      safety: emptySafety(), errors: emptyErrors(), alerts: emptyAlerts(), paper: emptyPaper(),
    });
    expect(r.verdict).toBe("attention");
  });

  it("critical wins over attention", async () => {    const r = classifyVerdict({
      trades: emptyTrades(), fires: emptyFires(),
      safety: { ...emptySafety(), drawdownTrips: 1, positionLimitBlocks: 1, budgetWarnings: [{ tag: "x", window: "daily", utilizationPct: 90 }] },
      errors: { ...emptyErrors(), errorRatePct: 30, totalAuditRows: 10, errorRows: 3 },
      alerts: emptyAlerts(), paper: emptyPaper(),
    });
    expect(r.verdict).toBe("critical");
    // Multiple reasons accumulate even when the verdict is critical.
    expect(r.verdictReasons.length).toBeGreaterThan(1);
  });
});

describe("verdictEmoji + verdictLabel", () => {
  it("maps each verdict", async () => {    expect(verdictEmoji("healthy")).toBe("🟢");
    expect(verdictEmoji("attention")).toBe("🟡");
    expect(verdictEmoji("critical")).toBe("🔴");
    expect(verdictLabel("healthy")).toBe("healthy");
    expect(verdictLabel("attention")).toBe("attention");
    expect(verdictLabel("critical")).toBe("critical");
  });
});

// ── comparison deltas ────────────────────────────────────────

describe("gatherDigest — comparison", () => {
  it("computes prior-window deltas when compare=true", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    // Current window (last 24h): 2 trades + 200 USD
    seedTrade({ timestamp: "2026-05-30T11:00:00Z", status: "success", quoteAmount: "100" });
    seedTrade({ timestamp: "2026-05-30T10:00:00Z", status: "success", quoteAmount: "100" });
    // Prior window (24-48h ago): 5 trades + 500 USD
    for (let i = 0; i < 5; i++) {
      seedTrade({
        timestamp: `2026-05-29T${String(11 - i).padStart(2, "0")}:00:00Z`,
        status: "success", quoteAmount: "100",
      });
    }

    const r = await gatherDigest({
      windowLabel: "24h", windowMs: 24 * 3_600_000,
      compare: true, now,
    });
    expect(r.trades.total).toBe(2);
    expect(r.comparison).not.toBeNull();
    expect(r.comparison!.prior!.trades.total).toBe(5);
    expect(r.comparison!.delta.trades).toBe(-3); // 2 - 5
    expect(r.comparison!.delta.usdVolume).toBe(-300); // 200 - 500
  });

  it("comparison=null by default", async () => {    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now: new Date("2026-05-30T12:00:00Z") });
    expect(r.comparison).toBeNull();
  });
});

// ── full-shape integration ───────────────────────────────────

describe("gatherDigest — full shape", () => {
  it("returns generatedAt + window boundaries", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.generatedAt).toBe("2026-05-30T12:00:00.000Z");
    expect(r.windowEnd).toBe("2026-05-30T12:00:00.000Z");
    expect(r.windowStart).toBe("2026-05-29T12:00:00.000Z");
    expect(r.windowLabel).toBe("24h");
  });

  it("zero-state digest is shaped", async () => {
    // v57: the digest verdict now reflects the STANDING safety posture. A
    // zero-activity window is only "healthy" when the config isn't EXPOSED,
    // so seed a per-tx USD ceiling (the default config has no ceiling →
    // exposed → attention, which is the posture rule working as intended).
    const { configSchema } = await import("./config.js");
    const baseCfg = configSchema.parse({});
    const config = { ...baseCfg, safety: { ...baseCfg.safety, perTxUsdLimit: 1000 } };
    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now: new Date("2026-05-30T12:00:00Z"), config });
    expect(r.verdict).toBe("healthy");
    expect(r.trades.total).toBe(0);
    expect(r.fires.ordersFilled).toBe(0);
    expect(r.errors.errorRows).toBe(0);
    expect(r.posture?.verdict).toBe("moderate"); // ceiling set, but no token list → moderate
  });

  it("v57: an EXPOSED config (no USD ceiling) lifts a zero-activity digest to attention", async () => {    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now: new Date("2026-05-30T12:00:00Z") });
    expect(r.posture?.verdict).toBe("exposed");
    expect(r.verdict).toBe("attention");
    expect(r.verdictReasons.some((x) => /posture EXPOSED/.test(x))).toBe(true);
  });
});

// ── unused-import suppression ────────────────────────────────

void insertSchedule;
void insertRebalancePlan;

// ── v28/v29 sections ─────────────────────────────────────────

describe("gatherDigest — alerts / paper / journal-exact fires", () => {
  const now = new Date("2026-05-30T12:00:00Z");
  const win = { windowLabel: "24h", windowMs: 24 * 3_600_000, now };

  it("alerts section counts window transitions + currently-active snapshot", async () => {    insertAlertEvent({ at: "2026-05-30T10:00:00Z", tag: "a", ruleType: "failure_streak", event: "fired", severity: "critical" });
    insertAlertEvent({ at: "2026-05-30T11:00:00Z", tag: "a", ruleType: "failure_streak", event: "resolved", severity: "info", durationSeconds: 3600 });
    insertAlertEvent({ at: "2026-05-30T11:30:00Z", tag: "b", ruleType: "staleness", event: "fired", severity: "warn" });
    insertAlertEvent({ at: "2026-05-28T00:00:00Z", tag: "c", ruleType: "staleness", event: "fired", severity: "warn" }); // outside window
    upsertStrategyAlertState({
      tag: "b", ruleType: "staleness", active: true,
      firstTriggeredAt: "2026-05-30T11:30:00Z", lastEvaluatedAt: "2026-05-30T11:30:00Z", lastValueJson: null,
    });

    const r = await gatherDigest(win);
    expect(r.alerts.fired).toBe(2);
    expect(r.alerts.resolved).toBe(1);
    expect(r.alerts.currentlyActive).toBe(1);
    expect(r.alerts.topRules[0]).toMatchObject({ fired: 1 });
    // Alert in window → attention verdict with the reason named.
    expect(r.verdict).not.toBe("healthy");
    expect(r.verdictReasons.some((x) => x.includes("strategy alert"))).toBe(true);
  });

  it("paper section counts window fills with strategy breakdown", async () => {    const mk = (ts: string, dir: "buy" | "sell", strategy: string | null) =>
      recordPaperTrade({
        timestamp: ts, source_type: "schedule", source_id: 1, chain: "base", account: "default",
        direction: dir, base_token: "0xw", base_symbol: "ETH", base_amount: "0.1",
        quote_token: "0xu", quote_symbol: "USDC", quote_amount: "200", price: "2000",
        slippage_bps: 0, strategy, notes: null,
      });
    mk("2026-05-30T10:00:00Z", "buy", "dca");
    mk("2026-05-30T11:00:00Z", "sell", "dca");
    mk("2026-05-29T00:00:00Z", "buy", "dca"); // outside window
    const r = await gatherDigest(win);
    expect(r.paper.fills).toBe(2);
    expect(r.paper.buys).toBe(1);
    expect(r.paper.sells).toBe(1);
    expect(r.paper.quoteVolume).toBeCloseTo(400, 6);
    expect(r.paper.topStrategies[0]).toMatchObject({ strategy: "dca", count: 2 });
  });

  it("journal-exact fire counts: a busy schedule shows its true count (legacy shows 1)", async () => {    const id = insertSchedule({
      name: "busy", cron_expr: "0 * * * *", next_run_at: "2026-05-30T13:00:00Z",
      side: "buy", chain: "base", account: "default",
      base_token: "0xw", base_symbol: "ETH", quote_token: "0xu", quote_symbol: "USDC",
      base_amount: null, quote_amount: "100", slippage_bps: null, auto_slippage: false,
      start_at: null, end_at: null, max_runs: null, strategy: "t", note: null,
    });
    openDb().prepare(`UPDATE schedules SET last_run_at = '2026-05-30T11:00:00Z' WHERE id = ?`).run(id);
    for (const h of ["08", "09", "10"]) {
      insertScheduleCheckEntry({ scheduleId: id, checkedAt: `2026-05-30T${h}:00:00Z`, decision: "fired", runNumber: 1 });
    }
    insertScheduleCheckEntry({ scheduleId: id, checkedAt: "2026-05-30T11:00:00Z", decision: "fire_failed", errorCode: "X" });
    insertRebalanceCheckEntry({ planId: 9, checkedAt: "2026-05-30T10:30:00Z", decision: "in_band", maxDriftPct: 2 });
    insertRebalanceCheckEntry({ planId: 9, checkedAt: "2026-05-30T11:30:00Z", decision: "partial_failure", errorCode: "PARTIAL_FAILURE" });

    const r = await gatherDigest(win);
    expect(r.fires.schedulesFired).toBe(1); // legacy approximation unchanged
    expect(r.fires.scheduleFireCount).toBe(3); // journal truth
    expect(r.fires.scheduleFireFailures).toBe(1);
    expect(r.fires.rebalanceInBandCount).toBe(1);
    expect(r.fires.rebalanceFailureCount).toBe(1);
    expect(r.verdictReasons.some((x) => x.includes("schedule fire failure"))).toBe(true);
    expect(r.verdictReasons.some((x) => x.includes("rebalance failure"))).toBe(true);
  });

  it("comparison delta includes alertsFired + paperFills", async () => {    insertAlertEvent({ at: "2026-05-30T10:00:00Z", tag: "a", ruleType: "staleness", event: "fired", severity: "warn" });
    insertAlertEvent({ at: "2026-05-29T06:00:00Z", tag: "a", ruleType: "staleness", event: "fired", severity: "warn" }); // prior window
    const r = await gatherDigest({ ...win, compare: true });
    expect(r.comparison?.delta.alertsFired).toBe(0); // 1 now vs 1 prior
    expect(r.comparison?.prior?.alerts.fired).toBe(1);
  });
});

// ── v38: equity section ──────────────────────────────────────

describe("gatherDigest — equity section", () => {
  it("reports the window's equity move from the snapshot feed", async () => {
    const { insertPortfolioSnapshot, openDb } = await import("./db.js");
    const now = Date.now();
    insertPortfolioSnapshot({
      timestamp: new Date(now - 20 * 3_600_000).toISOString(),
      total_usd: 1000, accounts_key: "default", chains_key: "base",
      token_count: 2, note: "engine-auto", data: "{}",
    });
    insertPortfolioSnapshot({
      timestamp: new Date(now - 1 * 3_600_000).toISOString(),
      total_usd: 1150, accounts_key: "default", chains_key: "base",
      token_count: 2, note: "engine-auto", data: "{}",
    });
    try {
      const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000 });
      expect(r.equity).not.toBeNull();
      expect(r.equity!.startUsd).toBe(1000);
      expect(r.equity!.endUsd).toBe(1150);
      expect(r.equity!.changeAbs).toBe(150);
      expect(r.equity!.changePct).toBeCloseTo(15, 6);
    } finally {
      openDb().exec("DELETE FROM portfolio_snapshots");
    }
  });

  it("equity is null with fewer than two points — the digest never fails on it", async () => {    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000 });
    expect(r.equity).toBeNull();
    expect(r.verdict).toBeDefined();
  });
});

describe("gatherDigest — signal counts (v36.5)", () => {
  it("counts received vs fired in the window", async () => {
    const { insertSignalEvent, consumeSignalEvent, openDb } = await import("./db.js");
    const now = new Date().toISOString();
    const a = insertSignalEvent({ name: "s1", receivedAt: now, source: "cli" });
    insertSignalEvent({ name: "s2", receivedAt: now, source: "webhook" }); // never fires
    consumeSignalEvent(a, now, 42);
    try {
      const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000 });
      expect(r.fires.signalsReceived).toBe(2);
      expect(r.fires.signalsFired).toBe(1);
    } finally {
      openDb().exec("DELETE FROM signal_events");
    }
  });
});

// ── strategy section (v88) ───────────────────────────────────

describe("gatherDigest — strategy section", () => {
  const WETH = "0xeeee";
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  function tr(strategy: string, dir: "buy" | "sell", amount: string, quote: string, ts: string) {
    insertTrade({
      timestamp: ts, chain: "base", account: "default", direction: dir,
      base_token: WETH, base_symbol: "WETH", base_amount: amount,
      quote_token: USDC, quote_symbol: "USDC", quote_amount: quote, price: "0",
      tx_hash: freshTxHash(), status: "success",
      gas_used: null, gas_price_wei: null, gas_cost_native: null,
      aggregator: null, fee_tier: null, notes: null, strategy,
    });
  }

  it("rolls up per-strategy realized P&L + flags bleeders", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    tr("winner", "buy", "1", "2000", "2026-05-30T09:00:00Z");
    tr("winner", "sell", "1", "2600", "2026-05-30T10:00:00Z"); // +600
    tr("loser", "buy", "1", "2000", "2026-05-30T09:00:00Z");
    tr("loser", "sell", "1", "1700", "2026-05-30T10:00:00Z"); // -300
    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.strategy).not.toBeNull();
    expect(r.strategy!.count).toBe(2);
    expect(r.strategy!.best!.strategy).toBe("winner");
    expect(r.strategy!.best!.realizedUsd).toBeCloseTo(600, 6);
    expect(r.strategy!.bleeding).toEqual(["loser"]);
    // a bleeding strategy pushes the verdict to attention with a named reason.
    expect(r.verdict === "attention" || r.verdict === "critical").toBe(true);
    expect(r.verdictReasons.some((x) => /bleeding/.test(x))).toBe(true);
  });

  it("is null when no priced strategy trades fall in the window", async () => {    const now = new Date("2026-05-30T12:00:00Z");
    const r = await gatherDigest({ windowLabel: "24h", windowMs: 24 * 3_600_000, now });
    expect(r.strategy ?? null).toBeNull();
  });
});

describe("classifyVerdict — strategy bleeding (v88)", () => {
  const base = {
    trades: { total: 0, success: 0, failed: 0, pending: 0, usdVolume: 0, successRatePct: null } as unknown as Parameters<typeof classifyVerdict>[0]["trades"],
    fires: { ordersFilled: 0, ordersFailed: 0, scheduleFireFailures: 0, rebalanceFailureCount: 0 } as unknown as Parameters<typeof classifyVerdict>[0]["fires"],
    safety: { drawdownTrips: 0, drawdownCurrentlyTripped: [], budgetWarnings: [], budgetBlocks: 0, positionLimitBlocks: 0, honeypotBlocks: 0, gasBudgetBlocks: 0 } as unknown as Parameters<typeof classifyVerdict>[0]["safety"],
    errors: { errorRows: 0, errorRatePct: 0 } as unknown as Parameters<typeof classifyVerdict>[0]["errors"],
    alerts: { fired: 0 } as unknown as Parameters<typeof classifyVerdict>[0]["alerts"],
    paper: {} as unknown as Parameters<typeof classifyVerdict>[0]["paper"],
  };

  it("a bleeding strategy → attention", async () => {    const r = classifyVerdict({ ...base, strategy: { count: 2, totalRealizedUsd: -50, best: null, worst: { strategy: "dca", realizedUsd: -300 }, bleeding: ["dca"] } });
    expect(r.verdict).toBe("attention");
    expect(r.verdictReasons.some((x) => /bleeding.*dca/.test(x))).toBe(true);
  });

  it("no bleeders → healthy (strategy section doesn't false-trigger)", async () => {    const r = classifyVerdict({ ...base, strategy: { count: 2, totalRealizedUsd: 900, best: { strategy: "a", realizedUsd: 900 }, worst: { strategy: "b", realizedUsd: 100 }, bleeding: [] } });
    expect(r.verdict).toBe("healthy");
  });

  // v95: promote-outcome divergence escalation.
  it("a DIVERGED promoted strategy → critical", async () => {
    const r = classifyVerdict({
      ...base,
      promote: {
        checked: 2,
        flagged: [{ playbookId: 7, name: "dca-eth", verdict: "diverged", topReason: "not making money with real execution" }],
        worst: { playbookId: 7, name: "dca-eth", verdict: "diverged" },
      },
    });
    expect(r.verdict).toBe("critical");
    expect(r.verdictReasons.some((x) => /DIVERGED.*dca-eth #7/.test(x))).toBe(true);
  });

  it("an underperforming (not diverged) promoted strategy → attention", async () => {
    const r = classifyVerdict({
      ...base,
      promote: {
        checked: 1,
        flagged: [{ playbookId: 3, name: "grid", verdict: "underperforming", topReason: "edge shrank in production" }],
        worst: { playbookId: 3, name: "grid", verdict: "underperforming" },
      },
    });
    expect(r.verdict).toBe("attention");
    expect(r.verdictReasons.some((x) => /underperforming.*grid #3/.test(x))).toBe(true);
  });

  it("diverged outranks underperforming for the verdict (critical), both reasons surface", async () => {
    const r = classifyVerdict({
      ...base,
      promote: {
        checked: 3,
        flagged: [
          { playbookId: 3, name: "grid", verdict: "underperforming", topReason: "edge shrank" },
          { playbookId: 7, name: "dca", verdict: "diverged", topReason: "losing live" },
        ],
        worst: { playbookId: 7, name: "dca", verdict: "diverged" },
      },
    });
    expect(r.verdict).toBe("critical");
    expect(r.verdictReasons.some((x) => /DIVERGED/.test(x))).toBe(true);
    expect(r.verdictReasons.some((x) => /underperforming/.test(x))).toBe(true);
  });

  it("no flagged promoted strategies → no escalation", async () => {
    const r = classifyVerdict({ ...base, promote: { checked: 4, flagged: [], worst: null } });
    expect(r.verdict).toBe("healthy");
  });
});

// ── v95: promote-outcome section (end-to-end through gatherDigest) ───
describe("gatherDigest — promote-outcome divergence section", () => {
  const NOW = new Date("2026-06-14T12:00:00Z");
  const WIN = { windowLabel: "30d", windowMs: 30 * 86_400_000, now: NOW };
  const WETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  function deployedPlaybook(): number {
    const id = insertPlaybook({ name: "dca-eth", sourcePath: null, sourceHash: "h", specJson: JSON.stringify({ name: "dca-eth", chain: "base", account: "default", strategies: [] }) });
    updatePlaybookStatus(id, "deployed");
    return id;
  }
  // paper round-trips: buy@buyPx then sell@sellPx, `pairs` times.
  function seedPaper(id: number, pairs: number, buyPx: number, sellPx: number): void {
    const total = pairs * 2;
    let n = 0;
    for (let p = 0; p < pairs; p++) {
      for (const [dir, px] of [["buy", buyPx], ["sell", sellPx]] as const) {
        recordPaperTrade({
          timestamp: new Date(NOW.getTime() - (total - n) * (10 / total) * 86_400_000).toISOString(),
          source_type: "schedule", source_id: 1,
          chain: "base", account: "default", direction: dir,
          base_token: WETH, base_symbol: "WETH", base_amount: "0.05",
          quote_token: USDC, quote_symbol: "USDC", quote_amount: String(px * 0.05),
          price: String(px), slippage_bps: 30, strategy: `playbook:${id}`, notes: null,
        });
        n++;
      }
    }
  }
  function seedLive(id: number, pairs: number, buyPx: number, sellPx: number): void {
    const total = pairs * 2;
    let n = 0;
    for (let p = 0; p < pairs; p++) {
      for (const [dir, px] of [["buy", buyPx], ["sell", sellPx]] as const) {
        insertTrade({
          timestamp: new Date(NOW.getTime() - (total - n) * (4 / total) * 86_400_000).toISOString(),
          chain: "base", account: "default", direction: dir,
          base_token: WETH, base_symbol: "WETH", base_amount: "0.05",
          quote_token: USDC, quote_symbol: "USDC", quote_amount: String(px * 0.05),
          price: String(px), tx_hash: freshTxHash(), status: "success",
          gas_used: null, gas_price_wei: null, gas_cost_native: "0.001",
          aggregator: "kyberswap", fee_tier: null, notes: null,
          strategy: `playbook:${id}`, realized_slippage_bps: 30,
        });
        n++;
      }
    }
  }

  it("null when there are no deployed playbooks", async () => {
    const r = await gatherDigest(WIN);
    expect(r.promote ?? null).toBeNull();
  });

  it("flags a promoted strategy that profits on paper but loses live → diverged + critical verdict", async () => {
    const id = deployedPlaybook();
    seedPaper(id, 5, 2000, 2100); // paper: +$100/ETH edge → positive realized
    seedLive(id, 3, 2000, 1900);  // live: sells below cost → realized ≤ 0
    const r = await gatherDigest(WIN);
    expect(r.promote).not.toBeNull();
    expect(r.promote!.checked).toBe(1);
    expect(r.promote!.flagged).toHaveLength(1);
    expect(r.promote!.flagged[0]).toMatchObject({ playbookId: id, name: "dca-eth", verdict: "diverged" });
    expect(r.verdict).toBe("critical");
    expect(r.verdictReasons.some((x) => /DIVERGED/.test(x))).toBe(true);
  });

  it("an on-track promoted strategy is NOT flagged (section present, empty)", async () => {
    const id = deployedPlaybook();
    seedPaper(id, 5, 2000, 2100);
    seedLive(id, 3, 2000, 2100); // live tracks paper
    const r = await gatherDigest(WIN);
    expect(r.promote!.checked).toBe(1);
    expect(r.promote!.flagged).toHaveLength(0);
    // promote alone doesn't escalate; the verdict is driven by other sections.
    expect(r.verdictReasons.some((x) => /promoted strateg/.test(x))).toBe(false);
  });
});
