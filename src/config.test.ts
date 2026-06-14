import { describe, it, expect } from "vitest";
import {
  setConfigPath,
  parseConfigValue,
  configSchema,
  pushConfigArray,
  dropConfigArray,
  lowercaseChainKeys,
  chainRecordLookup,
  redactConfigForDisplay,
  resolveProfile,
  agentLockedConfigSection,
  type Config,
} from "./config.js";
import { ToolError } from "./errors.js";

describe("setConfigPath", () => {
  const base = configSchema.parse({});

  it("sets a top-level value and re-validates", () => {
    const next = setConfigPath(base, "activeChain", "arbitrum");
    expect(next.activeChain).toBe("arbitrum");
  });

  it("sets a nested value (auto-creates missing objects)", () => {
    const next = setConfigPath(base, "safety.perTxUsdLimit", 100);
    expect(next.safety.perTxUsdLimit).toBe(100);
  });

  it("deletes when value is undefined", () => {
    const withLimit = setConfigPath(base, "safety.perTxUsdLimit", 100);
    expect(withLimit.safety.perTxUsdLimit).toBe(100);
    const cleared = setConfigPath(withLimit, "safety.perTxUsdLimit", undefined);
    expect(cleared.safety.perTxUsdLimit).toBeUndefined();
  });

  it("rejects invalid values (Zod validates)", () => {
    expect(() => setConfigPath(base, "defaultSlippageBps", "not a number")).toThrow();
    expect(() => setConfigPath(base, "safety.maxSlippageBps", -5)).toThrow();
    expect(() => setConfigPath(base, "safety.maxSlippageBps", 99999)).toThrow();
  });

  it("error message names the path AND the offending value (iter278)", async () => {
    // Regression: pre-iter278 the error was a raw ZodError stack trace.
    const { ToolError: ToolErrorClass } = await import("./errors.js");
    try {
      setConfigPath(base, "defaultSlippageBps", "not a number");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolErrorClass);
      const err = e as InstanceType<typeof ToolErrorClass>;
      expect(err.code).toBe("INVALID_PARAMS");
      // Path echoed back
      expect(err.message).toContain("defaultSlippageBps");
      // Offending value echoed back so operator sees what they passed
      expect(err.message).toContain("not a number");
    }
  });
});

describe("parseConfigValue", () => {
  it("parses JSON numbers", () => {
    expect(parseConfigValue("100")).toBe(100);
    expect(parseConfigValue("3.14")).toBe(3.14);
  });

  it("parses JSON booleans / null", () => {
    expect(parseConfigValue("true")).toBe(true);
    expect(parseConfigValue("false")).toBe(false);
    expect(parseConfigValue("null")).toBeNull();
  });

  it("parses JSON arrays / objects", () => {
    expect(parseConfigValue('["a","b"]')).toEqual(["a", "b"]);
    expect(parseConfigValue('{"k":1}')).toEqual({ k: 1 });
  });

  it("falls back to the raw string on non-JSON", () => {
    expect(parseConfigValue("hello world")).toBe("hello world");
    expect(parseConfigValue("0xabc")).toBe("0xabc");
  });

  it("parses quoted strings as JSON strings (unquoted)", () => {
    expect(parseConfigValue('"hello"')).toBe("hello");
  });
});

// contractWhitelist entries are schema-validated as 0x + 40 hex chars; use real-shaped
// addresses so the configSchema.parse() at the end of setConfigPath doesn't reject.
const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDR_C = "0xcccccccccccccccccccccccccccccccccccccccc";

describe("pushConfigArray", () => {
  const base = configSchema.parse({});

  it("creates the array when the path is absent", () => {
    const { config: next, alreadyPresent, length } = pushConfigArray(
      base,
      "safety.contractWhitelist.base",
      ADDR_A,
    );
    expect(alreadyPresent).toBe(false);
    expect(length).toBe(1);
    expect(next.safety.contractWhitelist?.base).toEqual([ADDR_A]);
  });

  it("idempotent: pushing an already-present value is a no-op", () => {
    const step1 = pushConfigArray(base, "safety.contractWhitelist.base", ADDR_A).config;
    const step2 = pushConfigArray(step1, "safety.contractWhitelist.base", ADDR_A);
    expect(step2.alreadyPresent).toBe(true);
    expect(step2.length).toBe(1);
    expect(step2.config.safety.contractWhitelist?.base).toEqual([ADDR_A]);
  });

  it("preserves order and appends new values", () => {
    const a = pushConfigArray(base, "safety.contractWhitelist.base", ADDR_A).config;
    const ab = pushConfigArray(a, "safety.contractWhitelist.base", ADDR_B).config;
    expect(ab.safety.contractWhitelist?.base).toEqual([ADDR_A, ADDR_B]);
  });

  it("throws when the path resolves to a non-array, non-undefined value", () => {
    // safety.perTxUsdLimit is a number; pushing to it would silently convert; refuse instead.
    const withLimit = setConfigPath(base, "safety.perTxUsdLimit", 100);
    expect(() => pushConfigArray(withLimit, "safety.perTxUsdLimit", ADDR_A)).toThrow(/not an array/);
  });
});

describe("dropConfigArray", () => {
  const base = configSchema.parse({});

  it("removes the first occurrence; reports removed=true and new length", () => {
    const seeded = pushConfigArray(
      pushConfigArray(base, "safety.contractWhitelist.base", ADDR_A).config,
      "safety.contractWhitelist.base",
      ADDR_B,
    ).config;
    const { config: next, removed, length } = dropConfigArray(
      seeded,
      "safety.contractWhitelist.base",
      ADDR_A,
    );
    expect(removed).toBe(true);
    expect(length).toBe(1);
    expect(next.safety.contractWhitelist?.base).toEqual([ADDR_B]);
  });

  it("no-op when value is absent (removed=false)", () => {
    const seeded = pushConfigArray(base, "safety.contractWhitelist.base", ADDR_A).config;
    const { removed, length } = dropConfigArray(seeded, "safety.contractWhitelist.base", ADDR_C);
    expect(removed).toBe(false);
    expect(length).toBe(1);
  });

  it("no-op on a never-set path", () => {
    const { removed, length } = dropConfigArray(base, "safety.contractWhitelist.optimism", ADDR_A);
    expect(removed).toBe(false);
    expect(length).toBe(0);
  });

  it("throws when the path resolves to a non-array value", () => {
    const withLimit = setConfigPath(base, "safety.perTxUsdLimit", 100);
    expect(() => dropConfigArray(withLimit, "safety.perTxUsdLimit", ADDR_A)).toThrow(/not an array/);
  });
});

describe("lowercaseChainKeys (iter97 — load-time normalization)", () => {
  it("lowercases every key while preserving the value", () => {
    const out = lowercaseChainKeys({ Base: [1], ARBITRUM: [2], optimism: [3] });
    expect(out).toEqual({ base: [1], arbitrum: [2], optimism: [3] });
  });

  it("returns undefined for an undefined input (so safety reads can guard with ?.)", () => {
    expect(lowercaseChainKeys(undefined)).toBeUndefined();
  });

  it("preserves an empty record (still {} after normalization)", () => {
    expect(lowercaseChainKeys({})).toEqual({});
  });

  // Note: if two keys differ only by case ("Base" vs "base"), the later one wins. The
  // user has bigger problems in that case; we don't try to merge.
  it("last-key-wins on case-collisions (best-effort behavior)", () => {
    const out = lowercaseChainKeys({ Base: [1], base: [2] });
    expect(Object.keys(out!).length).toBe(1);
  });
});

describe("chainRecordLookup (iter96 — case-insensitive read)", () => {
  it("exact match wins (fast path)", () => {
    expect(chainRecordLookup({ base: "x", Base: "y" }, "base")).toBe("x");
  });

  it("falls back to case-insensitive when no exact match", () => {
    expect(chainRecordLookup({ Base: "y" }, "base")).toBe("y");
    expect(chainRecordLookup({ ARBITRUM: "z" }, "arbitrum")).toBe("z");
  });

  it("returns undefined for missing keys and undefined records", () => {
    expect(chainRecordLookup({ base: "x" }, "polygon")).toBeUndefined();
    expect(chainRecordLookup(undefined, "base")).toBeUndefined();
  });
});

describe("redactConfigForDisplay (iter118 — config show / MCP / web don't leak API keys)", () => {
  const base = configSchema.parse({});

  it("replaces non-empty apiKeys values with [REDACTED]", () => {
    const cfg = setConfigPath(base, "aggregator.apiKeys.0x", "sk-real-key-12345");
    const out = redactConfigForDisplay(cfg);
    expect(out.aggregator?.apiKeys?.["0x" as keyof typeof out.aggregator.apiKeys]).toBe("[REDACTED]");
  });

  it("leaves empty/undefined apiKey slots as-is so operators can see which keys are unset", () => {
    const cfg = setConfigPath(base, "aggregator.apiKeys", { "0x": "", "1inch": "real-key" });
    const out = redactConfigForDisplay(cfg);
    expect(out.aggregator?.apiKeys?.["0x" as keyof NonNullable<typeof out.aggregator.apiKeys>]).toBe("");
    expect(out.aggregator?.apiKeys?.["1inch" as keyof NonNullable<typeof out.aggregator.apiKeys>]).toBe(
      "[REDACTED]",
    );
  });

  it("does not mutate the input config (returns a copy)", () => {
    const cfg = setConfigPath(base, "aggregator.apiKeys.0x", "real-key");
    redactConfigForDisplay(cfg);
    expect(cfg.aggregator?.apiKeys?.["0x" as keyof NonNullable<typeof cfg.aggregator.apiKeys>]).toBe(
      "real-key",
    );
  });

  it("is a no-op when apiKeys is undefined", () => {
    const out = redactConfigForDisplay(base);
    expect(out).toEqual(base);
  });
});

describe("resolveProfile custom-chain required-fields (iter315 — empty array counts as missing)", () => {
  // Build a config with a custom chain that has SOME fields but not all required ones.
  function makeConfigWithChain(chain: Record<string, unknown>): Config {
    const base = configSchema.parse({}) as unknown as Record<string, unknown>;
    return { ...base, chains: { zora: chain } } as unknown as Config;
  }

  it("rejects rpcs: [] with an actionable message", () => {
    const cfg = makeConfigWithChain({
      chainId: 7777777,
      rpcs: [],
      weth: "0x4200000000000000000000000000000000000006",
      usdc: "0x4200000000000000000000000000000000000006",
    });
    try {
      resolveProfile("zora", cfg);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("UNKNOWN_CHAIN");
      // Iter315 contract: error message names the field AND notes the empty-array cause
      expect((e as ToolError).message).toContain("rpcs");
      expect((e as ToolError).message).toMatch(/empty array/);
    }
  });

  it("rejects when chainId is missing", () => {
    const cfg = makeConfigWithChain({
      rpcs: ["https://rpc.zora.energy"],
      weth: "0x4200000000000000000000000000000000000006",
      usdc: "0x4200000000000000000000000000000000000006",
    });
    expect(() => resolveProfile("zora", cfg)).toThrow(/missing required field: chainId/);
  });

  it("accepts a fully-specified custom chain", () => {
    const cfg = makeConfigWithChain({
      chainId: 7777777,
      rpcs: ["https://rpc.zora.energy"],
      weth: "0x4200000000000000000000000000000000000006",
      usdc: "0x4200000000000000000000000000000000000006",
    });
    const profile = resolveProfile("zora", cfg);
    expect(profile.chainId).toBe(7777777);
    expect(profile.rpcs.length).toBe(1);
  });
});

describe("resolveProfile UNKNOWN_CHAIN typo suggestion (iter343)", () => {
  function emptyConfig(): Config {
    return configSchema.parse({}) as unknown as Config;
  }

  it("surfaces a 'Did you mean' hint for a single-typo chain name", () => {
    try {
      resolveProfile("baes", emptyConfig());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("UNKNOWN_CHAIN");
      expect((e as ToolError).message).toContain("Did you mean 'base'?");
      expect(((e as ToolError).details as { suggestion?: string }).suggestion).toBe("base");
    }
  });

  it("does NOT suggest when the input is far off (avoids misleading guesses)", () => {
    try {
      resolveProfile("zzzzz", emptyConfig());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).message).not.toMatch(/Did you mean/);
      expect(((e as ToolError).details as { suggestion?: string }).suggestion).toBeNull();
    }
  });

  it("suggests custom chain names too (not just built-ins)", () => {
    const cfg = configSchema.parse({
      chains: {
        myinternall3: {
          chainId: 999,
          rpcs: ["http://localhost:8545"],
          weth: "0x4200000000000000000000000000000000000006",
          usdc: "0x4200000000000000000000000000000000000006",
        },
      },
    }) as unknown as Config;
    try {
      resolveProfile("myinternall33", cfg);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).message).toContain("Did you mean 'myinternall3'?");
    }
  });
});

describe("agentLockedConfigSection (v89/v90 — operator-owned config)", () => {
  it("locks every operator-owned section (exact + nested path)", () => {
    for (const p of ["safety", "safety.maxSlippageBps", "safety.tradeApproval.enabled",
                     "chains", "chains.base.rpcs", "mev", "mev.privateRpcs.ethereum",
                     "webhooks", "webhooks.ops.url", "notifications"]) {
      expect(agentLockedConfigSection(p), p).not.toBeNull();
    }
  });

  it("leaves operational + routing config open (agent-writable)", () => {
    for (const p of ["activeChain", "activeAccount", "defaultSlippageBps",
                     "aggregator", "aggregator.mode", "aggregator.preferred"]) {
      expect(agentLockedConfigSection(p), p).toBeNull();
    }
  });

  it("matches on the section PREFIX, not a substring", () => {
    // A hypothetical sibling key that merely starts with the same letters must
    // not be falsely locked (prefix is "<section>." or exact).
    expect(agentLockedConfigSection("safetyNet")).toBeNull();
    expect(agentLockedConfigSection("chainsExtra")).toBeNull();
  });

  it("carries a human-readable reason for the error message", () => {
    expect(agentLockedConfigSection("chains.base.rpcs")!.what).toMatch(/RPC/i);
    expect(agentLockedConfigSection("mev")!.what).toMatch(/relay/i);
  });
});
