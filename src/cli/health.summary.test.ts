// Iter894: regression tests for the iter846 renderHealthSummary one-liner.
// This is the `tradekit health --summary` rendering — designed for Slack
// webhook subjects, cron-tail digests, and status-page topics. The
// field-collapse pattern (healthy state is short, degraded state grows
// fields naturally) is load-bearing for operators scanning chat channels:
// degradation is visible by length alone.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHealthSummary } from "./health.js";
import type { HealthReport } from "../health.js";

// Minimal HealthReport fixture covering only the fields the summary reads.
// renderHealthSummary intentionally ignores most of the dashboard payload so
// the one-liner stays short.
function makeReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    timestamp: "2026-05-30T11:24:33Z",
    elapsedMs: 1200,
    scope: { accounts: [], chains: [] },
    errors: [],
    nextActions: [],
    nextActionsSummary: { critical: 0, high: 0, medium: 0, low: 0 },
    severity: "ok",
    criticalActions: [],
    ...overrides,
  };
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: unknown) => {
    lines.push(typeof msg === "string" ? msg : String(msg));
  };
  return { lines, restore: () => { console.log = original; } };
}

describe("Iter846: renderHealthSummary", () => {
  let cap: ReturnType<typeof captureLog>;
  beforeEach(() => { cap = captureLog(); });
  afterEach(() => { cap.restore(); });

  it("emits exactly one line", () => {
    renderHealthSummary(makeReport());
    expect(cap.lines).toHaveLength(1);
  });

  it("healthy state is short — badge + tradekit health prefix + timestamp only", () => {
    renderHealthSummary(makeReport());
    const out = cap.lines[0];
    expect(out).toContain("🟢 OK");
    // Iter900: "tradekit health" prefix (was "TradeKit" — pre-iter900 the
    // health --summary was the outlier; now matches doctor/verify/reconcile/
    // sync/pending convention).
    expect(out).toContain("tradekit health");
    expect(out).toContain("2026-05-30T11:24:33Z");
    // No degraded-state field markers
    expect(out).not.toContain("crit=");
    expect(out).not.toContain("high=");
    expect(out).not.toContain("pending=");
    expect(out).not.toContain("errors=");
  });

  it("critical severity gets 🔴 CRIT badge", () => {
    renderHealthSummary(makeReport({
      severity: "critical",
      nextActionsSummary: { critical: 3, high: 0, medium: 0, low: 0 },
    }));
    expect(cap.lines[0]).toContain("🔴 CRIT");
    expect(cap.lines[0]).toContain("crit=3");
  });

  it("high severity gets 🟠 HIGH badge", () => {
    renderHealthSummary(makeReport({
      severity: "high",
      nextActionsSummary: { critical: 0, high: 2, medium: 0, low: 0 },
    }));
    expect(cap.lines[0]).toContain("🟠 HIGH");
    expect(cap.lines[0]).toContain("high=2");
  });

  it("medium severity gets 🟡 MED badge", () => {
    renderHealthSummary(makeReport({ severity: "medium" }));
    expect(cap.lines[0]).toContain("🟡 MED");
  });

  it("low severity gets 🔵 LOW badge", () => {
    renderHealthSummary(makeReport({ severity: "low" }));
    expect(cap.lines[0]).toContain("🔵 LOW");
  });

  it("includes portfolio total when portfolio section is present", () => {
    renderHealthSummary(makeReport({
      portfolio: {
        totalUsd: 12450.20,
        positionCount: 1,
        unpricedCount: 0,
        top: [],
        concentration: { top1: 0, top3: 0, top5: 0 },
      },
    }));
    expect(cap.lines[0]).toContain("portfolio=$12,450.2");
  });

  it("includes 7d delta with sign when present", () => {
    renderHealthSummary(makeReport({
      portfolio: {
        totalUsd: 10000,
        positionCount: 1,
        unpricedCount: 0,
        top: [],
        concentration: { top1: 0, top3: 0, top5: 0 },
        delta7d: { totalUsdDelta: 123.45, pct: 1.25, snapshotId: 7 },
      },
    }));
    expect(cap.lines[0]).toContain("(7d +$123.45)");
  });

  it("formats negative 7d delta without double-sign", () => {
    renderHealthSummary(makeReport({
      portfolio: {
        totalUsd: 10000,
        positionCount: 1,
        unpricedCount: 0,
        top: [],
        concentration: { top1: 0, top3: 0, top5: 0 },
        delta7d: { totalUsdDelta: -45.00, pct: -0.5, snapshotId: 7 },
      },
    }));
    // fmtUsd preserves the negative; no `+` is prepended
    expect(cap.lines[0]).toContain("(7d $-45)");
  });

  it("includes pending count when > 0", () => {
    renderHealthSummary(makeReport({
      trades: {
        total: 10,
        successCount: 8,
        failedCount: 0,
        pendingCount: 2,
        byVerdict: {},
        failureReasons: [],
        aggregatorWarnings: [],
        pairWarnings: [],
      },
    }));
    expect(cap.lines[0]).toContain("pending=2");
  });

  it("omits pending when count is 0 (field-collapse pattern)", () => {
    renderHealthSummary(makeReport({
      trades: {
        total: 8,
        successCount: 8,
        failedCount: 0,
        pendingCount: 0,
        byVerdict: {},
        failureReasons: [],
        aggregatorWarnings: [],
        pairWarnings: [],
      },
    }));
    expect(cap.lines[0]).not.toContain("pending=");
  });

  it("includes errors count when present", () => {
    renderHealthSummary(makeReport({
      errors: [
        { message: "RPC failed", code: "portfolio_failed" },
      ],
    }));
    expect(cap.lines[0]).toContain("errors=1");
  });

  it("iter903: includes elapsed (Ns) parens when elapsedMs is present", () => {
    renderHealthSummary(makeReport({ elapsedMs: 1200 }));
    expect(cap.lines[0]).toMatch(/\(1\.2s\)$/);
  });

  it("iter903: omits elapsed when elapsedMs is undefined", () => {
    renderHealthSummary(makeReport({ elapsedMs: undefined }));
    // No trailing parens — line ends with the ISO timestamp.
    expect(cap.lines[0]).toMatch(/2026-05-30T11:24:33Z$/);
    expect(cap.lines[0]).not.toMatch(/\([\d.]+s\)/);
  });

  it("iter929: OK badge is padded to align with WARN/CRIT/etc", () => {
    // "🟢 OK  " (with 2 trailing spaces) — 6 visible chars matching WARN/CRIT.
    // Pre-iter929 the OK badge was "🟢 OK" (4 chars), causing description-
    // column drift between OK and degraded states.
    renderHealthSummary(makeReport());
    expect(cap.lines[0]).toContain("🟢 OK  ");
  });

  it("grows fields naturally as state degrades (length is signal)", () => {
    const healthy = makeReport();
    const degraded = makeReport({
      severity: "critical",
      portfolio: {
        totalUsd: 10000,
        positionCount: 1,
        unpricedCount: 0,
        top: [],
        concentration: { top1: 0, top3: 0, top5: 0 },
        delta7d: { totalUsdDelta: -200, pct: -2, snapshotId: 7 },
      },
      trades: {
        total: 10, successCount: 7, failedCount: 0, pendingCount: 3,
        byVerdict: {}, failureReasons: [], aggregatorWarnings: [], pairWarnings: [],
      },
      nextActionsSummary: { critical: 2, high: 1, medium: 0, low: 0 },
      errors: [{ message: "x", code: "pnl_failed" }],
    });
    renderHealthSummary(healthy);
    const healthyLine = cap.lines[0];
    cap.lines.length = 0;
    renderHealthSummary(degraded);
    const degradedLine = cap.lines[0];
    expect(degradedLine.length).toBeGreaterThan(healthyLine.length);
  });
});
