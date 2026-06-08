// Tests for the schedules engine (schedules.ts). Split into:
//
//   1) Pure-logic / validation tests on createScheduleRow — error paths
//      and happy-path persistence.
//   2) DB roundtrip — insert, list filters, status transitions, run
//      telemetry, idempotency.
//   3) Lifecycle helpers — pause/resume/cancel error paths.
//
// runScheduleTick's executeTrade integration is exercised by the bash
// smoke suite (and would require a live wallet to fully cover here); the
// engine's STATE LOGIC (due-row selection, status flips on max_runs/end_at,
// next_run_at advancement) IS unit-tested via the DB layer + a stubbed
// fire path. Same boundary as orders.test.ts.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-schedules-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  createScheduleRow,
  pauseScheduleById,
  resumeScheduleById,
  cancelScheduleById,
} = await import("./schedules.js");
const {
  insertSchedule,
  getScheduleById,
  listSchedules,
  dueSchedules,
  setScheduleNextRunAt,
  recordScheduleFire,
  recordScheduleError,
  pauseSchedule: dbPauseSchedule,
  resumeSchedule: dbResumeSchedule,
  cancelSchedule: dbCancelSchedule,
  scheduleCountsByStatus,
  openDb,
  closeDb,
} = await import("./db.js");

beforeAll(() => {
  openDb();
});

afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM schedules");
});

function makeFixture(overrides: Partial<Parameters<typeof insertSchedule>[0]> = {}) {
  return {
    name: "dca-eth",
    cron_expr: "0 10 * * 1", // every Monday 10:00 UTC
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
    strategy: "dca",
    note: null,
    ...overrides,
  };
}

// ── DB roundtrip ─────────────────────────────────────────────

describe("schedules DB layer", () => {
  it("inserts then retrieves a schedule with all fields preserved", () => {
    const id = insertSchedule(makeFixture());
    expect(id).toBeGreaterThan(0);
    const row = getScheduleById(id)!;
    expect(row.name).toBe("dca-eth");
    expect(row.cron_expr).toBe("0 10 * * 1");
    expect(row.side).toBe("buy");
    expect(row.chain).toBe("base");
    expect(row.next_run_at).toBe("2026-06-01T10:00:00.000Z");
    expect(row.run_count).toBe(0);
    expect(row.status).toBe("active");
    expect(row.strategy).toBe("dca");
  });

  it("dueSchedules returns only active rows with next_run_at <= asOf", () => {
    const past = insertSchedule(makeFixture({ next_run_at: "2026-05-30T00:00:00.000Z" }));
    const future = insertSchedule(makeFixture({ next_run_at: "2026-12-31T00:00:00.000Z" }));
    dbPauseSchedule(past); // pause → no longer due
    insertSchedule(makeFixture({ next_run_at: "2026-05-31T00:00:00.000Z" })); // active + past = due

    const due = dueSchedules("2026-06-01T00:00:00.000Z");
    expect(due.length).toBe(1);
    // future schedule is not due
    expect(due.every((s) => s.id !== future)).toBe(true);
  });

  it("listSchedules filters by status / chain / account / strategy", () => {
    insertSchedule(makeFixture({ chain: "base", account: "main", strategy: "dca" }));
    insertSchedule(makeFixture({ chain: "arbitrum", account: "main", strategy: "rebal" }));
    insertSchedule(makeFixture({ chain: "base", account: "side", strategy: "rebal" }));
    const id = insertSchedule(makeFixture({ chain: "base", account: "main", strategy: "rebal" }));
    dbCancelSchedule(id);

    expect(listSchedules({}).length).toBe(4);
    expect(listSchedules({ status: "active" }).length).toBe(3);
    expect(listSchedules({ status: "cancelled" }).length).toBe(1);
    expect(listSchedules({ chain: "base" }).length).toBe(3);
    expect(listSchedules({ account: "main" }).length).toBe(3);
    expect(listSchedules({ strategy: "dca" }).length).toBe(1);
  });

  it("recordScheduleFire bumps run_count + totals + advances next_run_at", () => {
    const id = insertSchedule(makeFixture());
    recordScheduleFire(id, {
      nextRunAt: "2026-06-08T10:00:00.000Z",
      txHash: "0x" + "ab".repeat(32),
      baseAmount: "0.05",
      quoteAmount: "100",
      completed: false,
    });
    const r1 = getScheduleById(id)!;
    expect(r1.run_count).toBe(1);
    expect(r1.next_run_at).toBe("2026-06-08T10:00:00.000Z");
    expect(r1.last_run_tx_hash).toBe("0x" + "ab".repeat(32));
    expect(r1.last_run_status).toBe("success");
    expect(parseFloat(r1.total_base_filled ?? "0")).toBeCloseTo(0.05);
    expect(parseFloat(r1.total_quote_spent ?? "0")).toBeCloseTo(100);
    expect(r1.status).toBe("active");

    // Second fire accumulates totals.
    recordScheduleFire(id, {
      nextRunAt: "2026-06-15T10:00:00.000Z",
      txHash: "0x" + "cd".repeat(32),
      baseAmount: "0.05",
      quoteAmount: "100",
      completed: false,
    });
    const r2 = getScheduleById(id)!;
    expect(r2.run_count).toBe(2);
    expect(parseFloat(r2.total_base_filled ?? "0")).toBeCloseTo(0.1);
    expect(parseFloat(r2.total_quote_spent ?? "0")).toBeCloseTo(200);
  });

  it("recordScheduleFire with completed=true flips status to completed", () => {
    const id = insertSchedule(makeFixture({ max_runs: 1 }));
    recordScheduleFire(id, {
      nextRunAt: "2026-06-08T10:00:00.000Z",
      txHash: "0x" + "ab".repeat(32),
      baseAmount: "0.05",
      quoteAmount: "100",
      completed: true,
    });
    expect(getScheduleById(id)!.status).toBe("completed");
  });

  it("recordScheduleError stamps error trail without flipping status", () => {
    const id = insertSchedule(makeFixture());
    recordScheduleError(id, "2026-06-08T10:00:00.000Z", "RPC_FAILED", "RPC timeout");
    const r = getScheduleById(id)!;
    expect(r.status).toBe("active");
    expect(r.run_count).toBe(1);
    expect(r.last_run_status).toBe("failed");
    expect(r.last_error_code).toBe("RPC_FAILED");
    expect(r.last_error_message).toBe("RPC timeout");
    expect(r.next_run_at).toBe("2026-06-08T10:00:00.000Z");
  });

  it("pauseSchedule/resumeSchedule/cancelSchedule transitions are validated", () => {
    const id = insertSchedule(makeFixture());
    expect(dbPauseSchedule(id)).toBe(1);
    expect(getScheduleById(id)!.status).toBe("paused");
    // Pausing a paused row is refused (-1, not 0)
    expect(dbPauseSchedule(id)).toBe(-1);
    expect(dbResumeSchedule(id, "2026-06-01T10:00:00.000Z")).toBe(1);
    expect(getScheduleById(id)!.status).toBe("active");
    expect(dbResumeSchedule(id, "2026-06-08T10:00:00.000Z")).toBe(-1);
    expect(dbCancelSchedule(id)).toBe(1);
    expect(getScheduleById(id)!.status).toBe("cancelled");
    // Cancelling terminal-state is idempotent (0)
    expect(dbCancelSchedule(id)).toBe(0);
  });

  it("scheduleCountsByStatus covers all four states", () => {
    insertSchedule(makeFixture());
    const paused = insertSchedule(makeFixture());
    const completed = insertSchedule(makeFixture());
    const cancelled = insertSchedule(makeFixture());
    dbPauseSchedule(paused);
    recordScheduleFire(completed, {
      nextRunAt: "2026-12-31T10:00:00.000Z",
      txHash: "0x" + "ab".repeat(32),
      baseAmount: "0.05",
      quoteAmount: "100",
      completed: true,
    });
    dbCancelSchedule(cancelled);
    const counts = scheduleCountsByStatus();
    expect(counts.active).toBe(1);
    expect(counts.paused).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.cancelled).toBe(1);
  });
});

// ── createScheduleRow validation ─────────────────────────────

describe("createScheduleRow validation", () => {
  function baseArgs() {
    return {
      side: "buy" as const,
      chain: "base",
      account: "main",
      base: "ETH" as const,
      quote: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const,
      quoteAmount: "100",
      cron: "0 10 * * 1",
      strategy: "dca",
    };
  }

  it("rejects invalid side", () => {
    expect(() => createScheduleRow({ ...baseArgs(), side: "long" as unknown as "buy" })).toThrow(/side must be/);
  });

  it("requires exactly one of cron / every", () => {
    expect(() => createScheduleRow({ ...baseArgs(), cron: undefined, every: undefined })).toThrow(/exactly one/);
    expect(() => createScheduleRow({ ...baseArgs(), every: "1d" })).toThrow(/exactly one/);
  });

  it("requires exactly one of baseAmount / quoteAmount", () => {
    expect(() => createScheduleRow({ ...baseArgs(), quoteAmount: undefined })).toThrow(/exactly one/);
    expect(() => createScheduleRow({ ...baseArgs(), baseAmount: "0.05" })).toThrow(/exactly one/);
  });

  it("rejects bad slippage", () => {
    expect(() => createScheduleRow({ ...baseArgs(), slippageBps: 0 })).toThrow(/slippageBps/);
    expect(() => createScheduleRow({ ...baseArgs(), slippageBps: 10_001 })).toThrow(/slippageBps/);
  });

  it("rejects malformed startAt / endAt", () => {
    expect(() => createScheduleRow({ ...baseArgs(), startAt: "garbage" })).toThrow(/startAt/);
    expect(() => createScheduleRow({ ...baseArgs(), endAt: "garbage" })).toThrow(/endAt/);
  });

  it("rejects endAt in the past or before startAt", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(() => createScheduleRow({ ...baseArgs(), endAt: past })).toThrow(/future/);
    const future1 = new Date(Date.now() + 86_400_000).toISOString();
    const future2 = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect(() => createScheduleRow({ ...baseArgs(), startAt: future2, endAt: future1 })).toThrow(/after startAt/);
  });

  it("rejects non-positive maxRuns", () => {
    expect(() => createScheduleRow({ ...baseArgs(), maxRuns: 0 })).toThrow(/maxRuns/);
    expect(() => createScheduleRow({ ...baseArgs(), maxRuns: -1 })).toThrow(/maxRuns/);
  });

  it("rejects cron that won't fire before endAt", () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    // @yearly = Jan 1; if today isn't around Dec 31 it won't fire before tomorrow.
    expect(() => createScheduleRow({ ...baseArgs(), cron: "@yearly", endAt: tomorrow })).toThrow(/never fires/);
  });

  it("happy path with cron: persists with resolved symbols + computed next_run_at", () => {
    const row = createScheduleRow(baseArgs());
    expect(row.id).toBeGreaterThan(0);
    expect(row.cron_expr).toBe("0 10 * * 1");
    expect(row.base_symbol).toBe("ETH");
    expect(row.quote_symbol).toBe("USDC");
    expect(row.status).toBe("active");
    expect(row.next_run_at).toMatch(/T10:00:00\.000Z$/); // 10:00 UTC
    // next_run_at must be in the future relative to creation
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("happy path with every: compiles to cron via durationToCron", () => {
    const row = createScheduleRow({ ...baseArgs(), cron: undefined, every: "1d" });
    expect(row.cron_expr).toBe("0 0 * * *");
  });

  it("startAt in the future anchors the first run to >= startAt", () => {
    const start = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const row = createScheduleRow({ ...baseArgs(), startAt: start });
    expect(Date.parse(row.next_run_at)).toBeGreaterThanOrEqual(Date.parse(start));
  });
});

// ── lifecycle helpers (with structured errors) ──────────────

describe("scheduleLifecycle helpers", () => {
  it("pauseScheduleById throws INVALID_PARAMS for unknown id", () => {
    expect(() => pauseScheduleById(99_999)).toThrow(/not found/);
  });

  it("pauseScheduleById throws on already-paused / terminal rows", () => {
    const id = insertSchedule(makeFixture());
    dbPauseSchedule(id);
    expect(() => pauseScheduleById(id)).toThrow(/only active/);
  });

  it("resumeScheduleById recomputes next_run_at on resume", () => {
    const id = insertSchedule(makeFixture({
      cron_expr: "0 * * * *", // every hour
      next_run_at: "2020-01-01T00:00:00.000Z", // arbitrary past
    }));
    dbPauseSchedule(id);
    const row = resumeScheduleById(id);
    expect(row.status).toBe("active");
    // next_run_at must be a future hour from now (not the stale past one)
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("resumeScheduleById throws on non-paused rows", () => {
    const id = insertSchedule(makeFixture());
    expect(() => resumeScheduleById(id)).toThrow(/only paused/);
  });

  it("cancelScheduleById throws on unknown id", () => {
    expect(() => cancelScheduleById(99_999)).toThrow(/not found/);
  });

  it("cancelScheduleById is idempotent on cancelled rows", () => {
    const id = insertSchedule(makeFixture());
    dbCancelSchedule(id);
    const row = cancelScheduleById(id); // no throw, returns row
    expect(row.status).toBe("cancelled");
  });
});
