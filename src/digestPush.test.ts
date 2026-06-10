/**
 * Digest-push worker tests. All gating logic is injectable (now,
 * notifyFn, markerPath, config object) so everything runs offline
 * against the seeded test DB.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-digestpush-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { runDigestPushTick } = await import("./digestPush.js");
const { openDb, closeDb, insertAlertEvent } = await import("./db.js");
const { loadConfig } = await import("./config.js");

const markerPath = join(tmpDataDir, ".digest.test.marker");

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
  db.exec("DELETE FROM alert_events");
  db.exec("DELETE FROM strategy_alert_state");
  db.exec("DELETE FROM trades");
  if (existsSync(markerPath)) unlinkSync(markerPath);
  vi.clearAllMocks();
});

function cfg(over: Partial<{ enabled: boolean; hourUtc: number; window: string; minVerdict: "healthy" | "attention" | "critical" }> = {}) {
  const base = loadConfig();
  return {
    ...base,
    notifications: {
      ...base.notifications,
      digest: { enabled: true, hourUtc: 9, window: "24h", minVerdict: "healthy" as const, ...over },
    },
  } as never;
}

const NOON = new Date("2026-06-11T12:00:00Z");

describe("runDigestPushTick — gating", () => {
  it("skips when notifications.digest is disabled", async () => {
    const notifyFn = vi.fn();
    const r = await runDigestPushTick({ config: cfg({ enabled: false }), logger: noopLogger, notifyFn, now: NOON, markerPath });
    expect(r.skipped).toBe(true);
    expect(r.reason).toContain("enabled=false");
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("skips before the configured hour, sends after", async () => {
    const notifyFn = vi.fn();
    const early = await runDigestPushTick({
      config: cfg({ hourUtc: 14 }),
      logger: noopLogger, notifyFn,
      now: new Date("2026-06-11T13:59:00Z"),
      markerPath,
    });
    expect(early.skipped).toBe(true);
    expect(early.reason).toContain("before send hour");

    const onTime = await runDigestPushTick({
      config: cfg({ hourUtc: 14 }),
      logger: noopLogger, notifyFn,
      now: new Date("2026-06-11T14:01:00Z"),
      markerPath,
    });
    expect(onTime.sent).toBe(true);
    expect(notifyFn).toHaveBeenCalledTimes(1);
  });

  it("sends once per UTC day (marker dedup), re-arms the next day", async () => {
    const notifyFn = vi.fn();
    const r1 = await runDigestPushTick({ config: cfg(), logger: noopLogger, notifyFn, now: NOON, markerPath });
    expect(r1.sent).toBe(true);
    expect(readFileSync(markerPath, "utf8")).toBe("2026-06-11");

    const r2 = await runDigestPushTick({ config: cfg(), logger: noopLogger, notifyFn, now: NOON, markerPath });
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe("already sent today");
    expect(notifyFn).toHaveBeenCalledTimes(1);

    const r3 = await runDigestPushTick({
      config: cfg(), logger: noopLogger, notifyFn,
      now: new Date("2026-06-12T12:00:00Z"),
      markerPath,
    });
    expect(r3.sent).toBe(true);
    expect(notifyFn).toHaveBeenCalledTimes(2);
  });

  it("minVerdict=attention: a healthy day is gated WITHOUT marking, sends the moment health degrades", async () => {
    const notifyFn = vi.fn();
    const gated = await runDigestPushTick({
      config: cfg({ minVerdict: "attention" }),
      logger: noopLogger, notifyFn, now: NOON, markerPath,
    });
    expect(gated.skipped).toBe(true);
    expect(gated.reason).toContain("below minVerdict");
    expect(existsSync(markerPath)).toBe(false); // NOT marked — can still send later today

    // An alert fires mid-day → verdict escalates to attention.
    insertAlertEvent({
      at: "2026-06-11T13:00:00Z",
      tag: "x", ruleType: "failure_streak", event: "fired", severity: "critical",
    });
    const sent = await runDigestPushTick({
      config: cfg({ minVerdict: "attention" }),
      logger: noopLogger, notifyFn,
      now: new Date("2026-06-11T13:05:00Z"),
      markerPath,
    });
    expect(sent.sent).toBe(true);
    expect(sent.verdict).toBe("attention");
  });
});

describe("runDigestPushTick — payload", () => {
  it("carries the shared markdown body + verdict-mapped severity + daily dedupKey", async () => {
    insertAlertEvent({
      at: "2026-06-11T10:00:00Z",
      tag: "x", ruleType: "failure_streak", event: "fired", severity: "critical",
    });
    const notifyFn = vi.fn();
    await runDigestPushTick({ config: cfg(), logger: noopLogger, notifyFn, now: NOON, markerPath });
    const ev = notifyFn.mock.calls[0][0];
    expect(ev.event).toBe("digest.daily");
    expect(ev.severity).toBe("warn"); // attention → warn
    expect(ev.title).toContain("ATTENTION");
    expect(ev.body).toContain("Tradekit digest"); // shared slack renderer header
    expect(ev.fields.alertsFired).toBe(1);
    expect(ev.dedupKey).toBe("digest.daily:2026-06-11");
  });

  it("invalid window config degrades to a skipped tick (worker never throws)", async () => {
    const notifyFn = vi.fn();
    const r = await runDigestPushTick({
      config: cfg({ window: "not-a-window" }),
      logger: noopLogger, notifyFn, now: NOON, markerPath,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("invalid window");
    expect(notifyFn).not.toHaveBeenCalled();
  });
});
