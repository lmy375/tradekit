/**
 * Open-position review (v65) — "what am I holding, how is it doing, and is
 * it long-term yet?"
 *
 * The exit-decision counterpart to v64 price context (entry timing) and the
 * open-position completion of v60 (which gave REALIZED gains a holding period
 * + short/long-term term). For each OPEN position this surfaces cost basis,
 * current value, unrealized P&L (abs + %), the weighted-average acquisition
 * date, the holding period, and — the actionable tax signal — the term it
 * WOULD be if sold now plus how many days remain to long-term. "You're 340d
 * into WETH; 25 days to long-term rates" is a concrete exit-timing decision an
 * agent/operator otherwise had no surface for.
 *
 * Runs the SAME cost-basis walker (computePaperPnlMtm via toMtmRows for real
 * trades) every P&L surface shares — so the numbers are consistent. The
 * strategy tag is stripped before the walk so positions are PORTFOLIO-level
 * (your total WETH basis blends all your WETH buys), or strategy-scoped when
 * `strategy` is passed. Deterministic given the mark fetcher (injected in
 * tests); live marks via defaultPaperPriceFetcher in production.
 */

import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { recentTrades, listPaperTrades, type PaperTradeRow } from "./db.js";
import {
  computePaperPnlMtm,
  LONG_TERM_DAYS,
  type GainTerm,
  type PaperPriceFetcher,
} from "./paperPnl.js";

/** A short-term position within this many days of long-term is flagged as
 *  "approaching" — the window where waiting to sell flips the tax rate. */
export const APPROACHING_LONG_TERM_DAYS = 30;

export interface OpenPositionEntry {
  chain: string;
  token: string;
  symbol: string | null;
  amount: number;
  avgCostQuote: number;
  costBasisQuote: number;
  currentPriceQuote: number | null;
  valueQuote: number | null;
  unrealizedQuote: number | null;
  /** unrealizedQuote / costBasisQuote × 100. Null when unpriced or no basis. */
  unrealizedPct: number | null;
  acquiredAt: string | null;
  holdingDays: number | null;
  /** What the gain would be taxed as if sold NOW. */
  projectedTerm: GainTerm;
  /** Days until this short-term position becomes long-term. Null when it's
   *  already long, or untracked (no acquisition date). */
  daysToLongTerm: number | null;
  /** v67: recent price context (range position + trend) for EXIT timing —
   *  is the price near a recent high (good exit) or low (maybe hold)?
   *  Present only when withContext is requested; null when the token has no
   *  CoinGecko mapping. Backed by the v66 series cache, so repeated reviews
   *  are cheap. */
  priceContext?: {
    windowDays: number;
    low: number;
    high: number;
    /** 0 = at the window low, 100 = at the window high; null when flat. */
    rangePositionPct: number | null;
    changePctWindow: number;
    summary: string;
  } | null;
  /** v110: downside-protection status for THIS position — is there an active
   *  stop/trailing sell covering it, and how much downside cushion is left
   *  before it triggers? Merges the v76 protection audit into the position
   *  review so "how's it doing AND is it protected?" is one call. Present only
   *  when withProtection is requested. */
  protection?: {
    status: "protected" | "partial" | "unprotected";
    /** Base units covered by downside-protective sell orders. */
    protectedAmount: number;
    unprotectedAmount: number;
    /** The protective sell orders covering this position. */
    stops: Array<{ id: number; triggerType: string; trailPct: number | null; targetPriceUsd: number | null }>;
    /** For the HIGHEST fixed stop floor (price_below), how far the current
     *  price sits ABOVE it (% cushion before the stop fires). Null when there's
     *  no fixed-price stop or the position is unpriced. A trailing stop's
     *  giveback is its trailPct instead. */
    downsideToStopPct: number | null;
  } | null;
}

export interface OpenPositionsReport {
  mode: "real" | "paper";
  generatedAt: string;
  positions: OpenPositionEntry[];
  totalCostBasisQuote: number;
  /** Sum of priced positions' current value. */
  totalValueQuote: number;
  /** Sum of priced positions' unrealized P&L. */
  totalUnrealizedQuote: number;
  /** Open positions the oracle couldn't price. */
  unpricedCount: number;
  /** Short-term positions within APPROACHING_LONG_TERM_DAYS of long-term. */
  approachingLongTerm: number;
}

export async function gatherOpenPositions(args: {
  mode: "real" | "paper";
  account?: string;
  chain?: string;
  strategy?: string;
  config?: Config;
  /** Test seam: mark-price fetcher. Production uses defaultPaperPriceFetcher
   *  (live); null/omitted leaves positions unpriced (cost basis still exact). */
  markPriceFn?: PaperPriceFetcher;
  now?: Date;
  /** v67: attach recent price context (range position + trend) per position
   *  for exit timing. Off by default — it fetches a price series per token
   *  (cheap on the v66 cache, but a cold portfolio is N CoinGecko calls). */
  withContext?: boolean;
  /** Lookback window (days) for the price context. Default 7. */
  contextDays?: number;
  /** Test seam: the price-series fetcher (passed through to fetchPriceSeries). */
  seriesFetchImpl?: (url: string) => Promise<unknown>;
  /** v110: annotate each position with its downside-protection status (active
   *  stop/trailing coverage + cushion). Off by default — loads active orders. */
  withProtection?: boolean;
  /** Test seam: the active sell orders feeding the protection annotation. */
  protOrdersImpl?: () => import("./positionProtection.js").ProtOrderLite[];
}): Promise<OpenPositionsReport> {
  const config = args.config ?? loadConfig();
  const now = args.now ?? new Date();
  const FLAT = 1e-9;

  // ── gather fills (same adapter shape gains.ts uses) ──
  let rows: PaperTradeRow[];
  if (args.mode === "paper") {
    rows = listPaperTrades({}) as PaperTradeRow[];
    if (args.account) rows = rows.filter((r) => r.account === args.account);
    if (args.chain) { const c = args.chain.toLowerCase(); rows = rows.filter((r) => r.chain === c); }
    if (args.strategy) rows = rows.filter((r) => r.strategy === args.strategy);
  } else {
    const { toMtmRows } = await import("./strategyReport.js");
    const trades = recentTrades({ account: args.account, chain: args.chain, strategy: args.strategy, limit: 100_000 });
    rows = toMtmRows(trades);
  }
  // Strip the strategy tag so the walker merges by (chain, token) into ONE
  // portfolio-level bucket (your total WETH basis, not per-strategy slices).
  // A `strategy` filter already narrowed the rows above.
  const merged = rows.map((r) => ({ ...r, strategy: "open" }));

  let fetchPrice: PaperPriceFetcher;
  if (args.markPriceFn) {
    fetchPrice = args.markPriceFn;
  } else {
    const { defaultPaperPriceFetcher } = await import("./paperPnl.js");
    const { createSilentLogger } = await import("./logger.js");
    fetchPrice = defaultPaperPriceFetcher(config, createSilentLogger());
  }

  const report = await computePaperPnlMtm(merged, fetchPrice, { nowIso: now.toISOString() });

  const positions: OpenPositionEntry[] = [];
  let totalCostBasis = 0;
  let totalValue = 0;
  let totalUnrealized = 0;
  let unpriced = 0;
  let approaching = 0;

  for (const bucket of report.summaries) {
    for (const p of bucket.positions) {
      if (p.amount <= FLAT) continue; // open positions only
      const costBasisQuote = p.amount * p.avgCostQuote;
      const holdingDays =
        p.acquiredAt != null ? Math.max(0, (now.getTime() - Date.parse(p.acquiredAt)) / 86_400_000) : null;
      const projectedTerm: GainTerm =
        holdingDays == null ? "untracked" : holdingDays > LONG_TERM_DAYS ? "long" : "short";
      const daysToLongTerm = projectedTerm === "short" ? Math.max(0, LONG_TERM_DAYS - (holdingDays ?? 0)) : null;
      const unrealizedPct =
        p.unrealizedQuote != null && costBasisQuote > 0 ? (p.unrealizedQuote / costBasisQuote) * 100 : null;

      totalCostBasis += costBasisQuote;
      if (p.valueQuote != null) totalValue += p.valueQuote;
      if (p.unrealizedQuote != null) totalUnrealized += p.unrealizedQuote;
      if (p.currentPriceQuote == null) unpriced += 1;
      if (projectedTerm === "short" && daysToLongTerm != null && daysToLongTerm <= APPROACHING_LONG_TERM_DAYS) {
        approaching += 1;
      }

      positions.push({
        chain: p.chain,
        token: p.token,
        symbol: p.symbol,
        amount: p.amount,
        avgCostQuote: p.avgCostQuote,
        costBasisQuote,
        currentPriceQuote: p.currentPriceQuote,
        valueQuote: p.valueQuote,
        unrealizedQuote: p.unrealizedQuote,
        unrealizedPct,
        acquiredAt: p.acquiredAt,
        holdingDays,
        projectedTerm,
        daysToLongTerm,
      });
    }
  }
  // Largest current value first (unpriced trail).
  positions.sort((a, b) => (b.valueQuote ?? -1) - (a.valueQuote ?? -1));

  // v67: optional per-position price context (range/trend) for exit timing.
  // Fetched in parallel; the v66 series cache + in-flight dedup absorb
  // repeated/duplicate tokens. Native positions resolve to WETH for the
  // CoinGecko id; unmapped tokens degrade to priceContext: null.
  if (args.withContext && positions.length > 0) {
    const { gatherPriceContext } = await import("./priceContext.js");
    const { resolveProfile } = await import("./config.js");
    const { NATIVE_TOKEN } = await import("./tokens.js");
    const days = args.contextDays ?? 7;
    await Promise.all(
      positions.map(async (p) => {
        try {
          const profile = resolveProfile(p.chain, config);
          const addr = p.token === NATIVE_TOKEN ? profile.weth : p.token;
          if (!addr) { p.priceContext = null; return; }
          const ctx = await gatherPriceContext({ tokenAddress: addr, windowDays: days, config, now, fetchImpl: args.seriesFetchImpl });
          p.priceContext = ctx == null ? null : {
            windowDays: ctx.windowDays,
            low: ctx.low,
            high: ctx.high,
            rangePositionPct: ctx.rangePositionPct,
            changePctWindow: ctx.changePctWindow,
            summary: ctx.summary,
          };
        } catch {
          p.priceContext = null; // a series-fetch hiccup never breaks the review
        }
      }),
    );
  }

  // v110: per-position downside-protection status. Reuses the v76 computeProtection
  // matcher (positions × active protective sell orders) so the position review and
  // the protection audit can't disagree. Real mode uses real orders; paper uses
  // paper orders. Best-effort: any failure leaves protection undefined.
  if (args.withProtection && positions.length > 0) {
    try {
      const { computeProtection } = await import("./positionProtection.js");
      let orders = args.protOrdersImpl?.();
      if (orders == null) {
        const { listOrders } = await import("./db.js");
        const wantPaper = args.mode === "paper";
        orders = listOrders({ status: "active" })
          .filter((o) => o.side === "sell" && Boolean(o.paper) === wantPaper)
          .map((o) => ({
            id: o.id!,
            chain: o.chain,
            base_token: o.base_token,
            side: o.side,
            trigger_type: o.trigger_type,
            base_amount: o.base_amount,
            trail_pct: o.trail_pct,
            target_price_usd: o.target_price_usd,
          }));
      }
      const protPositions = positions.map((p) => ({
        chain: p.chain, token: p.token, symbol: p.symbol,
        amount: p.amount, currentPriceQuote: p.currentPriceQuote, valueQuote: p.valueQuote,
      }));
      const prot = computeProtection(protPositions, orders, now);
      const byKey = new Map(prot.positions.map((pp) => [`${pp.chain}:${pp.token.toLowerCase()}`, pp]));
      for (const p of positions) {
        const pp = byKey.get(`${p.chain}:${p.token.toLowerCase()}`);
        if (!pp) { p.protection = null; continue; }
        // Cushion to the HIGHEST fixed stop floor (the first to fire on a drop).
        let downsideToStopPct: number | null = null;
        const floors = pp.protectingOrders.map((o) => o.targetPriceUsd).filter((t): t is number => t != null && t > 0);
        if (floors.length > 0 && p.currentPriceQuote != null && p.currentPriceQuote > 0) {
          const highestFloor = Math.max(...floors);
          downsideToStopPct = ((p.currentPriceQuote - highestFloor) / p.currentPriceQuote) * 100;
        }
        p.protection = {
          status: pp.status,
          protectedAmount: pp.protectedAmount,
          unprotectedAmount: pp.unprotectedAmount,
          stops: pp.protectingOrders.map((o) => ({ id: o.id, triggerType: o.triggerType, trailPct: o.trailPct, targetPriceUsd: o.targetPriceUsd })),
          downsideToStopPct,
        };
      }
    } catch {
      // protection annotation is best-effort — never break the position review.
    }
  }

  return {
    mode: args.mode,
    generatedAt: now.toISOString(),
    positions,
    totalCostBasisQuote: totalCostBasis,
    totalValueQuote: totalValue,
    totalUnrealizedQuote: totalUnrealized,
    unpricedCount: unpriced,
    approachingLongTerm: approaching,
  };
}

export function renderOpenPositions(r: OpenPositionsReport): string {
  const lines: string[] = [];
  const usd = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
  lines.push(`Open positions (${r.mode}) — ${r.positions.length} held`);
  if (r.positions.length === 0) {
    lines.push(`  (no open tracked positions)`);
    return lines.join("\n");
  }
  lines.push(
    `  Cost basis ${usd(r.totalCostBasisQuote)} · value ${usd(r.totalValueQuote)} · unrealized ${r.totalUnrealizedQuote >= 0 ? "+" : ""}${usd(r.totalUnrealizedQuote)}` +
      (r.unpricedCount > 0 ? ` · ${r.unpricedCount} unpriced` : "") +
      (r.approachingLongTerm > 0 ? ` · ${r.approachingLongTerm} approaching long-term` : ""),
  );
  lines.push(``);
  for (const p of r.positions) {
    const term =
      p.projectedTerm === "long"
        ? "long-term"
        : p.projectedTerm === "short"
          ? `short-term${p.daysToLongTerm != null ? ` (${p.daysToLongTerm.toFixed(0)}d to long)` : ""}`
          : "untracked";
    const pnl =
      p.unrealizedQuote != null
        ? `${p.unrealizedQuote >= 0 ? "+" : ""}${usd(p.unrealizedQuote)}${p.unrealizedPct != null ? ` (${p.unrealizedPct >= 0 ? "+" : ""}${p.unrealizedPct.toFixed(1)}%)` : ""}`
        : "unpriced";
    lines.push(
      `  ${(p.symbol ?? p.token.slice(0, 8)).padEnd(8)} ${p.amount.toPrecision(4)} · basis ${usd(p.costBasisQuote)} · value ${usd(p.valueQuote)} · ${pnl}`,
    );
    lines.push(
      `           held ${p.holdingDays != null ? `${p.holdingDays.toFixed(0)}d` : "—"} · ${term}${p.acquiredAt ? ` · since ${p.acquiredAt.slice(0, 10)}` : ""}`,
    );
    if (p.priceContext !== undefined) {
      const c = p.priceContext;
      lines.push(
        c == null
          ? `           price ctx: — (no CoinGecko mapping)`
          : `           price ctx: ${c.changePctWindow >= 0 ? "+" : ""}${c.changePctWindow.toFixed(1)}% over ${c.windowDays}d · ${c.rangePositionPct != null ? `${c.rangePositionPct.toFixed(0)}% of range` : "flat range"}`,
      );
    }
    if (p.protection !== undefined && p.protection !== null) {
      const pr = p.protection;
      const badge = pr.status === "protected" ? "🛡 protected" : pr.status === "partial" ? "⚠ partial" : "🔴 UNPROTECTED";
      const stopDesc = pr.stops.length === 0
        ? ""
        : " · " + pr.stops.map((s) => s.trailPct != null ? `${s.trailPct}% trail` : s.targetPriceUsd != null ? `stop $${s.targetPriceUsd}` : s.triggerType).join(", ") +
          (pr.downsideToStopPct != null ? ` (${pr.downsideToStopPct.toFixed(1)}% cushion)` : "");
      lines.push(`           protection: ${badge}${stopDesc}`);
    } else if (p.protection === null) {
      lines.push(`           protection: 🔴 UNPROTECTED`);
    }
  }
  return lines.join("\n");
}
