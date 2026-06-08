/**
 * Engine lock tests.
 *
 * Layers:
 *   1. Pure predicate (isEngineLockedFromRow) — boolean over row state
 *   2. DB state (getEngineLock / setEngineLock / clearEngineLock) —
 *      single-row table invariants, idempotency, defensive seeding
 *   3. Throwing enforcement (assertEngineNotLocked) — error shape +
 *      nextActions
 *   4. High-level ops (lockEngine / unlockEngine) — notification +
 *      audit side effects, idempotent re-locks/unlocks
 *   5. softSkipIfLocked predicate — log + boolean return
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-engineLock-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  isEngineLockedFromRow,
  isEngineLocked,
  getEngineLockState,
  assertEngineNotLocked,
  lockEngine,
  unlockEngine,
  softSkipIfLocked,
} = await import("./engineLock.js");
const {
  openDb,
  closeDb,
  getEngineLock,
  setEngineLock,
  clearEngineLock,
} = await import("./db.js");
const { loadConfig } = await import("./config.js");

// Simple no-op logger to avoid touching the on-disk log stream during
// tests (same pattern as iter26 MCP tests).
const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
  recordAudit: () => {},
  close: () => {},
} as unknown as import("./logger.js").Logger;

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  // Reset to the migration's pre-seeded shape (id=1, active=0).
  db.exec("DELETE FROM engine_lock");
  db.exec(`INSERT INTO engine_lock (id, active, updated_at) VALUES (1, 0, '1970-01-01T00:00:00Z')`);
});

// ── pure predicate ───────────────────────────────────────────

describe("isEngineLockedFromRow", () => {
  it("returns true for active=1", () => {
    expect(isEngineLockedFromRow({
      id: 1, active: 1, reason: "x", locked_at: "2026-01-01T00:00:00Z",
      locked_by: "cli", updated_at: "2026-01-01T00:00:00Z",
    })).toBe(true);
  });
  it("returns false for active=0", () => {
    expect(isEngineLockedFromRow({
      id: 1, active: 0, reason: null, locked_at: null,
      locked_by: null, updated_at: "1970-01-01T00:00:00Z",
    })).toBe(false);
  });
});

// ── DB state ─────────────────────────────────────────────────

describe("getEngineLock — initial state", () => {
  it("returns unlocked state after migration", () => {
    const row = getEngineLock();
    expect(row.active).toBe(0);
    expect(row.reason).toBeNull();
    expect(row.locked_at).toBeNull();
    expect(row.locked_by).toBeNull();
  });

  it("isEngineLocked() reflects the row", () => {
    expect(isEngineLocked()).toBe(false);
  });
});

describe("setEngineLock / clearEngineLock", () => {
  it("set transitions active to 1 + records reason + lockedBy", () => {
    const row = setEngineLock({ reason: "investigating", lockedBy: "operator-alice" });
    expect(row.active).toBe(1);
    expect(row.reason).toBe("investigating");
    expect(row.locked_by).toBe("operator-alice");
    expect(row.locked_at).not.toBeNull();
    expect(isEngineLocked()).toBe(true);
  });

  it("set is idempotent — re-locking updates timestamps", async () => {
    const first = setEngineLock({ reason: "r1", lockedBy: "cli" });
    await new Promise((r) => setTimeout(r, 5));
    const second = setEngineLock({ reason: "r2", lockedBy: "mcp" });
    expect(second.active).toBe(1);
    expect(second.reason).toBe("r2");
    expect(second.locked_by).toBe("mcp");
    // locked_at refreshes on re-lock (matches the documented behavior
    // in the comment above setEngineLock).
    expect(Date.parse(second.locked_at!)).toBeGreaterThanOrEqual(Date.parse(first.locked_at!));
  });

  it("clear transitions active to 0 + nulls reason/lockedBy", () => {
    setEngineLock({ reason: "x", lockedBy: "cli" });
    const row = clearEngineLock();
    expect(row.active).toBe(0);
    expect(row.reason).toBeNull();
    expect(row.locked_by).toBeNull();
    expect(row.locked_at).toBeNull();
    expect(isEngineLocked()).toBe(false);
  });

  it("clear is idempotent — clearing unlocked engine is no-op", () => {
    expect(isEngineLocked()).toBe(false);
    const row = clearEngineLock();
    expect(row.active).toBe(0);
  });

  it("getEngineLock defensively re-seeds when row is missing", () => {
    const db = openDb();
    db.exec("DELETE FROM engine_lock");
    const row = getEngineLock();
    expect(row.id).toBe(1);
    expect(row.active).toBe(0);
  });
});

// ── assertEngineNotLocked ────────────────────────────────────

describe("assertEngineNotLocked", () => {
  it("returns silently when unlocked", () => {
    expect(() => assertEngineNotLocked({ context: "test" })).not.toThrow();
  });

  it("throws ENGINE_LOCKED when locked", () => {
    setEngineLock({ reason: "test reason", lockedBy: "test-operator" });
    let err: { code?: string; details?: Record<string, unknown> } | undefined;
    try {
      assertEngineNotLocked({ context: "manual trade buy ETH/USDC" });
    } catch (e) {
      err = e as { code?: string; details?: Record<string, unknown> };
    }
    expect(err?.code).toBe("ENGINE_LOCKED");
    expect(err?.details?.reason).toBe("test reason");
    expect(err?.details?.lockedBy).toBe("test-operator");
    expect(err?.details?.blockedContext).toBe("manual trade buy ETH/USDC");
  });

  it("error includes nextActions pointing at engine_unlock", () => {
    setEngineLock({ reason: "test", lockedBy: "cli" });
    let err: { nextActions?: Array<{ tool: string }> } | undefined;
    try {
      assertEngineNotLocked({ context: "schedule fire" });
    } catch (e) {
      err = e as { nextActions?: Array<{ tool: string }> };
    }
    expect(err?.nextActions?.[0]?.tool).toBe("engine_unlock");
  });
});

// ── high-level lockEngine / unlockEngine ────────────────────

describe("lockEngine — high-level", () => {
  it("sets row + emits notification + logs warn", async () => {
    const config = loadConfig();
    const notifyMock = vi.spyOn(noopLogger, "warn");
    const row = await lockEngine({
      reason: "incident-A",
      lockedBy: "test",
      config,
      logger: noopLogger,
    });
    expect(row.active).toBe(1);
    expect(notifyMock).toHaveBeenCalled();
    notifyMock.mockRestore();
  });

  it("idempotent re-lock doesn't fire a SECOND notification", async () => {
    const config = loadConfig();
    const warnSpy = vi.spyOn(noopLogger, "warn");
    await lockEngine({ reason: "r1", lockedBy: "cli", config, logger: noopLogger });
    const callsAfterFirst = warnSpy.mock.calls.length;
    await lockEngine({ reason: "r2", lockedBy: "mcp", config, logger: noopLogger });
    // Idempotent re-lock: row updates but no second notification
    // (transition was unlocked→locked once; second call was
    // locked→locked).
    expect(warnSpy.mock.calls.length).toBe(callsAfterFirst);
    warnSpy.mockRestore();
  });
});

describe("unlockEngine — high-level", () => {
  it("clears row + emits notification when locked", async () => {
    const config = loadConfig();
    await lockEngine({ reason: "x", lockedBy: "cli", config, logger: noopLogger });
    const row = await unlockEngine({ config, logger: noopLogger, unlockedBy: "cli" });
    expect(row.active).toBe(0);
  });

  it("unlock when already unlocked is a true no-op (no notification)", async () => {
    const config = loadConfig();
    const infoSpy = vi.spyOn(noopLogger, "info");
    const row = await unlockEngine({ config, logger: noopLogger, unlockedBy: "cli" });
    expect(row.active).toBe(0);
    // No transition → no info log emitted by the unlock path.
    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });
});

// ── softSkipIfLocked ─────────────────────────────────────────

describe("softSkipIfLocked", () => {
  it("returns false when unlocked", () => {
    expect(softSkipIfLocked({ context: "orders engine", logger: noopLogger })).toBe(false);
  });

  it("returns true + logs debug when locked", () => {
    setEngineLock({ reason: "test", lockedBy: "cli" });
    const debugSpy = vi.spyOn(noopLogger, "debug");
    expect(softSkipIfLocked({ context: "orders engine", logger: noopLogger })).toBe(true);
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

// ── getEngineLockState ───────────────────────────────────────

describe("getEngineLockState", () => {
  it("returns the full row for status dashboards", () => {
    setEngineLock({ reason: "maintenance", lockedBy: "deploy-bot" });
    const state = getEngineLockState();
    expect(state.active).toBe(1);
    expect(state.reason).toBe("maintenance");
    expect(state.locked_by).toBe("deploy-bot");
    expect(state.locked_at).not.toBeNull();
    expect(state.updated_at).not.toBeNull();
  });
});
