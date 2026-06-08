/**
 * Shared HTTP helpers. Centralising the timeout pattern keeps "fetch with no timeout"
 * out of every call site — a slow external API can hang the whole tool otherwise.
 */

import { tradekitVersion } from "./version.js";

/** Default per-request timeout for external API calls. Override via env. */
const DEFAULT_TIMEOUT_MS = Number(process.env.TRADEKIT_HTTP_TIMEOUT_MS) || 8000;

/**
 * Iter417: identify outbound tradekit traffic to upstream APIs. Without this, every
 * KyberSwap / OpenOcean / CoinGecko / DexScreener request shows up as undici (Node's
 * default fetch UA) — opaque to upstream operators and bad for per-app rate-limit
 * carve-outs. Caller-supplied User-Agent wins (some integrations need to pin a
 * specific UA for partner agreements), so we only set it when the caller didn't.
 * Memoized via tradekitVersion()'s own cache so we don't re-read package.json.
 */
function buildDefaultUserAgent(): string {
  return `tradekit/${tradekitVersion()} (+https://github.com/anthropics/tradekit)`;
}

function withDefaultUserAgent(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", buildDefaultUserAgent());
  return { ...(init ?? {}), headers };
}

export interface FetchOpts {
  /** Per-request timeout in ms. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Retries on transient failures: timeout, network error, 5xx, 429. Default 0 (no
   * retry). Caller MUST be confident the request is idempotent (GET-style). Non-2xx
   * 4xx responses (excluding 429) are NOT retried — they signal real bad-input/auth
   * problems and retrying just wastes the user's rate-limit budget.
   */
  retries?: number;
  /** Base backoff in ms. Each retry waits baseMs * 2^attempt with a small jitter. */
  retryBaseMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryableError(e: unknown): boolean {
  if (e instanceof Error) {
    // Timeout from our own wrapper.
    if (/timeout after \d+ms/.test(e.message)) return true;
    // Node's fetch surfaces network errors as TypeError("fetch failed") with a cause.
    if (e.name === "TypeError") return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch + AbortSignal.timeout, normalising the AbortError that Node emits on timeout
 * into a recognisable "timeout after Xms" message so error classifiers (toToolError)
 * see a stable string and upstream callers can branch on it. Optional retry-with-
 * backoff for idempotent GETs.
 *
 * Backwards-compatible: the timeoutMs positional parameter is still accepted (third
 * arg) so existing callers keep working without changes.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutOrOpts: number | FetchOpts = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const opts: FetchOpts =
    typeof timeoutOrOpts === "number" ? { timeoutMs: timeoutOrOpts } : timeoutOrOpts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? 0;
  const retryBaseMs = opts.retryBaseMs ?? 100;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, { ...withDefaultUserAgent(init), signal: AbortSignal.timeout(timeoutMs) });
      // Don't retry success or non-retryable 4xx — return so the caller can decide.
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
      // Retryable status. Drain the body so the connection can be reused, then back off.
      try {
        await res.text();
      } catch {
        // ignore drain errors
      }
      lastErr = new Error(`http ${res.status} on ${typeof input === "string" ? input : (input as URL).toString?.() ?? "request"}`);
      if (attempt === retries) return res; // ran out of retries — surface the response as-is
    } catch (e) {
      // Normalize timeout error message before we decide whether to retry.
      if (e instanceof DOMException && e.name === "TimeoutError") {
        lastErr = new Error(`timeout after ${timeoutMs}ms`);
      } else {
        lastErr = e;
      }
      if (attempt === retries || !isRetryableError(lastErr)) throw lastErr;
    }
    // Exponential backoff with ±20% jitter. Cap at 2000ms so a 3-retry chain at 100ms
    // base never blocks the user more than ~800ms cumulative.
    const wait = Math.min(2000, retryBaseMs * 2 ** attempt) * (0.8 + Math.random() * 0.4);
    await sleep(wait);
  }
  // Unreachable — loop either returns or throws. But TS wants a terminal statement.
  throw lastErr;
}
