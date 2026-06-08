// ──────────────────────────────────────────────────────────────────
// Config preflight (iter35): analyze the impact of (oldConfig →
// newConfig) against the current active state.
//
// Why: pre-iter35, an operator tightening `safety.maxSlippageBps`
// from 500 to 200 found out 23 active orders would fail on next
// fire only when the iter32 alerts watcher started firing
// success_rate_drop notifications hours later. Same story for
// tokenWhitelist additions, strategyBudgets reductions, etc.
//
// This module computes the impact UPFRONT: pure (oldConfig,
// newConfig, activeState) → ImpactReport. The CLI surfaces it via
// `tradekit config preflight`; the engine's hot-reload path can
// optionally include it in the `config.reloaded` notification.
//
// Design constraints:
//
//   1. Entirely pure. No DB reads — the active-state input is
//      passed in. The CLI gathers it; tests construct synthetic
//      shapes. Keeps the analyzer testable in isolation + lets the
//      MCP version skip DB I/O for read-only agents.
//
//   2. Rule-by-rule: each safety / engine field has a dedicated
//      analyzer that returns zero or more warnings + affected
//      primitives. Adding a new rule type is one function + one
//      test. No giant switch statement to grow.
//
//   3. Severity classification: "critical" means current state
//      violates the new config (operator MUST act); "warn" means
//      future fires might block; "info" means the change is
//      observable but harmless (e.g., engine interval bump).
//
//   4. Diff representation: structured per-key, not text. Lets the
//      CLI render and the JSON output be machine-readable for
//      agents/dashboards.
// ──────────────────────────────────────────────────────────────────

import type { Config, StrategyAlertRule } from "./config.js";
import type { OrderRow, ScheduleRow, RebalanceRow, DrawdownStateRow } from "./db.js";

// ── public types ────────────────────────────────────────────

export type ImpactSeverity = "info" | "warn" | "critical";

export interface ConfigImpactInput {
  oldConfig: Config;
  newConfig: Config;
  state?: ActiveState;
}

export interface ActiveState {
  /** Active orders for the operator at preflight time. */
  orders?: OrderRow[];
  /** Active schedules. */
  schedules?: ScheduleRow[];
  /** Active rebalance plans. */
  rebalances?: RebalanceRow[];
  /** Drawdown state rows (any scope). */
  drawdowns?: DrawdownStateRow[];
}

export interface ConfigImpact {
  /** Per-key changes. */
  diff: FieldDiff[];
  /** Severity-tagged warnings + the affected primitives. */
  warnings: ImpactWarning[];
  /** Headline counts for quick rendering. */
  summary: ImpactSummary;
}

export interface FieldDiff {
  /** Dot-path (e.g. `safety.maxSlippageBps`). */
  path: string;
  oldValue: unknown;
  newValue: unknown;
  /** Classification heuristic — "tightened" / "loosened" / "added" /
   *  "removed" / "changed" — used by the renderer to pick a hint. */
  kind: FieldChangeKind;
}

export type FieldChangeKind = "tightened" | "loosened" | "added" | "removed" | "changed";

export interface ImpactWarning {
  severity: ImpactSeverity;
  /** Machine-readable identifier for the rule that fired. */
  rule: WarningRule;
  /** One-line operator-facing summary. */
  message: string;
  /** Per-primitive references (when applicable). */
  affected: AffectedRef[];
}

export type WarningRule =
  | "max_slippage_tightened"
  | "per_tx_usd_tightened"
  | "daily_usd_tightened"
  | "default_slippage_changed"
  | "token_blacklist_added"
  | "token_whitelist_tightened"
  | "strategy_budget_added"
  | "strategy_budget_tightened"
  | "drawdown_threshold_tightened"
  | "engine_interval_changed"
  | "engine_worker_disabled"
  | "engine_worker_enabled"
  | "resilience_disabled"
  | "alerts_disabled"
  | "alerts_rule_added"
  | "alerts_rule_removed";

export interface AffectedRef {
  /** Kind of primitive (order / schedule / rebalance / drawdown). */
  type: "order" | "schedule" | "rebalance" | "drawdown";
  id: number | string;
  /** Optional human-readable label (e.g. "trailing 5% sell ETH/USDC"). */
  label?: string;
  /** Why this row is affected — free-text. */
  reason: string;
}

export interface ImpactSummary {
  totalDiffs: number;
  criticalCount: number;
  warnCount: number;
  infoCount: number;
  affectedOrders: number;
  affectedSchedules: number;
  affectedRebalances: number;
}

// ── diff utilities ──────────────────────────────────────────

function classify(oldValue: unknown, newValue: unknown, hint: FieldChangeKind = "changed"): FieldChangeKind {
  if (oldValue == null && newValue != null) return "added";
  if (oldValue != null && newValue == null) return "removed";
  return hint;
}

function numericTighten(oldVal: number | undefined | null, newVal: number | undefined | null, lowerIsTighter: boolean): FieldChangeKind {
  if (oldVal == null && newVal != null) return "added";
  if (oldVal != null && newVal == null) return "removed";
  if (oldVal === newVal) return "changed";
  if (oldVal == null || newVal == null) return "changed";
  if (lowerIsTighter) return newVal < oldVal ? "tightened" : "loosened";
  return newVal > oldVal ? "tightened" : "loosened";
}

// ── analyzers ───────────────────────────────────────────────

function analyzeMaxSlippage(args: { old: Config; new: Config; state?: ActiveState; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldVal = args.old.safety.maxSlippageBps;
  const newVal = args.new.safety.maxSlippageBps;
  if (oldVal === newVal) return;
  const kind = numericTighten(oldVal, newVal, true);
  args.diff.push({ path: "safety.maxSlippageBps", oldValue: oldVal, newValue: newVal, kind });
  if (kind !== "tightened") return;

  const offenders: AffectedRef[] = [];
  for (const o of args.state?.orders ?? []) {
    if (o.slippage_bps != null && o.slippage_bps > newVal) {
      offenders.push({
        type: "order",
        id: o.id ?? -1,
        label: `${o.side} ${o.base_symbol ?? o.base_token}/${o.quote_symbol ?? o.quote_token}`,
        reason: `slippage_bps=${o.slippage_bps} exceeds new cap ${newVal}`,
      });
    }
  }
  for (const s of args.state?.schedules ?? []) {
    if (s.slippage_bps != null && s.slippage_bps > newVal) {
      offenders.push({
        type: "schedule",
        id: s.id ?? -1,
        label: s.name ?? `${s.side} ${s.base_symbol ?? s.base_token}/${s.quote_symbol ?? s.quote_token}`,
        reason: `slippage_bps=${s.slippage_bps} exceeds new cap ${newVal}`,
      });
    }
  }
  if (offenders.length > 0) {
    args.warnings.push({
      severity: "critical",
      rule: "max_slippage_tightened",
      message: `safety.maxSlippageBps tightened ${oldVal} → ${newVal}; ${offenders.length} active primitive(s) carry a higher per-row slippage and will block on next fire.`,
      affected: offenders,
    });
  } else {
    args.warnings.push({
      severity: "info",
      rule: "max_slippage_tightened",
      message: `safety.maxSlippageBps tightened ${oldVal} → ${newVal}; no active primitive exceeds the new cap.`,
      affected: [],
    });
  }
}

function analyzePerTxUsd(args: { old: Config; new: Config; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldVal = args.old.safety.perTxUsdLimit;
  const newVal = args.new.safety.perTxUsdLimit;
  if (oldVal === newVal) return;
  const kind = numericTighten(oldVal, newVal, true);
  args.diff.push({ path: "safety.perTxUsdLimit", oldValue: oldVal ?? null, newValue: newVal ?? null, kind });
  if (kind === "tightened" || kind === "added") {
    args.warnings.push({
      severity: "warn",
      rule: "per_tx_usd_tightened",
      message:
        kind === "added"
          ? `safety.perTxUsdLimit added at $${newVal}. Trades estimated above this will block.`
          : `safety.perTxUsdLimit tightened $${oldVal} → $${newVal}. Trades estimated above the new cap will block.`,
      affected: [],
    });
  }
}

function analyzeDailyUsd(args: { old: Config; new: Config; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldVal = args.old.safety.dailyUsdLimit;
  const newVal = args.new.safety.dailyUsdLimit;
  if (oldVal === newVal) return;
  const kind = numericTighten(oldVal, newVal, true);
  args.diff.push({ path: "safety.dailyUsdLimit", oldValue: oldVal ?? null, newValue: newVal ?? null, kind });
  if (kind === "tightened" || kind === "added") {
    args.warnings.push({
      severity: "warn",
      rule: "daily_usd_tightened",
      message:
        kind === "added"
          ? `safety.dailyUsdLimit added at $${newVal}. Cumulative daily spend above this will block until UTC rollover.`
          : `safety.dailyUsdLimit tightened $${oldVal} → $${newVal}.`,
      affected: [],
    });
  }
}

function analyzeDefaultSlippage(args: { old: Config; new: Config; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldVal = args.old.defaultSlippageBps;
  const newVal = args.new.defaultSlippageBps;
  if (oldVal === newVal) return;
  args.diff.push({ path: "defaultSlippageBps", oldValue: oldVal, newValue: newVal, kind: numericTighten(oldVal, newVal, true) });
  args.warnings.push({
    severity: "info",
    rule: "default_slippage_changed",
    message: `defaultSlippageBps ${oldVal} → ${newVal}. Affects future trades that don't pass an explicit slippage; existing orders with their own slippage_bps are unaffected.`,
    affected: [],
  });
}

function analyzeTokenBlacklist(args: { old: Config; new: Config; state?: ActiveState; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldBL = args.old.safety.tokenBlacklist ?? {};
  const newBL = args.new.safety.tokenBlacklist ?? {};
  const additions = new Map<string, Set<string>>();
  for (const chain of Object.keys(newBL)) {
    const oldSet = new Set((oldBL[chain] ?? []).map((s) => s.toLowerCase()));
    const newSet = (newBL[chain] ?? []).map((s) => s.toLowerCase());
    for (const tok of newSet) {
      if (!oldSet.has(tok)) {
        if (!additions.has(chain)) additions.set(chain, new Set());
        additions.get(chain)!.add(tok);
      }
    }
  }
  if (additions.size === 0) return;
  const totalAdditions = Array.from(additions.values()).reduce((sum, s) => sum + s.size, 0);
  args.diff.push({
    path: "safety.tokenBlacklist",
    oldValue: oldBL,
    newValue: newBL,
    kind: "tightened",
  });

  const offenders: AffectedRef[] = [];
  for (const o of args.state?.orders ?? []) {
    const chainAdds = additions.get(o.chain.toLowerCase());
    if (!chainAdds) continue;
    if (chainAdds.has(o.base_token.toLowerCase()) || chainAdds.has(o.quote_token.toLowerCase())) {
      offenders.push({
        type: "order",
        id: o.id ?? -1,
        label: `${o.side} ${o.base_symbol ?? o.base_token}/${o.quote_symbol ?? o.quote_token}`,
        reason: `references blacklisted token`,
      });
    }
  }
  for (const s of args.state?.schedules ?? []) {
    const chainAdds = additions.get(s.chain.toLowerCase());
    if (!chainAdds) continue;
    if (chainAdds.has(s.base_token.toLowerCase()) || chainAdds.has(s.quote_token.toLowerCase())) {
      offenders.push({
        type: "schedule",
        id: s.id ?? -1,
        label: s.name ?? `${s.side} ${s.base_symbol ?? s.base_token}/${s.quote_symbol ?? s.quote_token}`,
        reason: `references blacklisted token`,
      });
    }
  }
  args.warnings.push({
    severity: offenders.length > 0 ? "critical" : "info",
    rule: "token_blacklist_added",
    message: `${totalAdditions} token(s) added to safety.tokenBlacklist across ${additions.size} chain(s)${
      offenders.length > 0 ? `; ${offenders.length} active primitive(s) reference one.` : "."
    }`,
    affected: offenders,
  });
}

function analyzeTokenWhitelist(args: { old: Config; new: Config; state?: ActiveState; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldWL = args.old.safety.tokenWhitelist;
  const newWL = args.new.safety.tokenWhitelist;
  // Whitelist matters only when ENABLED (non-empty); going from
  // empty/undefined → set is a tightening (everything outside the
  // list is now blocked).
  const oldEmpty = !oldWL || Object.keys(oldWL).length === 0;
  const newEmpty = !newWL || Object.keys(newWL).length === 0;
  if (oldEmpty && newEmpty) return;
  if (oldEmpty && !newEmpty) {
    args.diff.push({ path: "safety.tokenWhitelist", oldValue: oldWL ?? null, newValue: newWL ?? null, kind: "added" });
    // Identify active rows that aren't in the new whitelist.
    const offenders = findWhitelistViolations(newWL!, args.state);
    args.warnings.push({
      severity: offenders.length > 0 ? "critical" : "warn",
      rule: "token_whitelist_tightened",
      message: `safety.tokenWhitelist newly enabled; ${offenders.length} active primitive(s) reference tokens outside the list.`,
      affected: offenders,
    });
    return;
  }
  if (!oldEmpty && newEmpty) {
    args.diff.push({ path: "safety.tokenWhitelist", oldValue: oldWL ?? null, newValue: newWL ?? null, kind: "removed" });
    args.warnings.push({
      severity: "info",
      rule: "token_whitelist_tightened",
      message: "safety.tokenWhitelist disabled. All tokens are now allowed (subject to blacklist).",
      affected: [],
    });
    return;
  }
  // Both set — check if the new list is more restrictive.
  const restrictionsAdded: string[] = [];
  for (const chain of Object.keys(oldWL!)) {
    const oldChain = (oldWL![chain] ?? []).map((s) => s.toLowerCase());
    const newChain = new Set((newWL![chain] ?? []).map((s) => s.toLowerCase()));
    for (const tok of oldChain) {
      if (!newChain.has(tok)) restrictionsAdded.push(`${chain}:${tok}`);
    }
  }
  if (restrictionsAdded.length === 0) return;
  args.diff.push({ path: "safety.tokenWhitelist", oldValue: oldWL ?? null, newValue: newWL ?? null, kind: "tightened" });
  const offenders = findWhitelistViolations(newWL!, args.state);
  args.warnings.push({
    severity: offenders.length > 0 ? "critical" : "warn",
    rule: "token_whitelist_tightened",
    message: `safety.tokenWhitelist tightened (${restrictionsAdded.length} token(s) removed); ${offenders.length} active primitive(s) reference tokens no longer whitelisted.`,
    affected: offenders,
  });
}

function findWhitelistViolations(wl: Record<string, string[]>, state?: ActiveState): AffectedRef[] {
  const offenders: AffectedRef[] = [];
  const chainAllow = (chain: string, tok: string): boolean => {
    const allowed = wl[chain.toLowerCase()];
    if (!allowed) return false;
    return allowed.some((a) => a.toLowerCase() === tok.toLowerCase());
  };
  for (const o of state?.orders ?? []) {
    if (!chainAllow(o.chain, o.base_token) || !chainAllow(o.chain, o.quote_token)) {
      offenders.push({
        type: "order",
        id: o.id ?? -1,
        label: `${o.side} ${o.base_symbol ?? o.base_token}/${o.quote_symbol ?? o.quote_token}`,
        reason: `references a non-whitelisted token on ${o.chain}`,
      });
    }
  }
  for (const s of state?.schedules ?? []) {
    if (!chainAllow(s.chain, s.base_token) || !chainAllow(s.chain, s.quote_token)) {
      offenders.push({
        type: "schedule",
        id: s.id ?? -1,
        label: s.name ?? `${s.side} ${s.base_symbol ?? s.base_token}/${s.quote_symbol ?? s.quote_token}`,
        reason: `references a non-whitelisted token on ${s.chain}`,
      });
    }
  }
  return offenders;
}

function analyzeStrategyBudgets(args: { old: Config; new: Config; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldRules = args.old.safety.strategyBudgets ?? [];
  const newRules = args.new.safety.strategyBudgets ?? [];
  const oldByTag = new Map(oldRules.map((r) => [r.tag, r]));
  const newByTag = new Map(newRules.map((r) => [r.tag, r]));

  for (const [tag, newRule] of newByTag) {
    const oldRule = oldByTag.get(tag);
    if (!oldRule) {
      args.diff.push({ path: `safety.strategyBudgets[${tag}]`, oldValue: null, newValue: newRule, kind: "added" });
      args.warnings.push({
        severity: "warn",
        rule: "strategy_budget_added",
        message: `New strategy budget rule for "${tag}": ${describeBudget(newRule)}.`,
        affected: [],
      });
      continue;
    }
    // Compare each cap.
    const tightenings: string[] = [];
    if (oldRule.lifetimeUsd !== newRule.lifetimeUsd) {
      if (oldRule.lifetimeUsd == null && newRule.lifetimeUsd != null) {
        tightenings.push(`lifetimeUsd added at $${newRule.lifetimeUsd}`);
      } else if (oldRule.lifetimeUsd != null && newRule.lifetimeUsd != null && newRule.lifetimeUsd < oldRule.lifetimeUsd) {
        tightenings.push(`lifetimeUsd $${oldRule.lifetimeUsd} → $${newRule.lifetimeUsd}`);
      }
    }
    if (oldRule.dailyUsd !== newRule.dailyUsd) {
      if (oldRule.dailyUsd == null && newRule.dailyUsd != null) {
        tightenings.push(`dailyUsd added at $${newRule.dailyUsd}`);
      } else if (oldRule.dailyUsd != null && newRule.dailyUsd != null && newRule.dailyUsd < oldRule.dailyUsd) {
        tightenings.push(`dailyUsd $${oldRule.dailyUsd} → $${newRule.dailyUsd}`);
      }
    }
    if (oldRule.perFireUsd !== newRule.perFireUsd) {
      if (oldRule.perFireUsd == null && newRule.perFireUsd != null) {
        tightenings.push(`perFireUsd added at $${newRule.perFireUsd}`);
      } else if (oldRule.perFireUsd != null && newRule.perFireUsd != null && newRule.perFireUsd < oldRule.perFireUsd) {
        tightenings.push(`perFireUsd $${oldRule.perFireUsd} → $${newRule.perFireUsd}`);
      }
    }
    if (tightenings.length > 0) {
      args.diff.push({ path: `safety.strategyBudgets[${tag}]`, oldValue: oldRule, newValue: newRule, kind: "tightened" });
      args.warnings.push({
        severity: "warn",
        rule: "strategy_budget_tightened",
        message: `Strategy budget for "${tag}" tightened: ${tightenings.join(", ")}.`,
        affected: [],
      });
    }
  }
  for (const [tag, oldRule] of oldByTag) {
    if (!newByTag.has(tag)) {
      args.diff.push({ path: `safety.strategyBudgets[${tag}]`, oldValue: oldRule, newValue: null, kind: "removed" });
      // No warning — removing a budget is loosening, never an issue
      // for current state.
    }
  }
}

function describeBudget(r: { lifetimeUsd?: number; dailyUsd?: number; perFireUsd?: number }): string {
  const parts: string[] = [];
  if (r.lifetimeUsd != null) parts.push(`lifetime $${r.lifetimeUsd}`);
  if (r.dailyUsd != null) parts.push(`daily $${r.dailyUsd}`);
  if (r.perFireUsd != null) parts.push(`per-fire $${r.perFireUsd}`);
  return parts.join(", ");
}

function analyzeDrawdown(args: { old: Config; new: Config; state?: ActiveState; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldDd = args.old.safety.drawdownCircuitBreaker;
  const newDd = args.new.safety.drawdownCircuitBreaker;
  if (oldDd === newDd) return; // ref equality (rare but possible in tests)
  const oldEnabled = !!oldDd?.enabled;
  const newEnabled = !!newDd?.enabled;
  if (!oldEnabled && newEnabled) {
    args.diff.push({ path: "safety.drawdownCircuitBreaker", oldValue: oldDd ?? null, newValue: newDd ?? null, kind: "added" });
    // Check if current drawdown already exceeds the new threshold.
    const offenders: AffectedRef[] = [];
    for (const row of args.state?.drawdowns ?? []) {
      if (row.last_value_usd == null) continue;
      const pct = row.peak_usd > 0 ? ((row.peak_usd - row.last_value_usd) / row.peak_usd) * 100 : 0;
      if (pct >= newDd!.maxDrawdownPct) {
        offenders.push({
          type: "drawdown",
          id: row.scope_key,
          reason: `current drawdown ${pct.toFixed(2)}% ≥ new threshold ${newDd!.maxDrawdownPct}%`,
        });
      }
    }
    args.warnings.push({
      severity: offenders.length > 0 ? "critical" : "warn",
      rule: "drawdown_threshold_tightened",
      message: `drawdownCircuitBreaker enabled at maxDrawdownPct=${newDd!.maxDrawdownPct}%${
        offenders.length > 0 ? `; ${offenders.length} scope(s) already past the threshold.` : "."
      }`,
      affected: offenders,
    });
    return;
  }
  if (oldEnabled && !newEnabled) {
    args.diff.push({ path: "safety.drawdownCircuitBreaker", oldValue: oldDd ?? null, newValue: newDd ?? null, kind: "removed" });
    args.warnings.push({
      severity: "info",
      rule: "drawdown_threshold_tightened",
      message: "drawdownCircuitBreaker disabled. Capital trajectory no longer enforces a circuit-breaker.",
      affected: [],
    });
    return;
  }
  if (!oldEnabled || !newEnabled) return;
  if (oldDd!.maxDrawdownPct !== newDd!.maxDrawdownPct) {
    const kind = numericTighten(oldDd!.maxDrawdownPct, newDd!.maxDrawdownPct, true);
    args.diff.push({
      path: "safety.drawdownCircuitBreaker.maxDrawdownPct",
      oldValue: oldDd!.maxDrawdownPct,
      newValue: newDd!.maxDrawdownPct,
      kind,
    });
    if (kind === "tightened") {
      const offenders: AffectedRef[] = [];
      for (const row of args.state?.drawdowns ?? []) {
        if (row.last_value_usd == null) continue;
        const pct = row.peak_usd > 0 ? ((row.peak_usd - row.last_value_usd) / row.peak_usd) * 100 : 0;
        if (pct >= newDd!.maxDrawdownPct) {
          offenders.push({
            type: "drawdown",
            id: row.scope_key,
            reason: `current drawdown ${pct.toFixed(2)}% ≥ new threshold ${newDd!.maxDrawdownPct}%`,
          });
        }
      }
      args.warnings.push({
        severity: offenders.length > 0 ? "critical" : "warn",
        rule: "drawdown_threshold_tightened",
        message: `drawdownCircuitBreaker.maxDrawdownPct tightened ${oldDd!.maxDrawdownPct}% → ${newDd!.maxDrawdownPct}%${
          offenders.length > 0 ? `; ${offenders.length} scope(s) already past the new threshold.` : "."
        }`,
        affected: offenders,
      });
    }
  }
}

function analyzeEngineWorkers(args: { old: Config; new: Config; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldW = args.old.engine.workers;
  const newW = args.new.engine.workers;
  // Iterate the union of keys (alerts may not be present in old configs).
  const keys = new Set<keyof typeof newW>();
  for (const k of Object.keys(oldW)) keys.add(k as keyof typeof newW);
  for (const k of Object.keys(newW)) keys.add(k as keyof typeof newW);
  for (const name of keys) {
    const o = oldW[name];
    const n = newW[name];
    if (!o && !n) continue;
    if (!o && n) {
      args.diff.push({ path: `engine.workers.${name}`, oldValue: null, newValue: n, kind: "added" });
      args.warnings.push({
        severity: "info",
        rule: "engine_worker_enabled",
        message: `Engine worker "${String(name)}" added (interval ${(n.intervalMs / 1000).toFixed(0)}s).`,
        affected: [],
      });
      continue;
    }
    if (o && !n) {
      args.diff.push({ path: `engine.workers.${name}`, oldValue: o, newValue: null, kind: "removed" });
      args.warnings.push({
        severity: "warn",
        rule: "engine_worker_disabled",
        message: `Engine worker "${String(name)}" removed.`,
        affected: [],
      });
      continue;
    }
    if (o!.enabled !== n!.enabled) {
      args.diff.push({ path: `engine.workers.${name}.enabled`, oldValue: o!.enabled, newValue: n!.enabled, kind: o!.enabled ? "removed" : "added" });
      args.warnings.push({
        severity: n!.enabled ? "info" : "warn",
        rule: n!.enabled ? "engine_worker_enabled" : "engine_worker_disabled",
        message: `Engine worker "${String(name)}" ${n!.enabled ? "enabled" : "disabled"}.`,
        affected: [],
      });
    }
    if (o!.intervalMs !== n!.intervalMs) {
      args.diff.push({
        path: `engine.workers.${name}.intervalMs`,
        oldValue: o!.intervalMs,
        newValue: n!.intervalMs,
        kind: numericTighten(o!.intervalMs, n!.intervalMs, false), // higher = looser cadence
      });
      args.warnings.push({
        severity: "info",
        rule: "engine_interval_changed",
        message: `Engine worker "${String(name)}" interval ${(o!.intervalMs / 1000).toFixed(0)}s → ${(n!.intervalMs / 1000).toFixed(0)}s.`,
        affected: [],
      });
    }
  }
}

function analyzeAlerts(args: { old: Config; new: Config; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldA = args.old.safety.strategyAlerts;
  const newA = args.new.safety.strategyAlerts;
  const oldEnabled = !!oldA?.enabled;
  const newEnabled = !!newA?.enabled;
  if (oldEnabled && !newEnabled) {
    args.diff.push({ path: "safety.strategyAlerts.enabled", oldValue: true, newValue: false, kind: "removed" });
    args.warnings.push({
      severity: "warn",
      rule: "alerts_disabled",
      message: "Strategy alerts disabled. Proactive notifications will stop on next watcher tick.",
      affected: [],
    });
  }
  if (!oldEnabled && newEnabled) {
    args.diff.push({ path: "safety.strategyAlerts.enabled", oldValue: false, newValue: true, kind: "added" });
  }
  const oldRules = oldA?.rules ?? [];
  const newRules = newA?.rules ?? [];
  const oldKey = oldRules.map(ruleKey).sort();
  const newKey = newRules.map(ruleKey).sort();
  const added = newRules.filter((r) => !oldKey.includes(ruleKey(r)));
  const removed = oldRules.filter((r) => !newKey.includes(ruleKey(r)));
  for (const r of added) {
    args.diff.push({ path: `safety.strategyAlerts.rules[${r.type}]`, oldValue: null, newValue: r, kind: "added" });
    args.warnings.push({
      severity: "info",
      rule: "alerts_rule_added",
      message: `Strategy alert rule "${r.type}" added.`,
      affected: [],
    });
  }
  for (const r of removed) {
    args.diff.push({ path: `safety.strategyAlerts.rules[${r.type}]`, oldValue: r, newValue: null, kind: "removed" });
    args.warnings.push({
      severity: "info",
      rule: "alerts_rule_removed",
      message: `Strategy alert rule "${r.type}" removed.`,
      affected: [],
    });
  }
}

function ruleKey(r: StrategyAlertRule): string {
  // Discriminate by type + tag-pattern set (so "two rules with the
  // same type but different appliesTo" don't collapse).
  return `${r.type}::${(r.appliesTo ?? []).slice().sort().join(",")}`;
}

function analyzeResilience(args: { old: Config; new: Config; diff: FieldDiff[]; warnings: ImpactWarning[] }): void {
  const oldR = args.old.engine.resilience;
  const newR = args.new.engine.resilience;
  if (oldR.enabled !== newR.enabled) {
    args.diff.push({ path: "engine.resilience.enabled", oldValue: oldR.enabled, newValue: newR.enabled, kind: newR.enabled ? "added" : "removed" });
    if (!newR.enabled) {
      args.warnings.push({
        severity: "warn",
        rule: "resilience_disabled",
        message: "engine.resilience.enabled=false. Workers will no longer back off after consecutive failures.",
        affected: [],
      });
    }
  }
}

// ── main entry ──────────────────────────────────────────────

export function computeConfigImpact(args: ConfigImpactInput): ConfigImpact {
  const diff: FieldDiff[] = [];
  const warnings: ImpactWarning[] = [];
  const shared = { old: args.oldConfig, new: args.newConfig, state: args.state, diff, warnings };

  analyzeMaxSlippage(shared);
  analyzePerTxUsd(shared);
  analyzeDailyUsd(shared);
  analyzeDefaultSlippage({ old: args.oldConfig, new: args.newConfig, diff, warnings });
  analyzeTokenBlacklist(shared);
  analyzeTokenWhitelist(shared);
  analyzeStrategyBudgets({ old: args.oldConfig, new: args.newConfig, diff, warnings });
  analyzeDrawdown(shared);
  analyzeEngineWorkers({ old: args.oldConfig, new: args.newConfig, diff, warnings });
  analyzeAlerts({ old: args.oldConfig, new: args.newConfig, diff, warnings });
  analyzeResilience({ old: args.oldConfig, new: args.newConfig, diff, warnings });

  // Aggregate summary counts.
  let criticalCount = 0,
    warnCount = 0,
    infoCount = 0;
  const affectedOrders = new Set<number>();
  const affectedSchedules = new Set<number>();
  const affectedRebalances = new Set<number>();
  for (const w of warnings) {
    if (w.severity === "critical") criticalCount += 1;
    else if (w.severity === "warn") warnCount += 1;
    else infoCount += 1;
    for (const a of w.affected) {
      if (a.type === "order" && typeof a.id === "number") affectedOrders.add(a.id);
      else if (a.type === "schedule" && typeof a.id === "number") affectedSchedules.add(a.id);
      else if (a.type === "rebalance" && typeof a.id === "number") affectedRebalances.add(a.id);
    }
  }

  return {
    diff,
    warnings,
    summary: {
      totalDiffs: diff.length,
      criticalCount,
      warnCount,
      infoCount,
      affectedOrders: affectedOrders.size,
      affectedSchedules: affectedSchedules.size,
      affectedRebalances: affectedRebalances.size,
    },
  };
}
