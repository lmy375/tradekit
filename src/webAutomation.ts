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
}
