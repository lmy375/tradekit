/**
 * `tradekit export gains` — the realized-gains CSV (v36).
 *
 * CSV goes to stdout (pipeable) or --out FILE; the summary +
 * method disclaimers go to stderr so they never corrupt the data
 * stream.
 */

import { writeFileSync } from "node:fs";
import { ToolError } from "../errors.js";
import { printJson, subcommandError } from "./helpers.js";
import { gatherRealizedGains, gainsToCsv, yearWindow } from "../gains.js";
import { LONG_TERM_DAYS } from "../paperPnl.js";

export async function exportCommand(
  action: string | undefined,
  flags: Record<string, string>,
) {
  switch (action) {
    case "gains": {
      let sinceIso: string | undefined;
      let untilIso: string | undefined;
      if (flags["year"]) {
        if (flags["since"] || flags["until"]) {
          throw new ToolError("INVALID_PARAMS", "Use --year OR --since/--until, not both.");
        }
        const w = yearWindow(parseInt(flags["year"], 10));
        sinceIso = w.sinceIso;
        untilIso = w.untilIso;
      } else {
        if (flags["since"]) {
          if (!Number.isFinite(Date.parse(flags["since"]))) {
            throw new ToolError("INVALID_PARAMS", `--since must be an ISO timestamp (got "${flags["since"]}").`);
          }
          sinceIso = new Date(Date.parse(flags["since"])).toISOString();
        }
        if (flags["until"]) {
          if (!Number.isFinite(Date.parse(flags["until"]))) {
            throw new ToolError("INVALID_PARAMS", `--until must be an ISO timestamp (got "${flags["until"]}").`);
          }
          untilIso = new Date(Date.parse(flags["until"])).toISOString();
        }
      }
      const mode = (flags["mode"] as "real" | "paper" | undefined) ?? "real";
      if (mode !== "real" && mode !== "paper") {
        throw new ToolError("INVALID_PARAMS", `--mode must be real | paper.`);
      }

      const report = await gatherRealizedGains({
        mode,
        account: flags["account"],
        chain: flags["chain"],
        strategy: flags["strategy"],
        sinceIso,
        untilIso,
      });

      if (flags["json"] === "true") {
        printJson({ ok: true, ...report });
        return;
      }

      const csv = gainsToCsv(report.records);
      if (flags["out"]) {
        writeFileSync(flags["out"], csv, "utf8");
        console.log(`Wrote ${report.records.length} realization(s) → ${flags["out"]}`);
      } else {
        process.stdout.write(csv);
      }
      // Summary + disclaimers on stderr — never corrupts a piped CSV.
      const fmt = (n: number) => n.toFixed(2);
      console.error("");
      console.error(`  ${report.records.length} realization(s)${sinceIso ? ` in ${sinceIso.slice(0, 10)} → ${(untilIso ?? "now").slice(0, 10)}` : ""} (${mode})`);
      console.error(`  total gain ${fmt(report.totalGainQuote)} · proceeds ${fmt(report.totalProceedsQuote)} · cost basis ${fmt(report.totalCostBasisQuote)}`);
      // v60: short/long-term split — the headline tax distinction.
      const t = report.byTerm;
      console.error(
        `  short-term gain ${fmt(t.short.gainQuote)} (${t.short.realizations}) · long-term gain ${fmt(t.long.gainQuote)} (${t.long.realizations})` +
          (t.untracked.realizations > 0 ? ` · untracked ${t.untracked.realizations}` : ""),
      );
      if (report.byToken.length > 0) {
        console.error(`  by asset:`);
        for (const tok of report.byToken) {
          console.error(`    ${(tok.symbol ?? tok.token).padEnd(8)} gain ${fmt(tok.gainQuote)} · proceeds ${fmt(tok.proceedsQuote)} (${tok.realizations} sale${tok.realizations === 1 ? "" : "s"})`);
        }
      }
      if (report.totalUntrackedProceedsQuote > 0) {
        console.error(`  ⚠ untracked-sell proceeds ${fmt(report.totalUntrackedProceedsQuote)} (no cost basis — NOT in the gain total)`);
      }
      if (report.skippedNonStableQuote > 0) {
        console.error(`  ⚠ ${report.skippedNonStableQuote} fill(s) skipped (non-stablecoin quote)`);
      }
      console.error(`  method: WEIGHTED-AVERAGE cost basis (holding period is a weighted-avg estimate, NOT lot-based FIFO; long-term = held > ${LONG_TERM_DAYS}d) · gas excluded · not tax advice`);
      return;
    }
    default:
      throw subcommandError("export", action, ["gains"]);
  }
}
