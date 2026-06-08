// Tests for tokens.ts. Two contracts being pinned here:
//
// 1. isNativeSentinel — every trade branches on this to decide native vs ERC20 paths.
//    A regression here misroutes ETH trades as ERC20 swaps (which would revert).
//
// 2. primeFromProfile is intentionally a no-op (was iter44's fix for BSC USDC/USDT,
//    where symbol-inferred decimals were wrong by 10^12). Pin that contract so a
//    future "optimization" doesn't reintroduce the inference and poison the cache.

import { describe, it, expect } from "vitest";
import { isNativeSentinel, primeFromProfile, getToken, NATIVE_TOKEN } from "./tokens.js";
import type { ChainProfile } from "./chains.js";
import type { Address } from "viem";

// Each test uses a unique chainId so the module-global cache doesn't collide across runs.
let nextChainId = 9_999_001;
function makeProfile(tokens: Record<string, Address>): ChainProfile {
  return {
    name: "test-chain",
    chainId: nextChainId++,
    rpcs: ["http://example"],
    explorer: "https://example",
    nativeSymbol: "ETH",
    weth: "0x4200000000000000000000000000000000000006" as Address,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    tokens,
    aggregators: [],
    viemChain: { id: nextChainId } as never,
  } as unknown as ChainProfile;
}

describe("isNativeSentinel", () => {
  it("matches the canonical 0xEee… sentinel (checksummed)", () => {
    expect(isNativeSentinel("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address)).toBe(true);
  });

  it("matches the lowercased form of the sentinel (callers don't always preserve case)", () => {
    expect(isNativeSentinel("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address)).toBe(true);
  });

  it("does NOT match a typical ERC20 address (would mis-route trade as native)", () => {
    expect(isNativeSentinel("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address)).toBe(false);
  });

  it("NATIVE_TOKEN is the sentinel", () => {
    expect(isNativeSentinel(NATIVE_TOKEN)).toBe(true);
  });
});

describe("primeFromProfile is a no-op (regression: BSC USDC/USDT 18-vs-6 bug)", () => {
  it("does not write to the cache — getToken still falls through to the chain", async () => {
    // BSC's BEP-20 USDT is the canonical case: symbol "USDT", decimals 18 (NOT 6).
    // If primeFromProfile re-introduced symbol inference, getToken below would return
    // a cached entry (with the wrong 6) and never hit the chain. We assert the no-op
    // by passing a client that would CRASH on any RPC call — the test passing means
    // getToken short-circuited via the cache for the *native* path (next describe),
    // not via priming. For an ERC20 token after priming, getToken MUST do a chain
    // read; we observe that by the readContract call landing on the stub.
    const profile = makeProfile({
      USDT: "0x55d398326f99059fF775485246999027B3197955" as Address, // BSC-USD
    });
    primeFromProfile(profile);
    let readContractCalled = false;
    const stubClient = {
      readContract: async () => {
        readContractCalled = true;
        return 18n; // pretend chain returns the correct 18 decimals
      },
    } as unknown as Parameters<typeof getToken>[0];
    // Even after priming, the first getToken MUST hit the chain.
    await getToken(stubClient, profile, profile.tokens.USDT).catch(() => undefined);
    expect(readContractCalled).toBe(true);
  });
});

describe("getToken in-flight dedup (iter81 — race fix)", () => {
  it("five parallel calls for the same uncached token produce ONE pair of RPC reads", async () => {
    const profile = makeProfile({
      // Unique address per test run via the auto-incrementing chainId in makeProfile.
      WEIRD: "0xaa11aa22aa33aa44aa55aa66aa77aa88aa99aabb" as Address,
    });
    // Track RPC calls. With the dedup in place, 5 callers should produce exactly
    // 2 readContract calls (decimals + symbol), not 10.
    let calls = 0;
    let pendingResolvers: ((v: unknown) => void)[] = [];
    const stubClient = {
      readContract: ({ functionName }: { functionName: string }) => {
        calls++;
        // Block both reads until we explicitly resolve, so all 5 callers
        // queue on the SAME in-flight promise rather than one resolving before
        // the next starts.
        return new Promise((resolve) => {
          pendingResolvers.push(() => resolve(functionName === "decimals" ? 18 : "WEIRD"));
        });
      },
    } as unknown as Parameters<typeof getToken>[0];
    // Fire 5 in parallel; assert only 2 reads (decimals + symbol) hit the client.
    const requests = Promise.all(
      Array.from({ length: 5 }, () =>
        getToken(stubClient, profile, profile.tokens.WEIRD).catch(() => null),
      ),
    );
    // Give them a tick to all enqueue.
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(2);
    // Resolve the pending reads.
    for (const r of pendingResolvers) r(null);
    await requests;
  });

  it("after the fetch resolves, subsequent callers hit the regular (resolved) cache", async () => {
    const profile = makeProfile({
      AFTER: "0xbb11bb22bb33bb44bb55bb66bb77bb88bb99bbcc" as Address,
    });
    let calls = 0;
    const stubClient = {
      readContract: async ({ functionName }: { functionName: string }) => {
        calls++;
        return functionName === "decimals" ? 18 : "AFTER";
      },
    } as unknown as Parameters<typeof getToken>[0];
    await getToken(stubClient, profile, profile.tokens.AFTER);
    await getToken(stubClient, profile, profile.tokens.AFTER);
    await getToken(stubClient, profile, profile.tokens.AFTER);
    // First call: 2 reads (decimals + symbol). Subsequent two: 0 reads (cached).
    expect(calls).toBe(2);
  });
});

describe("getToken native sentinel handling", () => {
  it("returns nativeSymbol + 18 decimals + isNative=true for the sentinel", async () => {
    const profile = makeProfile({});
    // No client call required for native — getToken short-circuits.
    const meta = await getToken(null as never, profile, NATIVE_TOKEN);
    expect(meta.isNative).toBe(true);
    expect(meta.decimals).toBe(18);
    expect(meta.symbol).toBe("ETH");
  });
});
