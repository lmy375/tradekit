// Tests for paperTrade.ts (iter30). Three layers:
//
//   1. Pure math: slippage application, opposite-amount derivation.
//      No DB. Fast.
//   2. DB roundtrip: recordPaperTrade, paper_balances upsert,
//      listPaperTrades filters, resetPaperState. Shared tmp DB.
//   3. executePaperTrade integration: drive the full flow with
//      mocked getCurrentPrice / getToken so we never touch the
//      network. Asserts on balance deltas, journal rows, and the
//      result shape that orders.ts consumes.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";

// Override the data dir BEFORE importing db / paperTrade.
const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-paper-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

// Mock the on-chain bits paperTrade.ts depends on, so the tests
// don't need a real publicClient.
vi.mock("./price.js", () => ({
  getCurrentPrice: vi.fn(),
}));
vi.mock("./tokens.js", async () => {
  // Keep the real NATIVE_TOKEN sentinel + isNativeSentinel function;
  // only stub getToken so we control decimals + symbols.
  const actual = (await vi.importActual<typeof import("./tokens.js")>("./tokens.js"));
  return {
    ...actual,
    getToken: vi.fn(),
  };
});

const {
  applyWorstCaseSlippage,
  computeOppositeAmount,
  executePaperTrade,
  readVirtualBalance,
  adjustPaperBalance,
  setPaperBalance,
  summarizePaperPnl,
} = await import("./paperTrade.js");
type PaperTradeRow = import("./db.js").PaperTradeRow;
const {
  openDb,
  closeDb,
  recordPaperTrade,
  getPaperBalance,
  upsertPaperBalance,
  listPaperTrades,
  listPaperBalances,
  resetPaperState,
  paperDailyUsdVolume,
  paperUsdSpentUnderStrategy,
} = await import("./db.js");
const { getCurrentPrice } = await import("./price.js");
const { getToken } = await import("./tokens.js");
const { enforceDailyUsdLimit } = await import("./safety.js");

beforeAll(() => {
  openDb();
});
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM paper_balances");
  vi.clearAllMocks();
});

// ── 1) Pure math ────────────────────────────────────────────

describe("applyWorstCaseSlippage", () => {
  it("BUY pushes effective price UP by slip", () => {
    expect(applyWorstCaseSlippage(100, "buy", 100)).toBeCloseTo(101); // 1%
    expect(applyWorstCaseSlippage(2_500, "buy", 50)).toBeCloseTo(2512.5);
  });
  it("SELL pulls effective price DOWN by slip", () => {
    expect(applyWorstCaseSlippage(100, "sell", 100)).toBeCloseTo(99);
    expect(applyWorstCaseSlippage(2_500, "sell", 50)).toBeCloseTo(2487.5);
  });
  it("0 bps == spot", () => {
    expect(applyWorstCaseSlippage(100, "buy", 0)).toBe(100);
    expect(applyWorstCaseSlippage(100, "sell", 0)).toBe(100);
  });
});

describe("computeOppositeAmount", () => {
  it("derives quote from base", () => {
    const r = computeOppositeAmount({
      baseAmount: "2",
      quoteAmount: null,
      effectivePrice: 2_500,
    });
    expect(r.baseAmount).toBe("2");
    expect(parseFloat(r.quoteAmount)).toBeCloseTo(5_000);
  });
  it("derives base from quote", () => {
    const r = computeOppositeAmount({
      baseAmount: null,
      quoteAmount: "5000",
      effectivePrice: 2_500,
    });
    expect(parseFloat(r.baseAmount)).toBeCloseTo(2);
    expect(r.quoteAmount).toBe("5000");
  });
  it("rejects both set", () => {
    expect(() =>
      computeOppositeAmount({
        baseAmount: "1",
        quoteAmount: "2",
        effectivePrice: 100,
      }),
    ).toThrow(/Both baseAmount and quoteAmount/);
  });
  it("rejects neither set", () => {
    expect(() =>
      computeOppositeAmount({
        baseAmount: null,
        quoteAmount: null,
        effectivePrice: 100,
      }),
    ).toThrow(/Missing amount/);
  });
  it("rejects invalid numbers", () => {
    expect(() =>
      computeOppositeAmount({
        baseAmount: "abc",
        quoteAmount: null,
        effectivePrice: 100,
      }),
    ).toThrow(/Invalid baseAmount/);
    expect(() =>
      computeOppositeAmount({
        baseAmount: "0",
        quoteAmount: null,
        effectivePrice: 100,
      }),
    ).toThrow(/Invalid baseAmount/);
  });
});

// ── 1b) summarizePaperPnl (pure realized-P&L roll-up) ───────

describe("summarizePaperPnl", () => {
  function row(over: Partial<PaperTradeRow>): PaperTradeRow {
    return {
      id: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      source_type: "order",
      source_id: 1,
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: "0xeee",
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: "0xbbb",
      quote_symbol: "USDC",
      quote_amount: "2000",
      price: "2000",
      slippage_bps: 50,
      strategy: null,
      notes: null,
      value_usd: null,
      ...over,
    };
  }

  it("returns [] for empty input", () => {
    expect(summarizePaperPnl([])).toEqual([]);
  });

  it("nets quoteReceived - quoteSpent per strategy", () => {
    const out = summarizePaperPnl([
      row({ direction: "buy", quote_amount: "2000", strategy: "dca" }),
      row({ direction: "sell", quote_amount: "2100", strategy: "dca" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      strategy: "dca",
      fills: 2,
      buys: 1,
      sells: 1,
      quoteSpent: 2000,
      quoteReceived: 2100,
      netQuote: 100,
    });
  });

  it("folds null strategy into (unattributed)", () => {
    const out = summarizePaperPnl([row({ strategy: null })]);
    expect(out[0].strategy).toBe("(unattributed)");
  });

  it("sorts buckets by fill count descending", () => {
    const out = summarizePaperPnl([
      row({ strategy: "a" }),
      row({ strategy: "b" }),
      row({ strategy: "b" }),
      row({ strategy: "b" }),
      row({ strategy: "c" }),
      row({ strategy: "c" }),
    ]);
    expect(out.map((s) => s.strategy)).toEqual(["b", "c", "a"]);
  });

  it("tracks first/last fill timestamps within a bucket", () => {
    const out = summarizePaperPnl([
      row({ strategy: "x", timestamp: "2026-03-01T00:00:00.000Z" }),
      row({ strategy: "x", timestamp: "2026-01-01T00:00:00.000Z" }),
      row({ strategy: "x", timestamp: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(out[0].firstFillAt).toBe("2026-01-01T00:00:00.000Z");
    expect(out[0].lastFillAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("treats a non-finite quote_amount as 0 (defensive)", () => {
    const out = summarizePaperPnl([row({ direction: "sell", quote_amount: "not-a-number", strategy: "x" })]);
    expect(out[0].quoteReceived).toBe(0);
    expect(out[0].netQuote).toBe(0);
  });
});

// ── 2) DB roundtrip ─────────────────────────────────────────

const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;

describe("paper_trades DB layer", () => {
  it("recordPaperTrade + listPaperTrades roundtrip", () => {
    const id = recordPaperTrade({
      timestamp: "2026-05-30T12:00:00Z",
      source_type: "order",
      source_id: 7,
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: WETH,
      base_symbol: "WETH",
      base_amount: "1.5",
      quote_token: USDC,
      quote_symbol: "USDC",
      quote_amount: "3000",
      price: "2000",
      slippage_bps: 50,
      strategy: "playbook:1",
      notes: "test fill",
    });
    expect(id).toBeGreaterThan(0);
    const rows = listPaperTrades({ chain: "base" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_type: "order",
      source_id: 7,
      direction: "buy",
      base_amount: "1.5",
      quote_amount: "3000",
      strategy: "playbook:1",
    });
  });

  it("paper_balances upsert + read", () => {
    upsertPaperBalance({ account: "default", chain: "base", token: USDC, balance: "10000" });
    let row = getPaperBalance("default", "base", USDC);
    expect(row?.balance).toBe("10000");

    // Re-upsert overwrites + bumps timestamp.
    upsertPaperBalance({ account: "default", chain: "base", token: USDC, balance: "9500" });
    row = getPaperBalance("default", "base", USDC);
    expect(row?.balance).toBe("9500");
  });

  it("listPaperTrades filters by strategy + sourceType", () => {
    recordPaperTrade(samplePaperRow({ strategy: "playbook:1", source_type: "order" }));
    recordPaperTrade(samplePaperRow({ strategy: "playbook:2", source_type: "schedule" }));
    recordPaperTrade(samplePaperRow({ strategy: "playbook:1", source_type: "manual" }));
    expect(listPaperTrades({ strategy: "playbook:1" })).toHaveLength(2);
    expect(listPaperTrades({ sourceType: "schedule" })).toHaveLength(1);
  });

  it("resetPaperState wipes both tables (scoped + unscoped)", () => {
    recordPaperTrade(samplePaperRow({ chain: "base" }));
    recordPaperTrade(samplePaperRow({ chain: "arbitrum" }));
    upsertPaperBalance({ account: "default", chain: "base", token: USDC, balance: "1" });
    upsertPaperBalance({ account: "default", chain: "arbitrum", token: USDC, balance: "2" });

    const baseScope = resetPaperState({ chain: "base" });
    expect(baseScope.tradesRemoved).toBe(1);
    expect(baseScope.balancesRemoved).toBe(1);
    expect(listPaperTrades({})).toHaveLength(1);
    expect(listPaperBalances({})).toHaveLength(1);

    const wipe = resetPaperState();
    expect(wipe.tradesRemoved).toBe(1);
    expect(wipe.balancesRemoved).toBe(1);
    expect(listPaperTrades({})).toHaveLength(0);
    expect(listPaperBalances({})).toHaveLength(0);
  });
});

describe("balance helpers (BigInt math via parseUnits)", () => {
  it("readVirtualBalance returns 0n for unseeded key", () => {
    expect(readVirtualBalance("default", "base", USDC, 6)).toBe(0n);
  });
  it("setPaperBalance + readVirtualBalance roundtrip", () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "1234.5" });
    expect(readVirtualBalance("default", "base", USDC, 6)).toBe(1_234_500_000n);
  });
  it("adjustPaperBalance applies positive + negative deltas", () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "1000" });
    let after = adjustPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, delta: "250" });
    expect(after).toBe("1250");
    after = adjustPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, delta: "-500" });
    expect(after).toBe("750");
  });
  it("adjustPaperBalance rejects below-zero debits", () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "100" });
    expect(() =>
      adjustPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, delta: "-101" }),
    ).toThrow(/below zero/);
  });
  it("setPaperBalance rejects negative amounts", () => {
    expect(() =>
      setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "-1" }),
    ).toThrow(/cannot be negative/);
  });
});

// ── 3) executePaperTrade integration ────────────────────────

const fakePublicClient = {} as never;
const fakeProfile = {
  name: "base",
  chainId: 8453,
  nativeSymbol: "ETH",
  viemChain: {} as never,
  weth: WETH,
  tokens: { WETH, USDC },
  rpcs: [],
} as never;
const fakeConfig = {
  defaultSlippageBps: 50,
  activeChain: "base",
  activeAccount: "default",
  chains: {},
  aggregator: { preferred: ["kyberswap"], mode: "first" },
  safety: { enabled: false },
  notifications: {},
  engine: {},
  mev: {},
} as never;
const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

function mockToken(addr: Address, symbol: string, decimals: number) {
  return {
    address: addr,
    chainId: 8453,
    decimals,
    symbol,
    isNative: false,
  };
}

describe("executePaperTrade", () => {
  beforeEach(() => {
    // Default mocks: WETH=$2500, USDC=$1, base→quote spot = 2500.
    (getToken as ReturnType<typeof vi.fn>).mockImplementation(async (_pc, _profile, addr: Address) => {
      if (addr.toLowerCase() === WETH.toLowerCase()) return mockToken(WETH, "WETH", 18);
      if (addr.toLowerCase() === USDC.toLowerCase()) return mockToken(USDC, "USDC", 6);
      throw new Error(`unknown token ${addr}`);
    });
    (getCurrentPrice as ReturnType<typeof vi.fn>).mockImplementation(async (addr: string) => {
      if (addr.toLowerCase() === WETH.toLowerCase()) return 2_500;
      if (addr.toLowerCase() === USDC.toLowerCase()) return 1;
      return null;
    });
  });

  it("BUY: spends quote, credits base, applies worst-case slippage UP", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "10000" });
    const r = await executePaperTrade(
      {
        direction: "buy",
        base: WETH,
        quote: USDC,
        quoteAmount: "5000",
        slippageBps: 100, // 1%
        source: { type: "manual", id: null },
      },
      {
        publicClient: fakePublicClient,
        profile: fakeProfile,
        config: fakeConfig,
        logger: fakeLogger,
        accountLabel: "default",
      },
    );
    // Effective price for BUY = 2500 × 1.01 = 2525. Base = 5000/2525 ≈ 1.9802
    expect(r.status).toBe("success");
    expect(r.aggregator).toBe("paper");
    expect(r.txHash).toMatch(/^paper:\d+:\d+$/);
    expect(parseFloat(r.price)).toBeCloseTo(2525, 1);
    expect(parseFloat(r.baseAmount)).toBeCloseTo(1.9802, 3);
    expect(r.quoteAmount).toBe("5000");

    // Balance deltas: USDC down by 5000, WETH up by ~1.98.
    const usdc = getPaperBalance("default", "base", USDC);
    expect(parseFloat(usdc?.balance ?? "0")).toBeCloseTo(5_000, 2);
    const weth = getPaperBalance("default", "base", WETH);
    expect(parseFloat(weth?.balance ?? "0")).toBeCloseTo(1.9802, 3);

    // Journal row.
    const rows = listPaperTrades({});
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("buy");
    expect(rows[0].source_type).toBe("manual");
  });

  it("SELL: spends base, credits quote, applies worst-case slippage DOWN", async () => {
    setPaperBalance({ account: "default", chain: "base", token: WETH, decimals: 18, amount: "2" });
    const r = await executePaperTrade(
      {
        direction: "sell",
        base: WETH,
        quote: USDC,
        baseAmount: "2",
        slippageBps: 100, // 1%
        source: { type: "order", id: 42 },
      },
      {
        publicClient: fakePublicClient,
        profile: fakeProfile,
        config: fakeConfig,
        logger: fakeLogger,
        accountLabel: "default",
      },
    );
    // Effective price for SELL = 2500 × 0.99 = 2475. Quote = 2 × 2475 = 4950
    expect(parseFloat(r.price)).toBeCloseTo(2475, 1);
    expect(parseFloat(r.quoteAmount)).toBeCloseTo(4_950, 1);
    expect(r.baseAmount).toBe("2");

    // After: WETH 0, USDC ≈ 4950.
    expect(parseFloat(getPaperBalance("default", "base", WETH)?.balance ?? "999")).toBeCloseTo(0, 6);
    expect(parseFloat(getPaperBalance("default", "base", USDC)?.balance ?? "0")).toBeCloseTo(4_950, 1);
  });

  it("rejects when virtual input balance is insufficient", async () => {
    // No USDC seeded — BUY should reject.
    await expect(
      executePaperTrade(
        {
          direction: "buy",
          base: WETH,
          quote: USDC,
          quoteAmount: "100",
          source: { type: "manual", id: null },
        },
        {
          publicClient: fakePublicClient,
          profile: fakeProfile,
          config: fakeConfig,
          logger: fakeLogger,
          accountLabel: "default",
        },
      ),
    ).rejects.toMatchObject({ code: "PAPER_INSUFFICIENT_BALANCE" });

    // No journal row should have been written.
    expect(listPaperTrades({})).toHaveLength(0);
  });

  it("rejects PRICE_UNAVAILABLE when neither oracle returns a price", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "1000" });
    (getCurrentPrice as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      executePaperTrade(
        {
          direction: "buy",
          base: WETH,
          quote: USDC,
          quoteAmount: "100",
          source: { type: "manual", id: null },
        },
        {
          publicClient: fakePublicClient,
          profile: fakeProfile,
          config: fakeConfig,
          logger: fakeLogger,
          accountLabel: "default",
        },
      ),
    ).rejects.toMatchObject({ code: "PRICE_UNAVAILABLE" });
  });

  it("rejects when both baseAmount and quoteAmount are missing", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "1000" });
    await expect(
      executePaperTrade(
        {
          direction: "buy",
          base: WETH,
          quote: USDC,
          source: { type: "manual", id: null },
        },
        {
          publicClient: fakePublicClient,
          profile: fakeProfile,
          config: fakeConfig,
          logger: fakeLogger,
          accountLabel: "default",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("synthetic txHash carries paper-trade id", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "1000" });
    const r = await executePaperTrade(
      {
        direction: "buy",
        base: WETH,
        quote: USDC,
        quoteAmount: "100",
        source: { type: "manual", id: null },
      },
      {
        publicClient: fakePublicClient,
        profile: fakeProfile,
        config: fakeConfig,
        logger: fakeLogger,
        accountLabel: "default",
      },
    );
    expect(r.txHash.startsWith(`paper:${r.paperTradeId}:`)).toBe(true);
  });

  it("isolates virtual balances per account", async () => {
    setPaperBalance({ account: "alpha", chain: "base", token: USDC, decimals: 6, amount: "1000" });
    setPaperBalance({ account: "beta", chain: "base", token: USDC, decimals: 6, amount: "1000" });
    await executePaperTrade(
      {
        direction: "buy",
        base: WETH,
        quote: USDC,
        quoteAmount: "500",
        source: { type: "manual", id: null },
      },
      {
        publicClient: fakePublicClient,
        profile: fakeProfile,
        config: fakeConfig,
        logger: fakeLogger,
        accountLabel: "alpha",
      },
    );
    expect(parseFloat(getPaperBalance("alpha", "base", USDC)?.balance ?? "999")).toBeCloseTo(500, 2);
    expect(parseFloat(getPaperBalance("beta", "base", USDC)?.balance ?? "0")).toBeCloseTo(1_000, 2);
  });
});

// ── v125: paper-enforcement parity — the dry-run rejects where live would ──
describe("executePaperTrade — guardrail parity (v125)", () => {
  beforeEach(() => {
    (getToken as ReturnType<typeof vi.fn>).mockImplementation(async (_pc, _profile, addr: Address) => {
      if (addr.toLowerCase() === WETH.toLowerCase()) return mockToken(WETH, "WETH", 18);
      if (addr.toLowerCase() === USDC.toLowerCase()) return mockToken(USDC, "USDC", 6);
      throw new Error(`unknown token ${addr}`);
    });
    (getCurrentPrice as ReturnType<typeof vi.fn>).mockImplementation(async (addr: string) => {
      if (addr.toLowerCase() === WETH.toLowerCase()) return 2_500;
      if (addr.toLowerCase() === USDC.toLowerCase()) return 1;
      return null;
    });
  });

  const cfgSafe = (safety: Record<string, unknown>) =>
    ({ ...(fakeConfig as object), safety: { enabled: true, maxSlippageBps: 50, ...safety } }) as never;
  const ctxWith = (config: never) => ({
    publicClient: fakePublicClient, profile: fakeProfile, config, logger: fakeLogger, accountLabel: "default",
  });
  const buy = (quoteAmount: string, extra: Record<string, unknown> = {}) =>
    ({ direction: "buy" as const, base: WETH, quote: USDC, quoteAmount, source: { type: "manual" as const, id: null }, ...extra });

  it("rejects slippage over the cap, exactly like live", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "10000" });
    await expect(
      executePaperTrade(buy("5000", { slippageBps: 100 }), ctxWith(cfgSafe({ maxSlippageBps: 50 }))),
    ).rejects.toMatchObject({ code: "SLIPPAGE_TOO_HIGH" });
    expect(listPaperTrades({})).toHaveLength(0); // no virtual fill recorded
  });

  it("rejects a blacklisted token, exactly like live", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "10000" });
    await expect(
      executePaperTrade(buy("100"), ctxWith(cfgSafe({ maxSlippageBps: 5000, tokenBlacklist: { base: [WETH] } }))),
    ).rejects.toMatchObject({ code: "TOKEN_BLOCKED" });
  });

  it("rejects a token outside a configured whitelist, exactly like live", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "10000" });
    await expect(
      // Whitelist only USDC → buying WETH (not whitelisted) rejects.
      executePaperTrade(buy("100"), ctxWith(cfgSafe({ maxSlippageBps: 5000, tokenWhitelist: { base: [USDC] } }))),
    ).rejects.toMatchObject({ code: "TOKEN_BLOCKED" });
  });

  it("rejects a trade over the per-tx USD cap (priced by base USD, not raw quote)", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "10000" });
    // ~$4950 of WETH (2500 × ~1.98) vs a $1000 per-tx cap → rejects.
    await expect(
      executePaperTrade(buy("5000"), ctxWith(cfgSafe({ maxSlippageBps: 5000, perTxUsdLimit: 1000 }))),
    ).rejects.toMatchObject({ code: "AMOUNT_EXCEEDS_LIMIT" });
  });

  it("allows a trade within the per-tx cap", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "10000" });
    const r = await executePaperTrade(buy("5000"), ctxWith(cfgSafe({ maxSlippageBps: 5000, perTxUsdLimit: 10000 })));
    expect(r.status).toBe("success");
  });

  it("trips the strategy loss breaker on the virtual book (paper mode)", async () => {
    // Seed a losing round-trip for strategy "ls": buy 1 WETH @2500, sell @2000 → realized −$500.
    recordPaperTrade(samplePaperRow({ direction: "buy", strategy: "ls", base_amount: "1", quote_amount: "2500", price: "2500", timestamp: "2026-06-01T00:00:00Z" }));
    recordPaperTrade(samplePaperRow({ direction: "sell", strategy: "ls", base_amount: "1", quote_amount: "2000", price: "2000", timestamp: "2026-06-02T00:00:00Z" }));
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "10000" });
    // maxStrategyLossUsd=100; realized −500 ≤ −100 → new BUYS blocked.
    await expect(
      executePaperTrade(buy("100", { strategy: "ls" }), ctxWith(cfgSafe({ maxSlippageBps: 5000, maxStrategyLossUsd: 100 }))),
    ).rejects.toMatchObject({ code: "STRATEGY_LOSS_BREAKER_TRIPPED" });
  });

  it("loss breaker still ALLOWS sells (exit/recover), like live", async () => {
    recordPaperTrade(samplePaperRow({ direction: "buy", strategy: "ls", base_amount: "1", quote_amount: "2500", price: "2500", timestamp: "2026-06-01T00:00:00Z" }));
    recordPaperTrade(samplePaperRow({ direction: "sell", strategy: "ls", base_amount: "1", quote_amount: "2000", price: "2000", timestamp: "2026-06-02T00:00:00Z" }));
    setPaperBalance({ account: "default", chain: "base", token: WETH, decimals: 18, amount: "1" });
    const r = await executePaperTrade(
      { direction: "sell", base: WETH, quote: USDC, baseAmount: "1", strategy: "ls", source: { type: "manual", id: null } },
      ctxWith(cfgSafe({ maxSlippageBps: 5000, maxStrategyLossUsd: 100 })),
    );
    expect(r.status).toBe("success");
  });

  it("enforces nothing when safety is disabled (parity with live's master switch)", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "10000" });
    // Over-slippage + tiny per-tx cap, but safety.enabled=false → trade goes through.
    const r = await executePaperTrade(
      buy("5000", { slippageBps: 100 }),
      ctxWith({ ...(fakeConfig as object), safety: { enabled: false, maxSlippageBps: 50, perTxUsdLimit: 1 } } as never),
    );
    expect(r.status).toBe("success");
  });
});

// ── v126: cumulative-USD parity — daily-USD cap + strategy budget ──
//
// Closes the two windows deferred in v125. The dry-run must reject exactly where
// live's daily-USD cap (enforceSafety) and strategy budget (enforceStrategyBudget)
// would — valued off the paper_trades.value_usd column so non-stablecoin quotes
// are priced correctly, not under-counted ~1000× by the raw quote_amount.
describe("executePaperTrade — cumulative-USD parity (v126)", () => {
  beforeEach(() => {
    (getToken as ReturnType<typeof vi.fn>).mockImplementation(async (_pc, _profile, addr: Address) => {
      if (addr.toLowerCase() === WETH.toLowerCase()) return mockToken(WETH, "WETH", 18);
      if (addr.toLowerCase() === USDC.toLowerCase()) return mockToken(USDC, "USDC", 6);
      throw new Error(`unknown token ${addr}`);
    });
    (getCurrentPrice as ReturnType<typeof vi.fn>).mockImplementation(async (addr: string) => {
      if (addr.toLowerCase() === WETH.toLowerCase()) return 2_500;
      if (addr.toLowerCase() === USDC.toLowerCase()) return 1;
      return null;
    });
  });

  const cfgSafe = (safety: Record<string, unknown>) =>
    ({ ...(fakeConfig as object), safety: { enabled: true, maxSlippageBps: 5000, ...safety } }) as never;
  const ctxWith = (config: never) => ({
    publicClient: fakePublicClient, profile: fakeProfile, config, logger: fakeLogger, accountLabel: "default",
  });
  const buy = (quoteAmount: string, extra: Record<string, unknown> = {}) =>
    ({ direction: "buy" as const, base: WETH, quote: USDC, quoteAmount, source: { type: "manual" as const, id: null }, ...extra });

  // ── persistence: value_usd lands (and is NULL when unpriceable) ──

  it("persists value_usd ≈ baseUsd × baseAmount on the journal row", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "10000" });
    // buy 5000 USDC of WETH @ spot 2500, slippage 0 → exactly 2 WETH, value $5000.
    await executePaperTrade(buy("5000", { slippageBps: 0 }), ctxWith(cfgSafe({})));
    const rows = listPaperTrades({});
    expect(rows).toHaveLength(1);
    expect(rows[0].value_usd).not.toBeNull();
    // value_usd is quote-token-independent: baseUsd(2500) × baseAmount(2.0).
    expect(rows[0].value_usd!).toBeCloseTo(2_500 * parseFloat(rows[0].base_amount), 6);
    expect(rows[0].value_usd!).toBeCloseTo(5_000, 2);
  });

  it("records value_usd = NULL for legacy/backfill rows (omitted on insert)", () => {
    // executePaperTrade always has a priced base (resolveSpotPrice requires it),
    // so the unpriceable path is reached only by non-pricing callers (backfill /
    // import) that omit value_usd. The column stores NULL there, and consumers
    // fall back to quote_amount via sumUsdRows — symmetric with live legacy rows.
    const id = recordPaperTrade(samplePaperRow({ value_usd: undefined as unknown as null }));
    const row = listPaperTrades({}).find((r) => r.id === id)!;
    expect(row.value_usd).toBeNull();
    // And paperDailyUsdVolume folds it back to quote_amount (2500 here).
    expect(paperDailyUsdVolume("default", "base")).toBeCloseTo(2_500, 6);
  });

  // ── daily-USD cap boundary ──

  it("daily cap: cumulative + this trade == cap is ALLOWED", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "100000" });
    // Pre-seed $9000 of paper volume in the 24h window.
    recordPaperTrade(samplePaperRow({ value_usd: 9_000, quote_amount: "9000" }));
    // This trade ≈ $1000 → total exactly $10000 == cap → allowed.
    const r = await executePaperTrade(buy("1000"), ctxWith(cfgSafe({ dailyUsdLimit: 10_000 })));
    expect(r.status).toBe("success");
  });

  it("daily cap: one cent over the cap is REJECTED (AMOUNT_EXCEEDS_LIMIT, like live)", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "100000" });
    recordPaperTrade(samplePaperRow({ value_usd: 9_999.99, quote_amount: "9999.99" }));
    // This trade ≈ $1000 → total ≈ $10999.99 > $10000 cap → rejects.
    await expect(
      executePaperTrade(buy("1000"), ctxWith(cfgSafe({ dailyUsdLimit: 10_000 }))),
    ).rejects.toMatchObject({ code: "AMOUNT_EXCEEDS_LIMIT" });
    expect(listPaperTrades({})).toHaveLength(1); // only the pre-seeded row; no new fill
  });

  // ── non-stablecoin quote: the core regression guard ──

  it("REGRESSION: a WETH-quote fill is valued in USD, not by raw quote_amount", async () => {
    // Buy USDC with WETH as the quote token. base=USDC ($1), quote=WETH ($2500).
    // Spend 2 WETH (~$5000 of true value) → raw quote_amount ≈ 2, but value_usd
    // ≈ baseUsd(1) × baseAmount(~5000) ≈ $5000. A daily cap of $4000 must REJECT.
    // Pre-fix (summing raw quote_amount ≈ 2) this would have been ALLOWED.
    setPaperBalance({ account: "default", chain: "base", token: WETH, decimals: 18, amount: "100" });
    await expect(
      executePaperTrade(
        { direction: "buy", base: USDC, quote: WETH, quoteAmount: "2", slippageBps: 0, source: { type: "manual", id: null } },
        ctxWith(cfgSafe({ dailyUsdLimit: 4_000 })),
      ),
    ).rejects.toMatchObject({ code: "AMOUNT_EXCEEDS_LIMIT" });
    expect(listPaperTrades({})).toHaveLength(0);

    // Same fill under a $6000 cap → allowed, and the recorded value_usd ≈ $5000
    // (NOT ≈ 2, which is what a raw-quote_amount accounting would have stored).
    const r = await executePaperTrade(
      { direction: "buy", base: USDC, quote: WETH, quoteAmount: "2", slippageBps: 0, source: { type: "manual", id: null } },
      ctxWith(cfgSafe({ dailyUsdLimit: 6_000 })),
    );
    expect(r.status).toBe("success");
    const row = listPaperTrades({})[0];
    expect(row.value_usd!).toBeCloseTo(5_000, 0);
    expect(parseFloat(row.quote_amount)).toBeCloseTo(2, 3); // raw quote stays small
  });

  // ── strategy budget: routed through the shared enforcer + paper spentLookup ──

  it("strategy budget: per-fire cap rejects (no DB lookup needed)", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "100000" });
    // perFire $1000; this trade ≈ $5000 → rejects without consulting the book.
    await expect(
      executePaperTrade(
        buy("5000", { strategy: "dca" }),
        ctxWith(cfgSafe({ strategyBudgets: [{ tag: "dca", perFireUsd: 1_000 }] })),
      ),
    ).rejects.toMatchObject({ code: "STRATEGY_BUDGET_EXCEEDED" });
  });

  it("strategy budget: lifetime cap counts prior paper fills via paperUsdSpentUnderStrategy", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "100000" });
    // Prior $9000 lifetime spend under "dca"; lifetime cap $10000.
    recordPaperTrade(samplePaperRow({ strategy: "dca", value_usd: 9_000, quote_amount: "9000" }));
    // This trade ≈ $5000 → lifetime would be ~$14000 > $10000 → rejects.
    await expect(
      executePaperTrade(
        buy("5000", { strategy: "dca" }),
        ctxWith(cfgSafe({ strategyBudgets: [{ tag: "dca", lifetimeUsd: 10_000 }] })),
      ),
    ).rejects.toMatchObject({ code: "STRATEGY_BUDGET_EXCEEDED" });
  });

  it("strategy budget: untagged trade is a no-op (no rule matches)", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "100000" });
    // No strategy tag → budget short-circuits even with a tiny cap configured.
    const r = await executePaperTrade(
      buy("5000"),
      ctxWith(cfgSafe({ strategyBudgets: [{ tag: "dca", perFireUsd: 1 }] })),
    );
    expect(r.status).toBe("success");
  });

  // ── parity: same params reject in both eras ──

  it("parity: a trade over the daily cap rejects in paper exactly as live's enforceDailyUsdLimit does", async () => {
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "100000" });
    recordPaperTrade(samplePaperRow({ value_usd: 9_000, quote_amount: "9000" }));
    const cfg = cfgSafe({ dailyUsdLimit: 10_000 });
    // Paper path rejects.
    await expect(
      executePaperTrade(buy("5000"), ctxWith(cfg)),
    ).rejects.toMatchObject({ code: "AMOUNT_EXCEEDS_LIMIT" });
    // Live ENFORCEMENT (same function executePaperTrade calls), driven directly
    // with the paper book's 24h volume, rejects on the same numbers → invariant
    // locked: dry-run rejects exactly where real would.
    const usedToday = paperDailyUsdVolume("default", "base");
    expect(() => enforceDailyUsdLimit(5_000, cfg, () => usedToday)).toThrow(/24h volume/);
  });
});

// ── helpers ─────────────────────────────────────────────────

function samplePaperRow(overrides: Partial<Parameters<typeof recordPaperTrade>[0]> = {}) {
  return {
    timestamp: new Date().toISOString(),
    source_type: "manual" as const,
    source_id: null,
    chain: "base",
    account: "default",
    direction: "buy" as const,
    base_token: WETH,
    base_symbol: "WETH",
    base_amount: "1",
    quote_token: USDC,
    quote_symbol: "USDC",
    quote_amount: "2500",
    price: "2500",
    slippage_bps: 50,
    strategy: null,
    notes: null,
    ...overrides,
  };
}
