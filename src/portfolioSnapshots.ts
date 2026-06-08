// Iter618: portfolio snapshot capture + diff. Closes the "no historical view"
// gap in pre-iter618 portfolio.ts — operators could see CURRENT positions but
// had no built-in way to track unrealized change over time. PnL covers
// realized trades; this covers position state (priced + unpriced).
//
// Design:
//   - Capture: take an aggregatePortfolio() result + persist it as-is (JSON blob)
//     into the portfolio_snapshots table. The full report is preserved so a
//     future iter can diff against any past snapshot without re-fetching.
//   - Scope key: normalize the (accounts × chains) scan scope into a canonical
//     sorted-comma-joined string. Two snapshots are comparable iff their scope
//     keys match — otherwise you'd be diffing "5 chains" against "1 chain" and
//     calling the missing chains "removed positions".
//   - Diff: pure helper. Takes two PortfolioReports → returns a structured
//     PortfolioDelta describing tokens added/removed/changed + total USD delta.
//
// Why diff a saved snapshot rather than recompute history:
//   On-chain history is reconstructable but expensive (eth_getLogs across N
//   blocks × M tokens) and lossy (some price oracles don't have historical
//   data). Saving a snapshot at the moment captures both the on-chain state
//   AND the price view the operator was looking at — preserving the "they
//   saw $X" memory faithfully.

import type { PortfolioReport, TokenAggregate } from "./portfolio.js";

/** Canonical scope key for the (accounts, chains) scan target. Sorted +
 *  lowercased + comma-joined. Two snapshots with identical scope keys are
 *  comparable; mismatched ones aren't (the diff would mis-attribute missing
 *  chains/accounts as "position removed").
 *  Exported so the CLI/MCP layer can compute the same key when looking up
 *  a comparable past snapshot via findPortfolioSnapshotAsOf. */
export function scopeKey(items: readonly string[]): string {
  return [...items].map((s) => s.toLowerCase()).sort().join(",");
}

export interface TokenChange {
  /** Token display symbol. Pinned from the CURRENT report (the prev symbol
   *  might differ if the chain renamed it — rare but possible). */
  symbol: string;
  /** Canonical token grouping id (matches TokenAggregate.tokenKey). */
  tokenKey: string;
  /** Per-chain breakdown is omitted from the diff; the symbol-level totals
   *  are what operators care about. The original snapshots are preserved if
   *  callers need finer detail. */
  prevAmount: number | null;
  currentAmount: number | null;
  amountDelta: number | null;
  /** Per-token USD totals. Null when EITHER side was unpriced — the delta
   *  isn't meaningful when comparing unpriced ↔ priced. */
  prevUsd: number | null;
  currentUsd: number | null;
  usdDelta: number | null;
  /** Pct of USD change: (curr - prev) / prev × 100. Null when prev is
   *  null/0 (can't divide by zero) or current is null. */
  usdDeltaPct: number | null;
}

export interface PortfolioDelta {
  prev: { timestamp: string; totalUsd: number; tokenCount: number };
  current: { timestamp: string; totalUsd: number; tokenCount: number };
  totalUsdDelta: number;
  /** Percent change: (curr - prev) / prev × 100. Null when prev was 0. */
  totalUsdDeltaPct: number | null;
  /** Tokens present in CURRENT but not PREV. Sorted by USD descending. */
  added: TokenChange[];
  /** Tokens present in PREV but not CURRENT. Sorted by previous-USD descending. */
  removed: TokenChange[];
  /** Tokens present in both. Sorted by absolute USD delta descending — the
   *  biggest movers first (gainer or loser). */
  changed: TokenChange[];
  /** Tokens whose USD value is unchanged within tolerance. Included so the
   *  full set is reconstructable from the diff alone; sorted by current USD. */
  unchanged: TokenChange[];
}

/**
 * Iter618: pure diff. Walks token aggregates from both reports and emits a
 * PortfolioDelta. Tokens are matched by `tokenKey` (the canonical grouping
 * id portfolio.ts uses) so a NATIVE roll-up matches a NATIVE roll-up across
 * chains correctly.
 *
 * `usdEpsilon` is the threshold under which a USD change is treated as
 * unchanged (default $0.01). Avoids spamming "BTC changed by $0.0001" rows
 * caused by floating-point rounding in price feeds.
 */
export function diffSnapshots(
  prev: PortfolioReport,
  current: PortfolioReport,
  options?: { usdEpsilon?: number },
): PortfolioDelta {
  const epsilon = options?.usdEpsilon ?? 0.01;
  const prevByKey = new Map(prev.tokens.map((t) => [t.tokenKey, t]));
  const currentByKey = new Map(current.tokens.map((t) => [t.tokenKey, t]));
  const allKeys = new Set([...prevByKey.keys(), ...currentByKey.keys()]);

  const added: TokenChange[] = [];
  const removed: TokenChange[] = [];
  const changed: TokenChange[] = [];
  const unchanged: TokenChange[] = [];

  for (const key of allKeys) {
    const p = prevByKey.get(key);
    const c = currentByKey.get(key);
    const change = buildTokenChange(p, c);
    if (!p && c) {
      added.push(change);
    } else if (p && !c) {
      removed.push(change);
    } else if (p && c) {
      // Both sides priced + delta within epsilon → unchanged.
      // Both sides null USD OR mismatch → changed (operator should see it).
      const isUsdUnchanged =
        change.usdDelta != null && Math.abs(change.usdDelta) < epsilon;
      // Also treat as unchanged when BOTH sides are unpriced and amounts match
      // exactly. Otherwise we'd spam unpriced position rows on every snapshot.
      const isAmountUnchanged =
        change.usdDelta == null &&
        change.prevUsd == null &&
        change.currentUsd == null &&
        change.amountDelta != null &&
        Math.abs(change.amountDelta) < epsilon;
      if (isUsdUnchanged || isAmountUnchanged) {
        unchanged.push(change);
      } else {
        changed.push(change);
      }
    }
  }

  // Sort: added by current USD desc, removed by prev USD desc, changed by
  // ABSOLUTE usd delta desc (biggest movers first), unchanged by current USD desc.
  added.sort((a, b) => (b.currentUsd ?? 0) - (a.currentUsd ?? 0));
  removed.sort((a, b) => (b.prevUsd ?? 0) - (a.prevUsd ?? 0));
  changed.sort((a, b) => Math.abs(b.usdDelta ?? 0) - Math.abs(a.usdDelta ?? 0));
  unchanged.sort((a, b) => (b.currentUsd ?? 0) - (a.currentUsd ?? 0));

  const totalUsdDelta = current.totalUsd - prev.totalUsd;
  const totalUsdDeltaPct =
    prev.totalUsd > 0 ? (totalUsdDelta / prev.totalUsd) * 100 : null;

  return {
    prev: {
      timestamp: prev.timestamp,
      totalUsd: prev.totalUsd,
      tokenCount: prev.tokens.length,
    },
    current: {
      timestamp: current.timestamp,
      totalUsd: current.totalUsd,
      tokenCount: current.tokens.length,
    },
    totalUsdDelta,
    totalUsdDeltaPct,
    added,
    removed,
    changed,
    unchanged,
  };
}

/** Build a TokenChange row from optional prev/current aggregates. */
function buildTokenChange(
  prev: TokenAggregate | undefined,
  current: TokenAggregate | undefined,
): TokenChange {
  const symbol = current?.symbol ?? prev?.symbol ?? "?";
  const tokenKey = current?.tokenKey ?? prev?.tokenKey ?? symbol;

  const prevAmount = sumAmount(prev);
  const currentAmount = sumAmount(current);
  const amountDelta =
    prevAmount != null && currentAmount != null
      ? currentAmount - prevAmount
      : currentAmount != null
        ? currentAmount
        : prevAmount != null
          ? -prevAmount
          : null;

  const prevUsd = prev?.totalUsd ?? null;
  const currentUsd = current?.totalUsd ?? null;
  const usdDelta =
    prevUsd != null && currentUsd != null
      ? currentUsd - prevUsd
      : currentUsd != null
        ? currentUsd
        : prevUsd != null
          ? -prevUsd
          : null;
  const usdDeltaPct =
    prevUsd != null && prevUsd > 0 && usdDelta != null
      ? (usdDelta / prevUsd) * 100
      : null;

  return {
    symbol,
    tokenKey,
    prevAmount,
    currentAmount,
    amountDelta,
    prevUsd,
    currentUsd,
    usdDelta,
    usdDeltaPct,
  };
}

/** Sum `perChain.amount` strings into a single number. Returns null when the
 *  aggregate is undefined or every amount fails to parse. */
function sumAmount(agg: TokenAggregate | undefined): number | null {
  if (!agg) return null;
  let total = 0;
  let anyValid = false;
  for (const p of agg.perChain) {
    const n = parseFloat(p.amount);
    if (Number.isFinite(n)) {
      total += n;
      anyValid = true;
    }
  }
  return anyValid ? total : null;
}

/**
 * Iter618: resolve a snapshot reference string. Supports:
 *   - "<id>": numeric id from `portfolio history`
 *   - "Nd"/"Nh": relative ago (`7d`, `24h`)
 *   - "today" / "yesterday"
 *   - ISO date or timestamp (`2026-05-01`, `2026-05-01T00:00:00Z`)
 *
 * Returns an absolute ISO timestamp suitable for findPortfolioSnapshotAsOf,
 * OR a numeric id when the input was an explicit id. The CLI/MCP layer
 * branches on the return shape.
 *
 * Throws Error with a helpful message for malformed input.
 */
export function resolveSnapshotRef(ref: string): { kind: "id"; id: number } | { kind: "asOf"; iso: string } {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) {
    return { kind: "id", id: parseInt(trimmed, 10) };
  }
  if (trimmed === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { kind: "asOf", iso: d.toISOString() };
  }
  if (trimmed === "yesterday") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 1);
    return { kind: "asOf", iso: d.toISOString() };
  }
  const rel = /^(\d+)([smhd])$/.exec(trimmed);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const ms =
      unit === "s" ? n * 1000
      : unit === "m" ? n * 60_000
      : unit === "h" ? n * 3_600_000
      : n * 86_400_000;
    return { kind: "asOf", iso: new Date(Date.now() - ms).toISOString() };
  }
  // Fall back to Date.parse — accepts ISO date, ISO timestamp, common formats.
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return { kind: "asOf", iso: new Date(parsed).toISOString() };
  }
  throw new Error(
    `Unrecognized snapshot reference "${ref}". Use a numeric id, ISO date (2026-05-01), relative (7d, 24h), or "today"/"yesterday".`,
  );
}
