import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatUnits, parseUnits, formatEther, type Address } from "viem";
import { ERC20_ABI } from "./constants.js";
import { sellBase, sellBaseForQuoteAmount, buyBase, buyBaseWithQuoteAmount } from "./swap.js";
import { getCurrentPrice, getPriceHistory } from "./price.js";
import type { ServerConfig } from "./types.js";
import type { Logger } from "./logger.js";
import type { WalletContext } from "./wallet.js";

interface ServerDeps {
  config: ServerConfig;
  wallet: WalletContext;
  logger: Logger;
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const { config, wallet, logger } = deps;
  const { account, publicClient, walletClient } = wallet;

  const server = new McpServer({
    name: "tradekit",
    version: "1.0.0",
  });

  // Cache token info
  let baseDecimals: number | undefined;
  let quoteDecimals: number | undefined;
  let baseSymbol: string | undefined;
  let quoteSymbol: string | undefined;

  async function getBaseDecimals(): Promise<number> {
    if (baseDecimals !== undefined) return baseDecimals;
    if (config.isBaseNative) {
      baseDecimals = 18;
    } else {
      baseDecimals = await publicClient.readContract({
        address: config.baseToken,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
    }
    return baseDecimals;
  }

  async function getQuoteDecimals(): Promise<number> {
    if (quoteDecimals !== undefined) return quoteDecimals;
    quoteDecimals = await publicClient.readContract({
      address: config.quoteToken,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
    return quoteDecimals;
  }

  async function getBaseSymbol(): Promise<string> {
    if (baseSymbol !== undefined) return baseSymbol;
    if (config.isBaseNative) {
      baseSymbol = "ETH";
    } else {
      baseSymbol = await publicClient.readContract({
        address: config.baseToken,
        abi: ERC20_ABI,
        functionName: "symbol",
      });
    }
    return baseSymbol;
  }

  async function getQuoteSymbol(): Promise<string> {
    if (quoteSymbol !== undefined) return quoteSymbol;
    quoteSymbol = await publicClient.readContract({
      address: config.quoteToken,
      abi: ERC20_ABI,
      functionName: "symbol",
    });
    return quoteSymbol;
  }

  // ---- status tool ----
  server.tool("status", "Wallet status: address, balances, price, recent trades", {}, async () => {
    try {
      const [bDec, qDec, bSym, qSym] = await Promise.all([
        getBaseDecimals(),
        getQuoteDecimals(),
        getBaseSymbol(),
        getQuoteSymbol(),
      ]);

      // Balances
      let baseBalance: bigint;
      if (config.isBaseNative) {
        baseBalance = await publicClient.getBalance({
          address: account.address,
        });
      } else {
        baseBalance = await publicClient.readContract({
          address: config.baseToken,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        });
      }

      const quoteBalance = await publicClient.readContract({
        address: config.quoteToken,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });

      const baseBalanceStr = formatUnits(baseBalance, bDec);
      const quoteBalanceStr = formatUnits(quoteBalance, qDec);

      // Price
      const baseTokenAddr = config.isBaseNative
        ? config.chainConfig.weth
        : config.baseToken;
      const basePrice = await getCurrentPrice(baseTokenAddr, logger);
      const quotePrice = await getCurrentPrice(config.quoteToken, logger);

      let usdTotal = "N/A";
      if (basePrice != null && quotePrice != null) {
        const baseParsed = parseFloat(baseBalanceStr);
        const quoteParsed = parseFloat(quoteBalanceStr);
        const total = baseParsed * basePrice + quoteParsed * quotePrice;
        usdTotal = `$${total.toFixed(2)}`;
      }

      // Recent trades
      const trades = logger.readRecentTrades(10);
      const tradeLines =
        trades.length > 0
          ? trades
              .map(
                (t) =>
                  `  ${t.timestamp} ${t.direction.toUpperCase()} ${t.baseAmount} ${bSym} @ ${t.price} (${t.status})`,
              )
              .join("\n")
          : "  No trades yet";

      const text = [
        `Chain:   ${config.chainName}`,
        `Wallet:  ${account.address}`,
        `Pair:    ${bSym}/${qSym}`,
        ``,
        `Balances:`,
        `  ${bSym}: ${baseBalanceStr}`,
        `  ${qSym}: ${quoteBalanceStr}`,
        ``,
        `Price:   ${basePrice != null ? `$${basePrice.toFixed(2)}` : "N/A"} per ${bSym}`,
        `Total:   ${usdTotal}`,
        ``,
        `Recent Trades:`,
        tradeLines,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e) {
      logger.error(`status error: ${(e as Error).message}`);
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  // ---- buy tool ----
  server.tool(
    "buy",
    "Buy base asset. Specify either baseAmount (exact base to buy) or quoteAmount (exact quote to spend)",
    {
      baseAmount: z.number().positive().optional().describe("Exact amount of base to buy"),
      quoteAmount: z.number().positive().optional().describe("Exact amount of quote to spend"),
      slippageBps: z.number().int().min(1).max(5000).optional().describe("Slippage tolerance in basis points (default 50 = 0.5%)"),
    },
    async ({ baseAmount, quoteAmount, slippageBps }) => {
      try {
        if (baseAmount != null && quoteAmount != null) {
          return {
            content: [{ type: "text", text: "Error: specify either baseAmount or quoteAmount, not both" }],
            isError: true,
          };
        }
        if (baseAmount == null && quoteAmount == null) {
          return {
            content: [{ type: "text", text: "Error: specify either baseAmount or quoteAmount" }],
            isError: true,
          };
        }

        const [bDec, qDec, bSym, qSym] = await Promise.all([
          getBaseDecimals(),
          getQuoteDecimals(),
          getBaseSymbol(),
          getQuoteSymbol(),
        ]);

        const swapCtx = { publicClient, walletClient, config, logger };
        let result;

        if (baseAmount != null) {
          const amount = parseUnits(baseAmount.toString(), bDec);
          logger.info(`BUY: exact ${baseAmount} ${bSym}`);
          result = await buyBase(swapCtx, amount, bDec, qDec, slippageBps);
        } else {
          const amount = parseUnits(quoteAmount!.toString(), qDec);
          logger.info(`BUY: spend ${quoteAmount} ${qSym}`);
          result = await buyBaseWithQuoteAmount(swapCtx, amount, bDec, qDec, slippageBps);
        }

        logger.recordTrade({
          timestamp: new Date().toISOString(),
          direction: result.direction,
          baseAmount: result.baseAmount,
          quoteAmount: result.quoteAmount,
          price: result.price,
          txHash: result.txHash,
          status: result.status,
          gasUsed: result.gasUsed,
          feeTier: result.feeTier,
        });

        const text = [
          `BUY ${result.status.toUpperCase()}`,
          `  ${bSym}: +${result.baseAmount}`,
          `  ${qSym}: -${result.quoteAmount}`,
          `  Price: ${result.price} ${qSym}/${bSym}`,
          `  Fee tier: ${result.feeTier / 10000}%`,
          `  Gas: ${result.gasUsed}`,
          `  Tx: ${result.txHash}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (e) {
        logger.error(`buy error: ${(e as Error).message}`);
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ---- sell tool ----
  server.tool(
    "sell",
    "Sell base asset. Specify either baseAmount (exact base to sell) or quoteAmount (exact quote to receive)",
    {
      baseAmount: z.number().positive().optional().describe("Exact amount of base to sell"),
      quoteAmount: z.number().positive().optional().describe("Exact amount of quote to receive"),
      slippageBps: z.number().int().min(1).max(5000).optional().describe("Slippage tolerance in basis points (default 50 = 0.5%)"),
    },
    async ({ baseAmount, quoteAmount, slippageBps }) => {
      try {
        if (baseAmount != null && quoteAmount != null) {
          return {
            content: [{ type: "text", text: "Error: specify either baseAmount or quoteAmount, not both" }],
            isError: true,
          };
        }
        if (baseAmount == null && quoteAmount == null) {
          return {
            content: [{ type: "text", text: "Error: specify either baseAmount or quoteAmount" }],
            isError: true,
          };
        }

        const [bDec, qDec, bSym, qSym] = await Promise.all([
          getBaseDecimals(),
          getQuoteDecimals(),
          getBaseSymbol(),
          getQuoteSymbol(),
        ]);

        const swapCtx = { publicClient, walletClient, config, logger };
        let result;

        if (baseAmount != null) {
          const amount = parseUnits(baseAmount.toString(), bDec);
          logger.info(`SELL: exact ${baseAmount} ${bSym}`);
          result = await sellBase(swapCtx, amount, bDec, qDec, slippageBps);
        } else {
          const amount = parseUnits(quoteAmount!.toString(), qDec);
          logger.info(`SELL: receive ${quoteAmount} ${qSym}`);
          result = await sellBaseForQuoteAmount(swapCtx, amount, bDec, qDec, slippageBps);
        }

        logger.recordTrade({
          timestamp: new Date().toISOString(),
          direction: result.direction,
          baseAmount: result.baseAmount,
          quoteAmount: result.quoteAmount,
          price: result.price,
          txHash: result.txHash,
          status: result.status,
          gasUsed: result.gasUsed,
          feeTier: result.feeTier,
        });

        const text = [
          `SELL ${result.status.toUpperCase()}`,
          `  ${bSym}: -${result.baseAmount}`,
          `  ${qSym}: +${result.quoteAmount}`,
          `  Price: ${result.price} ${qSym}/${bSym}`,
          `  Fee tier: ${result.feeTier / 10000}%`,
          `  Gas: ${result.gasUsed}`,
          `  Tx: ${result.txHash}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (e) {
        logger.error(`sell error: ${(e as Error).message}`);
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ---- viewTx tool ----
  server.tool(
    "viewTx",
    "View transaction status and details",
    {
      txHash: z.string().describe("Transaction hash to look up"),
    },
    async ({ txHash }) => {
      try {
        const receipt = await publicClient.getTransactionReceipt({
          hash: txHash as `0x${string}`,
        });

        const tx = await publicClient.getTransaction({
          hash: txHash as `0x${string}`,
        });

        const text = [
          `Transaction: ${txHash}`,
          `Status:      ${receipt.status}`,
          `Block:       ${receipt.blockNumber}`,
          `Gas used:    ${receipt.gasUsed}`,
          `Gas price:   ${formatUnits(receipt.effectiveGasPrice, 9)} gwei`,
          `From:        ${tx.from}`,
          `To:          ${tx.to}`,
          `Value:       ${formatEther(tx.value)} ETH`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (e) {
        // Transaction might be pending
        try {
          const tx = await publicClient.getTransaction({
            hash: txHash as `0x${string}`,
          });
          const text = [
            `Transaction: ${txHash}`,
            `Status:      pending`,
            `From:        ${tx.from}`,
            `To:          ${tx.to}`,
            `Value:       ${formatEther(tx.value)} ETH`,
          ].join("\n");
          return { content: [{ type: "text", text }] };
        } catch (e2) {
          return {
            content: [{ type: "text", text: `Error: transaction not found - ${(e2 as Error).message}` }],
            isError: true,
          };
        }
      }
    },
  );

  // ---- price tool ----
  server.tool(
    "price",
    "Current price and historical trend",
    {
      period: z
        .enum(["1d", "1w", "1m", "1y"])
        .optional()
        .describe("Historical period (default: 1d)"),
    },
    async ({ period }) => {
      try {
        const baseTokenAddr = config.isBaseNative
          ? config.chainConfig.weth
          : config.baseToken;
        const bSym = await getBaseSymbol();

        const [currentPrice, history] = await Promise.all([
          getCurrentPrice(baseTokenAddr, logger),
          getPriceHistory(baseTokenAddr, period ?? "1d", logger),
        ]);

        const text = [
          `${bSym} Price`,
          `Current: ${currentPrice != null ? `$${currentPrice.toFixed(2)}` : "N/A"}`,
          ``,
          history,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (e) {
        logger.error(`price error: ${(e as Error).message}`);
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
