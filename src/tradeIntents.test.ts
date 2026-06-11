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

const GATE = { enabled: true as const, thresholdUsd: 500, expiresMinutes: 60 };

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
    expect(needsApproval(GATE, 500)).toBe(true);
    expect(needsApproval(GATE, 499.99)).toBe(false);
    expect(needsApproval(GATE, 10_000)).toBe(true);
  });

  it("null threshold = EVERY agent trade gates", () => {
    expect(needsApproval({ ...GATE, thresholdUsd: null }, 1)).toBe(true);
  });

  it("fails CLOSED on unpriceable trades — 'couldn't price it' must never mean 'waved through'", () => {
    expect(needsApproval(GATE, null)).toBe(true);
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
