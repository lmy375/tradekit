/**
 * Promote readiness check (v49) — "is this paper strategy ready for
 * real money?"
 *
 * The session's analytics investments each answer a piece of that
 * question — v48 paper equity risk (drawdown/sharpe of the virtual
 * book), v44 execution quality (what YOUR real fills actually cost),
 * v40 cost realism (paper slippage is an assumption, not a
 * measurement) — but the operator had to assemble them by hand at
 * exactly the moment money goes on the line. This module composes
 * them into one verdict.
 *
 * The key cross-check is FRICTION REALITY: paper fills record the
 * slippage they ASSUMED (paper_trades.slippage_bps); your real
 * trades record what fills actually COST (realized_slippage_bps +
 * gas). Projecting the real numbers onto the paper run's observed
 * cadence answers "does the paper PnL survive real-world friction?"
 * — the single most common way a promoted strategy disappoints.
 *
 * Deterministic + offline except one optional native-price lookup
 * (injected seam; null degrades gracefully). Verdict thresholds are
 * deliberately simple, documented constants — evidence floors, not
 * vibes.
 */

import { ToolError } from "./errors.js";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import {
  getPlaybookById,
  listPaperTrades,
  recentSlippageStats,
  recentGasStats,
  type PaperTradeRow,
} from "./db.js";

/** Evidence floors: below these the verdict is not_ready outright. */
export const MIN_RUNTIME_DAYS = 7;
export const MIN_FILLS = 5;
/** Caution thresholds. */
export const MAX_DRAWDOWN_CAUTION_PCT = 30;
export const FRICTION_SHARE_CAUTION_PCT = 50;

export type PromoteVerdict = "ready" | "caution" | "not_ready";

export interface PromoteCheckReport {
  playbookId: number;
  name: string;
  tag: string;
  chain: string | null;
  account: string | null;
  generatedAt: string;
  runtime: {
    deployedAt: string;
    days: number;
    fills: number;
    lastFillAt: string | null;
    fillsPerWeek: number;
  };
  performance: {
    realizedQuote: number;
    unrealizedQuote: number;
    totalQuote: number;
    /** Paper PnL scaled to a 30-day month at the observed runtime. */
    monthlyPnlUsd: number;
  } | null;
  risk: {
    scope: string;
    maxDrawdownPct: number;
    maxDrawdownUsd: number;
    volatilityPctAnnual: number | null;
    sharpe: number | null;
    /** The paper equity scope is the whole virtual BOOK for the
     *  account — not isolated to this strategy. Disclosed, not
     *  hidden. */
    bookLevel: true;
  } | null;
  frictionReality: {
    paperAssumedMedianBps: number | null;
    realMedianBps: number | null;
    realSlippageSamples: number;
    realAvgGasNative: number | null;
    realGasUsdPerFill: number | null;
    avgFillUsd: number | null;
    /** fills/month × (real slippage on the avg fill + real gas). */
    projectedMonthlyFrictionUsd: number | null;
    /** Friction as % of the paper run's monthly PnL (null when PnL ≤ 0
     *  or friction unknown). */
    frictionShareOfPnlPct: number | null;
  };
  verdict: PromoteVerdict;
  reasons: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function gatherPromoteCheck(args: {
  playbookId: number;
  config?: Config;
  /** Test seam: current USD price of the chain's native token —
   *  used only to express real gas in USD. Null degrades to
   *  native-only reporting. */
  nativeUsd?: number | null;
  now?: Date;
}): Promise<PromoteCheckReport> {
  const config = args.config ?? loadConfig();
  const now = args.now ?? new Date();
  const row = getPlaybookById(args.playbookId);
  if (!row) throw new ToolError("INVALID_PARAMS", `No playbook #${args.playbookId}.`);
  const spec = JSON.parse(row.spec_json) as { chain?: string; account?: string };
  const tag = `playbook:${args.playbookId}`;
  const chain = spec.chain ?? config.activeChain ?? null;
  const account = spec.account ?? "default";

  // ── runtime evidence ──
  const fills: PaperTradeRow[] = listPaperTrades({ strategy: tag, limit: 10_000 });
  const days = Math.max(0, (now.getTime() - Date.parse(row.deployed_at)) / 86_400_000);
  const lastFillAt = fills.length > 0 ? fills.map((f) => f.timestamp).sort().at(-1)! : null;
  const fillsPerWeek = days > 0 ? (fills.length / days) * 7 : 0;

  // ── performance (realized + MTM via the established walker) ──
  let performance: PromoteCheckReport["performance"] = null;
  if (fills.length > 0) {
    const { computePaperPnlMtm, defaultPaperPriceFetcher } = await import("./paperPnl.js");
    const { createSilentLogger } = await import("./logger.js");
    const mtm = await computePaperPnlMtm(fills, defaultPaperPriceFetcher(config, createSilentLogger()), {
      nowIso: now.toISOString(),
    });
    const bucket = mtm.summaries.find((s) => s.strategy === tag) ?? mtm.summaries[0];
    if (bucket) {
      const realized = bucket.realizedQuote;
      const unrealized = bucket.unrealizedQuote ?? 0;
      const total = bucket.totalQuote;
      performance = {
        realizedQuote: realized,
        unrealizedQuote: unrealized,
        totalQuote: total,
        monthlyPnlUsd: days > 0 ? (total / days) * 30 : 0,
      };
    }
  }

  // ── risk from the v48 paper equity scope (book-level) ──
  let risk: PromoteCheckReport["risk"] = null;
  {
    const { buildEquityCurve } = await import("./equity.js");
    const scope = `paper:${account}`;
    const curve = buildEquityCurve({ accountsKey: scope, chainsKey: chain ?? undefined });
    if (curve.risk != null && curve.points.length >= 3) {
      risk = {
        scope: `${scope} × ${curve.chainsKey}`,
        maxDrawdownPct: curve.risk.maxDrawdownPct,
        maxDrawdownUsd: curve.risk.maxDrawdownUsd,
        volatilityPctAnnual: curve.risk.volatilityPctAnnual,
        sharpe: curve.risk.sharpe,
        bookLevel: true,
      };
    }
  }

  // ── friction reality: paper ASSUMPTIONS vs your REAL fills ──
  const paperAssumedMedianBps = median(
    fills.map((f) => f.slippage_bps).filter((v): v is number => v != null && Number.isFinite(v)),
  );
  const slip = chain ? recentSlippageStats(chain) : null;
  const gas = chain ? recentGasStats(chain, null) : null;
  const nativeUsd = args.nativeUsd ?? null;
  const realGasUsdPerFill = gas != null && nativeUsd != null && nativeUsd > 0 ? gas.avgGasNative * nativeUsd : null;
  const fillUsds = fills
    .map((f) => parseFloat(f.quote_amount))
    .filter((v) => Number.isFinite(v) && v > 0);
  const avgFillUsd = fillUsds.length > 0 ? fillUsds.reduce((s, v) => s + v, 0) / fillUsds.length : null;
  const fillsPerMonth = days > 0 ? (fills.length / days) * 30 : 0;
  let projectedMonthlyFrictionUsd: number | null = null;
  if (avgFillUsd != null && (slip != null || realGasUsdPerFill != null)) {
    const slipUsd = slip != null ? (slip.avgAbsSlippageBps / 10_000) * avgFillUsd : 0;
    projectedMonthlyFrictionUsd = fillsPerMonth * (slipUsd + (realGasUsdPerFill ?? 0));
  }
  const frictionShareOfPnlPct =
    projectedMonthlyFrictionUsd != null && performance != null && performance.monthlyPnlUsd > 0
      ? (projectedMonthlyFrictionUsd / performance.monthlyPnlUsd) * 100
      : null;

  // ── verdict (evidence floors → hard not_ready; quality flags → caution) ──
  const reasons: string[] = [];
  let verdict: PromoteVerdict = "ready";
  const flag = (level: Exclude<PromoteVerdict, "ready">, reason: string) => {
    reasons.push(reason);
    if (level === "not_ready" || verdict === "not_ready") verdict = "not_ready";
    else verdict = "caution";
  };

  if (days < MIN_RUNTIME_DAYS) {
    flag("not_ready", `paper runtime ${days.toFixed(1)}d < ${MIN_RUNTIME_DAYS}d minimum — not enough market regimes sampled`);
  }
  if (fills.length < MIN_FILLS) {
    flag("not_ready", `${fills.length} paper fill(s) < ${MIN_FILLS} minimum — not enough execution evidence`);
  }
  if (performance != null && performance.totalQuote <= 0) {
    flag("caution", `paper PnL is ${performance.totalQuote.toFixed(2)} (realized+MTM) — promoting a losing strategy needs an explicit thesis`);
  }
  if (risk == null) {
    flag("caution", `no paper equity risk data — enable the snapshot worker (engine.workers.snapshot) or run \`tradekit portfolio snapshot --paper\` for a few days`);
  } else if (risk.maxDrawdownPct > MAX_DRAWDOWN_CAUTION_PCT) {
    flag("caution", `paper book max drawdown ${risk.maxDrawdownPct.toFixed(1)}% > ${MAX_DRAWDOWN_CAUTION_PCT}% — size the real deployment accordingly`);
  }
  if (frictionShareOfPnlPct != null && frictionShareOfPnlPct > FRICTION_SHARE_CAUTION_PCT) {
    flag("caution", `projected REAL friction eats ${frictionShareOfPnlPct.toFixed(0)}% of the paper monthly PnL (> ${FRICTION_SHARE_CAUTION_PCT}%) — the edge may not survive real execution`);
  }
  if (paperAssumedMedianBps != null && slip != null && paperAssumedMedianBps < slip.avgAbsSlippageBps) {
    flag("caution", `paper assumed ${paperAssumedMedianBps.toFixed(1)}bps slippage but your real fills on ${chain} average ${slip.avgAbsSlippageBps.toFixed(1)}bps — the paper run was optimistic`);
  }

  return {
    playbookId: args.playbookId,
    name: row.name,
    tag,
    chain,
    account,
    generatedAt: now.toISOString(),
    runtime: { deployedAt: row.deployed_at, days, fills: fills.length, lastFillAt, fillsPerWeek },
    performance,
    risk,
    frictionReality: {
      paperAssumedMedianBps,
      realMedianBps: slip?.avgAbsSlippageBps ?? null,
      realSlippageSamples: slip?.samples ?? 0,
      realAvgGasNative: gas?.avgGasNative ?? null,
      realGasUsdPerFill,
      avgFillUsd,
      projectedMonthlyFrictionUsd,
      frictionShareOfPnlPct,
    },
    verdict,
    reasons,
  };
}

/**
 * v96: the promote-gate half of the readiness check — mirrors
 * safetyPromoteBlocker / preflightBlocker. Returns a blocker message when the
 * strategy has NOT earned a real-money promotion, else null. Only the hard
 * EVIDENCE floors block (verdict === "not_ready": insufficient paper runtime /
 * fills) — `caution`-level quality flags (losing PnL, deep drawdown, friction
 * eating the edge) are judgment calls the operator owns, never a hard stop.
 * Used by `playbook promote --require-ready`.
 */
export function promoteReadinessBlocker(report: PromoteCheckReport): string | null {
  if (report.verdict !== "not_ready") return null;
  // The not_ready reasons ARE the evidence-floor failures (the flag() helper
  // only escalates to not_ready for the runtime/fills floors).
  return (
    `paper strategy #${report.playbookId} "${report.name}" is NOT READY for real money:\n` +
    report.reasons.map((r) => `  ✗ ${r}`).join("\n") +
    `\nLet it run on paper longer (or promote anyway without --require-ready).`
  );
}

// ── rendering ────────────────────────────────────────────────

export function renderPromoteCheck(r: PromoteCheckReport): string {
  const lines: string[] = [];
  const V = { ready: "✅ READY", caution: "⚠ CAUTION", not_ready: "⛔ NOT READY" }[r.verdict];
  lines.push(`Promote check — playbook #${r.playbookId} "${r.name}" (${r.tag})`);
  lines.push(``);
  lines.push(`  Verdict: ${V}`);
  for (const reason of r.reasons) lines.push(`    - ${reason}`);
  if (r.reasons.length === 0) lines.push(`    (no flags — evidence floors met, friction survivable, risk in band)`);
  lines.push(``);
  lines.push(`  Paper runtime:  ${r.runtime.days.toFixed(1)}d since ${r.runtime.deployedAt.slice(0, 10)} · ${r.runtime.fills} fills (${r.runtime.fillsPerWeek.toFixed(1)}/week)${r.runtime.lastFillAt ? ` · last ${r.runtime.lastFillAt.slice(0, 10)}` : ""}`);
  if (r.performance) {
    lines.push(`  Paper PnL:      realized ${r.performance.realizedQuote.toFixed(2)} + MTM ${r.performance.unrealizedQuote.toFixed(2)} = ${r.performance.totalQuote.toFixed(2)} quote (~$${r.performance.monthlyPnlUsd.toFixed(2)}/month at this cadence)`);
  }
  if (r.risk) {
    lines.push(`  Paper risk:     max DD −${r.risk.maxDrawdownPct.toFixed(1)}% (−$${r.risk.maxDrawdownUsd.toFixed(2)}) · vol ${r.risk.volatilityPctAnnual != null ? `${r.risk.volatilityPctAnnual.toFixed(1)}%/yr` : "—"} · sharpe ${r.risk.sharpe != null ? r.risk.sharpe.toFixed(2) : "—"}`);
    lines.push(`                  (scope ${r.risk.scope} — whole virtual book, not strategy-isolated)`);
  }
  const f = r.frictionReality;
  lines.push(`  Friction check: paper assumed ${f.paperAssumedMedianBps != null ? `${f.paperAssumedMedianBps.toFixed(1)}bps` : "—"} · your REAL fills ${f.realMedianBps != null ? `${f.realMedianBps.toFixed(1)}bps (${f.realSlippageSamples} samples)` : "no real history yet"}${f.realGasUsdPerFill != null ? ` · gas ~$${f.realGasUsdPerFill.toFixed(2)}/fill` : f.realAvgGasNative != null ? ` · gas ${f.realAvgGasNative.toPrecision(2)} native/fill` : ""}`);
  if (f.projectedMonthlyFrictionUsd != null) {
    lines.push(`                  projected real friction ~$${f.projectedMonthlyFrictionUsd.toFixed(2)}/month${f.frictionShareOfPnlPct != null ? ` = ${f.frictionShareOfPnlPct.toFixed(0)}% of paper PnL` : ""}`);
  }
  lines.push(``);
  lines.push(`  Promote:        tradekit playbook promote ${r.playbookId} --to real --require-funded`);
  lines.push(`                  (promote runs its own funding preflight — this check is the strategy-quality half)`);
  return lines.join("\n");
}
