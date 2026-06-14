/**
 * Promote-outcome tests (v50). The verdict rules pinned one by one:
 * insufficient_data is the honest "not enough live evidence" state
 * (no fills / < MIN / no paper baseline), diverged is paper-made-money
 * but live-loses, underperforming covers the per-fill / slippage /
 * cadence shortfalls, and a paper run that never closed a position
 * degrades to an execution+cadence verdict instead of dividing by ~0.
 *
 * Both eras run through the same cost-basis walker, so the realized
 * numbers are deterministic given the mocked mark price.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-promoteoutcome-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

// Inject a deterministic mark fetcher so MTM is offline + pure: open
// positions mark flat (null → unpriced). The verdict keys off REALIZED
// PnL, which comes from the round-trip prices we seed.
const markFlat = async () => null;

const {
  gatherPromoteOutcome,
  renderPromoteOutcome,
  MIN_REAL_FILLS,
  UNDERPERFORM_RATIO_PCT,
} = await import("./promoteOutcome.js");
const { openDb, closeDb, insertPlaybook, updatePlaybookStatus, recordPaperTrade, insertTrade } =
  await import("./db.js");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NOW = new Date("2026-06-14T12:00:00Z");

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  openDb().exec("DELETE FROM playbooks; DELETE FROM paper_trades; DELETE FROM trades");
});

function mkPlaybook(): number {
  const id = insertPlaybook({
    name: "dca-test",
    sourcePath: null,
    sourceHash: "h",
    specJson: JSON.stringify({ name: "dca-test", chain: "base", account: "default", strategies: [] }),
  });
  updatePlaybookStatus(id, "deployed");
  return id;
}

/** Seed a paper round-trip: `pairs` buy@buyPx then sell@sellPx, each
 *  side one fill. Realized per sell = (sellPx − buyPx) × amount. */
function seedPaperRoundTrips(id: number, opts: {
  pairs: number;
  buyPx: number;
  sellPx: number;
  amount?: number;
  slippageBps?: number;
  daysSpread?: number;
}): void {
  const amount = opts.amount ?? 0.05;
  const total = opts.pairs * 2;
  const spread = opts.daysSpread ?? 10;
  let n = 0;
  for (let p = 0; p < opts.pairs; p++) {
    for (const [dir, px] of [["buy", opts.buyPx], ["sell", opts.sellPx]] as const) {
      recordPaperTrade({
        timestamp: new Date(NOW.getTime() - (total - n) * (spread / total) * 86_400_000).toISOString(),
        source_type: "schedule", source_id: 1,
        chain: "base", account: "default", direction: dir,
        base_token: WETH, base_symbol: "WETH", base_amount: String(amount),
        quote_token: USDC, quote_symbol: "USDC", quote_amount: String(px * amount),
        price: String(px), slippage_bps: opts.slippageBps ?? 30,
        strategy: `playbook:${id}`, notes: null,
      });
      n++;
    }
  }
}

/** Seed live round-trips into the real `trades` table. */
function seedRealRoundTrips(id: number, opts: {
  pairs: number;
  buyPx: number;
  sellPx: number;
  amount?: number;
  slippageBps?: number;
  gasNative?: number;
  daysSpread?: number;
}): void {
  const amount = opts.amount ?? 0.05;
  const total = opts.pairs * 2;
  const spread = opts.daysSpread ?? 4;
  let n = 0;
  for (let p = 0; p < opts.pairs; p++) {
    for (const [dir, px] of [["buy", opts.buyPx], ["sell", opts.sellPx]] as const) {
      insertTrade({
        timestamp: new Date(NOW.getTime() - (total - n) * (spread / total) * 86_400_000).toISOString(),
        chain: "base", account: "default", direction: dir,
        base_token: WETH, base_symbol: "WETH", base_amount: String(amount),
        quote_token: USDC, quote_symbol: "USDC", quote_amount: String(px * amount),
        price: String(px), tx_hash: `0xpo${n}${Math.random().toString(16).slice(2)}`, status: "success",
        gas_used: null, gas_price_wei: null, gas_cost_native: String(opts.gasNative ?? 0.001),
        aggregator: "kyberswap", fee_tier: null, notes: null,
        strategy: `playbook:${id}`, realized_slippage_bps: opts.slippageBps ?? 30,
      });
      n++;
    }
  }
}

const outcome = (id: number, over: Record<string, unknown> = {}) =>
  gatherPromoteOutcome({ playbookId: id, now: NOW, nativeUsd: 2000, markPriceFn: markFlat, ...over });

describe("insufficient_data — not enough live evidence", () => {
  it("no live fills → insufficient_data pointing at promote/first fill", async () => {
    const id = mkPlaybook();
    seedPaperRoundTrips(id, { pairs: 5, buyPx: 2000, sellPx: 2100 });
    const r = await outcome(id);
    expect(r.verdict).toBe("insufficient_data");
    expect(r.real).toBeNull();
    expect(r.reasons.some((x) => /no live fills/.test(x))).toBe(true);
  });

  it("fewer than MIN_REAL_FILLS live fills → insufficient_data", async () => {
    const id = mkPlaybook();
    seedPaperRoundTrips(id, { pairs: 5, buyPx: 2000, sellPx: 2100 });
    // 1 round-trip = 2 fills < MIN_REAL_FILLS (3).
    seedRealRoundTrips(id, { pairs: 1, buyPx: 2000, sellPx: 2100 });
    const r = await outcome(id);
    expect(r.verdict).toBe("insufficient_data");
    expect(r.reasons.some((x) => new RegExp(`< ${MIN_REAL_FILLS} minimum`).test(x))).toBe(true);
  });

  it("no paper baseline → insufficient_data (nothing to compare against)", async () => {
    const id = mkPlaybook();
    seedRealRoundTrips(id, { pairs: 3, buyPx: 2000, sellPx: 2100 });
    const r = await outcome(id);
    expect(r.verdict).toBe("insufficient_data");
    expect(r.paper).toBeNull();
    expect(r.reasons.some((x) => /no paper baseline/.test(x))).toBe(true);
  });

  it("unknown playbook → clean INVALID_PARAMS", async () => {
    await expect(outcome(99_999)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});

describe("verdict — paper vs live performance", () => {
  it("live tracks paper → on_track with zero flags", async () => {
    const id = mkPlaybook();
    // Paper: 5 round-trips, +$100/ETH on 0.05 = +$5/sell, 10 fills.
    seedPaperRoundTrips(id, { pairs: 5, buyPx: 2000, sellPx: 2100, slippageBps: 30, daysSpread: 10 });
    // Live: same edge, same slippage, similar cadence (6 fills / 4d).
    seedRealRoundTrips(id, { pairs: 3, buyPx: 2000, sellPx: 2100, slippageBps: 30, daysSpread: 4 });
    const r = await outcome(id);
    expect(r.verdict).toBe("on_track");
    expect(r.reasons).toEqual([]);
    expect(r.paper).not.toBeNull();
    expect(r.real).not.toBeNull();
    expect(r.comparison!.hasRealizedSignal).toBe(true);
  });

  it("paper made money but live realizes ≤ 0 → diverged", async () => {
    const id = mkPlaybook();
    seedPaperRoundTrips(id, { pairs: 5, buyPx: 2000, sellPx: 2100 });
    // Live SELLS below cost → negative realized per fill.
    seedRealRoundTrips(id, { pairs: 3, buyPx: 2000, sellPx: 1900 });
    const r = await outcome(id);
    expect(r.verdict).toBe("diverged");
    expect(r.reasons.some((x) => /not making money with real execution/.test(x))).toBe(true);
  });

  it("live per-fill PnL well below paper → underperforming", async () => {
    const id = mkPlaybook();
    // Paper edge +$100/ETH → +$5/sell.
    seedPaperRoundTrips(id, { pairs: 5, buyPx: 2000, sellPx: 2100 });
    // Live edge only +$20/ETH → +$1/sell = 20% of paper (< 60%).
    seedRealRoundTrips(id, { pairs: 3, buyPx: 2000, sellPx: 2020 });
    const r = await outcome(id);
    expect(r.verdict).toBe("underperforming");
    expect(r.reasons.some((x) => new RegExp(`< ${UNDERPERFORM_RATIO_PCT}%`).test(x))).toBe(true);
    expect(r.comparison!.realizedPerFillRatioPct).toBeCloseTo(20, 5);
  });

  it("live slippage materially worse than paper assumed → underperforming flag", async () => {
    const id = mkPlaybook();
    // Same PnL edge so only slippage diverges. Paper assumed 20bps, live 60bps = 3×.
    seedPaperRoundTrips(id, { pairs: 5, buyPx: 2000, sellPx: 2100, slippageBps: 20 });
    seedRealRoundTrips(id, { pairs: 3, buyPx: 2000, sellPx: 2100, slippageBps: 60 });
    const r = await outcome(id);
    expect(r.verdict).toBe("underperforming");
    expect(r.reasons.some((x) => /slippage .* is .*× the paper-assumed/.test(x))).toBe(true);
    expect(r.comparison!.slippageRatioPct).toBeCloseTo(300, 5);
  });

  it("paper never closed a position → verdict rests on execution+cadence (no PnL divide)", async () => {
    const id = mkPlaybook();
    // Paper: buys only, no sells → realized 0, no PnL signal.
    for (let i = 0; i < 8; i++) {
      recordPaperTrade({
        timestamp: new Date(NOW.getTime() - (i + 1) * (10 / 8) * 86_400_000).toISOString(),
        source_type: "schedule", source_id: 1,
        chain: "base", account: "default", direction: "buy",
        base_token: WETH, base_symbol: "WETH", base_amount: "0.05",
        quote_token: USDC, quote_symbol: "USDC", quote_amount: "100",
        price: "2000", slippage_bps: 30, strategy: `playbook:${id}`, notes: null,
      });
    }
    // Live: buys only too, matching slippage + cadence → on_track.
    for (let i = 0; i < 4; i++) {
      insertTrade({
        timestamp: new Date(NOW.getTime() - (i + 1) * (4 / 4) * 86_400_000).toISOString(),
        chain: "base", account: "default", direction: "buy",
        base_token: WETH, base_symbol: "WETH", base_amount: "0.05",
        quote_token: USDC, quote_symbol: "USDC", quote_amount: "100",
        price: "2000", tx_hash: `0xnb${i}`, status: "success",
        gas_used: null, gas_price_wei: null, gas_cost_native: "0.001",
        aggregator: "kyberswap", fee_tier: null, notes: null,
        strategy: `playbook:${id}`, realized_slippage_bps: 30,
      });
    }
    const r = await outcome(id);
    expect(r.comparison!.hasRealizedSignal).toBe(false);
    expect(r.verdict).toBe("on_track");
    expect(r.reasons.some((x) => /never closed a position/.test(x))).toBe(true);
  });
});

describe("normalization + rendering", () => {
  it("compares per-fill and per-week, not raw totals", async () => {
    const id = mkPlaybook();
    // Paper: many fills (10) over 10 days. Live: few (6) over 4 days.
    seedPaperRoundTrips(id, { pairs: 5, buyPx: 2000, sellPx: 2100, daysSpread: 10 });
    seedRealRoundTrips(id, { pairs: 3, buyPx: 2000, sellPx: 2100, daysSpread: 4 });
    const r = await outcome(id);
    expect(r.paper!.fills).toBe(10);
    expect(r.real!.fills).toBe(6);
    // Same edge → per-fill realized matches despite different totals.
    expect(r.comparison!.realizedPerFillRatioPct).toBeCloseTo(100, 0);
  });

  it("expresses live gas in USD when nativeUsd given; native-only when null", async () => {
    const id = mkPlaybook();
    seedPaperRoundTrips(id, { pairs: 5, buyPx: 2000, sellPx: 2100 });
    seedRealRoundTrips(id, { pairs: 3, buyPx: 2000, sellPx: 2100, gasNative: 0.002 });
    const withUsd = await outcome(id); // nativeUsd 2000 → $4/fill
    expect(withUsd.real!.gasUsdPerFill).toBeCloseTo(4, 6);
    const native = await outcome(id, { nativeUsd: null });
    expect(native.real!.gasUsdPerFill).toBeNull();
    expect(native.real!.avgGasNative).toBeCloseTo(0.002, 9);
  });

  it("renders verdict, both eras, and the comparison block", async () => {
    const id = mkPlaybook();
    seedPaperRoundTrips(id, { pairs: 5, buyPx: 2000, sellPx: 2100 });
    seedRealRoundTrips(id, { pairs: 3, buyPx: 2000, sellPx: 2100 });
    const text = renderPromoteOutcome(await outcome(id));
    expect(text).toMatch(/Promote outcome — playbook #/);
    expect(text).toMatch(/Verdict: /);
    expect(text).toMatch(/Paper\s+\d+ fills/);
    expect(text).toMatch(/Real\s+\d+ fills/);
    expect(text).toMatch(/Per-fill realized:/);
  });
});
