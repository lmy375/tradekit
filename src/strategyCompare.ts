/**
 * Strategy comparison (v83) — "which of my strategies make money, which bleed?"
 *
 * For a multi-strategy agent, the core EFFECTIVENESS decision is capital
 * allocation: scale the winners, cut the losers. The product had per-strategy
 * deep-dives (strategy_report) and a buried byStrategy breakdown in the PnL
 * report (realized + count only) — but no RANKED side-by-side comparison with
 * the metrics that decide allocation: realized P&L, WIN RATE (consistency —
 * +$100 over 2 lucky trades vs 50 steady ones are very different), trade count
 * (sample size), and volume.
 *
 * Deterministic by design: uses the v71/v82 shared cost-basis reducer (the
 * canonical core every P&L surface now shares — so these numbers can't diverge)
 * + the same stablecoin-$1 quote model the tax export uses. No marks, no RPC —
 * a comparison you can run anytime and get the same answer. Realized-only (the
 * bottom line of CLOSED trades); unrealized/gas stay on the live `pnl` surface.
 *
 * Pure core (computeStrategyComparison) + a thin trade-loading gatherer.
 */

import { applyBuy, applySell, type CostBasisState } from "./costBasis.js";
import { recentTrades, listPaperTrades } from "./db.js";

/** Same stablecoin set the rest of the codebase uses — a quote priced at $1. */
const STABLES = new Set(["USDC", "USDT", "DAI", "USDC.E", "USDBC", "FRAX", "LUSD", "TUSD", "USDP", "GUSD"]);
function isStablecoin(symbol: string | null | undefined): boolean {
  return symbol != null && STABLES.has(symbol.toUpperCase());
}

export interface StrategyTradeLite {
  strategy: string | null;
  chain: string;
  direction: "buy" | "sell";
  base_token: string;
  base_symbol: string | null;
  base_amount: string;
  quote_amount: string;
  quote_symbol: string | null;
  timestamp: string;
}

export interface StrategyPerformance {
  strategy: string;
  /** Realized P&L (USD) — weighted-average, via the shared reducer. */
  realizedUsd: number;
  /** Priced swaps that entered the cost-basis walk. */
  tradeCount: number;
  /** Priced sells that realized against a tracked position. */
  closes: number;
  wins: number;
  losses: number;
  /** wins / (wins + losses) × 100. Null when nothing has closed. */
  winRatePct: number | null;
  /** Total priced USD traded (buys + sells). */
  volumeUsd: number;
  /** realizedUsd / closes. Null when nothing has closed. */
  avgRealizedPerClose: number | null;
  lastTradeAt: string | null;
}

export interface StrategyComparisonReport {
  /** Ranked, realized desc (winners first). */
  strategies: StrategyPerformance[];
  totalRealizedUsd: number;
  best: StrategyPerformance | null;
  worst: StrategyPerformance | null;
  /** Strategies whose realized P&L is negative — candidates to cut/review. */
  bleeding: string[];
  /** Trades skipped from P&L because the quote wasn't a priceable stablecoin. */
  unpricedTrades: number;
  summary: string;
  generatedAt: string;
}

/** Below this |USD| a realized result is treated as flat (neither win nor loss). */
const FLAT_PNL_EPSILON = 1e-6;

/**
 * Pure: walk trades grouped by strategy through the shared cost-basis reducer,
 * accumulating realized P&L + win/loss + volume per strategy, then rank.
 * `now` only stamps the report.
 */
export function computeStrategyComparison(
  rows: readonly StrategyTradeLite[],
  opts: { now?: Date } = {},
): StrategyComparisonReport {
  // Chronological walk — the weighted-average model is path-dependent.
  const sorted = [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  interface Acc {
    realized: number;
    tradeCount: number;
    closes: number;
    wins: number;
    losses: number;
    volume: number;
    lastTradeAt: string | null;
    positions: Map<string, CostBasisState>;
  }
  const byStrategy = new Map<string, Acc>();
  let unpricedTrades = 0;

  for (const r of sorted) {
    const base = parseFloat(r.base_amount);
    const quote = parseFloat(r.quote_amount);
    if (!Number.isFinite(base) || !Number.isFinite(quote) || base <= 0 || quote <= 0) continue;
    // Deterministic USD: only stablecoin-quoted trades are priced (same model
    // as the tax export). Others can't be valued without a price fetch.
    if (!isStablecoin(r.quote_symbol)) {
      unpricedTrades += 1;
      continue;
    }
    const tradeUsd = quote; // stablecoin quote ≈ $1/unit

    const key = r.strategy?.trim() || "(none)";
    let acc = byStrategy.get(key);
    if (!acc) {
      acc = { realized: 0, tradeCount: 0, closes: 0, wins: 0, losses: 0, volume: 0, lastTradeAt: null, positions: new Map() };
      byStrategy.set(key, acc);
    }
    acc.tradeCount += 1;
    acc.volume += tradeUsd;
    if (!acc.lastTradeAt || r.timestamp > acc.lastTradeAt) acc.lastTradeAt = r.timestamp;

    const posKey = `${r.chain}:${(r.base_symbol ?? r.base_token).toUpperCase()}`;
    let pos = acc.positions.get(posKey);
    if (!pos) {
      pos = { amount: 0, cost: 0 };
      acc.positions.set(posKey, pos);
    }

    if (r.direction === "buy") {
      applyBuy(pos, base, tradeUsd);
    } else {
      const sellPricePerUnit = tradeUsd / base;
      const { avgCost, sold } = applySell(pos, base);
      if (sold > 0) {
        const realized = (sellPricePerUnit - avgCost) * sold;
        acc.realized += realized;
        acc.closes += 1;
        if (realized > FLAT_PNL_EPSILON) acc.wins += 1;
        else if (realized < -FLAT_PNL_EPSILON) acc.losses += 1;
      }
    }
  }

  const strategies: StrategyPerformance[] = [...byStrategy.entries()]
    .map(([strategy, a]) => ({
      strategy,
      realizedUsd: a.realized,
      tradeCount: a.tradeCount,
      closes: a.closes,
      wins: a.wins,
      losses: a.losses,
      winRatePct: a.wins + a.losses > 0 ? (a.wins / (a.wins + a.losses)) * 100 : null,
      volumeUsd: a.volume,
      avgRealizedPerClose: a.closes > 0 ? a.realized / a.closes : null,
      lastTradeAt: a.lastTradeAt,
    }))
    .sort((x, y) => y.realizedUsd - x.realizedUsd);

  const totalRealizedUsd = strategies.reduce((s, x) => s + x.realizedUsd, 0);
  const best = strategies[0] ?? null;
  const worst = strategies.length > 0 ? strategies[strategies.length - 1] : null;
  const bleeding = strategies.filter((s) => s.realizedUsd < -FLAT_PNL_EPSILON).map((s) => s.strategy);

  const summary =
    strategies.length === 0
      ? "No priced (stablecoin-quoted) trades to compare."
      : `${strategies.length} strateg${strategies.length === 1 ? "y" : "ies"} · total realized $${totalRealizedUsd.toFixed(2)}` +
        (best && best.realizedUsd > 0 ? ` · best ${best.strategy} (+$${best.realizedUsd.toFixed(2)})` : "") +
        (bleeding.length > 0 ? ` · ${bleeding.length} bleeding` : "") +
        ".";

  return {
    strategies,
    totalRealizedUsd,
    best,
    worst,
    bleeding,
    unpricedTrades,
    summary,
    generatedAt: (opts.now ?? new Date()).toISOString(),
  };
}

/**
 * Load trades + compare. mode 'real' (default) ranks success real trades;
 * 'paper' ranks the virtual book. Deterministic — no marks/RPC.
 */
export function gatherStrategyComparison(args: {
  mode?: "real" | "paper";
  account?: string;
  chain?: string;
  sinceIso?: string;
  now?: Date;
}): StrategyComparisonReport {
  const mode = args.mode ?? "real";
  let rows: StrategyTradeLite[];
  if (mode === "paper") {
    rows = listPaperTrades({ account: args.account, chain: args.chain, sinceIso: args.sinceIso }).map(toLite);
  } else {
    rows = recentTrades({ account: args.account, chain: args.chain, since: args.sinceIso, limit: 1_000_000 })
      .filter((t) => t.status === "success")
      .map(toLite);
  }
  return computeStrategyComparison(rows, { now: args.now });
}

function toLite(t: {
  strategy?: string | null;
  chain: string;
  direction: string;
  base_token: string;
  base_symbol: string | null;
  base_amount: string;
  quote_amount: string;
  quote_symbol: string | null;
  timestamp: string;
}): StrategyTradeLite {
  return {
    strategy: t.strategy ?? null,
    chain: t.chain,
    direction: t.direction === "sell" ? "sell" : "buy",
    base_token: t.base_token,
    base_symbol: t.base_symbol,
    base_amount: t.base_amount,
    quote_amount: t.quote_amount,
    quote_symbol: t.quote_symbol,
    timestamp: t.timestamp,
  };
}

export function renderStrategyComparison(r: StrategyComparisonReport): string {
  const lines: string[] = [];
  lines.push(`Strategy comparison — ${r.summary}`);
  if (r.strategies.length === 0) return lines.join("\n");
  lines.push("");
  lines.push("  Rank  Strategy            Realized $   Win rate   Closes  Trades  Volume $    Last");
  lines.push("  " + "-".repeat(96));
  r.strategies.forEach((s, i) => {
    const wr = s.winRatePct != null ? `${s.winRatePct.toFixed(0)}% (${s.wins}/${s.wins + s.losses})` : "—";
    const last = s.lastTradeAt ? s.lastTradeAt.slice(0, 10) : "—";
    const realized = `${s.realizedUsd >= 0 ? "+" : "−"}$${Math.abs(s.realizedUsd).toFixed(2)}`;
    lines.push(
      `  ${String(i + 1).padStart(2)}.   ${s.strategy.padEnd(18).slice(0, 18)}  ${realized.padStart(11)}  ${wr.padStart(12)}  ${String(s.closes).padStart(6)}  ${String(s.tradeCount).padStart(6)}  $${s.volumeUsd.toFixed(0).padStart(9)}  ${last}`,
    );
  });
  if (r.bleeding.length > 0) {
    lines.push("");
    lines.push(`  ⚠ Bleeding (negative realized): ${r.bleeding.join(", ")} — review or cut.`);
  }
  if (r.unpricedTrades > 0) {
    lines.push(`  Note: ${r.unpricedTrades} non-stablecoin-quoted trade(s) excluded from P&L (can't value deterministically).`);
  }
  return lines.join("\n");
}
