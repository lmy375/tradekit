/**
 * Promote-readiness tests (v49). The verdict rules pinned one by
 * one: evidence floors are hard not_ready, quality flags are
 * caution, and missing data degrades honestly (never blocks, never
 * guesses).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-promotecheck-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

// Mock the paper price fetcher so MTM is deterministic: fills buy at
// $2000, the mark is $2200 — every open position carries +10%
// unrealized (breakeven books trip the PnL≤0 caution by design).
vi.mock("./paperPnl.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./paperPnl.js")>();
  return {
    ...mod,
    defaultPaperPriceFetcher: () => async () => 2200,
  };
});

const { gatherPromoteCheck, renderPromoteCheck, promoteReadinessBlocker, MIN_RUNTIME_DAYS, MIN_FILLS } =
  await import("./promoteCheck.js");
const { openDb, closeDb, insertPlaybook, updatePlaybookStatus, recordPaperTrade, insertTrade, insertPortfolioSnapshot } =
  await import("./db.js");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NOW = new Date("2026-06-11T12:00:00Z");

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  openDb().exec("DELETE FROM playbooks; DELETE FROM paper_trades; DELETE FROM trades; DELETE FROM portfolio_snapshots");
});

function mkPlaybook(deployedDaysAgo: number): number {
  const id = insertPlaybook({
    name: "dca-test",
    sourcePath: null,
    sourceHash: "h",
    specJson: JSON.stringify({ name: "dca-test", chain: "base", account: "default", strategies: [] }),
  });
  updatePlaybookStatus(id, "deployed");
  openDb().prepare(`UPDATE playbooks SET deployed_at = ? WHERE id = ?`)
    .run(new Date(NOW.getTime() - deployedDaysAgo * 86_400_000).toISOString(), id);
  return id;
}

function seedFills(id: number, count: number, opts: { slippageBps?: number; daysSpread?: number } = {}): void {
  for (let i = 0; i < count; i++) {
    recordPaperTrade({
      timestamp: new Date(NOW.getTime() - (i + 1) * ((opts.daysSpread ?? 10) / count) * 86_400_000).toISOString(),
      source_type: "schedule", source_id: 1,
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "WETH", base_amount: "0.05",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "100",
      price: "2000", slippage_bps: opts.slippageBps ?? 30,
      strategy: `playbook:${id}`, notes: null,
    });
  }
}

function seedPaperSnapshots(values: number[]): void {
  values.forEach((v, i) =>
    insertPortfolioSnapshot({
      timestamp: new Date(NOW.getTime() - (values.length - i) * 86_400_000).toISOString(),
      total_usd: v, accounts_key: "paper:default", chains_key: "base",
      token_count: 2, note: "engine-auto-paper", data: "{}",
    }),
  );
}

function seedRealSlippage(bps: number, count = 10): void {
  for (let i = 0; i < count; i++) {
    insertTrade({
      timestamp: new Date(NOW.getTime() - 86_400_000).toISOString(),
      chain: "base", account: "default", direction: "buy",
      base_token: WETH, base_symbol: "WETH", base_amount: "0.1",
      quote_token: USDC, quote_symbol: "USDC", quote_amount: "200",
      price: "2000", tx_hash: `0xpc${Math.random().toString(16).slice(2)}`, status: "success",
      gas_used: null, gas_price_wei: null, gas_cost_native: "0.001",
      aggregator: "kyberswap", fee_tier: null, notes: null,
      strategy: null, realized_slippage_bps: bps,
    });
  }
}

const check = (id: number, over: Record<string, unknown> = {}) =>
  gatherPromoteCheck({ playbookId: id, now: NOW, nativeUsd: 2000, ...over });

describe("verdict rules", () => {
  it("evidence floors: short runtime OR few fills → not_ready", async () => {
    const young = mkPlaybook(2);
    seedFills(young, 20, { daysSpread: 2 });
    seedPaperSnapshots([1000, 1010, 1020]);
    const r1 = await check(young);
    expect(r1.verdict).toBe("not_ready");
    expect(r1.reasons.some((x) => new RegExp(`< ${MIN_RUNTIME_DAYS}d`).test(x))).toBe(true);

    openDb().exec("DELETE FROM playbooks; DELETE FROM paper_trades");
    const sparse = mkPlaybook(30);
    seedFills(sparse, 2);
    const r2 = await check(sparse);
    expect(r2.verdict).toBe("not_ready");
    expect(r2.reasons.some((x) => new RegExp(`< ${MIN_FILLS}`).test(x))).toBe(true);
  });

  it("clean evidence → ready with zero flags", async () => {
    const id = mkPlaybook(14);
    seedFills(id, 10, { slippageBps: 30 });
    seedPaperSnapshots([1000, 1020, 1040, 1060]); // rising book — tiny DD
    seedRealSlippage(20); // real fills BETTER than paper assumption
    const r = await check(id);
    expect(r.reasons).toEqual([]);
    expect(r.verdict).toBe("ready");
    expect(r.runtime.fills).toBe(10);
    expect(r.performance).not.toBeNull();
    expect(r.risk).not.toBeNull();
    expect(r.risk!.bookLevel).toBe(true);
  });

  it("optimistic paper slippage (paper < real) → caution naming both numbers", async () => {
    const id = mkPlaybook(14);
    seedFills(id, 10, { slippageBps: 10 });
    seedPaperSnapshots([1000, 1010, 1020]);
    seedRealSlippage(40);
    const r = await check(id);
    expect(r.verdict).toBe("caution");
    expect(r.reasons.some((x) => /paper assumed 10.0bps.*real fills.*average 40.0bps/.test(x))).toBe(true);
  });

  it("deep paper-book drawdown → caution", async () => {
    const id = mkPlaybook(14);
    seedFills(id, 10);
    seedPaperSnapshots([1000, 1500, 900, 950]); // 40% DD
    const r = await check(id);
    expect(r.verdict).toBe("caution");
    expect(r.reasons.some((x) => /max drawdown 40.0%/.test(x))).toBe(true);
    expect(r.risk!.maxDrawdownUsd).toBeCloseTo(600, 6);
  });

  it("no paper snapshots → caution pointing at the worker, never a block", async () => {
    const id = mkPlaybook(14);
    seedFills(id, 10);
    const r = await check(id);
    expect(r.verdict).toBe("caution");
    expect(r.risk).toBeNull();
    expect(r.reasons.some((x) => /snapshot/.test(x))).toBe(true);
  });
});

describe("friction reality math", () => {
  it("projects monthly friction from REAL stats at the paper cadence — exact numbers", async () => {
    const id = mkPlaybook(10);
    // 10 fills over 10 days @ $100 each → 30 fills/month, avg $100.
    seedFills(id, 10, { slippageBps: 30, daysSpread: 10 });
    seedPaperSnapshots([1000, 1005, 1010]);
    seedRealSlippage(50); // real: 50bps → $0.50 per $100 fill
    const r = await check(id); // nativeUsd 2000 → gas 0.001 × 2000 = $2/fill
    const f = r.frictionReality;
    expect(f.paperAssumedMedianBps).toBe(30);
    expect(f.realMedianBps).toBeCloseTo(50, 9);
    expect(f.realGasUsdPerFill).toBeCloseTo(2, 9);
    expect(f.avgFillUsd).toBeCloseTo(100, 9);
    // 30 fills/month × ($0.50 + $2.00) = $75/month.
    expect(f.projectedMonthlyFrictionUsd).toBeCloseTo(75, 6);
  });

  it("no real history → friction fields null, no false caution", async () => {
    const id = mkPlaybook(14);
    seedFills(id, 10);
    seedPaperSnapshots([1000, 1010, 1020]);
    const r = await check(id);
    expect(r.frictionReality.realMedianBps).toBeNull();
    expect(r.frictionReality.projectedMonthlyFrictionUsd).toBeNull();
    expect(r.reasons.some((x) => /optimistic|friction eats/.test(x))).toBe(false);
  });

  it("missing nativeUsd degrades gas to native-only (no USD projection of gas)", async () => {
    const id = mkPlaybook(14);
    seedFills(id, 10);
    seedPaperSnapshots([1000, 1010, 1020]);
    seedRealSlippage(20);
    const r = await check(id, { nativeUsd: null });
    expect(r.frictionReality.realAvgGasNative).toBeCloseTo(0.001, 9);
    expect(r.frictionReality.realGasUsdPerFill).toBeNull();
    // Slippage-only projection still computed.
    expect(r.frictionReality.projectedMonthlyFrictionUsd).not.toBeNull();
  });
});

describe("render + errors", () => {
  it("renders verdict, sections, and the promote pointer", async () => {
    const id = mkPlaybook(14);
    seedFills(id, 10);
    seedPaperSnapshots([1000, 1010, 1020]);
    const text = renderPromoteCheck(await check(id));
    expect(text).toMatch(/Promote check — playbook #/);
    expect(text).toMatch(/Verdict: /);
    expect(text).toMatch(/Paper runtime:/);
    expect(text).toMatch(/whole virtual book, not strategy-isolated|snapshot/);
    expect(text).toMatch(/playbook promote \d+ --to real/);
  });

  it("unknown playbook → clean INVALID_PARAMS", async () => {
    await expect(check(99_999)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});

// v96: the promote-gate half — only the hard evidence floors block.
describe("promoteReadinessBlocker (the --require-ready gate)", () => {
  it("blocks a not_ready strategy, listing the evidence-floor failures", async () => {
    const sparse = mkPlaybook(30);
    seedFills(sparse, 2); // < MIN_FILLS → not_ready
    const r = await check(sparse);
    expect(r.verdict).toBe("not_ready");
    const blocker = promoteReadinessBlocker(r);
    expect(blocker).not.toBeNull();
    expect(blocker).toMatch(/NOT READY/);
    expect(blocker).toMatch(new RegExp(`< ${MIN_FILLS}`));
    expect(blocker).toMatch(/promote anyway without --require-ready/);
  });

  it("does NOT block a ready strategy", async () => {
    const id = mkPlaybook(14);
    seedFills(id, 10, { slippageBps: 30 });
    seedPaperSnapshots([1000, 1020, 1040, 1060]);
    seedRealSlippage(20);
    const r = await check(id);
    expect(r.verdict).toBe("ready");
    expect(promoteReadinessBlocker(r)).toBeNull();
  });

  it("does NOT block a caution-only strategy — quality flags are a judgment call, not a floor", async () => {
    const id = mkPlaybook(14);
    seedFills(id, 10, { slippageBps: 10 }); // paper optimistic vs real → caution
    seedPaperSnapshots([1000, 1010, 1020]);
    seedRealSlippage(80);
    const r = await check(id);
    expect(r.verdict).toBe("caution");
    expect(promoteReadinessBlocker(r)).toBeNull();
  });
});
