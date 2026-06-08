// Tests for the price cache. Specifically the iter132 negative-result caching that
// stops `pnl` over a wallet of N unpriceable long-tail tokens from firing 2N requests.
// We mock the underlying fetcher (http.fetchWithTimeout) so the test stays offline.

import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock must run before the module under test imports http. Returning null-ish
// responses from BOTH providers exercises the "no price available" path.
vi.mock("./http.js", () => ({
  fetchWithTimeout: vi.fn(async () => {
    // Empty/404-like response: DexScreener returns {pairs: []}; CoinGecko returns {}.
    // Either way both providers resolve to null.
    return new Response(JSON.stringify({ pairs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
}));

import { getCurrentPrice, getCoinGeckoId } from "./price.js";
import * as http from "./http.js";

const mockFetch = http.fetchWithTimeout as unknown as ReturnType<typeof vi.fn>;

// Logger stub: price providers call .warn / .info but we don't care here.
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  recordTrade: () => 0,
  recordAudit: () => 0,
  close: () => {},
} as never;

describe("getCurrentPrice negative-result caching (iter132)", () => {
  // A long-tail address that won't match any CoinGecko mapping → DexScreener fallback.
  // Different per test so each test starts with an empty cache slot.
  let addr: string;
  beforeEach(() => {
    addr = "0x" + Math.random().toString(16).slice(2).padStart(40, "0").slice(0, 40);
    mockFetch.mockClear();
  });

  it("caches null results so a repeat call doesn't re-hit the providers", async () => {
    const first = await getCurrentPrice(addr, logger);
    expect(first).toBeNull();
    const callsAfterFirst = mockFetch.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Repeat call within negative-TTL window — should be a cache hit, zero new fetches.
    const second = await getCurrentPrice(addr, logger);
    expect(second).toBeNull();
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does not flood — N concurrent calls for the same unpriceable token issue one fetch batch", async () => {
    // In-flight dedup + null caching together: 10 parallel calls should share one
    // fetch. Pre-iter132 only the in-flight dedup helped during the concurrent
    // window; a serial repeat afterward still re-fired.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => getCurrentPrice(addr, logger)),
    );
    expect(results.every((r) => r === null)).toBe(true);
    const firstBatchCalls = mockFetch.mock.calls.length;

    // Another serial call — should not increase fetch count (now satisfied by null cache).
    const again = await getCurrentPrice(addr, logger);
    expect(again).toBeNull();
    expect(mockFetch.mock.calls.length).toBe(firstBatchCalls);
  });
});

describe("getCoinGeckoId case-insensitive lookup (iter239)", () => {
  // Regression guard for the iter239 fix: pre-iter239 keys were checksum-cased and a
  // lowercased caller silently fell through to DexScreener — same price answer in
  // most cases but extra latency + an unnecessary upstream call. EVM addresses are
  // case-insensitive, so the lookup must be too.
  const USDC_BASE_CHECKSUM = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const USDC_BASE_LOWER = USDC_BASE_CHECKSUM.toLowerCase();
  const USDC_BASE_UPPER = "0x" + USDC_BASE_CHECKSUM.slice(2).toUpperCase();

  it("returns the same coingecko id regardless of address casing", () => {
    const checksum = getCoinGeckoId(USDC_BASE_CHECKSUM);
    expect(checksum).toBe("usd-coin");
    expect(getCoinGeckoId(USDC_BASE_LOWER)).toBe(checksum);
    expect(getCoinGeckoId(USDC_BASE_UPPER)).toBe(checksum);
  });

  it("returns undefined for an address with no mapping (any casing)", () => {
    const unknown = "0xabcdef0123456789abcdef0123456789abcdef01";
    expect(getCoinGeckoId(unknown)).toBeUndefined();
    expect(getCoinGeckoId(unknown.toUpperCase())).toBeUndefined();
  });
});
