// CLI surface for scheduled / recurring trades (DCA primitive).
//
//   tradekit schedule create --name X --side buy|sell --chain X --base ... --quote ...
//                            (--baseAmount A | --quoteAmount A)
//                            (--cron "<5-field>" | --every 1h|6h|1d|7d)
//                            [--slippage bps] [--auto-slippage]
//                            [--start-at <ISO>] [--end-at <ISO>] [--max-runs N]
//                            [--strategy TAG] [--note "..."] [--account L] [--json]
//   tradekit schedule list   [--status all|active|paused|completed|cancelled]
//                            [--chain X] [--account L] [--strategy TAG]
//                            [--limit N] [--json]
//   tradekit schedule show   <id> [--json]
//   tradekit schedule pause  <id> [--json]
//   tradekit schedule resume <id> [--json]
//   tradekit schedule cancel <id> [--yes] [--json]
//   tradekit schedule run    [--once] [--chain X] [--account L] [--dry-run]
//                            [--pass <pw>] [--strict] [--json] [--watch N]
//
// `schedule run` is the engine entry — same shape as `order run` so an
// operator can deploy both as parallel daemons or as parallel cron jobs.

import type { Address } from "viem";
import { ToolError } from "../errors.js";
import { loadConfig } from "../config.js";
import { resolveProfile } from "../config.js";
import { resolveTradePair } from "../chains.js";
import {
  createScheduleRow,
  pauseScheduleById,
  resumeScheduleById,
  cancelScheduleById,
  runScheduleTick,
  listSchedules,
  getScheduleById,
  type ScheduleRow,
  type ScheduleStatus,
} from "../schedules.js";
import { scheduleCountsByStatus } from "../db.js";
import {
  makeCliLogger,
  printJson,
  parseIntFlag,
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

function statusMarker(s: ScheduleStatus): string {
  switch (s) {
    case "active": return "●";
    case "paused": return "‖";
    case "completed": return "✓";
    case "cancelled": return "✕";
  }
}

function describeIntent(s: Pick<ScheduleRow, "side" | "base_amount" | "quote_amount" | "base_symbol" | "quote_symbol">): string {
  if (s.base_amount) return `${s.side} ${s.base_amount} ${s.base_symbol ?? "base"}`;
  if (s.quote_amount) return `${s.side} ${s.base_symbol ?? "base"} for ${s.quote_amount} ${s.quote_symbol ?? "quote"}`;
  return s.side;
}

function shortHash(h: string | null): string {
  if (!h) return "—";
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}

// ── create ───────────────────────────────────────────────────

export async function scheduleCreateCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);

  const side = flags["side"];
  if (side !== "buy" && side !== "sell") {
    throw new ToolError("INVALID_PARAMS", `--side must be buy or sell (got "${side ?? "(missing)"}").`);
  }
  if (!flags["cron"] && !flags["every"]) {
    throw new ToolError(
      "INVALID_PARAMS",
      "One of --cron \"<5-field>\" or --every <duration> (30m, 1h, 6h, 1d, 7d) is required.",
    );
  }
  if (flags["cron"] && flags["every"]) {
    throw new ToolError("INVALID_PARAMS", "Pass --cron OR --every, not both.");
  }

  const slippageBps = parseIntFlag(flags["slippage"], "--slippage", { min: 1, max: 10_000 });
  const maxRuns = parseIntFlag(flags["max-runs"], "--max-runs", { min: 1, max: 100_000 });

  let startAt: string | undefined;
  if (flags["start-at"]) {
    const t = Date.parse(flags["start-at"]);
    if (!Number.isFinite(t)) {
      throw new ToolError("INVALID_PARAMS", `--start-at must be ISO-8601 (got "${flags["start-at"]}").`);
    }
    startAt = new Date(t).toISOString();
  }
  let endAt: string | undefined;
  if (flags["end-at"]) {
    const t = Date.parse(flags["end-at"]);
    if (!Number.isFinite(t)) {
      throw new ToolError("INVALID_PARAMS", `--end-at must be ISO-8601 (got "${flags["end-at"]}").`);
    }
    endAt = new Date(t).toISOString();
  }

  const { base, quote } = resolveTradePair(profile, flags["base"] ?? "ETH", flags["quote"] ?? "USDC");
  const accountLabel = flags["account"] ?? config.activeAccount ?? "default";

  // Iter27: post-fill hook (--on-fill <json> or --on-fill-file <path>).
  // Either accepts a JSON string inline OR a path to a JSON file. The
  // resulting raw object is validated by createScheduleRow before the
  // row is persisted — bad hooks fail BEFORE schedule create.
  let onFill: unknown | undefined;
  if (flags["on-fill"] && flags["on-fill-file"]) {
    throw new ToolError("INVALID_PARAMS", "Pass --on-fill OR --on-fill-file, not both.");
  }
  if (flags["on-fill"]) {
    try {
      onFill = JSON.parse(flags["on-fill"]);
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `--on-fill is not valid JSON: ${(e as Error).message}`);
    }
  } else if (flags["on-fill-file"]) {
    const { readFileSync } = await import("node:fs");
    const { resolve: resolvePath } = await import("node:path");
    const absPath = resolvePath(flags["on-fill-file"]);
    let text: string;
    try {
      text = readFileSync(absPath, "utf8");
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `Cannot read --on-fill-file "${flags["on-fill-file"]}": ${(e as Error).message}`);
    }
    try {
      onFill = JSON.parse(text);
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `--on-fill-file "${flags["on-fill-file"]}" is not valid JSON: ${(e as Error).message}`);
    }
  }

  const row = createScheduleRow(
    {
      name: flags["name"],
      cron: flags["cron"],
      every: flags["every"],
      side,
      chain: profile.name,
      account: accountLabel,
      base,
      quote,
      baseAmount: flags["baseAmount"],
      quoteAmount: flags["quoteAmount"],
      slippageBps,
      autoSlippage: flags["auto-slippage"] === "true",
      startAt,
      endAt,
      maxRuns,
      strategy: resolveStrategy(flags["strategy"], process.env.TRADEKIT_STRATEGY),
      note: flags["note"],
      onFill,
      paper: flags["paper"] === "true",
    },
    config,
  );

  if (flags["json"] === "true") {
    printJson({ ok: true, schedule: row });
    return;
  }
  console.log(`Created schedule #${row.id}${row.name ? ` (${row.name})` : ""}  ${statusMarker(row.status)} ${row.status}`);
  console.log(`  Cron:    ${row.cron_expr}`);
  console.log(`  Intent:  ${describeIntent(row)} on ${row.chain} (account: ${row.account})`);
  if (row.slippage_bps) console.log(`  Slippage: ${row.slippage_bps} bps`);
  if (row.start_at) console.log(`  Start:   ${row.start_at}  (${formatRelativeAge(row.start_at)})`);
  if (row.end_at) console.log(`  End:     ${row.end_at}  (${formatRelativeAge(row.end_at)})`);
  if (row.max_runs != null) console.log(`  Max runs: ${row.max_runs}`);
  if (row.strategy) console.log(`  Strategy: ${row.strategy}`);
  console.log(`  Next:    ${row.next_run_at}  (${formatRelativeAge(row.next_run_at)})`);
  console.log("");
  console.log("  The schedule fires when the engine sees next_run_at in the past.");
  console.log("  Start the engine with:  tradekit schedule run");
}

// ── list ─────────────────────────────────────────────────────

const VALID_STATUSES: ReadonlyArray<ScheduleStatus | "all"> = [
  "all", "active", "paused", "completed", "cancelled",
];

export async function scheduleListCommand(flags: Record<string, string>) {
  const statusRaw = (flags["status"] ?? "active").toLowerCase();
  if (!VALID_STATUSES.includes(statusRaw as ScheduleStatus | "all")) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--status must be one of ${VALID_STATUSES.join("|")} (got "${statusRaw}").`,
    );
  }
  const limit = parseIntFlag(flags["limit"], "--limit", { min: 1, max: 1000 });
  const rows = listSchedules({
    status: statusRaw as ScheduleStatus | "all",
    chain: flags["chain"],
    account: flags["account"],
    strategy: flags["strategy"],
    limit,
  });
  const counts = scheduleCountsByStatus();

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      summary: { total: rows.length, byStatus: counts },
      items: rows,
    });
    return;
  }
  console.log(`Schedules (status: ${statusRaw}, showing ${rows.length})`);
  console.log(
    `Counts: active=${counts.active} paused=${counts.paused} ` +
    `completed=${counts.completed} cancelled=${counts.cancelled}`,
  );
  console.log("");
  if (rows.length === 0) {
    console.log("(no schedules match this filter)");
    return;
  }
  const hdr =
    `  #ID  ST  NAME            CRON                  INTENT                              NEXT             RUNS`;
  console.log(hdr);
  console.log("  " + "─".repeat(hdr.length - 2));
  for (const r of rows) {
    const id = String(r.id ?? "?").padStart(4);
    const st = (statusMarker(r.status) + " " + r.status).padEnd(11);
    const name = (r.name ?? "—").padEnd(15);
    const cron = r.cron_expr.padEnd(21);
    const intent = describeIntent(r).padEnd(36);
    const next = formatRelativeAge(r.next_run_at).padEnd(16);
    const runs = r.max_runs != null ? `${r.run_count}/${r.max_runs}` : String(r.run_count);
    console.log(`  ${id}  ${st} ${name} ${cron} ${intent} ${next} ${runs}`);
  }
}

// ── show ─────────────────────────────────────────────────────

export async function scheduleShowCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[2];
  if (!idArg) throw new ToolError("INVALID_PARAMS", "Usage: tradekit schedule show <id> [--json]");
  const id = parseInt(idArg, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `Invalid schedule id "${idArg}" — expected a positive integer.`);
  }
  const row = getScheduleById(id);
  if (!row) {
    throw new ToolError("INVALID_PARAMS", `Schedule #${id} not found.`, { details: { scheduleId: id } });
  }
  if (flags["json"] === "true") {
    printJson({ ok: true, schedule: row });
    return;
  }
  console.log(`Schedule #${row.id}${row.name ? ` (${row.name})` : ""}  ${statusMarker(row.status)} ${row.status.toUpperCase()}`);
  console.log(`  Cron:    ${row.cron_expr}`);
  console.log(`  Side:    ${row.side}`);
  console.log(`  Pair:    ${row.base_symbol ?? row.base_token} → ${row.quote_symbol ?? row.quote_token}`);
  console.log(`  Amount:  ${row.base_amount ? `${row.base_amount} ${row.base_symbol ?? "base"}` : `${row.quote_amount} ${row.quote_symbol ?? "quote"}`}`);
  console.log(`  Chain:   ${row.chain}    Account: ${row.account}`);
  if (row.slippage_bps != null) console.log(`  Slippage: ${row.slippage_bps} bps${row.auto_slippage ? "  (auto)" : ""}`);
  else if (row.auto_slippage) console.log(`  Slippage: auto`);
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
  if (row.total_base_filled) console.log(`  Total base filled:  ${row.total_base_filled} ${row.base_symbol ?? ""}`);
  if (row.total_quote_spent) console.log(`  Total quote spent:  ${row.total_quote_spent} ${row.quote_symbol ?? ""}`);
  if (row.last_run_at) {
    console.log(`  Last run: ${row.last_run_at}  (${formatRelativeAge(row.last_run_at)}, status=${row.last_run_status ?? "?"})`);
    if (row.last_run_tx_hash) console.log(`    tx:    ${shortHash(row.last_run_tx_hash)}`);
  }
  if (row.last_error_code) {
    console.log(`  Last error: [${row.last_error_code}] ${row.last_error_message ?? ""}`);
  }

  // v29: recent decision-journal tail. last_run_* only remembers the
  // LATEST outcome; the journal tail shows the last few decisions
  // inline so the common "what has this schedule been doing?" case
  // doesn't need a separate replay invocation.
  const { replayScheduleEntries } = await import("../db.js");
  const recent = replayScheduleEntries(row.id!, 5);
  if (recent.length > 0) {
    console.log("");
    console.log(`  Recent decisions (schedule replay ${row.id} for full history):`);
    for (const e of recent) {
      const run = e.run_number != null ? `  run #${e.run_number}` : "";
      const err = e.error_code ? `  [${e.error_code}]` : "";
      console.log(`    ${e.checked_at}  ${e.decision}${run}${err}`);
    }
  }
}

// ── pause / resume / cancel ──────────────────────────────────

export async function schedulePauseCommand(flags: Record<string, string>, positional: string[]) {
  const id = parseScheduleId(positional[2]);
  const row = pauseScheduleById(id);
  if (flags["json"] === "true") printJson({ ok: true, schedule: row });
  else console.log(`Paused schedule #${row.id}  (status → ${row.status})`);
}

export async function scheduleResumeCommand(flags: Record<string, string>, positional: string[]) {
  const id = parseScheduleId(positional[2]);
  const row = resumeScheduleById(id);
  if (flags["json"] === "true") printJson({ ok: true, schedule: row });
  else console.log(`Resumed schedule #${row.id}  (status → ${row.status}, next: ${row.next_run_at})`);
}

export async function scheduleCancelCommand(flags: Record<string, string>, positional: string[]) {
  const id = parseScheduleId(positional[2]);
  const existing = getScheduleById(id);
  if (!existing) {
    throw new ToolError("INVALID_PARAMS", `Schedule #${id} not found.`, { details: { scheduleId: id } });
  }
  if (
    existing.status === "active" &&
    flags["yes"] !== "true" &&
    flags["json"] !== "true" &&
    process.stdin.isTTY
  ) {
    const reply = await prompt(`Cancel schedule #${id} (${existing.name ?? "unnamed"}, cron: ${existing.cron_expr})? type 'cancel': `);
    if (reply.trim().toLowerCase() !== "cancel") {
      throw new ToolError("INVALID_PARAMS", "Cancel aborted — confirmation phrase didn't match.");
    }
  }
  const row = cancelScheduleById(id);
  if (flags["json"] === "true") printJson({ ok: true, schedule: row });
  else console.log(`Cancelled schedule #${row.id}  (status → ${row.status})`);
}

function parseScheduleId(raw: string | undefined): number {
  if (!raw) throw new ToolError("INVALID_PARAMS", "Schedule id is required.");
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ToolError("INVALID_PARAMS", `Invalid schedule id "${raw}" — expected a positive integer.`);
  }
  return n;
}

// ── run (engine) ─────────────────────────────────────────────

export async function scheduleRunCommand(flags: Record<string, string>) {
  if (flags["once"] !== "true" && flags["watch"] == null) {
    flags["watch"] = "30";
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
    const report = await runScheduleTick({
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
        `tick @ ${formatRelativeAge(report.timestamp)}${dryNote}: due=${report.due} fired=${report.fired} ` +
        `failed=${report.failed} completed=${report.completed} skipped=${report.skipped}  (${report.elapsedMs}ms)`,
      );
      for (const f of report.fires) {
        const tag =
          f.status === "fired" ? "✓ FIRED" :
          f.status === "failed" ? "✗ FAILED" :
          f.status === "completed" ? "✓ COMPLETED" : "·";
        const nameBit = f.name ? ` (${f.name})` : "";
        const txBit = f.txHash ? `  tx=${shortHash(f.txHash)}` : "";
        const errBit = f.errorCode ? `  [${f.errorCode}] ${f.errorMessage ?? ""}` : "";
        const nextBit = f.nextRunAt ? `  next=${formatRelativeAge(f.nextRunAt)}` : "";
        console.log(`  ${tag}  #${f.scheduleId}${nameBit}${txBit}${errBit}${nextBit}`);
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

export async function scheduleCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  switch (action) {
    case "create": await scheduleCreateCommand(flags); break;
    case "list":   await scheduleListCommand(flags); break;
    case "show":   await scheduleShowCommand(flags, positional); break;
    case "pause":  await schedulePauseCommand(flags, positional); break;
    case "resume": await scheduleResumeCommand(flags, positional); break;
    case "cancel": await scheduleCancelCommand(flags, positional); break;
    case "edit":   await scheduleEditCommand(flags, positional); break;
    case "run":    await scheduleRunCommand(flags); break;
    case "replay": await scheduleReplayCommand(flags, positional); break;
    default:
      throw subcommandError("schedule", action, ["create", "list", "show", "pause", "resume", "cancel", "edit", "run", "replay"]);
  }
}

/** v29: decision-journal replay — every fired / fire_failed / retired /
 *  locked-skip / hook outcome with exact timestamps. Gated by
 *  engine.scheduleJournal.enabled (the command works either way; it
 *  explains how to enable when the journal is off). */
export async function scheduleReplayCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[2];
  if (!idArg) throw new ToolError("INVALID_PARAMS", `Usage: tradekit schedule replay <id>`);
  const id = parseInt(idArg, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `<id> must be a positive integer (got "${idArg}").`);
  }
  const schedule = getScheduleById(id);
  if (!schedule) throw new ToolError("INVALID_PARAMS", `Schedule #${id} not found.`);
  const { replayScheduleEntries } = await import("../db.js");
  const { loadConfig } = await import("../config.js");
  const config = loadConfig();
  const limit = flags["limit"] ? parseInt(flags["limit"], 10) : 200;
  const entries = replayScheduleEntries(id, Number.isFinite(limit) && limit > 0 ? limit : 200);

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      scheduleId: id,
      journalEnabled: config.engine.scheduleJournal?.enabled === true,
      count: entries.length,
      entries,
    });
    return;
  }
  console.log(`Schedule #${id}${schedule.name ? ` (${schedule.name})` : ""}  ${schedule.side} ${schedule.base_symbol ?? "?"}/${schedule.quote_symbol ?? "?"}  status=${schedule.status}  run_count=${schedule.run_count}`);
  console.log("");
  if (config.engine.scheduleJournal?.enabled !== true) {
    console.log(`Schedule journal is NOT enabled. To enable forensic decision tracking:`);
    console.log(`  tradekit config set engine.scheduleJournal '{"enabled":true}'`);
    console.log("");
  }
  if (entries.length === 0) {
    console.log(`No journal entries for this schedule yet.`);
    return;
  }
  for (const e of entries) {
    const marker =
      e.decision === "fired" || e.decision === "hook_created" ? "●" :
      e.decision.startsWith("retired") ? "✓" :
      e.decision.startsWith("skipped") ? "‖" : "✕";
    const run = e.run_number != null ? `  run #${e.run_number}` : "";
    const tx = e.tx_hash ? `  tx ${e.tx_hash.slice(0, 14)}…` : "";
    const err = e.error_code ? `  [${e.error_code}]` : "";
    console.log(`  ${marker} ${e.checked_at}  ${e.decision.padEnd(18)}${run}${tx}${err}${e.notes ? `  ${e.notes}` : ""}`);
  }
}

/** Iter34: in-place schedule edit. Same shape as `order edit`. Cron
 *  edit triggers next_run_at recomputation (the operator-driven cron
 *  change should fire on the next natural occurrence; the prior
 *  next_run_at was relative to the OLD cron, so it's stale). */
export async function scheduleEditCommand(
  flags: Record<string, string>,
  positional: string[],
) {
  const idStr = positional[2];
  if (!idStr) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Usage: tradekit schedule edit <id> [--cron \"...\" | --every D] [--base-amount A | --quote-amount A] [--slippage-bps N] [--auto-slippage] [--end-at ISO] [--max-runs N] [--note \"...\"] [--strategy TAG] [--paper] [--on-fill-file P] [--unset end-at|max-runs|note|strategy|on-fill]",
    );
  }
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `Invalid schedule id "${idStr}".`);
  }

  const changes: import("../scheduleEdit.js").ScheduleEditChanges = {};
  if (flags["unset"]) {
    for (const raw of flags["unset"].split(",")) {
      const f = raw.trim();
      switch (f) {
        case "end-at": changes.endAt = null; break;
        case "max-runs": changes.maxRuns = null; break;
        case "note": changes.note = null; break;
        case "strategy": changes.strategy = null; break;
        case "slippage-bps": changes.slippageBps = null; break;
        case "on-fill": changes.onFill = null; break;
        default:
          throw new ToolError("INVALID_PARAMS", `--unset ${f}: not a clearable field.`);
      }
    }
  }
  if (flags["cron"] != null) changes.cron = flags["cron"];
  if (flags["every"] != null) changes.every = flags["every"];
  if (flags["base-amount"] != null) {
    changes.baseAmount = flags["base-amount"];
    changes.quoteAmount = null;
  }
  if (flags["quote-amount"] != null) {
    changes.quoteAmount = flags["quote-amount"];
    changes.baseAmount = null;
  }
  if (flags["slippage-bps"] != null) {
    changes.slippageBps = parseInt(flags["slippage-bps"], 10);
  }
  if (flags["auto-slippage"] === "true") changes.autoSlippage = true;
  if (flags["auto-slippage"] === "false") changes.autoSlippage = false;
  if (flags["end-at"] != null) changes.endAt = flags["end-at"];
  if (flags["max-runs"] != null) changes.maxRuns = parseInt(flags["max-runs"], 10);
  if (flags["note"] != null) changes.note = flags["note"];
  if (flags["strategy"] != null) changes.strategy = flags["strategy"];
  if (flags["paper"] === "true") changes.paper = true;
  if (flags["paper"] === "false") changes.paper = false;
  if (flags["on-fill"] != null) {
    try {
      changes.onFill = JSON.parse(flags["on-fill"]);
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `--on-fill is not valid JSON: ${(e as Error).message}`);
    }
  } else if (flags["on-fill-file"] != null) {
    try {
      const { readFileSync } = await import("node:fs");
      const text = readFileSync(flags["on-fill-file"], "utf8");
      changes.onFill = JSON.parse(text);
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `--on-fill-file "${flags["on-fill-file"]}" is not valid JSON: ${(e as Error).message}`);
    }
  }

  const { editSchedule } = await import("../scheduleEdit.js");
  const result = editSchedule({ id, changes });

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      scheduleId: id,
      changed: result.diff.length > 0,
      diff: result.diff,
      schedule: result.schedule,
    });
    return;
  }
  if (result.diff.length === 0) {
    console.log(`Schedule #${id}: no changes.`);
    return;
  }
  console.log(`Schedule #${id}: edited ${result.diff.length} field${result.diff.length === 1 ? "" : "s"}.`);
  for (const d of result.diff) {
    console.log(`  ${d.field}: ${fmtFieldValueSchedule(d.oldValue)} → ${fmtFieldValueSchedule(d.newValue)}`);
  }
  console.log(`  run_count preserved: ${result.schedule.run_count}`);
}

function fmtFieldValueSchedule(v: string | number | boolean | null): string {
  if (v == null) return "(null)";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}
