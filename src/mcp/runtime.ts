// Shared runtime helpers for MCP tools. Lifts the per-tool boilerplate (json wrap,
// audit-and-error wrap, context cache) out of server.ts so the individual tool
// definitions can stay focused on their schema + body. Future iterations split each
// tool group into its own module and `register(server, runtime)` to wire it up.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveProfile, loadConfig, type Config } from "../config.js";
import { loadWallet, type WalletContext } from "../wallet.js";
import { activeWalletLabel } from "../wallet.js";
import { ToolError, toToolError } from "../errors.js";
import { sanitizeForLogLine, type Logger } from "../logger.js";

export interface ServerOptions {
  walletPass: string;
  logger: Logger;
  /** Caller name written into audit_log (e.g. "mcp"). */
  caller: string;
}

interface ContextCache {
  [cacheKey: string]: Promise<WalletContext>;
}

/** Wrap a JSON-serializable payload as an MCP text content response. */
export function ok(payload: unknown): { content: { type: "text"; text: string }[] } {
  // Iter889: idempotent envelope discipline. Some MCP tools return raw shapes
  // (ApproveResult, TradeResult-without-ok, etc.); others already envelope
  // their payload (`return { ok: true, ...report }`). Pre-iter889 the helper
  // passed through unchanged, so agent contracts reading `.ok` worked for
  // some tools and not others. Now: if the payload is a plain object and
  // doesn't already carry an `ok` field, prepend `ok: true`. Idempotent on
  // already-enveloped payloads (the existing ok:true|false stays). Bigints,
  // strings, arrays, null are passed through unchanged.
  //
  // Iter905: only auto-envelope PLAIN objects (Object.prototype / null
  // prototype). Class instances (Date, Map, Error, custom classes) have no
  // enumerable own properties, so `{ ok: true, ...instance }` would silently
  // drop the payload. Currently no MCP tool returns class instances, but the
  // hardening makes the helper safe against future tools that might.
  let enveloped = payload;
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    !("ok" in (payload as Record<string, unknown>))
  ) {
    const proto = Object.getPrototypeOf(payload);
    if (proto === Object.prototype || proto === null) {
      enveloped = { ok: true, ...(payload as Record<string, unknown>) };
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(enveloped, jsonReplacer, 2) }] };
}

/** Wrap a ToolError as an MCP error response (isError:true). */
export function fail(err: ToolError): { content: { type: "text"; text: string }[]; isError: true } {
  return {
    content: [{ type: "text", text: JSON.stringify(err.toJSON(), jsonReplacer, 2) }],
    isError: true,
  };
}

/** JSON.stringify replacer that handles BigInt. */
function jsonReplacer(_: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function extractTxHash(x: unknown): string | null {
  if (x && typeof x === "object" && "txHash" in x) {
    const v = (x as Record<string, unknown>).txHash;
    return typeof v === "string" ? v : null;
  }
  return null;
}

/**
 * Audit-and-error-wrap a tool implementation. Every MCP tool body should be invoked via
 * runTool so failures are persisted to audit_log with the right error code and successful
 * runs include the returned txHash (when applicable).
 *
 * recordAudit is best-effort: a DB failure must not turn a successful tool call into a
 * failure (the user's real work would be discarded) and must not mask an existing
 * ToolError with an audit-write error (which would lose the actionable error code the
 * agent branches on). On failure we log to the error stream and continue.
 */
export async function runTool<T>(
  toolName: string,
  options: ServerOptions,
  params: Record<string, unknown>,
  chain: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const start = new Date().toISOString();
  // Audit attribution: prefer the per-call `account` override (if the tool accepted one
  // and the caller used it) over the globally-active account. Otherwise tools like
  // `buy { account: "trading-bot" }` get logged against `keystore`, defeating audit's
  // purpose for agents juggling multiple accounts.
  const explicitAccount = typeof params.account === "string" ? params.account : undefined;
  // Iter501: same iter500 fix as index.ts — route through activeWalletLabel so the
  // audit row matches what loadWallet would set as wallet.label (gated on
  // mnemonic.json). Pre-iter501 the orphaned-accounts.json case had MCP audit
  // disagree with the trade DB row.
  const active = explicitAccount ?? activeWalletLabel();
  // Redact sensitive fields before serializing. No existing MCP tool accepts a
  // password/mnemonic (the server has WALLET_PASS via env), but a future tool that
  // does will inherit the protection without having to remember to opt in.
  const { capAuditParams, redactSensitiveFields } = await import("../db.js");
  const paramsJson = capAuditParams(JSON.stringify(redactSensitiveFields(params), jsonReplacer));
  const safeAudit = (row: Parameters<Logger["recordAudit"]>[0]) => {
    try {
      options.logger.recordAudit(row);
    } catch (e) {
      // Iter479: sanitize before logging — sqlite error messages are usually one-line
      // but defense-in-depth via iter474 helper.
      options.logger.error(sanitizeForLogLine(
        `audit write failed for tool=${toolName} result=${row.result}: ${(e as Error).message}`,
      ));
    }
  };
  // Iter397: dot-concat the action sub-field if present so the audit row matches the
  // CLI iter342 vocabulary ("config.set" / "trade.buy" / "audit.prune"). Pre-iter397
  // MCP rows had tool="config" while CLI rows had tool="config.set" — an operator
  // querying `audit --tool config.set` got CLI rows only, missing the agent's MCP
  // calls. Both ".action" (for config / audit / accounts / allowances) and ".direction"
  // (for trade buy/sell) are sub-action discriminators. Skip if the value isn't a
  // string (defensive; zod enforces this but params is typed as unknown here).
  const subAction = (typeof params.action === "string" && params.action)
    || (typeof params.direction === "string" && params.direction)
    || null;
  const auditTool = subAction ? `${toolName}.${subAction}` : toolName;
  try {
    const result = await fn();
    safeAudit({
      timestamp: start,
      caller: options.caller,
      tool: auditTool,
      account: active,
      chain: chain ?? null,
      params_json: paramsJson,
      simulation_json: null,
      result: "ok",
      error_code: null,
      error_message: null,
      tx_hash: extractTxHash(result),
    });
    return result;
  } catch (e) {
    const te = toToolError(e);
    safeAudit({
      timestamp: start,
      caller: options.caller,
      tool: auditTool,
      account: active,
      chain: chain ?? null,
      params_json: paramsJson,
      simulation_json: null,
      result: "err",
      error_code: te.code,
      error_message: te.message,
      tx_hash: null,
    });
    throw te;
  }
}

/** Shared runtime passed to each tool-group register function. Encapsulates the wallet
 *  context cache + config accessor so tool bodies don't have to reach into mutable state. */
export interface McpRuntime {
  opts: ServerOptions;
  /** Loads (and caches) a WalletContext for `(chain, account)`. */
  getContext(
    chainName: string | undefined,
    accountLabel?: string,
  ): Promise<WalletContext & { chain: string }>;
  /** Fresh config snapshot — every tool call re-reads from disk so MCP picks up CLI edits. */
  getConfig(): Config;
  /** Drop all cached WalletContexts. Used by the `accounts use` tool after a switch. */
  invalidateContextCache(): void;
}

/**
 * Build the runtime closure used by every tool. The cache lives here so a server
 * restart wipes it; per-(chain, account) it's WalletContext-per-pair.
 */
export function makeRuntime(opts: ServerOptions): McpRuntime {
  const contextCache: ContextCache = {};
  return {
    opts,
    getConfig: () => loadConfig(),
    invalidateContextCache() {
      for (const k of Object.keys(contextCache)) delete contextCache[k];
    },
    async getContext(chainName, accountLabel) {
      const config = loadConfig();
      const chain = (chainName ?? config.activeChain).toLowerCase();
      const cacheKey = accountLabel ? `${chain}:${accountLabel}` : chain;
      if (!contextCache[cacheKey]) {
        const profile = resolveProfile(chain, config);
        const extraRpcs = config.chains[chain]?.rpcs ?? [];
        contextCache[cacheKey] = loadWallet(opts.walletPass, profile, extraRpcs, opts.logger, accountLabel);
      }
      const wallet = await contextCache[cacheKey];
      return { ...wallet, chain };
    },
  };
}

/** Each tool-group module exports a register function with this signature. */
export type RegisterFn = (server: McpServer, runtime: McpRuntime) => void;
