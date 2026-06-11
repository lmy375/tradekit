// Tests for dbLifecycle.ts (iter40). Mix of pure (config-driven
// retention reports) + integration (real SQLite VACUUM INTO,
// PRAGMA integrity_check, file system operations).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-dblifecycle-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  runIntegrityCheck,
  pruneByRetention,
  createBackup,
  rotateBackups,
  autoBackup,
  readDbStats,
} = await import("./dbLifecycle.js");
const {
  openDb,
  closeDb,
  insertAudit,
  recordPaperTrade,
  insertOrderCheckEntry,
  insertOrder,
} = await import("./db.js");
import type { DbConfig } from "./config.js";

beforeAll(() => openDb());
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM order_check_log");
  db.exec("DELETE FROM engine_events");
  db.exec("DELETE FROM alert_events");
  db.exec("DELETE FROM schedule_check_log");
  db.exec("DELETE FROM rebalance_check_log");
  db.exec("DELETE FROM trades");
  db.exec("DELETE FROM orders");
});

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const defaultDb: DbConfig = {
  retention: {
    enabled: false,
    auditLogDays: null,
    paperTradesDays: null,
    orderCheckLogDays: null,
    engineEventsDays: null,
    alertEventsDays: null,
      notificationQueueDays: null,
      configHistoryDays: null,
    scheduleCheckLogDays: null,
    rebalanceCheckLogDays: null,
    failedTradesDays: null,
        idempotencyKeysDays: null,
  },
  backup: { enabled: false, intervalHours: 24, destDir: "backups", retainCount: 7 },
  integrityCheck: { enabled: false, intervalHours: 24 },
};

function withRetention(over: Partial<DbConfig["retention"]>): DbConfig {
  return { ...defaultDb, retention: { ...defaultDb.retention, ...over } };
}

// ── runIntegrityCheck ───────────────────────────────────────

describe("runIntegrityCheck", () => {
  it("returns ok=true for a clean DB", () => {
    const r = runIntegrityCheck();
    expect(r.ok).toBe(true);
    expect(r.errorCount).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── pruneByRetention ───────────────────────────────────────

describe("pruneByRetention", () => {
  function seedAudit(daysAgo: number) {
    const iso = new Date(Date.now() - daysAgo * 86400 * 1000).toISOString();
    insertAudit({
      timestamp: iso,
      caller: "test",
      tool: "noop",
      account: "default",
      chain: "base",
      params_json: null,
      simulation_json: null,
      result: null,
      error_code: null,
      error_message: null,
      tx_hash: null,
    } as never);
  }

  function seedPaperTrade(daysAgo: number) {
    recordPaperTrade({
      timestamp: new Date(Date.now() - daysAgo * 86400 * 1000).toISOString(),
      source_type: "manual",
      source_id: null,
      chain: "base",
      account: "default",
      direction: "buy",
      base_token: WETH,
      base_symbol: "ETH",
      base_amount: "1",
      quote_token: USDC,
      quote_symbol: "USDC",
      quote_amount: "2500",
      price: "2500",
      slippage_bps: 50,
      strategy: null,
      notes: null,
    });
  }

  it("when retention disabled, all tables report skipped", () => {
    seedAudit(100);
    const r = pruneByRetention(defaultDb);
    expect(r.totalRowsRemoved).toBe(0);
    expect(r.tables.every((t) => t.status === "skipped")).toBe(true);
    // Existing row should NOT be touched.
    const db = openDb();
    const cnt = (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    expect(cnt).toBe(1);
  });

  it("when retention enabled but per-table days unset, table reports skipped with reason", () => {
    const r = pruneByRetention(withRetention({ enabled: true }));
    expect(r.tables.find((t) => t.table === "audit_log")?.status).toBe("skipped");
    expect(r.tables.find((t) => t.table === "audit_log")?.reason).toMatch(/unset/);
  });

  it("audit_log days cutoff deletes rows older than cutoff", () => {
    seedAudit(100);
    seedAudit(50);
    seedAudit(5);
    const r = pruneByRetention(withRetention({ enabled: true, auditLogDays: 30 }));
    const auditRow = r.tables.find((t) => t.table === "audit_log")!;
    expect(auditRow.status).toBe("ran");
    expect(auditRow.rowsRemoved).toBe(2); // 100d + 50d both > 30d
    expect(r.totalRowsRemoved).toBe(2);
    const db = openDb();
    const cnt = (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    expect(cnt).toBe(1);
  });

  it("paper_trades retention runs independently", () => {
    seedPaperTrade(60);
    seedPaperTrade(15);
    const r = pruneByRetention(withRetention({ enabled: true, paperTradesDays: 30 }));
    const row = r.tables.find((t) => t.table === "paper_trades")!;
    expect(row.rowsRemoved).toBe(1);
  });

  it("multiple tables enabled simultaneously", () => {
    seedAudit(100);
    seedPaperTrade(100);
    const r = pruneByRetention(
      withRetention({ enabled: true, auditLogDays: 30, paperTradesDays: 30 }),
    );
    expect(r.totalRowsRemoved).toBe(2);
    expect(r.tables.find((t) => t.table === "audit_log")?.rowsRemoved).toBe(1);
    expect(r.tables.find((t) => t.table === "paper_trades")?.rowsRemoved).toBe(1);
  });

  it("rows within the retention window are NOT pruned", () => {
    seedAudit(10);
    const r = pruneByRetention(withRetention({ enabled: true, auditLogDays: 30 }));
    expect(r.totalRowsRemoved).toBe(0);
    const db = openDb();
    const cnt = (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    expect(cnt).toBe(1);
  });

  it("order_check_log retention works", () => {
    const orderId = insertOrder({
      side: "sell",
      trigger_type: "price_below",
      target_price_usd: 1900,
      trail_pct: null,
      chain: "base",
      account: "default",
      base_token: WETH,
      base_symbol: "ETH",
      quote_token: USDC,
      quote_symbol: "USDC",
      base_amount: "1",
      quote_amount: null,
      slippage_bps: 50,
      auto_slippage: false,
      expires_at: null,
      strategy: null,
      note: null,
      group_id: null,
    });
    insertOrderCheckEntry({
      orderId,
      checkedAt: new Date(Date.now() - 60 * 86400 * 1000).toISOString(),
      priceUsd: 1950,
      waterMarkUsd: null,
      thresholdUsd: 1900,
      decision: "triggered_skipped",
      notes: null,
    });
    insertOrderCheckEntry({
      orderId,
      checkedAt: new Date().toISOString(),
      priceUsd: 1900,
      waterMarkUsd: null,
      thresholdUsd: 1900,
      decision: "triggered_fired",
      notes: null,
    });
    const r = pruneByRetention(withRetention({ enabled: true, orderCheckLogDays: 30 }));
    expect(r.tables.find((t) => t.table === "order_check_log")?.rowsRemoved).toBe(1);
  });

  it("schedule_check_log + rebalance_check_log retention works (v29)", async () => {
    const { insertScheduleCheckEntry, insertRebalanceCheckEntry } = await import("./db.js");
    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    const fresh = new Date().toISOString();
    insertScheduleCheckEntry({ scheduleId: 1, checkedAt: old, decision: "fired", runNumber: 1 });
    insertScheduleCheckEntry({ scheduleId: 1, checkedAt: fresh, decision: "fired", runNumber: 2 });
    insertRebalanceCheckEntry({ planId: 1, checkedAt: old, decision: "in_band", maxDriftPct: 2 });
    insertRebalanceCheckEntry({ planId: 1, checkedAt: fresh, decision: "fired", maxDriftPct: 8 });
    const r = pruneByRetention(withRetention({ enabled: true, scheduleCheckLogDays: 30, rebalanceCheckLogDays: 30 }));
    expect(r.tables.find((t) => t.table === "schedule_check_log")?.rowsRemoved).toBe(1);
    expect(r.tables.find((t) => t.table === "rebalance_check_log")?.rowsRemoved).toBe(1);
  });

  it("alert_events retention works (v28)", async () => {
    const { insertAlertEvent } = await import("./db.js");
    insertAlertEvent({
      at: new Date(Date.now() - 60 * 86400 * 1000).toISOString(),
      tag: "dca-eth",
      ruleType: "staleness",
      event: "fired",
      severity: "warn",
    });
    insertAlertEvent({
      at: new Date().toISOString(),
      tag: "dca-eth",
      ruleType: "staleness",
      event: "resolved",
      severity: "info",
      durationSeconds: 60,
    });
    const r = pruneByRetention(withRetention({ enabled: true, alertEventsDays: 30 }));
    expect(r.tables.find((t) => t.table === "alert_events")?.rowsRemoved).toBe(1);
    const db = openDb();
    const left = (db.prepare("SELECT COUNT(*) AS n FROM alert_events").get() as { n: number }).n;
    expect(left).toBe(1);
  });
});

// ── createBackup ───────────────────────────────────────────

describe("createBackup", () => {
  it("creates a valid SQLite copy via VACUUM INTO", () => {
    const destPath = join(tmpDataDir, "test-backup.db");
    const r = createBackup(destPath);
    expect(r.ok).toBe(true);
    expect(r.destPath).toBe(destPath);
    expect(r.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(destPath)).toBe(true);
    // Cleanup.
    rmSync(destPath);
  });

  it("resolves relative paths against DATA_DIR", () => {
    const r = createBackup("relative-test.db");
    expect(r.ok).toBe(true);
    expect(r.destPath).toBe(join(tmpDataDir, "relative-test.db"));
    rmSync(r.destPath);
  });

  it("refuses to overwrite an existing destination", () => {
    const destPath = join(tmpDataDir, "collision.db");
    writeFileSync(destPath, "existing");
    const r = createBackup(destPath);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists/);
    // Original file untouched.
    expect(statSync(destPath).size).toBe("existing".length);
    rmSync(destPath);
  });

  it("creates parent dirs that don't exist yet", () => {
    const destPath = join(tmpDataDir, "nested", "deep", "backup.db");
    const r = createBackup(destPath);
    expect(r.ok).toBe(true);
    rmSync(join(tmpDataDir, "nested"), { recursive: true, force: true });
  });
});

// ── rotateBackups ───────────────────────────────────────────

describe("rotateBackups", () => {
  it("keeps the most recent N + deletes the rest", async () => {
    const dir = join(tmpDataDir, "rotation");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    // Create 5 files with staggered mtimes.
    for (let i = 0; i < 5; i++) {
      const p = join(dir, `backup-${i}.db`);
      writeFileSync(p, `data${i}`);
      // SetMtime via utimes.
      const { utimesSync } = await import("node:fs");
      const mtime = new Date(Date.now() - (5 - i) * 86400 * 1000);
      utimesSync(p, mtime, mtime);
    }
    const r = rotateBackups(dir, 3);
    expect(r.total).toBe(5);
    expect(r.kept).toBe(3);
    expect(r.removed).toHaveLength(2);
    // The 2 oldest (backup-0, backup-1) should be gone.
    expect(r.removed.sort()).toEqual(["backup-0.db", "backup-1.db"]);
    const remaining = readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
    expect(remaining).toEqual(["backup-2.db", "backup-3.db", "backup-4.db"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores non-.db files in the dir", async () => {
    const dir = join(tmpDataDir, "rotation-noise");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "backup-1.db"), "x");
    writeFileSync(join(dir, "readme.txt"), "noise");
    const r = rotateBackups(dir, 5);
    expect(r.total).toBe(1);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(dir, "readme.txt"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns zero counts on a missing directory", () => {
    const r = rotateBackups(join(tmpDataDir, "does-not-exist"), 7);
    expect(r.total).toBe(0);
    expect(r.kept).toBe(0);
    expect(r.removed).toEqual([]);
  });
});

// ── autoBackup composes backup + rotate ───────────────────

describe("autoBackup", () => {
  it("creates a timestamped backup + rotates older ones", async () => {
    const cfg: DbConfig = {
      ...defaultDb,
      backup: { enabled: true, intervalHours: 24, destDir: "auto-backups", retainCount: 2 },
    };
    // Pre-create 3 older fake backups to exercise rotation.
    const dir = join(tmpDataDir, "auto-backups");
    const { mkdirSync, utimesSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      const p = join(dir, `tradekit-${i.toString().padStart(14, "2")}.db`);
      writeFileSync(p, "old");
      const t = new Date(Date.now() - (3 - i) * 86400 * 1000);
      utimesSync(p, t, t);
    }
    const r = autoBackup(cfg);
    expect(r.ok).toBe(true);
    // The new backup file exists.
    expect(existsSync(r.destPath)).toBe(true);
    // Rotation removed the 2 oldest (we have 4 total now: 3 old + 1 new, retain 2 → remove 2).
    expect(r.rotation).not.toBeNull();
    expect(r.rotation!.kept).toBe(2);
    expect(r.rotation!.removed.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns ok=false when backup fails (e.g. permission denied on dest dir)", async () => {
    const cfg: DbConfig = {
      ...defaultDb,
      backup: { enabled: true, intervalHours: 24, destDir: "/proc/forbidden-tradekit-backup", retainCount: 7 },
    };
    const r = autoBackup(cfg);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.rotation).toBeNull();
  });
});

// ── readDbStats ────────────────────────────────────────────

describe("readDbStats", () => {
  it("returns file stats + per-table row counts", () => {
    const r = readDbStats();
    expect(r.path).toContain("tradekit.db");
    expect(r.mainSizeBytes).toBeGreaterThan(0);
    expect(typeof r.rowCounts).toBe("object");
    expect(r.totalSizeBytes).toBe(r.mainSizeBytes + r.walSizeBytes + r.shmSizeBytes);
  });

  it("includes retentionPreview when config supplied", () => {
    const r = readDbStats({ config: withRetention({ enabled: true, auditLogDays: 30 }) });
    expect(r.retentionPreview).toBeDefined();
    const audit = r.retentionPreview!.tables.find((t) => t.table === "audit_log");
    expect(audit?.status).toBe("ran");
    expect(audit?.cutoffIso).toBeTruthy();
  });

  it("retentionPreview reflects disabled when config.retention.enabled=false", () => {
    const r = readDbStats({ config: defaultDb });
    expect(r.retentionPreview!.tables.every((t) => t.status === "skipped")).toBe(true);
  });
});
