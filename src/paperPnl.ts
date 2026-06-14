// ──────────────────────────────────────────────────────────────────
// Paper mark-to-market P&L (v27 follow-up): closes the documented
// "REALIZED only" limitation of `paper pnl` / `paper_pnl`.
//
// The realized-only summarizePaperPnl() stays the DEFAULT — it is
// deterministic (pure function of the fill journal), which matters
// for scripted consumers diffing output across runs. MTM is opt-in
// (`--mtm` on the CLI, `mtm: true` over MCP) because pricing open
// positions requires a live oracle call per held token.
//
// Cost-basis model — deliberately the SAME weighted-average model
// as the real-trade pnl.ts aggregateTrades():
//
//   buy:  amount += baseAmt; cost += quoteAmt
//   sell: avgCost = cost / amount
//         sold    = min(baseAmt, amount)        ← capped at tracked
//         realized += (sellPrice − avgCost) × sold
//         amount −= sold; cost −= avgCost × sold
//
// The cap matters more for paper than for real trades: paper books
// are seeded by `paper deposit`, which writes a balance with NO
// journal row — so "sell 1 ETH you deposited but never paper-bought"
// is a routine flow, not an anomaly. The untracked portion of such
// sells realizes NOTHING (we don't know its cost basis) and is
// reported per-position as `untrackedSellBase` / proceeds as
// `untrackedSellQuote` so the operator can see exactly how much of
// their cash flow the cost-basis model could not attribute.
// Deposits are CAPITAL, not P&L — same stance a brokerage statement
// takes.
//
// Quote handling mirrors pnl.ts quoteUsdAtTrade(): only stablecoin-
// quoted fills enter the cost-basis math (quote ≈ USD). Fills with a
// volatile quote (e.g. PEPE/WETH) are counted in fills/buys/sells +
// the legacy cash-flow fields but excluded from cost basis, and
// surfaced via `skippedNonStableQuote`. Pricing volatile quotes at
// trade time would need a historical oracle — out of scope, exactly
// as it is for the real-trade report.
//
// Determinism for tests: the price oracle is an injected callback
// (`fetchPrice`). Production callers use defaultPaperPriceFetcher()
// which prices the native sentinel via the chain's WETH — the same
// convention defaultFetchPaperPortfolio() established for paper
// rebalance plans.
// ──────────────────────────────────────────────────────────────────

import type { Address } from "viem";
import type { PaperTradeRow } from "./db.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { resolveProfile } from "./config.js";
import { summarizePaperPnl, type PaperPnlSummary } from "./paperTrade.js";
import { FLAT_EPSILON, applyBuy, applySell } from "./costBasis.js";
import { isStablecoin } from "./stablecoins.js";

/** Same conservative allow-list as pnl.ts / pairStats.ts / aggregatorStats.ts. */

/** Price oracle callback: USD-per-unit for (chain, token address), or null
 *  when unpriceable. Injected so the cost-basis math stays deterministic
 *  under test. Token may be the native sentinel — the default fetcher
 *  handles that; injected test fetchers see it verbatim. */
export type PaperPriceFetcher = (chain: string, token: string) => Promise<number | null>;

/** One open (or historically traded) per-(chain, base_token) position
 *  inside a strategy bucket. */
export interface PaperPositionEntry {
  chain: string;
  /** base_token address as stored in the fill journal (may be the
   *  native sentinel 0xEeee…). */
  token: string;
  /** Best-effort symbol from the most recent fill that carried one. */
  symbol: string | null;
  /** Net tracked amount still held (base units, decimal). Only fills
   *  that entered the cost-basis math contribute. */
  amount: number;
  /** Weighted-average cost in quote (≈USD) per base unit. 0 when flat. */
  avgCostQuote: number;
  /** Realized P&L attributed to this position (quote ≈ USD). */
  realizedQuote: number;
  /** Current oracle price (USD per unit). null = oracle had no answer —
   *  unrealizedQuote / valueQuote are null too and the bucket's
   *  unpricedPositionCount is bumped. */
  currentPriceQuote: number | null;
  /** amount × (currentPriceQuote − avgCostQuote). null when unpriced. */
  unrealizedQuote: number | null;
  /** amount × currentPriceQuote. null when unpriced. */
  valueQuote: number | null;
  /** Fills that contributed to this position's cost-basis walk. */
  trades: number;
  /** ISO timestamp of the most recent contributing fill. */
  lastTradeAt: string | null;
  /** Base sold WITHOUT a tracked cost basis (deposit-seeded inventory).
   *  Realizes nothing — see module header. */
  untrackedSellBase: number;
  /** Quote received for the untracked portion of sells. Counted in the
   *  legacy quoteReceived cash flow but NOT in realizedQuote. */
  untrackedSellQuote: number;
  /** v65: weighted-average acquisition time (ISO) of the CURRENTLY-held
   *  base — the same v60 blend the realization records use. Null when the
   *  position is flat. Lets consumers derive a holding period + projected
   *  short/long-term tax term for OPEN positions (tax-aware exit timing). */
  acquiredAt: string | null;
}

/** Per-strategy MTM roll-up. SUPERSET of PaperPnlSummary — every legacy
 *  field keeps its exact realized-only semantics (cash-flow sums over
 *  ALL fills), so consumers can switch between the two summaries
 *  without re-mapping. The new fields are additive. */
export interface PaperPnlMtmSummary extends PaperPnlSummary {
  /** Cost-basis realized P&L (quote ≈ USD), summed across positions.
   *  Differs from netQuote: netQuote is raw cash flow (a buy makes it
   *  negative even when the position is up); realizedQuote only books
   *  P&L when a tracked position is reduced. */
  realizedQuote: number;
  /** Sum of priced positions' unrealized P&L. Null only when EVERY
   *  open position is unpriced (no oracle answer at all). */
  unrealizedQuote: number | null;
  /** realizedQuote + (unrealizedQuote ?? 0) — headline total. */
  totalQuote: number;
  /** Sum of priced open positions' current value (USD). */
  openValueQuote: number;
  positions: PaperPositionEntry[];
  /** Open positions the oracle could not price. When > 0, the
   *  unrealized/total numbers are a LOWER-CONFIDENCE partial view. */
  unpricedPositionCount: number;
  /** Fills excluded from cost basis because their quote token is not
   *  a recognized stablecoin (volatile-quote pairs). */
  skippedNonStableQuote: number;
  /** v31: cumulative realized P&L trajectory — one point per
   *  realizing SELL, chronological. Deterministic (pure function of
   *  the fill journal; no marks involved). Answers "is this strategy
   *  improving or bleeding?" — the same +$500 total reads completely
   *  differently as a steady climb vs a spike-and-give-back. */
  realizedTimeline: Array<{ at: string; cumulativeRealizedQuote: number }>;
}

/** v36: one cost-basis realization — emitted per realizing SELL by
 *  the MTM walk. The tax-export building block: weighted-average
 *  cost basis (not FIFO / specific-lot), stablecoin-quote fills
 *  only, gas excluded. Deterministic (no oracle involved). */
export interface RealizationRecord {
  at: string;
  strategy: string;
  chain: string;
  token: string;
  symbol: string | null;
  /** Base sold WITH a tracked cost basis. */
  soldAmount: number;
  /** Sale price per unit (quote/base). */
  sellPriceQuote: number;
  /** Weighted-average cost per unit at the moment of sale. */
  avgCostQuote: number;
  proceedsQuote: number;
  costBasisQuote: number;
  gainQuote: number;
  /** Base sold WITHOUT a tracked basis (oversell of deposit-seeded
   *  inventory / pre-journal holdings). Proceeds excluded from
   *  gainQuote — reported for transparency. */
  untrackedAmount: number;
  untrackedProceedsQuote: number;
  txHash: string | null;
  /** v60: weighted-average acquisition time (ISO) of the basis sold here.
   *  Null when the sale had no tracked basis (pure untracked oversell). */
  acquiredAt: string | null;
  /** v60: sale time − acquiredAt, in days (fractional). Null when no
   *  tracked basis. The holding period for the tracked `soldAmount`. */
  holdingDays: number | null;
  /** v60: 'long' when holdingDays > LONG_TERM_DAYS, 'short' when ≤, and
   *  'untracked' when there's no tracked basis (no acquisition date). */
  term: GainTerm;
}

export interface PaperPnlMtmReport {
  /** ISO timestamp the price marks were fetched — the moment the
   *  unrealized numbers refer to. */
  timestamp: string;
  summaries: PaperPnlMtmSummary[];
  /** v36: every realizing sell across all strategies, chronological. */
  realizations: RealizationRecord[];
}

interface PosAcc {
  chain: string;
  token: string;
  symbol: string | null;
  amount: number;
  cost: number;
  realized: number;
  trades: number;
  lastTradeAt: string | null;
  untrackedSellBase: number;
  untrackedSellQuote: number;
  /** v60: weighted-average acquisition time (epoch ms) of the CURRENTLY
   *  held base — blended by amount on each buy, reset when the position
   *  goes flat. Null until the first buy. Mirrors the weighted-average
   *  cost-basis model: just as there's one blended cost per unit, there's
   *  one blended acquisition date — the principled holding-period estimate
   *  this model can give (it is NOT lot-based FIFO/specific-lot). */
  acquiredAtMs: number | null;
}

/** v60: holding-period threshold (days) above which a realization is
 *  long-term. US long-term capital gains require holding MORE than one
 *  year; 365 is the documented cut (a leap-year sale at exactly 366 days
 *  is unambiguously long, 365 or fewer is short). */
export const LONG_TERM_DAYS = 365;
export type GainTerm = "short" | "long" | "untracked";

/**
 * Compute per-strategy MTM P&L over a set of paper fills.
 *
 * Pure except for the injected `fetchPrice` — pass a stub for
 * deterministic tests, defaultPaperPriceFetcher() in production.
 * Price fetches are memoized per (chain, token) across ALL strategy
 * buckets, so a token held by 5 strategies costs one oracle call.
 *
 * Rows may arrive in any order (listPaperTrades returns newest-first);
 * the walk sorts ascending internally because cost basis is
 * path-dependent.
 */
export async function computePaperPnlMtm(
  rows: readonly PaperTradeRow[],
  fetchPrice: PaperPriceFetcher,
  opts?: { nowIso?: string },
): Promise<PaperPnlMtmReport> {
  // Legacy realized-only buckets first: the MTM summary is a superset and
  // reusing summarizePaperPnl guarantees the shared fields NEVER drift
  // from what the default (non-mtm) surface reports.
  const legacy = summarizePaperPnl(rows);
  const legacyByStrategy = new Map(legacy.map((s) => [s.strategy, s]));

  // Group + chronological sort (timestamp asc, id asc as tiebreaker —
  // ISO strings are lex-comparable in UTC).
  const grouped = new Map<string, PaperTradeRow[]>();
  for (const r of rows) {
    const key = r.strategy ?? "(unattributed)";
    const arr = grouped.get(key) ?? [];
    arr.push(r);
    grouped.set(key, arr);
  }
  for (const arr of grouped.values()) {
    arr.sort((a, b) => (a.timestamp === b.timestamp ? a.id - b.id : a.timestamp < b.timestamp ? -1 : 1));
  }

  // Walk cost basis per strategy bucket.
  const allRealizations: RealizationRecord[] = [];
  const buckets = new Map<string, { positions: Map<string, PosAcc>; skippedNonStableQuote: number; realizedTimeline: Array<{ at: string; cumulativeRealizedQuote: number }> }>();
  for (const [strategy, fills] of grouped) {
    const positions = new Map<string, PosAcc>();
    let skipped = 0;
    let bucketRealized = 0;
    const realizedTimeline: Array<{ at: string; cumulativeRealizedQuote: number }> = [];
    for (const r of fills) {
      if (!isStablecoin(r.quote_symbol)) {
        skipped += 1;
        continue;
      }
      const baseAmt = parseFloat(r.base_amount);
      const quoteAmt = parseFloat(r.quote_amount);
      if (!Number.isFinite(baseAmt) || !Number.isFinite(quoteAmt) || baseAmt <= 0) continue;

      const key = `${r.chain}:${r.base_token.toLowerCase()}`;
      let acc = positions.get(key);
      if (!acc) {
        acc = {
          chain: r.chain,
          token: r.base_token,
          symbol: null,
          amount: 0,
          cost: 0,
          realized: 0,
          trades: 0,
          lastTradeAt: null,
          untrackedSellBase: 0,
          untrackedSellQuote: 0,
          acquiredAtMs: null,
        };
        positions.set(key, acc);
      }
      if (r.base_symbol) acc.symbol = r.base_symbol; // newest-wins (asc walk)
      acc.trades += 1;
      if (!acc.lastTradeAt || r.timestamp > acc.lastTradeAt) acc.lastTradeAt = r.timestamp;

      if (r.direction === "buy") {
        // v60: blend the weighted-average acquisition time by amount.
        // When the position is flat (or first buy), this buy seeds it.
        const buyMs = Date.parse(r.timestamp);
        if (Number.isFinite(buyMs)) {
          if (acc.acquiredAtMs == null || acc.amount <= FLAT_EPSILON) {
            acc.acquiredAtMs = buyMs;
          } else {
            acc.acquiredAtMs = (acc.acquiredAtMs * acc.amount + buyMs * baseAmt) / (acc.amount + baseAmt);
          }
        }
        applyBuy(acc, baseAmt, quoteAmt);
      } else {
        // Reduce via the shared weighted-average reducer (same arithmetic the
        // position-cap enforcer uses — they cannot drift). The returned
        // avgCost/sold/untracked drive realized P&L + the holding period.
        const sellPricePerUnit = quoteAmt / baseAmt;
        const { avgCost, sold, untracked } = applySell(acc, baseAmt);
        const realizedDelta = (sellPricePerUnit - avgCost) * sold;
        acc.realized += realizedDelta;
        // v60: holding period for the TRACKED portion, from the position's
        // weighted-average acquisition date. Null when nothing tracked.
        const hasTracked = sold > FLAT_EPSILON && acc.acquiredAtMs != null;
        const sellMs = Date.parse(r.timestamp);
        const holdingDays =
          hasTracked && Number.isFinite(sellMs)
            ? Math.max(0, (sellMs - acc.acquiredAtMs!) / 86_400_000)
            : null;
        const term: GainTerm =
          holdingDays == null ? "untracked" : holdingDays > LONG_TERM_DAYS ? "long" : "short";
        if (sold > FLAT_EPSILON || untracked > FLAT_EPSILON) {
          allRealizations.push({
            at: r.timestamp,
            strategy,
            chain: r.chain,
            token: r.base_token,
            symbol: r.base_symbol ?? acc.symbol,
            soldAmount: sold > FLAT_EPSILON ? sold : 0,
            sellPriceQuote: sellPricePerUnit,
            avgCostQuote: avgCost,
            proceedsQuote: sold > FLAT_EPSILON ? sellPricePerUnit * sold : 0,
            costBasisQuote: sold > FLAT_EPSILON ? avgCost * sold : 0,
            gainQuote: sold > FLAT_EPSILON ? realizedDelta : 0,
            untrackedAmount: untracked > FLAT_EPSILON ? untracked : 0,
            untrackedProceedsQuote: untracked > FLAT_EPSILON ? sellPricePerUnit * untracked : 0,
            txHash: (r as { tx_hash?: string | null }).tx_hash ?? null,
            acquiredAt: hasTracked ? new Date(acc.acquiredAtMs!).toISOString() : null,
            holdingDays,
            term,
          });
        }
        if (sold > FLAT_EPSILON) {
          bucketRealized += realizedDelta;
          realizedTimeline.push({ at: r.timestamp, cumulativeRealizedQuote: bucketRealized });
        }
        // (acc.amount / acc.cost already mutated by applySell above.)
        if (untracked > FLAT_EPSILON) {
          acc.untrackedSellBase += untracked;
          acc.untrackedSellQuote += sellPricePerUnit * untracked;
        }
      }
    }
    buckets.set(strategy, { positions, skippedNonStableQuote: skipped, realizedTimeline });
  }

  // Mark open positions. Memoize oracle calls per (chain, token) — the
  // same token held by N strategies costs ONE call.
  const priceMemo = new Map<string, number | null>();
  const markPrice = async (chain: string, token: string): Promise<number | null> => {
    const key = `${chain}:${token.toLowerCase()}`;
    if (priceMemo.has(key)) return priceMemo.get(key)!;
    let p: number | null = null;
    try {
      p = await fetchPrice(chain, token);
      if (p != null && (!Number.isFinite(p) || p <= 0)) p = null;
    } catch {
      p = null;
    }
    priceMemo.set(key, p);
    return p;
  };

  const summaries: PaperPnlMtmSummary[] = [];
  for (const [strategy, bucket] of buckets) {
    const legacyBase = legacyByStrategy.get(strategy);
    // Unreachable in practice: every grouped fill also fed summarizePaperPnl.
    if (!legacyBase) continue;

    const positionEntries: PaperPositionEntry[] = [];
    let realizedQuote = 0;
    let unrealizedSum = 0;
    let pricedAny = false;
    let openValueQuote = 0;
    let unpriced = 0;

    for (const acc of bucket.positions.values()) {
      realizedQuote += acc.realized;
      const open = acc.amount > FLAT_EPSILON;
      let currentPriceQuote: number | null = null;
      let unrealizedQuote: number | null = null;
      let valueQuote: number | null = null;
      if (open) {
        currentPriceQuote = await markPrice(acc.chain, acc.token);
        if (currentPriceQuote != null) {
          const avgCost = acc.amount > 0 ? acc.cost / acc.amount : 0;
          unrealizedQuote = acc.amount * (currentPriceQuote - avgCost);
          valueQuote = acc.amount * currentPriceQuote;
          unrealizedSum += unrealizedQuote;
          openValueQuote += valueQuote;
          pricedAny = true;
        } else {
          unpriced += 1;
        }
      }
      positionEntries.push({
        chain: acc.chain,
        token: acc.token,
        symbol: acc.symbol,
        amount: acc.amount,
        avgCostQuote: acc.amount > FLAT_EPSILON ? acc.cost / acc.amount : 0,
        realizedQuote: acc.realized,
        currentPriceQuote,
        unrealizedQuote,
        valueQuote,
        trades: acc.trades,
        lastTradeAt: acc.lastTradeAt,
        untrackedSellBase: acc.untrackedSellBase,
        untrackedSellQuote: acc.untrackedSellQuote,
        acquiredAt: acc.acquiredAtMs != null && acc.amount > FLAT_EPSILON ? new Date(acc.acquiredAtMs).toISOString() : null,
      });
    }

    // Largest open value first; flat positions trail, ordered by realized.
    positionEntries.sort((a, b) => (b.valueQuote ?? 0) - (a.valueQuote ?? 0) || b.realizedQuote - a.realizedQuote);

    const hasOpen = positionEntries.some((p) => p.amount > FLAT_EPSILON);
    const unrealizedQuote = hasOpen ? (pricedAny ? unrealizedSum : null) : 0;
    summaries.push({
      ...legacyBase,
      realizedQuote,
      unrealizedQuote,
      totalQuote: realizedQuote + (unrealizedQuote ?? 0),
      openValueQuote,
      positions: positionEntries,
      unpricedPositionCount: unpriced,
      skippedNonStableQuote: bucket.skippedNonStableQuote,
      realizedTimeline: bucket.realizedTimeline,
    });
  }

  // Same ordering contract as summarizePaperPnl: busiest strategy first.
  summaries.sort((a, b) => b.fills - a.fills);
  allRealizations.sort((a, z) => a.at.localeCompare(z.at));
  return { timestamp: opts?.nowIso ?? new Date().toISOString(), summaries, realizations: allRealizations };
}

/**
 * Production price oracle: prices via getCurrentPrice(), with the native
 * sentinel routed through the chain's canonical WETH — the oracle wants a
 * real ERC20. Identical convention to defaultFetchPaperPortfolio() in
 * rebalance.ts, so a paper rebalance plan and `paper pnl --mtm` mark the
 * same book with the same numbers.
 */
export function defaultPaperPriceFetcher(config: Config, logger: Logger): PaperPriceFetcher {
  return async (chain, token) => {
    const { getCurrentPrice } = await import("./price.js");
    const { isNativeSentinel } = await import("./tokens.js");
    let target = token;
    if (isNativeSentinel(token as Address)) {
      const profile = resolveProfile(chain, config);
      target = profile.weth;
    }
    try {
      return await getCurrentPrice(target, logger);
    } catch (e) {
      logger.debug(`paper mtm: price fetch failed for ${chain}:${target}: ${(e as Error).message}`);
      return null;
    }
  };
}
