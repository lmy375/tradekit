// Tests for engineStatusWriter.ts (iter41).
//
// Pure unit tests — the writeFn is injected so no real file I/O.
// We verify the coalescing behavior: N rapid requests in a window
// collapse to 1 trailing write that reflects the latest state.

import { describe, it, expect, vi } from "vitest";
import { StatusWriter } from "./engineStatusWriter.js";
import type { EngineStatus } from "./engine.js";
import type { Logger } from "./logger.js";

function silent(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    recordAudit: vi.fn(),
  } as unknown as Logger;
}

function makeStatus(over: Partial<EngineStatus> = {}): EngineStatus {
  return {
    pid: 123,
    startedAt: "2026-05-31T12:00:00Z",
    updatedAt: "2026-05-31T12:00:00Z",
    workers: [],
    stopping: false,
    ...over,
  };
}

// ── single request ──────────────────────────────────────────

describe("StatusWriter — single request", () => {
  it("schedules a debounced write", async () => {
    const writeFn = vi.fn();
    let snap = makeStatus({ updatedAt: "v1" });
    const w = new StatusWriter({
      path: "/tmp/test.json",
      debounceMs: 50,
      logger: silent(),
      snapshotFn: () => snap,
      writeFn,
    });
    w.request();
    expect(writeFn).not.toHaveBeenCalled(); // debounced
    await new Promise((r) => setTimeout(r, 80));
    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn.mock.calls[0][0]).toBe("/tmp/test.json");
    expect(JSON.parse(writeFn.mock.calls[0][1]).updatedAt).toBe("v1");
  });
});

// ── coalescing ──────────────────────────────────────────────

describe("StatusWriter — coalescing", () => {
  it("multiple requests inside the window collapse to ONE write", async () => {
    const writeFn = vi.fn();
    let snap = makeStatus({ updatedAt: "initial" });
    const w = new StatusWriter({
      path: "/tmp/test.json",
      debounceMs: 100,
      logger: silent(),
      snapshotFn: () => snap,
      writeFn,
    });
    for (let i = 0; i < 10; i++) {
      w.request();
      snap = makeStatus({ updatedAt: `v${i}` });
    }
    expect(w.requestCount).toBe(10);
    await new Promise((r) => setTimeout(r, 150));
    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(w.writeCount).toBe(1);
    // Last snapshot wins — the trailing write picks up the most
    // recent state.
    expect(JSON.parse(writeFn.mock.calls[0][1]).updatedAt).toBe("v9");
  });

  it("requests AFTER a flush schedule a new write", async () => {
    const writeFn = vi.fn();
    let snap = makeStatus({ updatedAt: "v1" });
    const w = new StatusWriter({
      path: "/tmp/test.json",
      debounceMs: 50,
      logger: silent(),
      snapshotFn: () => snap,
      writeFn,
    });
    w.request();
    await new Promise((r) => setTimeout(r, 80));
    expect(writeFn).toHaveBeenCalledTimes(1);

    snap = makeStatus({ updatedAt: "v2" });
    w.request();
    await new Promise((r) => setTimeout(r, 80));
    expect(writeFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(writeFn.mock.calls[1][1]).updatedAt).toBe("v2");
  });
});

// ── zero debounce ───────────────────────────────────────────

describe("StatusWriter — zero debounce", () => {
  it("writes synchronously on each request", () => {
    const writeFn = vi.fn();
    const snap = makeStatus({ updatedAt: "v1" });
    const w = new StatusWriter({
      path: "/tmp/test.json",
      debounceMs: 0,
      logger: silent(),
      snapshotFn: () => snap,
      writeFn,
    });
    w.request();
    w.request();
    w.request();
    expect(writeFn).toHaveBeenCalledTimes(3);
  });
});

// ── flush ──────────────────────────────────────────────────

describe("StatusWriter — flush", () => {
  it("flushes pending write immediately", () => {
    const writeFn = vi.fn();
    const snap = makeStatus({ updatedAt: "v1" });
    const w = new StatusWriter({
      path: "/tmp/test.json",
      debounceMs: 1000,
      logger: silent(),
      snapshotFn: () => snap,
      writeFn,
    });
    w.request();
    expect(writeFn).not.toHaveBeenCalled();
    w.flush();
    expect(writeFn).toHaveBeenCalledTimes(1);
  });

  it("flush is idempotent when no write is pending", () => {
    const writeFn = vi.fn();
    const snap = makeStatus();
    const w = new StatusWriter({
      path: "/tmp/test.json",
      debounceMs: 100,
      logger: silent(),
      snapshotFn: () => snap,
      writeFn,
    });
    w.flush();
    expect(writeFn).toHaveBeenCalledTimes(1); // writes the current snapshot
    w.flush();
    expect(writeFn).toHaveBeenCalledTimes(2); // writes again — no harm
  });
});

// ── stop ────────────────────────────────────────────────────

describe("StatusWriter — stop", () => {
  it("ignores requests after stop()", async () => {
    const writeFn = vi.fn();
    const snap = makeStatus();
    const w = new StatusWriter({
      path: "/tmp/test.json",
      debounceMs: 50,
      logger: silent(),
      snapshotFn: () => snap,
      writeFn,
    });
    w.stop();
    expect(writeFn).toHaveBeenCalledTimes(1); // final flush
    writeFn.mockClear();
    w.request();
    await new Promise((r) => setTimeout(r, 80));
    expect(writeFn).not.toHaveBeenCalled();
  });
});

// ── error safety ───────────────────────────────────────────

describe("StatusWriter — error tolerance", () => {
  it("never throws when writeFn fails", () => {
    const logger = silent();
    const writeFn = vi.fn().mockImplementation(() => {
      throw new Error("disk full");
    });
    const w = new StatusWriter({
      path: "/tmp/test.json",
      debounceMs: 0,
      logger,
      snapshotFn: () => makeStatus(),
      writeFn,
    });
    expect(() => w.request()).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("never throws when snapshotFn fails", () => {
    const logger = silent();
    const writeFn = vi.fn();
    const w = new StatusWriter({
      path: "/tmp/test.json",
      debounceMs: 0,
      logger,
      snapshotFn: () => {
        throw new Error("snap failed");
      },
      writeFn,
    });
    expect(() => w.request()).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
    expect(writeFn).not.toHaveBeenCalled();
  });
});
