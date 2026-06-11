/**
 * v37 engine snapshot worker — the data feed for the equity curve.
 *
 * Ticks on engine.workers.snapshot.intervalMs (default hourly) but
 * only RECORDS when the freshest 'engine-auto' snapshot is older
 * than engine.snapshotEveryHours (default 24) — the tick is cheap;
 * the snapshot itself is a full multi-chain RPC + price scan, so it
 * runs once a day, not once an hour. Manual `tradekit snapshot`
 * rows live in the same table and contribute to the curve, but do
 * NOT reset the auto cadence (different note tag) — an operator
 * inspecting their portfolio shouldn't silently skip tonight's
 * data point.
 *
 * Read-only: addresses come from the account registry; no keystore.
 */

import { insertPortfolioSnapshot, listPortfolioSnapshots } from "./db.js";
import { scopeKey } from "./portfolioSnapshots.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { PortfolioReport } from "./portfolio.js";

export const AUTO_SNAPSHOT_NOTE = "engine-auto";

export interface SnapshotTickReport {
  skipped?: string;
  recorded?: { id: number; totalUsd: number | null; accountsKey: string; chainsKey: string };
}

export async function runSnapshotTick(args: {
  config: Config;
  logger: Logger;
  /** Test seam — defaults to the production portfolio aggregation. */
  aggregateFn?: () => Promise<PortfolioReport>;
  now?: Date;
}): Promise<SnapshotTickReport> {
  const now = args.now ?? new Date();
  const everyHours = args.config.engine?.snapshotEveryHours ?? 24;

  // Freshness gate: cheap indexed read. We can't scope-filter before
  // knowing the scope (account set may have changed), so the gate is
  // "any engine-auto snapshot recent enough" — one auto point per
  // cadence across the whole table, which is exactly the curve's
  // appetite.
  const recent = listPortfolioSnapshots({ limit: 50, since: new Date(now.getTime() - everyHours * 3_600_000).toISOString() });
  if (recent.some((r) => r.note === AUTO_SNAPSHOT_NOTE)) {
    return { skipped: `fresh auto-snapshot exists (< ${everyHours}h)` };
  }

  const aggregate =
    args.aggregateFn ??
    (async () => {
      const { resolveAccountsForPortfolio, aggregatePortfolio } = await import("./portfolio.js");
      const accounts = resolveAccountsForPortfolio(undefined);
      if (accounts.length === 0) {
        throw new Error("no wallet configured");
      }
      return aggregatePortfolio({ accounts, config: args.config, logger: args.logger });
    });

  let report: PortfolioReport;
  try {
    report = await aggregate();
  } catch (e) {
    // Degraded RPC / no wallet — skip quietly; the next tick retries.
    return { skipped: `portfolio aggregation failed: ${(e as Error).message}` };
  }

  const accountsKey = scopeKey(report.accounts.map((a) => a.label));
  const chainsKey = scopeKey(report.chains);
  const id = insertPortfolioSnapshot({
    timestamp: report.timestamp,
    total_usd: report.totalUsd,
    accounts_key: accountsKey,
    chains_key: chainsKey,
    token_count: report.tokens.length,
    note: AUTO_SNAPSHOT_NOTE,
    data: JSON.stringify(report),
  });
  args.logger.info(`snapshot worker: recorded #${id} (total $${report.totalUsd?.toFixed(2) ?? "?"}, scope ${accountsKey} × ${chainsKey})`);
  return { recorded: { id, totalUsd: report.totalUsd, accountsKey, chainsKey } };
}

// ── v48: paper-book snapshots ────────────────────────────────
//
// Paper is the on-ramp: strategies prove themselves on the virtual
// book BEFORE promote. The equity/risk stack (curve, drawdown, vol,
// sharpe, web scope picker) was real-portfolio-only — exactly the
// surfaces a promote decision needs were missing for paper. Paper
// snapshots write to the SAME portfolio_snapshots table under a
// namespaced "paper:<account>" accounts_key, so the entire stack
// works on them with zero further wiring (scope discipline pays).

import { listPaperBalances } from "./db.js";
import type { PaperPriceFetcher } from "./paperPnl.js";

export const PAPER_AUTO_SNAPSHOT_NOTE = "engine-auto-paper";
export const PAPER_SCOPE_PREFIX = "paper:";

export interface PaperBookValuation {
  totalUsd: number;
  /** Tokens with a non-zero balance. */
  tokenCount: number;
  pricedCount: number;
  /** Tokens we could NOT price — their value is EXCLUDED from
   *  totalUsd (honest undercount, never a guess). */
  unpricedCount: number;
  breakdown: Array<{
    chain: string;
    token: string;
    balance: number;
    priceUsd: number | null;
    valueUsd: number | null;
  }>;
}

export async function valuePaperBook(args: {
  rows: ReadonlyArray<{ chain: string; token: string; balance: string }>;
  fetchPrice: PaperPriceFetcher;
}): Promise<PaperBookValuation> {
  const breakdown: PaperBookValuation["breakdown"] = [];
  let totalUsd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const r of args.rows) {
    const balance = parseFloat(r.balance);
    if (!Number.isFinite(balance) || balance <= 0) continue;
    const priceUsd = await args.fetchPrice(r.chain, r.token).catch(() => null);
    const valueUsd = priceUsd != null ? balance * priceUsd : null;
    if (valueUsd != null) {
      totalUsd += valueUsd;
      priced++;
    } else {
      unpriced++;
    }
    breakdown.push({ chain: r.chain, token: r.token, balance, priceUsd, valueUsd });
  }
  return { totalUsd, tokenCount: priced + unpriced, pricedCount: priced, unpricedCount: unpriced, breakdown };
}

export interface PaperSnapshotTickReport {
  skipped?: string;
  recorded: Array<{ id: number; account: string; totalUsd: number; accountsKey: string; chainsKey: string; unpricedCount: number }>;
}

export async function runPaperSnapshotTick(args: {
  config: Config;
  logger: Logger;
  /** Test seam — production defaults to defaultPaperPriceFetcher. */
  fetchPrice?: PaperPriceFetcher;
  /** Manual `portfolio snapshot --paper` bypasses the cadence gate —
   *  an operator asking for a datapoint should get one. */
  force?: boolean;
  now?: Date;
}): Promise<PaperSnapshotTickReport> {
  const now = args.now ?? new Date();
  if (args.config.engine?.snapshotIncludePaper === false) {
    return { skipped: "engine.snapshotIncludePaper is false", recorded: [] };
  }
  const everyHours = args.config.engine?.snapshotEveryHours ?? 24;

  // Independent cadence from the real-portfolio snapshots: the gates
  // look at different note tags, so one feed being fresh never
  // starves the other.
  if (!args.force) {
    const recent = listPortfolioSnapshots({
      limit: 50,
      since: new Date(now.getTime() - everyHours * 3_600_000).toISOString(),
    });
    if (recent.some((r) => r.note === PAPER_AUTO_SNAPSHOT_NOTE)) {
      return { skipped: `fresh paper auto-snapshot exists (< ${everyHours}h)`, recorded: [] };
    }
  }

  const rows = listPaperBalances({});
  const nonZero = rows.filter((r) => {
    const b = parseFloat(r.balance);
    return Number.isFinite(b) && b > 0;
  });
  if (nonZero.length === 0) {
    return { skipped: "paper book is empty", recorded: [] };
  }

  const fetchPrice =
    args.fetchPrice ??
    (await (async () => {
      const { defaultPaperPriceFetcher } = await import("./paperPnl.js");
      return defaultPaperPriceFetcher(args.config, args.logger);
    })());

  // One snapshot row per paper ACCOUNT — the equity curve's scope
  // discipline wants one accounts_key×chains_key series per curve.
  const byAccount = new Map<string, typeof nonZero>();
  for (const r of nonZero) {
    const arr = byAccount.get(r.account) ?? [];
    arr.push(r);
    byAccount.set(r.account, arr);
  }

  const recorded: PaperSnapshotTickReport["recorded"] = [];
  for (const [account, accountRows] of byAccount) {
    const valuation = await valuePaperBook({ rows: accountRows, fetchPrice });
    if (valuation.tokenCount === 0) continue;
    const accountsKey = `${PAPER_SCOPE_PREFIX}${account}`;
    const chainsKey = scopeKey([...new Set(accountRows.map((r) => r.chain))]);
    const id = insertPortfolioSnapshot({
      timestamp: now.toISOString(),
      total_usd: valuation.totalUsd,
      accounts_key: accountsKey,
      chains_key: chainsKey,
      token_count: valuation.tokenCount,
      note: PAPER_AUTO_SNAPSHOT_NOTE,
      data: JSON.stringify({ paper: true, valuation }),
    });
    if (valuation.unpricedCount > 0) {
      args.logger.warn(
        `paper snapshot #${id}: ${valuation.unpricedCount} token(s) unpriceable — their value is EXCLUDED from the $${valuation.totalUsd.toFixed(2)} total`,
      );
    }
    recorded.push({ id, account, totalUsd: valuation.totalUsd, accountsKey, chainsKey, unpricedCount: valuation.unpricedCount });
  }
  if (recorded.length > 0) {
    args.logger.info(`paper snapshot worker: recorded ${recorded.length} scope(s)`);
  }
  return { recorded };
}
