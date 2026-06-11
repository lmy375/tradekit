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

// ── v46: live risk metrics (shared math with backtest risk block) ──

describe("buildEquityCurve — risk metrics", () => {
  it("hand-computed drawdown USD + vol/sharpe from daily snapshots", () => {
    openDb().exec("DELETE FROM portfolio_snapshots");
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];
    const vals = [1000, 1100, 990, 1100];
    days.forEach((d, i) => insertPortfolioSnapshot({
      timestamp: `${d}T00:00:00Z`, total_usd: vals[i],
      accounts_key: "default", chains_key: "base",
      token_count: 1, note: null, data: "{}",
    }));
    const c = buildEquityCurve();
    expect(c.risk).not.toBeNull();
    // Peak 1100 → trough 990 = −10%, −$110.
    expect(c.risk!.maxDrawdownPct).toBeCloseTo(10, 9);
    expect(c.risk!.maxDrawdownUsd).toBeCloseTo(110, 9);
    expect(c.risk!.peakTs).toBe("2026-06-02T00:00:00Z");
    expect(c.risk!.troughTs).toBe("2026-06-03T00:00:00Z");
    expect(c.risk!.returnPct).toBeCloseTo(10, 9); // 1000 → 1100
    // Daily cadence → vol annualizes by √365; sharpe finite.
    expect(c.risk!.volatilityPctAnnual).toBeGreaterThan(0);
    expect(c.risk!.sharpe).not.toBeNull();
    // Same number the legacy field reports.
    expect(c.risk!.maxDrawdownPct).toBeCloseTo(c.maxDrawdownPct!, 9);
  });

  it("empty scope → risk null; flat curve → zero vol, null sharpe", () => {
    openDb().exec("DELETE FROM portfolio_snapshots");
    expect(buildEquityCurve().risk).toBeNull();

    for (let i = 0; i < 4; i++) {
      insertPortfolioSnapshot({
        timestamp: `2026-06-0${i + 1}T00:00:00Z`, total_usd: 500,
        accounts_key: "default", chains_key: "base",
        token_count: 1, note: null, data: "{}",
      });
    }
    const c = buildEquityCurve();
    expect(c.risk!.volatilityPctAnnual).toBeCloseTo(0, 12);
    expect(c.risk!.sharpe).toBeNull(); // flat curve: no risk to adjust for
    expect(c.risk!.maxDrawdownPct).toBe(0);
  });
});

// ── v48: paper-book snapshots ────────────────────────────────

const { valuePaperBook, runPaperSnapshotTick, PAPER_AUTO_SNAPSHOT_NOTE } = await import("./snapshotWorker.js");
const { setPaperBalance } = await import("./paperTrade.js");

describe("valuePaperBook / runPaperSnapshotTick", () => {
  const db = openDb;

  const WETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const JUNK = "0x00000000000000000000000000000000000dead0";

  const PRICES: Record<string, number | null> = { [WETH]: 2000, [USDC]: 1, [JUNK]: null };
  const fetchPrice = async (_chain: string, token: string) => PRICES[token] ?? null;

  function clearPaper() {
    db().exec("DELETE FROM paper_balances; DELETE FROM portfolio_snapshots");
  }

  it("values the book at live prices; unpriceable tokens are EXCLUDED, never guessed", async () => {
    const v = await valuePaperBook({
      rows: [
        { chain: "base", token: WETH, balance: "0.5" },
        { chain: "base", token: USDC, balance: "300" },
        { chain: "base", token: JUNK, balance: "1000000" },
        { chain: "base", token: WETH, balance: "0" }, // zero rows skipped
      ],
      fetchPrice,
    });
    expect(v.totalUsd).toBeCloseTo(0.5 * 2000 + 300, 9);
    expect(v.pricedCount).toBe(2);
    expect(v.unpricedCount).toBe(1);
    expect(v.tokenCount).toBe(3);
    expect(v.breakdown.find((b) => b.token === JUNK)!.valueUsd).toBeNull();
  });

  it("tick writes ONE scoped row per paper account under paper:<account>", async () => {
    clearPaper();
    setPaperBalance({ account: "default", chain: "base", token: WETH, decimals: 18, amount: "1" });
    setPaperBalance({ account: "default", chain: "arbitrum", token: USDC, decimals: 6, amount: "500" });
    setPaperBalance({ account: "alt", chain: "base", token: USDC, decimals: 6, amount: "100" });
    const report = await runPaperSnapshotTick({ config: loadConfig(), logger: stubLogger, fetchPrice });
    expect(report.recorded).toHaveLength(2);
    const main = report.recorded.find((r) => r.account === "default")!;
    expect(main.accountsKey).toBe("paper:default");
    expect(main.totalUsd).toBeCloseTo(2500, 9);
    const rows = listPortfolioSnapshots({ accountsKey: "paper:default" });
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe(PAPER_AUTO_SNAPSHOT_NOTE);
    expect(rows[0].chains_key).toContain("arbitrum");
    expect(listPortfolioSnapshots({ accountsKey: "paper:alt" })[0].total_usd).toBeCloseTo(100, 9);
  });

  it("cadence gates are INDEPENDENT: a fresh real snapshot never starves the paper feed", async () => {
    clearPaper();
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "100" });
    // Fresh REAL auto-snapshot...
    seedSnap(new Date().toISOString(), 5000, { note: AUTO_SNAPSHOT_NOTE });
    // ...paper still records:
    const first = await runPaperSnapshotTick({ config: loadConfig(), logger: stubLogger, fetchPrice });
    expect(first.recorded).toHaveLength(1);
    // ...and the paper gate now blocks the SECOND paper tick:
    const second = await runPaperSnapshotTick({ config: loadConfig(), logger: stubLogger, fetchPrice });
    expect(second.skipped).toMatch(/fresh paper auto-snapshot/);
    // force (manual CLI) bypasses:
    const forced = await runPaperSnapshotTick({ config: loadConfig(), logger: stubLogger, fetchPrice, force: true });
    expect(forced.recorded).toHaveLength(1);
  });

  it("empty book and disabled flag both no-op", async () => {
    clearPaper();
    const empty = await runPaperSnapshotTick({ config: loadConfig(), logger: stubLogger, fetchPrice });
    expect(empty.skipped).toMatch(/paper book is empty/);

    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "1" });
    const cfg = loadConfig();
    const off = await runPaperSnapshotTick({
      config: { ...cfg, engine: { ...cfg.engine, snapshotIncludePaper: false } },
      logger: stubLogger,
      fetchPrice,
    });
    expect(off.skipped).toMatch(/snapshotIncludePaper/);
  });

  it("the FULL equity stack works on the paper scope — curve + risk, zero extra wiring", async () => {
    clearPaper();
    // Three paper snapshots by hand (the curve doesn't care who wrote them).
    [1000, 1200, 1080].forEach((v, i) =>
      insertPortfolioSnapshot({
        timestamp: `2026-06-0${i + 1}T00:00:00Z`, total_usd: v,
        accounts_key: "paper:default", chains_key: "base",
        token_count: 2, note: PAPER_AUTO_SNAPSHOT_NOTE, data: "{}",
      }),
    );
    const c = buildEquityCurve({ accountsKey: "paper:default", chainsKey: "base" });
    expect(c.points).toHaveLength(3);
    expect(c.changeAbs).toBeCloseTo(80, 9);
    expect(c.risk!.maxDrawdownPct).toBeCloseTo(10, 6); // 1200 → 1080
    expect(c.risk!.maxDrawdownUsd).toBeCloseTo(120, 6);
    // And the scope shows up in the picker every surface reads.
    expect(c.availableScopes.some((s) => s.accountsKey === "paper:default")).toBe(true);
  });
});
