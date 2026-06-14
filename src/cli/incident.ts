/**
 * `tradekit incident` — the one-command postmortem (v39).
 */

import { writeFileSync } from "node:fs";
import { printJson } from "./helpers.js";
import { parseWindowMs } from "../digest.js";
import { gatherIncidentReport, renderIncidentMarkdown } from "../incident.js";

export async function incidentCommand(flags: Record<string, string>) {
  const windowLabel = flags["window"] ?? "4h";
  const windowMs = parseWindowMs(windowLabel);
  const report = await gatherIncidentReport({
    windowLabel,
    windowMs,
    strategy: flags["strategy"],
  });

  if (flags["json"] === "true") {
    printJson({ ok: true, ...report });
    return;
  }
  const md = renderIncidentMarkdown(report);
  if (flags["out"]) {
    writeFileSync(flags["out"], md + "\n", "utf8");
    console.log(`Incident report → ${flags["out"]}  (verdict: ${report.digest.verdict}, ${report.events.length} warn+ events, ${report.configChanges.length} config change(s))`);
  } else {
    console.log(md);
  }
}
