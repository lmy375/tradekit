import {
  decodeAbiParameters,
  formatUnits,
  type Address,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { ToolError, toToolError } from "./errors.js";
import { sanitizeForLogLine, type Logger } from "./logger.js";

export interface SimulationResult {
  /** Gas units estimated. */
  gas: bigint;
  /** Effective gas price in wei (best estimate). */
  gasPriceWei: bigint;
  /** gas * gasPrice in native (formatted as decimal string). */
  gasCostNative: string;
  /** If simulation reverted, the parsed reason. */
  revertReason?: string;
  ok: boolean;
}

interface SimulateArgs {
  publicClient: PublicClient<Transport, Chain>;
  from: Address;
  to: Address;
  data: `0x${string}`;
  value: bigint;
  logger: Logger;
}

/**
 * Parse a Solidity revert reason from returned bytes. Exported so the parser can be
 * unit-tested — its output feeds toToolError, so a bug here cascades into wrong
 * error codes + missing recovery hints across every reverting trade.
 *
 * Handles:
 *   - Error(string) — selector 0x08c379a0, the standard revert("…") shape.
 *   - Panic(uint256) — selector 0x4e487b71, raised by Solidity assertions / arithmetic.
 *   - Unknown selectors — returned as the raw hex so the caller still sees something.
 *   - Empty / undefined — returns undefined so callers can fall back to the JS error.
 */
/**
 * Common OpenZeppelin v5 custom-error selectors (and a couple of related ones). When
 * the on-chain revert data starts with one of these we render the error NAME instead
 * of the raw 4-byte hex. Downstream the iter58 toToolError classifier matches against
 * these names (substring match) to assign the right ErrorCode + nextActions.
 *
 * Computed once via viem's toFunctionSelector ("ERC20InsufficientBalance(address,uint256,uint256)" etc.)
 * and hardcoded here so we don't pay the bundle cost at every revert.
 */
const CUSTOM_ERROR_NAMES: Record<string, string> = {
  "0xe450d38c": "ERC20InsufficientBalance",
  "0xfb8f41b2": "ERC20InsufficientAllowance",
  "0x96c6fd1e": "ERC20InvalidSender",
  "0xec442f05": "ERC20InvalidReceiver",
  "0xcd786059": "AddressInsufficientBalance",
  "0x1425ea42": "FailedInnerCall",
};

/**
 * Standard Panic codes per the Solidity spec. Pre-iter144 we surfaced "Panic(0x11)"
 * verbatim — operators had to look up what 0x11 meant. Decoding here makes the simulate
 * output self-explanatory and lets toToolError's pattern matcher branch on the human
 * name (e.g. an underflow on a sell looks like an INSUFFICIENT_BALANCE bug, not just
 * a generic revert).
 */
const PANIC_CODES: Record<string, string> = {
  "0x00": "Panic: generic/compiler-inserted (0x00)",
  "0x01": "Panic: assert(false) (0x01)",
  "0x11": "Panic: arithmetic overflow/underflow (0x11)",
  "0x12": "Panic: division/modulo by zero (0x12)",
  "0x21": "Panic: invalid enum conversion (0x21)",
  "0x22": "Panic: corrupted storage byte array (0x22)",
  "0x31": "Panic: pop() on empty array (0x31)",
  "0x32": "Panic: array index out of bounds (0x32)",
  "0x41": "Panic: too much memory allocated (0x41)",
  "0x51": "Panic: zero-initialized internal function called (0x51)",
};

export function decodeRevert(returnData: `0x${string}` | undefined): string | undefined {
  if (!returnData || returnData === "0x") return undefined;
  // Error(string) selector is 0x08c379a0
  if (returnData.startsWith("0x08c379a0")) {
    try {
      const [reason] = decodeAbiParameters([{ type: "string" }], `0x${returnData.slice(10)}`);
      return reason as string;
    } catch {
      return returnData;
    }
  }
  // Panic(uint256) selector 0x4e487b71
  if (returnData.startsWith("0x4e487b71")) {
    try {
      const [code] = decodeAbiParameters([{ type: "uint256" }], `0x${returnData.slice(10)}`);
      const hex = `0x${(code as bigint).toString(16).padStart(2, "0")}`;
      return PANIC_CODES[hex] ?? `Panic(${hex})`;
    } catch {
      return returnData;
    }
  }
  // Known OZ v5 custom errors — return the name so toToolError's pattern table maps to
  // a proper INSUFFICIENT_BALANCE / NEEDS_APPROVAL code instead of generic TX_REVERTED.
  const selector = returnData.slice(0, 10).toLowerCase();
  const name = CUSTOM_ERROR_NAMES[selector];
  if (name) return name;
  return returnData;
}


/**
 * Simulate a transaction with eth_estimateGas + eth_call: confirms the tx won't revert
 * and returns the gas units estimate, the effective gas price, and a normalized native
 * cost. We do NOT run state-overrides (which are RPC-specific) — that's why this works
 * on any plain HTTP RPC without a Tenderly-style dependency.
 *
 * Post-tx token deltas are NOT computed here — they're knowable only after the tx lands
 * (decodeTx.ts handles that from the receipt's Transfer logs). The caller can compare
 * the aggregator's quoted amountOut against the on-chain decoded result if desired.
 */
export async function simulateTx(args: SimulateArgs): Promise<SimulationResult> {
  const { publicClient, from, to, data, value, logger } = args;

  // Estimate gas
  let gas = 0n;
  let revertReason: string | undefined;
  let ok = true;
  try {
    gas = await publicClient.estimateGas({
      account: from,
      to,
      data,
      value,
    });
  } catch (e) {
    ok = false;
    const err = e as Error & { cause?: { data?: `0x${string}` } };
    revertReason = decodeRevert(err.cause?.data) ?? err.message;
    // Iter477: sanitize before logging — revertReason falls back to err.message
    // (viem multi-line) when decodeRevert can't parse the cause data.
    logger.error(sanitizeForLogLine(`simulate estimateGas failed: ${revertReason}`));
  }

  // Run eth_call to surface any revert that estimateGas might have masked
  if (ok) {
    try {
      await publicClient.call({
        account: from,
        to,
        data,
        value,
      });
    } catch (e) {
      ok = false;
      const err = e as Error & { cause?: { data?: `0x${string}` } };
      revertReason = decodeRevert(err.cause?.data) ?? err.message;
      // Iter477: same sanitize as estimateGas branch above.
      logger.error(sanitizeForLogLine(`simulate call failed: ${revertReason}`));
    }
  }

  // Gas price
  let gasPriceWei = 0n;
  if (ok) {
    try {
      const fees = await publicClient.estimateFeesPerGas();
      gasPriceWei = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    } catch {
      try {
        gasPriceWei = await publicClient.getGasPrice();
      } catch {
        gasPriceWei = 0n;
      }
    }
  }

  const gasCostWei = gas * gasPriceWei;
  const gasCostNative = formatUnits(gasCostWei, 18);

  return { gas, gasPriceWei, gasCostNative, revertReason, ok };
}
