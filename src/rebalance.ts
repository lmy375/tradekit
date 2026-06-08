// Portfolio rebalancing engine.
//
// Declarative target-weight specs that the engine periodically evaluates
// + corrects toward. A plan says "ETH should be 60% of my base portfolio,
// USDC the other 40%" — the engine fetches the live portfolio, computes
// each token's drift from target, and routes corrective trades through
// the SAME executeTrade pipeline as manual swaps (so every safety rail,
// MEV protection, audit row, and notification applies verbatim).
//
// Architectural placement:
//   - Sibling primitive to orders / schedules / reconcile (each plan has
//     its own row in rebalance_plans + lifecycle).
//   - Cron-driven cadence (reuses src/cron.ts).
//   - Wired into the engine supervisor as a 4th worker.
//
// Trade routing decisions:
//   - Each plan covers ONE chain + ONE account. Multi-chain operators
//     create one plan per chain. Keeps the trade graph small (no cross-
//     chain bridging needed in v1).
//   - A `quote_token` per plan (defaults to chain's usdc) serves as the
//     routing anchor: over-weight positions sell INTO quote_token, then
//     under-weight positions buy FROM quote_token. Sells fire first to
//     raise the quote balance available for the buys.
//   - Per-trade `min_trade_usd` skip threshold avoids burning gas on a
//     $3 correction that costs $5 in gas (default $10).
//
// The math (computeDrift, planRebalanceTrades) is pure + unit-testable;
// the engine wrapper (runRebalanceTick) is the only async part and
// injects a portfolio fetcher so tests can drive the state machine
// without RPC dependencies.

import type { Address, PublicClient, WalletClient, Account, Transport, Chain } from "viem";
import { ToolError, type NextAction } from "./errors.js";
import { executeTrade, type TradeRequest, type TradeContext, type TradeResult } from "./trade.js";
import { resolveTradePair } from "./chains.js";
import { resolveProfile, loadConfig, type Config } from "./config.js";
import {
  insertRebalancePlan,
  getRebalancePlanById,
  listRebalancePlans,
  dueRebalancePlans,
  setRebalancePlanNextRunAt,
  recordRebalanceRun,
  recordRebalanceError,
  pauseRebalancePlan as dbPauseRebalancePlan,
  resumeRebalancePlan as dbResumeRebalancePlan,
  cancelRebalancePlan as dbCancelRebalancePlan,
  rebalancePlanCountsByStatus,
  type RebalanceRow,
  type RebalanceStatus,
  type RebalanceTarget,
  type InsertRebalancePlanArgs,
} from "./db.js";
import { parseCron, nextRun } from "./cron.js";
import { tryNotify } from "./notify.js";
import { loadWallet, loadReadOnlyWallet } from "./wallet.js";
import { holdingsOnChain } from "./holdings.js";
import { chainHoldingsToSnapshot, type PortfolioSnapshot, type PortfolioToken } from "./positionLimits.js";
import type { Logger } from "./logger.js";
import type { ChainProfile } from "./chains.js";
import { resolveToken } from "./chains.js";

export type { RebalanceRow, RebalanceStatus, RebalanceTarget, RebalancePlanFilter } from "./db.js";

// ── pure: target validation ──────────────────────────────────

/**
 * Validate a rebalance targets[] spec. Rules:
 *   - At least 2 targets (a 1-target plan is degenerate — "100% ETH" is
 *     just "buy all the ETH" and would never need a rebalance).
 *   - No duplicate tokens (case-insensitive on symbols, lowercase on
 *     addresses). Operators sometimes paste the same line twice; surface
 *     the dupe explicitly.
 *   - Each targetPct in [0, 100]. A 0% target is a "phase out" — fully
 *     supported (every rebalance sells the entire position).
 *   - Sum to exactly 100 (within 0.01 epsilon for float-rounding edge
 *     cases).
 *
 * Pure helper — throws ToolError on bad input, returns the normalized
 * targets on success (token strings lowercased for address-style entries,
 * trimmed in either case).
 */
export function validateTargets(raw: readonly RebalanceTarget[]): RebalanceTarget[] {
  if (raw.length < 2) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Rebalance plan requires at least 2 targets (a single-target plan never rebalances). Got ${raw.length}.`,
    );
  }
  const seen = new Set<string>();
  let sum = 0;
  const out: RebalanceTarget[] = [];
  for (const [i, t] of raw.entries()) {
    if (!t.token || typeof t.token !== "string") {
      throw new ToolError("INVALID_PARAMS", `targets[${i}].token is required.`);
    }
    if (!Number.isFinite(t.targetPct) || t.targetPct < 0 || t.targetPct > 100) {
      throw new ToolError(
        "INVALID_PARAMS",
        `targets[${i}].targetPct must be a number in [0, 100] (got ${t.targetPct}).`,
      );
    }
    const key = t.token.trim().toLowerCase();
    if (seen.has(key)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Duplicate target "${t.token}" in targets[] — each token can appear at most once.`,
      );
    }
    seen.add(key);
    sum += t.targetPct;
    out.push({ token: t.token.trim(), targetPct: t.targetPct });
  }
  // Allow 0.01% tolerance for float-rounding edge cases (e.g. three 33.33%
  // entries that sum to 99.99). Reject anything outside that.
  if (Math.abs(sum - 100) > 0.01) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Rebalance targets must sum to exactly 100% (got ${sum.toFixed(4)}%).`,
    );
  }
  return out;
}

// ── pure: drift computation ──────────────────────────────────

export interface DriftEntry {
  /** Operator-supplied identifier (the original token string from the
   *  target spec — symbol or address). */
  token: string;
  /** The token's PortfolioToken match in the snapshot, or null when
   *  the operator targets a token they don't currently hold (drift =
   *  -targetPct, "I should buy this from zero"). */
  matched: PortfolioToken | null;
  currentPct: number;
  targetPct: number;
  /** currentPct - targetPct. Positive = over-weight (sell). Negative
   *  = under-weight (buy). */
  driftPct: number;
  /** Absolute USD value to move (positive). When driftPct > 0 this is
   *  the USD value to SELL; when < 0, USD value to BUY. */
  deltaUsd: number;
}

export interface DriftReport {
  /** Drift entries one-per-target. */
  entries: DriftEntry[];
  /** Max |driftPct| across all entries — engine's "should we fire?" signal. */
  maxDriftPct: number;
  /** Portfolio total USD as seen by the snapshot. Drift entries are
   *  computed against this. */
  totalUsd: number;
  /** True iff at least one targeted token couldn't be priced (its USD is
   *  null in the snapshot). Surfaces in the engine's soft-skip path. */
  hasUnpriced: boolean;
}

/**
 * Pure: compute per-target drift given a portfolio snapshot. The
 * snapshot is the OPERATOR-FACING view (PortfolioSnapshot from
 * positionLimits.ts — already covers symbol vs address matching, native
 * sentinel resolution, etc.).
 *
 * Matching rules:
 *   - target.token looks like 0x → match by lowercased address
 *   - else → match by uppercased symbol (with NATIVE / ETH / BNB / POL
 *     alias to chain-native).
 *
 * No-match (operator targeted a token they don't hold yet): currentPct=0,
 * driftPct = -targetPct ("I should buy this from zero").
 */
export function computeDrift(snapshot: PortfolioSnapshot, targets: readonly RebalanceTarget[]): DriftReport {
  const entries: DriftEntry[] = [];
  let maxDriftPct = 0;
  let hasUnpriced = false;

  for (const target of targets) {
    const matched = findTokenInSnapshot(snapshot, target.token);
    if (matched && matched.usd == null) hasUnpriced = true;
    const usd = matched?.usd ?? 0;
    const currentPct = snapshot.totalUsd > 0 ? (usd / snapshot.totalUsd) * 100 : 0;
    const driftPct = currentPct - target.targetPct;
    const targetUsd = (target.targetPct / 100) * snapshot.totalUsd;
    const deltaUsd = Math.abs(usd - targetUsd);
    entries.push({
      token: target.token,
      matched: matched ?? null,
      currentPct,
      targetPct: target.targetPct,
      driftPct,
      deltaUsd,
    });
    if (Math.abs(driftPct) > maxDriftPct) maxDriftPct = Math.abs(driftPct);
  }
  return { entries, maxDriftPct, totalUsd: snapshot.totalUsd, hasUnpriced };
}

function findTokenInSnapshot(snapshot: PortfolioSnapshot, token: string): PortfolioToken | null {
  const trimmed = token.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    const lc = trimmed.toLowerCase();
    return snapshot.tokens.find((t) => t.address.toLowerCase() === lc) ?? null;
  }
  const upper = trimmed.toUpperCase();
  // Native aliases — ETH / NATIVE / BNB / POL all match the chain's NATIVE
  // sentinel address regardless of stored symbol.
  if (upper === "ETH" || upper === "NATIVE" || upper === "BNB" || upper === "POL") {
    const native = snapshot.tokens.find((t) => t.address === "NATIVE");
    if (native) return native;
  }
  return snapshot.tokens.find((t) => (t.symbol ?? "").toUpperCase() === upper) ?? null;
}

// ── pure: trade-list planner ─────────────────────────────────

export interface RebalanceTradeStep {
  /** Operator-facing description of this leg ("sell 100 USD of ETH"). */
  description: string;
  direction: "buy" | "sell";
  /** Token-side of the trade (the one being adjusted; the OTHER side is
   *  always the plan's quote_token). For a "sell over-weight ETH" leg
   *  this is ETH. For a "buy under-weight WBTC" leg this is WBTC. */
  baseToken: string;
  /** USD value to trade (positive). */
  amountUsd: number;
  /** The driftPct that produced this leg — surfaced for telemetry. */
  driftPct: number;
}

export interface RebalancePlanResult {
  /** Trades to execute, in EXECUTION ORDER (sells before buys). */
  steps: RebalanceTradeStep[];
  /** Trades that would have fired but were skipped (below min_trade_usd
   *  threshold). Reported so operators can see "why did the rebalance
   *  do nothing for token X". */
  skipped: Array<RebalanceTradeStep & { reason: "below_min_trade_usd" }>;
  /** Max drift observed; rebalance is a no-op when this is below threshold. */
  maxDriftPct: number;
}

/**
 * Pure: given a drift report + minimum trade size, compute the trade
 * list. Sells fire first to raise the quote balance, then buys spend it
 * — keeps the gross balance reasonable on a multi-leg rebalance.
 *
 * The quote_token target ITSELF is excluded from the trade list (we
 * don't sell USDC to USDC). Its drift is the residual; sells will push
 * its weight up, buys will pull it down, and after the round-trip the
 * quote weight settles near its target naturally.
 */
export function planRebalanceTrades(
  drift: DriftReport,
  args: {
    quoteToken: string;
    minTradeUsd: number;
  },
): RebalancePlanResult {
  const sells: RebalanceTradeStep[] = [];
  const buys: RebalanceTradeStep[] = [];
  const skipped: RebalancePlanResult["skipped"] = [];

  const quoteUpper = args.quoteToken.trim().toUpperCase();
  const quoteLowerAddr = args.quoteToken.trim().toLowerCase();

  for (const entry of drift.entries) {
    // Skip the quote anchor — its drift settles via the cross-trades.
    const tokenLower = entry.token.trim().toLowerCase();
    const tokenUpper = entry.token.trim().toUpperCase();
    if (tokenLower === quoteLowerAddr || tokenUpper === quoteUpper) continue;

    // Match the matched-token's symbol/address against the quote — operators
    // can target "USDC" while the quote is the USDC address (or vice versa).
    if (entry.matched) {
      const matchedSymbol = (entry.matched.symbol ?? "").toUpperCase();
      const matchedAddrLower = entry.matched.address.toLowerCase();
      if (matchedAddrLower === quoteLowerAddr || matchedSymbol === quoteUpper) continue;
    }

    const step: RebalanceTradeStep = {
      description:
        entry.driftPct > 0
          ? `sell $${entry.deltaUsd.toFixed(2)} of ${entry.token}`
          : `buy $${entry.deltaUsd.toFixed(2)} of ${entry.token}`,
      direction: entry.driftPct > 0 ? "sell" : "buy",
      baseToken: entry.token,
      amountUsd: entry.deltaUsd,
      driftPct: entry.driftPct,
    };
    if (entry.deltaUsd < args.minTradeUsd) {
      skipped.push({ ...step, reason: "below_min_trade_usd" });
      continue;
    }
    if (entry.driftPct > 0) sells.push(step);
    else if (entry.driftPct < 0) buys.push(step);
    // drift == 0 → exactly on target, no trade.
  }
  // Sort each side largest-first so big corrections happen before small.
  sells.sort((a, b) => b.amountUsd - a.amountUsd);
  buys.sort((a, b) => b.amountUsd - a.amountUsd);
  return { steps: [...sells, ...buys], skipped, maxDriftPct: drift.maxDriftPct };
}

// ── creation ─────────────────────────────────────────────────

export interface CreateRebalancePlanArgs {
  name?: string;
  account: string;
  chain: string;
  /** Token symbol or address used as the routing anchor (default: chain USDC). */
  quoteToken?: string;
  targets: RebalanceTarget[];
  /** Min drift (any target's |current% - target%|) that triggers a fire.
   *  Default 5%. */
  driftThresholdPct?: number;
  /** Per-leg minimum USD trade size to actually fire (skips below).
   *  Default $10. */
  minTradeUsd?: number;
  /** Cron expression (5-field). Default "0 *\/6 * * *" (every 6h). */
  cron?: string;
  startAt?: string;
  endAt?: string;
  maxRuns?: number;
  slippageBps?: number;
  autoSlippage?: boolean;
  strategy?: string;
  note?: string;
}

export function createRebalancePlanRow(args: CreateRebalancePlanArgs, config: Config = loadConfig()): RebalanceRow {
  const targets = validateTargets(args.targets);

  if (args.driftThresholdPct != null && (!Number.isFinite(args.driftThresholdPct) || args.driftThresholdPct <= 0 || args.driftThresholdPct > 100)) {
    throw new ToolError("INVALID_PARAMS", `driftThresholdPct must be a number in (0, 100] (got ${args.driftThresholdPct}).`);
  }
  if (args.minTradeUsd != null && (!Number.isFinite(args.minTradeUsd) || args.minTradeUsd < 0)) {
    throw new ToolError("INVALID_PARAMS", `minTradeUsd must be a non-negative number (got ${args.minTradeUsd}).`);
  }
  if (args.slippageBps != null && (!Number.isInteger(args.slippageBps) || args.slippageBps <= 0 || args.slippageBps > 10_000)) {
    throw new ToolError("INVALID_PARAMS", `slippageBps must be an integer in (0, 10000] (got ${args.slippageBps}).`);
  }
  if (args.maxRuns != null && (!Number.isInteger(args.maxRuns) || args.maxRuns <= 0)) {
    throw new ToolError("INVALID_PARAMS", `maxRuns must be a positive integer (got ${args.maxRuns}).`);
  }

  const now = new Date();
  let startAt: string | null = null;
  if (args.startAt) {
    const t = Date.parse(args.startAt);
    if (!Number.isFinite(t)) {
      throw new ToolError("INVALID_PARAMS", `startAt must be ISO-8601 (got "${args.startAt}").`);
    }
    startAt = new Date(t).toISOString();
  }
  let endAt: string | null = null;
  if (args.endAt) {
    const t = Date.parse(args.endAt);
    if (!Number.isFinite(t)) {
      throw new ToolError("INVALID_PARAMS", `endAt must be ISO-8601 (got "${args.endAt}").`);
    }
    if (t <= now.getTime()) {
      throw new ToolError("INVALID_PARAMS", `endAt must be in the future (got "${args.endAt}").`);
    }
    if (startAt && Date.parse(startAt) >= t) {
      throw new ToolError("INVALID_PARAMS", `endAt must be after startAt.`);
    }
    endAt = new Date(t).toISOString();
  }

  const cronExpr = args.cron ?? "0 */6 * * *"; // every 6 hours by default
  const parsedCron = parseCron(cronExpr); // throws on malformed

  const profile = resolveProfile(args.chain, config);
  // Resolve quote token: explicit arg wins, else chain USDC.
  const quoteToken: Address = args.quoteToken
    ? resolveToken(profile, args.quoteToken) ?? null as unknown as Address
    : profile.usdc;
  if (!quoteToken) {
    throw new ToolError("INVALID_PARAMS", `Cannot resolve quoteToken "${args.quoteToken}" on chain ${profile.name}.`);
  }
  // Lookup the symbol for display (best-effort).
  const quoteSymbol = (() => {
    const lc = (quoteToken as string).toLowerCase();
    for (const [sym, addr] of Object.entries(profile.tokens ?? {})) {
      if (addr.toLowerCase() === lc) return sym;
    }
    return null;
  })();

  // First-run timing: start_at in the future → first fire ≥ start_at; else now.
  const startCursor =
    startAt && Date.parse(startAt) > now.getTime() ? new Date(Date.parse(startAt) - 60_000) : now;
  const firstRun = nextRun(parsedCron, startCursor);
  if (endAt && firstRun.getTime() > Date.parse(endAt)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `cron "${cronExpr}" never fires before endAt (${endAt}). Adjust cron or extend endAt.`,
    );
  }

  const insertArgs: InsertRebalancePlanArgs = {
    name: args.name ?? null,
    account: args.account,
    chain: profile.name,
    quote_token: quoteToken,
    quote_symbol: quoteSymbol,
    targets,
    drift_threshold_pct: args.driftThresholdPct ?? 5,
    min_trade_usd: args.minTradeUsd ?? 10,
    cron_expr: cronExpr,
    next_run_at: firstRun.toISOString(),
    start_at: startAt,
    end_at: endAt,
    max_runs: args.maxRuns ?? null,
    slippage_bps: args.slippageBps ?? null,
    auto_slippage: args.autoSlippage ?? false,
    strategy: args.strategy ?? null,
    note: args.note ?? null,
  };
  const id = insertRebalancePlan(insertArgs);
  const row = getRebalancePlanById(id);
  if (!row) throw new ToolError("INTERNAL_ERROR", `Rebalance plan ${id} disappeared immediately after insert.`);
  return row;
}

// ── lifecycle ────────────────────────────────────────────────

export function pauseRebalancePlanById(id: number): RebalanceRow {
  const existing = getRebalancePlanById(id);
  if (!existing) throw new ToolError("INVALID_PARAMS", `Rebalance plan #${id} not found.`, { details: { planId: id } });
  const r = dbPauseRebalancePlan(id);
  if (r === -1) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Rebalance plan #${id} is ${existing.status} — only active plans can be paused.`,
      { details: { planId: id, currentStatus: existing.status } },
    );
  }
  return getRebalancePlanById(id) ?? existing;
}

export function resumeRebalancePlanById(id: number, now: Date = new Date()): RebalanceRow {
  const existing = getRebalancePlanById(id);
  if (!existing) throw new ToolError("INVALID_PARAMS", `Rebalance plan #${id} not found.`, { details: { planId: id } });
  const parsed = parseCron(existing.cron_expr);
  const next = nextRun(parsed, now);
  const r = dbResumeRebalancePlan(id, next.toISOString());
  if (r === -1) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Rebalance plan #${id} is ${existing.status} — only paused plans can be resumed.`,
      { details: { planId: id, currentStatus: existing.status } },
    );
  }
  return getRebalancePlanById(id) ?? existing;
}

export function cancelRebalancePlanById(id: number): RebalanceRow {
  const existing = getRebalancePlanById(id);
  if (!existing) throw new ToolError("INVALID_PARAMS", `Rebalance plan #${id} not found.`, { details: { planId: id } });
  dbCancelRebalancePlan(id);
  return getRebalancePlanById(id) ?? existing;
}

// ── engine tick ──────────────────────────────────────────────

export interface RebalanceTickArgs {
  chain?: string;
  account?: string;
  password?: string;
  dryRun?: boolean;
  logger: Logger;
  now?: Date;
  /** Inject a portfolio fetcher for tests. Default uses live RPC. */
  fetchPortfolio?: (chain: string, account: string, config: Config, logger: Logger) => Promise<PortfolioSnapshot>;
}

export interface RebalanceFireReport {
  planId: number;
  name: string | null;
  status: "executed" | "skipped" | "failed" | "completed";
  /** Drift % observed at evaluation. */
  maxDriftPct?: number;
  /** Trades that fired this tick. */
  executed: Array<{ description: string; txHash?: string; ok: boolean; error?: string }>;
  /** Trades planned but skipped (below min_trade_usd). */
  skipped: Array<{ description: string; reason: string }>;
  errorCode?: string;
  errorMessage?: string;
  nextRunAt?: string;
}

export interface RebalanceTickReport {
  ok: true;
  timestamp: string;
  elapsedMs: number;
  severity: "ok" | "warn" | "critical";
  due: number;
  executed: number;
  skipped: number;
  failed: number;
  completed: number;
  fires: RebalanceFireReport[];
  recommendedActions: NextAction[];
}

/** Live portfolio fetcher — chain snapshot via existing holdings flow. */
async function defaultFetchPortfolio(chain: string, account: string, config: Config, logger: Logger): Promise<PortfolioSnapshot> {
  // We use the read-only wallet here just to get the owner address —
  // no signing needed for portfolio reads. Account-specific.
  const profile = resolveProfile(chain, config);
  const extraRpcs = config.chains[chain]?.rpcs ?? [];
  const wallet = loadReadOnlyWallet(profile, extraRpcs, account);
  const report = await holdingsOnChain(wallet.account.address, chain, config, logger);
  return chainHoldingsToSnapshot([report]);
}

/** Conservative classifier — same shape as the orders / schedules engines. */
function isTransientErrorCode(code: string): boolean {
  return (
    code === "RPC_FAILED" ||
    code === "RPC_RATE_LIMITED" ||
    code === "API_ERROR" ||
    code === "TX_TIMEOUT" ||
    code === "QUOTE_FAILED" ||
    code === "AGGREGATOR_FAILED"
  );
}

/**
 * Single engine tick for the rebalance worker. Walks every due active
 * plan, fetches its portfolio, computes drift, fires trades if drift
 * exceeds threshold. Each plan is processed independently — a single
 * bad plan doesn't kill the tick.
 *
 * Per-plan flow:
 *   1. Advance next_run_at first (so a fail-and-retry doesn't refire
 *      every tick within the same minute).
 *   2. Fetch portfolio + compute drift.
 *   3. If max drift < threshold → record run (skipped) + notify.
 *   4. Else plan trades + execute SELLS, then BUYS. Each trade routes
 *      through executeTrade (full safety pipeline).
 *   5. Record run + notify with the trade summary.
 *
 * Errors:
 *   - Portfolio fetch failure → record error, leave plan active for retry
 *   - Validation failure (cron unparseable, etc.) → mark plan completed
 *     with the error code (terminal: the plan is broken at the data layer)
 *   - Per-trade failure → record but continue processing remaining trades
 *     in the SAME plan (sells before buys; a failed sell doesn't block
 *     subsequent sells)
 */
export async function runRebalanceTick(args: RebalanceTickArgs): Promise<RebalanceTickReport> {
  const startedAt = Date.now();
  const now = args.now ?? new Date();
  let due = dueRebalancePlans(now.toISOString());
  if (args.chain) due = due.filter((p) => p.chain === args.chain!.toLowerCase());
  if (args.account) due = due.filter((p) => p.account === args.account);

  const fires: RebalanceFireReport[] = [];
  let executed = 0;
  let skipped = 0;
  let failed = 0;
  let completed = 0;

  const config = loadConfig();
  const fetcher = args.fetchPortfolio ?? defaultFetchPortfolio;

  // Iter28: engine lock. When the kill switch is active, skip
  // rebalance evaluation entirely (the portfolio fetch is the
  // expensive part — multi-token, multi-chain RPC; no point doing
  // it when we can't fire anyway). Each due plan is reported as
  // skipped with ENGINE_LOCKED so the operator sees rebalance state
  // didn't silently freeze.
  const { isEngineLocked: _isLocked, getEngineLockState: _lockState } = await import("./engineLock.js");
  if (_isLocked()) {
    const lock = _lockState();
    const lockReason = lock.reason ?? "(no reason)";
    args.logger.info(
      `rebalance: engine locked (${lockReason}) — skipping evaluation of ${due.length} due plan${due.length === 1 ? "" : "s"}`,
    );
    for (const plan of due) {
      fires.push({
        planId: plan.id ?? 0,
        name: plan.name,
        status: "skipped",
        executed: [],
        skipped: [],
        errorCode: "ENGINE_LOCKED",
        errorMessage: `engine locked: ${lockReason}`,
      });
      skipped++;
    }
    return {
      ok: true,
      timestamp: now.toISOString(),
      due: due.length,
      executed,
      skipped,
      failed,
      completed,
      fires,
      elapsedMs: Date.now() - startedAt,
      severity: "warn",
      recommendedActions: [],
    };
  }

  due.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

  // Lazy wallet cache keyed by ${chain}:${account} — shares one keystore
  // decrypt across plans for the same account.
  type Built = {
    profile: ChainProfile;
    publicClient: PublicClient<Transport, Chain>;
    walletClient: WalletClient<Transport, Chain, Account>;
    label: string;
  };
  const built = new Map<string, Built>();
  async function ensureWallet(chain: string, account: string): Promise<Built> {
    const key = `${chain}:${account}`;
    const cached = built.get(key);
    if (cached) return cached;
    const profile = resolveProfile(chain, config);
    const extraRpcs = config.chains[chain]?.rpcs ?? [];
    const wallet = args.dryRun || !args.password
      ? loadReadOnlyWallet(profile, extraRpcs, account)
      : await loadWallet(args.password, profile, extraRpcs, args.logger, account);
    const out: Built = {
      profile,
      publicClient: wallet.publicClient,
      walletClient: wallet.walletClient,
      label: wallet.label,
    };
    built.set(key, out);
    return out;
  }

  for (const plan of due) {
    if (plan.id == null) continue;

    // Bounds: start_at / end_at / max_runs (same pattern as schedules).
    if (plan.start_at && Date.parse(plan.start_at) > now.getTime()) {
      const parsed = parseCron(plan.cron_expr);
      const nextAt = nextRun(parsed, new Date(Date.parse(plan.start_at) - 60_000));
      setRebalancePlanNextRunAt(plan.id, nextAt.toISOString());
      continue;
    }
    if (plan.end_at && Date.parse(plan.end_at) <= now.getTime()) {
      // Flip to completed directly.
      const db = (await import("./db.js")).openDb();
      db.prepare(`UPDATE rebalance_plans SET status = 'completed', updated_at = ? WHERE id = ?`).run(
        now.toISOString(), plan.id,
      );
      completed += 1;
      fires.push({ planId: plan.id, name: plan.name, status: "completed", executed: [], skipped: [] });
      continue;
    }
    if (plan.max_runs != null && plan.run_count >= plan.max_runs) {
      const db = (await import("./db.js")).openDb();
      db.prepare(`UPDATE rebalance_plans SET status = 'completed', updated_at = ? WHERE id = ?`).run(
        now.toISOString(), plan.id,
      );
      completed += 1;
      fires.push({ planId: plan.id, name: plan.name, status: "completed", executed: [], skipped: [] });
      continue;
    }

    // Compute next_run_at FIRST (so a failure-then-retry doesn't refire
    // every tick within the same minute).
    let parsed: ReturnType<typeof parseCron>;
    let nextAt: Date;
    try {
      parsed = parseCron(plan.cron_expr);
      nextAt = nextRun(parsed, now);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const db = (await import("./db.js")).openDb();
      db.prepare(
        `UPDATE rebalance_plans SET status = 'completed', last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?`,
      ).run("INVALID_PARAMS", msg, now.toISOString(), plan.id);
      completed += 1;
      fires.push({
        planId: plan.id,
        name: plan.name,
        status: "completed",
        executed: [],
        skipped: [],
        errorCode: "INVALID_PARAMS",
        errorMessage: msg,
      });
      continue;
    }

    // Targets — JSON-deserialize.
    let targets: RebalanceTarget[];
    try {
      targets = JSON.parse(plan.targets_json) as RebalanceTarget[];
    } catch {
      // The DB has corrupt JSON in targets_json — terminal.
      const db = (await import("./db.js")).openDb();
      db.prepare(
        `UPDATE rebalance_plans SET status = 'completed', last_error_code = 'INVALID_PARAMS', last_error_message = ?, updated_at = ? WHERE id = ?`,
      ).run("corrupt targets_json", now.toISOString(), plan.id);
      completed += 1;
      fires.push({
        planId: plan.id, name: plan.name, status: "completed", executed: [], skipped: [],
        errorCode: "INVALID_PARAMS", errorMessage: "corrupt targets_json",
      });
      continue;
    }

    // Fetch portfolio.
    let snapshot: PortfolioSnapshot;
    try {
      snapshot = await fetcher(plan.chain, plan.account, config, args.logger);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const code = (e as { code?: string }).code ?? "API_ERROR";
      recordRebalanceError(plan.id, nextAt.toISOString(), code, msg);
      failed += 1;
      fires.push({
        planId: plan.id, name: plan.name, status: "failed", executed: [], skipped: [],
        errorCode: code, errorMessage: msg, nextRunAt: nextAt.toISOString(),
      });
      await tryNotify(
        {
          event: "rebalance.failed",
          severity: isTransientErrorCode(code) ? "warn" : "critical",
          title: `Rebalance plan #${plan.id}${plan.name ? ` (${plan.name})` : ""} failed: ${code}`,
          body: msg,
          fields: { id: plan.id, chain: plan.chain, account: plan.account, errorCode: code, nextRunAt: nextAt.toISOString() },
          dedupKey: `rebalance.failed:${plan.id}:${code}`,
        },
        config, args.logger,
      );
      continue;
    }

    const drift = computeDrift(snapshot, targets);
    if (drift.totalUsd <= 0) {
      // Empty portfolio — nothing to rebalance. Record a skip but don't
      // count as fired (consistent with schedules' "skipped" status for
      // start_at / dry-run paths).
      recordRebalanceRun(plan.id, {
        nextRunAt: nextAt.toISOString(),
        status: "skipped",
        executedCount: 0,
        skippedCount: 0,
        maxDriftPct: 0,
        completed: false,
      });
      skipped += 1;
      fires.push({
        planId: plan.id, name: plan.name, status: "skipped",
        maxDriftPct: 0, executed: [], skipped: [],
        errorMessage: "Empty portfolio — nothing to rebalance.",
        nextRunAt: nextAt.toISOString(),
      });
      await tryNotify(
        {
          event: "rebalance.skipped",
          severity: "info",
          title: `Rebalance #${plan.id}${plan.name ? ` (${plan.name})` : ""} skipped — empty portfolio`,
          fields: { id: plan.id, chain: plan.chain, account: plan.account, reason: "empty_portfolio" },
          dedupKey: `rebalance.skipped:${plan.id}:empty`,
        },
        config, args.logger,
      );
      continue;
    }

    // Plan trades. Skip the firing path if max drift is within threshold —
    // the natural "in band, nothing to do" case.
    const trades = planRebalanceTrades(drift, {
      quoteToken: plan.quote_symbol ?? plan.quote_token,
      minTradeUsd: plan.min_trade_usd,
    });

    if (drift.maxDriftPct < plan.drift_threshold_pct || trades.steps.length === 0) {
      recordRebalanceRun(plan.id, {
        nextRunAt: nextAt.toISOString(),
        status: "skipped",
        executedCount: 0,
        skippedCount: trades.skipped.length,
        maxDriftPct: drift.maxDriftPct,
        completed: false,
      });
      skipped += 1;
      fires.push({
        planId: plan.id, name: plan.name, status: "skipped",
        maxDriftPct: drift.maxDriftPct, executed: [],
        skipped: trades.skipped.map((s) => ({ description: s.description, reason: s.reason })),
        errorMessage: `Max drift ${drift.maxDriftPct.toFixed(2)}% within threshold ${plan.drift_threshold_pct}%`,
        nextRunAt: nextAt.toISOString(),
      });
      await tryNotify(
        {
          event: "rebalance.skipped",
          severity: "info",
          title: `Rebalance #${plan.id}${plan.name ? ` (${plan.name})` : ""} in band (max drift ${drift.maxDriftPct.toFixed(2)}% ≤ ${plan.drift_threshold_pct}%)`,
          fields: {
            id: plan.id, chain: plan.chain, account: plan.account,
            maxDriftPct: drift.maxDriftPct, threshold: plan.drift_threshold_pct,
            skippedSubMin: trades.skipped.length,
          },
          dedupKey: `rebalance.skipped:${plan.id}:in_band`,
        },
        config, args.logger,
      );
      continue;
    }

    // Dry-run: don't fire, but advance next_run_at so the planner sees it
    // as having ticked.
    if (args.dryRun) {
      recordRebalanceRun(plan.id, {
        nextRunAt: nextAt.toISOString(),
        status: "skipped",
        executedCount: 0,
        skippedCount: trades.steps.length,
        maxDriftPct: drift.maxDriftPct,
        completed: false,
      });
      skipped += 1;
      fires.push({
        planId: plan.id, name: plan.name, status: "skipped",
        maxDriftPct: drift.maxDriftPct,
        executed: trades.steps.map((s) => ({ description: `[DRY-RUN] ${s.description}`, ok: true })),
        skipped: trades.skipped.map((s) => ({ description: s.description, reason: s.reason })),
        errorCode: "DRY_RUN",
        errorMessage: `Drift exceeds threshold but dry-run requested — ${trades.steps.length} trade(s) NOT fired.`,
        nextRunAt: nextAt.toISOString(),
      });
      continue;
    }

    // Real fire. Build wallet, execute each leg.
    let walletBuilt: Built;
    try {
      walletBuilt = await ensureWallet(plan.chain, plan.account);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const code = (e as { code?: string }).code ?? "WALLET_LOCKED";
      recordRebalanceError(plan.id, nextAt.toISOString(), code, msg);
      failed += 1;
      fires.push({
        planId: plan.id, name: plan.name, status: "failed", executed: [], skipped: [],
        errorCode: code, errorMessage: msg, nextRunAt: nextAt.toISOString(),
      });
      continue;
    }

    // Resolve the quote address as the resolved on-chain address from the
    // plan (we stored it lowercased at insert time).
    const quoteAddr = plan.quote_token as Address;
    const executedLegs: RebalanceFireReport["executed"] = [];
    let legFailed = 0;

    for (const step of trades.steps) {
      // Resolve the base token for this leg via the profile.
      const baseResolved = resolveBaseToken(walletBuilt.profile, step.baseToken);
      if (!baseResolved) {
        executedLegs.push({
          description: step.description,
          ok: false,
          error: `Unknown base token "${step.baseToken}" on ${plan.chain}`,
        });
        legFailed += 1;
        continue;
      }
      // For sells, baseAmount can't be computed from USD alone — we use
      // quoteAmount semantics: sell ETH for $N of USDC. For buys: buy ETH
      // with $N of USDC. quoteAmount fits both.
      const req: TradeRequest = {
        direction: step.direction,
        base: baseResolved,
        quote: quoteAddr,
        // Always specify quoteAmount in USD terms — works for both sells
        // (sell base, receive at least $N quote) and buys (spend $N quote).
        quoteAmount: step.amountUsd.toFixed(2),
        slippageBps: plan.slippage_bps ?? undefined,
        autoSlippage: plan.auto_slippage === 1,
        simulate: false,
        note: plan.note ? `[rebalance #${plan.id}] ${plan.note}` : `[rebalance #${plan.id}]`,
        strategy: plan.strategy ?? undefined,
      };
      const ctx: TradeContext = {
        publicClient: walletBuilt.publicClient,
        walletClient: walletBuilt.walletClient,
        profile: walletBuilt.profile,
        config,
        logger: args.logger,
        accountLabel: walletBuilt.label,
      };
      try {
        const result = await executeTrade(req, ctx);
        if (result.txHash && result.status !== "failed") {
          executedLegs.push({ description: step.description, ok: true, txHash: result.txHash });
        } else {
          const reason = result.simulation?.revertReason ?? "trade reverted on-chain";
          executedLegs.push({ description: step.description, ok: false, error: reason, txHash: result.txHash });
          legFailed += 1;
        }
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        executedLegs.push({ description: step.description, ok: false, error: msg });
        legFailed += 1;
      }
    }

    // Record the run + notify.
    const allOk = legFailed === 0;
    recordRebalanceRun(plan.id, {
      nextRunAt: nextAt.toISOString(),
      status: allOk ? "executed" : "executed", // we still consider partial success as "executed" — counts in last_run_executed_count
      executedCount: executedLegs.filter((l) => l.ok).length,
      skippedCount: trades.skipped.length,
      maxDriftPct: drift.maxDriftPct,
      completed:
        (plan.max_runs != null && plan.run_count + 1 >= plan.max_runs) ||
        (plan.end_at != null && Date.parse(plan.end_at) <= nextAt.getTime()),
    });

    if (allOk) {
      executed += 1;
      fires.push({
        planId: plan.id, name: plan.name, status: "executed",
        maxDriftPct: drift.maxDriftPct,
        executed: executedLegs,
        skipped: trades.skipped.map((s) => ({ description: s.description, reason: s.reason })),
        nextRunAt: nextAt.toISOString(),
      });
    } else {
      failed += 1;
      fires.push({
        planId: plan.id, name: plan.name, status: "failed",
        maxDriftPct: drift.maxDriftPct,
        executed: executedLegs,
        skipped: trades.skipped.map((s) => ({ description: s.description, reason: s.reason })),
        errorCode: "PARTIAL_FAILURE",
        errorMessage: `${legFailed} of ${trades.steps.length} leg(s) failed`,
        nextRunAt: nextAt.toISOString(),
      });
    }
    await tryNotify(
      {
        event: allOk ? "rebalance.executed" : "rebalance.failed",
        severity: allOk ? "info" : "warn",
        title: allOk
          ? `Rebalance #${plan.id}${plan.name ? ` (${plan.name})` : ""} executed (${executedLegs.length} trade(s))`
          : `Rebalance #${plan.id}${plan.name ? ` (${plan.name})` : ""} partial failure (${legFailed}/${trades.steps.length} failed)`,
        body: executedLegs.map((l) => `  ${l.ok ? "✓" : "✗"} ${l.description}${l.error ? ` — ${l.error}` : ""}`).join("\n"),
        fields: {
          id: plan.id, chain: plan.chain, account: plan.account,
          maxDriftPct: drift.maxDriftPct,
          executedCount: executedLegs.filter((l) => l.ok).length,
          failedCount: legFailed,
          skippedCount: trades.skipped.length,
          nextRunAt: nextAt.toISOString(),
        },
        dedupKey: `rebalance.${allOk ? "executed" : "failed"}:${plan.id}:${plan.run_count + 1}`,
      },
      config, args.logger,
    );
  }

  const severity: "ok" | "warn" | "critical" = failed > 0 ? "warn" : "ok";
  const recommendedActions: NextAction[] = [];
  if (failed > 0) {
    recommendedActions.push({
      tool: "rebalance_list",
      params: { status: "active", limit: 20 },
      reason: `${failed} rebalance plan(s) failed this tick — review last_error_* via \`tradekit rebalance list\` and \`tradekit rebalance show <id>\`.`,
    });
  }

  return {
    ok: true,
    timestamp: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    severity,
    due: due.length,
    executed,
    skipped,
    failed,
    completed,
    fires,
    recommendedActions,
  };
}

/** Resolve a target token entry into the address shape executeTrade
 *  expects. Reuses chains.resolveToken for symbol lookups + ETH/NATIVE
 *  sentinel handling. */
function resolveBaseToken(profile: ChainProfile, token: string): Address | "ETH" | null {
  const upper = token.trim().toUpperCase();
  if (upper === "ETH" || upper === "NATIVE") return "ETH";
  return resolveToken(profile, token);
}

// ── re-exports ───────────────────────────────────────────────

export { listRebalancePlans, getRebalancePlanById, rebalancePlanCountsByStatus };
