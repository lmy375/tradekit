// CLI surface for portfolio rebalancing plans.
//
//   tradekit rebalance create --name X --account L --chain X
//                             --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]'
//                             [--cron "0 */6 * * *"] [--drift-threshold 5] [--min-trade-usd 10]
//                             [--quote-token USDC] [--slippage <bps>] [--auto-slippage]
//                             [--start-at <ISO>] [--end-at <ISO>] [--max-runs N]
//                             [--strategy TAG] [--note "..."] [--json]
//   tradekit rebalance list   [--status all|active|paused|completed|cancelled]
//                             [--chain X] [--account L] [--strategy TAG] [--limit N] [--json]
//   tradekit rebalance show   <id> [--json]
//   tradekit rebalance pause  <id> [--json]
//   tradekit rebalance resume <id> [--json]
//   tradekit rebalance cancel <id> [--yes] [--json]
//   tradekit rebalance run    [--once] [--chain X] [--account L] [--dry-run] [--pass <pw>]
//                             [--strict] [--json] [--watch N]

import { ToolError } from "../errors.js";
import { loadConfig } from "../config.js";
import {
  createRebalancePlanRow,
  pauseRebalancePlanById,
  resumeRebalancePlanById,
  cancelRebalancePlanById,
  runRebalanceTick,
  listRebalancePlans,
  getRebalancePlanById,
  type RebalanceRow,
  type RebalanceStatus,
  type RebalanceTarget,
} from "../rebalance.js";
import { rebalancePlanCountsByStatus } from "../db.js";
import {
  makeCliLogger,
  printJson,
  parseIntFlag,
  parseFloatFlag,
  requirePassword,
  withWatch,
  subcommandError,
  prompt,
  resolveStrategy,
} from "./helpers.js";

// ── helpers ──────────────────────────────────────────────────

function formatRelativeAge(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 0) {
    const abs = -secs;
    if (abs < 60) return `in ${abs}s`;
    if (abs < 3600) return `in ${Math.floor(abs / 60)}m`;
    if (abs < 86400) return `in ${Math.floor(abs / 3600)}h`;
    return `in ${Math.floor(abs / 86400)}d`;
  }
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function statusMarker(s: RebalanceStatus): string {
  switch (s) {
    case "active": return "●";
    case "paused": return "‖";
    case "completed": return "✓";
    case "cancelled": return "✕";
  }
}

function describeTargets(row: RebalanceRow): string {
  try {
    const targets = JSON.parse(row.targets_json) as RebalanceTarget[];
    return targets.map((t) => `${t.token}=${t.targetPct}%`).join(" / ");
  } catch {
    return "(invalid targets_json)";
  }
}

function parsePlanId(raw: string | undefined): number {
  if (!raw) throw new ToolError("INVALID_PARAMS", "Plan id is required.");
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ToolError("INVALID_PARAMS", `Invalid plan id "${raw}" — expected a positive integer.`);
  }
  return n;
}

// ── create ───────────────────────────────────────────────────

export async function rebalanceCreateCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const accountLabel = flags["account"] ?? config.activeAccount ?? "default";

  // --targets: JSON-array string. The CLI form is the same shape the
  // MCP tool accepts so operator scripts can move between surfaces
  // without translating.
  const targetsRaw = flags["targets"];
  if (!targetsRaw) {
    throw new ToolError(
      "INVALID_PARAMS",
      "--targets is required. Pass a JSON array, e.g.  --targets '[{\"token\":\"ETH\",\"targetPct\":60},{\"token\":\"USDC\",\"targetPct\":40}]'",
    );
  }
  let targets: RebalanceTarget[];
  try {
    const parsed = JSON.parse(targetsRaw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    targets = parsed as RebalanceTarget[];
  } catch (e) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--targets must be a JSON array of {token, targetPct} entries. Parse error: ${(e as Error).message}.`,
    );
  }

  const driftThresholdPct = parseFloatFlag(flags["drift-threshold"], "--drift-threshold", { min: 0, max: 100 });
  const minTradeUsd = parseFloatFlag(flags["min-trade-usd"], "--min-trade-usd", { min: 0 });
  const slippageBps = parseIntFlag(flags["slippage"], "--slippage", { min: 1, max: 10_000 });
  const maxRuns = parseIntFlag(flags["max-runs"], "--max-runs", { min: 1, max: 100_000 });

  let startAt: string | undefined;
  if (flags["start-at"]) {
    const t = Date.parse(flags["start-at"]);
    if (!Number.isFinite(t)) throw new ToolError("INVALID_PARAMS", `--start-at must be ISO-8601 (got "${flags["start-at"]}").`);
    startAt = new Date(t).toISOString();
  }
  let endAt: string | undefined;
  if (flags["end-at"]) {
    const t = Date.parse(flags["end-at"]);
    if (!Number.isFinite(t)) throw new ToolError("INVALID_PARAMS", `--end-at must be ISO-8601 (got "${flags["end-at"]}").`);
    endAt = new Date(t).toISOString();
  }

  const row = createRebalancePlanRow(
    {
      name: flags["name"],
      account: accountLabel,
      chain: chainName,
      quoteToken: flags["quote-token"],
      targets,
      driftThresholdPct,
      minTradeUsd,
      cron: flags["cron"],
      startAt,
      endAt,
      maxRuns,
      slippageBps,
      autoSlippage: flags["auto-slippage"] === "true",
      strategy: resolveStrategy(flags["strategy"], process.env.TRADEKIT_STRATEGY),
      note: flags["note"],
    },
    config,
  );

  if (flags["json"] === "true") {
    printJson({ ok: true, plan: row });
    return;
  }
  console.log(`Created rebalance plan #${row.id}${row.name ? ` (${row.name})` : ""}  ${statusMarker(row.status)} ${row.status}`);
  console.log(`  Targets:  ${describeTargets(row)}`);
  console.log(`  Anchor:   ${row.quote_symbol ?? row.quote_token}`);
  console.log(`  Threshold: drift ≥ ${row.drift_threshold_pct}% triggers a rebalance`);
  console.log(`  Min trade: $${row.min_trade_usd} per leg (sub-threshold legs skip)`);
  console.log(`  Cron:     ${row.cron_expr}`);
  console.log(`  Chain:    ${row.chain}   Account: ${row.account}`);
  if (row.slippage_bps != null) console.log(`  Slippage: ${row.slippage_bps} bps${row.auto_slippage ? "  (auto)" : ""}`);
  if (row.strategy) console.log(`  Strategy: ${row.strategy}`);
  if (row.start_at) console.log(`  Start:    ${row.start_at}  (${formatRelativeAge(row.start_at)})`);
  if (row.end_at) console.log(`  End:      ${row.end_at}  (${formatRelativeAge(row.end_at)})`);
  if (row.max_runs != null) console.log(`  Max runs: ${row.max_runs}`);
  console.log(`  Next:     ${row.next_run_at}  (${formatRelativeAge(row.next_run_at)})`);
  console.log("");
  console.log("  The engine evaluates this plan on each tick; trades fire when max drift exceeds the threshold.");
  console.log("  Start the engine with:  tradekit engine run     (or just  tradekit rebalance run)");
}

// ── list ─────────────────────────────────────────────────────

const VALID_STATUSES: ReadonlyArray<RebalanceStatus | "all"> = [
  "all", "active", "paused", "completed", "cancelled",
];

export async function rebalanceListCommand(flags: Record<string, string>) {
  const statusRaw = (flags["status"] ?? "active").toLowerCase();
  if (!VALID_STATUSES.includes(statusRaw as RebalanceStatus | "all")) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--status must be one of ${VALID_STATUSES.join("|")} (got "${statusRaw}").`,
    );
  }
  const limit = parseIntFlag(flags["limit"], "--limit", { min: 1, max: 1000 });
  const rows = listRebalancePlans({
    status: statusRaw as RebalanceStatus | "all",
    chain: flags["chain"],
    account: flags["account"],
    strategy: flags["strategy"],
    limit,
  });
  const counts = rebalancePlanCountsByStatus();

  if (flags["json"] === "true") {
    printJson({ ok: true, summary: { total: rows.length, byStatus: counts }, items: rows });
    return;
  }
  console.log(`Rebalance plans (status: ${statusRaw}, showing ${rows.length})`);
  console.log(`Counts: active=${counts.active} paused=${counts.paused} completed=${counts.completed} cancelled=${counts.cancelled}`);
  console.log("");
  if (rows.length === 0) {
    console.log("(no plans match this filter)");
    return;
  }
  const hdr =
    `  #ID  ST  NAME            TARGETS                            THRESHOLD  NEXT             RUNS`;
  console.log(hdr);
  console.log("  " + "─".repeat(hdr.length - 2));
  for (const r of rows) {
    const id = String(r.id ?? "?").padStart(4);
    const st = (statusMarker(r.status) + " " + r.status).padEnd(11);
    const name = (r.name ?? "—").padEnd(15);
    const targets = describeTargets(r).padEnd(35).slice(0, 35);
    const thresh = `≥ ${r.drift_threshold_pct}%`.padEnd(10);
    const next = formatRelativeAge(r.next_run_at).padEnd(16);
    const runs = r.max_runs != null ? `${r.run_count}/${r.max_runs}` : String(r.run_count);
    console.log(`  ${id}  ${st} ${name} ${targets} ${thresh} ${next} ${runs}`);
  }
}

// ── show ─────────────────────────────────────────────────────

export async function rebalanceShowCommand(flags: Record<string, string>, positional: string[]) {
  const id = parsePlanId(positional[2]);
  const row = getRebalancePlanById(id);
  if (!row) {
    throw new ToolError("INVALID_PARAMS", `Rebalance plan #${id} not found.`, { details: { planId: id } });
  }
  if (flags["json"] === "true") {
    printJson({ ok: true, plan: row });
    return;
  }
  console.log(`Plan #${row.id}${row.name ? ` (${row.name})` : ""}  ${statusMarker(row.status)} ${row.status.toUpperCase()}`);
  console.log(`  Targets:  ${describeTargets(row)}`);
  console.log(`  Anchor:   ${row.quote_symbol ?? row.quote_token}`);
  console.log(`  Threshold: drift ≥ ${row.drift_threshold_pct}% triggers`);
  console.log(`  Min trade: $${row.min_trade_usd} per leg`);
  console.log(`  Cron:     ${row.cron_expr}`);
  console.log(`  Chain:    ${row.chain}    Account: ${row.account}`);
  if (row.slippage_bps != null) console.log(`  Slippage: ${row.slippage_bps} bps${row.auto_slippage ? "  (auto)" : ""}`);
  if (row.strategy) console.log(`  Strategy: ${row.strategy}`);
  if (row.note) console.log(`  Note:     ${row.note}`);
  console.log("");
  console.log(`  Created: ${row.created_at}`);
  console.log(`  Updated: ${row.updated_at}`);
  if (row.start_at) console.log(`  Start:   ${row.start_at}  (${formatRelativeAge(row.start_at)})`);
  if (row.end_at) console.log(`  End:     ${row.end_at}  (${formatRelativeAge(row.end_at)})`);
  if (row.max_runs != null) console.log(`  Max runs: ${row.max_runs}`);
  console.log(`  Next:    ${row.next_run_at}  (${formatRelativeAge(row.next_run_at)})`);
  console.log("");
  console.log(`  Runs:    ${row.run_count}${row.max_runs != null ? ` / ${row.max_runs}` : ""}`);
  if (row.last_run_at) {
    console.log(`  Last run: ${row.last_run_at}  (${formatRelativeAge(row.last_run_at)}, status=${row.last_run_status ?? "?"})`);
    if (row.last_run_max_drift_pct != null) {
      console.log(`    max drift:      ${row.last_run_max_drift_pct.toFixed(2)}%`);
    }
    if (row.last_run_executed_count != null) {
      console.log(`    executed legs:  ${row.last_run_executed_count}`);
    }
    if (row.last_run_skipped_count != null) {
      console.log(`    skipped legs:   ${row.last_run_skipped_count}`);
    }
  }
  if (row.last_error_code) {
    console.log(`  Last error: [${row.last_error_code}] ${row.last_error_message ?? ""}`);
  }
}

// ── pause / resume / cancel ──────────────────────────────────

export async function rebalancePauseCommand(flags: Record<string, string>, positional: string[]) {
  const id = parsePlanId(positional[2]);
  const row = pauseRebalancePlanById(id);
  if (flags["json"] === "true") printJson({ ok: true, plan: row });
  else console.log(`Paused rebalance plan #${row.id}  (status → ${row.status})`);
}

export async function rebalanceResumeCommand(flags: Record<string, string>, positional: string[]) {
  const id = parsePlanId(positional[2]);
  const row = resumeRebalancePlanById(id);
  if (flags["json"] === "true") printJson({ ok: true, plan: row });
  else console.log(`Resumed rebalance plan #${row.id}  (status → ${row.status}, next: ${row.next_run_at})`);
}

export async function rebalanceCancelCommand(flags: Record<string, string>, positional: string[]) {
  const id = parsePlanId(positional[2]);
  const existing = getRebalancePlanById(id);
  if (!existing) {
    throw new ToolError("INVALID_PARAMS", `Rebalance plan #${id} not found.`, { details: { planId: id } });
  }
  if (
    existing.status === "active" &&
    flags["yes"] !== "true" &&
    flags["json"] !== "true" &&
    process.stdin.isTTY
  ) {
    const reply = await prompt(`Cancel plan #${id} (${existing.name ?? "unnamed"})? type 'cancel': `);
    if (reply.trim().toLowerCase() !== "cancel") {
      throw new ToolError("INVALID_PARAMS", "Cancel aborted — confirmation phrase didn't match.");
    }
  }
  const row = cancelRebalancePlanById(id);
  if (flags["json"] === "true") printJson({ ok: true, plan: row });
  else console.log(`Cancelled rebalance plan #${row.id}  (status → ${row.status})`);
}

// ── run (engine) ─────────────────────────────────────────────

export async function rebalanceRunCommand(flags: Record<string, string>) {
  if (flags["once"] !== "true" && flags["watch"] == null) {
    flags["watch"] = "300"; // 5min — rebalance ticks are heavier (portfolio fetch + maybe trades)
  }
  const dryRun = flags["dry-run"] === "true";
  const strict = flags["strict"] === "true";
  const logger = makeCliLogger(flags);
  let password: string | undefined;
  if (!dryRun) {
    if (flags["pass"]) password = flags["pass"];
    else if (process.env.WALLET_PASS) password = process.env.WALLET_PASS;
    if (!password && process.stdin.isTTY && flags["watch"] == null) {
      password = await requirePassword(flags);
    }
  }
  const work = async () => {
    const report = await runRebalanceTick({
      chain: flags["chain"],
      account: flags["account"],
      password,
      dryRun,
      logger,
    });
    if (flags["json"] === "true") {
      printJson(report);
    } else {
      const dryNote = dryRun ? "  [DRY-RUN]" : "";
      console.log(
        `tick @ ${formatRelativeAge(report.timestamp)}${dryNote}: due=${report.due} executed=${report.executed} ` +
        `skipped=${report.skipped} failed=${report.failed} completed=${report.completed}  (${report.elapsedMs}ms)`,
      );
      for (const f of report.fires) {
        const tag =
          f.status === "executed" ? "✓ EXECUTED" :
          f.status === "failed" ? "✗ FAILED" :
          f.status === "completed" ? "✓ COMPLETED" : "· skipped";
        const nameBit = f.name ? ` (${f.name})` : "";
        const driftBit = f.maxDriftPct != null ? `  maxDrift=${f.maxDriftPct.toFixed(2)}%` : "";
        const errBit = f.errorCode ? `  [${f.errorCode}] ${f.errorMessage ?? ""}` : "";
        const nextBit = f.nextRunAt ? `  next=${formatRelativeAge(f.nextRunAt)}` : "";
        console.log(`  ${tag}  #${f.planId}${nameBit}${driftBit}${errBit}${nextBit}`);
        for (const leg of f.executed) {
          const sigil = leg.ok ? "  ✓" : "  ✗";
          const tx = leg.txHash ? `  tx=${leg.txHash.slice(0, 10)}…${leg.txHash.slice(-4)}` : "";
          const err = leg.error ? `  — ${leg.error}` : "";
          console.log(`    ${sigil} ${leg.description}${tx}${err}`);
        }
        for (const leg of f.skipped) {
          console.log(`    ↷ ${leg.description}  (skipped: ${leg.reason})`);
        }
      }
      if (report.recommendedActions.length > 0) {
        console.log("");
        for (const a of report.recommendedActions) console.log(`  → ${a.tool}: ${a.reason}`);
      }
    }
    if (strict && report.failed > 0) process.exitCode = 1;
  };
  await withWatch(flags, work);
}

// ── dispatch ─────────────────────────────────────────────────

export async function rebalanceCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  switch (action) {
    case "create": await rebalanceCreateCommand(flags); break;
    case "list":   await rebalanceListCommand(flags); break;
    case "show":   await rebalanceShowCommand(flags, positional); break;
    case "pause":  await rebalancePauseCommand(flags, positional); break;
    case "resume": await rebalanceResumeCommand(flags, positional); break;
    case "cancel": await rebalanceCancelCommand(flags, positional); break;
    case "run":    await rebalanceRunCommand(flags); break;
    default:
      throw subcommandError("rebalance", action, ["create", "list", "show", "pause", "resume", "cancel", "run"]);
  }
}
