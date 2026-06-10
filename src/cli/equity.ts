/**
 * `tradekit equity` — the equity curve in the terminal.
 *
 * Pure DB read over portfolio_snapshots; the data feed is the v37
 * engine snapshot worker (or manual `tradekit snapshot` runs).
 */

import { ToolError } from "../errors.js";
import { printJson } from "./helpers.js";
import { buildEquityCurve } from "../equity.js";
import { sparkline } from "./strategy.js";

export async function equityCommand(flags: Record<string, string>) {
  let sinceIso: string | undefined;
  if (flags["since"]) {
    const m = /^(\d+)([dhw])$/.exec(flags["since"]);
    if (m) {
      const n = parseInt(m[1], 10);
      const ms = m[2] === "h" ? 3_600_000 : m[2] === "w" ? 7 * 86_400_000 : 86_400_000;
      sinceIso = new Date(Date.now() - n * ms).toISOString();
    } else if (Number.isFinite(Date.parse(flags["since"]))) {
      sinceIso = new Date(Date.parse(flags["since"])).toISOString();
    } else {
      throw new ToolError("INVALID_PARAMS", `--since must be a duration (12h, 30d, 4w) or ISO timestamp (got "${flags["since"]}").`);
    }
  }

  const curve = buildEquityCurve({
    accountsKey: flags["accounts-key"],
    chainsKey: flags["chains-key"],
    sinceIso,
  });

  if (flags["json"] === "true") {
    printJson({ ok: true, ...curve });
    return;
  }

  if (curve.points.length === 0) {
    console.log("No portfolio snapshots in this scope/window yet.");
    console.log("Feed the curve: enable the engine snapshot worker —");
    console.log("  tradekit config set engine.workers.snapshot.enabled true");
    console.log("or record one now: tradekit snapshot");
    if (curve.availableScopes.length > 0) {
      console.log("\nScopes with data:");
      for (const s of curve.availableScopes) {
        console.log(`  --accounts-key "${s.accountsKey}" --chains-key "${s.chainsKey}"  (${s.count} snapshots, last ${s.lastAt.slice(0, 10)})`);
      }
    }
    return;
  }

  const fmt = (n: number | null) => (n == null ? "—" : `$${n.toFixed(2)}`);
  console.log(`Equity — scope ${curve.accountsKey} × ${curve.chainsKey}${curve.scopeSource === "defaulted" ? " (most-snapshotted scope; pin with --accounts-key/--chains-key)" : ""}`);
  console.log("");
  console.log(`  ${sparkline(curve.points.map((p) => p.totalUsd), 56)}`);
  console.log(`  ${curve.firstAt?.slice(0, 10)} → ${curve.lastAt?.slice(0, 10)} · ${curve.points.length} points`);
  console.log("");
  const sign = (curve.changeAbs ?? 0) >= 0 ? "+" : "";
  console.log(`  now ${fmt(curve.lastUsd)} · start ${fmt(curve.firstUsd)} · change ${sign}${fmt(curve.changeAbs)?.replace("$", "$")} (${sign}${curve.changePct?.toFixed(2) ?? "—"}%)`);
  console.log(`  peak ${fmt(curve.peakUsd)}${curve.peakAt ? ` on ${curve.peakAt.slice(0, 10)}` : ""} · max drawdown ${curve.maxDrawdownPct?.toFixed(2) ?? "—"}%`);
  if (curve.availableScopes.length > 1) {
    console.log(`\n  (${curve.availableScopes.length - 1} other scope(s) have snapshots — see --json availableScopes)`);
  }
}
