// ──────────────────────────────────────────────────────────────────
// Config hot-reload (iter35): atomic in-process Config swap on
// SIGHUP + pidfile-aware kick from CLI mutation commands.
//
// Why: pre-iter35, every config change required a full engine
// restart — re-decrypting the keystore (expensive scrypt cost),
// losing in-flight tick state, and briefly leaving trading
// unprotected during the restart window. Unix daemons have solved
// this for 30 years: SIGHUP reloads config atomically.
//
// Design:
//
//   1. `ConfigRef` wraps the live config in a getter/setter pair.
//      Workers read via `.get()` on each tick — a reload between
//      ticks is invisible (worker either uses fully old or fully
//      new config; never half).
//
//   2. `buildSighupHandler` returns the OS signal handler that
//      validates the new config, atomically swaps the ref, and
//      emits a `config.reloaded` notification with a structured
//      diff. Validation failure → keep old config, emit
//      `config.reload_failed`.
//
//   3. `kickRunningEngine` is the inverse: from a CLI mutation
//      command (config set / push / drop), find the running
//      supervisor's pid + send SIGHUP. No-op when there's no
//      running engine.
//
//   4. The notification body carries the iter35 preflight diff
//      so operators / agents see WHAT changed without diffing
//      config files manually.
// ──────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import { loadConfig, configSchema, type Config } from "./config.js";
import { tryNotify } from "./notify.js";
import { computeConfigImpact } from "./configPreflight.js";
import { recordConfigReloaded, recordConfigReloadFailed } from "./engineEvents.js";
import { DATA_DIR } from "./constants.js";

const ENGINE_STATUS_PATH = join(DATA_DIR, ".engine.status.json");

/** A mutable container for the active Config. Workers + supervisor
 *  read the live config on each tick via `.get()`. The signal
 *  handler is the only writer. */
export class ConfigRef {
  private current: Config;
  constructor(initial: Config) {
    this.current = initial;
  }
  get(): Config {
    return this.current;
  }
  /** Atomic swap. Caller is responsible for having already
   *  validated `next` via `configSchema.parse`. */
  set(next: Config): void {
    this.current = next;
  }
}

/** Optional gatherer for active-primitive state, used to enrich
 *  the reload notification with iter35 preflight impact. Passed in
 *  so this module stays decoupled from the DB layer (tests inject
 *  a fixed snapshot). */
export type ActiveStateProvider = () => import("./configPreflight.js").ActiveState | undefined;

export interface SighupHandlerArgs {
  ref: ConfigRef;
  logger: Logger;
  /** Where to read the new config from. Defaults to the
   *  loadConfig() path; tests override with a stub. */
  loadFn?: () => Config;
  /** Optional active-state provider for preflight enrichment. */
  stateProvider?: ActiveStateProvider;
  /** Override notification dispatch (tests). */
  notifyFn?: typeof tryNotify;
}

export interface ReloadResult {
  ok: boolean;
  /** Number of diffs the new config introduced. */
  diffCount: number;
  /** Critical-severity warnings the preflight surfaced. */
  criticalCount: number;
  /** Error message when ok=false. */
  error?: string;
}

/**
 * Construct a SIGHUP handler. Returns an async function the
 * supervisor wires up via `process.on("SIGHUP", handler)`. The
 * function is also exported so tests can invoke it directly without
 * sending real OS signals (which Vitest doesn't tolerate well in
 * test runners).
 */
export function buildSighupHandler(args: SighupHandlerArgs): () => Promise<ReloadResult> {
  const loadFn = args.loadFn ?? loadConfig;
  const notifyFn = args.notifyFn ?? tryNotify;
  return async () => {
    const oldConfig = args.ref.get();
    let next: Config;
    try {
      // loadFn may itself parse via configSchema (the production
      // loadConfig does). For tests + safety, re-validate.
      const raw = loadFn();
      next = configSchema.parse(raw);
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      const attemptedAt = new Date().toISOString();
      args.logger.error(`config reload: parse/validation failed; keeping old config: ${message}`);
      await notifyFn(
        {
          event: "config.reload_failed",
          severity: "critical",
          title: "Config reload failed — old config retained",
          body: message,
          fields: { error: message, pid: process.pid },
          dedupKey: `config.reload_failed:${process.pid}:${Date.now()}`,
        },
        oldConfig,
        args.logger,
      );
      // Iter39: durable event so operators investigating "why is
      // my config still old?" can find the failure post-restart.
      recordConfigReloadFailed({ attemptedAt, error: message, logger: args.logger });
      return { ok: false, diffCount: 0, criticalCount: 0, error: message };
    }

    const state = args.stateProvider?.();
    const impact = computeConfigImpact({ oldConfig, newConfig: next, state });

    // Atomic swap.
    args.ref.set(next);

    // Surface the impact in the notification body so operators
    // who only see Slack/Discord still know what just happened.
    const summary = impact.summary;
    const headline = summary.totalDiffs === 0
      ? "Config reloaded (no semantic changes)"
      : `Config reloaded (${summary.totalDiffs} change${summary.totalDiffs === 1 ? "" : "s"}: ${summary.criticalCount} critical, ${summary.warnCount} warn, ${summary.infoCount} info)`;

    args.logger.info(`config reload: ${headline}`);
    const severity =
      summary.criticalCount > 0 ? "critical" : summary.warnCount > 0 ? "warn" : "info";
    const reloadedAt = new Date().toISOString();
    await notifyFn(
      {
        event: "config.reloaded",
        severity,
        title: headline,
        body: impact.warnings
          .filter((w) => w.severity !== "info")
          .map((w) => `${w.severity.toUpperCase()}: ${w.message}`)
          .join("\n") || undefined,
        fields: {
          pid: process.pid,
          diffCount: summary.totalDiffs,
          critical: summary.criticalCount,
          warn: summary.warnCount,
          info: summary.infoCount,
          affectedOrders: summary.affectedOrders,
          affectedSchedules: summary.affectedSchedules,
        },
        dedupKey: `config.reloaded:${process.pid}:${reloadedAt.slice(0, 19)}`,
      },
      next, // Use the NEW config for notification routing (channels
            // may have changed in the same reload).
      args.logger,
    );
    // Iter39: durable config.reloaded event. Operators auditing
    // "when did someone change maxSlippageBps last week?" find
    // the row + the impact summary here, not in rotated Slack logs.
    recordConfigReloaded({
      reloadedAt,
      diffCount: summary.totalDiffs,
      criticalCount: summary.criticalCount,
      warnCount: summary.warnCount,
      infoCount: summary.infoCount,
      affectedOrders: summary.affectedOrders,
      affectedSchedules: summary.affectedSchedules,
      logger: args.logger,
    });

    return {
      ok: true,
      diffCount: summary.totalDiffs,
      criticalCount: summary.criticalCount,
    };
  };
}

// ── pidfile-aware kick (CLI side) ───────────────────────────

export interface KickResult {
  /** True when SIGHUP was successfully sent to a live engine. */
  delivered: boolean;
  /** Why nothing was delivered, when delivered=false. */
  reason?: "no_status_file" | "stale_pid" | "self" | "signal_error";
  /** The supervisor pid we read (when present). */
  pid?: number;
}

/**
 * Send SIGHUP to the running engine supervisor, if any. Reads the
 * pid from the status file written by iter11's engine. Best-effort:
 *
 *   - No status file → engine never ran on this install → no-op.
 *   - Pid not alive → stale status file from a crashed prior run →
 *     no-op (the next `engine run` will overwrite it).
 *   - Pid is us → don't signal ourselves (caller is INSIDE the
 *     engine process and shouldn't re-trigger its own handler).
 *   - process.kill threw → return signal_error.
 *
 * Tests inject `statusPath` + `signal` to assert behavior without
 * actually sending OS signals.
 */
export function kickRunningEngine(opts: {
  statusPath?: string;
  signalFn?: (pid: number, sig: NodeJS.Signals | 0) => void;
} = {}): KickResult {
  const path = opts.statusPath ?? ENGINE_STATUS_PATH;
  const signalFn = opts.signalFn ?? ((pid, sig) => process.kill(pid, sig));
  if (!existsSync(path)) {
    return { delivered: false, reason: "no_status_file" };
  }
  let pid: number;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
    if (typeof raw.pid !== "number") {
      return { delivered: false, reason: "stale_pid" };
    }
    pid = raw.pid;
  } catch {
    return { delivered: false, reason: "stale_pid" };
  }

  if (pid === process.pid) {
    return { delivered: false, reason: "self", pid };
  }
  // Liveness probe via signal 0 (POSIX standard idempotent test).
  try {
    signalFn(pid, 0);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return { delivered: false, reason: "stale_pid", pid };
    }
    if (code === "EPERM") {
      // Process exists but we can't signal it. That's odd in a
      // single-user setup but possible (different uid). Treat as
      // an explicit signal error so the CLI can surface it.
      return { delivered: false, reason: "signal_error", pid };
    }
    return { delivered: false, reason: "signal_error", pid };
  }
  // Deliver the real signal.
  try {
    signalFn(pid, "SIGHUP");
    return { delivered: true, pid };
  } catch {
    return { delivered: false, reason: "signal_error", pid };
  }
}
