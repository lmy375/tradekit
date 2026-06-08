// ──────────────────────────────────────────────────────────────────
// Engine events (iter39): typed constructors over the v26
// engine_events table. Every engine state transition that previously
// surfaced only as a transient notification now ALSO persists here,
// giving the iter36 timeline + `tradekit engine events` a durable
// source that survives process restarts.
//
// Design:
//
//   1. ONE typed constructor per event type. Compile-time guarantee
//      that the payload shape matches the event semantics + the
//      severity matches the event type's convention.
//
//   2. Every constructor is ERROR-SAFE — wraps `insertEngineEvent`
//      in try/catch + logs warn. A DB hiccup during
//      `engine.stopped` MUST NOT crash the supervisor's shutdown.
//      The notification system is the synchronous-required path
//      (tryNotify already swallows errors); engine_events is the
//      durable-but-best-effort companion.
//
//   3. The dedup_key for each event matches the corresponding
//      tryNotify() dedupKey when one exists. Operators
//      cross-referencing Slack notifications with DB rows can pair
//      them by key.
//
//   4. fields encodes the event-specific payload. The shape is
//      fixed per event-type via the typed constructors; readers
//      (timeline.ts, engine events CLI) can JSON.parse + type-narrow.
//
//   5. Process pid is always recorded — lets operators distinguish
//      concurrent processes + correlate with `engine status`.
// ──────────────────────────────────────────────────────────────────

import { insertEngineEvent } from "./db.js";
import type { Logger } from "./logger.js";

// ── public event type catalog ────────────────────────────────

/** The full set of event types we persist. Adding a new type
 *  requires extending this union + adding a typed constructor. */
export type EngineEventType =
  | "engine.started"
  | "engine.stopped"
  | "engine.lock"
  | "engine.unlock"
  | "worker.degraded"
  | "worker.recovered"
  | "config.reloaded"
  | "config.reload_failed";

/** Operator-facing severity floor. Matches the iter28+ notification
 *  severity model exactly. */
export type EngineEventSeverity = "info" | "warn" | "critical";

// ── error-safe wrapper ──────────────────────────────────────

/**
 * Write an engine event. Swallows DB errors + logs a warn —
 * never throws to the caller. This is deliberate: a write
 * failure during engine shutdown MUST NOT cascade.
 */
function safeRecord(
  args: Parameters<typeof insertEngineEvent>[0],
  logger: Logger,
): void {
  try {
    insertEngineEvent(args);
  } catch (e) {
    logger.warn(
      `engineEvents: failed to persist ${args.eventType}: ${(e as Error).message}`,
    );
  }
}

// ── engine lifecycle ────────────────────────────────────────

export interface RecordEngineStartedArgs {
  startedAt: string;
  workers: string[];
  dryRun: boolean;
  logger: Logger;
}

export function recordEngineStarted(args: RecordEngineStartedArgs): void {
  safeRecord(
    {
      timestamp: args.startedAt,
      eventType: "engine.started",
      severity: "info",
      pid: process.pid,
      fields: {
        workers: args.workers,
        dryRun: args.dryRun,
      },
      dedupKey: null, // engine.started fires once per supervisor; no dedup
    },
    args.logger,
  );
}

export interface RecordEngineStoppedArgs {
  startedAt: string;
  stoppedAt: string;
  uptimeMs: number;
  /** When non-null, the supervisor exited with a fatal error. */
  fatal?: string | null;
  /** When non-null, the signal that triggered shutdown. */
  stopSignal?: string | null;
  logger: Logger;
}

export function recordEngineStopped(args: RecordEngineStoppedArgs): void {
  const severity: EngineEventSeverity = args.fatal ? "critical" : "info";
  safeRecord(
    {
      timestamp: args.stoppedAt,
      eventType: "engine.stopped",
      severity,
      pid: process.pid,
      fields: {
        startedAt: args.startedAt,
        uptimeMs: args.uptimeMs,
        fatal: args.fatal ?? null,
        stopSignal: args.stopSignal ?? null,
      },
      dedupKey: null,
    },
    args.logger,
  );
}

// ── engine kill switch (iter28) ─────────────────────────────

export interface RecordEngineLockArgs {
  lockedAt: string;
  reason: string | null;
  lockedBy: string;
  logger: Logger;
}

export function recordEngineLock(args: RecordEngineLockArgs): void {
  safeRecord(
    {
      timestamp: args.lockedAt,
      eventType: "engine.lock",
      severity: "warn",
      pid: process.pid,
      fields: {
        reason: args.reason,
        lockedBy: args.lockedBy,
      },
      dedupKey: `engine.lock:${args.lockedAt}`,
    },
    args.logger,
  );
}

export interface RecordEngineUnlockArgs {
  unlockedAt: string;
  unlockedBy: string;
  /** ISO timestamp of the LOCK that this unlock pairs with, when
   *  known. NULL if iter28 didn't capture the prior lock. */
  pairedLockedAt: string | null;
  logger: Logger;
}

export function recordEngineUnlock(args: RecordEngineUnlockArgs): void {
  safeRecord(
    {
      timestamp: args.unlockedAt,
      eventType: "engine.unlock",
      severity: "info",
      pid: process.pid,
      fields: {
        unlockedBy: args.unlockedBy,
        pairedLockedAt: args.pairedLockedAt,
      },
      dedupKey: `engine.unlock:${args.unlockedAt}`,
    },
    args.logger,
  );
}

// ── per-worker resilience (iter33) ──────────────────────────

export interface RecordWorkerDegradedArgs {
  workerName: string;
  consecutiveFailures: number;
  effectiveIntervalMs: number;
  baseIntervalMs: number;
  lastError: string | null;
  logger: Logger;
}

export function recordWorkerDegraded(args: RecordWorkerDegradedArgs): void {
  safeRecord(
    {
      timestamp: new Date().toISOString(),
      eventType: "worker.degraded",
      severity: "warn",
      pid: process.pid,
      workerName: args.workerName,
      fields: {
        consecutiveFailures: args.consecutiveFailures,
        effectiveIntervalMs: args.effectiveIntervalMs,
        baseIntervalMs: args.baseIntervalMs,
        lastError: args.lastError,
      },
      // Mirror the iter33 notification dedupKey so operators
      // pairing notifications + this table find both rows.
      dedupKey: `engine.worker.degraded:${args.workerName}`,
    },
    args.logger,
  );
}

export interface RecordWorkerRecoveredArgs {
  workerName: string;
  afterFailures: number;
  tickDurationMs: number;
  baseIntervalMs: number;
  logger: Logger;
}

export function recordWorkerRecovered(args: RecordWorkerRecoveredArgs): void {
  // Mirror the iter33 notification's hour-bucketed dedup so
  // operators pairing rows find them.
  const hourBucket = new Date().toISOString().slice(0, 13);
  safeRecord(
    {
      timestamp: new Date().toISOString(),
      eventType: "worker.recovered",
      severity: "info",
      pid: process.pid,
      workerName: args.workerName,
      fields: {
        afterFailures: args.afterFailures,
        tickDurationMs: args.tickDurationMs,
        baseIntervalMs: args.baseIntervalMs,
      },
      dedupKey: `engine.worker.recovered:${args.workerName}:${hourBucket}`,
    },
    args.logger,
  );
}

// ── config hot-reload (iter35) ──────────────────────────────

export interface RecordConfigReloadedArgs {
  reloadedAt: string;
  diffCount: number;
  criticalCount: number;
  warnCount: number;
  infoCount: number;
  affectedOrders: number;
  affectedSchedules: number;
  logger: Logger;
}

export function recordConfigReloaded(args: RecordConfigReloadedArgs): void {
  // Severity matches the iter35 notification severity rule:
  // critical when any critical warnings, warn when warn-only,
  // info when only info-level changes.
  const severity: EngineEventSeverity =
    args.criticalCount > 0 ? "critical" : args.warnCount > 0 ? "warn" : "info";
  safeRecord(
    {
      timestamp: args.reloadedAt,
      eventType: "config.reloaded",
      severity,
      pid: process.pid,
      fields: {
        diffCount: args.diffCount,
        criticalCount: args.criticalCount,
        warnCount: args.warnCount,
        infoCount: args.infoCount,
        affectedOrders: args.affectedOrders,
        affectedSchedules: args.affectedSchedules,
      },
      // iter35 dedupKey was minute-bucketed; mirror.
      dedupKey: `config.reloaded:${process.pid}:${args.reloadedAt.slice(0, 19)}`,
    },
    args.logger,
  );
}

export interface RecordConfigReloadFailedArgs {
  attemptedAt: string;
  error: string;
  logger: Logger;
}

export function recordConfigReloadFailed(args: RecordConfigReloadFailedArgs): void {
  safeRecord(
    {
      timestamp: args.attemptedAt,
      eventType: "config.reload_failed",
      severity: "critical",
      pid: process.pid,
      fields: {
        error: args.error,
      },
      dedupKey: `config.reload_failed:${process.pid}:${Date.now()}`,
    },
    args.logger,
  );
}
