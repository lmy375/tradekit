// ──────────────────────────────────────────────────────────────────
// Batch price fetch (iter38): one entry point for fetching prices
// for N tokens with minimal HTTP traffic.
//
// Pre-iter38 the orders engine called `getCurrentPrice(token)` per
// active row inside a loop. On a cache-cold tick with 15 distinct
// tokens that was 15 separate HTTP calls — and CoinGecko's
// `/simple/price?ids=...,...` endpoint trivially supports N tokens
// in one call. This module exploits that, plus parallelizes the
// non-CoinGecko-mapped tokens' DexScreener fallback via
// Promise.allSettled.
//
// Design:
//
//   1. SINGLE entry point `getCurrentPrices(addresses, logger)`.
//      Returns a Map<address-lower, price-or-null>. Existing
//      `getCurrentPrice` becomes a thin wrapper that calls this
//      with a 1-element array.
//
//   2. Cache-first. Every address goes through the price.ts
//      cache (which already has 60s success / 15s null TTL + FIFO
//      eviction). Misses go to providers; hits short-circuit.
//
//   3. In-flight dedup preserved. The existing
//      `priceInFlight` map (per-token Promise sharing) stays —
//      this module ADDS a batch path, doesn't replace the
//      single-token concurrency guarantees.
//
//   4. CoinGecko first. Tokens with a known coinId go into ONE
//      batched call. Tokens without go directly to DexScreener
//      (per-token, but parallel).
//
//   5. CoinGecko URL is bounded. Chunked at 250 ids per call to
//      stay well under any URL length limit.
//
//   6. Per-call stats. Every HTTP call records a ProviderCall
//      to priceStats — operators see batch-level "tokens
//      requested" + "tokens returned" + latency p50/p95.
// ──────────────────────────────────────────────────────────────────

import { fetchWithTimeout } from "./http.js";
import { getCoinGeckoId } from "./price.js";
import { recordProviderCall, classifyFetchError } from "./priceStats.js";
import type { Logger } from "./logger.js";

// ── shared cache + in-flight (re-exported from price.ts at runtime) ─

import {
  priceCache as _priceCache,
  priceInFlight as _priceInFlight,
  PRICE_CACHE_TTL as _PRICE_CACHE_TTL,
  PRICE_NEGATIVE_TTL as _PRICE_NEGATIVE_TTL,
  PRICE_CACHE_MAX as _PRICE_CACHE_MAX,
  evictIfOverCap as _evictIfOverCap,
} from "./priceCacheShared.js";

// Re-bind so the rest of this module reads naturally.
const priceCache = _priceCache;
const priceInFlight = _priceInFlight;
const PRICE_CACHE_TTL = _PRICE_CACHE_TTL;
const PRICE_NEGATIVE_TTL = _PRICE_NEGATIVE_TTL;
const PRICE_CACHE_MAX = _PRICE_CACHE_MAX;
const evictIfOverCap = _evictIfOverCap;

// ── tunables ────────────────────────────────────────────────

/** Max CoinGecko ids per single `/simple/price?ids=...` request.
 *  CoinGecko's docs don't publish a hard cap, but 250 keeps the
 *  URL under 5KB even with longish ids. */
const COINGECKO_BATCH_CHUNK = 250;

/** Timeout per provider call. Matches the existing per-token
 *  fetchWithTimeout default. */
const DEFAULT_TIMEOUT_MS = 10_000;

// ── public API ──────────────────────────────────────────────

/** Fetch USD prices for many tokens. Returns a Map keyed by
 *  lowercased address. Tokens with no usable price come back as
 *  `null` rather than being omitted — callers iterating their
 *  input array always find an entry. */
export async function getCurrentPrices(
  addresses: readonly string[],
  logger: Logger,
  opts: { injects?: BatchInjections } = {},
): Promise<Map<string, number | null>> {
  const inject = opts.injects ?? {};
  const result = new Map<string, number | null>();
  // Normalize + dedupe.
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const a of addresses) {
    const lower = a.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    unique.push(lower);
  }

  // Phase 1: cache lookup.
  const missing: string[] = [];
  for (const lower of unique) {
    const cached = priceCache.get(lower);
    if (cached) {
      const ttl = cached.data == null ? PRICE_NEGATIVE_TTL : PRICE_CACHE_TTL;
      if (Date.now() - cached.timestamp < ttl) {
        result.set(lower, cached.data);
        continue;
      }
    }
    missing.push(lower);
  }
  if (missing.length === 0) return result;

  // Phase 2: dedup against in-flight Promises. Tokens whose fetch
  // is currently in flight (from another caller — e.g. a
  // concurrent strategy report) share that Promise and never
  // duplicate the call.
  const pendingShared: Array<{ token: string; p: Promise<number | null> }> = [];
  const stillMissing: string[] = [];
  for (const lower of missing) {
    const p = priceInFlight.get(lower);
    if (p) {
      pendingShared.push({ token: lower, p });
    } else {
      stillMissing.push(lower);
    }
  }

  // Phase 3: split misses into CoinGecko-mapped vs unmapped.
  const coinGeckoMapped: Array<{ token: string; coinId: string }> = [];
  const onlyDexScreener: string[] = [];
  for (const lower of stillMissing) {
    const coinId = getCoinGeckoId(lower);
    if (coinId) coinGeckoMapped.push({ token: lower, coinId });
    else onlyDexScreener.push(lower);
  }

  // Phase 4: dispatch. We create a shared Promise per token so
  // concurrent calls (from a parallel strategy report invocation
  // or a web request) hit the in-flight dedup.
  const tokenPromises = new Map<string, Promise<number | null>>();

  // 4a. CoinGecko batch — one HTTP call per chunk.
  if (coinGeckoMapped.length > 0) {
    // Group: each chunk's resolved Promise resolves the same
    // value for every token in the chunk. We use a deferred-style
    // pattern: pre-create per-token promises whose resolvers fire
    // when the batch HTTP call completes.
    type Resolver = (price: number | null) => void;
    const resolvers = new Map<string, Resolver>();
    for (const { token } of coinGeckoMapped) {
      const promise = new Promise<number | null>((resolve) => {
        resolvers.set(token, resolve);
      });
      tokenPromises.set(token, promise);
      priceInFlight.set(token, promise);
    }

    const chunks: Array<Array<{ token: string; coinId: string }>> = [];
    for (let i = 0; i < coinGeckoMapped.length; i += COINGECKO_BATCH_CHUNK) {
      chunks.push(coinGeckoMapped.slice(i, i + COINGECKO_BATCH_CHUNK));
    }

    // Fire chunks in parallel. Each one's success/failure resolves
    // its own tokens; failures fall through to DexScreener for
    // each affected token.
    void Promise.all(
      chunks.map(async (chunk) => {
        const t0 = Date.now();
        let returnedMap: Record<string, { usd: number }> | null = null;
        let errorCode: string | undefined;
        try {
          const ids = chunk.map((c) => c.coinId).join(",");
          const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
          returnedMap = await (inject.coinGeckoFetchFn ?? defaultCoinGeckoFetch)(url);
        } catch (e) {
          errorCode = classifyFetchError(e);
          logger.debug(`CoinGecko batch fetch failed (${chunk.length} tokens): ${(e as Error).message}`);
        }
        const latencyMs = Date.now() - t0;

        // Track how many tokens in this chunk got a price.
        let tokensReturned = 0;
        const fallbackTokens: string[] = [];
        for (const { token, coinId } of chunk) {
          const cgPrice = returnedMap?.[coinId]?.usd ?? null;
          if (cgPrice != null) {
            tokensReturned += 1;
            cacheAndResolve(token, cgPrice, resolvers);
          } else {
            // No CoinGecko price → DexScreener fallback.
            fallbackTokens.push(token);
          }
        }
        recordProviderCall("coingecko", {
          ok: returnedMap != null,
          latencyMs,
          tokensRequested: chunk.length,
          tokensReturned,
          errorCode,
        });

        // Fire DexScreener fallback for the unmatched tokens in
        // this chunk. Parallel via Promise.allSettled — each
        // token's resolver fires independently.
        if (fallbackTokens.length > 0) {
          await Promise.allSettled(
            fallbackTokens.map((token) => fallbackToDexScreener(token, logger, resolvers, inject)),
          );
        }
      }),
    ).catch((e) => {
      logger.error(`priceBatch: outer chunk promise rejection (should be unreachable): ${(e as Error).message}`);
    });
  }

  // 4b. Tokens without a CoinGecko mapping go straight to
  // DexScreener.
  if (onlyDexScreener.length > 0) {
    type Resolver = (price: number | null) => void;
    const resolvers = new Map<string, Resolver>();
    for (const token of onlyDexScreener) {
      const promise = new Promise<number | null>((resolve) => {
        resolvers.set(token, resolve);
      });
      tokenPromises.set(token, promise);
      priceInFlight.set(token, promise);
    }
    void Promise.allSettled(
      onlyDexScreener.map((token) => fallbackToDexScreener(token, logger, resolvers, inject)),
    );
  }

  // Phase 5: await every per-token promise + populate the result
  // map. Pending-shared promises (from concurrent in-flight) are
  // awaited as-is.
  await Promise.all([
    ...pendingShared.map(async ({ token, p }) => {
      try {
        const v = await p;
        result.set(token, v ?? null);
      } catch {
        result.set(token, null);
      }
    }),
    ...Array.from(tokenPromises.entries()).map(async ([token, p]) => {
      try {
        const v = await p;
        result.set(token, v ?? null);
      } catch {
        result.set(token, null);
      }
    }),
  ]);

  // Ensure every input has an entry (defensive — should already
  // be the case given the loops above).
  for (const lower of unique) {
    if (!result.has(lower)) result.set(lower, null);
  }

  return result;
}

// ── DexScreener fallback ────────────────────────────────────

async function fallbackToDexScreener(
  token: string,
  logger: Logger,
  resolvers: Map<string, (p: number | null) => void>,
  inject: BatchInjections,
): Promise<void> {
  const t0 = Date.now();
  let price: number | null = null;
  let errorCode: string | undefined;
  try {
    price = await (inject.dexScreenerFetchFn ?? defaultDexScreenerFetch)(token);
  } catch (e) {
    errorCode = classifyFetchError(e);
    logger.debug(`DexScreener fetch failed for ${token}: ${(e as Error).message}`);
  }
  recordProviderCall("dexscreener", {
    ok: errorCode == null,
    latencyMs: Date.now() - t0,
    tokensRequested: 1,
    tokensReturned: price != null ? 1 : 0,
    errorCode,
  });
  cacheAndResolve(token, price, resolvers);
}

/** Write to cache + fire the per-token resolver. Eviction is best-
 *  effort — never blocks the resolver path. */
function cacheAndResolve(
  token: string,
  price: number | null,
  resolvers: Map<string, (p: number | null) => void>,
): void {
  priceCache.set(token, { data: price, timestamp: Date.now() });
  evictIfOverCap(priceCache, PRICE_CACHE_MAX);
  const r = resolvers.get(token);
  if (r) r(price);
  priceInFlight.delete(token);
}

// ── default provider fetchers (injection-overridable for tests) ──

async function defaultCoinGeckoFetch(url: string): Promise<Record<string, { usd: number }>> {
  const res = await fetchWithTimeout(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) }, { retries: 2 });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return (await res.json()) as Record<string, { usd: number }>;
}

async function defaultDexScreenerFetch(token: string): Promise<number | null> {
  const res = await fetchWithTimeout(
    `https://api.dexscreener.com/latest/dex/tokens/${token}`,
    { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) },
    { retries: 2 },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    pairs?: { priceUsd?: string; liquidity?: { usd?: number } }[];
  };
  // Pick the pair with highest liquidity (mirrors price.ts).
  if (!data.pairs || data.pairs.length === 0) return null;
  let bestPrice: number | null = null;
  let bestLiquidity = -Infinity;
  for (const p of data.pairs) {
    const liq = p.liquidity?.usd ?? 0;
    const price = p.priceUsd ? parseFloat(p.priceUsd) : null;
    if (price != null && liq > bestLiquidity) {
      bestLiquidity = liq;
      bestPrice = price;
    }
  }
  return bestPrice;
}

// ── test injection ─────────────────────────────────────────

/** Override seams for tests. Production callers leave undefined.
 *  Each function returns the raw provider payload OR throws on
 *  network error (which the caller catches + classifies). */
export interface BatchInjections {
  /** CoinGecko `/simple/price?ids=...` response shape. */
  coinGeckoFetchFn?: (url: string) => Promise<Record<string, { usd: number }>>;
  /** DexScreener per-token price lookup → null when no pair. */
  dexScreenerFetchFn?: (token: string) => Promise<number | null>;
}

// ── single-token convenience (for parity with price.ts API) ──

/** Single-token convenience over getCurrentPrices. Exposes the
 *  same legacy contract callers depend on. */
export async function getCurrentPriceBatched(
  tokenAddress: string,
  logger: Logger,
  opts?: { injects?: BatchInjections },
): Promise<number | null> {
  const m = await getCurrentPrices([tokenAddress], logger, opts);
  return m.get(tokenAddress.toLowerCase()) ?? null;
}
