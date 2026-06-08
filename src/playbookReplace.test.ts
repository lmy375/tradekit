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

  it("modified trailing order sets willResetTrailingHwm=true", () => {
    const oldSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const newSpec = mkSpec([
      { type: "order", side: "sell", trigger: "trailing", trailPct: 7, baseAmount: 1, base: "ETH", quote: "USDC" },
    ]);
    const d = computePlaybookDiff({ oldSpec, newSpec, playbookId: 1 });
    expect(d.willResetTrailingHwm).toBe(true);
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

    // 2 new primitives created (modified-new + added).
    expect(result.created.length).toBe(2);
    // 1 cancelled (modified-old).
    expect(result.cancelled.length).toBe(1);
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
    // Two orders exist (old cancelled + new active). Only one is active.
    expect(detailAfter.orders.length).toBe(2);
    const activeOrders = detailAfter.orders.filter((o) => o.status === "active");
    expect(activeOrders.length).toBe(1);
    expect(activeOrders[0].trail_pct).toBe(15);
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
