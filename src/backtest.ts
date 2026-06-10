/**
 * Historical strategy simulation.
 *
 * Replays a single order or schedule against a CoinGecko market-chart
 * price series + a starting balance. Pure timeline-walker — fetches
 * the series once, then walks it left-to-right evaluating the trigger
 * at each datapoint. Persists the result to backtest_runs so the
 * operator can re-inspect via `tradekit backtest show <id>`.
 *
 * What this is NOT:
 *   - Not a multi-strategy simulator. v1 scopes to one order OR one
 *     schedule at a time. Multi-strategy interactions (e.g. one
 *     schedule's fill firing another order's trigger) need explicit
 *     ordering rules + shared-state coordination that's deferred.
 *   - Not a gas/slippage simulator. The data resolution (hourly at
 *     best, daily for long windows) doesn't support modeling pool
 *     impact. Fill prices are taken directly from the series.
 *   - Not a safety-guardrail simulator. Operators want to know "would
 *     the trigger have fired"; safety would mask that signal. Manual
 *     audit of the strategy spec is the right place for guardrail
 *     review.
 *
 * Why it's still useful: a one-fire trailing-stop result tells the
 * operator exactly when their 5% trail would have triggered + at
 * what price + with what cumulative PnL — that's the load-bearing
 * signal for "should I deploy this strategy". The simplifications
 * above are accepted in exchange for shipping the v1 in one
 * iteration rather than spreading it across a quarter.
 */

import { ToolError } from "./errors.js";
import { fetchWithTimeout } from "./http.js";
import { getCoinGeckoId } from "./price.js";
import { isOrderTriggered } from "./orders.js";
import { evaluateTrailingTrigger, type TrailingOrderView } from "./trailingStop.js";
import { parseCron, matchesAt, durationToCron, type ParsedCron } from "./cron.js";
import { parseOnFillSpec, renderOnFillSpec, onFillLegs, autoHookGroup, type OnFillSpec } from "./scheduleHooks.js";
import { parseSizingSentinel, applyFraction } from "./sizing.js";
import type { OrderSide, OrderTrigger } from "./db.js";

// ── price series ─────────────────────────────────────────────

export interface PricePoint {
  /** UTC timestamp the price was sampled at. ISO string for forensic
   *  inspection + sorting. */
  ts: string;
  /** USD-denominated price of one unit of the base token at `ts`. */
  priceUsd: number;
}

/**
 * Internal series shape after we've extracted + sorted. Kept thin —
 * the simulator only needs (ts, priceUsd) and the series cardinality.
 * Native CoinGecko data also includes market_caps / total_volumes
 * which we discard.
 */
export interface PriceSeries {
  coinId: string;
  /** Number of days requested when fetching. Determines resolution:
   *  ≤1 → 5-minute, ≤90 → hourly, >90 → daily. Persisted to backtest
   *  runs so re-runs can detect data-density mismatch. */
  daysRequested: number;
  points: PricePoint[];
}

/**
 * Fetch a USD price series for a token from CoinGecko's market_chart
 * endpoint. `days` controls both the window AND the resolution per
 * CoinGecko's free-tier rules:
 *   - days ≤ 1   → 5-minute samples
 *   - days ≤ 90  → hourly samples
 *   - days > 90  → daily samples
 *
 * Returns null when the token has no CoinGecko id (off-listing). Throws
 * INVALID_PARAMS when CoinGecko returns no points (token too new, or
 * id wrong). Network failures bubble up as the underlying fetch error.
 *
 * `fetchImpl` is an injection seam for tests.
 */
export async function fetchPriceSeries(
  tokenAddress: string,
  days: number,
  fetchImpl: (url: string) => Promise<unknown> = defaultFetchJson,
): Promise<PriceSeries | null> {
  const coinId = getCoinGeckoId(tokenAddress);
  if (!coinId) return null;
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--since out of range — expected 1..3650 days, got ${days}.`,
    );
  }
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`;
  const raw = (await fetchImpl(url)) as { prices?: [number, number][] } | undefined;
  const rows = raw?.prices ?? [];
  if (rows.length === 0) {
    throw new ToolError(
      "API_ERROR",
      `CoinGecko returned no price series for ${coinId} over ${days}d — token may be too new or the id mapping is wrong.`,
    );
  }
  // CoinGecko returns [ms_epoch, price]. Sort + de-dupe by minute (rare
  // duplicates at boundaries). Stable sort lets us pick the FIRST point
  // at each minute (= boundary representative).
  const seen = new Set<number>();
  const points: PricePoint[] = [];
  for (const [msEpoch, priceUsd] of rows) {
    if (!Number.isFinite(msEpoch) || !Number.isFinite(priceUsd)) continue;
    if (priceUsd <= 0) continue;
    const minuteBucket = Math.floor(msEpoch / 60_000);
    if (seen.has(minuteBucket)) continue;
    seen.add(minuteBucket);
    points.push({ ts: new Date(msEpoch).toISOString(), priceUsd });
  }
  points.sort((a, b) => a.ts.localeCompare(b.ts));
  return { coinId, daysRequested: days, points };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetchWithTimeout(url, undefined, { retries: 2 });
  if (!res.ok) {
    throw new ToolError(
      "API_ERROR",
      `CoinGecko request failed: ${res.status} ${res.statusText}`,
    );
  }
  return await res.json();
}

// ── shared types ─────────────────────────────────────────────

export type SymbolBalance = Record<string, number>;

export interface BacktestFire {
  ts: string;
  /** What the simulator decided to do at this datapoint. "fill" =
   *  a trade simulated successfully; "halt" = the strategy needed
   *  to fire but couldn't (e.g. insufficient balance); "skip" is
   *  not currently emitted (no-fire ticks are silent). */
  action: "fill" | "halt";
  /** USD price of base at this datapoint. */
  priceUsd: number;
  /** Signed change to base balance (positive on buy, negative on sell). */
  baseDelta: number;
  /** Signed change to quote balance (negative on buy, positive on sell). */
  quoteDelta: number;
  /** Human-readable note. "trigger fired", "insufficient quote balance",
   *  etc. Surfaced via `backtest show`. */
  note?: string;
}

export interface BacktestResult {
  /** All fires + halts, in chronological order. */
  fires: BacktestFire[];
  /** Final balance after all fires. */
  finalBalance: SymbolBalance;
  /** USD value of the initial balance at the window-start price. */
  initialUsd: number;
  /** USD value of the final balance at the window-end price. */
  finalUsd: number;
  /** Net PnL in USD. */
  pnlUsd: number;
  /** Counterfactual: USD value of the initial balance at window-end
   *  prices (i.e. "if I had done nothing"). */
  holdFinalUsd: number;
  /** Counterfactual: holdFinalUsd − initialUsd. */
  holdPnlUsd: number;
  /** Free-form notes from the simulator (e.g. "halted at ts X"). */
  notes: string[];
  /** Window boundaries from the price series — useful for the row's
   *  window_start / window_end columns. */
  windowStart: string;
  windowEnd: string;
}

// ── order simulation ─────────────────────────────────────────

export interface OrderBacktestSpec {
  side: OrderSide;
  /** Signal triggers replay only at the PLAYBOOK level (simulatePlaybook
   *  signals[]) where history can be provided; single-order mode —
   *  the CLI/MCP validators reject them before reaching here. */
  trigger: Exclude<OrderTrigger, "signal">;
  /** Required for price_below / price_above. For trailing, this is the
   *  optional activation gate. */
  targetPriceUsd?: number;
  /** Required for trailing orders. % retracement that triggers the fill. */
  trailPct?: number;
  /** Base amount to trade (sell-side) OR amount of base to buy (buy-side
   *  fixed-base mode). Mutually exclusive with quoteAmount. */
  baseAmount?: number;
  /** Quote amount to spend (buy-side, fixed-quote mode). Mutually
   *  exclusive with baseAmount. */
  quoteAmount?: number;
}

/**
 * Replay a single order against a price series. The order spec mirrors
 * what `tradekit order create` would persist; we evaluate the trigger
 * at each datapoint via the same pure helpers the live engine uses
 * (isOrderTriggered + evaluateTrailingTrigger), so simulation behavior
 * matches production behavior by construction.
 *
 * Stopping rules:
 *   1. Order fires → simulate one fill, then terminate. Single-shot
 *      orders fire at most once.
 *   2. Insufficient balance → emit a "halt" fire, terminate.
 *   3. End of series with no fire → emit no fire, terminate naturally.
 *
 * Trailing state is carried in a local variable (not in the spec)
 * since the spec is treated as immutable. The water-mark evolves
 * tick-by-tick exactly as the live engine would persist it.
 */
export function simulateOrder(args: {
  spec: OrderBacktestSpec;
  baseSymbol: string;
  quoteSymbol: string;
  initialBalance: SymbolBalance;
  series: PriceSeries;
}): BacktestResult {
  const { spec, baseSymbol, quoteSymbol, initialBalance, series } = args;
  validateOrderSpec(spec);
  const balance: SymbolBalance = normalizeBalance(initialBalance);
  const fires: BacktestFire[] = [];
  const notes: string[] = [];

  // Trail state, evolves as the simulator walks.
  let trailWaterMark: number | null = null;

  let fired = false;
  for (const pt of series.points) {
    if (fired) break;
    if (spec.trigger === "trailing") {
      const view: TrailingOrderView = {
        side: spec.side,
        trigger_type: "trailing",
        target_price_usd: spec.targetPriceUsd ?? null,
        trail_pct: spec.trailPct ?? null,
        water_mark_usd: trailWaterMark,
      };
      const evalRes = evaluateTrailingTrigger(view, pt.priceUsd);
      if (evalRes.tracking && evalRes.waterMarkChanged) {
        trailWaterMark = evalRes.nextWaterMark;
      }
      if (evalRes.triggered) {
        const fillResult = simulateFillAt({ spec, pt, balance, baseSymbol, quoteSymbol });
        fires.push(fillResult);
        if (fillResult.action === "halt") notes.push(fillResult.note ?? "halted");
        fired = true;
      }
    } else {
      const triggered = isOrderTriggered(
        { trigger_type: spec.trigger, target_price_usd: spec.targetPriceUsd ?? null },
        pt.priceUsd,
      );
      if (triggered) {
        const fillResult = simulateFillAt({ spec, pt, balance, baseSymbol, quoteSymbol });
        fires.push(fillResult);
        if (fillResult.action === "halt") notes.push(fillResult.note ?? "halted");
        fired = true;
      }
    }
  }

  if (!fired) notes.push(`order never triggered over the ${series.points.length} datapoints in window`);

  return buildResult({ initialBalance, balance, fires, notes, series, baseSymbol, quoteSymbol });
}

function validateOrderSpec(spec: OrderBacktestSpec): void {
  if (spec.trigger === "trailing") {
    if (spec.trailPct == null || !(spec.trailPct > 0 && spec.trailPct <= 100)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `trailing orders require --trail-pct in (0, 100]; got ${spec.trailPct}.`,
      );
    }
  } else {
    if (spec.targetPriceUsd == null || !(spec.targetPriceUsd > 0)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `${spec.trigger} orders require a positive --price; got ${spec.targetPriceUsd}.`,
      );
    }
  }
  const hasBase = spec.baseAmount != null && spec.baseAmount > 0;
  const hasQuote = spec.quoteAmount != null && spec.quoteAmount > 0;
  if (hasBase === hasQuote) {
    throw new ToolError(
      "INVALID_PARAMS",
      `provide exactly one of --baseAmount or --quoteAmount (positive). Got base=${spec.baseAmount}, quote=${spec.quoteAmount}.`,
    );
  }
  if (spec.side === "sell" && !hasBase) {
    throw new ToolError(
      "INVALID_PARAMS",
      `sell-side orders require --baseAmount (the amount of base to sell).`,
    );
  }
}

// ── schedule simulation ──────────────────────────────────────

export interface ScheduleBacktestSpec {
  side: OrderSide;
  /** 5-field cron expression. Generated from "--every 1d" upstream via
   *  durationToCron, OR passed directly via "--cron". */
  cron: string;
  baseAmount?: number;
  quoteAmount?: number;
  /** Optional cap on the number of fires. The engine has the same field
   *  (max_runs) so the semantics match production. */
  maxRuns?: number;
}

/**
 * Replay a recurring schedule against a price series.
 *
 * Walks the series; at each datapoint, checks if the cron expression
 * matches that minute AND the previous minute didn't (i.e. firing edge
 * detection — a cron that says "every minute" should fire once per
 * minute, not once per second when the data resolution is denser).
 *
 * Stopping rules:
 *   1. maxRuns fires accumulated → terminate.
 *   2. Insufficient balance for a scheduled fire → emit "halt", terminate.
 *   3. End of series → terminate naturally.
 *
 * Note on resolution: when the price data is hourly but the cron says
 * "every minute", the simulator only fires once per data-point (not
 * once per minute) because there's no inter-point price to use. We
 * accept that as a known limitation; the operator gets a warning when
 * the cron's natural cadence is finer than the data resolution.
 */
export function simulateSchedule(args: {
  spec: ScheduleBacktestSpec;
  baseSymbol: string;
  quoteSymbol: string;
  initialBalance: SymbolBalance;
  series: PriceSeries;
}): BacktestResult {
  const { spec, baseSymbol, quoteSymbol, initialBalance, series } = args;
  validateScheduleSpec(spec);
  const parsed = parseCron(spec.cron);
  const balance: SymbolBalance = normalizeBalance(initialBalance);
  const fires: BacktestFire[] = [];
  const notes: string[] = [];

  const maxRuns = spec.maxRuns ?? Number.POSITIVE_INFINITY;
  let runCount = 0;
  let lastFireMinute = -1; // minute bucket of last successful fire

  for (const pt of series.points) {
    if (runCount >= maxRuns) {
      notes.push(`max-runs cap (${maxRuns}) reached`);
      break;
    }
    const t = new Date(pt.ts);
    const minuteBucket = Math.floor(t.getTime() / 60_000);
    if (minuteBucket === lastFireMinute) continue;
    if (!matchesAt(parsed, t)) continue;

    const fillResult = simulateFillAt({
      spec: { side: spec.side, baseAmount: spec.baseAmount, quoteAmount: spec.quoteAmount },
      pt,
      balance,
      baseSymbol,
      quoteSymbol,
    });
    fires.push(fillResult);
    if (fillResult.action === "halt") {
      notes.push(fillResult.note ?? "halted");
      break;
    }
    runCount++;
    lastFireMinute = minuteBucket;
  }

  if (fires.length === 0) {
    notes.push(`schedule never matched a datapoint — check the cron cadence vs the data resolution (${series.points.length} datapoints)`);
  }

  return buildResult({ initialBalance, balance, fires, notes, series, baseSymbol, quoteSymbol });
}

function validateScheduleSpec(spec: ScheduleBacktestSpec): void {
  // parseCron throws INVALID_PARAMS on its own — defer to it.
  parseCron(spec.cron);
  const hasBase = spec.baseAmount != null && spec.baseAmount > 0;
  const hasQuote = spec.quoteAmount != null && spec.quoteAmount > 0;
  if (hasBase === hasQuote) {
    throw new ToolError(
      "INVALID_PARAMS",
      `schedule requires exactly one of --baseAmount or --quoteAmount. Got base=${spec.baseAmount}, quote=${spec.quoteAmount}.`,
    );
  }
  if (spec.side === "sell" && !hasBase) {
    throw new ToolError(
      "INVALID_PARAMS",
      `sell-side schedules require --baseAmount (amount of base to sell each fire).`,
    );
  }
  if (spec.maxRuns != null && (!Number.isInteger(spec.maxRuns) || spec.maxRuns <= 0)) {
    throw new ToolError("INVALID_PARAMS", `--max-runs must be a positive integer.`);
  }
}

// ── shared fill simulator ────────────────────────────────────

/**
 * Simulate one trade at a given datapoint.
 *
 * Buy-side semantics:
 *   - With baseAmount: buy exactly that much base. Cost = baseAmount * priceUsd.
 *     If quote balance < cost → halt (note "insufficient quote").
 *   - With quoteAmount: spend exactly that much quote. Acquire = quoteAmount /
 *     priceUsd. If quote balance < quoteAmount → halt.
 *
 * Sell-side semantics (only baseAmount is valid here):
 *   - With baseAmount: sell exactly that much base. Receive = baseAmount * priceUsd.
 *     If base balance < baseAmount → halt.
 *
 * The quote token is assumed to be USD-pegged (USDC/USDT/DAI). We don't
 * model quote drift because the strategies we backtest are intrinsically
 * priced in USD, and pretending otherwise would require fetching a
 * second price series + multiplying through. v1 accepts the assumption.
 */
function simulateFillAt(args: {
  spec: { side: OrderSide; baseAmount?: number; quoteAmount?: number };
  pt: PricePoint;
  balance: SymbolBalance;
  baseSymbol: string;
  quoteSymbol: string;
}): BacktestFire {
  const { spec, pt, balance, baseSymbol, quoteSymbol } = args;
  if (spec.side === "buy") {
    if (spec.baseAmount != null) {
      const cost = spec.baseAmount * pt.priceUsd;
      const available = balance[quoteSymbol] ?? 0;
      if (available < cost) {
        return {
          ts: pt.ts,
          action: "halt",
          priceUsd: pt.priceUsd,
          baseDelta: 0,
          quoteDelta: 0,
          note: `insufficient ${quoteSymbol} (need ${formatNum(cost)}, have ${formatNum(available)})`,
        };
      }
      balance[quoteSymbol] = available - cost;
      balance[baseSymbol] = (balance[baseSymbol] ?? 0) + spec.baseAmount;
      return {
        ts: pt.ts,
        action: "fill",
        priceUsd: pt.priceUsd,
        baseDelta: spec.baseAmount,
        quoteDelta: -cost,
        note: `bought ${formatNum(spec.baseAmount)} ${baseSymbol} @ $${formatNum(pt.priceUsd)}`,
      };
    }
    if (spec.quoteAmount != null) {
      const available = balance[quoteSymbol] ?? 0;
      if (available < spec.quoteAmount) {
        return {
          ts: pt.ts,
          action: "halt",
          priceUsd: pt.priceUsd,
          baseDelta: 0,
          quoteDelta: 0,
          note: `insufficient ${quoteSymbol} (need ${formatNum(spec.quoteAmount)}, have ${formatNum(available)})`,
        };
      }
      const acquired = spec.quoteAmount / pt.priceUsd;
      balance[quoteSymbol] = available - spec.quoteAmount;
      balance[baseSymbol] = (balance[baseSymbol] ?? 0) + acquired;
      return {
        ts: pt.ts,
        action: "fill",
        priceUsd: pt.priceUsd,
        baseDelta: acquired,
        quoteDelta: -spec.quoteAmount,
        note: `bought ${formatNum(acquired)} ${baseSymbol} for ${formatNum(spec.quoteAmount)} ${quoteSymbol}`,
      };
    }
  }
  // sell — baseAmount only (validated upstream).
  const baseAvail = balance[baseSymbol] ?? 0;
  const baseAmount = spec.baseAmount ?? 0;
  if (baseAvail < baseAmount) {
    return {
      ts: pt.ts,
      action: "halt",
      priceUsd: pt.priceUsd,
      baseDelta: 0,
      quoteDelta: 0,
      note: `insufficient ${baseSymbol} (need ${formatNum(baseAmount)}, have ${formatNum(baseAvail)})`,
    };
  }
  const proceeds = baseAmount * pt.priceUsd;
  balance[baseSymbol] = baseAvail - baseAmount;
  balance[quoteSymbol] = (balance[quoteSymbol] ?? 0) + proceeds;
  return {
    ts: pt.ts,
    action: "fill",
    priceUsd: pt.priceUsd,
    baseDelta: -baseAmount,
    quoteDelta: proceeds,
    note: `sold ${formatNum(baseAmount)} ${baseSymbol} @ $${formatNum(pt.priceUsd)}`,
  };
}

// ── result builder ───────────────────────────────────────────

function buildResult(args: {
  initialBalance: SymbolBalance;
  balance: SymbolBalance;
  fires: BacktestFire[];
  notes: string[];
  series: PriceSeries;
  baseSymbol: string;
  quoteSymbol: string;
}): BacktestResult {
  const { initialBalance, balance, fires, notes, series, baseSymbol, quoteSymbol } = args;
  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  const startPrice = first.priceUsd;
  const endPrice = last.priceUsd;

  const initialBase = initialBalance[baseSymbol] ?? 0;
  const initialQuote = initialBalance[quoteSymbol] ?? 0;
  const finalBase = balance[baseSymbol] ?? 0;
  const finalQuote = balance[quoteSymbol] ?? 0;

  // USD valuation uses the START price for initial (= price when the
  // strategy was deployed) and the END price for final. This matches
  // how an operator thinks about PnL: "I started with these tokens at
  // this point in time; here's what they're worth now".
  const initialUsd = initialBase * startPrice + initialQuote;
  const finalUsd = finalBase * endPrice + finalQuote;
  const pnlUsd = finalUsd - initialUsd;
  // Counterfactual: same initial balance at end prices, no trades.
  const holdFinalUsd = initialBase * endPrice + initialQuote;
  const holdPnlUsd = holdFinalUsd - initialUsd;

  return {
    fires,
    finalBalance: balance,
    initialUsd,
    finalUsd,
    pnlUsd,
    holdFinalUsd,
    holdPnlUsd,
    notes,
    windowStart: first.ts,
    windowEnd: last.ts,
  };
}

function normalizeBalance(b: SymbolBalance): SymbolBalance {
  const out: SymbolBalance = {};
  for (const [k, v] of Object.entries(b)) {
    if (!Number.isFinite(v) || v < 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--balance entry ${k}=${v} is not a finite non-negative number.`,
      );
    }
    out[k.toUpperCase()] = v;
  }
  return out;
}

function formatNum(x: number): string {
  if (!Number.isFinite(x)) return "?";
  if (Math.abs(x) >= 1) return x.toFixed(4);
  return x.toPrecision(4);
}

// ── "--since" parsing ────────────────────────────────────────

/**
 * Parse a "since" duration string into a CoinGecko `days` parameter.
 *
 * Accepts:
 *   - `Nd` → N (1..3650)
 *   - `Nw` → N * 7
 *   - `Nm` → N * 30  (calendar-month approximation)
 *
 * Falls back to a bare integer (= days). CoinGecko's resolution rules
 * apply downstream:
 *   - days ≤ 1   → 5-minute granularity
 *   - days ≤ 90  → hourly granularity
 *   - days > 90  → daily granularity
 *
 * Returns a number of days; throws INVALID_PARAMS on parse failure.
 */
export function parseSinceDuration(raw: string): number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (n < 1 || n > 3650) throw new ToolError("INVALID_PARAMS", `--since ${n} out of range (1..3650 days)`);
    return n;
  }
  const m = /^(\d+)([dwm])$/i.exec(trimmed);
  if (!m) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--since "${raw}" — use formats like 30d, 4w, 6m, or a bare integer (days).`,
    );
  }
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const mult = unit === "d" ? 1 : unit === "w" ? 7 : 30;
  const days = n * mult;
  if (days < 1 || days > 3650) {
    throw new ToolError("INVALID_PARAMS", `--since ${days}d out of range (1..3650 days)`);
  }
  return days;
}

// Re-export the parsed-cron shape so callers don't have to import from
// two places.
export type { ParsedCron };

// ── multi-strategy (playbook) backtest ───────────────────────
//
// Replays a full playbook spec against a single price series with a
// shared simulated balance. Composes the single-strategy machinery:
//   - per-order trail state (water mark, status)
//   - per-schedule cron + maxRuns state
//   - OCO cascade within the playbook (when a peer fires, other
//     active peers in the same group flip to "cancelled")
//   - shared balance — one strategy's fills move the balance the
//     next strategy sees
//
// Constraints v1: every strategy must reference the same base/quote
// symbol pair, and rebalance plans are unsupported (multi-asset).
// Operators get an explicit error pointing at the single-strategy
// `backtest order` / `backtest schedule` commands when those
// constraints don't hold.

import type { PlaybookSpec, OrderSpec, ScheduleSpec, StrategySpec } from "./playbooks.js";

export interface PlaybookBacktestFire extends BacktestFire {
  /** Local id of the strategy that fired this tick (the spec's `id`
   *  field, or `strategies[N]` when omitted). */
  strategyId: string;
  /** Type of the firing strategy — order / schedule. */
  strategyType: "order" | "schedule";
  /** Action specific to multi-strategy mode: "fill" (a trade), "halt"
   *  (insufficient balance — the strategy is parked as cancelled), or
   *  "oco_cascade" (this strategy was cancelled because a peer fired
   *  — emitted with priceUsd=0, baseDelta=0, quoteDelta=0). */
  multiAction: "fill" | "halt" | "oco_cascade";
}

export interface PlaybookStrategyStat {
  strategyId: string;
  type: "order" | "schedule";
  fireCount: number;
  /** Cumulative base token delta from all fires (positive=net bought,
   *  negative=net sold). For orders, this is at most one fire's worth;
   *  for schedules, it's the sum across all fires. */
  baseDelta: number;
  /** Cumulative quote delta. */
  quoteDelta: number;
  /** Final lifecycle status. "active" = never fired, never cancelled
   *  (the timeline ended before the trigger was satisfied).
   *  "filled" = order fired. "cancelled" = OCO-cascaded or halted on
   *  balance. "completed" = schedule hit maxRuns. */
  finalStatus: "active" | "filled" | "cancelled" | "completed";
}

export interface PlaybookBacktestResult {
  fires: PlaybookBacktestFire[];
  finalBalance: SymbolBalance;
  initialUsd: number;
  finalUsd: number;
  pnlUsd: number;
  holdFinalUsd: number;
  holdPnlUsd: number;
  notes: string[];
  windowStart: string;
  windowEnd: string;
  /** Per-strategy stats, keyed by local strategy id. */
  perStrategy: PlaybookStrategyStat[];
}

/** Walks a single price series, evaluating every order + schedule
 *  primitive in the playbook against a shared balance. The simulator
 *  reuses the production trigger predicates (isOrderTriggered,
 *  evaluateTrailingTrigger, matchesAt) so behavior matches the live
 *  engine. */
/** v39.5: a recorded (or hypothetical) signal arrival for replay.
 *  In production these come from the v35 signal_events inbox —
 *  "how would my strategy have done with the alerts I actually
 *  received?". */
export interface SimSignal {
  name: string;
  /** ISO arrival time. Signals before the series start are STALE
   *  (the order wasn't armed yet) and never fire — same semantics
   *  as the live engine's armed-from rule. */
  at: string;
}

export function simulatePlaybook(args: {
  spec: PlaybookSpec;
  baseSymbol: string;
  quoteSymbol: string;
  initialBalance: SymbolBalance;
  series: PriceSeries;
  /** v39.5: recorded signal history. REQUIRED for specs containing
   *  signal-triggered entries — without it they stay rejected (no
   *  history to replay is not a simulation, it's a guess). */
  signals?: SimSignal[];
}): PlaybookBacktestResult {
  const { spec, baseSymbol, quoteSymbol, initialBalance, series } = args;
  // Replay mode engages when a history is PROVIDED, even if empty —
  // "no alerts arrived, the entry never fires" is a legitimate
  // simulation answer, not a validation error.
  validatePlaybookForBacktest(spec, baseSymbol, quoteSymbol, { signalsProvided: args.signals != null });
  // Normalize signal times to canonical ISO before comparing — the
  // series carries `toISOString()` stamps ("…00.000Z") and a raw
  // lexicographic compare against second-precision input ("…00Z")
  // silently misorders ('Z' > '.'). Then drop stale-before-armed
  // signals: only arrivals at/after the series start are eligible
  // (every sim order is armed at t0).
  const windowStart = series.points[0]?.ts ?? "";
  const simSignals = (args.signals ?? [])
    .map((s) => {
      const t = Date.parse(s.at);
      if (!Number.isFinite(t)) {
        throw new ToolError("INVALID_PARAMS", `signals[]: "${s.at}" is not a valid ISO-8601 time (signal "${s.name}").`);
      }
      return { name: s.name, at: new Date(t).toISOString() };
    })
    .filter((s) => s.at >= windowStart);

  // Build per-strategy state. Local ids preserve the operator's `id`
  // field when present, fall back to "strategies[N]" otherwise — same
  // convention as the playbook deploy + show paths.
  const states = spec.strategies.map((entry, i) => buildStrategyState(entry, i));

  const balance: SymbolBalance = normalizeBalance(initialBalance);
  const fires: PlaybookBacktestFire[] = [];
  const notes: string[] = [];


  for (const pt of series.points) {
    // Order matters: orders evaluate first, then schedules — matches
    // the live engine where orders tick more frequently than schedules.
    // The shared-balance effect is sequential: an order fire reduces
    // balance BEFORE a schedule in the same tick can spend.
    for (const st of states) {
      if (st.finalStatus !== "active") continue;
      if (st.type === "order") {
        evaluateOrderTick({ state: st, pt, balance, baseSymbol, quoteSymbol, states, fires, notes, signals: simSignals });
      }
    }
    for (const st of states) {
      if (st.finalStatus !== "active") continue;
      if (st.type === "schedule") {
        evaluateScheduleTick({ state: st, pt, balance, baseSymbol, quoteSymbol, fires, states, notes });
      }
    }
  }

  // v31: hook-spawn summary. Dynamic states carry spawnedBy.
  const spawned = states.filter((st) => st.type === "order" && st.spawnedBy != null).length;
  if (spawned > 0) {
    notes.push(`${spawned} follow-up order(s) spawned by on_fill hooks (simulated with the production renderer)`);
  }

  // Anything still "active" at the end of the timeline stays "active"
  // — operators see "would still be standing today".
  const perStrategy: PlaybookStrategyStat[] = states.map((st) => ({
    strategyId: st.id,
    type: st.type,
    fireCount: st.fireCount,
    baseDelta: st.baseDelta,
    quoteDelta: st.quoteDelta,
    finalStatus: st.finalStatus,
  }));

  for (const st of states) {
    if (st.type === "schedule" && st.finalStatus === "active" && st.fireCount === 0) {
      notes.push(`${st.id}: schedule never matched a datapoint (check cron cadence vs data resolution)`);
    }
    if (st.type === "order" && st.finalStatus === "active") {
      notes.push(`${st.id}: order never triggered over the ${series.points.length} datapoints in window`);
    }
  }

  const built = buildResult({ initialBalance, balance, fires: [], notes, series, baseSymbol, quoteSymbol });
  return {
    fires,
    finalBalance: balance,
    initialUsd: built.initialUsd,
    finalUsd: built.finalUsd,
    pnlUsd: built.pnlUsd,
    holdFinalUsd: built.holdFinalUsd,
    holdPnlUsd: built.holdPnlUsd,
    notes: built.notes,
    windowStart: built.windowStart,
    windowEnd: built.windowEnd,
    perStrategy,
  };
}

// ── per-strategy state ───────────────────────────────────────

interface OrderState {
  id: string;
  type: "order";
  spec: OrderSpec;
  finalStatus: "active" | "filled" | "cancelled";
  trailWaterMark: number | null;
  fireCount: number;
  baseDelta: number;
  quoteDelta: number;
  /** v31: the schedule state id whose on_fill hook spawned this
   *  order (null for spec-declared orders). */
  spawnedBy: string | null;
}

interface ScheduleState {
  id: string;
  type: "schedule";
  spec: ScheduleSpec;
  /** Parsed cron — computed once at validation time. */
  parsedCron: ParsedCron;
  finalStatus: "active" | "completed" | "cancelled";
  lastFireMinute: number;
  fireCount: number;
  baseDelta: number;
  quoteDelta: number;
  maxRuns: number;
}

type StrategyState = OrderState | ScheduleState;

function buildStrategyState(entry: StrategySpec, idx: number): StrategyState {
  const id = entry.id ?? `strategies[${idx}]`;
  if (entry.type === "order") {
    return {
      id,
      type: "order",
      spec: entry,
      finalStatus: "active",
      trailWaterMark: null,
      fireCount: 0,
      baseDelta: 0,
      quoteDelta: 0,
      spawnedBy: null,
    };
  }
  if (entry.type === "schedule") {
    const cronExpr = entry.cron ?? durationToCron(entry.every!);
    return {
      id,
      type: "schedule",
      spec: entry,
      parsedCron: parseCron(cronExpr),
      finalStatus: "active",
      lastFireMinute: -1,
      fireCount: 0,
      baseDelta: 0,
      quoteDelta: 0,
      maxRuns: entry.maxRuns ?? Number.POSITIVE_INFINITY,
    };
  }
  // rebalance — validation rejected this upstream, but the type
  // narrowing demands a path here.
  throw new ToolError(
    "INVALID_PARAMS",
    `Internal: rebalance strategies should be rejected by validatePlaybookForBacktest before state build.`,
  );
}

// ── per-tick evaluation ──────────────────────────────────────

function evaluateOrderTick(args: {
  state: OrderState;
  pt: PricePoint;
  balance: SymbolBalance;
  baseSymbol: string;
  quoteSymbol: string;
  states: StrategyState[];
  fires: PlaybookBacktestFire[];
  notes: string[];
  signals?: SimSignal[];
}): void {
  const { state, pt, balance, baseSymbol, quoteSymbol, states, fires, notes } = args;
  // Optional expires_at — drop the order without firing if past.
  if (state.spec.expiresAt) {
    if (Date.parse(state.spec.expiresAt) < Date.parse(pt.ts)) {
      state.finalStatus = "cancelled";
      return;
    }
  }
  let triggered = false;
  if (state.spec.trigger === "signal") {
    // v39.5: fire at the FIRST price point at-or-after a matching
    // recorded signal — the sim twin of "the next engine tick after
    // the webhook landed". The order fires once; later signals on
    // the same name are moot for it (matches live semantics).
    triggered = (args.signals ?? []).some(
      (s) => s.name === state.spec.signalName && s.at <= pt.ts,
    );
    if (!triggered) return;
  } else if (state.spec.trigger === "trailing") {
    const view: TrailingOrderView = {
      side: state.spec.side,
      trigger_type: "trailing",
      target_price_usd: state.spec.price ?? null,
      trail_pct: state.spec.trailPct ?? null,
      water_mark_usd: state.trailWaterMark,
    };
    const evalRes = evaluateTrailingTrigger(view, pt.priceUsd);
    if (evalRes.tracking && evalRes.waterMarkChanged) {
      state.trailWaterMark = evalRes.nextWaterMark;
    }
    triggered = evalRes.triggered;
  } else {
    triggered = isOrderTriggered(
      { trigger_type: state.spec.trigger, target_price_usd: state.spec.price ?? null },
      pt.priceUsd,
    );
  }
  if (!triggered) return;

  const fill = simulateFillForState({ state, pt, balance, baseSymbol, quoteSymbol });
  fires.push(fill);
  if (fill.multiAction === "fill") {
    state.finalStatus = "filled";
    state.fireCount = 1;
    state.baseDelta = fill.baseDelta;
    state.quoteDelta = fill.quoteDelta;
    cascadeOcoPeers(state, states, pt, fires);
    spawnHookOrder({ parent: state, onFill: state.spec.onFill, fill, pt, states, notes });
  } else {
    // halt — insufficient balance. Park the order so it doesn't keep
    // firing on subsequent ticks.
    state.finalStatus = "cancelled";
  }
}

function evaluateScheduleTick(args: {
  state: ScheduleState;
  pt: PricePoint;
  balance: SymbolBalance;
  baseSymbol: string;
  quoteSymbol: string;
  fires: PlaybookBacktestFire[];
  /** v31: dynamic hook orders are appended here. The orders loop runs
   *  BEFORE the schedules loop each tick, so a spawned order starts
   *  evaluating on the NEXT datapoint — same ordering as the live
   *  engine (the hook creates the order after the fill lands). */
  states: StrategyState[];
  notes: string[];
}): void {
  const { state, pt, balance, baseSymbol, quoteSymbol, fires, states, notes } = args;
  if (state.fireCount >= state.maxRuns) {
    state.finalStatus = "completed";
    return;
  }
  const t = new Date(pt.ts);
  const minuteBucket = Math.floor(t.getTime() / 60_000);
  if (minuteBucket === state.lastFireMinute) return;
  if (!matchesAt(state.parsedCron, t)) return;

  const fill = simulateFillForState({ state, pt, balance, baseSymbol, quoteSymbol });
  fires.push(fill);
  if (fill.multiAction === "fill") {
    state.fireCount++;
    state.baseDelta += fill.baseDelta;
    state.quoteDelta += fill.quoteDelta;
    state.lastFireMinute = minuteBucket;
    if (state.fireCount >= state.maxRuns) state.finalStatus = "completed";
    // v31: on_fill hook — shared spawn helper (orders use it too).
    spawnHookOrder({ parent: state, onFill: state.spec.onFill, fill, pt, states, notes });
  } else {
    // halt — park the schedule. Some operators might want to keep
    // retrying on the next tick (a schedule with insufficient balance
    // today might have balance next week from manual top-up), but
    // backtest semantics are "given THIS balance + THIS timeline, what
    // would have happened"; further fires would just emit more halts.
    state.finalStatus = "cancelled";
  }
}

/** v31: spawn an on_fill hook order with the SAME production renderer
 *  the live engine uses, fed the simulated fill context. A render
 *  failure mirrors live semantics: the fill stays, the hook is noted,
 *  the sim continues. Orders fire once (fireNumber 1); schedules pass
 *  their running fireCount. */
function spawnHookOrder(args: {
  parent: OrderState | ScheduleState;
  onFill: unknown;
  fill: PlaybookBacktestFire;
  pt: PricePoint;
  states: StrategyState[];
  notes: string[];
}): void {
  const { parent, onFill, fill, pt, states, notes } = args;
  if (onFill == null) return;
  const fireNumber = parent.fireCount > 0 ? parent.fireCount : 1;
  try {
    const hook = parseOnFillSpec(onFill);
    const rendered = renderOnFillSpec({
      spec: hook,
      fill: {
        baseAmount: String(Math.abs(fill.baseDelta)),
        quoteAmount: String(Math.abs(fill.quoteDelta)),
        fillPriceUsd: pt.priceUsd,
        txHash: `sim:${parent.id}:${fireNumber}`,
        fireNumber,
      },
    }) as OnFillSpec;
    // Multi-leg hooks spawn one sim order per leg; legs without an
    // explicit group share the auto-OCO group (bracket semantics —
    // the sim's cascadeOcoPeers handles the mutual cancel exactly
    // like the live engine).
    const legs = onFillLegs(rendered);
    const sharedGroup = autoHookGroup(legs, parent.id, fireNumber);
    legs.forEach((hs, legIdx) => {
      const legSuffix = legs.length > 1 ? `.${legIdx + 1}` : "";
      states.push({
        id: `${parent.id}:hook#${fireNumber}${legSuffix}`,
        type: "order",
        spec: {
          type: "order",
          side: hs.side,
          trigger: hs.trigger,
          price: hs.price != null ? Number(hs.price) : undefined,
          trailPct: hs.trailPct != null ? Number(hs.trailPct) : undefined,
          base: hs.base,
          quote: hs.quote,
          baseAmount: hs.baseAmount != null ? String(hs.baseAmount) : undefined,
          quoteAmount: hs.quoteAmount != null ? String(hs.quoteAmount) : undefined,
          expiresAt: hs.expiresAt,
          group: hs.group ?? sharedGroup,
        },
        finalStatus: "active",
        trailWaterMark: null,
        fireCount: 0,
        baseDelta: 0,
        quoteDelta: 0,
        spawnedBy: parent.id,
      });
    });
  } catch (e) {
    notes.push(`${pt.ts}: on_fill hook for ${parent.id} failed to render (${(e as Error).message.split("\n")[0]}) — fill kept, hook skipped`);
  }
}

function simulateFillForState(args: {
  state: StrategyState;
  pt: PricePoint;
  balance: SymbolBalance;
  baseSymbol: string;
  quoteSymbol: string;
}): PlaybookBacktestFire {
  const { state, pt, balance, baseSymbol, quoteSymbol } = args;
  // v35/v35.5: dynamic sizing ("max" / "N%") resolves against the SIM
  // balance at fire time — the backtest twin of executeTrade's
  // on-chain resolution. A zero balance resolves to 0 and the
  // existing insufficient-balance halt path reports it.
  const dynamicOf = (v: unknown): ReturnType<typeof parseSizingSentinel> =>
    typeof v === "string" ? parseSizingSentinel(v) : null;
  const baseSentinel = dynamicOf(state.spec.baseAmount);
  const quoteSentinel = dynamicOf(state.spec.quoteAmount);
  const fillSpec = {
    side: state.spec.side,
    baseAmount: baseSentinel
      ? applyFraction(balance[baseSymbol] ?? 0, baseSentinel)
      : numericOrUndefined(state.spec.baseAmount),
    quoteAmount: quoteSentinel
      ? applyFraction(balance[quoteSymbol] ?? 0, quoteSentinel)
      : numericOrUndefined(state.spec.quoteAmount),
  };
  const single = simulateFillAt({
    spec: fillSpec,
    pt,
    balance,
    baseSymbol,
    quoteSymbol,
  });
  return {
    ...single,
    strategyId: state.id,
    strategyType: state.type,
    multiAction: single.action,
  };
}

function numericOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

function cascadeOcoPeers(
  firedState: OrderState,
  states: StrategyState[],
  pt: PricePoint,
  fires: PlaybookBacktestFire[],
): void {
  const groupRaw = firedState.spec.group;
  if (!groupRaw) return;
  for (const other of states) {
    if (other === firedState) continue;
    if (other.type !== "order") continue;
    if (other.finalStatus !== "active") continue;
    if (other.spec.group !== groupRaw) continue;
    other.finalStatus = "cancelled";
    fires.push({
      ts: pt.ts,
      action: "fill", // BacktestFire.action union — placeholder; the multiAction field tells the truth.
      priceUsd: pt.priceUsd,
      baseDelta: 0,
      quoteDelta: 0,
      note: `OCO cascade — peer ${firedState.id} fired`,
      strategyId: other.id,
      strategyType: "order",
      multiAction: "oco_cascade",
    });
  }
}

// ── validation: spec must be backtestable ────────────────────

/**
 * Backtest mode supports a constrained subset of playbook shapes:
 *   - every strategy must reference the same base/quote pair (we fetch
 *     ONE price series; multi-asset backtests need a different design)
 *   - rebalance plans are unsupported (intrinsically multi-asset)
 *
 * The error names every violation in one message + carries
 * `nextActions[]` pointing at the single-strategy backtest commands as
 * a fallback. Operators frequently encounter the "I want to backtest
 * just the trail" case after seeing this error.
 */
function validatePlaybookForBacktest(
  spec: PlaybookSpec,
  baseSymbol: string,
  quoteSymbol: string,
  opts: { signalsProvided?: boolean } = {},
): void {
  const errors: string[] = [];
  let hasRebalance = false;
  for (let i = 0; i < spec.strategies.length; i++) {
    const s = spec.strategies[i];
    const prefix = `strategies[${i}]${s.id ? ` (${s.id})` : ""}`;
    if (s.type === "rebalance") {
      hasRebalance = true;
      errors.push(`${prefix}: rebalance plans aren't supported in playbook backtest (intrinsically multi-asset)`);
      continue;
    }
    // v37: signal triggers need history to replay against. v39.5:
    // recorded (or hypothetical) signals lift the restriction —
    // without them the rejection stands (no history is not a
    // simulation, it's a guess).
    if (s.type === "order" && s.trigger === "signal" && !opts.signalsProvided) {
      errors.push(`${prefix}: signal-triggered orders need signal history to replay — pass --signals-from-history (or signals[] via MCP), or replace with a price trigger`);
      continue;
    }
    if (s.base.toUpperCase() !== baseSymbol.toUpperCase() && !(baseSymbol.toUpperCase() === "ETH" && s.base.toUpperCase() === "ETH")) {
      errors.push(`${prefix}: base "${s.base}" doesn't match the playbook backtest base "${baseSymbol}"`);
    }
    if (s.quote.toUpperCase() !== quoteSymbol.toUpperCase()) {
      errors.push(`${prefix}: quote "${s.quote}" doesn't match the playbook backtest quote "${quoteSymbol}"`);
    }
    // v31: hook orders are simulated — the same-pair invariant
    // extends INSIDE the hook spec (one price series). Both schedule
    // AND order entries can carry hooks.
    if ((s.type === "schedule" || s.type === "order") && s.onFill != null) {
      try {
        const hook = parseOnFillSpec(s.onFill);
        const legs = onFillLegs(hook);
        legs.forEach((leg, li) => {
          const where = legs.length > 1 ? `${prefix}.onFill.specs[${li}]` : `${prefix}.onFill`;
          if (leg.base.toUpperCase() !== baseSymbol.toUpperCase()) {
            errors.push(`${where}: hook base "${leg.base}" doesn't match the playbook backtest base "${baseSymbol}"`);
          }
          if (leg.quote.toUpperCase() !== quoteSymbol.toUpperCase()) {
            errors.push(`${where}: hook quote "${leg.quote}" doesn't match the playbook backtest quote "${quoteSymbol}"`);
          }
        });
      } catch (e) {
        errors.push(`${prefix}.onFill: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  if (errors.length === 0) return;
  throw new ToolError(
    "INVALID_PARAMS",
    `Playbook is not backtestable as a single-asset bundle:\n  ${errors.join("\n  ")}\n` +
      `Fix the spec or backtest each strategy separately with \`tradekit backtest order\` / \`tradekit backtest schedule\`.`,
    {
      details: {
        violations: errors.length,
        hasRebalance,
      },
    },
  );
}
