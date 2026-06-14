/**
 * Promote outcome check (v50) — "did promoting this strategy deliver
 * what the paper run promised?"
 *
 * promoteCheck (v49) is the FORWARD half of the trust pipeline: is this
 * paper strategy ready for real money? This module closes the loop
 * BACKWARD. Once a strategy is promoted, the paper run's numbers were a
 * PROMISE — this compares them against what the live fills actually
 * delivered, so an operator (or agent) can catch the single most
 * dangerous outcome the whole pipeline exists to prevent: a strategy
 * that looked great on paper but quietly bleeds money live.
 *
 * The two eras already live in separate tables, tagged with the SAME
 * strategy tag: `paper_trades` is the frozen baseline that justified the
 * promote (promotion flips the primitives to real, so paper stops
 * accumulating), and `trades` holds the live fills since. Both run
 * through the SAME cost-basis walker (computePaperPnlMtm via toMtmRows)
 * so realized PnL is apples-to-apples.
 *
 * The comparison is NORMALIZED — per-fill PnL and per-week cadence — so
 * a 50-fill paper run and a 6-fill live run compare fairly instead of
 * the misleading raw totals.
 *
 * Deterministic + offline: the VERDICT keys off realized PnL (closed
 * round-trips, no oracle), real execution quality (the live fills'
 * own realized slippage + gas), and cadence — never off unrealized
 * marks. MTM totals are reported for context but never gate the
 * verdict. Thresholds are documented constants — evidence, not vibes.
 */

import { ToolError } from "./errors.js";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import {
  getPlaybookById,
  listPaperTrades,
  recentTrades,
  type PaperTradeRow,
  type TradeRow,
} from "./db.js";
import type { PaperPriceFetcher } from "./paperPnl.js";

/** Below this many live fills the run hasn't earned a verdict yet. */
export const MIN_REAL_FILLS = 3;
/** Real per-fill realized PnL below this share of paper's → underperforming. */
export const UNDERPERFORM_RATIO_PCT = 60;
/** Real cadence below this share of paper's (with enough live runtime) → flag. */
export const CADENCE_CAUTION_PCT = 50;
/** Min live runtime (days) before cadence divergence is trustworthy. */
export const CADENCE_MIN_REAL_DAYS = 2;
/** Real median slippage above this multiple of paper's assumption → flag. */
export const SLIPPAGE_DIVERGENCE_RATIO = 1.5;

export type OutcomeVerdict =
  | "on_track"
  | "underperforming"
  | "diverged"
  | "insufficient_data";

export interface OutcomeEra {
  fills: number;
  /** Span between first and last fill, in days. */
  spanDays: number;
  /** fills / spanDays × 7. Null when span is zero (single fill). */
  fillsPerWeek: number | null;
  firstFillAt: string | null;
  lastFillAt: string | null;
  /** Cost-basis realized PnL (quote ≈ USD), via the shared MTM walker. */
  realizedQuote: number;
  /** realized + unrealized MTM (context only; never gates the verdict). */
  totalQuote: number;
  /** realizedQuote / fills. */
  perFillRealizedQuote: number;
  /** Median fill notional in quote (≈ USD). Null when no priced fills. */
  avgFillUsd: number | null;
  /** Paper: median ASSUMED slippage. Real: median REALIZED slippage.
   *  Null when the era has no slippage data. */
  medianSlippageBps: number | null;
  /** Real only: avg gas per fill in native units; null for paper / no data. */
  avgGasNative: number | null;
  /** Real only: gas per fill in USD (needs nativeUsd). Null otherwise. */
  gasUsdPerFill: number | null;
}

export interface PromoteOutcomeReport {
  playbookId: number;
  name: string;
  tag: string;
  chain: string | null;
  account: string | null;
  generatedAt: string;
  /** The frozen paper baseline that justified the promote. Null when the
   *  strategy was never run on paper (nothing to compare against). */
  paper: OutcomeEra | null;
  /** The live run since promotion. Null when no real fills exist yet. */
  real: OutcomeEra | null;
  /** Normalized paper-vs-real deltas. Null when either era is missing. */
  comparison: {
    realizedPerFillDeltaQuote: number;
    /** real / paper × 100. Null when paper per-fill realized ≤ 0. */
    realizedPerFillRatioPct: number | null;
    /** real / paper × 100. Null when paper cadence unknown. */
    cadenceRatioPct: number | null;
    /** real median − paper assumed. Null when either unknown. */
    slippageDeltaBps: number | null;
    slippageRatioPct: number | null;
    /** True when the paper baseline actually realized PnL (had closing
     *  sells). When false, the PnL comparison is moot — verdict rests on
     *  execution quality + cadence and a reason says so. */
    hasRealizedSignal: boolean;
  } | null;
  verdict: OutcomeVerdict;
  reasons: string[];
  /** v98: the RESPONSE half — structured next-step(s) the operator/agent
   *  should take given the verdict, closing the trust pipeline's
   *  detect→respond loop. `diverged` → demote to paper NOW (halt the
   *  real-money bleed, state preserved); `underperforming` → consider
   *  demoting (a recoverable-or-cut judgment, so `yes` is intentionally
   *  NOT pre-filled — the agent must confirm consciously). on_track /
   *  insufficient_data carry none. */
  recommendedActions: import("./errors.js").NextAction[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const DAY_MS = 86_400_000;

/** Build an era summary from a set of fills already run through the
 *  cost-basis walker. `realizedQuote`/`totalQuote` come from the walker;
 *  the cadence + execution-quality fields come from the raw rows. */
function summarizeEra(args: {
  timestamps: string[];
  realizedQuote: number;
  totalQuote: number;
  fillUsds: number[];
  slippageBps: number[];
  gasNatives: number[];
  nativeUsd: number | null;
}): OutcomeEra {
  const fills = args.timestamps.length;
  const sorted = [...args.timestamps].sort();
  const firstFillAt = sorted[0] ?? null;
  const lastFillAt = sorted.at(-1) ?? null;
  const spanDays =
    firstFillAt && lastFillAt
      ? Math.max(0, (Date.parse(lastFillAt) - Date.parse(firstFillAt)) / DAY_MS)
      : 0;
  const fillsPerWeek = spanDays > 0 ? (fills / spanDays) * 7 : null;
  const avgGasNative =
    args.gasNatives.length > 0
      ? args.gasNatives.reduce((s, v) => s + v, 0) / args.gasNatives.length
      : null;
  return {
    fills,
    spanDays,
    fillsPerWeek,
    firstFillAt,
    lastFillAt,
    realizedQuote: args.realizedQuote,
    totalQuote: args.totalQuote,
    perFillRealizedQuote: fills > 0 ? args.realizedQuote / fills : 0,
    avgFillUsd: median(args.fillUsds),
    medianSlippageBps: median(args.slippageBps),
    avgGasNative,
    gasUsdPerFill:
      avgGasNative != null && args.nativeUsd != null && args.nativeUsd > 0
        ? avgGasNative * args.nativeUsd
        : null,
  };
}

export async function gatherPromoteOutcome(args: {
  playbookId: number;
  config?: Config;
  /** Test seam: current USD price of the chain's native token — used only
   *  to express real gas in USD. Null degrades to native-unit gas. */
  nativeUsd?: number | null;
  /** Test seam: mark-to-market price fetcher. Production injects
   *  defaultPaperPriceFetcher; null/omitted degrades MTM to realized-only
   *  (the verdict never depends on MTM regardless). */
  markPriceFn?: PaperPriceFetcher;
  now?: Date;
}): Promise<PromoteOutcomeReport> {
  const config = args.config ?? loadConfig();
  const now = args.now ?? new Date();
  const nativeUsd = args.nativeUsd ?? null;
  const row = getPlaybookById(args.playbookId);
  if (!row) throw new ToolError("INVALID_PARAMS", `No playbook #${args.playbookId}.`);
  const spec = JSON.parse(row.spec_json) as { chain?: string; account?: string };
  const tag = `playbook:${args.playbookId}`;
  const chain = spec.chain ?? config.activeChain ?? null;
  const account = spec.account ?? "default";

  const { computePaperPnlMtm } = await import("./paperPnl.js");
  const { toMtmRows } = await import("./strategyReport.js");
  // The default fetcher opens a logger (file IO); only build it when the
  // caller hasn't injected one, so tests stay pure and offline.
  let fetchPrice: PaperPriceFetcher;
  if (args.markPriceFn) {
    fetchPrice = args.markPriceFn;
  } else {
    const { defaultPaperPriceFetcher } = await import("./paperPnl.js");
    const { createSilentLogger } = await import("./logger.js");
    fetchPrice = defaultPaperPriceFetcher(config, createSilentLogger());
  }

  // ── the two eras, same walker ──
  const paperFills: PaperTradeRow[] = listPaperTrades({ strategy: tag, limit: 50_000 });
  const realRows: TradeRow[] = recentTrades({ strategy: tag, limit: 50_000 });
  const realFills = realRows.filter((t) => t.status === "success");

  async function walkRealized(rows: PaperTradeRow[]): Promise<{ realized: number; total: number }> {
    if (rows.length === 0) return { realized: 0, total: 0 };
    const mtm = await computePaperPnlMtm(rows, fetchPrice, { nowIso: now.toISOString() });
    const bucket = mtm.summaries.find((s) => s.strategy === tag) ?? mtm.summaries[0];
    if (!bucket) return { realized: 0, total: 0 };
    return { realized: bucket.realizedQuote, total: bucket.totalQuote };
  }

  let paper: OutcomeEra | null = null;
  if (paperFills.length > 0) {
    const { realized, total } = await walkRealized(paperFills);
    paper = summarizeEra({
      timestamps: paperFills.map((f) => f.timestamp),
      realizedQuote: realized,
      totalQuote: total,
      fillUsds: paperFills.map((f) => parseFloat(f.quote_amount)).filter((v) => Number.isFinite(v) && v > 0),
      slippageBps: paperFills
        .map((f) => f.slippage_bps)
        .filter((v): v is number => v != null && Number.isFinite(v)),
      gasNatives: [],
      nativeUsd,
    });
  }

  let real: OutcomeEra | null = null;
  if (realFills.length > 0) {
    const { realized, total } = await walkRealized(toMtmRows(realFills));
    real = summarizeEra({
      timestamps: realFills.map((f) => f.timestamp),
      realizedQuote: realized,
      totalQuote: total,
      fillUsds: realFills.map((f) => parseFloat(f.quote_amount)).filter((v) => Number.isFinite(v) && v > 0),
      // Real fills record what slippage ACTUALLY cost (abs — direction-
      // agnostic magnitude, same convention as recentSlippageStats).
      slippageBps: realFills
        .map((f) => f.realized_slippage_bps)
        .filter((v): v is number => v != null && Number.isFinite(v))
        .map((v) => Math.abs(v)),
      gasNatives: realFills
        .map((f) => (f.gas_cost_native != null ? parseFloat(f.gas_cost_native) : NaN))
        .filter((v) => Number.isFinite(v) && v >= 0),
      nativeUsd,
    });
  }

  // ── comparison (normalized) ──
  let comparison: PromoteOutcomeReport["comparison"] = null;
  if (paper != null && real != null) {
    const hasRealizedSignal = paper.perFillRealizedQuote > 0;
    const realizedPerFillRatioPct = hasRealizedSignal
      ? (real.perFillRealizedQuote / paper.perFillRealizedQuote) * 100
      : null;
    const cadenceRatioPct =
      paper.fillsPerWeek != null && paper.fillsPerWeek > 0 && real.fillsPerWeek != null
        ? (real.fillsPerWeek / paper.fillsPerWeek) * 100
        : null;
    const slippageDeltaBps =
      paper.medianSlippageBps != null && real.medianSlippageBps != null
        ? real.medianSlippageBps - paper.medianSlippageBps
        : null;
    const slippageRatioPct =
      paper.medianSlippageBps != null && paper.medianSlippageBps > 0 && real.medianSlippageBps != null
        ? (real.medianSlippageBps / paper.medianSlippageBps) * 100
        : null;
    comparison = {
      realizedPerFillDeltaQuote: real.perFillRealizedQuote - paper.perFillRealizedQuote,
      realizedPerFillRatioPct,
      cadenceRatioPct,
      slippageDeltaBps,
      slippageRatioPct,
      hasRealizedSignal,
    };
  }

  // ── verdict ──
  const reasons: string[] = [];
  let verdict: OutcomeVerdict = "on_track";
  const escalate = (level: Exclude<OutcomeVerdict, "on_track" | "insufficient_data">, reason: string) => {
    reasons.push(reason);
    // diverged is the worst non-terminal verdict; underperforming never
    // downgrades an existing diverged.
    if (level === "diverged" || verdict === "diverged") verdict = "diverged";
    else verdict = "underperforming";
  };

  if (real == null) {
    return finalize("insufficient_data", [
      `no live fills yet — this strategy has not traded with real money (promote it, or wait for the first live fill before judging the outcome)`,
    ]);
  }
  if (real.fills < MIN_REAL_FILLS) {
    return finalize("insufficient_data", [
      `only ${real.fills} live fill(s) < ${MIN_REAL_FILLS} minimum — too early to judge; re-check after more live execution`,
    ]);
  }
  if (paper == null) {
    return finalize("insufficient_data", [
      `no paper baseline — this strategy was never run on paper, so there is nothing to compare the live run against (the promote skipped the dry-run loop)`,
    ]);
  }

  const c = comparison!;
  if (c.hasRealizedSignal) {
    if (real.perFillRealizedQuote <= 0) {
      escalate(
        "diverged",
        `paper realized $${paper.perFillRealizedQuote.toFixed(2)}/fill but live fills realize $${real.perFillRealizedQuote.toFixed(2)}/fill (≤ 0) — the strategy is not making money with real execution`,
      );
    } else if (c.realizedPerFillRatioPct != null && c.realizedPerFillRatioPct < UNDERPERFORM_RATIO_PCT) {
      escalate(
        "underperforming",
        `live realized PnL is ${c.realizedPerFillRatioPct.toFixed(0)}% of the paper per-fill expectation (< ${UNDERPERFORM_RATIO_PCT}%) — the edge shrank in production ($${real.perFillRealizedQuote.toFixed(2)}/fill vs paper $${paper.perFillRealizedQuote.toFixed(2)}/fill)`,
      );
    }
  } else {
    reasons.push(
      `paper baseline never closed a position (no realized round-trips) — PnL comparison is pending position closes; this verdict rests on execution quality + cadence`,
    );
  }

  if (
    c.slippageRatioPct != null &&
    c.slippageRatioPct > SLIPPAGE_DIVERGENCE_RATIO * 100 &&
    real.medianSlippageBps != null &&
    paper.medianSlippageBps != null
  ) {
    escalate(
      "underperforming",
      `live slippage ${real.medianSlippageBps.toFixed(1)}bps is ${(c.slippageRatioPct / 100).toFixed(1)}× the paper-assumed ${paper.medianSlippageBps.toFixed(1)}bps — execution is materially worse than the paper run modeled`,
    );
  }

  if (
    c.cadenceRatioPct != null &&
    c.cadenceRatioPct < CADENCE_CAUTION_PCT &&
    real.spanDays >= CADENCE_MIN_REAL_DAYS
  ) {
    escalate(
      "underperforming",
      `live cadence ${real.fillsPerWeek?.toFixed(1)}/week is ${c.cadenceRatioPct.toFixed(0)}% of the paper ${paper.fillsPerWeek?.toFixed(1)}/week — the strategy is firing less live than on paper, so the projected returns won't materialize`,
    );
  }

  return finalize(verdict, reasons);

  function finalize(v: OutcomeVerdict, rs: string[]): PromoteOutcomeReport {
    return {
      playbookId: args.playbookId,
      name: row!.name,
      tag,
      chain,
      account,
      generatedAt: now.toISOString(),
      paper,
      real,
      comparison,
      verdict: v,
      reasons: rs,
      recommendedActions: recommendedActionsFor(v, args.playbookId, row!.name),
    };
  }
}

/** v98: map an outcome verdict to the protective RESPONSE. The demote
 *  target is `playbook_promote to=paper` — it halts real-money trades while
 *  PRESERVING strategy state (HWM, run counters, drift telemetry), so the
 *  strategy can be observed further or re-promoted after the cause is fixed.
 *  diverged pre-fills `yes` (the bleed is active — make the protective stop
 *  frictionless); underperforming does NOT (recoverable-or-cut is a judgment
 *  the operator/agent owns). */
function recommendedActionsFor(
  v: OutcomeVerdict,
  playbookId: number,
  name: string,
): import("./errors.js").NextAction[] {
  if (v === "diverged") {
    return [
      {
        tool: "playbook_promote",
        params: { id: playbookId, to: "paper", yes: true },
        reason: `DIVERGED — "${name}" is losing money with real execution against a paper baseline that promised profit. Demote to paper NOW to halt real-money trades; strategy state (HWM, counters) is preserved, so you can keep observing or re-promote after fixing the cause.`,
      },
    ];
  }
  if (v === "underperforming") {
    return [
      {
        tool: "playbook_promote",
        params: { id: playbookId, to: "paper" },
        reason: `UNDERPERFORMING — "${name}"'s live edge fell short of its paper promise. Decide whether the edge is recoverable or the strategy should be demoted (re-run with yes:true to flip it back to paper). Pair with playbook_promote_outcome for the per-fill/slippage/cadence breakdown.`,
      },
    ];
  }
  return [];
}

// ── rendering ────────────────────────────────────────────────

export function renderPromoteOutcome(r: PromoteOutcomeReport): string {
  const lines: string[] = [];
  const V = {
    on_track: "✅ ON TRACK",
    underperforming: "⚠ UNDERPERFORMING",
    diverged: "⛔ DIVERGED",
    insufficient_data: "· INSUFFICIENT DATA",
  }[r.verdict];
  lines.push(`Promote outcome — playbook #${r.playbookId} "${r.name}" (${r.tag})`);
  lines.push(``);
  lines.push(`  Verdict: ${V}`);
  for (const reason of r.reasons) lines.push(`    - ${reason}`);
  if (r.reasons.length === 0) {
    lines.push(`    (live realized PnL, execution quality, and cadence all track the paper baseline)`);
  }
  lines.push(``);

  const era = (label: string, e: OutcomeEra | null) => {
    if (e == null) {
      lines.push(`  ${label.padEnd(7)} —  (no fills)`);
      return;
    }
    const cadence = e.fillsPerWeek != null ? `${e.fillsPerWeek.toFixed(1)}/week` : "—";
    lines.push(
      `  ${label.padEnd(7)} ${e.fills} fills · ${cadence} · realized $${e.realizedQuote.toFixed(2)} ($${e.perFillRealizedQuote.toFixed(2)}/fill)`,
    );
    const slip = e.medianSlippageBps != null ? `${e.medianSlippageBps.toFixed(1)}bps` : "—";
    const gas = e.gasUsdPerFill != null ? ` · gas $${e.gasUsdPerFill.toFixed(2)}/fill` : e.avgGasNative != null ? ` · gas ${e.avgGasNative.toPrecision(2)} native/fill` : "";
    lines.push(`          ${label === "Paper" ? "assumed" : "real"} slippage ${slip}${gas}${e.avgFillUsd != null ? ` · ~$${e.avgFillUsd.toFixed(0)}/fill notional` : ""}`);
  };
  era("Paper", r.paper);
  era("Real", r.real);

  if (r.comparison) {
    lines.push(``);
    const c = r.comparison;
    if (c.realizedPerFillRatioPct != null) {
      lines.push(`  Per-fill realized: live is ${c.realizedPerFillRatioPct.toFixed(0)}% of paper (Δ $${c.realizedPerFillDeltaQuote.toFixed(2)}/fill)`);
    }
    if (c.cadenceRatioPct != null) {
      lines.push(`  Cadence:           live is ${c.cadenceRatioPct.toFixed(0)}% of paper`);
    }
    if (c.slippageRatioPct != null) {
      lines.push(`  Slippage:          live is ${(c.slippageRatioPct / 100).toFixed(1)}× paper-assumed`);
    }
  }
  // v98: the RESPONSE — what to do about this verdict.
  if (r.recommendedActions.length > 0) {
    lines.push(``);
    lines.push(`  Recommended:`);
    for (const a of r.recommendedActions) {
      // Translate the agent-facing tool call to the operator's CLI form.
      const cli =
        a.tool === "playbook_promote" && a.params?.to === "paper"
          ? `tradekit playbook promote ${a.params.id} --to paper${a.params.yes ? " --yes" : ""}`
          : a.tool;
      lines.push(`    → ${cli}`);
      lines.push(`      ${a.reason}`);
    }
  }
  return lines.join("\n");
}
