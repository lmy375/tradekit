// Tests for priceStats.ts (iter38). Entirely pure — no HTTP, no DB.

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordProviderCall,
  getProviderStat,
  getProviderStats,
  resetProviderStats,
  summarizeTiming,
  classifyFetchError,
} from "./priceStats.js";

const NOW = new Date("2026-05-31T12:00:00Z");

beforeEach(() => {
  resetProviderStats();
});

// ── recordProviderCall ──────────────────────────────────────

describe("recordProviderCall", () => {
  it("creates a new state entry on first call", () => {
    recordProviderCall("coingecko", {
      ok: true,
      latencyMs: 100,
      tokensRequested: 1,
      tokensReturned: 1,
    }, { nowFn: () => NOW });
    const s = getProviderStat("coingecko");
    expect(s).not.toBeNull();
    expect(s!.totalCalls).toBe(1);
    expect(s!.successes).toBe(1);
    expect(s!.failures).toBe(0);
    expect(s!.observedSince).toBe(NOW.toISOString());
  });

  it("increments counters across multiple calls", () => {
    for (let i = 0; i < 5; i++) {
      recordProviderCall("coingecko", { ok: true, latencyMs: 100, tokensRequested: 1, tokensReturned: 1 });
    }
    const s = getProviderStat("coingecko")!;
    expect(s.totalCalls).toBe(5);
    expect(s.successes).toBe(5);
  });

  it("records failure + lastErrorCode + lastErrorAt", () => {
    recordProviderCall("coingecko", {
      ok: false, latencyMs: 5000, tokensRequested: 1, tokensReturned: 0, errorCode: "HTTP_429",
    }, { nowFn: () => NOW });
    const s = getProviderStat("coingecko")!;
    expect(s.failures).toBe(1);
    expect(s.lastErrorCode).toBe("HTTP_429");
    expect(s.lastErrorAt).toBe(NOW.toISOString());
  });

  it("aggregates tokensRequested + tokensReturned across batched calls", () => {
    recordProviderCall("coingecko", { ok: true, latencyMs: 200, tokensRequested: 10, tokensReturned: 8 });
    recordProviderCall("coingecko", { ok: true, latencyMs: 150, tokensRequested: 5, tokensReturned: 5 });
    const s = getProviderStat("coingecko")!;
    expect(s.tokensRequested).toBe(15);
    expect(s.tokensReturned).toBe(13);
    expect(s.hitRate).toBeCloseTo(13 / 15);
  });

  it("tracks partialError as lastErrorCode when ok=true", () => {
    // Successful call that returned null for some tokens — operator
    // wants to see "the most recent error of any kind", even on
    // ok=true responses.
    recordProviderCall("coingecko", {
      ok: true, latencyMs: 100, tokensRequested: 3, tokensReturned: 2, partialError: "TOKEN_MISSING",
    }, { nowFn: () => NOW });
    const s = getProviderStat("coingecko")!;
    expect(s.lastErrorCode).toBe("TOKEN_MISSING");
    expect(s.failures).toBe(0);
  });

  it("isolates state across providers", () => {
    recordProviderCall("coingecko", { ok: true, latencyMs: 100, tokensRequested: 1, tokensReturned: 1 });
    recordProviderCall("dexscreener", { ok: false, latencyMs: 200, tokensRequested: 1, tokensReturned: 0, errorCode: "HTTP_429" });
    expect(getProviderStat("coingecko")?.successes).toBe(1);
    expect(getProviderStat("dexscreener")?.failures).toBe(1);
  });
});

// ── sliding window ──────────────────────────────────────────

describe("recordProviderCall — sliding window", () => {
  it("bounds latency window to default 50", () => {
    for (let i = 0; i < 60; i++) {
      recordProviderCall("coingecko", { ok: true, latencyMs: i, tokensRequested: 1, tokensReturned: 1 });
    }
    const s = getProviderStat("coingecko")!;
    expect(s.timing).not.toBeNull();
    expect(s.timing!.count).toBe(50);
    // Newest first means the window contains 59..10 (50 elements).
    expect(s.timing!.maxMs).toBe(59);
  });

  it("honors custom window size", () => {
    for (let i = 0; i < 20; i++) {
      recordProviderCall("coingecko", { ok: true, latencyMs: i, tokensRequested: 1, tokensReturned: 1 }, { window: 5 });
    }
    const s = getProviderStat("coingecko")!;
    expect(s.timing!.count).toBe(5);
  });
});

// ── summarizeTiming ─────────────────────────────────────────

describe("summarizeTiming", () => {
  it("returns null for empty samples", () => {
    expect(summarizeTiming([])).toBeNull();
  });

  it("computes avg / p50 / p95 / max", () => {
    const t = summarizeTiming([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(t).not.toBeNull();
    expect(t!.count).toBe(10);
    expect(t!.avgMs).toBe(55);
    expect(t!.p50Ms).toBe(60); // sorted[5]
    expect(t!.p95Ms).toBe(100); // sorted[9]
    expect(t!.maxMs).toBe(100);
  });

  it("handles single sample", () => {
    const t = summarizeTiming([200]);
    expect(t).toEqual({ count: 1, avgMs: 200, p50Ms: 200, p95Ms: 200, maxMs: 200 });
  });

  it("works on unsorted input", () => {
    const t = summarizeTiming([100, 5, 50, 10, 25])!;
    expect(t.maxMs).toBe(100);
    expect(t.avgMs).toBeCloseTo((100 + 5 + 50 + 10 + 25) / 5);
  });
});

// ── getProviderStats ────────────────────────────────────────

describe("getProviderStats", () => {
  it("returns empty array when nothing recorded", () => {
    expect(getProviderStats()).toEqual([]);
  });

  it("returns one entry per provider observed", () => {
    recordProviderCall("coingecko", { ok: true, latencyMs: 100, tokensRequested: 1, tokensReturned: 1 });
    recordProviderCall("dexscreener", { ok: true, latencyMs: 200, tokensRequested: 1, tokensReturned: 1 });
    const all = getProviderStats();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.provider).sort()).toEqual(["coingecko", "dexscreener"]);
  });
});

// ── resetProviderStats ──────────────────────────────────────

describe("resetProviderStats", () => {
  it("clears all providers when called with no arg", () => {
    recordProviderCall("coingecko", { ok: true, latencyMs: 100, tokensRequested: 1, tokensReturned: 1 });
    recordProviderCall("dexscreener", { ok: true, latencyMs: 100, tokensRequested: 1, tokensReturned: 1 });
    resetProviderStats();
    expect(getProviderStats()).toEqual([]);
  });

  it("clears only the targeted provider when specified", () => {
    recordProviderCall("coingecko", { ok: true, latencyMs: 100, tokensRequested: 1, tokensReturned: 1 });
    recordProviderCall("dexscreener", { ok: true, latencyMs: 100, tokensRequested: 1, tokensReturned: 1 });
    resetProviderStats("coingecko");
    expect(getProviderStat("coingecko")).toBeNull();
    expect(getProviderStat("dexscreener")?.successes).toBe(1);
  });
});

// ── classifyFetchError ──────────────────────────────────────

describe("classifyFetchError", () => {
  it("classifies 429 as HTTP_429", () => {
    expect(classifyFetchError(new Error("HTTP 429 Too Many Requests"))).toBe("HTTP_429");
    expect(classifyFetchError(new Error("oh no - Too Many Requests"))).toBe("HTTP_429");
  });

  it("classifies 5xx as HTTP_5xx", () => {
    expect(classifyFetchError(new Error("HTTP 502 Bad Gateway"))).toBe("HTTP_5xx");
    expect(classifyFetchError(new Error("HTTP 503 Service Unavailable"))).toBe("HTTP_5xx");
  });

  it("classifies generic 4xx as HTTP_4xx", () => {
    expect(classifyFetchError(new Error("HTTP 404 Not Found"))).toBe("HTTP_4xx");
  });

  it("classifies timeouts", () => {
    expect(classifyFetchError(new Error("request timed out"))).toBe("TIMEOUT");
    expect(classifyFetchError(new Error("timeout: 10s"))).toBe("TIMEOUT");
  });

  it("classifies network errors", () => {
    expect(classifyFetchError(new Error("ECONNREFUSED"))).toBe("NETWORK_ERROR");
    expect(classifyFetchError(new Error("ENOTFOUND api.coingecko.com"))).toBe("NETWORK_ERROR");
    expect(classifyFetchError(new Error("fetch failed"))).toBe("NETWORK_ERROR");
  });

  it("classifies parse errors", () => {
    expect(classifyFetchError(new SyntaxError("Unexpected token"))).toBe("PARSE_ERROR");
    expect(classifyFetchError(new Error("Invalid JSON"))).toBe("PARSE_ERROR");
  });

  it("falls back to UNKNOWN_ERROR for unfamiliar messages", () => {
    expect(classifyFetchError(new Error("something weird happened"))).toBe("UNKNOWN_ERROR");
    expect(classifyFetchError("string error")).toBe("UNKNOWN_ERROR");
  });
});

// ── observed time window ────────────────────────────────────

describe("observed window", () => {
  it("captures observedSince on first call + advances observedUntil on each call", () => {
    const t1 = new Date("2026-05-31T12:00:00Z");
    const t2 = new Date("2026-05-31T12:05:00Z");
    recordProviderCall("coingecko", { ok: true, latencyMs: 100, tokensRequested: 1, tokensReturned: 1 }, { nowFn: () => t1 });
    recordProviderCall("coingecko", { ok: true, latencyMs: 100, tokensRequested: 1, tokensReturned: 1 }, { nowFn: () => t2 });
    const s = getProviderStat("coingecko")!;
    expect(s.observedSince).toBe(t1.toISOString());
    expect(s.observedUntil).toBe(t2.toISOString());
  });
});
