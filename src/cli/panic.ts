/**
 * `tradekit panic` — the emergency stop.
 *
 * Confirmation discipline: pausing is reversible, so plain panic
 * asks a y/N (skippable with --yes, auto-skipped non-TTY for cron
 * wiring). --cancel-orders is TERMINAL and always requires --yes —
 * an interactive prompt under stress invites mistakes in BOTH
 * directions, so the destructive variant demands the explicit flag.
 */

import { ToolError } from "../errors.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { printJson } from "./helpers.js";
import { createInterface } from "node:readline/promises";

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true; // non-interactive (cron/script) — flags gate instead
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export async function panicCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  const config = loadConfig();
  const logger = createLogger({ stderrLevel: "warn" });

  if (action === "release") {
    const resumeAll = flags["resume-all"] === "true";
    if (resumeAll && flags["yes"] !== "true") {
      const ok = await confirm("Resume EVERY paused primitive (orders, schedules, rebalance plans)?");
      if (!ok) { console.log("Aborted."); return; }
    }
    const { releasePanic } = await import("../panic.js");
    const report = await releasePanic({ resumeAll, config, logger });
    if (flags["json"] === "true") { printJson({ ok: true, ...report }); return; }
    console.log(`Engine unlocked.`);
    if (resumeAll) {
      const n = report.resumed.orders.length + report.resumed.schedules.length + report.resumed.rebalances.length;
      console.log(`Resumed ${n} primitive(s): ${report.resumed.orders.length} order(s), ${report.resumed.schedules.length} schedule(s), ${report.resumed.rebalances.length} rebalance plan(s).`);
    } else {
      console.log(`Primitives remain PAUSED — resume selectively:`);
      console.log(`  tradekit strategy resume <tag>   ·  tradekit order resume <id>  ·  tradekit schedule resume <id>`);
    }
    return;
  }

  if (action != null && action !== "") {
    throw new ToolError("INVALID_PARAMS", `Unknown panic action "${action}". Usage: tradekit panic [release] [--reason "..."] [--cancel-orders] [--resume-all] [--yes]`);
  }
  void positional;

  const cancelOrders = flags["cancel-orders"] === "true";
  if (cancelOrders && flags["yes"] !== "true") {
    throw new ToolError(
      "INVALID_PARAMS",
      "--cancel-orders is TERMINAL (cancelled orders cannot be resumed). It requires the explicit --yes flag.",
    );
  }
  if (!cancelOrders && flags["yes"] !== "true") {
    const ok = await confirm("Lock the engine and pause EVERYTHING active?");
    if (!ok) { console.log("Aborted."); return; }
  }

  const { executePanic } = await import("../panic.js");
  const report = await executePanic({
    reason: flags["reason"],
    cancelOrders,
    config,
    logger,
  });

  if (flags["json"] === "true") { printJson({ ok: true, ...report }); return; }
  console.log(`PANIC engaged${report.reason ? ` (${report.reason})` : ""}.`);
  console.log(`  engine: LOCKED${report.alreadyLocked ? " (was already locked)" : ""}`);
  console.log(`  paused: ${report.paused.orders.length} order(s), ${report.paused.schedules.length} schedule(s), ${report.paused.rebalances.length} rebalance plan(s)`);
  if (report.cancelledOrders.length > 0) {
    console.log(`  CANCELLED (terminal): ${report.cancelledOrders.length} order(s): #${report.cancelledOrders.join(", #")}`);
  }
  console.log(`\nRelease: tradekit panic release        (unlock; everything stays paused)`);
  console.log(`         tradekit panic release --resume-all   (false alarm — resume everything)`);
}
