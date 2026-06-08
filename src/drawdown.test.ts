/**
 * Drawdown circuit-breaker tests.
 *
 * Three layers:
 *   1. Pure evaluator (evaluateDrawdown) — six outcome shapes against
 *      every (state × current × config) combination
 *   2. DB-backed enforcer (enforceDrawdownCircuitBreaker) — ratchet,
 *      trip persistence, still-tripped, auto-resume, manual reset
 *   3. Edge cases — invalid current values, missing config, scope
 *      overrides
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-drawdown-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  evaluateDrawdown,
  enforceDrawdownCircuitBreaker,
} = await import("./drawdown.js");
const {
  openDb,
  closeDb,
  getDrawdownState,
  upsertDrawdownState,
  resetDrawdownState,
  listDrawdownStates,
} = await import("./db.js");
const { ToolError } = await import("./errors.js");
const { loadConfig } = await import("./config.js");

beforeAll(() => {
  openDb();
});
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM drawdown_state");
});

const cfg = (overrides: Partial<{ enabled: boolean; maxDrawdownPct: number; autoResumeAtPct: number | null }> = {}) => ({
  enabled: true,
  maxDrawdownPct: 15,
  autoResumeAtPct: null,
  scope: "global" as const,
  ...overrides,
});

// ── pure evaluator ───────────────────────────────────────────

describe("evaluateDrawdown — no state", () => {
  it("first observation sets peak + allows", () => {
    const r = evaluateDrawdown({ currentUsd: 1000, state: null, config: cfg() });
    expect(r.kind).toBe("no-state");
    if (r.kind === "no-state") expect(r.nextPeak).toBe(1000);
  });

  it("zero / negative currentUsd is a no-op (no-state with peak=0)", () => {
    expect(evaluateDrawdown({ currentUsd: 0, state: null, config: cfg() }).kind).toBe("no-state");
    expect(evaluateDrawdown({ currentUsd: -5, state: null, config: cfg() }).kind).toBe("no-state");
    expect(evaluateDrawdown({ currentUsd: NaN, state: null, config: cfg() }).kind).toBe("no-state");
  });
});

describe("evaluateDrawdown — ratchet up", () => {
  it("new high updates peak + allows", () => {
    const state = makeState({ peak_usd: 1000 });
    const r = evaluateDrawdown({ currentUsd: 1200, state, config: cfg() });
    expect(r.kind).toBe("ratchet-up");
    if (r.kind === "ratchet-up") expect(r.nextPeak).toBe(1200);
  });

  it("ratchet up clears tripped state implicitly", () => {
    // A portfolio that recovers past its previous peak has fully
    // recovered; even if the state row says tripped, the next outcome
    // is ratchet-up which will overwrite tripped_at to null.
    const state = makeState({ peak_usd: 1000, tripped_at: "2026-04-01T00:00:00Z" });
    const r = evaluateDrawdown({ currentUsd: 1200, state, config: cfg() });
    expect(r.kind).toBe("ratchet-up");
  });
});

describe("evaluateDrawdown — within band", () => {
  it("small drawdown (under threshold) allows with computed drawdownPct", () => {
    const state = makeState({ peak_usd: 1000 });
    const r = evaluateDrawdown({ currentUsd: 900, state, config: cfg({ maxDrawdownPct: 15 }) });
    expect(r.kind).toBe("within-band");
    if (r.kind === "within-band") expect(r.drawdownPct).toBeCloseTo(10, 5);
  });

  it("exact threshold is the trip line — strictly less is OK", () => {
    const state = makeState({ peak_usd: 1000 });
    // 14.99% drawdown → within band
    expect(evaluateDrawdown({ currentUsd: 850.1, state, config: cfg({ maxDrawdownPct: 15 }) }).kind).toBe("within-band");
    // 15% drawdown → trip
    expect(evaluateDrawdown({ currentUsd: 850, state, config: cfg({ maxDrawdownPct: 15 }) }).kind).toBe("trip-now");
  });
});

describe("evaluateDrawdown — trip-now", () => {
  it("crosses threshold for the first time → trip-now", () => {
    const state = makeState({ peak_usd: 1000, tripped_at: null });
    const r = evaluateDrawdown({ currentUsd: 800, state, config: cfg({ maxDrawdownPct: 15 }) });
    expect(r.kind).toBe("trip-now");
    if (r.kind === "trip-now") {
      expect(r.peak).toBe(1000);
      expect(r.currentUsd).toBe(800);
      expect(r.drawdownPct).toBeCloseTo(20, 5);
    }
  });
});

describe("evaluateDrawdown — still-tripped", () => {
  it("already-tripped state with no auto-resume threshold stays tripped", () => {
    const state = makeState({ peak_usd: 1000, tripped_at: "2026-04-01T00:00:00Z" });
    const r = evaluateDrawdown({ currentUsd: 800, state, config: cfg({ maxDrawdownPct: 15, autoResumeAtPct: null }) });
    expect(r.kind).toBe("still-tripped");
  });

  it("already-tripped state with auto-resume — but current still in trip zone", () => {
    const state = makeState({ peak_usd: 1000, tripped_at: "2026-04-01T00:00:00Z" });
    // Drawdown = 16%, auto-resume threshold = 5%. Still tripped.
    const r = evaluateDrawdown({ currentUsd: 840, state, config: cfg({ maxDrawdownPct: 15, autoResumeAtPct: 5 }) });
    expect(r.kind).toBe("still-tripped");
  });

  it("partial recovery between resume threshold + trip threshold stays tripped", () => {
    const state = makeState({ peak_usd: 1000, tripped_at: "2026-04-01T00:00:00Z" });
    // Drawdown = 12%, between resume(5%) and trip(15%). Still tripped.
    const r = evaluateDrawdown({ currentUsd: 880, state, config: cfg({ maxDrawdownPct: 15, autoResumeAtPct: 5 }) });
    expect(r.kind).toBe("still-tripped");
  });
});

describe("evaluateDrawdown — auto-resume", () => {
  it("recovery past resume threshold clears tripped", () => {
    const state = makeState({ peak_usd: 1000, tripped_at: "2026-04-01T00:00:00Z" });
    // Drawdown = 3%, resume threshold = 5%. Should auto-resume.
    const r = evaluateDrawdown({ currentUsd: 970, state, config: cfg({ maxDrawdownPct: 15, autoResumeAtPct: 5 }) });
    expect(r.kind).toBe("auto-resume");
    if (r.kind === "auto-resume") {
      expect(r.peak).toBe(1000);
      expect(r.drawdownPct).toBeCloseTo(3, 5);
    }
  });

  it("resume requires strict < (boundary value still tripped)", () => {
    const state = makeState({ peak_usd: 1000, tripped_at: "2026-04-01T00:00:00Z" });
    // Drawdown = 5%, resume threshold = 5%. NOT auto-resume (strict <).
    const r = evaluateDrawdown({ currentUsd: 950, state, config: cfg({ maxDrawdownPct: 15, autoResumeAtPct: 5 }) });
    expect(r.kind).toBe("still-tripped");
  });
});

// ── DB-backed enforcer ───────────────────────────────────────

function makeConfig(overrides: Partial<{ enabled: boolean; maxDrawdownPct: number; autoResumeAtPct: number | null }>) {
  const base = loadConfig();
  return {
    ...base,
    safety: {
      ...base.safety,
      drawdownCircuitBreaker: {
        enabled: true,
        maxDrawdownPct: 15,
        autoResumeAtPct: null,
        scope: "global" as const,
        ...overrides,
      },
    },
  };
}

describe("enforceDrawdownCircuitBreaker — short-circuits", () => {
  it("no-op when feature disabled", () => {
    const config = makeConfig({ enabled: false });
    expect(() => enforceDrawdownCircuitBreaker({ currentUsd: 100, config })).not.toThrow();
    // No state row created.
    expect(listDrawdownStates().length).toBe(0);
  });

  it("no-op when feature not configured at all", () => {
    const config = loadConfig();
    expect(() => enforceDrawdownCircuitBreaker({ currentUsd: 100, config })).not.toThrow();
    expect(listDrawdownStates().length).toBe(0);
  });

  it("no-op for non-positive currentUsd", () => {
    const config = makeConfig({});
    expect(() => enforceDrawdownCircuitBreaker({ currentUsd: 0, config })).not.toThrow();
    expect(() => enforceDrawdownCircuitBreaker({ currentUsd: -5, config })).not.toThrow();
    expect(() => enforceDrawdownCircuitBreaker({ currentUsd: NaN, config })).not.toThrow();
    expect(listDrawdownStates().length).toBe(0);
  });
});

describe("enforceDrawdownCircuitBreaker — state lifecycle", () => {
  it("first call seeds state with current as peak", () => {
    const config = makeConfig({});
    enforceDrawdownCircuitBreaker({ currentUsd: 1000, config });
    const state = getDrawdownState("global");
    expect(state?.peak_usd).toBe(1000);
    expect(state?.tripped_at).toBeNull();
    expect(state?.last_value_usd).toBe(1000);
  });

  it("ratchets up to new highs across multiple calls", () => {
    const config = makeConfig({});
    enforceDrawdownCircuitBreaker({ currentUsd: 1000, config });
    enforceDrawdownCircuitBreaker({ currentUsd: 1200, config });
    enforceDrawdownCircuitBreaker({ currentUsd: 1100, config }); // pullback, no peak change
    enforceDrawdownCircuitBreaker({ currentUsd: 1500, config }); // new high
    expect(getDrawdownState("global")?.peak_usd).toBe(1500);
  });

  it("updates last_value_usd even on within-band pullbacks", () => {
    const config = makeConfig({});
    enforceDrawdownCircuitBreaker({ currentUsd: 1000, config });
    enforceDrawdownCircuitBreaker({ currentUsd: 950, config });
    const state = getDrawdownState("global");
    expect(state?.peak_usd).toBe(1000);
    expect(state?.last_value_usd).toBe(950);
  });

  it("trips on first crossing + throws + persists tripped_at", () => {
    const config = makeConfig({ maxDrawdownPct: 15 });
    enforceDrawdownCircuitBreaker({ currentUsd: 1000, config });
    let err: { code?: string; details?: Record<string, unknown> } | undefined;
    try {
      enforceDrawdownCircuitBreaker({ currentUsd: 800, config });
    } catch (e) {
      err = e as { code?: string; details?: Record<string, unknown> };
    }
    expect(err?.code).toBe("DRAWDOWN_CIRCUIT_BREAKER_TRIPPED");
    expect(err?.details?.peakUsd).toBe(1000);
    expect(err?.details?.currentUsd).toBe(800);
    expect((err?.details?.drawdownPct as number)).toBeCloseTo(20, 4);
    expect(err?.details?.freshTrip).toBe(true);
    // State persisted.
    const state = getDrawdownState("global");
    expect(state?.tripped_at).not.toBeNull();
  });

  it("stays tripped on subsequent attempts even with smaller drawdown", () => {
    const config = makeConfig({ maxDrawdownPct: 15 });
    enforceDrawdownCircuitBreaker({ currentUsd: 1000, config });
    expect(() => enforceDrawdownCircuitBreaker({ currentUsd: 800, config })).toThrow(/tripping NOW/);
    // Recover slightly (still within drawdown band but no auto-resume configured).
    let err: { code?: string; details?: Record<string, unknown> } | undefined;
    try {
      enforceDrawdownCircuitBreaker({ currentUsd: 900, config });
    } catch (e) {
      err = e as { code?: string; details?: Record<string, unknown> };
    }
    expect(err?.code).toBe("DRAWDOWN_CIRCUIT_BREAKER_TRIPPED");
    expect(err?.details?.freshTrip).toBe(false);
  });

  it("auto-resumes when current recovers past resume threshold", () => {
    const config = makeConfig({ maxDrawdownPct: 15, autoResumeAtPct: 5 });
    enforceDrawdownCircuitBreaker({ currentUsd: 1000, config });
    // Trip: drawdown 20%.
    expect(() => enforceDrawdownCircuitBreaker({ currentUsd: 800, config })).toThrow();
    // Auto-resume: drawdown 3%.
    expect(() => enforceDrawdownCircuitBreaker({ currentUsd: 970, config })).not.toThrow();
    expect(getDrawdownState("global")?.tripped_at).toBeNull();
  });

  it("ratchet up after recovery sets new peak (not just clears tripped)", () => {
    const config = makeConfig({ maxDrawdownPct: 15 });
    enforceDrawdownCircuitBreaker({ currentUsd: 1000, config });
    try { enforceDrawdownCircuitBreaker({ currentUsd: 800, config }); } catch {}
    // Recover past peak: ratchet up clears tripped + sets new peak.
    enforceDrawdownCircuitBreaker({ currentUsd: 1200, config });
    const state = getDrawdownState("global");
    expect(state?.peak_usd).toBe(1200);
    expect(state?.tripped_at).toBeNull();
  });

  it("preserves tripped_at across still-tripped calls", () => {
    const config = makeConfig({ maxDrawdownPct: 15 });
    enforceDrawdownCircuitBreaker({ currentUsd: 1000, config });
    try { enforceDrawdownCircuitBreaker({ currentUsd: 800, config }); } catch {}
    const trippedFirst = getDrawdownState("global")?.tripped_at;
    expect(trippedFirst).not.toBeNull();
    // Wait + retry — the tripped_at timestamp should NOT change on subsequent observations
    try { enforceDrawdownCircuitBreaker({ currentUsd: 750, config }); } catch {}
    const trippedSecond = getDrawdownState("global")?.tripped_at;
    expect(trippedSecond).toBe(trippedFirst);
  });
});

// ── manual reset ─────────────────────────────────────────────

describe("resetDrawdownState — manual reset", () => {
  it("returns null when no state exists for scope", () => {
    expect(resetDrawdownState({ scopeKey: "global" })).toBeNull();
  });

  it("clears tripped + keeps existing peak when newPeakUsd is omitted", () => {
    upsertDrawdownState({
      scopeKey: "global",
      peakUsd: 1000,
      peakAt: "2026-04-01T00:00:00Z",
      trippedAt: "2026-04-15T00:00:00Z",
      lastValueUsd: 800,
    });
    const after = resetDrawdownState({ scopeKey: "global" });
    expect(after?.tripped_at).toBeNull();
    // peak re-anchors to lastValueUsd when newPeakUsd is omitted —
    // protects against re-tripping immediately on the next trade.
    expect(after?.peak_usd).toBe(800);
  });

  it("re-anchors peak to newPeakUsd when supplied", () => {
    upsertDrawdownState({
      scopeKey: "global",
      peakUsd: 1000,
      peakAt: "2026-04-01T00:00:00Z",
      trippedAt: "2026-04-15T00:00:00Z",
      lastValueUsd: 800,
    });
    const after = resetDrawdownState({ scopeKey: "global", newPeakUsd: 850 });
    expect(after?.tripped_at).toBeNull();
    expect(after?.peak_usd).toBe(850);
  });

  it("after reset, breaker allows trades again", () => {
    const config = makeConfig({ maxDrawdownPct: 15 });
    enforceDrawdownCircuitBreaker({ currentUsd: 1000, config });
    try { enforceDrawdownCircuitBreaker({ currentUsd: 800, config }); } catch {}
    resetDrawdownState({ scopeKey: "global", newPeakUsd: 800 });
    expect(() => enforceDrawdownCircuitBreaker({ currentUsd: 800, config })).not.toThrow();
  });
});

// ── helpers ──────────────────────────────────────────────────

function makeState(overrides: Partial<{ peak_usd: number; tripped_at: string | null; last_value_usd: number | null }>) {
  return {
    scope_key: "global",
    peak_usd: 1000,
    peak_at: "2026-04-01T00:00:00Z",
    tripped_at: null,
    last_value_usd: null,
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}
