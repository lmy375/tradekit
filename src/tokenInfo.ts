// Iter629: unified per-token report. Pre-iter629 operators investigating a
// token had to run 4-5 separate commands:
//   - balance lookup (via holdings)
//   - allowances list, filtered manually
//   - price lookup (price command)
//   - recent trades filtering by token (trades --token X)
//   - safety check (token check)
//
// Each command returned one piece of the picture. This module composes all
// the pieces into a single TokenInfoReport so an operator (or agent) can
// run ONE call and get the full operational view of a token.
//
// Why this isn't "blindly adding features": it adds NO new RPC primitives,
// no new data sources, no new business logic. It's pure composition over
// existing capabilities — the kind of UX improvement the user's standing
// directive ("make core easier to use") explicitly asks for.
//
// Pure-helper / orchestrator split: composeTokenInfoReport is pure (takes
// pre-fetched inputs); gatherTokenInfo is the I/O orchestrator that fans
// out the underlying queries in parallel.

import type { Address, PublicClient, Transport, Chain } from "viem";
import { formatUnits } from "viem";
import type { ChainProfile } from "./chains.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { TokenMetadata } from "./tokens.js";
import type { ApprovalRow } from "./approvals.js";
import type { TradeRow } from "./db.js";
import type { NextAction } from "./errors.js";

export interface TokenInfoApproval {
  /** Spender address. */
  spender: Address;
  /** Friendly label when this spender is in the known-routers registry. */
  spenderLabel: string | null;
  /** Decimal allowance display ("infinite" or numeric string). */
  display: string;
  /** Severity bucket from iter606's risk model: critical / warn / ok. */
  severity: "critical" | "warn" | "ok";
}

export interface TokenInfoReport {
  chain: string;
  /** Resolved token address (checksummed). */
  address: Address;
  /** Token symbol (e.g. "USDC"). */
  symbol: string;
  /** Token decimals. */
  decimals: number;
  /** ISO timestamp the report was assembled. */
  timestamp: string;

  /** Current price in USD. Null when no oracle is available. */
  priceUsd: number | null;
  /** Source of the price ("coingecko", "dexscreener", or "none"). */
  priceSource: string;

  /** Wallet's current balance (decimal string). */
  balance: string;
  /** Wallet's balance × current price. Null when price unavailable. */
  balanceUsd: number | null;
  /** Address being queried (operator's wallet for the active account). */
  owner: Address;

  /** Standing approvals on this token by the owner. Sorted critical → warn → ok. */
  approvals: TokenInfoApproval[];
  /** Severity counts of approvals — quick "do I need to revoke?" signal. */
  approvalCounts: { critical: number; warn: number; ok: number };
  /** Iter802: worst-bucket severity derived from approvalCounts. Named
   *  approvalSeverity (not bare `severity`) to disambiguate — the token
   *  itself isn't being scored, only its standing approvals are. Always
   *  present. Symmetric priority: critical > warn > ok. Dashboards branch
   *  on this one field instead of computing approvalCounts.critical > 0. */
  approvalSeverity: "ok" | "warn" | "critical";

  /** Most recent trades involving this token (as base OR quote). Capped at limit. */
  recentTrades: Array<{
    timestamp: string;
    direction: "buy" | "sell" | "transfer";
    baseSymbol: string | null;
    quoteSymbol: string | null;
    baseAmount: string;
    quoteAmount: string;
    status: string;
    txHash: string;
  }>;
  /** Total trades touching this token in the DB (unbounded count for context). */
  totalTradeCount: number;

  /** Composed advisory — null when nothing actionable. */
  advisory?: string;
  /** Iter829: structured equivalent of `advisory` — same trigger conditions,
   *  same priority order, but agents dispatch directly via tool/params instead
   *  of parsing the prose. Symmetric with iter686 trade
   *  recentFailurePattern.suggestedActions + the ToolError.nextActions shape
   *  used across the rest of the codebase. Always present (empty array when
   *  nothing actionable — mirrors how iter764 nextActionsSummary is always
   *  present with zero baselines). */
  recommendedActions: NextAction[];
  /** Iter762: wall-clock ms for the full gatherTokenInfo orchestration. Token
   *  info touches 4 external sources (chain RPC for metadata + balance +
   *  allowances, external price oracle) + 1 DB query — the slowest of any
   *  single-token surface. Operators tracking RPC / oracle degradation
   *  benefit from per-call timing. Set by the orchestrator AFTER
   *  composeTokenInfoReport returns; absent on reports built outside the
   *  orchestrator (synthetic test fixtures). Symmetric with other report
   *  elapsedMs fields across the codebase. */
  elapsedMs?: number;
}

/**
 * Iter629: pure composer. Takes pre-fetched inputs and assembles the report.
 * Exported for unit testing without the HTTP stack.
 *
 * `approvals` is the FULL allowance list for the owner on `chain`; this
 * helper filters down to entries matching the queried token.
 *
 * `trades` is a full pre-filtered slice (e.g. recentTrades({ limit: 50 }));
 * this helper filters to rows whose base_token OR quote_token matches the
 * queried address.
 */
export function composeTokenInfoReport(args: {
  chain: string;
  address: Address;
  owner: Address;
  metadata: TokenMetadata;
  priceUsd: number | null;
  priceSource: string;
  balanceRaw: bigint;
  approvals: readonly ApprovalRow[];
  approvalSeverityByPair: Map<string, "critical" | "warn" | "ok">;
  trades: readonly TradeRow[];
  recentLimit?: number;
}): TokenInfoReport {
  const balanceDecimal = formatUnits(args.balanceRaw, args.metadata.decimals);
  const balanceFloat = parseFloat(balanceDecimal);
  const balanceUsd =
    args.priceUsd != null && Number.isFinite(balanceFloat)
      ? balanceFloat * args.priceUsd
      : null;

  const addrLc = args.address.toLowerCase();

  // Filter approvals to this token. Pull severity from the caller's map
  // (caller pre-ran the audit so we don't re-execute the scoring logic here).
  const tokenApprovals = args.approvals.filter((a) => a.token.toLowerCase() === addrLc);
  const approvals: TokenInfoApproval[] = tokenApprovals.map((a) => ({
    spender: a.spender,
    spenderLabel: a.spenderLabel ?? null,
    display: a.display,
    severity: args.approvalSeverityByPair.get(`${addrLc}:${a.spender.toLowerCase()}`) ?? "ok",
  }));
  approvals.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const approvalCounts = { critical: 0, warn: 0, ok: 0 };
  for (const a of approvals) approvalCounts[a.severity]++;

  // Filter trades to those touching this token (base OR quote).
  const matchingTrades = args.trades.filter(
    (t) => t.base_token.toLowerCase() === addrLc || t.quote_token.toLowerCase() === addrLc,
  );
  const recentLimit = args.recentLimit ?? 10;
  const recentTrades = matchingTrades.slice(0, recentLimit).map((t) => ({
    timestamp: t.timestamp,
    direction: t.direction as "buy" | "sell" | "transfer",
    baseSymbol: t.base_symbol,
    quoteSymbol: t.quote_symbol,
    baseAmount: t.base_amount,
    quoteAmount: t.quote_amount,
    status: t.status,
    txHash: t.tx_hash,
  }));

  // Compose advisory from the most actionable signal. Order: critical
  // approvals > warn approvals > unpriced + non-zero balance > none.
  let advisory: string | undefined;
  // Iter829: structured equivalent of advisory. Same priority order; tool +
  // params shape lets agents dispatch directly without parsing the prose.
  // Both fields are populated together so consumers can pick whichever is
  // easier for their surface (text vs JSON).
  const recommendedActions: NextAction[] = [];
  if (approvalCounts.critical > 0) {
    advisory = `${approvalCounts.critical} CRITICAL approval${approvalCounts.critical === 1 ? "" : "s"} on this token. Run \`tradekit allowances audit\` and revoke unless actively used.`;
    recommendedActions.push({
      tool: "audit_allowances",
      params: { chain: args.chain },
      reason: `${approvalCounts.critical} critical approval${approvalCounts.critical === 1 ? "" : "s"} on this token — likely wallet-drain vector. Audit + revoke before trading.`,
    });
  } else if (approvalCounts.warn > 0) {
    advisory = `${approvalCounts.warn} warn-level approval${approvalCounts.warn === 1 ? "" : "s"} on this token. Review with \`tradekit allowances audit\`.`;
    recommendedActions.push({
      tool: "audit_allowances",
      params: { chain: args.chain },
      reason: `${approvalCounts.warn} warn-level approval${approvalCounts.warn === 1 ? "" : "s"} — review to confirm intent.`,
    });
  } else if (args.priceUsd == null && balanceFloat > 0) {
    advisory = "No price oracle found for this token. Treat USD value as unknown.";
    recommendedActions.push({
      tool: "check_price",
      params: { token: args.address, chain: args.chain },
      reason: "Token has non-zero balance but no price oracle — verify the token is real (not a honeypot) before trading.",
    });
  }

  // Iter802: derive approval-side worst-bucket severity. Priority: critical
  // > warn > ok. Default "ok" handles the no-approvals case.
  const approvalSeverity: TokenInfoReport["approvalSeverity"] =
    approvalCounts.critical > 0
      ? "critical"
      : approvalCounts.warn > 0
        ? "warn"
        : "ok";

  return {
    chain: args.chain,
    address: args.address,
    symbol: args.metadata.symbol,
    decimals: args.metadata.decimals,
    timestamp: new Date().toISOString(),
    priceUsd: args.priceUsd,
    priceSource: args.priceSource,
    balance: balanceDecimal,
    balanceUsd,
    owner: args.owner,
    approvals,
    approvalCounts,
    approvalSeverity,
    recentTrades,
    totalTradeCount: matchingTrades.length,
    ...(advisory ? { advisory } : {}),
    recommendedActions,
  };
}

function severityRank(s: "critical" | "warn" | "ok"): number {
  return s === "critical" ? 0 : s === "warn" ? 1 : 2;
}

/**
 * Iter629: orchestrator. Fan out metadata + price + balance + allowances +
 * recent trades in parallel; pass results to composeTokenInfoReport.
 *
 * Per-call failure is captured into the report fields (price=null, balance=0)
 * rather than aborting — the caller gets the best-effort composite. The
 * one error this DOES surface is when metadata fetch fails (we can't render
 * decimals without it).
 */
export async function gatherTokenInfo(args: {
  chain: string;
  address: Address;
  owner: Address;
  publicClient: PublicClient<Transport, Chain>;
  profile: ChainProfile;
  config: Config;
  logger: Logger;
  recentLimit?: number;
}): Promise<TokenInfoReport> {
  // Iter762: wrap the full orchestration. Metadata fetch is serial-required
  // (downstream needs decimals/symbol), but the rest fans out in parallel —
  // wall-clock here is dominated by the SLOWEST of those, so capturing the
  // FULL window is the honest signal.
  const t0 = Date.now();
  const { getToken, readBalance } = await import("./tokens.js");
  const { getCurrentPrice } = await import("./price.js");
  const { listAllowances } = await import("./approvals.js");
  const { auditAllowanceList } = await import("./approvalAudit.js");
  const { KNOWN_ROUTERS } = await import("./routers.js");
  const { recentTrades, matchesTradeToken } = await import("./db.js");

  // Metadata is the foundation — fail loudly if we can't read decimals/symbol.
  const metadata = await getToken(args.publicClient, args.profile, args.address);

  // Parallel fan-out for the rest. Each catches its own errors → null/empty.
  const [priceResult, balanceRaw, allowanceRows] = await Promise.all([
    getCurrentPrice(args.address, args.logger).catch(() => null),
    readBalance(args.publicClient, args.address, args.owner).catch(() => 0n),
    listAllowances(
      {
        publicClient: args.publicClient,
        profile: args.profile,
        owner: args.owner,
        logger: args.logger,
      },
      {},
    ).catch(() => [] as ApprovalRow[]),
  ]);

  // Pull severity for each (token, spender) from the audit. We run the audit
  // ONCE for the whole allowance list (it's already filtered to owner-on-chain).
  const knownRouters = new Set(KNOWN_ROUTERS.map((r) => r.address.toLowerCase()));
  const auditReport = auditAllowanceList(allowanceRows, {
    chain: args.chain,
    config: args.config,
    knownRouters,
    tokenPrices: new Map(),
    owner: args.owner,
  });
  const severityByPair = new Map<string, "critical" | "warn" | "ok">();
  for (const a of auditReport.allowances) {
    severityByPair.set(`${a.token.toLowerCase()}:${a.spender.toLowerCase()}`, a.severity);
  }

  // Trades — pull a generous slice from the active account and let the
  // composer filter to ones touching this token. Cheap query (indexed).
  const rawTrades = recentTrades({ chain: args.chain, limit: 200 });
  // Use matchesTradeToken to filter — same predicate the trades CLI uses.
  const addrLc = args.address.toLowerCase();
  const trades = rawTrades.filter((t) => matchesTradeToken(t, addrLc));

  // Determine the source label that fed our price. The price.ts helper
  // doesn't expose this; we infer: if the price came back, it succeeded
  // through whatever fallback chain — label as "coingecko_or_dexscreener"
  // for honesty. Future iter can extend getCurrentPrice to return source.
  const priceSource = priceResult != null ? "coingecko_or_dexscreener" : "none";

  const report = composeTokenInfoReport({
    chain: args.chain,
    address: args.address,
    owner: args.owner,
    metadata,
    priceUsd: priceResult,
    priceSource,
    balanceRaw,
    approvals: allowanceRows,
    approvalSeverityByPair: severityByPair,
    trades,
    recentLimit: args.recentLimit,
  });
  report.elapsedMs = Date.now() - t0;
  return report;
}
