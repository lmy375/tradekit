/**
 * `tradekit runway` — funding-runway forecast for live automation.
 *
 * Answers "will my automation run out of money, and when?" BEFORE
 * the first fire_failed: walks upcoming schedule fires + reserved
 * order spends against current balances (paper book for paper
 * primitives, on-chain for real ones).
 */

import { ToolError } from "../errors.js";
import { printJson } from "./helpers.js";
import { computeFundingRunway, defaultRunwayBalanceFetcher, type TokenRunwayBucket } from "../runway.js";
import { loadConfig } from "../config.js";

export async function runwayCommand(flags: Record<string, string>) {
  const horizonDays = flags["days"] ? parseInt(flags["days"], 10) : 90;
  if (!Number.isFinite(horizonDays) || horizonDays <= 0 || horizonDays > 366) {
    throw new ToolError("INVALID_PARAMS", `--days must be an integer in [1, 366] (got "${flags["days"]}").`);
  }
  const config = loadConfig();
  const report = await computeFundingRunway({
    chain: flags["chain"],
    account: flags["account"],
    strategy: flags["strategy"],
    horizonDays,
    balanceFetcher: defaultRunwayBalanceFetcher(config),
  });

  if (flags["json"] === "true") {
    printJson({ ok: true, ...report });
    return;
  }

  if (report.buckets.length === 0) {
    console.log("No active schedules or orders with a computable spend — nothing to forecast.");
    if (report.skipped.length > 0) {
      console.log(`(${report.skipped.length} primitive(s) skipped — spend sized in the opposite denomination)`);
    }
    return;
  }

  console.log(`Funding runway (next ${report.horizonDays}d, generated ${report.generatedAt})\n`);
  for (const b of report.buckets) {
    console.log(renderBucket(b, horizonDays));
  }
  if (report.gas.length > 0) {
    console.log("Gas (native, REAL fires only — estimate from recent trade history):\n");
    for (const g of report.gas) {
      const scope = `${g.account}/${g.chain}`;
      let verdict: string;
      if (g.balance == null) verdict = "?  native balance unknown";
      else if (g.avgGasPerFire == null) verdict = `?  no gas history yet (balance ${trimNum(g.balance)})`;
      else if (g.exhaustsAt != null) {
        const marker = (g.runwayDays ?? 0) <= 7 ? "✗" : "⚠";
        verdict = `${marker}  gas runs out ~${g.exhaustsAt.slice(0, 10)} (${g.runwayDays!.toFixed(1)}d) — covers ${g.firesCovered}/${g.totalFiresInHorizon} fires`;
      } else verdict = `✓  gas survives the horizon (${g.totalFiresInHorizon} fires)`;
      console.log(`⛽ ${scope}`);
      console.log(`  ${verdict}`);
      const parts: string[] = [];
      if (g.balance != null) parts.push(`balance ${trimNum(g.balance)}`);
      if (g.avgGasPerFire != null) parts.push(`~${trimNum(g.avgGasPerFire)}/fire (n=${g.gasSamples})`);
      if (g.oneShotOrders > 0) parts.push(`${g.oneShotOrders} one-shot order(s) reserved`);
      if (parts.length) console.log(`  ${parts.join("  ·  ")}`);
      console.log("");
    }
  }
  if (report.skipped.length > 0) {
    console.log("Skipped (spend needs a price — sized in the opposite denomination):");
    for (const s of report.skipped) {
      console.log(`  ${s.kind} #${s.id}: ${s.reason}`);
    }
  }
}

function renderBucket(b: TokenRunwayBucket, horizonDays: number): string {
  const sym = b.symbol ?? (b.token === "native" ? "native" : `${b.token.slice(0, 8)}…`);
  const scope = `${b.account}/${b.chain}${b.paper ? " [paper]" : ""}`;
  const lines: string[] = [];

  let verdict: string;
  if (b.balance == null) {
    verdict = "?  balance unknown (fetch failed)";
  } else if (b.exhaustsAt != null) {
    const days = b.runwayDays!;
    const marker = days <= 7 ? "✗" : "⚠";
    verdict = `${marker}  runs out ${b.exhaustsAt.slice(0, 10)} (${days.toFixed(1)}d) — covers ${b.firesCovered}/${b.totalFiresInHorizon} fires`;
  } else {
    verdict = `✓  survives the ${horizonDays}d horizon (${b.totalFiresInHorizon} fires)`;
  }

  lines.push(`${sym}  ·  ${scope}`);
  lines.push(`  ${verdict}`);
  const bal = b.balance == null ? "?" : b.balance.toFixed(6).replace(/\.?0+$/, "");
  const parts = [`balance ${bal}`];
  if (b.oneShotReserved > 0) parts.push(`one-shot reserved ${trimNum(b.oneShotReserved)}`);
  if (b.burn30d > 0) parts.push(`burn/30d ${trimNum(b.burn30d)}`);
  lines.push(`  ${parts.join("  ·  ")}`);
  for (const o of b.obligations) {
    const cadence = o.cron ? `cron "${o.cron}"` : "one-shot";
    const tag = o.strategy ? `  [${o.strategy}]` : "";
    lines.push(`    ${o.kind} #${o.id}${o.name ? ` (${o.name})` : ""}: ${trimNum(o.amountPerFire)} per fire, ${cadence}${tag}`);
  }
  lines.push("");
  return lines.join("\n");
}

function trimNum(n: number): string {
  return n.toFixed(6).replace(/\.?0+$/, "");
}
