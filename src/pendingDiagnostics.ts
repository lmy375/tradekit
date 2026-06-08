// Iter622: pending-tx diagnostic. Pre-iter622 an operator with a stuck trade
// could see "status: pending" via `recent_trades` and could `speedup_tx` it,
// but had to manually decide WHY it was stuck and which action was right:
//   - Underpriced gas? speedup with higher multiplier
//   - Blocked by an earlier-nonce pending tx? speedup or cancel the EARLIER one
//   - Wallet nonce moved past it? mark failed (was reorg'd or already mined
//     under a different hash, never noticed)
//   - Fresh submission? wait, mining takes 5–30s on busy chains
//   - RPC reporting stale state? probe again later
//
// This module composes a structured diagnosis using:
//   - Stored TradeRow (timestamp + tx_hash)
//   - getTransaction(hash) — original tx data (nonce, gas, ...)
//   - getTransactionCount(wallet) — wallet's current confirmed nonce
//   - getBlock("latest").baseFeePerGas — current base fee for gas comparison
//
// Pure classifiers are exported so unit tests can pin the bucketing without
// any RPC mock; the orchestrator wires them to viem reads.

import type { Address, PublicClient, Transport, Chain, Hex } from "viem";
import { formatGwei } from "viem";
import type { ChainProfile } from "./chains.js";
import type { TradeRow } from "./db.js";
import type { Logger } from "./logger.js";

/** Gas comparison bucket. Stable across iters; new codes are additive. */
export type GasState =
  | "ok"                  // tx maxFeePerGas comfortably above current base
  | "marginal"            // within 25% of current base — may slip in/out
  | "underpriced"         // below current base — won't mine until base falls
  | "very_underpriced"    // <50% of current base — long wait or never
  | "unknown";            // legacy tx (no maxFeePerGas) or RPC missing data

/** Nonce relationship between this tx and the wallet's current confirmed nonce. */
export type NonceState =
  | "next"                // tx.nonce == walletNonce — first in line to be mined
  | "blocked_by_earlier"  // tx.nonce > walletNonce — earlier nonces still pending
  | "stale"               // tx.nonce < walletNonce — already mined or replaced
  | "unknown";            // RPC failure or tx not found

/** How long the tx has been in the pool. */
export type AgeBucket =
  | "fresh"           // <30s (mining takes time)
  | "moderate"        // 30s–5min
  | "stuck"           // 5min–30min
  | "very_stuck";     // >30min

/** Diagnostic recommendation. */
export type PendingAction =
  | "wait"             // fresh + ok gas → just wait
  | "speedup"          // underpriced AND stuck → bump gas
  | "speedup_high"     // very_underpriced or very_stuck → bump aggressively
  | "cancel_or_speedup_earlier"  // blocked_by_earlier → fix the earlier-nonce tx first
  | "investigate_stale" // stale nonce → tx may have already landed under different hash
  | "wait_and_recheck"  // ok gas + moderate age → likely fine; reconcile soon
  | "unknown";

export interface PendingDiagnosis {
  txHash: string;
  chain: string;
  account: string;
  /** Original tx fields (from getTransaction). Undefined when RPC couldn't find it. */
  txNonce?: number;
  walletNonce?: number;
  maxFeeGwei?: string;
  currentBaseFeeGwei?: string;
  /** Age in seconds since the DB row was created. */
  ageSeconds: number;
  gasState: GasState;
  nonceState: NonceState;
  ageBucket: AgeBucket;
  action: PendingAction;
  /** Human-readable explanation an operator can copy-paste into a support ticket. */
  message: string;
  /** Suggested CLI invocation (tradekit tx speedup/cancel/reconcile). */
  command?: string;
}

/**
 * Iter622: pure classifier. Compare a tx's maxFeePerGas to the current base
 * fee to decide if it's underpriced. Both inputs are bigint (wei).
 *
 * Buckets:
 *   - 100%+ of base: ok (will mine when its turn comes)
 *   - 75–100% of base: marginal
 *   - 50–75% of base: underpriced
 *   - <50% of base: very_underpriced
 *
 * Returns "unknown" when either input is undefined.
 *
 * Note: We compare against base fee, not the priority+base sum. With EIP-1559,
 * a tx pays min(maxFeePerGas, baseFee + maxPriorityFeePerGas). When maxFee <
 * baseFee, the tx CANNOT be mined — wallet's effective gas-cap rejects it.
 * So baseFee is the floor that matters.
 */
export function classifyGasState(args: {
  maxFeePerGas?: bigint;
  currentBaseFee?: bigint;
}): GasState {
  if (args.maxFeePerGas == null || args.currentBaseFee == null) return "unknown";
  if (args.currentBaseFee === 0n) return "ok"; // zero-base-fee chain
  // Ratio in bps for precision. tx_max × 10000 / base.
  const ratio = (args.maxFeePerGas * 10000n) / args.currentBaseFee;
  if (ratio >= 10000n) return "ok";
  if (ratio >= 7500n) return "marginal";
  if (ratio >= 5000n) return "underpriced";
  return "very_underpriced";
}

/**
 * Iter622: pure classifier. Compare a tx's nonce to the wallet's current
 * confirmed nonce.
 *
 *   - walletNonce == txNonce: tx is next in line. mining-blocked by gas/mempool.
 *   - walletNonce <  txNonce: there are EARLIER pending nonces ahead — fix
 *     those first or this one stays stuck regardless of its own gas.
 *   - walletNonce >  txNonce: tx is "stale" — it was either already mined
 *     (and we missed the receipt — reorg or RPC lag) or it was replaced.
 */
export function classifyNonceState(args: {
  walletNonce?: number;
  txNonce?: number;
}): NonceState {
  if (args.walletNonce == null || args.txNonce == null) return "unknown";
  if (args.walletNonce === args.txNonce) return "next";
  if (args.walletNonce < args.txNonce) return "blocked_by_earlier";
  return "stale";
}

/** Iter622: pure classifier. Bucketize age in seconds. */
export function classifyAge(ageSeconds: number): AgeBucket {
  if (ageSeconds < 30) return "fresh";
  if (ageSeconds < 300) return "moderate";
  if (ageSeconds < 1800) return "stuck";
  return "very_stuck";
}

/**
 * Iter622: pure recommender. Compose the classifier outputs into a single
 * actionable verdict + message. Exported so tests pin the decision tree.
 *
 * Decision tree (priority order — first match wins):
 *   1. stale nonce → investigate (tx may have been replaced/mined elsewhere)
 *   2. blocked_by_earlier → fix the earlier nonce first
 *   3. very_underpriced OR very_stuck → speedup_high
 *   4. underpriced AND (stuck OR very_stuck) → speedup
 *   5. ok/marginal gas + fresh → wait
 *   6. ok gas + moderate age → wait_and_recheck
 *   7. unknown state → unknown (display data, let operator decide)
 */
export function recommendAction(args: {
  gasState: GasState;
  nonceState: NonceState;
  ageBucket: AgeBucket;
}): { action: PendingAction; message: string } {
  const { gasState, nonceState, ageBucket } = args;

  if (nonceState === "stale") {
    return {
      action: "investigate_stale",
      message:
        "Wallet's confirmed nonce is past this tx's nonce — the tx was either mined under a different hash (reorg) or replaced. Run reconcile to update status from the chain.",
    };
  }
  if (nonceState === "blocked_by_earlier") {
    return {
      action: "cancel_or_speedup_earlier",
      message:
        "An EARLIER-nonce pending tx is blocking this one. Speedup or cancel the earlier tx first — this tx stays stuck regardless of its own gas until the earlier nonce clears.",
    };
  }
  if (gasState === "very_underpriced" || ageBucket === "very_stuck") {
    return {
      action: "speedup_high",
      message:
        gasState === "very_underpriced"
          ? "Gas is FAR below current base fee — bump with multiplier 1.5–2.0 to mine."
          : "Tx has been pending >30 min with no progress — recommend speedup at multiplier ≥1.5.",
    };
  }
  if ((gasState === "underpriced" || gasState === "marginal") && ageBucket === "stuck") {
    return {
      action: "speedup",
      message:
        "Gas is below current base fee AND tx has been pending >5 min. Speedup with default multiplier (1.2) is likely enough.",
    };
  }
  if (ageBucket === "fresh") {
    return {
      action: "wait",
      message: "Tx was just submitted — normal mining takes a few seconds. No action needed.",
    };
  }
  if (gasState === "ok" && ageBucket === "moderate") {
    return {
      action: "wait_and_recheck",
      message:
        "Gas looks fine but tx hasn't mined within typical window. Wait another minute, then run reconcile to re-check.",
    };
  }
  return {
    action: "unknown",
    message:
      "Mixed signals — gas/nonce/age don't cleanly fit any bucket. Run reconcile to refresh from the chain, then re-diagnose.",
  };
}

/**
 * Iter622: orchestrator. Given a single pending TradeRow + chain context,
 * fetch the on-chain state and produce a PendingDiagnosis.
 *
 * Returns the diagnosis even when RPC calls fail — the action field falls
 * back to "unknown" with an explanatory message rather than throwing. Callers
 * batch-diagnose; per-row failures shouldn't break the whole list.
 */
export async function diagnosePendingTx(args: {
  row: TradeRow;
  walletAddress: Address;
  publicClient: PublicClient<Transport, Chain>;
  profile: ChainProfile;
  logger: Logger;
  /** Override "now" — pure injection point for time-dependent tests. */
  nowMs?: number;
}): Promise<PendingDiagnosis> {
  const { row, walletAddress, publicClient, profile, logger } = args;
  const nowMs = args.nowMs ?? Date.now();
  const ageSeconds = Math.max(0, Math.floor((nowMs - new Date(row.timestamp).getTime()) / 1000));
  const ageBucket = classifyAge(ageSeconds);

  // Try to fetch tx + wallet nonce + latest block in parallel. Each call's
  // failure is captured locally so we still emit a diagnosis with whatever
  // fields succeeded.
  const [txResult, nonceResult, blockResult] = await Promise.allSettled([
    publicClient.getTransaction({ hash: row.tx_hash as Hex }),
    publicClient.getTransactionCount({ address: walletAddress }),
    publicClient.getBlock({ blockTag: "latest" }),
  ]);

  let txNonce: number | undefined;
  let maxFeePerGas: bigint | undefined;
  if (txResult.status === "fulfilled" && txResult.value) {
    txNonce = txResult.value.nonce;
    // viem's Transaction.maxFeePerGas is undefined for legacy txs.
    if ("maxFeePerGas" in txResult.value && txResult.value.maxFeePerGas != null) {
      maxFeePerGas = txResult.value.maxFeePerGas;
    } else if ("gasPrice" in txResult.value && txResult.value.gasPrice != null) {
      // Legacy tx — treat gasPrice as the cap. Less precise but workable for
      // the classifier (which compares against base fee).
      maxFeePerGas = txResult.value.gasPrice as bigint;
    }
  } else if (txResult.status === "rejected") {
    logger.debug(`pending diagnose: getTransaction failed for ${row.tx_hash}: ${(txResult.reason as Error).message}`);
  }

  const walletNonce =
    nonceResult.status === "fulfilled" ? nonceResult.value : undefined;
  if (nonceResult.status === "rejected") {
    logger.debug(`pending diagnose: getTransactionCount failed: ${(nonceResult.reason as Error).message}`);
  }

  let currentBaseFee: bigint | undefined;
  if (blockResult.status === "fulfilled" && blockResult.value.baseFeePerGas != null) {
    currentBaseFee = blockResult.value.baseFeePerGas;
  }

  const gasState = classifyGasState({ maxFeePerGas, currentBaseFee });
  const nonceState = classifyNonceState({ walletNonce, txNonce });
  const { action, message } = recommendAction({ gasState, nonceState, ageBucket });

  // Build the suggested command for actionable verdicts.
  let command: string | undefined;
  if (action === "speedup" || action === "speedup_high") {
    const multiplier = action === "speedup_high" ? "1.5" : "1.2";
    command = `tradekit tx speedup ${row.tx_hash} --chain ${row.chain} --multiplier ${multiplier}`;
  } else if (action === "investigate_stale") {
    command = `tradekit reconcile --chain ${row.chain}`;
  } else if (action === "wait_and_recheck") {
    command = `tradekit reconcile --chain ${row.chain}`;
  } else if (action === "cancel_or_speedup_earlier") {
    // The earlier-nonce tx is what blocks this one; the operator needs to
    // discover its hash (we don't know it). Tell them how.
    command = `tradekit trades --status pending --chain ${row.chain}`;
  }

  return {
    txHash: row.tx_hash,
    chain: row.chain,
    account: row.account,
    txNonce,
    walletNonce,
    maxFeeGwei: maxFeePerGas != null ? formatGwei(maxFeePerGas) : undefined,
    currentBaseFeeGwei: currentBaseFee != null ? formatGwei(currentBaseFee) : undefined,
    ageSeconds,
    gasState,
    nonceState,
    ageBucket,
    action,
    message,
    command,
  };
}
