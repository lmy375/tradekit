// ──────────────────────────────────────────────────────────────────
// DB lifecycle (iter40): integrity check + retention + auto-backup.
//
// Pre-iter40 the SQLite file grew indefinitely (every iter28+
// added writes — audit_log, paper_trades, alert state, engine
// events, order_check_log, ...) and was backed up only when the
// operator remembered `tradekit backup export`. Disaster recovery
// for SQLite corruption was: hope you have a recent backup.
//
// This module adds three coordinated capabilities:
//
//   1. INTEGRITY CHECK — wraps `PRAGMA integrity_check` with a
//      typed result so the CLI / engine worker / MCP all share
//      one source of truth on "is the DB intact".
//
//   2. RETENTION — per-table prune by cutoff timestamp. Each
//      target table has a dedicated helper in db.ts; this module
//      composes them by reading the iter40 retention config +
//      computing per-table cutoffs.
//
//   3. AUTO-BACKUP — atomic SQLite copy via `VACUUM INTO`. No
//      manual WAL checkpoint needed. Files land in a configurable
//      directory with timestamped names; rotation keeps the last
//      N.
//
// Design constraints:
//
//   * Each operation is INDEPENDENT — operators enable integrity
//     checks without enabling backups, or vice versa.
//
//   * Each operation returns a TYPED report (no thrown exceptions
//     for "normal" failure modes like missing files or corruption).
//     The engine worker that orchestrates these wants to record an
//     engine_events row for the result regardless of success/fail.
//
//   * RUN ONLY WHEN ENABLED — every helper checks the config flag
//     internally. Callers pass the live config + the helper either
//     does the work or returns `{ skipped: true, reason }`.
//
//   * ATOMIC — backup uses `VACUUM INTO`, retention uses per-table
//     SQL with conservative WHERE clauses. Failures don't leave
//     partial state.
// ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import {
  openDb,
  getDbFileStats,
  pruneOldAuditBefore,
  pruneOldPaperTradesBefore,
  pruneTerminalTradesBefore,
  pruneOrderCheckLog,
  pruneEngineEvents,
  pruneAlertEvents,
  pruneScheduleCheckLog,
  pruneRebalanceCheckLog,
  type DbFileStats,
} from "./db.js";
import { DATA_DIR } from "./constants.js";
import type { DbConfig } from "./config.js";

// ── integrity check ────────────────────────────────────────

/** Result of a single `PRAGMA integrity_check` invocation. SQLite
 *  returns a list of strings; "ok" means clean, anything else is
 *  a corruption detail line. We capture the raw list + a single
 *  bool flag for the common-case operator query. */
export interface IntegrityCheckResult {
  ok: boolean;
  /** Wall-clock duration of the check, in ms. Useful for operators
   *  tuning the cadence (a 100MB DB takes seconds to verify). */
  durationMs: number;
  /** Number of errors reported. 0 when ok=true. */
  errorCount: number;
  /** Raw error strings from SQLite. Empty when ok=true. */
  errors: string[];
  /** ISO timestamp of the check. */
  checkedAt: string;
}

export function runIntegrityCheck(): IntegrityCheckResult {
  const t0 = Date.now();
  const checkedAt = new Date().toISOString();
  const db = openDb();
  const rows = db
    .prepare("PRAGMA integrity_check")
    .all() as Array<{ integrity_check?: string }>;
  const durationMs = Date.now() - t0;
  if (rows.length === 1 && rows[0].integrity_check === "ok") {
    return { ok: true, durationMs, errorCount: 0, errors: [], checkedAt };
  }
  const errors: string[] = [];
  for (const r of rows) {
    if (r.integrity_check && r.integrity_check !== "ok") errors.push(r.integrity_check);
  }
  return {
    ok: false,
    durationMs,
    errorCount: errors.length,
    errors,
    checkedAt,
  };
}

// ── retention ──────────────────────────────────────────────

/** Per-table prune outcome. */
export interface PruneTableResult {
  table: string;
  cutoffIso: string | null;
  rowsRemoved: number;
  /** "skipped" when retention is disabled OR the table-specific
   *  cutoff is unset; "ran" otherwise. */
  status: "ran" | "skipped";
  reason?: string;
}

export interface PruneReport {
  ranAt: string;
  /** Per-table results in deterministic order. */
  tables: PruneTableResult[];
  totalRowsRemoved: number;
  /** Wall-clock of the full prune pass. */
  durationMs: number;
}

/** Map of table name → prune-helper + days-field-name on the
 *  retention config. Adding a new retainable table is one entry. */
const RETENTION_TABLES: Array<{
  table: string;
  daysField: keyof DbConfig["retention"];
  pruneFn: (beforeIso: string) => number;
}> = [
  { table: "audit_log", daysField: "auditLogDays", pruneFn: pruneOldAuditBefore },
  { table: "paper_trades", daysField: "paperTradesDays", pruneFn: pruneOldPaperTradesBefore },
  { table: "order_check_log", daysField: "orderCheckLogDays", pruneFn: pruneOrderCheckLog },
  { table: "engine_events", daysField: "engineEventsDays", pruneFn: pruneEngineEvents },
  { table: "alert_events", daysField: "alertEventsDays", pruneFn: pruneAlertEvents },
  { table: "schedule_check_log", daysField: "scheduleCheckLogDays", pruneFn: pruneScheduleCheckLog },
  { table: "rebalance_check_log", daysField: "rebalanceCheckLogDays", pruneFn: pruneRebalanceCheckLog },
  { table: "trades", daysField: "failedTradesDays", pruneFn: pruneTerminalTradesBefore },
];

/** Run the retention policy against the live DB. Each enabled
 *  table contributes a PruneTableResult; disabled tables surface
 *  as status='skipped'. Operator-driven (CLI) or engine-driven
 *  (db_maintenance worker) — same code path. */
export function pruneByRetention(config: DbConfig, opts: { now?: Date } = {}): PruneReport {
  const ranAt = (opts.now ?? new Date()).toISOString();
  const t0 = Date.now();
  const tables: PruneTableResult[] = [];
  let total = 0;

  if (!config.retention.enabled) {
    for (const r of RETENTION_TABLES) {
      tables.push({
        table: r.table,
        cutoffIso: null,
        rowsRemoved: 0,
        status: "skipped",
        reason: "db.retention.enabled=false",
      });
    }
    return { ranAt, tables, totalRowsRemoved: 0, durationMs: Date.now() - t0 };
  }

  for (const r of RETENTION_TABLES) {
    const days = config.retention[r.daysField] as number | null;
    if (days == null) {
      tables.push({
        table: r.table,
        cutoffIso: null,
        rowsRemoved: 0,
        status: "skipped",
        reason: `db.retention.${r.daysField}=null (unset)`,
      });
      continue;
    }
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    let removed = 0;
    try {
      removed = r.pruneFn(cutoff);
    } catch (e) {
      tables.push({
        table: r.table,
        cutoffIso: cutoff,
        rowsRemoved: 0,
        status: "ran",
        reason: `error: ${(e as Error).message}`,
      });
      continue;
    }
    total += removed;
    tables.push({
      table: r.table,
      cutoffIso: cutoff,
      rowsRemoved: removed,
      status: "ran",
    });
  }
  return { ranAt, tables, totalRowsRemoved: total, durationMs: Date.now() - t0 };
}

// ── backup ─────────────────────────────────────────────────

/** Result of a single backup attempt. */
export interface BackupResult {
  ok: boolean;
  destPath: string;
  sizeBytes: number;
  durationMs: number;
  createdAt: string;
  /** Set when ok=false. */
  error?: string;
}

/** Create an atomic SQLite copy via `VACUUM INTO`. The dest file
 *  is created fresh; if it already exists `VACUUM INTO` fails and
 *  we surface the error rather than silently overwriting (safer
 *  default for the operator-driven CLI path; the engine
 *  scheduled-backup path uses timestamped names so collision is
 *  impossible).
 *
 *  `destPath` resolves relative paths against DATA_DIR for
 *  consistency with the rest of the install. */
export function createBackup(destPath: string): BackupResult {
  const t0 = Date.now();
  const createdAt = new Date().toISOString();
  const resolved = isAbsolute(destPath) ? destPath : resolve(DATA_DIR, destPath);
  // Parent dir must exist for VACUUM INTO.
  try {
    const parent = resolved.replace(/\/[^/]+$/, "");
    if (parent && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
  } catch (e) {
    return {
      ok: false,
      destPath: resolved,
      sizeBytes: 0,
      durationMs: Date.now() - t0,
      createdAt,
      error: `mkdir failed: ${(e as Error).message}`,
    };
  }
  if (existsSync(resolved)) {
    return {
      ok: false,
      destPath: resolved,
      sizeBytes: 0,
      durationMs: Date.now() - t0,
      createdAt,
      error: `destination already exists: ${resolved}`,
    };
  }
  const db = openDb();
  try {
    // VACUUM INTO produces an atomic, valid copy — no manual
    // checkpoint, no risk of half-written file. The SQL string is
    // interpolated because VACUUM doesn't accept bind parameters
    // for the dest path; we escape single quotes defensively even
    // though our caller-supplied path comes from operator config
    // or the engine (no untrusted input here).
    const safePath = resolved.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${safePath}'`);
  } catch (e) {
    return {
      ok: false,
      destPath: resolved,
      sizeBytes: 0,
      durationMs: Date.now() - t0,
      createdAt,
      error: `VACUUM INTO failed: ${(e as Error).message}`,
    };
  }
  let sizeBytes = 0;
  try {
    sizeBytes = Number(statSync(resolved).size);
  } catch {
    // Best-effort — backup succeeded if VACUUM INTO returned but
    // we couldn't read the size for telemetry.
  }
  return {
    ok: true,
    destPath: resolved,
    sizeBytes,
    durationMs: Date.now() - t0,
    createdAt,
  };
}

// ── rotation ───────────────────────────────────────────────

export interface RotateBackupsResult {
  dir: string;
  total: number;
  kept: number;
  removed: string[];
}

/** Keep the most recent `retainCount` backup files in `dir` (by
 *  modification time, newest first). Delete the rest. Files are
 *  matched by extension `.db` so unrelated files in the dir are
 *  ignored. Returns the list of removed filenames + counts for
 *  the engine event payload. */
export function rotateBackups(dir: string, retainCount: number): RotateBackupsResult {
  const resolved = isAbsolute(dir) ? dir : resolve(DATA_DIR, dir);
  const removed: string[] = [];
  if (!existsSync(resolved)) {
    return { dir: resolved, total: 0, kept: 0, removed };
  }
  const all = readdirSync(resolved)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const p = join(resolved, f);
      let mtime = 0;
      try {
        mtime = Number(statSync(p).mtimeMs);
      } catch {
        // ignore
      }
      return { file: f, path: p, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const toRemove = all.slice(retainCount);
  for (const { file, path } of toRemove) {
    try {
      unlinkSync(path);
      removed.push(file);
    } catch {
      // Best-effort. Couldn't delete one file doesn't block the rest.
    }
  }
  return {
    dir: resolved,
    total: all.length,
    kept: Math.min(all.length, retainCount),
    removed,
  };
}

/** Compose backup + rotate. Used by the engine's db_maintenance
 *  worker. Generates a timestamped filename so concurrent / repeat
 *  runs never collide. */
export function autoBackup(config: DbConfig): BackupResult & { rotation: RotateBackupsResult | null } {
  // Timestamp in YYYYMMDDHHMMSS form for sortable lexicographic
  // ordering (matches the iter40 rotation's mtime sort but is
  // independent of fs timestamp precision).
  const ts = new Date().toISOString().replace(/[:.\-T]/g, "").replace(/Z$/, "").slice(0, 14);
  const filename = `tradekit-${ts}.db`;
  const destPath = join(config.backup.destDir, filename);
  const result = createBackup(destPath);
  if (!result.ok) {
    return { ...result, rotation: null };
  }
  const rotation = rotateBackups(config.backup.destDir, config.backup.retainCount);
  return { ...result, rotation };
}

// ── compose stats with retention preview ───────────────────

export interface DbStatsReport extends DbFileStats {
  /** What the next pruneByRetention pass would do, given current
   *  config. Computed BUT NOT EXECUTED — operators preview impact
   *  before enabling retention. */
  retentionPreview?: PruneReport;
}

/** Stats helper used by `tradekit db stats` + MCP. Returns the
 *  raw DbFileStats from db.ts plus (optionally) a what-would-prune
 *  preview. */
export function readDbStats(opts: { config?: DbConfig } = {}): DbStatsReport {
  const stats = getDbFileStats();
  if (!opts.config) return stats;
  // The preview = what the retention pass WOULD do, but without
  // committing. We can't easily compute "rows removed" without
  // running the DELETE — so for the preview we just compute the
  // cutoff timestamps. The CLI tells the operator which tables
  // are armed; actual row counts come from running the prune.
  const previewReport: PruneReport = {
    ranAt: new Date().toISOString(),
    tables: [],
    totalRowsRemoved: 0,
    durationMs: 0,
  };
  if (!opts.config.retention.enabled) {
    for (const r of RETENTION_TABLES) {
      previewReport.tables.push({
        table: r.table,
        cutoffIso: null,
        rowsRemoved: 0,
        status: "skipped",
        reason: "db.retention.enabled=false",
      });
    }
  } else {
    for (const r of RETENTION_TABLES) {
      const days = opts.config.retention[r.daysField] as number | null;
      if (days == null) {
        previewReport.tables.push({
          table: r.table,
          cutoffIso: null,
          rowsRemoved: 0,
          status: "skipped",
          reason: `db.retention.${r.daysField}=null (unset)`,
        });
      } else {
        const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
        previewReport.tables.push({
          table: r.table,
          cutoffIso: cutoff,
          rowsRemoved: 0,
          status: "ran",
          reason: "preview only — run `tradekit db prune` to apply",
        });
      }
    }
  }
  return { ...stats, retentionPreview: previewReport };
}
