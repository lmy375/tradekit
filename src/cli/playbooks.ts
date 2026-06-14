// CLI surface for strategy playbooks.
//
//   tradekit playbook validate <file> [--json]
//     Parse + validate a playbook JSON spec without touching the DB.
//     Useful in CI to ensure a strategy file is well-formed before
//     PR'ing it.
//
//   tradekit playbook deploy <file> [--json]
//     Parse + atomically create every primitive. Mid-deploy failure
//     rolls back; idempotent on the spec hash.
//
//   tradekit playbook list [--status all|deploying|deployed|destroyed|failed] [--limit N] [--json]
//     List playbook deployments.
//
//   tradekit playbook show <id> [--json]
//     Detail: spec, all owned primitives + their current status.
//
//   tradekit playbook destroy <id> [--yes] [--json]
//     Cancel every owned primitive + mark playbook destroyed.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { ToolError } from "../errors.js";
import {
  parsePlaybookSpec,
  deployPlaybook,
  destroyPlaybook,
  getPlaybookDetail,
  type PlaybookSpec,
  type StrategySpec,
} from "../playbooks.js";
import {
  renderPlaybookTemplate,
  isTemplate,
  parseTemplateVars,
  parseVarFlags,
  coerceVarsByDeclaration,
  type VarValue,
} from "../playbookTemplate.js";
import {
  listPlaybooks,
  getPlaybookById,
  type PlaybookStatus,
} from "../db.js";
import { printJson, parseIntFlag, subcommandError, prompt, collectRepeatableFlag } from "./helpers.js";

// ── helpers ──────────────────────────────────────────────────

function readPlaybookFile(path: string): { raw: unknown; absolutePath: string } {
  const absolutePath = resolvePath(path);
  let text: string;
  try {
    text = readFileSync(absolutePath, "utf8");
  } catch (e) {
    throw new ToolError("INVALID_PARAMS", `Cannot read playbook file "${path}": ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ToolError("INVALID_PARAMS", `Playbook file "${path}" is not valid JSON: ${(e as Error).message}`);
  }
  return { raw: parsed, absolutePath };
}

/**
 * Iter21: read + maybe-render a playbook file. Returns the spec ready
 * to feed parsePlaybookSpec, plus a render report (vars resolved,
 * warnings).
 *
 * Variable precedence: --var NAME=VALUE overrides --vars-file. Both
 * are collected here so the playbook command + backtest command share
 * one entry point.
 */
export function readAndRenderPlaybookFile(args: {
  filePath: string;
  flags: Record<string, string>;
}): {
  rendered: unknown;
  absolutePath: string;
  template: ReturnType<typeof renderPlaybookTemplate> | null;
} {
  const { raw, absolutePath } = readPlaybookFile(args.filePath);

  // Collect --var occurrences (repeatable) from raw argv. parseArgs
  // folds duplicates so we go around it for this one flag.
  const repeatedVars = collectRepeatableFlag(process.argv.slice(2), "var");
  const providedRaw: Record<string, string | number | boolean> = {};

  // --vars-file goes in FIRST (lowest precedence). Errors out on bad
  // JSON / non-object.
  const varsFile = args.flags["vars-file"];
  if (varsFile && varsFile !== "true") {
    const absVarsPath = resolvePath(varsFile);
    let varsText: string;
    try {
      varsText = readFileSync(absVarsPath, "utf8");
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `Cannot read --vars-file "${varsFile}": ${(e as Error).message}`);
    }
    let varsObj: unknown;
    try {
      varsObj = JSON.parse(varsText);
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `--vars-file "${varsFile}" is not valid JSON: ${(e as Error).message}`);
    }
    if (!varsObj || typeof varsObj !== "object" || Array.isArray(varsObj)) {
      throw new ToolError("INVALID_PARAMS", `--vars-file "${varsFile}" must contain a JSON object.`);
    }
    for (const [k, v] of Object.entries(varsObj as Record<string, unknown>)) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new ToolError(
          "INVALID_PARAMS",
          `--vars-file "${varsFile}": var ${JSON.stringify(k)} must be string | number | boolean (got ${typeof v}).`,
        );
      }
      providedRaw[k] = v;
    }
  }

  // --var NAME=VALUE goes in SECOND (higher precedence; overrides
  // --vars-file). Values arrive as strings; coerceVarsByDeclaration
  // promotes them to the declared type.
  if (repeatedVars.length > 0) {
    const fromFlags = parseVarFlags(repeatedVars);
    for (const [k, v] of Object.entries(fromFlags)) {
      providedRaw[k] = v;
    }
  }

  // If the file isn't a template AND no vars supplied → pass through
  // verbatim. Detection via `isTemplate` is cheap (no resolution); the
  // earlier call site used `renderPlaybookTemplate({ provided: {} })`
  // for detection but that throws on the first required-var miss
  // BEFORE the supplied vars could even be applied.
  if (!isTemplate(raw)) {
    if (Object.keys(providedRaw).length > 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--var / --vars-file supplied but "${args.filePath}" has no template variables. Either remove the vars or convert the file into a template by adding a "vars" section / "{{...}}" placeholders.`,
      );
    }
    return { rendered: raw, absolutePath, template: null };
  }

  // Parse declarations first (without resolving) so we know what types
  // to coerce CLI strings to.
  const rawDeclarations =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).vars
      : undefined;
  const declarations = rawDeclarations != null ? parseTemplateVars(rawDeclarations) : {};

  // Coerce provided strings to declared types BEFORE resolution. This
  // is what turns `--var TRAIL_PCT=5` (string "5") into
  // `{ TRAIL_PCT: 5 }` (number) when TRAIL_PCT is declared as a
  // number.
  const coerced: Record<string, VarValue> = coerceVarsByDeclaration(providedRaw, declarations);
  const rendered = renderPlaybookTemplate({ raw, provided: coerced });
  return { rendered: rendered.rendered, absolutePath, template: rendered };
}

function describeStrategy(s: StrategySpec): string {
  switch (s.type) {
    case "order": {
      const amt = s.baseAmount != null ? `${s.baseAmount} ${s.base}` : `${s.quoteAmount} ${s.quote}`;
      if (s.trigger === "trailing") {
        return `[order] ${s.side} ${amt} — trailing ${s.trailPct}% (activation $${s.price ?? "now"})`;
      }
      return `[order] ${s.side} ${amt} — ${s.trigger} $${s.price}`;
    }
    case "schedule": {
      const amt = s.baseAmount != null ? `${s.baseAmount} ${s.base}` : `${s.quoteAmount} ${s.quote}`;
      const cadence = s.cron ? `cron "${s.cron}"` : `every ${s.every}`;
      return `[schedule] ${s.side} ${amt} ${cadence}` + (s.maxRuns ? ` (max ${s.maxRuns})` : "");
    }
    case "rebalance": {
      const tgts = s.targets.map((t) => `${t.token}=${t.targetPct}%`).join(" / ");
      return `[rebalance] targets ${tgts} (drift>${s.driftThresholdPct ?? 5}%)`;
    }
  }
}

function statusMarker(s: PlaybookStatus): string {
  switch (s) {
    case "deployed":  return "●";
    case "deploying": return "◐";
    case "destroyed": return "✕";
    case "failed":    return "✗";
  }
}

function formatRelativeAge(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ── validate ─────────────────────────────────────────────────

export async function playbookValidateCommand(flags: Record<string, string>, positional: string[]) {
  const filePath = positional[2];
  if (!filePath) throw new ToolError("INVALID_PARAMS", `Usage: tradekit playbook validate <file>`);
  const { rendered, absolutePath, template } = readAndRenderPlaybookFile({ filePath, flags });
  const spec = parsePlaybookSpec(rendered);

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      file: absolutePath,
      name: spec.name,
      strategy_count: spec.strategies.length,
      template: template
        ? { vars: template.vars, declarations: template.declarations, warnings: template.warnings }
        : null,
      spec,
    });
    return;
  }
  console.log(`OK  ${absolutePath}`);
  console.log(`Playbook "${spec.name}" — ${spec.strategies.length} strateg${spec.strategies.length === 1 ? "y" : "ies"}`);
  if (spec.description) console.log(`  Description: ${spec.description}`);
  if (spec.chain) console.log(`  Default chain: ${spec.chain}`);
  if (spec.account) console.log(`  Default account: ${spec.account}`);
  if (template) {
    console.log(`  Template:    yes (${Object.keys(template.declarations).length} declared var${Object.keys(template.declarations).length === 1 ? "" : "s"})`);
    if (Object.keys(template.vars).length > 0) {
      console.log(`  Resolved vars:`);
      for (const [k, v] of Object.entries(template.vars)) {
        console.log(`    ${k.padEnd(16)} ${JSON.stringify(v)}`);
      }
    }
    for (const w of template.warnings) {
      console.log(`  ⚠ ${w}`);
    }
  }
  for (let i = 0; i < spec.strategies.length; i++) {
    const localId = spec.strategies[i].id ?? `#${i}`;
    console.log(`  ${localId.padEnd(16)} ${describeStrategy(spec.strategies[i])}`);
  }
}

// ── deploy ───────────────────────────────────────────────────

export async function playbookDeployCommand(flags: Record<string, string>, positional: string[]) {
  const filePath = positional[2];
  if (!filePath) throw new ToolError("INVALID_PARAMS", `Usage: tradekit playbook deploy <file>`);
  const { rendered, absolutePath, template } = readAndRenderPlaybookFile({ filePath, flags });
  const spec = parsePlaybookSpec(rendered);

  if (template && template.warnings.length > 0 && flags["json"] !== "true") {
    for (const w of template.warnings) {
      console.log(`⚠ ${w}`);
    }
  }
  const paper = flags["paper"] === "true";
  const result = deployPlaybook({ spec, sourcePath: absolutePath, paper });

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      playbook_id: result.playbookId,
      already_deployed: result.alreadyDeployed,
      items: result.items,
      paper,
    });
    return;
  }
  if (result.alreadyDeployed) {
    console.log(`No-op: playbook "${spec.name}" already deployed as #${result.playbookId} (same spec hash).`);
    console.log(`To replace: tradekit playbook destroy ${result.playbookId} && tradekit playbook deploy ${filePath}`);
    return;
  }
  console.log(`Deployed playbook "${spec.name}" as #${result.playbookId}${paper ? "  [PAPER MODE]" : ""}`);
  for (const item of result.items) {
    console.log(`  ${item.type.padEnd(10)} #${String(item.rowId).padEnd(4)} ${item.localId.padEnd(16)} ${item.summary}`);
  }
  console.log(``);
  console.log(`To tear down: tradekit playbook destroy ${result.playbookId}`);
}

// ── list ─────────────────────────────────────────────────────

export async function playbookListCommand(flags: Record<string, string>) {
  const statusRaw = flags["status"];
  if (statusRaw != null) {
    const valid = ["all", "deploying", "deployed", "destroyed", "failed"];
    if (!valid.includes(statusRaw)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--status must be one of ${valid.join(" | ")} (got "${statusRaw}").`,
      );
    }
  }
  const status = (statusRaw ?? "deployed") as PlaybookStatus | "all";
  const limit = parseIntFlag(flags["limit"], "--limit", { min: 1, max: 1000 }) ?? 100;
  const rows = listPlaybooks({ status, limit });

  if (flags["json"] === "true") {
    printJson({ ok: true, playbooks: rows });
    return;
  }
  if (rows.length === 0) {
    console.log(`No playbooks with status="${status}". Try \`tradekit playbook --help\` to deploy one.`);
    return;
  }
  console.log(`ID    STATUS     NAME                                DEPLOYED       DESTROYED`);
  for (const r of rows) {
    const marker = statusMarker(r.status);
    const id = String(r.id).padStart(4);
    const name = r.name.length > 34 ? r.name.slice(0, 31) + "…" : r.name.padEnd(34);
    const status = (marker + " " + r.status).padEnd(10);
    const deployed = formatRelativeAge(r.deployed_at).padEnd(14);
    const destroyed = formatRelativeAge(r.destroyed_at);
    console.log(`${id}  ${status}  ${name}  ${deployed}  ${destroyed}`);
  }
}

// ── show ─────────────────────────────────────────────────────

export async function playbookShowCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[2];
  if (!idArg) throw new ToolError("INVALID_PARAMS", `Usage: tradekit playbook show <id>`);
  const id = parseInt(idArg, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `<id> must be a positive integer (got "${idArg}").`);
  }
  const detail = getPlaybookDetail(id);

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      playbook: detail.row,
      spec: detail.spec,
      primitives: {
        orders: detail.orders,
        schedules: detail.schedules,
        rebalances: detail.rebalances,
      },
    });
    return;
  }

  const { row, spec, orders, schedules, rebalances } = detail;
  console.log(`Playbook #${row.id} "${row.name}" — ${row.status}`);
  if (spec.description) console.log(`  Description: ${spec.description}`);
  if (row.source_path) console.log(`  Source:      ${row.source_path}`);
  console.log(`  Hash:        ${row.source_hash}`);
  console.log(`  Deployed:    ${row.deployed_at}`);
  if (row.destroyed_at) console.log(`  Destroyed:   ${row.destroyed_at}`);

  if (orders.length) {
    console.log(``);
    console.log(`  Orders (${orders.length}):`);
    for (const o of orders) {
      const groupTxt = o.group_id ? ` group=${o.group_id}` : "";
      const trig = o.trigger_type === "trailing"
        ? `trailing ${o.trail_pct}%`
        : `${o.trigger_type} $${o.target_price_usd}`;
      console.log(`    #${String(o.id).padStart(4)} [${o.status.padEnd(8)}] ${o.side} ${o.base_symbol ?? "?"}/${o.quote_symbol ?? "?"} — ${trig}${groupTxt}`);
    }
  }
  if (schedules.length) {
    console.log(``);
    console.log(`  Schedules (${schedules.length}):`);
    for (const s of schedules) {
      console.log(`    #${String(s.id).padStart(4)} [${s.status.padEnd(8)}] ${s.side} ${s.base_symbol ?? "?"}/${s.quote_symbol ?? "?"} — cron "${s.cron_expr}" (runs=${s.run_count})`);
    }
  }
  if (rebalances.length) {
    console.log(``);
    console.log(`  Rebalance plans (${rebalances.length}):`);
    for (const r of rebalances) {
      console.log(`    #${String(r.id).padStart(4)} [${r.status.padEnd(8)}] cron "${r.cron_expr}" drift>${r.drift_threshold_pct}% (runs=${r.run_count})`);
    }
  }
}

// ── destroy ──────────────────────────────────────────────────

export async function playbookDestroyCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[2];
  if (!idArg) throw new ToolError("INVALID_PARAMS", `Usage: tradekit playbook destroy <id>`);
  const id = parseInt(idArg, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `<id> must be a positive integer (got "${idArg}").`);
  }
  const existing = getPlaybookById(id);
  if (!existing) throw new ToolError("INVALID_PARAMS", `No playbook with id ${id}.`);

  if (
    existing.status === "deployed" &&
    flags["yes"] !== "true" &&
    flags["json"] !== "true" &&
    process.stdin.isTTY
  ) {
    const reply = await prompt(`Tear down playbook #${id} "${existing.name}" — cancel all owned primitives? type 'destroy': `);
    if (reply.trim().toLowerCase() !== "destroy") {
      throw new ToolError("INVALID_PARAMS", "Destroy aborted — confirmation phrase didn't match.");
    }
  }

  const result = destroyPlaybook(id);

  if (flags["json"] === "true") {
    printJson({ ok: true, ...result });
    return;
  }
  console.log(`Destroyed playbook #${id} "${existing.name}"`);
  console.log(`  Cancelled:        ${result.cancelled.length}`);
  console.log(`  Already terminal: ${result.alreadyTerminal.length}`);
  if (result.errors.length) {
    console.log(`  Errors (${result.errors.length}):`);
    for (const e of result.errors) {
      console.log(`    [${e.type} #${e.rowId}] ${e.message}`);
    }
  }
}

// ── diff (iter29) ────────────────────────────────────────────

/**
 * Read-only preview of what `playbook replace` would change. Useful
 * in CI before merging a strategy spec PR.
 */
export async function playbookDiffCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[2];
  const fileArg = positional[3];
  if (!idArg || !fileArg) {
    throw new ToolError("INVALID_PARAMS", `Usage: tradekit playbook diff <id> <new-spec-file>`);
  }
  const id = parseInt(idArg, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `<id> must be a positive integer (got "${idArg}").`);
  }
  const existing = getPlaybookById(id);
  if (!existing) throw new ToolError("INVALID_PARAMS", `No playbook with id ${id}.`);
  if (existing.status !== "deployed") {
    throw new ToolError(
      "INVALID_PARAMS",
      `Playbook #${id} is "${existing.status}" — diff requires a deployed playbook.`,
    );
  }

  const { rendered: newRendered } = readAndRenderPlaybookFile({ filePath: fileArg, flags });
  const newSpec = parsePlaybookSpec(newRendered);
  const oldSpec = parsePlaybookSpec(JSON.parse(existing.spec_json));

  const { computePlaybookDiff } = await import("../playbookReplace.js");
  const diff = computePlaybookDiff({ oldSpec, newSpec, playbookId: id });

  if (flags["json"] === "true") {
    printJson({ ok: true, diff });
    return;
  }

  console.log(`Playbook diff — #${id} "${existing.name}"`);
  console.log(`  Old hash: ${diff.oldHash.slice(0, 16)}…`);
  console.log(`  New hash: ${diff.newHash.slice(0, 16)}…`);
  if (diff.noChanges) {
    console.log(`  No changes — specs are identical.`);
    return;
  }
  console.log(`  Summary:  ${diff.summary.unchanged} unchanged, ${diff.summary.modified} modified, ${diff.summary.added} added, ${diff.summary.removed} removed`);
  if (diff.willResetTrailingHwm) {
    console.log(`  ⚠ Modified trailing orders will be RECREATED and lose their HWM state on replace.`);
  }
  console.log(``);
  for (const entry of diff.entries) {
    const marker = entry.status === "unchanged" ? "=" :
      entry.status === "modified" ? "~" :
      entry.status === "added" ? "+" : "-";
    console.log(`  ${marker} ${entry.summary}`);
    if (entry.status === "modified") {
      for (const c of entry.fieldChanges) {
        console.log(`      ${c.path}: ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`);
      }
      if (entry.applyMode === "edit") {
        console.log(`      → applied in place (state preserved: HWM, run counters, journal)`);
      } else if (entry.applyMode === "recreate") {
        console.log(`      → cancel + recreate (${entry.recreateReason ?? "state resets"})`);
      }
    }
  }
}

// ── replace (iter29) ─────────────────────────────────────────

/**
 * Atomically apply a new playbook spec. Cancels removed + modified-
 * old primitives, creates added + modified-new ones, updates the
 * playbook row's spec_json + source_hash. Pre-validates BEFORE
 * cancellation so a defective new spec can't leave the playbook in
 * partial state.
 */
export async function playbookReplaceCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[2];
  const fileArg = positional[3];
  if (!idArg || !fileArg) {
    throw new ToolError("INVALID_PARAMS", `Usage: tradekit playbook replace <id> <new-spec-file>`);
  }
  const id = parseInt(idArg, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `<id> must be a positive integer (got "${idArg}").`);
  }
  const existing = getPlaybookById(id);
  if (!existing) throw new ToolError("INVALID_PARAMS", `No playbook with id ${id}.`);
  if (existing.status !== "deployed") {
    throw new ToolError(
      "INVALID_PARAMS",
      `Playbook #${id} is "${existing.status}" — replace requires a deployed playbook.`,
    );
  }

  const { rendered, absolutePath } = readAndRenderPlaybookFile({ filePath: fileArg, flags });
  const newSpec = parsePlaybookSpec(rendered);
  const oldSpec = parsePlaybookSpec(JSON.parse(existing.spec_json));

  // Compute the diff to show the operator what they're about to do.
  const { computePlaybookDiff, replacePlaybook } = await import("../playbookReplace.js");
  const previewDiff = computePlaybookDiff({ oldSpec, newSpec, playbookId: id });

  if (previewDiff.noChanges) {
    if (flags["json"] === "true") {
      printJson({ ok: true, noChanges: true });
    } else {
      console.log(`No changes — new spec is identical to deployed.`);
    }
    return;
  }

  // v2: --fresh-state opts OUT of state preservation — every modified
  // primitive is cancelled + recreated with fresh HWM / run counters.
  const preserveState = flags["fresh-state"] !== "true";

  if (
    flags["yes"] !== "true" &&
    flags["json"] !== "true" &&
    process.stdin.isTTY
  ) {
    console.log(`Playbook replace — #${id} "${existing.name}"`);
    console.log(`  Summary:  ${previewDiff.summary.unchanged} unchanged, ${previewDiff.summary.modified} modified, ${previewDiff.summary.added} added, ${previewDiff.summary.removed} removed`);
    const editable = previewDiff.entries.filter((e) => e.status === "modified" && e.applyMode === "edit").length;
    if (!preserveState) {
      console.log(`  ⚠ --fresh-state: ALL modified primitives are recreated — trailing HWM + run counters reset.`);
    } else {
      if (editable > 0) {
        console.log(`  ${editable} modified primitive${editable === 1 ? "" : "s"} will be edited IN PLACE (HWM, run counters, journal preserved).`);
      }
      if (previewDiff.willResetTrailingHwm) {
        console.log(`  ⚠ Some modified trailing orders must be recreated — their HWM state resets.`);
      }
    }
    const reply = await prompt(`Apply changes? type 'replace': `);
    if (reply.trim().toLowerCase() !== "replace") {
      throw new ToolError("INVALID_PARAMS", "Replace aborted — confirmation phrase didn't match.");
    }
  }

  const result = replacePlaybook({
    playbookId: id,
    newSpec,
    newSourcePath: absolutePath,
    preserveState,
  });

  if (flags["json"] === "true") {
    printJson({ ok: true, ...result });
    return;
  }
  console.log(`Replaced playbook #${id} "${existing.name}"${result.paper ? "  [PAPER]" : ""}`);
  console.log(`  Diff:       ${result.diff.summary.unchanged} unchanged, ${result.diff.summary.modified} modified, ${result.diff.summary.added} added, ${result.diff.summary.removed} removed`);
  if (result.edited.length > 0) {
    console.log(`  Edited:     ${result.edited.length} primitive${result.edited.length === 1 ? "" : "s"} in place (state preserved)`);
    for (const ed of result.edited) {
      console.log(`    ${ed.type.padEnd(10)} #${String(ed.rowId).padEnd(4)} ${ed.localId.padEnd(16)} fields: ${ed.fields.join(", ")}`);
    }
  }
  console.log(`  Cancelled:  ${result.cancelled.length} old primitive${result.cancelled.length === 1 ? "" : "s"}`);
  console.log(`  Created:    ${result.created.length} new primitive${result.created.length === 1 ? "" : "s"}`);
  for (const item of result.created) {
    console.log(`    ${item.type.padEnd(10)} #${String(item.rowId).padEnd(4)} ${item.localId.padEnd(16)} ${item.summary}`);
  }
  console.log(`  New hash:   ${result.newHash.slice(0, 16)}…`);
}

// ── promote (paper ⇄ real) ───────────────────────────────────

/**
 * Flip a deployed playbook between paper and real trading IN PLACE —
 * trailing HWM, run counters, and drift telemetry survive (vs the old
 * destroy + redeploy guidance, which reset all of it). Symmetric:
 * --to paper demotes a live strategy back to the sandbox.
 */
export async function playbookPromoteCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[2];
  if (!idArg) throw new ToolError("INVALID_PARAMS", `Usage: tradekit playbook promote <id> [--to real|paper] [--yes]`);
  const id = parseInt(idArg, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `<id> must be a positive integer (got "${idArg}").`);
  }
  const to = flags["to"] ?? "real";
  if (to !== "real" && to !== "paper") {
    throw new ToolError("INVALID_PARAMS", `--to must be real or paper (got "${to}").`);
  }
  const existing = getPlaybookById(id);
  if (!existing) throw new ToolError("INVALID_PARAMS", `No playbook with id ${id}.`);

  if (
    to === "real" &&
    flags["yes"] !== "true" &&
    flags["json"] !== "true" &&
    process.stdin.isTTY
  ) {
    console.log(`Promote playbook #${id} "${existing.name}" to REAL trading.`);
    console.log(`  Every live paper primitive flips in place — HWM / run counters survive.`);
    console.log(`  ⚠ Real funds: the engine will fire actual trades from the next tick.`);
    console.log(`  ⚠ Ensure the real wallet covers the strategy's amounts (tradekit trade preflight).`);
    const reply = await prompt(`Type 'promote' to continue: `);
    if (reply.trim().toLowerCase() !== "promote") {
      throw new ToolError("INVALID_PARAMS", "Promote aborted — confirmation phrase didn't match.");
    }
  }

  // v36 preflight: before flipping to REAL, ask the funding runway
  // whether the real wallet could actually fund this playbook
  // (assumeReal buckets + gas estimate). Non-gating by default;
  // --require-funded aborts on a cannot-fund-one-fire finding;
  // --skip-preflight for RPC-less environments.
  let preflight: import("../playbooks.js").PromotePreflight | null = null;
  if (to === "real" && flags["skip-preflight"] !== "true") {
    const { promotePreflight, preflightBlocker } = await import("../playbooks.js");
    try {
      preflight = await promotePreflight({ playbookId: id });
    } catch (e) {
      console.log(`  (preflight unavailable: ${(e as Error).message})`);
    }
    if (preflight) {
      if (flags["json"] !== "true") {
        if (preflight.warnings.length === 0) {
          console.log(`  Preflight: ✓ real wallet covers the playbook's upcoming fires (30d window).`);
        } else {
          console.log(`  Preflight findings:`);
          for (const w of preflight.warnings) console.log(`    ${w.includes("even ONE fire") ? "✗" : "⚠"} ${w}`);
        }
      }
      if (flags["require-funded"] === "true") {
        const blocker = preflightBlocker(preflight);
        if (blocker) throw new ToolError("INSUFFICIENT_BALANCE", blocker);
      }
    }
  }

  // v52 safety preflight: the funding preflight asks "can the wallet
  // PAY for this?"; this asks "is the wallet GUARDED while it does?".
  // Symmetric stance — advisory by default (prints the posture),
  // --require-safe aborts on a CRITICAL guardrail gap (safety off / no
  // USD ceiling), --skip-preflight disables both.
  if (to === "real" && flags["skip-preflight"] !== "true") {
    const { reviewSafety, safetyPromoteBlocker } = await import("../safetyReview.js");
    const { loadConfig } = await import("../config.js");
    const posture = reviewSafety(loadConfig());
    if (flags["json"] !== "true") {
      if (posture.verdict === "hardened") {
        console.log(`  Safety posture: ✓ hardened — no critical or warn guardrail gaps.`);
      } else {
        console.log(`  Safety posture: ${posture.verdict === "exposed" ? "⛔ EXPOSED" : "⚠ MODERATE"} (run \`tradekit safety review\` for the full audit + fixes)`);
        for (const g of posture.gaps.filter((x) => x.severity !== "info")) {
          console.log(`    ${g.severity === "critical" ? "✗" : "⚠"} ${g.finding}`);
        }
      }
    }
    if (flags["require-safe"] === "true") {
      const blocker = safetyPromoteBlocker(posture);
      if (blocker) throw new ToolError("SAFEGUARD_TRIGGERED", `Promote aborted — ${blocker}`);
    }
  }

  const { promotePlaybook } = await import("../playbooks.js");
  const result = promotePlaybook({ playbookId: id, to });

  if (flags["json"] === "true") {
    printJson({ ok: true, ...result, preflight });
    return;
  }

  if (result.alreadyInTarget) {
    console.log(`Playbook #${id} "${existing.name}" — every live primitive is already ${to}. Nothing to flip.`);
  } else {
    console.log(`Promoted playbook #${id} "${existing.name}" → ${to.toUpperCase()}`);
    console.log(`  Flipped in place (state preserved):`);
    for (const f of result.flipped) {
      console.log(`    ${f.type.padEnd(10)} #${f.rowId}`);
    }
  }
  if (result.skipped.length > 0) {
    console.log(`  Skipped:`);
    for (const sk of result.skipped) {
      console.log(`    ${sk.type.padEnd(10)} #${sk.rowId}  (${sk.reason})`);
    }
  }
  if (to === "real" && !result.alreadyInTarget) {
    console.log("");
    console.log(`  Live from the next engine tick. Sanity-check funding with \`tradekit holdings\`;`);
    console.log(`  preview the next fire with \`tradekit strategy report ${id} --sections forward\`.`);
  }
}

// ── dispatch ─────────────────────────────────────────────────

export async function playbookCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  switch (action) {
    case "validate":
      await playbookValidateCommand(flags, positional);
      break;
    case "deploy":
      await playbookDeployCommand(flags, positional);
      break;
    case "list":
      await playbookListCommand(flags);
      break;
    case "show":
      await playbookShowCommand(flags, positional);
      break;
    case "destroy":
      await playbookDestroyCommand(flags, positional);
      break;
    case "diff":
      await playbookDiffCommand(flags, positional);
      break;
    case "replace":
      await playbookReplaceCommand(flags, positional);
      break;
    case "promote":
      await playbookPromoteCommand(flags, positional);
      break;
    // v49: "is this paper strategy ready for real money?" — the
    // strategy-quality half of the promote decision (promote itself
    // runs the funding-preflight half).
    case "promote-check": {
      const idArg = positional[2];
      const id = parseInt(idArg ?? "", 10);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ToolError("INVALID_PARAMS", `Usage: tradekit playbook promote-check <id> [--json]`);
      }
      const { gatherPromoteCheck, renderPromoteCheck } = await import("../promoteCheck.js");
      // Best-effort native price so real gas can be expressed in USD;
      // failure degrades to native-only reporting.
      let nativeUsd: number | null = null;
      try {
        const { loadConfig, resolveProfile } = await import("../config.js");
        const cfg = loadConfig();
        const profile = resolveProfile(cfg.activeChain, cfg);
        if (profile.weth) {
          const { getCurrentPrice } = await import("../price.js");
          const { makeCliLogger } = await import("./helpers.js");
          nativeUsd = await getCurrentPrice(profile.weth, makeCliLogger(flags)).catch(() => null);
        }
      } catch {
        // offline / unconfigured chain — report gas in native units
      }
      const report = await gatherPromoteCheck({ playbookId: id, nativeUsd });
      if (flags["json"] === "true") {
        const { printJson } = await import("./helpers.js");
        printJson({ ok: true, ...report });
      } else {
        console.log(renderPromoteCheck(report));
      }
      break;
    }
    // v50: the BACKWARD half of the trust pipeline — "did promoting this
    // strategy deliver what the paper run promised?" Compares the frozen
    // paper baseline against the live fills, normalized per-fill + per-week.
    case "outcome": {
      const idArg = positional[2];
      const id = parseInt(idArg ?? "", 10);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ToolError("INVALID_PARAMS", `Usage: tradekit playbook outcome <id> [--json]`);
      }
      const { gatherPromoteOutcome, renderPromoteOutcome } = await import("../promoteOutcome.js");
      // Best-effort native price so live gas can be expressed in USD;
      // failure degrades to native-only reporting.
      let nativeUsd: number | null = null;
      try {
        const { loadConfig, resolveProfile } = await import("../config.js");
        const cfg = loadConfig();
        const profile = resolveProfile(cfg.activeChain, cfg);
        if (profile.weth) {
          const { getCurrentPrice } = await import("../price.js");
          const { makeCliLogger } = await import("./helpers.js");
          nativeUsd = await getCurrentPrice(profile.weth, makeCliLogger(flags)).catch(() => null);
        }
      } catch {
        // offline / unconfigured chain — report gas in native units
      }
      const report = await gatherPromoteOutcome({ playbookId: id, nativeUsd });
      if (flags["json"] === "true") {
        const { printJson } = await import("./helpers.js");
        printJson({ ok: true, ...report });
      } else {
        console.log(renderPromoteOutcome(report));
      }
      break;
    }
    default:
      throw subcommandError("playbook", action, ["validate", "deploy", "list", "show", "destroy", "diff", "replace", "promote", "promote-check", "outcome"]);
  }
}

// Expose the spec type from the CLI module too (some integration code
// finds it more natural to import from here).
export type { PlaybookSpec };
