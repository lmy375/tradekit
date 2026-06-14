/**
 * Shared circuit-breaker tests (v62). The decision logic is pinned here in
 * isolation — both schedules.ts and rebalance.ts route through this, so the
 * trip condition (enabled AND streak ≥ threshold AND the pause actually
 * paused an active row) lives in one tested place.
 */

import { describe, it, expect, vi } from "vitest";
import { tripCircuitBreakerIfNeeded } from "./circuitBreaker.js";
import { configSchema } from "./config.js";

const config = configSchema.parse({});
const noopLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => noopLogger, recordAudit: () => {}, close: () => {},
} as unknown as import("./logger.js").Logger;

const base = {
  kind: "schedule" as const,
  id: 7,
  name: "dca",
  chain: "base",
  account: "default",
  lastCode: "TX_REVERTED",
  config,
  logger: noopLogger,
};

describe("tripCircuitBreakerIfNeeded", () => {
  it("does nothing when the breaker is disabled (pause never called)", async () => {
    const pause = vi.fn(() => 1);
    const tripped = await tripCircuitBreakerIfNeeded({
      ...base, failCount: 99, breaker: { enabled: false, maxConsecutiveFailures: 3 }, pause,
    });
    expect(tripped).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it("does nothing when undefined breaker config", async () => {
    const pause = vi.fn(() => 1);
    expect(await tripCircuitBreakerIfNeeded({ ...base, failCount: 99, breaker: undefined, pause })).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it("does nothing below the threshold", async () => {
    const pause = vi.fn(() => 1);
    const tripped = await tripCircuitBreakerIfNeeded({
      ...base, failCount: 2, breaker: { enabled: true, maxConsecutiveFailures: 3 }, pause,
    });
    expect(tripped).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it("trips at the threshold: pauses + returns true", async () => {
    const pause = vi.fn(() => 1);
    const tripped = await tripCircuitBreakerIfNeeded({
      ...base, failCount: 3, breaker: { enabled: true, maxConsecutiveFailures: 3 }, pause,
    });
    expect(tripped).toBe(true);
    expect(pause).toHaveBeenCalledWith(7);
  });

  it("trips above the threshold too", async () => {
    const pause = vi.fn(() => 1);
    expect(await tripCircuitBreakerIfNeeded({
      ...base, failCount: 10, breaker: { enabled: true, maxConsecutiveFailures: 3 }, pause,
    })).toBe(true);
  });

  it("returns false when the pause is a no-op (row already non-active — race)", async () => {
    const pause = vi.fn(() => 0); // dbPause returns 0/-1 when not active
    const tripped = await tripCircuitBreakerIfNeeded({
      ...base, failCount: 5, breaker: { enabled: true, maxConsecutiveFailures: 3 }, pause,
    });
    expect(tripped).toBe(false);
    expect(pause).toHaveBeenCalled(); // it tried, but the row wasn't active
  });

  it("works for the rebalance kind too", async () => {
    const pause = vi.fn(() => 1);
    expect(await tripCircuitBreakerIfNeeded({
      ...base, kind: "rebalance", failCount: 3, breaker: { enabled: true, maxConsecutiveFailures: 3 }, pause,
    })).toBe(true);
  });
});
