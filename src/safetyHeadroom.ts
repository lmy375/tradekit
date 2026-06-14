/**
 * Safety headroom (v53) — "how much room do I have left, and what's my
 * binding constraint right now?"
 *
 * The third use of the safety investment, not a fourth guardrail:
 *   - v51 safety_review makes the static config posture legible (operator).
 *   - v52 promote safety-preflight makes it gate go-live (the gate).
 *   - v53 here makes the RUNTIME envelope legible to the AGENT at
 *     decision time.
 *
 * An autonomous agent that knows it has $50 of a $1000 daily limit left,
 * is 80% to a position cap, and is 5% from a drawdown trip can SIZE its
 * next trade intelligently — instead of firing blind and bouncing off a
 * SAFEGUARD_TRIGGERED rejection. And the operator gets a one-read "how
 * close is my agent to its limits?".
 *
 * Each active quantitative limit becomes a HeadroomEntry with used /
 * remaining / utilization%, classified ok | approaching | exhausted |
 * tripped. The `binding` entry is the tightest active constraint.
 *
 * Deterministic + offline: reads config + the trades/drawdown tables
 * (no oracle, no RPC). Static limits with no cumulative state (per-tx
 * cap) are reported informationally. Injection seams keep tests pure.
 */

import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import {
  dailyUsdVolume,
  usdSpentUnderStrategy,
  getDrawdownState,
  lastTradeAtByAccount,
  listDistinctStrategies,
  type DrawdownStateRow,
} from "./db.js";
import { computeBudgetConsumption } from "./strategyBudget.js";
import { netPosition, capMatchesTag, defaultFillRows, type FillRowLite, type PositionCapRule } from "./positionCaps.js";

/** Utilization at/above this fraction (%) flags a limit as approaching. */
export const APPROACHING_PCT = 80;

export type HeadroomStatus = "ok" | "approaching" | "exhausted" | "tripped";

export interface HeadroomEntry {
  key: string;
  label: string;
  /** What the limit is scoped to — "account:default × base", "global",
   *  "strategy dca-eth", "dca-eth × WETH". */
  scope: string;
  /** The cap. Null for purely informational / time-based limits. */
  limit: number | null;
  /** Current consumption toward the cap. Null when not applicable. */
  used: number | null;
  /** limit − used, floored at 0. Null when not quantifiable. */
  remaining: number | null;
  /** used / limit × 100. Null when not quantifiable. */
  utilizationPct: number | null;
  status: HeadroomStatus;
  detail: string;
}

export interface SafetyHeadroomReport {
  generatedAt: string;
  account: string;
  chain: string | null;
  entries: HeadroomEntry[];
  /** Tightest active constraint (tripped > exhausted > approaching > ok;
   *  tiebreak highest utilization). Null when no quantitative limit is
   *  active. */
  binding: HeadroomEntry | null;
  counts: { ok: number; approaching: number; exhausted: number; tripped: number };
}

function classify(utilizationPct: number | null): HeadroomStatus {
  if (utilizationPct == null) return "ok";
  if (utilizationPct >= 100) return "exhausted";
  if (utilizationPct >= APPROACHING_PCT) return "approaching";
  return "ok";
}

const DAY_MS = 86_400_000;

export function gatherSafetyHeadroom(args: {
  config?: Config;
  account?: string;
  chain?: string;
  now?: Date;
  // ── injection seams (tests) ──
  dailyVolumeFn?: (account: string, chain?: string) => number;
  spentLookup?: (tag: string, sinceIso?: string) => number;
  distinctStrategiesFn?: () => string[];
  drawdownLookup?: (scope: string) => DrawdownStateRow | null;
  lastTradeAtFn?: () => Map<string, string>;
  fillRowsLookup?: (tag: string, paper: boolean) => FillRowLite[];
} = {}): SafetyHeadroomReport {
  const config = args.config ?? loadConfig();
  const s = config.safety;
  const now = args.now ?? new Date();
  const account = args.account ?? config.activeAccount ?? "default";
  const chain = (args.chain ?? config.activeChain ?? null)?.toLowerCase() ?? null;
  const entries: HeadroomEntry[] = [];

  // ── per-tx USD: a static ceiling (no cumulative state) ──
  if (s.perTxUsdLimit != null) {
    entries.push({
      key: "perTxUsd",
      label: "Per-trade USD cap",
      scope: "every trade",
      limit: s.perTxUsdLimit,
      used: null,
      remaining: null,
      utilizationPct: null,
      status: "ok",
      detail: `each trade must be ≤ $${s.perTxUsdLimit} (static ceiling, not cumulative)`,
    });
  }

  // ── daily USD: 24h rolling volume vs cap, scoped account × chain ──
  if (s.dailyUsdLimit != null) {
    const used = (args.dailyVolumeFn ?? dailyUsdVolume)(account, chain ?? undefined);
    const util = (used / s.dailyUsdLimit) * 100;
    entries.push({
      key: "dailyUsd",
      label: "Daily USD cap",
      scope: `account:${account}${chain ? ` × ${chain}` : ""}`,
      limit: s.dailyUsdLimit,
      used,
      remaining: Math.max(0, s.dailyUsdLimit - used),
      utilizationPct: util,
      status: classify(util),
      detail: `$${used.toFixed(2)} of $${s.dailyUsdLimit} used in the last 24h · $${Math.max(0, s.dailyUsdLimit - used).toFixed(2)} left`,
    });
  }

  // ── strategy budgets: reuse the live-consumption engine (lifetime +
  //    24h-rolling). perFire is a per-trade ceiling, reported as static. ──
  if (s.strategyBudgets && s.strategyBudgets.length > 0) {
    const consumption = computeBudgetConsumption({
      budgets: s.strategyBudgets,
      spentLookup: args.spentLookup ?? usdSpentUnderStrategy,
      distinctStrategiesFn:
        args.distinctStrategiesFn ??
        (() => listDistinctStrategies({}).map((r) => r.strategy).filter((t): t is string => t != null)),
    });
    for (const c of consumption) {
      const tagLabel = c.matchedTags.length === 1 ? c.matchedTags[0] : `${c.rule.tag} (${c.matchedTags.length} tags)`;
      if (c.rule.lifetimeUsd != null) {
        const util = (c.lifetimeSpentUsd! / c.rule.lifetimeUsd) * 100;
        entries.push({
          key: `strategyBudget:lifetime:${c.rule.tag}`,
          label: "Strategy budget (lifetime)",
          scope: `strategy ${tagLabel}`,
          limit: c.rule.lifetimeUsd,
          used: c.lifetimeSpentUsd,
          remaining: c.remaining.lifetime,
          utilizationPct: util,
          status: classify(util),
          detail: `$${c.lifetimeSpentUsd!.toFixed(2)} of $${c.rule.lifetimeUsd} lifetime · $${c.remaining.lifetime!.toFixed(2)} left`,
        });
      }
      if (c.rule.dailyUsd != null) {
        const util = (c.dailySpentUsd! / c.rule.dailyUsd) * 100;
        entries.push({
          key: `strategyBudget:daily:${c.rule.tag}`,
          label: "Strategy budget (24h)",
          scope: `strategy ${tagLabel}`,
          limit: c.rule.dailyUsd,
          used: c.dailySpentUsd,
          remaining: c.remaining.daily,
          utilizationPct: util,
          status: classify(util),
          detail: `$${c.dailySpentUsd!.toFixed(2)} of $${c.rule.dailyUsd} in 24h · $${c.remaining.daily!.toFixed(2)} left`,
        });
      }
      if (c.rule.perFireUsd != null) {
        entries.push({
          key: `strategyBudget:perFire:${c.rule.tag}`,
          label: "Strategy budget (per-fire)",
          scope: `strategy ${tagLabel}`,
          limit: c.rule.perFireUsd,
          used: null,
          remaining: null,
          utilizationPct: null,
          status: "ok",
          detail: `each fire must be ≤ $${c.rule.perFireUsd} (static ceiling)`,
        });
      }
    }
  }

  // ── drawdown circuit breaker: distance from current DD% to the trip ──
  if (s.drawdownCircuitBreaker?.enabled === true) {
    const maxDd = s.drawdownCircuitBreaker.maxDrawdownPct;
    const st = (args.drawdownLookup ?? getDrawdownState)("global");
    const tripped = st?.tripped_at != null;
    let currentDd: number | null = null;
    if (st != null && st.last_value_usd != null && st.peak_usd > 0) {
      currentDd = Math.max(0, ((st.peak_usd - st.last_value_usd) / st.peak_usd) * 100);
    }
    const util = currentDd != null ? (currentDd / maxDd) * 100 : null;
    entries.push({
      key: "drawdown",
      label: "Drawdown circuit breaker",
      scope: "global",
      limit: maxDd,
      used: currentDd,
      remaining: currentDd != null ? Math.max(0, maxDd - currentDd) : null,
      utilizationPct: util,
      status: tripped ? "tripped" : classify(util),
      detail: tripped
        ? `TRIPPED at ${st?.tripped_at} — trading halted until reset (\`tradekit safety reset-drawdown\`)`
        : currentDd != null
          ? `current drawdown ${currentDd.toFixed(1)}% of the ${maxDd}% trip threshold · ${Math.max(0, maxDd - currentDd).toFixed(1)}pp of room`
          : `enabled (trips at −${maxDd}%); no portfolio peak observed yet`,
    });
  }

  // ── rate limit: time since the account's last trade vs the minimum ──
  if (s.minTradeIntervalMs != null && s.minTradeIntervalMs > 0) {
    const lastMap = (args.lastTradeAtFn ?? lastTradeAtByAccount)();
    const lastIso = lastMap.get(account) ?? null;
    const elapsedMs = lastIso != null ? now.getTime() - Date.parse(lastIso) : null;
    const ready = elapsedMs == null || elapsedMs >= s.minTradeIntervalMs;
    const waitMs = ready ? 0 : s.minTradeIntervalMs - (elapsedMs ?? 0);
    entries.push({
      key: "rateLimit",
      label: "Trade rate limit",
      scope: `account:${account}`,
      limit: s.minTradeIntervalMs,
      used: elapsedMs != null ? Math.min(elapsedMs, s.minTradeIntervalMs) : null,
      remaining: waitMs,
      utilizationPct: elapsedMs != null && !ready ? ((s.minTradeIntervalMs - waitMs) / s.minTradeIntervalMs) * 100 : ready ? 0 : null,
      status: ready ? "ok" : "approaching",
      detail: ready
        ? `ready — last trade ${lastIso ?? "never"}; ≥${s.minTradeIntervalMs}ms required between trades`
        : `wait ${waitMs}ms — last trade ${elapsedMs}ms ago, minimum ${s.minTradeIntervalMs}ms`,
    });
  }

  // ── position caps: current NET exposure vs the cap, per matching tag ──
  if (s.positionCaps && s.positionCaps.length > 0) {
    const distinct = (args.distinctStrategiesFn ??
      (() => listDistinctStrategies({}).map((r) => r.strategy).filter((t): t is string => t != null)))();
    const fills = args.fillRowsLookup ?? defaultFillRows;
    for (const cap of s.positionCaps as PositionCapRule[]) {
      const tags = cap.pattern.endsWith("*") ? distinct.filter((t) => capMatchesTag(cap, t)) : [cap.pattern];
      for (const tag of tags) {
        const pos = netPosition(fills(tag, false), cap);
        // Pick the tighter configured dimension as the entry's headroom.
        const dims: Array<{ kind: string; used: number; limit: number }> = [];
        if (cap.maxBaseAmount != null) dims.push({ kind: "base", used: pos.baseAmount, limit: cap.maxBaseAmount });
        if (cap.maxCostQuote != null) dims.push({ kind: "cost", used: pos.costQuote, limit: cap.maxCostQuote });
        if (dims.length === 0) continue;
        const tightest = dims.reduce((a, b) => (b.used / b.limit > a.used / a.limit ? b : a));
        const util = (tightest.used / tightest.limit) * 100;
        entries.push({
          key: `positionCap:${tag}:${cap.token}`,
          label: "Net-exposure cap",
          scope: `${tag} × ${cap.token}`,
          limit: tightest.limit,
          used: tightest.used,
          remaining: Math.max(0, tightest.limit - tightest.used),
          utilizationPct: util,
          status: classify(util),
          detail: dims
            .map((d) => `net ${d.kind} ${d.used.toFixed(d.kind === "base" ? 4 : 2)} of ${d.limit} (${((d.used / d.limit) * 100).toFixed(0)}%)`)
            .join(" · "),
        });
      }
    }
  }

  // ── binding constraint + counts ──
  const rank: Record<HeadroomStatus, number> = { tripped: 3, exhausted: 2, approaching: 1, ok: 0 };
  const quantitative = entries.filter((e) => e.utilizationPct != null || e.status === "tripped");
  const binding =
    quantitative.length === 0
      ? null
      : quantitative.reduce((a, b) => {
          if (rank[b.status] !== rank[a.status]) return rank[b.status] > rank[a.status] ? b : a;
          return (b.utilizationPct ?? 0) > (a.utilizationPct ?? 0) ? b : a;
        });

  return {
    generatedAt: now.toISOString(),
    account,
    chain,
    entries,
    binding,
    counts: {
      ok: entries.filter((e) => e.status === "ok").length,
      approaching: entries.filter((e) => e.status === "approaching").length,
      exhausted: entries.filter((e) => e.status === "exhausted").length,
      tripped: entries.filter((e) => e.status === "tripped").length,
    },
  };
}

// ── rendering ────────────────────────────────────────────────

export function renderSafetyHeadroom(r: SafetyHeadroomReport): string {
  const lines: string[] = [];
  lines.push(`Safety headroom — account:${r.account}${r.chain ? ` × ${r.chain}` : ""}`);
  if (r.entries.length === 0) {
    lines.push(`  (no quantitative limits configured — the agent's spend/loss/rate envelope is unbounded; see \`tradekit safety review\`)`);
    return lines.join("\n");
  }
  if (r.binding) {
    const b = r.binding;
    lines.push(`  Binding constraint: ${b.label} (${b.scope}) — ${b.utilizationPct != null ? `${b.utilizationPct.toFixed(0)}% used` : b.status}`);
  }
  lines.push(`  ${r.counts.tripped} tripped · ${r.counts.exhausted} exhausted · ${r.counts.approaching} approaching · ${r.counts.ok} ok`);
  lines.push(``);
  const badge: Record<HeadroomStatus, string> = { tripped: "⛔", exhausted: "⛔", approaching: "⚠", ok: "✓" };
  for (const e of r.entries) {
    lines.push(`  ${badge[e.status]} ${e.label.padEnd(28)} ${e.detail}`);
  }
  return lines.join("\n");
}
