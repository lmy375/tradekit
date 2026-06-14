/**
 * Stablecoin registry tests (v85). The point of the consolidation: every P&L /
 * tax / classification surface now shares ONE set, so a quote symbol is a
 * dollar everywhere or nowhere. These pin the canonical set — including the
 * symbols that were previously recognized by only SOME surfaces (the live
 * divergence this fixed) — and guard against a surface keeping a private copy.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isStablecoin, STABLECOIN_SYMBOLS } from "./stablecoins.js";

describe("isStablecoin", () => {
  it("recognizes the core stablecoins", () => {
    for (const s of ["USDC", "USDT", "DAI", "FRAX"]) expect(isStablecoin(s)).toBe(true);
  });

  it("recognizes EVERY symbol that any prior surface recognized (the union — no coverage lost)", () => {
    // pnl/tradeExport/aggregatorStats/pairStats/importTrade had BUSD/USDP/TUSD;
    // paperPnl had USDBC/LUSD/GUSD/USDS. Before consolidation these split the
    // surfaces — now all are stable everywhere.
    for (const s of ["BUSD", "USDP", "TUSD", "USDBC", "LUSD", "GUSD", "USDS", "USDC.E"]) {
      expect(isStablecoin(s), s).toBe(true);
    }
  });

  it("is case-insensitive (bridged USDC.e matches)", () => {
    expect(isStablecoin("usdc")).toBe(true);
    expect(isStablecoin("USDC.e")).toBe(true);
    expect(isStablecoin("UsDc.E")).toBe(true);
  });

  it("rejects non-stablecoins + empty/null", () => {
    for (const s of ["WETH", "WBTC", "PEPE", "ETH", "", null, undefined]) {
      expect(isStablecoin(s)).toBe(false);
    }
  });

  it("the set is non-trivial + frozen-ish (no accidental shrink)", () => {
    expect(STABLECOIN_SYMBOLS.size).toBeGreaterThanOrEqual(12);
  });
});

describe("no surface keeps a private stablecoin list (regression guard)", () => {
  it("only stablecoins.ts defines an isStablecoin/STABLE set; others import it", () => {
    // Catch a future copy-paste reintroducing the divergence this fixed.
    const srcDir = fileURLToPath(new URL(".", import.meta.url));
    const offenders: string[] = [];
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "stablecoins.ts") continue;
      const body = readFileSync(join(srcDir, f), "utf8");
      // A local definition (not an import) of a stablecoin recognizer.
      if (/function isStablecoin\s*\(/.test(body) || /const STABLE_SYMBOLS\b/.test(body)) {
        offenders.push(f);
      }
    }
    expect(offenders, `these files redefine a stablecoin set instead of importing stablecoins.ts: ${offenders.join(", ")}`).toEqual([]);
  });
});
