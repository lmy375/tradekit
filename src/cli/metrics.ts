// CLI surface for the metrics module.
//
//   tradekit metrics              # Prometheus text format on stdout (default)
//   tradekit metrics --json       # Structured snapshot for jq / scripts
//
// Designed for the node_exporter textfile-collector pattern:
//   * * * * *  tradekit metrics > /var/lib/node_exporter/textfile_collector/tradekit.prom
//
// The live-scraping path is the web server's /metrics route or the
// engine's --metrics-port listener; this CLI is the cron-friendly
// one-shot equivalent.

import { gatherMetricsSnapshot, formatPrometheus } from "../metrics.js";
import { printJson } from "./helpers.js";

export async function metricsCommand(flags: Record<string, string>): Promise<void> {
  const snapshot = gatherMetricsSnapshot();
  if (flags["json"] === "true") {
    // Structured shape: same families/samples surface that the
    // Prometheus formatter consumes. Useful for jq pipelines or for
    // operators who want to dispatch metrics to a non-Prometheus
    // backend (Datadog, InfluxDB, custom).
    printJson(snapshot);
    return;
  }
  // Write directly to stdout via process.stdout to avoid console.log's
  // automatic newline appending (the formatter already appends).
  process.stdout.write(formatPrometheus(snapshot));
}
