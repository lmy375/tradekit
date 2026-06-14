// CLI surface for `tradekit digest`.
//
//   tradekit digest [--window 1h|24h|7d|30d] [--format text|slack|json]
//                   [--compare] [--strict] [--quiet]
//
// Produces a windowed activity report. The text format is the default
// terminal-readable output. The slack format produces markdown
// suitable for direct piping into a Slack incoming-webhook (operators
// pipe the output into curl).
//
// --strict exits 1 on a 🔴 critical verdict — cron alert gate.

import { ToolError } from "../errors.js";
import {
  gatherDigest,
  parseWindowMs,
  verdictEmoji,
  verdictLabel,
  type DigestReport,
  type TradesSection,
  type FiresSection,
  type SafetyEventsSection,
  type ErrorsSection,
} from "../digest.js";
import { printJson } from "./helpers.js";

// ── shared formatters ────────────────────────────────────────

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (Math.abs(n) >= 1000) {
    return `$${(n / 1000).toFixed(1)}k`;
  }
  return `$${n.toFixed(2)}`;
}

function fmtSigned(n: number): string {
  if (!Number.isFinite(n)) return "?";
  return (n >= 0 ? "+" : "") + n.toString();
}

function fmtSignedUsd(n: number): string {
  return (n >= 0 ? "+" : "") + fmtUsd(n);
}

function shorten(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z").replace("Z", " UTC");
}

// ── text renderer ────────────────────────────────────────────

function renderText(r: DigestReport): string {
  const lines: string[] = [];
  lines.push(`TRADEKIT DIGEST — ${r.windowLabel}  ${verdictEmoji(r.verdict)} ${verdictLabel(r.verdict)}`);
  lines.push(`  ${shorten(r.windowStart)} → ${shorten(r.windowEnd)}`);
  if (r.verdictReasons.length > 0) {
    lines.push(``);
    lines.push(`  Reasons:`);
    for (const reason of r.verdictReasons) {
      lines.push(`    • ${reason}`);
    }
  }
  lines.push(``);
  lines.push(renderTradesText(r.trades, r.comparison?.prior?.trades));
  lines.push(``);
  lines.push(renderFiresText(r.fires, r.comparison?.prior?.fires));
  // v47.5: approval-queue activity — pendingNow is actionable NOW.
  if (r.intents.pendingNow > 0 || r.intents.createdInWindow > 0 || r.intents.expiredInWindow > 0) {
    const parts = [`${r.intents.createdInWindow} proposed`];
    if (r.intents.executedInWindow > 0) parts.push(`${r.intents.executedInWindow} approved+executed`);
    if (r.intents.rejectedInWindow > 0) parts.push(`${r.intents.rejectedInWindow} rejected`);
    if (r.intents.expiredInWindow > 0) parts.push(`${r.intents.expiredInWindow} EXPIRED un-reviewed ⚠`);
    lines.push(`  Agent intents:    ${parts.join(" / ")}${r.intents.pendingNow > 0 ? `  — ${r.intents.pendingNow} AWAITING APPROVAL${r.intents.oldestPendingMinutes != null ? ` (oldest ${Math.round(r.intents.oldestPendingMinutes)}min)` : ""} ⚠` : ""}`);
  }
  lines.push(``);
  lines.push(renderSafetyText(r.safety));
  if (r.posture) {
    const v = { hardened: "🛡 hardened", moderate: "⚠ moderate", exposed: "⛔ EXPOSED" }[r.posture.verdict];
    lines.push(`  Posture:          ${v} (${r.posture.criticalGaps} critical, ${r.posture.warnGaps} warn gaps)${r.posture.topGap ? ` — ${r.posture.topGap}` : ""}`);
    if (r.posture.binding && r.posture.binding.status !== "ok") {
      const b = r.posture.binding;
      lines.push(`  Binding limit:    ${b.label} (${b.scope}) ${b.status}${b.utilizationPct != null ? ` ${b.utilizationPct.toFixed(0)}%` : ""}`);
    }
  }
  lines.push(``);
  lines.push(renderAlertsText(r.alerts));
  lines.push(``);
  lines.push(renderEquityText(r.equity));
  lines.push(``);
  lines.push(renderPaperText(r.paper));
  lines.push(``);
  lines.push(renderErrorsText(r.errors));
  if (r.comparison) {
    lines.push(``);
    lines.push(`COMPARISON vs prior ${r.windowLabel}:`);
    lines.push(`  Trades:        ${r.trades.total} (${fmtSigned(r.comparison.delta.trades)})`);
    lines.push(`  USD volume:    ${fmtUsd(r.trades.usdVolume)} (${fmtSignedUsd(r.comparison.delta.usdVolume)})`);
    lines.push(`  Orders filled: ${r.fires.ordersFilled} (${fmtSigned(r.comparison.delta.ordersFilled)})`);
    lines.push(`  Audit errors:  ${r.errors.errorRows} (${fmtSigned(r.comparison.delta.errorRows)})`);
    lines.push(`  Alerts fired:  ${r.alerts.fired} (${fmtSigned(r.comparison.delta.alertsFired)})`);
    lines.push(`  Paper fills:   ${r.paper.fills} (${fmtSigned(r.comparison.delta.paperFills)})`);
  }
  return lines.join("\n");
}

function renderTradesText(t: TradesSection, prior?: TradesSection): string {
  const lines: string[] = [];
  const deltaTotal = prior ? `  (${fmtSigned(t.total - prior.total)})` : "";
  lines.push(`TRADES  ${t.total} total${deltaTotal}  (${t.success} success, ${t.pending} pending, ${t.failed} failed)`);
  if (t.total === 0) {
    lines.push(`  No trades in window.`);
    return lines.join("\n");
  }
  lines.push(`  USD volume:    ${fmtUsd(t.usdVolume)}`);
  lines.push(`  Success rate:  ${t.successRatePct.toFixed(1)}%`);
  if (t.topStrategies.length > 0) {
    lines.push(`  Top strategies:`);
    for (const s of t.topStrategies) {
      lines.push(`    ${s.strategy.padEnd(20)} ${String(s.count).padStart(3)} trade${s.count === 1 ? "" : "s"}  ${fmtUsd(s.usdVolume)}`);
    }
  }
  if (t.topBases.length > 0) {
    lines.push(`  Top bases:     ${t.topBases.map((b) => `${b.symbol}×${b.count}`).join("  ")}`);
  }
  return lines.join("\n");
}

function renderFiresText(f: FiresSection, prior?: FiresSection): string {
  const lines: string[] = [];
  lines.push(`STRATEGY FIRES`);
  const orderDelta = prior ? `  (${fmtSigned(f.ordersFilled - prior.ordersFilled)})` : "";
  if (f.ordersFilled + f.ordersCancelled + f.ordersExpired + f.ordersFailed === 0
      && f.schedulesFired === 0 && f.rebalanceRuns === 0) {
    lines.push(`  No strategy fires in window.`);
    return lines.join("\n");
  }
  if (f.ordersFilled > 0) lines.push(`  Orders filled:    ${f.ordersFilled}${orderDelta}`);
  if (f.ordersCancelled > 0) lines.push(`  Orders cancelled: ${f.ordersCancelled}`);
  if (f.ordersExpired > 0) lines.push(`  Orders expired:   ${f.ordersExpired}`);
  if (f.ordersFailed > 0) lines.push(`  Orders failed:    ${f.ordersFailed}  ⚠`);
  if (f.schedulesFired > 0) {
    const exact = f.scheduleJournalEnabled ? `  (${f.scheduleFireCount} fire${f.scheduleFireCount === 1 ? "" : "s"} exact)` : "";
    lines.push(`  Schedules fired:  ${f.schedulesFired}${exact}`);
  }
  if (f.scheduleFireFailures > 0) lines.push(`  Schedule failures: ${f.scheduleFireFailures}  ⚠`);
  if (f.scheduleHookFailures > 0) lines.push(`  Hook failures:    ${f.scheduleHookFailures}  ⚠`);
  if (f.rebalanceRuns > 0) {
    const exact = f.rebalanceJournalEnabled
      ? `  (${f.rebalanceExecutedCount} fired / ${f.rebalanceInBandCount} in-band exact)`
      : "";
    lines.push(`  Rebalance runs:   ${f.rebalanceRuns}${exact}`);
  }
  if (f.rebalanceFailureCount > 0) lines.push(`  Rebalance failures: ${f.rebalanceFailureCount}  ⚠`);
  if (f.signalsReceived > 0) {
    const unclaimed = f.signalsReceived - f.signalsFired;
    lines.push(`  Signals received: ${f.signalsReceived} (${f.signalsFired} fired${unclaimed > 0 ? `, ${unclaimed} fired NOTHING ⚠` : ""})`);
  }
  if (f.recentFills.length > 0) {
    lines.push(`  Recent fills:`);
    for (const fill of f.recentFills) {
      const price = fill.fillPrice != null ? `@${fmtUsd(fill.fillPrice)}` : "";
      const pair = `${fill.base ?? "?"}/${fill.quote ?? "?"}`;
      lines.push(`    #${String(fill.orderId).padEnd(4)} ${fill.side.padEnd(4)} ${pair.padEnd(10)} ${price.padStart(10)}  ${shorten(fill.filledAt)}`);
    }
  }
  return lines.join("\n");
}

function renderAlertsText(a: import("../digest.js").AlertsSection): string {
  const lines: string[] = [];
  lines.push(`ALERTS`);
  if (a.fired === 0 && a.resolved === 0 && a.currentlyActive === 0) {
    lines.push(`  No alert activity in window.`);
    return lines.join("\n");
  }
  lines.push(`  Fired:    ${a.fired}${a.fired > 0 ? "  ⚠" : ""}`);
  lines.push(`  Resolved: ${a.resolved}`);
  lines.push(`  Active:   ${a.currentlyActive}${a.currentlyActive > 0 ? "  ⚠" : ""}`);
  if (a.topRules.length > 0) {
    lines.push(`  Top rules: ${a.topRules.map((t) => `${t.ruleType}×${t.fired}`).join("  ")}`);
  }
  return lines.join("\n");
}

function renderEquityText(e: import("../digest.js").EquitySection | null): string {
  if (!e) return `EQUITY: no snapshot feed in this window (enable engine.workers.snapshot)`;
  const sign = e.changeAbs >= 0 ? "+" : "";
  return (
    `EQUITY (${e.accountsKey} × ${e.chainsKey}):\n` +
    `  ${fmtUsd(e.startUsd)} → ${fmtUsd(e.endUsd)}  ` +
    `(${sign}${fmtUsd(Math.abs(e.changeAbs)).replace("$", e.changeAbs >= 0 ? "$" : "-$")}` +
    `${e.changePct != null ? `, ${sign}${e.changePct.toFixed(2)}%` : ""}) · ${e.points} snapshots`
  );
}

function renderPaperText(p: import("../digest.js").PaperSection): string {
  const lines: string[] = [];
  lines.push(`PAPER`);
  if (p.fills === 0) {
    lines.push(`  No paper fills in window.`);
    return lines.join("\n");
  }
  lines.push(`  Fills:    ${p.fills}  (${p.buys} buy${p.buys === 1 ? "" : "s"}, ${p.sells} sell${p.sells === 1 ? "" : "s"})  ${fmtUsd(p.quoteVolume)} volume`);
  if (p.topStrategies.length > 0) {
    lines.push(`  Top strategies: ${p.topStrategies.map((t) => `${t.strategy}×${t.count}`).join("  ")}`);
  }
  return lines.join("\n");
}

function renderSafetyText(s: SafetyEventsSection): string {
  const lines: string[] = [];
  const totalBlocks = s.budgetBlocks + s.positionLimitBlocks + s.honeypotBlocks + s.gasBudgetBlocks;
  const hasAnything =
    s.drawdownTrips > 0 ||
    s.drawdownCurrentlyTripped.length > 0 ||
    totalBlocks > 0 ||
    s.budgetWarnings.length > 0;
  lines.push(`SAFETY`);
  if (!hasAnything) {
    lines.push(`  Clean — no trips, blocks, or warnings.`);
    return lines.join("\n");
  }
  if (s.drawdownTrips > 0) {
    lines.push(`  🔴 Drawdown breaker tripped: ${s.drawdownTrips}×`);
  }
  for (const t of s.drawdownCurrentlyTripped) {
    const pct = t.drawdownPct != null ? `, ${t.drawdownPct.toFixed(1)}% drawdown` : "";
    lines.push(`  🔴 Currently tripped: scope=${t.scope} since ${shorten(t.trippedAt)}${pct}`);
  }
  if (s.budgetBlocks > 0)        lines.push(`  ⚠ Strategy budget blocks:  ${s.budgetBlocks}`);
  if (s.positionLimitBlocks > 0) lines.push(`  ⚠ Position limit blocks:   ${s.positionLimitBlocks}`);
  if (s.honeypotBlocks > 0)      lines.push(`  ⚠ Honeypot blocks:         ${s.honeypotBlocks}`);
  if (s.gasBudgetBlocks > 0)     lines.push(`  ⚠ Gas budget blocks:       ${s.gasBudgetBlocks}`);
  for (const w of s.budgetWarnings) {
    lines.push(`  ⚠ Budget "${w.tag}" ${w.window} utilization ${w.utilizationPct.toFixed(0)}%`);
  }
  return lines.join("\n");
}

function renderErrorsText(e: ErrorsSection): string {
  const lines: string[] = [];
  if (e.totalAuditRows === 0) {
    lines.push(`ERRORS  no audit activity`);
    return lines.join("\n");
  }
  lines.push(`ERRORS  ${e.errorRows}/${e.totalAuditRows} audit rows had errors (${e.errorRatePct.toFixed(1)}%)`);
  if (e.topErrors.length === 0) {
    lines.push(`  No errors.`);
    return lines.join("\n");
  }
  for (const err of e.topErrors) {
    lines.push(`  ${err.code.padEnd(34)} ${String(err.count).padStart(4)}×  (last ${shorten(err.lastSeen)})`);
  }
  return lines.join("\n");
}

// ── slack renderer ───────────────────────────────────────────

/**
 * Slack incoming-webhook expects `mrkdwn` formatting:
 *   *bold*, _italic_, `code`, >quote, lists with bullets.
 *
 * We use `*` for bold (Slack uses single asterisks, not Markdown's
 * double), backticks for code, and a code block for the section
 * details. Operators pipe the output directly into a webhook payload.
 */
/** Exported for the v31 digest-push engine worker — one renderer,
 *  identical output whether the digest is piped from cron or pushed
 *  by the engine through the notify channels. */
export function renderDigestMarkdown(r: DigestReport): string {
  return renderSlack(r);
}

function renderSlack(r: DigestReport): string {
  const lines: string[] = [];
  const header = `${verdictEmoji(r.verdict)} *Tradekit digest* · ${r.windowLabel} · ${verdictLabel(r.verdict)}`;
  lines.push(header);
  lines.push(`_${shorten(r.windowStart)} → ${shorten(r.windowEnd)}_`);
  if (r.verdictReasons.length > 0) {
    lines.push(``);
    lines.push(`*Reasons:*`);
    for (const reason of r.verdictReasons) {
      lines.push(`• ${reason}`);
    }
  }
  lines.push(``);
  lines.push(`*Trades:* ${r.trades.total} (${r.trades.success}✓ ${r.trades.failed}✗) · ${fmtUsd(r.trades.usdVolume)} volume · ${r.trades.successRatePct.toFixed(0)}% success`);
  if (r.trades.topStrategies.length > 0) {
    const tops = r.trades.topStrategies.slice(0, 3).map((s) => `\`${s.strategy}\`×${s.count}`).join(" ");
    lines.push(`*Top strategies:* ${tops}`);
  }
  lines.push(``);
  const firesParts: string[] = [];
  if (r.fires.ordersFilled > 0) firesParts.push(`${r.fires.ordersFilled} filled`);
  if (r.fires.ordersCancelled > 0) firesParts.push(`${r.fires.ordersCancelled} cancelled`);
  if (r.fires.ordersExpired > 0) firesParts.push(`${r.fires.ordersExpired} expired`);
  if (r.fires.ordersFailed > 0) firesParts.push(`*${r.fires.ordersFailed} failed* ⚠`);
  if (r.fires.schedulesFired > 0) firesParts.push(`${r.fires.schedulesFired} schedule${r.fires.schedulesFired === 1 ? "" : "s"} fired`);
  if (r.fires.rebalanceRuns > 0) firesParts.push(`${r.fires.rebalanceRuns} rebalance${r.fires.rebalanceRuns === 1 ? "" : "s"}`);
  if (r.fires.scheduleFireFailures > 0) firesParts.push(`*${r.fires.scheduleFireFailures} schedule failure${r.fires.scheduleFireFailures === 1 ? "" : "s"}* ⚠`);
  if (r.fires.rebalanceFailureCount > 0) firesParts.push(`*${r.fires.rebalanceFailureCount} rebalance failure${r.fires.rebalanceFailureCount === 1 ? "" : "s"}* ⚠`);
  if (firesParts.length > 0) {
    lines.push(`*Strategy fires:* ${firesParts.join(" · ")}`);
  } else {
    lines.push(`*Strategy fires:* none`);
  }
  const alertParts: string[] = [];
  if (r.alerts.fired > 0) alertParts.push(`*${r.alerts.fired} fired* ⚠`);
  if (r.alerts.resolved > 0) alertParts.push(`${r.alerts.resolved} resolved`);
  if (r.alerts.currentlyActive > 0) alertParts.push(`*${r.alerts.currentlyActive} active* ⚠`);
  if (alertParts.length > 0) lines.push(`*Alerts:* ${alertParts.join(" · ")}`);
  if (r.paper.fills > 0) {
    lines.push(`*Paper:* ${r.paper.fills} fill${r.paper.fills === 1 ? "" : "s"} · ${fmtUsd(r.paper.quoteVolume)} volume`);
  }
  if (r.equity) {
    const sign = r.equity.changeAbs >= 0 ? "+" : "−";
    lines.push(`*Equity:* ${fmtUsd(r.equity.endUsd)} (${sign}${fmtUsd(Math.abs(r.equity.changeAbs))}${r.equity.changePct != null ? `, ${sign}${Math.abs(r.equity.changePct).toFixed(2)}%` : ""})`);
  }

  // Safety section — show only when there's something to surface.
  const safety = r.safety;
  const safetyParts: string[] = [];
  if (safety.drawdownTrips > 0) safetyParts.push(`🔴 ${safety.drawdownTrips} drawdown trip${safety.drawdownTrips === 1 ? "" : "s"}`);
  if (safety.drawdownCurrentlyTripped.length > 0) safetyParts.push(`🔴 currently tripped`);
  if (safety.budgetBlocks > 0) safetyParts.push(`${safety.budgetBlocks} budget block${safety.budgetBlocks === 1 ? "" : "s"}`);
  if (safety.positionLimitBlocks > 0) safetyParts.push(`${safety.positionLimitBlocks} position-limit block${safety.positionLimitBlocks === 1 ? "" : "s"}`);
  if (safety.honeypotBlocks > 0) safetyParts.push(`${safety.honeypotBlocks} honeypot block${safety.honeypotBlocks === 1 ? "" : "s"}`);
  if (safety.gasBudgetBlocks > 0) safetyParts.push(`${safety.gasBudgetBlocks} gas-budget block${safety.gasBudgetBlocks === 1 ? "" : "s"}`);
  for (const w of safety.budgetWarnings) {
    safetyParts.push(`budget \`${w.tag}\` ${w.window} ${w.utilizationPct.toFixed(0)}%`);
  }
  if (safetyParts.length > 0) {
    lines.push(`*Safety:* ${safetyParts.join(" · ")}`);
  }

  // Errors.
  if (r.errors.errorRows > 0) {
    lines.push(``);
    const topErr = r.errors.topErrors.slice(0, 3)
      .map((e) => `\`${e.code}\`×${e.count}`)
      .join(" ");
    lines.push(`*Errors:* ${r.errors.errorRows}/${r.errors.totalAuditRows} (${r.errors.errorRatePct.toFixed(1)}%)  ${topErr}`);
  }

  // Comparison footer.
  if (r.comparison) {
    lines.push(``);
    const d = r.comparison.delta;
    lines.push(`_vs prior ${r.windowLabel}: trades ${fmtSigned(d.trades)} · vol ${fmtSignedUsd(d.usdVolume)} · fills ${fmtSigned(d.ordersFilled)} · errors ${fmtSigned(d.errorRows)}_`);
  }

  return lines.join("\n");
}

// ── CLI entry ────────────────────────────────────────────────

const VALID_FORMATS = new Set(["text", "slack", "json"]);

export async function digestCommand(flags: Record<string, string>) {
  const window = flags["window"] ?? "24h";
  const windowMs = parseWindowMs(window);
  const format = flags["format"] ?? "text";
  if (!VALID_FORMATS.has(format)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--format must be one of: text, slack, json (got "${format}").`,
    );
  }
  const compare = flags["compare"] === "true";
  const strict = flags["strict"] === "true";
  const quiet = flags["quiet"] === "true";

  const report = gatherDigest({
    windowLabel: window,
    windowMs,
    compare,
  });

  if (format === "json") {
    printJson({ ok: true, report });
  } else if (format === "slack") {
    if (!quiet) console.log(renderSlack(report));
  } else {
    if (!quiet) console.log(renderText(report));
  }

  if (strict && report.verdict === "critical") {
    // Exit code 2 to distinguish from generic exit-1 errors.
    process.exit(2);
  }
}
