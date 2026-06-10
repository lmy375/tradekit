// ──────────────────────────────────────────────────────────────────
// Strategy report (iter31): unified observability for a strategy tag.
//
// Pre-iter31, "how is my strategy doing?" required 7+ separate
// commands:
//
//   tradekit playbook show 1
//   tradekit order list      --strategy playbook:1
//   tradekit schedule list   --strategy playbook:1
//   tradekit rebalance list  --strategy playbook:1
//   tradekit trades          --strategy playbook:1
//   tradekit pnl             --strategy playbook:1
//   tradekit slippage        --strategy playbook:1
//
// Every data source already existed; what was missing was a
// composable aggregator that pulls them together into one
// operator-facing view.
//
// This module is intentionally PURE-ISH: it reads from the DB
// + the config + the in-memory price cache (via callbacks) but
// it never writes anywhere. The CLI / MCP / web layers consume
// the typed `StrategyReport` and render their own formatting.
//
// Design constraints:
//
//   1. ONE entry point: `buildStrategyReport({ tag, window, ... })`.
//      No surprise side effects, no caches, no globals beyond
//      what the DB layer already maintains.
//
//   2. Paper-aware. When the tag was deployed via `--paper`,
//      the performance / position / activity sections pull from
//      `paper_trades` + `paper_balances` instead of `trades`.
//      Detected automatically by inspecting the primitives:
//      if every active primitive has paper=1 (or zero real fills
//      exist and at least one paper trade does), the report
//      switches modes. Operators can override with `mode: "real"`
//      or `mode: "paper"` for ambiguous cases.
//
//   3. Tag resolution is permissive: a numeric input maps to
//      `playbook:<N>`; otherwise the literal string is used as
//      the tag. `playbook:1` and `1` resolve identically.
//
//   4. The 7 sections are independent — fast paths can be
//      derived by opting out via the `sections` filter (the MCP
//      tool surfaces this for agents that want a quick snapshot).
//
//   5. Window defaults to 30 days. `window: "all"` drops the
//      timestamp filter on the trades aggregation. The
//      composition section is always lifetime (active state
//      doesn't have a window).
// ──────────────────────────────────────────────────────────────────

import {
  listOrders,
  listSchedules,
  listRebalancePlans,
  recentTrades,
  listPaperTrades,
  getPlaybookById,
  usdSpentUnderStrategy,
  replayOrderEntries,
  getDrawdownState,
  type OrderRow,
  type ScheduleRow,
  type RebalanceRow,
  type TradeRow,
  type PaperTradeRow,
  type PlaybookRow,
  type OrderCheckLogRow,
  type DrawdownStateRow,
} from "./db.js";
import { loadConfig, type Config } from "./config.js";
import { computePaperPnlMtm, type PaperPriceFetcher, type PaperPositionEntry } from "./paperPnl.js";
import { evaluateTrailingTrigger } from "./trailingStop.js";
import { isOrderTriggered, isOrderExpired } from "./orders.js";

// ── public types ────────────────────────────────────────────

export type ReportWindow = "1d" | "7d" | "30d" | "90d" | "all";
export type ReportMode = "real" | "paper" | "auto";
export type ReportSection =
  | "identity"
  | "composition"
  | "performance"
  | "position"
  | "risk"
  | "activity"
  | "forward"
  /** Opt-in (NOT in the default set — pricing open positions needs a
   *  live oracle call per held token, which makes the report
   *  non-deterministic). Cost-basis positions marked to market. */
  | "valuation";

export interface BuildStrategyReportArgs {
  /** The strategy tag. A bare number is interpreted as a playbook id
   *  and rewritten to `playbook:<N>`. Free-form tags (like `"dca-eth"`)
   *  are taken verbatim. */
  tag: string;
  window?: ReportWindow;
  mode?: ReportMode;
  /** Optional subset of sections to compute. Defaults to all 7. */
  sections?: ReportSection[];
  /** Best-effort live spot price for the strategy's primary base
   *  token, supplied by the caller (CLI / MCP) since price IO
   *  belongs at the edge. Used by the forward-signals section to
   *  compute "% to trigger" distances. When null, those distances
   *  appear as null in the output. */
  livePriceFn?: (tokenAddress: string) => Promise<number | null>;
  /** Price oracle for the valuation section: USD per unit of
   *  (chain, token). Supplied by the caller (CLI / MCP) since price
   *  IO belongs at the edge — defaultPaperPriceFetcher() is the
   *  production implementation (it handles the native sentinel via
   *  the chain's WETH). When omitted, valuation still computes cost
   *  basis but every open position is unpriced (deterministic +
   *  offline — useful for tests and air-gapped report generation). */
  markPriceFn?: PaperPriceFetcher;
  /** Test seam: defaults to Date.now(). Lets tests pin the
   *  "now" used for window calculation + age display. */
  nowFn?: () => Date;
  /** Override config (tests). */
  config?: Config;
}

export interface StrategyReport {
  /** Echoed back so the consumer can label dashboards. */
  tag: string;
  /** "real" or "paper" after auto-resolution. */
  mode: "real" | "paper";
  window: ReportWindow;
  /** ISO timestamp the report was built at. */
  generatedAt: string;

  identity?: IdentitySection;
  composition?: CompositionSection;
  performance?: PerformanceSection;
  position?: PositionSection;
  risk?: RiskSection;
  activity?: ActivitySection;
  forward?: ForwardSection;
  valuation?: ValuationSection;
}

export interface IdentitySection {
  /** The display name. For playbook tags, the playbook name; for
   *  free-form tags the tag itself. */
  displayName: string;
  /** When tag resolves to a playbook row. */
  playbookId: number | null;
  playbookStatus: PlaybookRow["status"] | null;
  /** YAML/JSON path the playbook was deployed from (when known). */
  sourcePath: string | null;
  sourceHash: string | null;
  deployedAt: string | null;
  destroyedAt: string | null;
  /** Seconds since deployment (or since first observed trade for
   *  free-form tags). null when nothing is observable yet. */
  ageSeconds: number | null;
}

export interface CompositionSection {
  /** Per-type breakdown. Counts every primitive (active + terminal). */
  totals: {
    orders: number;
    schedules: number;
    rebalances: number;
  };
  /** Lifecycle counts across all owned primitives. */
  lifecycle: {
    active: number;
    filled: number;
    failed: number;
    expired: number;
    cancelled: number;
    paused: number;
    completed: number;
  };
  primitives: CompositionEntry[];
}

export interface CompositionEntry {
  kind: "order" | "schedule" | "rebalance";
  id: number;
  status: string;
  /** Compact human-readable description (side + trigger + pair for
   *  orders; cron + pair for schedules; targets summary for rebals). */
  summary: string;
  chain: string;
  account: string;
  paper: boolean;
  createdAt: string;
  /** First terminal timestamp for filled/failed/expired — useful
   *  for "filled 3 days ago" displays. Null while active. */
  terminalAt: string | null;
}

export interface PerformanceSection {
  windowSinceIso: string | null;
  fills: number;
  failures: number;
  /** fills / (fills + failures). null when no terminal trades yet. */
  successRate: number | null;
  buyCount: number;
  sellCount: number;
  /** Quote-denominated. Sum of quote received (sells) minus quote
   *  spent (buys). PAPER mode uses paper_trades quote_amount; REAL
   *  mode uses trades.quote_amount on status='success' rows. */
  realizedQuoteSpent: number;
  realizedQuoteReceived: number;
  realizedNetQuote: number;
  /** Slippage stats from real trades only (paper has no
   *  realized_slippage_bps). null for paper. */
  avgSlippageBps: number | null;
  maxSlippageBps: number | null;
  /** Median + p95 across the window. null when sample size = 0. */
  p50SlippageBps: number | null;
  p95SlippageBps: number | null;
}

export interface PositionSection {
  /** Per (chain, token) net position. Positive = net accumulated;
   *  negative = net distributed. Computed from the trades table
   *  (or paper_trades) by walking each fill. */
  positions: PositionEntry[];
}

export interface PositionEntry {
  chain: string;
  token: string;
  symbol: string | null;
  netAmount: string;
  /** "base" or "quote" — useful when rendering: base = the asset
   *  the strategy is acquiring; quote = the asset spent. */
  role: "base" | "quote";
}

/** Opt-in mark-to-market view. Positions are rebuilt from the fill
 *  journal with the SAME weighted-average cost-basis model the
 *  `paper pnl --mtm` surface uses (one shared core, computePaperPnlMtm
 *  — numbers can't drift between surfaces), then open positions are
 *  marked at current oracle prices.
 *
 *  Mode parity: paper mode walks paper_trades; real mode walks
 *  status='success' trades through the same engine. Real-mode caveat
 *  (documented, deliberate): gas is NOT included here — the
 *  full-portfolio `tradekit pnl` report owns historically-accurate
 *  gas accounting; this section answers the per-strategy question. */
export interface ValuationSection {
  /** ISO timestamp the price marks were fetched. */
  markedAt: string;
  /** Cost-basis realized P&L (USD ≈ quote). Differs from the
   *  performance section's realizedNetQuote: that is raw cash flow
   *  (a buy makes it negative even when the position is up); this
   *  only books P&L when a tracked position is reduced. */
  realizedQuote: number;
  /** Open positions marked at current prices. Null when every open
   *  position is unpriced (no oracle / no markPriceFn). */
  unrealizedQuote: number | null;
  /** realizedQuote + (unrealizedQuote ?? 0). */
  totalQuote: number;
  /** Current USD value of priced open positions. */
  openValueQuote: number;
  positions: PaperPositionEntry[];
  unpricedPositionCount: number;
  /** Fills excluded from cost basis (non-stablecoin quote). */
  skippedNonStableQuote: number;
  /** Base sold without a tracked cost basis (deposit-seeded paper
   *  inventory, or real trades predating the journal) — proceeds
   *  excluded from realizedQuote, reported for transparency. */
  untrackedSellQuote: number;
  /** v31: cumulative realized trajectory (one point per realizing
   *  sell, chronological). Deterministic — present even without a
   *  markPriceFn. Empty when the strategy never realized. */
  realizedTimeline: Array<{ at: string; cumulativeRealizedQuote: number }>;
}

export interface RiskSection {
  /** Strategy-budget rules that match this tag + their current
   *  consumption. Empty when no budgets are configured. */
  budgets: BudgetSummary[];
  /** Drawdown state IF a `strategy:<tag>` scope exists in the
   *  drawdown table. null when no per-strategy drawdown tracking
   *  is configured. */
  drawdown: DrawdownSummary | null;
}

export interface BudgetSummary {
  pattern: string;
  lifetimeUsd: number | null;
  lifetimeSpentUsd: number | null;
  lifetimePctUsed: number | null;
  dailyUsd: number | null;
  dailySpentUsd: number | null;
  dailyPctUsed: number | null;
  perFireUsd: number | null;
}

export interface DrawdownSummary {
  scopeKey: string;
  peakUsd: number;
  peakAt: string;
  lastValueUsd: number | null;
  drawdownPct: number | null;
  tripped: boolean;
  trippedAt: string | null;
}

export interface ActivitySection {
  recentFills: ActivityEntry[];
  recentFailures: ActivityEntry[];
  recentJournal: ActivityEntry[];
}

export interface ActivityEntry {
  /** ISO timestamp. */
  at: string;
  kind: "fill" | "failure" | "journal";
  /** One-line summary suitable for table rendering. */
  summary: string;
  /** Source primitive when known. */
  primitiveType: "order" | "schedule" | "rebalance" | "trade" | null;
  primitiveId: number | null;
  /** Tx hash for fills/failures, null for pure journal entries. */
  txHash: string | null;
}

export interface ForwardSection {
  /** Next schedule that will fire (across the strategy). null when
   *  no active schedule exists. */
  nextScheduleAt: string | null;
  nextScheduleId: number | null;
  /** Per-active-order projection. */
  pendingTriggers: PendingTriggerEntry[];
  /** Per-plan drift proximity from PERSISTED last-run telemetry
   *  (deterministic — no oracle call; the engine measured the drift
   *  on its last evaluation). Empty when the strategy owns no live
   *  plans. Plans that never evaluated have lastDriftPct=null. */
  rebalanceDrift: RebalanceDriftEntry[];
}

export interface RebalanceDriftEntry {
  planId: number;
  name: string | null;
  /** Max per-target drift the engine measured on its LAST evaluation
   *  (last_run_max_drift_pct). null until the first evaluation. */
  lastDriftPct: number | null;
  thresholdPct: number;
  /** lastDriftPct / thresholdPct × 100 — "how close to firing" as a
   *  percentage of the trigger. ≥100 means the next evaluation fires
   *  (barring price movement). null when lastDriftPct is null. */
  pctOfThreshold: number | null;
  lastEvaluatedAt: string | null;
  nextRunAt: string;
  status: string;
  paper: boolean;
}

export interface PendingTriggerEntry {
  orderId: number;
  trigger: "price_below" | "price_above" | "trailing";
  side: "buy" | "sell";
  /** When `livePriceFn` returned a price, the current price in USD. */
  currentPriceUsd: number | null;
  /** The price the order would fire AT (target for price triggers;
   *  HWM × retracement for trailing; null when trailing hasn't
   *  activated yet). */
  fireThresholdUsd: number | null;
  /** Signed percentage distance from current to threshold. Positive
   *  = the price must move up to fire; negative = move down. null
   *  when either side is missing. */
  distancePct: number | null;
  /** True when ALL inputs are present + the order would trigger
   *  this tick if the engine ran (sanity-check parity with the
   *  engine's predicate). */
  wouldFireNow: boolean;
  /** Trailing only: current water-mark and the "tracking" flag from
   *  evaluateTrailingTrigger. Null for non-trailing. */
  trailingWaterMarkUsd: number | null;
  trailingTracking: boolean | null;
}

// ── tag resolution ──────────────────────────────────────────

/**
 * Normalize the caller's tag input. A bare number → `playbook:<N>`;
 * anything else passes through unchanged. Exported for testing.
 */
export function normalizeTag(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return `playbook:${trimmed}`;
  return trimmed;
}

/**
 * Inverse: extract the playbook id from a tag if present. Returns
 * null for free-form tags.
 */
export function playbookIdFromTag(tag: string): number | null {
  const m = /^playbook:(\d+)$/.exec(tag);
  return m ? parseInt(m[1], 10) : null;
}

// ── window helpers ──────────────────────────────────────────

function windowToSinceIso(window: ReportWindow, now: Date): string | null {
  if (window === "all") return null;
  const days = window === "1d" ? 1 : window === "7d" ? 7 : window === "30d" ? 30 : 90;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

// ── identity ────────────────────────────────────────────────

function buildIdentity(args: {
  tag: string;
  playbook: PlaybookRow | null;
  composition: CompositionSection | undefined;
  now: Date;
}): IdentitySection {
  const { tag, playbook, composition, now } = args;
  let ageSeconds: number | null = null;
  let deployedAt: string | null = null;
  let destroyedAt: string | null = null;
  if (playbook) {
    deployedAt = playbook.deployed_at;
    destroyedAt = playbook.destroyed_at ?? null;
    if (deployedAt) {
      const t = Date.parse(deployedAt);
      if (Number.isFinite(t)) ageSeconds = Math.max(0, Math.floor((now.getTime() - t) / 1000));
    }
  } else if (composition?.primitives.length) {
    // Derive age from the earliest primitive's created_at.
    let earliest = Infinity;
    for (const p of composition.primitives) {
      const t = Date.parse(p.createdAt);
      if (Number.isFinite(t) && t < earliest) earliest = t;
    }
    if (earliest !== Infinity) {
      ageSeconds = Math.max(0, Math.floor((now.getTime() - earliest) / 1000));
    }
  }
  return {
    displayName: playbook?.name ?? tag,
    playbookId: playbook?.id ?? null,
    playbookStatus: playbook?.status ?? null,
    sourcePath: playbook?.source_path ?? null,
    sourceHash: playbook?.source_hash ?? null,
    deployedAt,
    destroyedAt,
    ageSeconds,
  };
}

// ── composition ─────────────────────────────────────────────

function buildComposition(args: {
  orders: OrderRow[];
  schedules: ScheduleRow[];
  rebalances: RebalanceRow[];
}): CompositionSection {
  const { orders, schedules, rebalances } = args;
  const lifecycle = {
    active: 0,
    filled: 0,
    failed: 0,
    expired: 0,
    cancelled: 0,
    paused: 0,
    completed: 0,
  };
  const primitives: CompositionEntry[] = [];
  const bumpLifecycle = (status: string) => {
    switch (status) {
      case "active":
        lifecycle.active += 1;
        break;
      case "filled":
        lifecycle.filled += 1;
        break;
      case "failed":
        lifecycle.failed += 1;
        break;
      case "expired":
        lifecycle.expired += 1;
        break;
      case "cancelled":
        lifecycle.cancelled += 1;
        break;
      case "paused":
        lifecycle.paused += 1;
        break;
      case "completed":
        lifecycle.completed += 1;
        break;
    }
  };

  for (const o of orders) {
    bumpLifecycle(o.status);
    primitives.push({
      kind: "order",
      id: o.id ?? -1,
      status: o.status,
      summary: summarizeOrder(o),
      chain: o.chain,
      account: o.account,
      paper: (o.paper ?? 0) === 1,
      createdAt: o.created_at,
      terminalAt: o.filled_at ?? null,
    });
  }
  for (const s of schedules) {
    bumpLifecycle(s.status);
    primitives.push({
      kind: "schedule",
      id: s.id ?? -1,
      status: s.status,
      summary: summarizeSchedule(s),
      chain: s.chain,
      account: s.account,
      paper: (s.paper ?? 0) === 1,
      createdAt: s.created_at,
      terminalAt: s.status === "completed" ? s.updated_at : null,
    });
  }
  for (const r of rebalances) {
    bumpLifecycle(r.status);
    primitives.push({
      kind: "rebalance",
      id: r.id ?? -1,
      status: r.status,
      summary: summarizeRebalance(r),
      chain: r.chain,
      account: r.account,
      paper: false, // v1: rebalance is not paper-aware
      createdAt: r.created_at,
      terminalAt: r.status === "completed" ? r.updated_at : null,
    });
  }
  // Stable ordering: by kind then id ascending.
  primitives.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.id - b.id;
  });
  return {
    totals: {
      orders: orders.length,
      schedules: schedules.length,
      rebalances: rebalances.length,
    },
    lifecycle,
    primitives,
  };
}

function summarizeOrder(o: OrderRow): string {
  const pair = `${o.base_symbol ?? "?"}/${o.quote_symbol ?? "?"}`;
  const amt = o.base_amount ?? o.quote_amount ?? "?";
  let trigger: string;
  if (o.trigger_type === "trailing") {
    trigger = `trailing ${o.trail_pct ?? "?"}%`;
  } else {
    const sym = o.trigger_type === "price_below" ? "≤" : "≥";
    trigger = `${sym} $${o.target_price_usd ?? "?"}`;
  }
  return `${o.side.toUpperCase()} ${amt} ${pair}  ${trigger}`;
}

function summarizeSchedule(s: ScheduleRow): string {
  const pair = `${s.base_symbol ?? "?"}/${s.quote_symbol ?? "?"}`;
  const amt = s.base_amount ?? s.quote_amount ?? "?";
  return `${s.side.toUpperCase()} ${amt} ${pair}  @ ${s.cron_expr}  (${s.run_count} runs)`;
}

function summarizeRebalance(r: RebalanceRow): string {
  let targetCount = 0;
  try {
    const parsed = JSON.parse(r.targets_json) as unknown;
    if (Array.isArray(parsed)) targetCount = parsed.length;
  } catch {
    // ignore — leave as 0
  }
  return `${r.name ?? "rebalance"}  (${targetCount} targets, drift ${r.drift_threshold_pct}%)`;
}

// ── performance ─────────────────────────────────────────────

function buildPerformance(args: {
  trades: TradeRow[] | PaperTradeRow[];
  isPaper: boolean;
  sinceIso: string | null;
}): PerformanceSection {
  const { trades, isPaper, sinceIso } = args;
  let fills = 0;
  let failures = 0;
  let buyCount = 0;
  let sellCount = 0;
  let qSpent = 0;
  let qRecvd = 0;
  const slippageSamples: number[] = [];
  for (const t of trades) {
    if (sinceIso && t.timestamp < sinceIso) continue;
    if (isPaper) {
      // Paper rows are always "success" — record buy/sell + amounts.
      fills += 1;
      const pt = t as PaperTradeRow;
      const q = parseFloat(pt.quote_amount);
      if (pt.direction === "buy") {
        buyCount += 1;
        if (Number.isFinite(q)) qSpent += q;
      } else {
        sellCount += 1;
        if (Number.isFinite(q)) qRecvd += q;
      }
    } else {
      const rt = t as TradeRow;
      const ok = rt.status === "success";
      if (ok) {
        fills += 1;
        const q = parseFloat(rt.quote_amount);
        if (rt.direction === "buy") {
          buyCount += 1;
          if (Number.isFinite(q)) qSpent += q;
        } else {
          sellCount += 1;
          if (Number.isFinite(q)) qRecvd += q;
        }
        if (rt.realized_slippage_bps != null && Number.isFinite(rt.realized_slippage_bps)) {
          slippageSamples.push(rt.realized_slippage_bps);
        }
      } else if (rt.status === "failed" || rt.status === "reverted") {
        failures += 1;
      }
    }
  }
  const successRate = fills + failures > 0 ? fills / (fills + failures) : null;
  let avgSlip: number | null = null;
  let maxSlip: number | null = null;
  let p50: number | null = null;
  let p95: number | null = null;
  if (!isPaper && slippageSamples.length > 0) {
    const sorted = [...slippageSamples].sort((a, b) => a - b);
    avgSlip = sorted.reduce((sum, x) => sum + x, 0) / sorted.length;
    maxSlip = sorted[sorted.length - 1];
    p50 = sorted[Math.floor(sorted.length * 0.5)];
    p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
  return {
    windowSinceIso: sinceIso,
    fills,
    failures,
    successRate,
    buyCount,
    sellCount,
    realizedQuoteSpent: qSpent,
    realizedQuoteReceived: qRecvd,
    realizedNetQuote: qRecvd - qSpent,
    avgSlippageBps: avgSlip,
    maxSlippageBps: maxSlip,
    p50SlippageBps: p50,
    p95SlippageBps: p95,
  };
}

// ── position ────────────────────────────────────────────────

function buildPosition(args: {
  trades: TradeRow[] | PaperTradeRow[];
  isPaper: boolean;
}): PositionSection {
  const { trades, isPaper } = args;
  // Map key: `${chain}|${tokenLower}|${role}` → { symbol, net } (decimal accumulator).
  const byKey = new Map<string, { chain: string; token: string; symbol: string | null; role: "base" | "quote"; net: number }>();

  const apply = (chain: string, token: string, symbol: string | null, role: "base" | "quote", delta: number) => {
    const key = `${chain}|${token.toLowerCase()}|${role}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.net += delta;
    } else {
      byKey.set(key, { chain, token, symbol, role, net: delta });
    }
  };

  for (const t of trades) {
    // Skip failed real trades (paper has only successful rows).
    if (!isPaper && (t as TradeRow).status !== "success") continue;
    const base = parseFloat(t.base_amount);
    const quote = parseFloat(t.quote_amount);
    if (!Number.isFinite(base) || !Number.isFinite(quote)) continue;
    // BUY: base accumulates, quote is spent.
    // SELL: base is sold, quote accumulates.
    const baseDelta = t.direction === "buy" ? base : -base;
    const quoteDelta = t.direction === "buy" ? -quote : quote;
    apply(t.chain, t.base_token, t.base_symbol ?? null, "base", baseDelta);
    apply(t.chain, t.quote_token, t.quote_symbol ?? null, "quote", quoteDelta);
  }

  const positions: PositionEntry[] = Array.from(byKey.values())
    .map((r) => ({
      chain: r.chain,
      token: r.token,
      symbol: r.symbol,
      role: r.role,
      netAmount: trimDecimal(r.net),
    }))
    // Hide trivial zero entries (rounding artifacts).
    .filter((r) => Math.abs(parseFloat(r.netAmount)) > 1e-12)
    .sort((a, b) => {
      if (a.chain !== b.chain) return a.chain.localeCompare(b.chain);
      if (a.role !== b.role) return a.role.localeCompare(b.role);
      return (a.symbol ?? a.token).localeCompare(b.symbol ?? b.token);
    });
  return { positions };
}

function trimDecimal(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // Show enough precision for tiny amounts but trim trailing zeros.
  const s = Math.abs(n) < 0.0001 ? n.toExponential(4) : n.toFixed(8);
  if (s.includes("e")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

// ── risk ────────────────────────────────────────────────────

function buildRisk(args: {
  tag: string;
  config: Config;
  drawdownLookup: (scopeKey: string) => DrawdownStateRow | null;
  spentLookup: (tag: string, sinceIso?: string) => number;
}): RiskSection {
  const { tag, config, drawdownLookup, spentLookup } = args;
  const rules = config.safety.strategyBudgets ?? [];
  const matching = rules.filter((r) => {
    if (r.tag === tag) return true;
    if (r.tag.endsWith("*")) {
      const prefix = r.tag.slice(0, -1);
      return tag.startsWith(prefix);
    }
    return false;
  });
  const dailySinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const budgets: BudgetSummary[] = matching.map((rule) => {
    const lifetime = rule.lifetimeUsd != null ? spentLookup(tag) : null;
    const daily = rule.dailyUsd != null ? spentLookup(tag, dailySinceIso) : null;
    return {
      pattern: rule.tag,
      lifetimeUsd: rule.lifetimeUsd ?? null,
      lifetimeSpentUsd: lifetime,
      lifetimePctUsed: rule.lifetimeUsd && lifetime != null ? Math.min(100, (lifetime / rule.lifetimeUsd) * 100) : null,
      dailyUsd: rule.dailyUsd ?? null,
      dailySpentUsd: daily,
      dailyPctUsed: rule.dailyUsd && daily != null ? Math.min(100, (daily / rule.dailyUsd) * 100) : null,
      perFireUsd: rule.perFireUsd ?? null,
    };
  });

  // Per-strategy drawdown is keyed by `strategy:<tag>` per the
  // iter20 convention. Plain `global` lives in its own scope and is
  // intentionally NOT surfaced here — the strategy report should
  // only show drawdown that's specific to the tag.
  const scopeKey = `strategy:${tag}`;
  const row = drawdownLookup(scopeKey);
  let drawdown: DrawdownSummary | null = null;
  if (row) {
    const ddPct =
      row.last_value_usd != null && row.peak_usd > 0
        ? ((row.peak_usd - row.last_value_usd) / row.peak_usd) * 100
        : null;
    drawdown = {
      scopeKey: row.scope_key,
      peakUsd: row.peak_usd,
      peakAt: row.peak_at,
      lastValueUsd: row.last_value_usd,
      drawdownPct: ddPct,
      tripped: row.tripped_at != null,
      trippedAt: row.tripped_at,
    };
  }
  return { budgets, drawdown };
}

// ── activity ────────────────────────────────────────────────

function buildActivity(args: {
  trades: TradeRow[] | PaperTradeRow[];
  isPaper: boolean;
  orderIds: number[];
  journalLookup: (orderId: number, limit: number) => OrderCheckLogRow[];
  limit?: number;
}): ActivitySection {
  const limit = args.limit ?? 10;

  const fillEntries: ActivityEntry[] = [];
  const failEntries: ActivityEntry[] = [];
  for (const t of args.trades) {
    if (args.isPaper) {
      const pt = t as PaperTradeRow;
      fillEntries.push({
        at: pt.timestamp,
        kind: "fill",
        summary: `${pt.direction.toUpperCase()} ${pt.base_amount} ${pt.base_symbol ?? "?"} @ ${pt.price}  (paper)`,
        primitiveType: pt.source_type === "manual" ? "trade" : (pt.source_type as "order" | "schedule"),
        primitiveId: pt.source_id,
        txHash: null,
      });
    } else {
      const rt = t as TradeRow;
      if (rt.status === "success") {
        fillEntries.push({
          at: rt.timestamp,
          kind: "fill",
          summary: `${rt.direction.toUpperCase()} ${rt.base_amount} ${rt.base_symbol ?? "?"} @ ${rt.price}`,
          primitiveType: "trade",
          primitiveId: rt.id ?? null,
          txHash: rt.tx_hash,
        });
      } else if (rt.status === "failed" || rt.status === "reverted") {
        failEntries.push({
          at: rt.timestamp,
          kind: "failure",
          summary: `${rt.direction.toUpperCase()} ${rt.base_amount} ${rt.base_symbol ?? "?"}: ${rt.revert_reason ?? rt.status}`,
          primitiveType: "trade",
          primitiveId: rt.id ?? null,
          txHash: rt.tx_hash,
        });
      }
    }
  }
  fillEntries.sort((a, b) => (a.at < b.at ? 1 : -1));
  failEntries.sort((a, b) => (a.at < b.at ? 1 : -1));

  const journalEntries: ActivityEntry[] = [];
  // Aggregate the most recent journal across all owned orders. We
  // ask each order for its last few entries and merge by timestamp.
  for (const orderId of args.orderIds) {
    for (const row of args.journalLookup(orderId, 5)) {
      journalEntries.push({
        at: row.checked_at,
        kind: "journal",
        summary: journalSummary(row),
        primitiveType: "order",
        primitiveId: row.order_id,
        txHash: null,
      });
    }
  }
  journalEntries.sort((a, b) => (a.at < b.at ? 1 : -1));

  return {
    recentFills: fillEntries.slice(0, limit),
    recentFailures: failEntries.slice(0, limit),
    recentJournal: journalEntries.slice(0, limit),
  };
}

function journalSummary(row: OrderCheckLogRow): string {
  const decision = row.decision;
  const price = row.price_usd != null ? ` @ $${row.price_usd}` : "";
  const note = row.notes ? ` (${row.notes})` : "";
  return `order #${row.order_id}: ${decision}${price}${note}`;
}

// ── forward signals ─────────────────────────────────────────

async function buildForward(args: {
  schedules: ScheduleRow[];
  orders: OrderRow[];
  rebalances: RebalanceRow[];
  livePriceFn?: (tokenAddress: string) => Promise<number | null>;
}): Promise<ForwardSection> {
  // Rebalance drift proximity — persisted telemetry, no IO.
  const rebalanceDrift: RebalanceDriftEntry[] = [];
  for (const r of args.rebalances) {
    if (r.status !== "active" && r.status !== "paused") continue;
    if (r.id == null) continue;
    const last = r.last_run_max_drift_pct;
    rebalanceDrift.push({
      planId: r.id,
      name: r.name,
      lastDriftPct: last,
      thresholdPct: r.drift_threshold_pct,
      pctOfThreshold:
        last != null && r.drift_threshold_pct > 0 ? (last / r.drift_threshold_pct) * 100 : null,
      lastEvaluatedAt: r.last_run_at,
      nextRunAt: r.next_run_at,
      status: r.status,
      paper: (r.paper ?? 0) === 1,
    });
  }
  // Closest-to-firing first.
  rebalanceDrift.sort((x, y) => (y.pctOfThreshold ?? -1) - (x.pctOfThreshold ?? -1));
  // Pick the next-firing schedule across the strategy.
  let nextScheduleAt: string | null = null;
  let nextScheduleId: number | null = null;
  for (const s of args.schedules) {
    if (s.status !== "active") continue;
    if (!nextScheduleAt || s.next_run_at < nextScheduleAt) {
      nextScheduleAt = s.next_run_at;
      nextScheduleId = s.id ?? null;
    }
  }

  const activeOrders = args.orders.filter((o) => o.status === "active" && !isOrderExpired(o));
  const pendingTriggers: PendingTriggerEntry[] = [];

  // Group by base_token so we only fetch each price once.
  const priceCache = new Map<string, number | null>();
  const fetchPrice = async (token: string): Promise<number | null> => {
    if (priceCache.has(token)) return priceCache.get(token) ?? null;
    if (!args.livePriceFn) {
      priceCache.set(token, null);
      return null;
    }
    try {
      const p = await args.livePriceFn(token);
      priceCache.set(token, p);
      return p;
    } catch {
      priceCache.set(token, null);
      return null;
    }
  };

  for (const o of activeOrders) {
    const current = await fetchPrice(o.base_token);
    let threshold: number | null = null;
    let wouldFire = false;
    let trailingWm: number | null = null;
    let trailingTracking: boolean | null = null;
    if (o.trigger_type === "trailing") {
      trailingTracking = null;
      const evalResult = evaluateTrailingTrigger(o, current);
      trailingTracking = evalResult.tracking;
      trailingWm = evalResult.nextWaterMark;
      // Fire threshold = HWM × (1 ± trail_pct).
      if (o.trail_pct != null && evalResult.nextWaterMark != null) {
        const slip = o.trail_pct / 100;
        threshold =
          o.side === "sell"
            ? evalResult.nextWaterMark * (1 - slip)
            : evalResult.nextWaterMark * (1 + slip);
      }
      wouldFire = evalResult.triggered;
    } else {
      threshold = o.target_price_usd;
      wouldFire = isOrderTriggered(o, current);
    }
    const distancePct =
      current != null && threshold != null && current !== 0
        ? ((threshold - current) / current) * 100
        : null;
    pendingTriggers.push({
      orderId: o.id ?? -1,
      trigger: o.trigger_type,
      side: o.side,
      currentPriceUsd: current,
      fireThresholdUsd: threshold,
      distancePct,
      wouldFireNow: wouldFire,
      trailingWaterMarkUsd: trailingWm,
      trailingTracking,
    });
  }

  pendingTriggers.sort((a, b) => {
    // Closest to firing first. wouldFireNow goes to the top.
    if (a.wouldFireNow !== b.wouldFireNow) return a.wouldFireNow ? -1 : 1;
    const aDist = a.distancePct != null ? Math.abs(a.distancePct) : Infinity;
    const bDist = b.distancePct != null ? Math.abs(b.distancePct) : Infinity;
    return aDist - bDist;
  });

  return { nextScheduleAt, nextScheduleId, pendingTriggers, rebalanceDrift };
}

// ── valuation (mark-to-market) ──────────────────────────────

/** Adapt success-status real trades to the MTM walker's row shape.
 *  The walker only reads (strategy, timestamp, id, chain, direction,
 *  base_token/symbol/amount, quote_symbol/amount) — every one of
 *  which TradeRow shares. */
function toMtmRows(trades: readonly TradeRow[]): PaperTradeRow[] {
  return trades
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
    }));
}

async function buildValuation(args: {
  tag: string;
  trades: TradeRow[] | PaperTradeRow[];
  isPaper: boolean;
  markPriceFn?: PaperPriceFetcher;
  nowIso: string;
}): Promise<ValuationSection> {
  const rows = args.isPaper
    ? (args.trades as PaperTradeRow[])
    : toMtmRows(args.trades as TradeRow[]);
  // No oracle injected → every open position reports unpriced. Cost
  // basis is still exact, and the section stays deterministic.
  const fetchPrice: PaperPriceFetcher = args.markPriceFn ?? (async () => null);
  const report = await computePaperPnlMtm(rows, fetchPrice, { nowIso: args.nowIso });
  // Rows are pre-filtered to the tag, so there is at most one bucket
  // (untagged rows can't reach here — the DB query filters on
  // strategy). Defensive: merge if multiple ever appear.
  const buckets = report.summaries;
  const positions = buckets.flatMap((b) => b.positions);
  const realizedQuote = buckets.reduce((acc, b) => acc + b.realizedQuote, 0);
  const unrealizedVals = buckets.map((b) => b.unrealizedQuote).filter((v): v is number => v != null);
  const hasOpen = positions.some((p) => p.amount > 1e-9);
  const unrealizedQuote = hasOpen
    ? (unrealizedVals.length > 0 ? unrealizedVals.reduce((a, v) => a + v, 0) : null)
    : 0;
  // Trajectory: rows are tag-filtered so there is one bucket in
  // practice; with multiple defensive buckets the per-bucket
  // cumulatives can't be merged without re-walking — take the single
  // bucket's timeline, else empty.
  const realizedTimeline = buckets.length === 1 ? buckets[0].realizedTimeline : [];
  return {
    markedAt: report.timestamp,
    realizedQuote,
    unrealizedQuote,
    totalQuote: realizedQuote + (unrealizedQuote ?? 0),
    openValueQuote: buckets.reduce((acc, b) => acc + b.openValueQuote, 0),
    positions,
    unpricedPositionCount: buckets.reduce((acc, b) => acc + b.unpricedPositionCount, 0),
    skippedNonStableQuote: buckets.reduce((acc, b) => acc + b.skippedNonStableQuote, 0),
    untrackedSellQuote: positions.reduce((acc, p) => acc + p.untrackedSellQuote, 0),
    realizedTimeline,
  };
}

// ── mode detection ──────────────────────────────────────────

/**
 * Auto-detect paper vs real mode from the primitives + trade data.
 * Rules:
 *  - If `mode` was explicitly passed, honor it.
 *  - Else: if EVERY non-terminal primitive has paper=1, → paper.
 *  - Else if there are paper_trades but no real trades, → paper.
 *  - Else → real.
 */
export function resolveMode(args: {
  mode: ReportMode;
  orders: OrderRow[];
  schedules: ScheduleRow[];
  realTradeCount: number;
  paperTradeCount: number;
}): "real" | "paper" {
  if (args.mode === "real") return "real";
  if (args.mode === "paper") return "paper";
  const active = [...args.orders, ...args.schedules].filter((p) => p.status === "active");
  if (active.length > 0) {
    const allPaper = active.every((p) => ((p as { paper?: number }).paper ?? 0) === 1);
    if (allPaper) return "paper";
    const anyReal = active.some((p) => ((p as { paper?: number }).paper ?? 0) === 0);
    if (anyReal) return "real";
  }
  if (args.realTradeCount === 0 && args.paperTradeCount > 0) return "paper";
  return "real";
}

// ── main entry ──────────────────────────────────────────────

export async function buildStrategyReport(
  args: BuildStrategyReportArgs,
): Promise<StrategyReport> {
  const tag = normalizeTag(args.tag);
  const window: ReportWindow = args.window ?? "30d";
  const mode: ReportMode = args.mode ?? "auto";
  const now = (args.nowFn ?? (() => new Date()))();
  const config = args.config ?? loadConfig();
  const sections = new Set<ReportSection>(
    args.sections ?? ["identity", "composition", "performance", "position", "risk", "activity", "forward"],
  );

  // Pull primitives + trades once; subsequent section builders are
  // pure transformations.
  const playbookId = playbookIdFromTag(tag);
  const playbook = playbookId != null ? getPlaybookById(playbookId) : null;

  const orders = listOrders({ strategy: tag });
  const schedules = listSchedules({ strategy: tag });
  const rebalances = listRebalancePlans({ strategy: tag });

  // Fetch a generous slice of trade history — the largest window
  // section (performance "all") uses everything, so we always pull
  // all and the per-section since-filter applies in-memory.
  const realTrades = recentTrades({ strategy: tag, limit: 5000 });
  const paperTrades = listPaperTrades({ strategy: tag, limit: 5000 });

  const resolvedMode = resolveMode({
    mode,
    orders,
    schedules,
    realTradeCount: realTrades.length,
    paperTradeCount: paperTrades.length,
  });

  const tradesForReport: TradeRow[] | PaperTradeRow[] =
    resolvedMode === "paper" ? paperTrades : realTrades;
  const isPaper = resolvedMode === "paper";

  const sinceIso = windowToSinceIso(window, now);

  const report: StrategyReport = {
    tag,
    mode: resolvedMode,
    window,
    generatedAt: now.toISOString(),
  };

  let composition: CompositionSection | undefined;
  if (sections.has("composition")) {
    composition = buildComposition({ orders, schedules, rebalances });
    report.composition = composition;
  }

  if (sections.has("identity")) {
    report.identity = buildIdentity({
      tag,
      playbook,
      composition: composition ?? buildComposition({ orders, schedules, rebalances }),
      now,
    });
  }

  if (sections.has("performance")) {
    report.performance = buildPerformance({
      trades: tradesForReport,
      isPaper,
      sinceIso,
    });
  }

  if (sections.has("position")) {
    // Position uses the FULL trade history (positions accumulate
    // since strategy start, not just the window). The window
    // covers performance metrics, not position state.
    report.position = buildPosition({ trades: tradesForReport, isPaper });
  }

  if (sections.has("risk")) {
    report.risk = buildRisk({
      tag,
      config,
      drawdownLookup: getDrawdownState,
      spentLookup: usdSpentUnderStrategy,
    });
  }

  if (sections.has("activity")) {
    // Bound the journal lookup to the orders we actually own.
    const orderIds = orders.map((o) => o.id ?? 0).filter((id) => id > 0);
    report.activity = buildActivity({
      trades: tradesForReport,
      isPaper,
      orderIds,
      journalLookup: replayOrderEntries,
    });
  }

  if (sections.has("forward")) {
    report.forward = await buildForward({
      schedules,
      orders,
      rebalances,
      livePriceFn: args.livePriceFn,
    });
  }

  if (sections.has("valuation")) {
    report.valuation = await buildValuation({
      tag,
      trades: tradesForReport,
      isPaper,
      markPriceFn: args.markPriceFn,
      nowIso: now.toISOString(),
    });
  }

  return report;
}

// ── re-exports for testing convenience ──────────────────────

export {
  buildComposition as _buildComposition,
  buildPerformance as _buildPerformance,
  buildPosition as _buildPosition,
  buildRisk as _buildRisk,
  buildActivity as _buildActivity,
  buildForward as _buildForward,
  buildIdentity as _buildIdentity,
  buildValuation as _buildValuation,
};
