// Iter617: tests for the pure helpers in approvalFreshness.ts. The HTTP-bound
// `scanApprovalFreshness` is covered indirectly via the CLI smoke tests; the
// log-grouping + age-formatting helpers are pure and tested here without any
// network mock.

import { describe, expect, it } from "vitest";
import { groupApprovalLogs, formatAgo } from "./approvalFreshness.js";
import type { Hex } from "viem";

const APPROVAL_TOPIC: Hex =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

// 32-byte padded address topic helper for tests
function pad(addr: string): Hex {
  return ("0x000000000000000000000000" + addr.slice(2).toLowerCase()) as Hex;
}

const OWNER = "0x1111111111111111111111111111111111111111";
const SPENDER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SPENDER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN_X = "0xcccccccccccccccccccccccccccccccccccccccc";
const TOKEN_Y = "0xdddddddddddddddddddddddddddddddddddddddd";

describe("groupApprovalLogs", () => {
  it("keeps the most recent event per (token, spender) pair", () => {
    const logs = [
      {
        address: TOKEN_X,
        blockNumber: 100,
        transactionHash: "0xtxold",
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_A)],
      },
      {
        address: TOKEN_X,
        blockNumber: 200,
        transactionHash: "0xtxnew",
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_A)],
      },
      // earlier-block event after the later-block one — should still be ignored
      {
        address: TOKEN_X,
        blockNumber: 150,
        transactionHash: "0xtxmid",
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_A)],
      },
    ];
    const grouped = groupApprovalLogs(logs);
    expect(grouped.size).toBe(1);
    const entry = grouped.get(`${TOKEN_X.toLowerCase()}:${SPENDER_A.toLowerCase()}`);
    expect(entry).toBeDefined();
    expect(entry?.blockNumber).toBe(200);
    expect(entry?.txHash).toBe("0xtxnew");
  });

  it("separates entries by spender AND token", () => {
    const logs = [
      {
        address: TOKEN_X,
        blockNumber: 100,
        transactionHash: "0x1",
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_A)],
      },
      {
        address: TOKEN_X,
        blockNumber: 100,
        transactionHash: "0x2",
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_B)],
      },
      {
        address: TOKEN_Y,
        blockNumber: 100,
        transactionHash: "0x3",
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_A)],
      },
    ];
    const grouped = groupApprovalLogs(logs);
    expect(grouped.size).toBe(3);
  });

  it("handles hex-string block numbers (RPC raw shape)", () => {
    const logs = [
      {
        address: TOKEN_X,
        blockNumber: "0x64", // 100 in hex
        transactionHash: "0x1",
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_A)],
      },
      {
        address: TOKEN_X,
        blockNumber: "0xc8", // 200 in hex
        transactionHash: "0x2",
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_A)],
      },
    ];
    const grouped = groupApprovalLogs(logs);
    expect(grouped.get(`${TOKEN_X.toLowerCase()}:${SPENDER_A.toLowerCase()}`)?.blockNumber).toBe(200);
  });

  it("skips malformed logs (missing topics, null tx hash)", () => {
    const logs = [
      // missing topic[2]
      {
        address: TOKEN_X,
        blockNumber: 100,
        transactionHash: "0x1",
        topics: [APPROVAL_TOPIC, pad(OWNER)] as Hex[],
      },
      // null tx hash (pending block)
      {
        address: TOKEN_X,
        blockNumber: 100,
        transactionHash: null,
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_A)],
      },
      // valid
      {
        address: TOKEN_X,
        blockNumber: 100,
        transactionHash: "0xok",
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_B)],
      },
    ];
    const grouped = groupApprovalLogs(logs);
    expect(grouped.size).toBe(1);
  });

  it("lowercases token + spender for stable keys", () => {
    const logs = [
      {
        address: TOKEN_X.toUpperCase(),
        blockNumber: 100,
        transactionHash: "0x1",
        topics: [APPROVAL_TOPIC, pad(OWNER), pad(SPENDER_A.toUpperCase())],
      },
    ];
    const grouped = groupApprovalLogs(logs);
    expect(grouped.has(`${TOKEN_X.toLowerCase()}:${SPENDER_A.toLowerCase()}`)).toBe(true);
  });
});

describe("formatAgo", () => {
  const NOW = Date.parse("2026-05-29T12:00:00Z");

  it("returns 'just now' for <1m", () => {
    expect(formatAgo(new Date(NOW - 30_000).toISOString(), NOW)).toBe("just now");
  });

  it("returns minutes, hours, days, months, years", () => {
    expect(formatAgo(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m ago");
    expect(formatAgo(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe("3h ago");
    expect(formatAgo(new Date(NOW - 12 * 86400_000).toISOString(), NOW)).toBe("12d ago");
    expect(formatAgo(new Date(NOW - 90 * 86400_000).toISOString(), NOW)).toBe("3mo ago");
    expect(formatAgo(new Date(NOW - 400 * 86400_000).toISOString(), NOW)).toBe("1y ago");
  });

  it("handles future timestamps (clock skew)", () => {
    expect(formatAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe("in the future");
  });

  it("returns '?' for malformed timestamps", () => {
    expect(formatAgo("not a date", NOW)).toBe("?");
  });
});
