// ──────────────────────────────────────────────────────────────────
// Web read-only automation API.
//
// The original /api surface (status, holdings, trades, pnl, quote,
// trade, …) predates the automation arc — the web dashboard was blind
// to everything the engine does: conditional orders, DCA schedules,
// rebalance plans, playbooks, paper trading, decision journals, the
// unified timeline, strategy alerts. A wall-mounted dashboard could
// show your balances but not "what is my strategy about to do and
// why did it do what it did".
//
// This module adds the missing routes. Design constraints:
//
//   1. READ-ONLY. Every route is a GET over SQLite (+ the engine
//      status/lock files). No wallet, no keystore, no RPC, no writes.
//      Mutations stay on the CLI/MCP surfaces where the confirmation
//      discipline (yes flags, phrases) lives — a leaked dashboard
//      token must not be able to fire trades through these routes.
//
//   2. Zero new aggregation logic. Each route delegates to the same
//      core helpers the CLI/MCP use (listOrders, getPlaybookDetail,
//      collectTimeline, buildStrategyReport, …) so the numbers match
//      across surfaces by construction.
//
//   3. Registered as a plain function over the Express app so the
//      route set is unit-testable without standing up the full
//      web server (auth, wallet context, static bundle).
//
// Auth: web.ts calls registerAutomationRoutes() AFTER its token
// middleware is installed, so every route here inherits the same
// bearer-token gate as the rest of /api.
// ──────────────────────────────────────────────────────────────────

import type { Express, Request, RequestHandler, Response } from "express";
import { ToolError } from "./errors.js";
import {
  listOrders,
  getOrderById,
  listSchedules,
  getScheduleById,
  listPlaybooks,
  getPlaybookById,
  listPaperBalances,
  listPaperTrades,
  listAlertEvents,
  listStrategyAlertStates,
  replayOrderEntries,
  replayScheduleEntries,
  replayRebalanceEntries,
  type OrderStatus,
  type ScheduleStatus,
  type PlaybookStatus,
} from "./db.js";
import { listRebalancePlans, getRebalancePlanById, type RebalanceStatus } from "./rebalance.js";
import { getPlaybookDetail } from "./playbooks.js";
import { summarizePaperPnl } from "./paperTrade.js";
import { collectTimeline, parseSinceDuration, ALL_EVENT_KINDS, type EventKind } from "./timeline.js";
import { buildStrategyReport, type ReportMode, type ReportWindow, type ReportSection } from "./strategyReport.js";
import { readEngineStatus } from "./engine.js";
import { getEngineLockState } from "./engineLock.js";
import { gatherStatusReport, ALL_SECTIONS, type SectionName } from "./status.js";
import { loadConfig } from "./config.js";
import { reviewSafety } from "./safetyReview.js";
import { gatherSafetyHeadroom } from "./safetyHeadroom.js";

// ── shared helpers ──────────────────────────────────────────

const wrap =
  (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      next(e);
    }
  };

function qStr(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function qInt(req: Request, name: string, opts: { min: number; max: number; fallback: number }): number {
  const raw = qStr(req, name);
  if (raw == null) return opts.fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < opts.min || n > opts.max) {
    throw new ToolError("INVALID_PARAMS", `query "${name}" must be an integer in [${opts.min}, ${opts.max}] (got "${raw}").`);
  }
  return n;
}

function pathId(req: Request): number {
  const raw = req.params.id;
  const n = parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ToolError("INVALID_PARAMS", `:id must be a positive integer (got "${raw}").`);
  }
  return n;
}

const TIMELINE_KINDS: EventKind[] = ALL_EVENT_KINDS;

// ── registration ────────────────────────────────────────────

/**
 * v35: inbound signal webhook — POST /api/signal/:name?key=SECRET.
 *
 * Registered BEFORE the dashboard-token middleware (TradingView and
 * most alert sources can only POST a fixed URL + JSON body — no
 * bearer headers). Auth is the SEPARATE config webhooks.signalSecret
 * (webhook URLs get pasted into third-party UIs and leak; the
 * dashboard token must not travel with them). Risk profile is
 * bounded by design: a forged signal can only fire orders the
 * operator PRE-ARMED with their own amounts and safety rails — it
 * cannot move funds on its own. Unset secret = 404 (endpoint
 * indistinguishable from absent).
 */
export function registerSignalWebhook(
  app: Express,
  logger: { info: (msg: string) => void },
): void {
  app.post("/api/signal/:name", async (req, res) => {
    try {
      const { loadConfig } = await import("./config.js");
      const secret = loadConfig().webhooks?.signalSecret;
      if (!secret) {
        res.status(404).json({ ok: false, error: { code: "INVALID_PARAMS", message: "Not found." } });
        return;
      }
      const key = typeof req.query.key === "string" ? req.query.key : "";
      if (!key || !timingSafeEqualStr(key, secret)) {
        res.status(401).json({ ok: false, error: { code: "WALLET_LOCKED", message: "Unauthorized." } });
        return;
      }
      const name = String(req.params.name ?? "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        res.status(400).json({ ok: false, error: { code: "INVALID_PARAMS", message: "signal name must match /^[A-Za-z0-9_-]{1,64}$/." } });
        return;
      }
      const { insertSignalEvent } = await import("./db.js");
      const payload =
        req.body != null && typeof req.body === "object" && Object.keys(req.body as object).length > 0
          ? JSON.stringify(req.body).slice(0, 4096)
          : null;
      const id = insertSignalEvent({ name, receivedAt: new Date().toISOString(), source: "webhook", payloadJson: payload });
      logger.info(`signal "${name}" received (webhook, event #${id})`);
      res.json({ ok: true, id, name });
    } catch (e) {
      res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: (e as Error).message } });
    }
  });
}

/** Constant-time string compare (local twin of web.ts tokensMatch —
 *  this module must not import the server entry). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function registerAutomationRoutes(app: Express): void {
  // ── engine ────────────────────────────────────────────────
  app.get(
    "/api/engine",
    wrap((_req, res) => {
      const status = readEngineStatus();
      const lock = getEngineLockState();
      res.json({
        ok: true,
        running: status != null && !status.stopping,
        status,
        lock: { active: lock.active === 1, reason: lock.reason, lockedAt: lock.locked_at, lockedBy: lock.locked_by },
      });
    }),
  );

  // ── full status dashboard ─────────────────────────────────
  app.get(
    "/api/dashboard",
    wrap((req, res) => {
      let sections: SectionName[] | undefined;
      const raw = qStr(req, "sections");
      if (raw) {
        sections = raw.split(",").map((x) => x.trim()).filter(Boolean) as SectionName[];
        for (const sec of sections) {
          if (!ALL_SECTIONS.includes(sec)) {
            throw new ToolError("INVALID_PARAMS", `unknown section "${sec}"; valid: ${ALL_SECTIONS.join(", ")}.`);
          }
        }
      }
      const report = gatherStatusReport({ sections });
      res.json({ ok: true, report, sections: sections ?? ALL_SECTIONS });
    }),
  );

  // ── orders ────────────────────────────────────────────────
  app.get(
    "/api/orders",
    wrap((req, res) => {
      const rows = listOrders({
        status: (qStr(req, "status") as OrderStatus | "all" | undefined) ?? "active",
        chain: qStr(req, "chain"),
        account: qStr(req, "account"),
        strategy: qStr(req, "strategy"),
      });
      const limit = qInt(req, "limit", { min: 1, max: 1000, fallback: 200 });
      res.json({ ok: true, count: Math.min(rows.length, limit), orders: rows.slice(0, limit) });
    }),
  );
  app.get(
    "/api/orders/:id",
    wrap((req, res) => {
      const id = pathId(req);
      const order = getOrderById(id);
      if (!order) throw new ToolError("INVALID_PARAMS", `Order #${id} not found.`);
      res.json({ ok: true, order, journal: replayOrderEntries(id, 50) });
    }),
  );

  // ── schedules ─────────────────────────────────────────────
  app.get(
    "/api/schedules",
    wrap((req, res) => {
      const rows = listSchedules({
        status: (qStr(req, "status") as ScheduleStatus | "all" | undefined) ?? "active",
        chain: qStr(req, "chain"),
        account: qStr(req, "account"),
        strategy: qStr(req, "strategy"),
      });
      const limit = qInt(req, "limit", { min: 1, max: 1000, fallback: 200 });
      res.json({ ok: true, count: Math.min(rows.length, limit), schedules: rows.slice(0, limit) });
    }),
  );
  app.get(
    "/api/schedules/:id",
    wrap((req, res) => {
      const id = pathId(req);
      const schedule = getScheduleById(id);
      if (!schedule) throw new ToolError("INVALID_PARAMS", `Schedule #${id} not found.`);
      res.json({ ok: true, schedule, journal: replayScheduleEntries(id, 50) });
    }),
  );

  // ── rebalance plans ───────────────────────────────────────
  app.get(
    "/api/rebalance",
    wrap((req, res) => {
      const rows = listRebalancePlans({
        status: (qStr(req, "status") as RebalanceStatus | "all" | undefined) ?? "active",
        chain: qStr(req, "chain"),
        account: qStr(req, "account"),
        strategy: qStr(req, "strategy"),
      });
      const limit = qInt(req, "limit", { min: 1, max: 1000, fallback: 200 });
      res.json({ ok: true, count: Math.min(rows.length, limit), plans: rows.slice(0, limit) });
    }),
  );
  app.get(
    "/api/rebalance/:id",
    wrap((req, res) => {
      const id = pathId(req);
      const plan = getRebalancePlanById(id);
      if (!plan) throw new ToolError("INVALID_PARAMS", `Rebalance plan #${id} not found.`);
      // The journal tail is the drift history — the dashboard's
      // "how close is this plan to firing?" series.
      res.json({ ok: true, plan, journal: replayRebalanceEntries(id, 50) });
    }),
  );

  // ── playbooks ─────────────────────────────────────────────
  app.get(
    "/api/playbooks",
    wrap((req, res) => {
      const rows = listPlaybooks({
        status: (qStr(req, "status") as PlaybookStatus | "all" | undefined) ?? "deployed",
        limit: qInt(req, "limit", { min: 1, max: 1000, fallback: 100 }),
      });
      res.json({ ok: true, count: rows.length, playbooks: rows });
    }),
  );
  app.get(
    "/api/playbooks/:id",
    wrap((req, res) => {
      const id = pathId(req);
      if (!getPlaybookById(id)) throw new ToolError("INVALID_PARAMS", `No playbook with id ${id}.`);
      const detail = getPlaybookDetail(id);
      res.json({
        ok: true,
        playbook: detail.row,
        spec: detail.spec,
        primitives: { orders: detail.orders, schedules: detail.schedules, rebalances: detail.rebalances },
      });
    }),
  );

  // ── paper trading ─────────────────────────────────────────
  app.get(
    "/api/paper",
    wrap((req, res) => {
      const filter: { account?: string; chain?: string } = {};
      if (qStr(req, "account")) filter.account = qStr(req, "account");
      if (qStr(req, "chain")) filter.chain = qStr(req, "chain");
      const balances = listPaperBalances(filter);
      // Same 5000-row cap + shared core as `paper pnl` / paper_pnl —
      // realized-only here (deterministic; MTM needs an oracle and
      // stays on the CLI/MCP surfaces where it's explicitly opted into).
      const trades = listPaperTrades({ ...filter, limit: 5000 });
      res.json({ ok: true, balances, pnl: summarizePaperPnl(trades) });
    }),
  );

  // ── unified timeline ──────────────────────────────────────
  app.get(
    "/api/timeline",
    wrap((req, res) => {
      let sinceIso: string | undefined;
      const since = qStr(req, "since");
      if (since) {
        const parsed = parseSinceDuration(since);
        if (!parsed) throw new ToolError("INVALID_PARAMS", `"since" must be a duration (4h, 2d) or ISO timestamp (got "${since}").`);
        sinceIso = parsed;
      }
      let kinds: EventKind[] | undefined;
      const kindsRaw = qStr(req, "kinds");
      if (kindsRaw) {
        kinds = kindsRaw.split(",").map((k) => k.trim()).filter(Boolean) as EventKind[];
        for (const k of kinds) {
          if (!TIMELINE_KINDS.includes(k)) {
            throw new ToolError("INVALID_PARAMS", `unknown kind "${k}"; valid: ${TIMELINE_KINDS.join(", ")}.`);
          }
        }
      }
      const minSeverity = qStr(req, "minSeverity");
      if (minSeverity && minSeverity !== "info" && minSeverity !== "warn" && minSeverity !== "critical") {
        throw new ToolError("INVALID_PARAMS", `"minSeverity" must be info | warn | critical.`);
      }
      const events = collectTimeline({
        sinceIso,
        untilIso: qStr(req, "until"),
        chain: qStr(req, "chain"),
        account: qStr(req, "account"),
        strategy: qStr(req, "strategy"),
        kinds,
        minSeverity: minSeverity as "info" | "warn" | "critical" | undefined,
        limit: qInt(req, "limit", { min: 1, max: 1000, fallback: 100 }),
      });
      res.json({ ok: true, count: events.length, events });
    }),
  );

  // ── realized gains (deterministic) ────────────────────────
  // Pure fill-journal walk, no oracle — fits this surface's
  // zero-network discipline exactly (unlike valuation/runway).
  app.get(
    "/api/gains",
    wrap(async (req, res) => {
      const { gatherRealizedGains } = await import("./gains.js");
      const mode = (qStr(req, "mode") as "real" | "paper" | undefined) ?? "real";
      if (mode !== "real" && mode !== "paper") {
        throw new ToolError("INVALID_PARAMS", `"mode" must be real | paper.`);
      }
      let sinceIso: string | undefined;
      const since = qStr(req, "since");
      if (since) {
        const parsed = parseSinceDuration(since);
        if (!parsed) throw new ToolError("INVALID_PARAMS", `"since" must be a duration (90d) or ISO timestamp.`);
        sinceIso = parsed;
      }
      const report = await gatherRealizedGains({
        mode,
        account: qStr(req, "account"),
        chain: qStr(req, "chain"),
        strategy: qStr(req, "strategy"),
        sinceIso,
      });
      res.json({ ok: true, ...report });
    }),
  );

  // ── signal inbox ──────────────────────────────────────────
  app.get(
    "/api/signals",
    wrap(async (req, res) => {
      const { listSignalEvents } = await import("./db.js");
      const events = listSignalEvents({
        name: qStr(req, "name"),
        limit: qInt(req, "limit", { min: 1, max: 500, fallback: 50 }),
      });
      res.json({ ok: true, count: events.length, events });
    }),
  );

  // ── v42: backtest results (read-only) ──────────────────────
  // The CLI/MCP run the simulations; the web tab makes three rounds
  // of backtest investment VISIBLE — risk metrics, the strategy-vs-
  // hold equity curves (persisted downsampled in metrics_json), the
  // fire timeline. List is intentionally light (no fires/metrics
  // payloads); detail hydrates one run fully.
  app.get(
    "/api/backtests",
    wrap(async (req, res) => {
      const { listBacktestRuns } = await import("./db.js");
      const strategyType = qStr(req, "strategyType");
      if (strategyType && !["order", "schedule", "playbook", "rebalance"].includes(strategyType)) {
        throw new ToolError("INVALID_PARAMS", `"strategyType" must be order | schedule | playbook | rebalance.`);
      }
      const rows = listBacktestRuns({
        strategyType: strategyType as never,
        chain: qStr(req, "chain"),
        limit: qInt(req, "limit", { min: 1, max: 500, fallback: 50 }),
      });
      res.json({
        ok: true,
        count: rows.length,
        runs: rows.map((r) => ({
          id: r.id,
          strategy_type: r.strategy_type,
          chain: r.chain,
          base_symbol: r.base_symbol,
          quote_symbol: r.quote_symbol,
          window_start: r.window_start,
          window_end: r.window_end,
          points: r.points,
          fire_count: r.fire_count,
          pnl_usd: r.pnl_usd,
          hold_pnl_usd: r.hold_pnl_usd,
          vs_hold_usd: r.pnl_usd - r.hold_pnl_usd,
          has_metrics: r.metrics_json != null,
          created_at: r.created_at,
        })),
      });
    }),
  );

  app.get(
    "/api/backtests/:id",
    wrap(async (req, res) => {
      const { getBacktestRunById } = await import("./db.js");
      const id = parseInt(String(req.params.id ?? ""), 10);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ToolError("INVALID_PARAMS", `:id must be a positive integer.`);
      }
      const row = getBacktestRunById(id);
      if (!row) {
        res.status(404).json({ ok: false, error: { code: "INVALID_PARAMS", message: `No backtest run #${id}.` } });
        return;
      }
      let metrics: unknown = null;
      if (row.metrics_json) {
        try {
          metrics = JSON.parse(row.metrics_json);
        } catch {
          metrics = null; // malformed pre-v39 data — degrade, don't 500
        }
      }
      res.json({
        ok: true,
        run: {
          id: row.id,
          strategy_type: row.strategy_type,
          chain: row.chain,
          base_symbol: row.base_symbol,
          quote_symbol: row.quote_symbol,
          spec: JSON.parse(row.spec_json),
          initial_balance: JSON.parse(row.initial_balance_json),
          final_balance: JSON.parse(row.final_balance_json),
          window_start: row.window_start,
          window_end: row.window_end,
          points: row.points,
          fires: JSON.parse(row.fires_json),
          fire_count: row.fire_count,
          pnl_usd: row.pnl_usd,
          hold_pnl_usd: row.hold_pnl_usd,
          vs_hold_usd: row.pnl_usd - row.hold_pnl_usd,
          notes: row.notes,
          metrics,
          created_at: row.created_at,
        },
      });
    }),
  );

  app.get(
    "/api/backtest-comparisons",
    wrap(async (req, res) => {
      const { listBacktestComparisons } = await import("./db.js");
      const rows = listBacktestComparisons({
        chain: qStr(req, "chain"),
        limit: qInt(req, "limit", { min: 1, max: 200, fallback: 25 }),
      });
      res.json({
        ok: true,
        count: rows.length,
        comparisons: rows.map((r) => {
          let scenarios: Array<{ scenarioName?: string }> = [];
          try {
            scenarios = JSON.parse(r.results_json) as Array<{ scenarioName?: string }>;
          } catch {
            // tolerate malformed rows
          }
          return {
            id: r.id,
            name: r.name,
            chain: r.chain,
            base_symbol: r.base_symbol,
            quote_symbol: r.quote_symbol,
            window_start: r.window_start,
            window_end: r.window_end,
            scenario_count: scenarios.length,
            winner_idx: r.winner_idx,
            winner: r.winner_idx != null ? (scenarios[r.winner_idx]?.scenarioName ?? null) : null,
            created_at: r.created_at,
          };
        }),
      });
    }),
  );

  app.get(
    "/api/backtest-comparisons/:id",
    wrap(async (req, res) => {
      const { getBacktestComparisonById } = await import("./db.js");
      const id = parseInt(String(req.params.id ?? ""), 10);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ToolError("INVALID_PARAMS", `:id must be a positive integer.`);
      }
      const row = getBacktestComparisonById(id);
      if (!row) {
        res.status(404).json({ ok: false, error: { code: "INVALID_PARAMS", message: `No comparison #${id}.` } });
        return;
      }
      res.json({
        ok: true,
        comparison: {
          id: row.id,
          name: row.name,
          chain: row.chain,
          base_symbol: row.base_symbol,
          quote_symbol: row.quote_symbol,
          window_start: row.window_start,
          window_end: row.window_end,
          winner_idx: row.winner_idx,
          scenarios: JSON.parse(row.results_json),
          // run_ids is comma-joined in the column, not JSON
          run_ids: row.run_ids.split(",").filter(Boolean).map((x) => parseInt(x, 10)),
          created_at: row.created_at,
        },
      });
    }),
  );

  // ── v47.5: trade-intent queue (read-only — approve is CLI-only) ──
  app.get(
    "/api/intents",
    wrap(async (req, res) => {
      const { listIntents } = await import("./tradeIntents.js");
      const status = qStr(req, "status");
      if (status && !["pending", "executed", "failed", "rejected", "expired"].includes(status)) {
        throw new ToolError("INVALID_PARAMS", `"status" must be pending | executed | failed | rejected | expired.`);
      }
      const rows = listIntents({
        status: status as never,
        limit: qInt(req, "limit", { min: 1, max: 200, fallback: 50 }),
      });
      // v102: a safe JSON parse for the persisted blobs — a corrupt row must
      // never 500 the whole queue view.
      const safeParse = (s: string | null): unknown => {
        if (!s) return null;
        try { return JSON.parse(s); } catch { return null; }
      };
      res.json({
        ok: true,
        count: rows.length,
        pending: rows.filter((r) => r.status === "pending").length,
        intents: rows.map((r) => {
          const request = safeParse(r.request_json) as Record<string, unknown> | null;
          const preview = safeParse(r.preview_json) as Record<string, unknown> | null;
          return {
            id: r.id,
            status: r.status,
            tool: r.tool,
            chain: r.chain,
            account: r.account,
            est_usd: r.est_usd,
            reason: r.reason,
            created_at: r.created_at,
            expires_at: r.expires_at,
            decided_at: r.decided_at,
            decided_note: r.decided_note,
            // v102: full review context so the operator can vet the proposed
            // trade ON THE WEB, then run the CLI approve (approve stays
            // CLI-only by design). v101 approvalReasons = WHY it was gated.
            approvalReasons: (safeParse(r.approval_reasons_json) as string[] | null) ?? [],
            base: (request?.base as string | undefined) ?? null,
            quote: (request?.quote as string | undefined) ?? null,
            preview: preview
              ? {
                  price: preview.price ?? null,
                  baseAmount: preview.baseAmount ?? null,
                  quoteAmount: preview.quoteAmount ?? null,
                  baseSymbol: preview.baseSymbol ?? null,
                  quoteSymbol: preview.quoteSymbol ?? null,
                  aggregator: preview.aggregator ?? null,
                }
              : null,
            // The exact CLI commands — the web is read-only for the decision.
            approveCmd: `tradekit intents approve ${r.id}`,
            rejectCmd: `tradekit intents reject ${r.id} --note "..."`,
          };
        }),
      });
    }),
  );

  // ── v46: execution quality (read-only, offline) ───────────
  app.get(
    "/api/execution",
    wrap(async (req, res) => {
      const { gatherExecutionReport } = await import("./executionReport.js");
      const windowLabel = qStr(req, "since") ?? "30d";
      const sinceIso = parseSinceDuration(windowLabel);
      if (!sinceIso) throw new ToolError("INVALID_PARAMS", `"since" must be a duration (30d) or ISO timestamp.`);
      const report = gatherExecutionReport({
        windowLabel,
        sinceIso,
        chain: qStr(req, "chain"),
        account: qStr(req, "account"),
      });
      res.json({ ok: true, ...report });
    }),
  );

  // ── funding runway ────────────────────────────────────────
  // On-demand (the UI computes it behind a button, not on the
  // auto-refresh loop): real buckets read on-chain balances, which
  // costs an RPC round-trip per distinct spend token.
  app.get(
    "/api/runway",
    wrap(async (req, res) => {
      const days = qInt(req, "days", { min: 1, max: 366, fallback: 90 });
      const { computeFundingRunway, defaultRunwayBalanceFetcher } = await import("./runway.js");
      const { loadConfig } = await import("./config.js");
      const report = await computeFundingRunway({
        chain: qStr(req, "chain"),
        account: qStr(req, "account"),
        strategy: qStr(req, "strategy"),
        horizonDays: days,
        balanceFetcher: defaultRunwayBalanceFetcher(loadConfig()),
      });
      res.json({ ok: true, ...report });
    }),
  );

  // ── alerts ────────────────────────────────────────────────
  app.get(
    "/api/alerts",
    wrap((req, res) => {
      const tag = qStr(req, "tag");
      const active = listStrategyAlertStates({ tag, active: true });
      const history = listAlertEvents({
        tag,
        limit: qInt(req, "limit", { min: 1, max: 1000, fallback: 50 }),
      });
      res.json({ ok: true, active, history });
    }),
  );

  // ── strategy report ───────────────────────────────────────
  // ── equity curve ──────────────────────────────────────────
  // Pure DB read over portfolio_snapshots — the v37 engine snapshot
  // worker is the feed.
  app.get(
    "/api/equity",
    wrap(async (req, res) => {
      const { buildEquityCurve } = await import("./equity.js");
      let sinceIso: string | undefined;
      const since = qStr(req, "since");
      if (since) {
        const parsed = parseSinceDuration(since);
        if (!parsed) throw new ToolError("INVALID_PARAMS", `"since" must be a duration (30d) or ISO timestamp.`);
        sinceIso = parsed;
      }
      const curve = buildEquityCurve({
        accountsKey: qStr(req, "accountsKey"),
        chainsKey: qStr(req, "chainsKey"),
        sinceIso,
        maxPoints: qInt(req, "maxPoints", { min: 2, max: 2000, fallback: 200 }),
      });
      res.json({ ok: true, ...curve });
    }),
  );

  // ── strategy tags ─────────────────────────────────────────
  // Union of trade-history tags and live-primitive tags so a freshly
  // deployed playbook (zero fills) still appears in the picker.
  app.get(
    "/api/strategies",
    wrap(async (_req, res) => {
      const { listDistinctStrategies } = await import("./db.js");
      const fromTrades = listDistinctStrategies({});
      const byTag = new Map<string, { tag: string; tradeCount: number; lastUsed: string | null; live: boolean }>();
      for (const r of fromTrades) {
        if (!r.strategy) continue;
        byTag.set(r.strategy, { tag: r.strategy, tradeCount: r.tradeCount, lastUsed: r.lastUsed, live: false });
      }
      // live = has ACTIVE primitives (enumerateActiveTags would also
      // include trade-only tags — its semantics are "worth alerting
      // on", not "currently deployed").
      const liveTags = new Set<string>();
      for (const o of listOrders({ status: "active" })) if (o.strategy) liveTags.add(o.strategy);
      for (const s of listSchedules({ status: "active" })) if (s.strategy) liveTags.add(s.strategy);
      for (const r of listRebalancePlans({ status: "active" })) if (r.strategy) liveTags.add(r.strategy);
      for (const tag of liveTags) {
        const existing = byTag.get(tag);
        if (existing) existing.live = true;
        else byTag.set(tag, { tag, tradeCount: 0, lastUsed: null, live: true });
      }
      const strategies = Array.from(byTag.values()).sort((a, z) => {
        if (a.live !== z.live) return a.live ? -1 : 1; // live first
        return (z.lastUsed ?? "").localeCompare(a.lastUsed ?? "");
      });
      res.json({ ok: true, count: strategies.length, strategies });
    }),
  );

  app.get(
    "/api/strategy-report/:tag",
    wrap(async (req, res) => {
      const tag = String(req.params.tag ?? "");
      if (!tag) throw new ToolError("INVALID_PARAMS", `:tag is required.`);
      const window = (qStr(req, "window") as ReportWindow | undefined) ?? "30d";
      if (!["1d", "7d", "30d", "90d", "all"].includes(window)) {
        throw new ToolError("INVALID_PARAMS", `"window" must be 1d | 7d | 30d | 90d | all.`);
      }
      const mode = (qStr(req, "mode") as ReportMode | undefined) ?? "auto";
      if (!["real", "paper", "auto"].includes(mode)) {
        throw new ToolError("INVALID_PARAMS", `"mode" must be real | paper | auto.`);
      }
      // Deterministic + network-free by design: no livePriceFn (forward
      // distances show null) and no valuation/runway sections (they need
      // oracle/balance IO). Live-priced views stay on the CLI/MCP
      // surfaces where the cost is opted into. `sections` may subset
      // the seven core sections.
      const CORE_SECTIONS = ["identity", "composition", "performance", "position", "risk", "activity", "forward"] as const;
      let sections: ReportSection[] | undefined;
      const rawSections = qStr(req, "sections");
      if (rawSections) {
        sections = rawSections.split(",").map((x) => x.trim()).filter(Boolean) as ReportSection[];
        for (const s of sections) {
          if (!(CORE_SECTIONS as readonly string[]).includes(s)) {
            throw new ToolError("INVALID_PARAMS", `unknown/unavailable section "${s}"; this route serves: ${CORE_SECTIONS.join(", ")}.`);
          }
        }
      }
      const report = await buildStrategyReport({ tag, window, mode, sections });
      res.json({ ok: true, report });
    }),
  );

  // ── safety (v68) ──────────────────────────────────────────
  // Web parity for the operator-trust surfaces: the v51 config posture
  // (what's configured / what's wide open) + the v53 runtime headroom (how
  // much room is left, what's the binding constraint). Read-only,
  // deterministic (config + the trades/drawdown tables; no RPC) — the same
  // pull operators get from `safety review` / `safety headroom` on the CLI,
  // now consumable by the web dashboard + any external monitor.
  app.get(
    "/api/safety",
    wrap(async (_req, res) => {
      const config = loadConfig();
      const posture = reviewSafety(config);
      const headroom = gatherSafetyHeadroom({ config });
      // v113: bring the safety-NET reliability signals to the web operator —
      // the cron digest (engine liveness) and doctor (notification delivery)
      // checks decide whether the guardrails can actually FIRE / REACH you. Reuse
      // the exported doctor checks (single source); both are fast + RPC-free.
      const { checkEngineLiveness, checkNotificationDelivery } = await import("./doctor.js");
      const reliability = await Promise.all([checkEngineLiveness(), checkNotificationDelivery()]);
      res.json({ ok: true, posture, headroom, reliability });
    }),
  );

  // ── strategy comparison (v87) ─────────────────────────────
  // Web parity for the v83 capital-allocation view — rank strategies by
  // realized P&L + win rate so an operator sees which to scale / cut at a
  // glance (the existing Strategy tab is a per-tag deep-dive; this is the
  // cross-strategy ranking). Deterministic (DB-only, stablecoin-$1 model) — no
  // RPC, fully testable.
  app.get(
    "/api/strategy-compare",
    wrap(async (req, res) => {
      const mode = qStr(req, "mode") === "paper" ? "paper" : "real";
      const daysRaw = qStr(req, "days");
      const days = daysRaw != null ? Number(daysRaw) : undefined;
      const sinceIso =
        days != null && Number.isFinite(days) && days > 0
          ? new Date(Date.now() - days * 86_400_000).toISOString()
          : undefined;
      const { gatherStrategyComparison } = await import("./strategyCompare.js");
      res.json({ ok: true, ...gatherStrategyComparison({ mode, sinceIso }) });
    }),
  );

  // ── risk posture (v86) ────────────────────────────────────
  // Web parity for the v78 unified RUNTIME risk verdict — the single "is my
  // book in danger right now?" answer (exposure headroom + concentration +
  // unprotected value + MEV synthesized to ok/elevated/critical with ranked
  // concerns). The most important operator signal, now on the dashboard
  // instead of only `risk` on the CLI. Each component is best-effort: a dim
  // that needs on-chain reads degrades into `skipped` (never fails the call),
  // so the page renders even when an RPC is down.
  app.get(
    "/api/risk",
    wrap(async (_req, res) => {
      const config = loadConfig();
      const { gatherRiskPosture } = await import("./riskPosture.js");
      const { createSilentLogger } = await import("./logger.js");
      const report = await gatherRiskPosture({ config, logger: createSilentLogger() });
      res.json({ ok: true, ...report });
    }),
  );
}
