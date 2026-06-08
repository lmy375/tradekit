// Iter619: tests for the pure helpers in tradeAnalysis.ts. The orchestrator
// (analyzeStoredTrade) is HTTP-bound + covered indirectly via the CLI smoke
// tests; pure-core scoring + comparison math is pinned here.

import { describe, expect, it } from "vitest";
import {
  classifySlippage,
  compareTradeExecution,
  bigintToFloat,
  analyzeStoredTrade,
} from "./tradeAnalysis.js";
import type { TradeRow } from "./db.js";
import type { ChainProfile } from "./chains.js";
import type { Logger } from "./logger.js";

describe("classifySlippage", () => {
  it("excellent for <=5 bps (incl. negative)", () => {
    expect(classifySlippage(0).code).toBe("excellent");
    expect(classifySlippage(3).code).toBe("excellent");
    expect(classifySlippage(5).code).toBe("excellent");
    expect(classifySlippage(-10).code).toBe("excellent"); // beat the quote
  });

  it("ok for 5 < bps <= 30", () => {
    expect(classifySlippage(6).code).toBe("ok");
    expect(classifySlippage(20).code).toBe("ok");
    expect(classifySlippage(30).code).toBe("ok");
  });

  it("minor_slip for 30 < bps <= 100", () => {
    expect(classifySlippage(31).code).toBe("minor_slip");
    expect(classifySlippage(100).code).toBe("minor_slip");
  });

  it("major_slip for 100 < bps <= 500", () => {
    expect(classifySlippage(101).code).toBe("major_slip");
    expect(classifySlippage(500).code).toBe("major_slip");
  });

  it("extreme_slip for > 500 bps", () => {
    expect(classifySlippage(501).code).toBe("extreme_slip");
    expect(classifySlippage(5000).code).toBe("extreme_slip");
  });

  it("unknown for non-finite slippage", () => {
    expect(classifySlippage(NaN).code).toBe("unknown");
    expect(classifySlippage(Infinity).code).toBe("unknown");
  });
});

describe("compareTradeExecution — buy direction", () => {
  it("exact match → zero slippage, excellent", () => {
    const out = compareTradeExecution({
      direction: "buy",
      quotedBase: 1.0,
      quotedQuote: 3000,
      actualBase: 1.0,
      actualQuote: 3000,
    });
    expect(out.slippageBps).toBe(0);
    expect(out.outputDelta).toBe(0);
    expect(out.finding.code).toBe("excellent");
  });

  it("got 1% less base → 100 bps slippage, minor_slip", () => {
    const out = compareTradeExecution({
      direction: "buy",
      quotedBase: 1.0,
      quotedQuote: 3000,
      actualBase: 0.99, // 1% less
      actualQuote: 3000,
    });
    expect(out.slippageBps).toBeCloseTo(100, 1);
    expect(out.outputDelta).toBeCloseTo(-0.01, 8);
    expect(out.finding.code).toBe("minor_slip");
  });

  it("got 5% less base → 500 bps slippage, major_slip (boundary)", () => {
    const out = compareTradeExecution({
      direction: "buy",
      quotedBase: 1.0,
      quotedQuote: 3000,
      actualBase: 0.95, // 5% less
      actualQuote: 3000,
    });
    expect(out.slippageBps).toBeCloseTo(500, 1);
    expect(out.finding.code).toBe("major_slip");
  });

  it("got more base than quoted → negative slippage, excellent", () => {
    const out = compareTradeExecution({
      direction: "buy",
      quotedBase: 1.0,
      quotedQuote: 3000,
      actualBase: 1.005, // got more
      actualQuote: 3000,
    });
    expect(out.slippageBps).toBeLessThan(0);
    expect(out.outputDelta).toBeGreaterThan(0);
    expect(out.finding.code).toBe("excellent");
    expect(out.finding.message).toMatch(/BETTER than quoted/);
  });
});

describe("compareTradeExecution — sell direction", () => {
  it("exact match → zero slippage", () => {
    const out = compareTradeExecution({
      direction: "sell",
      quotedBase: 1.0,
      quotedQuote: 3000,
      actualBase: 1.0,
      actualQuote: 3000,
    });
    expect(out.slippageBps).toBe(0);
    expect(out.finding.code).toBe("excellent");
  });

  it("got 1% less quote → 100 bps slippage", () => {
    const out = compareTradeExecution({
      direction: "sell",
      quotedBase: 1.0,
      quotedQuote: 3000,
      actualBase: 1.0,
      actualQuote: 2970, // 1% less
    });
    expect(out.slippageBps).toBeCloseTo(100, 1);
    expect(out.finding.code).toBe("minor_slip");
  });

  it("got 10% less quote → 1000 bps, extreme_slip", () => {
    const out = compareTradeExecution({
      direction: "sell",
      quotedBase: 1.0,
      quotedQuote: 3000,
      actualBase: 1.0,
      actualQuote: 2700, // 10% less — MEV/sandwich territory
    });
    expect(out.slippageBps).toBeCloseTo(1000, 1);
    expect(out.finding.code).toBe("extreme_slip");
  });
});

describe("compareTradeExecution — edge cases", () => {
  it("zero quoted → unknown verdict (avoid divide-by-zero)", () => {
    const out = compareTradeExecution({
      direction: "buy",
      quotedBase: 0,
      quotedQuote: 3000,
      actualBase: 1.0,
      actualQuote: 3000,
    });
    expect(out.finding.code).toBe("unknown");
  });

  it("NaN inputs → unknown verdict", () => {
    const out = compareTradeExecution({
      direction: "buy",
      quotedBase: NaN,
      quotedQuote: 3000,
      actualBase: 1.0,
      actualQuote: 3000,
    });
    expect(out.finding.code).toBe("unknown");
  });
});

describe("bigintToFloat", () => {
  it("infers 18-decimals scale from a 1.0 reference", () => {
    // delta = 1.0 in 18-decimal units = 10^18
    const result = bigintToFloat(10n ** 18n, 1.0, "in");
    expect(result).toBeCloseTo(1.0, 6);
  });

  it("infers 6-decimals scale (USDC) from a 100 reference", () => {
    // delta = 100 in 6-decimal units = 100 * 10^6 = 10^8
    const result = bigintToFloat(10n ** 8n, 100, "out");
    expect(result).toBeCloseTo(100, 4);
  });

  it("handles negative bigint delta (preserves sign)", () => {
    const result = bigintToFloat(-(10n ** 18n), 1.0, "out");
    expect(result).toBeCloseTo(-1.0, 6);
  });

  it("returns raw Number when reference is zero or negative", () => {
    expect(bigintToFloat(10n ** 18n, 0, "in")).toBe(Number(10n ** 18n));
    expect(bigintToFloat(10n ** 18n, -1, "in")).toBe(Number(10n ** 18n));
  });
});

// ── analyzeStoredTrade — failed-trade revert-reason extraction (iter666) ──

describe("analyzeStoredTrade failed trades (iter666 revert-reason capture)", () => {
  function failedRow(overrides: Partial<TradeRow> = {}): TradeRow {
    return {
      id: 1,
      timestamp: "2026-05-29T00:00:00Z",
      chain: "base",
      account: "alice",
      direction: "buy",
      base_token: "0xa1",
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: "0xa2",
      quote_symbol: "USDC",
      quote_amount: "3000",
      price: "3000",
      tx_hash: "0x" + "ab".repeat(32),
      status: "failed",
      gas_used: "21000",
      gas_price_wei: null,
      gas_cost_native: "0.001",
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      block_number: 12345678,
      ...overrides,
    };
  }
  const profile: ChainProfile = { name: "base" } as ChainProfile;
  const silentLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;

  // Helper: build a minimal mock publicClient that satisfies the call shape used
  // in analyzeStoredTrade. We don't need to be exhaustive — analyzeStoredTrade
  // only calls .getTransaction + .call on the failed-trade path.
  function mockClient(opts: {
    getTransaction?: () => Promise<{ from: `0x${string}`; to: `0x${string}`; input: `0x${string}`; value: bigint }>;
    call?: () => Promise<unknown>;
  }) {
    return {
      getTransaction:
        opts.getTransaction ??
        (async () => ({
          from: "0xfromfromfromfromfromfromfromfromfromfrom" as `0x${string}`,
          to: "0xtototototototototototototototototototo" as `0x${string}`,
          input: "0xdeadbeef" as `0x${string}`,
          value: 0n,
        })),
      call:
        opts.call ??
        (async () => {
          throw Object.assign(new Error("execution reverted"), { cause: { data: "0x" } });
        }),
    } as never;
  }

  // Build an Error(string)-encoded revert payload: selector 0x08c379a0 followed
  // by ABI-encoded (string) = offset(32) + length(32) + utf8 bytes (padded).
  // For "Too little received" (19 bytes): pack appropriately. Easier to use a
  // viem helper, but constructing manually avoids the dependency in tests.
  function encodeErrorString(s: string): `0x${string}` {
    const bytes = new TextEncoder().encode(s);
    const lenHex = bytes.length.toString(16).padStart(64, "0");
    const padded = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0");
    // Offset 0x20 (32) + length + data
    return ("0x08c379a0" + "0000000000000000000000000000000000000000000000000000000000000020" + lenHex + padded) as `0x${string}`;
  }

  it("extracts Error(string) revert reason via eth_call replay", async () => {
    const client = mockClient({
      call: async () => {
        throw Object.assign(new Error("execution reverted: Too little received"), {
          cause: { data: encodeErrorString("Too little received") },
        });
      },
    });
    const r = await analyzeStoredTrade({ row: failedRow(), publicClient: client, profile, logger: silentLogger });
    expect(r.finding.code).toBe("reverted");
    expect(r.revertReason).toBe("Too little received");
    expect(r.finding.message).toMatch(/Too little received/);
  });

  it("decodes Panic codes (e.g. division by zero)", async () => {
    // Panic selector 0x4e487b71 + uint256(0x12) = division by zero
    const panicData = ("0x4e487b71" + "12".padStart(64, "0")) as `0x${string}`;
    const client = mockClient({
      call: async () => {
        throw Object.assign(new Error("execution reverted: panic"), { cause: { data: panicData } });
      },
    });
    const r = await analyzeStoredTrade({ row: failedRow(), publicClient: client, profile, logger: silentLogger });
    expect(r.revertReason).toMatch(/Panic.*division\/modulo by zero/i);
    expect(r.finding.message).toMatch(/division\/modulo by zero/i);
  });

  it("returns no revertReason when block_number is missing (can't pin replay block)", async () => {
    const client = mockClient({
      // call should not even be invoked
      call: async () => {
        throw new Error("call should not have been called");
      },
    });
    const r = await analyzeStoredTrade({
      row: failedRow({ block_number: null }),
      publicClient: client,
      profile,
      logger: silentLogger,
    });
    expect(r.finding.code).toBe("reverted");
    expect(r.revertReason).toBeUndefined();
    expect(r.finding.message).toMatch(/no slippage to compute/i);
  });

  it("falls back to generic message when getTransaction fails (RPC error)", async () => {
    const client = mockClient({
      getTransaction: async () => {
        throw new Error("RPC: connection refused");
      },
    });
    const r = await analyzeStoredTrade({ row: failedRow(), publicClient: client, profile, logger: silentLogger });
    expect(r.finding.code).toBe("reverted");
    expect(r.revertReason).toBeUndefined();
    expect(r.finding.message).not.toMatch(/connection refused/);
  });

  it("falls back when replay throws but cause.data is empty", async () => {
    const client = mockClient({
      call: async () => {
        // RPC returns a revert with no usable revert data (rare but happens
        // on some L2s for certain failure modes).
        throw Object.assign(new Error("execution reverted"), { cause: { data: "0x" } });
      },
    });
    const r = await analyzeStoredTrade({ row: failedRow(), publicClient: client, profile, logger: silentLogger });
    expect(r.finding.code).toBe("reverted");
    expect(r.revertReason).toBeUndefined();
  });

  it("falls back when replay does NOT revert (state at blockNumber-1 wouldn't reproduce)", async () => {
    const client = mockClient({
      call: async () => "0x" as `0x${string}`,
    });
    const r = await analyzeStoredTrade({ row: failedRow(), publicClient: client, profile, logger: silentLogger });
    expect(r.finding.code).toBe("reverted");
    expect(r.revertReason).toBeUndefined();
  });

  it("preserves stored gas_cost_native in the analysis result", async () => {
    const client = mockClient({
      call: async () => {
        throw Object.assign(new Error("execution reverted: X"), {
          cause: { data: encodeErrorString("X") },
        });
      },
    });
    const r = await analyzeStoredTrade({
      row: failedRow({ gas_cost_native: "0.0042" }),
      publicClient: client,
      profile,
      logger: silentLogger,
    });
    expect(r.gasCostNative).toBe("0.0042");
  });
});
