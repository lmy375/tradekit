// Tests for MEV-protected submission (mev.ts). Three layers:
//   1) resolveMevSubmit — pure config dispatch
//   2) buildSubmitTransport — transport selection (we don't run a real
//      RPC; the test verifies the returned shape is the expected viem
//      transport variant via behavioral probing — the public fallback
//      transport is identifiable, and the private-only / private-first
//      variants have observable structural differences).
//   3) redactPrivateRpcUrl — host-only fingerprint
//   4) probeMevRpc — fetch-mocked happy + failure paths
//
// No DB / no wallet — pure-logic + small fetch mock.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveMevSubmit,
  buildSubmitTransport,
  redactPrivateRpcUrl,
  probeMevRpc,
  assessMevExposure,
} from "./mev.js";
import type { MevConfig } from "./config.js";
import { configSchema, redactConfigForDisplay } from "./config.js";
import { redactSensitiveFields } from "./db.js";
import { http } from "viem";
import type { ChainProfile } from "./chains.js";

// ── fixtures ─────────────────────────────────────────────────

function mockProfile(name = "ethereum", chainId = 1): ChainProfile {
  return {
    name,
    chainId,
    nativeSymbol: "ETH",
    viemChain: { id: chainId, name } as ChainProfile["viemChain"],
    rpcs: ["https://eth.llamarpc.com"],
    explorer: "https://etherscan.io",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    tokens: {},
    aggregators: [],
  };
}

function makeMev(overrides: Partial<Parameters<typeof resolveMevSubmit>[0] & object> = {}) {
  return {
    enabled: true,
    privateRpcs: {
      ethereum: "https://rpc.flashbots.net/fast",
    },
    fallbackToPublic: false,
    labels: { ethereum: "Flashbots Protect" },
    ...overrides,
  };
}

// ── resolveMevSubmit ─────────────────────────────────────────

describe("resolveMevSubmit", () => {
  it("returns active=false when MEV is disabled", () => {
    expect(
      resolveMevSubmit({ enabled: false, privateRpcs: { ethereum: "https://x" }, fallbackToPublic: false, labels: {} }, "ethereum"),
    ).toEqual({ active: false, fallbackToPublic: false });
  });

  it("returns active=false when MEV is undefined", () => {
    expect(resolveMevSubmit(undefined, "ethereum")).toEqual({ active: false, fallbackToPublic: false });
  });

  it("returns active=false when chain has no privateRpc entry", () => {
    const r = resolveMevSubmit(makeMev(), "arbitrum");
    expect(r.active).toBe(false);
  });

  it("returns active=true + URL + label when chain matches (case-insensitive)", () => {
    const r1 = resolveMevSubmit(makeMev(), "ethereum");
    expect(r1).toMatchObject({
      active: true,
      privateUrl: "https://rpc.flashbots.net/fast",
      label: "Flashbots Protect",
      fallbackToPublic: false,
    });
    // Case-insensitive chain match (after the loader's lowercase
    // normalization the field is already lowercased; this guards the
    // pure-helper layer against being called with a wrong-cased name).
    const r2 = resolveMevSubmit(makeMev(), "Ethereum");
    expect(r2.active).toBe(true);
    expect(r2.privateUrl).toBe("https://rpc.flashbots.net/fast");
  });

  it("uses 'private relay' as the default label when none configured", () => {
    const r = resolveMevSubmit(
      { enabled: true, privateRpcs: { base: "https://rpc.mevblocker.io" }, fallbackToPublic: false, labels: {} },
      "base",
    );
    expect(r.label).toBe("private relay");
  });

  it("surfaces fallbackToPublic flag from config", () => {
    const r = resolveMevSubmit(makeMev({ fallbackToPublic: true }), "ethereum");
    expect(r.fallbackToPublic).toBe(true);
  });
});

// ── buildSubmitTransport ─────────────────────────────────────

describe("buildSubmitTransport", () => {
  it("returns the unchanged public transport when MEV is inactive", () => {
    const publicTransport = http("https://eth.llamarpc.com");
    const out = buildSubmitTransport({
      profile: mockProfile(),
      mev: { enabled: false, privateRpcs: {}, fallbackToPublic: false, labels: {} },
      publicTransport,
    });
    expect(out).toBe(publicTransport);
  });

  it("returns the unchanged public transport when MEV is enabled but chain has no entry", () => {
    const publicTransport = http("https://eth.llamarpc.com");
    const out = buildSubmitTransport({
      profile: mockProfile("polygon", 137),
      mev: makeMev(), // only has ethereum entry
      publicTransport,
    });
    expect(out).toBe(publicTransport);
  });

  it("returns a DIFFERENT transport (private-leg fallback) when MEV is active + strict", () => {
    const publicTransport = http("https://eth.llamarpc.com");
    const out = buildSubmitTransport({
      profile: mockProfile(),
      mev: makeMev({ fallbackToPublic: false }),
      publicTransport,
    });
    expect(out).not.toBe(publicTransport);
    // viem transports are functions. The returned thing should be callable
    // with a chain config and return a request object. Just verify shape.
    const probe = (out as unknown as (cfg: { chain?: unknown }) => { value: { transports: unknown[] } })({});
    // The strict-mode wrap is fallback([privateLeg]) so the inner value
    // carries exactly one transport (the private leg). Graceful-degrade
    // carries two.
    expect(probe.value.transports.length).toBe(1);
  });

  it("returns a TWO-leg fallback ([private, public]) when fallbackToPublic=true", () => {
    const publicTransport = http("https://eth.llamarpc.com");
    const out = buildSubmitTransport({
      profile: mockProfile(),
      mev: makeMev({ fallbackToPublic: true }),
      publicTransport,
    });
    expect(out).not.toBe(publicTransport);
    const probe = (out as unknown as (cfg: { chain?: unknown }) => { value: { transports: unknown[] } })({});
    expect(probe.value.transports.length).toBe(2);
  });
});

// ── redactPrivateRpcUrl ──────────────────────────────────────

describe("redactPrivateRpcUrl", () => {
  it("preserves host + protocol, masks path", () => {
    expect(redactPrivateRpcUrl("https://rpc.merkle.io/abcd1234secret")).toBe(
      "https://rpc.merkle.io/[REDACTED]",
    );
    expect(redactPrivateRpcUrl("https://rpc.flashbots.net/fast")).toBe(
      "https://rpc.flashbots.net/[REDACTED]",
    );
  });

  it("returns [REDACTED] for malformed URLs", () => {
    expect(redactPrivateRpcUrl("not-a-url")).toBe("[REDACTED]");
    expect(redactPrivateRpcUrl("")).toBe("[REDACTED]");
  });
});

// ── redaction integration ────────────────────────────────────

describe("redactConfigForDisplay — mev redaction", () => {
  it("scrubs mev.privateRpcs URLs in the displayed config", () => {
    const cfg = configSchema.parse({
      mev: {
        enabled: true,
        privateRpcs: {
          ethereum: "https://rpc.merkle.io/SECRET_KEY",
          base: "https://rpc.flashbots.net/fast",
        },
        fallbackToPublic: false,
        labels: { ethereum: "Merkle" },
      },
    });
    const display = redactConfigForDisplay(cfg);
    expect(display.mev.privateRpcs.ethereum).toBe("https://rpc.merkle.io/[REDACTED]");
    expect(display.mev.privateRpcs.base).toBe("https://rpc.flashbots.net/[REDACTED]");
    // Labels stay readable (they're operator-facing strings, never sensitive)
    expect(display.mev.labels.ethereum).toBe("Merkle");
    // Original untouched
    expect(cfg.mev.privateRpcs.ethereum).toBe("https://rpc.merkle.io/SECRET_KEY");
  });

  it("leaves mev untouched when no privateRpcs are configured", () => {
    const cfg = configSchema.parse({ mev: { enabled: false } });
    const display = redactConfigForDisplay(cfg);
    expect(display.mev).toEqual(cfg.mev);
  });
});

describe("redactSensitiveFields — private RPC keys", () => {
  it("scrubs `privateRpc` / `private_rpcs` keys at any nesting depth", () => {
    const redacted = redactSensitiveFields({
      action: "push",
      path: "mev.privateRpcs.ethereum",
      // The CLI passes the URL as a positional string; if a future code
      // path stuffs it into a value under a recognized key, the redactor
      // should mask it.
      params: {
        privateRpc: "https://rpc.merkle.io/SECRET_KEY",
        notSensitive: "hello",
      },
    });
    expect((redacted.params as { privateRpc: string }).privateRpc).toBe("[REDACTED]");
    expect((redacted.params as { notSensitive: string }).notSensitive).toBe("hello");
  });

  it("scrubs nested privateRpcs records", () => {
    const redacted = redactSensitiveFields({
      privateRpcs: {
        ethereum: "https://rpc.merkle.io/SECRET",
      },
    });
    // The whole record value gets stamped REDACTED at the matched key —
    // we don't try to preserve the chain map shape because we're
    // redacting the parent key entirely.
    expect((redacted as { privateRpcs: unknown }).privateRpcs).toBe("[REDACTED]");
  });
});

// ── probeMevRpc ──────────────────────────────────────────────

describe("probeMevRpc — fetch mocked", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("happy path: relay returns matching chainId", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 }),
    );
    const r = await probeMevRpc("https://rpc.flashbots.net/fast", 1);
    expect(r.reachable).toBe(true);
    expect(r.observedChainId).toBe(1);
    expect(r.error).toBeUndefined();
  });

  it("chain mismatch: relay reports a different chainId than expected", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x89" }), { status: 200 }), // 137 = polygon
    );
    const r = await probeMevRpc("https://rpc.flashbots.net/fast", 1);
    expect(r.reachable).toBe(false);
    expect(r.observedChainId).toBe(137);
    expect(r.error).toMatch(/chain mismatch/);
  });

  it("HTTP non-200 → not reachable", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("server boom", { status: 500 }));
    const r = await probeMevRpc("https://rpc.flashbots.net/fast", 1);
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/HTTP 500/);
  });

  it("RPC-level error in body → not reachable", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } }),
        { status: 200 },
      ),
    );
    const r = await probeMevRpc("https://rpc.flashbots.net/fast", 1);
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/method not found/);
  });

  it("missing result field → not reachable", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { status: 200 }),
    );
    const r = await probeMevRpc("https://rpc.flashbots.net/fast", 1);
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/missing result/);
  });

  it("network error → caught + surfaced as error message", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    const r = await probeMevRpc("https://rpc.flashbots.net/fast", 1);
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/fetch failed/);
  });

  it("elapsedMs is set on both success and failure paths", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: "0x1" }), { status: 200 }),
    );
    const ok = await probeMevRpc("https://rpc.flashbots.net/fast", 1);
    expect(typeof ok.elapsedMs).toBe("number");
    expect(ok.elapsedMs).toBeGreaterThanOrEqual(0);
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    const fail = await probeMevRpc("https://rpc.flashbots.net/fast", 1);
    expect(typeof fail.elapsedMs).toBe("number");
  });
});

describe("assessMevExposure (v77)", () => {
  const mev = (over: Partial<MevConfig> = {}): MevConfig =>
    ({ enabled: false, privateRpcs: {}, labels: {}, fallbackToPublic: false, ...over }) as MevConfig;

  it("Ethereum mainnet with NO protection → exposed (high sandwich risk)", () => {
    const r = assessMevExposure("ethereum", mev());
    expect(r.sandwichRisk).toBe("high");
    expect(r.protected).toBe(false);
    expect(r.exposed).toBe(true);
    expect(r.advisory).toMatch(/NO MEV protection/);
  });

  it("Ethereum WITH an active private relay → protected, not exposed", () => {
    const r = assessMevExposure("ethereum", mev({ enabled: true, privateRpcs: { ethereum: "https://rpc.flashbots.net/fast" }, labels: { ethereum: "Flashbots" } }));
    expect(r.protected).toBe(true);
    expect(r.exposed).toBe(false);
    expect(r.relayLabel).toBe("Flashbots");
    expect(r.advisory).toMatch(/protected/i);
  });

  it("BNB / Polygon are medium risk → exposed without protection", () => {
    expect(assessMevExposure("bnb", mev()).exposed).toBe(true);
    expect(assessMevExposure("polygon", mev()).sandwichRisk).toBe("medium");
  });

  it("single-sequencer L2s (base/arbitrum/optimism) are low risk → NOT exposed", () => {
    for (const c of ["base", "arbitrum", "optimism"]) {
      const r = assessMevExposure(c, mev());
      expect(r.sandwichRisk).toBe("low");
      expect(r.exposed).toBe(false);
    }
  });

  it("unknown/custom chains default to low risk (don't over-warn)", () => {
    expect(assessMevExposure("zkfoo", mev()).sandwichRisk).toBe("low");
    expect(assessMevExposure("zkfoo", mev()).exposed).toBe(false);
  });

  it("protection on the same chain clears exposure even at high risk", () => {
    const r = assessMevExposure("ethereum", mev({ enabled: true, privateRpcs: { ethereum: "https://x" } }));
    expect(r.exposed).toBe(false);
  });
});
