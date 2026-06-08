// CLI surface for the unified engine supervisor.
//
//   tradekit engine run [--once] [--workers orders,schedules,reconcile]
//                       [--dry-run] [--pass <pw>] [--strict] [--json]
//   tradekit engine status [--json]
//
// `engine run` is the production deployment unit — one process that ticks
// orders + schedules + reconcile on their independent cadences. Pass
// --once to do a single round (useful in a cron job) or omit for the
// long-running daemon mode (the natural systemd / container pattern).
//
// `engine status` reads ~/.tradekit/.engine.status.json (written by the
// supervisor on every tick) so operators can answer "what's the engine
// doing right now?" from any shell, without an IPC channel.

import { ToolError } from "../errors.js";
import { loadConfig, type EngineWorkerName } from "../config.js";
import {
  runEngineSupervisor,
  readEngineStatus,
  formatDuration,
  tickStalenessSeconds,
} from "../engine.js";
import {
  makeCliLogger,
  printJson,
  requirePassword,
  subcommandError,
  parseIntFlag,
  prompt,
} from "./helpers.js";
import {
  lockEngine,
  unlockEngine,
  getEngineLockState,
  isEngineLocked,
} from "../engineLock.js";

// ── helpers ──────────────────────────────────────────────────

const VALID_WORKERS: ReadonlyArray<EngineWorkerName> = ["orders", "schedules", "reconcile"];

function parseWorkersFlag(raw: string | undefined): EngineWorkerName[] | undefined {
  if (raw == null) return undefined;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  for (const w of parsed) {
    if (!VALID_WORKERS.includes(w as EngineWorkerName)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Unknown worker "${w}" in --workers. Valid: ${VALID_WORKERS.join(", ")}.`,
        { details: { provided: w, valid: VALID_WORKERS } },
      );
    }
  }
  return parsed as EngineWorkerName[];
}

// ── engine run ───────────────────────────────────────────────

export async function engineRunCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const workers = parseWorkersFlag(flags["workers"]);
  const dryRun = flags["dry-run"] === "true";
  const once = flags["once"] === "true";
  const strict = flags["strict"] === "true";
  const logger = makeCliLogger(flags);
  // Metrics listener: opt-in via --metrics-port. Bound to loopback by
  // default (the Prometheus convention); operators expose externally
  // via firewall + reverse proxy when needed. Skipped automatically
  // when --once is set — a one-shot tick doesn't justify spinning up
  // an HTTP listener for a single scrape window.
  const metricsPort = flags["metrics-port"]
    ? parseIntFlag(flags["metrics-port"], "--metrics-port", { min: 1, max: 65_535 })
    : undefined;
  const metricsHost = flags["metrics-host"];
  if (metricsPort != null && once) {
    throw new ToolError(
      "INVALID_PARAMS",
      "--metrics-port is incompatible with --once (the listener would close before the first scrape). Drop --once for daemon mode.",
    );
  }

  // Password handling: orders / schedules need to sign on a fire. We
  // require it eagerly so the operator finds out at startup, not when
  // the first tick tries to load the wallet.
  const needsPassword = !dryRun && (
    !workers || workers.some((w) => w !== "reconcile")
  );
  let password: string | undefined;
  if (needsPassword) {
    if (flags["pass"]) password = flags["pass"];
    else if (process.env.WALLET_PASS) password = process.env.WALLET_PASS;
    else if (process.stdin.isTTY) password = await requirePassword(flags);
    else {
      // Non-TTY (cron, systemd) without WALLET_PASS — fail fast with a
      // clear remediation. The engine itself would refuse seconds later
      // anyway, but the CLI message names the env var explicitly.
      throw new ToolError(
        "WALLET_LOCKED",
        "Engine signing workers (orders, schedules) need a wallet password. Set WALLET_PASS in your environment or pass --pass (or --dry-run / --workers reconcile to skip signing).",
      );
    }
  }

  // Pre-run advisory: tell the operator what's about to start. Especially
  // useful for the daemon-mode case where the next thing they see might
  // be a long pause before the first tick.
  if (flags["json"] !== "true") {
    const activeWorkers = workers ?? VALID_WORKERS.filter((w) => config.engine.workers[w].enabled);
    const intervals = activeWorkers.map((w) => `${w}@${config.engine.workers[w].intervalMs / 1000}s`).join("  ");
    const heartbeatNote = config.engine.heartbeatIntervalMs > 0
      ? `, heartbeat every ${formatDuration(config.engine.heartbeatIntervalMs)}`
      : ", heartbeat disabled";
    const modeNote = once ? "[--once, single round]" : "[daemon mode — ctrl-c to stop]";
    const dryNote = dryRun ? "  [DRY-RUN]" : "";
    console.error(`engine starting (pid ${process.pid}) ${modeNote}${dryNote}`);
    console.error(`  workers: ${intervals}`);
    console.error(`  notifications: ${(config.notifications?.channels ?? []).length} channel(s)${heartbeatNote}`);
    if (metricsPort != null) {
      console.error(`  metrics: http://${metricsHost ?? "127.0.0.1"}:${metricsPort}/metrics  (loopback by default)`);
    }
    console.error("");
  }

  const result = await runEngineSupervisor({
    workers,
    password,
    dryRun,
    maxTicks: once ? 1 : undefined,
    logger,
    metricsPort,
    metricsHost,
  });

  if (flags["json"] === "true") {
    printJson({ ok: !result.fatal, ...result });
  } else {
    console.error("");
    console.error(`engine stopped (uptime ${formatDuration(result.uptimeMs)}, reason: ${result.reason})`);
    for (const w of result.workers) {
      const failRate = w.ticks > 0 ? ((w.failures / w.ticks) * 100).toFixed(1) : "0.0";
      console.error(`  ${w.name.padEnd(10)} ticks=${w.ticks}  ok=${w.successes}  fail=${w.failures}  (${failRate}% fail-rate)`);
    }
    if (result.fatal) {
      console.error("");
      console.error(`FATAL: ${result.fatal}`);
    }
  }

  if (strict && (result.fatal || result.workers.some((w) => w.failures > 0))) {
    process.exitCode = 1;
  }
}

// ── engine status ────────────────────────────────────────────

export async function engineStatusCommand(flags: Record<string, string>) {
  const status = readEngineStatus();
  if (flags["json"] === "true") {
    if (!status) {
      printJson({ ok: false, running: false, message: "No engine has ever run on this install (no status file)." });
      return;
    }
    // Augment with derived freshness signals so JSON consumers don't have
    // to recompute them client-side.
    const augmented = {
      ok: true,
      running: !status.stopping,
      pid: status.pid,
      pidAlive: pidLikelyAlive(status.pid),
      startedAt: status.startedAt,
      updatedAt: status.updatedAt,
      uptimeSeconds: Math.floor((Date.now() - Date.parse(status.startedAt)) / 1000),
      stalenessSeconds: tickStalenessSeconds(status.updatedAt),
      workers: status.workers.map((w) => ({
        ...w,
        stalenessSeconds: tickStalenessSeconds(w.lastTickAt),
      })),
    };
    printJson(augmented);
    return;
  }
  if (!status) {
    console.log("Engine has never run on this install (no status file at ~/.tradekit/.engine.status.json).");
    console.log("Start it with: tradekit engine run");
    return;
  }
  const alive = pidLikelyAlive(status.pid);
  const startedAt = Date.parse(status.startedAt);
  const uptime = Date.now() - startedAt;
  // Four-state badge:
  //   alive + !stopping   → ● RUNNING (typical daemon mode)
  //   alive + stopping    → ⌛ STOPPING (drain in progress)
  //   !alive + stopping   → ✓ STOPPED (clean prior exit, e.g. --once)
  //   !alive + !stopping  → ✕ CRASHED (pid gone without setting stopping)
  const headBadge =
    alive && !status.stopping
      ? "● RUNNING"
      : alive && status.stopping
      ? "⌛ STOPPING"
      : !alive && status.stopping
      ? "✓ STOPPED (clean prior exit)"
      : "✕ CRASHED (pid gone without graceful shutdown)";
  console.log(`Engine ${headBadge}`);
  console.log(`  pid: ${status.pid}${alive ? "" : "  (dead)"}    started: ${status.startedAt}  (uptime ${formatDuration(uptime)})`);
  console.log(`  status file last updated: ${formatRelativeAge(status.updatedAt)}`);
  console.log("");
  console.log(`Workers (${status.workers.length}):`);
  for (const w of status.workers) {
    const failRate = w.ticks > 0 ? ((w.failures / w.ticks) * 100).toFixed(1) : "0.0";
    const lastBit = w.lastTickAt ? formatRelativeAge(w.lastTickAt) : "never";
    const nextBit = w.nextTickDueAt ? formatRelativeAge(w.nextTickDueAt) : "—";
    const errBit = w.lastError ? `  ⚠ ${w.lastError}` : "";
    // Iter33: prepend a health badge so an operator sees degraded
    // workers immediately when running `engine status`.
    const healthBadge = w.degraded ? "⚠ " : "● ";
    console.log(`  ${healthBadge}${w.name.padEnd(10)} interval=${(w.intervalMs / 1000).toFixed(0)}s  ticks=${w.ticks}  ok=${w.successes}  fail=${w.failures} (${failRate}%)  last=${lastBit}  next=${nextBit}${errBit}`);
    // Iter33: secondary line — backoff state + tick-timing percentiles
    // when present. Skipped when there's no data yet (fresh start).
    if (w.degraded || (w.tickTiming && w.tickTiming.count > 0)) {
      const parts: string[] = [];
      if (w.degraded) {
        parts.push(
          `BACKOFF: ${w.consecutiveFailures} consecutive failures → effective interval ${(w.effectiveIntervalMs / 1000).toFixed(0)}s`,
        );
      }
      if (w.tickTiming && w.tickTiming.count > 0) {
        parts.push(
          `tick time: avg ${w.tickTiming.avgMs.toFixed(0)}ms · p50 ${w.tickTiming.p50Ms.toFixed(0)} · p95 ${w.tickTiming.p95Ms.toFixed(0)} · max ${w.tickTiming.maxMs.toFixed(0)}`,
        );
      }
      for (const line of parts) console.log(`    ${line}`);
    }
  }
}

function formatRelativeAge(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 0) {
    const abs = -secs;
    if (abs < 60) return `in ${abs}s`;
    if (abs < 3600) return `in ${Math.floor(abs / 60)}m`;
    if (abs < 86_400) return `in ${Math.floor(abs / 3600)}h`;
    return `in ${Math.floor(abs / 86_400)}d`;
  }
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

/** Liveness check via `process.kill(pid, 0)`. ESRCH = dead. Same primitive
 *  as processLock.isHolderDead but with no special-case for self (the
 *  status file holds OUR pid only when we're the supervisor; from a
 *  separate `engine status` invocation, the pid is always external). */
function pidLikelyAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM"; // exists, just not signalable by us
  }
}

// ── dispatch ─────────────────────────────────────────────────

// ── lock / unlock (iter28) ───────────────────────────────────

/**
 * Engage the global kill switch. All trading paths (orders engine,
 * schedules engine, rebalance engine, manual trades, post-fill
 * hooks) will reject until `engine unlock` runs. Existing trailing
 * stops continue to TICK (HWM tracking stays fresh) but skip the
 * FIRE path — so trails stay positioned correctly for when unlocked.
 *
 * Interactive confirmation required unless --yes (matches the
 * `cancel-tx` / `playbook destroy` defensive pattern). --reason
 * documents WHY in the audit log + ENGINE_LOCKED error details for
 * incident responders who hit the rejection later.
 */
export async function engineLockCommand(flags: Record<string, string>) {
  const reason = flags["reason"]?.trim() || null;
  const logger = makeCliLogger(flags);

  if (isEngineLocked()) {
    const state = getEngineLockState();
    if (flags["json"] === "true") {
      printJson({ ok: true, alreadyLocked: true, state });
    } else {
      console.log(`Engine is already locked.`);
      console.log(`  Reason:     ${state.reason ?? "(not specified)"}`);
      console.log(`  Locked at:  ${state.locked_at}`);
      console.log(`  Locked by:  ${state.locked_by}`);
    }
    logger.close();
    return;
  }

  if (flags["yes"] !== "true" && flags["json"] !== "true" && process.stdin.isTTY) {
    const reply = await prompt(
      `Lock engine — ALL trading paths (orders, schedules, rebalance, manual trades) will reject until unlocked. Type 'lock': `,
    );
    if (reply.trim().toLowerCase() !== "lock") {
      throw new ToolError("INVALID_PARAMS", "Lock aborted — confirmation phrase didn't match.");
    }
  }

  const config = loadConfig();
  try {
    const row = await lockEngine({
      reason, lockedBy: "cli",
      config, logger,
    });

    if (flags["json"] === "true") {
      printJson({ ok: true, locked: true, state: row });
    } else {
      console.log(`✕ Engine LOCKED`);
      console.log(`  Reason:     ${reason ?? "(not specified)"}`);
      console.log(`  Locked at:  ${row.locked_at}`);
      console.log(`  Locked by:  ${row.locked_by}`);
      console.log(``);
      console.log(`All trading paths will reject with ENGINE_LOCKED until you run:`);
      console.log(`  tradekit engine unlock`);
    }
  } finally {
    logger.close();
  }
}

/**
 * Clear the kill switch. The engine resumes on the next tick (or
 * immediately for manual trades). Idempotent — unlocking an already-
 * unlocked engine is a no-op.
 */
export async function engineUnlockCommand(flags: Record<string, string>) {
  const logger = makeCliLogger(flags);

  if (!isEngineLocked()) {
    if (flags["json"] === "true") {
      printJson({ ok: true, alreadyUnlocked: true });
    } else {
      console.log(`Engine is not locked. Nothing to do.`);
    }
    logger.close();
    return;
  }

  if (flags["yes"] !== "true" && flags["json"] !== "true" && process.stdin.isTTY) {
    const state = getEngineLockState();
    const reply = await prompt(
      `Unlock engine (locked since ${state.locked_at}, reason: ${state.reason ?? "n/a"}). Type 'unlock': `,
    );
    if (reply.trim().toLowerCase() !== "unlock") {
      throw new ToolError("INVALID_PARAMS", "Unlock aborted — confirmation phrase didn't match.");
    }
  }

  const config = loadConfig();
  try {
    const row = await unlockEngine({ config, logger, unlockedBy: "cli" });
    if (flags["json"] === "true") {
      printJson({ ok: true, unlocked: true, state: row });
    } else {
      console.log(`● Engine UNLOCKED — trading resumed`);
    }
  } finally {
    logger.close();
  }
}

export async function engineCommand(
  action: string | undefined,
  flags: Record<string, string>,
) {
  switch (action) {
    case "run":    await engineRunCommand(flags); break;
    case "status": await engineStatusCommand(flags); break;
    case "lock":   await engineLockCommand(flags); break;
    case "unlock": await engineUnlockCommand(flags); break;
    case "events": await engineEventsCommand(flags); break;
    default:
      throw subcommandError("engine", action, ["run", "status", "lock", "unlock", "events"]);
  }
}

/** Iter39: `tradekit engine events [--since 4h] [--types ...] [--severity ...] [--worker X] [--limit N] [--json]`
 *
 *  Read-only forensic view of the v26 engine_events table.
 *  Persistent state transitions: engine.started, engine.stopped,
 *  engine.lock, engine.unlock, worker.degraded, worker.recovered,
 *  config.reloaded, config.reload_failed. Survives process
 *  restarts (vs notifications which are transient).
 */
export async function engineEventsCommand(flags: Record<string, string>): Promise<void> {
  const { listEngineEvents } = await import("../db.js");
  const { parseSinceDuration } = await import("../timeline.js");
  const validTypes = [
    "engine.started", "engine.stopped",
    "engine.lock", "engine.unlock",
    "worker.degraded", "worker.recovered",
    "config.reloaded", "config.reload_failed",
  ];

  let sinceIso: string | undefined;
  if (flags["since"]) {
    const parsed = parseSinceDuration(flags["since"]);
    if (!parsed) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--since must be a duration (4h, 30m, 2d) or ISO timestamp (got "${flags["since"]}").`,
      );
    }
    sinceIso = parsed;
  } else {
    // Default: last 24h.
    sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  }
  let untilIso: string | undefined;
  if (flags["until"]) {
    const t = Date.parse(flags["until"]);
    if (!Number.isFinite(t)) {
      throw new ToolError("INVALID_PARAMS", `--until must be ISO-8601 (got "${flags["until"]}").`);
    }
    untilIso = new Date(t).toISOString();
  }

  let typeFilter: string[] | undefined;
  if (flags["types"]) {
    typeFilter = flags["types"].split(",").map((s) => s.trim()).filter(Boolean);
    for (const t of typeFilter) {
      if (!validTypes.includes(t)) {
        throw new ToolError(
          "INVALID_PARAMS",
          `--types includes unknown "${t}"; valid: ${validTypes.join(", ")}.`,
        );
      }
    }
  }

  let minSeverity: "info" | "warn" | "critical" | undefined;
  if (flags["severity"]) {
    if (flags["severity"] !== "info" && flags["severity"] !== "warn" && flags["severity"] !== "critical") {
      throw new ToolError("INVALID_PARAMS", `--severity must be info|warn|critical (got "${flags["severity"]}").`);
    }
    minSeverity = flags["severity"];
  }

  const limit = flags["limit"] ? parseInt(flags["limit"], 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ToolError("INVALID_PARAMS", `--limit must be a positive integer (got "${flags["limit"]}").`);
  }

  // If types[] is set, query each type union and merge — DB helper
  // takes one event_type or one prefix. For multi-type filters,
  // post-filter in memory.
  let rows = listEngineEvents({
    sinceIso,
    untilIso,
    minSeverity,
    workerName: flags["worker"] || undefined,
    limit: Math.max(limit, typeFilter ? limit * 4 : limit),
  });
  if (typeFilter && typeFilter.length > 0) {
    const set = new Set(typeFilter);
    rows = rows.filter((r) => set.has(r.event_type));
  }
  rows = rows.slice(0, limit);

  if (flags["json"] === "true") {
    printJson({ ok: true, count: rows.length, since: sinceIso, until: untilIso ?? null, events: rows });
    return;
  }

  if (rows.length === 0) {
    console.log("No engine events in the requested window.");
    console.log("");
    console.log("Default window is the last 24h. Try:");
    console.log("  tradekit engine events --since 7d");
    console.log("  tradekit engine events --since 24h --types worker.degraded,worker.recovered");
    return;
  }

  const cCount = rows.filter((r) => r.severity === "critical").length;
  const wCount = rows.filter((r) => r.severity === "warn").length;
  console.log(`Engine events (${rows.length} rows, since ${sinceIso}):`);
  console.log(`  ${cCount} critical · ${wCount} warn · ${rows.length - cCount - wCount} info`);
  console.log("");
  for (const r of rows) {
    const badge = r.severity === "critical" ? "✕" : r.severity === "warn" ? "⚠" : "·";
    const t = r.timestamp.replace(/\.\d{3}Z$/, "Z").replace(/T/, " ");
    const ev = r.event_type.padEnd(22);
    const worker = r.worker_name ? `[${r.worker_name}] ` : "";
    const fields = r.fields_json ? JSON.parse(r.fields_json) : {};
    const summary = summarizeRow(r.event_type, worker, fields);
    console.log(`  ${badge} ${t} ${ev} ${summary}`);
  }
  if (rows.length === limit) {
    console.log("");
    console.log(`  (output truncated to --limit ${limit}; pass higher to see more)`);
  }
}

function summarizeRow(eventType: string, workerLabel: string, fields: Record<string, unknown>): string {
  switch (eventType) {
    case "engine.started": {
      const workers = (fields.workers as string[] | undefined)?.join(",") ?? "?";
      return `pid=${fields.pid ?? "?"} workers=${workers}`;
    }
    case "engine.stopped": {
      const uptime = typeof fields.uptimeMs === "number" ? `${Math.floor(fields.uptimeMs / 1000)}s` : "?";
      const fatal = fields.fatal ? ` fatal=${String(fields.fatal).slice(0, 40)}` : "";
      return `uptime=${uptime}${fatal}`;
    }
    case "engine.lock": {
      const reason = fields.reason ? `: ${String(fields.reason).slice(0, 50)}` : "";
      return `${workerLabel}locked by ${fields.lockedBy ?? "?"}${reason}`;
    }
    case "engine.unlock":
      return `${workerLabel}unlocked by ${fields.unlockedBy ?? "?"}`;
    case "worker.degraded":
      return `${workerLabel}consecutive=${fields.consecutiveFailures ?? "?"} effective=${fields.effectiveIntervalMs ?? "?"}ms`;
    case "worker.recovered":
      return `${workerLabel}after=${fields.afterFailures ?? "?"} fails`;
    case "config.reloaded":
      return `diff=${fields.diffCount ?? 0} critical=${fields.criticalCount ?? 0} warn=${fields.warnCount ?? 0}`;
    case "config.reload_failed":
      return `${String(fields.error ?? "").slice(0, 80)}`;
    default:
      return JSON.stringify(fields).slice(0, 100);
  }
}
