import type { Address, PublicClient, Transport, Chain } from "viem";
import { QUOTER_V2_ABI, FEE_TIERS } from "./constants.js";
import type { QuoteResult } from "./types.js";
import type { Logger } from "./logger.js";

export async function getQuoteExactInput(
  publicClient: PublicClient<Transport, Chain>,
  quoterAddress: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  logger: Logger,
): Promise<QuoteResult> {
  let lastError: Error | undefined;

  for (const fee of FEE_TIERS) {
    try {
      const { result } = await publicClient.simulateContract({
        address: quoterAddress,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });

      const [amountOut, sqrtPriceX96After] = result;
      logger.debug(`Quote exactInput fee=${fee}: ${amountIn} → ${amountOut}`);
      return { amountIn, amountOut, feeTier: fee, sqrtPriceX96After };
    } catch (e) {
      lastError = e as Error;
      logger.debug(`Quote exactInput fee=${fee} failed: ${(e as Error).message}`);
    }
  }

  throw new Error(`All fee tiers failed for exactInput quote: ${lastError?.message}`);
}

export async function getQuoteExactOutput(
  publicClient: PublicClient<Transport, Chain>,
  quoterAddress: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountOut: bigint,
  logger: Logger,
): Promise<QuoteResult> {
  let lastError: Error | undefined;

  for (const fee of FEE_TIERS) {
    try {
      const { result } = await publicClient.simulateContract({
        address: quoterAddress,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactOutputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            amount: amountOut,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });

      const [amountIn, sqrtPriceX96After] = result;
      logger.debug(`Quote exactOutput fee=${fee}: ${amountOut} ← ${amountIn}`);
      return { amountIn, amountOut, feeTier: fee, sqrtPriceX96After };
    } catch (e) {
      lastError = e as Error;
      logger.debug(`Quote exactOutput fee=${fee} failed: ${(e as Error).message}`);
    }
  }

  throw new Error(`All fee tiers failed for exactOutput quote: ${lastError?.message}`);
}
