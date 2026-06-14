/**
 * Preflight calibration tests (v75). The correlation is the load-bearing logic:
 * each preflight run claims the nearest subsequent same-key trade within the
 * window, one trade per run. Then per-verdict outcomes (fill/fail/slippage) and
 * the plain-language "is the verdict predictive?" read. Pure — synthetic runs +
 * trades, no DB.
 */

import { describe, it, expect } from "vitest";
import {
  correlatePreflightToTrades,
  summarizeCalibration,
  type PreflightLite,
  type TradeLite,
} from "./preflightCalibration.js";

const T0 = Date.parse("2026-06-14T00:00:00Z");
const at = (mins: number) => new Date(T0 + mins * 60_000).toISOString();
const WINDOW = 30 * 60_000;

function run(over: Partial<PreflightLite> = {}): PreflightLite {
  return { id: 1, timestamp: at(0), chain: "base", account: "default", direction: "buy", baseSymbol: "WETH", verdict: "go", ...over };
}
function trade(over: Partial<TradeLite> = {}): TradeLite {
  return { timestamp: at(1), chain: "base", account: "default", direction: "buy", baseSymbol: "WETH", status: "success", realizedSlippageBps: 20, ...over };
}

describe("correlatePreflightToTrades", () => {
  it("matches a run to the nearest subsequent same-key trade", () => {
    const { matches } = correlatePreflightToTrades([run({ timestamp: at(0) })], [trade({ timestamp: at(2) })], WINDOW);
    expect(matches[0].trade).not.toBeNull();
    expect(matches[0].trade!.realizedSlippageBps).toBe(20);
  });

  it("does NOT match a trade outside the window or before the decision", () => {
    const beforeDecision = correlatePreflightToTrades([run({ timestamp: at(10) })], [trade({ timestamp: at(5) })], WINDOW);
    expect(beforeDecision.matches[0].trade).toBeNull();
    const tooLate = correlatePreflightToTrades([run({ timestamp: at(0) })], [trade({ timestamp: at(45) })], WINDOW);
    expect(tooLate.matches[0].trade).toBeNull();
  });

  it("does NOT match across a different pair / direction / chain", () => {
    const r = run({ timestamp: at(0), baseSymbol: "WETH", direction: "buy", chain: "base" });
    expect(correlatePreflightToTrades([r], [trade({ baseSymbol: "PEPE" })], WINDOW).matches[0].trade).toBeNull();
    expect(correlatePreflightToTrades([r], [trade({ direction: "sell" })], WINDOW).matches[0].trade).toBeNull();
    expect(correlatePreflightToTrades([r], [trade({ chain: "arbitrum" })], WINDOW).matches[0].trade).toBeNull();
  });

  it("claims one trade per run — two runs don't share a trade", () => {
    const runs = [run({ id: 1, timestamp: at(0) }), run({ id: 2, timestamp: at(1) })];
    const trades = [trade({ timestamp: at(2), realizedSlippageBps: 11 })]; // only ONE trade
    const { matches } = correlatePreflightToTrades(runs, trades, WINDOW);
    const matched = matches.filter((m) => m.trade != null);
    expect(matched).toHaveLength(1); // the earlier run claims it; the second gets none
    expect(matches.find((m) => m.run.id === 1)!.trade).not.toBeNull();
    expect(matches.find((m) => m.run.id === 2)!.trade).toBeNull();
  });

  it("aggregates per verdict: fill/fail counts + median slippage", () => {
    const runs: PreflightLite[] = [
      run({ id: 1, timestamp: at(0), verdict: "go" }),
      run({ id: 2, timestamp: at(10), verdict: "go" }),
      run({ id: 3, timestamp: at(20), verdict: "caution" }),
    ];
    const trades: TradeLite[] = [
      trade({ timestamp: at(1), status: "success", realizedSlippageBps: 20 }),
      trade({ timestamp: at(11), status: "success", realizedSlippageBps: 30 }),
      trade({ timestamp: at(21), status: "failed", realizedSlippageBps: null }),
    ];
    const { byVerdict } = correlatePreflightToTrades(runs, trades, WINDOW);
    const go = byVerdict.find((v) => v.verdict === "go")!;
    expect(go.runs).toBe(2);
    expect(go.filled).toBe(2);
    expect(go.medianSlippageBps).toBe(25); // median of 20,30
    const caution = byVerdict.find((v) => v.verdict === "caution")!;
    expect(caution.failed).toBe(1);
    expect(caution.filled).toBe(0);
  });

  it("orders verdicts go → caution → no_go", () => {
    const runs = [run({ id: 1, verdict: "no_go", timestamp: at(0) }), run({ id: 2, verdict: "go", timestamp: at(5) })];
    const { byVerdict } = correlatePreflightToTrades(runs, [], WINDOW);
    expect(byVerdict.map((v) => v.verdict)).toEqual(["go", "no_go"]);
  });
});

describe("summarizeCalibration", () => {
  it("flags the verdict as predictive when caution trades slip worse", () => {
    const s = summarizeCalibration([
      { verdict: "go", runs: 5, matched: 5, filled: 5, failed: 0, pending: 0, medianSlippageBps: 20 },
      { verdict: "caution", runs: 3, matched: 3, filled: 3, failed: 0, pending: 0, medianSlippageBps: 60 },
    ]);
    expect(s).toMatch(/predictive/);
  });

  it("notes when slippage isn't separated by verdict", () => {
    const s = summarizeCalibration([
      { verdict: "go", runs: 5, matched: 5, filled: 5, failed: 0, pending: 0, medianSlippageBps: 30 },
      { verdict: "caution", runs: 3, matched: 3, filled: 3, failed: 0, pending: 0, medianSlippageBps: 31 },
    ]);
    expect(s).toMatch(/isn't separated|similar/);
  });

  it("degrades gracefully with too little data", () => {
    const s = summarizeCalibration([{ verdict: "go", runs: 1, matched: 0, filled: 0, failed: 0, pending: 0, medianSlippageBps: null }]);
    expect(s).toMatch(/Not enough/);
  });
});
