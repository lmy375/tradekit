// ──────────────────────────────────────────────────────────────────
// Digest push (v31): the daily digest, delivered by the engine.
//
// The digest's deployment story was "write a crontab entry that pipes
// `tradekit digest --format slack` into curl". The engine is already a
// long-running supervisor with a notify stack wired to Slack / Discord
// / Telegram — this worker closes the loop: one config flag instead of
// external cron plumbing.
//
//   tradekit config set notifications.digest '{"enabled":true,"hourUtc":9}'
//
// Semantics:
//   - At most ONE send per UTC day, at (or after) hourUtc. The worker
//     ticks every 5 minutes; a marker file (.digest.last, same trust
//     level as the engine status file) records the last sent date so
//     restarts don't double-send.
//   - minVerdict gates on health: "attention" = only send when the
//     digest verdict is attention or worse. A below-gate day is NOT
//     marked sent — if health degrades later the digest goes out the
//     moment it qualifies. "healthy" (default) = always send.
//   - The body is the SAME markdown the CLI's --format slack emits
//     (shared renderer) — operators migrating from cron keep their
//     channel formatting.
// ──────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./constants.js";
import { gatherDigest, parseWindowMs, type HealthVerdict } from "./digest.js";
import { renderDigestMarkdown } from "./cli/digest.js";
import { tryNotify } from "./notify.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

export interface DigestPushReport {
  /** True when nothing was attempted this tick. */
  skipped: boolean;
  reason?: string;
  sent?: boolean;
  verdict?: HealthVerdict;
  /** UTC date (YYYY-MM-DD) the send was attributed to. */
  date?: string;
}

const VERDICT_RANK: Record<HealthVerdict, number> = { healthy: 0, attention: 1, critical: 2 };

export function digestMarkerPath(): string {
  return join(DATA_DIR, ".digest.last");
}

function readMarker(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export async function runDigestPushTick(args: {
  config: Config;
  logger: Logger;
  /** Inject for tests. Defaults to tryNotify. */
  notifyFn?: typeof tryNotify;
  /** Inject "now" — defaults to new Date(). */
  now?: Date;
  /** Marker file override (tests). */
  markerPath?: string;
}): Promise<DigestPushReport> {
  // v34: the digest worker doubles as the quiet-hours flush heartbeat —
  // if the morning is uneventful (no notify() call to trigger the
  // opportunistic flush), this tick delivers the suppressed-summary
  // shortly after the window ends. Best-effort; never blocks the digest.
  if (args.config.notifications?.quietHours?.enabled) {
    try {
      const { flushQueuedNotifications } = await import("./notify.js");
      await flushQueuedNotifications(args.config, args.logger, { now: args.now });
    } catch { /* never block the digest on a flush hiccup */ }
  }

  const cfg = args.config.notifications.digest;
  if (!cfg?.enabled) return { skipped: true, reason: "notifications.digest.enabled=false" };

  const now = args.now ?? new Date();
  const dateUtc = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < cfg.hourUtc) {
    return { skipped: true, reason: `before send hour (${cfg.hourUtc}:00 UTC)` };
  }
  const markerPath = args.markerPath ?? digestMarkerPath();
  const last = readMarker(markerPath);
  if (last === dateUtc) {
    return { skipped: true, reason: "already sent today" };
  }

  let windowMs: number;
  try {
    windowMs = parseWindowMs(cfg.window);
  } catch (e) {
    args.logger.warn(`digest push: invalid notifications.digest.window "${cfg.window}": ${(e as Error).message}`);
    return { skipped: true, reason: "invalid window" };
  }
  const report = await gatherDigest({ windowLabel: cfg.window, windowMs, now, config: args.config });

  if (VERDICT_RANK[report.verdict] < VERDICT_RANK[cfg.minVerdict]) {
    // Deliberately NOT marked sent: if health degrades later today,
    // the digest goes out the moment it qualifies.
    return { skipped: true, reason: `verdict ${report.verdict} below minVerdict ${cfg.minVerdict}`, verdict: report.verdict };
  }

  const severity = report.verdict === "critical" ? "critical" : report.verdict === "attention" ? "warn" : "info";
  const notify = args.notifyFn ?? tryNotify;
  await notify(
    {
      event: "digest.daily",
      severity,
      title: `Tradekit digest (${cfg.window}) — ${report.verdict.toUpperCase()}`,
      body: renderDigestMarkdown(report),
      fields: {
        verdict: report.verdict,
        trades: report.trades.total,
        usdVolume: Math.round(report.trades.usdVolume * 100) / 100,
        ordersFilled: report.fires.ordersFilled,
        alertsFired: report.alerts.fired,
        paperFills: report.paper.fills,
        errorRows: report.errors.errorRows,
      },
      dedupKey: `digest.daily:${dateUtc}`,
    },
    args.config,
    args.logger,
  );

  try {
    writeFileSync(markerPath, dateUtc, "utf8");
  } catch (e) {
    args.logger.warn(`digest push: marker write failed (${(e as Error).message}) — dedupKey still guards double-send today`);
  }
  return { skipped: false, sent: true, verdict: report.verdict, date: dateUtc };
}
