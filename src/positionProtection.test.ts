/**
 * Position-protection audit tests (v76). The join is the load-bearing logic:
 * which open positions have a downside-protective sell order (trailing stop /
 * price_below stop-loss) covering them, how much is left unprotected, and the
 * value at risk. Pure — synthetic positions + orders, no DB.
 */

import { describe, it, expect } from "vitest";
import {
  computeProtection,
  type ProtPositionLite,
  type ProtOrderLite,
} from "./positionProtection.js";

const WETH = "0x4200000000000000000000000000000000000006";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";

function pos(over: Partial<ProtPositionLite> = {}): ProtPositionLite {
  return { chain: "base", token: WETH, symbol: "WETH", amount: 2, currentPriceQuote: 3000, valueQuote: 6000, ...over };
}
function order(over: Partial<ProtOrderLite> = {}): ProtOrderLite {
  return { id: 1, chain: "base", base_token: WETH, side: "sell", trigger_type: "trailing", base_amount: "max", trail_pct: 10, target_price_usd: null, ...over };
}

describe("computeProtection", () => {
  it("a position with no orders is UNPROTECTED, full value at risk", () => {
    const r = computeProtection([pos()], []);
    const p = r.positions[0];
    expect(p.status).toBe("unprotected");
    expect(p.unprotectedAmount).toBe(2);
    expect(p.unprotectedValueUsd).toBe(6000);
    expect(r.unprotectedCount).toBe(1);
    expect(r.totalUnprotectedValueUsd).toBe(6000);
    expect(r.summary).toMatch(/exposed with no stop/);
  });

  it("a 'max' trailing stop fully PROTECTS the position", () => {
    const r = computeProtection([pos()], [order({ base_amount: "max", trigger_type: "trailing" })]);
    const p = r.positions[0];
    expect(p.status).toBe("protected");
    expect(p.protectedAmount).toBe(2);
    expect(p.unprotectedValueUsd).toBe(0);
    expect(r.summary).toMatch(/have downside protection/);
  });

  it("a price_below stop-loss counts as protection", () => {
    const r = computeProtection([pos({ amount: 1 })], [order({ trigger_type: "price_below", base_amount: "1", target_price_usd: 2500, trail_pct: null })]);
    expect(r.positions[0].status).toBe("protected");
  });

  it("a fixed-amount order covering HALF leaves the position PARTIAL", () => {
    const r = computeProtection([pos({ amount: 2 })], [order({ base_amount: "1", trigger_type: "trailing" })]);
    const p = r.positions[0];
    expect(p.status).toBe("partial");
    expect(p.protectedAmount).toBe(1);
    expect(p.unprotectedAmount).toBe(1);
    expect(p.unprotectedValueUsd).toBe(3000);
    expect(r.partialCount).toBe(1);
  });

  it("a 'N%' sentinel covers that fraction of the held amount", () => {
    const r = computeProtection([pos({ amount: 4 })], [order({ base_amount: "25%" })]);
    expect(r.positions[0].protectedAmount).toBe(1); // 25% of 4
    expect(r.positions[0].status).toBe("partial");
  });

  it("a take-profit (price_above sell) is NOT downside protection — counted separately", () => {
    const r = computeProtection([pos({ amount: 1 })], [order({ trigger_type: "price_above", base_amount: "1", target_price_usd: 5000, trail_pct: null })]);
    const p = r.positions[0];
    expect(p.status).toBe("unprotected");
    expect(p.takeProfitOrders).toBe(1);
    expect(p.protectingOrders).toHaveLength(0);
  });

  it("does not match orders on a different token or chain", () => {
    const r = computeProtection(
      [pos({ token: WETH })],
      [order({ base_token: WBTC }), order({ chain: "arbitrum" })],
    );
    expect(r.positions[0].status).toBe("unprotected");
  });

  it("over-coverage (order amount > held) caps at the held amount", () => {
    const r = computeProtection([pos({ amount: 1 })], [order({ base_amount: "100", trigger_type: "trailing" })]);
    expect(r.positions[0].protectedAmount).toBe(1);
    expect(r.positions[0].status).toBe("protected");
  });

  it("unpriced position → null value at risk, still classified", () => {
    const r = computeProtection([pos({ currentPriceQuote: null, valueQuote: null })], []);
    expect(r.positions[0].status).toBe("unprotected");
    expect(r.positions[0].unprotectedValueUsd).toBeNull();
    expect(r.unpricedCount).toBe(1);
  });

  it("sorts the most-exposed position first + aggregates totals", () => {
    const r = computeProtection(
      [
        pos({ token: WETH, symbol: "WETH", amount: 1, currentPriceQuote: 3000, valueQuote: 3000 }), // $3000 at risk
        pos({ token: WBTC, symbol: "WBTC", amount: 1, currentPriceQuote: 60000, valueQuote: 60000 }), // $60000 at risk
      ],
      [],
    );
    expect(r.positions[0].symbol).toBe("WBTC"); // most exposed first
    expect(r.totalUnprotectedValueUsd).toBe(63000);
    expect(r.unprotectedCount).toBe(2);
  });
});
