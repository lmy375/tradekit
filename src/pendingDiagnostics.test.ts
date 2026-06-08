// Iter622: tests for the pure classifiers in pendingDiagnostics.ts. The
// orchestrator (diagnosePendingTx) is RPC-bound — covered indirectly by the
// CLI smoke tests. Here we pin every gas/nonce/age classifier + the decision
// tree so a regression in the bucketing matrix gets caught fast.

import { describe, expect, it } from "vitest";
import {
  classifyGasState,
  classifyNonceState,
  classifyAge,
  recommendAction,
} from "./pendingDiagnostics.js";

// ── classifyGasState ───────────────────────────────────────

describe("classifyGasState", () => {
  it("returns ok when maxFee >= base (within 100%)", () => {
    expect(classifyGasState({ maxFeePerGas: 100n, currentBaseFee: 100n })).toBe("ok");
    expect(classifyGasState({ maxFeePerGas: 200n, currentBaseFee: 100n })).toBe("ok");
  });

  it("returns marginal for 75–99% of base", () => {
    expect(classifyGasState({ maxFeePerGas: 80n, currentBaseFee: 100n })).toBe("marginal");
    expect(classifyGasState({ maxFeePerGas: 75n, currentBaseFee: 100n })).toBe("marginal");
  });

  it("returns underpriced for 50–74% of base", () => {
    expect(classifyGasState({ maxFeePerGas: 60n, currentBaseFee: 100n })).toBe("underpriced");
    expect(classifyGasState({ maxFeePerGas: 50n, currentBaseFee: 100n })).toBe("underpriced");
  });

  it("returns very_underpriced for <50%", () => {
    expect(classifyGasState({ maxFeePerGas: 25n, currentBaseFee: 100n })).toBe("very_underpriced");
    expect(classifyGasState({ maxFeePerGas: 1n, currentBaseFee: 100n })).toBe("very_underpriced");
  });

  it("returns ok for zero-base-fee chains", () => {
    expect(classifyGasState({ maxFeePerGas: 1n, currentBaseFee: 0n })).toBe("ok");
  });

  it("returns unknown when inputs are missing", () => {
    expect(classifyGasState({ currentBaseFee: 100n })).toBe("unknown");
    expect(classifyGasState({ maxFeePerGas: 100n })).toBe("unknown");
    expect(classifyGasState({})).toBe("unknown");
  });
});

// ── classifyNonceState ─────────────────────────────────────

describe("classifyNonceState", () => {
  it("returns next when wallet == tx nonce", () => {
    expect(classifyNonceState({ walletNonce: 10, txNonce: 10 })).toBe("next");
  });

  it("returns blocked_by_earlier when wallet < tx (earlier nonces pending)", () => {
    expect(classifyNonceState({ walletNonce: 8, txNonce: 10 })).toBe("blocked_by_earlier");
  });

  it("returns stale when wallet > tx (already mined elsewhere)", () => {
    expect(classifyNonceState({ walletNonce: 12, txNonce: 10 })).toBe("stale");
  });

  it("returns unknown when inputs missing", () => {
    expect(classifyNonceState({})).toBe("unknown");
    expect(classifyNonceState({ walletNonce: 10 })).toBe("unknown");
  });
});

// ── classifyAge ────────────────────────────────────────────

describe("classifyAge", () => {
  it("fresh for <30s", () => {
    expect(classifyAge(0)).toBe("fresh");
    expect(classifyAge(29)).toBe("fresh");
  });
  it("moderate for 30s–5min", () => {
    expect(classifyAge(30)).toBe("moderate");
    expect(classifyAge(299)).toBe("moderate");
  });
  it("stuck for 5min–30min", () => {
    expect(classifyAge(300)).toBe("stuck");
    expect(classifyAge(1799)).toBe("stuck");
  });
  it("very_stuck for >=30min", () => {
    expect(classifyAge(1800)).toBe("very_stuck");
    expect(classifyAge(10000)).toBe("very_stuck");
  });
});

// ── recommendAction ────────────────────────────────────────

describe("recommendAction decision tree", () => {
  it("stale nonce → investigate_stale (highest priority)", () => {
    const r = recommendAction({ gasState: "ok", nonceState: "stale", ageBucket: "fresh" });
    expect(r.action).toBe("investigate_stale");
  });

  it("stale nonce wins even when gas is very_underpriced", () => {
    // The earlier-nonce check shouldn't override stale — stale means the tx
    // is no longer in the canonical mempool.
    const r = recommendAction({ gasState: "very_underpriced", nonceState: "stale", ageBucket: "very_stuck" });
    expect(r.action).toBe("investigate_stale");
  });

  it("blocked_by_earlier → cancel_or_speedup_earlier", () => {
    const r = recommendAction({ gasState: "ok", nonceState: "blocked_by_earlier", ageBucket: "stuck" });
    expect(r.action).toBe("cancel_or_speedup_earlier");
  });

  it("very_underpriced → speedup_high (regardless of age)", () => {
    expect(recommendAction({ gasState: "very_underpriced", nonceState: "next", ageBucket: "fresh" }).action).toBe("speedup_high");
    expect(recommendAction({ gasState: "very_underpriced", nonceState: "next", ageBucket: "very_stuck" }).action).toBe("speedup_high");
  });

  it("very_stuck age → speedup_high", () => {
    const r = recommendAction({ gasState: "ok", nonceState: "next", ageBucket: "very_stuck" });
    expect(r.action).toBe("speedup_high");
  });

  it("underpriced + stuck → speedup", () => {
    const r = recommendAction({ gasState: "underpriced", nonceState: "next", ageBucket: "stuck" });
    expect(r.action).toBe("speedup");
  });

  it("marginal gas + stuck → speedup", () => {
    const r = recommendAction({ gasState: "marginal", nonceState: "next", ageBucket: "stuck" });
    expect(r.action).toBe("speedup");
  });

  it("ok gas + fresh → wait", () => {
    const r = recommendAction({ gasState: "ok", nonceState: "next", ageBucket: "fresh" });
    expect(r.action).toBe("wait");
  });

  it("ok gas + moderate age → wait_and_recheck", () => {
    const r = recommendAction({ gasState: "ok", nonceState: "next", ageBucket: "moderate" });
    expect(r.action).toBe("wait_and_recheck");
  });

  it("unknown state combos → unknown verdict (graceful)", () => {
    const r = recommendAction({ gasState: "unknown", nonceState: "unknown", ageBucket: "moderate" });
    expect(r.action).toBe("unknown");
  });

  it("underpriced + fresh does NOT trigger speedup (age check protects against premature bump)", () => {
    // Mining takes a few seconds even on fast chains. We don't speedup a tx
    // submitted 5 seconds ago even if the gas looks underpriced — wait for
    // the network to reject it first.
    const r = recommendAction({ gasState: "underpriced", nonceState: "next", ageBucket: "fresh" });
    expect(r.action).toBe("wait");
  });

  it("includes a non-empty message for every verdict", () => {
    const r = recommendAction({ gasState: "underpriced", nonceState: "next", ageBucket: "stuck" });
    expect(r.message.length).toBeGreaterThan(20);
  });
});
