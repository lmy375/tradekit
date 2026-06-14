/**
 * Activity digest — operator-facing window summary.
 *
 * The natural complement to iter23's `tradekit status`:
 *   - status  = "what is the engine doing RIGHT NOW"
 *   - digest  = "what happened over the last N (hours / days)"
 *
 * Composes trades + strategy fires + safety events + errors from
 * existing DB tables into a structured report. Three formats:
 *   - text:  multi-section operator-readable
 *   - slack: markdown formatted for direct webhook delivery
 *   - json:  structured shape for downstream consumers
 *
 * Production workflow this unlocks: a daily cron job pipes the slack
 * format into a Slack incoming webhook, no operator intervention.
 *
 *   0 9 * * * tradekit digest --window 24h --format slack | \
 *     curl -X POST -H 'Content-Type: text/plain' --data-binary @- $SLACK_WEBHOOK
 *
 * Performance: ~6 indexed DB queries, all bounded by `since` predicate.
 * Sub-100ms on a busy install.
 */

import { ToolError } from "./errors.js";
import {
  recentTrades,
  recentAudit,
  auditSummary,
  listOrders,
  listSchedules,
  listRebalancePlans,
  listDrawdownStates,
  listAlertEvents,
  listStrategyAlertStates,
  listPaperTrades,
  openDb,
  type TradeRow,
  type OrderRow,
  type ScheduleRow,
  type RebalanceRow,
  listSignalEvents,
  sweepExpiredTradeIntents,
  listTradeIntents,
} from "./db.js";
import { computeBudgetConsumption } from "./strategyBudget.js";
import { loadConfig, type Config } from "./config.js";
import { buildEquityCurve } from "./equity.js";
import { reviewSafety } from "./safetyReview.js";
import { gatherSafetyHeadroom } from "./safetyHeadroom.js";
import { gatherStrategyComparison } from "./strategyCompare.js";

// ── window parsing ───────────────────────────────────────────

/**
 * Parse a window string like "24h", "7d", "1h", "30d" into a
 * milliseconds value. Used for the `since` predicate on every DB
 * query. Range-checked to [1 minute, 90 days] — beyond 90d the audit
 * log + trades table get large enough that the digest's "top errors
 * + recent fires" lose signal.
 */
export function parseWindowMs(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(raw.trim());
  if (!m) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--window "${raw}" — use formats like 1h, 24h, 7d, 30d.`,
    );
  }
  const n = parseFloat(m[1]);
  const unit = m[2];
  const ms = n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
  if (ms < 60_000) {
    throw new ToolError("INVALID_PARAMS", `--window "${raw}" — minimum 1 minute.`);
  }
  if (ms > 90 * 86_400_000) {
    throw new ToolError("INVALID_PARAMS", `--window "${raw}" — maximum 90 days. Split into multiple shorter windows.`);
  }
  return ms;
}

// ── output shape ─────────────────────────────────────────────

export type HealthVerdict = "healthy" | "attention" | "critical";

export interface TradesSection {
  total: number;
  success: number;
  pending: number;
  failed: number;
  /** Sum of quote_amount across success+pending trades. Assumes
   *  USD-pegged quote (USDC/USDT/DAI) — same convention dailyUsdVolume
   *  uses. Unpriced trades contribute 0. */
  usdVolume: number;
  successRatePct: number;
  /** Top 5 strategy tags by trade count. */
  topStrategies: Array<{ strategy: string; count: number; usdVolume: number }>;
  /** Top 5 base symbols by trade count. */
  topBases: Array<{ symbol: string; count: number }>;
}

export interface FiresSection {
  /** Orders that transitioned to a terminal state during the window. */
  ordersFilled: number;
  ordersCancelled: number;
  ordersExpired: number;
  ordersFailed: number;
  /** Schedules that fired during the window (last_run_at in window).
   *  This counts SCHEDULES with at least one fire, not the total fire
   *  count — a busy schedule that fired 10× shows as 1. For exact
   *  fire counts use the trades section's strategy tag breakdown. */
  schedulesFired: number;
  /** Rebalance plans that ran during the window. */
  rebalanceRuns: number;
  /** v29 journal-exact counts. The legacy schedulesFired /
   *  rebalanceRuns fields count PRIMITIVES with ≥1 run (last_run_at
   *  approximation — a busy schedule that fired 10× shows as 1).
   *  When the decision journals are enabled these carry the EXACT
   *  per-decision counts inside the window. They read the journal
   *  tables directly, so they're 0 (not null) when the journals are
   *  off — disambiguate via the *JournalEnabled flags. */
  scheduleJournalEnabled: boolean;
  scheduleFireCount: number;
  scheduleFireFailures: number;
  scheduleHookFailures: number;
  rebalanceJournalEnabled: boolean;
  rebalanceExecutedCount: number;
  rebalanceInBandCount: number;
  rebalanceFailureCount: number;
  /** v36.5: external signal events received in the window, and how
   *  many of those fired at least one order. A non-zero gap means
   *  alerts arrived that fired NOTHING — the integration-debugging
   *  signal. */
  signalsReceived: number;
  signalsFired: number;
  /** Most recently fired orders (top 5). */
  recentFills: Array<{
    orderId: number;
    side: "buy" | "sell";
    base: string | null;
    quote: string | null;
    fillPrice: number | null;
    filledAt: string;
  }>;
}

export interface SafetyEventsSection {
  /** Number of times the drawdown breaker tripped DURING the window
   *  (distinct from "currently tripped" — a breaker that tripped
   *  and was later reset still counts). */
  drawdownTrips: number;
  /** Currently tripped scopes (snapshot at digest time). */
  drawdownCurrentlyTripped: Array<{ scope: string; trippedAt: string; drawdownPct: number | null }>;
  /** Trade attempts blocked by strategy budgets. */
  budgetBlocks: number;
  /** Trade attempts blocked by position limits (POSITION_LIMIT_EXCEEDED +
   *  POSITION_CAP_EXCEEDED — both are net-exposure caps). */
  positionLimitBlocks: number;
  /** Trade attempts blocked by the auto-honeypot probe. */
  honeypotBlocks: number;
  /** Trade attempts blocked by gas-budget guardrail. */
  gasBudgetBlocks: number;
  /** v100: trade attempts blocked by the per-tx / daily USD cap
   *  (AMOUNT_EXCEEDS_LIMIT). The most fundamental guardrail — previously
   *  uncounted in the digest. */
  amountLimitBlocks: number;
  /** v100: BUYS blocked by the v84 per-strategy realized-loss breaker
   *  (STRATEGY_LOSS_BREAKER_TRIPPED). A strategy bled past its loss cap. */
  strategyLossBlocks: number;
  /** v100: trades blocked by a configured execution-quality cap
   *  (SLIPPAGE_TOO_HIGH + QUOTE_DEVIATION_EXCEEDED). */
  executionCapBlocks: number;
  /** v100: remaining guardrail blocks not in a named bucket above
   *  (CONTRACT_BLOCKED + SAFEGUARD_TRIGGERED catch-all) — keeps the heartbeat
   *  COMPLETE so no guardrail trip is ever invisible. */
  otherGuardrailBlocks: number;
  /** Currently configured budgets utilized > 80%. */
  budgetWarnings: Array<{ tag: string; window: "lifetime" | "daily"; utilizationPct: number }>;
}

/**
 * v57: STANDING safety posture — distinct from SafetyEventsSection (which
 * counts what HAPPENED in the window). This is the config posture (v51) +
 * the binding runtime limit (v53) AT digest time. Closes the same gap v55
 * closed for `health`: a cron-monitored digest could read "healthy" while
 * the wallet is wide-open (no USD ceiling) or about to halt on a limit.
 * Null when the config couldn't be reviewed (best-effort).
 */
export interface PostureSection {
  verdict: "hardened" | "moderate" | "exposed";
  criticalGaps: number;
  warnGaps: number;
  /** Worst-severity config gap finding, for the one-liner. */
  topGap: string | null;
  /** Tightest active runtime limit (v53 binding). Null when none configured. */
  binding: {
    label: string;
    scope: string;
    status: "ok" | "approaching" | "exhausted" | "tripped";
    utilizationPct: number | null;
  } | null;
}

export interface ErrorsSection {
  totalAuditRows: number;
  errorRows: number;
  errorRatePct: number;
  /** Top 5 error codes by count. */
  topErrors: Array<{ code: string; count: number; lastSeen: string }>;
}

/** v28: strategy-alert transitions inside the window, from the
 *  durable alert_events journal — exact counts, full repeat history. */
export interface AlertsSection {
  fired: number;
  resolved: number;
  /** Snapshot at digest time (not window-scoped). */
  currentlyActive: number;
  /** Top rule types by fired count in the window. */
  topRules: Array<{ ruleType: string; fired: number }>;
}

/** Paper-trading activity inside the window — the digest previously
 *  counted only REAL trades, leaving dry-run strategies invisible in
 *  the daily summary. */
export interface PaperSection {
  fills: number;
  buys: number;
  sells: number;
  /** Sum of quote_amount across window fills (USD ≈ stable quote). */
  quoteVolume: number;
  topStrategies: Array<{ strategy: string; count: number }>;
}

export interface ComparisonDelta {
  trades: number;
  usdVolume: number;
  ordersFilled: number;
  errorRows: number;
  /** v28/v29 additions. */
  alertsFired: number;
  paperFills: number;
}

/** v38: equity movement inside the digest window — from the v37
 *  snapshot feed (pure DB read). null when the feed has fewer than
 *  two points in the window's scope. */
export interface EquitySection {
  accountsKey: string;
  chainsKey: string;
  startUsd: number;
  endUsd: number;
  changeAbs: number;
  changePct: number | null;
  points: number;
}

/** v88: per-strategy realized-P&L roll-up for the window — the proactive
 *  effectiveness signal (v83 comparison surfaced in the cron briefing).
 *  `bleeding` is the capital-allocation flag: strategies losing money. */
export interface StrategyDigestSection {
  /** Strategies with priced (stablecoin-quoted) trades in the window. */
  count: number;
  totalRealizedUsd: number;
  best: { strategy: string; realizedUsd: number } | null;
  worst: { strategy: string; realizedUsd: number } | null;
  /** Strategies with negative realized P&L — review/cut candidates. */
  bleeding: string[];
}

/** v95: promote-outcome divergence — for each PROMOTED strategy, did the
 *  live run deliver what the paper baseline promised, or is it quietly
 *  bleeding against expectation? This is the trust pipeline's most
 *  dangerous outcome (looked great on paper, loses money live) made
 *  PROACTIVE — it was previously only checkable on demand. Distinct from
 *  the v88 strategy section, which flags raw negative P&L: a strategy can
 *  post POSITIVE raw P&L (so v88 stays quiet) yet realize a fraction of
 *  its paper promise or slip far worse — divergence catches that. */
export interface PromoteOutcomeSection {
  /** Deployed playbooks evaluated this run. */
  checked: number;
  /** Only the actionable verdicts — underperforming or diverged. on_track
   *  and insufficient_data are omitted (nothing for the operator to do). */
  flagged: Array<{
    playbookId: number;
    name: string;
    verdict: "underperforming" | "diverged";
    /** The lead reason from the outcome report (most-severe first). */
    topReason: string;
  }>;
  /** The single worst flagged strategy (diverged ranks above
   *  underperforming), for the one-line verdict reason. Null when none. */
  worst: { playbookId: number; name: string; verdict: "underperforming" | "diverged" } | null;
}

/** v47.5: agent trade-approval queue activity. pendingNow is the
 *  actionable number — an open intent means an agent is BLOCKED
 *  waiting on a human. */
export interface IntentsSection {
  pendingNow: number;
  createdInWindow: number;
  executedInWindow: number;
  rejectedInWindow: number;
  expiredInWindow: number;
  /** Age of the oldest still-pending intent, minutes. */
  oldestPendingMinutes: number | null;
}

export interface DigestReport {
  generatedAt: string;
  /** ISO timestamp of the window's start. */
  windowStart: string;
  /** ISO timestamp of the window's end (= generatedAt). */
  windowEnd: string;
  /** Window label as the operator supplied. */
  windowLabel: string;
  /** Overall health verdict computed from the sections. */
  verdict: HealthVerdict;
  /** Human-readable reasons feeding the verdict. */
  verdictReasons: string[];
  trades: TradesSection;
  fires: FiresSection;
  safety: SafetyEventsSection;
  /** v57: standing config posture + binding runtime limit (null when the
   *  config couldn't be reviewed). */
  posture: PostureSection | null;
  errors: ErrorsSection;
  alerts: AlertsSection;
  paper: PaperSection;
  /** v47.5: approval-queue activity. */
  intents: IntentsSection;
  /** v38: null when the snapshot feed has < 2 points in the window. */
  equity: EquitySection | null;
  /** v88: per-strategy realized P&L for the window (null when no priced
   *  strategy trades fall in it). Surfaces bleeders proactively. */
  strategy?: StrategyDigestSection | null;
  /** v95: promote-outcome divergence across promoted strategies (null when
   *  no deployed playbooks, or the scan failed best-effort). A STANDING
   *  signal (paper-vs-live, not window-scoped), so null in comparisons. */
  promote?: PromoteOutcomeSection | null;
  /** When `--compare` was set, the same digest for the immediately-
   *  prior window with the same length. */
  comparison: {
    prior: DigestReport | null;
    delta: ComparisonDelta;
  } | null;
}

// ── orchestrator ─────────────────────────────────────────────

export interface GatherDigestArgs {
  windowLabel: string;
  windowMs: number;
  /** Optional: also compute the immediately-prior window of the same
   *  length for comparison deltas. */
  compare?: boolean;
  config?: Config;
  now?: Date;
}

export async function gatherDigest(args: GatherDigestArgs): Promise<DigestReport> {
  const now = args.now ?? new Date();
  const config = args.config ?? loadConfig();

  const report = gatherWindow({
    nowMs: now.getTime(),
    windowMs: args.windowMs,
    windowLabel: args.windowLabel,
    config,
    includeComparison: args.compare ?? false,
  });

  // v95: fold in promote-outcome divergence — a STANDING signal computed
  // here (not in gatherWindow) because it's async and not window-scoped, like
  // posture. Re-run classifyVerdict with it so the verdict has a single source
  // of truth (rather than escalating ad hoc). The prior-window comparison keeps
  // promote=null, consistent with posture (a current-state concept).
  const promote = await gatherPromoteOutcomes(config, now);
  report.promote = promote;
  if (promote && promote.flagged.length > 0) {
    const re = classifyVerdict({
      trades: report.trades,
      fires: report.fires,
      safety: report.safety,
      errors: report.errors,
      alerts: report.alerts,
      paper: report.paper,
      intents: report.intents,
      posture: report.posture,
      strategy: report.strategy,
      promote,
    });
    report.verdict = re.verdict;
    report.verdictReasons = re.verdictReasons;
  }
  return report;
}

/** v57: standing posture — config review (v51) + binding runtime limit
 *  (v53), composed from the primitives (not via health, to avoid coupling).
 *  Best-effort: any failure → null so the digest never breaks on it. */
function gatherPosture(config: Config): PostureSection | null {
  try {
    const review = reviewSafety(config);
    const worst =
      review.gaps.find((g) => g.severity === "critical") ??
      review.gaps.find((g) => g.severity === "warn");
    let binding: PostureSection["binding"] = null;
    try {
      const hr = gatherSafetyHeadroom({ config });
      if (hr.binding) {
        binding = {
          label: hr.binding.label,
          scope: hr.binding.scope,
          status: hr.binding.status,
          utilizationPct: hr.binding.utilizationPct,
        };
      }
    } catch {
      // headroom reads the DB; a failure leaves binding null (posture half).
    }
    return {
      verdict: review.verdict,
      criticalGaps: review.counts.critical,
      warnGaps: review.counts.warn,
      topGap: worst?.finding ?? null,
      binding,
    };
  } catch {
    return null;
  }
}

/** v38: equity delta from the snapshot feed. Scope-disciplined like
 *  the equity surfaces: most-snapshotted scope, never mixed. */
function gatherEquity(args: { since: string; until?: string }): EquitySection | null {
  try {
    const curve = buildEquityCurve({ sinceIso: args.since });
    let points = curve.points;
    if (args.until) points = points.filter((p) => p.at <= args.until!);
    if (points.length < 2) return null;
    const first = points[0];
    const last = points[points.length - 1];
    return {
      accountsKey: curve.accountsKey,
      chainsKey: curve.chainsKey,
      startUsd: first.totalUsd,
      endUsd: last.totalUsd,
      changeAbs: last.totalUsd - first.totalUsd,
      changePct: first.totalUsd > 0 ? ((last.totalUsd - first.totalUsd) / first.totalUsd) * 100 : null,
      points: points.length,
    };
  } catch {
    return null; // feed unavailable — the digest never fails on equity
  }
}

// v88: per-strategy realized performance for the window — deterministic
// (DB-only, stablecoin-$1 model), so it fits the digest's no-RPC nature. Null
// when no priced strategy trades fall in the window.
function gatherStrategyPerf(args: { since: string; until?: string }): StrategyDigestSection | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const r = gatherStrategyComparison({ sinceIso: args.since });
    if (r.strategies.length === 0) return null;
    return {
      count: r.strategies.length,
      totalRealizedUsd: r.totalRealizedUsd,
      best: r.best ? { strategy: r.best.strategy, realizedUsd: r.best.realizedUsd } : null,
      worst: r.worst ? { strategy: r.worst.strategy, realizedUsd: r.worst.realizedUsd } : null,
      bleeding: r.bleeding,
    };
  } catch {
    return null; // feed unavailable — the digest never fails on strategy perf
  }
}

// v95: promote-outcome divergence — a STANDING (not window-scoped) signal.
// For every DEPLOYED playbook, reuse the SAME gatherPromoteOutcome verdict
// engine (v50) that the on-demand check uses — no duplicated thresholds, so
// the digest can never disagree with `playbook promote-outcome`. The verdict
// is deterministic and offline (it keys off realized PnL + execution + cadence,
// never MTM), so we inject a null mark-price fetcher to keep the digest's
// no-RPC nature. Best-effort: one bad playbook never breaks the digest, and
// the whole scan degrades to null on any failure.
async function gatherPromoteOutcomes(config: Config, now: Date): Promise<PromoteOutcomeSection | null> {
  try {
    const { listPlaybooks } = await import("./db.js");
    const deployed = listPlaybooks({ status: "deployed" });
    if (deployed.length === 0) return null;
    const { gatherPromoteOutcome } = await import("./promoteOutcome.js");
    const flagged: PromoteOutcomeSection["flagged"] = [];
    for (const pb of deployed) {
      try {
        const r = await gatherPromoteOutcome({
          playbookId: pb.id,
          config,
          nativeUsd: null,
          // Offline: the verdict never depends on MTM, so a null fetcher
          // keeps the digest RPC-free while preserving the verdict exactly.
          markPriceFn: async () => null,
          now,
        });
        if (r.verdict === "underperforming" || r.verdict === "diverged") {
          flagged.push({
            playbookId: pb.id,
            name: pb.name,
            verdict: r.verdict,
            topReason: r.reasons[0] ?? r.verdict,
          });
        }
      } catch {
        // a single playbook's outcome check failing must not sink the digest
      }
    }
    // diverged outranks underperforming for the one-line verdict reason.
    const worst =
      flagged.find((f) => f.verdict === "diverged") ?? flagged.find((f) => f.verdict === "underperforming") ?? null;
    return {
      checked: deployed.length,
      flagged,
      worst: worst ? { playbookId: worst.playbookId, name: worst.name, verdict: worst.verdict } : null,
    };
  } catch {
    return null; // promote-outcome unavailable — the digest never fails on it
  }
}

function gatherWindow(args: {
  nowMs: number;
  windowMs: number;
  windowLabel: string;
  config: Config;
  includeComparison: boolean;
}): DigestReport {
  const windowEnd = new Date(args.nowMs).toISOString();
  const windowStart = new Date(args.nowMs - args.windowMs).toISOString();

  const trades = gatherTrades({ since: windowStart });
  const fires = gatherFires({ since: windowStart, config: args.config });
  const safety = gatherSafety({ since: windowStart, config: args.config });
  const errors = gatherErrors({ since: windowStart });
  const alerts = gatherAlerts({ since: windowStart });
  const paper = gatherPaper({ since: windowStart });
  const equity = gatherEquity({ since: windowStart });
  const intents = gatherIntents({ since: windowStart, now: new Date(args.nowMs) });
  const posture = gatherPosture(args.config);
  const strategy = gatherStrategyPerf({ since: windowStart });

  const { verdict, verdictReasons } = classifyVerdict({ trades, fires, safety, errors, alerts, paper, intents, posture, strategy });

  let comparison: DigestReport["comparison"] = null;
  if (args.includeComparison) {
    const priorEnd = new Date(args.nowMs - args.windowMs).toISOString();
    const priorStart = new Date(args.nowMs - 2 * args.windowMs).toISOString();
    const priorTrades = gatherTrades({ since: priorStart, until: priorEnd });
    const priorFires = gatherFiresWithUntil({ since: priorStart, until: priorEnd, config: args.config });
    const priorErrors = gatherErrors({ since: priorStart, until: priorEnd });
    const priorSafety = gatherSafety({ since: priorStart, until: priorEnd, config: args.config });
    const priorAlerts = gatherAlerts({ since: priorStart, until: priorEnd });
    const priorPaper = gatherPaper({ since: priorStart, until: priorEnd });
    const priorEquity = gatherEquity({ since: priorStart, until: priorEnd });
    const priorIntents = gatherIntents({ since: priorStart, until: priorEnd, now: new Date(args.nowMs) });
    const priorVerdict = classifyVerdict({
      trades: priorTrades, fires: priorFires, safety: priorSafety, errors: priorErrors,
      alerts: priorAlerts, paper: priorPaper, intents: priorIntents,
    });
    const prior: DigestReport = {
      generatedAt: windowStart,
      windowStart: priorStart,
      windowEnd: priorEnd,
      windowLabel: args.windowLabel,
      verdict: priorVerdict.verdict,
      verdictReasons: priorVerdict.verdictReasons,
      trades: priorTrades, fires: priorFires, safety: priorSafety, errors: priorErrors,
      // Posture is a CURRENT-standing concept, not window-scoped — the prior
      // window has no distinct posture, so it's null in the comparison.
      posture: null,
      alerts: priorAlerts, paper: priorPaper, intents: priorIntents, equity: priorEquity,
      comparison: null,
    };
    comparison = {
      prior,
      delta: {
        trades: trades.total - prior.trades.total,
        usdVolume: trades.usdVolume - prior.trades.usdVolume,
        ordersFilled: fires.ordersFilled - prior.fires.ordersFilled,
        errorRows: errors.errorRows - prior.errors.errorRows,
        alertsFired: alerts.fired - prior.alerts.fired,
        paperFills: paper.fills - prior.paper.fills,
      },
    };
  }

  return {
    generatedAt: windowEnd,
    windowStart,
    windowEnd,
    windowLabel: args.windowLabel,
    verdict,
    verdictReasons,
    trades,
    fires,
    safety,
    posture,
    errors,
    alerts,
    paper,
    intents,
    equity,
    strategy,
    comparison,
  };
}

// ── trades section ───────────────────────────────────────────

function gatherTrades(args: { since: string; until?: string }): TradesSection {
  // Pull every trade in the window — bounded by the window timestamp
  // predicate which uses idx_trades_ts. Limit high enough to cover
  // even a busy install (1000 trades in 24h is ~heavy ops); operators
  // who hit this should split into shorter windows.
  const rows = recentTrades({ limit: 5000, since: args.since });
  const filtered = args.until ? rows.filter((r) => r.timestamp < args.until!) : rows;

  let success = 0, pending = 0, failed = 0;
  let usdVolume = 0;
  const strategyTotals = new Map<string, { count: number; usdVolume: number }>();
  const baseTotals = new Map<string, number>();
  for (const r of filtered) {
    if (r.status === "success") success++;
    else if (r.status === "pending") pending++;
    else if (r.status === "failed") failed++;

    if (r.status === "success" || r.status === "pending") {
      const usd = parseFloat(r.quote_amount);
      if (Number.isFinite(usd)) usdVolume += usd;
    }
    if (r.strategy) {
      const cur = strategyTotals.get(r.strategy) ?? { count: 0, usdVolume: 0 };
      cur.count++;
      const usd = parseFloat(r.quote_amount);
      if (Number.isFinite(usd) && (r.status === "success" || r.status === "pending")) cur.usdVolume += usd;
      strategyTotals.set(r.strategy, cur);
    }
    const baseSym = r.base_symbol ?? "(unknown)";
    baseTotals.set(baseSym, (baseTotals.get(baseSym) ?? 0) + 1);
  }
  const total = filtered.length;
  const successRatePct = total > 0 ? (success / total) * 100 : 0;
  const topStrategies = Array.from(strategyTotals.entries())
    .map(([strategy, v]) => ({ strategy, count: v.count, usdVolume: v.usdVolume }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const topBases = Array.from(baseTotals.entries())
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return { total, success, pending, failed, usdVolume, successRatePct, topStrategies, topBases };
}

// ── fires section ────────────────────────────────────────────

function gatherFires(args: { since: string; config: Config }): FiresSection {
  return gatherFiresWithUntil({ since: args.since, config: args.config });
}

/** v29 journal-exact decision counts inside the window. Direct SQL —
 *  the journal tables are indexed on checked_at. */
function journalCounts(args: { since: string; until?: string }): {
  scheduleFireCount: number;
  scheduleFireFailures: number;
  scheduleHookFailures: number;
  rebalanceExecutedCount: number;
  rebalanceInBandCount: number;
  rebalanceFailureCount: number;
} {
  // Lexical ISO comparison: the max JS date renders as "+275760-…",
  // which sorts BEFORE "2026-…" — use a plain far-future literal.
  const until = args.until ?? "9999-12-31T23:59:59.999Z";
  try {
    const db = openDb();
    const count = (sql: string, ...binds: string[]): number =>
      (db.prepare(sql).get(args.since, until, ...binds) as { n: number }).n;
    return {
      scheduleFireCount: count(
        `SELECT COUNT(*) AS n FROM schedule_check_log WHERE checked_at >= ? AND checked_at < ? AND decision = 'fired'`,
      ),
      scheduleFireFailures: count(
        `SELECT COUNT(*) AS n FROM schedule_check_log WHERE checked_at >= ? AND checked_at < ? AND decision = 'fire_failed'`,
      ),
      scheduleHookFailures: count(
        `SELECT COUNT(*) AS n FROM schedule_check_log WHERE checked_at >= ? AND checked_at < ? AND decision = 'hook_failed'`,
      ),
      rebalanceExecutedCount: count(
        `SELECT COUNT(*) AS n FROM rebalance_check_log WHERE checked_at >= ? AND checked_at < ? AND decision = 'fired'`,
      ),
      rebalanceInBandCount: count(
        `SELECT COUNT(*) AS n FROM rebalance_check_log WHERE checked_at >= ? AND checked_at < ? AND decision = 'in_band'`,
      ),
      rebalanceFailureCount: count(
        `SELECT COUNT(*) AS n FROM rebalance_check_log WHERE checked_at >= ? AND checked_at < ? AND decision IN ('failed', 'partial_failure')`,
      ),
    };
  } catch {
    return {
      scheduleFireCount: 0, scheduleFireFailures: 0, scheduleHookFailures: 0,
      rebalanceExecutedCount: 0, rebalanceInBandCount: 0, rebalanceFailureCount: 0,
    };
  }
}

function gatherFiresWithUntil(args: { since: string; until?: string; config: Config }): FiresSection {
  // Orders: filter by filled_at / updated_at in window for the
  // terminal-state counters. We pull all orders + filter in JS
  // because listOrders doesn't support a time predicate on a
  // computed field — but orders is a small table (typically <1K
  // rows even on busy installs), so the scan is cheap.
  const allOrders = listOrders({ status: "all", limit: 5000 });
  let ordersFilled = 0, ordersCancelled = 0, ordersExpired = 0, ordersFailed = 0;
  const fills: Array<OrderRow & { _filledAt: string }> = [];
  for (const o of allOrders) {
    if (o.filled_at && inWindow(o.filled_at, args)) {
      if (o.status === "filled") {
        ordersFilled++;
        fills.push({ ...o, _filledAt: o.filled_at });
      }
    }
    // Cancelled / expired / failed: updated_at is the terminal-
    // transition timestamp. status is the final state.
    if (o.status === "cancelled" && inWindow(o.updated_at, args)) ordersCancelled++;
    if (o.status === "expired" && inWindow(o.updated_at, args)) ordersExpired++;
    if (o.status === "failed" && inWindow(o.updated_at, args)) ordersFailed++;
  }
  const recentFills = fills
    .sort((a, b) => b._filledAt.localeCompare(a._filledAt))
    .slice(0, 5)
    .map((o) => ({
      orderId: o.id!,
      side: o.side,
      base: o.base_symbol,
      quote: o.quote_symbol,
      fillPrice: o.fill_price,
      filledAt: o._filledAt,
    }));

  // Schedules: last_run_at in window means the schedule fired AT
  // LEAST ONCE in the window. We can't distinguish "fired once" from
  // "fired 10 times" without a journal, so this counts SCHEDULES
  // that fired, not individual fires. The trades-by-strategy breakdown
  // already covers exact fire counts when a strategy tag is set.
  const allSchedules: ScheduleRow[] = listSchedules({ status: "all", limit: 5000 });
  let schedulesFired = 0;
  for (const s of allSchedules) {
    if (s.last_run_at && inWindow(s.last_run_at, args)) schedulesFired++;
  }

  // Rebalance plans: same logic on last_run_at.
  const allPlans: RebalanceRow[] = listRebalancePlans({ status: "all", limit: 5000 });
  let rebalanceRuns = 0;
  for (const p of allPlans) {
    if (p.last_run_at && inWindow(p.last_run_at, args)) rebalanceRuns++;
  }

  const jc = journalCounts({ since: args.since, until: args.until });

  // v36.5: signal-inbox counts. listSignalEvents is newest-first;
  // window-filter in JS (the table stays small via retention).
  let signalsReceived = 0;
  let signalsFired = 0;
  try {
    for (const ev of listSignalEvents({ limit: 1000 })) {
      if (!inWindow(ev.received_at, args)) continue;
      signalsReceived += 1;
      if (ev.consumed_by_order != null) signalsFired += 1;
    }
  } catch { /* pre-v35 db — section reads 0 */ }

  return {
    ordersFilled, ordersCancelled, ordersExpired, ordersFailed,
    schedulesFired, rebalanceRuns,
    scheduleJournalEnabled: args.config.engine.scheduleJournal?.enabled === true,
    rebalanceJournalEnabled: args.config.engine.rebalanceJournal?.enabled === true,
    ...jc,
    signalsReceived,
    signalsFired,
    recentFills,
  };
}

// ── alerts section (v28) ─────────────────────────────────────

function gatherAlerts(args: { since: string; until?: string }): AlertsSection {
  const events = listAlertEvents({ sinceIso: args.since, untilIso: args.until });
  let fired = 0, resolved = 0;
  const byRule = new Map<string, number>();
  for (const e of events) {
    if (e.event === "fired") {
      fired++;
      byRule.set(e.rule_type, (byRule.get(e.rule_type) ?? 0) + 1);
    } else {
      resolved++;
    }
  }
  const topRules = Array.from(byRule.entries())
    .map(([ruleType, n]) => ({ ruleType, fired: n }))
    .sort((a, b) => b.fired - a.fired)
    .slice(0, 5);
  const currentlyActive = listStrategyAlertStates({ active: true }).length;
  return { fired, resolved, currentlyActive, topRules };
}

// ── paper section ────────────────────────────────────────────

function gatherPaper(args: { since: string; until?: string }): PaperSection {
  const rows = listPaperTrades({ sinceIso: args.since, untilIso: args.until, limit: 5000 });
  let buys = 0, sells = 0, quoteVolume = 0;
  const byStrategy = new Map<string, number>();
  for (const r of rows) {
    if (r.direction === "buy") buys++;
    else sells++;
    const q = parseFloat(r.quote_amount);
    if (Number.isFinite(q)) quoteVolume += q;
    const tag = r.strategy ?? "(unattributed)";
    byStrategy.set(tag, (byStrategy.get(tag) ?? 0) + 1);
  }
  const topStrategies = Array.from(byStrategy.entries())
    .map(([strategy, count]) => ({ strategy, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return { fills: rows.length, buys, sells, quoteVolume, topStrategies };
}

function inWindow(iso: string, args: { since: string; until?: string }): boolean {
  if (iso < args.since) return false;
  if (args.until && iso >= args.until) return false;
  return true;
}

// ── safety section ───────────────────────────────────────────

function gatherSafety(args: {
  since: string;
  until?: string;
  config: Config;
}): SafetyEventsSection {
  // Pull audit rows in the window with non-null error codes; count
  // by code. Use recentAudit which uses idx_audit_ts.
  const auditRows = recentAudit(5000, {
    since: args.since,
  });
  const filtered = args.until ? auditRows.filter((r) => r.timestamp < args.until!) : auditRows;
  // v100: count EVERY guardrail block (errors.GUARDRAIL_BLOCK_CODES), not just
  // the original 5 — a tripped per-tx cap (AMOUNT_EXCEEDS_LIMIT) or loss breaker
  // (STRATEGY_LOSS_BREAKER_TRIPPED) is a real-money safety event that belongs in
  // the heartbeat. Each guardrail code maps to exactly one bucket; the
  // otherGuardrailBlocks catch-all keeps the accounting COMPLETE (a regression
  // guard in digest.test.ts asserts no GUARDRAIL_BLOCK_CODE is dropped).
  let drawdownTrips = 0, budgetBlocks = 0, positionLimitBlocks = 0;
  let honeypotBlocks = 0, gasBudgetBlocks = 0;
  let amountLimitBlocks = 0, strategyLossBlocks = 0, executionCapBlocks = 0, otherGuardrailBlocks = 0;
  for (const r of filtered) {
    if (!r.error_code) continue;
    switch (r.error_code) {
      case "DRAWDOWN_CIRCUIT_BREAKER_TRIPPED": drawdownTrips++; break;
      case "STRATEGY_BUDGET_EXCEEDED":         budgetBlocks++; break;
      case "POSITION_LIMIT_EXCEEDED":          positionLimitBlocks++; break;
      case "POSITION_CAP_EXCEEDED":            positionLimitBlocks++; break;
      case "TOKEN_BLOCKED":                    honeypotBlocks++; break;
      case "GAS_BUDGET_EXCEEDED":              gasBudgetBlocks++; break;
      case "AMOUNT_EXCEEDS_LIMIT":             amountLimitBlocks++; break;
      case "STRATEGY_LOSS_BREAKER_TRIPPED":    strategyLossBlocks++; break;
      case "SLIPPAGE_TOO_HIGH":                executionCapBlocks++; break;
      case "QUOTE_DEVIATION_EXCEEDED":         executionCapBlocks++; break;
      case "CONTRACT_BLOCKED":                 otherGuardrailBlocks++; break;
      case "SAFEGUARD_TRIGGERED":              otherGuardrailBlocks++; break;
    }
  }

  // Currently-tripped drawdown scopes (snapshot at digest time).
  const drawdownStates = listDrawdownStates();
  const drawdownCurrentlyTripped = drawdownStates
    .filter((s) => s.tripped_at != null)
    .map((s) => {
      const drawdownPct = s.last_value_usd != null && s.peak_usd > 0
        ? ((s.peak_usd - s.last_value_usd) / s.peak_usd) * 100
        : null;
      return { scope: s.scope_key, trippedAt: s.tripped_at!, drawdownPct };
    });

  // Budget warnings (utilization > 80%). Live consumption — same
  // computation `tradekit strategies --budget` uses.
  const budgets = args.config.safety.strategyBudgets ?? [];
  const budgetWarnings: SafetyEventsSection["budgetWarnings"] = [];
  if (budgets.length > 0) {
    const consumption = computeBudgetConsumption({ budgets });
    for (const c of consumption) {
      if (c.rule.lifetimeUsd != null && c.lifetimeSpentUsd != null && c.rule.lifetimeUsd > 0) {
        const pct = (c.lifetimeSpentUsd / c.rule.lifetimeUsd) * 100;
        if (pct >= 80) budgetWarnings.push({ tag: c.rule.tag, window: "lifetime", utilizationPct: pct });
      }
      if (c.rule.dailyUsd != null && c.dailySpentUsd != null && c.rule.dailyUsd > 0) {
        const pct = (c.dailySpentUsd / c.rule.dailyUsd) * 100;
        if (pct >= 80) budgetWarnings.push({ tag: c.rule.tag, window: "daily", utilizationPct: pct });
      }
    }
  }

  return {
    drawdownTrips, drawdownCurrentlyTripped,
    budgetBlocks, positionLimitBlocks, honeypotBlocks, gasBudgetBlocks,
    amountLimitBlocks, strategyLossBlocks, executionCapBlocks, otherGuardrailBlocks,
    budgetWarnings,
  };
}

// ── errors section ───────────────────────────────────────────

function gatherErrors(args: { since: string; until?: string }): ErrorsSection {
  if (args.until) {
    // auditSummary doesn't take an `until` predicate; for the
    // comparison-prior path we filter manually. Cheap enough at the
    // 5000-row limit.
    const rows = recentAudit(5000, { since: args.since });
    const filtered = rows.filter((r) => r.timestamp < args.until!);
    const errorCounts = new Map<string, { count: number; lastSeen: string }>();
    for (const r of filtered) {
      if (!r.error_code) continue;
      const cur = errorCounts.get(r.error_code) ?? { count: 0, lastSeen: r.timestamp };
      cur.count++;
      if (r.timestamp > cur.lastSeen) cur.lastSeen = r.timestamp;
      errorCounts.set(r.error_code, cur);
    }
    const errorRows = filtered.filter((r) => r.error_code).length;
    return {
      totalAuditRows: filtered.length,
      errorRows,
      errorRatePct: filtered.length > 0 ? (errorRows / filtered.length) * 100 : 0,
      topErrors: Array.from(errorCounts.entries())
        .map(([code, v]) => ({ code, count: v.count, lastSeen: v.lastSeen }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    };
  }
  const summary = auditSummary({ since: args.since });
  return {
    totalAuditRows: summary.totalRows,
    errorRows: summary.errorRows,
    errorRatePct: summary.totalRows > 0 ? (summary.errorRows / summary.totalRows) * 100 : 0,
    topErrors: summary.byErrorCode.slice(0, 5).map((e) => ({
      code: e.errorCode, count: e.count, lastSeen: e.lastSeen,
    })),
  };
}

// ── verdict classification ───────────────────────────────────

/**
 * Aggregate signals into one operator-readable health verdict.
 *
 * critical (🔴) — any of:
 *   - drawdown breaker tripped (at any point) OR currently tripped
 *   - error rate > 25%
 * attention (🟡) — any of:
 *   - error rate > 10%
 *   - any budget utilization > 80%
 *   - any safety blocks (budget / position / honeypot / gas)
 *   - any orders failed
 * healthy (🟢) — none of the above.
 *
 * Reasons are accumulated regardless of verdict level — the renderer
 * picks the most severe but operators can inspect all signals via JSON.
 */
/** v47.5: approval-queue section. Sweeps expiry lazily first so
 *  pendingNow never counts a corpse. */
export function gatherIntents(args: { since: string; until?: string; now?: Date }): IntentsSection {
  const now = args.now ?? new Date();
  try {
    sweepExpiredTradeIntents(now.toISOString());
    const rows = listTradeIntents({ limit: 500 });
    const until = args.until ?? now.toISOString();
    const inWindow = (ts: string | null) => ts != null && ts >= args.since && ts <= until;
    const pending = rows.filter((r) => r.status === "pending");
    let oldest: number | null = null;
    for (const r of pending) {
      const age = (now.getTime() - Date.parse(r.created_at)) / 60_000;
      if (oldest == null || age > oldest) oldest = age;
    }
    return {
      pendingNow: pending.length,
      createdInWindow: rows.filter((r) => inWindow(r.created_at)).length,
      executedInWindow: rows.filter((r) => r.status === "executed" && inWindow(r.executed_at ?? r.decided_at)).length,
      rejectedInWindow: rows.filter((r) => r.status === "rejected" && inWindow(r.decided_at)).length,
      expiredInWindow: rows.filter((r) => r.status === "expired" && inWindow(r.expires_at)).length,
      oldestPendingMinutes: oldest,
    };
  } catch {
    // The digest must render even if the intents table is somehow
    // unreadable — empty section, never a crash.
    return { pendingNow: 0, createdInWindow: 0, executedInWindow: 0, rejectedInWindow: 0, expiredInWindow: 0, oldestPendingMinutes: null };
  }
}

export function classifyVerdict(args: {
  trades: TradesSection;
  fires: FiresSection;
  safety: SafetyEventsSection;
  errors: ErrorsSection;
  alerts: AlertsSection;
  paper: PaperSection;
  /** v47.5: optional so pre-existing callers/tests stay valid —
   *  omitted means "no queue activity". */
  intents?: IntentsSection;
  /** v57: standing config posture + binding runtime limit. Optional so
   *  pre-existing callers/tests stay valid. */
  posture?: PostureSection | null;
  /** v88: per-strategy realized performance — a bleeding strategy is an
   *  effectiveness concern (losing money), distinct from operational health. */
  strategy?: StrategyDigestSection | null;
  /** v95: promote-outcome divergence — a promoted strategy not delivering its
   *  paper promise. The trust pipeline's most dangerous outcome. */
  promote?: PromoteOutcomeSection | null;
}): { verdict: HealthVerdict; verdictReasons: string[] } {
  const reasons: string[] = [];
  let critical = false;
  let attention = false;

  // v47.5: an open intent means an agent is BLOCKED on a human;
  // expiries mean proposals are dying un-reviewed.
  if (args.intents != null && args.intents.pendingNow > 0) {
    reasons.push(`${args.intents.pendingNow} agent trade(s) awaiting approval${args.intents.oldestPendingMinutes != null ? ` (oldest ${Math.round(args.intents.oldestPendingMinutes)}min)` : ""} — tradekit intents list`);
    attention = true;
  }
  if (args.intents != null && args.intents.expiredInWindow > 0) {
    reasons.push(`${args.intents.expiredInWindow} agent proposal(s) EXPIRED un-reviewed during window`);
    attention = true;
  }

  if (args.safety.drawdownTrips > 0) {
    reasons.push(`drawdown breaker tripped ${args.safety.drawdownTrips}× during window`);
    critical = true;
  }
  if (args.safety.drawdownCurrentlyTripped.length > 0) {
    reasons.push(`drawdown breaker currently tripped (${args.safety.drawdownCurrentlyTripped.length} scope${args.safety.drawdownCurrentlyTripped.length === 1 ? "" : "s"})`);
    critical = true;
  }
  if (args.errors.errorRatePct > 25) {
    reasons.push(`error rate ${args.errors.errorRatePct.toFixed(1)}% > 25% threshold`);
    critical = true;
  }
  if (args.errors.errorRatePct > 10 && args.errors.errorRatePct <= 25) {
    reasons.push(`error rate ${args.errors.errorRatePct.toFixed(1)}% > 10% threshold`);
    attention = true;
  }
  for (const w of args.safety.budgetWarnings) {
    reasons.push(`budget "${w.tag}" ${w.window} utilization ${w.utilizationPct.toFixed(0)}%`);
    attention = true;
  }
  // v100: every guardrail block counts toward the verdict — not just the
  // original 4. Drawdown is handled above (critical); the rest are attention.
  const safetyBlockTotal =
    args.safety.budgetBlocks +
    args.safety.positionLimitBlocks +
    args.safety.honeypotBlocks +
    args.safety.gasBudgetBlocks +
    args.safety.amountLimitBlocks +
    args.safety.strategyLossBlocks +
    args.safety.executionCapBlocks +
    args.safety.otherGuardrailBlocks;
  if (safetyBlockTotal > 0) {
    // Name the loss breaker + per-tx cap explicitly — they're the most
    // consequential and were previously invisible here.
    const highlights: string[] = [];
    if (args.safety.strategyLossBlocks > 0) highlights.push(`${args.safety.strategyLossBlocks} loss-breaker`);
    if (args.safety.amountLimitBlocks > 0) highlights.push(`${args.safety.amountLimitBlocks} per-tx/daily cap`);
    reasons.push(
      `${safetyBlockTotal} safety block${safetyBlockTotal === 1 ? "" : "s"} during window${highlights.length > 0 ? ` (${highlights.join(", ")})` : ""}`,
    );
    attention = true;
  }
  if (args.fires.ordersFailed > 0) {
    reasons.push(`${args.fires.ordersFailed} order${args.fires.ordersFailed === 1 ? "" : "s"} failed during window`);
    attention = true;
  }
  // v29: journal-exact engine failures — these catch failures the
  // legacy counters can't see (a schedule that failed then later
  // succeeded leaves no trace on last_run_status).
  if (args.fires.scheduleFireFailures > 0) {
    reasons.push(`${args.fires.scheduleFireFailures} schedule fire failure${args.fires.scheduleFireFailures === 1 ? "" : "s"} during window`);
    attention = true;
  }
  if (args.fires.rebalanceFailureCount > 0) {
    reasons.push(`${args.fires.rebalanceFailureCount} rebalance failure${args.fires.rebalanceFailureCount === 1 ? "" : "s"} during window`);
    attention = true;
  }
  // v88: a strategy bleeding money in the window is an effectiveness concern —
  // operationally everything may be "fine" (trades fill) while capital leaks.
  if (args.strategy != null && args.strategy.bleeding.length > 0) {
    const w = args.strategy.worst;
    reasons.push(
      `${args.strategy.bleeding.length} strateg${args.strategy.bleeding.length === 1 ? "y" : "ies"} bleeding` +
        (w && w.realizedUsd < 0 ? ` (worst: ${w.strategy} −$${Math.abs(w.realizedUsd).toFixed(2)})` : "") +
        " — tradekit strategies compare",
    );
    attention = true;
  }
  // v95: promote-outcome divergence — a promoted strategy not delivering its
  // paper promise. `diverged` (not making money with real execution, against a
  // paper baseline that justified deploying real capital) is the trust
  // pipeline's most dangerous outcome → critical, the operator should pause/cut
  // it. `underperforming` (edge shrank, or execution materially worse) →
  // attention. Distinct from v88 bleeding: divergence flags even a strategy
  // posting positive raw P&L that falls short of its paper promise.
  if (args.promote && args.promote.flagged.length > 0) {
    const diverged = args.promote.flagged.filter((f) => f.verdict === "diverged");
    const under = args.promote.flagged.filter((f) => f.verdict === "underperforming");
    if (diverged.length > 0) {
      const w = diverged[0];
      reasons.push(
        `${diverged.length} promoted strateg${diverged.length === 1 ? "y" : "ies"} DIVERGED from paper` +
          ` (worst: ${w.name} #${w.playbookId}) — losing money vs the paper promise · tradekit playbook promote-outcome ${w.playbookId}`,
      );
      critical = true;
    }
    if (under.length > 0) {
      const w = under[0];
      reasons.push(
        `${under.length} promoted strateg${under.length === 1 ? "y" : "ies"} underperforming paper` +
          ` (e.g. ${w.name} #${w.playbookId}) — tradekit playbook promote-outcome ${w.playbookId}`,
      );
      attention = true;
    }
  }
  // v28: a strategy alert firing inside the window is by definition
  // worth attention — that's what the operator configured it for.
  if (args.alerts.fired > 0) {
    reasons.push(`${args.alerts.fired} strategy alert${args.alerts.fired === 1 ? "" : "s"} fired during window`);
    attention = true;
  }
  if (args.alerts.currentlyActive > 0) {
    reasons.push(`${args.alerts.currentlyActive} strategy alert${args.alerts.currentlyActive === 1 ? "" : "s"} currently active`);
    attention = true;
  }

  // v57: standing posture. EXPOSED config (no USD ceiling / safety off) is
  // a config-level danger no other window signal surfaces → attention. The
  // binding limit nearing its edge is surfaced too, EXCEPT drawdown (already
  // covered above by drawdownCurrentlyTripped) — avoids double-counting.
  if (args.posture) {
    if (args.posture.verdict === "exposed") {
      reasons.push(`wallet safety posture EXPOSED${args.posture.topGap ? `: ${args.posture.topGap}` : ""} — tradekit safety review`);
      attention = true;
    }
    const b = args.posture.binding;
    if (b && b.label.toLowerCase().indexOf("drawdown") === -1 && (b.status === "approaching" || b.status === "exhausted")) {
      reasons.push(`${b.label} (${b.scope}) ${b.status}${b.utilizationPct != null ? ` at ${b.utilizationPct.toFixed(0)}%` : ""} — tradekit safety headroom`);
      attention = true;
    }
  }

  let verdict: HealthVerdict = "healthy";
  if (critical) verdict = "critical";
  else if (attention) verdict = "attention";

  return { verdict, verdictReasons: reasons };
}

// ── verdict emoji (exported for renderers) ───────────────────

export function verdictEmoji(v: HealthVerdict): string {
  switch (v) {
    case "healthy": return "🟢";
    case "attention": return "🟡";
    case "critical": return "🔴";
  }
}

export function verdictLabel(v: HealthVerdict): string {
  switch (v) {
    case "healthy": return "healthy";
    case "attention": return "attention";
    case "critical": return "critical";
  }
}

// Silence unused-import warnings in callers that pull these types.
export type { TradeRow, OrderRow };
