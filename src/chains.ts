import { base, mainnet, arbitrum, optimism, bsc, polygon } from "viem/chains";
import { fallback, http, isAddress, type Address, type Chain, type Transport } from "viem";
import { ToolError } from "./errors.js";
import { closestMatch } from "./format.js";
import type { Config } from "./config.js";

export interface ChainProfile {
  name: string;
  chainId: number;
  viemChain: Chain;
  nativeSymbol: string;
  explorer: string;
  /** Multiple public RPCs for failover (no API key required). */
  rpcs: string[];
  /** Wrapped native token address. */
  weth: Address;
  /** Default quote token (usually USDC). */
  usdc: Address;
  /** Optional commonly-used tokens (for symbol resolution & whitelists). */
  tokens: Record<string, Address>;
  /** Uniswap V3 deployment, used as fallback when no aggregator supports the chain. */
  uniswapV3?: {
    swapRouter02: Address;
    quoterV2: Address;
  };
  /** Aggregators known to support this chain. */
  aggregators: AggregatorName[];
}

export type AggregatorName = "kyberswap" | "openocean" | "0x" | "1inch";

const profiles: Record<string, ChainProfile> = {
  ethereum: {
    name: "ethereum",
    chainId: 1,
    viemChain: mainnet,
    nativeSymbol: "ETH",
    explorer: "https://etherscan.io",
    rpcs: [
      "https://eth.llamarpc.com",
      "https://ethereum-rpc.publicnode.com",
      "https://rpc.ankr.com/eth",
      "https://cloudflare-eth.com",
    ],
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    tokens: {
      WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    },
    uniswapV3: {
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    },
    aggregators: ["0x", "1inch"],
  },
  base: {
    name: "base",
    chainId: 8453,
    viemChain: base,
    nativeSymbol: "ETH",
    explorer: "https://basescan.org",
    rpcs: [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
      "https://base.llamarpc.com",
      "https://1rpc.io/base",
    ],
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokens: {
      WETH: "0x4200000000000000000000000000000000000006",
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
      DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    },
    uniswapV3: {
      swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
      quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    },
    aggregators: ["0x", "1inch"],
  },
  arbitrum: {
    name: "arbitrum",
    chainId: 42161,
    viemChain: arbitrum,
    nativeSymbol: "ETH",
    explorer: "https://arbiscan.io",
    rpcs: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one-rpc.publicnode.com",
      "https://arbitrum.llamarpc.com",
      "https://rpc.ankr.com/arbitrum",
    ],
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    tokens: {
      WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    },
    uniswapV3: {
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    },
    aggregators: ["0x", "1inch"],
  },
  optimism: {
    name: "optimism",
    chainId: 10,
    viemChain: optimism,
    nativeSymbol: "ETH",
    explorer: "https://optimistic.etherscan.io",
    rpcs: [
      "https://mainnet.optimism.io",
      "https://optimism-rpc.publicnode.com",
      "https://optimism.llamarpc.com",
      "https://rpc.ankr.com/optimism",
    ],
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    tokens: {
      WETH: "0x4200000000000000000000000000000000000006",
      USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      OP: "0x4200000000000000000000000000000000000042",
    },
    uniswapV3: {
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    },
    aggregators: ["0x", "1inch"],
  },
  bnb: {
    name: "bnb",
    chainId: 56,
    viemChain: bsc,
    nativeSymbol: "BNB",
    explorer: "https://bscscan.com",
    rpcs: [
      "https://bsc-dataseed.bnbchain.org",
      "https://bsc-rpc.publicnode.com",
      "https://binance.llamarpc.com",
      "https://rpc.ankr.com/bsc",
    ],
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    tokens: {
      WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      USDT: "0x55d398326f99059fF775485246999027B3197955",
      BUSD: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
      CAKE: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
    },
    uniswapV3: {
      swapRouter02: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
      quoterV2: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    },
    aggregators: ["0x", "1inch"],
  },
  polygon: {
    name: "polygon",
    chainId: 137,
    viemChain: polygon,
    nativeSymbol: "POL",
    explorer: "https://polygonscan.com",
    rpcs: [
      "https://polygon-rpc.com",
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon.llamarpc.com",
      "https://rpc.ankr.com/polygon",
    ],
    weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WPOL (was WMATIC)
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    tokens: {
      WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      "USDC.e": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
      WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    },
    uniswapV3: {
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    },
    aggregators: ["0x", "1inch"],
  },
};

export function listChains(): string[] {
  return Object.keys(profiles);
}

export function getBuiltinProfile(name: string): ChainProfile | undefined {
  return profiles[name.toLowerCase()];
}

export function profileByChainId(chainId: number): ChainProfile | undefined {
  return Object.values(profiles).find((p) => p.chainId === chainId);
}

/**
 * Build a viem transport with automatic failover across the profile's RPC list,
 * plus any extra RPCs provided (typically from user config).
 */
export function makeTransport(profile: ChainProfile, extraRpcs: string[] = []): Transport {
  const all = [...extraRpcs, ...profile.rpcs].filter((u, i, arr) => arr.indexOf(u) === i);
  if (all.length === 0) throw new Error(`No RPC available for chain "${profile.name}"`);
  // Per-RPC timeout was 15s × retryCount=1 = 30s before failover. With 4 RPCs in the
  // typical profile that's up to 120s of "tool looks hung" if the primary is down.
  // Cut: 8s timeout (matches our http.ts default), inner retryCount=0 (the next-RPC
  // failover IS our retry mechanism). Outer fallback retryCount=1 still gives a single
  // whole-pool retry for transient sub-second flakes.
  return fallback(
    all.map((url) => http(url, { retryCount: 0, timeout: 8_000 })),
    { rank: false, retryCount: 1 },
  );
}

/** Resolve token symbol or address to a checksummed address using the profile's token list. */
/**
 * Validate that a chain name resolves to either a built-in or a user-configured chain.
 * Throws UNKNOWN_CHAIN with the known list when it doesn't. Pass `undefined` to no-op.
 *
 * Iter287: extracted so the chain-filter check is identical across CLI / MCP / web.
 * Pre-iter287 each surface either re-implemented this inline (cli/admin.ts:reconcile
 * iter286) or skipped validation entirely (web /api/reconcile, MCP reconcile tool) —
 * the latter let a typo'd chain silently produce a "no pending trades" no-op.
 */
/**
 * Two-step address validator. Shape check first (rejects truly malformed input);
 * strict EIP-55 second (rejects mixed-case addresses whose checksum doesn't match,
 * catching single-character paste typos in addresses copied from a block explorer).
 *
 * Lowercase addresses pass the strict check (EIP-55 spec treats all-lowercase as
 * the "checksum not specified" form), so an operator who knows their source is
 * trustworthy can lowercase to bypass the typo net.
 *
 * Iter292: extracted from cli/approvals.ts assertAddress + mcp/security-tools.ts
 * assertCheckedSpender — two near-identical helpers diverged on the error message
 * shape. Now one source of truth.
 */
export function assertAddressEIP55(label: string, raw: string): Address {
  if (!isAddress(raw, { strict: false })) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Invalid ${label} address "${raw}" — expected 0x-prefixed 40 hex chars.`,
    );
  }
  if (!isAddress(raw)) {
    const Label = label[0].toUpperCase() + label.slice(1);
    throw new ToolError(
      "INVALID_PARAMS",
      `${Label} address "${raw}" has an invalid EIP-55 checksum — likely a typo or partial copy/paste. Re-copy from a trusted source, or pass the address all-lowercase to disable checksum verification.`,
    );
  }
  return raw as Address;
}

export function assertKnownChain(chainName: string | undefined, config: Config): void {
  if (!chainName) return;
  const known = [...listChains(), ...Object.keys(config.chains ?? {})];
  if (!known.includes(chainName.toLowerCase())) {
    // Iter383: parity with iter343's resolveProfile UNKNOWN_CHAIN — surface a
    // closest-match suggestion via closestMatch. Pre-iter383 this helper just
    // listed known chains with no "Did you mean" hint, even though resolveProfile
    // (the other UNKNOWN_CHAIN source) had been doing this since iter343.
    const suggestion = closestMatch(chainName, known);
    const suggestionNote = suggestion ? ` Did you mean "${suggestion}"?` : "";
    throw new ToolError(
      "UNKNOWN_CHAIN",
      `Unknown chain "${chainName}".${suggestionNote} Known: ${known.join(", ")}.`,
      { details: { chain: chainName, known, suggestion } },
    );
  }
}

export function resolveToken(profile: ChainProfile, input: string): Address | null {
  const trimmed = input.trim();
  // Pre-iter122 the check was `startsWith("0x") && length === 42` — that passed
  // through addresses like "0xzzzz..." (right length, non-hex), and the bad value
  // surfaced much later as an opaque viem contract-read error. viem's isAddress does
  // a proper 0x + 40-hex check (and accepts both checksummed and lowercased forms).
  if (isAddress(trimmed, { strict: false })) return trimmed as Address;
  const upper = trimmed.toUpperCase();
  if (upper === "ETH" || upper === "NATIVE") return profile.weth;
  // Exact symbol match
  for (const [sym, addr] of Object.entries(profile.tokens)) {
    if (sym.toUpperCase() === upper) return addr;
  }
  return null;
}

/**
 * Resolve a (base, quote) pair into the shape executeTrade expects: base is preserved as
 * the literal "ETH" sentinel for native (so the trade flow takes the native code path
 * rather than wrapping/unwrapping WETH); quote must be a real ERC20 address.
 *
 * Used by CLI/MCP/web trade entry points — extracted so the throw-on-unresolved logic
 * (which subtly handles the ETH special case) lives in exactly one place.
 */
export function resolveTradePair(
  profile: ChainProfile,
  baseInput: string,
  quoteInput: string,
): { base: Address | "ETH"; quote: Address } {
  const baseUpper = baseInput.toUpperCase();
  const baseIsNative = baseUpper === "ETH" || baseUpper === "NATIVE";
  const quoteAddr = resolveToken(profile, quoteInput);
  // Iter298: same actionable shape as iter296/297 — name the chain (already done)
  // AND point the operator/agent at the recovery (token list / pass an address).
  if (!quoteAddr) throw unknownTokenError("quote token", quoteInput, profile);
  if (baseIsNative) return { base: "ETH", quote: quoteAddr };
  const baseAddr = resolveToken(profile, baseInput);
  if (!baseAddr) throw unknownTokenError("base token", baseInput, profile);
  return { base: baseAddr, quote: quoteAddr };
}

/**
 * Build an UNKNOWN_TOKEN error with the iter298 "Pass the 0x address" footer AND an
 * iter345 closest-match suggestion when the input is a symbol (not an address). Pre-
 * iter345 a typo like `--quote USDT` on a chain with only USDC produced a dead-end
 * "Cannot resolve ... known symbols" message; operators had to read `token list` to
 * find the typo themselves. Same UX as iter343 (chains), iter344 (accounts), iter162/164
 * (commands + sub-actions).
 *
 * Skips the suggestion for inputs that look like an address (0x…) — addresses are
 * unique and Levenshtein doesn't help.
 */
export function unknownTokenError(role: string, input: string, profile: ChainProfile): ToolError {
  const looksLikeAddress = /^0x/i.test(input.trim());
  const knownSymbols = Object.keys(profile.tokens);
  const suggestion = looksLikeAddress ? null : closestMatch(input, knownSymbols);
  const suggestionNote = suggestion ? ` Did you mean "${suggestion}"?` : "";
  return new ToolError(
    "UNKNOWN_TOKEN",
    `Cannot resolve ${role} "${input}" on chain "${profile.name}".${suggestionNote} Pass the 0x address, or check \`tradekit token list ${profile.name}\` for known symbols.`,
    { details: { token: input, chain: profile.name, suggestion } },
  );
}
