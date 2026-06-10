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

const { runScheduleTick } = await import("./schedules.js");
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
