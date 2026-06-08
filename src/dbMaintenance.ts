// ──────────────────────────────────────────────────────────────────
// DB maintenance tick (iter40): orchestrates integrity-check +
// retention-prune + auto-backup for the engine's db_maintenance
// worker.
//
// The base worker tick runs at config.engine.workers.db_maintenance
// .intervalMs (default 1h). But each SUBTASK has its own configured
// cadence (config.db.{integrityCheck,backup}.intervalHours). This
// module tracks per-subtask last-run timestamps and gates each
// subtask on its independent schedule. Retention runs on every tick
// because it's idempotent + cheap when nothing's expired.
//
// Failures of any subtask are isolated:
//  - Recorded as a critical iter39 engine event for forensic history.
//  - Don't prevent other subtasks from running this tick.
//  - Don't crash the supervisor (the worker wrapper catches the
//    outer throw via the iter33 resilience layer).
// ──────────────────────────────────────────────────────────────────

import type { Logger } from "./logger.js";
import type { Config } from "./config.js";
import {
  runIntegrityCheck,
  pruneByRetention,
  autoBackup,
  type IntegrityCheckResult,
  type PruneReport,
  type BackupResult,
  type RotateBackupsResult,
} from "./dbLifecycle.js";
import { insertEngineEvent } from "./db.js";

/** Per-tick report — what ran, what skipped, with each subtask's
 *  result. Surfaced as the engine worker's `data` payload + so
 *  visible in `engine status`. */
export interface DbMaintenanceTickReport {
  tickAt: string;
  integrityCheck: { ran: boolean; result?: IntegrityCheckResult; reason?: string };
  retention: { ran: boolean; result?: PruneReport; reason?: string };
  backup: { ran: boolean; result?: (BackupResult & { rotation: RotateBackupsResult | null }); reason?: string };
}

/** Per-process subtask-cadence state. Resets on supervisor
 *  restart (acceptable: subtasks just run on the next tick after
 *  start). */
interface MaintenanceState {
  lastIntegrityCheckAt: number;
  lastBackupAt: number;
}

let state: MaintenanceState = {
  lastIntegrityCheckAt: 0,
  lastBackupAt: 0,
};

/** Reset state — exposed for tests so each test starts clean. */
export function resetMaintenanceState(): void {
  state = { lastIntegrityCheckAt: 0, lastBackupAt: 0 };
}

export function runDbMaintenanceTick(args: {
  config: Config;
  logger: Logger;
  nowFn?: () => Date;
}): DbMaintenanceTickReport {
  const now = (args.nowFn ?? (() => new Date()))();
  const nowMs = now.getTime();
  const dbCfg = args.config.db;

  // ── integrity check ──
  let integrity: DbMaintenanceTickReport["integrityCheck"] = { ran: false, reason: "disabled" };
  if (dbCfg.integrityCheck.enabled) {
    const intervalMs = dbCfg.integrityCheck.intervalHours * 3600 * 1000;
    const due = nowMs - state.lastIntegrityCheckAt >= intervalMs;
    if (!due) {
      integrity = { ran: false, reason: "not due" };
    } else {
      try {
        const result = runIntegrityCheck();
        state.lastIntegrityCheckAt = nowMs;
        integrity = { ran: true, result };
        if (!result.ok) {
          recordSafe({
            timestamp: now.toISOString(),
            eventType: "db.integrity_failed",
            severity: "critical",
            pid: process.pid,
            fields: {
              errorCount: result.errorCount,
              errors: result.errors.slice(0, 10),
              durationMs: result.durationMs,
            },
          }, args.logger);
          args.logger.error(`db_maintenance: integrity check FAILED with ${result.errorCount} error(s)`);
        }
      } catch (e) {
        integrity = { ran: false, reason: `error: ${(e as Error).message}` };
        recordSafe({
          timestamp: now.toISOString(),
          eventType: "db.integrity_failed",
          severity: "critical",
          pid: process.pid,
          fields: { error: (e as Error).message },
        }, args.logger);
      }
    }
  }

  // ── retention prune ──
  let retention: DbMaintenanceTickReport["retention"] = { ran: false, reason: "disabled" };
  if (dbCfg.retention.enabled) {
    try {
      const result = pruneByRetention(dbCfg, { now });
      retention = { ran: true, result };
      if (result.totalRowsRemoved > 0) {
        args.logger.info(
          `db_maintenance: pruned ${result.totalRowsRemoved} row(s) across ${result.tables.filter((t) => t.rowsRemoved > 0).length} table(s)`,
        );
      }
    } catch (e) {
      retention = { ran: false, reason: `error: ${(e as Error).message}` };
      recordSafe({
        timestamp: now.toISOString(),
        eventType: "db.prune_failed",
        severity: "warn",
        pid: process.pid,
        fields: { error: (e as Error).message },
      }, args.logger);
    }
  }

  // ── auto-backup ──
  let backup: DbMaintenanceTickReport["backup"] = { ran: false, reason: "disabled" };
  if (dbCfg.backup.enabled) {
    const intervalMs = dbCfg.backup.intervalHours * 3600 * 1000;
    const due = nowMs - state.lastBackupAt >= intervalMs;
    if (!due) {
      backup = { ran: false, reason: "not due" };
    } else {
      try {
        const result = autoBackup(dbCfg);
        state.lastBackupAt = nowMs;
        backup = { ran: true, result };
        if (!result.ok) {
          recordSafe({
            timestamp: now.toISOString(),
            eventType: "db.backup_failed",
            severity: "critical",
            pid: process.pid,
            fields: { error: result.error ?? "unknown", destPath: result.destPath },
          }, args.logger);
          args.logger.error(`db_maintenance: backup FAILED: ${result.error}`);
        } else {
          recordSafe({
            timestamp: now.toISOString(),
            eventType: "db.backup_ok",
            severity: "info",
            pid: process.pid,
            fields: {
              destPath: result.destPath,
              sizeBytes: result.sizeBytes,
              durationMs: result.durationMs,
              rotationKept: result.rotation?.kept ?? null,
              rotationRemoved: result.rotation?.removed.length ?? null,
            },
          }, args.logger);
        }
      } catch (e) {
        backup = { ran: false, reason: `error: ${(e as Error).message}` };
        recordSafe({
          timestamp: now.toISOString(),
          eventType: "db.backup_failed",
          severity: "critical",
          pid: process.pid,
          fields: { error: (e as Error).message },
        }, args.logger);
      }
    }
  }

  return { tickAt: now.toISOString(), integrityCheck: integrity, retention, backup };
}

/** Error-safe wrapper around insertEngineEvent. Same pattern as
 *  iter39 engineEvents.ts — DB failure during event recording
 *  must not cascade. */
function recordSafe(
  args: Parameters<typeof insertEngineEvent>[0],
  logger: Logger,
): void {
  try {
    insertEngineEvent(args);
  } catch (e) {
    logger.warn(`dbMaintenance: failed to persist ${args.eventType}: ${(e as Error).message}`);
  }
}
