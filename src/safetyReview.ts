/**
 * Safety posture review (v51) — "what protects me, and what's wide open?"
 *
 * The safety stack grew to ~19 independent layers across spend / token /
 * approval / execution / rate / exposure / circuit / human-in-the-loop.
 * Each is individually documented, but an operator's FIRST question
 * before trusting an AI agent with real money — what is actually
 * protecting me right now, and which dangerous gaps are open? — had no
 * single answer. It meant reading a dozen nested config keys AND knowing
 * which absences are benign (gas budget off) vs catastrophic (no USD
 * ceiling at all). This module encodes that judgement.
 *
 * Two halves:
 *   - guardrails[]: every layer, active or off, with its configured value
 *     rendered (the "what protects me" inventory).
 *   - gaps[]: the absences that matter, each with a SEVERITY reflecting
 *     real risk to an agent deployment + the exact config command to
 *     close it (the "what's wide open" audit).
 *
 * Pure + deterministic: reads config only, no IO, no clock except an
 * injected stamp. Severity thresholds are documented constants.
 */

import type { Config } from "./config.js";

/** Slippage cap at/above this (bps) is flagged loose. 1000 = 10%. */
export const LOOSE_SLIPPAGE_BPS = 1000;

export type GuardrailCategory =
  | "master"
  | "spend"
  | "token"
  | "approval"
  | "execution"
  | "rate"
  | "exposure"
  | "circuit"
  | "human";

export type GuardrailState = "active" | "off" | "partial";
export type GapSeverity = "critical" | "warn" | "info";
export type SafetyPostureVerdict = "hardened" | "moderate" | "exposed";

export interface GuardrailStatus {
  key: string;
  label: string;
  category: GuardrailCategory;
  state: GuardrailState;
  /** Human render of the configured value or the off-state. */
  detail: string;
}

export interface SafetyGap {
  key: string;
  severity: GapSeverity;
  /** What is exposed by this absence. */
  finding: string;
  /** The config command (or action) that closes it. */
  fix: string;
}

export interface SafetyPostureReport {
  generatedAt: string;
  verdict: SafetyPostureVerdict;
  counts: {
    critical: number;
    warn: number;
    info: number;
    activeGuardrails: number;
    totalGuardrails: number;
  };
  guardrails: GuardrailStatus[];
  gaps: SafetyGap[];
}

type Safety = Config["safety"];

/** Count chains-with-entries + total entries in a chain-keyed record. */
function chainRecordSummary(
  rec: Record<string, string[]> | undefined,
): { chains: number; entries: number } {
  if (!rec) return { chains: 0, entries: 0 };
  const chains = Object.keys(rec).filter((c) => (rec[c]?.length ?? 0) > 0);
  return { chains: chains.length, entries: chains.reduce((s, c) => s + (rec[c]?.length ?? 0), 0) };
}

export function reviewSafety(config: Config, opts: { now?: Date } = {}): SafetyPostureReport {
  const s: Safety = config.safety;
  const now = opts.now ?? new Date();
  const guardrails: GuardrailStatus[] = [];
  const gaps: SafetyGap[] = [];

  const g = (gr: GuardrailStatus) => guardrails.push(gr);
  const gap = (severity: GapSeverity, key: string, finding: string, fix: string) =>
    gaps.push({ key, severity, finding, fix });

  // ── master switch ──
  g({
    key: "enabled",
    label: "Safety stack",
    category: "master",
    state: s.enabled ? "active" : "off",
    detail: s.enabled ? "ON" : "DISABLED — every guardrail below is bypassed",
  });
  if (!s.enabled) {
    gap(
      "critical",
      "enabled",
      "safety.enabled=false disables the ENTIRE guardrail stack — every check below is bypassed for agent AND CLI trades",
      "tradekit config set safety.enabled true",
    );
  }

  // ── spend ceilings ──
  g({
    key: "perTxUsdLimit",
    label: "Per-trade USD cap",
    category: "spend",
    state: s.perTxUsdLimit != null ? "active" : "off",
    detail: s.perTxUsdLimit != null ? `$${s.perTxUsdLimit}/tx` : "no per-trade USD ceiling",
  });
  g({
    key: "dailyUsdLimit",
    label: "Daily USD cap",
    category: "spend",
    state: s.dailyUsdLimit != null ? "active" : "off",
    detail: s.dailyUsdLimit != null ? `$${s.dailyUsdLimit}/day` : "no daily USD ceiling",
  });
  if (s.perTxUsdLimit == null && s.dailyUsdLimit == null) {
    gap(
      "critical",
      "usdCeiling",
      "no per-trade AND no daily USD ceiling — an agent trade (or a runaway loop) can spend an unbounded amount of capital",
      "tradekit config set safety.perTxUsdLimit <usd> (and/or safety.dailyUsdLimit <usd>)",
    );
  }

  // ── execution: slippage ──
  g({
    key: "maxSlippageBps",
    label: "Slippage cap",
    category: "execution",
    state: "active",
    detail: `${s.maxSlippageBps} bps (${(s.maxSlippageBps / 100).toFixed(1)}%)${s.maxSlippageBps === 500 ? " — default" : ""}`,
  });
  if (s.maxSlippageBps >= LOOSE_SLIPPAGE_BPS) {
    gap(
      "warn",
      "maxSlippageBps",
      `slippage cap is loose (${(s.maxSlippageBps / 100).toFixed(1)}%) — trades stay exposed to sandwich attacks and illiquid-pair fills`,
      "tradekit config set safety.maxSlippageBps <tighter bps, e.g. 300>",
    );
  }

  // ── token allow/deny + honeypot probe ──
  const wl = chainRecordSummary(s.tokenWhitelist);
  const bl = chainRecordSummary(s.tokenBlacklist);
  const autoCheckOn = s.autoTokenCheck?.enabled === true;
  g({
    key: "tokenWhitelist",
    label: "Token whitelist",
    category: "token",
    state: wl.entries > 0 ? "active" : "off",
    detail: wl.entries > 0 ? `${wl.entries} token(s) across ${wl.chains} chain(s)` : "off (any token tradeable)",
  });
  g({
    key: "tokenBlacklist",
    label: "Token blacklist",
    category: "token",
    state: bl.entries > 0 ? "active" : "off",
    detail: bl.entries > 0 ? `${bl.entries} token(s) across ${bl.chains} chain(s)` : "off",
  });
  g({
    key: "autoTokenCheck",
    label: "Auto honeypot probe",
    category: "token",
    state: autoCheckOn ? "active" : "off",
    detail: autoCheckOn
      ? `ON (failOnSuspicious=${s.autoTokenCheck?.failOnSuspicious ?? true})`
      : "off",
  });
  if (wl.entries === 0 && bl.entries === 0 && !autoCheckOn) {
    gap(
      "warn",
      "tokenSafety",
      "no token allow/deny list AND no automated honeypot probe — an agent can trade ANY token, including scams and honeypots",
      "enable safety.autoTokenCheck.enabled=true, or set safety.tokenWhitelist.<chain>",
    );
  } else if (wl.entries === 0 && bl.entries === 0) {
    gap(
      "info",
      "tokenSafety",
      "no token allow/deny list (the honeypot probe is active, but any non-honeypot token is still tradeable)",
      "set safety.tokenWhitelist.<chain> to restrict the agent to a known set",
    );
  }

  // ── approvals ──
  g({
    key: "allowInfiniteApprovals",
    label: "Infinite-approval block",
    category: "approval",
    state: s.allowInfiniteApprovals ? "off" : "active",
    detail: s.allowInfiniteApprovals ? "infinite approvals PERMITTED" : "infinite approvals blocked (default)",
  });
  if (s.allowInfiniteApprovals) {
    gap(
      "warn",
      "allowInfiniteApprovals",
      "infinite token approvals are permitted — a compromised or malicious spender contract can drain the entire token balance, not just one trade",
      "tradekit config set safety.allowInfiniteApprovals false",
    );
  }
  g({
    key: "maxApprovalUsdLimit",
    label: "Approval USD cap",
    category: "approval",
    state: s.maxApprovalUsdLimit != null ? "active" : "off",
    detail: s.maxApprovalUsdLimit != null ? `$${s.maxApprovalUsdLimit}/approval` : "no approval USD ceiling",
  });
  if (s.maxApprovalUsdLimit == null) {
    gap(
      "info",
      "maxApprovalUsdLimit",
      "approve() calls have no USD ceiling — a single approval can authorize an unbounded allowance",
      "tradekit config set safety.maxApprovalUsdLimit <usd>",
    );
  }

  // ── execution: gas budget ──
  const gasOn = s.gas?.maxGasPctOfTrade != null || (s.gas?.maxGasNativePerChain != null && Object.keys(s.gas.maxGasNativePerChain).length > 0);
  g({
    key: "gasBudget",
    label: "Gas budget",
    category: "execution",
    state: gasOn ? "active" : "off",
    detail: gasOn
      ? [
          s.gas?.maxGasPctOfTrade != null ? `≤${s.gas.maxGasPctOfTrade}% of trade` : null,
          s.gas?.maxGasNativePerChain != null && Object.keys(s.gas.maxGasNativePerChain).length > 0
            ? `${Object.keys(s.gas.maxGasNativePerChain).length} per-chain native cap(s)`
            : null,
        ].filter(Boolean).join(" · ")
      : "off (gas cost unbounded relative to trade size)",
  });
  if (!gasOn) {
    gap(
      "info",
      "gasBudget",
      "no gas budget — a small trade on a busy L1 can lose a large fraction of its value to gas with no guardrail",
      "tradekit config set safety.gas.maxGasPctOfTrade <pct, e.g. 10>",
    );
  }

  // v77: MEV protection — public-mempool chains (Ethereum / BNB / Polygon) leak
  // 0.5–3% per trade to sandwich bots without a private-relay submission path.
  const mevChains = config.mev?.enabled ? Object.keys(config.mev.privateRpcs ?? {}).length : 0;
  g({
    key: "mevProtection",
    label: "MEV protection",
    category: "execution",
    state: mevChains > 0 ? "active" : "off",
    detail: mevChains > 0 ? `private relay on ${mevChains} chain(s)` : "off (public-mempool submission)",
  });
  if (mevChains === 0) {
    gap(
      "info",
      "mevProtection",
      "no MEV protection — trades on public-mempool chains (Ethereum especially) can be sandwiched for 0.5–3% per trade",
      "tradekit config set mev.enabled true + config set mev.privateRpcs.ethereum <flashbots/mevblocker url>",
    );
  }

  // ── rate limit ──
  const rateOn = s.minTradeIntervalMs != null && s.minTradeIntervalMs > 0;
  g({
    key: "minTradeIntervalMs",
    label: "Trade rate limit",
    category: "rate",
    state: rateOn ? "active" : "off",
    detail: rateOn ? `≥${s.minTradeIntervalMs}ms between trades/account` : "off (no minimum interval)",
  });
  if (!rateOn) {
    gap(
      "info",
      "minTradeIntervalMs",
      "no rate limit — a buggy loop firing many small trades can drain a balance entirely while staying inside the daily USD window",
      "tradekit config set safety.minTradeIntervalMs <ms matching your strategy cadence>",
    );
  }

  // ── exposure caps (position limits / caps / strategy budgets) ──
  const posLimits = s.positionLimits?.length ?? 0;
  const posCaps = s.positionCaps?.length ?? 0;
  const stratBudgets = s.strategyBudgets?.length ?? 0;
  g({
    key: "positionLimits",
    label: "Portfolio-weight limits",
    category: "exposure",
    state: posLimits > 0 ? "active" : "off",
    detail: posLimits > 0 ? `${posLimits} rule(s)` : "off",
  });
  g({
    key: "positionCaps",
    label: "Net-exposure caps",
    category: "exposure",
    state: posCaps > 0 ? "active" : "off",
    detail: posCaps > 0 ? `${posCaps} rule(s)` : "off",
  });
  g({
    key: "strategyBudgets",
    label: "Per-strategy spend caps",
    category: "exposure",
    state: stratBudgets > 0 ? "active" : "off",
    detail: stratBudgets > 0 ? `${stratBudgets} rule(s)` : "off",
  });
  // v72: portfolio concentration — the cross-strategy aggregate the per-
  // strategy caps above structurally miss.
  const concLimit = s.maxConcentrationPct;
  g({
    key: "maxConcentration",
    label: "Concentration limit",
    category: "exposure",
    state: concLimit != null ? "active" : "off",
    detail: concLimit != null ? `flag any single token > ${concLimit}% of the book` : "off",
  });
  if (concLimit == null) {
    gap(
      "info",
      "concentration",
      "no portfolio concentration limit — several strategies can each stay within their per-strategy caps while the book drifts into one token (the cross-strategy blind spot)",
      "set safety.maxConcentrationPct (e.g. 50) to flag single-token over-concentration in `portfolio` / `safety review`",
    );
  }
  if (posLimits === 0 && posCaps === 0 && stratBudgets === 0) {
    gap(
      "info",
      "exposureCaps",
      "no per-strategy or per-position exposure caps — only the global USD limits bound how much of any single token the agent can accumulate",
      "set safety.positionCaps / safety.strategyBudgets / safety.positionLimits as your strategy needs",
    );
  }

  // ── circuit breaker ──
  const ddOn = s.drawdownCircuitBreaker?.enabled === true;
  g({
    key: "drawdownCircuitBreaker",
    label: "Drawdown circuit breaker",
    category: "circuit",
    state: ddOn ? "active" : "off",
    detail: ddOn
      ? `trips at −${s.drawdownCircuitBreaker?.maxDrawdownPct}%${s.drawdownCircuitBreaker?.autoResumeAtPct != null ? ` · auto-resume −${s.drawdownCircuitBreaker.autoResumeAtPct}%` : " · manual reset"}`
      : "off (realized losses won't auto-halt trading)",
  });
  if (!ddOn) {
    gap(
      "info",
      "drawdownCircuitBreaker",
      "no portfolio drawdown breaker — a losing streak won't automatically halt trading; you find out when you check",
      "tradekit config set safety.drawdownCircuitBreaker.enabled true (and maxDrawdownPct)",
    );
  }

  // ── human-in-the-loop approval gate ──
  const apprOn = s.tradeApproval?.enabled === true;
  g({
    key: "tradeApproval",
    label: "Human approval gate",
    category: "human",
    state: apprOn ? "active" : "off",
    detail: apprOn
      ? s.tradeApproval?.thresholdUsd == null
        ? "EVERY agent trade needs CLI approval"
        : `agent trades ≥ $${s.tradeApproval.thresholdUsd} need CLI approval`
      : "off (agent trades execute autonomously)",
  });
  if (!apprOn) {
    gap(
      "info",
      "tradeApproval",
      "agent-proposed trades execute without human approval — fine for autonomous deployments, but there is no human checkpoint before capital moves",
      "tradekit config set safety.tradeApproval.enabled true (and thresholdUsd)",
    );
  }

  // ── verdict ──
  const critical = gaps.filter((x) => x.severity === "critical").length;
  const warn = gaps.filter((x) => x.severity === "warn").length;
  const info = gaps.filter((x) => x.severity === "info").length;
  const verdict: SafetyPostureVerdict = critical > 0 ? "exposed" : warn > 0 ? "moderate" : "hardened";

  return {
    generatedAt: now.toISOString(),
    verdict,
    counts: {
      critical,
      warn,
      info,
      activeGuardrails: guardrails.filter((x) => x.state === "active").length,
      totalGuardrails: guardrails.length,
    },
    guardrails,
    gaps,
  };
}

/**
 * v52: the promote-time gate. Returns a blocker message when the
 * posture has at least one CRITICAL gap (safety disabled, or no USD
 * ceiling at all) — the absences that make firing real trades reckless.
 * Returns null when the wallet is adequately guarded (no critical gap).
 *
 * Mirrors playbooks.preflightBlocker: advisory callers ignore it; a
 * `--require-safe` / requireSafe caller throws SAFEGUARD_TRIGGERED on a
 * non-null return. WARN/INFO gaps never block — they are surfaced for
 * the operator to weigh, not enforced.
 */
export function safetyPromoteBlocker(report: SafetyPostureReport): string | null {
  const critical = report.gaps.filter((g) => g.severity === "critical");
  if (critical.length === 0) return null;
  return (
    `wallet not adequately guarded for real trading:\n` +
    critical.map((g) => `  ✗ ${g.finding}\n    fix: ${g.fix}`).join("\n")
  );
}

// ── rendering ────────────────────────────────────────────────

export function renderSafetyReview(r: SafetyPostureReport): string {
  const lines: string[] = [];
  const V = {
    hardened: "🛡 HARDENED",
    moderate: "⚠ MODERATE",
    exposed: "⛔ EXPOSED",
  }[r.verdict];
  lines.push(`Safety posture — ${V}`);
  lines.push(
    `  ${r.counts.activeGuardrails}/${r.counts.totalGuardrails} guardrails active · ${r.counts.critical} critical · ${r.counts.warn} warn · ${r.counts.info} info gap(s)`,
  );

  if (r.gaps.length > 0) {
    const badge = { critical: "⛔", warn: "⚠", info: "·" };
    for (const sev of ["critical", "warn", "info"] as const) {
      const list = r.gaps.filter((x) => x.severity === sev);
      if (list.length === 0) continue;
      lines.push(``);
      lines.push(`  ${sev.toUpperCase()} gaps:`);
      for (const x of list) {
        lines.push(`    ${badge[sev]} ${x.finding}`);
        lines.push(`        fix: ${x.fix}`);
      }
    }
  }

  lines.push(``);
  lines.push(`  Active protections:`);
  const active = r.guardrails.filter((x) => x.state === "active");
  if (active.length === 0) {
    lines.push(`    (none)`);
  } else {
    for (const x of active) lines.push(`    ✓ ${x.label.padEnd(26)} ${x.detail}`);
  }
  const off = r.guardrails.filter((x) => x.state !== "active");
  if (off.length > 0) {
    lines.push(``);
    lines.push(`  Inactive:`);
    for (const x of off) lines.push(`    · ${x.label.padEnd(26)} ${x.detail}`);
  }
  return lines.join("\n");
}
