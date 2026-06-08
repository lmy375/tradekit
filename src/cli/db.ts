// CLI surface for DB lifecycle (iter40):
//
//   tradekit db stats [--json]
//        Per-table row counts, file size (main + WAL + SHM), and
//        what the retention policy WOULD prune given current config.
//
//   tradekit db integrity-check [--json]
//        Wraps PRAGMA integrity_check. exit 1 on corruption.
//
//   tradekit db prune [--dry-run] [--json]
//        Apply the retention policy. --dry-run reports cutoffs
//        without DELETEing.
//
//   tradekit db backup [--dest PATH] [--json]
//        Atomic SQLite snapshot via VACUUM INTO. Defaults to a
//        timestamped file in the configured backup dir.
//
//   tradekit db rotate [--retain N] [--json]
//        Apply the rotation policy to the backup dir.

import { ToolError } from "../errors.js";
import { loadConfig } from "../config.js";
import {
  runIntegrityCheck,
  pruneByRetention,
  createBackup,
  rotateBackups,
  readDbStats,
} from "../dbLifecycle.js";
import { printJson, subcommandError } from "./helpers.js";
import { join } from "node:path";
import { DATA_DIR } from "../constants.js";

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

// ── db stats ────────────────────────────────────────────────

async function dbStatsCommand(flags: Record<string, string>): Promise<void> {
  const config = loadConfig();
  const stats = readDbStats({ config: config.db });

  if (flags["json"] === "true") {
    printJson({ ok: true, stats });
    return;
  }

  console.log(`DB stats: ${stats.path}`);
  console.log("");
  console.log(`  Disk:    main ${fmtBytes(stats.mainSizeBytes)} · WAL ${fmtBytes(stats.walSizeBytes)} · SHM ${fmtBytes(stats.shmSizeBytes)} · total ${fmtBytes(stats.totalSizeBytes)}`);
  console.log("");
  console.log("  Row counts:");
  // Sort by count descending so the heaviest tables surface first.
  const sorted = Object.entries(stats.rowCounts).sort((a, b) => b[1] - a[1]);
  for (const [table, count] of sorted) {
    if (count === 0) continue;
    console.log(`    ${table.padEnd(24)} ${count.toLocaleString()}`);
  }
  // List zero-count tables at the end for completeness.
  const zeros = sorted.filter(([_, c]) => c === 0).map(([t]) => t);
  if (zeros.length > 0) {
    console.log(`    (empty: ${zeros.join(", ")})`);
  }

  if (stats.retentionPreview) {
    console.log("");
    console.log("  Retention preview:");
    for (const t of stats.retentionPreview.tables) {
      if (t.status === "skipped") {
        console.log(`    ${t.table.padEnd(24)} skipped (${t.reason})`);
      } else {
        console.log(`    ${t.table.padEnd(24)} would prune rows older than ${t.cutoffIso}`);
      }
    }
    console.log("");
    console.log("  Run `tradekit db prune --dry-run` to see actual counts; `tradekit db prune` to apply.");
  }
}

// ── db integrity-check ──────────────────────────────────────

async function dbIntegrityCheckCommand(flags: Record<string, string>): Promise<void> {
  const result = runIntegrityCheck();
  if (flags["json"] === "true") {
    printJson({ ok: result.ok, result });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (result.ok) {
    console.log(`✓ DB integrity OK (${result.durationMs}ms)`);
    return;
  }
  console.log(`✕ DB integrity FAILED (${result.errorCount} error(s), ${result.durationMs}ms):`);
  for (const e of result.errors) {
    console.log(`  ${e}`);
  }
  process.exitCode = 1;
}

// ── db prune ────────────────────────────────────────────────

async function dbPruneCommand(flags: Record<string, string>): Promise<void> {
  const config = loadConfig();
  const dryRun = flags["dry-run"] === "true";

  if (dryRun) {
    // For dry-run we just read the stats preview — which already
    // computes cutoffs without running DELETE.
    const stats = readDbStats({ config: config.db });
    if (flags["json"] === "true") {
      printJson({ ok: true, dryRun: true, preview: stats.retentionPreview });
      return;
    }
    if (!stats.retentionPreview || stats.retentionPreview.tables.every((t) => t.status === "skipped")) {
      console.log("Retention is disabled or no per-table cutoffs are configured.");
      console.log("Set db.retention.enabled=true + at least one of {auditLogDays, paperTradesDays, ...} to use prune.");
      return;
    }
    console.log("Prune dry-run — what would happen:");
    for (const t of stats.retentionPreview.tables) {
      if (t.status === "skipped") {
        console.log(`  ${t.table.padEnd(24)} skipped (${t.reason})`);
      } else {
        console.log(`  ${t.table.padEnd(24)} would delete rows older than ${t.cutoffIso}`);
      }
    }
    return;
  }

  const result = pruneByRetention(config.db);
  if (flags["json"] === "true") {
    printJson({ ok: true, report: result });
    return;
  }
  if (result.totalRowsRemoved === 0 && result.tables.every((t) => t.status === "skipped")) {
    console.log("Nothing pruned — retention is disabled or all table cutoffs are unset.");
    return;
  }
  console.log(`Pruned ${result.totalRowsRemoved} row(s) in ${result.durationMs}ms.`);
  for (const t of result.tables) {
    if (t.status === "skipped") continue;
    console.log(`  ${t.table.padEnd(24)} ${t.rowsRemoved} row(s) removed (cutoff ${t.cutoffIso})`);
  }
}

// ── db backup ───────────────────────────────────────────────

async function dbBackupCommand(flags: Record<string, string>): Promise<void> {
  // Resolve dest path: --dest takes precedence; else use a
  // timestamped name in DATA_DIR.
  let dest: string;
  if (flags["dest"]) {
    dest = flags["dest"];
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    dest = join(DATA_DIR, `tradekit-manual-${ts}.db`);
  }

  const result = createBackup(dest);
  if (flags["json"] === "true") {
    printJson({ ok: result.ok, result });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (result.ok) {
    console.log(`✓ Backup created: ${result.destPath} (${fmtBytes(result.sizeBytes)}, ${result.durationMs}ms)`);
    return;
  }
  console.error(`✕ Backup FAILED: ${result.error}`);
  process.exitCode = 1;
}

// ── db rotate ───────────────────────────────────────────────

async function dbRotateCommand(flags: Record<string, string>): Promise<void> {
  const config = loadConfig();
  const retainCount = flags["retain"] ? parseInt(flags["retain"], 10) : config.db.backup.retainCount;
  if (!Number.isFinite(retainCount) || retainCount < 1) {
    throw new ToolError("INVALID_PARAMS", `--retain must be a positive integer (got "${flags["retain"]}").`);
  }

  const result = rotateBackups(config.db.backup.destDir, retainCount);
  if (flags["json"] === "true") {
    printJson({ ok: true, result });
    return;
  }
  console.log(`Rotation: ${result.dir}`);
  console.log(`  Total backups: ${result.total}`);
  console.log(`  Kept:          ${result.kept}`);
  console.log(`  Removed:       ${result.removed.length}`);
  for (const f of result.removed) {
    console.log(`    - ${f}`);
  }
}

// ── dispatch ────────────────────────────────────────────────

export async function dbCommand(
  action: string | undefined,
  flags: Record<string, string>,
  _positional: string[],
): Promise<void> {
  switch (action) {
    case "stats":
      await dbStatsCommand(flags);
      break;
    case "integrity-check":
      await dbIntegrityCheckCommand(flags);
      break;
    case "prune":
      await dbPruneCommand(flags);
      break;
    case "backup":
      await dbBackupCommand(flags);
      break;
    case "rotate":
      await dbRotateCommand(flags);
      break;
    default:
      throw subcommandError("db", action, ["stats", "integrity-check", "prune", "backup", "rotate"]);
  }
}
