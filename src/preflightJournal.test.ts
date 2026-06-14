/**
 * Preflight decision-journal tests (v74). The journal's whole point is to make
 * the agent's risk JUDGMENT visible — including the caution/no_go runs (trades
 * it refused) that never reach the trades table. Pins insert → list (with
 * filters) → the verdict breakdown that surfaces the go/no-go discipline.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-preflight-journal-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { openDb, closeDb, insertPreflightRun, listPreflightRuns, preflightVerdictBreakdown } =
  await import("./db.js");

beforeAll(() => { openDb(); });
afterAll(() => { closeDb(); rmSync(tmpDataDir, { recursive: true, force: true }); });
beforeEach(() => { openDb().exec("DELETE FROM preflight_runs"); });

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-14T00:00:00Z");
const ago = (d: number) => new Date(NOW - d * DAY).toISOString();

function run(over: Partial<Parameters<typeof insertPreflightRun>[0]> = {}) {
  return insertPreflightRun({
    timestamp: over.timestamp ?? ago(0),
    chain: "base",
    account: "default",
    direction: "buy",
    baseSymbol: "WETH",
    quoteSymbol: "USDC",
    strategy: null,
    verdict: "go",
    estUsd: 500,
    criticalCount: 0,
    warnCount: 0,
    reasonsJson: "[]",
    ...over,
  });
}

describe("preflight journal — insert + list", () => {
  it("round-trips a run and reads it back newest-first", () => {
    run({ timestamp: ago(2), verdict: "go" });
    run({ timestamp: ago(1), verdict: "no_go", criticalCount: 1, reasonsJson: JSON.stringify([{ code: "token_honeypot", severity: "critical", message: "honeypot", source: "token_safety" }]) });
    const rows = listPreflightRuns({});
    expect(rows).toHaveLength(2);
    expect(rows[0].verdict).toBe("no_go"); // newest first
    expect(rows[0].critical_count).toBe(1);
    expect(JSON.parse(rows[0].reasons_json)[0].code).toBe("token_honeypot");
  });

  it("filters by verdict — surfacing the REFUSED trades specifically", () => {
    run({ verdict: "go" });
    run({ verdict: "go" });
    run({ verdict: "no_go" });
    run({ verdict: "caution" });
    expect(listPreflightRuns({ verdict: "no_go" })).toHaveLength(1);
    expect(listPreflightRuns({ verdict: "go" })).toHaveLength(2);
  });

  it("filters by since + strategy + honours limit", () => {
    run({ timestamp: ago(10), strategy: "dca" });
    run({ timestamp: ago(1), strategy: "dca" });
    run({ timestamp: ago(1), strategy: "other" });
    expect(listPreflightRuns({ sinceIso: ago(5) })).toHaveLength(2); // the 10-day-old one excluded
    expect(listPreflightRuns({ strategy: "dca" })).toHaveLength(2);
    expect(listPreflightRuns({ limit: 1 })).toHaveLength(1);
  });
});

describe("preflightVerdictBreakdown — the risk-discipline summary", () => {
  it("counts each verdict + total", () => {
    run({ verdict: "go" });
    run({ verdict: "go" });
    run({ verdict: "go" });
    run({ verdict: "caution" });
    run({ verdict: "no_go" });
    run({ verdict: "no_go" });
    const b = preflightVerdictBreakdown({});
    expect(b).toEqual({ total: 6, go: 3, caution: 1, no_go: 2 });
  });

  it("scopes the breakdown to a window + strategy", () => {
    run({ timestamp: ago(10), verdict: "no_go", strategy: "dca" });
    run({ timestamp: ago(1), verdict: "go", strategy: "dca" });
    run({ timestamp: ago(1), verdict: "go", strategy: "other" });
    const b = preflightVerdictBreakdown({ sinceIso: ago(5), strategy: "dca" });
    expect(b).toEqual({ total: 1, go: 1, caution: 0, no_go: 0 });
  });

  it("empty journal → all zeroes", () => {
    expect(preflightVerdictBreakdown({})).toEqual({ total: 0, go: 0, caution: 0, no_go: 0 });
  });
});
