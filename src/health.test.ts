// Iter621: tests for the pure helpers in health.ts. The orchestrator
// (the CLI/MCP wiring) is HTTP+DB-bound; the composition rules + the
// formatters live here so unit tests can pin every next-action rule + delta
// math without standing up a full RPC stack.

import { describe, expect, it } from "vitest";
import {
  composeHealthReport,
  buildPortfolioSection,
  buildPnLSection,
  buildSecuritySection,
  buildTradesSection,
  deriveNextActions,
  formatUsdDelta,
  medianAndAvg,
} from "./health.js";
import type { Address } from "viem";
import type { PortfolioReport } from "./portfolio.js";
import type { PnLReport } from "./pnl.js";
import type { AllowanceAuditReport } from "./approvalAudit.js";
import type { AnalyzedTrade } from "./tradeAnalysis.js";
import type { TradeRow } from "./db.js";

// ── fixtures ───────────────────────────────────────────────

function makePortfolio(overrides: Partial<PortfolioReport> = {}): PortfolioReport {
  return {
    timestamp: "2026-05-29T00:00:00.000Z",
    accounts: [{ label: "alice", address: "0x1111111111111111111111111111111111111111" as Address }],
    chains: ["base"],
    snapshots: [],
    errors: [],
    totalUsd: 10000,
    unpricedPositionCount: 0,
    tokens: [
      { symbol: "ETH", tokenKey: "NATIVE", perChain: [{ chain: "base", address: "NATIVE" as const, amount: "3.0", usd: 8000 }], totalUsd: 8000, percentOfPortfolio: 80 },
      { symbol: "USDC", tokenKey: "0xusdc", perChain: [{ chain: "base", address: "0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address, amount: "2000", usd: 2000 }], totalUsd: 2000, percentOfPortfolio: 20 },
    ],
    concentration: { top1: 80, top3: 100, top5: 100 },
    severity: "ok",
    recommendedActions: [],
    ...overrides,
  };
}

// ── medianAndAvg ───────────────────────────────────────────

describe("medianAndAvg", () => {
  it("returns null/null/0 for empty input", () => {
    expect(medianAndAvg([])).toEqual({ median: null, avg: null, count: 0 });
  });

  it("filters non-finite values", () => {
    const r = medianAndAvg([NaN, Infinity, 10, 20, 30]);
    expect(r.count).toBe(3);
    expect(r.median).toBe(20);
    expect(r.avg).toBe(20);
  });

  it("median of odd-length", () => {
    expect(medianAndAvg([1, 2, 3]).median).toBe(2);
  });
});

// ── deriveNextActions ──────────────────────────────────────

describe("deriveNextActions", () => {
  it("suggests reconcile when there are pending trades", () => {
    const actions = deriveNextActions({
      trades: { total: 5, successCount: 3, failedCount: 0, pendingCount: 2, byVerdict: {}, failureReasons: [], aggregatorWarnings: [], pairWarnings: [] },
    });
    expect(actions.find((a) => a.code === "reconcile_pending")).toBeDefined();
  });

  it("suggests revoke when critical approvals exist", () => {
    const actions = deriveNextActions({
      security: { totalApprovals: 10, criticalCount: 1, warnCount: 2, topConcerns: [] },
    });
    expect(actions.find((a) => a.code === "revoke_critical")).toBeDefined();
  });

  it("suggests stale_snapshot when last snapshot is >30 days old", () => {
    const actions = deriveNextActions({ daysSinceLastSnapshot: 45 });
    expect(actions.find((a) => a.code === "stale_snapshot")).toBeDefined();
  });

  it("does NOT suggest stale_snapshot at exactly 30 days (just over the threshold)", () => {
    const actions = deriveNextActions({ daysSinceLastSnapshot: 30 });
    expect(actions.find((a) => a.code === "stale_snapshot")).toBeUndefined();
  });

  it("suggests take_snapshot when no snapshot exists AND portfolio has value", () => {
    const actions = deriveNextActions({
      portfolio: {
        totalUsd: 100,
        positionCount: 1,
        unpricedCount: 0,
        top: [],
        concentration: { top1: 0, top3: 0, top5: 0 },
      },
    });
    expect(actions.find((a) => a.code === "take_snapshot")).toBeDefined();
  });

  it("does NOT suggest take_snapshot for an empty portfolio", () => {
    const actions = deriveNextActions({
      portfolio: {
        totalUsd: 0,
        positionCount: 0,
        unpricedCount: 0,
        top: [],
        concentration: { top1: 0, top3: 0, top5: 0 },
      },
    });
    expect(actions.find((a) => a.code === "take_snapshot")).toBeUndefined();
  });

  it("suggests audit_approvals when warnCount >= 5", () => {
    const actions = deriveNextActions({
      security: { totalApprovals: 20, criticalCount: 0, warnCount: 7, topConcerns: [] },
    });
    expect(actions.find((a) => a.code === "audit_approvals")).toBeDefined();
  });

  it("section absence skips that section's rules without crashing", () => {
    // Only pass security; rules touching other sections should silently skip.
    const actions = deriveNextActions({
      security: { totalApprovals: 5, criticalCount: 0, warnCount: 0, topConcerns: [] },
    });
    expect(actions).toEqual([]);
  });

  it("iter655: fires backfill_blocks when count >= 50", () => {
    const actions = deriveNextActions({
      legacyBackfillCounts: { missingBlockNumber: 100, missingSlippage: 0, missingGasUsd: 0, missingRevertReason: 0 },
    });
    expect(actions.find((a) => a.code === "backfill_blocks")).toBeDefined();
    expect(actions.find((a) => a.code === "backfill_blocks")?.command).toMatch(/--backfill-blocks/);
  });

  it("iter743: fires stale_sync (high severity) when staleBookmarks supplied", () => {
    const actions = deriveNextActions({
      staleBookmarks: [{ chain: "base", account: "main", ageHours: 72 }],
    });
    const a = actions.find((x) => x.code === "stale_sync");
    expect(a).toBeDefined();
    expect(a?.severity).toBe("high");
    expect(a?.message).toMatch(/base\/main/);
    expect(a?.message).toMatch(/3\.0d/); // 72h → 3.0d
    expect(a?.command).toMatch(/tradekit trades sync --chain base --account main/);
  });

  it("iter743: picks the OLDEST staleBookmark for the inline reference + appends '(+N more)'", () => {
    const actions = deriveNextActions({
      staleBookmarks: [
        { chain: "base", account: "main", ageHours: 72 },
        { chain: "arbitrum", account: "swing", ageHours: 120 }, // oldest
        { chain: "base", account: "bot", ageHours: 60 },
      ],
    });
    const a = actions.find((x) => x.code === "stale_sync");
    expect(a?.message).toMatch(/arbitrum\/swing/);
    expect(a?.message).toMatch(/\(\+2 more\)/);
  });

  it("iter743: does NOT fire stale_sync when staleBookmarks is empty or undefined", () => {
    expect(deriveNextActions({ staleBookmarks: [] }).find((a) => a.code === "stale_sync")).toBeUndefined();
    expect(deriveNextActions({}).find((a) => a.code === "stale_sync")).toBeUndefined();
  });

  it("iter743: formats sub-day age in hours", () => {
    const actions = deriveNextActions({
      // 20h < 24h → formatted as hours
      staleBookmarks: [{ chain: "base", account: "main", ageHours: 20 }],
    });
    expect(actions.find((a) => a.code === "stale_sync")?.message).toMatch(/20\.0h/);
  });

  it("iter655: does NOT fire backfill rules below threshold (handful of legacy rows)", () => {
    const actions = deriveNextActions({
      legacyBackfillCounts: { missingBlockNumber: 10, missingSlippage: 20, missingGasUsd: 30, missingRevertReason: 0 },
    });
    expect(actions.find((a) => a.code === "backfill_blocks")).toBeUndefined();
    expect(actions.find((a) => a.code === "backfill_slippage")).toBeUndefined();
    expect(actions.find((a) => a.code === "backfill_gas_usd")).toBeUndefined();
  });

  it("iter655/iter670: all 4 backfill rules can fire simultaneously", () => {
    const actions = deriveNextActions({
      legacyBackfillCounts: { missingBlockNumber: 100, missingSlippage: 100, missingGasUsd: 100, missingRevertReason: 50 },
    });
    expect(actions.find((a) => a.code === "backfill_blocks")).toBeDefined();
    expect(actions.find((a) => a.code === "backfill_slippage")).toBeDefined();
    expect(actions.find((a) => a.code === "backfill_gas_usd")).toBeDefined();
    expect(actions.find((a) => a.code === "backfill_revert_reasons")).toBeDefined();
  });

  it("iter671: frequent_failure_reason fires when a non-unknown reason has count >= 3", () => {
    const actions = deriveNextActions({
      trades: {
        total: 10,
        successCount: 5,
        failedCount: 5,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [
          { reason: "Too little received", count: 4 },
          { reason: "STF", count: 1 },
        ],
        aggregatorWarnings: [], pairWarnings: [],
      },
    });
    const action = actions.find((a) => a.code === "frequent_failure_reason");
    expect(action).toBeDefined();
    expect(action?.message).toMatch(/Too little received/);
    expect(action?.message).toMatch(/4 failures/);
  });

  it("iter700: frequent_failure_reason message includes dominant.lastSeen when present", () => {
    const actions = deriveNextActions({
      trades: {
        total: 10, successCount: 5, failedCount: 5, pendingCount: 0,
        byVerdict: {},
        failureReasons: [
          { reason: "Too little received", count: 4, lastSeen: "2026-05-30T02:14:33.000Z" },
        ],
        aggregatorWarnings: [],
        pairWarnings: [],
      },
    });
    const action = actions.find((a) => a.code === "frequent_failure_reason");
    expect(action?.message).toMatch(/last: 2026-05-30 02:14/);
  });

  it("iter700: frequent_failure_reason message omits lastSeen bit when absent (back-compat)", () => {
    const actions = deriveNextActions({
      trades: {
        total: 10, successCount: 5, failedCount: 5, pendingCount: 0,
        byVerdict: {},
        failureReasons: [{ reason: "Too little received", count: 4 }],
        aggregatorWarnings: [],
        pairWarnings: [],
      },
    });
    const action = actions.find((a) => a.code === "frequent_failure_reason");
    expect(action?.message).not.toMatch(/last:/);
  });

  it("iter671: does NOT fire when no reason hits the threshold", () => {
    const actions = deriveNextActions({
      trades: {
        total: 10,
        successCount: 5,
        failedCount: 4,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [
          { reason: "Too little received", count: 2 },
          { reason: "STF", count: 2 },
        ],
        aggregatorWarnings: [], pairWarnings: [],
      },
    });
    expect(actions.find((a) => a.code === "frequent_failure_reason")).toBeUndefined();
  });

  it("iter671: skips (unknown) as the dominant reason — that's a backfill signal, not operational", () => {
    const actions = deriveNextActions({
      trades: {
        total: 10,
        successCount: 0,
        failedCount: 10,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [
          { reason: "(unknown)", count: 10 },
        ],
        aggregatorWarnings: [], pairWarnings: [],
      },
    });
    expect(actions.find((a) => a.code === "frequent_failure_reason")).toBeUndefined();
  });

  it("iter671: picks the FIRST non-unknown reason at threshold (failureReasons is already sorted desc)", () => {
    // failureReasons comes back sorted by count desc — health takes the
    // first one that's both non-unknown AND >= threshold.
    const actions = deriveNextActions({
      trades: {
        total: 10,
        successCount: 0,
        failedCount: 10,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [
          { reason: "(unknown)", count: 5 },
          { reason: "Too little received", count: 4 },
          { reason: "STF", count: 1 },
        ],
        aggregatorWarnings: [], pairWarnings: [],
      },
    });
    const action = actions.find((a) => a.code === "frequent_failure_reason");
    expect(action?.message).toMatch(/Too little received/);
    expect(action?.message).not.toMatch(/STF/);
  });

  it("iter689: aggregator_underperformer fires when aggregatorWarnings has entries", () => {
    const actions = deriveNextActions({
      trades: {
        total: 50,
        successCount: 40,
        failedCount: 10,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [],
        aggregatorWarnings: [
          "openocean is underperforming on success rate: 70.0% across 20 trades (25.0 pct below the best peer at 95.0%).",
        ],
        pairWarnings: [],
      },
    });
    const action = actions.find((a) => a.code === "aggregator_underperformer");
    expect(action).toBeDefined();
    expect(action?.message).toMatch(/openocean/);
    expect(action?.command).toMatch(/aggregator stats/);
  });

  it("iter692: collapses multiple aggregator warnings into ONE summary nextAction", () => {
    const actions = deriveNextActions({
      trades: {
        total: 100,
        successCount: 70,
        failedCount: 30,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [],
        aggregatorWarnings: [
          "openocean is underperforming on success rate: ...",
          "1inch is underperforming on median slippage: ...",
        ],
        pairWarnings: [],
      },
    });
    const matching = actions.filter((a) => a.code === "aggregator_underperformer");
    expect(matching.length).toBe(1);
    expect(matching[0].message).toMatch(/2 aggregator warnings/);
    expect(matching[0].message).toMatch(/worst: openocean/);
  });

  it("iter689: no nextAction when aggregatorWarnings is empty", () => {
    const actions = deriveNextActions({
      trades: {
        total: 50,
        successCount: 50,
        failedCount: 0,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [],
        aggregatorWarnings: [], pairWarnings: [],
      },
    });
    expect(actions.find((a) => a.code === "aggregator_underperformer")).toBeUndefined();
  });

  it("iter691: pair_underperformer fires when pairWarnings has entries", () => {
    const actions = deriveNextActions({
      trades: {
        total: 50,
        successCount: 40,
        failedCount: 10,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [],
        aggregatorWarnings: [],
        pairWarnings: [
          "ETH/PEPE has high median slippage: 200.0 bps across 15 analyzed trades (185.0 bps worse than the best pair at 15.0 bps).",
        ],
      },
    });
    const action = actions.find((a) => a.code === "pair_underperformer");
    expect(action).toBeDefined();
    expect(action?.message).toMatch(/ETH\/PEPE/);
    expect(action?.command).toMatch(/pairs stats/);
  });

  it("iter692: collapses multiple pair warnings into ONE summary nextAction", () => {
    const actions = deriveNextActions({
      trades: {
        total: 100,
        successCount: 70,
        failedCount: 30,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [],
        aggregatorWarnings: [],
        pairWarnings: [
          "ETH/PEPE has high median slippage: ...",
          "ETH/PEPE fails predominantly with ...",
        ],
      },
    });
    const matching = actions.filter((a) => a.code === "pair_underperformer");
    expect(matching.length).toBe(1);
    expect(matching[0].message).toMatch(/2 pair warnings/);
  });

  it("iter693: nextActions carry severity and are sorted critical→low", () => {
    const actions = deriveNextActions({
      // Mix critical (pending) + medium (stale snapshot) + low (backfill) +
      // high (frequent_failure_reason).
      trades: {
        total: 10, successCount: 5, failedCount: 5, pendingCount: 1,
        byVerdict: {},
        failureReasons: [{ reason: "Too little received", count: 4 }],
        aggregatorWarnings: [],
        pairWarnings: [],
      },
      daysSinceLastSnapshot: 45,
      legacyBackfillCounts: { missingBlockNumber: 100, missingSlippage: 0, missingGasUsd: 0, missingRevertReason: 0 },
    });
    // Every action has severity.
    expect(actions.every((a) => ["critical", "high", "medium", "low"].includes(a.severity))).toBe(true);
    // Sorted: critical → high → medium → low.
    const severities = actions.map((a) => a.severity);
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]]).toBeGreaterThanOrEqual(rank[severities[i - 1]]);
    }
  });

  it("iter693: severity tiers are stable across iterations (regression guard)", () => {
    // Lock the severity assignments — if a future iter changes a rule's
    // severity, this test fires and the author has to update intentionally.
    const actions = deriveNextActions({
      trades: {
        total: 10, successCount: 5, failedCount: 5, pendingCount: 1,
        byVerdict: {},
        failureReasons: [{ reason: "Too little received", count: 4 }],
        aggregatorWarnings: ["x"],
        pairWarnings: ["y"],
      },
      security: { totalApprovals: 10, criticalCount: 1, warnCount: 7, topConcerns: [] },
      daysSinceLastSnapshot: 45,
      legacyBackfillCounts: { missingBlockNumber: 100, missingSlippage: 100, missingGasUsd: 100, missingRevertReason: 50 },
    });
    const map = Object.fromEntries(actions.map((a) => [a.code, a.severity]));
    expect(map.reconcile_pending).toBe("critical");
    expect(map.revoke_critical).toBe("critical");
    expect(map.frequent_failure_reason).toBe("high");
    expect(map.aggregator_underperformer).toBe("high");
    expect(map.pair_underperformer).toBe("high");
    expect(map.stale_snapshot).toBe("medium");
    expect(map.audit_approvals).toBe("medium");
    expect(map.backfill_blocks).toBe("low");
    expect(map.backfill_slippage).toBe("low");
    expect(map.backfill_gas_usd).toBe("low");
    expect(map.backfill_revert_reasons).toBe("low");
  });

  it("iter692: single warning passes through verbatim (no summary header)", () => {
    const actions = deriveNextActions({
      trades: {
        total: 50,
        successCount: 45,
        failedCount: 5,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [],
        aggregatorWarnings: ["openocean is underperforming verbatim message"],
        pairWarnings: [],
      },
    });
    const a = actions.find((x) => x.code === "aggregator_underperformer");
    expect(a?.message).toBe("openocean is underperforming verbatim message");
  });

  it("iter689+iter691: aggregator + pair warnings emit independent nextActions", () => {
    const actions = deriveNextActions({
      trades: {
        total: 100,
        successCount: 70,
        failedCount: 30,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [],
        aggregatorWarnings: ["aggregator warning string"],
        pairWarnings: ["pair warning string"],
      },
    });
    expect(actions.find((a) => a.code === "aggregator_underperformer")).toBeDefined();
    expect(actions.find((a) => a.code === "pair_underperformer")).toBeDefined();
  });

  it("iter670: backfill_revert_reasons fires at lower threshold (>=10)", () => {
    const actions = deriveNextActions({
      legacyBackfillCounts: { missingBlockNumber: 0, missingSlippage: 0, missingGasUsd: 0, missingRevertReason: 10 },
    });
    expect(actions.find((a) => a.code === "backfill_revert_reasons")).toBeDefined();
    // Below threshold: 9 < 10
    const below = deriveNextActions({
      legacyBackfillCounts: { missingBlockNumber: 0, missingSlippage: 0, missingGasUsd: 0, missingRevertReason: 9 },
    });
    expect(below.find((a) => a.code === "backfill_revert_reasons")).toBeUndefined();
  });

  it("iter655: backfill counts absent → no backfill actions (back-compat)", () => {
    const actions = deriveNextActions({});
    expect(actions.find((a) => a.code === "backfill_blocks")).toBeUndefined();
    expect(actions.find((a) => a.code === "backfill_slippage")).toBeUndefined();
    expect(actions.find((a) => a.code === "backfill_gas_usd")).toBeUndefined();
  });

  it("multiple rules can fire in the same call (composability)", () => {
    const actions = deriveNextActions({
      trades: { total: 5, successCount: 0, failedCount: 0, pendingCount: 5, byVerdict: {}, failureReasons: [], aggregatorWarnings: [], pairWarnings: [] },
      security: { totalApprovals: 20, criticalCount: 3, warnCount: 8, topConcerns: [] },
      daysSinceLastSnapshot: 60,
    });
    expect(actions.length).toBe(4); // reconcile + revoke + stale + audit
    expect(actions.map((a) => a.code).sort()).toEqual(
      ["audit_approvals", "reconcile_pending", "revoke_critical", "stale_snapshot"].sort(),
    );
  });
});

// ── buildPortfolioSection ──────────────────────────────────

describe("buildPortfolioSection", () => {
  it("collapses PortfolioReport into the section shape", () => {
    const section = buildPortfolioSection(makePortfolio());
    expect(section.totalUsd).toBe(10000);
    expect(section.positionCount).toBe(2);
    expect(section.top[0].symbol).toBe("ETH");
    expect(section.top[0].percentOfPortfolio).toBe(80);
  });

  it("respects the limit", () => {
    const section = buildPortfolioSection(makePortfolio(), 1);
    expect(section.top.length).toBe(1);
    expect(section.top[0].symbol).toBe("ETH");
  });
});

// ── buildPnLSection ────────────────────────────────────────

describe("buildPnLSection", () => {
  const pnl: PnLReport = {
    account: "alice",
    timestamp: "2026-05-29T00:00:00.000Z",
    positions: [],
    gas: [],
    totalRealizedUsd: 100,
    totalUnrealizedUsd: 500,
    totalGasUsd: 20,
    totalRealizedAfterGasUsd: 80,
    severity: "ok",
    recommendedActions: [],
    windows: [
      {
        label: "7d",
        realizedUsd: 50,
        gasNativePerChain: [],
        totalGasUsd: 10,
        realizedAfterGasUsd: 40,
        positions: [
          { symbol: "ETH", chain: "base", token: "NATIVE", realizedUsd: 100 },
          { symbol: "PEPE", chain: "base", token: "0xpepe", realizedUsd: -50 },
        ],
      },
    ],
  };

  it("surfaces the 7d window when present", () => {
    const section = buildPnLSection(pnl);
    expect(section.realized7dUsd).toBe(50);
    expect(section.gas7dUsd).toBe(10);
    expect(section.netAfterGas7dUsd).toBe(40);
  });

  it("identifies top winner + top loser", () => {
    const section = buildPnLSection(pnl);
    expect(section.topWinner?.symbol).toBe("ETH");
    expect(section.topWinner?.realizedUsd).toBe(100);
    expect(section.topLoser?.symbol).toBe("PEPE");
    expect(section.topLoser?.realizedUsd).toBe(-50);
  });

  it("falls back to report totals when the requested window is absent", () => {
    const section = buildPnLSection(pnl, "nonexistent");
    expect(section.realized7dUsd).toBe(100); // totalRealizedUsd
  });

  it("surfaces iter639 byPair as top winner/loser pairs (iter640)", () => {
    const pnlWithPairs: PnLReport = {
      ...pnl,
      byPair: [
        { pair: "ETH/USDC", realizedUsd: 500, tradeCount: 10 },
        { pair: "WBTC/USDC", realizedUsd: 200, tradeCount: 5 },
        { pair: "USDC/USDT", realizedUsd: 50, tradeCount: 3 },
        { pair: "PEPE/USDC", realizedUsd: -100, tradeCount: 4 },
        { pair: "DOGE/USDC", realizedUsd: -300, tradeCount: 8 },
      ],
    };
    const section = buildPnLSection(pnlWithPairs);
    expect(section.topWinnerPairs?.length).toBe(3);
    expect(section.topWinnerPairs?.[0].pair).toBe("ETH/USDC");
    expect(section.topWinnerPairs?.[2].pair).toBe("USDC/USDT");
    expect(section.topLoserPairs?.length).toBe(2);
    // Most-negative first (loser ranking).
    expect(section.topLoserPairs?.[0].pair).toBe("DOGE/USDC");
    expect(section.topLoserPairs?.[1].pair).toBe("PEPE/USDC");
  });

  it("omits topWinnerPairs/topLoserPairs when no byPair data exists", () => {
    const section = buildPnLSection(pnl);
    expect(section.topWinnerPairs).toBeUndefined();
    expect(section.topLoserPairs).toBeUndefined();
  });

  it("topWinnerPairs handles all-winning case (no losers)", () => {
    const r: PnLReport = {
      ...pnl,
      byPair: [
        { pair: "ETH/USDC", realizedUsd: 100, tradeCount: 5 },
        { pair: "WBTC/USDC", realizedUsd: 50, tradeCount: 3 },
      ],
    };
    const section = buildPnLSection(r);
    expect(section.topWinnerPairs?.length).toBe(2);
    expect(section.topLoserPairs).toBeUndefined();
  });

  it("zero-realized pairs are excluded from both winner and loser arrays", () => {
    const r: PnLReport = {
      ...pnl,
      byPair: [
        { pair: "ETH/USDC", realizedUsd: 100, tradeCount: 5 },
        { pair: "BUY_ONLY/USDC", realizedUsd: 0, tradeCount: 3 }, // buys only, no realized yet
      ],
    };
    const section = buildPnLSection(r);
    expect(section.topWinnerPairs?.length).toBe(1);
    expect(section.topLoserPairs).toBeUndefined();
  });

  it("iter650: surfaces iter649 byStrategy as top winner/loser strategies", () => {
    const r: PnLReport = {
      ...pnl,
      byStrategy: [
        { strategy: "dca-eth", realizedUsd: 500, tradeCount: 10 },
        { strategy: "swing", realizedUsd: 100, tradeCount: 5 },
        { strategy: "manual", realizedUsd: -200, tradeCount: 3 },
      ],
    };
    const section = buildPnLSection(r);
    expect(section.topWinnerStrategies?.length).toBe(2);
    expect(section.topWinnerStrategies?.[0].strategy).toBe("dca-eth");
    expect(section.topLoserStrategies?.length).toBe(1);
    expect(section.topLoserStrategies?.[0].strategy).toBe("manual");
  });

  it("iter650: filters '(none)' bucket — only tagged strategies appear", () => {
    const r: PnLReport = {
      ...pnl,
      byStrategy: [
        { strategy: "(none)", realizedUsd: 1000, tradeCount: 20 }, // huge winner but untagged
        { strategy: "dca-eth", realizedUsd: 50, tradeCount: 3 },
      ],
    };
    const section = buildPnLSection(r);
    expect(section.topWinnerStrategies?.length).toBe(1);
    expect(section.topWinnerStrategies?.[0].strategy).toBe("dca-eth");
  });

  it("iter650: omits top-strategy fields when no byStrategy data", () => {
    const section = buildPnLSection(pnl);
    expect(section.topWinnerStrategies).toBeUndefined();
    expect(section.topLoserStrategies).toBeUndefined();
  });
});

// ── buildSecuritySection ───────────────────────────────────

describe("buildSecuritySection", () => {
  function makeAudit(chain: string, critical: number, warn: number): AllowanceAuditReport {
    return {
      chain,
      owner: "0x1111111111111111111111111111111111111111" as Address,
      timestamp: "2026-05-29T00:00:00.000Z",
      counts: { critical, warn, ok: 0, total: critical + warn },
      severity: critical > 0 ? "critical" : warn > 0 ? "warn" : "ok",
      recommendedActions: [],
      allowances: [
        ...Array.from({ length: critical }, (_, i) => ({
          token: `0xtok${i}` as Address,
          symbol: `CRIT${i}`,
          spender: `0xspc${i}` as Address,
          spenderLabel: null,
          display: "infinite",
          usdExposure: null,
          severity: "critical" as const,
          findings: [{ code: "infinite_unknown_spender" as const, severity: "critical" as const, message: "x" }],
          recommendedAction: { tool: "revoke" as const, params: { chain, token: `0xtok${i}` as Address, spender: `0xspc${i}` as Address }, reason: "x" },
        })),
        ...Array.from({ length: warn }, (_, i) => ({
          token: `0xtokw${i}` as Address,
          symbol: `WARN${i}`,
          spender: `0xspcw${i}` as Address,
          spenderLabel: null,
          display: "infinite",
          usdExposure: null,
          severity: "warn" as const,
          findings: [{ code: "infinite_known_router" as const, severity: "warn" as const, message: "x" }],
          recommendedAction: { tool: "revoke" as const, params: { chain, token: `0xtokw${i}` as Address, spender: `0xspcw${i}` as Address }, reason: "x" },
        })),
      ],
    };
  }

  it("sums counts across chains", () => {
    const section = buildSecuritySection([makeAudit("base", 1, 2), makeAudit("arb", 1, 1)]);
    expect(section.criticalCount).toBe(2);
    expect(section.warnCount).toBe(3);
    expect(section.totalApprovals).toBe(5);
  });

  it("topConcerns sorts critical first then warn", () => {
    const section = buildSecuritySection([makeAudit("base", 1, 2)]);
    expect(section.topConcerns[0].severity).toBe("critical");
    expect(section.topConcerns[1].severity).toBe("warn");
  });

  it("topConcerns excludes ok-severity rows", () => {
    const section = buildSecuritySection([makeAudit("base", 0, 0)]);
    expect(section.topConcerns.length).toBe(0);
  });

  it("counts stale_approval findings (iter617 signal)", () => {
    const audit = makeAudit("base", 0, 1);
    audit.allowances[0].findings.push({
      code: "stale_approval",
      severity: "warn",
      message: "old",
    });
    const section = buildSecuritySection([audit]);
    expect(section.staleCount).toBe(1);
  });
});

// ── buildTradesSection ─────────────────────────────────────

describe("buildTradesSection", () => {
  function makeRow(overrides: Partial<TradeRow>): TradeRow {
    return {
      id: 1,
      timestamp: "2026-05-29T00:00:00.000Z",
      chain: "base",
      account: "alice",
      direction: "buy",
      base_token: "NATIVE",
      base_symbol: "ETH",
      base_amount: "1.0",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      quote_amount: "3000",
      price: "3000",
      tx_hash: "0xabc",
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      ...overrides,
    };
  }

  it("counts by status within the 7d window only", () => {
    const since = "2026-05-22T00:00:00.000Z";
    const rows = [
      makeRow({ id: 1, timestamp: "2026-05-29T00:00:00.000Z", status: "success" }),
      makeRow({ id: 2, timestamp: "2026-05-28T00:00:00.000Z", status: "failed" }),
      makeRow({ id: 3, timestamp: "2026-05-27T00:00:00.000Z", status: "pending" }),
      makeRow({ id: 4, timestamp: "2026-05-01T00:00:00.000Z", status: "success" }), // outside
    ];
    const section = buildTradesSection({ rows, analyses: [], since7d: since });
    expect(section.total).toBe(3);
    expect(section.successCount).toBe(1);
    expect(section.failedCount).toBe(1);
    expect(section.pendingCount).toBe(1);
  });

  it("aggregates analyses slippage when present", () => {
    const analyses: AnalyzedTrade[] = [
      {
        txHash: "0xa",
        chain: "base",
        direction: "buy",
        baseSymbol: "ETH",
        quoteSymbol: "USDC",
        finding: { code: "excellent", message: "x" },
        comparison: {
          quoted: { baseAmount: 1, quoteAmount: 3000, pricePerBase: 3000 },
          actual: { baseAmount: 1, quoteAmount: 3000, pricePerBase: 3000 },
          slippageBps: 5,
          outputDelta: 0,
          finding: { code: "excellent", message: "x" },
        },
      },
      {
        txHash: "0xb",
        chain: "base",
        direction: "sell",
        baseSymbol: "ETH",
        quoteSymbol: "USDC",
        finding: { code: "minor_slip", message: "x" },
        comparison: {
          quoted: { baseAmount: 1, quoteAmount: 3000, pricePerBase: 3000 },
          actual: { baseAmount: 1, quoteAmount: 2970, pricePerBase: 2970 },
          slippageBps: 100,
          outputDelta: -30,
          finding: { code: "minor_slip", message: "x" },
        },
      },
    ];
    const section = buildTradesSection({ rows: [], analyses, since7d: "2026-01-01T00:00:00.000Z" });
    expect(section.medianSlippageBps).toBeCloseTo(100, 0);
    expect(section.avgSlippageBps).toBeCloseTo(52.5, 1);
    expect(section.byVerdict).toEqual({ excellent: 1, minor_slip: 1 });
  });

  it("iter653: reads iter641-stored realized_slippage_bps from rows directly", () => {
    function row(overrides: Partial<TradeRow>): TradeRow {
      return {
        id: 1,
        timestamp: "2026-05-29T00:00:00.000Z",
        chain: "base",
        account: "alice",
        direction: "buy",
        base_token: "0xeee",
        base_symbol: "ETH",
        base_amount: "1",
        quote_token: "0xusdc",
        quote_symbol: "USDC",
        quote_amount: "3000",
        price: "3000",
        tx_hash: "0xabc",
        status: "success",
        gas_used: null,
        gas_price_wei: null,
        gas_cost_native: null,
        aggregator: "kyberswap",
        fee_tier: null,
        notes: null,
        ...overrides,
      };
    }
    const rows = [
      row({ id: 1, tx_hash: "0x1", realized_slippage_bps: 30 }),
      row({ id: 2, tx_hash: "0x2", realized_slippage_bps: 50 }),
    ];
    // No analyses passed — section should still compute from stored.
    const section = buildTradesSection({ rows, analyses: [], since7d: "2026-01-01T00:00:00Z" });
    expect(section.medianSlippageBps).toBeCloseTo(50, 1);
    expect(section.avgSlippageBps).toBeCloseTo(40, 1);
  });

  it("iter653: avoids double-counting when a row has BOTH stored slippage AND an analysis", () => {
    function row(overrides: Partial<TradeRow>): TradeRow {
      return {
        id: 1,
        timestamp: "2026-05-29T00:00:00.000Z",
        chain: "base",
        account: "alice",
        direction: "buy",
        base_token: "0xeee",
        base_symbol: "ETH",
        base_amount: "1",
        quote_token: "0xusdc",
        quote_symbol: "USDC",
        quote_amount: "3000",
        price: "3000",
        tx_hash: "0xabc",
        status: "success",
        gas_used: null,
        gas_price_wei: null,
        gas_cost_native: null,
        aggregator: "kyberswap",
        fee_tier: null,
        notes: null,
        ...overrides,
      };
    }
    const rows = [
      row({ tx_hash: "0x1", realized_slippage_bps: 30 }), // stored
    ];
    const analyses: AnalyzedTrade[] = [
      {
        txHash: "0x1", // same tx — analysis is redundant
        chain: "base",
        direction: "buy",
        baseSymbol: "ETH",
        quoteSymbol: "USDC",
        finding: { code: "ok", message: "x" },
        comparison: {
          quoted: { baseAmount: 1, quoteAmount: 3000, pricePerBase: 3000 },
          actual: { baseAmount: 1, quoteAmount: 3000, pricePerBase: 3000 },
          slippageBps: 30,
          outputDelta: 0,
          finding: { code: "ok", message: "x" },
        },
      },
    ];
    const section = buildTradesSection({ rows, analyses, since7d: "2026-01-01T00:00:00Z" });
    // Only ONE sample contributes — not double-counted.
    expect(section.medianSlippageBps).toBe(30);
    expect(section.avgSlippageBps).toBe(30);
    // byVerdict still comes from analyses (it's not stored on the row).
    expect(section.byVerdict).toEqual({ ok: 1 });
  });

  it("iter653: mixed dataset — stored + legacy analyzed both contribute", () => {
    function row(overrides: Partial<TradeRow>): TradeRow {
      return {
        id: 1,
        timestamp: "2026-05-29T00:00:00.000Z",
        chain: "base",
        account: "alice",
        direction: "buy",
        base_token: "0xeee",
        base_symbol: "ETH",
        base_amount: "1",
        quote_token: "0xusdc",
        quote_symbol: "USDC",
        quote_amount: "3000",
        price: "3000",
        tx_hash: "0xabc",
        status: "success",
        gas_used: null,
        gas_price_wei: null,
        gas_cost_native: null,
        aggregator: "kyberswap",
        fee_tier: null,
        notes: null,
        ...overrides,
      };
    }
    const rows = [
      row({ tx_hash: "0xnew", realized_slippage_bps: 40 }), // stored
      row({ tx_hash: "0xold" }), // legacy, no stored
    ];
    const analyses: AnalyzedTrade[] = [
      {
        txHash: "0xold",
        chain: "base",
        direction: "buy",
        baseSymbol: "ETH",
        quoteSymbol: "USDC",
        finding: { code: "ok", message: "x" },
        comparison: {
          quoted: { baseAmount: 1, quoteAmount: 3000, pricePerBase: 3000 },
          actual: { baseAmount: 1, quoteAmount: 2940, pricePerBase: 2940 },
          slippageBps: 200,
          outputDelta: -60,
          finding: { code: "ok", message: "x" },
        },
      },
    ];
    const section = buildTradesSection({ rows, analyses, since7d: "2026-01-01T00:00:00Z" });
    // Median of [40, 200] = picks idx floor(2/2) = idx 1 → 200 in this 2-sample impl
    expect(section.medianSlippageBps).toBe(200);
    expect(section.avgSlippageBps).toBe(120);
  });
});

// ── composeHealthReport ────────────────────────────────────

describe("composeHealthReport", () => {
  it("captures section errors without aborting the whole report", () => {
    const report = composeHealthReport({
      scope: { accounts: [{ label: "alice", address: "0x1111111111111111111111111111111111111111" as Address }], chains: ["base"] },
      portfolio: { error: "RPC timeout" },
      pnl: undefined,
      approvalAudits: { error: "another RPC failure" } as { error: string },
      analyses: [],
      recentRows: [],
      since7d: "2026-05-22T00:00:00.000Z",
    });
    expect(report.portfolio).toBeUndefined();
    expect(report.errors.length).toBe(2);
    expect(report.errors.find((e) => e.code === "portfolio_failed")).toBeDefined();
    expect(report.errors.find((e) => e.code === "approvals_failed")).toBeDefined();
    // trades section still built (rows + analyses passed as success)
    expect(report.trades).toBeDefined();
  });

  it("builds a complete report when all inputs succeed", () => {
    const report = composeHealthReport({
      scope: { accounts: [{ label: "alice", address: "0x1111111111111111111111111111111111111111" as Address }], chains: ["base"] },
      portfolio: makePortfolio(),
      pnl: undefined,
      approvalAudits: [],
      analyses: [],
      recentRows: [],
      since7d: "2026-05-22T00:00:00.000Z",
    });
    expect(report.portfolio).toBeDefined();
    expect(report.security).toBeDefined();
    expect(report.trades).toBeDefined();
    expect(report.errors).toEqual([]);
  });

  it("composes next-action suggestions from section data", () => {
    const report = composeHealthReport({
      scope: { accounts: [{ label: "alice", address: "0x1111111111111111111111111111111111111111" as Address }], chains: ["base"] },
      portfolio: makePortfolio(),
      pnl: undefined,
      approvalAudits: [],
      analyses: [],
      recentRows: [],
      since7d: "2026-05-22T00:00:00.000Z",
    });
    // Portfolio has value but no snapshot → take_snapshot suggestion
    expect(report.nextActions.find((a) => a.code === "take_snapshot")).toBeDefined();
  });

  it("iter786: emits worst-bucket severity field derived from nextActionsSummary", () => {
    const empty = composeHealthReport({
      scope: { accounts: [{ label: "alice", address: "0x1111111111111111111111111111111111111111" as Address }], chains: ["base"] },
      pnl: undefined,
      approvalAudits: [],
      analyses: [],
      recentRows: [],
      since7d: "2026-05-22T00:00:00.000Z",
    });
    expect(empty.severity).toBe("ok");

    // Portfolio with value but no snapshot → take_snapshot (medium) only.
    const withMedium = composeHealthReport({
      scope: { accounts: [{ label: "alice", address: "0x1111111111111111111111111111111111111111" as Address }], chains: ["base"] },
      portfolio: makePortfolio(),
      pnl: undefined,
      approvalAudits: [],
      analyses: [],
      recentRows: [],
      since7d: "2026-05-22T00:00:00.000Z",
    });
    expect(withMedium.severity).toBe("medium");
  });

  it("iter764: emits nextActionsSummary with severity counts (always present)", () => {
    const empty = composeHealthReport({
      scope: { accounts: [{ label: "alice", address: "0x1111111111111111111111111111111111111111" as Address }], chains: ["base"] },
      pnl: undefined,
      approvalAudits: [],
      analyses: [],
      recentRows: [],
      since7d: "2026-05-22T00:00:00.000Z",
    });
    expect(empty.nextActionsSummary).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });

    // Portfolio with value but no snapshot → 1 medium (take_snapshot)
    const withMedium = composeHealthReport({
      scope: { accounts: [{ label: "alice", address: "0x1111111111111111111111111111111111111111" as Address }], chains: ["base"] },
      portfolio: makePortfolio(),
      pnl: undefined,
      approvalAudits: [],
      analyses: [],
      recentRows: [],
      since7d: "2026-05-22T00:00:00.000Z",
    });
    expect(withMedium.nextActionsSummary.medium).toBeGreaterThanOrEqual(1);
    // sum across buckets matches nextActions.length
    const sum =
      withMedium.nextActionsSummary.critical +
      withMedium.nextActionsSummary.high +
      withMedium.nextActionsSummary.medium +
      withMedium.nextActionsSummary.low;
    expect(sum).toBe(withMedium.nextActions.length);
  });
});

// ── formatUsdDelta ─────────────────────────────────────────

describe("formatUsdDelta", () => {
  it("formats positive delta with + sign", () => {
    expect(formatUsdDelta(100)).toBe("+$100");
  });

  it("formats negative delta with - sign", () => {
    expect(formatUsdDelta(-50)).toBe("-$50");
  });

  it("includes pct when supplied", () => {
    expect(formatUsdDelta(100, 5.5)).toBe("+$100 (+5.50%)");
    expect(formatUsdDelta(-50, -2.5)).toBe("-$50 (-2.50%)");
  });

  it("treats tiny values as $0.00", () => {
    expect(formatUsdDelta(0.001)).toBe("+$0.00");
  });
});

// ── iter671: buildTradesSection failureReasons histogram ──────

describe("buildTradesSection failureReasons (iter671)", () => {
  function row(overrides: Partial<TradeRow>): TradeRow {
    return {
      id: 1,
      timestamp: "2026-05-29T00:00:00.000Z",
      chain: "base",
      account: "alice",
      direction: "buy",
      base_token: "NATIVE",
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      quote_amount: "3000",
      price: "3000",
      tx_hash: "0xabc",
      status: "failed",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      ...overrides,
    };
  }
  const since = "2026-05-22T00:00:00.000Z";

  it("buckets failed rows by revert_reason, sorted by count desc", () => {
    const rows = [
      row({ id: 1, tx_hash: "0x1", revert_reason: "Too little received" }),
      row({ id: 2, tx_hash: "0x2", revert_reason: "Too little received" }),
      row({ id: 3, tx_hash: "0x3", revert_reason: "Too little received" }),
      row({ id: 4, tx_hash: "0x4", revert_reason: "STF" }),
    ];
    const section = buildTradesSection({ rows, analyses: [], since7d: since });
    // Iter699: lastSeen may be present — use toMatchObject for partial match.
    expect(section.failureReasons).toMatchObject([
      { reason: "Too little received", count: 3 },
      { reason: "STF", count: 1 },
    ]);
  });

  it("buckets NULL revert_reason as '(unknown)'", () => {
    const rows = [
      row({ id: 1, tx_hash: "0x1", revert_reason: null }),
      row({ id: 2, tx_hash: "0x2", revert_reason: null }),
      row({ id: 3, tx_hash: "0x3", revert_reason: "STF" }),
    ];
    const section = buildTradesSection({ rows, analyses: [], since7d: since });
    const unk = section.failureReasons.find((r) => r.reason === "(unknown)");
    const stf = section.failureReasons.find((r) => r.reason === "STF");
    expect(unk?.count).toBe(2);
    expect(stf?.count).toBe(1);
  });

  it("only counts failed rows (success rows ignored even if they have revert_reason somehow)", () => {
    const rows = [
      row({ id: 1, tx_hash: "0x1", status: "success", revert_reason: "should not count" }),
      row({ id: 2, tx_hash: "0x2", status: "failed", revert_reason: "real reason" }),
    ];
    const section = buildTradesSection({ rows, analyses: [], since7d: since });
    expect(section.failureReasons).toMatchObject([{ reason: "real reason", count: 1 }]);
  });

  it("only counts rows within the 7d window", () => {
    const rows = [
      row({ id: 1, tx_hash: "0x1", timestamp: "2026-05-29T00:00:00Z", revert_reason: "in window" }),
      row({ id: 2, tx_hash: "0x2", timestamp: "2026-04-01T00:00:00Z", revert_reason: "outside window" }),
    ];
    const section = buildTradesSection({ rows, analyses: [], since7d: since });
    expect(section.failureReasons).toMatchObject([{ reason: "in window", count: 1 }]);
  });

  it("returns empty array when no failed rows", () => {
    const rows = [row({ id: 1, status: "success" })];
    const section = buildTradesSection({ rows, analyses: [], since7d: since });
    expect(section.failureReasons).toEqual([]);
  });
});
