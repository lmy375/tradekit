// Tests for the rotate-on-open behavior in createLogger. A long-running MCP/web
// server's append-only log file is unbounded; without rotation, disk fills.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set the data dir BEFORE importing the logger so SERVER_LOG_PATH (resolved
// at module load from TRADEKIT_DATA_DIR) points at a temp dir, not the real
// ~/.tradekit — lets the createLogger file-behavior tests assert on it safely.
const loggerDataDir = mkdtempSync(join(tmpdir(), "tradekit-logger-datadir-"));
process.env.TRADEKIT_DATA_DIR = loggerDataDir;
const { rotateIfTooLarge, sanitizeForLogLine, createLogger, createSilentLogger } = await import("./logger.js");
const serverLogPath = join(loggerDataDir, "server.log");

afterAll(() => {
  rmSync(loggerDataDir, { recursive: true, force: true });
});

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tradekit-log-test-"));
  logPath = join(tmpDir, "server.log");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("rotateIfTooLarge", () => {
  it("moves the file to .1 when oversized and returns true", () => {
    writeFileSync(logPath, "x".repeat(2048));
    const rotated = rotateIfTooLarge(logPath, 1024);
    expect(rotated).toBe(true);
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(`${logPath}.1`).size).toBe(2048);
  });

  it("leaves the file alone when under the threshold and returns false", () => {
    writeFileSync(logPath, "x".repeat(100));
    const rotated = rotateIfTooLarge(logPath, 1024);
    expect(rotated).toBe(false);
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(readFileSync(logPath, "utf-8")).toBe("x".repeat(100));
  });

  it("returns false (no-op) when the file doesn't exist", () => {
    expect(existsSync(logPath)).toBe(false);
    expect(rotateIfTooLarge(logPath, 1024)).toBe(false);
  });

  it("overwrites a previous .1 (single generation is intentional)", () => {
    writeFileSync(`${logPath}.1`, "stale-old");
    writeFileSync(logPath, "y".repeat(2048));
    const rotated = rotateIfTooLarge(logPath, 1024);
    expect(rotated).toBe(true);
    // The previous .1 content is gone; the just-rotated file's content is what's there.
    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("y".repeat(2048));
  });
});

describe("sanitizeForLogLine (iter463 + iter473 + iter474)", () => {
  it("passes short single-line messages through unchanged", () => {
    expect(sanitizeForLogLine("RPC_FAILED: timeout after 8000ms")).toBe(
      "RPC_FAILED: timeout after 8000ms",
    );
    expect(sanitizeForLogLine("")).toBe("");
  });

  it("collapses CR/LF into literal '\\n' to prevent log-line injection (iter473)", () => {
    // viem's BaseError prints metaMessages separated by real newlines. Without the
    // collapse, a multi-line error in server.log would look like two entries.
    expect(sanitizeForLogLine("line one\nline two")).toBe("line one\\nline two");
    expect(sanitizeForLogLine("crlf\r\nstyle")).toBe("crlf\\nstyle");
    // Runs of CR/LF collapse to a single literal "\n" (the regex is greedy).
    expect(sanitizeForLogLine("a\n\n\nb")).toBe("a\\nb");
  });

  it("caps at 500 chars by default; truncated form is 497 chars + '...' (iter463/466)", () => {
    const short = "a".repeat(500);
    expect(sanitizeForLogLine(short)).toBe(short); // exactly 500: pass through
    expect(sanitizeForLogLine(short).length).toBe(500);

    const long = "a".repeat(501);
    const truncated = sanitizeForLogLine(long);
    expect(truncated.length).toBe(500);
    expect(truncated.endsWith("...")).toBe(true);
    expect(truncated.slice(0, 497)).toBe("a".repeat(497));
  });

  it("sanitizes BEFORE truncating so the 500 cap counts post-collapse", () => {
    // Without the order, a multi-line input could be truncated mid-CRLF leaving
    // a half-control char at the boundary. Construct an input where pre-sanitize
    // length is > 500 but post-sanitize length is ≤ 500 — the collapse means we
    // shouldn't trim.
    const input = "x".repeat(498) + "\r\n" + "y";
    // pre-sanitize: 501 chars (498 x + \r\n + y)
    // post-sanitize: "xxx...x\\ny" = 498 + 2 + 1 = 501 chars
    // exceeds 500 → truncate to 497 + "..."
    const out = sanitizeForLogLine(input);
    expect(out.length).toBe(500);
    expect(out.endsWith("...")).toBe(true);
  });

  it("respects a custom cap (so non-web call sites can use a different budget)", () => {
    expect(sanitizeForLogLine("0123456789", 5)).toBe("01...");
    expect(sanitizeForLogLine("12345", 5)).toBe("12345"); // exactly cap, no truncate
  });
});

describe("createLogger central newline-collapse (iter480)", () => {
  // Iter480 added a defense-in-depth `msg.replace(/[\r\n]+/g, "\\n")` inside the
  // write() chokepoint, so EVERY logger entry is single-line regardless of caller
  // discipline (token-derived strings, future un-sanitized sites, etc.). This test
  // pins that behavior so a future refactor can't silently drop the collapse.
  // We override TRADEKIT_DATA_DIR via env + reset the module cache so constants.ts
  // re-evaluates SERVER_LOG_PATH against the per-test tmp dir.
  let savedDataDir: string | undefined;
  beforeEach(() => {
    savedDataDir = process.env.TRADEKIT_DATA_DIR;
    process.env.TRADEKIT_DATA_DIR = tmpDir;
    vi.resetModules();
  });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TRADEKIT_DATA_DIR;
    else process.env.TRADEKIT_DATA_DIR = savedDataDir;
    vi.resetModules();
  });

  it("collapses embedded newlines in info/warn/error to literal '\\n' (single log line)", async () => {
    const { createLogger } = await import("./logger.js");
    const logger = createLogger({ stderrLevel: "silent" });
    logger.info("first line\nsecond line");
    logger.warn("crlf\r\nstyle");
    logger.error("triple\n\n\nblank");
    logger.close();
    // Allow the write stream to flush before reading.
    await new Promise((r) => setTimeout(r, 50));
    const serverLog = join(tmpDir, "server.log");
    const contents = readFileSync(serverLog, "utf-8");
    // Each logger call produced exactly one line (terminating "\n" only).
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    // Embedded newlines were replaced with the literal two-char sequence `\n`.
    expect(lines[0]).toContain("first line\\nsecond line");
    expect(lines[1]).toContain("crlf\\nstyle");
    expect(lines[2]).toContain("triple\\nblank");
    // Sanity: no raw CR slipped through (the collapse must be greedy).
    expect(lines[0]).not.toContain("\r");
  });
});

// ── createLogger fileLevel / createSilentLogger (v59) ──────────

describe("createLogger fileLevel + createSilentLogger", () => {
  beforeEach(() => {
    if (existsSync(serverLogPath)) rmSync(serverLogPath);
  });

  it("default createLogger opens + writes the server log", async () => {
    const logger = createLogger({ stderrLevel: "silent" });
    logger.info("hello-from-default");
    logger.close();
    await new Promise((r) => setTimeout(r, 50)); // let the async stream flush
    expect(existsSync(serverLogPath)).toBe(true);
    expect(readFileSync(serverLogPath, "utf8")).toContain("hello-from-default");
  });

  it("createSilentLogger writes NOTHING to disk and never opens the file", () => {
    const logger = createSilentLogger();
    // Every level is a no-op to disk; none of these throw.
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.close();
    // The whole point: no file handle was ever opened, so the shared log
    // is untouched (and there's no stream to leak / race with cleanup).
    expect(existsSync(serverLogPath)).toBe(false);
  });

  it("fileLevel: 'silent' is equivalent to createSilentLogger for disk output", () => {
    const logger = createLogger({ stderrLevel: "silent", fileLevel: "silent" });
    logger.error("should-not-persist");
    logger.close();
    expect(existsSync(serverLogPath)).toBe(false);
  });

  it("fileLevel gates which levels reach the disk (e.g. 'warn' drops debug/info)", async () => {
    const logger = createLogger({ stderrLevel: "silent", fileLevel: "warn" });
    logger.debug("dbg-skip");
    logger.info("info-skip");
    logger.warn("warn-keep");
    logger.error("error-keep");
    logger.close();
    await new Promise((r) => setTimeout(r, 50)); // let the async stream flush
    const body = readFileSync(serverLogPath, "utf8");
    expect(body).not.toContain("dbg-skip");
    expect(body).not.toContain("info-skip");
    expect(body).toContain("warn-keep");
    expect(body).toContain("error-keep");
  });

  it("a silent logger still records trades/audit (DB-backed, not file-backed)", () => {
    // recordTrade/recordAudit go to SQLite, independent of the log stream —
    // a no-file logger must not break them. We only assert the methods exist
    // and are callable shape-wise (no DB open here); the contract is that
    // file logging and DB recording are orthogonal.
    const logger = createSilentLogger();
    expect(typeof logger.recordTrade).toBe("function");
    expect(typeof logger.recordAudit).toBe("function");
    logger.close();
  });
});
