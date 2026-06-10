/**
 * Playbook diff + replace tests.
 *
 * Layers:
 *   1. Pure diff (computePlaybookDiff) — 4 buckets + structural
 *      matching + multi-key disambiguation + field-change detection
 *   2. structuralKey — different-trigger orders on same pair are
 *      distinct keys; rebalance keys derived from targets list
 *   3. Atomic replace (replacePlaybook) — full end-to-end on real DB:
 *      added/modified/removed apply, validation failure rolls back
 *      pre-cancel, playbook row updated with new hash + spec_json
 *   4. Edge cases — empty new spec, status filter (replace only
 *      deployed playbooks), missing playbook id
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-playbookReplace-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  computePlaybookDiff,
  structuralKey,
  replacePlaybook,
} = await import("./playbookReplace.js");
const {
  parsePlaybookSpec,
  deployPlaybook,
  getPlaybookDetail,
} = await import("./playbooks.js");
const {
  openDb,
  closeDb,
  getPlaybookById,
} = await import("./db.js");

beforeAll(() => { openDb(); });
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
});

// ── structural key ───────────────────────────────────────────

describe("structuralKey", () => {
  it("orders use type:side:trigger:base:quote", () => {
    const spec = parsePlaybookSpec({
      name: "x",
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    expect(structuralKey(spec.strategies[0])).toBe("order:sell:trailing:ETH:USDC");
  });

  it("orders with different triggers are distinct keys", () => {
    const a = parsePlaybookSpec({
      name: "x", strategies: [
        { type: "order", side: "sell", trigger: "price_above", price: 4000, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const b = parsePlaybookSpec({
      name: "x", strategies: [
        { type: "order", side: "sell", trigger: "price_below", price: 2700, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    expect(structuralKey(a.strategies[0])).not.toBe(structuralKey(b.strategies[0]));
  });

  it("schedules don't include trigger (no concept)", () => {
    const spec = parsePlaybookSpec({
      name: "x",
      strategies: [
        { type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
      ],
    });
    expect(structuralKey(spec.strategies[0])).toBe("schedule:buy:ETH:USDC");
  });

  it("rebalance uses name + sorted targets fingerprint", () => {
    const spec = parsePlaybookSpec({
      name: "x",
      strategies: [
        {
          type: "rebalance", name: "core",
          targets: [{ token: "USDC", targetPct: 40 }, { token: "ETH", targetPct: 60 }],
        },
      ],
    });
    expect(structuralKey(spec.strategies[0])).toBe("rebalance:core:ETH,USDC");
  });

  it("rebalance target reordering produces same key", () => {
    const a = parsePlaybookSpec({
      name: "x",
      strategies: [
        { type: "rebalance", name: "core", targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }] },
      ],
    });
    const b = parsePlaybookSpec({
      name: "x",
      strategies: [
        { type: "rebalance", name: "core", targets: [{ token: "USDC", targetPct: 40 }, { token: "ETH", targetPct: 60 }] },
      ],
    });
    expect(structuralKey(a.strategies[0])).toBe(structuralKey(b.strategies[0]));
  });
});

// ── pure diff ────────────────────────────────────────────────

function mkSpec(strategies: unknown[]): ReturnType<typeof parsePlaybookSpec> {
  return parsePlaybookSpec({ name: "diff-test", strategies });
}

describe("computePlaybookDiff", () => {
  it("identical specs produce all-unchanged + noChanges=true", () => {
    const s = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      { type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
    ]);
    const d = computePlaybookDiff({ oldSpec: s, newSpec: s, playbookId: 1 });
    expect(d.noChanges).toBe(true);
    expect(d.summary).toEqual({ unchanged: 2, modified: 0, added: 0, removed: 0 });
  });

  it("classifies a trailPct change as modified, not removed+added", () => {
    const oldSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const newSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 10, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    expect(d.summary).toEqual({ unchanged: 0, modified: 1, added: 0, removed: 0 });
    const e = d.entries[0];
    expect(e.status).toBe("modified");
    expect(e.fieldChanges.map((c) => c.path)).toContain("trailPct");
    expect(e.fieldChanges.find((c) => c.path === "trailPct")?.oldValue).toBe(5);
    expect(e.fieldChanges.find((c) => c.path === "trailPct")?.newValue).toBe(10);
  });

  it("v2: trailing order with only editable changes is applyMode=edit and does NOT set willResetTrailingHwm", () => {
    const oldSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const newSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 7, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    const modified = d.entries.find((e) => e.status === "modified");
    expect(modified?.applyMode).toBe("edit");
    // Edit-in-place preserves the HWM — the warning flag must stay off.
    expect(d.willResetTrailingHwm).toBe(false);
  });

  it("v2: trailing order with a frozen-field change (group) is applyMode=recreate and sets willResetTrailingHwm", () => {
    const oldSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket-a" },
    ]);
    const newSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket-b" },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    const modified = d.entries.find((e) => e.status === "modified");
    expect(modified?.applyMode).toBe("recreate");
    expect(modified?.recreateReason).toContain("group");
    expect(d.willResetTrailingHwm).toBe(true);
  });

  it("v3: modified rebalance with editable changes is applyMode=edit (rebalanceEdit.ts)", () => {
    const oldSpec = mkSpec([
      { type: "rebalance", name: "folio", targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }], driftThresholdPct: 5 },
    ]);
    const newSpec = mkSpec([
      { type: "rebalance", name: "folio", targets: [{ token: "ETH", targetPct: 70 }, { token: "USDC", targetPct: 30 }], driftThresholdPct: 8 },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    const modified = d.entries.find((e) => e.status === "modified");
    expect(modified?.applyMode).toBe("edit"); // re-weight + threshold are both editable
    expect(d.willResetTrailingHwm).toBe(false); // not a trailing order
  });

  it("v3: rebalance quoteToken change is frozen → applyMode=recreate", () => {
    const oldSpec = mkSpec([
      { type: "rebalance", name: "folio", targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }], quoteToken: "USDC" },
    ]);
    const newSpec = mkSpec([
      { type: "rebalance", name: "folio", targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }], quoteToken: "WETH" },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    const modified = d.entries.find((e) => e.status === "modified");
    expect(modified?.applyMode).toBe("recreate");
    expect(modified?.recreateReason).toContain("quoteToken");
  });

  it("modified non-trailing order does NOT set willResetTrailingHwm", () => {
    const oldSpec = mkSpec([
      { type: "order", side: "sell", trigger: "price_above", price: 4000, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const newSpec = mkSpec([
      { type: "order", side: "sell", trigger: "price_above", price: 4500, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    expect(d.willResetTrailingHwm).toBe(false);
  });

  it("added primitive in new spec produces added entry", () => {
    const oldSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const newSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      { type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    expect(d.summary).toEqual({ unchanged: 1, modified: 0, added: 1, removed: 0 });
    const added = d.entries.find((e) => e.status === "added");
    expect(added?.type).toBe("schedule");
  });

  it("removed primitive in old spec produces removed entry", () => {
    const oldSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      { type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
    ]);
    const newSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    expect(d.summary).toEqual({ unchanged: 1, modified: 0, added: 0, removed: 1 });
    const removed = d.entries.find((e) => e.status === "removed");
    expect(removed?.type).toBe("schedule");
  });

  it("hashes differ when specs differ", () => {
    const oldSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const newSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 10, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    expect(d.oldHash).not.toBe(d.newHash);
    expect(d.noChanges).toBe(false);
  });

  it("handles same-key duplicates by index-within-key matching", () => {
    // Two trailing-sells on same pair with different trailPcts. Both
    // share the structural key — the diff matches first occurrence
    // to first occurrence, then second to second.
    const oldSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      { type: "order", side: "sell", trigger: "trailing", trailPct: 10, baseAmount: 2, base: "ETH", quote: "USDC" },
    ]);
    const newSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" }, // unchanged
      { type: "order", side: "sell", trigger: "trailing", trailPct: 15, baseAmount: 2, base: "ETH", quote: "USDC" }, // modified
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    expect(d.summary).toEqual({ unchanged: 1, modified: 1, added: 0, removed: 0 });
    const modified = d.entries.find((e) => e.status === "modified");
    expect(modified?.fieldChanges.find((c) => c.path === "trailPct")?.newValue).toBe(15);
  });

  it("ignores `id` field differences (operator metadata)", () => {
    const oldSpec = mkSpec([
      { id: "trail-a", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const newSpec = mkSpec([
      { id: "trail-b", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    // The `id` change shouldn't flip an otherwise-identical primitive
    // to "modified".
    expect(d.summary.unchanged).toBe(1);
  });
});

// ── atomic replace ───────────────────────────────────────────

describe("replacePlaybook — happy paths", () => {
  it("end-to-end: deploy → replace → playbook owns new primitives", () => {
    const initial = parsePlaybookSpec({
      name: "replace-test",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec: initial, sourcePath: null });
    expect(deploy.alreadyDeployed).toBe(false);

    // New spec: change trailPct + add a TP order. DCA stays.
    const updated = parsePlaybookSpec({
      name: "replace-test",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 10, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
        { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 5000, baseAmount: 0.5, base: "ETH", quote: "USDC" },
      ],
    });
    const result = replacePlaybook({
      playbookId: deploy.playbookId,
      newSpec: updated,
      newSourcePath: null,
    });

    // Diff classification: 1 unchanged (dca), 1 modified (trail), 1 added (tp).
    expect(result.diff.summary.unchanged).toBe(1);
    expect(result.diff.summary.modified).toBe(1);
    expect(result.diff.summary.added).toBe(1);
    expect(result.diff.summary.removed).toBe(0);

    // v2: the trailPct change is in-place editable — the trail order is
    // EDITED (keeps its row id + HWM), not cancelled + recreated. Only
    // the added TP order is created.
    expect(result.edited.length).toBe(1);
    expect(result.edited[0].type).toBe("order");
    expect(result.edited[0].fields).toEqual(["trailPct"]);
    expect(result.created.length).toBe(1);
    expect(result.cancelled.length).toBe(0);
  });

  it("playbook row's spec_json + source_hash update after replace", () => {
    const initial = parsePlaybookSpec({
      name: "hash-update",
      chain: "base",
      account: "default",
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec: initial, sourcePath: null });
    const before = getPlaybookById(deploy.playbookId);

    const updated = parsePlaybookSpec({
      name: "hash-update",
      chain: "base",
      account: "default",
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 12, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    replacePlaybook({ playbookId: deploy.playbookId, newSpec: updated, newSourcePath: "/path/v2.json" });

    const after = getPlaybookById(deploy.playbookId);
    expect(after?.source_hash).not.toBe(before?.source_hash);
    expect(after?.source_path).toBe("/path/v2.json");
    const persistedSpec = JSON.parse(after!.spec_json);
    expect(persistedSpec.strategies[0].trailPct).toBe(12);
  });

  it("primitives left over after replace are only the new ones (cancelled old removed from active)", () => {
    const initial = parsePlaybookSpec({
      name: "active-set",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec: initial, sourcePath: null });

    const detailBefore = getPlaybookDetail(deploy.playbookId);
    expect(detailBefore.orders.filter((o) => o.status === "active").length).toBe(1);

    const updated = parsePlaybookSpec({
      name: "active-set",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 15, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    replacePlaybook({ playbookId: deploy.playbookId, newSpec: updated, newSourcePath: null });

    const detailAfter = getPlaybookDetail(deploy.playbookId);
    // v2: the trailPct change is edit-in-place — SAME row, updated value,
    // no cancelled twin left behind.
    expect(detailAfter.orders.length).toBe(1);
    const activeOrders = detailAfter.orders.filter((o) => o.status === "active");
    expect(activeOrders.length).toBe(1);
    expect(activeOrders[0].trail_pct).toBe(15);
    expect(activeOrders[0].id).toBe(detailBefore.orders[0].id);
  });

  it("no-op when new spec is identical to old", () => {
    const spec = parsePlaybookSpec({
      name: "noop",
      chain: "base",
      account: "default",
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec, sourcePath: null });
    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: spec, newSourcePath: null });
    expect(result.diff.noChanges).toBe(true);
    expect(result.created.length).toBe(0);
    expect(result.cancelled.length).toBe(0);
  });
});

describe("replacePlaybook — error paths", () => {
  it("throws on missing playbook id", () => {
    const newSpec = parsePlaybookSpec({
      name: "x",
      strategies: [{ type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" }],
    });
    expect(() => replacePlaybook({ playbookId: 99999, newSpec, newSourcePath: null })).toThrow(/No playbook/);
  });

  it("pre-validation catches bad new primitive BEFORE any cancellation", () => {
    const initial = parsePlaybookSpec({
      name: "prevalid",
      chain: "base",
      account: "default",
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec: initial, sourcePath: null });

    // New spec references an unresolvable token on the base chain.
    // Pre-validate's resolveTradePair throws UNKNOWN_TOKEN BEFORE we
    // touch any DB state.
    const badNew = parsePlaybookSpec({
      name: "prevalid",
      chain: "base",
      account: "default",
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "BOGUS-NOT-A-TOKEN", quote: "USDC" },
      ],
    });
    let err: { code?: string } | undefined;
    try {
      replacePlaybook({ playbookId: deploy.playbookId, newSpec: badNew, newSourcePath: null });
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe("UNKNOWN_TOKEN");

    // The old primitive is STILL ACTIVE — pre-validation prevented
    // the cancel-before-fail problem.
    const detail = getPlaybookDetail(deploy.playbookId);
    const activeOrders = detail.orders.filter((o) => o.status === "active");
    expect(activeOrders.length).toBe(1);
    expect(activeOrders[0].base_symbol).toBe("ETH");
  });

  it("rejects replace on destroyed playbook", () => {
    const spec = parsePlaybookSpec({
      name: "destroyed",
      chain: "base",
      account: "default",
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec, sourcePath: null });
    // Manually flip status to destroyed via direct DB access.
    const db = openDb();
    db.prepare(`UPDATE playbooks SET status = 'destroyed' WHERE id = ?`).run(deploy.playbookId);

    expect(() =>
      replacePlaybook({ playbookId: deploy.playbookId, newSpec: spec, newSourcePath: null }),
    ).toThrow(/not.*deployed|destroyed/i);
  });
});

// ── v2: state preservation + paper inference ─────────────────

describe("replacePlaybook v2 — state-preserving modify", () => {
  function deployTrailDca(opts: { paper?: boolean } = {}) {
    const spec = parsePlaybookSpec({
      name: "v2-state",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
      ],
    });
    return { spec, deploy: deployPlaybook({ spec, sourcePath: null, ...(opts.paper ? { paper: true } : {}) }) };
  }

  it("trailing HWM survives an in-place edit (the headline v2 win)", () => {
    const { deploy } = deployTrailDca();
    const db = openDb();
    const orderId = getPlaybookDetail(deploy.playbookId).orders[0].id!;
    // Engine has been tracking: HWM sits at 3500.
    db.prepare(`UPDATE orders SET water_mark_usd = 3500 WHERE id = ?`).run(orderId);

    const updated = parsePlaybookSpec({
      name: "v2-state",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 8, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
      ],
    });
    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: updated, newSourcePath: null });

    expect(result.edited).toEqual([{ type: "order", rowId: orderId, localId: "trail", fields: ["trailPct"] }]);
    expect(result.cancelled).toEqual([]);
    expect(result.created).toEqual([]);

    const after = getPlaybookDetail(deploy.playbookId).orders[0];
    expect(after.id).toBe(orderId);
    expect(after.trail_pct).toBe(8);
    expect(after.water_mark_usd).toBe(3500); // HWM intact
    expect(after.status).toBe("active");

    // Journal continuity: the edit landed an edited_by_operator row.
    const journal = db
      .prepare(`SELECT decision FROM order_check_log WHERE order_id = ? ORDER BY id DESC LIMIT 1`)
      .get(orderId) as { decision: string } | undefined;
    expect(journal?.decision).toBe("edited_by_operator");
  });

  it("schedule run counters survive an in-place edit", () => {
    const { deploy } = deployTrailDca();
    const db = openDb();
    const schedId = getPlaybookDetail(deploy.playbookId).schedules[0].id!;
    db.prepare(
      `UPDATE schedules SET run_count = 3, total_quote_spent = '300', last_run_at = '2026-06-01T00:00:00.000Z' WHERE id = ?`,
    ).run(schedId);

    const updated = parsePlaybookSpec({
      name: "v2-state",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 150, base: "ETH", quote: "USDC" },
      ],
    });
    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: updated, newSourcePath: null });

    expect(result.edited).toEqual([{ type: "schedule", rowId: schedId, localId: "dca", fields: ["quoteAmount"] }]);
    const after = getPlaybookDetail(deploy.playbookId).schedules[0];
    expect(after.id).toBe(schedId);
    expect(after.quote_amount).toBe("150");
    expect(after.run_count).toBe(3); // counters intact
    expect(after.total_quote_spent).toBe("300");
  });

  it("schedule recreate (frozen startAt changed) still carries run counters to the new row", () => {
    const { deploy } = deployTrailDca();
    const db = openDb();
    const schedId = getPlaybookDetail(deploy.playbookId).schedules[0].id!;
    db.prepare(
      `UPDATE schedules SET run_count = 4, total_quote_spent = '400', last_run_at = '2026-06-02T00:00:00.000Z' WHERE id = ?`,
    ).run(schedId);

    const updated = parsePlaybookSpec({
      name: "v2-state",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        // startAt is a frozen field → recreate.
        { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC", startAt: "2027-01-01T00:00:00.000Z" },
      ],
    });
    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: updated, newSourcePath: null });

    expect(result.edited).toEqual([]);
    expect(result.cancelled).toEqual([schedId]);
    expect(result.created.length).toBe(1);

    const schedules = getPlaybookDetail(deploy.playbookId).schedules;
    const active = schedules.find((s) => s.status === "active")!;
    expect(active.id).not.toBe(schedId);
    expect(active.run_count).toBe(4); // carried
    expect(active.total_quote_spent).toBe("400");
    expect(active.last_run_at).toBe("2026-06-02T00:00:00.000Z");
  });

  it("rebalance modify edits IN PLACE — same row, run_count + telemetry native", () => {
    const spec = parsePlaybookSpec({
      name: "v2-reb",
      chain: "base",
      account: "default",
      strategies: [
        { id: "folio", type: "rebalance", targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }], driftThresholdPct: 5 },
      ],
    });
    const deploy = deployPlaybook({ spec, sourcePath: null });
    const db = openDb();
    const planId = getPlaybookDetail(deploy.playbookId).rebalances[0].id!;
    db.prepare(`UPDATE rebalance_plans SET run_count = 2, last_run_at = '2026-06-03T00:00:00.000Z' WHERE id = ?`).run(planId);

    const updated = parsePlaybookSpec({
      name: "v2-reb",
      chain: "base",
      account: "default",
      strategies: [
        { id: "folio", type: "rebalance", targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }], driftThresholdPct: 8 },
      ],
    });
    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: updated, newSourcePath: null });

    // v3: driftThresholdPct is in-place editable — no recreate at all.
    expect(result.edited).toEqual([{ type: "rebalance", rowId: planId, localId: "folio", fields: ["driftThresholdPct"] }]);
    expect(result.cancelled).toEqual([]);
    expect(result.created).toEqual([]);
    const active = getPlaybookDetail(deploy.playbookId).rebalances.find((r) => r.status === "active")!;
    expect(active.id).toBe(planId); // SAME row
    expect(active.drift_threshold_pct).toBe(8);
    expect(active.run_count).toBe(2); // native, not carried
    expect(active.last_run_at).toBe("2026-06-03T00:00:00.000Z");
  });

  it("rebalance recreate (frozen quoteToken changed) still carries run counters", () => {
    const spec = parsePlaybookSpec({
      name: "v3-reb-frozen",
      chain: "base",
      account: "default",
      strategies: [
        { id: "folio", type: "rebalance", targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }], quoteToken: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec, sourcePath: null });
    const db = openDb();
    const planId = getPlaybookDetail(deploy.playbookId).rebalances[0].id!;
    db.prepare(`UPDATE rebalance_plans SET run_count = 3, last_run_at = '2026-06-04T00:00:00.000Z' WHERE id = ?`).run(planId);

    const updated = parsePlaybookSpec({
      name: "v3-reb-frozen",
      chain: "base",
      account: "default",
      strategies: [
        { id: "folio", type: "rebalance", targets: [{ token: "ETH", targetPct: 60 }, { token: "USDC", targetPct: 40 }], quoteToken: "WETH" },
      ],
    });
    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: updated, newSourcePath: null });

    expect(result.edited).toEqual([]);
    expect(result.cancelled).toEqual([planId]);
    expect(result.created.length).toBe(1);
    const active = getPlaybookDetail(deploy.playbookId).rebalances.find((r) => r.status === "active")!;
    expect(active.id).not.toBe(planId);
    expect(active.run_count).toBe(3); // carried across the recreate
    expect(active.last_run_at).toBe("2026-06-04T00:00:00.000Z");
  });

  it("preserveState:false restores v1 behavior — recreate everything, fresh state", () => {
    const { deploy } = deployTrailDca();
    const db = openDb();
    const orderId = getPlaybookDetail(deploy.playbookId).orders[0].id!;
    db.prepare(`UPDATE orders SET water_mark_usd = 3500 WHERE id = ?`).run(orderId);

    const updated = parsePlaybookSpec({
      name: "v2-state",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 8, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
      ],
    });
    const result = replacePlaybook({
      playbookId: deploy.playbookId,
      newSpec: updated,
      newSourcePath: null,
      preserveState: false,
    });

    expect(result.edited).toEqual([]);
    expect(result.cancelled).toEqual([orderId]);
    expect(result.created.length).toBe(1);
    const active = getPlaybookDetail(deploy.playbookId).orders.find((o) => o.status === "active")!;
    expect(active.id).not.toBe(orderId);
    expect(active.water_mark_usd).toBeNull(); // fresh tracking
    expect(active.trail_pct).toBe(8);
  });

  it("falls back to recreate when the edit-target row was cancelled outside the playbook flow", () => {
    const { deploy } = deployTrailDca();
    const db = openDb();
    const orderId = getPlaybookDetail(deploy.playbookId).orders[0].id!;
    // Operator cancelled the order directly; replace should restore the slot.
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).run(orderId);

    const updated = parsePlaybookSpec({
      name: "v2-state",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 8, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
      ],
    });
    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: updated, newSourcePath: null });

    expect(result.edited).toEqual([]);
    expect(result.created.length).toBe(1);
    const active = getPlaybookDetail(deploy.playbookId).orders.filter((o) => o.status === "active");
    expect(active.length).toBe(1);
    expect(active[0].trail_pct).toBe(8);
  });
});

describe("replacePlaybook v2 — paper inference", () => {
  it("replacing a --paper deployment keeps recreated + added primitives paper", () => {
    const spec = parsePlaybookSpec({
      name: "v2-paper",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec, sourcePath: null, paper: true });
    expect(getPlaybookDetail(deploy.playbookId).orders[0].paper).toBe(1);

    const updated = parsePlaybookSpec({
      name: "v2-paper",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 5000, baseAmount: 0.5, base: "ETH", quote: "USDC" },
      ],
    });
    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: updated, newSourcePath: null });

    expect(result.paper).toBe(true);
    const detail = getPlaybookDetail(deploy.playbookId);
    const tp = detail.orders.find((o) => o.trigger_type === "price_above")!;
    // Pre-v2 BUG: this was created with paper=0 — a silent flip to
    // real trading on a dry-run playbook.
    expect(tp.paper).toBe(1);
  });

  it("explicit paper:false override wins over inference", () => {
    const spec = parsePlaybookSpec({
      name: "v2-paper-override",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec, sourcePath: null, paper: true });

    const updated = parsePlaybookSpec({
      name: "v2-paper-override",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 5000, baseAmount: 0.5, base: "ETH", quote: "USDC" },
      ],
    });
    const result = replacePlaybook({
      playbookId: deploy.playbookId,
      newSpec: updated,
      newSourcePath: null,
      paper: false,
    });

    expect(result.paper).toBe(false);
    const tp = getPlaybookDetail(deploy.playbookId).orders.find((o) => o.trigger_type === "price_above")!;
    expect(tp.paper).toBe(0);
  });

  it("real (non-paper) deployment stays real on replace", () => {
    const spec = parsePlaybookSpec({
      name: "v2-real",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec, sourcePath: null });

    const updated = parsePlaybookSpec({
      name: "v2-real",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 5000, baseAmount: 0.5, base: "ETH", quote: "USDC" },
      ],
    });
    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: updated, newSourcePath: null });

    expect(result.paper).toBe(false);
    const tp = getPlaybookDetail(deploy.playbookId).orders.find((o) => o.trigger_type === "price_above")!;
    expect(tp.paper).toBe(0);
  });
});

// ── on_fill hooks through replace ────────────────────────────

describe("replacePlaybook — on_fill hooks", () => {
  const HOOK = {
    type: "createOrder",
    spec: {
      side: "sell",
      trigger: "trailing",
      trailPct: 5,
      base: "ETH",
      quote: "USDC",
      baseAmount: "{{filled.baseAmount}}",
    },
  };

  function dcaSpec(onFill?: unknown) {
    return parsePlaybookSpec({
      name: "hook-replace",
      chain: "base",
      account: "default",
      strategies: [
        { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC", ...(onFill !== undefined ? { onFill } : {}) },
      ],
    });
  }

  it("adding a hook is an in-place EDIT — run counters preserved, on_fill_json set", () => {
    const deploy = deployPlaybook({ spec: dcaSpec(), sourcePath: null });
    const db = openDb();
    const schedId = getPlaybookDetail(deploy.playbookId).schedules[0].id!;
    db.prepare(`UPDATE schedules SET run_count = 3 WHERE id = ?`).run(schedId);

    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: dcaSpec(HOOK), newSourcePath: null });

    expect(result.edited).toEqual([{ type: "schedule", rowId: schedId, localId: "dca", fields: ["onFill"] }]);
    expect(result.cancelled).toEqual([]);
    const after = getPlaybookDetail(deploy.playbookId).schedules[0];
    expect(after.id).toBe(schedId);
    expect(after.run_count).toBe(3);
    expect(JSON.parse(after.on_fill_json!)).toEqual(HOOK);
  });

  it("removing the hook edits on_fill_json back to null", () => {
    const deploy = deployPlaybook({ spec: dcaSpec(HOOK), sourcePath: null });
    const schedId = getPlaybookDetail(deploy.playbookId).schedules[0].id!;

    const result = replacePlaybook({ playbookId: deploy.playbookId, newSpec: dcaSpec(), newSourcePath: null });

    expect(result.edited).toEqual([{ type: "schedule", rowId: schedId, localId: "dca", fields: ["onFill"] }]);
    const after = getPlaybookDetail(deploy.playbookId).schedules[0];
    expect(after.on_fill_json).toBeNull();
  });

  it("a structurally-bad hook in the new spec aborts BEFORE any cancellation", () => {
    const deploy = deployPlaybook({
      spec: parsePlaybookSpec({
        name: "hook-prevalidate",
        chain: "base",
        account: "default",
        strategies: [
          // startAt makes the modified entry a RECREATE (frozen field),
          // routing the new schedule through preValidate's create path.
          { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
        ],
      }),
      sourcePath: null,
    });
    const schedId = getPlaybookDetail(deploy.playbookId).schedules[0].id!;

    const badSpec = parsePlaybookSpec({
      name: "hook-prevalidate",
      chain: "base",
      account: "default",
      strategies: [
        { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC", startAt: "2027-01-01T00:00:00.000Z" },
      ],
    });
    // Hand the parsed spec a bad hook AFTER parse (simulating a spec
    // that slipped past structural parse, e.g. via direct API use).
    (badSpec.strategies[0] as { onFill?: unknown }).onFill = { type: "bogus" };

    expect(() =>
      replacePlaybook({ playbookId: deploy.playbookId, newSpec: badSpec, newSourcePath: null }),
    ).toThrow(/onFill/);
    // Old schedule untouched — still active.
    const after = getPlaybookDetail(deploy.playbookId).schedules[0];
    expect(after.id).toBe(schedId);
    expect(after.status).toBe("active");
  });
});
