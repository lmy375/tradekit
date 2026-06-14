// Iter630: tests for the pure combinePreflightVerdict combiner. The
// orchestrator (runPreflight) is RPC + DB bound — covered indirectly via
// CLI smoke tests. Here we pin the priority-ranked decision tree across
// every combination an agent's branching code would see.

import { describe, expect, it } from "vitest";
import { combinePreflightVerdict } from "./preflight.js";
import type { TradePreviewReport } from "./tradePreview.js";
import type { TokenSafetyReport } from "./tokenSafety.js";
import type { PriceCrossCheck } from "./priceCrossCheck.js";
import type { Address } from "viem";

// ── fixture builders ───────────────────────────────────────

function makePreview(overrides?: {
  passes?: boolean;
  rejection?: { code: string; message: string };
  gasPctOfInput?: number | null;
  balanceFractionPct?: number;
  hasSufficientAllowance?: boolean;
  marketContext?: TradePreviewReport["marketContext"];
}): TradePreviewReport {
  return {
    ...(overrides?.marketContext ? { marketContext: overrides.marketContext } : {}),
    chain: "base",
    direction: "buy",
    baseToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address,
    baseSymbol: "ETH",
    quoteToken: "0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
    quoteSymbol: "USDC",
    provider: "kyberswap",
    to: "0xabcdef" as Address,
    allowanceTarget: "0xabcdef" as Address,
    metrics: {
      amountIn: "1.0",
      amountOut: "3000",
      amountOutMinimum: "2985",
      inputUsd: 3000,
      outputUsd: 3000,
      outputUsdFloor: 2985,
      slippageCushionBps: 50,
      effectivePrice: 3000,
      estimatedGasNative: "0.001",
      estimatedGasUsd: 3,
      gasPctOfInput: overrides?.gasPctOfInput ?? 0.1,
      walletBalance: "10",
      balanceFractionPct: overrides?.balanceFractionPct ?? 10,
      currentAllowance: "infinite",
      hasSufficientAllowance: overrides?.hasSufficientAllowance ?? true,
    },
    safety: overrides?.passes === false
      ? { passes: false, rejection: { code: overrides?.rejection?.code ?? "SLIPPAGE_TOO_HIGH", message: overrides?.rejection?.message ?? "x" } }
      : { passes: true },
    timestamp: "2026-05-29T00:00:00Z",
  };
}

function makeTokenSafety(verdict: TokenSafetyReport["verdict"]): TokenSafetyReport {
  return {
    chain: "base",
    token: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address,
    symbol: "TOK",
    decimals: 18,
    probeUsd: 10,
    probeNativeAmount: "0.003",
    buyQuoted: true,
    buySimulated: true,
    sellQuoted: verdict !== "honeypot",
    sellSimulated: verdict !== "honeypot",
    roundTripLossPct: verdict === "suspicious" ? 30 : 5,
    suspiciousLossPct: 20,
    verdict,
    reasons: ["x"],
    timestamp: "2026-05-29T00:00:00Z",
  };
}

function makePriceCrossCheck(verdict: PriceCrossCheck["verdict"], pct?: number): PriceCrossCheck {
  return {
    token: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    coinGeckoPrice: 1.0,
    dexScreenerPrice: verdict === "ok" ? 1.0 : verdict === "suspicious" ? 1.08 : 1.5,
    absoluteDiff: pct ?? null,
    divergencePct: pct ?? null,
    tolerancePct: 5,
    extremePct: 20,
    verdict,
    reason: "x",
    timestamp: "2026-05-29T00:00:00Z",
  };
}

// ── verdict combiner ──────────────────────────────────────

describe("combinePreflightVerdict — go path", () => {
  it("all-ok inputs → go", () => {
    const r = combinePreflightVerdict({
      preview: makePreview(),
      tokenSafety: makeTokenSafety("ok"),
      priceCrossCheck: makePriceCrossCheck("ok"),
      history: { sampleSize: 10, medianSlippageBps: 20, p95SlippageBps: 50 },
    });
    expect(r.verdict).toBe("go");
    expect(r.reasons.find((x) => x.code === "preview_ok")).toBeDefined();
    expect(r.reasons.find((x) => x.code === "token_ok")).toBeDefined();
    expect(r.reasons.find((x) => x.code === "price_ok")).toBeDefined();
    expect(r.reasons.find((x) => x.code === "history_ok")).toBeDefined();
  });

  it("empty input → go (no signals = no objection)", () => {
    const r = combinePreflightVerdict({});
    expect(r.verdict).toBe("go");
    expect(r.reasons.length).toBe(0);
  });

  it("approval_needed is info-level — doesn't change verdict from go", () => {
    const r = combinePreflightVerdict({
      preview: makePreview({ hasSufficientAllowance: false }),
      tokenSafety: makeTokenSafety("ok"),
    });
    expect(r.verdict).toBe("go");
    expect(r.reasons.find((x) => x.code === "approval_needed")).toBeDefined();
  });
});

describe("combinePreflightVerdict — market timing (v69)", () => {
  const mc = (timing: "favorable" | "neutral" | "caution", notes: string[] = []): TradePreviewReport["marketContext"] => ({
    windowDays: 7,
    coinId: "ethereum",
    currentPriceUsd: 3000,
    rangePositionPct: timing === "caution" ? 95 : timing === "favorable" ? 5 : 50,
    changePctWindow: 10,
    changePct24h: 1,
    volatilityPct: 4,
    summary: "$3,000 · +10% over 7d",
    timing,
    notes,
  });

  it("caution timing → verdict caution (advice nudges, never blocks)", () => {
    const r = combinePreflightVerdict({
      preview: makePreview({ marketContext: mc("caution", ["buying near the 7d high (95% of range) — chasing the top"]) }),
      tokenSafety: makeTokenSafety("ok"),
    });
    expect(r.verdict).toBe("caution");
    const reason = r.reasons.find((x) => x.code === "market_timing_caution");
    expect(reason).toBeDefined();
    expect(reason!.severity).toBe("warn");
    expect(reason!.source).toBe("market_timing");
    expect(reason!.message).toMatch(/chasing the top/);
  });

  it("favorable timing → still go, recorded info-level", () => {
    const r = combinePreflightVerdict({
      preview: makePreview({ marketContext: mc("favorable", ["near the 7d low — favorable entry zone"]) }),
      tokenSafety: makeTokenSafety("ok"),
    });
    expect(r.verdict).toBe("go");
    const reason = r.reasons.find((x) => x.code === "market_timing_ok");
    expect(reason).toBeDefined();
    expect(reason!.severity).toBe("info");
  });

  it("neutral timing → go, info-level", () => {
    const r = combinePreflightVerdict({ preview: makePreview({ marketContext: mc("neutral") }) });
    expect(r.verdict).toBe("go");
    expect(r.reasons.find((x) => x.code === "market_timing_ok")).toBeDefined();
  });

  it("absent market context → no market_timing reason at all", () => {
    const r = combinePreflightVerdict({ preview: makePreview() });
    expect(r.reasons.find((x) => x.source === "market_timing")).toBeUndefined();
  });

  it("a caution timing does NOT override a critical finding (still no_go)", () => {
    const r = combinePreflightVerdict({
      preview: makePreview({ marketContext: mc("caution") }),
      tokenSafety: makeTokenSafety("honeypot"),
    });
    expect(r.verdict).toBe("no_go");
  });
});

describe("combinePreflightVerdict — no_go path (critical findings)", () => {
  it("token honeypot → no_go", () => {
    const r = combinePreflightVerdict({
      tokenSafety: makeTokenSafety("honeypot"),
    });
    expect(r.verdict).toBe("no_go");
    expect(r.reasons[0].code).toBe("token_honeypot");
    expect(r.reasons[0].severity).toBe("critical");
  });

  it("price extreme divergence → no_go", () => {
    const r = combinePreflightVerdict({
      priceCrossCheck: makePriceCrossCheck("extreme", 50),
    });
    expect(r.verdict).toBe("no_go");
    expect(r.reasons.find((x) => x.code === "price_extreme_divergence")?.severity).toBe("critical");
  });

  it("preview safety failed → no_go", () => {
    const r = combinePreflightVerdict({
      preview: makePreview({ passes: false }),
    });
    expect(r.verdict).toBe("no_go");
    expect(r.reasons.find((x) => x.code === "preview_safety_failed")?.severity).toBe("critical");
  });

  it("multiple criticals all reported (not just the first)", () => {
    const r = combinePreflightVerdict({
      preview: makePreview({ passes: false }),
      tokenSafety: makeTokenSafety("honeypot"),
      priceCrossCheck: makePriceCrossCheck("extreme", 30),
    });
    expect(r.verdict).toBe("no_go");
    const criticals = r.reasons.filter((x) => x.severity === "critical");
    expect(criticals.length).toBe(3);
  });

  // v54: a configured execution limit that would reject the trade is a
  // no_go even when the cheap safety subset (slippage+tokens) passes.
  it("limit projection would reject → no_go with limit_would_reject", () => {
    const r = combinePreflightVerdict({
      preview: {
        ...makePreview(), // safety.passes = true
        limits: {
          admissible: false,
          checks: [{ name: "strategy_budget", label: "Per-strategy budget", passes: false, code: "STRATEGY_BUDGET_EXCEEDED", message: "over the lifetime cap" }],
          blocking: [{ name: "strategy_budget", label: "Per-strategy budget", passes: false, code: "STRATEGY_BUDGET_EXCEEDED", message: "over the lifetime cap" }],
        },
      },
    });
    expect(r.verdict).toBe("no_go");
    const reason = r.reasons.find((x) => x.code === "limit_would_reject");
    expect(reason?.severity).toBe("critical");
    expect(reason?.message).toMatch(/Per-strategy budget.*STRATEGY_BUDGET_EXCEEDED/);
  });

  it("admissible limit projection adds no limit_would_reject reason", () => {
    const r = combinePreflightVerdict({
      preview: { ...makePreview(), limits: { admissible: true, checks: [{ name: "core_safety", label: "x", passes: true }], blocking: [] } },
    });
    expect(r.reasons.some((x) => x.code === "limit_would_reject")).toBe(false);
  });
});

describe("combinePreflightVerdict — caution path (warn findings)", () => {
  it("token suspicious → caution", () => {
    const r = combinePreflightVerdict({
      tokenSafety: makeTokenSafety("suspicious"),
    });
    expect(r.verdict).toBe("caution");
    expect(r.reasons.find((x) => x.code === "token_suspicious")?.severity).toBe("warn");
  });

  it("price suspicious divergence → caution", () => {
    const r = combinePreflightVerdict({
      priceCrossCheck: makePriceCrossCheck("suspicious", 8),
    });
    expect(r.verdict).toBe("caution");
  });

  it("high realized slippage history (>100 bps median) → caution", () => {
    const r = combinePreflightVerdict({
      history: { sampleSize: 10, medianSlippageBps: 150, p95SlippageBps: 300 },
    });
    expect(r.verdict).toBe("caution");
    expect(r.reasons.find((x) => x.code === "high_realized_slippage_history")).toBeDefined();
  });

  it("gas_pct_high > 10% → caution", () => {
    const r = combinePreflightVerdict({
      preview: makePreview({ gasPctOfInput: 15 }),
    });
    expect(r.verdict).toBe("caution");
    expect(r.reasons.find((x) => x.code === "gas_pct_high")).toBeDefined();
  });

  it("gas_pct_high <= 10% → still go", () => {
    const r = combinePreflightVerdict({
      preview: makePreview({ gasPctOfInput: 5 }),
    });
    expect(r.verdict).toBe("go");
    expect(r.reasons.find((x) => x.code === "gas_pct_high")).toBeUndefined();
  });
});

describe("combinePreflightVerdict — severity priority", () => {
  it("critical wins over warn", () => {
    const r = combinePreflightVerdict({
      tokenSafety: makeTokenSafety("honeypot"), // critical
      priceCrossCheck: makePriceCrossCheck("suspicious", 8), // warn
    });
    expect(r.verdict).toBe("no_go");
  });

  it("warn wins over info", () => {
    const r = combinePreflightVerdict({
      tokenSafety: makeTokenSafety("suspicious"), // warn
      preview: makePreview({ hasSufficientAllowance: false }), // info
    });
    expect(r.verdict).toBe("caution");
  });

  it("balance_fraction_high > 50% is info — doesn't trigger caution", () => {
    const r = combinePreflightVerdict({
      preview: makePreview({ balanceFractionPct: 75 }),
    });
    expect(r.verdict).toBe("go");
    expect(r.reasons.find((x) => x.code === "balance_fraction_high")?.severity).toBe("info");
  });
});

describe("combinePreflightVerdict — skipped checks", () => {
  it("error sentinels produce check_skipped reasons but don't change verdict", () => {
    const r = combinePreflightVerdict({
      preview: { error: "skipped" } as { error: string },
      tokenSafety: { error: "skipped" } as { error: string },
      priceCrossCheck: { error: "skipped" } as { error: string },
      history: { error: "skipped" } as { error: string },
    });
    expect(r.verdict).toBe("go");
    expect(r.reasons.filter((x) => x.code === "check_skipped").length).toBe(4);
  });

  it("partial check set — only ran checks contribute", () => {
    const r = combinePreflightVerdict({
      tokenSafety: makeTokenSafety("ok"),
      priceCrossCheck: { error: "rate limited" } as { error: string },
    });
    expect(r.verdict).toBe("go");
    expect(r.reasons.find((x) => x.code === "token_ok")).toBeDefined();
    expect(r.reasons.find((x) => x.code === "check_skipped")).toBeDefined();
  });
});
