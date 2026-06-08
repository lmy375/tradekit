// Pre-trade automatic token-safety check.
//
// Hooks into the trade flow BEFORE the aggregator HTTP roundtrip. For
// every trade whose input or output token isn't already trusted (chain
// native, chain's canonical USDC/WETH/WBTC, or operator's safety
// whitelist), simulate a buy+sell roundtrip via the existing
// `tokenSafety.checkTokenSafety` probe and block the trade if the
// verdict is `honeypot` (always) or `suspicious` (configurable).
//
// Probe cost (~3-8s, two aggregator quotes + two eth_calls) is real but
// amortized via the v15 token_safety_cache: after the first probe per
// (chain, token), subsequent trades within `cacheTtlMs` (default 24h)
// pay zero overhead.
//
// Smart-skip ordering (cheapest checks first):
//   1. Feature disabled → skip
//   2. Native sentinel (NATIVE / ETH) → skip (always trusted)
//   3. Chain canonical USDC / WETH / WBTC → skip (baseline assets)
//   4. Token in safety.tokenWhitelist[chain] AND skipWhitelisted=true → skip
//   5. Token in safety.tokenBlacklist[chain] → already rejected by enforceSafety
//   6. Cache hit (verdict + not-expired) → use cached verdict
//   7. Cache miss → run probe, write cache, gate on verdict
//
// Verdict → action mapping (see verdictAction):
//   ok          → continue
//   unknown     → log + continue (probe couldn't reach the aggregator;
//                 don't fail-closed on infra outage)
//   suspicious  → block when failOnSuspicious=true (default), else warn
//   honeypot    → always block

import type { Address, PublicClient, Transport, Chain } from "viem";
import { ToolError } from "./errors.js";
import type { Config } from "./config.js";
import type { ChainProfile } from "./chains.js";
import type { Logger } from "./logger.js";
import {
  getCachedTokenVerdict,
  putCachedTokenVerdict,
  type TokenSafetyCacheVerdict,
  type TokenSafetyCacheRow,
} from "./db.js";
import type { TokenSafetyReport } from "./tokenSafety.js";
import { tryNotify } from "./notify.js";

// ── pure helpers ─────────────────────────────────────────────

export type AutoTokenCheckAction = "skip" | "ok" | "warn" | "block";

export interface AutoTokenCheckDecision {
  action: AutoTokenCheckAction;
  verdict?: TokenSafetyCacheVerdict;
  /** True when the verdict came from the v15 cache (not a fresh probe). */
  fromCache: boolean;
  /** Operator-facing message — surfaced in error details / log lines. */
  reason: string;
  /** ISO timestamp the verdict was recorded (for cached results). */
  checkedAt?: string;
  /** Operator-set USD size used by the probe (for replay). */
  probeUsd?: number;
}

/**
 * Pure mapping: verdict + config → action. Centralizes the policy so
 * the trade-flow integration doesn't have to repeat the suspicious-mode
 * branching.
 *
 * Inputs:
 *   verdict — from checkTokenSafety
 *   failOnSuspicious — config; default true
 *
 * Returns: "ok" / "warn" / "block".
 */
export function verdictAction(
  verdict: TokenSafetyCacheVerdict,
  failOnSuspicious: boolean,
): "ok" | "warn" | "block" {
  if (verdict === "ok") return "ok";
  if (verdict === "honeypot") return "block";
  if (verdict === "suspicious") return failOnSuspicious ? "block" : "warn";
  // "unknown" — probe couldn't get a quote (illiquid token, aggregator
  // outage). Fail-open: warn but don't block, so a transient upstream
  // outage doesn't cascade into a tradekit outage. Operators serious
  // about gating on unknowns set tokenWhitelist explicitly.
  return "warn";
}

/**
 * Pure helper: is this token in the baseline-trusted set? The set
 * includes:
 *   - the chain's native sentinel (NATIVE / "ETH" literal)
 *   - the chain's canonical USDC + WETH + WBTC addresses from the
 *     chain profile
 *
 * These are short-circuited from any auto-check because:
 *   1. They're on every chain's well-known token list and are not
 *      honeypots by construction.
 *   2. Probing them would burn cycles on a known-good answer.
 *   3. The honeypot probe USES native + USDC as its routing pairs —
 *      probing USDC itself would be a self-referential cycle.
 */
export function isBaselineTrustedToken(profile: ChainProfile, tokenAddress: string): boolean {
  if (tokenAddress === "NATIVE" || tokenAddress === "ETH" || tokenAddress === "0x0000000000000000000000000000000000000000") {
    return true;
  }
  const lower = tokenAddress.toLowerCase();
  if (profile.usdc && profile.usdc.toLowerCase() === lower) return true;
  if (profile.weth && profile.weth.toLowerCase() === lower) return true;
  // Walk the chain's well-known token list for WBTC (the only other
  // "always-trusted" baseline). Not every chain has it.
  for (const [sym, addr] of Object.entries(profile.tokens ?? {})) {
    if (sym === "WBTC" && addr.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * Pure helper: is this token in the operator-supplied whitelist for
 * this chain? Reads safety.tokenWhitelist[chain] and matches by
 * lowercased address.
 */
export function isOperatorWhitelisted(config: Config, chain: string, tokenAddress: string): boolean {
  const whitelist = config.safety.tokenWhitelist?.[chain.toLowerCase()];
  if (!whitelist || whitelist.length === 0) return false;
  const lower = tokenAddress.toLowerCase();
  return whitelist.some((addr) => addr.toLowerCase() === lower);
}

// ── probe injection seam ─────────────────────────────────────

/** Probe function shape — matches `tokenSafety.checkTokenSafety`. Injected
 *  at the test boundary so tests don't need a live wallet + RPC. */
export type SafetyProbeFn = (args: {
  token: Address;
  probeUsd: number;
  publicClient: PublicClient<Transport, Chain>;
  walletAddress: Address;
  profile: ChainProfile;
  config: Config;
  logger: Logger;
}) => Promise<TokenSafetyReport>;

// ── integration entry ────────────────────────────────────────

export interface CheckTokenAtTradeTimeArgs {
  chain: string;
  profile: ChainProfile;
  tokenAddress: string;
  config: Config;
  logger: Logger;
  publicClient: PublicClient<Transport, Chain>;
  walletAddress: Address;
  /** Test seam — defaults to `tokenSafety.checkTokenSafety` at runtime. */
  probeFn?: SafetyProbeFn;
  /** Test seam — defaults to `Date.now()`. */
  now?: Date;
}

/**
 * Run the auto-check for ONE token. Returns a decision object the trade
 * flow uses to gate the trade. Never throws on probe failure (those map
 * to verdict="unknown" + action="warn"). DOES throw when verdict is
 * `honeypot` or `suspicious + failOnSuspicious=true` — the trade flow
 * catches and surfaces as `TOKEN_BLOCKED`.
 *
 * Configuration short-circuits (cheapest first) live in the helper itself
 * so the caller doesn't have to repeat them.
 */
export async function checkTokenAtTradeTime(args: CheckTokenAtTradeTimeArgs): Promise<AutoTokenCheckDecision> {
  const cfg = args.config.safety.autoTokenCheck;
  if (!cfg || !cfg.enabled) {
    return { action: "skip", fromCache: false, reason: "auto-token-check disabled" };
  }

  // Skip native sentinels + chain baselines (USDC / WETH / WBTC).
  if (isBaselineTrustedToken(args.profile, args.tokenAddress)) {
    return { action: "skip", fromCache: false, reason: "baseline-trusted token (native / USDC / WETH / WBTC)" };
  }
  // Skip operator whitelist when configured.
  if (cfg.skipWhitelisted && isOperatorWhitelisted(args.config, args.chain, args.tokenAddress)) {
    return { action: "skip", fromCache: false, reason: "in safety.tokenWhitelist (operator-trusted)" };
  }

  const now = args.now ?? new Date();
  const nowIso = now.toISOString();

  // Cache lookup.
  const cached = getCachedTokenVerdict(args.chain, args.tokenAddress, nowIso);
  if (cached) {
    return decisionFromVerdict({
      verdict: cached.verdict,
      reason: `cached verdict (checked at ${cached.checked_at})`,
      fromCache: true,
      checkedAt: cached.checked_at,
      probeUsd: cached.probe_usd ?? undefined,
      failOnSuspicious: cfg.failOnSuspicious,
    });
  }

  // Cache miss — run the probe.
  args.logger.info(
    `auto-token-check: probing ${args.tokenAddress} on ${args.chain} (probe size $${cfg.probeUsd})`,
  );
  const probeFn = args.probeFn ?? (await defaultProbe());
  let report: TokenSafetyReport;
  try {
    report = await probeFn({
      token: args.tokenAddress as Address,
      probeUsd: cfg.probeUsd,
      publicClient: args.publicClient,
      walletAddress: args.walletAddress,
      profile: args.profile,
      config: args.config,
      logger: args.logger,
    });
  } catch (e) {
    // Probe itself threw — treat as "unknown" verdict so the trade
    // proceeds (fail-open on infra outage). Don't cache the unknown
    // since the next trade might succeed if the upstream comes back.
    const msg = (e as Error).message ?? String(e);
    args.logger.warn(`auto-token-check probe threw (treated as unknown): ${msg}`);
    return {
      action: "warn",
      verdict: "unknown",
      fromCache: false,
      reason: `probe failed (${msg}) — continuing fail-open. Set safety.tokenWhitelist to skip future probes.`,
    };
  }

  // Persist the verdict in the cache.
  putCachedTokenVerdict({
    chain: args.chain,
    tokenAddress: args.tokenAddress,
    verdict: report.verdict,
    detailsJson: JSON.stringify(report),
    probeUsd: cfg.probeUsd,
    cacheTtlMs: cfg.cacheTtlMs,
    now,
  });
  return decisionFromVerdict({
    verdict: report.verdict,
    reason: `fresh probe: ${report.reasons.join(" · ")}`,
    fromCache: false,
    checkedAt: nowIso,
    probeUsd: cfg.probeUsd,
    failOnSuspicious: cfg.failOnSuspicious,
  });
}

/** Translate a raw verdict into a structured decision (pure). */
function decisionFromVerdict(args: {
  verdict: TokenSafetyCacheVerdict;
  reason: string;
  fromCache: boolean;
  checkedAt?: string;
  probeUsd?: number;
  failOnSuspicious: boolean;
}): AutoTokenCheckDecision {
  const action = verdictAction(args.verdict, args.failOnSuspicious);
  return {
    action,
    verdict: args.verdict,
    fromCache: args.fromCache,
    reason: args.reason,
    checkedAt: args.checkedAt,
    probeUsd: args.probeUsd,
  };
}

/** Dynamic import shim — keeps the trade module from picking up the
 *  full tokenSafety chain at load time. Only loaded when a probe
 *  actually fires. */
async function defaultProbe(): Promise<SafetyProbeFn> {
  const { checkTokenSafety } = await import("./tokenSafety.js");
  return checkTokenSafety as SafetyProbeFn;
}

// ── enforcement wrapper ──────────────────────────────────────

/**
 * Enforcement wrapper that the trade flow calls. Runs the check for ONE
 * token + maps the decision to either pass-through (no-op) OR throw
 * `TOKEN_BLOCKED`. Notification is emitted on block.
 *
 * Caller (trade.ts) invokes this once per relevant token (typically twice
 * per swap — input + output).
 */
export async function enforceTokenSafety(
  args: CheckTokenAtTradeTimeArgs & {
    /** Operator-facing label of which side this token is — "input" or
     *  "output" — so the error message names the offender. */
    side: "input" | "output";
  },
): Promise<AutoTokenCheckDecision> {
  const decision = await checkTokenAtTradeTime(args);
  if (decision.action === "skip" || decision.action === "ok") {
    args.logger.debug(
      `auto-token-check: ${args.side} token ${args.tokenAddress} → ${decision.action} (${decision.reason})`,
    );
    return decision;
  }
  if (decision.action === "warn") {
    args.logger.warn(
      `auto-token-check: ${args.side} token ${args.tokenAddress} verdict=${decision.verdict ?? "?"} (${decision.reason}). Trade allowed but operator review recommended.`,
    );
    return decision;
  }
  // action === "block" → fire notification + throw structured error.
  // Notification is best-effort; the throw is the source-of-truth.
  await tryNotify(
    {
      event: "token.honeypot_blocked",
      severity: "critical",
      title: `Trade blocked — ${args.side} token ${args.tokenAddress} verdict=${decision.verdict}`,
      body: decision.reason,
      fields: {
        chain: args.chain,
        side: args.side,
        token: args.tokenAddress,
        verdict: decision.verdict,
        fromCache: decision.fromCache,
        checkedAt: decision.checkedAt,
        probeUsd: decision.probeUsd,
      },
      dedupKey: `token.honeypot_blocked:${args.chain}:${args.tokenAddress.toLowerCase()}:${decision.verdict}`,
    },
    args.config,
    args.logger,
  );
  throw new ToolError(
    "TOKEN_BLOCKED",
    `Auto-check blocked ${args.side} token ${args.tokenAddress} on chain ${args.chain}: verdict=${decision.verdict}. ${decision.reason}`,
    {
      details: {
        chain: args.chain,
        side: args.side,
        token: args.tokenAddress,
        verdict: decision.verdict,
        fromCache: decision.fromCache,
        reason: decision.reason,
        checkedAt: decision.checkedAt,
        autoTokenCheck: true,
      },
      nextActions: [
        {
          tool: "check_token",
          params: { chain: args.chain, address: args.tokenAddress, probeUsd: args.config.safety.autoTokenCheck?.probeUsd ?? 5 },
          reason:
            decision.verdict === "honeypot"
              ? `Confirm the honeypot probe manually (\`tradekit token check ${args.tokenAddress} --chain ${args.chain}\`). If you're CERTAIN the token is safe, add to safety.tokenWhitelist.${args.chain} to skip future probes.`
              : `Re-run the probe manually for a current verdict (\`tradekit token check ${args.tokenAddress} --chain ${args.chain}\`). If safe, add to safety.tokenWhitelist.${args.chain} OR set safety.autoTokenCheck.failOnSuspicious=false to fall back to warn-only.`,
        },
      ],
    },
  );
}

// ── re-exports ──────────────────────────────────────────────

export { getCachedTokenVerdict, putCachedTokenVerdict };
export type { TokenSafetyCacheRow };
