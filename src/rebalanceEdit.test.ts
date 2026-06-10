/**
 * Rebalance-plan edit tests. Three layers, mirroring orderEdit /
 * scheduleEdit coverage:
 *
 *   1. validateRebalanceEdit — pure validation against a fixture row
 *      (targets sum/dupes, threshold/minTrade ranges, cron recompute,
 *      endAt future, maxRuns >= run_count, slippage cap, status gate)
 *   2. editRebalancePlan — end-to-end against the real DB: persisted
 *      fields, run_count untouched, no-op edits, race-loss guard
 *   3. The state-preservation contract that motivated the module:
 *      re-weighting a plan keeps run_count + last-run telemetry.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-rebalanceEdit-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { validateRebalanceEdit, editRebalancePlan, renderRebalanceDiff } = await import("./rebalanceEdit.js");
const {
  openDb,
  closeDb,
  insertRebalancePlan,
  getRebalancePlanById,
} = await import("./db.js");
const { loadConfig } = await import("./config.js");

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  openDb().exec("DELETE FROM rebalance_plans");
});

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NOW = new Date("2026-06-10T12:00:00Z");

function seedPlan(over: Partial<Parameters<typeof insertRebalancePlan>[0]> = {}): number {
  return insertRebalancePlan({
    name: "core-folio",
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
    next_run_at: "2026-06-10T18:00:00.000Z",
    start_at: null,
    end_at: null,
    max_runs: null,
    slippage_bps: 50,
    auto_slippage: false,
    strategy: "folio",
    note: null,
    ...over,
  });
}

function planRow(id: number) {
  const row = getRebalancePlanById(id);
  if (!row) throw new Error(`plan ${id} missing`);
  return row;
}

const config = loadConfig();

// ── validateRebalanceEdit ───────────────────────────────────

describe("validateRebalanceEdit", () => {
  it("re-weighting targets produces a targets diff", () => {
    const plan = planRow(seedPlan());
    const { dbChanges, diff } = validateRebalanceEdit({
      plan,
      changes: { targets: [{ token: "ETH", targetPct: 70 }, { token: "USDC", targetPct: 30 }] },
      config,
      now: NOW,
    });
    expect(dbChanges.targets_json).toContain('"targetPct":70');
    expect(diff).toHaveLength(1);
    expect(diff[0].field).toBe("targets");
  });

  it("rejects targets that don't sum to 100", () => {
    const plan = planRow(seedPlan());
    expect(() =>
      validateRebalanceEdit({
        plan,
        changes: { targets: [{ token: "ETH", targetPct: 70 }, { token: "USDC", targetPct: 40 }] },
        config,
        now: NOW,
      }),
    ).toThrow(/sum/i);
  });

  it("rejects an empty targets array", () => {
    const plan = planRow(seedPlan());
    expect(() =>
      validateRebalanceEdit({ plan, changes: { targets: [] }, config, now: NOW }),
    ).toThrow(/non-empty/i);
  });

  it("driftThresholdPct must be in (0, 100)", () => {
    const plan = planRow(seedPlan());
    for (const bad of [0, -3, 100, 250]) {
      expect(() =>
        validateRebalanceEdit({ plan, changes: { driftThresholdPct: bad }, config, now: NOW }),
      ).toThrow(/driftThresholdPct/);
    }
    const { dbChanges } = validateRebalanceEdit({ plan, changes: { driftThresholdPct: 8 }, config, now: NOW });
    expect(dbChanges.drift_threshold_pct).toBe(8);
  });

  it("cron change recomputes next_run_at from now", () => {
    const plan = planRow(seedPlan());
    const { dbChanges, diff } = validateRebalanceEdit({
      plan,
      changes: { every: "1d" },
      config,
      now: NOW,
    });
    expect(dbChanges.cron_expr).toBeTruthy();
    expect(dbChanges.next_run_at).toBeTruthy();
    expect(Date.parse(dbChanges.next_run_at!)).toBeGreaterThan(NOW.getTime());
    expect(diff.map((d) => d.field).sort()).toEqual(["cronExpr", "nextRunAt"]);
  });

  it("rejects cron + every together", () => {
    const plan = planRow(seedPlan());
    expect(() =>
      validateRebalanceEdit({ plan, changes: { cron: "0 * * * *", every: "1d" }, config, now: NOW }),
    ).toThrow(/exactly one/i);
  });

  it("endAt must be a future ISO timestamp; null clears", () => {
    const plan = planRow(seedPlan({ end_at: "2026-12-31T00:00:00.000Z" }));
    expect(() =>
      validateRebalanceEdit({ plan, changes: { endAt: "2020-01-01T00:00:00Z" }, config, now: NOW }),
    ).toThrow(/future/);
    expect(() =>
      validateRebalanceEdit({ plan, changes: { endAt: "not-a-date" }, config, now: NOW }),
    ).toThrow(/ISO-8601/);
    const { dbChanges } = validateRebalanceEdit({ plan, changes: { endAt: null }, config, now: NOW });
    expect(dbChanges.end_at).toBeNull();
  });

  it("maxRuns below run_count rejects with structured guidance", () => {
    const id = seedPlan();
    openDb().prepare(`UPDATE rebalance_plans SET run_count = 5 WHERE id = ?`).run(id);
    const plan = planRow(id);
    expect(() =>
      validateRebalanceEdit({ plan, changes: { maxRuns: 3 }, config, now: NOW }),
    ).toThrow(/run_count/);
    // Equal is fine — "retire after the next run".
    const { dbChanges } = validateRebalanceEdit({ plan, changes: { maxRuns: 5 }, config, now: NOW });
    expect(dbChanges.max_runs).toBe(5);
  });

  it("slippageBps is capped by safety.maxSlippageBps", () => {
    const plan = planRow(seedPlan());
    const cap = config.safety?.maxSlippageBps ?? 5000;
    expect(() =>
      validateRebalanceEdit({ plan, changes: { slippageBps: cap + 1 }, config, now: NOW }),
    ).toThrow(/maxSlippageBps/);
  });

  it("terminal statuses are not editable", () => {
    const id = seedPlan();
    openDb().prepare(`UPDATE rebalance_plans SET status = 'cancelled' WHERE id = ?`).run(id);
    const plan = planRow(id);
    expect(() =>
      validateRebalanceEdit({ plan, changes: { driftThresholdPct: 8 }, config, now: NOW }),
    ).toThrow(/cancelled/);
  });

  it("paused plans ARE editable", () => {
    const id = seedPlan();
    openDb().prepare(`UPDATE rebalance_plans SET status = 'paused' WHERE id = ?`).run(id);
    const plan = planRow(id);
    const { diff } = validateRebalanceEdit({ plan, changes: { driftThresholdPct: 8 }, config, now: NOW });
    expect(diff).toHaveLength(1);
  });

  it("same-value changes produce an empty diff (idempotent)", () => {
    const plan = planRow(seedPlan());
    const { diff } = validateRebalanceEdit({
      plan,
      changes: { driftThresholdPct: 5, minTradeUsd: 10, note: null },
      config,
      now: NOW,
    });
    expect(diff).toEqual([]);
  });
});

// ── editRebalancePlan end-to-end ────────────────────────────

describe("editRebalancePlan", () => {
  it("re-weighting persists targets and PRESERVES run_count + telemetry", () => {
    const id = seedPlan();
    openDb()
      .prepare(`UPDATE rebalance_plans SET run_count = 4, last_run_at = '2026-06-09T00:00:00.000Z', last_run_max_drift_pct = 6.5 WHERE id = ?`)
      .run(id);

    const result = editRebalancePlan({
      id,
      changes: { targets: [{ token: "ETH", targetPct: 70 }, { token: "USDC", targetPct: 30 }], driftThresholdPct: 8 },
      config,
      nowFn: () => NOW,
    });

    expect(result.diff.map((d) => d.field).sort()).toEqual(["driftThresholdPct", "targets"]);
    const after = planRow(id);
    expect(JSON.parse(after.targets_json)).toEqual([
      { token: "ETH", targetPct: 70 },
      { token: "USDC", targetPct: 30 },
    ]);
    expect(after.drift_threshold_pct).toBe(8);
    // The whole point of edit-vs-recreate:
    expect(after.run_count).toBe(4);
    expect(after.last_run_at).toBe("2026-06-09T00:00:00.000Z");
    expect(after.last_run_max_drift_pct).toBe(6.5);
    expect(after.status).toBe("active");
  });

  it("no-op edit returns empty diff without touching updated_at", () => {
    const id = seedPlan();
    const before = planRow(id);
    const result = editRebalancePlan({ id, changes: { driftThresholdPct: 5 }, config, nowFn: () => NOW });
    expect(result.diff).toEqual([]);
    expect(planRow(id).updated_at).toBe(before.updated_at);
  });

  it("unknown id throws INVALID_PARAMS", () => {
    expect(() => editRebalancePlan({ id: 99_999, changes: { driftThresholdPct: 8 }, config })).toThrow(/not found/);
  });

  it("race-loss: plan goes terminal between read and write → structured error, no silent overwrite", () => {
    const id = seedPlan();
    const plan = planRow(id);
    // Simulate the race by validating against the live row, then
    // flipping status before the guarded UPDATE would run.
    openDb().prepare(`UPDATE rebalance_plans SET status = 'completed' WHERE id = ?`).run(id);
    expect(() =>
      editRebalancePlan({ id, changes: { driftThresholdPct: 9 }, config, nowFn: () => NOW }),
    ).toThrow(/completed/);
    expect(planRow(id).drift_threshold_pct).toBe(plan.drift_threshold_pct); // unchanged
  });

  it("paper flip persists", () => {
    const id = seedPlan();
    editRebalancePlan({ id, changes: { paper: true }, config, nowFn: () => NOW });
    expect(planRow(id).paper).toBe(1);
    editRebalancePlan({ id, changes: { paper: false }, config, nowFn: () => NOW });
    expect(planRow(id).paper).toBe(0);
  });

  it("cron edit moves next_run_at", () => {
    const id = seedPlan();
    const before = planRow(id);
    editRebalancePlan({ id, changes: { every: "1d" }, config, nowFn: () => NOW });
    const after = planRow(id);
    expect(after.cron_expr).not.toBe(before.cron_expr);
    expect(after.next_run_at).not.toBe(before.next_run_at);
  });

  it("renderRebalanceDiff produces compact field→[old,new] JSON", () => {
    const id = seedPlan();
    const result = editRebalancePlan({ id, changes: { driftThresholdPct: 8 }, config, nowFn: () => NOW });
    const rendered = JSON.parse(renderRebalanceDiff(result.diff)) as Record<string, [unknown, unknown]>;
    expect(rendered["driftThresholdPct"]).toEqual([5, 8]);
  });
});
