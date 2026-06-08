// Iter616: unit tests for the pure enrichment math in tradeExport.ts.
// Verifies: cost basis tracking, realized PnL on sells, buys/transfers/failed
// rows handled correctly, gas_usd attribution, chronological sort defense,
// over-sell edge.

import { describe, it, expect } from "vitest";
import {
  enrichTradesForExport,
  quoteUsdAtTradeForExport,
  ENRICHED_COLUMNS,
} from "./tradeExport.js";
import type { TradeRow } from "./db.js";

function row(overrides: Partial<TradeRow> & Pick<TradeRow, "direction" | "base_amount" | "quote_amount">): TradeRow {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    chain: "base",
    account: "main",
    base_token: "0xbase",
    base_symbol: "WETH",
    quote_token: "0xquote",
    quote_symbol: "USDC",
    price: "0",
    tx_hash: "0x",
    status: "success",
    gas_used: null,
    gas_price_wei: null,
    gas_cost_native: null,
    aggregator: null,
    fee_tier: null,
    notes: null,
    ...overrides,
  };
}

const stableQuote = () => 1; // every row pays in USDC at $1
const noGas = new Map<string, number | null>();

describe("enrichTradesForExport (iter616)", () => {
  it("returns empty for no rows", () => {
    expect(enrichTradesForExport([], stableQuote, noGas)).toEqual([]);
  });

  it("buy row: cost_basis_usd = USD spent; proceeds_usd + realized null", () => {
    const rows = [row({ direction: "buy", base_amount: "10", quote_amount: "1000" })];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    expect(enriched).toHaveLength(1);
    expect(enriched[0].cost_basis_usd).toBe(1000);
    expect(enriched[0].proceeds_usd).toBeNull();
    expect(enriched[0].realized_pnl_usd).toBeNull();
  });

  it("buy-then-sell roundtrip: sell row carries realized + cost_basis + proceeds", () => {
    // Buy 10 @ $100 = $1000 → Sell 5 @ $150 = $750 → released cost = $500 (5 × avg cost $100),
    // realized = $750 - $500 = $250.
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "750", timestamp: "2026-02-01T00:00:00Z" }),
    ];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    expect(enriched[0].cost_basis_usd).toBe(1000); // buy
    expect(enriched[0].proceeds_usd).toBeNull();
    expect(enriched[0].realized_pnl_usd).toBeNull();
    expect(enriched[1].cost_basis_usd).toBe(500); // sell
    expect(enriched[1].proceeds_usd).toBe(750);
    expect(enriched[1].realized_pnl_usd).toBe(250);
  });

  it("partial sells decrement basis proportionally (weighted average preserved)", () => {
    // Buy 10 @ $100 ($1000), then sell 4 (releasing $400 basis), then sell 3
    // (releasing $300 from the remaining $600 / 6 left = $100/unit avg).
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "4", quote_amount: "600", timestamp: "2026-02-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "3", quote_amount: "450", timestamp: "2026-03-01T00:00:00Z" }),
    ];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    // First sell: cost = 4 × $100 = $400, proceeds = $600, realized = $200.
    expect(enriched[1].cost_basis_usd).toBe(400);
    expect(enriched[1].realized_pnl_usd).toBe(200);
    // Second sell: avg cost still $100 (weighted-average is preserved through
    // proportional decrement). cost = 3 × $100 = $300, proceeds = $450, realized $150.
    expect(enriched[2].cost_basis_usd).toBe(300);
    expect(enriched[2].realized_pnl_usd).toBe(150);
  });

  it("weighted-average shifts when subsequent buys happen at different prices", () => {
    // Buy 10 @ $100 ($1000), buy 10 @ $200 ($2000) → 20 units, total cost $3000,
    // avg $150. Sell 5: cost released = 5 × $150 = $750.
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "buy", base_amount: "10", quote_amount: "2000", timestamp: "2026-02-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "900", timestamp: "2026-03-01T00:00:00Z" }),
    ];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    expect(enriched[2].cost_basis_usd).toBe(750);
    expect(enriched[2].proceeds_usd).toBe(900);
    expect(enriched[2].realized_pnl_usd).toBe(150);
  });

  it("loss case: sell below avg cost produces negative realized", () => {
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "400", timestamp: "2026-02-01T00:00:00Z" }),
    ];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    // Cost released = 5 × $100 = $500. Proceeds = $400. Realized = -$100.
    expect(enriched[1].realized_pnl_usd).toBe(-100);
  });

  it("transfer row: all 3 PnL columns null even when status=success", () => {
    const rows = [
      row({
        direction: "sell",
        base_amount: "5",
        quote_amount: "500",
        aggregator: "transfer",
        status: "success",
      }),
    ];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    expect(enriched[0].cost_basis_usd).toBeNull();
    expect(enriched[0].proceeds_usd).toBeNull();
    expect(enriched[0].realized_pnl_usd).toBeNull();
  });

  it("failed row: all 3 PnL columns null (no realization on revert)", () => {
    const rows = [
      row({
        direction: "buy",
        base_amount: "10",
        quote_amount: "1000",
        status: "failed",
      }),
    ];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    expect(enriched[0].cost_basis_usd).toBeNull();
    expect(enriched[0].proceeds_usd).toBeNull();
    expect(enriched[0].realized_pnl_usd).toBeNull();
  });

  it("zero-amount rows: skipped (no PnL math)", () => {
    const rows = [row({ direction: "buy", base_amount: "0", quote_amount: "0" })];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    expect(enriched[0].cost_basis_usd).toBeNull();
  });

  it("unknown-quote (returns null): row passes through with null PnL columns", () => {
    const rows = [row({ direction: "buy", base_amount: "10", quote_amount: "1", quote_symbol: "VOLATILE" })];
    const enriched = enrichTradesForExport(rows, () => null, noGas);
    expect(enriched[0].cost_basis_usd).toBeNull();
  });

  it("gas_usd: computed from gas_cost_native × chain native USD", () => {
    const rows = [
      row({
        direction: "buy",
        base_amount: "10",
        quote_amount: "1000",
        gas_cost_native: "0.005",
        chain: "base",
      }),
    ];
    const gas = new Map<string, number | null>([["base", 3000]]); // ETH @ $3000
    const enriched = enrichTradesForExport(rows, stableQuote, gas);
    // 0.005 ETH × $3000 = $15
    expect(enriched[0].gas_usd).toBe(15);
  });

  it("gas_usd: null when chain native price is unknown", () => {
    const rows = [row({ direction: "buy", base_amount: "10", quote_amount: "1000", gas_cost_native: "0.005" })];
    const gas = new Map<string, number | null>([["base", null]]);
    const enriched = enrichTradesForExport(rows, stableQuote, gas);
    expect(enriched[0].gas_usd).toBeNull();
  });

  it("gas_usd: null when gas_cost_native is null (gas not recorded)", () => {
    const rows = [row({ direction: "buy", base_amount: "10", quote_amount: "1000" })];
    const gas = new Map<string, number | null>([["base", 3000]]);
    const enriched = enrichTradesForExport(rows, stableQuote, gas);
    expect(enriched[0].gas_usd).toBeNull();
  });

  it("gas_usd: counted even for FAILED rows (gas paid regardless of revert)", () => {
    const rows = [
      row({
        direction: "buy",
        base_amount: "10",
        quote_amount: "1000",
        status: "failed",
        gas_cost_native: "0.005",
      }),
    ];
    const gas = new Map<string, number | null>([["base", 3000]]);
    const enriched = enrichTradesForExport(rows, stableQuote, gas);
    expect(enriched[0].gas_usd).toBe(15);
    // But PnL columns still null (no realization on failed).
    expect(enriched[0].realized_pnl_usd).toBeNull();
  });

  it("input is sorted chronologically (out-of-order input still works)", () => {
    // Deliberately pass rows in REVERSE order. The enricher sorts internally
    // so cost basis is computed against the time-ordered history.
    const rows = [
      row({
        id: 2,
        direction: "sell",
        base_amount: "5",
        quote_amount: "750",
        timestamp: "2026-02-01T00:00:00Z",
      }),
      row({
        id: 1,
        direction: "buy",
        base_amount: "10",
        quote_amount: "1000",
        timestamp: "2026-01-01T00:00:00Z",
      }),
    ];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    // After sorting: buy first, sell second.
    expect(enriched[0].direction).toBe("buy");
    expect(enriched[1].direction).toBe("sell");
    expect(enriched[1].realized_pnl_usd).toBe(250);
  });

  it("over-sell (sells more than position): caps at the held amount", () => {
    // Buy 5, then sell 10 (5 more than held). The enricher should attribute
    // realized for the 5 actually held; the over-sold portion gets ignored
    // by the cap.
    const rows = [
      row({ direction: "buy", base_amount: "5", quote_amount: "500", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "10", quote_amount: "2000", timestamp: "2026-02-01T00:00:00Z" }),
    ];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    // sell_price_per_unit = 2000 / 10 = 200 (the SALE was at $200/unit).
    // sold = min(10, 5) = 5. avg cost = $100. cost released = 5 × $100 = $500.
    // proceeds = 5 × $200 = $1000. realized = $500.
    expect(enriched[1].cost_basis_usd).toBe(500);
    expect(enriched[1].proceeds_usd).toBe(1000);
    expect(enriched[1].realized_pnl_usd).toBe(500);
  });

  it("multi-token isolation: position state is per-token (not commingled)", () => {
    // ETH and PEPE positions are tracked independently. A PEPE sell doesn't
    // touch ETH cost basis.
    const rows = [
      row({
        direction: "buy",
        base_amount: "10",
        quote_amount: "1000",
        base_symbol: "ETH",
        base_token: "0xeth",
        timestamp: "2026-01-01T00:00:00Z",
      }),
      row({
        direction: "buy",
        base_amount: "100",
        quote_amount: "500",
        base_symbol: "PEPE",
        base_token: "0xpepe",
        timestamp: "2026-01-02T00:00:00Z",
      }),
      row({
        direction: "sell",
        base_amount: "50",
        quote_amount: "300",
        base_symbol: "PEPE",
        base_token: "0xpepe",
        timestamp: "2026-02-01T00:00:00Z",
      }),
    ];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    // PEPE: avg cost $5/unit, sell 50 at $6/unit → cost basis released $250, proceeds $300, realized $50.
    expect(enriched[2].cost_basis_usd).toBe(250);
    expect(enriched[2].realized_pnl_usd).toBe(50);
  });

  it("multi-chain isolation: per-chain position keys", () => {
    // Same token symbol on different chains is tracked separately.
    const rows = [
      row({
        direction: "buy",
        base_amount: "10",
        quote_amount: "1000",
        chain: "base",
        timestamp: "2026-01-01T00:00:00Z",
      }),
      row({
        direction: "sell",
        base_amount: "5",
        quote_amount: "750",
        chain: "arbitrum", // different chain — no position there to sell from
        timestamp: "2026-02-01T00:00:00Z",
      }),
    ];
    const enriched = enrichTradesForExport(rows, stableQuote, noGas);
    // Arbitrum WETH position is empty, so sold = min(5, 0) = 0 → cost released = 0,
    // proceeds = 0 × $150 = 0, realized = 0.
    expect(enriched[1].cost_basis_usd).toBe(0);
    expect(enriched[1].proceeds_usd).toBe(0);
    expect(enriched[1].realized_pnl_usd).toBe(0);
  });
});

describe("quoteUsdAtTradeForExport (iter616)", () => {
  it("$1 for stablecoin quote tokens", () => {
    expect(quoteUsdAtTradeForExport(row({ direction: "buy", base_amount: "1", quote_amount: "1", quote_symbol: "USDC" }))).toBe(1);
    expect(quoteUsdAtTradeForExport(row({ direction: "buy", base_amount: "1", quote_amount: "1", quote_symbol: "DAI" }))).toBe(1);
    expect(quoteUsdAtTradeForExport(row({ direction: "buy", base_amount: "1", quote_amount: "1", quote_symbol: "USDT" }))).toBe(1);
  });

  it("null for volatile quote tokens (caller must inject price)", () => {
    expect(quoteUsdAtTradeForExport(row({ direction: "buy", base_amount: "1", quote_amount: "1", quote_symbol: "WETH" }))).toBeNull();
    expect(quoteUsdAtTradeForExport(row({ direction: "buy", base_amount: "1", quote_amount: "1", quote_symbol: "PEPE" }))).toBeNull();
  });

  it("null for missing quote symbol", () => {
    expect(quoteUsdAtTradeForExport(row({ direction: "buy", base_amount: "1", quote_amount: "1", quote_symbol: null }))).toBeNull();
  });
});

describe("ENRICHED_COLUMNS schema (iter616)", () => {
  it("contains the original TRADE_COLUMNS PLUS the 4 new tax columns at the end", () => {
    // Last 4 must be the new ones in the canonical order downstream tools expect.
    expect(ENRICHED_COLUMNS.slice(-4)).toEqual([
      "cost_basis_usd",
      "proceeds_usd",
      "realized_pnl_usd",
      "gas_usd",
    ]);
  });

  it("contains all 20 base columns", () => {
    // 16 original + 4 new = 20 total.
    expect(ENRICHED_COLUMNS).toHaveLength(24);
    // Sanity: id is first, notes is last before the new columns.
    expect(ENRICHED_COLUMNS[0]).toBe("id");
    expect(ENRICHED_COLUMNS.indexOf("notes")).toBe(ENRICHED_COLUMNS.length - 5); // notes is just before the 4 new ones
  });
});
