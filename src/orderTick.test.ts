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
