// Iter607: unit tests for the pure helpers in activitySync.ts. The HTTP-touching
// scanWalletActivity is covered by smoke tests (it needs a live chain); these
// unit tests pin the block-range chunker, log-grouping, and address-topic
// encoding contracts so a regression in the math gets caught fast.
// Iter738: bookmark-resolver + advancement helpers tested here too — they
// touch the DB so we set up a tmp data dir before importing db.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { chunkBlockRange, uniqueTxHashes, DEFAULT_CHUNK_SIZE, scanWalletActivity, __testing } from "./activitySync.js";

// Iter738: tmp data dir for the bookmark helpers that touch the DB. Must be
// set BEFORE the dynamic db import below.
const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-activitysync-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

afterAll(async () => {
  const { closeDb } = await import("./db.js");
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("chunkBlockRange (iter607)", () => {
  it("returns empty when from > to (caller treats as no-op)", () => {
    expect(chunkBlockRange(100n, 50n)).toEqual([]);
  });

  it("returns a single chunk when the range fits in chunkSize", () => {
    const result = chunkBlockRange(100n, 200n, 1000n);
    expect(result).toEqual([{ fromBlock: 100n, toBlock: 200n }]);
  });

  it("returns a single chunk when from === to (single block)", () => {
    expect(chunkBlockRange(500n, 500n, 1000n)).toEqual([{ fromBlock: 500n, toBlock: 500n }]);
  });

  it("splits evenly when (to - from + 1) is a multiple of chunkSize", () => {
    // 10000 blocks total in chunks of 5000 → 2 chunks of exactly 5000.
    const result = chunkBlockRange(0n, 9999n, 5000n);
    expect(result).toEqual([
      { fromBlock: 0n, toBlock: 4999n },
      { fromBlock: 5000n, toBlock: 9999n },
    ]);
  });

  it("trims the last chunk when the range doesn't divide evenly", () => {
    // 7 blocks (0..6) in chunks of 3 → 0-2, 3-5, 6-6.
    const result = chunkBlockRange(0n, 6n, 3n);
    expect(result).toEqual([
      { fromBlock: 0n, toBlock: 2n },
      { fromBlock: 3n, toBlock: 5n },
      { fromBlock: 6n, toBlock: 6n },
    ]);
  });

  it("chunks form a contiguous cover of the range (no gaps, no overlaps)", () => {
    // Property test on a non-trivial range.
    const chunks = chunkBlockRange(1000n, 8999n, 1234n);
    expect(chunks[0].fromBlock).toBe(1000n);
    expect(chunks[chunks.length - 1].toBlock).toBe(8999n);
    for (let i = 0; i + 1 < chunks.length; i++) {
      expect(chunks[i].toBlock + 1n).toBe(chunks[i + 1].fromBlock);
    }
    // Every chunk except possibly the last is exactly chunkSize blocks.
    for (let i = 0; i + 1 < chunks.length; i++) {
      expect(chunks[i].toBlock - chunks[i].fromBlock + 1n).toBe(1234n);
    }
  });

  it("handles realistic 30-day Base scan range with the default chunkSize", () => {
    // 30d × 7200 blocks/day = 216_000 blocks. With chunkSize=5000 → 44 chunks
    // (43 full + 1 tail of 1000).
    const fromBlock = 0n;
    const toBlock = 215_999n;
    const result = chunkBlockRange(fromBlock, toBlock, DEFAULT_CHUNK_SIZE);
    expect(result).toHaveLength(44);
    expect(result[0]).toEqual({ fromBlock: 0n, toBlock: 4999n });
    expect(result[result.length - 1].toBlock).toBe(215_999n);
  });

  it("throws on non-positive chunkSize (operator typo guard)", () => {
    expect(() => chunkBlockRange(0n, 100n, 0n)).toThrow(/chunkSize must be positive/);
    expect(() => chunkBlockRange(0n, 100n, -5n)).toThrow(/chunkSize must be positive/);
  });

  it("uses the default chunkSize when omitted", () => {
    const result = chunkBlockRange(0n, DEFAULT_CHUNK_SIZE - 1n);
    expect(result).toHaveLength(1);
    expect(result[0].toBlock).toBe(DEFAULT_CHUNK_SIZE - 1n);
  });
});

describe("uniqueTxHashes (iter607)", () => {
  it("returns empty for empty input", () => {
    expect(uniqueTxHashes([])).toEqual([]);
  });

  it("deduplicates the same tx hash appearing multiple times (multi-Transfer-in-one-tx)", () => {
    // A typical swap fires 2-4 Transfer events all in one tx. They should
    // collapse to ONE tx hash in the import queue.
    const hash = "0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1" as `0x${string}`;
    const logs = [
      { transactionHash: hash },
      { transactionHash: hash },
      { transactionHash: hash },
    ];
    expect(uniqueTxHashes(logs)).toEqual([hash]);
  });

  it("preserves first-seen order across distinct tx hashes", () => {
    // Order matters: the import phase processes txs in this order so the log
    // output matches what an operator would see on an explorer.
    const hashA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
    const hashB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
    const hashC = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
    const logs = [
      { transactionHash: hashB },
      { transactionHash: hashA },
      { transactionHash: hashB }, // dup — ignored
      { transactionHash: hashC },
      { transactionHash: hashA }, // dup — ignored
    ];
    expect(uniqueTxHashes(logs)).toEqual([hashB, hashA, hashC]);
  });

  it("skips logs with null transactionHash (defensive against weird RPC output)", () => {
    // Some indexers/RPCs return logs with null hash in transient states (e.g.
    // pending blocks). The scanner should silently skip them.
    const hash = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as `0x${string}`;
    const logs = [
      { transactionHash: null },
      { transactionHash: hash },
      { transactionHash: null },
    ];
    expect(uniqueTxHashes(logs)).toEqual([hash]);
  });

  it("case-insensitive dedup on hex hashes (defensive against RPC casing)", () => {
    // RPC returns hashes as lowercase by spec, but some indexers re-case. Dedup
    // must compare case-insensitively or the same swap would be imported twice.
    const lower = "0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1" as `0x${string}`;
    const upper = "0xABC123ABC123ABC123ABC123ABC123ABC123ABC123ABC123ABC123ABC123ABC1" as `0x${string}`;
    const logs = [{ transactionHash: lower }, { transactionHash: upper }];
    const result = uniqueTxHashes(logs);
    expect(result).toHaveLength(1);
  });
});

describe("scanWalletActivity report.elapsedMs (iter736)", () => {
  // The integration path (real RPC) is smoke-tested. This pin uses an empty
  // block range so the function never calls publicClient (chunkBlockRange
  // returns []), letting us assert the elapsedMs contract without mocking RPC.
  it("includes elapsedMs in the report", async () => {
    const noopLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, close: () => {} };
    const report = await scanWalletActivity({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      profile: { name: "test-chain" } as any,
      owner: "0x0000000000000000000000000000000000000001",
      // from > to → empty chunks → no RPC calls made
      fromBlock: 100n,
      toBlock: 50n,
      account: "test",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: noopLogger as any,
    });
    expect(typeof report.elapsedMs).toBe("number");
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    // Sanity check: a no-op sync completes well under 1 second.
    expect(report.elapsedMs).toBeLessThan(1000);
  });
});

describe("resolveBookmarkAwareFromBlock (iter738)", () => {
  const OWNER = "0x1111111111111111111111111111111111111111" as Address;
  const TO = 32_500_000n;
  // 30 days at 7200 blocks/day = 216_000 blocks lookback.
  const DEFAULT_FALLBACK = TO - 216_000n;

  it("explicitFromBlock takes priority over everything (bookmark ignored)", async () => {
    const { resolveBookmarkAwareFromBlock } = await import("./activitySync.js");
    const { setSyncBookmark } = await import("./db.js");
    setSyncBookmark("base", "iter738-explicit", OWNER, 99n);
    const r = resolveBookmarkAwareFromBlock({
      chain: "base",
      account: "iter738-explicit",
      owner: OWNER,
      toBlock: TO,
      explicitFromBlock: 12345n,
      useBookmark: true,
    });
    expect(r).toEqual({ fromBlock: 12345n, bookmarkUsed: false });
  });

  it("sinceDaysExplicit overrides bookmark (operator wants wider rescan)", async () => {
    const { resolveBookmarkAwareFromBlock } = await import("./activitySync.js");
    const { setSyncBookmark } = await import("./db.js");
    setSyncBookmark("base", "iter738-since", OWNER, TO - 100n);
    const r = resolveBookmarkAwareFromBlock({
      chain: "base",
      account: "iter738-since",
      owner: OWNER,
      toBlock: TO,
      sinceDaysExplicit: 7,
      useBookmark: true,
    });
    // 7 days × 7200 = 50_400 lookback
    expect(r.fromBlock).toBe(TO - 50_400n);
    expect(r.bookmarkUsed).toBe(false);
  });

  it("useBookmark=false falls back to 30d default (--no-bookmark path)", async () => {
    const { resolveBookmarkAwareFromBlock } = await import("./activitySync.js");
    const { setSyncBookmark } = await import("./db.js");
    setSyncBookmark("base", "iter738-optout", OWNER, TO - 5n);
    const r = resolveBookmarkAwareFromBlock({
      chain: "base",
      account: "iter738-optout",
      owner: OWNER,
      toBlock: TO,
      useBookmark: false,
    });
    expect(r).toEqual({ fromBlock: DEFAULT_FALLBACK, bookmarkUsed: false });
  });

  it("bookmark present + no overrides → resumes at bookmark+1", async () => {
    const { resolveBookmarkAwareFromBlock } = await import("./activitySync.js");
    const { setSyncBookmark } = await import("./db.js");
    setSyncBookmark("base", "iter738-resume", OWNER, 32_400_000n);
    const r = resolveBookmarkAwareFromBlock({
      chain: "base",
      account: "iter738-resume",
      owner: OWNER,
      toBlock: TO,
      useBookmark: true,
    });
    expect(r.fromBlock).toBe(32_400_001n);
    expect(r.bookmarkUsed).toBe(true);
    expect(r.resumedFromBlock).toBe(32_400_001n);
  });

  it("no bookmark + no overrides → falls back to 30d default (first-time sync)", async () => {
    const { resolveBookmarkAwareFromBlock } = await import("./activitySync.js");
    const r = resolveBookmarkAwareFromBlock({
      chain: "base",
      account: "iter738-firsttime",
      owner: OWNER,
      toBlock: TO,
      useBookmark: true,
    });
    expect(r).toEqual({ fromBlock: DEFAULT_FALLBACK, bookmarkUsed: false });
  });

  it("lookback caps at block 0 (toBlock < 216_000)", async () => {
    const { resolveBookmarkAwareFromBlock } = await import("./activitySync.js");
    const r = resolveBookmarkAwareFromBlock({
      chain: "base",
      account: "iter738-genesis",
      owner: OWNER,
      toBlock: 100_000n,
      useBookmark: true,
    });
    expect(r.fromBlock).toBe(0n);
  });
});

describe("advanceBookmarkAfterSync (iter738)", () => {
  const OWNER = "0x2222222222222222222222222222222222222222" as Address;

  it("advances bookmark on clean sync (no chunk errors)", async () => {
    const { advanceBookmarkAfterSync } = await import("./activitySync.js");
    const { getSyncBookmark } = await import("./db.js");
    const r = advanceBookmarkAfterSync({
      chain: "base",
      account: "iter738-adv",
      owner: OWNER,
      toBlock: 32_600_000n,
      chunkErrors: [],
    });
    expect(r).toBe(32_600_000n);
    expect(getSyncBookmark("base", "iter738-adv", OWNER)?.lastSyncedBlock).toBe(32_600_000n);
  });

  it("does NOT advance when any chunk failed (partial-failure retry safety)", async () => {
    const { advanceBookmarkAfterSync } = await import("./activitySync.js");
    const { setSyncBookmark, getSyncBookmark } = await import("./db.js");
    // Seed a bookmark at a known position.
    setSyncBookmark("base", "iter738-fail", OWNER, 32_500_000n);
    const r = advanceBookmarkAfterSync({
      chain: "base",
      account: "iter738-fail",
      owner: OWNER,
      toBlock: 32_600_000n,
      chunkErrors: [{ fromBlock: "32510000", toBlock: "32515000", message: "rate-limited" }],
    });
    expect(r).toBeUndefined();
    // Bookmark unchanged so retry rescans the same window.
    expect(getSyncBookmark("base", "iter738-fail", OWNER)?.lastSyncedBlock).toBe(32_500_000n);
  });
});

describe("approxBlockTimeSeconds + formatBlocksBehindHint (iter742)", () => {
  it("returns 12s for ethereum/mainnet (canonical L1)", async () => {
    const { approxBlockTimeSeconds } = await import("./activitySync.js");
    expect(approxBlockTimeSeconds("ethereum")).toBe(12);
    expect(approxBlockTimeSeconds("Ethereum")).toBe(12);
    expect(approxBlockTimeSeconds("mainnet")).toBe(12);
  });

  it("returns 3s for bsc", async () => {
    const { approxBlockTimeSeconds } = await import("./activitySync.js");
    expect(approxBlockTimeSeconds("bsc")).toBe(3);
  });

  it("returns 2s default for unknown / L2 chains (base, optimism, arbitrum, polygon)", async () => {
    const { approxBlockTimeSeconds } = await import("./activitySync.js");
    expect(approxBlockTimeSeconds("base")).toBe(2);
    expect(approxBlockTimeSeconds("arbitrum")).toBe(2);
    expect(approxBlockTimeSeconds("unknown-l3")).toBe(2);
  });

  it("returns null hint for zero or negative gap (at or past tip)", async () => {
    const { formatBlocksBehindHint } = await import("./activitySync.js");
    expect(formatBlocksBehindHint(0n, "base")).toBeNull();
    expect(formatBlocksBehindHint(-100n, "base")).toBeNull();
  });

  it("returns null for negligible gaps (<5min on a 2s chain)", async () => {
    const { formatBlocksBehindHint } = await import("./activitySync.js");
    // 100 blocks × 2s = 200s — under the 300s floor.
    expect(formatBlocksBehindHint(100n, "base")).toBeNull();
  });

  it("formats sub-day gaps in hours", async () => {
    const { formatBlocksBehindHint } = await import("./activitySync.js");
    // 7200 blocks × 2s = 14400s = 4h on base
    expect(formatBlocksBehindHint(7200n, "base")).toBe("~4.0h behind tip");
  });

  it("formats >=1d gaps in days", async () => {
    const { formatBlocksBehindHint } = await import("./activitySync.js");
    // 216_000 blocks × 2s = 5.0d on base
    expect(formatBlocksBehindHint(216_000n, "base")).toBe("~5.0d behind tip");
  });

  it("uses 12s per block for ethereum (longer time estimate same block count)", async () => {
    const { formatBlocksBehindHint } = await import("./activitySync.js");
    // 7200 blocks × 12s = 86_400s = 24h = 1.0d on ethereum
    expect(formatBlocksBehindHint(7200n, "ethereum")).toBe("~1.0d behind tip");
  });
});

describe("addressTopic (iter607 internal helper)", () => {
  it("encodes an address as a 32-byte left-padded topic", () => {
    // Standard EIP-20 Transfer topic[1]/[2]: the 20-byte address left-padded to 32 bytes.
    const addr = "0x1234567890123456789012345678901234567890" as Address;
    const topic = __testing.addressTopic(addr);
    expect(topic).toBe("0x0000000000000000000000001234567890123456789012345678901234567890");
    expect(topic.length).toBe(2 + 64); // "0x" + 64 hex chars = 32 bytes
  });

  it("lowercases the address (RPC topic comparison is case-sensitive on some nodes)", () => {
    // A mixed-case checksum address must normalize so eth_getLogs matches
    // events emitted with lowercase topics (the spec-mandated form).
    const addr = "0xABCDef0123456789012345678901234567890123" as Address;
    const topic = __testing.addressTopic(addr);
    expect(topic).toBe("0x000000000000000000000000abcdef0123456789012345678901234567890123");
  });

  it("the zero address is the all-zero topic (used by Transfer for mint/burn)", () => {
    // Mint events show topic[1]=0 (from = 0x0); burn events show topic[2]=0
    // (to = 0x0). The encoding here matches what those events emit.
    const addr = "0x0000000000000000000000000000000000000000" as Address;
    const topic = __testing.addressTopic(addr);
    expect(topic).toBe("0x0000000000000000000000000000000000000000000000000000000000000000");
  });
});
