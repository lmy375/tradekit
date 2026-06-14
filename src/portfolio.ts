// Iter605: portfolio — aggregate holdings across multiple accounts and chains.
//
// Pre-iter605: an operator with 5 HD accounts on 3 chains had to run
// `tradekit holdings` 15 times and aggregate manually. The `pnl` command shows
// total realized + unrealized but not per-token-per-account exposure, and
// `status` is single-account.
//
// This module orchestrates existing primitives (listAccounts, holdingsMultiChain)
// into one structured aggregate, plus concentration analysis so an operator can
// see "82% of net worth is in WETH" at a glance — a meaningful risk signal that
// silently lives across 15 separate views before iter605.
//
// Design notes:
// - The aggregation is PURE (given a list of ChainHoldings tuples, builds the
//   aggregate without further chain calls). The pure split lets us unit-test the
//   math without mocking HTTP.
// - Per-chain failures inherit holdingsMultiChain's iter190 contract:
//   per-(account, chain) errors land in result.errors[] without aborting the
//   whole portfolio scan. An operator scanning 5 accounts × 3 chains with one
//   bad RPC still gets 14/15 working scans.
// - Concentration analysis ignores unpriced tokens (usd === undefined) — they
//   contribute neither to the total nor to the percentage. A token without a
//   price isn't "0% of portfolio"; it's "unmeasured" and should be surfaced
//   separately so an operator doesn't undercount.

import type { Address } from "viem";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { listAccounts } from "./accounts.js";
import { getKeystoreAddress } from "./wallet.js";
import { KEYSTORE_LABEL } from "./constants.js";
import {
  holdingsMultiChain,
  type ChainHoldings,
  type ChainHoldingsError,
  type TokenBalance,
} from "./holdings.js";

export interface AccountResolution {
  label: string;
  address: Address;
}

export interface AccountChainSnapshot {
  account: string;
  address: Address;
  chain: string;
  chainId: number;
  timestamp: string;
  balances: TokenBalance[];
  /** USD value for this (account, chain) pair. Undefined when no balance has a price. */
  totalUsd?: number;
}

export interface AccountChainError {
  account: string;
  chain: string;
  message: string;
}

export interface TokenAggregate {
  symbol: string;
  /** Canonical token id used for grouping. "NATIVE" sentinel collapses native
   *  assets across chains into one row; addresses keep per-token rows. */
  tokenKey: string;
  /** Token addresses contributing to this aggregate (one per chain — native
   *  appears here as "NATIVE" repeated). Distinct because the same symbol can
   *  exist at different addresses across chains. */
  perChain: Array<{ chain: string; address: Address | "NATIVE"; amount: string; usd?: number }>;
  /** Sum of usd across contributing positions. Undefined when ALL contributing
   *  positions are unpriced — distinguishes "$0 value" from "unknown value". */
  totalUsd?: number;
  /** Percentage of the priced portfolio total. Undefined when totalUsd is
   *  undefined or when the portfolio's overall priced total is 0. */
  percentOfPortfolio?: number;
  /** Iter717: MAX timestamp across contributing chains' last-trade of this
   *  symbol (from the iter716 lastTradeAtBySymbol helper). Absent when this
   *  symbol has never been traded on any contributing chain (e.g. airdrop
   *  recipient, deposit-only account). */
  lastTradeAt?: string;
}

export interface PortfolioReport {
  /** ISO timestamp the scan started. Per-snapshot timestamps stay in
   *  snapshots[i].timestamp — this is just the audit anchor. */
  timestamp: string;
  /** Iter728: wall-clock ms for the full portfolio scan (includes per-
   *  (account, chain) RPC fan-out + price lookups + aggregation). Same
   *  shape as iter727 PnLReport.elapsedMs. */
  elapsedMs?: number;
  /** Accounts that were scanned (label + address). Pinned here so an operator
   *  reading the report later knows exactly which keys it covered. */
  accounts: AccountResolution[];
  /** Chains that were scanned. Same rationale. */
  chains: string[];
  /** Per-(account, chain) success rows. Empty when every scan failed. */
  snapshots: AccountChainSnapshot[];
  /** Per-(account, chain) failures. Empty on a fully-healthy run. */
  errors: AccountChainError[];
  /** Sum across all priced positions. The "priced" qualifier matters — see
   *  TokenAggregate.totalUsd; unpriced positions are excluded. */
  totalUsd: number;
  /** Count of unpriced positions (positions with non-zero amount but no usd
   *  field). Surfaces "I have unknown-value holdings" so the operator can
   *  investigate without thinking the totalUsd is the full picture. */
  unpricedPositionCount: number;
  /** Per-token roll-up, sorted by totalUsd descending. Top of the array is
   *  the largest position. */
  tokens: TokenAggregate[];
  /** Top N concentration: cumulative % of portfolio in the top entries.
   *  Useful as a risk signal — "top 1 is 82% → highly concentrated". */
  concentration: { top1: number; top3: number; top5: number };
  /** v72: concentration assessed against the configured single-token limit
   *  (safety.maxConcentrationPct) — the guardrail verdict, not just the raw
   *  metric. verdict 'unconfigured' when no limit is set. */
  concentrationRisk: ConcentrationRisk;
  /** Iter807: worst-bucket severity. "warn" on any per-(account, chain)
   *  scan failures; "ok" otherwise. Symmetric with iter801/804/806 severity
   *  fields across multi-chain reports. */
  severity: "ok" | "warn";
  /** Iter833: structured dispatch list. One entry per failed (account,
   *  chain) suggesting per-chain holdings inspection — agents triage which
   *  chain's RPC needs attention. Always present (empty on a clean scan).
   *  Symmetric with iter829-832. */
  recommendedActions: import("./errors.js").NextAction[];
}

// ── account resolution ────────────────────────────────────

/**
 * Resolve the list of accounts to scan. "all" expands to every HD account plus
 * the keystore (when one exists); a comma-list of labels resolves each entry
 * individually; undefined defaults to the single active wallet (matching
 * `holdings` without --account).
 *
 * Errors:
 * - UNKNOWN_ACCOUNT (via accountResolution callers) when a label doesn't match.
 *
 * Throws never on its own — returns an empty list when nothing matches, leaving
 * the caller to decide whether that's an error (CLI: yes, with a message;
 * library: no, just an empty portfolio).
 */
export function resolveAccountsForPortfolio(
  labels: string[] | "all" | undefined,
): AccountResolution[] {
  const accountsFile = listAccounts();
  const keystoreAddr = getKeystoreAddress();
  const hdAccounts: AccountResolution[] = (accountsFile?.accounts ?? []).map((a) => ({
    label: a.label,
    address: a.address,
  }));
  const keystoreEntry: AccountResolution | null = keystoreAddr
    ? { label: KEYSTORE_LABEL, address: keystoreAddr }
    : null;

  if (labels === "all") {
    const out = [...hdAccounts];
    if (keystoreEntry) out.push(keystoreEntry);
    return out;
  }

  if (labels === undefined) {
    // Default: the single active account (HD-preferred via accountsFile.active).
    // Pre-iter605 you'd just call `holdings` — same selection logic preserved.
    if (accountsFile && accountsFile.active) {
      const active = hdAccounts.find((a) => a.label === accountsFile.active);
      if (active) return [active];
    }
    if (keystoreEntry) return [keystoreEntry];
    return [];
  }

  // Comma-list: resolve each label. Unknown labels are skipped here; the CLI
  // surfaces them with `unknownAccountError` via a separate validation pass.
  const known = new Map(hdAccounts.map((a) => [a.label, a]));
  if (keystoreEntry) known.set(keystoreEntry.label, keystoreEntry);
  const resolved: AccountResolution[] = [];
  for (const label of labels) {
    const hit = known.get(label);
    if (hit) resolved.push(hit);
  }
  return resolved;
}

// ── pure aggregation ──────────────────────────────────────

/**
 * Iter605: pure aggregation. Given the raw per-(account, chain) ChainHoldings
 * results, build the cross-cutting TokenAggregate roll-up + concentration math.
 * Split from the orchestrator so the math is unit-testable without HTTP.
 *
 * Grouping rule: native assets across chains collapse into one "NATIVE" row
 * iff their symbols match (ETH on base + ETH on arbitrum → one row;
 * MATIC on polygon stays its own row). Cross-chain ERC20 tokens with the same
 * symbol but different addresses keep separate rows — they're not fungible
 * across chains absent a bridge.
 */
export function aggregateTokens(
  snapshots: AccountChainSnapshot[],
): { tokens: TokenAggregate[]; totalUsd: number; unpricedPositionCount: number } {
  // Build a key per position. Native tokens collapse by symbol; ERC20s key by
  // address only (cross-chain same-symbol same-address would collapse, which is
  // the right behavior on Optimism-style canonical bridge mappings).
  const groups = new Map<
    string,
    {
      symbol: string;
      tokenKey: string;
      entries: { chain: string; address: Address | "NATIVE"; amount: string; usd?: number }[];
    }
  >();
  let unpriced = 0;

  for (const snap of snapshots) {
    for (const bal of snap.balances) {
      const amountFloat = parseFloat(bal.amount);
      if (!Number.isFinite(amountFloat) || amountFloat === 0) continue;
      // Key: NATIVE + symbol for natives (collapse across chains); the address
      // for ERC20s (already case-insensitive in viem normalization).
      const key =
        bal.token === "NATIVE" ? `NATIVE:${bal.symbol}` : bal.token.toLowerCase();
      const existing = groups.get(key);
      const entry = { chain: snap.chain, address: bal.token, amount: bal.amount, usd: bal.usd };
      if (existing) {
        existing.entries.push(entry);
      } else {
        groups.set(key, { symbol: bal.symbol, tokenKey: key, entries: [entry] });
      }
      if (bal.usd === undefined) unpriced++;
    }
  }

  // Build the TokenAggregate list with summed USD. Aggregates with at least one
  // priced entry get a totalUsd; all-unpriced groups carry totalUsd=undefined.
  let portfolioTotal = 0;
  const tokens: TokenAggregate[] = [];
  for (const g of groups.values()) {
    let total = 0;
    let anyPriced = false;
    for (const e of g.entries) {
      if (typeof e.usd === "number") {
        total += e.usd;
        anyPriced = true;
      }
    }
    const totalUsd = anyPriced ? total : undefined;
    if (totalUsd !== undefined) portfolioTotal += totalUsd;
    tokens.push({
      symbol: g.symbol,
      tokenKey: g.tokenKey,
      perChain: g.entries,
      totalUsd,
    });
  }

  // Now that we know portfolioTotal, fill in percentOfPortfolio for priced rows.
  for (const t of tokens) {
    if (t.totalUsd !== undefined && portfolioTotal > 0) {
      t.percentOfPortfolio = (t.totalUsd / portfolioTotal) * 100;
    }
  }

  // Sort descending by totalUsd (unpriced last — they all have undefined totals).
  tokens.sort((a, b) => {
    const av = a.totalUsd ?? -1;
    const bv = b.totalUsd ?? -1;
    return bv - av;
  });

  return { tokens, totalUsd: portfolioTotal, unpricedPositionCount: unpriced };
}

/**
 * Iter605: pure concentration math. Cumulative percentage of the top N
 * holdings. "Top 1 at 82%" is a high-concentration risk signal; "top 5 at 30%"
 * is a well-diversified portfolio. Surfaces both 1 / 3 / 5 thresholds so the
 * operator can pick the metric that matches their mental model.
 */
export function computeConcentration(
  tokens: TokenAggregate[],
): { top1: number; top3: number; top5: number } {
  // Only priced tokens contribute. The list is already sorted by totalUsd desc
  // when called from aggregateTokens, but compute defensively in case of
  // alternative call sites.
  const priced = tokens
    .filter((t): t is TokenAggregate & { totalUsd: number; percentOfPortfolio: number } =>
      typeof t.totalUsd === "number" && typeof t.percentOfPortfolio === "number",
    )
    .sort((a, b) => b.totalUsd - a.totalUsd);
  const cum = (n: number): number => {
    let s = 0;
    for (let i = 0; i < n && i < priced.length; i++) s += priced[i].percentOfPortfolio;
    return s;
  };
  return { top1: cum(1), top3: cum(3), top5: cum(5) };
}

export interface ConcentrationRisk {
  /** Configured single-token threshold (% of priced portfolio). Null when
   *  unset — the operator hasn't opted into a concentration limit. */
  thresholdPct: number | null;
  /** ok = every token under the threshold; warn = ≥1 at/over it;
   *  unconfigured = no threshold to judge against (a visible gap). */
  verdict: "ok" | "warn" | "unconfigured";
  /** Largest single priced position's % of portfolio. Null when nothing priced. */
  largestPct: number | null;
  largestSymbol: string | null;
  /** Tokens at/over the threshold, descending by %. Empty unless verdict=warn. */
  breaches: Array<{ symbol: string; percentOfPortfolio: number; overByPct: number }>;
  summary: string;
}

/**
 * v72: assess portfolio concentration against a configured single-token cap.
 * This is the CROSS-STRATEGY aggregate that per-(strategy,token) position caps
 * structurally miss — several strategies can each stay within their cap while
 * the whole book drifts into one token. Pure; operates on the same priced
 * TokenAggregate roll-up computeConcentration uses.
 */
export function assessConcentrationRisk(
  tokens: TokenAggregate[],
  thresholdPct: number | null | undefined,
): ConcentrationRisk {
  const priced = tokens
    .filter((t): t is TokenAggregate & { percentOfPortfolio: number } =>
      typeof t.percentOfPortfolio === "number",
    )
    .sort((a, b) => b.percentOfPortfolio - a.percentOfPortfolio);
  const largest = priced[0] ?? null;
  const largestPct = largest ? largest.percentOfPortfolio : null;
  const largestSymbol = largest ? largest.symbol : null;

  if (thresholdPct == null) {
    return {
      thresholdPct: null,
      verdict: "unconfigured",
      largestPct,
      largestSymbol,
      breaches: [],
      summary:
        largest != null
          ? `No concentration limit set — top holding ${largestSymbol} is ${largestPct!.toFixed(1)}% of the book (set safety.maxConcentrationPct to get a guardrail).`
          : `No concentration limit set; no priced holdings to assess.`,
    };
  }

  const breaches = priced
    .filter((t) => t.percentOfPortfolio >= thresholdPct)
    .map((t) => ({
      symbol: t.symbol,
      percentOfPortfolio: t.percentOfPortfolio,
      overByPct: t.percentOfPortfolio - thresholdPct,
    }));
  const verdict: "ok" | "warn" = breaches.length > 0 ? "warn" : "ok";
  const summary =
    verdict === "warn"
      ? `CONCENTRATED: ${breaches.map((b) => `${b.symbol} ${b.percentOfPortfolio.toFixed(1)}%`).join(", ")} over the ${thresholdPct}% single-token limit.`
      : largest != null
        ? `OK — top holding ${largestSymbol} is ${largestPct!.toFixed(1)}% (under the ${thresholdPct}% limit).`
        : `OK — no priced holdings.`;
  return { thresholdPct, verdict, largestPct, largestSymbol, breaches, summary };
}

// ── orchestration ─────────────────────────────────────────

/**
 * Build a multi-account, multi-chain portfolio aggregate. Fans out one
 * holdingsMultiChain call per account (each of which fans out per-chain), then
 * folds the results.
 *
 * Per-(account, chain) errors are collected into report.errors[] WITHOUT
 * aborting the rest of the scan — matches holdingsMultiChain's iter190
 * contract. An operator with one bad RPC on one chain still gets the rest of
 * the portfolio.
 */
export async function aggregatePortfolio(args: {
  accounts: AccountResolution[];
  config: Config;
  logger: Logger;
  /** Optional chain filter. Undefined → built-ins + custom (the
   *  holdingsMultiChain default). */
  chains?: string[];
}): Promise<PortfolioReport> {
  // Iter728: wall-clock for the full scan.
  const t0 = Date.now();
  const timestamp = new Date().toISOString();
  const snapshots: AccountChainSnapshot[] = [];
  const errors: AccountChainError[] = [];

  // Per-account fan-out — each inner call already parallelizes chains, so we
  // also parallelize across accounts. For 5 accounts × 5 chains that's up to
  // 25 concurrent RPC reads (with the per-chain rate-limiting + RPC failover
  // already in makeTransport).
  const accountResults = await Promise.all(
    args.accounts.map(async (a) => {
      const { reports, errors: chainErrors } = await holdingsMultiChain(
        a.address,
        args.config,
        args.logger,
        args.chains,
      );
      return { account: a, reports, chainErrors };
    }),
  );

  // Lowered to a flat snapshot list with account labels attached.
  for (const r of accountResults) {
    for (const report of r.reports) {
      snapshots.push({
        account: r.account.label,
        address: r.account.address,
        chain: report.chain,
        chainId: report.chainId,
        timestamp: report.timestamp,
        balances: report.balances,
        totalUsd: report.totalUsd,
      });
    }
    for (const e of r.chainErrors as ChainHoldingsError[]) {
      errors.push({ account: r.account.label, chain: e.chain, message: e.message });
    }
  }

  const { tokens, totalUsd, unpricedPositionCount } = aggregateTokens(snapshots);
  const concentration = computeConcentration(tokens);
  const concentrationRisk = assessConcentrationRisk(tokens, args.config.safety.maxConcentrationPct);

  const chainsScanned: string[] = [];
  for (const snap of snapshots) {
    if (!chainsScanned.includes(snap.chain)) chainsScanned.push(snap.chain);
  }

  return {
    timestamp,
    elapsedMs: Date.now() - t0,
    accounts: args.accounts,
    chains: chainsScanned,
    snapshots: snapshots.map((s) => {
      // ChainHoldings carries the per-snapshot data; we just lift account into the row.
      // The reference compose maintains stability of the return shape across iters.
      return s;
    }),
    errors,
    totalUsd,
    unpricedPositionCount,
    tokens,
    concentration,
    concentrationRisk,
    // Iter807: severity from per-(account, chain) failure count. v72: also
    // warn when a configured concentration limit is breached.
    severity: errors.length > 0 || concentrationRisk.verdict === "warn" ? "warn" : "ok",
    // Iter833: per-failed-(account, chain) dispatch list. Each entry points
    // agents at a scoped holdings inspection — diagnose which chain's RPC
    // is degraded.
    recommendedActions: errors.map((e) => ({
      tool: "holdings",
      params: { account: e.account, chains: [e.chain] },
      reason: `Portfolio scan failed for ${e.account}/${e.chain}: ${e.message.slice(0, 100)}. Inspect this chain's holdings directly to diagnose.`,
    })),
  };
}
