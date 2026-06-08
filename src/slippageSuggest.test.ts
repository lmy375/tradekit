// Iter642: tests for the pure helpers in slippageSuggest.ts.

import { describe, expect, it } from "vitest";
import {
  suggestSlippageBps,
  extractPairSamples,
  SUGGEST_MIN_SAMPLES,
  SUGGEST_DEFAULT_BUFFER_PCT,
} from "./slippageSuggest.js";
import type { TradeRow } from "./db.js";

describe("suggestSlippageBps", () => {
  it("returns default + no_history when sample set is empty", () => {
    const s = suggestSlippageBps({ samples: [], defaultBps: 50, maxBps: 500 });
    expect(s.suggestedBps).toBe(50);
    expect(s.reason).toBe("no_history");
    expect(s.sampleCount).toBe(0);
    expect(s.p95Bps).toBeNull();
  });

  it("returns default + insufficient_history below MIN_SAMPLES", () => {
    const s = suggestSlippageBps({
      samples: Array.from({ length: SUGGEST_MIN_SAMPLES - 1 }, () => 30),
      defaultBps: 50,
      maxBps: 500,
    });
    expect(s.suggestedBps).toBe(50);
    expect(s.reason).toBe("insufficient_history");
  });

  it("computes p95 + buffer from sufficient samples (happy path)", () => {
    // p95 of 0..99 is ~94.05; +25% buffer = ~117.5 → rounds to 118
    const samples = Array.from({ length: 100 }, (_, i) => i);
    const s = suggestSlippageBps({ samples, defaultBps: 50, maxBps: 500 });
    expect(s.reason).toBe("from_history");
    expect(s.p95Bps).toBeCloseTo(94.05, 1);
    expect(s.suggestedBps).toBe(Math.round(94.05 * 1.25));
    // Median uses index-based selection (sorted[floor(len/2)]) — for [0..99]
    // that's sorted[50] = 50. Not mathematically the interpolated median
    // (49.5), but consistent with iter623's percentile helper.
    expect(s.medianBps).toBe(50);
  });

  it("floors at defaultBps when p95+buffer is lower", () => {
    // All samples = 10 bps. p95=10, +25%=12.5. Default 50 → use default.
    const s = suggestSlippageBps({
      samples: Array.from({ length: 10 }, () => 10),
      defaultBps: 50,
      maxBps: 500,
    });
    expect(s.suggestedBps).toBe(50);
    expect(s.reason).toBe("from_history_floored");
    expect(s.flooredAtDefault).toBe(true);
  });

  it("caps at maxBps when p95+buffer is higher", () => {
    // All samples = 1000 bps. p95=1000, +25%=1250. Max 500 → cap.
    const s = suggestSlippageBps({
      samples: Array.from({ length: 10 }, () => 1000),
      defaultBps: 50,
      maxBps: 500,
    });
    expect(s.suggestedBps).toBe(500);
    expect(s.reason).toBe("from_history_capped");
    expect(s.cappedAtMax).toBe(true);
  });

  it("filters non-finite samples before computing", () => {
    const samples = [10, 20, NaN, 30, Infinity, 40, 50];
    const s = suggestSlippageBps({ samples, defaultBps: 5, maxBps: 500 });
    expect(s.sampleCount).toBe(5); // NaN + Infinity filtered out
  });

  it("custom bufferPct overrides default", () => {
    // All samples=100. p95=100. With buffer=0 → 100. Default 50 → not floored.
    const samples = Array.from({ length: 10 }, () => 100);
    const s = suggestSlippageBps({
      samples,
      defaultBps: 50,
      maxBps: 500,
      bufferPct: 0,
    });
    expect(s.suggestedBps).toBe(100);
  });

  it("custom minSamples allows smaller sets", () => {
    const s = suggestSlippageBps({
      samples: [10, 20, 30],
      defaultBps: 5,
      maxBps: 500,
      minSamples: 3,
    });
    expect(s.reason).toBe("from_history");
    expect(s.sampleCount).toBe(3);
  });

  it("SUGGEST_DEFAULT_BUFFER_PCT is 25", () => {
    expect(SUGGEST_DEFAULT_BUFFER_PCT).toBe(25);
  });

  it("SUGGEST_MIN_SAMPLES is 5", () => {
    expect(SUGGEST_MIN_SAMPLES).toBe(5);
  });
});

describe("extractPairSamples", () => {
  function row(o: Partial<TradeRow> = {}): TradeRow {
    return {
      id: 1,
      timestamp: "2026-05-29T00:00:00Z",
      chain: "base",
      account: "alice",
      direction: "buy",
      base_token: "0xeee",
      base_symbol: "ETH",
      base_amount: "1.0",
      quote_token: "0xusdc",
      quote_symbol: "USDC",
      quote_amount: "3000",
      price: "3000",
      tx_hash: "0xabc",
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      ...o,
    };
  }

  it("returns empty when neither pairSymbol nor pairAddress is supplied", () => {
    expect(extractPairSamples({ rows: [row({ realized_slippage_bps: 10 })] })).toEqual([]);
  });

  it("matches by symbol (canonical lexicographic)", () => {
    const samples = extractPairSamples({
      rows: [
        row({ tx_hash: "0x1", base_symbol: "ETH", quote_symbol: "USDC", realized_slippage_bps: 30 }),
        row({ tx_hash: "0x2", base_symbol: "USDC", quote_symbol: "ETH", realized_slippage_bps: 40 }), // reverse
        row({ tx_hash: "0x3", base_symbol: "PEPE", quote_symbol: "USDC", realized_slippage_bps: 99 }), // diff
      ],
      pairSymbol: "ETH/USDC",
    });
    expect(samples.sort()).toEqual([30, 40]);
  });

  it("matches by address when symbols don't match", () => {
    const samples = extractPairSamples({
      rows: [
        row({
          tx_hash: "0x1",
          base_token: "0xAAAA",
          quote_token: "0xBBBB",
          base_symbol: null, // no symbol
          quote_symbol: null,
          realized_slippage_bps: 25,
        }),
      ],
      pairAddress: "0xaaaa/0xbbbb",
    });
    expect(samples).toEqual([25]);
  });

  it("skips rows without stored realized_slippage_bps", () => {
    expect(
      extractPairSamples({
        rows: [row({ tx_hash: "0x1" })], // null slippage
        pairSymbol: "ETH/USDC",
      }),
    ).toEqual([]);
  });

  it("skips failed/pending status rows", () => {
    expect(
      extractPairSamples({
        rows: [
          row({ tx_hash: "0x1", status: "failed", realized_slippage_bps: 30 }),
          row({ tx_hash: "0x2", status: "pending", realized_slippage_bps: 40 }),
        ],
        pairSymbol: "ETH/USDC",
      }),
    ).toEqual([]);
  });

  it("skips transfer rows (not swaps)", () => {
    expect(
      extractPairSamples({
        rows: [row({ aggregator: "transfer", realized_slippage_bps: 30 })],
        pairSymbol: "ETH/USDC",
      }),
    ).toEqual([]);
  });

  it("symbol match takes precedence over address when both present", () => {
    // Same row, both keys hit. Should only count once (uses `continue`).
    const samples = extractPairSamples({
      rows: [
        row({
          tx_hash: "0x1",
          base_symbol: "ETH",
          quote_symbol: "USDC",
          base_token: "0xeth",
          quote_token: "0xusdc",
          realized_slippage_bps: 30,
        }),
      ],
      pairSymbol: "ETH/USDC",
      pairAddress: "0xeth/0xusdc",
    });
    expect(samples).toEqual([30]);
  });
});
