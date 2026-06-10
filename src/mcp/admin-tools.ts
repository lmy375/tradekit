// MCP admin tools: status, accounts, audit, config. The wallet/state-management surface.

import { z } from "zod";
import {
  loadConfig,
  resolveProfile,
  saveConfig,
  setConfigPath,
  parseConfigValue,
  pushConfigArray,
  dropConfigArray,
  redactConfigForDisplay,
  getConfigPath,
} from "../config.js";
import {
  listAccounts,
  addAccount,
  setActiveAccount,
} from "../accounts.js";
import { getKeystoreAddress } from "../wallet.js";
import { listAllowances } from "../approvals.js";
import { holdingsOnChain } from "../holdings.js";
import { getCurrentPrice } from "../price.js";
import { recentTrades, recentAudit, matchesTradeToken } from "../db.js";
import { ToolError, toToolError } from "../errors.js";
import { parseDateFilter } from "../format.js";
import { ok, fail, runTool, type RegisterFn } from "./runtime.js";

export const registerAdminTools: RegisterFn = (server, rt) => {
  // ── status ────────────────────────────────────────────────
  server.tool(
    "status",
    "Active account snapshot: address, chain, all non-zero token balances (native + chain profile's known tokens), native USD price, standing approvals (a key risk surface), and recent trades. Units: amounts are decimal strings; usd is USD. Cheap aggregate read — use as a startup verification or to confirm an account/chain is healthy before a trade. Errors: WALLET_NOT_FOUND (no wallet configured — details.reason discriminates `no_wallet` vs `no_mnemonic` vs `keystore_requested_but_absent`), UNKNOWN_CHAIN (chain filter typo — details.suggestion carries the closest match when available). Auxiliary failures (price API down, allowance probe error) are swallowed silently so the snapshot still returns: prices.ETH = null and approvals = [] in that case.",
    {
      chain: z.string().optional().describe("Chain name (default: config.activeChain)."),
    },
    async ({ chain }) => {
      try {
        return ok(
          await runTool("status", rt.opts, { chain }, chain, async () => {
            const config = rt.getConfig();
            const wallet = await rt.getContext(chain);
            const profile = resolveProfile(wallet.chain, config);
            const [holdings, ethPrice, approvals] = await Promise.all([
              holdingsOnChain(wallet.account.address, wallet.chain, config, rt.opts.logger),
              getCurrentPrice(profile.weth, rt.opts.logger).catch(() => null),
              listAllowances(
                { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger: rt.opts.logger },
                {},
              ).catch(() => []),
            ]);
            const nonZero = holdings.balances.filter((b) => parseFloat(b.amount) > 0);
            return {
              ok: true,
              units: { amounts: "decimal", usd: "USD" },
              account: wallet.label,
              address: wallet.account.address,
              chain: wallet.chain,
              chainId: profile.chainId,
              balances: Object.fromEntries(nonZero.map((b) => [b.symbol, { amount: b.amount, usd: b.usd ?? null }])),
              totalUsd: holdings.totalUsd ?? null,
              prices: { [profile.nativeSymbol]: ethPrice },
              approvals: approvals.map((a) => ({
                token: a.symbol,
                spender: a.spenderLabel ?? a.spender,
                allowance: a.display,
              })),
              recentTrades: recentTrades({ chain: wallet.chain, account: wallet.label, limit: 5 }),
              // Iter248: composite-snapshot freshness, matching the wallet view CLI
              // snapshot (iter247) and every other snapshot-style tool (iter218-238).
              // Agents polling status to monitor a position need to know how stale
              // the bundle is — `balances` and `prices` were independently cached so
              // a single envelope timestamp is the honest answer.
              timestamp: new Date().toISOString(),
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── accounts ──────────────────────────────────────────────
  server.tool(
    "accounts",
    "List / manage HD accounts. Actions: list (default) returns all known accounts + the active label; use <label> switches the active account (subsequent tools use this account by default); add <label> [index] derives a new HD account at the given index (next available if omitted). The list action enriches each account with `tradeCount`, `firstTradeAt`, `lastTradeAt` (iter720/iter735 — total trades + first/most-recent ISO timestamps for this account; absent for never-traded accounts like cold-reserve / fresh derivations) AND `syncStale: true` (iter748 — present when ANY bookmark for this account across any chain is older than the 48h threshold used by iter741 PnL / iter743 health / iter746 accounts-list-CLI; absent means either no bookmarks or all fresh). Agents triage activity (how active, how long active) AND sync health (is the cron alive) in one round-trip. The label \"keystore\" is reserved as the single-key wallet identifier and rejected for HD additions. Units: addresses are 0x-prefixed 20-byte hex. Errors: INVALID_PARAMS (missing label for use/add, duplicate label, reserved \"keystore\" label, duplicate index for add), UNKNOWN_ACCOUNT (typo'd label on use — details.suggestion may carry a close match), WALLET_NOT_FOUND (no HD mnemonic configured for add action). When no HD wallet exists, list falls back to a synthetic single-key entry labeled \"keystore\" so agents see SOMETHING is configured.",
    {
      action: z.enum(["list", "use", "add"]).optional().describe("Default: list."),
      label: z.string().optional().describe("Account label — required for `use` and `add`."),
      index: z.number().int().nonnegative().optional().describe("BIP-44 address index for `add`. Defaults to the next available."),
    },
    async ({ action, label, index }) => {
      try {
        return ok(
          await runTool("accounts", rt.opts, { action, label, index }, undefined, async () => {
            const a = action ?? "list";
            if (a === "list") {
              // Iter720/iter735: per-account activity for agent triage. Uses
              // the iter735 richer summary (count + first/last) instead of
              // just lastTradeAt.
              // Iter748: ALSO enrich with syncStale?: true so agents see the
              // same staleness signal CLI operators get from iter746. Single
              // DB read for the bookmarks table — small, cheap.
              const { accountActivitySummary, listSyncBookmarks } = await import("../db.js");
              const activity = accountActivitySummary();
              const STALE_HOURS = 48; // matches iter741 PNL_STALE_BOOKMARK_HOURS + iter746 CLI default
              const thresholdMs = STALE_HOURS * 3_600_000;
              const nowMs = Date.now();
              const staleSet = new Set<string>();
              for (const b of listSyncBookmarks()) {
                if (nowMs - new Date(b.updatedAt).getTime() > thresholdMs) {
                  staleSet.add(b.account);
                }
              }
              const enrich = <T extends { label: string }>(
                a: T,
              ): T & { tradeCount?: number; firstTradeAt?: string; lastTradeAt?: string; syncStale?: boolean } => {
                const act = activity.get(a.label);
                const base = act
                  ? {
                      ...a,
                      tradeCount: act.tradeCount,
                      firstTradeAt: act.firstTradeAt,
                      lastTradeAt: act.lastTradeAt,
                    }
                  : { ...a };
                return staleSet.has(a.label) ? { ...base, syncStale: true } : base;
              };
              const file = listAccounts();
              if (file) {
                return { ok: true, accounts: file.accounts.map(enrich), active: file.active };
              }
              // No HD wallet — fall back to the single-key keystore so agents see what
              // wallet IS configured. Pre-iter234 the response was empty array + null
              // active, which an agent would read as "no wallet exists" even when a
              // single-key keystore was perfectly usable. Matches the CLI's
              // account list keystore-fallback (cli/wallet.ts:241-256).
              const keystoreAddr = getKeystoreAddress();
              if (keystoreAddr) {
                return {
                  ok: true,
                  active: "keystore",
                  accounts: [enrich({ label: "keystore", index: 0, address: keystoreAddr, createdAt: null })],
                };
              }
              return { ok: true, accounts: [], active: null };
            }
            if (a === "use") {
              if (!label) throw new ToolError("INVALID_PARAMS", "label is required for action=use");
              const file = setActiveAccount(label);
              // Invalidate cached WalletContexts so subsequent tools rebuild against the new account.
              rt.invalidateContextCache();
              return { ok: true, active: file.active };
            }
            if (a === "add") {
              if (!label) throw new ToolError("INVALID_PARAMS", "label is required for action=add");
              const entry = addAccount(label, rt.opts.walletPass, index);
              return { ok: true, account: entry };
            }
            throw new ToolError("INVALID_PARAMS", `Unknown action: ${a}`);
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── audit ─────────────────────────────────────────────────
  server.tool(
    "audit",
    "Audit-log of every MCP/CLI/web invocation. action=list (default) returns recent rows up to `limit` PLUS an iter779 inline summary { total, errors, ok } pre-computed over the returned entries (saves an iteration when triaging \"how many of these N rows hit an error\"); action=prune deletes old rows; action=summary (iter631/iter697) returns aggregated counts (by tool, caller, error_code, chain) + error rate over the filtered window — answers 'how many errors in the last 24h' without scrolling listings. Iter771: summary includes `elapsedMs` (wall-clock for the aggregation). Iter834/iter837: summary includes `recommendedActions[]` carrying structured NextAction[] dispatches — per-tool (high error rate on a specific tool → re-run the tool with verbose / call doctor) and per-error-code (e.g. RPC_FAILED entries → `doctor`, INVALID_PARAMS volume → caller review). Agents triaging an error spike branch on recommendedActions directly instead of writing per-code logic. byErrorCode entries include `lastSeen` (ISO timestamp of the most recent occurrence) so agents investigating a code can drill straight to recent rows. Filters (apply to all actions): `since` (ISO date, YYYY-MM-DD, full timestamp, or shortcuts: today/yesterday/Nh/Nd), `tool` (name like 'quote'), `account` (label), `chain`, `caller` (cli/mcp/web — useful for tracing which surface initiated an action), `error_code` (iter695 — exact match against the canonical code like SLIPPAGE_EXCEEDED, useful for pattern investigation), `errors_only` (iter696 — only rows with non-null error_code; convenience for 'what's been breaking'), `tx_hash` (iter705 — exact tx-hash lookup; returns the full audit history of one tx). Prune defaults to DRY-RUN (returns count + range without deleting); pass dryRun=false to actually delete. Iter828: prune dry-run output includes `pctOfTotal` (the percentage of total audit rows being pruned) — operators about to wipe months of history see context. Inspect the dry-run output before re-calling with dryRun=false to avoid wiping more than you intended. Errors: INVALID_PARAMS (bad date shortcut, future date, unknown caller value).",
    {
      action: z.enum(["list", "prune", "summary"]).optional(),
      limit: z.number().int().positive().max(500).optional(),
      since: z.string().optional().describe("ISO date, YYYY-MM-DD, full timestamp, OR shortcuts: today, yesterday, 1h..48h, 1d..30d. Only entries at/after this are returned."),
      tool: z.string().optional().describe("Filter to a single tool name (e.g. 'quote')."),
      account: z.string().optional().describe("Filter to a single account label."),
      chain: z.string().optional().describe("Filter to a single chain."),
      caller: z.enum(["cli", "mcp", "web"]).optional().describe("Filter to entries from a specific surface."),
      error_code: z.string().optional().describe("Iter695: exact match against the canonical error code (e.g. SLIPPAGE_EXCEEDED, TOKEN_BLOCKED). Use for pattern investigation — combine with `since` to scope a window."),
      errors_only: z.boolean().optional().describe("Iter696: when true, only return rows with non-null error_code. Convenience for 'what's been breaking?' investigation."),
      tx_hash: z.string().optional().describe("Iter705: exact tx-hash lookup (case-insensitive). Returns every audit row that touched this hash — the submit call + any follow-up reconcile / view / etc. Matches the iter661 trades --tx pattern."),
      before: z.string().optional().describe("For action=prune: delete entries strictly before this date. Same shortcut shapes as `since`."),
      dryRun: z
        .boolean()
        .optional()
        .describe("For action=prune: TRUE by default (preview only). Pass dryRun=false to actually delete."),
    },
    async ({ action, limit, since, tool, account, chain, caller, error_code, errors_only, tx_hash, before, dryRun }) => {
      try {
        if (action === "prune") {
          if (!before) throw new ToolError("INVALID_PARAMS", "action=prune requires `before` (ISO date).");
          const iso = parseDateFilter(before, "before")!;
          // Same year-typo guard as the CLI's audit prune (iter187): reject dates
          // more than a year in the future, which would otherwise delete all audit
          // history. MCP agents are bound to make occasional date-shift mistakes.
          if (Date.parse(iso) > Date.now() + 365 * 24 * 60 * 60 * 1000) {
            throw new ToolError(
              "INVALID_PARAMS",
              `before ${iso} is more than a year in the future. Did you typo the year? (To delete everything older than now, use today's date.)`,
            );
          }
          const { auditPruneStats, pruneAudit } = await import("../db.js");
          // Always compute stats — even on a real prune the response surfaces what was
          // removed (the count + range), which lets the agent verify the action matched
          // intent without a separate read. Matches the CLI's preview-before-delete UX.
          const stats = auditPruneStats(iso);
          // Iter269: dryRun defaults to TRUE for MCP. Pre-iter269 an agent calling
          // `audit { action: "prune", before: "..." }` would immediately delete —
          // mirroring the same year-typo nightmare iter187 documented for CLI. CLI
          // has the operator confirm at a y/N prompt by default; MCP agents have no
          // such guard. Flip the default to safe-by-default: agents see WHAT would
          // be deleted, then pass dryRun=false explicitly to actually delete. Same
          // discipline as iter256/257 (EIP-55 typo detection) — defensive defaults
          // for destructive ops.
          // Iter828: proportional context — symmetric with iter799 CLI. Agents
          // see "99% of table" obvious-typo cases as concretely as operators
          // do. Cheap single-row COUNT.
          const { openDb } = await import("../db.js");
          const totalRows = (openDb().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
          const pruneSharePct = totalRows > 0 ? (stats.count / totalRows) * 100 : 0;
          const isDryRun = dryRun !== false; // default true; only explicit false executes
          if (isDryRun || stats.count === 0) {
            return ok({
              ok: true,
              dryRun: isDryRun,
              before: iso,
              wouldPrune: stats.count,
              oldestPruned: stats.oldestPruned,
              newestPruned: stats.newestPruned,
              totalRows,
              pruneSharePct,
              remaining: totalRows - stats.count,
            });
          }
          const n = pruneAudit(iso);
          return ok({
            ok: true,
            pruned: n,
            before: iso,
            oldestPruned: stats.oldestPruned,
            newestPruned: stats.newestPruned,
            totalRows,
            pruneSharePct,
            remaining: totalRows - n,
          });
        }
        const sinceIso = parseDateFilter(since, "since");
        // Iter631: summary action returns the aggregate shape instead of row list.
        // Note: audit summary's filters mirror recentAudit's; the new iter695/696
        // filters apply to action=list, not summary (summary's whole purpose is to
        // aggregate across all error codes — filtering to one would defeat it).
        if (action === "summary") {
          const { auditSummary } = await import("../db.js");
          return ok({
            ok: true,
            ...auditSummary({ since: sinceIso, tool, account, chain, caller }),
          });
        }
        // Iter705: validate tx_hash shape at the boundary so a typo gives
        // INVALID_PARAMS instead of zero rows.
        if (tx_hash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) {
          throw new ToolError("INVALID_PARAMS", `tx_hash must be a 0x-prefixed 64-hex-char string, got "${tx_hash}"`);
        }
        const entries = recentAudit(limit ?? 30, {
          since: sinceIso,
          tool,
          account,
          chain,
          caller,
          // Iter695/iter696: normalize error_code to uppercase canonical form.
          errorCode: error_code?.toUpperCase(),
          errorsOnly: errors_only,
          txHash: tx_hash,
        });
        // Iter779: pre-computed summary over the RETURNED entries. Agents
        // commonly want a quick "how many of these N rows hit an error?" read
        // without iterating — same pattern as iter766 recent_trades summary.
        // Scoped to entries that were ACTUALLY returned (post-limit, post-
        // filter), not the whole audit table; for table-wide aggregates the
        // separate action=summary tool exists.
        const errorEntries = entries.filter((e) => e.error_code != null).length;
        return ok({
          ok: true,
          count: entries.length,
          summary: { total: entries.length, errors: errorEntries, ok: entries.length - errorEntries },
          entries,
        });
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── reconcile ─────────────────────────────────────────────
  server.tool(
    "reconcile",
    "Walk every pending trade (status='pending') for the active account, query the chain for receipts, and update the DB. Use this after a TX_TIMEOUT to confirm whether your trade landed. Returns { ok, scanned, resolvedSuccess, resolvedFailed, stillPending, errors[], timestamp, elapsedMs, severity, recommendedActions[] } — per-row RPC failures land in errors[] without aborting the whole walk. Iter801: top-level `severity` is 'ok' (clean walk OR scanned=0) or 'warn' (stillPending>0 OR errors non-empty). Iter831: `recommendedActions[]` carries structured NextAction[] dispatching to `diagnose_pending` for stuck txs and `doctor` for RPC errors; empty when severity='ok'. Filters: `chain` defaults to all chains with pending rows (UNKNOWN_CHAIN if the filter doesn't resolve); `account` defaults to all accounts. An empty pending-trades DB returns scanned=0 — not an error. Iter628: pass `verifyRecent: N` instead to re-check the last N success trades for REORG-driven status flips — returns { ok, scanned, stillSuccess, reorgFailed, reorgMissing, errors[], suspects[{txHash, chain, account, verdict, message}], severity, recommendedActions[] }. Verdicts: 'still_success' (happy path), 'reorg_failed' (chain now reports reverted — reorg flipped the outcome), 'reorg_missing' (receipt vanished — likely deep reorg or RPC lag; flag for review). Conservative by default: surfaces suspects without mutating the DB; pass `autoMark: true` to promote reorg_failed → failed. reorg_missing is NEVER auto-marked (RPC lag would create false-negatives).",
    {
      chain: z.string().optional().describe("Limit to one chain (default: all chains with pending rows)."),
      account: z.string().optional().describe("Limit to one account (default: all)."),
      verifyRecent: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe(
          "Iter628: when set, re-checks the last N success trades for reorg detection (instead of the default pending walk). Returns the VerifyRecentReport shape, not the ReconcileReport shape.",
        ),
      autoMark: z
        .boolean()
        .optional()
        .describe(
          "Iter628: when verifyRecent is set + autoMark=true, promotes 'reorg_failed' suspects to status='failed' in the DB. 'reorg_missing' is never auto-marked (RPC lag would create false negatives — operator decides).",
        ),
      maxReorgDepth: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Iter635: skip rows buried deeper than this many blocks (cheap pre-filter using stored block_number — no RPC roundtrip for finalized trades). Default 256. Set 0 to verify every row regardless of depth.",
        ),
      backfillBlocks: z
        .number()
        .int()
        .positive()
        .max(5000)
        .optional()
        .describe(
          "Iter637: one-time maintenance — walk legacy success trades with NULL block_number, fetch the receipt's blockNumber, persist. Returns { scanned, backfilled, receiptMissing, errors[] } instead of the normal reconcile shape. Idempotent (already-backfilled rows skipped). Bounded at 5000 per call.",
        ),
      backfillSlippage: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe(
          "Iter643: one-time maintenance — walk legacy success swaps with NULL realized_slippage_bps, run iter619 analysis, persist the computed slippage. Returns { scanned, backfilled, inconclusive, errors[] }. Idempotent. Bounded at 2000/call (each row costs 2 RPC calls). Unlocks iter642 auto-slippage for historical data.",
        ),
      backfillGasUsd: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe(
          "Iter654: walk legacy success swaps with NULL gas_cost_usd_at_trade, look up native USD price at row.timestamp via CoinGecko, persist. Returns { scanned, backfilled, noOracle, apiFailed, errors[] }. Date-keyed cache to dedupe API calls; rate-limit-friendly. Bounded at 1000/call. Unlocks tax-quarter accuracy for historical gas.",
        ),
      backfillAll: z
        .boolean()
        .optional()
        .describe(
          "Iter656/iter670: run all four backfills in sequence (blocks → slippage → gas-USD → revert-reasons). Returns { blocks, slippage, gasUsd, revertReasons, totalBackfilled }. Each mode applies its own default limit. Convenience for post-upgrade catch-up — one call instead of four.",
        ),
      backfillRevertReasons: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe(
          "Iter670: walk legacy failed trades with NULL revert_reason but a captured block_number, run the iter666 eth_call replay at block_number-1, persist the decoded reason. Returns { scanned, backfilled, inconclusive, errors[] }. Inconclusive rows leave NULL so a future re-run (with different RPC quality) can retry. Bounded at 1000/call.",
        ),
    },
    async ({ chain, account, verifyRecent, autoMark, maxReorgDepth, backfillBlocks, backfillSlippage, backfillGasUsd, backfillAll, backfillRevertReasons }) => {
      try {
        return ok(
          await runTool(
            "reconcile",
            rt.opts,
            { chain, account, verifyRecent, autoMark, maxReorgDepth, backfillBlocks, backfillSlippage, backfillGasUsd, backfillAll, backfillRevertReasons },
            chain,
            async () => {
            const config = rt.getConfig();
            // Iter287: same chain-filter validation as CLI/web (assertKnownChain).
            // Pre-iter287 a bad chain name silently filtered to zero pending rows.
            const { assertKnownChain } = await import("../chains.js");
            assertKnownChain(chain, config);

            // Iter643: branch on backfillSlippage before blocks (independent paths).
            if (backfillSlippage != null) {
              const { backfillRealizedSlippage } = await import("../reconcile.js");
              const report = await backfillRealizedSlippage({
                config,
                logger: rt.opts.logger,
                limit: backfillSlippage,
                chain,
                account,
              });
              return { ok: true, mode: "backfill_slippage", ...report };
            }

            // Iter654: branch on backfillGasUsd.
            if (backfillGasUsd != null) {
              const { backfillGasUsd: backfillGasUsdFn } = await import("../reconcile.js");
              const report = await backfillGasUsdFn({
                config,
                logger: rt.opts.logger,
                limit: backfillGasUsd,
                chain,
                account,
              });
              return { ok: true, mode: "backfill_gas_usd", ...report };
            }

            // Iter670: branch on backfillRevertReasons.
            if (backfillRevertReasons != null) {
              const { backfillRevertReasons: backfillRevertReasonsFn } = await import("../reconcile.js");
              const report = await backfillRevertReasonsFn({
                config,
                logger: rt.opts.logger,
                limit: backfillRevertReasons,
                chain,
                account,
              });
              return { ok: true, mode: "backfill_revert_reasons", ...report };
            }

            // Iter656: branch on backfillAll — runs all three modes serially.
            if (backfillAll === true) {
              const { backfillAll: backfillAllFn } = await import("../reconcile.js");
              const report = await backfillAllFn({
                config,
                logger: rt.opts.logger,
                chain,
                account,
              });
              return { ok: true, mode: "backfill_all", ...report };
            }

            // Iter637: branch on backfillBlocks first.
            if (backfillBlocks != null) {
              const { backfillBlockNumbers } = await import("../reconcile.js");
              const report = await backfillBlockNumbers({
                config,
                logger: rt.opts.logger,
                limit: backfillBlocks,
                chain,
                account,
              });
              return { ok: true, mode: "backfill_blocks", ...report };
            }

            // Iter628: branch on verifyRecent.
            if (verifyRecent != null) {
              const { verifyRecentSuccess } = await import("../reconcile.js");
              const report = await verifyRecentSuccess({
                config,
                logger: rt.opts.logger,
                limit: verifyRecent,
                chain,
                account,
                autoMark: autoMark === true,
                maxReorgDepth,
              });
              return { ok: true, mode: "verify_recent", ...report };
            }

            const { reconcilePending } = await import("../reconcile.js");
            const report = await reconcilePending({
              config,
              logger: rt.opts.logger,
              chain,
              account,
            });
            return { ok: true, mode: "pending", ...report };
          },
          ),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── recent_trades ─────────────────────────────────────────
  server.tool(
    "recent_trades",
    "Trade history rows from the local DB (read-only — no network calls). Returns { ok, count, summary: { byStatus: { success, failed, pending } }, trades } — iter766 pre-computes status bucket counts so agents reading the response don't iterate trades[] to compute breakdowns; sum across buckets equals count. Filters: `chain`, `account` (defaults to active), `status` (success/failed/pending — use 'pending' to find trades that timed out at receipt-wait; call `reconcile` after to update them), `token` (symbol or 0x-prefix match against base or quote), `note` (case-insensitive substring against notes — useful for campaign tags), `strategy` (iter648 indexed exact-match against the strategy column), `tx_hash` (iter661 exact match — fastest single-row lookup, case-insensitive), `aggregator` (iter662 exact match — kyberswap/openocean/0x/1inch/transfer/etc), `since` (ISO/date/shortcut). Units: base_amount/quote_amount/price are decimal strings; gas_cost_native is decimal native. Empty DB or filters with no matches return trades=[] + summary with zeros — not an error. Errors: INVALID_PARAMS (bad since-date shortcut, future date, or malformed tx_hash).",
    {
      chain: z.string().optional(),
      account: z.string().optional().describe("Default: active account."),
      status: z.enum(["success", "failed", "pending"]).optional(),
      token: z.string().optional().describe("Filter to rows where this symbol or address appears as base or quote. Exact match on symbol; exact or prefix match on address (so '0xabc' matches any token whose address starts with 0xabc)."),
      note: z.string().optional().describe("Case-insensitive substring match against the trade row's `notes` field (use for campaign tags like 'DCA #4')."),
      strategy: z.string().optional().describe("Iter648: exact-match against the structured `strategy` column. Indexed — cheap on huge histories."),
      tx_hash: z.string().optional().describe("Iter661: exact tx-hash lookup (case-insensitive). Faster than fetching the row via the chain RPC; returns tradekit's own record including strategy/realized_slippage_bps/notes."),
      aggregator: z.string().optional().describe("Iter662: exact-match against the aggregator column (kyberswap, openocean, 0x, 1inch, transfer, etc). Case-insensitive."),
      since: z.string().optional().describe("Only return trades with timestamp at-or-after this. Accepts: YYYY-MM-DD, ISO timestamp, today, yesterday, 1h..48h, 1d..30d."),
      limit: z.number().int().positive().max(500).optional(),
    },
    async ({ chain, account, status, token, note, strategy, tx_hash, aggregator, since, limit }) => {
      try {
        return ok(
          await runTool("recent_trades", rt.opts, { chain, account, status, token, note, strategy, tx_hash, aggregator, since, limit }, chain, async () => {
            const sinceIso = parseDateFilter(since, "since");
            // Validate tx_hash shape up-front so a typo gives INVALID_PARAMS
            // instead of silently zero rows.
            if (tx_hash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) {
              throw new ToolError("INVALID_PARAMS", `tx_hash must be a 0x-prefixed 64-hex-char string, got "${tx_hash}"`);
            }
            let rows = recentTrades({ chain, account, limit: limit ?? 50, since: sinceIso, strategy, txHash: tx_hash, aggregator });
            if (status) rows = rows.filter((r) => r.status === status);
            if (token) {
              // Shared predicate (matchesTradeToken from db.ts, iter282) — same rule
              // across CLI/MCP/web: exact symbol/address match plus prefix-on-address.
              const q = token.toLowerCase();
              rows = rows.filter((r) => matchesTradeToken(r, q));
            }
            if (note) {
              const needle = note.toLowerCase();
              rows = rows.filter((r) => (r.notes ?? "").toLowerCase().includes(needle));
            }
            // Iter766: pre-compute per-status counts so agents reading the
            // result don't have to iterate trades[] to learn "how many of
            // each status came back". Always emit zero baseline for all
            // three buckets (success/failed/pending) so consumers don't need
            // presence checks. Sum across buckets equals rows.length.
            const summary = { byStatus: { success: 0, failed: 0, pending: 0 } };
            for (const r of rows) {
              if (r.status === "success") summary.byStatus.success++;
              else if (r.status === "failed") summary.byStatus.failed++;
              else if (r.status === "pending") summary.byStatus.pending++;
            }
            return { ok: true, count: rows.length, summary, trades: rows };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── config ────────────────────────────────────────────────
  server.tool(
    "config",
    "Read or update the tradekit config file. action=show (default — returns the whole config, REDACTED on MCP so API keys never leak into agent context) | get (path required — returns { path, value, set }) | set (path + value required — value is JSON-encoded) | push (path + value, appends to an array field e.g. safety.contractWhitelist.base) | drop (path + value, removes matching item from array). Matches the `tradekit config <action>` CLI. Errors: INVALID_PARAMS (missing path/value for actions that need them, invalid action name, bad JSON in value, schema-rejected value). Note: push/drop on non-array paths throws; set replaces the whole value.",
    {
      action: z.enum(["show", "get", "set", "push", "drop"]).optional(),
      path: z.string().optional().describe("Dotted path, e.g. \"safety.perTxUsdLimit\""),
      value: z.string().optional().describe("New value (JSON-encoded). For set/push/drop."),
    },
    async ({ action, path, value }) => {
      try {
        const a = action ?? "show";
        const config = loadConfig();
        // Always redact in MCP: an LLM agent has no legitimate workflow that needs the
        // raw 0x/1inch keys (the SERVER makes those calls). Returning them just risks
        // them ending up in the agent's transcript / logs / training data.
        if (a === "show") return ok({ ok: true, config: redactConfigForDisplay(config) });
        if (a === "get") {
          if (!path) throw new ToolError("INVALID_PARAMS", "path is required for get");
          // Iter279: use the shared getConfigPath helper. Same as the CLI's config get.
          return ok({ ok: true, path, value: getConfigPath(config, path) });
        }
        if (a === "set") {
          if (!path) throw new ToolError("INVALID_PARAMS", "path is required for set");
          const parsed = value === undefined ? undefined : parseConfigValue(value);
          // Iter313: agent-honest response. CLI iter312 surfaces SET/UPDATE/REMOVE/NO-OP
          // distinctly; the MCP shape now carries the same signal. An agent diffing
          // config state across calls needs to know what actually changed.
          const prev = getConfigPath(config, path);
          const next = setConfigPath(config, path, parsed);
          saveConfig(next);
          let action: "set" | "updated" | "removed" | "noop";
          if (parsed === undefined) {
            action = prev === undefined ? "noop" : "removed";
          } else if (prev === undefined) {
            action = "set";
          } else if (JSON.stringify(prev) === JSON.stringify(parsed)) {
            action = "noop";
          } else {
            action = "updated";
          }
          return ok({ ok: true, action, path, previousValue: prev, value: parsed });
        }
        if (a === "push" || a === "drop") {
          if (!path) throw new ToolError("INVALID_PARAMS", `path is required for ${a}`);
          if (value === undefined) throw new ToolError("INVALID_PARAMS", `value is required for ${a}`);
          const parsedNew = parseConfigValue(value);
          if (a === "push") {
            const { config: next, alreadyPresent, length } = pushConfigArray(config, path, parsedNew);
            saveConfig(next);
            return ok({ ok: true, action: "push", path, length, alreadyPresent });
          } else {
            const { config: next, removed, length } = dropConfigArray(config, path, parsedNew);
            saveConfig(next);
            return ok({ ok: true, action: "drop", path, length, removed });
          }
        }
        throw new ToolError("INVALID_PARAMS", `Unknown action: ${a}`);
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── doctor ────────────────────────────────────────────────
  // Iter586: closes a cross-surface gap — pre-iter586 the rpcFailedChainError
  // helper (iter574) and wrongPasswordError (iter435) emitted nextActions naming
  // `tool: "doctor"`, but only the CLI had a doctor command. MCP agents dispatching
  // on those hints had no tool to call. Wrap runDoctor + return its structured
  // result so the cross-surface hint contract is honored.
  server.tool(
    "doctor",
    "Health check: probes data-dir permissions, RPC reachability + chainId match per chain, wallet decryption (when `pass` is supplied), config sanity, and audit/log file state. Returns { ok, criticalFailures, results[], timestamp, elapsedMs, severity, summary: {ok, warn, fail}, failedChecks[] } — each result has { check, name, severity: 'ok'|'warn'|'fail', message, details? }. Iter787: top-level `severity` is the worst-bucket string across results ('ok' | 'warn' | 'fail'). Iter825: `failedChecks[]` is a pre-filtered slice of results where severity !== 'ok' — dashboards rendering 'what's broken' branch on this without walking results[]. Iter908: `elapsedMs` is wall-clock for the doctor pass (dominated by parallel RPC checks across the configured chains); agents tail this to spot chain-level RPC degradation. Use when an agent receives a nextAction with tool=\"doctor\" (typically after RPC_FAILED or WRONG_PASSWORD), or to verify wallet+chain health before trading.",
    {
      chains: z.array(z.string()).optional().describe("Chains to probe (default: just the active chain). Pass [\"all\"] to expand to every built-in + custom chain."),
      pass: z.string().optional().describe("Wallet password — when supplied, doctor will additionally attempt to decrypt the keystore and report success/failure. Omit for read-only health check."),
    },
    async ({ chains, pass }) => {
      try {
        return ok(
          await runTool("doctor", rt.opts, { chains, pass: pass ? "***" : undefined }, undefined, async () => {
            const { runDoctor } = await import("../doctor.js");
            const { results, criticalFailures, timestamp } = await runDoctor({
              chains,
              walletPass: pass,
              logger: rt.opts.logger,
            });
            return { ok: true, criticalFailures, results, timestamp };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── sync_trades (iter607) ─────────────────────────────────
  // Backfill the local trades DB from on-chain activity. Scans eth_getLogs for
  // Transfer events involving the wallet, then imports each unique tx via
  // importTradeFromTx (idempotent on tx_hash). Use to populate PnL from history
  // done outside tradekit (Uniswap UI swaps, bot trades, etc.).
  server.tool(
    "sync_trades",
    "Scan on-chain Transfer events for the active wallet within a block range and import every discovered swap into the local trades DB. Idempotent — already-imported txs report as duplicates rather than re-inserting. Returns { ok, chain, owner, fromBlock, toBlock, scannedTxCount, inserted, duplicates, skipped, errors[], chunkErrors[], timestamp, elapsedMs, bookmark?, severity, recommendedActions[] } (iter736 — elapsedMs is the wall-clock duration including RPC log fetches + per-tx receipt decodes; iter738 — bookmark records per-(chain,account,owner) resume state so daily cron syncs only scan NEW blocks instead of rescanning the same 30-day window every night, eliminating 96%+ of redundant RPC work). Iter806: top-level `severity` is 'ok' (clean import) or 'warn' (any chunkErrors OR errors). Iter832: `recommendedActions[]` carries structured NextAction[] — dispatches `reconcile` when imports happened (to confirm tx status) and `doctor` when chunk errors suggest RPC issues; empty when severity='ok' and no imports. Per-chunk getLogs failures accumulate in chunkErrors[] without aborting; per-tx import failures accumulate in errors[]. Bookmark advances only on FULL success (no chunkErrors) — partial failures leave the bookmark pinned so retry rescans the same window (dedup absorbs duplicates). Use to backfill PnL from history done outside tradekit (Uniswap UI, MEV bot, custom-router trades). chunkSize defaults to 5000 blocks/request (conservative for public RPCs).",
    {
      chain: z.string().optional(),
      account: z.string().optional().describe("HD account label override; defaults to active."),
      fromBlock: z.string().optional().describe("Starting block (decimal string, e.g. '12345678'). When set, overrides bookmark + sinceDays."),
      toBlock: z.string().optional().describe("Ending block (decimal string). If omitted, defaults to the chain's current head."),
      sinceDays: z.number().int().positive().max(365).optional().describe("Lookback in days (overrides bookmark when set; ignored if fromBlock is set). Default fallback 30 when no bookmark exists. Computed at 7200 blocks/day (12s/block conservative ceiling)."),
      chunkSize: z.number().int().positive().max(50000).optional().describe("Blocks per eth_getLogs request. Default 5000. Lower if you hit RPC range-cap chunkErrors."),
      noBookmark: z.boolean().optional().describe("Iter738: opt out of bookmark resume — force 30d fallback. Use for forensic re-imports."),
      resetBookmark: z.boolean().optional().describe("Iter738: clear the stored bookmark before scanning. Combine with sinceDays to start fresh from a chosen depth."),
    },
    async ({ chain, account, fromBlock, toBlock, sinceDays, chunkSize, noBookmark, resetBookmark }) => {
      try {
        return ok(
          await runTool(
            "sync_trades",
            rt.opts,
            { chain, account, fromBlock, toBlock, sinceDays, chunkSize, noBookmark, resetBookmark },
            chain,
            async () => {
              const config = rt.getConfig();
              const wallet = await rt.getContext(chain, account);
              const { resolveProfile: rp } = await import("../config.js");
              const profile = rp(wallet.chain, config);
              const ownerAddr = wallet.account.address as `0x${string}`;
              const chainName = wallet.chain;
              const accountLabel = wallet.label;

              if (resetBookmark) {
                const { clearSyncBookmark } = await import("../db.js");
                clearSyncBookmark(chainName, accountLabel, ownerAddr);
              }

              const tipBlock = await wallet.publicClient.getBlockNumber();
              const to = toBlock ? BigInt(toBlock) : tipBlock;

              const { resolveBookmarkAwareFromBlock, scanWalletActivity, advanceBookmarkAfterSync } =
                await import("../activitySync.js");
              const useBookmark = !noBookmark;
              const resolved = resolveBookmarkAwareFromBlock({
                chain: chainName,
                account: accountLabel,
                owner: ownerAddr,
                toBlock: to,
                ...(fromBlock ? { explicitFromBlock: BigInt(fromBlock) } : {}),
                ...(sinceDays != null ? { sinceDaysExplicit: sinceDays } : {}),
                useBookmark,
              });

              const report = await scanWalletActivity({
                publicClient: wallet.publicClient,
                profile,
                owner: ownerAddr,
                fromBlock: resolved.fromBlock,
                toBlock: to,
                account: accountLabel,
                logger: rt.opts.logger,
                chunkSize: chunkSize ? BigInt(chunkSize) : undefined,
              });

              const advancedToBlock = useBookmark
                ? advanceBookmarkAfterSync({
                    chain: chainName,
                    account: accountLabel,
                    owner: ownerAddr,
                    toBlock: to,
                    chunkErrors: report.chunkErrors,
                  })
                : undefined;

              if (resolved.bookmarkUsed || advancedToBlock !== undefined) {
                report.bookmark = {
                  used: resolved.bookmarkUsed,
                  ...(resolved.resumedFromBlock != null ? { resumedFromBlock: resolved.resumedFromBlock } : {}),
                  ...(advancedToBlock !== undefined ? { advancedToBlock } : {}),
                };
              }

              const bookmarkJson = report.bookmark
                ? {
                    used: report.bookmark.used,
                    ...(report.bookmark.resumedFromBlock != null
                      ? { resumedFromBlock: report.bookmark.resumedFromBlock.toString() }
                      : {}),
                    ...(report.bookmark.advancedToBlock != null
                      ? { advancedToBlock: report.bookmark.advancedToBlock.toString() }
                      : {}),
                  }
                : undefined;

              return {
                ok: true,
                ...report,
                fromBlock: report.fromBlock.toString(),
                toBlock: report.toBlock.toString(),
                ...(bookmarkJson ? { bookmark: bookmarkJson } : {}),
              };
            },
          ),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── list_sync_bookmarks (iter739) ─────────────────────────
  // Read-only listing of iter737 sync_bookmarks. Lets agents diagnose
  // "which (chain, account) sync targets are tracked + how stale". No
  // clearing exposed here — destructive bookmark ops stay on the CLI
  // --reset-bookmark path so they require interactive operator scope.
  server.tool(
    "list_sync_bookmarks",
    "List sync bookmarks (iter737) — the per-(chain,account,owner) records of the last fully-successful trades_sync block. Returns { ok, count, summary: { fresh, stale, staleAfterHours }, bookmarks: [{ chain, account, owner, lastSyncedBlock, updatedAt, ageMs }], timestamp }. Iter767 — summary pre-computes counts using the 48h staleness threshold shared with iter741 PnL / iter743 health / iter746 accounts; sum of fresh + stale === count. lastSyncedBlock is a decimal string (BigInt-safe). ageMs is now() − updatedAt; agents can flag stale bookmarks (e.g. >48h) as evidence a sync cron has stopped. Read-only — does NOT modify any bookmark. To clear a bookmark, use the CLI `tradekit trades sync --reset-bookmark` flag.",
    {},
    async () => {
      try {
        return ok(
          await runTool("list_sync_bookmarks", rt.opts, {}, undefined, async () => {
            const { listSyncBookmarks } = await import("../db.js");
            const bookmarks = listSyncBookmarks();
            const now = Date.now();
            // Iter767: pre-compute fresh/stale counts. Threshold matches iter741
            // PNL_STALE_BOOKMARK_HOURS so the signal is consistent across surfaces.
            // staleAfterHours is included so consumers know exactly which rule
            // produced the counts — useful if the threshold ever changes.
            const STALE_HOURS = 48;
            const thresholdMs = STALE_HOURS * 3_600_000;
            const summary = { fresh: 0, stale: 0, staleAfterHours: STALE_HOURS };
            const enriched = bookmarks.map((b) => {
              const ageMs = now - new Date(b.updatedAt).getTime();
              if (ageMs > thresholdMs) summary.stale++;
              else summary.fresh++;
              return {
                chain: b.chain,
                account: b.account,
                owner: b.owner,
                lastSyncedBlock: b.lastSyncedBlock.toString(),
                updatedAt: b.updatedAt,
                ageMs,
              };
            });
            return {
              ok: true,
              count: bookmarks.length,
              summary,
              bookmarks: enriched,
              timestamp: new Date().toISOString(),
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── verify (iter626) ──────────────────────────────────────
  // Integrity check across wallet + config + db. Backup verification is
  // deliberately NOT exposed at MCP (consistent with the iter612 backup
  // exclusion — file-path + password operation, agent shouldn't be touching
  // local filesystem secrets paths).
  server.tool(
    "verify",
    "Run integrity checks across wallet, config, and db subsystems. Returns { ok, timestamp, target, checks: [ { name, ok, message, details? } ], passed, failed, elapsedMs, severity, failedChecks[] } — iter785/iter794 elapsedMs is wall-clock for the full orchestration (wallet decrypt is the slowest single step on a real installation). Iter805: top-level `severity` is 'ok' (all passed) or 'fail' (any failed). Iter826: `failedChecks[]` is a pre-filtered slice of checks where ok=false — dashboards rendering 'what's broken' branch on this without iterating the full checks[] array. Wallet checks: keystore present + decryptable, HD mnemonic present + decryptable (when WALLET_PASS is set). Config checks: orphan chain shells (config.chains.X with no fields), invalid token addresses, safety-list entries referencing unknown chains, aggregator.preferred not empty. DB checks: schema version match, stale-pending trades (>24h old), audit-log size threshold. Per-check failures don't abort the suite — every check runs; `ok` aggregates as (failed == 0). Use as a periodic health check (cron-friendly) or before risky operations. NOTE: backup verification is CLI-only — call `tradekit verify backup <file>` from a shell.",
    {
      target: z
        .enum(["all", "wallet", "config", "db"])
        .optional()
        .describe(
          "Subsystem to verify. Default 'all' runs every check. 'backup' is intentionally CLI-only — call from a shell. Backup checks are skipped from MCP-side 'all'.",
        ),
    },
    async ({ target }) => {
      try {
        const effectiveTarget = target ?? "all";
        return ok(
          await runTool("verify", rt.opts, { target: effectiveTarget }, undefined, async () => {
            // Iter794: wall-clock for MCP verify orchestration — symmetric with
            // the CLI's iter785 timing. Wallet decrypt + DB scan dominate.
            const t0 = Date.now();
            const { verifyConfigIntegrity, verifyDbIntegrity, summarizeChecks } = await import("../verify.js");
            const { listChains: lc } = await import("../chains.js");
            const { hasMnemonic, loadMnemonicKeystore, decryptMnemonic } = await import("../accounts.js");
            const { getKeystoreAddress } = await import("../wallet.js");
            const { mnemonicToAccount } = await import("viem/accounts");
            const { openDb } = await import("../db.js");

            const checks = [];

            // Wallet (always runs for "all" + "wallet").
            if (effectiveTarget === "all" || effectiveTarget === "wallet") {
              const keystoreAddr = getKeystoreAddress();
              if (keystoreAddr) {
                checks.push({
                  name: "wallet.keystore.present",
                  ok: true,
                  message: `Keystore present, address ${keystoreAddr}.`,
                  details: { address: keystoreAddr },
                });
              } else {
                checks.push({ name: "wallet.keystore.absent", ok: true, message: "No keystore configured." });
              }
              if (hasMnemonic()) {
                if (process.env.WALLET_PASS) {
                  try {
                    const ks = loadMnemonicKeystore();
                    const mnemonic = decryptMnemonic(ks, process.env.WALLET_PASS);
                    const account = mnemonicToAccount(mnemonic);
                    checks.push({
                      name: "wallet.mnemonic.derives",
                      ok: true,
                      message: `HD mnemonic decrypts + derives ${account.address}.`,
                      details: { address: account.address },
                    });
                  } catch (e) {
                    checks.push({
                      name: "wallet.mnemonic.derive_failed",
                      ok: false,
                      message: `HD mnemonic decrypt failed: ${(e as Error).message}.`,
                    });
                  }
                } else {
                  checks.push({
                    name: "wallet.mnemonic.present",
                    ok: true,
                    message: "HD mnemonic file present (set WALLET_PASS to fully verify).",
                  });
                }
              } else {
                checks.push({ name: "wallet.mnemonic.absent", ok: true, message: "No HD mnemonic configured." });
              }
            }

            // Config.
            if (effectiveTarget === "all" || effectiveTarget === "config") {
              const config = rt.getConfig();
              const knownChains = [...lc(), ...Object.keys(config.chains)];
              checks.push(...verifyConfigIntegrity(config, knownChains));
            }

            // DB.
            if (effectiveTarget === "all" || effectiveTarget === "db") {
              try {
                const db = openDb();
                const schemaRow = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
                const pendingTotal = (db.prepare("SELECT COUNT(*) AS c FROM trades WHERE status = 'pending'").get() as { c: number }).c;
                const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
                const pendingStale = (db
                  .prepare("SELECT COUNT(*) AS c FROM trades WHERE status = 'pending' AND timestamp < ?")
                  .get(cutoff) as { c: number }).c;
                const auditRows = (db.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
                checks.push(
                  ...verifyDbIntegrity({
                    schemaVersion: schemaRow.v ?? 0,
                    expectedSchemaVersion: 3,
                    pendingCount: pendingTotal,
                    pendingOlderThan24h: pendingStale,
                    auditRowCount: auditRows,
                  }),
                );
              } catch (e) {
                checks.push({ name: "db.open_failed", ok: false, message: `DB open failed: ${(e as Error).message}.` });
              }
            }

            const report = summarizeChecks(effectiveTarget, checks);
            report.elapsedMs = Date.now() - t0;
            return report;
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── diagnose_pending (iter622) ────────────────────────────
  // For each pending trade, fetch on-chain state and classify why it's
  // stuck. Returns structured verdicts (action ∈ wait / speedup / speedup_high
  // / cancel_or_speedup_earlier / investigate_stale / wait_and_recheck) so an
  // agent can dispatch the right recovery without manual etherscan triage.
  server.tool(
    "diagnose_pending",
    "Diagnose every pending trade (or filter by chain/account/txHash) and return a structured action recommendation. Returns { ok, count, summary: { byAction: { wait, speedup, speedup_high, cancel_or_speedup_earlier, investigate_stale, wait_and_recheck, unknown } }, diagnoses: [ { txHash, chain, account, txNonce?, walletNonce?, maxFeeGwei?, currentBaseFeeGwei?, ageSeconds, gasState, nonceState, ageBucket, action, message, command? } ], elapsedMs }. Iter795 — summary.byAction pre-computes the verdict mix with always-present zero baseline (sum across buckets === count) so agents triage at a glance without iterating diagnoses[]. Iter910 — elapsedMs is wall-clock for the diagnose loop (per-tx RPC roundtrips dominate); agents tailing responses spot performance regression. Action codes: 'wait' (just submitted, fresh), 'speedup' (underpriced + stuck >5m), 'speedup_high' (very underpriced or stuck >30m — bump multiplier 1.5+), 'cancel_or_speedup_earlier' (an earlier-nonce pending tx is blocking this one — fix THAT one first), 'investigate_stale' (wallet nonce past tx's nonce — may have been reorg'd/replaced; run reconcile), 'wait_and_recheck' (gas looks fine, give it more time). gasState ∈ ok/marginal/underpriced/very_underpriced (compared to current base fee). nonceState ∈ next/blocked_by_earlier/stale. Use to triage stuck trades — the action + command fields let an agent dispatch automatically.",
    {
      chain: z.string().optional(),
      account: z.string().optional().describe("HD account label override; defaults to all accounts with pending trades."),
      txHash: z.string().optional().describe("Narrow to a single hash. Useful for re-checking one tx after a recommended action."),
    },
    async ({ chain, account, txHash }) => {
      try {
        return ok(
          await runTool("diagnose_pending", rt.opts, { chain, account, txHash }, chain, async () => {
            // Iter910: track wall-clock elapsed for parity with iter909 CLI
            // pending path. Agents tailing MCP responses see per-call timing
            // alongside the diagnoses; performance regression visible.
            const t0 = Date.now();
            const config = rt.getConfig();
            const { pendingTrades } = await import("../db.js");
            const { diagnosePendingTx } = await import("../pendingDiagnostics.js");

            let rows = pendingTrades({ chain, account });
            if (txHash) {
              rows = rows.filter((r) => r.tx_hash.toLowerCase() === txHash.toLowerCase());
            }
            // Iter795: byAction summary pre-computed over diagnoses. Always-
            // present zero baseline (matches iter789 CLI pending shape) so
            // agents reading the response branch on summary.byAction.speedup_high
            // > 0 directly instead of iterating diagnoses[]. Sum across buckets
            // === count. Empty-rows path emits zeros for every bucket.
            const emptyByAction = (): Record<string, number> => ({
              wait: 0,
              speedup: 0,
              speedup_high: 0,
              cancel_or_speedup_earlier: 0,
              investigate_stale: 0,
              wait_and_recheck: 0,
              unknown: 0,
            });
            if (rows.length === 0) {
              return {
                ok: true,
                count: 0,
                summary: { byAction: emptyByAction() },
                diagnoses: [],
                elapsedMs: Date.now() - t0,
              };
            }

            const diagnoses = [];
            const walletByChain = new Map<string, Awaited<ReturnType<typeof rt.getContext>>>();
            for (const row of rows) {
              try {
                let wallet = walletByChain.get(row.chain);
                if (!wallet) {
                  wallet = await rt.getContext(row.chain, row.account);
                  walletByChain.set(row.chain, wallet);
                }
                const profile = resolveProfile(row.chain, config);
                const diagnosis = await diagnosePendingTx({
                  row,
                  walletAddress: wallet.account.address,
                  publicClient: wallet.publicClient,
                  profile,
                  logger: rt.opts.logger,
                });
                diagnoses.push(diagnosis);
              } catch (e) {
                rt.opts.logger.debug(`diagnose_pending: skipped ${row.tx_hash}: ${(e as Error).message}`);
              }
            }

            const byAction = emptyByAction();
            for (const d of diagnoses) {
              if (d.action in byAction) byAction[d.action]++;
              else byAction.unknown++;
            }

            return { ok: true, count: diagnoses.length, summary: { byAction }, diagnoses, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── analyze_trade (iter619) ───────────────────────────────
  // Post-trade execution quality analysis. Compares the QUOTED amounts stored
  // at trade time against the ACTUAL on-chain deltas (decoded from the
  // receipt's Transfer events via iter265's computeDeltasFromLogs), reports
  // realized slippage + quality verdict.
  //
  // Modes:
  //   - txHash: analyze one specific trade.
  //   - recent: analyze the N most-recent SUCCESS trades (default behavior
  //     when neither is set — returns last 10).
  //
  // Verdict codes (stable across iters; new codes are additive): excellent,
  // ok, minor_slip, major_slip, extreme_slip, reverted, pending, no_match,
  // unknown. Agent classifiers branch on `analyses[i].finding.code`.
  server.tool(
    "analyze_trade",
    "Compare quoted vs actual on-chain amounts for one or more completed trades. Returns { ok, count, analyses: [ { txHash, chain, direction, baseSymbol, quoteSymbol, comparison: {quoted, actual, slippageBps, outputDelta, finding}, finding: {code, message}, gasCostNative, revertReason? } ], elapsedMs }. `finding.code` is one of: excellent (<=5 bps), ok (<=30 bps), minor_slip (<=100 bps), major_slip (<=500 bps), extreme_slip (>500 bps), reverted, pending, no_match (on-chain logs don't contain stored tokens), unknown. slippageBps is positive when unfavorable (got LESS out than quoted), negative when the router beat the quote. `revertReason` (iter666) is populated for failed trades via an eth_call replay at the pre-inclusion block — surfaces the actual revert string (Error/Panic/known custom error) instead of a generic 'reverted' message. Iter911: `elapsedMs` is wall-clock for the analyze loop (per-tx RPC roundtrips dominate); use to budget batch calls and detect chain-side RPC degradation. Use to retro a single trade (pass txHash) or to spot pattern issues across recent fills (pass recent=N — typical N is 10-50). `strategy` / `aggregator` (iter664/iter665) scope the recent-N selection to one strategy or aggregator. `status` (iter667): success (default — preserves pre-iter667 behavior) | failed (unlocks batch revert-reason view) | all. Errors: INVALID_PARAMS (txHash not in DB — call import_trade first).",
    {
      txHash: z.string().optional().describe("Specific tx hash to analyze. If omitted, analyzes the most-recent success trades (count from `recent`)."),
      recent: z.number().int().positive().max(100).optional().describe("Number of recent success trades to analyze when txHash is omitted. Default 10."),
      chain: z.string().optional(),
      account: z.string().optional().describe("HD account label override; defaults to active."),
      strategy: z.string().optional().describe("Iter664: scope --recent N to one strategy tag (ignored when txHash is set)."),
      aggregator: z.string().optional().describe("Iter665: scope --recent N to one aggregator (ignored when txHash is set)."),
      status: z.enum(["success", "failed", "all"]).optional().describe("Iter667: scope --recent N to one status. Default 'success' preserves pre-iter667 behavior. 'failed' unlocks the iter666 batch revert-reason view. Ignored when txHash is set."),
    },
    async ({ txHash, recent, chain, account, strategy, aggregator, status }) => {
      try {
        return ok(
          await runTool("analyze_trade", rt.opts, { txHash, recent, chain, account, strategy, aggregator, status }, chain, async () => {
            // Iter911: wall-clock for the analyze loop (per-tx RPC roundtrips
            // for receipt decode + iter666 revert-replay). Wall-clock scales
            // ~linearly with row count; tracking it lets agents budget the
            // call and detect chain-side RPC degradation.
            const t0 = Date.now();
            const config = rt.getConfig();
            const { recentTrades } = await import("../db.js");
            const { analyzeStoredTrade } = await import("../tradeAnalysis.js");
            const { resolveProfile: rp } = await import("../config.js");

            let rows;
            if (txHash) {
              const candidate = recentTrades({ chain, account, limit: 1000 })
                .filter((r) => r.tx_hash.toLowerCase() === txHash.toLowerCase());
              if (candidate.length === 0) {
                const { ToolError } = await import("../errors.js");
                throw new ToolError(
                  "INVALID_PARAMS",
                  `No trade row found for tx ${txHash}. Call import_trade first.`,
                );
              }
              rows = candidate;
            } else {
              // Iter667: same pool-N×10 + post-filter semantics as the CLI so
              // `--recent 10 --status=failed` means "last 10 failed trades"
              // rather than "the failed ones among the last 10 of any status".
              const wantedN = recent ?? 10;
              const statusFilter = status ?? "success";
              const poolSize = statusFilter === "all" ? wantedN : wantedN * 10;
              const pool = recentTrades({ chain, account, limit: poolSize, strategy, aggregator });
              const matching = statusFilter === "all" ? pool : pool.filter((r) => r.status === statusFilter);
              rows = matching.slice(0, wantedN);
              if (rows.length === 0) {
                const noun = statusFilter === "all" ? "trades" : `${statusFilter} trades`;
                return { ok: true, count: 0, analyses: [], note: `No ${noun} to analyze.`, elapsedMs: Date.now() - t0 };
              }
            }

            const wallet = await rt.getContext(chain, account);
            const analyses = [];
            for (const row of rows) {
              const profile = rp(row.chain, config);
              const analyzed = await analyzeStoredTrade({
                row,
                publicClient: wallet.publicClient,
                profile,
                logger: rt.opts.logger,
              });
              analyses.push(analyzed);
            }

            return { ok: true, count: analyses.length, analyses, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── address (iter614) ─────────────────────────────────────
  // Address book — named recipient aliases. action=list (default) returns the
  // saved entries; add/remove mutate. Use `@name` as the `to` field in transfer
  // to resolve via the book (the transfer flow expands aliases at the boundary).
  server.tool(
    "address",
    "Address book — named recipient aliases for transfer recipients. action=list (default) returns saved entries; action=add adds/overwrites (name + address + optional note + optional overwrite); action=remove deletes by name. Entries stored at $HOME/.tradekit/address-book.json with 0600 perms. Use `@name` as the transfer `to` field to resolve via the book (defends against clipboard-hijack + typo errors). Errors: INVALID_PARAMS (bad name shape — [a-zA-Z0-9_-]+ only, max 64 chars; bad address shape; note too long; book full at 200 entries; name exists without overwrite), UNKNOWN_RECIPIENT (typo on remove — details.suggestion may carry a close match).",
    {
      action: z.enum(["list", "add", "remove"]).optional(),
      name: z.string().optional().describe("Required for add/remove. [a-zA-Z0-9_-]+, max 64 chars."),
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "address must be 0x-prefixed 40 hex chars (20-byte EVM address)")
        .optional()
        .describe("Required for add. EIP-55 checksum or raw hex; normalized to lowercase."),
      note: z.string().max(200).optional().describe("Free-form note (max 200 chars)."),
      overwrite: z.boolean().optional().describe("For add: replace an existing entry with this name. Default false."),
    },
    async ({ action, name, address, note, overwrite }) => {
      try {
        const a = action ?? "list";
        const { listAddressEntries, addAddressEntry, removeAddressEntry } = await import("../addressBook.js");
        return ok(
          await runTool("address", rt.opts, { action: a, name, address }, undefined, async () => {
            if (a === "list") {
              const entries = listAddressEntries();
              return { ok: true, action: "list" as const, count: entries.length, entries, timestamp: new Date().toISOString() };
            }
            if (a === "add") {
              if (!name || !address) {
                throw new ToolError(
                  "INVALID_PARAMS",
                  "address.add requires both name and address.",
                  { details: { reason: "missing_args", missing: !name ? "name" : "address" } },
                );
              }
              const entry = addAddressEntry({ name, address, note, overwrite });
              return { ok: true, action: "added" as const, entry, timestamp: new Date().toISOString() };
            }
            // remove
            if (!name) {
              throw new ToolError(
                "INVALID_PARAMS",
                "address.remove requires name.",
                { details: { reason: "missing_args", missing: "name" } },
              );
            }
            const removed = removeAddressEntry(name);
            return { ok: true, action: "removed" as const, entry: removed, timestamp: new Date().toISOString() };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── speedup_tx ────────────────────────────────────────────
  // Iter603: replace a stuck pending tx with a same-nonce, higher-gas
  // replacement so it lands. Closes a real production gap — previously the
  // operator had no recovery path inside tradekit for a stuck low-gas tx.
  server.tool(
    "speedup_tx",
    "Replace a pending tx with the same to/value/data at the same nonce but higher gas (default 1.2x). The original gets dropped by mempool replacement rules; the new tx lands. Use when a tx is stuck due to a mempool gas spike after submit. Returns { action: \"speedup\", originalHash, newHash, nonce, multiplier, originalGas, newGas, explorerUrl }. Errors: TX_NOT_FOUND (tx unknown on this chain — wrong chain or bad hash), INVALID_PARAMS (already mined / not owned by active wallet / multiplier < 1.1 replacement-rule floor), TX_REVERTED (rare — usually means the wallet's nonce moved past the original between fetch and send, in which case the original tx is no longer stuck). Requires wallet password (signs the replacement). Cross-surface: this is the typed recovery for a TX_TIMEOUT / replacement-underpriced situation.",
    {
      chain: z.string().optional().describe("Chain the original tx is on (default: active chain)."),
      txHash: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be 0x-prefixed 64 hex chars (32-byte transaction hash)")
        .describe("Hash of the pending tx to speed up."),
      multiplier: z
        .number()
        .min(1.1, "multiplier must be ≥ 1.1 (geth's +10% replacement-rule floor)")
        .optional()
        .describe("Gas multiplier vs. the original tx (default 1.2). Higher = pays more, lands faster."),
      pass: z.string().optional().describe("Wallet password (or set WALLET_PASS env). Required — signs the replacement tx."),
    },
    async ({ chain, txHash, multiplier, pass }) => {
      try {
        return ok(
          await runTool("speedup_tx", rt.opts, { chain, txHash, multiplier }, chain, async () => {
            const config = rt.getConfig();
            const { resolveProfile: rp } = await import("../config.js");
            const { loadWallet } = await import("../wallet.js");
            const profile = rp(chain ?? config.activeChain, config);
            const walletPass = pass ?? process.env.WALLET_PASS;
            if (!walletPass) {
              throw new ToolError(
                "WRONG_PASSWORD",
                "speedup_tx requires the wallet password to sign the replacement tx. Pass `pass` or set WALLET_PASS env.",
                { details: { reason: "missing_password" } },
              );
            }
            const wallet = await loadWallet(walletPass, profile, config.chains[profile.name]?.rpcs ?? [], rt.opts.logger);
            const { speedupTx } = await import("../txOps.js");
            return await speedupTx({
              txHash: txHash as `0x${string}`,
              multiplier,
              ctx: { publicClient: wallet.publicClient, walletClient: wallet.walletClient, profile, logger: rt.opts.logger },
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── cancel_tx ─────────────────────────────────────────────
  // Iter603: replace a pending tx with a zero-value self-send at the same
  // nonce + higher gas. Effectively cancels the original — the nonce position
  // is consumed by the cheap self-send instead.
  server.tool(
    "cancel_tx",
    "Cancel a pending tx by replacing it with a zero-value self-send at the same nonce + higher gas (default 1.2x). The original tx's intent is dropped — only the gas cost of the cancel transaction is incurred. DESTRUCTIVE: the original swap/transfer/approve will NOT execute. Requires `confirm=true` opt-in (parity with the CLI's `--yes`). Returns { action: \"cancel\", originalHash, cancelHash, nonce, multiplier, originalGas, newGas, explorerUrl }. Errors mirror speedup_tx (TX_NOT_FOUND, INVALID_PARAMS for already-mined / not-owned / multiplier-too-low / confirm-not-set, TX_REVERTED).",
    {
      chain: z.string().optional().describe("Chain the original tx is on (default: active chain)."),
      txHash: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be 0x-prefixed 64 hex chars (32-byte transaction hash)")
        .describe("Hash of the pending tx to cancel."),
      multiplier: z
        .number()
        .min(1.1, "multiplier must be ≥ 1.1 (geth's +10% replacement-rule floor)")
        .optional()
        .describe("Gas multiplier vs. the original tx (default 1.2). Higher = cancel lands faster."),
      confirm: z.boolean().describe("MUST be true. Explicit opt-in for the destructive operation — the original tx's intent is dropped. Set to false (or omit) and the call rejects with INVALID_PARAMS."),
      pass: z.string().optional().describe("Wallet password (or set WALLET_PASS env). Required — signs the cancel tx."),
    },
    async ({ chain, txHash, multiplier, confirm, pass }) => {
      try {
        if (confirm !== true) {
          throw new ToolError(
            "INVALID_PARAMS",
            "cancel_tx requires explicit confirm=true. Cancel drops the original tx's intent (swap/transfer/approve will NOT execute) — confirm only when that's what you want.",
            { details: { reason: "confirm_required" } },
          );
        }
        return ok(
          await runTool("cancel_tx", rt.opts, { chain, txHash, multiplier, confirm }, chain, async () => {
            const config = rt.getConfig();
            const { resolveProfile: rp } = await import("../config.js");
            const { loadWallet } = await import("../wallet.js");
            const profile = rp(chain ?? config.activeChain, config);
            const walletPass = pass ?? process.env.WALLET_PASS;
            if (!walletPass) {
              throw new ToolError(
                "WRONG_PASSWORD",
                "cancel_tx requires the wallet password to sign the cancel tx. Pass `pass` or set WALLET_PASS env.",
                { details: { reason: "missing_password" } },
              );
            }
            const wallet = await loadWallet(walletPass, profile, config.chains[profile.name]?.rpcs ?? [], rt.opts.logger);
            const { cancelTx } = await import("../txOps.js");
            return await cancelTx({
              txHash: txHash as `0x${string}`,
              multiplier,
              ctx: { publicClient: wallet.publicClient, walletClient: wallet.walletClient, profile, logger: rt.opts.logger },
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── engine_status ────────────────────────────────────────
  //
  // Read the supervisor's status file (~/.tradekit/.engine.status.json),
  // augmented with derived freshness signals (seconds-since-last-tick).
  // Read-only — does NOT start an engine; only reports what's running.
  server.tool(
    "engine_status",
    "Read the engine supervisor's status file. Returns { ok, running, pid, pidAlive, startedAt, uptimeSeconds, stalenessSeconds, workers: [{ name, intervalMs, ticks, successes, failures, lastTickAt, lastTickData, lastError, nextTickDueAt, stalenessSeconds }] }. When no engine has ever run on this install, returns { ok: false, running: false, message }. The pidAlive field uses process.kill(pid, 0) — distinguishes a clean stop (pidAlive=false + stopping=true) from a crash (pidAlive=false + stopping=false) from a healthy run (pidAlive=true + stopping=false).",
    {},
    async () => {
      try {
        return ok(
          await runTool("engine_status", rt.opts, {}, undefined, async () => {
            const { readEngineStatus, tickStalenessSeconds } = await import("../engine.js");
            const status = readEngineStatus();
            if (!status) {
              return { running: false, message: "No engine has ever run on this install." };
            }
            const pidAlive = (() => {
              try {
                process.kill(status.pid, 0);
                return true;
              } catch (e) {
                return (e as NodeJS.ErrnoException).code === "EPERM";
              }
            })();
            return {
              running: pidAlive && !status.stopping,
              pid: status.pid,
              pidAlive,
              startedAt: status.startedAt,
              updatedAt: status.updatedAt,
              uptimeSeconds: Math.floor((Date.now() - Date.parse(status.startedAt)) / 1000),
              stalenessSeconds: tickStalenessSeconds(status.updatedAt),
              workers: status.workers.map((w) => ({
                ...w,
                stalenessSeconds: tickStalenessSeconds(w.lastTickAt),
              })),
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── engine_run ────────────────────────────────────────────
  //
  // Single-tick equivalent of `tradekit engine run --once`. Useful for
  // agent loops that want to drive the engine themselves (rather than
  // delegating to an external systemd unit). Holds the engine lock for
  // the duration of one round and releases on return.
  server.tool(
    "engine_run",
    "Run ONE tick round of the unified engine supervisor: fan out the orders / schedules / reconcile workers in parallel, collect per-worker results, release the lock, return. Mutually exclusive — if another `engine run` daemon holds the lock, this call fails with WALLET_LOCKED + the holder pid. Pass `workers` to subset (e.g. just reconcile, which doesn't need a password). dryRun=true evaluates triggers without sending tx. Returns the SupervisorRunResult shape: { startedAt, stoppedAt, uptimeMs, workers: WorkerStatus[], reason }.",
    {
      workers: z
        .array(z.enum(["orders", "schedules", "reconcile"]))
        .optional()
        .describe("Worker name subset. Defaults to every worker whose config.engine.workers.*.enabled=true."),
      dryRun: z.boolean().optional().describe("Evaluate triggers + advance bookkeeping but do NOT send tx. Default false."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("engine_run", rt.opts, input, undefined, async () => {
            const { runEngineSupervisor } = await import("../engine.js");
            return await runEngineSupervisor({
              workers: input.workers,
              password: input.dryRun ? undefined : rt.opts.walletPass,
              dryRun: input.dryRun,
              maxTicks: 1,
              logger: rt.opts.logger,
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── notify_list ───────────────────────────────────────────
  //
  // Inspection helper for the notification system. Returns the configured
  // channels with auto-detected format and URLs path-masked. URLs are
  // ALWAYS redacted via redactWebhookUrl — there's no MCP path that
  // exposes raw webhook URLs (parallel to how aggregator API keys are
  // never exposed via MCP). Operators needing the raw value run the CLI's
  // `config show --show-secrets`.
  server.tool(
    "notify_list",
    "List configured notification channels with their auto-detected format (slack | discord | telegram | generic), event allowlist, severity floor, and enable flag. Webhook URLs are path-masked — the host is preserved for routing verification but the auth-bearing path component is replaced with [REDACTED]. Returns { ok, summary: { total, enabled }, dedupWindowMs, items: [{ name, url (redacted), format, events, minSeverity, enabled, timeoutMs }] }.",
    {},
    async () => {
      try {
        return ok(
          await runTool("notify_list", rt.opts, {}, undefined, async () => {
            const { redactWebhookUrl } = await import("../config.js");
            const { detectFormat } = await import("../notify.js");
            const cfg = rt.getConfig();
            const channels = cfg.notifications?.channels ?? [];
            return {
              dedupWindowMs: cfg.notifications?.dedupWindowMs ?? 60_000,
              summary: {
                total: channels.length,
                enabled: channels.filter((c) => c.enabled).length,
              },
              items: channels.map((c) => ({
                ...c,
                url: redactWebhookUrl(c.url),
                format: detectFormat(c.url),
              })),
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── notify_test ───────────────────────────────────────────
  //
  // Send a synthetic event so an agent / operator can verify channel
  // wiring without waiting for a real order/trade event to fire. By
  // default fans out to every channel; pass `channel: "name"` to scope
  // to one. Returns the per-channel dispatch report — never throws on
  // delivery failure (a Slack outage shouldn't break the agent flow).
  server.tool(
    "notify_test",
    "Dispatch a synthetic test notification to verify channel wiring. With no args, fans out to every channel (subject to per-channel events/minSeverity filters); pass `channel` to target one channel by name. Returns the per-channel DispatchResult report — never throws on delivery failure. Use this AFTER `notify_list` confirms the channel is configured, and BEFORE leaving the engine running unattended. Errors: INVALID_PARAMS (no channels configured, unknown channel name, invalid severity).",
    {
      channel: z.string().optional().describe("Channel name (from notify_list). Omit to fan out to every channel."),
      severity: z.enum(["info", "warn", "critical"]).optional().describe("Severity of the synthetic event (default: info). Useful for testing severity-gated channels."),
      event: z.string().optional().describe("Event name to use on the synthetic message (default: 'test'). Set to e.g. 'order.filled' to test a channel that's allowlisted to specific events."),
    },
    async ({ channel, severity, event }) => {
      try {
        return ok(
          await runTool("notify_test", rt.opts, { channel, severity, event }, undefined, async () => {
            const { notify } = await import("../notify.js");
            const cfg = rt.getConfig();
            const channels = cfg.notifications?.channels ?? [];
            if (channels.length === 0) {
              throw new ToolError(
                "INVALID_PARAMS",
                "No notification channels configured. Add one via `config push notifications.channels '{...}'`.",
              );
            }
            let active = cfg;
            if (channel) {
              const target = channels.find((c) => c.name === channel);
              if (!target) {
                throw new ToolError(
                  "INVALID_PARAMS",
                  `Unknown channel "${channel}". Available: ${channels.map((c) => c.name).join(", ")}.`,
                  { details: { provided: channel, available: channels.map((c) => c.name) } },
                );
              }
              active = { ...cfg, notifications: { ...cfg.notifications, channels: [target] } };
            }
            const t0 = Date.now();
            const report = await notify(
              {
                event: event ?? "test",
                severity: severity ?? "info",
                title: "tradekit notify test (MCP)",
                body: "Synthetic test event dispatched via the MCP notify_test tool.",
                fields: {
                  source: "tradekit",
                  hostname: process.env.HOSTNAME ?? null,
                  pid: process.pid,
                },
              },
              active,
              rt.opts.logger,
            );
            return { ...report, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── engine_lock (iter28) ─────────────────────────────────
  //
  // Global kill switch. ALL trading paths (orders engine, schedules
  // engine, rebalance engine, manual trades via executeTrade, post-
  // fill hooks) reject with ENGINE_LOCKED until the operator calls
  // engine_unlock. Orders engine continues TICKING (HWM tracking
  // stays fresh) but skips the FIRE path.
  //
  // Idempotent: re-locking an already-locked engine updates the
  // timestamp + reason but doesn't double-notify (the runtime
  // dedups by `engine.locked:<locked_at>`).
  server.tool(
    "engine_lock",
    "Engage the global engine kill switch. ALL trading paths reject with ENGINE_LOCKED until engine_unlock is called. Orders engine continues ticking (HWM tracking) but skips the fire path — trailing stops stay correctly positioned for resume. Idempotent. Use for incident response (oracle outage, suspected key compromise, market crash) or maintenance windows. Requires `yes: true` (destructive — operator should confirm intent).",
    {
      reason: z.string().min(1).max(500).optional().describe("Free-text reason for the lock (logged + shown in audit + ENGINE_LOCKED errors)."),
      yes: z.literal(true).describe("Confirmation flag — lock affects every trading path; must be true."),
    },
    async ({ reason, yes }) => {
      try {
        return ok(
          await runTool("engine_lock", rt.opts, { reason, yes }, undefined, async () => {
            if (!yes) {
              throw new ToolError("INVALID_PARAMS", `Confirmation flag required: pass yes=true.`);
            }
            const { lockEngine } = await import("../engineLock.js");
            const row = await lockEngine({
              reason: reason ?? null,
              lockedBy: "mcp",
              config: rt.getConfig(),
              logger: rt.opts.logger,
            });
            return { ok: true, state: row };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── config_preflight (iter35) ────────────────────────────
  //
  // Computes the impact of (currently-saved config, proposed
  // config) against the live active-primitive state. The proposed
  // config is supplied INLINE — agents pass the full config object
  // (or just the keys they want to change, merged onto current)
  // and get the structured ImpactReport back. No DB writes.
  server.tool(
    "config_preflight",
    "Dry-run impact analysis of a proposed config change. Given an inline `proposed` config (full shape OR a partial overlay merged onto current via deep-merge), returns a typed ImpactReport: per-key diffs + severity-tagged warnings + which active primitives (orders, schedules, drawdown scopes) would be impacted. Critical = current state violates new rules (must act); warn = future fires might block; info = observable but harmless. No DB writes. Use BEFORE setting a config value via the host's file-system access. Errors: INVALID_PARAMS (proposed shape fails Zod validation — error.details.zodIssues carries the per-path validation errors).",
    {
      proposed: z.unknown().describe("Either a full Config object OR a partial overlay (deep-merged onto current). The merge result is validated via configSchema."),
      merge: z.boolean().default(true).describe("When true (default), deep-merges `proposed` onto current config before validation. When false, treats `proposed` as a complete replacement."),
    },
    async ({ proposed, merge }) => {
      try {
        return ok(
          await runTool("config_preflight", rt.opts, { proposed, merge }, undefined, async () => {
            const current = rt.getConfig();
            const { configSchema } = await import("../config.js");
            const merged = merge
              ? deepMerge(current as unknown as Record<string, unknown>, proposed as Record<string, unknown>)
              : proposed;
            let newConfig;
            try {
              newConfig = configSchema.parse(merged);
            } catch (e) {
              const issues = (e as { issues?: unknown }).issues;
              throw new ToolError(
                "INVALID_PARAMS",
                `Proposed config failed schema validation: ${(e as Error).message}`,
                { details: { zodIssues: issues } },
              );
            }
            const { computeConfigImpact } = await import("../configPreflight.js");
            const { listOrders, listSchedules, listDrawdownStates } = await import("../db.js");
            const impact = computeConfigImpact({
              oldConfig: current,
              newConfig,
              state: {
                orders: listOrders({}),
                schedules: listSchedules({}),
                drawdowns: listDrawdownStates(),
              },
            });
            return { impact };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── engine_unlock (iter28) ───────────────────────────────
  server.tool(
    "engine_unlock",
    "Release the global engine kill switch. Trading paths resume on the next tick (or immediately for manual trades). Idempotent — unlocking an already-unlocked engine is a no-op. Requires `yes: true`.",
    {
      yes: z.literal(true).describe("Confirmation flag — must be true."),
    },
    async ({ yes }) => {
      try {
        return ok(
          await runTool("engine_unlock", rt.opts, { yes }, undefined, async () => {
            if (!yes) {
              throw new ToolError("INVALID_PARAMS", `Confirmation flag required: pass yes=true.`);
            }
            const { unlockEngine } = await import("../engineLock.js");
            const row = await unlockEngine({
              config: rt.getConfig(),
              logger: rt.opts.logger,
              unlockedBy: "mcp",
            });
            return { ok: true, state: row };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── bulk_halt (iter37) ──────────────────────────────────────
  //
  // Scoped halt: cancel matching orders + pause matching
  // schedules + pause matching rebalances in one atomic batch.
  // Mirrors the CLI surface; agents drive incident response or
  // scheduled rotations the same way an operator would.
  server.tool(
    "bulk_halt",
    "Bulk halt: scoped cancel/pause across orders + schedules + rebalances in one atomic batch. At least one filter (strategy/chain/account) is required, or pass `all: true` to confirm unscoped intent. Returns the executed plan + per-row results. Halt semantics: orders → cancel (terminal), schedules → pause (reversible), rebalances → pause (reversible). Already-terminal rows are skipped with a reason. Use `dryRun: true` to preview without mutating. Emits one bulk.halt notification. Errors: INVALID_PARAMS (no scope + no `all`, unknown type).",
    {
      strategy: z.string().optional().describe("Exact strategy tag (e.g. 'dca-eth' or 'playbook:1')."),
      chain: z.string().optional().describe("Chain name (case-insensitive)."),
      account: z.string().optional().describe("Account label."),
      types: z
        .array(z.enum(["orders", "schedules", "rebalances"]))
        .optional()
        .describe("Restrict to specific primitive types. Default: all three."),
      all: z.boolean().optional().describe("Required when no filter is set — confirms unscoped intent."),
      dryRun: z.boolean().default(false).describe("When true, plan only; no DB writes."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("bulk_halt", rt.opts, input, input.chain, async () => {
            const { planHalt, executeHalt } = await import("../bulkOps.js");
            const plan = planHalt({
              strategy: input.strategy,
              chain: input.chain,
              account: input.account,
              types: input.types,
              all: input.all,
            });
            if (input.dryRun) {
              return { dryRun: true, plan };
            }
            const result = executeHalt(plan);
            return {
              dryRun: false,
              plan,
              applied: result.applied.length,
              skipped: result.skipped.length,
              errors: result.errors,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── bulk_resume (iter37) ────────────────────────────────────
  server.tool(
    "bulk_resume",
    "Bulk resume: re-enable paused schedules + rebalances. Cancelled orders are terminal — recreate via order_create or the CLI `playbook replace`; the types[] filter refuses 'orders'. Same scope requirement as bulk_halt. Returns the executed plan + per-row results. Errors: INVALID_PARAMS (no scope + no `all`, 'orders' in types).",
    {
      strategy: z.string().optional(),
      chain: z.string().optional(),
      account: z.string().optional(),
      types: z
        .array(z.enum(["schedules", "rebalances"]))
        .optional()
        .describe("Restrict to schedules / rebalances. Default: both."),
      all: z.boolean().optional(),
      dryRun: z.boolean().default(false),
    },
    async (input) => {
      try {
        return ok(
          await runTool("bulk_resume", rt.opts, input, input.chain, async () => {
            const { planResume, executeResume } = await import("../bulkOps.js");
            const plan = planResume({
              strategy: input.strategy,
              chain: input.chain,
              account: input.account,
              types: input.types,
              all: input.all,
            });
            if (input.dryRun) {
              return { dryRun: true, plan };
            }
            const result = executeResume(plan);
            return {
              dryRun: false,
              plan,
              applied: result.applied.length,
              skipped: result.skipped.length,
              errors: result.errors,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── db_stats (iter40) ─────────────────────────────────────
  server.tool(
    "db_stats",
    "DB observability: per-table row counts + file sizes (main / WAL / SHM / total) + a retention-policy preview that shows what `db_prune` WOULD remove given current config. Read-only, zero RPC, sub-100ms. Use this before enabling retention to gauge impact.",
    {},
    async () => {
      try {
        return ok(
          await runTool("db_stats", rt.opts, {}, undefined, async () => {
            const { readDbStats } = await import("../dbLifecycle.js");
            const config = rt.getConfig();
            return { stats: readDbStats({ config: config.db }) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── db_integrity_check (iter40) ───────────────────────────
  server.tool(
    "db_integrity_check",
    "Wraps SQLite's PRAGMA integrity_check. Returns ok=true for a clean DB; ok=false with the list of errors otherwise. Use as a periodic health probe or in CI before backing up. Cheap on small DBs; slower (~seconds) on multi-GB files.",
    {},
    async () => {
      try {
        return ok(
          await runTool("db_integrity_check", rt.opts, {}, undefined, async () => {
            const { runIntegrityCheck } = await import("../dbLifecycle.js");
            return runIntegrityCheck();
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );
};

/** Iter35 helper for config_preflight. Recursive deep-merge —
 *  objects on `b` override objects on `a` per-key; non-object
 *  values + arrays replace wholesale (a deep merge of arrays is
 *  ambiguous and would force the agent to pass the full list anyway
 *  for predictability). Used only by the MCP path; the CLI flow
 *  reads a complete file via configSchema.parse. */
function deepMerge(a: Record<string, unknown>, b: unknown): unknown {
  if (b == null || typeof b !== "object" || Array.isArray(b)) return b;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
