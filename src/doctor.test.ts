// Iter660: checkEnv() surfaces the state of recognized TRADEKIT_* env vars.
// Iter740: checkSyncBookmarks() flags stale sync bookmarks (>7d → warn) so a
// stopped cron is visible through the doctor surface.

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnv } from "./doctor.js";

// Iter740: tmp data dir for the bookmark check (touches the DB). Set BEFORE
// the dynamic db import inside the test block.
const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-doctor-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

afterAll(async () => {
  const { closeDb } = await import("./db.js");
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

const KNOWN_ENV = [
  "TRADEKIT_DATA_DIR",
  "TRADEKIT_WEB_TOKEN",
  "TRADEKIT_HTTP_TIMEOUT_MS",
  "TRADEKIT_RECEIPT_TIMEOUT_MS",
  "TRADEKIT_LOG_ROTATE_BYTES",
  "TRADEKIT_STRATEGY",
  "WALLET_PASS",
];

describe("checkEnv (iter660)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot + clear all known env vars so each test starts from a known state.
    for (const n of KNOWN_ENV) {
      saved[n] = process.env[n];
      delete process.env[n];
    }
  });

  afterEach(() => {
    // Restore exactly what was there pre-test.
    for (const n of KNOWN_ENV) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it("returns ok severity even when many vars are set", async () => {
    process.env.TRADEKIT_DATA_DIR = "/tmp/foo";
    process.env.TRADEKIT_STRATEGY = "dca";
    const r = await checkEnv();
    expect(r.severity).toBe("ok");
    expect(r.name).toBe("env vars");
  });

  it("reports 'no recognized env vars set' when all are unset", async () => {
    const r = await checkEnv();
    expect(r.message).toMatch(/no recognized env vars set/);
  });

  it("includes non-sensitive values in the summary message", async () => {
    process.env.TRADEKIT_STRATEGY = "dca-eth";
    process.env.TRADEKIT_HTTP_TIMEOUT_MS = "15000";
    const r = await checkEnv();
    expect(r.message).toMatch(/TRADEKIT_STRATEGY=dca-eth/);
    expect(r.message).toMatch(/TRADEKIT_HTTP_TIMEOUT_MS=15000/);
  });

  it("redacts sensitive env values (WALLET_PASS, TRADEKIT_WEB_TOKEN)", async () => {
    process.env.WALLET_PASS = "supersecret-passphrase";
    process.env.TRADEKIT_WEB_TOKEN = "tk-abc-xyz-secret";
    const r = await checkEnv();
    expect(r.message).not.toContain("supersecret-passphrase");
    expect(r.message).not.toContain("tk-abc-xyz-secret");
    expect(r.message).toMatch(/WALLET_PASS=\(set\)/);
    expect(r.message).toMatch(/TRADEKIT_WEB_TOKEN=\(set\)/);
  });

  it("flags WALLET_PASS-set in the inline message (visible without --verbose)", async () => {
    process.env.WALLET_PASS = "p";
    const r = await checkEnv();
    expect(r.message).toMatch(/WALLET_PASS skips the prompt/i);
  });

  it("no WALLET_PASS warning when not set", async () => {
    process.env.TRADEKIT_STRATEGY = "dca";
    const r = await checkEnv();
    expect(r.message).not.toMatch(/WALLET_PASS skips/i);
  });

  it("details cover every known env var, regardless of set state", async () => {
    process.env.TRADEKIT_STRATEGY = "dca";
    const r = await checkEnv();
    const labels = (r.details ?? []).map((d) => d.label).sort();
    expect(labels).toEqual([...KNOWN_ENV].sort());
  });

  it("details mark set vs unset via the ok flag", async () => {
    process.env.TRADEKIT_STRATEGY = "dca";
    const r = await checkEnv();
    const row = r.details!.find((d) => d.label === "TRADEKIT_STRATEGY");
    expect(row?.ok).toBe(true);
    expect(row?.note).toBe("dca");
    const unset = r.details!.find((d) => d.label === "TRADEKIT_HTTP_TIMEOUT_MS");
    expect(unset?.ok).toBe(false);
    expect(unset?.note).toBe("(unset)");
  });

  it("sensitive details do NOT carry the raw value in the note", async () => {
    process.env.WALLET_PASS = "supersecret";
    const r = await checkEnv();
    const row = r.details!.find((d) => d.label === "WALLET_PASS");
    expect(row?.ok).toBe(true);
    expect(row?.note).not.toContain("supersecret");
    expect(row?.note).toMatch(/value hidden/i);
  });

  it("treats empty-string env as unset", async () => {
    process.env.TRADEKIT_STRATEGY = "";
    const r = await checkEnv();
    expect(r.message).toMatch(/no recognized env vars set/);
    const row = r.details!.find((d) => d.label === "TRADEKIT_STRATEGY");
    expect(row?.ok).toBe(false);
  });

  it("truncates long non-sensitive values in the summary line", async () => {
    process.env.TRADEKIT_DATA_DIR = "/very/long/path/that/exceeds/the/forty-character/truncation/threshold/used/by/checkEnv";
    const r = await checkEnv();
    // Summary uses an ellipsis for long values; details keep the full value.
    expect(r.message).toMatch(/…/);
    const row = r.details!.find((d) => d.label === "TRADEKIT_DATA_DIR");
    expect(row?.note).toBe(process.env.TRADEKIT_DATA_DIR);
  });
});

describe("checkSyncBookmarks (iter740)", () => {
  const OWNER = "0xa000000000000000000000000000000000000001";

  // Clear bookmarks between tests so state doesn't leak across cases.
  beforeEach(async () => {
    const { listSyncBookmarks, clearSyncBookmark } = await import("./db.js");
    for (const b of listSyncBookmarks()) {
      clearSyncBookmark(b.chain, b.account, b.owner);
    }
  });

  it("returns ok with 'none tracked' when no bookmarks exist", async () => {
    const { checkSyncBookmarks } = await import("./doctor.js");
    const r = await checkSyncBookmarks();
    expect(r.severity).toBe("ok");
    expect(r.name).toBe("sync bookmarks");
    expect(r.message).toMatch(/none tracked/);
  });

  it("returns ok with count + age when all bookmarks are fresh", async () => {
    const { setSyncBookmark, openDb } = await import("./db.js");
    setSyncBookmark("base", "iter740-fresh", OWNER, 100n);
    // Backdate to 2 hours ago — well under the 7d warn threshold.
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    openDb().prepare("UPDATE sync_bookmarks SET updated_at = ? WHERE account = ?").run(twoHoursAgo, "iter740-fresh");
    const { checkSyncBookmarks } = await import("./doctor.js");
    const r = await checkSyncBookmarks();
    expect(r.severity).toBe("ok");
    expect(r.message).toMatch(/1 tracked/);
  });

  it("warns when the oldest bookmark exceeds 7 days, surfacing the chain/account ref", async () => {
    const { setSyncBookmark, openDb } = await import("./db.js");
    setSyncBookmark("base", "iter740-fresh", OWNER, 100n);
    setSyncBookmark("arbitrum", "iter740-stale", OWNER, 200n);
    // Backdate the stale row to 10 days ago.
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    openDb()
      .prepare("UPDATE sync_bookmarks SET updated_at = ? WHERE account = ?")
      .run(tenDaysAgo, "iter740-stale");
    const { checkSyncBookmarks } = await import("./doctor.js");
    const r = await checkSyncBookmarks();
    expect(r.severity).toBe("warn");
    // Message identifies which account is the oldest.
    expect(r.message).toMatch(/arbitrum\/iter740-stale/);
    // Hint nudges the operator toward the right next action.
    expect(r.hint).toMatch(/sync cron stopped|reset-bookmark/);
  });
});

// ── v30 ops-hygiene pack ─────────────────────────────────────

describe("checkRetentionHygiene", () => {
  it("ok on a small install with retention off", async () => {
    const { checkRetentionHygiene } = await import("./doctor.js");
    const r = await checkRetentionHygiene();
    expect(r.severity).toBe("ok");
    expect(r.name).toBe("retention");
    expect(r.details!.length).toBe(7);
  });

  it("warns when a journal table grows past 50k rows with no retention knob", async () => {
    const { openDb } = await import("./db.js");
    const db = openDb();
    // Bulk-insert 50k alert_events cheaply inside one transaction.
    db.exec("BEGIN");
    const ins = db.prepare(
      `INSERT INTO alert_events (at, tag, rule_type, event, severity) VALUES (?, 'bulk', 'staleness', 'fired', 'warn')`,
    );
    for (let i = 0; i < 50_000; i++) ins.run("2026-06-01T00:00:00Z");
    db.exec("COMMIT");
    try {
      const { checkRetentionHygiene } = await import("./doctor.js");
      const r = await checkRetentionHygiene();
      expect(r.severity).toBe("warn");
      expect(r.message).toContain("alert_events");
      expect(r.hint).toContain("db.retention");
      const row = r.details!.find((d) => d.label === "alert_events")!;
      expect(row.ok).toBe(false);
    } finally {
      db.exec("DELETE FROM alert_events");
    }
  });
});

describe("checkPaperReadiness", () => {
  const WETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  beforeEach(async () => {
    const { openDb } = await import("./db.js");
    const db = openDb();
    db.exec("DELETE FROM orders");
    db.exec("DELETE FROM schedules");
    db.exec("DELETE FROM rebalance_plans");
    db.exec("DELETE FROM paper_balances");
  });

  it("ok when no live paper primitives exist", async () => {
    const { checkPaperReadiness } = await import("./doctor.js");
    const r = await checkPaperReadiness();
    expect(r.severity).toBe("ok");
    expect(r.message).toMatch(/no live paper/);
  });

  it("warns when a live paper order has an EMPTY book; ok once funded", async () => {
    const { insertOrder } = await import("./db.js");
    insertOrder({
      side: "sell", trigger_type: "trailing", target_price_usd: null, trail_pct: 5,
      chain: "base", account: "default",
      base_token: WETH, base_symbol: "ETH", quote_token: USDC, quote_symbol: "USDC",
      base_amount: "1", quote_amount: null, slippage_bps: 50, auto_slippage: false,
      expires_at: null, strategy: "doc-test", note: null, group_id: null, paper: true,
    } as never);
    const { checkPaperReadiness } = await import("./doctor.js");
    const starved = await checkPaperReadiness();
    expect(starved.severity).toBe("warn");
    expect(starved.message).toContain("default:base");
    expect(starved.hint).toContain("paper deposit");

    const { setPaperBalance } = await import("./paperTrade.js");
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: "1000" });
    const funded = await checkPaperReadiness();
    expect(funded.severity).toBe("ok");
  });
});

describe("checkAlertsCoverage + checkEngineLiveness", () => {
  const WETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  beforeEach(async () => {
    const { openDb } = await import("./db.js");
    const db = openDb();
    db.exec("DELETE FROM orders");
    db.exec("DELETE FROM schedules");
    db.exec("DELETE FROM rebalance_plans");
    db.exec("DELETE FROM strategy_alert_state");
  });

  function seedActiveOrder() {
    return import("./db.js").then(({ insertOrder }) =>
      insertOrder({
        side: "sell", trigger_type: "price_below", target_price_usd: 1900, trail_pct: null,
        chain: "base", account: "default",
        base_token: WETH, base_symbol: "ETH", quote_token: USDC, quote_symbol: "USDC",
        base_amount: "1", quote_amount: null, slippage_bps: 50, auto_slippage: false,
        expires_at: null, strategy: "doc-test", note: null, group_id: null,
      } as never),
    );
  }

  it("alerts: ok with no primitives; warns when automation runs unwatched", async () => {
    const { checkAlertsCoverage } = await import("./doctor.js");
    expect((await checkAlertsCoverage()).severity).toBe("ok");

    await seedActiveOrder();
    const r = await checkAlertsCoverage();
    // Default config has strategyAlerts disabled.
    expect(r.severity).toBe("warn");
    expect(r.message).toMatch(/unwatched|disabled/);
  });

  it("alerts: CURRENTLY FIRING alerts surface as warn with the tags", async () => {
    const { upsertStrategyAlertState } = await import("./db.js");
    upsertStrategyAlertState({
      tag: "doc-test", ruleType: "failure_streak", active: true,
      firstTriggeredAt: new Date().toISOString(), lastEvaluatedAt: new Date().toISOString(), lastValueJson: null,
    });
    const { checkAlertsCoverage } = await import("./doctor.js");
    const r = await checkAlertsCoverage();
    expect(r.severity).toBe("warn");
    expect(r.message).toContain("doc-test/failure_streak");
  });

  it("engine liveness: ok with no primitives; warns when primitives exist but the engine never ran", async () => {
    const { checkEngineLiveness } = await import("./doctor.js");
    expect((await checkEngineLiveness()).severity).toBe("ok");

    await seedActiveOrder();
    const r = await checkEngineLiveness();
    expect(r.severity).toBe("warn");
    expect(r.message).toMatch(/NEVER run/);
    expect(r.hint).toContain("engine run");
  });
});
