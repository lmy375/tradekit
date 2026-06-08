// Top-level server commands: MCP (stdio) and web (Express + React bundle).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger, type Logger } from "../logger.js";
import { loadConfig, resolveProfile } from "../config.js";
import { loadWallet } from "../wallet.js";
import { anyWalletExists } from "../accounts.js";
import { createMcpServer } from "../server.js";
import { startWebServer } from "../web.js";
import { toToolError, ToolError } from "../errors.js";
import { tradekitVersion } from "../version.js";
import { parseIntFlag } from "./helpers.js";

/**
 * Shared server startup: validate the wallet password against the keystore (fail-fast
 * so operators see [WRONG_PASSWORD] up front, not on the first user trade), then
 * fire-and-forget a reconcile of any pending trades from the previous session.
 * Returns false if no wallet is configured (caller proceeds with a warning).
 */
async function validateWalletAndReconcile(
  walletPass: string,
  logger: Logger,
  modeLabel: string,
): Promise<void> {
  if (!anyWalletExists()) {
    logger.warn(
      `No wallet configured — ${modeLabel} tools that need a signer will fail until one is created.`,
    );
    return;
  }
  try {
    const config = loadConfig();
    const profile = resolveProfile(config.activeChain, config);
    const extraRpcs = config.chains[config.activeChain]?.rpcs ?? [];
    const wallet = await loadWallet(walletPass, profile, extraRpcs, logger);
    // Iter391: surface the wallet address + active chain on server startup. Operators
    // launching MCP via Claude Desktop / a launcher / a CI job can verify they're
    // pointed at the RIGHT wallet without having to invoke a tool to check. Address
    // is public-derived (not key material) so logging it is safe — same level as the
    // iter175 banner the web server already prints with the URL.
    logger.info(`Wallet password validated  (${wallet.account.address} on ${config.activeChain})`);
    // Detached: pending trades from a previous session get reconciled in the background
    // so they don't sit forever consuming daily-budget headroom.
    const { runStartupReconcile } = await import("../reconcile.js");
    runStartupReconcile(config, logger);
  } catch (e) {
    const te = toToolError(e);
    console.error(`${modeLabel} startup failed: [${te.code}] ${te.message}`);
    process.exit(1);
  }
}

export async function mcpCommand(flags: Record<string, string>) {
  const walletPass = flags["pass"] ?? process.env.WALLET_PASS;
  if (!walletPass)
    throw new ToolError("INVALID_PARAMS", "MCP mode requires --pass or WALLET_PASS (stdin is reserved for MCP protocol).");

  // MCP uses stderr for diagnostic output (stdin/stdout are JSON-RPC); show INFO+.
  const logger = createLogger({ stderrLevel: "info" });
  // Iter396: include the tradekit version in the startup banner. Operators launching
  // MCP via Claude Desktop or a launcher with stderr captured can verify which version
  // is loaded without invoking a separate tool. Matches iter391's address-in-startup
  // discipline and iter393/395's version-in-response-envelope work.
  // Iter434: import was dynamic; hoisted to top-level static (same iter433 cleanup).
  logger.info(`Starting tradekit MCP server  (tradekit ${tradekitVersion()}, node ${process.versions.node})`);

  await validateWalletAndReconcile(walletPass, logger, "MCP");

  const server = createMcpServer({ walletPass, logger, caller: "mcp" });
  const transport = new StdioServerTransport();

  // Graceful shutdown — close DB + log stream cleanly so WAL is checkpointed.
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down MCP server`);
    try {
      const { closeDb } = await import("../db.js");
      closeDb();
    } catch {
      /* ignore */
    }
    logger.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await server.connect(transport);
  logger.info("MCP server connected via stdio");
}

export async function webCommand(flags: Record<string, string>) {
  // Ports: 1-65535. Below 1024 needs root on most Unixes; allow it (operator's choice).
  const port = parseIntFlag(flags["port"], "--port", { min: 1, max: 65535 }) ?? 3030;
  const host = flags["host"] ?? "127.0.0.1";
  const walletPass = flags["pass"] ?? process.env.WALLET_PASS;
  if (!walletPass) throw new ToolError("INVALID_PARAMS", "Web mode requires --pass or WALLET_PASS.");
  const logger = createLogger({ stderrLevel: "info" });
  // Iter396: same version-in-startup-banner as the MCP path. Operators reviewing
  // server.log post-incident can see at a glance which version produced the run.
  // Iter434: import was dynamic; hoisted to top-level static (same iter433 cleanup).
  logger.info(`Starting tradekit web server  (tradekit ${tradekitVersion()}, node ${process.versions.node})`);
  // Binding to 0.0.0.0 / public IPs exposes the wallet-trading API to the network.
  // Token auth + same-session token cap the blast radius, but operators routinely
  // typo themselves into this by running `tradekit web --host 0.0.0.0` for local
  // dev convenience and forgetting they did so. One loud warning at startup catches
  // the obvious foot-shoot.
  if (host === "0.0.0.0" || host === "::") {
    logger.warn(
      `Binding to ${host} exposes the trading API to your network. Anyone with the per-session token (printed below) can trade as this wallet. Use 127.0.0.1 for local-only access, or front this with a reverse-proxy + TLS for remote use.`,
    );
  }
  // Validate the keystore can decrypt BEFORE binding the listener — otherwise an
  // operator with a typo'd WALLET_PASS only learns about it when the first /api/trade
  // arrives. Also kicks off the auto-reconcile.
  await validateWalletAndReconcile(walletPass, logger, "Web");
  await startWebServer({ host, port, walletPass, logger });
}
