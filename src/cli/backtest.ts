// CLI surface for historical strategy backtesting.
//
//   tradekit backtest order
//     --chain X --base ETH --quote USDC
//     --side buy|sell
//     --trigger price_below|price_above|trailing
//     (--price USD | --trail-pct PCT [--price ACTIVATION_USD])
//     (--baseAmount A | --quoteAmount A)
//     --balance '{"ETH":1.0,"USDC":3000}'
//     --since 30d
//     [--json]
//
//   tradekit backtest schedule
//     --chain X --base ETH --quote USDC
//     --side buy|sell
//     (--cron "<5-field>" | --every 30m|1h|6h|1d|7d)
//     (--baseAmount A | --quoteAmount A)
//     [--max-runs N]
//     --balance '{"USDC":3000}'
//     --since 30d
//     [--json]
//
//   tradekit backtest list   [--strategy-type order|schedule] [--chain X] [--limit N] [--json]
//   tradekit backtest show   <id> [--json]
//
// Result is persisted to backtest_runs so `backtest show <id>` can
// re-render without re-fetching the CoinGecko series.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { ToolError } from "../errors.js";
import { loadConfig, resolveProfile } from "../config.js";
import { resolveTradePair } from "../chains.js";
import {
  simulateOrder,
  simulateSchedule,
  simulatePlaybook,
  fetchPriceSeries,
  parseSinceDuration,
  type OrderBacktestSpec,
  type ScheduleBacktestSpec,
  type SymbolBalance,
  type BacktestResult,
  type PlaybookBacktestResult,
  type PriceSeries,
} from "../backtest.js";
import { parsePlaybookSpec, type PlaybookSpec } from "../playbooks.js";
import {
  insertBacktestRun,
  getBacktestRunById,
  listBacktestRuns,
  type BacktestRunRow,
  type BacktestStrategyType,
} from "../db.js";
import { durationToCron } from "../cron.js";
import { printJson, parseIntFlag, parseFloatFlag, subcommandError } from "./helpers.js";

// ── shared helpers ───────────────────────────────────────────

function parseBalance(raw: string | undefined): SymbolBalance {
  if (!raw) {
    throw new ToolError("INVALID_PARAMS", `--balance is required, e.g. '{"ETH":1.0,"USDC":3000}'.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ToolError("INVALID_PARAMS", `--balance is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError("INVALID_PARAMS", `--balance must be a JSON object {SYM: amount}.`);
  }
  const out: SymbolBalance = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--balance entry ${k}=${JSON.stringify(v)} must be a finite non-negative number.`,
      );
    }
    out[k.toUpperCase()] = v;
  }
  return out;
}

function fmt(n: number, fractionDigits = 4): string {
  if (!Number.isFinite(n)) return "?";
  if (Math.abs(n) >= 1) return n.toFixed(fractionDigits);
  return n.toPrecision(fractionDigits);
}

function fmtSignedUsd(n: number): string {
  const s = n >= 0 ? "+" : "";
  return `${s}$${n.toFixed(2)}`;
}

// ── render ───────────────────────────────────────────────────

function renderResultText(args: {
  result: BacktestResult;
  series: PriceSeries;
  baseSymbol: string;
  quoteSymbol: string;
  strategyType: BacktestStrategyType;
  rowId: number;
}): string {
  const { result, series, baseSymbol, quoteSymbol, strategyType, rowId } = args;
  const lines: string[] = [];
  lines.push(`Backtest #${rowId} (${strategyType})`);
  lines.push(`  Window:        ${result.windowStart} → ${result.windowEnd}`);
  lines.push(`  Datapoints:    ${series.points.length} (CoinGecko ${series.coinId}, ${series.daysRequested}d)`);
  lines.push("");
  lines.push(`  Initial USD:   $${result.initialUsd.toFixed(2)}`);
  lines.push(`  Final USD:     $${result.finalUsd.toFixed(2)}`);
  lines.push(`  Strategy PnL:  ${fmtSignedUsd(result.pnlUsd)}`);
  lines.push(`  Hold PnL:      ${fmtSignedUsd(result.holdPnlUsd)}`);
  const diff = result.pnlUsd - result.holdPnlUsd;
  const verb = diff >= 0 ? "outperformed" : "underperformed";
  lines.push(`  Vs hold:       ${verb} by ${fmtSignedUsd(diff)}`);
  lines.push("");
  lines.push(`  Final balance:`);
  for (const [sym, amt] of Object.entries(result.finalBalance)) {
    lines.push(`    ${sym.padEnd(8)} ${fmt(amt)}`);
  }
  if (result.fires.length === 0) {
    lines.push("");
    lines.push(`  No fires.`);
  } else {
    lines.push("");
    lines.push(`  Fires (${result.fires.length}):`);
    for (const f of result.fires) {
      const marker = f.action === "fill" ? "●" : "✕";
      lines.push(`    ${marker} ${f.ts}  $${fmt(f.priceUsd, 2)}  ${f.note ?? ""}`);
    }
  }
  if (result.notes.length) {
    lines.push("");
    lines.push(`  Notes:`);
    for (const n of result.notes) lines.push(`    - ${n}`);
  }
  void baseSymbol;
  void quoteSymbol;
  return lines.join("\n");
}

function buildJsonResult(args: {
  result: BacktestResult;
  series: PriceSeries;
  baseSymbol: string;
  quoteSymbol: string;
  strategyType: BacktestStrategyType;
  rowId: number;
  spec: OrderBacktestSpec | ScheduleBacktestSpec;
  initialBalance: SymbolBalance;
  chain: string;
}) {
  const { result, series, baseSymbol, quoteSymbol, strategyType, rowId, spec, initialBalance, chain } = args;
  return {
    ok: true,
    id: rowId,
    strategy_type: strategyType,
    chain,
    base_symbol: baseSymbol,
    quote_symbol: quoteSymbol,
    spec,
    initial_balance: initialBalance,
    final_balance: result.finalBalance,
    window_start: result.windowStart,
    window_end: result.windowEnd,
    coingecko_id: series.coinId,
    points: series.points.length,
    initial_usd: result.initialUsd,
    final_usd: result.finalUsd,
    pnl_usd: result.pnlUsd,
    hold_pnl_usd: result.holdPnlUsd,
    hold_final_usd: result.holdFinalUsd,
    fires: result.fires,
    notes: result.notes,
  };
}

// ── order ────────────────────────────────────────────────────

export async function backtestOrderCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);

  const side = flags["side"];
  if (side !== "buy" && side !== "sell") {
    throw new ToolError("INVALID_PARAMS", `--side must be buy or sell (got "${side ?? "(missing)"}").`);
  }
  const trigger = flags["trigger"];
  if (trigger !== "price_below" && trigger !== "price_above" && trigger !== "trailing") {
    throw new ToolError(
      "INVALID_PARAMS",
      `--trigger must be price_below | price_above | trailing (got "${trigger ?? "(missing)"}").`,
    );
  }

  const baseInput = flags["base"];
  const quoteInput = flags["quote"];
  if (!baseInput || !quoteInput) {
    throw new ToolError("INVALID_PARAMS", `--base and --quote are required.`);
  }
  // Resolve base to an address so we can look up the CoinGecko mapping.
  const pair = resolveTradePair(profile, baseInput, quoteInput);
  // For native ETH the trade-pair returns the literal "ETH" sentinel; map to
  // the chain's WETH address for the price lookup.
  const baseAddrForPrice = pair.base === "ETH" ? profile.weth : pair.base;
  if (!baseAddrForPrice) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Cannot resolve a price address for ${baseInput} on ${profile.name} — missing WETH config.`,
    );
  }

  const targetPriceUsd = parseFloatFlag(flags["price"], "--price", { min: 0 });
  const trailPct = parseFloatFlag(flags["trail-pct"], "--trail-pct", { min: 0, max: 100 });
  const baseAmount = parseFloatFlag(flags["baseAmount"], "--baseAmount", { min: 0 });
  const quoteAmount = parseFloatFlag(flags["quoteAmount"], "--quoteAmount", { min: 0 });

  const spec: OrderBacktestSpec = {
    side,
    trigger,
    targetPriceUsd: targetPriceUsd ?? undefined,
    trailPct: trailPct ?? undefined,
    baseAmount: baseAmount ?? undefined,
    quoteAmount: quoteAmount ?? undefined,
  };

  const initialBalance = parseBalance(flags["balance"]);
  const since = flags["since"] ?? "30d";
  const days = parseSinceDuration(since);

  const series = await fetchPriceSeries(baseAddrForPrice, days);
  if (!series) {
    throw new ToolError(
      "UNKNOWN_TOKEN",
      `Backtest requires a CoinGecko-listed base token. "${baseInput}" on chain "${profile.name}" isn't in the mapping — try a major asset (ETH/WBTC/USDC/major L1 tokens).`,
    );
  }

  // Use the chain profile's symbols (which the operator typed) rather than
  // re-deriving from the resolved address.
  const baseSymbol = baseInput.toUpperCase() === "ETH" ? "ETH" : baseInput.toUpperCase();
  const quoteSymbol = quoteInput.toUpperCase();

  const result = simulateOrder({
    spec,
    baseSymbol,
    quoteSymbol,
    initialBalance,
    series,
  });

  const rowId = insertBacktestRun({
    strategyType: "order",
    chain: profile.name,
    baseSymbol,
    quoteSymbol,
    specJson: JSON.stringify(spec),
    initialBalanceJson: JSON.stringify(initialBalance),
    finalBalanceJson: JSON.stringify(result.finalBalance),
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
    points: series.points.length,
    firesJson: JSON.stringify(result.fires),
    fireCount: result.fires.length,
    pnlUsd: result.pnlUsd,
    holdPnlUsd: result.holdPnlUsd,
    notes: result.notes.join("; ") || null,
  });

  if (flags["json"] != null) {
    printJson(
      buildJsonResult({
        result, series, baseSymbol, quoteSymbol, strategyType: "order",
        rowId, spec, initialBalance, chain: profile.name,
      }),
    );
    return;
  }
  console.log(renderResultText({ result, series, baseSymbol, quoteSymbol, strategyType: "order", rowId }));
}

// ── schedule ─────────────────────────────────────────────────

export async function backtestScheduleCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);

  const side = flags["side"];
  if (side !== "buy" && side !== "sell") {
    throw new ToolError("INVALID_PARAMS", `--side must be buy or sell (got "${side ?? "(missing)"}").`);
  }
  if (!flags["cron"] && !flags["every"]) {
    throw new ToolError(
      "INVALID_PARAMS",
      "One of --cron \"<5-field>\" or --every <duration> (30m, 1h, 6h, 1d, 7d) is required.",
    );
  }
  if (flags["cron"] && flags["every"]) {
    throw new ToolError("INVALID_PARAMS", "Pass --cron OR --every, not both.");
  }
  const cron = flags["cron"] ?? durationToCron(flags["every"]);

  const baseInput = flags["base"];
  const quoteInput = flags["quote"];
  if (!baseInput || !quoteInput) {
    throw new ToolError("INVALID_PARAMS", `--base and --quote are required.`);
  }
  const pair = resolveTradePair(profile, baseInput, quoteInput);
  const baseAddrForPrice = pair.base === "ETH" ? profile.weth : pair.base;
  if (!baseAddrForPrice) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Cannot resolve a price address for ${baseInput} on ${profile.name} — missing WETH config.`,
    );
  }

  const baseAmount = parseFloatFlag(flags["baseAmount"], "--baseAmount", { min: 0 });
  const quoteAmount = parseFloatFlag(flags["quoteAmount"], "--quoteAmount", { min: 0 });
  const maxRuns = parseIntFlag(flags["max-runs"], "--max-runs", { min: 1, max: 100_000 });

  const spec: ScheduleBacktestSpec = {
    side,
    cron,
    baseAmount: baseAmount ?? undefined,
    quoteAmount: quoteAmount ?? undefined,
    maxRuns: maxRuns ?? undefined,
  };

  const initialBalance = parseBalance(flags["balance"]);
  const since = flags["since"] ?? "30d";
  const days = parseSinceDuration(since);

  const series = await fetchPriceSeries(baseAddrForPrice, days);
  if (!series) {
    throw new ToolError(
      "UNKNOWN_TOKEN",
      `Backtest requires a CoinGecko-listed base token. "${baseInput}" on chain "${profile.name}" isn't in the mapping.`,
    );
  }

  const baseSymbol = baseInput.toUpperCase() === "ETH" ? "ETH" : baseInput.toUpperCase();
  const quoteSymbol = quoteInput.toUpperCase();

  const result = simulateSchedule({
    spec,
    baseSymbol,
    quoteSymbol,
    initialBalance,
    series,
  });

  const rowId = insertBacktestRun({
    strategyType: "schedule",
    chain: profile.name,
    baseSymbol,
    quoteSymbol,
    specJson: JSON.stringify(spec),
    initialBalanceJson: JSON.stringify(initialBalance),
    finalBalanceJson: JSON.stringify(result.finalBalance),
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
    points: series.points.length,
    firesJson: JSON.stringify(result.fires),
    fireCount: result.fires.length,
    pnlUsd: result.pnlUsd,
    holdPnlUsd: result.holdPnlUsd,
    notes: result.notes.join("; ") || null,
  });

  if (flags["json"] != null) {
    printJson(
      buildJsonResult({
        result, series, baseSymbol, quoteSymbol, strategyType: "schedule",
        rowId, spec, initialBalance, chain: profile.name,
      }),
    );
    return;
  }
  console.log(renderResultText({ result, series, baseSymbol, quoteSymbol, strategyType: "schedule", rowId }));
}

// ── list ─────────────────────────────────────────────────────

export async function backtestListCommand(flags: Record<string, string>) {
  const strategyType = flags["strategy-type"];
  if (strategyType != null && strategyType !== "order" && strategyType !== "schedule") {
    throw new ToolError("INVALID_PARAMS", `--strategy-type must be 'order' or 'schedule' (got "${strategyType}").`);
  }
  const limit = parseIntFlag(flags["limit"], "--limit", { min: 1, max: 1000 }) ?? 50;
  const rows = listBacktestRuns({
    strategyType: strategyType as BacktestStrategyType | undefined,
    chain: flags["chain"],
    limit,
  });

  if (flags["json"] != null) {
    printJson({ ok: true, runs: rows });
    return;
  }
  if (rows.length === 0) {
    console.log(`No backtest runs yet. Try \`tradekit backtest order --help\` to get started.`);
    return;
  }
  const lines: string[] = [];
  lines.push(`ID    TYPE      CHAIN      PAIR             FIRES   PNL          HOLD-PNL     WHEN`);
  for (const r of rows) {
    const pair = `${r.base_symbol}/${r.quote_symbol}`;
    const pnl = fmtSignedUsd(r.pnl_usd).padStart(11);
    const hold = fmtSignedUsd(r.hold_pnl_usd).padStart(11);
    const age = formatRelativeAge(r.created_at);
    lines.push(
      `${String(r.id).padStart(4)}  ${r.strategy_type.padEnd(8)}  ${r.chain.padEnd(9)}  ${pair.padEnd(15)}  ${String(r.fire_count).padStart(5)}   ${pnl}  ${hold}  ${age}`,
    );
  }
  console.log(lines.join("\n"));
}

// ── show ─────────────────────────────────────────────────────

export async function backtestShowCommand(flags: Record<string, string>, positional: string[]) {
  // positional[0] = "backtest", [1] = "show", [2] = id — same convention as
  // the other multi-action commands (order show, schedule show, etc.).
  const idArg = positional[2];
  if (!idArg) throw new ToolError("INVALID_PARAMS", `Usage: tradekit backtest show <id>`);
  const id = parseInt(idArg, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `<id> must be a positive integer (got "${idArg}").`);
  }
  const row = getBacktestRunById(id);
  if (!row) throw new ToolError("INVALID_PARAMS", `No backtest run with id ${id}.`);

  if (flags["json"] != null) {
    printJson({ ok: true, run: hydrateRow(row) });
    return;
  }
  console.log(renderRowText(row));
}

function hydrateRow(row: BacktestRunRow) {
  return {
    id: row.id,
    strategy_type: row.strategy_type,
    chain: row.chain,
    base_symbol: row.base_symbol,
    quote_symbol: row.quote_symbol,
    spec: JSON.parse(row.spec_json),
    initial_balance: JSON.parse(row.initial_balance_json),
    final_balance: JSON.parse(row.final_balance_json),
    window_start: row.window_start,
    window_end: row.window_end,
    points: row.points,
    fires: JSON.parse(row.fires_json),
    fire_count: row.fire_count,
    pnl_usd: row.pnl_usd,
    hold_pnl_usd: row.hold_pnl_usd,
    notes: row.notes,
    created_at: row.created_at,
  };
}

function renderRowText(row: BacktestRunRow): string {
  const lines: string[] = [];
  lines.push(`Backtest #${row.id} (${row.strategy_type})`);
  lines.push(`  Chain:         ${row.chain}`);
  lines.push(`  Pair:          ${row.base_symbol}/${row.quote_symbol}`);
  lines.push(`  Created:       ${row.created_at}`);
  lines.push(`  Window:        ${row.window_start} → ${row.window_end}`);
  lines.push(`  Datapoints:    ${row.points}`);
  lines.push("");
  lines.push(`  Spec:          ${row.spec_json}`);
  lines.push(`  Initial bal:   ${row.initial_balance_json}`);
  lines.push(`  Final bal:     ${row.final_balance_json}`);
  lines.push("");
  lines.push(`  Strategy PnL:  ${fmtSignedUsd(row.pnl_usd)}`);
  lines.push(`  Hold PnL:      ${fmtSignedUsd(row.hold_pnl_usd)}`);
  const diff = row.pnl_usd - row.hold_pnl_usd;
  const verb = diff >= 0 ? "outperformed" : "underperformed";
  lines.push(`  Vs hold:       ${verb} by ${fmtSignedUsd(diff)}`);
  if (row.notes) {
    lines.push(`  Notes:         ${row.notes}`);
  }
  const fires = JSON.parse(row.fires_json) as Array<{ ts: string; action: string; priceUsd: number; note?: string }>;
  if (fires.length === 0) {
    lines.push("");
    lines.push(`  No fires.`);
  } else {
    lines.push("");
    lines.push(`  Fires (${fires.length}):`);
    for (const f of fires) {
      const marker = f.action === "fill" ? "●" : "✕";
      lines.push(`    ${marker} ${f.ts}  $${fmt(f.priceUsd, 2)}  ${f.note ?? ""}`);
    }
  }
  return lines.join("\n");
}

function formatRelativeAge(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ── playbook backtest ────────────────────────────────────────

/**
 * Replay a full playbook spec (multiple orders + schedules) against a
 * shared price series. The simulator validates that all primitives
 * reference the same base/quote pair; multi-asset playbooks (or
 * playbooks containing rebalance plans) fail upfront with a clear
 * pointer at the single-strategy `backtest order` / `backtest schedule`
 * commands as fallback.
 */
export async function backtestPlaybookCommand(flags: Record<string, string>, positional: string[]) {
  const filePath = positional[2];
  if (!filePath) throw new ToolError("INVALID_PARAMS", `Usage: tradekit backtest playbook <file>`);
  // Iter21: route through the shared template-aware reader so backtest
  // accepts the same --var / --vars-file flags as `playbook deploy`.
  // Operators backtest the SAME template they'll later deploy; using a
  // different reader here would mean different errors / different
  // variable resolution behavior.
  const { readAndRenderPlaybookFile } = await import("./playbooks.js");
  const { rendered, absolutePath, template } = readAndRenderPlaybookFile({ filePath, flags });
  const spec = parsePlaybookSpec(rendered);
  if (template && template.warnings.length > 0 && flags["json"] !== "true") {
    for (const w of template.warnings) {
      console.log(`⚠ ${w}`);
    }
  }

  // Backtest-specific knobs (chain / base / quote can be overridden via
  // flags so the operator doesn't have to bake them into the playbook
  // file for backtest runs).
  const config = loadConfig();
  const chainName = flags["chain"] ?? spec.chain ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  const baseInput = flags["base"] ?? inferSharedBase(spec);
  const quoteInput = flags["quote"] ?? inferSharedQuote(spec);
  if (!baseInput || !quoteInput) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Could not infer base/quote from the playbook (mixed strategies?). Pass --base and --quote explicitly.`,
    );
  }
  const pair = resolveTradePair(profile, baseInput, quoteInput);
  const baseAddrForPrice = pair.base === "ETH" ? profile.weth : pair.base;
  if (!baseAddrForPrice) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Cannot resolve a price address for ${baseInput} on ${profile.name} — missing WETH config.`,
    );
  }

  const baseSymbol = baseInput.toUpperCase();
  const quoteSymbol = quoteInput.toUpperCase();

  const initialBalance = parseBalance(flags["balance"]);
  const since = flags["since"] ?? "30d";
  const days = parseSinceDuration(since);

  const series = await fetchPriceSeries(baseAddrForPrice, days);
  if (!series) {
    throw new ToolError(
      "UNKNOWN_TOKEN",
      `Playbook backtest requires a CoinGecko-listed base token. "${baseInput}" on chain "${profile.name}" isn't in the mapping.`,
    );
  }

  const result = simulatePlaybook({
    spec,
    baseSymbol,
    quoteSymbol,
    initialBalance,
    series,
  });

  // Persist into backtest_runs as strategy_type='playbook'.
  const rowId = insertBacktestRun({
    strategyType: "playbook",
    chain: profile.name,
    baseSymbol,
    quoteSymbol,
    specJson: JSON.stringify(spec),
    initialBalanceJson: JSON.stringify(initialBalance),
    finalBalanceJson: JSON.stringify(result.finalBalance),
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
    points: series.points.length,
    firesJson: JSON.stringify(result.fires),
    fireCount: result.fires.filter((f) => f.multiAction === "fill").length,
    pnlUsd: result.pnlUsd,
    holdPnlUsd: result.holdPnlUsd,
    notes: result.notes.join("; ") || null,
  });

  if (flags["json"] != null) {
    printJson({
      ok: true,
      id: rowId,
      strategy_type: "playbook",
      chain: profile.name,
      base_symbol: baseSymbol,
      quote_symbol: quoteSymbol,
      spec,
      initial_balance: initialBalance,
      final_balance: result.finalBalance,
      window_start: result.windowStart,
      window_end: result.windowEnd,
      coingecko_id: series.coinId,
      points: series.points.length,
      initial_usd: result.initialUsd,
      final_usd: result.finalUsd,
      pnl_usd: result.pnlUsd,
      hold_pnl_usd: result.holdPnlUsd,
      hold_final_usd: result.holdFinalUsd,
      fires: result.fires,
      per_strategy: result.perStrategy,
      notes: result.notes,
    });
    return;
  }
  console.log(renderPlaybookResult({ result, series, baseSymbol, quoteSymbol, rowId, spec }));
}

function inferSharedBase(spec: PlaybookSpec): string | undefined {
  const orderSchedule = spec.strategies.filter((s) => s.type === "order" || s.type === "schedule");
  if (orderSchedule.length === 0) return undefined;
  const first = orderSchedule[0] as { base: string };
  return first.base;
}

function inferSharedQuote(spec: PlaybookSpec): string | undefined {
  const orderSchedule = spec.strategies.filter((s) => s.type === "order" || s.type === "schedule");
  if (orderSchedule.length === 0) return undefined;
  const first = orderSchedule[0] as { quote: string };
  return first.quote;
}

function renderPlaybookResult(args: {
  result: PlaybookBacktestResult;
  series: PriceSeries;
  baseSymbol: string;
  quoteSymbol: string;
  rowId: number;
  spec: PlaybookSpec;
}): string {
  const { result, series, baseSymbol, quoteSymbol, rowId, spec } = args;
  const lines: string[] = [];
  lines.push(`Playbook backtest #${rowId} "${spec.name}"`);
  lines.push(`  Window:        ${result.windowStart} → ${result.windowEnd}`);
  lines.push(`  Datapoints:    ${series.points.length} (CoinGecko ${series.coinId}, ${series.daysRequested}d)`);
  lines.push(`  Pair:          ${baseSymbol}/${quoteSymbol}`);
  lines.push(``);
  lines.push(`  Initial USD:   $${result.initialUsd.toFixed(2)}`);
  lines.push(`  Final USD:     $${result.finalUsd.toFixed(2)}`);
  lines.push(`  Strategy PnL:  ${fmtSignedUsd(result.pnlUsd)}`);
  lines.push(`  Hold PnL:      ${fmtSignedUsd(result.holdPnlUsd)}`);
  const diff = result.pnlUsd - result.holdPnlUsd;
  const verb = diff >= 0 ? "outperformed" : "underperformed";
  lines.push(`  Vs hold:       ${verb} by ${fmtSignedUsd(diff)}`);
  lines.push(``);
  lines.push(`  Final balance:`);
  for (const [sym, amt] of Object.entries(result.finalBalance)) {
    lines.push(`    ${sym.padEnd(8)} ${fmt(amt)}`);
  }
  lines.push(``);
  lines.push(`  Per strategy:`);
  for (const s of result.perStrategy) {
    const statusMarker = s.finalStatus === "filled" || s.finalStatus === "completed" ? "●" :
      s.finalStatus === "cancelled" ? "✕" : "○";
    const delta = s.type === "order"
      ? `base ${fmtSigned(s.baseDelta)} / quote ${fmtSigned(s.quoteDelta)}`
      : `${s.fireCount}× fires / base ${fmtSigned(s.baseDelta)} / quote ${fmtSigned(s.quoteDelta)}`;
    lines.push(`    ${statusMarker} ${s.strategyId.padEnd(16)} [${s.finalStatus.padEnd(10)}] ${s.type.padEnd(8)} ${delta}`);
  }
  const fillFires = result.fires.filter((f) => f.multiAction === "fill");
  const cascadeFires = result.fires.filter((f) => f.multiAction === "oco_cascade");
  if (fillFires.length === 0) {
    lines.push(``);
    lines.push(`  No fires.`);
  } else {
    lines.push(``);
    lines.push(`  Fires (${fillFires.length} fill, ${cascadeFires.length} OCO cascade):`);
    for (const f of result.fires) {
      const marker = f.multiAction === "fill" ? "●" : f.multiAction === "oco_cascade" ? "↪" : "✕";
      const tag = f.strategyId.padEnd(12);
      lines.push(`    ${marker} ${f.ts}  ${tag}  $${fmt(f.priceUsd, 2)}  ${f.note ?? ""}`);
    }
  }
  if (result.notes.length) {
    lines.push(``);
    lines.push(`  Notes:`);
    for (const n of result.notes) lines.push(`    - ${n}`);
  }
  return lines.join("\n");
}

function fmtSigned(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const s = n >= 0 ? "+" : "";
  return s + fmt(n);
}

// ── compare ──────────────────────────────────────────────────

/**
 * `backtest compare <scenarios.json>` — runs N scenarios against one
 * shared price series + balance.
 * `backtest compare list` — recent comparisons.
 * `backtest compare show <id>` — re-render a stored comparison without
 * re-fetching CoinGecko data.
 *
 * The sub-action is positional[2]: "list" / "show" route to inspection;
 * anything else is treated as a scenarios file path.
 */
export async function backtestCompareCommand(flags: Record<string, string>, positional: string[]) {
  const arg = positional[2];
  if (arg === "list") {
    await backtestCompareListCommand(flags);
    return;
  }
  if (arg === "show") {
    await backtestCompareShowCommand(flags, positional);
    return;
  }
  if (!arg) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Usage: tradekit backtest compare <scenarios.json> | tradekit backtest compare list | tradekit backtest compare show <id>`,
    );
  }
  await backtestCompareRunCommand(flags, arg);
}

async function backtestCompareRunCommand(flags: Record<string, string>, scenariosPath: string) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);

  // Probe scenarios to figure out the shared base symbol so we can
  // resolve the on-chain address for CoinGecko mapping. The shared-
  // pair invariant gets enforced inside prepareScenarios; we re-prep
  // here just to learn the symbol.
  const { readFileSync } = await import("node:fs");
  const { resolve: resolvePathFn, dirname: pathDirnameFn } = await import("node:path");
  const absScenarios = resolvePathFn(scenariosPath);
  let scenariosText: string;
  try {
    scenariosText = readFileSync(absScenarios, "utf8");
  } catch (e) {
    throw new ToolError("INVALID_PARAMS", `Cannot read scenarios file "${scenariosPath}": ${(e as Error).message}`);
  }
  let rawScenarios: unknown;
  try {
    rawScenarios = JSON.parse(scenariosText);
  } catch (e) {
    throw new ToolError("INVALID_PARAMS", `Scenarios file is not valid JSON: ${(e as Error).message}`);
  }
  const { parseScenariosFile, prepareScenarios, runCompareFromFile, renderComparison } = await import("../backtestCompare.js");
  const scenariosFile = parseScenariosFile(rawScenarios);
  const scenariosFileDir = pathDirnameFn(absScenarios);
  const { baseSymbol, quoteSymbol } = prepareScenarios({ scenariosFile, scenariosFileDir });

  // Resolve base symbol → on-chain address → CoinGecko mapping.
  const pair = resolveTradePair(profile, baseSymbol, quoteSymbol);
  const baseAddrForPrice = pair.base === "ETH" ? profile.weth : pair.base;
  if (!baseAddrForPrice) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Cannot resolve a price address for ${baseSymbol} on ${profile.name} — missing WETH config.`,
    );
  }

  const initialBalance = parseBalance(flags["balance"]);
  const since = flags["since"] ?? "30d";

  const outcome = await runCompareFromFile({
    scenariosPath: absScenarios,
    initialBalance,
    since,
    chain: profile.name,
    baseAddress: baseAddrForPrice,
  });

  if (flags["json"] != null) {
    printJson({
      ok: true,
      comparison_id: outcome.comparisonId,
      name: outcome.name,
      chain: outcome.chain,
      base_symbol: outcome.baseSymbol,
      quote_symbol: outcome.quoteSymbol,
      window_start: outcome.windowStart,
      window_end: outcome.windowEnd,
      points: outcome.points,
      winner_idx: outcome.winnerIdx,
      scenarios: outcome.scenarios,
    });
    return;
  }
  console.log(renderComparison(outcome));
}

async function backtestCompareListCommand(flags: Record<string, string>) {
  const { listBacktestComparisons } = await import("../db.js");
  const limit = parseIntFlag(flags["limit"], "--limit", { min: 1, max: 1000 }) ?? 50;
  const rows = listBacktestComparisons({ chain: flags["chain"], limit });

  if (flags["json"] != null) {
    printJson({ ok: true, comparisons: rows });
    return;
  }
  if (rows.length === 0) {
    console.log(`No backtest comparisons yet. Try \`tradekit backtest compare <scenarios.json>\`.`);
    return;
  }
  console.log(`ID    NAME                                    CHAIN      PAIR             SCENARIOS  WINNER  WHEN`);
  for (const r of rows) {
    const results = JSON.parse(r.results_json) as Array<{ scenarioName: string; pnlUsd: number }>;
    const winner = r.winner_idx != null && results[r.winner_idx]
      ? `${results[r.winner_idx].scenarioName} (${results[r.winner_idx].pnlUsd >= 0 ? "+" : ""}$${results[r.winner_idx].pnlUsd.toFixed(2)})`
      : "—";
    const name = r.name.length > 38 ? r.name.slice(0, 35) + "…" : r.name.padEnd(38);
    const pair = `${r.base_symbol}/${r.quote_symbol}`;
    const age = formatRelativeAge(r.created_at);
    const winnerCol = winner.length > 22 ? winner.slice(0, 19) + "…" : winner.padEnd(22);
    console.log(`${String(r.id).padStart(4)}  ${name}  ${r.chain.padEnd(9)}  ${pair.padEnd(15)}  ${String(results.length).padStart(9)}  ${winnerCol}  ${age}`);
  }
}

async function backtestCompareShowCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[3];
  if (!idArg) throw new ToolError("INVALID_PARAMS", `Usage: tradekit backtest compare show <id>`);
  const id = parseInt(idArg, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `<id> must be a positive integer (got "${idArg}").`);
  }
  const { getBacktestComparisonById } = await import("../db.js");
  const { renderComparison } = await import("../backtestCompare.js");
  const row = getBacktestComparisonById(id);
  if (!row) throw new ToolError("INVALID_PARAMS", `No comparison with id ${id}.`);

  const results = JSON.parse(row.results_json) as import("../backtestCompare.js").ScenarioResult[];
  const outcome = {
    comparisonId: row.id,
    name: row.name,
    chain: row.chain,
    baseSymbol: row.base_symbol,
    quoteSymbol: row.quote_symbol,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    points: 0, // not stored on the comparison row
    scenarios: results,
    winnerIdx: row.winner_idx,
  };

  if (flags["json"] != null) {
    printJson({
      ok: true,
      comparison: row,
      scenarios: JSON.parse(row.scenarios_json),
      results,
    });
    return;
  }
  console.log(renderComparison(outcome));
  console.log(``);
  console.log(`Created:  ${row.created_at}`);
  console.log(`Runs:     ${row.run_ids}  (use \`tradekit backtest show <id>\` for per-scenario detail)`);
}

// ── dispatch ─────────────────────────────────────────────────

export async function backtestCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  switch (action) {
    case "order":
      await backtestOrderCommand(flags);
      break;
    case "schedule":
      await backtestScheduleCommand(flags);
      break;
    case "playbook":
      await backtestPlaybookCommand(flags, positional);
      break;
    case "compare":
      await backtestCompareCommand(flags, positional);
      break;
    case "list":
      await backtestListCommand(flags);
      break;
    case "show":
      await backtestShowCommand(flags, positional);
      break;
    default:
      throw subcommandError("backtest", action, ["order", "schedule", "playbook", "compare", "list", "show"]);
  }
}
