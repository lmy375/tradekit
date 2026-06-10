// CLI surface for the notification / webhook system.
//
//   tradekit notify list [--json]
//        Show every configured channel + detected format. Webhook URLs
//        appear with the host preserved and the path masked.
//   tradekit notify test [--channel NAME] [--event order.filled] [--severity info|warn|critical]
//                        [--json]
//        Send a synthetic event to one or all matching channels. Prints
//        a per-channel dispatch report so operators verify wiring before
//        a real event needs to fire.
//
// The dispatcher itself lives in src/notify.ts; this module is a thin
// adapter — same pattern as cli/orders.ts.

import { ToolError } from "../errors.js";
import { loadConfig, redactWebhookUrl } from "../config.js";
import { detectFormat, notify, type NotificationEvent, type NotificationSeverity } from "../notify.js";
import { makeCliLogger, printJson, subcommandError } from "./helpers.js";

const VALID_SEVERITIES: NotificationSeverity[] = ["info", "warn", "critical"];

export async function notifyListCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const channels = config.notifications?.channels ?? [];
  if (flags["json"] === "true") {
    printJson({
      ok: true,
      dedupWindowMs: config.notifications?.dedupWindowMs ?? 60_000,
      summary: { total: channels.length, enabled: channels.filter((c) => c.enabled).length },
      // Redact URLs by default — operators reviewing channels in a chat
      // paste / screenshot won't leak the auth-bearing path component.
      // Pair with `config show --show-secrets` if the full URL is needed.
      items: channels.map((c) => ({
        ...c,
        url: redactWebhookUrl(c.url),
        format: detectFormat(c.url),
      })),
    });
    return;
  }
  if (channels.length === 0) {
    console.log("No notification channels configured.");
    console.log("");
    console.log("Add a channel:");
    console.log("  tradekit config push notifications.channels '{");
    console.log('    "name": "ops-slack",');
    console.log('    "url": "https://hooks.slack.com/services/...",');
    console.log('    "events": ["order.filled","order.failed","trade.failed","approval.infinite"],');
    console.log('    "minSeverity": "info"');
    console.log("  }'");
    return;
  }
  console.log(`Notification channels (${channels.length}, dedup window: ${(config.notifications?.dedupWindowMs ?? 60_000) / 1000}s)`);
  console.log("");
  for (const c of channels) {
    const status = c.enabled ? "●" : "○";
    const format = detectFormat(c.url);
    const events = c.events && c.events.length > 0 ? c.events.join(",") : "all";
    console.log(`  ${status} ${c.name}   format=${format}   minSeverity=${c.minSeverity}`);
    console.log(`     url: ${redactWebhookUrl(c.url)}`);
    console.log(`     events: ${events}`);
    if (c.timeoutMs) console.log(`     timeoutMs: ${c.timeoutMs}`);
    console.log("");
  }
}

export async function notifyTestCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const channels = config.notifications?.channels ?? [];
  if (channels.length === 0) {
    throw new ToolError(
      "INVALID_PARAMS",
      "No notification channels configured. Run `tradekit notify list` for setup instructions.",
    );
  }
  const event = flags["event"] ?? "test";
  const severity = (flags["severity"] ?? "info") as NotificationSeverity;
  if (!VALID_SEVERITIES.includes(severity)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--severity must be one of ${VALID_SEVERITIES.join("|")} (got "${severity}").`,
    );
  }

  // Optional channel filter — single channel by name. Without --channel,
  // EVERY channel matching the test event flows.
  let activeConfig = config;
  if (flags["channel"]) {
    const target = channels.find((c) => c.name === flags["channel"]);
    if (!target) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Unknown channel "${flags["channel"]}". Available: ${channels.map((c) => c.name).join(", ")}.`,
        { details: { provided: flags["channel"], available: channels.map((c) => c.name) } },
      );
    }
    // Override the live config in-memory with just the one channel — the
    // notify dispatcher then naturally fans out to it alone. No mutation
    // of disk config.
    activeConfig = { ...config, notifications: { ...config.notifications, channels: [target] } };
  }

  const logger = makeCliLogger(flags);
  const evt: NotificationEvent = {
    event,
    severity,
    title: "tradekit notify test",
    body: `This is a synthetic test event from \`tradekit notify test\` — if you're reading it, your webhook is configured correctly.`,
    fields: {
      source: "tradekit",
      hostname: process.env.HOSTNAME ?? null,
      pid: process.pid,
    },
    // No dedupKey: each `notify test` invocation MUST go through, even on
    // back-to-back runs. Otherwise an operator iterating on config can't
    // tell whether silence means "channel works but is dedup-suppressed"
    // or "channel is broken".
  };
  const report = await notify(evt, activeConfig, logger);

  if (flags["json"] === "true") {
    printJson({ ok: true, ...report });
    return;
  }
  console.log(
    `Sent test event "${event}" (severity=${severity}) to ${report.channels} channel(s): ` +
    `delivered=${report.delivered} skipped=${report.skipped} failed=${report.failed}`,
  );
  console.log("");
  for (const r of report.results) {
    const status =
      r.skipped ? `↷ skipped (${r.skipped})` :
      r.ok ? `✓ ok (HTTP ${r.status})` :
      `✗ failed (${r.error ?? `HTTP ${r.status ?? "?"}`})`;
    const elapsed = r.elapsedMs != null ? `  ${r.elapsedMs}ms` : "";
    console.log(`  ${r.channelName}  [${r.format}]  ${status}${elapsed}`);
  }
}

// ── dispatcher ───────────────────────────────────────────────

/** `tradekit notify queue` — inspect notifications suppressed by the
 *  v34 quiet-hours window (pending = not yet flushed). */
export async function notifyQueueCommand(flags: Record<string, string>) {
  const { pendingQueuedNotifications } = await import("../db.js");
  const pending = pendingQueuedNotifications(200);
  if (flags["json"] === "true") {
    printJson({ ok: true, count: pending.length, pending });
    return;
  }
  if (pending.length === 0) {
    console.log("Quiet-hours queue is empty.");
    return;
  }
  console.log(`${pending.length} notification(s) queued during quiet hours:\n`);
  for (const q of pending) {
    console.log(`  ${q.queued_at}  [${q.severity}]  ${q.event}  ${q.title}`);
  }
  console.log(`\nFlush now: tradekit notify flush`);
}

/** `tradekit notify flush [--force]` — deliver the suppressed-summary
 *  now. --force flushes even while the quiet window is still active. */
export async function notifyFlushCommand(flags: Record<string, string>) {
  const { flushQueuedNotifications } = await import("../notify.js");
  const { loadConfig } = await import("../config.js");
  const { createLogger } = await import("../logger.js");
  const result = await flushQueuedNotifications(loadConfig(), createLogger({ stderrLevel: "warn" }), {
    force: flags["force"] === "true",
  });
  if (flags["json"] === "true") {
    printJson({ ok: true, result });
    return;
  }
  if (!result) {
    console.log("Nothing to flush (queue empty, or quiet hours still active — use --force).");
  } else if (result.flushed > 0) {
    console.log(`Flushed ${result.flushed} queued notification(s) as one summary${result.delivered ? "" : " (no channels configured)"}.`);
  } else {
    console.log("Flush attempted but summary delivery failed — rows stay queued for retry.");
  }
}

export async function notifyCommand(
  action: string | undefined,
  flags: Record<string, string>,
) {
  switch (action) {
    case "list":
      await notifyListCommand(flags);
      break;
    case "test":
      await notifyTestCommand(flags);
      break;
    case "queue":
      await notifyQueueCommand(flags);
      break;
    case "flush":
      await notifyFlushCommand(flags);
      break;
    default:
      throw subcommandError("notify", action, ["list", "test", "queue", "flush"]);
  }
}
