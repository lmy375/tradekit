// CLI surface for the operational status dashboard.
//
//   tradekit status [--section SECTION] [--json] [--watch N]
//
// Composes engine workers + active orders/schedules/rebalance plans +
// playbooks + drawdown breaker + strategy budgets + 24h audit activity
// into one operator-facing view. Read-only, sub-100ms, zero RPC.

import {
  gatherStatusReport,
  formatDurationSeconds,
  healthMarker,
  ALL_SECTIONS,
  type SectionName,
  type StatusReport,
  type EngineSection,
  type OrdersSection,
  type SchedulesSection,
  type RebalanceSection,
  type PlaybooksSection,
  type DrawdownSection,
  type BudgetsSection,
  type ActivitySection,
} from "../status.js";
import { ToolError } from "../errors.js";
import { printJson, withWatch } from "./helpers.js";

// ── shared formatters ────────────────────────────────────────

function ageOf(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return formatDurationSeconds((now.getTime() - t) / 1000) + " ago";
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "?";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "?";
  return `${n.toFixed(2)}%`;
}

// ── section renderers ────────────────────────────────────────

function renderEngine(s: EngineSection, now: Date): string {
  const lines: string[] = ["ENGINE"];
  // Iter28: surface the kill switch FIRST when active — operators
  // glancing at status need to see the lock immediately, not buried
  // below worker telemetry.
  if (s.lock.locked) {
    lines.push(`  ✕✕✕ ENGINE LOCKED ✕✕✕`);
    lines.push(`      Reason:    ${s.lock.reason ?? "(not specified)"}`);
    lines.push(`      Locked at: ${s.lock.lockedAt}  (${ageOf(s.lock.lockedAt, now)})`);
    lines.push(`      Locked by: ${s.lock.lockedBy}`);
    lines.push(`      Resume:    tradekit engine unlock`);
    lines.push(``);
  }
  if (s.notStarted) {
    lines.push(`  Engine has not been started. Run \`tradekit engine run --once\` to start.`);
    return lines.join("\n");
  }
  lines.push(`  pid=${s.pid}  started ${ageOf(s.startedAt, now)}  updated ${ageOf(s.updatedAt, now)}${s.stopping ? "  (stopping)" : ""}`);
  if (s.workers.length === 0) {
    lines.push(`  No workers configured.`);
    return lines.join("\n");
  }
  for (const w of s.workers) {
    const marker = healthMarker(w.health);
    const age = w.lastTickAt ? `last tick ${formatDurationSeconds(w.lastTickAgeSec!)} ago` : "never ticked";
    const errs = w.failures > 0 ? `, ${w.failures} fail${w.failures === 1 ? "" : "s"}` : "";
    const lastErr = w.lastError ? `  ← ${w.lastError.slice(0, 60)}` : "";
    const enabledNote = w.enabled ? "" : " (disabled)";
    lines.push(`  ${marker} ${w.name.padEnd(10)} ${age}  (interval ${formatDurationSeconds(w.intervalMs / 1000)}, ${w.successes} ok${errs})${enabledNote}${lastErr}`);
  }
  return lines.join("\n");
}

function renderOrders(s: OrdersSection): string {
  const lines: string[] = [
    `ORDERS  (${s.counts.active} active, ${s.counts.filled} filled, ${s.counts.cancelled} cancelled, ${s.counts.expired} expired, ${s.counts.failed} failed)`,
  ];
  if (s.nearTrigger.length === 0) {
    if (s.counts.active > 0) {
      lines.push(`  ${s.counts.active} active orders, but none have a usable price yet.`);
      lines.push(`  Run \`tradekit order run --once\` to refresh check timestamps.`);
    }
    return lines.join("\n");
  }
  lines.push(`  Closest to trigger:`);
  for (const o of s.nearTrigger) {
    const stale = o.staleCheck ? " ⚠ stale check" : "";
    const pct = o.pctToFire === 0 ? "AT TRIGGER" : `${fmtPct(o.pctToFire)} away`;
    const pair = `${o.base ?? "?"}/${o.quote ?? "?"}`;
    lines.push(`    #${String(o.id).padEnd(4)} ${o.side.padEnd(4)} ${pair.padEnd(10)} ${o.triggerLabel.padEnd(36)} cur=${fmtUsd(o.lastPriceUsd ?? 0).padStart(10)}  ${pct}${stale}`);
  }
  return lines.join("\n");
}

function renderSchedules(s: SchedulesSection): string {
  const lines: string[] = [
    `SCHEDULES  (${s.counts.active} active, ${s.counts.paused} paused, ${s.counts.completed} completed, ${s.counts.cancelled} cancelled)`,
  ];
  if (s.nextFires.length === 0) return lines.join("\n");
  for (const sched of s.nextFires) {
    const until = sched.secondsUntilFire < 0
      ? `OVERDUE by ${formatDurationSeconds(-sched.secondsUntilFire)}`
      : `next fire ${formatDurationSeconds(sched.secondsUntilFire)}`;
    const name = sched.name ?? `schedule #${sched.id}`;
    const runsCol = sched.maxRuns != null ? `${sched.runCount}/${sched.maxRuns}` : `${sched.runCount} runs`;
    lines.push(`  #${String(sched.id).padEnd(4)} ${name.padEnd(24)} cron "${sched.cron}"  ${until}  (${runsCol})`);
  }
  return lines.join("\n");
}

function renderRebalance(s: RebalanceSection): string {
  const lines: string[] = [
    `REBALANCE PLANS  (${s.counts.active} active, ${s.counts.paused} paused, ${s.counts.completed} completed, ${s.counts.cancelled} cancelled)`,
  ];
  if (s.plans.length === 0) return lines.join("\n");
  for (const p of s.plans) {
    const until = p.secondsUntilEval < 0
      ? `OVERDUE by ${formatDurationSeconds(-p.secondsUntilEval)}`
      : `next eval ${formatDurationSeconds(p.secondsUntilEval)}`;
    const name = p.name ?? `plan #${p.id}`;
    const last = p.lastResultSummary ? `  · ${p.lastResultSummary}` : "";
    lines.push(`  #${String(p.id).padEnd(4)} ${name.padEnd(20)} chain=${p.chain}  drift>${p.driftThresholdPct}%  ${until}${last}`);
  }
  return lines.join("\n");
}

function renderPlaybooks(s: PlaybooksSection, now: Date): string {
  const lines: string[] = [
    `PLAYBOOKS  (${s.counts.deployed} deployed, ${s.counts.deploying} deploying, ${s.counts.destroyed} destroyed, ${s.counts.failed} failed)`,
  ];
  if (s.recent.length === 0) return lines.join("\n");
  for (const p of s.recent) {
    const note = p.status === "deployed"
      ? `deployed ${ageOf(p.deployedAt, now)}`
      : `${p.status} ${ageOf(p.destroyedAt ?? p.deployedAt, now)}`;
    lines.push(`  #${String(p.id).padEnd(4)} ${p.name.padEnd(28)} ${note}`);
  }
  return lines.join("\n");
}

function renderDrawdown(s: DrawdownSection): string {
  const lines: string[] = ["DRAWDOWN BREAKER"];
  if (!s.configured) {
    lines.push(`  Not configured. Enable with: tradekit config set safety.drawdownCircuitBreaker '{"enabled":true,"maxDrawdownPct":15}'`);
    return lines.join("\n");
  }
  if (!s.enabled) {
    lines.push(`  Configured but disabled (set safety.drawdownCircuitBreaker.enabled=true).`);
    return lines.join("\n");
  }
  const auto = s.autoResumeAtPct != null ? `, autoResume<${s.autoResumeAtPct}%` : ", manual reset only";
  lines.push(`  enabled (maxDrawdown ${s.maxDrawdownPct}%${auto})`);
  if (s.states.length === 0) {
    lines.push(`  No state yet — next trade will seed the peak.`);
    return lines.join("\n");
  }
  for (const st of s.states) {
    const status = st.tripped ? `✕ TRIPPED at ${st.trippedAt}` : `● ok`;
    const drawdown = st.drawdownPct != null
      ? `drawdown ${fmtPct(st.drawdownPct)}`
      : "no current reading";
    const last = st.lastValueUsd != null ? `last ${fmtUsd(st.lastValueUsd)}` : "";
    lines.push(`  scope=${st.scope}  peak ${fmtUsd(st.peakUsd)}  ${last}  ${drawdown}  ${status}`);
  }
  return lines.join("\n");
}

function renderBudgets(s: BudgetsSection): string {
  const lines: string[] = ["STRATEGY BUDGETS"];
  if (!s.configured) {
    lines.push(`  Not configured. Enable per-strategy spend caps with safety.strategyBudgets.`);
    return lines.join("\n");
  }
  if (s.rules.length === 0) {
    lines.push(`  No rules.`);
    return lines.join("\n");
  }
  for (const c of s.rules) {
    const r = c.rule;
    const matched = c.matchedTags.length > 0 && r.tag.endsWith("*")
      ? `  [${c.matchedTags.length} matches]`
      : "";
    let utilization = "";
    if (r.lifetimeUsd != null && c.lifetimeSpentUsd != null) {
      const pct = r.lifetimeUsd > 0 ? Math.min(100, (c.lifetimeSpentUsd / r.lifetimeUsd) * 100) : 0;
      utilization += `  lifetime ${fmtUsd(c.lifetimeSpentUsd)}/${fmtUsd(r.lifetimeUsd)} (${pct.toFixed(0)}%)`;
    }
    if (r.dailyUsd != null && c.dailySpentUsd != null) {
      const pct = r.dailyUsd > 0 ? Math.min(100, (c.dailySpentUsd / r.dailyUsd) * 100) : 0;
      utilization += `  24h ${fmtUsd(c.dailySpentUsd)}/${fmtUsd(r.dailyUsd)} (${pct.toFixed(0)}%)`;
    }
    if (r.perFireUsd != null) {
      utilization += `  per-fire cap ${fmtUsd(r.perFireUsd)}`;
    }
    lines.push(`  ${r.tag.padEnd(20)}${matched}${utilization}`);
  }
  return lines.join("\n");
}

function renderActivity(s: ActivitySection): string {
  const lines: string[] = [
    `LAST 24H  (${s.summary.totalRows} audit rows, ${s.summary.errorRows} errors)`,
  ];
  if (s.summary.totalRows === 0) {
    lines.push(`  No audit activity in the last 24h.`);
    return lines.join("\n");
  }
  if (s.topErrors.length === 0) {
    lines.push(`  No errors. ${s.summary.byTool.length > 0 ? `Top tool: ${s.summary.byTool[0].tool} (${s.summary.byTool[0].count})` : ""}`);
    return lines.join("\n");
  }
  lines.push(`  Top errors:`);
  for (const e of s.topErrors) {
    lines.push(`    ${e.code.padEnd(28)} ${String(e.count).padStart(4)} occurrence${e.count === 1 ? "" : "s"}  (last ${e.lastSeen})`);
  }
  return lines.join("\n");
}

// ── full report renderer ─────────────────────────────────────

function renderAlertsStatus(s: import("../status.js").AlertsStatusSection): string {
  const lines: string[] = [];
  lines.push("ALERTS");
  if (s.activeCount === 0) {
    lines.push("  ✅ no active alerts");
  } else {
    lines.push(`  🔴 ${s.activeCount} active alert${s.activeCount === 1 ? "" : "s"}:`);
    for (const a of s.active.slice(0, 10)) {
      const since = a.firstTriggeredAt ? `  since ${a.firstTriggeredAt}` : "";
      lines.push(`    ⚠ ${a.tag} / ${a.ruleType}${since}`);
    }
  }
  if (s.recentTransitions.length > 0) {
    lines.push("  Recent (24h):");
    for (const t of s.recentTransitions) {
      const marker = t.event === "fired" ? "🔴" : "🟢";
      lines.push(`    ${marker} ${t.at}  ${t.event.padEnd(8)} ${t.tag} / ${t.ruleType}`);
    }
  }
  return lines.join("\n");
}

function renderPaperStatus(s: import("../status.js").PaperStatusSection): string {
  const lines: string[] = [];
  lines.push("PAPER");
  const live = s.activePaper.orders + s.activePaper.schedules + s.activePaper.rebalances;
  if (s.balanceRows === 0 && live === 0) {
    lines.push("  (no paper book / no live paper primitives)");
    return lines.join("\n");
  }
  lines.push(`  Book:      ${s.balanceRows} balance row${s.balanceRows === 1 ? "" : "s"} across ${s.bookScopes} scope${s.bookScopes === 1 ? "" : "s"}`);
  lines.push(`  Live:      ${s.activePaper.orders} order${s.activePaper.orders === 1 ? "" : "s"}, ${s.activePaper.schedules} schedule${s.activePaper.schedules === 1 ? "" : "s"}, ${s.activePaper.rebalances} rebalance${s.activePaper.rebalances === 1 ? "" : "s"}`);
  lines.push(`  Fills 24h: ${s.fills24h}`);
  return lines.join("\n");
}

function renderReport(report: StatusReport, sections: SectionName[]): string {
  const now = new Date(report.generatedAt);
  const header = `TRADEKIT STATUS  ·  ${report.generatedAt}`;
  const out: string[] = [header, ""];
  for (const name of sections) {
    switch (name) {
      case "engine": out.push(renderEngine(report.engine, now)); break;
      case "orders": out.push(renderOrders(report.orders)); break;
      case "schedules": out.push(renderSchedules(report.schedules)); break;
      case "rebalance": out.push(renderRebalance(report.rebalance)); break;
      case "playbooks": out.push(renderPlaybooks(report.playbooks, now)); break;
      case "drawdown": out.push(renderDrawdown(report.drawdown)); break;
      case "budgets": out.push(renderBudgets(report.budgets)); break;
      case "activity": out.push(renderActivity(report.activity)); break;
      case "alerts": out.push(renderAlertsStatus(report.alerts)); break;
      case "paper": out.push(renderPaperStatus(report.paper)); break;
    }
    out.push("");
  }
  return out.join("\n");
}

// ── command entry ────────────────────────────────────────────

function resolveSections(flag: string | undefined): SectionName[] {
  if (!flag) return ALL_SECTIONS;
  const requested = flag.split(",").map((s) => s.trim()).filter(Boolean) as SectionName[];
  const valid = new Set<SectionName>(ALL_SECTIONS);
  const unknown = requested.filter((s) => !valid.has(s));
  if (unknown.length > 0) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Unknown section${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. ` +
        `Valid sections: ${ALL_SECTIONS.join(", ")}.`,
    );
  }
  return requested;
}

export async function statusCommand(flags: Record<string, string>) {
  const sections = resolveSections(flags["section"]);

  const work = async () => {
    const report = gatherStatusReport({ sections });
    if (flags["json"] === "true") {
      printJson({ ok: true, report, sections });
      return;
    }
    console.log(renderReport(report, sections));
  };

  await withWatch(flags, work);
}
