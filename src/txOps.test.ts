// Iter603: unit tests for the pure helpers in txOps.ts. The HTTP-touching
// speedupTx / cancelTx are covered by smoke tests (live chain); these unit
// tests pin the gas-multiplier math and gwei formatting contracts so a regression
// in the bigint precision logic gets caught immediately.

import { describe, it, expect } from "vitest";
import {
  applyGasMultiplier,
  DEFAULT_GAS_MULTIPLIER,
  MIN_GAS_MULTIPLIER,
  __testing,
} from "./txOps.js";
import { ToolError } from "./errors.js";

describe("applyGasMultiplier (iter603)", () => {
  it("scales by the default 1.2x and produces a strictly higher amount", () => {
    // 100 wei × 1.2 = 120 wei (+ 1 wei round-up = 121).
    const result = applyGasMultiplier(100n, DEFAULT_GAS_MULTIPLIER);
    expect(result).toBe(121n);
    expect(result).toBeGreaterThan(100n);
  });

  it("accepts the +10% floor (1.1) exactly — the geth replacement minimum", () => {
    // 100 wei × 1.1 = 110 wei + 1 round-up = 111.
    const result = applyGasMultiplier(100n, MIN_GAS_MULTIPLIER);
    expect(result).toBe(111n);
  });

  it("rejects multipliers below the 1.1 floor with INVALID_PARAMS", () => {
    // 1.0 = "same gas" — the mempool would reject this as not-actually-a-replacement.
    expect(() => applyGasMultiplier(100n, 1.0)).toThrow(ToolError);
    try {
      applyGasMultiplier(100n, 1.0);
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INVALID_PARAMS");
      expect(err.message).toMatch(/replacement-rule floor/);
      // Iter603: structured details so a wizard/automation can read provided vs min vs default.
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("multiplier_too_low");
      expect(details?.provided).toBe(1.0);
      expect(details?.min).toBe(1.1);
      expect(details?.default).toBe(1.2);
    }
  });

  it("rejects negative or zero multipliers (operator typo guard)", () => {
    expect(() => applyGasMultiplier(100n, 0)).toThrow(ToolError);
    expect(() => applyGasMultiplier(100n, -1)).toThrow(ToolError);
  });

  it("preserves bigint precision on realistic 18-decimal gas-price values", () => {
    // 50 gwei = 50_000_000_000 wei. 1.5x = 75 gwei + 1 wei round-up.
    const fiftyGwei = 50_000_000_000n;
    const result = applyGasMultiplier(fiftyGwei, 1.5);
    // 50e9 × 15000 / 10000 = 75e9, + 1 wei.
    expect(result).toBe(75_000_000_001n);
  });

  it("handles very large amounts without overflow (1 ETH worth of gas)", () => {
    const oneEth = 1_000_000_000_000_000_000n; // 1e18 wei
    const result = applyGasMultiplier(oneEth, 1.2);
    // 1e18 × 12000 / 10000 = 1.2e18, + 1 wei round-up.
    expect(result).toBe(1_200_000_000_000_000_001n);
  });

  it("multiplier precision: 1.2345 round-trips through 4 bps digits", () => {
    // 1000 × 1.2345 = 1234.5 wei. Math.round(1.2345 × 10000) = 12345 bps.
    // 1000 × 12345 / 10000 = 1234 (bigint truncates), + 1 round-up = 1235.
    const result = applyGasMultiplier(1000n, 1.2345);
    expect(result).toBe(1235n);
  });

  it("zero amount stays zero (+ round-up = 1)", () => {
    // Edge: legacy-only chains where the original tx had no priority fee. The
    // multiplier-then-round-up produces 1 wei priority on the replacement,
    // which the mempool accepts as "non-zero priority".
    const result = applyGasMultiplier(0n, 1.2);
    expect(result).toBe(1n);
  });

  it("multiplier of exactly 1.1 against an even number still crosses +10% cleanly", () => {
    // 100 × 1.1 = 110.0. With round-up the replacement is 111 — strictly above
    // the +10% floor. Pins the rationale for the "+1 wei" in the helper.
    const result = applyGasMultiplier(100n, 1.1);
    expect(result).toBeGreaterThan((100n * 110n) / 100n); // > 110, the literal +10%
  });
});

describe("formatGwei (iter603 internal helper)", () => {
  it("converts whole gwei correctly", () => {
    expect(__testing.formatGwei(50_000_000_000n)).toBe("50");
  });

  it("handles fractional gwei without trailing zeros", () => {
    // 1.5 gwei = 1_500_000_000 wei. Should render as "1.5", not "1.500000000".
    expect(__testing.formatGwei(1_500_000_000n)).toBe("1.5");
  });

  it("returns '0' for zero wei (compact)", () => {
    expect(__testing.formatGwei(0n)).toBe("0");
  });

  it("renders sub-gwei amounts as decimal-less than 1", () => {
    // 500 mwei = 0.5 gwei.
    expect(__testing.formatGwei(500_000_000n)).toBe("0.5");
  });

  it("preserves precision down to wei (no rounding)", () => {
    // 1 wei = 0.000000001 gwei. Trailing-zero-strip leaves "0.000000001".
    expect(__testing.formatGwei(1n)).toBe("0.000000001");
  });
});
