// Iter609: unit tests for computeSafetyVerdict — the pure verdict logic of the
// token safety check. The orchestrator (checkTokenSafety) needs aggregators +
// chain and is covered by smoke tests; these unit tests pin the verdict
// precedence + reasoning for every branch so a regression in the safety
// classification gets caught immediately.

import { describe, it, expect } from "vitest";
import {
  computeSafetyVerdict,
  shortVerdictLine,
  DEFAULT_SUSPICIOUS_LOSS_PCT,
  type TokenSafetyReport,
} from "./tokenSafety.js";

describe("computeSafetyVerdict (iter609)", () => {
  const T = DEFAULT_SUSPICIOUS_LOSS_PCT; // 20

  it("unknown: buy didn't quote (no liquidity → can't assess safety)", () => {
    const r = computeSafetyVerdict({
      buyQuoted: false,
      buySimulated: false,
      sellQuoted: false,
      sellSimulated: false,
      roundTripLossPct: null,
      suspiciousLossPct: T,
    });
    expect(r.verdict).toBe("unknown");
    expect(r.reasons[0]).toMatch(/no liquidity/i);
  });

  it("unknown: buy quoted but buy simulation reverted (could be paused contract, not strictly honeypot)", () => {
    const r = computeSafetyVerdict({
      buyQuoted: true,
      buySimulated: false,
      buyRevertReason: "Pausable: paused",
      sellQuoted: false,
      sellSimulated: false,
      roundTripLossPct: null,
      suspiciousLossPct: T,
    });
    expect(r.verdict).toBe("unknown");
    // Reasoning should explicitly mention the buy revert reason so the operator
    // knows why we can't assess the sell side.
    expect(r.reasons[0]).toMatch(/Pausable: paused/);
  });

  it("honeypot: buy simulated but sell could not be quoted (no exit liquidity)", () => {
    const r = computeSafetyVerdict({
      buyQuoted: true,
      buySimulated: true,
      sellQuoted: false,
      sellSimulated: false,
      roundTripLossPct: null,
      suspiciousLossPct: T,
    });
    expect(r.verdict).toBe("honeypot");
    expect(r.reasons[0]).toMatch(/no exit liquidity/i);
  });

  it("honeypot: buy simulated, sell quoted, but sell simulate reverted (classic drain)", () => {
    const r = computeSafetyVerdict({
      buyQuoted: true,
      buySimulated: true,
      sellQuoted: true,
      sellSimulated: false,
      sellRevertReason: "TRANSFER_FAILED",
      roundTripLossPct: null,
      suspiciousLossPct: T,
    });
    expect(r.verdict).toBe("honeypot");
    expect(r.reasons[0]).toMatch(/honeypot/i);
    expect(r.reasons[0]).toMatch(/TRANSFER_FAILED/);
  });

  it("suspicious: both simulate but round-trip loss exceeds threshold (high tax)", () => {
    const r = computeSafetyVerdict({
      buyQuoted: true,
      buySimulated: true,
      sellQuoted: true,
      sellSimulated: true,
      roundTripLossPct: 25, // > 20% threshold
      suspiciousLossPct: T,
    });
    expect(r.verdict).toBe("suspicious");
    expect(r.reasons[0]).toMatch(/25.0%/);
    expect(r.reasons[0]).toMatch(/transfer-tax/i);
  });

  it("suspicious: exact-threshold + epsilon counts as suspicious (no off-by-one)", () => {
    const r = computeSafetyVerdict({
      buyQuoted: true,
      buySimulated: true,
      sellQuoted: true,
      sellSimulated: true,
      roundTripLossPct: 20.0001,
      suspiciousLossPct: T,
    });
    expect(r.verdict).toBe("suspicious");
  });

  it("ok: exactly at threshold is OK (the > comparison is strict)", () => {
    const r = computeSafetyVerdict({
      buyQuoted: true,
      buySimulated: true,
      sellQuoted: true,
      sellSimulated: true,
      roundTripLossPct: 20,
      suspiciousLossPct: T,
    });
    expect(r.verdict).toBe("ok");
  });

  it("ok: small loss within slippage + gas budget", () => {
    const r = computeSafetyVerdict({
      buyQuoted: true,
      buySimulated: true,
      sellQuoted: true,
      sellSimulated: true,
      roundTripLossPct: 1.5, // 1.5% — normal for a swap+swap with 50bps + gas
      suspiciousLossPct: T,
    });
    expect(r.verdict).toBe("ok");
    expect(r.reasons[0]).toMatch(/within the expected.+budget/i);
    // The "not a guarantee" disclaimer is the second reason — pinned because
    // it's important UX: operators trusting the probe as gospel is risky.
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
    expect(r.reasons[1]).toMatch(/not a guarantee/i);
  });

  it("unknown: both simulate but loss couldn't be computed (price oracle gap)", () => {
    const r = computeSafetyVerdict({
      buyQuoted: true,
      buySimulated: true,
      sellQuoted: true,
      sellSimulated: true,
      roundTripLossPct: null,
      suspiciousLossPct: T,
    });
    expect(r.verdict).toBe("unknown");
    expect(r.reasons[0]).toMatch(/price oracle gap/i);
  });

  it("custom threshold: 5% threshold makes a 10% loss suspicious", () => {
    const r = computeSafetyVerdict({
      buyQuoted: true,
      buySimulated: true,
      sellQuoted: true,
      sellSimulated: true,
      roundTripLossPct: 10,
      suspiciousLossPct: 5,
    });
    expect(r.verdict).toBe("suspicious");
  });

  it("negative loss (round-trip gained somehow) is treated as OK", () => {
    // Edge: aggregator routes through a pool with stale prices and the "loss"
    // comes out negative (gain). Not suspicious — treat as OK. The pattern is
    // rare but exists (sandwich attack victim's view).
    const r = computeSafetyVerdict({
      buyQuoted: true,
      buySimulated: true,
      sellQuoted: true,
      sellSimulated: true,
      roundTripLossPct: -2,
      suspiciousLossPct: T,
    });
    expect(r.verdict).toBe("ok");
  });
});

describe("shortVerdictLine (iter609)", () => {
  const baseReport: TokenSafetyReport = {
    chain: "base",
    token: "0x1234567890123456789012345678901234567890" as `0x${string}`,
    symbol: "TEST",
    decimals: 18,
    probeUsd: 10,
    probeNativeAmount: "0.003",
    buyQuoted: true,
    buySimulated: true,
    sellQuoted: true,
    sellSimulated: true,
    roundTripLossPct: 1.5,
    suspiciousLossPct: 20,
    verdict: "ok",
    reasons: [],
    timestamp: "2026-01-01T00:00:00.000Z",
  };

  it("ok verdict line includes the symbol + loss %", () => {
    const line = shortVerdictLine(baseReport);
    expect(line).toMatch(/🟢 OK/);
    expect(line).toMatch(/TEST/);
    expect(line).toMatch(/1\.5%/);
  });

  it("honeypot verdict line surfaces the token address (so operator can block-list)", () => {
    const r = { ...baseReport, verdict: "honeypot" as const };
    const line = shortVerdictLine(r);
    expect(line).toMatch(/🔴 HONEYPOT/);
    expect(line).toMatch(/cannot be sold/i);
    expect(line).toMatch(/0x1234/); // partial token address visible
  });

  it("suspicious verdict line shows the loss percentage", () => {
    const r = { ...baseReport, verdict: "suspicious" as const, roundTripLossPct: 25.4 };
    const line = shortVerdictLine(r);
    expect(line).toMatch(/🟡 SUSPICIOUS/);
    expect(line).toMatch(/25\.4%/);
  });

  it("unknown verdict line explains why (no liquidity / RPC error)", () => {
    const r = { ...baseReport, verdict: "unknown" as const };
    const line = shortVerdictLine(r);
    expect(line).toMatch(/⚪ UNKNOWN/);
    expect(line).toMatch(/could not be probed/i);
  });
});
