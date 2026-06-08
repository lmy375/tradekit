// Iter642 + iter644: data-driven slippage suggestion. Operators currently
// guess at slippage values — too tight, trades revert during normal market
// noise; too loose, exposed to MEV / sandwich attacks. After iter641 stored
// realized slippage on every success trade, we can suggest a value from the
// operator's OWN historical fills on the same pair.
//
// iter644 added a standalone preview path so operators can inspect what the
// suggestion would be WITHOUT executing a trade.
//
// Formula:
//   suggested = max(p95(history) × (1 + bufferPct), defaultSlippageBps)
//   suggested = min(suggested, maxSlippageBps)
//
// Why p95 not p99 or max: p99/max chase outliers (one bad sandwich shouldn't
// permanently raise the operator's slippage budget). p95 is the standard
// "bad day" risk number.
//
// Why a buffer: even with stored history matching the current pair, future
// volatility may be higher than past. 25% default buffer absorbs minor regime
// shifts without being so generous it widens the MEV door.
//
// Confidence gate: requires N >= 5 samples to suggest. Smaller samples are
// noise — fall back to the operator's default. Returns reason="insufficient_history"
// so the CLI/MCP layer can tell the operator we used the default.

import type { TradeRow } from "./db.js";

/** Minimum stored slippage samples for a recommendation. */
export const SUGGEST_MIN_SAMPLES = 5;

/** Default safety buffer added on top of p95 (e.g. 25% of p95). */
export const SUGGEST_DEFAULT_BUFFER_PCT = 25;

/** Default lookback window for sourcing rows from the DB. */
export const SUGGEST_DEFAULT_LOOKBACK_DAYS = 30;

export interface SlippageSuggestion {
  /** The recommended slippage in basis points. */
  suggestedBps: number;
  /** How many historical samples contributed. */
  sampleCount: number;
  /** p95 of the underlying samples (pre-buffer). Null when sample count < min. */
  p95Bps: number | null;
  /** Median of the samples. Useful for the operator to see "typical" vs "bad day". */
  medianBps: number | null;
  /** Whether the recommendation was floored at config.defaultSlippageBps (sample
   *  set's p95 was lower than default) or capped at safety.maxSlippageBps. */
  flooredAtDefault: boolean;
  cappedAtMax: boolean;
  /** Why the suggestion is what it is — stable codes an agent can branch on. */
  reason:
    | "from_history"                 // happy path: p95+buffer recommended
    | "from_history_floored"          // p95+buffer was below default; using default
    | "from_history_capped"           // p95+buffer was above max; capped
    | "insufficient_history"          // < SUGGEST_MIN_SAMPLES, default used
    | "no_history";                   // 0 samples, default used
}

/**
 * Iter642: pure suggestion. Takes slip samples + caps + returns a recommendation.
 *
 * Returns the recommended `suggestedBps` plus structured `reason` so callers
 * can branch (e.g. "show 'using default — need 5+ trades on this pair' to the
 * operator").
 */
export function suggestSlippageBps(args: {
  /** Realized slippage samples (in basis points). */
  samples: readonly number[];
  /** Operator's configured default (config.defaultSlippageBps). Floor. */
  defaultBps: number;
  /** Operator's configured cap (safety.maxSlippageBps). Ceiling. */
  maxBps: number;
  /** Buffer % applied on top of p95. Default SUGGEST_DEFAULT_BUFFER_PCT. */
  bufferPct?: number;
  /** Minimum samples required to use history. Default SUGGEST_MIN_SAMPLES. */
  minSamples?: number;
}): SlippageSuggestion {
  const minSamples = args.minSamples ?? SUGGEST_MIN_SAMPLES;
  const bufferPct = args.bufferPct ?? SUGGEST_DEFAULT_BUFFER_PCT;
  const samples = args.samples.filter((s) => Number.isFinite(s));

  if (samples.length === 0) {
    return {
      suggestedBps: args.defaultBps,
      sampleCount: 0,
      p95Bps: null,
      medianBps: null,
      flooredAtDefault: false,
      cappedAtMax: false,
      reason: "no_history",
    };
  }
  if (samples.length < minSamples) {
    return {
      suggestedBps: args.defaultBps,
      sampleCount: samples.length,
      p95Bps: null,
      medianBps: null,
      flooredAtDefault: false,
      cappedAtMax: false,
      reason: "insufficient_history",
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // p95 with linear interpolation matching iter623's percentile helper.
  const idx = 0.95 * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const p95 = lo === hi ? sorted[lo] : sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);

  const withBuffer = p95 * (1 + bufferPct / 100);
  let suggested = withBuffer;
  let flooredAtDefault = false;
  let cappedAtMax = false;
  if (suggested < args.defaultBps) {
    suggested = args.defaultBps;
    flooredAtDefault = true;
  }
  if (suggested > args.maxBps) {
    suggested = args.maxBps;
    cappedAtMax = true;
  }
  // Round to whole bps — sub-bps precision in the recommendation isn't useful
  // and is cosmetic noise.
  suggested = Math.round(suggested);

  const reason = cappedAtMax
    ? "from_history_capped"
    : flooredAtDefault
      ? "from_history_floored"
      : "from_history";

  return {
    suggestedBps: suggested,
    sampleCount: samples.length,
    p95Bps: p95,
    medianBps: median,
    flooredAtDefault,
    cappedAtMax,
    reason,
  };
}

/**
 * Iter642: extract realized-slippage samples for a canonical pair from a
 * batch of trade rows. Filters to:
 *   - status="success" (failed/pending rows have no realized data)
 *   - aggregator != "transfer" (transfers aren't swaps)
 *   - realized_slippage_bps IS NOT NULL (iter641 stored)
 *   - pair matches by EITHER symbol OR address
 *
 * Hybrid match: callers may know only addresses (programmatic) or only
 * symbols (resolved). Match-by-EITHER lets the auto-slippage path work
 * before token metadata has been fetched. Same canonical "lexicographically
 * sorted + uppercased" pair shape as iter634.
 *
 * Pure — exported for unit testing without a DB.
 */
export function extractPairSamples(args: {
  rows: readonly TradeRow[];
  /** Canonical symbol-pair ("BASE/QUOTE"), or undefined if symbols not known. */
  pairSymbol?: string;
  /** Canonical address-pair ("0xbase/0xquote"), or undefined if addresses
   *  shouldn't be considered. */
  pairAddress?: string;
}): number[] {
  const targetSym = args.pairSymbol?.toUpperCase();
  const targetAddr = args.pairAddress?.toLowerCase();
  if (!targetSym && !targetAddr) return [];
  const samples: number[] = [];
  for (const row of args.rows) {
    if (row.status !== "success") continue;
    if (row.aggregator === "transfer") continue;
    if (row.realized_slippage_bps == null) continue;
    if (!Number.isFinite(row.realized_slippage_bps)) continue;

    if (targetSym) {
      const baseUp = (row.base_symbol ?? "").toUpperCase();
      const quoteUp = (row.quote_symbol ?? "").toUpperCase();
      if (baseUp && quoteUp) {
        const pair = baseUp < quoteUp ? `${baseUp}/${quoteUp}` : `${quoteUp}/${baseUp}`;
        if (pair === targetSym) {
          samples.push(row.realized_slippage_bps);
          continue;
        }
      }
    }
    if (targetAddr) {
      const bt = row.base_token.toLowerCase();
      const qt = row.quote_token.toLowerCase();
      if (bt && qt) {
        const pair = bt < qt ? `${bt}/${qt}` : `${qt}/${bt}`;
        if (pair === targetAddr) {
          samples.push(row.realized_slippage_bps);
        }
      }
    }
  }
  return samples;
}

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

export interface SlippagePreview {
  /** Canonical "BASE/QUOTE" symbol-pair used for the lookup. */
  pairSymbol: string;
  /** Canonical address-pair (when both addresses supplied). */
  pairAddress?: string;
  /** Account label scoped to. */
  account: string;
  /** ISO timestamp lower bound used for the row pull. */
  since: string;
  /** Operator's default slippage cap (for context in the response). */
  defaultBps: number;
  /** Safety max slippage cap (for context). */
  maxBps: number;
  /** The suggestion details (same shape as iter642 SlippageSuggestion). */
  suggestion: SlippageSuggestion;
}

/**
 * Iter644: standalone slippage-suggestion preview. Same pure logic the
 * trade.ts auto-slippage path uses — runs without executing any trade.
 *
 * Operators inspect via `tradekit slippage suggest ETH USDC` or the
 * `slippage_suggest` MCP tool.
 */
export async function previewSlippageSuggestion(args: {
  config: Config;
  logger: Logger;
  account: string;
  baseSymbol?: string;
  quoteSymbol?: string;
  baseAddress?: string;
  quoteAddress?: string;
  /** Window in days to pull rows from. Default SUGGEST_DEFAULT_LOOKBACK_DAYS. */
  lookbackDays?: number;
}): Promise<SlippagePreview> {
  const { recentTrades } = await import("./db.js");
  const lookbackDays = args.lookbackDays ?? SUGGEST_DEFAULT_LOOKBACK_DAYS;
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const rows = recentTrades({ account: args.account, since, limit: 1000 });

  const normPair = (a: string, b: string): string => (a < b ? `${a}/${b}` : `${b}/${a}`);
  const baseU = (args.baseSymbol ?? "").toUpperCase();
  const quoteU = (args.quoteSymbol ?? "").toUpperCase();
  const pairSymbol = baseU && quoteU ? normPair(baseU, quoteU) : `${baseU}/${quoteU}`;

  let pairAddress: string | undefined;
  if (args.baseAddress && args.quoteAddress) {
    const bL = args.baseAddress.toLowerCase();
    const qL = args.quoteAddress.toLowerCase();
    pairAddress = bL < qL ? `${bL}/${qL}` : `${qL}/${bL}`;
  }

  const samples = extractPairSamples({ rows, pairSymbol, pairAddress });
  const suggestion = suggestSlippageBps({
    samples,
    defaultBps: args.config.defaultSlippageBps,
    maxBps: args.config.safety.maxSlippageBps,
  });

  args.logger.debug(
    `Slippage suggestion preview: ${suggestion.suggestedBps} bps (${suggestion.reason}, ${suggestion.sampleCount} samples on ${pairSymbol})`,
  );

  return {
    pairSymbol,
    pairAddress,
    account: args.account,
    since,
    defaultBps: args.config.defaultSlippageBps,
    maxBps: args.config.safety.maxSlippageBps,
    suggestion,
  };
}
