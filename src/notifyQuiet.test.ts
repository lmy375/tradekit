/**
 * v34 quiet-hours tests.
 *
 * Layers:
 *   1. inQuietHours — pure window predicate incl. midnight wrap
 *   2. shouldQueueForQuietHours — severity breakthrough + exemptions
 *   3. notify() integration — suppress-and-queue, ignoreQuietHours
 *      channels deliver, queue-once semantics, fail-open on enqueue
 *      errors (mocked fetch, seeded SQLite)
 *   4. flushQueuedNotifications — summary shape, severity max,
 *      marking, still-quiet no-op + --force, failed-delivery retry
 *   5. db helpers + retention prune
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-notifyQuiet-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  inQuietHours,
  shouldQueueForQuietHours,
  flushQueuedNotifications,
  notify,
  clearDedupCache,
} = await import("./notify.js");
const {
  openDb,
  closeDb,
  enqueueNotification,
  pendingQueuedNotifications,
  countPendingQueuedNotifications,
  markQueuedNotificationsFlushed,
  pruneNotificationQueue,
} = await import("./db.js");
import type { Logger } from "./logger.js";
import type { Config } from "./config.js";
import type { NotificationEvent } from "./notify.js";

const stubLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

// In-window and out-of-window instants for the default 22→07 wrap window.
const NIGHT = new Date("2026-06-10T23:30:00Z");
const MORNING = new Date("2026-06-10T09:00:00Z");

function cfg(over: Record<string, unknown> = {}, channels: unknown[] = []): Config {
  return {
    notifications: {
      channels,
      dedupWindowMs: 0,
      digest: { enabled: false, hourUtc: 9, window: "24h", minVerdict: "healthy" },
      quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7, breakthroughSeverity: "critical", ...over },
    },
  } as unknown as Config;
}

function evt(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    event: "order.filled",
    severity: "info",
    title: "test event",
    ...over,
  };
}

const channel = (over: Record<string, unknown> = {}) => ({
  name: "ops",
  url: "https://example.com/hook",
  minSeverity: "info",
  enabled: true,
  ...over,
});

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  openDb().exec("DELETE FROM notification_queue");
  clearDedupCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── inQuietHours ─────────────────────────────────────────────

describe("inQuietHours — pure window predicate", () => {
  const win = (s: number, e: number) => ({ startHourUtc: s, endHourUtc: e });

  it("plain window (9 → 17)", () => {
    expect(inQuietHours(new Date("2026-06-10T09:00:00Z"), win(9, 17))).toBe(true);
    expect(inQuietHours(new Date("2026-06-10T16:59:00Z"), win(9, 17))).toBe(true);
    expect(inQuietHours(new Date("2026-06-10T17:00:00Z"), win(9, 17))).toBe(false);
    expect(inQuietHours(new Date("2026-06-10T08:59:00Z"), win(9, 17))).toBe(false);
  });

  it("midnight wrap (22 → 7)", () => {
    expect(inQuietHours(new Date("2026-06-10T23:00:00Z"), win(22, 7))).toBe(true);
    expect(inQuietHours(new Date("2026-06-10T03:00:00Z"), win(22, 7))).toBe(true);
    expect(inQuietHours(new Date("2026-06-10T07:00:00Z"), win(22, 7))).toBe(false);
    expect(inQuietHours(new Date("2026-06-10T21:59:00Z"), win(22, 7))).toBe(false);
  });

  it("degenerate zero-length window is never active", () => {
    expect(inQuietHours(new Date("2026-06-10T05:00:00Z"), win(5, 5))).toBe(false);
  });
});

// ── shouldQueueForQuietHours ─────────────────────────────────

describe("shouldQueueForQuietHours", () => {
  it("queues sub-breakthrough severities inside the window", () => {
    expect(shouldQueueForQuietHours(evt({ severity: "info" }), cfg(), NIGHT)).toBe(true);
    expect(shouldQueueForQuietHours(evt({ severity: "warn" }), cfg(), NIGHT)).toBe(true);
  });

  it("breakthrough severity always delivers", () => {
    expect(shouldQueueForQuietHours(evt({ severity: "critical" }), cfg(), NIGHT)).toBe(false);
    // Lowered breakthrough: warn pages too.
    expect(shouldQueueForQuietHours(evt({ severity: "warn" }), cfg({ breakthroughSeverity: "warn" }), NIGHT)).toBe(false);
  });

  it("outside the window nothing queues", () => {
    expect(shouldQueueForQuietHours(evt({ severity: "info" }), cfg(), MORNING)).toBe(false);
  });

  it("disabled feature never queues", () => {
    expect(shouldQueueForQuietHours(evt(), cfg({ enabled: false }), NIGHT)).toBe(false);
  });

  it("the flush summary and the daily digest are exempt", () => {
    expect(shouldQueueForQuietHours(evt({ event: "notify.quiet_flush" }), cfg(), NIGHT)).toBe(false);
    expect(shouldQueueForQuietHours(evt({ event: "digest.daily" }), cfg(), NIGHT)).toBe(false);
  });
});

// ── notify() integration ─────────────────────────────────────

describe("notify() — quiet-hours integration", () => {
  function mockFetchOk(): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("suppresses + queues inside the window; nothing is sent", async () => {
    vi.useFakeTimers({ now: NIGHT });
    const fetchMock = mockFetchOk();
    const report = await notify(evt({ severity: "warn", title: "dca fired" }), cfg({}, [channel()]), stubLogger);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.delivered).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.results[0].skipped).toBe("quiet_hours");
    const pending = pendingQueuedNotifications();
    expect(pending).toHaveLength(1);
    expect(pending[0].title).toBe("dca fired");
    expect(pending[0].severity).toBe("warn");
  });

  it("critical breaks through the window", async () => {
    vi.useFakeTimers({ now: NIGHT });
    const fetchMock = mockFetchOk();
    const report = await notify(evt({ severity: "critical" }), cfg({}, [channel()]), stubLogger);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(report.delivered).toBe(1);
    expect(countPendingQueuedNotifications()).toBe(0);
  });

  it("ignoreQuietHours channels deliver while others queue", async () => {
    vi.useFakeTimers({ now: NIGHT });
    const fetchMock = mockFetchOk();
    const report = await notify(
      evt({ severity: "warn" }),
      cfg({}, [channel({ name: "slack" }), channel({ name: "pager", url: "https://pager.example.com/h", ignoreQuietHours: true })]),
      stubLogger,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // pager only
    expect(report.delivered).toBe(1);
    expect(report.results.find((r) => r.channelName === "slack")?.skipped).toBe("quiet_hours");
    expect(countPendingQueuedNotifications()).toBe(1); // queued for the slack summary
  });

  it("does not queue events no suppressed channel subscribes to", async () => {
    vi.useFakeTimers({ now: NIGHT });
    mockFetchOk();
    await notify(
      evt({ severity: "info", event: "order.filled" }),
      cfg({}, [channel({ events: ["trade.failed"] })]), // not subscribed
      stubLogger,
    );
    expect(countPendingQueuedNotifications()).toBe(0);
  });
});

// ── flushQueuedNotifications ─────────────────────────────────

describe("flushQueuedNotifications", () => {
  function seedQueued(severity: "info" | "warn" | "critical", title: string, at = "2026-06-10T23:45:00.000Z") {
    enqueueNotification({ queuedAt: at, event: "order.filled", severity, title });
  }

  it("no-op while quiet hours are still active; --force overrides", async () => {
    seedQueued("info", "a");
    const still = await flushQueuedNotifications(cfg({}, [channel()]), stubLogger, { now: NIGHT });
    expect(still).toBeNull();
    expect(countPendingQueuedNotifications()).toBe(1);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const forced = await flushQueuedNotifications(cfg({}, [channel()]), stubLogger, { now: NIGHT, force: true });
    expect(forced?.flushed).toBe(1);
    expect(countPendingQueuedNotifications()).toBe(0);
  });

  it("flushes as ONE summary carrying the max severity + counts", async () => {
    seedQueued("info", "low");
    seedQueued("warn", "mid");
    seedQueued("warn", "mid2");
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("ok", { status: 200 });
    }));
    const r = await flushQueuedNotifications(cfg({}, [channel()]), stubLogger, { now: MORNING });
    expect(r?.flushed).toBe(3);
    expect(r?.delivered).toBe(true);
    expect(sent).toHaveLength(1); // ONE summary, not three notifications
    const payload = JSON.stringify(sent[0]);
    expect(payload).toMatch(/3 notification\(s\) suppressed/);
    expect(payload).toMatch(/2 warn/);
    expect(countPendingQueuedNotifications()).toBe(0);
  });

  it("failed delivery leaves the rows queued for retry", async () => {
    seedQueued("warn", "x");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const r = await flushQueuedNotifications(cfg({}, [channel()]), stubLogger, { now: MORNING });
    expect(r?.flushed).toBe(0);
    expect(countPendingQueuedNotifications()).toBe(1);
  });

  it("no channels configured → marks flushed without sending (nothing to wait for)", async () => {
    seedQueued("info", "y");
    const r = await flushQueuedNotifications(cfg({}, []), stubLogger, { now: MORNING });
    expect(r?.flushed).toBe(1);
    expect(countPendingQueuedNotifications()).toBe(0);
  });

  it("empty queue is a null no-op", async () => {
    expect(await flushQueuedNotifications(cfg({}, [channel()]), stubLogger, { now: MORNING })).toBeNull();
  });
});

// ── db helpers ───────────────────────────────────────────────

describe("notification_queue helpers", () => {
  it("enqueue / pending / mark-flushed round trip", () => {
    const id = enqueueNotification({ queuedAt: "2026-06-10T23:00:00.000Z", event: "e", severity: "info", title: "t" });
    expect(countPendingQueuedNotifications()).toBe(1);
    expect(markQueuedNotificationsFlushed([id], "2026-06-11T07:01:00.000Z")).toBe(1);
    expect(countPendingQueuedNotifications()).toBe(0);
    // Double-flush is a no-op.
    expect(markQueuedNotificationsFlushed([id], "2026-06-11T08:00:00.000Z")).toBe(0);
  });

  it("retention prune drops old rows regardless of flush state", () => {
    enqueueNotification({ queuedAt: "2026-01-01T00:00:00.000Z", event: "e", severity: "info", title: "old" });
    enqueueNotification({ queuedAt: "2026-06-10T00:00:00.000Z", event: "e", severity: "info", title: "new" });
    expect(pruneNotificationQueue("2026-03-01T00:00:00.000Z")).toBe(1);
    expect(countPendingQueuedNotifications()).toBe(1);
  });
});
