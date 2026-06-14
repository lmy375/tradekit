// CLI surface for stateful safety primitives.
//
// In v1: drawdown circuit breaker only — inspection + manual reset.
// Future scope: per-strategy lockout list, structured "why was this
// trade rejected" trail, etc. Lives under `tradekit safety <action>`
// to keep the stateful-safety commands grouped.
//
//   tradekit safety drawdown [--scope global] [--json]
//     Show current peak, last value, drawdown %, tripped state for
//     each scope (or just the named scope).
//
//   tradekit safety reset-drawdown [--scope global] [--peak USD] [--yes] [--json]
//     Clear tripped state + optionally re-anchor peak to a specific
//     USD value (defaults to the most recently observed value, which
//     prevents immediate re-tripping on the next trade).

import { ToolError } from "../errors.js";
import {
  getDrawdownState,
  resetDrawdownState,
  listDrawdownStates,
  type DrawdownStateRow,
} from "../db.js";
import { loadConfig } from "../config.js";
import { printJson, parseFloatFlag, prompt, subcommandError } from "./helpers.js";

// ── shared helpers ───────────────────────────────────────────

function formatRelativeAge(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function hydrate(row: DrawdownStateRow) {
  const drawdownPct =
    row.last_value_usd != null && row.peak_usd > 0
      ? ((row.peak_usd - row.last_value_usd) / row.peak_usd) * 100
      : null;
  return {
    scope: row.scope_key,
    peak_usd: row.peak_usd,
    peak_at: row.peak_at,
    last_value_usd: row.last_value_usd,
    drawdown_pct: drawdownPct,
    tripped: row.tripped_at != null,
    tripped_at: row.tripped_at,
    updated_at: row.updated_at,
  };
}

// ── drawdown (inspection) ────────────────────────────────────

export async function safetyDrawdownCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const cfg = config.safety.drawdownCircuitBreaker;
  const requestedScope = flags["scope"];

  if (flags["json"] === "true") {
    const all = requestedScope
      ? [getDrawdownState(requestedScope)].filter((r): r is DrawdownStateRow => r != null)
      : listDrawdownStates();
    printJson({
      ok: true,
      configured: cfg != null && cfg.enabled,
      config: cfg ?? null,
      states: all.map(hydrate),
    });
    return;
  }

  if (!cfg || !cfg.enabled) {
    console.log(`Drawdown circuit breaker is NOT enabled.`);
    console.log(``);
    console.log(`Enable with:`);
    console.log(`  tradekit config set safety.drawdownCircuitBreaker '{"enabled":true,"maxDrawdownPct":15}'`);
    return;
  }

  console.log(`Drawdown circuit breaker: enabled (maxDrawdownPct=${cfg.maxDrawdownPct}%${cfg.autoResumeAtPct != null ? `, autoResumeAtPct=${cfg.autoResumeAtPct}%` : ", manual reset only"})`);
  console.log(``);

  const states = requestedScope
    ? [getDrawdownState(requestedScope)].filter((r): r is DrawdownStateRow => r != null)
    : listDrawdownStates();

  if (states.length === 0) {
    if (requestedScope) {
      console.log(`No drawdown state for scope "${requestedScope}". First tagged trade will seed it.`);
    } else {
      console.log(`No drawdown state recorded yet. The next trade will seed the peak.`);
    }
    return;
  }

  for (const row of states) {
    const status = row.tripped_at ? `✕ TRIPPED at ${row.tripped_at}` : `● ok`;
    const drawdownPct =
      row.last_value_usd != null && row.peak_usd > 0
        ? ((row.peak_usd - row.last_value_usd) / row.peak_usd) * 100
        : null;
    console.log(`  Scope:        ${row.scope_key}`);
    console.log(`  Status:       ${status}`);
    console.log(`  Peak USD:     $${row.peak_usd.toFixed(2)}  (${formatRelativeAge(row.peak_at)})`);
    if (row.last_value_usd != null) {
      const drawdownLine =
        drawdownPct != null
          ? `  →  ${drawdownPct.toFixed(2)}% below peak`
          : "";
      console.log(`  Last value:   $${row.last_value_usd.toFixed(2)}${drawdownLine}`);
    }
    if (row.tripped_at && cfg.autoResumeAtPct != null && drawdownPct != null) {
      const targetResume = row.peak_usd * (1 - cfg.autoResumeAtPct / 100);
      console.log(`  Auto-resume:  when current ≥ $${targetResume.toFixed(2)} (drawdown < ${cfg.autoResumeAtPct}%)`);
    }
    console.log(`  Updated:      ${formatRelativeAge(row.updated_at)}`);
    console.log(``);
  }
  if (states.some((r) => r.tripped_at)) {
    console.log(`Reset with: tradekit safety reset-drawdown [--scope <scope>] [--peak <USD>]`);
  }
}

// ── reset-drawdown ───────────────────────────────────────────

export async function safetyResetDrawdownCommand(flags: Record<string, string>) {
  const scope = flags["scope"] ?? "global";
  const newPeakUsd = parseFloatFlag(flags["peak"], "--peak", { min: 0 });

  const existing = getDrawdownState(scope);
  if (!existing) {
    throw new ToolError(
      "INVALID_PARAMS",
      `No drawdown state for scope "${scope}". Nothing to reset.`,
    );
  }

  if (
    existing.tripped_at != null &&
    flags["yes"] !== "true" &&
    flags["json"] !== "true" &&
    process.stdin.isTTY
  ) {
    const reply = await prompt(
      `Reset drawdown breaker for scope "${scope}" (currently TRIPPED since ${existing.tripped_at})? type 'reset': `,
    );
    if (reply.trim().toLowerCase() !== "reset") {
      throw new ToolError("INVALID_PARAMS", "Reset aborted — confirmation phrase didn't match.");
    }
  }

  const after = resetDrawdownState({ scopeKey: scope, newPeakUsd: newPeakUsd ?? undefined });
  if (!after) {
    throw new ToolError("INVALID_PARAMS", `Reset failed — state for scope "${scope}" disappeared mid-call.`);
  }

  if (flags["json"] === "true") {
    printJson({ ok: true, state: hydrate(after) });
    return;
  }
  console.log(`Reset drawdown breaker for scope "${scope}"`);
  console.log(`  New peak:     $${after.peak_usd.toFixed(2)}`);
  console.log(`  Tripped:      ${after.tripped_at ? "yes" : "no (cleared)"}`);
  if (after.last_value_usd != null) {
    console.log(`  Last value:   $${after.last_value_usd.toFixed(2)}`);
  }
}

// ── dispatch ─────────────────────────────────────────────────

export async function safetyCommand(
  action: string | undefined,
  flags: Record<string, string>,
  _positional: string[],
) {
  switch (action) {
    case "review":
      await safetyReviewCommand(flags);
      break;
    case "drawdown":
      await safetyDrawdownCommand(flags);
      break;
    case "reset-drawdown":
      await safetyResetDrawdownCommand(flags);
      break;
    default:
      throw subcommandError("safety", action, ["review", "drawdown", "reset-drawdown"]);
  }
}

// v51: consolidated guardrail audit — "what protects me, and what's
// wide open?" Pure read of the safety config + severity-ranked gaps.
async function safetyReviewCommand(flags: Record<string, string>) {
  const { reviewSafety, renderSafetyReview } = await import("../safetyReview.js");
  const report = reviewSafety(loadConfig());
  if (flags["json"] === "true") {
    printJson({ ok: true, ...report });
  } else {
    console.log(renderSafetyReview(report));
  }
}
