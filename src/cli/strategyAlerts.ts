// CLI surface for the strategy alerts subsystem (iter32).
//
// Subactions (invoked via `tradekit strategy alerts <action>`):
//
//   list [--tag X] [--active-only] [--json]
//        List every alert state row. Default shows all rows sorted
//        by last_evaluated_at desc. --active-only filters to
//        currently-firing alerts.
//
//   show-rules [--json]
//        Print the configured rules + which strategy tags they
//        currently apply to. Useful for verifying a fresh config
//        change before running a tick.
//
//   run [--once | --watch N] [--tag X] [--json]
//        Run the watcher: enumerate strategies, evaluate, emit
//        notifications. --once runs a single tick (default with
//        no flags). --watch N runs forever at N-second cadence.
//
//   reset [--tag X] [--rule TYPE] [--yes] [--json]
//        Manually clear alert state rows. Re-arms the rule so the
//        next violation will emit a fresh fire notification.
//
//   history [--tag X] [--rule TYPE] [--event fired|resolved]
//           [--since ISO] [--until ISO] [--limit N] [--json]
//        v28: page the durable alert_events journal — every
//        fired/resolved transition with exact timestamps, the
//        violated value, and (for resolves) the alerting duration.
//        Unlike `list` (current state), this is the full history.

import { ToolError } from "../errors.js";
import { loadConfig } from "../config.js";
import {
  listStrategyAlertStates,
  resetStrategyAlertState,
  listAlertEvents,
  type StrategyAlertStateRow,
  type ListAlertEventsFilter,
} from "../db.js";
import {
  runAlertTick,
  enumerateActiveTags,
  ruleAppliesToTag,
  type AlertTickReport,
} from "../strategyAlerts.js";
import { createLogger } from "../logger.js";
import { printJson, prompt, subcommandError } from "./helpers.js";

// ── shared helpers ──────────────────────────────────────────

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 0) return iso;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function decodeValue(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── list ────────────────────────────────────────────────────

export async function strategyAlertsListCommand(flags: Record<string, string>) {
  const filter: Parameters<typeof listStrategyAlertStates>[0] = {};
  if (flags["tag"]) filter.tag = flags["tag"];
  if (flags["active-only"] === "true") filter.active = true;
  const rows = listStrategyAlertStates(filter);

  if (flags["json"] === "true") {
    printJson({ ok: true, count: rows.length, states: rows.map(hydrateRow) });
    return;
  }

  if (rows.length === 0) {
    console.log("No alert state recorded.");
    console.log("");
    console.log("Hint: configure safety.strategyAlerts.enabled=true + rules[]");
    console.log("      Then run: tradekit strategy alerts run --once");
    return;
  }

  // Group by tag.
  const byTag = new Map<string, StrategyAlertStateRow[]>();
  for (const r of rows) {
    const arr = byTag.get(r.tag) ?? [];
    arr.push(r);
    byTag.set(r.tag, arr);
  }
  for (const [tag, group] of byTag) {
    const activeCount = group.filter((r) => r.active === 1).length;
    const status = activeCount > 0 ? `⚠ ${activeCount} ACTIVE` : "✓ OK";
    console.log(`\n${tag}  ${status}`);
    for (const r of group) {
      const badge = r.active === 1 ? "⚠" : "✓";
      const since = r.active === 1 && r.first_triggered_at ? `  (active since ${fmtRelative(r.first_triggered_at)})` : "";
      console.log(`  ${badge} ${r.rule_type.padEnd(20)} eval ${fmtRelative(r.last_evaluated_at)}${since}`);
    }
  }
}

function hydrateRow(r: StrategyAlertStateRow) {
  return {
    tag: r.tag,
    ruleType: r.rule_type,
    active: r.active === 1,
    firstTriggeredAt: r.first_triggered_at,
    lastEvaluatedAt: r.last_evaluated_at,
    value: decodeValue(r.last_value_json),
  };
}

// ── show-rules ──────────────────────────────────────────────

export async function strategyAlertsShowRulesCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const cfg = config.safety.strategyAlerts;
  const activeTags = enumerateActiveTags();
  type RuleSummary = {
    type: string;
    appliesTo: string[];
    matchedTags: string[];
    config: Record<string, unknown>;
  };
  const summaries: RuleSummary[] = [];
  if (cfg && cfg.rules.length > 0) {
    for (const rule of cfg.rules) {
      const matched = activeTags.filter((tag) => ruleAppliesToTag(rule, tag));
      const { type: _t, appliesTo: _a, note: _n, ...specifics } = rule as Record<string, unknown>;
      void _t;
      void _a;
      void _n;
      summaries.push({
        type: rule.type,
        appliesTo: rule.appliesTo ?? [],
        matchedTags: matched,
        config: specifics,
      });
    }
  }
  if (flags["json"] === "true") {
    printJson({
      ok: true,
      enabled: cfg?.enabled ?? false,
      eventPrefix: cfg?.eventPrefix ?? "strategy.alert",
      ruleCount: summaries.length,
      activeTagCount: activeTags.length,
      rules: summaries,
    });
    return;
  }
  if (!cfg) {
    console.log("Strategy alerts: not configured.");
    console.log("");
    console.log("Enable in config: safety.strategyAlerts.enabled = true");
    console.log("Configure rules:  safety.strategyAlerts.rules = [...]");
    return;
  }
  console.log(`Strategy alerts: ${cfg.enabled ? "ENABLED" : "disabled"}`);
  console.log(`Event prefix:    ${cfg.eventPrefix}`);
  console.log(`Rules:           ${summaries.length}`);
  console.log(`Active tags:     ${activeTags.length}`);
  console.log("");
  if (summaries.length === 0) {
    console.log("(no rules configured)");
    return;
  }
  for (const r of summaries) {
    const applies =
      r.appliesTo.length === 0 ? "all strategies" : `tags: ${r.appliesTo.join(", ")}`;
    console.log(`  ${r.type}`);
    console.log(`    config:    ${JSON.stringify(r.config)}`);
    console.log(`    applies:   ${applies}`);
    console.log(`    matches:   ${r.matchedTags.length === 0 ? "(none)" : r.matchedTags.join(", ")}`);
    console.log("");
  }
}

// ── run ─────────────────────────────────────────────────────

export async function strategyAlertsRunCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const cfg = config.safety.strategyAlerts;
  if (!cfg || !cfg.enabled) {
    if (flags["json"] === "true") {
      printJson({ ok: true, skipped: "disabled", message: "safety.strategyAlerts.enabled is false" });
      return;
    }
    console.log("Strategy alerts disabled. Set safety.strategyAlerts.enabled=true in config to use.");
    return;
  }
  const onlyTags = flags["tag"] ? [flags["tag"]] : undefined;
  const watchSecs = parseWatch(flags);
  const logger = createLogger({ stderrLevel: flags["json"] === "true" ? "silent" : "info" });

  const runOnce = async () => {
    const r = await runAlertTick({ config, logger, onlyTags });
    if (flags["json"] === "true") {
      printJson({ ok: true, tick: serializeTick(r) });
    } else {
      renderTickSummary(r);
    }
    return r;
  };

  if (watchSecs == null) {
    await runOnce();
    return;
  }
  // Watch mode: run forever at the configured cadence.
  console.log(`Watching strategy alerts every ${watchSecs}s. Press Ctrl-C to stop.`);
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      logger.error(`strategy alerts run: ${(e as Error).message}`);
    }
    await sleep(watchSecs * 1000);
  }
}

function parseWatch(flags: Record<string, string>): number | null {
  if (flags["once"] === "true") return null;
  if (flags["watch"] != null) {
    const n = parseInt(flags["watch"], 10);
    if (!Number.isFinite(n) || n < 5) {
      throw new ToolError("INVALID_PARAMS", `--watch must be an integer ≥ 5 seconds (got "${flags["watch"]}").`);
    }
    return n;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeTick(r: AlertTickReport) {
  return {
    startedAt: r.startedAt,
    fired: r.fired,
    resolved: r.resolved,
    stillActive: r.stillActive,
    skipped: r.skipped,
    evaluations: r.evaluations.map((ev) => ({
      tag: ev.tag,
      ruleType: ev.ruleType,
      applicable: ev.applicable,
      violated: ev.violated,
      message: ev.message,
      value: ev.value,
    })),
  };
}

function renderTickSummary(r: AlertTickReport) {
  console.log(
    `Alert tick @ ${r.startedAt}: ${r.fired} fired · ${r.resolved} resolved · ${r.stillActive} still active · ${r.skipped} skipped`,
  );
  if (r.transitions.length === 0) return;
  for (const t of r.transitions) {
    if (t.kind === "fire") {
      console.log(`  ⚠ FIRE     ${t.evaluation.tag.padEnd(24)} ${t.evaluation.ruleType.padEnd(20)} ${t.evaluation.message}`);
    } else if (t.kind === "resolve") {
      console.log(`  ✓ RESOLVE  ${t.evaluation.tag.padEnd(24)} ${t.evaluation.ruleType.padEnd(20)} ${t.evaluation.message}`);
    }
  }
}

// ── reset ───────────────────────────────────────────────────

export async function strategyAlertsResetCommand(flags: Record<string, string>) {
  const filter: { tag?: string; ruleType?: string } = {};
  if (flags["tag"]) filter.tag = flags["tag"];
  if (flags["rule"]) filter.ruleType = flags["rule"];
  const scopeDesc = filter.tag || filter.ruleType
    ? `tag=${filter.tag ?? "*"} rule=${filter.ruleType ?? "*"}`
    : "ALL alert state (every tag, every rule)";
  if (flags["yes"] !== "true" && flags["json"] !== "true") {
    const ans = await prompt(`This will RESET ${scopeDesc}. Re-armed rules will fire fresh notifications on the next violation. Continue? [y/N] `);
    if (!/^y(es)?$/i.test(ans.trim())) {
      console.log("Cancelled.");
      return;
    }
  }
  const removed = resetStrategyAlertState(filter);
  if (flags["json"] === "true") {
    printJson({ ok: true, removed, scope: filter });
    return;
  }
  console.log(`Removed ${removed} state row(s).`);
}

// ── history (v28) ───────────────────────────────────────────

export async function strategyAlertsHistoryCommand(flags: Record<string, string>) {
  const filter: ListAlertEventsFilter = { limit: 100 };
  if (flags["tag"]) filter.tag = flags["tag"];
  if (flags["rule"]) filter.ruleType = flags["rule"];
  if (flags["event"]) {
    const ev = flags["event"];
    if (ev !== "fired" && ev !== "resolved") {
      throw new ToolError("INVALID_PARAMS", `--event must be fired or resolved (got "${ev}").`);
    }
    filter.event = ev;
  }
  if (flags["since"]) filter.sinceIso = flags["since"];
  if (flags["until"]) filter.untilIso = flags["until"];
  if (flags["limit"]) {
    const n = parseInt(flags["limit"], 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ToolError("INVALID_PARAMS", `--limit must be a positive integer (got "${flags["limit"]}").`);
    }
    filter.limit = n;
  }
  const rows = listAlertEvents(filter);

  if (flags["json"] === "true") {
    printJson({ ok: true, count: rows.length, events: rows });
    return;
  }
  if (rows.length === 0) {
    console.log("No alert transitions recorded.");
    console.log("");
    console.log("The journal fills as the alert watcher fires/resolves rules (v28+).");
    console.log("Current state (incl. pre-v28 alerts): tradekit strategy alerts list");
    return;
  }
  console.log(`${rows.length} alert transition(s), newest first:`);
  for (const r of rows) {
    const marker = r.event === "fired" ? (r.severity === "critical" ? "🔴" : "🟠") : "🟢";
    const dur = r.event === "resolved" && r.duration_seconds != null ? `  (was alerting ${Math.floor(r.duration_seconds / 60)}m)` : "";
    console.log(`  ${marker} ${r.at}  ${r.event.toUpperCase().padEnd(8)} ${r.tag} / ${r.rule_type}${dur}`);
    if (r.event === "fired" && r.message) {
      console.log(`       ${r.message}`);
    }
  }
}

// ── dispatch ────────────────────────────────────────────────

export async function strategyAlertsCommand(
  action: string | undefined,
  flags: Record<string, string>,
  _positional: string[],
) {
  switch (action) {
    case "list":
      await strategyAlertsListCommand(flags);
      break;
    case "show-rules":
    case "rules":
      await strategyAlertsShowRulesCommand(flags);
      break;
    case "run":
      await strategyAlertsRunCommand(flags);
      break;
    case "reset":
      await strategyAlertsResetCommand(flags);
      break;
    case "history":
      await strategyAlertsHistoryCommand(flags);
      break;
    default:
      throw subcommandError("strategy alerts", action, ["list", "show-rules", "run", "reset", "history"]);
  }
}
