// CLI surface for the conditional-orders engine.
//
//   tradekit order create  --side ... --trigger ... --price N --base ... --quote ...
//                          (--baseAmount A | --quoteAmount A) [--slippage bps]
//                          [--expires-in 7d | --expires-at <ISO>] [--strategy ...] [--note ...]
//                          [--chain X] [--account L] [--json]
//   tradekit order list    [--status all|active|filled|cancelled|expired|failed]
//                          [--chain X] [--account L] [--strategy TAG] [--limit N] [--json]
//   tradekit order show    <id> [--json]
//   tradekit order cancel  <id> [--yes] [--json]
//   tradekit order run     [--once] [--chain X] [--account L] [--dry-run]
//                          [--pass <pw>] [--strict] [--json] [--watch N]
//   tradekit order help
//
// `order run` is the engine entry. Without --once it implies --watch 30 — the
// most common deployment is "set it and forget it". With --json --watch N it
// emits JSONL one record per tick (Vector / Fluent Bit friendly).

import type { Address } from "viem";
import { ToolError } from "../errors.js";
import { loadConfig } from "../config.js";
import { resolveProfile } from "../config.js";
import { resolveTradePair } from "../chains.js";
import {
  createOrderRow,
  cancelOrderById,
  runOrderTick,
  parseDurationToDate,
  listOrders,
  getOrderById,
  type OrderRow,
  type OrderStatus,
  type OrderSide,
  type OrderTrigger,
} from "../orders.js";
import { orderCountsByStatus } from "../db.js";
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
    // future timestamp (expires_at)
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

function shortHash(h: string | null): string {
  if (!h) return "—";
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}

function statusMarker(s: OrderStatus): string {
  switch (s) {
    case "active": return "○";
    case "paused": return "⏸";
    case "filled": return "●";
    case "cancelled": return "✕";
    case "expired": return "⌛";
    case "failed": return "!";
  }
}

function describeTrigger(o: Pick<OrderRow, "trigger_type" | "target_price_usd" | "trail_pct" | "water_mark_usd" | "side" | "base_symbol" | "base_token">): string {
  const sym = o.base_symbol ?? `${o.base_token.slice(0, 6)}…${o.base_token.slice(-4)}`;
  if (o.trigger_type === "trailing") {
    const pct = o.trail_pct ?? 0;
    if (o.water_mark_usd != null) {
      const dir = o.side === "sell" ? "from HWM" : "from LWM";
      return `${sym} trailing ${pct}% ${dir} $${o.water_mark_usd.toFixed(4)}`;
    }
    if (o.target_price_usd != null) {
      const dir = o.side === "sell" ? "≥" : "≤";
      return `${sym} trailing ${pct}% (activates at ${dir} $${o.target_price_usd})`;
    }
    return `${sym} trailing ${pct}%`;
  }
  const cmp = o.trigger_type === "price_below" ? "≤" : "≥";
  return `${sym} ${cmp} $${o.target_price_usd}`;
}

function describeIntent(o: Pick<OrderRow, "side" | "base_amount" | "quote_amount" | "base_symbol" | "quote_symbol">): string {
  if (o.base_amount) return `${o.side} ${o.base_amount} ${o.base_symbol ?? "base"}`;
  if (o.quote_amount) return `${o.side} ${o.base_symbol ?? "base"} for ${o.quote_amount} ${o.quote_symbol ?? "quote"}`;
  return o.side;
}

// ── create ───────────────────────────────────────────────────

function parseSide(raw: string | undefined): OrderSide {
  if (raw === "buy" || raw === "sell") return raw;
  throw new ToolError("INVALID_PARAMS", `--side must be "buy" or "sell" (got "${raw ?? "(missing)"}").`);
}

function parseTrigger(raw: string | undefined): OrderTrigger {
  if (raw === "price_below" || raw === "price_above" || raw === "trailing") return raw;
  // Friendly aliases for common operator vocabulary.
  if (raw === "below" || raw === "lt" || raw === "<=") return "price_below";
  if (raw === "above" || raw === "gt" || raw === ">=") return "price_above";
  if (raw === "trail" || raw === "trailing_stop" || raw === "trailing-stop") return "trailing";
  throw new ToolError(
    "INVALID_PARAMS",
    `--trigger must be "price_below", "price_above", or "trailing" (aliases: below/above/lt/gt/trail). Got "${raw ?? "(missing)"}").`,
  );
}

export async function orderCreateCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);

  const side = parseSide(flags["side"]);
  const trigger = parseTrigger(flags["trigger"]);
  // --price is required for price_below / price_above (it IS the trigger
  // threshold). For trailing it's OPTIONAL (activation gate). The
  // createOrderRow validator does the trigger-specific enforcement; the
  // CLI just provides a clear error when --price is missing for the
  // legacy triggers.
  const targetPriceUsd = parseFloatFlag(flags["price"], "--price", { min: 0 });
  if (trigger !== "trailing" && (targetPriceUsd == null || targetPriceUsd <= 0)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--price <USD> is required for trigger=${trigger} (it's the trigger threshold).`,
    );
  }
  // Trailing-specific: --trail-pct is the % retracement that fires the order.
  const trailPct = parseFloatFlag(flags["trail-pct"], "--trail-pct", { min: 0, max: 100 });
  if (trigger === "trailing" && (trailPct == null || trailPct <= 0)) {
    throw new ToolError(
      "INVALID_PARAMS",
      "--trail-pct <N> (in (0, 100]) is required for trigger=trailing — the % retracement that triggers the fill.",
    );
  }
  if (trigger !== "trailing" && trailPct != null) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--trail-pct is only valid with --trigger trailing (got --trigger ${trigger}).`,
    );
  }
  const slippageBps = parseIntFlag(flags["slippage"], "--slippage", { min: 1, max: 10_000 });

  // Expiry: --expires-in 7d | --expires-at <ISO>. Pick one. Convert duration
  // to absolute ISO at create time so the stored value is unambiguous (and
  // doesn't drift if the engine restarts).
  let expiresAt: string | undefined;
  if (flags["expires-in"] && flags["expires-at"]) {
    throw new ToolError("INVALID_PARAMS", "Pass --expires-in OR --expires-at, not both.");
  }
  if (flags["expires-in"]) {
    const dt = parseDurationToDate(flags["expires-in"]);
    if (!dt) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Invalid --expires-in "${flags["expires-in"]}" — use formats like 30s, 15m, 2h, 7d, 4w.`,
      );
    }
    expiresAt = dt.toISOString();
  } else if (flags["expires-at"]) {
    const t = Date.parse(flags["expires-at"]);
    if (!Number.isFinite(t)) {
      throw new ToolError("INVALID_PARAMS", `Invalid --expires-at "${flags["expires-at"]}" — expected ISO-8601.`);
    }
    expiresAt = new Date(t).toISOString();
  }

  const { base, quote } = resolveTradePair(profile, flags["base"] ?? "ETH", flags["quote"] ?? "USDC");
  const accountLabel = flags["account"] ?? config.activeAccount ?? "default";

  // v31: post-fill hook (--on-fill <json> | --on-fill-file <path>) —
  // same dialect as schedule create. Validated by createOrderRow.
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
    let text: string;
    try {
      text = readFileSync(resolvePath(flags["on-fill-file"]), "utf8");
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `Cannot read --on-fill-file "${flags["on-fill-file"]}": ${(e as Error).message}`);
    }
    try {
      onFill = JSON.parse(text);
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `--on-fill-file is not valid JSON: ${(e as Error).message}`);
    }
  }

  const row = createOrderRow(
    {
      side,
      trigger,
      // targetPriceUsd is the trigger threshold for price_below/above
      // OR the optional activation gate for trailing.
      targetPriceUsd,
      trailPct,
      chain: profile.name,
      account: accountLabel,
      base,
      quote,
      baseAmount: flags["baseAmount"],
      quoteAmount: flags["quoteAmount"],
      slippageBps,
      autoSlippage: flags["auto-slippage"] === "true",
      expiresAt,
      strategy: resolveStrategy(flags["strategy"], process.env.TRADEKIT_STRATEGY),
      note: flags["note"],
      group: flags["group"],
      paper: flags["paper"] === "true",
      onFill,
    },
    config,
  );

  if (flags["json"] === "true") {
    printJson({ ok: true, order: row });
    return;
  }
  console.log(`Created order #${row.id}  ${statusMarker(row.status)} ${row.status}`);
  console.log(`  Trigger: ${describeTrigger(row)}  (${row.trigger_type})`);
  console.log(`  Intent:  ${describeIntent(row)} on ${row.chain} (account: ${row.account})`);
  if (row.slippage_bps) console.log(`  Slippage: ${row.slippage_bps} bps`);
  if (row.expires_at) console.log(`  Expires: ${row.expires_at}  (${formatRelativeAge(row.expires_at)})`);
  if (row.strategy) console.log(`  Strategy: ${row.strategy}`);
  if (row.group_id) {
    // Show count of existing peers (excluding self) so operators understand
    // "this is now the 3rd order in the group".
    const peers = listOrders({ group: row.group_id });
    const peerCount = peers.length - 1;
    console.log(`  OCO group: ${row.group_id}${peerCount > 0 ? `  (${peerCount} peer${peerCount === 1 ? "" : "s"} active)` : "  (no peers yet)"}`);
  }
  if (row.on_fill_json) console.log(`  On fill: auto-creates a follow-up order (hook validated)`);
  console.log("");
  console.log("  The order fires when the engine sees the price predicate hit.");
  console.log("  Start the engine with:  tradekit order run");
}

// ── list ─────────────────────────────────────────────────────

const VALID_STATUSES: ReadonlyArray<OrderStatus | "all"> = [
  "all", "active", "paused", "filled", "cancelled", "expired", "failed",
];

export async function orderListCommand(flags: Record<string, string>) {
  const statusRaw = (flags["status"] ?? "active").toLowerCase();
  if (!VALID_STATUSES.includes(statusRaw as OrderStatus | "all")) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--status must be one of ${VALID_STATUSES.join("|")} (got "${statusRaw}").`,
    );
  }
  const limit = parseIntFlag(flags["limit"], "--limit", { min: 1, max: 1000 });
  const rows = listOrders({
    status: statusRaw as OrderStatus | "all",
    chain: flags["chain"],
    account: flags["account"],
    strategy: flags["strategy"],
    group: flags["group"],
    limit,
  });
  const counts = orderCountsByStatus();

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      summary: {
        total: rows.length,
        byStatus: counts,
      },
      items: rows,
    });
    return;
  }

  console.log(`Orders (status: ${statusRaw}, showing ${rows.length})`);
  console.log(
    `Counts: active=${counts.active} filled=${counts.filled} ` +
    `cancelled=${counts.cancelled} expired=${counts.expired} failed=${counts.failed}`,
  );
  console.log("");
  if (rows.length === 0) {
    console.log("(no orders match this filter)");
    return;
  }
  // Header + rows. Width: id | status | trigger | intent | chain | account | last-check
  const hdr =
    `  #ID  ST  TRIGGER                     INTENT                              CHAIN     ACCT    LAST CHECK`;
  console.log(hdr);
  console.log("  " + "─".repeat(hdr.length - 2));
  for (const r of rows) {
    const id = String(r.id ?? "?").padStart(4);
    const st = (statusMarker(r.status) + " " + r.status).padEnd(11);
    const trg = describeTrigger(r).padEnd(28);
    const intent = describeIntent(r).padEnd(36);
    const chain = (r.chain ?? "").padEnd(9);
    const acct = (r.account ?? "").padEnd(7);
    const last = r.last_checked_at
      ? `${formatRelativeAge(r.last_checked_at)}${r.last_checked_price != null ? ` @ $${r.last_checked_price.toFixed(4)}` : ""}`
      : "—";
    console.log(`  ${id}  ${st} ${trg} ${intent} ${chain} ${acct} ${last}`);
  }
}

// ── show ─────────────────────────────────────────────────────

export async function orderShowCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[2];
  if (!idArg) {
    throw new ToolError("INVALID_PARAMS", "Usage: tradekit order show <id> [--json]");
  }
  const id = parseInt(idArg, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `Invalid order id "${idArg}" — expected a positive integer.`);
  }
  const row = getOrderById(id);
  if (!row) {
    throw new ToolError("INVALID_PARAMS", `Order #${id} not found.`, { details: { orderId: id } });
  }
  if (flags["json"] === "true") {
    printJson({ ok: true, order: row });
    return;
  }
  console.log(`Order #${row.id}  ${statusMarker(row.status)} ${row.status.toUpperCase()}`);
  if (row.trigger_type === "trailing") {
    // Pull the rich trailing-state renderer from the canonical place.
    const { describeTrailingState } = await import("../trailingStop.js");
    console.log(`  Side / trigger:  ${describeTrailingState(row, row.base_symbol)}`);
  } else {
    console.log(`  Side / trigger:  ${row.side} when ${row.trigger_type === "price_below" ? "≤" : "≥"} $${row.target_price_usd}`);
  }
  console.log(`  Pair:    ${row.base_symbol ?? row.base_token} → ${row.quote_symbol ?? row.quote_token}`);
  console.log(`  Amount:  ${row.base_amount ? `${row.base_amount} ${row.base_symbol ?? "base"}` : `${row.quote_amount} ${row.quote_symbol ?? "quote"}`}`);
  console.log(`  Chain:   ${row.chain}    Account: ${row.account}`);
  if (row.slippage_bps != null) console.log(`  Slippage: ${row.slippage_bps} bps${row.auto_slippage ? "  (auto)" : ""}`);
  else if (row.auto_slippage) console.log(`  Slippage: auto`);
  if (row.strategy) console.log(`  Strategy: ${row.strategy}`);
  if (row.note) console.log(`  Note:     ${row.note}`);
  if (row.group_id) {
    // Render the full OCO group state: peer ids + statuses. Helps an
    // operator see at a glance "who else is in this group" without
    // running a separate `order list --group X` call.
    const peers = listOrders({ group: row.group_id }).filter((p) => p.id !== row.id);
    if (peers.length === 0) {
      console.log(`  OCO group: ${row.group_id}  (no other peers)`);
    } else {
      console.log(`  OCO group: ${row.group_id}`);
      for (const p of peers) {
        const marker = statusMarker(p.status);
        const note = p.last_error_code === "OCO_PEER_FIRED"
          ? "  — auto-cancelled by OCO peer"
          : p.last_error_code === "OCO_OPERATOR_CASCADE"
          ? "  — operator-cancelled with --cascade"
          : "";
        console.log(`    ${marker} #${p.id} ${p.status.padEnd(10)} ${describeIntent(p)}${note}`);
      }
    }
  }
  console.log("");
  console.log(`  Created:  ${row.created_at}`);
  console.log(`  Updated:  ${row.updated_at}`);
  if (row.expires_at) console.log(`  Expires:  ${row.expires_at}  (${formatRelativeAge(row.expires_at)})`);
  console.log(`  Attempts: ${row.attempts}`);
  if (row.last_checked_at) {
    const priceBit = row.last_checked_price != null ? ` (price was $${row.last_checked_price})` : "";
    console.log(`  Last seen: ${row.last_checked_at}  (${formatRelativeAge(row.last_checked_at)})${priceBit}`);
  }
  if (row.last_error_code) {
    console.log(`  Last error: [${row.last_error_code}] ${row.last_error_message ?? ""}`);
  }
  if (row.status === "filled") {
    console.log("");
    console.log(`  Filled at: ${row.filled_at}`);
    console.log(`  Tx:        ${row.fill_tx_hash}`);
    console.log(`  Price:     $${row.fill_price}`);
    console.log(`  Base out:  ${row.fill_base_amount}`);
    console.log(`  Quote out: ${row.fill_quote_amount}`);
  }
}

// ── cancel ───────────────────────────────────────────────────

export async function orderCancelCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[2];
  if (!idArg) {
    throw new ToolError("INVALID_PARAMS", "Usage: tradekit order cancel <id> [--yes] [--cascade] [--json]");
  }
  const id = parseInt(idArg, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `Invalid order id "${idArg}" — expected a positive integer.`);
  }
  const existing = getOrderById(id);
  if (!existing) {
    throw new ToolError("INVALID_PARAMS", `Order #${id} not found.`, { details: { orderId: id } });
  }
  const cascade = flags["cascade"] === "true";
  if (cascade && !existing.group_id) {
    // --cascade on an order with no group_id is a no-op + likely a typo.
    // Surface it rather than silently accepting.
    throw new ToolError(
      "INVALID_PARAMS",
      `Order #${id} is not part of an OCO group — --cascade has nothing to cancel. Omit the flag.`,
      { details: { orderId: id } },
    );
  }
  // Confirmation prompt for active orders unless --yes (or non-TTY). When
  // --cascade is set, the prompt names the count of peers that will also
  // be cancelled so the operator confirms with full context.
  if (
    existing.status === "active" &&
    flags["yes"] !== "true" &&
    flags["json"] !== "true" &&
    process.stdin.isTTY
  ) {
    const intent = describeIntent(existing);
    const trg = describeTrigger(existing);
    let suffix = "";
    if (cascade && existing.group_id) {
      const peerCount = listOrders({ group: existing.group_id, status: "active" })
        .filter((p) => p.id !== id).length;
      suffix = ` + cascade-cancel ${peerCount} peer${peerCount === 1 ? "" : "s"} in group "${existing.group_id}"`;
    }
    const reply = await prompt(`Cancel order #${id} (${intent}, ${trg})${suffix}? type 'cancel': `);
    if (reply.trim().toLowerCase() !== "cancel") {
      throw new ToolError("INVALID_PARAMS", "Cancel aborted — confirmation phrase didn't match.");
    }
  }
  const row = cancelOrderById(id, { cascade });
  if (flags["json"] === "true") {
    printJson({ ok: true, order: row });
    return;
  }
  console.log(`Cancelled order #${row.id}  (was ${existing.status} → now ${row.status})`);
  if (row.cascadedPeerIds && row.cascadedPeerIds.length > 0) {
    console.log(`  Cascade: also cancelled ${row.cascadedPeerIds.length} OCO peer(s): #${row.cascadedPeerIds.join(", #")}`);
  }
}

// ── run (engine) ─────────────────────────────────────────────

export async function orderRunCommand(flags: Record<string, string>) {
  // Default behavior: a long-running watch loop at 30s interval. `--once`
  // short-circuits to a single tick (cron / CI mode). When the operator
  // sets --watch explicitly, withWatch honors it; without --watch and
  // without --once we synthesize watch=30.
  if (flags["once"] !== "true" && flags["watch"] == null) {
    flags["watch"] = "30";
  }

  const dryRun = flags["dry-run"] === "true";
  const strict = flags["strict"] === "true";
  const logger = makeCliLogger(flags);

  // Resolve password lazily: if dry-run, never. Else read --pass / env, but
  // do NOT interactively prompt while in watch-mode (would block forever
  // when running as a systemd service). When the engine actually needs to
  // sign, ensureWallet in runOrderTick throws WALLET_LOCKED — strict mode
  // makes that an exit-1 signal.
  let password: string | undefined;
  if (!dryRun) {
    if (flags["pass"]) password = flags["pass"];
    else if (process.env.WALLET_PASS) password = process.env.WALLET_PASS;
    // Non-TTY (cron / systemd / Docker entrypoint) MUST get the password
    // out-of-band — no interactive prompt fallback in run mode.
    if (!password && process.stdin.isTTY && flags["watch"] == null) {
      password = await requirePassword(flags);
    }
  }

  const work = async () => {
    const report = await runOrderTick({
      chain: flags["chain"],
      account: flags["account"],
      password,
      dryRun,
      logger,
    });
    if (flags["json"] === "true") {
      printJson(report);
    } else {
      const tickAgo = formatRelativeAge(report.timestamp);
      const dryNote = dryRun ? "  [DRY-RUN]" : "";
      console.log(
        `tick @ ${tickAgo}${dryNote}: scanned=${report.scanned} triggered=${report.triggered} ` +
        `filled=${report.filled} failed=${report.failedCount} expired=${report.expiredCount} ` +
        `transient=${report.transientErrorCount}  (${report.elapsedMs}ms)`,
      );
      for (const f of report.fills) {
        const tag = f.status === "filled" ? "✓ FILLED" : f.status === "failed" ? "✗ FAILED" : "·";
        const priceBit = f.observedPriceUsd != null ? ` @ $${f.observedPriceUsd.toFixed(4)}` : "";
        const txBit = f.txHash ? `  tx=${shortHash(f.txHash)}` : "";
        const errBit = f.errorCode ? `  [${f.errorCode}] ${f.errorMessage ?? ""}` : "";
        console.log(`  ${tag}  #${f.orderId}${priceBit}${txBit}${errBit}`);
      }
      if (report.recommendedActions.length > 0) {
        console.log("");
        for (const a of report.recommendedActions) {
          console.log(`  → ${a.tool}: ${a.reason}`);
        }
      }
    }
    if (strict && (report.failedCount > 0 || report.transientErrorCount > 0)) {
      // strict + watch is unusual but valid (set & forget with PD alert);
      // exit signals the watch loop to terminate next iteration via process.exit
      process.exitCode = 1;
    }
  };

  await withWatch(flags, work);
}

// ── dispatch ─────────────────────────────────────────────────

/**
 * Top-level dispatcher for `tradekit order <subcommand> ...`. Lives here so
 * index.ts stays a single-line case statement. Throws subcommandError for
 * unknown sub-actions — matches every other multi-action command.
 */
// ── replay (iter25) ──────────────────────────────────────────

/**
 * Renders the order's decision journal as a chronological timeline.
 * Each row shows the engine's evaluation at one significant tick:
 * activation, HWM advances, proximity crossings, fires, errors.
 *
 * Requires `engine.orderJournal.enabled=true` (default off) — without
 * it, no rows exist for any order. Operators who haven't enabled the
 * journal see an explanatory message + the config to set.
 */
export async function orderReplayCommand(flags: Record<string, string>, positional: string[]) {
  const idArg = positional[2];
  if (!idArg) throw new ToolError("INVALID_PARAMS", `Usage: tradekit order replay <id>`);
  const id = parseInt(idArg, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `<id> must be a positive integer (got "${idArg}").`);
  }
  const limit = parseIntFlag(flags["limit"], "--limit", { min: 1, max: 10_000 });

  const order = getOrderById(id);
  if (!order) throw new ToolError("INVALID_PARAMS", `Order #${id} not found.`);

  const config = loadConfig();
  const { replayOrder, decisionMarker, decisionLabel } = await import("../orderJournal.js");
  const timeline = replayOrder(id, limit);

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      orderId: id,
      order: orderSummaryForJson(order),
      journalEnabled: config.engine.orderJournal.enabled,
      totalEntries: timeline.totalEntries,
      entries: timeline.entries,
    });
    return;
  }

  console.log(`Order #${order.id}  ${order.side} ${describeIntentForReplay(order)}  ${describeTriggerForReplay(order)}`);
  console.log(`  Status:        ${order.status}`);
  console.log(`  Chain:         ${order.chain}`);
  console.log(`  Created:       ${order.created_at}`);
  if (order.filled_at) console.log(`  Filled:        ${order.filled_at}`);
  console.log(``);

  if (!config.engine.orderJournal.enabled) {
    console.log(`Order journal is NOT enabled. To enable forensic decision tracking:`);
    console.log(`  tradekit config set engine.orderJournal '{"enabled":true,"proximityPct":5,"retentionDays":30}'`);
    console.log(``);
    console.log(`The engine will start journaling on the next tick after enabling. Historical orders (filled before enablement) will have no journal entries.`);
    return;
  }

  if (timeline.totalEntries === 0) {
    console.log(`No journal entries for this order yet.`);
    if (order.status === "active") {
      console.log(`The engine will record state-changing evaluations as the order ticks.`);
    } else {
      console.log(`This order may have transitioned to ${order.status} before journaling was enabled.`);
    }
    return;
  }

  const shown = timeline.entries.length;
  const truncated = limit != null && shown < timeline.totalEntries;
  console.log(`Decision timeline (${truncated ? `showing ${shown} of ${timeline.totalEntries}` : `${shown} entries`}):`);
  console.log(``);
  for (const e of timeline.entries) {
    const marker = decisionMarker(e.decision);
    const label = decisionLabel(e.decision);
    const ts = e.checked_at.replace("T", " ").replace(/\.\d+Z$/, "Z").replace("Z", " UTC");
    const priceCol = e.price_usd != null ? `$${e.price_usd.toFixed(2)}` : "—";
    const hwmCol = e.water_mark_usd != null ? `HWM $${e.water_mark_usd.toFixed(2)}` : "";
    const thrCol = e.threshold_usd != null ? `thr $${e.threshold_usd.toFixed(2)}` : "";
    const meta = [hwmCol, thrCol].filter(Boolean).join(" ");
    const notes = e.notes ? `  · ${e.notes}` : "";
    console.log(`  ${ts}  ${priceCol.padStart(10)}  ${meta.padEnd(32)}  ${marker} ${label}${notes}`);
  }
}

function orderSummaryForJson(o: ReturnType<typeof getOrderById>) {
  if (!o) return null;
  return {
    id: o.id, status: o.status, side: o.side,
    trigger: o.trigger_type, targetPriceUsd: o.target_price_usd,
    trailPct: o.trail_pct, waterMarkUsd: o.water_mark_usd,
    chain: o.chain, account: o.account,
    base: o.base_symbol, quote: o.quote_symbol,
    baseAmount: o.base_amount, quoteAmount: o.quote_amount,
    createdAt: o.created_at, filledAt: o.filled_at,
  };
}

// Brief intent + trigger strings used by the replay header. The
// file's earlier describeIntent / describeTrigger have slightly
// different signatures + return styles; these duplicate the logic
// for the replay header's tighter formatting.
function describeIntentForReplay(o: import("../db.js").OrderRow): string {
  if (o.base_amount) return `${o.base_amount} ${o.base_symbol ?? "base"}`;
  if (o.quote_amount) return `${o.base_symbol ?? "base"} for ${o.quote_amount} ${o.quote_symbol ?? "quote"}`;
  return o.base_symbol ?? "?";
}
function describeTriggerForReplay(o: import("../db.js").OrderRow): string {
  if (o.trigger_type === "trailing") {
    const trail = o.trail_pct != null ? `${o.trail_pct}%` : "?%";
    const act = o.target_price_usd != null ? ` (activation $${o.target_price_usd})` : "";
    return `trailing ${trail}${act}`;
  }
  const t = o.target_price_usd != null ? o.target_price_usd.toFixed(2) : "?";
  return `${o.trigger_type} $${t}`;
}

/** `tradekit order pause <id>` — the engine stops evaluating the
 *  trigger until resumed. Expiry still applies and OCO peers can
 *  still cancel a paused order. */
export async function orderPauseCommand(flags: Record<string, string>, positional: string[]) {
  const id = parseOrderId(positional[2], "pause");
  const { pauseOrderById } = await import("../orders.js");
  const row = pauseOrderById(id);
  if (flags["json"] === "true") printJson({ ok: true, order: row });
  else console.log(`Paused order #${row.id}  (status → ${row.status})`);
}

/** `tradekit order resume <id>` — re-enters trigger evaluation on the
 *  next tick. Trailing watermarks are preserved across the pause. */
export async function orderResumeCommand(flags: Record<string, string>, positional: string[]) {
  const id = parseOrderId(positional[2], "resume");
  const { resumeOrderById } = await import("../orders.js");
  const row = resumeOrderById(id);
  if (flags["json"] === "true") printJson({ ok: true, order: row });
  else console.log(`Resumed order #${row.id}  (status → ${row.status})`);
}

function parseOrderId(idArg: string | undefined, verb: string): number {
  if (!idArg) {
    throw new ToolError("INVALID_PARAMS", `Usage: tradekit order ${verb} <id> [--json]`);
  }
  const id = parseInt(idArg, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `Invalid order id "${idArg}" — expected a positive integer.`);
  }
  return id;
}

export async function orderCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  switch (action) {
    case "create":
      await orderCreateCommand(flags);
      break;
    case "list":
      await orderListCommand(flags);
      break;
    case "show":
      await orderShowCommand(flags, positional);
      break;
    case "cancel":
      await orderCancelCommand(flags, positional);
      break;
    case "pause":
      await orderPauseCommand(flags, positional);
      break;
    case "resume":
      await orderResumeCommand(flags, positional);
      break;
    case "edit":
      await orderEditCommand(flags, positional);
      break;
    case "run":
      await orderRunCommand(flags);
      break;
    case "replay":
      await orderReplayCommand(flags, positional);
      break;
    default:
      throw subcommandError("order", action, ["create", "list", "show", "cancel", "pause", "resume", "edit", "run", "replay"]);
  }
}

/** Iter34: `tradekit order edit <id> [--target-price N] [--trail-pct N]
 *  [--base-amount A | --quote-amount A] [--slippage-bps N] [--auto-slippage]
 *  [--expires-in D | --expires-at ISO] [--note "..."] [--strategy TAG]
 *  [--paper] [--unset target-price|trail-pct|...]`. Each editable field
 *  gets one flag; --unset is the convention for clearing nullable
 *  fields (only legal for ones that ARE nullable). */
export async function orderEditCommand(
  flags: Record<string, string>,
  positional: string[],
) {
  const idStr = positional[2];
  if (!idStr) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Usage: tradekit order edit <id> [--target-price N] [--trail-pct N] [--base-amount A | --quote-amount A] [--slippage-bps N] [--auto-slippage] [--expires-in D | --expires-at ISO] [--note \"...\"] [--strategy TAG] [--paper] [--unset target-price|trail-pct|expires-at|note|strategy]",
    );
  }
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ToolError("INVALID_PARAMS", `Invalid order id "${idStr}".`);
  }

  const changes: import("../orderEdit.js").OrderEditChanges = {};
  // --unset short-circuits: pass a comma-separated list of fields to
  // clear. We translate each to a "field: null" entry.
  if (flags["unset"]) {
    for (const raw of flags["unset"].split(",")) {
      const f = raw.trim();
      switch (f) {
        case "target-price":
          changes.targetPriceUsd = null;
          break;
        case "trail-pct":
          changes.trailPct = null; // validator will reject for trailing — by design
          break;
        case "expires-at":
        case "expires-in":
          changes.expiresAt = null;
          break;
        case "note":
          changes.note = null;
          break;
        case "strategy":
          changes.strategy = null;
          break;
        case "slippage-bps":
          changes.slippageBps = null;
          break;
        case "on-fill":
          changes.onFill = null;
          break;
        default:
          throw new ToolError("INVALID_PARAMS", `--unset ${f}: not a clearable field.`);
      }
    }
  }
  if (flags["on-fill"] != null) {
    try {
      changes.onFill = JSON.parse(flags["on-fill"]);
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", `--on-fill is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (flags["target-price"] != null) {
    changes.targetPriceUsd = parseFloat(flags["target-price"]);
  }
  if (flags["trail-pct"] != null) {
    changes.trailPct = parseFloat(flags["trail-pct"]);
  }
  if (flags["base-amount"] != null) {
    changes.baseAmount = flags["base-amount"];
    // Conventionally, setting one amount clears the other (the
    // exactly-one invariant). Make this explicit.
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
  if (flags["expires-at"] != null) {
    changes.expiresAt = flags["expires-at"];
  } else if (flags["expires-in"] != null) {
    const dt = parseDurationToDate(flags["expires-in"]);
    if (!dt) throw new ToolError("INVALID_PARAMS", `Invalid --expires-in "${flags["expires-in"]}".`);
    changes.expiresAt = dt.toISOString();
  }
  if (flags["note"] != null) changes.note = flags["note"];
  if (flags["strategy"] != null) changes.strategy = flags["strategy"];
  if (flags["paper"] === "true") changes.paper = true;
  if (flags["paper"] === "false") changes.paper = false;

  const { editOrder } = await import("../orderEdit.js");
  const result = editOrder({ id, changes });

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      orderId: id,
      changed: result.diff.length > 0,
      diff: result.diff,
      order: result.order,
    });
    return;
  }
  if (result.diff.length === 0) {
    console.log(`Order #${id}: no changes.`);
    return;
  }
  console.log(`Order #${id}: edited ${result.diff.length} field${result.diff.length === 1 ? "" : "s"}.`);
  for (const d of result.diff) {
    console.log(`  ${d.field}: ${fmtFieldValue(d.oldValue)} → ${fmtFieldValue(d.newValue)}`);
  }
  if (result.order.trigger_type === "trailing") {
    console.log(`  Trailing HWM preserved: ${result.order.water_mark_usd ?? "(not yet tracking)"}`);
  }
}

function fmtFieldValue(v: number | string | boolean | null): string {
  if (v == null) return "(null)";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}
