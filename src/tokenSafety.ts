// Iter609: token safety check — runs a buy+sell round-trip simulation against
// an unknown token to detect the most common rug patterns:
//   - Honeypot: buy succeeds but sell reverts. The classic drain — operator
//     buys in, gets stuck with valueless tokens forever.
//   - High transfer tax: round-trip loses more than expected slippage + 2x gas.
//     Some tokens charge 10-25% fee on transfer (so swapping in+out costs ~40%).
//   - Sell-blocked: a variant of honeypot where the contract allows ONLY whitelisted
//     addresses to sell, surfacing as a sell-side simulate revert.
//
// The probe simulates without committing funds (eth_call, not eth_sendTransaction).
// So it costs ~4 RPC roundtrips (2 quotes + 2 simulates) but burns zero gas.
//
// Verdict logic:
//   - "honeypot": sell simulation reverted but buy simulation succeeded
//   - "suspicious": both succeed BUT round-trip loss > suspiciousLossPct
//   - "ok": both succeed AND round-trip loss ≤ suspiciousLossPct
//   - "unknown": couldn't even quote (no liquidity / aggregator declined) —
//     not safe to claim either way

import type { Address, PublicClient, Transport, Chain } from "viem";
import { formatUnits } from "viem";
import type { ChainProfile } from "./chains.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { ToolError } from "./errors.js";
import { aggregateQuote, type AggregatorQuote } from "./aggregator.js";
import { simulateTx, type SimulationResult } from "./simulate.js";
import { getToken, NATIVE_TOKEN } from "./tokens.js";

export type SafetyVerdict = "ok" | "suspicious" | "honeypot" | "unknown";

export interface TokenSafetyReport {
  chain: string;
  token: Address;
  symbol: string;
  decimals: number;
  /** USD-denominated probe amount used (e.g. $10). Pure native amount derived
   *  via native price; surfaced so an operator/agent sees the magnitude tested. */
  probeUsd: number;
  /** Native amount used as the buy-side input. */
  probeNativeAmount: string;

  /** Whether the round-trip even reached the sell side. */
  buyQuoted: boolean;
  buySimulated: boolean;
  buyRevertReason?: string;
  /** Expected output of the buy (the token amount we'd hypothetically receive). */
  expectedTokenOut?: string;

  sellQuoted: boolean;
  sellSimulated: boolean;
  sellRevertReason?: string;
  /** Expected native received after a sell of expectedTokenOut. */
  expectedNativeOut?: string;

  /**
   * Round-trip loss percent: 1 - (expectedNativeOut / probeNativeAmount) × 100.
   * Positive = net loss. Includes slippage + gas + transfer tax. Null when
   * one side couldn't quote/simulate.
   */
  roundTripLossPct: number | null;
  /** Threshold above which the verdict is "suspicious" (default 20%). */
  suspiciousLossPct: number;

  verdict: SafetyVerdict;
  /** Human-readable + agent-readable reasoning for the verdict. */
  reasons: string[];
  timestamp: string;
}

/** Default threshold for "suspicious" tax/slippage. 20% net loss on a $10 probe
 *  with 50bps slippage means the token charged ~19% on the round-trip — far
 *  above the gas+slippage budget. */
export const DEFAULT_SUSPICIOUS_LOSS_PCT = 20;

/**
 * Iter609: pure verdict logic. Given the four boolean outcomes + the loss %,
 * derive the SafetyVerdict and reasoning. Split for unit testing without HTTP.
 *
 * Precedence (highest priority first):
 *   1. buy didn't even quote → "unknown" (no liquidity to assess)
 *   2. buy quoted but sell didn't quote/simulate → "honeypot" (or "unknown" if
 *      the buy simulation also failed — can't assess sell-blocked vs no-liquidity)
 *   3. buy simulated and sell reverted → "honeypot"
 *   4. both simulated → check loss → "suspicious" if > threshold, "ok" otherwise
 */
export function computeSafetyVerdict(args: {
  buyQuoted: boolean;
  buySimulated: boolean;
  buyRevertReason?: string;
  sellQuoted: boolean;
  sellSimulated: boolean;
  sellRevertReason?: string;
  roundTripLossPct: number | null;
  suspiciousLossPct: number;
}): { verdict: SafetyVerdict; reasons: string[] } {
  const reasons: string[] = [];

  if (!args.buyQuoted) {
    reasons.push("Aggregator could not produce a buy quote — likely no liquidity. Verdict 'unknown' (not enough info to assess safety).");
    return { verdict: "unknown", reasons };
  }

  if (args.buyQuoted && !args.buySimulated) {
    reasons.push(`Buy simulation reverted (${args.buyRevertReason ?? "unknown reason"}). The token's buy path itself failed — possibly transfer-locked, paused, or selector mismatch.`);
    // If buy simulate failed we can't probe sell behavior reliably. Call it
    // "unknown" rather than declaring honeypot, since a paused contract isn't
    // strictly a honeypot.
    return { verdict: "unknown", reasons };
  }

  // Buy quoted AND simulated. Now look at the sell side.
  if (!args.sellQuoted) {
    reasons.push("Buy works, but the aggregator couldn't produce a sell quote for the received tokens — strong honeypot indicator (no exit liquidity).");
    return { verdict: "honeypot", reasons };
  }

  if (!args.sellSimulated) {
    reasons.push(`Buy works, sell quote exists but sell SIMULATION reverted (${args.sellRevertReason ?? "unknown reason"}). Classic honeypot: the contract gates the transfer/sell so the buy is profitable to the rugger and the operator can't exit.`);
    return { verdict: "honeypot", reasons };
  }

  // Both simulated. Look at loss.
  if (args.roundTripLossPct == null) {
    reasons.push("Round-trip succeeded but could not compute loss percentage (price oracle gap). Verdict 'unknown'.");
    return { verdict: "unknown", reasons };
  }
  if (args.roundTripLossPct > args.suspiciousLossPct) {
    reasons.push(`Round-trip loss of ${args.roundTripLossPct.toFixed(1)}% exceeds the ${args.suspiciousLossPct}% threshold. Likely a high-transfer-tax token (some charge 10-25% per transfer) — not a honeypot, but every swap erodes value significantly.`);
    return { verdict: "suspicious", reasons };
  }

  reasons.push(`Buy + sell both simulated successfully. Round-trip loss ${args.roundTripLossPct.toFixed(1)}% is within the expected slippage + gas budget. No honeypot indicators detected.`);
  // Surface the limitation explicitly — this is NOT a guarantee. Tokens can
  // have time-locked sells, owner-gated sells, etc. that only trigger AFTER
  // certain conditions, and this simulation runs from the current state.
  reasons.push("Note: this probe simulates from current state only. Time-locked or owner-gated sells that activate later won't be detected. Treat as a sanity check, not a guarantee.");
  return { verdict: "ok", reasons };
}

/**
 * Orchestrator. Probes the token by simulating a $probeUsd buy + the matching sell.
 *
 * `probeUsd` should be small (default $10) so the round-trip doesn't move the
 * pool meaningfully (which would itself inflate the loss %). For very illiquid
 * tokens a smaller probe (e.g. $1) is safer.
 */
export async function checkTokenSafety(args: {
  token: Address;
  probeUsd?: number;
  suspiciousLossPct?: number;
  publicClient: PublicClient<Transport, Chain>;
  walletAddress: Address;
  profile: ChainProfile;
  config: Config;
  logger: Logger;
}): Promise<TokenSafetyReport> {
  const probeUsd = args.probeUsd ?? 10;
  const suspiciousLossPct = args.suspiciousLossPct ?? DEFAULT_SUSPICIOUS_LOSS_PCT;

  // Resolve token metadata (decimals + symbol).
  const tokenMeta = await getToken(args.publicClient, args.profile, args.token);

  // Compute the probe native amount from probeUsd via the native USD price.
  // Use a synchronous import for getCurrentPrice via promise — same path price.ts uses.
  const { getCurrentPrice } = await import("./price.js");
  const nativeUsd = await getCurrentPrice(args.profile.weth, args.logger);
  if (nativeUsd == null || nativeUsd <= 0) {
    // No native price → we can't size the probe in USD terms. Fall back to a
    // small fixed native amount (0.001 ETH-equivalent) so the probe still runs.
    args.logger.warn(`Token safety probe on ${args.profile.name}: no native USD price available, using fixed 0.001 native fallback for sizing`);
  }
  const probeNativeFloat = nativeUsd && nativeUsd > 0 ? probeUsd / nativeUsd : 0.001;
  // Native uses 18 decimals across every chain tradekit supports.
  const probeNativeRaw = BigInt(Math.floor(probeNativeFloat * 1e18));
  const probeNativeStr = formatUnits(probeNativeRaw, 18);

  args.logger.info(
    `Token safety probe on ${args.profile.name} for ${tokenMeta.symbol} (${args.token}): probing $${probeUsd} = ${probeNativeStr} ${args.profile.nativeSymbol}`,
  );

  // BUY-SIDE: native → token.
  let buyQuote: AggregatorQuote | null = null;
  let buyQuoted = false;
  let buySim: SimulationResult | null = null;
  let buyRevertReason: string | undefined;
  let expectedTokenOut: bigint | null = null;

  try {
    buyQuote = await aggregateQuote(
      {
        profile: args.profile,
        tokenIn: NATIVE_TOKEN,
        tokenOut: args.token,
        amountIn: probeNativeRaw,
        slippageBps: 100, // 1% — typical for unknown tokens
        from: args.walletAddress,
      },
      args.config,
      args.logger,
    );
    buyQuoted = true;
    expectedTokenOut = buyQuote.amountOut;
  } catch (e) {
    args.logger.info(`Token safety: buy quote failed: ${(e as Error).message}`);
  }

  if (buyQuote) {
    try {
      buySim = await simulateTx({
        publicClient: args.publicClient,
        from: args.walletAddress,
        to: buyQuote.to,
        data: buyQuote.data,
        value: buyQuote.value,
        logger: args.logger,
      });
      buyRevertReason = buySim.ok ? undefined : buySim.revertReason;
    } catch (e) {
      buyRevertReason = (e as Error).message;
    }
  }
  const buySimulated = buySim?.ok === true;

  // SELL-SIDE: token → native. Only proceed if buy at least quoted.
  let sellQuote: AggregatorQuote | null = null;
  let sellQuoted = false;
  let sellSim: SimulationResult | null = null;
  let sellRevertReason: string | undefined;
  let expectedNativeOut: bigint | null = null;

  if (buyQuoted && expectedTokenOut && expectedTokenOut > 0n) {
    try {
      sellQuote = await aggregateQuote(
        {
          profile: args.profile,
          tokenIn: args.token,
          tokenOut: NATIVE_TOKEN,
          amountIn: expectedTokenOut,
          slippageBps: 100,
          from: args.walletAddress,
        },
        args.config,
        args.logger,
      );
      sellQuoted = true;
      expectedNativeOut = sellQuote.amountOut;
    } catch (e) {
      args.logger.info(`Token safety: sell quote failed: ${(e as Error).message}`);
    }

    if (sellQuote) {
      try {
        sellSim = await simulateTx({
          publicClient: args.publicClient,
          from: args.walletAddress,
          to: sellQuote.to,
          data: sellQuote.data,
          value: sellQuote.value,
          logger: args.logger,
        });
        sellRevertReason = sellSim.ok ? undefined : sellSim.revertReason;
      } catch (e) {
        sellRevertReason = (e as Error).message;
      }
    }
  }
  const sellSimulated = sellSim?.ok === true;

  // Round-trip loss = 1 - (expectedNativeOut / probeNativeRaw).
  let roundTripLossPct: number | null = null;
  if (expectedNativeOut != null && probeNativeRaw > 0n) {
    const inFloat = parseFloat(probeNativeStr);
    const outFloat = parseFloat(formatUnits(expectedNativeOut, 18));
    if (Number.isFinite(inFloat) && Number.isFinite(outFloat) && inFloat > 0) {
      roundTripLossPct = (1 - outFloat / inFloat) * 100;
    }
  }

  const { verdict, reasons } = computeSafetyVerdict({
    buyQuoted,
    buySimulated,
    buyRevertReason,
    sellQuoted,
    sellSimulated,
    sellRevertReason,
    roundTripLossPct,
    suspiciousLossPct,
  });

  return {
    chain: args.profile.name,
    token: args.token,
    symbol: tokenMeta.symbol,
    decimals: tokenMeta.decimals,
    probeUsd,
    probeNativeAmount: probeNativeStr,
    buyQuoted,
    buySimulated,
    buyRevertReason,
    expectedTokenOut: expectedTokenOut != null ? formatUnits(expectedTokenOut, tokenMeta.decimals) : undefined,
    sellQuoted,
    sellSimulated,
    sellRevertReason,
    expectedNativeOut: expectedNativeOut != null ? formatUnits(expectedNativeOut, 18) : undefined,
    roundTripLossPct,
    suspiciousLossPct,
    verdict,
    reasons,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Convenience: short reason string for at-a-glance display. Used by CLI text
 * mode so the operator sees the verdict in one line.
 */
export function shortVerdictLine(report: TokenSafetyReport): string {
  switch (report.verdict) {
    case "honeypot":
      return `🔴 HONEYPOT — ${report.symbol} (${report.token}) cannot be sold from this wallet`;
    case "suspicious":
      return `🟡 SUSPICIOUS — ${report.symbol} round-trip loss ${report.roundTripLossPct?.toFixed(1)}% (likely high transfer tax)`;
    case "ok":
      return `🟢 OK — ${report.symbol} round-trip loss ${report.roundTripLossPct?.toFixed(1)}% (within slippage + gas budget)`;
    case "unknown":
      return `⚪ UNKNOWN — ${report.symbol} could not be probed (no liquidity or RPC error)`;
  }
}

// Unused helper kept for future extension hooks.
void ToolError;
