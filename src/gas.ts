import {
  createPublicClient,
  formatEther,
  formatUnits,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { makeTransport, type ChainProfile } from "./chains.js";
import { ToolError, rpcFailedChainError } from "./errors.js";
import { getCurrentPrice } from "./price.js";
import { formatUsd } from "./holdings.js";
import type { Logger } from "./logger.js";

/** Approximate gas units for a typical aggregator swap on each chain.
 *  Used to translate raw gwei into a realistic dollar estimate.
 *  Sources: historical median of KyberSwap/OpenOcean swaps on each chain. */
const TYPICAL_SWAP_GAS: Record<string, number> = {
  ethereum: 220_000,
  base: 240_000,
  arbitrum: 800_000, // Arbitrum charges more units; gas price is much lower
  optimism: 240_000,
  bnb: 200_000,
  polygon: 250_000,
};

export interface GasSnapshot {
  chain: string;
  chainId: number;
  /** ISO timestamp when this snapshot was taken — lets cache layers + watch-mode
   *  consumers reason about freshness without inferring from block times. */
  timestamp: string;
  /** Latest block number observed during the snapshot. */
  blockNumber: number;
  /** Native asset symbol (ETH, BNB, POL, …) and current USD price (if known). */
  nativeSymbol: string;
  nativeUsd: number | null;

  // Fee components in wei
  baseFeeWei: string | null;
  priorityFeeWei: string;
  maxFeeWei: string;

  // Convenience: gwei view (the unit humans expect)
  baseFeeGwei: string | null;
  priorityFeeGwei: string;
  maxFeeGwei: string;

  /** Native currency cost of a "typical aggregator swap" at the current max fee. */
  typicalSwapNative: string;
  /** USD cost of a typical aggregator swap (null if native USD price unknown). */
  typicalSwapUsd: number | null;
  /** Gas units used as the basis for the typical-swap estimate. */
  typicalSwapGasUnits: number;

  /** Heuristic verdict for an Agent: "cheap" / "normal" / "expensive". Chain-specific thresholds. */
  verdict: "cheap" | "normal" | "expensive" | "unknown";
}

function bigintToGwei(wei: bigint): string {
  return formatUnits(wei, 9);
}

export function verdictForChain(chain: string, maxFeeGwei: number): GasSnapshot["verdict"] {
  // Per-chain thresholds based on common operating ranges. Imperfect but useful.
  const thresholds: Record<string, [number, number]> = {
    ethereum: [10, 50],
    base: [0.01, 0.5],
    arbitrum: [0.01, 0.5],
    optimism: [0.001, 0.05],
    bnb: [1, 5],
    polygon: [30, 200],
  };
  const t = thresholds[chain];
  if (!t) return "unknown";
  if (maxFeeGwei <= t[0]) return "cheap";
  if (maxFeeGwei <= t[1]) return "normal";
  return "expensive";
}

export async function gasSnapshot(
  profile: ChainProfile,
  extraRpcs: string[],
  logger: Logger,
): Promise<GasSnapshot> {
  const transport = makeTransport(profile, extraRpcs);
  const client = createPublicClient({ chain: profile.viemChain, transport }) as PublicClient<Transport, Chain>;

  // All four reads are independent — parallelize so the snapshot stays snappy on
  // chains where each RPC roundtrip is ~100ms. Failures are handled below per-call.
  const [blockRes, feesRes, latestBlockRes, nativeUsd] = await Promise.all([
    client.getBlockNumber().then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, e }),
    ),
    client.estimateFeesPerGas().then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, e }),
    ),
    client.getBlock({ blockTag: "latest" }).then(
      (v) => ({ ok: true as const, v }),
      () => ({ ok: false as const }),
    ),
    getCurrentPrice(profile.weth, logger).catch(() => null),
  ]);

  if (!blockRes.ok) {
    throw rpcFailedChainError(
      profile.name,
      `Could not fetch block number on ${profile.name}: ${blockRes.e.message}`,
      "getBlockNumber",
    );
  }
  const block = blockRes.v;

  // viem's estimateFeesPerGas returns { maxFeePerGas, maxPriorityFeePerGas, gasPrice? }.
  // Fall back to legacy getGasPrice if it errors (e.g. non-EIP-1559 chains).
  let priorityFee = 0n;
  let maxFee = 0n;
  if (feesRes.ok) {
    priorityFee = feesRes.v.maxPriorityFeePerGas ?? 0n;
    maxFee = feesRes.v.maxFeePerGas ?? feesRes.v.gasPrice ?? 0n;
  } else {
    logger.debug(`estimateFeesPerGas failed: ${feesRes.e.message}`);
    try {
      maxFee = await client.getGasPrice();
    } catch (e2) {
      throw rpcFailedChainError(
        profile.name,
        `Could not estimate fees on ${profile.name}: ${(e2 as Error).message}`,
        "estimateFeesPerGas+getGasPrice",
      );
    }
  }

  const baseFee = latestBlockRes.ok ? latestBlockRes.v.baseFeePerGas ?? null : null;

  const gasUnits = TYPICAL_SWAP_GAS[profile.name] ?? 250_000;
  const costWei = maxFee * BigInt(gasUnits);
  const costNative = formatEther(costWei);
  const costUsd = nativeUsd != null ? parseFloat(costNative) * nativeUsd : null;

  const maxFeeGweiNum = parseFloat(bigintToGwei(maxFee));
  return {
    chain: profile.name,
    chainId: profile.chainId,
    timestamp: new Date().toISOString(),
    blockNumber: Number(block),
    nativeSymbol: profile.nativeSymbol,
    nativeUsd,

    baseFeeWei: baseFee != null ? baseFee.toString() : null,
    priorityFeeWei: priorityFee.toString(),
    maxFeeWei: maxFee.toString(),

    baseFeeGwei: baseFee != null ? bigintToGwei(baseFee) : null,
    priorityFeeGwei: bigintToGwei(priorityFee),
    maxFeeGwei: bigintToGwei(maxFee),

    typicalSwapNative: costNative,
    typicalSwapUsd: costUsd,
    typicalSwapGasUnits: gasUnits,

    verdict: verdictForChain(profile.name, maxFeeGweiNum),
  };
}

export function formatGasSnapshot(g: GasSnapshot): string {
  const verdictDecoration: Record<GasSnapshot["verdict"], string> = {
    cheap: "✓ cheap",
    normal: "  normal",
    expensive: "⚠ expensive",
    unknown: "  -",
  };
  const lines: string[] = [];
  lines.push(`Chain:       ${g.chain} (id=${g.chainId})  block=${g.blockNumber}`);
  lines.push(`Native:      ${g.nativeSymbol}${g.nativeUsd != null ? `  @  ${formatUsd(g.nativeUsd)}` : ""}`);
  lines.push("");
  if (g.baseFeeGwei) {
    lines.push(`  Base fee:     ${Number(g.baseFeeGwei).toFixed(6)} gwei`);
  }
  lines.push(`  Priority fee: ${Number(g.priorityFeeGwei).toFixed(6)} gwei`);
  lines.push(`  Max fee:      ${Number(g.maxFeeGwei).toFixed(6)} gwei    ${verdictDecoration[g.verdict]}`);
  lines.push("");
  lines.push(
    `  Typical swap (~${g.typicalSwapGasUnits.toLocaleString()} gas) ≈ ${g.typicalSwapNative} ${g.nativeSymbol}` +
      (g.typicalSwapUsd != null ? `  (~${formatUsd(g.typicalSwapUsd)})` : ""),
  );
  return lines.join("\n");
}
