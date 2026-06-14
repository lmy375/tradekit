// Iter618: tests for the pure helpers in portfolioSnapshots.ts. The DB-bound
// insert/list/diff orchestration is covered by smoke tests; this file pins
// the math + reference-resolution.

import { describe, expect, it } from "vitest";
import {
  diffSnapshots,
  resolveSnapshotRef,
  scopeKey,
} from "./portfolioSnapshots.js";
import type { PortfolioReport, TokenAggregate } from "./portfolio.js";

function makeReport(
  timestamp: string,
  totalUsd: number,
  tokens: Array<Pick<TokenAggregate, "symbol" | "tokenKey" | "totalUsd"> & {
    amount?: string;
    chain?: string;
  }>,
): PortfolioReport {
  return {
    timestamp,
    accounts: [{ label: "alice", address: "0x1111111111111111111111111111111111111111" as `0x${string}` }],
    chains: ["base"],
    snapshots: [],
    errors: [],
    totalUsd,
    unpricedPositionCount: 0,
    tokens: tokens.map((t) => ({
      symbol: t.symbol,
      tokenKey: t.tokenKey,
      perChain: [
        {
          chain: t.chain ?? "base",
          address: "NATIVE" as const,
          amount: t.amount ?? "1.0",
          usd: t.totalUsd,
        },
      ],
      totalUsd: t.totalUsd,
      percentOfPortfolio: totalUsd > 0 && t.totalUsd != null ? (t.totalUsd / totalUsd) * 100 : undefined,
    })),
    concentration: { top1: 0, top3: 0, top5: 0 },
    concentrationRisk: { thresholdPct: null, verdict: "unconfigured", largestPct: null, largestSymbol: null, breaches: [], summary: "" },
    severity: "ok",
    recommendedActions: [],
  };
}

describe("scopeKey", () => {
  it("sorts + lowercases + comma-joins", () => {
    expect(scopeKey(["bob", "Alice", "Charlie"])).toBe("alice,bob,charlie");
    expect(scopeKey(["BASE", "arb"])).toBe("arb,base");
  });

  it("empty input returns empty string", () => {
    expect(scopeKey([])).toBe("");
  });
});

describe("diffSnapshots", () => {
  it("identifies tokens added (in current, not in prev)", () => {
    const prev = makeReport("2026-05-01T00:00:00Z", 100, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 100 },
    ]);
    const current = makeReport("2026-05-29T00:00:00Z", 200, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 120 },
      { symbol: "USDC", tokenKey: "0xusdc", totalUsd: 80 },
    ]);
    const delta = diffSnapshots(prev, current);
    expect(delta.added.length).toBe(1);
    expect(delta.added[0].symbol).toBe("USDC");
    expect(delta.added[0].currentUsd).toBe(80);
    expect(delta.added[0].prevUsd).toBeNull();
  });

  it("identifies tokens removed (in prev, not in current)", () => {
    const prev = makeReport("2026-05-01T00:00:00Z", 200, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 100 },
      { symbol: "USDC", tokenKey: "0xusdc", totalUsd: 100 },
    ]);
    const current = makeReport("2026-05-29T00:00:00Z", 100, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 100 },
    ]);
    const delta = diffSnapshots(prev, current);
    expect(delta.removed.length).toBe(1);
    expect(delta.removed[0].symbol).toBe("USDC");
    expect(delta.removed[0].prevUsd).toBe(100);
    expect(delta.removed[0].currentUsd).toBeNull();
  });

  it("identifies changed tokens (in both, USD delta > epsilon)", () => {
    const prev = makeReport("2026-05-01T00:00:00Z", 100, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 100 },
    ]);
    const current = makeReport("2026-05-29T00:00:00Z", 150, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 150 },
    ]);
    const delta = diffSnapshots(prev, current);
    expect(delta.changed.length).toBe(1);
    expect(delta.changed[0].symbol).toBe("ETH");
    expect(delta.changed[0].usdDelta).toBe(50);
    expect(delta.changed[0].usdDeltaPct).toBe(50);
  });

  it("treats sub-epsilon USD change as unchanged", () => {
    const prev = makeReport("2026-05-01T00:00:00Z", 100, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 100.001 },
    ]);
    const current = makeReport("2026-05-29T00:00:00Z", 100, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 100.002 },
    ]);
    const delta = diffSnapshots(prev, current);
    expect(delta.changed.length).toBe(0);
    expect(delta.unchanged.length).toBe(1);
  });

  it("sorts changed by absolute USD delta descending (biggest movers first)", () => {
    const prev = makeReport("2026-05-01T00:00:00Z", 1000, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 500 },
      { symbol: "USDC", tokenKey: "0xusdc", totalUsd: 300 },
      { symbol: "WBTC", tokenKey: "0xwbtc", totalUsd: 200 },
    ]);
    const current = makeReport("2026-05-29T00:00:00Z", 1000, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 480 }, // -20
      { symbol: "USDC", tokenKey: "0xusdc", totalUsd: 600 }, // +300 (biggest)
      { symbol: "WBTC", tokenKey: "0xwbtc", totalUsd: 100 }, // -100
    ]);
    const delta = diffSnapshots(prev, current);
    expect(delta.changed[0].symbol).toBe("USDC"); // +300
    expect(delta.changed[1].symbol).toBe("WBTC"); // -100
    expect(delta.changed[2].symbol).toBe("ETH"); // -20
  });

  it("computes total USD delta + percent", () => {
    const prev = makeReport("2026-05-01T00:00:00Z", 100, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 100 },
    ]);
    const current = makeReport("2026-05-29T00:00:00Z", 150, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 150 },
    ]);
    const delta = diffSnapshots(prev, current);
    expect(delta.totalUsdDelta).toBe(50);
    expect(delta.totalUsdDeltaPct).toBe(50);
  });

  it("totalUsdDeltaPct is null when prev was 0 (avoid divide-by-zero)", () => {
    const prev = makeReport("2026-05-01T00:00:00Z", 0, []);
    const current = makeReport("2026-05-29T00:00:00Z", 100, [
      { symbol: "ETH", tokenKey: "NATIVE", totalUsd: 100 },
    ]);
    const delta = diffSnapshots(prev, current);
    expect(delta.totalUsdDelta).toBe(100);
    expect(delta.totalUsdDeltaPct).toBeNull();
  });
});

describe("resolveSnapshotRef", () => {
  it("parses numeric id", () => {
    expect(resolveSnapshotRef("42")).toEqual({ kind: "id", id: 42 });
    expect(resolveSnapshotRef("1")).toEqual({ kind: "id", id: 1 });
  });

  it("parses relative ago (Nd / Nh / Nm / Ns)", () => {
    const r = resolveSnapshotRef("7d");
    expect(r.kind).toBe("asOf");
    const sevenDaysAgo = Date.now() - 7 * 86400_000;
    if (r.kind === "asOf") {
      expect(Math.abs(Date.parse(r.iso) - sevenDaysAgo)).toBeLessThan(5000);
    }
  });

  it("parses 'today' to start of day", () => {
    const r = resolveSnapshotRef("today");
    if (r.kind === "asOf") {
      const d = new Date(r.iso);
      expect(d.getHours()).toBe(0);
      expect(d.getMinutes()).toBe(0);
    }
  });

  it("parses 'yesterday' to start of day -1", () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const r = resolveSnapshotRef("yesterday");
    if (r.kind === "asOf") {
      const d = new Date(r.iso);
      expect(d.getTime()).toBe(today.getTime() - 86400_000);
    }
  });

  it("parses ISO date", () => {
    const r = resolveSnapshotRef("2026-05-01");
    expect(r.kind).toBe("asOf");
    if (r.kind === "asOf") {
      expect(r.iso).toBe("2026-05-01T00:00:00.000Z");
    }
  });

  it("throws on malformed ref", () => {
    expect(() => resolveSnapshotRef("totally bogus")).toThrow(/Unrecognized snapshot reference/);
    expect(() => resolveSnapshotRef("")).toThrow();
  });
});
