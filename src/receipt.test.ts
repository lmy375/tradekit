// Tests for the receipt-wait helper. We can't ergonomically spin up a real chain in
// unit tests, so we drive the helper with a stub publicClient that mimics viem's
// behaviour — including throwing WaitForTransactionReceiptTimeoutError when asked.
// The contract being tested: timeout error → TX_TIMEOUT with explorer URL + a "check
// status" nextAction (so an agent never blindly re-fires the tx and bricks its nonce).

import { describe, it, expect } from "vitest";
import { WaitForTransactionReceiptTimeoutError } from "viem";
import { waitForReceiptWithTimeout } from "./receipt.js";
import { ToolError } from "./errors.js";
import type { ChainProfile } from "./chains.js";

const FAKE_PROFILE = {
  name: "base",
  chainId: 8453,
  rpcs: ["https://example"],
  explorer: "https://basescan.org",
  nativeSymbol: "ETH",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  tokens: {},
  aggregators: [],
  viemChain: { id: 8453 } as never,
} as unknown as ChainProfile;

function makeStubClient(handler: (h: string) => Promise<unknown>) {
  return { waitForTransactionReceipt: ({ hash }: { hash: string }) => handler(hash) } as never;
}

describe("waitForReceiptWithTimeout", () => {
  it("returns the receipt on success (passes through the underlying call)", async () => {
    const receipt = { status: "success", blockNumber: 100n, gasUsed: 21000n };
    const client = makeStubClient(async () => receipt);
    const r = await waitForReceiptWithTimeout(client, "0xabc" as `0x${string}`, FAKE_PROFILE, 1000);
    expect(r).toBe(receipt);
  });

  it("translates viem timeout → TX_TIMEOUT with explorer URL and reconcile-first nextActions", async () => {
    const client = makeStubClient(async () => {
      throw new WaitForTransactionReceiptTimeoutError({ hash: "0xdeadbeef" as `0x${string}` });
    });
    try {
      await waitForReceiptWithTimeout(client, "0xdeadbeef" as `0x${string}`, FAKE_PROFILE, 50);
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err).toBeInstanceOf(ToolError);
      expect(err.code).toBe("TX_TIMEOUT");
      expect(err.details?.txHash).toBe("0xdeadbeef");
      expect(err.details?.explorerUrl).toBe("https://basescan.org/tx/0xdeadbeef");
      // Primary action is reconcile — it updates the DB row, not just inspects the tx.
      expect(err.nextActions?.[0].tool).toBe("reconcile");
      expect(err.nextActions?.[1].tool).toBe("viewTx");
      // The message must steer the agent away from re-sending the tx (nonce conflict)
      // AND mention that the trade is already in history as pending.
      expect(err.message).toMatch(/do NOT resubmit/i);
      expect(err.message).toMatch(/pending/i);
    }
  });

  it("rethrows non-timeout errors unchanged so the original stack remains debuggable", async () => {
    const orig = new Error("RPC 500");
    const client = makeStubClient(async () => {
      throw orig;
    });
    await expect(
      waitForReceiptWithTimeout(client, "0x1" as `0x${string}`, FAKE_PROFILE, 50),
    ).rejects.toBe(orig);
  });

  it("omits explorerUrl when the profile has none (some custom chains)", async () => {
    const profileNoExplorer = { ...FAKE_PROFILE, explorer: undefined } as unknown as ChainProfile;
    const client = makeStubClient(async () => {
      throw new WaitForTransactionReceiptTimeoutError({ hash: "0x1" as `0x${string}` });
    });
    try {
      await waitForReceiptWithTimeout(client, "0x1" as `0x${string}`, profileNoExplorer, 50);
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("TX_TIMEOUT");
      expect(err.details?.explorerUrl).toBeUndefined();
    }
  });
});
