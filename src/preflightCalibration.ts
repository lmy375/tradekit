/**
 * Preflight calibration (v75) — "are the preflight verdicts actually
 * predictive, or just noise?"
 *
 * v74 made the agent's DECISIONS visible (the preflight journal — every
 * go/caution/no_go verdict, including refused trades). This closes the loop:
 * it correlates each recorded decision to the trade that followed and reports,
 * per verdict, how those trades actually turned out (fill rate, realized
 * slippage, failures). That's the operator's deepest trust question — not "what
 * did the agent decide" but "was the agent's judgment GOOD". If 'go' trades
 * fill cleanly while 'caution' trades slip badly / fail more, the preflight
 * system is well-calibrated and the agent's discipline is meaningful; if the
 * outcomes are indistinguishable, the signal is noise.
 *
 * Correlation is by proximity (same chain/account/pair/direction, the nearest
 * trade within a window AFTER the decision), greedy + one-trade-per-run — a
 * heuristic, clearly labelled, since decisions and trades aren't hard-linked.
 * For an AGGREGATE calibration read, occasional mismatches wash out.
 *
 * Pure correlation core (no IO) + a thin DB-backed gatherer.
 */

import { listPreflightRuns, recentTrades } from "./db.js";

export interface PreflightLite {
  id: number;
  timestamp: string;
  chain: string;
  account: string | null;
  direction: string;
  baseSymbol: string | null;
  verdict: string;
  /** v94: the warn/critical reason codes this run carried (e.g.
   *  "market_timing_caution", "concentration_high"). Drives per-signal
   *  calibration — does a signal actually predict worse outcomes? Optional so
   *  pre-v94 callers stay valid. */
  codes?: string[];
}

export interface TradeLite {
  timestamp: string;
  chain: string;
  account: string;
  direction: string;
  baseSymbol: string | null;
  status: string;
  realizedSlippageBps: number | null;
}

export interface VerdictOutcome {
  verdict: string;
  /** Preflight runs with this verdict in the window. */
  runs: number;
  /** Runs that correlated to a subsequent trade. */
  matched: number;
  filled: number;
  failed: number;
  pending: number;
  /** Median realized slippage (bps) of the filled correlated trades. */
  medianSlippageBps: number | null;
}

export interface SignalOutcome {
  /** The warn/critical preflight reason code, e.g. "market_timing_caution". */
  code: string;
  /** Matched runs (correlated to a trade) that carried this signal. */
  matched: number;
  filled: number;
  medianSlippageBps: number | null;
  /** signal median − the all-filled baseline median (positive = the signal's
   *  trades slip WORSE, i.e. the signal is predictive). Null when unmeasurable. */
  vsBaselineBps: number | null;
  /** true = predictive (worse than baseline by a margin, enough samples);
   *  false = not separating outcomes (possible noise); null = too few samples. */
  predictive: boolean | null;
}

export interface PreflightCalibrationReport {
  windowMinutes: number;
  totalRuns: number;
  totalMatched: number;
  byVerdict: VerdictOutcome[];
  /** v94: per-signal calibration — does each caution-type signal predict worse
   *  outcomes? Ranked by vsBaselineBps desc (most-predictive first). */
  bySignal: SignalOutcome[];
  /** Plain-language read of whether the verdicts separate outcomes. */
  summary: string;
  generatedAt: string;
}

/** Min filled samples before a signal's predictiveness is judged (else null). */
const SIGNAL_MIN_SAMPLES = 3;
/** A signal's trades must slip ≥ this many bps worse than baseline to count as predictive. */
const SIGNAL_PREDICTIVE_MARGIN_BPS = 5;

/**
 * Pure: from the run↔trade matches, measure whether each warn/critical SIGNAL
 * (reason code a run carried) predicts worse execution than the overall filled
 * baseline. Reuses the v75 correlation; the per-signal lens is the v94 add — it
 * validates which of the accreted pre-trade signals (timing, concentration,
 * MEV, …) actually earn their keep vs. fire as noise.
 */
export function aggregateSignalOutcomes(
  matches: ReadonlyArray<{ run: PreflightLite; trade: TradeLite | null }>,
): SignalOutcome[] {
  // Baseline: median slippage across ALL filled correlated trades.
  const baseSlips: number[] = [];
  for (const m of matches) {
    if (m.trade?.status === "success" && m.trade.realizedSlippageBps != null && Number.isFinite(m.trade.realizedSlippageBps)) {
      baseSlips.push(m.trade.realizedSlippageBps);
    }
  }
  const baseline = median(baseSlips);

  const acc = new Map<string, { matched: number; filled: number; slips: number[] }>();
  for (const m of matches) {
    if (!m.trade) continue;
    for (const code of m.run.codes ?? []) {
      const e = acc.get(code) ?? { matched: 0, filled: 0, slips: [] };
      e.matched += 1;
      if (m.trade.status === "success") {
        e.filled += 1;
        if (m.trade.realizedSlippageBps != null && Number.isFinite(m.trade.realizedSlippageBps)) e.slips.push(m.trade.realizedSlippageBps);
      }
      acc.set(code, e);
    }
  }

  return [...acc.entries()]
    .map(([code, e]) => {
      const med = median(e.slips);
      const vsBaselineBps = med != null && baseline != null ? med - baseline : null;
      const predictive =
        e.filled < SIGNAL_MIN_SAMPLES || vsBaselineBps == null ? null : vsBaselineBps >= SIGNAL_PREDICTIVE_MARGIN_BPS;
      return { code, matched: e.matched, filled: e.filled, medianSlippageBps: med, vsBaselineBps, predictive };
    })
    .sort((a, b) => (b.vsBaselineBps ?? -Infinity) - (a.vsBaselineBps ?? -Infinity));
}

const VERDICT_ORDER = ["go", "caution", "no_go"];

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function sameKey(run: PreflightLite, t: TradeLite): boolean {
  if (run.chain.toLowerCase() !== t.chain.toLowerCase()) return false;
  if (run.direction !== t.direction) return false;
  // Preflight account is nullable; when present it must match.
  if (run.account != null && run.account !== t.account) return false;
  const rb = (run.baseSymbol ?? "").toUpperCase();
  const tb = (t.baseSymbol ?? "").toUpperCase();
  return rb !== "" && rb === tb;
}

/**
 * Pure: greedily match each preflight run to the nearest subsequent trade on
 * the same key within `windowMs`. Each trade is claimed by at most one run.
 * Returns per-run matches + the per-verdict aggregate.
 */
export function correlatePreflightToTrades(
  runs: readonly PreflightLite[],
  trades: readonly TradeLite[],
  windowMs: number,
): { matches: Array<{ run: PreflightLite; trade: TradeLite | null }>; byVerdict: VerdictOutcome[] } {
  // Ascending by time so "nearest subsequent" is the first candidate.
  const runsAsc = [...runs].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const tradesAsc = [...trades].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const consumed = new Set<number>();
  const matches: Array<{ run: PreflightLite; trade: TradeLite | null }> = [];

  for (const run of runsAsc) {
    const runMs = Date.parse(run.timestamp);
    let pick: { idx: number; trade: TradeLite } | null = null;
    for (let i = 0; i < tradesAsc.length; i++) {
      if (consumed.has(i)) continue;
      const t = tradesAsc[i];
      const tMs = Date.parse(t.timestamp);
      if (tMs < runMs) continue; // trade must follow the decision
      if (tMs - runMs > windowMs) break; // ascending — no closer candidate beyond here
      if (sameKey(run, t)) {
        pick = { idx: i, trade: t };
        break; // earliest match wins
      }
    }
    if (pick) {
      consumed.add(pick.idx);
      matches.push({ run, trade: pick.trade });
    } else {
      matches.push({ run, trade: null });
    }
  }

  // Aggregate by verdict.
  const acc = new Map<string, { runs: number; matched: number; filled: number; failed: number; pending: number; slips: number[] }>();
  for (const m of matches) {
    const e = acc.get(m.run.verdict) ?? { runs: 0, matched: 0, filled: 0, failed: 0, pending: 0, slips: [] };
    e.runs += 1;
    if (m.trade) {
      e.matched += 1;
      if (m.trade.status === "success") {
        e.filled += 1;
        if (m.trade.realizedSlippageBps != null && Number.isFinite(m.trade.realizedSlippageBps)) {
          e.slips.push(m.trade.realizedSlippageBps);
        }
      } else if (m.trade.status === "failed") {
        e.failed += 1;
      } else {
        e.pending += 1;
      }
    }
    acc.set(m.run.verdict, e);
  }

  const byVerdict: VerdictOutcome[] = [...acc.entries()]
    .map(([verdict, e]) => ({
      verdict,
      runs: e.runs,
      matched: e.matched,
      filled: e.filled,
      failed: e.failed,
      pending: e.pending,
      medianSlippageBps: median(e.slips),
    }))
    .sort((a, b) => {
      const ai = VERDICT_ORDER.indexOf(a.verdict);
      const bi = VERDICT_ORDER.indexOf(b.verdict);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  return { matches, byVerdict };
}

/** Build the plain-language calibration read. */
export function summarizeCalibration(byVerdict: VerdictOutcome[]): string {
  const go = byVerdict.find((v) => v.verdict === "go");
  const caution = byVerdict.find((v) => v.verdict === "caution");
  if (!go || go.filled === 0 || !caution || caution.matched === 0) {
    return "Not enough correlated outcomes across verdicts to judge calibration yet — keep trading through preflight.";
  }
  const parts: string[] = [];
  if (go.medianSlippageBps != null && caution.medianSlippageBps != null) {
    const delta = caution.medianSlippageBps - go.medianSlippageBps;
    if (delta > 5) {
      parts.push(`caution trades slip ${delta.toFixed(0)}bps worse than go trades (${caution.medianSlippageBps.toFixed(0)} vs ${go.medianSlippageBps.toFixed(0)}) — the verdict is predictive`);
    } else if (delta < -5) {
      parts.push(`caution trades slip LESS than go trades — the caution signal may be over-firing`);
    } else {
      parts.push(`go and caution trades slip similarly (${go.medianSlippageBps.toFixed(0)} vs ${caution.medianSlippageBps.toFixed(0)}bps) — slippage isn't separated by the verdict`);
    }
  }
  const goFail = go.matched > 0 ? (go.failed / go.matched) * 100 : 0;
  const cautionFail = caution.matched > 0 ? (caution.failed / caution.matched) * 100 : 0;
  if (cautionFail > goFail + 10) {
    parts.push(`caution trades fail more often (${cautionFail.toFixed(0)}% vs ${goFail.toFixed(0)}%)`);
  }
  return parts.length > 0 ? parts.join("; ") + "." : "go and caution outcomes look similar so far.";
}

/** DB-backed gatherer: read recent preflight runs + trades, correlate, summarize. */
export function gatherPreflightCalibration(args: {
  windowMinutes?: number;
  sinceIso?: string;
  strategy?: string;
  now?: Date;
}): PreflightCalibrationReport {
  const windowMinutes = args.windowMinutes ?? 30;
  const runsRaw = listPreflightRuns({ sinceIso: args.sinceIso, strategy: args.strategy, limit: 5000 });
  const runs: PreflightLite[] = runsRaw.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    chain: r.chain,
    account: r.account,
    direction: r.direction,
    baseSymbol: r.base_symbol,
    verdict: r.verdict,
    codes: parseSignalCodes(r.reasons_json),
  }));
  // Trades from a touch before the window opens through now (a run near the
  // window's start can match a trade just after it).
  const tradesRaw = recentTrades({ since: args.sinceIso, strategy: args.strategy, limit: 50_000 });
  const trades: TradeLite[] = tradesRaw.map((t) => ({
    timestamp: t.timestamp,
    chain: t.chain,
    account: t.account,
    direction: t.direction,
    baseSymbol: t.base_symbol,
    status: t.status,
    realizedSlippageBps: t.realized_slippage_bps ?? null,
  }));

  const { byVerdict, matches } = correlatePreflightToTrades(runs, trades, windowMinutes * 60_000);
  return {
    windowMinutes,
    totalRuns: runs.length,
    totalMatched: byVerdict.reduce((s, v) => s + v.matched, 0),
    byVerdict,
    bySignal: aggregateSignalOutcomes(matches),
    summary: summarizeCalibration(byVerdict),
    generatedAt: (args.now ?? new Date()).toISOString(),
  };
}

/** Extract the warn/critical reason codes from a journaled run's reasons_json
 *  (the signals worth calibrating; "_ok"/info reasons aren't signals). */
function parseSignalCodes(reasonsJson: string): string[] {
  try {
    const reasons = JSON.parse(reasonsJson) as Array<{ code?: string; severity?: string }>;
    return reasons.filter((r) => r.severity === "warn" || r.severity === "critical").map((r) => r.code ?? "").filter(Boolean);
  } catch {
    return [];
  }
}
