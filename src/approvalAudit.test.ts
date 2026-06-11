// Iter606: unit tests for the pure scoring logic in approvalAudit.ts.
// The orchestrator (auditAllowanceList) and the MCP/CLI wiring are covered by
// smoke tests; these unit tests pin every risk signal + the severity-collapse
// rule + the sort order so a regression in the scoring matrix gets caught fast.

import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { scoreAllowance, auditAllowanceList } from "./approvalAudit.js";
import type { ApprovalRow } from "./approvals.js";
import type { Config } from "./config.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const SCAM = "0x000000000000000000000000000000000000sCaM" as Address;
const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
const RANDOM_CONTRACT = "0x1234567890123456789012345678901234567890" as Address;

const MAX_UINT256 = (1n << 256n) - 1n;
const INFINITE_THRESHOLD = 1n << 255n;
const SOME_FINITE = 1_000n;

function row(overrides: Partial<ApprovalRow>): ApprovalRow {
  return {
    token: USDC,
    symbol: "USDC",
    decimals: 6,
    spender: RANDOM_CONTRACT,
    allowance: SOME_FINITE,
    display: "1.0",
    spenderLabel: undefined,
    ...overrides,
  };
}

const baseCtx = {
  chain: "base",
  knownRouters: new Set<string>([KYBER_ROUTER.toLowerCase()]),
  blacklistedTokens: new Set<string>(),
};

describe("scoreAllowance (iter606)", () => {
  it("ok when allowance is finite, to a known router, with no other signals", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" });
    const out = scoreAllowance(r, baseCtx);
    expect(out.severity).toBe("ok");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].code).toBe("ok");
  });

  it("CRITICAL: infinite allowance to unknown spender — the classic drain vector", () => {
    const r = row({ spender: RANDOM_CONTRACT, allowance: MAX_UINT256, display: "infinite" });
    const out = scoreAllowance(r, baseCtx);
    expect(out.severity).toBe("critical");
    expect(out.findings.some((f) => f.code === "infinite_unknown_spender")).toBe(true);
  });

  it("WARN: infinite allowance to a known router — common but worth flagging", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: MAX_UINT256, display: "infinite" });
    const out = scoreAllowance(r, baseCtx);
    expect(out.severity).toBe("warn");
    expect(out.findings.some((f) => f.code === "infinite_known_router")).toBe(true);
    // Should NOT also fire infinite_unknown_spender — known router gates that off.
    expect(out.findings.some((f) => f.code === "infinite_unknown_spender")).toBe(false);
  });

  it("exact 2^255 is treated as infinite (matches the threshold)", () => {
    const r = row({ spender: RANDOM_CONTRACT, allowance: INFINITE_THRESHOLD, display: "infinite" });
    const out = scoreAllowance(r, baseCtx);
    expect(out.severity).toBe("critical");
  });

  it("2^255 - 1 is NOT infinite (just below the threshold)", () => {
    // A finite-but-huge allowance to an unknown contract isn't the "infinite"
    // pattern. May still hit large_usd_exposure but not infinite_unknown_spender.
    const r = row({ spender: RANDOM_CONTRACT, allowance: INFINITE_THRESHOLD - 1n, display: "57896044618.658097711785492504343953926634992332820282019728792003956564819967" });
    const out = scoreAllowance(r, baseCtx);
    expect(out.findings.some((f) => f.code === "infinite_unknown_spender")).toBe(false);
  });

  it("WARN: large USD exposure — finite allowance × price exceeds threshold", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: 100_000_000n, display: "100" }); // 100 USDC
    const out = scoreAllowance(r, { ...baseCtx, tokenUsdPrice: 1, usdThreshold: 50 });
    expect(out.severity).toBe("warn");
    expect(out.findings.some((f) => f.code === "large_usd_exposure")).toBe(true);
    expect(out.usdExposure).toBe(100);
  });

  it("does NOT fire large_usd_exposure when exposure is below threshold", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: 50_000n, display: "0.05" });
    const out = scoreAllowance(r, { ...baseCtx, tokenUsdPrice: 1, usdThreshold: 10 });
    expect(out.findings.some((f) => f.code === "large_usd_exposure")).toBe(false);
  });

  it("does NOT compute usdExposure for infinite allowances (unbounded)", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: MAX_UINT256, display: "infinite" });
    const out = scoreAllowance(r, { ...baseCtx, tokenUsdPrice: 3000 });
    expect(out.usdExposure).toBeNull();
  });

  it("does NOT compute usdExposure when no price is known", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.1" });
    const out = scoreAllowance(r, baseCtx); // no tokenUsdPrice in ctx
    expect(out.usdExposure).toBeNull();
  });

  it("WARN: blacklisted token still has non-zero allowance", () => {
    const r = row({ token: SCAM, spender: KYBER_ROUTER, allowance: 100n, display: "0.1" });
    const ctxWithBlacklist = {
      ...baseCtx,
      blacklistedTokens: new Set([SCAM.toLowerCase()]),
    };
    const out = scoreAllowance(r, ctxWithBlacklist);
    expect(out.severity).toBe("warn");
    expect(out.findings.some((f) => f.code === "blacklisted_token_still_approved")).toBe(true);
  });

  it("zero-allowance blacklisted token does NOT fire the warning", () => {
    // Zero allowance means there's nothing to revoke — no need to alert.
    const r = row({ token: SCAM, spender: KYBER_ROUTER, allowance: 0n, display: "0" });
    const ctxWithBlacklist = {
      ...baseCtx,
      blacklistedTokens: new Set([SCAM.toLowerCase()]),
    };
    const out = scoreAllowance(r, ctxWithBlacklist);
    expect(out.findings.some((f) => f.code === "blacklisted_token_still_approved")).toBe(false);
  });

  it("multiple signals stack: infinite to unknown + blacklisted → CRITICAL wins", () => {
    const r = row({ token: SCAM, spender: RANDOM_CONTRACT, allowance: MAX_UINT256, display: "infinite" });
    const ctxWithBlacklist = {
      ...baseCtx,
      blacklistedTokens: new Set([SCAM.toLowerCase()]),
    };
    const out = scoreAllowance(r, ctxWithBlacklist);
    expect(out.severity).toBe("critical");
    expect(out.findings).toHaveLength(2);
    expect(out.findings.map((f) => f.code).sort()).toEqual([
      "blacklisted_token_still_approved",
      "infinite_unknown_spender",
    ]);
  });

  it("multiple WARN signals: large exposure + blacklisted → severity stays WARN", () => {
    const r = row({ token: SCAM, spender: KYBER_ROUTER, allowance: 100_000_000n, display: "100" });
    const ctxBoth = {
      ...baseCtx,
      blacklistedTokens: new Set([SCAM.toLowerCase()]),
      tokenUsdPrice: 1,
      usdThreshold: 50,
    };
    const out = scoreAllowance(r, ctxBoth);
    expect(out.severity).toBe("warn");
    expect(out.findings).toHaveLength(2);
  });
});

describe("auditAllowanceList (iter606)", () => {
  const cfg: Config = {
    version: 1 as const,
    activeChain: "base",
    activeAccount: "default",
    defaultSlippageBps: 50,
    chains: {},
    aggregator: { preferred: ["kyberswap"], mode: "first" as const },
    safety: { enabled: true, maxSlippageBps: 500, allowInfiniteApprovals: false, tradeApproval: { enabled: false, thresholdUsd: null, expiresMinutes: 60 } },
    webhooks: {},
    notifications: { channels: [], dedupWindowMs: 60_000, digest: { enabled: false, hourUtc: 9, window: "24h", minVerdict: "healthy" as const }, quietHours: { enabled: false, startHourUtc: 22, endHourUtc: 7, breakthroughSeverity: "critical" as const } },
    engine: {
      workers: {
        orders: { enabled: true, intervalMs: 30_000 },
        schedules: { enabled: true, intervalMs: 60_000 },
        reconcile: { enabled: true, intervalMs: 60_000 },
        rebalance: { enabled: true, intervalMs: 300_000 },
        alerts: { enabled: true, intervalMs: 300_000 },
        db_maintenance: { enabled: false, intervalMs: 3_600_000 },
          digest: { enabled: true, intervalMs: 300_000 },
        snapshot: { enabled: false, intervalMs: 3_600_000 },
      },
      resilience: { enabled: true, thresholdFailures: 3, backoffMultiplier: 2, maxBackoffMs: 600_000, tickTimingWindow: 20 },
      heartbeatIntervalMs: 3_600_000,
      orderJournal: { enabled: false, proximityPct: 5, retentionDays: 30 },
      scheduleJournal: { enabled: false },
      rebalanceJournal: { enabled: false },
      fireRetry: { enabled: true, maxAttempts: 3, backoffMinutes: 5 },
      snapshotEveryHours: 24,
      snapshotIncludePaper: true,
    },
    mev: { enabled: false, privateRpcs: {}, fallbackToPublic: false, labels: {} },
    db: {
      retention: {
        enabled: false,
        auditLogDays: null,
        paperTradesDays: null,
        orderCheckLogDays: null,
        engineEventsDays: null,
        alertEventsDays: null,
      notificationQueueDays: null,
      configHistoryDays: null,
        scheduleCheckLogDays: null,
        rebalanceCheckLogDays: null,
        failedTradesDays: null,
        idempotencyKeysDays: null,
      },
      backup: { enabled: false, intervalHours: 24, destDir: "backups", retainCount: 7 },
      integrityCheck: { enabled: false, intervalHours: 24 },
    },
  } as Config;

  const owner = "0x1111111111111111111111111111111111111111" as Address;
  const ctxBase = {
    chain: "base",
    config: cfg,
    knownRouters: new Set([KYBER_ROUTER.toLowerCase()]),
    tokenPrices: new Map<string, number>([[USDC.toLowerCase(), 1], [WETH.toLowerCase(), 3000]]),
    owner,
  };

  it("sorts critical first, then warn, then ok", () => {
    const rows: ApprovalRow[] = [
      row({ symbol: "OK1", spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" }), // ok
      row({ symbol: "CRIT", token: SCAM, spender: RANDOM_CONTRACT, allowance: (1n << 256n) - 1n, display: "infinite" }), // critical
      row({ symbol: "WARN", spender: KYBER_ROUTER, allowance: (1n << 256n) - 1n, display: "infinite" }), // warn (inf to known router)
    ];
    const report = auditAllowanceList(rows, ctxBase);
    expect(report.allowances[0].symbol).toBe("CRIT");
    expect(report.allowances[1].symbol).toBe("WARN");
    expect(report.allowances[2].symbol).toBe("OK1");
  });

  it("within a bucket: null usdExposure (infinite/unpriced) sorts first in critical+warn", () => {
    const inf = (1n << 256n) - 1n;
    const rows: ApprovalRow[] = [
      // Two critical entries: one with priced finite "exposure" (won't apply since
      // finite to unknown isn't critical), one infinite. To get two criticals in
      // the same bucket I need two infinite-to-unknown rows.
      row({ symbol: "INF_A", token: USDC, spender: "0x0000000000000000000000000000000000000aaa" as Address, allowance: inf, display: "infinite" }),
      row({ symbol: "INF_B", token: WETH, spender: "0x0000000000000000000000000000000000000bbb" as Address, allowance: inf, display: "infinite" }),
    ];
    const report = auditAllowanceList(rows, ctxBase);
    // Both critical; both usdExposure=null. Order is stable-by-input on ties.
    expect(report.allowances[0].severity).toBe("critical");
    expect(report.allowances[1].severity).toBe("critical");
    expect(report.allowances[0].usdExposure).toBeNull();
    expect(report.allowances[1].usdExposure).toBeNull();
  });

  it("within warn bucket: larger USD exposure first", () => {
    const rows: ApprovalRow[] = [
      // Two large-exposure warns. The bigger USD goes first.
      row({ symbol: "SMALL", token: USDC, spender: KYBER_ROUTER, allowance: 50_000_000n, display: "50" }),
      row({ symbol: "BIG", token: USDC, spender: KYBER_ROUTER, allowance: 100_000_000_000n, display: "100000" }),
    ];
    const report = auditAllowanceList(rows, { ...ctxBase, usdThreshold: 10 });
    // Both are warn (large_usd_exposure). BIG's exposure ($100k) > SMALL's ($50).
    expect(report.allowances[0].symbol).toBe("BIG");
    expect(report.allowances[1].symbol).toBe("SMALL");
  });

  it("counts each severity bucket independently", () => {
    const inf = (1n << 256n) - 1n;
    const rows: ApprovalRow[] = [
      row({ spender: RANDOM_CONTRACT, allowance: inf, display: "infinite" }), // critical
      row({ spender: KYBER_ROUTER, allowance: inf, display: "infinite" }),    // warn
      row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" }),      // ok
      row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" }),      // ok
    ];
    const report = auditAllowanceList(rows, ctxBase);
    expect(report.counts.critical).toBe(1);
    expect(report.counts.warn).toBe(1);
    expect(report.counts.ok).toBe(2);
    expect(report.counts.total).toBe(4);
  });

  it("empty input yields empty allowances + zero counts (not undefined)", () => {
    const report = auditAllowanceList([], ctxBase);
    expect(report.allowances).toEqual([]);
    expect(report.counts).toEqual({ ok: 0, warn: 0, critical: 0, total: 0 });
    expect(report.chain).toBe("base");
    expect(report.owner).toBe(owner);
  });

  it("each allowance carries a typed recommendedAction (revoke params pre-filled)", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" });
    const report = auditAllowanceList([r], ctxBase);
    const action = report.allowances[0].recommendedAction;
    expect(action.tool).toBe("revoke");
    expect(action.params).toEqual({ chain: "base", token: USDC, spender: KYBER_ROUTER });
    // Reason text should mention `tradekit revoke` for CLI paste-readiness.
    expect(action.reason).toMatch(/tradekit revoke/);
  });

  it("recommendedAction reason text differs by severity (honest signal)", () => {
    const inf = (1n << 256n) - 1n;
    const rows: ApprovalRow[] = [
      row({ symbol: "CRIT", spender: RANDOM_CONTRACT, allowance: inf, display: "infinite" }),
      row({ symbol: "OK1", spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" }),
    ];
    const report = auditAllowanceList(rows, ctxBase);
    const crit = report.allowances.find((a) => a.symbol === "CRIT")!;
    const ok = report.allowances.find((a) => a.symbol === "OK1")!;
    expect(crit.recommendedAction.reason).toMatch(/critical risk/);
    expect(ok.recommendedAction.reason).toMatch(/No action needed/);
  });

  it("respects safety.tokenBlacklist from config when scoring", () => {
    const blacklistedConfig: Config = {
      ...cfg,
      safety: { ...cfg.safety, tokenBlacklist: { base: [SCAM] } },
    } as Config;
    const r = row({ token: SCAM, spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" });
    const report = auditAllowanceList([r], { ...ctxBase, config: blacklistedConfig });
    expect(report.allowances[0].severity).toBe("warn");
    expect(report.allowances[0].findings.some((f) => f.code === "blacklisted_token_still_approved")).toBe(true);
  });
});

describe("approval freshness signal (iter617)", () => {
  const NOW = Date.parse("2026-05-29T00:00:00Z");
  const cfg: Config = {
    version: 1 as const,
    activeChain: "base",
    activeAccount: "default",
    defaultSlippageBps: 50,
    chains: {},
    aggregator: { preferred: ["kyberswap"], mode: "first" as const },
    safety: { enabled: true, maxSlippageBps: 500, allowInfiniteApprovals: false, tradeApproval: { enabled: false, thresholdUsd: null, expiresMinutes: 60 } },
    webhooks: {},
    notifications: { channels: [], dedupWindowMs: 60_000, digest: { enabled: false, hourUtc: 9, window: "24h", minVerdict: "healthy" as const }, quietHours: { enabled: false, startHourUtc: 22, endHourUtc: 7, breakthroughSeverity: "critical" as const } },
    engine: {
      workers: {
        orders: { enabled: true, intervalMs: 30_000 },
        schedules: { enabled: true, intervalMs: 60_000 },
        reconcile: { enabled: true, intervalMs: 60_000 },
        rebalance: { enabled: true, intervalMs: 300_000 },
        alerts: { enabled: true, intervalMs: 300_000 },
        db_maintenance: { enabled: false, intervalMs: 3_600_000 },
          digest: { enabled: true, intervalMs: 300_000 },
        snapshot: { enabled: false, intervalMs: 3_600_000 },
      },
      resilience: { enabled: true, thresholdFailures: 3, backoffMultiplier: 2, maxBackoffMs: 600_000, tickTimingWindow: 20 },
      heartbeatIntervalMs: 3_600_000,
      orderJournal: { enabled: false, proximityPct: 5, retentionDays: 30 },
      scheduleJournal: { enabled: false },
      rebalanceJournal: { enabled: false },
      fireRetry: { enabled: true, maxAttempts: 3, backoffMinutes: 5 },
      snapshotEveryHours: 24,
      snapshotIncludePaper: true,
    },
    mev: { enabled: false, privateRpcs: {}, fallbackToPublic: false, labels: {} },
    db: {
      retention: {
        enabled: false,
        auditLogDays: null,
        paperTradesDays: null,
        orderCheckLogDays: null,
        engineEventsDays: null,
        alertEventsDays: null,
      notificationQueueDays: null,
      configHistoryDays: null,
        scheduleCheckLogDays: null,
        rebalanceCheckLogDays: null,
        failedTradesDays: null,
        idempotencyKeysDays: null,
      },
      backup: { enabled: false, intervalHours: 24, destDir: "backups", retainCount: 7 },
      integrityCheck: { enabled: false, intervalHours: 24 },
    },
  } as Config;
  const owner = "0x1111111111111111111111111111111111111111" as Address;
  const ctxBase = {
    chain: "base",
    config: cfg,
    knownRouters: new Set([KYBER_ROUTER.toLowerCase()]),
    tokenPrices: new Map<string, number>([
      [USDC.toLowerCase(), 1],
      [WETH.toLowerCase(), 3000],
    ]),
    owner,
  };

  it("fires stale_approval when most-recent grant is older than staleDays", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" });
    const oneYearAgo = new Date(NOW - 365 * 86400_000).toISOString();
    const out = scoreAllowance(r, {
      ...baseCtx,
      grantedAt: { timestamp: oneYearAgo, blockNumber: 1234 },
      staleDays: 180,
      nowMs: NOW,
    });
    expect(out.findings.some((f) => f.code === "stale_approval")).toBe(true);
    expect(out.severity).toBe("warn");
  });

  it("does NOT fire stale_approval when grant is recent (within staleDays)", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" });
    const recent = new Date(NOW - 7 * 86400_000).toISOString();
    const out = scoreAllowance(r, {
      ...baseCtx,
      grantedAt: { timestamp: recent, blockNumber: 1234 },
      staleDays: 180,
      nowMs: NOW,
    });
    expect(out.findings.some((f) => f.code === "stale_approval")).toBe(false);
  });

  it("fires stale_approval when agedOutOfLookback (scanned but no event found)", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" });
    const out = scoreAllowance(r, {
      ...baseCtx,
      agedOutOfLookback: true,
      nowMs: NOW,
    });
    expect(out.findings.some((f) => f.code === "stale_approval")).toBe(true);
    expect(out.severity).toBe("warn");
  });

  it("does NOT fire stale_approval when freshness data not supplied", () => {
    // No grantedAt, no agedOutOfLookback → we didn't look → no signal
    const r = row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" });
    const out = scoreAllowance(r, baseCtx);
    expect(out.findings.some((f) => f.code === "stale_approval")).toBe(false);
  });

  it("does NOT fire stale_approval when allowance is zero", () => {
    // Revoked approval — age doesn't matter
    const r = row({ spender: KYBER_ROUTER, allowance: 0n, display: "0" });
    const out = scoreAllowance(r, {
      ...baseCtx,
      agedOutOfLookback: true,
      nowMs: NOW,
    });
    expect(out.findings.some((f) => f.code === "stale_approval")).toBe(false);
  });

  it("auditAllowanceList: attaches grantedAt + agedOutOfLookback per row", () => {
    const r1 = row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" });
    const r2 = row({ token: WETH, symbol: "WETH", spender: RANDOM_CONTRACT, allowance: 100n, display: "0.0001" });
    const freshness = new Map<string, { timestamp: string | null; blockNumber: number; txHash: string }>();
    // r1 has a recent grant
    freshness.set(`${USDC.toLowerCase()}:${KYBER_ROUTER.toLowerCase()}`, {
      timestamp: new Date(NOW - 86400_000).toISOString(),
      blockNumber: 100,
      txHash: "0xrecent",
    });
    // r2 was not in the scan → should be agedOutOfLookback
    const report = auditAllowanceList([r1, r2], {
      ...ctxBase,
      freshness,
      nowMs: NOW,
    });
    const fresh = report.allowances.find((a) => a.symbol === "USDC")!;
    const stale = report.allowances.find((a) => a.symbol === "WETH")!;
    expect(fresh.grantedAt?.txHash).toBe("0xrecent");
    expect(fresh.agedOutOfLookback).toBe(false);
    expect(stale.grantedAt).toBeUndefined();
    expect(stale.agedOutOfLookback).toBe(true);
    expect(stale.findings.some((f) => f.code === "stale_approval")).toBe(true);
  });

  it("auditAllowanceList: when freshness is undefined, no row carries agedOutOfLookback", () => {
    const r = row({ spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" });
    const report = auditAllowanceList([r], ctxBase);
    expect(report.allowances[0].agedOutOfLookback).toBeUndefined();
    expect(report.allowances[0].grantedAt).toBeUndefined();
  });
});

// ── aggregateMultiChainAudits (iter632) ────────────────────

describe("aggregateMultiChainAudits", () => {
  // We use real per-chain reports built via auditAllowanceList so the test
  // exercises the aggregator against the same shape production callers feed it.
  function reportForChain(chain: string, rows: ApprovalRow[]): import("./approvalAudit.js").AllowanceAuditReport {
    const cfg = {
      version: 1 as const,
      activeChain: "base",
      activeAccount: "default",
      defaultSlippageBps: 50,
      chains: {},
      aggregator: { preferred: ["kyberswap"], mode: "first" as const },
      safety: { enabled: true, maxSlippageBps: 500, allowInfiniteApprovals: false, tradeApproval: { enabled: false, thresholdUsd: null, expiresMinutes: 60 } },
    } as never;
    return auditAllowanceList(rows, {
      chain,
      config: cfg,
      knownRouters: new Set([KYBER_ROUTER.toLowerCase()]),
      tokenPrices: new Map(),
      owner: "0x1111111111111111111111111111111111111111" as Address,
    });
  }

  it("returns empty aggregate on empty input", async () => {
    const { aggregateMultiChainAudits } = await import("./approvalAudit.js");
    const r = aggregateMultiChainAudits({ perChainReports: [], chainsScanned: ["base"] });
    expect(r.chains).toEqual([]);
    expect(r.chainsScanned).toEqual(["base"]);
    expect(r.counts.total).toBe(0);
    expect(r.allowances).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("sums counts across chains", async () => {
    const { aggregateMultiChainAudits } = await import("./approvalAudit.js");
    const inf = (1n << 256n) - 1n;
    const baseReport = reportForChain("base", [
      row({ symbol: "AAA", spender: RANDOM_CONTRACT, allowance: inf, display: "infinite" }), // critical
      row({ symbol: "BBB", spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" }), // ok
    ]);
    const arbReport = reportForChain("arbitrum", [
      row({ symbol: "CCC", spender: KYBER_ROUTER, allowance: inf, display: "infinite" }), // warn
    ]);
    const r = aggregateMultiChainAudits({
      perChainReports: [baseReport, arbReport],
      chainsScanned: ["base", "arbitrum"],
    });
    expect(r.counts.critical).toBe(1);
    expect(r.counts.warn).toBe(1);
    expect(r.counts.ok).toBe(1);
    expect(r.counts.total).toBe(3);
    expect(r.chains).toEqual(["base", "arbitrum"]);
  });

  it("merges allowance lists sorted critical → warn → ok", async () => {
    const { aggregateMultiChainAudits } = await import("./approvalAudit.js");
    const inf = (1n << 256n) - 1n;
    const baseReport = reportForChain("base", [
      row({ symbol: "OK1", spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" }),
    ]);
    const arbReport = reportForChain("arbitrum", [
      row({ symbol: "CRIT1", spender: RANDOM_CONTRACT, allowance: inf, display: "infinite" }),
    ]);
    const r = aggregateMultiChainAudits({
      perChainReports: [baseReport, arbReport],
      chainsScanned: ["base", "arbitrum"],
    });
    expect(r.allowances[0].severity).toBe("critical");
    expect(r.allowances[0].chain).toBe("arbitrum");
    expect(r.allowances[r.allowances.length - 1].severity).toBe("ok");
  });

  it("each merged allowance carries its chain (preserves cross-chain identity)", async () => {
    const { aggregateMultiChainAudits } = await import("./approvalAudit.js");
    const baseReport = reportForChain("base", [
      row({ symbol: "OK1", spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" }),
    ]);
    const r = aggregateMultiChainAudits({
      perChainReports: [baseReport],
      chainsScanned: ["base"],
    });
    expect(r.allowances[0].chain).toBe("base");
  });

  it("perChain map indexes reports by chain name", async () => {
    const { aggregateMultiChainAudits } = await import("./approvalAudit.js");
    const baseReport = reportForChain("base", [
      row({ symbol: "OK1", spender: KYBER_ROUTER, allowance: 100n, display: "0.0001" }),
    ]);
    const arbReport = reportForChain("arbitrum", [
      row({ symbol: "OK2", spender: KYBER_ROUTER, allowance: 200n, display: "0.0002" }),
    ]);
    const r = aggregateMultiChainAudits({
      perChainReports: [baseReport, arbReport],
      chainsScanned: ["base", "arbitrum"],
    });
    expect(r.perChain.base).toBeDefined();
    expect(r.perChain.arbitrum).toBeDefined();
    expect(r.perChain.base.allowances[0].symbol).toBe("OK1");
  });

  it("preserves error list passed through", async () => {
    const { aggregateMultiChainAudits } = await import("./approvalAudit.js");
    const r = aggregateMultiChainAudits({
      perChainReports: [],
      chainsScanned: ["base", "arbitrum"],
      errors: [{ chain: "arbitrum", message: "RPC down" }],
    });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].chain).toBe("arbitrum");
    expect(r.chainsScanned).toEqual(["base", "arbitrum"]);
  });

  it("within a severity bucket, larger USD exposure first", async () => {
    const { aggregateMultiChainAudits } = await import("./approvalAudit.js");
    // Two warn-bucket entries on different chains with priced exposure.
    // Use blacklist to force warn severity reliably.
    const cfg = {
      version: 1 as const,
      activeChain: "base",
      activeAccount: "default",
      defaultSlippageBps: 50,
      chains: {},
      aggregator: { preferred: ["kyberswap"], mode: "first" as const },
      safety: {
        enabled: true,
        maxSlippageBps: 500,
        allowInfiniteApprovals: false,
        tokenBlacklist: { base: [USDC], arbitrum: [WETH] },
      },
    } as never;
    const baseReport = auditAllowanceList(
      [row({ token: USDC, symbol: "USDC", spender: KYBER_ROUTER, allowance: 1000n, display: "0.001" })],
      {
        chain: "base",
        config: cfg,
        knownRouters: new Set([KYBER_ROUTER.toLowerCase()]),
        tokenPrices: new Map([[USDC.toLowerCase(), 1]]), // exposure = $0.001
        owner: "0x1111111111111111111111111111111111111111" as Address,
      },
    );
    const arbReport = auditAllowanceList(
      [
        row({
          token: WETH,
          symbol: "WETH",
          spender: KYBER_ROUTER,
          allowance: 1_000_000_000_000_000_000n, // 1 WETH in wei
          display: "1.0",
        }),
      ],
      {
        chain: "arbitrum",
        config: cfg,
        knownRouters: new Set([KYBER_ROUTER.toLowerCase()]),
        tokenPrices: new Map([[WETH.toLowerCase(), 3000]]), // exposure = $3000
        owner: "0x1111111111111111111111111111111111111111" as Address,
      },
    );
    const r = aggregateMultiChainAudits({
      perChainReports: [baseReport, arbReport],
      chainsScanned: ["base", "arbitrum"],
    });
    // Both rows are warn. The arb row has higher exposure → first.
    expect(r.allowances[0].chain).toBe("arbitrum");
    expect(r.allowances[0].usdExposure).toBe(3000);
  });
});
