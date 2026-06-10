// CLI surface for the unified strategy report (iter31).
//
// Subactions:
//
//   tradekit strategy report <id|tag> [--window 1d|7d|30d|90d|all]
//                                     [--mode real|paper|auto]
//                                     [--sections id,comp,perf,...]
//                                     [--no-prices] [--json]
//        Render the full strategy report. Default window 30d, mode
//        auto. With --json the typed StrategyReport is emitted
//        verbatim (no header / table rendering). Without --json a
//        human-readable text rendering covers all seven sections.
//
//   tradekit strategy list [--chain X] [--account L] [--json]
//        Thin alias for the existing `strategies list` command — kept
//        on this namespace so operators discover both via
//        `strategy --help`.
//
// Design:
//  * Live price lookup is opt-out via --no-prices (default ON). When
//    the operator doesn't want the network roundtrip for the
//    forward-signals section, --no-prices skips it.
//  * Text rendering is non-trivial (multi-section, padded columns).
//    Keep the renderers small + composable so future sections slot
//    in without rewriting the whole layout.

import { ToolError } from "../errors.js";
import {
  buildStrategyReport,
  type StrategyReport,
  type ReportWindow,
  type ReportMode,
  type ReportSection,
  type CompositionEntry,
  type ActivityEntry,
  type PendingTriggerEntry,
} from "../strategyReport.js";
import { listStrategyAlertStates } from "../db.js";
import { getCurrentPrice } from "../price.js";
import { loadConfig } from "../config.js";
import { defaultPaperPriceFetcher } from "../paperPnl.js";
import { createLogger } from "../logger.js";
import { printJson, subcommandError } from "./helpers.js";
import { strategiesListCommand } from "./inspect.js";
import { strategyAlertsCommand } from "./strategyAlerts.js";

// ── parsing helpers ─────────────────────────────────────────

const VALID_WINDOWS: ReportWindow[] = ["1d", "7d", "30d", "90d", "all"];
const VALID_MODES: ReportMode[] = ["real", "paper", "auto"];
const VALID_SECTIONS: ReportSection[] = [
  "identity",
  "composition",
  "performance",
  "position",
  "risk",
  "activity",
  "forward",
  "valuation",
];

function parseWindow(raw: string | undefined): ReportWindow {
  if (!raw) return "30d";
  if (!VALID_WINDOWS.includes(raw as ReportWindow)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--window must be one of ${VALID_WINDOWS.join("|")} (got "${raw}").`,
    );
  }
  return raw as ReportWindow;
}

function parseMode(raw: string | undefined): ReportMode {
  if (!raw) return "auto";
  if (!VALID_MODES.includes(raw as ReportMode)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--mode must be one of ${VALID_MODES.join("|")} (got "${raw}").`,
    );
  }
  return raw as ReportMode;
}

function parseSections(raw: string | undefined): ReportSection[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out: ReportSection[] = [];
  for (const p of parts) {
    // Accept short aliases.
    const aliased =
      p === "id"
        ? "identity"
        : p === "comp"
          ? "composition"
          : p === "perf"
            ? "performance"
            : p === "pos"
              ? "position"
              : p === "act"
                ? "activity"
                : p === "fwd"
                  ? "forward"
                  : p === "mtm" || p === "val"
                    ? "valuation"
                    : p;
    if (!VALID_SECTIONS.includes(aliased as ReportSection)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--sections includes unknown "${p}"; valid: ${VALID_SECTIONS.join(", ")}.`,
      );
    }
    out.push(aliased as ReportSection);
  }
  return out.length ? out : undefined;
}

// ── number / time formatting ────────────────────────────────

function fmtAge(secs: number | null): string {
  if (secs == null) return "—";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 0) {
    // future
    const abs = Math.abs(secs);
    if (abs < 3600) return `in ${Math.floor(abs / 60)}m`;
    if (abs < 86400) return `in ${Math.floor(abs / 3600)}h`;
    return `in ${Math.floor(abs / 86400)}d`;
  }
  return `${fmtAge(secs)} ago`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function statusBadge(status: string): string {
  switch (status) {
    case "active":
      return "●";
    case "filled":
      return "✓";
    case "failed":
      return "✕";
    case "expired":
      return "⊘";
    case "cancelled":
      return "—";
    case "paused":
      return "⏸";
    case "completed":
      return "✓";
    default:
      return "?";
  }
}

// ── section renderers ───────────────────────────────────────

function renderHeader(report: StrategyReport): string[] {
  const lines: string[] = [];
  const id = report.identity;
  const name = id?.displayName ?? report.tag;
  const tagSuffix = id && id.displayName !== report.tag ? `  (${report.tag})` : "";
  const modeBadge = report.mode === "paper" ? "  [PAPER]" : "";
  lines.push(`Strategy: ${name}${tagSuffix}${modeBadge}`);
  lines.push("─".repeat(60));
  if (id) {
    if (id.playbookId != null) {
      lines.push(`Playbook:    #${id.playbookId}  ${id.playbookStatus ?? "?"}`);
      if (id.sourcePath) lines.push(`Source:      ${id.sourcePath}`);
      if (id.sourceHash) lines.push(`Spec hash:   ${id.sourceHash.slice(0, 16)}…`);
    }
    if (id.deployedAt) {
      lines.push(`Deployed:    ${id.deployedAt}  (${fmtAge(id.ageSeconds)} ago)`);
    } else if (id.ageSeconds != null) {
      lines.push(`Age:         ${fmtAge(id.ageSeconds)}`);
    }
    if (id.destroyedAt) lines.push(`Destroyed:   ${id.destroyedAt}`);
  }
  lines.push(`Window:      ${report.window}`);
  lines.push("");
  return lines;
}

function renderComposition(report: StrategyReport): string[] {
  const c = report.composition;
  if (!c) return [];
  const lines: string[] = [];
  lines.push("Composition");
  lines.push("─".repeat(60));
  lines.push(
    `  Totals:     ${c.totals.orders} orders · ${c.totals.schedules} schedules · ${c.totals.rebalances} rebalances`,
  );
  const lc = c.lifecycle;
  lines.push(
    `  Lifecycle:  active ${lc.active} · filled ${lc.filled} · failed ${lc.failed} · expired ${lc.expired} · cancelled ${lc.cancelled} · paused ${lc.paused} · completed ${lc.completed}`,
  );
  if (c.primitives.length === 0) {
    lines.push("  (no primitives)");
  } else {
    lines.push("");
    lines.push(`  ${"ID".padEnd(8)}${"Kind".padEnd(12)}${"Status".padEnd(12)}Summary`);
    for (const p of c.primitives) {
      lines.push(`  ${formatPrimitiveRow(p)}`);
    }
  }
  lines.push("");
  return lines;
}

function formatPrimitiveRow(p: CompositionEntry): string {
  const id = `#${p.id}`.padEnd(8);
  const kind = `${p.kind}${p.paper ? "*" : ""}`.padEnd(12);
  const status = `${statusBadge(p.status)} ${p.status}`.padEnd(12);
  return `${id}${kind}${status}${p.summary}`;
}

function renderPerformance(report: StrategyReport): string[] {
  const p = report.performance;
  if (!p) return [];
  const lines: string[] = [];
  lines.push(`Performance (${report.window})`);
  lines.push("─".repeat(60));
  const total = p.fills + p.failures;
  lines.push(`  Trades:       ${total} total  (${p.fills} fills, ${p.failures} failures)`);
  if (p.successRate != null) lines.push(`  Success rate: ${(p.successRate * 100).toFixed(1)}%`);
  lines.push(`  Buy/Sell:     ${p.buyCount} / ${p.sellCount}`);
  lines.push(`  Realized:     spent ${fmtUsd(p.realizedQuoteSpent)} · received ${fmtUsd(p.realizedQuoteReceived)} · net ${fmtUsd(p.realizedNetQuote)}`);
  if (p.avgSlippageBps != null) {
    lines.push(
      `  Slippage:     avg ${p.avgSlippageBps.toFixed(1)} bps · p50 ${p.p50SlippageBps?.toFixed(1)} · p95 ${p.p95SlippageBps?.toFixed(1)} · max ${p.maxSlippageBps?.toFixed(1)}`,
    );
  } else {
    lines.push(`  Slippage:     —`);
  }
  lines.push("");
  return lines;
}

function renderPosition(report: StrategyReport): string[] {
  const p = report.position;
  if (!p) return [];
  const lines: string[] = [];
  lines.push("Position (cumulative)");
  lines.push("─".repeat(60));
  if (p.positions.length === 0) {
    lines.push("  (flat)");
  } else {
    for (const row of p.positions) {
      const label = row.symbol ?? row.token.slice(0, 10);
      const sign = parseFloat(row.netAmount) >= 0 ? "+" : "";
      lines.push(
        `  ${row.chain.padEnd(10)}${row.role.padEnd(6)}${(sign + row.netAmount).padStart(20)} ${label}`,
      );
    }
  }
  lines.push("");
  return lines;
}

function renderRisk(report: StrategyReport): string[] {
  const r = report.risk;
  if (!r) return [];
  const lines: string[] = [];
  lines.push("Risk");
  lines.push("─".repeat(60));
  if (r.budgets.length === 0) {
    lines.push("  No matching strategy budgets configured.");
  } else {
    for (const b of r.budgets) {
      lines.push(`  Budget rule: ${b.pattern}`);
      if (b.lifetimeUsd != null) {
        lines.push(
          `    Lifetime:   ${fmtUsd(b.lifetimeSpentUsd)} / ${fmtUsd(b.lifetimeUsd)}  (${b.lifetimePctUsed?.toFixed(0)}%)`,
        );
      }
      if (b.dailyUsd != null) {
        lines.push(
          `    Daily:      ${fmtUsd(b.dailySpentUsd)} / ${fmtUsd(b.dailyUsd)}  (${b.dailyPctUsed?.toFixed(0)}%)`,
        );
      }
      if (b.perFireUsd != null) {
        lines.push(`    Per-fire:   ${fmtUsd(b.perFireUsd)}`);
      }
    }
  }
  if (r.drawdown) {
    const d = r.drawdown;
    const trip = d.tripped ? `  ⚠ TRIPPED at ${d.trippedAt}` : "";
    lines.push(
      `  Drawdown:    peak ${fmtUsd(d.peakUsd)} (${fmtRelative(d.peakAt)}) · current ${fmtUsd(d.lastValueUsd)} · ${fmtPct(d.drawdownPct)}${trip}`,
    );
  }
  lines.push("");
  return lines;
}

function renderActivity(report: StrategyReport): string[] {
  const a = report.activity;
  if (!a) return [];
  const lines: string[] = [];
  lines.push("Recent activity");
  lines.push("─".repeat(60));
  const renderGroup = (label: string, entries: ActivityEntry[]) => {
    lines.push(`  ${label}: ${entries.length === 0 ? "(none)" : ""}`);
    for (const e of entries.slice(0, 5)) {
      const id = e.primitiveType && e.primitiveId != null ? ` [${e.primitiveType}#${e.primitiveId}]` : "";
      lines.push(`    ${fmtRelative(e.at).padEnd(12)}${id} ${e.summary}`);
    }
  };
  renderGroup("Fills", a.recentFills);
  renderGroup("Failures", a.recentFailures);
  renderGroup("Journal", a.recentJournal);
  lines.push("");
  return lines;
}

function renderForward(report: StrategyReport): string[] {
  const f = report.forward;
  if (!f) return [];
  const lines: string[] = [];
  lines.push("Forward signals");
  lines.push("─".repeat(60));
  if (f.nextScheduleAt) {
    lines.push(`  Next schedule:  #${f.nextScheduleId}  @ ${f.nextScheduleAt}  (${fmtRelative(f.nextScheduleAt)})`);
  } else {
    lines.push(`  Next schedule:  (none active)`);
  }
  if (f.pendingTriggers.length === 0) {
    lines.push(`  Pending orders: (none active)`);
  } else {
    lines.push(`  Pending orders:`);
    for (const t of f.pendingTriggers.slice(0, 10)) {
      lines.push(`    ${formatPendingRow(t)}`);
    }
  }
  lines.push("");
  return lines;
}

function formatPendingRow(t: PendingTriggerEntry): string {
  const fireFlag = t.wouldFireNow ? "⚠ WOULD FIRE NOW" : "";
  const trig =
    t.trigger === "trailing"
      ? `trailing  HWM=${fmtUsd(t.trailingWaterMarkUsd)}`
      : t.trigger === "price_below"
        ? "≤"
        : "≥";
  const target = t.fireThresholdUsd != null ? `$${t.fireThresholdUsd.toFixed(2)}` : "—";
  const curr = t.currentPriceUsd != null ? `$${t.currentPriceUsd.toFixed(2)}` : "—";
  const dist = t.distancePct != null ? fmtPct(t.distancePct) : "—";
  return `#${String(t.orderId).padEnd(5)} ${t.side.padEnd(4)} ${trig.padEnd(10)} target ${target.padStart(12)}  current ${curr.padStart(12)}  dist ${dist.padStart(8)}  ${fireFlag}`.trimEnd();
}

function renderValuation(report: StrategyReport): string[] {
  const v = report.valuation;
  if (!v) return [];
  const lines: string[] = [];
  lines.push("Valuation (mark-to-market)");
  lines.push("─".repeat(60));
  const sign = (n: number) => `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
  const unreal = v.unrealizedQuote == null ? "— (unpriced)" : sign(v.unrealizedQuote);
  lines.push(`  Realized:    ${sign(v.realizedQuote)}   Unrealized: ${unreal}   Total: ${sign(v.totalQuote)}`);
  lines.push(`  Open value:  $${v.openValueQuote.toFixed(2)}   marked at ${v.markedAt}`);
  for (const p of v.positions) {
    if (p.amount <= 1e-9 && p.realizedQuote === 0 && p.untrackedSellBase === 0) continue;
    const sym = p.symbol ?? p.token.slice(0, 10);
    if (p.amount > 1e-9) {
      const mark = p.currentPriceQuote == null
        ? "price unavailable"
        : `@ $${p.currentPriceQuote.toFixed(2)} (avg cost $${p.avgCostQuote.toFixed(2)})  unrealized ${p.unrealizedQuote == null ? "—" : sign(p.unrealizedQuote)}`;
      lines.push(`    ${sym.padEnd(10)} ${p.amount.toFixed(6)} held  ${mark}`);
    } else {
      lines.push(`    ${sym.padEnd(10)} flat  realized ${sign(p.realizedQuote)}`);
    }
  }
  if (v.unpricedPositionCount > 0) {
    lines.push(`  ⚠ ${v.unpricedPositionCount} open position(s) unpriced — unrealized/total are partial`);
  }
  if (v.skippedNonStableQuote > 0) {
    lines.push(`  ⚠ ${v.skippedNonStableQuote} fill(s) with non-stablecoin quote excluded from cost basis`);
  }
  if (v.untrackedSellQuote > 0) {
    lines.push(`  ⚠ $${v.untrackedSellQuote.toFixed(2)} sell proceeds without tracked cost basis (excluded from realized)`);
  }
  if (report.mode === "real") {
    lines.push(`  Note: gas not included — see \`tradekit pnl\` for full portfolio accounting.`);
  }
  lines.push("");
  return lines;
}

// ── render orchestrator ─────────────────────────────────────

export function renderStrategyReport(report: StrategyReport): string {
  const lines: string[] = [];
  lines.push(...renderHeader(report));
  lines.push(...renderComposition(report));
  lines.push(...renderPerformance(report));
  lines.push(...renderPosition(report));
  lines.push(...renderValuation(report));
  lines.push(...renderRisk(report));
  lines.push(...renderActivity(report));
  lines.push(...renderForward(report));
  return lines.join("\n");
}

// ── command entry ───────────────────────────────────────────

export async function strategyReportCommand(
  flags: Record<string, string>,
  positional: string[],
) {
  const tagArg = positional[2];
  if (!tagArg) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Usage: tradekit strategy report <id|tag> [--window 1d|7d|30d|90d|all] [--mode real|paper|auto] [--no-prices] [--json]",
    );
  }
  const window = parseWindow(flags["window"]);
  const mode = parseMode(flags["mode"]);
  let sections = parseSections(flags["sections"]);
  const noPrices = flags["no-prices"] === "true" || flags["prices"] === "false";

  // --mtm: add the valuation section on top of whatever sections
  // resolve (default = all seven + valuation). The section itself is
  // opt-in because it needs one oracle call per held token.
  const wantMtm = flags["mtm"] === "true" || sections?.includes("valuation") === true;
  if (flags["mtm"] === "true" && sections && !sections.includes("valuation")) {
    sections = [...sections, "valuation"];
  } else if (flags["mtm"] === "true" && !sections) {
    sections = [...VALID_SECTIONS];
  }

  const quietLogger = createLogger({ stderrLevel: "silent" });
  const livePriceFn = noPrices
    ? undefined
    : async (tokenAddr: string): Promise<number | null> => {
        try {
          return await getCurrentPrice(tokenAddr, quietLogger);
        } catch {
          return null;
        }
      };
  const markPriceFn = wantMtm && !noPrices
    ? defaultPaperPriceFetcher(loadConfig(), quietLogger)
    : undefined;

  const report = await buildStrategyReport({
    tag: tagArg,
    window,
    mode,
    sections,
    livePriceFn,
    markPriceFn,
  });

  // --alerts: surface currently-active alerts for the strategy. This
  // is a non-invasive read of the v25 strategy_alert_state table —
  // doesn't trigger the watcher, just shows what the last tick
  // recorded.
  const includeAlerts = flags["alerts"] === "true";
  const alertRows = includeAlerts ? listStrategyAlertStates({ tag: report.tag, active: true }) : [];

  if (flags["json"] === "true") {
    const payload: Record<string, unknown> = { ok: true, report };
    if (includeAlerts) {
      payload.alerts = alertRows.map((r) => ({
        tag: r.tag,
        ruleType: r.rule_type,
        active: r.active === 1,
        firstTriggeredAt: r.first_triggered_at,
        lastEvaluatedAt: r.last_evaluated_at,
      }));
    }
    printJson(payload);
    return;
  }
  console.log(renderStrategyReport(report));
  if (includeAlerts) {
    if (alertRows.length === 0) {
      console.log("Alerts:  (no active alerts)");
    } else {
      console.log(`Alerts:  ${alertRows.length} active`);
      for (const row of alertRows) {
        const since = row.first_triggered_at ? `  (since ${row.first_triggered_at})` : "";
        console.log(`  ⚠ ${row.rule_type}${since}`);
      }
    }
  }
}

// ── dispatch ────────────────────────────────────────────────

export async function strategyCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  switch (action) {
    case "report":
    case "show":
      await strategyReportCommand(flags, positional);
      break;
    case "list":
      await strategiesListCommand(flags);
      break;
    case "alerts": {
      // Nested subcommand: `tradekit strategy alerts <action>`.
      // The action sits at positional[2] because positional[0] is
      // the binary and positional[1] is "strategy". The actual
      // alerts subaction is at positional[3] when invoked as
      // `tradekit strategy alerts list` — positional[0] = node,
      // positional[1] = strategy in the parent dispatch's view,
      // but the parent dispatch slices: see how the cli sees it.
      // Convention in this codebase: the parent dispatcher passes
      // positional verbatim. The "alerts" was action; the next
      // word is positional[2].
      const alertsAction = positional[2];
      await strategyAlertsCommand(alertsAction, flags, positional);
      break;
    }
    default:
      throw subcommandError("strategy", action, ["report", "list", "alerts"]);
  }
}
