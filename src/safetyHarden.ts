/**
 * Safety hardening plan (v93) — the detect→ACTION completion of `safety review`.
 *
 * Every guardrail in the safety stack is opt-in, so a careless operator can run
 * an autonomous agent wide-open (no breaker, no concentration cap, no transfer
 * allowlist, infinite approvals). `safety review` DETECTS the gaps + prints the
 * per-gap fix command — but the operator still has to run ~8 of them and invent
 * the values. This computes a recommended hardened baseline in one step: safe
 * documented defaults for the structural guardrails, scale-specific USD limits
 * from operator flags (or flagged as still-needed). FILLS GAPS ONLY — never
 * overrides a guardrail the operator already configured.
 *
 * Pure: takes the current config + the operator's USD inputs, returns the plan.
 * The CLI applies it (operator-authorized; safety config is operator-owned —
 * see v89). No auto-apply over MCP.
 */

import type { Config } from "./config.js";

export interface HardeningChange {
  path: string;
  /** The recommended value to set (JSON value). */
  recommended: unknown;
  reason: string;
}

export interface HardeningPlan {
  /** Gaps with a safe recommendation ready to apply. */
  changes: HardeningChange[];
  /** Guardrails that need an operator-specific value not supplied (e.g. USD
   *  limits without a --per-trade-usd flag). Surfaced, not guessed. */
  stillNeeded: Array<{ path: string; reason: string }>;
  /** Guardrails already configured (left untouched). */
  alreadyHardened: string[];
}

/** Documented safe defaults for the structural guardrails (not scale-specific). */
export const HARDENING_DEFAULTS = {
  maxDrawdownPct: 20,
  maxConcentrationPct: 50,
} as const;

/**
 * Build the hardening plan. `opts` carries the scale-specific USD limits the
 * operator chooses (per-trade / daily / per-strategy loss); when omitted, those
 * guardrails land in `stillNeeded` rather than being guessed.
 */
export function buildHardeningPlan(
  config: Config,
  opts: { perTradeUsd?: number; dailyUsd?: number; maxStrategyLossUsd?: number } = {},
): HardeningPlan {
  const s = config.safety;
  const changes: HardeningChange[] = [];
  const stillNeeded: HardeningPlan["stillNeeded"] = [];
  const alreadyHardened: string[] = [];

  // ── structural guardrails (safe documented defaults) ──
  if (s.drawdownCircuitBreaker?.enabled === true) {
    alreadyHardened.push("safety.drawdownCircuitBreaker");
  } else {
    changes.push({
      path: "safety.drawdownCircuitBreaker",
      recommended: { enabled: true, maxDrawdownPct: HARDENING_DEFAULTS.maxDrawdownPct, autoResumeAtPct: null, scope: "global" },
      reason: `halt ALL trading if the portfolio falls ${HARDENING_DEFAULTS.maxDrawdownPct}% from peak (manual reset — investigate before resuming)`,
    });
  }

  if (s.maxConcentrationPct != null) {
    alreadyHardened.push("safety.maxConcentrationPct");
  } else {
    changes.push({
      path: "safety.maxConcentrationPct",
      recommended: HARDENING_DEFAULTS.maxConcentrationPct,
      reason: `flag the book when any single token exceeds ${HARDENING_DEFAULTS.maxConcentrationPct}% (cross-strategy concentration)`,
    });
  }

  if (s.transferAllowlistOnly === true) {
    alreadyHardened.push("safety.transferAllowlistOnly");
  } else {
    changes.push({
      path: "safety.transferAllowlistOnly",
      recommended: true,
      reason: "restrict agent transfers + approvals to address-book recipients/known spenders — curate them via `tradekit address add` first, or agent transfers will be blocked",
    });
  }

  if (s.allowInfiniteApprovals === true) {
    changes.push({
      path: "safety.allowInfiniteApprovals",
      recommended: false,
      reason: "require bounded approvals (an infinite approval to a later-compromised router drains the wallet)",
    });
  } else {
    alreadyHardened.push("safety.allowInfiniteApprovals");
  }

  // ── scale-specific USD limits (from operator flags, else still-needed) ──
  const usdLimit = (
    path: string,
    current: number | null | undefined,
    flag: number | undefined,
    reason: string,
    needReason: string,
  ) => {
    if (current != null) { alreadyHardened.push(path); return; }
    if (flag != null && flag > 0) changes.push({ path, recommended: flag, reason });
    else stillNeeded.push({ path, reason: needReason });
  };
  usdLimit(
    "safety.perTxUsdLimit", s.perTxUsdLimit, opts.perTradeUsd,
    "cap the USD value of any single trade",
    "per-trade USD ceiling — scale-specific; pass --per-trade-usd N",
  );
  usdLimit(
    "safety.dailyUsdLimit", s.dailyUsdLimit, opts.dailyUsd,
    "cap cumulative 24h trade volume",
    "daily USD ceiling — scale-specific; pass --daily-usd N",
  );
  usdLimit(
    "safety.maxStrategyLossUsd", s.maxStrategyLossUsd, opts.maxStrategyLossUsd,
    "auto-block new buys once a strategy's realized loss exceeds this",
    "per-strategy realized-loss breaker — scale-specific; pass --max-strategy-loss-usd N",
  );

  return { changes, stillNeeded, alreadyHardened };
}

export function renderHardeningPlan(plan: HardeningPlan, applied: boolean): string {
  const lines: string[] = [];
  const verb = applied ? "Applied" : "Would apply";
  if (plan.changes.length === 0) {
    lines.push("Safety hardening — no gaps with a safe default to fill.");
  } else {
    lines.push(`Safety hardening — ${verb} ${plan.changes.length} change(s):`);
    for (const c of plan.changes) {
      lines.push(`  ${applied ? "✓" : "•"} ${c.path} = ${JSON.stringify(c.recommended)}`);
      lines.push(`      ${c.reason}`);
    }
  }
  if (plan.stillNeeded.length > 0) {
    lines.push("");
    lines.push("  Still needs an operator value (not guessed):");
    for (const n of plan.stillNeeded) lines.push(`   ⚠ ${n.path} — ${n.reason}`);
  }
  if (plan.alreadyHardened.length > 0) {
    lines.push("");
    lines.push(`  Already configured (untouched): ${plan.alreadyHardened.join(", ")}`);
  }
  if (!applied && plan.changes.length > 0) {
    lines.push("");
    lines.push("  Re-run with --apply to write these. (Dry-run by default.)");
  }
  return lines.join("\n");
}
