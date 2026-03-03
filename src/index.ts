#!/usr/bin/env node

import { existsSync } from "fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { formatUnits, formatEther, parseUnits, type Address } from "viem";
import { loadUserConfig, resolveChainConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { WALLET_PATH, ERC20_ABI } from "./constants.js";
import {
  createWallet,
  importWallet,
  exportWallet,
  loadWallet,
  getWalletAddress,
} from "./wallet.js";
import { createMcpServer } from "./server.js";
import { sellBase, sellBaseForQuoteAmount, buyBase, buyBaseWithQuoteAmount } from "./swap.js";
import { prompt, promptPassword } from "./cli.js";
import type { ServerConfig } from "./types.js";

// ── arg parsing ──────────────────────────────────────────────

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// ── helpers ──────────────────────────────────────────────────

function buildServerConfig(flags: Record<string, string>, walletPass: string): ServerConfig {
  const chainName = flags["chain"] ?? "base";
  const userConfig = loadUserConfig();
  const chainConfig = resolveChainConfig(chainName, userConfig);
  const userChainOverride = userConfig.chains?.[chainName];

  const rpcUrl = flags["rpc"] ?? userChainOverride?.rpc ?? chainConfig.rpc;
  const routerAddress = (flags["router"] ?? userChainOverride?.swapRouter02 ?? chainConfig.swapRouter02) as Address;
  const quoterAddress = chainConfig.quoterV2;

  const baseArg = flags["base"] ?? userChainOverride?.base ?? "ETH";
  const isBaseNative = baseArg.toUpperCase() === "ETH";
  const baseToken: Address = isBaseNative
    ? chainConfig.weth
    : (baseArg as Address);

  const quoteToken: Address = (flags["quote"] ?? userChainOverride?.quote ?? chainConfig.usdc) as Address;

  return {
    chainName,
    chainConfig,
    rpcUrl,
    baseToken,
    quoteToken,
    isBaseNative,
    walletPass,
    routerAddress,
    quoterAddress,
  };
}

async function requirePassword(flags: Record<string, string>): Promise<string> {
  if (flags["pass"]) return flags["pass"];
  const envPass = process.env.WALLET_PASS;
  if (envPass) return envPass;
  return promptPassword("Enter wallet password: ");
}

// ── wallet commands ──────────────────────────────────────────

async function walletCreate(flags: Record<string, string>) {
  if (existsSync(WALLET_PATH)) {
    const answer = await prompt("Wallet already exists. Overwrite? (yes/no): ");
    if (answer.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }
  const nonInteractive = flags["pass"] || process.env.WALLET_PASS;
  let pass: string;
  if (nonInteractive) {
    pass = await requirePassword(flags);
  } else {
    pass = await promptPassword("Enter password: ");
    const pass2 = await promptPassword("Confirm password: ");
    if (pass !== pass2) {
      console.error("Passwords do not match.");
      process.exit(1);
    }
  }
  const logger = createLogger();
  try {
    const address = await createWallet(pass, logger);
    console.log(`Wallet created: ${address}`);
  } finally {
    logger.close();
  }
}

async function walletImport(flags: Record<string, string>) {
  if (existsSync(WALLET_PATH)) {
    const answer = await prompt("Wallet already exists. Overwrite? (yes/no): ");
    if (answer.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }
  const privateKey = await prompt("Enter private key: ");
  const nonInteractive = flags["pass"] || process.env.WALLET_PASS;
  let pass: string;
  if (nonInteractive) {
    pass = await requirePassword(flags);
  } else {
    pass = await promptPassword("Enter password: ");
    const pass2 = await promptPassword("Confirm password: ");
    if (pass !== pass2) {
      console.error("Passwords do not match.");
      process.exit(1);
    }
  }
  const logger = createLogger();
  try {
    const address = await importWallet(privateKey, pass, logger);
    console.log(`Wallet imported: ${address}`);
  } finally {
    logger.close();
  }
}

async function walletExport(flags: Record<string, string>) {
  const pass = await requirePassword(flags);
  const logger = createLogger();
  try {
    const pk = await exportWallet(pass, logger);
    console.log(pk);
  } finally {
    logger.close();
  }
}

async function walletView(flags: Record<string, string>) {
  const address = getWalletAddress();
  if (!address) {
    console.error("No wallet found. Run 'wallet create' or 'wallet import' first.");
    process.exit(1);
  }

  console.log(`Address: ${address}`);

  // If --chain is provided, show balances
  const chainName = flags["chain"] ?? "base";
  const userConfig = loadUserConfig();
  const chainConfig = resolveChainConfig(chainName, userConfig);
  const userChainOverride = userConfig.chains?.[chainName];
  const rpcUrl = flags["rpc"] ?? userChainOverride?.rpc ?? chainConfig.rpc;

  const { createPublicClient, http } = await import("viem");
  const publicClient = createPublicClient({
    chain: chainConfig.viemChain,
    transport: http(rpcUrl),
  });

  const ethBalance = await publicClient.getBalance({ address });
  console.log(`Chain:   ${chainName}`);
  console.log(`ETH:     ${formatEther(ethBalance)}`);

  // Base token balance
  const baseArg = flags["base"] ?? userChainOverride?.base ?? "ETH";
  const isBaseNative = baseArg.toUpperCase() === "ETH";
  if (!isBaseNative) {
    const baseToken = baseArg as Address;
    const [baseBal, baseSym, baseDec] = await Promise.all([
      publicClient.readContract({ address: baseToken, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
      publicClient.readContract({ address: baseToken, abi: ERC20_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: baseToken, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    console.log(`${baseSym}:  ${formatUnits(baseBal as bigint, baseDec as number)}`);
  }

  // Quote token balance
  const quoteToken = (flags["quote"] ?? userChainOverride?.quote ?? chainConfig.usdc) as Address;
  const [quoteBal, quoteSym, quoteDec] = await Promise.all([
    publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
    publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: "symbol" }),
    publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: "decimals" }),
  ]);
  console.log(`${quoteSym}:  ${formatUnits(quoteBal as bigint, quoteDec as number)}`);
}

// ── trade commands ───────────────────────────────────────────

async function tradeCommand(direction: "buy" | "sell", flags: Record<string, string>) {
  const walletPass = await requirePassword(flags);

  const config = buildServerConfig(flags, walletPass);
  const logger = createLogger();

  try {
    const wallet = await loadWallet(walletPass, config.chainConfig, config.rpcUrl, logger);
    const { publicClient, walletClient } = wallet;

    const baseDecimals = config.isBaseNative
      ? 18
      : await publicClient.readContract({ address: config.baseToken, abi: ERC20_ABI, functionName: "decimals" });
    const quoteDecimals = await publicClient.readContract({ address: config.quoteToken, abi: ERC20_ABI, functionName: "decimals" });

    const swapCtx = { publicClient, walletClient, config, logger };
    const slippageBps = flags["slippage"] ? parseInt(flags["slippage"], 10) : undefined;

    let result;

    if (direction === "buy") {
      if (flags["baseAmount"]) {
        const amount = parseUnits(flags["baseAmount"], baseDecimals);
        result = await buyBase(swapCtx, amount, baseDecimals, quoteDecimals, slippageBps);
      } else if (flags["quoteAmount"]) {
        const amount = parseUnits(flags["quoteAmount"], quoteDecimals);
        result = await buyBaseWithQuoteAmount(swapCtx, amount, baseDecimals, quoteDecimals, slippageBps);
      } else {
        console.error("Specify --baseAmount or --quoteAmount");
        process.exit(1);
      }
    } else {
      if (flags["baseAmount"]) {
        const amount = parseUnits(flags["baseAmount"], baseDecimals);
        result = await sellBase(swapCtx, amount, baseDecimals, quoteDecimals, slippageBps);
      } else if (flags["quoteAmount"]) {
        const amount = parseUnits(flags["quoteAmount"], quoteDecimals);
        result = await sellBaseForQuoteAmount(swapCtx, amount, baseDecimals, quoteDecimals, slippageBps);
      } else {
        console.error("Specify --baseAmount or --quoteAmount");
        process.exit(1);
      }
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

    console.log(`${direction.toUpperCase()} ${result.status.toUpperCase()}`);
    console.log(`  Base:     ${direction === "buy" ? "+" : "-"}${result.baseAmount}`);
    console.log(`  Quote:    ${direction === "buy" ? "-" : "+"}${result.quoteAmount}`);
    console.log(`  Price:    ${result.price}`);
    console.log(`  Fee tier: ${result.feeTier / 10000}%`);
    console.log(`  Gas:      ${result.gasUsed}`);
    console.log(`  Tx:       ${result.txHash}`);
  } finally {
    logger.close();
  }
}

// ── mcp command ──────────────────────────────────────────────

async function mcpCommand(flags: Record<string, string>) {
  const walletPass = flags["pass"] ?? process.env.WALLET_PASS;
  if (!walletPass) {
    console.error("MCP mode requires --pass or WALLET_PASS (stdin is reserved for MCP protocol).");
    process.exit(1);
  }

  const config = buildServerConfig(flags, walletPass);
  const logger = createLogger();

  logger.info("Starting tradekit MCP server");
  logger.info(`Chain: ${config.chainName} (${config.chainConfig.chainId})`);
  logger.info(`RPC: ${config.rpcUrl}`);
  logger.info(`Base: ${config.isBaseNative ? "ETH (native)" : config.baseToken}`);
  logger.info(`Quote: ${config.quoteToken}`);
  logger.info(`Router: ${config.routerAddress}`);

  const wallet = await loadWallet(walletPass, config.chainConfig, config.rpcUrl, logger);
  const mcpServer = createMcpServer({ config, wallet, logger });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  logger.info("MCP server connected via stdio");
}

// ── usage ────────────────────────────────────────────────────

function printUsage() {
  console.log(`Usage: tradekit <command> [action] [options]

Commands:
  wallet create              Create a new wallet
  wallet import              Import wallet from private key
  wallet export              Export private key
  wallet view                View address and balances

  trade buy                  Buy base token
  trade sell                 Sell base token
    --chain <name>           Chain name (default: base)
    --base <token>           Base token address or ETH (default: ETH)
    --quote <token>          Quote token address (default: USDC)
    --baseAmount <amount>    Exact base amount
    --quoteAmount <amount>   Exact quote amount
    --slippage <bps>         Slippage in basis points (default: 50)

  mcp                        Start MCP server
    --chain <name>           Chain name (default: base)
    --rpc <url>              RPC endpoint
    --router <address>       SwapRouter02 address
    --base <token>           Base token
    --quote <token>          Quote token

Options:
  --pass <password>          Wallet password

Environment:
  WALLET_PASS                Wallet password (fallback for --pass)`);
}

// ── main ─────────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const action = positional[1];

  try {
    switch (command) {
      case "wallet":
        switch (action) {
          case "create":
            await walletCreate(flags);
            break;
          case "import":
            await walletImport(flags);
            break;
          case "export":
            await walletExport(flags);
            break;
          case "view":
            await walletView(flags);
            break;
          default:
            console.error(`Unknown wallet action: ${action ?? "(none)"}`);
            printUsage();
            process.exit(1);
        }
        break;

      case "trade":
        switch (action) {
          case "buy":
            await tradeCommand("buy", flags);
            break;
          case "sell":
            await tradeCommand("sell", flags);
            break;
          default:
            console.error(`Unknown trade action: ${action ?? "(none)"}`);
            printUsage();
            process.exit(1);
        }
        break;

      case "mcp":
        await mcpCommand(flags);
        break;

      default:
        printUsage();
        if (command) {
          console.error(`\nUnknown command: ${command}`);
          process.exit(1);
        }
        break;
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
