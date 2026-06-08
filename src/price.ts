import type { Logger } from "./logger.js";
import { fetchWithTimeout } from "./http.js";
import { ToolError } from "./errors.js";
import { closestMatch } from "./format.js";
// Iter38: per-provider observability. Every CoinGecko / DexScreener
// call records a ProviderCall so `tradekit price stats` can show
// the operator hit rates, latencies, rate-limit incidents.
import { recordProviderCall, classifyFetchError } from "./priceStats.js";

// CoinGecko ID mapping for common tokens. Used first for major tokens since CoinGecko has
// authoritative pricing & history. When CoinGecko rate-limits or returns N/A, we fall back
// to DexScreener which has no rate limit and broad coverage of EVM tokens.
//
// Iter239: keys are stored lowercase so getCoinGeckoId() can do a case-insensitive
// lookup. Pre-iter239 keys were a mix of checksum and lowercase; a caller passing the
// SAME address but in different casing (web /api/price from any client, an MCP user
// pasting a lowercased address, holdings.ts later flowing a lowercased token through)
// would silently miss CoinGecko and fall through to DexScreener — same price answer
// in most cases, but extra latency, an unnecessary upstream call, and one rate-limit
// budget step burned for nothing. EVM addresses are case-insensitive (EIP-55 checksum
// is a presentation convenience), so a case-insensitive lookup is the honest one.
const COINGECKO_IDS: Record<string, string> = {
  // WETH / ETH on multiple chains
  "0x4200000000000000000000000000000000000006": "ethereum", // WETH on Base / Optimism
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "ethereum", // WETH on Ethereum
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "ethereum", // WETH on Arbitrum
  // USDC
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "usd-coin",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "usd-coin",
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": "usd-coin",
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85": "usd-coin",
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "usd-coin",
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "usd-coin",
  // BNB
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "binancecoin",
};

// Iter38: price/inFlight caches + TTL constants moved to
// ./priceCacheShared.js so priceBatch.ts can read from the SAME
// cache (avoid circular import). Behavior unchanged.
import {
  priceCache,
  priceInFlight,
  PRICE_CACHE_TTL,
  PRICE_NEGATIVE_TTL,
  PRICE_CACHE_MAX,
  evictIfOverCap,
  type CacheEntry,
} from "./priceCacheShared.js";

const historyCache = new Map<string, CacheEntry<HistoryData>>();

const HISTORY_CACHE_TTL = 300_000; // 5min
const HISTORY_CACHE_MAX = 200;

interface HistoryData {
  prices: [number, number][];
}

const PERIOD_DAYS: Record<string, number> = { "1d": 1, "1w": 7, "1m": 30, "1y": 365 };

async function fetchJson<T>(url: string): Promise<T> {
  // Price fetches are idempotent GETs against rate-sensitive third parties (CoinGecko
  // free tier especially). Retry budget = 2: catches transient 429/503/timeout that
  // would otherwise mark a token unpriced and cascade into "(+N unpriced)" notes.
  const res = await fetchWithTimeout(url, undefined, { retries: 2 });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function getCoinGeckoId(tokenAddress: string): string | undefined {
  // Lowercase here (and lowercase storage above) so an upstream caller passing a
  // checksummed OR lowercased OR upper-cased address all hit the same row.
  return COINGECKO_IDS[tokenAddress.toLowerCase()];
}

// Iter613: exported so priceCrossCheck.ts can call CoinGecko directly without
// going through the fallback chain in getCurrentPrice. The two-source divergence
// check NEEDS both sources, not just whichever responded first.
export async function priceFromCoinGecko(coinId: string, logger: Logger): Promise<number | null> {
  const t0 = Date.now();
  try {
    const data = await fetchJson<Record<string, { usd: number }>>(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
    );
    const price = data[coinId]?.usd ?? null;
    recordProviderCall("coingecko", {
      ok: true,
      latencyMs: Date.now() - t0,
      tokensRequested: 1,
      tokensReturned: price != null ? 1 : 0,
    });
    return price;
  } catch (e) {
    recordProviderCall("coingecko", {
      ok: false,
      latencyMs: Date.now() - t0,
      tokensRequested: 1,
      tokensReturned: 0,
      errorCode: classifyFetchError(e),
    });
    logger.debug(`CoinGecko price fetch failed: ${(e as Error).message}`);
    return null;
  }
}

// Iter654: in-memory cache for historical price lookups keyed by (coinId, date).
// Date queries are EXPENSIVE on CoinGecko's free tier (rate-limited + slow);
// every legacy trade backfill needs the same date possibly across many tokens
// only when natives are also on different days. Dedupe by (coinId, DD-MM-YYYY)
// so a 200-row backfill with mostly-same-day trades hits the API a handful
// of times rather than 200 times.
const historicalPriceCache = new Map<string, number | null>();

/**
 * Iter654: historical USD price for a CoinGecko-listed token at a given date.
 * Uses the `/coins/{id}/history?date=DD-MM-YYYY` endpoint (free tier
 * supported). Returns null for non-CoinGecko-listed tokens, API failures, or
 * dates where the token didn't yet exist.
 *
 * `isoDate` accepts any ISO timestamp — we extract the YYYY-MM-DD portion
 * and reformat to CoinGecko's DD-MM-YYYY convention.
 *
 * Cached by (coinId, date) — repeat queries on a backfill walk hit the same
 * date repeatedly when an operator made many trades same day, so dedup is
 * essential.
 */
export async function getHistoricalPrice(
  tokenAddress: string,
  isoDate: string,
  logger: Logger,
): Promise<number | null> {
  const coinId = getCoinGeckoId(tokenAddress);
  if (!coinId) return null;
  // Extract YYYY-MM-DD then reformat to DD-MM-YYYY (CoinGecko's convention).
  const ymd = isoDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [year, month, day] = ymd.split("-");
  const cgDate = `${day}-${month}-${year}`;
  const cacheKey = `${coinId}|${cgDate}`;
  if (historicalPriceCache.has(cacheKey)) {
    return historicalPriceCache.get(cacheKey) ?? null;
  }
  try {
    const data = await fetchJson<{
      market_data?: { current_price?: { usd?: number } };
    }>(`https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${cgDate}&localization=false`);
    const price = data.market_data?.current_price?.usd ?? null;
    historicalPriceCache.set(cacheKey, price);
    return price;
  } catch (e) {
    logger.debug(`CoinGecko historical price fetch failed for ${coinId}@${cgDate}: ${(e as Error).message}`);
    // Cache null too — avoid re-hitting the API on repeated failures during
    // a backfill walk. Operator can re-run later when API is up.
    historicalPriceCache.set(cacheKey, null);
    return null;
  }
}

// Iter613: also exported for parallel cross-source comparison.
export async function priceFromDexScreener(tokenAddress: string, logger: Logger): Promise<number | null> {
  const t0 = Date.now();
  try {
    // DexScreener "tokens" endpoint returns pairs across chains; we pick the most liquid one.
    const data = await fetchJson<{ pairs?: { priceUsd?: string; liquidity?: { usd?: number } }[] }>(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
    );
    const pairs = data.pairs ?? [];
    let price: number | null = null;
    if (pairs.length > 0) {
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const top = pairs[0];
      const p = top.priceUsd ? parseFloat(top.priceUsd) : null;
      price = Number.isFinite(p) ? p : null;
    }
    recordProviderCall("dexscreener", {
      ok: true,
      latencyMs: Date.now() - t0,
      tokensRequested: 1,
      tokensReturned: price != null ? 1 : 0,
    });
    return price;
  } catch (e) {
    recordProviderCall("dexscreener", {
      ok: false,
      latencyMs: Date.now() - t0,
      tokensRequested: 1,
      tokensReturned: 0,
      errorCode: classifyFetchError(e),
    });
    logger.debug(`DexScreener price fetch failed: ${(e as Error).message}`);
    return null;
  }
}

export async function getCurrentPrice(tokenAddress: string, logger: Logger): Promise<number | null> {
  const key = tokenAddress.toLowerCase();
  // Prefer cache. Successful prices: 60s TTL. Null (unpriceable) results: 15s TTL —
  // see PRICE_NEGATIVE_TTL comment.
  const cached = priceCache.get(key);
  if (cached) {
    const ttl = cached.data == null ? PRICE_NEGATIVE_TTL : PRICE_CACHE_TTL;
    if (Date.now() - cached.timestamp < ttl) return cached.data;
  }
  // Already fetching for this token? Share the promise.
  const pending = priceInFlight.get(key);
  if (pending) return pending;

  const fetchP: Promise<number | null> = (async () => {
    try {
      // 1) CoinGecko (for tokens we have a mapping for).
      const coinId = getCoinGeckoId(tokenAddress);
      let price: number | null = null;
      if (coinId) price = await priceFromCoinGecko(coinId, logger);
      // 2) DexScreener fallback (works for any EVM token by address).
      if (price == null) price = await priceFromDexScreener(tokenAddress, logger);
      // Cache both success AND null. Null cache prevents the 2N-request flood when a
      // wallet holds many long-tail tokens that no provider knows about.
      priceCache.set(key, { data: price, timestamp: Date.now() });
      evictIfOverCap(priceCache, PRICE_CACHE_MAX);
      return price;
    } finally {
      priceInFlight.delete(key);
    }
  })();
  priceInFlight.set(key, fetchP);
  return fetchP;
}

export async function getPriceHistory(tokenAddress: string, period: string, logger: Logger): Promise<string> {
  const coinId = getCoinGeckoId(tokenAddress);
  if (!coinId) {
    return "Price history unavailable for non-CoinGecko-listed tokens (use the web UI's K-line tab for DEX pairs).";
  }

  // Reject unknown periods loudly instead of silently falling back to 1d. Pre-iter173
  // a typo like `--period 1week` produced a "1d" chart with no signal that the period
  // flag was ignored.
  if (!(period in PERIOD_DAYS)) {
    const validPeriods = Object.keys(PERIOD_DAYS);
    const suggestion = closestMatch(period, validPeriods);
    const suggestionNote = suggestion ? ` Did you mean "${suggestion}"?` : "";
    throw new ToolError(
      "INVALID_PARAMS",
      `Invalid --period "${period}" — expected one of: ${validPeriods.join(", ")}.${suggestionNote}`,
      {
        details: { providedPeriod: period, validPeriods, suggestion },
        ...(suggestion ? {
          nextActions: [
            {
              tool: "price",
              params: { period: suggestion },
              reason: `Retry with period="${suggestion}" (CLI: \`tradekit price <token> --period ${suggestion}\`).`,
            },
          ],
        } : {}),
      },
    );
  }
  const days = PERIOD_DAYS[period];
  const cacheKey = `${coinId}_${days}`;
  const cached = historyCache.get(cacheKey);
  let history: HistoryData;

  if (cached && Date.now() - cached.timestamp < HISTORY_CACHE_TTL) {
    history = cached.data;
  } else {
    try {
      history = await fetchJson<HistoryData>(
        `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`,
      );
      historyCache.set(cacheKey, { data: history, timestamp: Date.now() });
      evictIfOverCap(historyCache, HISTORY_CACHE_MAX);
    } catch (e) {
      logger.debug(`CoinGecko history fetch failed: ${(e as Error).message}`);
      if (cached) {
        history = cached.data;
      } else {
        return "Price history unavailable (CoinGecko rate-limited or unreachable).";
      }
    }
  }

  if (!history.prices || history.prices.length === 0) return "No price history data available";

  const prices = history.prices.map(([, p]) => p);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const change = ((last - first) / first) * 100;

  const lines: string[] = [
    `Period: ${period} (${days} day${days > 1 ? "s" : ""})`,
    `Current: $${last.toFixed(2)}`,
    `High:    $${high.toFixed(2)}`,
    `Low:     $${low.toFixed(2)}`,
    `Change:  ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`,
  ];

  const bucketCount = Math.min(20, prices.length);
  const bucketSize = Math.floor(prices.length / bucketCount);
  const buckets: number[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const slice = prices.slice(i * bucketSize, (i + 1) * bucketSize);
    buckets.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  const minB = Math.min(...buckets);
  const maxB = Math.max(...buckets);
  const range = maxB - minB || 1;
  const bars = "▁▂▃▄▅▆▇█";
  const sparkline = buckets
    .map((v) => bars[Math.round(((v - minB) / range) * (bars.length - 1))])
    .join("");
  lines.push(`Chart:   ${sparkline}`);
  return lines.join("\n");
}
