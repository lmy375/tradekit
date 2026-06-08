// Tests for the holdings *formatter*. The on-chain reading itself needs an RPC and is
// already exercised by the integration smoke; here we just lock down the
// human-readable rendering quirks that have bitten production users.

import { describe, it, expect } from "vitest";
import { formatHoldings, formatPrice, formatUsd, type ChainHoldings } from "./holdings.js";

function chain(overrides: Partial<ChainHoldings>): ChainHoldings {
  return {
    chain: "base",
    chainId: 8453,
    address: "0x1234567890abcdef1234567890abcdef12345678",
    timestamp: "2026-01-01T00:00:00Z",
    balances: [],
    totalUsd: undefined,
    ...overrides,
  };
}

describe("formatHoldings (iter123 — honest USD display)", () => {
  it("renders a regular balance with USD value as $X.XX", () => {
    const out = formatHoldings([
      chain({
        balances: [{ symbol: "WETH", token: "NATIVE", amount: "0.5", decimals: 18, usd: 1500 }],
        totalUsd: 1500,
      }),
    ]);
    expect(out).toContain("WETH       0.5 ($1500.00)");
    expect(out).toContain("Subtotal: $1500.00");
    expect(out).toContain("Grand total: $1500.00");
  });

  it("renders dust between $0 and $0.01 as <$0.01 (regression: was $0.00 pre-iter123)", () => {
    // A position worth $0.003 used to display as "$0.00" — operators saw it as worthless,
    // but it could be one of many such positions summing to real money in the grand total.
    const out = formatHoldings([
      chain({
        balances: [{ symbol: "DUST", token: "NATIVE", amount: "0.001", decimals: 18, usd: 0.003 }],
        totalUsd: 0.003,
      }),
    ]);
    expect(out).toContain("(<$0.01)");
    expect(out).toContain("Subtotal: <$0.01");
    expect(out).not.toContain("$0.00");
  });

  it("flags unpriced tokens in the subtotal AND grand total", () => {
    // Long-tail tokens often have no price feed. Pre-iter123 they silently dropped out
    // of the subtotal — the operator had zero signal that the displayed number wasn't
    // the full picture.
    const out = formatHoldings([
      chain({
        balances: [
          { symbol: "WETH", token: "NATIVE", amount: "0.5", decimals: 18, usd: 1500 },
          { symbol: "WEIRDO", token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", amount: "1000", decimals: 18, usd: undefined },
        ],
        totalUsd: 1500,
      }),
    ]);
    expect(out).toContain("Subtotal: $1500.00  (+1 unpriced)");
    expect(out).toContain("Grand total: $1500.00  (+1 unpriced)");
  });

  it("sums unpriced counts across chains in the grand total", () => {
    const out = formatHoldings([
      chain({
        chain: "base",
        balances: [
          { symbol: "WETH", token: "NATIVE", amount: "0.5", decimals: 18, usd: 1500 },
          { symbol: "X", token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", amount: "1", decimals: 18, usd: undefined },
        ],
        totalUsd: 1500,
      }),
      chain({
        chain: "arbitrum",
        chainId: 42161,
        balances: [
          { symbol: "USDC", token: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", amount: "100", decimals: 6, usd: 100 },
          { symbol: "Y", token: "0xcccccccccccccccccccccccccccccccccccccccc", amount: "1", decimals: 18, usd: undefined },
          { symbol: "Z", token: "0xdddddddddddddddddddddddddddddddddddddddd", amount: "1", decimals: 18, usd: undefined },
        ],
        totalUsd: 100,
      }),
    ]);
    expect(out).toContain("Grand total: $1600.00  (+3 unpriced)");
  });

  it("does NOT show the (+N unpriced) note when everything is priced", () => {
    const out = formatHoldings([
      chain({
        balances: [{ symbol: "WETH", token: "NATIVE", amount: "0.5", decimals: 18, usd: 1500 }],
        totalUsd: 1500,
      }),
    ]);
    expect(out).not.toContain("unpriced");
  });

  it("returns 'No balances found.' when every chain is empty", () => {
    const out = formatHoldings([
      chain({
        balances: [{ symbol: "WETH", token: "NATIVE", amount: "0", decimals: 18, usd: 0 }],
      }),
    ]);
    expect(out).toContain("No balances found.");
  });

  it("iter747: appends onboarding hint with address + chain list on the empty path", () => {
    const out = formatHoldings([
      chain({
        chain: "base",
        balances: [{ symbol: "WETH", token: "NATIVE", amount: "0", decimals: 18, usd: 0 }],
      }),
      chain({
        chain: "arbitrum",
        balances: [{ symbol: "ETH", token: "NATIVE", amount: "0", decimals: 18, usd: 0 }],
      }),
    ]);
    expect(out).toContain("Scanned address 0x1234567890abcdef1234567890abcdef12345678");
    expect(out).toContain("base, arbitrum");
    expect(out).toContain("tradekit holdings --chains all");
    expect(out).toContain("tradekit holdings --accounts all");
  });

  it("iter747: hint is suppressed when balances exist (only the empty path triggers it)", () => {
    const out = formatHoldings([
      chain({
        balances: [{ symbol: "WETH", token: "NATIVE", amount: "0.5", decimals: 18, usd: 1500 }],
        totalUsd: 1500,
      }),
    ]);
    expect(out).not.toContain("Scanned address");
    expect(out).not.toContain("--chains all");
  });

  it("iter747: empty-input array does NOT crash — hint section is skipped", () => {
    const out = formatHoldings([]);
    expect(out).toBe("No balances found.");
  });

  it("skips a chain entirely when every balance is zero", () => {
    const out = formatHoldings([
      chain({
        chain: "empty-chain",
        balances: [{ symbol: "X", token: "NATIVE", amount: "0", decimals: 18, usd: 0 }],
      }),
      chain({
        chain: "good-chain",
        balances: [{ symbol: "WETH", token: "NATIVE", amount: "0.5", decimals: 18, usd: 1500 }],
        totalUsd: 1500,
      }),
    ]);
    expect(out).not.toContain("empty-chain");
    expect(out).toContain("good-chain");
  });

  it("iter709: --min-usd filters priced positions below threshold", () => {
    const out = formatHoldings(
      [
        chain({
          balances: [
            { symbol: "WETH", token: "NATIVE", amount: "0.5", decimals: 18, usd: 1500 },
            { symbol: "DUST1", token: ("0x" + "11".repeat(20)) as `0x${string}`, amount: "1000", decimals: 18, usd: 0.05 },
            { symbol: "DUST2", token: ("0x" + "22".repeat(20)) as `0x${string}`, amount: "5", decimals: 18, usd: 0.3 },
          ],
          totalUsd: 1500.35,
        }),
      ],
      { minUsd: 1 },
    );
    // WETH is shown (above threshold).
    expect(out).toContain("WETH");
    // DUST1 + DUST2 are not displayed.
    expect(out).not.toContain("DUST1");
    expect(out).not.toContain("DUST2");
    // Subtotal note shows filtered count + value so signal isn't silent.
    expect(out).toMatch(/Subtotal:.*\(\+2 dust \$0\.35\)/);
    // Grand-total note also has filter info.
    expect(out).toMatch(/Grand total:.*filtered by --min-usd/);
  });

  it("iter709: unpriced balances are NEVER filtered (no usd → can't decide)", () => {
    const out = formatHoldings(
      [
        chain({
          balances: [
            { symbol: "WEIRDO", token: "0xa".padEnd(42, "a") as `0x${string}`, amount: "1000", decimals: 18, usd: undefined },
            { symbol: "DUST", token: "0xb".padEnd(42, "b") as `0x${string}`, amount: "1", decimals: 18, usd: 0.1 },
          ],
          totalUsd: 0.1,
        }),
      ],
      { minUsd: 1 },
    );
    // Unpriced token still shows even with high minUsd.
    expect(out).toContain("WEIRDO");
    expect(out).not.toContain("DUST");
  });

  it("iter709: omitting minUsd preserves pre-iter709 behavior (no filtering)", () => {
    const out = formatHoldings([
      chain({
        balances: [{ symbol: "DUST", token: "NATIVE", amount: "1", decimals: 18, usd: 0.01 }],
        totalUsd: 0.01,
      }),
    ]);
    expect(out).toContain("DUST");
    expect(out).not.toMatch(/dust.*filtered/i);
  });
});

describe("formatPrice (iter170 — adaptive precision for sub-cent tokens)", () => {
  it("two decimals for prices >= $1", () => {
    expect(formatPrice(1234.5)).toBe("$1234.50");
    expect(formatPrice(1)).toBe("$1.00");
  });

  it("four decimals for prices in $0.01..$0.99", () => {
    expect(formatPrice(0.05)).toBe("$0.0500");
    expect(formatPrice(0.12345)).toBe("$0.1235");
  });

  it("expands precision for sub-cent prices (regression: pre-iter170 showed $0.0000)", () => {
    // Memecoin-sized: surface enough decimals to expose 4 significant digits.
    expect(formatPrice(0.0000123)).toBe("$0.0000123");
    expect(formatPrice(0.0000000045)).toBe("$0.0000000045");
  });

  it("trims unnecessary trailing zeros (no '$0.0010000')", () => {
    expect(formatPrice(0.001)).toBe("$0.001");
    expect(formatPrice(0.0005)).toBe("$0.0005");
  });

  it("zero stays as $0 (not $0.00 or $0)", () => {
    expect(formatPrice(0)).toBe("$0");
  });

  it("handles negative prices (shouldn't normally happen but doesn't crash)", () => {
    // Sign-before-dollar follows accounting convention (iter229).
    expect(formatPrice(-1.5)).toBe("-$1.50");
  });
});

describe("formatUsd (iter230 — sign-before-dollar convention)", () => {
  it("formats positives normally", () => {
    expect(formatUsd(1500.55)).toBe("$1500.55");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("places minus BEFORE dollar for negative values", () => {
    expect(formatUsd(-1500.55)).toBe("-$1500.55");
    expect(formatUsd(-5.3)).toBe("-$5.30");
  });

  it("keeps the dust sentinels (<$0.01, >-$0.01)", () => {
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(-0.001)).toBe(">-$0.01");
  });
});
