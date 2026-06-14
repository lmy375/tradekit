/**
 * Trade sizing (v70) — "what's the LARGEST trade I can make right now, and
 * which limit binds?"
 *
 * v54's projectTradeLimits answers the forward question — "is THIS size
 * admissible?". v53's safetyHeadroom reports "how much room is left" per limit.
 * Neither answers the question an agent actually faces on every trade: given my
 * configured guardrails and current consumption, what is the MAX I can spend on
 * a single trade before something rejects it? Today the agent has to read the
 * headroom, manually take the min across every USD-denominated limit, and
 * convert — error-prone, and over-sizing is a top way an autonomous agent
 * blows up. This solves for that ceiling directly and names the binding
 * constraint, turning the safety posture into a concrete, safe trade size.
 *
 * It reuses the SAME consumption lookups the real enforcers use
 * (dailyUsdVolume, usdSpentUnderStrategy, netPosition) — zero divergence from
 * what would actually gate the trade at execution.
 *
 * Deterministic: every lookup is injectable. The binding-selection logic is a
 * pure exported helper. Network-free by default (no price → token-amount
 * conversion is simply omitted, surfaced as a caveat).
 */

import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { dailyUsdVolume, usdSpentUnderStrategy } from "./db.js";
import { rulesMatchingTag, type BudgetRule } from "./strategyBudget.js";
import {
  netPosition,
  capMatchesTag,
  defaultFillRows,
  type FillRowLite,
  type PositionCapRule,
} from "./positionCaps.js";

export type SizingConstraintKind =
  | "per_tx"
  | "daily"
  | "strategy_per_fire"
  | "strategy_lifetime"
  | "strategy_daily"
  | "position_cap_cost"
  | "wallet_balance";

export interface SizingConstraint {
  kind: SizingConstraintKind;
  label: string;
  /** Max single-trade USD this constraint alone would allow (floored at 0). */
  capUsd: number;
  /** What the constraint is scoped to (account, strategy tag, token …). */
  scope: string;
  detail: string;
}

export interface TradeSizingReport {
  account: string;
  chain: string | null;
  direction: "buy" | "sell";
  strategy: string | null;
  /** Base token symbol/address the sizing was scoped to (for position caps). */
  token: string | null;
  /** The largest single-trade USD that clears EVERY constraint below — i.e.
   *  min(constraints.capUsd). Null when no USD-denominated limit applies
   *  (sizing is unbounded by policy; only the wallet/position constrains). */
  maxTradeUsd: number | null;
  /** The constraint that sets the ceiling (the tightest). Null when unbounded. */
  binding: SizingConstraint | null;
  /** Every USD constraint considered, ascending by capUsd. */
  constraints: SizingConstraint[];
  /** Mark price used for the token-amount conversion (null when unavailable). */
  priceUsd: number | null;
  /** maxTradeUsd expressed in base-token units (buy: base received ≈; sell:
   *  base sold). Null when no price or no USD ceiling. */
  maxBaseAmount: number | null;
  /** Limits that exist but are NOT folded into maxTradeUsd (so the number is
   *  never silently over-trusted) — e.g. a base-amount position cap with no
   *  price to convert, or the recommendation to preflight the chosen size. */
  caveats: string[];
  generatedAt: string;
}

/**
 * Pure: given the candidate constraints, pick the tightest (smallest capUsd).
 * Empty → unbounded (null). Ties resolve to the first in the sorted order
 * (stable). Exported for direct unit testing of the selection edge cases.
 */
export function selectBindingConstraint(constraints: readonly SizingConstraint[]): {
  maxTradeUsd: number | null;
  binding: SizingConstraint | null;
  sorted: SizingConstraint[];
} {
  const sorted = [...constraints].sort((a, b) => a.capUsd - b.capUsd);
  if (sorted.length === 0) return { maxTradeUsd: null, binding: null, sorted };
  return { maxTradeUsd: sorted[0].capUsd, binding: sorted[0], sorted };
}

/**
 * Pure: the max single-trade USD each window of a budget rule allows. perFire
 * is a static ceiling; lifetime/daily are (cap − already-spent), floored at 0.
 * This is the exact inverse of evaluateRule (which checks predicted ≤ remaining).
 */
export function budgetConstraints(
  rule: BudgetRule,
  spentLifetimeUsd: number,
  spentDailyUsd: number,
): SizingConstraint[] {
  const out: SizingConstraint[] = [];
  const scope = `strategy ${rule.tag}`;
  if (rule.perFireUsd != null) {
    out.push({
      kind: "strategy_per_fire",
      label: "Strategy budget (per-fire)",
      capUsd: Math.max(0, rule.perFireUsd),
      scope,
      detail: `each fire must be ≤ $${rule.perFireUsd.toFixed(2)}`,
    });
  }
  if (rule.lifetimeUsd != null) {
    const remaining = Math.max(0, rule.lifetimeUsd - spentLifetimeUsd);
    out.push({
      kind: "strategy_lifetime",
      label: "Strategy budget (lifetime)",
      capUsd: remaining,
      scope,
      detail: `$${remaining.toFixed(2)} left of $${rule.lifetimeUsd.toFixed(2)} lifetime (spent $${spentLifetimeUsd.toFixed(2)})`,
    });
  }
  if (rule.dailyUsd != null) {
    const remaining = Math.max(0, rule.dailyUsd - spentDailyUsd);
    out.push({
      kind: "strategy_daily",
      label: "Strategy budget (24h)",
      capUsd: remaining,
      scope,
      detail: `$${remaining.toFixed(2)} left of $${rule.dailyUsd.toFixed(2)} in 24h (spent $${spentDailyUsd.toFixed(2)})`,
    });
  }
  return out;
}

const DAY_MS = 86_400_000;

/**
 * Resolve the maximum admissible trade size right now. Returns the USD ceiling
 * + the binding constraint + every constraint considered, optionally converted
 * to a base-token amount when a mark price is supplied.
 *
 * All consumption lookups are injectable; with no injections it reads the live
 * DB (the same path the enforcers use).
 */
export function gatherTradeSizing(args: {
  direction: "buy" | "sell";
  config?: Config;
  account?: string;
  chain?: string;
  strategy?: string | null;
  /** Base token (symbol or 0x) — needed to scope net-exposure position caps. */
  token?: string | null;
  /** USD price of the base token, for the token-amount conversion. */
  priceUsd?: number | null;
  /** Spendable wallet value in USD — when supplied, adds a wallet ceiling. */
  walletUsd?: number | null;
  now?: Date;
  // ── injection seams (tests) ──
  dailyVolumeFn?: (account: string, chain?: string) => number;
  spentLookup?: (tag: string, sinceIso?: string) => number;
  fillRowsLookup?: (tag: string, paper: boolean) => FillRowLite[];
}): TradeSizingReport {
  const config = args.config ?? loadConfig();
  const s = config.safety;
  const now = args.now ?? new Date();
  const account = args.account ?? config.activeAccount ?? "default";
  const chain = (args.chain ?? config.activeChain ?? null)?.toLowerCase() ?? null;
  const strategy = args.strategy ?? null;
  const token = args.token ?? null;
  const constraints: SizingConstraint[] = [];
  const caveats: string[] = [];

  // ── per-tx USD cap: a static per-trade ceiling ──
  if (s.perTxUsdLimit != null) {
    constraints.push({
      kind: "per_tx",
      label: "Per-trade USD cap",
      capUsd: Math.max(0, s.perTxUsdLimit),
      scope: "every trade",
      detail: `each trade must be ≤ $${s.perTxUsdLimit.toFixed(2)}`,
    });
  }

  // ── daily USD: cap − 24h rolling volume (account × chain) ──
  if (s.dailyUsdLimit != null) {
    const used = (args.dailyVolumeFn ?? dailyUsdVolume)(account, chain ?? undefined);
    const remaining = Math.max(0, s.dailyUsdLimit - used);
    constraints.push({
      kind: "daily",
      label: "Daily USD cap",
      capUsd: remaining,
      scope: `account:${account}${chain ? ` × ${chain}` : ""}`,
      detail: `$${remaining.toFixed(2)} left of $${s.dailyUsdLimit.toFixed(2)} (spent $${used.toFixed(2)} in 24h)`,
    });
  }

  // ── strategy budgets: per matching rule, the tightest window remaining ──
  if (strategy && s.strategyBudgets && s.strategyBudgets.length > 0) {
    const matching = rulesMatchingTag(s.strategyBudgets as BudgetRule[], strategy);
    const lookup = args.spentLookup ?? usdSpentUnderStrategy;
    for (const rule of matching) {
      const needLifetime = rule.lifetimeUsd != null;
      const needDaily = rule.dailyUsd != null;
      const spentLifetime = needLifetime ? lookup(strategy) : 0;
      const spentDaily = needDaily
        ? lookup(strategy, new Date(now.getTime() - DAY_MS).toISOString())
        : 0;
      constraints.push(...budgetConstraints(rule, spentLifetime, spentDaily));
    }
  } else if (!strategy && s.strategyBudgets && s.strategyBudgets.length > 0) {
    caveats.push(
      "Strategy budgets are configured but no `strategy` tag was given — pass the tag this trade will carry to fold its budget into the ceiling.",
    );
  }

  // ── net-exposure position cap (BUY only — sells reduce exposure) ──
  // The cost-quote dimension is a clean USD ceiling on the spend; the
  // base-amount dimension limits token quantity (folded in when a price lets
  // us convert it to USD, else surfaced as a caveat).
  if (args.direction === "buy" && token && s.positionCaps && s.positionCaps.length > 0) {
    const fills = args.fillRowsLookup ?? defaultFillRows;
    for (const cap of s.positionCaps as PositionCapRule[]) {
      if (!capMatchesTag(cap, strategy)) continue;
      // Net position is per (tag, token); cap.token scopes which token.
      const pos = netPosition(fills(strategy ?? cap.pattern, false), { token: cap.token });
      if (cap.maxCostQuote != null) {
        const remaining = Math.max(0, cap.maxCostQuote - pos.costQuote);
        constraints.push({
          kind: "position_cap_cost",
          label: "Net-exposure cap (cost)",
          capUsd: remaining,
          scope: `${cap.pattern} × ${cap.token}`,
          detail: `$${remaining.toFixed(2)} of cost-basis room left (holding $${pos.costQuote.toFixed(2)} of $${cap.maxCostQuote.toFixed(2)})`,
        });
      }
      if (cap.maxBaseAmount != null) {
        const remainingBase = Math.max(0, cap.maxBaseAmount - pos.baseAmount);
        if (args.priceUsd != null && args.priceUsd > 0) {
          constraints.push({
            kind: "position_cap_cost",
            label: "Net-exposure cap (base→USD)",
            capUsd: remainingBase * args.priceUsd,
            scope: `${cap.pattern} × ${cap.token}`,
            detail: `${remainingBase.toFixed(6)} base units of room left × $${args.priceUsd} ≈ $${(remainingBase * args.priceUsd).toFixed(2)} (holding ${pos.baseAmount.toFixed(6)} of ${cap.maxBaseAmount})`,
          });
        } else {
          caveats.push(
            `A base-amount net-exposure cap (${cap.pattern} × ${cap.token}, ≤ ${cap.maxBaseAmount} units, holding ${pos.baseAmount.toFixed(6)}) applies but no price was available to convert it to USD — the USD ceiling does not account for it.`,
          );
        }
      }
    }
  } else if (args.direction === "buy" && !token && s.positionCaps && s.positionCaps.length > 0) {
    caveats.push(
      "Net-exposure position caps are configured but no `token` was given — pass the base token to fold the cap into the ceiling.",
    );
  }

  // ── wallet balance ceiling (optional — you can't spend what you don't have) ──
  if (args.walletUsd != null && args.walletUsd >= 0) {
    constraints.push({
      kind: "wallet_balance",
      label: "Spendable wallet balance",
      capUsd: args.walletUsd,
      scope: `account:${account}`,
      detail: `$${args.walletUsd.toFixed(2)} spendable`,
    });
  }

  const { maxTradeUsd, binding, sorted } = selectBindingConstraint(constraints);

  let maxBaseAmount: number | null = null;
  if (maxTradeUsd != null && args.priceUsd != null && args.priceUsd > 0) {
    maxBaseAmount = maxTradeUsd / args.priceUsd;
  } else if (maxTradeUsd != null && (args.priceUsd == null || args.priceUsd <= 0)) {
    caveats.push("No base-token price available — maxTradeUsd is not converted to a token amount.");
  }

  if (maxTradeUsd === 0) {
    caveats.push(
      `maxTradeUsd is $0 — ${binding?.label ?? "a limit"} is fully consumed; no trade is admissible right now.`,
    );
  }
  if (maxTradeUsd != null) {
    caveats.push(
      "Run the chosen size through `preflight_trade` before firing — sizing covers the USD spend limits but the preview re-checks token safety, slippage, and the exact admissibility at execution.",
    );
  }

  return {
    account,
    chain,
    direction: args.direction,
    strategy,
    token,
    maxTradeUsd,
    binding,
    constraints: sorted,
    priceUsd: args.priceUsd ?? null,
    maxBaseAmount,
    caveats,
    generatedAt: now.toISOString(),
  };
}

export function renderTradeSizing(r: TradeSizingReport): string {
  const lines: string[] = [];
  const dir = r.direction.toUpperCase();
  lines.push(`Trade sizing — ${dir}${r.token ? ` ${r.token}` : ""}${r.strategy ? ` · strategy ${r.strategy}` : ""} (account ${r.account}${r.chain ? ` × ${r.chain}` : ""})`);
  if (r.maxTradeUsd == null) {
    lines.push(`  Max trade: UNBOUNDED by policy — no USD-denominated limit applies.`);
  } else {
    lines.push(`  Max trade:  $${r.maxTradeUsd.toFixed(2)}${r.maxBaseAmount != null ? `  ≈ ${r.maxBaseAmount.toFixed(6)} base units @ $${r.priceUsd}` : ""}`);
    lines.push(`  Binding:    ${r.binding?.label ?? "—"} (${r.binding?.scope ?? ""}) — ${r.binding?.detail ?? ""}`);
  }
  if (r.constraints.length > 0) {
    lines.push(``);
    lines.push(`  Constraints (tightest first):`);
    for (const c of r.constraints) {
      const mark = c === r.binding ? "→" : " ";
      lines.push(`   ${mark} $${c.capUsd.toFixed(2).padStart(12)}  ${c.label} — ${c.detail}`);
    }
  }
  if (r.caveats.length > 0) {
    lines.push(``);
    for (const cv of r.caveats) lines.push(`  ⚠ ${cv}`);
  }
  return lines.join("\n");
}
