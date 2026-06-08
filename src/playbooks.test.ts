/**
 * Playbook tests.
 *
 * Three layers:
 *   1. Pure parser (parsePlaybookSpec, hashSpec) — no DB
 *   2. Atomic deploy (deployPlaybook) — real DB, real createRow path,
 *      injected failure verifies rollback
 *   3. Tear-down (destroyPlaybook) — verifies cancel cascades + leaves
 *      already-terminal primitives alone
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-playbooks-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  parsePlaybookSpec,
  hashSpec,
  deployPlaybook,
  destroyPlaybook,
  getPlaybookDetail,
} = await import("./playbooks.js");
const {
  openDb,
  closeDb,
  getPlaybookById,
  listPlaybooks,
  findActivePlaybookByName,
  playbookCountsByStatus,
  insertOrder,
  cancelOrder: dbCancelOrder,
  markOrderFilled,
} = await import("./db.js");
const { ToolError } = await import("./errors.js");

beforeAll(() => {
  openDb();
});

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

// ── parser ────────────────────────────────────────────────────

describe("parsePlaybookSpec — top-level shape", () => {
  it("rejects non-object input", () => {
    expect(() => parsePlaybookSpec("hi")).toThrow(/must be a JSON object/);
    expect(() => parsePlaybookSpec(null)).toThrow(/must be a JSON object/);
    expect(() => parsePlaybookSpec([])).toThrow(/must be a JSON object/);
  });

  it("rejects bad name", () => {
    expect(() =>
      parsePlaybookSpec({ name: "has spaces", strategies: [] }),
    ).toThrow(/name:/);
    expect(() =>
      parsePlaybookSpec({ name: 123, strategies: [] }),
    ).toThrow(/name:/);
    expect(() =>
      parsePlaybookSpec({ name: "a".repeat(65), strategies: [] }),
    ).toThrow(/name:/);
  });

  it("rejects unsupported version", () => {
    expect(() =>
      parsePlaybookSpec({ name: "x", version: 2, strategies: [{ type: "order", side: "buy", trigger: "price_below", price: 1, base: "ETH", quote: "USDC", quoteAmount: 1 }] }),
    ).toThrow(/version:/);
  });

  it("rejects missing strategies array", () => {
    expect(() =>
      parsePlaybookSpec({ name: "x" }),
    ).toThrow(/strategies:/);
  });

  it("rejects empty strategies array", () => {
    expect(() =>
      parsePlaybookSpec({ name: "x", strategies: [] }),
    ).toThrow(/at least one entry/);
  });

  it("rejects duplicate strategy ids", () => {
    const spec = {
      name: "x",
      strategies: [
        { id: "a", type: "order", side: "buy", trigger: "price_below", price: 1, base: "ETH", quote: "USDC", quoteAmount: 1 },
        { id: "a", type: "order", side: "buy", trigger: "price_below", price: 1, base: "ETH", quote: "USDC", quoteAmount: 1 },
      ],
    };
    expect(() => parsePlaybookSpec(spec)).toThrow(/duplicated/);
  });

  it("collects multiple errors into one message", () => {
    let msg = "";
    try {
      parsePlaybookSpec({
        name: "ok",
        strategies: [
          { type: "order", side: "weird" },
          { type: "schedule" },
        ],
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/strategies\[0\]/);
    expect(msg).toMatch(/strategies\[1\]/);
  });

  it("accepts a well-formed spec", () => {
    const parsed = parsePlaybookSpec({
      name: "test-pb",
      description: "hello",
      chain: "base",
      account: "main",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    expect(parsed.name).toBe("test-pb");
    expect(parsed.strategies.length).toBe(1);
    expect(parsed.version).toBe(1);
  });
});

describe("parsePlaybookSpec — per-strategy", () => {
  it("requires trailPct for trailing orders", () => {
    expect(() =>
      parsePlaybookSpec({
        name: "x",
        strategies: [{ type: "order", side: "sell", trigger: "trailing", baseAmount: 1, base: "ETH", quote: "USDC" }],
      }),
    ).toThrow(/trailPct/);
  });

  it("requires price for price_below / price_above", () => {
    expect(() =>
      parsePlaybookSpec({
        name: "x",
        strategies: [{ type: "order", side: "buy", trigger: "price_below", baseAmount: 1, base: "ETH", quote: "USDC" }],
      }),
    ).toThrow(/price:/);
  });

  it("rejects both baseAmount + quoteAmount on an order", () => {
    expect(() =>
      parsePlaybookSpec({
        name: "x",
        strategies: [{ type: "order", side: "buy", trigger: "price_below", price: 1, baseAmount: 1, quoteAmount: 100, base: "ETH", quote: "USDC" }],
      }),
    ).toThrow(/exactly one of baseAmount/);
  });

  it("requires exactly one of cron / every on a schedule", () => {
    expect(() =>
      parsePlaybookSpec({
        name: "x",
        strategies: [{ type: "schedule", side: "buy", quoteAmount: 100, base: "ETH", quote: "USDC" }],
      }),
    ).toThrow(/exactly one of cron/);
    expect(() =>
      parsePlaybookSpec({
        name: "x",
        strategies: [{ type: "schedule", side: "buy", cron: "0 0 * * *", every: "1d", quoteAmount: 100, base: "ETH", quote: "USDC" }],
      }),
    ).toThrow(/exactly one of cron/);
  });

  it("rejects empty rebalance targets", () => {
    expect(() =>
      parsePlaybookSpec({
        name: "x",
        strategies: [{ type: "rebalance", targets: [] }],
      }),
    ).toThrow(/at least one entry/);
  });

  it("rejects rebalance targets with bad pct", () => {
    expect(() =>
      parsePlaybookSpec({
        name: "x",
        strategies: [{ type: "rebalance", targets: [{ token: "ETH", targetPct: 101 }] }],
      }),
    ).toThrow(/targetPct/);
  });

  it("rejects unknown type", () => {
    expect(() =>
      parsePlaybookSpec({
        name: "x",
        strategies: [{ type: "swap" }],
      }),
    ).toThrow(/type:/);
  });

  it("rejects bad group id", () => {
    expect(() =>
      parsePlaybookSpec({
        name: "x",
        strategies: [{ type: "order", side: "sell", trigger: "price_above", price: 1, baseAmount: 1, base: "ETH", quote: "USDC", group: "has spaces" }],
      }),
    ).toThrow(/group:/);
  });
});

// ── hash stability ───────────────────────────────────────────

describe("hashSpec", () => {
  it("is stable across key insertion order", () => {
    const a = parsePlaybookSpec({
      name: "p",
      strategies: [{ type: "order", side: "sell", trigger: "price_above", price: 5000, baseAmount: 1, base: "ETH", quote: "USDC" }],
    });
    const b = parsePlaybookSpec({
      strategies: [{ base: "ETH", side: "sell", baseAmount: 1, type: "order", quote: "USDC", trigger: "price_above", price: 5000 }],
      name: "p",
    });
    expect(hashSpec(a)).toBe(hashSpec(b));
  });

  it("changes when a value changes", () => {
    const a = parsePlaybookSpec({
      name: "p",
      strategies: [{ type: "order", side: "sell", trigger: "price_above", price: 5000, baseAmount: 1, base: "ETH", quote: "USDC" }],
    });
    const b = parsePlaybookSpec({
      name: "p",
      strategies: [{ type: "order", side: "sell", trigger: "price_above", price: 4999, baseAmount: 1, base: "ETH", quote: "USDC" }],
    });
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  it("changes when strategy order changes (order is meaningful)", () => {
    const a = parsePlaybookSpec({
      name: "p",
      strategies: [
        { type: "order", side: "sell", trigger: "price_above", price: 4000, baseAmount: 1, base: "ETH", quote: "USDC" },
        { type: "order", side: "sell", trigger: "price_below", price: 3000, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const b = parsePlaybookSpec({
      name: "p",
      strategies: [
        { type: "order", side: "sell", trigger: "price_below", price: 3000, baseAmount: 1, base: "ETH", quote: "USDC" },
        { type: "order", side: "sell", trigger: "price_above", price: 4000, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });
});

// ── deploy (real DB) ─────────────────────────────────────────

function bracketDcaSpec() {
  return parsePlaybookSpec({
    name: "bracket-dca",
    description: "trailing-stop + sl + tp bracket + weekly DCA",
    chain: "base",
    account: "default",
    strategies: [
      { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
      { id: "sl", type: "order", side: "sell", trigger: "price_below", price: 2700, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket" },
      { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 4000, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket" },
      { id: "dca", type: "schedule", side: "buy", every: "7d", quoteAmount: 100, base: "ETH", quote: "USDC" },
    ],
  });
}

describe("deployPlaybook — happy path", () => {
  it("creates all primitives + marks deployed", () => {
    const spec = bracketDcaSpec();
    const result = deployPlaybook({ spec, sourcePath: "/tmp/x.json" });
    expect(result.alreadyDeployed).toBe(false);
    expect(result.items.length).toBe(4);
    expect(result.items.map((i) => i.type).sort()).toEqual(["order", "order", "order", "schedule"]);

    const row = getPlaybookById(result.playbookId);
    expect(row?.status).toBe("deployed");
    expect(row?.source_path).toBe("/tmp/x.json");

    const detail = getPlaybookDetail(result.playbookId);
    expect(detail.orders.length).toBe(3);
    expect(detail.schedules.length).toBe(1);
    expect(detail.rebalances.length).toBe(0);
  });

  it("stamps strategy = playbook:<id> on every owned primitive", () => {
    const spec = bracketDcaSpec();
    const result = deployPlaybook({ spec, sourcePath: null });
    const expectedTag = `playbook:${result.playbookId}`;
    const detail = getPlaybookDetail(result.playbookId);
    for (const o of detail.orders) expect(o.strategy).toBe(expectedTag);
    for (const s of detail.schedules) expect(s.strategy).toBe(expectedTag);
  });

  it("namespaces OCO group names per playbook", () => {
    const result = deployPlaybook({ spec: bracketDcaSpec(), sourcePath: null });
    const detail = getPlaybookDetail(result.playbookId);
    const groups = detail.orders.map((o) => o.group_id).filter(Boolean);
    expect(groups.length).toBe(2);
    expect(groups.every((g) => g!.startsWith(`pb${result.playbookId}-`))).toBe(true);
    expect(new Set(groups).size).toBe(1); // both peers share the SAME namespaced group
  });
});

describe("deployPlaybook — idempotency", () => {
  it("redeploy with same hash is a no-op", () => {
    const spec = bracketDcaSpec();
    const first = deployPlaybook({ spec, sourcePath: null });
    expect(first.alreadyDeployed).toBe(false);
    const second = deployPlaybook({ spec, sourcePath: null });
    expect(second.alreadyDeployed).toBe(true);
    expect(second.playbookId).toBe(first.playbookId);
    expect(playbookCountsByStatus().deployed).toBe(1);
  });

  it("redeploy with different hash + same name errors", () => {
    const a = bracketDcaSpec();
    deployPlaybook({ spec: a, sourcePath: null });
    const b = parsePlaybookSpec({
      ...JSON.parse(JSON.stringify(a)),
      strategies: [
        { type: "order", side: "sell", trigger: "trailing", trailPct: 7, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    let err: unknown;
    try {
      deployPlaybook({ spec: b, sourcePath: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toMatch(/already deployed/);
    // Recovery hint lives in the error message text; structured nextActions
    // are reserved for MCP-exposed tools (playbooks are CLI-only in v1).
    expect((err as Error).message).toMatch(/tradekit playbook destroy/);
  });

  it("redeploying after destroy works cleanly", () => {
    const spec = bracketDcaSpec();
    const first = deployPlaybook({ spec, sourcePath: null });
    destroyPlaybook(first.playbookId);
    const second = deployPlaybook({ spec, sourcePath: null });
    expect(second.alreadyDeployed).toBe(false);
    expect(second.playbookId).not.toBe(first.playbookId);
  });
});

describe("deployPlaybook — atomicity / rollback", () => {
  it("rolls back if mid-deploy create fails", () => {
    // Build a spec where the THIRD strategy hits createRow validation
    // failure: a price_below order with `expiresAt` in the past.
    // The parser doesn't validate timestamps deeply — it accepts an
    // ISO-string; the createOrderRow validator rejects past expiries.
    const spec = parsePlaybookSpec({
      name: "atomic-test",
      chain: "base",
      account: "default",
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing", trailPct: 5, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 5000, baseAmount: 1, base: "ETH", quote: "USDC" },
        // Past expiry — createOrderRow will throw INVALID_PARAMS.
        { id: "bad", type: "order", side: "sell", trigger: "price_above", price: 6000, baseAmount: 1, base: "ETH", quote: "USDC", expiresAt: "2000-01-01T00:00:00Z" },
      ],
    });
    let err: unknown;
    try {
      deployPlaybook({ spec, sourcePath: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toMatch(/rolled back/);
    // No playbook row should survive — the deploy helper deletes it
    // outright on rollback so the operator can redeploy without
    // tripping the "already deployed" idempotency check.
    expect(findActivePlaybookByName("atomic-test")).toBeNull();
    expect(listPlaybooks({ status: "deployed" }).length).toBe(0);
    expect(listPlaybooks({ status: "deploying" }).length).toBe(0);
    expect(listPlaybooks({ status: "failed" }).length).toBe(0);
    // Primitive rows are CANCELLED, not deleted — cancel() preserves
    // the row as a forensic breadcrumb (status='cancelled', last_error
    // populated). The invariant is that nothing is left ACTIVE.
    const db = openDb();
    const activeCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE strategy LIKE 'playbook:%' AND status = 'active'`).get() as { n: number }
    ).n;
    expect(activeCount).toBe(0);
  });

  it("surfaces the underlying error code (INVALID_PARAMS) on rollback", () => {
    const spec = parsePlaybookSpec({
      name: "code-check",
      chain: "base",
      account: "default",
      strategies: [
        { id: "ok", type: "order", side: "sell", trigger: "price_above", price: 5000, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "bad", type: "order", side: "sell", trigger: "price_above", price: 6000, baseAmount: 1, base: "ETH", quote: "USDC", expiresAt: "2000-01-01T00:00:00Z" },
      ],
    });
    // Cast through `unknown` — dynamic import gives us the class as a value,
    // not as a type; we want the structured fields without re-importing the
    // type statically (which would defeat the dynamic-import test isolation).
    let err: { code?: string; details?: Record<string, unknown> } | undefined;
    try {
      deployPlaybook({ spec, sourcePath: null });
    } catch (e) {
      err = e as { code?: string; details?: Record<string, unknown> };
    }
    expect(err?.code).toBe("INVALID_PARAMS");
    expect(err?.details?.rolledBack).toBe(1);
  });
});

// ── destroy ──────────────────────────────────────────────────

describe("destroyPlaybook", () => {
  it("cancels every active primitive", () => {
    const spec = bracketDcaSpec();
    const deploy = deployPlaybook({ spec, sourcePath: null });
    const result = destroyPlaybook(deploy.playbookId);
    expect(result.cancelled.length).toBe(4);
    expect(result.alreadyTerminal.length).toBe(0);
    expect(result.errors.length).toBe(0);
    const row = getPlaybookById(deploy.playbookId);
    expect(row?.status).toBe("destroyed");
    expect(row?.destroyed_at).not.toBeNull();
    const detail = getPlaybookDetail(deploy.playbookId);
    for (const o of detail.orders) expect(o.status).toBe("cancelled");
    for (const s of detail.schedules) expect(s.status).toBe("cancelled");
  });

  it("leaves already-terminal primitives alone", () => {
    const spec = parsePlaybookSpec({
      name: "mixed",
      chain: "base",
      account: "default",
      strategies: [
        { id: "a", type: "order", side: "sell", trigger: "price_above", price: 5000, baseAmount: 1, base: "ETH", quote: "USDC" },
        { id: "b", type: "order", side: "sell", trigger: "price_above", price: 6000, baseAmount: 1, base: "ETH", quote: "USDC" },
      ],
    });
    const deploy = deployPlaybook({ spec, sourcePath: null });
    // Manually drive one order into a terminal state out-of-band.
    const detail = getPlaybookDetail(deploy.playbookId);
    const firstOrder = detail.orders[0];
    markOrderFilled(firstOrder.id!, {
      tx_hash: "0x" + "ab".repeat(32),
      fill_price: 5000,
      base_amount: "1",
      quote_amount: "5000",
    });

    const result = destroyPlaybook(deploy.playbookId);
    expect(result.cancelled.length).toBe(1);
    expect(result.alreadyTerminal.length).toBe(1);
    expect(result.alreadyTerminal[0].status).toBe("filled");
  });

  it("is idempotent — destroying twice returns empty cancelled list", () => {
    const spec = bracketDcaSpec();
    const deploy = deployPlaybook({ spec, sourcePath: null });
    destroyPlaybook(deploy.playbookId);
    const result = destroyPlaybook(deploy.playbookId);
    expect(result.cancelled.length).toBe(0);
    expect(result.alreadyTerminal.length).toBe(0);
  });

  it("throws on unknown playbook id", () => {
    expect(() => destroyPlaybook(99999)).toThrow(/No playbook/);
  });
});

// ── primitive isolation ──────────────────────────────────────

describe("playbook primitive isolation", () => {
  it("does not cancel non-playbook primitives", () => {
    const spec = bracketDcaSpec();
    const deploy = deployPlaybook({ spec, sourcePath: null });

    // Insert a standalone order with a different strategy tag.
    const standaloneId = insertOrder({
      chain: "base",
      account: "default",
      side: "sell",
      trigger_type: "price_above",
      target_price_usd: 9999,
      trail_pct: null,
      base_token: "0x4200000000000000000000000000000000000006",
      quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      base_symbol: "WETH",
      quote_symbol: "USDC",
      base_amount: "1",
      quote_amount: null,
      slippage_bps: null,
      auto_slippage: false,
      expires_at: null,
      strategy: "manual-tag",
      note: null,
      group_id: null,
    });
    expect(standaloneId).toBeGreaterThan(0);

    destroyPlaybook(deploy.playbookId);

    // Standalone order should still be active.
    const db = openDb();
    const row = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(standaloneId) as { status: string };
    expect(row.status).toBe("active");
  });

  it("two playbooks with the same local group don't cross-cancel via OCO", () => {
    // The crucial test of group namespacing. Both playbooks declare
    // their OCO group as "bracket"; we expect them to become
    // pb<A>-bracket vs pb<B>-bracket so a fire in playbook A doesn't
    // cascade-cancel orders in playbook B.
    const a = deployPlaybook({
      spec: parsePlaybookSpec({
        name: "pb-a",
        chain: "base",
        account: "default",
        strategies: [
          { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 4000, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket" },
          { id: "sl", type: "order", side: "sell", trigger: "price_below", price: 2700, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket" },
        ],
      }),
      sourcePath: null,
    });
    const b = deployPlaybook({
      spec: parsePlaybookSpec({
        name: "pb-b",
        chain: "base",
        account: "default",
        strategies: [
          { id: "tp", type: "order", side: "sell", trigger: "price_above", price: 5000, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket" },
          { id: "sl", type: "order", side: "sell", trigger: "price_below", price: 2500, baseAmount: 1, base: "ETH", quote: "USDC", group: "bracket" },
        ],
      }),
      sourcePath: null,
    });

    const detailA = getPlaybookDetail(a.playbookId);
    const detailB = getPlaybookDetail(b.playbookId);
    const groupA = detailA.orders[0].group_id;
    const groupB = detailB.orders[0].group_id;
    expect(groupA).toMatch(new RegExp(`^pb${a.playbookId}-bracket$`));
    expect(groupB).toMatch(new RegExp(`^pb${b.playbookId}-bracket$`));
    expect(groupA).not.toBe(groupB);

    // Cancel one peer in playbook A — playbook B's orders should be untouched.
    dbCancelOrder(detailA.orders[0].id!);
    const detailAfter = getPlaybookDetail(b.playbookId);
    for (const o of detailAfter.orders) expect(o.status).toBe("active");
  });
});

// ── full lifecycle smoke ─────────────────────────────────────

describe("full lifecycle", () => {
  it("deploy → list → show → destroy → list", () => {
    const spec = bracketDcaSpec();
    const deploy = deployPlaybook({ spec, sourcePath: "./eth.json" });

    const deployed = listPlaybooks({ status: "deployed" });
    expect(deployed.length).toBe(1);
    expect(deployed[0].name).toBe("bracket-dca");

    const detail = getPlaybookDetail(deploy.playbookId);
    expect(detail.spec.description).toBe("trailing-stop + sl + tp bracket + weekly DCA");
    expect(detail.orders.length + detail.schedules.length).toBe(4);

    destroyPlaybook(deploy.playbookId);

    expect(listPlaybooks({ status: "deployed" }).length).toBe(0);
    expect(listPlaybooks({ status: "destroyed" }).length).toBe(1);
    expect(playbookCountsByStatus().destroyed).toBe(1);
  });
});
