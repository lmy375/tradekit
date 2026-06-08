import { describe, it, expect } from "vitest";
import { getBuiltinProfile, profileByChainId, resolveToken, resolveTradePair, listChains, assertKnownChain, assertAddressEIP55, unknownTokenError } from "./chains.js";
import { ToolError } from "./errors.js";
import type { Config } from "./config.js";

describe("chain profile registry", () => {
  it("lists exactly the six supported chains", () => {
    expect(listChains().sort()).toEqual(
      ["arbitrum", "base", "bnb", "ethereum", "optimism", "polygon"].sort(),
    );
  });

  it("getBuiltinProfile is case-insensitive", () => {
    expect(getBuiltinProfile("BASE")?.chainId).toBe(8453);
    expect(getBuiltinProfile("base")?.chainId).toBe(8453);
    expect(getBuiltinProfile("nope")).toBeUndefined();
  });

  it("profileByChainId returns the right chain", () => {
    expect(profileByChainId(8453)?.name).toBe("base");
    expect(profileByChainId(1)?.name).toBe("ethereum");
    expect(profileByChainId(99999)).toBeUndefined();
  });
});

describe("resolveToken", () => {
  const base = getBuiltinProfile("base")!;

  it("returns 0x-prefixed input unchanged when it looks like an address", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    expect(resolveToken(base, addr)).toBe(addr);
  });

  it("maps ETH / NATIVE to the wrapped native (WETH)", () => {
    expect(resolveToken(base, "ETH")).toBe(base.weth);
    expect(resolveToken(base, "NATIVE")).toBe(base.weth);
    // Case-insensitive
    expect(resolveToken(base, "eth")).toBe(base.weth);
  });

  it("resolves known symbols case-insensitively", () => {
    expect(resolveToken(base, "USDC")).toBe(base.usdc);
    expect(resolveToken(base, "usdc")).toBe(base.usdc);
  });

  it("returns null for unknown symbols", () => {
    expect(resolveToken(base, "FAKETOKEN123")).toBeNull();
  });

  // iter122 hardening — pre-fix resolveToken only checked length+prefix, so non-hex
  // values like "0xzzz..." (right length, wrong content) were returned as if they were
  // real addresses and exploded later in viem with an opaque contract-read error.
  it("rejects 42-char 0x-prefixed values that aren't valid hex (regression)", () => {
    expect(resolveToken(base, "0x" + "z".repeat(40))).toBeNull();
    expect(resolveToken(base, "0x" + "g".repeat(40))).toBeNull();
  });

  it("rejects 0x-prefixed values of the wrong length", () => {
    expect(resolveToken(base, "0x123")).toBeNull(); // too short
    expect(resolveToken(base, "0x" + "a".repeat(64))).toBeNull(); // tx-hash length, not address
  });

  it("accepts mixed-case hex (block explorer / EIP-55 checksum forms)", () => {
    // viem isAddress with {strict:false} accepts both lowercase and EIP-55 checksum.
    const checksummed = "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e";
    expect(resolveToken(base, checksummed)).toBe(checksummed);
  });
});

describe("resolveTradePair", () => {
  const base = getBuiltinProfile("base")!;

  it("preserves the \"ETH\" sentinel for native base (NOT the weth address)", () => {
    // The trade flow checks `base === \"ETH\"` to choose the native code path. If
    // resolveTradePair returned profile.weth for ETH base, every ETH→USDC swap would
    // take the ERC20 path and silently break.
    const { base: b, quote: q } = resolveTradePair(base, "ETH", "USDC");
    expect(b).toBe("ETH");
    expect(q).toBe(base.usdc);
  });

  it("treats 'NATIVE' as an alias for ETH (case-insensitive)", () => {
    expect(resolveTradePair(base, "native", "USDC").base).toBe("ETH");
    expect(resolveTradePair(base, "Native", "USDC").base).toBe("ETH");
    expect(resolveTradePair(base, "eth", "USDC").base).toBe("ETH");
  });

  it("resolves a known ERC20 base to its address", () => {
    const { base: b } = resolveTradePair(base, "USDC", "DAI");
    expect(b).toBe(base.usdc);
  });

  it("passes through a well-shaped 0x address on either side", () => {
    const random = "0x1234567890abcdef1234567890abcdef12345678";
    const { base: b, quote: q } = resolveTradePair(base, random, base.usdc);
    expect(b).toBe(random);
    expect(q).toBe(base.usdc);
  });

  it("throws UNKNOWN_TOKEN for an unresolvable quote (even when base is ETH)", () => {
    // Was easy to skip in the old per-caller code; pin it here so the contract is clear.
    try {
      resolveTradePair(base, "ETH", "NOPE-NOT-A-TOKEN");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("UNKNOWN_TOKEN");
      expect((e as ToolError).message).toMatch(/quote/i);
      // Iter298: error includes the chain name and the recovery hint
      expect((e as ToolError).message).toContain("base"); // the chain name
      expect((e as ToolError).message).toMatch(/0x address|token list/i);
    }
  });

  it("throws UNKNOWN_TOKEN for an unresolvable base", () => {
    try {
      resolveTradePair(base, "NOPE-NOT-A-TOKEN", "USDC");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("UNKNOWN_TOKEN");
      expect((e as ToolError).message).toMatch(/base/i);
      // Iter298: same actionable hint shape as the quote-token path
      expect((e as ToolError).message).toMatch(/0x address|token list/i);
    }
  });
});

describe("assertKnownChain (iter287 — shared boundary validator)", () => {
  // Bare-minimum config; only `chains` field is used by the assertion.
  const baseConfig = { chains: {} } as unknown as Config;

  it("no-ops when chain is undefined (matches `chain is optional` semantics)", () => {
    expect(() => assertKnownChain(undefined, baseConfig)).not.toThrow();
  });

  it("accepts a built-in chain name", () => {
    expect(() => assertKnownChain("base", baseConfig)).not.toThrow();
    expect(() => assertKnownChain("ethereum", baseConfig)).not.toThrow();
  });

  it("accepts a built-in chain name regardless of casing", () => {
    expect(() => assertKnownChain("BASE", baseConfig)).not.toThrow();
    expect(() => assertKnownChain("Base", baseConfig)).not.toThrow();
  });

  it("accepts a user-configured custom chain", () => {
    const withCustom = { chains: { zora: {} } } as unknown as Config;
    expect(() => assertKnownChain("zora", withCustom)).not.toThrow();
  });

  it("throws UNKNOWN_CHAIN with the known list for typos", () => {
    try {
      assertKnownChain("bse", baseConfig);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("UNKNOWN_CHAIN");
      // Echoes the bad input
      expect((e as ToolError).message).toContain("bse");
      // Lists at least one valid alternative so operator can correct
      expect((e as ToolError).message).toContain("base");
    }
  });
});

describe("assertAddressEIP55 (iter292 — shared shape + checksum validator)", () => {
  const WETH_BASE_CHECKSUM = "0x4200000000000000000000000000000000000006"; // all-lower but valid
  const USDC_BASE_CHECKSUM = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // proper EIP-55

  it("accepts a properly checksummed address (valid EIP-55)", () => {
    expect(assertAddressEIP55("spender", USDC_BASE_CHECKSUM)).toBe(USDC_BASE_CHECKSUM);
  });

  it("accepts an all-lowercase address (EIP-55 'no checksum' form)", () => {
    expect(assertAddressEIP55("spender", USDC_BASE_CHECKSUM.toLowerCase())).toBe(
      USDC_BASE_CHECKSUM.toLowerCase(),
    );
    expect(assertAddressEIP55("spender", WETH_BASE_CHECKSUM)).toBe(WETH_BASE_CHECKSUM);
  });

  it("rejects malformed shape with 'expected 0x-prefixed 40 hex chars'", () => {
    try {
      assertAddressEIP55("spender", "0xshort");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("INVALID_PARAMS");
      expect((e as ToolError).message).toMatch(/expected 0x-prefixed 40 hex chars/);
      expect((e as ToolError).message).toContain("0xshort");
    }
  });

  it("rejects a wrong-checksum address with EIP-55 typo-catch message", () => {
    // Take a valid checksummed address and corrupt one character.
    const corrupted = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02914"; // last digit changed
    try {
      assertAddressEIP55("spender", corrupted);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("INVALID_PARAMS");
      expect((e as ToolError).message).toMatch(/invalid EIP-55 checksum/);
      // Mentions the lowercase escape hatch
      expect((e as ToolError).message).toContain("lowercase");
    }
  });

  it("capitalizes the label in the checksum error", () => {
    // "spender" → "Spender address ...", "recipient" → "Recipient address ..."
    const corrupted = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02914";
    try {
      assertAddressEIP55("spender", corrupted);
    } catch (e) {
      expect((e as ToolError).message).toMatch(/^Spender address/);
    }
    try {
      assertAddressEIP55("recipient", corrupted);
    } catch (e) {
      expect((e as ToolError).message).toMatch(/^Recipient address/);
    }
  });
});

describe("unknownTokenError (iter345 — UNKNOWN_TOKEN typo suggestion)", () => {
  const base = getBuiltinProfile("base")!;

  it("suggests the closest token when input is a single-typo symbol", () => {
    const e = unknownTokenError("token", "USDT", base);
    expect(e.code).toBe("UNKNOWN_TOKEN");
    expect(e.message).toContain('Did you mean "USDC"?');
    expect((e.details as { suggestion: string | null }).suggestion).toBe("USDC");
  });

  it("preserves the iter298 'token list' footer and chain name", () => {
    const e = unknownTokenError("base token", "WBTH", base);
    expect(e.message).toContain('on chain "base"');
    expect(e.message).toContain("token list base");
  });

  it("does NOT suggest when the input looks like an address (Levenshtein on hex is useless)", () => {
    const e = unknownTokenError("token", "0xabc1230000000000000000000000000000000000", base);
    expect(e.message).not.toMatch(/Did you mean/);
    expect((e.details as { suggestion: string | null }).suggestion).toBeNull();
  });

  it("does NOT suggest when no known symbol is close enough (avoids misleading)", () => {
    const e = unknownTokenError("token", "zzz_unrelated_symbol", base);
    expect(e.message).not.toMatch(/Did you mean/);
    expect((e.details as { suggestion: string | null }).suggestion).toBeNull();
  });
});
