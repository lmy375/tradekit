// MCP server entry point. All tool definitions live in src/mcp/*-tools.ts modules; this
// file does only the wiring. Each tool group is a `register(server, runtime)` function
// that takes the server + shared runtime (which encapsulates the wallet context cache,
// config accessor, and the audit/error-wrap helper).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeRuntime, type ServerOptions } from "./mcp/runtime.js";
import { registerAdminTools } from "./mcp/admin-tools.js";
import { registerDataTools } from "./mcp/data-tools.js";
import { registerTradeTools } from "./mcp/trade-tools.js";
import { registerSecurityTools } from "./mcp/security-tools.js";
import { registerStrategyTools } from "./mcp/strategy-tools.js";
import { registerObservabilityTools } from "./mcp/observability-tools.js";
import { tradekitVersion } from "./version.js";

export type { ServerOptions };

export function createMcpServer(opts: ServerOptions): McpServer {
  // Iter416: was hard-coded "2.0.0" — every package.json bump would silently drift.
  // tradekitVersion() (iter393) reads package.json so the MCP handshake matches CLI
  // --version / doctor / web /api/status / help banner / startup logs.
  const server = new McpServer({ name: "tradekit", version: tradekitVersion() });
  const runtime = makeRuntime(opts);

  // Order is informational — tool listing follows registration order. Group by concern
  // so an agent calling `tools/list` sees related tools clustered.
  registerAdminTools(server, runtime); // status, accounts, audit, reconcile, recent_trades, config, doctor, speedup_tx, cancel_tx, sync_trades, address, verify, diagnose_pending, analyze_trade
  registerDataTools(server, runtime); // chains, gas, price, holdings, portfolio, portfolio_snapshot, portfolio_history, portfolio_diff, health, token_info, aggregator_stats, pair_stats, slippage_suggest, strategies_list, trending, pnl, viewTx, check_price
  registerTradeTools(server, runtime); // quote, buy, sell, import_trade, transfer, preview_trade, preflight_trade, sweep_balances
  registerSecurityTools(server, runtime); // allowances, audit_allowances, approve, revoke, revoke_all, check_token, safety_drawdown, safety_reset_drawdown
  // Iter26: strategy lifecycle (playbooks + backtests) + observability (status, digest, replay).
  // Completes the gap between iter17-25 CLI features and the MCP surface.
  registerStrategyTools(server, runtime); // playbook_validate, playbook_deploy, playbook_list, playbook_show, playbook_destroy, backtest_order, backtest_playbook, backtest_compare
  registerObservabilityTools(server, runtime); // status_dashboard, digest_summary, order_replay, backtest_list, backtest_show, backtest_compare_list, backtest_compare_show

  return server;
}
