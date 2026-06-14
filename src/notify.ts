// Notification / webhook dispatcher.
//
// Push-based delivery of operationally interesting events (order fills,
// trade reverts, infinite approvals, …) to one or more configured channels.
// Channels are URL-driven — the format is auto-detected from the host:
//
//   hooks.slack.com               → Slack incoming webhook (blocks API)
//   discord.com/api/webhooks      → Discord embed
//   api.telegram.org/bot...       → Telegram sendMessage
//   anything else                 → generic JSON POST { event, severity, ... }
//
// Delivery is best-effort fire-and-forget: a webhook outage logs a warning
// but NEVER throws. This is a hard invariant — a Slack outage cannot block
// a trade. The notify engine sits at the bottom of the dependency graph
// (no imports from trade/orders) so it can be called from anywhere without
// circular concerns.
//
// Dedup: events with the same `dedupKey` within `config.notifications.
// dedupWindowMs` are suppressed in-memory. Catches the most common storms
// (a stuck order failing every tick) without losing unique signal.

import { fetchWithTimeout } from "./http.js";
import type { Logger } from "./logger.js";
import type { Config, NotificationChannel } from "./config.js";

// ── types ────────────────────────────────────────────────────

/** Stable event identifiers. The string is what operators write in
 *  channel.events and what notify.test references — keep it kebab-dotted
 *  and additive (don't rename without a deprecation path). */
export type NotificationEventType =
  | "order.filled"
  | "order.failed"
  | "order.expired"
  | "order.cancelled_oco"
  // Pre-trade auto-honeypot check blocked a trade. critical severity —
  // operators almost always want to know immediately when an automated
  // strategy attempted to trade through a flagged token.
  | "token.honeypot_blocked"
  | "trade.failed"
  | "approval.infinite"
  // Schedule (DCA / recurring) events.
  | "schedule.fired"
  | "schedule.failed"
  | "schedule.completed"
  // Iter27: post-fill hook outcomes. Auto-created follow-up order
  // succeeded vs. the hook errored mid-fire (fill stays, follow-up
  // didn't land). on_fill_failed warrants operator attention —
  // partial state means the operator may need to create the
  // follow-up manually.
  | "schedule.on_fill_created"
  | "schedule.on_fill_failed"
  // Portfolio rebalance plan events.
  | "rebalance.executed"
  | "rebalance.skipped"
  | "rebalance.failed"
  | "rebalance.completed"
  // Engine supervisor events. heartbeat is emitted periodically so
  // operators can confirm the supervisor is still alive without watching
  // logs. started / stopped bracket the supervisor lifetime — useful for
  // deployment auditing.
  | "engine.heartbeat"
  | "engine.started"
  | "engine.stopped"
  // Iter28: global kill switch was set / cleared. Operators should
  // know when this happens — locked means ALL fires + manual trades
  // are blocked. Useful for incident-response alerting and audit.
  | "engine.locked"
  | "engine.unlocked"
  // Synthetic event for the `notify test` command — used to verify a
  // channel is wired up without waiting for a real event to fire.
  | "test";

export type NotificationSeverity = "info" | "warn" | "critical";

export interface NotificationEvent {
  event: NotificationEventType | string;
  severity: NotificationSeverity;
  /** Short one-line title for chat clients (Slack/Discord show this prominently). */
  title: string;
  /** Longer free-form body. Markdown allowed (Slack mrkdwn + Discord both
   *  support a subset). Optional — when omitted, only the title renders. */
  body?: string;
  /** Structured payload echoed into the generic-POST body and rendered as a
   *  field list on Slack/Discord. Keep flat — nested objects flatten to
   *  one-line JSON in chat. */
  fields?: Record<string, string | number | boolean | null | undefined>;
  /** Optional explorer URL the chat client can hyperlink. Slack/Discord
   *  render a clickable footer; generic includes it in the payload. */
  link?: string;
  /** When set, the dispatcher suppresses identical (channel, dedupKey) pairs
   *  within the configured dedup window. Use a stable key per logical
   *  failure mode (e.g. `order.failed:42`) so a repeating error doesn't spam. */
  dedupKey?: string;
}

/** Channel formats we recognize. Determined by URL host inspection — see
 *  detectFormat below. Operators don't set this; it's derived. */
export type ChannelFormat = "slack" | "discord" | "telegram" | "generic";

// ── format detection ─────────────────────────────────────────

/**
 * Pure dispatcher: given a webhook URL, return the channel format. Exported
 * for testing without standing up the full notify stack.
 *
 *  hooks.slack.com                        → "slack"
 *  *.discord.com / discordapp.com         → "discord" (any /api/webhooks/* path)
 *  api.telegram.org/bot<TOKEN>/...        → "telegram"
 *  anything else (or malformed URL)       → "generic"
 *
 * The detector is conservative — when in doubt it falls back to generic
 * (a plain JSON POST), which is universally compatible with custom
 * receivers and webhook proxies.
 */
export function detectFormat(rawUrl: string): ChannelFormat {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "generic";
  }
  const host = u.hostname.toLowerCase();
  if (host === "hooks.slack.com") return "slack";
  if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) {
    return "discord";
  }
  if (host === "api.telegram.org") return "telegram";
  return "generic";
}

// ── payload builders ─────────────────────────────────────────

const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  info: "🔵",
  warn: "🟡",
  critical: "🔴",
};

const SEVERITY_COLOR: Record<NotificationSeverity, number> = {
  // Discord embed colors (24-bit integer). Slack uses these too as a
  // best-effort "attachment color" hint.
  info: 0x1f78b4,    // blue
  warn: 0xf9a825,    // amber
  critical: 0xd32f2f, // red
};

function fieldLines(fields: NotificationEvent["fields"]): string[] {
  if (!fields) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    out.push(`*${k}*: ${String(v)}`);
  }
  return out;
}

/** Slack incoming-webhook payload. Uses the Block Kit format — header +
 *  section + optional context. Falls back to plain `text` for simple events. */
export function buildSlackPayload(evt: NotificationEvent): Record<string, unknown> {
  const emoji = SEVERITY_EMOJI[evt.severity];
  const text = `${emoji} ${evt.title}`;
  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${evt.title}`, emoji: true },
    },
  ];
  const lines = [evt.body, ...fieldLines(evt.fields)].filter(Boolean).join("\n");
  if (lines) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: lines } });
  }
  if (evt.link) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${evt.link}|View>` }],
    });
  }
  return {
    // `text` is the fallback for clients that don't render blocks (mobile
    // notifications, screen readers). Slack uses it as the notification
    // preview text — keep it short and informative.
    text,
    blocks,
  };
}

/** Discord webhook payload. Single embed with color + fields. */
export function buildDiscordPayload(evt: NotificationEvent): Record<string, unknown> {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (evt.fields) {
    for (const [k, v] of Object.entries(evt.fields)) {
      if (v == null) continue;
      fields.push({ name: k, value: String(v), inline: true });
    }
  }
  const embed: Record<string, unknown> = {
    title: `${SEVERITY_EMOJI[evt.severity]} ${evt.title}`,
    color: SEVERITY_COLOR[evt.severity],
    timestamp: new Date().toISOString(),
  };
  if (evt.body) embed.description = evt.body;
  if (fields.length > 0) embed.fields = fields;
  if (evt.link) embed.url = evt.link;
  return { embeds: [embed] };
}

/** Telegram sendMessage payload. Markdown text body. The URL itself
 *  embeds `bot<TOKEN>` — we POST to /sendMessage with `chat_id` parsed
 *  from the URL query string. Operators set the channel URL as
 *  `https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>`. */
export function buildTelegramPayload(evt: NotificationEvent): Record<string, unknown> {
  const emoji = SEVERITY_EMOJI[evt.severity];
  const lines: string[] = [`${emoji} *${escapeTelegramMarkdown(evt.title)}*`];
  if (evt.body) lines.push("", escapeTelegramMarkdown(evt.body));
  for (const line of fieldLines(evt.fields)) lines.push(escapeTelegramMarkdown(line));
  if (evt.link) lines.push("", `[View](${evt.link})`);
  return {
    text: lines.join("\n"),
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
  };
}

/** Telegram MarkdownV2 requires escaping a known set of metacharacters
 *  outside the styling delimiters themselves. We escape the inputs (title,
 *  body, fields) before composing the final markdown so user-supplied
 *  symbols (think: `0x_ABC123`) don't break the parser. */
function escapeTelegramMarkdown(s: string): string {
  return s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/** Generic JSON POST body — the same shape across every non-chat receiver
 *  (custom webhook listener, Vector / Fluentd HTTP sink, internal ops bot).
 *  Stable enough that operators can write JSON-Schema validators against it. */
export function buildGenericPayload(evt: NotificationEvent): Record<string, unknown> {
  return {
    event: evt.event,
    severity: evt.severity,
    title: evt.title,
    body: evt.body ?? null,
    fields: evt.fields ?? null,
    link: evt.link ?? null,
    timestamp: new Date().toISOString(),
  };
}

/** Format-aware payload selection. Exported for testing. */
export function buildPayloadFor(format: ChannelFormat, evt: NotificationEvent): Record<string, unknown> {
  switch (format) {
    case "slack": return buildSlackPayload(evt);
    case "discord": return buildDiscordPayload(evt);
    case "telegram": return buildTelegramPayload(evt);
    case "generic": return buildGenericPayload(evt);
  }
}

// ── severity / event filtering ───────────────────────────────

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  warn: 1,
  critical: 2,
};

/** Pure predicate: would this event flow through this channel? Considers
 *  enabled flag, event allowlist, and severity floor. Exported for tests. */
export function eventMatchesChannel(channel: NotificationChannel, evt: NotificationEvent): boolean {
  if (channel.enabled === false) return false;
  if (channel.events && channel.events.length > 0 && !channel.events.includes(evt.event)) {
    return false;
  }
  return SEVERITY_RANK[evt.severity] >= SEVERITY_RANK[channel.minSeverity];
}

// ── dedup cache ──────────────────────────────────────────────
//
// In-memory map keyed by (channelName, dedupKey). Values are the timestamp
// (ms epoch) of the last successful dispatch for that pair. On each event
// we check whether the last dispatch was within `dedupWindowMs` — if so,
// skip. Bounded by an LRU sweep so a long-running process can't grow it
// unboundedly.

const dedupCache = new Map<string, number>();
const DEDUP_CACHE_MAX = 1000;

function dedupCacheKey(channelName: string, dedupKey: string): string {
  return `${channelName}|${dedupKey}`;
}

/** Returns true when this (channel, dedupKey) is currently in the suppress
 *  window. As a side effect, advances the timestamp on a fresh emission so
 *  consecutive same-key events bounce off the same window edge.
 *
 *  Exported for unit testing — `clearDedupCache()` resets between tests. */
export function shouldSuppressDedup(
  channelName: string,
  dedupKey: string,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  if (windowMs <= 0) return false;
  const key = dedupCacheKey(channelName, dedupKey);
  const prev = dedupCache.get(key);
  if (prev != null && now - prev < windowMs) return true;
  dedupCache.set(key, now);
  // Cheap FIFO eviction — Map preserves insertion order.
  while (dedupCache.size > DEDUP_CACHE_MAX) {
    const first = dedupCache.keys().next();
    if (first.done) break;
    dedupCache.delete(first.value);
  }
  return false;
}

export function clearDedupCache(): void {
  dedupCache.clear();
}

// ── quiet hours (v34) ────────────────────────────────────────
//
// Inside the window, sub-breakthrough notifications queue in the
// v34 notification_queue table and flush as ONE summary when the
// window ends. Channels with ignoreQuietHours always deliver.

export interface QuietHoursConfig {
  enabled: boolean;
  startHourUtc: number;
  endHourUtc: number;
  breakthroughSeverity: NotificationSeverity;
}

/** Pure window predicate. Handles midnight wrap (start > end →
 *  active from start to midnight AND midnight to end). start === end
 *  is a degenerate zero-length window — never active (an "all day"
 *  quiet config should just disable the channel instead). */
export function inQuietHours(now: Date, cfg: Pick<QuietHoursConfig, "startHourUtc" | "endHourUtc">): boolean {
  const h = now.getUTCHours();
  const { startHourUtc: s, endHourUtc: e } = cfg;
  if (s === e) return false;
  if (s < e) return h >= s && h < e;
  return h >= s || h < e;
}

/** Events that must never be queued: the flush summary itself (would
 *  recurse) and the daily digest (already time-gated by its own
 *  hourUtc — queueing it would double-delay). */
const QUIET_EXEMPT_EVENTS = new Set(["notify.quiet_flush", "digest.daily"]);

function quietHoursConfig(config: Config): QuietHoursConfig | null {
  const qh = config.notifications?.quietHours;
  if (!qh || !qh.enabled) return null;
  return qh;
}

/** Should this event be suppressed-and-queued right now? Pure given
 *  (event, config, now); exported for tests. */
export function shouldQueueForQuietHours(
  evt: NotificationEvent,
  config: Config,
  now: Date = new Date(),
): boolean {
  const qh = quietHoursConfig(config);
  if (!qh) return false;
  if (QUIET_EXEMPT_EVENTS.has(evt.event)) return false;
  if (!inQuietHours(now, qh)) return false;
  return SEVERITY_RANK[evt.severity] < SEVERITY_RANK[qh.breakthroughSeverity];
}

/**
 * Flush the queued notifications as ONE summary event. Called
 * automatically by notify() on the first delivery outside the window,
 * by the engine digest worker tick, and manually via
 * `tradekit notify flush`. No-op when the queue is empty or quiet
 * hours are still active (a manual --force overrides the window).
 *
 * Marking: rows flip to flushed when the summary DELIVERED to at
 * least one channel OR no channels are configured at all (nothing to
 * wait for). A failed webhook leaves them pending for the next flush
 * attempt.
 */
export async function flushQueuedNotifications(
  config: Config,
  logger: Logger,
  opts: { now?: Date; force?: boolean } = {},
): Promise<{ flushed: number; delivered: boolean } | null> {
  const now = opts.now ?? new Date();
  const qh = quietHoursConfig(config);
  if (qh && inQuietHours(now, qh) && !opts.force) return null; // still quiet
  const { pendingQueuedNotifications, markQueuedNotificationsFlushed } = await import("./db.js");
  const pending = pendingQueuedNotifications(500);
  if (pending.length === 0) return null;

  const bySeverity = { info: 0, warn: 0, critical: 0 } as Record<NotificationSeverity, number>;
  for (const q of pending) bySeverity[q.severity] = (bySeverity[q.severity] ?? 0) + 1;
  const maxSeverity: NotificationSeverity =
    bySeverity.critical > 0 ? "critical" : bySeverity.warn > 0 ? "warn" : "info";

  const PREVIEW = 15;
  const lines = pending.slice(-PREVIEW).map((q) => `[${q.severity}] ${q.queued_at.slice(11, 16)}Z ${q.title}`);
  const omitted = pending.length - Math.min(pending.length, PREVIEW);

  const summary: NotificationEvent = {
    event: "notify.quiet_flush",
    severity: maxSeverity,
    title: `${pending.length} notification(s) suppressed during quiet hours`,
    body:
      `${bySeverity.critical} critical · ${bySeverity.warn} warn · ${bySeverity.info} info\n\n` +
      (omitted > 0 ? `(${omitted} older omitted)\n` : "") +
      lines.join("\n"),
    fields: {
      queued: pending.length,
      critical: bySeverity.critical,
      warn: bySeverity.warn,
      info: bySeverity.info,
      oldestAt: pending[0]?.queued_at,
    },
    dedupKey: `notify.quiet_flush:${pending[0]?.queued_at ?? ""}`,
  };

  const report = await notify(summary, config, logger);
  const noChannels = report.channels === 0;
  const delivered = report.delivered > 0;
  if (delivered || noChannels) {
    markQueuedNotificationsFlushed(pending.map((q) => q.id), now.toISOString());
    logger.info(`quiet-hours flush: ${pending.length} queued notification(s) summarized${noChannels ? " (no channels configured)" : ""}`);
    return { flushed: pending.length, delivered };
  }
  logger.warn(`quiet-hours flush: summary delivery failed — ${pending.length} row(s) stay queued for retry`);
  return { flushed: 0, delivered: false };
}

// ── dispatch ─────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5000;

export interface DispatchResult {
  channelName: string;
  format: ChannelFormat;
  ok: boolean;
  status?: number;
  /** Per-event reason for skipping: "filtered" (event not allowed by
   *  channel's events[]) | "severity" (below minSeverity) | "disabled"
   *  | "dedup" (within suppress window). Missing on successful sends. */
  skipped?: "filtered" | "severity" | "disabled" | "dedup" | "quiet_hours";
  error?: string;
  elapsedMs?: number;
}

export interface NotifyReport {
  event: string;
  /** Total channels considered. */
  channels: number;
  /** Channels that actually sent. */
  delivered: number;
  /** Channels skipped via filtering / dedup. */
  skipped: number;
  /** Channels that attempted to send but failed. */
  failed: number;
  results: DispatchResult[];
}

/**
 * Fan out an event to every matching channel. Returns a per-channel
 * delivery report — even on failure. Caller is expected to log the report
 * at debug; we don't surface to the user except via `notify test`.
 *
 * Failure handling: every individual dispatch is wrapped — a single bad
 * channel can't bring down the others, and a network error never throws
 * out of this function. The DispatchResult.ok flag is the source of truth.
 */
export async function notify(
  evt: NotificationEvent,
  config: Config,
  logger: Logger,
): Promise<NotifyReport> {
  const allChannels = config.notifications?.channels ?? [];
  const dedupWindowMs = config.notifications?.dedupWindowMs ?? 60_000;
  const results: DispatchResult[] = [];
  if (allChannels.length === 0) {
    return { event: evt.event, channels: 0, delivered: 0, skipped: 0, failed: 0, results: [] };
  }

  // v34 quiet hours. Outside the window: opportunistically flush any
  // queued backlog FIRST so the summary lands before (and dated
  // earlier than) the event that woke us. Inside the window:
  // sub-breakthrough events queue once (if any non-exempt channel
  // would have received them) and deliver only to ignoreQuietHours
  // channels.
  let channels = allChannels;
  // Only consult the queue when the feature is on — operators without
  // quiet hours configured must never pay a DB open from the notify
  // path (it also keeps unit tests with no data dir hermetic).
  if (evt.event !== "notify.quiet_flush" && quietHoursConfig(config) != null) {
    try {
      const { countPendingQueuedNotifications } = await import("./db.js");
      if (countPendingQueuedNotifications() > 0) {
        await flushQueuedNotifications(config, logger);
      }
    } catch { /* queue table unavailable (fresh db mid-migration) — never block delivery */ }
  }
  if (shouldQueueForQuietHours(evt, config)) {
    const breakthrough = allChannels.filter((ch) => ch.ignoreQuietHours === true);
    const suppressed = allChannels.filter((ch) => ch.ignoreQuietHours !== true);
    // Queue only when a suppressed channel actually subscribes to the
    // event — otherwise the morning summary reports noise nobody
    // would have received anyway.
    const anySubscriber = suppressed.some((ch) => eventMatchesChannel(ch, evt));
    let suppressionHolds = true;
    if (anySubscriber) {
      try {
        const { enqueueNotification } = await import("./db.js");
        enqueueNotification({
          queuedAt: new Date().toISOString(),
          event: evt.event,
          severity: evt.severity,
          title: evt.title,
          body: evt.body ?? null,
          fieldsJson: evt.fields ? JSON.stringify(evt.fields) : null,
          dedupKey: evt.dedupKey ?? null,
        });
        logger.debug(`quiet hours: queued "${evt.title}" (${evt.severity})`);
      } catch (e) {
        // Fail open: a broken queue must not silently eat notifications.
        logger.warn(`quiet hours: enqueue failed (${(e as Error).message}) — delivering immediately instead`);
        suppressionHolds = false;
      }
    }
    if (suppressionHolds) {
      for (const ch of suppressed) {
        results.push({ channelName: ch.name, format: detectFormat(ch.url), ok: false, skipped: "quiet_hours" });
      }
      channels = breakthrough;
      if (channels.length === 0) {
        return { event: evt.event, channels: allChannels.length, delivered: 0, skipped: results.length, failed: 0, results };
      }
    }
  }

  // Per-channel dispatch happens in parallel — a slow Slack can't block
  // a fast generic POST. Promise.allSettled so individual failures don't
  // bubble. Each settle path produces a DispatchResult.
  const settled = await Promise.allSettled(
    channels.map((ch) => dispatchOne(ch, evt, dedupWindowMs, logger)),
  );
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      results.push(s.value);
    } else {
      results.push({
        channelName: channels[i].name,
        format: detectFormat(channels[i].url),
        ok: false,
        error: (s.reason as Error)?.message ?? String(s.reason),
      });
    }
  }
  let delivered = 0, skipped = 0, failed = 0;
  for (const r of results) {
    if (r.skipped) skipped += 1;
    else if (r.ok) delivered += 1;
    else failed += 1;
  }
  // v106: persist delivery health per channel so a silently-dead webhook is
  // caught proactively (doctor) instead of leaving the operator flying blind.
  // Only ATTEMPTED sends count — a skip (dedup/severity/quiet-hours/disabled)
  // is neither success nor failure. Best-effort: never let a DB hiccup break
  // notification delivery (and keep no-data-dir unit tests hermetic).
  const attempts = results.filter((r) => !r.skipped);
  if (attempts.length > 0) {
    try {
      const { recordNotificationDelivery } = await import("./db.js");
      for (const r of attempts) recordNotificationDelivery({ channelName: r.channelName, ok: r.ok, error: r.error ?? null });
    } catch { /* health table unavailable (fresh db / no data dir) — delivery already happened */ }
  }
  return { event: evt.event, channels: allChannels.length, delivered, skipped, failed, results };
}

async function dispatchOne(
  channel: NotificationChannel,
  evt: NotificationEvent,
  dedupWindowMs: number,
  logger: Logger,
): Promise<DispatchResult> {
  const format = detectFormat(channel.url);
  if (channel.enabled === false) {
    return { channelName: channel.name, format, ok: false, skipped: "disabled" };
  }
  if (channel.events && channel.events.length > 0 && !channel.events.includes(evt.event)) {
    return { channelName: channel.name, format, ok: false, skipped: "filtered" };
  }
  if (SEVERITY_RANK[evt.severity] < SEVERITY_RANK[channel.minSeverity]) {
    return { channelName: channel.name, format, ok: false, skipped: "severity" };
  }
  if (evt.dedupKey && shouldSuppressDedup(channel.name, evt.dedupKey, dedupWindowMs)) {
    return { channelName: channel.name, format, ok: false, skipped: "dedup" };
  }
  const body = JSON.stringify(buildPayloadFor(format, evt));
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(
      channel.url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
      { timeoutMs: channel.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
    const elapsedMs = Date.now() - t0;
    if (!res.ok) {
      // Drain body so the upstream connection can be reused. Best-effort.
      let snippet = "";
      try {
        snippet = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      logger.warn(
        `notify: ${channel.name} (${format}) responded ${res.status}: ${snippet}`,
      );
      return {
        channelName: channel.name,
        format,
        ok: false,
        status: res.status,
        error: snippet || `HTTP ${res.status}`,
        elapsedMs,
      };
    }
    logger.debug(`notify: ${channel.name} (${format}) delivered in ${elapsedMs}ms`);
    return { channelName: channel.name, format, ok: true, status: res.status, elapsedMs };
  } catch (e) {
    const elapsedMs = Date.now() - t0;
    const msg = (e as Error).message ?? String(e);
    // Critical invariant: NEVER re-throw. Webhook outages must not block
    // the surrounding trade / engine tick. Log loud enough to surface in
    // server.log without producing an alert-from-the-alerter loop.
    logger.warn(`notify: ${channel.name} (${format}) failed: ${msg}`);
    return { channelName: channel.name, format, ok: false, error: msg, elapsedMs };
  }
}

// ── convenience: tryNotify ───────────────────────────────────

/**
 * Fire-and-forget wrapper that catches the unlikely throws-out-of-notify
 * itself (config parsing weirdness, logger crash). The contract for callers
 * embedded in hot paths (trade.ts, orders.ts) is "this returns a settled
 * promise with no observable side effects on failure". The optional await
 * lets callers serialize delivery against subsequent work when they care
 * about ordering (the order engine awaits so a tick's log line includes the
 * delivery summary); most callers just leave the promise floating.
 */
export async function tryNotify(
  evt: NotificationEvent,
  config: Config,
  logger: Logger,
): Promise<NotifyReport | null> {
  try {
    return await notify(evt, config, logger);
  } catch (e) {
    logger.warn(`notify: unexpected failure: ${(e as Error).message}`);
    return null;
  }
}
