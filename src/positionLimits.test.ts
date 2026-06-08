// Tests for portfolio-aware position limits. Pure-function coverage of:
//   - simulateDelta / applyDelta math
//   - limit matching (symbol / address / wildcard chain / native sentinel)
//   - evaluateLimits (caps, floors, multi-rule, edge cases)
//   - enforcePositionLimits async wrapper (with injected mock fetcher)
//
// No DB or RPC dependencies — every test is a deterministic value-in /
// value-out check.

import { describe, it, expect, vi } from "vitest";

import {
  deltaForSwap,
  deltaForTransfer,
  applyDelta,
  limitMatchesToken,
  evaluateLimits,
  enforcePositionLimits,
  chainHoldingsToSnapshot,
  type PositionLimit,
  type PortfolioSnapshot,
  type PortfolioToken,
  type TradeDelta,
} from "./positionLimits.js";
import type { ChainHoldings } from "./holdings.js";
import { configSchema } from "./config.js";
import type { Logger } from "./logger.js";

const stubLogger = (() => {
  const warns: string[] = [];
  const debugs: string[] = [];
  return {
    logger: {
      debug: (m: string) => debugs.push(m),
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
      recordAudit: () => {},
    } as unknown as Logger,
    warns,
    debugs,
  };
})();

// ── helpers ──────────────────────────────────────────────────

function tok(overrides: Partial<PortfolioToken> = {}): PortfolioToken {
  return {
    chain: "base",
    symbol: "USDC",
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    usd: 100,
    ...overrides,
  };
}

function snapshot(tokens: PortfolioToken[]): PortfolioSnapshot {
  let totalUsd = 0;
  let hasUnpriced = false;
  for (const t of tokens) {
    if (t.usd == null) hasUnpriced = true;
    else totalUsd += t.usd;
  }
  return { totalUsd, hasUnpriced, tokens };
}

// ── deltaForSwap ─────────────────────────────────────────────

describe("deltaForSwap", () => {
  const baseAddr = "0x4200000000000000000000000000000000000006" as `0x${string}`;
  const quoteAddr = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as `0x${string}`;

  it("buy adds estimatedUsd to base, subtracts from quote", () => {
    const d = deltaForSwap({
      chain: "base",
      direction: "buy",
      estimatedUsd: 100,
      baseAddress: baseAddr,
      baseIsNative: false,
      quoteAddress: quoteAddr,
    })!;
    expect(d.chain).toBe("base");
    expect(d.byAddress[baseAddr.toLowerCase()]).toBe(100);
    expect(d.byAddress[quoteAddr.toLowerCase()]).toBe(-100);
  });

  it("sell subtracts from base, adds to quote", () => {
    const d = deltaForSwap({
      chain: "base",
      direction: "sell",
      estimatedUsd: 100,
      baseAddress: baseAddr,
      baseIsNative: false,
      quoteAddress: quoteAddr,
    })!;
    expect(d.byAddress[baseAddr.toLowerCase()]).toBe(-100);
    expect(d.byAddress[quoteAddr.toLowerCase()]).toBe(100);
  });

  it("native base maps to 'NATIVE' key, not the address", () => {
    const d = deltaForSwap({
      chain: "base",
      direction: "buy",
      estimatedUsd: 50,
      baseAddress: "ETH",
      baseIsNative: true,
      quoteAddress: quoteAddr,
    })!;
    expect(d.byAddress["NATIVE"]).toBe(50);
    expect(d.byAddress[quoteAddr.toLowerCase()]).toBe(-50);
  });

  it("returns null on missing / invalid USD", () => {
    const args = {
      chain: "base",
      direction: "buy" as const,
      baseAddress: baseAddr,
      baseIsNative: false,
      quoteAddress: quoteAddr,
    };
    expect(deltaForSwap({ ...args, estimatedUsd: undefined })).toBeNull();
    expect(deltaForSwap({ ...args, estimatedUsd: null })).toBeNull();
    expect(deltaForSwap({ ...args, estimatedUsd: 0 })).toBeNull();
    expect(deltaForSwap({ ...args, estimatedUsd: Number.NaN })).toBeNull();
  });
});

// ── deltaForTransfer ─────────────────────────────────────────

describe("deltaForTransfer", () => {
  it("subtracts the transferred amount from the sent token", () => {
    const d = deltaForTransfer({
      chain: "base",
      estimatedUsd: 250,
      tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      tokenIsNative: false,
    })!;
    expect(d.byAddress["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]).toBe(-250);
  });

  it("native transfer maps to 'NATIVE'", () => {
    const d = deltaForTransfer({
      chain: "base",
      estimatedUsd: 25,
      tokenAddress: "ETH",
      tokenIsNative: true,
    })!;
    expect(d.byAddress["NATIVE"]).toBe(-25);
  });

  it("returns null on missing / invalid USD", () => {
    expect(deltaForTransfer({ chain: "base", estimatedUsd: undefined, tokenAddress: "ETH", tokenIsNative: true })).toBeNull();
    expect(deltaForTransfer({ chain: "base", estimatedUsd: -1, tokenAddress: "ETH", tokenIsNative: true })).toBeNull();
  });
});

// ── applyDelta ───────────────────────────────────────────────

describe("applyDelta", () => {
  it("updates an existing token's USD without mutating the input", () => {
    const before = snapshot([
      tok({ symbol: "ETH", address: "NATIVE", usd: 600 }),
      tok({ symbol: "USDC", address: "0xaaa", usd: 400 }),
    ]);
    const delta: TradeDelta = { chain: "base", byAddress: { NATIVE: 100, "0xaaa": -100 } };
    const after = applyDelta(before, delta);
    expect(after.tokens.find((t) => t.address === "NATIVE")!.usd).toBe(700);
    expect(after.tokens.find((t) => t.address === "0xaaa")!.usd).toBe(300);
    expect(after.totalUsd).toBe(1000);
    // Input unchanged.
    expect(before.tokens.find((t) => t.address === "NATIVE")!.usd).toBe(600);
  });

  it("appends a token introduced by the delta (bought a new asset)", () => {
    const before = snapshot([tok({ symbol: "USDC", address: "0xaaa", usd: 500 })]);
    const delta: TradeDelta = { chain: "base", byAddress: { "0xbbb": 100, "0xaaa": -100 } };
    const after = applyDelta(before, delta);
    expect(after.tokens.length).toBe(2);
    expect(after.tokens.find((t) => t.address === "0xbbb")!.usd).toBe(100);
  });

  it("clamps to ≥ 0 when a sell USD rounds slightly larger than the balance", () => {
    const before = snapshot([tok({ symbol: "USDC", address: "0xaaa", usd: 100 })]);
    const delta: TradeDelta = { chain: "base", byAddress: { "0xaaa": -101 } };
    const after = applyDelta(before, delta);
    expect(after.tokens.find((t) => t.address === "0xaaa")!.usd).toBe(0);
  });

  it("doesn't introduce a token when the delta is a negative for it (selling a token you don't hold)", () => {
    const before = snapshot([tok({ symbol: "USDC", address: "0xaaa", usd: 500 })]);
    const delta: TradeDelta = { chain: "base", byAddress: { "0xbbb": -50 } };
    const after = applyDelta(before, delta);
    expect(after.tokens.length).toBe(1);
  });

  it("delta on a different chain does NOT mutate the original chain's tokens", () => {
    const before = snapshot([
      tok({ chain: "base", symbol: "ETH", address: "NATIVE", usd: 100 }),
      tok({ chain: "arbitrum", symbol: "ETH", address: "NATIVE", usd: 50 }),
    ]);
    const delta: TradeDelta = { chain: "arbitrum", byAddress: { NATIVE: 20 } };
    const after = applyDelta(before, delta);
    expect(after.tokens.find((t) => t.chain === "base" && t.address === "NATIVE")!.usd).toBe(100);
    expect(after.tokens.find((t) => t.chain === "arbitrum" && t.address === "NATIVE")!.usd).toBe(70);
  });
});

// ── limitMatchesToken ────────────────────────────────────────

describe("limitMatchesToken", () => {
  const usdc = tok({ chain: "base", symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });

  it("exact chain + symbol match (case-insensitive)", () => {
    expect(limitMatchesToken({ chain: "base", token: "USDC" }, usdc)).toBe(true);
    expect(limitMatchesToken({ chain: "BASE", token: "usdc" }, usdc)).toBe(true);
  });

  it("wildcard chain matches any chain", () => {
    expect(limitMatchesToken({ chain: "*", token: "USDC" }, usdc)).toBe(true);
    expect(limitMatchesToken({ chain: "*", token: "USDC" }, { ...usdc, chain: "arbitrum" })).toBe(true);
  });

  it("chain mismatch rejects", () => {
    expect(limitMatchesToken({ chain: "arbitrum", token: "USDC" }, usdc)).toBe(false);
  });

  it("symbol mismatch rejects", () => {
    expect(limitMatchesToken({ chain: "base", token: "WBTC" }, usdc)).toBe(false);
  });

  it("address match (case-insensitive)", () => {
    expect(limitMatchesToken(
      { chain: "base", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      usdc,
    )).toBe(true);
  });

  it("0x-prefixed limit token uses ADDRESS match only (not symbol)", () => {
    // Same-shape symbol with a different address — must NOT match an
    // address-style limit unless addresses align.
    expect(limitMatchesToken(
      { chain: "base", token: "0x" + "0".repeat(40) },
      usdc,
    )).toBe(false);
  });

  it("native sentinel matches ETH / NATIVE / BNB / POL symbols", () => {
    const native = tok({ symbol: null, address: "NATIVE" });
    expect(limitMatchesToken({ chain: "base", token: "ETH" }, native)).toBe(true);
    expect(limitMatchesToken({ chain: "base", token: "NATIVE" }, native)).toBe(true);
    expect(limitMatchesToken({ chain: "bnb", token: "BNB" }, { ...native, chain: "bnb" })).toBe(true);
    expect(limitMatchesToken({ chain: "polygon", token: "POL" }, { ...native, chain: "polygon" })).toBe(true);
    expect(limitMatchesToken({ chain: "base", token: "USDC" }, native)).toBe(false);
  });
});

// ── evaluateLimits ───────────────────────────────────────────

describe("evaluateLimits", () => {
  // Common starting portfolio: 600 USDC + 400 ETH on base = $1000 total
  const start = snapshot([
    tok({ chain: "base", symbol: "USDC", address: "0xaaa", usd: 600 }),
    tok({ chain: "base", symbol: "ETH", address: "NATIVE", usd: 400 }),
  ]);

  it("no violations when predicted composition is within all bands", () => {
    const limits: PositionLimit[] = [
      { chain: "base", token: "ETH", maxPctOfPortfolio: 70 },
      { chain: "base", token: "USDC", minPctOfPortfolio: 10 },
    ];
    const predicted = applyDelta(start, { chain: "base", byAddress: { NATIVE: 100, "0xaaa": -100 } });
    // Predicted: 500 USDC + 500 ETH = 50/50.
    const { violations } = evaluateLimits(start, predicted, limits);
    expect(violations).toEqual([]);
  });

  it("max bound trips when buy pushes a token over the cap", () => {
    const limits: PositionLimit[] = [{ chain: "base", token: "ETH", maxPctOfPortfolio: 60 }];
    // Big ETH buy: +400 ETH → ETH=800, USDC=200, total=1000 → ETH=80%.
    const predicted = applyDelta(start, { chain: "base", byAddress: { NATIVE: 400, "0xaaa": -400 } });
    const { violations } = evaluateLimits(start, predicted, limits);
    expect(violations.length).toBe(1);
    expect(violations[0].violatedBound).toBe("max");
    expect(violations[0].boundValue).toBe(60);
    expect(violations[0].predictedPct).toBeCloseTo(80, 1);
    expect(violations[0].currentPct).toBeCloseTo(40, 1);
  });

  it("min bound trips when a sell drops the token below the floor", () => {
    const limits: PositionLimit[] = [{ chain: "base", token: "USDC", minPctOfPortfolio: 50 }];
    // Sell USDC for ETH: USDC=200, ETH=800 → USDC=20%.
    const predicted = applyDelta(start, { chain: "base", byAddress: { NATIVE: 400, "0xaaa": -400 } });
    const { violations } = evaluateLimits(start, predicted, limits);
    expect(violations.length).toBe(1);
    expect(violations[0].violatedBound).toBe("min");
    expect(violations[0].boundValue).toBe(50);
  });

  it("min violation suppressed when the floor is ALREADY breached pre-trade (won't deadlock)", () => {
    // Start: USDC at 20% (already below 50% floor). The trade buys more ETH —
    // makes USDC% lower BUT not the trade's fault that the floor was breached.
    // Still, the trade DOES make it worse, so evaluateLimits SHOULD fire.
    // The "no deadlock" rule only excuses trades that LEAVE composition equal
    // or improved. Let's verify both branches:
    const startSkewed = snapshot([
      tok({ chain: "base", symbol: "USDC", address: "0xaaa", usd: 200 }),
      tok({ chain: "base", symbol: "ETH", address: "NATIVE", usd: 800 }),
    ]);
    const limits: PositionLimit[] = [{ chain: "base", token: "USDC", minPctOfPortfolio: 50 }];

    // Case 1: buy MORE ETH — USDC% drops further. SHOULD fire.
    const worsening = applyDelta(startSkewed, { chain: "base", byAddress: { NATIVE: 50, "0xaaa": -50 } });
    expect(evaluateLimits(startSkewed, worsening, limits).violations.length).toBe(1);

    // Case 2: sell ETH for USDC — USDC% rises (still below 50% but improving).
    // SHOULD NOT fire (predicted >= current; we don't punish improving trades).
    const improving = applyDelta(startSkewed, { chain: "base", byAddress: { NATIVE: -50, "0xaaa": 50 } });
    expect(evaluateLimits(startSkewed, improving, limits).violations.length).toBe(0);
  });

  it("multi-chain wildcard caps sum across chains", () => {
    const multi = snapshot([
      tok({ chain: "base", symbol: "ETH", address: "NATIVE", usd: 300 }),
      tok({ chain: "arbitrum", symbol: "ETH", address: "NATIVE", usd: 300 }),
      tok({ chain: "base", symbol: "USDC", address: "0xaaa", usd: 400 }),
    ]);
    // Wildcard ETH cap at 50% — ETH total = 600 / 1000 = 60% → trips.
    const limits: PositionLimit[] = [{ chain: "*", token: "ETH", maxPctOfPortfolio: 50 }];
    // No trade — current = predicted. Should fire on the existing portfolio
    // only when the trade made it worse; here the trade is no-op.
    const noopDelta: TradeDelta = { chain: "base", byAddress: {} };
    const predicted = applyDelta(multi, noopDelta);
    // ETH already at 60%, no change. Max-bound trips on the PREDICTED value
    // — there's no "no-deadlock" rule for max bounds (they're protective
    // caps, not floors).
    const { violations } = evaluateLimits(multi, predicted, limits);
    expect(violations.length).toBe(1);
    expect(violations[0].predictedPct).toBeCloseTo(60, 1);
  });

  it("multiple violations stack into the violations[] array", () => {
    const limits: PositionLimit[] = [
      { chain: "base", token: "ETH", maxPctOfPortfolio: 30 }, // currently 40, would go to 80 → trips
      { chain: "base", token: "USDC", minPctOfPortfolio: 50 }, // currently 60, would go to 20 → trips
    ];
    const predicted = applyDelta(start, { chain: "base", byAddress: { NATIVE: 400, "0xaaa": -400 } });
    const { violations } = evaluateLimits(start, predicted, limits);
    expect(violations.length).toBe(2);
    const codes = violations.map((v) => `${v.limit.token}-${v.violatedBound}`).sort();
    expect(codes).toEqual(["ETH-max", "USDC-min"]);
  });

  it("zero-USD portfolio: only min-floor violations can fire (max never trips)", () => {
    const empty: PortfolioSnapshot = { totalUsd: 0, hasUnpriced: false, tokens: [] };
    const limits: PositionLimit[] = [
      { chain: "base", token: "USDC", minPctOfPortfolio: 10 },
      { chain: "base", token: "ETH", maxPctOfPortfolio: 50 },
    ];
    // Empty + empty delta → predicted is empty too. min stays at 0% which
    // is < 10, but our "no deadlock" rule says skip-when-not-worsening;
    // predicted == current (both 0) so we skip. So zero violations.
    const { violations } = evaluateLimits(empty, empty, limits);
    expect(violations).toEqual([]);
  });

  it("hasUnpricedPredicted is surfaced from the snapshot", () => {
    const unpriced: PortfolioSnapshot = {
      totalUsd: 500,
      hasUnpriced: true,
      tokens: [tok({ symbol: "USDC", address: "0xaaa", usd: 500 }), tok({ symbol: "UNKNOWN", address: "0xbbb", usd: null })],
    };
    const { hasUnpricedPredicted } = evaluateLimits(unpriced, unpriced, []);
    expect(hasUnpricedPredicted).toBe(true);
  });
});

// ── enforcePositionLimits ────────────────────────────────────

describe("enforcePositionLimits (async wrapper)", () => {
  function makeConfig(positionLimits?: PositionLimit[], failOnUnpriced = false) {
    return configSchema.parse({
      safety: {
        positionLimits,
        positionLimitsFailOnUnpriced: failOnUnpriced,
      },
    });
  }

  it("no-op when safety.positionLimits is undefined / empty", async () => {
    const fetcher = vi.fn();
    const violations = await enforcePositionLimits({
      chain: "base",
      delta: { chain: "base", byAddress: { NATIVE: 100 } },
      config: makeConfig(),
      logger: stubLogger.logger,
      fetchPortfolio: fetcher as never,
    });
    expect(violations).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("no-op when safety.enabled=false (even with limits configured)", async () => {
    const fetcher = vi.fn();
    const cfg = configSchema.parse({
      safety: {
        enabled: false,
        positionLimits: [{ chain: "base", token: "ETH", maxPctOfPortfolio: 50 }],
      },
    });
    const violations = await enforcePositionLimits({
      chain: "base",
      delta: { chain: "base", byAddress: { NATIVE: 100 } },
      config: cfg,
      logger: stubLogger.logger,
      fetchPortfolio: fetcher as never,
    });
    expect(violations).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("soft-skips when delta is null (unpriced trade)", async () => {
    const fetcher = vi.fn();
    const violations = await enforcePositionLimits({
      chain: "base",
      delta: null,
      config: makeConfig([{ chain: "base", token: "ETH", maxPctOfPortfolio: 50 }]),
      logger: stubLogger.logger,
      fetchPortfolio: fetcher as never,
    });
    expect(violations).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("filter-fast: doesn't fetch portfolio when no limit matches the trade's chain", async () => {
    const fetcher = vi.fn();
    const violations = await enforcePositionLimits({
      chain: "base",
      delta: { chain: "base", byAddress: { NATIVE: 100 } },
      config: makeConfig([{ chain: "arbitrum", token: "ETH", maxPctOfPortfolio: 50 }]),
      logger: stubLogger.logger,
      fetchPortfolio: fetcher as never,
    });
    expect(violations).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches portfolio + evaluates when limits apply", async () => {
    const portfolio: PortfolioSnapshot = {
      totalUsd: 1000,
      hasUnpriced: false,
      tokens: [
        { chain: "base", symbol: "ETH", address: "NATIVE", usd: 500 },
        { chain: "base", symbol: "USDC", address: "0xaaa", usd: 500 },
      ],
    };
    const fetcher = vi.fn(async () => portfolio);
    const violations = await enforcePositionLimits({
      chain: "base",
      delta: { chain: "base", byAddress: { NATIVE: 100, "0xaaa": -100 } },
      config: makeConfig([{ chain: "base", token: "ETH", maxPctOfPortfolio: 70 }]),
      logger: stubLogger.logger,
      fetchPortfolio: fetcher,
    });
    expect(violations).toEqual([]); // ETH would be 60%, under the 70% cap
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("throws POSITION_LIMIT_EXCEEDED with structured details on violation", async () => {
    const portfolio: PortfolioSnapshot = {
      totalUsd: 1000,
      hasUnpriced: false,
      tokens: [
        { chain: "base", symbol: "ETH", address: "NATIVE", usd: 500 },
        { chain: "base", symbol: "USDC", address: "0xaaa", usd: 500 },
      ],
    };
    const promise = enforcePositionLimits({
      chain: "base",
      delta: { chain: "base", byAddress: { NATIVE: 300, "0xaaa": -300 } }, // ETH → 80%
      config: makeConfig([{ chain: "base", token: "ETH", maxPctOfPortfolio: 70 }]),
      logger: stubLogger.logger,
      fetchPortfolio: async () => portfolio,
    });
    await expect(promise).rejects.toMatchObject({
      code: "POSITION_LIMIT_EXCEEDED",
      details: {
        chain: "base",
        token: "ETH",
        violatedBound: "max",
        boundValue: 70,
      },
    });
  });

  it("soft-skips on portfolio fetch failure by default", async () => {
    const violations = await enforcePositionLimits({
      chain: "base",
      delta: { chain: "base", byAddress: { NATIVE: 100 } },
      config: makeConfig([{ chain: "base", token: "ETH", maxPctOfPortfolio: 50 }]),
      logger: stubLogger.logger,
      fetchPortfolio: async () => { throw new Error("RPC down"); },
    });
    expect(violations).toEqual([]);
  });

  it("hard-fails on portfolio fetch failure when failOnUnpriced=true", async () => {
    const promise = enforcePositionLimits({
      chain: "base",
      delta: { chain: "base", byAddress: { NATIVE: 100 } },
      config: makeConfig([{ chain: "base", token: "ETH", maxPctOfPortfolio: 50 }], true),
      logger: stubLogger.logger,
      fetchPortfolio: async () => { throw new Error("RPC down"); },
    });
    await expect(promise).rejects.toMatchObject({
      code: "POSITION_LIMIT_EXCEEDED",
      details: { reason: "portfolio_fetch_failed" },
    });
  });

  it("integrates end-to-end with a holdings-shaped fetcher (chainHoldingsToSnapshot)", async () => {
    const holdings: ChainHoldings = {
      chain: "base",
      chainId: 8453,
      address: "0x0000000000000000000000000000000000000001",
      timestamp: new Date().toISOString(),
      balances: [
        // Native ETH balance
        { symbol: "ETH", token: "NATIVE", amount: "0.5", decimals: 18, usd: 1000 },
        // ERC20 USDC
        { symbol: "USDC", token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount: "200", decimals: 6, usd: 200 },
        // Dust — filtered out
        { symbol: "DUST", token: "0x000000000000000000000000000000000000dead", amount: "0", decimals: 18 },
      ],
      totalUsd: 1200,
    };
    const fetcher = async () => chainHoldingsToSnapshot([holdings]);
    // ETH currently 1000/1200 = 83.3%; cap is 90%, so passes.
    const violations = await enforcePositionLimits({
      chain: "base",
      delta: { chain: "base", byAddress: { NATIVE: 0 } }, // no-op delta
      config: makeConfig([{ chain: "base", token: "ETH", maxPctOfPortfolio: 90 }]),
      logger: stubLogger.logger,
      fetchPortfolio: fetcher,
    });
    expect(violations).toEqual([]);

    // Tighter cap at 70% — currently 83.3% which already exceeds. The cap
    // fires on the predicted (same as current here). Hard violation.
    await expect(
      enforcePositionLimits({
        chain: "base",
        delta: { chain: "base", byAddress: { NATIVE: 0 } },
        config: makeConfig([{ chain: "base", token: "ETH", maxPctOfPortfolio: 70 }]),
        logger: stubLogger.logger,
        fetchPortfolio: fetcher,
      }),
    ).rejects.toMatchObject({
      code: "POSITION_LIMIT_EXCEEDED",
      details: { token: "ETH", violatedBound: "max", boundValue: 70 },
    });
  });

  it("hard-fails on unpriced PORTFOLIO when failOnUnpriced=true", async () => {
    const portfolio: PortfolioSnapshot = {
      totalUsd: 500,
      hasUnpriced: true,
      tokens: [
        { chain: "base", symbol: "USDC", address: "0xaaa", usd: 500 },
        { chain: "base", symbol: "UNKNOWN", address: "0xbbb", usd: null },
      ],
    };
    const promise = enforcePositionLimits({
      chain: "base",
      delta: { chain: "base", byAddress: { NATIVE: 100 } },
      config: makeConfig([{ chain: "base", token: "ETH", maxPctOfPortfolio: 50 }], true),
      logger: stubLogger.logger,
      fetchPortfolio: async () => portfolio,
    });
    await expect(promise).rejects.toMatchObject({
      code: "POSITION_LIMIT_EXCEEDED",
      details: { reason: "portfolio_unpriced" },
    });
  });
});
