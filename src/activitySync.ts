// Iter607: wallet activity sync — backfill the local trades DB from on-chain
// history. Closes the most-asked production gap: pre-iter607, operators with
// significant on-chain history (Uniswap UI swaps, MEV bot trades, custom-router
// activity) had no way to bring those into tradekit's PnL view. `import_trade`
// works one tx at a time — useless for backfilling 50+ historical trades.
//
// Strategy:
//   1. eth_getLogs for Transfer events where the wallet is `from` OR `to`.
//   2. Group the log entries by tx hash (multiple Transfer events in one tx is
//      the swap signature: sent X, received Y).
//   3. For each unique tx hash, call existing importTradeFromTx — which already
//      decodes the receipt, classifies as swap/transfer, and persists to DB.
//      Idempotent on tx_hash, so re-runs are safe.
//
// Block-range chunking: public RPCs typically cap eth_getLogs at 10k blocks
// per request. We split the requested range into chunks of `chunkSize` (default
// 5000 for headroom) and union the results.
//
// Failure handling:
//   - Per-chunk failures (one chunk's getLogs throws) accumulate in errors[]
//     without aborting the whole sync. The successful chunks' txs still import.
//   - Per-tx import failures (e.g. TX_NOT_FOUND for a tx whose receipt the RPC
//     forgot) accumulate in errors[] too; other txs in the same sync still go.

import type { Address, Hex, PublicClient, Transport, Chain } from "viem";
import type { ChainProfile } from "./chains.js";
import type { Logger } from "./logger.js";
import { importTradeFromTx } from "./importTrade.js";
import { getSyncBookmark, setSyncBookmark } from "./db.js";

/** Same TRANSFER_TOPIC constant decodeTx.ts uses. Topic[0] of every ERC20 Transfer event. */
const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Default eth_getLogs chunk size. Conservative — public RPCs often cap at 10k. */
export const DEFAULT_CHUNK_SIZE = 5_000n;

export interface SyncReport {
  chain: string;
  owner: Address;
  fromBlock: bigint;
  toBlock: bigint;
  /** Number of distinct tx hashes the scan found. */
  scannedTxCount: number;
  /** Successfully imported (new rows in trades). */
  inserted: number;
  /** Skipped because already in DB. */
  duplicates: number;
  /** Skipped because not classifiable as a trade (e.g. pure transfers, status pending). */
  skipped: number;
  /** Per-tx import failures (TX_NOT_FOUND for a hash whose receipt RPC dropped, etc). */
  errors: Array<{ txHash: `0x${string}`; message: string }>;
  /** Per-chunk getLogs failures (typically RPC range-cap exceeded). */
  chunkErrors: Array<{ fromBlock: string; toBlock: string; message: string }>;
  timestamp: string;
  /** Iter736: wall-clock duration of the sync (eth_getLogs across all chunks + per-tx
   *  receipt fetches + decode + persist). Symmetric with iter725/727/728 elapsedMs
   *  on reconcile/pnl/portfolio. trades_sync is the slowest CLI command (RPC-heavy
   *  log scanning + receipt fetches), so the timing feeds three operator workflows:
   *  (1) capacity planning ("if I add 5 more accounts the cron will take ~5×"),
   *  (2) RPC provider comparison (same range, two providers, pick the faster),
   *  (3) anomaly detection (usual 30s → today 5min flags RPC degradation). Optional
   *  for back-compat — pre-iter736 consumers that don't read the field are unaffected. */
  elapsedMs?: number;
  /** Iter806: worst-bucket severity. "warn" on any chunkErrors[] (RPC
   *  range-cap, rate-limit) OR errors[] (per-tx import failures); "ok"
   *  otherwise. Symmetric with iter801/804 severity fields. Always
   *  present. */
  severity: "ok" | "warn";
  /** Iter832: structured dispatch. chunkErrors[] → suggest re-running sync
   *  (bookmark stays pinned per iter738, dedup makes retry safe).
   *  errors[] → suggest diagnosing the affected tx hashes. Always present
   *  (empty on a clean sync). Symmetric with iter829-831. */
  recommendedActions: import("./errors.js").NextAction[];
  /** Iter738: bookmark resume metadata. Present when the CLI/MCP orchestrator
   *  used a stored sync_bookmark to compute fromBlock OR advanced the bookmark
   *  after a fully successful scan. Absent when the operator passed an
   *  explicit --from-block / --since-days OR opted out via --no-bookmark.
   *  Internal types are bigint to match the rest of the report; the CLI/MCP
   *  JSON serializer converts to decimal-string at the boundary. */
  bookmark?: {
    /** Was the bookmark consulted to derive fromBlock? false = explicit-override or opt-out path. */
    used: boolean;
    /** When used=true, the block we resumed from (= stored bookmark + 1). */
    resumedFromBlock?: bigint;
    /** Present only on advancement — i.e. chunkErrors.length === 0 so the bookmark
     *  moved to toBlock. Absent on partial-failure runs to communicate "no
     *  advancement happened, retry will rescan the same window". */
    advancedToBlock?: bigint;
  };
}

/**
 * Iter607: pure block-range chunker. Splits a [from, to] inclusive range into
 * chunks of at most `chunkSize` blocks each. Returns an empty array when
 * from > to (caller should treat as no-op).
 *
 * The last chunk may be smaller than chunkSize if the range doesn't divide
 * evenly. Both endpoints inclusive: chunk[i].toBlock + 1 = chunk[i+1].fromBlock.
 *
 * Exported for unit testing — the math here is a common source of off-by-one
 * bugs and warrants a pin.
 */
export function chunkBlockRange(
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint = DEFAULT_CHUNK_SIZE,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (fromBlock > toBlock) return [];
  if (chunkSize <= 0n) {
    throw new Error(`chunkSize must be positive (got ${chunkSize})`);
  }
  const chunks: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    // chunkSize blocks INCLUSIVE means cursor + chunkSize - 1.
    const end = cursor + chunkSize - 1n;
    chunks.push({ fromBlock: cursor, toBlock: end > toBlock ? toBlock : end });
    cursor = end + 1n;
  }
  return chunks;
}

/**
 * Encode an address as a 32-byte log topic (0x-prefixed, 64 hex chars, leading
 * zeros pad the address). topic[1] and topic[2] of a Transfer event hold the
 * `from` and `to` addresses in this encoding.
 */
function addressTopic(addr: Address): Hex {
  return `0x000000000000000000000000${addr.slice(2).toLowerCase()}` as Hex;
}

/**
 * Iter607: pure log-grouping helper. Takes an array of raw logs and returns
 * the set of distinct tx hashes. Used to fan out from "raw Transfer events"
 * to "unique txs to decode" without re-fetching logs per tx.
 *
 * Preserves first-seen order so the sync's import phase processes txs in the
 * order they appeared on-chain (older-block first). This matters for PnL
 * accounting because trades imported later are filed under their BLOCK
 * timestamp anyway, but the deterministic order helps operators eyeball the
 * sync log against an explorer.
 */
export function uniqueTxHashes(
  logs: Array<{ transactionHash: `0x${string}` | null }>,
): `0x${string}`[] {
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const log of logs) {
    if (!log.transactionHash) continue;
    const lower = log.transactionHash.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(log.transactionHash);
  }
  return out;
}

/**
 * Scan eth_getLogs for Transfer events involving `owner` (as either sender or
 * recipient) across the [fromBlock, toBlock] range, then import each unique tx
 * via importTradeFromTx.
 *
 * Two eth_getLogs calls per chunk: one with topic[1]=owner (outgoing transfers,
 * Uniswap pull-and-swap pattern), one with topic[2]=owner (incoming transfers,
 * the swap output). We could query both at once with topic-or syntax, but not
 * all RPC providers support the OR shape — two requests is the portable path.
 */
export async function scanWalletActivity(args: {
  publicClient: PublicClient<Transport, Chain>;
  profile: ChainProfile;
  owner: Address;
  fromBlock: bigint;
  toBlock: bigint;
  account: string;
  logger: Logger;
  chunkSize?: bigint;
}): Promise<SyncReport> {
  // Iter736: wall-clock timer. Wrap the entire sync — both phases (getLogs
  // across chunks AND per-tx receipt fetch + decode) contribute to user-visible
  // latency, so the timer encloses both.
  const t0 = Date.now();
  const chunks = chunkBlockRange(args.fromBlock, args.toBlock, args.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const ownerTopic = addressTopic(args.owner);

  args.logger.info(
    `Activity sync on ${args.profile.name} for ${args.owner}: scanning blocks ${args.fromBlock}-${args.toBlock} in ${chunks.length} chunk(s)`,
  );

  // Iter773: periodic info-level progress for long scans. Per-chunk lines are
  // debug-only (per-line at info would flood logs for normal short scans),
  // but operators tail-watching a multi-minute backfill saw no progress
  // between the initial "scanning N chunks" line and the post-scan summary.
  // Emit at ~25% intervals when chunks.length >= 8 — small scans skip
  // progress entirely; long ones get ~3-4 status pings without spam.
  const progressInterval =
    chunks.length >= 8 ? Math.ceil(chunks.length / 4) : Number.POSITIVE_INFINITY;

  const allLogs: Array<{ transactionHash: `0x${string}` | null }> = [];
  const chunkErrors: SyncReport["chunkErrors"] = [];

  // Process chunks SERIALLY — public RPCs often rate-limit eth_getLogs heavily
  // and parallelism can trip those limits. The serial path keeps the sync
  // predictable + lets us surface progress per chunk in the logger.
  let chunkIndex = 0;
  for (const c of chunks) {
    chunkIndex++;
    try {
      // Two requests per chunk: outgoing (topic[1] = owner) and incoming
      // (topic[2] = owner). A single tx where owner is BOTH from and to (rare
      // — self-transfer or wrapped-call) appears in both result sets but the
      // uniqueTxHashes helper dedupes downstream.
      // viem's typed getLogs requires `event` (a parsed ABI item) — too narrow
      // for our topic-based filter where we want any contract that emits
      // standard ERC20 Transfer. Drop to raw eth_getLogs via the JSON-RPC
      // request method so we can pass topics directly. The response shape
      // matches viem's Log type closely enough that uniqueTxHashes just looks
      // at .transactionHash.
      const blockToHex = (b: bigint): Hex => `0x${b.toString(16)}`;
      const rawOutgoing = (await args.publicClient.request({
        method: "eth_getLogs",
        params: [{
          fromBlock: blockToHex(c.fromBlock),
          toBlock: blockToHex(c.toBlock),
          topics: [TRANSFER_TOPIC, ownerTopic],
        }],
      })) as Array<{ transactionHash: `0x${string}` | null }>;
      const rawIncoming = (await args.publicClient.request({
        method: "eth_getLogs",
        params: [{
          fromBlock: blockToHex(c.fromBlock),
          toBlock: blockToHex(c.toBlock),
          topics: [TRANSFER_TOPIC, null, ownerTopic],
        }],
      })) as Array<{ transactionHash: `0x${string}` | null }>;
      allLogs.push(...rawOutgoing, ...rawIncoming);
      args.logger.debug(
        `Activity sync chunk ${c.fromBlock}-${c.toBlock}: ${rawOutgoing.length} outgoing + ${rawIncoming.length} incoming`,
      );
      // Iter773: info-level progress ping every progressInterval chunks (or
      // on the final chunk so operators see "44/44 done" before the import
      // phase kicks off). Skipped entirely on short scans (chunks.length <
      // 8) where the initial + per-tx info already gives sufficient signal.
      if (
        chunks.length >= 8 &&
        (chunkIndex % progressInterval === 0 || chunkIndex === chunks.length)
      ) {
        args.logger.info(
          `Activity sync progress: chunk ${chunkIndex}/${chunks.length} (block ${c.fromBlock}-${c.toBlock})`,
        );
      }
    } catch (e) {
      const message = (e as Error).message;
      chunkErrors.push({
        fromBlock: c.fromBlock.toString(),
        toBlock: c.toBlock.toString(),
        message,
      });
      args.logger.warn(
        `Activity sync chunk ${c.fromBlock}-${c.toBlock} failed: ${message}`,
      );
    }
  }

  const txs = uniqueTxHashes(allLogs);
  args.logger.info(`Activity sync found ${txs.length} unique tx${txs.length === 1 ? "" : "es"} to inspect`);

  let inserted = 0;
  let duplicates = 0;
  let skipped = 0;
  const errors: SyncReport["errors"] = [];

  // Iter791: periodic info-level progress for the per-tx import phase.
  // Same threshold + ~25% cadence as iter773's chunk progress — operators
  // tail-watching a 50+ tx backfill saw silence between "found N unique txes
  // to inspect" and the final summary. Per-tx receipt fetches + decode are
  // ~200ms each on a typical RPC, so 50 txs = ~10s; 200 txs = ~40s — long
  // enough to need liveness.
  const importInterval =
    txs.length >= 8 ? Math.ceil(txs.length / 4) : Number.POSITIVE_INFINITY;

  let importIndex = 0;
  for (const txHash of txs) {
    importIndex++;
    try {
      const result = await importTradeFromTx(args.publicClient, args.profile, txHash, args.account, args.logger);
      if (result.status === "inserted") inserted++;
      else if (result.status === "duplicate") duplicates++;
      else skipped++;
    } catch (e) {
      const message = (e as Error).message;
      errors.push({ txHash, message });
      args.logger.warn(`Activity sync import ${txHash} failed: ${message}`);
    }
    // Tick AFTER outcome so the message reflects what was actually done.
    if (
      txs.length >= 8 &&
      (importIndex % importInterval === 0 || importIndex === txs.length)
    ) {
      args.logger.info(
        `Activity sync import progress: ${importIndex}/${txs.length} (last: ${txHash.slice(0, 10)}…)`,
      );
    }
  }

  // Iter832: structured dispatch list — empty by default, populated when
  // errors fired.
  const recommendedActions: import("./errors.js").NextAction[] = [];
  if (chunkErrors.length > 0) {
    recommendedActions.push({
      tool: "sync_trades",
      params: { chain: args.profile.name, account: args.account },
      reason: `${chunkErrors.length} chunk${chunkErrors.length === 1 ? "" : "s"} failed during scan (bookmark not advanced) — re-run is safe; iter738 dedup absorbs duplicates.`,
    });
  }
  if (errors.length > 0) {
    recommendedActions.push({
      tool: "recent_trades",
      params: { account: args.account, tx_hash: errors[0].txHash },
      reason: `${errors.length} per-tx import error${errors.length === 1 ? "" : "s"} during sync — inspect the failing tx${errors.length === 1 ? "" : "es"} (first: ${errors[0].txHash.slice(0, 10)}…).`,
    });
  }
  return {
    chain: args.profile.name,
    owner: args.owner,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    scannedTxCount: txs.length,
    inserted,
    duplicates,
    skipped,
    errors,
    chunkErrors,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    // Iter806: severity from chunk + per-tx error counts.
    severity: chunkErrors.length > 0 || errors.length > 0 ? "warn" : "ok",
    recommendedActions,
  };
}

/**
 * Iter738: bookmark-aware fromBlock resolver. Pure on its inputs, performs a
 * single DB lookup for the bookmark (no writes). Returns the effective
 * fromBlock plus metadata so the caller can render "Resuming from block N"
 * messages and decide whether to call advanceBookmarkAfterSync.
 *
 * Resolution priority (highest first):
 *   1. explicitFromBlock present → use it. Operator override; bookmark ignored.
 *   2. sinceDaysExplicit set → 30d-style lookback at that depth, bookmark ignored.
 *      Operators passing --since-days clearly want a wider rescan.
 *   3. useBookmark === false → default 30d lookback, bookmark ignored. The
 *      --no-bookmark escape hatch (e.g. for forensic re-import).
 *   4. bookmark exists for (chain, account, owner) → fromBlock = bookmark + 1.
 *      The +1 avoids re-scanning the boundary block (dedup would absorb it,
 *      but skipping it saves RPC cost).
 *   5. fallback → 30d lookback. First-time sync.
 *
 * The DEFAULT_SINCE_DAYS constant is duplicated here from the CLI's literal
 * "30" so the helper has one source of truth.
 */
export const DEFAULT_SINCE_DAYS = 30;
const BLOCKS_PER_DAY_AT_12S = (24n * 60n * 60n) / 12n; // 7200

function computeSinceLookback(toBlock: bigint, days: number): bigint {
  const lookback = BLOCKS_PER_DAY_AT_12S * BigInt(days);
  return toBlock > lookback ? toBlock - lookback : 0n;
}

export function resolveBookmarkAwareFromBlock(args: {
  chain: string;
  account: string;
  owner: Address;
  toBlock: bigint;
  explicitFromBlock?: bigint;
  sinceDaysExplicit?: number;
  useBookmark: boolean;
}): { fromBlock: bigint; bookmarkUsed: boolean; resumedFromBlock?: bigint } {
  if (args.explicitFromBlock != null) {
    return { fromBlock: args.explicitFromBlock, bookmarkUsed: false };
  }
  if (args.sinceDaysExplicit != null) {
    return { fromBlock: computeSinceLookback(args.toBlock, args.sinceDaysExplicit), bookmarkUsed: false };
  }
  if (!args.useBookmark) {
    return { fromBlock: computeSinceLookback(args.toBlock, DEFAULT_SINCE_DAYS), bookmarkUsed: false };
  }
  const bm = getSyncBookmark(args.chain, args.account, args.owner);
  if (bm) {
    const resumed = bm.lastSyncedBlock + 1n;
    return { fromBlock: resumed, bookmarkUsed: true, resumedFromBlock: resumed };
  }
  return { fromBlock: computeSinceLookback(args.toBlock, DEFAULT_SINCE_DAYS), bookmarkUsed: false };
}

/**
 * Iter738: bookmark advancement after a sync. Writes the bookmark only when
 * the sync was FULLY successful (no chunkErrors). A partial-failure leaves the
 * bookmark pinned so the operator's next retry rescans the failed range
 * (dedup absorbs the duplicate trades, and we avoid silently skipping blocks
 * a failed chunk would have covered).
 *
 * Per-tx errors (errors[]) DO NOT block advancement — those represent txs
 * the chunk did surface but couldn't decode (e.g. TX_NOT_FOUND mid-scan).
 * The eth_getLogs scan of the range was still complete, so advancing is safe;
 * the operator handles the per-tx failures via the errors[] list.
 *
 * Returns the new bookmark block on advancement, undefined otherwise.
 */
export function advanceBookmarkAfterSync(args: {
  chain: string;
  account: string;
  owner: Address;
  toBlock: bigint;
  chunkErrors: SyncReport["chunkErrors"];
}): bigint | undefined {
  if (args.chunkErrors.length > 0) return undefined;
  setSyncBookmark(args.chain, args.account, args.owner, args.toBlock);
  return args.toBlock;
}

/**
 * Iter742: coarse chain → seconds-per-block table for UX time approximations.
 * Used to translate "N blocks behind tip" into "~Xh / Xd behind tip" on the
 * sync resume line — operators eyeball whether the catch-up sync will be a
 * minute (caught up) or hours (long gap after a stopped cron).
 *
 * Conservative bias: when a chain isn't listed we default to 2s (the modern
 * L2 baseline) since that's where ~95% of tradekit usage lives. Mis-mapping
 * means the time hint is off by ~6× for ethereum L1, which is acceptable for
 * a hint — operators familiar with their chain mentally adjust. The
 * authoritative block-range math elsewhere (resolveBookmarkAware, the
 * since-days lookback) stays on the existing 12s ceiling for correctness.
 */
export function approxBlockTimeSeconds(chain: string): number {
  switch (chain.toLowerCase()) {
    case "ethereum":
    case "mainnet":
      return 12;
    case "bsc":
    case "bnbchain":
      return 3;
    default:
      // base, optimism, arbitrum, polygon, etc — all ~2s.
      return 2;
  }
}

/**
 * Iter742: compact age hint for a block gap. Hours when < 1d, days otherwise.
 * Returns null when the gap is negligible (≤300s ≈ 5min) — bookmark caught
 * up to within a few minutes of tip; printing "behind by 0.1h" is noise.
 */
export function formatBlocksBehindHint(
  gapBlocks: bigint,
  chain: string,
): string | null {
  if (gapBlocks <= 0n) return null;
  const seconds = Number(gapBlocks) * approxBlockTimeSeconds(chain);
  if (seconds < 300) return null;
  if (seconds < 86_400) {
    return `~${(seconds / 3600).toFixed(1)}h behind tip`;
  }
  return `~${(seconds / 86_400).toFixed(1)}d behind tip`;
}

// Iter607: exported for unit testing — `addressTopic` is a small but
// boundary-sensitive helper (32-byte left-pad of an address).
export const __testing = { addressTopic };
