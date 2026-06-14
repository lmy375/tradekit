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
import { resolveTradePair, resolveToken } from "../chains.js";
import {
  simulateOrder,
  simulateSchedule,
  simulatePlaybook,
  fetchPriceSeries,
  parseSinceDuration,
  type SymbolBalance,
  type PriceSeries,
} from "../backtest.js";
import {
  insertBacktestRun,
  listSignalEvents,
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

  // ── v49: playbook_promote_check ────────────────────────────
  server.tool(
    "playbook_promote_check",
    "v49: 'is this paper strategy ready for real money?' — the strategy-quality half of the promote decision (playbook_promote runs the funding half). Composes: paper runtime evidence (days/fills — floors at 7d/5 fills → not_ready), realized+MTM paper PnL, the v48 paper-book equity risk block (drawdown/vol/sharpe; book-level, disclosed), and the FRICTION REALITY cross-check — paper fills' ASSUMED slippage vs your REAL fills' realized slippage + gas, projected onto the paper cadence as monthly USD friction and its share of paper PnL (>50% → caution; 'the edge may not survive real execution'). Deterministic thresholds, reasons[] names every flag. Verdict: ready | caution | not_ready.",
    {
      id: z.number().int().positive().describe("Playbook id (paper deployment)."),
      native_usd: z.number().positive().optional().describe("Current native-token USD price (for expressing real gas in USD). Omit to degrade to native-unit gas reporting."),
    },
    async ({ id, native_usd }) => {
      try {
        return ok(
          await runTool("playbook_promote_check", rt.opts, { id, native_usd }, undefined, async () => {
            const { gatherPromoteCheck } = await import("../promoteCheck.js");
            return await gatherPromoteCheck({ playbookId: id, nativeUsd: native_usd ?? null, config: rt.getConfig() });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── v50: playbook_outcome ──────────────────────────────────
  server.tool(
    "playbook_outcome",
    "v50: 'did promoting this strategy deliver what the paper run promised?' — the BACKWARD half of the trust pipeline (playbook_promote_check is the forward half). Compares the frozen paper baseline (paper_trades, which stopped growing at promotion) against the live fills (trades) for the same strategy tag, NORMALIZED per-fill and per-week so a 50-fill paper run and a 6-fill live run compare fairly. Both eras run through the SAME cost-basis walker (computePaperPnlMtm) → apples-to-apples realized PnL. Verdict: on_track | underperforming | diverged | insufficient_data. diverged = paper realized > 0 but live fills realize ≤ 0/fill (the strategy is not making money with real execution). underperforming = live per-fill realized < 60% of paper, OR live median slippage > 1.5× the paper assumption, OR live cadence < 50% of paper (with ≥2 live days). insufficient_data = no live fills, < 3 live fills, or no paper baseline. Deterministic + offline: the verdict keys off realized PnL (closed round-trips), the live fills' own realized slippage + gas, and cadence — never off unrealized marks. reasons[] names every flag.",
    {
      id: z.number().int().positive().describe("Playbook id (promoted, or paper — insufficient_data when no live fills yet)."),
      native_usd: z.number().positive().optional().describe("Current native-token USD price (for expressing live gas in USD). Omit to degrade to native-unit gas reporting."),
    },
    async ({ id, native_usd }) => {
      try {
        return ok(
          await runTool("playbook_outcome", rt.opts, { id, native_usd }, undefined, async () => {
            const { gatherPromoteOutcome } = await import("../promoteOutcome.js");
            return await gatherPromoteOutcome({ playbookId: id, nativeUsd: native_usd ?? null, config: rt.getConfig() });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── playbook_promote ───────────────────────────────────────
  server.tool(
    "playbook_promote",
    "Flip a deployed playbook between paper and real trading IN PLACE — the dry-run loop's graduation step. Every live primitive (active orders; active+paused schedules/rebalance plans) routes through the same edit machinery as order_edit/schedule_edit/rebalance_edit, so trailing HWM water marks, run counters, and drift telemetry ALL survive: a trailing stop that tracked a $3,500 HWM in paper keeps protecting from $3,500 the moment it's real. Symmetric: to='paper' demotes a live strategy back to the sandbox without losing state. Rows already in the target mode (or terminal) are reported in skipped[] with reasons; alreadyInTarget=true means nothing flipped. v36: promotes to real run an as-if-real funding PREFLIGHT (the runway machinery with paper primitives bucketed as real — spend tokens AND gas vs the actual wallet); the result's preflight.warnings list findings worst-first and requireFunded=true aborts with INSUFFICIENT_BALANCE when the wallet cannot fund even one fire. Preflight is advisory by default and best-effort (a dead RPC warns, never blocks; skipPreflight disables). Destructive direction (to real fires actual trades from the next engine tick) requires `yes: true`. Errors: INVALID_PARAMS (id not found, not deployed, no owned primitives, yes missing).",
    {
      id: z.number().int().positive().describe("Deployed playbook id."),
      to: z.enum(["real", "paper"]).default("real").describe("Target mode. Default real (graduate the dry-run)."),
      yes: z.literal(true).describe("Confirmation — promotion to real fires actual trades from the next tick; must be `true`."),
      requireFunded: z.boolean().optional().describe("v36: abort (INSUFFICIENT_BALANCE) when the preflight finds the REAL wallet cannot fund even one fire (spend token or gas). Strongly recommended for agent-driven promotes."),
      skipPreflight: z.boolean().optional().describe("Skip the as-if-real funding preflight entirely (RPC-less environments). The result then has preflight: null."),
    },
    async ({ id, to, yes, requireFunded, skipPreflight }) => {
      try {
        return ok(
          await runTool("playbook_promote", rt.opts, { id, to, yes, requireFunded, skipPreflight }, undefined, async () => {
            if (yes !== true) {
              throw new ToolError("INVALID_PARAMS", `Confirmation flag required: pass yes=true.`);
            }
            const { promotePlaybook, promotePreflight, preflightBlocker } = await import("../playbooks.js");
            // v36 preflight: as-if-real funding runway scoped to the
            // playbook. Best-effort (a dead RPC reports as warnings,
            // never blocks) unless requireFunded gates on the hard
            // cannot-fund-one-fire findings.
            let preflight: Awaited<ReturnType<typeof promotePreflight>> | null = null;
            if (to === "real" && skipPreflight !== true) {
              try {
                preflight = await promotePreflight({ playbookId: id });
              } catch { /* preflight unavailable — proceed (it is advisory by default) */ }
              if (preflight && requireFunded === true) {
                const blocker = preflightBlocker(preflight);
                if (blocker) throw new ToolError("INSUFFICIENT_BALANCE", blocker);
              }
            }
            const result = promotePlaybook({ playbookId: id, to });
            return { ok: true, ...result, preflight };
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

  // ── v40: cost-aware backtests (shared knobs) ───────────────
  // Friction model — see SimCosts in backtest.ts. Explicit knobs win
  // over history-derived values; omitting everything keeps the
  // cost-free pre-v40 behavior.
  const costShapes = {
    slippage_bps: z.number().min(0).max(10_000).optional()
      .describe("v40: per-fill slippage in basis points. Degrades the received side of every simulated fill (flows through the balance)."),
    gas_usd_per_fire: z.number().min(0).optional()
      .describe("v40: flat USD gas per fill, charged against final equity (the sim doesn't track the native balance)."),
    costs_from_history: z.boolean().default(false)
      .describe("v40: calibrate missing knobs from YOUR recorded real trades — slippage = avg |realized slippage| (last 50 fills on the chain), gas = avg gas_cost_native × current native USD price. The hold counterfactual stays frictionless on purpose."),
  };
  async function resolveMcpCosts(args: {
    slippage_bps?: number;
    gas_usd_per_fire?: number;
    costs_from_history: boolean;
    profile: { name: string; weth?: `0x${string}` };
  }): Promise<{ costs: { slippageBps: number; gasUsdPerFire: number } | null; provenance: string[] }> {
    let slippageBps = args.slippage_bps;
    let gasUsdPerFire = args.gas_usd_per_fire;
    const provenance: string[] = [];
    if (args.costs_from_history) {
      const { recentSlippageStats, recentGasStats } = await import("../db.js");
      if (slippageBps == null) {
        const slip = recentSlippageStats(args.profile.name);
        if (slip) {
          slippageBps = Math.round(slip.avgAbsSlippageBps * 10) / 10;
          provenance.push(`slippage ${slippageBps}bps = avg |realized slippage| over last ${slip.samples} real fill(s) on ${args.profile.name}`);
        } else {
          provenance.push(`costs_from_history: no recorded slippage on ${args.profile.name} — slippage not modeled`);
        }
      }
      if (gasUsdPerFire == null) {
        const gas = recentGasStats(args.profile.name, null);
        if (gas && args.profile.weth) {
          const { getCurrentPrice } = await import("../price.js");
          const { createLogger } = await import("../logger.js");
          const nativeUsd = await getCurrentPrice(args.profile.weth, createLogger({ stderrLevel: "silent" })).catch(() => null);
          if (nativeUsd != null && nativeUsd > 0) {
            gasUsdPerFire = Math.round(gas.avgGasNative * nativeUsd * 10_000) / 10_000;
            provenance.push(`gas $${gasUsdPerFire}/fire = avg ${gas.avgGasNative.toPrecision(3)} native over last ${gas.samples} real fill(s) × native price $${nativeUsd.toFixed(2)}`);
          } else {
            provenance.push(`costs_from_history: native USD price unavailable — gas not modeled`);
          }
        } else {
          provenance.push(`costs_from_history: no recorded gas costs on ${args.profile.name} — gas not modeled`);
        }
      }
    }
    if (slippageBps == null && gasUsdPerFire == null) return { costs: null, provenance };
    return { costs: { slippageBps: slippageBps ?? 0, gasUsdPerFire: gasUsdPerFire ?? 0 }, provenance };
  }

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
      ...costShapes,
    },
    async ({ side, trigger, price, trail_pct, base, quote, base_amount, quote_amount, balance, since, chain, slippage_bps, gas_usd_per_fire, costs_from_history }) => {
      try {
        return ok(
          await runTool("backtest_order", rt.opts, { side, trigger, price, trail_pct, base, quote, base_amount, quote_amount, balance, since, chain, slippage_bps, gas_usd_per_fire, costs_from_history }, chain, async () => {
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
            const simCosts = await resolveMcpCosts({ slippage_bps, gas_usd_per_fire, costs_from_history, profile });
            const result = simulateOrder({
              spec: {
                side, trigger,
                targetPriceUsd: price,
                trailPct: trail_pct,
                baseAmount: base_amount,
                quoteAmount: quote_amount,
              },
              baseSymbol, quoteSymbol, initialBalance, series,
              costs: simCosts.costs,
            });
            result.notes.push(...simCosts.provenance);
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
              metricsJson: result.metrics || result.holdMetrics
                ? JSON.stringify({ metrics: result.metrics, holdMetrics: result.holdMetrics })
                : null,
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
              costs: result.costs,
              metrics: result.metrics, hold_metrics: result.holdMetrics,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── backtest_rebalance ─────────────────────────────────────
  server.tool(
    "backtest_rebalance",
    "Replay a target-weight rebalance plan against historical multi-asset CoinGecko price series — the multi-asset backtest the single-pair tools can't do. Walks the cron's occurrences across the window; at each one it prices every target (at-or-before lookup, robust to misaligned series), computes per-target drift, and when maxDrift >= driftThresholdPct fires corrective legs with the live engine's mechanics (sells fund the quote anchor first, buys draw from it, per-leg minTradeUsd skip, anchor shortfall clamps — money is never minted). Optional worst-case slippageBps per leg. Returns { id, targets, evaluations, skipped_in_band, fires: [{ ts, maxDriftPct, legs[], portfolioUsdBefore/After }], pnl_usd, hold_pnl_usd, ... } — pnl_usd − hold_pnl_usd is the REBALANCING ALPHA vs plain HODL of the same starting book (usually negative in trends, positive in mean-reverting chop). Initial book defaults to initial_usd (default $10k) split at target weights at window-start prices, so every fire is attributable to market drift. Persists to backtest_runs (strategy_type='rebalance') for backtest_show. Stablecoin anchors without a CoinGecko mapping synthesize a flat $1 series. Errors: INVALID_PARAMS (targets sum, threshold range, bad cron); UNKNOWN_TOKEN (non-listed, non-stable target).",
    {
      targets: z
        .array(z.object({ token: z.string(), targetPct: z.number().positive() }))
        .min(2)
        .describe("Target weights — same shape rebalance_create takes; must sum to exactly 100."),
      drift_threshold_pct: z.number().optional().describe("Fire when max per-target drift >= this. Default 5."),
      min_trade_usd: z.number().optional().describe("Per-leg USD minimum; smaller corrective legs skip. Default 10."),
      cron: z.string().optional().describe("Evaluation cadence (cron). Default: every 6 hours."),
      every: z.string().optional().describe("Duration shorthand alternative to cron (6h, 1d, 7d)."),
      max_runs: z.number().int().min(1).optional().describe("Lifetime cap on executed rebalances."),
      slippage_bps: z.number().int().min(0).max(10_000).optional().describe("Worst-case per-leg slippage. Default 0 (isolate the pure rebalancing effect)."),
      quote_token: z.string().optional().describe("Routing anchor symbol. Default USDC."),
      balance: z.record(z.string(), z.number().nonnegative()).optional().describe("Starting units per symbol. Omit for the default $-split-at-target-weights book."),
      initial_usd: z.number().positive().optional().describe("Total USD for the default starting book. Default 10000."),
      since: z.string().default("90d").describe("Window — '90d', '6m', or bare days. Max 3650."),
      chain: z.string().optional().describe("Chain (default: active chain)."),
      sweep_thresholds: z.array(z.number()).optional().describe("SWEEP MODE: drift-threshold axis. Any sweep_* param flips to grid mode — every threshold×cadence×min-trade combination re-runs over the SAME fetched series (no extra API calls). Returns a ranked variant table + persists one backtest_comparisons row (re-render via backtest_compare_show)."),
      sweep_cadences: z.array(z.string()).optional().describe("SWEEP MODE: cadence axis as duration shorthands (1h, 6h, 1d)."),
      sweep_min_trades: z.array(z.number()).optional().describe("SWEEP MODE: per-leg min-trade-USD axis."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("backtest_rebalance", rt.opts, input, input.chain, async () => {
            const { simulateRebalance, validateRebalanceBacktestSpec, constantSeries, defaultInitialBalance, sweepRebalance } =
              await import("../backtestRebalance.js");
            const { fetchPriceSeries: fetchSeries, parseSinceDuration: parseSince } = await import("../backtest.js");
            const config = rt.getConfig();
            const chainName = input.chain ?? config.activeChain;
            const profile = resolveProfile(chainName, config);

            const targets = input.targets.map((t) => ({ symbol: t.token.toUpperCase(), targetPct: t.targetPct }));
            const quoteSymbol = (input.quote_token ?? "USDC").toUpperCase();
            const { durationToCron } = await import("../cron.js");
            const spec = {
              targets,
              driftThresholdPct: input.drift_threshold_pct,
              minTradeUsd: input.min_trade_usd,
              cron: input.cron ?? (input.every ? durationToCron(input.every) : undefined),
              maxRuns: input.max_runs,
              slippageBps: input.slippage_bps,
              quoteSymbol,
            };
            validateRebalanceBacktestSpec(spec);

            const days = parseSince(input.since);
            const windowStartIso = new Date(Date.now() - days * 86_400_000).toISOString();
            const windowEndIso = new Date().toISOString();
            const STABLES = new Set(["USDC", "USDT", "DAI", "USDBC", "USDC.E", "LUSD", "GUSD", "FRAX"]);

            const symbols = new Set<string>(targets.map((t) => t.symbol));
            symbols.add(quoteSymbol);
            const series: Record<string, import("../backtest.js").PriceSeries> = {};
            let totalPoints = 0;
            for (const sym of symbols) {
              const addr = resolveToken(profile, sym);
              let s = addr
                ? await fetchSeries(addr, days).catch((e) => {
                    if (STABLES.has(sym)) return null;
                    throw e;
                  })
                : null;
              if (!s && STABLES.has(sym)) s = constantSeries(sym, windowStartIso, windowEndIso);
              if (!s) {
                throw new ToolError(
                  "UNKNOWN_TOKEN",
                  `No price series for ${sym} on ${profile.name} — targets must be CoinGecko-listed (or recognized stablecoins).`,
                );
              }
              series[sym] = s;
              totalPoints += s.points.length;
            }

            const initialBalance = input.balance
              ? Object.fromEntries(Object.entries(input.balance).map(([k, v]) => [k.toUpperCase(), v]))
              : defaultInitialBalance({ spec, series, totalUsd: input.initial_usd });

            // Sweep mode: grid over the same series, persist each
            // variant + one comparison row, return ranked variants.
            if (input.sweep_thresholds?.length || input.sweep_cadences?.length || input.sweep_min_trades?.length) {
              const outcome = sweepRebalance({
                spec,
                thresholds: input.sweep_thresholds,
                crons: input.sweep_cadences?.map((c) => durationToCron(c)),
                minTrades: input.sweep_min_trades,
                initialBalance,
                series,
              });
              const { insertBacktestComparison } = await import("../db.js");
              const baseSym = targets.map((t) => t.symbol).join("+");
              const runIds: number[] = [];
              const variants = outcome.variants.map((v) => {
                const runId = insertBacktestRun({
                  strategyType: "rebalance",
                  chain: profile.name,
                  baseSymbol: baseSym,
                  quoteSymbol,
                  specJson: JSON.stringify({ ...spec, driftThresholdPct: v.driftThresholdPct, cron: v.cron, minTradeUsd: v.minTradeUsd }),
                  initialBalanceJson: JSON.stringify(initialBalance),
                  finalBalanceJson: JSON.stringify(v.result.finalBalance),
                  windowStart: v.result.windowStart,
                  windowEnd: v.result.windowEnd,
                  points: totalPoints,
                  firesJson: JSON.stringify(v.result.fires),
                  fireCount: v.result.fires.length,
                  pnlUsd: v.result.pnlUsd,
                  holdPnlUsd: v.result.holdPnlUsd,
                  notes: v.result.notes.join("; ") || null,
                });
                runIds.push(runId);
                return {
                  scenarioName: v.label,
                  runId,
                  pnlUsd: v.result.pnlUsd,
                  holdPnlUsd: v.result.holdPnlUsd,
                  vsHoldUsd: v.result.pnlUsd - v.result.holdPnlUsd,
                  fireCount: v.result.fires.length,
                  cascadeCount: 0,
                  finalUsd: v.result.finalUsd,
                  initialUsd: v.result.initialUsd,
                  perStrategy: [],
                  hadAnyFill: v.result.fires.length > 0,
                };
              });
              const first = outcome.variants[0]?.result;
              const comparisonId = insertBacktestComparison({
                name: `rebalance-sweep-${baseSym}`,
                scenariosJson: JSON.stringify(outcome.variants.map((v) => ({ name: v.label, driftThresholdPct: v.driftThresholdPct, cron: v.cron, minTradeUsd: v.minTradeUsd }))),
                resultsJson: JSON.stringify(variants),
                runIds,
                baseSymbol: baseSym,
                quoteSymbol,
                chain: profile.name,
                windowStart: first?.windowStart ?? new Date().toISOString(),
                windowEnd: first?.windowEnd ?? new Date().toISOString(),
                winnerIdx: outcome.winnerIdx,
              });
              return {
                ok: true,
                sweep: true,
                comparison_id: comparisonId,
                targets,
                quote_symbol: quoteSymbol,
                winner_idx: outcome.winnerIdx,
                winner: outcome.winnerIdx != null ? variants[outcome.winnerIdx].scenarioName : null,
                variants,
              };
            }

            const result = simulateRebalance({ spec, initialBalance, series });

            const rowId = insertBacktestRun({
              strategyType: "rebalance",
              chain: profile.name,
              baseSymbol: targets.map((t) => t.symbol).join("+"),
              quoteSymbol,
              specJson: JSON.stringify(spec),
              initialBalanceJson: JSON.stringify(initialBalance),
              finalBalanceJson: JSON.stringify(result.finalBalance),
              windowStart: result.windowStart,
              windowEnd: result.windowEnd,
              points: totalPoints,
              firesJson: JSON.stringify(result.fires),
              fireCount: result.fires.length,
              pnlUsd: result.pnlUsd,
              holdPnlUsd: result.holdPnlUsd,
              notes: result.notes.join("; ") || null,
            });

            return {
              ok: true,
              id: rowId,
              targets,
              quote_symbol: quoteSymbol,
              window_start: result.windowStart,
              window_end: result.windowEnd,
              points: totalPoints,
              evaluations: result.evaluations,
              skipped_in_band: result.skippedInBand,
              initial_balance: initialBalance,
              final_balance: result.finalBalance,
              initial_usd: result.initialUsd,
              final_usd: result.finalUsd,
              pnl_usd: result.pnlUsd,
              hold_final_usd: result.holdFinalUsd,
              hold_pnl_usd: result.holdPnlUsd,
              rebalancing_alpha_usd: result.pnlUsd - result.holdPnlUsd,
              fires: result.fires,
              notes: result.notes,
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
      signals: z
        .array(z.object({
          name: z.string().describe("Signal name (matches the order's signal_name)."),
          at: z.string().describe("ISO-8601 arrival time. Signals before the series window never fire (order wasn't armed)."),
        }))
        .optional()
        .describe("v39.5: signal history to replay for signal-triggered entries — hypothetical, or recorded. Providing this (even empty) lifts the signal-entry rejection. Mutually composable with signals_from_history (merged)."),
      signals_from_history: z
        .boolean()
        .default(false)
        .describe("v39.5: replay the v35 signal_events inbox — \"with the alerts I actually received, how would this have done?\". Pulls every recorded signal inside the price window."),
      ...costShapes,
    },
    async ({ spec, vars, balance, since, chain, base, quote, signals, signals_from_history, slippage_bps, gas_usd_per_fire, costs_from_history }) => {
      try {
        return ok(
          await runTool("backtest_playbook", rt.opts, { spec, vars, balance, since, chain, base, quote, signals, signals_from_history, slippage_bps, gas_usd_per_fire, costs_from_history }, chain, async () => {
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
            const baseSymbol = baseInput.toUpperCase();
            const quoteSymbol = quoteInput.toUpperCase();
            const days = parseSinceDuration(since);
            // v43: one series per unique base (multi-pair bundles).
            const uniqueBases: string[] = [baseSymbol];
            for (const s of parsed.strategies) {
              if (s.type !== "order" && s.type !== "schedule") continue;
              const b = s.base.toUpperCase();
              if (!uniqueBases.includes(b)) uniqueBases.push(b);
            }
            if (uniqueBases.length > 6) {
              throw new ToolError("INVALID_PARAMS", `Playbook spans ${uniqueBases.length} distinct base tokens — max 6 per backtest.`);
            }
            const fetchFor = async (b: string) => {
              const pair = resolveTradePair(profile, b, quoteSymbol);
              const addr = pair.base === "ETH" ? profile.weth : pair.base;
              if (!addr) throw new ToolError("INVALID_PARAMS", `Cannot resolve a price address for ${b} on ${profile.name}.`);
              const s = await fetchPriceSeries(addr, days);
              if (!s) throw new ToolError("UNKNOWN_TOKEN", `Backtest requires CoinGecko-listed base tokens ("${b}" isn't mapped).`);
              return s;
            };
            const series = await fetchFor(baseSymbol);
            const seriesByBase: Record<string, PriceSeries> = {};
            for (const b of uniqueBases.slice(1)) seriesByBase[b] = await fetchFor(b);
            const initialBalance: SymbolBalance = Object.fromEntries(
              Object.entries(balance).map(([k, v]) => [k.toUpperCase(), v]),
            );
            let simSignals = signals as Array<{ name: string; at: string }> | undefined;
            if (signals_from_history) {
              const windowStart = series.points[0]?.ts ?? new Date(0).toISOString();
              const recorded = listSignalEvents({ since: windowStart, limit: 10_000 }).map((e) => ({
                name: e.name,
                at: e.received_at,
              }));
              simSignals = [...(simSignals ?? []), ...recorded];
            }
            const simCosts = await resolveMcpCosts({ slippage_bps, gas_usd_per_fire, costs_from_history, profile });
            const result = simulatePlaybook({ spec: parsed, baseSymbol, quoteSymbol, initialBalance, series, seriesByBase, signals: simSignals, costs: simCosts.costs });
            result.notes.push(...simCosts.provenance);
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
              metricsJson: result.metrics || result.holdMetrics
                ? JSON.stringify({ metrics: result.metrics, holdMetrics: result.holdMetrics })
                : null,
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
              costs: result.costs,
              metrics: result.metrics, hold_metrics: result.holdMetrics,
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
      ...costShapes,
    },
    async ({ scenarios, balance, since, chain, base, quote, name, slippage_bps, gas_usd_per_fire, costs_from_history }) => {
      try {
        return ok(
          await runTool("backtest_compare", rt.opts, { scenarios, balance, since, chain, base, quote, name, slippage_bps, gas_usd_per_fire, costs_from_history }, chain, async () => {
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
              const simCosts = await resolveMcpCosts({ slippage_bps, gas_usd_per_fire, costs_from_history, profile });
              const outcome = await runCompareFromFile({
                scenariosPath,
                initialBalance,
                since,
                chain: profile.name,
                baseAddress: baseAddrForPrice,
                costs: simCosts.costs,
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
    "Unified multi-section report for a strategy tag (or playbook id). Pulls together composition (active orders/schedules/rebalances), performance (fills + slippage), position (net token deltas), risk (budgets + drawdown), recent activity, and forward signals (next schedule fire + per-order distance-to-trigger) into one response. Bare numeric tag resolves to playbook:N. Mode auto-detects paper vs real from the primitives. --sections filter supports fast tick checks. `mtm: true` adds a VALUATION section: cost-basis positions (same weighted-average core as paper_pnl mtm — numbers match across surfaces) marked at live oracle prices, with realized/unrealized/total + per-position detail; works in BOTH modes (real mode walks status='success' trades; gas excluded — use the pnl tool for full portfolio accounting). mtm is opt-in and non-deterministic (live prices). Errors: INVALID_PARAMS (bad window/mode/section name).",
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
        .array(z.enum(["identity", "composition", "performance", "position", "risk", "activity", "forward", "valuation", "runway"]))
        .optional()
        .describe("Subset of sections to compute. Omit for the full report (valuation stays opt-in via mtm)."),
      includePrices: z
        .boolean()
        .default(false)
        .describe("Look up live spot prices for the forward-signals section. Default false (MCP calls should be deterministic + network-free unless explicitly opted in)."),
      mtm: z
        .boolean()
        .default(false)
        .describe("Add the mark-to-market valuation section (cost-basis positions at live oracle prices). One memoized oracle call per held token."),
    },
    async ({ tag, window, mode, sections, includePrices, mtm }) => {
      try {
        return ok(
          await runTool(
            "strategy_report",
            rt.opts,
            { tag, window, mode, sections, includePrices, mtm },
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
              let effectiveSections = sections;
              let markPriceFn;
              if (mtm) {
                const { defaultPaperPriceFetcher } = await import("../paperPnl.js");
                markPriceFn = defaultPaperPriceFetcher(rt.getConfig(), quietLogger);
                if (effectiveSections && !effectiveSections.includes("valuation")) {
                  effectiveSections = [...effectiveSections, "valuation"];
                } else if (!effectiveSections) {
                  effectiveSections = ["identity", "composition", "performance", "position", "risk", "activity", "forward", "valuation"];
                }
              }
              const report = await buildStrategyReport({
                tag,
                window,
                mode,
                sections: effectiveSections,
                livePriceFn,
                markPriceFn,
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

  // ── strategy_pause / strategy_resume ──────────────────────
  server.tool(
    "strategy_pause",
    "CIRCUIT BREAKER (manual): bulk-pause every active primitive (orders / schedules / rebalance plans) owned by a strategy tag in one call. Non-destructive — nothing is cancelled; trailing watermarks, run counters, and OCO groups all survive. Paused orders still expire on their expiresAt and still die to OCO peer fires. This is the same machinery alert rules with `action: \"pause\"` invoke automatically when they fire. Idempotent: re-pausing reports zero transitions (skipped counts already-paused rows). Returns { tag, action, orders: number[], schedules: number[], rebalances: number[], total, skipped }. Errors: INVALID_PARAMS (empty tag).",
    {
      tag: z.string().min(1).describe("Strategy tag whose primitives to pause (e.g. 'playbook:42' or a custom tag). Exact match — wildcards not supported here."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("strategy_pause", rt.opts, input, undefined, async () => {
            const { pauseStrategyPrimitives } = await import("../strategyControl.js");
            return pauseStrategyPrimitives(input.tag);
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "strategy_resume",
    "Bulk-resume every paused primitive owned by a strategy tag. Schedules + rebalance plans recompute next_run_at from now (missed windows are skipped, not backfilled); orders re-enter trigger evaluation on the next engine tick with trailing watermarks preserved. Blanket by tag: it cannot distinguish breaker-paused from hand-paused primitives — both resume. After a circuit breaker trip, the breaker does NOT re-pause while its rule stays violated (it acts only on fresh fire transitions), so a deliberate resume sticks until the rule resolves and fires again. Returns the same shape as strategy_pause. Errors: INVALID_PARAMS (empty tag).",
    {
      tag: z.string().min(1).describe("Strategy tag whose paused primitives to resume."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("strategy_resume", rt.opts, input, undefined, async () => {
            const { resumeStrategyPrimitives } = await import("../strategyControl.js");
            return resumeStrategyPrimitives(input.tag);
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );
};
