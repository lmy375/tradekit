// Tests for engineHealth.ts (iter33). Entirely pure — no DB, no I/O.

import { describe, it, expect } from "vitest";
import {
  emptyWorkerHealth,
  nextWorkerInterval,
  recordTickResult,
  summarizeTimings,
  DEFAULT_RESILIENCE,
  type ResilienceConfig,
  type WorkerHealthState,
} from "./engineHealth.js";

const NOW = new Date("2026-05-31T00:00:00Z");

function cfg(over: Partial<ResilienceConfig> = {}): ResilienceConfig {
  return { ...DEFAULT_RESILIENCE, ...over };
}

// ── nextWorkerInterval ──────────────────────────────────────

describe("nextWorkerInterval", () => {
  it("returns base interval when not in backoff", () => {
    const state = emptyWorkerHealth();
    expect(nextWorkerInterval({ baseIntervalMs: 30_000, state, config: cfg() })).toBe(30_000);
  });

  it("returns base interval when resilience disabled even if multiplier > 1", () => {
    const state: WorkerHealthState = { ...emptyWorkerHealth(), backoffMultiplier: 4 };
    const interval = nextWorkerInterval({ baseIntervalMs: 30_000, state, config: cfg({ enabled: false }) });
    expect(interval).toBe(30_000);
  });

  it("multiplies base by current multiplier", () => {
    const state: WorkerHealthState = { ...emptyWorkerHealth(), backoffMultiplier: 4 };
    const interval = nextWorkerInterval({ baseIntervalMs: 30_000, state, config: cfg() });
    expect(interval).toBe(120_000);
  });

  it("caps at maxBackoffMs", () => {
    const state: WorkerHealthState = { ...emptyWorkerHealth(), backoffMultiplier: 100 };
    const interval = nextWorkerInterval({
      baseIntervalMs: 30_000,
      state,
      config: cfg({ maxBackoffMs: 600_000 }),
    });
    expect(interval).toBe(600_000);
  });
});

// ── recordTickResult success paths ──────────────────────────

describe("recordTickResult — success", () => {
  it("increments ticks + successes; resets streak; no_change transition when not degraded", () => {
    const start = emptyWorkerHealth();
    const r = recordTickResult({
      state: start,
      ok: true,
      durationMs: 100,
      baseIntervalMs: 30_000,
      config: cfg(),
      now: NOW,
    });
    expect(r.state.ticks).toBe(1);
    expect(r.state.successes).toBe(1);
    expect(r.state.consecutiveFailures).toBe(0);
    expect(r.state.lastSuccessAt).toBe(NOW.toISOString());
    expect(r.transition.kind).toBe("no_change");
  });

  it("recovers from degraded state and emits recovered transition", () => {
    const degraded: WorkerHealthState = {
      ...emptyWorkerHealth(),
      consecutiveFailures: 5,
      backoffMultiplier: 4,
      degraded: true,
    };
    const r = recordTickResult({
      state: degraded,
      ok: true,
      durationMs: 50,
      baseIntervalMs: 30_000,
      config: cfg(),
      now: NOW,
    });
    expect(r.state.degraded).toBe(false);
    expect(r.state.backoffMultiplier).toBe(1);
    expect(r.state.consecutiveFailures).toBe(0);
    expect(r.transition.kind).toBe("recovered");
    if (r.transition.kind === "recovered") {
      expect(r.transition.afterFailures).toBe(5);
    }
  });
});

// ── recordTickResult failure paths ──────────────────────────

describe("recordTickResult — failure", () => {
  it("first failure: no transition; streak=1; no degraded yet", () => {
    const r = recordTickResult({
      state: emptyWorkerHealth(),
      ok: false,
      durationMs: 100,
      baseIntervalMs: 30_000,
      config: cfg({ thresholdFailures: 3 }),
      now: NOW,
    });
    expect(r.state.failures).toBe(1);
    expect(r.state.consecutiveFailures).toBe(1);
    expect(r.state.degraded).toBe(false);
    expect(r.transition.kind).toBe("no_change");
  });

  it("crossing threshold enters backoff", () => {
    let state = emptyWorkerHealth();
    for (let i = 0; i < 2; i++) {
      state = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: cfg({ thresholdFailures: 3 }), now: NOW }).state;
    }
    const r = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: cfg({ thresholdFailures: 3, backoffMultiplier: 2 }), now: NOW });
    expect(r.state.degraded).toBe(true);
    expect(r.state.backoffMultiplier).toBe(2);
    expect(r.transition.kind).toBe("entered_backoff");
    if (r.transition.kind === "entered_backoff") {
      expect(r.transition.consecutiveFailures).toBe(3);
      expect(r.transition.effectiveIntervalMs).toBe(60_000);
    }
  });

  it("further failures while degraded deepen the backoff", () => {
    // Get into backoff.
    let state = emptyWorkerHealth();
    const c = cfg({ thresholdFailures: 3, backoffMultiplier: 2, maxBackoffMs: 600_000 });
    for (let i = 0; i < 3; i++) {
      state = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW }).state;
    }
    expect(state.backoffMultiplier).toBe(2);
    // Next failure: should deepen to 4×.
    const r = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW });
    expect(r.state.backoffMultiplier).toBe(4);
    expect(r.transition.kind).toBe("backoff_deepened");
    if (r.transition.kind === "backoff_deepened") {
      expect(r.transition.effectiveIntervalMs).toBe(120_000);
    }
  });

  it("backoff multiplier respects maxBackoffMs cap", () => {
    // 30s base × multiplier 32 = 960s > 600s cap → effective should
    // stop growing once we hit the cap. The MULTIPLIER itself is
    // capped to maxBackoffMs / base = 20.
    let state = emptyWorkerHealth();
    const c = cfg({ thresholdFailures: 3, backoffMultiplier: 2, maxBackoffMs: 600_000 });
    // Get into deep backoff.
    for (let i = 0; i < 20; i++) {
      state = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW }).state;
    }
    expect(state.backoffMultiplier).toBeLessThanOrEqual(20);
    expect(nextWorkerInterval({ baseIntervalMs: 30_000, state, config: c })).toBeLessThanOrEqual(600_000);
  });

  it("backoff_deepened doesn't fire when multiplier doesn't grow (already at cap)", () => {
    const c = cfg({ thresholdFailures: 3, backoffMultiplier: 2, maxBackoffMs: 60_000 });
    // Saturate: base 30s × multiplier 2 = 60s, the cap. Next failure
    // shouldn't classify as "backoff_deepened" because multiplier
    // can't grow.
    let state = emptyWorkerHealth();
    for (let i = 0; i < 3; i++) {
      state = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW }).state;
    }
    expect(state.backoffMultiplier).toBe(2);
    const r = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW });
    expect(r.state.backoffMultiplier).toBe(2);
    expect(r.transition.kind).toBe("no_change");
  });

  it("disabled resilience never enters backoff regardless of streak", () => {
    let state = emptyWorkerHealth();
    const c = cfg({ enabled: false, thresholdFailures: 3 });
    for (let i = 0; i < 10; i++) {
      const r = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW });
      expect(r.transition.kind).toBe("no_change");
      state = r.state;
    }
    expect(state.degraded).toBe(false);
    expect(state.backoffMultiplier).toBe(1);
  });
});

// ── timing window ───────────────────────────────────────────

describe("recordTickResult — timing window", () => {
  it("records the latest duration first", () => {
    const r = recordTickResult({
      state: emptyWorkerHealth(),
      ok: true,
      durationMs: 250,
      baseIntervalMs: 30_000,
      config: cfg(),
      now: NOW,
    });
    expect(r.state.recentDurationsMs[0]).toBe(250);
  });

  it("caps the window to tickTimingWindow size", () => {
    let state = emptyWorkerHealth();
    const c = cfg({ tickTimingWindow: 5 });
    for (let i = 0; i < 10; i++) {
      state = recordTickResult({ state, ok: true, durationMs: i, baseIntervalMs: 30_000, config: c, now: NOW }).state;
    }
    expect(state.recentDurationsMs).toHaveLength(5);
    // Newest first: 9, 8, 7, 6, 5
    expect(state.recentDurationsMs).toEqual([9, 8, 7, 6, 5]);
  });
});

// ── summarizeTimings ────────────────────────────────────────

describe("summarizeTimings", () => {
  it("returns null when no samples", () => {
    expect(summarizeTimings([])).toBeNull();
  });

  it("computes avg, p50, p95, max", () => {
    const s = summarizeTimings([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(s).not.toBeNull();
    expect(s!.count).toBe(10);
    expect(s!.avgMs).toBe(55);
    expect(s!.p50Ms).toBe(60); // sorted[Math.floor(10*0.5)] = sorted[5] = 60
    expect(s!.p95Ms).toBe(100); // sorted[Math.floor(10*0.95)] = sorted[9] = 100
    expect(s!.maxMs).toBe(100);
  });

  it("handles single-sample case", () => {
    const s = summarizeTimings([42]);
    expect(s).toEqual({ count: 1, avgMs: 42, p50Ms: 42, p95Ms: 42, maxMs: 42 });
  });

  it("works on unsorted input (sorts internally)", () => {
    const s = summarizeTimings([100, 5, 50, 10, 25]);
    expect(s!.maxMs).toBe(100);
    expect(s!.avgMs).toBe((100 + 5 + 50 + 10 + 25) / 5);
  });
});

// ── end-to-end transitions ──────────────────────────────────

describe("recordTickResult — transition flow", () => {
  it("fails 3 → degraded → fails 2 more → recovers → no_change → fails 3 again → degraded again", () => {
    let state = emptyWorkerHealth();
    const c = cfg({ thresholdFailures: 3, backoffMultiplier: 2, maxBackoffMs: 600_000 });

    // 1-2: no transition (streak=1,2)
    state = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW }).state;
    state = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW }).state;
    expect(state.degraded).toBe(false);

    // 3rd: entered_backoff
    const r3 = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW });
    expect(r3.transition.kind).toBe("entered_backoff");
    state = r3.state;

    // 4-5: deeper backoff
    const r4 = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW });
    expect(r4.transition.kind).toBe("backoff_deepened");
    state = r4.state;

    // Success → recovered
    const r5 = recordTickResult({ state, ok: true, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW });
    expect(r5.transition.kind).toBe("recovered");
    state = r5.state;
    expect(state.degraded).toBe(false);
    expect(state.backoffMultiplier).toBe(1);

    // No change on subsequent success
    const r6 = recordTickResult({ state, ok: true, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW });
    expect(r6.transition.kind).toBe("no_change");

    // Failure storm again: should re-enter backoff after 3 fresh failures
    state = r6.state;
    state = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW }).state;
    state = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW }).state;
    const r9 = recordTickResult({ state, ok: false, durationMs: 100, baseIntervalMs: 30_000, config: c, now: NOW });
    expect(r9.transition.kind).toBe("entered_backoff");
  });
});
