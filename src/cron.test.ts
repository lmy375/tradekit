// Tests for the cron parser + nextRun calculator (cron.ts). Two layers:
//   1) Parser tests — accept valid syntax, reject malformed, normalize
//      DOW 7 → 0, expand macros.
//   2) nextRun tests — deterministic UTC walks from a frozen "now", with
//      POSIX dom/dow OR-semantics and leap-year correctness.
//
// All times in tests are ISO-8601 UTC strings so the assertions are
// timezone-agnostic and identical for CI / developer laptops.

import { describe, it, expect } from "vitest";
import { parseCron, nextRun, matchesAt, durationToCron } from "./cron.js";

// ── parser ───────────────────────────────────────────────────

describe("parseCron — fields & values", () => {
  it("accepts the all-wildcards expression", () => {
    const p = parseCron("* * * * *");
    expect(p.minute.size).toBe(60);
    expect(p.hour.size).toBe(24);
    expect(p.dayOfMonth.size).toBe(31);
    expect(p.month.size).toBe(12);
    expect(p.dayOfWeek.size).toBe(7); // 0-6 after normalization
    expect(p.domRestricted).toBe(false);
    expect(p.dowRestricted).toBe(false);
  });
  it("parses single values", () => {
    const p = parseCron("5 10 1 6 3");
    expect([...p.minute]).toEqual([5]);
    expect([...p.hour]).toEqual([10]);
    expect([...p.dayOfMonth]).toEqual([1]);
    expect([...p.month]).toEqual([6]);
    expect([...p.dayOfWeek]).toEqual([3]);
    expect(p.domRestricted).toBe(true);
    expect(p.dowRestricted).toBe(true);
  });
  it("parses comma lists", () => {
    const p = parseCron("0,15,30,45 * * * *");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });
  it("parses ranges", () => {
    const p = parseCron("0 9-17 * * *");
    expect([...p.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });
  it("parses steps on wildcard", () => {
    const p = parseCron("*/15 * * * *");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });
  it("parses steps on range", () => {
    const p = parseCron("0 0-23/6 * * *");
    expect([...p.hour].sort((a, b) => a - b)).toEqual([0, 6, 12, 18]);
  });
  it("parses Linux-style 'N/step' as 'N-max step'", () => {
    const p = parseCron("0 5/4 * * *");
    expect([...p.hour].sort((a, b) => a - b)).toEqual([5, 9, 13, 17, 21]);
  });
  it("normalizes day-of-week 7 → 0 (Sunday)", () => {
    const p = parseCron("0 0 * * 7");
    expect([...p.dayOfWeek]).toEqual([0]);
  });
});

describe("parseCron — macros", () => {
  it("@hourly", () => {
    const p = parseCron("@hourly");
    expect([...p.minute]).toEqual([0]);
    expect(p.hour.size).toBe(24);
  });
  it("@daily / @midnight equivalent", () => {
    const p1 = parseCron("@daily");
    const p2 = parseCron("@midnight");
    expect([...p1.minute]).toEqual([0]);
    expect([...p1.hour]).toEqual([0]);
    expect([...p2.minute]).toEqual([0]);
    expect([...p2.hour]).toEqual([0]);
  });
  it("@weekly → Sunday midnight UTC", () => {
    const p = parseCron("@weekly");
    expect([...p.dayOfWeek]).toEqual([0]);
    expect([...p.hour]).toEqual([0]);
  });
  it("@monthly → 1st of month midnight UTC", () => {
    const p = parseCron("@monthly");
    expect([...p.dayOfMonth]).toEqual([1]);
    expect([...p.hour]).toEqual([0]);
  });
  it("@yearly / @annually equivalent", () => {
    const p1 = parseCron("@yearly");
    const p2 = parseCron("@annually");
    expect([...p1.month]).toEqual([1]);
    expect([...p1.dayOfMonth]).toEqual([1]);
    expect([...p2.month]).toEqual([1]);
    expect([...p2.dayOfMonth]).toEqual([1]);
  });
});

describe("parseCron — error paths", () => {
  it("rejects empty / whitespace input", () => {
    expect(() => parseCron("")).toThrow(/empty/);
    expect(() => parseCron("   ")).toThrow(/empty/);
  });
  it("rejects wrong field count", () => {
    expect(() => parseCron("0 0")).toThrow(/5 fields/);
    expect(() => parseCron("0 0 0 0 0 0")).toThrow(/5 fields/);
  });
  it("rejects out-of-range numbers", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("0 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("0 0 0 * *")).toThrow(/out of range/);
    expect(() => parseCron("0 0 32 * *")).toThrow(/out of range/);
    expect(() => parseCron("0 0 * 13 *")).toThrow(/out of range/);
    expect(() => parseCron("0 0 * * 8")).toThrow(/out of range/);
  });
  it("rejects backwards ranges", () => {
    expect(() => parseCron("10-5 * * * *")).toThrow(/range start/);
  });
  it("rejects garbage values", () => {
    expect(() => parseCron("abc * * * *")).toThrow();
    expect(() => parseCron("* / * * *")).toThrow();
    expect(() => parseCron("*/0 * * * *")).toThrow(/step.*> 0/);
  });
});

// ── nextRun ──────────────────────────────────────────────────

describe("nextRun — basic", () => {
  it("fires the next minute when expression is wildcard", () => {
    const p = parseCron("* * * * *");
    const from = new Date("2026-05-30T10:00:30Z");
    expect(nextRun(p, from).toISOString()).toBe("2026-05-30T10:01:00.000Z");
  });
  it("strictly-after semantic: same-minute call yields the FOLLOWING minute", () => {
    const p = parseCron("* * * * *");
    const from = new Date("2026-05-30T10:00:00.000Z");
    expect(nextRun(p, from).toISOString()).toBe("2026-05-30T10:01:00.000Z");
  });
  it("hourly: aligned to top of hour", () => {
    const p = parseCron("@hourly");
    const from = new Date("2026-05-30T10:30:00Z");
    expect(nextRun(p, from).toISOString()).toBe("2026-05-30T11:00:00.000Z");
  });
  it("daily at 10:00 UTC", () => {
    const p = parseCron("0 10 * * *");
    const from = new Date("2026-05-30T15:00:00Z");
    expect(nextRun(p, from).toISOString()).toBe("2026-05-31T10:00:00.000Z");
  });
  it("every 15 minutes", () => {
    const p = parseCron("*/15 * * * *");
    const from = new Date("2026-05-30T10:07:00Z");
    expect(nextRun(p, from).toISOString()).toBe("2026-05-30T10:15:00.000Z");
  });
});

describe("nextRun — POSIX dom/dow OR semantics", () => {
  it("both restricted: matches EITHER (1st of month OR Monday)", () => {
    const p = parseCron("0 10 1 * 1");
    // 2026-05-04 is a Monday — but not the 1st. Should match.
    const fromMonday = new Date("2026-05-04T09:00:00Z");
    expect(nextRun(p, fromMonday).toISOString()).toBe("2026-05-04T10:00:00.000Z");
    // 2026-06-01 is the 1st of June (a Monday actually — but the OR matches regardless).
    const fromMay31 = new Date("2026-05-31T10:00:00Z");
    expect(nextRun(p, fromMay31).toISOString()).toBe("2026-06-01T10:00:00.000Z");
  });
  it("only dom restricted: dom-only gating (no OR)", () => {
    const p = parseCron("0 10 15 * *");
    // 2026-05-15 is a Friday — the dow doesn't constrain.
    const from = new Date("2026-05-14T10:00:00Z");
    expect(nextRun(p, from).toISOString()).toBe("2026-05-15T10:00:00.000Z");
  });
  it("only dow restricted: dow-only gating (no OR)", () => {
    const p = parseCron("0 10 * * 5"); // every Friday 10am UTC
    const from = new Date("2026-05-25T10:00:00Z"); // Monday
    expect(nextRun(p, from).toISOString()).toBe("2026-05-29T10:00:00.000Z");
  });
});

describe("nextRun — month boundaries + leap year", () => {
  it("rolls over end of month correctly", () => {
    const p = parseCron("0 0 1 * *");
    const from = new Date("2026-05-15T00:00:00Z");
    expect(nextRun(p, from).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
  it("rolls over end of year correctly", () => {
    const p = parseCron("0 0 1 1 *"); // Jan 1 midnight UTC
    const from = new Date("2026-12-15T00:00:00Z");
    expect(nextRun(p, from).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  it("Feb 29 fires in leap years only — 2028 case", () => {
    const p = parseCron("0 0 29 2 *");
    // 2026 + 2027 are non-leap (skip). 2028 IS a leap year.
    const from = new Date("2026-03-01T00:00:00Z");
    expect(nextRun(p, from).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
  it("Feb 30 (impossible) throws within safety horizon", () => {
    const p = parseCron("0 0 30 2 *");
    expect(() => nextRun(p, new Date("2026-01-01T00:00:00Z"))).toThrow(/no firing/);
  });
});

describe("nextRun — every-N steps", () => {
  it("every 5 minutes from a non-aligned start", () => {
    const p = parseCron("*/5 * * * *");
    const from = new Date("2026-05-30T10:07:33Z");
    expect(nextRun(p, from).toISOString()).toBe("2026-05-30T10:10:00.000Z");
  });
  it("every 4 hours, midnight onward", () => {
    const p = parseCron("0 */4 * * *");
    const from = new Date("2026-05-30T05:00:00Z");
    expect(nextRun(p, from).toISOString()).toBe("2026-05-30T08:00:00.000Z");
  });
});

describe("matchesAt", () => {
  it("returns true on exact match", () => {
    expect(matchesAt(parseCron("0 10 * * *"), new Date("2026-05-30T10:00:00Z"))).toBe(true);
  });
  it("returns false on minute mismatch", () => {
    expect(matchesAt(parseCron("0 10 * * *"), new Date("2026-05-30T10:01:00Z"))).toBe(false);
  });
});

// ── duration shorthand ───────────────────────────────────────

describe("durationToCron", () => {
  it("compiles minute durations to */N", () => {
    expect(durationToCron("15m")).toBe("*/15 * * * *");
    expect(durationToCron("30m")).toBe("*/30 * * * *");
    expect(durationToCron("60m")).toBe("0 * * * *");
  });
  it("compiles hour durations", () => {
    expect(durationToCron("1h")).toBe("0 * * * *");
    expect(durationToCron("2h")).toBe("0 */2 * * *");
    expect(durationToCron("6h")).toBe("0 */6 * * *");
    expect(durationToCron("24h")).toBe("0 0 * * *");
  });
  it("compiles day durations with weekly alias for 7d", () => {
    expect(durationToCron("1d")).toBe("0 0 * * *");
    expect(durationToCron("7d")).toBe("0 0 * * 0"); // weekly Sunday — exact 7-day cadence
    expect(durationToCron("3d")).toBe("0 0 */3 * *");
  });
  it("rejects sub-minute durations", () => {
    expect(() => durationToCron("30s")).toThrow(/sub-minute/);
  });
  it("rejects non-evenly-dividing durations", () => {
    expect(() => durationToCron("75m")).toThrow(/evenly divide/);
    expect(() => durationToCron("5h")).toThrow(/evenly divide/);
  });
  it("rejects malformed input", () => {
    expect(() => durationToCron("garbage")).toThrow();
    expect(() => durationToCron("")).toThrow();
    expect(() => durationToCron("-1h")).toThrow();
  });
  it("compiled cron expressions round-trip through parseCron", () => {
    for (const dur of ["15m", "1h", "2h", "6h", "24h", "1d", "3d", "7d"]) {
      // Just confirm parseCron accepts the output — no semantic check beyond
      // that. nextRun tests above cover the semantic of the standard forms.
      expect(() => parseCron(durationToCron(dur))).not.toThrow();
    }
  });
});
