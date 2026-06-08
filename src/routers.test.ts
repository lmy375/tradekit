// Pin the canonical router registry. Two contracts:
//   - KNOWN_ROUTERS must include the aggregators we actually probe in allowances
//     (a missing entry means a real infinite-approval is invisible).
//   - ROUTER_BY_ADDRESS keys are always lowercased — importTrade classifies tx.to by
//     looking up `to.toLowerCase()`, so a checksummed key would silently never match.

import { describe, it, expect } from "vitest";
import { KNOWN_ROUTERS, ROUTER_BY_ADDRESS } from "./routers.js";

describe("KNOWN_ROUTERS registry", () => {
  it("covers the canonical aggregators the codebase calls out", () => {
    const aggregators = new Set(KNOWN_ROUTERS.map((r) => r.aggregator));
    for (const required of ["kyberswap", "openocean", "1inch", "0x", "uniswap-v3", "uniswap-universal"]) {
      expect(aggregators.has(required)).toBe(true);
    }
  });

  it("has no duplicate addresses (would cause silently-overridden labels)", () => {
    const addrs = KNOWN_ROUTERS.map((r) => r.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

describe("ROUTER_BY_ADDRESS lookup", () => {
  it("keys are lowercase — case-mismatched keys are the classic silent-miss bug", () => {
    for (const key of ROUTER_BY_ADDRESS.keys()) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("classifyAggregator-style lookup resolves a known router (1inch v6)", () => {
    expect(ROUTER_BY_ADDRESS.get("0x111111125421ca6dc452d289314280a0f8842a65")?.aggregator).toBe("1inch");
  });

  it("returns undefined for an address that isn't in the registry", () => {
    expect(ROUTER_BY_ADDRESS.get("0x0000000000000000000000000000000000000000")).toBeUndefined();
  });

  it("matches regardless of caller-supplied casing (callers lowercase first)", () => {
    // The classifier in importTrade.ts does .toLowerCase() before lookup. This test
    // pins that the registry's stored keys match that contract.
    const checksummed = "0x111111125421Ca6dC452d289314280a0f8842A65";
    expect(ROUTER_BY_ADDRESS.get(checksummed.toLowerCase())?.aggregator).toBe("1inch");
  });
});
