import { createPublicClient, formatUnits, type Hex } from "viem";
import { resolveProfile } from "./config.js";
import { listChains, makeTransport } from "./chains.js";
import { pendingTrades, updateTradeStatus, type TradeRow } from "./db.js";
import { compactMessage } from "./format.js";
import type { Config } from "./config.js";
import { sanitizeForLogLine, type Logger } from "./logger.js";

/**
 * Iter775: shared progress ticker for backfill operations. Extracts the
 * pattern iter774 introduced inline in backfillBlockNumbers so the other
 * three backfills (slippage / gas-usd / revert-reason) and any future
 * batch maintenance op get the same liveness signal with one function call.
 *
 * Emits info-level progress at ~25% intervals when totalRows >= threshold
 * (default 50). Below threshold: returns a no-op ticker. The ticker MUST be
 * called once per row processed (success / failure / skipped — every code
 * path) so the counter reflects actual liveness. JS is single-threaded so
 * the closure-captured counter is race-free across Promise.all chain
 * workers.
 *
 * `opName` is the log prefix (e.g. "backfillBlockNumbers"). The format
 * matches iter774's pattern: "{opName} progress: P/T rows (last: chain/hash…)".
 */
function makeProgressTicker(
  logger: Logger,
  opName: string,
  totalRows: number,
  threshold = 50,
): (chainName: string, txHash: string) => void {
  if (totalRows < threshold) return () => {}; // no-op for small scans
  const interval = Math.ceil(totalRows / 4);
  let processed = 0;
  return (chainName: string, txHash: string) => {
    processed++;
    if (processed % interval === 0 || processed === totalRows) {
      logger.info(
        `${opName} progress: ${processed}/${totalRows} rows (last: ${chainName}/${txHash.slice(0, 10)}…)`,
      );
    }
  };
}

export interface ReconcileVerdict {
  /** Stay pending — receipt isn't on chain yet. */
  status: "pending";
}
export interface ReconcileResolved {
  status: "success" | "failed";
  gasUsed: string;
  gasCostNative: string;
  /** Iter635: receipt block number (when the receipt carried one). Used to
   *  backfill the trades.block_number column for reorg-depth filtering. */
  blockNumber?: number;
}

export type ReconcileOutcome = ReconcileVerdict | ReconcileResolved;

/**
 * Pure: given a fetched receipt (or null if the chain doesn't know about the hash yet),
 * decide what status the pending trade should become. Extracted so the dispatch logic
 * can be unit-tested without a real RPC.
 */
export function classifyReceipt(
  receipt:
    | { status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice?: bigint | null; blockNumber?: bigint }
    | null,
): ReconcileOutcome {
  if (!receipt) return { status: "pending" };
  const gasCostWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
  return {
    status: receipt.status === "success" ? "success" : "failed",
    gasUsed: receipt.gasUsed.toString(),
    gasCostNative: formatUnits(gasCostWei, 18),
    // Iter635: capture blockNumber when present (viem's getTransactionReceipt
    // always populates it on success/failed receipts; undefined only on the
    // null-receipt branch above).
    ...(receipt.blockNumber != null ? { blockNumber: Number(receipt.blockNumber) } : {}),
  };
}

export interface ReconcileReport {
  /** ISO timestamp when reconcile started — useful for audit trails and operator
   *  back-tracing when investigating "why did so many fail today?". */
  timestamp: string;
  scanned: number;
  resolvedSuccess: number;
  resolvedFailed: number;
  stillPending: number;
  errors: { chain: string; txHash: string; message: string; explorerUrl?: string }[];
  /** Iter725: wall-clock ms for the pending walk. Same shape as iter724's
   *  backfill elapsedMs — scripted consumers (cron tick frequency tuning,
   *  alerting on slow reconciles) can see how long the walk took. */
  elapsedMs?: number;
  /** Iter801: top-level severity for at-a-glance status. "ok" = clean sweep
   *  (no errors, no still-pending rows). "warn" = something deserves operator
   *  attention — RPC errors during the walk OR rows that remained pending
   *  (next reconcile should resolve them, but persistent stillPending across
   *  runs flags a stuck tx). Symmetric with iter786 health.severity / iter787
   *  doctor.severity / iter788 audit.severity. */
  severity: "ok" | "warn";
  /** Iter831: structured next-action dispatch. When stillPending > 0,
   *  suggests `pending` to diagnose stuck txs. When errors[] non-empty,
   *  suggests re-running reconcile (likely transient RPC; iter738 bookmark
   *  pinning means dedup absorbs the retry). Always present (empty on a
   *  clean sweep). Symmetric with iter829 tokenInfo + iter830 pnl. */
  recommendedActions: import("./errors.js").NextAction[];
}

/**
 * Walk every pending trade row (for the given account/chain filter), fetch its receipt,
 * and update the DB. Trades whose receipts can't be retrieved stay pending — we never
 * "guess" a trade failed, since on most L2s a tx that hasn't landed yet is indistinguishable
 * from a tx that vanished. Operators can manually mark with `tradekit inspect` if needed.
 */
export async function reconcilePending(
  opts: {
    config: Config;
    logger: Logger;
    /** Limit to one chain (defaults to all chains found among pending rows). */
    chain?: string;
    /** Limit to one account (defaults to all). */
    account?: string;
  },
): Promise<ReconcileReport> {
  // Iter725: wall-clock timing for the pending walk.
  const t0 = Date.now();
  const rows = pendingTrades({ chain: opts.chain, account: opts.account });
  const report: ReconcileReport = {
    timestamp: new Date().toISOString(),
    scanned: rows.length,
    resolvedSuccess: 0,
    resolvedFailed: 0,
    stillPending: 0,
    errors: [],
    // Iter801: severity defaults ok; derivation runs at return time after
    // counters are finalized.
    severity: "ok",
    // Iter831: dispatch list also derived at return time.
    recommendedActions: [],
  };

  // Group by chain so we build one PublicClient per chain instead of per row.
  const byChain = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const list = byChain.get(row.chain) ?? [];
    list.push(row);
    byChain.set(row.chain, list);
  }

  // Process chains in parallel — typical pending workload spans 1-2 chains, but on a
  // multi-chain agent setup chains were previously serialized (each waited for the
  // prior chain's slow RPC). Now all chains kick off concurrently.
  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainName, chainRows]) => {
      // Check both built-ins AND user-configured custom chains. Pre-iter226 the check
      // only consulted listChains() (built-ins), so pending trades on a custom chain
      // were incorrectly classified as "unknown" even when the config had the chain
      // fully defined. Same gap iter157/161/211 closed elsewhere.
      const isKnown =
        listChains().includes(chainName) || opts.config.chains?.[chainName] != null;
      if (!isKnown) {
        // Iter306: surface the unknown-chain skip in the report so the CLI shows
        // operators WHY some rows stayed pending. Pre-iter306 the warn went only to
        // server.log and the operator saw a higher-than-expected stillPending count
        // with no diagnostic. Most common cause: operator removed a custom chain
        // after a trade landed on it, or the trades table has data from before iter226's
        // custom-chain support was applied.
        const msg = `reconcile: skipping unknown chain "${chainName}" (${chainRows.length} rows) — add it back via \`tradekit config set chains.${chainName}.chainId ...\` to verify these txs.`;
        opts.logger.warn(msg);
        report.stillPending += chainRows.length;
        for (const row of chainRows) {
          report.errors.push({
            chain: chainName,
            txHash: row.tx_hash,
            message: `Chain "${chainName}" not in built-ins or config; cannot verify receipt.`,
          });
        }
        return;
      }
      const profile = resolveProfile(chainName, opts.config);
      const userRpcs = opts.config.chains[chainName]?.rpcs ?? [];
      const transport = makeTransport(profile, userRpcs);
      const client = createPublicClient({ chain: profile.viemChain, transport });

      // Fetch all receipts in parallel within the chain. Per-row failures stay pending.
      await Promise.all(
        chainRows.map(async (row) => {
          try {
            const receipt = await client.getTransactionReceipt({ hash: row.tx_hash as Hex }).catch(() => null);
            const verdict = classifyReceipt(receipt);
            if (verdict.status === "pending") {
              report.stillPending += 1;
              return;
            }
            if (typeof row.id !== "number") {
              // Inserted rows always have an id; this only happens for handcrafted tests.
              throw new Error("trade row missing id");
            }
            // Iter669: when the receipt is failed AND we have a block number,
            // attempt to extract + persist the revert reason via an eth_call
            // replay (iter666 logic). Best-effort: any failure (RPC error,
            // replay-doesn't-revert, no return data) leaves revert_reason
            // NULL so the analyze path can retry later. We deliberately do
            // NOT await this in a way that fails the reconcile — the trade's
            // failed status persists regardless.
            let revertReason: string | undefined;
            if (verdict.status === "failed" && verdict.blockNumber != null) {
              try {
                const { extractRevertReasonByHash } = await import("./tradeAnalysis.js");
                revertReason = await extractRevertReasonByHash({
                  publicClient: client,
                  txHash: row.tx_hash,
                  blockNumber: verdict.blockNumber,
                  logger: opts.logger,
                });
              } catch (e) {
                opts.logger.debug(`reconcile: revert-reason extraction failed for ${row.tx_hash}: ${(e as Error).message}`);
              }
            }
            updateTradeStatus(row.id, verdict.status, {
              gas_used: verdict.gasUsed,
              gas_cost_native: verdict.gasCostNative,
              // Iter635: backfill block_number when the receipt carried one.
              // Pre-iter635 rows had no column; new reconciles populate it.
              block_number: verdict.blockNumber ?? null,
              // Iter669: persist the extracted reason on the row. Stored
              // even when undefined — the column accepts NULL so subsequent
              // analyses can re-extract.
              revert_reason: revertReason ?? null,
            });
            if (verdict.status === "success") report.resolvedSuccess += 1;
            else report.resolvedFailed += 1;
            opts.logger.info(`reconcile ${chainName} ${row.tx_hash} → ${verdict.status}`);
          } catch (e) {
            const message = (e as Error).message;
            report.errors.push({
              chain: chainName,
              txHash: row.tx_hash,
              message,
              explorerUrl: profile.explorer ? `${profile.explorer}/tx/${row.tx_hash}` : undefined,
            });
            // Iter478: sanitize external `message` (viem/RPC multi-line) before logging.
            opts.logger.warn(sanitizeForLogLine(`reconcile ${chainName} ${row.tx_hash} error: ${message}`));
          }
        }),
      );
    }),
  );

  report.elapsedMs = Date.now() - t0;
  // Iter801: derive severity from final counters. "warn" when anything
  // deserves operator attention — errors during the walk OR stillPending
  // rows (next sweep should resolve, but persistent across runs flags
  // genuinely stuck txs).
  report.severity = report.errors.length > 0 || report.stillPending > 0 ? "warn" : "ok";
  // Iter831: derive structured dispatch list from final counters. Two
  // independent triggers:
  //   - stillPending > 0 → operator should diagnose via `pending` (iter622
  //     classifies stuck-vs-routine-wait per tx)
  //   - errors > 0 → re-run reconcile (typically transient; iter738 dedup
  //     handles the re-attempt safely)
  if (report.stillPending > 0) {
    report.recommendedActions.push({
      tool: "diagnose_pending",
      params: opts.chain ? { chain: opts.chain } : {},
      reason: `${report.stillPending} trade${report.stillPending === 1 ? "" : "s"} still pending after reconcile — diagnose to classify stuck vs routine-wait.`,
    });
  }
  if (report.errors.length > 0) {
    report.recommendedActions.push({
      tool: "reconcile",
      params: opts.chain ? { chain: opts.chain } : {},
      reason: `${report.errors.length} per-row error${report.errors.length === 1 ? "" : "s"} during the walk — typically transient RPC; re-run is safe (iter738 dedup).`,
    });
  }
  return report;
}

/**
 * Fire-and-log a reconcile in the background. Designed for server startup: never throws,
 * never blocks, logs one summary line when done. If the very first reconcile finds 0
 * pending rows (the common case) we stay silent — no need to spam every server start.
 */
export function runStartupReconcile(config: Config, logger: Logger): void {
  // Detached promise: we don't await — server startup latency stays unchanged.
  reconcilePending({ config, logger })
    .then((report) => {
      if (report.scanned === 0) return;
      logger.info(
        `startup reconcile: ${report.resolvedSuccess} success, ${report.resolvedFailed} failed, ${report.stillPending} still pending, ${report.errors.length} errors`,
      );
    })
    .catch((e) => {
      // Iter478: sanitize before logging — startup reconcile's catch sees viem
      // multi-line errors from chain probes.
      logger.warn(sanitizeForLogLine(`startup reconcile failed: ${(e as Error).message}`));
    });
}

export function formatReconcileReport(r: ReconcileReport): string {
  // Iter258: collapse the empty case to a single line. A scheduled `reconcile` cron
  // typically returns 0 most invocations — printing five lines of "0 success / 0 failed
  // / 0 pending / 0 errors" every minute pushes anything useful out of the operator's
  // log scroll. One line keeps the signal-to-noise high. JSON shape is unchanged so
  // monitoring scripts that parse the report still get the full breakdown.
  // Iter731: elapsedMs suffix surfaces compute cost — useful for both the
  // empty-case and the populated cases.
  const elapsedSuffix = r.elapsedMs != null
    ? ` (${(r.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  if (r.scanned === 0 && r.errors.length === 0) {
    return `No pending trades to reconcile.${elapsedSuffix}`;
  }
  // Iter811: severity badge prepended to the header — parity with iter808/809/810
  // verify / sync / portfolio conventions. Skipped on the empty-clean case above
  // (the line itself is already the signal).
  const badge = r.severity === "ok" ? "🟢 OK  " : "🟡 WARN";
  const lines: string[] = [];
  lines.push(`${badge}  Scanned ${r.scanned} pending trade${r.scanned === 1 ? "" : "s"}${elapsedSuffix}`);
  lines.push(`  ✓ success:  ${r.resolvedSuccess}`);
  lines.push(`  ✗ failed:   ${r.resolvedFailed}`);
  lines.push(`  …  pending: ${r.stillPending}`);
  if (r.errors.length > 0) {
    lines.push(`  ! errors:   ${r.errors.length}`);
    for (const e of r.errors.slice(0, 5)) {
      lines.push(`      ${e.chain.padEnd(8)} ${e.txHash}  ${compactMessage(e.message, 60)}`);
    }
  }
  // Iter839: surface iter831 recommendedActions inline. Each action's
  // `reason` is operator-readable prose; printing them under a "Next step:"
  // banner gives copy-paste-ready guidance without operators having to parse
  // the counts + errors above.
  if (r.recommendedActions.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const a of r.recommendedActions) {
      lines.push(`  → ${a.reason}`);
    }
  }
  return lines.join("\n");
}

// ── reorg detection (iter628) ─────────────────────────────────

/**
 * Iter628: verdict for a recent-success trade being re-checked against the
 * chain. "still_success" is the normal case; the other two indicate the trade
 * was reorg'd after we marked it success.
 */
export type ReorgVerdict = "still_success" | "reorg_failed" | "reorg_missing";

export interface ReorgSuspect {
  txHash: string;
  chain: string;
  account: string;
  verdict: ReorgVerdict;
  /** Human-readable explanation. */
  message: string;
}

export interface VerifyRecentReport {
  timestamp: string;
  /** Trades re-checked. */
  scanned: number;
  /** Trades whose receipt still confirms success — the happy path. */
  stillSuccess: number;
  /** Trades whose on-chain status flipped to failed since we marked them. */
  reorgFailed: number;
  /** Trades whose receipt is now missing (tx vanished from chain). */
  reorgMissing: number;
  /** RPC errors during the re-check. */
  errors: { chain: string; txHash: string; message: string }[];
  /** Concatenated list of every non-still_success row. */
  suspects: ReorgSuspect[];
  /** Iter726: wall-clock ms for the verify walk. Same shape as iter724's
   *  backfill elapsedMs + iter725's reconcile elapsedMs. */
  elapsedMs?: number;
  /** Iter804: worst-bucket severity. "warn" on any reorg-affected rows OR
   *  per-tx errors during the verify walk. Symmetric with iter801. */
  severity: "ok" | "warn";
}

/**
 * Iter628: pure classifier for a recent-success trade being re-verified.
 *
 *   - receipt confirms success → "still_success" (no action needed)
 *   - receipt now says reverted → "reorg_failed" (a reorg flipped it)
 *   - receipt is null → "reorg_missing" (the tx is no longer in the canonical
 *     chain — could be a deep reorg that dropped it, or RPC lag; flag for
 *     operator review)
 *
 * Exported pure so unit tests can pin the verdict matrix without an RPC.
 */
export function classifyReorgVerdict(
  receipt: { status: "success" | "reverted" } | null,
): ReorgVerdict {
  if (!receipt) return "reorg_missing";
  if (receipt.status === "success") return "still_success";
  return "reorg_failed";
}

/**
 * Iter628: re-verify the last N success trades against the chain to detect
 * reorgs. Conservative: surfaces suspects but does NOT auto-mutate the DB
 * by default. The CLI/MCP wrapper exposes an `autoMark` opt-in that promotes
 * suspects to failed.
 *
 * Why conservative: a transient RPC issue could report a real success as
 * "missing" (the tx is still there, the node just hasn't indexed it). Auto-
 * marking on that would create a false failure in the DB. Surfacing suspects
 * gives the operator a chance to investigate (compare across RPCs, wait,
 * etc.) before destructive action.
 *
 * Limit: caller passes how many recent trades to check. Default 10 in the
 * CLI/MCP layer — bounded RPC fan-out.
 */
export async function verifyRecentSuccess(opts: {
  config: Config;
  logger: Logger;
  limit: number;
  chain?: string;
  account?: string;
  autoMark?: boolean;
  /**
   * Iter635: skip trades buried deeper than this many blocks (per chain). A
   * trade confirmed N blocks ago on Ethereum (12s/block) is effectively immune
   * to reorgs once N > 64. Default 256 — generous for any chain. Set to 0 to
   * verify every success row regardless of depth.
   *
   * Only applies to rows that HAVE a block_number (iter635+ rows). Legacy
   * rows without it are always re-verified — we have no depth signal.
   */
  maxReorgDepth?: number;
}): Promise<VerifyRecentReport> {
  // Iter726: wall-clock timing for the verify walk.
  const t0 = Date.now();
  // Lazy import so we don't change the existing reconcile module's static
  // import graph (and to keep db import scoping consistent with other reads).
  const { recentTrades } = await import("./db.js");
  const rows = recentTrades({
    chain: opts.chain,
    account: opts.account,
    limit: Math.max(1, Math.min(opts.limit, 500)),
  }).filter((r) => r.status === "success");

  const report: VerifyRecentReport = {
    timestamp: new Date().toISOString(),
    scanned: rows.length,
    stillSuccess: 0,
    reorgFailed: 0,
    reorgMissing: 0,
    errors: [],
    suspects: [],
    severity: "ok",
  };

  // Group by chain so we build one PublicClient per chain.
  const byChain = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const list = byChain.get(row.chain) ?? [];
    list.push(row);
    byChain.set(row.chain, list);
  }

  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainName, chainRows]) => {
      const isKnown =
        listChains().includes(chainName) || opts.config.chains?.[chainName] != null;
      if (!isKnown) {
        for (const row of chainRows) {
          report.errors.push({
            chain: chainName,
            txHash: row.tx_hash,
            message: `Chain "${chainName}" not in built-ins or config; cannot verify.`,
          });
        }
        return;
      }
      const profile = resolveProfile(chainName, opts.config);
      const userRpcs = opts.config.chains[chainName]?.rpcs ?? [];
      const transport = makeTransport(profile, userRpcs);
      const client = createPublicClient({ chain: profile.viemChain, transport });

      // Iter635: fetch chain head once per chain so we can prune rows buried
      // deeper than maxReorgDepth before spending an RPC each on getReceipt.
      // Falls back to "no depth filter" when getBlockNumber fails — the cost
      // is one extra RPC per chain, dwarfed by the per-row receipts we save.
      const maxDepth = opts.maxReorgDepth ?? 256;
      let head: bigint | null = null;
      if (maxDepth > 0) {
        try {
          head = await client.getBlockNumber();
        } catch (e) {
          opts.logger.debug(
            `verifyRecent ${chainName}: chain head fetch failed — depth filter disabled. ${(e as Error).message}`,
          );
        }
      }

      await Promise.all(
        chainRows.map(async (row) => {
          // Iter635: skip deeply-buried rows. Only rows with block_number qualify
          // (legacy/null rows always re-verify — we have no depth signal).
          if (
            head != null &&
            maxDepth > 0 &&
            row.block_number != null &&
            head - BigInt(row.block_number) > BigInt(maxDepth)
          ) {
            report.stillSuccess += 1; // assumed final; no RPC needed
            return;
          }
          try {
            const receipt = await client
              .getTransactionReceipt({ hash: row.tx_hash as Hex })
              .catch(() => null);
            const verdict = classifyReorgVerdict(receipt);
            if (verdict === "still_success") {
              report.stillSuccess += 1;
              return;
            }

            if (verdict === "reorg_failed") report.reorgFailed += 1;
            else report.reorgMissing += 1;

            const message =
              verdict === "reorg_failed"
                ? `Receipt now reports REVERTED on chain — was marked success in DB. Likely reorg flipped the tx outcome.`
                : `Receipt is MISSING on chain — was marked success in DB. Tx may have been reorg'd out, or RPC is lagging. Investigate before any action.`;
            const suspect: ReorgSuspect = {
              txHash: row.tx_hash,
              chain: chainName,
              account: row.account,
              verdict,
              message,
            };
            report.suspects.push(suspect);

            // Conservative: only auto-mark on opt-in. And ONLY for reorg_failed
            // (we have a positive signal); reorg_missing stays as success in
            // the DB even with autoMark=true because an RPC lag would falsely
            // demote a real trade.
            if (opts.autoMark && verdict === "reorg_failed" && typeof row.id === "number") {
              updateTradeStatus(row.id, "failed", {
                gas_used: row.gas_used ?? null,
                gas_cost_native: row.gas_cost_native ?? null,
              });
              opts.logger.warn(
                sanitizeForLogLine(
                  `verifyRecent: auto-marked ${row.tx_hash} (${chainName}) FAILED — reorg flipped on-chain status.`,
                ),
              );
            }
          } catch (e) {
            const message = (e as Error).message;
            report.errors.push({ chain: chainName, txHash: row.tx_hash, message });
            opts.logger.warn(
              sanitizeForLogLine(`verifyRecent ${chainName} ${row.tx_hash} error: ${message}`),
            );
          }
        }),
      );
    }),
  );

  report.elapsedMs = Date.now() - t0;
  // Iter804: severity also reflects reorg detections — both errors and reorg
  // signals indicate operator attention.
  report.severity =
    report.errors.length > 0 || report.reorgFailed > 0 || report.reorgMissing > 0
      ? "warn"
      : "ok";
  return report;
}

/**
 * Iter628: human-readable summary of a verify-recent report. Mirrors
 * formatReconcileReport's terse-on-empty pattern.
 */
export function formatVerifyRecentReport(r: VerifyRecentReport): string {
  // Iter731: elapsedMs suffix parallel to formatReconcileReport.
  const elapsedSuffix = r.elapsedMs != null
    ? ` (${(r.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  if (r.scanned === 0) return `No recent success trades to verify.${elapsedSuffix}`;
  const lines: string[] = [];
  lines.push(`Verified ${r.scanned} recent success trade${r.scanned === 1 ? "" : "s"}:${elapsedSuffix}`);
  lines.push(`  ✓ still success: ${r.stillSuccess}`);
  if (r.reorgFailed > 0) lines.push(`  ⚠ reorg flipped:  ${r.reorgFailed}`);
  if (r.reorgMissing > 0) lines.push(`  ⚠ reorg missing:  ${r.reorgMissing}`);
  if (r.errors.length > 0) lines.push(`  ! errors:        ${r.errors.length}`);
  if (r.suspects.length > 0) {
    lines.push("");
    lines.push("Suspects:");
    for (const s of r.suspects.slice(0, 10)) {
      const badge = s.verdict === "reorg_failed" ? "REORG-FLIP" : "REORG-MISS";
      lines.push(`  ${badge}  ${s.chain.padEnd(8)} ${s.txHash}`);
      lines.push(`     ${s.message}`);
    }
    if (r.suspects.length > 10) {
      lines.push(`     … and ${r.suspects.length - 10} more`);
    }
  }
  return lines.join("\n");
}

// ── block_number backfill (iter637) ────────────────────────────

export interface BackfillBlocksReport {
  timestamp: string;
  /** Rows considered (success trades with block_number IS NULL, within filter). */
  scanned: number;
  /** Rows where the chain returned a receipt + we persisted blockNumber. */
  backfilled: number;
  /** Rows whose receipt was missing on the chain (likely pruned or wrong chain).
   *  Not an error — these legacy rows just stay NULL forever. */
  receiptMissing: number;
  /** RPC / DB errors during the walk. */
  errors: Array<{ chain: string; txHash: string; message: string }>;
  /** Iter724: wall-clock ms for the standalone backfill. Symmetric with
   *  iter723's per-phase timing on BackfillAllReport — scripted consumers
   *  running individual backfills (`tradekit reconcile --backfill-blocks`)
   *  see how long the walk took. */
  elapsedMs?: number;
  /** Iter804: worst-bucket severity. "warn" when any per-row error fired
   *  during the walk; "ok" otherwise. Symmetric with iter786/801 severity
   *  fields. receiptMissing doesn't trigger — those are legacy rows beyond
   *  the chain's pruning window, not an error. */
  severity: "ok" | "warn";
}

/**
 * Iter637: walks success trades without a block_number and backfills it from
 * the chain receipt. Iter635's maxReorgDepth filter only helps trades made
 * AFTER iter635 deploys; this command lets operators with months/years of
 * trade history get the same coverage retroactively.
 *
 * Bounded by `limit` (default 500) to avoid runaway RPC fan-out on huge
 * historical DBs. Operators with bigger backfills run the command multiple
 * times — idempotent: rows already backfilled won't be picked up again.
 *
 * Per-row error tolerant. Receipts that return null (pruned or wrong chain)
 * land in `receiptMissing` — not an error, just an unrecoverable legacy state.
 */
export async function backfillBlockNumbers(opts: {
  config: Config;
  logger: Logger;
  limit?: number;
  chain?: string;
  account?: string;
}): Promise<BackfillBlocksReport> {
  // Iter724: wall-clock timing for standalone callers (backfillAll already
  // tracks per-phase via its own t0/tBlocks measurements; redundant here is
  // fine — same Date.now() base).
  const t0 = Date.now();
  const { successTradesWithoutBlockNumber, updateTradeStatus } = await import("./db.js");
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const rows = successTradesWithoutBlockNumber({
    limit,
    chain: opts.chain,
    account: opts.account,
  });

  const report: BackfillBlocksReport = {
    timestamp: new Date().toISOString(),
    scanned: rows.length,
    backfilled: 0,
    receiptMissing: 0,
    errors: [],
    // Iter804: severity defaults ok; derived at return time after errors[]
    // has its final contents.
    severity: "ok",
  };

  // Group by chain to share one PublicClient per chain — same pattern as
  // reconcilePending / verifyRecentSuccess.
  const byChain = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const list = byChain.get(row.chain) ?? [];
    list.push(row);
    byChain.set(row.chain, list);
  }

  // Iter775: use the shared progress ticker (extracted from iter774's
  // inline version). Counter tracks ALL rows touched — backfilled +
  // receiptMissing + errors — so operators see real liveness even when
  // most receipts are missing.
  const tick = makeProgressTicker(opts.logger, "backfillBlockNumbers", rows.length);

  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainName, chainRows]) => {
      const isKnown =
        listChains().includes(chainName) || opts.config.chains?.[chainName] != null;
      if (!isKnown) {
        for (const row of chainRows) {
          report.errors.push({
            chain: chainName,
            txHash: row.tx_hash,
            message: `Chain "${chainName}" not in built-ins or config; cannot fetch receipt.`,
          });
        }
        return;
      }
      const profile = resolveProfile(chainName, opts.config);
      const userRpcs = opts.config.chains[chainName]?.rpcs ?? [];
      const transport = makeTransport(profile, userRpcs);
      const client = createPublicClient({ chain: profile.viemChain, transport });

      // Process serially within a chain to keep RPC load gentle on free-tier
      // public RPCs — backfill is a long-running maintenance op, not a
      // latency-sensitive read.
      for (const row of chainRows) {
        try {
          const receipt = await client
            .getTransactionReceipt({ hash: row.tx_hash as Hex })
            .catch(() => null);
          if (!receipt) {
            report.receiptMissing += 1;
            tick(chainName, row.tx_hash);
            continue;
          }
          if (typeof row.id !== "number") {
            tick(chainName, row.tx_hash);
            continue;
          }
          // Preserve the existing status (success — we filtered for that);
          // only update gas + block_number. The existing gas_used /
          // gas_cost_native may have been populated by an earlier reconcile;
          // re-applying them is harmless (idempotent).
          updateTradeStatus(row.id, "success", {
            gas_used: row.gas_used ?? null,
            gas_cost_native: row.gas_cost_native ?? null,
            block_number: Number(receipt.blockNumber),
          });
          report.backfilled += 1;
          tick(chainName, row.tx_hash);
        } catch (e) {
          report.errors.push({
            chain: chainName,
            txHash: row.tx_hash,
            message: (e as Error).message,
          });
          opts.logger.warn(
            sanitizeForLogLine(`backfillBlockNumbers ${chainName} ${row.tx_hash} error: ${(e as Error).message}`),
          );
          tick(chainName, row.tx_hash);
        }
      }
    }),
  );

  report.elapsedMs = Date.now() - t0;
  report.severity = report.errors.length > 0 ? "warn" : "ok";
  return report;
}

/** Iter637: terse formatter for the backfill report. */
export function formatBackfillBlocksReport(r: BackfillBlocksReport): string {
  // Iter732: elapsed suffix parallel to iter730/731. Compact (N.Ns).
  const elapsedSuffix = r.elapsedMs != null
    ? ` (${(r.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  if (r.scanned === 0) return `No success trades without block_number — nothing to backfill.${elapsedSuffix}`;
  const lines: string[] = [];
  lines.push(`Backfill block_number for ${r.scanned} legacy success trade${r.scanned === 1 ? "" : "s"}:${elapsedSuffix}`);
  lines.push(`  ✓ backfilled:       ${r.backfilled}`);
  if (r.receiptMissing > 0) {
    lines.push(`  ⚠ receipt missing:  ${r.receiptMissing} (likely pruned by the RPC; legacy state)`);
  }
  if (r.errors.length > 0) {
    lines.push(`  ! errors:           ${r.errors.length}`);
    for (const e of r.errors.slice(0, 5)) {
      lines.push(`      ${e.chain.padEnd(10)} ${e.txHash}  ${compactMessage(e.message, 60)}`);
    }
    if (r.errors.length > 5) {
      lines.push(`      … and ${r.errors.length - 5} more`);
    }
  }
  // Order matters: when we hit the default 500-row limit, more rows likely
  // exist in the DB regardless of how many we backfilled in this call. Surface
  // the re-run hint first so operators don't think they're done when they
  // aren't.
  if (r.scanned >= 500) {
    lines.push("");
    lines.push("Hit the default 500-row limit — re-run to continue backfilling.");
  } else if (r.backfilled === r.scanned && r.scanned > 0) {
    lines.push("");
    lines.push("All rows backfilled. Future maxReorgDepth filters will now cover historical trades.");
  }
  return lines.join("\n");
}

// ── realized_slippage_bps backfill (iter643) ──────────────────

export interface BackfillSlippageReport {
  timestamp: string;
  /** Rows considered (success swaps with realized_slippage_bps IS NULL). */
  scanned: number;
  /** Rows where iter619 analysis succeeded + we persisted slippage. */
  backfilled: number;
  /** Rows where analysis was inconclusive (no_match, unknown, missing
   *  receipt). Legacy state that can't be recovered. */
  inconclusive: number;
  /** RPC / DB errors during the walk. */
  errors: Array<{ chain: string; txHash: string; message: string }>;
  /** Iter724: wall-clock ms for the standalone backfill. */
  elapsedMs?: number;
  /** Iter804: worst-bucket severity. "warn" on any per-row error. */
  severity: "ok" | "warn";
}

/**
 * Iter643: walk legacy success swaps and backfill realized_slippage_bps via
 * the iter619 analyzeStoredTrade path. Symmetric with iter637 backfill-blocks:
 * one-time maintenance for operators with pre-iter641 history.
 *
 * Per-row cost is two RPC calls (getTransaction + getTransactionReceipt).
 * Bounded by `limit` (default 200, max 2000) to keep runtime reasonable on
 * huge historical DBs. Operators with bigger backfills re-run — idempotent
 * (already-backfilled rows are filtered at the query layer).
 *
 * Conservative on inconclusive results: when iter619 returns `unknown` or
 * `no_match`, we leave the column NULL rather than store a misleading value.
 * Operators can re-run after improving token metadata config (rare cause of
 * no_match) without polluted data.
 */
export async function backfillRealizedSlippage(opts: {
  config: Config;
  logger: Logger;
  limit?: number;
  chain?: string;
  account?: string;
}): Promise<BackfillSlippageReport> {
  // Iter724: wall-clock timing for standalone callers.
  const t0 = Date.now();
  const { successTradesWithoutSlippage, updateTradeStatus } = await import("./db.js");
  const { analyzeStoredTrade } = await import("./tradeAnalysis.js");
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000));
  const rows = successTradesWithoutSlippage({
    limit,
    chain: opts.chain,
    account: opts.account,
  });

  const report: BackfillSlippageReport = {
    timestamp: new Date().toISOString(),
    scanned: rows.length,
    backfilled: 0,
    inconclusive: 0,
    errors: [],
    severity: "ok",
  };

  // Group by chain for one PublicClient per chain — same pattern as backfill blocks.
  const byChain = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const list = byChain.get(row.chain) ?? [];
    list.push(row);
    byChain.set(row.chain, list);
  }

  // Iter775: shared progress ticker (same helper backfillBlockNumbers uses).
  const tick = makeProgressTicker(opts.logger, "backfillRealizedSlippage", rows.length);

  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainName, chainRows]) => {
      const isKnown =
        listChains().includes(chainName) || opts.config.chains?.[chainName] != null;
      if (!isKnown) {
        for (const row of chainRows) {
          report.errors.push({
            chain: chainName,
            txHash: row.tx_hash,
            message: `Chain "${chainName}" not in built-ins or config; cannot analyze receipt.`,
          });
          tick(chainName, row.tx_hash);
        }
        return;
      }
      const profile = resolveProfile(chainName, opts.config);
      const userRpcs = opts.config.chains[chainName]?.rpcs ?? [];
      const transport = makeTransport(profile, userRpcs);
      const client = createPublicClient({ chain: profile.viemChain, transport });

      // Serial within a chain — same RPC-gentle pattern as backfill blocks.
      for (const row of chainRows) {
        try {
          if (typeof row.id !== "number") {
            tick(chainName, row.tx_hash);
            continue;
          }
          const analyzed = await analyzeStoredTrade({
            row,
            publicClient: client,
            profile,
            logger: opts.logger,
          });
          // Conservative: only persist when the analysis produced a real
          // comparison. unknown / no_match / reverted stay NULL.
          if (analyzed.comparison && Number.isFinite(analyzed.comparison.slippageBps)) {
            updateTradeStatus(row.id, "success", {
              gas_used: row.gas_used ?? null,
              gas_cost_native: row.gas_cost_native ?? null,
              realized_slippage_bps: analyzed.comparison.slippageBps,
            });
            report.backfilled += 1;
          } else {
            report.inconclusive += 1;
          }
          tick(chainName, row.tx_hash);
        } catch (e) {
          report.errors.push({
            chain: chainName,
            txHash: row.tx_hash,
            message: (e as Error).message,
          });
          opts.logger.warn(
            sanitizeForLogLine(`backfillRealizedSlippage ${chainName} ${row.tx_hash} error: ${(e as Error).message}`),
          );
          tick(chainName, row.tx_hash);
        }
      }
    }),
  );

  report.elapsedMs = Date.now() - t0;
  report.severity = report.errors.length > 0 ? "warn" : "ok";
  return report;
}

// ── gas_cost_usd_at_trade backfill (iter654) ─────────────────

export interface BackfillGasUsdReport {
  timestamp: string;
  /** Rows considered (success swaps with gas_cost_native + NULL gas_cost_usd_at_trade). */
  scanned: number;
  /** Rows where historical CoinGecko price + math succeeded. */
  backfilled: number;
  /** Rows where the chain's native isn't CoinGecko-mapped (unknown native).
   *  Permanent state — these rows can't be backfilled with this strategy. */
  noOracle: number;
  /** Rows where the API call failed (rate limit, network, etc). Retryable —
   *  operator re-runs later. */
  apiFailed: number;
  /** RPC / DB errors. */
  errors: Array<{ chain: string; txHash: string; message: string }>;
  /** Iter724: wall-clock ms for the standalone backfill. */
  elapsedMs?: number;
  /** Iter804: worst-bucket severity. "warn" on errors OR apiFailed (retryable
   *  signals that warrant another sweep); noOracle stays ok (permanent state,
   *  no action available). */
  severity: "ok" | "warn";
}

/**
 * Iter654: walk legacy success swaps and backfill gas_cost_usd_at_trade
 * using CoinGecko's historical price endpoint. Symmetric with iter637
 * block_number backfill + iter643 slippage backfill.
 *
 * Approach:
 *   1. Resolve the chain's native token CoinGecko id (via the chain's
 *      `weth` address → COINGECKO_IDS map).
 *   2. For each row: compute USD = parseFloat(gas_cost_native) × historical
 *      native price at row.timestamp.
 *   3. Persist via updateTradeStatus.
 *
 * Cost: 1 CoinGecko call per UNIQUE (coinId, date) thanks to iter654's
 * in-memory cache. A 200-row backfill spanning 7 days of mostly-same-chain
 * activity costs ~7-14 CoinGecko calls, not 200. Free tier handles it.
 *
 * Bounded by `limit` (default 200, max 1000) so the rate-limit budget stays
 * predictable.
 */
export async function backfillGasUsd(opts: {
  config: Config;
  logger: Logger;
  limit?: number;
  chain?: string;
  account?: string;
}): Promise<BackfillGasUsdReport> {
  // Iter724: wall-clock timing for standalone callers.
  const t0 = Date.now();
  const { successTradesWithoutGasUsd, updateTradeStatus } = await import("./db.js");
  const { getHistoricalPrice, getCoinGeckoId } = await import("./price.js");
  const { getBuiltinProfile } = await import("./chains.js");
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const rows = successTradesWithoutGasUsd({
    limit,
    chain: opts.chain,
    account: opts.account,
  });

  const report: BackfillGasUsdReport = {
    timestamp: new Date().toISOString(),
    scanned: rows.length,
    backfilled: 0,
    noOracle: 0,
    apiFailed: 0,
    errors: [],
    severity: "ok",
  };

  // Iter775: shared progress ticker — same helper backfillBlockNumbers uses.
  const tick = makeProgressTicker(opts.logger, "backfillGasUsd", rows.length);

  // Serial walk — CoinGecko free tier is rate-limited (~10-30 rpm). Parallel
  // would burn the budget fast.
  for (const row of rows) {
    try {
      if (typeof row.id !== "number") {
        tick(row.chain, row.tx_hash);
        continue;
      }
      const profile = getBuiltinProfile(row.chain) ?? opts.config.chains?.[row.chain];
      if (!profile) {
        report.errors.push({
          chain: row.chain,
          txHash: row.tx_hash,
          message: `Chain "${row.chain}" not in built-ins or config.`,
        });
        tick(row.chain, row.tx_hash);
        continue;
      }
      const wethAddr =
        "weth" in profile && profile.weth ? (profile.weth as string) : undefined;
      if (!wethAddr || !getCoinGeckoId(wethAddr)) {
        report.noOracle += 1;
        tick(row.chain, row.tx_hash);
        continue;
      }
      const histPrice = await getHistoricalPrice(wethAddr, row.timestamp, opts.logger);
      if (histPrice == null) {
        report.apiFailed += 1;
        tick(row.chain, row.tx_hash);
        continue;
      }
      const native = parseFloat(row.gas_cost_native ?? "0");
      if (!Number.isFinite(native) || native <= 0) {
        report.apiFailed += 1;
        tick(row.chain, row.tx_hash);
        continue;
      }
      const usd = native * histPrice;
      updateTradeStatus(row.id, "success", {
        gas_used: row.gas_used ?? null,
        gas_cost_native: row.gas_cost_native ?? null,
        gas_cost_usd_at_trade: usd,
      });
      report.backfilled += 1;
      tick(row.chain, row.tx_hash);
    } catch (e) {
      report.errors.push({
        chain: row.chain,
        txHash: row.tx_hash,
        message: (e as Error).message,
      });
      opts.logger.warn(
        sanitizeForLogLine(`backfillGasUsd ${row.chain} ${row.tx_hash} error: ${(e as Error).message}`),
      );
      tick(row.chain, row.tx_hash);
    }
  }

  report.elapsedMs = Date.now() - t0;
  report.severity = report.errors.length > 0 ? "warn" : "ok";
  return report;
}

// ── backfill revert reasons (iter670) ─────────────────────────

export interface BackfillRevertReasonReport {
  timestamp: string;
  /** Rows considered (failed swaps with block_number but NULL revert_reason). */
  scanned: number;
  /** Rows where the eth_call replay yielded a decoded revert reason. */
  backfilled: number;
  /** Rows where the replay produced no usable revert data — e.g. RPC dropped
   *  the receipt, or the pre-block state didn't reproduce the revert. Stays
   *  NULL on the row (retryable if RPC quality improves). */
  inconclusive: number;
  /** RPC / DB errors during a single row's processing. */
  errors: Array<{ chain: string; txHash: string; message: string }>;
  /** Iter724: wall-clock ms for the standalone backfill. */
  elapsedMs?: number;
  /** Iter804: worst-bucket severity. "warn" on any per-row error.
   *  inconclusive stays ok (retryable on next sweep — not flagged). */
  severity: "ok" | "warn";
}

/**
 * Iter670: walk legacy failed trades and persist their revert_reason via the
 * iter666 eth_call replay. Symmetric with iter637 block_number / iter643
 * slippage / iter654 gas-USD backfills.
 *
 * Approach:
 *   1. failedTradesWithoutRevertReason returns rows with block_number set
 *      (necessary to pin the replay block) but revert_reason still NULL.
 *   2. For each row: construct a public client per chain (cached), call
 *      extractRevertReasonByHash with the stored block.
 *   3. Persist via updateTradeStatus.
 *
 * Bounded by `limit` (default 200, max 1000) so a single run doesn't burn the
 * RPC budget. Idempotent — re-running picks up where the previous run stopped
 * (no row is queried twice once its reason is set).
 */
export async function backfillRevertReasons(opts: {
  config: Config;
  logger: Logger;
  limit?: number;
  chain?: string;
  account?: string;
}): Promise<BackfillRevertReasonReport> {
  // Iter724: wall-clock timing for standalone callers.
  const t0 = Date.now();
  const { failedTradesWithoutRevertReason, updateTradeStatus } = await import("./db.js");
  const { extractRevertReasonByHash } = await import("./tradeAnalysis.js");
  const { resolveProfile } = await import("./config.js");
  const { http } = await import("viem");
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const rows = failedTradesWithoutRevertReason({
    limit,
    chain: opts.chain,
    account: opts.account,
  });

  const report: BackfillRevertReasonReport = {
    timestamp: new Date().toISOString(),
    scanned: rows.length,
    backfilled: 0,
    inconclusive: 0,
    errors: [],
    severity: "ok",
  };

  // Per-chain client cache — same trick the other backfills + reconcile use.
  // Typed via Parameters of extractRevertReasonByHash so the cache and the
  // call site agree on the publicClient shape (avoids the narrower-than-
  // expected inferred type from createPublicClient + chain).
  type ReplayClient = Parameters<typeof extractRevertReasonByHash>[0]["publicClient"];
  const clientByChain = new Map<string, ReplayClient>();

  // Iter775: shared progress ticker — same helper the other backfills use.
  const tick = makeProgressTicker(opts.logger, "backfillRevertReasons", rows.length);

  for (const row of rows) {
    try {
      if (typeof row.id !== "number") {
        tick(row.chain, row.tx_hash);
        continue;
      }
      let client = clientByChain.get(row.chain);
      if (!client) {
        const profile = resolveProfile(row.chain, opts.config);
        const rpcs = opts.config.chains[row.chain]?.rpcs ?? profile.rpcs;
        const transport = rpcs.length > 0 ? http(rpcs[0]) : http();
        client = createPublicClient({ chain: profile.viemChain, transport }) as ReplayClient;
        clientByChain.set(row.chain, client);
      }
      // block_number is non-null per the query, but TS doesn't know that.
      const blockNumber = row.block_number;
      if (blockNumber == null) {
        report.inconclusive += 1;
        tick(row.chain, row.tx_hash);
        continue;
      }
      const reason = await extractRevertReasonByHash({
        publicClient: client,
        txHash: row.tx_hash,
        blockNumber,
        logger: opts.logger,
      });
      if (reason) {
        updateTradeStatus(row.id, "failed", {
          gas_used: row.gas_used ?? null,
          gas_cost_native: row.gas_cost_native ?? null,
          revert_reason: reason,
        });
        report.backfilled += 1;
      } else {
        // Replay didn't yield a reason — leave NULL so a future re-run can
        // retry (RPC providers vary in revert-data fidelity). Counted
        // separately so operators see the distinction from hard errors.
        report.inconclusive += 1;
      }
      tick(row.chain, row.tx_hash);
    } catch (e) {
      report.errors.push({
        chain: row.chain,
        txHash: row.tx_hash,
        message: (e as Error).message,
      });
      opts.logger.warn(
        sanitizeForLogLine(`backfillRevertReasons ${row.chain} ${row.tx_hash} error: ${(e as Error).message}`),
      );
      tick(row.chain, row.tx_hash);
    }
  }

  report.elapsedMs = Date.now() - t0;
  // Iter804: trigger on errors only — inconclusive rows are retryable
  // (RPC quality may improve on next sweep) but not bad-detected.
  report.severity = report.errors.length > 0 ? "warn" : "ok";
  return report;
}

/** Iter670: terse formatter mirrors the iter654 gas-USD formatter style. */
export function formatBackfillRevertReasonReport(r: BackfillRevertReasonReport): string {
  // Iter732: elapsed suffix.
  const elapsedSuffix = r.elapsedMs != null
    ? ` (${(r.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  if (r.scanned === 0) {
    return `No failed trades without revert_reason — nothing to backfill.${elapsedSuffix}`;
  }
  const lines: string[] = [];
  lines.push(`Backfill revert_reason for ${r.scanned} legacy failed trade${r.scanned === 1 ? "" : "s"}:${elapsedSuffix}`);
  lines.push(`  ✓ backfilled:    ${r.backfilled}`);
  if (r.inconclusive > 0) {
    lines.push(`  ⚠ inconclusive:  ${r.inconclusive} (replay yielded no revert data — retryable on RPC change)`);
  }
  if (r.errors.length > 0) {
    lines.push(`  ! errors:        ${r.errors.length}`);
    for (const e of r.errors.slice(0, 5)) {
      lines.push(`      ${e.chain.padEnd(10)} ${e.txHash}  ${compactMessage(e.message, 60)}`);
    }
    if (r.errors.length > 5) {
      lines.push(`      … and ${r.errors.length - 5} more`);
    }
  }
  if (r.scanned >= 200) {
    lines.push("");
    lines.push("Hit the default 200-row limit — re-run to continue backfilling.");
  } else if (r.backfilled === r.scanned && r.scanned > 0) {
    lines.push("");
    lines.push("All failed-row revert reasons backfilled.");
  }
  return lines.join("\n");
}

// ── combined backfill-all (iter656) ───────────────────────────

export interface BackfillAllReport {
  timestamp: string;
  /** Per-mode sub-reports. Each runs in sequence; if one fails the report
   *  surfaces the partial results — caller doesn't lose the rows already
   *  backfilled by earlier modes. */
  blocks: BackfillBlocksReport;
  slippage: BackfillSlippageReport;
  gasUsd: BackfillGasUsdReport;
  /** Iter670: revert reason backfill (failed-trade rows). */
  revertReasons: BackfillRevertReasonReport;
  /** Total rows backfilled across all four modes. */
  totalBackfilled: number;
  /** Iter723: per-phase wall-clock timing in milliseconds. Scripted
   *  consumers identify slow phases (e.g. "gasUsd took 80% of the time —
   *  CoinGecko rate-limiting?") without parsing logs. Same `phaseTiming`
   *  field shape as iter638's TradeResult.phaseTiming. */
  phaseTimingMs: {
    blocks: number;
    slippage: number;
    gasUsd: number;
    revertReasons: number;
    totalMs: number;
  };
  /** Iter804: worst-bucket severity across all four phases. "warn" when any
   *  phase's severity is "warn"; "ok" otherwise. */
  severity: "ok" | "warn";
}

/**
 * Iter656: run all three backfills in sequence. Convenience for operators
 * upgrading tradekit — instead of three separate `--backfill-blocks` /
 * `--backfill-slippage` / `--backfill-gas-usd` calls, one command covers
 * everything.
 *
 * Order matters: block_number backfill first (other modes can use it
 * indirectly via tx_hash → receipt lookup), then slippage (uses iter619
 * decoded deltas), then gas-USD (uses CoinGecko historical + the row's
 * native gas). Each mode's bounded limit applies independently — caller
 * passes a single `limit` that each mode uses.
 *
 * Idempotent — re-running picks up where the previous run left off
 * (matched-criteria queries skip already-backfilled rows).
 */
export async function backfillAll(opts: {
  config: Config;
  logger: Logger;
  limit?: number;
  chain?: string;
  account?: string;
}): Promise<BackfillAllReport> {
  // Iter722: per-phase progress logging. Operators running
  // `tradekit reconcile --backfill-all` against a large legacy DB used to
  // see a silent 30-second wait. Each phase is now bracketed by a start
  // log + per-phase result count so the operator (and any log scraper)
  // sees real-time progress and knows which phase any per-row warning
  // belongs to. Iter723 also persists the per-phase timing in the report.
  const t0 = Date.now();
  opts.logger.info("backfill-all: phase 1/4 — block_number");
  const tBlocks = Date.now();
  const blocks = await backfillBlockNumbers(opts);
  const blocksMs = Date.now() - tBlocks;
  opts.logger.info(
    `backfill-all: phase 1/4 done — ${blocks.backfilled}/${blocks.scanned} backfilled (${blocksMs}ms)`,
  );
  opts.logger.info("backfill-all: phase 2/4 — realized_slippage_bps");
  const tSlippage = Date.now();
  const slippage = await backfillRealizedSlippage(opts);
  const slippageMs = Date.now() - tSlippage;
  opts.logger.info(
    `backfill-all: phase 2/4 done — ${slippage.backfilled}/${slippage.scanned} backfilled (${slippageMs}ms)`,
  );
  opts.logger.info("backfill-all: phase 3/4 — gas_cost_usd_at_trade");
  const tGasUsd = Date.now();
  const gasUsd = await backfillGasUsd(opts);
  const gasUsdMs = Date.now() - tGasUsd;
  opts.logger.info(
    `backfill-all: phase 3/4 done — ${gasUsd.backfilled}/${gasUsd.scanned} backfilled (${gasUsdMs}ms)`,
  );
  // Iter670: revert-reason backfill needs block_number set, so it runs AFTER
  // the blocks backfill — the same run that just persisted block_numbers for
  // legacy success rows might also help failed rows whose blocks were already
  // captured at reconcile time. Independent of slippage/gasUsd ordering.
  opts.logger.info("backfill-all: phase 4/4 — revert_reason");
  const tRevertReasons = Date.now();
  const revertReasons = await backfillRevertReasons(opts);
  const revertReasonsMs = Date.now() - tRevertReasons;
  opts.logger.info(
    `backfill-all: phase 4/4 done — ${revertReasons.backfilled}/${revertReasons.scanned} backfilled (${revertReasonsMs}ms)`,
  );
  const totalBackfilled =
    blocks.backfilled + slippage.backfilled + gasUsd.backfilled + revertReasons.backfilled;
  const totalMs = Date.now() - t0;
  opts.logger.info(
    `backfill-all: complete — ${totalBackfilled} rows backfilled across 4 phases in ${totalMs}ms`,
  );
  // Iter804: roll-up severity across all four phases.
  const anyWarn =
    blocks.severity === "warn" ||
    slippage.severity === "warn" ||
    gasUsd.severity === "warn" ||
    revertReasons.severity === "warn";
  return {
    timestamp: new Date().toISOString(),
    blocks,
    slippage,
    gasUsd,
    revertReasons,
    totalBackfilled,
    phaseTimingMs: {
      blocks: blocksMs,
      slippage: slippageMs,
      gasUsd: gasUsdMs,
      revertReasons: revertReasonsMs,
      totalMs,
    },
    severity: anyWarn ? "warn" : "ok",
  };
}

/** Iter656: composite formatter showing all three sub-reports. */
export function formatBackfillAllReport(r: BackfillAllReport): string {
  const lines: string[] = [];
  // Iter732: total elapsed in the header for at-a-glance compute cost.
  // Per-phase timings still surface via each sub-formatter (iter732).
  const totalElapsed = r.phaseTimingMs?.totalMs;
  const elapsedSuffix = totalElapsed != null
    ? `  (${(totalElapsed / 1000).toFixed(1)}s total)`
    : "";
  lines.push(`Backfill all — completed ${r.timestamp}${elapsedSuffix}`);
  lines.push(`  Total rows backfilled across modes: ${r.totalBackfilled}`);
  lines.push("");
  lines.push("─ block_number ──");
  lines.push(formatBackfillBlocksReport(r.blocks));
  lines.push("");
  lines.push("─ realized_slippage_bps ──");
  lines.push(formatBackfillSlippageReport(r.slippage));
  lines.push("");
  lines.push("─ gas_cost_usd_at_trade ──");
  lines.push(formatBackfillGasUsdReport(r.gasUsd));
  lines.push("");
  lines.push("─ revert_reason ──");
  lines.push(formatBackfillRevertReasonReport(r.revertReasons));
  // Show re-run hint if any of the four hit its limit.
  const anyMaxed =
    r.blocks.scanned >= 500 ||
    r.slippage.scanned >= 200 ||
    r.gasUsd.scanned >= 200 ||
    r.revertReasons.scanned >= 200;
  if (anyMaxed) {
    lines.push("");
    lines.push("One or more modes hit their per-run limit — re-run `tradekit reconcile --backfill-all` to continue.");
  }
  return lines.join("\n");
}

/** Iter654: terse formatter for the gas-USD backfill report. */
export function formatBackfillGasUsdReport(r: BackfillGasUsdReport): string {
  // Iter732: elapsed suffix.
  const elapsedSuffix = r.elapsedMs != null
    ? ` (${(r.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  if (r.scanned === 0) {
    return `No success swaps without gas_cost_usd_at_trade — nothing to backfill.${elapsedSuffix}`;
  }
  const lines: string[] = [];
  lines.push(`Backfill gas_cost_usd_at_trade for ${r.scanned} legacy swap${r.scanned === 1 ? "" : "s"}:${elapsedSuffix}`);
  lines.push(`  ✓ backfilled:    ${r.backfilled}`);
  if (r.noOracle > 0) {
    lines.push(`  ⚠ no oracle:     ${r.noOracle} (chain's native isn't in CoinGecko's map — permanent)`);
  }
  if (r.apiFailed > 0) {
    lines.push(`  ⚠ api failed:    ${r.apiFailed} (rate limit / network — retryable)`);
  }
  if (r.errors.length > 0) {
    lines.push(`  ! errors:        ${r.errors.length}`);
    for (const e of r.errors.slice(0, 5)) {
      lines.push(`      ${e.chain.padEnd(10)} ${e.txHash}  ${compactMessage(e.message, 60)}`);
    }
    if (r.errors.length > 5) {
      lines.push(`      … and ${r.errors.length - 5} more`);
    }
  }
  if (r.scanned >= 200) {
    lines.push("");
    lines.push("Hit the default 200-row limit — re-run to continue backfilling.");
  } else if (r.backfilled === r.scanned && r.scanned > 0) {
    lines.push("");
    lines.push("All rows backfilled. Tax-quarter PnL + historical gas now use the at-trade USD.");
  } else if (r.apiFailed > 0) {
    lines.push("");
    lines.push(`${r.apiFailed} row${r.apiFailed === 1 ? "" : "s"} hit API failures — re-run later to retry those.`);
  }
  return lines.join("\n");
}

/** Iter643: terse formatter for the backfill report. */
export function formatBackfillSlippageReport(r: BackfillSlippageReport): string {
  // Iter732: elapsed suffix.
  const elapsedSuffix = r.elapsedMs != null
    ? ` (${(r.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  if (r.scanned === 0) {
    return `No success swaps without realized_slippage_bps — nothing to backfill.${elapsedSuffix}`;
  }
  const lines: string[] = [];
  lines.push(`Backfill realized_slippage_bps for ${r.scanned} legacy swap${r.scanned === 1 ? "" : "s"}:${elapsedSuffix}`);
  lines.push(`  ✓ backfilled:    ${r.backfilled}`);
  if (r.inconclusive > 0) {
    lines.push(`  ⚠ inconclusive:  ${r.inconclusive} (no_match/unknown — left NULL)`);
  }
  if (r.errors.length > 0) {
    lines.push(`  ! errors:        ${r.errors.length}`);
    for (const e of r.errors.slice(0, 5)) {
      lines.push(`      ${e.chain.padEnd(10)} ${e.txHash}  ${compactMessage(e.message, 60)}`);
    }
    if (r.errors.length > 5) {
      lines.push(`      … and ${r.errors.length - 5} more`);
    }
  }
  // Same re-run hint as backfill blocks — operators with big histories will
  // hit the default limit.
  if (r.scanned >= 200) {
    lines.push("");
    lines.push("Hit the default 200-row limit — re-run to continue backfilling.");
  } else if (r.backfilled === r.scanned && r.scanned > 0) {
    lines.push("");
    lines.push("All rows backfilled. Auto-slippage (iter642) + cheap aggregator/pair stats now cover historical trades.");
  }
  return lines.join("\n");
}
