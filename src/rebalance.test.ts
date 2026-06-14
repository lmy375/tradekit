// Tests for portfolio rebalancing (rebalance.ts). Three layers:
//
//   1) Pure math: validateTargets, computeDrift, planRebalanceTrades —
//      no DB, no RPC, deterministic.
//   2) DB roundtrip: insertRebalancePlan, listRebalancePlans, lifecycle
//      transitions, telemetry recorders.
//   3) createRebalancePlanRow validation — error paths + happy path.
//
// runRebalanceTick's executeTrade integration is exercised by the bash
// smoke + lower-level engine tests; the pure logic IS unit-tested here
// (drift computation, trade planning) so the math + state machine are
// fully covered without standing up the RPC stack.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-rebalance-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  validateTargets,
  computeDrift,
  planRebalanceTrades,
  gatherRebalancePreview,
  renderRebalancePreview,
  createRebalancePlanRow,
  pauseRebalancePlanById,
  resumeRebalancePlanById,
  cancelRebalancePlanById,
} = await import("./rebalance.js");
const {
  insertRebalancePlan,
  getRebalancePlanById,
  listRebalancePlans,
  dueRebalancePlans,
  setRebalancePlanNextRunAt,
  recordRebalanceRun,
  recordRebalanceError,
  pauseRebalancePlan: dbPause,
  resumeRebalancePlan: dbResume,
  cancelRebalancePlan: dbCancel,
  rebalancePlanCountsByStatus,
  openDb,
  closeDb,
} = await import("./db.js");
import type { PortfolioSnapshot, PortfolioToken } from "./positionLimits.js";
import type { RebalanceTarget } from "./db.js";
const { configSchema } = await import("./config.js");

beforeAll(() => {
  openDb();
});

afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM rebalance_plans");
});

// ── validateTargets ──────────────────────────────────────────

describe("validateTargets", () => {
  it("accepts a valid 2-target spec summing to 100", () => {
    expect(
      validateTargets([
        { token: "ETH", targetPct: 60 },
        { token: "USDC", targetPct: 40 },
      ]),
    ).toEqual([
      { token: "ETH", targetPct: 60 },
      { token: "USDC", targetPct: 40 },
    ]);
  });

  it("accepts 3-target spec near 100 within float tolerance", () => {
    // 33.33% × 3 = 99.99 — within the 0.01 epsilon allowance.
    expect(
      validateTargets([
        { token: "ETH", targetPct: 33.33 },
        { token: "USDC", targetPct: 33.33 },
        { token: "WBTC", targetPct: 33.34 },
      ]).length,
    ).toBe(3);
  });

  it("rejects fewer than 2 targets", () => {
    expect(() => validateTargets([])).toThrow(/at least 2/);
    expect(() => validateTargets([{ token: "ETH", targetPct: 100 }])).toThrow(/at least 2/);
  });

  it("rejects duplicate tokens (case-insensitive)", () => {
    expect(() =>
      validateTargets([
        { token: "ETH", targetPct: 50 },
        { token: "eth", targetPct: 50 },
      ]),
    ).toThrow(/Duplicate/);
  });

  it("rejects out-of-range targetPct", () => {
    expect(() =>
      validateTargets([
        { token: "ETH", targetPct: 101 },
        { token: "USDC", targetPct: -1 },
      ]),
    ).toThrow(/in \[0, 100\]/);
  });

  it("rejects sums far from 100", () => {
    expect(() =>
      validateTargets([
        { token: "ETH", targetPct: 60 },
        { token: "USDC", targetPct: 30 },
      ]),
    ).toThrow(/sum to exactly 100/);
  });

  it("accepts a 0% target (phase-out / sell-to-zero pattern)", () => {
    expect(
      validateTargets([
        { token: "ETH", targetPct: 100 },
        { token: "WBTC", targetPct: 0 },
      ]).length,
    ).toBe(2);
  });
});

// ── computeDrift ─────────────────────────────────────────────

function tok(overrides: Partial<PortfolioToken> = {}): PortfolioToken {
  return {
    chain: "base",
    symbol: "ETH",
    address: "NATIVE",
    usd: 600,
    ...overrides,
  };
}

function makeSnapshot(tokens: PortfolioToken[]): PortfolioSnapshot {
  let total = 0;
  let hasUnpriced = false;
  for (const t of tokens) {
    if (t.usd == null) hasUnpriced = true;
    else total += t.usd;
  }
  return { totalUsd: total, hasUnpriced, tokens };
}

describe("computeDrift", () => {
  // Portfolio: ETH=600, USDC=400 → 60/40
  const snapshot = makeSnapshot([
    tok({ symbol: "ETH", address: "NATIVE", usd: 600 }),
    tok({ symbol: "USDC", address: "0xaaa", usd: 400 }),
  ]);

  it("at-target portfolio produces drift=0", () => {
    const drift = computeDrift(snapshot, [
      { token: "ETH", targetPct: 60 },
      { token: "USDC", targetPct: 40 },
    ]);
    expect(drift.entries[0].driftPct).toBeCloseTo(0, 6);
    expect(drift.entries[1].driftPct).toBeCloseTo(0, 6);
    expect(drift.maxDriftPct).toBeCloseTo(0, 6);
  });

  it("over-weight position has positive drift; under-weight is negative", () => {
    const drift = computeDrift(snapshot, [
      { token: "ETH", targetPct: 50 },
      { token: "USDC", targetPct: 50 },
    ]);
    expect(drift.entries[0].driftPct).toBeCloseTo(10, 4); // ETH 60 - target 50 = +10
    expect(drift.entries[1].driftPct).toBeCloseTo(-10, 4); // USDC 40 - target 50 = -10
    expect(drift.maxDriftPct).toBeCloseTo(10, 4);
  });

  it("deltaUsd reports the absolute USD to move per leg", () => {
    const drift = computeDrift(snapshot, [
      { token: "ETH", targetPct: 50 },
      { token: "USDC", targetPct: 50 },
    ]);
    // Total 1000; ETH target 500; current 600 → delta 100 USD.
    expect(drift.entries[0].deltaUsd).toBeCloseTo(100, 4);
    expect(drift.entries[1].deltaUsd).toBeCloseTo(100, 4);
  });

  it("targets-a-token-not-held → drift = -targetPct, deltaUsd = targetUsd", () => {
    const drift = computeDrift(snapshot, [
      { token: "ETH", targetPct: 50 },
      { token: "USDC", targetPct: 30 },
      { token: "WBTC", targetPct: 20 }, // not held
    ]);
    const wbtc = drift.entries.find((e) => e.token === "WBTC")!;
    expect(wbtc.currentPct).toBe(0);
    expect(wbtc.driftPct).toBeCloseTo(-20, 4);
    expect(wbtc.deltaUsd).toBeCloseTo(200, 4); // 20% of $1000
    expect(wbtc.matched).toBeNull();
  });

  it("native sentinel matches ETH symbol via the NATIVE alias", () => {
    const drift = computeDrift(snapshot, [
      { token: "ETH", targetPct: 50 },
      { token: "USDC", targetPct: 50 },
    ]);
    expect(drift.entries[0].matched).not.toBeNull();
    expect(drift.entries[0].matched!.address).toBe("NATIVE");
  });

  it("address-style target matches by exact lowercased address", () => {
    // Use a properly-formed 40-hex-char address so the address-style
    // branch fires (anything shorter falls through to symbol-match).
    const fullAddr = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const snap = makeSnapshot([
      tok({ symbol: "ETH", address: "NATIVE", usd: 600 }),
      tok({ symbol: "USDC", address: fullAddr, usd: 400 }),
    ]);
    const drift = computeDrift(snap, [
      { token: "NATIVE", targetPct: 50 },
      { token: fullAddr, targetPct: 50 },
    ]);
    expect(drift.entries[1].matched).not.toBeNull();
    expect(drift.entries[1].matched!.address).toBe(fullAddr);
  });

  it("hasUnpriced surfaces when a matched token has null USD", () => {
    const unpriced = makeSnapshot([
      tok({ symbol: "ETH", address: "NATIVE", usd: 600 }),
      tok({ symbol: "USDC", address: "0xaaa", usd: 400 }),
      tok({ symbol: "UNKNOWN", address: "0xbbb", usd: null }),
    ]);
    const drift = computeDrift(unpriced, [
      { token: "UNKNOWN", targetPct: 50 },
      { token: "USDC", targetPct: 50 },
    ]);
    expect(drift.hasUnpriced).toBe(true);
  });

  it("zero-total portfolio: currentPct=0 + drift=-targetPct (no divide-by-zero)", () => {
    // Empty wallet is 100% off-target — every entry has current=0 and
    // drift = -targetPct (under-weight by the full target). The engine
    // tick checks totalUsd <= 0 separately and skips the fire path; the
    // pure helper just reports the drift faithfully.
    const empty: PortfolioSnapshot = { totalUsd: 0, hasUnpriced: false, tokens: [] };
    const drift = computeDrift(empty, [
      { token: "ETH", targetPct: 50 },
      { token: "USDC", targetPct: 50 },
    ]);
    expect(drift.totalUsd).toBe(0);
    expect(drift.entries[0].currentPct).toBe(0);
    expect(drift.entries[0].driftPct).toBe(-50);
    expect(drift.maxDriftPct).toBe(50);
    // deltaUsd is the targetUsd which is 50% of 0 = 0 — so nothing would
    // actually trade. Engine's separate totalUsd<=0 short-circuit is what
    // prevents the fire path entirely.
    expect(drift.entries[0].deltaUsd).toBe(0);
  });
});

// ── planRebalanceTrades ──────────────────────────────────────

describe("planRebalanceTrades", () => {
  const snapshot = makeSnapshot([
    tok({ symbol: "ETH", address: "NATIVE", usd: 700 }), // over-weight (70%)
    tok({ symbol: "USDC", address: "0xaaa", usd: 200 }), // mid-weight (20%)
    tok({ symbol: "WBTC", address: "0xbbb", usd: 100 }), // under-weight (10%)
  ]);

  it("sells over-weight + buys under-weight, EXCLUDING the quote anchor", () => {
    // Targets: ETH=50, USDC=30, WBTC=20. Total $1000.
    // ETH: 700 → target 500 → sell 200.
    // USDC: 200 → target 300 → IS THE QUOTE — excluded from steps.
    // WBTC: 100 → target 200 → buy 100.
    const drift = computeDrift(snapshot, [
      { token: "ETH", targetPct: 50 },
      { token: "USDC", targetPct: 30 },
      { token: "WBTC", targetPct: 20 },
    ]);
    const plan = planRebalanceTrades(drift, { quoteToken: "USDC", minTradeUsd: 0 });
    expect(plan.steps.length).toBe(2);
    expect(plan.steps.map((s) => `${s.direction}:${s.baseToken}`)).toEqual([
      "sell:ETH",
      "buy:WBTC",
    ]);
    expect(plan.steps[0].amountUsd).toBeCloseTo(200, 4);
    expect(plan.steps[1].amountUsd).toBeCloseTo(100, 4);
  });

  it("sells fire before buys (raises quote balance for the buy leg)", () => {
    const drift = computeDrift(snapshot, [
      { token: "ETH", targetPct: 50 },
      { token: "USDC", targetPct: 30 },
      { token: "WBTC", targetPct: 20 },
    ]);
    const plan = planRebalanceTrades(drift, { quoteToken: "USDC", minTradeUsd: 0 });
    expect(plan.steps[0].direction).toBe("sell");
    expect(plan.steps[1].direction).toBe("buy");
  });

  it("each side sorted largest-first within direction", () => {
    // Two sells of different sizes.
    const snap2 = makeSnapshot([
      tok({ symbol: "ETH", address: "NATIVE", usd: 500 }),
      tok({ symbol: "WBTC", address: "0xbbb", usd: 400 }),
      tok({ symbol: "USDC", address: "0xaaa", usd: 100 }),
    ]);
    // Targets: ETH=20, WBTC=10, USDC=70. ETH drifts +30 ($300), WBTC drifts +30 ($300)
    // — actually let me make them different.
    // Targets: ETH=10, WBTC=20, USDC=70. ETH +40 ($400 sell), WBTC +20 ($200 sell).
    const drift = computeDrift(snap2, [
      { token: "ETH", targetPct: 10 },
      { token: "WBTC", targetPct: 20 },
      { token: "USDC", targetPct: 70 },
    ]);
    const plan = planRebalanceTrades(drift, { quoteToken: "USDC", minTradeUsd: 0 });
    // Both sells — ETH ($400) should come first because it's larger.
    expect(plan.steps[0].baseToken).toBe("ETH");
    expect(plan.steps[1].baseToken).toBe("WBTC");
  });

  it("filters trades below min_trade_usd into skipped[]", () => {
    const drift = computeDrift(snapshot, [
      { token: "ETH", targetPct: 50 },
      { token: "USDC", targetPct: 30 },
      { token: "WBTC", targetPct: 20 },
    ]);
    const plan = planRebalanceTrades(drift, { quoteToken: "USDC", minTradeUsd: 150 });
    // ETH sell is $200 (over min); WBTC buy is $100 (under min — skipped).
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].baseToken).toBe("ETH");
    expect(plan.skipped.length).toBe(1);
    expect(plan.skipped[0].baseToken).toBe("WBTC");
    expect(plan.skipped[0].reason).toBe("below_min_trade_usd");
  });

  it("excludes the quote anchor target (operator wrote it explicitly)", () => {
    // Target USDC at 30% but USDC is the quote — engine excludes the
    // quote from the trade list since it can't trade USDC→USDC. Its
    // weight settles via the cross-trades.
    const drift = computeDrift(snapshot, [
      { token: "ETH", targetPct: 70 },
      { token: "USDC", targetPct: 30 },
    ]);
    const plan = planRebalanceTrades(drift, { quoteToken: "USDC", minTradeUsd: 0 });
    expect(plan.steps.every((s) => s.baseToken !== "USDC")).toBe(true);
  });

  it("at-target drift = no trades", () => {
    const balanced = makeSnapshot([
      tok({ symbol: "ETH", address: "NATIVE", usd: 500 }),
      tok({ symbol: "USDC", address: "0xaaa", usd: 500 }),
    ]);
    const drift = computeDrift(balanced, [
      { token: "ETH", targetPct: 50 },
      { token: "USDC", targetPct: 50 },
    ]);
    const plan = planRebalanceTrades(drift, { quoteToken: "USDC", minTradeUsd: 0 });
    expect(plan.steps).toEqual([]);
  });
});

// ── DB roundtrip ─────────────────────────────────────────────

function makeFixtureArgs(overrides: Partial<Parameters<typeof insertRebalancePlan>[0]> = {}) {
  return {
    name: "core-folio",
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
    slippage_bps: 50,
    auto_slippage: false,
    strategy: "rebal-core",
    note: null,
    ...overrides,
  };
}

describe("rebalance plans DB layer", () => {
  it("inserts then retrieves all fields", () => {
    const id = insertRebalancePlan(makeFixtureArgs());
    expect(id).toBeGreaterThan(0);
    const row = getRebalancePlanById(id)!;
    expect(row.name).toBe("core-folio");
    expect(row.chain).toBe("base");
    expect(row.account).toBe("main");
    expect(row.drift_threshold_pct).toBe(5);
    expect(row.min_trade_usd).toBe(10);
    expect(row.run_count).toBe(0);
    expect(row.status).toBe("active");
    const targets = JSON.parse(row.targets_json) as RebalanceTarget[];
    expect(targets.length).toBe(2);
    expect(targets[0].targetPct).toBe(60);
  });

  it("dueRebalancePlans returns only active rows with next_run_at <= asOf", () => {
    insertRebalancePlan(makeFixtureArgs({ next_run_at: "2026-05-30T00:00:00.000Z" }));
    insertRebalancePlan(makeFixtureArgs({ next_run_at: "2026-12-31T00:00:00.000Z" }));
    const pausedId = insertRebalancePlan(makeFixtureArgs({ next_run_at: "2026-05-30T00:00:00.000Z" }));
    dbPause(pausedId);

    const due = dueRebalancePlans("2026-06-01T00:00:00.000Z");
    expect(due.length).toBe(1); // only the first row (active + past)
  });

  it("recordRebalanceRun stamps telemetry + advances next_run_at + bumps run_count", () => {
    const id = insertRebalancePlan(makeFixtureArgs());
    recordRebalanceRun(id, {
      nextRunAt: "2026-06-01T06:00:00.000Z",
      status: "executed",
      executedCount: 2,
      skippedCount: 1,
      maxDriftPct: 8.5,
      completed: false,
    });
    const r = getRebalancePlanById(id)!;
    expect(r.run_count).toBe(1);
    expect(r.next_run_at).toBe("2026-06-01T06:00:00.000Z");
    expect(r.last_run_status).toBe("executed");
    expect(r.last_run_executed_count).toBe(2);
    expect(r.last_run_skipped_count).toBe(1);
    expect(r.last_run_max_drift_pct).toBeCloseTo(8.5, 6);
    expect(r.status).toBe("active");
  });

  it("recordRebalanceRun with completed=true flips status to completed", () => {
    const id = insertRebalancePlan(makeFixtureArgs({ max_runs: 1 }));
    recordRebalanceRun(id, {
      nextRunAt: "2026-12-31T06:00:00.000Z",
      status: "executed",
      executedCount: 1,
      skippedCount: 0,
      maxDriftPct: 12,
      completed: true,
    });
    expect(getRebalancePlanById(id)!.status).toBe("completed");
  });

  it("recordRebalanceError stamps error trail without flipping status", () => {
    const id = insertRebalancePlan(makeFixtureArgs());
    recordRebalanceError(id, "2026-06-01T06:00:00.000Z", "RPC_FAILED", "RPC down");
    const r = getRebalancePlanById(id)!;
    expect(r.status).toBe("active");
    // run_count counts EXECUTED rebalances only — failures must not
    // consume the max_runs quota (same fires-only contract as schedules).
    expect(r.run_count).toBe(0);
    expect(r.last_run_status).toBe("failed");
    expect(r.last_error_code).toBe("RPC_FAILED");
    expect(r.last_error_message).toBe("RPC down");
    expect(r.next_run_at).toBe("2026-06-01T06:00:00.000Z");
  });

  it("pauseRebalancePlan / resumeRebalancePlan / cancelRebalancePlan transitions are validated", () => {
    const id = insertRebalancePlan(makeFixtureArgs());
    expect(dbPause(id)).toBe(1);
    expect(getRebalancePlanById(id)!.status).toBe("paused");
    // Pausing a paused row is refused (-1).
    expect(dbPause(id)).toBe(-1);
    expect(dbResume(id, "2026-06-01T12:00:00.000Z")).toBe(1);
    expect(getRebalancePlanById(id)!.status).toBe("active");
    expect(dbResume(id, "2026-06-02T00:00:00.000Z")).toBe(-1);
    expect(dbCancel(id)).toBe(1);
    expect(getRebalancePlanById(id)!.status).toBe("cancelled");
    expect(dbCancel(id)).toBe(0); // idempotent on terminal
  });

  it("rebalancePlanCountsByStatus covers all four states", () => {
    insertRebalancePlan(makeFixtureArgs());
    const paused = insertRebalancePlan(makeFixtureArgs());
    const completed = insertRebalancePlan(makeFixtureArgs());
    const cancelled = insertRebalancePlan(makeFixtureArgs());
    dbPause(paused);
    recordRebalanceRun(completed, {
      nextRunAt: "2026-12-31T06:00:00.000Z",
      status: "executed",
      executedCount: 1,
      skippedCount: 0,
      maxDriftPct: 12,
      completed: true,
    });
    dbCancel(cancelled);
    const counts = rebalancePlanCountsByStatus();
    expect(counts).toEqual({ active: 1, paused: 1, completed: 1, cancelled: 1 });
  });
});

// ── createRebalancePlanRow validation ────────────────────────

describe("createRebalancePlanRow validation", () => {
  function baseArgs() {
    return {
      account: "main",
      chain: "base",
      targets: [
        { token: "ETH", targetPct: 60 },
        { token: "USDC", targetPct: 40 },
      ] as RebalanceTarget[],
    };
  }

  it("rejects invalid targets (delegated to validateTargets)", () => {
    expect(() =>
      createRebalancePlanRow({ ...baseArgs(), targets: [{ token: "ETH", targetPct: 100 }] }),
    ).toThrow(/at least 2/);
  });

  it("rejects bad drift threshold", () => {
    expect(() =>
      createRebalancePlanRow({ ...baseArgs(), driftThresholdPct: 0 }),
    ).toThrow(/driftThresholdPct/);
    expect(() =>
      createRebalancePlanRow({ ...baseArgs(), driftThresholdPct: 101 }),
    ).toThrow(/driftThresholdPct/);
  });

  it("rejects negative min_trade_usd", () => {
    expect(() => createRebalancePlanRow({ ...baseArgs(), minTradeUsd: -1 })).toThrow(/minTradeUsd/);
  });

  it("rejects slippageBps outside (0, 10000]", () => {
    expect(() => createRebalancePlanRow({ ...baseArgs(), slippageBps: 0 })).toThrow(/slippageBps/);
    expect(() => createRebalancePlanRow({ ...baseArgs(), slippageBps: 10_001 })).toThrow(/slippageBps/);
  });

  it("rejects non-positive maxRuns", () => {
    expect(() => createRebalancePlanRow({ ...baseArgs(), maxRuns: 0 })).toThrow(/maxRuns/);
  });

  it("rejects malformed start/end dates", () => {
    expect(() => createRebalancePlanRow({ ...baseArgs(), startAt: "garbage" })).toThrow(/startAt/);
    expect(() => createRebalancePlanRow({ ...baseArgs(), endAt: "garbage" })).toThrow(/endAt/);
  });

  it("rejects endAt before startAt", () => {
    const future1 = new Date(Date.now() + 86_400_000).toISOString();
    const future2 = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect(() =>
      createRebalancePlanRow({ ...baseArgs(), startAt: future2, endAt: future1 }),
    ).toThrow(/after startAt/);
  });

  it("happy path: persists with defaults applied", () => {
    const row = createRebalancePlanRow(baseArgs());
    expect(row.id).toBeGreaterThan(0);
    expect(row.drift_threshold_pct).toBe(5); // default
    expect(row.min_trade_usd).toBe(10); // default
    expect(row.cron_expr).toBe("0 */6 * * *"); // default
    // Quote token defaults to chain USDC.
    expect(row.quote_symbol).toBe("USDC");
    expect(row.status).toBe("active");
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("happy path: explicit cron + quote token + bounds", () => {
    const row = createRebalancePlanRow({
      ...baseArgs(),
      cron: "0 0 * * *", // daily midnight UTC
      quoteToken: "USDC",
      driftThresholdPct: 3,
      minTradeUsd: 25,
      slippageBps: 75,
      strategy: "core",
      maxRuns: 30,
    });
    expect(row.cron_expr).toBe("0 0 * * *");
    expect(row.drift_threshold_pct).toBe(3);
    expect(row.min_trade_usd).toBe(25);
    expect(row.slippage_bps).toBe(75);
    expect(row.strategy).toBe("core");
    expect(row.max_runs).toBe(30);
  });
});

// ── lifecycle helpers (with structured errors) ──────────────

describe("lifecycle helpers throw INVALID_PARAMS on bad transitions", () => {
  it("pauseRebalancePlanById throws for unknown id", () => {
    expect(() => pauseRebalancePlanById(99_999)).toThrow(/not found/);
  });

  it("pauseRebalancePlanById throws when already paused", () => {
    const id = insertRebalancePlan(makeFixtureArgs());
    dbPause(id);
    expect(() => pauseRebalancePlanById(id)).toThrow(/only active/);
  });

  it("resumeRebalancePlanById recomputes next_run_at on resume", () => {
    const id = insertRebalancePlan(
      makeFixtureArgs({
        cron_expr: "0 * * * *", // hourly
        next_run_at: "2020-01-01T00:00:00.000Z", // arbitrary past
      }),
    );
    dbPause(id);
    const row = resumeRebalancePlanById(id);
    expect(row.status).toBe("active");
    // next_run_at must be a future hour from now (not the stale past one)
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("cancelRebalancePlanById is idempotent on terminal states", () => {
    const id = insertRebalancePlan(makeFixtureArgs());
    dbCancel(id);
    const row = cancelRebalancePlanById(id);
    expect(row.status).toBe("cancelled");
  });
});

// ── gatherRebalancePreview (v56) — ad-hoc drift + trade plan ──

describe("gatherRebalancePreview", () => {
  const config = configSchema.parse({});
  const noopLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    child: () => noopLogger, recordAudit: () => {}, close: () => {},
  } as unknown as import("./logger.js").Logger;

  // A 72/28 ETH/USDC book on a $10k portfolio — over-weight ETH.
  const snapshot = {
    totalUsd: 10_000,
    hasUnpriced: false,
    tokens: [
      { chain: "base", symbol: "ETH", address: "NATIVE", usd: 7200 },
      { chain: "base", symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", usd: 2800 },
    ],
  };
  const fetchPortfolio = async () => snapshot;

  const preview = (over: Record<string, unknown> = {}) =>
    gatherRebalancePreview({
      targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }],
      chain: "base", account: "default", quoteToken: "USDC",
      config, logger: noopLogger, fetchPortfolio,
      now: new Date("2026-06-14T12:00:00Z"),
      ...over,
    });

  it("computes drift + a corrective sell of the over-weight token", async () => {
    const r = await preview();
    expect(r.totalUsd).toBe(10_000);
    expect(r.maxDriftPct).toBeCloseTo(12, 6);
    const eth = r.drift.find((d) => d.token === "ETH")!;
    expect(eth.currentPct).toBeCloseTo(72, 6);
    expect(eth.driftPct).toBeCloseTo(12, 6);
    // ETH is over-weight → sell ~$1,200; USDC is the quote anchor → no leg.
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].direction).toBe("sell");
    expect(r.steps[0].baseToken).toBe("ETH");
    expect(r.steps[0].amountUsd).toBeCloseTo(1200, 6);
    expect(r.totalTradeUsd).toBeCloseTo(1200, 6);
  });

  it("wouldFire reflects the supplied drift threshold", async () => {
    expect((await preview({ driftThresholdPct: 5 })).wouldFire).toBe(true);
    expect((await preview({ driftThresholdPct: 20 })).wouldFire).toBe(false);
    expect((await preview()).wouldFire).toBeNull(); // no threshold → null
  });

  it("minTradeUsd pushes sub-threshold legs into skipped[]", async () => {
    const r = await preview({ minTradeUsd: 5000 }); // $1,200 leg < $5,000
    expect(r.steps).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toBe("below_min_trade_usd");
  });

  it("flags paper mode + rejects targets that don't sum to 100", async () => {
    expect((await preview({ paper: true })).paper).toBe(true);
    await expect(preview({ targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 30 }] }))
      .rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("renders drift, the trade plan, and the would-fire context", async () => {
    const text = renderRebalancePreview(await preview({ driftThresholdPct: 5 }));
    expect(text).toMatch(/Rebalance preview — account:default × base/);
    expect(text).toMatch(/max drift 12\.0%/);
    expect(text).toMatch(/would fire \(≥5%\): YES/);
    expect(text).toMatch(/sell \$1200\.00 of ETH/);
  });
});
