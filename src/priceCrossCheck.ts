// Iter613: cross-source price sanity check. Pre-iter613 getCurrentPrice
// used CoinGecko + DexScreener as a fallback chain (try first, fall back
// to second on null) — never comparing them. An aggregator returning a
// manipulated quote (DEX pool spoof, stale liquidity, honeypot price
// trick) would pass preview because the single oracle queried agrees with
// the on-chain pool that's been spoofed.
//
// This module fans out to BOTH sources in parallel and compares. The verdict:
//   - ok: prices agree within tolerance (default 5%)
//   - suspicious: prices diverge between tolerance and extreme threshold
//                 (e.g. 5-20% apart — manipulated pool, low liquidity, stale data)
//   - extreme: divergence beyond extreme threshold (>20% by default — almost
//              certainly a honeypot price trick or completely stale data)
//   - one_source: only one source returned a price (the other timed out
//                 or doesn't know this token) — verdict unknown, but
//                 we surface the single price for the caller's decision
//   - unknown: neither source returned a price (totally untracked token)
//
// Tolerance/extreme defaults match what production trading desks use:
//   - 5% tolerance: routine slippage + stale-but-not-dangerous data
//   - 20% extreme: aggressive manipulation, honeypot, or off-chain pricing error

import type { Logger } from "./logger.js";
import { getCoinGeckoId, priceFromCoinGecko, priceFromDexScreener } from "./price.js";

export type PriceCheckVerdict = "ok" | "suspicious" | "extreme" | "one_source" | "unknown";

export interface PriceCrossCheck {
  /** Lowercased input address. */
  token: string;
  /** Price from CoinGecko (USD per token) — null when not available. */
  coinGeckoPrice: number | null;
  /** Price from DexScreener (USD per token) — null when not available. */
  dexScreenerPrice: number | null;
  /** Absolute USD difference (max - min) when both prices exist. Null otherwise. */
  absoluteDiff: number | null;
  /** Relative divergence: |a - b| / min(a, b) × 100. Null when one or both missing. */
  divergencePct: number | null;
  /** Tolerance and extreme thresholds the verdict was computed with. */
  tolerancePct: number;
  extremePct: number;
  verdict: PriceCheckVerdict;
  /** Human-readable explanation. */
  reason: string;
  timestamp: string;
}

export const DEFAULT_TOLERANCE_PCT = 5;
export const DEFAULT_EXTREME_PCT = 20;

/**
 * Iter613: pure verdict logic. Given two source prices + thresholds, derive
 * the verdict. Split for unit testing — no HTTP, no logger.
 */
export function computeCrossCheckVerdict(args: {
  coinGeckoPrice: number | null;
  dexScreenerPrice: number | null;
  tolerancePct: number;
  extremePct: number;
}): {
  verdict: PriceCheckVerdict;
  reason: string;
  absoluteDiff: number | null;
  divergencePct: number | null;
} {
  const a = args.coinGeckoPrice;
  const b = args.dexScreenerPrice;

  if (a == null && b == null) {
    return {
      verdict: "unknown",
      reason: "Neither CoinGecko nor DexScreener returned a price for this token. May be a brand-new or untracked token.",
      absoluteDiff: null,
      divergencePct: null,
    };
  }

  if (a == null || b == null) {
    const source = a != null ? "CoinGecko" : "DexScreener";
    const price = a ?? b ?? 0;
    return {
      verdict: "one_source",
      reason: `Only ${source} returned a price ($${price}). The other source didn't recognize this token or timed out — cross-check not possible.`,
      absoluteDiff: null,
      divergencePct: null,
    };
  }

  // Both numbers — compute divergence.
  // Use min as denominator for the "from the smaller side" reading.
  // If a price went to zero (degenerate), treat as extreme to surface loudly.
  if (a === 0 || b === 0) {
    return {
      verdict: "extreme",
      reason: `One source reports zero (CoinGecko $${a}, DexScreener $${b}). One of the sources has stale or corrupted data.`,
      absoluteDiff: Math.abs(a - b),
      divergencePct: Infinity,
    };
  }

  const absoluteDiff = Math.abs(a - b);
  const divergencePct = (absoluteDiff / Math.min(a, b)) * 100;

  if (divergencePct >= args.extremePct) {
    return {
      verdict: "extreme",
      reason: `Sources diverge by ${divergencePct.toFixed(1)}% (CoinGecko $${a}, DexScreener $${b}) — beyond the ${args.extremePct}% extreme threshold. Likely a manipulated pool, honeypot price trick, or critically stale data. Do NOT trade on this token until you understand why the sources disagree.`,
      absoluteDiff,
      divergencePct,
    };
  }
  if (divergencePct >= args.tolerancePct) {
    return {
      verdict: "suspicious",
      reason: `Sources diverge by ${divergencePct.toFixed(1)}% (CoinGecko $${a}, DexScreener $${b}) — beyond the ${args.tolerancePct}% normal-slippage threshold. Could be low liquidity, stale data, or a slightly manipulated pool. Verify before trading.`,
      absoluteDiff,
      divergencePct,
    };
  }
  return {
    verdict: "ok",
    reason: `Sources agree within ${divergencePct.toFixed(1)}% (CoinGecko $${a}, DexScreener $${b}) — within the ${args.tolerancePct}% tolerance.`,
    absoluteDiff,
    divergencePct,
  };
}

/**
 * Run the cross-check. Fans out to both sources in PARALLEL (not the fallback
 * chain that getCurrentPrice uses) so we always see both numbers for comparison.
 */
export async function crossCheckPrice(args: {
  tokenAddress: string;
  logger: Logger;
  tolerancePct?: number;
  extremePct?: number;
}): Promise<PriceCrossCheck> {
  const tolerancePct = args.tolerancePct ?? DEFAULT_TOLERANCE_PCT;
  const extremePct = args.extremePct ?? DEFAULT_EXTREME_PCT;
  const tokenLower = args.tokenAddress.toLowerCase();
  const coinId = getCoinGeckoId(tokenLower);

  // Parallel fetch. CoinGecko query is no-op when we don't have a mapping —
  // skip it to avoid an unhelpful 404 in the logs.
  const [cg, ds] = await Promise.all([
    coinId ? priceFromCoinGecko(coinId, args.logger) : Promise.resolve(null),
    priceFromDexScreener(tokenLower, args.logger),
  ]);

  const { verdict, reason, absoluteDiff, divergencePct } = computeCrossCheckVerdict({
    coinGeckoPrice: cg,
    dexScreenerPrice: ds,
    tolerancePct,
    extremePct,
  });

  return {
    token: tokenLower,
    coinGeckoPrice: cg,
    dexScreenerPrice: ds,
    absoluteDiff,
    divergencePct,
    tolerancePct,
    extremePct,
    verdict,
    reason,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Iter613: convenience — short single-line verdict for at-a-glance display.
 */
export function shortVerdictLine(check: PriceCrossCheck): string {
  switch (check.verdict) {
    case "ok":
      return `🟢 OK — CoinGecko $${check.coinGeckoPrice} vs DexScreener $${check.dexScreenerPrice} (${check.divergencePct?.toFixed(1)}% apart)`;
    case "suspicious":
      return `🟡 SUSPICIOUS — sources diverge by ${check.divergencePct?.toFixed(1)}% (CG $${check.coinGeckoPrice}, DS $${check.dexScreenerPrice})`;
    case "extreme":
      return `🔴 EXTREME — sources diverge by ${check.divergencePct === Infinity ? "∞" : check.divergencePct?.toFixed(1) + "%"} (CG $${check.coinGeckoPrice}, DS $${check.dexScreenerPrice})`;
    case "one_source":
      return `⚪ ONE SOURCE — ${check.coinGeckoPrice != null ? `CoinGecko $${check.coinGeckoPrice}` : `DexScreener $${check.dexScreenerPrice}`} (other source unavailable)`;
    case "unknown":
      return `⚪ UNKNOWN — neither CoinGecko nor DexScreener recognizes this token`;
  }
}
