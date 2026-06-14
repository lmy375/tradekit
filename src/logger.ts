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
  /** Closes the file stream. Returns a Promise that resolves once the stream
   *  has FLUSHED to the OS (so a caller that reads the log right after — e.g.
   *  a test, or a shutdown that tails the log — sees every line). Callers that
   *  don't care can ignore the return (fire-and-forget still flushes). */
  close(): void | Promise<void>;
}

export interface LoggerOptions {
  /** Minimum level to mirror to stderr. Default "warn". */
  stderrLevel?: LogLevel;
  /**
   * Minimum level to write to the on-disk `server.log`. Default "debug"
   * (capture everything — the long-standing behavior). Set to "silent" for
   * a TRANSIENT / throwaway logger (e.g. the one-shot logger handed to a
   * price fetcher inside a gather function) that must NOT touch the shared
   * log file at all: no stream is opened, so there's no leaked file handle
   * whose async writes can outlive an ephemeral data dir (the root cause of
   * the long-standing test-suite "ENOENT … server.log" noise) and no
   * server.log growth from read-only/one-shot work.
   */
  fileLevel?: LogLevel;
}

/**
 * Create a logger that writes to `~/.tradekit/server.log` (at `fileLevel`
 * and up — default DEBUG, i.e. everything) and mirrors messages to stderr
 * at or above `stderrLevel` (default: warn).
 *
 * CLI commands should leave this at the default; pass `stderrLevel: "debug"`
 * when the user opts into verbose mode (--verbose), or `"silent"` for --quiet.
 * MCP / web mode should use `"info"` since stdout is reserved for protocol
 * output. For a throwaway logger that should leave NO trace on disk, prefer
 * `createSilentLogger()`.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const stderrLevel = opts.stderrLevel ?? "warn";
  const stderrMin = LEVEL_RANK[stderrLevel];
  const fileLevel = opts.fileLevel ?? "debug";
  const fileMin = LEVEL_RANK[fileLevel];
  const fileEnabled = fileLevel !== "silent";

  // Only open (and prepare) the shared log file when file logging is on.
  // A silent-file logger opens nothing — no handle to leak, no IO cost.
  let logStream: WriteStream | null = null;
  if (fileEnabled) {
    ensureDataDir(DATA_DIR);
    rotateIfTooLarge(SERVER_LOG_PATH);
    // Server log can contain RPC error bodies, tool failure messages, agent params. Not
    // key material, but operationally sensitive — same 0600 treatment as the DB.
    chmodSecureIfExists(SERVER_LOG_PATH);
    logStream = createWriteStream(SERVER_LOG_PATH, { flags: "a" });
  }

  function write(level: LogLevel, msg: string) {
    const rank = LEVEL_RANK[level];
    if (logStream == null && rank < stderrMin) return; // nothing to do — skip formatting
    // Iter480: defense-in-depth newline collapse at the logger chokepoint. Iter473-479
    // explicitly sanitize at known sites with `(e as Error).message` content, but
    // other call sites pass through token-derived strings (symbol/name from on-chain
    // reads) that could theoretically contain newlines from a malicious ERC20. Collapse
    // here so EVERY log line is single-line, regardless of caller discipline. Does NOT
    // truncate — explicit sites still apply their own caps via sanitizeForLogLine.
    const safe = msg.replace(/[\r\n]+/g, "\\n");
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${safe}\n`;
    if (logStream != null && rank >= fileMin) {
      logStream.write(line);
    }
    if (rank >= stderrMin) {
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

    close(): void | Promise<void> {
      const s = logStream;
      logStream = null; // idempotent: a second close is a no-op
      if (s == null) return;
      // end(cb) fires the callback on the stream's 'finish' event — i.e. after
      // all buffered writes have flushed. Awaiting this removes the race where
      // a fixed setTimeout guessed at the flush delay.
      return new Promise<void>((resolve) => s.end(() => resolve()));
    },
  };
}

/**
 * A transient logger that writes NOTHING — no on-disk file, no stderr.
 * Use for throwaway loggers handed to a helper (e.g. a one-shot price
 * fetch) purely to satisfy a signature: they should leave no operational
 * trace and must not open the shared log file (which would leak a handle).
 */
export function createSilentLogger(): Logger {
  return createLogger({ stderrLevel: "silent", fileLevel: "silent" });
}

/** Backwards-compat for the old createLogger(boolean) signature. */
export function createLegacyLogger(toStderr: boolean): Logger {
  return createLogger({ stderrLevel: toStderr ? "info" : "silent" });
}
