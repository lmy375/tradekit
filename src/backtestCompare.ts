/**
 * Multi-scenario backtest comparison.
 *
 * The natural follow-on to template parameterization (iter21).
 * Operators with a parameterizable playbook want to compare variants
 * side-by-side: "trail-5pct vs trail-10pct vs trail-15pct, which
 * makes the most money over the last 60 days?". Without this,
 * comparison meant running N separate `backtest playbook` invocations
 * and mentally diffing terminal output — tedious enough that nobody
 * did it.
 *
 * Mechanism. Operator writes a scenarios file:
 *
 *   {
 *     "name": "trail-pct-sweep",
 *     "scenarios": [
 *       { "name": "5pct",  "file": "./trail.tmpl.json", "vars": { "TRAIL_PCT": 5 } },
 *       { "name": "10pct", "file": "./trail.tmpl.json", "vars": { "TRAIL_PCT": 10 } },
 *       { "name": "15pct", "file": "./trail.tmpl.json", "vars": { "TRAIL_PCT": 15 } }
 *     ]
 *   }
 *
 * Then `tradekit backtest compare <file>`:
 *   1. Parse + render every scenario (template-aware).
 *   2. Validate every rendered spec is backtestable (single-base,
 *      no rebalance) AND every scenario uses the SAME base/quote
 *      pair — comparison only makes sense on one price series.
 *   3. Fetch ONE price series.
 *   4. For each scenario: simulate against a FRESH copy of the
 *      initial balance.
 *   5. Persist each scenario as a regular backtest_runs row + the
 *      comparison summary as a new backtest_comparisons row linking
 *      to those runs.
 *   6. Output: per-scenario stats + winner (highest PnL).
 *
 * Why the same-pair invariant. The shared price series carries one
 * (base, quote) — a scenarios file mixing ETH and WBTC would need
 * two CoinGecko fetches AND the "winner" comparison would compare
 * USD totals across different asset trajectories, which conflates
 * strategy efficacy with market direction. Surfacing the violation
 * upfront points operators at running independent comparisons per
 * pair instead.
 *
 * Persistence design: each scenario writes a normal `backtest_runs`
 * row so `backtest show <id>` works on it untouched. The
 * comparison row stores the per-scenario summary + the list of run
 * ids so `backtest compare show <id>` can re-render without
 * re-running simulations OR re-fetching CoinGecko data.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname as pathDirname, isAbsolute as pathIsAbsolute, join as pathJoin } from "node:path";
import { ToolError } from "./errors.js";
import { renderPlaybookTemplate } from "./playbookTemplate.js";
import { parsePlaybookSpec, type PlaybookSpec, type StrategySpec, type OrderSpec, type ScheduleSpec } from "./playbooks.js";
import {
  fetchPriceSeries,
  simulatePlaybook,
  normalizeSimCosts,
  type SimCosts,
  parseSinceDuration,
  type SymbolBalance,
  type PriceSeries,
  type PlaybookBacktestResult,
} from "./backtest.js";
import {
  insertBacktestRun,
  insertBacktestComparison,
} from "./db.js";

// ── scenarios file shape ─────────────────────────────────────

export interface ScenarioSpec {
  /** Operator-facing label for the scenario. Surfaces in the
   *  comparison table + persisted alongside the underlying run. */
  name: string;
  /** Path to a playbook (template OR plain) file. Relative paths
   *  resolve against the SCENARIOS file's directory — operators
   *  expect `./trail.tmpl.json` inside scenarios.json to mean
   *  "next to scenarios.json", not "wherever the CLI runs from". */
  file: string;
  /** Variables for the template, if the file is templatized. */
  vars?: Record<string, string | number | boolean>;
}

export interface ScenariosFile {
  /** Optional name for the comparison itself. Default:
   *  "comparison-<timestamp>". */
  name?: string;
  scenarios: ScenarioSpec[];
}

// ── parser ───────────────────────────────────────────────────

const NAME_RX = /^[A-Za-z0-9_-]{1,64}$/;

export function parseScenariosFile(raw: unknown): ScenariosFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolError("INVALID_PARAMS", `Scenarios file must be a JSON object.`);
  }
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (r.name != null) {
    if (typeof r.name !== "string" || !NAME_RX.test(r.name)) {
      errors.push(`name: must match ${NAME_RX}`);
    }
  }
  if (!Array.isArray(r.scenarios)) {
    errors.push(`scenarios: required array of scenario specs`);
    throw new ToolError("INVALID_PARAMS", `Invalid scenarios file:\n  ${errors.join("\n  ")}`);
  }
  if ((r.scenarios as unknown[]).length < 2) {
    errors.push(`scenarios: at least 2 scenarios required (comparison needs ≥2 to be meaningful)`);
  }
  if ((r.scenarios as unknown[]).length > 50) {
    errors.push(`scenarios: max 50 scenarios per comparison (got ${(r.scenarios as unknown[]).length}) — split into multiple files`);
  }

  const seenNames = new Set<string>();
  const scenarios: ScenarioSpec[] = [];
  (r.scenarios as unknown[]).forEach((s, i) => {
    const prefix = `scenarios[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      errors.push(`${prefix}: must be an object`);
      return;
    }
    const sObj = s as Record<string, unknown>;
    if (typeof sObj.name !== "string" || !NAME_RX.test(sObj.name)) {
      errors.push(`${prefix}.name: required string matching ${NAME_RX}`);
    } else if (seenNames.has(sObj.name)) {
      errors.push(`${prefix}.name: "${sObj.name}" is duplicated within the comparison`);
    } else {
      seenNames.add(sObj.name);
    }
    if (typeof sObj.file !== "string" || sObj.file === "") {
      errors.push(`${prefix}.file: required non-empty string (path to playbook JSON)`);
    }
    let vars: Record<string, string | number | boolean> | undefined;
    if (sObj.vars !== undefined) {
      if (!sObj.vars || typeof sObj.vars !== "object" || Array.isArray(sObj.vars)) {
        errors.push(`${prefix}.vars: must be an object`);
      } else {
        vars = {};
        for (const [k, v] of Object.entries(sObj.vars as Record<string, unknown>)) {
          if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
            errors.push(`${prefix}.vars.${k}: must be string | number | boolean (got ${typeof v})`);
          } else {
            vars[k] = v;
          }
        }
      }
    }
    if (typeof sObj.name === "string" && typeof sObj.file === "string") {
      scenarios.push({
        name: sObj.name,
        file: sObj.file,
        vars,
      });
    }
  });

  if (errors.length) {
    throw new ToolError("INVALID_PARAMS", `Invalid scenarios file:\n  ${errors.join("\n  ")}`);
  }
  return {
    name: (r.name as string | undefined) ?? `comparison-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}`,
    scenarios,
  };
}

// ── runner ───────────────────────────────────────────────────

export interface ScenarioResult {
  scenarioName: string;
  runId: number;
  pnlUsd: number;
  holdPnlUsd: number;
  vsHoldUsd: number;
  fireCount: number;
  cascadeCount: number;
  finalUsd: number;
  initialUsd: number;
  perStrategy: PlaybookBacktestResult["perStrategy"];
  /** True iff at least one strategy in the scenario fired a real fill. */
  hadAnyFill: boolean;
  /** v40: total USD friction paid (slippage + gas); 0 when the
   *  comparison ran cost-free. */
  frictionUsd: number;
}

export interface ComparisonOutcome {
  /** Comparison row id in backtest_comparisons. */
  comparisonId: number;
  /** Display name from scenarios file. */
  name: string;
  /** Resolved chain + pair (shared across all scenarios). */
  chain: string;
  baseSymbol: string;
  quoteSymbol: string;
  /** Window from the shared price series. */
  windowStart: string;
  windowEnd: string;
  points: number;
  /** Per-scenario outcomes in input order. */
  scenarios: ScenarioResult[];
  /** Index of the highest-PnL scenario; null when all halted before
   *  any fill (no winner makes sense). */
  winnerIdx: number | null;
}

export interface RunComparisonArgs {
  scenariosFile: ScenariosFile;
  /** Directory the relative `scenarios[].file` paths resolve against. */
  scenariosFileDir: string;
  initialBalance: SymbolBalance;
  /** ISO-style duration / day count (e.g. "30d", "60d", "1y"). */
  since: string;
  /** Resolved base/quote/chain. The runner already validated these
   *  match every scenario's playbook. */
  baseSymbol: string;
  quoteSymbol: string;
  chain: string;
  /** Series fetched by the caller — lets `backtest compare` reuse a
   *  test injection seam + run with mocked data. */
  series: PriceSeries;
  /** v40: friction model applied IDENTICALLY to every scenario —
   *  fair comparison requires shared costs. */
  costs?: Partial<SimCosts> | null;
}

/**
 * Validate + render every scenario. Returns parsed playbook specs +
 * the resolved shared pair. Throws INVALID_PARAMS on:
 *   - file read / JSON parse failure
 *   - template render failure
 *   - playbook spec validation failure
 *   - mixed base/quote across scenarios
 *
 * Pure (no DB writes, no network) so it composes cleanly in tests.
 */
export function prepareScenarios(args: {
  scenariosFile: ScenariosFile;
  scenariosFileDir: string;
}): { specs: PlaybookSpec[]; baseSymbol: string; quoteSymbol: string } {
  const { scenariosFile, scenariosFileDir } = args;
  const errors: string[] = [];
  const specs: PlaybookSpec[] = [];

  scenariosFile.scenarios.forEach((scenario, i) => {
    const prefix = `scenarios[${i}] "${scenario.name}"`;
    const absPath = pathIsAbsolute(scenario.file)
      ? scenario.file
      : pathJoin(scenariosFileDir, scenario.file);
    let text: string;
    try {
      text = readFileSync(absPath, "utf8");
    } catch (e) {
      errors.push(`${prefix}: cannot read "${scenario.file}": ${(e as Error).message}`);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      errors.push(`${prefix}: "${scenario.file}" is not valid JSON: ${(e as Error).message}`);
      return;
    }
    let rendered: unknown;
    try {
      const r = renderPlaybookTemplate({ raw, provided: scenario.vars ?? {} });
      rendered = r.rendered;
    } catch (e) {
      errors.push(`${prefix}: template render failed — ${(e as Error).message}`);
      return;
    }
    try {
      const spec = parsePlaybookSpec(rendered);
      specs.push(spec);
    } catch (e) {
      errors.push(`${prefix}: spec validation failed — ${(e as Error).message}`);
    }
  });

  if (errors.length) {
    throw new ToolError("INVALID_PARAMS", `Comparison failed to prepare scenarios:\n  ${errors.join("\n  ")}`);
  }

  // Same-pair invariant: every scenario must reference the same base
  // + quote across every non-rebalance strategy. simulatePlaybook
  // will reject mixed-pair playbooks individually, but for
  // comparison we need ALL scenarios to agree.
  const pairs: Set<string> = new Set();
  let firstBase = "";
  let firstQuote = "";
  specs.forEach((spec) => {
    const nonRebalance = spec.strategies.filter(
      (s): s is OrderSpec | ScheduleSpec => s.type === "order" || s.type === "schedule",
    );
    if (nonRebalance.length === 0) return;
    const base = nonRebalance[0].base.toUpperCase();
    const quote = nonRebalance[0].quote.toUpperCase();
    pairs.add(`${base}/${quote}`);
    if (firstBase === "") {
      firstBase = base;
      firstQuote = quote;
    }
  });
  if (pairs.size > 1) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Scenarios reference multiple base/quote pairs (${Array.from(pairs).join(", ")}). ` +
        `Comparison requires a single shared pair so all scenarios run against the same price series. ` +
        `Split into per-pair scenarios files and compare each independently.`,
    );
  }
  if (pairs.size === 0) {
    throw new ToolError(
      "INVALID_PARAMS",
      `No scenarios reference an order or schedule strategy — comparison needs at least one tradeable primitive per scenario.`,
    );
  }
  return { specs, baseSymbol: firstBase, quoteSymbol: firstQuote };
}

/**
 * Run the full comparison: simulate every scenario against the shared
 * price series + a fresh balance copy, persist results, compute the
 * winner. Returns the orchestration outcome including the comparison
 * row id.
 */
export function runComparison(args: RunComparisonArgs): ComparisonOutcome {
  const { scenariosFile, scenariosFileDir, initialBalance, series, baseSymbol, quoteSymbol, chain } = args;
  const costs = normalizeSimCosts(args.costs);
  const { specs } = prepareScenarios({ scenariosFile, scenariosFileDir });

  const results: ScenarioResult[] = [];
  const runIds: number[] = [];

  specs.forEach((spec, i) => {
    const scenario = scenariosFile.scenarios[i];
    // Fresh balance copy per scenario — JSON deep-clone is safe for
    // SymbolBalance (flat string→number map).
    const balanceForScenario: SymbolBalance = { ...initialBalance };
    const simResult = simulatePlaybook({
      spec,
      baseSymbol,
      quoteSymbol,
      initialBalance: balanceForScenario,
      series,
      costs,
    });

    // Persist as a regular backtest_runs row so `backtest show <id>`
    // works on individual scenarios. Notes carry the comparison
    // attribution.
    const runId = insertBacktestRun({
      strategyType: "playbook",
      chain,
      baseSymbol,
      quoteSymbol,
      specJson: JSON.stringify(spec),
      initialBalanceJson: JSON.stringify(initialBalance),
      finalBalanceJson: JSON.stringify(simResult.finalBalance),
      windowStart: simResult.windowStart,
      windowEnd: simResult.windowEnd,
      points: series.points.length,
      firesJson: JSON.stringify(simResult.fires),
      fireCount: simResult.fires.filter((f) => f.multiAction === "fill").length,
      pnlUsd: simResult.pnlUsd,
      holdPnlUsd: simResult.holdPnlUsd,
      notes:
        (simResult.notes.join("; ") || "") +
        (simResult.notes.length ? " | " : "") +
        `scenario=${scenario.name} comparison=${scenariosFile.name}`,
    });
    runIds.push(runId);

    const fills = simResult.fires.filter((f) => f.multiAction === "fill");
    results.push({
      scenarioName: scenario.name,
      runId,
      pnlUsd: simResult.pnlUsd,
      holdPnlUsd: simResult.holdPnlUsd,
      vsHoldUsd: simResult.pnlUsd - simResult.holdPnlUsd,
      fireCount: fills.length,
      cascadeCount: simResult.fires.filter((f) => f.multiAction === "oco_cascade").length,
      finalUsd: simResult.finalUsd,
      initialUsd: simResult.initialUsd,
      perStrategy: simResult.perStrategy,
      hadAnyFill: fills.length > 0,
      frictionUsd: simResult.costs?.totalUsd ?? 0,
    });
  });

  // Winner: highest PnL among scenarios with at least one fill. When
  // no scenario fired anything, "winner" is undefined — all halted
  // before any value moved. Reported as null so the CLI shows
  // "—" instead of forcing a misleading pick.
  let winnerIdx: number | null = null;
  let bestPnl = -Infinity;
  results.forEach((r, i) => {
    if (!r.hadAnyFill) return;
    if (r.pnlUsd > bestPnl) {
      bestPnl = r.pnlUsd;
      winnerIdx = i;
    }
  });

  // Persist comparison summary.
  const comparisonId = insertBacktestComparison({
    name: scenariosFile.name!,
    scenariosJson: JSON.stringify(scenariosFile),
    resultsJson: JSON.stringify(results),
    runIds,
    baseSymbol,
    quoteSymbol,
    chain,
    windowStart: results[0]?.perStrategy ? series.points[0].ts : series.points[0].ts,
    windowEnd: series.points[series.points.length - 1].ts,
    winnerIdx,
  });

  return {
    comparisonId,
    name: scenariosFile.name!,
    chain,
    baseSymbol,
    quoteSymbol,
    windowStart: series.points[0].ts,
    windowEnd: series.points[series.points.length - 1].ts,
    points: series.points.length,
    scenarios: results,
    winnerIdx,
  };
}

// ── rendering ────────────────────────────────────────────────

function fmtSignedUsd(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const s = n >= 0 ? "+" : "";
  return `${s}$${n.toFixed(2)}`;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "?";
  return `$${n.toFixed(2)}`;
}

/** Render a comparison outcome as a multi-line operator-facing table. */
export function renderComparison(outcome: ComparisonOutcome): string {
  const lines: string[] = [];
  lines.push(`Backtest comparison #${outcome.comparisonId} "${outcome.name}"`);
  lines.push(`  Window:        ${outcome.windowStart} → ${outcome.windowEnd}`);
  lines.push(`  Datapoints:    ${outcome.points} (CoinGecko ${outcome.chain})`);
  lines.push(`  Pair:          ${outcome.baseSymbol}/${outcome.quoteSymbol}`);
  lines.push(`  Scenarios:     ${outcome.scenarios.length}`);
  lines.push(``);
  // Column widths sized to ~80-col terminal.
  const nameW = Math.max(20, Math.max(...outcome.scenarios.map((s) => s.scenarioName.length)) + 2);
  const header = `  ${"NAME".padEnd(nameW)} ${"PNL".padStart(12)}  ${"VS HOLD".padStart(11)}  ${"FIRES".padStart(5)}  ${"FINAL USD".padStart(11)}  ${"RUN".padStart(4)}  WINNER`;
  lines.push(header);
  lines.push(`  ${"-".repeat(header.length - 2)}`);
  outcome.scenarios.forEach((s, i) => {
    const winnerMark = i === outcome.winnerIdx ? "  ★" : "";
    lines.push(
      `  ${s.scenarioName.padEnd(nameW)} ${fmtSignedUsd(s.pnlUsd).padStart(12)}  ${fmtSignedUsd(s.vsHoldUsd).padStart(11)}  ${String(s.fireCount).padStart(5)}  ${fmtUsd(s.finalUsd).padStart(11)}  #${String(s.runId).padStart(3)}${winnerMark}`,
    );
  });
  // Counterfactual row.
  const firstScenario = outcome.scenarios[0];
  if (firstScenario) {
    lines.push(``);
    lines.push(
      `  ${"HOLD (no trades)".padEnd(nameW)} ${fmtSignedUsd(firstScenario.holdPnlUsd).padStart(12)}  ${"—".padStart(11)}  ${"0".padStart(5)}  ${fmtUsd(firstScenario.initialUsd + firstScenario.holdPnlUsd).padStart(11)}  ${"—".padStart(4)}`,
    );
  }
  // v40: friction footnote — PnL above is NET of these costs; the
  // HOLD row pays none (that asymmetry is the comparison's point).
  if (outcome.scenarios.some((s) => s.frictionUsd > 0)) {
    lines.push(``);
    lines.push(`  Friction paid (already deducted from PnL):`);
    for (const s of outcome.scenarios) {
      lines.push(`    ${s.scenarioName.padEnd(nameW)} ${fmtUsd(s.frictionUsd).padStart(12)}`);
    }
  }
  lines.push(``);
  if (outcome.winnerIdx !== null) {
    const winner = outcome.scenarios[outcome.winnerIdx];
    lines.push(`Winner: ${winner.scenarioName}  (PnL ${fmtSignedUsd(winner.pnlUsd)}, ${fmtSignedUsd(winner.vsHoldUsd)} vs hold, run #${winner.runId})`);
  } else {
    lines.push(`No winner: every scenario halted before any fill. Strategies may need different triggers, longer window, or larger initial balance.`);
  }
  return lines.join("\n");
}

// ── CLI orchestrator ─────────────────────────────────────────

/**
 * High-level entry the CLI calls. Reads + parses the scenarios file,
 * prepares scenarios, fetches the price series, runs the comparison,
 * returns the outcome. Caller handles render + persist-was-already-done.
 *
 * `priceFetcher` is an injection seam for tests.
 */
export async function runCompareFromFile(args: {
  scenariosPath: string;
  initialBalance: SymbolBalance;
  since: string;
  chain: string;
  baseAddress: `0x${string}`;
  priceFetcher?: (addr: string, days: number) => Promise<PriceSeries | null>;
  costs?: Partial<SimCosts> | null;
}): Promise<ComparisonOutcome> {
  const absPath = resolvePath(args.scenariosPath);
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Cannot read scenarios file "${args.scenariosPath}": ${(e as Error).message}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Scenarios file "${args.scenariosPath}" is not valid JSON: ${(e as Error).message}`,
    );
  }
  const scenariosFile = parseScenariosFile(raw);
  const scenariosFileDir = pathDirname(absPath);

  // Verify scenarios are prep-able BEFORE fetching CoinGecko data.
  // Prepare also validates the shared-pair invariant so we know the
  // pair before fetching.
  const { specs, baseSymbol, quoteSymbol } = prepareScenarios({
    scenariosFile,
    scenariosFileDir,
  });
  void specs; // prep validates; runComparison re-preps internally.

  const days = parseSinceDuration(args.since);
  const fetcher = args.priceFetcher ?? fetchPriceSeries;
  const series = await fetcher(args.baseAddress, days);
  if (!series) {
    throw new ToolError(
      "UNKNOWN_TOKEN",
      `Comparison requires a CoinGecko-listed base token. Base "${baseSymbol}" on chain "${args.chain}" isn't in the mapping.`,
    );
  }

  return runComparison({
    scenariosFile,
    scenariosFileDir,
    initialBalance: args.initialBalance,
    since: args.since,
    baseSymbol,
    quoteSymbol,
    chain: args.chain,
    series,
    costs: args.costs,
  });
}

// Re-export for CLI / tests.
export type { StrategySpec };
