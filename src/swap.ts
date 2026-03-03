import {
  encodeFunctionData,
  formatUnits,
  type Address,
  type PublicClient,
  type WalletClient,
  type Account,
  type Transport,
  type Chain,
} from "viem";
import { SWAP_ROUTER_ABI, ERC20_ABI } from "./constants.js";
import { getQuoteExactInput, getQuoteExactOutput } from "./quote.js";
import type { ServerConfig, SwapResult } from "./types.js";
import type { Logger } from "./logger.js";

const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%

interface SwapContext {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
  config: ServerConfig;
  logger: Logger;
}

async function getDecimals(
  publicClient: PublicClient<Transport, Chain>,
  token: Address,
): Promise<number> {
  const decimals = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "decimals",
  });
  return decimals;
}

async function ensureApproval(
  ctx: SwapContext,
  token: Address,
  amount: bigint,
): Promise<void> {
  const allowance = await ctx.publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [ctx.walletClient.account.address, ctx.config.routerAddress],
  });

  if (allowance < amount) {
    ctx.logger.info(`Approving ${token} for router...`);
    const hash = await ctx.walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ctx.config.routerAddress, amount * 2n],
    });
    await ctx.publicClient.waitForTransactionReceipt({ hash });
    ctx.logger.info(`Approval tx: ${hash}`);
  }
}

async function executeSwap(
  ctx: SwapContext,
  calldata: `0x${string}`[],
  value: bigint,
  direction: "buy" | "sell",
  baseAmount: string,
  quoteAmount: string,
  price: string,
  feeTier: number,
): Promise<SwapResult> {
  let txHash: string;

  // Always use multicall — even for single call, keeps it uniform
  txHash = await ctx.walletClient.writeContract({
    address: ctx.config.routerAddress,
    abi: SWAP_ROUTER_ABI,
    functionName: "multicall",
    args: [calldata],
    value,
  });

  ctx.logger.info(`Swap tx sent: ${txHash}`);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  const status = receipt.status === "success" ? "success" : "failed";
  const gasUsed = receipt.gasUsed.toString();

  ctx.logger.info(`Swap ${status}: gas=${gasUsed}`);

  return {
    txHash,
    direction,
    baseAmount,
    quoteAmount,
    price,
    gasUsed,
    feeTier,
    status,
  };
}

// ---- SELL base ----

/** Sell exact baseAmount of base token, receive quote */
export async function sellBase(
  ctx: SwapContext,
  baseAmount: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): Promise<SwapResult> {
  const { config, logger, publicClient } = ctx;
  const tokenIn = config.isBaseNative ? config.chainConfig.weth : config.baseToken;
  const tokenOut = config.quoteToken;

  // Get quote
  const quote = await getQuoteExactInput(
    publicClient,
    config.quoterAddress,
    tokenIn,
    tokenOut,
    baseAmount,
    logger,
  );

  const amountOutMinimum =
    quote.amountOut - (quote.amountOut * BigInt(slippageBps)) / 10000n;

  const calldata: `0x${string}`[] = [];
  let value = 0n;

  if (config.isBaseNative) {
    // Selling ETH: send ETH value, router wraps to WETH
    value = baseAmount;
    const swapData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.feeTier,
          recipient: ctx.walletClient.account.address,
          amountIn: baseAmount,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    calldata.push(swapData);
  } else {
    // Selling ERC20 base
    await ensureApproval(ctx, tokenIn, baseAmount);
    const swapData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.feeTier,
          recipient: ctx.walletClient.account.address,
          amountIn: baseAmount,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    calldata.push(swapData);
  }

  const baseAmountStr = formatUnits(baseAmount, baseDecimals);
  const quoteAmountStr = formatUnits(quote.amountOut, quoteDecimals);
  const price = (
    parseFloat(quoteAmountStr) / parseFloat(baseAmountStr)
  ).toFixed(6);

  return executeSwap(
    ctx,
    calldata,
    value,
    "sell",
    baseAmountStr,
    quoteAmountStr,
    price,
    quote.feeTier,
  );
}

/** Sell base token until receiving exact quoteAmount of quote */
export async function sellBaseForQuoteAmount(
  ctx: SwapContext,
  quoteAmount: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): Promise<SwapResult> {
  const { config, logger, publicClient } = ctx;
  const tokenIn = config.isBaseNative ? config.chainConfig.weth : config.baseToken;
  const tokenOut = config.quoteToken;

  // Get quote: how much base to sell to get quoteAmount
  const quote = await getQuoteExactOutput(
    publicClient,
    config.quoterAddress,
    tokenIn,
    tokenOut,
    quoteAmount,
    logger,
  );

  const amountInMaximum =
    quote.amountIn + (quote.amountIn * BigInt(slippageBps)) / 10000n;

  const calldata: `0x${string}`[] = [];
  let value = 0n;

  if (config.isBaseNative) {
    value = amountInMaximum;
    const swapData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactOutputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.feeTier,
          recipient: ctx.walletClient.account.address,
          amountOut: quoteAmount,
          amountInMaximum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    calldata.push(swapData);
    // Refund excess ETH
    calldata.push(
      encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "refundETH",
        args: [],
      }),
    );
  } else {
    await ensureApproval(ctx, tokenIn, amountInMaximum);
    const swapData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactOutputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.feeTier,
          recipient: ctx.walletClient.account.address,
          amountOut: quoteAmount,
          amountInMaximum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    calldata.push(swapData);
  }

  const baseAmountStr = formatUnits(quote.amountIn, baseDecimals);
  const quoteAmountStr = formatUnits(quoteAmount, quoteDecimals);
  const price = (
    parseFloat(quoteAmountStr) / parseFloat(baseAmountStr)
  ).toFixed(6);

  return executeSwap(
    ctx,
    calldata,
    value,
    "sell",
    baseAmountStr,
    quoteAmountStr,
    price,
    quote.feeTier,
  );
}

// ---- BUY base ----

/** Buy exact baseAmount of base token, paying with quote */
export async function buyBase(
  ctx: SwapContext,
  baseAmount: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): Promise<SwapResult> {
  const { config, logger, publicClient } = ctx;
  const tokenIn = config.quoteToken;
  const tokenOut = config.isBaseNative ? config.chainConfig.weth : config.baseToken;

  // Get quote: how much quote to pay for baseAmount
  const quote = await getQuoteExactOutput(
    publicClient,
    config.quoterAddress,
    tokenIn,
    tokenOut,
    baseAmount,
    logger,
  );

  const amountInMaximum =
    quote.amountIn + (quote.amountIn * BigInt(slippageBps)) / 10000n;

  await ensureApproval(ctx, tokenIn, amountInMaximum);

  const calldata: `0x${string}`[] = [];

  if (config.isBaseNative) {
    // Buying ETH: swap quote→WETH, then unwrap WETH to ETH
    const swapData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactOutputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.feeTier,
          recipient: config.routerAddress, // send WETH to router for unwrap
          amountOut: baseAmount,
          amountInMaximum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    calldata.push(swapData);
    // Unwrap WETH to ETH and send to user
    calldata.push(
      encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "unwrapWETH9",
        args: [0n, ctx.walletClient.account.address],
      }),
    );
  } else {
    const swapData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactOutputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.feeTier,
          recipient: ctx.walletClient.account.address,
          amountOut: baseAmount,
          amountInMaximum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    calldata.push(swapData);
  }

  const baseAmountStr = formatUnits(baseAmount, baseDecimals);
  const quoteAmountStr = formatUnits(quote.amountIn, quoteDecimals);
  const price = (
    parseFloat(quoteAmountStr) / parseFloat(baseAmountStr)
  ).toFixed(6);

  return executeSwap(ctx, calldata, 0n, "buy", baseAmountStr, quoteAmountStr, price, quote.feeTier);
}

/** Buy base token by spending exact quoteAmount of quote */
export async function buyBaseWithQuoteAmount(
  ctx: SwapContext,
  quoteAmount: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): Promise<SwapResult> {
  const { config, logger, publicClient } = ctx;
  const tokenIn = config.quoteToken;
  const tokenOut = config.isBaseNative ? config.chainConfig.weth : config.baseToken;

  // Get quote: how much base we get for quoteAmount
  const quote = await getQuoteExactInput(
    publicClient,
    config.quoterAddress,
    tokenIn,
    tokenOut,
    quoteAmount,
    logger,
  );

  const amountOutMinimum =
    quote.amountOut - (quote.amountOut * BigInt(slippageBps)) / 10000n;

  await ensureApproval(ctx, tokenIn, quoteAmount);

  const calldata: `0x${string}`[] = [];

  if (config.isBaseNative) {
    // Buying ETH: swap quote→WETH, then unwrap
    const swapData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.feeTier,
          recipient: config.routerAddress, // send WETH to router for unwrap
          amountIn: quoteAmount,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    calldata.push(swapData);
    calldata.push(
      encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "unwrapWETH9",
        args: [amountOutMinimum, ctx.walletClient.account.address],
      }),
    );
  } else {
    const swapData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.feeTier,
          recipient: ctx.walletClient.account.address,
          amountIn: quoteAmount,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    calldata.push(swapData);
  }

  const baseAmountStr = formatUnits(quote.amountOut, baseDecimals);
  const quoteAmountStr = formatUnits(quoteAmount, quoteDecimals);
  const price = (
    parseFloat(quoteAmountStr) / parseFloat(baseAmountStr)
  ).toFixed(6);

  return executeSwap(ctx, calldata, 0n, "buy", baseAmountStr, quoteAmountStr, price, quote.feeTier);
}
