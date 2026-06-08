// Tests for decodeTx — verifies the pure log-walking heuristic in computeDeltasFromLogs.
// decodeTx itself is a thin wrapper that fetches receipt+tx and feeds them here, so
// covering this function gives us confidence in the swap-classification pipeline.

import { describe, it, expect } from "vitest";
import { computeDeltasFromLogs } from "./decodeTx.js";
import type { Address, Hex } from "viem";

const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WETH_WITHDRAWAL_TOPIC: Hex = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

// 20-byte addresses (lowercased). Helper to build the 32-byte topic form viem returns.
const USER: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROUTER: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USDC: Address = "0xcccccccccccccccccccccccccccccccccccccccc";
const WETH: Address = "0xdddddddddddddddddddddddddddddddddddddddd";

function addrTopic(addr: string): Hex {
  return ("0x" + "0".repeat(24) + addr.replace(/^0x/, "")) as Hex;
}

function uintData(v: bigint): Hex {
  return ("0x" + v.toString(16).padStart(64, "0")) as Hex;
}

function transferLog(token: string, from: string, to: string, value: bigint) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)] as Hex[],
    data: uintData(value),
  };
}

describe("computeDeltasFromLogs", () => {
  it("returns empty map when no logs and no native value", () => {
    const deltas = computeDeltasFromLogs({
      fromAddress: USER,
      txValue: 0n,
      logs: [],
      wethAddress: WETH,
    });
    expect(deltas.size).toBe(0);
  });

  it("debits NATIVE when tx carries a top-level value", () => {
    const deltas = computeDeltasFromLogs({
      fromAddress: USER,
      txValue: 1_000_000_000_000_000n, // 0.001 ETH
      logs: [],
      wethAddress: WETH,
    });
    expect(deltas.get("NATIVE")).toBe(-1_000_000_000_000_000n);
  });

  it("classifies a swap: ETH → USDC via router (user sends ETH, receives USDC)", () => {
    // Pattern: tx.value = 0.001 ETH (debits NATIVE). Router transfers USDC to user.
    const deltas = computeDeltasFromLogs({
      fromAddress: USER,
      txValue: 1_000_000_000_000_000n,
      logs: [transferLog(USDC, ROUTER, USER, 2_073_000n)],
      wethAddress: WETH,
    });
    expect(deltas.get("NATIVE")).toBe(-1_000_000_000_000_000n);
    expect(deltas.get(USDC.toLowerCase())).toBe(2_073_000n);
  });

  it("classifies a swap: USDC → ETH via router with WETH unwrap by user", () => {
    // User sends USDC to router; router sends WETH to user (Transfer); user unwraps (Withdrawal).
    // Net result: USDC out, WETH net-zero (received then burned), NATIVE in.
    const value = 500_000_000_000_000n;
    const deltas = computeDeltasFromLogs({
      fromAddress: USER,
      txValue: 0n,
      logs: [
        transferLog(USDC, USER, ROUTER, 1_000_000n),
        transferLog(WETH, ROUTER, USER, value),
        transferLog(WETH, USER, "0x0000000000000000000000000000000000000000", value),
        {
          address: WETH,
          topics: [WETH_WITHDRAWAL_TOPIC, addrTopic(USER)] as Hex[],
          data: uintData(value),
        },
      ],
      wethAddress: WETH,
    });
    expect(deltas.get(USDC.toLowerCase())).toBe(-1_000_000n);
    expect(deltas.get(WETH.toLowerCase())).toBe(0n); // received then burned
    expect(deltas.get("NATIVE")).toBe(value);
  });

  it("ignores Transfer events where the user is neither sender nor recipient", () => {
    // Internal hop between two routers — shouldn't show up in user's deltas.
    const deltas = computeDeltasFromLogs({
      fromAddress: USER,
      txValue: 0n,
      logs: [
        transferLog(USDC, ROUTER, "0x1111111111111111111111111111111111111111", 999n),
      ],
      wethAddress: WETH,
    });
    expect(deltas.size).toBe(0);
  });

  it("accumulates multiple Transfers of the same token", () => {
    // E.g. a multi-hop swap that touches USDC twice.
    const deltas = computeDeltasFromLogs({
      fromAddress: USER,
      txValue: 0n,
      logs: [
        transferLog(USDC, ROUTER, USER, 500_000n),
        transferLog(USDC, ROUTER, USER, 300_000n),
      ],
      wethAddress: WETH,
    });
    expect(deltas.get(USDC.toLowerCase())).toBe(800_000n);
  });

  it("matches addresses case-insensitively (checksummed vs lowercased)", () => {
    // viem returns checksummed addresses; tx.from may differ in casing from log topic.
    const checksummedUser = "0xAAaAAaAAaAaAaAaAaaaAAAaaAaAaAAaAAaAAaAAA" as Address;
    const deltas = computeDeltasFromLogs({
      fromAddress: checksummedUser,
      txValue: 0n,
      logs: [transferLog(USDC, ROUTER, USER, 100n)],
      wethAddress: WETH,
    });
    expect(deltas.get(USDC.toLowerCase())).toBe(100n);
  });

  it("skips WETH Withdrawal when the burner is not the user (router-on-behalf-of)", () => {
    // Some aggregators unwrap on the user's behalf; we'd need a balance diff to attribute it.
    // The pure decoder must NOT mistakenly credit the user.
    const deltas = computeDeltasFromLogs({
      fromAddress: USER,
      txValue: 0n,
      logs: [
        {
          address: WETH,
          topics: [WETH_WITHDRAWAL_TOPIC, addrTopic(ROUTER)] as Hex[],
          data: uintData(1_000_000_000_000_000n),
        },
      ],
      wethAddress: WETH,
    });
    expect(deltas.size).toBe(0);
  });

  it("skips Withdrawal events from a contract that isn't the configured WETH", () => {
    // A token with a coincidentally-matching topic shouldn't trigger native credit.
    const fakeWeth = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const deltas = computeDeltasFromLogs({
      fromAddress: USER,
      txValue: 0n,
      logs: [
        {
          address: fakeWeth,
          topics: [WETH_WITHDRAWAL_TOPIC, addrTopic(USER)] as Hex[],
          data: uintData(1n),
        },
      ],
      wethAddress: WETH,
    });
    expect(deltas.size).toBe(0);
  });

  it("ignores logs with no topics", () => {
    const deltas = computeDeltasFromLogs({
      fromAddress: USER,
      txValue: 0n,
      logs: [{ address: USDC, topics: [] as Hex[], data: uintData(1n) }],
      wethAddress: WETH,
    });
    expect(deltas.size).toBe(0);
  });
});
