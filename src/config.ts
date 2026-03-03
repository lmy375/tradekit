import { readFileSync } from "fs";
import { CHAIN_CONFIGS, CONFIG_PATH } from "./constants.js";
import type { ChainConfig, UserConfig, UserChainOverride } from "./types.js";
import type { Address, Chain } from "viem";
import * as viemChains from "viem/chains";

export function loadUserConfig(): UserConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as UserConfig;
  } catch {
    return {};
  }
}

function findViemChain(chainId: number): Chain | undefined {
  for (const chain of Object.values(viemChains)) {
    if (typeof chain === "object" && chain !== null && "id" in chain && chain.id === chainId) {
      return chain as Chain;
    }
  }
  return undefined;
}

export function resolveChainConfig(
  chainName: string,
  userConfig: UserConfig,
): ChainConfig {
  const builtin = CHAIN_CONFIGS[chainName];
  const userOverride = userConfig.chains?.[chainName];

  if (!builtin && !userOverride) {
    throw new Error(
      `Unknown chain "${chainName}". Available: ${Object.keys(CHAIN_CONFIGS).join(", ")}`,
    );
  }

  if (!builtin && userOverride) {
    // User-defined chain — require all fields
    const required = ["chainId", "rpc", "weth", "usdc", "swapRouter02", "quoterV2"] as const;
    for (const field of required) {
      if (!userOverride[field]) {
        throw new Error(
          `Custom chain "${chainName}" missing required field: ${field}`,
        );
      }
    }
    const chainId = userOverride.chainId!;
    const viemChain = findViemChain(chainId);
    if (!viemChain) {
      throw new Error(
        `No viem chain found for chainId ${chainId}. Custom chains without viem support are not yet supported.`,
      );
    }
    return {
      chainId,
      rpc: userOverride.rpc!,
      weth: userOverride.weth! as Address,
      usdc: userOverride.usdc! as Address,
      swapRouter02: userOverride.swapRouter02! as Address,
      quoterV2: userOverride.quoterV2! as Address,
      viemChain,
    };
  }

  // Deep merge: user override on top of builtin
  return deepMergeChainConfig(builtin!, userOverride);
}

function deepMergeChainConfig(
  base: ChainConfig,
  override?: UserChainOverride,
): ChainConfig {
  if (!override) return { ...base };
  return {
    chainId: override.chainId ?? base.chainId,
    rpc: override.rpc ?? base.rpc,
    weth: (override.weth as Address) ?? base.weth,
    usdc: (override.usdc as Address) ?? base.usdc,
    swapRouter02: (override.swapRouter02 as Address) ?? base.swapRouter02,
    quoterV2: (override.quoterV2 as Address) ?? base.quoterV2,
    viemChain: base.viemChain,
  };
}
