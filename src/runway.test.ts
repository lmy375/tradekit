/**
 * Funding-runway tests.
 *
 * Layers:
 *   1. walkRunway (pure) — occurrence merge-walk: exhaustion point,
 *      horizon survival, max_runs budget, end_at bound, multi-
 *      schedule chronology, past-due immediate fire, one-shot
 *      over-reserve, burn30d windowing
 *   2. computeFundingRunway (db integration) — spend-side mapping
 *      (buy→quote / sell→base), canonical native, paper/real bucket
 *      isolation, one-shot order reserve, opposite-denomination
 *      skip, strategy scoping, unknown-balance degradation
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-runway-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { walkRunway, computeFundingRunway, canonicalSpendToken } = await import("./runway.js");
const { openDb, closeDb, insertOrder, insertSchedule } = await import("./db.js");
import type { InsertOrderArgs, InsertScheduleArgs } from "./db.js";
import type { RunwayBalanceFetcher } from "./runway.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NOW = new Date("2026-06-10T00:00:00.000Z");

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  openDb().exec("DELETE FROM orders; DELETE FROM schedules");
});

// ── walkRunway (pure) ───────────────────────────────────────

function weekly(amount: number, over: Record<string, unknown> = {}) {
  return {
    obligation: { kind: "schedule" as const, id: 1, name: null, strategy: null, amountPerFire: amount, cron: "0 0 * * 1" },
    cron: "0 0 * * 1", // Mondays 00:00 UTC
    nextRunAt: "2026-06-15T00:00:00.000Z", // next Monday after NOW (Wednesday)
    endAt: null,
    remainingRuns: Infinity,
    ...over,
  };
}

describe("walkRunway — pure occurrence walk", () => {
  it("balance covering 3 weekly fires exhausts on the 4th", () => {
    const r = walkRunway({ schedules: [weekly(100)], startBalance: 350, now: NOW, horizonDays: 60 });
    expect(r.firesCovered).toBe(3);
    // 4th Monday: Jun 15, 22, 29 covered; Jul 6 exhausts.
    expect(r.exhaustsAt).toBe("2026-07-06T00:00:00.000Z");
    expect(r.runwayDays).toBeCloseTo(26, 0);
  });

  it("survives the horizon → exhaustsAt null, every fire counted", () => {
    const r = walkRunway({ schedules: [weekly(100)], startBalance: 100_000, now: NOW, horizonDays: 30 });
    expect(r.exhaustsAt).toBeNull();
    expect(r.runwayDays).toBeNull();
    // Mondays in (Jun 10, Jul 10): Jun 15, 22, 29, Jul 6 = 4 fires.
    expect(r.totalFiresInHorizon).toBe(4);
    expect(r.firesCovered).toBe(4);
  });

  it("max_runs budget caps the stream", () => {
    const r = walkRunway({
      schedules: [weekly(100, { remainingRuns: 2 })],
      startBalance: 100_000, now: NOW, horizonDays: 60,
    });
    expect(r.totalFiresInHorizon).toBe(2);
    expect(r.exhaustsAt).toBeNull();
  });

  it("end_at stops occurrences", () => {
    const r = walkRunway({
      schedules: [weekly(100, { endAt: "2026-06-23T00:00:00.000Z" })],
      startBalance: 100_000, now: NOW, horizonDays: 60,
    });
    // Jun 15 + Jun 22 fire; Jun 29 > end_at.
    expect(r.totalFiresInHorizon).toBe(2);
  });

  it("multi-schedule merge walks chronologically", () => {
    const daily = {
      obligation: { kind: "schedule" as const, id: 2, name: null, strategy: null, amountPerFire: 10, cron: "0 0 * * *" },
      cron: "0 0 * * *",
      nextRunAt: "2026-06-11T00:00:00.000Z",
      endAt: null,
      remainingRuns: Infinity,
    };
    // Balance 60: daily burns 10 on Jun 11,12,13,14 (4 fires, 40
    // spent). Jun 15 00:00 both fire — ties resolve in array order,
    // so the weekly 100 goes first and exhausts (40+100 > 60).
    const r = walkRunway({ schedules: [weekly(100), daily], startBalance: 60, now: NOW, horizonDays: 30 });
    expect(r.firesCovered).toBe(4);
    expect(r.exhaustsAt).toBe("2026-06-15T00:00:00.000Z");
  });

  it("past-due next_run_at fires immediately at now", () => {
    const r = walkRunway({
      schedules: [weekly(100, { nextRunAt: "2026-06-01T00:00:00.000Z" })],
      startBalance: 50, now: NOW, horizonDays: 30,
    });
    // The overdue fire happens "now" and immediately exhausts.
    expect(r.exhaustsAt).toBe(NOW.toISOString());
    expect(r.firesCovered).toBe(0);
  });

  it("negative start balance (one-shot over-reserve) exhausts at now", () => {
    const r = walkRunway({ schedules: [weekly(100)], startBalance: -5, now: NOW, horizonDays: 30 });
    expect(r.exhaustsAt).toBe(NOW.toISOString());
    expect(r.runwayDays).toBe(0);
  });

  it("burn30d counts only fires inside the 30d window", () => {
    const r = walkRunway({ schedules: [weekly(100)], startBalance: 100_000, now: NOW, horizonDays: 90 });
    // 30d window (until Jul 10): Jun 15/22/29 + Jul 6 = 4 fires = 400.
    expect(r.burn30d).toBe(400);
    expect(r.totalFiresInHorizon).toBeGreaterThan(4); // 90d sees more
  });
});

// ── canonicalSpendToken ─────────────────────────────────────

describe("canonicalSpendToken", () => {
  it("maps native sentinels and lowercases addresses", () => {
    expect(canonicalSpendToken("ETH")).toBe("native");
    expect(canonicalSpendToken("NATIVE")).toBe("native");
    expect(canonicalSpendToken(WETH.toUpperCase().replace("0X", "0x"))).toBe(WETH);
  });
});

// ── computeFundingRunway (db integration) ───────────────────

function seedSchedule(over: Partial<InsertScheduleArgs> = {}): number {
  return insertSchedule({
    name: "dca",
    cron_expr: "0 0 * * 1",
    next_run_at: "2026-06-15T00:00:00.000Z",
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
    strategy: "playbook:1",
    note: null,
    paper: false,
    ...over,
  });
}

function seedOrder(over: Partial<InsertOrderArgs> = {}): number {
  return insertOrder({
    side: "buy",
    trigger_type: "price_below",
    target_price_usd: 1800,
    trail_pct: null,
    chain: "base",
    account: "default",
    base_token: WETH,
    base_symbol: "WETH",
    quote_token: USDC,
    quote_symbol: "USDC",
    base_amount: null,
    quote_amount: "500",
    slippage_bps: 50,
    auto_slippage: false,
    expires_at: null,
    strategy: "playbook:1",
    note: null,
    group_id: null,
    paper: false,
    ...over,
  });
}

/** Deterministic fetcher: balances keyed `${paper?'p':'r'}:${token}`. */
function fetcher(balances: Record<string, number | null>): RunwayBalanceFetcher {
  return async ({ token, paper }) => {
    const v = balances[`${paper ? "p" : "r"}:${token}`];
    return v === undefined || v === null ? null : { amount: v };
  };
}

describe("computeFundingRunway — db integration", () => {
  it("buy schedules burn the quote token; sells burn the base token", async () => {
    seedSchedule(); // buy → USDC
    seedSchedule({ side: "sell", base_amount: "0.5", quote_amount: null }); // sell → WETH
    const report = await computeFundingRunway({
      horizonDays: 30,
      balanceFetcher: fetcher({ [`r:${USDC}`]: 1000, [`r:${WETH}`]: 10 }),
      now: NOW,
    });
    expect(report.buckets).toHaveLength(2);
    const usdc = report.buckets.find((b) => b.token === USDC)!;
    const weth = report.buckets.find((b) => b.token === WETH)!;
    expect(usdc.burn30d).toBe(400); // 4 Mondays × 100
    expect(weth.burn30d).toBe(2);   // 4 × 0.5
    expect(usdc.symbol).toBe("USDC");
    expect(weth.symbol).toBe("WETH");
  });

  it("active orders reserve one-shot spend before the walk", async () => {
    seedSchedule(); // 100/week
    seedOrder();    // 500 one-shot
    const report = await computeFundingRunway({
      horizonDays: 60,
      balanceFetcher: fetcher({ [`r:${USDC}`]: 800 }),
      now: NOW,
    });
    const usdc = report.buckets[0];
    expect(usdc.oneShotReserved).toBe(500);
    // 800 - 500 = 300 → covers 3 weekly fires, 4th exhausts.
    expect(usdc.firesCovered).toBe(3);
    expect(usdc.exhaustsAt).toBe("2026-07-06T00:00:00.000Z");
  });

  it("paper and real primitives bucket separately", async () => {
    seedSchedule({ paper: false });
    seedSchedule({ paper: true });
    const report = await computeFundingRunway({
      horizonDays: 30,
      balanceFetcher: fetcher({ [`r:${USDC}`]: 1000, [`p:${USDC}`]: 50 }),
      now: NOW,
    });
    expect(report.buckets).toHaveLength(2);
    const paper = report.buckets.find((b) => b.paper)!;
    const real = report.buckets.find((b) => !b.paper)!;
    expect(paper.balance).toBe(50);
    expect(paper.exhaustsAt).not.toBeNull(); // 50 < 100/fire
    expect(real.exhaustsAt).toBeNull();      // 1000 covers 4 fires in 30d
  });

  it("opposite-denomination sizing lands in skipped, not guessed", async () => {
    seedSchedule({ base_amount: "0.1", quote_amount: null }); // buy sized in base
    seedOrder({ side: "sell", base_amount: null, quote_amount: "500" }); // sell sized in quote
    const report = await computeFundingRunway({
      horizonDays: 30,
      balanceFetcher: fetcher({}),
      now: NOW,
    });
    expect(report.buckets).toHaveLength(0);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped[0].reason).toMatch(/opposite denomination/);
  });

  it("strategy filter scopes the forecast", async () => {
    seedSchedule({ strategy: "playbook:1" });
    seedSchedule({ strategy: "playbook:2", quote_amount: "999" });
    const report = await computeFundingRunway({
      strategy: "playbook:1",
      horizonDays: 30,
      balanceFetcher: fetcher({ [`r:${USDC}`]: 1000 }),
      now: NOW,
    });
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0].obligations).toHaveLength(1);
    expect(report.buckets[0].obligations[0].strategy).toBe("playbook:1");
  });

  it("a failed balance fetch degrades the bucket to unknown but keeps burn data", async () => {
    seedSchedule();
    const report = await computeFundingRunway({
      horizonDays: 30,
      balanceFetcher: fetcher({ [`r:${USDC}`]: null }),
      now: NOW,
    });
    const b = report.buckets[0];
    expect(b.balance).toBeNull();
    expect(b.exhaustsAt).toBeNull();
    expect(b.burn30d).toBe(400); // the obligations are still visible
    expect(b.totalFiresInHorizon).toBeGreaterThan(0);
  });

  it("native sell schedules canonicalize to the native bucket", async () => {
    seedSchedule({ side: "sell", base_token: "ETH", base_symbol: "ETH", base_amount: "0.1", quote_amount: null });
    const report = await computeFundingRunway({
      horizonDays: 30,
      balanceFetcher: fetcher({ "r:native": 1 }),
      now: NOW,
    });
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0].token).toBe("native");
    expect(report.buckets[0].balance).toBe(1);
  });

  it("shortest runway sorts first", async () => {
    seedSchedule(); // USDC: plenty
    seedSchedule({ side: "sell", base_amount: "5", quote_amount: null }); // WETH: tight
    const report = await computeFundingRunway({
      horizonDays: 60,
      balanceFetcher: fetcher({ [`r:${USDC}`]: 100_000, [`r:${WETH}`]: 6 }),
      now: NOW,
    });
    expect(report.buckets[0].token).toBe(WETH); // exhausts → sorts first
    expect(report.buckets[1].exhaustsAt).toBeNull();
  });
});
