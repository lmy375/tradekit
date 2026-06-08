// Tests for the pure cost-basis aggregator extracted from computePnL. Verifies the
// weighted-average-cost math, the realize-against-avg-cost on sells, and per-chain
// gas accumulation. computePnL itself just adds I/O (db + price fetches) on top of
// this function.

import { describe, it, expect } from "vitest";
import { aggregateTrades, formatPnLReport, isInWindow, rollupPositionsBySymbol, sumPnLReports, computeStaleBookmarkEntries, PNL_STALE_BOOKMARK_HOURS, type PnLReport, type PnLWindow, type TokenPosition } from "./pnl.js";
import type { TradeRow } from "./db.js";

function row(overrides: Partial<TradeRow> & Pick<TradeRow, "direction" | "base_amount" | "quote_amount">): TradeRow {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    chain: "base",
    account: "main",
    base_token: "0xbase",
    base_symbol: "PEPE",
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

// All test rows quote in USDC (stable) so quoteUsd = 1 for every trade.
const stableQuote = () => 1;

describe("aggregateTrades", () => {
  it("returns empty maps for no rows", () => {
    const { positions, gasSpend } = aggregateTrades([], stableQuote);
    expect(positions.size).toBe(0);
    expect(gasSpend.size).toBe(0);
  });

  it("a single buy creates a position with cost = quote amount, zero realized", () => {
    const { positions } = aggregateTrades(
      [row({ direction: "buy", base_amount: "100", quote_amount: "50" })],
      stableQuote,
    );
    const acc = [...positions.values()][0];
    expect(acc.amount).toBe(100);
    expect(acc.cost).toBe(50);
    expect(acc.realized).toBe(0);
    expect(acc.trades).toBe(1);
  });

  it("two buys average their cost basis", () => {
    // Buy 100 @ $0.50 then 100 @ $1.00 → avg = $0.75
    const { positions } = aggregateTrades(
      [
        row({ direction: "buy", base_amount: "100", quote_amount: "50" }),
        row({ direction: "buy", base_amount: "100", quote_amount: "100" }),
      ],
      stableQuote,
    );
    const acc = [...positions.values()][0];
    expect(acc.amount).toBe(200);
    expect(acc.cost).toBe(150);
    expect(acc.cost / acc.amount).toBeCloseTo(0.75, 8);
  });

  it("a sell realizes PnL against current average cost", () => {
    // Buy 100 @ $0.50 (avg=$0.50). Sell 50 @ $1.00. Realized = 50 * (1.00 - 0.50) = $25.
    const { positions } = aggregateTrades(
      [
        row({ direction: "buy", base_amount: "100", quote_amount: "50" }),
        row({ direction: "sell", base_amount: "50", quote_amount: "50" }),
      ],
      stableQuote,
    );
    const acc = [...positions.values()][0];
    expect(acc.realized).toBeCloseTo(25, 8);
    expect(acc.amount).toBe(50);
    expect(acc.cost).toBeCloseTo(25, 8); // remaining cost = avg * remaining = 0.50 * 50
  });

  it("selling at a loss produces negative realized PnL", () => {
    // Buy 100 @ $1.00 then sell all at $0.40 → realized = 100 * (0.40 - 1.00) = -$60
    const { positions } = aggregateTrades(
      [
        row({ direction: "buy", base_amount: "100", quote_amount: "100" }),
        row({ direction: "sell", base_amount: "100", quote_amount: "40" }),
      ],
      stableQuote,
    );
    const acc = [...positions.values()][0];
    expect(acc.realized).toBeCloseTo(-60, 8);
    expect(acc.amount).toBe(0);
  });

  it("sell with no prior position caps the sold amount and produces zero realized", () => {
    // Selling without a buy: sold = min(50, 0) = 0; realized stays 0.
    const { positions } = aggregateTrades(
      [row({ direction: "sell", base_amount: "50", quote_amount: "50" })],
      stableQuote,
    );
    const acc = [...positions.values()][0];
    expect(acc.realized).toBe(0);
    expect(acc.amount).toBe(0);
  });

  it("skips failed trades", () => {
    const { positions } = aggregateTrades(
      [
        row({ direction: "buy", base_amount: "100", quote_amount: "50", status: "failed" }),
        row({ direction: "buy", base_amount: "100", quote_amount: "50" }),
      ],
      stableQuote,
    );
    const acc = [...positions.values()][0];
    expect(acc.trades).toBe(1);
    expect(acc.amount).toBe(100);
  });

  it("skips trades where quoteUsd is null (no price available)", () => {
    const { positions } = aggregateTrades(
      [row({ direction: "buy", base_amount: "100", quote_amount: "50", quote_symbol: "WBTC" })],
      () => null,
    );
    expect(positions.size).toBe(0);
  });

  it("separates positions by chain", () => {
    const { positions } = aggregateTrades(
      [
        row({ chain: "base", direction: "buy", base_amount: "100", quote_amount: "50" }),
        row({ chain: "arbitrum", direction: "buy", base_amount: "100", quote_amount: "50" }),
      ],
      stableQuote,
    );
    expect(positions.size).toBe(2);
  });

  it("separates positions by base symbol (case-insensitive)", () => {
    const { positions } = aggregateTrades(
      [
        row({ direction: "buy", base_amount: "100", quote_amount: "50", base_symbol: "PEPE" }),
        row({ direction: "buy", base_amount: "100", quote_amount: "50", base_symbol: "WIF" }),
      ],
      stableQuote,
    );
    expect(positions.size).toBe(2);
  });

  it("accumulates gas per chain across trades", () => {
    const { gasSpend } = aggregateTrades(
      [
        row({ chain: "base", direction: "buy", base_amount: "100", quote_amount: "50", gas_cost_native: "0.0005" }),
        row({ chain: "base", direction: "sell", base_amount: "50", quote_amount: "30", gas_cost_native: "0.0003" }),
        row({ chain: "arbitrum", direction: "buy", base_amount: "1", quote_amount: "1", gas_cost_native: "0.0001" }),
      ],
      stableQuote,
    );
    expect(gasSpend.get("base")).toBeCloseTo(0.0008, 8);
    expect(gasSpend.get("arbitrum")).toBeCloseTo(0.0001, 8);
  });

  it("counts gas on FAILED trades (regression iter126 — gas is paid on revert too)", () => {
    // Pre-iter126 the status check came before gas accounting: a reverted swap paid
    // real ETH on chain but the PnL report acted as if gas spend was zero.
    const { gasSpend, positions } = aggregateTrades(
      [
        row({ chain: "base", direction: "buy", base_amount: "1", quote_amount: "1", gas_cost_native: "0.01", status: "failed" }),
        row({ chain: "base", direction: "buy", base_amount: "1", quote_amount: "1", gas_cost_native: "0.005", status: "success" }),
      ],
      stableQuote,
    );
    expect(gasSpend.get("base")).toBeCloseTo(0.015, 8);
    // Failed trade doesn't pollute cost basis — only the success contributes 1 unit at $1.
    expect(positions.size).toBe(1);
    expect([...positions.values()][0].amount).toBe(1);
  });

  it("iter706: position Acc tracks lastTradeAt as MAX(timestamp) across contributing rows", () => {
    const { positions } = aggregateTrades(
      [
        row({ chain: "base", direction: "buy", base_amount: "1", quote_amount: "1", timestamp: "2026-05-01T00:00:00Z" }),
        row({ chain: "base", direction: "buy", base_amount: "1", quote_amount: "1", timestamp: "2026-05-15T12:00:00Z" }), // latest
        row({ chain: "base", direction: "buy", base_amount: "1", quote_amount: "1", timestamp: "2026-05-10T00:00:00Z" }),
      ],
      stableQuote,
    );
    const pos = [...positions.values()][0];
    expect(pos.lastTradeAt).toBe("2026-05-15T12:00:00Z");
    expect(pos.trades).toBe(3);
  });

  it("counts gas on TRANSFER rows (regression iter126 — transfers cost gas too)", () => {
    const { gasSpend, positions } = aggregateTrades(
      [
        row({ chain: "base", direction: "sell", base_amount: "100", quote_amount: "100", gas_cost_native: "0.002", aggregator: "transfer" }),
      ],
      stableQuote,
    );
    expect(gasSpend.get("base")).toBeCloseTo(0.002, 8);
    // Transfer does NOT enter positions (cost basis).
    expect(positions.size).toBe(0);
  });

  it("counts gas on PENDING trades — they've been broadcast and paid for", () => {
    const { gasSpend } = aggregateTrades(
      [
        row({ chain: "base", direction: "buy", base_amount: "1", quote_amount: "1", gas_cost_native: "0.001", status: "pending" }),
      ],
      stableQuote,
    );
    expect(gasSpend.get("base")).toBeCloseTo(0.001, 8);
  });

  it("ignores non-numeric gas_cost_native", () => {
    const { gasSpend } = aggregateTrades(
      [row({ direction: "buy", base_amount: "1", quote_amount: "1", gas_cost_native: "not-a-number" })],
      stableQuote,
    );
    expect(gasSpend.size).toBe(0);
  });

  it("uses the dynamic quoteUsd callback per trade", () => {
    // Same row but ETH-quoted; quoteUsd resolves to 2000 (ETH price). Buy 1 PEPE for 0.5 ETH → cost $1000.
    const rows: TradeRow[] = [
      row({ direction: "buy", base_amount: "1", quote_amount: "0.5", quote_symbol: "WETH", quote_token: "0xweth" }),
    ];
    const { positions } = aggregateTrades(rows, (r) => (r.quote_symbol === "WETH" ? 2000 : null));
    const acc = [...positions.values()][0];
    expect(acc.cost).toBe(1000);
  });
});

describe("formatPnLReport (iter124 — surface unpriced positions / gas)", () => {
  function report(overrides: Partial<PnLReport> = {}): PnLReport {
    return {
      account: "main",
      chain: undefined,
      timestamp: "2026-01-01T00:00:00Z",
      positions: [],
      gas: [],
      totalRealizedUsd: 0,
      totalUnrealizedUsd: 0,
      totalGasUsd: 0,
      totalRealizedAfterGasUsd: 0,
      severity: "ok",
      recommendedActions: [],
      ...overrides,
    };
  }

  it("appends '(+N unpriced)' to the unrealized line when positions have no price", () => {
    // Regression: pre-iter124 a long-tail position with no price was silently
    // excluded from totalUnrealizedUsd — the operator saw a clean number with no
    // signal that mark-to-market was missing N positions.
    const out = formatPnLReport(
      report({
        positions: [
          {
            chain: "base",
            symbol: "WEIRDO",
            token: "0xa",
            amount: "1000",
            avgCostUsd: 0.1,
            realizedUsd: 0,
            currentPriceUsd: undefined,
            unrealizedUsd: undefined,
            trades: 1,
          },
        ],
        totalUnrealizedUsd: 0,
      }),
    );
    expect(out).toContain("Unrealized (mark-to-mkt): $0.00  (+1 unpriced)");
  });

  it("does not append the note when every position is priced", () => {
    const out = formatPnLReport(
      report({
        positions: [
          {
            chain: "base",
            symbol: "WETH",
            token: "0xb",
            amount: "1",
            avgCostUsd: 2000,
            realizedUsd: 0,
            currentPriceUsd: 3000,
            unrealizedUsd: 1000,
            trades: 1,
          },
        ],
        totalUnrealizedUsd: 1000,
      }),
    );
    expect(out).not.toContain("unpriced");
  });

  it("appends '(+N chains unpriced)' to gas lines when a chain's native price is unknown", () => {
    const out = formatPnLReport(
      report({
        gas: [
          { chain: "base", amount: "0.01", usd: 30 },
          { chain: "obscure", amount: "0.5", usd: undefined },
        ],
        totalGasUsd: 30,
      }),
    );
    expect(out).toContain("Gas paid (USD):         $30.00  (+1 chain unpriced)");
    // Per-chain block also calls it out.
    expect(out).toContain("obscure    0.5  (unpriced)");
  });

  it("does not flag zero-amount entries as unpriced (no funds → no inconsistency)", () => {
    const out = formatPnLReport(
      report({
        positions: [
          {
            chain: "base",
            symbol: "X",
            token: "0xc",
            amount: "0",
            avgCostUsd: 0,
            realizedUsd: 0,
            currentPriceUsd: undefined,
            unrealizedUsd: undefined,
            trades: 2, // closed-out position
          },
        ],
        gas: [{ chain: "base", amount: "0", usd: undefined }],
      }),
    );
    expect(out).not.toContain("unpriced");
  });

  it("pluralizes 'chain' / 'chains' correctly", () => {
    const out = formatPnLReport(
      report({
        gas: [
          { chain: "a", amount: "0.1", usd: undefined },
          { chain: "b", amount: "0.1", usd: undefined },
        ],
      }),
    );
    expect(out).toContain("(+2 chains unpriced)");
  });

  it("renders the iter741 stale-sync warning under the header when bookmarks are stale", () => {
    const out = formatPnLReport(
      report({
        dataFreshness: {
          staleAfterHours: 48,
          staleBookmarks: [
            { chain: "base", account: "main", owner: "0xabc", ageHours: 72, lastSyncedBlock: "32500000" },
          ],
        },
      }),
    );
    expect(out).toContain("⚠ Sync stale");
    expect(out).toContain("base/main");
    // 72h = 3.0d, formatter prefers days when >=24h
    expect(out).toMatch(/3\.0d/);
    expect(out).toContain("tradekit trades sync");
  });

  it("does not render any stale warning when dataFreshness is absent (fresh or no bookmarks)", () => {
    const out = formatPnLReport(report({}));
    expect(out).not.toContain("Sync stale");
  });

  it("iter745: renders onboarding hint when tradeCount is 0", () => {
    const out = formatPnLReport(report({ tradeCount: 0 }));
    expect(out).toContain("No trades in local DB");
    expect(out).toContain("tradekit trades sync --account main");
  });

  it("iter745: includes --chain suffix in the hint when chain is set", () => {
    const out = formatPnLReport(report({ tradeCount: 0, chain: "base" }));
    expect(out).toMatch(/tradekit trades sync --account main --chain base/);
  });

  it("iter745: omits the onboarding hint when tradeCount > 0", () => {
    const out = formatPnLReport(report({ tradeCount: 12 }));
    expect(out).not.toContain("No trades in local DB");
  });

  it("iter745: omits the hint when tradeCount is undefined (legacy / synthetic reports)", () => {
    // Health.ts adapter builds synthetic PnLReport-shaped objects without
    // tradeCount; those must not show the onboarding hint inappropriately.
    const out = formatPnLReport(report({}));
    expect(out).not.toContain("No trades in local DB");
  });

  it("iter765/iter768: renders activity footer with span when first + latest present", () => {
    const out = formatPnLReport(
      report({ tradeCount: 12, firstTradeAt: "2025-08-12T15:30:00Z", latestTradeAt: "2026-05-29T10:00:00Z" }),
    );
    expect(out).toMatch(/Active: 12 trades from 2025-08-12 to 2026-05-29/);
  });

  it("iter768: collapses to 'on YYYY-MM-DD' when first === latest (single-day history)", () => {
    const out = formatPnLReport(
      report({ tradeCount: 3, firstTradeAt: "2026-05-29T08:00:00Z", latestTradeAt: "2026-05-29T18:00:00Z" }),
    );
    expect(out).toMatch(/Active: 3 trades on 2026-05-29/);
    expect(out).not.toMatch(/from 2026-05-29 to 2026-05-29/);
  });

  it("iter768: falls back to 'on' when latestTradeAt missing (synthetic / legacy report)", () => {
    const out = formatPnLReport(
      report({ tradeCount: 5, firstTradeAt: "2025-08-12T15:30:00Z" }),
    );
    expect(out).toMatch(/Active: 5 trades on 2025-08-12/);
  });

  it("iter765: pluralizes 'trade' / 'trades' correctly", () => {
    const out = formatPnLReport(
      report({ tradeCount: 1, firstTradeAt: "2025-08-12T15:30:00Z", latestTradeAt: "2025-08-12T15:30:00Z" }),
    );
    expect(out).toMatch(/Active: 1 trade on 2025-08-12/);
    expect(out).not.toMatch(/1 trades/);
  });

  it("iter765: omits the footer when tradeCount is 0 (onboarding hint handles that case)", () => {
    const out = formatPnLReport(report({ tradeCount: 0 }));
    expect(out).not.toContain("Active:");
  });

  it("iter765: omits the footer when firstTradeAt is undefined (synthetic / legacy reports)", () => {
    const out = formatPnLReport(report({ tradeCount: 5 }));
    expect(out).not.toContain("Active:");
  });

  it("renders sub-day ages as Nh (e.g. 60h stays as 2.5d boundary check)", () => {
    const out = formatPnLReport(
      report({
        dataFreshness: {
          staleAfterHours: 48,
          staleBookmarks: [
            { chain: "base", account: "main", owner: "0xabc", ageHours: 49.5, lastSyncedBlock: "32500000" },
          ],
        },
      }),
    );
    // 49.5h ≥ 24 → formatted as days = 2.1d
    expect(out).toMatch(/2\.1d/);
  });
});

// ── iter615: time-windowed PnL ──────────────────────────────

describe("isInWindow (iter615)", () => {
  it("returns true when no window bounds set", () => {
    expect(isInWindow("2026-01-15T00:00:00Z", {})).toBe(true);
  });

  it("respects since lower bound (inclusive)", () => {
    const w: PnLWindow = { since: "2026-01-10T00:00:00Z" };
    expect(isInWindow("2026-01-10T00:00:00Z", w)).toBe(true); // boundary
    expect(isInWindow("2026-01-15T00:00:00Z", w)).toBe(true);
    expect(isInWindow("2026-01-09T23:59:59Z", w)).toBe(false);
  });

  it("respects until upper bound (exclusive)", () => {
    const w: PnLWindow = { until: "2026-01-20T00:00:00Z" };
    expect(isInWindow("2026-01-19T23:59:59Z", w)).toBe(true);
    expect(isInWindow("2026-01-20T00:00:00Z", w)).toBe(false); // boundary (exclusive)
    expect(isInWindow("2026-01-21T00:00:00Z", w)).toBe(false);
  });

  it("respects both bounds (half-open interval)", () => {
    const w: PnLWindow = { since: "2026-01-10T00:00:00Z", until: "2026-01-20T00:00:00Z" };
    expect(isInWindow("2026-01-09T23:59:59Z", w)).toBe(false);
    expect(isInWindow("2026-01-10T00:00:00Z", w)).toBe(true); // since inclusive
    expect(isInWindow("2026-01-15T00:00:00Z", w)).toBe(true);
    expect(isInWindow("2026-01-19T23:59:59Z", w)).toBe(true);
    expect(isInWindow("2026-01-20T00:00:00Z", w)).toBe(false); // until exclusive
  });
});

describe("aggregateTrades with windows (iter615)", () => {
  it("no windows passed → behavior matches pre-iter615 (backward compat)", () => {
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "750", timestamp: "2026-02-01T00:00:00Z" }),
    ];
    const result = aggregateTrades(rows, stableQuote);
    expect(result.gasSpendPerWindow).toBeUndefined();
    const acc = [...result.positions.values()][0];
    expect(acc.realizedPerWindow).toBeUndefined();
  });

  it("single window: attributes realized to the sale's window (path-correct)", () => {
    // Buy 10 @ $100 ($1000 cost) in Jan → Sell 5 @ $150 ($750 = realizes $250) in Feb.
    // The Feb-only window should attribute the FULL $250 realized (cost basis from Jan).
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "750", timestamp: "2026-02-15T00:00:00Z" }),
    ];
    const febWindow: PnLWindow = { since: "2026-02-01T00:00:00Z", until: "2026-03-01T00:00:00Z", label: "Feb" };
    const result = aggregateTrades(rows, stableQuote, [febWindow]);
    const acc = [...result.positions.values()][0];
    expect(acc.realized).toBe(250); // unchanged: all-time
    expect(acc.realizedPerWindow).toEqual([250]); // Feb gets the full gain
  });

  it("sale OUTSIDE the window contributes ZERO to that window's realized", () => {
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "750", timestamp: "2026-02-15T00:00:00Z" }),
    ];
    const janWindow: PnLWindow = { since: "2026-01-01T00:00:00Z", until: "2026-02-01T00:00:00Z", label: "Jan" };
    const result = aggregateTrades(rows, stableQuote, [janWindow]);
    const acc = [...result.positions.values()][0];
    expect(acc.realized).toBe(250); // all-time still records the gain
    expect(acc.realizedPerWindow).toEqual([0]); // Jan window saw no sales
  });

  it("multiple windows: each gets its own attribution slot", () => {
    // 3 sales across 3 months, each window covers one month.
    const rows = [
      row({ direction: "buy", base_amount: "30", quote_amount: "3000", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "10", quote_amount: "1500", timestamp: "2026-01-15T00:00:00Z" }),
      row({ direction: "sell", base_amount: "10", quote_amount: "2000", timestamp: "2026-02-15T00:00:00Z" }),
      row({ direction: "sell", base_amount: "10", quote_amount: "1100", timestamp: "2026-03-15T00:00:00Z" }),
    ];
    const windows: PnLWindow[] = [
      { since: "2026-01-01T00:00:00Z", until: "2026-02-01T00:00:00Z", label: "Jan" },
      { since: "2026-02-01T00:00:00Z", until: "2026-03-01T00:00:00Z", label: "Feb" },
      { since: "2026-03-01T00:00:00Z", until: "2026-04-01T00:00:00Z", label: "Mar" },
    ];
    const result = aggregateTrades(rows, stableQuote, windows);
    const acc = [...result.positions.values()][0];
    // Cost basis $100/unit throughout. Sales: 1500 (gain 500), 2000 (gain 1000), 1100 (gain 100).
    expect(acc.realizedPerWindow).toEqual([500, 1000, 100]);
    // All-time matches the sum.
    expect(acc.realized).toBe(1600);
  });

  it("overlapping windows: a sale lands in BOTH overlapping windows", () => {
    // The function doesn't enforce non-overlap — a sale in the overlap gets
    // counted in both windows. This is the correct semantic for use cases like
    // "show me last 30 days AND last 7 days side-by-side".
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "750", timestamp: "2026-02-15T00:00:00Z" }),
    ];
    const wide: PnLWindow = { since: "2026-01-01T00:00:00Z", until: "2026-12-31T00:00:00Z", label: "year" };
    const narrow: PnLWindow = { since: "2026-02-01T00:00:00Z", until: "2026-03-01T00:00:00Z", label: "Feb" };
    const result = aggregateTrades(rows, stableQuote, [wide, narrow]);
    const acc = [...result.positions.values()][0];
    expect(acc.realizedPerWindow).toEqual([250, 250]); // both windows attribute
  });

  it("gas accounting is windowed too", () => {
    const rows = [
      row({
        direction: "buy",
        base_amount: "10",
        quote_amount: "1000",
        timestamp: "2026-01-15T00:00:00Z",
        gas_cost_native: "0.01",
      }),
      row({
        direction: "buy",
        base_amount: "10",
        quote_amount: "1000",
        timestamp: "2026-02-15T00:00:00Z",
        gas_cost_native: "0.02",
      }),
    ];
    const windows: PnLWindow[] = [
      { since: "2026-01-01T00:00:00Z", until: "2026-02-01T00:00:00Z", label: "Jan" },
      { since: "2026-02-01T00:00:00Z", until: "2026-03-01T00:00:00Z", label: "Feb" },
    ];
    const result = aggregateTrades(rows, stableQuote, windows);
    expect(result.gasSpendPerWindow).toBeDefined();
    expect(result.gasSpendPerWindow![0].get("base")).toBeCloseTo(0.01);
    expect(result.gasSpendPerWindow![1].get("base")).toBeCloseTo(0.02);
    // All-time gas still aggregates both.
    expect(result.gasSpend.get("base")).toBeCloseTo(0.03);
  });

  it("gas from FAILED tx still counts (matches all-time iter126 behavior)", () => {
    // A reverted trade still costs gas. The window attribution honors the timestamp
    // regardless of success — same as the all-time number does.
    const rows = [
      row({
        direction: "buy",
        base_amount: "0",
        quote_amount: "0",
        status: "failed",
        timestamp: "2026-01-15T00:00:00Z",
        gas_cost_native: "0.005",
      }),
    ];
    const w: PnLWindow = { since: "2026-01-01T00:00:00Z", until: "2026-02-01T00:00:00Z" };
    const result = aggregateTrades(rows, stableQuote, [w]);
    expect(result.gasSpendPerWindow![0].get("base")).toBeCloseTo(0.005);
  });

  it("loss in a window is correctly attributed (negative realized)", () => {
    // Buy 10 @ $100 = $1000 cost → sell 5 @ $80 → realizes -$100 (loss).
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "400", timestamp: "2026-02-15T00:00:00Z" }),
    ];
    const w: PnLWindow = { since: "2026-02-01T00:00:00Z", until: "2026-03-01T00:00:00Z" };
    const result = aggregateTrades(rows, stableQuote, [w]);
    const acc = [...result.positions.values()][0];
    expect(acc.realizedPerWindow![0]).toBe(-100);
  });

  it("open-ended window (no since) covers everything before until", () => {
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2025-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "750", timestamp: "2025-06-01T00:00:00Z" }),
    ];
    const w: PnLWindow = { until: "2026-01-01T00:00:00Z" };
    const result = aggregateTrades(rows, stableQuote, [w]);
    const acc = [...result.positions.values()][0];
    expect(acc.realizedPerWindow![0]).toBe(250);
  });

  it("open-ended window (no until) covers everything after since", () => {
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2025-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "750", timestamp: "2026-02-15T00:00:00Z" }),
    ];
    const w: PnLWindow = { since: "2026-01-01T00:00:00Z" };
    const result = aggregateTrades(rows, stableQuote, [w]);
    const acc = [...result.positions.values()][0];
    expect(acc.realizedPerWindow![0]).toBe(250); // sale is in 2026, after since
  });

  it("window covering nothing yields realizedPerWindow=0 (but still populated)", () => {
    const rows = [
      row({ direction: "buy", base_amount: "10", quote_amount: "1000", timestamp: "2026-01-01T00:00:00Z" }),
      row({ direction: "sell", base_amount: "5", quote_amount: "750", timestamp: "2026-02-15T00:00:00Z" }),
    ];
    const w: PnLWindow = { since: "2030-01-01T00:00:00Z", until: "2030-12-31T00:00:00Z" };
    const result = aggregateTrades(rows, stableQuote, [w]);
    const acc = [...result.positions.values()][0];
    expect(acc.realizedPerWindow).toEqual([0]);
  });
});

// ── sumPnLReports (iter624) ────────────────────────────────

describe("sumPnLReports", () => {
  function report(overrides: Partial<PnLReport>): PnLReport {
    return {
      account: "x",
      timestamp: "2026-05-29T00:00:00Z",
      positions: [],
      gas: [],
      totalRealizedUsd: 0,
      totalUnrealizedUsd: 0,
      totalGasUsd: 0,
      totalRealizedAfterGasUsd: 0,
      severity: "ok",
      recommendedActions: [],
      ...overrides,
    };
  }

  it("returns zero totals for empty input", () => {
    const s = sumPnLReports([]);
    expect(s.totalRealizedUsd).toBe(0);
    expect(s.totalUnrealizedUsd).toBe(0);
    expect(s.totalGasUsd).toBe(0);
    expect(s.totalRealizedAfterGasUsd).toBe(0);
    expect(s.windows).toBeUndefined();
  });

  it("sums totals across multiple accounts", () => {
    const a = report({
      account: "alice",
      totalRealizedUsd: 100,
      totalUnrealizedUsd: 200,
      totalGasUsd: 10,
      totalRealizedAfterGasUsd: 90,
    });
    const b = report({
      account: "bob",
      totalRealizedUsd: 50,
      totalUnrealizedUsd: -30,
      totalGasUsd: 5,
      totalRealizedAfterGasUsd: 45,
    });
    const s = sumPnLReports([a, b]);
    expect(s.totalRealizedUsd).toBe(150);
    expect(s.totalUnrealizedUsd).toBe(170);
    expect(s.totalGasUsd).toBe(15);
    expect(s.totalRealizedAfterGasUsd).toBe(135);
  });

  it("merges windows by label across accounts", () => {
    const a = report({
      account: "alice",
      totalRealizedUsd: 100,
      windows: [
        {
          label: "7d",
          realizedUsd: 70,
          gasNativePerChain: [{ chain: "base", amount: "0.01", usd: 30 }],
          totalGasUsd: 30,
          realizedAfterGasUsd: 40,
          positions: [{ symbol: "ETH", chain: "base", token: "NATIVE", realizedUsd: 70 }],
        },
      ],
    });
    const b = report({
      account: "bob",
      totalRealizedUsd: 50,
      windows: [
        {
          label: "7d",
          realizedUsd: 50,
          gasNativePerChain: [{ chain: "base", amount: "0.005", usd: 15 }],
          totalGasUsd: 15,
          realizedAfterGasUsd: 35,
          positions: [{ symbol: "PEPE", chain: "base", token: "0xpepe", realizedUsd: 50 }],
        },
      ],
    });
    const s = sumPnLReports([a, b]);
    expect(s.windows?.length).toBe(1);
    const w = s.windows![0];
    expect(w.label).toBe("7d");
    expect(w.realizedUsd).toBe(120);
    expect(w.totalGasUsd).toBe(45);
    expect(w.realizedAfterGasUsd).toBe(75);
    expect(w.positions.length).toBe(2); // concat
    expect(w.gasNativePerChain.length).toBe(1); // base merged
    expect(parseFloat(w.gasNativePerChain[0].amount)).toBeCloseTo(0.015, 6);
    expect(w.gasNativePerChain[0].usd).toBe(45);
  });

  it("merges windows by since|until when label is missing", () => {
    const a = report({
      windows: [
        {
          since: "2026-01-01T00:00:00Z",
          until: "2026-02-01T00:00:00Z",
          realizedUsd: 10,
          gasNativePerChain: [],
          totalGasUsd: 0,
          realizedAfterGasUsd: 10,
          positions: [],
        },
      ],
    });
    const b = report({
      windows: [
        {
          since: "2026-01-01T00:00:00Z",
          until: "2026-02-01T00:00:00Z",
          realizedUsd: 20,
          gasNativePerChain: [],
          totalGasUsd: 0,
          realizedAfterGasUsd: 20,
          positions: [],
        },
      ],
    });
    const s = sumPnLReports([a, b]);
    expect(s.windows?.length).toBe(1);
    expect(s.windows![0].realizedUsd).toBe(30);
  });

  it("keeps separate windows with different labels", () => {
    const a = report({
      windows: [
        {
          label: "7d",
          realizedUsd: 10,
          gasNativePerChain: [],
          totalGasUsd: 0,
          realizedAfterGasUsd: 10,
          positions: [],
        },
        {
          label: "30d",
          realizedUsd: 100,
          gasNativePerChain: [],
          totalGasUsd: 0,
          realizedAfterGasUsd: 100,
          positions: [],
        },
      ],
    });
    const s = sumPnLReports([a]);
    expect(s.windows?.length).toBe(2);
  });

  it("does not mutate the input reports", () => {
    const a = report({
      windows: [
        {
          label: "7d",
          realizedUsd: 70,
          gasNativePerChain: [{ chain: "base", amount: "0.01", usd: 30 }],
          totalGasUsd: 30,
          realizedAfterGasUsd: 40,
          positions: [{ symbol: "ETH", chain: "base", token: "NATIVE", realizedUsd: 70 }],
        },
      ],
    });
    const before = JSON.stringify(a);
    sumPnLReports([a, a]);
    expect(JSON.stringify(a)).toBe(before);
  });
});

// ── rollupPositionsBySymbol (iter627) ──────────────────────

describe("rollupPositionsBySymbol", () => {
  function pos(overrides: Partial<TokenPosition> = {}): TokenPosition {
    return {
      chain: "base",
      symbol: "ETH",
      token: "NATIVE",
      amount: "1.0",
      avgCostUsd: 3000,
      realizedUsd: 0,
      currentPriceUsd: 3500,
      unrealizedUsd: 500,
      trades: 5,
      ...overrides,
    };
  }

  it("returns empty array for empty positions", () => {
    expect(rollupPositionsBySymbol([])).toEqual([]);
  });

  it("single-chain position passes through unchanged in totals", () => {
    const r = rollupPositionsBySymbol([pos()]);
    expect(r.length).toBe(1);
    expect(r[0].symbol).toBe("ETH");
    expect(parseFloat(r[0].amount)).toBe(1);
    expect(r[0].avgCostUsd).toBe(3000);
    expect(r[0].realizedUsd).toBe(0);
    expect(r[0].unrealizedUsd).toBe(500);
    expect(r[0].chains).toEqual(["base"]);
    expect(r[0].unpricedChainCount).toBe(0);
  });

  it("collapses multi-chain same-symbol into one entry", () => {
    const r = rollupPositionsBySymbol([
      pos({ chain: "base", amount: "1.0", avgCostUsd: 3000, realizedUsd: 100, unrealizedUsd: 500 }),
      pos({ chain: "arbitrum", amount: "2.0", avgCostUsd: 2500, realizedUsd: 50, unrealizedUsd: 1000 }),
      pos({ chain: "optimism", amount: "0.5", avgCostUsd: 3200, realizedUsd: -20, unrealizedUsd: 150 }),
    ]);
    expect(r.length).toBe(1);
    expect(r[0].symbol).toBe("ETH");
    expect(parseFloat(r[0].amount)).toBeCloseTo(3.5, 6);
    expect(r[0].realizedUsd).toBe(130); // 100 + 50 - 20
    expect(r[0].unrealizedUsd).toBe(1650); // 500 + 1000 + 150
    expect(r[0].totalUsd).toBe(1780); // 130 + 1650
    expect(r[0].chains.sort()).toEqual(["arbitrum", "base", "optimism"]);
  });

  it("weights avgCostUsd by amount across chains", () => {
    const r = rollupPositionsBySymbol([
      pos({ chain: "base", amount: "1.0", avgCostUsd: 3000 }),
      pos({ chain: "arbitrum", amount: "3.0", avgCostUsd: 2000 }),
    ]);
    // weighted: (1×3000 + 3×2000) / 4 = 9000/4 = 2250
    expect(r[0].avgCostUsd).toBeCloseTo(2250, 4);
  });

  it("sorts entries by totalUsd descending", () => {
    const r = rollupPositionsBySymbol([
      pos({ symbol: "PEPE", realizedUsd: 50, unrealizedUsd: 100 }), // 150
      pos({ symbol: "ETH", realizedUsd: 500, unrealizedUsd: 5000 }), // 5500
      pos({ symbol: "USDC", realizedUsd: 200, unrealizedUsd: 800 }), // 1000
    ]);
    expect(r[0].symbol).toBe("ETH");
    expect(r[1].symbol).toBe("USDC");
    expect(r[2].symbol).toBe("PEPE");
  });

  it("case-insensitive symbol grouping", () => {
    const r = rollupPositionsBySymbol([
      pos({ chain: "base", symbol: "Pepe", amount: "1000" }),
      pos({ chain: "arbitrum", symbol: "PEPE", amount: "2000" }),
      pos({ chain: "optimism", symbol: "pepe", amount: "500" }),
    ]);
    expect(r.length).toBe(1);
    expect(r[0].symbol).toBe("PEPE"); // uppercased
    expect(parseFloat(r[0].amount)).toBe(3500);
  });

  it("tracks unpricedChainCount when currentPriceUsd is missing", () => {
    const r = rollupPositionsBySymbol([
      pos({ chain: "base", currentPriceUsd: 3500, unrealizedUsd: 500 }),
      pos({ chain: "arbitrum", currentPriceUsd: undefined, unrealizedUsd: undefined }),
      pos({ chain: "optimism", currentPriceUsd: undefined, unrealizedUsd: undefined }),
    ]);
    expect(r[0].unpricedChainCount).toBe(2);
    expect(r[0].unrealizedUsd).toBe(500); // only the priced chain contributes
  });

  it("sums trades across chains", () => {
    const r = rollupPositionsBySymbol([
      pos({ chain: "base", trades: 10 }),
      pos({ chain: "arbitrum", trades: 5 }),
    ]);
    expect(r[0].trades).toBe(15);
  });

  it("zero-amount aggregate keeps avgCostUsd = 0 (no divide-by-zero)", () => {
    const r = rollupPositionsBySymbol([
      pos({ chain: "base", amount: "0", avgCostUsd: 3000, realizedUsd: 100, unrealizedUsd: 0 }),
    ]);
    expect(r[0].avgCostUsd).toBe(0); // (0 × 3000) / 0 → 0 (safe)
    expect(r[0].realizedUsd).toBe(100); // realized still counts even with zero current position
  });

  it("totalUsd correctly combines realized + unrealized", () => {
    const r = rollupPositionsBySymbol([
      pos({ realizedUsd: 100, unrealizedUsd: 200 }),
    ]);
    expect(r[0].totalUsd).toBe(300);
  });

  it("iter707: lastTradeAt aggregates MAX across contributing chains", () => {
    const r = rollupPositionsBySymbol([
      pos({ chain: "base", lastTradeAt: "2026-05-01T00:00:00Z" }),
      pos({ chain: "arbitrum", lastTradeAt: "2026-05-20T15:00:00Z" }), // latest
      pos({ chain: "optimism", lastTradeAt: "2026-05-10T00:00:00Z" }),
    ]);
    expect(r.length).toBe(1);
    expect(r[0].lastTradeAt).toBe("2026-05-20T15:00:00Z");
  });

  it("iter707: lastTradeAt absent when no contributing position carries it (back-compat)", () => {
    const r = rollupPositionsBySymbol([pos({ chain: "base" })]);
    expect(r[0].lastTradeAt).toBeUndefined();
  });

  it("iter707: partial coverage (some chains have lastTradeAt, others don't) uses MAX of present", () => {
    const r = rollupPositionsBySymbol([
      pos({ chain: "base" }), // no lastTradeAt
      pos({ chain: "arbitrum", lastTradeAt: "2026-05-15T00:00:00Z" }),
    ]);
    expect(r[0].lastTradeAt).toBe("2026-05-15T00:00:00Z");
  });
});

// ── aggregateTrades byAggregator (iter636) ─────────────────

describe("aggregateTrades realizedByAggregator (iter636)", () => {
  const stable = () => 1; // stablecoin quote

  function r(o: Partial<TradeRow> = {}): TradeRow {
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

  it("buckets realized USD by aggregator on sells", () => {
    const { realizedByAggregator } = aggregateTrades(
      [
        // Buy 1 ETH for $3000 via kyberswap
        r({ id: 1, direction: "buy", base_amount: "1", quote_amount: "3000", aggregator: "kyberswap", timestamp: "2026-01-01T00:00:00Z" }),
        // Sell 0.5 ETH for $2000 via kyberswap → realized = (2000/0.5 - 3000) * 0.5 = (4000 - 3000) * 0.5 = $500
        r({ id: 2, direction: "sell", base_amount: "0.5", quote_amount: "2000", aggregator: "kyberswap", timestamp: "2026-02-01T00:00:00Z" }),
      ],
      stable,
    );
    const k = realizedByAggregator.get("kyberswap");
    expect(k?.realizedUsd).toBeCloseTo(500, 2);
    expect(k?.tradeCount).toBe(2); // buy + sell both count
  });

  it("buys add to tradeCount but not realized (no realization on opening)", () => {
    const { realizedByAggregator } = aggregateTrades(
      [r({ direction: "buy", aggregator: "openocean" })],
      stable,
    );
    const o = realizedByAggregator.get("openocean");
    expect(o?.tradeCount).toBe(1);
    expect(o?.realizedUsd).toBe(0);
  });

  it("null/empty aggregator strings collapse into 'unknown' bucket", () => {
    const { realizedByAggregator } = aggregateTrades(
      [
        r({ id: 1, direction: "buy", aggregator: null }),
        r({ id: 2, direction: "buy", aggregator: "" }),
      ],
      stable,
    );
    expect(realizedByAggregator.get("unknown")?.tradeCount).toBe(2);
  });

  it("transfers are excluded from byAggregator (consistent with cost basis math)", () => {
    const { realizedByAggregator } = aggregateTrades(
      [r({ direction: "sell", aggregator: "transfer" })],
      stable,
    );
    expect(realizedByAggregator.get("transfer")).toBeUndefined();
  });

  it("multiple aggregators tracked separately", () => {
    const { realizedByAggregator } = aggregateTrades(
      [
        r({ id: 1, direction: "buy", base_amount: "1", quote_amount: "3000", aggregator: "kyberswap", timestamp: "2026-01-01T00:00:00Z" }),
        r({ id: 2, direction: "sell", base_amount: "1", quote_amount: "3500", aggregator: "openocean", timestamp: "2026-02-01T00:00:00Z" }),
      ],
      stable,
    );
    expect(realizedByAggregator.get("kyberswap")?.realizedUsd).toBe(0); // buy only
    expect(realizedByAggregator.get("openocean")?.realizedUsd).toBeCloseTo(500, 2);
  });
});

// ── sumPnLReports byAggregator merge (iter636) ─────────────

describe("sumPnLReports byAggregator merge", () => {
  function rep(o: Partial<PnLReport>): PnLReport {
    return {
      account: "x",
      timestamp: "2026-05-29T00:00:00Z",
      positions: [],
      gas: [],
      totalRealizedUsd: 0,
      totalUnrealizedUsd: 0,
      totalGasUsd: 0,
      totalRealizedAfterGasUsd: 0,
      severity: "ok",
      recommendedActions: [],
      ...o,
    };
  }

  it("merges per-aggregator across accounts (same aggregator → sum)", () => {
    const a = rep({
      account: "alice",
      byAggregator: [{ aggregator: "kyberswap", realizedUsd: 100, tradeCount: 5 }],
    });
    const b = rep({
      account: "bob",
      byAggregator: [{ aggregator: "kyberswap", realizedUsd: 50, tradeCount: 3 }],
    });
    const s = sumPnLReports([a, b]);
    expect(s.byAggregator).toBeDefined();
    expect(s.byAggregator?.length).toBe(1);
    expect(s.byAggregator?.[0]).toMatchObject({ aggregator: "kyberswap", realizedUsd: 150, tradeCount: 8 });
  });

  it("iter708: lastTradeAt aggregates as MAX across merged accounts", () => {
    const a = rep({
      account: "alice",
      byAggregator: [{ aggregator: "kyberswap", realizedUsd: 100, tradeCount: 5, lastTradeAt: "2026-05-15T00:00:00Z" }],
    });
    const b = rep({
      account: "bob",
      byAggregator: [{ aggregator: "kyberswap", realizedUsd: 50, tradeCount: 3, lastTradeAt: "2026-05-25T12:00:00Z" }], // latest
    });
    const s = sumPnLReports([a, b]);
    expect(s.byAggregator?.[0].lastTradeAt).toBe("2026-05-25T12:00:00Z");
  });

  it("iter708: merged entry omits lastTradeAt when neither account had it", () => {
    const a = rep({
      account: "alice",
      byAggregator: [{ aggregator: "kyberswap", realizedUsd: 100, tradeCount: 5 }],
    });
    const b = rep({
      account: "bob",
      byAggregator: [{ aggregator: "kyberswap", realizedUsd: 50, tradeCount: 3 }],
    });
    const s = sumPnLReports([a, b]);
    expect(s.byAggregator?.[0].lastTradeAt).toBeUndefined();
  });

  it("keeps distinct aggregators separate", () => {
    const a = rep({
      byAggregator: [{ aggregator: "kyberswap", realizedUsd: 100, tradeCount: 5 }],
    });
    const b = rep({
      byAggregator: [{ aggregator: "openocean", realizedUsd: 50, tradeCount: 3 }],
    });
    const s = sumPnLReports([a, b]);
    expect(s.byAggregator?.length).toBe(2);
  });

  it("sorts by realizedUsd desc", () => {
    const a = rep({
      byAggregator: [
        { aggregator: "loser", realizedUsd: -50, tradeCount: 2 },
        { aggregator: "winner", realizedUsd: 500, tradeCount: 5 },
        { aggregator: "mid", realizedUsd: 100, tradeCount: 3 },
      ],
    });
    const s = sumPnLReports([a]);
    expect(s.byAggregator?.[0].aggregator).toBe("winner");
    expect(s.byAggregator?.[1].aggregator).toBe("mid");
    expect(s.byAggregator?.[2].aggregator).toBe("loser");
  });

  it("omits byAggregator when no reports carry it (back-compat)", () => {
    const s = sumPnLReports([rep({})]);
    expect(s.byAggregator).toBeUndefined();
  });
});

// ── aggregateTrades byPair (iter639) ───────────────────────

describe("aggregateTrades realizedByPair (iter639)", () => {
  const stable = () => 1;

  function r(o: Partial<TradeRow> = {}): TradeRow {
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

  it("buckets realized USD by canonical pair", () => {
    const { realizedByPair } = aggregateTrades(
      [
        r({ id: 1, direction: "buy", base_amount: "1", quote_amount: "3000", base_symbol: "ETH", quote_symbol: "USDC", timestamp: "2026-01-01T00:00:00Z" }),
        r({ id: 2, direction: "sell", base_amount: "0.5", quote_amount: "2000", base_symbol: "ETH", quote_symbol: "USDC", timestamp: "2026-02-01T00:00:00Z" }),
      ],
      stable,
    );
    const ethUsdc = realizedByPair.get("ETH/USDC");
    expect(ethUsdc?.realizedUsd).toBeCloseTo(500, 2);
    expect(ethUsdc?.tradeCount).toBe(2);
  });

  it("collapses both directions of same pair", () => {
    const { realizedByPair } = aggregateTrades(
      [
        r({ id: 1, direction: "buy", base_symbol: "ETH", quote_symbol: "USDC" }),
        r({ id: 2, direction: "buy", base_symbol: "USDC", quote_symbol: "ETH" }), // reversed
      ],
      stable,
    );
    expect(realizedByPair.get("ETH/USDC")?.tradeCount).toBe(2);
  });

  it("separates distinct pairs", () => {
    const { realizedByPair } = aggregateTrades(
      [
        r({ id: 1, base_symbol: "ETH", quote_symbol: "USDC" }),
        r({ id: 2, base_symbol: "PEPE", quote_symbol: "USDC" }),
      ],
      stable,
    );
    expect(realizedByPair.size).toBe(2);
    expect(realizedByPair.get("ETH/USDC")).toBeDefined();
    expect(realizedByPair.get("PEPE/USDC")).toBeDefined();
  });

  it("transfers excluded from byPair (consistent with cost basis)", () => {
    const { realizedByPair } = aggregateTrades(
      [r({ aggregator: "transfer" })],
      stable,
    );
    expect(realizedByPair.size).toBe(0);
  });
});

// ── sumPnLReports byPair merge (iter639) ──────────────────

describe("sumPnLReports byPair merge", () => {
  function rep(o: Partial<PnLReport>): PnLReport {
    return {
      account: "x",
      timestamp: "2026-05-29T00:00:00Z",
      positions: [],
      gas: [],
      totalRealizedUsd: 0,
      totalUnrealizedUsd: 0,
      totalGasUsd: 0,
      totalRealizedAfterGasUsd: 0,
      severity: "ok",
      recommendedActions: [],
      ...o,
    };
  }

  it("merges per-pair across accounts (same pair → sum)", () => {
    const a = rep({
      byPair: [{ pair: "ETH/USDC", realizedUsd: 100, tradeCount: 5 }],
    });
    const b = rep({
      byPair: [{ pair: "ETH/USDC", realizedUsd: 50, tradeCount: 3 }],
    });
    const s = sumPnLReports([a, b]);
    expect(s.byPair?.length).toBe(1);
    expect(s.byPair?.[0]).toEqual({ pair: "ETH/USDC", realizedUsd: 150, tradeCount: 8 });
  });

  it("keeps distinct pairs separate + sorts by realizedUsd desc", () => {
    const a = rep({
      byPair: [
        { pair: "PEPE/USDC", realizedUsd: -200, tradeCount: 3 },
        { pair: "ETH/USDC", realizedUsd: 500, tradeCount: 5 },
        { pair: "WBTC/USDC", realizedUsd: 100, tradeCount: 2 },
      ],
    });
    const s = sumPnLReports([a]);
    expect(s.byPair?.[0].pair).toBe("ETH/USDC");
    expect(s.byPair?.[2].pair).toBe("PEPE/USDC");
  });

  it("omits byPair when no reports carry it (back-compat)", () => {
    const s = sumPnLReports([rep({})]);
    expect(s.byPair).toBeUndefined();
  });

  it("iter649: merges byStrategy across accounts", () => {
    const a = rep({
      byStrategy: [{ strategy: "dca-eth", realizedUsd: 100, tradeCount: 5 }],
    });
    const b = rep({
      byStrategy: [{ strategy: "dca-eth", realizedUsd: 50, tradeCount: 3 }],
    });
    const s = sumPnLReports([a, b]);
    expect(s.byStrategy?.length).toBe(1);
    expect(s.byStrategy?.[0]).toEqual({ strategy: "dca-eth", realizedUsd: 150, tradeCount: 8 });
  });

  it("iter649: omits byStrategy when no reports carry it (back-compat)", () => {
    const s = sumPnLReports([rep({})]);
    expect(s.byStrategy).toBeUndefined();
  });
});

// ── aggregateTrades gas USD stored vs unstored (iter646) ────

describe("aggregateTrades gas USD stored vs unstored (iter646)", () => {
  const stable = () => 1;

  function r(o: Partial<TradeRow> = {}): TradeRow {
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
      gas_cost_native: "0.005",
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      ...o,
    };
  }

  it("rows with stored gas USD populate gasSpendUsdStored", () => {
    const { gasSpendUsdStored, gasSpendNativeUnstored } = aggregateTrades(
      [r({ chain: "base", gas_cost_native: "0.005", gas_cost_usd_at_trade: 17.5 })],
      stable,
    );
    expect(gasSpendUsdStored.get("base")).toBeCloseTo(17.5, 2);
    // The native amount of this row should NOT be in the unstored bucket
    // (would double-count when the computer adds storedUsd + unstoredNative × price).
    expect(gasSpendNativeUnstored.get("base") ?? 0).toBe(0);
  });

  it("rows without stored gas USD populate gasSpendNativeUnstored", () => {
    const { gasSpendUsdStored, gasSpendNativeUnstored } = aggregateTrades(
      [r({ chain: "base", gas_cost_native: "0.005", gas_cost_usd_at_trade: null })],
      stable,
    );
    expect(gasSpendUsdStored.get("base") ?? 0).toBe(0);
    expect(gasSpendNativeUnstored.get("base")).toBeCloseTo(0.005, 6);
  });

  it("gasSpend (total native) includes BOTH stored + unstored rows", () => {
    const { gasSpend } = aggregateTrades(
      [
        r({ chain: "base", gas_cost_native: "0.005", gas_cost_usd_at_trade: 17.5 }),
        r({ tx_hash: "0xdef", chain: "base", gas_cost_native: "0.003", gas_cost_usd_at_trade: null }),
      ],
      stable,
    );
    expect(gasSpend.get("base")).toBeCloseTo(0.008, 6);
  });

  it("non-finite gas_cost_usd_at_trade falls back to native bucket (defensive)", () => {
    const { gasSpendUsdStored, gasSpendNativeUnstored } = aggregateTrades(
      [r({ chain: "base", gas_cost_native: "0.005", gas_cost_usd_at_trade: NaN as never })],
      stable,
    );
    expect(gasSpendUsdStored.get("base") ?? 0).toBe(0);
    expect(gasSpendNativeUnstored.get("base")).toBeCloseTo(0.005, 6);
  });

  it("iter649: buckets realized USD by strategy tag", () => {
    const { realizedByStrategy } = aggregateTrades(
      [
        r({ id: 1, direction: "buy", base_amount: "1", quote_amount: "3000", strategy: "dca-eth", timestamp: "2026-01-01T00:00:00Z" }),
        r({ id: 2, direction: "sell", base_amount: "0.5", quote_amount: "2000", strategy: "dca-eth", timestamp: "2026-02-01T00:00:00Z" }),
        r({ id: 3, direction: "buy", base_amount: "1", quote_amount: "3000", strategy: "swing", timestamp: "2026-01-01T00:00:00Z" }),
      ],
      stable,
    );
    expect(realizedByStrategy.get("dca-eth")?.realizedUsd).toBeCloseTo(500, 2);
    expect(realizedByStrategy.get("dca-eth")?.tradeCount).toBe(2);
    expect(realizedByStrategy.get("swing")?.realizedUsd).toBe(0);
    expect(realizedByStrategy.get("swing")?.tradeCount).toBe(1);
  });

  it("iter649: NULL/empty strategy collapses into '(none)' bucket", () => {
    const { realizedByStrategy } = aggregateTrades(
      [
        r({ id: 1, direction: "buy", strategy: null }),
        r({ id: 2, direction: "buy", strategy: "" }),
        r({ id: 3, direction: "buy", strategy: "  " }), // whitespace-only
      ],
      stable,
    );
    expect(realizedByStrategy.get("(none)")?.tradeCount).toBe(3);
  });

  it("iter647: stored/unstored split also populates per-window maps", () => {
    const window: PnLWindow = {
      since: "2026-01-01T00:00:00Z",
      until: "2027-01-01T00:00:00Z",
      label: "y2026",
    };
    const out = aggregateTrades(
      [
        r({ tx_hash: "0xa", timestamp: "2026-03-01T00:00:00Z", chain: "base", gas_cost_native: "0.005", gas_cost_usd_at_trade: 17.5 }),
        r({ tx_hash: "0xb", timestamp: "2026-04-01T00:00:00Z", chain: "base", gas_cost_native: "0.003", gas_cost_usd_at_trade: null }),
        // Outside the window — shouldn't contribute.
        r({ tx_hash: "0xc", timestamp: "2025-01-01T00:00:00Z", chain: "base", gas_cost_native: "0.999", gas_cost_usd_at_trade: 999 }),
      ],
      stable,
      [window],
    );
    expect(out.gasSpendUsdStoredPerWindow?.[0].get("base")).toBeCloseTo(17.5, 2);
    expect(out.gasSpendNativeUnstoredPerWindow?.[0].get("base")).toBeCloseTo(0.003, 6);
  });
});

describe("computeStaleBookmarkEntries (iter741)", () => {
  const NOW = new Date("2026-05-30T00:00:00Z").getTime();
  const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

  it("returns [] when no bookmarks match the account", () => {
    const entries = computeStaleBookmarkEntries({
      account: "main",
      bookmarks: [
        { chain: "base", account: "other", owner: "0xa", lastSyncedBlock: 1n, updatedAt: hoursAgo(100) },
      ],
      nowMs: NOW,
    });
    expect(entries).toEqual([]);
  });

  it("returns [] when matching bookmarks are all fresh (under the 48h default)", () => {
    const entries = computeStaleBookmarkEntries({
      account: "main",
      bookmarks: [
        { chain: "base", account: "main", owner: "0xa", lastSyncedBlock: 1n, updatedAt: hoursAgo(10) },
        { chain: "arbitrum", account: "main", owner: "0xa", lastSyncedBlock: 2n, updatedAt: hoursAgo(45) },
      ],
      nowMs: NOW,
    });
    expect(entries).toEqual([]);
  });

  it("flags a single stale bookmark with rounded ageHours", () => {
    const entries = computeStaleBookmarkEntries({
      account: "main",
      bookmarks: [
        { chain: "base", account: "main", owner: "0xabc", lastSyncedBlock: 999n, updatedAt: hoursAgo(72) },
      ],
      nowMs: NOW,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      chain: "base",
      account: "main",
      owner: "0xabc",
      lastSyncedBlock: "999",
    });
    expect(entries[0].ageHours).toBeCloseTo(72, 0);
  });

  it("filters by chain when set (multi-chain accounts)", () => {
    const entries = computeStaleBookmarkEntries({
      account: "main",
      chain: "base",
      bookmarks: [
        { chain: "base", account: "main", owner: "0xa", lastSyncedBlock: 1n, updatedAt: hoursAgo(100) },
        { chain: "arbitrum", account: "main", owner: "0xa", lastSyncedBlock: 2n, updatedAt: hoursAgo(100) },
      ],
      nowMs: NOW,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].chain).toBe("base");
  });

  it("respects a custom staleAfterHours override", () => {
    const entries = computeStaleBookmarkEntries({
      account: "main",
      bookmarks: [
        { chain: "base", account: "main", owner: "0xa", lastSyncedBlock: 1n, updatedAt: hoursAgo(36) },
      ],
      nowMs: NOW,
      staleAfterHours: 24,
    });
    expect(entries).toHaveLength(1);
  });

  it("exports PNL_STALE_BOOKMARK_HOURS = 48 (the documented default)", () => {
    expect(PNL_STALE_BOOKMARK_HOURS).toBe(48);
  });
});
