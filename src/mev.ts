// MEV-protected transaction submission via private-relay RPCs.
//
// On Ethereum mainnet (and to varying degrees on other public-mempool
// chains) any trade submitted through a standard JSON-RPC endpoint is
// visible to MEV bots before inclusion. The bots sandwich it: a front-run
// + back-run pair that extracts the operator's slippage tolerance as
// arbitrage profit. Typical cost: 0.5-3% per trade, sometimes much more
// on illiquid pairs.
//
// The standard mitigation is to submit the signed transaction through a
// PRIVATE relay endpoint (Flashbots Protect, MEV Blocker, Merkle Private
// RPC, etc.) which forwards the tx directly to block builders without
// exposing it to the public mempool. Every supported relay speaks the
// same `eth_sendRawTransaction` JSON-RPC method viem already uses, so
// the integration is purely a transport swap.
//
// This module is pure-logic: it decides which transport to build based
// on config + chain, exports the helper, and doesn't touch viem at the
// caller end. The wallet module wires the transport into its
// walletClient (writes only — publicClient stays on the public-RPC
// fallback chain).
//
// Read/write split: most private relays buffer the tx privately for some
// blocks before propagation, so eth_getTransactionByHash on a freshly-
// submitted private-mempool tx returns "not found" until inclusion.
// Reading through the private RPC would hang waiting for receipts;
// instead, reads route through the existing publicClient (public RPCs
// with fallback), writes route through the new private-aware transport.
// loadWallet builds two clients, both using profile+chain but with
// different transports.

import { fallback, http, type Transport } from "viem";
import type { ChainProfile } from "./chains.js";
import type { MevConfig } from "./config.js";

// ── pure config resolution ───────────────────────────────────

export interface ResolvedMevSubmit {
  /** True when this chain has an active MEV-protected submission path. */
  active: boolean;
  /** The private-relay URL to submit through. Undefined when active=false. */
  privateUrl?: string;
  /** Operator-facing label for the relay (defaults to "private relay" when
   *  no explicit label was configured). */
  label?: string;
  /** Whether viem's fallback transport should drop down to public RPCs if
   *  the private relay errors. When true, the transport is fallback(
   *  [private, ...public]). When false, it's a single-leg http() that
   *  hard-fails on private outage — the safer default for MEV protection. */
  fallbackToPublic: boolean;
}

/**
 * Decide whether a chain has an active MEV submission path. Pure: takes
 * the resolved mev config + chain name, returns a struct describing the
 * outcome. Caller (wallet.ts) consumes this to build the actual transport.
 */
export function resolveMevSubmit(mev: MevConfig | undefined, chainName: string): ResolvedMevSubmit {
  if (!mev || !mev.enabled) return { active: false, fallbackToPublic: false };
  const key = chainName.toLowerCase();
  const privateUrl = mev.privateRpcs?.[key];
  if (!privateUrl) return { active: false, fallbackToPublic: false };
  const label = mev.labels?.[key] ?? "private relay";
  return {
    active: true,
    privateUrl,
    label,
    fallbackToPublic: mev.fallbackToPublic ?? false,
  };
}

// ── transport construction ───────────────────────────────────

/**
 * Build the transport that the wallet's WRITE-side client (`walletClient`)
 * uses. Three modes:
 *
 *   1. MEV inactive (default for most chains): same transport as the public
 *      multi-RPC fallback used for reads — operationally identical to
 *      pre-MEV behavior.
 *
 *   2. MEV active, fallbackToPublic=false (strict, recommended): a
 *      single-leg http() to the private relay. If the relay errors, the
 *      trade hard-fails rather than leak to the public mempool. Operators
 *      who set MEV up generally chose this risk profile deliberately.
 *
 *   3. MEV active, fallbackToPublic=true (graceful-degrade): a fallback
 *      transport with [private, ...public]. If the private leg errors,
 *      viem fails over to the public chain. Tx still lands; MEV protection
 *      may not. Operators who care more about "must land" than "must not
 *      leak" flip this.
 *
 * `extraRpcs` is the user-config rpc list (config.chains.<chain>.rpcs);
 * `publicTransport` is the already-built public fallback (we wrap it
 * rather than rebuild — keeps timeout / retry tuning in one place).
 *
 * Pure helper — takes the publicTransport as a function-shaped argument
 * so we don't have to import chains.makeTransport here (avoids the
 * circular dependency since chains.ts has no awareness of mev.ts).
 */
export function buildSubmitTransport(args: {
  profile: ChainProfile;
  mev: MevConfig | undefined;
  publicTransport: Transport;
  /** Optional extraRpcs already factored into publicTransport — only
   *  surfaced here for completeness in the fallback case (re-wrapping
   *  would duplicate them, so we just chain publicTransport). */
}): Transport {
  const resolved = resolveMevSubmit(args.mev, args.profile.name);
  if (!resolved.active || !resolved.privateUrl) {
    // No MEV configured for this chain — pass through.
    return args.publicTransport;
  }
  // Build the private leg. Same timeout / retry tuning as the public
  // multi-RPC fallback (8s timeout, 0 inner retries — the fallback
  // dispatcher is the retry mechanism). retryCount=1 on the outer
  // fallback gives one whole-pool retry on a transient sub-second flake.
  const privateLeg = http(resolved.privateUrl, { retryCount: 0, timeout: 8_000 });
  if (!resolved.fallbackToPublic) {
    // Strict mode: private-only. Wrap in fallback([private]) instead of
    // the bare http leg so the retryCount=1 outer-pool retry still
    // applies — a transient single-second 503 from the relay shouldn't
    // kill the trade.
    return fallback([privateLeg], { rank: false, retryCount: 1 });
  }
  // Graceful-degrade: private first, then the existing public chain.
  return fallback([privateLeg, args.publicTransport], { rank: false, retryCount: 1 });
}

// ── url redaction ────────────────────────────────────────────

/**
 * Host-only fingerprint for a private-RPC URL. Private relays often
 * embed bearer tokens in the path (Merkle: /<api-key>, MEV-Share:
 * /<session>); this preserves enough signal for an operator to verify
 * routing (host name) without exposing the secret half.
 *
 * Delegates to redactWebhookUrl semantics — same redaction class.
 * Exported in case future surfaces want their own private-URL display
 * (web UI config viewer, MCP doctor tool output).
 */
export function redactPrivateRpcUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/[REDACTED]`;
  } catch {
    return "[REDACTED]";
  }
}

// ── doctor probe ─────────────────────────────────────────────

/**
 * Fire a lightweight reachability probe at a private-RPC URL. Used by
 * `tradekit doctor` to verify the relay is reachable + responding.
 *
 * Uses `eth_chainId` — universally implemented, cheap, and a real
 * response (vs HEAD which many relays reject). Failure modes:
 *   - HTTP non-200 → not reachable
 *   - 200 but body missing `result` → reachable but mis-configured
 *   - chainId doesn't match the profile → wrong-chain relay (operator
 *     pasted an Ethereum URL into config.mev.privateRpcs.base or similar)
 *
 * Returns a structured probe result that doctor's renderer turns into
 * the existing OK / WARN / FAIL row format.
 */
export interface MevProbeResult {
  reachable: boolean;
  observedChainId: number | null;
  elapsedMs: number;
  error?: string;
}

export async function probeMevRpc(url: string, expectedChainId: number, timeoutMs = 5_000): Promise<MevProbeResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = Date.now() - start;
    if (!res.ok) {
      return { reachable: false, observedChainId: null, elapsedMs, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (body.error) {
      return { reachable: false, observedChainId: null, elapsedMs, error: body.error.message ?? "RPC error" };
    }
    if (typeof body.result !== "string") {
      return { reachable: false, observedChainId: null, elapsedMs, error: "missing result field" };
    }
    const observedChainId = parseInt(body.result, 16);
    if (!Number.isFinite(observedChainId)) {
      return { reachable: false, observedChainId: null, elapsedMs, error: `invalid chainId "${body.result}"` };
    }
    if (observedChainId !== expectedChainId) {
      return {
        reachable: false,
        observedChainId,
        elapsedMs,
        error: `chain mismatch — relay reports chainId=${observedChainId}, profile expects ${expectedChainId}`,
      };
    }
    return { reachable: true, observedChainId, elapsedMs };
  } catch (e) {
    const elapsedMs = Date.now() - start;
    if (e instanceof DOMException && e.name === "TimeoutError") {
      return { reachable: false, observedChainId: null, elapsedMs, error: `timeout after ${timeoutMs}ms` };
    }
    return { reachable: false, observedChainId: null, elapsedMs, error: (e as Error).message ?? String(e) };
  }
}
