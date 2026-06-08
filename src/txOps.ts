// Iter603: stuck-tx recovery — speedup + cancel a pending tx by replacing it at
// the same nonce with higher gas. A pending tx with too-low gas is a real
// production hazard (the mempool spikes after submit + the tx never lands); pre-
// iter603 tradekit had no way to unblock from inside the tool.
//
// Speedup: rebuild the same tx (to/value/data + same nonce) with higher gas, send.
// Cancel: same-nonce zero-value self-transfer with higher gas. The original
// nonce position gets replaced by the new tx; the original tx becomes
// "replacement" by mempool rules.
//
// Safety:
// - Tx must be from the active wallet (rejecting cross-wallet replacement is a
//   foot-gun guard — you'd need the signer for it anyway, but fail loudly
//   instead of with a confusing signer error).
// - Tx must still be pending — replacing a mined tx is impossible; reject with
//   a clear "already mined" message.
// - Cancel is destructive (the operator's original intent is dropped). The CLI
//   surfaces a typed confirmation; the MCP tool takes `confirm=true` opt-in.

import type { Address, Hex } from "viem";
import type { WalletContext } from "./wallet.js";
import type { ChainProfile } from "./chains.js";
import type { Logger } from "./logger.js";
import { ToolError, toToolError } from "./errors.js";

/**
 * Default gas multiplier for the replacement tx. Geth's replacement rule
 * requires the new gas tip to be at least 10% higher than the original; we
 * default to 20% so a single retry covers normal mempool drift without operator
 * tuning. The caller can override (e.g. 2.0 for a really stuck tx).
 */
export const DEFAULT_GAS_MULTIPLIER = 1.2;

/**
 * Floor for gas multiplier — geth's replacement rule is +10%; below that the
 * mempool would reject the replacement as underpriced. We refuse multipliers
 * less than 1.1 at the boundary so an operator typo (1.0, 0.9) doesn't waste
 * an RPC roundtrip on a guaranteed-fail.
 */
export const MIN_GAS_MULTIPLIER = 1.1;

interface TxOpsContext {
  publicClient: WalletContext["publicClient"];
  walletClient: WalletContext["walletClient"];
  profile: ChainProfile;
  logger: Logger;
}

export interface SpeedupResult {
  action: "speedup";
  originalHash: `0x${string}`;
  newHash: `0x${string}`;
  nonce: number;
  multiplier: number;
  /** Old EIP-1559 gas params (gwei strings). Pre-1559 chains report 0 in the priority field. */
  originalGas: { maxFeePerGas: string; maxPriorityFeePerGas: string };
  newGas: { maxFeePerGas: string; maxPriorityFeePerGas: string };
  /** Explorer URL for the new tx so the operator can monitor confirmation. */
  explorerUrl?: string;
}

export interface CancelResult {
  action: "cancel";
  originalHash: `0x${string}`;
  cancelHash: `0x${string}`;
  nonce: number;
  multiplier: number;
  originalGas: { maxFeePerGas: string; maxPriorityFeePerGas: string };
  newGas: { maxFeePerGas: string; maxPriorityFeePerGas: string };
  explorerUrl?: string;
}

/**
 * Fetch + validate the original tx for replacement.
 *
 * Throws:
 * - TX_NOT_FOUND if the RPC doesn't know the hash (wrong chain / very recent /
 *   bad hash).
 * - INVALID_PARAMS if the tx is already mined (can't replace) or owned by a
 *   different address (can't sign for it).
 *
 * Returns the original tx so the caller can build the replacement from its
 * fields.
 */
async function loadReplaceable(
  txHash: `0x${string}`,
  ctx: TxOpsContext,
): Promise<{
  to: Address | null;
  value: bigint;
  data: Hex | undefined;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  // Fetch tx + receipt in parallel. Receipt fetch failing means "pending" (the
  // RPC throws for not-yet-mined hashes); we want both signals.
  type TxResult = Awaited<ReturnType<typeof ctx.publicClient.getTransaction>>;
  type ReceiptResult = Awaited<ReturnType<typeof ctx.publicClient.getTransactionReceipt>>;
  const [txOutcome, receiptOutcome] = await Promise.allSettled([
    ctx.publicClient.getTransaction({ hash: txHash }),
    ctx.publicClient.getTransactionReceipt({ hash: txHash }),
  ]);

  if (txOutcome.status === "rejected") {
    throw new ToolError(
      "TX_NOT_FOUND",
      `Transaction ${txHash} not found on ${ctx.profile.name}. Possible causes: tx is on a different chain (try --chain), tx hash is wrong, or the RPC is very new and hasn't indexed it yet.`,
      { details: { txHash, chain: ctx.profile.name } },
    );
  }
  const tx = txOutcome.value as TxResult;

  // Already mined? receipt fulfilled with a non-null value means yes.
  if (receiptOutcome.status === "fulfilled" && receiptOutcome.value) {
    const receipt = receiptOutcome.value as NonNullable<ReceiptResult>;
    throw new ToolError(
      "INVALID_PARAMS",
      `Transaction ${txHash} is already mined in block ${receipt.blockNumber} on ${ctx.profile.name} — cannot replace a confirmed tx.`,
      {
        details: {
          txHash,
          chain: ctx.profile.name,
          blockNumber: receipt.blockNumber.toString(),
          reason: "already_mined",
        },
      },
    );
  }

  // Ownership: only the original sender can replace the tx (their private key
  // signs the same-nonce replacement). Mismatch = operator tried to replace
  // someone else's tx; surface a specific error rather than letting viem throw
  // a confusing signer error later.
  const walletAddr = ctx.walletClient.account.address.toLowerCase();
  if (tx.from.toLowerCase() !== walletAddr) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Transaction ${txHash} was sent by ${tx.from}, but the active wallet is ${ctx.walletClient.account.address}. Only the original sender can replace a tx — switch accounts or pick a different tx.`,
      {
        details: {
          txHash,
          txSender: tx.from,
          activeWallet: ctx.walletClient.account.address,
          reason: "not_owned",
        },
      },
    );
  }

  // viem types: getTransaction returns either eip1559 (maxFeePerGas/Priority) or
  // legacy (gasPrice). Normalize to the 1559 shape; for legacy txs use gasPrice
  // as maxFeePerGas and priority = 0 (the replacement still works under legacy
  // rules — gasPrice just needs to be 10% higher).
  const maxFeePerGas =
    (tx as { maxFeePerGas?: bigint }).maxFeePerGas ?? (tx as { gasPrice?: bigint }).gasPrice ?? 0n;
  const maxPriorityFeePerGas =
    (tx as { maxPriorityFeePerGas?: bigint }).maxPriorityFeePerGas ?? 0n;

  return {
    to: tx.to as Address | null,
    value: tx.value,
    data: tx.input as Hex | undefined,
    nonce: tx.nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

/**
 * Apply a gas multiplier with bigint precision (avoid float drift on 18-decimal
 * gas-price values). Rounded up so we don't accidentally hit the +10% floor
 * exactly; the mempool sometimes rejects equality cases.
 *
 * `multiplier` accepts decimal (e.g. 1.25). We scale into bigint via integer
 * basis points: 1.25 → 12500, multiply, divide by 10000, then add 1 to round
 * up. Float-then-bigint cast would lose precision on the cents-of-gwei range.
 */
export function applyGasMultiplier(amount: bigint, multiplier: number): bigint {
  if (multiplier < MIN_GAS_MULTIPLIER) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Gas multiplier ${multiplier} is below the ${MIN_GAS_MULTIPLIER} replacement-rule floor (geth requires +10% min). Use ${MIN_GAS_MULTIPLIER} or higher; default is ${DEFAULT_GAS_MULTIPLIER}.`,
      { details: { provided: multiplier, min: MIN_GAS_MULTIPLIER, default: DEFAULT_GAS_MULTIPLIER, reason: "multiplier_too_low" } },
    );
  }
  // Scale by 10000 bps to preserve 4 decimal digits of multiplier precision.
  const bpsScaled = BigInt(Math.round(multiplier * 10000));
  const scaled = (amount * bpsScaled) / 10000n;
  // +1 wei round-up so a multiplier of exactly 1.1 against an even amount
  // still crosses the +10% threshold cleanly.
  return scaled + 1n;
}

function formatGwei(wei: bigint): string {
  // 9 decimals (1 gwei = 10^9 wei). Use bigint string division to avoid float.
  if (wei === 0n) return "0";
  const gwei = wei / 1_000_000_000n;
  const rem = wei % 1_000_000_000n;
  if (rem === 0n) return gwei.toString();
  return `${gwei.toString()}.${rem.toString().padStart(9, "0").replace(/0+$/, "")}`;
}

/**
 * Replace a pending tx with the same to/value/data at the same nonce + higher
 * gas. Returns the new tx hash + the gas-price delta for audit/logging.
 *
 * Errors:
 * - TX_NOT_FOUND: tx unknown on the configured chain.
 * - INVALID_PARAMS: tx already mined, or owned by a different wallet, or
 *   multiplier below the replacement-rule floor.
 * - TX_REVERTED: sendTransaction itself rejected (rare for a same-nonce
 *   replacement — usually means the wallet's nonce moved past the original
 *   between fetch + send).
 */
export async function speedupTx(args: {
  txHash: `0x${string}`;
  multiplier?: number;
  ctx: TxOpsContext;
}): Promise<SpeedupResult> {
  const multiplier = args.multiplier ?? DEFAULT_GAS_MULTIPLIER;
  const original = await loadReplaceable(args.txHash, args.ctx);

  const newMaxFee = applyGasMultiplier(original.maxFeePerGas, multiplier);
  const newPriority = applyGasMultiplier(original.maxPriorityFeePerGas, multiplier);

  args.ctx.logger.info(
    `Speedup ${args.txHash} (nonce ${original.nonce}): maxFee ${formatGwei(original.maxFeePerGas)} → ${formatGwei(newMaxFee)} gwei (×${multiplier})`,
  );

  // sendTransaction with explicit nonce + gas fields. viem accepts both 1559
  // and legacy shapes; we always send 1559 since every chain tradekit supports
  // is post-merge. (If a custom chain adds a pre-1559 L2, viem auto-falls back
  // when maxFeePerGas isn't supported by the chain.)
  let newHash: `0x${string}`;
  try {
    newHash = await args.ctx.walletClient.sendTransaction({
      to: original.to ?? undefined,
      value: original.value,
      data: original.data,
      nonce: original.nonce,
      maxFeePerGas: newMaxFee,
      maxPriorityFeePerGas: newPriority,
    });
  } catch (e) {
    throw toToolError(e, "TX_REVERTED");
  }

  args.ctx.logger.info(`Speedup tx sent: ${newHash}`);

  return {
    action: "speedup",
    originalHash: args.txHash,
    newHash,
    nonce: original.nonce,
    multiplier,
    originalGas: {
      maxFeePerGas: formatGwei(original.maxFeePerGas),
      maxPriorityFeePerGas: formatGwei(original.maxPriorityFeePerGas),
    },
    newGas: {
      maxFeePerGas: formatGwei(newMaxFee),
      maxPriorityFeePerGas: formatGwei(newPriority),
    },
    explorerUrl: args.ctx.profile.explorer ? `${args.ctx.profile.explorer}/tx/${newHash}` : undefined,
  };
}

/**
 * Cancel a pending tx by replacing it with a zero-value self-transfer at the
 * same nonce + higher gas. The mempool replacement rule guarantees the
 * cancel either lands first (the original is dropped) or both fail (which
 * means the chain has moved past the nonce already). Either way, the
 * original intent doesn't execute.
 *
 * Note: cancel uses MORE gas than speedup at the same multiplier because a
 * zero-value transfer still pays 21000 base gas + the higher gas price. The
 * operator should consider this a sunk cost — the alternative is the original
 * tx eventually landing in conditions where it might still revert.
 *
 * Same errors as speedupTx (TX_NOT_FOUND, INVALID_PARAMS, TX_REVERTED).
 */
export async function cancelTx(args: {
  txHash: `0x${string}`;
  multiplier?: number;
  ctx: TxOpsContext;
}): Promise<CancelResult> {
  const multiplier = args.multiplier ?? DEFAULT_GAS_MULTIPLIER;
  const original = await loadReplaceable(args.txHash, args.ctx);

  const newMaxFee = applyGasMultiplier(original.maxFeePerGas, multiplier);
  const newPriority = applyGasMultiplier(original.maxPriorityFeePerGas, multiplier);

  const ownAddress = args.ctx.walletClient.account.address;
  args.ctx.logger.info(
    `Cancel ${args.txHash} (nonce ${original.nonce}): zero-value self-send at maxFee ${formatGwei(newMaxFee)} gwei (×${multiplier})`,
  );

  let cancelHash: `0x${string}`;
  try {
    cancelHash = await args.ctx.walletClient.sendTransaction({
      to: ownAddress,
      value: 0n,
      // Empty data — a pure value transfer. Some wallets reject `data: undefined`
      // alongside an explicit nonce, so set it to "0x" to be explicit.
      data: "0x" as `0x${string}`,
      nonce: original.nonce,
      maxFeePerGas: newMaxFee,
      maxPriorityFeePerGas: newPriority,
    });
  } catch (e) {
    throw toToolError(e, "TX_REVERTED");
  }

  args.ctx.logger.info(`Cancel tx sent: ${cancelHash}`);

  return {
    action: "cancel",
    originalHash: args.txHash,
    cancelHash,
    nonce: original.nonce,
    multiplier,
    originalGas: {
      maxFeePerGas: formatGwei(original.maxFeePerGas),
      maxPriorityFeePerGas: formatGwei(original.maxPriorityFeePerGas),
    },
    newGas: {
      maxFeePerGas: formatGwei(newMaxFee),
      maxPriorityFeePerGas: formatGwei(newPriority),
    },
    explorerUrl: args.ctx.profile.explorer ? `${args.ctx.profile.explorer}/tx/${cancelHash}` : undefined,
  };
}

// Exported for unit tests — pure helper.
export const __testing = { formatGwei };
