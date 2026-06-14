// Iter621: `tradekit health` CLI. Composes the existing read primitives
// (portfolio + pnl + allowance audit + recent trades + trade analysis) into
// a single morning-briefing report. Pure composition is in src/health.ts;
// this file is the I/O orchestrator: fans out the underlying queries in
// parallel via Promise.allSettled and feeds the results to composeHealthReport.

import type { Address } from "viem";
import { ToolError } from "../errors.js";
import { loadConfig, resolveProfile } from "../config.js";
import { listChains } from "../chains.js";
import { makeCliLogger, printJson, withWatch, parseChainsFlag } from "./helpers.js";
import {
  composeHealthReport,
  formatUsdDelta,
  type HealthReport,
  type PortfolioSection,
} from "../health.js";

/** Format USD as "$1,234.56". Returns "—" for null/undefined. */
function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export async function healthCommand(flags: Record<string, string>) {
  await withWatch(flags, () => healthOnce(flags));
}

async function healthOnce(flags: Record<string, string>) {
  const config = loadConfig();
  const logger = makeCliLogger(flags);
  try {
    const report = await buildHealthReport(config, flags, logger);
    // Iter734: --quiet filters nextActions to severity=critical. Cron-tailing
    // operators want only urgent signals; medium/low nextActions become noise
    // after the first few ticks. Applies AFTER fetch so the underlying scope
    // (portfolio, pnl, etc.) stays identical between quiet + verbose runs;
    // operators reading the JSON later still get the full nextActions list
    // by re-running without --quiet.
    const filtered = flags["quiet"] === "true"
      ? { ...report, nextActions: report.nextActions.filter((a) => a.severity === "critical") }
      : report;
    if (flags["json"] === "true") {
      printJson({ ok: true, ...filtered });
    } else if (flags["summary"] === "true" || flags["summary"] === "") {
      // Iter846: --summary prints a single-line cron/Slack-friendly digest
      // instead of the multi-section dashboard. Use case: pipelining health
      // into alerting (`tradekit health --summary | tee -a alerts.log`) or
      // setting an irc/slack channel topic. Multi-line text is too noisy for
      // a chat-status surface but the multi-line view is still right for
      // interactive operators — hence a flag, not a flag-flipped default.
      // --quiet semantics carry through: if --quiet was passed, summary
      // reflects critical-only nextActions count.
      renderHealthSummary(filtered);
    } else {
      renderHealthText(filtered);
    }
    // Iter755: --strict exit-code surface. Cron pipelines + systemd timers
    // gate on the process exit code; pre-iter755 health exited 0 even when
    // critical nextActions (pending trades, drain-risk approvals) or per-
    // section errors fired, so a stuck cron silently kept "succeeding".
    // Strict mode flips that — any CRITICAL nextAction OR any per-section
    // error → exit 1. Operators wanting fail-fast monitoring set --strict
    // (often alongside --quiet for noise reduction); everyone else's
    // setup is unchanged. Symmetric naming with doctor --strict (iter,
    // warnings count as failures) and trades sync --strict (iter754).
    //
    // Note: uses the UNFILTERED report so --strict still fires even when
    // --quiet hid the nextAction from the rendered output. Operators don't
    // expect --quiet to alter exit-code semantics — it's a presentation
    // flag, not a gating flag.
    const strict = flags["strict"] === "true" || flags["strict"] === "";
    if (strict) {
      const hasCritical = report.nextActions.some((a) => a.severity === "critical");
      const hasErrors = report.errors.length > 0;
      if (hasCritical || hasErrors) {
        // process.exitCode (not process.exit) so main()'s audit-insert
        // finally block still runs — same pattern as doctor (iter351).
        process.exitCode = 1;
      }
    }
  } finally {
    logger.close();
  }
}

async function buildHealthReport(
  config: ReturnType<typeof loadConfig>,
  flags: Record<string, string>,
  logger: ReturnType<typeof makeCliLogger>,
): Promise<HealthReport> {
  // Iter729: measure full orchestration time (compose is pure; the fan-out
  // is what takes time — portfolio + pnl + analyses + approvals).
  const t0 = Date.now();
  const { resolveAccountsForPortfolio, aggregatePortfolio } = await import("../portfolio.js");
  const { listAccounts, unknownAccountError } = await import("../accounts.js");
  const { getKeystoreAddress } = await import("../wallet.js");
  const { KEYSTORE_LABEL } = await import("../constants.js");

  // Same accounts resolution path as portfolio.
  let accountLabels: string[] | "all" | undefined;
  const rawAccounts = flags["accounts"];
  if (rawAccounts == null || rawAccounts === "all") {
    accountLabels = "all";
  } else {
    const parts = rawAccounts.split(",").map((s) => s.trim()).filter(Boolean);
    const file = listAccounts();
    const knownLabels = [
      ...(file?.accounts ?? []).map((a) => a.label),
      ...(getKeystoreAddress() ? [KEYSTORE_LABEL] : []),
    ];
    for (const p of parts) {
      if (!knownLabels.includes(p)) throw unknownAccountError(p, knownLabels);
    }
    accountLabels = parts;
  }
  const accounts = resolveAccountsForPortfolio(accountLabels);
  if (accounts.length === 0) {
    throw new ToolError("WALLET_NOT_FOUND", "Health requires at least one wallet.", {
      details: { reason: "no_wallet" },
    });
  }
  // Default to ALL configured chains (built-ins + custom). Matches portfolio.
  const allChains = [...listChains(), ...Object.keys(config.chains)];
  const chains = parseChainsFlag(flags["chains"], allChains) ?? allChains;

  // Compute 7d-ago timestamp upfront for downstream filters.
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Fan-out: portfolio + pnl + recent trades + analyses + approvals. Each
  // section catches its own errors so one bad RPC doesn't kill the whole
  // report. Audits fan out further (one per active chain × first account).
  const portfolioP = aggregatePortfolio({ accounts, config, logger, chains }).catch(
    (e) => ({ error: (e as Error).message }) as { error: string },
  );

  // Iter624: PnL now aggregates across ALL accounts in scope (pre-iter624 this
  // section only surfaced the first account's PnL, which silently undercounted
  // for HD-wallet operators with multiple derived accounts). The aggregator
  // captures per-account RPC failures into errors[] without aborting.
  const pnlAccount = accounts[0].label;
  const { aggregateMultiAccountPnL } = await import("../pnl.js");
  const pnlP = aggregateMultiAccountPnL(
    accounts.map((a) => a.label),
    { chain: undefined, windows: [{ since: since7d, label: "7d" }] },
    logger,
  )
    // Convert the aggregate to a PnLReport-shaped object for the existing
    // composeHealthReport contract — the section only reads totals and the
    // first window, which the aggregate already exposes at the top level.
    .then((agg) => ({
      account: agg.accounts.join(","),
      chain: agg.chain,
      timestamp: agg.timestamp,
      positions: [], // not used by the section builder
      gas: [],
      totalRealizedUsd: agg.totalRealizedUsd,
      totalUnrealizedUsd: agg.totalUnrealizedUsd,
      totalGasUsd: agg.totalGasUsd,
      totalRealizedAfterGasUsd: agg.totalRealizedAfterGasUsd,
      windows: agg.windows,
      // Iter640: pass byPair through so buildPnLSection picks up top winners/losers.
      byPair: agg.byPair,
      // Iter650: same pass-through for byStrategy.
      byStrategy: agg.byStrategy,
      // Iter818: propagate severity from the aggregate (covers both data
      // freshness + per-account errors).
      severity: agg.severity,
      // Iter830: propagate recommendedActions from the aggregate.
      recommendedActions: agg.recommendedActions,
    }))
    .catch((e) => ({ error: (e as Error).message }) as { error: string });

  // Recent trades + analyses. Used for both the trades section and as
  // input to the iter619 analyses batch.
  const { recentTrades } = await import("../db.js");
  type RowsArr = ReturnType<typeof recentTrades>;
  let rows: RowsArr | { error: string };
  try {
    rows = recentTrades({ account: pnlAccount, limit: 50 });
  } catch (e) {
    rows = { error: (e as Error).message };
  }

  // Iter653: analyses fan-out only needed for rows WITHOUT stored slippage
  // (iter641). For rows that have it, buildTradesSection reads the DB value
  // directly — no RPC. The analyses fan-out remains for legacy rows so
  // byVerdict tallies stay accurate. On a fully-iter641 dataset this drops
  // from 10 analysis calls (~3s) to 0.
  const analysesP = (async () => {
    if (!Array.isArray(rows)) return { error: (rows as { error: string }).error };
    const { analyzeStoredTrade } = await import("../tradeAnalysis.js");
    const { loadReadOnlyWallet } = await import("../wallet.js");
    const candidates = rows.filter((r) => r.status === "success" && r.timestamp >= since7d).slice(0, 10);
    // Iter653: filter to rows that LACK stored slippage. Stored rows skip
    // the RPC roundtrip; analyses still cover the rest.
    const legacyRows = candidates.filter((r) => r.realized_slippage_bps == null);
    if (legacyRows.length === 0) return [];
    const walletByChain = new Map<string, ReturnType<typeof loadReadOnlyWallet>>();
    const out = [];
    for (const row of legacyRows) {
      try {
        let wallet = walletByChain.get(row.chain);
        if (!wallet) {
          const profile = resolveProfile(row.chain, config);
          const extraRpcs = config.chains[row.chain]?.rpcs ?? [];
          wallet = loadReadOnlyWallet(profile, extraRpcs, pnlAccount);
          walletByChain.set(row.chain, wallet);
        }
        const profile = resolveProfile(row.chain, config);
        out.push(
          await analyzeStoredTrade({ row, publicClient: wallet.publicClient, profile, logger }),
        );
      } catch (e) {
        logger.debug(`health: analyze skipped for ${row.tx_hash}: ${(e as Error).message}`);
      }
    }
    return out;
  })();
  const analyses = await analysesP;

  // Approval audits — across the wallet's chains. Per-chain failures stay in
  // the section's error string (we collapse below). Skip freshness scans
  // here — they're slow (eth_getLogs across N blocks) and overview should be
  // FAST. Operator can `tradekit allowances audit --lookback-blocks N` for
  // the deeper check when needed.
  const approvalsP = (async () => {
    try {
      const { loadReadOnlyWallet } = await import("../wallet.js");
      const { listAllowances } = await import("../approvals.js");
      const { auditAllowanceList } = await import("../approvalAudit.js");
      const { KNOWN_ROUTERS } = await import("../routers.js");
      const knownRouters = new Set(KNOWN_ROUTERS.map((r) => r.address.toLowerCase()));
      const reports = [];
      for (const chainName of chains) {
        try {
          const profile = resolveProfile(chainName, config);
          const extraRpcs = config.chains[chainName]?.rpcs ?? [];
          const wallet = loadReadOnlyWallet(profile, extraRpcs, pnlAccount);
          const rs = await listAllowances(
            { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger },
            {},
          );
          if (rs.length === 0) continue;
          // Skip token-price lookups here — slow, and the security overview cares
          // about COUNT (criticals/warns) more than dollar magnitude. Operators
          // get richer USD data via `allowances audit` standalone.
          reports.push(
            auditAllowanceList(rs, {
              chain: chainName,
              config,
              knownRouters,
              tokenPrices: new Map(),
              owner: wallet.account.address as Address,
            }),
          );
        } catch (e) {
          logger.debug(`health: allowance audit skipped on ${chainName}: ${(e as Error).message}`);
        }
      }
      return reports;
    } catch (e) {
      return { error: (e as Error).message } as { error: string };
    }
  })();

  // Iter618 snapshot inputs: most recent + 24h/7d comparisons.
  const snapshotInputs = await (async () => {
    try {
      const { listPortfolioSnapshots, findPortfolioSnapshotAsOf } = await import("../db.js");
      const portfolioResolved = await portfolioP;
      const accountsKey = Array.isArray((portfolioResolved as { accounts?: unknown }).accounts)
        ? [...(portfolioResolved as { accounts: { label: string }[] }).accounts]
            .map((a) => a.label.toLowerCase())
            .sort()
            .join(",")
        : "";
      const chainsKey = [...chains].map((c) => c.toLowerCase()).sort().join(",");
      const recent = listPortfolioSnapshots({ limit: 1, accountsKey, chainsKey });
      const lastSnapshotAt = recent[0]?.timestamp;
      const daysSinceLastSnapshot =
        lastSnapshotAt != null
          ? Math.floor((Date.now() - new Date(lastSnapshotAt).getTime()) / 86_400_000)
          : undefined;

      let delta24h: PortfolioSection["delta24h"];
      let delta7d: PortfolioSection["delta7d"];
      if (
        portfolioResolved &&
        !(portfolioResolved as { error?: string }).error &&
        accountsKey &&
        chainsKey
      ) {
        const totalUsd = (portfolioResolved as { totalUsd: number }).totalUsd;
        const snap24h = findPortfolioSnapshotAsOf({
          asOf: new Date(Date.now() - 24 * 3600_000).toISOString(),
          accountsKey,
          chainsKey,
        });
        if (snap24h?.total_usd != null) {
          const d = totalUsd - snap24h.total_usd;
          delta24h = {
            totalUsdDelta: d,
            pct: snap24h.total_usd > 0 ? (d / snap24h.total_usd) * 100 : null,
            snapshotId: snap24h.id!,
          };
        }
        const snap7d = findPortfolioSnapshotAsOf({ asOf: since7d, accountsKey, chainsKey });
        if (snap7d?.total_usd != null) {
          const d = totalUsd - snap7d.total_usd;
          delta7d = {
            totalUsdDelta: d,
            pct: snap7d.total_usd > 0 ? (d / snap7d.total_usd) * 100 : null,
            snapshotId: snap7d.id!,
          };
        }
      }
      return { lastSnapshotAt, daysSinceLastSnapshot, delta24h, delta7d };
    } catch (e) {
      logger.debug(`health: snapshot inputs failed: ${(e as Error).message}`);
      return {};
    }
  })();

  const [portfolio, pnl, approvalAudits] = await Promise.all([portfolioP, pnlP, approvalsP]);

  // Iter655/iter658: cheap single-SQL-pass count of legacy rows missing the
  // iter635/iter641/iter646 columns. Powers the backfill_* nextAction rules.
  // Counts are GLOBAL (no account filter): backfill commands themselves don't
  // accept --account; surfacing them per-account would hide rows from other
  // accounts and cause the same nextAction to recur after a "successful" run.
  let legacyBackfillCounts:
    | {
        missingBlockNumber: number;
        missingSlippage: number;
        missingGasUsd: number;
        missingRevertReason: number;
      }
    | undefined;
  try {
    const dbModule = await import("../db.js");
    legacyBackfillCounts = dbModule.legacyBackfillCounts({});
  } catch (e) {
    logger.debug(`legacy backfill count failed: ${(e as Error).message}`);
  }

  // v55: runtime headroom (config + trades/drawdown reads). Best-effort —
  // a failure becomes a {error} placeholder so the safety section degrades
  // to the config-posture half rather than breaking the dashboard.
  let headroom: import("../safetyHeadroom.js").SafetyHeadroomReport | { error: string } | undefined;
  try {
    const { gatherSafetyHeadroom } = await import("../safetyHeadroom.js");
    headroom = gatherSafetyHeadroom({ config });
  } catch (e) {
    headroom = { error: (e as Error).message };
  }

  // v124: position-protection audit (live marks + active orders) — feeds the
  // risk verdict's protection dimension + the unprotected_positions nextAction.
  // Whole-book (no account/chain filter) so the safety signal isn't narrowed by
  // the dashboard's scope. Best-effort: a failure degrades to {error}.
  let protection: import("../positionProtection.js").PositionProtectionReport | { error: string } | undefined;
  try {
    const { gatherPositionProtection } = await import("../positionProtection.js");
    protection = await gatherPositionProtection({ mode: "real", config });
  } catch (e) {
    protection = { error: (e as Error).message };
  }

  return composeHealthReport({
    scope: { accounts, chains },
    portfolio,
    pnl,
    approvalAudits,
    analyses: Array.isArray(analyses) ? analyses : analyses,
    recentRows: Array.isArray(rows) ? rows : rows,
    since7d,
    daysSinceLastSnapshot: snapshotInputs.daysSinceLastSnapshot,
    portfolioDelta24h: snapshotInputs.delta24h,
    portfolioDelta7d: snapshotInputs.delta7d,
    lastSnapshotAt: snapshotInputs.lastSnapshotAt,
    legacyBackfillCounts,
    config,
    headroom,
    protection,
    // Iter729: pass measured orchestration time so the report carries it.
    elapsedMs: Date.now() - t0,
  });
}


/**
 * Iter846: single-line `tradekit health --summary` output. Designed for
 * cron-fed alerting (Slack webhook subject, status-page channel topic, email
 * digest header). Compact enough to fit a 132-col terminal AND a Slack
 * one-liner; fields ordered by what a sleep-deprived oncall scans first
 * (severity → portfolio total → 7d delta → critical signals).
 *
 * Format (example, post-iter900/903 alignment):
 *   🟡 MED   tradekit health · portfolio=$12,450.20 · (7d +$123) · crit=1 · pending=0 · 2026-05-30T11:24:33Z  (1.2s)
 *
 * Skipped fields collapse cleanly — a healthy state reads as:
 *   🟢 OK    tradekit health · portfolio=$12,450.20 · 2026-05-30T11:24:33Z  (1.2s)
 *
 * JSON contract unchanged: --summary is purely a text-mode rendering toggle.
 */
export function renderHealthSummary(r: HealthReport): void {
  const HEALTH_BADGE: Record<typeof r.severity, string> = {
    ok: "🟢 OK  ",
    critical: "🔴 CRIT",
    high: "🟠 HIGH",
    medium: "🟡 MED ",
    low: "🔵 LOW ",
  };
  const parts: string[] = [];
  if (r.portfolio) {
    parts.push(`portfolio=${fmtUsd(r.portfolio.totalUsd)}`);
    if (r.portfolio.delta7d) {
      const d = r.portfolio.delta7d.totalUsdDelta;
      const sign = d >= 0 ? "+" : "";
      parts.push(`(7d ${sign}${fmtUsd(d)})`);
    }
  }
  // Critical signals only — summary is for alerting, not for showing the full
  // dashboard. Counts derive from the nextActionsSummary buckets (iter764)
  // that the multi-line view already uses.
  if (r.nextActionsSummary.critical > 0) parts.push(`crit=${r.nextActionsSummary.critical}`);
  if (r.nextActionsSummary.high > 0) parts.push(`high=${r.nextActionsSummary.high}`);
  if (r.trades && r.trades.pendingCount > 0) parts.push(`pending=${r.trades.pendingCount}`);
  if (r.errors.length > 0) parts.push(`errors=${r.errors.length}`);
  parts.push(r.timestamp);
  // Iter903: elapsed parens at the end when iter730 elapsedMs is present.
  // Matches the iter902-aligned verify / reconcile / sync convention so all
  // elapsed-bearing summaries use the same `(Ns)` format.
  const elapsed = r.elapsedMs != null
    ? `  (${(r.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  // Iter900: "tradekit health" prefix instead of "TradeKit" for consistency
  // with the doctor / verify / reconcile / sync / pending --summary
  // convention (iter847/848/899). Operators piping multiple commands into a
  // single Slack channel see uniform line format — every line starts with
  // `<badge>  tradekit <command> · ...`.
  console.log(`${HEALTH_BADGE[r.severity]}  tradekit health · ${parts.join(" · ")}${elapsed}`);
}

function renderHealthText(r: HealthReport) {
  // Iter730: surface iter729 elapsedMs in the header. Operators glancing at
  // health daily get a baseline ("usually 1.2s, today 8s — RPC degradation?").
  // Formatted as "(N.Ns)" for compactness; absent when not measured (e.g.
  // test fixtures hand-constructed without timing).
  const elapsedSuffix = r.elapsedMs != null
    ? `  (${(r.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  // Iter812: severity badge — parity with iter808/809/810/811. Health uses
  // the full 5-color scheme matching iter786's severity values (ok/critical/
  // high/medium/low) — operators see worst-bucket status before scanning the
  // iter784 nextActionsSummary detail line.
  const HEALTH_BADGE: Record<typeof r.severity, string> = {
    ok: "🟢 OK  ",
    critical: "🔴 CRIT",
    high: "🟠 HIGH",
    medium: "🟡 MED ",
    low: "🔵 LOW ",
  };
  console.log(`${HEALTH_BADGE[r.severity]}  TradeKit Health — ${r.timestamp}${elapsedSuffix}`);
  console.log("=".repeat(60));
  const accLabels = r.scope.accounts.map((a) => a.label).join(", ");
  console.log(`Scope: ${r.scope.accounts.length} account${r.scope.accounts.length === 1 ? "" : "s"} (${accLabels}) × ${r.scope.chains.length} chain${r.scope.chains.length === 1 ? "" : "s"}`);
  // Iter784: surface the iter764 nextActionsSummary as a one-liner directly
  // under the header so operators see severity counts WITHOUT scrolling to
  // the bottom NEXT ACTIONS section. Mirrors the doctor footer's
  // "N ok · N warn · N fail" summary discipline. Skipped when total is
  // zero — clean health doesn't need the noise.
  const s = r.nextActionsSummary;
  const total = s.critical + s.high + s.medium + s.low;
  if (total > 0) {
    console.log(
      `Next actions: ${s.critical} critical · ${s.high} high · ${s.medium} medium · ${s.low} low`,
    );
  }
  console.log("");

  // PORTFOLIO
  if (r.portfolio) {
    console.log("PORTFOLIO");
    console.log(`  Total:        ${fmtUsd(r.portfolio.totalUsd)}`);
    if (r.portfolio.delta24h) {
      console.log(`  24h change:   ${formatUsdDelta(r.portfolio.delta24h.totalUsdDelta, r.portfolio.delta24h.pct)} (vs snapshot #${r.portfolio.delta24h.snapshotId})`);
    }
    if (r.portfolio.delta7d) {
      console.log(`  7d change:    ${formatUsdDelta(r.portfolio.delta7d.totalUsdDelta, r.portfolio.delta7d.pct)} (vs snapshot #${r.portfolio.delta7d.snapshotId})`);
    }
    if (r.portfolio.unpricedCount > 0) {
      console.log(`  Unpriced:     ${r.portfolio.unpricedCount} position${r.portfolio.unpricedCount === 1 ? "" : "s"} (not in total)`);
    }
    if (r.portfolio.top.length > 0) {
      const topStr = r.portfolio.top
        .slice(0, 3)
        .map((t) => `${t.symbol} (${fmtUsd(t.totalUsd)}, ${t.percentOfPortfolio.toFixed(1)}%)`)
        .join(", ");
      console.log(`  Top:          ${topStr}`);
    }
    console.log(`  Concentration: top1=${r.portfolio.concentration.top1.toFixed(1)}%, top3=${r.portfolio.concentration.top3.toFixed(1)}%, top5=${r.portfolio.concentration.top5.toFixed(1)}%`);
    console.log("");
  }

  // PNL
  if (r.pnl) {
    console.log("PnL — last 7 days (first account)");
    console.log(`  Realized:     ${formatUsdDelta(r.pnl.realized7dUsd)}`);
    console.log(`  Unrealized:   ${formatUsdDelta(r.pnl.unrealizedUsd)}`);
    console.log(`  Gas:          ${formatUsdDelta(-r.pnl.gas7dUsd)}`);
    console.log(`  Net:          ${formatUsdDelta(r.pnl.netAfterGas7dUsd)}`);
    if (r.pnl.topWinner) {
      console.log(`  Top winner:   ${r.pnl.topWinner.symbol} on ${r.pnl.topWinner.chain}: ${formatUsdDelta(r.pnl.topWinner.realizedUsd)}`);
    }
    if (r.pnl.topLoser) {
      console.log(`  Top loser:    ${r.pnl.topLoser.symbol} on ${r.pnl.topLoser.chain}: ${formatUsdDelta(r.pnl.topLoser.realizedUsd)}`);
    }
    // Iter640: per-pair top winners + losers. Surfaces strategy-level signal
    // that the per-symbol view collapses.
    if (r.pnl.topWinnerPairs && r.pnl.topWinnerPairs.length > 0) {
      console.log("  Top pairs (winners):");
      for (const p of r.pnl.topWinnerPairs) {
        console.log(`    + ${p.pair.padEnd(20)} ${formatUsdDelta(p.realizedUsd)} (${p.tradeCount} trades)`);
      }
    }
    if (r.pnl.topLoserPairs && r.pnl.topLoserPairs.length > 0) {
      console.log("  Top pairs (losers):");
      for (const p of r.pnl.topLoserPairs) {
        console.log(`    - ${p.pair.padEnd(20)} ${formatUsdDelta(p.realizedUsd)} (${p.tradeCount} trades)`);
      }
    }
    // Iter650: per-strategy top winners + loser. Strategy attribution at a glance.
    if (r.pnl.topWinnerStrategies && r.pnl.topWinnerStrategies.length > 0) {
      console.log("  Top strategies (winners):");
      for (const s of r.pnl.topWinnerStrategies) {
        console.log(`    + ${s.strategy.padEnd(20)} ${formatUsdDelta(s.realizedUsd)} (${s.tradeCount} trades)`);
      }
    }
    if (r.pnl.topLoserStrategies && r.pnl.topLoserStrategies.length > 0) {
      console.log("  Top strategies (losers):");
      for (const s of r.pnl.topLoserStrategies) {
        console.log(`    - ${s.strategy.padEnd(20)} ${formatUsdDelta(s.realizedUsd)} (${s.tradeCount} trades)`);
      }
    }
    console.log("");
  }

  // TRADES
  if (r.trades) {
    console.log("TRADES — last 7 days");
    console.log(`  Total:        ${r.trades.total} (${r.trades.successCount} success, ${r.trades.failedCount} failed, ${r.trades.pendingCount} pending)`);
    if (r.trades.medianSlippageBps != null) {
      console.log(`  Median slip:  ${r.trades.medianSlippageBps.toFixed(1)} bps`);
      console.log(`  Avg slip:     ${r.trades.avgSlippageBps?.toFixed(1)} bps`);
    }
    const verdicts = Object.entries(r.trades.byVerdict);
    if (verdicts.length > 0) {
      console.log(`  By verdict:   ${verdicts.map(([k, v]) => `${k}=${v}`).join("  ")}`);
    }
    // Iter674: surface the iter671 failureReasons histogram inline. Skip
    // when no failures — keeps healthy-state output uncluttered. Cap at top
    // 3 to keep one line; full list lives in --json.
    if (r.trades.failureReasons.length > 0) {
      const top3 = r.trades.failureReasons.slice(0, 3);
      const summary = top3.map((rr) => `${rr.reason}=${rr.count}`).join("  ");
      const more = r.trades.failureReasons.length > 3 ? `  (+${r.trades.failureReasons.length - 3} more)` : "";
      console.log(`  Failure why:  ${summary}${more}`);
      // Iter699: dominant reason's last-seen on its own line for visibility.
      if (top3[0]?.lastSeen) {
        const ts = top3[0].lastSeen.slice(0, 16).replace("T", " ");
        console.log(`  Last failure: ${ts} (${top3[0].reason})`);
      }
    }
    console.log("");
  }

  // SECURITY
  if (r.security) {
    console.log("SECURITY");
    console.log(`  Approvals:    ${r.security.totalApprovals} standing (${r.security.criticalCount} critical, ${r.security.warnCount} warn)`);
    if (r.security.staleCount != null) {
      console.log(`  Stale:        ${r.security.staleCount} approval${r.security.staleCount === 1 ? "" : "s"} above the freshness threshold`);
    }
    if (r.security.topConcerns.length > 0) {
      console.log("  Top concerns:");
      for (const c of r.security.topConcerns) {
        const badge = c.severity === "critical" ? "🔴 CRIT" : "🟡 WARN";
        const sp = c.spenderLabel ?? c.spender;
        console.log(`    ${badge}  ${c.symbol.padEnd(12)} → ${sp} (${c.chain})`);
      }
    }
    console.log("");
  }

  // SAFETY (v55) — config posture + binding runtime limit.
  if (r.safety) {
    console.log("SAFETY");
    const v = { hardened: "🛡 hardened", moderate: "⚠ moderate", exposed: "⛔ EXPOSED" }[r.safety.postureVerdict];
    console.log(`  Posture:      ${v} (${r.safety.criticalGaps} critical, ${r.safety.warnGaps} warn gap${r.safety.warnGaps === 1 ? "" : "s"})`);
    if (r.safety.topGap) console.log(`                ${r.safety.topGap}`);
    if (r.safety.binding) {
      const b = r.safety.binding;
      const badge = b.status === "tripped" || b.status === "exhausted" ? "🔴" : b.status === "approaching" ? "🟡" : "✓";
      console.log(`  Binding limit: ${badge} ${b.label} (${b.scope})${b.utilizationPct != null ? ` — ${b.utilizationPct.toFixed(0)}% used` : ""}`);
    }
    // v81: unified runtime risk verdict (concentration + headroom + MEV).
    if (r.risk) {
      const rv = { ok: "🟢 ok", elevated: "🟡 ELEVATED", critical: "🔴 CRITICAL" }[r.risk.verdict];
      console.log(`  Risk:         ${rv}${r.risk.verdict !== "ok" ? ` (${r.risk.criticalCount} critical, ${r.risk.elevatedCount} elevated)` : ""}`);
      if (r.risk.topConcern) console.log(`                ${r.risk.topConcern}`);
    }
    console.log("");
  }

  // NEXT ACTIONS
  if (r.nextActions.length > 0) {
    console.log("NEXT ACTIONS");
    // Iter693: severity badge so operators see urgency at a glance. The
    // actions are already sorted by severity (critical → low) in
    // deriveNextActions, so iteration order is correct.
    const BADGE: Record<typeof r.nextActions[number]["severity"], string> = {
      critical: "🔴",
      high: "🟠",
      medium: "🟡",
      low: "  ",
    };
    for (const a of r.nextActions) {
      console.log(`  ${BADGE[a.severity]} ${a.message}`);
      console.log(`      ${a.command}`);
    }
    console.log("");
  }

  // ERRORS
  if (r.errors.length > 0) {
    console.log("WARNINGS (partial data)");
    for (const e of r.errors) {
      console.log(`  ⚠️  ${e.code}: ${e.message}`);
    }
  }
}
