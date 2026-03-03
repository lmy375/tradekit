import type { Address, Chain } from "viem";

export interface ChainConfig {
  chainId: number;
  rpc: string;
  weth: Address;
  usdc: Address;
  swapRouter02: Address;
  quoterV2: Address;
  viemChain: Chain;
}

export interface UserChainOverride {
  chainId?: number;
  rpc?: string;
  weth?: string;
  usdc?: string;
  swapRouter02?: string;
  quoterV2?: string;
  base?: string;
  quote?: string;
}

export interface UserConfig {
  chains?: Record<string, UserChainOverride>;
}

export interface ServerConfig {
  chainName: string;
  chainConfig: ChainConfig;
  rpcUrl: string;
  baseToken: Address;
  quoteToken: Address;
  isBaseNative: boolean;
  walletPass: string;
  routerAddress: Address;
  quoterAddress: Address;
}

export interface SwapResult {
  txHash: string;
  direction: "buy" | "sell";
  baseAmount: string;
  quoteAmount: string;
  price: string;
  gasUsed: string;
  feeTier: number;
  status: "success" | "failed";
}

export interface TradeRecord {
  timestamp: string;
  direction: "buy" | "sell";
  baseAmount: string;
  quoteAmount: string;
  price: string;
  txHash: string;
  status: string;
  gasUsed: string;
  feeTier: number;
}

export interface QuoteResult {
  amountIn: bigint;
  amountOut: bigint;
  feeTier: number;
  sqrtPriceX96After: bigint;
}
