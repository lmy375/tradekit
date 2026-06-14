/**
 * Strategy-comparison tests (v83). The pure core ranks strategies by realized
 * P&L with win rate / closes / volume, flags bleeders, and excludes
 * non-stablecoin-quoted (unpriceable) trades — all via the shared cost-basis
 * reducer. Plus an integration pass on a temp DB (paper book).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStrategyComparison, enforceStrategyLossBreaker, type StrategyTradeLite } from "./strategyCompare.js";
import { ToolError } from "./errors.js";

const WETH = "0x4200000000000000000000000000000000000006";
let ts = 0;
function fill(o: Partial<StrategyTradeLite>): StrategyTradeLite {
  ts += 1;
  return {
    strategy: "a", chain: "base", direction: "buy", base_token: WETH, base_symbol: "WETH",
    base_amount: "1", quote_amount: "2000", quote_symbol: "USDC",
    timestamp: `2026-06-${String(ts).padStart(2, "0")}T00:00:00Z`, ...o,
  };
}

describe("computeStrategyComparison", () => {
  it("ranks strategies by realized P&L (winners first)", () => {
    const r = computeStrategyComparison([
      // strategy a: buy 1@2000, sell 1@2500 → +500
      fill({ strategy: "a", direction: "buy", base_amount: "1", quote_amount: "2000" }),
      fill({ strategy: "a", direction: "sell", base_amount: "1", quote_amount: "2500" }),
      // strategy b: buy 1@3000, sell 1@2400 → -600
      fill({ strategy: "b", direction: "buy", base_amount: "1", quote_amount: "3000" }),
      fill({ strategy: "b", direction: "sell", base_amount: "1", quote_amount: "2400" }),
    ]);
    expect(r.strategies.map((s) => s.strategy)).toEqual(["a", "b"]); // +500 before -600
    expect(r.strategies[0].realizedUsd).toBeCloseTo(500, 6);
    expect(r.strategies[1].realizedUsd).toBeCloseTo(-600, 6);
    expect(r.best!.strategy).toBe("a");
    expect(r.worst!.strategy).toBe("b");
    expect(r.bleeding).toEqual(["b"]);
    expect(r.totalRealizedUsd).toBeCloseTo(-100, 6);
  });

  it("computes win rate from closed sells", () => {
    const r = computeStrategyComparison([
      fill({ strategy: "a", direction: "buy", base_amount: "3", quote_amount: "6000" }), // avg 2000
      fill({ strategy: "a", direction: "sell", base_amount: "1", quote_amount: "2500" }), // +500 win
      fill({ strategy: "a", direction: "sell", base_amount: "1", quote_amount: "2200" }), // +200 win
      fill({ strategy: "a", direction: "sell", base_amount: "1", quote_amount: "1800" }), // -200 loss
    ]);
    const a = r.strategies[0];
    expect(a.closes).toBe(3);
    expect(a.wins).toBe(2);
    expect(a.losses).toBe(1);
    expect(a.winRatePct).toBeCloseTo(66.67, 1);
    expect(a.avgRealizedPerClose).toBeCloseTo((500 + 200 - 200) / 3, 6);
  });

  it("excludes non-stablecoin-quoted trades from P&L (can't value deterministically)", () => {
    const r = computeStrategyComparison([
      fill({ strategy: "a", direction: "buy", base_amount: "1", quote_amount: "2000", quote_symbol: "USDC" }),
      fill({ strategy: "a", direction: "sell", base_amount: "1", quote_amount: "1", quote_symbol: "WETH" }), // WETH quote → unpriced
    ]);
    expect(r.unpricedTrades).toBe(1);
    expect(r.strategies[0].tradeCount).toBe(1); // only the priced buy counted
    expect(r.strategies[0].closes).toBe(0);
  });

  it("untagged trades bucket under (none)", () => {
    const r = computeStrategyComparison([
      fill({ strategy: null, direction: "buy", base_amount: "1", quote_amount: "2000" }),
      fill({ strategy: null, direction: "sell", base_amount: "1", quote_amount: "2100" }),
    ]);
    expect(r.strategies[0].strategy).toBe("(none)");
    expect(r.strategies[0].realizedUsd).toBeCloseTo(100, 6);
  });

  it("win rate is null when nothing has closed (buys only)", () => {
    const r = computeStrategyComparison([fill({ strategy: "a", direction: "buy" })]);
    expect(r.strategies[0].winRatePct).toBeNull();
    expect(r.strategies[0].avgRealizedPerClose).toBeNull();
  });

  it("empty input → empty report", () => {
    const r = computeStrategyComparison([]);
    expect(r.strategies).toHaveLength(0);
    expect(r.best).toBeNull();
    expect(r.summary).toMatch(/No priced/);
  });

  it("isolates positions per (chain, token) within a strategy", () => {
    // Same strategy trades WETH on base and a different token; realized must
    // attribute to the right cost basis, not cross-contaminate.
    const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
    const r = computeStrategyComparison([
      fill({ strategy: "a", direction: "buy", base_token: WETH, base_symbol: "WETH", base_amount: "1", quote_amount: "2000" }),
      fill({ strategy: "a", direction: "buy", base_token: WBTC, base_symbol: "WBTC", base_amount: "1", quote_amount: "60000" }),
      fill({ strategy: "a", direction: "sell", base_token: WETH, base_symbol: "WETH", base_amount: "1", quote_amount: "2500" }), // +500 vs WETH basis
    ]);
    expect(r.strategies[0].realizedUsd).toBeCloseTo(500, 6); // not contaminated by WBTC's 60000
  });
});

describe("enforceStrategyLossBreaker (v84)", () => {
  const lookup = (realized: number) => () => realized;

  it("throws STRATEGY_LOSS_BREAKER_TRIPPED when realized loss exceeds the limit", () => {
    expect(() =>
      enforceStrategyLossBreaker({ strategyTag: "a", maxLossUsd: 500, realizedLookup: lookup(-600) }),
    ).toThrowError(ToolError);
    try {
      enforceStrategyLossBreaker({ strategyTag: "a", maxLossUsd: 500, realizedLookup: lookup(-600) });
    } catch (e) {
      expect((e as ToolError).code).toBe("STRATEGY_LOSS_BREAKER_TRIPPED");
      expect((e as ToolError).message).toMatch(/600/);
    }
  });

  it("trips exactly AT the limit (≤ -max)", () => {
    expect(() =>
      enforceStrategyLossBreaker({ strategyTag: "a", maxLossUsd: 500, realizedLookup: lookup(-500) }),
    ).toThrowError(/loss breaker/);
  });

  it("allows when the loss is within the limit", () => {
    expect(() =>
      enforceStrategyLossBreaker({ strategyTag: "a", maxLossUsd: 500, realizedLookup: lookup(-400) }),
    ).not.toThrow();
  });

  it("allows a profitable strategy", () => {
    expect(() =>
      enforceStrategyLossBreaker({ strategyTag: "a", maxLossUsd: 500, realizedLookup: lookup(1200) }),
    ).not.toThrow();
  });

  it("is a no-op when unconfigured (no maxLossUsd) or untagged — and never calls the lookup", () => {
    let called = false;
    const spy = () => { called = true; return -9999; };
    enforceStrategyLossBreaker({ strategyTag: "a", maxLossUsd: undefined, realizedLookup: spy });
    enforceStrategyLossBreaker({ strategyTag: null, maxLossUsd: 500, realizedLookup: spy });
    enforceStrategyLossBreaker({ strategyTag: "a", maxLossUsd: 0, realizedLookup: spy });
    expect(called).toBe(false);
  });
});

// ── integration: gatherStrategyComparison on a temp DB (paper) ──

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-stratcompare-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;
const { openDb, closeDb, recordPaperTrade } = await import("./db.js");
const { gatherStrategyComparison } = await import("./strategyCompare.js");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

beforeAll(() => { openDb(); });
afterAll(() => { closeDb(); rmSync(tmpDataDir, { recursive: true, force: true }); });
beforeEach(() => { openDb().exec("DELETE FROM paper_trades"); });

function paper(strategy: string, dir: "buy" | "sell", amount: string, quote: string, day: number) {
  recordPaperTrade({
    timestamp: `2026-06-${String(day).padStart(2, "0")}T00:00:00Z`, source_type: "manual", source_id: null,
    chain: "base", account: "default", direction: dir, base_token: WETH, base_symbol: "WETH",
    base_amount: amount, quote_token: USDC, quote_symbol: "USDC", quote_amount: quote, price: "0",
    slippage_bps: null, strategy, notes: null,
  });
}

describe("gatherStrategyComparison (paper, temp DB)", () => {
  it("ranks paper strategies by realized P&L", () => {
    paper("winner", "buy", "1", "2000", 1);
    paper("winner", "sell", "1", "2600", 2); // +600
    paper("loser", "buy", "1", "2000", 1);
    paper("loser", "sell", "1", "1700", 2); // -300
    const r = gatherStrategyComparison({ mode: "paper" });
    expect(r.strategies.map((s) => s.strategy)).toEqual(["winner", "loser"]);
    expect(r.strategies[0].realizedUsd).toBeCloseTo(600, 6);
    expect(r.bleeding).toEqual(["loser"]);
  });
});
