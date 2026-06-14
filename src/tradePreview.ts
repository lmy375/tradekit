// Iter608: trade preview — unified pre-trade analysis. Pre-iter608, deciding
// whether to submit a trade required mentally combining outputs of `quote`,
// internal safety pre-flight (only fired at trade-time), wallet balance, and
// current gas prices. This module does that combination in ONE read-only call
// so an operator/agent sees the full picture before deciding to submit.
//
// What "the full picture" includes:
//   - The aggregator quote (price, amountOut, allowanceTarget, slippageBps)
//   - USD valuation of input and output (via getCurrentPrice for both sides)
//   - Slippage CUSHION: how much amountOut exceeds amountOutMinimum (%)
//   - Gas %: estimated gas USD / input USD — flags trades where gas dominates
//   - Balance fraction: amountIn / current wallet balance for tokenIn (%)
//   - Approval state: does the wallet already have allowance for the router?
//   - Safety pre-flight outcome: would the trade pass the slippage cap,
//     token whitelist/blacklist, contract whitelist, USD limits?
//
// Pure read-only: uses loadReadOnlyWallet (no password). The wallet's role is
// just providing an address for balance reads — no signing.

import type { Address, PublicClient, Transport, Chain } from "viem";
import { formatUnits, parseUnits } from "viem";
import type { ChainProfile } from "./chains.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { ERC20_ABI } from "./constants.js";
import { NATIVE_TOKEN } from "./tokens.js";
import { ToolError } from "./errors.js";
import { aggregateQuote, type AggregatorQuote } from "./aggregator.js";
import { getCurrentPrice } from "./price.js";
import { getToken } from "./tokens.js";
import { enforcePreflightSafety, type SafetyCheckInput } from "./safety.js";

export interface PreviewMetrics {
  /** Decimal input amount (formatted), e.g. "100". */
  amountIn: string;
  /** Decimal output amount (mid of the aggregator quote). */
  amountOut: string;
  /** Decimal amount-out floor (after slippage, encoded in calldata). */
  amountOutMinimum: string;
  /** USD value of the input. Null when no price oracle for the input token. */
  inputUsd: number | null;
  /** USD value of the expected output. Null when no price oracle. */
  outputUsd: number | null;
  /** USD value of the worst-case output (amountOutMinimum × outputPrice). Null when no price. */
  outputUsdFloor: number | null;
  /**
   * Slippage cushion in basis points: (amountOut - amountOutMinimum) / amountOut * 10000.
   * Equals roughly the requested slippage in normal conditions; deviations signal
   * an aggregator-side quirk worth investigating.
   */
  slippageCushionBps: number;
  /**
   * Effective price = amountOut / amountIn (in output-per-input units). Useful for
   * comparing across providers without re-doing decimals.
   */
  effectivePrice: number | null;
  /** Estimated gas in native units (gwei converted to ETH-like). Null when unknown. */
  estimatedGasNative: string | null;
  /** Gas USD = estimatedGasNative × native USD price. Null when either is unknown. */
  estimatedGasUsd: number | null;
  /**
   * Gas as a percentage of input USD: estimatedGasUsd / inputUsd × 100. High values
   * (e.g. >5%) signal a trade where gas dominates the economics.
   */
  gasPctOfInput: number | null;
  /** Current wallet balance of tokenIn, decimal. */
  walletBalance: string;
  /**
   * amountIn / walletBalance × 100. ≈100 means "this trade spends all of the input
   * token I have"; <1 means a small partial. Helps catch fat-finger errors where
   * the operator typed the wrong amount.
   */
  balanceFractionPct: number;
  /**
   * Pre-existing allowance for the aggregator's allowanceTarget. Decimal string;
   * "infinite" for ≥ 2^255. Null when tokenIn is native (no allowance concept).
   */
  currentAllowance: string | null;
  /**
   * True when currentAllowance is sufficient for amountIn (or tokenIn is native).
   * When false, a fresh `approve` is needed before the trade can succeed.
   */
  hasSufficientAllowance: boolean;
}

export interface PreviewSafety {
  /** True when enforcePreflightSafety would have allowed the trade. */
  passes: boolean;
  /** When the pre-flight rejected, this carries the error info so the agent
   *  can fix the issue without retrying just to learn what failed. */
  rejection?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface TradePreviewReport {
  chain: string;
  direction: "buy" | "sell";
  baseToken: Address;
  baseSymbol: string;
  quoteToken: Address;
  quoteSymbol: string;
  /** Which aggregator produced the quote. */
  provider: string;
  /** When aggregator.mode is "best", losing providers + spread. Same shape as
   *  AggregatorQuote.alternatives. Empty in "first" mode. */
  alternatives?: AggregatorQuote["alternatives"];
  /** Calldata destination — the contract that will be called. */
  to: Address;
  /** allowanceTarget — the contract that must be approved for tokenIn. */
  allowanceTarget: Address;
  metrics: PreviewMetrics;
  safety: PreviewSafety;
  timestamp: string;
  /** Iter694: predictive failure pattern from iter682 — same shape as
   *  TradeResult.recentFailurePattern. Surfaced here so operators using
   *  preview as their pre-trade dashboard see the warning alongside
   *  metrics + safety. Populated only when ≥3 failures in last 7d on this
   *  base/quote pair AND a non-unknown reason has ≥50% share. */
  recentFailurePattern?: {
    total: number;
    windowDays: number;
    dominantReason: string;
    dominantCount: number;
    /** Iter700: dominant reason's most-recent timestamp. */
    dominantLastSeen?: string;
    suggestedActions?: import("./errors.js").NextAction[];
  };
  /** v54: projection of the STATE-DEPENDENT execution guardrails (per-tx/
   *  daily USD, contract whitelist, rate limit, per-strategy budget,
   *  net-exposure position cap, gas budget) for THIS prospective trade.
   *  Where `safety` covers only the cheap slippage+token subset, this is
   *  the complete "would buy/sell actually be admitted?" picture — so the
   *  agent never gets a "go" here then a SAFEGUARD_TRIGGERED at execution.
   *  Computed via the real enforcers (zero divergence). Absent only when
   *  the projection itself errors (best-effort, never blocks the preview). */
  limits?: import("./tradeAdmissibility.js").TradeLimitProjection;
}

/**
 * Iter608: pure metric math. Given the raw inputs (quote + prices + balance +
 * allowance + gas estimate), derive every metric. Split from the orchestrator
 * so it's unit-testable without HTTP. Pure number-only — no logging, no
 * exceptions for normal inputs.
 *
 * Decimals: amountIn/amountOut/amountOutMinimum/walletBalance/allowance are
 * raw bigint; decimals say how to format. inputPriceUsd/outputPriceUsd are
 * USD per token (decimal-normalized). nativeUsdPrice = USD per native unit.
 * gas/gasPriceWei = raw bigint.
 */
export function computePreviewMetrics(args: {
  amountIn: bigint;
  amountOut: bigint;
  amountOutMinimum: bigint;
  inDecimals: number;
  outDecimals: number;
  inputPriceUsd: number | null;
  outputPriceUsd: number | null;
  nativeUsdPrice: number | null;
  walletBalance: bigint;
  currentAllowance: bigint | null;
  isNativeIn: boolean;
  gas: bigint;
  gasPriceWei: bigint;
}): PreviewMetrics {
  const amountInStr = formatUnits(args.amountIn, args.inDecimals);
  const amountOutStr = formatUnits(args.amountOut, args.outDecimals);
  const amountOutMinStr = formatUnits(args.amountOutMinimum, args.outDecimals);
  const balanceStr = formatUnits(args.walletBalance, args.inDecimals);
  const amountInFloat = parseFloat(amountInStr);
  const amountOutFloat = parseFloat(amountOutStr);
  const balanceFloat = parseFloat(balanceStr);

  const inputUsd =
    args.inputPriceUsd != null && Number.isFinite(amountInFloat)
      ? amountInFloat * args.inputPriceUsd
      : null;
  const outputUsd =
    args.outputPriceUsd != null && Number.isFinite(amountOutFloat)
      ? amountOutFloat * args.outputPriceUsd
      : null;
  const amountOutMinFloat = parseFloat(amountOutMinStr);
  const outputUsdFloor =
    args.outputPriceUsd != null && Number.isFinite(amountOutMinFloat)
      ? amountOutMinFloat * args.outputPriceUsd
      : null;

  // Slippage cushion in bps. Bigint math to avoid float drift on 18-decimal amounts.
  // (amountOut - amountOutMin) / amountOut * 10000.
  let slippageCushionBps = 0;
  if (args.amountOut > 0n) {
    const diff = args.amountOut - args.amountOutMinimum;
    slippageCushionBps = Number((diff * 10000n) / args.amountOut);
  }

  const effectivePrice =
    amountInFloat > 0 && Number.isFinite(amountOutFloat) ? amountOutFloat / amountInFloat : null;

  // Gas: native units = gas × gasPriceWei in 1e18 denomination.
  const gasNativeWei = args.gas * args.gasPriceWei;
  const gasNativeStr = gasNativeWei > 0n ? formatUnits(gasNativeWei, 18) : null;
  const gasNativeFloat = gasNativeStr != null ? parseFloat(gasNativeStr) : null;
  const estimatedGasUsd =
    gasNativeFloat != null && args.nativeUsdPrice != null && Number.isFinite(gasNativeFloat)
      ? gasNativeFloat * args.nativeUsdPrice
      : null;
  const gasPctOfInput =
    estimatedGasUsd != null && inputUsd != null && inputUsd > 0
      ? (estimatedGasUsd / inputUsd) * 100
      : null;

  const balanceFractionPct =
    balanceFloat > 0 && Number.isFinite(amountInFloat) ? (amountInFloat / balanceFloat) * 100 : 0;

  let currentAllowanceStr: string | null = null;
  if (!args.isNativeIn && args.currentAllowance != null) {
    const INFINITE_THRESHOLD = 1n << 255n;
    currentAllowanceStr =
      args.currentAllowance >= INFINITE_THRESHOLD
        ? "infinite"
        : formatUnits(args.currentAllowance, args.inDecimals);
  }
  const hasSufficientAllowance = args.isNativeIn || (args.currentAllowance ?? 0n) >= args.amountIn;

  return {
    amountIn: amountInStr,
    amountOut: amountOutStr,
    amountOutMinimum: amountOutMinStr,
    inputUsd,
    outputUsd,
    outputUsdFloor,
    slippageCushionBps,
    effectivePrice,
    estimatedGasNative: gasNativeStr,
    estimatedGasUsd,
    gasPctOfInput,
    walletBalance: balanceStr,
    balanceFractionPct,
    currentAllowance: currentAllowanceStr,
    hasSufficientAllowance,
  };
}

/**
 * Orchestrator. Calls aggregateQuote, fetches prices in parallel, reads
 * current balance + allowance, computes metrics, runs the safety pre-flight
 * (capturing rejection instead of throwing). Returns a complete preview report.
 *
 * The caller supplies a read-only wallet context (loadReadOnlyWallet) — no
 * password required. Mirrors quote's read-only contract (iter486).
 */
export async function previewTrade(args: {
  direction: "buy" | "sell";
  base: Address;
  quote: Address;
  baseAmount?: bigint;
  quoteAmount?: bigint;
  slippageBps: number;
  publicClient: PublicClient<Transport, Chain>;
  walletAddress: Address;
  account: string;
  profile: ChainProfile;
  config: Config;
  logger: Logger;
  /** v54: optional strategy tag. When set, the limit projection also
   *  evaluates the per-strategy budget + net-exposure position cap that
   *  would gate a tagged agent trade at execution. */
  strategy?: string | null;
}): Promise<TradePreviewReport> {
  const baseIsNative = args.base === NATIVE_TOKEN;
  const quoteIsNative = args.quote === NATIVE_TOKEN;

  // Resolve token metadata (decimals + symbol) for both sides. Use the same
  // getToken cache the rest of the codebase relies on.
  // For native: synthesize a fake "metadata" since getToken expects a contract.
  const baseMeta = baseIsNative
    ? { decimals: 18, symbol: args.profile.nativeSymbol }
    : await getToken(args.publicClient, args.profile, args.base);
  const quoteMeta = quoteIsNative
    ? { decimals: 18, symbol: args.profile.nativeSymbol }
    : await getToken(args.publicClient, args.profile, args.quote);

  // Compute amountIn / tokenIn / tokenOut based on direction.
  let tokenIn: Address;
  let tokenOut: Address;
  let inDecimals: number;
  let outDecimals: number;
  let amountInRaw: bigint;
  if (args.direction === "buy") {
    // buy: spend quoteAmount of quote → receive base.
    if (args.quoteAmount == null) {
      throw new ToolError(
        "INVALID_PARAMS",
        "buy preview requires quoteAmount (the amount of quote to spend).",
        { details: { direction: "buy", missingField: "quoteAmount" } },
      );
    }
    tokenIn = args.quote;
    tokenOut = args.base;
    inDecimals = quoteMeta.decimals;
    outDecimals = baseMeta.decimals;
    amountInRaw = args.quoteAmount;
  } else {
    // sell: send baseAmount of base → receive quote.
    if (args.baseAmount == null) {
      throw new ToolError(
        "INVALID_PARAMS",
        "sell preview requires baseAmount (the amount of base to sell).",
        { details: { direction: "sell", missingField: "baseAmount" } },
      );
    }
    tokenIn = args.base;
    tokenOut = args.quote;
    inDecimals = baseMeta.decimals;
    outDecimals = quoteMeta.decimals;
    amountInRaw = args.baseAmount;
  }
  const isNativeIn = tokenIn === NATIVE_TOKEN;

  // Fetch the aggregator quote.
  const quote = await aggregateQuote(
    {
      profile: args.profile,
      tokenIn,
      tokenOut,
      amountIn: amountInRaw,
      slippageBps: args.slippageBps,
      from: args.walletAddress,
    },
    args.config,
    args.logger,
  );

  // Fan out parallel reads: input USD price, output USD price, native USD price
  // (for gas), wallet balance for tokenIn, current allowance to the
  // allowanceTarget. Each is best-effort — failures yield null/0 so the
  // preview still returns useful partial information.
  const allowanceTokenAddr = isNativeIn ? null : (tokenIn as Address);
  const balancePromise: Promise<bigint> = isNativeIn
    ? args.publicClient.getBalance({ address: args.walletAddress }).catch(() => 0n)
    : (args.publicClient.readContract({
        address: tokenIn as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [args.walletAddress],
      }) as Promise<bigint>).catch(() => 0n);
  const allowancePromise: Promise<bigint | null> = allowanceTokenAddr
    ? (args.publicClient.readContract({
        address: allowanceTokenAddr,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [args.walletAddress, quote.allowanceTarget],
      }) as Promise<bigint>).catch(() => 0n)
    : Promise.resolve(null);

  const [inputPriceUsd, outputPriceUsd, nativeUsdPrice, walletBalance, currentAllowance, fees] =
    await Promise.all([
      // Native price queries don't work with the sentinel — use WETH for natives.
      getCurrentPrice(isNativeIn ? args.profile.weth : (tokenIn as Address), args.logger).catch(() => null),
      getCurrentPrice(tokenOut === NATIVE_TOKEN ? args.profile.weth : (tokenOut as Address), args.logger).catch(() => null),
      getCurrentPrice(args.profile.weth, args.logger).catch(() => null),
      balancePromise,
      allowancePromise,
      args.publicClient.estimateFeesPerGas().catch(() => null),
    ]);

  const gasPriceWei = fees?.maxFeePerGas ?? fees?.gasPrice ?? 0n;

  const metrics = computePreviewMetrics({
    amountIn: amountInRaw,
    amountOut: quote.amountOut,
    amountOutMinimum: quote.amountOutMinimum,
    inDecimals,
    outDecimals,
    inputPriceUsd,
    outputPriceUsd,
    nativeUsdPrice,
    walletBalance,
    currentAllowance,
    isNativeIn,
    gas: quote.gas ?? 0n,
    gasPriceWei,
  });

  // Run the safety pre-flight, capturing rejection instead of throwing.
  let safety: PreviewSafety;
  try {
    const input: SafetyCheckInput = {
      chain: args.profile.name,
      account: args.account,
      tokenIn,
      tokenOut,
      toContract: quote.to,
      estimatedUsd: metrics.inputUsd ?? undefined,
      slippageBps: args.slippageBps,
    };
    enforcePreflightSafety(input, args.config, args.logger);
    safety = { passes: true };
  } catch (e) {
    if (e instanceof ToolError) {
      safety = {
        passes: false,
        rejection: {
          code: e.code,
          message: e.message,
          details: e.details,
        },
      };
    } else {
      throw e;
    }
  }

  // Iter694: pre-trade failure-pattern check — same logic as trade.ts
  // iter682. Surfaced in preview so the operator sees the predictive
  // warning right next to metrics + safety. Best-effort: DB failure leaves
  // the field absent, matching the trade-flow behavior.
  let recentFailurePattern: TradePreviewReport["recentFailurePattern"];
  try {
    const { recentPairFailureHistogram } = await import("./db.js");
    const { classifyReason } = await import("./errors.js");
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const pattern = recentPairFailureHistogram({
      chain: args.profile.name,
      account: args.account,
      baseToken: args.base,
      quoteToken: args.quote,
      sinceIso: sevenDaysAgo,
    });
    if (pattern.total >= 3) {
      const dominant = pattern.reasons.find(
        (r) => r.reason !== "(unknown)" && r.count >= Math.ceil(pattern.total / 2),
      );
      if (dominant) {
        const classified = classifyReason(dominant.reason);
        recentFailurePattern = {
          total: pattern.total,
          windowDays: 7,
          dominantReason: dominant.reason,
          dominantCount: dominant.count,
          // Iter700: dominant reason's most-recent timestamp.
          ...(dominant.lastSeen ? { dominantLastSeen: dominant.lastSeen } : {}),
          ...(classified?.nextActions ? { suggestedActions: classified.nextActions } : {}),
        };
      }
    }
  } catch (e) {
    args.logger.debug(`iter694 pattern check failed: ${(e as Error).message}`);
  }

  // v54: project the full state-dependent execution gauntlet for THIS
  // trade so the agent's pre-trade read is complete (not just the cheap
  // slippage+token subset in `safety`). Best-effort — a projection error
  // never breaks the preview, matching the recentFailurePattern stance.
  let limits: TradePreviewReport["limits"];
  try {
    const { projectTradeLimits } = await import("./tradeAdmissibility.js");
    // For a buy, the base received is the output amount; the quote spent
    // is the input USD. Sells reduce exposure → no position-cap projection.
    const addBaseAmount = args.direction === "buy" ? Number(metrics.amountOut) : null;
    const addCostQuote = args.direction === "buy" ? metrics.inputUsd : null;
    const gas =
      metrics.estimatedGasNative != null
        ? {
            chain: args.profile.name,
            estimatedGasNative: Number(metrics.estimatedGasNative),
            estimatedGasUsd: metrics.estimatedGasUsd ?? undefined,
            estimatedTradeUsd: metrics.inputUsd ?? undefined,
          }
        : null;
    limits = projectTradeLimits({
      config: args.config,
      logger: args.logger,
      chain: args.profile.name,
      account: args.account,
      tokenIn,
      tokenOut,
      toContract: quote.to,
      estimatedUsd: metrics.inputUsd,
      slippageBps: args.slippageBps,
      direction: args.direction,
      strategy: args.strategy ?? null,
      baseToken: args.base,
      baseSymbol: baseMeta.symbol,
      addBaseAmount,
      addCostQuote,
      gas,
    });
  } catch (e) {
    args.logger.debug(`v54 limit projection failed: ${(e as Error).message}`);
  }

  return {
    chain: args.profile.name,
    direction: args.direction,
    baseToken: args.base,
    baseSymbol: baseMeta.symbol,
    quoteToken: args.quote,
    quoteSymbol: quoteMeta.symbol,
    provider: quote.provider,
    alternatives: quote.alternatives,
    to: quote.to,
    allowanceTarget: quote.allowanceTarget,
    metrics,
    safety,
    timestamp: new Date().toISOString(),
    ...(recentFailurePattern ? { recentFailurePattern } : {}),
    ...(limits ? { limits } : {}),
  };
}

// Exported for unit tests — small helper kept private for prod call sites.
export const __testing = { parseUnitsForTest: parseUnits };
