// Tests for engineEvents.ts (iter39). Two layers:
//
//   1. Pure constructor shape — each typed helper passes the
//      right severity/payload to the DB layer.
//   2. End-to-end against a seeded DB — assert rows land,
//      fields_json parses correctly, listEngineEvents filters work.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-engineevents-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  recordEngineStarted,
  recordEngineStopped,
  recordEngineLock,
  recordEngineUnlock,
  recordWorkerDegraded,
  recordWorkerRecovered,
  recordConfigReloaded,
  recordConfigReloadFailed,
} = await import("./engineEvents.js");
const {
  openDb,
  closeDb,
  listEngineEvents,
  pruneEngineEvents,
} = await import("./db.js");
import type { Logger } from "./logger.js";

function silentLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    recordAudit: vi.fn(),
  } as unknown as Logger;
}

beforeAll(() => openDb());
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM engine_events");
});

// ── engine.started / engine.stopped ─────────────────────────

describe("recordEngineStarted", () => {
  it("persists a row with severity=info + workers in fields", () => {
    recordEngineStarted({
      startedAt: "2026-05-31T12:00:00Z",
      workers: ["orders", "schedules"],
      dryRun: false,
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("engine.started");
    expect(rows[0].severity).toBe("info");
    expect(rows[0].pid).toBe(process.pid);
    expect(rows[0].worker_name).toBeNull();
    const fields = JSON.parse(rows[0].fields_json!);
    expect(fields.workers).toEqual(["orders", "schedules"]);
    expect(fields.dryRun).toBe(false);
  });
});

describe("recordEngineStopped", () => {
  it("clean exit is severity=info", () => {
    recordEngineStopped({
      startedAt: "2026-05-31T12:00:00Z",
      stoppedAt: "2026-05-31T14:00:00Z",
      uptimeMs: 7_200_000,
      fatal: null,
      stopSignal: "SIGINT",
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows[0].event_type).toBe("engine.stopped");
    expect(rows[0].severity).toBe("info");
    const fields = JSON.parse(rows[0].fields_json!);
    expect(fields.uptimeMs).toBe(7_200_000);
    expect(fields.fatal).toBeNull();
    expect(fields.stopSignal).toBe("SIGINT");
  });

  it("fatal exit is severity=critical", () => {
    recordEngineStopped({
      startedAt: "2026-05-31T12:00:00Z",
      stoppedAt: "2026-05-31T13:00:00Z",
      uptimeMs: 3_600_000,
      fatal: "RPC pool exhausted",
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows[0].severity).toBe("critical");
    expect(JSON.parse(rows[0].fields_json!).fatal).toBe("RPC pool exhausted");
  });
});

// ── engine.lock / engine.unlock ─────────────────────────────

describe("recordEngineLock", () => {
  it("severity=warn + dedup_key includes lockedAt", () => {
    recordEngineLock({
      lockedAt: "2026-05-31T13:00:00Z",
      reason: "investigation",
      lockedBy: "cli",
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows[0].event_type).toBe("engine.lock");
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].dedup_key).toBe("engine.lock:2026-05-31T13:00:00Z");
    const fields = JSON.parse(rows[0].fields_json!);
    expect(fields.reason).toBe("investigation");
    expect(fields.lockedBy).toBe("cli");
  });
});

describe("recordEngineUnlock", () => {
  it("severity=info + carries pairedLockedAt", () => {
    recordEngineUnlock({
      unlockedAt: "2026-05-31T14:00:00Z",
      unlockedBy: "mcp",
      pairedLockedAt: "2026-05-31T13:00:00Z",
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows[0].event_type).toBe("engine.unlock");
    expect(rows[0].severity).toBe("info");
    const fields = JSON.parse(rows[0].fields_json!);
    expect(fields.unlockedBy).toBe("mcp");
    expect(fields.pairedLockedAt).toBe("2026-05-31T13:00:00Z");
  });
});

// ── worker.degraded / worker.recovered ─────────────────────

describe("recordWorkerDegraded", () => {
  it("captures worker_name + payload + dedup_key mirrors iter33 notify", () => {
    recordWorkerDegraded({
      workerName: "orders",
      consecutiveFailures: 3,
      effectiveIntervalMs: 60_000,
      baseIntervalMs: 30_000,
      lastError: "RPC timeout",
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows[0].event_type).toBe("worker.degraded");
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].worker_name).toBe("orders");
    expect(rows[0].dedup_key).toBe("engine.worker.degraded:orders");
    const fields = JSON.parse(rows[0].fields_json!);
    expect(fields.consecutiveFailures).toBe(3);
    expect(fields.lastError).toBe("RPC timeout");
  });
});

describe("recordWorkerRecovered", () => {
  it("severity=info + hour-bucketed dedup_key", () => {
    recordWorkerRecovered({
      workerName: "schedules",
      afterFailures: 5,
      tickDurationMs: 250,
      baseIntervalMs: 60_000,
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows[0].event_type).toBe("worker.recovered");
    expect(rows[0].severity).toBe("info");
    expect(rows[0].worker_name).toBe("schedules");
    // Hour bucket is the first 13 chars of an ISO timestamp.
    expect(rows[0].dedup_key).toMatch(/^engine\.worker\.recovered:schedules:\d{4}-\d{2}-\d{2}T\d{2}$/);
  });
});

// ── config.reloaded / config.reload_failed ────────────────

describe("recordConfigReloaded", () => {
  it("severity follows iter35 rule — critical when criticalCount>0", () => {
    recordConfigReloaded({
      reloadedAt: "2026-05-31T15:00:00Z",
      diffCount: 5,
      criticalCount: 2,
      warnCount: 1,
      infoCount: 2,
      affectedOrders: 3,
      affectedSchedules: 0,
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows[0].severity).toBe("critical");
  });

  it("severity=warn when only warn-level changes", () => {
    recordConfigReloaded({
      reloadedAt: "2026-05-31T15:00:00Z",
      diffCount: 2,
      criticalCount: 0,
      warnCount: 1,
      infoCount: 1,
      affectedOrders: 0,
      affectedSchedules: 0,
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows[0].severity).toBe("warn");
  });

  it("severity=info when only info-level changes", () => {
    recordConfigReloaded({
      reloadedAt: "2026-05-31T15:00:00Z",
      diffCount: 1,
      criticalCount: 0,
      warnCount: 0,
      infoCount: 1,
      affectedOrders: 0,
      affectedSchedules: 0,
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows[0].severity).toBe("info");
  });
});

describe("recordConfigReloadFailed", () => {
  it("severity=critical + carries error message", () => {
    recordConfigReloadFailed({
      attemptedAt: "2026-05-31T15:00:00Z",
      error: "Zod validation failed: safety.maxSlippageBps must be a number",
      logger: silentLogger(),
    });
    const rows = listEngineEvents();
    expect(rows[0].event_type).toBe("config.reload_failed");
    expect(rows[0].severity).toBe("critical");
    expect(JSON.parse(rows[0].fields_json!).error).toMatch(/Zod validation/);
  });
});

// ── listEngineEvents filters ───────────────────────────────

describe("listEngineEvents — filter passthrough", () => {
  it("returns rows newest-first", () => {
    recordEngineStarted({ startedAt: "2026-05-31T10:00:00Z", workers: [], dryRun: false, logger: silentLogger() });
    recordEngineStopped({ startedAt: "2026-05-31T10:00:00Z", stoppedAt: "2026-05-31T12:00:00Z", uptimeMs: 7200000, logger: silentLogger() });
    const rows = listEngineEvents();
    expect(rows).toHaveLength(2);
    expect(rows[0].event_type).toBe("engine.stopped");
    expect(rows[1].event_type).toBe("engine.started");
  });

  it("filters by event_type prefix", () => {
    recordEngineStarted({ startedAt: "2026-05-31T10:00:00Z", workers: [], dryRun: false, logger: silentLogger() });
    recordWorkerDegraded({
      workerName: "orders",
      consecutiveFailures: 3,
      effectiveIntervalMs: 60_000,
      baseIntervalMs: 30_000,
      lastError: null,
      logger: silentLogger(),
    });
    const workerOnly = listEngineEvents({ eventTypePrefix: "worker." });
    expect(workerOnly).toHaveLength(1);
    expect(workerOnly[0].event_type).toBe("worker.degraded");
  });

  it("filters by minSeverity floor", () => {
    recordEngineStarted({ startedAt: "2026-05-31T10:00:00Z", workers: [], dryRun: false, logger: silentLogger() });
    recordEngineLock({ lockedAt: "2026-05-31T11:00:00Z", reason: null, lockedBy: "x", logger: silentLogger() });
    recordConfigReloadFailed({ attemptedAt: "2026-05-31T12:00:00Z", error: "bad", logger: silentLogger() });
    const critical = listEngineEvents({ minSeverity: "critical" });
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("critical");
    const warnAndUp = listEngineEvents({ minSeverity: "warn" });
    expect(warnAndUp).toHaveLength(2);
  });

  it("filters by workerName", () => {
    recordWorkerDegraded({
      workerName: "orders",
      consecutiveFailures: 3, effectiveIntervalMs: 60_000, baseIntervalMs: 30_000, lastError: null, logger: silentLogger(),
    });
    recordWorkerDegraded({
      workerName: "schedules",
      consecutiveFailures: 3, effectiveIntervalMs: 60_000, baseIntervalMs: 30_000, lastError: null, logger: silentLogger(),
    });
    expect(listEngineEvents({ workerName: "orders" })).toHaveLength(1);
    expect(listEngineEvents({ workerName: "schedules" })).toHaveLength(1);
  });

  it("filters by pid (current process by default; rows from older runs filtered out)", () => {
    recordEngineStarted({ startedAt: "2026-05-31T10:00:00Z", workers: [], dryRun: false, logger: silentLogger() });
    // Insert a row pretending to be from a different pid by direct
    // SQL — this lets us test the pid filter without spawning a
    // separate process.
    const db = openDb();
    db.prepare(
      `INSERT INTO engine_events (timestamp, event_type, severity, pid) VALUES (?, ?, ?, ?)`,
    ).run("2026-05-30T10:00:00Z", "engine.started", "info", 99999);
    const ours = listEngineEvents({ pid: process.pid });
    expect(ours.every((r) => r.pid === process.pid)).toBe(true);
    const other = listEngineEvents({ pid: 99999 });
    expect(other).toHaveLength(1);
  });

  it("filters by window (sinceIso + untilIso)", () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO engine_events (timestamp, event_type, severity, pid) VALUES (?, ?, ?, ?)`,
    ).run("2026-05-30T00:00:00Z", "engine.started", "info", process.pid);
    db.prepare(
      `INSERT INTO engine_events (timestamp, event_type, severity, pid) VALUES (?, ?, ?, ?)`,
    ).run("2026-05-31T12:00:00Z", "engine.started", "info", process.pid);
    const inWindow = listEngineEvents({
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(inWindow).toHaveLength(1);
    expect(inWindow[0].timestamp).toBe("2026-05-31T12:00:00Z");
  });
});

// ── pruneEngineEvents ───────────────────────────────────────

describe("pruneEngineEvents", () => {
  it("deletes rows older than the cutoff", () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO engine_events (timestamp, event_type, severity, pid) VALUES (?, ?, ?, ?)`,
    ).run("2026-05-01T00:00:00Z", "engine.started", "info", process.pid);
    db.prepare(
      `INSERT INTO engine_events (timestamp, event_type, severity, pid) VALUES (?, ?, ?, ?)`,
    ).run("2026-05-31T00:00:00Z", "engine.started", "info", process.pid);
    const removed = pruneEngineEvents("2026-05-15T00:00:00Z");
    expect(removed).toBe(1);
    expect(listEngineEvents()).toHaveLength(1);
  });
});

// ── error-safe semantics ────────────────────────────────────

describe("safe-record error tolerance", () => {
  it("constructor never throws when the underlying DB call fails", async () => {
    // Mock the DB layer to throw, verify the typed constructor
    // swallows + logs warn instead of propagating.
    const logger = silentLogger();
    const dbMod = await import("./db.js");
    const originalInsert = dbMod.insertEngineEvent;
    const spy = vi.spyOn(dbMod, "insertEngineEvent").mockImplementation(() => {
      throw new Error("simulated DB failure");
    });
    try {
      expect(() =>
        recordEngineStarted({
          startedAt: "2026-05-31T10:00:00Z",
          workers: [],
          dryRun: false,
          logger,
        }),
      ).not.toThrow();
      expect(logger.warn).toHaveBeenCalled();
      expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/engine\.started/);
    } finally {
      spy.mockRestore();
      // Restore the export — Vitest's spy.mockRestore already does
      // this but be explicit so the rest of the suite is unaffected.
      void originalInsert;
    }
  });
});
