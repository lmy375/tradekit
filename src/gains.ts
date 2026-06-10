/**
 * Realized-gains report (v36) — the tax-season export.
 *
 * Walks real trades (status=success) or paper fills through the SAME
 * weighted-average cost-basis engine every P&L surface uses
 * (computePaperPnlMtm) and exposes the per-sell realizations the
 * walker computes internally: date, amount sold, proceeds, cost
 * basis, gain, average cost, tx hash.
 *
 * Method disclaimers (printed on every export, documented in README):
 *  - WEIGHTED AVERAGE cost basis — not FIFO, not specific-lot. Some
 *    jurisdictions require a specific method; this report may not be
 *    directly filing-ready everywhere.
 *  - Stablecoin-quote fills only (the cost-basis engine's stable-
 *    anchor rule); skipped fills are counted.
 *  - Gas is EXCLUDED (the full-portfolio `tradekit pnl` owns gas
 *    accounting).
 *  - Sells without a tracked basis (pre-history holdings, transfers
 *    in) are reported separately as untracked proceeds — never
 *    silently folded into gains.
 *  - Not tax advice.
 *
 * Deterministic: no oracle is involved — realizations come purely
 * from the fill journal, so the same window always exports the same
 * rows.
 */

import { recentTrades, listPaperTrades, type PaperTradeRow } from "./db.js";
import { computePaperPnlMtm, type RealizationRecord } from "./paperPnl.js";
import { ToolError } from "./errors.js";

export interface GainsReport {
  mode: "real" | "paper";
  sinceIso: string | null;
  untilIso: string | null;
  records: RealizationRecord[];
  totalGainQuote: number;
  totalProceedsQuote: number;
  totalCostBasisQuote: number;
  totalUntrackedProceedsQuote: number;
  /** Fills excluded because the quote token isn't a stablecoin. */
  skippedNonStableQuote: number;
}

export async function gatherRealizedGains(args: {
  mode: "real" | "paper";
  account?: string;
  chain?: string;
  strategy?: string;
  sinceIso?: string;
  untilIso?: string;
}): Promise<GainsReport> {
  let rows: PaperTradeRow[];
  if (args.mode === "paper") {
    rows = listPaperTrades({}) as PaperTradeRow[];
    if (args.account) rows = rows.filter((r) => r.account === args.account);
    if (args.chain) { const c = args.chain.toLowerCase(); rows = rows.filter((r) => r.chain === c); }
    if (args.strategy) rows = rows.filter((r) => r.strategy === args.strategy);
  } else {
    // Real trades through the same adapter shape strategyReport uses —
    // success rows only; tx_hash rides along for the export.
    const trades = recentTrades({
      account: args.account,
      chain: args.chain,
      strategy: args.strategy,
      limit: 100_000,
    });
    rows = trades
      .filter((t) => t.status === "success")
      .map((t, i) => ({
        id: t.id ?? i,
        timestamp: t.timestamp,
        source_type: "manual",
        source_id: null,
        chain: t.chain,
        account: t.account,
        direction: t.direction,
        base_token: t.base_token,
        base_symbol: t.base_symbol,
        base_amount: t.base_amount,
        quote_token: t.quote_token,
        quote_symbol: t.quote_symbol,
        quote_amount: t.quote_amount,
        price: t.price ?? "0",
        slippage_bps: null,
        strategy: t.strategy ?? null,
        notes: null,
        tx_hash: t.tx_hash,
      })) as unknown as PaperTradeRow[];
  }

  // IMPORTANT: cost basis is path-dependent — the walk must see the
  // FULL history (a 2025 buy funds a 2026 sell's basis). The window
  // filters the OUTPUT records, never the input fills.
  const report = await computePaperPnlMtm(rows, async () => null);

  let records = report.realizations;
  if (args.sinceIso) records = records.filter((r) => r.at >= args.sinceIso!);
  if (args.untilIso) records = records.filter((r) => r.at <= args.untilIso!);

  let totalGain = 0;
  let totalProceeds = 0;
  let totalCost = 0;
  let totalUntracked = 0;
  for (const r of records) {
    totalGain += r.gainQuote;
    totalProceeds += r.proceedsQuote;
    totalCost += r.costBasisQuote;
    totalUntracked += r.untrackedProceedsQuote;
  }
  const skipped = report.summaries.reduce((acc, s) => acc + (s.skippedNonStableQuote ?? 0), 0);

  return {
    mode: args.mode,
    sinceIso: args.sinceIso ?? null,
    untilIso: args.untilIso ?? null,
    records,
    totalGainQuote: totalGain,
    totalProceedsQuote: totalProceeds,
    totalCostBasisQuote: totalCost,
    totalUntrackedProceedsQuote: totalUntracked,
    skippedNonStableQuote: skipped,
  };
}

/** RFC-4180-ish CSV: quote fields containing comma/quote/newline,
 *  double embedded quotes. Numbers at full precision (the consumer
 *  rounds; we don't). */
export function gainsToCsv(records: readonly RealizationRecord[]): string {
  const esc = (v: string | number | null): string => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "date", "strategy", "chain", "token", "symbol",
    "amount_sold", "sell_price_quote", "avg_cost_quote",
    "proceeds_quote", "cost_basis_quote", "gain_quote",
    "untracked_amount", "untracked_proceeds_quote", "tx_hash",
  ].join(",");
  const lines = records.map((r) =>
    [
      r.at, r.strategy, r.chain, r.token, r.symbol ?? "",
      r.soldAmount, r.sellPriceQuote, r.avgCostQuote,
      r.proceedsQuote, r.costBasisQuote, r.gainQuote,
      r.untrackedAmount, r.untrackedProceedsQuote, r.txHash ?? "",
    ].map(esc).join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

/** Parse --year N into a [since, until) ISO pair (UTC calendar year). */
export function yearWindow(year: number): { sinceIso: string; untilIso: string } {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ToolError("INVALID_PARAMS", `--year must be a calendar year (got ${year}).`);
  }
  return {
    sinceIso: `${year}-01-01T00:00:00.000Z`,
    untilIso: `${year}-12-31T23:59:59.999Z`,
  };
}
