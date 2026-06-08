// Iter613: unit tests for computeCrossCheckVerdict — the pure verdict math.
// HTTP fetches in crossCheckPrice are covered by integration/smoke; these
// tests pin every divergence-threshold branch + the edge cases (null,
// zero-price, infinity).

import { describe, it, expect } from "vitest";
import {
  computeCrossCheckVerdict,
  shortVerdictLine,
  DEFAULT_TOLERANCE_PCT,
  DEFAULT_EXTREME_PCT,
  type PriceCrossCheck,
} from "./priceCrossCheck.js";

describe("computeCrossCheckVerdict (iter613)", () => {
  const T = DEFAULT_TOLERANCE_PCT; // 5
  const E = DEFAULT_EXTREME_PCT; // 20

  it("unknown: both prices null", () => {
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: null,
      dexScreenerPrice: null,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toMatch(/Neither/);
    expect(r.absoluteDiff).toBeNull();
    expect(r.divergencePct).toBeNull();
  });

  it("one_source: only CoinGecko present", () => {
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 3000,
      dexScreenerPrice: null,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("one_source");
    expect(r.reason).toMatch(/CoinGecko/);
    expect(r.absoluteDiff).toBeNull();
  });

  it("one_source: only DexScreener present", () => {
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: null,
      dexScreenerPrice: 50,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("one_source");
    expect(r.reason).toMatch(/DexScreener/);
  });

  it("ok: prices agree within tolerance (1% apart)", () => {
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 3000,
      dexScreenerPrice: 3030,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("ok");
    // 30 / 3000 = 1% → well within 5% tolerance.
    expect(r.divergencePct).toBeCloseTo(1, 2);
    expect(r.absoluteDiff).toBe(30);
  });

  it("ok: identical prices give 0% divergence", () => {
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 100,
      dexScreenerPrice: 100,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("ok");
    expect(r.divergencePct).toBe(0);
    expect(r.absoluteDiff).toBe(0);
  });

  it("suspicious: divergence between tolerance and extreme (10% apart)", () => {
    // 3000 vs 3300 → 300/3000 = 10% (above 5%, below 20%)
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 3000,
      dexScreenerPrice: 3300,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("suspicious");
    expect(r.divergencePct).toBeCloseTo(10, 2);
    expect(r.reason).toMatch(/low liquidity|stale data|manipulated/);
  });

  it("extreme: divergence beyond extreme threshold (25% apart)", () => {
    // 100 vs 125 → 25/100 = 25% (above the 20% extreme threshold)
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 100,
      dexScreenerPrice: 125,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("extreme");
    expect(r.divergencePct).toBeCloseTo(25, 2);
    expect(r.reason).toMatch(/manipulated|honeypot|stale/);
    // Reason should explicitly say "do not trade" since the verdict is extreme.
    expect(r.reason).toMatch(/Do NOT trade/);
  });

  it("extreme: massive divergence (10x apart) handled cleanly", () => {
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 1,
      dexScreenerPrice: 10,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("extreme");
    // (10-1)/1 = 900%
    expect(r.divergencePct).toBeCloseTo(900, 2);
  });

  it("extreme: one price is zero (stale/corrupted data)", () => {
    // Edge: one source returns 0. Computing divergence relative to min would
    // hit division-by-zero — handle as extreme + Infinity divergence.
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 100,
      dexScreenerPrice: 0,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("extreme");
    expect(r.divergencePct).toBe(Infinity);
    expect(r.reason).toMatch(/stale|corrupted/);
  });

  it("boundary: exactly at tolerance threshold is suspicious (>= semantic)", () => {
    // 100 vs 105 → exactly 5% (=tolerancePct). Per the >= check, this becomes
    // "suspicious" not "ok" — operator should be alerted at the boundary.
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 100,
      dexScreenerPrice: 105,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("suspicious");
  });

  it("boundary: exactly at extreme threshold is extreme (>= semantic)", () => {
    // 100 vs 120 → exactly 20%.
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 100,
      dexScreenerPrice: 120,
      tolerancePct: T,
      extremePct: E,
    });
    expect(r.verdict).toBe("extreme");
  });

  it("custom thresholds: tighter 1% tolerance flags a 2% divergence", () => {
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 100,
      dexScreenerPrice: 102,
      tolerancePct: 1,
      extremePct: 10,
    });
    expect(r.verdict).toBe("suspicious");
  });

  it("custom thresholds: loose 30% tolerance accepts a 25% divergence as OK", () => {
    const r = computeCrossCheckVerdict({
      coinGeckoPrice: 100,
      dexScreenerPrice: 125,
      tolerancePct: 30,
      extremePct: 100,
    });
    expect(r.verdict).toBe("ok");
  });

  it("symmetric: order of arguments doesn't affect divergence magnitude", () => {
    const a = computeCrossCheckVerdict({
      coinGeckoPrice: 100,
      dexScreenerPrice: 110,
      tolerancePct: T,
      extremePct: E,
    });
    const b = computeCrossCheckVerdict({
      coinGeckoPrice: 110,
      dexScreenerPrice: 100,
      tolerancePct: T,
      extremePct: E,
    });
    expect(a.divergencePct).toBe(b.divergencePct);
    expect(a.absoluteDiff).toBe(b.absoluteDiff);
    expect(a.verdict).toBe(b.verdict);
  });
});

describe("shortVerdictLine (iter613)", () => {
  const base: PriceCrossCheck = {
    token: "0x1234567890123456789012345678901234567890",
    coinGeckoPrice: 100,
    dexScreenerPrice: 103,
    absoluteDiff: 3,
    divergencePct: 3,
    tolerancePct: 5,
    extremePct: 20,
    verdict: "ok",
    reason: "agree",
    timestamp: "2026-01-01T00:00:00.000Z",
  };

  it("ok line names both prices + divergence", () => {
    expect(shortVerdictLine(base)).toMatch(/🟢 OK/);
    expect(shortVerdictLine(base)).toMatch(/100/);
    expect(shortVerdictLine(base)).toMatch(/103/);
    expect(shortVerdictLine(base)).toMatch(/3\.0%/);
  });

  it("suspicious line surfaces the divergence as the headline", () => {
    const c = { ...base, verdict: "suspicious" as const, divergencePct: 10 };
    expect(shortVerdictLine(c)).toMatch(/🟡 SUSPICIOUS/);
    expect(shortVerdictLine(c)).toMatch(/10\.0%/);
  });

  it("extreme line uses the warning emoji + names divergence", () => {
    const c = { ...base, verdict: "extreme" as const, divergencePct: 50 };
    expect(shortVerdictLine(c)).toMatch(/🔴 EXTREME/);
  });

  it("extreme line handles Infinity divergence (zero-price edge)", () => {
    const c = { ...base, verdict: "extreme" as const, divergencePct: Infinity };
    expect(shortVerdictLine(c)).toMatch(/∞/);
  });

  it("one_source line names which source returned", () => {
    const c = { ...base, verdict: "one_source" as const, dexScreenerPrice: null };
    expect(shortVerdictLine(c)).toMatch(/⚪ ONE SOURCE/);
    expect(shortVerdictLine(c)).toMatch(/CoinGecko/);
  });

  it("unknown line explains no source recognized the token", () => {
    const c: PriceCrossCheck = { ...base, verdict: "unknown", coinGeckoPrice: null, dexScreenerPrice: null };
    expect(shortVerdictLine(c)).toMatch(/⚪ UNKNOWN/);
    expect(shortVerdictLine(c)).toMatch(/neither/i);
  });
});
