// CLI surface for the unified forensic timeline (iter36).
//
// Subactions: none — the command is single-purpose. Filters are
// expressed through flags:
//
//   tradekit timeline [--since 4h|ISO] [--until ISO]
//                     [--chain X] [--account L] [--strategy TAG]
//                     [--kinds trade.fill,trade.failure,...]
//                     [--severity warn|critical]
//                     [--no-paper] [--limit N] [--json]
//
// Default window: last 4h. Default limit: 100.

import { ToolError } from "../errors.js";
import {
  collectTimeline,
  parseSinceDuration,
  type EventKind,
  type EventSeverity,
  type TimelineEvent,
} from "../timeline.js";
import { printJson } from "./helpers.js";

const VALID_KINDS: EventKind[] = [
  "trade.fill",
  "trade.failure",
  "trade.pending",
  "paper.fill",
  "order.journal",
  "order.edited",
  "audit.tool",
  "audit.error",
  "alert.fired",
  "alert.resolved",
];

function parseKinds(raw: string | undefined): EventKind[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out: EventKind[] = [];
  for (const p of parts) {
    if (!VALID_KINDS.includes(p as EventKind)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--kinds includes unknown "${p}"; valid: ${VALID_KINDS.join(", ")}.`,
      );
    }
    out.push(p as EventKind);
  }
  return out.length ? out : undefined;
}

function parseSeverity(raw: string | undefined): EventSeverity | undefined {
  if (!raw) return undefined;
  if (raw !== "info" && raw !== "warn" && raw !== "critical") {
    throw new ToolError(
      "INVALID_PARAMS",
      `--severity must be one of info|warn|critical (got "${raw}").`,
    );
  }
  return raw;
}

function severityBadge(s: EventSeverity): string {
  return s === "critical" ? "✕" : s === "warn" ? "⚠" : "·";
}

function fmtRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 0) return iso;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function fmtShortTime(iso: string): string {
  // Render the ISO timestamp with second precision (drop ms +
  // trailing Z) so the table stays compact.
  return iso.replace(/\.\d{3}Z$/, "Z").replace(/T/, " ");
}

function renderEvent(e: TimelineEvent): string {
  const badge = severityBadge(e.severity);
  const time = fmtShortTime(e.at).padEnd(20);
  const kind = e.kind.padEnd(16);
  return `  ${badge} ${time} ${kind} ${e.summary}`;
}

export async function timelineCommand(flags: Record<string, string>) {
  // Resolve since: accept duration shorthand (4h, 1d, …) or ISO.
  let sinceIso: string | undefined;
  if (flags["since"]) {
    const parsed = parseSinceDuration(flags["since"]);
    if (!parsed) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--since must be a duration (e.g. 4h, 30m, 2d) or an ISO-8601 timestamp (got "${flags["since"]}").`,
      );
    }
    sinceIso = parsed;
  }
  let untilIso: string | undefined;
  if (flags["until"]) {
    const t = Date.parse(flags["until"]);
    if (!Number.isFinite(t)) {
      throw new ToolError("INVALID_PARAMS", `--until must be a valid ISO-8601 timestamp (got "${flags["until"]}").`);
    }
    untilIso = new Date(t).toISOString();
  }

  const limit = flags["limit"] != null ? parseInt(flags["limit"], 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ToolError("INVALID_PARAMS", `--limit must be a positive integer (got "${flags["limit"]}").`);
  }

  const events = collectTimeline({
    sinceIso,
    untilIso,
    chain: flags["chain"],
    account: flags["account"],
    strategy: flags["strategy"],
    kinds: parseKinds(flags["kinds"]),
    minSeverity: parseSeverity(flags["severity"]),
    includePaper: flags["no-paper"] !== "true",
    limit,
  });

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      count: events.length,
      since: sinceIso ?? null,
      until: untilIso ?? null,
      events,
    });
    return;
  }

  if (events.length === 0) {
    console.log("No events in the requested window.");
    console.log("");
    console.log("Default window is the last 4h. Try:");
    console.log("  tradekit timeline --since 1d");
    console.log("  tradekit timeline --since 7d --strategy <tag>");
    return;
  }

  // Header.
  const windowDesc = sinceIso ? `since ${fmtRelative(sinceIso)}` : "last 4h";
  console.log(`Timeline (${events.length} events, ${windowDesc}):`);
  console.log("");
  const cBadgeCount = events.filter((e) => e.severity === "critical").length;
  const wBadgeCount = events.filter((e) => e.severity === "warn").length;
  console.log(`  ${cBadgeCount} critical · ${wBadgeCount} warn · ${events.length - cBadgeCount - wBadgeCount} info`);
  console.log("");
  for (const e of events) {
    console.log(renderEvent(e));
  }
  if (events.length === limit) {
    console.log("");
    console.log(`  (output truncated to --limit ${limit}; pass a higher --limit to see more)`);
  }
}
