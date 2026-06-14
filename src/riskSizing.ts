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
  /** Effective risk at finalUsd: finalUsd × stopDistancePct/100. ≤ riskUsd when
   *  the safety ceiling clamped the size (you're risking LESS than budgeted). */
  effectiveRiskUsd: number;
  caveats: string[];
  generatedAt: string;
}

export function gatherRiskSize(args: {
  direction: "buy" | "sell";
  /** Absolute risk budget, OR riskPct + portfolioUsd. */
  riskUsd?: number | null;
  riskPct?: number | null;
  portfolioUsd?: number | null;
  /** Stop distance: an explicit stop-loss %, OR the trailing-stop trail %. */
  stopLossPct?: number | null;
  trailPct?: number | null;
  config?: Config;
  account?: string;
  chain?: string;
  strategy?: string | null;
  token?: string | null;
  priceUsd?: number | null;
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
    effectiveRiskUsd: finalUsd * (stopDistancePct / 100),
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
  for (const c of r.caveats) lines.push(`    · ${c}`);
  return lines.join("\n");
}
