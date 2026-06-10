/**
 * runOrderTick integration tests — the FIRST test coverage for the
 * order engine's main loop (expiry → price → trigger → lock → wallet
 * → fire → journal → OCO cascade).
 *
 * Strategy: fully offline. We mock the three I/O boundaries —
 *   - ./price.js   (getCurrentPrice / getCurrentPrices)
 *   - ./tokens.js  (getToken — decimals/symbol lookup)
 *   - ./wallet.js  (loadReadOnlyWallet / loadWallet)
 * — and use PAPER orders for the fire path, so executePaperTrade
 * writes to the virtual book and no on-chain / aggregator code runs.
 *
 * The order journal is enabled via config so every test can assert
 * the forensic timeline alongside the status transitions. This
 * directly regression-guards the engine-hardening work:
 *   1. journal entries on ALL terminal/skip paths (wallet failure,
 *      trade exception, expiry) — previously blind spots
 *   2. the pre-fire expiry re-check (order must NOT fire when its
 *      expires_at passed during the price fetch / wallet build)
 *   3. OCO cascade on fill / expiry
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-ordertick-test-"));
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

// Token addresses — base-chain WETH + USDC (any valid 0x strings work;
// the price/token mocks key off these constants).
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const { runOrderTick } = await import("./orders.js");
const {
  openDb,
  closeDb,
  insertOrder,
  getOrderById,
  replayOrderEntries,
  listPaperTrades,
} = await import("./db.js");
type InsertOrderArgs = import("./db.js").InsertOrderArgs;
const { setPaperBalance } = await import("./paperTrade.js");
const { loadConfig, saveConfig, setConfigPath } = await import("./config.js");
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

beforeAll(() => {
  openDb();
  // Enable the order journal so every test can assert the forensic
  // timeline. proximityPct default (5) is fine.
  saveConfig(setConfigPath(loadConfig(), "engine.orderJournal.enabled", true));
});

afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM orders");
  db.exec("DELETE FROM order_check_log");
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM paper_balances");
  vi.clearAllMocks();
  // Default price answer: WETH $2000, USDC $1. Tests override per-case.
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

function seedOrder(over: Partial<InsertOrderArgs> = {}): number {
  return insertOrder({
    side: "buy",
    trigger_type: "price_below",
    target_price_usd: 2100, // default mock price 2000 ≤ 2100 → triggered
    trail_pct: null,
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
    expires_at: null,
    strategy: "tick-test",
    note: null,
    group_id: null,
    paper: true, // paper by default — fire path never touches chain
    ...over,
  });
}

function seedQuoteBalance(amount = "10000"): void {
  setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount });
}

function decisions(orderId: number): string[] {
  return replayOrderEntries(orderId).map((e) => e.decision);
}

const tick = (over: Partial<Parameters<typeof runOrderTick>[0]> = {}) =>
  runOrderTick({ logger: noopLogger, ...over });

// ── expiry (step-1 pre-price check) ──────────────────────────

describe("runOrderTick — expiry", () => {
  it("retires an expired order: status, report count, journal entry", async () => {
    const id = seedOrder({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const report = await tick();
    expect(report.expiredCount).toBe(1);
    expect(report.fills).toHaveLength(0);
    expect(getOrderById(id)?.status).toBe("expired");
    // Journal: timeline ends with an explicit "expired" entry instead
    // of just stopping silently (pre-hardening there was NO entry).
    expect(decisions(id)).toEqual(["expired"]);
    // Step-1 expiry runs before the price fetch — no price call needed.
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it("expired OCO peer cancels the rest of its group", async () => {
    const expired = seedOrder({
      group_id: "oco-exp",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const sibling = seedOrder({ group_id: "oco-exp", target_price_usd: 1 }); // never triggers
    const report = await tick();
    expect(report.expiredCount).toBe(1);
    expect(getOrderById(expired)?.status).toBe("expired");
    expect(getOrderById(sibling)?.status).toBe("cancelled");
    expect(getOrderById(sibling)?.last_error_code).toBe("OCO_PEER_FIRED");
  });
});

// ── price unavailable ────────────────────────────────────────

describe("runOrderTick — price unavailable", () => {
  it("records a transient error + journal error entry, order stays active", async () => {
    mockedPrice.mockResolvedValue(null as never);
    const id = seedOrder();
    const report = await tick();
    expect(report.transientErrorCount).toBe(1);
    const row = getOrderById(id)!;
    expect(row.status).toBe("active"); // retry next tick
    expect(row.last_error_code).toBe("API_ERROR");
    expect(decisions(id)).toEqual(["error"]);
  });
});

// ── trigger not met ──────────────────────────────────────────

describe("runOrderTick — trigger not met", () => {
  it("leaves the order active with a near_threshold journal entry", async () => {
    const id = seedOrder({ target_price_usd: 1500 }); // price 2000 > 1500 → buy not triggered
    const report = await tick();
    expect(report.triggered).toBe(0);
    expect(report.fills).toHaveLength(0);
    expect(getOrderById(id)?.status).toBe("active");
    // First journal entry always logs; decision is the honest
    // "approaching" code, NOT triggered_skipped (regression guard for
    // the fixed no-op ternary).
    expect(decisions(id)).toEqual(["near_threshold"]);
  });
});

// ── dry-run ──────────────────────────────────────────────────

describe("runOrderTick — dry run", () => {
  it("triggered order is skipped with DRY_RUN and journals triggered_skipped", async () => {
    const id = seedOrder(); // triggered at default price
    const report = await tick({ dryRun: true });
    expect(report.triggered).toBe(1);
    expect(report.fills).toHaveLength(1);
    expect(report.fills[0]).toMatchObject({ orderId: id, status: "skipped", errorCode: "DRY_RUN" });
    expect(getOrderById(id)?.status).toBe("active");
    expect(decisions(id)).toEqual(["triggered_skipped"]);
  });
});

// ── engine lock ──────────────────────────────────────────────

describe("runOrderTick — engine lock", () => {
  it("triggered order is skipped while locked; journal carries the lock reason", async () => {
    const config = loadConfig();
    await lockEngine({ reason: "incident response", lockedBy: "test", config, logger: noopLogger });
    try {
      const id = seedOrder();
      const report = await tick();
      expect(report.fills).toHaveLength(1);
      expect(report.fills[0]).toMatchObject({ orderId: id, status: "skipped", errorCode: "ENGINE_LOCKED" });
      expect(getOrderById(id)?.status).toBe("active");
      expect(getOrderById(id)?.last_error_code).toBe("ENGINE_LOCKED");
      const entries = replayOrderEntries(id);
      expect(entries.map((e) => e.decision)).toEqual(["triggered_skipped"]);
      expect(entries[0].notes).toContain("incident response");
    } finally {
      await unlockEngine({ unlockedBy: "test", config, logger: noopLogger });
    }
  });
});

// ── paper fire (happy path) ──────────────────────────────────

describe("runOrderTick — paper fill", () => {
  it("fills a triggered paper order: status, virtual fill row, journal triggered_fired", async () => {
    seedQuoteBalance("10000");
    const id = seedOrder(); // buy 100 USDC worth at $2000, triggered
    const report = await tick();
    expect(report.triggered).toBe(1);
    expect(report.filled).toBe(1);
    expect(report.fills[0]).toMatchObject({ orderId: id, status: "filled" });
    const row = getOrderById(id)!;
    expect(row.status).toBe("filled");
    expect(row.fill_tx_hash).toMatch(/^paper:/); // synthetic hash, never mistakable for on-chain
    // Virtual book recorded the fill, attributed to this order.
    const paper = listPaperTrades({});
    expect(paper).toHaveLength(1);
    expect(paper[0]).toMatchObject({ source_type: "order", source_id: id, direction: "buy" });
    expect(decisions(id)).toEqual(["triggered_fired"]);
  });

  it("OCO: a filled peer cancels the rest of its group", async () => {
    seedQuoteBalance("10000");
    const filled = seedOrder({ group_id: "oco-fill" });
    const sibling = seedOrder({ group_id: "oco-fill", target_price_usd: 1 }); // not triggered
    const report = await tick();
    expect(report.filled).toBe(1);
    expect(getOrderById(filled)?.status).toBe("filled");
    expect(getOrderById(sibling)?.status).toBe("cancelled");
  });
});

// ── terminal failure (insufficient virtual balance) ──────────

describe("runOrderTick — terminal failure", () => {
  it("marks the order failed + journals the error (previously a journal blind spot)", async () => {
    // NO quote balance seeded → executePaperTrade throws
    // PAPER_INSUFFICIENT_BALANCE, which is not in the transient list →
    // terminal failure path.
    const id = seedOrder();
    const report = await tick();
    expect(report.failedCount).toBe(1);
    const row = getOrderById(id)!;
    expect(row.status).toBe("failed");
    expect(row.last_error_code).toBe("PAPER_INSUFFICIENT_BALANCE");
    // Journal: the terminal failure is recorded — `order replay` can
    // answer "why did this order flip to failed?".
    const entries = replayOrderEntries(id);
    expect(entries.map((e) => e.decision)).toEqual(["error"]);
    expect(entries[0].notes).toContain("PAPER_INSUFFICIENT_BALANCE");
  });

  it("a terminally-failed OCO peer cancels its group", async () => {
    const failing = seedOrder({ group_id: "oco-fail" }); // no balance → fails
    const sibling = seedOrder({ group_id: "oco-fail", target_price_usd: 1 });
    await tick();
    expect(getOrderById(failing)?.status).toBe("failed");
    expect(getOrderById(sibling)?.status).toBe("cancelled");
  });
});

// ── wallet load failure ──────────────────────────────────────

describe("runOrderTick — wallet load failure", () => {
  it("skips the order, keeps it active, and journals the error", async () => {
    seedQuoteBalance("10000");
    const err = Object.assign(new Error("keystore not found"), { code: "WALLET_NOT_FOUND" });
    mockedReadOnlyWallet.mockImplementation(() => { throw err; });
    const id = seedOrder();
    const report = await tick();
    expect(report.transientErrorCount).toBe(1);
    expect(report.fills[0]).toMatchObject({ orderId: id, status: "skipped", errorCode: "WALLET_NOT_FOUND" });
    expect(getOrderById(id)?.status).toBe("active"); // retryable
    const entries = replayOrderEntries(id);
    expect(entries.map((e) => e.decision)).toEqual(["error"]);
    expect(entries[0].notes).toContain("WALLET_NOT_FOUND");
  });
});

// ── pre-fire expiry re-check (race window) ───────────────────

describe("runOrderTick — pre-fire expiry re-check", () => {
  it("does NOT fire an order whose expires_at passed during the price fetch", async () => {
    seedQuoteBalance("10000");
    // Order expires 30ms from now — passes the step-1 check, but the
    // (mocked) price fetch takes 150ms, so by fire time it's expired.
    const id = seedOrder({ expires_at: new Date(Date.now() + 30).toISOString() });
    mockedPrice.mockImplementation(async (address: string) => {
      await new Promise((r) => setTimeout(r, 150));
      return String(address).toLowerCase() === USDC.toLowerCase() ? 1 : 2000;
    });
    const report = await tick();
    expect(report.expiredCount).toBe(1);
    expect(report.filled).toBe(0);
    expect(report.fills).toHaveLength(0);
    const row = getOrderById(id)!;
    expect(row.status).toBe("expired");
    expect(row.fill_tx_hash).toBeNull(); // crucially: no fire happened
    // No virtual fill either.
    expect(listPaperTrades({})).toHaveLength(0);
    // Journal records the expiry WITH the price observed at trigger time.
    const entries = replayOrderEntries(id);
    expect(entries.map((e) => e.decision)).toEqual(["expired"]);
    expect(entries[0].price_usd).toBe(2000);
  });

  it("the pre-fire re-check cascades OCO like the step-1 path", async () => {
    seedQuoteBalance("10000");
    const expiring = seedOrder({
      group_id: "oco-race",
      expires_at: new Date(Date.now() + 30).toISOString(),
    });
    const sibling = seedOrder({ group_id: "oco-race", target_price_usd: 1 });
    mockedPrice.mockImplementation(async (address: string) => {
      await new Promise((r) => setTimeout(r, 150));
      return String(address).toLowerCase() === USDC.toLowerCase() ? 1 : 2000;
    });
    await tick();
    expect(getOrderById(expiring)?.status).toBe("expired");
    expect(getOrderById(sibling)?.status).toBe("cancelled");
  });
});

// ── journal disabled (default config) ────────────────────────

describe("runOrderTick — journal disabled", () => {
  it("writes no journal rows when engine.orderJournal.enabled=false", async () => {
    saveConfig(setConfigPath(loadConfig(), "engine.orderJournal.enabled", false));
    try {
      seedQuoteBalance("10000");
      const id = seedOrder();
      const report = await tick();
      expect(report.filled).toBe(1);
      expect(replayOrderEntries(id)).toHaveLength(0); // zero cost when off
    } finally {
      saveConfig(setConfigPath(loadConfig(), "engine.orderJournal.enabled", true));
    }
  });
});

// ── v31: order on_fill hooks ─────────────────────────────────

describe("runOrderTick — on_fill hook", () => {
  const HOOK = {
    type: "createOrder",
    spec: {
      side: "sell",
      trigger: "trailing",
      trailPct: 5,
      base: "WETH",
      quote: "USDC",
      baseAmount: "{{filled.baseAmount}}",
    },
  };

  it("a fill chains the follow-up order, sized to the filled amount", async () => {
    seedQuoteBalance("10000");
    // Paper buy below 2100 — price mock is 2000 → triggers.
    const id = seedOrder({
      side: "buy",
      trigger_type: "price_below",
      target_price_usd: 2100,
      base_amount: null,
      quote_amount: "1000",
      paper: true,
      on_fill_json: JSON.stringify(HOOK),
    });
    const report = await tick();
    expect(report.filled).toBe(1);

    const { listOrders } = await import("./db.js");
    const all = listOrders({ status: "active" });
    expect(all).toHaveLength(1); // the chained follow-up
    const follow = all[0];
    expect(follow.trigger_type).toBe("trailing");
    expect(follow.side).toBe("sell");
    // Sized to the simulated fill: 1000 USDC at ~2000 with paper
    // worst-case slippage → just under 0.5 WETH.
    expect(parseFloat(follow.base_amount!)).toBeGreaterThan(0.49);
    expect(parseFloat(follow.base_amount!)).toBeLessThanOrEqual(0.5);
    expect(follow.id).not.toBe(id);
  });

  it("hook failure does NOT unwind the fill (order stays filled, journal records hook_failed)", async () => {
    const { loadConfig, saveConfig } = await import("./config.js");
    const cfg = loadConfig();
    saveConfig({ ...cfg, engine: { ...cfg.engine, orderJournal: { ...cfg.engine.orderJournal, enabled: true } } } as never);
    try {
      seedQuoteBalance("10000");
      const id = seedOrder({
        side: "buy",
        trigger_type: "price_below",
        target_price_usd: 2100,
        base_amount: null,
        quote_amount: "1000",
        paper: true,
        // trailPct -5 passes structural parse but fails the order
        // validators at hook-execution time.
        on_fill_json: JSON.stringify({ type: "createOrder", spec: { ...HOOK.spec, trailPct: -5 } }),
      });
      const report = await tick();
      expect(report.filled).toBe(1); // fill kept

      const { getOrderById, replayOrderEntries } = await import("./db.js");
      expect(getOrderById(id)?.status).toBe("filled");
      const decisions = replayOrderEntries(id).map((e) => e.decision);
      expect(decisions).toContain("hook_failed");
      // No follow-up order created.
      const { listOrders } = await import("./db.js");
      expect(listOrders({ status: "active" })).toHaveLength(0);
    } finally {
      saveConfig(cfg);
    }
  });
});

// ── multi-leg bracket hooks (createOrders) ──────────────────

describe("runOrderTick — multi-leg bracket hook", () => {
  it("a fill chains TP+SL legs sharing the auto-OCO group + paper flag", async () => {
    seedQuoteBalance("10000");
    const id = seedOrder({
      side: "buy",
      trigger_type: "price_below",
      target_price_usd: 2100,
      base_amount: null,
      quote_amount: "1000",
      paper: true,
      on_fill_json: JSON.stringify({
        type: "createOrders",
        specs: [
          { side: "sell", trigger: "price_above", price: 3000, base: "WETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
          { side: "sell", trigger: "price_below", price: 1500, base: "WETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
        ],
      }),
    });
    const report = await tick();
    expect(report.filled).toBe(1);

    const { listOrders } = await import("./db.js");
    const legs = listOrders({ status: "active" });
    expect(legs).toHaveLength(2);
    for (const leg of legs) {
      expect(leg.group_id).toBe(`hook-order-${id}-1`);
      expect(leg.paper).toBe(1); // inherits the parent's book
      expect(leg.side).toBe("sell");
    }
    const triggers = legs.map((l) => l.trigger_type).sort();
    expect(triggers).toEqual(["price_above", "price_below"]);
  });
});

// ── paused orders ────────────────────────────────────────────

describe("runOrderTick — paused orders", () => {
  it("a paused order is not evaluated (trigger would otherwise fire)", async () => {
    seedQuoteBalance("10000");
    const { pauseOrder, getOrderById } = await import("./db.js");
    // Mock price 2000 ≤ 2100 → would trigger if active.
    const id = seedOrder({ paper: true });
    pauseOrder(id);
    const report = await tick();
    expect(report.filled).toBe(0);
    expect(getOrderById(id)?.status).toBe("paused");
  });

  it("a paused order still expires when expires_at passes", async () => {
    const { pauseOrder, getOrderById } = await import("./db.js");
    const id = seedOrder({ expires_at: "2026-01-01T00:00:00.000Z" });
    pauseOrder(id);
    const report = await tick();
    expect(report.expiredCount).toBe(1);
    expect(getOrderById(id)?.status).toBe("expired");
  });

  it("an OCO peer fire cancels the PAUSED sibling too", async () => {
    seedQuoteBalance("10000");
    const { pauseOrder, getOrderById } = await import("./db.js");
    // TP leg triggers (mock price 2000 ≤ 2100), SL leg paused.
    const tp = seedOrder({ group_id: "bracket-1", paper: true });
    const sl = seedOrder({
      group_id: "bracket-1",
      target_price_usd: 900, // far from trigger
      paper: true,
    });
    pauseOrder(sl);
    const report = await tick();
    expect(report.filled).toBe(1);
    expect(getOrderById(tp)?.status).toBe("filled");
    // The paused arm died with its sibling — resuming it later would
    // have re-armed an exit for a position that already closed.
    const slRow = getOrderById(sl)!;
    expect(slRow.status).toBe("cancelled");
    expect(slRow.last_error_code).toBe("OCO_PEER_FIRED");
  });
});

// ── v33: crash-window recovery guard ─────────────────────────

describe("runOrderTick — v33 crash-window recovery", () => {
  async function seedPaperEvidence(orderId: number, over: Record<string, unknown> = {}) {
    const { recordPaperTrade } = await import("./db.js");
    return recordPaperTrade({
      timestamp: new Date().toISOString(),
      source_type: "order",
      source_id: orderId,
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: WETH,
      base_symbol: "WETH",
      base_amount: "0.5",
      quote_token: USDC,
      quote_symbol: "USDC",
      quote_amount: "1000",
      price: "2000",
      slippage_bps: 50,
      strategy: null,
      notes: null,
      ...over,
    } as never);
  }

  it("a triggered paper order with an orphaned fill is booked, not refired", async () => {
    seedQuoteBalance("10000");
    const id = seedOrder({ paper: true }); // price_below 2100, mock 2000 → triggered
    await seedPaperEvidence(id);
    const report = await tick();
    expect(report.recoveredCount).toBe(1);
    expect(report.filled).toBe(0); // nothing sent this tick
    const fill = report.fills.find((f) => f.orderId === id)!;
    expect(fill.status).toBe("recovered");

    const { getOrderById, listPaperTrades } = await import("./db.js");
    const row = getOrderById(id)!;
    expect(row.status).toBe("filled");
    expect(row.base_amount === "0.5" || row.fill_price === 2000).toBe(true);
    expect(row.fill_price).toBe(2000); // from the evidence trade
    // Exactly the one orphaned fill — no double-buy.
    expect(listPaperTrades({})).toHaveLength(1);
  });

  it("a real order recovers from a pending trade row (the TX_TIMEOUT refire scenario)", async () => {
    const { insertTrade, getOrderById } = await import("./db.js");
    seedQuoteBalance("10000");
    const id = seedOrder({ paper: false }); // triggered at mock price
    // The timed-out tx from the previous tick — still pending.
    insertTrade({
      timestamp: new Date().toISOString(),
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "WETH", base_amount: "0.5",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "1000",
      price: "1999",
      tx_hash: "0xtimedout",
      status: "pending",
      gas_used: null, gas_price_wei: null, gas_cost_native: null,
      aggregator: "kyberswap", fee_tier: null,
      notes: `[order #${id}]`,
      strategy: null,
      realized_slippage_bps: null,
    });
    const report = await tick();
    expect(report.recoveredCount).toBe(1);
    const row = getOrderById(id)!;
    expect(row.status).toBe("filled");
    expect(row.fill_tx_hash).toBe("0xtimedout");
    expect(row.fill_price).toBe(1999);
  });

  it("a reverted trade is NOT evidence — the order refires", async () => {
    const { insertTrade } = await import("./db.js");
    seedQuoteBalance("10000");
    const id = seedOrder({ paper: true });
    insertTrade({
      timestamp: new Date().toISOString(),
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "WETH", base_amount: "0.5",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "1000",
      price: "2000",
      tx_hash: "0xreverted",
      status: "failed",
      gas_used: null, gas_price_wei: null, gas_cost_native: null,
      aggregator: "kyberswap", fee_tier: null,
      notes: `[order #${id}]`,
      strategy: null,
      realized_slippage_bps: null,
    });
    const report = await tick();
    expect(report.recoveredCount).toBe(0);
    expect(report.filled).toBe(1); // refired normally (paper)
  });

  it("recovery cascades the OCO group — the surviving arm dies with the booked fill", async () => {
    seedQuoteBalance("10000");
    const { getOrderById } = await import("./db.js");
    const tp = seedOrder({ paper: true, group_id: "bracket-r" }); // triggered
    const sl = seedOrder({
      paper: true, group_id: "bracket-r",
      target_price_usd: 900, // far from trigger — stays active unless cascaded
    });
    await seedPaperEvidence(tp);
    const report = await tick();
    expect(report.recoveredCount).toBe(1);
    expect(getOrderById(tp)?.status).toBe("filled");
    const slRow = getOrderById(sl)!;
    expect(slRow.status).toBe("cancelled");
    expect(slRow.last_error_code).toBe("OCO_PEER_FIRED");
  });

  it("recovery skips the on_fill hook (notification says so; no follow-up created)", async () => {
    seedQuoteBalance("10000");
    const { listOrders, getOrderById } = await import("./db.js");
    const id = seedOrder({
      paper: true,
      on_fill_json: JSON.stringify({
        type: "createOrder",
        spec: { side: "sell", trigger: "trailing", trailPct: 5, base: "WETH", quote: "USDC", baseAmount: "{{filled.baseAmount}}" },
      }),
    });
    await seedPaperEvidence(id);
    const report = await tick();
    expect(report.recoveredCount).toBe(1);
    expect(getOrderById(id)?.status).toBe("filled");
    expect(listOrders({ status: "active" })).toHaveLength(0); // no chained follow-up
  });

  it("marker matching is exact — #N evidence never matches #N5", async () => {
    const { insertTrade } = await import("./db.js");
    seedQuoteBalance("10000");
    const id = seedOrder({ paper: true });
    insertTrade({
      timestamp: new Date().toISOString(),
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "WETH", base_amount: "0.5",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "1000",
      price: "2000",
      tx_hash: "0xother",
      status: "success",
      gas_used: null, gas_price_wei: null, gas_cost_native: null,
      aggregator: "kyberswap", fee_tier: null,
      notes: `[order #${id}5]`, // someone else's marker
      strategy: null,
      realized_slippage_bps: null,
    });
    const report = await tick();
    expect(report.recoveredCount).toBe(0);
    expect(report.filled).toBe(1);
  });

  it("journals the recovered decision", async () => {
    const { saveConfig } = await import("./config.js");
    const { loadConfig: lc } = await import("./config.js");
    const cfg = lc();
    saveConfig({ ...cfg, engine: { ...cfg.engine, orderJournal: { ...cfg.engine.orderJournal, enabled: true } } } as never);
    try {
      seedQuoteBalance("10000");
      const id = seedOrder({ paper: true });
      await seedPaperEvidence(id);
      await tick();
      const { replayOrderEntries } = await import("./db.js");
      const entries = replayOrderEntries(id);
      const recoveredEntry = entries.find((e) => e.decision === "recovered");
      expect(recoveredEntry).toBeDefined();
      expect(recoveredEntry!.notes).toMatch(/booked, not refired/);
    } finally {
      saveConfig(cfg);
    }
  });
});

// ── v35: position-level "max" sizing ─────────────────────────

describe("runOrderTick — max sizing", () => {
  it("a trailing sell with baseAmount max sells the ENTIRE virtual position", async () => {
    const { setPaperBalance: setBal } = await import("./paperTrade.js");
    const { getOrderById, listPaperTrades } = await import("./db.js");
    // Position: 1.75 WETH on the paper book; quote book empty.
    setBal({ account: "default", chain: "base", token: WETH, decimals: 18, amount: "1.75" });
    const id = seedOrder({
      side: "sell",
      trigger_type: "price_below",
      target_price_usd: 2100, // mock price 2000 → triggered
      base_amount: "max",
      quote_amount: null,
      paper: true,
    });
    const report = await tick();
    expect(report.filled).toBe(1);
    expect(getOrderById(id)?.status).toBe("filled");
    const fills = listPaperTrades({});
    expect(fills).toHaveLength(1);
    // The whole 1.75 WETH position, not a fixed slice.
    expect(parseFloat(fills[0].base_amount)).toBeCloseTo(1.75, 9);
    expect(fills[0].direction).toBe("sell");
  });

  it("max with an empty book fails the fire with PAPER_INSUFFICIENT_BALANCE (terminal)", async () => {
    const { getOrderById } = await import("./db.js");
    const id = seedOrder({
      side: "sell",
      trigger_type: "price_below",
      target_price_usd: 2100,
      base_amount: "max",
      quote_amount: null,
      paper: true,
    });
    const report = await tick();
    expect(report.filled).toBe(0);
    const row = getOrderById(id)!;
    expect(row.status).toBe("failed");
    expect(row.last_error_code).toBe("PAPER_INSUFFICIENT_BALANCE");
  });
});

describe("createOrderRow — v35 amount validation", () => {
  const base = {
    trigger: "price_below" as const,
    targetPriceUsd: 1800,
    chain: "base",
    account: "default",
    base: WETH as `0x${string}`,
    quote: USDC as `0x${string}`,
    paper: true,
  };
  it("accepts spend-side max and normalizes case", async () => {
    const { createOrderRow } = await import("./orders.js");
    const sell = createOrderRow({ ...base, side: "sell", baseAmount: "MAX" });
    expect(sell.base_amount).toBe("max");
    const buy = createOrderRow({ ...base, side: "buy", quoteAmount: "Max" });
    expect(buy.quote_amount).toBe("max");
  });
  it("rejects receive-side max with a teaching error", async () => {
    const { createOrderRow } = await import("./orders.js");
    expect(() => createOrderRow({ ...base, side: "buy", baseAmount: "max" })).toThrow(/SPEND side/);
    expect(() => createOrderRow({ ...base, side: "sell", quoteAmount: "max" })).toThrow(/SPEND side/);
  });
  it("rejects garbage amounts at create (not at first fire)", async () => {
    const { createOrderRow } = await import("./orders.js");
    expect(() => createOrderRow({ ...base, side: "sell", baseAmount: "lots" })).toThrow(/positive decimal, "max", or a percentage/);
    expect(() => createOrderRow({ ...base, side: "buy", quoteAmount: "-5" })).toThrow(/positive decimal, "max", or a percentage/);
  });
});

describe("runOrderTick — percentage sizing (v35.5)", () => {
  it("a sell with baseAmount 50% takes half the position at fire time", async () => {
    const { setPaperBalance: setBal } = await import("./paperTrade.js");
    const { listPaperTrades } = await import("./db.js");
    setBal({ account: "default", chain: "base", token: WETH, decimals: 18, amount: "2" });
    seedOrder({
      side: "sell",
      trigger_type: "price_below",
      target_price_usd: 2100,
      base_amount: "50%",
      quote_amount: null,
      paper: true,
    });
    const report = await tick();
    expect(report.filled).toBe(1);
    const fills = listPaperTrades({});
    expect(parseFloat(fills[0].base_amount)).toBeCloseTo(1.0, 9); // half of 2
  });

  it("createOrderRow accepts spend-side percentages and rejects bad ones", async () => {
    const { createOrderRow } = await import("./orders.js");
    const base = {
      trigger: "price_below" as const, targetPriceUsd: 1800,
      chain: "base", account: "default",
      base: WETH as `0x${string}`, quote: USDC as `0x${string}`, paper: true,
    };
    expect(createOrderRow({ ...base, side: "sell", baseAmount: "37.5%" }).base_amount).toBe("37.5%");
    expect(() => createOrderRow({ ...base, side: "sell", baseAmount: "150%" })).toThrow(/percentage/);
    expect(() => createOrderRow({ ...base, side: "buy", baseAmount: "50%" })).toThrow(/SPEND side/);
  });
});
