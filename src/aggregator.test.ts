// Tests for resolveAggregatorOrder — the pure helper that decides which DEX aggregators
// to try, in what order. Used by aggregateQuote's main loop AND by the simulation-revert
// retry loop in trade.ts. A bug here can silently drop a user-preferred aggregator or
// produce an infinite retry where an "excluded" provider isn't actually excluded.

import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { resolveAggregatorOrder, pickBestQuote, type ProviderName, type AggregatorQuote } from "./aggregator.js";

describe("resolveAggregatorOrder", () => {
  it("with no preferred, returns the default order (kyberswap → openocean → 0x → 1inch)", () => {
    expect(resolveAggregatorOrder([])).toEqual(["kyberswap", "openocean", "0x", "1inch"]);
  });

  it("preferred providers come first, then the default order with duplicates removed", () => {
    // User puts 0x at the front. Should be: 0x, then the default order with 0x removed.
    expect(resolveAggregatorOrder(["0x"])).toEqual(["0x", "kyberswap", "openocean", "1inch"]);
  });

  it("multiple preferred providers keep their relative order", () => {
    expect(resolveAggregatorOrder(["1inch", "0x"])).toEqual([
      "1inch",
      "0x",
      "kyberswap",
      "openocean",
    ]);
  });

  it("duplicate preferred entries are deduplicated", () => {
    // A misconfigured `preferred: ["openocean", "openocean"]` shouldn't double up.
    expect(resolveAggregatorOrder(["openocean", "openocean"] as ProviderName[])).toEqual([
      "openocean",
      "kyberswap",
      "0x",
      "1inch",
    ]);
  });

  it("exclude drops providers from the result entirely (no infinite-retry hole)", () => {
    const order = resolveAggregatorOrder([], ["kyberswap"]);
    expect(order).not.toContain("kyberswap");
    expect(order).toEqual(["openocean", "0x", "1inch"]);
  });

  it("exclude works even when the excluded item is in preferred", () => {
    // The retry loop adds the just-tried provider to `exclude`. If we honor preferred
    // blindly, the retry would re-pick that same provider — defeating the retry's purpose.
    const order = resolveAggregatorOrder(["kyberswap", "openocean"], ["kyberswap"]);
    expect(order).not.toContain("kyberswap");
    expect(order[0]).toBe("openocean");
  });

  it("exclude removes the provider even when it appears in BOTH preferred and default", () => {
    // openocean is in both preferred AND the default. Excluding it must remove from both.
    const order = resolveAggregatorOrder(["openocean"], ["openocean"]);
    expect(order).not.toContain("openocean");
    expect(order).toEqual(["kyberswap", "0x", "1inch"]);
  });

  it("excluding every provider yields an empty array (caller raises AGGREGATOR_FAILED)", () => {
    expect(
      resolveAggregatorOrder([], ["kyberswap", "openocean", "0x", "1inch"]),
    ).toEqual([]);
  });

  it("does not mutate the input arrays", () => {
    const preferred: ProviderName[] = ["0x"];
    const exclude: ProviderName[] = ["1inch"];
    resolveAggregatorOrder(preferred, exclude);
    expect(preferred).toEqual(["0x"]);
    expect(exclude).toEqual(["1inch"]);
  });
});

// Iter602: pure-logic tests for the parallel best-of-N picker. The HTTP-touching
// aggregateQuote / aggregateQuoteBest functions are covered by smoke tests (live
// aggregator APIs); these unit tests pin the winner-selection + alternatives + bps
// math contract so a regression in the math gets caught fast.
describe("pickBestQuote (iter602)", () => {
  const stubQuote = (provider: ProviderName, amountOut: bigint): { provider: ProviderName; quote: AggregatorQuote } => ({
    provider,
    quote: {
      provider,
      tokenIn: "0x1111111111111111111111111111111111111111" as Address,
      tokenOut: "0x2222222222222222222222222222222222222222" as Address,
      amountIn: 1_000_000n,
      amountOut,
      amountOutMinimum: amountOut * 99n / 100n,
      allowanceTarget: "0x3333333333333333333333333333333333333333" as Address,
      to: "0x4444444444444444444444444444444444444444" as Address,
      data: "0xdead" as `0x${string}`,
      value: 0n,
    },
  });

  it("returns null when there are zero successful quotes", () => {
    const result = pickBestQuote([], [{ provider: "kyberswap", message: "boom" }], ["kyberswap"]);
    expect(result).toBeNull();
  });

  it("with a single success returns the winner with no alternatives", () => {
    const successes = [stubQuote("kyberswap", 1_000_000n)];
    const result = pickBestQuote(successes, [], ["kyberswap"]);
    expect(result).not.toBeNull();
    expect(result?.winner.provider).toBe("kyberswap");
    expect(result?.winner.amountOut).toBe(1_000_000n);
    expect(result?.winner.alternatives).toEqual([]);
    expect(result?.loserSummary).toBe("");
  });

  it("picks the highest amountOut across competing successes", () => {
    // openocean has a strictly better quote → it should win regardless of order.
    const successes = [
      stubQuote("kyberswap", 1_000_000n),
      stubQuote("openocean", 1_100_000n),
    ];
    const result = pickBestQuote(successes, [], ["kyberswap", "openocean"]);
    expect(result?.winner.provider).toBe("openocean");
    expect(result?.winner.amountOut).toBe(1_100_000n);
    // kyberswap appears as the only alternative.
    expect(result?.winner.alternatives).toEqual([
      { provider: "kyberswap", status: "ok", amountOut: 1_000_000n, bpsBehindWinner: expect.any(Number) },
    ]);
  });

  it("computes bpsBehindWinner correctly (100 bps = 1%)", () => {
    // openocean wins with 1_000_000; kyberswap is at 990_000 → exactly 100 bps behind.
    const successes = [
      stubQuote("openocean", 1_000_000n),
      stubQuote("kyberswap", 990_000n),
    ];
    const result = pickBestQuote(successes, [], ["openocean", "kyberswap"]);
    expect(result?.winner.alternatives?.[0]).toMatchObject({
      provider: "kyberswap",
      status: "ok",
      bpsBehindWinner: 100,
    });
  });

  it("on a tie (identical amountOut), tie-breaks by eligibleOrder position", () => {
    // Both providers return 1_000_000n. Eligible order is [kyberswap, openocean],
    // so kyberswap should win the tie.
    const successes = [
      stubQuote("openocean", 1_000_000n),
      stubQuote("kyberswap", 1_000_000n),
    ];
    const result = pickBestQuote(successes, [], ["kyberswap", "openocean"]);
    expect(result?.winner.provider).toBe("kyberswap");
    // openocean is the alternative, with 0 bps behind (same amount).
    expect(result?.winner.alternatives?.[0]).toMatchObject({
      provider: "openocean",
      status: "ok",
      bpsBehindWinner: 0,
    });
  });

  it("on a tie with REVERSED eligibleOrder, tie-breaks the other way", () => {
    // Same successes, opposite eligible order → openocean wins now. Pins that
    // tie-break is governed by eligibleOrder, not insertion order of `successes`.
    const successes = [
      stubQuote("openocean", 1_000_000n),
      stubQuote("kyberswap", 1_000_000n),
    ];
    const result = pickBestQuote(successes, [], ["openocean", "kyberswap"]);
    expect(result?.winner.provider).toBe("openocean");
  });

  it("losers are sorted by descending amountOut and errors come last", () => {
    // Three successes (winner + two losers) and one failure. Alternatives should
    // be [secondBest, thirdBest, errorProvider] in that order.
    const successes = [
      stubQuote("kyberswap", 950_000n),       // worst success
      stubQuote("openocean", 1_000_000n),     // winner
      stubQuote("0x", 980_000n),              // second-best
    ];
    const failures = [{ provider: "1inch" as ProviderName, message: "timeout" }];
    const result = pickBestQuote(successes, failures, ["kyberswap", "openocean", "0x", "1inch"]);
    expect(result?.winner.provider).toBe("openocean");
    const alts = result?.winner.alternatives ?? [];
    expect(alts).toHaveLength(3);
    expect(alts[0]).toMatchObject({ provider: "0x", status: "ok" });
    expect(alts[1]).toMatchObject({ provider: "kyberswap", status: "ok" });
    expect(alts[2]).toMatchObject({ provider: "1inch", status: "error", message: "timeout" });
  });

  it("loserSummary names every alternative with bps or ERR marker", () => {
    const successes = [
      stubQuote("openocean", 1_000_000n),
      stubQuote("kyberswap", 990_000n),
    ];
    const failures = [{ provider: "0x" as ProviderName, message: "rate limit" }];
    const result = pickBestQuote(successes, failures, ["openocean", "kyberswap", "0x"]);
    expect(result?.loserSummary).toContain("kyberswap -100bps");
    expect(result?.loserSummary).toContain("0x ERR");
  });

  it("guards against winnerAmount=0 (degenerate trade) — bps falls back to 0", () => {
    // Both zero amountOut. Winner picked by tie-break order; alternative gets 0 bps.
    const successes = [stubQuote("kyberswap", 0n), stubQuote("openocean", 0n)];
    const result = pickBestQuote(successes, [], ["kyberswap", "openocean"]);
    expect(result?.winner.provider).toBe("kyberswap");
    const alt = result?.winner.alternatives?.[0];
    expect(alt?.status).toBe("ok");
    if (alt?.status === "ok") expect(alt.bpsBehindWinner).toBe(0);
  });
});
