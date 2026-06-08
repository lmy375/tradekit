// Iter605: unit tests for portfolio.ts pure aggregation logic. The orchestrator
// (aggregatePortfolio) needs HTTP and is covered by smoke tests; these unit
// tests pin the math + grouping rules so a regression in the cross-chain
// roll-up gets caught fast.

import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  aggregateTokens,
  computeConcentration,
  type AccountChainSnapshot,
} from "./portfolio.js";

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const USDC_ARB = "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as Address;
const WETH_BASE = "0x4200000000000000000000000000000000000006" as Address;

function snap(
  account: string,
  chain: string,
  balances: AccountChainSnapshot["balances"],
): AccountChainSnapshot {
  return {
    account,
    address: "0x1111111111111111111111111111111111111111" as Address,
    chain,
    chainId: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    balances,
    totalUsd: balances.reduce((s, b) => s + (b.usd ?? 0), 0),
  };
}

describe("aggregateTokens (iter605)", () => {
  it("returns empty aggregate for no snapshots", () => {
    const result = aggregateTokens([]);
    expect(result.tokens).toEqual([]);
    expect(result.totalUsd).toBe(0);
    expect(result.unpricedPositionCount).toBe(0);
  });

  it("ignores zero-balance positions (won't pollute the roll-up)", () => {
    const snapshots = [
      snap("alice", "base", [
        { symbol: "WETH", token: WETH_BASE, amount: "0", decimals: 18, usd: 0 },
      ]),
    ];
    expect(aggregateTokens(snapshots).tokens).toEqual([]);
  });

  it("collapses NATIVE across chains by symbol", () => {
    // ETH on base + ETH on arbitrum → one row (same symbol, same native sentinel).
    const snapshots = [
      snap("alice", "base", [{ symbol: "ETH", token: "NATIVE", amount: "1.0", decimals: 18, usd: 3000 }]),
      snap("alice", "arbitrum", [{ symbol: "ETH", token: "NATIVE", amount: "0.5", decimals: 18, usd: 1500 }]),
    ];
    const result = aggregateTokens(snapshots);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].symbol).toBe("ETH");
    expect(result.tokens[0].totalUsd).toBe(4500);
    expect(result.tokens[0].perChain).toHaveLength(2);
    expect(result.totalUsd).toBe(4500);
  });

  it("keeps NATIVE rows separate when symbols differ (ETH vs MATIC)", () => {
    const snapshots = [
      snap("alice", "base", [{ symbol: "ETH", token: "NATIVE", amount: "1.0", decimals: 18, usd: 3000 }]),
      snap("alice", "polygon", [{ symbol: "MATIC", token: "NATIVE", amount: "100", decimals: 18, usd: 50 }]),
    ];
    const result = aggregateTokens(snapshots);
    expect(result.tokens).toHaveLength(2);
    const symbols = result.tokens.map((t) => t.symbol).sort();
    expect(symbols).toEqual(["ETH", "MATIC"]);
  });

  it("keeps cross-chain same-symbol ERC20 rows separate when addresses differ", () => {
    // USDC on Base and USDC on Arbitrum have DIFFERENT canonical addresses; they
    // are not fungible across chains absent a bridge. Stay separate rows.
    const snapshots = [
      snap("alice", "base", [{ symbol: "USDC", token: USDC_BASE, amount: "100", decimals: 6, usd: 100 }]),
      snap("alice", "arbitrum", [{ symbol: "USDC", token: USDC_ARB, amount: "200", decimals: 6, usd: 200 }]),
    ];
    const result = aggregateTokens(snapshots);
    expect(result.tokens).toHaveLength(2);
    expect(result.totalUsd).toBe(300);
  });

  it("sums USD across the same token + account combinations", () => {
    // Same WETH address across two accounts → one row with summed USD.
    const snapshots = [
      snap("alice", "base", [{ symbol: "WETH", token: WETH_BASE, amount: "1.0", decimals: 18, usd: 3000 }]),
      snap("bob", "base", [{ symbol: "WETH", token: WETH_BASE, amount: "2.0", decimals: 18, usd: 6000 }]),
    ];
    const result = aggregateTokens(snapshots);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].totalUsd).toBe(9000);
    expect(result.tokens[0].perChain).toHaveLength(2);
  });

  it("sorts tokens by totalUsd descending — biggest position first", () => {
    const snapshots = [
      snap("alice", "base", [
        { symbol: "USDC", token: USDC_BASE, amount: "100", decimals: 6, usd: 100 },
        { symbol: "WETH", token: WETH_BASE, amount: "1.0", decimals: 18, usd: 3000 },
      ]),
    ];
    const result = aggregateTokens(snapshots);
    expect(result.tokens[0].symbol).toBe("WETH");
    expect(result.tokens[1].symbol).toBe("USDC");
  });

  it("computes percentOfPortfolio against the priced total", () => {
    // 75/25 split: WETH 3000, USDC 1000 → 75%/25%.
    const snapshots = [
      snap("alice", "base", [
        { symbol: "WETH", token: WETH_BASE, amount: "1.0", decimals: 18, usd: 3000 },
        { symbol: "USDC", token: USDC_BASE, amount: "1000", decimals: 6, usd: 1000 },
      ]),
    ];
    const result = aggregateTokens(snapshots);
    expect(result.tokens[0].percentOfPortfolio).toBe(75);
    expect(result.tokens[1].percentOfPortfolio).toBe(25);
    expect(result.totalUsd).toBe(4000);
  });

  it("treats unpriced positions as undefined totalUsd (not 0)", () => {
    // A position with amount > 0 but no `usd` field. Roll-up totalUsd is
    // undefined; the position counts toward unpricedPositionCount.
    const snapshots = [
      snap("alice", "base", [
        { symbol: "SCAM", token: "0x0000000000000000000000000000000000000099" as Address, amount: "1000", decimals: 18 },
      ]),
    ];
    const result = aggregateTokens(snapshots);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].totalUsd).toBeUndefined();
    expect(result.tokens[0].percentOfPortfolio).toBeUndefined();
    expect(result.unpricedPositionCount).toBe(1);
    expect(result.totalUsd).toBe(0);
  });

  it("priced + unpriced mix: total reflects only priced positions; unpriced count separately", () => {
    const snapshots = [
      snap("alice", "base", [
        { symbol: "WETH", token: WETH_BASE, amount: "1.0", decimals: 18, usd: 3000 },
        { symbol: "SCAM", token: "0x0000000000000000000000000000000000000099" as Address, amount: "1000", decimals: 18 },
      ]),
    ];
    const result = aggregateTokens(snapshots);
    expect(result.totalUsd).toBe(3000);
    expect(result.unpricedPositionCount).toBe(1);
    // Priced first, unpriced last in sort.
    expect(result.tokens[0].symbol).toBe("WETH");
    expect(result.tokens[1].symbol).toBe("SCAM");
  });

  it("zero-total portfolio (all unpriced) gives no percentOfPortfolio anywhere", () => {
    const snapshots = [
      snap("alice", "base", [
        { symbol: "UNPRICED_1", token: "0x0000000000000000000000000000000000000001" as Address, amount: "1", decimals: 18 },
      ]),
    ];
    const result = aggregateTokens(snapshots);
    expect(result.tokens[0].percentOfPortfolio).toBeUndefined();
    expect(result.totalUsd).toBe(0);
  });
});

describe("computeConcentration (iter605)", () => {
  it("returns 0% for an empty token list", () => {
    expect(computeConcentration([])).toEqual({ top1: 0, top3: 0, top5: 0 });
  });

  it("single position is 100% top1/top3/top5", () => {
    const snapshots = [
      snap("alice", "base", [{ symbol: "WETH", token: WETH_BASE, amount: "1.0", decimals: 18, usd: 3000 }]),
    ];
    const { tokens } = aggregateTokens(snapshots);
    const c = computeConcentration(tokens);
    expect(c.top1).toBe(100);
    expect(c.top3).toBe(100);
    expect(c.top5).toBe(100);
  });

  it("top1 is < top3 is < top5 for a 5-position spread", () => {
    // 50/20/15/10/5 split.
    const snapshots = [
      snap("alice", "base", [
        { symbol: "A", token: "0x000000000000000000000000000000000000000a" as Address, amount: "1", decimals: 18, usd: 50 },
        { symbol: "B", token: "0x000000000000000000000000000000000000000b" as Address, amount: "1", decimals: 18, usd: 20 },
        { symbol: "C", token: "0x000000000000000000000000000000000000000c" as Address, amount: "1", decimals: 18, usd: 15 },
        { symbol: "D", token: "0x000000000000000000000000000000000000000d" as Address, amount: "1", decimals: 18, usd: 10 },
        { symbol: "E", token: "0x000000000000000000000000000000000000000e" as Address, amount: "1", decimals: 18, usd: 5 },
      ]),
    ];
    const { tokens } = aggregateTokens(snapshots);
    const c = computeConcentration(tokens);
    expect(c.top1).toBe(50);
    expect(c.top3).toBe(85); // 50 + 20 + 15
    expect(c.top5).toBe(100); // covers everything
  });

  it("top5 caps at the actual token count (no over-extension)", () => {
    // Only 2 tokens; top5 should still be 100%.
    const snapshots = [
      snap("alice", "base", [
        { symbol: "A", token: "0x000000000000000000000000000000000000000a" as Address, amount: "1", decimals: 18, usd: 60 },
        { symbol: "B", token: "0x000000000000000000000000000000000000000b" as Address, amount: "1", decimals: 18, usd: 40 },
      ]),
    ];
    const { tokens } = aggregateTokens(snapshots);
    const c = computeConcentration(tokens);
    expect(c.top1).toBe(60);
    expect(c.top3).toBe(100);
    expect(c.top5).toBe(100);
  });

  it("ignores unpriced positions in concentration math", () => {
    // 1 priced (100% of $50) + 1 unpriced. Concentration reflects priced-only.
    const snapshots = [
      snap("alice", "base", [
        { symbol: "WETH", token: WETH_BASE, amount: "1", decimals: 18, usd: 50 },
        { symbol: "UNK", token: "0x000000000000000000000000000000000000000a" as Address, amount: "1", decimals: 18 },
      ]),
    ];
    const { tokens } = aggregateTokens(snapshots);
    const c = computeConcentration(tokens);
    expect(c.top1).toBe(100); // 100% of the priced portfolio
  });
});
