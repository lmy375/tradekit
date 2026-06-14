// Iter630: pre-trade composite check. Pre-iter630 operators ran 3-4 separate
// commands before a real trade:
//   1. `trade preview`  (iter608)  — gas %, balance %, allowance, safety pre-flight
//   2. `token check`    (iter609)  — honeypot/high-tax probe via buy+sell sim
//   3. `price-check`    (iter613)  — cross-source price sanity (CoinGecko vs DexScreener)
//   4. `trades analyze` (iter619)  — historical realized slippage on similar trades
//
// Each returned PART of the picture. This module composes them into ONE call
// with a go / caution / no_go verdict and a structured `reasons[]` list so
// agents can branch on the same data operators read.
//
// Why this isn't "blindly adding features": it adds NO new RPC primitives,
// no new business logic, no new data sources. It's pure composition over
// existing iter608/609/613/619 capabilities. The verdict combiner is the
// only new logic — and that's a pure priority-ranked rule set.
//
// Design priorities:
//   1. Pure verdict combiner so the decision tree is unit-testable
//   2. Parallel fan-out (preview is the slowest; others race against it)
//   3. Skip-flags for expensive checks operators sometimes want to bypass
//      (e.g. --skip-honeypot when the token is well-known and the round-trip
//      probe just costs RPC roundtrips without new signal)
//   4. Verdict semantics conservative on no_go — only TRUE deal-breakers
//      trigger it; questionable findings → caution. Default operator should
//      be able to override caution and proceed.

import type { Address, PublicClient, Transport, Chain } from "viem";
import type { ChainProfile } from "./chains.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { TradePreviewReport } from "./tradePreview.js";
import type { TokenSafetyReport } from "./tokenSafety.js";
import type { PriceCrossCheck } from "./priceCrossCheck.js";
import type { AnalyzedTrade } from "./tradeAnalysis.js";

/** Final go/no_go/caution verdict. */
export type PreflightVerdict = "go" | "caution" | "no_go";

export interface PreflightReason {
  /** Stable code an agent can branch on. Stable across iters; new codes are additive. */
  code:
    | "token_honeypot"
    | "token_suspicious"
    | "price_extreme_divergence"
    | "price_suspicious_divergence"
    | "preview_safety_failed"
    | "limit_would_reject"
    | "high_realized_slippage_history"
    | "gas_pct_high"
    | "balance_fraction_high"
    | "approval_needed"
    | "market_timing_caution"
    | "market_timing_ok"
    | "preview_ok"
    | "token_ok"
    | "price_ok"
    | "history_ok"
    | "check_skipped";
  severity: "info" | "warn" | "critical";
  message: string;
  /** Source check this came from. */
  source: "preview" | "token_safety" | "price_cross_check" | "history" | "market_timing" | "general";
}

export interface PreflightReport {
  chain: string;
  direction: "buy" | "sell";
  baseSymbol: string;
  quoteSymbol: string;
  /** ISO timestamp the preflight ran. */
  timestamp: string;
  verdict: PreflightVerdict;
  reasons: PreflightReason[];
  /** Source reports for callers who want the full detail. Each may be null
   *  when the check was skipped or failed. */
  preview?: TradePreviewReport;
  tokenSafety?: TokenSafetyReport;
  priceCrossCheck?: PriceCrossCheck;
  /** Iter619 historical analysis for similar trades. */
  history?: {
    sampleSize: number;
    medianSlippageBps: number | null;
    p95SlippageBps: number | null;
  };
}

/**
 * Iter630: pure verdict combiner. Walks the source reports + builds the
 * priority-ranked verdict.
 *
 * Decision tree (HIGHEST priority first — first match decides verdict tier):
 *
 *  Critical (no_go):
 *    1. token honeypot detected
 *    2. price cross-check extreme divergence (likely manipulation)
 *    3. preview safety pre-flight rejected (slippage cap, USD limit, etc.)
 *
 *  Warn (caution):
 *    4. token suspicious (high transfer tax / round-trip loss)
 *    5. price suspicious divergence
 *    6. historical median slippage > 100 bps (route quality issue)
 *    7. gas % of trade > 10%
 *    8. market-timing caution (buying near a high / into a falling knife;
 *       selling near a low) — advice, nudges to caution, never blocks
 *
 *  Info (still go, but operator should know):
 *    9. balance fraction > 50%
 *   10. approval needed
 *   11. market-timing favorable / neutral
 *
 * Multiple findings can be reported; verdict is the WORST severity. Reasons
 * list is the COMPLETE set so the operator sees every signal.
 *
 * Exported pure for unit testing without standing up the full RPC stack.
 */
export function combinePreflightVerdict(args: {
  preview?: TradePreviewReport | { error: string };
  tokenSafety?: TokenSafetyReport | { error: string };
  priceCrossCheck?: PriceCrossCheck | { error: string };
  history?: { sampleSize: number; medianSlippageBps: number | null; p95SlippageBps: number | null } | { error: string };
}): { verdict: PreflightVerdict; reasons: PreflightReason[] } {
  const reasons: PreflightReason[] = [];

  // 1. Token honeypot — the only check whose failure is unambiguously no_go.
  if (args.tokenSafety && "verdict" in args.tokenSafety) {
    if (args.tokenSafety.verdict === "honeypot") {
      reasons.push({
        code: "token_honeypot",
        severity: "critical",
        message: `Token check detected HONEYPOT pattern (buy succeeds, sell fails). Refusing the trade.`,
        source: "token_safety",
      });
    } else if (args.tokenSafety.verdict === "suspicious") {
      reasons.push({
        code: "token_suspicious",
        severity: "warn",
        message: `Token has suspicious round-trip behavior (loss ${args.tokenSafety.roundTripLossPct?.toFixed(1) ?? "?"}%). High transfer tax likely.`,
        source: "token_safety",
      });
    } else if (args.tokenSafety.verdict === "ok") {
      reasons.push({
        code: "token_ok",
        severity: "info",
        message: "Token round-trip probe passed.",
        source: "token_safety",
      });
    }
  }

  // 2. Price cross-check.
  if (args.priceCrossCheck && "verdict" in args.priceCrossCheck) {
    if (args.priceCrossCheck.verdict === "extreme") {
      reasons.push({
        code: "price_extreme_divergence",
        severity: "critical",
        message: `Price cross-check: extreme divergence ${args.priceCrossCheck.divergencePct?.toFixed(1) ?? "?"}% between sources. Likely pool manipulation, depeg, or honeypot pricing trick.`,
        source: "price_cross_check",
      });
    } else if (args.priceCrossCheck.verdict === "suspicious") {
      reasons.push({
        code: "price_suspicious_divergence",
        severity: "warn",
        message: `Price cross-check: ${args.priceCrossCheck.divergencePct?.toFixed(1) ?? "?"}% divergence between sources. Above the configured tolerance but below extreme.`,
        source: "price_cross_check",
      });
    } else if (args.priceCrossCheck.verdict === "ok") {
      reasons.push({
        code: "price_ok",
        severity: "info",
        message: "Price cross-check passed.",
        source: "price_cross_check",
      });
    }
  }

  // 3. Preview safety pre-flight result.
  if (args.preview && "safety" in args.preview) {
    if (!args.preview.safety.passes) {
      reasons.push({
        code: "preview_safety_failed",
        severity: "critical",
        message: `Pre-flight safety check failed: ${args.preview.safety.rejection?.message ?? "unknown reason"}.`,
        source: "preview",
      });
    } else {
      reasons.push({
        code: "preview_ok",
        severity: "info",
        message: "Pre-flight safety checks passed.",
        source: "preview",
      });
    }

    // v54: state-dependent limit projection (per-tx/daily USD, rate limit,
    // strategy budget, position cap, gas budget). A trade that would bounce
    // off one of these at execution is a no_go — the agent shouldn't fire it
    // only to eat a SAFEGUARD_TRIGGERED / STRATEGY_BUDGET_EXCEEDED reject.
    if (args.preview.limits && !args.preview.limits.admissible) {
      const blocked = args.preview.limits.blocking
        .map((b) => `${b.label}${b.code ? ` (${b.code})` : ""}`)
        .join("; ");
      reasons.push({
        code: "limit_would_reject",
        severity: "critical",
        message: `A configured guardrail would REJECT this trade at execution: ${blocked}. ${args.preview.limits.blocking[0]?.message ?? ""}`.trim(),
        source: "preview",
      });
    }

    // Lower-severity preview signals — gas % and balance fraction.
    const gasPct = args.preview.metrics.gasPctOfInput;
    if (gasPct != null && gasPct > 10) {
      reasons.push({
        code: "gas_pct_high",
        severity: "warn",
        message: `Gas is ${gasPct.toFixed(1)}% of trade input. Consider increasing trade size or waiting for lower gas.`,
        source: "preview",
      });
    }
    if (args.preview.metrics.balanceFractionPct > 50) {
      reasons.push({
        code: "balance_fraction_high",
        severity: "info",
        message: `Trade spends ${args.preview.metrics.balanceFractionPct.toFixed(1)}% of input-token balance. Confirm this is intentional.`,
        source: "preview",
      });
    }
    if (!args.preview.metrics.hasSufficientAllowance) {
      reasons.push({
        code: "approval_needed",
        severity: "info",
        message: "Approval needed before this trade — agent must call `approve` first, or the trade orchestrator will handle it.",
        source: "preview",
      });
    }

    // v69: market-timing read. `limits`/`safety` answer "will it execute?";
    // this answers "is now a good time?". A caution flag (buying near the
    // recent high / into a falling knife; selling near the recent low) is a
    // warn — it nudges the verdict to caution but never blocks: timing is
    // advice, not a hard guardrail. Favorable / neutral is recorded info-level
    // so the verdict stays honest about what was checked.
    if (args.preview.marketContext) {
      const mc = args.preview.marketContext;
      if (mc.timing === "caution") {
        reasons.push({
          code: "market_timing_caution",
          severity: "warn",
          message: `Market timing caution: ${mc.notes.join("; ") || mc.summary}.`,
          source: "market_timing",
        });
      } else {
        reasons.push({
          code: "market_timing_ok",
          severity: "info",
          message: `Market timing ${mc.timing}: ${mc.summary}.`,
          source: "market_timing",
        });
      }
    }
  }

  // 4. Historical realized slippage from iter619.
  if (args.history && "medianSlippageBps" in args.history && args.history.medianSlippageBps != null) {
    if (args.history.medianSlippageBps > 100) {
      reasons.push({
        code: "high_realized_slippage_history",
        severity: "warn",
        message: `Historical median realized slippage for similar trades is ${args.history.medianSlippageBps.toFixed(1)} bps over ${args.history.sampleSize} trades. Route quality has been mediocre.`,
        source: "history",
      });
    } else {
      reasons.push({
        code: "history_ok",
        severity: "info",
        message: `Historical realized slippage looks healthy: median ${args.history.medianSlippageBps.toFixed(1)} bps over ${args.history.sampleSize} trades.`,
        source: "history",
      });
    }
  }

  // Skipped checks → record info-level so the verdict is honest.
  if (args.preview && "error" in args.preview) {
    reasons.push({
      code: "check_skipped",
      severity: "info",
      message: `preview check skipped: ${args.preview.error}`,
      source: "preview",
    });
  }
  if (args.tokenSafety && "error" in args.tokenSafety) {
    reasons.push({
      code: "check_skipped",
      severity: "info",
      message: `token safety check skipped: ${args.tokenSafety.error}`,
      source: "token_safety",
    });
  }
  if (args.priceCrossCheck && "error" in args.priceCrossCheck) {
    reasons.push({
      code: "check_skipped",
      severity: "info",
      message: `price cross-check skipped: ${args.priceCrossCheck.error}`,
      source: "price_cross_check",
    });
  }
  if (args.history && "error" in args.history) {
    reasons.push({
      code: "check_skipped",
      severity: "info",
      message: `history check skipped: ${args.history.error}`,
      source: "history",
    });
  }

  // Verdict: worst severity decides. critical → no_go, warn → caution, else go.
  let verdict: PreflightVerdict = "go";
  for (const r of reasons) {
    if (r.severity === "critical") {
      verdict = "no_go";
      break;
    }
    if (r.severity === "warn") verdict = "caution";
  }

  return { verdict, reasons };
}

export interface PreflightRequest {
  direction: "buy" | "sell";
  /** Resolved address. CLI/MCP shim normalizes "ETH" → NATIVE_TOKEN before calling. */
  base: Address;
  quote: Address;
  /** Parsed raw bigint amount (CLI/MCP shim resolves via parseUnits + token decimals). */
  baseAmount?: bigint;
  quoteAmount?: bigint;
  slippageBps: number;
  /** Skip the iter609 buy+sell round-trip probe (expensive, ~4 RPC calls). */
  skipHoneypot?: boolean;
  /** Skip the iter613 cross-source price check (CoinGecko + DexScreener). */
  skipPriceCheck?: boolean;
  /** Skip the iter619 historical-quality lookup (DB-bound, cheap). */
  skipHistory?: boolean;
  /** v54: strategy tag — when set, the preview's limit projection also
   *  evaluates the per-strategy budget + position cap that would gate a
   *  tagged agent trade, so the verdict reflects them. */
  strategy?: string | null;
}

/**
 * Iter630: orchestrator. Fans out preview + token safety + price check + DB
 * history query in parallel. Per-call failure is captured into a `{ error }`
 * sentinel and fed to the verdict combiner so a partial check set still
 * produces a verdict.
 *
 * Skipped checks land in the report as `check_skipped` reasons so an operator
 * reading the output knows what WASN'T verified.
 */
export async function runPreflight(args: {
  req: PreflightRequest;
  publicClient: PublicClient<Transport, Chain>;
  walletAddress: Address;
  profile: ChainProfile;
  config: Config;
  logger: Logger;
  accountLabel: string;
}): Promise<PreflightReport> {
  const { previewTrade } = await import("./tradePreview.js");
  const { checkTokenSafety } = await import("./tokenSafety.js");
  const { crossCheckPrice } = await import("./priceCrossCheck.js");
  const { NATIVE_TOKEN } = await import("./tokens.js");

  // For non-preview probes that need a token CONTRACT (not the native sentinel),
  // substitute the wrapped-native address. tradePreview handles this internally;
  // the other probes don't.
  const baseForContractProbes =
    args.req.base === NATIVE_TOKEN ? args.profile.weth : args.req.base;

  // Fire all four checks in parallel.
  const previewP = previewTrade({
    direction: args.req.direction,
    base: args.req.base,
    quote: args.req.quote,
    baseAmount: args.req.baseAmount,
    quoteAmount: args.req.quoteAmount,
    slippageBps: args.req.slippageBps,
    publicClient: args.publicClient,
    walletAddress: args.walletAddress,
    profile: args.profile,
    config: args.config,
    logger: args.logger,
    account: args.accountLabel,
    strategy: args.req.strategy ?? null,
  }).catch((e) => ({ error: (e as Error).message }) as { error: string });

  const tokenSafetyP = args.req.skipHoneypot
    ? Promise.resolve({ error: "skipped via skipHoneypot" } as { error: string })
    : checkTokenSafety({
        token: baseForContractProbes,
        publicClient: args.publicClient,
        walletAddress: args.walletAddress,
        profile: args.profile,
        config: args.config,
        logger: args.logger,
      }).catch((e) => ({ error: (e as Error).message }) as { error: string });

  const priceP = args.req.skipPriceCheck
    ? Promise.resolve({ error: "skipped via skipPriceCheck" } as { error: string })
    : crossCheckPrice({
        tokenAddress: baseForContractProbes,
        logger: args.logger,
      }).catch((e) => ({ error: (e as Error).message }) as { error: string });

  // History query is DB-only; do it inline.
  const history = args.req.skipHistory
    ? ({ error: "skipped via skipHistory" } as { error: string })
    : await loadHistorySlippage({
        chain: args.profile.name,
        account: args.accountLabel,
        baseToken: baseForContractProbes,
        quoteToken: args.req.quote,
        config: args.config,
        logger: args.logger,
      });

  const [preview, tokenSafety, priceCrossCheck] = await Promise.all([previewP, tokenSafetyP, priceP]);

  const { verdict, reasons } = combinePreflightVerdict({
    preview,
    tokenSafety,
    priceCrossCheck,
    history,
  });

  // Resolve symbols for the report. Pull from preview when available; fall
  // back to "?" otherwise (no extra RPC just for the display field).
  const baseSymbol = !("error" in (preview as object))
    ? (preview as TradePreviewReport).baseSymbol
    : "?";
  const quoteSymbol = !("error" in (preview as object))
    ? (preview as TradePreviewReport).quoteSymbol
    : "?";

  return {
    chain: args.profile.name,
    direction: args.req.direction,
    baseSymbol,
    quoteSymbol,
    timestamp: new Date().toISOString(),
    verdict,
    reasons,
    preview: !("error" in (preview as object)) ? (preview as TradePreviewReport) : undefined,
    tokenSafety: !("error" in (tokenSafety as object)) ? (tokenSafety as TokenSafetyReport) : undefined,
    priceCrossCheck: !("error" in (priceCrossCheck as object)) ? (priceCrossCheck as PriceCrossCheck) : undefined,
    history: !("error" in (history as object)) ? (history as PreflightReport["history"]) : undefined,
  };
}

/**
 * Iter630: look up historical realized slippage for the given (base, quote)
 * pair from iter619 analyses of recent success trades.
 *
 * Cheap: queries the local DB + runs analyses against ~10 recent matching
 * trades. Returns sampleSize=0 when no matching history exists.
 */
async function loadHistorySlippage(args: {
  chain: string;
  account: string;
  baseToken: Address;
  quoteToken: Address;
  config: Config;
  logger: Logger;
}): Promise<
  | { sampleSize: number; medianSlippageBps: number | null; p95SlippageBps: number | null }
  | { error: string }
> {
  try {
    const { recentTrades, matchesTradeToken } = await import("./db.js");
    const rawTrades = recentTrades({ chain: args.chain, account: args.account, limit: 100 });
    const baseLc = args.baseToken.toLowerCase();
    const quoteLc = args.quoteToken.toLowerCase();
    const matched = rawTrades.filter(
      (r) =>
        r.status === "success" &&
        matchesTradeToken(r, baseLc) &&
        matchesTradeToken(r, quoteLc),
    );
    if (matched.length === 0) {
      return { sampleSize: 0, medianSlippageBps: null, p95SlippageBps: null };
    }

    // Cap at 10 to bound RPC fan-out — iter619 analysis fetches receipts per row.
    const cap = matched.slice(0, 10);
    const { analyzeStoredTrade } = await import("./tradeAnalysis.js");
    const { resolveProfile } = await import("./config.js");
    const { loadReadOnlyWallet } = await import("./wallet.js");
    const profile = resolveProfile(args.chain, args.config);
    const extraRpcs = args.config.chains[args.chain]?.rpcs ?? [];
    const wallet = loadReadOnlyWallet(profile, extraRpcs, args.account);

    const slips: number[] = [];
    for (const row of cap) {
      try {
        const analyzed = await analyzeStoredTrade({
          row,
          publicClient: wallet.publicClient,
          profile,
          logger: args.logger,
        });
        if (analyzed.comparison) slips.push(analyzed.comparison.slippageBps);
      } catch (e) {
        args.logger.debug(`preflight history: skipped ${row.tx_hash}: ${(e as Error).message}`);
      }
    }
    if (slips.length === 0) {
      return { sampleSize: matched.length, medianSlippageBps: null, p95SlippageBps: null };
    }
    const sorted = [...slips].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted.length >= 5 ? sorted[Math.floor(sorted.length * 0.95)] : null;
    return { sampleSize: slips.length, medianSlippageBps: median, p95SlippageBps: p95 };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
