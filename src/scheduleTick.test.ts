/**
 * runScheduleTick integration tests — first coverage for the DCA
 * engine's main loop (due gating → start/end/maxRuns bounds → cron
 * advance → lock → wallet → fire → on_fill hook).
 *
 * Same offline harness as orderTick.test.ts: mock the I/O boundaries
 * (price / tokens / wallet) and fire PAPER schedules so
 * executePaperTrade writes to the virtual book — no chain, no
 * aggregator, no keystore.
 *
 * Pinned semantics worth calling out:
 *   - ENGINE_LOCKED skip does NOT advance next_run_at (a missed DCA
 *     window fires as soon as the operator unlocks) — deliberately
 *     different from dry-run, which DOES advance.
 *   - Transient AND terminal fire errors BOTH advance next_run_at
 *     (DCA is per-occurrence; a failed Monday buy shouldn't re-fire
 *     all week — the next attempt is next Monday).
 *   - on_fill hook failures never unwind the fill.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-scheduletick-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

// ── I/O boundary mocks (must precede module imports) ─────────

vi.mock("./price.js", () => ({
  getCurrentPrice: vi.fn(),
  getCurrentPrices: vi.fn(async () => ({})),
}));

vi.mock("./tokens.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./tokens.js")>();
  return {
    ...orig,
    getToken: vi.fn(async (_pc: unknown, _profile: unknown, address: string) => {
      const addr = String(address).toLowerCase();
      if (addr === USDC.toLowerCase()) {
        return { address, chainId: 8453, decimals: 6, symbol: "USDC", isNative: false };
      }
      return { address, chainId: 8453, decimals: 18, symbol: "WETH", isNative: false };
    }),
  };
});

vi.mock("./wallet.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./wallet.js")>();
  return {
    ...orig,
    loadReadOnlyWallet: vi.fn(() => ({
      publicClient: {},
      walletClient: {},
      label: "default",
      account: { address: "0x0000000000000000000000000000000000000001" },
    })),
    loadWallet: vi.fn(),
  };
});

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const { runScheduleTick, planTransientRetry } = await import("./schedules.js");
const {
  openDb,
  closeDb,
  insertSchedule,
  getScheduleById,
  listPaperTrades,
  listOrders,
} = await import("./db.js");
type InsertScheduleArgs = import("./db.js").InsertScheduleArgs;
const { setPaperBalance } = await import("./paperTrade.js");
const { loadConfig } = await import("./config.js");
const { lockEngine, unlockEngine } = await import("./engineLock.js");
const { getCurrentPrice } = await import("./price.js");
const { loadReadOnlyWallet } = await import("./wallet.js");

const mockedPrice = vi.mocked(getCurrentPrice);
const mockedReadOnlyWallet = vi.mocked(loadReadOnlyWallet);

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
  recordAudit: () => {},
  close: () => {},
} as unknown as import("./logger.js").Logger;

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM schedules");
  db.exec("DELETE FROM orders");
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM paper_balances");
  vi.clearAllMocks();
  mockedPrice.mockImplementation(async (address: string) =>
    String(address).toLowerCase() === USDC.toLowerCase() ? 1 : 2000,
  );
  mockedReadOnlyWallet.mockImplementation(() => ({
    publicClient: {},
    walletClient: {},
    label: "default",
    account: { address: "0x0000000000000000000000000000000000000001" },
  }) as never);
});

// ── seeding helpers ──────────────────────────────────────────

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

function seedSchedule(over: Partial<InsertScheduleArgs> = {}): number {
  return insertSchedule({
    name: "dca-test",
    cron_expr: "0 */6 * * *",
    next_run_at: PAST, // due by default
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
    strategy: "tick-test",
    note: null,
    paper: true,
    ...over,
  });
}

function seedQuoteBalance(amount = "10000"): void {
  setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount });
}

const tick = (over: Partial<Parameters<typeof runScheduleTick>[0]> = {}) =>
  runScheduleTick({ logger: noopLogger, ...over });

// ── due gating ───────────────────────────────────────────────

describe("runScheduleTick — due gating", () => {
  it("ignores schedules whose next_run_at is in the future", async () => {
    seedSchedule({ next_run_at: FUTURE });
    const report = await tick();
    expect(report.due).toBe(0);
    expect(report.fires).toHaveLength(0);
  });
});

// ── paper fire (happy path) ──────────────────────────────────

describe("runScheduleTick — paper fire", () => {
  it("fires a due paper schedule: run telemetry + virtual fill + cron advance", async () => {
    seedQuoteBalance("10000");
    const id = seedSchedule();
    const report = await tick();
    expect(report.due).toBe(1);
    expect(report.fired).toBe(1);
    expect(report.fires[0]).toMatchObject({ scheduleId: id, status: "fired" });
    expect(report.fires[0].txHash).toMatch(/^paper:/);

    const row = getScheduleById(id)!;
    expect(row.status).toBe("active");
    expect(row.run_count).toBe(1);
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now()); // advanced to next cron slot
    expect(parseFloat(row.total_quote_spent ?? "0")).toBeGreaterThan(0);

    const paper = listPaperTrades({});
    expect(paper).toHaveLength(1);
    expect(paper[0]).toMatchObject({ source_type: "schedule", source_id: id, direction: "buy" });
  });

  it("a fire that reaches max_runs flips the schedule to completed", async () => {
    seedQuoteBalance("10000");
    const id = seedSchedule({ max_runs: 1 });
    const report = await tick();
    expect(report.fired).toBe(1);
    expect(report.completed).toBe(1); // completedNow path
    expect(getScheduleById(id)?.status).toBe("completed");
    expect(getScheduleById(id)?.run_count).toBe(1);
  });
});

// ── bounds (pre-fire completion paths) ───────────────────────

describe("runScheduleTick — bounds", () => {
  it("end_at in the past completes the schedule without firing", async () => {
    const id = seedSchedule({ end_at: PAST });
    const report = await tick();
    expect(report.completed).toBe(1);
    expect(report.fired).toBe(0);
    expect(getScheduleById(id)?.status).toBe("completed");
    expect(listPaperTrades({})).toHaveLength(0);
  });

  it("run_count >= max_runs completes the schedule without firing", async () => {
    const id = seedSchedule({ max_runs: 2 });
    openDb().prepare(`UPDATE schedules SET run_count = 2 WHERE id = ?`).run(id);
    const report = await tick();
    expect(report.completed).toBe(1);
    expect(getScheduleById(id)?.status).toBe("completed");
  });

  it("start_at in the future re-anchors next_run_at and skips (PRE_START)", async () => {
    // next_run_at corrupted to the past while start_at is still ahead —
    // the defensive re-anchor must repair the row instead of firing.
    const id = seedSchedule({ start_at: FUTURE });
    const report = await tick();
    expect(report.skipped).toBe(1);
    expect(report.fires[0]).toMatchObject({ scheduleId: id, status: "skipped", errorCode: "PRE_START" });
    const row = getScheduleById(id)!;
    expect(row.status).toBe("active");
    expect(Date.parse(row.next_run_at)).toBeGreaterThanOrEqual(Date.parse(PAST));
    expect(listPaperTrades({})).toHaveLength(0);
  });

  it("an unparseable cron_expr terminates the schedule (completed + INVALID_PARAMS)", async () => {
    const id = seedSchedule();
    openDb().prepare(`UPDATE schedules SET cron_expr = 'not a cron' WHERE id = ?`).run(id);
    const report = await tick();
    expect(report.completed).toBe(1);
    const row = getScheduleById(id)!;
    expect(row.status).toBe("completed");
    expect(row.last_error_code).toBe("INVALID_PARAMS");
  });
});

// ── dry-run vs engine lock (opposite advance semantics) ──────

describe("runScheduleTick — dry run", () => {
  it("skips with DRY_RUN and ADVANCES next_run_at (no refire on next tick)", async () => {
    const id = seedSchedule();
    const r1 = await tick({ dryRun: true });
    expect(r1.skipped).toBe(1);
    expect(r1.fires[0]).toMatchObject({ scheduleId: id, status: "skipped", errorCode: "DRY_RUN" });
    expect(Date.parse(getScheduleById(id)!.next_run_at)).toBeGreaterThan(Date.now());
    // Second tick: nothing due — the dry-run consumed the occurrence.
    const r2 = await tick({ dryRun: true });
    expect(r2.due).toBe(0);
  });
});

describe("runScheduleTick — engine lock", () => {
  it("skips with ENGINE_LOCKED and does NOT advance next_run_at (fires after unlock)", async () => {
    const config = loadConfig();
    await lockEngine({ reason: "maintenance", lockedBy: "test", config, logger: noopLogger });
    try {
      seedQuoteBalance("10000");
      const id = seedSchedule();
      const before = getScheduleById(id)!.next_run_at;
      const r1 = await tick();
      expect(r1.skipped).toBe(1);
      expect(r1.fires[0]).toMatchObject({ status: "skipped", errorCode: "ENGINE_LOCKED" });
      // Crucially: next_run_at unchanged — the missed window fires asap.
      expect(getScheduleById(id)!.next_run_at).toBe(before);
      expect(getScheduleById(id)!.last_error_code).toBe("ENGINE_LOCKED");

      await unlockEngine({ unlockedBy: "test", config, logger: noopLogger });
      const r2 = await tick();
      expect(r2.fired).toBe(1); // fired immediately after unlock
    } finally {
      // Idempotent — safe even though the happy path already unlocked.
      await unlockEngine({ unlockedBy: "test", config, logger: noopLogger });
    }
  });
});

// ── failure semantics ────────────────────────────────────────

describe("runScheduleTick — failure semantics", () => {
  it("a terminal fire error advances next_run_at and leaves the schedule active", async () => {
    // No virtual balance → PAPER_INSUFFICIENT_BALANCE (terminal class).
    const id = seedSchedule();
    const report = await tick();
    expect(report.failed).toBe(1);
    const row = getScheduleById(id)!;
    expect(row.status).toBe("active"); // DCA semantic: next occurrence still runs
    expect(row.last_error_code).toBe("PAPER_INSUFFICIENT_BALANCE");
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now()); // advanced — no refire storm
    expect(row.run_count).toBe(0); // failures don't count as runs
  });

  it("a wallet load failure advances next_run_at and records the error", async () => {
    seedQuoteBalance("10000");
    const err = Object.assign(new Error("keystore not found"), { code: "WALLET_NOT_FOUND" });
    mockedReadOnlyWallet.mockImplementation(() => { throw err; });
    const id = seedSchedule();
    const report = await tick();
    expect(report.failed).toBe(1);
    const row = getScheduleById(id)!;
    expect(row.status).toBe("active");
    expect(row.last_error_code).toBe("WALLET_NOT_FOUND");
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now());
  });
});

// ── on_fill hooks ────────────────────────────────────────────

describe("runScheduleTick — on_fill hook", () => {
  it("creates the follow-up order after a fill, with template interpolation", async () => {
    seedQuoteBalance("10000");
    const hook = {
      type: "createOrder",
      spec: {
        side: "sell",
        trigger: "trailing",
        trailPct: 5,
        base: "WETH",
        quote: "USDC",
        baseAmount: "{{filled.baseAmount}}", // whole-field → numeric string preserved
        note: "bracket after fire {{filled.fireNumber}}",
      },
    };
    const id = seedSchedule({ on_fill_json: JSON.stringify(hook) });
    const report = await tick();
    expect(report.fired).toBe(1);
    const fire = report.fires[0] as { onFillOrderId?: number };
    expect(fire.onFillOrderId).toBeGreaterThan(0);

    const orders = listOrders({ status: "all" });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ side: "sell", trigger_type: "trailing", trail_pct: 5 });
    // {{filled.baseAmount}} interpolated with the actual paper fill amount.
    expect(parseFloat(orders[0].base_amount!)).toBeGreaterThan(0);
    expect(orders[0].note).toBe(`bracket after fire 1`);
  });

  it("a failing hook does NOT unwind the fill (fill persists, error reported)", async () => {
    seedQuoteBalance("10000");
    const hook = {
      type: "createOrder",
      spec: {
        side: "sell",
        trigger: "trailing",
        trailPct: -5, // invalid — validateTrailingCreate rejects at hook-fire time
        base: "WETH",
        quote: "USDC",
        baseAmount: "1",
      },
    };
    const id = seedSchedule({ on_fill_json: JSON.stringify(hook) });
    const report = await tick();
    // Fill still counted as fired; schedule telemetry intact.
    expect(report.fired).toBe(1);
    expect(getScheduleById(id)?.run_count).toBe(1);
    expect(listPaperTrades({})).toHaveLength(1);
    // Hook error surfaced on the fire report; no order created.
    const fire = report.fires[0] as { onFillError?: { code: string } };
    expect(fire.onFillError).toBeDefined();
    expect(listOrders({ status: "all" })).toHaveLength(0);
  });
});

// ── v29: decision journal ────────────────────────────────────

describe("runScheduleTick — decision journal (v29)", () => {
  async function withJournal<T>(fn: () => Promise<T>): Promise<T> {
    const { loadConfig, saveConfig } = await import("./config.js");
    const cfg = loadConfig();
    saveConfig({ ...cfg, engine: { ...cfg.engine, scheduleJournal: { enabled: true } } } as never);
    try {
      return await fn();
    } finally {
      saveConfig(cfg);
    }
  }

  it("journal is OFF by default — fires write no rows", async () => {
    seedQuoteBalance("10000");
    seedSchedule();
    await tick();
    const { replayScheduleEntries } = await import("./db.js");
    const all = openDb().prepare(`SELECT COUNT(*) AS n FROM schedule_check_log`).get() as { n: number };
    expect(all.n).toBe(0);
    void replayScheduleEntries;
  });

  it("fired writes a row with run number + paper tx hash", async () => {
    await withJournal(async () => {
      seedQuoteBalance("10000");
      const id = seedSchedule();
      await tick();
      const { replayScheduleEntries } = await import("./db.js");
      const entries = replayScheduleEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].decision).toBe("fired");
      expect(entries[0].run_number).toBe(1);
      expect(entries[0].tx_hash).toMatch(/^paper:/);
    });
  });

  it("paper-balance failure journals fire_failed with the error code", async () => {
    await withJournal(async () => {
      // No quote balance seeded → PAPER_INSUFFICIENT_BALANCE.
      const id = seedSchedule();
      await tick();
      const { replayScheduleEntries } = await import("./db.js");
      const entries = replayScheduleEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].decision).toBe("fire_failed");
      expect(entries[0].error_code).toBeTruthy();
    });
  });

  it("max_runs retirement journals retired_max_runs", async () => {
    await withJournal(async () => {
      // run_count already at the cap → pre-fire retirement branch.
      const id = seedSchedule({ max_runs: 2 });
      openDb().prepare(`UPDATE schedules SET run_count = 2 WHERE id = ?`).run(id);
      await tick();
      const { replayScheduleEntries } = await import("./db.js");
      const entries = replayScheduleEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].decision).toBe("retired_max_runs");
      expect(entries[0].run_number).toBe(2);
    });
  });

  it("engine-lock skips dedupe on repeat ticks (one row, not one per tick)", async () => {
    await withJournal(async () => {
      const { lockEngine: lock2, unlockEngine: unlock2 } = await import("./engineLock.js");
      const cfg = (await import("./config.js")).loadConfig();
      seedQuoteBalance("10000");
      const id = seedSchedule();
      await lock2({ reason: "journal-test", lockedBy: "test", config: cfg, logger: noopLogger });
      try {
        await tick();
        await tick();
        await tick();
      } finally {
        await unlock2({ unlockedBy: "test", config: cfg, logger: noopLogger });
      }
      const { replayScheduleEntries } = await import("./db.js");
      const entries = replayScheduleEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].decision).toBe("skipped_locked");
      expect(entries[0].error_code).toBe("ENGINE_LOCKED");
    });
  });

  it("on_fill hook outcome journals hook_created alongside the fire", async () => {
    await withJournal(async () => {
      seedQuoteBalance("10000");
      const id = seedSchedule({
        on_fill_json: JSON.stringify({
          type: "createOrder",
          spec: {
            side: "sell",
            trigger: "trailing",
            trailPct: 5,
            base: "WETH",
            quote: "USDC",
            baseAmount: "{{filled.baseAmount}}",
          },
        }),
      });
      await tick();
      const { replayScheduleEntries } = await import("./db.js");
      const decisions = replayScheduleEntries(id).map((e) => e.decision).sort();
      expect(decisions).toEqual(["fired", "hook_created"]);
    });
  });
});

// ── multi-leg bracket hooks (createOrders) ──────────────────

describe("runScheduleTick — multi-leg bracket hook", () => {
  it("spawns both legs OCO-paired under the auto group, inheriting paper", async () => {
    seedQuoteBalance("10000");
    const hook = {
      type: "createOrders",
      specs: [
        { side: "sell", trigger: "price_above", price: 3000, base: "WETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
        { side: "sell", trigger: "price_below", price: 1500, base: "WETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
      ],
    };
    const id = seedSchedule({ on_fill_json: JSON.stringify(hook) });
    const report = await tick();
    expect(report.fired).toBe(1);
    const fire = report.fires[0] as { onFillOrderId?: number; onFillOrderIds?: number[] };
    expect(fire.onFillOrderIds).toHaveLength(2);
    expect(fire.onFillOrderId).toBe(fire.onFillOrderIds![0]);

    const orders = listOrders({ status: "all" });
    expect(orders).toHaveLength(2);
    const triggers = orders.map((o) => o.trigger_type).sort();
    expect(triggers).toEqual(["price_above", "price_below"]);
    // One shared auto-OCO group: TP fires → SL cancels, and vice versa.
    for (const o of orders) {
      expect(o.group_id).toBe(`hook-schedule-${id}-1`);
      // The paper schedule's bracket lives on the paper book — never real.
      expect(o.paper).toBe(1);
      // Sized to the fill.
      expect(parseFloat(o.base_amount!)).toBeGreaterThan(0);
    }
  });

  it("a failing bracket leg rolls back the whole bracket, fill kept", async () => {
    seedQuoteBalance("10000");
    const hook = {
      type: "createOrders",
      specs: [
        { side: "sell", trigger: "price_above", price: 3000, base: "WETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
        // trailing without trailPct → leg 2 rejected at fire time
        { side: "sell", trigger: "trailing", base: "WETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
      ],
    };
    seedSchedule({ on_fill_json: JSON.stringify(hook) });
    const report = await tick();
    // Fill persists — hooks never unwind the trade.
    expect(report.fired).toBe(1);
    const fire = report.fires[0] as { onFillError?: { code: string; message: string } };
    expect(fire.onFillError).toBeDefined();
    expect(fire.onFillError!.message).toMatch(/leg 2\/2 failed/);
    // No half-bracket survives: leg 1 was rolled back to cancelled.
    expect(listOrders({ status: "active" })).toHaveLength(0);
  });
});

// ── v32: transient fire retry ────────────────────────────────

describe("planTransientRetry — pure planner", () => {
  const NAT = new Date(Date.now() + 6 * 3_600_000); // natural slot 6h out
  const cfg = () => loadConfig();

  it("terminal codes never retry", () => {
    expect(planTransientRetry({ code: "INSUFFICIENT_BALANCE", retryCount: 0, nowMs: Date.now(), naturalNextAt: NAT, endAt: null, config: cfg() })).toBeNull();
    expect(planTransientRetry({ code: "WALLET_NOT_FOUND", retryCount: 0, nowMs: Date.now(), naturalNextAt: NAT, endAt: null, config: cfg() })).toBeNull();
  });

  it("exponential backoff doubles per attempt (5m → 10m → 20m)", () => {
    const now = Date.now();
    const r1 = planTransientRetry({ code: "RPC_FAILED", retryCount: 0, nowMs: now, naturalNextAt: NAT, endAt: null, config: cfg() })!;
    const r2 = planTransientRetry({ code: "RPC_FAILED", retryCount: 1, nowMs: now, naturalNextAt: NAT, endAt: null, config: cfg() })!;
    const r3 = planTransientRetry({ code: "RPC_FAILED", retryCount: 2, nowMs: now, naturalNextAt: NAT, endAt: null, config: cfg() })!;
    expect(r1.retryAt.getTime() - now).toBe(5 * 60_000);
    expect(r2.retryAt.getTime() - now).toBe(10 * 60_000);
    expect(r3.retryAt.getTime() - now).toBe(20 * 60_000);
    expect(r1.attempt).toBe(1);
    expect(r3.attempt).toBe(3);
  });

  it("budget exhausted (attempt > maxAttempts) returns null", () => {
    expect(planTransientRetry({ code: "RPC_FAILED", retryCount: 3, nowMs: Date.now(), naturalNextAt: NAT, endAt: null, config: cfg() })).toBeNull();
  });

  it("never crosses the next natural occurrence", () => {
    const soon = new Date(Date.now() + 2 * 60_000); // natural slot in 2m < 5m backoff
    expect(planTransientRetry({ code: "RPC_FAILED", retryCount: 0, nowMs: Date.now(), naturalNextAt: soon, endAt: null, config: cfg() })).toBeNull();
  });

  it("never crosses end_at", () => {
    const endAt = new Date(Date.now() + 60_000).toISOString();
    expect(planTransientRetry({ code: "RPC_FAILED", retryCount: 0, nowMs: Date.now(), naturalNextAt: NAT, endAt, config: cfg() })).toBeNull();
  });
});

describe("runScheduleTick — v32 transient retry", () => {
  async function withFireRetry<T>(over: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const { saveConfig } = await import("./config.js");
    const cfg = loadConfig();
    saveConfig({ ...cfg, engine: { ...cfg.engine, fireRetry: { ...cfg.engine.fireRetry, ...over } } } as never);
    try {
      return await fn();
    } finally {
      saveConfig(cfg);
    }
  }

  it("a transient wallet failure parks the schedule on a retry slot", async () => {
    seedQuoteBalance("10000");
    const err = Object.assign(new Error("rpc down"), { code: "RPC_FAILED" });
    mockedReadOnlyWallet.mockImplementation(() => { throw err; });
    const id = seedSchedule(); // cron 0 */6 * * * — natural slot hours out
    const before = Date.now();
    const report = await tick();
    expect(report.failed).toBe(0);
    expect(report.retried).toBe(1);
    const fire = report.fires[0];
    expect(fire.status).toBe("retry_pending");
    expect(fire.retryAttempt).toBe(1);
    const row = getScheduleById(id)!;
    expect(row.status).toBe("active");
    expect(row.retry_count).toBe(1);
    expect(row.last_run_status).toBe("retry_pending");
    const delta = Date.parse(row.next_run_at) - before;
    expect(delta).toBeGreaterThan(4 * 60_000);
    expect(delta).toBeLessThan(6 * 60_000);
    // run_count untouched — the occurrence hasn't happened yet.
    expect(row.run_count).toBe(0);
  });

  it("consecutive failures back off exponentially (2nd attempt ≈ 10m)", async () => {
    seedQuoteBalance("10000");
    const err = Object.assign(new Error("rpc down"), { code: "RPC_FAILED" });
    mockedReadOnlyWallet.mockImplementation(() => { throw err; });
    const id = seedSchedule();
    await tick(); // attempt 1 → retry_count = 1, next_run_at +5m (future)
    // Force the retry slot due now to simulate the retry tick.
    const { setScheduleNextRunAt } = await import("./db.js");
    setScheduleNextRunAt(id, PAST);
    const before = Date.now();
    const report = await tick();
    expect(report.retried).toBe(1);
    const row = getScheduleById(id)!;
    expect(row.retry_count).toBe(2);
    const delta = Date.parse(row.next_run_at) - before;
    expect(delta).toBeGreaterThan(9 * 60_000);
    expect(delta).toBeLessThan(11 * 60_000);
  });

  it("budget exhaustion loses the occurrence: natural slot + reset counter + failed status", async () => {
    seedQuoteBalance("10000");
    const err = Object.assign(new Error("rpc still down"), { code: "RPC_FAILED" });
    mockedReadOnlyWallet.mockImplementation(() => { throw err; });
    const id = seedSchedule();
    openDb().prepare(`UPDATE schedules SET retry_count = 3 WHERE id = ?`).run(id);
    const report = await tick();
    expect(report.retried).toBe(0);
    expect(report.failed).toBe(1);
    const row = getScheduleById(id)!;
    expect(row.retry_count).toBe(0); // reset for the next occurrence
    expect(row.last_run_status).toBe("failed");
    // Advanced to the natural 6h cron slot, not a backoff slot.
    expect(Date.parse(row.next_run_at) - Date.now()).toBeGreaterThan(30 * 60_000);
  });

  it("a successful fire resets a lingering retry counter", async () => {
    seedQuoteBalance("10000");
    const id = seedSchedule();
    openDb().prepare(`UPDATE schedules SET retry_count = 2 WHERE id = ?`).run(id);
    const report = await tick();
    expect(report.fired).toBe(1);
    expect(getScheduleById(id)!.retry_count).toBe(0);
  });

  it("a tight cron (every minute) never retries — the next occurrence supersedes", async () => {
    seedQuoteBalance("10000");
    const err = Object.assign(new Error("rpc down"), { code: "RPC_FAILED" });
    mockedReadOnlyWallet.mockImplementation(() => { throw err; });
    const id = seedSchedule({ cron_expr: "* * * * *" });
    const report = await tick();
    expect(report.retried).toBe(0);
    expect(report.failed).toBe(1);
    expect(getScheduleById(id)!.retry_count).toBe(0);
  });

  it("fireRetry.enabled=false restores pre-v32 behavior", async () => {
    await withFireRetry({ enabled: false }, async () => {
      seedQuoteBalance("10000");
      const err = Object.assign(new Error("rpc down"), { code: "RPC_FAILED" });
      mockedReadOnlyWallet.mockImplementation(() => { throw err; });
      const id = seedSchedule();
      const report = await tick();
      expect(report.retried).toBe(0);
      expect(report.failed).toBe(1);
      expect(getScheduleById(id)!.retry_count).toBe(0);
    });
  });

  it("journals retry_scheduled with the attempt counter", async () => {
    await withJournal2(async () => {
      seedQuoteBalance("10000");
      const err = Object.assign(new Error("rpc down"), { code: "RPC_FAILED" });
      mockedReadOnlyWallet.mockImplementation(() => { throw err; });
      const id = seedSchedule();
      await tick();
      const { replayScheduleEntries } = await import("./db.js");
      const entries = replayScheduleEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].decision).toBe("retry_scheduled");
      expect(entries[0].error_code).toBe("RPC_FAILED");
      expect(entries[0].notes).toMatch(/attempt 1\/3/);
    });
  });

  async function withJournal2<T>(fn: () => Promise<T>): Promise<T> {
    const { saveConfig } = await import("./config.js");
    const cfg = loadConfig();
    saveConfig({ ...cfg, engine: { ...cfg.engine, scheduleJournal: { enabled: true } } } as never);
    try {
      return await fn();
    } finally {
      saveConfig(cfg);
    }
  }
});

// ── v33: crash-window recovery guard ─────────────────────────

describe("runScheduleTick — v33 crash-window recovery", () => {
  const nowIso = () => new Date().toISOString();

  async function seedPaperEvidence(scheduleId: number, over: Record<string, unknown> = {}) {
    const { recordPaperTrade } = await import("./db.js");
    return recordPaperTrade({
      timestamp: nowIso(),
      source_type: "schedule",
      source_id: scheduleId,
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: WETH,
      base_symbol: "WETH",
      base_amount: "0.05",
      quote_token: USDC,
      quote_symbol: "USDC",
      quote_amount: "100",
      price: "2000",
      slippage_bps: 50,
      strategy: null,
      notes: null,
      ...over,
    } as never);
  }

  it("a paper occurrence with an orphaned fill is booked, not refired", async () => {
    seedQuoteBalance("10000");
    const id = seedSchedule(); // due (PAST), paper
    await seedPaperEvidence(id);     // the crashed fire's fill — bookkeeping never landed
    const report = await tick();
    expect(report.recovered).toBe(1);
    expect(report.fired).toBe(0);
    expect(report.fires[0].status).toBe("recovered");

    const row = getScheduleById(id)!;
    expect(row.run_count).toBe(1); // occurrence booked
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now()); // advanced
    expect(row.total_quote_spent).toBe("100"); // amounts from the evidence trade
    // NO second fill: exactly the one orphaned paper trade remains.
    expect(listPaperTrades({})).toHaveLength(1);
  });

  it("a real schedule recovers from a pending trade row without touching the wallet", async () => {
    const { insertTrade } = await import("./db.js");
    const id = seedSchedule({ paper: false });
    insertTrade({
      timestamp: nowIso(),
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "WETH", base_amount: "0.05",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "100",
      price: "2000",
      tx_hash: "0xdeadbeef",
      status: "pending", // TX_TIMEOUT'd — confirmed-or-not, do NOT resubmit
      gas_used: null, gas_price_wei: null, gas_cost_native: null,
      aggregator: "kyberswap", fee_tier: null,
      notes: `[schedule #${id}]`,
      strategy: null,
      realized_slippage_bps: null,
    });
    // Wallet must never be needed: make any wallet access explode.
    mockedReadOnlyWallet.mockImplementation(() => { throw new Error("wallet must not be touched"); });
    const report = await tick();
    expect(report.recovered).toBe(1);
    const row = getScheduleById(id)!;
    expect(row.run_count).toBe(1);
    expect(row.last_run_tx_hash).toBe("0xdeadbeef");
  });

  it("a reverted (failed) trade is NOT evidence — the occurrence refires", async () => {
    const { insertTrade } = await import("./db.js");
    seedQuoteBalance("10000");
    const id = seedSchedule(); // paper — would fire normally
    insertTrade({
      timestamp: nowIso(),
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "WETH", base_amount: "0.05",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "100",
      price: "2000",
      tx_hash: "0xreverted",
      status: "failed",
      gas_used: null, gas_price_wei: null, gas_cost_native: null,
      aggregator: "kyberswap", fee_tier: null,
      notes: `[schedule #${id}]`,
      strategy: null,
      realized_slippage_bps: null,
    });
    const report = await tick();
    expect(report.recovered).toBe(0);
    expect(report.fired).toBe(1); // refired normally
  });

  it("evidence from a PAST occurrence (ts < due time) never false-recovers", async () => {
    seedQuoteBalance("10000");
    const id = seedSchedule(); // next_run_at = PAST (60s ago)
    // A fill from 10 minutes ago — properly-booked previous occurrence.
    await seedPaperEvidence(id, { timestamp: new Date(Date.now() - 600_000).toISOString() });
    const report = await tick();
    expect(report.recovered).toBe(0);
    expect(report.fired).toBe(1);
  });

  it("retry-slot windows reach BACK past the consumed backoff (TX_TIMEOUT interplay)", async () => {
    const { insertTrade } = await import("./db.js");
    const id = seedSchedule({ paper: false });
    // Simulate: fire at T sent a tx → TX_TIMEOUT → retry parked, attempt 1.
    // The evidence trade is ~4 minutes old; next_run_at (retry slot) is due NOW.
    openDb().prepare(`UPDATE schedules SET retry_count = 1 WHERE id = ?`).run(id);
    insertTrade({
      timestamp: new Date(Date.now() - 4 * 60_000).toISOString(),
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "WETH", base_amount: "0.05",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "100",
      price: "2000",
      tx_hash: "0xlanded",
      status: "success", // the timed-out tx confirmed during the backoff
      gas_used: null, gas_price_wei: null, gas_cost_native: null,
      aggregator: "kyberswap", fee_tier: null,
      notes: `[schedule #${id}]`,
      strategy: null,
      realized_slippage_bps: null,
    });
    const report = await tick();
    expect(report.recovered).toBe(1); // booked, NOT refired — no double-buy
    const row = getScheduleById(id)!;
    expect(row.retry_count).toBe(0); // recordScheduleFire reset it
    expect(row.last_run_tx_hash).toBe("0xlanded");
  });

  it("marker matching is exact — schedule #5's evidence never matches #55", async () => {
    const { insertTrade } = await import("./db.js");
    seedQuoteBalance("10000");
    const id = seedSchedule(); // paper id (likely 1)
    insertTrade({
      timestamp: nowIso(),
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "WETH", base_amount: "0.05",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "100",
      price: "2000",
      tx_hash: "0xother",
      status: "success",
      gas_used: null, gas_price_wei: null, gas_cost_native: null,
      aggregator: "kyberswap", fee_tier: null,
      notes: `[schedule #${id}5]`, // a DIFFERENT schedule's marker (id*10+5)
      strategy: null,
      realized_slippage_bps: null,
    });
    const report = await tick();
    expect(report.recovered).toBe(0);
    expect(report.fired).toBe(1);
  });

  it("recovery completes a max_runs=1 campaign and skips the on_fill hook", async () => {
    seedQuoteBalance("10000");
    const hook = {
      type: "createOrder",
      spec: { side: "sell", trigger: "trailing", trailPct: 5, base: "WETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
    };
    const id = seedSchedule({ max_runs: 1, on_fill_json: JSON.stringify(hook) });
    await seedPaperEvidence(id);
    const report = await tick();
    expect(report.recovered).toBe(1);
    const row = getScheduleById(id)!;
    expect(row.status).toBe("completed"); // max_runs reached via recovery
    // Hook deliberately NOT executed on recovery.
    expect(listOrders({ status: "all" })).toHaveLength(0);
  });

  it("journals the recovered decision with the evidence tx", async () => {
    const { saveConfig } = await import("./config.js");
    const cfg = loadConfig();
    saveConfig({ ...cfg, engine: { ...cfg.engine, scheduleJournal: { enabled: true } } } as never);
    try {
      seedQuoteBalance("10000");
      const id = seedSchedule();
      await seedPaperEvidence(id);
      await tick();
      const { replayScheduleEntries } = await import("./db.js");
      const entries = replayScheduleEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].decision).toBe("recovered");
      expect(entries[0].run_number).toBe(1);
      expect(entries[0].notes).toMatch(/booked, not refired/);
    } finally {
      saveConfig(cfg);
    }
  });
});
