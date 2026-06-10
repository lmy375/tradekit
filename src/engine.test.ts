// Tests for the unified engine supervisor (engine.ts).
//
// We focus on the supervisor's SCHEDULING + ISOLATION + STATUS PERSISTENCE
// without depending on the actual built-in workers (which would need a
// real wallet + RPC). Mock workers are injected via `workersOverride`.
//
// The lock-collision test asserts the WALLET_LOCKED error when a second
// supervisor tries to start while the first holds the .lock.engine file.
//
// All tests use a fresh TRADEKIT_DATA_DIR so the .lock.engine and status
// file don't collide with the developer's real install or other tests.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-engine-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  runEngineSupervisor,
  readEngineStatus,
  formatDuration,
  tickStalenessSeconds,
  buildBuiltinWorkers,
} = await import("./engine.js");
type Worker = Awaited<ReturnType<typeof import("./engine.js").buildBuiltinWorkers>>[number];
type WorkerName = Worker["name"];

// Use dynamic imports for everything that pulls in constants.ts — the
// TRADEKIT_DATA_DIR env var must be set BEFORE the constants module
// captures DATA_DIR (top-level const). Without this, DATA_DIR resolves
// to HOME/.tradekit and the engine's lockfile + status file land in the
// wrong directory.
import type { Logger } from "./logger.js";
const { acquireLock } = await import("./processLock.js");
const { closeDb, openDb } = await import("./db.js");
const { loadConfig, configSchema } = await import("./config.js");

const stubLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  recordAudit: () => {},
} as unknown as Logger;

beforeAll(() => {
  // Open DB so migration runs once; the engine itself doesn't write to
  // the DB but the buildBuiltinWorkers path does indirect-import db.js.
  openDb();
});

afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Status + lock files survive across tests; delete to start clean.
  for (const f of [".engine.status.json", ".lock.engine"]) {
    const p = join(tmpDataDir, f);
    if (existsSync(p)) rmSync(p);
  }
});

// ── pure helpers ────────────────────────────────────────────

describe("formatDuration", () => {
  it("returns ms for sub-second", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(0)).toBe("0ms");
  });
  it("returns seconds under a minute", () => {
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(59_000)).toBe("59s");
  });
  it("returns m + s under an hour", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
  it("returns h + m under a day", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(3_660_000)).toBe("1h 1m");
  });
  it("returns d + h beyond a day", () => {
    expect(formatDuration(86_400_000)).toBe("1d 0h");
    expect(formatDuration(90_000_000)).toBe("1d 1h");
  });
});

describe("tickStalenessSeconds", () => {
  it("returns null when no lastTickAt", () => {
    expect(tickStalenessSeconds(null)).toBeNull();
    expect(tickStalenessSeconds("garbage")).toBeNull();
  });
  it("returns positive seconds when lastTickAt is in the past", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const stale = tickStalenessSeconds(fiveMinAgo)!;
    expect(stale).toBeGreaterThan(290);
    expect(stale).toBeLessThan(310);
  });
});

// ── readEngineStatus on a missing file ──────────────────────

describe("readEngineStatus", () => {
  it("returns null when no engine has ever run", () => {
    expect(readEngineStatus()).toBeNull();
  });
});

// ── buildBuiltinWorkers respects config.enabled ─────────────

describe("buildBuiltinWorkers", () => {
  it("emits workers in canonical order: orders, schedules, reconcile, rebalance, alerts, digest", () => {
    const workers = buildBuiltinWorkers(loadConfig());
    expect(workers.map((w) => w.name)).toEqual(["orders", "schedules", "reconcile", "rebalance", "alerts", "digest"]);
  });

  it("omits workers whose config.enabled=false", async () => {
    // Use configSchema.parse to build an in-memory Config with some
    // workers disabled — no on-disk mutation. Iter33: also disable
    // alerts (otherwise it's added as a 5th worker by default).
    const cfg = configSchema.parse({
      engine: {
        workers: {
          orders: { enabled: false, intervalMs: 30_000 },
          schedules: { enabled: true, intervalMs: 60_000 },
          reconcile: { enabled: true, intervalMs: 60_000 },
          rebalance: { enabled: false, intervalMs: 300_000 },
          alerts: { enabled: false, intervalMs: 300_000 },
          digest: { enabled: false, intervalMs: 300_000 },
        },
      },
    });
    const workers = buildBuiltinWorkers(cfg);
    expect(workers.map((w) => w.name)).toEqual(["schedules", "reconcile"]);
  });
});

// ── supervisor scheduling ───────────────────────────────────

/** Build a mock worker that records every tick + optionally throws. */
function mockWorker(name: WorkerName, opts: {
  intervalMs?: number;
  throwOnTick?: number; // 1-indexed tick at which to throw
  data?: unknown;
  ok?: boolean;
} = {}): { worker: Worker; tickCount: () => number } {
  let count = 0;
  return {
    worker: {
      name,
      intervalMs: opts.intervalMs ?? 1_000,
      async tick() {
        count += 1;
        if (opts.throwOnTick != null && count === opts.throwOnTick) {
          throw new Error(`mock throw on tick ${opts.throwOnTick}`);
        }
        return { ok: opts.ok ?? true, data: opts.data ?? { count } };
      },
    },
    tickCount: () => count,
  };
}

describe("runEngineSupervisor — scheduling + status persistence", () => {
  it("ticks every enabled worker on the first round (initial dueAt=now)", async () => {
    const a = mockWorker("orders");
    const b = mockWorker("schedules");
    const c = mockWorker("reconcile");
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      dryRun: true,
      workersOverride: [a.worker, b.worker, c.worker],
    });
    expect(a.tickCount()).toBe(1);
    expect(b.tickCount()).toBe(1);
    expect(c.tickCount()).toBe(1);
    expect(result.reason).toBe("max_ticks");
    expect(result.workers.find((w) => w.name === "orders")!.ticks).toBe(1);
    expect(result.workers.every((w) => w.successes === 1)).toBe(true);
  });

  it("writes a status file after each tick round", async () => {
    const a = mockWorker("orders", { data: { fired: 3 } });
    await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      dryRun: true,
      workersOverride: [a.worker],
    });
    const status = readEngineStatus()!;
    expect(status).not.toBeNull();
    expect(status.pid).toBe(process.pid);
    expect(status.workers.length).toBe(1);
    expect(status.workers[0].name).toBe("orders");
    expect(status.workers[0].lastTickData).toEqual({ fired: 3 });
    expect(status.workers[0].ticks).toBe(1);
    expect(status.workers[0].successes).toBe(1);
    expect(status.stopping).toBe(true); // set on finally, just before return
  });

  it("--workers filter narrows the active set", async () => {
    const a = mockWorker("orders");
    const b = mockWorker("schedules");
    const c = mockWorker("reconcile");
    await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      dryRun: true,
      workers: ["orders", "reconcile"],
      workersOverride: [a.worker, b.worker, c.worker],
    });
    expect(a.tickCount()).toBe(1);
    expect(b.tickCount()).toBe(0); // filtered out
    expect(c.tickCount()).toBe(1);
  });

  it("rejects an empty worker set with INVALID_PARAMS", async () => {
    await expect(
      runEngineSupervisor({
        logger: stubLogger,
        maxTicks: 1,
        dryRun: true,
        workers: ["orders"],
        workersOverride: [mockWorker("schedules").worker], // no overlap
      }),
    ).rejects.toThrow(/No workers enabled/);
  });

  it("requires a password when any signing worker is enabled and dry-run is false", async () => {
    await expect(
      runEngineSupervisor({
        logger: stubLogger,
        maxTicks: 1,
        // dryRun unset, no password, signing worker present
        workersOverride: [mockWorker("orders").worker],
      }),
    ).rejects.toThrow(/Engine requires a wallet password/);
  });

  it("dry-run skips the password requirement entirely", async () => {
    await expect(
      runEngineSupervisor({
        logger: stubLogger,
        maxTicks: 1,
        dryRun: true,
        workersOverride: [mockWorker("orders").worker],
      }),
    ).resolves.toMatchObject({ reason: "max_ticks" });
  });

  it("--workers reconcile alone runs without a password (reconcile is read-only)", async () => {
    await expect(
      runEngineSupervisor({
        logger: stubLogger,
        maxTicks: 1,
        workers: ["reconcile"],
        workersOverride: [mockWorker("reconcile").worker],
      }),
    ).resolves.toMatchObject({ reason: "max_ticks" });
  });
});

// ── error isolation ─────────────────────────────────────────

describe("runEngineSupervisor — error isolation", () => {
  it("a worker that throws does NOT take down its peers", async () => {
    const good = mockWorker("orders");
    const bad = mockWorker("schedules", { throwOnTick: 1 });
    const reconcile = mockWorker("reconcile");
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      dryRun: true,
      workersOverride: [good.worker, bad.worker, reconcile.worker],
    });
    expect(result.reason).toBe("max_ticks");
    // good + reconcile ticked successfully; bad recorded a failure
    const byName = Object.fromEntries(result.workers.map((w) => [w.name, w]));
    expect(byName.orders.successes).toBe(1);
    expect(byName.orders.failures).toBe(0);
    expect(byName.schedules.successes).toBe(0);
    expect(byName.schedules.failures).toBe(1);
    expect(byName.schedules.lastError).toMatch(/mock throw/);
    expect(byName.reconcile.successes).toBe(1);
  });

  it("a worker returning ok=false counts as failure", async () => {
    const w = mockWorker("orders", { ok: false });
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      dryRun: true,
      workersOverride: [w.worker],
    });
    expect(result.workers[0].successes).toBe(0);
    expect(result.workers[0].failures).toBe(1);
  });
});

// ── process lock ────────────────────────────────────────────

describe("runEngineSupervisor — process lock", () => {
  it("refuses to start when another process holds the engine lock", async () => {
    // Acquire the lock manually as if a prior engine were running.
    const heldByOther = acquireLock(tmpDataDir, "engine", "external-test-holder");
    try {
      await expect(
        runEngineSupervisor({
          logger: stubLogger,
          maxTicks: 1,
          dryRun: true,
          workersOverride: [mockWorker("orders").worker],
        }),
      ).rejects.toMatchObject({
        code: "WALLET_LOCKED",
      });
    } finally {
      heldByOther.release();
    }
  });

  it("releases the lock on completion so a follow-up run can acquire it", async () => {
    await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      dryRun: true,
      workersOverride: [mockWorker("orders").worker],
    });
    // Lock should be released — a new acquireLock succeeds.
    const lock = acquireLock(tmpDataDir, "engine", "follow-up");
    expect(lock).toBeTruthy();
    lock.release();
  });

  it("releases the lock even when the supervisor throws fatally", async () => {
    // Force a fatal error by passing an empty workers set; the lock must
    // still release in the finally block before the throw propagates.
    try {
      await runEngineSupervisor({
        logger: stubLogger,
        maxTicks: 1,
        dryRun: true,
        workers: ["orders"],
        workersOverride: [mockWorker("schedules").worker], // disjoint → throws
      });
    } catch {
      // expected
    }
    // Lock should NOT be held now.
    const lock = acquireLock(tmpDataDir, "engine", "after-throw");
    expect(lock).toBeTruthy();
    lock.release();
  });
});

// ── multi-round scheduling ───────────────────────────────────

describe("runEngineSupervisor — multi-round scheduling with fake clock", () => {
  it("a slow-interval worker only ticks once even when a fast worker ticks many times", async () => {
    // Fake clock: advances 1000ms per call so each scheduling iteration
    // jumps ahead by ~1s. With intervals 1s vs 10s, in 3 supervisor
    // rounds the slow worker should fire ~1 time vs fast ~3.
    let t = 0;
    const fakeNow = () => t;
    const fast = mockWorker("orders", { intervalMs: 1_000 });
    const slow = mockWorker("schedules", { intervalMs: 10_000 });
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 3,
      dryRun: true,
      now: () => {
        const v = t;
        t += 1_000; // advance the fake clock on every read
        return v;
      },
      workersOverride: [fast.worker, slow.worker],
    });
    expect(result.reason).toBe("max_ticks");
    // Fast worker fired on every round (3); slow only on the first
    // (interval not yet elapsed for the other two).
    expect(fast.tickCount()).toBe(3);
    expect(slow.tickCount()).toBe(1);
    // Suppress unused-variable warning.
    void fakeNow;
  });
});

// ── iter33: resilience integration ──────────────────────────

describe("runEngineSupervisor — iter33 resilience", () => {
  // Mock worker whose result depends on the tick number — lets us
  // drive the supervisor through fail-then-recover transitions
  // without time travel.
  function flakyWorker(name: WorkerName, schedule: ("ok" | "fail")[]): { worker: Worker; ticks: number } {
    const state = { ticks: 0, name } as { ticks: number; name: WorkerName };
    return {
      worker: {
        name,
        intervalMs: 1_000,
        async tick() {
          const outcome = schedule[state.ticks] ?? "ok";
          state.ticks += 1;
          if (outcome === "fail") return { ok: false, error: "mock failure" };
          return { ok: true, data: { tick: state.ticks } };
        },
      },
      get ticks() {
        return state.ticks;
      },
    } as { worker: Worker; ticks: number };
  }

  it("records consecutiveFailures + degraded after threshold failures", async () => {
    const f = flakyWorker("orders", ["fail", "fail", "fail"]);
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 3,
      dryRun: true,
      workersOverride: [f.worker],
    });
    const w = result.workers[0];
    expect(w.failures).toBe(3);
    expect(w.consecutiveFailures).toBe(3);
    expect(w.degraded).toBe(true);
    expect(w.effectiveIntervalMs).toBeGreaterThan(1_000);
  });

  it("recovers + restores base interval after a successful tick", async () => {
    const f = flakyWorker("orders", ["fail", "fail", "fail", "fail", "ok"]);
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 5,
      dryRun: true,
      workersOverride: [f.worker],
    });
    const w = result.workers[0];
    expect(w.degraded).toBe(false);
    expect(w.consecutiveFailures).toBe(0);
    expect(w.effectiveIntervalMs).toBe(1_000); // base
    expect(w.successes).toBe(1);
    expect(w.failures).toBe(4);
  });

  it("populates tickTiming summary after first tick", async () => {
    const f = flakyWorker("orders", ["ok"]);
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      dryRun: true,
      workersOverride: [f.worker],
    });
    const w = result.workers[0];
    expect(w.tickTiming).not.toBeNull();
    expect(w.tickTiming!.count).toBe(1);
  });

  it("alerts worker counts as read-only (no password required)", async () => {
    // Build a fake "alerts" worker explicitly to verify the readonly
    // bypass in the supervisor's password gate.
    const alerts = flakyWorker("alerts" as never, ["ok"]);
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      // no password, not dryRun — alerts alone should NOT require one
      workersOverride: [alerts.worker],
    });
    expect(result.workers[0].name).toBe("alerts");
    expect(result.workers[0].successes).toBe(1);
  });
});

// ── iter41: concurrent worker execution ─────────────────────

describe("runEngineSupervisor — iter41 concurrent ticks", () => {
  /** Build a mock worker whose tick takes a measurable amount of
   *  wall-clock time. Used to verify that two due workers run
   *  concurrently (wall-clock ≈ MAX(durations) not SUM). */
  function slowWorker(name: WorkerName, durationMs: number): { worker: Worker; tickStarts: number[]; tickEnds: number[] } {
    const tickStarts: number[] = [];
    const tickEnds: number[] = [];
    return {
      worker: {
        name,
        intervalMs: 1_000,
        async tick() {
          tickStarts.push(Date.now());
          await new Promise((r) => setTimeout(r, durationMs));
          tickEnds.push(Date.now());
          return { ok: true, data: null };
        },
      },
      tickStarts,
      tickEnds,
    };
  }

  it("two due workers tick concurrently — wall clock ≈ MAX, not SUM", async () => {
    const a = slowWorker("orders", 200);
    const b = slowWorker("schedules", 200);
    const t0 = Date.now();
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      dryRun: true,
      workersOverride: [a.worker, b.worker],
    });
    const elapsed = Date.now() - t0;
    expect(result.reason).toBe("max_ticks");
    expect(a.tickStarts).toHaveLength(1);
    expect(b.tickStarts).toHaveLength(1);
    // Concurrent ticks: both worker tick starts within the same
    // tight window (≈ same ms). If sequential, b would start at
    // a.start + 200ms.
    const startDelta = Math.abs(a.tickStarts[0] - b.tickStarts[0]);
    expect(startDelta).toBeLessThan(50); // generous slack for CI
    // Wall clock for the round should be ≈ 200ms (max), NOT
    // 400ms (sum). Allow CI noise.
    expect(elapsed).toBeLessThan(380);
  });

  it("slow worker doesn't block status updates for other workers in the same round", async () => {
    // Two workers: one fast, one slow. After the round, BOTH
    // status entries should be updated (ticks=1 each).
    const fast = slowWorker("orders", 10);
    const slow = slowWorker("schedules", 150);
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      dryRun: true,
      workersOverride: [fast.worker, slow.worker],
    });
    const fastStatus = result.workers.find((w) => w.name === "orders")!;
    const slowStatus = result.workers.find((w) => w.name === "schedules")!;
    expect(fastStatus.ticks).toBe(1);
    expect(slowStatus.ticks).toBe(1);
    expect(fastStatus.successes).toBe(1);
    expect(slowStatus.successes).toBe(1);
  });

  it("worker that throws doesn't crash the supervisor or block the other", async () => {
    let bTicks = 0;
    const a: Worker = {
      name: "orders" as WorkerName,
      intervalMs: 1_000,
      async tick() {
        throw new Error("synchronous tick failure");
      },
    };
    const b: Worker = {
      name: "schedules" as WorkerName,
      intervalMs: 1_000,
      async tick() {
        bTicks += 1;
        return { ok: true, data: null };
      },
    };
    const result = await runEngineSupervisor({
      logger: stubLogger,
      maxTicks: 1,
      dryRun: true,
      workersOverride: [a, b],
    });
    expect(result.reason).toBe("max_ticks");
    expect(bTicks).toBe(1);
    expect(result.workers.find((w) => w.name === "orders")!.failures).toBe(1);
    expect(result.workers.find((w) => w.name === "schedules")!.successes).toBe(1);
  });
});
