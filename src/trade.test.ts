// Iter625: tests for the pure helpers in trade.ts. The orchestrator
// (executeTrade) is HTTP+wallet-bound; this file pins the pure pieces.
// Currently: checkQuoteDeviation — the quote-freshness gate.

import { describe, expect, it } from "vitest";
import { checkQuoteDeviation, DEFAULT_QUOTE_DEVIATION_BPS } from "./trade.js";

describe("checkQuoteDeviation (iter625)", () => {
  it("passes when actual exactly matches expected", () => {
    expect(checkQuoteDeviation({ expectedAmountOut: "100", actualAmountOut: "100", maxBps: 100 })).toEqual({
      ok: true,
    });
  });

  it("passes when actual is BETTER than expected (router beat the quote)", () => {
    const r = checkQuoteDeviation({ expectedAmountOut: "100", actualAmountOut: "105", maxBps: 100 });
    expect(r.ok).toBe(true);
  });

  it("passes when actual is worse by less than the tolerance", () => {
    // 100 → 99.5 is 50 bps worse; cap is 100 bps → ok
    const r = checkQuoteDeviation({ expectedAmountOut: "100", actualAmountOut: "99.5", maxBps: 100 });
    expect(r.ok).toBe(true);
  });

  it("fails when actual is worse by MORE than the tolerance", () => {
    // 100 → 98 is 200 bps worse; cap is 100 bps → fail
    const r = checkQuoteDeviation({ expectedAmountOut: "100", actualAmountOut: "98", maxBps: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.actualBps).toBeCloseTo(200, 1);
      expect(r.expected).toBe(100);
      expect(r.actual).toBe(98);
    }
  });

  it("exactly-at-cap deviation passes (off-by-one safety)", () => {
    // 100 → 99 is exactly 100 bps; cap 100 → pass (not strict-greater)
    const r = checkQuoteDeviation({ expectedAmountOut: "100", actualAmountOut: "99", maxBps: 100 });
    expect(r.ok).toBe(true);
  });

  it("returns ok for unparseable expected (defensive — don't block trades)", () => {
    expect(checkQuoteDeviation({ expectedAmountOut: "not-a-number", actualAmountOut: "100", maxBps: 100 })).toEqual({
      ok: true,
    });
    expect(checkQuoteDeviation({ expectedAmountOut: "0", actualAmountOut: "100", maxBps: 100 })).toEqual({
      ok: true,
    });
    expect(checkQuoteDeviation({ expectedAmountOut: "-5", actualAmountOut: "100", maxBps: 100 })).toEqual({
      ok: true,
    });
  });

  it("returns ok for unparseable actual (defensive)", () => {
    expect(checkQuoteDeviation({ expectedAmountOut: "100", actualAmountOut: "not-a-number", maxBps: 100 })).toEqual({
      ok: true,
    });
  });

  it("works at extreme deviations (1000+ bps)", () => {
    // 100 → 50 = 5000 bps worse
    const r = checkQuoteDeviation({ expectedAmountOut: "100", actualAmountOut: "50", maxBps: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.actualBps).toBeCloseTo(5000, 1);
  });

  it("DEFAULT_QUOTE_DEVIATION_BPS is 100 (1%)", () => {
    expect(DEFAULT_QUOTE_DEVIATION_BPS).toBe(100);
  });

  it("works with decimal-string inputs (matches on-the-wire shape)", () => {
    // Tight stablecoin pair: 100.5 USDC expected, 100.42 actual → ~7.96 bps worse
    const r = checkQuoteDeviation({ expectedAmountOut: "100.50", actualAmountOut: "100.42", maxBps: 25 });
    expect(r.ok).toBe(true); // under 25 bps cap
  });

  it("tight tolerance (25 bps stablecoin) catches small drift", () => {
    // 100.50 → 100.20 = 29.85 bps worse → fail @ 25 bps cap
    const r = checkQuoteDeviation({ expectedAmountOut: "100.50", actualAmountOut: "100.20", maxBps: 25 });
    expect(r.ok).toBe(false);
  });
});
