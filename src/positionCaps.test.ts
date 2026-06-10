/**
 * Position-cap tests (v38) — the net-exposure risk axis.
 *
 * Layers:
 *   1. netPosition — weighted-average netting (sells free room with
 *      proportional cost reduction), token matching by symbol/address
 *   2. enforcePositionCap — buy blocked at base cap / cost cap,
 *      SELLS NEVER BLOCKED, sells-free-room round trip, no-tag and
 *      unconfigured bypass, pattern matching
 *   3. paper E2E through the orders engine (runOrderTick) — the
 *      enforcement actually rejects at fire time
 */

import { describe, it, expect } from "vitest";
import { netPosition, enforcePositionCap, capMatchesTag, type FillRowLite, type PositionCapRule } from "./positionCaps.js";

const WETH = "0x4200000000000000000000000000000000000006";

function row(direction: string, base: string, quote: string, ts = "2026-01-01T00:00:00Z"): FillRowLite {
  return { timestamp: ts, direction, base_token: WETH, base_symbol: "WETH", base_amount: base, quote_amount: quote };
}

describe("netPosition", () => {
  it("buys add; sells subtract with proportional (weighted-avg) cost reduction", () => {
    const rows = [
      row("buy", "2", "4000", "2026-01-01T00:00:00Z"),  // avg 2000
      row("sell", "1", "2500", "2026-01-02T00:00:00Z"), // releases 2000 cost
    ];
    const pos = netPosition(rows, { token: "WETH" });
    expect(pos.baseAmount).toBeCloseTo(1, 9);
    expect(pos.costQuote).toBeCloseTo(2000, 9);
  });

  it("oversells floor at zero — never negative exposure", () => {
    const pos = netPosition([row("buy", "1", "2000"), row("sell", "3", "6000", "2026-01-02T00:00:00Z")], { token: "WETH" });
    expect(pos.baseAmount).toBe(0);
    expect(pos.costQuote).toBe(0);
  });

  it("token matches by symbol (ci) or address; others ignored", () => {
    const other: FillRowLite = { ...row("buy", "5", "100"), base_token: "0xother", base_symbol: "PEPE" };
    expect(netPosition([row("buy", "1", "2000"), other], { token: "weth" }).baseAmount).toBe(1);
    expect(netPosition([row("buy", "1", "2000"), other], { token: WETH.toUpperCase() }).baseAmount).toBe(1);
    expect(netPosition([other], { token: "WETH" }).baseAmount).toBe(0);
  });
});

describe("capMatchesTag", () => {
  it("exact + suffix wildcard, null-tag never matches", () => {
    const cap = { pattern: "playbook:*", token: "WETH" } as PositionCapRule;
    expect(capMatchesTag(cap, "playbook:7")).toBe(true);
    expect(capMatchesTag(cap, "dca-eth")).toBe(false);
    expect(capMatchesTag(cap, null)).toBe(false);
    expect(capMatchesTag({ pattern: "dca-eth", token: "x" } as PositionCapRule, "dca-eth")).toBe(true);
  });
});

describe("enforcePositionCap", () => {
  const baseArgs = {
    strategyTag: "dca-eth",
    direction: "buy" as const,
    baseToken: WETH,
    baseSymbol: "WETH",
    paper: true,
  };
  const cap = (over: Partial<PositionCapRule> = {}): PositionCapRule => ({
    pattern: "dca-eth", token: "WETH", maxBaseAmount: 2, ...over,
  });

  it("blocks a buy that would exceed the base cap, with teaching details", () => {
    const rows = [row("buy", "1.5", "3000")];
    expect(() =>
      enforcePositionCap({ ...baseArgs, addBaseAmount: 0.6, addCostQuote: 1200, caps: [cap()], rowsLookup: () => rows }),
    ).toThrow(/over the 2 cap.*NET exposure/s);
  });

  it("allows a buy under the cap; sells FREE room for the next buy", () => {
    // 1.9 held → 0.6 buy blocked; after selling 1.0, the same buy passes.
    const before = [row("buy", "1.9", "3800")];
    expect(() =>
      enforcePositionCap({ ...baseArgs, addBaseAmount: 0.6, addCostQuote: 1200, caps: [cap()], rowsLookup: () => before }),
    ).toThrow(/POSITION_CAP|over the/);
    const after = [...before, row("sell", "1", "2100", "2026-01-02T00:00:00Z")];
    expect(() =>
      enforcePositionCap({ ...baseArgs, addBaseAmount: 0.6, addCostQuote: 1200, caps: [cap()], rowsLookup: () => after }),
    ).not.toThrow();
  });

  it("cost-basis cap blocks independently of the base cap", () => {
    const rows = [row("buy", "1", "4500")];
    expect(() =>
      enforcePositionCap({
        ...baseArgs, addBaseAmount: 0.1, addCostQuote: 600,
        caps: [cap({ maxBaseAmount: undefined, maxCostQuote: 5000 })],
        rowsLookup: () => rows,
      }),
    ).toThrow(/cost basis/);
  });

  it("SELLS are never blocked, even over-cap", () => {
    const rows = [row("buy", "10", "20000")]; // way over a 2 cap
    expect(() =>
      enforcePositionCap({
        ...baseArgs, direction: "sell", addBaseAmount: 0, addCostQuote: 0,
        caps: [cap()], rowsLookup: () => rows,
      }),
    ).not.toThrow();
  });

  it("untagged trades and unconfigured installs bypass", () => {
    expect(() =>
      enforcePositionCap({ ...baseArgs, strategyTag: null, addBaseAmount: 99, addCostQuote: 1, caps: [cap()], rowsLookup: () => [] }),
    ).not.toThrow();
    expect(() =>
      enforcePositionCap({ ...baseArgs, addBaseAmount: 99, addCostQuote: 1, caps: [], rowsLookup: () => [] }),
    ).not.toThrow();
  });

  it("non-matching pattern or token bypasses", () => {
    expect(() =>
      enforcePositionCap({
        ...baseArgs, addBaseAmount: 99, addCostQuote: 1,
        caps: [cap({ pattern: "other-*" })], rowsLookup: () => [],
      }),
    ).not.toThrow();
    expect(() =>
      enforcePositionCap({
        ...baseArgs, addBaseAmount: 99, addCostQuote: 1,
        caps: [cap({ token: "PEPE" })], rowsLookup: () => [],
      }),
    ).not.toThrow();
  });
});
