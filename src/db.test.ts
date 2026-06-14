// Tests for the SQL queries that aren't covered by higher-level tests. Currently:
// dailyUsdVolume — the budget check the safety gate reads to enforce per-day USD caps.
// Critical that pending trades count (a stalled tx may still land; if we ignored it,
// a retry would double-spend the daily budget).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// IMPORTANT: must set TRADEKIT_DATA_DIR BEFORE importing db / constants — those
// modules read the path once at load time.
const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-db-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

// Static imports happen before tmp dir is set, so use dynamic import after env var.
const { dailyUsdVolume, usdSpentUnderStrategy, insertTrade, hasPriorTokenFill, closeDb } = await import("./db.js");
type TradeRow = Awaited<ReturnType<typeof import("./db.js").recentTrades>>[number];

const ACCOUNT = "test-acct";
const CHAIN = "base";

function trade(overrides: Partial<TradeRow> = {}): Omit<TradeRow, "id"> {
  return {
    timestamp: new Date().toISOString(), // within the last 24h
    chain: CHAIN,
    account: ACCOUNT,
    direction: "buy",
    base_token: "0xbase",
    base_symbol: "PEPE",
    base_amount: "1000",
    quote_token: "0xusdc",
    quote_symbol: "USDC",
    quote_amount: "100",
    price: "0.1",
    tx_hash: "0x" + Math.random().toString(16).slice(2).padStart(64, "0"),
    status: "success",
    gas_used: null,
    gas_price_wei: null,
    gas_cost_native: null,
    aggregator: "kyberswap",
    fee_tier: null,
    notes: null,
    ...overrides,
  };
}

beforeAll(() => {
  // db is fresh because the tmp dir is fresh; nothing to clean up.
});

afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("hasPriorTokenFill (v101 new-token detection)", () => {
  // Unique token/account per assertion so the shared-DB accumulation in this
  // file can't bleed in.
  it("false when the token was never traded on this account+chain", () => {
    expect(hasPriorTokenFill({ account: "novel-acct", chain: CHAIN, baseToken: "0xNEVERTRADED" })).toBe(false);
  });

  it("true after a SUCCESSFUL fill of that token (address match, case-insensitive)", () => {
    insertTrade(trade({ account: "known-acct", base_token: "0xAbCdEf", status: "success" }));
    expect(hasPriorTokenFill({ account: "known-acct", chain: CHAIN, baseToken: "0xabcdef" })).toBe(true);
  });

  it("a FAILED/pending attempt does NOT make a token known", () => {
    insertTrade(trade({ account: "fail-acct", base_token: "0xFAILONLY", status: "failed" }));
    insertTrade(trade({ account: "fail-acct", base_token: "0xFAILONLY", status: "pending" }));
    expect(hasPriorTokenFill({ account: "fail-acct", chain: CHAIN, baseToken: "0xFAILONLY" })).toBe(false);
  });

  it("scoped by chain — a fill on another chain leaves the token novel here", () => {
    insertTrade(trade({ account: "chain-acct", chain: "arbitrum", base_token: "0xCROSSCHAIN", status: "success" }));
    expect(hasPriorTokenFill({ account: "chain-acct", chain: "base", baseToken: "0xCROSSCHAIN" })).toBe(false);
    expect(hasPriorTokenFill({ account: "chain-acct", chain: "arbitrum", baseToken: "0xCROSSCHAIN" })).toBe(true);
  });

  it("a prior SELL also counts — once held, no longer novel", () => {
    insertTrade(trade({ account: "sell-acct", base_token: "0xHELD", direction: "sell", status: "success" }));
    expect(hasPriorTokenFill({ account: "sell-acct", chain: CHAIN, baseToken: "0xHELD" })).toBe(true);
  });
});

// v104: the USD-budget layer must sum DOLLARS (value_usd), not raw quote-token
// units. A WETH-quoted trade's quote_amount is in WETH — counting it as USD
// under-counted the daily cap + strategy budgets by the WETH price.
describe("USD budgets use value_usd, fall back to quote_amount (v104)", () => {
  it("dailyUsdVolume sums value_usd when present (WETH-quoted trade counts its USD, not 0.5)", () => {
    const acct = "v104-daily";
    // A WETH-quoted buy: 0.5 WETH spent, but value_usd = $1500.
    insertTrade(trade({ account: acct, quote_symbol: "WETH", quote_amount: "0.5", value_usd: 1500 }));
    insertTrade(trade({ account: acct, quote_symbol: "WETH", quote_amount: "0.3", value_usd: 900 }));
    expect(dailyUsdVolume(acct, CHAIN)).toBe(2400); // 1500 + 900, NOT 0.8
  });

  it("dailyUsdVolume falls back to quote_amount for legacy rows (value_usd null)", () => {
    const acct = "v104-legacy";
    insertTrade(trade({ account: acct, quote_symbol: "USDC", quote_amount: "250" })); // no value_usd
    expect(dailyUsdVolume(acct, CHAIN)).toBe(250);
  });

  it("dailyUsdVolume mixes priced + legacy rows correctly", () => {
    const acct = "v104-mixed";
    insertTrade(trade({ account: acct, quote_symbol: "WETH", quote_amount: "0.5", value_usd: 1500 }));
    insertTrade(trade({ account: acct, quote_symbol: "USDC", quote_amount: "200" })); // legacy → 200
    expect(dailyUsdVolume(acct, CHAIN)).toBe(1700);
  });

  it("usdSpentUnderStrategy uses value_usd too", () => {
    insertTrade(trade({ account: "v104-strat", strategy: "dca-weth", quote_symbol: "WETH", quote_amount: "1", value_usd: 3000 }));
    insertTrade(trade({ account: "v104-strat", strategy: "dca-weth", quote_symbol: "WETH", quote_amount: "0.5", value_usd: 1500 }));
    expect(usdSpentUnderStrategy("dca-weth")).toBe(4500); // not 1.5
  });
});

describe("dailyUsdVolume", () => {
  it("sums quote_amount for success trades within 24h", () => {
    insertTrade(trade({ quote_amount: "50" }));
    insertTrade(trade({ quote_amount: "75" }));
    expect(dailyUsdVolume(ACCOUNT, CHAIN)).toBe(125);
  });

  it("counts pending trades — a timed-out tx may still confirm, so it must consume budget", () => {
    insertTrade(trade({ quote_amount: "200", status: "pending" }));
    // Previous test already inserted 125 worth; total should now include the pending 200.
    expect(dailyUsdVolume(ACCOUNT, CHAIN)).toBe(125 + 200);
  });

  it("excludes failed trades — gas was paid but no value moved", () => {
    insertTrade(trade({ quote_amount: "999", status: "failed" }));
    expect(dailyUsdVolume(ACCOUNT, CHAIN)).toBe(125 + 200); // unchanged
  });

  it("scopes by account", () => {
    insertTrade(trade({ account: "other", quote_amount: "10000" }));
    expect(dailyUsdVolume(ACCOUNT, CHAIN)).toBe(125 + 200);
    expect(dailyUsdVolume("other", CHAIN)).toBe(10000);
  });

  it("scopes by chain when provided", () => {
    insertTrade(trade({ chain: "arbitrum", quote_amount: "50" }));
    expect(dailyUsdVolume(ACCOUNT, "arbitrum")).toBe(50);
    // Without a chain filter, all chains for that account are summed.
    expect(dailyUsdVolume(ACCOUNT)).toBe(125 + 200 + 50);
  });

  it("ignores rows older than 24h", () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    insertTrade(trade({ timestamp: old, quote_amount: "9999" }));
    expect(dailyUsdVolume(ACCOUNT, CHAIN)).toBe(125 + 200); // unchanged
  });

  it("counts transfer rows toward the daily budget (regression: was a bypass before iter53)", () => {
    // Pre-existing total in this account/chain from earlier tests: 125 + 200 = 325.
    // Add a $50 transfer; daily total must reflect it.
    insertTrade(trade({ aggregator: "transfer", quote_amount: "50", notes: "transfer to 0xfoo" }));
    expect(dailyUsdVolume(ACCOUNT, CHAIN)).toBe(125 + 200 + 50);
  });
});

describe("pnl.aggregateTrades transfer handling", () => {
  it("skips transfer rows so they don't pollute cost basis", async () => {
    const { aggregateTrades } = await import("./pnl.js");
    const baseRow: Omit<TradeRow, "id"> = trade({
      base_symbol: "WETH",
      base_amount: "1",
      quote_symbol: "USDC",
      quote_amount: "3000",
      aggregator: "kyberswap",
      direction: "buy",
    });
    const transferRow: Omit<TradeRow, "id"> = trade({
      base_symbol: "USDC",
      base_amount: "100",
      quote_symbol: "USD",
      quote_amount: "100", // estimated USD value, NOT a swap counterparty
      aggregator: "transfer",
      direction: "sell",
      notes: "transfer to 0xfoo",
    });
    const out = aggregateTrades([baseRow as TradeRow, transferRow as TradeRow], () => 1);
    // Only the WETH buy should appear; the transfer is filtered.
    expect(out.positions.size).toBe(1);
    const [position] = [...out.positions.values()];
    expect(position.symbol).toBe("WETH");
    expect(position.amount).toBe(1);
  });
});

describe("redactSensitiveFields (iter114 — security fix)", () => {
  it("replaces password-like field values with [REDACTED]", async () => {
    const { redactSensitiveFields } = await import("./db.js");
    const out = redactSensitiveFields({
      pass: "my-real-password",
      chain: "base",
      json: "true",
    });
    expect(out.pass).toBe("[REDACTED]");
    expect(out.chain).toBe("base");
    expect(out.json).toBe("true");
  });

  it("matches case-insensitively (PASS, Password, MNEMONIC, etc.)", async () => {
    const { redactSensitiveFields } = await import("./db.js");
    const out = redactSensitiveFields({
      PASS: "x",
      Password: "y",
      MNEMONIC: "z",
      "Private-Key": "k",
    });
    expect(out.PASS).toBe("[REDACTED]");
    expect(out.Password).toBe("[REDACTED]");
    expect(out.MNEMONIC).toBe("[REDACTED]");
    expect(out["Private-Key"]).toBe("[REDACTED]");
  });

  it("covers all the common sensitive field names", async () => {
    const { redactSensitiveFields } = await import("./db.js");
    const out = redactSensitiveFields({
      pass: "1",
      password: "2",
      passphrase: "3",
      "private-key": "4",
      privatekey: "5",
      private_key: "6",
      mnemonic: "7",
      seed: "8",
      secret: "9",
    });
    expect(Object.values(out).every((v) => v === "[REDACTED]")).toBe(true);
  });

  it("preserves the original key (only the VALUE is redacted)", async () => {
    const { redactSensitiveFields } = await import("./db.js");
    const out = redactSensitiveFields({ pass: "secret123" });
    expect(Object.keys(out)).toEqual(["pass"]);
  });

  it("recurses into nested objects (iter136 — was top-level-only before)", async () => {
    const { redactSensitiveFields } = await import("./db.js");
    const out = redactSensitiveFields({
      chain: "base",
      auth: { user: "alice", password: "secret123" },
    });
    expect(out.chain).toBe("base");
    expect((out.auth as Record<string, unknown>).user).toBe("alice");
    expect((out.auth as Record<string, unknown>).password).toBe("[REDACTED]");
  });

  it("recurses into arrays (iter136)", async () => {
    const { redactSensitiveFields } = await import("./db.js");
    const out = redactSensitiveFields({
      batch: [{ id: 1, secret: "x" }, { id: 2, secret: "y" }],
    });
    const arr = out.batch as Array<Record<string, unknown>>;
    expect(arr[0].id).toBe(1);
    expect(arr[0].secret).toBe("[REDACTED]");
    expect(arr[1].secret).toBe("[REDACTED]");
  });

  it("does not deep-walk non-plain objects (iter136 — Date / Buffer stay as-is)", async () => {
    const { redactSensitiveFields } = await import("./db.js");
    const d = new Date();
    const out = redactSensitiveFields({ when: d, password: "x" });
    expect(out.when).toBe(d); // same instance, not cloned/mangled
    expect(out.password).toBe("[REDACTED]");
  });

  it("preserves null and undefined values", async () => {
    const { redactSensitiveFields } = await import("./db.js");
    const out = redactSensitiveFields({ a: null, b: undefined, password: "x" });
    expect(out.a).toBeNull();
    expect(out.b).toBeUndefined();
    expect(out.password).toBe("[REDACTED]");
  });
});

describe("chain filter case-insensitivity (iter127 — silent empty-result fix)", () => {
  // Pre-iter127, `tradekit pnl --chain Base` returned zero trades because the SQL
  // `chain = ?` match was case-sensitive and trades store chain as canonical lowercase.
  // All chain-filtered DB queries now lowercase the filter at the boundary.
  it("recentTrades matches regardless of input chain case", async () => {
    const { recentTrades } = await import("./db.js");
    const lowercase = recentTrades({ account: ACCOUNT, chain: "base", limit: 100 });
    const uppercase = recentTrades({ account: ACCOUNT, chain: "BASE", limit: 100 });
    const mixed = recentTrades({ account: ACCOUNT, chain: "Base", limit: 100 });
    expect(uppercase.length).toBe(lowercase.length);
    expect(mixed.length).toBe(lowercase.length);
    expect(lowercase.length).toBeGreaterThan(0); // sanity: prior tests left rows
  });

  it("dailyUsdVolume matches regardless of input chain case", async () => {
    const { dailyUsdVolume } = await import("./db.js");
    const lc = dailyUsdVolume(ACCOUNT, "base");
    const uc = dailyUsdVolume(ACCOUNT, "BASE");
    expect(uc).toBe(lc);
  });
});

describe("recentAudit read-side redaction (iter159 — protect legacy rows)", () => {
  it("re-redacts sensitive fields in params_json on every read", async () => {
    const { insertAudit, recentAudit } = await import("./db.js");
    // Simulate a row that escaped the write-side redaction (e.g. inserted by code
    // from before iter113/114, or by a future tool-write path that forgets to redact).
    insertAudit({
      timestamp: "2026-01-01T00:00:00Z",
      caller: "test",
      tool: "iter159_legacy",
      account: ACCOUNT,
      chain: CHAIN,
      params_json: JSON.stringify({ chain: "base", password: "plaintext-leak", json: "true" }),
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: null,
    });
    const rows = recentAudit(100, { tool: "iter159_legacy" });
    expect(rows.length).toBeGreaterThan(0);
    const parsed = JSON.parse(rows[0].params_json!);
    expect(parsed.password).toBe("[REDACTED]");
    expect(parsed.chain).toBe("base"); // non-sensitive unchanged
  });

  it("iter695: filters by errorCode (exact match)", async () => {
    const { insertAudit, recentAudit } = await import("./db.js");
    const TOOL = "iter695_test";
    insertAudit({
      timestamp: "2026-04-01T00:00:00Z", caller: "test", tool: TOOL, account: ACCOUNT, chain: CHAIN,
      params_json: "{}", simulation_json: null, result: "error",
      error_code: "SLIPPAGE_EXCEEDED", error_message: "x", tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-04-02T00:00:00Z", caller: "test", tool: TOOL, account: ACCOUNT, chain: CHAIN,
      params_json: "{}", simulation_json: null, result: "error",
      error_code: "SLIPPAGE_EXCEEDED", error_message: "y", tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-04-03T00:00:00Z", caller: "test", tool: TOOL, account: ACCOUNT, chain: CHAIN,
      params_json: "{}", simulation_json: null, result: "error",
      error_code: "TOKEN_BLOCKED", error_message: "z", tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-04-04T00:00:00Z", caller: "test", tool: TOOL, account: ACCOUNT, chain: CHAIN,
      params_json: "{}", simulation_json: null, result: "ok",
      error_code: null, error_message: null, tx_hash: null,
    });
    const slipOnly = recentAudit(100, { tool: TOOL, errorCode: "SLIPPAGE_EXCEEDED" });
    expect(slipOnly.length).toBe(2);
    expect(slipOnly.every((r) => r.error_code === "SLIPPAGE_EXCEEDED")).toBe(true);

    const tokenOnly = recentAudit(100, { tool: TOOL, errorCode: "TOKEN_BLOCKED" });
    expect(tokenOnly.length).toBe(1);

    const unknown = recentAudit(100, { tool: TOOL, errorCode: "DOES_NOT_EXIST" });
    expect(unknown.length).toBe(0);
  });

  it("iter696: errorsOnly filters to rows with non-null error_code", async () => {
    const { insertAudit, recentAudit } = await import("./db.js");
    const TOOL = "iter696_test";
    insertAudit({
      timestamp: "2026-04-05T00:00:00Z", caller: "test", tool: TOOL, account: ACCOUNT, chain: CHAIN,
      params_json: "{}", simulation_json: null, result: "error",
      error_code: "A_CODE", error_message: "fail", tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-04-06T00:00:00Z", caller: "test", tool: TOOL, account: ACCOUNT, chain: CHAIN,
      params_json: "{}", simulation_json: null, result: "ok",
      error_code: null, error_message: null, tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-04-07T00:00:00Z", caller: "test", tool: TOOL, account: ACCOUNT, chain: CHAIN,
      params_json: "{}", simulation_json: null, result: "ok",
      error_code: null, error_message: null, tx_hash: null,
    });
    const errOnly = recentAudit(100, { tool: TOOL, errorsOnly: true });
    expect(errOnly.length).toBe(1);
    expect(errOnly[0].error_code).toBe("A_CODE");

    // Without errorsOnly: all 3 returned.
    const all = recentAudit(100, { tool: TOOL });
    expect(all.length).toBe(3);
  });

  it("iter705: recentAudit filters by txHash (case-insensitive)", async () => {
    const { insertAudit, recentAudit } = await import("./db.js");
    const TOOL = "iter705_test";
    const HASH = "0x" + "Aa".repeat(32); // mixed-case 64-hex
    insertAudit({
      timestamp: "2026-04-10T00:00:00Z", caller: "cli", tool: TOOL,
      account: ACCOUNT, chain: CHAIN, params_json: "{}", simulation_json: null,
      result: "ok", error_code: null, error_message: null, tx_hash: HASH,
    });
    insertAudit({
      timestamp: "2026-04-11T00:00:00Z", caller: "cli", tool: TOOL,
      account: ACCOUNT, chain: CHAIN, params_json: "{}", simulation_json: null,
      result: "ok", error_code: null, error_message: null, tx_hash: HASH,
    });
    insertAudit({
      timestamp: "2026-04-12T00:00:00Z", caller: "cli", tool: TOOL,
      account: ACCOUNT, chain: CHAIN, params_json: "{}", simulation_json: null,
      result: "ok", error_code: null, error_message: null, tx_hash: "0x" + "bb".repeat(32),
    });
    // Exact case
    expect(recentAudit(100, { tool: TOOL, txHash: HASH }).length).toBe(2);
    // Lowercased input matches mixed-case stored value
    expect(recentAudit(100, { tool: TOOL, txHash: HASH.toLowerCase() }).length).toBe(2);
    // Different hash
    expect(recentAudit(100, { tool: TOOL, txHash: "0x" + "cc".repeat(32) }).length).toBe(0);
  });

  it("iter695+iter696: filters compose (errorCode + errorsOnly together)", async () => {
    const { insertAudit, recentAudit } = await import("./db.js");
    const TOOL = "iter696_compose";
    insertAudit({
      timestamp: "2026-04-08T00:00:00Z", caller: "test", tool: TOOL, account: ACCOUNT, chain: CHAIN,
      params_json: "{}", simulation_json: null, result: "error",
      error_code: "TARGET", error_message: "x", tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-04-09T00:00:00Z", caller: "test", tool: TOOL, account: ACCOUNT, chain: CHAIN,
      params_json: "{}", simulation_json: null, result: "error",
      error_code: "OTHER", error_message: "y", tx_hash: null,
    });
    // errorCode filter is itself a strict equality, but combining with
    // errorsOnly should be a no-op (errorCode != null is already implied).
    const r = recentAudit(100, { tool: TOOL, errorCode: "TARGET", errorsOnly: true });
    expect(r.length).toBe(1);
    expect(r[0].error_code).toBe("TARGET");
  });

  it("leaves non-JSON params_json alone (e.g. truncated payloads)", async () => {
    const { insertAudit, recentAudit } = await import("./db.js");
    insertAudit({
      timestamp: "2026-01-02T00:00:00Z",
      caller: "test",
      tool: "iter159_truncated",
      account: ACCOUNT,
      chain: CHAIN,
      params_json: "[TRUNCATED garbage that isn't JSON]",
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: null,
    });
    const rows = recentAudit(100, { tool: "iter159_truncated" });
    expect(rows[0].params_json).toBe("[TRUNCATED garbage that isn't JSON]");
  });
});

describe("auditPruneStats (iter119 — preview before deleting)", () => {
  it("returns count + min/max timestamps of rows that would be pruned", async () => {
    const { insertAudit, auditPruneStats } = await import("./db.js");
    // Fresh-ish DB — earlier tests may have inserted audit rows, so use a unique tool name.
    insertAudit({
      timestamp: "2026-01-01T00:00:00Z",
      caller: "test",
      tool: "iter119_a",
      account: ACCOUNT,
      chain: CHAIN,
      params_json: "{}",
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-02-15T00:00:00Z",
      caller: "test",
      tool: "iter119_b",
      account: ACCOUNT,
      chain: CHAIN,
      params_json: "{}",
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-03-01T00:00:00Z",
      caller: "test",
      tool: "iter119_c",
      account: ACCOUNT,
      chain: CHAIN,
      params_json: "{}",
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: null,
    });
    // Prune cutoff between feb and march: catches iter119_a + iter119_b only.
    const stats = auditPruneStats("2026-02-20T00:00:00Z");
    expect(stats.count).toBeGreaterThanOrEqual(2);
    expect(stats.oldestPruned).toBe("2026-01-01T00:00:00Z");
    // newestPruned must be <= the cutoff (we count rows STRICTLY before cutoff).
    expect(stats.newestPruned).toBe("2026-02-15T00:00:00Z");
  });

  it("returns count=0 + nulls when nothing matches", async () => {
    const { auditPruneStats } = await import("./db.js");
    const stats = auditPruneStats("1970-01-01T00:00:00Z");
    expect(stats.count).toBe(0);
    expect(stats.oldestPruned).toBeNull();
    expect(stats.newestPruned).toBeNull();
  });
});

describe("recentTrades chronological ordering (iter245 — historical-import bug)", () => {
  it("orders by timestamp desc — recently-imported old trade does NOT jump to the top", async () => {
    // Companion to iter244. `tradekit trades` shows trade HISTORY; ordering should be
    // by when the trade actually happened, not when it was imported. Importing a
    // 6-month-old swap shouldn't make it the "newest" trade in the listing.
    const { recentTrades, insertTrade } = await import("./db.js");

    insertTrade(trade({
      account: "iter245-acct",
      timestamp: "2026-05-28T12:00:00Z",
      tx_hash: "0x" + "c".repeat(64),
    }));
    // Imported OLD trade — inserted last, but timestamp is 6 months ago.
    insertTrade(trade({
      account: "iter245-acct",
      timestamp: "2025-08-01T12:00:00Z",
      tx_hash: "0x" + "d".repeat(64),
    }));

    const rows = recentTrades({ account: "iter245-acct" });
    expect(rows.length).toBe(2);
    // Most recent BY WHEN-IT-HAPPENED comes first (not the just-imported old one).
    expect(rows[0].timestamp).toBe("2026-05-28T12:00:00Z");
    expect(rows[1].timestamp).toBe("2025-08-01T12:00:00Z");
  });
});

describe("allTrades chronological ordering (iter244 — historical-import bug)", () => {
  it("orders by timestamp asc, even when insertion order disagrees", async () => {
    // Regression for iter244: pre-iter244 allTrades did `ORDER BY id ASC` (insertion
    // order), which agreed with timestamp for live trades but broke after iter243
    // started stamping imported historical trades with their block time. Inserting
    // an old-timestamp trade LAST should still place it FIRST in chronological order
    // so PnL's weighted-average cost basis processes events in real-world sequence.
    const { allTrades, insertTrade } = await import("./db.js");

    // Insert "today" trade first
    const todayId = insertTrade(trade({
      account: "iter244-acct",
      timestamp: "2026-05-28T12:00:00Z",
      tx_hash: "0x" + "a".repeat(64),
    }));
    // Then insert a HISTORICAL trade (older timestamp) — analogue of importing an old tx.
    const oldId = insertTrade(trade({
      account: "iter244-acct",
      timestamp: "2025-08-01T12:00:00Z",
      tx_hash: "0x" + "b".repeat(64),
    }));
    expect(oldId).toBeGreaterThan(todayId); // sanity: older trade has the higher id

    const rows = allTrades({ account: "iter244-acct" });
    expect(rows.length).toBe(2);
    expect(rows[0].timestamp).toBe("2025-08-01T12:00:00Z"); // older one comes first now
    expect(rows[1].timestamp).toBe("2026-05-28T12:00:00Z");
  });
});

describe("matchesTradeToken (iter282 — shared CLI/MCP/web token-filter predicate)", () => {
  function row(overrides: Partial<TradeRow> = {}) {
    return {
      base_symbol: "WETH",
      quote_symbol: "USDC",
      base_token: "0x4200000000000000000000000000000000000006",
      quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      ...overrides,
    };
  }

  it("matches base symbol exactly (case-insensitive — caller pre-lowercases)", async () => {
    const { matchesTradeToken } = await import("./db.js");
    expect(matchesTradeToken(row(), "weth")).toBe(true);
    expect(matchesTradeToken(row(), "usdc")).toBe(true); // quote symbol
  });

  it("matches base or quote address exactly", async () => {
    const { matchesTradeToken } = await import("./db.js");
    expect(matchesTradeToken(row(), "0x4200000000000000000000000000000000000006")).toBe(true);
    expect(matchesTradeToken(row(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")).toBe(true);
  });

  it("matches address prefix (so `--token 0xabc` finds anything starting with 0xabc)", async () => {
    const { matchesTradeToken } = await import("./db.js");
    expect(matchesTradeToken(row(), "0x4200")).toBe(true); // partial base
    expect(matchesTradeToken(row(), "0x8335")).toBe(true); // partial quote
  });

  it("does NOT match symbol prefixes (those are exact-only)", async () => {
    const { matchesTradeToken } = await import("./db.js");
    expect(matchesTradeToken(row(), "wet")).toBe(false);
    expect(matchesTradeToken(row(), "usd")).toBe(false);
  });

  it("handles null symbols (some imported rows have no symbol)", async () => {
    const { matchesTradeToken } = await import("./db.js");
    const r = row({ base_symbol: null, quote_symbol: null });
    expect(matchesTradeToken(r, "weth")).toBe(false);
    expect(matchesTradeToken(r, "0x4200")).toBe(true); // address still matches
  });

  it("doesn't match anything for an empty needle vs non-empty token", async () => {
    const { matchesTradeToken } = await import("./db.js");
    // Empty needle would match every prefix (startsWith("") === true). Guard handled
    // by callers via `if (tokenFilter) ...` — predicate itself doesn't second-guess.
    expect(matchesTradeToken(row(), "")).toBe(true); // documents the behavior
  });
});

describe("capTradeNotes (iter270 — DB-bloat safeguard)", () => {
  it("returns null for null/undefined", async () => {
    const { capTradeNotes } = await import("./db.js");
    expect(capTradeNotes(null)).toBeNull();
    expect(capTradeNotes(undefined)).toBeNull();
  });

  it("passes through notes under the cap unchanged", async () => {
    const { capTradeNotes, TRADE_NOTES_MAX } = await import("./db.js");
    expect(capTradeNotes("DCA #4")).toBe("DCA #4");
    expect(capTradeNotes("x".repeat(TRADE_NOTES_MAX))).toBe("x".repeat(TRADE_NOTES_MAX));
  });

  it("truncates with marker when over cap", async () => {
    const { capTradeNotes, TRADE_NOTES_MAX } = await import("./db.js");
    const big = "y".repeat(TRADE_NOTES_MAX + 1000);
    const out = capTradeNotes(big);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(big.length);
    expect(out!).toMatch(/\[TRUNCATED\]$/);
    // First TRADE_NOTES_MAX chars preserved so the note prefix stays readable.
    expect(out!.slice(0, TRADE_NOTES_MAX)).toBe("y".repeat(TRADE_NOTES_MAX));
  });

  it("insertTrade transparently applies the cap", async () => {
    // End-to-end: an MCP agent passing a multi-MB note ends up with a bounded row.
    const { insertTrade, recentTrades, capTradeNotes, TRADE_NOTES_MAX } = await import("./db.js");
    const giant = "z".repeat(TRADE_NOTES_MAX * 5);
    insertTrade(trade({
      account: "iter270-acct",
      tx_hash: "0x" + "e".repeat(64),
      notes: giant,
    }));
    const rows = recentTrades({ account: "iter270-acct" });
    const r = rows.find((x) => x.tx_hash === "0x" + "e".repeat(64));
    expect(r).toBeTruthy();
    expect(r!.notes!.length).toBeLessThan(giant.length);
    expect(r!.notes).toBe(capTradeNotes(giant));
  });
});

describe("capAuditText (iter271 — bounded error_message + simulation_json)", () => {
  it("returns null for null/undefined", async () => {
    const { capAuditText } = await import("./db.js");
    expect(capAuditText(null)).toBeNull();
    expect(capAuditText(undefined)).toBeNull();
  });

  it("passes through under-cap strings unchanged", async () => {
    const { capAuditText, AUDIT_TEXT_MAX } = await import("./db.js");
    expect(capAuditText("short message")).toBe("short message");
    expect(capAuditText("x".repeat(AUDIT_TEXT_MAX))).toBe("x".repeat(AUDIT_TEXT_MAX));
  });

  it("truncates oversized strings with marker", async () => {
    const { capAuditText, AUDIT_TEXT_MAX } = await import("./db.js");
    const big = "z".repeat(AUDIT_TEXT_MAX + 2000);
    const out = capAuditText(big);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(big.length);
    expect(out!).toMatch(/\[TRUNCATED\]$/);
    expect(out!.slice(0, AUDIT_TEXT_MAX)).toBe("z".repeat(AUDIT_TEXT_MAX));
  });

  it("insertAudit transparently caps error_message + simulation_json", async () => {
    // End-to-end: an upstream error with a giant RPC body lands bounded.
    const { insertAudit, recentAudit, AUDIT_TEXT_MAX } = await import("./db.js");
    const huge = "q".repeat(AUDIT_TEXT_MAX * 5);
    insertAudit({
      timestamp: "2026-05-28T13:00:00Z",
      caller: "test",
      tool: "iter271-test",
      account: "iter271-acct",
      chain: "base",
      params_json: '{"a":1}',
      simulation_json: huge,
      result: "err",
      error_code: "RPC_FAILED",
      error_message: huge,
      tx_hash: null,
    });
    const rows = recentAudit(5, { tool: "iter271-test" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].error_message!.length).toBeLessThan(huge.length);
    expect(rows[0].error_message).toMatch(/\[TRUNCATED\]$/);
    expect(rows[0].simulation_json!.length).toBeLessThan(huge.length);
    expect(rows[0].simulation_json).toMatch(/\[TRUNCATED\]$/);
  });
});

describe("capAuditParams (iter112)", () => {
  it("passes through payloads under the cap unchanged", async () => {
    const { capAuditParams, AUDIT_PARAMS_MAX } = await import("./db.js");
    const small = JSON.stringify({ a: 1, b: "ok" });
    expect(capAuditParams(small)).toBe(small);
    // Exactly-at-cap also passes through.
    const exactly = "x".repeat(AUDIT_PARAMS_MAX);
    expect(capAuditParams(exactly)).toBe(exactly);
  });

  it("truncates payloads over the cap with a [TRUNCATED] marker", async () => {
    const { capAuditParams, AUDIT_PARAMS_MAX } = await import("./db.js");
    const oversized = "x".repeat(AUDIT_PARAMS_MAX + 1000);
    const out = capAuditParams(oversized);
    expect(out.length).toBeLessThan(oversized.length);
    expect(out).toMatch(/TRUNCATED/);
    // First AUDIT_PARAMS_MAX chars preserved so debugging can still recognize the
    // command shape (the JSON prefix).
    expect(out.slice(0, AUDIT_PARAMS_MAX)).toBe("x".repeat(AUDIT_PARAMS_MAX));
  });
});

describe("portfolio snapshots (iter618)", () => {
  it("round-trips insert + getById + list + findAsOf", async () => {
    const {
      insertPortfolioSnapshot,
      getPortfolioSnapshot,
      listPortfolioSnapshots,
      findPortfolioSnapshotAsOf,
    } = await import("./db.js");

    const t1 = "2026-05-01T00:00:00.000Z";
    const t2 = "2026-05-15T00:00:00.000Z";
    const t3 = "2026-05-29T00:00:00.000Z";

    const id1 = insertPortfolioSnapshot({
      timestamp: t1,
      total_usd: 100,
      accounts_key: "alice",
      chains_key: "base",
      token_count: 1,
      note: "first",
      data: JSON.stringify({ tokens: [] }),
    });
    const id2 = insertPortfolioSnapshot({
      timestamp: t2,
      total_usd: 150,
      accounts_key: "alice",
      chains_key: "base",
      token_count: 2,
      note: null,
      data: JSON.stringify({ tokens: [] }),
    });
    const id3 = insertPortfolioSnapshot({
      timestamp: t3,
      total_usd: 200,
      accounts_key: "bob",
      chains_key: "base",
      token_count: 3,
      note: "different scope",
      data: JSON.stringify({ tokens: [] }),
    });

    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(id1);
    expect(id3).toBeGreaterThan(id2);

    // getById returns the full row including data blob
    const row1 = getPortfolioSnapshot(id1);
    expect(row1?.timestamp).toBe(t1);
    expect(row1?.note).toBe("first");
    expect(row1?.data).toBe(JSON.stringify({ tokens: [] }));

    // listSnapshots returns most recent first, without data blob
    const list = listPortfolioSnapshots({ limit: 10 });
    expect(list.length).toBe(3);
    expect(list[0].id).toBe(id3); // most recent first
    expect(list[2].id).toBe(id1);
    expect("data" in list[0]).toBe(false);

    // listSnapshots with scope filter
    const aliceOnly = listPortfolioSnapshots({ accountsKey: "alice" });
    expect(aliceOnly.length).toBe(2);
    expect(aliceOnly.every((s) => s.accounts_key === "alice")).toBe(true);

    // findAsOf with matching scope returns most recent <= timestamp
    const asOf = findPortfolioSnapshotAsOf({
      asOf: "2026-05-20T00:00:00.000Z",
      accountsKey: "alice",
      chainsKey: "base",
    });
    expect(asOf?.id).toBe(id2);

    // findAsOf with no match returns null
    const noMatch = findPortfolioSnapshotAsOf({
      asOf: "2026-04-01T00:00:00.000Z",
      accountsKey: "alice",
      chainsKey: "base",
    });
    expect(noMatch).toBeNull();

    // findAsOf skips scope mismatch (bob's snapshot not returned for alice query)
    const aliceAsOfRecent = findPortfolioSnapshotAsOf({
      asOf: "2026-12-01T00:00:00.000Z",
      accountsKey: "alice",
      chainsKey: "base",
    });
    expect(aliceAsOfRecent?.id).toBe(id2); // not id3 (bob's)
  });

  it("getPortfolioSnapshot returns null for non-existent id", async () => {
    const { getPortfolioSnapshot } = await import("./db.js");
    expect(getPortfolioSnapshot(999_999)).toBeNull();
  });
});

// ── auditSummary (iter631) ─────────────────────────────────

describe("auditSummary", () => {
  it("returns zero counts on empty filter result", async () => {
    const { auditSummary } = await import("./db.js");
    const r = auditSummary({ tool: "definitely-does-not-exist-tool" });
    expect(r.totalRows).toBe(0);
    expect(r.errorRows).toBe(0);
    expect(r.byTool).toEqual([]);
    expect(r.byCaller).toEqual([]);
    expect(r.byErrorCode).toEqual([]);
    expect(r.byChain).toEqual([]);
    expect(r.earliest).toBeNull();
    expect(r.latest).toBeNull();
  });

  it("iter771: report carries elapsedMs (wall-clock timing)", async () => {
    const { auditSummary } = await import("./db.js");
    const r = auditSummary({});
    expect(typeof r.elapsedMs).toBe("number");
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    // Sanity bound: a single-shot audit summary on the test DB should be fast.
    expect(r.elapsedMs).toBeLessThan(5_000);
  });

  it("aggregates real audit rows by tool with error counts", async () => {
    const { insertAudit, auditSummary } = await import("./db.js");
    const ts = (n: number) => new Date(2026, 0, 1, n).toISOString();
    insertAudit({
      timestamp: ts(0),
      caller: "cli",
      tool: "iter631test_quote",
      account: null,
      chain: null,
      params_json: null,
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: null,
    });
    insertAudit({
      timestamp: ts(1),
      caller: "cli",
      tool: "iter631test_quote",
      account: null,
      chain: null,
      params_json: null,
      simulation_json: null,
      result: null,
      error_code: "AGGREGATOR_FAILED",
      error_message: "boom",
      tx_hash: null,
    });
    insertAudit({
      timestamp: ts(2),
      caller: "mcp",
      tool: "iter631test_buy",
      account: null,
      chain: "base",
      params_json: null,
      simulation_json: null,
      result: null,
      error_code: "AGGREGATOR_FAILED",
      error_message: "boom2",
      tx_hash: null,
    });

    // Filter on a tool prefix so we don't conflict with rows from earlier tests
    // in this file (which created audit rows for other tools).
    const r = auditSummary({ since: ts(0) });
    expect(r.totalRows).toBeGreaterThanOrEqual(3);

    const quoteRow = r.byTool.find((t) => t.tool === "iter631test_quote");
    expect(quoteRow?.count).toBe(2);
    expect(quoteRow?.errorCount).toBe(1);

    const buyRow = r.byTool.find((t) => t.tool === "iter631test_buy");
    expect(buyRow?.count).toBe(1);
    expect(buyRow?.errorCount).toBe(1);

    // Aggregator-failed should appear in byErrorCode with count >= 2.
    const aggErr = r.byErrorCode.find((e) => e.errorCode === "AGGREGATOR_FAILED");
    expect(aggErr?.count).toBeGreaterThanOrEqual(2);
    // Iter697: lastSeen is the most recent timestamp of any row with this
    // error_code. Should be a valid ISO string.
    expect(aggErr?.lastSeen).toBeDefined();
    expect(typeof aggErr?.lastSeen).toBe("string");
    expect(aggErr?.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("iter698: byTool/byCaller/byChain entries carry lastSeen (MAX(timestamp) per group)", async () => {
    const { insertAudit, auditSummary } = await import("./db.js");
    const TOOL = "iter698_test";
    insertAudit({
      timestamp: "2026-03-01T00:00:00.000Z", caller: "cli", tool: TOOL,
      account: ACCOUNT, chain: "polygon", params_json: "{}", simulation_json: null,
      result: "ok", error_code: null, error_message: null, tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-03-15T08:00:00.000Z", caller: "mcp", tool: TOOL,
      account: ACCOUNT, chain: "polygon", params_json: "{}", simulation_json: null,
      result: "ok", error_code: null, error_message: null, tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-03-10T00:00:00.000Z", caller: "cli", tool: TOOL,
      account: ACCOUNT, chain: "base", params_json: "{}", simulation_json: null,
      result: "ok", error_code: null, error_message: null, tx_hash: null,
    });
    const r = auditSummary({ tool: TOOL });
    const tool = r.byTool.find((t) => t.tool === TOOL);
    // 3 rows total → lastSeen is the latest of the three.
    expect(tool?.lastSeen).toBe("2026-03-15T08:00:00.000Z");
    // byCaller: cli (2 rows, latest 2026-03-10) + mcp (1 row, 2026-03-15)
    const cliCaller = r.byCaller.find((c) => c.caller === "cli");
    const mcpCaller = r.byCaller.find((c) => c.caller === "mcp");
    expect(cliCaller?.lastSeen).toBe("2026-03-10T00:00:00.000Z");
    expect(mcpCaller?.lastSeen).toBe("2026-03-15T08:00:00.000Z");
    // byChain: polygon (2 rows, latest 2026-03-15) + base (1 row, 2026-03-10)
    const polyChain = r.byChain.find((c) => c.chain === "polygon");
    const baseChain = r.byChain.find((c) => c.chain === "base");
    expect(polyChain?.lastSeen).toBe("2026-03-15T08:00:00.000Z");
    expect(baseChain?.lastSeen).toBe("2026-03-10T00:00:00.000Z");
  });

  it("iter697: byErrorCode.lastSeen carries MAX(timestamp) per code group", async () => {
    const { insertAudit, auditSummary } = await import("./db.js");
    const TOOL = "iter697_test";
    const CODE = "ITER697_TEST_CODE";
    // 3 rows with the same code at different timestamps. MAX should pick
    // the latest.
    insertAudit({
      timestamp: "2026-04-01T00:00:00.000Z", caller: "test", tool: TOOL,
      account: ACCOUNT, chain: CHAIN, params_json: "{}", simulation_json: null,
      result: "error", error_code: CODE, error_message: "x", tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-04-15T12:34:56.000Z", caller: "test", tool: TOOL,
      account: ACCOUNT, chain: CHAIN, params_json: "{}", simulation_json: null,
      result: "error", error_code: CODE, error_message: "y", tx_hash: null,
    });
    insertAudit({
      timestamp: "2026-04-10T00:00:00.000Z", caller: "test", tool: TOOL,
      account: ACCOUNT, chain: CHAIN, params_json: "{}", simulation_json: null,
      result: "error", error_code: CODE, error_message: "z", tx_hash: null,
    });
    const r = auditSummary({ tool: TOOL });
    const entry = r.byErrorCode.find((e) => e.errorCode === CODE);
    expect(entry?.count).toBe(3);
    expect(entry?.lastSeen).toBe("2026-04-15T12:34:56.000Z"); // latest, not insertion order
  });

  it("respects since filter (only counts rows at or after timestamp)", async () => {
    const { insertAudit, auditSummary } = await import("./db.js");
    const past = "2026-01-01T00:00:00.000Z";
    const future = "2027-01-01T00:00:00.000Z";
    insertAudit({
      timestamp: past,
      caller: "cli",
      tool: "iter631test_filter",
      account: null,
      chain: null,
      params_json: null,
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: null,
    });
    insertAudit({
      timestamp: future,
      caller: "cli",
      tool: "iter631test_filter",
      account: null,
      chain: null,
      params_json: null,
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: null,
    });
    // Window that captures only the future row.
    const r = auditSummary({ since: "2026-12-01T00:00:00.000Z", tool: "iter631test_filter" });
    expect(r.totalRows).toBe(1);
    expect(r.earliest).toBe(future);
  });

  it("byChain collapses NULL chain into '(none)' bucket", async () => {
    const { insertAudit, auditSummary } = await import("./db.js");
    insertAudit({
      timestamp: "2026-02-01T00:00:00.000Z",
      caller: "cli",
      tool: "iter631test_chainless",
      account: null,
      chain: null,
      params_json: null,
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: null,
    });
    const r = auditSummary({ tool: "iter631test_chainless" });
    const noneBucket = r.byChain.find((c) => c.chain === "(none)");
    expect(noneBucket?.count).toBeGreaterThanOrEqual(1);
  });

  it("byErrorCode excludes rows with NULL error_code (success rows)", async () => {
    const { insertAudit, auditSummary } = await import("./db.js");
    insertAudit({
      timestamp: "2026-03-01T00:00:00.000Z",
      caller: "cli",
      tool: "iter631test_successonly",
      account: null,
      chain: null,
      params_json: null,
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: null,
    });
    const r = auditSummary({ tool: "iter631test_successonly" });
    expect(r.byErrorCode).toEqual([]);
  });
});

// ── block_number tracking (iter635) ────────────────────────

describe("block_number tracking", () => {
  it("insertTrade persists block_number when provided", async () => {
    const { insertTrade, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({
      account: "iter635-acct",
      tx_hash: "0x" + "a".repeat(64),
      block_number: 12345678,
    }));
    expect(id).toBeGreaterThan(0);
    const rows = recentTrades({ account: "iter635-acct", limit: 10 });
    const row = rows.find((r) => r.id === id);
    expect(row?.block_number).toBe(12345678);
  });

  it("insertTrade with undefined block_number persists NULL", async () => {
    const { insertTrade, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({ account: "iter635-acct-null" }));
    const row = recentTrades({ account: "iter635-acct-null", limit: 10 }).find((r) => r.id === id);
    expect(row?.block_number ?? null).toBeNull();
  });

  it("updateTradeStatus with block_number backfills the column", async () => {
    const { insertTrade, updateTradeStatus, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({ account: "iter635-update", status: "pending" }));
    updateTradeStatus(id, "success", {
      gas_used: "100000",
      gas_cost_native: "0.001",
      block_number: 99_999_999,
    });
    const row = recentTrades({ account: "iter635-update", limit: 10 }).find((r) => r.id === id);
    expect(row?.block_number).toBe(99_999_999);
    expect(row?.status).toBe("success");
  });

  it("updateTradeStatus without block_number preserves existing value", async () => {
    const { insertTrade, updateTradeStatus, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({
      account: "iter635-preserve",
      status: "pending",
      block_number: 5_000_000,
    }));
    updateTradeStatus(id, "success", {
      gas_used: "100000",
      gas_cost_native: "0.001",
      // No block_number — should preserve the original.
    });
    const row = recentTrades({ account: "iter635-preserve", limit: 10 }).find((r) => r.id === id);
    expect(row?.block_number).toBe(5_000_000);
  });

  it("iter641: insertTrade persists realized_slippage_bps when provided", async () => {
    const { insertTrade, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({
      account: "iter641-insert",
      realized_slippage_bps: 42.5,
    }));
    const row = recentTrades({ account: "iter641-insert", limit: 10 }).find((r) => r.id === id);
    expect(row?.realized_slippage_bps).toBeCloseTo(42.5, 2);
  });

  it("iter641: updateTradeStatus with realized_slippage_bps backfills the column", async () => {
    const { insertTrade, updateTradeStatus, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({ account: "iter641-update", status: "pending" }));
    updateTradeStatus(id, "success", {
      gas_used: "100000",
      gas_cost_native: "0.001",
      realized_slippage_bps: 15.3,
    });
    const row = recentTrades({ account: "iter641-update", limit: 10 }).find((r) => r.id === id);
    expect(row?.realized_slippage_bps).toBeCloseTo(15.3, 2);
    expect(row?.status).toBe("success");
  });

  it("iter641: updateTradeStatus without realized_slippage_bps preserves existing", async () => {
    const { insertTrade, updateTradeStatus, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({
      account: "iter641-preserve",
      status: "pending",
      realized_slippage_bps: 88.8,
    }));
    updateTradeStatus(id, "success", {
      gas_used: "100000",
      gas_cost_native: "0.001",
    });
    const row = recentTrades({ account: "iter641-preserve", limit: 10 }).find((r) => r.id === id);
    expect(row?.realized_slippage_bps).toBeCloseTo(88.8, 2);
  });

  it("iter646: insertTrade persists gas_cost_usd_at_trade", async () => {
    const { insertTrade, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({
      account: "iter646-insert",
      gas_cost_usd_at_trade: 17.5,
    }));
    const row = recentTrades({ account: "iter646-insert", limit: 10 }).find((r) => r.id === id);
    expect(row?.gas_cost_usd_at_trade).toBeCloseTo(17.5, 2);
  });

  it("iter646: updateTradeStatus with gas_cost_usd_at_trade backfills the column", async () => {
    const { insertTrade, updateTradeStatus, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({ account: "iter646-update", status: "pending" }));
    updateTradeStatus(id, "success", {
      gas_used: "100000",
      gas_cost_native: "0.005",
      gas_cost_usd_at_trade: 17.5,
    });
    const row = recentTrades({ account: "iter646-update", limit: 10 }).find((r) => r.id === id);
    expect(row?.gas_cost_usd_at_trade).toBeCloseTo(17.5, 2);
  });

  it("iter648: insertTrade persists strategy tag", async () => {
    const { insertTrade, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({
      account: "iter648-insert",
      strategy: "dca-eth",
    }));
    const row = recentTrades({ account: "iter648-insert", limit: 10 }).find((r) => r.id === id);
    expect(row?.strategy).toBe("dca-eth");
  });

  it("iter648: recentTrades respects --strategy filter", async () => {
    const ACCT = "iter648-filter";
    insertTrade(trade({ account: ACCT, strategy: "dca-eth", tx_hash: "0x101" }));
    insertTrade(trade({ account: ACCT, strategy: "dca-eth", tx_hash: "0x102" }));
    insertTrade(trade({ account: ACCT, strategy: "swing", tx_hash: "0x103" }));
    insertTrade(trade({ account: ACCT, strategy: null, tx_hash: "0x104" }));
    const { recentTrades } = await import("./db.js");
    const dca = recentTrades({ account: ACCT, strategy: "dca-eth", limit: 10 });
    expect(dca.length).toBe(2);
    expect(dca.every((r) => r.strategy === "dca-eth")).toBe(true);
  });

  it("iter661: recentTrades respects txHash filter (case-insensitive)", async () => {
    const ACCT = "iter661-txfilter";
    const HASH = "0x" + "Ab".repeat(32); // mixed-case hex, 64 chars
    insertTrade(trade({ account: ACCT, tx_hash: HASH }));
    insertTrade(trade({ account: ACCT, tx_hash: "0x" + "cd".repeat(32) }));
    insertTrade(trade({ account: ACCT, tx_hash: "0x" + "ef".repeat(32) }));
    const { recentTrades } = await import("./db.js");
    // Exact-case match
    expect(recentTrades({ account: ACCT, txHash: HASH, limit: 10 }).length).toBe(1);
    // Lowercased query matches mixed-case stored hash
    expect(recentTrades({ account: ACCT, txHash: HASH.toLowerCase(), limit: 10 }).length).toBe(1);
    // Uppercased query matches too
    expect(recentTrades({ account: ACCT, txHash: HASH.toUpperCase(), limit: 10 }).length).toBe(1);
    // Different hash → no match
    expect(recentTrades({ account: ACCT, txHash: "0x" + "00".repeat(32), limit: 10 }).length).toBe(0);
  });

  it("iter661: txHash filter is independent of other filters", async () => {
    // Lookup-by-hash should return the row even if you forgot to scope to its account.
    const HASH = "0x" + "ba".repeat(32);
    insertTrade(trade({ account: "iter661-acctA", tx_hash: HASH }));
    const { recentTrades } = await import("./db.js");
    // No account filter: still finds it.
    const found = recentTrades({ txHash: HASH, limit: 10 });
    expect(found.length).toBe(1);
    expect(found[0].account).toBe("iter661-acctA");
  });

  it("iter662: recentTrades respects aggregator filter (case-insensitive)", async () => {
    const ACCT = "iter662-aggfilter";
    insertTrade(trade({ account: ACCT, aggregator: "openocean", tx_hash: "0x" + "11".repeat(32) }));
    insertTrade(trade({ account: ACCT, aggregator: "openocean", tx_hash: "0x" + "12".repeat(32) }));
    insertTrade(trade({ account: ACCT, aggregator: "kyberswap", tx_hash: "0x" + "13".repeat(32) }));
    insertTrade(trade({ account: ACCT, aggregator: "0x", tx_hash: "0x" + "14".repeat(32) }));
    const { recentTrades } = await import("./db.js");
    const oo = recentTrades({ account: ACCT, aggregator: "openocean", limit: 10 });
    expect(oo.length).toBe(2);
    expect(oo.every((r) => r.aggregator === "openocean")).toBe(true);
    // Case-insensitive
    expect(recentTrades({ account: ACCT, aggregator: "OpenOcean", limit: 10 }).length).toBe(2);
    expect(recentTrades({ account: ACCT, aggregator: "OPENOCEAN", limit: 10 }).length).toBe(2);
    // Single-aggregator rows
    expect(recentTrades({ account: ACCT, aggregator: "kyberswap", limit: 10 }).length).toBe(1);
  });

  it("iter663: aggregator stats wiring scopes via recentTrades strategy filter", async () => {
    // End-to-end wiring: when an aggregator-stats consumer pipes a strategy-
    // filtered recentTrades() result into computeAggregatorStats, the resulting
    // stats are scoped to that strategy. This locks the contract that CLI and
    // MCP both rely on (iter663 changes were just "pass strategy through" — the
    // actual scoping happens at the DB layer).
    const ACCT = "iter663-wiring";
    insertTrade(trade({ account: ACCT, aggregator: "openocean", strategy: "dca", tx_hash: "0x" + "a1".repeat(32) }));
    insertTrade(trade({ account: ACCT, aggregator: "openocean", strategy: "dca", tx_hash: "0x" + "a2".repeat(32) }));
    insertTrade(trade({ account: ACCT, aggregator: "kyberswap", strategy: "swing", tx_hash: "0x" + "a3".repeat(32) }));
    insertTrade(trade({ account: ACCT, aggregator: "kyberswap", strategy: "swing", tx_hash: "0x" + "a4".repeat(32) }));
    insertTrade(trade({ account: ACCT, aggregator: "kyberswap", strategy: "swing", tx_hash: "0x" + "a5".repeat(32) }));

    const { recentTrades } = await import("./db.js");
    const { computeAggregatorStats } = await import("./aggregatorStats.js");

    // Within strategy "dca": only openocean should appear.
    const dcaRows = recentTrades({ account: ACCT, strategy: "dca", limit: 100 });
    const dcaStats = computeAggregatorStats(dcaRows, []);
    expect(dcaStats.byAggregator.map((s) => s.aggregator).sort()).toEqual(["openocean"]);
    expect(dcaStats.totalTrades).toBe(2);

    // Within strategy "swing": only kyberswap.
    const swingRows = recentTrades({ account: ACCT, strategy: "swing", limit: 100 });
    const swingStats = computeAggregatorStats(swingRows, []);
    expect(swingStats.byAggregator.map((s) => s.aggregator).sort()).toEqual(["kyberswap"]);
    expect(swingStats.totalTrades).toBe(3);

    // Without filter: both aggregators appear (sanity — same input, no scoping).
    const allRows = recentTrades({ account: ACCT, limit: 100 });
    const allStats = computeAggregatorStats(allRows, []);
    expect(allStats.byAggregator.map((s) => s.aggregator).sort()).toEqual(["kyberswap", "openocean"]);
  });

  it("iter682: recentPairFailureHistogram scopes to pair + chain + account + window", async () => {
    const ACCT = "iter682-pair";
    const BASE = "0x" + "11".repeat(20);
    const QUOTE = "0x" + "22".repeat(20);
    const OTHER = "0x" + "33".repeat(20);

    // 3 failures on BASE/QUOTE pair, same reason
    insertTrade(trade({ account: ACCT, status: "failed", base_token: BASE, quote_token: QUOTE, revert_reason: "Too little received", tx_hash: "0x" + "01".repeat(32) }));
    insertTrade(trade({ account: ACCT, status: "failed", base_token: BASE, quote_token: QUOTE, revert_reason: "Too little received", tx_hash: "0x" + "02".repeat(32) }));
    insertTrade(trade({ account: ACCT, status: "failed", base_token: BASE, quote_token: QUOTE, revert_reason: "STF", tx_hash: "0x" + "03".repeat(32) }));
    // Failure on different pair → excluded
    insertTrade(trade({ account: ACCT, status: "failed", base_token: BASE, quote_token: OTHER, revert_reason: "should not count", tx_hash: "0x" + "04".repeat(32) }));
    // Success on the pair → excluded
    insertTrade(trade({ account: ACCT, status: "success", base_token: BASE, quote_token: QUOTE, tx_hash: "0x" + "05".repeat(32) }));

    const { recentPairFailureHistogram } = await import("./db.js");
    const result = recentPairFailureHistogram({
      chain: CHAIN,
      account: ACCT,
      baseToken: BASE,
      quoteToken: QUOTE,
      sinceIso: "2020-01-01T00:00:00.000Z",
    });
    expect(result.total).toBe(3);
    // Iter699: lastSeen may be present — partial match.
    expect(result.reasons).toMatchObject([
      { reason: "Too little received", count: 2 },
      { reason: "STF", count: 1 },
    ]);
  });

  it("iter682: pair match is symmetric (BASE/QUOTE matches QUOTE/BASE direction)", async () => {
    // Operators trade both directions of the same pair. A failure on the
    // sell side should count for the next buy on the same pair.
    const ACCT = "iter682-symmetric";
    const ETH = "0x" + "ee".repeat(20);
    const USDC = "0x" + "dd".repeat(20);
    insertTrade(trade({ account: ACCT, status: "failed", base_token: ETH, quote_token: USDC, revert_reason: "X", tx_hash: "0x" + "11".repeat(32) }));
    insertTrade(trade({ account: ACCT, status: "failed", base_token: USDC, quote_token: ETH, revert_reason: "X", tx_hash: "0x" + "12".repeat(32) }));

    const { recentPairFailureHistogram } = await import("./db.js");
    const fwd = recentPairFailureHistogram({
      chain: CHAIN, account: ACCT, baseToken: ETH, quoteToken: USDC, sinceIso: "2020-01-01T00:00:00Z",
    });
    expect(fwd.total).toBe(2);
    // Reverse direction returns the same pair
    const rev = recentPairFailureHistogram({
      chain: CHAIN, account: ACCT, baseToken: USDC, quoteToken: ETH, sinceIso: "2020-01-01T00:00:00Z",
    });
    expect(rev.total).toBe(2);
  });

  it("iter682: respects the sinceIso window", async () => {
    const ACCT = "iter682-window";
    const BASE = "0x" + "aa".repeat(20);
    const QUOTE = "0x" + "bb".repeat(20);
    insertTrade(trade({ account: ACCT, status: "failed", base_token: BASE, quote_token: QUOTE, revert_reason: "old", tx_hash: "0x" + "21".repeat(32), timestamp: "2024-01-01T00:00:00Z" }));
    insertTrade(trade({ account: ACCT, status: "failed", base_token: BASE, quote_token: QUOTE, revert_reason: "new", tx_hash: "0x" + "22".repeat(32), timestamp: "2026-05-01T00:00:00Z" }));

    const { recentPairFailureHistogram } = await import("./db.js");
    const recent = recentPairFailureHistogram({
      chain: CHAIN, account: ACCT, baseToken: BASE, quoteToken: QUOTE, sinceIso: "2026-01-01T00:00:00Z",
    });
    expect(recent.total).toBe(1);
    expect(recent.reasons[0].reason).toBe("new");
  });

  it("iter683: recentRecipientFailureHistogram filters by transfer + recipient + window", async () => {
    const ACCT = "iter683-recipient";
    const RECIPIENT = "0x742d35Cc6635C0532925a3b8c89A1eFE6f7b3e51";
    insertTrade(trade({
      account: ACCT, status: "failed", aggregator: "transfer",
      notes: `transfer to ${RECIPIENT}`,
      revert_reason: "Recipient is contract",
      tx_hash: "0x" + "31".repeat(32),
    }));
    insertTrade(trade({
      account: ACCT, status: "failed", aggregator: "transfer",
      notes: `note  •  transfer to ${RECIPIENT}`,
      revert_reason: "Recipient is contract",
      tx_hash: "0x" + "32".repeat(32),
    }));
    // Different recipient → excluded
    insertTrade(trade({
      account: ACCT, status: "failed", aggregator: "transfer",
      notes: `transfer to 0x" + "ff".repeat(20)`,
      revert_reason: "should not count",
      tx_hash: "0x" + "33".repeat(32),
    }));
    // Success → excluded
    insertTrade(trade({
      account: ACCT, status: "success", aggregator: "transfer",
      notes: `transfer to ${RECIPIENT}`,
      tx_hash: "0x" + "34".repeat(32),
    }));
    // Non-transfer aggregator → excluded
    insertTrade(trade({
      account: ACCT, status: "failed", aggregator: "kyberswap",
      notes: `transfer to ${RECIPIENT}`,
      tx_hash: "0x" + "35".repeat(32),
    }));

    const { recentRecipientFailureHistogram } = await import("./db.js");
    const result = recentRecipientFailureHistogram({
      chain: CHAIN, account: ACCT, recipient: RECIPIENT, sinceIso: "2020-01-01T00:00:00Z",
    });
    expect(result.total).toBe(2);
    expect(result.reasons).toMatchObject([{ reason: "Recipient is contract", count: 2 }]);
  });

  it("iter715: lastTradeAtByAccount returns MAX(timestamp) per account label", async () => {
    insertTrade(trade({ account: "iter715-alice", timestamp: "2026-05-01T00:00:00Z", tx_hash: "0x" + "a1".repeat(32) }));
    insertTrade(trade({ account: "iter715-alice", timestamp: "2026-05-15T12:00:00Z", tx_hash: "0x" + "a2".repeat(32) })); // latest for alice
    insertTrade(trade({ account: "iter715-alice", timestamp: "2026-05-10T00:00:00Z", tx_hash: "0x" + "a3".repeat(32) }));
    insertTrade(trade({ account: "iter715-bob", timestamp: "2026-04-01T00:00:00Z", tx_hash: "0x" + "b1".repeat(32) }));
    const { lastTradeAtByAccount } = await import("./db.js");
    const map = lastTradeAtByAccount();
    expect(map.get("iter715-alice")).toBe("2026-05-15T12:00:00Z");
    expect(map.get("iter715-bob")).toBe("2026-04-01T00:00:00Z");
  });

  it("iter716: lastTradeAtBySymbol returns MAX(timestamp) per (chain, symbol)", async () => {
    insertTrade(trade({
      account: "iter716", chain: "base", base_symbol: "ETH",
      timestamp: "2026-05-01T00:00:00Z", tx_hash: "0x" + "16a1".padEnd(64, "1"),
    }));
    insertTrade(trade({
      account: "iter716", chain: "base", base_symbol: "ETH",
      timestamp: "2026-05-15T12:00:00Z", tx_hash: "0x" + "16a2".padEnd(64, "2"),
    })); // latest for base:ETH
    insertTrade(trade({
      account: "iter716", chain: "arbitrum", base_symbol: "ETH",
      timestamp: "2026-05-10T00:00:00Z", tx_hash: "0x" + "16a3".padEnd(64, "3"),
    }));
    insertTrade(trade({
      account: "iter716", chain: "base", base_symbol: "PEPE",
      timestamp: "2026-04-01T00:00:00Z", tx_hash: "0x" + "16a4".padEnd(64, "4"),
    }));
    const { lastTradeAtBySymbol } = await import("./db.js");
    const map = lastTradeAtBySymbol({ account: "iter716" });
    expect(map.get("base:ETH")).toBe("2026-05-15T12:00:00Z");
    expect(map.get("arbitrum:ETH")).toBe("2026-05-10T00:00:00Z");
    expect(map.get("base:PEPE")).toBe("2026-04-01T00:00:00Z");
  });

  it("iter716: symbol is uppercased in the key (regardless of stored casing)", async () => {
    insertTrade(trade({
      account: "iter716-case", chain: "base", base_symbol: "weth",
      timestamp: "2026-06-01T00:00:00Z", tx_hash: "0x" + "16b1".padEnd(64, "1"),
    }));
    const { lastTradeAtBySymbol } = await import("./db.js");
    const map = lastTradeAtBySymbol({ account: "iter716-case" });
    expect(map.get("base:WETH")).toBe("2026-06-01T00:00:00Z");
    expect(map.get("base:weth")).toBeUndefined();
  });

  it("iter715: accounts without trades are absent from the map", async () => {
    const { lastTradeAtByAccount } = await import("./db.js");
    const map = lastTradeAtByAccount();
    // No trades inserted for this account.
    expect(map.get("iter715-no-trades")).toBeUndefined();
  });

  it("iter735: accountActivitySummary returns count + first/last per account", async () => {
    insertTrade(trade({ account: "iter735-acct", timestamp: "2026-01-01T00:00:00Z", tx_hash: "0x" + "7351".padEnd(64, "1") }));
    insertTrade(trade({ account: "iter735-acct", timestamp: "2026-05-15T12:00:00Z", tx_hash: "0x" + "7352".padEnd(64, "2") }));
    insertTrade(trade({ account: "iter735-acct", timestamp: "2026-03-10T00:00:00Z", tx_hash: "0x" + "7353".padEnd(64, "3") }));
    const { accountActivitySummary } = await import("./db.js");
    const map = accountActivitySummary();
    const entry = map.get("iter735-acct");
    expect(entry?.tradeCount).toBe(3);
    expect(entry?.firstTradeAt).toBe("2026-01-01T00:00:00Z");
    expect(entry?.lastTradeAt).toBe("2026-05-15T12:00:00Z"); // MAX, not insertion order
  });

  it("iter735: accountActivitySummary excludes accounts with no trades", async () => {
    const { accountActivitySummary } = await import("./db.js");
    const map = accountActivitySummary();
    expect(map.get("iter735-never-traded")).toBeUndefined();
  });

  it("iter675: failureReasonHistogram buckets failed rows, ignores others", async () => {
    const { failureReasonHistogram } = await import("./db.js");
    const rows = [
      { status: "failed", revert_reason: "Too little received" },
      { status: "failed", revert_reason: "Too little received" },
      { status: "failed", revert_reason: "STF" },
      { status: "success", revert_reason: "should not appear" }, // ignored
      { status: "pending", revert_reason: null }, // ignored
    ] as Parameters<typeof failureReasonHistogram>[0];
    expect(failureReasonHistogram(rows)).toEqual([
      { reason: "Too little received", count: 2 },
      { reason: "STF", count: 1 },
    ]);
  });

  it("iter675: failureReasonHistogram treats NULL + whitespace as '(unknown)'", async () => {
    const { failureReasonHistogram } = await import("./db.js");
    const rows = [
      { status: "failed", revert_reason: null },
      { status: "failed", revert_reason: "" },
      { status: "failed", revert_reason: "   " },
      { status: "failed", revert_reason: "Real" },
    ] as Parameters<typeof failureReasonHistogram>[0];
    expect(failureReasonHistogram(rows)).toEqual([
      { reason: "(unknown)", count: 3 },
      { reason: "Real", count: 1 },
    ]);
  });

  it("iter699: failureReasonHistogram surfaces lastSeen per reason bucket (MAX timestamp)", async () => {
    const { failureReasonHistogram } = await import("./db.js");
    const rows = [
      { status: "failed", revert_reason: "Too little received", timestamp: "2026-05-01T00:00:00Z" },
      { status: "failed", revert_reason: "Too little received", timestamp: "2026-05-15T12:00:00Z" }, // latest for this reason
      { status: "failed", revert_reason: "Too little received", timestamp: "2026-05-10T00:00:00Z" },
      { status: "failed", revert_reason: "STF", timestamp: "2026-05-20T00:00:00Z" },
    ] as Parameters<typeof failureReasonHistogram>[0];
    const result = failureReasonHistogram(rows);
    const tlr = result.find((r) => r.reason === "Too little received");
    const stf = result.find((r) => r.reason === "STF");
    expect(tlr?.count).toBe(3);
    expect(tlr?.lastSeen).toBe("2026-05-15T12:00:00Z");
    expect(stf?.count).toBe(1);
    expect(stf?.lastSeen).toBe("2026-05-20T00:00:00Z");
  });

  it("iter699: lastSeen is omitted when row timestamps absent (back-compat with iter675)", async () => {
    const { failureReasonHistogram } = await import("./db.js");
    // Pre-iter699 callers used Pick<TradeRow, "status" | "revert_reason"> —
    // shape without timestamp. Helper should still work; lastSeen field
    // simply absent on each entry.
    const rows = [
      { status: "failed", revert_reason: "X" },
      { status: "failed", revert_reason: "X" },
    ] as Parameters<typeof failureReasonHistogram>[0];
    const result = failureReasonHistogram(rows);
    expect(result[0].count).toBe(2);
    expect(result[0].lastSeen).toBeUndefined();
  });

  it("iter675: failureReasonHistogram returns [] for empty / no-failure input", async () => {
    const { failureReasonHistogram } = await import("./db.js");
    expect(failureReasonHistogram([])).toEqual([]);
    expect(
      failureReasonHistogram([
        { status: "success", revert_reason: null },
        { status: "pending", revert_reason: null },
      ] as Parameters<typeof failureReasonHistogram>[0]),
    ).toEqual([]);
  });

  it("iter669: revert_reason column persists across insertTrade + recentTrades roundtrip", async () => {
    const ACCT = "iter669-revert";
    const id = insertTrade(trade({
      account: ACCT,
      status: "failed",
      revert_reason: "Too little received",
      tx_hash: "0x" + "ee".repeat(32),
    }));
    const { recentTrades } = await import("./db.js");
    const row = recentTrades({ account: ACCT, limit: 10 }).find((r) => r.id === id);
    expect(row?.revert_reason).toBe("Too little received");
  });

  it("iter669: updateTradeStatus persists revert_reason via the dynamic SET builder", async () => {
    const ACCT = "iter669-update";
    const id = insertTrade(trade({ account: ACCT, status: "pending", tx_hash: "0x" + "ed".repeat(32) }));
    const { updateTradeStatus, recentTrades } = await import("./db.js");
    updateTradeStatus(id, "failed", {
      gas_used: "21000",
      gas_cost_native: "0.001",
      block_number: 12345,
      revert_reason: "STF",
    });
    const row = recentTrades({ account: ACCT, limit: 10 }).find((r) => r.id === id);
    expect(row?.status).toBe("failed");
    expect(row?.revert_reason).toBe("STF");
    expect(row?.block_number).toBe(12345);
  });

  it("iter669: updateTradeStatus with revert_reason=undefined preserves the existing value", async () => {
    // Same semantics as block_number / slippage / gas_usd: undefined means
    // "don't touch this column". A two-stage update (first reconcile sets
    // the reason, a subsequent reconcile passes undefined) must NOT clobber.
    const ACCT = "iter669-preserve";
    const id = insertTrade(trade({
      account: ACCT,
      status: "failed",
      revert_reason: "Too little received",
      tx_hash: "0x" + "ec".repeat(32),
    }));
    const { updateTradeStatus, recentTrades } = await import("./db.js");
    updateTradeStatus(id, "failed", {
      gas_used: "21000",
      gas_cost_native: "0.001",
      // revert_reason omitted — should preserve
    });
    const row = recentTrades({ account: ACCT, limit: 10 }).find((r) => r.id === id);
    expect(row?.revert_reason).toBe("Too little received");
  });

  it("iter669: updateTradeStatus with revert_reason=null explicitly clears", async () => {
    const ACCT = "iter669-clear";
    const id = insertTrade(trade({
      account: ACCT,
      status: "failed",
      revert_reason: "old reason",
      tx_hash: "0x" + "eb".repeat(32),
    }));
    const { updateTradeStatus, recentTrades } = await import("./db.js");
    updateTradeStatus(id, "failed", {
      gas_used: null,
      gas_cost_native: null,
      revert_reason: null,
    });
    const row = recentTrades({ account: ACCT, limit: 10 }).find((r) => r.id === id);
    expect(row?.revert_reason).toBeNull();
  });

  it("iter667: pool-then-filter semantics — '--recent N --status=failed' returns last N FAILED trades", async () => {
    // Pre-iter667 the analyze flow was: recentTrades(limit=N) then filter to
    // success. With sparse failures (say 1 failure per 20 trades), an operator
    // running `--recent 10 --status=failed` would get zero rows because none
    // of the most-recent 10 happened to be failed. Iter667 pools N×10 and
    // post-filters, so the operator gets up to N actual failures.
    const ACCT = "iter667-pool";
    // Insert 25 trades: 20 success + 5 failed, success rows are more recent.
    for (let i = 0; i < 5; i++) {
      insertTrade(trade({
        account: ACCT,
        status: "failed",
        tx_hash: "0x" + (10 + i).toString(16).padStart(2, "0").repeat(32),
        timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }));
    }
    for (let i = 0; i < 20; i++) {
      insertTrade(trade({
        account: ACCT,
        status: "success",
        tx_hash: "0x" + (50 + i).toString(16).padStart(2, "0").repeat(32),
        timestamp: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }));
    }

    const { recentTrades } = await import("./db.js");
    // The CLI/MCP iter667 query: query N×10, post-filter to status, slice to N.
    const wantedN = 5;
    const poolSize = wantedN * 10;
    const pool = recentTrades({ account: ACCT, limit: poolSize });
    const matching = pool.filter((r) => r.status === "failed");
    const rows = matching.slice(0, wantedN);

    // We should get all 5 failures even though the most-recent 10 rows are
    // pure success.
    expect(rows.length).toBe(5);
    expect(rows.every((r) => r.status === "failed")).toBe(true);

    // Sanity: the pre-iter667 approach (limit=N, post-filter) returns 0.
    const preIter667 = recentTrades({ account: ACCT, limit: wantedN }).filter((r) => r.status === "failed");
    expect(preIter667.length).toBe(0);
  });

  it("iter664/iter665: trades analyze --recent honors strategy + aggregator + status=success", async () => {
    // Locks the wiring contract trades-analyze (CLI + MCP) depends on: the
    // --recent path queries recentTrades({strategy, aggregator}) then filters
    // to success rows. Adding either filter must scope the selection BEFORE
    // the success filter, otherwise the analyze command would over-select.
    const ACCT = "iter664-wiring";
    insertTrade(trade({ account: ACCT, status: "success", strategy: "dca", aggregator: "openocean", tx_hash: "0x" + "b1".repeat(32) }));
    insertTrade(trade({ account: ACCT, status: "success", strategy: "dca", aggregator: "openocean", tx_hash: "0x" + "b2".repeat(32) }));
    insertTrade(trade({ account: ACCT, status: "success", strategy: "dca", aggregator: "kyberswap", tx_hash: "0x" + "b3".repeat(32) }));
    insertTrade(trade({ account: ACCT, status: "success", strategy: "swing", aggregator: "openocean", tx_hash: "0x" + "b4".repeat(32) }));
    insertTrade(trade({ account: ACCT, status: "failed", strategy: "dca", aggregator: "openocean", tx_hash: "0x" + "b5".repeat(32) }));
    insertTrade(trade({ account: ACCT, status: "pending", strategy: "dca", aggregator: "openocean", tx_hash: "0x" + "b6".repeat(32) }));

    const { recentTrades } = await import("./db.js");
    // Replicate the exact analyze-recent query pattern.
    const dcaOoSuccess = recentTrades({ account: ACCT, strategy: "dca", aggregator: "openocean", limit: 100 })
      .filter((r) => r.status === "success");
    expect(dcaOoSuccess.length).toBe(2);
    expect(dcaOoSuccess.every((r) => r.strategy === "dca" && r.aggregator === "openocean")).toBe(true);
    expect(dcaOoSuccess.every((r) => r.status === "success")).toBe(true);

    // Strategy alone — any aggregator within dca, success only.
    const dcaSuccess = recentTrades({ account: ACCT, strategy: "dca", limit: 100 })
      .filter((r) => r.status === "success");
    expect(dcaSuccess.length).toBe(3);

    // Aggregator alone — any strategy through openocean, success only.
    const ooSuccess = recentTrades({ account: ACCT, aggregator: "openocean", limit: 100 })
      .filter((r) => r.status === "success");
    expect(ooSuccess.length).toBe(3);

    // No filter — all success rows (excludes the failed + pending).
    const allSuccess = recentTrades({ account: ACCT, limit: 100 })
      .filter((r) => r.status === "success");
    expect(allSuccess.length).toBe(4);
  });

  it("iter661+iter662: filters compose with the existing axes", async () => {
    const ACCT = "iter662-compose";
    const TARGET = "0x" + "ff".repeat(32);
    insertTrade(trade({ account: ACCT, aggregator: "openocean", strategy: "dca", tx_hash: TARGET }));
    insertTrade(trade({ account: ACCT, aggregator: "openocean", strategy: "swing", tx_hash: "0x" + "01".repeat(32) }));
    insertTrade(trade({ account: ACCT, aggregator: "kyberswap", strategy: "dca", tx_hash: "0x" + "02".repeat(32) }));
    const { recentTrades } = await import("./db.js");
    const intersect = recentTrades({ account: ACCT, aggregator: "openocean", strategy: "dca", limit: 10 });
    expect(intersect.length).toBe(1);
    expect(intersect[0].tx_hash).toBe(TARGET);
  });

  it("iter648: allTrades respects strategy filter", async () => {
    const ACCT = "iter648-all-filter";
    insertTrade(trade({ account: ACCT, strategy: "dca", tx_hash: "0x201" }));
    insertTrade(trade({ account: ACCT, strategy: "swing", tx_hash: "0x202" }));
    const { allTrades } = await import("./db.js");
    const dca = allTrades({ account: ACCT, strategy: "dca" });
    expect(dca.length).toBe(1);
    expect(dca[0].strategy).toBe("dca");
  });

  it("iter651: listDistinctStrategies returns distinct tags + counts", async () => {
    const ACCT = "iter651-list";
    insertTrade(trade({
      account: ACCT,
      strategy: "dca-eth",
      tx_hash: "0x301",
      timestamp: "2026-01-01T00:00:00Z",
    }));
    insertTrade(trade({
      account: ACCT,
      strategy: "dca-eth",
      tx_hash: "0x302",
      timestamp: "2026-02-01T00:00:00Z",
    }));
    insertTrade(trade({
      account: ACCT,
      strategy: "swing",
      tx_hash: "0x303",
      timestamp: "2026-03-01T00:00:00Z",
    }));
    insertTrade(trade({
      account: ACCT,
      strategy: null, // untagged — should be excluded
      tx_hash: "0x304",
    }));
    const { listDistinctStrategies } = await import("./db.js");
    const list = listDistinctStrategies({ account: ACCT });
    expect(list.length).toBe(2);
    const dca = list.find((e) => e.strategy === "dca-eth");
    expect(dca?.tradeCount).toBe(2);
    expect(dca?.firstUsed).toBe("2026-01-01T00:00:00Z");
    expect(dca?.lastUsed).toBe("2026-02-01T00:00:00Z");
  });

  it("iter651: sorts strategies by lastUsed desc (most-active first)", async () => {
    const ACCT = "iter651-sort";
    insertTrade(trade({
      account: ACCT,
      strategy: "old-strategy",
      timestamp: "2025-01-01T00:00:00Z",
      tx_hash: "0x401",
    }));
    insertTrade(trade({
      account: ACCT,
      strategy: "new-strategy",
      timestamp: "2026-06-01T00:00:00Z",
      tx_hash: "0x402",
    }));
    const { listDistinctStrategies } = await import("./db.js");
    const list = listDistinctStrategies({ account: ACCT });
    expect(list[0].strategy).toBe("new-strategy");
    expect(list[1].strategy).toBe("old-strategy");
  });

  it("iter651: excludes NULL strategy rows entirely", async () => {
    const ACCT = "iter651-no-null";
    insertTrade(trade({ account: ACCT, strategy: null, tx_hash: "0x501" }));
    insertTrade(trade({ account: ACCT, strategy: null, tx_hash: "0x502" }));
    const { listDistinctStrategies } = await import("./db.js");
    expect(listDistinctStrategies({ account: ACCT })).toEqual([]);
  });

  it("iter651: respects chain filter", async () => {
    const ACCT = "iter651-chain";
    insertTrade(trade({ account: ACCT, strategy: "dca", chain: "base", tx_hash: "0x601" }));
    insertTrade(trade({ account: ACCT, strategy: "dca", chain: "arbitrum", tx_hash: "0x602" }));
    const { listDistinctStrategies } = await import("./db.js");
    const baseOnly = listDistinctStrategies({ account: ACCT, chain: "base" });
    expect(baseOnly[0].tradeCount).toBe(1);
  });

  it("iter655: legacyBackfillCounts returns the three missing-column counts", async () => {
    const ACCT = "iter655-counts";
    insertTrade(trade({
      account: ACCT,
      status: "success",
      block_number: null,
      realized_slippage_bps: null,
      gas_cost_native: "0.005",
      gas_cost_usd_at_trade: null,
      tx_hash: "0x801",
    }));
    insertTrade(trade({
      account: ACCT,
      status: "success",
      block_number: 100,
      realized_slippage_bps: 25,
      gas_cost_native: "0.005",
      gas_cost_usd_at_trade: 15,
      tx_hash: "0x802",
    }));
    // Failed status — excluded from the count
    insertTrade(trade({
      account: ACCT,
      status: "failed",
      block_number: null,
      realized_slippage_bps: null,
      gas_cost_usd_at_trade: null,
      tx_hash: "0x803",
    }));
    const { legacyBackfillCounts } = await import("./db.js");
    const counts = legacyBackfillCounts({ account: ACCT });
    expect(counts.missingBlockNumber).toBe(1);
    expect(counts.missingSlippage).toBe(1);
    expect(counts.missingGasUsd).toBe(1);
  });

  it("iter658: legacyBackfillCounts with no filter aggregates across all accounts", async () => {
    // Multi-account install: backfill is a global migration, so a no-filter
    // count must sum legacy rows from EVERY account. Pre-iter658 health
    // surfaced only the first account's count, hiding rows on others and
    // causing the same backfill nextAction to recur after a "successful"
    // run.
    const ACCT_A = "iter658-acct-a";
    const ACCT_B = "iter658-acct-b";
    insertTrade(trade({
      account: ACCT_A,
      status: "success",
      block_number: null,
      tx_hash: "0x901",
    }));
    insertTrade(trade({
      account: ACCT_B,
      status: "success",
      block_number: null,
      tx_hash: "0x902",
    }));
    insertTrade(trade({
      account: ACCT_B,
      status: "success",
      block_number: null,
      tx_hash: "0x903",
    }));
    const { legacyBackfillCounts } = await import("./db.js");
    const globalCounts = legacyBackfillCounts({});
    // Both accounts contribute (≥3, more if earlier tests inserted legacy rows).
    expect(globalCounts.missingBlockNumber).toBeGreaterThanOrEqual(3);
    // Single-account count is strictly less than the global aggregate.
    const acctA = legacyBackfillCounts({ account: ACCT_A });
    const acctB = legacyBackfillCounts({ account: ACCT_B });
    expect(acctA.missingBlockNumber).toBe(1);
    expect(acctB.missingBlockNumber).toBe(2);
    expect(globalCounts.missingBlockNumber).toBeGreaterThanOrEqual(
      acctA.missingBlockNumber + acctB.missingBlockNumber,
    );
  });

  it("iter654: successTradesWithoutGasUsd filters correctly", async () => {
    const ACCT = "iter654-list";
    insertTrade(trade({
      account: ACCT,
      status: "success",
      gas_cost_native: "0.005",
      gas_cost_usd_at_trade: null,
      tx_hash: "0x701",
    })); // ✓
    insertTrade(trade({
      account: ACCT,
      status: "success",
      gas_cost_native: "0.005",
      gas_cost_usd_at_trade: 17.5, // has USD
      tx_hash: "0x702",
    }));
    insertTrade(trade({
      account: ACCT,
      status: "success",
      gas_cost_native: null, // no native
      gas_cost_usd_at_trade: null,
      tx_hash: "0x703",
    }));
    insertTrade(trade({
      account: ACCT,
      status: "failed", // failed status
      gas_cost_native: "0.005",
      gas_cost_usd_at_trade: null,
      tx_hash: "0x704",
    }));
    insertTrade(trade({
      account: ACCT,
      status: "success",
      aggregator: "transfer", // transfer excluded
      gas_cost_native: "0.005",
      gas_cost_usd_at_trade: null,
      tx_hash: "0x705",
    }));
    const { successTradesWithoutGasUsd } = await import("./db.js");
    const rows = successTradesWithoutGasUsd({ account: ACCT });
    expect(rows.length).toBe(1);
    expect(rows[0].tx_hash).toBe("0x701");
  });

  it("iter646: updateTradeStatus without gas_cost_usd_at_trade preserves existing", async () => {
    const { insertTrade, updateTradeStatus, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({
      account: "iter646-preserve",
      status: "pending",
      gas_cost_usd_at_trade: 99.9,
    }));
    updateTradeStatus(id, "success", {
      gas_used: "100000",
      gas_cost_native: "0.005",
    });
    const row = recentTrades({ account: "iter646-preserve", limit: 10 }).find((r) => r.id === id);
    expect(row?.gas_cost_usd_at_trade).toBeCloseTo(99.9, 2);
  });

  it("iter641: updateTradeStatus with realized_slippage_bps: null explicitly clears", async () => {
    const { insertTrade, updateTradeStatus, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({
      account: "iter641-clear",
      realized_slippage_bps: 99,
    }));
    updateTradeStatus(id, "failed", {
      gas_used: "100000",
      gas_cost_native: "0.001",
      realized_slippage_bps: null,
    });
    const row = recentTrades({ account: "iter641-clear", limit: 10 }).find((r) => r.id === id);
    expect(row?.realized_slippage_bps ?? null).toBeNull();
  });

  it("updateTradeStatus with block_number: null explicitly clears the column", async () => {
    const { insertTrade, updateTradeStatus, recentTrades } = await import("./db.js");
    const id = insertTrade(trade({
      account: "iter635-clear",
      block_number: 7_777_777,
    }));
    updateTradeStatus(id, "failed", {
      gas_used: "100000",
      gas_cost_native: "0.001",
      block_number: null,
    });
    const row = recentTrades({ account: "iter635-clear", limit: 10 }).find((r) => r.id === id);
    expect(row?.block_number ?? null).toBeNull();
  });
});

// ── successTradesWithoutBlockNumber (iter637) ──────────────

describe("successTradesWithoutBlockNumber", () => {
  it("returns only status='success' rows with NULL block_number", async () => {
    const ACCT = "iter637-no-block";
    insertTrade(trade({ account: ACCT, status: "success", block_number: null }));
    insertTrade(trade({ account: ACCT, status: "success", block_number: 100 })); // has block
    insertTrade(trade({ account: ACCT, status: "failed", block_number: null })); // failed
    insertTrade(trade({ account: ACCT, status: "pending", block_number: null })); // pending
    const { successTradesWithoutBlockNumber } = await import("./db.js");
    const rows = successTradesWithoutBlockNumber({ account: ACCT });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("success");
    expect(rows[0].block_number ?? null).toBeNull();
  });

  it("respects limit", async () => {
    const ACCT = "iter637-limit";
    for (let i = 0; i < 5; i++) {
      insertTrade(trade({ account: ACCT, status: "success", block_number: null }));
    }
    const { successTradesWithoutBlockNumber } = await import("./db.js");
    const rows = successTradesWithoutBlockNumber({ account: ACCT, limit: 3 });
    expect(rows.length).toBe(3);
  });

  it("orders by id ASC (oldest legacy rows first)", async () => {
    const ACCT = "iter637-order";
    const id1 = insertTrade(trade({ account: ACCT, status: "success", block_number: null }));
    const id2 = insertTrade(trade({ account: ACCT, status: "success", block_number: null }));
    const id3 = insertTrade(trade({ account: ACCT, status: "success", block_number: null }));
    const { successTradesWithoutBlockNumber } = await import("./db.js");
    const rows = successTradesWithoutBlockNumber({ account: ACCT });
    expect(rows[0].id).toBe(id1);
    expect(rows[1].id).toBe(id2);
    expect(rows[2].id).toBe(id3);
  });

  it("respects chain filter", async () => {
    const ACCT = "iter637-chain";
    insertTrade(trade({ account: ACCT, status: "success", block_number: null, chain: "base" }));
    insertTrade(trade({ account: ACCT, status: "success", block_number: null, chain: "arbitrum" }));
    const { successTradesWithoutBlockNumber } = await import("./db.js");
    const baseRows = successTradesWithoutBlockNumber({ account: ACCT, chain: "base" });
    expect(baseRows.length).toBe(1);
    expect(baseRows[0].chain).toBe("base");
  });
});

// ── successTradesWithoutSlippage (iter643) ─────────────────

describe("successTradesWithoutSlippage", () => {
  it("returns only status='success' swaps with NULL realized_slippage_bps", async () => {
    const ACCT = "iter643-no-slip";
    insertTrade(trade({ account: ACCT, status: "success", realized_slippage_bps: null })); // ✓
    insertTrade(trade({ account: ACCT, status: "success", realized_slippage_bps: 25 })); // has slippage
    insertTrade(trade({ account: ACCT, status: "failed", realized_slippage_bps: null })); // failed
    insertTrade(trade({ account: ACCT, status: "pending", realized_slippage_bps: null })); // pending
    const { successTradesWithoutSlippage } = await import("./db.js");
    const rows = successTradesWithoutSlippage({ account: ACCT });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("success");
    expect(rows[0].realized_slippage_bps ?? null).toBeNull();
  });

  it("excludes transfer + incoming aggregator (not real swaps)", async () => {
    const ACCT = "iter643-no-transfers";
    insertTrade(trade({ account: ACCT, status: "success", aggregator: "transfer", realized_slippage_bps: null }));
    insertTrade(trade({ account: ACCT, status: "success", aggregator: "incoming", realized_slippage_bps: null }));
    insertTrade(trade({ account: ACCT, status: "success", aggregator: "kyberswap", realized_slippage_bps: null })); // ✓
    const { successTradesWithoutSlippage } = await import("./db.js");
    const rows = successTradesWithoutSlippage({ account: ACCT });
    expect(rows.length).toBe(1);
    expect(rows[0].aggregator).toBe("kyberswap");
  });

  it("respects limit", async () => {
    const ACCT = "iter643-limit";
    for (let i = 0; i < 5; i++) {
      insertTrade(trade({ account: ACCT, status: "success", realized_slippage_bps: null }));
    }
    const { successTradesWithoutSlippage } = await import("./db.js");
    const rows = successTradesWithoutSlippage({ account: ACCT, limit: 3 });
    expect(rows.length).toBe(3);
  });
});

// ── mostRecentTradeTimestamp (iter633) ─────────────────────

describe("mostRecentTradeTimestamp", () => {
  const ACCT = "iter633-rate-acct";

  it("returns null when account has no trades", async () => {
    const { mostRecentTradeTimestamp } = await import("./db.js");
    expect(mostRecentTradeTimestamp(ACCT)).toBeNull();
  });

  it("returns the latest timestamp for the account", async () => {
    insertTrade(trade({ account: ACCT, timestamp: "2026-01-01T00:00:00.000Z" }));
    insertTrade(trade({ account: ACCT, timestamp: "2026-03-01T00:00:00.000Z" }));
    insertTrade(trade({ account: ACCT, timestamp: "2026-02-01T00:00:00.000Z" }));
    const { mostRecentTradeTimestamp } = await import("./db.js");
    expect(mostRecentTradeTimestamp(ACCT)).toBe("2026-03-01T00:00:00.000Z");
  });

  it("includes failed + pending statuses (not just success)", async () => {
    const ACCT2 = "iter633-rate-acct-failed";
    insertTrade(trade({ account: ACCT2, timestamp: "2026-04-01T00:00:00.000Z", status: "success" }));
    insertTrade(trade({ account: ACCT2, timestamp: "2026-04-02T00:00:00.000Z", status: "failed" }));
    insertTrade(trade({ account: ACCT2, timestamp: "2026-04-03T00:00:00.000Z", status: "pending" }));
    const { mostRecentTradeTimestamp } = await import("./db.js");
    expect(mostRecentTradeTimestamp(ACCT2)).toBe("2026-04-03T00:00:00.000Z");
  });

  it("respects chain filter when provided", async () => {
    const ACCT3 = "iter633-rate-acct-chain";
    insertTrade(trade({ account: ACCT3, timestamp: "2026-05-01T00:00:00.000Z", chain: "base" }));
    insertTrade(trade({ account: ACCT3, timestamp: "2026-05-02T00:00:00.000Z", chain: "arbitrum" }));
    const { mostRecentTradeTimestamp } = await import("./db.js");
    expect(mostRecentTradeTimestamp(ACCT3, "base")).toBe("2026-05-01T00:00:00.000Z");
    expect(mostRecentTradeTimestamp(ACCT3, "arbitrum")).toBe("2026-05-02T00:00:00.000Z");
  });

  it("returns null when account name doesn't match any rows", async () => {
    const { mostRecentTradeTimestamp } = await import("./db.js");
    expect(mostRecentTradeTimestamp("never-existed-account")).toBeNull();
  });
});

describe("sync_bookmarks (iter737)", () => {
  const OWNER = "0xAbCdEf0123456789012345678901234567890123";

  it("getSyncBookmark returns null when no row exists", async () => {
    const { getSyncBookmark } = await import("./db.js");
    expect(getSyncBookmark("base", "iter737-fresh", OWNER)).toBeNull();
  });

  it("setSyncBookmark + getSyncBookmark round-trip preserves block number", async () => {
    const { setSyncBookmark, getSyncBookmark } = await import("./db.js");
    setSyncBookmark("base", "iter737-rt", OWNER, 32_500_000n);
    const b = getSyncBookmark("base", "iter737-rt", OWNER);
    expect(b?.lastSyncedBlock).toBe(32_500_000n);
    expect(b?.chain).toBe("base");
    expect(b?.account).toBe("iter737-rt");
    // owner stored lowercase regardless of input casing
    expect(b?.owner).toBe(OWNER.toLowerCase());
    expect(typeof b?.updatedAt).toBe("string");
  });

  it("setSyncBookmark upserts — second call for same key updates the block", async () => {
    const { setSyncBookmark, getSyncBookmark } = await import("./db.js");
    setSyncBookmark("base", "iter737-up", OWNER, 100n);
    setSyncBookmark("base", "iter737-up", OWNER, 200n);
    expect(getSyncBookmark("base", "iter737-up", OWNER)?.lastSyncedBlock).toBe(200n);
  });

  it("getSyncBookmark returns null when owner differs (mnemonic-rotation safety)", async () => {
    const { setSyncBookmark, getSyncBookmark } = await import("./db.js");
    setSyncBookmark("base", "iter737-rot", OWNER, 500n);
    const newOwner = "0x1111111111111111111111111111111111111111";
    expect(getSyncBookmark("base", "iter737-rot", newOwner)).toBeNull();
    // original owner still returns its bookmark
    expect(getSyncBookmark("base", "iter737-rot", OWNER)?.lastSyncedBlock).toBe(500n);
  });

  it("getSyncBookmark normalizes owner casing (input checksum vs stored lowercase)", async () => {
    const { setSyncBookmark, getSyncBookmark } = await import("./db.js");
    setSyncBookmark("base", "iter737-case", OWNER.toLowerCase(), 777n);
    // Query with checksum-cased address still hits
    expect(getSyncBookmark("base", "iter737-case", OWNER)?.lastSyncedBlock).toBe(777n);
  });

  it("clearSyncBookmark removes the row and returns 1; second call returns 0", async () => {
    const { setSyncBookmark, clearSyncBookmark, getSyncBookmark } = await import("./db.js");
    setSyncBookmark("base", "iter737-clr", OWNER, 999n);
    expect(clearSyncBookmark("base", "iter737-clr", OWNER)).toBe(1);
    expect(getSyncBookmark("base", "iter737-clr", OWNER)).toBeNull();
    expect(clearSyncBookmark("base", "iter737-clr", OWNER)).toBe(0);
  });

  it("listSyncBookmarks returns all bookmarks sorted by chain, account", async () => {
    const { setSyncBookmark, listSyncBookmarks } = await import("./db.js");
    // Add a couple more so the listing has multiple entries; rely on
    // already-inserted iter737-* rows from earlier tests too.
    setSyncBookmark("arbitrum", "iter737-list-a", OWNER, 1n);
    setSyncBookmark("arbitrum", "iter737-list-b", OWNER, 2n);
    const all = listSyncBookmarks();
    const arbs = all.filter((b) => b.chain === "arbitrum" && b.account.startsWith("iter737-list"));
    expect(arbs.map((b) => b.account)).toEqual(["iter737-list-a", "iter737-list-b"]);
  });
});

// ── recentSlippageStats (v40 cost-aware backtests) ───────────

describe("recentSlippageStats", () => {
  const SLIP_CHAIN = "v40-slip-chain"; // unique chain isolates from other suites
  it("averages |realized_slippage_bps| over recent SUCCESSFUL trades only", async () => {
    insertTrade(trade({ chain: SLIP_CHAIN, status: "success", realized_slippage_bps: 20 }));
    insertTrade(trade({ chain: SLIP_CHAIN, status: "success", realized_slippage_bps: -40 })); // abs() → 40
    insertTrade(trade({ chain: SLIP_CHAIN, status: "failed", realized_slippage_bps: 900 })); // excluded
    insertTrade(trade({ chain: SLIP_CHAIN, status: "success", realized_slippage_bps: null })); // excluded
    const { recentSlippageStats } = await import("./db.js");
    const stats = recentSlippageStats(SLIP_CHAIN)!;
    expect(stats.samples).toBe(2);
    expect(stats.avgAbsSlippageBps).toBeCloseTo(30, 9); // (20+40)/2
  });

  it("returns null when the chain has no slippage-stamped history", async () => {
    const { recentSlippageStats } = await import("./db.js");
    expect(recentSlippageStats("v40-empty-chain")).toBeNull();
  });

  it("respects the recency limit", async () => {
    const CH = "v40-slip-limit";
    for (let i = 0; i < 4; i++) {
      insertTrade(trade({
        chain: CH, status: "success", realized_slippage_bps: i < 2 ? 100 : 10,
        timestamp: new Date(Date.now() - (4 - i) * 60_000).toISOString(), // oldest first
      }));
    }
    const { recentSlippageStats } = await import("./db.js");
    // limit=2 → only the two NEWEST (10bps) rows.
    expect(recentSlippageStats(CH, 2)!.avgAbsSlippageBps).toBeCloseTo(10, 9);
  });
});

describe("recentGasStats — account=null aggregates across accounts (v40)", () => {
  it("null account sees every account's gas history on the chain", async () => {
    const CH = "v40-gas-chain";
    insertTrade(trade({ chain: CH, account: "a1", status: "success", gas_cost_native: "0.001" }));
    insertTrade(trade({ chain: CH, account: "a2", status: "success", gas_cost_native: "0.003" }));
    const { recentGasStats } = await import("./db.js");
    const scoped = recentGasStats(CH, "a1")!;
    expect(scoped.samples).toBe(1);
    expect(scoped.avgGasNative).toBeCloseTo(0.001, 12);
    const all = recentGasStats(CH, null)!;
    expect(all.samples).toBe(2);
    expect(all.avgGasNative).toBeCloseTo(0.002, 12);
  });
});

// ── backtest_runs.metrics_json round trip (v41) ──────────────

describe("backtest_runs metrics_json", () => {
  it("persists and reads back the metric pair; omitting it stays NULL", async () => {
    const { insertBacktestRun, getBacktestRunById } = await import("./db.js");
    const base = {
      strategyType: "order" as const, chain: "base", baseSymbol: "ETH", quoteSymbol: "USDC",
      specJson: "{}", initialBalanceJson: "{}", finalBalanceJson: "{}",
      windowStart: "2026-04-01T00:00:00Z", windowEnd: "2026-04-02T00:00:00Z",
      points: 2, firesJson: "[]", fireCount: 0, pnlUsd: 0, holdPnlUsd: 0,
    };
    const withMetrics = insertBacktestRun({
      ...base,
      metricsJson: JSON.stringify({ metrics: { maxDrawdownPct: 12.5 }, holdMetrics: { maxDrawdownPct: 20 } }),
    });
    const row = getBacktestRunById(withMetrics)!;
    const parsed = JSON.parse(row.metrics_json!) as { metrics: { maxDrawdownPct: number } };
    expect(parsed.metrics.maxDrawdownPct).toBe(12.5);

    const without = insertBacktestRun(base);
    expect(getBacktestRunById(without)!.metrics_json).toBeNull();
  });
});
