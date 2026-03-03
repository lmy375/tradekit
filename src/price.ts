import type { Logger } from "./logger.js";

// CoinGecko ID mapping for common tokens
const COINGECKO_IDS: Record<string, string> = {
  "0x4200000000000000000000000000000000000006": "ethereum", // WETH on Base
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "ethereum", // WETH on Ethereum
  "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1": "ethereum", // WETH on Arbitrum
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": "usd-coin", // USDC on Base
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "usd-coin", // USDC on Ethereum
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": "usd-coin", // USDC on Arbitrum
};

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const priceCache = new Map<string, CacheEntry<number>>();
const historyCache = new Map<string, CacheEntry<HistoryData>>();

const PRICE_CACHE_TTL = 60_000; // 60s
const HISTORY_CACHE_TTL = 300_000; // 5min

interface HistoryData {
  prices: [number, number][];
}

const PERIOD_DAYS: Record<string, number> = {
  "1d": 1,
  "1w": 7,
  "1m": 30,
  "1y": 365,
};

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CoinGecko API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function getCoinGeckoId(tokenAddress: string): string | undefined {
  return COINGECKO_IDS[tokenAddress];
}

export async function getCurrentPrice(
  tokenAddress: string,
  logger: Logger,
): Promise<number | null> {
  const coinId = getCoinGeckoId(tokenAddress);
  if (!coinId) {
    logger.debug(`No CoinGecko ID for ${tokenAddress}`);
    return null;
  }

  const cached = priceCache.get(coinId);
  if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
    return cached.data;
  }

  try {
    const data = await fetchJson(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
    );
    const price = data[coinId]?.usd;
    if (price != null) {
      priceCache.set(coinId, { data: price, timestamp: Date.now() });
    }
    return price ?? null;
  } catch (e) {
    logger.error(`CoinGecko price fetch failed: ${(e as Error).message}`);
    return cached?.data ?? null;
  }
}

export async function getPriceHistory(
  tokenAddress: string,
  period: string,
  logger: Logger,
): Promise<string> {
  const coinId = getCoinGeckoId(tokenAddress);
  if (!coinId) {
    return "Price history unavailable: unknown token";
  }

  const days = PERIOD_DAYS[period] ?? 1;
  const cacheKey = `${coinId}_${days}`;

  const cached = historyCache.get(cacheKey);
  let history: HistoryData;

  if (cached && Date.now() - cached.timestamp < HISTORY_CACHE_TTL) {
    history = cached.data;
  } else {
    try {
      history = await fetchJson(
        `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`,
      );
      historyCache.set(cacheKey, { data: history, timestamp: Date.now() });
    } catch (e) {
      logger.error(`CoinGecko history fetch failed: ${(e as Error).message}`);
      if (cached) {
        history = cached.data;
      } else {
        return "Price history unavailable: API error";
      }
    }
  }

  if (!history.prices || history.prices.length === 0) {
    return "No price history data available";
  }

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

  // Sparkline (simple ASCII)
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
