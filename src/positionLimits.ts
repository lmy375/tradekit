// Portfolio-aware position limits.
//
// A safety primitive that caps individual token weight as % of total
// portfolio. The existing safety pipeline gates per-trade SIZE (per-tx
// USD limit, daily USD limit, gas budget). This gates CUMULATIVE
// PORTFOLIO COMPOSITION — independent of any one trade's size, the
// concrete predicted-after-trade allocation must stay inside the
// operator-declared bands.
//
// Use cases:
//   - "Don't let any single token exceed 70% of my portfolio" → maxPct
//   - "Always keep ≥ 10% in USDC as a safety reserve" → minPct
//   - "WBTC has a 30% cap portfolio-wide" → chain: "*"
//
// Why this is a separate module (not a function in safety.ts):
// the check is asynchronous (needs portfolio + price oracle) and depends
// on holdings + portfolio aggregation logic. safety.ts is intentionally
// pure-synchronous so trade.ts can pre-flight before any RPC roundtrip.
// Position limits run AFTER the cheap config-vs-input checks pass.
//
// All math lives in pure functions (simulateDelta, applyDelta,
// evaluateLimits) so the tricky cases (wildcard chains, mixed symbol /
// address matching, multi-rule stacking, zero-portfolio edge) are
// fully unit-testable without RPC infrastructure.

import type { Address } from "viem";
import { ToolError } from "./errors.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { ChainHoldings } from "./holdings.js";

// ── types ────────────────────────────────────────────────────

export interface PositionLimit {
  /** Chain name (lowercase) or "*" for every chain. */
  chain: string;
  /** Symbol (case-insensitive) or 0x address (case-insensitive). */
  token: string;
  minPctOfPortfolio?: number;
  maxPctOfPortfolio?: number;
}

/** Flat per-token entry in the simulation snapshot. */
export interface PortfolioToken {
  chain: string;
  /** Uppercased token symbol when available (best for symbol-based limits). */
  symbol: string | null;
  /** Lowercased token address; "NATIVE" sentinel for native asset.
   *  Native ETH/BNB etc. is canonicalized to "NATIVE" so a limit against
   *  the chain's WETH address ALSO matches the native balance (operators
   *  configuring `safety.positionLimits` for "ETH" expect both). */
  address: string;
  /** USD value of this token's balance. null when unpriced. */
  usd: number | null;
}

export interface PortfolioSnapshot {
  /** Sum of usd values across all priced tokens. */
  totalUsd: number;
  /** Whether ANY priced token had a null USD value (oracle failed for it).
   *  Drives the soft-pass-with-warning behavior in evaluateLimits. */
  hasUnpriced: boolean;
  tokens: PortfolioToken[];
}

/** Predicted USD movement for one trade. Positive = added, negative = removed.
 *  A buy ETH/USDC trade is: { ETH: +estUsd, USDC: -estUsd } on chain "base". */
export interface TradeDelta {
  chain: string;
  /** Map of token address (lowercased) → USD delta. Native uses "NATIVE". */
  byAddress: Record<string, number>;
}

export interface LimitViolation {
  limit: PositionLimit;
  /** Which token in the predicted portfolio failed the limit. */
  matchedToken: {
    chain: string;
    symbol: string | null;
    address: string;
    predictedUsd: number;
  };
  predictedPct: number;
  currentPct: number;
  /** "min" or "max" — which side of the band was breached. */
  violatedBound: "min" | "max";
  boundValue: number;
}

// ── delta builders ───────────────────────────────────────────

/** Pure delta for a swap. Caller passes estimatedUsd (the USD value of the
 *  trade, which both legs share at quote price). Direction selects which
 *  leg gains and which loses.
 *
 *  baseIsNative carries the native-sentinel resolution — when true, the
 *  base side maps to "NATIVE" address-bucket; otherwise to the lowercased
 *  ERC20 address. Same for quote.
 *
 *  Returns null when estimatedUsd is unknown — the trade flow already has
 *  a separate "USD limits skipped on unpriced trades" warning; position
 *  limits inherit the same soft-skip behavior. */
export function deltaForSwap(args: {
  chain: string;
  direction: "buy" | "sell";
  estimatedUsd: number | undefined | null;
  baseAddress: Address | "ETH";
  baseIsNative: boolean;
  quoteAddress: Address;
}): TradeDelta | null {
  if (args.estimatedUsd == null || !Number.isFinite(args.estimatedUsd) || args.estimatedUsd <= 0) {
    return null;
  }
  const baseKey = args.baseIsNative || args.baseAddress === "ETH" ? "NATIVE" : (args.baseAddress as string).toLowerCase();
  const quoteKey = (args.quoteAddress as string).toLowerCase();
  const sign = args.direction === "buy" ? 1 : -1;
  return {
    chain: args.chain.toLowerCase(),
    byAddress: {
      [baseKey]: sign * args.estimatedUsd,
      [quoteKey]: -sign * args.estimatedUsd,
    },
  };
}

/** Pure delta for a transfer (send-only — removes from the balance).
 *  estimatedUsd is the USD value of the amount being sent. */
export function deltaForTransfer(args: {
  chain: string;
  estimatedUsd: number | undefined | null;
  tokenAddress: Address | "ETH" | "NATIVE";
  tokenIsNative: boolean;
}): TradeDelta | null {
  if (args.estimatedUsd == null || !Number.isFinite(args.estimatedUsd) || args.estimatedUsd <= 0) {
    return null;
  }
  const key =
    args.tokenIsNative || args.tokenAddress === "ETH" || args.tokenAddress === "NATIVE"
      ? "NATIVE"
      : (args.tokenAddress as string).toLowerCase();
  return { chain: args.chain.toLowerCase(), byAddress: { [key]: -args.estimatedUsd } };
}

// ── snapshot + apply ─────────────────────────────────────────

/** Apply a TradeDelta to a snapshot — returns a new snapshot with the USD
 *  values mutated by the delta. Tokens that exist in the delta but NOT
 *  the current snapshot are added as new entries with the delta's USD
 *  value (e.g. buying a token you don't currently hold). */
export function applyDelta(snapshot: PortfolioSnapshot, delta: TradeDelta): PortfolioSnapshot {
  // Build a fresh tokens array — we don't mutate the input.
  const tokens = snapshot.tokens.map((t) => ({ ...t }));
  const seen = new Set<string>();
  // Address-key convention: "NATIVE" sentinel kept uppercase as-is; ERC20
  // addresses lowercased. Both sides of the lookup follow this. Pre-fix:
  // applyDelta lowercased EVERY address including "NATIVE" → "native"
  // which never matched the delta's "NATIVE" key, so native-token deltas
  // silently dropped.
  const canonKey = (addr: string): string => (addr === "NATIVE" ? "NATIVE" : addr.toLowerCase());
  const normalizedDelta: Record<string, number> = {};
  for (const [k, v] of Object.entries(delta.byAddress)) normalizedDelta[canonKey(k)] = v;
  for (const t of tokens) {
    if (t.chain !== delta.chain) continue;
    const key = canonKey(t.address);
    if (normalizedDelta[key] != null) {
      seen.add(key);
      const newUsd = (t.usd ?? 0) + normalizedDelta[key];
      // Clamp to ≥ 0 — a sell can't take a balance negative; this also
      // guards a rounding-error case where the trade USD slightly
      // overshoots the holding.
      t.usd = Math.max(0, newUsd);
    }
  }
  // New tokens introduced by the delta (e.g. buying a new asset).
  for (const [rawKey, deltaUsd] of Object.entries(normalizedDelta)) {
    if (seen.has(rawKey)) continue;
    if (deltaUsd <= 0) continue; // selling a token you don't own — no-op
    tokens.push({
      chain: delta.chain,
      symbol: null, // we don't have the symbol from the delta alone
      address: rawKey,
      usd: deltaUsd,
    });
  }
  // Recompute total + unpriced flag from the new tokens.
  let totalUsd = 0;
  let hasUnpriced = false;
  for (const t of tokens) {
    if (t.usd == null) hasUnpriced = true;
    else totalUsd += t.usd;
  }
  return { totalUsd, hasUnpriced, tokens };
}

// ── limit evaluation ─────────────────────────────────────────

/** Pure predicate: does this PortfolioToken match the limit's (chain, token)
 *  selector? Wildcard `"*"` chain matches everything; otherwise exact lowercase
 *  match. Token matches by address (case-insensitive 0x) OR by symbol
 *  (case-insensitive). When the limit's token looks like an address (starts
 *  with `0x`), only address match counts (avoids "0xabcd" accidentally
 *  matching a token whose symbol happens to be "0xabcd"). */
export function limitMatchesToken(limit: PositionLimit, token: Pick<PortfolioToken, "chain" | "symbol" | "address">): boolean {
  const limitChain = limit.chain.toLowerCase();
  if (limitChain !== "*" && limitChain !== token.chain.toLowerCase()) return false;
  const limitToken = limit.token.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(limitToken)) {
    return limitToken.toLowerCase() === token.address.toLowerCase();
  }
  // Symbol match. ETH / NATIVE / WETH all alias to the chain's native asset:
  //   - The native sentinel address is "NATIVE" (set by deltaForSwap +
  //     normalizePortfolioForLimits when the native balance is present).
  //   - Operators write "ETH" in their config; chain profiles' nativeSymbol
  //     is also "ETH" / "BNB" / etc.
  //   - Our snapshot's `symbol` field is uppercased.
  const upperLimit = limitToken.toUpperCase();
  if (token.symbol == null) {
    // Fallback: native sentinel matches the chain's conventional symbols.
    if (token.address === "NATIVE" && (upperLimit === "ETH" || upperLimit === "NATIVE" || upperLimit === "BNB" || upperLimit === "POL")) {
      return true;
    }
    return false;
  }
  return token.symbol.toUpperCase() === upperLimit;
}

/** Pure: evaluate every limit against the predicted snapshot. Returns the
 *  list of violations (empty when all limits pass). The result also notes
 *  when the snapshot can't be fully priced — callers decide whether to
 *  hard-fail or soft-skip via the failOnUnpriced flag.
 *
 *  Algorithm: for each limit, find the tokens in the snapshot that match
 *  (could be multiple — e.g. wildcard chain "*" matches every chain's
 *  WBTC). Sum their USD as a single composite weight. Compare against the
 *  limit's bounds.
 *
 *  Edge cases:
 *    - Zero totalUsd: every percentage is 0; only min-bound violations
 *      can fire (and only when the min > 0 on a token with zero balance,
 *      which is desirable — empty wallet of USDC violates "min 10% USDC").
 *    - Token not in snapshot at all: contributes 0 USD to the match sum.
 *    - When the same limit matches multiple tokens (wildcard chain), we
 *      sum across them.
 */
export function evaluateLimits(
  current: PortfolioSnapshot,
  predicted: PortfolioSnapshot,
  limits: readonly PositionLimit[],
): { violations: LimitViolation[]; hasUnpricedPredicted: boolean } {
  const violations: LimitViolation[] = [];
  for (const limit of limits) {
    // Gather all snapshot tokens that match this limit's selector.
    const matchedPredicted = predicted.tokens.filter((t) => limitMatchesToken(limit, t));
    const matchedCurrent = current.tokens.filter((t) => limitMatchesToken(limit, t));

    // Sum USD across matches.
    const predictedUsd = sumPriced(matchedPredicted);
    const currentUsd = sumPriced(matchedCurrent);

    // Percentages relative to total portfolio USD. Guard division by zero —
    // when the snapshot has no priced tokens at all, every match is 0 USD
    // and we just compare against the 0 case.
    const predictedPct = predicted.totalUsd > 0 ? (predictedUsd / predicted.totalUsd) * 100 : 0;
    const currentPct = current.totalUsd > 0 ? (currentUsd / current.totalUsd) * 100 : 0;

    if (limit.maxPctOfPortfolio != null && predictedPct > limit.maxPctOfPortfolio) {
      violations.push({
        limit,
        matchedToken: {
          chain: matchedPredicted[0]?.chain ?? limit.chain,
          symbol: matchedPredicted[0]?.symbol ?? null,
          address: matchedPredicted[0]?.address ?? limit.token,
          predictedUsd,
        },
        predictedPct,
        currentPct,
        violatedBound: "max",
        boundValue: limit.maxPctOfPortfolio,
      });
    }
    if (limit.minPctOfPortfolio != null && predictedPct < limit.minPctOfPortfolio) {
      // We violate the floor only when the predicted is BELOW current's
      // — i.e. the trade is the cause. If the floor was already violated
      // BEFORE the trade (operator drifted there manually), don't block
      // a trade that doesn't make things worse. Otherwise we'd permanently
      // deadlock all trading after a single drift.
      if (predictedPct < currentPct - 1e-9) {
        violations.push({
          limit,
          matchedToken: {
            chain: matchedPredicted[0]?.chain ?? limit.chain,
            symbol: matchedPredicted[0]?.symbol ?? null,
            address: matchedPredicted[0]?.address ?? limit.token,
            predictedUsd,
          },
          predictedPct,
          currentPct,
          violatedBound: "min",
          boundValue: limit.minPctOfPortfolio,
        });
      }
    }
  }
  return { violations, hasUnpricedPredicted: predicted.hasUnpriced };
}

function sumPriced(tokens: PortfolioToken[]): number {
  let s = 0;
  for (const t of tokens) if (t.usd != null) s += t.usd;
  return s;
}

// ── enforcement wrapper ──────────────────────────────────────

/** Snapshot fetcher contract. The trade flow injects a callable so this
 *  module stays decoupled from holdings.ts (which has heavy RPC deps).
 *  Tests inject a deterministic mock. */
export type PortfolioFetcher = () => Promise<PortfolioSnapshot>;

export interface EnforcePositionLimitsArgs {
  chain: string;
  delta: TradeDelta | null;
  config: Config;
  logger: Logger;
  /** Async function that returns the current portfolio snapshot. Called
   *  exactly once when limits are configured. */
  fetchPortfolio: PortfolioFetcher;
}

/**
 * Main enforcement entry: applies the delta to a freshly-fetched portfolio,
 * evaluates every configured limit, and throws POSITION_LIMIT_EXCEEDED on
 * the first violation.
 *
 * Skip-fast paths:
 *   - safety.enabled === false → skip entirely.
 *   - safety.positionLimits undefined / empty → skip entirely (no fetch).
 *   - delta === null (unpriced trade) → log warning + skip the check
 *     (matches the existing iter-405 "USD limits skipped on unpriced" pattern).
 *
 * Unpriced portfolio (oracle outage during the fetch) → log warning + skip
 * the check, unless `safety.positionLimitsFailOnUnpriced` is true.
 *
 * Returns the violations list (empty on pass) — used by the test harness
 * to verify the soft-skip paths without observing thrown errors.
 */
export async function enforcePositionLimits(args: EnforcePositionLimitsArgs): Promise<LimitViolation[]> {
  const s = args.config.safety;
  if (!s.enabled) {
    args.logger.debug("position-limits: safety disabled — skipping");
    return [];
  }
  const limits = s.positionLimits;
  if (!limits || limits.length === 0) {
    return [];
  }
  if (args.delta == null) {
    args.logger.warn(
      "position-limits: trade USD value unknown — skipping position-limit checks. " +
        "Other safety rails still apply.",
    );
    return [];
  }
  // Filter limits to those that COULD match this chain. A wildcard "*"
  // limit always could; a chain-specific limit only when it matches.
  const relevant = limits.filter((l) => l.chain === "*" || l.chain.toLowerCase() === args.chain.toLowerCase());
  if (relevant.length === 0) return [];

  let current: PortfolioSnapshot;
  try {
    current = await args.fetchPortfolio();
  } catch (e) {
    if (s.positionLimitsFailOnUnpriced) {
      throw new ToolError(
        "POSITION_LIMIT_EXCEEDED",
        `Position-limit check failed: could not fetch portfolio snapshot (${(e as Error).message}).`,
        {
          details: { reason: "portfolio_fetch_failed", message: (e as Error).message },
        },
      );
    }
    args.logger.warn(
      `position-limits: portfolio fetch failed (${(e as Error).message}) — skipping check. ` +
        "Other safety rails still apply. Set safety.positionLimitsFailOnUnpriced=true to fail closed instead.",
    );
    return [];
  }

  const predicted = applyDelta(current, args.delta);
  const evaluation = evaluateLimits(current, predicted, relevant);

  if (evaluation.hasUnpricedPredicted && s.positionLimitsFailOnUnpriced) {
    throw new ToolError(
      "POSITION_LIMIT_EXCEEDED",
      `Position-limit check failed: portfolio contains tokens with unknown USD price (cannot compute composition exactly).`,
      { details: { reason: "portfolio_unpriced", failOnUnpriced: true } },
    );
  }
  if (evaluation.hasUnpricedPredicted) {
    args.logger.warn(
      "position-limits: at least one held token couldn't be priced — composition computed against priced subset only. Set safety.positionLimitsFailOnUnpriced=true for strict enforcement.",
    );
  }

  if (evaluation.violations.length === 0) {
    args.logger.debug("position-limits: predicted composition stays within all configured bands");
    return [];
  }

  // Throw on the first violation — the structured details name EXACTLY
  // which limit hit, current vs predicted %, and the target band. The
  // CLI / MCP error path renders this so operators see a one-shot
  // remediation (resize the trade, or rebalance the offending token
  // FIRST).
  const v = evaluation.violations[0];
  const bandDesc =
    v.violatedBound === "max"
      ? `≤ ${v.boundValue}%`
      : `≥ ${v.boundValue}%`;
  const tokenLabel = v.matchedToken.symbol ?? v.limit.token;
  throw new ToolError(
    "POSITION_LIMIT_EXCEEDED",
    `Position limit tripped: ${tokenLabel} on ${v.limit.chain} predicted ${v.predictedPct.toFixed(1)}% of portfolio after trade (target ${bandDesc}; currently ${v.currentPct.toFixed(1)}%).`,
    {
      details: {
        chain: v.limit.chain,
        token: v.limit.token,
        violatedBound: v.violatedBound,
        boundValue: v.boundValue,
        currentPct: round(v.currentPct, 2),
        predictedPct: round(v.predictedPct, 2),
        currentUsd: round(v.currentPct * (predicted.totalUsd / 100), 2),
        predictedUsd: round(v.matchedToken.predictedUsd, 2),
        totalUsd: round(predicted.totalUsd, 2),
        // Iter309-style additional violations: when multiple limits fire,
        // surface them all in details for an at-a-glance fix-the-set view.
        // Don't throw multiple ToolErrors — one structured error with the
        // full list keeps the agent's branch logic simple (single catch).
        additionalViolations: evaluation.violations.slice(1).map((extra) => ({
          chain: extra.limit.chain,
          token: extra.limit.token,
          violatedBound: extra.violatedBound,
          boundValue: extra.boundValue,
          currentPct: round(extra.currentPct, 2),
          predictedPct: round(extra.predictedPct, 2),
        })),
      },
      nextActions: [
        {
          tool: "portfolio",
          params: {},
          reason: `Inspect current composition with \`tradekit portfolio\`. To fix: either resize this trade so ${tokenLabel} stays within ${bandDesc}, or rebalance the offending position FIRST (sell ${tokenLabel} if over max, or top up if under min).`,
        },
      ],
    },
  );
}

function round(n: number, places: number): number {
  const m = Math.pow(10, places);
  return Math.round(n * m) / m;
}

// ── holdings → snapshot adapter ──────────────────────────────

/**
 * Convert one-or-more chains' ChainHoldings reports (from holdings.ts) into
 * the flat PortfolioSnapshot shape expected by evaluateLimits. Native
 * balances become entries with address "NATIVE" + chain-appropriate symbol.
 *
 * Pure — no I/O. Tested via the trade flow's integration smoke; pure-unit
 * tests live alongside the rest of positionLimits.test.ts where useful.
 */
export function chainHoldingsToSnapshot(reports: readonly ChainHoldings[]): PortfolioSnapshot {
  const tokens: PortfolioToken[] = [];
  let totalUsd = 0;
  let hasUnpriced = false;
  for (const report of reports) {
    for (const balance of report.balances) {
      // Filter dust + zeros — they're not meaningful for composition.
      // A balance with amount "0" can still appear in `balances` (the
      // scan walks every chain-profile token); skipping keeps the
      // snapshot small.
      const amount = parseFloat(balance.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const isNative = balance.token === "NATIVE";
      const address = isNative ? "NATIVE" : (balance.token as string).toLowerCase();
      const usd = balance.usd ?? null;
      if (usd == null) hasUnpriced = true;
      else totalUsd += usd;
      tokens.push({
        chain: report.chain,
        symbol: balance.symbol ? balance.symbol.toUpperCase() : null,
        address,
        usd,
      });
    }
  }
  return { totalUsd, hasUnpriced, tokens };
}
