// ──────────────────────────────────────────────────────────────────
// Price provider statistics (iter38): in-memory per-provider
// observability for the price fetch layer.
//
// Why: pre-iter38, an operator hitting CoinGecko rate limits had
// no way to confirm "is CoinGecko the problem, or is it the
// network, or is it just DexScreener returning null?". The price
// path failed silently with `null`, the iter32 alerts watcher
// fired on stale data, and the operator played guess-the-cause.
//
// This module persists per-provider counters in-memory:
//   - Total calls
//   - Successes (returned a non-null price for at least one token)
//   - Failures (HTTP error, 429, timeout, parse error)
//   - Last error code + timestamp
//   - Bounded sliding window of recent latencies (for p50/p95)
//   - Tokens requested vs tokens with a price returned (hit rate)
//
// Stats are in-memory only: they reset on process restart. This is
// the right tradeoff — they're an operational debug aid, not an
// audit trail, and durable per-call telemetry would be expensive
// (every price tick = N stat rows). The persistent audit trail
// already lives in audit_log (per-trade fetches).
// ──────────────────────────────────────────────────────────────────

/** Providers we route price requests through. Adding a new
 *  provider requires extending this union + the dispatch in
 *  priceBatch.ts. */
export type PriceProvider = "coingecko" | "dexscreener";

/** A single recorded call against a provider. Pure value type. */
export interface ProviderCall {
  /** True when the call returned at least one usable price. False
   *  when it errored, timed out, or returned null for every
   *  requested token. */
  ok: boolean;
  /** Wall-clock latency in milliseconds. Measured from the moment
   *  the call started to the moment it returned (whether
   *  success or error). */
  latencyMs: number;
  /** How many tokens were requested. 1 for single-token DexScreener
   *  calls; up to ~250 for CoinGecko batched calls. */
  tokensRequested: number;
  /** How many tokens got a non-null price in this call. 0 when
   *  ok=false. */
  tokensReturned: number;
  /** When ok=false, a short error tag for the operator. Common
   *  values: "HTTP_429", "HTTP_5xx", "TIMEOUT", "PARSE_ERROR",
   *  "NETWORK_ERROR". */
  errorCode?: string;
  /** When ok=true but some tokens were null, the latest specific
   *  HTTP error code seen (informational — operators tracking
   *  "DexScreener returns 200 with empty pairs for token X" need
   *  the differentiation). */
  partialError?: string;
}

/** Aggregated per-provider counters. Reset only on process
 *  restart. */
export interface ProviderStats {
  provider: PriceProvider;
  totalCalls: number;
  successes: number;
  failures: number;
  tokensRequested: number;
  tokensReturned: number;
  hitRate: number; // tokensReturned / max(tokensRequested, 1)
  /** Last error seen + when. Empty when no failures since reset. */
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  /** Sliding-window latency stats. null until first call. */
  timing: TimingSummary | null;
  /** ISO timestamp of the first recorded call after reset. Lets
   *  the operator see "stats are for the last 4h" by comparing
   *  to now. */
  observedSince: string | null;
  observedUntil: string | null;
}

export interface TimingSummary {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Default sliding window. 50 samples is enough for stable p50/p95
 *  on a single provider while bounding memory to ~400 bytes per
 *  provider. */
const DEFAULT_WINDOW = 50;

interface InternalState {
  totalCalls: number;
  successes: number;
  failures: number;
  tokensRequested: number;
  tokensReturned: number;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  /** Newest-first ring of recent latencies. */
  recentLatenciesMs: number[];
  observedSince: string | null;
  observedUntil: string | null;
}

const state = new Map<PriceProvider, InternalState>();

function emptyState(): InternalState {
  return {
    totalCalls: 0,
    successes: 0,
    failures: 0,
    tokensRequested: 0,
    tokensReturned: 0,
    lastErrorCode: null,
    lastErrorAt: null,
    recentLatenciesMs: [],
    observedSince: null,
    observedUntil: null,
  };
}

/** Record a call against a provider. Pure-effectful — bumps the
 *  in-memory map, never throws. */
export function recordProviderCall(
  provider: PriceProvider,
  call: ProviderCall,
  opts: { window?: number; nowFn?: () => Date } = {},
): void {
  const now = (opts.nowFn ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const window = Math.max(2, opts.window ?? DEFAULT_WINDOW);

  let s = state.get(provider);
  if (!s) {
    s = emptyState();
    state.set(provider, s);
  }
  if (!s.observedSince) s.observedSince = nowIso;
  s.observedUntil = nowIso;
  s.totalCalls += 1;
  s.tokensRequested += call.tokensRequested;
  s.tokensReturned += call.tokensReturned;
  if (call.ok) {
    s.successes += 1;
  } else {
    s.failures += 1;
    if (call.errorCode) {
      s.lastErrorCode = call.errorCode;
      s.lastErrorAt = nowIso;
    }
  }
  // partialError stays in lastErrorCode too — operators care
  // about "the most recent error of any kind", not just hard
  // failures.
  if (call.partialError && call.ok) {
    s.lastErrorCode = call.partialError;
    s.lastErrorAt = nowIso;
  }
  // Bounded ring buffer for the latency window.
  s.recentLatenciesMs.unshift(call.latencyMs);
  if (s.recentLatenciesMs.length > window) {
    s.recentLatenciesMs.length = window;
  }
}

/** Snapshot of all known providers. The order is the iteration
 *  order of the underlying Map — insertion order, which means
 *  "first observed" — stable across calls within a process
 *  lifetime. */
export function getProviderStats(): ProviderStats[] {
  const out: ProviderStats[] = [];
  for (const [provider, s] of state) {
    out.push(hydrate(provider, s));
  }
  return out;
}

/** Single-provider lookup. Returns null when the provider has
 *  never been called this process lifetime. */
export function getProviderStat(provider: PriceProvider): ProviderStats | null {
  const s = state.get(provider);
  return s ? hydrate(provider, s) : null;
}

function hydrate(provider: PriceProvider, s: InternalState): ProviderStats {
  return {
    provider,
    totalCalls: s.totalCalls,
    successes: s.successes,
    failures: s.failures,
    tokensRequested: s.tokensRequested,
    tokensReturned: s.tokensReturned,
    hitRate: s.tokensRequested > 0 ? s.tokensReturned / s.tokensRequested : 0,
    lastErrorCode: s.lastErrorCode,
    lastErrorAt: s.lastErrorAt,
    timing: summarizeTiming(s.recentLatenciesMs),
    observedSince: s.observedSince,
    observedUntil: s.observedUntil,
  };
}

/** Bounded percentile aggregator. Returns null when the window is
 *  empty. Exported for testing. */
export function summarizeTiming(samples: readonly number[]): TimingSummary | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = (p: number) => Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    count: sorted.length,
    avgMs: sum / sorted.length,
    p50Ms: sorted[idx(0.5)],
    p95Ms: sorted[idx(0.95)],
    maxMs: sorted[sorted.length - 1],
  };
}

/** Wipe all provider stats. Used by tests + by a future
 *  `tradekit price stats --reset` CLI surface. */
export function resetProviderStats(provider?: PriceProvider): void {
  if (provider) {
    state.delete(provider);
  } else {
    state.clear();
  }
}

/** Categorize an unknown error/exception thrown during a price
 *  fetch into one of our known error codes. Exported for the
 *  priceBatch path to feed recordProviderCall.errorCode. */
export function classifyFetchError(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  const name = (e as Error)?.name ?? "";
  // SyntaxError carries its discriminator in `.name`, not `.message`,
  // so probe both. Same for any future named error subclasses
  // (RangeError, TypeError used as parser invariant guards).
  const haystack = `${name}: ${message}`;
  if (/HTTP\s+429/i.test(haystack) || /Too Many Requests/i.test(haystack)) return "HTTP_429";
  if (/HTTP\s+5\d\d/i.test(haystack)) return "HTTP_5xx";
  if (/HTTP\s+4\d\d/i.test(haystack)) return "HTTP_4xx";
  if (/timed?\s*out|timeout/i.test(haystack)) return "TIMEOUT";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network/i.test(haystack)) return "NETWORK_ERROR";
  if (/SyntaxError|JSON|parse/i.test(haystack)) return "PARSE_ERROR";
  return "UNKNOWN_ERROR";
}
