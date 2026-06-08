// Iter746: tests for the computeStaleAccountSet pure helper in cli/wallet.ts.
// Other accountList behavior is integration-tested via the full CLI surface;
// this file focuses on the small pure helpers exported for unit-level pinning.

import { describe, it, expect } from "vitest";
import { computeStaleAccountSet } from "./wallet.js";

describe("computeStaleAccountSet (iter746)", () => {
  const NOW = new Date("2026-05-30T00:00:00Z").getTime();
  const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

  it("returns empty set for no bookmarks", () => {
    expect(computeStaleAccountSet([], NOW).size).toBe(0);
  });

  it("returns empty set when every bookmark is fresh (under default 48h threshold)", () => {
    const set = computeStaleAccountSet(
      [
        { account: "main", updatedAt: hoursAgo(2) },
        { account: "bot", updatedAt: hoursAgo(47) },
      ],
      NOW,
    );
    expect(set.size).toBe(0);
  });

  it("flags accounts with at least one stale bookmark", () => {
    const set = computeStaleAccountSet(
      [
        { account: "main", updatedAt: hoursAgo(2) }, // fresh
        { account: "swing", updatedAt: hoursAgo(120) }, // stale
      ],
      NOW,
    );
    expect(set.has("main")).toBe(false);
    expect(set.has("swing")).toBe(true);
  });

  it("ANY stale bookmark for an account puts it in the set (multi-chain accounts)", () => {
    const set = computeStaleAccountSet(
      [
        { account: "main", updatedAt: hoursAgo(2) },   // base — fresh
        { account: "main", updatedAt: hoursAgo(100) }, // arbitrum — stale
      ],
      NOW,
    );
    expect(set.has("main")).toBe(true);
  });

  it("respects a custom staleAfterHours override", () => {
    const set = computeStaleAccountSet(
      [{ account: "main", updatedAt: hoursAgo(36) }],
      NOW,
      24, // tighter threshold
    );
    expect(set.has("main")).toBe(true);
  });

  it("uses strict > threshold — a bookmark at exactly 48h is NOT stale", () => {
    const set = computeStaleAccountSet(
      [{ account: "main", updatedAt: hoursAgo(48) }],
      NOW,
    );
    expect(set.has("main")).toBe(false);
  });
});
