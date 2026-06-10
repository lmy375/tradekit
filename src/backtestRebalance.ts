// ──────────────────────────────────────────────────────────────────
// Rebalance backtest: replay a target-weight plan against historical
// multi-asset price series.
//
// Closes the last backtest gap. Orders / schedules / playbooks could
// be validated historically since iter16; rebalance plans were
// documented as "intrinsically multi-asset, unsupported". This module
// makes them first-class: an operator can answer "would 60/40
// ETH/USDC with a 5% drift threshold have beaten plain HODL over the
// last year, and how many corrections would it have fired?" BEFORE
// deploying the plan.
//
// Design notes:
//
//  1. Multi-series clock. Each target token gets its own CoinGecko
//     series; their sample timestamps don't align exactly. Instead of
//     matching cron minutes against datapoints (the single-pair
//     simulators' approach — fragile when samples land at :07), we
//     walk the cron's OCCURRENCES from window start to window end via
//     nextRun(), and price every symbol at each occurrence with an
//     at-or-before lookup (monotonic pointers, O(total points)).
//     An occurrence before some symbol's first sample is skipped.
//
//  2. Leg mechanics mirror the live engine (rebalance.ts):
//       fire ⇔ maxDrift ≥ driftThresholdPct
//       over-weight targets SELL the USD excess into the quote anchor
//       under-weight targets BUY the USD deficit from the quote anchor
//       sells run first (they fund the buys), per-leg minTradeUsd skip
//     The quote anchor is a real balance-sheet entry in the sim: if
//     buys outrun the anchor balance (sell legs skipped by
//     minTradeUsd, or slippage drag), the shortfall leg is CLAMPED to
//     the available anchor and noted — money is never minted.
//
//  3. Slippage model matches paper trading: worst-case. Each leg
//     loses slippageBps/10000 of its USD notional (sells receive
//     less anchor; buys receive fewer units). Default 0 so the
//     headline number isolates the pure rebalancing effect; pass
//     --slippage-bps to stress it.
//
//  4. Counterfactual: HODL the initial balance, value it at
//     window-end prices. pnl − holdPnl is the rebalancing alpha
//     (often negative in trending markets, positive in mean-
//     reverting chop — that's exactly the insight the operator
//     wants before committing).
// ──────────────────────────────────────────────────────────────────

import { ToolError } from "./errors.js";
import { parseCron, nextRun, type ParsedCron } from "./cron.js";
import type { PriceSeries, SymbolBalance } from "./backtest.js";

export interface RebalanceBacktestTarget {
  /** Symbol key into the series map + balance map (e.g. "ETH"). */
  symbol: string;
  targetPct: number;
}

export interface RebalanceBacktestSpec {
  targets: RebalanceBacktestTarget[];
  /** Fire when max per-target drift ≥ this. Default 5. */
  driftThresholdPct?: number;
  /** Per-leg USD minimum; smaller corrective legs skip. Default 10. */
  minTradeUsd?: number;
  /** Evaluation cadence (cron). Default: every 6 hours — the same
   *  default cadence the live engine uses. */
  cron?: string;
  /** Lifetime cap on EXECUTED rebalances (parity with max_runs). */
  maxRuns?: number;
  /** Worst-case slippage applied per leg, in bps. Default 0. */
  slippageBps?: number;
  /** Symbol used as the routing anchor (must be one of the series
   *  keys; conventionally a stablecoin). Default "USDC". */
  quoteSymbol?: string;
}

export interface RebalanceLeg {
  symbol: string;
  side: "sell" | "buy";
  /** USD notional of the leg (pre-slippage). */
  amountUsd: number;
  /** Units of `symbol` moved (signed by side at the balance level;
   *  reported positive here). */
  units: number;
  priceUsd: number;
  /** True when the leg was clamped to the available anchor balance. */
  clamped?: boolean;
}

export interface RebalanceBacktestFire {
  ts: string;
  /** Max per-target drift (pct points) that triggered this fire. */
  maxDriftPct: number;
  portfolioUsdBefore: number;
  portfolioUsdAfter: number;
  legs: RebalanceLeg[];
  /** Corrective legs skipped because |deltaUsd| < minTradeUsd. */
  skippedLegs: number;
}

export interface RebalanceBacktestResult {
  /** Cron occurrences evaluated inside the window. */
  evaluations: number;
  /** Occurrences where maxDrift < threshold (no fire). */
  skippedInBand: number;
  fires: RebalanceBacktestFire[];
  finalBalance: SymbolBalance;
  initialUsd: number;
  finalUsd: number;
  pnlUsd: number;
  /** HODL counterfactual: initial balance at window-end prices. */
  holdFinalUsd: number;
  holdPnlUsd: number;
  notes: string[];
  windowStart: string;
  windowEnd: string;
}

// ── validation ───────────────────────────────────────────────

export function validateRebalanceBacktestSpec(spec: RebalanceBacktestSpec): {
  parsedCron: ParsedCron;
  driftThresholdPct: number;
  minTradeUsd: number;
  slippageBps: number;
  quoteSymbol: string;
} {
  if (!Array.isArray(spec.targets) || spec.targets.length < 2) {
    throw new ToolError("INVALID_PARAMS", "rebalance backtest requires at least 2 targets.");
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const t of spec.targets) {
    const sym = t.symbol?.toUpperCase?.();
    if (!sym) throw new ToolError("INVALID_PARAMS", "every target needs a symbol.");
    if (seen.has(sym)) throw new ToolError("INVALID_PARAMS", `duplicate target symbol ${sym}.`);
    seen.add(sym);
    if (!Number.isFinite(t.targetPct) || t.targetPct <= 0 || t.targetPct > 100) {
      throw new ToolError("INVALID_PARAMS", `targetPct for ${sym} must be in (0, 100] (got ${t.targetPct}).`);
    }
    sum += t.targetPct;
  }
  if (Math.abs(sum - 100) > 0.01) {
    throw new ToolError("INVALID_PARAMS", `targets must sum to exactly 100% (got ${sum.toFixed(4)}%).`);
  }
  const driftThresholdPct = spec.driftThresholdPct ?? 5;
  if (!Number.isFinite(driftThresholdPct) || driftThresholdPct <= 0 || driftThresholdPct >= 100) {
    throw new ToolError("INVALID_PARAMS", `driftThresholdPct must be in (0, 100) (got ${spec.driftThresholdPct}).`);
  }
  const minTradeUsd = spec.minTradeUsd ?? 10;
  if (!Number.isFinite(minTradeUsd) || minTradeUsd < 0) {
    throw new ToolError("INVALID_PARAMS", `minTradeUsd must be >= 0 (got ${spec.minTradeUsd}).`);
  }
  const slippageBps = spec.slippageBps ?? 0;
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new ToolError("INVALID_PARAMS", `slippageBps must be in [0, 10000] (got ${spec.slippageBps}).`);
  }
  if (spec.maxRuns != null && (!Number.isInteger(spec.maxRuns) || spec.maxRuns <= 0)) {
    throw new ToolError("INVALID_PARAMS", `maxRuns must be a positive integer.`);
  }
  const parsedCron = parseCron(spec.cron ?? "0 */6 * * *");
  const quoteSymbol = (spec.quoteSymbol ?? "USDC").toUpperCase();
  return { parsedCron, driftThresholdPct, minTradeUsd, slippageBps, quoteSymbol };
}

// ── at-or-before price lookup ────────────────────────────────

/** Monotonic per-symbol cursor over a sorted series. The simulator's
 *  evaluation times are non-decreasing, so each cursor only moves
 *  forward — the whole run is O(Σ series points). */
class SeriesCursor {
  private idx = -1;
  constructor(private readonly points: PriceSeries["points"]) {}
  /** Latest price at-or-before `ts`, or null when ts predates the
   *  first sample. */
  priceAt(ts: string): number | null {
    while (this.idx + 1 < this.points.length && this.points[this.idx + 1].ts <= ts) {
      this.idx += 1;
    }
    return this.idx >= 0 ? this.points[this.idx].priceUsd : null;
  }
}

// Hard cap on cron occurrences — a "* * * * *" cron over 3650 days is
// 5.25M occurrences; nobody needs minute-level rebalance evaluation
// over years. 200k keeps worst-case runtime sane and the error names
// the fix.
const MAX_EVALUATIONS = 200_000;

// ── simulator ────────────────────────────────────────────────

/**
 * Pure: replay a rebalance plan against per-symbol price series.
 *
 * `series` must contain an entry for EVERY target symbol AND the
 * quote anchor. `initialBalance` is units per symbol (missing keys
 * default to 0).
 */
export function simulateRebalance(args: {
  spec: RebalanceBacktestSpec;
  initialBalance: SymbolBalance;
  series: Record<string, PriceSeries>;
}): RebalanceBacktestResult {
  const { parsedCron, driftThresholdPct, minTradeUsd, slippageBps, quoteSymbol } =
    validateRebalanceBacktestSpec(args.spec);
  const targets = args.spec.targets.map((t) => ({ symbol: t.symbol.toUpperCase(), targetPct: t.targetPct }));

  // Resolve + validate the series map.
  const symbols = new Set<string>(targets.map((t) => t.symbol));
  symbols.add(quoteSymbol);
  const cursors = new Map<string, SeriesCursor>();
  let windowStartMs = Number.POSITIVE_INFINITY;
  let windowEndMs = Number.NEGATIVE_INFINITY;
  for (const sym of symbols) {
    const s = args.series[sym] ?? args.series[sym.toLowerCase()];
    if (!s || s.points.length === 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `missing price series for ${sym} — every target (and the quote anchor ${quoteSymbol}) needs one.`,
      );
    }
    cursors.set(sym, new SeriesCursor(s.points));
    windowStartMs = Math.min(windowStartMs, Date.parse(s.points[0].ts));
    windowEndMs = Math.max(windowEndMs, Date.parse(s.points[s.points.length - 1].ts));
  }
  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = new Date(windowEndMs).toISOString();

  // Normalized working balance (uppercase keys, missing → 0).
  const balance: SymbolBalance = {};
  for (const sym of symbols) balance[sym] = 0;
  for (const [k, v] of Object.entries(args.initialBalance)) {
    const sym = k.toUpperCase();
    if (!symbols.has(sym)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `initial balance has ${sym} which is neither a target nor the quote anchor — the simulator can't price it.`,
      );
    }
    if (!Number.isFinite(v) || v < 0) {
      throw new ToolError("INVALID_PARAMS", `initial balance for ${sym} must be a non-negative number.`);
    }
    balance[sym] = v;
  }

  const fires: RebalanceBacktestFire[] = [];
  const notes: string[] = [];
  let evaluations = 0;
  let skippedInBand = 0;
  let skippedUnpriced = 0;
  const maxRuns = args.spec.maxRuns ?? Number.POSITIVE_INFINITY;

  const priceAll = (ts: string): Map<string, number> | null => {
    const out = new Map<string, number>();
    for (const [sym, cursor] of cursors) {
      const p = cursor.priceAt(ts);
      if (p == null) return null; // some symbol has no sample yet
      out.set(sym, p);
    }
    return out;
  };

  // Capture window-start prices for the initial valuation + HODL
  // counterfactual. First occurrence where every symbol has a price.
  let initialUsd: number | null = null;
  const initialUnits: SymbolBalance = { ...balance };

  // Walk cron occurrences across the window.
  let t = nextRun(parsedCron, new Date(windowStartMs - 60_000));
  while (t.getTime() <= windowEndMs) {
    if (evaluations >= MAX_EVALUATIONS) {
      notes.push(`evaluation cap (${MAX_EVALUATIONS}) reached — use a coarser cron for long windows`);
      break;
    }
    const ts = t.toISOString();
    const prices = priceAll(ts);
    if (prices == null) {
      skippedUnpriced += 1;
      t = nextRun(parsedCron, new Date(t.getTime() + 1000));
      continue;
    }
    evaluations += 1;

    let portfolioUsd = 0;
    for (const sym of symbols) portfolioUsd += balance[sym] * prices.get(sym)!;
    if (initialUsd == null) initialUsd = portfolioUsd;

    if (portfolioUsd <= 0) {
      skippedInBand += 1;
      t = nextRun(parsedCron, new Date(t.getTime() + 1000));
      continue;
    }

    // Per-target drift (the quote anchor participates only when it's
    // itself a target — same as the live engine).
    let maxDriftPct = 0;
    const deltas: Array<{ symbol: string; deltaUsd: number }> = [];
    for (const tgt of targets) {
      const currentUsd = balance[tgt.symbol] * prices.get(tgt.symbol)!;
      const currentPct = (currentUsd / portfolioUsd) * 100;
      const drift = Math.abs(currentPct - tgt.targetPct);
      maxDriftPct = Math.max(maxDriftPct, drift);
      deltas.push({ symbol: tgt.symbol, deltaUsd: (tgt.targetPct / 100) * portfolioUsd - currentUsd });
    }

    if (maxDriftPct < driftThresholdPct || fires.length >= maxRuns) {
      skippedInBand += 1;
      t = nextRun(parsedCron, new Date(t.getTime() + 1000));
      continue;
    }

    // Fire: sells first (fund the anchor), then buys.
    const legs: RebalanceLeg[] = [];
    let skippedLegs = 0;
    const slip = slippageBps / 10_000;
    const quotePrice = prices.get(quoteSymbol)!;

    for (const d of deltas) {
      if (d.symbol === quoteSymbol) continue; // anchor corrects implicitly
      if (d.deltaUsd < 0) {
        const sellUsd = -d.deltaUsd;
        if (sellUsd < minTradeUsd) { skippedLegs += 1; continue; }
        const px = prices.get(d.symbol)!;
        const units = Math.min(sellUsd / px, balance[d.symbol]);
        if (units <= 0) { skippedLegs += 1; continue; }
        const usdMoved = units * px;
        balance[d.symbol] -= units;
        // Worst-case slippage: receive less anchor than the notional.
        balance[quoteSymbol] += (usdMoved * (1 - slip)) / quotePrice;
        legs.push({ symbol: d.symbol, side: "sell", amountUsd: usdMoved, units, priceUsd: px });
      }
    }
    for (const d of deltas) {
      if (d.symbol === quoteSymbol) continue;
      if (d.deltaUsd > 0) {
        let buyUsd = d.deltaUsd;
        if (buyUsd < minTradeUsd) { skippedLegs += 1; continue; }
        const anchorUsd = balance[quoteSymbol] * quotePrice;
        let clamped = false;
        if (buyUsd > anchorUsd) {
          // Anchor can't fund the full leg (sell legs skipped, or
          // slippage drag). Clamp — never mint.
          buyUsd = anchorUsd;
          clamped = true;
          if (buyUsd < minTradeUsd) { skippedLegs += 1; continue; }
        }
        const px = prices.get(d.symbol)!;
        balance[quoteSymbol] -= buyUsd / quotePrice;
        // Worst-case slippage: receive fewer units for the notional.
        const units = (buyUsd * (1 - slip)) / px;
        balance[d.symbol] += units;
        legs.push({ symbol: d.symbol, side: "buy", amountUsd: buyUsd, units, priceUsd: px, ...(clamped ? { clamped: true } : {}) });
        if (clamped) notes.push(`${ts}: buy leg for ${d.symbol} clamped to available ${quoteSymbol} anchor`);
      }
    }

    if (legs.length === 0) {
      // Everything below minTradeUsd — economically in-band.
      skippedInBand += 1;
      t = nextRun(parsedCron, new Date(t.getTime() + 1000));
      continue;
    }

    let portfolioAfter = 0;
    for (const sym of symbols) portfolioAfter += balance[sym] * prices.get(sym)!;
    fires.push({
      ts,
      maxDriftPct,
      portfolioUsdBefore: portfolioUsd,
      portfolioUsdAfter: portfolioAfter,
      legs,
      skippedLegs,
    });

    t = nextRun(parsedCron, new Date(t.getTime() + 1000));
  }

  if (skippedUnpriced > 0) {
    notes.push(`${skippedUnpriced} occurrence(s) skipped before every symbol had a price sample`);
  }
  if (evaluations === 0) {
    notes.push("cron never produced an evaluable occurrence inside the data window — check the cadence vs the series span");
  }
  if (args.spec.maxRuns != null && fires.length >= args.spec.maxRuns) {
    notes.push(`max-runs cap (${args.spec.maxRuns}) reached`);
  }

  // Final + counterfactual valuation at window-end prices.
  const endPrices = priceAll(windowEnd);
  let finalUsd = 0;
  let holdFinalUsd = 0;
  if (endPrices) {
    for (const sym of symbols) {
      finalUsd += balance[sym] * endPrices.get(sym)!;
      holdFinalUsd += (initialUnits[sym] ?? 0) * endPrices.get(sym)!;
    }
  }
  const initUsd = initialUsd ?? 0;

  return {
    evaluations,
    skippedInBand,
    fires,
    finalBalance: balance,
    initialUsd: initUsd,
    finalUsd,
    pnlUsd: finalUsd - initUsd,
    holdFinalUsd,
    holdPnlUsd: holdFinalUsd - initUsd,
    notes,
    windowStart,
    windowEnd,
  };
}

/** Synthesize a flat series (price 1.0) — for stablecoin anchors the
 *  caller doesn't want to burn a CoinGecko call on. Spans the given
 *  window at daily resolution. */
export function constantSeries(symbol: string, windowStartIso: string, windowEndIso: string, priceUsd = 1): PriceSeries {
  const start = Date.parse(windowStartIso);
  const end = Date.parse(windowEndIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new ToolError("INVALID_PARAMS", `invalid window for constant series (${windowStartIso} → ${windowEndIso}).`);
  }
  const points: PriceSeries["points"] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    points.push({ ts: new Date(t).toISOString(), priceUsd });
  }
  if (points.length === 0 || points[points.length - 1].ts < windowEndIso) {
    points.push({ ts: new Date(end).toISOString(), priceUsd });
  }
  return { coinId: `constant:${symbol.toLowerCase()}`, daysRequested: Math.ceil((end - start) / 86_400_000), points };
}

/** Default starting book: `totalUsd` split across the targets at
 *  their target weights, priced at each symbol's first sample. The
 *  natural baseline — the portfolio starts perfectly balanced, so
 *  every later fire is attributable to market drift, and the HODL
 *  counterfactual answers "did rebalancing add anything?". */
export function defaultInitialBalance(args: {
  spec: RebalanceBacktestSpec;
  series: Record<string, PriceSeries>;
  totalUsd?: number;
}): SymbolBalance {
  const total = args.totalUsd ?? 10_000;
  if (!Number.isFinite(total) || total <= 0) {
    throw new ToolError("INVALID_PARAMS", `initial total USD must be positive (got ${args.totalUsd}).`);
  }
  const out: SymbolBalance = {};
  for (const t of args.spec.targets) {
    const sym = t.symbol.toUpperCase();
    const s = args.series[sym] ?? args.series[sym.toLowerCase()];
    if (!s || s.points.length === 0) {
      throw new ToolError("INVALID_PARAMS", `missing price series for ${sym}.`);
    }
    const px = s.points[0].priceUsd;
    out[sym] = (total * t.targetPct) / 100 / px;
  }
  return out;
}
