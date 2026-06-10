/**
 * Equity curve (v37) — "how has my total portfolio value moved?"
 *
 * Built from portfolio_snapshots (iter618): each row already carries
 * a denormalized total_usd, so the curve is a pure DB read — no RPC,
 * no oracle. The data FEED is the v37 engine snapshot worker
 * (engine.workers.snapshot), which records an 'engine-auto' snapshot
 * when the freshest one is older than engine.snapshotEveryHours;
 * manual `tradekit snapshot` rows contribute too.
 *
 * Scope discipline: a curve only makes sense within ONE scan scope
 * (accounts_key × chains_key) — mixing scopes makes the line jump on
 * COVERAGE changes, not value changes. When the caller doesn't pin a
 * scope, the most-snapshotted one is selected and echoed back.
 */

import { listPortfolioSnapshots, listSnapshotScopes } from "./db.js";
import { ToolError } from "./errors.js";

export interface EquityPoint {
  at: string;
  totalUsd: number;
}

export interface EquityCurve {
  /** The scope the curve was computed over. */
  accountsKey: string;
  chainsKey: string;
  /** Why this scope: "requested" | "defaulted" (most-snapshotted). */
  scopeSource: "requested" | "defaulted";
  points: EquityPoint[];
  firstAt: string | null;
  lastAt: string | null;
  firstUsd: number | null;
  lastUsd: number | null;
  changeAbs: number | null;
  changePct: number | null;
  peakUsd: number | null;
  peakAt: string | null;
  /** Max peak-to-trough drawdown across the window, percent. */
  maxDrawdownPct: number | null;
  /** Other scopes that exist (for pickers). */
  availableScopes: Array<{ accountsKey: string; chainsKey: string; count: number; lastAt: string }>;
}

/** Evenly downsample to at most maxPoints, always keeping the first
 *  and last point (the endpoints carry the change numbers). */
export function downsample<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const out: T[] = [points[0]];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i++) {
    out.push(points[Math.round(i * step)]);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function buildEquityCurve(args: {
  accountsKey?: string;
  chainsKey?: string;
  sinceIso?: string;
  maxPoints?: number;
} = {}): EquityCurve {
  const maxPoints = args.maxPoints ?? 200;
  if (maxPoints < 2 || maxPoints > 2000) {
    throw new ToolError("INVALID_PARAMS", `maxPoints must be in [2, 2000] (got ${maxPoints}).`);
  }
  const scopes = listSnapshotScopes();
  const availableScopes = scopes.map((s) => ({
    accountsKey: s.accounts_key,
    chainsKey: s.chains_key,
    count: s.count,
    lastAt: s.lastAt,
  }));

  let accountsKey = args.accountsKey;
  let chainsKey = args.chainsKey;
  let scopeSource: EquityCurve["scopeSource"] = "requested";
  if (accountsKey == null && chainsKey == null) {
    const best = scopes[0];
    if (!best) {
      return {
        accountsKey: "", chainsKey: "", scopeSource: "defaulted",
        points: [], firstAt: null, lastAt: null, firstUsd: null, lastUsd: null,
        changeAbs: null, changePct: null, peakUsd: null, peakAt: null,
        maxDrawdownPct: null, availableScopes,
      };
    }
    accountsKey = best.accounts_key;
    chainsKey = best.chains_key;
    scopeSource = "defaulted";
  }

  const rows = listPortfolioSnapshots({
    accountsKey,
    chainsKey,
    since: args.sinceIso,
  });
  // listPortfolioSnapshots returns newest-first; the curve walks
  // oldest-first. Rows without a priced total are unplottable.
  const points: EquityPoint[] = rows
    .filter((r) => r.total_usd != null && Number.isFinite(r.total_usd))
    .map((r) => ({ at: r.timestamp, totalUsd: r.total_usd as number }))
    .reverse();

  const sampled = downsample(points, maxPoints);

  let peakUsd: number | null = null;
  let peakAt: string | null = null;
  let maxDrawdownPct: number | null = null;
  let runningPeak = -Infinity;
  for (const p of points) {
    if (p.totalUsd > runningPeak) runningPeak = p.totalUsd;
    if (peakUsd == null || p.totalUsd > peakUsd) {
      peakUsd = p.totalUsd;
      peakAt = p.at;
    }
    if (runningPeak > 0) {
      const dd = ((runningPeak - p.totalUsd) / runningPeak) * 100;
      if (maxDrawdownPct == null || dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  const first = points[0] ?? null;
  const last = points[points.length - 1] ?? null;
  const changeAbs = first && last ? last.totalUsd - first.totalUsd : null;
  const changePct = first && last && first.totalUsd > 0 ? ((last.totalUsd - first.totalUsd) / first.totalUsd) * 100 : null;

  return {
    accountsKey: accountsKey ?? "",
    chainsKey: chainsKey ?? "",
    scopeSource,
    points: sampled,
    firstAt: first?.at ?? null,
    lastAt: last?.at ?? null,
    firstUsd: first?.totalUsd ?? null,
    lastUsd: last?.totalUsd ?? null,
    changeAbs,
    changePct,
    peakUsd,
    peakAt,
    maxDrawdownPct,
    availableScopes,
  };
}
