// Unified engine supervisor.
//
// Single-process daemon that fans out per-feature workers (orders engine,
// schedules engine, reconcile sweep) on independent cadences. Replaces the
// three separate `*  run --watch` daemons with a single deployment unit —
// one systemd service, one container, one health check, one keystore
// decrypt at startup.
//
// Architecture:
//
//   EngineSupervisor
//   ├── Worker("orders",     30s) → runOrderTick
//   ├── Worker("schedules",  60s) → runScheduleTick
//   └── Worker("reconcile",  60s) → reconcilePending
//
// Each worker is wrapped with per-tick error catching so one worker's RPC
// outage cannot kill the others. Per-worker telemetry is persisted to a
// status file (~/.tradekit/.engine.status.json) on every tick so `engine
// status` can answer "what's the engine doing right now?" without an IPC
// channel.
//
// Process lock: the supervisor takes a file-system advisory lock at boot
// (via processLock.withLock) so a second `engine run` immediately fails
// with WALLET_LOCKED + the holder's pid. Stale-lock cleanup handles a
// previous crashed run.
//
// Graceful shutdown: SIGINT/SIGTERM set `stopRequested = true`. The
// scheduler loop polls this flag every ≤ 1s during sleeps, and an
// in-flight tick is allowed to complete before exit. Hard invariant —
// never kill a tick mid-trade.

import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Logger } from "./logger.js";
import { ToolError } from "./errors.js";
import { loadConfig, type Config, type EngineWorkerName } from "./config.js";
import { acquireLock, type LockHolder } from "./processLock.js";
import { runOrderTick } from "./orders.js";
import { runScheduleTick } from "./schedules.js";
import { reconcilePending } from "./reconcile.js";
import { runRebalanceTick } from "./rebalance.js";
import { runAlertTick } from "./strategyAlerts.js";
import { renderMetricsResponse } from "./metrics.js";
import { tryNotify } from "./notify.js";
import { DATA_DIR } from "./constants.js";
import {
  emptyWorkerHealth,
  nextWorkerInterval,
  recordTickResult,
  summarizeTimings,
  type WorkerHealthState,
  type TickTimingSummary,
} from "./engineHealth.js";
import { ConfigRef, buildSighupHandler } from "./configReload.js";
import { listOrders, listSchedules, listDrawdownStates } from "./db.js";
import {
  recordEngineStarted,
  recordEngineStopped,
  recordWorkerDegraded,
  recordWorkerRecovered,
} from "./engineEvents.js";

// ── status persistence ───────────────────────────────────────

export const ENGINE_STATUS_FILE = join(DATA_DIR, ".engine.status.json");

export interface EngineWorkerStatus {
  name: EngineWorkerName;
  enabled: boolean;
  intervalMs: number;
  /** Total ticks attempted across the supervisor's lifetime. */
  ticks: number;
  /** Ticks that returned ok=true. */
  successes: number;
  /** Ticks that errored OR returned a non-empty `error` field. */
  failures: number;
  /** ISO timestamp of the last completed tick (success or fail). */
  lastTickAt: string | null;
  /** Most recent tickFn payload — surfaced by `engine status` so operators
   *  see counters per worker (orders fired/failed, schedules due/fired,
   *  reconcile resolved/pending) without grepping logs. */
  lastTickData: unknown;
  /** Last error message (if the most recent tick failed). */
  lastError: string | null;
  /** Earliest UTC time the worker will tick next. Computed as
   *  lastTickAt + intervalMs; nullable when the worker hasn't ticked yet. */
  nextTickDueAt: string | null;
  /** Iter33: number of consecutive failures (resets on first success).
   *  Surfaces in status so an operator can see "this worker has been
   *  failing for the last 5 ticks" without scrolling through the log. */
  consecutiveFailures: number;
  /** Iter33: true when the resilience layer has entered backoff for this
   *  worker. Operators see this prominently in `engine status` and can
   *  correlate with the `worker.degraded` notification that fired. */
  degraded: boolean;
  /** Iter33: current effective interval after backoff (matches
   *  intervalMs when not degraded; multiplied when degraded up to
   *  the configured max). */
  effectiveIntervalMs: number;
  /** Iter33: tick-duration summary over the last N ticks (window size
   *  from config.engine.resilience.tickTimingWindow). null until the
   *  worker has ticked at least once. */
  tickTiming: TickTimingSummary | null;
}

export interface EngineStatus {
  /** Supervisor process id — operators can `kill -INT <pid>` it. */
  pid: number;
  /** When the supervisor started. */
  startedAt: string;
  /** When the status file was last updated (every tick). */
  updatedAt: string;
  /** Per-worker state. */
  workers: EngineWorkerStatus[];
  /** True once the supervisor has begun the shutdown sequence. */
  stopping: boolean;
}

/** Best-effort persistence — a failed status write is logged but never
 *  blocks a tick. The status file is purely operator-facing. */
function writeStatus(status: EngineStatus, logger: Logger): void {
  try {
    writeFileSync(ENGINE_STATUS_FILE, JSON.stringify(status, null, 2) + "\n");
  } catch (e) {
    logger.warn(`engine: status file write failed: ${(e as Error).message}`);
  }
}

/** Reader for `engine status` and the MCP `engine_status` tool. Returns
 *  null when the file is absent (engine never started or was cleaned up). */
export function readEngineStatus(): EngineStatus | null {
  if (!existsSync(ENGINE_STATUS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(ENGINE_STATUS_FILE, "utf-8")) as EngineStatus;
  } catch {
    // Malformed — treat as absent rather than throwing. Operator can
    // delete the file by hand if they're debugging.
    return null;
  }
}

// ── worker abstraction ───────────────────────────────────────

export interface WorkerContext {
  config: Config;
  logger: Logger;
  /** Wallet password (when the supervisor was started with one). Workers
   *  that need to sign on a fire pass this to the underlying tick function.
   *  Undefined when the supervisor is in dry-run / read-only mode. */
  password?: string;
  /** True when this tick should evaluate triggers + advance bookkeeping
   *  but NEVER send a transaction. Propagates to the wrapped tick fn. */
  dryRun?: boolean;
}

export interface WorkerTickResult {
  ok: boolean;
  /** Per-worker structured payload — surfaced via the status file + the
   *  console output. Kept generic so each worker can return its own
   *  natural shape (OrderTickReport / ScheduleTickReport / ReconcileReport). */
  data?: unknown;
  /** Soft-fail message. Supervisor records on the worker but doesn't halt
   *  the engine — a single bad worker can't take down its peers. */
  error?: string;
}

export interface Worker {
  name: EngineWorkerName;
  intervalMs: number;
  tick(ctx: WorkerContext): Promise<WorkerTickResult>;
}

/** Build the three built-in workers from a Config. Each is a thin wrapper
 *  around the existing per-feature tick function — no logic duplication. */
export function buildBuiltinWorkers(config: Config): Worker[] {
  const out: Worker[] = [];
  const cfg = config.engine.workers;

  if (cfg.orders.enabled) {
    out.push({
      name: "orders",
      intervalMs: cfg.orders.intervalMs,
      async tick(ctx) {
        try {
          const report = await runOrderTick({
            password: ctx.password,
            dryRun: ctx.dryRun,
            logger: ctx.logger,
          });
          return { ok: report.severity === "ok", data: report };
        } catch (e) {
          return { ok: false, error: (e as Error).message ?? String(e) };
        }
      },
    });
  }
  if (cfg.schedules.enabled) {
    out.push({
      name: "schedules",
      intervalMs: cfg.schedules.intervalMs,
      async tick(ctx) {
        try {
          const report = await runScheduleTick({
            password: ctx.password,
            dryRun: ctx.dryRun,
            logger: ctx.logger,
          });
          return { ok: report.severity === "ok", data: report };
        } catch (e) {
          return { ok: false, error: (e as Error).message ?? String(e) };
        }
      },
    });
  }
  if (cfg.reconcile.enabled) {
    out.push({
      name: "reconcile",
      intervalMs: cfg.reconcile.intervalMs,
      async tick(ctx) {
        try {
          // Reconcile is read-only against the wallet — no password
          // required. Just walks pending trades and queries receipts.
          const report = await reconcilePending({
            config: ctx.config,
            logger: ctx.logger,
          });
          return {
            ok: report.severity === "ok",
            data: report,
            error: report.severity === "ok" ? undefined : `${report.errors.length} error(s), ${report.stillPending} still pending`,
          };
        } catch (e) {
          return { ok: false, error: (e as Error).message ?? String(e) };
        }
      },
    });
  }
  if (cfg.rebalance.enabled) {
    out.push({
      name: "rebalance",
      intervalMs: cfg.rebalance.intervalMs,
      async tick(ctx) {
        try {
          const report = await runRebalanceTick({
            password: ctx.password,
            dryRun: ctx.dryRun,
            logger: ctx.logger,
          });
          return { ok: report.severity === "ok", data: report };
        } catch (e) {
          return { ok: false, error: (e as Error).message ?? String(e) };
        }
      },
    });
  }
  if (cfg.alerts.enabled) {
    // Iter33: alerts worker — runs the iter32 strategy-alerts tick.
    // Read-side worker (no wallet needed); ok=true even when alerts
    // fire because firing IS the intended successful outcome. The
    // worker is enabled by default, but the tick itself is a no-op
    // when safety.strategyAlerts.enabled=false → cheap when operators
    // haven't opted in.
    out.push({
      name: "alerts",
      intervalMs: cfg.alerts.intervalMs,
      async tick(ctx) {
        try {
          const report = await runAlertTick({
            config: ctx.config,
            logger: ctx.logger,
          });
          return { ok: true, data: report };
        } catch (e) {
          return { ok: false, error: (e as Error).message ?? String(e) };
        }
      },
    });
  }
  if (cfg.db_maintenance.enabled) {
    // Iter40: db_maintenance worker — runs integrity check +
    // retention prune + auto-backup on internally-tracked cadences
    // (from db.{integrityCheck,retention,backup}.intervalHours).
    // Read-only from the wallet POV (no password). Each subtask
    // is independently gated; ok=true iff none threw. Subtask
    // success/failure is reported via engine_events for forensic
    // history regardless of which one triggered the tick result.
    out.push({
      name: "db_maintenance",
      intervalMs: cfg.db_maintenance.intervalMs,
      async tick(ctx) {
        try {
          const { runDbMaintenanceTick } = await import("./dbMaintenance.js");
          const report = runDbMaintenanceTick({ config: ctx.config, logger: ctx.logger });
          return { ok: true, data: report };
        } catch (e) {
          return { ok: false, error: (e as Error).message ?? String(e) };
        }
      },
    });
  }
  return out;
}

// ── supervisor ───────────────────────────────────────────────

export interface SupervisorOptions {
  /** Workers to enable. Defaults to every enabled worker in config. Subset
   *  passes through to filter — used by `engine run --workers orders,schedules`. */
  workers?: EngineWorkerName[];
  /** Wallet password. Required when any signing worker (orders/schedules)
   *  is enabled and dryRun is false. */
  password?: string;
  dryRun?: boolean;
  /** Maximum supervisor tick rounds before exit. Default Infinity (run
   *  forever). Used by tests + by `engine run --once` (set to 1). One
   *  "tick round" = one pass through the worker loop that fired ≥ 1 worker. */
  maxTicks?: number;
  logger: Logger;
  /** Override clock — used by tests to drive the scheduler deterministically. */
  now?: () => number;
  /** Inject a custom worker list, bypassing buildBuiltinWorkers. Used by
   *  tests to exercise the supervisor's scheduling / isolation / status
   *  logic with mock workers (no RPC dependencies). When set, the engine
   *  worker config filter still applies via `opts.workers` (name allowlist). */
  workersOverride?: Worker[];
  /** When set, the supervisor starts a tiny standalone HTTP listener
   *  exposing the Prometheus `/metrics` endpoint on this port. Default
   *  unset (no listener). Useful for single-process production
   *  deployments — operators running just `tradekit engine run` get a
   *  scrapable endpoint without also spinning up the web server. */
  metricsPort?: number;
  /** Bind host for the metrics listener. Default "127.0.0.1" (loopback
   *  only — operators expose externally via firewall rules + reverse
   *  proxy, matching the Prometheus convention). */
  metricsHost?: string;
}

export interface SupervisorRunResult {
  startedAt: string;
  stoppedAt: string;
  uptimeMs: number;
  workers: EngineWorkerStatus[];
  reason: "max_ticks" | "signal" | "fatal_error";
  fatal?: string;
}

/**
 * Run the engine supervisor. Returns when stopped (signal, maxTicks
 * exhaustion, or fatal error). Holds an exclusive `.lock.engine` file in
 * the data dir for its entire lifetime — a second supervisor invocation
 * fails immediately with WALLET_LOCKED.
 *
 * The function is designed to be called from the CLI (`engine run`) but
 * the same shape works from MCP / agent harnesses (caller supplies the
 * logger + signal-equivalent via maxTicks).
 */
export async function runEngineSupervisor(opts: SupervisorOptions): Promise<SupervisorRunResult> {
  const lock = acquireLock(DATA_DIR, "engine", "engine run");
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const now = opts.now ?? Date.now;
  // Iter35: hold the live config in a mutable ref so SIGHUP can
  // atomically swap it without restarting the supervisor. The
  // initial value is the same loadConfig() call as before; every
  // subsequent read inside the loop goes through configRef.get()
  // so a reload between ticks is invisible to in-flight work.
  const configRef = new ConfigRef(loadConfig());
  const config = configRef.get();

  // Filter workers by --workers list AND by config.engine.workers.enabled.
  // workersOverride is the test seam — when supplied, it short-circuits
  // buildBuiltinWorkers entirely.
  const allWorkers = opts.workersOverride ?? buildBuiltinWorkers(config);
  const filterSet = opts.workers ? new Set(opts.workers) : null;
  const workers = filterSet ? allWorkers.filter((w) => filterSet.has(w.name)) : allWorkers;

  if (workers.length === 0) {
    lock.release();
    throw new ToolError(
      "INVALID_PARAMS",
      "No workers enabled. Check config.engine.workers.* or pass --workers orders,schedules,reconcile to override.",
    );
  }

  // Refuse to start a signing worker without a password (unless dry-run).
  // reconcile + alerts are read-only — both safe without a password.
  const READ_ONLY_WORKERS = new Set<EngineWorkerName>(["reconcile", "alerts", "db_maintenance"]);
  const requiresPassword = !opts.dryRun && workers.some((w) => !READ_ONLY_WORKERS.has(w.name));
  if (requiresPassword && !opts.password) {
    lock.release();
    throw new ToolError(
      "WALLET_LOCKED",
      "Engine requires a wallet password to run signing workers (orders, schedules). Pass --pass or set WALLET_PASS, or run with --dry-run / --workers reconcile,alerts.",
    );
  }

  // Iter33: per-worker health state. Tracks consecutive failures,
  // backoff multiplier, timing window. The map keys match worker
  // names. Initialized empty; each tick pushes a fresh entry.
  const healthStates = new Map<string, WorkerHealthState>();
  for (const w of workers) healthStates.set(w.name, emptyWorkerHealth());
  const resilienceConfig = config.engine.resilience;

  // Initial status snapshot — operators starting the engine want `engine
  // status` to immediately show "running, no ticks yet" rather than null.
  let status: EngineStatus = {
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
    workers: workers.map((w) => ({
      name: w.name,
      enabled: true,
      intervalMs: w.intervalMs,
      ticks: 0,
      successes: 0,
      failures: 0,
      lastTickAt: null,
      lastTickData: null,
      lastError: null,
      nextTickDueAt: new Date(now()).toISOString(),
      // Iter33 fields — start clean.
      consecutiveFailures: 0,
      degraded: false,
      effectiveIntervalMs: w.intervalMs,
      tickTiming: null,
    })),
    stopping: false,
  };
  writeStatus(status, opts.logger);

  // engine.started notification — signals deployment auditing systems.
  await tryNotify(
    {
      event: "engine.started",
      severity: "info",
      title: `Engine supervisor started (pid ${process.pid})`,
      fields: {
        pid: process.pid,
        workers: workers.map((w) => `${w.name}@${w.intervalMs / 1000}s`).join(","),
        dryRun: opts.dryRun ?? false,
        startedAt,
      },
    },
    config,
    opts.logger,
  );
  // Iter39: durable engine event for the lifecycle history.
  // Side-by-side with the notification; persists past restart.
  recordEngineStarted({
    startedAt,
    workers: workers.map((w) => w.name),
    dryRun: opts.dryRun ?? false,
    logger: opts.logger,
  });

  // Shutdown wiring. Both signals route to the same stop flag; the loop
  // polls between sleeps. We don't kill in-flight ticks — see the loop
  // comment for the safety rationale.
  let stopRequested = false;
  let stopSignal: NodeJS.Signals | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    if (!stopRequested) {
      stopRequested = true;
      stopSignal = sig;
      opts.logger.info(`engine: ${sig} received — draining in-flight ticks then exiting`);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Iter35: SIGHUP triggers an atomic config reload + preflight
  // impact notification. The handler validates the on-disk config
  // before swapping; a malformed config keeps the running config
  // and emits a critical `config.reload_failed` event so the
  // operator notices immediately (vs. silently running on the old
  // config thinking the change took effect).
  const sighupHandler = buildSighupHandler({
    ref: configRef,
    logger: opts.logger,
    stateProvider: () => {
      // Cheap active-state snapshot for the preflight enrichment.
      // Failures here MUST NOT throw — the reload should succeed
      // even if the DB is briefly unavailable; the notification
      // just won't include "affected primitive" detail.
      try {
        return {
          orders: listOrders({}),
          schedules: listSchedules({}),
          drawdowns: listDrawdownStates(),
        };
      } catch {
        return undefined;
      }
    },
  });
  const onSighup = () => {
    void sighupHandler().catch((e) => {
      opts.logger.error(`engine: SIGHUP handler failed: ${(e as Error).message}`);
    });
  };
  process.on("SIGHUP", onSighup);

  // Optional Prometheus metrics listener. Starts a tiny standalone HTTP
  // server bound to loopback by default — operators expose externally
  // via firewall + reverse proxy (matching the Prometheus convention).
  // Only `/metrics` is handled; everything else returns 404. Listener
  // is closed in the finally block alongside lock release + signal
  // cleanup so a clean SIGINT shutdown also releases the port.
  let metricsServer: Server | null = null;
  if (opts.metricsPort != null) {
    const host = opts.metricsHost ?? "127.0.0.1";
    metricsServer = createServer((req, res) => {
      // Defensive: only respond to GET /metrics. POST + other paths get
      // 404 so a misconfigured scraper or stray browser doesn't get
      // misleading 200s on the wrong URL.
      if (req.method === "GET" && (req.url === "/metrics" || req.url === "/metrics/")) {
        try {
          const { contentType, body } = renderMetricsResponse();
          res.writeHead(200, { "content-type": contentType });
          res.end(body);
        } catch (e) {
          // A metrics render failure must NOT crash the supervisor.
          // Surface as a 500 so Prometheus marks the scrape as failed
          // and operators get an alert via their existing scrape-health
          // monitor.
          opts.logger.error(`engine: metrics render failed: ${(e as Error).message}`);
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(`# render failed: ${(e as Error).message}\n`);
        }
        return;
      }
      // Also serve a basic /healthz so the same listener doubles as a
      // load-balancer health check target. Returns 200 when the engine
      // is alive (the supervisor IS the process serving the response —
      // tautologically alive when this handler runs).
      if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok\n");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
    });
    metricsServer.listen(opts.metricsPort, host, () => {
      opts.logger.info(`engine: metrics listener bound to http://${host}:${opts.metricsPort}/metrics`);
    });
    // The listener's error handler — bind failures (EADDRINUSE) are
    // the common case; surface to the supervisor log + don't crash
    // (the supervisor itself continues without metrics).
    metricsServer.on("error", (e) => {
      opts.logger.warn(`engine: metrics listener error: ${(e as Error).message}`);
    });
  }

  // Heartbeat scheduling — independent of worker ticks. heartbeat=0 means
  // disabled; otherwise emit on first arrival of (now - lastHeartbeat) ≥
  // heartbeatIntervalMs.
  const heartbeatIntervalMs = config.engine.heartbeatIntervalMs;
  let lastHeartbeatAt = now();

  // Per-worker next-due timestamps. Initialized to "now" so every worker
  // fires on the first tick — operators starting the engine see immediate
  // activity rather than waiting up to a minute for the first reconcile.
  const dueAt = new Map<string, number>();
  for (const w of workers) dueAt.set(w.name, now());

  const maxTicks = opts.maxTicks ?? Number.POSITIVE_INFINITY;
  let supervisorTickCount = 0;
  let fatal: string | undefined;

  // Iter41: tick body extracted into a function so the supervisor
  // can dispatch all due workers via Promise.all instead of
  // sequentially awaiting each. Slow workers no longer block
  // fast ones — the round itself is bounded by the SLOWEST
  // due-worker's tick, not by their SUM.
  //
  // Semantics preserved: status writes still happen per round
  // (after all due workers complete), heartbeat fires after the
  // round, maxTicks counts rounds. Existing tests pass unchanged.
  //
  // Concurrency notes:
  //   - Each worker writes to its OWN status row (per-name lookup) +
  //     its OWN health state entry — no cross-worker collisions.
  //   - notification + engine_events writes are async-safe (the
  //     iter28+ notify queue + iter39 safeRecord both serialize
  //     internally / are idempotent).
  //   - SQLite busy_timeout (iter611) handles concurrent
  //     transaction collisions.
  //   - Worker tick functions themselves never call each other,
  //     so deadlock-via-recursion is impossible.
  async function tickOneWorker(worker: Worker): Promise<void> {
    opts.logger.debug(`engine: tick worker=${worker.name}`);
    const tickStart = Date.now();
    let result: WorkerTickResult;
    try {
      result = await worker.tick({
        // Iter35: read the live config on EACH tick. SIGHUP
        // between ticks swaps the ref; the next tick uses
        // the new config. Mid-tick changes are invisible.
        config: configRef.get(),
        logger: opts.logger,
        password: opts.password,
        dryRun: opts.dryRun,
      });
    } catch (e) {
      // Defensive: a worker's tickFn should catch its own errors (see
      // buildBuiltinWorkers), but a synchronous throw before the try
      // block (e.g. an import-time failure) still surfaces here. Wrap
      // so the supervisor stays up.
      const msg = (e as Error).message ?? String(e);
      opts.logger.warn(`engine: worker ${worker.name} threw out of tick: ${msg}`);
      result = { ok: false, error: msg };
    }
    const tickElapsed = Date.now() - tickStart;
    opts.logger.debug(`engine: tick worker=${worker.name} ok=${result.ok} elapsedMs=${tickElapsed}`);

    // Iter33: update the resilience state + classify any
    // transition. The state map is the source of truth for the
    // status fields (degraded / effectiveIntervalMs / tickTiming);
    // the supervisor-level counts (ticks/successes/failures)
    // remain on EngineWorkerStatus for backward-compat (existing
    // dashboards already read them).
    const priorHealth = healthStates.get(worker.name) ?? emptyWorkerHealth();
    const { state: newHealth, transition } = recordTickResult({
      state: priorHealth,
      ok: result.ok,
      durationMs: tickElapsed,
      baseIntervalMs: worker.intervalMs,
      config: resilienceConfig,
      now: new Date(),
    });
    healthStates.set(worker.name, newHealth);

    // Emit transition notifications. degraded / recovered are
    // operator-actionable; backoff_deepened is informational
    // (operator already got the degraded notification). No
    // notification for no_change — that's the common path.
    if (transition.kind === "entered_backoff") {
      await tryNotify(
        {
          event: "engine.worker.degraded",
          severity: "warn",
          title: `Engine worker degraded: ${worker.name}`,
          body: `${transition.reason}. Effective interval bumped to ${(transition.effectiveIntervalMs / 1000).toFixed(0)}s.`,
          fields: {
            worker: worker.name,
            consecutiveFailures: transition.consecutiveFailures,
            effectiveIntervalMs: transition.effectiveIntervalMs,
            baseIntervalMs: worker.intervalMs,
            lastError: result.error ?? null,
          },
          dedupKey: `engine.worker.degraded:${worker.name}`,
        },
        config,
        opts.logger,
      );
      // Iter39: durable engine event for forensic history.
      recordWorkerDegraded({
        workerName: worker.name,
        consecutiveFailures: transition.consecutiveFailures,
        effectiveIntervalMs: transition.effectiveIntervalMs,
        baseIntervalMs: worker.intervalMs,
        lastError: result.error ?? null,
        logger: opts.logger,
      });
    } else if (transition.kind === "recovered") {
      await tryNotify(
        {
          event: "engine.worker.recovered",
          severity: "info",
          title: `Engine worker recovered: ${worker.name}`,
          body: `After ${transition.afterFailures} consecutive failures, ${worker.name} ticked successfully. Restoring base interval.`,
          fields: {
            worker: worker.name,
            afterFailures: transition.afterFailures,
            tickDurationMs: transition.durationMs,
            baseIntervalMs: worker.intervalMs,
          },
          dedupKey: `engine.worker.recovered:${worker.name}:${new Date().toISOString().slice(0, 13)}`,
        },
        config,
        opts.logger,
      );
      // Iter39: durable engine event mirrors the notification.
      recordWorkerRecovered({
        workerName: worker.name,
        afterFailures: transition.afterFailures,
        tickDurationMs: transition.durationMs,
        baseIntervalMs: worker.intervalMs,
        logger: opts.logger,
      });
    }

    // Update status entry for this worker. Each worker only
    // writes its OWN row by name — no cross-worker collision.
    const wstatus = status.workers.find((w) => w.name === worker.name)!;
    wstatus.ticks += 1;
    if (result.ok) wstatus.successes += 1;
    else wstatus.failures += 1;
    wstatus.lastTickAt = new Date().toISOString();
    wstatus.lastTickData = result.data ?? null;
    wstatus.lastError = result.error ?? null;
    wstatus.consecutiveFailures = newHealth.consecutiveFailures;
    wstatus.degraded = newHealth.degraded;
    wstatus.tickTiming = summarizeTimings(newHealth.recentDurationsMs);

    // The next-due timestamp uses the BACKOFF-aware interval so a
    // degraded worker actually ticks less often. Non-degraded
    // workers see the base interval unchanged.
    const effectiveInterval = nextWorkerInterval({
      baseIntervalMs: worker.intervalMs,
      state: newHealth,
      config: resilienceConfig,
    });
    wstatus.effectiveIntervalMs = effectiveInterval;
    const nextDue = now() + effectiveInterval;
    dueAt.set(worker.name, nextDue);
    wstatus.nextTickDueAt = new Date(nextDue).toISOString();
  }

  try {
    while (!stopRequested && supervisorTickCount < maxTicks) {
      const t = now();
      // Iter41: collect all due workers at this moment + dispatch
      // them concurrently via Promise.all. The round still
      // completes when every due worker's tick resolves, but
      // wall-clock = MAX(tick durations) instead of SUM(tick
      // durations). A slow worker no longer blocks fast ones —
      // for operators with mixed-speed RPC tiers this is a real
      // throughput win.
      const dueWorkers = workers.filter((w) => (dueAt.get(w.name) ?? 0) <= t);
      let firedThisRound = false;
      if (dueWorkers.length > 0) {
        firedThisRound = true;
        await Promise.all(dueWorkers.map((worker) => tickOneWorker(worker)));
      }
      if (firedThisRound) {
        status.updatedAt = new Date().toISOString();
        writeStatus(status, opts.logger);
        supervisorTickCount += 1;
      }

      // Heartbeat emission. Happens AFTER worker ticks so the payload
      // includes the freshest counter snapshot.
      if (heartbeatIntervalMs > 0 && now() - lastHeartbeatAt >= heartbeatIntervalMs) {
        lastHeartbeatAt = now();
        await tryNotify(
          {
            event: "engine.heartbeat",
            severity: "info",
            title: `Engine heartbeat (uptime ${formatDuration(Date.now() - t0)})`,
            fields: {
              pid: process.pid,
              uptimeMs: Date.now() - t0,
              ...Object.fromEntries(
                status.workers.flatMap((w) => [
                  [`${w.name}_ticks`, w.ticks],
                  [`${w.name}_failures`, w.failures],
                ]),
              ),
            },
            dedupKey: `engine.heartbeat:${process.pid}`,
          },
          config,
          opts.logger,
        );
      }

      if (stopRequested || supervisorTickCount >= maxTicks) break;

      // Compute the earliest next-due moment across all workers; sleep
      // until then, but never more than 1s so SIGINT response time stays
      // tight. (1s vs 100ms is a trade-off — 1s costs an extra ~0.5s of
      // shutdown latency, but at 100ms the supervisor wakes 10×/second
      // even when nothing's due, polluting strace / process listings.)
      const earliestDue = Math.min(...Array.from(dueAt.values()));
      const sleepMs = Math.max(50, Math.min(1000, earliestDue - now()));
      await sleep(sleepMs);
    }
  } catch (e) {
    // The loop itself threw (vs a worker tick throw, which is caught
    // above). Treat as fatal — record and shut down.
    fatal = (e as Error).message ?? String(e);
    opts.logger.error(`engine: fatal supervisor error: ${fatal}`);
  } finally {
    status.stopping = true;
    status.updatedAt = new Date().toISOString();
    writeStatus(status, opts.logger);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSighup);
    // Release the metrics port (if bound) before the lock. Listener
    // close is async-ish but we don't await — node will reap the port
    // when the process exits. Calling close() ensures pending requests
    // get to finish gracefully rather than getting reset.
    if (metricsServer) {
      try {
        metricsServer.close();
      } catch (e) {
        opts.logger.warn(`engine: metrics listener close failed: ${(e as Error).message}`);
      }
    }
    lock.release();
  }

  const stoppedAt = new Date().toISOString();
  const uptimeMs = Date.now() - t0;

  // engine.stopped notification — symmetric with engine.started. Useful
  // for ops to confirm the supervisor really exited (vs hung).
  await tryNotify(
    {
      event: "engine.stopped",
      severity: fatal ? "critical" : "info",
      title: fatal
        ? `Engine supervisor stopped with fatal error: ${fatal}`
        : `Engine supervisor stopped${stopSignal ? ` (${stopSignal})` : ""}`,
      fields: {
        pid: process.pid,
        startedAt,
        stoppedAt,
        uptimeMs,
        signal: stopSignal,
        ...Object.fromEntries(
          status.workers.flatMap((w) => [
            [`${w.name}_ticks`, w.ticks],
            [`${w.name}_failures`, w.failures],
          ]),
        ),
      },
    },
    config,
    opts.logger,
  );
  // Iter39: durable engine.stopped event. Operators answering
  // "what was my engine doing 3 days ago when it crashed?" get
  // the answer from DB, not from rotated log files.
  recordEngineStopped({
    startedAt,
    stoppedAt,
    uptimeMs,
    fatal: fatal ?? null,
    stopSignal: stopSignal ?? null,
    logger: opts.logger,
  });

  return {
    startedAt,
    stoppedAt,
    uptimeMs,
    workers: status.workers,
    reason: fatal ? "fatal_error" : stopRequested ? "signal" : "max_ticks",
    fatal,
  };
}

// ── helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  // Critical: do NOT t.unref(). Node signal listeners don't keep the event
  // loop alive on their own — if our sleep timer is unref'd, the loop
  // drains and the process exits PREMATURELY after the first tick. Daemon
  // mode requires the timer to ref the event loop. Graceful shutdown
  // works via the stopRequested poll inside the loop (between sleeps),
  // not via timer unref.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Friendly humanized duration: 1s, 30s, 5m, 1h 23m, 2d 5h. Used in
 *  heartbeat notification titles and `engine status` output. Exported
 *  for testing the formatting in isolation. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Pure helper for tests + the `engine status` CLI — given a current time
 *  and a worker's lastTickAt, how stale is it? Returns the diff in seconds. */
export function tickStalenessSeconds(lastTickAt: string | null, now: Date = new Date()): number | null {
  if (!lastTickAt) return null;
  const t = Date.parse(lastTickAt);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 1000);
}

/** Holder shape for the engine lock — re-exported so consumers (doctor,
 *  the CLI) can probe whether the engine is running and identify the
 *  holder pid + start time. */
export type EngineLockHolder = LockHolder;
