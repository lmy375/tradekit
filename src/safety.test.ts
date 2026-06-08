// Tests for safety.ts — the gate that every swap/transfer/approve passes through.
// These pin the contract that an agent's `SAFEGUARD_TRIGGERED`-handling code relies on.

import { describe, it, expect } from "vitest";
import { configSchema, type Config } from "./config.js";
import { enforceSafety, enforceApprovalSafety, enforcePreflightSafety, enforcePreflightApprovalSafety, enforceGasBudget, enforceRateLimit } from "./safety.js";
import { ToolError } from "./errors.js";
import { maxUint256, type Address } from "viem";

// A no-op logger that satisfies the Logger interface without writing to disk.
const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  recordTrade: () => 0,
  readRecentTrades: () => [],
  recordAudit: () => 0,
  close: () => {},
};

function makeConfig(overrides: Partial<Config["safety"]> = {}): Config {
  return configSchema.parse({
    safety: { enabled: true, maxSlippageBps: 500, allowInfiniteApprovals: false, ...overrides },
  });
}

// Assert that `fn` throws a ToolError with the given code. Cleaner than .toThrow(regex)
// against a message — codes are the stable contract that agents branch on.
function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect((e as ToolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ToolError with code=${code}, but no error was thrown`);
}

const USDC = "0xa0b86991c6218b36c1d19D4a2e9eb0cE3606eB48" as Address;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
const RANDOM = "0x1234567890123456789012345678901234567890" as Address;

describe("enforceSafety (swap path)", () => {
  it("does nothing when safety.enabled = false", () => {
    const cfg = makeConfig({ enabled: false });
    expect(() =>
      enforceSafety(
        { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: ROUTER, slippageBps: 9999 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("rejects slippage above the cap with SLIPPAGE_TOO_HIGH + next_actions hint", () => {
    const cfg = makeConfig({ maxSlippageBps: 100 });
    try {
      enforceSafety(
        { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: ROUTER, slippageBps: 500 },
        cfg,
        stubLogger,
      );
      expect.fail("should have thrown");
    } catch (e) {
      const te = e as ToolError;
      expect(te.code).toBe("SLIPPAGE_TOO_HIGH");
      expect(te.details).toMatchObject({ requested: 500, cap: 100 });
      expect(te.nextActions?.[0].params).toMatchObject({ slippageBps: 100 });
    }
  });

  it("blocks blacklisted token (either side)", () => {
    const cfg = makeConfig({ tokenBlacklist: { base: [USDC] } });
    expectCode(
      () =>
        enforceSafety(
          { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: ROUTER, slippageBps: 50 },
          cfg,
          stubLogger,
        ),
      "TOKEN_BLOCKED",
    );
    expectCode(
      () =>
        enforceSafety(
          { chain: "base", account: "a", tokenIn: WETH, tokenOut: USDC, toContract: ROUTER, slippageBps: 50 },
          cfg,
          stubLogger,
        ),
      "TOKEN_BLOCKED",
    );
  });

  it("whitelist rejects unlisted token, allows listed ones", () => {
    const cfg = makeConfig({ tokenWhitelist: { base: [USDC, WETH] } });
    expect(() =>
      enforceSafety(
        { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: ROUTER, slippageBps: 50 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
    expectCode(
      () =>
        enforceSafety(
          { chain: "base", account: "a", tokenIn: USDC, tokenOut: RANDOM, toContract: ROUTER, slippageBps: 50 },
          cfg,
          stubLogger,
        ),
      "TOKEN_BLOCKED",
    );
  });

  it("contractWhitelist (when set + non-empty) restricts the router", () => {
    const cfg = makeConfig({ contractWhitelist: { base: [ROUTER] } });
    expect(() =>
      enforceSafety(
        { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: ROUTER, slippageBps: 50 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
    expectCode(
      () =>
        enforceSafety(
          { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: RANDOM, slippageBps: 50 },
          cfg,
          stubLogger,
        ),
      "CONTRACT_BLOCKED",
    );
  });

  it("contractWhitelist is bypassed for transfer recipients (iter318)", () => {
    // Regression: pre-iter318 transfer.ts's comment claimed transfers skipped
    // contractWhitelist, but the code didn't actually implement the skip. An operator
    // with contractWhitelist set for router safety would have transfers to arbitrary
    // EOA recipients rejected. The whitelist is for routers/spenders, not payees.
    const cfg = makeConfig({ contractWhitelist: { base: [ROUTER] } });
    expect(() =>
      enforceSafety(
        {
          chain: "base", account: "a", tokenIn: USDC, tokenOut: USDC,
          toContract: RANDOM, // NOT in whitelist — would block for a swap
          slippageBps: 0,
          isTransferRecipient: true, // … but transfers bypass the whitelist
        },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("perTxUsdLimit blocks oversized trades with AMOUNT_EXCEEDS_LIMIT", () => {
    const cfg = makeConfig({ perTxUsdLimit: 100 });
    try {
      enforceSafety(
        { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: ROUTER, slippageBps: 50, estimatedUsd: 500 },
        cfg,
        stubLogger,
      );
      expect.fail("should have thrown");
    } catch (e) {
      const te = e as ToolError;
      expect(te.code).toBe("AMOUNT_EXCEEDS_LIMIT");
      expect(te.details).toMatchObject({ estimatedUsd: 500, perTxUsdLimit: 100 });
      // Iter307: nextAction suggests reducing/splitting (NOT raising the limit — that
      // would defeat the safety the operator opted into).
      expect(te.nextActions?.[0].reason).toMatch(/reduce|split/i);
      expect(te.nextActions?.[0].reason).not.toMatch(/raise|increase.*limit/i);
    }
  });

  it("perTxUsdLimit passes when estimate is null/below cap", () => {
    const cfg = makeConfig({ perTxUsdLimit: 100 });
    expect(() =>
      enforceSafety(
        { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: ROUTER, slippageBps: 50, estimatedUsd: 50 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
    // estimatedUsd missing → limit skipped
    expect(() =>
      enforceSafety(
        { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: ROUTER, slippageBps: 50 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("warns loudly when estimatedUsd is null AND USD limits are configured (iter70 bypass-visibility)", () => {
    // Without this warning a brand-new token with no DexScreener listing slides past
    // BOTH the per-tx and daily USD caps with zero operator-visible signal. Operators
    // running `tradekit logs` should see this fire.
    const warnings: string[] = [];
    const watchLogger = { ...stubLogger, warn: (m: string) => warnings.push(m) };
    const cfg = makeConfig({ perTxUsdLimit: 100, dailyUsdLimit: 1000 });
    enforceSafety(
      // estimatedUsd intentionally omitted
      { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: ROUTER, slippageBps: 50 },
      cfg,
      watchLogger,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/USD pricing unavailable/i);
    expect(warnings[0]).toMatch(/NOT enforced/i);
  });

  it("does NOT warn when no USD limits are configured (warning would be noise)", () => {
    const warnings: string[] = [];
    const watchLogger = { ...stubLogger, warn: (m: string) => warnings.push(m) };
    // safety enabled but no perTxUsdLimit / dailyUsdLimit set
    const cfg = makeConfig();
    enforceSafety(
      { chain: "base", account: "a", tokenIn: USDC, tokenOut: WETH, toContract: ROUTER, slippageBps: 50 },
      cfg,
      watchLogger,
    );
    expect(warnings).toHaveLength(0);
  });
});

describe("enforceApprovalSafety", () => {
  it("blocks infinite approvals by default", () => {
    const cfg = makeConfig();
    expectCode(
      () =>
        enforceApprovalSafety(
          { chain: "base", token: USDC, spender: ROUTER, amount: maxUint256, decimals: 6 },
          cfg,
          stubLogger,
        ),
      "SAFEGUARD_TRIGGERED",
    );
  });

  it("allows infinite when allowInfiniteApprovals=true", () => {
    const cfg = makeConfig({ allowInfiniteApprovals: true });
    expect(() =>
      enforceApprovalSafety(
        { chain: "base", token: USDC, spender: ROUTER, amount: maxUint256, decimals: 6 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("allows infinite when override=true (per-call)", () => {
    const cfg = makeConfig();
    expect(() =>
      enforceApprovalSafety(
        { chain: "base", token: USDC, spender: ROUTER, amount: maxUint256, decimals: 6, override: true },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("blocks blacklisted token even on approve", () => {
    const cfg = makeConfig({ tokenBlacklist: { base: [USDC] } });
    expectCode(
      () =>
        enforceApprovalSafety(
          { chain: "base", token: USDC, spender: ROUTER, amount: 100n, decimals: 6 },
          cfg,
          stubLogger,
        ),
      "TOKEN_BLOCKED",
    );
  });

  it("enforces contractWhitelist on spender", () => {
    const cfg = makeConfig({ contractWhitelist: { base: [ROUTER] } });
    expect(() =>
      enforceApprovalSafety(
        { chain: "base", token: USDC, spender: ROUTER, amount: 100n, decimals: 6 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
    expectCode(
      () =>
        enforceApprovalSafety(
          { chain: "base", token: USDC, spender: RANDOM, amount: 100n, decimals: 6 },
          cfg,
          stubLogger,
        ),
      "CONTRACT_BLOCKED",
    );
  });

  it("case-insensitive chain key lookup (iter96 — user hand-edits config with 'Base')", () => {
    // input.chain is always canonical lowercase from profile.name. But a user who
    // hand-edits the JSON config might write "Base", "Arbitrum", etc. — without the
    // chainLookup helper, those entries would be silently ignored at safety-check
    // time, defeating their purpose.
    const cfg = configSchema.parse({
      safety: {
        enabled: true,
        maxSlippageBps: 500,
        allowInfiniteApprovals: false,
        // Capital B — exactly the case a hand-editor might pick.
        tokenBlacklist: { Base: [USDC] },
      },
    });
    expectCode(
      () =>
        enforceApprovalSafety(
          { chain: "base", token: USDC, spender: ROUTER, amount: 1n, decimals: 6 },
          cfg,
          stubLogger,
        ),
      "TOKEN_BLOCKED",
    );
  });

  it("blocks when approval USD value exceeds maxApprovalUsdLimit", () => {
    const cfg = makeConfig({ maxApprovalUsdLimit: 50 });
    expectCode(
      () =>
        enforceApprovalSafety(
          { chain: "base", token: USDC, spender: ROUTER, amount: 1_000_000_000n, decimals: 6, tokenUsdPrice: 1 },
          cfg,
          stubLogger,
        ),
      "AMOUNT_EXCEEDS_LIMIT",
    );
    // 10 USDC at $1 = $10 (well under)
    expect(() =>
      enforceApprovalSafety(
        { chain: "base", token: USDC, spender: ROUTER, amount: 10_000_000n, decimals: 6, tokenUsdPrice: 1 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("maxApprovalUsdLimit error includes resize-to-fit hint (iter308)", () => {
    // 1000 USDC at $1 = $1000, cap $50 → agent should see the max-allowed amount.
    const cfg = makeConfig({ maxApprovalUsdLimit: 50 });
    try {
      enforceApprovalSafety(
        { chain: "base", token: USDC, spender: ROUTER, amount: 1_000_000_000n, decimals: 6, tokenUsdPrice: 1 },
        cfg,
        stubLogger,
      );
      expect.fail("should have thrown");
    } catch (e) {
      const te = e as ToolError;
      // maxAllowedAmount = 50 / 1 = 50
      expect(te.details).toMatchObject({ maxAllowedAmount: expect.stringMatching(/^50/) });
      // nextAction's params.amount is ready to retry with
      expect(te.nextActions?.[0].tool).toBe("approve");
      expect((te.nextActions?.[0].params as { amount?: string } | undefined)?.amount).toMatch(/^50/);
      // Reason mentions the safe amount
      expect(te.nextActions?.[0].reason).toMatch(/50/);
    }
  });
});

// Iter421: enforcePreflightSafety (iter405) and enforcePreflightApprovalSafety (iter413)
// are the cheap-check subsets that trade.ts (iter403/404), transfer.ts (iter412),
// and approvals.ts (iter413) call BEFORE the aggregator / price-lookup HTTP roundtrip.
// They MUST NOT trigger the post-flight checks (contract whitelist, per-tx USD,
// daily USD, approval USD cap) — those need info that's only available after the
// HTTP call. If a refactor moves a post-flight check into pre-flight, real trades
// could be rejected on transient checks (e.g., contract whitelist firing on the
// aggregator's freshly-chosen route before the operator has whitelisted it).
describe("enforcePreflightSafety (iter405 cheap-check subset)", () => {
  it("does the same slippage + token checks as enforceSafety", () => {
    // Slippage above cap
    expectCode(
      () =>
        enforcePreflightSafety(
          { chain: "base", tokenIn: USDC, tokenOut: WETH, slippageBps: 9999 },
          makeConfig({ maxSlippageBps: 100 }),
          stubLogger,
        ),
      "SLIPPAGE_TOO_HIGH",
    );
    // Blacklisted tokenIn
    expectCode(
      () =>
        enforcePreflightSafety(
          { chain: "base", tokenIn: USDC, tokenOut: WETH, slippageBps: 50 },
          makeConfig({ tokenBlacklist: { base: [USDC] } }),
          stubLogger,
        ),
      "TOKEN_BLOCKED",
    );
    // Whitelist miss on tokenOut
    expectCode(
      () =>
        enforcePreflightSafety(
          { chain: "base", tokenIn: USDC, tokenOut: WETH, slippageBps: 50 },
          makeConfig({ tokenWhitelist: { base: [USDC] } }),
          stubLogger,
        ),
      "TOKEN_BLOCKED",
    );
  });

  it("does NOT check contract whitelist (toContract isn't in the pre-flight Pick<>)", () => {
    // Even with a contract whitelist that would block ROUTER post-flight, the
    // pre-flight signature doesn't accept toContract at all, so this can't fire.
    // Verifies by passing config that would otherwise trigger CONTRACT_BLOCKED.
    const cfg = makeConfig({ contractWhitelist: { base: [RANDOM] } }); // ROUTER not in list
    expect(() =>
      enforcePreflightSafety(
        { chain: "base", tokenIn: USDC, tokenOut: WETH, slippageBps: 50 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("no-ops cleanly when safety.enabled = false", () => {
    const cfg = makeConfig({ enabled: false, maxSlippageBps: 1, tokenBlacklist: { base: [USDC] } });
    // Both slippage AND blacklist would trip if enabled; enabled=false short-circuits.
    expect(() =>
      enforcePreflightSafety(
        { chain: "base", tokenIn: USDC, tokenOut: WETH, slippageBps: 9999 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });
});

describe("enforcePreflightApprovalSafety (iter413 cheap-check subset)", () => {
  it("checks token blacklist + spender whitelist + infinite-approval gate", () => {
    // Token blacklist
    expectCode(
      () =>
        enforcePreflightApprovalSafety(
          { chain: "base", token: USDC, spender: ROUTER, amount: 100n },
          makeConfig({ tokenBlacklist: { base: [USDC] } }),
          stubLogger,
        ),
      "TOKEN_BLOCKED",
    );
    // Spender (contract) whitelist miss
    expectCode(
      () =>
        enforcePreflightApprovalSafety(
          { chain: "base", token: USDC, spender: ROUTER, amount: 100n },
          makeConfig({ contractWhitelist: { base: [RANDOM] } }),
          stubLogger,
        ),
      "CONTRACT_BLOCKED",
    );
    // Infinite-approval gate
    expectCode(
      () =>
        enforcePreflightApprovalSafety(
          { chain: "base", token: USDC, spender: ROUTER, amount: maxUint256 },
          makeConfig(),
          stubLogger,
        ),
      "SAFEGUARD_TRIGGERED",
    );
  });

  it("does NOT check approval USD cap (no tokenUsdPrice/decimals in pre-flight Pick<>)", () => {
    // Approval cap can only be evaluated after the price lookup. Verifies pre-flight
    // doesn't fire AMOUNT_EXCEEDS_LIMIT even when the cap would clearly be exceeded
    // post-flight (e.g., 1 quadrillion units of a $1-priced token).
    const cfg = makeConfig({ maxApprovalUsdLimit: 50 });
    expect(() =>
      enforcePreflightApprovalSafety(
        { chain: "base", token: USDC, spender: ROUTER, amount: 1_000_000_000_000_000n },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("override=true bypasses the infinite gate", () => {
    expect(() =>
      enforcePreflightApprovalSafety(
        { chain: "base", token: USDC, spender: ROUTER, amount: maxUint256, override: true },
        makeConfig(),
        stubLogger,
      ),
    ).not.toThrow();
  });
});

// ── enforceGasBudget (iter620) ────────────────────────────────

describe("enforceGasBudget (iter620)", () => {
  it("does nothing when safety.enabled = false", () => {
    const cfg = makeConfig({ enabled: false, gas: { maxGasPctOfTrade: 1 } });
    expect(() =>
      enforceGasBudget(
        { chain: "base", estimatedGasNative: 100, estimatedGasUsd: 100, estimatedTradeUsd: 100 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("does nothing when safety.gas is undefined (default)", () => {
    const cfg = makeConfig({});
    expect(() =>
      enforceGasBudget(
        { chain: "base", estimatedGasNative: 100, estimatedGasUsd: 100, estimatedTradeUsd: 100 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("throws GAS_BUDGET_EXCEEDED when absolute native cap is exceeded", () => {
    const cfg = makeConfig({ gas: { maxGasNativePerChain: { base: 0.005 } } });
    expectCode(
      () =>
        enforceGasBudget(
          { chain: "base", estimatedGasNative: 0.01, estimatedGasUsd: 30, estimatedTradeUsd: 100 },
          cfg,
          stubLogger,
        ),
      "GAS_BUDGET_EXCEEDED",
    );
  });

  it("passes when absolute native cap is not exceeded", () => {
    const cfg = makeConfig({ gas: { maxGasNativePerChain: { base: 0.01 } } });
    expect(() =>
      enforceGasBudget(
        { chain: "base", estimatedGasNative: 0.005, estimatedGasUsd: 15, estimatedTradeUsd: 100 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("throws GAS_BUDGET_EXCEEDED when gas-pct-of-trade exceeds cap", () => {
    const cfg = makeConfig({ gas: { maxGasPctOfTrade: 10 } });
    expectCode(
      () =>
        enforceGasBudget(
          { chain: "base", estimatedGasNative: 0.01, estimatedGasUsd: 20, estimatedTradeUsd: 100 },
          cfg,
          stubLogger,
        ),
      "GAS_BUDGET_EXCEEDED",
    );
  });

  it("passes when gas-pct-of-trade is under the cap", () => {
    const cfg = makeConfig({ gas: { maxGasPctOfTrade: 30 } });
    expect(() =>
      enforceGasBudget(
        { chain: "base", estimatedGasNative: 0.001, estimatedGasUsd: 5, estimatedTradeUsd: 100 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("skips pct check when USD prices are unavailable (but logs a warn)", () => {
    let warnCalled = false;
    const logger = { ...stubLogger, warn: () => { warnCalled = true; } };
    const cfg = makeConfig({ gas: { maxGasPctOfTrade: 1 } });
    expect(() =>
      enforceGasBudget(
        { chain: "base", estimatedGasNative: 0.01 },
        cfg,
        logger,
      ),
    ).not.toThrow();
    expect(warnCalled).toBe(true);
  });

  it("absolute-native cap still fires when USD prices are unavailable", () => {
    const cfg = makeConfig({ gas: { maxGasNativePerChain: { base: 0.005 } } });
    expectCode(
      () =>
        enforceGasBudget(
          { chain: "base", estimatedGasNative: 0.01 },
          cfg,
          stubLogger,
        ),
      "GAS_BUDGET_EXCEEDED",
    );
  });

  it("zero trade USD avoids divide-by-zero (silently skips pct check)", () => {
    const cfg = makeConfig({ gas: { maxGasPctOfTrade: 10 } });
    expect(() =>
      enforceGasBudget(
        { chain: "base", estimatedGasNative: 0.01, estimatedGasUsd: 20, estimatedTradeUsd: 0 },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("error details include the actual pct so an agent can resize", () => {
    const cfg = makeConfig({ gas: { maxGasPctOfTrade: 5 } });
    try {
      enforceGasBudget(
        { chain: "base", estimatedGasNative: 0.01, estimatedGasUsd: 25, estimatedTradeUsd: 100 },
        cfg,
        stubLogger,
      );
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("GAS_BUDGET_EXCEEDED");
      expect(err.details).toMatchObject({
        actualPct: 25,
        maxGasPctOfTrade: 5,
        reason: "pct_of_trade_cap",
      });
    }
  });

  it("error nextActions point at `quote` for agent retry path", () => {
    const cfg = makeConfig({ gas: { maxGasNativePerChain: { base: 0.001 } } });
    try {
      enforceGasBudget(
        { chain: "base", estimatedGasNative: 0.01 },
        cfg,
        stubLogger,
      );
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ToolError;
      expect(err.nextActions?.[0].tool).toBe("quote");
    }
  });
});

// ── enforceRateLimit (iter633) ─────────────────────────────────

describe("enforceRateLimit (iter633)", () => {
  const NOW = Date.parse("2026-05-29T12:00:00Z");

  it("does nothing when safety.enabled = false", () => {
    const cfg = makeConfig({ enabled: false, minTradeIntervalMs: 60_000 });
    expect(() =>
      enforceRateLimit(
        {
          account: "a",
          lastTradeTimestamp: new Date(NOW - 1000).toISOString(),
          nowMs: NOW,
        },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("does nothing when minTradeIntervalMs is undefined (default)", () => {
    const cfg = makeConfig();
    expect(() =>
      enforceRateLimit(
        {
          account: "a",
          lastTradeTimestamp: new Date(NOW - 100).toISOString(),
          nowMs: NOW,
        },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("does nothing when minTradeIntervalMs is 0 (explicit no-limit)", () => {
    const cfg = makeConfig({ minTradeIntervalMs: 0 });
    expect(() =>
      enforceRateLimit(
        {
          account: "a",
          lastTradeTimestamp: new Date(NOW).toISOString(),
          nowMs: NOW,
        },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("passes when there is no prior trade", () => {
    const cfg = makeConfig({ minTradeIntervalMs: 60_000 });
    expect(() =>
      enforceRateLimit(
        { account: "a", lastTradeTimestamp: null, nowMs: NOW },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("passes when elapsed >= minInterval", () => {
    const cfg = makeConfig({ minTradeIntervalMs: 60_000 });
    expect(() =>
      enforceRateLimit(
        {
          account: "a",
          lastTradeTimestamp: new Date(NOW - 60_000).toISOString(),
          nowMs: NOW,
        },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });

  it("throws SAFEGUARD_TRIGGERED when elapsed < minInterval", () => {
    const cfg = makeConfig({ minTradeIntervalMs: 60_000 });
    expectCode(
      () =>
        enforceRateLimit(
          {
            account: "a",
            lastTradeTimestamp: new Date(NOW - 1000).toISOString(),
            nowMs: NOW,
          },
          cfg,
          stubLogger,
        ),
      "SAFEGUARD_TRIGGERED",
    );
  });

  it("error details include reason + elapsedMs + waitMs for agent retry math", () => {
    const cfg = makeConfig({ minTradeIntervalMs: 60_000 });
    try {
      enforceRateLimit(
        {
          account: "alice",
          chain: "base",
          lastTradeTimestamp: new Date(NOW - 10_000).toISOString(),
          nowMs: NOW,
        },
        cfg,
        stubLogger,
      );
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("SAFEGUARD_TRIGGERED");
      expect(err.details).toMatchObject({
        reason: "rate_limited",
        account: "alice",
        chain: "base",
        elapsedMs: 10_000,
        minTradeIntervalMs: 60_000,
        waitMs: 50_000,
      });
    }
  });

  it("nextActions point at quote (agent should re-quote after cooldown)", () => {
    const cfg = makeConfig({ minTradeIntervalMs: 60_000 });
    try {
      enforceRateLimit(
        {
          account: "a",
          lastTradeTimestamp: new Date(NOW - 100).toISOString(),
          nowMs: NOW,
        },
        cfg,
        stubLogger,
      );
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ToolError;
      expect(err.nextActions?.[0].tool).toBe("quote");
    }
  });

  it("malformed timestamp is logged and skipped (doesn't block trades)", () => {
    const cfg = makeConfig({ minTradeIntervalMs: 60_000 });
    let warned = false;
    const logger = { ...stubLogger, warn: () => { warned = true; } };
    expect(() =>
      enforceRateLimit(
        {
          account: "a",
          lastTradeTimestamp: "not-a-timestamp",
          nowMs: NOW,
        },
        cfg,
        logger,
      ),
    ).not.toThrow();
    expect(warned).toBe(true);
  });

  it("future-dated timestamp (clock skew) is logged and skipped", () => {
    const cfg = makeConfig({ minTradeIntervalMs: 60_000 });
    let warned = false;
    const logger = { ...stubLogger, warn: () => { warned = true; } };
    expect(() =>
      enforceRateLimit(
        {
          account: "a",
          lastTradeTimestamp: new Date(NOW + 100_000).toISOString(),
          nowMs: NOW,
        },
        cfg,
        logger,
      ),
    ).not.toThrow();
    expect(warned).toBe(true);
  });

  it("exactly-at-interval passes (off-by-one safety)", () => {
    const cfg = makeConfig({ minTradeIntervalMs: 60_000 });
    expect(() =>
      enforceRateLimit(
        {
          account: "a",
          lastTradeTimestamp: new Date(NOW - 60_000).toISOString(),
          nowMs: NOW,
        },
        cfg,
        stubLogger,
      ),
    ).not.toThrow();
  });
});
