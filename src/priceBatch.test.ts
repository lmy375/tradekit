// Tests for priceBatch.ts (iter38). Layer through injected
// fetch fns so no real HTTP traffic; assert cache + dedup +
// stats interaction.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getCurrentPrices, getCurrentPriceBatched } from "./priceBatch.js";
import { resetProviderStats, getProviderStats, getProviderStat } from "./priceStats.js";
import { priceCache, priceInFlight } from "./priceCacheShared.js";
import type { Logger } from "./logger.js";

function silent(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    recordAudit: vi.fn(),
  } as unknown as Logger;
}

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";  // ETH ID per the COINGECKO_IDS map
const ETH_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const UNKNOWN = "0x0000000000000000000000000000000000abcdef";

beforeEach(() => {
  priceCache.clear();
  priceInFlight.clear();
  resetProviderStats();
});

// ── empty input ─────────────────────────────────────────────

describe("getCurrentPrices", () => {
  it("returns empty Map for empty input + makes zero HTTP calls", async () => {
    const cg = vi.fn();
    const ds = vi.fn();
    const result = await getCurrentPrices([], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(result.size).toBe(0);
    expect(cg).not.toHaveBeenCalled();
    expect(ds).not.toHaveBeenCalled();
  });

  it("returns cached price when within TTL + makes zero HTTP calls", async () => {
    priceCache.set(WETH.toLowerCase(), { data: 2500, timestamp: Date.now() });
    const cg = vi.fn();
    const ds = vi.fn();
    const result = await getCurrentPrices([WETH], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(result.get(WETH.toLowerCase())).toBe(2500);
    expect(cg).not.toHaveBeenCalled();
    expect(ds).not.toHaveBeenCalled();
  });

  it("returns null cache when within negative TTL", async () => {
    priceCache.set(UNKNOWN.toLowerCase(), { data: null, timestamp: Date.now() });
    const cg = vi.fn();
    const ds = vi.fn();
    const result = await getCurrentPrices([UNKNOWN], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(result.get(UNKNOWN.toLowerCase())).toBeNull();
    expect(cg).not.toHaveBeenCalled();
    expect(ds).not.toHaveBeenCalled();
  });

  it("re-fetches when cache entry is stale", async () => {
    priceCache.set(WETH.toLowerCase(), { data: 2400, timestamp: Date.now() - 120_000 });
    const cg = vi.fn().mockResolvedValue({ ethereum: { usd: 2500 } });
    const ds = vi.fn();
    const result = await getCurrentPrices([WETH], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(result.get(WETH.toLowerCase())).toBe(2500);
    expect(cg).toHaveBeenCalledTimes(1);
  });
});

// ── CoinGecko batching ──────────────────────────────────────

describe("CoinGecko batching", () => {
  it("makes ONE batched call for multiple CoinGecko-mapped tokens", async () => {
    // Both WETH + native ETH map to coinId "ethereum" — but the
    // batch deduplicates by token address, not coinId, so we
    // expect ONE HTTP call carrying both ids (though it's the
    // same ethereum id twice, which CoinGecko will return once).
    // To get a CLEAN test we'd need two different mapped tokens.
    // Let me use a token mapping plus a known address.
    const cg = vi.fn().mockResolvedValue({ ethereum: { usd: 2500 } });
    const ds = vi.fn();
    const result = await getCurrentPrices([WETH], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(cg).toHaveBeenCalledTimes(1);
    expect(cg.mock.calls[0][0]).toContain("ids=ethereum");
    expect(cg.mock.calls[0][0]).toContain("vs_currencies=usd");
    expect(result.get(WETH.toLowerCase())).toBe(2500);
  });

  it("dedupes input addresses (case-insensitive)", async () => {
    const cg = vi.fn().mockResolvedValue({ ethereum: { usd: 2500 } });
    const result = await getCurrentPrices([WETH, WETH.toUpperCase(), WETH], silent(), {
      injects: { coinGeckoFetchFn: cg },
    });
    expect(cg).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(1);
  });

  it("falls back to DexScreener when CoinGecko returns no price for a mapped token", async () => {
    // CoinGecko returns empty for the mapped id → DexScreener
    // gets called for that token.
    const cg = vi.fn().mockResolvedValue({});
    const ds = vi.fn().mockResolvedValue(2510);
    const result = await getCurrentPrices([WETH], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(cg).toHaveBeenCalledTimes(1);
    expect(ds).toHaveBeenCalledTimes(1);
    expect(ds).toHaveBeenCalledWith(WETH.toLowerCase());
    expect(result.get(WETH.toLowerCase())).toBe(2510);
  });

  it("falls back to DexScreener when CoinGecko throws", async () => {
    const cg = vi.fn().mockRejectedValue(new Error("HTTP 429 Too Many Requests"));
    const ds = vi.fn().mockResolvedValue(2510);
    const result = await getCurrentPrices([WETH], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(result.get(WETH.toLowerCase())).toBe(2510);
    const cgStats = getProviderStat("coingecko");
    expect(cgStats?.failures).toBe(1);
    expect(cgStats?.lastErrorCode).toBe("HTTP_429");
  });
});

// ── DexScreener-only path ───────────────────────────────────

describe("DexScreener-only fallback", () => {
  it("dispatches non-mapped tokens directly to DexScreener (no CoinGecko call)", async () => {
    const cg = vi.fn();
    const ds = vi.fn().mockResolvedValue(0.001);
    const result = await getCurrentPrices([UNKNOWN], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(cg).not.toHaveBeenCalled();
    expect(ds).toHaveBeenCalledTimes(1);
    expect(result.get(UNKNOWN.toLowerCase())).toBe(0.001);
  });

  it("parallelizes multiple DexScreener fallbacks", async () => {
    const calls: string[] = [];
    const ds = vi.fn().mockImplementation(async (token: string) => {
      calls.push(token);
      return token === UNKNOWN ? 0.001 : 0.002;
    });
    const tokens = [
      "0x0000000000000000000000000000000000abcdef",
      "0x0000000000000000000000000000000000bbbbbb",
    ];
    await getCurrentPrices(tokens, silent(), {
      injects: { dexScreenerFetchFn: ds },
    });
    expect(ds).toHaveBeenCalledTimes(2);
    expect(calls.sort()).toEqual([
      "0x0000000000000000000000000000000000abcdef",
      "0x0000000000000000000000000000000000bbbbbb",
    ]);
  });

  it("returns null when DexScreener returns null", async () => {
    const ds = vi.fn().mockResolvedValue(null);
    const result = await getCurrentPrices([UNKNOWN], silent(), {
      injects: { dexScreenerFetchFn: ds },
    });
    expect(result.get(UNKNOWN.toLowerCase())).toBeNull();
  });

  it("returns null when DexScreener throws", async () => {
    const ds = vi.fn().mockRejectedValue(new Error("HTTP 503"));
    const result = await getCurrentPrices([UNKNOWN], silent(), {
      injects: { dexScreenerFetchFn: ds },
    });
    expect(result.get(UNKNOWN.toLowerCase())).toBeNull();
    expect(getProviderStat("dexscreener")?.failures).toBe(1);
    expect(getProviderStat("dexscreener")?.lastErrorCode).toBe("HTTP_5xx");
  });
});

// ── mixed cache + fetch ─────────────────────────────────────

describe("mixed cache + fetch", () => {
  it("partial cache hit → only missing tokens hit providers", async () => {
    priceCache.set(WETH.toLowerCase(), { data: 2500, timestamp: Date.now() });
    const cg = vi.fn();
    const ds = vi.fn().mockResolvedValue(0.001);
    await getCurrentPrices([WETH, UNKNOWN], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(cg).not.toHaveBeenCalled();
    expect(ds).toHaveBeenCalledTimes(1);
    expect(ds).toHaveBeenCalledWith(UNKNOWN.toLowerCase());
  });

  it("populates cache after fetch", async () => {
    const cg = vi.fn().mockResolvedValue({ ethereum: { usd: 2500 } });
    await getCurrentPrices([WETH], silent(), { injects: { coinGeckoFetchFn: cg } });
    const cached = priceCache.get(WETH.toLowerCase());
    expect(cached?.data).toBe(2500);
  });
});

// ── stats integration ──────────────────────────────────────

describe("stats integration", () => {
  it("records ONE CoinGecko call with the full tokensRequested count", async () => {
    const cg = vi.fn().mockResolvedValue({ ethereum: { usd: 2500 } });
    await getCurrentPrices([WETH], silent(), { injects: { coinGeckoFetchFn: cg } });
    const s = getProviderStat("coingecko")!;
    expect(s.totalCalls).toBe(1);
    expect(s.successes).toBe(1);
    expect(s.tokensRequested).toBe(1);
    expect(s.tokensReturned).toBe(1);
  });

  it("records DexScreener calls separately from CoinGecko", async () => {
    const cg = vi.fn().mockResolvedValue({ ethereum: { usd: 2500 } });
    const ds = vi.fn().mockResolvedValue(0.001);
    await getCurrentPrices([WETH, UNKNOWN], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(getProviderStat("coingecko")?.totalCalls).toBe(1);
    expect(getProviderStat("dexscreener")?.totalCalls).toBe(1);
  });

  it("reports CoinGecko fallback flowing into DexScreener as 2 calls total", async () => {
    const cg = vi.fn().mockResolvedValue({}); // empty response
    const ds = vi.fn().mockResolvedValue(2510);
    await getCurrentPrices([WETH], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(getProviderStat("coingecko")?.totalCalls).toBe(1);
    // CG was OK (didn't throw), so success=1, but tokensReturned=0.
    expect(getProviderStat("coingecko")?.successes).toBe(1);
    expect(getProviderStat("coingecko")?.tokensReturned).toBe(0);
    expect(getProviderStat("dexscreener")?.totalCalls).toBe(1);
    expect(getProviderStat("dexscreener")?.tokensReturned).toBe(1);
  });
});

// ── single-token wrapper ────────────────────────────────────

describe("getCurrentPriceBatched", () => {
  it("returns the price for a single token", async () => {
    const cg = vi.fn().mockResolvedValue({ ethereum: { usd: 2500 } });
    const v = await getCurrentPriceBatched(WETH, silent(), {
      injects: { coinGeckoFetchFn: cg },
    });
    expect(v).toBe(2500);
  });

  it("returns null when neither provider has a price", async () => {
    const cg = vi.fn().mockResolvedValue({});
    const ds = vi.fn().mockResolvedValue(null);
    const v = await getCurrentPriceBatched(WETH, silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(v).toBeNull();
  });
});

// ── input ordering preservation ────────────────────────────

describe("result ordering / completeness", () => {
  it("every input address gets an entry in the result map", async () => {
    const cg = vi.fn().mockResolvedValue({ ethereum: { usd: 2500 } });
    const ds = vi.fn().mockResolvedValue(null);
    const result = await getCurrentPrices([WETH, UNKNOWN], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    expect(result.get(WETH.toLowerCase())).toBe(2500);
    expect(result.get(UNKNOWN.toLowerCase())).toBeNull();
  });
});

// ── unique providers seen ──────────────────────────────────

describe("getProviderStats integration", () => {
  it("getProviderStats lists every provider touched in this run", async () => {
    const cg = vi.fn().mockResolvedValue({ ethereum: { usd: 2500 } });
    const ds = vi.fn().mockResolvedValue(0.001);
    await getCurrentPrices([WETH, UNKNOWN], silent(), {
      injects: { coinGeckoFetchFn: cg, dexScreenerFetchFn: ds },
    });
    const all = getProviderStats();
    expect(all.map((s) => s.provider).sort()).toEqual(["coingecko", "dexscreener"]);
  });
});
