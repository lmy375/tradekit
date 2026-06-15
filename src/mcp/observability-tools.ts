// MCP observability tools: status (right-now dashboard), digest
// (windowed activity report), order_replay (forensic decision
// timeline), backtest_list / backtest_show (historical backtest
// retrieval).
//
// These compose the iter23 / iter24 / iter25 read-only surfaces into
// an agent-callable interface. Zero RPC, sub-100ms responses.

import { z } from "zod";
import { ALL_EVENT_KINDS, type EventKind } from "../timeline.js";
import { toToolError, ToolError } from "../errors.js";
import { ok, fail, runTool, type RegisterFn } from "./runtime.js";
import {
  gatherStatusReport,
  ALL_SECTIONS,
  type SectionName,
} from "../status.js";
import {
  gatherDigest,
  parseWindowMs,
} from "../digest.js";
import {
  replayOrder,
} from "../orderJournal.js";
import {
  getOrderById,
  listBacktestRuns,
  getBacktestRunById,
  listBacktestComparisons,
  getBacktestComparisonById,
} from "../db.js";

// ── tool registration ────────────────────────────────────────

export const registerObservabilityTools: RegisterFn = (server, rt) => {
  // ── status_dashboard ───────────────────────────────────────
  server.tool(
    "status_dashboard",
    "Operational status across engine workers + active orders / schedules / rebalance plans + playbooks + drawdown breaker + strategy budgets + 24h audit + currently-firing strategy alerts (with the last 24h transitions) + the paper-trading snapshot (book size, live paper primitives, 24h fills). Composes ~10 read-side queries into one situational-awareness view. Different from the `status` admin tool (which is process-status only) — this is the iter23 multi-section dashboard. Optional section filter: pass `sections` to limit (e.g. [\"orders\",\"drawdown\"]). Sub-100ms, zero RPC.",
    {
      sections: z
        .array(z.enum(["engine", "orders", "schedules", "rebalance", "playbooks", "drawdown", "budgets", "activity", "alerts", "paper"]))
        .optional()
        .describe("Section filter; default = all 10 sections."),
    },
    async ({ sections }) => {
      try {
        return ok(
          await runTool("status_dashboard", rt.opts, { sections }, undefined, async () => {
            const report = gatherStatusReport({
              sections: sections as SectionName[] | undefined,
            });
            return { ok: true, report, sections: sections ?? ALL_SECTIONS };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── digest_summary ─────────────────────────────────────────
  server.tool(
    "digest_summary",
    "Windowed activity digest: trades + strategy fires (journal-exact schedule/rebalance counts when the v29 decision journals are enabled, incl. failure counts the legacy last_run approximation misses) + alert transitions (v28 — fired/resolved in window + currently-active snapshot) + paper-trading activity + safety events + top errors over the last N hours/days. Computes a 3-tier health verdict (healthy/attention/critical) with cumulative reasons. v103: a STANDING `engine` liveness section (everRan, stale, lastTickAgoSec, livePrimitives, protectiveOrders) — when the engine daemon is DOWN while standing primitives depend on it, the verdict escalates: protective stops inert → CRITICAL (positions ride UNPROTECTED), other live primitives inert → attention (orders/schedules/DCAs not firing). Closes the blind spot where the digest read healthy while the engine — and every trailing stop it fires — was dead. v123: the `engine` section also carries `protectiveFailuresInWindow` + `recentProtectiveFailures[]` (id/symbol/errorCode/at) — protective stops (trailing / price_below) that TERMINALLY FAILED to fire in the window (the sell reverted, hit a slippage cap, ran out of balance, tripped a safeguard). This is a CONCRETE exposure distinct from the inert-stop case: the engine is ALIVE but tried to fire the stop and couldn't, so that position lost protection RIGHT NOW. Escalates to CRITICAL (the engine being up doesn't re-arm a dead stop) and names the orders so the response is 'open_positions → re-arm a stop on X'. v100: the safety section counts EVERY guardrail block (a single-source registry — per-tx/daily cap, loss breaker, position/exposure caps, execution-quality caps, budget, gas, honeypot, contract allow/deny), not just a subset; a tripped per-tx cap or strategy loss-breaker (real-money safety events previously invisible here) now surface and feed the verdict. v95 `promote` is a STANDING (not window-scoped) section: for every DEPLOYED playbook it reuses the promote-outcome verdict to flag strategies whose LIVE run diverged from the paper baseline that justified deploying real capital — `diverged` (losing money vs the paper promise → critical) or `underperforming` (edge shrank / execution worse → attention). This is distinct from raw per-strategy P&L: a strategy can post POSITIVE P&L yet still fall far short of its paper promise. Optional `compare` adds prior-window deltas (trades, USD volume, fills, errors); promote stays null in the comparison (it's a current-state signal). Window range [1min, 90d]. Pairs with status_dashboard (right-now vs windowed). Errors: INVALID_PARAMS (bad window format).",
    {
      window: z.string().default("24h").describe("Window — '1h', '24h', '7d', '30d' (m/h/d units; min 1 minute, max 90 days)."),
      compare: z.boolean().optional().describe("Include immediately-prior window of same length with delta math; default false."),
    },
    async ({ window, compare }) => {
      try {
        return ok(
          await runTool("digest_summary", rt.opts, { window, compare }, undefined, async () => {
            const windowMs = parseWindowMs(window);
            const report = await gatherDigest({
              windowLabel: window,
              windowMs,
              compare: compare ?? false,
            });
            return { ok: true, report };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── order_replay ───────────────────────────────────────────
  server.tool(
    "order_replay",
    "Forensic decision timeline for an order — every state-changing engine tick (activation, HWM advances, proximity crossings, fires, errors). Requires `engine.orderJournal.enabled=true` (default off). Answers \"why did this trail fire HERE and not earlier?\" from the persistent journal. Errors: INVALID_PARAMS (id not found).",
    {
      id: z.number().int().positive().describe("Order id."),
      limit: z.number().int().min(1).max(10_000).optional().describe("Max entries; default unlimited."),
    },
    async ({ id, limit }) => {
      try {
        return ok(
          await runTool("order_replay", rt.opts, { id, limit }, undefined, async () => {
            const order = getOrderById(id);
            if (!order) throw new ToolError("INVALID_PARAMS", `Order #${id} not found.`);
            const { loadConfig } = await import("../config.js");
            const config = loadConfig();
            const timeline = replayOrder(id, limit);
            return {
              ok: true,
              orderId: id,
              order: {
                id: order.id, status: order.status, side: order.side,
                trigger: order.trigger_type, targetPriceUsd: order.target_price_usd,
                trailPct: order.trail_pct, waterMarkUsd: order.water_mark_usd,
                chain: order.chain, account: order.account,
                base: order.base_symbol, quote: order.quote_symbol,
                baseAmount: order.base_amount, quoteAmount: order.quote_amount,
                createdAt: order.created_at, filledAt: order.filled_at,
              },
              journalEnabled: config.engine.orderJournal.enabled,
              totalEntries: timeline.totalEntries,
              entries: timeline.entries,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── schedule_replay + rebalance_replay (v29) ──────────────
  // Forensic parity for the other two engines.
  server.tool(
    "schedule_replay",
    "Forensic decision timeline for a schedule — every fired / fire_failed / retired (end_at, max_runs) / locked-skip / on_fill hook outcome with exact timestamps, run numbers, and tx hashes. Requires `engine.scheduleJournal.enabled=true` (default off; the response carries journalEnabled so an agent can tell 'no entries' from 'journal off'). Answers \"why didn't my DCA fire this morning?\" from the persistent journal. Errors: INVALID_PARAMS (id not found).",
    {
      id: z.number().int().positive().describe("Schedule id."),
      limit: z.number().int().min(1).max(10_000).optional().describe("Max entries, newest-first; default 200."),
    },
    async ({ id, limit }) => {
      try {
        return ok(
          await runTool("schedule_replay", rt.opts, { id, limit }, undefined, async () => {
            const { getScheduleById, replayScheduleEntries } = await import("../db.js");
            const schedule = getScheduleById(id);
            if (!schedule) throw new ToolError("INVALID_PARAMS", `Schedule #${id} not found.`);
            const { loadConfig } = await import("../config.js");
            const config = loadConfig();
            const entries = replayScheduleEntries(id, limit ?? 200);
            return {
              ok: true,
              scheduleId: id,
              schedule: {
                id: schedule.id, status: schedule.status, side: schedule.side,
                cron: schedule.cron_expr, runCount: schedule.run_count, maxRuns: schedule.max_runs,
                chain: schedule.chain, account: schedule.account,
                base: schedule.base_symbol, quote: schedule.quote_symbol,
                nextRunAt: schedule.next_run_at, paper: (schedule.paper ?? 0) === 1,
              },
              journalEnabled: config.engine.scheduleJournal?.enabled === true,
              count: entries.length,
              entries,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "rebalance_replay",
    "Forensic decision timeline for a rebalance plan — every evaluated occurrence including IN-BAND ones with max_drift_pct, so the DRIFT HISTORY is visible (watch drift creep toward the threshold instead of being surprised by the fire), plus fired / partial_failure / failed / dry_run / locked-skip outcomes with executed/skipped leg counts. Requires `engine.rebalanceJournal.enabled=true` (default off; journalEnabled in the response disambiguates). Errors: INVALID_PARAMS (id not found).",
    {
      id: z.number().int().positive().describe("Rebalance plan id."),
      limit: z.number().int().min(1).max(10_000).optional().describe("Max entries, newest-first; default 200."),
    },
    async ({ id, limit }) => {
      try {
        return ok(
          await runTool("rebalance_replay", rt.opts, { id, limit }, undefined, async () => {
            const { replayRebalanceEntries } = await import("../db.js");
            const { getRebalancePlanById } = await import("../rebalance.js");
            const plan = getRebalancePlanById(id);
            if (!plan) throw new ToolError("INVALID_PARAMS", `Rebalance plan #${id} not found.`);
            const { loadConfig } = await import("../config.js");
            const config = loadConfig();
            const entries = replayRebalanceEntries(id, limit ?? 200);
            return {
              ok: true,
              planId: id,
              plan: {
                id: plan.id, status: plan.status, name: plan.name,
                driftThresholdPct: plan.drift_threshold_pct, runCount: plan.run_count,
                chain: plan.chain, account: plan.account,
                nextRunAt: plan.next_run_at, paper: (plan.paper ?? 0) === 1,
              },
              journalEnabled: config.engine.rebalanceJournal?.enabled === true,
              count: entries.length,
              entries,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── backtest_list ──────────────────────────────────────────
  server.tool(
    "backtest_list",
    "Recent backtest runs (newest first). Each row has spec, balance, fire timeline, PnL, vs-hold counterfactual. Use to find prior runs to re-render via `backtest_show` without re-fetching CoinGecko data.",
    {
      strategy_type: z.enum(["order", "schedule", "playbook"]).optional().describe("Filter by strategy type."),
      chain: z.string().optional().describe("Filter by chain."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max rows; default 50."),
    },
    async ({ strategy_type, chain, limit }) => {
      try {
        return ok(
          await runTool("backtest_list", rt.opts, { strategy_type, chain, limit }, chain, async () => {
            const rows = listBacktestRuns({
              strategyType: strategy_type,
              chain,
              limit: limit ?? 50,
            });
            return { ok: true, runs: rows };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── backtest_show ──────────────────────────────────────────
  server.tool(
    "backtest_show",
    "Full detail for a backtest run by id. Returns the persisted spec, balances, fire timeline, PnL, and vs-hold counterfactual without re-running the simulation. Errors: INVALID_PARAMS (id not found).",
    {
      id: z.number().int().positive().describe("Backtest run id from backtest_list."),
    },
    async ({ id }) => {
      try {
        return ok(
          await runTool("backtest_show", rt.opts, { id }, undefined, async () => {
            const row = getBacktestRunById(id);
            if (!row) throw new ToolError("INVALID_PARAMS", `No backtest run with id ${id}.`);
            return {
              ok: true,
              run: {
                ...row,
                spec: JSON.parse(row.spec_json),
                initial_balance: JSON.parse(row.initial_balance_json),
                final_balance: JSON.parse(row.final_balance_json),
                fires: JSON.parse(row.fires_json),
              },
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── backtest_compare_list ──────────────────────────────────
  server.tool(
    "backtest_compare_list",
    "Recent backtest comparison runs (multi-scenario parameter sweeps). Each row groups N backtest_runs by a comparison name with a winner index.",
    {
      chain: z.string().optional().describe("Filter by chain."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max rows; default 50."),
    },
    async ({ chain, limit }) => {
      try {
        return ok(
          await runTool("backtest_compare_list", rt.opts, { chain, limit }, chain, async () => {
            const rows = listBacktestComparisons({
              chain,
              limit: limit ?? 50,
            });
            return { ok: true, comparisons: rows };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── backtest_compare_show ──────────────────────────────────
  server.tool(
    "backtest_compare_show",
    "Full detail for a backtest comparison by id — per-scenario results + winner index + linked run ids for individual scenario inspection via backtest_show. Errors: INVALID_PARAMS (id not found).",
    {
      id: z.number().int().positive().describe("Comparison id."),
    },
    async ({ id }) => {
      try {
        return ok(
          await runTool("backtest_compare_show", rt.opts, { id }, undefined, async () => {
            const row = getBacktestComparisonById(id);
            if (!row) throw new ToolError("INVALID_PARAMS", `No comparison with id ${id}.`);
            return {
              ok: true,
              comparison: {
                ...row,
                scenarios_spec: JSON.parse(row.scenarios_json),
                results: JSON.parse(row.results_json),
              },
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── timeline_query (iter36) ─────────────────────────────────
  //
  // Unified chronological event view across trades / paper /
  // audit / order journal / strategy alerts. Pre-iter36 an agent
  // investigating an incident had to make 6+ separate MCP calls
  // (recent_trades, audit, order_replay-per-order, etc.) + merge
  // by timestamp client-side. This tool collapses that into one
  // call returning the same typed TimelineEvent[] the CLI uses.
  server.tool(
    "timeline_query",
    "Forensic timeline: merged chronological events from trades, paper_trades, audit_log, order_check_log, strategy_alert_state. Newest-first. Use for incident investigation ('what happened between 13:55 and 14:05?'). Filters: chain/account/strategy narrow the cross-source scope; kinds[] restricts to specific event types; minSeverity floors to warn or critical; --no-paper (i.e. includePaper=false) hides paper.fill events. Default window: last 4h. Default limit: 100. ZERO RPC, sub-100ms. Errors: INVALID_PARAMS (bad kind name, bad ISO timestamp).",
    {
      since: z
        .string()
        .optional()
        .describe("Lower bound for the window. Accepts a duration shorthand (4h, 30m, 2d, 1w) or ISO-8601 timestamp. Default: 4 hours before now."),
      until: z
        .string()
        .optional()
        .describe("Upper bound — ISO-8601 timestamp. Default: now."),
      chain: z.string().optional().describe("Restrict to one chain."),
      account: z.string().optional().describe("Restrict to one account label."),
      strategy: z.string().optional().describe("Restrict to one strategy tag."),
      kinds: z
        .array(z.enum(ALL_EVENT_KINDS as [EventKind, ...EventKind[]]))
        .optional()
        .describe(`Subset of event kinds. Omit for all kinds. Valid: ${ALL_EVENT_KINDS.join(", ")}.`),
      minSeverity: z
        .enum(["info", "warn", "critical"])
        .optional()
        .describe("Severity floor; events below are dropped."),
      includePaper: z
        .boolean()
        .default(true)
        .describe("Include paper.fill events. Pass false for a 'real trades only' forensic view."),
      limit: z.number().int().min(1).max(5000).default(100).describe("Cap on returned events. Applied after global merge + sort."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("timeline_query", rt.opts, input, input.chain, async () => {
            const { collectTimeline, parseSinceDuration } = await import("../timeline.js");
            let sinceIso: string | undefined;
            if (input.since) {
              const parsed = parseSinceDuration(input.since);
              if (!parsed) {
                throw new ToolError(
                  "INVALID_PARAMS",
                  `'since' must be a duration (4h, 30m, 2d) or ISO-8601 timestamp; got "${input.since}".`,
                );
              }
              sinceIso = parsed;
            }
            let untilIso: string | undefined;
            if (input.until) {
              const t = Date.parse(input.until);
              if (!Number.isFinite(t)) {
                throw new ToolError("INVALID_PARAMS", `'until' must be a valid ISO-8601 timestamp; got "${input.until}".`);
              }
              untilIso = new Date(t).toISOString();
            }
            const events = collectTimeline({
              sinceIso,
              untilIso,
              chain: input.chain,
              account: input.account,
              strategy: input.strategy,
              kinds: input.kinds,
              minSeverity: input.minSeverity,
              includePaper: input.includePaper,
              limit: input.limit,
            });
            return {
              count: events.length,
              since: sinceIso ?? null,
              until: untilIso ?? null,
              events,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── engine_events (iter39) ──────────────────────────────────
  //
  // Read-only forensic view of the v26 engine_events table.
  // Durable engine lifecycle (started/stopped) + worker
  // resilience (degraded/recovered) + config reload events.
  // Survives process restart (vs notifications). Agents
  // investigating "what happened to my engine yesterday?" call
  // this once instead of grepping rotated Slack logs.
  server.tool(
    "engine_events",
    "Forensic engine state transitions: engine.started/stopped, engine.lock/unlock, worker.degraded/recovered, config.reloaded/config.reload_failed. Durable across process restarts (writes to v26 engine_events table alongside the iter28+ notification path). Filter by event_type[], minSeverity, worker_name, pid, time window. Use for incident investigation across runs. Errors: INVALID_PARAMS (bad event_type, bad ISO timestamp).",
    {
      since: z
        .string()
        .optional()
        .describe("Lower bound — duration shorthand (4h, 1d, 7d) or ISO timestamp. Default: 24h ago."),
      until: z.string().optional().describe("Upper bound — ISO timestamp. Default: now."),
      types: z
        .array(
          z.enum([
            "engine.started", "engine.stopped",
            "engine.lock", "engine.unlock",
            "worker.degraded", "worker.recovered",
            "config.reloaded", "config.reload_failed",
          ]),
        )
        .optional()
        .describe("Subset of event types."),
      minSeverity: z.enum(["info", "warn", "critical"]).optional(),
      workerName: z.string().optional().describe("Restrict to worker.* events for one worker."),
      pid: z.number().int().optional().describe("Restrict to events from a specific process."),
      limit: z.number().int().min(1).max(10_000).default(200),
    },
    async (input) => {
      try {
        return ok(
          await runTool("engine_events", rt.opts, input, undefined, async () => {
            const { listEngineEvents } = await import("../db.js");
            const { parseSinceDuration } = await import("../timeline.js");
            let sinceIso: string | undefined;
            if (input.since) {
              const parsed = parseSinceDuration(input.since);
              if (!parsed) {
                throw new ToolError(
                  "INVALID_PARAMS",
                  `'since' must be a duration (4h, 30m, 2d) or ISO timestamp; got "${input.since}".`,
                );
              }
              sinceIso = parsed;
            } else {
              sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
            }
            let untilIso: string | undefined;
            if (input.until) {
              const t = Date.parse(input.until);
              if (!Number.isFinite(t)) {
                throw new ToolError("INVALID_PARAMS", `'until' must be valid ISO-8601; got "${input.until}".`);
              }
              untilIso = new Date(t).toISOString();
            }
            let rows = listEngineEvents({
              sinceIso,
              untilIso,
              minSeverity: input.minSeverity,
              workerName: input.workerName,
              pid: input.pid,
              limit: Math.max(input.limit, input.types ? input.limit * 4 : input.limit),
            });
            if (input.types && input.types.length > 0) {
              const set = new Set(input.types);
              rows = rows.filter((r) => set.has(r.event_type as never));
            }
            return {
              count: rows.length,
              since: sinceIso,
              until: untilIso ?? null,
              events: rows,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── alert_history (v28) ─────────────────────────────────────
  server.tool(
    "alert_history",
    "Durable journal of strategy-alert transitions (v28 alert_events table): one row per fired/resolved transition, written at the moment the watcher emitted the notification — exact timestamps, the violated value, and (for resolves) the alerting duration in seconds. Unlike the strategy_report alerts section (CURRENT state only) this is the full history: an alert that fired+resolved 5 times shows all 10 transitions. Returns { ok, count, events: [{ id, at, tag, rule_type, event, severity, message, value_json, duration_seconds }], elapsedMs }, newest-first. Filters (all optional): `tag` (strategy tag), `rule` (rule type, e.g. failure_streak), `event` (fired|resolved), `since` (duration shorthand like 7d or ISO), `until` (ISO), `limit` (default 100). Transitions recorded before the v28 migration aren't in the journal — use timeline_query (which falls back to state-row reconstruction) for those. Read-only.",
    {
      tag: z.string().optional().describe("Strategy tag filter (e.g. playbook:3, dca-eth)."),
      rule: z.string().optional().describe("Rule type filter: staleness | slippage_trend | success_rate_drop | failure_streak | budget_approach | drawdown_threshold | trigger_proximity."),
      event: z.enum(["fired", "resolved"]).optional(),
      since: z.string().optional().describe("Lower bound — duration shorthand (4h, 7d) or ISO timestamp. Default: unbounded."),
      until: z.string().optional().describe("Upper bound — ISO timestamp. Default: unbounded."),
      limit: z.number().int().min(1).max(10_000).default(100),
    },
    async (input) => {
      try {
        return ok(
          await runTool("alert_history", rt.opts, input, undefined, async () => {
            const t0 = Date.now();
            const { listAlertEvents } = await import("../db.js");
            const { parseSinceDuration } = await import("../timeline.js");
            let sinceIso: string | undefined;
            if (input.since) {
              const parsed = parseSinceDuration(input.since);
              if (!parsed) {
                throw new ToolError(
                  "INVALID_PARAMS",
                  `'since' must be a duration (4h, 30m, 2d) or ISO timestamp; got "${input.since}".`,
                );
              }
              sinceIso = parsed;
            }
            let untilIso: string | undefined;
            if (input.until) {
              const t = Date.parse(input.until);
              if (!Number.isFinite(t)) {
                throw new ToolError("INVALID_PARAMS", `'until' must be valid ISO-8601; got "${input.until}".`);
              }
              untilIso = new Date(t).toISOString();
            }
            const rows = listAlertEvents({
              sinceIso,
              untilIso,
              tag: input.tag,
              ruleType: input.rule,
              event: input.event,
              limit: input.limit,
            });
            return { count: rows.length, events: rows, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── price_stats (iter38) ────────────────────────────────────
  server.tool(
    "price_stats",
    "Per-provider price-fetch observability. Returns calls/successes/failures/last-error/timing-percentiles for each price provider (CoinGecko, DexScreener) touched since process start. In-memory only — resets on engine restart. Use for debugging 'why am I getting rate-limited?' or for periodic scrapes to a dashboard. Optional `reset: true` clears the in-memory counters.",
    {
      reset: z.boolean().default(false).describe("When true, clear all provider stats after returning the current snapshot. Useful for monitoring scripts that want delta-since-last-scrape semantics."),
    },
    async ({ reset }) => {
      try {
        return ok(
          await runTool("price_stats", rt.opts, { reset }, undefined, async () => {
            const { getProviderStats, resetProviderStats } = await import("../priceStats.js");
            const snapshot = getProviderStats();
            if (reset) resetProviderStats();
            return { providers: snapshot };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── v44: execution quality ────────────────────────────────
  server.tool(
    "execution_report",
    "v44: execution quality analytics over REAL fills — signed realized slippage (positive = unfavorable vs quote) cut by aggregator, pair, and order-size bucket, gas in native units per chain, a trailing-7d-vs-prior trend, and threshold-gated recommendations (aggregator preference / order splitting / degradation / low slippage coverage). Paper fills excluded (simulated slippage isn't execution quality); transfers/incoming excluded (not swaps). Deterministic + offline — one DB scan, no oracle. Use it to decide aggregator.mode (first vs best), per-fire sizing, and whether execution is degrading.",
    {
      since: z.string().optional().describe("Window — duration (30d, 12h) or ISO timestamp. Default 30d."),
      chain: z.string().optional().describe("Scope to one chain."),
      account: z.string().optional().describe("Scope to one account label."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("execution_report", rt.opts, input, input.chain, async () => {
            const { parseSinceDuration } = await import("../timeline.js");
            const { gatherExecutionReport } = await import("../executionReport.js");
            const windowLabel = input.since ?? "30d";
            const sinceIso = parseSinceDuration(windowLabel);
            if (!sinceIso) {
              throw new ToolError("INVALID_PARAMS", `"since" must be a duration (30d) or ISO timestamp.`);
            }
            return gatherExecutionReport({
              windowLabel,
              sinceIso,
              chain: input.chain,
              account: input.account,
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── operator notes ────────────────────────────────────────
  server.tool(
    "note_add",
    "v37: record an annotation into the forensic timeline (kind note.operator) — the HUMAN/AGENT layer of the otherwise machine-only stream. Use it to leave reasoning for the next session or the operator: why you adjusted a stop, why you paused a strategy, what you observed before acting. Notes tagged with a strategy appear under that strategy's timeline filter; untagged notes are global context. Max 2000 chars. Returns { id, at }.",
    {
      text: z.string().min(1).max(2000).describe("What was done and WHY — the next reader's context."),
      strategy: z.string().optional().describe("Optional strategy tag this note concerns."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("note_add", rt.opts, input, undefined, async () => {
            const { insertOperatorNote } = await import("../db.js");
            const at = new Date().toISOString();
            const id = insertOperatorNote({ at, text: input.text, strategy: input.strategy ?? null, source: "mcp" });
            return { id, at };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "note_list",
    "v37: list operator/agent notes (newest first). The human layer of the forensic timeline — read these FIRST when investigating: they explain the why behind the machine events.",
    {
      strategy: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async (input) => {
      try {
        return ok(
          await runTool("note_list", rt.opts, input, undefined, async () => {
            const { listOperatorNotes } = await import("../db.js");
            return { notes: listOperatorNotes({ strategy: input.strategy, limit: input.limit }) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── realized gains ────────────────────────────────────────
  server.tool(
    "gains_report",
    "v36: realized-gains report — every cost-basis realization (per-sell: date, amount, proceeds, cost basis, gain, avg cost, tx hash) from the SAME weighted-average engine all P&L surfaces share. Deterministic (pure fill-journal walk, no oracle). The cost-basis walk always sees FULL history; since/until filter the OUTPUT records only — a 2025 buy correctly funds a 2026 sell's basis. Method caveats baked into the contract: weighted-average (not FIFO/specific-lot), stablecoin-quote fills only (skipped count reported), gas excluded, untracked sells (no basis) reported separately and never folded into gains. Not tax advice. CSV export lives on the CLI (`tradekit export gains --year N --out file.csv`). v60: each record carries `acquiredAt` (weighted-average acquisition date), `holdingDays`, and `term` ('short' ≤365d / 'long' >365d / 'untracked'); the report adds `byTerm` (short/long/untracked gain+proceeds+cost subtotals — the headline tax split) and `byToken` (per-(chain,token) rollup, gain-descending). Holding period is a weighted-average ESTIMATE, not lot-based FIFO — disclosed, since this model carries one blended basis per position. Returns { mode, sinceIso, untilIso, records[], totalGainQuote, totalProceedsQuote, totalCostBasisQuote, totalUntrackedProceedsQuote, skippedNonStableQuote, byTerm, byToken }.",
    {
      mode: z.enum(["real", "paper"]).optional().describe("Default real (success trades). paper walks the virtual fills."),
      year: z.number().int().min(2000).max(2100).optional().describe("UTC calendar-year window shorthand. Mutually exclusive with since/until."),
      since: z.string().optional().describe("ISO lower bound on realization timestamps."),
      until: z.string().optional().describe("ISO upper bound."),
      account: z.string().optional(),
      chain: z.string().optional(),
      strategy: z.string().optional(),
    },
    async (input) => {
      try {
        return ok(
          await runTool("gains_report", rt.opts, input, input.chain, async () => {
            const { gatherRealizedGains, yearWindow } = await import("../gains.js");
            let sinceIso = input.since;
            let untilIso = input.until;
            if (input.year != null) {
              if (input.since || input.until) {
                throw new ToolError("INVALID_PARAMS", "Use year OR since/until, not both.");
              }
              const w = yearWindow(input.year);
              sinceIso = w.sinceIso;
              untilIso = w.untilIso;
            }
            return await gatherRealizedGains({
              mode: input.mode ?? "real",
              account: input.account,
              chain: input.chain,
              strategy: input.strategy,
              sinceIso,
              untilIso,
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── equity curve ──────────────────────────────────────────
  server.tool(
    "equity_curve",
    "Equity curve: total portfolio USD value over time, built from portfolio_snapshots — a PURE DB read (no RPC, no oracle). The data feed is the v37 engine snapshot worker (engine.workers.snapshot, default off — enable it or run `tradekit snapshot` manually/cron). Scope discipline: a curve only makes sense within ONE scan scope (accountsKey × chainsKey); when unpinned, the most-snapshotted scope is selected (scopeSource: 'defaulted') and availableScopes lists the rest. Returns { accountsKey, chainsKey, scopeSource, points: [{at, totalUsd}], firstUsd, lastUsd, changeAbs, changePct, peakUsd, peakAt, maxDrawdownPct, availableScopes }. Errors: INVALID_PARAMS (bad maxPoints).",
    {
      accountsKey: z.string().optional().describe("Pin the accounts scope (sorted comma-joined labels, e.g. 'default')."),
      chainsKey: z.string().optional().describe("Pin the chains scope (sorted comma-joined, e.g. 'base,ethereum')."),
      since: z.string().optional().describe("Lower bound — ISO timestamp or duration shorthand (30d, 12h)."),
      maxPoints: z.number().int().min(2).max(2000).optional().describe("Downsample ceiling (default 200; endpoints always kept)."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("equity_curve", rt.opts, input, undefined, async () => {
            const { buildEquityCurve } = await import("../equity.js");
            let sinceIso: string | undefined;
            if (input.since) {
              const { parseSinceDuration } = await import("../timeline.js");
              const parsed = parseSinceDuration(input.since);
              if (!parsed) throw new ToolError("INVALID_PARAMS", `"since" must be a duration (30d) or ISO timestamp.`);
              sinceIso = parsed;
            }
            return buildEquityCurve({
              accountsKey: input.accountsKey,
              chainsKey: input.chainsKey,
              sinceIso,
              maxPoints: input.maxPoints,
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── runway ─────────────────────────────────────────────────
  server.tool(
    "runway",
    "Funding-runway forecast: will live automation run out of money, and when? Walks every ACTIVE schedule's upcoming cron occurrences (respecting end_at + remaining max_runs budget) and reserves every ACTIVE order's one-shot spend, then replays them chronologically against CURRENT balances — paper book for paper primitives, on-chain balanceOf for real ones (read-only, no keystore). Spend accounting is price-free and exact: buys burn the quote token, sells burn the base token; primitives sized in the opposite denomination are listed in `skipped` (their spend needs a price). Rebalance plans are out of scope (drift-dependent trades have no fixed burn rate). Returns { generatedAt, horizonDays, buckets: [{account, chain, paper, token, symbol, balance, oneShotReserved, burn30d, totalFiresInHorizon, firesCovered, exhaustsAt, runwayDays, obligations}], gas: [{account, chain, balance, avgGasPerFire, gasSamples, totalFiresInHorizon, oneShotOrders, firesCovered, exhaustsAt, runwayDays}], skipped } sorted shortest-runway-first. The gas section estimates native-gas burn for REAL fires from the historical average gas_cost_native (last 50 successful trades) — no history means no estimate (never guessed). Pair with the funding_runway alert rule for push notification (or action:'pause' to stop firing into guaranteed failures). Errors: INVALID_PARAMS (bad horizonDays).",
    {
      chain: z.string().optional().describe("Filter to one chain."),
      account: z.string().optional().describe("Filter to one account label."),
      strategy: z.string().optional().describe("Exact strategy tag — scope the forecast to one strategy's own primitives."),
      horizonDays: z.number().int().min(1).max(366).optional().describe("Forecast horizon (default 90). exhaustsAt=null means the balance survives the whole horizon."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("runway", rt.opts, input, input.chain, async () => {
            const { computeFundingRunway, defaultRunwayBalanceFetcher } = await import("../runway.js");
            const { loadConfig } = await import("../config.js");
            return await computeFundingRunway({
              chain: input.chain,
              account: input.account,
              strategy: input.strategy,
              horizonDays: input.horizonDays,
              balanceFetcher: defaultRunwayBalanceFetcher(loadConfig()),
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );
};
