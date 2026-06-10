// ──────────────────────────────────────────────────────────────────
// Forensic timeline (iter36): unified chronological event view
// across every operationally-significant source in tradekit.
//
// Why: after iter31-35 the operator has excellent state-centric
// observability (strategy report, alerts, in-place edit, hot-reload
// preflight), but the *time-centric* forensic story is fragmented.
// Answering "what happened between 13:55 and 14:05?" today requires
// 6+ separate commands and manual merge-by-timestamp.
//
// This module is the third leg of the observability stool:
//
//   iter31  strategy report  — state, per-strategy
//   iter32  strategy alerts  — push, threshold-driven
//   iter36  unified timeline — time, cross-strategy
//
// Design constraints:
//
//   1. ENTIRELY pure-ish — DB reads only, no writes, no signal IO.
//      The CLI / MCP renderers consume the typed `TimelineEvent[]`.
//
//   2. No new schema — composes existing tables (trades,
//      paper_trades, order_check_log, audit_log,
//      strategy_alert_state). No migration cost; existing
//      installs get the feature on the next binary upgrade.
//
//   3. Each source is a SEPARATE collector function. Adding a new
//      event source (e.g. a future engine.events table) is one
//      function + one test, not a sprawling switch statement.
//
//   4. Stable sort: newest-first by timestamp, with id as the
//      deterministic tiebreaker. The same query at the same
//      moment always returns rows in the same order — important
//      for CI diffs and JSON-tail pipelines.
//
//   5. The CLI passes filters down to per-source SQL queries
//      (since/until/chain/account/strategy) so we don't bring
//      every row into memory just to filter. limit applies AFTER
//      the merge so the global newest-N is correct even when
//      sources are unbalanced.
// ──────────────────────────────────────────────────────────────────

import {
  recentTrades,
  listPaperTrades,
  recentAudit,
  listStrategyAlertStates,
  listAlertEvents,
  type AlertEventRow,
  type ScheduleCheckLogRow,
  type RebalanceCheckLogRow,
  listEngineEvents,
  openDb,
  type TradeRow,
  type PaperTradeRow,
  type AuditRow,
  type OrderCheckLogRow,
  type StrategyAlertStateRow,
  type EngineEventRow,
  listSignalEvents,
  type SignalEventRow,
} from "./db.js";

// ── public types ────────────────────────────────────────────

/** Every event surfaces this base shape; the discriminated `kind`
 *  + the per-kind `source` carry the type-specific detail. */
export interface TimelineEvent {
  /** ISO timestamp, UTC. */
  at: string;
  kind: EventKind;
  severity: EventSeverity;
  /** One-line description suitable for a table row. */
  summary: string;
  /** Source identifiers — every event carries enough info that the
   *  operator can drill into the underlying row. */
  refs: EventRefs;
  /** Optional pre-fetched details (revert reason, slippage_bps, etc.)
   *  for the JSON consumer. The text renderer ignores this. */
  details?: Record<string, string | number | boolean | null>;
}

export type EventSeverity = "info" | "warn" | "critical";

export type EventKind =
  | "trade.fill"               // success trade (status === "success")
  | "trade.failure"            // failed / reverted trade
  | "trade.pending"            // trade row written but not yet resolved
  | "paper.fill"               // paper_trades row
  | "order.journal"            // order_check_log entry (engine decision)
  | "order.edited"             // order_check_log "edited_by_operator"
  | "schedule.journal"         // v29 schedule_check_log entry (fired / failed / retired / hook)
  | "rebalance.journal"        // v29 rebalance_check_log entry (incl. in_band drift history)
  | "audit.tool"               // audit_log row tagged with a tool action
  | "audit.error"              // audit_log row with error_code set
  | "alert.fired"              // strategy_alert_state row turned active
  | "alert.resolved"           // strategy_alert_state row last_evaluated_at after first_triggered_at fell to active=0
  | "alert.breaker"            // circuit breaker paused a strategy's primitives (rule action: "pause")
  | "signal.received"          // v35 external signal event arrived (webhook / cli / mcp), with consumption state
  // Iter39: durable engine state transitions from the v26
  // engine_events table. Replaces the iter36 audit_log heuristic
  // for these events — exact data, no inference.
  | "engine.started"
  | "engine.stopped"
  | "engine.lock"
  | "engine.unlock"
  | "worker.degraded"
  | "worker.recovered"
  | "config.reloaded"
  | "config.reload_failed";

/** Single source of truth for the kind registry. The CLI --kinds
 *  validator and the web /api/timeline whitelist both consume this —
 *  pre-this they each kept their own copy, and alert.breaker (added
 *  later) silently went missing from the web list. */
export const ALL_EVENT_KINDS: EventKind[] = [
  "trade.fill", "trade.failure", "trade.pending", "paper.fill",
  "order.journal", "order.edited", "schedule.journal", "rebalance.journal",
  "audit.tool", "audit.error",
  "alert.fired", "alert.resolved", "alert.breaker",
  "signal.received",
  "engine.started", "engine.stopped", "engine.lock", "engine.unlock",
  "worker.degraded", "worker.recovered", "config.reloaded", "config.reload_failed",
];

export interface EventRefs {
  /** Concrete primitive id when applicable (order id, schedule id,
   *  trade id, audit id, engine_event id). Used by the renderer
   *  for the "drill into this row" link. */
  type: "trade" | "paper_trade" | "order" | "schedule" | "rebalance" | "audit" | "alert" | "engine_event" | "signal";
  id: number | string;
  /** Chain / account / strategy denormalized so the consumer can
   *  filter without joining. Nullable when irrelevant. */
  chain?: string | null;
  account?: string | null;
  strategy?: string | null;
  txHash?: string | null;
  /** Iter39: worker name on worker.* engine events. Lets the
   *  CLI render "engine.worker.degraded [orders]" labels. */
  workerName?: string | null;
  /** Iter39: writer pid on engine_events rows. Lets operators
   *  filter "what THIS engine run did". */
  pid?: number | null;
}

// ── collector input ─────────────────────────────────────────

export interface CollectTimelineArgs {
  /** ISO timestamp lower bound (inclusive). Default: now - 4h. */
  sinceIso?: string;
  /** ISO timestamp upper bound (inclusive). Default: now. */
  untilIso?: string;
  /** Restrict to a chain (matches `chain` column on each source). */
  chain?: string;
  /** Restrict to an account label. */
  account?: string;
  /** Restrict to a strategy tag (literal — no wildcard in v1). */
  strategy?: string;
  /** Subset of event kinds to include. Empty/undefined = all. */
  kinds?: EventKind[];
  /** Minimum severity floor: "info" lets everything through;
   *  "warn" drops info; "critical" drops info + warn. */
  minSeverity?: EventSeverity;
  /** Optional toggle: include paper trades. Default: include them.
   *  Some operators want a "real only" forensic view. */
  includePaper?: boolean;
  /** Cap on returned rows. Default 100. Applied AFTER merging
   *  + sorting so the newest-N across all sources is correct. */
  limit?: number;
  /** Injection seam — tests stub each source with deterministic
   *  data. Production callers leave these undefined. */
  injects?: TimelineInjections;
}

export interface TimelineInjections {
  tradesFn?: typeof recentTrades;
  paperTradesFn?: typeof listPaperTrades;
  auditFn?: typeof recentAudit;
  alertsFn?: typeof listStrategyAlertStates;
  /** v28: alert_events journal source (exact transitions). When the
   *  journal has no rows in the window, the collector falls back to
   *  the legacy state-row heuristic via alertsFn. */
  alertEventsFn?: typeof listAlertEvents;
  journalFn?: (since: string, until: string, limit: number) => OrderCheckLogRow[];
  /** v29: schedule/rebalance decision-journal sources. */
  scheduleJournalFn?: (since: string, until: string, limit: number) => ScheduleCheckLogRow[];
  signalEventsFn?: typeof listSignalEvents;
  rebalanceJournalFn?: (since: string, until: string, limit: number) => RebalanceCheckLogRow[];
  /** Iter39: engine_events table source. */
  engineEventsFn?: typeof listEngineEvents;
}

// ── window resolution ───────────────────────────────────────

/**
 * Resolve a since/until window. When `since` is unset, default to
 * 4h ago. When `until` is unset, default to now. The values are
 * carried as ISO strings throughout so SQLite's string comparison
 * (which matches ISO-8601 lexically) handles range queries
 * correctly with the existing per-source indices.
 */
export function resolveWindow(args: { sinceIso?: string; untilIso?: string; nowFn?: () => Date }): {
  sinceIso: string;
  untilIso: string;
} {
  const now = (args.nowFn ?? (() => new Date()))();
  const untilIso = args.untilIso ?? now.toISOString();
  const sinceIso = args.sinceIso ?? new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
  return { sinceIso, untilIso };
}

// ── per-source collectors ───────────────────────────────────

/** Collect trade events (fills, failures, pending). */
export function collectTradeEvents(args: {
  trades: readonly TradeRow[];
  filter: Pick<CollectTimelineArgs, "chain" | "account" | "strategy" | "kinds" | "minSeverity">;
  sinceIso: string;
  untilIso: string;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const t of args.trades) {
    if (t.timestamp < args.sinceIso || t.timestamp > args.untilIso) continue;
    if (args.filter.chain && t.chain !== args.filter.chain.toLowerCase()) continue;
    if (args.filter.account && t.account !== args.filter.account) continue;
    if (args.filter.strategy && t.strategy !== args.filter.strategy) continue;
    const isSuccess = t.status === "success";
    const isFailure = t.status === "failed" || t.status === "reverted";
    const kind: EventKind = isSuccess ? "trade.fill" : isFailure ? "trade.failure" : "trade.pending";
    if (!kindAllowed(kind, args.filter.kinds)) continue;
    const severity: EventSeverity = isFailure ? "critical" : isSuccess ? "info" : "warn";
    if (!severityAllowed(severity, args.filter.minSeverity)) continue;
    const summary = isSuccess
      ? `TRADE ${t.direction.toUpperCase()} ${t.base_amount} ${t.base_symbol ?? "?"} @ ${t.price} ${t.quote_symbol ?? "?"}`
      : isFailure
        ? `TRADE FAILED ${t.direction.toUpperCase()} ${t.base_amount} ${t.base_symbol ?? "?"}: ${t.revert_reason ?? t.status}`
        : `TRADE PENDING ${t.direction.toUpperCase()} ${t.base_amount} ${t.base_symbol ?? "?"}`;
    out.push({
      at: t.timestamp,
      kind,
      severity,
      summary,
      refs: {
        type: "trade",
        id: t.id ?? -1,
        chain: t.chain,
        account: t.account,
        strategy: t.strategy ?? null,
        txHash: t.tx_hash,
      },
      details: {
        direction: t.direction,
        baseAmount: t.base_amount,
        quoteAmount: t.quote_amount,
        aggregator: t.aggregator ?? null,
        slippageBps: t.realized_slippage_bps ?? null,
        gasCostUsd: t.gas_cost_usd_at_trade ?? null,
      },
    });
  }
  return out;
}

/** Collect paper_trades. Always tagged severity=info (paper trades
 *  never fail in v1; iter30 PAPER_INSUFFICIENT_BALANCE happens at
 *  fire-time and never produces a paper_trades row). */
export function collectPaperEvents(args: {
  paperTrades: readonly PaperTradeRow[];
  filter: Pick<CollectTimelineArgs, "chain" | "account" | "strategy" | "kinds" | "minSeverity">;
  sinceIso: string;
  untilIso: string;
}): TimelineEvent[] {
  if (!kindAllowed("paper.fill", args.filter.kinds)) return [];
  if (!severityAllowed("info", args.filter.minSeverity)) return [];
  const out: TimelineEvent[] = [];
  for (const p of args.paperTrades) {
    if (p.timestamp < args.sinceIso || p.timestamp > args.untilIso) continue;
    if (args.filter.chain && p.chain !== args.filter.chain.toLowerCase()) continue;
    if (args.filter.account && p.account !== args.filter.account) continue;
    if (args.filter.strategy && p.strategy !== args.filter.strategy) continue;
    out.push({
      at: p.timestamp,
      kind: "paper.fill",
      severity: "info",
      summary: `PAPER ${p.direction.toUpperCase()} ${p.base_amount} ${p.base_symbol ?? "?"} @ ${p.price} (paper)`,
      refs: {
        type: "paper_trade",
        id: p.id ?? -1,
        chain: p.chain,
        account: p.account,
        strategy: p.strategy ?? null,
      },
      details: {
        sourceType: p.source_type,
        sourceId: p.source_id,
        slippageBps: p.slippage_bps ?? null,
      },
    });
  }
  return out;
}

/** Collect audit_log rows. Severity is derived: rows with an
 *  error_code surface as `critical`; safety-rule tools surface as
 *  `warn`; everything else `info`. */
export function collectAuditEvents(args: {
  audit: readonly AuditRow[];
  filter: Pick<CollectTimelineArgs, "chain" | "account" | "kinds" | "minSeverity">;
  sinceIso: string;
  untilIso: string;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const a of args.audit) {
    if (a.timestamp < args.sinceIso || a.timestamp > args.untilIso) continue;
    if (args.filter.chain && a.chain !== args.filter.chain.toLowerCase()) continue;
    if (args.filter.account && a.account !== args.filter.account) continue;
    const hasError = a.error_code != null;
    const kind: EventKind = hasError ? "audit.error" : "audit.tool";
    if (!kindAllowed(kind, args.filter.kinds)) continue;
    // Severity heuristic: error_code → critical; engine-lock /
    // unlock + safety-related tools → warn; everything else info.
    const severity: EventSeverity = hasError
      ? "critical"
      : isElevatedAuditTool(a.tool)
        ? "warn"
        : "info";
    if (!severityAllowed(severity, args.filter.minSeverity)) continue;
    const summary = hasError
      ? `AUDIT ${a.tool}: ${a.error_code} ${a.error_message ? "— " + a.error_message.slice(0, 80) : ""}`
      : `AUDIT ${a.tool}${a.tx_hash ? ` (tx ${a.tx_hash.slice(0, 10)}…)` : ""}`;
    out.push({
      at: a.timestamp,
      kind,
      severity,
      summary,
      refs: {
        type: "audit",
        id: a.id ?? -1,
        chain: a.chain,
        account: a.account,
        txHash: a.tx_hash,
      },
      details: {
        tool: a.tool,
        caller: a.caller,
        errorCode: a.error_code,
        errorMessage: a.error_message,
        result: a.result,
      },
    });
  }
  return out;
}

/** Audit tools whose action is operationally elevated (warn-level
 *  by default even on success). Centralizes the heuristic so adding
 *  a new sensitive tool is one entry. */
function isElevatedAuditTool(tool: string): boolean {
  return (
    tool === "engine_lock" ||
    tool === "engine_unlock" ||
    tool === "approve" ||
    tool === "revoke" ||
    tool === "revoke_all" ||
    tool === "cancel_tx" ||
    tool === "speedup_tx" ||
    tool === "safety_reset_drawdown" ||
    tool.startsWith("playbook_destroy") ||
    tool.startsWith("paper_reset")
  );
}

/** Collect order_check_log entries that are operationally
 *  interesting in a forensic view. Routine tracking_started /
 *  hwm_advanced rows would drown the timeline; we surface
 *  only firing decisions, errors, near-threshold notices, and
 *  iter34 operator edits. */
export function collectJournalEvents(args: {
  rows: readonly OrderCheckLogRow[];
  filter: Pick<CollectTimelineArgs, "kinds" | "minSeverity">;
  sinceIso: string;
  untilIso: string;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const r of args.rows) {
    if (r.checked_at < args.sinceIso || r.checked_at > args.untilIso) continue;
    // Skip the chatty decisions — operators looking at a 4h window
    // don't want N hwm_advanced rows per order.
    if (r.decision === "tracking_started" || r.decision === "hwm_advanced") continue;
    const isEdit = r.decision === "edited_by_operator";
    const kind: EventKind = isEdit ? "order.edited" : "order.journal";
    if (!kindAllowed(kind, args.filter.kinds)) continue;
    const severity: EventSeverity =
      r.decision === "error"
        ? "critical"
        : r.decision === "triggered_fired"
          ? "warn"
          : r.decision === "edited_by_operator"
            ? "info"
            : r.decision === "near_threshold"
              ? "warn"
              : "info";
    if (!severityAllowed(severity, args.filter.minSeverity)) continue;
    const summary = isEdit
      ? `ORDER #${r.order_id} edited by operator${r.notes ? ` — ${r.notes.slice(0, 60)}` : ""}`
      : `ORDER #${r.order_id} ${r.decision}${
          r.price_usd != null ? ` @ $${r.price_usd}` : ""
        }${r.notes ? ` (${r.notes.slice(0, 60)})` : ""}`;
    out.push({
      at: r.checked_at,
      kind,
      severity,
      summary,
      refs: {
        type: "order",
        id: r.order_id,
      },
      details: {
        decision: r.decision,
        priceUsd: r.price_usd,
        waterMarkUsd: r.water_mark_usd,
        thresholdUsd: r.threshold_usd,
        notes: r.notes,
      },
    });
  }
  return out;
}

/** v29: schedule decision journal → timeline. Every decision is
 *  operationally interesting (the engine only writes on fires,
 *  failures, retirements, lock transitions, hook outcomes) — no
 *  chattiness filter needed, unlike the order journal. */
export function collectScheduleJournalEvents(args: {
  rows: readonly ScheduleCheckLogRow[];
  filter: Pick<CollectTimelineArgs, "kinds" | "minSeverity">;
  sinceIso: string;
  untilIso: string;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const r of args.rows) {
    if (r.checked_at < args.sinceIso || r.checked_at > args.untilIso) continue;
    if (!kindAllowed("schedule.journal", args.filter.kinds)) continue;
    const severity: EventSeverity =
      r.decision === "fire_failed" ? "critical" :
      r.decision === "hook_failed" || r.decision === "skipped_locked" || r.decision === "retry_scheduled" || r.decision === "recovered" ? "warn" :
      "info";
    if (!severityAllowed(severity, args.filter.minSeverity)) continue;
    const run = r.run_number != null ? ` (run #${r.run_number})` : "";
    out.push({
      at: r.checked_at,
      kind: "schedule.journal",
      severity,
      summary: `SCHEDULE #${r.schedule_id} ${r.decision}${run}${r.error_code ? ` [${r.error_code}]` : ""}${r.notes ? ` — ${r.notes.slice(0, 60)}` : ""}`,
      refs: { type: "schedule", id: r.schedule_id },
      details: {
        decision: r.decision,
        runNumber: r.run_number,
        txHash: r.tx_hash,
        errorCode: r.error_code,
        notes: r.notes,
      },
    });
  }
  return out;
}

/** v29: rebalance decision journal → timeline. in_band rows carry the
 *  drift reading — surfaced at info severity so a default timeline
 *  shows the drift history without drowning warn-level views. */
export function collectRebalanceJournalEvents(args: {
  rows: readonly RebalanceCheckLogRow[];
  filter: Pick<CollectTimelineArgs, "kinds" | "minSeverity">;
  sinceIso: string;
  untilIso: string;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const r of args.rows) {
    if (r.checked_at < args.sinceIso || r.checked_at > args.untilIso) continue;
    if (!kindAllowed("rebalance.journal", args.filter.kinds)) continue;
    const severity: EventSeverity =
      r.decision === "failed" || r.decision === "partial_failure" ? "critical" :
      r.decision === "fired" || r.decision === "skipped_locked" || r.decision === "retry_scheduled" || r.decision === "skipped_pending_legs" ? "warn" :
      "info";
    if (!severityAllowed(severity, args.filter.minSeverity)) continue;
    const drift =
      r.max_drift_pct != null
        ? ` drift ${r.max_drift_pct.toFixed(2)}%${r.threshold_pct != null ? `/${r.threshold_pct}%` : ""}`
        : "";
    const legs = r.executed_count != null ? ` legs=${r.executed_count}` : "";
    out.push({
      at: r.checked_at,
      kind: "rebalance.journal",
      severity,
      summary: `REBALANCE #${r.plan_id} ${r.decision}${drift}${legs}${r.error_code ? ` [${r.error_code}]` : ""}`,
      refs: { type: "rebalance", id: r.plan_id },
      details: {
        decision: r.decision,
        maxDriftPct: r.max_drift_pct,
        thresholdPct: r.threshold_pct,
        executedCount: r.executed_count,
        skippedCount: r.skipped_count,
        errorCode: r.error_code,
        notes: r.notes,
      },
    });
  }
  return out;
}

/**
 * v28: collect alert events from the durable alert_events journal —
 * every fired/resolved transition is a row written at the moment the
 * watcher emitted the notification, so timestamps are exact and
 * REPEATED transitions inside the window all surface (the legacy
 * state-row reconstruction collapsed them to at most one of each).
 */
export function collectAlertEvents(args: {
  events: readonly AlertEventRow[];
  filter: Pick<CollectTimelineArgs, "strategy" | "kinds" | "minSeverity">;
  sinceIso: string;
  untilIso: string;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const e of args.events) {
    if (args.filter.strategy && e.tag !== args.filter.strategy) continue;
    if (e.at < args.sinceIso || e.at > args.untilIso) continue;
    if (e.event === "fired") {
      const severity = e.severity as EventSeverity;
      if (!kindAllowed("alert.fired", args.filter.kinds) || !severityAllowed(severity, args.filter.minSeverity)) continue;
      out.push({
        at: e.at,
        kind: "alert.fired",
        severity,
        summary: `ALERT FIRED ${e.tag}: ${e.rule_type}${e.message ? ` — ${e.message}` : ""}`,
        refs: { type: "alert", id: `${e.tag}/${e.rule_type}`, strategy: e.tag },
        details: { tag: e.tag, ruleType: e.rule_type, value: e.value_json, message: e.message },
      });
    } else if (e.event === "breaker_paused") {
      if (!kindAllowed("alert.breaker", args.filter.kinds) || !severityAllowed("critical", args.filter.minSeverity)) continue;
      out.push({
        at: e.at,
        kind: "alert.breaker",
        severity: "critical",
        summary: `CIRCUIT BREAKER ${e.tag}: ${e.rule_type}${e.message ? ` — ${e.message}` : ""}`,
        refs: { type: "alert", id: `${e.tag}/${e.rule_type}`, strategy: e.tag },
        details: { tag: e.tag, ruleType: e.rule_type, value: e.value_json, message: e.message },
      });
    } else {
      if (!kindAllowed("alert.resolved", args.filter.kinds) || !severityAllowed("info", args.filter.minSeverity)) continue;
      out.push({
        at: e.at,
        kind: "alert.resolved",
        severity: "info",
        summary: `ALERT RESOLVED ${e.tag}: ${e.rule_type}${e.duration_seconds != null ? ` (after ${Math.floor(e.duration_seconds / 60)}m)` : ""}`,
        refs: { type: "alert", id: `${e.tag}/${e.rule_type}`, strategy: e.tag },
        details: { tag: e.tag, ruleType: e.rule_type, durationSeconds: e.duration_seconds },
      });
    }
  }
  return out;
}

/**
 * LEGACY (pre-v28) reconstruction from strategy_alert_state. Each row
 * in the "active" state corresponds to ONE fired event (at
 * first_triggered_at). Inactive rows in our window with a
 * last_evaluated_at after first_triggered_at correspond to a
 * resolved event — we can't perfectly distinguish the resolution
 * timestamp from the alert state alone, but last_evaluated_at IS
 * the moment the reconciler observed the OK transition (i.e. when
 * the resolved notification was emitted), so it's the right
 * timestamp to use.
 *
 * Kept as the FALLBACK for windows with no alert_events rows —
 * transitions that happened before the v28 migration are only
 * reconstructible this way.
 */
export function collectAlertEventsLegacy(args: {
  states: readonly StrategyAlertStateRow[];
  filter: Pick<CollectTimelineArgs, "strategy" | "kinds" | "minSeverity">;
  sinceIso: string;
  untilIso: string;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const s of args.states) {
    if (args.filter.strategy && s.tag !== args.filter.strategy) continue;
    // Fired event: when this state row was first triggered AND the
    // first_triggered_at falls within our window.
    if (s.first_triggered_at && s.first_triggered_at >= args.sinceIso && s.first_triggered_at <= args.untilIso) {
      const severity = severityForAlertRule(s.rule_type);
      if (kindAllowed("alert.fired", args.filter.kinds) && severityAllowed(severity, args.filter.minSeverity)) {
        out.push({
          at: s.first_triggered_at,
          kind: "alert.fired",
          severity,
          summary: `ALERT FIRED ${s.tag}: ${s.rule_type}`,
          refs: { type: "alert", id: `${s.tag}/${s.rule_type}`, strategy: s.tag },
          details: { tag: s.tag, ruleType: s.rule_type, value: s.last_value_json },
        });
      }
    }
    // Resolved event: row currently active=0 BUT had a
    // first_triggered_at (i.e., previously fired) AND was
    // re-evaluated within our window. The reconciler clears
    // first_triggered_at to null when emitting resolve, so we
    // can detect this state: active=0 + first_triggered_at IS NULL
    // is the post-resolve state. Distinguish a "was-resolved-in-
    // window" event by: active=0 + last_evaluated_at in window
    // + we also see last_value_json that previously was set.
    //
    // In practice, the cleanest signal is: active=0 +
    // last_evaluated_at in window + last_value_json non-null
    // (only the resolve write persists the resolved value).
    // Note: this is a best-effort heuristic. The next iter could
    // persist an explicit alert_events table for exactness.
    if (
      s.active === 0 &&
      s.last_value_json != null &&
      s.last_evaluated_at >= args.sinceIso &&
      s.last_evaluated_at <= args.untilIso
    ) {
      if (kindAllowed("alert.resolved", args.filter.kinds) && severityAllowed("info", args.filter.minSeverity)) {
        out.push({
          at: s.last_evaluated_at,
          kind: "alert.resolved",
          severity: "info",
          summary: `ALERT RESOLVED ${s.tag}: ${s.rule_type}`,
          refs: { type: "alert", id: `${s.tag}/${s.rule_type}`, strategy: s.tag },
          details: { tag: s.tag, ruleType: s.rule_type },
        });
      }
    }
  }
  return out;
}

/** Severity mapping per iter32 rule type. Mirrors strategyAlerts.ts. */
function severityForAlertRule(rule: string): EventSeverity {
  switch (rule) {
    case "drawdown_threshold":
    case "failure_streak":
      return "critical";
    case "trigger_proximity":
      return "info";
    default:
      return "warn";
  }
}

/**
 * Iter39: collect engine state-transition events from the v26
 * engine_events table. Replaces the iter36 audit_log heuristic
 * for engine.* and worker.* events — exact data, not inference.
 *
 * Iter36's heuristic was: "look for audit_log rows with
 * tool='engine_lock'/'engine_unlock'". That worked for the
 * lock/unlock pair but missed entirely the worker.degraded /
 * worker.recovered transitions (they never went through audit_log)
 * and config.reload events. iter39's table captures all of these
 * with structured fields, so this function is a direct map from
 * row → TimelineEvent with no inference.
 */
export function collectEngineEvents(args: {
  rows: readonly EngineEventRow[];
  filter: Pick<CollectTimelineArgs, "kinds" | "minSeverity">;
  sinceIso: string;
  untilIso: string;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const r of args.rows) {
    if (r.timestamp < args.sinceIso || r.timestamp > args.untilIso) continue;
    // Map event_type to our EventKind union. The constructors only
    // ever insert known event_type values, but be defensive: skip
    // unknown event types instead of crashing the timeline.
    const kind = r.event_type as EventKind;
    const knownKinds = new Set<EventKind>([
      "engine.started",
      "engine.stopped",
      "engine.lock",
      "engine.unlock",
      "worker.degraded",
      "worker.recovered",
      "config.reloaded",
      "config.reload_failed",
    ]);
    if (!knownKinds.has(kind)) continue;
    if (!kindAllowed(kind, args.filter.kinds)) continue;
    const severity = (r.severity ?? "info") as EventSeverity;
    if (!severityAllowed(severity, args.filter.minSeverity)) continue;
    const fields = r.fields_json ? safeParseFields(r.fields_json) : {};
    out.push({
      at: r.timestamp,
      kind,
      severity,
      summary: summarizeEngineEvent(r, fields),
      refs: {
        type: "engine_event",
        id: r.id,
        workerName: r.worker_name,
        pid: r.pid,
      },
      details: flattenForDetails(fields),
    });
  }
  return out;
}

function safeParseFields(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Coerce arbitrary nested fields into the flat scalar shape
 *  TimelineEvent.details accepts. Non-scalars are stringified;
 *  undefined → null for type-clean JSON encoding. */
function flattenForDetails(fields: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) {
      out[k] = null;
    } else if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

function summarizeEngineEvent(row: EngineEventRow, fields: Record<string, unknown>): string {
  switch (row.event_type) {
    case "engine.started": {
      const workers = (fields.workers as string[] | undefined)?.join(",") ?? "?";
      return `ENGINE STARTED (pid ${row.pid}, workers ${workers})`;
    }
    case "engine.stopped": {
      const uptime = typeof fields.uptimeMs === "number" ? `${Math.floor(fields.uptimeMs / 1000)}s` : "?";
      const fatal = fields.fatal ? ` — fatal: ${String(fields.fatal).slice(0, 60)}` : "";
      const signal = fields.stopSignal ? ` (${fields.stopSignal})` : "";
      return `ENGINE STOPPED${signal}, uptime ${uptime}${fatal}`;
    }
    case "engine.lock": {
      const reason = fields.reason ? ` — ${String(fields.reason).slice(0, 60)}` : "";
      const by = fields.lockedBy ? ` by ${fields.lockedBy}` : "";
      return `ENGINE LOCKED${by}${reason}`;
    }
    case "engine.unlock": {
      const by = fields.unlockedBy ? ` by ${fields.unlockedBy}` : "";
      return `ENGINE UNLOCKED${by}`;
    }
    case "worker.degraded": {
      const fails = fields.consecutiveFailures ?? "?";
      const interval =
        typeof fields.effectiveIntervalMs === "number"
          ? `${(fields.effectiveIntervalMs / 1000).toFixed(0)}s`
          : "?";
      const err = fields.lastError ? ` (${String(fields.lastError).slice(0, 60)})` : "";
      return `WORKER ${row.worker_name ?? "?"} DEGRADED after ${fails} consecutive failures → effective ${interval}${err}`;
    }
    case "worker.recovered": {
      const after = fields.afterFailures ?? "?";
      return `WORKER ${row.worker_name ?? "?"} RECOVERED after ${after} failures`;
    }
    case "config.reloaded": {
      const total = fields.diffCount ?? 0;
      const crit = fields.criticalCount ?? 0;
      const warn = fields.warnCount ?? 0;
      const info = fields.infoCount ?? 0;
      return `CONFIG RELOADED — ${total} change(s): ${crit} critical, ${warn} warn, ${info} info`;
    }
    case "config.reload_failed": {
      const err = fields.error ? `: ${String(fields.error).slice(0, 80)}` : "";
      return `CONFIG RELOAD FAILED${err}`;
    }
    default:
      return `${row.event_type.toUpperCase()} (pid ${row.pid})`;
  }
}

// ── filter helpers ──────────────────────────────────────────

function kindAllowed(kind: EventKind, kinds: EventKind[] | undefined): boolean {
  if (!kinds || kinds.length === 0) return true;
  return kinds.includes(kind);
}

function severityAllowed(sev: EventSeverity, floor: EventSeverity | undefined): boolean {
  if (!floor) return true;
  const rank: Record<EventSeverity, number> = { info: 0, warn: 1, critical: 2 };
  return rank[sev] >= rank[floor];
}

// ── main entry ──────────────────────────────────────────────

/** End-to-end timeline construction. Each source is queried with
 *  the resolved window + filters; results are merged + sorted
 *  newest-first + limited. */
/** v35 signal events → timeline. Consumed events are info ("alert
 *  arrived, fired order #N"); PENDING and expired-unclaimed events
 *  are warn — an alert that arrived and fired NOTHING is exactly
 *  what an operator debugging a TradingView integration needs to
 *  see. Signals are global (no chain/account); strategy filter
 *  doesn't apply. */
export function collectSignalEvents(args: {
  rows: readonly SignalEventRow[];
  filter: Pick<CollectTimelineArgs, "kinds" | "minSeverity">;
  sinceIso: string;
  untilIso: string;
}): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const r of args.rows) {
    if (r.received_at < args.sinceIso || r.received_at > args.untilIso) continue;
    if (!kindAllowed("signal.received", args.filter.kinds)) continue;
    const consumedByOrder = r.consumed_by_order != null;
    const expiredUnclaimed = r.consumed_at != null && r.consumed_by_order == null;
    const severity: EventSeverity = consumedByOrder ? "info" : "warn";
    if (!severityAllowed(severity, args.filter.minSeverity)) continue;
    const state = consumedByOrder
      ? `fired order #${r.consumed_by_order}`
      : expiredUnclaimed
        ? "expired UNCLAIMED — nothing was armed"
        : "PENDING";
    out.push({
      at: r.received_at,
      kind: "signal.received",
      severity,
      summary: `SIGNAL "${r.name}" received [${r.source}] — ${state}`,
      refs: { type: "signal", id: r.id },
      details: {
        name: r.name,
        source: r.source,
        consumedAt: r.consumed_at,
        consumedByOrder: r.consumed_by_order,
        payload: r.payload_json,
      },
    });
  }
  return out;
}

export function collectTimeline(args: CollectTimelineArgs = {}): TimelineEvent[] {
  const { sinceIso, untilIso } = resolveWindow({ sinceIso: args.sinceIso, untilIso: args.untilIso });
  const filter = {
    chain: args.chain,
    account: args.account,
    strategy: args.strategy,
    kinds: args.kinds,
    minSeverity: args.minSeverity,
  };
  const limit = Math.max(1, Math.min(args.limit ?? 100, 5000));
  const includePaper = args.includePaper !== false;

  // Pull a generous slice from each source — we'll limit AFTER the
  // merge. The per-source limit is bounded by the global maximum
  // to keep query cost predictable; an operator chasing 1000s of
  // events should bump --limit explicitly.
  const sourceLimit = Math.max(limit * 2, 200);

  const trades = (args.injects?.tradesFn ?? recentTrades)({
    chain: args.chain,
    account: args.account,
    strategy: args.strategy,
    since: sinceIso,
    limit: sourceLimit,
  });
  const tradeEvents = collectTradeEvents({ trades, filter, sinceIso, untilIso });

  const paperEvents: TimelineEvent[] = [];
  if (includePaper) {
    const paperRows = (args.injects?.paperTradesFn ?? listPaperTrades)({
      chain: args.chain,
      account: args.account,
      strategy: args.strategy,
      sinceIso,
      untilIso,
      limit: sourceLimit,
    });
    paperEvents.push(...collectPaperEvents({ paperTrades: paperRows, filter, sinceIso, untilIso }));
  }

  const auditRows = (args.injects?.auditFn ?? recentAudit)(sourceLimit, {
    chain: args.chain,
    account: args.account,
    since: sinceIso,
  });
  const auditEvents = collectAuditEvents({ audit: auditRows, filter, sinceIso, untilIso });

  // v28: prefer the durable alert_events journal (exact transition
  // timestamps, full repeat history). Fall back to the legacy
  // state-row reconstruction ONLY when the journal has nothing in
  // the window — that's the pre-migration-history case.
  const alertJournalRows = (args.injects?.alertEventsFn ?? listAlertEvents)({
    sinceIso,
    untilIso,
    ...(args.strategy ? { tag: args.strategy } : {}),
  });
  let alertEvents: TimelineEvent[];
  if (alertJournalRows.length > 0) {
    alertEvents = collectAlertEvents({ events: alertJournalRows, filter, sinceIso, untilIso });
  } else {
    const alertRows = (args.injects?.alertsFn ?? listStrategyAlertStates)({
      tag: args.strategy,
    });
    alertEvents = collectAlertEventsLegacy({ states: alertRows, filter, sinceIso, untilIso });
  }

  // Journal source: no public helper for "last N order_check_log
  // rows in a window". The injection hook covers tests; the
  // default runs a direct SQL query against the db handle.
  const journalRows = (args.injects?.journalFn ?? defaultJournalQuery)(sinceIso, untilIso, sourceLimit);
  const journalEvents = collectJournalEvents({ rows: journalRows, filter, sinceIso, untilIso });

  // v29: schedule + rebalance decision journals — same direct-SQL +
  // inject-seam pattern as the order journal.
  const scheduleJournalRows = (args.injects?.scheduleJournalFn ?? defaultScheduleJournalQuery)(sinceIso, untilIso, sourceLimit);
  const scheduleJournalEvents = collectScheduleJournalEvents({ rows: scheduleJournalRows, filter, sinceIso, untilIso });
  const rebalanceJournalRows = (args.injects?.rebalanceJournalFn ?? defaultRebalanceJournalQuery)(sinceIso, untilIso, sourceLimit);
  const rebalanceJournalEvents = collectRebalanceJournalEvents({ rows: rebalanceJournalRows, filter, sinceIso, untilIso });

  // Iter39: engine_events source — exact persisted state
  // transitions. Pre-iter39 the timeline derived these via
  // audit_log heuristics (which missed worker.degraded /
  // worker.recovered / config.reload* entirely). Engine events
  // are global (not per chain/account/strategy), so we ignore
  // those filter dimensions here — only window + kinds + severity.
  const engineRows = (args.injects?.engineEventsFn ?? listEngineEvents)({
    sinceIso,
    untilIso,
    limit: sourceLimit,
  });
  const engineEvents = collectEngineEvents({ rows: engineRows, filter, sinceIso, untilIso });

  // v35: signal inbox — global like engine events.
  const signalRows = (args.injects?.signalEventsFn ?? listSignalEvents)({ limit: sourceLimit });
  const signalEvents = collectSignalEvents({ rows: signalRows, filter, sinceIso, untilIso });

  // Merge.
  const all = [...tradeEvents, ...paperEvents, ...auditEvents, ...alertEvents, ...journalEvents, ...scheduleJournalEvents, ...rebalanceJournalEvents, ...engineEvents, ...signalEvents];

  // Stable sort: newest first by `at`, then by `kind` for
  // determinism when multiple events share a millisecond.
  all.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    const aId = typeof a.refs.id === "number" ? a.refs.id : 0;
    const bId = typeof b.refs.id === "number" ? b.refs.id : 0;
    return bId - aId;
  });

  return all.slice(0, limit);
}

function defaultScheduleJournalQuery(sinceIso: string, untilIso: string, limit: number): ScheduleCheckLogRow[] {
  try {
    const db = openDb();
    return db
      .prepare(
        `SELECT * FROM schedule_check_log
           WHERE checked_at >= ? AND checked_at <= ?
           ORDER BY checked_at DESC LIMIT ?`,
      )
      .all(sinceIso, untilIso, limit) as unknown as ScheduleCheckLogRow[];
  } catch {
    return [];
  }
}

function defaultRebalanceJournalQuery(sinceIso: string, untilIso: string, limit: number): RebalanceCheckLogRow[] {
  try {
    const db = openDb();
    return db
      .prepare(
        `SELECT * FROM rebalance_check_log
           WHERE checked_at >= ? AND checked_at <= ?
           ORDER BY checked_at DESC LIMIT ?`,
      )
      .all(sinceIso, untilIso, limit) as unknown as RebalanceCheckLogRow[];
  } catch {
    return [];
  }
}

/** Direct SQL query for order_check_log rows in a window. Kept
 *  private + bypassable via the injects.journalFn seam. */
function defaultJournalQuery(sinceIso: string, untilIso: string, limit: number): OrderCheckLogRow[] {
  try {
    const db = openDb();
    return db
      .prepare(
        `SELECT * FROM order_check_log
           WHERE checked_at >= ? AND checked_at <= ?
           ORDER BY checked_at DESC LIMIT ?`,
      )
      .all(sinceIso, untilIso, limit) as unknown as OrderCheckLogRow[];
  } catch {
    return [];
  }
}

// ── duration parsing for CLI ────────────────────────────────

/**
 * Parse a since-shorthand into an ISO timestamp. Accepts:
 *
 *   "4h" / "30m" / "2d" / "7d" / "1w" / numeric seconds with "s"
 *   Or an ISO-8601 timestamp (passed through).
 *
 * Returns null for unrecognized formats. Exported for the CLI to
 * reuse + for tests. The CLI catches null and surfaces
 * INVALID_PARAMS.
 */
export function parseSinceDuration(raw: string, now: Date = new Date()): string | null {
  const trimmed = raw.trim();
  // ISO passthrough.
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate) && trimmed.includes("T")) {
    return new Date(parsedDate).toISOString();
  }
  // Duration shorthand.
  const m = /^(\d+)\s*(s|m|h|d|w)$/i.exec(trimmed);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2].toLowerCase();
  const seconds =
    unit === "s" ? n :
    unit === "m" ? n * 60 :
    unit === "h" ? n * 3600 :
    unit === "d" ? n * 86400 :
    /* "w" */ n * 604800;
  return new Date(now.getTime() - seconds * 1000).toISOString();
}
