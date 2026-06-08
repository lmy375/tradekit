// Tests for the notification / webhook dispatcher (notify.ts). Pure-logic
// tests for format detection + payload builders + filter predicates (no
// network) followed by an end-to-end notify() integration that mocks the
// global fetch so we exercise the full dispatch path without standing up
// a real HTTP server.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  detectFormat,
  buildSlackPayload,
  buildDiscordPayload,
  buildTelegramPayload,
  buildGenericPayload,
  buildPayloadFor,
  eventMatchesChannel,
  shouldSuppressDedup,
  clearDedupCache,
  notify,
  tryNotify,
  type NotificationEvent,
} from "./notify.js";
import { configSchema, redactWebhookUrl, redactConfigForDisplay } from "./config.js";
import { redactSensitiveFields } from "./db.js";
import type { Logger } from "./logger.js";

const stubLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  recordAudit: () => {},
} as unknown as Logger;

// ── detectFormat ─────────────────────────────────────────────

describe("detectFormat", () => {
  it("recognizes Slack incoming webhooks", () => {
    expect(detectFormat("https://hooks.slack.com/services/T1/B2/abc")).toBe("slack");
  });
  it("recognizes Discord webhooks (apex + subdomain + legacy host)", () => {
    expect(detectFormat("https://discord.com/api/webhooks/123/abc")).toBe("discord");
    expect(detectFormat("https://canary.discord.com/api/webhooks/123/abc")).toBe("discord");
    expect(detectFormat("https://discordapp.com/api/webhooks/123/abc")).toBe("discord");
  });
  it("recognizes Telegram bot API URLs", () => {
    expect(
      detectFormat("https://api.telegram.org/bot12345:ABCDEF/sendMessage?chat_id=42"),
    ).toBe("telegram");
  });
  it("falls back to generic for unknown hosts", () => {
    expect(detectFormat("https://hooks.example.com/x")).toBe("generic");
    expect(detectFormat("https://my-relay.internal/webhook")).toBe("generic");
  });
  it("returns generic for malformed URLs", () => {
    expect(detectFormat("not-a-url")).toBe("generic");
    expect(detectFormat("")).toBe("generic");
  });
});

// ── payload builders ─────────────────────────────────────────

function ev(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    event: "order.filled",
    severity: "info",
    title: "Order #42 filled",
    body: "ETH ≤ $2900 trigger met",
    fields: { id: 42, price: "2898.50", txHash: "0xabc" },
    link: "https://basescan.org/tx/0xabc",
    ...overrides,
  };
}

describe("buildSlackPayload", () => {
  it("returns a header block + section block + context link", () => {
    const p = buildSlackPayload(ev());
    expect(p.text).toContain("Order #42 filled");
    const blocks = p.blocks as Array<{ type: string }>;
    expect(blocks[0].type).toBe("header");
    expect(blocks.some((b) => b.type === "section")).toBe(true);
    expect(blocks.some((b) => b.type === "context")).toBe(true);
  });
  it("emoji reflects severity (info=🔵 warn=🟡 critical=🔴)", () => {
    expect((buildSlackPayload(ev({ severity: "info" })).text as string)).toMatch(/🔵/);
    expect((buildSlackPayload(ev({ severity: "warn" })).text as string)).toMatch(/🟡/);
    expect((buildSlackPayload(ev({ severity: "critical" })).text as string)).toMatch(/🔴/);
  });
  it("omits context block when link is absent", () => {
    const p = buildSlackPayload(ev({ link: undefined }));
    const blocks = p.blocks as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === "context")).toBe(false);
  });
});

describe("buildDiscordPayload", () => {
  it("returns a single embed with color + fields + url", () => {
    const p = buildDiscordPayload(ev()) as { embeds: Array<Record<string, unknown>> };
    expect(p.embeds.length).toBe(1);
    const e = p.embeds[0];
    expect(e.color).toBe(0x1f78b4); // info blue
    expect(e.description).toBe("ETH ≤ $2900 trigger met");
    expect(e.url).toBe("https://basescan.org/tx/0xabc");
    expect((e.fields as unknown[]).length).toBe(3);
  });
  it("severity drives the color (critical=red, warn=amber, info=blue)", () => {
    expect((buildDiscordPayload(ev({ severity: "critical" })).embeds as Array<{color: number}>)[0].color).toBe(0xd32f2f);
    expect((buildDiscordPayload(ev({ severity: "warn" })).embeds as Array<{color: number}>)[0].color).toBe(0xf9a825);
  });
});

describe("buildTelegramPayload", () => {
  it("uses MarkdownV2 + escapes metacharacters", () => {
    const p = buildTelegramPayload(ev({ title: "Order #42 filled!", body: "0x_ABC.123" }));
    expect(p.parse_mode).toBe("MarkdownV2");
    // ! and . are MarkdownV2 metacharacters; escapeTelegramMarkdown backslashes them.
    expect(p.text).toContain("Order \\#42 filled\\!");
    expect(p.text).toContain("0x\\_ABC\\.123");
  });
  it("renders link as a [View](url) footer", () => {
    const p = buildTelegramPayload(ev());
    expect(p.text).toMatch(/\[View\]\(https:\/\/basescan/);
  });
  it("disables link preview", () => {
    expect(buildTelegramPayload(ev()).disable_web_page_preview).toBe(true);
  });
});

describe("buildGenericPayload", () => {
  it("returns a stable flat JSON shape", () => {
    const p = buildGenericPayload(ev());
    expect(p.event).toBe("order.filled");
    expect(p.severity).toBe("info");
    expect(p.title).toBe("Order #42 filled");
    expect(p.fields).toEqual({ id: 42, price: "2898.50", txHash: "0xabc" });
    expect(p.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("nullable fields default to null (not undefined) so JSON consumers see uniform keys", () => {
    const p = buildGenericPayload({ event: "test", severity: "info", title: "x" });
    expect(p.body).toBeNull();
    expect(p.fields).toBeNull();
    expect(p.link).toBeNull();
  });
});

describe("buildPayloadFor", () => {
  it("dispatches by format identifier", () => {
    expect((buildPayloadFor("slack", ev()) as { blocks: unknown[] }).blocks).toBeDefined();
    expect((buildPayloadFor("discord", ev()) as { embeds: unknown[] }).embeds).toBeDefined();
    expect((buildPayloadFor("telegram", ev()) as { text: string }).text).toBeDefined();
    expect((buildPayloadFor("generic", ev()) as { event: string }).event).toBeDefined();
  });
});

// ── eventMatchesChannel ──────────────────────────────────────

function chan(overrides: Partial<import("./config.js").NotificationChannel> = {}) {
  return {
    name: "test",
    url: "https://example.com/x",
    events: undefined,
    minSeverity: "info" as const,
    enabled: true,
    ...overrides,
  };
}

describe("eventMatchesChannel", () => {
  it("disabled channels never match", () => {
    expect(eventMatchesChannel(chan({ enabled: false }), ev())).toBe(false);
  });
  it("empty / undefined events allowlist passes all events", () => {
    expect(eventMatchesChannel(chan(), ev({ event: "order.filled" }))).toBe(true);
    expect(eventMatchesChannel(chan({ events: [] }), ev({ event: "order.filled" }))).toBe(true);
    expect(eventMatchesChannel(chan(), ev({ event: "approval.infinite" }))).toBe(true);
  });
  it("non-empty allowlist blocks unlisted events", () => {
    const c = chan({ events: ["order.failed", "trade.failed"] });
    expect(eventMatchesChannel(c, ev({ event: "order.filled" }))).toBe(false);
    expect(eventMatchesChannel(c, ev({ event: "order.failed" }))).toBe(true);
  });
  it("severity floor: minSeverity=warn blocks info but passes warn+critical", () => {
    const c = chan({ minSeverity: "warn" });
    expect(eventMatchesChannel(c, ev({ severity: "info" }))).toBe(false);
    expect(eventMatchesChannel(c, ev({ severity: "warn" }))).toBe(true);
    expect(eventMatchesChannel(c, ev({ severity: "critical" }))).toBe(true);
  });
  it("severity floor: minSeverity=critical blocks info + warn", () => {
    const c = chan({ minSeverity: "critical" });
    expect(eventMatchesChannel(c, ev({ severity: "info" }))).toBe(false);
    expect(eventMatchesChannel(c, ev({ severity: "warn" }))).toBe(false);
    expect(eventMatchesChannel(c, ev({ severity: "critical" }))).toBe(true);
  });
});

// ── shouldSuppressDedup ──────────────────────────────────────

describe("shouldSuppressDedup", () => {
  beforeEach(() => clearDedupCache());

  it("first emission is never suppressed", () => {
    expect(shouldSuppressDedup("ch1", "k1", 60_000, 1000)).toBe(false);
  });
  it("second emission within the window IS suppressed", () => {
    shouldSuppressDedup("ch1", "k1", 60_000, 1000);
    expect(shouldSuppressDedup("ch1", "k1", 60_000, 30_000)).toBe(true);
  });
  it("second emission after the window is NOT suppressed", () => {
    shouldSuppressDedup("ch1", "k1", 60_000, 1000);
    expect(shouldSuppressDedup("ch1", "k1", 60_000, 90_000)).toBe(false);
  });
  it("different (channel, key) pairs don't interfere", () => {
    shouldSuppressDedup("ch1", "k1", 60_000, 1000);
    expect(shouldSuppressDedup("ch2", "k1", 60_000, 1500)).toBe(false);
    expect(shouldSuppressDedup("ch1", "k2", 60_000, 1500)).toBe(false);
  });
  it("windowMs=0 disables dedup entirely", () => {
    shouldSuppressDedup("ch1", "k1", 0, 1000);
    expect(shouldSuppressDedup("ch1", "k1", 0, 1000)).toBe(false);
  });
});

// ── notify() end-to-end with mocked fetch ────────────────────

describe("notify (end-to-end with mocked fetch)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearDedupCache();
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeConfig(channels: Partial<import("./config.js").NotificationChannel>[] = []): import("./config.js").Config {
    return configSchema.parse({
      notifications: {
        channels: channels.map((c) => ({
          name: "x",
          url: "https://hooks.slack.com/services/T/B/abc",
          minSeverity: "info",
          enabled: true,
          ...c,
        })),
        dedupWindowMs: 60_000,
      },
    });
  }

  it("no-op when no channels configured", async () => {
    const r = await notify(ev(), makeConfig([]), stubLogger);
    expect(r.channels).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatches to every matching channel in parallel", async () => {
    const cfg = makeConfig([
      { name: "slack", url: "https://hooks.slack.com/services/T/B/abc" },
      { name: "discord", url: "https://discord.com/api/webhooks/1/abc" },
      { name: "generic", url: "https://relay.example.com/hook" },
    ]);
    const r = await notify(ev(), cfg, stubLogger);
    expect(r.delivered).toBe(3);
    expect(r.failed).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(r.results.map((x) => x.format).sort()).toEqual(["discord", "generic", "slack"]);
  });

  it("respects the event allowlist (filtered result, no fetch)", async () => {
    const cfg = makeConfig([
      { name: "ord-only", events: ["order.failed"] },
    ]);
    const r = await notify(ev({ event: "order.filled" }), cfg, stubLogger);
    expect(r.skipped).toBe(1);
    expect(r.delivered).toBe(0);
    expect(r.results[0].skipped).toBe("filtered");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("respects the minSeverity floor (severity-skip result, no fetch)", async () => {
    const cfg = makeConfig([{ name: "critical-only", minSeverity: "critical" }]);
    const r = await notify(ev({ severity: "warn" }), cfg, stubLogger);
    expect(r.results[0].skipped).toBe("severity");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("disabled channels skip without fetching", async () => {
    const cfg = makeConfig([{ name: "paused", enabled: false }]);
    const r = await notify(ev(), cfg, stubLogger);
    expect(r.results[0].skipped).toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dedup window suppresses second identical emission", async () => {
    const cfg = makeConfig([{ name: "ch", url: "https://relay.example.com/x" }]);
    const e = ev({ dedupKey: "order.failed:42" });
    const r1 = await notify(e, cfg, stubLogger);
    const r2 = await notify(e, cfg, stubLogger);
    expect(r1.delivered).toBe(1);
    expect(r2.delivered).toBe(0);
    expect(r2.results[0].skipped).toBe("dedup");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("HTTP failure marks result as ok=false WITHOUT throwing", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("server boom", { status: 500 }));
    const cfg = makeConfig([{ name: "bad", url: "https://relay.example.com/x" }]);
    const r = await notify(ev(), cfg, stubLogger);
    expect(r.failed).toBe(1);
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].status).toBe(500);
  });

  it("network error marks result as ok=false WITHOUT throwing", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    const cfg = makeConfig([{ name: "bad", url: "https://relay.example.com/x" }]);
    const r = await notify(ev(), cfg, stubLogger);
    expect(r.failed).toBe(1);
    expect(r.results[0].error).toMatch(/fetch failed/);
  });

  it("one bad channel doesn't poison the others", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const cfg = makeConfig([
      { name: "a", url: "https://hooks.slack.com/services/T/B/a" },
      { name: "b", url: "https://relay.example.com/b" },
      { name: "c", url: "https://hooks.slack.com/services/T/B/c" },
    ]);
    const r = await notify(ev(), cfg, stubLogger);
    expect(r.delivered).toBe(2);
    expect(r.failed).toBe(1);
    // The middle dispatch is the one that should have failed.
    const byName = Object.fromEntries(r.results.map((x) => [x.channelName, x]));
    expect(byName["a"].ok).toBe(true);
    expect(byName["b"].ok).toBe(false);
    expect(byName["c"].ok).toBe(true);
  });
});

// ── tryNotify never throws ───────────────────────────────────

describe("tryNotify", () => {
  it("returns null when notify() throws (defense-in-depth wrapper)", async () => {
    // tryNotify wraps notify in try/catch. Force a throw by handing notify
    // a config whose channels[] is an object pretending to be an array but
    // throws on iteration — exercises the catch path without needing a
    // Zod-bypass fake. .map() invokes [Symbol.iterator] which throws here.
    const evilChannels = {
      length: 1,
      0: { name: "x", url: "https://relay.example.com/x", minSeverity: "info", enabled: true },
      map: () => { throw new Error("simulated config corruption"); },
    } as unknown as never[];
    const cfg = {
      notifications: { channels: evilChannels, dedupWindowMs: 60_000 },
    } as unknown as import("./config.js").Config;
    const result = await tryNotify(ev(), cfg, stubLogger);
    expect(result).toBeNull();
  });
  it("returns the same shape as notify() on the happy path", async () => {
    const cfg = configSchema.parse({ notifications: { channels: [], dedupWindowMs: 0 } });
    const r = await tryNotify(ev(), cfg, stubLogger);
    expect(r).toMatchObject({ event: "order.filled", channels: 0, delivered: 0 });
  });
});

// ── redaction integration ────────────────────────────────────

describe("webhook URL redaction", () => {
  it("redactWebhookUrl preserves host but masks the path", () => {
    expect(redactWebhookUrl("https://hooks.slack.com/services/T1/B2/secret")).toBe(
      "https://hooks.slack.com/[REDACTED]",
    );
    expect(redactWebhookUrl("https://discord.com/api/webhooks/123/abcdef")).toBe(
      "https://discord.com/[REDACTED]",
    );
  });
  it("malformed URLs collapse to [REDACTED]", () => {
    expect(redactWebhookUrl("not-a-url")).toBe("[REDACTED]");
  });
  it("redactConfigForDisplay scrubs channel URLs", () => {
    const cfg = configSchema.parse({
      notifications: {
        channels: [
          { name: "slack", url: "https://hooks.slack.com/services/T1/B2/secret" },
        ],
      },
    });
    const display = redactConfigForDisplay(cfg);
    expect(display.notifications.channels[0].url).toBe("https://hooks.slack.com/[REDACTED]");
    // Original is untouched (function returns a copy).
    expect(cfg.notifications.channels[0].url).toBe("https://hooks.slack.com/services/T1/B2/secret");
  });
  it("redactSensitiveFields scrubs webhook/webhook_url keys at any nesting depth", () => {
    const redacted = redactSensitiveFields({
      action: "create",
      params: { webhook: "https://hooks.slack.com/x/y/z", chain: "base" },
    });
    expect((redacted.params as { webhook: string }).webhook).toBe("[REDACTED]");
    expect((redacted.params as { chain: string }).chain).toBe("base");
  });
});
