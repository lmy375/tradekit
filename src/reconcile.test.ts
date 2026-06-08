// Tests for the pure receipt classifier used by `tradekit reconcile`. The orchestrator
// has to talk to viem so it isn't unit-tested here; classifyReceipt is where the actual
// status-decision logic lives, and pinning its behavior keeps the contract that drives
// the DB updates explicit.

import { describe, it, expect } from "vitest";
import {
  classifyReceipt,
  classifyReorgVerdict,
  formatReconcileReport,
  formatVerifyRecentReport,
  formatBackfillBlocksReport,
  formatBackfillSlippageReport,
  formatBackfillGasUsdReport,
  formatBackfillAllReport,
  type ReconcileReport,
  type VerifyRecentReport,
  type BackfillBlocksReport,
  type BackfillSlippageReport,
  type BackfillGasUsdReport,
  type BackfillAllReport,
  type BackfillRevertReasonReport,
} from "./reconcile.js";

describe("classifyReceipt", () => {
  it("treats a missing receipt as still-pending — never assume failure", () => {
    // On most L2s, a tx that hasn't propagated yet is indistinguishable from one that
    // vanished. Marking it failed would discard a real on-chain trade.
    expect(classifyReceipt(null)).toEqual({ status: "pending" });
  });

  it("a success receipt yields status=success with gas info", () => {
    const out = classifyReceipt({
      status: "success",
      gasUsed: 200_000n,
      effectiveGasPrice: 1_000_000_000n, // 1 gwei
    });
    expect(out).toMatchObject({
      status: "success",
      gasUsed: "200000",
      // 200000 * 1e9 wei = 2e14 wei = 0.0002 ETH
      gasCostNative: "0.0002",
    });
  });

  it("a reverted receipt yields status=failed (gas still recorded)", () => {
    const out = classifyReceipt({
      status: "reverted",
      gasUsed: 50_000n,
      effectiveGasPrice: 2_000_000_000n, // 2 gwei
    });
    expect(out).toMatchObject({
      status: "failed",
      gasUsed: "50000",
      gasCostNative: "0.0001",
    });
  });

  it("treats missing effectiveGasPrice as 0 (cost unknown rather than crash)", () => {
    const out = classifyReceipt({ status: "success", gasUsed: 100_000n });
    expect(out).toMatchObject({ status: "success", gasUsed: "100000", gasCostNative: "0" });
  });

  it("treats null effectiveGasPrice as 0 too", () => {
    const out = classifyReceipt({ status: "success", gasUsed: 100_000n, effectiveGasPrice: null });
    expect(out).toMatchObject({ status: "success", gasCostNative: "0" });
  });
});

describe("formatReconcileReport (iter258 — empty-state collapse)", () => {
  function report(overrides: Partial<ReconcileReport> = {}): ReconcileReport {
    return {
      timestamp: "2026-05-28T12:00:00Z",
      scanned: 0,
      resolvedSuccess: 0,
      resolvedFailed: 0,
      stillPending: 0,
      errors: [],
      severity: "ok",
      recommendedActions: [],
      ...overrides,
    };
  }

  it("collapses the empty case to a single line (iter258 — quiet cron friendliness)", () => {
    // Regression: pre-iter258 a no-pending-trades reconcile printed 4 lines of "0/0/0";
    // cron-friendly tooling buries the operator in noise. Now: one line.
    expect(formatReconcileReport(report())).toBe("No pending trades to reconcile.");
  });

  it("prints the full breakdown when scanned > 0", () => {
    const out = formatReconcileReport(report({
      scanned: 3, resolvedSuccess: 2, resolvedFailed: 1, stillPending: 0,
    }));
    expect(out).toContain("Scanned 3 pending trades");
    expect(out).toContain("success:  2");
    expect(out).toContain("failed:   1");
    expect(out).toContain("pending: 0");
  });

  it("prints the full breakdown even when errors exist but scanned=0", () => {
    // RPC outage scenario: 0 rows succeeded, but an error block to surface.
    const out = formatReconcileReport(report({
      errors: [{ chain: "base", txHash: "0xabc", message: "RPC timeout" }],
    }));
    expect(out).toContain("Scanned 0 pending trades");
    expect(out).toContain("errors:   1");
    expect(out).toContain("base");
    expect(out).toContain("RPC timeout");
  });

  it("uses singular 'trade' for scanned=1", () => {
    const out = formatReconcileReport(report({ scanned: 1, resolvedSuccess: 1 }));
    expect(out).toContain("Scanned 1 pending trade\n"); // singular, not "1 pending trades"
  });

  it("caps the per-error detail list at 5 to keep the report readable", () => {
    const errors = Array.from({ length: 10 }, (_, i) => ({
      chain: "base",
      txHash: `0x${i.toString().padStart(64, "0")}`,
      message: "rpc",
    }));
    const out = formatReconcileReport(report({ errors }));
    expect(out).toContain("errors:   10"); // total count is honest
    // But only 5 detail lines are printed (the rest implicitly elided)
    const detailLines = out.split("\n").filter((l) => l.trim().startsWith("base "));
    expect(detailLines.length).toBe(5);
  });
});

// ── classifyReorgVerdict (iter628) ─────────────────────────

describe("classifyReorgVerdict", () => {
  it("missing receipt → reorg_missing", () => {
    // null = receipt not found on chain. Could be deep reorg dropping the tx,
    // OR an RPC that hasn't indexed it yet. Either way, suspect.
    expect(classifyReorgVerdict(null)).toBe("reorg_missing");
  });

  it("receipt success → still_success (happy path)", () => {
    expect(classifyReorgVerdict({ status: "success" })).toBe("still_success");
  });

  it("receipt reverted → reorg_failed (chain flipped the outcome)", () => {
    expect(classifyReorgVerdict({ status: "reverted" })).toBe("reorg_failed");
  });
});

// ── formatVerifyRecentReport (iter628) ─────────────────────

describe("formatVerifyRecentReport", () => {
  function report(overrides: Partial<VerifyRecentReport> = {}): VerifyRecentReport {
    return {
      timestamp: "2026-05-29T00:00:00Z",
      scanned: 0,
      stillSuccess: 0,
      reorgFailed: 0,
      reorgMissing: 0,
      errors: [],
      suspects: [],
      severity: "ok",
      ...overrides,
    };
  }

  it("collapses empty case to a single line", () => {
    expect(formatVerifyRecentReport(report())).toBe("No recent success trades to verify.");
  });

  it("happy path: shows only still-success count", () => {
    const out = formatVerifyRecentReport(report({ scanned: 5, stillSuccess: 5 }));
    expect(out).toMatch(/Verified 5/);
    expect(out).toMatch(/still success: 5/);
    expect(out).not.toMatch(/reorg/);
  });

  it("surfaces reorg_failed + reorg_missing counts", () => {
    const out = formatVerifyRecentReport(
      report({
        scanned: 10,
        stillSuccess: 7,
        reorgFailed: 2,
        reorgMissing: 1,
        suspects: [
          { txHash: "0xa", chain: "polygon", account: "alice", verdict: "reorg_failed", message: "x" },
          { txHash: "0xb", chain: "polygon", account: "alice", verdict: "reorg_missing", message: "y" },
        ],
      }),
    );
    expect(out).toMatch(/reorg flipped:\s+2/);
    expect(out).toMatch(/reorg missing:\s+1/);
    expect(out).toMatch(/REORG-FLIP/);
    expect(out).toMatch(/REORG-MISS/);
  });

  it("truncates suspects list past 10 entries (display only)", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      txHash: `0x${i}`,
      chain: "polygon",
      account: "alice",
      verdict: "reorg_failed" as const,
      message: "x",
    }));
    const out = formatVerifyRecentReport(
      report({ scanned: 25, reorgFailed: 25, suspects: many }),
    );
    expect(out).toMatch(/and 15 more/);
  });
});

// ── formatBackfillBlocksReport (iter637) ───────────────────

describe("formatBackfillBlocksReport", () => {
  function rep(o: Partial<BackfillBlocksReport> = {}): BackfillBlocksReport {
    return {
      timestamp: "2026-05-29T00:00:00Z",
      scanned: 0,
      backfilled: 0,
      receiptMissing: 0,
      errors: [],
      severity: "ok",
      ...o,
    };
  }

  it("collapses empty case to a single line", () => {
    expect(formatBackfillBlocksReport(rep())).toBe(
      "No success trades without block_number — nothing to backfill.",
    );
  });

  it("reports backfilled + scanned counts", () => {
    const out = formatBackfillBlocksReport(rep({ scanned: 100, backfilled: 100 }));
    expect(out).toMatch(/100 legacy success/);
    expect(out).toMatch(/backfilled:\s+100/);
  });

  it("surfaces receipt-missing rows separately (not as errors)", () => {
    const out = formatBackfillBlocksReport(
      rep({ scanned: 100, backfilled: 95, receiptMissing: 5 }),
    );
    expect(out).toMatch(/receipt missing:\s+5/);
    expect(out).not.toMatch(/! errors:/);
  });

  it("renders errors with details", () => {
    const out = formatBackfillBlocksReport(
      rep({
        scanned: 5,
        backfilled: 3,
        errors: [
          { chain: "polygon", txHash: "0xabc", message: "RPC down" },
          { chain: "base", txHash: "0xdef", message: "rate limited" },
        ],
      }),
    );
    expect(out).toMatch(/! errors:\s+2/);
    expect(out).toMatch(/polygon/);
    expect(out).toMatch(/base/);
  });

  it("hints at re-running when scanned >= 500 (hit the default limit)", () => {
    const out = formatBackfillBlocksReport(rep({ scanned: 500, backfilled: 500 }));
    expect(out).toMatch(/re-run/i);
  });

  it("congratulates on full backfill (all rows backfilled, under limit)", () => {
    const out = formatBackfillBlocksReport(rep({ scanned: 50, backfilled: 50 }));
    expect(out).toMatch(/All rows backfilled/);
  });
});

// ── formatBackfillSlippageReport (iter643) ─────────────────

describe("formatBackfillSlippageReport", () => {
  function rep(o: Partial<BackfillSlippageReport> = {}): BackfillSlippageReport {
    return {
      timestamp: "2026-05-29T00:00:00Z",
      scanned: 0,
      backfilled: 0,
      inconclusive: 0,
      errors: [],
      severity: "ok",
      ...o,
    };
  }

  it("collapses empty case", () => {
    expect(formatBackfillSlippageReport(rep())).toBe(
      "No success swaps without realized_slippage_bps — nothing to backfill.",
    );
  });

  it("reports backfilled count", () => {
    const out = formatBackfillSlippageReport(rep({ scanned: 50, backfilled: 50 }));
    expect(out).toMatch(/50 legacy/);
    expect(out).toMatch(/backfilled:\s+50/);
    expect(out).toMatch(/All rows backfilled/);
  });

  it("surfaces inconclusive separately from errors", () => {
    const out = formatBackfillSlippageReport(rep({ scanned: 100, backfilled: 80, inconclusive: 20 }));
    expect(out).toMatch(/inconclusive:\s+20/);
    expect(out).toMatch(/no_match\/unknown/);
    expect(out).not.toMatch(/! errors:/);
  });

  it("renders errors with details", () => {
    const out = formatBackfillSlippageReport(
      rep({
        scanned: 5,
        backfilled: 3,
        errors: [{ chain: "polygon", txHash: "0xabc", message: "RPC down" }],
      }),
    );
    expect(out).toMatch(/! errors:\s+1/);
    expect(out).toMatch(/polygon/);
  });

  it("hints at re-running when scanned >= 200 (hit the default limit)", () => {
    const out = formatBackfillSlippageReport(rep({ scanned: 200, backfilled: 200 }));
    expect(out).toMatch(/re-run/i);
  });
});

// ── formatBackfillGasUsdReport (iter654) ───────────────────

describe("formatBackfillGasUsdReport", () => {
  function rep(o: Partial<BackfillGasUsdReport> = {}): BackfillGasUsdReport {
    return {
      timestamp: "2026-05-29T00:00:00Z",
      scanned: 0,
      backfilled: 0,
      noOracle: 0,
      apiFailed: 0,
      errors: [],
      severity: "ok",
      ...o,
    };
  }

  it("collapses empty case", () => {
    expect(formatBackfillGasUsdReport(rep())).toBe(
      "No success swaps without gas_cost_usd_at_trade — nothing to backfill.",
    );
  });

  it("reports backfilled count + congratulation on full backfill", () => {
    const out = formatBackfillGasUsdReport(rep({ scanned: 50, backfilled: 50 }));
    expect(out).toMatch(/50 legacy/);
    expect(out).toMatch(/backfilled:\s+50/);
    expect(out).toMatch(/All rows backfilled/);
  });

  it("surfaces noOracle separately (permanent state)", () => {
    const out = formatBackfillGasUsdReport(rep({ scanned: 100, backfilled: 90, noOracle: 10 }));
    expect(out).toMatch(/no oracle:\s+10/);
    expect(out).toMatch(/permanent/);
  });

  it("surfaces apiFailed separately (retryable)", () => {
    const out = formatBackfillGasUsdReport(rep({ scanned: 100, backfilled: 80, apiFailed: 20 }));
    expect(out).toMatch(/api failed:\s+20/);
    expect(out).toMatch(/re-run later/);
  });

  it("hints at re-running when scanned >= 200 (hit the default limit)", () => {
    const out = formatBackfillGasUsdReport(rep({ scanned: 200, backfilled: 200 }));
    expect(out).toMatch(/re-run/i);
  });

  it("renders errors with details", () => {
    const out = formatBackfillGasUsdReport(
      rep({
        scanned: 5,
        backfilled: 3,
        errors: [{ chain: "polygon", txHash: "0xabc", message: "DB down" }],
      }),
    );
    expect(out).toMatch(/! errors:\s+1/);
    expect(out).toMatch(/polygon/);
  });
});

// ── formatBackfillAllReport (iter656) ──────────────────────

describe("formatBackfillAllReport", () => {
  function emptySub() {
    return {
      timestamp: "2026-05-29T00:00:00Z",
      scanned: 0,
      backfilled: 0,
      errors: [],
      severity: "ok" as const,
    };
  }
  function rep(o: Partial<BackfillAllReport> = {}): BackfillAllReport {
    return {
      timestamp: "2026-05-29T00:00:00Z",
      blocks: { ...emptySub(), receiptMissing: 0 } as BackfillBlocksReport,
      slippage: { ...emptySub(), inconclusive: 0 } as BackfillSlippageReport,
      gasUsd: { ...emptySub(), noOracle: 0, apiFailed: 0 } as BackfillGasUsdReport,
      revertReasons: { ...emptySub(), inconclusive: 0 } as BackfillRevertReasonReport,
      totalBackfilled: 0,
      // Iter723: phaseTimingMs is required on BackfillAllReport.
      phaseTimingMs: { blocks: 0, slippage: 0, gasUsd: 0, revertReasons: 0, totalMs: 0 },
      // Iter804: severity is required on BackfillAllReport.
      severity: "ok",
      ...o,
    };
  }

  it("renders the composite header + each sub-report", () => {
    const out = formatBackfillAllReport(rep({
      totalBackfilled: 250,
      blocks: { ...emptySub(), scanned: 100, backfilled: 100, receiptMissing: 0 } as BackfillBlocksReport,
      slippage: { ...emptySub(), scanned: 80, backfilled: 80, inconclusive: 0 } as BackfillSlippageReport,
      gasUsd: { ...emptySub(), scanned: 70, backfilled: 70, noOracle: 0, apiFailed: 0 } as BackfillGasUsdReport,
    }));
    expect(out).toMatch(/Backfill all/);
    expect(out).toMatch(/Total rows backfilled across modes: 250/);
    expect(out).toMatch(/block_number/);
    expect(out).toMatch(/realized_slippage_bps/);
    expect(out).toMatch(/gas_cost_usd_at_trade/);
  });

  it("surfaces re-run hint when any mode hit its per-run limit", () => {
    const out = formatBackfillAllReport(rep({
      blocks: { ...emptySub(), scanned: 500, backfilled: 500, receiptMissing: 0 } as BackfillBlocksReport,
    }));
    expect(out).toMatch(/re-run.*backfill-all/i);
  });

  it("no re-run hint when all modes finished cleanly under their limits", () => {
    const out = formatBackfillAllReport(rep({
      blocks: { ...emptySub(), scanned: 100, backfilled: 100, receiptMissing: 0 } as BackfillBlocksReport,
      slippage: { ...emptySub(), scanned: 50, backfilled: 50, inconclusive: 0 } as BackfillSlippageReport,
      gasUsd: { ...emptySub(), scanned: 30, backfilled: 30, noOracle: 0, apiFailed: 0 } as BackfillGasUsdReport,
    }));
    expect(out).not.toMatch(/re-run.*backfill-all/i);
  });
});
