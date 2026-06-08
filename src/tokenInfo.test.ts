// Iter629: tests for the pure compose helper in tokenInfo.ts. The
// orchestrator (gatherTokenInfo) is RPC-bound + covered indirectly by the CLI
// smoke tests; here we pin the compose math + advisory rules.

import { describe, expect, it } from "vitest";
import { composeTokenInfoReport } from "./tokenInfo.js";
import type { Address } from "viem";
import type { ApprovalRow } from "./approvals.js";
import type { TradeRow } from "./db.js";
import type { TokenMetadata } from "./tokens.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const SPENDER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const SPENDER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const OWNER = "0x1111111111111111111111111111111111111111" as Address;

const usdcMeta: TokenMetadata = {
  address: USDC,
  chainId: 8453,
  decimals: 6,
  symbol: "USDC",
  isNative: false,
};

function approval(overrides: Partial<ApprovalRow>): ApprovalRow {
  return {
    token: USDC,
    symbol: "USDC",
    decimals: 6,
    spender: SPENDER_A,
    allowance: 1_000_000n,
    display: "1.0",
    spenderLabel: undefined,
    ...overrides,
  };
}

function trade(overrides: Partial<TradeRow>): TradeRow {
  return {
    id: 1,
    timestamp: "2026-05-29T00:00:00Z",
    chain: "base",
    account: "alice",
    direction: "buy",
    base_token: USDC.toLowerCase(),
    base_symbol: "USDC",
    base_amount: "100",
    quote_token: "0xeee",
    quote_symbol: "ETH",
    quote_amount: "0.033",
    price: "0.00033",
    tx_hash: "0xabc",
    status: "success",
    gas_used: null,
    gas_price_wei: null,
    gas_cost_native: null,
    aggregator: "kyberswap",
    fee_tier: null,
    notes: null,
    ...overrides,
  };
}

describe("composeTokenInfoReport", () => {
  it("converts raw balance to decimal + USD when price is known", () => {
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: 1,
      priceSource: "coingecko_or_dexscreener",
      balanceRaw: 100_000_000n, // 100 USDC at 6 decimals
      approvals: [],
      approvalSeverityByPair: new Map(),
      trades: [],
    });
    expect(r.balance).toBe("100");
    expect(r.balanceUsd).toBeCloseTo(100, 2);
  });

  it("balanceUsd is null when price is missing", () => {
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: null,
      priceSource: "none",
      balanceRaw: 100_000_000n,
      approvals: [],
      approvalSeverityByPair: new Map(),
      trades: [],
    });
    expect(r.balance).toBe("100");
    expect(r.balanceUsd).toBeNull();
  });

  it("filters approvals to ones matching the queried token", () => {
    const OTHER = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: 1,
      priceSource: "coingecko_or_dexscreener",
      balanceRaw: 0n,
      approvals: [
        approval({ token: USDC, spender: SPENDER_A }),
        approval({ token: OTHER, spender: SPENDER_B }), // different token — should be filtered out
      ],
      approvalSeverityByPair: new Map([
        [`${USDC.toLowerCase()}:${SPENDER_A.toLowerCase()}`, "warn"],
      ]),
      trades: [],
    });
    expect(r.approvals.length).toBe(1);
    expect(r.approvals[0].spender).toBe(SPENDER_A);
  });

  it("sorts approvals critical → warn → ok", () => {
    const SPENDER_C = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
    const sevMap = new Map<string, "critical" | "warn" | "ok">([
      [`${USDC.toLowerCase()}:${SPENDER_A.toLowerCase()}`, "warn"],
      [`${USDC.toLowerCase()}:${SPENDER_B.toLowerCase()}`, "critical"],
      [`${USDC.toLowerCase()}:${SPENDER_C.toLowerCase()}`, "ok"],
    ]);
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: 1,
      priceSource: "coingecko_or_dexscreener",
      balanceRaw: 0n,
      approvals: [
        approval({ token: USDC, spender: SPENDER_A }),
        approval({ token: USDC, spender: SPENDER_B }),
        approval({ token: USDC, spender: SPENDER_C }),
      ],
      approvalSeverityByPair: sevMap,
      trades: [],
    });
    expect(r.approvals[0].severity).toBe("critical");
    expect(r.approvals[1].severity).toBe("warn");
    expect(r.approvals[2].severity).toBe("ok");
  });

  it("counts severity buckets correctly", () => {
    const sevMap = new Map<string, "critical" | "warn" | "ok">([
      [`${USDC.toLowerCase()}:${SPENDER_A.toLowerCase()}`, "critical"],
      [`${USDC.toLowerCase()}:${SPENDER_B.toLowerCase()}`, "warn"],
    ]);
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: 1,
      priceSource: "coingecko_or_dexscreener",
      balanceRaw: 0n,
      approvals: [
        approval({ token: USDC, spender: SPENDER_A }),
        approval({ token: USDC, spender: SPENDER_B }),
      ],
      approvalSeverityByPair: sevMap,
      trades: [],
    });
    expect(r.approvalCounts).toEqual({ critical: 1, warn: 1, ok: 0 });
  });

  it("filters trades to ones touching the queried token (as base OR quote)", () => {
    const OTHER = "0xcccccccccccccccccccccccccccccccccccccccc";
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: 1,
      priceSource: "coingecko_or_dexscreener",
      balanceRaw: 0n,
      approvals: [],
      approvalSeverityByPair: new Map(),
      trades: [
        trade({ tx_hash: "0xa", base_token: USDC.toLowerCase() }),
        trade({ tx_hash: "0xb", base_token: OTHER, quote_token: USDC.toLowerCase() }),
        trade({ tx_hash: "0xc", base_token: OTHER, quote_token: OTHER }), // doesn't touch — excluded
      ],
    });
    expect(r.recentTrades.length).toBe(2);
    expect(r.recentTrades.map((t) => t.txHash).sort()).toEqual(["0xa", "0xb"]);
    expect(r.totalTradeCount).toBe(2);
  });

  it("respects recentLimit when slicing trades", () => {
    const trades = Array.from({ length: 25 }, (_, i) =>
      trade({ tx_hash: `0x${i}`, base_token: USDC.toLowerCase() }),
    );
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: 1,
      priceSource: "coingecko_or_dexscreener",
      balanceRaw: 0n,
      approvals: [],
      approvalSeverityByPair: new Map(),
      trades,
      recentLimit: 5,
    });
    expect(r.recentTrades.length).toBe(5);
    expect(r.totalTradeCount).toBe(25); // unbounded count for context
  });

  it("advisory fires for critical approvals", () => {
    const sevMap = new Map<string, "critical" | "warn" | "ok">([
      [`${USDC.toLowerCase()}:${SPENDER_A.toLowerCase()}`, "critical"],
    ]);
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: 1,
      priceSource: "coingecko_or_dexscreener",
      balanceRaw: 0n,
      approvals: [approval({ token: USDC, spender: SPENDER_A })],
      approvalSeverityByPair: sevMap,
      trades: [],
    });
    expect(r.advisory).toMatch(/CRITICAL approval/);
  });

  it("advisory fires for warn approvals when no critical", () => {
    const sevMap = new Map<string, "critical" | "warn" | "ok">([
      [`${USDC.toLowerCase()}:${SPENDER_A.toLowerCase()}`, "warn"],
    ]);
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: 1,
      priceSource: "coingecko_or_dexscreener",
      balanceRaw: 0n,
      approvals: [approval({ token: USDC, spender: SPENDER_A })],
      approvalSeverityByPair: sevMap,
      trades: [],
    });
    expect(r.advisory).toMatch(/warn-level approval/);
  });

  it("advisory fires for missing-price WHEN there's a non-zero balance", () => {
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: null,
      priceSource: "none",
      balanceRaw: 100_000_000n, // non-zero balance
      approvals: [],
      approvalSeverityByPair: new Map(),
      trades: [],
    });
    expect(r.advisory).toMatch(/No price oracle/);
  });

  it("no advisory when nothing is actionable", () => {
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: 1,
      priceSource: "coingecko_or_dexscreener",
      balanceRaw: 100_000_000n,
      approvals: [],
      approvalSeverityByPair: new Map(),
      trades: [],
    });
    expect(r.advisory).toBeUndefined();
  });

  it("critical advisory beats warn (priority order)", () => {
    const sevMap = new Map<string, "critical" | "warn" | "ok">([
      [`${USDC.toLowerCase()}:${SPENDER_A.toLowerCase()}`, "critical"],
      [`${USDC.toLowerCase()}:${SPENDER_B.toLowerCase()}`, "warn"],
    ]);
    const r = composeTokenInfoReport({
      chain: "base",
      address: USDC,
      owner: OWNER,
      metadata: usdcMeta,
      priceUsd: 1,
      priceSource: "coingecko_or_dexscreener",
      balanceRaw: 0n,
      approvals: [
        approval({ token: USDC, spender: SPENDER_A }),
        approval({ token: USDC, spender: SPENDER_B }),
      ],
      approvalSeverityByPair: sevMap,
      trades: [],
    });
    expect(r.advisory).toMatch(/CRITICAL/);
    expect(r.advisory).not.toMatch(/warn-level/);
  });
});
