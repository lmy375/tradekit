// ──────────────────────────────────────────────────────────────────
// Engine health (iter33): per-worker resilience + tick-timing helpers.
//
// Three production gaps this module closes:
//
//   1. **No backoff on persistent failures.** Pre-iter33, a worker
//      whose underlying call (RPC, oracle) had been failing for an
//      hour kept retrying every intervalMs — wasted load + a
//      `worker.failed` notification storm. Now: consecutive
//      failures grow the effective interval exponentially up to a
//      configurable cap, with a deduped degraded → recovered
//      notification pair around the transitions.
//
//   2. **No tick-duration visibility.** Pre-iter33, `engine status`
//      told you tick counts but not "is the orders worker getting
//      slower?" A sliding window of the last N tick durations
//      gives operators p50 / p95 / max + the average — enough to
//      spot regressions ("orders p95 jumped from 200ms to 4s
//      after I added the 12th token to the safety whitelist").
//
//   3. **No structured degradation surface.** A worker that was
//      failing every tick used to manifest as "lots of warn-level
//      log lines" — invisible to dashboards. Health transitions
//      emit a structured notification (worker.degraded /
//      worker.recovered) once per transition.
//
// Design constraints:
//
//   * EVERYTHING in this module is pure. State is passed in and a
//     new state is returned. The supervisor owns the actual
//     state map + the notification dispatch.
//
//   * Timing window is bounded by `tickTimingWindow` (default 20)
//     so memory grows linearly with worker count, not tick count.
//
//   * Backoff multiplier and cap are independent: cap is in ms,
//     not multiplier-of-base. Lets operators express "back off
//     fast but never wait more than 10 min" without algebra.
//
//   * Transitions are CLASSIFIED in this module but emission is
//     done by the supervisor — keeps `engineHealth.ts` free of
//     I/O imports + lets tests assert on transition shapes
//     without mocking notify.
// ──────────────────────────────────────────────────────────────────

/** Pure per-worker mutable state. The supervisor owns a Map<name,
 *  WorkerHealthState> and feeds each into `recordTickResult` after
 *  the underlying tick returns. */
export interface WorkerHealthState {
  /** Lifetime tick count. */
  ticks: number;
  /** Lifetime successes (ok=true). */
  successes: number;
  /** Lifetime failures (ok=false). */
  failures: number;
  /** Streak count: bumped on each consecutive failure, reset to 0
   *  on success. */
  consecutiveFailures: number;
  /** Current backoff multiplier (1 = base interval; 2 = 2× base;
   *  etc.). Bumped per failure once we're already in backoff;
   *  resets to 1 on first success. */
  backoffMultiplier: number;
  /** Last N tick durations in ms. Bounded by the configured
   *  window. Newest entry first; older entries fall off the end. */
  recentDurationsMs: number[];
  /** True when consecutive failures crossed the threshold + the
   *  degraded notification was emitted. Cleared on the success
   *  that triggers the recovery notification. */
  degraded: boolean;
  /** ISO timestamp of the last successful tick (lifetime). Null
   *  until the first success. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the last failed tick. Null until the first
   *  failure. */
  lastFailureAt: string | null;
}

/** Construct a fresh state. Exported so the supervisor can pre-
 *  seed workers without an inline literal. */
export function emptyWorkerHealth(): WorkerHealthState {
  return {
    ticks: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    backoffMultiplier: 1,
    recentDurationsMs: [],
    degraded: false,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
}

/** Configuration shape consumed by these helpers. Mirrors the
 *  Zod schema in src/config.ts; duplicated here so the helpers
 *  stay decoupled from config-parsing imports + so tests can
 *  pass literal config objects. */
export interface ResilienceConfig {
  enabled: boolean;
  thresholdFailures: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  tickTimingWindow: number;
}

/** Transition classification emitted alongside the new state.
 *  The supervisor branches on this to dispatch notifications. */
export type WorkerHealthTransition =
  | { kind: "no_change" }
  | { kind: "entered_backoff"; consecutiveFailures: number; effectiveIntervalMs: number; reason: string }
  | { kind: "backoff_deepened"; consecutiveFailures: number; effectiveIntervalMs: number }
  | { kind: "recovered"; afterFailures: number; durationMs: number };

/**
 * Compute the effective tick interval for a worker, considering
 * the current backoff state. Pure function — no state mutation.
 *
 *  effectiveMs = baseIntervalMs × backoffMultiplier  (capped)
 *
 * When resilience.enabled is false OR the worker isn't in
 * backoff, returns baseIntervalMs verbatim. The cap is in
 * absolute milliseconds, not a multiplier — operators want to
 * express "never wait more than 10 min" not "never multiply
 * by more than 20".
 *
 * Exported for testing.
 */
export function nextWorkerInterval(args: {
  baseIntervalMs: number;
  state: WorkerHealthState;
  config: ResilienceConfig;
}): number {
  const { baseIntervalMs, state, config } = args;
  if (!config.enabled) return baseIntervalMs;
  if (state.backoffMultiplier <= 1) return baseIntervalMs;
  const proposed = baseIntervalMs * state.backoffMultiplier;
  return Math.min(proposed, config.maxBackoffMs);
}

/**
 * Apply a tick outcome to the state and classify the resulting
 * transition.
 *
 * - On success: reset consecutiveFailures + backoffMultiplier.
 *   If we WERE degraded, classify as "recovered" with the
 *   duration in backoff.
 * - On failure: bump consecutiveFailures. If we just crossed the
 *   threshold (consecutiveFailures === thresholdFailures), enter
 *   backoff (multiplier = backoffMultiplier; degraded = true)
 *   and classify as "entered_backoff". On further failures while
 *   already in backoff, deepen the multiplier (× backoffMultiplier
 *   each time, capped via nextWorkerInterval) and classify as
 *   "backoff_deepened".
 *
 * Returns a new state object (immutable) plus the transition.
 */
export function recordTickResult(args: {
  state: WorkerHealthState;
  ok: boolean;
  durationMs: number;
  baseIntervalMs: number;
  config: ResilienceConfig;
  now: Date;
}): { state: WorkerHealthState; transition: WorkerHealthTransition } {
  const { state, ok, durationMs, baseIntervalMs, config, now } = args;

  const newDurations = [durationMs, ...state.recentDurationsMs].slice(0, Math.max(1, config.tickTimingWindow));
  const baseNew: WorkerHealthState = {
    ...state,
    ticks: state.ticks + 1,
    recentDurationsMs: newDurations,
  };

  if (ok) {
    const wasDegraded = state.degraded;
    const beforeFailures = state.consecutiveFailures;
    const next: WorkerHealthState = {
      ...baseNew,
      successes: state.successes + 1,
      consecutiveFailures: 0,
      backoffMultiplier: 1,
      degraded: false,
      lastSuccessAt: now.toISOString(),
    };
    if (wasDegraded) {
      return {
        state: next,
        transition: {
          kind: "recovered",
          afterFailures: beforeFailures,
          durationMs,
        },
      };
    }
    return { state: next, transition: { kind: "no_change" } };
  }

  // failure path
  const consecutive = state.consecutiveFailures + 1;
  const isFirstThresholdHit = config.enabled && !state.degraded && consecutive >= config.thresholdFailures;

  let nextMultiplier = state.backoffMultiplier;
  let nextDegraded = state.degraded;
  let transition: WorkerHealthTransition = { kind: "no_change" };

  if (isFirstThresholdHit) {
    nextMultiplier = Math.max(1, config.backoffMultiplier);
    nextDegraded = true;
    const effectiveMs = Math.min(baseIntervalMs * nextMultiplier, config.maxBackoffMs);
    transition = {
      kind: "entered_backoff",
      consecutiveFailures: consecutive,
      effectiveIntervalMs: effectiveMs,
      reason: `${consecutive} consecutive failures crossed threshold ${config.thresholdFailures}`,
    };
  } else if (config.enabled && state.degraded) {
    // Already in backoff: deepen.
    const deepened = state.backoffMultiplier * config.backoffMultiplier;
    // Cap the multiplier so its product against base doesn't exceed
    // maxBackoffMs (otherwise it grows unbounded over time).
    const cappedMultiplier = Math.min(deepened, Math.max(1, config.maxBackoffMs / Math.max(1, baseIntervalMs)));
    if (cappedMultiplier > state.backoffMultiplier) {
      nextMultiplier = cappedMultiplier;
      transition = {
        kind: "backoff_deepened",
        consecutiveFailures: consecutive,
        effectiveIntervalMs: Math.min(baseIntervalMs * cappedMultiplier, config.maxBackoffMs),
      };
    }
  }

  const next: WorkerHealthState = {
    ...baseNew,
    failures: state.failures + 1,
    consecutiveFailures: consecutive,
    backoffMultiplier: nextMultiplier,
    degraded: nextDegraded,
    lastFailureAt: now.toISOString(),
  };
  return { state: next, transition };
}

/** Aggregated timing statistics over the sliding window. Returns
 *  null when the window is empty (no ticks recorded yet). Pure. */
export interface TickTimingSummary {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export function summarizeTimings(recentDurationsMs: readonly number[]): TickTimingSummary | null {
  if (recentDurationsMs.length === 0) return null;
  const sorted = [...recentDurationsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, x) => acc + x, 0);
  const idx = (p: number) => Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return {
    count: sorted.length,
    avgMs: sum / sorted.length,
    p50Ms: sorted[idx(0.5)],
    p95Ms: sorted[idx(0.95)],
    maxMs: sorted[sorted.length - 1],
  };
}

/** Default-resilience config used when the operator hasn't
 *  configured one. Aggressive enough to catch real degradations
 *  but loose enough that a one-off RPC blip doesn't trip the
 *  alarm. */
export const DEFAULT_RESILIENCE: ResilienceConfig = {
  enabled: true,
  thresholdFailures: 3,
  backoffMultiplier: 2,
  maxBackoffMs: 600_000, // 10 min
  tickTimingWindow: 20,
};
