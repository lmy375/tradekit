/**
 * Equity curve + snapshot worker tests (v37).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-equity-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { buildEquityCurve, downsample } = await import("./equity.js");
const { runSnapshotTick, AUTO_SNAPSHOT_NOTE } = await import("./snapshotWorker.js");
const { openDb, closeDb, insertPortfolioSnapshot, listPortfolioSnapshots } = await import("./db.js");
const { loadConfig } = await import("./config.js");
import type { Logger } from "./logger.js";
import type { PortfolioReport } from "./portfolio.js";

const stubLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  openDb().exec("DELETE FROM portfolio_snapshots");
});

function seedSnap(at: string, totalUsd: number | null, over: Record<string, unknown> = {}): number {
  return insertPortfolioSnapshot({
    timestamp: at,
    total_usd: totalUsd,
    accounts_key: "default",
    chains_key: "base",
    token_count: 3,
    note: null,
    data: "{}",
    ...over,
  } as never);
}

// ── buildEquityCurve ─────────────────────────────────────────

describe("buildEquityCurve", () => {
  it("walks oldest-first with change / peak / max-drawdown stats", () => {
    seedSnap("2026-06-01T00:00:00Z", 1000);
    seedSnap("2026-06-02T00:00:00Z", 1500); // peak
    seedSnap("2026-06-03T00:00:00Z", 900);  // 40% drawdown from 1500
    seedSnap("2026-06-04T00:00:00Z", 1200);
    const c = buildEquityCurve();
    expect(c.points.map((p) => p.totalUsd)).toEqual([1000, 1500, 900, 1200]);
    expect(c.firstUsd).toBe(1000);
    expect(c.lastUsd).toBe(1200);
    expect(c.changeAbs).toBe(200);
    expect(c.changePct).toBeCloseTo(20, 6);
    expect(c.peakUsd).toBe(1500);
    expect(c.peakAt).toBe("2026-06-02T00:00:00Z");
    expect(c.maxDrawdownPct).toBeCloseTo(40, 6);
  });

  it("defaults to the most-snapshotted scope and reports it", () => {
    seedSnap("2026-06-01T00:00:00Z", 100, { accounts_key: "alt", chains_key: "ethereum" });
    seedSnap("2026-06-01T00:00:00Z", 1000);
    seedSnap("2026-06-02T00:00:00Z", 1100);
    const c = buildEquityCurve();
    expect(c.scopeSource).toBe("defaulted");
    expect(c.accountsKey).toBe("default");
    expect(c.chainsKey).toBe("base");
    expect(c.points).toHaveLength(2); // the alt scope never mixes in
    expect(c.availableScopes).toHaveLength(2);
  });

  it("pinned scope + since window filter", () => {
    seedSnap("2026-05-01T00:00:00Z", 500);
    seedSnap("2026-06-01T00:00:00Z", 1000);
    const c = buildEquityCurve({ accountsKey: "default", chainsKey: "base", sinceIso: "2026-05-15T00:00:00Z" });
    expect(c.scopeSource).toBe("requested");
    expect(c.points).toHaveLength(1);
    expect(c.firstUsd).toBe(1000);
  });

  it("unpriced snapshots (total_usd null) are unplottable and skipped", () => {
    seedSnap("2026-06-01T00:00:00Z", 1000);
    seedSnap("2026-06-02T00:00:00Z", null);
    seedSnap("2026-06-03T00:00:00Z", 1200);
    expect(buildEquityCurve().points).toHaveLength(2);
  });

  it("empty table returns an empty curve, not an error", () => {
    const c = buildEquityCurve();
    expect(c.points).toEqual([]);
    expect(c.changeAbs).toBeNull();
  });
});

describe("downsample", () => {
  it("keeps endpoints and caps the count", () => {
    const pts = Array.from({ length: 100 }, (_, i) => i);
    const out = downsample(pts, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(0);
    expect(out[9]).toBe(99);
  });
  it("short series pass through", () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});

// ── snapshot worker ──────────────────────────────────────────

describe("runSnapshotTick", () => {
  const fakeReport = (totalUsd: number): PortfolioReport =>
    ({
      timestamp: new Date().toISOString(),
      accounts: [{ label: "default", address: "0x0000000000000000000000000000000000000001" }],
      chains: ["base"],
      snapshots: [],
      errors: [],
      tokens: [{}, {}],
      totalUsd,
    }) as unknown as PortfolioReport;

  it("records an engine-auto snapshot when none is fresh", async () => {
    const report = await runSnapshotTick({
      config: loadConfig(),
      logger: stubLogger,
      aggregateFn: async () => fakeReport(4321),
    });
    expect(report.recorded).toBeDefined();
    expect(report.recorded!.totalUsd).toBe(4321);
    const rows = listPortfolioSnapshots({ limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe(AUTO_SNAPSHOT_NOTE);
    expect(rows[0].accounts_key).toBe("default");
  });

  it("skips when a fresh auto-snapshot exists (cadence gate)", async () => {
    const agg = vi.fn(async () => fakeReport(1));
    await runSnapshotTick({ config: loadConfig(), logger: stubLogger, aggregateFn: agg });
    const second = await runSnapshotTick({ config: loadConfig(), logger: stubLogger, aggregateFn: agg });
    expect(second.skipped).toMatch(/fresh auto-snapshot/);
    expect(agg).toHaveBeenCalledTimes(1);
    expect(listPortfolioSnapshots({ limit: 5 })).toHaveLength(1);
  });

  it("manual snapshots do NOT reset the auto cadence", async () => {
    seedSnap(new Date().toISOString(), 999, { note: "manual look" });
    const report = await runSnapshotTick({
      config: loadConfig(),
      logger: stubLogger,
      aggregateFn: async () => fakeReport(1000),
    });
    expect(report.recorded).toBeDefined(); // manual row didn't satisfy the gate
  });

  it("aggregation failure skips quietly (next tick retries)", async () => {
    const report = await runSnapshotTick({
      config: loadConfig(),
      logger: stubLogger,
      aggregateFn: async () => { throw new Error("rpc down"); },
    });
    expect(report.skipped).toMatch(/rpc down/);
    expect(listPortfolioSnapshots({ limit: 5 })).toHaveLength(0);
  });
});
