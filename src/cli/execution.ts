/**
 * `tradekit execution` — execution quality report (v44).
 *
 * Turns the per-fill forensics every real trade already records
 * (realized slippage, aggregator, gas) into the production decisions
 * they can answer: aggregator choice, order sizing, degradation.
 */

import { ToolError } from "../errors.js";
import { printJson } from "./helpers.js";

export async function executionCommand(flags: Record<string, string>) {
  const windowLabel = flags["since"] ?? "30d";
  const { parseSinceDuration } = await import("../timeline.js");
  const sinceIso = parseSinceDuration(windowLabel);
  if (!sinceIso) {
    throw new ToolError("INVALID_PARAMS", `--since must be a duration (30d, 12h) or ISO timestamp (got "${windowLabel}").`);
  }

  const { gatherExecutionReport, renderExecutionReport } = await import("../executionReport.js");
  const report = gatherExecutionReport({
    windowLabel,
    sinceIso,
    chain: flags["chain"],
    account: flags["account"],
  });

  if (flags["json"] === "true") {
    printJson({ ok: true, ...report });
    return;
  }
  console.log(renderExecutionReport(report));
}
