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
