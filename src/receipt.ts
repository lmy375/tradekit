import type { Chain, Hex, PublicClient, Transport } from "viem";
import { WaitForTransactionReceiptTimeoutError } from "viem";
import { ToolError } from "./errors.js";
import type { ChainProfile } from "./chains.js";

/**
 * Default wait for a tx to land. L2s settle in 1-5s; mainnet usually <30s; this
 * leaves enough headroom for congested moments without making the tool look hung.
 * Override via TRADEKIT_RECEIPT_TIMEOUT_MS for chains/networks with worse SLA.
 */
const RECEIPT_TIMEOUT_MS = Number(process.env.TRADEKIT_RECEIPT_TIMEOUT_MS) || 90_000;

/**
 * Await a receipt with a bounded timeout. On timeout, throws TX_TIMEOUT with the tx
 * hash + explorer URL attached as details so the agent can check status itself
 * instead of blindly retrying (a retry would consume a new nonce and likely race).
 */
export async function waitForReceiptWithTimeout(
  publicClient: PublicClient<Transport, Chain>,
  txHash: Hex,
  profile: ChainProfile,
  timeoutMs: number = RECEIPT_TIMEOUT_MS,
): ReturnType<PublicClient<Transport, Chain>["waitForTransactionReceipt"]> {
  try {
    return await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs });
  } catch (e) {
    if (e instanceof WaitForTransactionReceiptTimeoutError) {
      const explorerUrl = profile.explorer ? `${profile.explorer}/tx/${txHash}` : undefined;
      throw new ToolError(
        "TX_TIMEOUT",
        `Transaction ${txHash} did not confirm within ${timeoutMs}ms. It may still land — do NOT resubmit (nonce conflict). The trade was already recorded as 'pending' in history.`,
        {
          details: { txHash, chain: profile.name, timeoutMs, explorerUrl },
          nextActions: [
            {
              tool: "reconcile",
              // Iter601: scope the reconcile to this specific chain so an agent on a
              // multi-chain workflow doesn't trigger a full multi-chain walk for one
              // pending row. Reconcile's chain filter is opt-in (defaults to all);
              // supplying it cuts unnecessary RPC roundtrips.
              params: { chain: profile.name },
              reason: `Wait ~30s, then run reconcile (scoped to ${profile.name}) to query the chain and update the pending row to its final status (success/failed/still-pending).`,
            },
            {
              tool: "viewTx",
              // Param name matches the MCP/CLI tool schema (txHash, not hash). Pre-iter150
              // an agent that mechanically applied this hint would have hit a zod
              // validation failure because the schema's field is `txHash`.
              // Iter601: include chain so viewTx scans the right chain — pre-iter601 the
              // tool defaulted to the active chain, which can differ from the chain the
              // tx was sent on for multi-chain agent workflows. Same iter531 pattern.
              params: { txHash, chain: profile.name },
              reason: "Optional: inspect the tx directly to see if it has landed since.",
            },
          ],
        },
      );
    }
    throw e;
  }
}
