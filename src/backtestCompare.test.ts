/**
 * Backtest comparison tests.
 *
 * Layers:
 *   1. Scenarios parser — well-formed + every error path + multi-
 *      error collection
 *   2. prepareScenarios — file resolution, template rendering,
 *      cross-scenario shared-pair invariant
 *   3. runComparison — fresh balance per scenario, winner ranking,
 *      no-winner case, persistence
 *   4. Renderer — human-readable output snapshot
 *   5. Orchestrator — runCompareFromFile with injection seam
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-bt-compare-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  parseScenariosFile,
  prepareScenarios,
  runComparison,
  renderComparison,
  runCompareFromFile,
} = await import("./backtestCompare.js");
const {
  openDb,
  closeDb,
  getBacktestComparisonById,
  listBacktestComparisons,
  getBacktestRunById,
} = await import("./db.js");
const { ToolError } = await import("./errors.js");

beforeAll(() => {
  openDb();
});
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM backtest_comparisons");
  db.exec("DELETE FROM backtest_runs");
});

// ── scenarios parser ─────────────────────────────────────────

describe("parseScenariosFile — happy path", () => {
  it("parses minimal valid input", () => {
    const f = parseScenariosFile({
      scenarios: [
        { name: "a", file: "./a.json" },
        { name: "b", file: "./b.json", vars: { X: 5, Y: "hello" } },
      ],
    });
    expect(f.scenarios.length).toBe(2);
    expect(f.scenarios[1].vars).toEqual({ X: 5, Y: "hello" });
    expect(f.name).toMatch(/^comparison-/); // auto-generated
  });

  it("preserves operator-supplied name", () => {
    const f = parseScenariosFile({
      name: "my-sweep",
      scenarios: [
        { name: "a", file: "./a.json" },
        { name: "b", file: "./b.json" },
      ],
    });
    expect(f.name).toBe("my-sweep");
  });
});

describe("parseScenariosFile — error paths", () => {
  it("rejects non-object input", () => {
    expect(() => parseScenariosFile("hi")).toThrow(/JSON object/);
    expect(() => parseScenariosFile([])).toThrow(/JSON object/);
    expect(() => parseScenariosFile(null)).toThrow(/JSON object/);
  });

  it("rejects bad name", () => {
    expect(() =>
      parseScenariosFile({
        name: "has spaces",
        scenarios: [
          { name: "a", file: "./a.json" },
          { name: "b", file: "./b.json" },
        ],
      }),
    ).toThrow(/name: must match/);
  });

  it("rejects missing scenarios array", () => {
    expect(() => parseScenariosFile({})).toThrow(/scenarios: required array/);
  });

  it("rejects too-few scenarios", () => {
    expect(() =>
      parseScenariosFile({ scenarios: [{ name: "only", file: "./a.json" }] }),
    ).toThrow(/at least 2 scenarios/);
  });

  it("rejects too-many scenarios", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ name: `s${i}`, file: "./a.json" }));
    expect(() => parseScenariosFile({ scenarios: many })).toThrow(/max 50/);
  });

  it("rejects duplicate scenario names", () => {
    expect(() =>
      parseScenariosFile({
        scenarios: [
          { name: "dup", file: "./a.json" },
          { name: "dup", file: "./b.json" },
        ],
      }),
    ).toThrow(/duplicated/);
  });

  it("rejects bad scenario shape", () => {
    expect(() =>
      parseScenariosFile({
        scenarios: [
          { name: "ok", file: "./a.json" },
          { name: 42, file: "./b.json" },
        ],
      }),
    ).toThrow(/scenarios\[1\]\.name/);
  });

  it("rejects bad var type in scenario", () => {
    expect(() =>
      parseScenariosFile({
        scenarios: [
          { name: "a", file: "./a.json", vars: { OK: 5, BAD: { nested: true } } },
          { name: "b", file: "./b.json" },
        ],
      }),
    ).toThrow(/vars\.BAD/);
  });

  it("collects multiple errors into one message", () => {
    let msg = "";
    try {
      parseScenariosFile({
        name: "has spaces",
        scenarios: [
          { name: "dup", file: "./a.json" },
          { name: "dup", file: "./b.json" },
          { name: 42, file: "./c.json" },
        ],
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/name: must match/);
    expect(msg).toMatch(/duplicated/);
    expect(msg).toMatch(/scenarios\[2\]\.name/);
  });
});

// ── prepareScenarios ─────────────────────────────────────────

/** Build a per-test temp dir with playbook files. */
function makeWorkdir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "tradekit-bt-compare-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content, null, 2));
  }
  return dir;
}

describe("prepareScenarios", () => {
  it("renders templates + parses plain playbooks", () => {
    const dir = makeWorkdir({
      "trail.tmpl.json": {
        name: "{{N}}-trail",
        vars: { N: { type: "string", required: true }, PCT: { type: "number", required: true } },
        strategies: [
          { type: "order", side: "sell", trigger: "trailing", trailPct: "{{PCT}}",
            baseAmount: 1, base: "ETH", quote: "USDC" },
        ],
      },
      "plain.json": {
        name: "plain",
        strategies: [
          { type: "order", side: "sell", trigger: "price_above", price: 4000,
            baseAmount: 1, base: "ETH", quote: "USDC" },
        ],
      },
    });
    const scenariosFile = parseScenariosFile({
      scenarios: [
        { name: "trail-5", file: "trail.tmpl.json", vars: { N: "five", PCT: 5 } },
        { name: "trail-10", file: "trail.tmpl.json", vars: { N: "ten", PCT: 10 } },
        { name: "plain", file: "plain.json" },
      ],
    });
    const result = prepareScenarios({ scenariosFile, scenariosFileDir: dir });
    expect(result.specs.length).toBe(3);
    expect(result.baseSymbol).toBe("ETH");
    expect(result.quoteSymbol).toBe("USDC");
    expect(result.specs[0].name).toBe("five-trail");
    expect(result.specs[1].name).toBe("ten-trail");
    rmSync(dir, { recursive: true });
  });

  it("rejects missing required template var with prefixed error", () => {
    const dir = makeWorkdir({
      "trail.tmpl.json": {
        name: "x",
        vars: { PCT: { type: "number", required: true } },
        strategies: [{ type: "order", side: "sell", trigger: "trailing", trailPct: "{{PCT}}",
          baseAmount: 1, base: "ETH", quote: "USDC" }],
      },
    });
    const scenariosFile = parseScenariosFile({
      scenarios: [
        { name: "missing", file: "trail.tmpl.json" },
        { name: "ok", file: "trail.tmpl.json", vars: { PCT: 5 } },
      ],
    });
    let msg = "";
    try {
      prepareScenarios({ scenariosFile, scenariosFileDir: dir });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/scenarios\[0\] "missing"/);
    expect(msg).toMatch(/PCT/);
    rmSync(dir, { recursive: true });
  });

  it("rejects missing file", () => {
    const dir = makeWorkdir({});
    const scenariosFile = parseScenariosFile({
      scenarios: [
        { name: "missing", file: "no-such-file.json" },
        { name: "also-missing", file: "no-such-file2.json" },
      ],
    });
    let msg = "";
    try {
      prepareScenarios({ scenariosFile, scenariosFileDir: dir });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/cannot read/);
    expect(msg).toMatch(/no-such-file/);
    rmSync(dir, { recursive: true });
  });

  it("rejects mixed base/quote across scenarios", () => {
    const dir = makeWorkdir({
      "eth.json": {
        name: "eth-trail",
        strategies: [
          { type: "order", side: "sell", trigger: "trailing", trailPct: 5,
            baseAmount: 1, base: "ETH", quote: "USDC" },
        ],
      },
      "wbtc.json": {
        name: "wbtc-trail",
        strategies: [
          { type: "order", side: "sell", trigger: "trailing", trailPct: 5,
            baseAmount: 0.1, base: "WBTC", quote: "USDC" },
        ],
      },
    });
    const scenariosFile = parseScenariosFile({
      scenarios: [
        { name: "eth", file: "eth.json" },
        { name: "wbtc", file: "wbtc.json" },
      ],
    });
    expect(() => prepareScenarios({ scenariosFile, scenariosFileDir: dir })).toThrow(/multiple base\/quote pairs/);
    rmSync(dir, { recursive: true });
  });
});

// ── runComparison ────────────────────────────────────────────

function makeHourlySeries(startIso: string, prices: number[]) {
  const start = new Date(startIso).getTime();
  return {
    coinId: "ethereum",
    daysRequested: Math.ceil(prices.length / 24) || 1,
    points: prices.map((p, i) => ({
      ts: new Date(start + i * 3_600_000).toISOString(),
      priceUsd: p,
    })),
  };
}

describe("runComparison", () => {
  it("picks the highest-PnL scenario as winner", () => {
    const dir = makeWorkdir({
      "trail.tmpl.json": {
        name: "{{N}}-trail",
        vars: {
          N: { type: "string", required: true },
          PCT: { type: "number", required: true },
        },
        strategies: [
          { type: "order", side: "sell", trigger: "trailing", trailPct: "{{PCT}}",
            baseAmount: 1, base: "ETH", quote: "USDC" },
        ],
      },
    });
    const scenariosFile = parseScenariosFile({
      name: "trail-sweep",
      scenarios: [
        { name: "trail-5", file: "trail.tmpl.json", vars: { N: "five", PCT: 5 } },
        { name: "trail-10", file: "trail.tmpl.json", vars: { N: "ten", PCT: 10 } },
        { name: "trail-15", file: "trail.tmpl.json", vars: { N: "fifteen", PCT: 15 } },
      ],
    });

    // Series rises to $3000, then drops to $2400. Trail thresholds:
    //   5%:  fires when price retraces 5% from peak (peak=3000 → fire at 2850)
    //   10%: fires at 2700
    //   15%: fires at 2550
    // Lower trail-pct → fires HIGHER + locks in more profit; 5% should win.
    const series = makeHourlySeries(
      "2026-04-01T00:00:00Z",
      [2000, 2200, 2400, 2600, 2800, 3000, 2900, 2750, 2650, 2550, 2450, 2400],
    );
    const outcome = runComparison({
      scenariosFile,
      scenariosFileDir: dir,
      initialBalance: { ETH: 1, USDC: 0 },
      since: "30d",
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      chain: "base",
      series,
    });

    expect(outcome.scenarios.length).toBe(3);
    // 5% trail fires at ~2850 → highest PnL
    expect(outcome.winnerIdx).toBe(0);
    expect(outcome.scenarios[0].pnlUsd).toBeGreaterThan(outcome.scenarios[1].pnlUsd);
    expect(outcome.scenarios[1].pnlUsd).toBeGreaterThan(outcome.scenarios[2].pnlUsd);
    expect(outcome.scenarios.every((s) => s.hadAnyFill)).toBe(true);

    // Comparison + individual run rows persist.
    const cmp = getBacktestComparisonById(outcome.comparisonId);
    expect(cmp?.name).toBe("trail-sweep");
    expect(cmp?.run_ids.split(",").length).toBe(3);
    for (const s of outcome.scenarios) {
      expect(getBacktestRunById(s.runId)).not.toBeNull();
    }
    rmSync(dir, { recursive: true });
  });

  it("no winner when every scenario halts before any fill", () => {
    const dir = makeWorkdir({
      "high-trigger.json": {
        name: "way-too-high",
        strategies: [
          { type: "order", side: "sell", trigger: "price_above", price: 99999,
            baseAmount: 1, base: "ETH", quote: "USDC" },
        ],
      },
    });
    const scenariosFile = parseScenariosFile({
      scenarios: [
        { name: "a", file: "high-trigger.json" },
        { name: "b", file: "high-trigger.json" },
      ],
    });
    const series = makeHourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200]);
    const outcome = runComparison({
      scenariosFile,
      scenariosFileDir: dir,
      initialBalance: { ETH: 1, USDC: 0 },
      since: "1d",
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      chain: "base",
      series,
    });
    expect(outcome.winnerIdx).toBeNull();
    expect(outcome.scenarios.every((s) => !s.hadAnyFill)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("scenarios don't contaminate each other's balance", () => {
    // Two identical scenarios on the same balance — without fresh
    // copies, scenario B would start with scenario A's depleted ETH.
    const dir = makeWorkdir({
      "sell.json": {
        name: "sell",
        strategies: [
          { type: "order", side: "sell", trigger: "price_above", price: 2100,
            baseAmount: 1, base: "ETH", quote: "USDC" },
        ],
      },
    });
    const scenariosFile = parseScenariosFile({
      scenarios: [
        { name: "a", file: "sell.json" },
        { name: "b", file: "sell.json" },
      ],
    });
    const series = makeHourlySeries("2026-04-01T00:00:00Z", [2000, 2100, 2200]);
    const outcome = runComparison({
      scenariosFile,
      scenariosFileDir: dir,
      initialBalance: { ETH: 1, USDC: 0 },
      since: "1d",
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      chain: "base",
      series,
    });
    // Both should have fired (same starting balance + same trigger).
    expect(outcome.scenarios.every((s) => s.hadAnyFill)).toBe(true);
    // Both should have IDENTICAL PnL (deterministic same-input replay).
    expect(outcome.scenarios[0].pnlUsd).toBe(outcome.scenarios[1].pnlUsd);
    rmSync(dir, { recursive: true });
  });
});

// ── renderer ─────────────────────────────────────────────────

describe("renderComparison", () => {
  it("includes name, window, pair, winner mark", () => {
    const outcome = {
      comparisonId: 42,
      name: "test-sweep",
      chain: "base",
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      windowStart: "2026-04-01T00:00:00Z",
      windowEnd: "2026-04-30T23:00:00Z",
      points: 720,
      winnerIdx: 1,
      scenarios: [
        { scenarioName: "loser", runId: 1, pnlUsd: 100, holdPnlUsd: 50, vsHoldUsd: 50,
          fireCount: 1, cascadeCount: 0, finalUsd: 2100, initialUsd: 2000, perStrategy: [], hadAnyFill: true },
        { scenarioName: "winner", runId: 2, pnlUsd: 300, holdPnlUsd: 50, vsHoldUsd: 250,
          fireCount: 1, cascadeCount: 0, finalUsd: 2300, initialUsd: 2000, perStrategy: [], hadAnyFill: true },
      ],
    };
    const rendered = renderComparison(outcome);
    expect(rendered).toMatch(/Backtest comparison #42 "test-sweep"/);
    expect(rendered).toMatch(/ETH\/USDC/);
    expect(rendered).toMatch(/loser/);
    expect(rendered).toMatch(/winner/);
    expect(rendered).toMatch(/★/); // winner mark
    expect(rendered).toMatch(/Winner: winner/);
    expect(rendered).toMatch(/HOLD/);
  });

  it("indicates no-winner case", () => {
    const outcome = {
      comparisonId: 1,
      name: "all-halted",
      chain: "base",
      baseSymbol: "ETH",
      quoteSymbol: "USDC",
      windowStart: "2026-04-01T00:00:00Z",
      windowEnd: "2026-04-30T23:00:00Z",
      points: 720,
      winnerIdx: null,
      scenarios: [
        { scenarioName: "a", runId: 1, pnlUsd: 0, holdPnlUsd: 50, vsHoldUsd: -50,
          fireCount: 0, cascadeCount: 0, finalUsd: 2000, initialUsd: 2000, perStrategy: [], hadAnyFill: false },
        { scenarioName: "b", runId: 2, pnlUsd: 0, holdPnlUsd: 50, vsHoldUsd: -50,
          fireCount: 0, cascadeCount: 0, finalUsd: 2000, initialUsd: 2000, perStrategy: [], hadAnyFill: false },
      ],
    };
    const rendered = renderComparison(outcome);
    expect(rendered).toMatch(/No winner/);
    expect(rendered).not.toMatch(/★/);
  });
});

// ── orchestrator ─────────────────────────────────────────────

describe("runCompareFromFile", () => {
  it("end-to-end with injected price fetcher", async () => {
    const dir = makeWorkdir({
      "trail.tmpl.json": {
        name: "{{N}}-trail",
        vars: {
          N: { type: "string", required: true },
          PCT: { type: "number", required: true },
        },
        strategies: [
          { type: "order", side: "sell", trigger: "trailing", trailPct: "{{PCT}}",
            baseAmount: 1, base: "ETH", quote: "USDC" },
        ],
      },
      "scenarios.json": {
        name: "smoke",
        scenarios: [
          { name: "five", file: "trail.tmpl.json", vars: { N: "fivename", PCT: 5 } },
          { name: "ten", file: "trail.tmpl.json", vars: { N: "tenname", PCT: 10 } },
        ],
      },
    });
    const series = makeHourlySeries("2026-04-01T00:00:00Z", [2000, 2500, 3000, 2700, 2400]);
    const outcome = await runCompareFromFile({
      scenariosPath: join(dir, "scenarios.json"),
      initialBalance: { ETH: 1, USDC: 0 },
      since: "1d",
      chain: "base",
      baseAddress: "0x4200000000000000000000000000000000000006",
      priceFetcher: async () => series,
    });
    expect(outcome.scenarios.length).toBe(2);
    expect(outcome.name).toBe("smoke");
    expect(getBacktestComparisonById(outcome.comparisonId)).not.toBeNull();
    expect(listBacktestComparisons({}).length).toBe(1);
    rmSync(dir, { recursive: true });
  });

  it("surfaces structured error when CoinGecko returns no series", async () => {
    const dir = makeWorkdir({
      "trail.json": {
        name: "trail",
        strategies: [
          { type: "order", side: "sell", trigger: "trailing", trailPct: 5,
            baseAmount: 1, base: "ETH", quote: "USDC" },
        ],
      },
      "scenarios.json": {
        scenarios: [
          { name: "a", file: "trail.json" },
          { name: "b", file: "trail.json" },
        ],
      },
    });
    await expect(
      runCompareFromFile({
        scenariosPath: join(dir, "scenarios.json"),
        initialBalance: { ETH: 1, USDC: 0 },
        since: "1d",
        chain: "base",
        baseAddress: "0x4200000000000000000000000000000000000006",
        priceFetcher: async () => null,
      }),
    ).rejects.toThrow(/CoinGecko-listed/);
    rmSync(dir, { recursive: true });
  });
});
