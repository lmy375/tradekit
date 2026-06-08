// Tests for scheduleEdit.ts (iter34). Mirrors the orderEdit test
// suite shape: pure validation layer + end-to-end against a tmp DB.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-schedule-edit-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { editSchedule, validateScheduleEdit, renderScheduleDiff } = await import("./scheduleEdit.js");
const {
  openDb,
  closeDb,
  insertSchedule,
  getScheduleById,
} = await import("./db.js");
import type { ScheduleRow } from "./db.js";
const { loadConfig } = await import("./config.js");

beforeAll(() => openDb());
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM schedules");
});

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function seedDaily(opts: { runCount?: number; maxRuns?: number | null } = {}): number {
  const id = insertSchedule({
    name: "test-dca",
    cron_expr: "0 10 * * *",
    next_run_at: "2026-06-01T10:00:00Z",
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
    max_runs: opts.maxRuns ?? null,
    strategy: null,
    note: null,
  });
  if (opts.runCount != null) {
    const db = openDb();
    db.prepare(`UPDATE schedules SET run_count = ? WHERE id = ?`).run(opts.runCount, id);
  }
  return id;
}

// ── validateScheduleEdit ────────────────────────────────────

describe("validateScheduleEdit — happy paths", () => {
  const config = loadConfig();
  const now = new Date("2026-05-31T00:00:00Z");

  it("changes cron + recomputes next_run_at", () => {
    const id = seedDaily();
    const schedule = getScheduleById(id)!;
    const { dbChanges, diff } = validateScheduleEdit({
      schedule,
      changes: { cron: "0 12 * * *" },
      config,
      now,
    });
    expect(dbChanges.cron_expr).toBe("0 12 * * *");
    expect(dbChanges.next_run_at).toBeTypeOf("string");
    // The next_run_at must be in the future relative to `now`.
    expect(Date.parse(dbChanges.next_run_at!)).toBeGreaterThan(now.getTime());
    expect(diff.map((d) => d.field).sort()).toEqual(["cronExpr", "nextRunAt"]);
  });

  it("--every shorthand compiles to cron", () => {
    const id = seedDaily();
    const schedule = getScheduleById(id)!;
    const { dbChanges } = validateScheduleEdit({
      schedule,
      changes: { every: "1h" },
      config,
      now,
    });
    expect(dbChanges.cron_expr).toBeDefined();
    // 1h compiles to "0 * * * *"
    expect(dbChanges.cron_expr).toMatch(/^\S+ \* \* \* \*$/);
  });

  it("emits empty diff when nothing changed", () => {
    const id = seedDaily();
    const schedule = getScheduleById(id)!;
    const { diff } = validateScheduleEdit({
      schedule,
      changes: { quoteAmount: "100", slippageBps: 50 },
      config,
      now,
    });
    expect(diff).toEqual([]);
  });

  it("accepts setting endAt + maxRuns together", () => {
    const id = seedDaily();
    const schedule = getScheduleById(id)!;
    const { dbChanges, diff } = validateScheduleEdit({
      schedule,
      changes: {
        endAt: "2026-12-31T23:59:59Z",
        maxRuns: 50,
      },
      config,
      now,
    });
    expect(dbChanges.end_at).toBe("2026-12-31T23:59:59Z");
    expect(dbChanges.max_runs).toBe(50);
    expect(diff).toHaveLength(2);
  });
});

describe("validateScheduleEdit — rejection paths", () => {
  const config = loadConfig();
  const now = new Date("2026-05-31T00:00:00Z");

  it("rejects edit on terminal schedule", () => {
    const id = seedDaily();
    const schedule = { ...getScheduleById(id)!, status: "completed" } as ScheduleRow;
    expect(() =>
      validateScheduleEdit({ schedule, changes: { quoteAmount: "200" }, config, now }),
    ).toThrow(/only active\/paused schedules are editable/);
  });

  it("accepts edit on paused schedule", () => {
    const id = seedDaily();
    const schedule = { ...getScheduleById(id)!, status: "paused" } as ScheduleRow;
    expect(() =>
      validateScheduleEdit({ schedule, changes: { quoteAmount: "200" }, config, now }),
    ).not.toThrow();
  });

  it("rejects both cron + every", () => {
    const id = seedDaily();
    const schedule = getScheduleById(id)!;
    expect(() =>
      validateScheduleEdit({ schedule, changes: { cron: "0 * * * *", every: "1h" }, config, now }),
    ).toThrow(/exactly one of cron \/ every/);
  });

  it("rejects malformed cron", () => {
    const id = seedDaily();
    const schedule = getScheduleById(id)!;
    expect(() =>
      validateScheduleEdit({ schedule, changes: { cron: "not a cron" }, config, now }),
    ).toThrow(/Invalid cron expression/);
  });

  it("rejects both amount types set", () => {
    const id = seedDaily();
    const schedule = getScheduleById(id)!;
    expect(() =>
      validateScheduleEdit({
        schedule,
        changes: { baseAmount: "1", quoteAmount: "100" },
        config,
        now,
      }),
    ).toThrow(/cannot have both set/);
  });

  it("rejects maxRuns below current run_count", () => {
    const id = seedDaily({ runCount: 10 });
    const schedule = getScheduleById(id)!;
    expect(() =>
      validateScheduleEdit({ schedule, changes: { maxRuns: 5 }, config, now }),
    ).toThrow(/cannot be less than the current run_count/);
  });

  it("accepts maxRuns EQUAL to current run_count", () => {
    const id = seedDaily({ runCount: 10 });
    const schedule = getScheduleById(id)!;
    const { dbChanges } = validateScheduleEdit({
      schedule,
      changes: { maxRuns: 10 },
      config,
      now,
    });
    expect(dbChanges.max_runs).toBe(10);
  });

  it("rejects endAt in the past", () => {
    const id = seedDaily();
    const schedule = getScheduleById(id)!;
    expect(() =>
      validateScheduleEdit({
        schedule,
        changes: { endAt: "2020-01-01T00:00:00Z" },
        config,
        now,
      }),
    ).toThrow(/in the future/);
  });

  it("rejects slippage above safety cap", () => {
    const id = seedDaily();
    const schedule = getScheduleById(id)!;
    const tight = { ...config, safety: { ...config.safety, maxSlippageBps: 200 } } as never;
    expect(() => validateScheduleEdit({ schedule, changes: { slippageBps: 500 }, config: tight, now })).toThrow(
      /SLIPPAGE_TOO_HIGH|exceeds safety/,
    );
  });
});

// ── editSchedule end-to-end ─────────────────────────────────

describe("editSchedule — end-to-end", () => {
  it("preserves run_count + total_base_filled across edits", () => {
    const id = seedDaily({ runCount: 12 });
    const db = openDb();
    db.prepare(`UPDATE schedules SET total_base_filled = ?, total_quote_spent = ? WHERE id = ?`).run(
      "1.5", "3000", id,
    );
    editSchedule({ id, changes: { slippageBps: 75 } });
    const after = getScheduleById(id)!;
    expect(after.run_count).toBe(12);
    expect(after.total_base_filled).toBe("1.5");
    expect(after.total_quote_spent).toBe("3000");
    expect(after.slippage_bps).toBe(75);
  });

  it("cron edit recomputes next_run_at + persists both", () => {
    const id = seedDaily();
    const result = editSchedule({ id, changes: { cron: "0 12 * * *" } });
    const after = getScheduleById(id)!;
    expect(after.cron_expr).toBe("0 12 * * *");
    expect(after.next_run_at).not.toBe("2026-06-01T10:00:00Z");
    expect(result.diff.map((d) => d.field).sort()).toEqual(["cronExpr", "nextRunAt"]);
  });

  it("rejects edit on terminal schedule with useful error", () => {
    const id = seedDaily();
    const db = openDb();
    db.prepare(`UPDATE schedules SET status = 'completed' WHERE id = ?`).run(id);
    expect(() => editSchedule({ id, changes: { slippageBps: 75 } })).toThrow(
      /only active\/paused schedules are editable/,
    );
  });

  it("throws on unknown schedule id", () => {
    expect(() => editSchedule({ id: 999999, changes: { slippageBps: 75 } })).toThrow(/not found/);
  });

  it("is a no-op when nothing changed", () => {
    const id = seedDaily();
    const before = getScheduleById(id)!;
    const result = editSchedule({ id, changes: { quoteAmount: "100", slippageBps: 50 } });
    expect(result.diff).toEqual([]);
    const after = getScheduleById(id)!;
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("paused schedule edit succeeds + preserves status", () => {
    const id = seedDaily();
    const db = openDb();
    db.prepare(`UPDATE schedules SET status = 'paused' WHERE id = ?`).run(id);
    editSchedule({ id, changes: { slippageBps: 75 } });
    const after = getScheduleById(id)!;
    expect(after.status).toBe("paused");
    expect(after.slippage_bps).toBe(75);
  });

  it("onFill removal clears stored hook", () => {
    const id = seedDaily();
    const db = openDb();
    db.prepare(`UPDATE schedules SET on_fill_json = ? WHERE id = ?`).run('{"type":"createOrder"}', id);
    editSchedule({ id, changes: { onFill: null } });
    const after = getScheduleById(id)!;
    expect(after.on_fill_json).toBeNull();
  });
});

describe("renderScheduleDiff", () => {
  it("emits compact JSON of per-field changes", () => {
    const out = renderScheduleDiff([
      { field: "cronExpr", oldValue: "0 10 * * *", newValue: "0 12 * * *" },
      { field: "slippageBps", oldValue: 50, newValue: 75 },
    ]);
    const parsed = JSON.parse(out) as Record<string, [unknown, unknown]>;
    expect(parsed.cronExpr).toEqual(["0 10 * * *", "0 12 * * *"]);
    expect(parsed.slippageBps).toEqual([50, 75]);
  });
});
