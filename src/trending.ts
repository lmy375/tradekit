import type { Logger } from "./logger.js";
import { ToolError } from "./errors.js";
import { fetchWithTimeout } from "./http.js";
import { closestMatch } from "./format.js";

/** Map our chain names → DexScreener's chain identifiers. */
const DEX_CHAINS: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  bnb: "bsc",
  polygon: "polygon",
};

/**
 * Build an UNKNOWN_CHAIN error for DexScreener-unsupported chains. Iter385 — both
 * tokenByAddress and trendingOnChain check the same DEX_CHAINS map, so the error-
 * building logic was duplicated. Centralizing also gives both sites the iter343
 * closest-match suggestion automatically.
 */
function unsupportedDexChainError(chain: string): ToolError {
  const supported = Object.keys(DEX_CHAINS);
  const suggestion = closestMatch(chain, supported);
  const suggestionNote = suggestion ? ` Did you mean "${suggestion}"?` : "";
  return new ToolError(
    "UNKNOWN_CHAIN",
    `DexScreener does not map chain "${chain}".${suggestionNote} Supported: ${supported.join(", ")}.`,
    { details: { chain, supported, suggestion } },
  );
}

export interface TrendingPair {
  chain: string;
  pairAddress: string;
  dex: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: string | null;
  priceChangeH1: number | null;
  priceChangeH24: number | null;
  volumeH24: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  pairCreatedAt: number | null;
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  priceChange?: { h1?: number; h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  pairCreatedAt?: number;
}

function normalisePair(p: DexScreenerPair): TrendingPair {
  return {
    chain: p.chainId,
    pairAddress: p.pairAddress,
    dex: p.dexId,
    baseToken: p.baseToken,
    quoteToken: p.quoteToken,
    priceUsd: p.priceUsd ?? null,
    priceChangeH1: p.priceChange?.h1 ?? null,
    priceChangeH24: p.priceChange?.h24 ?? null,
    volumeH24: p.volume?.h24 ?? null,
    liquidityUsd: p.liquidity?.usd ?? null,
    fdv: p.fdv ?? null,
    pairCreatedAt: p.pairCreatedAt ?? null,
  };
}

/** Search DexScreener for a token by symbol or address. Free, no key required. */
export async function searchToken(query: string, logger: Logger): Promise<TrendingPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  logger.debug(`DexScreener GET ${url}`);
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new ToolError("API_ERROR", `DexScreener ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { pairs?: DexScreenerPair[] };
  return (body.pairs ?? []).map(normalisePair);
}

/** Look up a token by chain + address. */
export async function tokenByAddress(chain: string, address: string, logger: Logger): Promise<TrendingPair[]> {
  const dexChain = DEX_CHAINS[chain.toLowerCase()];
  if (!dexChain) throw unsupportedDexChainError(chain);
  const url = `https://api.dexscreener.com/tokens/v1/${dexChain}/${address}`;
  logger.debug(`DexScreener GET ${url}`);
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new ToolError("API_ERROR", `DexScreener ${res.status} ${res.statusText}`);
  const body = (await res.json()) as DexScreenerPair[];
  return Array.isArray(body) ? body.map(normalisePair) : [];
}

/**
 * Top trending pairs by 24h volume. DexScreener exposes a "boosts" endpoint for
 * newly-promoted tokens; we use search by chain + sort by H24 volume client-side.
 */
export async function trendingOnChain(
  chain: string,
  logger: Logger,
  limit = 10,
): Promise<TrendingPair[]> {
  const dexChain = DEX_CHAINS[chain.toLowerCase()];
  if (!dexChain) throw unsupportedDexChainError(chain);
  // Use the "tokens" search for common stables as a seed and pick top pairs by liquidity.
  // Cleanest free signal: token-profiles boosts endpoint.
  const url = `https://api.dexscreener.com/token-boosts/top/v1`;
  logger.debug(`DexScreener GET ${url}`);
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new ToolError("API_ERROR", `DexScreener ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { chainId: string; tokenAddress: string }[];
  const matches = body.filter((b) => b.chainId === dexChain).slice(0, limit);
  // Iter246: parallelize the per-token lookups. Pre-iter246 this was a serial loop —
  // with limit=10 that meant 10 sequential round-trips (~2-5s wall time). Each
  // tokenByAddress call is an independent HTTP GET against DexScreener, so they can
  // safely fan out. Per-token failures are still swallowed (a single bad token
  // shouldn't drop the rest of the trending list). Order is preserved from the
  // boosts response so the user sees the highest-ranked tokens first.
  const tokenResults = await Promise.all(
    matches.map((m) =>
      tokenByAddress(chain, m.tokenAddress, logger).catch(() => [] as TrendingPair[]),
    ),
  );
  const pairs: TrendingPair[] = [];
  for (const tokPairs of tokenResults) {
    const top = tokPairs.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
    if (top) pairs.push(top);
  }
  return pairs;
}

export function formatPairs(pairs: TrendingPair[]): string {
  if (pairs.length === 0) return "No pairs found.";
  const lines: string[] = [];
  lines.push("Symbol         Chain      Price($)      H1(%)    H24(%)   Vol24h($)    Liq($)       Pair");
  lines.push("-".repeat(110));
  for (const p of pairs) {
    const price = p.priceUsd ?? "N/A";
    const h1 = p.priceChangeH1 != null ? p.priceChangeH1.toFixed(2) : "N/A";
    const h24 = p.priceChangeH24 != null ? p.priceChangeH24.toFixed(2) : "N/A";
    const vol = p.volumeH24 != null ? Math.round(p.volumeH24).toLocaleString() : "N/A";
    const liq = p.liquidityUsd != null ? Math.round(p.liquidityUsd).toLocaleString() : "N/A";
    lines.push(
      `${p.baseToken.symbol.padEnd(14)} ${p.chain.padEnd(10)} ${price.padEnd(13)} ${h1.padEnd(8)} ${h24.padEnd(
        8,
      )} ${vol.padEnd(12)} ${liq.padEnd(12)} ${p.pairAddress.slice(0, 12)}...`,
    );
  }
  return lines.join("\n");
}
