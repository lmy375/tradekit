/**
 * Protect-action tests (v79). Two layers:
 *  1) selectPositionsToProtect — pure: which positions need a stop + the amount
 *     to cover (skip protected, top up partials, token filter). Synthetic report.
 *  2) protectPositions — integration on a temp DB: seed a paper position with no
 *     stop → protect creates a trailing stop for the held amount; re-run is
 *     idempotent (already protected → skipped); simulate creates nothing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── pure layer ──────────────────────────────────────────────

import { selectPositionsToProtect } from "./protect.js";
import type { PositionProtectionReport, PositionProtection } from "./positionProtection.js";

const WETH = "0x4200000000000000000000000000000000000006";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";

function p(over: Partial<PositionProtection>): PositionProtection {
  return {
    chain: "base", token: WETH, symbol: "WETH", heldAmount: 2, heldValueUsd: 6000,
    protectedAmount: 0, unprotectedAmount: 2, unprotectedValueUsd: 6000,
    status: "unprotected", protectingOrders: [], takeProfitOrders: 0, ...over,
  };
}
const report = (positions: PositionProtection[]): PositionProtectionReport => ({
  positions, totalValueUsd: 0, totalUnprotectedValueUsd: 0, unprotectedCount: 0, partialCount: 0, unpricedCount: 0, summary: "", generatedAt: "x",
});

describe("selectPositionsToProtect", () => {
  it("selects unprotected positions for their full held amount", () => {
    const t = selectPositionsToProtect(report([p({ status: "unprotected", unprotectedAmount: 2 })]));
    expect(t).toHaveLength(1);
    expect(t[0].amount).toBe(2);
  });

  it("skips fully-protected positions", () => {
    const t = selectPositionsToProtect(report([p({ status: "protected", unprotectedAmount: 0 })]));
    expect(t).toHaveLength(0);
  });

  it("tops up a PARTIAL position by only the unprotected remainder", () => {
    const t = selectPositionsToProtect(report([p({ status: "partial", heldAmount: 2, protectedAmount: 1.5, unprotectedAmount: 0.5 })]));
    expect(t).toHaveLength(1);
    expect(t[0].amount).toBe(0.5); // not the full 2
  });

  it("filters by token (symbol or address)", () => {
    const r = report([p({ token: WETH, symbol: "WETH" }), p({ token: WBTC, symbol: "WBTC" })]);
    expect(selectPositionsToProtect(r, { token: "WBTC" }).map((x) => x.symbol)).toEqual(["WBTC"]);
    expect(selectPositionsToProtect(r, { token: WETH }).map((x) => x.symbol)).toEqual(["WETH"]);
  });
});

// ── integration layer ───────────────────────────────────────

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-protect-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { openDb, closeDb, recordPaperTrade, listOrders } = await import("./db.js");
const { protectPositions, createEntryStop } = await import("./protect.js");
const { configSchema } = await import("./config.js");

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, close() {} } as unknown as import("./logger.js").Logger;
const config = configSchema.parse({ activeChain: "base", activeAccount: "default" });

beforeAll(() => { openDb(); });
afterAll(() => { closeDb(); rmSync(tmpDataDir, { recursive: true, force: true }); });
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM orders");
});

function seedPaperPosition(base: string, sym: string, amount: string, quote: string) {
  recordPaperTrade({
    timestamp: new Date().toISOString(), source_type: "manual", source_id: null, chain: "base", account: "default",
    direction: "buy", base_token: base, base_symbol: sym, base_amount: amount, quote_token: USDC, quote_symbol: "USDC",
    quote_amount: quote, price: "0", slippage_bps: null, strategy: "p", notes: null,
  });
}

describe("protectPositions (paper, temp DB)", () => {
  it("creates a trailing stop covering an unprotected position", async () => {
    seedPaperPosition(WETH, "WETH", "2", "6000");
    const r = await protectPositions({ config, logger: silentLogger, mode: "paper", trailPct: 12 });
    expect(r.created).toHaveLength(1);
    expect(r.created[0].symbol).toBe("WETH");
    expect(r.created[0].amount).toBeCloseTo(2, 6);
    expect(r.created[0].trailPct).toBe(12);
    // The order actually landed, as a paper trailing sell of the held amount.
    const orders = listOrders({ status: "active" });
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe("sell");
    expect(orders[0].trigger_type).toBe("trailing");
    expect(orders[0].trail_pct).toBe(12);
    expect(parseFloat(orders[0].base_amount!)).toBeCloseTo(2, 6);
  });

  it("is idempotent — a second run protects nothing (already covered)", async () => {
    seedPaperPosition(WETH, "WETH", "2", "6000");
    await protectPositions({ config, logger: silentLogger, mode: "paper" });
    const second = await protectPositions({ config, logger: silentLogger, mode: "paper" });
    expect(second.created).toHaveLength(0);
    expect(second.alreadyProtected.length).toBeGreaterThanOrEqual(1);
    expect(listOrders({ status: "active" })).toHaveLength(1); // not duplicated
  });

  it("simulate plans without creating any order", async () => {
    seedPaperPosition(WETH, "WETH", "1", "3000");
    const r = await protectPositions({ config, logger: silentLogger, mode: "paper", simulate: true });
    expect(r.simulate).toBe(true);
    expect(r.created).toHaveLength(1); // the PLAN
    expect(listOrders({ status: "active" })).toHaveLength(0); // nothing actually created
  });

  it("no positions → nothing to do", async () => {
    const r = await protectPositions({ config, logger: silentLogger, mode: "paper" });
    expect(r.created).toHaveLength(0);
    expect(r.summary).toMatch(/No open positions/);
  });
});

describe("createEntryStop (v79 source-level protection)", () => {
  const buyResult = {
    direction: "buy" as const, status: "success" as const,
    baseToken: WETH, baseSymbol: "WETH", quoteToken: USDC, baseAmount: "1.5",
  };

  it("creates a trailing stop for a successful BUY's received amount", async () => {
    const r = await createEntryStop({ result: buyResult, trailPct: 10, config, account: "default", chain: "base", paper: true });
    expect(r.created).toBe(true);
    expect(r.amount).toBeCloseTo(1.5, 6);
    expect(r.trailPct).toBe(10);
    const orders = listOrders({ status: "active" });
    expect(orders).toHaveLength(1);
    expect(orders[0].trigger_type).toBe("trailing");
    expect(parseFloat(orders[0].base_amount!)).toBeCloseTo(1.5, 6);
  });

  it("skips a SELL (reduces exposure, nothing to protect)", async () => {
    const r = await createEntryStop({ result: { ...buyResult, direction: "sell" }, trailPct: 10, config, account: "default", chain: "base", paper: true });
    expect(r.created).toBe(false);
    expect(r.skipped).toMatch(/sell/i);
    expect(listOrders({ status: "active" })).toHaveLength(0);
  });

  it("skips a failed trade", async () => {
    const r = await createEntryStop({ result: { ...buyResult, status: "failed" }, trailPct: 10, config, account: "default", chain: "base", paper: true });
    expect(r.created).toBe(false);
    expect(r.skipped).toMatch(/fill/i);
  });
});
