// MCP strategy tools: playbook lifecycle (validate / deploy / list /
// show / diff / replace / destroy) + backtest surface (order /
// playbook / compare).
//
// Composes the iter17 / iter18 / iter21 / iter22 features into an
// agent-callable interface. Operators using tradekit through an MCP
// client (Claude Desktop, Cursor, custom agent) get the full strategy
// lifecycle — pre-iter26 these were CLI-only.

import { z } from "zod";
import { ToolError, toToolError } from "../errors.js";
import { ok, fail, runTool, type RegisterFn } from "./runtime.js";
import {
  parsePlaybookSpec,
  deployPlaybook,
  destroyPlaybook,
  getPlaybookDetail,
} from "../playbooks.js";
import {
  isTemplate,
  parseTemplateVars,
  resolveVars,
  renderTemplate,
  type VarValue,
} from "../playbookTemplate.js";
import { computePlaybookDiff, replacePlaybook } from "../playbookReplace.js";
import { listPlaybooks, getPlaybookById } from "../db.js";
import { loadConfig, resolveProfile } from "../config.js";
import { resolveTradePair } from "../chains.js";
import {
  simulateOrder,
  simulateSchedule,
  simulatePlaybook,
  fetchPriceSeries,
  parseSinceDuration,
  type SymbolBalance,
} from "../backtest.js";
import {
  insertBacktestRun,
} from "../db.js";
import {
  parseScenariosFile,
  runCompareFromFile,
} from "../backtestCompare.js";

// ── shared shapes ────────────────────────────────────────────

/** Variable bag for template rendering. Accepts JSON primitives
 *  directly — agents don't have to stringify numbers. */
const varsShape = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe("Template variables (NAME → value). Override declared defaults; ignored when the spec isn't a template.");

const playbookSpecShape = z
  .union([
    z
      .object({})
      .passthrough()
      .describe("Inline playbook spec object — matches the JSON file shape (name, chain, account, strategies[], optional vars)."),
    z.unknown(),
  ])
  .describe("Playbook spec as a JSON object. Templates supported: any `{{var}}` placeholders are rendered against `vars` before validation.");

/** Render + parse — pass-through for non-templates, renderTemplate
 *  for templates with var coercion. Mirrors the CLI's
 *  readAndRenderPlaybookFile helper but takes a JSON object instead
 *  of a file path. */
function renderAndParse(raw: unknown, provided: Record<string, VarValue> | undefined) {
  if (!isTemplate(raw)) {
    if (provided && Object.keys(provided).length > 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `vars supplied but the spec has no template variables. Remove vars or convert the spec to a template.`,
      );
    }
    return parsePlaybookSpec(raw);
  }
  const obj = raw as Record<string, unknown>;
  const declarations = obj.vars != null ? parseTemplateVars(obj.vars) : {};
  const { resolved } = resolveVars({ declared: declarations, provided: provided ?? {} });
  const rendered = renderTemplate({ spec: raw, vars: resolved });
  return parsePlaybookSpec(rendered);
}

// ── tool registration ───────────────────────────────────────

export const registerStrategyTools: RegisterFn = (server, rt) => {
  // ── playbook_validate ──────────────────────────────────────
  server.tool(
    "playbook_validate",
    "Parse + structurally validate a playbook spec WITHOUT touching the database. Returns the rendered+parsed spec for inspection. Useful pre-deploy validation in CI / agent dry-runs. Templates supported via `vars`. Errors: INVALID_PARAMS (every validation error collected into one message with JSON path → fix all at once).",
    {
      spec: playbookSpecShape,
      vars: varsShape,
    },
    async ({ spec, vars }) => {
      try {
        return ok(
          await runTool("playbook_validate", rt.opts, { spec, vars }, undefined, async () => {
            const parsed = renderAndParse(spec, vars as Record<string, VarValue> | undefined);
            return {
              ok: true,
              name: parsed.name,
              strategy_count: parsed.strategies.length,
              spec: parsed,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── playbook_deploy ────────────────────────────────────────
  server.tool(
    "playbook_deploy",
    "Atomically deploy a playbook spec → creates orders / schedules / rebalance plans transactionally. Any per-primitive failure rolls back the whole bundle and deletes the playbook row. Idempotent on spec hash (same hash + same name = no-op returning the existing id). `paper: true` cascades to EVERY primitive in the spec — the whole strategy fires against the virtual book (seed it with paper_deposit first), no real trades, no keystore. Errors: INVALID_PARAMS (spec validation failure; same-name-different-hash conflict — message names the existing id and `tradekit playbook destroy` to clear).",
    {
      spec: playbookSpecShape,
      vars: varsShape,
      paper: z.boolean().optional().describe("Deploy in paper mode: every order/schedule/rebalance fires against the virtual book instead of trading. The full dry-run loop — pair with paper_balances / paper_trades / paper_pnl."),
    },
    async ({ spec, vars, paper }) => {
      try {
        return ok(
          await runTool("playbook_deploy", rt.opts, { spec, vars, paper }, undefined, async () => {
            const parsed = renderAndParse(spec, vars as Record<string, VarValue> | undefined);
            const result = deployPlaybook({ spec: parsed, sourcePath: null, ...(paper === true ? { paper: true } : {}) });
            return {
              ok: true,
              playbook_id: result.playbookId,
              already_deployed: result.alreadyDeployed,
              paper: paper === true,
              items: result.items,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── playbook_diff ──────────────────────────────────────────
  server.tool(
    "playbook_diff",
    "Read-only preview of what playbook_replace would change: compares a deployed playbook's spec against a new spec WITHOUT touching state. Each primitive lands in one of four buckets (unchanged / modified / added / removed); modified entries carry field-level changes plus an `applyMode` — 'edit' (applied IN PLACE on replace: trailing HWM, run counters, journal continuity all preserved) or 'recreate' (cancel + create; `recreateReason` names the frozen field that forced it — OCO group, chain, account, schedule startAt/name; rebalance plans always recreate but carry run counters). `willResetTrailingHwm: true` warns that a modified trailing order must be recreated and loses its high-water mark. Templates supported via `vars`. Returns { ok, diff: { oldHash, newHash, noChanges, entries[], summary, willResetTrailingHwm } }. Errors: INVALID_PARAMS (id not found, playbook not deployed, spec validation failure).",
    {
      id: z.number().int().positive().describe("Deployed playbook id (from playbook_list)."),
      spec: playbookSpecShape,
      vars: varsShape,
    },
    async ({ id, spec, vars }) => {
      try {
        return ok(
          await runTool("playbook_diff", rt.opts, { id, spec, vars }, undefined, async () => {
            const row = getPlaybookById(id);
            if (!row) throw new ToolError("INVALID_PARAMS", `No playbook with id ${id}.`);
            if (row.status !== "deployed") {
              throw new ToolError("INVALID_PARAMS", `Playbook #${id} is "${row.status}" — diff requires a deployed playbook.`);
            }
            const newSpec = renderAndParse(spec, vars as Record<string, VarValue> | undefined);
            const oldSpec = parsePlaybookSpec(JSON.parse(row.spec_json));
            const diff = computePlaybookDiff({ oldSpec, newSpec, playbookId: id });
            return { ok: true, diff };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── playbook_replace ───────────────────────────────────────
  server.tool(
    "playbook_replace",
    "Atomically apply a new spec to a deployed playbook — the strategy-iteration path (vs destroy+deploy, which loses ALL running state). Modified primitives whose changes are in-place editable (price, trailPct, amounts, slippage, expiry/endAt, maxRuns, cadence, note) are EDITED via the same machinery as order_edit/schedule_edit: same row id, trailing HWM, run_count/max_runs accounting, and journal continuity survive. Frozen-field changes (OCO group, chain, account, schedule startAt/name) force cancel+recreate; recreated schedules/rebalance plans still carry their run counters. Pre-validates EVERYTHING before cancelling anything, so a defective spec can't leave partial state. Paper-ness is inferred from the playbook's owned rows (replacing a paper deployment stays paper) — override with `paper`. `preserve_state: false` recreates every modified primitive with fresh state (HWM + counters reset). Returns { ok, no_changes } when specs are identical (nothing touched), else { ok, diff, edited[], cancelled[], created[], paper, oldHash, newHash }. Destructive (cancels primitives); requires `yes: true`. Preview first with playbook_diff. Errors: INVALID_PARAMS (id not found, not deployed, spec/edit validation failure, yes missing).",
    {
      id: z.number().int().positive().describe("Deployed playbook id to replace."),
      spec: playbookSpecShape,
      vars: varsShape,
      preserve_state: z.boolean().optional().describe("Default true: edit-in-place where possible + carry run counters on recreate. false = v1 behavior, recreate everything with fresh state."),
      paper: z.boolean().optional().describe("Override paper inference for recreated/added primitives. Omit to inherit the deployment's paper-ness from its owned rows."),
      yes: z.literal(true).describe("Confirmation flag — replace cancels primitives; must be `true`."),
    },
    async ({ id, spec, vars, preserve_state, paper, yes }) => {
      try {
        return ok(
          await runTool("playbook_replace", rt.opts, { id, spec, vars, preserve_state, paper, yes }, undefined, async () => {
            if (yes !== true) {
              throw new ToolError("INVALID_PARAMS", `Confirmation flag required: pass yes=true.`);
            }
            const row = getPlaybookById(id);
            if (!row) throw new ToolError("INVALID_PARAMS", `No playbook with id ${id}.`);
            if (row.status !== "deployed") {
              throw new ToolError("INVALID_PARAMS", `Playbook #${id} is "${row.status}" — replace requires a deployed playbook.`);
            }
            const newSpec = renderAndParse(spec, vars as Record<string, VarValue> | undefined);
            // Mirror the CLI: identical specs are a read-only no-op —
            // don't touch the playbook row (deployed_at would bump).
            const oldSpec = parsePlaybookSpec(JSON.parse(row.spec_json));
            const preview = computePlaybookDiff({ oldSpec, newSpec, playbookId: id });
            if (preview.noChanges) {
              return { ok: true, no_changes: true };
            }
            const result = replacePlaybook({
              playbookId: id,
              newSpec,
              newSourcePath: null,
              ...(preserve_state === false ? { preserveState: false } : {}),
              ...(paper != null ? { paper } : {}),
            });
            return {
              ok: true,
              no_changes: false,
              diff: result.diff,
              edited: result.edited,
              cancelled: result.cancelled,
              created: result.created,
              paper: result.paper,
              oldHash: result.oldHash,
              newHash: result.newHash,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── playbook_list ──────────────────────────────────────────
  server.tool(
    "playbook_list",
    "List deployed playbooks. Default status=deployed; use 'all' to see destroyed/failed too. Returns id, name, status, source_hash, deployed_at, destroyed_at. Read-only, fast (single indexed SELECT).",
    {
      status: z.enum(["all", "deploying", "deployed", "destroyed", "failed"]).optional().describe("Status filter; default 'deployed'."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max rows; default 100."),
    },
    async ({ status, limit }) => {
      try {
        return ok(
          await runTool("playbook_list", rt.opts, { status, limit }, undefined, async () => {
            const rows = listPlaybooks({
              status: status ?? "deployed",
              limit: limit ?? 100,
            });
            return { ok: true, playbooks: rows };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── playbook_show ──────────────────────────────────────────
  server.tool(
    "playbook_show",
    "Full detail for a playbook: row metadata + every owned primitive (orders / schedules / rebalance plans) with current status. Errors: INVALID_PARAMS (id not found).",
    {
      id: z.number().int().positive().describe("Playbook id from `playbook_list` or `playbook_deploy`."),
    },
    async ({ id }) => {
      try {
        return ok(
          await runTool("playbook_show", rt.opts, { id }, undefined, async () => {
            const detail = getPlaybookDetail(id);
            return {
              ok: true,
              playbook: detail.row,
              spec: detail.spec,
              primitives: {
                orders: detail.orders,
                schedules: detail.schedules,
                rebalances: detail.rebalances,
              },
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── playbook_destroy ───────────────────────────────────────
  server.tool(
    "playbook_destroy",
    "Tear down a deployed playbook: cancels every ACTIVE owned primitive (orders / schedules / rebalance plans), marks playbook destroyed. Already-terminal primitives (filled / expired / cancelled / completed) are reported in `alreadyTerminal[]` and left alone. Per-row cancel errors collect in `errors[]` without aborting the rest. Destructive; requires `yes: true`. Errors: INVALID_PARAMS (id not found; yes flag missing).",
    {
      id: z.number().int().positive().describe("Playbook id to tear down."),
      yes: z.literal(true).describe("Confirmation flag — destroy is destructive; must be `true`."),
    },
    async ({ id, yes }) => {
      try {
        return ok(
          await runTool("playbook_destroy", rt.opts, { id, yes }, undefined, async () => {
            if (!yes) {
              throw new ToolError("INVALID_PARAMS", `Confirmation flag required: pass yes=true.`);
            }
            const result = destroyPlaybook(id);
            return { ok: true, ...result };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── backtest_order ─────────────────────────────────────────
  server.tool(
    "backtest_order",
    "Replay a single order spec (price_below / price_above / trailing) against a CoinGecko price series. Returns the simulated fire timeline + PnL + vs-hold counterfactual. CoinGecko resolution: ≤1 day → 5-min, ≤90 days → hourly, >90 days → daily. Persists a row in backtest_runs for later retrieval via `backtest_show`. Errors: INVALID_PARAMS (spec validation); UNKNOWN_TOKEN (base not CoinGecko-listed).",
    {
      side: z.enum(["buy", "sell"]).describe("Trade direction."),
      trigger: z.enum(["price_below", "price_above", "trailing"]).describe("Trigger type."),
      price: z.number().positive().optional().describe("Required for price_below/price_above (USD trigger); optional activation gate for trailing."),
      trail_pct: z.number().positive().max(100).optional().describe("Required for trailing — % retracement that triggers the fill."),
      base: z.string().describe("Base token symbol or address (must be CoinGecko-listed)."),
      quote: z.string().describe("Quote token symbol or address."),
      base_amount: z.number().positive().optional().describe("Base amount for the trade (sell-side or buy-fixed-base)."),
      quote_amount: z.number().positive().optional().describe("Quote amount for the trade (buy-fixed-quote)."),
      balance: z.record(z.string(), z.number().nonnegative()).describe("Starting balance as { SYMBOL: amount } (e.g. { ETH: 1.0, USDC: 3000 })."),
      since: z.string().default("30d").describe("Window — '30d', '7d', '6m', or a bare integer (days). Max 3650 days."),
      chain: z.string().optional().describe("Chain (default: active chain)."),
    },
    async ({ side, trigger, price, trail_pct, base, quote, base_amount, quote_amount, balance, since, chain }) => {
      try {
        return ok(
          await runTool("backtest_order", rt.opts, { side, trigger, price, trail_pct, base, quote, base_amount, quote_amount, balance, since, chain }, chain, async () => {
            const config = rt.getConfig();
            const chainName = chain ?? config.activeChain;
            const profile = resolveProfile(chainName, config);
            const pair = resolveTradePair(profile, base, quote);
            const baseAddrForPrice = pair.base === "ETH" ? profile.weth : pair.base;
            if (!baseAddrForPrice) {
              throw new ToolError("INVALID_PARAMS", `Cannot resolve a price address for ${base} on ${profile.name}.`);
            }
            const days = parseSinceDuration(since);
            const series = await fetchPriceSeries(baseAddrForPrice, days);
            if (!series) {
              throw new ToolError("UNKNOWN_TOKEN", `Backtest requires a CoinGecko-listed base token. "${base}" on chain "${profile.name}" isn't in the mapping.`);
            }
            const baseSymbol = base.toUpperCase() === "ETH" ? "ETH" : base.toUpperCase();
            const quoteSymbol = quote.toUpperCase();
            const initialBalance: SymbolBalance = Object.fromEntries(
              Object.entries(balance).map(([k, v]) => [k.toUpperCase(), v]),
            );
            const result = simulateOrder({
              spec: {
                side, trigger,
                targetPriceUsd: price,
                trailPct: trail_pct,
                baseAmount: base_amount,
                quoteAmount: quote_amount,
              },
              baseSymbol, quoteSymbol, initialBalance, series,
            });
            const rowId = insertBacktestRun({
              strategyType: "order",
              chain: profile.name,
              baseSymbol, quoteSymbol,
              specJson: JSON.stringify({ side, trigger, price, trail_pct, base_amount, quote_amount }),
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
            return {
              ok: true,
              id: rowId,
              base_symbol: baseSymbol, quote_symbol: quoteSymbol,
              window_start: result.windowStart, window_end: result.windowEnd,
              points: series.points.length,
              initial_usd: result.initialUsd, final_usd: result.finalUsd,
              pnl_usd: result.pnlUsd, hold_pnl_usd: result.holdPnlUsd,
              fires: result.fires, notes: result.notes,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── backtest_playbook ──────────────────────────────────────
  server.tool(
    "backtest_playbook",
    "Replay a full playbook spec (multiple orders + schedules) against a SHARED price series with a FRESH balance copy per strategy. OCO cascade fires during simulation. Same-pair invariant enforced — every order/schedule must reference the same base/quote (use single-strategy backtest_order/backtest_schedule for multi-pair). Rebalance plans rejected (intrinsically multi-asset). Templates supported via `vars`. Persists a row in backtest_runs as strategy_type='playbook'.",
    {
      spec: playbookSpecShape,
      vars: varsShape,
      balance: z.record(z.string(), z.number().nonnegative()).describe("Starting balance { SYMBOL: amount }; identical to backtest_order."),
      since: z.string().default("30d").describe("Window — '30d', '7d', '6m', '<N>' (bare days)."),
      chain: z.string().optional().describe("Chain (default: spec.chain or active chain)."),
      base: z.string().optional().describe("Override base symbol; default inferred from the playbook's first non-rebalance strategy."),
      quote: z.string().optional().describe("Override quote symbol; default inferred from the playbook's first non-rebalance strategy."),
    },
    async ({ spec, vars, balance, since, chain, base, quote }) => {
      try {
        return ok(
          await runTool("backtest_playbook", rt.opts, { spec, vars, balance, since, chain, base, quote }, chain, async () => {
            const parsed = renderAndParse(spec, vars as Record<string, VarValue> | undefined);
            const config = rt.getConfig();
            const chainName = chain ?? parsed.chain ?? config.activeChain;
            const profile = resolveProfile(chainName, config);
            // Infer base/quote from first non-rebalance strategy when not overridden.
            const firstTradeable = parsed.strategies.find((s) => s.type === "order" || s.type === "schedule");
            if (!firstTradeable) {
              throw new ToolError("INVALID_PARAMS", `Playbook has no order or schedule strategies to backtest.`);
            }
            const baseInput = base ?? (firstTradeable as { base: string }).base;
            const quoteInput = quote ?? (firstTradeable as { quote: string }).quote;
            const pair = resolveTradePair(profile, baseInput, quoteInput);
            const baseAddrForPrice = pair.base === "ETH" ? profile.weth : pair.base;
            if (!baseAddrForPrice) {
              throw new ToolError("INVALID_PARAMS", `Cannot resolve a price address for ${baseInput} on ${profile.name}.`);
            }
            const days = parseSinceDuration(since);
            const series = await fetchPriceSeries(baseAddrForPrice, days);
            if (!series) {
              throw new ToolError("UNKNOWN_TOKEN", `Backtest requires a CoinGecko-listed base token.`);
            }
            const baseSymbol = baseInput.toUpperCase();
            const quoteSymbol = quoteInput.toUpperCase();
            const initialBalance: SymbolBalance = Object.fromEntries(
              Object.entries(balance).map(([k, v]) => [k.toUpperCase(), v]),
            );
            const result = simulatePlaybook({ spec: parsed, baseSymbol, quoteSymbol, initialBalance, series });
            const rowId = insertBacktestRun({
              strategyType: "playbook",
              chain: profile.name,
              baseSymbol, quoteSymbol,
              specJson: JSON.stringify(parsed),
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
            return {
              ok: true,
              id: rowId,
              spec: parsed,
              base_symbol: baseSymbol, quote_symbol: quoteSymbol,
              window_start: result.windowStart, window_end: result.windowEnd,
              points: series.points.length,
              initial_usd: result.initialUsd, final_usd: result.finalUsd,
              pnl_usd: result.pnlUsd, hold_pnl_usd: result.holdPnlUsd,
              fires: result.fires,
              per_strategy: result.perStrategy,
              notes: result.notes,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── backtest_compare ───────────────────────────────────────
  server.tool(
    "backtest_compare",
    "Replay N scenarios against ONE shared price series + fresh balance per scenario. Returns per-scenario PnL/fires/status + winner index (highest PnL). Each scenario persists as a regular backtest_runs row; the comparison summary persists separately. Same-pair invariant enforced across scenarios.",
    {
      scenarios: z
        .array(
          z.object({
            name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe("Scenario label."),
            spec: playbookSpecShape,
            vars: varsShape,
          }),
        )
        .min(2).max(50)
        .describe("Inline scenarios array. Each has a unique name + a playbook spec (template-renderable via vars)."),
      balance: z.record(z.string(), z.number().nonnegative()).describe("Starting balance, identical for every scenario."),
      since: z.string().default("30d").describe("Window — same shape as backtest_playbook."),
      chain: z.string().optional().describe("Chain (default: first scenario's chain or active chain)."),
      base: z.string().optional().describe("Override base symbol."),
      quote: z.string().optional().describe("Override quote symbol."),
      name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe("Comparison label (default: auto-generated)."),
    },
    async ({ scenarios, balance, since, chain, base, quote, name }) => {
      try {
        return ok(
          await runTool("backtest_compare", rt.opts, { scenarios, balance, since, chain, base, quote, name }, chain, async () => {
            // For MCP, the operator passes inline scenarios (with vars
            // resolved inline). We materialize a temporary scenarios
            // file in-memory by writing renderered specs to a temp dir;
            // simpler to call the comparison runner with inline data.
            const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
            const { join } = await import("node:path");
            const { tmpdir } = await import("node:os");
            const dir = mkdtempSync(join(tmpdir(), "tradekit-mcp-compare-"));
            try {
              // Render each scenario's spec to a file in the temp dir.
              const scenarioFiles = scenarios.map((s, i) => {
                const fileName = `scenario-${i}-${s.name}.json`;
                writeFileSync(join(dir, fileName), JSON.stringify(s.spec, null, 2));
                return { name: s.name, file: fileName, vars: s.vars };
              });
              const scenariosObj = {
                name: name ?? `mcp-compare-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}`,
                scenarios: scenarioFiles,
              };
              const scenariosPath = join(dir, "scenarios.json");
              writeFileSync(scenariosPath, JSON.stringify(scenariosObj, null, 2));
              parseScenariosFile(scenariosObj); // validates upfront

              // Pre-resolve the shared pair so we know which CoinGecko
              // address to fetch.
              const config = rt.getConfig();
              const chainName = chain ?? config.activeChain;
              const profile = resolveProfile(chainName, config);
              // Use first scenario's spec to infer base/quote when not
              // overridden.
              const firstSpec = scenarios[0].spec as Record<string, unknown>;
              const firstStrategies = Array.isArray(firstSpec.strategies) ? firstSpec.strategies : [];
              const firstTradeable = firstStrategies.find(
                (s: unknown) => typeof s === "object" && s != null && ((s as { type?: string }).type === "order" || (s as { type?: string }).type === "schedule"),
              ) as { base?: string; quote?: string } | undefined;
              const baseInput = base ?? firstTradeable?.base;
              const quoteInput = quote ?? firstTradeable?.quote;
              if (!baseInput || !quoteInput) {
                throw new ToolError("INVALID_PARAMS", `Could not infer base/quote — pass --base/--quote explicitly.`);
              }
              const pair = resolveTradePair(profile, baseInput, quoteInput);
              const baseAddrForPrice = pair.base === "ETH" ? profile.weth : pair.base;
              if (!baseAddrForPrice) {
                throw new ToolError("INVALID_PARAMS", `Cannot resolve a price address for ${baseInput} on ${profile.name}.`);
              }
              const initialBalance: SymbolBalance = Object.fromEntries(
                Object.entries(balance).map(([k, v]) => [k.toUpperCase(), v]),
              );
              const outcome = await runCompareFromFile({
                scenariosPath,
                initialBalance,
                since,
                chain: profile.name,
                baseAddress: baseAddrForPrice,
              });
              return {
                ok: true,
                comparison_id: outcome.comparisonId,
                name: outcome.name,
                base_symbol: outcome.baseSymbol,
                quote_symbol: outcome.quoteSymbol,
                window_start: outcome.windowStart,
                window_end: outcome.windowEnd,
                points: outcome.points,
                winner_idx: outcome.winnerIdx,
                scenarios: outcome.scenarios,
              };
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  void simulateSchedule; // exported but not registered as its own MCP tool — backtest_playbook covers schedules
  void loadConfig;

  // ── strategy_report (iter31) ──────────────────────────────
  //
  // Unified observability for a strategy tag. Pre-iter31 agents had
  // to issue 7+ separate MCP calls (playbook_show + recent_trades +
  // ...) to assemble a strategy snapshot; this tool collapses that
  // into one call returning the same typed structure used by the
  // CLI. Section filtering lets agents request just the parts they
  // need (e.g. identity+forward for a quick "is this still healthy?
  // is anything about to fire?" tick check).
  server.tool(
    "strategy_report",
    "Unified multi-section report for a strategy tag (or playbook id). Pulls together composition (active orders/schedules/rebalances), performance (fills + slippage), position (net token deltas), risk (budgets + drawdown), recent activity, and forward signals (next schedule fire + per-order distance-to-trigger) into one response. Bare numeric tag resolves to playbook:N. Mode auto-detects paper vs real from the primitives. --sections filter supports fast tick checks. Errors: INVALID_PARAMS (bad window/mode/section name).",
    {
      tag: z.string().min(1).describe("Strategy tag (e.g. `playbook:1`, `dca-eth`) or a bare playbook id."),
      window: z
        .enum(["1d", "7d", "30d", "90d", "all"])
        .default("30d")
        .describe("Aggregation window for the performance section. Composition + position are always lifetime."),
      mode: z
        .enum(["real", "paper", "auto"])
        .default("auto")
        .describe("Force paper or real mode; auto inspects primitives + trades to pick."),
      sections: z
        .array(z.enum(["identity", "composition", "performance", "position", "risk", "activity", "forward"]))
        .optional()
        .describe("Subset of sections to compute. Omit for the full report."),
      includePrices: z
        .boolean()
        .default(false)
        .describe("Look up live spot prices for the forward-signals section. Default false (MCP calls should be deterministic + network-free unless explicitly opted in)."),
    },
    async ({ tag, window, mode, sections, includePrices }) => {
      try {
        return ok(
          await runTool(
            "strategy_report",
            rt.opts,
            { tag, window, mode, sections, includePrices },
            undefined,
            async () => {
              const { buildStrategyReport } = await import("../strategyReport.js");
              const { getCurrentPrice } = await import("../price.js");
              const { createLogger } = await import("../logger.js");
              const quietLogger = createLogger({ stderrLevel: "silent" });
              const livePriceFn = includePrices
                ? async (token: string): Promise<number | null> => {
                    try {
                      return await getCurrentPrice(token, quietLogger);
                    } catch {
                      return null;
                    }
                  }
                : undefined;
              const report = await buildStrategyReport({
                tag,
                window,
                mode,
                sections,
                livePriceFn,
              });
              return { report };
            },
          ),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );
};
