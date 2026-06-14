// Iter616: tax-grade trade export enrichment.
//
// Pre-iter616 `trades --format csv` exported raw rows with no PnL columns.
// Operators filing taxes had to manually compute cost basis + realized gain
// per trade. Iter616 adds an enriched export mode that walks trades
// chronologically (preserving the same path-dependent weighted-average cost
// basis math iter615 uses) and attaches 4 derived columns to each row:
//   - cost_basis_usd: USD cost released by this trade. Sells: the avg-cost-
//     basis × amount sold. Buys: the USD spent (i.e. cost ADDED). Null for
//     transfers / failed / unpriced rows.
//   - proceeds_usd: USD received. Sells only. Null otherwise.
//   - realized_pnl_usd: proceeds - cost_basis. Sells only. Null otherwise.
//   - gas_usd: native gas × chain native USD price. Available when prices
//     are known.
//
// IMPORTANT: This enrichment is PATH-DEPENDENT. It walks rows chronologically
// in the order they were on-chain. Filtering the input by date first would
// break the cost-basis math — same caveat iter615 documents.
//
// Currency model: this module reports USD numbers using the SAME quoteUsd
// callback the PnL aggregator uses. For stablecoin quote rows that's $1; for
// volatile quote rows the caller must inject the right price (best-effort
// "current price" is what iter615's computePnL does, with a known caveat
// that historical prices aren't backfilled).

import type { TradeRow } from "./db.js";
import { applyBuy, applySell } from "./costBasis.js";

export interface EnrichedTradeRow extends TradeRow {
  /**
   * USD value of the cost basis associated with this trade.
   * - Buy: equals proceeds_usd (the buy's USD cost — what's being ADDED to basis).
   * - Sell: equals the released avg-cost-basis (USD cost of the shares being closed).
   * - Transfer / failed / unpriced: null.
   */
  cost_basis_usd: number | null;
  /**
   * USD proceeds.
   * - Sell: USD received.
   * - Buy: null (a buy is paying out, not receiving).
   * - Transfer / failed / unpriced: null.
   */
  proceeds_usd: number | null;
  /**
   * Realized PnL = proceeds_usd - cost_basis_usd. Sells only.
   * Null for buys (no realization event — opening a position doesn't crystallize gain/loss).
   */
  realized_pnl_usd: number | null;
  /**
   * gas_cost_native × chain native USD price. Null when either is unknown.
   */
  gas_usd: number | null;
}

/** Same isStablecoin shape pnl.ts uses — local copy avoids cross-import. */
function isStablecoin(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return /^(USDC|USDT|DAI|BUSD|FRAX|USDP|TUSD|USDC\.e)$/i.test(symbol);
}

/**
 * Iter616: per-row enrichment. Walks chronologically, maintains per-token
 * weighted-average cost basis, computes the 4 derived columns. Pure: no I/O,
 * no logger. Returns a NEW array with original row order preserved.
 *
 * `quoteUsd(row)` returns USD-per-unit of the row's quote token at trade time
 * (matches pnl.ts's signature). Return null to skip USD attribution on that
 * row (the row still appears, just with null cost_basis_usd / proceeds_usd /
 * realized_pnl_usd).
 *
 * `gasUsdPerChain` maps chain → USD-per-native-unit. When a chain isn't
 * present (or the value is null), gas_usd is null for that row.
 */
export function enrichTradesForExport(
  rows: readonly TradeRow[],
  quoteUsd: (row: TradeRow) => number | null,
  gasUsdPerChain: Map<string, number | null>,
): EnrichedTradeRow[] {
  type PositionState = { amount: number; cost: number };
  const positions = new Map<string, PositionState>();
  const out: EnrichedTradeRow[] = [];

  // Sort defensively — caller might pass unsorted rows. The PnL aggregator
  // gets its rows from allTrades which orders by timestamp; we do the same
  // here so callers passing raw row arrays still get correct math.
  const sorted = [...rows].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    // Ties → respect input order (insertion-stable). Sort by id when present.
    return (a.id ?? 0) - (b.id ?? 0);
  });

  for (const row of sorted) {
    // Gas USD: independent of trade success — gas is paid regardless of revert
    // (same iter126 rationale aggregateTrades uses).
    const gasUsd = ((): number | null => {
      if (!row.gas_cost_native) return null;
      const g = parseFloat(row.gas_cost_native);
      if (!Number.isFinite(g)) return null;
      const nativeUsd = gasUsdPerChain.get(row.chain);
      if (nativeUsd == null) return null;
      return g * nativeUsd;
    })();

    // Default to null for cost/proceeds/realized. Filled below for SUCCESS-status
    // swap rows that have parseable amounts + a quoteUsd value.
    let costBasisUsd: number | null = null;
    let proceedsUsd: number | null = null;
    let realizedPnlUsd: number | null = null;

    const isSwap = row.status === "success" && row.aggregator !== "transfer";
    if (isSwap) {
      const baseAmt = parseFloat(row.base_amount) || 0;
      const quoteAmt = parseFloat(row.quote_amount) || 0;
      const qUsd = quoteUsd(row);
      if (baseAmt > 0 && quoteAmt > 0 && qUsd != null) {
        const tradeUsd = quoteAmt * qUsd;
        const key = `${row.chain}:${(row.base_symbol ?? row.base_token).toUpperCase()}`;
        let pos = positions.get(key);
        if (!pos) {
          pos = { amount: 0, cost: 0 };
          positions.set(key, pos);
        }

        if (row.direction === "buy") {
          // Buy: ADD to position. cost_basis_usd represents the buy's USD value
          // (what's being added to basis). proceeds is null (you're paying, not receiving).
          applyBuy(pos, baseAmt, tradeUsd);
          costBasisUsd = tradeUsd;
          proceedsUsd = null;
          realizedPnlUsd = null;
        } else {
          // Sell: REMOVE from position via the shared reducer (v82 — the same
          // cost-basis core pnl.ts / the MTM walker / position caps use, so the
          // tax-export numbers can't drift from the PnL surfaces). cost_basis is
          // the avg cost × sold; proceeds is USD received; realized = the diff.
          // The over-sold amount (sell beyond the open position) gets cost_basis
          // 0 — pure gain, no prior buy to attribute against — same cap pnl.ts uses.
          const { sold, costRemoved } = applySell(pos, baseAmt);
          const sellPricePerUnit = tradeUsd / baseAmt;
          const proceedsForSold = sold * sellPricePerUnit;
          costBasisUsd = costRemoved;
          proceedsUsd = proceedsForSold;
          realizedPnlUsd = proceedsForSold - costRemoved;
        }
      }
    }

    out.push({ ...row, cost_basis_usd: costBasisUsd, proceeds_usd: proceedsUsd, realized_pnl_usd: realizedPnlUsd, gas_usd: gasUsd });
  }

  return out;
}

/**
 * Iter616: default quoteUsd resolver — $1 for stablecoins, null otherwise.
 * Matches pnl.ts's quoteUsdAtTrade. Callers who want live prices wrap this
 * with a Map-backed fallback (same pattern computePnL uses).
 *
 * Exported so the CLI/MCP layer can compose it with a live price map without
 * re-implementing the stablecoin pattern.
 */
export function quoteUsdAtTradeForExport(row: TradeRow): number | null {
  if (isStablecoin(row.quote_symbol)) return 1;
  return null;
}

/**
 * Canonical column order for the enriched CSV. Built from TRADE_COLUMNS plus
 * the 4 new tax-grade columns at the end. Single source of truth so the empty-
 * result case still emits a parseable header.
 *
 * Exported separately from TRADE_COLUMNS so the existing `--format csv` stays
 * byte-identical to pre-iter616 output — only `--format tax` uses these.
 */
export const ENRICHED_COLUMNS = [
  "id",
  "timestamp",
  "chain",
  "account",
  "direction",
  "base_token",
  "base_symbol",
  "base_amount",
  "quote_token",
  "quote_symbol",
  "quote_amount",
  "price",
  "tx_hash",
  "status",
  "gas_used",
  "gas_price_wei",
  "gas_cost_native",
  "aggregator",
  "fee_tier",
  "notes",
  // Iter616 additions:
  "cost_basis_usd",
  "proceeds_usd",
  "realized_pnl_usd",
  "gas_usd",
] as const;
