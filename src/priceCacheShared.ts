// ──────────────────────────────────────────────────────────────────
// Shared price-cache primitives (iter38).
//
// Pre-iter38 these lived in price.ts. Moved to their own module to
// let priceBatch.ts (the new batch fetch path) read from the SAME
// cache as the legacy single-token path — without creating a
// circular import between price.ts ↔ priceBatch.ts.
//
// Behavior unchanged from iter132 / iter80:
//   - Success TTL 60s (most-used short-term cache)
//   - Null TTL 15s (transient provider outages recover fast)
//   - In-flight Promise dedup
//   - FIFO eviction at 1000-entry cap
// ──────────────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export const priceCache = new Map<string, CacheEntry<number | null>>();
export const priceInFlight = new Map<string, Promise<number | null>>();

export const PRICE_CACHE_TTL = 60_000; // 60s for successful prices
export const PRICE_NEGATIVE_TTL = 15_000; // 15s for null
export const PRICE_CACHE_MAX = 1000;

export function evictIfOverCap<K, V>(map: Map<K, V>, cap: number): void {
  while (map.size > cap) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}
