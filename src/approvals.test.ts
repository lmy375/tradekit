// Iter604: unit tests for the pure helpers extracted from cli/approvals.ts when
// bulk-revoke moved into approvals.ts (so MCP could share the same logic). The
// HTTP-touching planRevokeAll / executeRevokeAll are covered by smoke tests
// (they need a live chain); these tests pin the filter matching semantics so
// a regression in case-handling or the symbol-vs-address dual match gets caught.

import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { filterRevokeTargets, classifySpender, type ApprovalRow } from "./approvals.js";
import type { ChainProfile } from "./chains.js";
import type { Config } from "./config.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const UNI_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as Address;
const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;

const sampleRows: ApprovalRow[] = [
  {
    token: USDC,
    symbol: "USDC",
    decimals: 6,
    spender: UNI_ROUTER,
    allowance: 1_000_000n,
    display: "1.0",
    spenderLabel: "Uniswap V3 router",
  },
  {
    token: USDC,
    symbol: "USDC",
    decimals: 6,
    spender: KYBER_ROUTER,
    allowance: 5_000_000n,
    display: "5.0",
    spenderLabel: "Kyberswap router",
  },
  {
    token: WETH,
    symbol: "WETH",
    decimals: 18,
    spender: UNI_ROUTER,
    allowance: 1_000_000_000_000_000_000n,
    display: "1.0",
    spenderLabel: "Uniswap V3 router",
  },
];

describe("filterRevokeTargets (iter604)", () => {
  it("with no filters, returns every row (mapped to the target shape)", () => {
    const result = filterRevokeTargets(sampleRows, {});
    expect(result).toHaveLength(3);
    // Pin the shape transformation: ApprovalRow → RevokeAllTarget drops allowance/decimals
    // and renames spenderLabel from "string|undefined" to "string|null".
    expect(result[0]).toEqual({
      token: USDC,
      symbol: "USDC",
      spender: UNI_ROUTER,
      spenderLabel: "Uniswap V3 router",
      display: "1.0",
    });
  });

  it("filters by spender — exact (case-insensitive) match", () => {
    const result = filterRevokeTargets(sampleRows, { spender: UNI_ROUTER });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.spender === UNI_ROUTER)).toBe(true);
  });

  it("spender filter is case-insensitive on both sides", () => {
    // Pass the spender filter as all-lowercase; rows have checksummed casing.
    // Both should normalize to lowercase and match.
    const filterLower = UNI_ROUTER.toLowerCase() as Address;
    const result = filterRevokeTargets(sampleRows, { spender: filterLower });
    expect(result).toHaveLength(2);
  });

  it("filters by token symbol (case-insensitive)", () => {
    // "usdc" lowercased should match USDC rows.
    const result = filterRevokeTargets(sampleRows, { token: "usdc" });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.symbol === "USDC")).toBe(true);
  });

  it("filters by token symbol with mixed case", () => {
    const result = filterRevokeTargets(sampleRows, { token: "WeTh" });
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("WETH");
  });

  it("filters by token address (case-insensitive)", () => {
    // Pass the address in mixed case. Both sides normalize so all USDC rows match.
    const result = filterRevokeTargets(sampleRows, { token: USDC });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.token === USDC)).toBe(true);
  });

  it("token filter matches either symbol OR address — dual-match semantic", () => {
    // The same filter input (case-insensitive lowered address) matches the address
    // column. A symbol that happens to share characters with an address doesn't
    // false-match because the comparison is exact-equals after lowercase.
    const byAddress = filterRevokeTargets(sampleRows, { token: USDC.toLowerCase() });
    const bySymbol = filterRevokeTargets(sampleRows, { token: "USDC" });
    expect(byAddress).toHaveLength(2);
    expect(bySymbol).toHaveLength(2);
    // Same set of rows.
    expect(byAddress.map((r) => r.spender).sort()).toEqual(bySymbol.map((r) => r.spender).sort());
  });

  it("spender + token combine with AND semantics", () => {
    // Only the USDC-on-Uniswap row matches both filters.
    const result = filterRevokeTargets(sampleRows, { spender: UNI_ROUTER, token: "USDC" });
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("USDC");
    expect(result[0].spender).toBe(UNI_ROUTER);
  });

  it("returns empty array when no row matches (not undefined / not null)", () => {
    const result = filterRevokeTargets(sampleRows, { token: "DOES_NOT_EXIST" });
    expect(result).toEqual([]);
  });

  it("returns empty array on an empty input", () => {
    expect(filterRevokeTargets([], { token: "USDC" })).toEqual([]);
    expect(filterRevokeTargets([], {})).toEqual([]);
  });

  it("preserves input row order in the result (stable for deterministic UX)", () => {
    // CLI prints the target list in order; a regression that sorted/reversed the
    // output would confuse operators comparing the plan to `allowances list`.
    const result = filterRevokeTargets(sampleRows, {});
    expect(result.map((r) => r.spender)).toEqual([UNI_ROUTER, KYBER_ROUTER, UNI_ROUTER]);
  });

  it("normalizes spenderLabel undefined → null in the target shape", () => {
    // ApprovalRow.spenderLabel is optional (undefined when no label); RevokeAllTarget
    // standardizes to null so JSON output is consistent.
    const rowsNoLabel: ApprovalRow[] = [
      { ...sampleRows[0], spenderLabel: undefined },
    ];
    const result = filterRevokeTargets(rowsNoLabel, {});
    expect(result[0].spenderLabel).toBeNull();
  });
});

describe("classifySpender (iter681)", () => {
  // Minimal profile — only the fields classifySpender reads.
  const profile = {
    name: "base",
    uniswapV3: { swapRouter02: "0x2626664c2603336e57b271c5c0b26f421741e481" as Address },
    tokens: {},
    usdc: "0x" + "00".repeat(20) as Address,
    weth: "0x" + "00".repeat(20) as Address,
  } as unknown as ChainProfile;

  it("classifies a curated KyberSwap router as known/router", async () => {
    const KYBER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
    const r = await classifySpender(KYBER, profile);
    expect(r.isKnown).toBe(true);
    expect(r.source).toBe("router");
    expect(r.label).toMatch(/KyberSwap/i);
  });

  it("classifies the profile's Uniswap V3 router as known/router (per-chain)", async () => {
    const r = await classifySpender(profile.uniswapV3!.swapRouter02, profile);
    expect(r.isKnown).toBe(true);
    expect(r.source).toBe("router");
  });

  it("router match is case-insensitive", async () => {
    const KYBER_LOWER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5" as Address;
    const r = await classifySpender(KYBER_LOWER, profile);
    expect(r.isKnown).toBe(true);
  });

  it("classifies a config.safety.contractWhitelist match as known/whitelist", async () => {
    const CUSTOM = "0x" + "ab".repeat(20) as Address;
    const config = {
      safety: { contractWhitelist: { base: [CUSTOM] } },
    } as unknown as Config;
    const r = await classifySpender(CUSTOM, profile, config);
    expect(r.isKnown).toBe(true);
    expect(r.source).toBe("whitelist");
  });

  it("returns unknown when no source matches", async () => {
    const UNKNOWN_ADDR = "0x" + "ff".repeat(20) as Address;
    const r = await classifySpender(UNKNOWN_ADDR, profile);
    expect(r.isKnown).toBe(false);
    expect(r.source).toBe("unknown");
    expect(r.label).toBeUndefined();
  });

  it("router > whitelist resolution order: curated wins when address appears in both", async () => {
    const KYBER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
    const config = {
      safety: { contractWhitelist: { base: [KYBER] } },
    } as unknown as Config;
    const r = await classifySpender(KYBER, profile, config);
    // Curated label (more informative than "operator whitelist") wins.
    expect(r.source).toBe("router");
    expect(r.label).toMatch(/KyberSwap/i);
  });
});
