import { createWriteStream, renameSync, statSync, existsSync } from "fs";
import { chmodSecureIfExists, ensureDataDir } from "./secureIo.js";
import type { WriteStream } from "fs";
import { DATA_DIR, SERVER_LOG_PATH } from "./constants.js";
import { insertTrade, recentTrades, insertAudit, type TradeRow, type AuditRow } from "./db.js";

/** Rotate the server log if it's grown past this size. Override via env for ops. */
const LOG_ROTATE_BYTES = Number(process.env.TRADEKIT_LOG_ROTATE_BYTES) || 50 * 1024 * 1024;

/**
 * Rotate-on-open: if `logPath` exceeds `thresholdBytes`, move it to `.1` (overwriting
 * any previous `.1`) and let the caller open a fresh file. We deliberately keep only
 * one rotation generation — the on-disk log is for debugging the last few days, not
 * long-term retention (that's what the audit table is for, and external log shippers
 * handle the multi-day case).
 *
 * This runs at logger construction, not during writes — so a long-running MCP/web
 * server can still grow up to ~2× the threshold between restarts. Good enough for the
 * typical pattern where the process restarts daily; if not, the operator should pipe
 * to an external rotator.
 *
 * Exported so it can be unit-tested without re-importing the module graph.
 */
/**
 * Iter474: sanitize a string for safe single-line logging. Caps length and collapses
 * embedded CR/LF so a multi-line input (viem BaseError, agent-influenced contract
 * revert reason) can't inject fake log entries into server.log.
 *
 * Order: sanitize FIRST so the literal "\n" sequence counts toward the cap, then
 * truncate. Otherwise a truncated-mid-line message could leave a half-newline at
 * the boundary. Iter466's "497 + ellipsis = 500 cap" comment applies here too:
 * inputs over `cap` get sliced to `cap - 3` chars + "...", inputs ≤ cap pass
 * through after the newline collapse.
 *
 * Extracted from web.ts's iter444 error middleware so the contract is unit-testable.
 */
export function sanitizeForLogLine(msg: string, cap = 500): string {
  const sanitized = msg.replace(/[\r\n]+/g, "\\n");
  return sanitized.length > cap ? `${sanitized.slice(0, cap - 3)}...` : sanitized;
}

export function rotateIfTooLarge(logPath: string, thresholdBytes: number = LOG_ROTATE_BYTES): boolean {
  if (!existsSync(logPath)) return false;
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return false;
  }
  if (size < thresholdBytes) return false;
  try {
    renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    // Best effort — if rename fails (e.g. cross-device on Linux), we just keep
    // appending and let an external rotator handle it.
    return false;
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
  recordTrade(row: Omit<TradeRow, "id">): number;
  readRecentTrades(n: number, filter?: { chain?: string; account?: string }): TradeRow[];
  recordAudit(row: Omit<AuditRow, "id">): number;
  close(): void;
}

export interface LoggerOptions {
  /** Minimum level to mirror to stderr. The on-disk log always captures DEBUG and up. */
  stderrLevel?: LogLevel;
}

/**
 * Create a logger that writes everything to `~/.tradekit/server.log` and mirrors
 * messages to stderr at or above `stderrLevel` (default: warn).
 *
 * CLI commands should leave this at the default; pass `stderrLevel: "debug"` when
 * the user opts into verbose mode (--verbose), or `"silent"` for --quiet.
 * MCP / web mode should use `"info"` since stdout is reserved for protocol output.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const stderrLevel = opts.stderrLevel ?? "warn";
  const stderrMin = LEVEL_RANK[stderrLevel];

  ensureDataDir(DATA_DIR);
  rotateIfTooLarge(SERVER_LOG_PATH);
  // Server log can contain RPC error bodies, tool failure messages, agent params. Not
  // key material, but operationally sensitive — same 0600 treatment as the DB.
  chmodSecureIfExists(SERVER_LOG_PATH);
  const logStream: WriteStream = createWriteStream(SERVER_LOG_PATH, { flags: "a" });

  function write(level: LogLevel, msg: string) {
    // Iter480: defense-in-depth newline collapse at the logger chokepoint. Iter473-479
    // explicitly sanitize at known sites with `(e as Error).message` content, but
    // other call sites pass through token-derived strings (symbol/name from on-chain
    // reads) that could theoretically contain newlines from a malicious ERC20. Collapse
    // here so EVERY log line is single-line, regardless of caller discipline. Does NOT
    // truncate — explicit sites still apply their own caps via sanitizeForLogLine.
    const safe = msg.replace(/[\r\n]+/g, "\\n");
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${safe}\n`;
    logStream.write(line);
    if (LEVEL_RANK[level] >= stderrMin) {
      process.stderr.write(line);
    }
  }

  return {
    debug: (msg) => write("debug", msg),
    info: (msg) => write("info", msg),
    warn: (msg) => write("warn", msg),
    error: (msg) => write("error", msg),

    recordTrade(row) {
      return insertTrade(row);
    },

    readRecentTrades(n, filter = {}) {
      return recentTrades({ ...filter, limit: n });
    },

    recordAudit(row) {
      return insertAudit(row);
    },

    close() {
      logStream.end();
    },
  };
}

/** Backwards-compat for the old createLogger(boolean) signature. */
export function createLegacyLogger(toStderr: boolean): Logger {
  return createLogger({ stderrLevel: toStderr ? "info" : "silent" });
}
