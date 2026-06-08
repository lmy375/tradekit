// Prometheus-style metrics endpoint.
//
// Stateless snapshot model: every metric is computed by reading existing
// persistent state (DB row counts, engine status file, audit aggregates).
// No in-memory counters; no event-bus instrumentation; no race conditions
// between scrapes. A scrape is a small SQL pass + a status-file read.
//
// Three delivery surfaces share the SAME core:
//   1. CLI `tradekit metrics` — one-shot stdout, cron-friendly.
//   2. Web `/metrics` route — live Prometheus scraping when `tradekit web`
//      is running.
//   3. Engine `--metrics-port N` — minimal standalone HTTP listener in
//      the engine process for single-process deployments.
//
// Label cardinality discipline: labels are bounded enums (status, chain,
// worker, error_code) — NEVER wallet addresses, token amounts, USD
// values, strategy tags, account labels. Unbounded labels would blow up
// the time-series index; sensitive labels would leak operator info. The
// only string interpolation into labels is escape-on-write via
// escapeLabelValue.
//
// Format spec: https://prometheus.io/docs/instrumenting/exposition_formats/

import { openDb } from "./db.js";
import { readEngineStatus } from "./engine.js";
import { tradekitVersion } from "./version.js";

// ── types ────────────────────────────────────────────────────

export type MetricType = "counter" | "gauge" | "info";

/** Single metric series. One MetricSample == one Prometheus line. */
export interface MetricSample {
  /** Metric name (snake_case, prefixed `tradekit_`). */
  name: string;
  /** Bounded-enum labels. Empty record = unlabeled. */
  labels: Record<string, string | number>;
  /** Numeric value. Always finite — non-finite values are clamped to 0
   *  during formatting to keep the output well-formed. */
  value: number;
}

export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

export interface MetricsSnapshot {
  /** ISO timestamp when the snapshot was assembled. */
  timestamp: string;
  /** Wall-clock ms to gather. */
  elapsedMs: number;
  families: MetricFamily[];
}

// ── pure helpers ─────────────────────────────────────────────

/**
 * Escape a label value per the Prometheus spec:
 *   - backslash → \\
 *   - double-quote → \"
 *   - newline → \n
 * Other characters pass through unchanged (UTF-8 is allowed in label
 * values). Returns the value wrapped in double-quotes per the format spec.
 *
 * Exported for tests; consumers go through formatPrometheus.
 */
export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Format a single sample as a Prometheus text line. */
export function formatSample(s: MetricSample): string {
  const entries = Object.entries(s.labels);
  const value = Number.isFinite(s.value) ? s.value : 0;
  if (entries.length === 0) return `${s.name} ${value}`;
  const labels = entries
    .map(([k, v]) => `${k}="${escapeLabelValue(String(v))}"`)
    .join(",");
  return `${s.name}{${labels}} ${value}`;
}

/**
 * Format a complete snapshot in Prometheus text-exposition format.
 * Output is sorted by family name for deterministic test assertions.
 * Each family gets a `# HELP` + `# TYPE` header followed by its samples.
 */
export function formatPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  // Sort families by name for stability (tests + diff-friendly).
  const families = [...snapshot.families].sort((a, b) => a.name.localeCompare(b.name));
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${family.help}`);
    // Prometheus `info` type is conventionally "untyped" — we emit a
    // gauge with the same semantic since strict scrapers (some legacy
    // tools) reject `info`. The metric value is always 1.
    const t = family.type === "info" ? "gauge" : family.type;
    lines.push(`# TYPE ${family.name} ${t}`);
    for (const sample of family.samples) {
      lines.push(formatSample(sample));
    }
  }
  // Prometheus expects a trailing newline.
  return lines.join("\n") + "\n";
}

// ── snapshot collection ──────────────────────────────────────

/**
 * Collect the full metrics snapshot. Each helper hits the DB or status
 * file independently; we don't wrap in a transaction because metric
 * staleness within a single scrape (≤ ms) is far less interesting than
 * the inter-scrape interval (15-60s typical). Reads are cheap (all
 * indexed COUNT queries) so a scrape takes a few ms.
 */
export function gatherMetricsSnapshot(): MetricsSnapshot {
  const t0 = Date.now();
  const families: MetricFamily[] = [];
  families.push(buildInfoFamily());
  families.push(...buildTradesFamilies());
  families.push(...buildOrdersFamilies());
  families.push(...buildSchedulesFamilies());
  families.push(...buildRebalanceFamilies());
  families.push(...buildAuditFamilies());
  families.push(...buildEngineFamilies());
  return {
    timestamp: new Date(t0).toISOString(),
    elapsedMs: Date.now() - t0,
    families,
  };
}

// ── family builders ──────────────────────────────────────────

function buildInfoFamily(): MetricFamily {
  // Standard Prometheus "info" pattern — a single sample with value=1
  // and the version metadata in labels. Lets queries do
  // `tradekit_build_info * on (instance) group_left(version) ...`
  return {
    name: "tradekit_build_info",
    help: "tradekit build information; always 1, labels carry version + node version.",
    type: "info",
    samples: [
      {
        name: "tradekit_build_info",
        labels: {
          version: tradekitVersion(),
          node: process.versions.node,
        },
        value: 1,
      },
    ],
  };
}

function buildTradesFamilies(): MetricFamily[] {
  const db = openDb();
  // SELECT chain, status, COUNT(*) — labeled counter family.
  const rows = db
    .prepare(`SELECT chain, status, COUNT(*) AS n FROM trades GROUP BY chain, status`)
    .all() as Array<{ chain: string; status: string; n: number }>;
  const samples: MetricSample[] = rows.map((r) => ({
    name: "tradekit_trades_total",
    labels: { chain: r.chain, status: r.status },
    value: r.n,
  }));
  // Pending-trades gauge — cron alerting on stuck txs reads this.
  const pendingCount = (db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE status = 'pending'`).get() as { n: number }).n;
  return [
    {
      name: "tradekit_trades_total",
      help: "Total trades persisted, labeled by chain + status (success/failed/pending).",
      type: "counter",
      samples,
    },
    {
      name: "tradekit_pending_trades",
      help: "Current count of trades in 'pending' status (reconcile-eligible).",
      type: "gauge",
      samples: [{ name: "tradekit_pending_trades", labels: {}, value: pendingCount }],
    },
  ];
}

function buildOrdersFamilies(): MetricFamily[] {
  const db = openDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  // Always emit one sample per known status — even when count is 0 —
  // so Prometheus rate() queries don't break on missing series.
  const knownStatuses = ["active", "filled", "cancelled", "expired", "failed"];
  const counts = new Map(rows.map((r) => [r.status, r.n]));
  const samples = knownStatuses.map((s) => ({
    name: "tradekit_orders_total",
    labels: { status: s },
    value: counts.get(s) ?? 0,
  }));
  return [
    {
      name: "tradekit_orders_total",
      help: "Total conditional orders persisted, labeled by status.",
      type: "counter",
      samples,
    },
  ];
}

function buildSchedulesFamilies(): MetricFamily[] {
  const db = openDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM schedules GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  const knownStatuses = ["active", "paused", "completed", "cancelled"];
  const counts = new Map(rows.map((r) => [r.status, r.n]));
  const samples = knownStatuses.map((s) => ({
    name: "tradekit_schedules_total",
    labels: { status: s },
    value: counts.get(s) ?? 0,
  }));
  // Total fires across all schedules — bumped on every fire-or-skip via
  // recordScheduleFire. Useful for alerting "DCA engine is not firing".
  const totalFires = (db.prepare(`SELECT COALESCE(SUM(run_count), 0) AS n FROM schedules`).get() as { n: number }).n;
  return [
    {
      name: "tradekit_schedules_total",
      help: "Total recurring schedules persisted, labeled by status.",
      type: "counter",
      samples,
    },
    {
      name: "tradekit_schedule_fires_total",
      help: "Cumulative tick count across all schedules (sum of run_count column).",
      type: "counter",
      samples: [{ name: "tradekit_schedule_fires_total", labels: {}, value: totalFires }],
    },
  ];
}

function buildRebalanceFamilies(): MetricFamily[] {
  const db = openDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM rebalance_plans GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  const knownStatuses = ["active", "paused", "completed", "cancelled"];
  const counts = new Map(rows.map((r) => [r.status, r.n]));
  const samples = knownStatuses.map((s) => ({
    name: "tradekit_rebalance_plans_total",
    labels: { status: s },
    value: counts.get(s) ?? 0,
  }));
  const totalRuns = (db.prepare(`SELECT COALESCE(SUM(run_count), 0) AS n FROM rebalance_plans`).get() as { n: number }).n;
  return [
    {
      name: "tradekit_rebalance_plans_total",
      help: "Total rebalance plans persisted, labeled by status.",
      type: "counter",
      samples,
    },
    {
      name: "tradekit_rebalance_runs_total",
      help: "Cumulative rebalance evaluation count across all plans.",
      type: "counter",
      samples: [{ name: "tradekit_rebalance_runs_total", labels: {}, value: totalRuns }],
    },
  ];
}

function buildAuditFamilies(): MetricFamily[] {
  const db = openDb();
  // result=ok/err counts.
  const resultRows = db
    .prepare(
      `SELECT CASE WHEN error_code IS NULL THEN 'ok' ELSE 'err' END AS result, COUNT(*) AS n
       FROM audit_log GROUP BY result`,
    )
    .all() as Array<{ result: string; n: number }>;
  const samples: MetricSample[] = resultRows.map((r) => ({
    name: "tradekit_audit_rows_total",
    labels: { result: r.result },
    value: r.n,
  }));
  // Top-N error codes — bounded label cardinality (we only expose the top
  // 20 codes; tail goes to "other" bucket). Prevents a runaway agent
  // generating 1000 distinct codes from blowing up the metric series.
  const errorRows = db
    .prepare(
      `SELECT error_code, COUNT(*) AS n FROM audit_log
       WHERE error_code IS NOT NULL
       GROUP BY error_code
       ORDER BY n DESC LIMIT 21`,
    )
    .all() as Array<{ error_code: string; n: number }>;
  const errorSamples: MetricSample[] = [];
  let otherTotal = 0;
  for (let i = 0; i < errorRows.length; i++) {
    if (i < 20) {
      errorSamples.push({
        name: "tradekit_audit_errors_total",
        labels: { error_code: errorRows[i].error_code },
        value: errorRows[i].n,
      });
    } else {
      otherTotal += errorRows[i].n;
    }
  }
  if (otherTotal > 0) {
    errorSamples.push({
      name: "tradekit_audit_errors_total",
      labels: { error_code: "other" },
      value: otherTotal,
    });
  }
  return [
    {
      name: "tradekit_audit_rows_total",
      help: "Total audit log rows, labeled by result (ok/err).",
      type: "counter",
      samples,
    },
    {
      name: "tradekit_audit_errors_total",
      help: "Audit-log error counts by error_code (top 20; remainder bucketed as 'other').",
      type: "counter",
      samples: errorSamples,
    },
  ];
}

function buildEngineFamilies(): MetricFamily[] {
  const status = readEngineStatus();
  if (!status) {
    // Engine has never run on this install — emit a single gauge=0
    // sample so scrapers see "engine_running=0" rather than missing.
    return [
      {
        name: "tradekit_engine_running",
        help: "1 when the engine supervisor is alive (pid alive + not stopping), else 0.",
        type: "gauge",
        samples: [{ name: "tradekit_engine_running", labels: {}, value: 0 }],
      },
    ];
  }
  const pidAlive = (() => {
    try {
      process.kill(status.pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  })();
  const running = pidAlive && !status.stopping ? 1 : 0;
  const startedAt = Date.parse(status.startedAt);
  const uptimeSeconds = Number.isFinite(startedAt) && running ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const families: MetricFamily[] = [
    {
      name: "tradekit_engine_running",
      help: "1 when the engine supervisor is alive (pid alive + not stopping), else 0.",
      type: "gauge",
      samples: [{ name: "tradekit_engine_running", labels: {}, value: running }],
    },
    {
      name: "tradekit_engine_uptime_seconds",
      help: "Seconds since the current engine supervisor instance started; 0 when not running.",
      type: "gauge",
      samples: [{ name: "tradekit_engine_uptime_seconds", labels: {}, value: uptimeSeconds }],
    },
  ];
  // Per-worker tick + failure counters. The supervisor's in-memory
  // counters reset on restart, so these are "counter" semantically per
  // supervisor lifetime; consumers that need cross-restart cumulative
  // sums use the DB-derived row counts above (orders_total, etc.) which
  // are persistent.
  const ticksSamples: MetricSample[] = [];
  const failsSamples: MetricSample[] = [];
  const stalenessSamples: MetricSample[] = [];
  const now = Date.now();
  for (const w of status.workers) {
    ticksSamples.push({
      name: "tradekit_engine_worker_ticks_total",
      labels: { worker: w.name },
      value: w.ticks,
    });
    failsSamples.push({
      name: "tradekit_engine_worker_failures_total",
      labels: { worker: w.name },
      value: w.failures,
    });
    // Staleness gauge: seconds since the worker's last tick. -1 when
    // never ticked (rather than a huge number) — operators alerting on
    // "stalled worker" use `> threshold` which gracefully ignores -1.
    const lastTickMs = w.lastTickAt ? Date.parse(w.lastTickAt) : Number.NaN;
    const stalenessSec = Number.isFinite(lastTickMs) ? Math.floor((now - lastTickMs) / 1000) : -1;
    stalenessSamples.push({
      name: "tradekit_engine_worker_last_tick_seconds_ago",
      labels: { worker: w.name },
      value: stalenessSec,
    });
  }
  families.push(
    {
      name: "tradekit_engine_worker_ticks_total",
      help: "Per-worker tick count since the current supervisor started (resets on restart).",
      type: "counter",
      samples: ticksSamples,
    },
    {
      name: "tradekit_engine_worker_failures_total",
      help: "Per-worker tick-failure count since the current supervisor started.",
      type: "counter",
      samples: failsSamples,
    },
    {
      name: "tradekit_engine_worker_last_tick_seconds_ago",
      help: "Seconds since each worker's most recent tick; -1 when never ticked. Use `> N` for stalled-worker alerts.",
      type: "gauge",
      samples: stalenessSamples,
    },
  );
  return families;
}

// ── HTTP serving helper ──────────────────────────────────────

/**
 * Render the metrics response body + content type for an HTTP handler.
 * The format string is content-type `text/plain` per the Prometheus spec
 * (version=0.0.4 is the canonical text format; we use the basic form
 * which is compatible with every scraper).
 *
 * Exported so both the web server and the engine's standalone listener
 * can share the same rendering path.
 */
export function renderMetricsResponse(): { contentType: string; body: string } {
  const snapshot = gatherMetricsSnapshot();
  return {
    contentType: "text/plain; version=0.0.4; charset=utf-8",
    body: formatPrometheus(snapshot),
  };
}
