import { describe, it, expect } from "vitest";
import { compactMessage, parseDateFilter, dedupeFirstSeen, closestMatch } from "./format.js";
import { ToolError } from "./errors.js";

describe("compactMessage (iter197)", () => {
  it("returns empty string for null and undefined", () => {
    expect(compactMessage(null, 100)).toBe("");
    expect(compactMessage(undefined, 100)).toBe("");
  });

  it("passes short ASCII messages through unchanged", () => {
    expect(compactMessage("hello world", 100)).toBe("hello world");
  });

  it("collapses embedded newlines, tabs, and multi-spaces to single space", () => {
    expect(compactMessage("line1\nline2", 100)).toBe("line1 line2");
    expect(compactMessage("a\tb\tc", 100)).toBe("a b c");
    expect(compactMessage("a   b\n\n c", 100)).toBe("a b c");
  });

  it("trims leading/trailing whitespace", () => {
    expect(compactMessage("  hello  ", 100)).toBe("hello");
    expect(compactMessage("\n\nhello\n\n", 100)).toBe("hello");
  });

  it("truncates with '...' suffix when over max (total length stays ≤ max)", () => {
    const long = "abcdefghij".repeat(20); // 200 chars
    const out = compactMessage(long, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("...")).toBe(true);
  });

  it("doesn't add '...' when input fits exactly at max", () => {
    expect(compactMessage("abc", 3)).toBe("abc");
    expect(compactMessage("abcd", 4)).toBe("abcd");
  });

  it("respects very small max values without crashing", () => {
    // max=3 means slice(0,0)+"..." → just "..."
    expect(compactMessage("hello world", 3)).toBe("...");
    expect(compactMessage("hello world", 0)).toBe("...");
  });

  it("real-world: a multi-line zod issue list compacts cleanly", () => {
    const zod = "Config validation failed:\n  • activeChain: required\n  • safety.perTxUsdLimit: must be a number";
    const out = compactMessage(zod, 80);
    expect(out).toContain("Config validation failed:");
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThanOrEqual(80);
  });
});

describe("parseDateFilter (iter242)", () => {
  it("returns undefined for null/undefined inputs", () => {
    expect(parseDateFilter(undefined, "--since")).toBeUndefined();
    expect(parseDateFilter(null, "--since")).toBeUndefined();
  });

  it("expands date-only input to start-of-day UTC", () => {
    expect(parseDateFilter("2026-05-28", "--since")).toBe("2026-05-28T00:00:00Z");
  });

  it("passes through inputs that already contain a 'T'", () => {
    expect(parseDateFilter("2026-05-28T12:34:56Z", "--since")).toBe("2026-05-28T12:34:56Z");
  });

  it("throws INVALID_PARAMS on unparseable input, with the flag name in the message", () => {
    try {
      parseDateFilter("garbage", "--before");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("INVALID_PARAMS");
      expect((e as ToolError).message).toContain("--before");
      expect((e as ToolError).message).toContain("garbage");
    }
  });

  it("iter371: empty string surfaces a self-describing error (not 'Invalid --since:')", () => {
    // `--since ""` or `--since=` previously gave "Invalid --since:" with nothing after
    // the colon — operator couldn't tell whether their value was lost or rejected.
    // Now the message is explicit about the empty-value condition.
    try {
      parseDateFilter("", "--since");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).message).toMatch(/--since was passed but its value is empty/);
      expect((e as ToolError).message).toMatch(/Omit the flag entirely/);
    }
  });

  it("iter371: pure-whitespace input is treated as empty (not as garbage)", () => {
    try {
      parseDateFilter("   ", "--since");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).message).toMatch(/value is empty/);
    }
  });

  // Iter356: relative-date shortcuts so operators don't have to type ISO dates for
  // common cases (`tradekit audit --since today` etc).
  it("'today' expands to start of current day UTC", () => {
    const got = parseDateFilter("today", "--since")!;
    const now = new Date();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    expect(got).toBe(expected);
  });

  it("'yesterday' expands to start of yesterday UTC", () => {
    const got = parseDateFilter("yesterday", "--since")!;
    const now = new Date();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString();
    expect(got).toBe(expected);
  });

  it("is case-insensitive for word shortcuts", () => {
    expect(parseDateFilter("TODAY", "--since")).toBe(parseDateFilter("today", "--since"));
    expect(parseDateFilter("Yesterday", "--since")).toBe(parseDateFilter("yesterday", "--since"));
  });

  it("'24h' expands to now minus 24 hours (within a few ms)", () => {
    const got = parseDateFilter("24h", "--since")!;
    const diff = Date.now() - Date.parse(got);
    // Should be ~24h ± 1s of clock drift between the two Date.now() calls.
    expect(Math.abs(diff - 24 * 3600 * 1000)).toBeLessThan(1000);
  });

  it("'7d' expands to now minus 7 days", () => {
    const got = parseDateFilter("7d", "--since")!;
    const diff = Date.now() - Date.parse(got);
    expect(Math.abs(diff - 7 * 24 * 3600 * 1000)).toBeLessThan(1000);
  });

  it("rejects '0h' / '0d' (operator likely meant 'now' or a typo)", () => {
    expect(() => parseDateFilter("0h", "--since")).toThrow(ToolError);
    expect(() => parseDateFilter("0d", "--since")).toThrow(ToolError);
  });

  it("doesn't confuse '7d' (relative) with a literal '7d' that fails to parse", () => {
    // Regression guard: the relative-duration regex matches BEFORE the iso-parse
    // attempt, so '7d' doesn't fall through to Date.parse('7dT00:00:00Z').
    expect(() => parseDateFilter("7d", "--since")).not.toThrow();
  });
});

describe("dedupeFirstSeen (iter347 — shared between CLI parseChainsFlag and web /api/holdings)", () => {
  it("preserves first-seen order, drops later duplicates", () => {
    expect(dedupeFirstSeen(["base", "arbitrum", "base", "optimism", "arbitrum"]))
      .toEqual(["base", "arbitrum", "optimism"]);
  });

  it("returns an empty array for empty input (no crash)", () => {
    expect(dedupeFirstSeen([])).toEqual([]);
  });

  it("returns the same array shape when no duplicates exist", () => {
    expect(dedupeFirstSeen(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("works on non-string types via Set equality (numbers, objects-by-ref)", () => {
    expect(dedupeFirstSeen([1, 2, 1, 3, 2])).toEqual([1, 2, 3]);
  });
});

describe("closestMatch (iter343 — moved from cli/helpers.ts to format.ts)", () => {
  it("returns the closest match within edit distance 2", () => {
    expect(closestMatch("baes", ["base", "arbitrum", "optimism"])).toBe("base");
  });

  it("returns null when nothing is close enough (avoids misleading suggestions)", () => {
    expect(closestMatch("zzzzz", ["base", "arbitrum"])).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(closestMatch("", ["base"])).toBeNull();
  });

  it("returns null for empty candidates", () => {
    expect(closestMatch("base", [])).toBeNull();
  });

  it("is case-insensitive (uppercase input matches lowercase candidate)", () => {
    expect(closestMatch("BAES", ["base"])).toBe("base");
  });
});
