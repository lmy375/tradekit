import type { TradeRow } from "./db.js";
import { allTrades } from "./db.js";
import { applyBuy, applySell } from "./costBasis.js";
import { getCurrentPrice } from "./price.js";
import { getBuiltinProfile } from "./chains.js";
import type { Logger } from "./logger.js";
import { formatUsd } from "./holdings.js";

/**
 * Cost-basis & PnL computation, account- and chain-scoped.
 *
 * Approach (weighted-average cost basis per token symbol):
 *   - When a "buy" closes (i.e. quote → base), the base token's average cost goes up by
 *     (quote_amount_usd / base_amount).
 *   - When a "sell" closes (base → quote), the realized PnL is
 *     base_amount_sold * (sell_price_usd - avg_cost_usd).
 *
 * USD is computed using the trade-record price (which is quote_per_base) plus the current
 * USD price of the QUOTE token; this is the best we can do without historical quote-USD prices.
 * For USD-pegged quote tokens (USDC, USDT, DAI) this gives near-exact results.
 *
 * Gas spend is summed in native token units per chain (separate report).
 */

export interface TokenPosition {
  chain: string;
  symbol: string;
  token: string; // address
  /** Net amount held (decimal string). */
  amount: string;
  /** Average USD cost basis per unit. */
  avgCostUsd: number;
  /** Realized PnL in USD so far. */
  realizedUsd: number;
  /** Current USD price (best-effort). */
  currentPriceUsd?: number;
  /** Unrealized PnL = amount * (currentPriceUsd - avgCostUsd). */
  unrealizedUsd?: number;
  /** Number of trades that contributed. */
  trades: number;
  /** Iter706: ISO timestamp of the most-recent trade contributing to this
   *  position. Distinguishes active holdings from dust positions an
   *  operator has forgotten. Absent only when no trades contributed (i.e.,
   *  position never existed — unreachable in practice). */
  lastTradeAt?: string;
}

export interface GasSpend {
  chain: string;
  /** Native asset units spent on gas (decimal string). */
  amount: string;
  /** USD equivalent at current native price (best-effort). */
  usd?: number;
}

/**
 * Iter627: cross-chain symbol roll-up. PnLReport.positions is keyed by
 * (chain, symbol) so an operator with ETH on base + arbitrum + optimism sees
 * three separate rows. byTokenSymbol[] collapses those into ONE row per
 * symbol, summing amounts/realized/unrealized across chains.
 *
 * Why this matters: multi-chain operators almost always think about their
 * positions at the SYMBOL level ("how much ETH do I have total?"). The per-
 * chain breakdown still ships in positions[] for operators who care about
 * chain-level detail (gas reserves, bridge-cost accounting). The roll-up is
 * the higher-level view.
 *
 * Notes on the math:
 *   - amount: sum of all positions[].amount with the SAME symbol. For
 *     fungible-by-symbol tokens (ETH, USDC) this is the operator's true
 *     total holding. For tokens whose symbol happens to clash across chains
 *     but represents different underlying assets (rare; e.g. wrapped/proxy
 *     forks), this can be misleading — caller can branch on perChain[].
 *   - avgCostUsd: weighted by amount, summed across chains, then divided by
 *     total amount. Falls back to 0 when total amount is 0.
 *   - realizedUsd: pure sum (additive — realized gains compound across chains).
 *   - unrealizedUsd: sum where present; chains without a price oracle
 *     contribute zero (callers can detect via `unpricedChainCount`).
 *   - currentPriceUsd: omitted from the rollup since prices CAN differ per
 *     chain (same symbol, different pool depth → different DEX price). The
 *     operator who needs cross-chain price arbitrage detection should look at
 *     positions[] directly.
 */
export interface TokenSymbolRollup {
  symbol: string;
  /** Sum of amounts across chains (decimal string, 8 decimals). */
  amount: string;
  /** Weighted-average cost basis in USD per unit. Zero when total amount is 0. */
  avgCostUsd: number;
  /** Sum of realized PnL across chains (USD). Realized gains/losses are
   *  additive — closing a position on chain A and another on chain B has
   *  the same net effect as closing both on chain A. */
  realizedUsd: number;
  /** Sum of unrealized PnL where the per-chain unrealized was populated.
   *  Chains without a current price oracle contribute zero — see
   *  `unpricedChainCount`. */
  unrealizedUsd: number;
  /** Total realized + unrealized for this symbol (USD). */
  totalUsd: number;
  /** How many per-chain positions contributed to this rollup. */
  chains: string[];
  /** How many of the contributing chains had no current-price oracle. When
   *  > 0, unrealizedUsd is a LOWER BOUND — the unpriced chains' positions
   *  still exist but contribute 0 to the unrealized total. */
  unpricedChainCount: number;
  /** Sum of trades across all contributing chains. */
  trades: number;
  /** Iter707: MAX of contributing chains' lastTradeAt — when did this
   *  symbol last trade on ANY chain? Absent only when none of the rolled-up
   *  positions had a lastTradeAt. */
  lastTradeAt?: string;
}

export interface PnLReport {
  account: string;
  chain?: string;
  /** ISO timestamp when this PnL snapshot was generated — captures the moment the
   *  current-price marks were fetched, which is what drives the unrealized number. */
  timestamp: string;
  /** Iter727: wall-clock ms for the compute (includes per-token price fan-out
   *  and gas-oracle lookups). Same shape as iter724/725/726 elapsedMs on the
   *  reconcile reports — scripted consumers track PnL compute cost over
   *  time, detect RPC degradation, alert on slow runs. */
  elapsedMs?: number;
  positions: TokenPosition[];
  gas: GasSpend[];
  totalRealizedUsd: number;
  totalUnrealizedUsd: number;
  /** Sum of gas costs across all chains in USD. */
  totalGasUsd: number;
  /** Realized PnL minus total gas (USD). The number that actually matters for accounting. */
  totalRealizedAfterGasUsd: number;
  /**
   * Iter615: per-window realized + gas breakdown. Each entry corresponds to a
   * window the caller passed to computePnL. Unrealized doesn't appear here
   * because unrealized is "current state" — it doesn't have a meaningful
   * historical attribution per window (the position either still exists right
   * now, or it doesn't).
   *
   * Use case: tax-quarter reporting ("Q1 realized: $X, Q2 realized: $Y"),
   * strategy attribution ("last 7 days realized: $Z"), comparative dashboards.
   */
  windows?: PnLWindowSummary[];
  /**
   * Iter627: cross-chain symbol roll-up. Populated by computePnL (always
   * present in real reports, empty array when no positions). Optional on the
   * type so legacy synthetic PnLReports (e.g. the adapter in health.ts that
   * converts MultiAccountPnLReport into a PnLReport-shaped object for the
   * section builder) don't have to manufacture it. One entry per UNIQUE
   * symbol across all contributing chains. Sorted by totalUsd descending —
   * biggest position by combined value first.
   */
  byTokenSymbol?: TokenSymbolRollup[];
  /**
   * Iter636: per-aggregator realized USD breakdown. Cross-cuts iter623's
   * slippage stats (per-aggregator quality) with iter615 realized (per-trade
   * outcomes). Answers "which aggregator made me the most money in net
   * realized USD?" — DIFFERENT signal than slippage. A consistently-tight
   * aggregator can still be losing money if its routes consistently move
   * the market AGAINST the operator's position before fills. realizedUsd
   * captures the bottom-line outcome.
   *
   * Sorted by realizedUsd descending — biggest earner first. tradeCount is
   * total trades (buys + sells) routed via this aggregator; only sells
   * contribute to realizedUsd (consistent with cost-basis math).
   *
   * Buys-only aggregators (never sold via them) show realizedUsd=0 +
   * tradeCount=N — honest signal that the data isn't yet conclusive.
   */
  byAggregator?: Array<{ aggregator: string; realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
  /**
   * Iter639: per-pair realized USD breakdown. Pair canonicalized as iter634's
   * "BASE/QUOTE" key (lexicographic sort + uppercase). Cross-cut with
   * byTokenSymbol: a single trade contributes to BOTH ETH's symbol-level
   * realized AND the ETH/USDC pair-level realized. Use pair view when
   * strategy detail matters (ETH/USDC vs ETH/PEPE behave very differently
   * even though both contribute to "ETH realized"). Sorted by realizedUsd
   * desc — biggest winner first.
   * Iter708: each entry carries lastTradeAt (MAX timestamp per bucket).
   */
  byPair?: Array<{ pair: string; realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
  /**
   * Iter649: per-strategy realized USD breakdown. Operators running multiple
   * strategies on the same wallet (DCA + swing + manual arb) see WHICH
   * strategy is performing — the 4th axis after symbol / aggregator / pair.
   * NULL strategy rows bucket into "(none)" so untagged volume is honest.
   * Sorted by realizedUsd desc.
   * Iter708: each entry carries lastTradeAt (MAX timestamp per bucket).
   */
  byStrategy?: Array<{ strategy: string; realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
  /**
   * Iter745: count of trades that fed into this report (before windowing).
   * Surfaced so the formatter can distinguish "operator with real activity
   * but currently flat" (tradeCount>0, positions=[]) from "fresh operator
   * with literally no trades yet" (tradeCount=0). The latter gets a friendly
   * onboarding hint nudging them to `tradekit trades sync`; the former gets
   * the existing empty-positions message unchanged. JSON consumers can read
   * the count directly for similar branching.
   */
  tradeCount?: number;
  /**
   * Iter765: ISO timestamp of the earliest trade row that fed into this
   * report. Lets operators (and agents) read "how long has this account
   * been active" off the report directly, instead of inspecting the
   * positions table or per-window summaries. Absent when tradeCount === 0
   * (no rows → no earliest). Same data shape as iter735
   * accountActivitySummary's firstTradeAt — operators learn one field name.
   */
  firstTradeAt?: string;
  /**
   * Iter768: ISO timestamp of the latest trade row that fed into this
   * report. Symmetric counterpart to firstTradeAt — together they describe
   * the full activity span. Useful for distinguishing "currently active"
   * accounts (latestTradeAt recent) from "dormant since N days ago"
   * accounts (latestTradeAt old). Absent when tradeCount === 0.
   */
  latestTradeAt?: string;
  /**
   * Iter741: data-freshness warning. PnL numbers depend on the local trades DB
   * being a faithful mirror of on-chain reality. When a sync bookmark
   * (iter737) for this (chain, account) hasn't moved in >PNL_STALE_BOOKMARK_HOURS,
   * the PnL may be silently missing trades that happened since — and the
   * operator should know before trusting the totals.
   *
   * Populated only when MATCHING bookmarks exist AND at least one is stale.
   * Absent means EITHER: no bookmarks (operator uses import_trade workflow —
   * not a sync regression) OR all bookmarks are fresh. Multiple matching
   * bookmarks (e.g. multi-chain PnL for one account) each get their own entry
   * so the warning is granular.
   */
  dataFreshness?: {
    /** Threshold used to flag staleness; included for consumers building
     *  custom alerting (e.g. "warn at 24h instead of 48h"). */
    staleAfterHours: number;
    staleBookmarks: Array<{ chain: string; account: string; owner: string; ageHours: number; lastSyncedBlock: string }>;
  };
  /** Iter818: worst-bucket severity derived from dataFreshness. "warn" when
   *  any stale bookmark detected (PnL numbers may be misleading); "ok"
   *  otherwise. Always present. Symmetric with iter786/787/788/801/803-807
   *  severity fields across other report types — dashboards branch on one
   *  field everywhere. */
  severity: "ok" | "warn";
  /** Iter830: structured next-action dispatch list. One entry per stale
   *  bookmark — agents dispatch `trades_sync` for the specific chain+account
   *  combo without parsing the iter741 advisory prose. Always present
   *  (empty array when no stale data). Symmetric with iter829 tokenInfo +
   *  iter686 trade recentFailurePattern.suggestedActions. */
  recommendedActions: import("./errors.js").NextAction[];
}

/** Iter741: hours past which a sync bookmark is considered stale enough to
 *  warn against trusting derived PnL. 48h is a forgiving threshold — most
 *  production crons run daily but operator schedules sometimes skip a day
 *  (machine reboot, scheduler maintenance). 48h catches "cron broken" without
 *  false-flagging "ran a day late". Exported so other report layers (multi-
 *  account, health) can use the same constant. */
export const PNL_STALE_BOOKMARK_HOURS = 48;

/**
 * Iter741: pure helper computing stale-bookmark entries for a (chain?, account)
 * scope. Returns [] when no bookmarks match or all are fresh. Exposed so the
 * multi-account aggregator and unit tests can share it.
 */
export function computeStaleBookmarkEntries(args: {
  account: string;
  chain?: string;
  bookmarks: ReadonlyArray<{ chain: string; account: string; owner: string; lastSyncedBlock: bigint; updatedAt: string }>;
  nowMs?: number;
  staleAfterHours?: number;
}): Array<{ chain: string; account: string; owner: string; ageHours: number; lastSyncedBlock: string }> {
  const now = args.nowMs ?? Date.now();
  const threshold = args.staleAfterHours ?? PNL_STALE_BOOKMARK_HOURS;
  const thresholdMs = threshold * 3_600_000;
  const out: Array<{ chain: string; account: string; owner: string; ageHours: number; lastSyncedBlock: string }> = [];
  for (const b of args.bookmarks) {
    if (b.account !== args.account) continue;
    if (args.chain && b.chain !== args.chain) continue;
    const ageMs = now - new Date(b.updatedAt).getTime();
    if (ageMs <= thresholdMs) continue;
    out.push({
      chain: b.chain,
      account: b.account,
      owner: b.owner,
      ageHours: ageMs / 3_600_000,
      lastSyncedBlock: b.lastSyncedBlock.toString(),
    });
  }
  return out;
}

/** Iter615: per-window summary. */
export interface PnLWindowSummary {
  label?: string;
  since?: string;
  until?: string;
  realizedUsd: number;
  /** Native gas spend per chain, aggregated for this window's trade timestamps. */
  gasNativePerChain: Array<{ chain: string; amount: string; usd?: number }>;
  /** Total USD gas for this window (where chain native prices are available). */
  totalGasUsd: number;
  /** Net = realized - gas. */
  realizedAfterGasUsd: number;
  /**
   * Per-position realized breakdown for this window — symbol + chain + amount.
   * Empty array when no realized gains occurred in this window.
   */
  positions: Array<{ symbol: string; chain: string; token: string; realizedUsd: number }>;
}

export interface Acc {
  symbol: string;
  token: string;
  chain: string;
  amount: number;
  cost: number; // total USD cost basis (running)
  realized: number;
  trades: number;
  /** Iter615: per-window realized — same indexes as the windows array passed
   *  to aggregateTrades. Only populated when the caller passed windows. */
  realizedPerWindow?: number[];
  /** Iter706: MAX(timestamp) across rows contributing to this position. */
  lastTradeAt?: string;
}

/**
 * Iter615: a time window for windowed-realized attribution. Half-open by
 * convention: `since <= timestamp < until`. Either endpoint can be undefined
 * (open-ended window).
 */
export interface PnLWindow {
  /** ISO timestamp lower bound (inclusive). Undefined = no lower bound. */
  since?: string;
  /** ISO timestamp upper bound (exclusive). Undefined = no upper bound. */
  until?: string;
  /** Human-readable label for display ("7d", "Q1-2026", "all-time"). */
  label?: string;
}

/**
 * Iter615: check whether a trade row's timestamp falls inside a window.
 * Pure — exported for unit testing.
 */
export function isInWindow(timestamp: string, window: PnLWindow): boolean {
  if (window.since && timestamp < window.since) return false;
  if (window.until && timestamp >= window.until) return false;
  return true;
}

function isStablecoin(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return /^(USDC|USDT|DAI|BUSD|FRAX|USDP|TUSD|USDC\.e)$/i.test(symbol);
}

/**
 * Iter639: canonical pair key for PnL bucketing. Same semantics as
 * pairStats.ts's canonicalPairKey — lexicographic + uppercase + "(unknown)"
 * sentinel — but duplicated here to avoid a cross-import (pairStats imports
 * from pnl via TradeRow; circular if pnl imports from pairStats). The
 * sentinel + sort rules are stable enough that duplication is safe.
 */
function canonicalPnLPairKey(baseSymbol: string | null | undefined, quoteSymbol: string | null | undefined): string {
  const norm = (s: string | null | undefined): string => (s == null ? "(unknown)" : s.toUpperCase());
  const b = norm(baseSymbol);
  const q = norm(quoteSymbol);
  return b < q ? `${b}/${q}` : `${q}/${b}`;
}

/**
 * Iter627: roll up per-chain positions into one entry per symbol. Pure — no
 * I/O. Sorted by totalUsd (realized + unrealized) descending so the biggest
 * combined-value position lands first.
 *
 * Exported for unit testing the math without touching computePnL's HTTP
 * stack. computePnL calls this internally; downstream consumers that just
 * want the rollup can call this directly with an already-computed positions
 * list.
 *
 * Symbol matching is case-insensitive — operators with custom token configs
 * sometimes register the SAME symbol with different casing across chains
 * (e.g. "Pepe" on base, "PEPE" on arb). We treat those as one symbol;
 * fold the rollup's display symbol to uppercase.
 */
export function rollupPositionsBySymbol(positions: readonly TokenPosition[]): TokenSymbolRollup[] {
  const buckets = new Map<string, TokenSymbolRollup>();

  for (const p of positions) {
    const key = p.symbol.toUpperCase();
    const amount = parseFloat(p.amount) || 0;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        symbol: key,
        amount: amount.toFixed(8),
        // Initial avgCost is the chain's avgCost; if more chains contribute,
        // we re-weight below. Storing the running weighted-cost numerator
        // (amount × avgCost) in avgCostUsd as a working value; divided by
        // total amount at the end.
        avgCostUsd: amount * p.avgCostUsd,
        realizedUsd: p.realizedUsd,
        unrealizedUsd: p.unrealizedUsd ?? 0,
        totalUsd: 0, // computed at the end
        chains: [p.chain],
        unpricedChainCount: p.currentPriceUsd == null ? 1 : 0,
        trades: p.trades,
        // Iter707: seed lastTradeAt from this chain's position.
        ...(p.lastTradeAt ? { lastTradeAt: p.lastTradeAt } : {}),
      });
    } else {
      const currentTotalAmount = (parseFloat(existing.amount) || 0) + amount;
      // Running weighted-cost numerator.
      existing.avgCostUsd += amount * p.avgCostUsd;
      existing.realizedUsd += p.realizedUsd;
      existing.unrealizedUsd += p.unrealizedUsd ?? 0;
      existing.amount = currentTotalAmount.toFixed(8);
      if (!existing.chains.includes(p.chain)) existing.chains.push(p.chain);
      if (p.currentPriceUsd == null) existing.unpricedChainCount += 1;
      existing.trades += p.trades;
      // Iter707: take MAX across contributing chains.
      if (p.lastTradeAt && (!existing.lastTradeAt || p.lastTradeAt > existing.lastTradeAt)) {
        existing.lastTradeAt = p.lastTradeAt;
      }
    }
  }

  // Finalize: divide weighted-cost numerator by total amount. Compute totalUsd.
  for (const r of buckets.values()) {
    const totalAmount = parseFloat(r.amount) || 0;
    r.avgCostUsd = totalAmount > 0 ? r.avgCostUsd / totalAmount : 0;
    r.totalUsd = r.realizedUsd + r.unrealizedUsd;
  }

  return [...buckets.values()].sort((a, b) => b.totalUsd - a.totalUsd);
}

/**
 * Estimate USD per-unit of the quote token at trade time.
 * Returns 1 for stablecoins; otherwise null (best-effort live price lookups happen later
 * in `computePnL` for the overall valuation — historical quote price is approximated by 1
 * for stables and by quote's current USD price for non-stable quotes).
 */
function quoteUsdAtTrade(row: TradeRow): number | null {
  if (isStablecoin(row.quote_symbol)) return 1;
  return null;
}

/**
 * Pure: aggregate a set of trades into per-token positions + gas spend.
 *
 * Extracted from computePnL so the weighted-average-cost-basis math can be unit-tested
 * without touching SQLite or hitting price APIs. The async wrapper below just resolves
 * USD prices and then delegates here.
 *
 * `quoteUsd(row)` returns USD-per-unit of the row's quote token at trade time, or null
 * to skip the trade. Stablecoin rows pass `1`; non-stable quote rows pass a live price.
 */
export function aggregateTrades(
  rows: readonly TradeRow[],
  quoteUsd: (row: TradeRow) => number | null,
  /**
   * Iter615: optional windows for time-windowed realized + gas attribution.
   * Cost basis is path-dependent — windows DON'T filter the input. They only
   * filter the OUTPUT attribution: a sell's realized gain is added to a
   * window's bucket iff its timestamp falls in that window. The full per-row
   * chronological processing still happens, so a sale that closes a position
   * opened months earlier correctly attributes its full realized to the sale's
   * window.
   *
   * When this parameter is omitted (or empty), `realizedPerWindow` / `gasSpendPerWindow`
   * stay undefined and behavior matches the pre-iter615 contract exactly.
   */
  windows?: readonly PnLWindow[],
): {
  positions: Map<string, Acc>;
  gasSpend: Map<string, number>;
  /** Iter646: per-chain sum of `gas_cost_usd_at_trade` for rows that stored
   *  it. Computer uses this directly (historically accurate); legacy rows
   *  whose gas_cost_usd_at_trade IS NULL fall back to native × current price.
   *  To avoid double-counting, gasSpend (native) for rows that have stored
   *  USD is EXCLUDED from the native-fallback math at the computer. */
  gasSpendUsdStored: Map<string, number>;
  /** Iter646: per-chain native gas SUM for rows WITHOUT stored USD. These
   *  are the legacy rows where the computer must multiply by current native
   *  price as a fallback. Distinct from `gasSpend` which is the total
   *  including stored-USD rows. */
  gasSpendNativeUnstored: Map<string, number>;
  /** Iter615: parallel-indexed with `windows`. gasSpendPerWindow[i] is a per-
   *  chain map for window[i]. Empty maps when no windows or no gas in window. */
  gasSpendPerWindow?: Array<Map<string, number>>;
  /** Iter647: per-window split for historically-accurate gas USD math.
   *  Parallel-indexed with `windows`. Same contract as the main-path
   *  gasSpendUsdStored / gasSpendNativeUnstored from iter646. */
  gasSpendUsdStoredPerWindow?: Array<Map<string, number>>;
  gasSpendNativeUnstoredPerWindow?: Array<Map<string, number>>;
  /** Iter636: per-aggregator realized USD + trade count. Keys are the row's
   *  aggregator string (e.g. "kyberswap", "openocean"); transfers are
   *  excluded (same as in cost-basis math). Buys contribute to tradeCount
   *  but not realized (realization happens on sells).
   *  Iter708: lastTradeAt = MAX(timestamp) per aggregator bucket. */
  realizedByAggregator: Map<string, { realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
  /** Iter639: per-pair realized USD + trade count. Keys are the canonical
   *  pair from iter634 (e.g. "ETH/USDC", lexicographically sorted). Cross-
   *  cuts iter627 (per-token-symbol) — same trade contributes to ETH's symbol-
   *  level AND to ETH/USDC's pair-level. Pair-level surfaces strategy detail
   *  (ETH/USDC stable-paired vs ETH/PEPE volatile-paired tell different
   *  stories the symbol-level view collapses).
   *  Iter708: lastTradeAt = MAX(timestamp) per pair bucket. */
  realizedByPair: Map<string, { realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
  /** Iter649: per-strategy realized USD + trade count. NULL strategy rows
   *  bucket into "(none)" so operators see what's tagged vs untagged. Same
   *  4th-axis cross-cut as iter636/iter639 — answers "how is my DCA strategy
   *  performing vs untagged manual trades?".
   *  Iter708: lastTradeAt = MAX(timestamp) per strategy bucket. */
  realizedByStrategy: Map<string, { realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
} {
  const positions = new Map<string, Acc>();
  const gasSpend = new Map<string, number>();
  const gasSpendUsdStored = new Map<string, number>();
  const gasSpendNativeUnstored = new Map<string, number>();
  const realizedByAggregator = new Map<string, { realizedUsd: number; tradeCount: number; lastTradeAt?: string }>();
  const realizedByPair = new Map<string, { realizedUsd: number; tradeCount: number; lastTradeAt?: string }>();
  const realizedByStrategy = new Map<string, { realizedUsd: number; tradeCount: number; lastTradeAt?: string }>();
  const hasWindows = windows && windows.length > 0;
  const gasSpendPerWindow: Array<Map<string, number>> = hasWindows
    ? windows!.map(() => new Map<string, number>())
    : [];
  // Iter647: per-window stored/unstored split, parallel-indexed with windows.
  const gasSpendUsdStoredPerWindow: Array<Map<string, number>> = hasWindows
    ? windows!.map(() => new Map<string, number>())
    : [];
  const gasSpendNativeUnstoredPerWindow: Array<Map<string, number>> = hasWindows
    ? windows!.map(() => new Map<string, number>())
    : [];

  for (const row of rows) {
    // Gas accounting comes BEFORE the success/transfer skips. Gas is paid even on a
    // reverted trade (the EVM charges the included tx gas regardless of revert), and
    // transfers cost real gas too — pre-iter126 the report's "Gas paid (USD)" was
    // sometimes wildly low for accounts with many failed swaps or heavy transfer
    // activity. The cost-basis math below stays scoped to successful swaps only.
    if (row.gas_cost_native) {
      const g = parseFloat(row.gas_cost_native);
      if (Number.isFinite(g)) {
        gasSpend.set(row.chain, (gasSpend.get(row.chain) ?? 0) + g);
        // Iter646: split the native total into stored-USD vs unstored buckets.
        // Stored-USD rows get their PRE-COMPUTED USD value summed into
        // gasSpendUsdStored; unstored rows go into the native-only bucket
        // for the legacy native × current-price fallback path. This avoids
        // double-counting when the PnL computer combines the two.
        const storedUsd = row.gas_cost_usd_at_trade;
        const hasStoredUsd = storedUsd != null && Number.isFinite(storedUsd);
        if (hasStoredUsd) {
          gasSpendUsdStored.set(row.chain, (gasSpendUsdStored.get(row.chain) ?? 0) + storedUsd);
        } else {
          gasSpendNativeUnstored.set(row.chain, (gasSpendNativeUnstored.get(row.chain) ?? 0) + g);
        }
        if (hasWindows) {
          for (let i = 0; i < windows!.length; i++) {
            if (isInWindow(row.timestamp, windows![i])) {
              const m = gasSpendPerWindow[i];
              m.set(row.chain, (m.get(row.chain) ?? 0) + g);
              // Iter647: same stored/unstored split per window.
              if (hasStoredUsd) {
                const ms = gasSpendUsdStoredPerWindow[i];
                ms.set(row.chain, (ms.get(row.chain) ?? 0) + (storedUsd as number));
              } else {
                const mu = gasSpendNativeUnstoredPerWindow[i];
                mu.set(row.chain, (mu.get(row.chain) ?? 0) + g);
              }
            }
          }
        }
      }
    }

    if (row.status !== "success") continue;
    // Transfers are persisted in the trades table so dailyUsdVolume can include them
    // for safety budgeting, but they are NOT swaps — including them in cost basis would
    // produce nonsense PnL (a "sell" of USDC with no actual quote).
    if (row.aggregator === "transfer") continue;

    const baseAmt = parseFloat(row.base_amount) || 0;
    const quoteAmt = parseFloat(row.quote_amount) || 0;
    const qUsd = quoteUsd(row);
    if (baseAmt <= 0 || quoteAmt <= 0 || qUsd == null) continue;

    const tradeUsd = quoteAmt * qUsd;
    const key = `${row.chain}:${(row.base_symbol ?? row.base_token).toUpperCase()}`;
    let acc = positions.get(key);
    if (!acc) {
      acc = {
        symbol: row.base_symbol ?? row.base_token.slice(0, 8),
        token: row.base_token,
        chain: row.chain,
        amount: 0,
        cost: 0,
        realized: 0,
        trades: 0,
        ...(hasWindows ? { realizedPerWindow: windows!.map(() => 0) } : {}),
      };
      positions.set(key, acc);
    }
    acc.trades += 1;
    // Iter706: track the most-recent contributing-row timestamp. ISO strings
    // are lex-comparable in UTC.
    if (!acc.lastTradeAt || row.timestamp > acc.lastTradeAt) {
      acc.lastTradeAt = row.timestamp;
    }

    // Iter636: bucket realized + trade count by aggregator. The aggregator
    // field is set on every trade row (defaults to "unknown" via the bucket
    // shape — same fallback aggregatorStats.ts uses).
    const aggKey = row.aggregator?.trim() || "unknown";
    let aggBucket = realizedByAggregator.get(aggKey);
    if (!aggBucket) {
      aggBucket = { realizedUsd: 0, tradeCount: 0 };
      realizedByAggregator.set(aggKey, aggBucket);
    }
    aggBucket.tradeCount += 1;
    // Iter708: track MAX(timestamp) per aggregator bucket.
    if (!aggBucket.lastTradeAt || row.timestamp > aggBucket.lastTradeAt) {
      aggBucket.lastTradeAt = row.timestamp;
    }

    // Iter639: bucket realized + trade count by canonical pair (same key
    // shape as iter634 pairStats: "BASE/QUOTE" lexicographically sorted +
    // uppercased; "(unknown)" sentinel for missing symbols).
    const pairKey = canonicalPnLPairKey(row.base_symbol, row.quote_symbol);
    let pairBucket = realizedByPair.get(pairKey);
    if (!pairBucket) {
      pairBucket = { realizedUsd: 0, tradeCount: 0 };
      realizedByPair.set(pairKey, pairBucket);
    }
    pairBucket.tradeCount += 1;
    // Iter708: track MAX(timestamp) per pair bucket.
    if (!pairBucket.lastTradeAt || row.timestamp > pairBucket.lastTradeAt) {
      pairBucket.lastTradeAt = row.timestamp;
    }

    // Iter649: bucket realized + trade count by strategy tag. NULL → "(none)"
    // so operators see what's untagged. Same trim-then-fallback pattern as
    // iter636 aggregator bucketing.
    const stratKey = row.strategy?.trim() || "(none)";
    let stratBucket = realizedByStrategy.get(stratKey);
    if (!stratBucket) {
      stratBucket = { realizedUsd: 0, tradeCount: 0 };
      realizedByStrategy.set(stratKey, stratBucket);
    }
    stratBucket.tradeCount += 1;
    // Iter708: track MAX(timestamp) per strategy bucket.
    if (!stratBucket.lastTradeAt || row.timestamp > stratBucket.lastTradeAt) {
      stratBucket.lastTradeAt = row.timestamp;
    }

    if (row.direction === "buy") {
      // Acquire baseAmt at avg cost tradeUsd/baseAmt — via the shared reducer
      // (v82: the same cost-basis core the MTM walker / position caps / tax
      // export use, so the headline real-money PnL can't drift from them).
      applyBuy(acc, baseAmt, tradeUsd);
    } else {
      // Sell baseAmt at price (tradeUsd/baseAmt). Realize PnL against avg cost.
      // applySell caps the sale at the open position + mutates acc.amount/cost;
      // the returned avgCost/sold drive the realized attribution below.
      const sellPricePerUnit = tradeUsd / baseAmt;
      const { avgCost, sold } = applySell(acc, baseAmt);
      const realizedForThisSale = (sellPricePerUnit - avgCost) * sold;
      acc.realized += realizedForThisSale;
      // Iter636: also attribute realized to the executing aggregator.
      aggBucket.realizedUsd += realizedForThisSale;
      // Iter639: also attribute realized to the canonical pair.
      pairBucket.realizedUsd += realizedForThisSale;
      // Iter649: also attribute realized to the strategy tag.
      stratBucket.realizedUsd += realizedForThisSale;
      // Iter615: attribute the realized to any window whose range covers this trade's
      // timestamp. A sale's full realized gain goes into the window — we don't pro-rate
      // by holding period because that would require FIFO lot tracking which iter615
      // doesn't introduce. The weighted-average model attributes the entire gain at
      // the moment of sale.
      if (hasWindows && acc.realizedPerWindow) {
        for (let i = 0; i < windows!.length; i++) {
          if (isInWindow(row.timestamp, windows![i])) {
            acc.realizedPerWindow[i] += realizedForThisSale;
          }
        }
      }
      // (acc.amount / acc.cost already reduced by applySell above.)
    }
  }

  return hasWindows
    ? {
        positions,
        gasSpend,
        gasSpendUsdStored,
        gasSpendNativeUnstored,
        gasSpendPerWindow,
        gasSpendUsdStoredPerWindow,
        gasSpendNativeUnstoredPerWindow,
        realizedByAggregator,
        realizedByPair,
        realizedByStrategy,
      }
    : {
        positions,
        gasSpend,
        gasSpendUsdStored,
        gasSpendNativeUnstored,
        realizedByAggregator,
        realizedByPair,
        realizedByStrategy,
      };
}

export async function computePnL(
  account: string,
  opts: { chain?: string; windows?: readonly PnLWindow[]; strategy?: string },
  logger: Logger,
): Promise<PnLReport> {
  // Iter727: wall-clock timing — captures the full compute including
  // per-token price fan-out + gas oracle lookups.
  const t0 = Date.now();
  // Iter648: strategy filter — when set, computePnL scopes to trades tagged
  // with this strategy. Cost-basis is still path-correct WITHIN the filter
  // (sells without prior buys in the same strategy show as pure realized).
  const rows = allTrades({ chain: opts.chain, account, strategy: opts.strategy });

  // Pre-fetch current USD price for every non-stable quote token in parallel — these
  // are independent network calls, so serializing them turned PnL into an O(N) wait.
  const nonStableQuotes = Array.from(
    new Set(rows.filter((r) => !isStablecoin(r.quote_symbol)).map((r) => r.quote_token)),
  );
  const quoteUsdLive = new Map<string, number | null>(
    await Promise.all(
      nonStableQuotes.map(
        async (addr) => [addr, await getCurrentPrice(addr, logger).catch(() => null)] as const,
      ),
    ),
  );

  const aggregated = aggregateTrades(
    rows,
    (row) => quoteUsdAtTrade(row) ?? quoteUsdLive.get(row.quote_token) ?? null,
    opts.windows,
  );
  const { positions, gasSpend, gasSpendUsdStored, gasSpendNativeUnstored, realizedByAggregator, realizedByPair, realizedByStrategy } = aggregated;
  const gasSpendPerWindow = aggregated.gasSpendPerWindow;
  const gasSpendUsdStoredPerWindow = aggregated.gasSpendUsdStoredPerWindow;
  const gasSpendNativeUnstoredPerWindow = aggregated.gasSpendNativeUnstoredPerWindow;

  // Gas-token price proxy: use each chain profile's wrapped-native address (WETH/WBNB/
  // WPOL). DexScreener tracks the wrapped form on every supported chain, and pulling
  // from the chain registry instead of a duplicated map means a future chain addition
  // — or a user's custom override — is automatically picked up without code change.

  // Fetch current prices for every position token + every chain's native token in one
  // parallel batch. The 60s price cache (price.ts) makes the duplicate keys cheap.
  const positionList = [...positions.values()];
  const positionPricesP = Promise.all(
    positionList.map((acc) => getCurrentPrice(acc.token, logger).catch(() => null)),
  );
  const gasChains = [...gasSpend.entries()];
  const gasPricesP = Promise.all(
    gasChains.map(([chain]) => {
      const profile = getBuiltinProfile(chain);
      return profile ? getCurrentPrice(profile.weth, logger).catch(() => null) : Promise.resolve(null);
    }),
  );
  const [positionPrices, gasPrices] = await Promise.all([positionPricesP, gasPricesP]);

  const positionsOut: TokenPosition[] = [];
  let totalRealized = 0;
  let totalUnrealized = 0;
  positionList.forEach((acc, i) => {
    const currentPriceUsd = positionPrices[i] ?? undefined;
    const avgCostUsd = acc.amount > 0 ? acc.cost / acc.amount : 0;
    let unrealizedUsd: number | undefined;
    if (currentPriceUsd != null && acc.amount > 0) {
      unrealizedUsd = acc.amount * (currentPriceUsd - avgCostUsd);
      totalUnrealized += unrealizedUsd;
    }
    totalRealized += acc.realized;
    positionsOut.push({
      chain: acc.chain,
      symbol: acc.symbol,
      token: acc.token,
      amount: acc.amount.toFixed(8),
      avgCostUsd,
      realizedUsd: acc.realized,
      currentPriceUsd,
      unrealizedUsd,
      trades: acc.trades,
      ...(acc.lastTradeAt ? { lastTradeAt: acc.lastTradeAt } : {}),
    });
  });

  // Iter646: per-chain gas USD now uses a hybrid: stored USD (historically
  // accurate) + (native_unstored × current native price) as fallback for
  // legacy rows. Pre-iter646 the entire native total was multiplied by
  // CURRENT price, which mis-valued historical gas as the native price
  // drifted (a $17.50 gas trade at last month's ETH price became $15 today).
  const gasOut: GasSpend[] = [];
  let totalGasUsd = 0;
  gasChains.forEach(([chain, amount], i) => {
    const nativeUsd = gasPrices[i];
    const storedUsd = gasSpendUsdStored.get(chain) ?? 0;
    const unstoredNative = gasSpendNativeUnstored.get(chain) ?? 0;
    let usd: number | undefined;
    if (nativeUsd != null) {
      usd = storedUsd + unstoredNative * nativeUsd;
    } else if (storedUsd > 0) {
      // Even without a current native price, the stored portion is still
      // accurate — surface it (rather than dropping to undefined and hiding
      // accurate data behind a lookup failure).
      usd = storedUsd;
    }
    if (usd != null) totalGasUsd += usd;
    gasOut.push({ chain, amount: amount.toFixed(8), usd });
  });

  // Iter615: build per-window summaries when the caller asked for windows.
  // Reuses the per-window data accumulated by aggregateTrades (parallel-indexed
  // with opts.windows). Native gas prices come from the same gasPrices fetch.
  let windowSummaries: PnLWindowSummary[] | undefined;
  if (opts.windows && opts.windows.length > 0 && gasSpendPerWindow) {
    windowSummaries = opts.windows.map((win, wi) => {
      let realizedTotal = 0;
      const positionsForWindow: PnLWindowSummary["positions"] = [];
      for (const acc of positions.values()) {
        const r = acc.realizedPerWindow?.[wi] ?? 0;
        if (r !== 0) {
          positionsForWindow.push({ symbol: acc.symbol, chain: acc.chain, token: acc.token, realizedUsd: r });
          realizedTotal += r;
        }
      }
      const gasMap = gasSpendPerWindow[wi];
      let windowGasUsd = 0;
      const gasNativePerChain: PnLWindowSummary["gasNativePerChain"] = [];
      // Pull from the SAME parallel gasPrices fetch above by re-walking gasChains —
      // entries that don't appear in this window's map get amount=0 and skip the row.
      gasChains.forEach(([chain, _allAmount], i) => {
        void _allAmount;
        const winAmount = gasMap.get(chain) ?? 0;
        if (winAmount === 0) return;
        const nativeUsd = gasPrices[i];
        // Iter647: same hybrid math as the main path. Stored USD (historically
        // accurate) + native_unstored × current native price. Falls back to
        // legacy total native × current price when stored buckets are empty.
        const storedUsd = gasSpendUsdStoredPerWindow?.[wi]?.get(chain) ?? 0;
        const unstoredNative = gasSpendNativeUnstoredPerWindow?.[wi]?.get(chain) ?? 0;
        let usd: number | undefined;
        if (nativeUsd != null) {
          // When the per-window split is present (windows enabled), use it.
          // Else fall back to the pre-iter647 native × price calculation.
          if (gasSpendUsdStoredPerWindow && gasSpendNativeUnstoredPerWindow) {
            usd = storedUsd + unstoredNative * nativeUsd;
          } else {
            usd = winAmount * nativeUsd;
          }
        } else if (storedUsd > 0) {
          // Stored portion is accurate even without a current native price.
          usd = storedUsd;
        }
        if (usd != null) windowGasUsd += usd;
        gasNativePerChain.push({ chain, amount: winAmount.toFixed(8), usd });
      });
      return {
        label: win.label,
        since: win.since,
        until: win.until,
        realizedUsd: realizedTotal,
        gasNativePerChain,
        totalGasUsd: windowGasUsd,
        realizedAfterGasUsd: realizedTotal - windowGasUsd,
        positions: positionsForWindow.sort((a, b) => b.realizedUsd - a.realizedUsd),
      };
    });
  }

  // Iter627: sort positions BEFORE building the rollup so the rollup's
  // contributing-chain list reflects the same display order callers see in
  // positions[]. Cheap — single sort.
  const positionsSorted = positionsOut.sort((a, b) => (b.unrealizedUsd ?? 0) - (a.unrealizedUsd ?? 0));
  const byTokenSymbol = rollupPositionsBySymbol(positionsSorted);

  // Iter636: surface per-aggregator realized USD breakdown. Sorted by
  // realizedUsd descending — biggest earner first.
  // Iter708: each entry carries lastTradeAt from its bucket (MAX timestamp).
  const byAggregator = [...realizedByAggregator.entries()]
    .map(([aggregator, { realizedUsd, tradeCount, lastTradeAt }]) =>
      lastTradeAt
        ? { aggregator, realizedUsd, tradeCount, lastTradeAt }
        : { aggregator, realizedUsd, tradeCount },
    )
    .sort((a, b) => b.realizedUsd - a.realizedUsd);

  // Iter639: surface per-pair realized USD breakdown. Same sort discipline
  // as byAggregator.
  const byPair = [...realizedByPair.entries()]
    .map(([pair, { realizedUsd, tradeCount, lastTradeAt }]) =>
      lastTradeAt
        ? { pair, realizedUsd, tradeCount, lastTradeAt }
        : { pair, realizedUsd, tradeCount },
    )
    .sort((a, b) => b.realizedUsd - a.realizedUsd);

  // Iter649: per-strategy breakdown — same sort discipline.
  const byStrategy = [...realizedByStrategy.entries()]
    .map(([strategy, { realizedUsd, tradeCount, lastTradeAt }]) =>
      lastTradeAt
        ? { strategy, realizedUsd, tradeCount, lastTradeAt }
        : { strategy, realizedUsd, tradeCount },
    )
    .sort((a, b) => b.realizedUsd - a.realizedUsd);

  // Iter741: data-freshness check. Look up bookmarks for this (chain?, account)
  // and surface a warning when any are stale. listSyncBookmarks is a single
  // tiny query (small table), so the cost is negligible vs. the price+gas RPC
  // fan-out that dominates this function.
  const { listSyncBookmarks } = await import("./db.js");
  const staleBookmarks = computeStaleBookmarkEntries({
    account,
    ...(opts.chain ? { chain: opts.chain } : {}),
    bookmarks: listSyncBookmarks(),
  });
  const dataFreshness = staleBookmarks.length > 0
    ? { staleAfterHours: PNL_STALE_BOOKMARK_HOURS, staleBookmarks }
    : undefined;

  return {
    account,
    chain: opts.chain,
    timestamp: new Date().toISOString(),
    // Iter727: wall-clock for the full compute. Placed after timestamp for
    // visual proximity in JSON output.
    elapsedMs: Date.now() - t0,
    positions: positionsSorted,
    gas: gasOut,
    totalRealizedUsd: totalRealized,
    totalUnrealizedUsd: totalUnrealized,
    totalGasUsd,
    totalRealizedAfterGasUsd: totalRealized - totalGasUsd,
    byTokenSymbol,
    byAggregator,
    byPair,
    byStrategy,
    tradeCount: rows.length,
    // Iter765/iter768: earliest + latest input row timestamps. Single linear
    // pass picks both extremes — cheaper than two reduce() calls when
    // histories grow. Absent when rows is empty (no data point).
    ...(rows.length > 0
      ? (() => {
          let earliest = rows[0].timestamp;
          let latest = rows[0].timestamp;
          for (const r of rows) {
            if (r.timestamp < earliest) earliest = r.timestamp;
            if (r.timestamp > latest) latest = r.timestamp;
          }
          return { firstTradeAt: earliest, latestTradeAt: latest };
        })()
      : {}),
    ...(windowSummaries ? { windows: windowSummaries } : {}),
    ...(dataFreshness ? { dataFreshness } : {}),
    // Iter818: severity from dataFreshness presence.
    severity: dataFreshness ? "warn" : "ok",
    // Iter830: structured per-stale-bookmark dispatch list. Empty when no
    // staleness — same trigger as iter741 dataFreshness presence.
    recommendedActions: (dataFreshness?.staleBookmarks ?? []).map((s) => ({
      tool: "sync_trades",
      params: { chain: s.chain, account: s.account },
      reason: `Sync bookmark for ${s.chain}/${s.account} hasn't advanced in ${(s.ageHours / 24).toFixed(1)}d — PnL may be missing recent trades.`,
    })),
  };
}

export function formatPnLReport(report: PnLReport): string {
  const lines: string[] = [];
  // Iter731: append iter727 elapsedMs to the header for parity with iter730
  // health text-mode. Compact (N.Ns) suffix, absent when not measured.
  const elapsedSuffix = report.elapsedMs != null
    ? `  (${(report.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  // Iter819: severity badge — parity with iter808-818 convention. Reads
  // iter818 severity (ok/warn) derived from dataFreshness presence.
  const pnlBadge = report.severity === "ok" ? "🟢 OK  " : "🟡 WARN";
  lines.push(`${pnlBadge}  PnL Report — account: ${report.account}${report.chain ? `  chain: ${report.chain}` : ""}${elapsedSuffix}`);
  // Iter741: surface stale-sync warning directly under the header. Operators
  // who only skim the totals must see this — frozen sync = silently incomplete
  // PnL. One line per stale bookmark; >1 happens on multi-chain accounts.
  if (report.dataFreshness && report.dataFreshness.staleBookmarks.length > 0) {
    for (const s of report.dataFreshness.staleBookmarks) {
      const ageStr = s.ageHours >= 24
        ? `${(s.ageHours / 24).toFixed(1)}d`
        : `${s.ageHours.toFixed(1)}h`;
      lines.push(`  ⚠ Sync stale: ${s.chain}/${s.account} bookmark not advanced in ${ageStr} — PnL may be missing recent trades. Run \`tradekit trades sync\` or check the cron.`);
    }
  }
  // Iter745: onboarding hint for the empty-state. Fresh operators running
  // `tradekit pnl` after install see zeros everywhere and wonder what they did
  // wrong; this nudges them toward `trades sync` to backfill, or explains that
  // trading through tradekit will auto-populate. Conditional on tradeCount === 0
  // (no rows fed in at all — windowing/strategy filters that reduce a non-empty
  // set to zero would still set tradeCount=0, but the hint applies in either
  // case: "no trades match the current filter — sync more or widen the
  // scope").
  if (report.tradeCount === 0) {
    lines.push(`  ℹ No trades in local DB for this scope. Backfill from on-chain: \`tradekit trades sync --account ${report.account}${report.chain ? ` --chain ${report.chain}` : ""}\``);
  }
  lines.push("");
  if (report.positions.length === 0) {
    // Pre-iter165: "No closed trades yet." — but that was wrong for two real cases:
    // (a) account with only fully-closed positions (realized PnL non-zero, positions
    // table empty), and (b) account with only failed/transfer trades (gas spent but
    // no positions opened). The summary lines below still show the actual totals.
    lines.push("  No open positions.");
  } else {
    lines.push(
      "  Symbol         Chain      Amount           AvgCost($)   Price($)    Unrealized($)  Realized($)  Trades  Last",
    );
    lines.push(
      "  -----------------------------------------------------------------------------------------------------------------",
    );
    for (const p of report.positions) {
      const price = p.currentPriceUsd != null ? p.currentPriceUsd.toFixed(4) : "N/A";
      const unreal = p.unrealizedUsd != null ? p.unrealizedUsd.toFixed(2) : "N/A";
      // Iter706: lastTradeAt as YYYY-MM-DD compact form (full ISO in --json).
      const last = p.lastTradeAt ? p.lastTradeAt.slice(0, 10) : "—";
      lines.push(
        `  ${p.symbol.padEnd(14)} ${p.chain.padEnd(10)} ${p.amount.padEnd(16)} ${p.avgCostUsd
          .toFixed(4)
          .padEnd(12)} ${price.padEnd(11)} ${unreal.padEnd(14)} ${p.realizedUsd
          .toFixed(2)
          .padEnd(12)} ${String(p.trades).padEnd(6)} ${last}`,
      );
    }
  }
  // Count positions/gas with held value but no USD valuation. Pre-iter124 these were
  // silently excluded from the totals — the user saw a clean number and had no signal
  // that mark-to-market was missing N positions. Same pattern as iter123's
  // formatHoldings "(+N unpriced)" note.
  const unpricedPositions = report.positions.filter(
    (p) => p.currentPriceUsd == null && parseFloat(p.amount) !== 0,
  ).length;
  const unpricedGas = report.gas.filter((g) => g.usd == null && parseFloat(g.amount) !== 0).length;
  const unrealizedNote = unpricedPositions > 0 ? `  (+${unpricedPositions} unpriced)` : "";
  const gasNote = unpricedGas > 0 ? `  (+${unpricedGas} chain${unpricedGas === 1 ? "" : "s"} unpriced)` : "";

  lines.push("");
  lines.push(`  Realized (gross):       ${formatUsd(report.totalRealizedUsd)}`);
  lines.push(`  Gas paid (USD):         ${formatUsd(report.totalGasUsd)}${gasNote}`);
  lines.push(`  Realized after gas:     ${formatUsd(report.totalRealizedAfterGasUsd)}${gasNote}`);
  lines.push(`  Unrealized (mark-to-mkt): ${formatUsd(report.totalUnrealizedUsd)}${unrealizedNote}`);
  // Per-chain gas block: filter zero-amount entries (chains the account never used).
  // For remaining rows, show "(unpriced)" only when there's real gas spend that
  // couldn't be valued in USD — matches the summary "(+N chains unpriced)" note above.
  const nonZeroGas = report.gas.filter((g) => parseFloat(g.amount) !== 0);
  if (nonZeroGas.length > 0) {
    lines.push("");
    lines.push("  Gas by chain:");
    for (const g of nonZeroGas) {
      const usdSuffix = g.usd != null ? `  ($${g.usd.toFixed(4)})` : "  (unpriced)";
      lines.push(`    ${g.chain.padEnd(10)} ${g.amount}${usdSuffix}`);
    }
  }
  // Iter765/iter768: activity footer — "N trades from YYYY-MM-DD to YYYY-MM-DD".
  // Two-line cost, anchors the operator's eye on the activity SPAN — both
  // "how long have I been doing this" AND "is this account currently active".
  // Skipped when tradeCount === 0 (the iter745 onboarding hint already covers
  // that case at the top). When the entire history happened on one day,
  // collapses to "N trades on YYYY-MM-DD" — avoids the redundant "from X to X".
  if (report.tradeCount != null && report.tradeCount > 0 && report.firstTradeAt) {
    const since = report.firstTradeAt.slice(0, 10);
    const until = report.latestTradeAt?.slice(0, 10);
    const span = until && until !== since ? `from ${since} to ${until}` : `on ${since}`;
    lines.push("");
    lines.push(`  Active: ${report.tradeCount} trade${report.tradeCount === 1 ? "" : "s"} ${span}`);
  }
  return lines.join("\n");
}

// ── multi-account PnL (iter624) ───────────────────────────────

export interface MultiAccountPnLReport {
  /** ISO timestamp the aggregate was computed. */
  timestamp: string;
  /** Iter727: wall-clock ms for the full multi-account aggregate. Each
   *  perAccount[i].report has its own elapsedMs (iter727); this top-level
   *  field captures the orchestrator's own time, which includes parallel
   *  fan-out + the merge work — typically dominated by the slowest single-
   *  account compute. */
  elapsedMs?: number;
  /** Account labels included in the aggregate (those that succeeded). */
  accounts: string[];
  /** Chain filter applied to every account (mirrors PnLReport.chain). */
  chain?: string;
  /** Per-account reports — full PnLReport shape per account. Caller can drill
   *  into a single account's positions/windows without re-running the math. */
  perAccount: PnLReport[];
  /** Aggregate realized PnL = sum across accounts. */
  totalRealizedUsd: number;
  /** Aggregate unrealized PnL = sum across accounts. */
  totalUnrealizedUsd: number;
  /** Aggregate gas spend = sum across accounts. */
  totalGasUsd: number;
  /** Aggregate net = realized - gas. */
  totalRealizedAfterGasUsd: number;
  /**
   * Aggregate per-window summary. Window labels are matched by `label` ||
   * (`since`,`until`) tuple — same window definition the caller passed to
   * aggregateMultiAccountPnL maps to one summary entry across all accounts.
   * Per-window realized/gas sums roll up the per-account window numbers.
   */
  windows?: PnLWindowSummary[];
  /** Iter636: per-aggregator realized USD summed across accounts. Iter708
   *  carries lastTradeAt (MAX across the merged accounts). */
  byAggregator?: Array<{ aggregator: string; realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
  /** Iter639: per-pair realized USD summed across accounts. Iter708 lastTradeAt. */
  byPair?: Array<{ pair: string; realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
  /** Iter649: per-strategy realized USD summed across accounts. Iter708 lastTradeAt. */
  byStrategy?: Array<{ strategy: string; realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
  /** Per-account errors. One bad RPC for one account doesn't kill the whole
   *  aggregate; the failure is captured here and that account's PnL is
   *  excluded from totals. */
  errors: Array<{ account: string; message: string }>;
  /**
   * Iter741: aggregated data-freshness warnings across all contributing
   * accounts. Concatenation of perAccount[i].dataFreshness?.staleBookmarks —
   * one entry per stale (chain, account, owner) tuple. Absent when every
   * contributing account is fresh (or has no bookmarks).
   */
  dataFreshness?: {
    staleAfterHours: number;
    staleBookmarks: Array<{ chain: string; account: string; owner: string; ageHours: number; lastSyncedBlock: string }>;
  };
  /** Iter818: worst-bucket severity. "warn" when any stale bookmark (any
   *  account) OR per-account errors fired; "ok" otherwise. Roll-up of the
   *  per-account severity fields combined with aggregate-level errors. */
  severity: "ok" | "warn";
  /** Iter830: structured next-action dispatch list (aggregated across
   *  per-account stale bookmarks). One entry per stale (chain, account)
   *  tuple suggesting `sync_trades`. Always present. */
  recommendedActions: import("./errors.js").NextAction[];
}

/**
 * Iter624: pure aggregator. Given per-account PnL reports, sum totals and
 * merge per-window summaries by their identity (label || since|until).
 *
 * Behavior:
 *   - empty input → zero totals, empty arrays, no windows.
 *   - windows match by `label` when set; otherwise by since|until tuple.
 *   - per-window `positions[]` is concatenated (account context is implicit
 *     in PnLWindowSummary.positions[].chain + symbol — the caller can still
 *     identify which account's position when needed via perAccount).
 *
 * Pure — no I/O. Exported for unit testing without standing up the full
 * computePnL HTTP stack.
 */
export function sumPnLReports(reports: readonly PnLReport[]): {
  totalRealizedUsd: number;
  totalUnrealizedUsd: number;
  totalGasUsd: number;
  totalRealizedAfterGasUsd: number;
  windows?: PnLWindowSummary[];
  /** Iter636/iter708: per-aggregator realized USD summed across accounts + MAX(lastTradeAt). */
  byAggregator?: Array<{ aggregator: string; realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
  /** Iter639/iter708: per-pair realized USD + lastTradeAt. */
  byPair?: Array<{ pair: string; realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
  /** Iter649/iter708: per-strategy realized USD + lastTradeAt. */
  byStrategy?: Array<{ strategy: string; realizedUsd: number; tradeCount: number; lastTradeAt?: string }>;
} {
  let totalRealizedUsd = 0;
  let totalUnrealizedUsd = 0;
  let totalGasUsd = 0;
  for (const r of reports) {
    totalRealizedUsd += r.totalRealizedUsd;
    totalUnrealizedUsd += r.totalUnrealizedUsd;
    totalGasUsd += r.totalGasUsd;
  }

  // Iter636/iter708: merge per-aggregator across accounts. Same aggregator on
  // different accounts → sum realized/tradeCount; lastTradeAt = MAX across
  // contributing accounts.
  const aggMap = new Map<string, { realizedUsd: number; tradeCount: number; lastTradeAt?: string }>();
  for (const r of reports) {
    for (const a of r.byAggregator ?? []) {
      const existing = aggMap.get(a.aggregator);
      if (existing) {
        existing.realizedUsd += a.realizedUsd;
        existing.tradeCount += a.tradeCount;
        if (a.lastTradeAt && (!existing.lastTradeAt || a.lastTradeAt > existing.lastTradeAt)) {
          existing.lastTradeAt = a.lastTradeAt;
        }
      } else {
        aggMap.set(a.aggregator, {
          realizedUsd: a.realizedUsd,
          tradeCount: a.tradeCount,
          ...(a.lastTradeAt ? { lastTradeAt: a.lastTradeAt } : {}),
        });
      }
    }
  }
  const byAggregator = aggMap.size > 0
    ? [...aggMap.entries()]
        .map(([aggregator, v]) =>
          v.lastTradeAt
            ? { aggregator, realizedUsd: v.realizedUsd, tradeCount: v.tradeCount, lastTradeAt: v.lastTradeAt }
            : { aggregator, realizedUsd: v.realizedUsd, tradeCount: v.tradeCount },
        )
        .sort((a, b) => b.realizedUsd - a.realizedUsd)
    : undefined;

  // Iter639/iter708: merge per-pair across accounts.
  const pairMap = new Map<string, { realizedUsd: number; tradeCount: number; lastTradeAt?: string }>();
  for (const r of reports) {
    for (const p of r.byPair ?? []) {
      const existing = pairMap.get(p.pair);
      if (existing) {
        existing.realizedUsd += p.realizedUsd;
        existing.tradeCount += p.tradeCount;
        if (p.lastTradeAt && (!existing.lastTradeAt || p.lastTradeAt > existing.lastTradeAt)) {
          existing.lastTradeAt = p.lastTradeAt;
        }
      } else {
        pairMap.set(p.pair, {
          realizedUsd: p.realizedUsd,
          tradeCount: p.tradeCount,
          ...(p.lastTradeAt ? { lastTradeAt: p.lastTradeAt } : {}),
        });
      }
    }
  }
  const byPair = pairMap.size > 0
    ? [...pairMap.entries()]
        .map(([pair, v]) =>
          v.lastTradeAt
            ? { pair, realizedUsd: v.realizedUsd, tradeCount: v.tradeCount, lastTradeAt: v.lastTradeAt }
            : { pair, realizedUsd: v.realizedUsd, tradeCount: v.tradeCount },
        )
        .sort((a, b) => b.realizedUsd - a.realizedUsd)
    : undefined;

  // Iter649/iter708: merge per-strategy across accounts.
  const stratMap = new Map<string, { realizedUsd: number; tradeCount: number; lastTradeAt?: string }>();
  for (const r of reports) {
    for (const s of r.byStrategy ?? []) {
      const existing = stratMap.get(s.strategy);
      if (existing) {
        existing.realizedUsd += s.realizedUsd;
        existing.tradeCount += s.tradeCount;
        if (s.lastTradeAt && (!existing.lastTradeAt || s.lastTradeAt > existing.lastTradeAt)) {
          existing.lastTradeAt = s.lastTradeAt;
        }
      } else {
        stratMap.set(s.strategy, {
          realizedUsd: s.realizedUsd,
          tradeCount: s.tradeCount,
          ...(s.lastTradeAt ? { lastTradeAt: s.lastTradeAt } : {}),
        });
      }
    }
  }
  const byStrategy = stratMap.size > 0
    ? [...stratMap.entries()]
        .map(([strategy, v]) =>
          v.lastTradeAt
            ? { strategy, realizedUsd: v.realizedUsd, tradeCount: v.tradeCount, lastTradeAt: v.lastTradeAt }
            : { strategy, realizedUsd: v.realizedUsd, tradeCount: v.tradeCount },
        )
        .sort((a, b) => b.realizedUsd - a.realizedUsd)
    : undefined;

  // Merge windows by identity key. The first account whose report includes a
  // given window establishes that window's label/since/until; subsequent
  // accounts contribute realized/gas/positions.
  const windowMap = new Map<string, PnLWindowSummary>();
  for (const r of reports) {
    for (const w of r.windows ?? []) {
      const key = w.label ?? `${w.since ?? ""}|${w.until ?? ""}`;
      const existing = windowMap.get(key);
      if (!existing) {
        // Deep-clone so subsequent merges that mutate existing.gasNativePerChain
        // entries don't reach back into the input reports' arrays. Shallow
        // [...w.gasNativePerChain] copies the array but its entries are still
        // refs to the input's objects.
        windowMap.set(key, {
          label: w.label,
          since: w.since,
          until: w.until,
          realizedUsd: w.realizedUsd,
          gasNativePerChain: w.gasNativePerChain.map((g) => ({ ...g })),
          totalGasUsd: w.totalGasUsd,
          realizedAfterGasUsd: w.realizedAfterGasUsd,
          positions: [...w.positions],
        });
      } else {
        existing.realizedUsd += w.realizedUsd;
        existing.totalGasUsd += w.totalGasUsd;
        existing.realizedAfterGasUsd = existing.realizedUsd - existing.totalGasUsd;
        existing.positions = [...existing.positions, ...w.positions];
        // Merge gasNativePerChain by chain: same chain, different accounts ->
        // sum the native amount + USD. Different chains -> concat.
        for (const g of w.gasNativePerChain) {
          const existingChain = existing.gasNativePerChain.find((x) => x.chain === g.chain);
          if (existingChain) {
            const prevAmt = parseFloat(existingChain.amount) || 0;
            const newAmt = parseFloat(g.amount) || 0;
            existingChain.amount = (prevAmt + newAmt).toFixed(8);
            if (g.usd != null) {
              existingChain.usd = (existingChain.usd ?? 0) + g.usd;
            }
          } else {
            existing.gasNativePerChain.push({ ...g });
          }
        }
      }
    }
  }
  const windows = windowMap.size > 0 ? [...windowMap.values()] : undefined;

  return {
    totalRealizedUsd,
    totalUnrealizedUsd,
    totalGasUsd,
    totalRealizedAfterGasUsd: totalRealizedUsd - totalGasUsd,
    ...(windows ? { windows } : {}),
    ...(byAggregator ? { byAggregator } : {}),
    ...(byPair ? { byPair } : {}),
    ...(byStrategy ? { byStrategy } : {}),
  };
}

/**
 * Iter624: orchestrator. Fan out computePnL across N accounts in parallel,
 * aggregate via sumPnLReports, capture per-account errors so a single bad
 * RPC doesn't kill the whole aggregate.
 *
 * Why parallel: per-account computePnL is independent (separate DB query,
 * separate price fetches). Serial would be N× slower for no benefit.
 *
 * `accounts` is required (caller resolves "all" → label list before this).
 * `chain` and `windows` are applied identically to every account.
 */
export async function aggregateMultiAccountPnL(
  accounts: readonly string[],
  opts: { chain?: string; windows?: readonly PnLWindow[]; strategy?: string },
  logger: Logger,
): Promise<MultiAccountPnLReport> {
  // Iter727: wall-clock for the multi-account orchestration.
  const t0 = Date.now();
  const results = await Promise.all(
    accounts.map(async (acct) => {
      try {
        const report = await computePnL(acct, opts, logger);
        return { kind: "ok" as const, account: acct, report };
      } catch (e) {
        return { kind: "err" as const, account: acct, message: (e as Error).message };
      }
    }),
  );

  const perAccount: PnLReport[] = [];
  const errors: MultiAccountPnLReport["errors"] = [];
  const succeededLabels: string[] = [];
  for (const r of results) {
    if (r.kind === "ok") {
      perAccount.push(r.report);
      succeededLabels.push(r.account);
    } else {
      errors.push({ account: r.account, message: r.message });
    }
  }

  const sums = sumPnLReports(perAccount);

  // Iter741: aggregate stale-bookmark warnings from every contributing
  // per-account report. Concatenation — one entry per stale (chain, account,
  // owner) tuple. Order is the perAccount iteration order, which is the
  // caller-supplied account list. Absent when every account is fresh.
  const aggregateStale = perAccount.flatMap((r) => r.dataFreshness?.staleBookmarks ?? []);
  const dataFreshness = aggregateStale.length > 0
    ? { staleAfterHours: PNL_STALE_BOOKMARK_HOURS, staleBookmarks: aggregateStale }
    : undefined;

  return {
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    accounts: succeededLabels,
    chain: opts.chain,
    perAccount,
    totalRealizedUsd: sums.totalRealizedUsd,
    totalUnrealizedUsd: sums.totalUnrealizedUsd,
    totalGasUsd: sums.totalGasUsd,
    totalRealizedAfterGasUsd: sums.totalRealizedAfterGasUsd,
    ...(sums.windows ? { windows: sums.windows } : {}),
    ...(sums.byAggregator ? { byAggregator: sums.byAggregator } : {}),
    ...(sums.byPair ? { byPair: sums.byPair } : {}),
    ...(sums.byStrategy ? { byStrategy: sums.byStrategy } : {}),
    errors,
    ...(dataFreshness ? { dataFreshness } : {}),
    // Iter818: severity rolls up data freshness + per-account errors.
    severity: dataFreshness || errors.length > 0 ? "warn" : "ok",
    // Iter830: aggregated dispatch list — one entry per stale bookmark
    // across all contributing accounts.
    recommendedActions: (dataFreshness?.staleBookmarks ?? []).map((s) => ({
      tool: "sync_trades",
      params: { chain: s.chain, account: s.account },
      reason: `Sync bookmark for ${s.chain}/${s.account} hasn't advanced in ${(s.ageHours / 24).toFixed(1)}d — PnL may be missing recent trades.`,
    })),
  };
}
