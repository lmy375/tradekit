/**
 * Trade-intent tests (v47) — the human-in-the-loop approval gate.
 * The dangerous invariants pinned hard: the gate fails CLOSED on
 * unpriceable trades, decisions are race-safe transitions, and
 * terminal intents can never be re-decided.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-intents-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  needsApproval,
  approvalGateConfig,
  createTradeIntent,
  getActionableIntent,
  rejectTradeIntent,
  completeApprovedIntent,
  listIntents,
} = await import("./tradeIntents.js");
const { openDb, closeDb, getTradeIntentById, transitionTradeIntent } = await import("./db.js");
const { loadConfig } = await import("./config.js");
const { ToolError } = await import("./errors.js");

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => { openDb().exec("DELETE FROM trade_intents"); });

const GATE = { enabled: true as const, thresholdUsd: 500, expiresMinutes: 60, requireForNewToken: false };
// v101: a buy-signal helper — most existing tests only exercise the size dimension.
const buy = (estUsd: number | null) => ({ estUsd, direction: "buy" as const });

function mkIntent(over: Partial<Parameters<typeof createTradeIntent>[0]> = {}) {
  return createTradeIntent({
    tool: "buy",
    chain: "base",
    account: "default",
    request: { direction: "buy", base: "0xweth", quote: "0xusdc", quoteAmount: "1000" },
    preview: { price: "2000", baseAmount: "0.5", quoteAmount: "1000", aggregator: "kyberswap" },
    estUsd: 1000,
    reason: "TV breakout",
    expiresMinutes: 60,
    ...over,
  });
}

describe("needsApproval — the gate decision", () => {
  it("threshold: at-or-above gates, below passes", () => {
    expect(needsApproval(GATE, buy(500)).required).toBe(true);
    expect(needsApproval(GATE, buy(499.99)).required).toBe(false);
    expect(needsApproval(GATE, buy(10_000)).required).toBe(true);
  });

  it("null threshold = EVERY agent trade gates", () => {
    expect(needsApproval({ ...GATE, thresholdUsd: null }, buy(1)).required).toBe(true);
  });

  it("fails CLOSED on unpriceable trades — 'couldn't price it' must never mean 'waved through'", () => {
    expect(needsApproval(GATE, buy(null)).required).toBe(true);
  });

  // v101: the novelty dimension — size-blind routing of new-token buys.
  it("requireForNewToken: a small BUY of a never-traded token gates regardless of size", () => {
    const gate = { ...GATE, thresholdUsd: 500, requireForNewToken: true };
    const d = needsApproval(gate, { estUsd: 20, direction: "buy", isNewToken: true });
    expect(d.required).toBe(true);
    expect(d.reasons.some((r) => /new-token risk/.test(r))).toBe(true);
  });

  it("requireForNewToken: a known-token buy below threshold still passes", () => {
    const gate = { ...GATE, thresholdUsd: 500, requireForNewToken: true };
    expect(needsApproval(gate, { estUsd: 20, direction: "buy", isNewToken: false }).required).toBe(false);
  });

  it("requireForNewToken: novelty never gates a SELL (you already hold it)", () => {
    const gate = { ...GATE, thresholdUsd: 500, requireForNewToken: true };
    expect(needsApproval(gate, { estUsd: 20, direction: "sell", isNewToken: true }).required).toBe(false);
  });

  it("reasons accumulate when BOTH size and novelty fire", () => {
    const gate = { ...GATE, thresholdUsd: 100, requireForNewToken: true };
    const d = needsApproval(gate, { estUsd: 500, direction: "buy", isNewToken: true });
    expect(d.required).toBe(true);
    expect(d.reasons).toHaveLength(2);
  });

  it("approvalGateConfig: disabled (the default) returns null", () => {
    expect(approvalGateConfig(loadConfig())).toBeNull();
  });
});

describe("intent lifecycle", () => {
  it("create → pending with expiry + approve hint", () => {
    const now = new Date("2026-06-11T10:00:00Z");
    const s = mkIntent({ now });
    expect(s.status).toBe("pending_approval");
    expect(s.expiresAt).toBe("2026-06-11T11:00:00.000Z");
    expect(s.approveHint).toMatch(new RegExp(`intents approve ${s.intentId}`));
    const row = getTradeIntentById(s.intentId)!;
    expect(row.status).toBe("pending");
    expect(row.est_usd).toBe(1000);
    expect(JSON.parse(row.preview_json!).aggregator).toBe("kyberswap");
  });

  // v101: gate-trigger reasons round-trip through the DB so the CLI/MCP show WHY.
  it("persists approvalReasons → readable on the row + returned summary", () => {
    const s = mkIntent({ approvalReasons: ["trade ≈ $1000.00 ≥ $500 approval threshold", "first BUY of this token on this account/chain — never traded before (new-token risk)"] });
    expect(s.approvalReasons).toHaveLength(2);
    const row = getTradeIntentById(s.intentId)!;
    expect(JSON.parse(row.approval_reasons_json!)).toEqual(s.approvalReasons);
  });

  it("no approvalReasons → null column (backward-compatible)", () => {
    const row = getTradeIntentById(mkIntent().intentId)!;
    expect(row.approval_reasons_json).toBeNull();
  });

  it("approve flow: execute success → executed with result; concurrent reject loses loudly", () => {
    const s = mkIntent();
    const intent = getActionableIntent(s.intentId);
    expect(intent.tool).toBe("buy");
    completeApprovedIntent({ id: s.intentId, outcome: "executed", resultJson: JSON.stringify({ txHash: "0xabc" }) });
    const row = getTradeIntentById(s.intentId)!;
    expect(row.status).toBe("executed");
    expect(JSON.parse(row.result_json!).txHash).toBe("0xabc");

    // The intent is terminal — a second finalization must fail loudly.
    expect(() => completeApprovedIntent({ id: s.intentId, outcome: "failed", resultJson: "{}" })).toThrow(/changed state/);
  });

  it("approve flow: execution failure → failed with the error recorded", () => {
    const s = mkIntent();
    getActionableIntent(s.intentId);
    completeApprovedIntent({
      id: s.intentId,
      outcome: "failed",
      resultJson: JSON.stringify({ error: { code: "QUOTE_DEVIATION_EXCEEDED" } }),
    });
    expect(getTradeIntentById(s.intentId)!.status).toBe("failed");
  });

  it("reject: pending → rejected with note; terminal intents can't be re-decided", () => {
    const s = mkIntent();
    const row = rejectTradeIntent({ id: s.intentId, note: "too big today" });
    expect(row.status).toBe("rejected");
    expect(row.decided_note).toBe("too big today");
    expect(() => rejectTradeIntent({ id: s.intentId })).toThrow(/only pending/);
    expect(() => getActionableIntent(s.intentId)).toThrow(/rejected/);
  });

  it("expiry: pending past its deadline flips to expired on any list/actionable touch", () => {
    const s = mkIntent({ now: new Date(Date.now() - 2 * 3_600_000) }); // expired an hour ago
    expect(() => getActionableIntent(s.intentId)).toThrow(/expired/);
    expect(getTradeIntentById(s.intentId)!.status).toBe("expired");

    const fresh = mkIntent();
    const rows = listIntents({ status: "pending" });
    expect(rows.map((r) => r.id)).toEqual([fresh.intentId]);
  });

  it("transitionTradeIntent is race-safe: the second writer changes nothing", () => {
    const s = mkIntent();
    expect(transitionTradeIntent({ id: s.intentId, from: "pending", to: "rejected" })).toBe(true);
    expect(transitionTradeIntent({ id: s.intentId, from: "pending", to: "executed" })).toBe(false);
    expect(getTradeIntentById(s.intentId)!.status).toBe("rejected");
  });

  it("unknown intent → clean INVALID_PARAMS", () => {
    expect(() => getActionableIntent(99_999)).toThrow(ToolError);
    expect(() => rejectTradeIntent({ id: 99_999 })).toThrow(/No trade intent/);
  });
});

// ── v47.5: operational-surface integration ───────────────────

describe("timeline integration (collectIntentEvents)", () => {
  it("created (warn while pending) + decided events; expiry synthesizes decided at expires_at", async () => {
    const { collectIntentEvents } = await import("./timeline.js");
    const now = new Date("2026-06-11T12:00:00Z");
    const base = {
      tool: "buy" as const, chain: "base", account: "default",
      request_json: "{}", preview_json: null, est_usd: 800, reason: "breakout",
      decided_at: null, decided_note: null, executed_at: null, result_json: null,
      approval_reasons_json: null,
    };
    const rows = [
      { ...base, id: 1, status: "pending" as const, created_at: "2026-06-11T11:00:00Z", expires_at: "2026-06-11T13:00:00Z" },
      { ...base, id: 2, status: "rejected" as const, created_at: "2026-06-11T10:00:00Z", expires_at: "2026-06-11T11:00:00Z", decided_at: "2026-06-11T10:30:00Z", decided_note: "too big" },
      { ...base, id: 3, status: "expired" as const, created_at: "2026-06-11T08:00:00Z", expires_at: "2026-06-11T09:00:00Z" },
      { ...base, id: 4, status: "executed" as const, created_at: "2026-06-11T07:00:00Z", expires_at: "2026-06-11T08:00:00Z", decided_at: "2026-06-11T07:10:00Z" },
    ];
    const events = collectIntentEvents({
      rows, filter: {}, sinceIso: "2026-06-11T00:00:00Z", untilIso: "2026-06-11T23:59:59Z",
      nowIso: now.toISOString(),
    });
    const byKey = (id: number, kind: string) => events.find((e) => e.refs.id === id && e.kind === kind);
    expect(byKey(1, "intent.created")!.severity).toBe("warn"); // still actionable
    expect(byKey(1, "intent.created")!.summary).toMatch(/AWAITING APPROVAL/);
    expect(byKey(2, "intent.created")!.severity).toBe("info"); // decided — created is history
    expect(byKey(2, "intent.decided")!.summary).toMatch(/REJECTED \(too big\)/);
    // Expiry synthesizes a decided event AT expires_at.
    const expired = byKey(3, "intent.decided")!;
    expect(expired.at).toBe("2026-06-11T09:00:00Z");
    expect(expired.severity).toBe("warn");
    expect(expired.summary).toMatch(/EXPIRED un-reviewed/);
    expect(byKey(4, "intent.decided")!.severity).toBe("info");
  });

  it("the kinds live in ALL_EVENT_KINDS — every derived surface gets them for free", async () => {
    const { ALL_EVENT_KINDS } = await import("./timeline.js");
    expect(ALL_EVENT_KINDS).toContain("intent.created");
    expect(ALL_EVENT_KINDS).toContain("intent.decided");
  });
});

describe("digest integration (gatherIntents + verdict)", () => {
  it("counts the window + pending now; pending pushes verdict to attention", async () => {
    const { gatherIntents, classifyVerdict } = await import("./digest.js");
    const now = new Date();
    mkIntent({ now: new Date(now.getTime() - 30 * 60_000) }); // pending, 30min old
    const s2 = mkIntent({ now: new Date(now.getTime() - 10 * 60_000) });
    // Pin the decision clock INSIDE the window — decided_at must not
    // land after the gather's `until` boundary.
    rejectTradeIntent({ id: s2.intentId, note: "no", now: new Date(now.getTime() - 60_000) });
    const section = gatherIntents({ since: new Date(now.getTime() - 3_600_000).toISOString(), now });
    expect(section.pendingNow).toBe(1);
    expect(section.createdInWindow).toBe(2);
    expect(section.rejectedInWindow).toBe(1);
    expect(Math.round(section.oldestPendingMinutes!)).toBe(30);

    const empty = { } as never; // sections irrelevant for this rule
    void empty;
    const verdict = classifyVerdict({
      trades: { total: 0, usdVolume: 0 } as never,
      fires: { ordersFilled: 0, ordersFailed: 0, schedulesFired: 0, scheduleFireFailures: 0, rebalanceFailureCount: 0 } as never,
      safety: { drawdownTrips: 0, drawdownCurrentlyTripped: [], budgetWarnings: [], budgetBlocks: 0, positionLimitBlocks: 0, honeypotBlocks: 0, gasBudgetBlocks: 0 } as never,
      errors: { errorRatePct: 0 } as never,
      alerts: { fired: 0, resolved: 0, currentlyActive: 0 } as never,
      paper: { fills: 0 } as never,
      intents: section,
    });
    expect(verdict.verdict).toBe("attention");
    expect(verdict.verdictReasons.some((x) => /awaiting approval/.test(x))).toBe(true);
  });
});

describe("doctor integration (checkPendingIntents)", () => {
  it("warns on pending; ok when the queue is clear", async () => {
    const { checkPendingIntents } = await import("./doctor.js");
    const clear = await checkPendingIntents();
    expect(clear.severity).toBe("ok");

    mkIntent();
    const warn = await checkPendingIntents();
    expect(warn.severity).toBe("warn");
    expect(warn.message).toMatch(/AWAITING APPROVAL/);
    expect(warn.hint).toMatch(/intents list/);
  });

  it("warns on recently-expired-unreviewed even with an empty queue", async () => {
    const { checkPendingIntents } = await import("./doctor.js");
    mkIntent({ now: new Date(Date.now() - 2 * 3_600_000) }); // expires 1h ago
    const r = await checkPendingIntents();
    expect(r.severity).toBe("warn");
    expect(r.message).toMatch(/expired UN-REVIEWED/);
  });
});
