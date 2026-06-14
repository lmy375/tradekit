/**
 * Risk posture (v78) — the single "is my book in danger RIGHT NOW?" answer.
 *
 * Iterations v53/v72/v76/v77 each added a runtime risk signal — exposure
 * headroom, portfolio concentration, unprotected positions, MEV exposure —
 * but they live in separate commands. An operator (or the agent itself) had no
 * ONE place that says "your risk is critical / elevated / ok" and ranks why.
 * This composes the existing signals into a single verdict + ranked concerns,
 * so a monitoring cron can page on `risk=critical` and an agent can halt when
 * its own book turns dangerous — one branchable signal instead of polling six.
 *
 * NOT a new detector: it adds no new analysis, only synthesis. Each component
 * comes from its existing gatherer (best-effort — a failed/absent component is
 * recorded in `checked`, never fabricated). The verdict combiner is pure.
 */

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { SafetyHeadroomReport } from "./safetyHeadroom.js";
import type { ConcentrationRisk } from "./portfolio.js";
import type { MevExposure } from "./mev.js";

export type RiskVerdict = "ok" | "elevated" | "critical";

export interface RiskConcern {
  severity: "critical" | "warn";
  /** Stable code an agent can branch on. */
  code: string;
  message: string;
  /** The signal this came from. */
  source: "headroom" | "concentration" | "protection" | "mev";
}

export interface ProtectionSummaryLite {
  totalValueUsd: number | null;
  totalUnprotectedValueUsd: number | null;
  unprotectedCount: number;
  partialCount: number;
}

export interface RiskPostureReport {
  verdict: RiskVerdict;
  /** Ranked worst-first (critical before warn). */
  concerns: RiskConcern[];
  /** Which component signals were available this run (honesty about coverage). */
  checked: string[];
  /** Component signals that couldn't be gathered (e.g. RPC failure). */
  skipped: string[];
  summary: string;
  generatedAt: string;
}

/** ≥ this fraction of the book unprotected (no stop) is an elevated concern. */
export const UNPROTECTED_ELEVATED_FRAC = 0.5;

/**
 * Pure: fold the component signals into one verdict + ranked concerns.
 * Each input is optional — a null component is simply not assessed.
 */
export function combineRiskPosture(inputs: {
  headroom?: SafetyHeadroomReport | null;
  concentration?: ConcentrationRisk | null;
  protection?: ProtectionSummaryLite | null;
  mev?: MevExposure | null;
  now?: Date;
}): RiskPostureReport {
  const concerns: RiskConcern[] = [];
  const checked: string[] = [];

  // ── exposure headroom: tripped/exhausted limits are can't-trade states ──
  if (inputs.headroom) {
    checked.push("headroom");
    for (const e of inputs.headroom.entries) {
      if (e.status === "tripped" || e.status === "exhausted") {
        concerns.push({
          severity: "critical",
          code: e.status === "tripped" ? "limit_tripped" : "limit_exhausted",
          message: `${e.label} ${e.status}: ${e.detail}`,
          source: "headroom",
        });
      } else if (e.status === "approaching") {
        concerns.push({
          severity: "warn",
          code: "limit_approaching",
          message: `${e.label} approaching its cap: ${e.detail}`,
          source: "headroom",
        });
      }
    }
  }

  // ── concentration: one token dominating the book ──
  if (inputs.concentration) {
    checked.push("concentration");
    if (inputs.concentration.verdict === "warn") {
      concerns.push({
        severity: "warn",
        code: "concentration_high",
        message: inputs.concentration.summary,
        source: "concentration",
      });
    }
  }

  // ── protection: value at risk with no downside exit ──
  if (inputs.protection) {
    checked.push("protection");
    const { totalValueUsd, totalUnprotectedValueUsd } = inputs.protection;
    if (totalUnprotectedValueUsd != null && totalUnprotectedValueUsd > 0) {
      const frac = totalValueUsd && totalValueUsd > 0 ? totalUnprotectedValueUsd / totalValueUsd : 1;
      if (frac >= UNPROTECTED_ELEVATED_FRAC) {
        concerns.push({
          severity: "warn",
          code: "unprotected_exposure",
          message:
            `$${totalUnprotectedValueUsd.toFixed(2)} (${(frac * 100).toFixed(0)}% of the book) has no downside protection` +
            ` across ${inputs.protection.unprotectedCount + inputs.protection.partialCount} position(s) — a crash has no automated exit.`,
          source: "protection",
        });
      }
    }
  }

  // ── MEV: execution-path leak on a public-mempool chain ──
  if (inputs.mev) {
    checked.push("mev");
    if (inputs.mev.exposed) {
      concerns.push({
        severity: "warn",
        code: "mev_exposed",
        message: inputs.mev.advisory,
        source: "mev",
      });
    }
  }

  // Rank: critical first, then warn; preserve insertion order within a tier.
  concerns.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));

  const verdict: RiskVerdict = concerns.some((c) => c.severity === "critical")
    ? "critical"
    : concerns.some((c) => c.severity === "warn")
      ? "elevated"
      : "ok";

  const critN = concerns.filter((c) => c.severity === "critical").length;
  const warnN = concerns.length - critN;
  const summary =
    checked.length === 0
      ? "No risk signals could be evaluated."
      : verdict === "ok"
        ? `Risk OK — no elevated or critical signals across ${checked.length} dimension(s).`
        : `Risk ${verdict.toUpperCase()} — ${critN} critical, ${warnN} elevated concern(s).`;

  return {
    verdict,
    concerns,
    checked,
    skipped: [],
    summary,
    generatedAt: (inputs.now ?? new Date()).toISOString(),
  };
}

/**
 * Gather every component (best-effort) and combine. Heavy bits (concentration
 * needs on-chain holdings; protection needs positions + marks) are wrapped so a
 * single RPC failure degrades that dimension into `skipped` rather than failing
 * the whole posture.
 */
export async function gatherRiskPosture(args: {
  config: Config;
  logger: Logger;
  account?: string;
  chain?: string;
  now?: Date;
}): Promise<RiskPostureReport> {
  const { config, logger } = args;
  const skipped: string[] = [];

  // Headroom — DB-only, cheap.
  let headroom: SafetyHeadroomReport | null = null;
  try {
    const { gatherSafetyHeadroom } = await import("./safetyHeadroom.js");
    headroom = gatherSafetyHeadroom({ config, account: args.account, chain: args.chain, now: args.now });
  } catch (e) {
    skipped.push("headroom");
    logger.debug(`risk: headroom skipped: ${(e as Error).message}`);
  }

  // Concentration — needs on-chain holdings.
  let concentration: ConcentrationRisk | null = null;
  try {
    const { aggregatePortfolio, resolveAccountsForPortfolio } = await import("./portfolio.js");
    const accounts = resolveAccountsForPortfolio(args.account ? [args.account] : undefined);
    const pf = await aggregatePortfolio({ accounts, config, logger, chains: args.chain ? [args.chain] : undefined });
    concentration = pf.concentrationRisk;
  } catch (e) {
    skipped.push("concentration");
    logger.debug(`risk: concentration skipped: ${(e as Error).message}`);
  }

  // Protection — needs open positions + marks.
  let protection: ProtectionSummaryLite | null = null;
  try {
    const { gatherPositionProtection } = await import("./positionProtection.js");
    const p = await gatherPositionProtection({ mode: "real", account: args.account, chain: args.chain, config });
    protection = {
      totalValueUsd: p.totalValueUsd,
      totalUnprotectedValueUsd: p.totalUnprotectedValueUsd,
      unprotectedCount: p.unprotectedCount,
      partialCount: p.partialCount,
    };
  } catch (e) {
    skipped.push("protection");
    logger.debug(`risk: protection skipped: ${(e as Error).message}`);
  }

  // MEV — pure config logic for the active chain.
  let mev: MevExposure | null = null;
  try {
    const { assessMevExposure } = await import("./mev.js");
    mev = assessMevExposure(args.chain ?? config.activeChain, config.mev);
  } catch (e) {
    skipped.push("mev");
    logger.debug(`risk: mev skipped: ${(e as Error).message}`);
  }

  const report = combineRiskPosture({ headroom, concentration, protection, mev, now: args.now });
  report.skipped = skipped;
  return report;
}

export function renderRiskPosture(r: RiskPostureReport): string {
  const lines: string[] = [];
  const badge = r.verdict === "critical" ? "🔴 CRITICAL" : r.verdict === "elevated" ? "🟡 ELEVATED" : "🟢 OK";
  lines.push(`Risk posture: ${badge}`);
  lines.push(`  ${r.summary}`);
  if (r.concerns.length > 0) {
    lines.push("");
    for (const c of r.concerns) {
      const mark = c.severity === "critical" ? "🔴" : "🟡";
      lines.push(`  ${mark} [${c.source}] ${c.message}`);
    }
  }
  lines.push("");
  lines.push(`  Checked: ${r.checked.join(", ") || "none"}${r.skipped.length ? ` · skipped: ${r.skipped.join(", ")}` : ""}`);
  return lines.join("\n");
}
