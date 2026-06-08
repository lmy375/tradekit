// Tests for the pre-trade auto token-safety check (autoTokenCheck.ts).
// Three layers:
//   1) Pure helpers — verdict-to-action, baseline-trusted detection,
//      operator-whitelist lookup
//   2) Cache layer — getCachedTokenVerdict / putCachedTokenVerdict, TTL
//      semantics, expired-row treatment
//   3) Integration — checkTokenAtTradeTime + enforceTokenSafety with a
//      stubbed probe. Covers: feature disabled, baseline skip, whitelist
//      skip, cache hit, cache miss → probe → store, probe-throws →
//      fail-open, honeypot → block + throw, suspicious + fail flag
//
// No live RPC / no wallet. Probe is fully stubbed.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-autotc-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  verdictAction,
  isBaselineTrustedToken,
  isOperatorWhitelisted,
  checkTokenAtTradeTime,
  enforceTokenSafety,
} = await import("./autoTokenCheck.js");
const {
  getCachedTokenVerdict,
  putCachedTokenVerdict,
  clearExpiredTokenVerdicts,
  listCachedTokenVerdicts,
  openDb,
  closeDb,
} = await import("./db.js");
const { configSchema } = await import("./config.js");

import type { ChainProfile } from "./chains.js";
import type { Logger } from "./logger.js";
import type { TokenSafetyReport, SafetyVerdict } from "./tokenSafety.js";
import type { PublicClient, Transport, Chain } from "viem";

// Stub PublicClient — `as unknown as PublicClient<Transport, Chain>` so
// the strict-typed CheckTokenAtTradeTimeArgs accepts it. The mock probe
// fn is injected and never actually uses the client, so the inner shape
// doesn't matter.
const STUB_CLIENT = {} as unknown as PublicClient<Transport, Chain>;

beforeAll(() => {
  openDb();
});

afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM token_safety_cache");
});

// ── fixtures ─────────────────────────────────────────────────

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as `0x${string}`;
const WETH_BASE = "0x4200000000000000000000000000000000000006" as `0x${string}`;
const WBTC_BASE = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c" as `0x${string}`;
const RANDOM_TOKEN = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`;

function mockProfile(): ChainProfile {
  return {
    name: "base",
    chainId: 8453,
    viemChain: { id: 8453, name: "base" } as ChainProfile["viemChain"],
    rpcs: ["https://base.example"],
    nativeSymbol: "ETH",
    explorer: "https://basescan.org",
    weth: WETH_BASE,
    usdc: USDC_BASE,
    tokens: { WETH: WETH_BASE, USDC: USDC_BASE, WBTC: WBTC_BASE },
    aggregators: ["kyberswap"],
  };
}

const stubLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  recordAudit: () => {},
} as unknown as Logger;

function buildConfig(autoOverride: Partial<{
  enabled: boolean;
  cacheTtlMs: number;
  failOnSuspicious: boolean;
  probeUsd: number;
  skipWhitelisted: boolean;
}> = {}, whitelist?: Record<string, string[]>) {
  return configSchema.parse({
    safety: {
      autoTokenCheck: {
        enabled: true,
        cacheTtlMs: 60_000,
        failOnSuspicious: true,
        probeUsd: 5,
        skipWhitelisted: true,
        ...autoOverride,
      },
      ...(whitelist ? { tokenWhitelist: whitelist } : {}),
    },
  });
}

function makeReport(verdict: SafetyVerdict, reasons: string[] = []): TokenSafetyReport {
  return {
    token: RANDOM_TOKEN,
    verdict,
    reasons,
    probeUsd: 5,
    probeNativeAmount: "0.00125",
    buyQuoted: true,
    buyOk: verdict !== "honeypot",
    sellQuoted: true,
    sellOk: verdict !== "honeypot",
    roundTripLossPct: verdict === "ok" ? 0.5 : verdict === "suspicious" ? 25 : 100,
    expectedTokenOut: "1000000",
    suspiciousLossPct: 20,
  } as unknown as TokenSafetyReport;
}

// ── pure helpers ─────────────────────────────────────────────

describe("verdictAction (pure)", () => {
  it("ok → ok", () => {
    expect(verdictAction("ok", true)).toBe("ok");
    expect(verdictAction("ok", false)).toBe("ok");
  });
  it("honeypot → block (regardless of failOnSuspicious)", () => {
    expect(verdictAction("honeypot", true)).toBe("block");
    expect(verdictAction("honeypot", false)).toBe("block");
  });
  it("suspicious → block when failOnSuspicious=true, warn otherwise", () => {
    expect(verdictAction("suspicious", true)).toBe("block");
    expect(verdictAction("suspicious", false)).toBe("warn");
  });
  it("unknown → warn (fail-open on infra outage)", () => {
    expect(verdictAction("unknown", true)).toBe("warn");
    expect(verdictAction("unknown", false)).toBe("warn");
  });
});

describe("isBaselineTrustedToken (pure)", () => {
  const profile = mockProfile();
  it("matches chain native sentinels", () => {
    expect(isBaselineTrustedToken(profile, "NATIVE")).toBe(true);
    expect(isBaselineTrustedToken(profile, "ETH")).toBe(true);
    // EVM zero-address is sometimes used as the native sentinel.
    expect(isBaselineTrustedToken(profile, "0x0000000000000000000000000000000000000000")).toBe(true);
  });
  it("matches chain canonical USDC + WETH (case-insensitive)", () => {
    expect(isBaselineTrustedToken(profile, USDC_BASE)).toBe(true);
    expect(isBaselineTrustedToken(profile, USDC_BASE.toUpperCase())).toBe(true);
    expect(isBaselineTrustedToken(profile, WETH_BASE)).toBe(true);
  });
  it("matches WBTC from the chain's well-known token list", () => {
    expect(isBaselineTrustedToken(profile, WBTC_BASE)).toBe(true);
  });
  it("rejects random addresses", () => {
    expect(isBaselineTrustedToken(profile, RANDOM_TOKEN)).toBe(false);
  });
  it("rejects WBTC on a chain that doesn't include it", () => {
    const profile2 = { ...profile, tokens: { WETH: WETH_BASE, USDC: USDC_BASE } };
    expect(isBaselineTrustedToken(profile2, WBTC_BASE)).toBe(false);
  });
});

describe("isOperatorWhitelisted (pure)", () => {
  it("returns false when no whitelist configured", () => {
    expect(isOperatorWhitelisted(buildConfig(), "base", RANDOM_TOKEN)).toBe(false);
  });
  it("matches lowercase + uppercase whitelist entries", () => {
    const cfg = buildConfig({}, { base: [RANDOM_TOKEN] });
    expect(isOperatorWhitelisted(cfg, "base", RANDOM_TOKEN)).toBe(true);
    expect(isOperatorWhitelisted(cfg, "base", RANDOM_TOKEN.toUpperCase())).toBe(true);
    expect(isOperatorWhitelisted(cfg, "BASE", RANDOM_TOKEN)).toBe(true);
  });
  it("rejects when the whitelist is for a DIFFERENT chain", () => {
    const cfg = buildConfig({}, { ethereum: [RANDOM_TOKEN] });
    expect(isOperatorWhitelisted(cfg, "base", RANDOM_TOKEN)).toBe(false);
  });
  it("rejects when whitelist is empty", () => {
    const cfg = buildConfig({}, { base: [] });
    expect(isOperatorWhitelisted(cfg, "base", RANDOM_TOKEN)).toBe(false);
  });
});

// ── DB cache layer ───────────────────────────────────────────

describe("token_safety_cache (DB layer)", () => {
  it("getCachedTokenVerdict returns null on cache miss", () => {
    expect(getCachedTokenVerdict("base", RANDOM_TOKEN)).toBeNull();
  });

  it("putCachedTokenVerdict + getCachedTokenVerdict round-trip", () => {
    putCachedTokenVerdict({
      chain: "base",
      tokenAddress: RANDOM_TOKEN,
      verdict: "ok",
      detailsJson: '{"reasons":["clean roundtrip"]}',
      probeUsd: 5,
      cacheTtlMs: 60_000,
    });
    const row = getCachedTokenVerdict("base", RANDOM_TOKEN)!;
    expect(row.verdict).toBe("ok");
    expect(row.token_address).toBe(RANDOM_TOKEN.toLowerCase());
    expect(row.chain).toBe("base");
    expect(row.probe_usd).toBe(5);
    expect(JSON.parse(row.details_json!).reasons).toEqual(["clean roundtrip"]);
    expect(Date.parse(row.checked_at)).toBeGreaterThan(0);
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.parse(row.checked_at));
  });

  it("case-insensitive on chain + address", () => {
    putCachedTokenVerdict({
      chain: "BASE",
      tokenAddress: RANDOM_TOKEN.toUpperCase(),
      verdict: "honeypot",
      detailsJson: null,
      probeUsd: 5,
      cacheTtlMs: 60_000,
    });
    expect(getCachedTokenVerdict("base", RANDOM_TOKEN.toLowerCase())!.verdict).toBe("honeypot");
    expect(getCachedTokenVerdict("Base", RANDOM_TOKEN)!.verdict).toBe("honeypot");
  });

  it("expired rows surface as cache-miss", () => {
    const pastTs = new Date(Date.now() - 60_000).toISOString();
    putCachedTokenVerdict({
      chain: "base",
      tokenAddress: RANDOM_TOKEN,
      verdict: "ok",
      detailsJson: null,
      probeUsd: 5,
      cacheTtlMs: -120_000, // already expired
    });
    expect(getCachedTokenVerdict("base", RANDOM_TOKEN, pastTs)).toBeNull();
    // Pass an explicit older "now" that's still before the expires_at to
    // verify the WHERE expires_at > ? gate.
    putCachedTokenVerdict({
      chain: "base",
      tokenAddress: RANDOM_TOKEN,
      verdict: "ok",
      detailsJson: null,
      probeUsd: 5,
      cacheTtlMs: 60_000,
    });
    expect(getCachedTokenVerdict("base", RANDOM_TOKEN)).not.toBeNull();
  });

  it("re-put on the same key replaces (INSERT OR REPLACE)", () => {
    putCachedTokenVerdict({
      chain: "base", tokenAddress: RANDOM_TOKEN, verdict: "ok",
      detailsJson: null, probeUsd: 5, cacheTtlMs: 60_000,
    });
    putCachedTokenVerdict({
      chain: "base", tokenAddress: RANDOM_TOKEN, verdict: "honeypot",
      detailsJson: null, probeUsd: 5, cacheTtlMs: 60_000,
    });
    expect(getCachedTokenVerdict("base", RANDOM_TOKEN)!.verdict).toBe("honeypot");
  });

  it("clearExpiredTokenVerdicts deletes only expired rows", () => {
    // Fresh row (won't be deleted)
    putCachedTokenVerdict({
      chain: "base", tokenAddress: RANDOM_TOKEN, verdict: "ok",
      detailsJson: null, probeUsd: 5, cacheTtlMs: 60_000,
    });
    // Expired row
    putCachedTokenVerdict({
      chain: "base",
      tokenAddress: "0x" + "11".repeat(20),
      verdict: "ok",
      detailsJson: null,
      probeUsd: 5,
      cacheTtlMs: -60_000,
    });
    const deleted = clearExpiredTokenVerdicts();
    expect(deleted).toBe(1);
    expect(listCachedTokenVerdicts().length).toBe(1);
  });
});

// ── checkTokenAtTradeTime integration ──────────────────────

describe("checkTokenAtTradeTime", () => {
  const profile = mockProfile();
  const baseCtx = () => ({
    chain: "base",
    profile,
    tokenAddress: RANDOM_TOKEN,
    logger: stubLogger,
    publicClient: STUB_CLIENT,
    walletAddress: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  });

  it("feature disabled → action=skip, no probe", async () => {
    const cfg = configSchema.parse({ safety: { autoTokenCheck: { enabled: false } } });
    const probeFn = vi.fn();
    const d = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/disabled/);
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("config omitted → action=skip (autoTokenCheck is optional, schema default = undefined)", async () => {
    const cfg = configSchema.parse({});
    const probeFn = vi.fn();
    const d = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(d.action).toBe("skip");
  });

  it("baseline-trusted (USDC) → skip, no probe", async () => {
    const probeFn = vi.fn();
    const d = await checkTokenAtTradeTime({
      ...baseCtx(),
      tokenAddress: USDC_BASE,
      config: buildConfig(),
      probeFn,
    });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/baseline-trusted/);
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("operator whitelist match → skip when skipWhitelisted=true", async () => {
    const cfg = buildConfig({ skipWhitelisted: true }, { base: [RANDOM_TOKEN] });
    const probeFn = vi.fn();
    const d = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/whitelist/i);
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("operator whitelist match → probe when skipWhitelisted=false", async () => {
    const cfg = buildConfig({ skipWhitelisted: false }, { base: [RANDOM_TOKEN] });
    const probeFn = vi.fn(async () => makeReport("ok"));
    const d = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(d.action).toBe("ok");
    expect(d.fromCache).toBe(false);
  });

  it("cache miss → probe → cache write → cache hit on second call", async () => {
    const cfg = buildConfig();
    const probeFn = vi.fn(async () => makeReport("ok"));
    const d1 = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(d1.action).toBe("ok");
    expect(d1.fromCache).toBe(false);
    expect(probeFn).toHaveBeenCalledTimes(1);

    // Second call should hit the cache.
    const d2 = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(d2.action).toBe("ok");
    expect(d2.fromCache).toBe(true);
    expect(probeFn).toHaveBeenCalledTimes(1); // unchanged
  });

  it("honeypot verdict → action=block (regardless of failOnSuspicious)", async () => {
    const cfg = buildConfig({ failOnSuspicious: false });
    const probeFn = vi.fn(async () => makeReport("honeypot", ["sell reverted"]));
    const d = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(d.action).toBe("block");
    expect(d.verdict).toBe("honeypot");
  });

  it("suspicious + failOnSuspicious=true → block", async () => {
    const cfg = buildConfig({ failOnSuspicious: true });
    const probeFn = vi.fn(async () => makeReport("suspicious", ["25% tax"]));
    const d = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(d.action).toBe("block");
    expect(d.verdict).toBe("suspicious");
  });

  it("suspicious + failOnSuspicious=false → warn (no block)", async () => {
    const cfg = buildConfig({ failOnSuspicious: false });
    const probeFn = vi.fn(async () => makeReport("suspicious", ["25% tax"]));
    const d = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(d.action).toBe("warn");
  });

  it("probe throws → fail-open (verdict=unknown, action=warn, NOT cached)", async () => {
    const cfg = buildConfig();
    const probeFn = vi.fn(async () => {
      throw new Error("aggregator timed out");
    });
    const d = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(d.action).toBe("warn");
    expect(d.verdict).toBe("unknown");
    expect(d.reason).toMatch(/probe failed/);
    // Critical: the unknown verdict should NOT be cached (next trade
    // could succeed if upstream recovers).
    expect(getCachedTokenVerdict("base", RANDOM_TOKEN)).toBeNull();
  });

  it("unknown verdict from a successful probe → cached + action=warn", async () => {
    // Distinct from the "probe throws" path: probe succeeded but returned
    // verdict=unknown (e.g. illiquid token, no quote). We cache it so we
    // don't re-probe a known-illiquid token every trade.
    const cfg = buildConfig();
    const probeFn = vi.fn(async () => makeReport("unknown", ["no liquidity"]));
    const d = await checkTokenAtTradeTime({ ...baseCtx(), config: cfg, probeFn });
    expect(d.action).toBe("warn");
    expect(d.verdict).toBe("unknown");
    expect(getCachedTokenVerdict("base", RANDOM_TOKEN)?.verdict).toBe("unknown");
  });

  it("verdict from cache reflects the original failOnSuspicious flag at check time", async () => {
    // Cache a "suspicious" verdict from a prior probe.
    putCachedTokenVerdict({
      chain: "base", tokenAddress: RANDOM_TOKEN, verdict: "suspicious",
      detailsJson: '{"reasons":["25% tax"]}', probeUsd: 5, cacheTtlMs: 60_000,
    });
    // First check: failOnSuspicious=true → block.
    const d1 = await checkTokenAtTradeTime({
      ...baseCtx(),
      config: buildConfig({ failOnSuspicious: true }),
    });
    expect(d1.action).toBe("block");
    expect(d1.fromCache).toBe(true);
    // Second check: failOnSuspicious=false → warn (same cached verdict).
    const d2 = await checkTokenAtTradeTime({
      ...baseCtx(),
      config: buildConfig({ failOnSuspicious: false }),
    });
    expect(d2.action).toBe("warn");
    expect(d2.fromCache).toBe(true);
  });
});

// ── enforceTokenSafety wrapper ─────────────────────────────

describe("enforceTokenSafety (throwing wrapper)", () => {
  const profile = mockProfile();
  const baseCtx = () => ({
    chain: "base",
    profile,
    tokenAddress: RANDOM_TOKEN,
    logger: stubLogger,
    publicClient: STUB_CLIENT,
    walletAddress: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    side: "input" as const,
  });

  it("ok / skip / warn → no throw", async () => {
    const cfg = buildConfig({ failOnSuspicious: false });
    const okFn = vi.fn(async () => makeReport("ok"));
    await expect(
      enforceTokenSafety({ ...baseCtx(), config: cfg, probeFn: okFn }),
    ).resolves.toMatchObject({ action: "ok" });

    const unknownFn = vi.fn(async () => makeReport("unknown"));
    await expect(
      enforceTokenSafety({ ...baseCtx(), tokenAddress: "0x" + "22".repeat(20), config: cfg, probeFn: unknownFn }),
    ).resolves.toMatchObject({ action: "warn" });
  });

  it("honeypot → throws TOKEN_BLOCKED with structured details", async () => {
    const cfg = buildConfig();
    const probeFn = vi.fn(async () => makeReport("honeypot", ["sell reverted"]));
    await expect(
      enforceTokenSafety({ ...baseCtx(), config: cfg, probeFn }),
    ).rejects.toMatchObject({
      code: "TOKEN_BLOCKED",
      details: {
        chain: "base",
        side: "input",
        token: RANDOM_TOKEN,
        verdict: "honeypot",
        autoTokenCheck: true,
      },
    });
  });

  it("suspicious + failOnSuspicious=true → throws", async () => {
    const cfg = buildConfig({ failOnSuspicious: true });
    const probeFn = vi.fn(async () => makeReport("suspicious"));
    await expect(
      enforceTokenSafety({ ...baseCtx(), config: cfg, probeFn }),
    ).rejects.toMatchObject({ code: "TOKEN_BLOCKED", details: { verdict: "suspicious" } });
  });

  it("blocks attach nextActions[] pointing at the manual check command", async () => {
    const cfg = buildConfig();
    const probeFn = vi.fn(async () => makeReport("honeypot"));
    try {
      await enforceTokenSafety({ ...baseCtx(), config: cfg, probeFn });
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as { nextActions?: Array<{ tool: string; params: Record<string, unknown> }> };
      expect(err.nextActions).toBeDefined();
      expect(err.nextActions!.length).toBe(1);
      expect(err.nextActions![0].tool).toBe("check_token");
      expect(err.nextActions![0].params).toMatchObject({
        chain: "base",
        address: RANDOM_TOKEN,
      });
    }
  });

  it("the `side` label flows into the error message + details", async () => {
    const cfg = buildConfig();
    const probeFn = vi.fn(async () => makeReport("honeypot"));
    await expect(
      enforceTokenSafety({ ...baseCtx(), side: "output", config: cfg, probeFn }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("output"),
      details: { side: "output" },
    });
  });
});
