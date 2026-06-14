/**
 * Incident report (v39) — the one-command postmortem.
 *
 * When something goes wrong the forensic data is ALL there — spread
 * across six surfaces: the digest's verdict, the timeline's critical
 * events, alert transitions + breaker trips, retry/recovery
 * journals, signal arrivals, config history ("what changed before it
 * broke"), operator notes, and the equity move. Assembling them
 * under stress is exactly the work an operator shouldn't be doing.
 *
 * `tradekit incident --window 4h` composes them into one markdown
 * document, ordered the way a reviewer reads: verdict first, then
 * what acted (breaker/panic/recoveries), what failed, what changed,
 * what humans said, and the full critical/warn event tail.
 *
 * Pure composition — every section reuses the existing gatherers, so
 * the incident report can never disagree with the surfaces it
 * summarizes. Deterministic except the digest's own clock.
 */

import { gatherDigest, type DigestReport } from "./digest.js";
import { collectTimeline, type TimelineEvent } from "./timeline.js";
import { listConfigHistory, listOperatorNotes, type OperatorNoteRow } from "./db.js";
import type { Config } from "./config.js";

export interface IncidentReport {
  generatedAt: string;
  windowLabel: string;
  windowStart: string;
  windowEnd: string;
  strategy: string | null;
  digest: DigestReport;
  /** Timeline events in the window, critical+warn only, newest first. */
  events: TimelineEvent[];
  notes: OperatorNoteRow[];
  /** Config versions saved inside the window — "what changed before
   *  it broke" is the postmortem's most-asked question. */
  configChanges: Array<{ id: number; saved_at: string; source: string | null; hash: string }>;
}

export async function gatherIncidentReport(args: {
  windowLabel: string;
  windowMs: number;
  strategy?: string;
  config?: Config;
  now?: Date;
}): Promise<IncidentReport> {
  const now = args.now ?? new Date();
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - args.windowMs).toISOString();

  const digest = await gatherDigest({
    windowLabel: args.windowLabel,
    windowMs: args.windowMs,
    config: args.config,
    now,
  });

  const events = collectTimeline({
    sinceIso: windowStart,
    untilIso: windowEnd,
    strategy: args.strategy,
    minSeverity: "warn",
    limit: 500,
  });

  // Same survive-semantics as the timeline collector: untagged notes
  // are GLOBAL context ("rotated RPC" matters to every strategy's
  // postmortem) and pass any strategy filter; tagged notes scope.
  const notes = listOperatorNotes({ since: windowStart, limit: 200 }).filter(
    (n) => !args.strategy || n.strategy == null || n.strategy === args.strategy,
  );

  const configChanges = listConfigHistory(200)
    .filter((c) => c.saved_at >= windowStart && c.saved_at <= windowEnd)
    .map((c) => ({ id: c.id, saved_at: c.saved_at, source: c.source, hash: c.hash }));

  return {
    generatedAt: windowEnd,
    windowLabel: args.windowLabel,
    windowStart,
    windowEnd,
    strategy: args.strategy ?? null,
    digest,
    events,
    notes,
    configChanges,
  };
}

export function renderIncidentMarkdown(r: IncidentReport): string {
  const lines: string[] = [];
  const f = r.digest.fires;
  const a = r.digest.alerts;

  lines.push(`# Incident report — last ${r.windowLabel}${r.strategy ? ` · strategy ${r.strategy}` : ""}`);
  lines.push(``);
  lines.push(`Window: ${r.windowStart} → ${r.windowEnd}`);
  lines.push(``);

  // 1. Verdict — the one-line answer.
  lines.push(`## Verdict: ${r.digest.verdict.toUpperCase()}`);
  for (const reason of r.digest.verdictReasons) lines.push(`- ${reason}`);
  lines.push(``);

  // 2. What acted / what failed — the numbers a reviewer scans first.
  lines.push(`## Activity`);
  lines.push(`- Trades: ${r.digest.trades.total} (${r.digest.trades.failed} failed) · volume $${r.digest.trades.usdVolume.toFixed(2)}`);
  lines.push(`- Orders: ${f.ordersFilled} filled / ${f.ordersFailed} failed / ${f.ordersExpired} expired`);
  lines.push(`- Schedules: ${f.schedulesFired} fired · ${f.scheduleFireFailures} fire failures · ${f.scheduleHookFailures} hook failures`);
  lines.push(`- Rebalance: ${f.rebalanceRuns} runs · ${f.rebalanceFailureCount} failures`);
  if (f.signalsReceived > 0) {
    lines.push(`- Signals: ${f.signalsReceived} received, ${f.signalsFired} fired${f.signalsReceived > f.signalsFired ? ` — **${f.signalsReceived - f.signalsFired} fired NOTHING**` : ""}`);
  }
  lines.push(`- Alerts: ${a.fired} fired / ${a.resolved} resolved / ${a.currentlyActive} still active`);
  if (r.digest.equity) {
    const e = r.digest.equity;
    const sign = e.changeAbs >= 0 ? "+" : "";
    lines.push(`- Equity: $${e.startUsd.toFixed(2)} → $${e.endUsd.toFixed(2)} (${sign}${e.changeAbs.toFixed(2)}${e.changePct != null ? `, ${sign}${e.changePct.toFixed(2)}%` : ""})`);
  }
  lines.push(``);

  // 3. Config changes — the most-asked postmortem question.
  lines.push(`## Config changes in window`);
  if (r.configChanges.length === 0) {
    lines.push(`(none — the config did not change inside this window)`);
  } else {
    for (const c of r.configChanges) {
      lines.push(`- \`#${c.id}\` ${c.saved_at} — ${c.source ?? "(unknown source)"} (${c.hash})`);
    }
    lines.push(``);
    lines.push(`Inspect: \`tradekit config diff-version <id>\` · roll back: \`tradekit config rollback <id> --yes\``);
  }
  lines.push(``);

  // 4. Human layer.
  lines.push(`## Operator / agent notes`);
  if (r.notes.length === 0) {
    lines.push(`(none in window — record context with \`tradekit note add\`)`);
  } else {
    for (const n of [...r.notes].reverse()) {
      lines.push(`- ${n.at} [${n.source}]${n.strategy ? ` (${n.strategy})` : ""}: ${n.text}`);
    }
  }
  lines.push(``);

  // 5. The event tail — critical first, then warn, chronological
  //    inside each band so cause-and-effect reads top-down.
  const critical = r.events.filter((e) => e.severity === "critical").reverse();
  const warn = r.events.filter((e) => e.severity === "warn").reverse();
  lines.push(`## Critical events (${critical.length})`);
  if (critical.length === 0) lines.push(`(none)`);
  for (const e of critical) lines.push(`- ${e.at} \`${e.kind}\` ${e.summary}`);
  lines.push(``);
  lines.push(`## Warnings (${warn.length})`);
  if (warn.length === 0) lines.push(`(none)`);
  for (const e of warn.slice(0, 50)) lines.push(`- ${e.at} \`${e.kind}\` ${e.summary}`);
  if (warn.length > 50) lines.push(`- … ${warn.length - 50} more (see \`tradekit timeline --since ${r.windowLabel} --min-severity warn\`)`);
  lines.push(``);

  lines.push(`---`);
  lines.push(`Generated ${r.generatedAt} · drill in: \`tradekit timeline\` · \`tradekit order replay <id>\` · \`tradekit schedule replay <id>\``);
  return lines.join("\n");
}
