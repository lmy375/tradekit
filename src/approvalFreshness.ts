// Iter617: scan on-chain Approval events to surface the AGE of each standing
// approval. Pre-iter617 iter606's audit ranked approvals by amount + spender
// + token blacklist — but treated a 2-year-old forgotten "set and forget"
// infinite approval the same as one granted yesterday. In practice old
// approvals to long-abandoned routers are higher-risk: the operator has
// forgotten they exist, the spender contract may have been exploited since
// the grant, and the operator's threat surface is whatever those contracts
// are doing TODAY (which may be different from grant-day).
//
// Implementation:
//   - eth_getLogs for Approval events where the owner is `wallet`. Chunked
//     across block ranges via iter607's chunkBlockRange.
//   - Group by (token, spender), keep the MOST RECENT event per pair.
//   - Annotate with the block timestamp via getBlock (best-effort cached).
//   - Return Map<lowerToken + lowerSpender, FreshnessEntry>.
//
// Limits:
//   - Default lookback is 90 days (configurable). Approvals older than the
//     lookback don't appear in the map — the iter606 audit interprets the
//     ABSENCE as "older than Nd" rather than "missing data".
//   - eth_getLogs has RPC range limits (~10k blocks for many free public
//     RPCs). chunkSize defaults to 5000 (same as iter607).

import type { Address, Hex, PublicClient, Transport, Chain } from "viem";
import type { ChainProfile } from "./chains.js";
import type { Logger } from "./logger.js";
import { chunkBlockRange, DEFAULT_CHUNK_SIZE } from "./activitySync.js";

/** ERC20 Approval(owner, spender, value) — keccak256("Approval(address,address,uint256)") */
const APPROVAL_TOPIC: Hex = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

export interface FreshnessEntry {
  /** Token contract address (lowercased). */
  token: string;
  /** Spender address (lowercased). */
  spender: string;
  /** Block number of the most recent Approval event found. */
  blockNumber: number;
  /** Block timestamp (ISO). Undefined when the timestamp fetch failed. */
  timestamp?: string;
  /** Tx hash of the most recent grant. */
  txHash: string;
}

export interface FreshnessScanReport {
  chain: string;
  owner: Address;
  fromBlock: bigint;
  toBlock: bigint;
  /** ISO timestamp the scan started — for "as-of" reporting. */
  scannedAt: string;
  /** Number of Approval events found (raw, before dedup). */
  rawEventCount: number;
  /** One entry per unique (token, spender) — most recent grant. */
  entries: FreshnessEntry[];
  /** Per-chunk getLogs failures (typically RPC range-cap). Doesn't abort. */
  chunkErrors: Array<{ fromBlock: string; toBlock: string; message: string }>;
}

/**
 * Iter617: pure log-grouping. Given the raw log entries (from eth_getLogs),
 * group by (token, spender) keeping the latest block-number per pair.
 *
 * Approval event encoding: topic[0]=APPROVAL_TOPIC, topic[1]=owner padded,
 * topic[2]=spender padded, data=value (uint256). We don't need the value —
 * just the FACT that an Approval was emitted at block N → that's the grant
 * timestamp signal.
 *
 * Exported for unit testing without HTTP.
 */
export function groupApprovalLogs(
  logs: Array<{
    address: string;
    blockNumber: number | bigint | string;
    transactionHash: string | null;
    topics: readonly Hex[];
  }>,
): Map<string, FreshnessEntry> {
  const map = new Map<string, FreshnessEntry>();
  for (const log of logs) {
    if (log.topics.length < 3) continue; // malformed — defensive
    if (!log.transactionHash) continue;
    // topic[2] is the spender, padded to 32 bytes. Strip the leading 12 bytes.
    const spenderTopic = log.topics[2];
    if (!spenderTopic || spenderTopic.length !== 66) continue;
    const spender = ("0x" + spenderTopic.slice(26)).toLowerCase();
    const token = log.address.toLowerCase();
    const key = `${token}:${spender}`;
    // Normalize blockNumber across the three shapes a raw RPC might return.
    const blockNumber =
      typeof log.blockNumber === "bigint"
        ? Number(log.blockNumber)
        : typeof log.blockNumber === "string"
          ? parseInt(log.blockNumber, 16) || parseInt(log.blockNumber, 10)
          : log.blockNumber;
    if (!Number.isFinite(blockNumber)) continue;
    const existing = map.get(key);
    if (!existing || blockNumber > existing.blockNumber) {
      map.set(key, {
        token,
        spender,
        blockNumber,
        txHash: log.transactionHash,
      });
    }
  }
  return map;
}

/**
 * Encode an address as a 32-byte left-padded log topic. Same helper iter607
 * uses; duplicated here to avoid a circular import (the iter607 version is
 * private to activitySync.ts).
 */
function addressTopic(addr: Address): Hex {
  return `0x000000000000000000000000${addr.slice(2).toLowerCase()}` as Hex;
}

/**
 * Scan Approval events emitted by `owner` (topic[1] = owner) across the
 * specified block range. Chunks via iter607's chunker. Per-chunk failures
 * accumulate in chunkErrors[] without aborting.
 *
 * After the scan, annotate each entry with the block's timestamp via getBlock
 * (parallelized). Timestamps are best-effort — when the timestamp fetch fails
 * (RPC pruned the block, etc.) the entry still appears with `timestamp` undefined.
 */
export async function scanApprovalFreshness(args: {
  publicClient: PublicClient<Transport, Chain>;
  profile: ChainProfile;
  owner: Address;
  fromBlock: bigint;
  toBlock: bigint;
  logger: Logger;
  chunkSize?: bigint;
}): Promise<FreshnessScanReport> {
  const chunks = chunkBlockRange(args.fromBlock, args.toBlock, args.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const ownerTopic = addressTopic(args.owner);

  args.logger.info(
    `Approval freshness scan on ${args.profile.name} for ${args.owner}: blocks ${args.fromBlock}-${args.toBlock} in ${chunks.length} chunk(s)`,
  );

  const allLogs: Array<{
    address: string;
    blockNumber: number | bigint | string;
    transactionHash: string | null;
    topics: readonly Hex[];
  }> = [];
  const chunkErrors: FreshnessScanReport["chunkErrors"] = [];

  // Serial chunk processing — same rate-limit-friendly pattern iter607 uses.
  // Approval events are FAR less common than Transfer events so a 5000-block
  // chunk typically returns just a few logs.
  for (const c of chunks) {
    try {
      const blockToHex = (b: bigint): Hex => `0x${b.toString(16)}`;
      const raw = (await args.publicClient.request({
        method: "eth_getLogs",
        params: [
          {
            fromBlock: blockToHex(c.fromBlock),
            toBlock: blockToHex(c.toBlock),
            topics: [APPROVAL_TOPIC, ownerTopic],
          },
        ],
      })) as Array<{
        address: string;
        blockNumber: string;
        transactionHash: string | null;
        topics: Hex[];
      }>;
      allLogs.push(...raw);
      args.logger.debug(`Approval freshness chunk ${c.fromBlock}-${c.toBlock}: ${raw.length} events`);
    } catch (e) {
      const message = (e as Error).message;
      chunkErrors.push({
        fromBlock: c.fromBlock.toString(),
        toBlock: c.toBlock.toString(),
        message,
      });
      args.logger.warn(`Approval freshness chunk ${c.fromBlock}-${c.toBlock} failed: ${message}`);
    }
  }

  const grouped = groupApprovalLogs(allLogs);
  const entries = [...grouped.values()];

  // Fetch block timestamps for each unique block (de-dup across entries that
  // share a block). Parallel for speed; per-block failure → entry stays with
  // undefined timestamp.
  const uniqueBlocks = Array.from(new Set(entries.map((e) => e.blockNumber)));
  const blockTimestamps = new Map<number, string>();
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      try {
        const block = await args.publicClient.getBlock({ blockNumber: BigInt(bn) });
        if (block?.timestamp) {
          blockTimestamps.set(bn, new Date(Number(block.timestamp) * 1000).toISOString());
        }
      } catch (e) {
        args.logger.debug(`Approval freshness: failed to fetch block ${bn} timestamp: ${(e as Error).message}`);
      }
    }),
  );

  for (const e of entries) {
    const ts = blockTimestamps.get(e.blockNumber);
    if (ts) e.timestamp = ts;
  }

  return {
    chain: args.profile.name,
    owner: args.owner,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    scannedAt: new Date().toISOString(),
    rawEventCount: allLogs.length,
    entries,
    chunkErrors,
  };
}

/**
 * Iter617: human-readable age from a timestamp. Returns strings like:
 *   "12d ago" / "3h ago" / "5m ago" / "just now"
 * Pure — exported for tests + reuse.
 */
export function formatAgo(timestamp: string, nowMs: number = Date.now()): string {
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return "?";
  const diffMs = nowMs - t;
  if (diffMs < 0) return "in the future"; // clock skew / future-dated
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}
