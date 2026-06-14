/**
 * v105: risk-based position sizing — "how much SHOULD I trade so that hitting
 * my stop loses only my risk budget?"
 *
 * The sizing module (v70, tradeSizing.ts) answers "how much CAN I trade before
 * a SAFETY limit rejects it" — the hard ceiling. This answers the orthogonal,
 * effectiveness question every disciplined trade faces: given a risk budget
 * (e.g. risk $50, or 1% of the book) and a stop distance (a -5% stop-loss, or
 * the 5% trail on the protect-on-entry trailing stop from v80), what position
 * size keeps the loss at the stop equal to the budget?
 *
 *   recommendedUsd = riskUsd / (stopDistancePct / 100)
 *
 * e.g. risk $50 with a 5% stop → $50 / 0.05 = $1000 (a 5% drop on $1000 = $50).
 *
 * The recommendation is then CLAMPED by the safety ceiling (gatherTradeSizing):
 * the safe path never exceeds what policy allows. The report shows both numbers
 * and which one bound the final size, so the agent sizes by risk AND stays
 * inside the envelope — the cornerstone discipline of not blowing up.
 *
 * Deterministic + offline (pure math + the existing sizing lookups, which are
 * injectable). The risk layer is ADVISORY — it never widens the safety ceiling,
 * only narrows the recommended size; maxTradeUsd keeps its "policy allows" meaning.
 */

import { gatherTradeSizing, type SizingConstraint } from "./tradeSizing.js";
import type { FillRowLite } from "./positionCaps.js";
import type { Config } from "./config.js";
import type { NextAction } from "./errors.js";

/** Pure: the position USD whose loss at the stop equals the risk budget.
 *  Returns null on a non-positive risk budget or stop distance (nothing to
 *  size). stopDistancePct is a percentage number (5 = 5%). */
export function recommendedRiskSize(args: { riskUsd: number; stopDistancePct: number }): number | null {
  if (!(args.riskUsd > 0) || !(args.stopDistancePct > 0)) return null;
  return args.riskUsd / (args.stopDistancePct / 100);
}

export type RiskSizeBoundBy = "risk_budget" | SizingConstraint["kind"];
export type StopSource = "stop_loss" | "trailing_stop";

export interface RiskSizeReport {
  account: string;
  chain: string | null;
  direction: "buy" | "sell";
  strategy: string | null;
  token: string | null;
  /** The resolved risk budget in USD (from riskUsd, or riskPct × portfolioUsd). */
  riskUsd: number;
  /** Stop distance as a percentage (5 = 5%). */
  stopDistancePct: number;
  stopSource: StopSource;
  /** riskUsd / (stopDistancePct/100) — the risk-disciplined size before clamping. */
  recommendedUsd: number;
  /** The safety ceiling from gatherTradeSizing (null = unbounded by policy). */
  ceilingUsd: number | null;
  ceilingBinding: SizingConstraint | null;
  /** min(recommendedUsd, ceilingUsd) — the size to actually trade. */
  finalUsd: number;
  /** What set finalUsd: the risk budget, or the binding safety constraint. */
  boundBy: RiskSizeBoundBy;
  priceUsd: number | null;
  /** finalUsd ÷ price. Null when no price. */
  baseAmount: number | null;
  /** v105.1: finalUsd ÷ quote-token USD price — the `quoteAmount` to pass to
   *  buy. Null when the quote price wasn't supplied. */
  finalQuoteAmount: number | null;
  /** Effective risk at finalUsd: finalUsd × stopDistancePct/100. ≤ riskUsd when
   *  the safety ceiling clamped the size (you're risking LESS than budgeted). */
  effectiveRiskUsd: number;
  /** v118: the reward:risk target (e.g. 2 = aim for 2× the risk). Null when not
   *  requested. */
  targetRMultiple: number | null;
  /** v118: take-profit % above entry for the target — targetRMultiple ×
   *  stopDistancePct (a 2R target on a 5% stop = +10%). Null unless a target was
   *  requested on a trailing-stop entry (the bracket the buy action attaches). */
  takeProfitPct: number | null;
  /** v105.1: the executable next step — a ready-to-run BUY for the sized amount
   *  with the protective stop attached (protectTrailPct = the stop distance when
   *  trailing). Turns advisory sizing into a one-call risk-disciplined entry.
   *  Empty for sells, or when no quote price was available to size the spend. */
  recommendedActions: NextAction[];
  caveats: string[];
  generatedAt: string;
}

export function gatherRiskSize(args: {
  direction: "buy" | "sell";
  /** Absolute risk budget, OR riskPct + portfolioUsd. */
  riskUsd?: number | null;
  riskPct?: number | null;
  portfolioUsd?: number | null;
  /** v118: reward:risk target. When set on a trailing-stop entry, the buy
   *  next-action also brackets a take-profit at targetRMultiple × stopDistance
   *  (a 2R target on a 5% stop = take-profit at +10%). */
  targetRMultiple?: number | null;
  /** Stop distance: an explicit stop-loss %, OR the trailing-stop trail %. */
  stopLossPct?: number | null;
  trailPct?: number | null;
  config?: Config;
  account?: string;
  chain?: string;
  strategy?: string | null;
  token?: string | null;
  priceUsd?: number | null;
  /** USD price of the QUOTE token — to convert finalUsd → the quoteAmount the
   *  buy tool spends. ~1 for stablecoin quotes. Null → no executable action. */
  quotePriceUsd?: number | null;
  /** Quote token symbol/address, for the buy next-action's `quote` param. */
  quote?: string | null;
  walletUsd?: number | null;
  now?: Date;
  // ── injection seams (tests) ──
  dailyVolumeFn?: (account: string, chain?: string) => number;
  spentLookup?: (tag: string, sinceIso?: string) => number;
  fillRowsLookup?: (tag: string, paper: boolean) => FillRowLite[];
}): RiskSizeReport {
  const caveats: string[] = [];

  // ── resolve the risk budget ──
  let riskUsd: number;
  if (args.riskUsd != null && args.riskUsd > 0) {
    riskUsd = args.riskUsd;
    if (args.riskPct != null) caveats.push("Both riskUsd and riskPct supplied — using the absolute riskUsd.");
  } else if (args.riskPct != null && args.riskPct > 0) {
    if (args.portfolioUsd == null || !(args.portfolioUsd > 0)) {
      throw new Error("riskPct needs a positive portfolioUsd to resolve to a dollar budget.");
    }
    riskUsd = args.portfolioUsd * (args.riskPct / 100);
  } else {
    throw new Error("Provide a positive riskUsd, or riskPct + portfolioUsd.");
  }

  // ── resolve the stop distance (explicit stop-loss wins; else the trail %) ──
  let stopDistancePct: number;
  let stopSource: StopSource;
  if (args.stopLossPct != null && args.stopLossPct > 0) {
    stopDistancePct = args.stopLossPct;
    stopSource = "stop_loss";
    if (args.trailPct != null) caveats.push("Both stopLossPct and trailPct supplied — using stopLossPct.");
  } else if (args.trailPct != null && args.trailPct > 0) {
    stopDistancePct = args.trailPct;
    stopSource = "trailing_stop";
  } else {
    throw new Error("Provide a positive stopLossPct, or trailPct (the trailing-stop distance).");
  }

  const recommendedUsd = recommendedRiskSize({ riskUsd, stopDistancePct })!;

  // ── the safety ceiling (reuse the v70 max-admissible computation) ──
  const sizing = gatherTradeSizing({
    direction: args.direction,
    config: args.config,
    account: args.account,
    chain: args.chain,
    strategy: args.strategy,
    token: args.token,
    priceUsd: args.priceUsd,
    walletUsd: args.walletUsd,
    now: args.now,
    dailyVolumeFn: args.dailyVolumeFn,
    spentLookup: args.spentLookup,
    fillRowsLookup: args.fillRowsLookup,
  });
  const ceilingUsd = sizing.maxTradeUsd;

  // ── clamp: the safe path never exceeds policy ──
  let finalUsd = recommendedUsd;
  let boundBy: RiskSizeBoundBy = "risk_budget";
  if (ceilingUsd != null && ceilingUsd < recommendedUsd) {
    finalUsd = ceilingUsd;
    boundBy = sizing.binding?.kind ?? "risk_budget";
    caveats.push(
      `Risk budget suggests $${recommendedUsd.toFixed(2)}, but the ${sizing.binding?.label ?? "safety limit"} caps the trade at $${ceilingUsd.toFixed(2)} — sizing down (you'll risk less than $${riskUsd.toFixed(2)}).`,
    );
  }

  const priceUsd = sizing.priceUsd;
  const baseAmount = priceUsd != null && priceUsd > 0 ? finalUsd / priceUsd : null;
  if (baseAmount == null) caveats.push("No base-token price — finalUsd is not converted to a token amount.");

  // ── v118: reward target — a take-profit at targetRMultiple × the risk distance
  // (bracketed with the stop). Only meaningful on a trailing-stop entry (the
  // bracket the buy attaches); for an explicit stop-loss source it's advisory.
  const targetRMultiple = args.targetRMultiple != null && args.targetRMultiple > 0 ? args.targetRMultiple : null;
  const takeProfitPct = targetRMultiple != null && stopSource === "trailing_stop" ? targetRMultiple * stopDistancePct : null;
  if (targetRMultiple != null && stopSource !== "trailing_stop") {
    caveats.push("targetRMultiple needs a trailing-stop entry (trailPct) to auto-bracket the take-profit — set the stop via trailPct.");
  }

  // ── the executable entry: BUY the sized amount, protected by the stop ──
  const finalQuoteAmount = args.quotePriceUsd != null && args.quotePriceUsd > 0 ? finalUsd / args.quotePriceUsd : null;
  const recommendedActions: NextAction[] = [];
  if (args.direction === "buy" && finalQuoteAmount != null && finalQuoteAmount > 0 && args.token) {
    const params: Record<string, unknown> = {
      base: args.token,
      quoteAmount: finalQuoteAmount.toFixed(6),
    };
    if (args.quote) params.quote = args.quote;
    if (args.strategy) params.strategy = args.strategy;
    // The trail % IS the stop distance — attach the protective stop that the
    // sizing assumed, so the realized risk matches the budget.
    if (stopSource === "trailing_stop") params.protectTrailPct = stopDistancePct;
    // v118: bracket the take-profit at the reward target → a one-call,
    // fully risk-disciplined entry (size by R, stop at 1R, take-profit at N-R).
    if (takeProfitPct != null) params.takeProfitPct = takeProfitPct;
    recommendedActions.push({
      tool: "buy",
      params,
      reason:
        `Risk-disciplined entry: spend ~$${finalUsd.toFixed(2)} (quoteAmount ${finalQuoteAmount.toFixed(6)})` +
        (stopSource === "trailing_stop"
          ? ` and attach the ${stopDistancePct}% trailing stop the sizing assumed`
          : ` — attach your ${stopDistancePct}% stop so the realized risk matches the $${riskUsd.toFixed(2)} budget`) +
        (takeProfitPct != null
          ? ` + a take-profit at +${takeProfitPct}% (${targetRMultiple}R target) — an OCO bracket`
          : "") +
        `. Preflight first if unsure.`,
    });
  } else if (args.direction === "buy" && args.quotePriceUsd == null) {
    caveats.push("No quote-token price supplied — finalUsd not converted to a quoteAmount, so no executable buy action.");
  }
  caveats.push("Risk sizing is advisory; preflight the chosen size before dispatching (preflight_trade).");

  return {
    account: sizing.account,
    chain: sizing.chain,
    direction: args.direction,
    strategy: args.strategy ?? null,
    token: args.token ?? null,
    riskUsd,
    stopDistancePct,
    stopSource,
    recommendedUsd,
    ceilingUsd,
    ceilingBinding: sizing.binding,
    finalUsd,
    boundBy,
    priceUsd,
    baseAmount,
    finalQuoteAmount,
    effectiveRiskUsd: finalUsd * (stopDistancePct / 100),
    targetRMultiple,
    takeProfitPct,
    recommendedActions,
    caveats,
    generatedAt: sizing.generatedAt,
  };
}

export function renderRiskSize(r: RiskSizeReport): string {
  const lines: string[] = [];
  lines.push(`Risk-based sizing — ${r.direction} ${r.token ?? "?"} (account:${r.account}${r.chain ? ` × ${r.chain}` : ""})`);
  lines.push("");
  lines.push(`  Risk budget:   $${r.riskUsd.toFixed(2)}`);
  lines.push(`  Stop distance: ${r.stopDistancePct.toFixed(2)}% (${r.stopSource === "trailing_stop" ? "trailing stop" : "stop-loss"})`);
  lines.push(`  Recommended:   $${r.recommendedUsd.toFixed(2)}  (risk ÷ stop distance)`);
  if (r.ceilingUsd != null) {
    lines.push(`  Safety ceiling: $${r.ceilingUsd.toFixed(2)}${r.ceilingBinding ? ` (${r.ceilingBinding.label})` : ""}`);
  } else {
    lines.push(`  Safety ceiling: none (unbounded by policy)`);
  }
  lines.push("");
  lines.push(
    `  → Trade $${r.finalUsd.toFixed(2)}${r.baseAmount != null ? ` ≈ ${r.baseAmount.toFixed(6)} ${r.token ?? "base"} @ $${r.priceUsd}` : ""}` +
      `  [bound by ${r.boundBy === "risk_budget" ? "risk budget" : r.ceilingBinding?.label ?? r.boundBy}]`,
  );
  lines.push(`    effective risk at stop: $${r.effectiveRiskUsd.toFixed(2)}`);
  if (r.takeProfitPct != null) {
    lines.push(`    take-profit target: +${r.takeProfitPct}% (${r.targetRMultiple}R) — bracketed OCO with the stop`);
  }
  if (r.recommendedActions.length > 0) {
    // Translate the agent-facing buy params to the CLI's flag names
    // (--quoteAmount / --protect-trail / --take-profit-pct), so it runs as-is.
    const p = r.recommendedActions[0].params ?? {};
    lines.push("");
    lines.push(
      `  Entry: tradekit trade buy --base ${p.base ?? r.token}${p.quote ? ` --quote ${p.quote}` : ""}` +
        ` --quoteAmount ${p.quoteAmount}${p.protectTrailPct != null ? ` --protect-trail ${p.protectTrailPct}` : ""}` +
        `${p.takeProfitPct != null ? ` --take-profit-pct ${p.takeProfitPct}` : ""}`,
    );
  }
  for (const c of r.caveats) lines.push(`    · ${c}`);
  return lines.join("\n");
}
