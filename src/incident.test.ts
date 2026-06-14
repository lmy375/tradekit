/**
 * Incident-report tests (v39) — the one-command postmortem.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-incident-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { gatherIncidentReport, renderIncidentMarkdown } = await import("./incident.js");
const {
  openDb,
  closeDb,
  insertOperatorNote,
  insertAlertEvent,
  insertConfigHistory,
  insertSignalEvent,
  insertTrade,
} = await import("./db.js");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  openDb().exec(
    "DELETE FROM operator_notes; DELETE FROM alert_events; DELETE FROM config_history; DELETE FROM signal_events; DELETE FROM trades",
  );
});

function seedWindow(): void {
  const inWindow = new Date(Date.now() - 30 * 60_000).toISOString();
  insertOperatorNote({ at: inWindow, text: "rotated RPC, base flaky", strategy: null, source: "cli" });
  insertAlertEvent({
    at: inWindow, tag: "dca-eth", ruleType: "failure_streak", event: "breaker_paused",
    severity: "critical", message: "paused 3 primitive(s)",
  });
  insertConfigHistory({ savedAt: inWindow, hash: "abc123", source: "cli:config set safety.maxSlippageBps", content: "{}" });
  insertSignalEvent({ name: "tv-x", receivedAt: inWindow, source: "webhook" });
  insertTrade({
    timestamp: inWindow,
    chain: "base", account: "default", direction: "buy",
    base_token: WETH, base_symbol: "WETH", base_amount: "0.1",
    quote_token: USDC, quote_symbol: "USDC", quote_amount: "200",
    price: "2000", tx_hash: "0xinc", status: "failed",
    gas_used: null, gas_price_wei: null, gas_cost_native: null,
    aggregator: "kyberswap", fee_tier: null, notes: null,
    strategy: "dca-eth", realized_slippage_bps: null,
  });
}

describe("gatherIncidentReport", () => {
  it("composes digest + events + notes + config changes for the window", async () => {    seedWindow();
    // Out-of-window rows must not leak in.
    insertOperatorNote({ at: "2025-01-01T00:00:00Z", text: "ancient", strategy: null, source: "cli" });
    insertConfigHistory({ savedAt: "2025-01-01T00:00:00Z", hash: "old", source: "old", content: "{}" });

    const r = await gatherIncidentReport({ windowLabel: "4h", windowMs: 4 * 3_600_000 });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0].text).toMatch(/rotated RPC/);
    expect(r.configChanges).toHaveLength(1);
    expect(r.configChanges[0].source).toMatch(/maxSlippageBps/);
    expect(r.digest.fires.signalsReceived).toBe(1);
    // The breaker trip + failed trade appear in the warn+ event tail.
    expect(r.events.some((e) => e.kind === "alert.breaker")).toBe(true);
    expect(r.events.some((e) => e.kind === "trade.failure")).toBe(true);
    // The unconsumed signal surfaces as a warn (fired nothing).
    expect(r.events.some((e) => e.kind === "signal.received")).toBe(true);
  });

  it("strategy filter scopes the tail but keeps global notes", async () => {    seedWindow();
    const r = await gatherIncidentReport({ windowLabel: "4h", windowMs: 4 * 3_600_000, strategy: "other-tag" });
    // The dca-eth failed trade is filtered out of the tail…
    expect(r.events.some((e) => e.kind === "trade.failure")).toBe(false);
    // …but the untagged note survives (global context semantics).
    expect(r.notes).toHaveLength(1);
  });
});

describe("renderIncidentMarkdown", () => {
  it("renders the reviewer order: verdict → activity → config → notes → events", async () => {    seedWindow();
    const r = await gatherIncidentReport({ windowLabel: "4h", windowMs: 4 * 3_600_000 });
    const md = renderIncidentMarkdown(r);
    const order = ["## Verdict", "## Activity", "## Config changes in window", "## Operator / agent notes", "## Critical events", "## Warnings"];
    let last = -1;
    for (const h of order) {
      const i = md.indexOf(h);
      expect(i, `missing section ${h}`).toBeGreaterThan(last);
      last = i;
    }
    expect(md).toMatch(/cli:config set safety.maxSlippageBps/);
    expect(md).toMatch(/rotated RPC/);
    expect(md).toMatch(/fired NOTHING/); // the signal that fired nothing is bolded
    expect(md).toMatch(/config diff-version/); // remediation pointers
  });

  it("empty window renders honest placeholders, never crashes", async () => {    const r = await gatherIncidentReport({ windowLabel: "1h", windowMs: 3_600_000 });
    const md = renderIncidentMarkdown(r);
    expect(md).toMatch(/\(none — the config did not change/);
    expect(md).toMatch(/\(none in window — record context/);
    expect(md).toMatch(/## Critical events \(0\)/);
  });
});
