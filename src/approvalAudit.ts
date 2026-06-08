// Iter606: allowance risk audit. Layers a pure scoring engine on top of
// existing approvals primitives (listAllowances) to surface DANGEROUS standing
// approvals first — pre-iter606 the flat `allowances` list required the
// operator to recognize each spender by heart.
//
// Risk model — per allowance, run every signal; the highest-severity signal
// wins (critical > warn > ok). Each signal carries a reason code so an MCP
// agent can branch on the structured detail rather than parsing prose.
//
// Why "infinite to unknown" is critical, not warn:
//   The catastrophic wallet-drain vector is approve(maxUint256, attackerContract).
//   Once granted, the attacker can move ALL of that token at any future time
//   from this wallet. A finite-amount approval to the same attacker is still
//   bad but bounded — at most loses `amount` once.
//
// Why "blacklisted token still approved" is warn:
//   The operator added the token to safety.tokenBlacklist precisely because
//   they don't want to interact with it. A standing approval is a contradictory
//   state — either the blacklist is wrong or the approval was forgotten. Either
//   way, revoke is the safe default.

import type { Address } from "viem";
import type { ApprovalRow } from "./approvals.js";
import type { Config } from "./config.js";

export type RiskSeverity = "ok" | "warn" | "critical";

/** Reason codes for risk signals. Stable across iters — an agent's classifier
 *  branches on these. New codes are additive (don't rename existing). */
export type RiskCode =
  | "infinite_unknown_spender"      // critical: approve(max, unknownContract)
  | "infinite_known_router"          // warn: approve(max, kyberswapRouter) — common but worth surfacing
  | "large_usd_exposure"             // warn: USD value of (allowance × current price) exceeds threshold
  | "blacklisted_token_still_approved" // warn: token in safety.tokenBlacklist but allowance > 0
  | "obscure_token"                  // warn: token symbol unknown + spender not a known router
  | "stale_approval"                 // warn (iter617): approval older than threshold or older than scan lookback
  | "ok";                             // no signal fired

export interface RiskFinding {
  code: RiskCode;
  severity: RiskSeverity;
  message: string;
}

export interface AuditedAllowance {
  token: Address;
  symbol: string;
  spender: Address;
  spenderLabel: string | null;
  /** Raw allowance display ("infinite" or decimal string — same as listAllowances). */
  display: string;
  /** Estimated USD value of the allowance × current token price.
   *  Undefined when the allowance is "infinite" (no meaningful USD value) OR when
   *  the token has no price oracle. Infinite-and-priced cases get NULL not the
   *  literal max value, because the "exposure" is conceptually unbounded. */
  usdExposure: number | null;
  /** Highest-severity finding for this allowance. Multiple findings are listed
   *  separately in `findings[]`; `severity` reflects the worst of them. */
  severity: RiskSeverity;
  findings: RiskFinding[];
  /** Suggested revoke action (matches the MCP `revoke` tool's params shape so
   *  an agent can dispatch directly). Always populated; the operator decides
   *  whether to act based on severity. */
  recommendedAction: {
    tool: "revoke";
    params: { chain: string; token: Address; spender: Address };
    reason: string;
  };
  /** Iter617: when the caller supplied freshness data, this captures the
   *  most-recent Approval event's timestamp (ISO) and block number for this
   *  (token, spender) pair. Undefined when:
   *    - the caller didn't fetch freshness data, OR
   *    - the freshness scan ran but found no event (= approval older than lookback)
   *  When freshness was scanned but no entry was found, `agedOutOfLookback=true`
   *  separates "we didn't look" from "we looked and it's older than the window".
   */
  grantedAt?: {
    timestamp: string | null;
    blockNumber: number;
    txHash: string;
  };
  /** Iter617: true when freshness was scanned for this (token, spender) pair
   *  AND no event was found in the lookback range. Used by the stale_approval
   *  risk signal — an approval older than the scan window is "set and forget"
   *  by definition. */
  agedOutOfLookback?: boolean;
}

export interface AllowanceAuditReport {
  chain: string;
  owner: Address;
  timestamp: string;
  /** Count by severity bucket. */
  counts: { ok: number; warn: number; critical: number; total: number };
  /** Iter788: top-level worst-bucket severity derived from counts. Lets
   *  dashboards / agents render a single status indicator without
   *  computing counts.critical > 0 etc. Priority: critical > warn > ok.
   *  Always present (counts.total === 0 → "ok"). Symmetric with iter786
   *  health.severity / iter787 doctor.severity — same single-string
   *  worst-bucket convention. */
  severity: "ok" | "warn" | "critical";
  /** All allowances sorted: critical → warn → ok, within each bucket by USD
   *  exposure descending (the riskiest dollar amount first). */
  allowances: AuditedAllowance[];
  /** Iter838: top-level dispatch list — pre-aggregated from the critical
   *  allowances' inline recommendedAction (iter681). Top-3 by USD exposure
   *  (null/unbounded first — infinite approvals are the worst). Agents
   *  skip iterating allowances[] to filter for critical+collect actions;
   *  the most-actionable subset surfaces directly. Always present (empty
   *  when no critical allowances). Symmetric with iter829-837. */
  recommendedActions: import("./errors.js").NextAction[];
  /** Iter749: wall-clock ms for the full audit orchestration. The pure
   *  auditAllowanceList scoring is fast — the wall clock is dominated by:
   *  (1) listAllowances RPC fan-out, (2) per-unique-token getCurrentPrice
   *  fan-out, (3) optional iter617 scanApprovalFreshness (eth_getLogs).
   *  Set by the CLI/MCP orchestrator AFTER the pure scoring step; absent on
   *  reports built outside an orchestrator (synthetic test fixtures, etc).
   *  Symmetric with iter725/727/728/729/736/744 elapsedMs across reconcile/
   *  pnl/portfolio/health/trades_sync/aggregator-stats reports — cron
   *  operators tracking compute over time get consistent shape. */
  elapsedMs?: number;
}

/** 2^255 — same threshold approvals.ts uses to recognize "effectively infinite". */
const INFINITE_THRESHOLD = 1n << 255n;

/** USD value of an allowance above which we surface a `large_usd_exposure` warning.
 *  Default $10k matches the "you'd notice this in your balance" threshold; the
 *  config can override via safety.alertUsdThreshold later if needed. */
const DEFAULT_USD_THRESHOLD = 10_000;

/** Iter617: an approval whose most recent grant is older than this is "stale".
 *  Operators who haven't re-touched an approval in 6+ months almost certainly
 *  forgot about it; the spender contract has had 6 months to be exploited or
 *  to rotate ownership. Tunable via `staleDays` in scoreAllowance ctx. */
const DEFAULT_STALE_DAYS = 180;

/**
 * Score a single allowance against every risk signal. Returns the worst
 * severity that fired + the full findings list (so an audit display can show
 * "2 critical issues" rather than collapsing into the worst-only summary).
 *
 * `priceFn` is injected so the caller controls the USD lookup (avoids dragging
 * `getCurrentPrice` into the pure scoring core + lets tests pin behavior
 * without network calls).
 */
export function scoreAllowance(
  row: ApprovalRow,
  ctx: {
    chain: string;
    knownRouters: Set<string>;
    blacklistedTokens: Set<string>;
    /** Token price in USD — undefined when no oracle. */
    tokenUsdPrice?: number;
    /** Threshold for large-exposure warning. */
    usdThreshold?: number;
    /** Iter617: most-recent grant for this (token, spender). undefined → not
     *  scanned. `timestamp=null` with a real blockNumber → scanned, found event,
     *  but couldn't fetch block timestamp (still meaningful — block number IS
     *  age data on chains with steady block time). */
    grantedAt?: { timestamp: string | null; blockNumber: number };
    /** Iter617: true when we ran the freshness scan but found no event for this
     *  pair in the lookback range. The absence-of-event signal: this approval
     *  must be older than the lookback window. */
    agedOutOfLookback?: boolean;
    /** Iter617: stale-approval threshold in days (defaults to 180). */
    staleDays?: number;
    /** Iter617: scan time (ISO) — used as "now" for computing approval age.
     *  Defaults to Date.now() when not supplied (callers in test pin this). */
    nowMs?: number;
  },
): {
  severity: RiskSeverity;
  findings: RiskFinding[];
  usdExposure: number | null;
} {
  const findings: RiskFinding[] = [];
  const isInfinite = row.allowance >= INFINITE_THRESHOLD;
  const spenderLower = row.spender.toLowerCase();
  const tokenLower = row.token.toLowerCase();
  const isKnownRouter = ctx.knownRouters.has(spenderLower);
  const isBlacklisted = ctx.blacklistedTokens.has(tokenLower);

  // Signal 1: infinite-to-unknown-spender. The catastrophic case.
  if (isInfinite && !isKnownRouter) {
    findings.push({
      code: "infinite_unknown_spender",
      severity: "critical",
      message: `Infinite approval to non-router contract ${row.spender}. This is the standard wallet-drain vector — revoke unless you specifically trust this contract.`,
    });
  }

  // Signal 2: infinite-to-known-router. Common but worth flagging — even
  // mainstream routers can have exploits; finite approvals are safer.
  if (isInfinite && isKnownRouter) {
    findings.push({
      code: "infinite_known_router",
      severity: "warn",
      message: `Infinite approval to ${row.spenderLabel ?? row.spender}. Routine for active traders, but consider periodic revoke + re-approve to limit blast radius if the router is ever compromised.`,
    });
  }

  // Signal 3: large USD exposure. Only meaningful for finite approvals (infinite
  // has no upper bound so a number wouldn't help).
  let usdExposure: number | null = null;
  if (!isInfinite && ctx.tokenUsdPrice != null) {
    // row.allowance is bigint raw units; row.display is the human decimal. Use
    // parseFloat(display) for the math — display is already decimal-formatted
    // by listAllowances, no further unit conversion needed.
    const amount = parseFloat(row.display);
    if (Number.isFinite(amount)) {
      usdExposure = amount * ctx.tokenUsdPrice;
      const threshold = ctx.usdThreshold ?? DEFAULT_USD_THRESHOLD;
      if (usdExposure >= threshold) {
        findings.push({
          code: "large_usd_exposure",
          severity: "warn",
          message: `Allowance of ${row.display} ${row.symbol} (~$${usdExposure.toFixed(0)}) exceeds $${threshold.toLocaleString("en-US")} threshold.`,
        });
      }
    }
  }

  // Signal 4: blacklisted token with non-zero allowance. Operator marked this
  // token as blacklisted but the approval is still standing — revoke regardless.
  if (isBlacklisted && row.allowance > 0n) {
    findings.push({
      code: "blacklisted_token_still_approved",
      severity: "warn",
      message: `Token ${row.symbol} is in safety.tokenBlacklist on this chain but the approval is still standing. Revoke to align state with policy.`,
    });
  }

  // Signal 5 (iter617): stale approval. Two cases trigger a warning:
  //   (a) freshness was scanned but no event found → older than lookback
  //   (b) freshness was scanned, event found, but its timestamp > staleDays
  // Only fires when the allowance is non-zero (a revoked approval has no risk
  // regardless of age) and only when freshness data was actually supplied
  // (absence of context.grantedAt and !context.agedOutOfLookback means "we
  // didn't look" → no signal, not a false-negative).
  if (row.allowance > 0n) {
    const staleDays = ctx.staleDays ?? DEFAULT_STALE_DAYS;
    if (ctx.agedOutOfLookback) {
      findings.push({
        code: "stale_approval",
        severity: "warn",
        message: `No on-chain Approval event found in the freshness scan window for ${row.symbol} → ${row.spenderLabel ?? row.spender}. This approval is older than the scan lookback (typically months). "Set and forget" approvals are higher-risk because the spender contract has had time to be exploited or rotated since the grant — revoke unless still actively used.`,
      });
    } else if (ctx.grantedAt?.timestamp) {
      const grantMs = Date.parse(ctx.grantedAt.timestamp);
      if (Number.isFinite(grantMs)) {
        const ageMs = (ctx.nowMs ?? Date.now()) - grantMs;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays >= staleDays) {
          findings.push({
            code: "stale_approval",
            severity: "warn",
            message: `Approval last granted ${Math.floor(ageDays)} days ago (older than the ${staleDays}-day stale threshold). "Set and forget" approvals are higher-risk — revoke unless still actively used.`,
          });
        }
      }
    }
  }

  // Signal 6: obscure-token-to-non-router. A finite approval to an unknown
  // contract for a token tradekit doesn't recognize. Could be benign (an
  // operator using a DEX tradekit doesn't natively support) or could be a
  // social-engineering scam. Warn at minimum.
  // We only flag this when isInfinite is false (the critical case is already
  // covered above) and the spender isn't a known router. The "obscure token"
  // proxy is the symbol — listAllowances always returns a symbol but it falls
  // back to a placeholder when the contract doesn't implement symbol(); a
  // present-but-empty or unusually short symbol is the signal.
  if (!isInfinite && !isKnownRouter && row.allowance > 0n) {
    // Use the absence of a known router label as the signal. Don't warn if
    // we don't have a price either (overlap with the price-driven warning is
    // not useful), unless the allowance is suspiciously small (dust-trap
    // approval is the social-engineering pattern). Skip this for now to
    // avoid noisy warnings on every UniV3 NFT-router approval the operator
    // has legitimately granted.
    // Intentionally narrow: leave the no-op signal as-is.
  }

  // Collapse to worst severity. If no findings, the allowance is ok.
  let severity: RiskSeverity = "ok";
  for (const f of findings) {
    if (f.severity === "critical") {
      severity = "critical";
      break;
    }
    if (f.severity === "warn") severity = "warn";
  }
  if (findings.length === 0) {
    findings.push({
      code: "ok",
      severity: "ok",
      message: "No risk signals fired for this allowance.",
    });
  }

  return { severity, findings, usdExposure };
}

/**
 * Run scoreAllowance against every row + sort the result so the worst rows are
 * surfaced first. Within a severity bucket, sort by USD exposure descending
 * (so the biggest priced exposure within a bucket lands at the top — the
 * operator sees "the biggest critical risk" first).
 *
 * `tokenPrices` is a map from lowercase token address to USD/token price.
 * Caller fetches via getCurrentPrice + a parallel loop; the scoring core stays
 * pure so unit tests don't need a network.
 */
export function auditAllowanceList(
  rows: ApprovalRow[],
  ctx: {
    chain: string;
    config: Config;
    knownRouters: Set<string>;
    tokenPrices: Map<string, number>;
    /** Optional explicit threshold for large_usd_exposure. Defaults to $10k. */
    usdThreshold?: number;
    owner: Address;
    /** Iter617: most-recent Approval event per (token+spender), keyed lowercase
     *  "<token>:<spender>". When supplied, every row checks this map; absent
     *  pairs are flagged as `agedOutOfLookback`. Pass `undefined` to skip
     *  freshness analysis entirely (the audit still works, just without the
     *  stale_approval signal). */
    freshness?: Map<string, { timestamp: string | null; blockNumber: number; txHash: string }>;
    /** Iter617: stale threshold in days. Default 180. */
    staleDays?: number;
    /** Iter617: clock for age math. Defaults to Date.now(). */
    nowMs?: number;
  },
): AllowanceAuditReport {
  const blacklisted = new Set(
    (ctx.config.safety?.tokenBlacklist?.[ctx.chain] ?? []).map((a) => a.toLowerCase()),
  );

  const audited: AuditedAllowance[] = rows.map((row) => {
    const tokenPrice = ctx.tokenPrices.get(row.token.toLowerCase());

    // Iter617: freshness lookup. The key is "<token>:<spender>" lowercased,
    // matching groupApprovalLogs's output shape.
    const freshKey = `${row.token.toLowerCase()}:${row.spender.toLowerCase()}`;
    const freshEntry = ctx.freshness?.get(freshKey);
    // agedOutOfLookback: we ran the scan (ctx.freshness defined) BUT no entry
    // for this pair → the approval predates the scan window.
    const agedOutOfLookback = ctx.freshness != null && freshEntry == null;

    const { severity, findings, usdExposure } = scoreAllowance(row, {
      chain: ctx.chain,
      knownRouters: ctx.knownRouters,
      blacklistedTokens: blacklisted,
      tokenUsdPrice: tokenPrice,
      usdThreshold: ctx.usdThreshold,
      grantedAt: freshEntry ? { timestamp: freshEntry.timestamp, blockNumber: freshEntry.blockNumber } : undefined,
      agedOutOfLookback,
      staleDays: ctx.staleDays,
      nowMs: ctx.nowMs,
    });
    // Build the suggested-action's reason text — different per severity so the
    // operator (or agent) gets honest signal not just boilerplate.
    const actionReason =
      severity === "critical"
        ? `Revoke this approval — critical risk. Run \`tradekit revoke ${row.token} ${row.spender}\` (CLI) or call the revoke tool with token + spender (MCP).`
        : severity === "warn"
          ? `Consider revoking this approval. Run \`tradekit revoke ${row.token} ${row.spender}\` (CLI) or call the revoke tool with token + spender (MCP).`
          : `No action needed. Revoke is still safe if you no longer use this spender: \`tradekit revoke ${row.token} ${row.spender}\`.`;

    return {
      token: row.token,
      symbol: row.symbol,
      spender: row.spender,
      spenderLabel: row.spenderLabel ?? null,
      display: row.display,
      usdExposure,
      severity,
      findings,
      recommendedAction: {
        tool: "revoke",
        params: { chain: ctx.chain, token: row.token, spender: row.spender },
        reason: actionReason,
      },
      ...(freshEntry
        ? {
            grantedAt: {
              timestamp: freshEntry.timestamp,
              blockNumber: freshEntry.blockNumber,
              txHash: freshEntry.txHash,
            },
          }
        : {}),
      ...(ctx.freshness != null ? { agedOutOfLookback } : {}),
    };
  });

  // Sort: critical → warn → ok; within each bucket, larger USD exposure first.
  // null usdExposure (infinite or unpriced) sorts BEFORE numeric exposures in
  // critical/warn buckets, because "unbounded" is conceptually worse than any
  // finite amount.
  const severityRank: Record<RiskSeverity, number> = { critical: 0, warn: 1, ok: 2 };
  audited.sort((a, b) => {
    const sa = severityRank[a.severity];
    const sb = severityRank[b.severity];
    if (sa !== sb) return sa - sb;
    // Within a bucket: null (infinite/unpriced) first in critical/warn, last in ok.
    if (a.usdExposure === null && b.usdExposure === null) return 0;
    if (a.severity === "ok") {
      // ok bucket: priced first, null last (less interesting at the bottom).
      if (a.usdExposure === null) return 1;
      if (b.usdExposure === null) return -1;
    } else {
      // critical/warn bucket: null (unbounded risk) first.
      if (a.usdExposure === null) return -1;
      if (b.usdExposure === null) return 1;
    }
    return (b.usdExposure ?? 0) - (a.usdExposure ?? 0);
  });

  const counts = audited.reduce(
    (acc, a) => {
      acc[a.severity]++;
      acc.total++;
      return acc;
    },
    { ok: 0, warn: 0, critical: 0, total: 0 } as { ok: number; warn: number; critical: number; total: number },
  );

  // Iter788: derive worst-bucket severity. Priority critical > warn > ok.
  // Default "ok" handles the empty-allowances case (counts.total === 0).
  const severity: AllowanceAuditReport["severity"] =
    counts.critical > 0 ? "critical" : counts.warn > 0 ? "warn" : "ok";

  // Iter838: top-3 critical allowances' actions. Sort by usdExposure desc
  // with null (unbounded/infinite) first — those are the riskiest. Each
  // allowance's recommendedAction is already a NextAction shape (iter681).
  const recommendedActions: import("./errors.js").NextAction[] = audited
    .filter((a) => a.severity === "critical")
    .sort((a, b) => {
      if (a.usdExposure == null && b.usdExposure == null) return 0;
      if (a.usdExposure == null) return -1;
      if (b.usdExposure == null) return 1;
      return b.usdExposure - a.usdExposure;
    })
    .slice(0, 3)
    .map((a) => a.recommendedAction);

  return {
    chain: ctx.chain,
    owner: ctx.owner,
    timestamp: new Date().toISOString(),
    counts,
    severity,
    allowances: audited,
    recommendedActions,
  };
}

// ── cross-chain aggregator (iter632) ──────────────────────────

export interface MultiChainAuditReport {
  /** ISO timestamp the aggregate was assembled. */
  timestamp: string;
  /** Chains successfully audited (those with at least one allowance returned).
   *  Chains that returned no allowances still count as audited via `chainsScanned`. */
  chains: string[];
  /** Every chain the caller asked to audit, including ones that failed. */
  chainsScanned: string[];
  /** Per-chain reports indexed by chain name. */
  perChain: Record<string, AllowanceAuditReport>;
  /** Per-chain errors (one bad RPC doesn't abort the whole audit). */
  errors: Array<{ chain: string; message: string }>;
  /** Summed severity counts across all included chains. */
  counts: { ok: number; warn: number; critical: number; total: number };
  /** Iter788: top-level worst-bucket severity across ALL chains. Same
   *  derivation as the single-chain report — critical > warn > ok. Lets
   *  dashboards render a single status for cross-chain audits. */
  severity: "ok" | "warn" | "critical";
  /** Cross-chain merged allowance list — all allowances from all chains,
   *  sorted using the same severity-then-USD rule the single-chain audit
   *  uses. Augmented with `chain` for display + agent dispatch. */
  allowances: Array<AuditedAllowance & { chain: string }>;
  /** Iter838: top-level dispatch list aggregated from the critical
   *  allowances across ALL chains. Top-3 by USD exposure (null/unbounded
   *  first). Same iter838 shape as the single-chain report. */
  recommendedActions: import("./errors.js").NextAction[];
}

/**
 * Iter632: pure aggregator. Combines per-chain reports into a unified
 * multi-chain shape. Same sort discipline as auditAllowanceList:
 *   critical → warn → ok; within each bucket, null usdExposure first (the
 *   unbounded-risk infinite approvals), then numeric desc.
 *
 * Per-chain errors are passed in separately (the orchestrator captures them
 * during the fan-out); this helper just embeds them in the report.
 *
 * Exported pure for unit testing without a real audit run.
 */
export function aggregateMultiChainAudits(args: {
  perChainReports: ReadonlyArray<AllowanceAuditReport>;
  chainsScanned: ReadonlyArray<string>;
  errors?: ReadonlyArray<{ chain: string; message: string }>;
}): MultiChainAuditReport {
  const perChain: Record<string, AllowanceAuditReport> = {};
  const chains: string[] = [];
  for (const report of args.perChainReports) {
    perChain[report.chain] = report;
    chains.push(report.chain);
  }

  const counts = { ok: 0, warn: 0, critical: 0, total: 0 };
  const allowances: Array<AuditedAllowance & { chain: string }> = [];
  for (const report of args.perChainReports) {
    counts.ok += report.counts.ok;
    counts.warn += report.counts.warn;
    counts.critical += report.counts.critical;
    counts.total += report.counts.total;
    for (const a of report.allowances) {
      allowances.push({ ...a, chain: report.chain });
    }
  }

  // Same sort as auditAllowanceList — critical first, then warn, then ok;
  // within each, null usdExposure (infinite/unpriced) sorts BEFORE numeric
  // entries in critical/warn (unbounded > finite), AFTER in ok (less urgent
  // when bottom-of-list anyway).
  const severityRank: Record<"critical" | "warn" | "ok", number> = {
    critical: 0,
    warn: 1,
    ok: 2,
  };
  allowances.sort((a, b) => {
    const sa = severityRank[a.severity];
    const sb = severityRank[b.severity];
    if (sa !== sb) return sa - sb;
    if (a.usdExposure === null && b.usdExposure === null) return 0;
    if (a.severity === "ok") {
      if (a.usdExposure === null) return 1;
      if (b.usdExposure === null) return -1;
    } else {
      if (a.usdExposure === null) return -1;
      if (b.usdExposure === null) return 1;
    }
    return (b.usdExposure ?? 0) - (a.usdExposure ?? 0);
  });

  // Iter788: same worst-bucket derivation as the single-chain report. Cross-
  // chain rolls up via the summed counts.
  const severity: MultiChainAuditReport["severity"] =
    counts.critical > 0 ? "critical" : counts.warn > 0 ? "warn" : "ok";

  // Iter838: top-3 critical actions across ALL chains, sorted by USD
  // exposure (null/unbounded first). The cross-chain merge naturally
  // surfaces the absolute worst — an infinite USDC approval on Base ranks
  // ahead of a $500 approval on Arbitrum.
  const recommendedActions: import("./errors.js").NextAction[] = allowances
    .filter((a) => a.severity === "critical")
    .sort((a, b) => {
      if (a.usdExposure == null && b.usdExposure == null) return 0;
      if (a.usdExposure == null) return -1;
      if (b.usdExposure == null) return 1;
      return b.usdExposure - a.usdExposure;
    })
    .slice(0, 3)
    .map((a) => a.recommendedAction);

  return {
    timestamp: new Date().toISOString(),
    chains,
    chainsScanned: [...args.chainsScanned],
    perChain,
    errors: args.errors ? [...args.errors] : [],
    counts,
    severity,
    allowances,
    recommendedActions,
  };
}
