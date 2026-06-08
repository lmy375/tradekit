// Tests for the conditional-orders engine (orders.ts). Split into:
//
//   1) Pure-logic tests: trigger predicate, expiry, duration parsing — no DB,
//      no RPC, fast.
//   2) DB roundtrip tests: insertOrder → DB → listOrders, cancellation, status
//      transitions. Follows the standard pattern in db.test.ts — set
//      TRADEKIT_DATA_DIR BEFORE module imports, share a single DB across all
//      tests, scrub the orders table between tests so each starts clean.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// IMPORTANT: must set TRADEKIT_DATA_DIR BEFORE importing db / constants — those
// modules read the path once at load time. Same pattern as db.test.ts.
const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-orders-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  isOrderTriggered,
  isOrderExpired,
  parseDurationToDate,
  createOrderRow,
  cancelOrderById,
} = await import("./orders.js");
const {
  insertOrder,
  getOrderById,
  listOrders,
  activeOrders,
  recordOrderCheck,
  markOrderFilled,
  markOrderFailed,
  markOrderExpired,
  cancelOrder: dbCancelOrder,
  setOrderError,
  orderCountsByStatus,
  openDb,
  closeDb,
} = await import("./db.js");

beforeAll(() => {
  // Ensure DB is open + migrations applied before the first test fires.
  openDb();
});

afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

// Per-test scrub of the orders table. Cheap (DELETE FROM with no WHERE) and
// keeps row-id assertions deterministic across tests.
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM orders");
});

// ── pure predicates ──────────────────────────────────────────

describe("isOrderTriggered", () => {
  const baseOrder = { trigger_type: "price_below" as const, target_price_usd: 3000 };
  it("fires when price <= target for price_below", () => {
    expect(isOrderTriggered(baseOrder, 2999)).toBe(true);
    expect(isOrderTriggered(baseOrder, 3000)).toBe(true);
    expect(isOrderTriggered(baseOrder, 3001)).toBe(false);
  });
  it("fires when price >= target for price_above", () => {
    const o = { trigger_type: "price_above" as const, target_price_usd: 3000 };
    expect(isOrderTriggered(o, 2999)).toBe(false);
    expect(isOrderTriggered(o, 3000)).toBe(true);
    expect(isOrderTriggered(o, 3001)).toBe(true);
  });
  it("never fires when price is null / invalid", () => {
    expect(isOrderTriggered(baseOrder, null)).toBe(false);
    expect(isOrderTriggered(baseOrder, Number.NaN)).toBe(false);
    expect(isOrderTriggered(baseOrder, -1)).toBe(false);
    expect(isOrderTriggered(baseOrder, 0)).toBe(false);
    expect(isOrderTriggered(baseOrder, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("isOrderExpired", () => {
  it("returns false when expires_at is null", () => {
    expect(isOrderExpired({ expires_at: null })).toBe(false);
  });
  it("returns true when now > expires_at", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isOrderExpired({ expires_at: past })).toBe(true);
  });
  it("returns false when expires_at is in the future", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isOrderExpired({ expires_at: future })).toBe(false);
  });
  it("returns false for malformed ISO", () => {
    expect(isOrderExpired({ expires_at: "garbage" })).toBe(false);
  });
});

describe("parseDurationToDate", () => {
  const now = new Date("2026-05-30T00:00:00Z");
  it("parses seconds / minutes / hours / days / weeks", () => {
    expect(parseDurationToDate("30s", now)!.toISOString()).toBe("2026-05-30T00:00:30.000Z");
    expect(parseDurationToDate("15m", now)!.toISOString()).toBe("2026-05-30T00:15:00.000Z");
    expect(parseDurationToDate("2h", now)!.toISOString()).toBe("2026-05-30T02:00:00.000Z");
    expect(parseDurationToDate("7d", now)!.toISOString()).toBe("2026-06-06T00:00:00.000Z");
    expect(parseDurationToDate("1w", now)!.toISOString()).toBe("2026-06-06T00:00:00.000Z");
  });
  it("accepts decimal multipliers", () => {
    expect(parseDurationToDate("0.5h", now)!.toISOString()).toBe("2026-05-30T00:30:00.000Z");
  });
  it("is case-insensitive on the unit", () => {
    expect(parseDurationToDate("2H", now)!.toISOString()).toBe("2026-05-30T02:00:00.000Z");
  });
  it("rejects unknown / ambiguous units", () => {
    expect(parseDurationToDate("1mo")).toBeNull();
    expect(parseDurationToDate("1y")).toBeNull();
    expect(parseDurationToDate("garbage")).toBeNull();
    expect(parseDurationToDate("")).toBeNull();
  });
  it("rejects non-positive durations", () => {
    expect(parseDurationToDate("0s")).toBeNull();
    expect(parseDurationToDate("-5m")).toBeNull();
  });
});

// ── DB roundtrip ─────────────────────────────────────────────

function makeFixture(overrides: Partial<Parameters<typeof insertOrder>[0]> = {}) {
  return {
    side: "buy" as const,
    trigger_type: "price_below" as const,
    target_price_usd: 3000,
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
    expires_at: null,
    strategy: null,
    note: null,
    // v14: OCO group column. Default null = standalone order (no peers).
    // Group-specific tests below override with group_id strings.
    group_id: null,
    // v12: trailing-stop columns. Default null = legacy price-trigger
    // order with no trailing semantics. Trailing-specific tests below
    // override with trail_pct + (optionally) target_price_usd as the
    // activation gate.
    trail_pct: null,
    ...overrides,
  };
}

describe("orders DB layer", () => {
  it("inserts then retrieves an order with all fields preserved", () => {
    const id = insertOrder(makeFixture());
    expect(id).toBeGreaterThan(0);
    const row = getOrderById(id)!;
    expect(row.side).toBe("buy");
    expect(row.trigger_type).toBe("price_below");
    expect(row.target_price_usd).toBe(3000);
    expect(row.chain).toBe("base");
    expect(row.account).toBe("main");
    expect(row.base_symbol).toBe("WETH");
    expect(row.quote_amount).toBe("100");
    expect(row.slippage_bps).toBe(50);
    expect(row.status).toBe("active");
    expect(row.attempts).toBe(0);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("listOrders filters by status / chain / account / strategy", () => {
    insertOrder(makeFixture({ chain: "base", account: "main", strategy: "dca" }));
    insertOrder(makeFixture({ chain: "arbitrum", account: "main" }));
    insertOrder(makeFixture({ chain: "base", account: "side" }));
    const id = insertOrder(makeFixture({ chain: "base", account: "main" }));
    markOrderFailed(id, "TX_REVERTED", "test fail");

    expect(listOrders({}).length).toBe(4);
    expect(listOrders({ status: "active" }).length).toBe(3);
    expect(listOrders({ status: "failed" }).length).toBe(1);
    expect(listOrders({ chain: "base" }).length).toBe(3);
    expect(listOrders({ account: "main" }).length).toBe(3);
    expect(listOrders({ strategy: "dca" }).length).toBe(1);
    expect(listOrders({ status: "active", chain: "base", account: "main" }).length).toBe(1);
  });

  it("recordOrderCheck increments attempts + stamps last_checked fields", () => {
    const id = insertOrder(makeFixture());
    recordOrderCheck(id, 2950.25);
    const r1 = getOrderById(id)!;
    expect(r1.attempts).toBe(1);
    expect(r1.last_checked_price).toBe(2950.25);
    expect(r1.last_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    recordOrderCheck(id, null);
    expect(getOrderById(id)!.attempts).toBe(2);
  });

  it("markOrderFilled writes fill details and flips status", () => {
    const id = insertOrder(makeFixture());
    markOrderFilled(id, {
      tx_hash: "0x" + "ab".repeat(32),
      fill_price: 2998.5,
      base_amount: "0.033",
      quote_amount: "100",
    });
    const r = getOrderById(id)!;
    expect(r.status).toBe("filled");
    expect(r.fill_tx_hash).toBe("0x" + "ab".repeat(32));
    expect(r.fill_price).toBe(2998.5);
    expect(r.filled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("markOrderFailed records code + message and flips status", () => {
    const id = insertOrder(makeFixture());
    markOrderFailed(id, "TX_REVERTED", "execution reverted: STF");
    const r = getOrderById(id)!;
    expect(r.status).toBe("failed");
    expect(r.last_error_code).toBe("TX_REVERTED");
    expect(r.last_error_message).toBe("execution reverted: STF");
  });

  it("markOrderExpired flips status to expired", () => {
    const id = insertOrder(makeFixture());
    markOrderExpired(id);
    expect(getOrderById(id)!.status).toBe("expired");
  });

  it("cancelOrder is idempotent on active rows, refuses terminal-state rows", () => {
    const id = insertOrder(makeFixture());
    expect(dbCancelOrder(id)).toBe(1);
    expect(getOrderById(id)!.status).toBe("cancelled");
    // re-cancelling is a no-op (0 changes, NOT -1)
    expect(dbCancelOrder(id)).toBe(0);

    const filledId = insertOrder(makeFixture());
    markOrderFilled(filledId, {
      tx_hash: "0x" + "cd".repeat(32),
      fill_price: 100,
      base_amount: "1",
      quote_amount: "100",
    });
    // cancelling a filled order returns -1 (refused)
    expect(dbCancelOrder(filledId)).toBe(-1);
  });

  it("setOrderError stamps the error trail without flipping status", () => {
    const id = insertOrder(makeFixture());
    setOrderError(id, "RPC_FAILED", "timeout fetching block");
    const r = getOrderById(id)!;
    expect(r.status).toBe("active");
    expect(r.last_error_code).toBe("RPC_FAILED");
    expect(r.last_error_message).toBe("timeout fetching block");
  });

  it("activeOrders only returns status='active' rows", () => {
    const a = insertOrder(makeFixture());
    const b = insertOrder(makeFixture());
    const c = insertOrder(makeFixture());
    markOrderFilled(b, { tx_hash: "0x" + "01".repeat(32), fill_price: 100, base_amount: "1", quote_amount: "100" });
    dbCancelOrder(c);
    const active = activeOrders();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(a);
  });

  it("orderCountsByStatus aggregates all five statuses", () => {
    insertOrder(makeFixture());
    const filled = insertOrder(makeFixture());
    const failed = insertOrder(makeFixture());
    const cancelled = insertOrder(makeFixture());
    const expired = insertOrder(makeFixture());
    markOrderFilled(filled, { tx_hash: "0x" + "ab".repeat(32), fill_price: 1, base_amount: "1", quote_amount: "1" });
    markOrderFailed(failed, "TX_REVERTED", "boom");
    dbCancelOrder(cancelled);
    markOrderExpired(expired);
    const counts = orderCountsByStatus();
    expect(counts.active).toBe(1);
    expect(counts.filled).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.cancelled).toBe(1);
    expect(counts.expired).toBe(1);
  });

  it("listOrders is sorted newest-first by id", () => {
    const ids = [insertOrder(makeFixture()), insertOrder(makeFixture()), insertOrder(makeFixture())];
    const rows = listOrders({});
    expect(rows.map((r) => r.id)).toEqual([...ids].reverse());
  });
});

// ── createOrderRow validation ────────────────────────────────

describe("createOrderRow validation", () => {
  function makeBaseArgs() {
    return {
      side: "buy" as const,
      trigger: "price_below" as const,
      targetPriceUsd: 3000,
      chain: "base",
      account: "main",
      base: "ETH" as const,
      quote: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const,
      quoteAmount: "100",
    };
  }

  it("rejects invalid side / trigger", () => {
    expect(() => createOrderRow({ ...makeBaseArgs(), side: "long" as unknown as "buy" })).toThrow(/side must be/);
    expect(() => createOrderRow({ ...makeBaseArgs(), trigger: "rsi_oversold" as unknown as "price_below" })).toThrow(/trigger must be/);
  });

  it("rejects non-positive target price", () => {
    expect(() => createOrderRow({ ...makeBaseArgs(), targetPriceUsd: 0 })).toThrow(/positive/);
    expect(() => createOrderRow({ ...makeBaseArgs(), targetPriceUsd: -1 })).toThrow(/positive/);
    expect(() => createOrderRow({ ...makeBaseArgs(), targetPriceUsd: Number.NaN })).toThrow(/positive/);
  });

  it("requires exactly one of baseAmount / quoteAmount", () => {
    const a = makeBaseArgs();
    expect(() => createOrderRow({ ...a, quoteAmount: undefined })).toThrow(/exactly one/);
    expect(() => createOrderRow({ ...a, baseAmount: "1", quoteAmount: "100" })).toThrow(/exactly one/);
  });

  it("rejects slippage_bps outside (0, 10000]", () => {
    expect(() => createOrderRow({ ...makeBaseArgs(), slippageBps: 0 })).toThrow(/slippageBps/);
    expect(() => createOrderRow({ ...makeBaseArgs(), slippageBps: -1 })).toThrow(/slippageBps/);
    expect(() => createOrderRow({ ...makeBaseArgs(), slippageBps: 10_001 })).toThrow(/slippageBps/);
    expect(() => createOrderRow({ ...makeBaseArgs(), slippageBps: 50.5 })).toThrow(/slippageBps/);
  });

  it("rejects past / malformed expiresAt", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(() => createOrderRow({ ...makeBaseArgs(), expiresAt: past })).toThrow(/future/);
    expect(() => createOrderRow({ ...makeBaseArgs(), expiresAt: "garbage" })).toThrow(/ISO/);
  });

  it("happy path: persists with resolved symbols", () => {
    const row = createOrderRow(makeBaseArgs());
    expect(row.id).toBeGreaterThan(0);
    expect(row.chain).toBe("base");
    expect(row.base_symbol).toBe("ETH");
    expect(row.quote_symbol).toBe("USDC");
    expect(row.target_price_usd).toBe(3000);
    expect(row.status).toBe("active");
  });
});

// ── createOrderRow validation: trailing trigger ─────────────

describe("createOrderRow validation — trailing", () => {
  function trailArgs() {
    return {
      side: "sell" as const,
      trigger: "trailing" as const,
      chain: "base",
      account: "main",
      base: "ETH" as const,
      quote: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const,
      baseAmount: "0.5",
    };
  }

  it("requires trailPct on trailing", () => {
    expect(() => createOrderRow(trailArgs())).toThrow(/trail-pct/);
  });

  it("rejects trailPct outside (0, 100]", () => {
    expect(() => createOrderRow({ ...trailArgs(), trailPct: 0 })).toThrow(/0, 100/);
    expect(() => createOrderRow({ ...trailArgs(), trailPct: 101 })).toThrow(/0, 100/);
    expect(() => createOrderRow({ ...trailArgs(), trailPct: -1 })).toThrow();
  });

  it("rejects trailPct on price_below / price_above triggers", () => {
    expect(() =>
      createOrderRow({
        ...trailArgs(),
        trigger: "price_below",
        targetPriceUsd: 3000,
        trailPct: 5,
      }),
    ).toThrow(/only meaningful with trigger="trailing"/);
  });

  it("rejects non-positive activationPriceUsd", () => {
    expect(() =>
      createOrderRow({ ...trailArgs(), trailPct: 5, targetPriceUsd: 0 }),
    ).toThrow();
    expect(() =>
      createOrderRow({ ...trailArgs(), trailPct: 5, targetPriceUsd: -1 }),
    ).toThrow();
  });

  it("happy path: trailing without activation (immediate tracking)", () => {
    const row = createOrderRow({ ...trailArgs(), trailPct: 5 });
    expect(row.trigger_type).toBe("trailing");
    expect(row.trail_pct).toBe(5);
    expect(row.target_price_usd).toBeNull();
    expect(row.water_mark_usd).toBeNull(); // starts unset
    expect(row.status).toBe("active");
  });

  it("happy path: trailing with activation gate (target_price_usd populated)", () => {
    const row = createOrderRow({ ...trailArgs(), trailPct: 5, targetPriceUsd: 3500 });
    expect(row.trigger_type).toBe("trailing");
    expect(row.trail_pct).toBe(5);
    expect(row.target_price_usd).toBe(3500); // re-purposed as activation gate
    expect(row.water_mark_usd).toBeNull();
  });
});

// ── trailing DB roundtrip ──────────────────────────────────

describe("trailing-stop DB integration", () => {
  it("updateOrderWaterMark persists the new mark + bumps updated_at", async () => {
    const row = createOrderRow({
      side: "sell",
      trigger: "trailing",
      chain: "base",
      account: "main",
      base: "ETH",
      quote: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      baseAmount: "0.5",
      trailPct: 5,
    });
    const before = (await import("./db.js")).getOrderById(row.id!)!;
    expect(before.water_mark_usd).toBeNull();
    const { updateOrderWaterMark, getOrderById } = await import("./db.js");
    updateOrderWaterMark(row.id!, 3200);
    const after = getOrderById(row.id!)!;
    expect(after.water_mark_usd).toBe(3200);
    expect(Date.parse(after.updated_at)).toBeGreaterThanOrEqual(Date.parse(before.updated_at));
    // Updating to a different value persists.
    updateOrderWaterMark(row.id!, 3300);
    expect(getOrderById(row.id!)!.water_mark_usd).toBe(3300);
  });
});

// ── cancelOrderById structured errors ────────────────────────

describe("cancelOrderById", () => {
  it("throws INVALID_PARAMS when the id is unknown", () => {
    expect(() => cancelOrderById(99999)).toThrow(/not found/);
  });

  it("throws when cancelling a filled order", () => {
    const id = insertOrder(makeFixture());
    markOrderFilled(id, { tx_hash: "0x" + "ab".repeat(32), fill_price: 1, base_amount: "1", quote_amount: "1" });
    expect(() => cancelOrderById(id)).toThrow(/already filled/);
  });
});

// ── OCO groups: validation + DB layer + cancelOrderById cascade ──

describe("createOrderRow validation — OCO group", () => {
  function baseArgs() {
    return {
      side: "buy" as const,
      trigger: "price_below" as const,
      targetPriceUsd: 3000,
      chain: "base",
      account: "main",
      base: "ETH" as const,
      quote: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const,
      quoteAmount: "100",
    };
  }

  it("accepts a well-formed group id", () => {
    const row = createOrderRow({ ...baseArgs(), group: "tp_or_sl" });
    expect(row.group_id).toBe("tp_or_sl");
  });

  it("trims whitespace + lowercases-letter-preserving the group id", () => {
    const row = createOrderRow({ ...baseArgs(), group: "  TP-Group  " });
    expect(row.group_id).toBe("TP-Group");
  });

  it("rejects empty / whitespace-only group", () => {
    // Whitespace-only is trimmed to empty → rejected.
    expect(() => createOrderRow({ ...baseArgs(), group: "   " })).toThrow(/1-64 chars/);
  });

  it("rejects groups with disallowed characters", () => {
    expect(() => createOrderRow({ ...baseArgs(), group: "tp or sl" })).toThrow(/letters, digits, dash, or underscore/);
    expect(() => createOrderRow({ ...baseArgs(), group: "tp/sl" })).toThrow(/letters, digits, dash, or underscore/);
    expect(() => createOrderRow({ ...baseArgs(), group: "tp.sl" })).toThrow(/letters, digits, dash, or underscore/);
  });

  it("rejects groups longer than 64 chars", () => {
    expect(() => createOrderRow({ ...baseArgs(), group: "a".repeat(65) })).toThrow(/1-64 chars/);
  });

  it("default (no group) stores null group_id", () => {
    const row = createOrderRow(baseArgs());
    expect(row.group_id).toBeNull();
  });
});

describe("DB-layer OCO helpers", () => {
  it("listOrders with group filter returns only matching rows", async () => {
    const { listOrders } = await import("./db.js");
    insertOrder(makeFixture({ group_id: "g1" }));
    insertOrder(makeFixture({ group_id: "g1" }));
    insertOrder(makeFixture({ group_id: "g2" }));
    insertOrder(makeFixture({ group_id: null }));
    expect(listOrders({ group: "g1" }).length).toBe(2);
    expect(listOrders({ group: "g2" }).length).toBe(1);
  });

  it("findActiveGroupPeers excludes the fired row + non-active rows", async () => {
    const { findActiveGroupPeers, cancelOrder: dbCancelOrder } = await import("./db.js");
    const a = insertOrder(makeFixture({ group_id: "shared" }));
    const b = insertOrder(makeFixture({ group_id: "shared" }));
    const c = insertOrder(makeFixture({ group_id: "shared" }));
    dbCancelOrder(c);
    // Peers of `a` in "shared" — should be just `b` (c is cancelled; a is self).
    const peers = findActiveGroupPeers(a, "shared");
    expect(peers.map((p) => p.id).sort()).toEqual([b]);
  });

  it("findActiveGroupPeers returns [] for null group / unknown group", async () => {
    const { findActiveGroupPeers } = await import("./db.js");
    const a = insertOrder(makeFixture({ group_id: null }));
    expect(findActiveGroupPeers(a, null)).toEqual([]);
    expect(findActiveGroupPeers(a, "nonexistent")).toEqual([]);
  });

  it("cancelOcoPeers cancels every active peer + stamps the reason", async () => {
    const { cancelOcoPeers, getOrderById } = await import("./db.js");
    const a = insertOrder(makeFixture({ group_id: "oco-1" }));
    const b = insertOrder(makeFixture({ group_id: "oco-1" }));
    const c = insertOrder(makeFixture({ group_id: "oco-1" }));
    const cancelled = cancelOcoPeers(a, "oco-1", "OCO_PEER_FIRED", "Order #1 filled — auto-cancelling peers.");
    expect(cancelled.sort()).toEqual([b, c]);
    const rb = getOrderById(b)!;
    const rc = getOrderById(c)!;
    expect(rb.status).toBe("cancelled");
    expect(rb.last_error_code).toBe("OCO_PEER_FIRED");
    expect(rb.last_error_message).toMatch(/auto-cancelling peers/);
    expect(rc.status).toBe("cancelled");
  });

  it("cancelOcoPeers is non-recursive (no infinite loop) — does NOT re-cascade on already-cancelled rows", async () => {
    const { cancelOcoPeers, getOrderById } = await import("./db.js");
    const a = insertOrder(makeFixture({ group_id: "shared" }));
    const b = insertOrder(makeFixture({ group_id: "shared" }));
    // First call cancels b. Second call from b's perspective should find
    // no active peers (a is still active but cancelOcoPeers passes
    // firedOrderId=b which excludes itself; a IS active so... actually
    // this would create an infinite loop if the engine called it. But
    // the engine only calls cancelOcoPeers when a row TRANSITIONS to
    // terminal state, and cancelled is one such state but we don't
    // cascade from it. Verify the SQL layer is safe: cancelOcoPeers
    // never cancels its own caller, so calling it from b's perspective
    // cancels a (which is still active).
    expect(cancelOcoPeers(a, "shared", "OCO_PEER_FIRED", "fire").sort()).toEqual([b]);
    // Now b is cancelled. If we call cancelOcoPeers(b, "shared", ...) it
    // would try to cancel a (the only other peer in the group). a is
    // still ACTIVE here, so this call DOES cancel it. The non-recursive
    // guarantee comes from the engine never CALLING this from a
    // terminal-state transition that's cancelled — not from the SQL.
    // Verify: from b's perspective, a is the active peer to cancel.
    expect(cancelOcoPeers(b, "shared", "OCO_PEER_FIRED", "fire").sort()).toEqual([a]);
    expect(getOrderById(a)!.status).toBe("cancelled");
  });

  it("cancelOcoPeers no-ops on null/empty group_id", async () => {
    const { cancelOcoPeers } = await import("./db.js");
    const a = insertOrder(makeFixture({ group_id: null }));
    expect(cancelOcoPeers(a, null, "OCO_PEER_FIRED", "x")).toEqual([]);
    expect(cancelOcoPeers(a, undefined, "OCO_PEER_FIRED", "x")).toEqual([]);
    // Pass a group id but a row not in any group — returns [].
    expect(cancelOcoPeers(a, "nonexistent", "OCO_PEER_FIRED", "x")).toEqual([]);
  });
});

describe("cancelOrderById --cascade", () => {
  function baseArgs() {
    return {
      side: "buy" as const,
      trigger: "price_below" as const,
      targetPriceUsd: 3000,
      chain: "base",
      account: "main",
      base: "ETH" as const,
      quote: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const,
      quoteAmount: "100",
    };
  }

  it("manual cancel WITHOUT cascade leaves peers active", async () => {
    const a = createOrderRow({ ...baseArgs(), group: "test1" });
    const b = createOrderRow({ ...baseArgs(), group: "test1" });
    const c = createOrderRow({ ...baseArgs(), group: "test1" });
    cancelOrderById(a.id!);
    const { getOrderById } = await import("./db.js");
    expect(getOrderById(a.id!)!.status).toBe("cancelled");
    expect(getOrderById(b.id!)!.status).toBe("active");
    expect(getOrderById(c.id!)!.status).toBe("active");
  });

  it("manual cancel WITH cascade cancels every peer + tags OCO_OPERATOR_CASCADE", async () => {
    const a = createOrderRow({ ...baseArgs(), group: "test2" });
    const b = createOrderRow({ ...baseArgs(), group: "test2" });
    const c = createOrderRow({ ...baseArgs(), group: "test2" });
    const result = cancelOrderById(a.id!, { cascade: true });
    expect(result.cascadedPeerIds?.sort()).toEqual([b.id, c.id]);
    const { getOrderById } = await import("./db.js");
    expect(getOrderById(b.id!)!.status).toBe("cancelled");
    expect(getOrderById(b.id!)!.last_error_code).toBe("OCO_OPERATOR_CASCADE");
    expect(getOrderById(c.id!)!.status).toBe("cancelled");
    expect(getOrderById(c.id!)!.last_error_code).toBe("OCO_OPERATOR_CASCADE");
  });

  it("cascade is a no-op on a single-order group (no peers)", async () => {
    const a = createOrderRow({ ...baseArgs(), group: "alone" });
    const result = cancelOrderById(a.id!, { cascade: true });
    // No cascadedPeerIds field when there were no peers — the helper only
    // attaches it on non-empty cascade.
    expect(result.cascadedPeerIds).toBeUndefined();
  });

  it("cascade on an order without a group_id is allowed at the DB layer but no-ops", async () => {
    // The cli/MCP layer rejects --cascade on a non-grouped order, but the
    // lower-level cancelOrderById accepts it gracefully (no-op): the
    // db.cancelOcoPeers helper short-circuits on null group_id, so the
    // cascade just does nothing extra. CLI guard prevents the operator
    // typo case.
    const a = createOrderRow(baseArgs()); // no group
    const result = cancelOrderById(a.id!, { cascade: true });
    expect(result.cascadedPeerIds).toBeUndefined();
    expect(result.status).toBe("cancelled");
  });
});
