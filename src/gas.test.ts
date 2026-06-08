// Pin the per-chain "cheap/normal/expensive" thresholds so accidental edits to
// gas.ts don't silently change what an agent considers "high gas." These are the
// values an agent will branch on when deciding whether to defer a trade.

import { describe, it, expect } from "vitest";
import { verdictForChain } from "./gas.js";

describe("verdictForChain", () => {
  // Threshold table from gas.ts (per-chain [cheap, normal] caps).
  it("Ethereum: cheap ≤10 / normal ≤50 / expensive >50", () => {
    expect(verdictForChain("ethereum", 5)).toBe("cheap");
    expect(verdictForChain("ethereum", 10)).toBe("cheap");
    expect(verdictForChain("ethereum", 30)).toBe("normal");
    expect(verdictForChain("ethereum", 50)).toBe("normal");
    expect(verdictForChain("ethereum", 100)).toBe("expensive");
  });

  it("Base: cheap ≤0.01 / normal ≤0.5", () => {
    expect(verdictForChain("base", 0.001)).toBe("cheap");
    expect(verdictForChain("base", 0.01)).toBe("cheap");
    expect(verdictForChain("base", 0.1)).toBe("normal");
    expect(verdictForChain("base", 0.5)).toBe("normal");
    expect(verdictForChain("base", 1)).toBe("expensive");
  });

  it("Polygon: cheap ≤30 / normal ≤200", () => {
    expect(verdictForChain("polygon", 25)).toBe("cheap");
    expect(verdictForChain("polygon", 100)).toBe("normal");
    expect(verdictForChain("polygon", 300)).toBe("expensive");
  });

  it("Unknown chain → unknown verdict (not crash)", () => {
    expect(verdictForChain("dogechain", 1000)).toBe("unknown");
    expect(verdictForChain("", 0)).toBe("unknown");
  });
});
