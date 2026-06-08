// CLI surface for bulk halt/resume primitives (iter37).
//
// Subactions:
//
//   tradekit bulk halt [--strategy X] [--chain Y] [--account Z]
//                      [--types orders,schedules,rebalances]
//                      [--dry-run] [--yes] [--json]
//        Cancel all matching orders + pause matching schedules +
//        pause matching rebalance plans, atomically. At least one
//        filter scope (or --all) is required.
//
//   tradekit bulk resume [--strategy X] [--chain Y] [--account Z]
//                        [--types schedules,rebalances]
//                        [--dry-run] [--yes] [--json]
//        Re-enable paused schedules + rebalances. Cancelled orders
//        are terminal — recreate via `order create` instead.

import { ToolError } from "../errors.js";
import { loadConfig } from "../config.js";
import { tryNotify } from "../notify.js";
import { createLogger } from "../logger.js";
import {
  planHalt,
  executeHalt,
  planResume,
  executeResume,
  type BulkHaltFilter,
  type BulkPrimitiveType,
  type BulkHaltPlan,
  type BulkResumePlan,
  type BulkResult,
  type PlannedAction,
} from "../bulkOps.js";
import { printJson, prompt, subcommandError } from "./helpers.js";

const VALID_TYPES: BulkPrimitiveType[] = ["orders", "schedules", "rebalances"];

function parseTypes(raw: string | undefined, allowOrders = true): BulkPrimitiveType[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out: BulkPrimitiveType[] = [];
  for (const p of parts) {
    if (!VALID_TYPES.includes(p as BulkPrimitiveType)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--types includes unknown "${p}"; valid: ${VALID_TYPES.join(", ")}.`,
      );
    }
    if (!allowOrders && p === "orders") {
      throw new ToolError(
        "INVALID_PARAMS",
        "Bulk resume cannot include 'orders' — cancelled orders are terminal. Recreate via 'order create' or 'playbook replace'.",
      );
    }
    out.push(p as BulkPrimitiveType);
  }
  return out.length ? out : undefined;
}

function filterFromFlags(flags: Record<string, string>, opts: { allowOrders?: boolean } = {}): BulkHaltFilter {
  return {
    strategy: flags["strategy"],
    chain: flags["chain"],
    account: flags["account"],
    types: parseTypes(flags["types"], opts.allowOrders ?? true),
    all: flags["all"] === "true",
  };
}

// ── plan renderers ──────────────────────────────────────────

function describeFilter(f: BulkHaltFilter): string {
  const parts: string[] = [];
  if (f.strategy) parts.push(`strategy=${f.strategy}`);
  if (f.chain) parts.push(`chain=${f.chain}`);
  if (f.account) parts.push(`account=${f.account}`);
  if (f.types && f.types.length > 0) parts.push(`types=${f.types.join(",")}`);
  if (f.all) parts.push("all");
  return parts.length ? parts.join(" ") : "(unscoped)";
}

function renderActions(actions: PlannedAction[]): void {
  // Group by type so the operator sees the categorical breakdown
  // before per-row detail.
  const groups: Record<string, PlannedAction[]> = {};
  for (const a of actions) {
    const key = a.type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(a);
  }
  for (const type of ["order", "schedule", "rebalance"] as const) {
    const list = groups[type];
    if (!list || list.length === 0) continue;
    console.log("");
    console.log(`  ${type}s:`);
    for (const a of list) {
      const badge =
        a.operation === "cancel"
          ? "✕"
          : a.operation === "pause"
            ? "⏸"
            : a.operation === "resume"
              ? "▶"
              : "·";
      const tag = a.operation.padEnd(7);
      console.log(`    ${badge} ${tag} #${String(a.id).padEnd(5)} ${a.summary}  (${a.reason})`);
    }
  }
}

function renderHaltPlanText(plan: BulkHaltPlan): void {
  console.log(`Bulk halt plan: ${describeFilter(plan.filter)}`);
  console.log("");
  console.log(`  Would affect ${plan.summary.wouldAffect} primitive(s):`);
  console.log(`    orders     to cancel: ${plan.summary.byType.orders.wouldCancel}`);
  console.log(`    schedules  to pause:  ${plan.summary.byType.schedules.wouldPause}`);
  console.log(`    rebalances to pause:  ${plan.summary.byType.rebalances.wouldPause}`);
  if (plan.summary.skippedAlreadyTerminal > 0) {
    console.log(`  Skipped (already terminal): ${plan.summary.skippedAlreadyTerminal}`);
    for (const [reason, count] of Object.entries(plan.summary.skippedReasons)) {
      console.log(`    ${reason}: ${count}`);
    }
  }
  renderActions(plan.actions);
}

function renderResumePlanText(plan: BulkResumePlan): void {
  console.log(`Bulk resume plan: ${describeFilter(plan.filter)}`);
  console.log("");
  console.log(`  Would resume ${plan.summary.wouldAffect} primitive(s):`);
  console.log(`    schedules:  ${plan.summary.byType.schedules.wouldResume}`);
  console.log(`    rebalances: ${plan.summary.byType.rebalances.wouldResume}`);
  if (plan.summary.skipped > 0) {
    console.log(`  Skipped (not paused): ${plan.summary.skipped}`);
  }
  renderActions(plan.actions);
}

function renderResult(label: string, result: BulkResult): void {
  console.log("");
  console.log(
    `${label}: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.errors.length} error(s).`,
  );
  if (result.errors.length > 0) {
    console.log("");
    console.log("Errors:");
    for (const e of result.errors) {
      console.log(`  ✕ ${e.type} #${e.id}: ${e.message}`);
    }
  }
}

// ── confirmation prompts ───────────────────────────────────

async function confirmHalt(plan: BulkHaltPlan): Promise<boolean> {
  if (plan.summary.wouldAffect === 0) {
    console.log("");
    console.log("Nothing to halt (all matching primitives are already terminal or paused).");
    return false;
  }
  console.log("");
  const ans = await prompt(
    `Type 'halt' to confirm halting ${plan.summary.wouldAffect} primitive(s): `,
  );
  return ans.trim().toLowerCase() === "halt";
}

async function confirmResume(plan: BulkResumePlan): Promise<boolean> {
  if (plan.summary.wouldAffect === 0) {
    console.log("");
    console.log("Nothing to resume (no matching paused primitives).");
    return false;
  }
  console.log("");
  const ans = await prompt(
    `Type 'resume' to confirm resuming ${plan.summary.wouldAffect} primitive(s): `,
  );
  return ans.trim().toLowerCase() === "resume";
}

// ── halt subcommand ─────────────────────────────────────────

async function bulkHaltCommand(flags: Record<string, string>): Promise<void> {
  const filter = filterFromFlags(flags);
  const plan = planHalt(filter);

  const isJson = flags["json"] === "true";
  const isDryRun = flags["dry-run"] === "true";

  if (isJson && isDryRun) {
    printJson({ ok: true, dryRun: true, plan });
    return;
  }
  if (isDryRun) {
    renderHaltPlanText(plan);
    console.log("");
    console.log("(dry-run — no changes applied)");
    return;
  }
  if (!isJson) {
    renderHaltPlanText(plan);
  }
  // Auto-confirm in JSON mode (assumed machine-driven); otherwise
  // require typed confirmation unless --yes.
  const wantsAutoConfirm = isJson || flags["yes"] === "true";
  if (plan.summary.wouldAffect === 0) {
    if (isJson) {
      printJson({ ok: true, plan, applied: 0, skipped: plan.actions.length, errors: 0 });
    } else {
      console.log("");
      console.log("Nothing to halt — all matching primitives are already terminal or paused.");
    }
    return;
  }
  if (!wantsAutoConfirm) {
    const confirmed = await confirmHalt(plan);
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = executeHalt(plan);

  // Emit a bulk-level notification so the team sees one row in
  // Slack rather than N per-primitive cancels (which the
  // underlying helpers don't notify on anyway — but operators
  // running bulk ops want a clear audit signal that THIS bulk
  // action happened).
  try {
    const config = loadConfig();
    const logger = createLogger({ stderrLevel: isJson ? "silent" : "info" });
    await tryNotify(
      {
        event: "bulk.halt",
        severity: result.applied.length > 0 ? "warn" : "info",
        title: `Bulk halt: ${result.applied.length} primitive(s) — ${describeFilter(filter)}`,
        body:
          result.errors.length > 0
            ? `${result.errors.length} error(s) during execution; see audit_log for detail.`
            : undefined,
        fields: {
          applied: result.applied.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
          strategy: filter.strategy ?? null,
          chain: filter.chain ?? null,
          account: filter.account ?? null,
        },
        dedupKey: `bulk.halt:${new Date().toISOString().slice(0, 19)}`,
      },
      config,
      logger,
    );
  } catch {
    // Best-effort. Bulk halt success doesn't depend on notify
    // delivery.
  }

  if (isJson) {
    printJson({
      ok: result.ok,
      plan,
      applied: result.applied.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
      errorDetails: result.errors,
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  renderResult("Bulk halt", result);
  if (!result.ok) process.exitCode = 1;
}

// ── resume subcommand ───────────────────────────────────────

async function bulkResumeCommand(flags: Record<string, string>): Promise<void> {
  const filter = filterFromFlags(flags, { allowOrders: false });
  const plan = planResume(filter);

  const isJson = flags["json"] === "true";
  const isDryRun = flags["dry-run"] === "true";

  if (isJson && isDryRun) {
    printJson({ ok: true, dryRun: true, plan });
    return;
  }
  if (isDryRun) {
    renderResumePlanText(plan);
    console.log("");
    console.log("(dry-run — no changes applied)");
    return;
  }
  if (!isJson) {
    renderResumePlanText(plan);
  }
  const wantsAutoConfirm = isJson || flags["yes"] === "true";
  if (plan.summary.wouldAffect === 0) {
    if (isJson) {
      printJson({ ok: true, plan, applied: 0, skipped: plan.actions.length, errors: 0 });
    } else {
      console.log("");
      console.log("Nothing to resume — no matching paused primitives.");
    }
    return;
  }
  if (!wantsAutoConfirm) {
    const confirmed = await confirmResume(plan);
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = executeResume(plan);

  try {
    const config = loadConfig();
    const logger = createLogger({ stderrLevel: isJson ? "silent" : "info" });
    await tryNotify(
      {
        event: "bulk.resume",
        severity: "info",
        title: `Bulk resume: ${result.applied.length} primitive(s) — ${describeFilter(filter)}`,
        fields: {
          applied: result.applied.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
          strategy: filter.strategy ?? null,
          chain: filter.chain ?? null,
          account: filter.account ?? null,
        },
        dedupKey: `bulk.resume:${new Date().toISOString().slice(0, 19)}`,
      },
      config,
      logger,
    );
  } catch {
    // best-effort
  }

  if (isJson) {
    printJson({
      ok: result.ok,
      plan,
      applied: result.applied.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
      errorDetails: result.errors,
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  renderResult("Bulk resume", result);
  if (!result.ok) process.exitCode = 1;
}

// ── dispatch ────────────────────────────────────────────────

export async function bulkCommand(
  action: string | undefined,
  flags: Record<string, string>,
  _positional: string[],
): Promise<void> {
  switch (action) {
    case "halt":
      await bulkHaltCommand(flags);
      break;
    case "resume":
      await bulkResumeCommand(flags);
      break;
    default:
      throw subcommandError("bulk", action, ["halt", "resume"]);
  }
}
