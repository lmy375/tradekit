import {
  type Address,
  type PublicClient,
  type Transport,
  type Chain,
  isAddress,
  getAddress,
} from "viem";
import { ERC20_ABI } from "./constants.js";
import { ToolError } from "./errors.js";
import type { ChainProfile } from "./chains.js";

export interface TokenMetadata {
  address: Address;
  chainId: number;
  decimals: number;
  symbol: string;
  /** True if this is the chain's native asset (handled specially in swaps). */
  isNative: boolean;
}

const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

// In-memory cache keyed by `${chainId}:${lower(address)}`. Decimals & symbol are
// effectively immutable on a deployed contract, so we cache for the process lifetime.
const cache = new Map<string, TokenMetadata>();
// In-flight dedup (same rationale as price.ts iter80): when N concurrent calls ask for
// the same token before the first RPC resolves, share the promise. Holdings + trade +
// status all fetching metadata for the same WETH at startup is a common pattern.
const inFlight = new Map<string, Promise<TokenMetadata>>();

function cacheKey(chainId: number, address: Address): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/**
 * Intentionally no-op: previously seeded the cache with decimals INFERRED from the
 * symbol (USDC=6, WBTC=8, default 18). That assumption is wrong on BSC — Binance-Peg
 * USDC/USDT are 18-decimal BEP-20 tokens, not 6-decimal — and the cached inference
 * suppressed the subsequent on-chain read, breaking swaps/balances by 10^12. We now
 * always go to chain on first lookup; the result is then cached for the process
 * lifetime, so the perf cost is one extra RPC call per token per process.
 *
 * Kept as an exported no-op for backward compatibility with callers that still invoke
 * it (and so the cache is documented in one place).
 */
export function primeFromProfile(_profile: ChainProfile): void {
  // No-op by design. See JSDoc above.
}

/**
 * Resolve metadata for a token on a chain. Reads from cache if available; otherwise
 * fetches `decimals()` and `symbol()` on-chain and caches the result.
 *
 * Native: pass the chain's native sentinel (0xEee…) to get an entry with `isNative: true`,
 * symbol = profile.nativeSymbol, decimals = 18.
 */
export async function getToken(
  publicClient: PublicClient<Transport, Chain>,
  profile: ChainProfile,
  address: Address,
): Promise<TokenMetadata> {
  // Native
  if (address.toLowerCase() === NATIVE_SENTINEL.toLowerCase()) {
    return {
      address: NATIVE_SENTINEL,
      chainId: profile.chainId,
      decimals: 18,
      symbol: profile.nativeSymbol,
      isNative: true,
    };
  }

  const checksummed = isAddress(address) ? getAddress(address) : address;
  const key = cacheKey(profile.chainId, checksummed);
  const cached = cache.get(key);
  if (cached) return cached;
  // Share an in-flight RPC pair (decimals + symbol) across concurrent callers.
  const pending = inFlight.get(key);
  if (pending) return pending;

  const fetchP: Promise<TokenMetadata> = (async () => {
    try {
      const [decimals, symbol] = await Promise.all([
        publicClient.readContract({
          address: checksummed,
          abi: ERC20_ABI,
          functionName: "decimals",
        }),
        publicClient.readContract({
          address: checksummed,
          abi: ERC20_ABI,
          functionName: "symbol",
        }),
      ]);
      const meta: TokenMetadata = {
        address: checksummed,
        chainId: profile.chainId,
        decimals: decimals as number,
        symbol: symbol as string,
        isNative: false,
      };
      cache.set(key, meta);
      return meta;
    } catch (e) {
      throw new ToolError("UNKNOWN_TOKEN", `Failed to read ERC20 metadata for ${checksummed}: ${(e as Error).message}`, {
        cause: e,
        details: { token: checksummed, chainId: profile.chainId },
      });
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, fetchP);
  return fetchP;
}

/** Read an ERC20 balance, returning the raw bigint. (No metadata fetch.) */
export async function readBalance(
  publicClient: PublicClient<Transport, Chain>,
  token: Address,
  owner: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

/** Read an ERC20 allowance. */
export async function readAllowance(
  publicClient: PublicClient<Transport, Chain>,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
}

export function isNativeSentinel(addr: Address): boolean {
  return addr.toLowerCase() === NATIVE_SENTINEL.toLowerCase();
}

export const NATIVE_TOKEN = NATIVE_SENTINEL;
