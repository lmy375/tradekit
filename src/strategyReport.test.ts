// Tests for the unified strategy report (iter31). The module mixes
// pure aggregation with DB I/O — we test the pure layer in
// isolation where possible (so the math is verifiable without
// fixture setup) and the integration layer end-to-end with a
// seeded DB.
//
// Layers:
//   1. tag normalization + mode resolution (pure)
//   2. composition / performance / position / risk / activity /
//      forward — each tested with synthetic inputs
//   3. end-to-end buildStrategyReport against a seeded DB

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-strategy-report-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  buildStrategyReport,
  normalizeTag,
  playbookIdFromTag,
  resolveMode,
  _buildComposition,
  _buildPerformance,
  _buildPosition,
  _buildRisk,
  _buildActivity,
  _buildForward,
  _buildIdentity,
} = await import("./strategyReport.js");
const {
  openDb,
  closeDb,
  insertOrder,
  insertSchedule,
  insertTrade,
  insertPlaybook,
  recordPaperTrade,
  upsertDrawdownState,
  markOrderFilled,
  markOrderFailed,
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
  db.exec("DELETE FROM paper_balances");
  db.exec("DELETE FROM playbooks");
  db.exec("DELETE FROM drawdown_state");
  db.exec("DELETE FROM order_check_log");
  vi.clearAllMocks();
});

// ── 1) tag resolution ───────────────────────────────────────

describe("normalizeTag", () => {
  it("maps bare numbers to playbook:N", () => {
    expect(normalizeTag("1")).toBe("playbook:1");
    expect(normalizeTag("42")).toBe("playbook:42");
    expect(normalizeTag(" 7 ")).toBe("playbook:7");
  });
  it("passes free-form tags through unchanged", () => {
    expect(normalizeTag("dca-eth")).toBe("dca-eth");
    expect(normalizeTag("playbook:1")).toBe("playbook:1");
    expect(normalizeTag("rebal-q1")).toBe("rebal-q1");
  });
});

describe("playbookIdFromTag", () => {
  it("extracts id from playbook:N tags", () => {
    expect(playbookIdFromTag("playbook:1")).toBe(1);
    expect(playbookIdFromTag("playbook:42")).toBe(42);
  });
  it("returns null for free-form tags", () => {
    expect(playbookIdFromTag("dca-eth")).toBeNull();
    expect(playbookIdFromTag("playbook:abc")).toBeNull();
    expect(playbookIdFromTag("")).toBeNull();
  });
});

// ── 2) resolveMode ──────────────────────────────────────────

describe("resolveMode", () => {
  it("honors explicit mode override", () => {
    expect(resolveMode({ mode: "real", orders: [], schedules: [], realTradeCount: 0, paperTradeCount: 99 })).toBe("real");
    expect(resolveMode({ mode: "paper", orders: [], schedules: [], realTradeCount: 99, paperTradeCount: 0 })).toBe("paper");
  });
  it("auto: all active primitives paper → paper", () => {
    const orders = [{ status: "active", paper: 1 } as never];
    expect(resolveMode({ mode: "auto", orders, schedules: [], realTradeCount: 0, paperTradeCount: 0 })).toBe("paper");
  });
  it("auto: any active real primitive → real", () => {
    const orders = [{ status: "active", paper: 0 } as never, { status: "active", paper: 1 } as never];
    expect(resolveMode({ mode: "auto", orders, schedules: [], realTradeCount: 0, paperTradeCount: 0 })).toBe("real");
  });
  it("auto: no active primitives + only paper trades → paper", () => {
    expect(resolveMode({ mode: "auto", orders: [], schedules: [], realTradeCount: 0, paperTradeCount: 3 })).toBe("paper");
  });
  it("auto: no active primitives + only real trades → real", () => {
    expect(resolveMode({ mode: "auto", orders: [], schedules: [], realTradeCount: 3, paperTradeCount: 0 })).toBe("real");
  });
  it("auto: nothing at all → real (safe default)", () => {
    expect(resolveMode({ mode: "auto", orders: [], schedules: [], realTradeCount: 0, paperTradeCount: 0 })).toBe("real");
  });
});

// ── 3) buildComposition ─────────────────────────────────────

describe("buildComposition", () => {
  const baseOrder = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      id: 1,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      status: "active",
      side: "sell",
      trigger_type: "price_below",
      target_price_usd: 2000,
      trail_pct: null,
      water_mark_usd: null,
      chain: "base",
      account: "default",
      base_token: "0xeth",
      base_symbol: "ETH",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      base_amount: "1",
      quote_amount: null,
      slippage_bps: null,
      auto_slippage: 0,
      expires_at: null,
      strategy: "playbook:1",
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
      paper: 0,
      ...over,
    }) as never;

  it("counts primitives by type + lifecycle", () => {
    const comp = _buildComposition({
      orders: [
        baseOrder({ id: 1, status: "active" }),
        baseOrder({ id: 2, status: "filled" }),
        baseOrder({ id: 3, status: "failed" }),
      ],
      schedules: [],
      rebalances: [],
    });
    expect(comp.totals.orders).toBe(3);
    expect(comp.lifecycle.active).toBe(1);
    expect(comp.lifecycle.filled).toBe(1);
    expect(comp.lifecycle.failed).toBe(1);
    expect(comp.primitives).toHaveLength(3);
    // Sorted by kind then id.
    expect(comp.primitives.map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it("formats summary for trailing orders", () => {
    const trailing = baseOrder({
      id: 7,
      trigger_type: "trailing",
      trail_pct: 5,
      target_price_usd: null,
    });
    const comp = _buildComposition({ orders: [trailing], schedules: [], rebalances: [] });
    expect(comp.primitives[0].summary).toMatch(/trailing 5%/);
  });

  it("marks paper primitives", () => {
    const paper = baseOrder({ id: 5, paper: 1 });
    const comp = _buildComposition({ orders: [paper], schedules: [], rebalances: [] });
    expect(comp.primitives[0].paper).toBe(true);
  });
});

// ── 4) buildPerformance ─────────────────────────────────────

describe("buildPerformance (real)", () => {
  const makeTrade = (over: Partial<Record<string, unknown>>) =>
    ({
      id: 1,
      timestamp: "2026-05-01T00:00:00Z",
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: "0xeth",
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      quote_amount: "2000",
      price: "2000",
      tx_hash: "0xaaa",
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      strategy: "playbook:1",
      realized_slippage_bps: 20,
      ...over,
    }) as never;

  it("counts fills + failures", () => {
    const perf = _buildPerformance({
      trades: [
        makeTrade({ status: "success" }),
        makeTrade({ status: "success", direction: "sell", quote_amount: "2200" }),
        makeTrade({ status: "failed" }),
      ],
      isPaper: false,
      sinceIso: null,
    });
    expect(perf.fills).toBe(2);
    expect(perf.failures).toBe(1);
    expect(perf.successRate).toBeCloseTo(2 / 3);
    expect(perf.buyCount).toBe(1);
    expect(perf.sellCount).toBe(1);
  });

  it("sums quote spent + received + net", () => {
    const perf = _buildPerformance({
      trades: [
        makeTrade({ direction: "buy", quote_amount: "1000" }),
        makeTrade({ direction: "buy", quote_amount: "500" }),
        makeTrade({ direction: "sell", quote_amount: "2000" }),
      ],
      isPaper: false,
      sinceIso: null,
    });
    expect(perf.realizedQuoteSpent).toBe(1500);
    expect(perf.realizedQuoteReceived).toBe(2000);
    expect(perf.realizedNetQuote).toBe(500);
  });

  it("computes slippage stats from successful real trades only", () => {
    const perf = _buildPerformance({
      trades: [
        makeTrade({ realized_slippage_bps: 10 }),
        makeTrade({ realized_slippage_bps: 30 }),
        makeTrade({ realized_slippage_bps: 50 }),
        makeTrade({ realized_slippage_bps: 100 }),
        makeTrade({ status: "failed", realized_slippage_bps: 999 }),
      ],
      isPaper: false,
      sinceIso: null,
    });
    expect(perf.avgSlippageBps).toBeCloseTo((10 + 30 + 50 + 100) / 4);
    expect(perf.maxSlippageBps).toBe(100);
    expect(perf.p50SlippageBps).toBe(50); // index 2 of 4 sorted
    expect(perf.p95SlippageBps).toBe(100);
  });

  it("applies window filter via sinceIso", () => {
    const perf = _buildPerformance({
      trades: [
        makeTrade({ timestamp: "2025-01-01T00:00:00Z", quote_amount: "9999" }), // before window
        makeTrade({ timestamp: "2026-05-15T00:00:00Z", quote_amount: "100" }),
      ],
      isPaper: false,
      sinceIso: "2026-05-01T00:00:00Z",
    });
    expect(perf.fills).toBe(1);
    expect(perf.realizedQuoteSpent).toBe(100);
  });
});

describe("buildPerformance (paper)", () => {
  const makePaper = (over: Partial<Record<string, unknown>>) =>
    ({
      id: 1,
      timestamp: "2026-05-01T00:00:00Z",
      source_type: "order",
      source_id: 1,
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: "0xeth",
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      quote_amount: "2000",
      price: "2000",
      slippage_bps: 50,
      strategy: "playbook:1",
      notes: null,
      ...over,
    }) as never;

  it("counts every row as a fill (paper trades never fail)", () => {
    const perf = _buildPerformance({
      trades: [makePaper({}), makePaper({ direction: "sell", quote_amount: "2200" })],
      isPaper: true,
      sinceIso: null,
    });
    expect(perf.fills).toBe(2);
    expect(perf.failures).toBe(0);
    expect(perf.successRate).toBe(1);
  });

  it("leaves slippage stats null in paper mode (no realized_slippage_bps)", () => {
    const perf = _buildPerformance({
      trades: [makePaper({})],
      isPaper: true,
      sinceIso: null,
    });
    expect(perf.avgSlippageBps).toBeNull();
    expect(perf.maxSlippageBps).toBeNull();
  });
});

// ── 5) buildPosition ────────────────────────────────────────

describe("buildPosition", () => {
  const makeTrade = (over: Partial<Record<string, unknown>>) =>
    ({
      timestamp: "2026-05-01T00:00:00Z",
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: "0xETH",
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: "0xUSDC",
      quote_symbol: "USDC",
      quote_amount: "2000",
      price: "2000",
      tx_hash: "0x1",
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "k",
      fee_tier: null,
      notes: null,
      strategy: "x",
      ...over,
    }) as never;

  it("accumulates net base position across buys/sells", () => {
    const pos = _buildPosition({
      trades: [
        makeTrade({ direction: "buy", base_amount: "1", quote_amount: "2000" }),
        makeTrade({ direction: "buy", base_amount: "0.5", quote_amount: "1100" }),
        makeTrade({ direction: "sell", base_amount: "0.3", quote_amount: "750" }),
      ],
      isPaper: false,
    });
    const base = pos.positions.find((p) => p.role === "base");
    expect(base).toBeDefined();
    expect(parseFloat(base!.netAmount)).toBeCloseTo(1 + 0.5 - 0.3);
    const quote = pos.positions.find((p) => p.role === "quote");
    expect(parseFloat(quote!.netAmount)).toBeCloseTo(-(2000 + 1100 - 750));
  });

  it("skips failed real trades", () => {
    const pos = _buildPosition({
      trades: [
        makeTrade({ status: "success", base_amount: "1", quote_amount: "2000" }),
        makeTrade({ status: "failed", base_amount: "100", quote_amount: "999999" }),
      ],
      isPaper: false,
    });
    const base = pos.positions.find((p) => p.role === "base");
    expect(parseFloat(base!.netAmount)).toBeCloseTo(1);
  });

  it("includes paper rows verbatim (all paper rows are successful)", () => {
    const paperRow = {
      timestamp: "2026-05-01T00:00:00Z",
      chain: "base",
      direction: "buy",
      base_token: "0xeth",
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      quote_amount: "2000",
    } as never;
    const pos = _buildPosition({
      trades: [paperRow],
      isPaper: true,
    });
    expect(pos.positions.length).toBeGreaterThan(0);
  });

  it("hides near-zero rounding artifacts", () => {
    const pos = _buildPosition({
      trades: [
        makeTrade({ direction: "buy", base_amount: "1", quote_amount: "2000" }),
        makeTrade({ direction: "sell", base_amount: "1", quote_amount: "2000" }),
      ],
      isPaper: false,
    });
    // Net is 0; rows should be filtered out.
    expect(pos.positions).toHaveLength(0);
  });
});

// ── 6) buildRisk ────────────────────────────────────────────

describe("buildRisk", () => {
  const baseConfig = {
    safety: {
      strategyBudgets: [
        { tag: "playbook:1", lifetimeUsd: 1000, dailyUsd: 200, perFireUsd: 50 },
        { tag: "rebal-*", lifetimeUsd: 5000 },
      ],
    },
  } as never;

  it("returns matching exact-tag budgets with consumption", () => {
    const risk = _buildRisk({
      tag: "playbook:1",
      config: baseConfig,
      drawdownLookup: () => null,
      spentLookup: (_tag, since) => (since ? 50 : 300),
    });
    expect(risk.budgets).toHaveLength(1);
    expect(risk.budgets[0].pattern).toBe("playbook:1");
    expect(risk.budgets[0].lifetimeSpentUsd).toBe(300);
    expect(risk.budgets[0].lifetimePctUsed).toBeCloseTo(30);
    expect(risk.budgets[0].dailySpentUsd).toBe(50);
    expect(risk.budgets[0].perFireUsd).toBe(50);
  });

  it("matches wildcard patterns", () => {
    const risk = _buildRisk({
      tag: "rebal-q1",
      config: baseConfig,
      drawdownLookup: () => null,
      spentLookup: () => 1000,
    });
    expect(risk.budgets).toHaveLength(1);
    expect(risk.budgets[0].pattern).toBe("rebal-*");
    expect(risk.budgets[0].lifetimeUsd).toBe(5000);
  });

  it("surfaces per-strategy drawdown by scope key", () => {
    const risk = _buildRisk({
      tag: "playbook:1",
      config: baseConfig,
      drawdownLookup: (key) =>
        key === "strategy:playbook:1"
          ? {
              scope_key: key,
              peak_usd: 10_000,
              peak_at: "2026-05-01T00:00:00Z",
              last_value_usd: 9_500,
              tripped_at: null,
              updated_at: "2026-05-15T00:00:00Z",
            } as never
          : null,
      spentLookup: () => 0,
    });
    expect(risk.drawdown).not.toBeNull();
    expect(risk.drawdown!.drawdownPct).toBeCloseTo(5);
    expect(risk.drawdown!.tripped).toBe(false);
  });

  it("returns null drawdown when scope row absent", () => {
    const risk = _buildRisk({
      tag: "playbook:1",
      config: baseConfig,
      drawdownLookup: () => null,
      spentLookup: () => 0,
    });
    expect(risk.drawdown).toBeNull();
  });
});

// ── 7) buildActivity ────────────────────────────────────────

describe("buildActivity", () => {
  const realTrade = (over: Partial<Record<string, unknown>>) =>
    ({
      id: 1,
      timestamp: "2026-05-01T00:00:00Z",
      chain: "base",
      direction: "buy",
      base_token: "0xeth",
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      quote_amount: "2000",
      price: "2000",
      tx_hash: "0xfilled",
      status: "success",
      strategy: "x",
      ...over,
    }) as never;

  it("sorts fills + failures newest-first", () => {
    const act = _buildActivity({
      trades: [
        realTrade({ id: 1, timestamp: "2026-05-01T00:00:00Z" }),
        realTrade({ id: 2, timestamp: "2026-05-10T00:00:00Z" }),
        realTrade({ id: 3, timestamp: "2026-05-05T00:00:00Z", status: "failed", revert_reason: "bad route" }),
      ],
      isPaper: false,
      orderIds: [],
      journalLookup: () => [],
    });
    expect(act.recentFills.map((f) => f.primitiveId)).toEqual([2, 1]);
    expect(act.recentFailures).toHaveLength(1);
    expect(act.recentFailures[0].summary).toMatch(/bad route/);
  });

  it("paper mode tags every row as fill", () => {
    const paperRow = {
      id: 1,
      timestamp: "2026-05-01T00:00:00Z",
      source_type: "order",
      source_id: 7,
      chain: "base",
      account: "default",
      direction: "buy" as const,
      base_token: "0xeth",
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      quote_amount: "2000",
      price: "2000",
      slippage_bps: 50,
      strategy: "x",
      notes: null,
    };
    const act = _buildActivity({
      trades: [paperRow as never],
      isPaper: true,
      orderIds: [],
      journalLookup: () => [],
    });
    expect(act.recentFills).toHaveLength(1);
    expect(act.recentFailures).toHaveLength(0);
    expect(act.recentFills[0].primitiveId).toBe(7);
  });

  it("merges journal entries from multiple orders", () => {
    const act = _buildActivity({
      trades: [],
      isPaper: false,
      orderIds: [1, 2],
      journalLookup: (orderId) => [
        {
          id: orderId * 10,
          order_id: orderId,
          checked_at: `2026-05-0${orderId}T00:00:00Z`,
          price_usd: 100 * orderId,
          water_mark_usd: null,
          threshold_usd: 100,
          decision: "skipped_not_triggered" as never,
          notes: "below threshold",
        },
      ],
    });
    expect(act.recentJournal).toHaveLength(2);
    // Sorted newest-first.
    expect(act.recentJournal[0].primitiveId).toBe(2);
  });
});

// ── 8) buildForward ─────────────────────────────────────────

describe("buildForward", () => {
  const makeOrder = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      id: 1,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      status: "active",
      side: "sell" as const,
      trigger_type: "price_below" as const,
      target_price_usd: 1900,
      trail_pct: null,
      water_mark_usd: null,
      chain: "base",
      account: "default",
      base_token: "0xeth",
      base_symbol: "ETH",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      base_amount: "1",
      quote_amount: null,
      slippage_bps: null,
      auto_slippage: 0,
      expires_at: null,
      strategy: "x",
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
      paper: 0,
      ...over,
    }) as never;

  it("computes distance-to-trigger for price orders", async () => {
    const f = await _buildForward({
      schedules: [],
      orders: [makeOrder({ id: 1, target_price_usd: 1900 })],
      rebalances: [],
      livePriceFn: async () => 2000,
    });
    expect(f.pendingTriggers).toHaveLength(1);
    expect(f.pendingTriggers[0].currentPriceUsd).toBe(2000);
    expect(f.pendingTriggers[0].fireThresholdUsd).toBe(1900);
    expect(f.pendingTriggers[0].distancePct).toBeCloseTo(-5);
    expect(f.pendingTriggers[0].wouldFireNow).toBe(false);
  });

  it("flags wouldFireNow when triggered", async () => {
    const f = await _buildForward({
      schedules: [],
      orders: [makeOrder({ id: 1, target_price_usd: 2100 })],
      rebalances: [],
      livePriceFn: async () => 2000, // 2000 ≤ 2100 → price_below fires
    });
    expect(f.pendingTriggers[0].wouldFireNow).toBe(true);
  });

  it("sorts pending triggers by closeness to firing", async () => {
    const orders = [
      makeOrder({ id: 1, target_price_usd: 1800 }), // 10% below
      makeOrder({ id: 2, target_price_usd: 1950 }), // 2.5% below
      makeOrder({ id: 3, target_price_usd: 1500 }), // 25% below
    ];
    const f = await _buildForward({
      schedules: [],
      orders,
      rebalances: [],
      livePriceFn: async () => 2000,
    });
    expect(f.pendingTriggers.map((t) => t.orderId)).toEqual([2, 1, 3]);
  });

  it("handles trailing orders with HWM", async () => {
    const o = makeOrder({
      id: 1,
      trigger_type: "trailing" as const,
      trail_pct: 5,
      water_mark_usd: 2100,
      target_price_usd: null,
    });
    const f = await _buildForward({
      schedules: [],
      orders: [o],
      rebalances: [],
      livePriceFn: async () => 2050,
    });
    const e = f.pendingTriggers[0];
    expect(e.trigger).toBe("trailing");
    // For a sell trail, fire = HWM × (1 - trail%) = 2100 × 0.95 = 1995
    expect(e.fireThresholdUsd).toBeCloseTo(1995);
    expect(e.trailingWaterMarkUsd).toBeGreaterThanOrEqual(2050);
  });

  it("returns null nextScheduleAt when no active schedules", async () => {
    const f = await _buildForward({
      schedules: [{ status: "paused", next_run_at: "2026-05-01T00:00:00Z" } as never],
      orders: [],
      rebalances: [],
      livePriceFn: undefined,
    });
    expect(f.nextScheduleAt).toBeNull();
  });

  it("picks earliest next_run_at across multiple active schedules", async () => {
    const f = await _buildForward({
      schedules: [
        { id: 1, status: "active", next_run_at: "2026-06-01T00:00:00Z" } as never,
        { id: 2, status: "active", next_run_at: "2026-05-25T00:00:00Z" } as never,
      ],
      orders: [],
      rebalances: [],
      livePriceFn: undefined,
    });
    expect(f.nextScheduleAt).toBe("2026-05-25T00:00:00Z");
    expect(f.nextScheduleId).toBe(2);
  });

  it("survives livePriceFn errors (current=null, distance=null)", async () => {
    const f = await _buildForward({
      schedules: [],
      orders: [makeOrder({ id: 1 })],
      rebalances: [],
      livePriceFn: async () => {
        throw new Error("boom");
      },
    });
    expect(f.pendingTriggers[0].currentPriceUsd).toBeNull();
    expect(f.pendingTriggers[0].distancePct).toBeNull();
  });
});

// ── 9) buildIdentity ────────────────────────────────────────

describe("buildIdentity", () => {
  it("uses playbook name + deployedAt when playbook resolves", () => {
    const id = _buildIdentity({
      tag: "playbook:1",
      playbook: {
        id: 1,
        name: "eth-bracket",
        source_path: "/x.json",
        source_hash: "abc",
        spec_json: "{}",
        status: "deployed" as never,
        deployed_at: "2026-05-01T00:00:00Z",
        destroyed_at: null,
      },
      composition: undefined,
      now: new Date("2026-05-31T00:00:00Z"),
    });
    expect(id.displayName).toBe("eth-bracket");
    expect(id.playbookId).toBe(1);
    expect(id.ageSeconds).toBeGreaterThan(0);
  });

  it("falls back to tag + earliest primitive for free-form", () => {
    const id = _buildIdentity({
      tag: "dca-eth",
      playbook: null,
      composition: {
        totals: { orders: 1, schedules: 0, rebalances: 0 },
        lifecycle: { active: 1, filled: 0, failed: 0, expired: 0, cancelled: 0, paused: 0, completed: 0 },
        primitives: [
          {
            kind: "order" as const,
            id: 1,
            status: "active",
            summary: "x",
            chain: "base",
            account: "default",
            paper: false,
            createdAt: "2026-04-01T00:00:00Z",
            terminalAt: null,
          },
        ],
      },
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(id.displayName).toBe("dca-eth");
    expect(id.playbookId).toBeNull();
    expect(id.ageSeconds).toBeCloseTo(30 * 86_400, -1);
  });
});

// ── 10) end-to-end buildStrategyReport ──────────────────────

describe("buildStrategyReport — end-to-end", () => {
  const ETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  it("assembles all 7 sections for a real playbook", async () => {
    // Seed: playbook + 2 active orders + 1 filled order + 2 trades + drawdown + journal entry.
    const pbId = insertPlaybook({
      name: "eth-test",
      sourcePath: "/tmp/x.json",
      sourceHash: "deadbeef",
      specJson: '{"name":"eth-test"}',
    });
    const tag = `playbook:${pbId}`;
    const o1 = insertOrder({
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
    const o2 = insertOrder({
      side: "sell",
      trigger_type: "price_above",
      target_price_usd: 3000,
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
    markOrderFilled(o2, {
      tx_hash: "0xfilled",
      fill_price: 3010,
      base_amount: "1",
      quote_amount: "3010",
    });
    insertTrade({
      timestamp: "2026-05-20T00:00:00Z",
      chain: "base",
      account: "default",
      direction: "sell",
      base_token: ETH,
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: USDC,
      quote_symbol: "USDC",
      quote_amount: "3010",
      price: "3010",
      tx_hash: "0xfilled",
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      strategy: tag,
      realized_slippage_bps: 25,
    });
    insertTrade({
      timestamp: "2026-05-21T00:00:00Z",
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: ETH,
      base_symbol: "ETH",
      base_amount: "0.5",
      quote_token: USDC,
      quote_symbol: "USDC",
      quote_amount: "1450",
      price: "2900",
      tx_hash: "0xbuy",
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      strategy: tag,
      realized_slippage_bps: 15,
    });
    upsertDrawdownState({
      scopeKey: `strategy:${tag}`,
      peakUsd: 10_000,
      peakAt: "2026-05-15T00:00:00Z",
      lastValueUsd: 9_700,
      trippedAt: null,
    });

    const report = await buildStrategyReport({
      tag: String(pbId), // bare number → playbook:N
      window: "30d",
      mode: "auto",
      livePriceFn: async () => 2500,
      nowFn: () => new Date("2026-05-31T00:00:00Z"),
    });

    expect(report.tag).toBe(tag);
    expect(report.mode).toBe("real");
    expect(report.identity?.displayName).toBe("eth-test");
    expect(report.identity?.playbookId).toBe(pbId);
    expect(report.composition?.totals.orders).toBe(2);
    expect(report.composition?.lifecycle.active).toBe(1);
    expect(report.composition?.lifecycle.filled).toBe(1);
    expect(report.performance?.fills).toBe(2);
    expect(report.performance?.realizedNetQuote).toBeCloseTo(3010 - 1450);
    expect(report.performance?.avgSlippageBps).toBeCloseTo(20);
    expect(report.position?.positions.length).toBeGreaterThan(0);
    expect(report.risk?.drawdown?.drawdownPct).toBeCloseTo(3);
    expect(report.activity?.recentFills.length).toBe(2);
    expect(report.forward?.pendingTriggers.length).toBe(1);
    // o1: target 1900 vs current 2500 → -24% (sell wants price ≤ 1900)
    expect(report.forward?.pendingTriggers[0].orderId).toBe(o1);
  });

  it("switches to paper mode when all primitives + trades are paper", async () => {
    const tag = "paper-strategy-x";
    insertOrder({
      side: "buy",
      trigger_type: "price_below",
      target_price_usd: 1800,
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
      paper: true,
    });
    recordPaperTrade({
      timestamp: "2026-05-20T00:00:00Z",
      source_type: "order",
      source_id: 1,
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: ETH,
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: USDC,
      quote_symbol: "USDC",
      quote_amount: "1800",
      price: "1800",
      slippage_bps: 50,
      strategy: tag,
      notes: null,
    });
    const r = await buildStrategyReport({ tag, window: "all", mode: "auto" });
    expect(r.mode).toBe("paper");
    expect(r.performance?.fills).toBe(1);
    expect(r.performance?.avgSlippageBps).toBeNull();
  });

  it("honors sections filter for fast lookups", async () => {
    const r = await buildStrategyReport({
      tag: "nonexistent-tag",
      sections: ["identity", "composition"],
    });
    expect(r.identity).toBeDefined();
    expect(r.composition).toBeDefined();
    expect(r.performance).toBeUndefined();
    expect(r.position).toBeUndefined();
    expect(r.risk).toBeUndefined();
    expect(r.activity).toBeUndefined();
    expect(r.forward).toBeUndefined();
  });

  it("handles bare number tag → playbook:N", async () => {
    const pbId = insertPlaybook({
      name: "tag-test",
      sourcePath: null,
      sourceHash: "z",
      specJson: "{}",
    });
    const r = await buildStrategyReport({ tag: String(pbId), sections: ["identity"] });
    expect(r.tag).toBe(`playbook:${pbId}`);
    expect(r.identity?.displayName).toBe("tag-test");
  });
});

// ── valuation (mark-to-market) ──────────────────────────────

describe("buildStrategyReport — valuation section", () => {
  const ETH2 = "0x4200000000000000000000000000000000000006";
  const USDC2 = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  function seedRealTrade(over: Record<string, unknown> = {}) {
    insertTrade({
      timestamp: "2026-05-20T00:00:00Z",
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: ETH2,
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: USDC2,
      quote_symbol: "USDC",
      quote_amount: "2000",
      price: "2000",
      tx_hash: `0x${Math.floor(Math.random() * 1e9).toString(16)}`,
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      strategy: "val-test",
      realized_slippage_bps: 10,
      ...over,
    } as never);
  }

  it("is NOT in the default section set (opt-in only)", async () => {
    seedRealTrade();
    const r = await buildStrategyReport({ tag: "val-test", mode: "real" });
    expect(r.valuation).toBeUndefined();
  });

  it("real mode: marks the open position via markPriceFn (success trades only)", async () => {
    seedRealTrade(); // buy 1 ETH @ 2000
    // A FAILED trade must not enter cost basis.
    seedRealTrade({ timestamp: "2026-05-21T00:00:00Z", status: "failed", quote_amount: "9999", base_amount: "5" });
    const r = await buildStrategyReport({
      tag: "val-test",
      mode: "real",
      sections: ["valuation"],
      markPriceFn: async (_chain, token) => (token.toLowerCase() === ETH2 ? 2500 : null),
    });
    const v = r.valuation!;
    expect(v.realizedQuote).toBe(0);
    expect(v.unrealizedQuote).toBeCloseTo(500, 6); // 1 × (2500 − 2000)
    expect(v.totalQuote).toBeCloseTo(500, 6);
    expect(v.openValueQuote).toBeCloseTo(2500, 6);
    expect(v.positions).toHaveLength(1);
    expect(v.positions[0].amount).toBeCloseTo(1, 9); // failed trade excluded
    expect(v.positions[0].avgCostQuote).toBeCloseTo(2000, 6);
  });

  it("real mode: round-trip realizes cost-basis P&L", async () => {
    seedRealTrade(); // buy 1 @ 2000
    seedRealTrade({ timestamp: "2026-05-22T00:00:00Z", direction: "sell", quote_amount: "2300", price: "2300" });
    const r = await buildStrategyReport({
      tag: "val-test",
      mode: "real",
      sections: ["valuation"],
      markPriceFn: async () => 9999, // flat position — mark must not matter
    });
    const v = r.valuation!;
    expect(v.realizedQuote).toBeCloseTo(300, 6);
    expect(v.unrealizedQuote).toBe(0);
    expect(v.totalQuote).toBeCloseTo(300, 6);
  });

  it("paper mode: same engine over paper_trades", async () => {
    recordPaperTrade({
      timestamp: "2026-05-20T00:00:00Z",
      source_type: "schedule",
      source_id: 1,
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: ETH2,
      base_symbol: "ETH",
      base_amount: "2",
      quote_token: USDC2,
      quote_symbol: "USDC",
      quote_amount: "4000",
      price: "2000",
      slippage_bps: 50,
      strategy: "val-paper",
      notes: null,
    });
    const r = await buildStrategyReport({
      tag: "val-paper",
      mode: "paper",
      sections: ["valuation"],
      markPriceFn: async () => 2600,
    });
    const v = r.valuation!;
    expect(r.mode).toBe("paper");
    expect(v.unrealizedQuote).toBeCloseTo(2 * 600, 6);
    expect(v.openValueQuote).toBeCloseTo(5200, 6);
  });

  it("no markPriceFn → deterministic offline section with unpriced positions", async () => {
    seedRealTrade();
    const r = await buildStrategyReport({
      tag: "val-test",
      mode: "real",
      sections: ["valuation"],
    });
    const v = r.valuation!;
    expect(v.realizedQuote).toBe(0); // cost basis still exact
    expect(v.unrealizedQuote).toBeNull();
    expect(v.unpricedPositionCount).toBe(1);
    expect(v.positions[0].avgCostQuote).toBeCloseTo(2000, 6);
  });

  it("empty trade history → empty valuation, no crash", async () => {
    const r = await buildStrategyReport({
      tag: "val-empty",
      mode: "real",
      sections: ["valuation"],
      markPriceFn: async () => 1,
    });
    const v = r.valuation!;
    expect(v.positions).toEqual([]);
    expect(v.realizedQuote).toBe(0);
    expect(v.unrealizedQuote).toBe(0); // nothing open
    expect(v.totalQuote).toBe(0);
  });
});

// ── forward: rebalance drift proximity ───────────────────────

describe("buildForward — rebalance drift", () => {
  function planRow(over: Record<string, unknown> = {}) {
    return {
      id: 1,
      created_at: "x",
      updated_at: "x",
      status: "active",
      name: "folio",
      account: "default",
      chain: "base",
      quote_token: "0xq",
      quote_symbol: "USDC",
      targets_json: "[]",
      drift_threshold_pct: 5,
      min_trade_usd: 10,
      cron_expr: "0 */6 * * *",
      next_run_at: "2026-06-11T06:00:00.000Z",
      start_at: null,
      end_at: null,
      max_runs: null,
      slippage_bps: null,
      auto_slippage: 0,
      strategy: "t",
      note: null,
      run_count: 3,
      last_run_at: "2026-06-11T00:00:00.000Z",
      last_run_status: "skipped",
      last_run_executed_count: 0,
      last_run_skipped_count: 0,
      last_run_max_drift_pct: 4.2,
      last_error_code: null,
      last_error_message: null,
      paper: 0,
      ...over,
    } as never;
  }

  it("surfaces persisted drift telemetry with pct-of-threshold, sorted hottest-first", async () => {
    const f = await _buildForward({
      schedules: [],
      orders: [],
      rebalances: [
        planRow({ id: 1, last_run_max_drift_pct: 1.0 }),
        planRow({ id: 2, last_run_max_drift_pct: 4.2 }),
        planRow({ id: 3, last_run_max_drift_pct: null, last_run_at: null }),
      ],
      livePriceFn: undefined,
    });
    expect(f.rebalanceDrift).toHaveLength(3);
    expect(f.rebalanceDrift[0].planId).toBe(2); // 84% of threshold — hottest first
    expect(f.rebalanceDrift[0].pctOfThreshold).toBeCloseTo(84, 6);
    expect(f.rebalanceDrift[1].planId).toBe(1); // 20%
    expect(f.rebalanceDrift[2].planId).toBe(3); // never evaluated → null trails
    expect(f.rebalanceDrift[2].lastDriftPct).toBeNull();
    expect(f.rebalanceDrift[2].pctOfThreshold).toBeNull();
  });

  it("excludes terminal plans; includes paused; flags paper", async () => {
    const f = await _buildForward({
      schedules: [],
      orders: [],
      rebalances: [
        planRow({ id: 1, status: "cancelled" }),
        planRow({ id: 2, status: "paused", paper: 1 }),
      ],
      livePriceFn: undefined,
    });
    expect(f.rebalanceDrift).toHaveLength(1);
    expect(f.rebalanceDrift[0]).toMatchObject({ planId: 2, status: "paused", paper: true });
  });
});

describe("valuation — realizedTimeline (v31)", () => {
  const ETH3 = "0x4200000000000000000000000000000000000006";
  const USDC3 = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  it("the section carries the cumulative realized trajectory", async () => {
    const mk = (ts: string, dir: "buy" | "sell", base: string, quote: string) =>
      insertTrade({
        timestamp: ts, chain: "base", account: "default", direction: dir,
        base_token: ETH3, base_symbol: "ETH", base_amount: base,
        quote_token: USDC3, quote_symbol: "USDC", quote_amount: quote,
        price: "0", tx_hash: `0x${ts}`, status: "success",
        gas_used: null, gas_price_wei: null, gas_cost_native: null,
        aggregator: "kyberswap", fee_tier: null, notes: null,
        strategy: "tl-test", realized_slippage_bps: null,
      } as never);
    mk("2026-06-01T00:00:00Z", "buy", "1", "2000");
    mk("2026-06-02T00:00:00Z", "sell", "0.5", "1100"); // +100
    mk("2026-06-03T00:00:00Z", "sell", "0.5", "1050"); // +50 → cum 150

    const r = await buildStrategyReport({ tag: "tl-test", mode: "real", sections: ["valuation"] });
    const tl = r.valuation!.realizedTimeline;
    expect(tl).toHaveLength(2);
    expect(tl[1].cumulativeRealizedQuote).toBeCloseTo(150, 6);
  });
});

describe("sparkline (CLI helper)", () => {
  it("renders trajectory shape, handles flat/empty/downsampling", async () => {
    const { sparkline } = await import("./cli/strategy.js");
    expect(sparkline([])).toBe("");
    // Flat series → mid-band bars, length preserved.
    const flat = sparkline([5, 5, 5]);
    expect(flat).toHaveLength(3);
    expect(new Set(flat.split("")).size).toBe(1);
    // Monotonic climb → first char is the lowest bar, last the highest.
    const climb = sparkline([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(climb[0]).toBe("▁");
    expect(climb[climb.length - 1]).toBe("█");
    // Downsampling caps the width.
    const wide = sparkline(Array.from({ length: 500 }, (_, i) => i), 40);
    expect(wide).toHaveLength(40);
    expect(wide[39]).toBe("█");
  });
});
