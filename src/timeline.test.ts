// Tests for timeline.ts (iter36). Two layers:
//
//   1. Pure collectors — each per-source function tested against
//      hand-built rows; no DB.
//   2. End-to-end collectTimeline against a seeded DB. Asserts on
//      cross-source merging + chronological ordering + filter
//      passthrough + limit truncation.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-timeline-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  collectTimeline,
  collectTradeEvents,
  collectPaperEvents,
  collectAuditEvents,
  collectAlertEvents,
  collectAlertEventsLegacy,
  collectScheduleJournalEvents,
  collectRebalanceJournalEvents,
  collectJournalEvents,
  resolveWindow,
  parseSinceDuration,
} = await import("./timeline.js");
const {
  openDb,
  closeDb,
  insertTrade,
  insertOrder,
  recordPaperTrade,
  insertAudit,
  insertOrderCheckEntry,
  upsertStrategyAlertState,
  insertAlertEvent,
  insertScheduleCheckEntry,
  insertRebalanceCheckEntry,
} = await import("./db.js");

beforeAll(() => openDb());
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM trades");
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM orders");
  db.exec("DELETE FROM order_check_log");
  db.exec("DELETE FROM strategy_alert_state");
  db.exec("DELETE FROM alert_events");
  db.exec("DELETE FROM schedule_check_log");
  db.exec("DELETE FROM rebalance_check_log");
  vi.clearAllMocks();
});

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

// ── resolveWindow ───────────────────────────────────────────

describe("resolveWindow", () => {
  it("defaults to last 4 hours", () => {
    const now = new Date("2026-05-31T12:00:00Z");
    const w = resolveWindow({ nowFn: () => now });
    expect(w.untilIso).toBe(now.toISOString());
    expect(w.sinceIso).toBe(new Date(now.getTime() - 4 * 3600 * 1000).toISOString());
  });

  it("honors explicit since/until", () => {
    const w = resolveWindow({
      sinceIso: "2026-05-30T00:00:00Z",
      untilIso: "2026-05-30T01:00:00Z",
    });
    expect(w.sinceIso).toBe("2026-05-30T00:00:00Z");
    expect(w.untilIso).toBe("2026-05-30T01:00:00Z");
  });
});

// ── parseSinceDuration ──────────────────────────────────────

describe("parseSinceDuration", () => {
  const now = new Date("2026-05-31T12:00:00Z");

  it("parses common duration shorthand", () => {
    expect(parseSinceDuration("4h", now)).toBe(new Date("2026-05-31T08:00:00Z").toISOString());
    expect(parseSinceDuration("30m", now)).toBe(new Date("2026-05-31T11:30:00Z").toISOString());
    expect(parseSinceDuration("2d", now)).toBe(new Date("2026-05-29T12:00:00Z").toISOString());
    expect(parseSinceDuration("1w", now)).toBe(new Date("2026-05-24T12:00:00Z").toISOString());
  });

  it("passes ISO timestamps through unchanged (canonicalized)", () => {
    expect(parseSinceDuration("2026-01-01T00:00:00Z", now)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns null for malformed shorthand", () => {
    expect(parseSinceDuration("foo", now)).toBeNull();
    expect(parseSinceDuration("4x", now)).toBeNull();
  });
});

// ── collectTradeEvents ──────────────────────────────────────

describe("collectTradeEvents", () => {
  function makeTrade(over: Partial<Record<string, unknown>>): import("./db.js").TradeRow {
    return {
      id: 1,
      timestamp: "2026-05-31T12:00:00Z",
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
      tx_hash: "0xaaa",
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      strategy: null,
      realized_slippage_bps: 50,
      ...over,
    } as never;
  }

  it("classifies success as trade.fill / info", () => {
    const evs = collectTradeEvents({
      trades: [makeTrade({})],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("trade.fill");
    expect(evs[0].severity).toBe("info");
  });

  it("classifies failed as trade.failure / critical", () => {
    const evs = collectTradeEvents({
      trades: [makeTrade({ status: "failed", revert_reason: "out of gas" })],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs[0].kind).toBe("trade.failure");
    expect(evs[0].severity).toBe("critical");
    expect(evs[0].summary).toMatch(/out of gas/);
  });

  it("filters by window", () => {
    const evs = collectTradeEvents({
      trades: [makeTrade({ timestamp: "2025-01-01T00:00:00Z" })],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toEqual([]);
  });

  it("filters by chain/account/strategy", () => {
    const inWindow = "2026-05-31T12:00:00Z";
    const rows = [
      makeTrade({ id: 1, chain: "base", account: "alice", strategy: "dca", timestamp: inWindow }),
      makeTrade({ id: 2, chain: "arbitrum", account: "alice", strategy: "dca", timestamp: inWindow }),
      makeTrade({ id: 3, chain: "base", account: "bob", strategy: "dca", timestamp: inWindow }),
      makeTrade({ id: 4, chain: "base", account: "alice", strategy: "swing", timestamp: inWindow }),
    ];
    expect(
      collectTradeEvents({
        trades: rows,
        filter: { chain: "base" },
        sinceIso: "2026-05-31T00:00:00Z",
        untilIso: "2026-05-31T23:59:59Z",
      }),
    ).toHaveLength(3);
    expect(
      collectTradeEvents({
        trades: rows,
        filter: { chain: "base", account: "alice" },
        sinceIso: "2026-05-31T00:00:00Z",
        untilIso: "2026-05-31T23:59:59Z",
      }),
    ).toHaveLength(2);
    expect(
      collectTradeEvents({
        trades: rows,
        filter: { chain: "base", account: "alice", strategy: "swing" },
        sinceIso: "2026-05-31T00:00:00Z",
        untilIso: "2026-05-31T23:59:59Z",
      }),
    ).toHaveLength(1);
  });

  it("honors kinds filter", () => {
    const evs = collectTradeEvents({
      trades: [
        makeTrade({ id: 1, timestamp: "2026-05-31T12:00:00Z", status: "success" }),
        makeTrade({ id: 2, timestamp: "2026-05-31T12:01:00Z", status: "failed" }),
      ],
      filter: { kinds: ["trade.fill"] },
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("trade.fill");
  });

  it("honors minSeverity floor", () => {
    const evs = collectTradeEvents({
      trades: [
        makeTrade({ id: 1, timestamp: "2026-05-31T12:00:00Z", status: "success" }),
        makeTrade({ id: 2, timestamp: "2026-05-31T12:01:00Z", status: "failed" }),
      ],
      filter: { minSeverity: "critical" },
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].severity).toBe("critical");
  });
});

// ── collectPaperEvents ──────────────────────────────────────

describe("collectPaperEvents", () => {
  function makePaper(over: Partial<Record<string, unknown>>): import("./db.js").PaperTradeRow {
    return {
      id: 1,
      timestamp: "2026-05-31T12:00:00Z",
      source_type: "order",
      source_id: 42,
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
      ...over,
    } as never;
  }

  it("emits paper.fill / info", () => {
    const evs = collectPaperEvents({
      paperTrades: [makePaper({})],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs[0].kind).toBe("paper.fill");
    expect(evs[0].severity).toBe("info");
    expect(evs[0].summary).toMatch(/paper/i);
  });

  it("filters out when minSeverity=warn", () => {
    const evs = collectPaperEvents({
      paperTrades: [makePaper({})],
      filter: { minSeverity: "warn" },
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toEqual([]);
  });
});

// ── collectAuditEvents ──────────────────────────────────────

describe("collectAuditEvents", () => {
  it("classifies error rows as critical", () => {
    const evs = collectAuditEvents({
      audit: [
        {
          id: 1,
          timestamp: "2026-05-31T12:00:00Z",
          tool: "trade",
          caller: "cli",
          chain: "base",
          account: "default",
          error_code: "SLIPPAGE_EXCEEDED",
          error_message: "slippage too high",
        } as never,
      ],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs[0].kind).toBe("audit.error");
    expect(evs[0].severity).toBe("critical");
    expect(evs[0].summary).toMatch(/SLIPPAGE_EXCEEDED/);
  });

  it("escalates engine_lock to warn even on success", () => {
    const evs = collectAuditEvents({
      audit: [
        {
          id: 1,
          timestamp: "2026-05-31T12:00:00Z",
          tool: "engine_lock",
          caller: "cli",
          chain: null,
          account: null,
          error_code: null,
          error_message: null,
        } as never,
      ],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs[0].kind).toBe("audit.tool");
    expect(evs[0].severity).toBe("warn");
  });

  it("treats routine tool calls as info", () => {
    const evs = collectAuditEvents({
      audit: [
        {
          id: 1,
          timestamp: "2026-05-31T12:00:00Z",
          tool: "holdings_on_chain",
          caller: "cli",
          chain: "base",
          account: "default",
          error_code: null,
          error_message: null,
        } as never,
      ],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs[0].severity).toBe("info");
  });
});

// ── collectJournalEvents ────────────────────────────────────

describe("collectJournalEvents", () => {
  function row(over: Partial<Record<string, unknown>>): import("./db.js").OrderCheckLogRow {
    return {
      id: 1,
      order_id: 42,
      checked_at: "2026-05-31T12:00:00Z",
      price_usd: 2500,
      water_mark_usd: null,
      threshold_usd: 1900,
      decision: "triggered_fired",
      notes: null,
      ...over,
    } as never;
  }

  it("skips routine tracking_started + hwm_advanced", () => {
    const evs = collectJournalEvents({
      rows: [
        row({ id: 1, decision: "tracking_started" }),
        row({ id: 2, decision: "hwm_advanced" }),
        row({ id: 3, decision: "triggered_fired" }),
      ],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("order.journal");
  });

  it("marks edited_by_operator as order.edited / info", () => {
    const evs = collectJournalEvents({
      rows: [row({ decision: "edited_by_operator", notes: '{"trailPct":[5,7]}' })],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs[0].kind).toBe("order.edited");
    expect(evs[0].severity).toBe("info");
    expect(evs[0].summary).toMatch(/edited/i);
  });

  it("marks error decisions as critical", () => {
    const evs = collectJournalEvents({
      rows: [row({ decision: "error", notes: "rpc timeout" })],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs[0].severity).toBe("critical");
  });
});

// ── collectAlertEvents ──────────────────────────────────────

describe("collectAlertEventsLegacy (pre-v28 state-row fallback)", () => {
  it("emits a fired event when first_triggered_at lands in window", () => {
    const evs = collectAlertEventsLegacy({
      states: [
        {
          tag: "dca-eth",
          rule_type: "slippage_trend",
          active: 1,
          first_triggered_at: "2026-05-31T12:00:00Z",
          last_evaluated_at: "2026-05-31T12:05:00Z",
          last_value_json: null,
        } as never,
      ],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("alert.fired");
    expect(evs[0].severity).toBe("warn");
  });

  it("emits a resolved event when active=0 + last_value_json present + last_evaluated in window", () => {
    const evs = collectAlertEventsLegacy({
      states: [
        {
          tag: "dca-eth",
          rule_type: "slippage_trend",
          active: 0,
          first_triggered_at: null,
          last_evaluated_at: "2026-05-31T13:00:00Z",
          last_value_json: '{"x":1}',
        } as never,
      ],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("alert.resolved");
  });

  it("classifies drawdown_threshold as critical, trigger_proximity as info", () => {
    const evs = collectAlertEventsLegacy({
      states: [
        { tag: "x", rule_type: "drawdown_threshold", active: 1, first_triggered_at: "2026-05-31T12:00:00Z", last_evaluated_at: "x", last_value_json: null } as never,
        { tag: "x", rule_type: "trigger_proximity", active: 1, first_triggered_at: "2026-05-31T12:00:00Z", last_evaluated_at: "x", last_value_json: null } as never,
      ],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    const dd = evs.find((e) => e.summary.includes("drawdown_threshold"));
    const tp = evs.find((e) => e.summary.includes("trigger_proximity"));
    expect(dd?.severity).toBe("critical");
    expect(tp?.severity).toBe("info");
  });

  it("filters by strategy tag", () => {
    const evs = collectAlertEventsLegacy({
      states: [
        { tag: "dca-eth", rule_type: "staleness", active: 1, first_triggered_at: "2026-05-31T12:00:00Z", last_evaluated_at: "x", last_value_json: null } as never,
        { tag: "swing-btc", rule_type: "staleness", active: 1, first_triggered_at: "2026-05-31T12:00:00Z", last_evaluated_at: "x", last_value_json: null } as never,
      ],
      filter: { strategy: "dca-eth" },
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].refs.strategy).toBe("dca-eth");
  });
});

// ── collectAlertEvents (v28 journal-driven) ─────────────────

function journalRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    at: "2026-05-31T12:00:00Z",
    tag: "dca-eth",
    rule_type: "failure_streak",
    event: "fired",
    severity: "critical",
    message: "3 consecutive failures",
    value_json: '{"streak":3}',
    duration_seconds: null,
    ...over,
  } as never;
}

describe("collectAlertEvents (v28 journal)", () => {
  it("maps fired rows with the stored severity + message", () => {
    const evs = collectAlertEvents({
      events: [journalRow()],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("alert.fired");
    expect(evs[0].severity).toBe("critical");
    expect(evs[0].at).toBe("2026-05-31T12:00:00Z"); // exact transition time
    expect(evs[0].summary).toContain("3 consecutive failures");
  });

  it("maps resolved rows as info with the alerting duration", () => {
    const evs = collectAlertEvents({
      events: [journalRow({ event: "resolved", severity: "info", duration_seconds: 720 })],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("alert.resolved");
    expect(evs[0].severity).toBe("info");
    expect(evs[0].summary).toContain("after 12m");
  });

  it("REPEATED fire/resolve cycles all surface (the legacy reconstruction collapsed them)", () => {
    const evs = collectAlertEvents({
      events: [
        journalRow({ id: 1, at: "2026-05-31T10:00:00Z", event: "fired" }),
        journalRow({ id: 2, at: "2026-05-31T11:00:00Z", event: "resolved", severity: "info", duration_seconds: 3600 }),
        journalRow({ id: 3, at: "2026-05-31T12:00:00Z", event: "fired" }),
        journalRow({ id: 4, at: "2026-05-31T13:00:00Z", event: "resolved", severity: "info", duration_seconds: 3600 }),
      ],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(4);
    expect(evs.filter((e) => e.kind === "alert.fired")).toHaveLength(2);
    expect(evs.filter((e) => e.kind === "alert.resolved")).toHaveLength(2);
  });

  it("respects strategy / kinds / minSeverity filters", () => {
    const rows = [
      journalRow({ id: 1, tag: "dca-eth" }),
      journalRow({ id: 2, tag: "swing-btc", severity: "warn", rule_type: "staleness" }),
    ];
    const byTag = collectAlertEvents({
      events: rows,
      filter: { strategy: "dca-eth" },
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(byTag).toHaveLength(1);
    expect(byTag[0].refs.strategy).toBe("dca-eth");

    const bySeverity = collectAlertEvents({
      events: rows,
      filter: { minSeverity: "critical" },
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(bySeverity).toHaveLength(1);
    expect(bySeverity[0].severity).toBe("critical");
  });
});

// ── collectTimeline end-to-end ──────────────────────────────

describe("collectTimeline — end-to-end against seeded DB", () => {
  function seedTrade(over: Record<string, unknown> = {}) {
    return insertTrade({
      timestamp: "2026-05-31T12:00:00Z",
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
      tx_hash: "0x" + Math.random().toString(16).slice(2),
      status: "success",
      gas_used: null,
      gas_price_wei: null,
      gas_cost_native: null,
      aggregator: "kyberswap",
      fee_tier: null,
      notes: null,
      strategy: null,
      realized_slippage_bps: 50,
      ...over,
    } as never);
  }

  it("merges trade + paper + audit events and returns newest-first", () => {
    seedTrade({ timestamp: "2026-05-31T11:00:00Z", tx_hash: "0xtrade" });
    insertAudit({
      timestamp: "2026-05-31T11:30:00Z",
      caller: "cli",
      tool: "engine_lock",
      account: null,
      chain: null,
      params_json: null,
      simulation_json: null,
      result: null,
      error_code: null,
      error_message: null,
      tx_hash: null,
    } as never);
    recordPaperTrade({
      timestamp: "2026-05-31T11:45:00Z",
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

    const evs = collectTimeline({
      sinceIso: "2026-05-31T10:00:00Z",
      untilIso: "2026-05-31T12:00:00Z",
    });
    // Newest first.
    expect(evs[0].kind).toBe("paper.fill");
    expect(evs[1].kind).toBe("audit.tool");
    expect(evs[2].kind).toBe("trade.fill");
  });

  it("limit truncates after global sort", () => {
    for (let i = 0; i < 5; i++) {
      seedTrade({ timestamp: `2026-05-31T11:0${i}:00Z`, tx_hash: `0x${i}` });
    }
    const evs = collectTimeline({
      sinceIso: "2026-05-31T10:00:00Z",
      untilIso: "2026-05-31T12:00:00Z",
      limit: 3,
    });
    expect(evs).toHaveLength(3);
    expect(evs[0].at).toBe("2026-05-31T11:04:00Z");
    expect(evs[2].at).toBe("2026-05-31T11:02:00Z");
  });

  it("excludes paper events when includePaper=false", () => {
    recordPaperTrade({
      timestamp: "2026-05-31T11:45:00Z",
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
    const evs = collectTimeline({
      sinceIso: "2026-05-31T10:00:00Z",
      untilIso: "2026-05-31T12:00:00Z",
      includePaper: false,
    });
    expect(evs.filter((e) => e.kind === "paper.fill")).toEqual([]);
  });

  it("alert fired event is collected via the LEGACY state-row fallback when the journal is empty", () => {
    upsertStrategyAlertState({
      tag: "dca-eth",
      ruleType: "drawdown_threshold",
      active: true,
      firstTriggeredAt: "2026-05-31T11:30:00Z",
      lastEvaluatedAt: "2026-05-31T11:30:00Z",
      lastValueJson: '{"x":1}',
    });
    const evs = collectTimeline({
      sinceIso: "2026-05-31T10:00:00Z",
      untilIso: "2026-05-31T12:00:00Z",
      kinds: ["alert.fired"],
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("alert.fired");
    expect(evs[0].severity).toBe("critical");
  });

  it("v28: the alert_events journal takes precedence over the state-row heuristic", () => {
    // Journal has the truth: two full fire/resolve cycles.
    insertAlertEvent({ at: "2026-05-31T10:30:00Z", tag: "dca-eth", ruleType: "failure_streak", event: "fired", severity: "critical", message: "3 consecutive failures" });
    insertAlertEvent({ at: "2026-05-31T11:00:00Z", tag: "dca-eth", ruleType: "failure_streak", event: "resolved", severity: "info", durationSeconds: 1800 });
    insertAlertEvent({ at: "2026-05-31T11:30:00Z", tag: "dca-eth", ruleType: "failure_streak", event: "fired", severity: "critical", message: "3 consecutive failures" });
    // A state row that the legacy heuristic would have reconstructed
    // DIFFERENTLY (one fire at 11:30 only) — must be ignored.
    upsertStrategyAlertState({
      tag: "dca-eth",
      ruleType: "failure_streak",
      active: true,
      firstTriggeredAt: "2026-05-31T11:30:00Z",
      lastEvaluatedAt: "2026-05-31T11:30:00Z",
      lastValueJson: '{"streak":3}',
    });
    const evs = collectTimeline({
      sinceIso: "2026-05-31T10:00:00Z",
      untilIso: "2026-05-31T12:00:00Z",
      kinds: ["alert.fired", "alert.resolved"],
    });
    // All THREE journal transitions surface; the heuristic would have
    // produced exactly one.
    expect(evs).toHaveLength(3);
    expect(evs.filter((e) => e.kind === "alert.fired")).toHaveLength(2);
    expect(evs.filter((e) => e.kind === "alert.resolved")).toHaveLength(1);
  });

  it("journal source — order edits surface in the timeline", () => {
    // Need an order_check_log row.
    const orderId = insertOrder({
      side: "sell",
      trigger_type: "trailing",
      target_price_usd: null,
      trail_pct: 5,
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
      checkedAt: "2026-05-31T11:15:00Z",
      priceUsd: null,
      waterMarkUsd: 2500,
      thresholdUsd: null,
      decision: "edited_by_operator",
      notes: '{"trailPct":[5,7]}',
    });
    const evs = collectTimeline({
      sinceIso: "2026-05-31T10:00:00Z",
      untilIso: "2026-05-31T12:00:00Z",
      kinds: ["order.edited"],
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].refs.id).toBe(orderId);
  });

  it("strategy filter narrows trades + alerts cohesively", () => {
    seedTrade({ strategy: "dca-eth", timestamp: "2026-05-31T11:00:00Z" });
    seedTrade({ strategy: "swing-btc", timestamp: "2026-05-31T11:05:00Z" });
    upsertStrategyAlertState({
      tag: "dca-eth",
      ruleType: "staleness",
      active: true,
      firstTriggeredAt: "2026-05-31T11:30:00Z",
      lastEvaluatedAt: "2026-05-31T11:30:00Z",
      lastValueJson: null,
    });
    const evs = collectTimeline({
      sinceIso: "2026-05-31T10:00:00Z",
      untilIso: "2026-05-31T12:00:00Z",
      strategy: "dca-eth",
    });
    // Only 1 trade + 1 alert event (no swing-btc).
    expect(evs.every((e) => e.refs.strategy === "dca-eth" || e.kind === "alert.fired")).toBe(true);
    expect(evs.length).toBe(2);
  });
});

// ── v29: schedule + rebalance journal sources ────────────────

describe("collectScheduleJournalEvents (v29)", () => {
  function schedRow(over: Record<string, unknown> = {}) {
    return {
      id: 1,
      schedule_id: 7,
      checked_at: "2026-05-31T12:00:00Z",
      decision: "fired",
      run_number: 3,
      tx_hash: "paper:1:123",
      error_code: null,
      notes: null,
      ...over,
    } as never;
  }

  it("maps decisions with run numbers + severity (fire_failed=critical, locked=warn, fired=info)", () => {
    const evs = collectScheduleJournalEvents({
      rows: [
        schedRow({ id: 1, decision: "fired" }),
        schedRow({ id: 2, decision: "fire_failed", error_code: "INSUFFICIENT_BALANCE" }),
        schedRow({ id: 3, decision: "skipped_locked", error_code: "ENGINE_LOCKED" }),
      ],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(3);
    const byDecision = Object.fromEntries(evs.map((e) => [(e.details as { decision: string }).decision, e]));
    expect(byDecision["fired"].severity).toBe("info");
    expect(byDecision["fired"].summary).toContain("run #3");
    expect(byDecision["fire_failed"].severity).toBe("critical");
    expect(byDecision["fire_failed"].summary).toContain("[INSUFFICIENT_BALANCE]");
    expect(byDecision["skipped_locked"].severity).toBe("warn");
    expect(evs[0].kind).toBe("schedule.journal");
    expect(evs[0].refs).toMatchObject({ type: "schedule", id: 7 });
  });

  it("respects kinds + window filters", () => {
    const rows = [schedRow({ checked_at: "2026-05-30T00:00:00Z" }), schedRow({})];
    const inWindow = collectScheduleJournalEvents({
      rows,
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(inWindow).toHaveLength(1);
    const filteredOut = collectScheduleJournalEvents({
      rows,
      filter: { kinds: ["trade.fill"] },
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(filteredOut).toHaveLength(0);
  });
});

describe("collectRebalanceJournalEvents (v29)", () => {
  function rebRow(over: Record<string, unknown> = {}) {
    return {
      id: 1,
      plan_id: 4,
      checked_at: "2026-05-31T12:00:00Z",
      decision: "in_band",
      max_drift_pct: 3.21,
      threshold_pct: 5,
      executed_count: null,
      skipped_count: 0,
      error_code: null,
      notes: null,
      ...over,
    } as never;
  }

  it("in_band rows surface the drift reading at info severity", () => {
    const evs = collectRebalanceJournalEvents({
      rows: [rebRow()],
      filter: {},
      sinceIso: "2026-05-31T00:00:00Z",
      untilIso: "2026-05-31T23:59:59Z",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("rebalance.journal");
    expect(evs[0].severity).toBe("info");
    expect(evs[0].summary).toContain("drift 3.21%/5%");
    expect(evs[0].refs).toMatchObject({ type: "rebalance", id: 4 });
  });

  it("severity ladder: fired=warn, partial_failure/failed=critical; minSeverity floors apply", () => {
    const rows = [
      rebRow({ id: 1, decision: "in_band" }),
      rebRow({ id: 2, decision: "fired", executed_count: 2 }),
      rebRow({ id: 3, decision: "partial_failure", error_code: "PARTIAL_FAILURE", executed_count: 1 }),
    ];
    const all = collectRebalanceJournalEvents({
      rows, filter: {}, sinceIso: "2026-05-31T00:00:00Z", untilIso: "2026-05-31T23:59:59Z",
    });
    expect(all.map((e) => e.severity).sort()).toEqual(["critical", "info", "warn"]);
    const warnPlus = collectRebalanceJournalEvents({
      rows, filter: { minSeverity: "warn" }, sinceIso: "2026-05-31T00:00:00Z", untilIso: "2026-05-31T23:59:59Z",
    });
    // The in_band drift reading drops at the warn floor.
    expect(warnPlus).toHaveLength(2);
  });
});

describe("collectTimeline — v29 journal sources end-to-end", () => {
  it("merges schedule + rebalance journal rows from the DB with the other sources", () => {
    insertScheduleCheckEntry({
      scheduleId: 11,
      checkedAt: "2026-05-31T11:00:00Z",
      decision: "fired",
      runNumber: 1,
      txHash: "paper:9:1",
    });
    insertRebalanceCheckEntry({
      planId: 12,
      checkedAt: "2026-05-31T11:30:00Z",
      decision: "in_band",
      maxDriftPct: 2.5,
      thresholdPct: 5,
    });
    const evs = collectTimeline({
      sinceIso: "2026-05-31T10:00:00Z",
      untilIso: "2026-05-31T12:00:00Z",
      kinds: ["schedule.journal", "rebalance.journal"],
    });
    expect(evs).toHaveLength(2);
    // Newest-first global sort.
    expect(evs[0].kind).toBe("rebalance.journal");
    expect(evs[1].kind).toBe("schedule.journal");
  });
});

// ── v36.5: signal events ─────────────────────────────────────

describe("collectSignalEvents", () => {
  const mkSignal = (over: Record<string, unknown> = {}) => ({
    id: 1, name: "tv-breakout", received_at: "2026-06-10T12:00:00Z",
    source: "webhook", payload_json: null, consumed_at: null, consumed_by_order: null,
    ...over,
  });
  const window = { sinceIso: "2026-06-10T00:00:00Z", untilIso: "2026-06-11T00:00:00Z" };

  it("consumed-by-order events are info with the order id in the summary", async () => {
    const { collectSignalEvents } = await import("./timeline.js");
    const events = collectSignalEvents({
      rows: [mkSignal({ consumed_at: "2026-06-10T12:01:00Z", consumed_by_order: 7 })] as never,
      filter: {},
      ...window,
    });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("info");
    expect(events[0].summary).toMatch(/fired order #7/);
    expect(events[0].kind).toBe("signal.received");
  });

  it("PENDING and expired-unclaimed events are warn — the integration-debugging signal", async () => {
    const { collectSignalEvents } = await import("./timeline.js");
    const pending = collectSignalEvents({ rows: [mkSignal()] as never, filter: {}, ...window });
    expect(pending[0].severity).toBe("warn");
    expect(pending[0].summary).toMatch(/PENDING/);

    const unclaimed = collectSignalEvents({
      rows: [mkSignal({ consumed_at: "2026-06-10T13:00:00Z", consumed_by_order: null })] as never,
      filter: {},
      ...window,
    });
    expect(unclaimed[0].severity).toBe("warn");
    expect(unclaimed[0].summary).toMatch(/UNCLAIMED/);
  });

  it("respects kind + severity filters and the window", async () => {
    const { collectSignalEvents } = await import("./timeline.js");
    expect(collectSignalEvents({ rows: [mkSignal()] as never, filter: { kinds: ["trade.fill"] }, ...window })).toHaveLength(0);
    expect(collectSignalEvents({
      rows: [mkSignal({ consumed_by_order: 1, consumed_at: "x" })] as never,
      filter: { minSeverity: "warn" }, ...window,
    })).toHaveLength(0); // info filtered out
    expect(collectSignalEvents({
      rows: [mkSignal({ received_at: "2026-06-09T00:00:00Z" })] as never,
      filter: {}, ...window,
    })).toHaveLength(0); // outside window
  });
});
