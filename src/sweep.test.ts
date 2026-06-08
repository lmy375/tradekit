// Iter610: unit tests for classifyTokenForSweep — the pure filter logic of
// the sweep planner. The orchestrator (planSweep/executeSweep) needs HTTP +
// wallet signing and is covered by smoke tests; these unit tests pin every
// filter branch + the dual-match semantics for the exclude list so a
// regression in the filter matrix gets caught fast.

import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { classifyTokenForSweep } from "./sweep.js";
import type { TokenBalance } from "./holdings.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;

const usdcBalance = (overrides: Partial<TokenBalance> = {}): TokenBalance => ({
  symbol: "USDC",
  token: USDC,
  amount: "100",
  decimals: 6,
  usd: 100,
  ...overrides,
});

const nativeBalance = (overrides: Partial<TokenBalance> = {}): TokenBalance => ({
  symbol: "ETH",
  token: "NATIVE",
  amount: "0.5",
  decimals: 18,
  usd: 1500,
  ...overrides,
});

describe("classifyTokenForSweep (iter610)", () => {
  it("includes a non-zero priced token with no filters set", () => {
    const r = classifyTokenForSweep(usdcBalance(), {});
    expect(r.include).toBe(true);
    if (r.include) expect(r.reason).toBe("included");
  });

  it("skips zero-balance tokens (no point appearing in the plan)", () => {
    const r = classifyTokenForSweep(usdcBalance({ amount: "0", usd: 0 }), {});
    expect(r.include).toBe(false);
    if (!r.include) expect(r.reason).toBe("zero_balance");
  });

  it("zero balance is detected even with non-zero usd (rounding edge)", () => {
    // Defensive: a 0-amount balance with stale usd shouldn't pass.
    const r = classifyTokenForSweep(usdcBalance({ amount: "0", usd: 99 }), {});
    expect(r.include).toBe(false);
    if (!r.include) expect(r.reason).toBe("zero_balance");
  });

  it("skips NaN amounts (defensive against bad upstream data)", () => {
    const r = classifyTokenForSweep(usdcBalance({ amount: "not-a-number" }), {});
    expect(r.include).toBe(false);
    if (!r.include) expect(r.reason).toBe("zero_balance");
  });

  it("excludes tokens in the exclude list by SYMBOL (case-insensitive)", () => {
    const r = classifyTokenForSweep(usdcBalance(), { exclude: ["usdc"] });
    expect(r.include).toBe(false);
    if (!r.include) expect(r.reason).toBe("in_exclude_list");
  });

  it("excludes tokens in the exclude list by ADDRESS (case-insensitive)", () => {
    const r = classifyTokenForSweep(usdcBalance(), { exclude: [USDC.toLowerCase()] });
    expect(r.include).toBe(false);
    if (!r.include) expect(r.reason).toBe("in_exclude_list");
  });

  it("address match wins over symbol match (dual matching, both work)", () => {
    // Same address in mixed case as input — should still match.
    const mixed = USDC.toLowerCase().slice(0, 6) + USDC.slice(6, 12).toUpperCase() + USDC.slice(12);
    const r = classifyTokenForSweep(usdcBalance(), { exclude: [mixed] });
    expect(r.include).toBe(false);
  });

  it("native tokens match exclude with 'NATIVE' literal (lowercased)", () => {
    const r = classifyTokenForSweep(nativeBalance(), { exclude: ["NATIVE"] });
    expect(r.include).toBe(false);
    if (!r.include) expect(r.reason).toBe("in_exclude_list");
  });

  it("native exclude also works via symbol (e.g. 'ETH')", () => {
    const r = classifyTokenForSweep(nativeBalance(), { exclude: ["eth"] });
    expect(r.include).toBe(false);
  });

  it("skips tokens below minUsd threshold", () => {
    const r = classifyTokenForSweep(usdcBalance({ amount: "0.5", usd: 0.5 }), { minUsd: 10 });
    expect(r.include).toBe(false);
    if (!r.include) expect(r.reason).toBe("below_min_usd");
  });

  it("INCLUDES tokens with usd exactly equal to minUsd (>= semantic, not >)", () => {
    // Strict-less comparison: $10 against minUsd=10 is included (no off-by-one).
    const r = classifyTokenForSweep(usdcBalance({ amount: "10", usd: 10 }), { minUsd: 10 });
    expect(r.include).toBe(true);
  });

  it("unpriced + minUsd: defaults to INCLUDE (lets operator see the token)", () => {
    // No price + minUsd filter present + excludeUnpriced NOT set: include with
    // a reason that names the special case. The alternative (silent exclude)
    // would hide unpriced positions the operator might care about.
    const r = classifyTokenForSweep(usdcBalance({ usd: undefined }), { minUsd: 50 });
    expect(r.include).toBe(true);
    if (r.include) expect(r.reason).toMatch(/no price data/);
  });

  it("unpriced + excludeUnpriced=true: skips with 'no_price_data' reason", () => {
    const r = classifyTokenForSweep(usdcBalance({ usd: undefined }), { excludeUnpriced: true });
    expect(r.include).toBe(false);
    if (!r.include) expect(r.reason).toBe("no_price_data");
  });

  it("unpriced + excludeUnpriced=true + minUsd: minUsd never gets a chance to fire", () => {
    // Precedence: excludeUnpriced is checked together with minUsd; either firing means skip.
    const r = classifyTokenForSweep(usdcBalance({ usd: undefined }), {
      minUsd: 100,
      excludeUnpriced: true,
    });
    expect(r.include).toBe(false);
    if (!r.include) expect(r.reason).toBe("no_price_data");
  });

  it("combining filters: minUsd + exclude, exclude wins for matching token", () => {
    // Both apply but exclude is checked FIRST in the order — match exits with
    // the exclude reason rather than minUsd.
    const r = classifyTokenForSweep(usdcBalance({ usd: 0.5 }), {
      minUsd: 100,
      exclude: ["USDC"],
    });
    expect(r.include).toBe(false);
    if (!r.include) expect(r.reason).toBe("in_exclude_list");
  });

  it("a high-value WETH balance with full filter stack still gets through", () => {
    const r = classifyTokenForSweep(
      { symbol: "WETH", token: WETH, amount: "1.5", decimals: 18, usd: 4500 },
      { minUsd: 50, exclude: ["USDC", "DAI"], excludeUnpriced: true },
    );
    expect(r.include).toBe(true);
  });

  it("minUsd=0 means no threshold (every priced token includes)", () => {
    const r = classifyTokenForSweep(usdcBalance({ amount: "0.01", usd: 0.01 }), { minUsd: 0 });
    expect(r.include).toBe(true);
  });
});
