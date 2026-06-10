/**
 * Dynamic-sizing sentinel tests (v35.5) — the single definition every
 * execution layer (trade / paper / backtest / validation) shares.
 */

import { describe, it, expect } from "vitest";
import { parseSizingSentinel, isDynamicAmount, applyFractionBig, applyFraction, describeSentinel } from "./sizing.js";

describe("parseSizingSentinel", () => {
  it("parses max case-insensitively", () => {
    expect(parseSizingSentinel("max")).toEqual({ kind: "max" });
    expect(parseSizingSentinel("MAX")).toEqual({ kind: "max" });
    expect(parseSizingSentinel("  Max  ")).toEqual({ kind: "max" });
  });

  it("parses percentages in (0, 100]", () => {
    expect(parseSizingSentinel("50%")).toEqual({ kind: "pct", fraction: 0.5 });
    expect(parseSizingSentinel("37.5%")).toEqual({ kind: "pct", fraction: 0.375 });
    expect(parseSizingSentinel("100%")).toEqual({ kind: "pct", fraction: 1 });
    expect(parseSizingSentinel("0.5%")).toEqual({ kind: "pct", fraction: 0.005 });
  });

  it("rejects out-of-range and malformed percentages", () => {
    expect(parseSizingSentinel("0%")).toBeNull();
    expect(parseSizingSentinel("150%")).toBeNull();
    expect(parseSizingSentinel("-5%")).toBeNull();   // sign not matched by the regex
    expect(parseSizingSentinel("x%")).toBeNull();
    expect(parseSizingSentinel("%")).toBeNull();
  });

  it("plain decimals are not sentinels", () => {
    expect(parseSizingSentinel("1.5")).toBeNull();
    expect(parseSizingSentinel("maximum")).toBeNull();
  });

  it("isDynamicAmount mirrors the parser", () => {
    expect(isDynamicAmount("max")).toBe(true);
    expect(isDynamicAmount("25%")).toBe(true);
    expect(isDynamicAmount("1.5")).toBe(false);
    expect(isDynamicAmount(null)).toBe(false);
  });
});

describe("applyFractionBig — ppm integer math", () => {
  it("max is identity", () => {
    expect(applyFractionBig(123456789n, { kind: "max" })).toBe(123456789n);
  });

  it("50% of an 18-decimals balance has no float drift", () => {
    const oneEth = 10n ** 18n;
    expect(applyFractionBig(oneEth, { kind: "pct", fraction: 0.5 })).toBe(oneEth / 2n);
  });

  it("37.5% rounds down at ppm resolution", () => {
    expect(applyFractionBig(1_000_000n, { kind: "pct", fraction: 0.375 })).toBe(375_000n);
    expect(applyFractionBig(3n, { kind: "pct", fraction: 0.5 })).toBe(1n); // floor
  });

  it("float twin matches for the simulator", () => {
    expect(applyFraction(2.0, { kind: "pct", fraction: 0.5 })).toBe(1.0);
    expect(applyFraction(2.0, { kind: "max" })).toBe(2.0);
  });
});

describe("describeSentinel", () => {
  it("renders operator-facing labels", () => {
    expect(describeSentinel({ kind: "max" })).toBe("max");
    expect(describeSentinel({ kind: "pct", fraction: 0.5 })).toBe("50%");
    expect(describeSentinel({ kind: "pct", fraction: 0.375 })).toBe("37.5%");
  });
});
