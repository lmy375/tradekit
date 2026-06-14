/**
 * Safety-posture tests (v51). Verdict + gap severity pinned one rule at
 * a time: critical = the stack is off OR there's no USD ceiling at all,
 * warn = loose slippage / infinite approvals / no token safety, info =
 * the "nice to have" omissions. The inventory half (guardrails[]) is
 * checked for the active values it renders.
 *
 * Pure + deterministic: configs are built from configSchema.parse({})
 * defaults and spread-overridden — no IO, no clock except the injected
 * stamp.
 */

import { describe, it, expect } from "vitest";
import { configSchema, type Config } from "./config.js";
import { reviewSafety, renderSafetyReview, safetyPromoteBlocker, LOOSE_SLIPPAGE_BPS } from "./safetyReview.js";

const NOW = new Date("2026-06-14T12:00:00Z");
const base = configSchema.parse({});

/** Build a config whose .safety is the defaults plus overrides. */
function cfg(overrides: Partial<Config["safety"]> = {}): Config {
  return { ...base, safety: { ...base.safety, ...overrides } } as Config;
}

const review = (overrides: Partial<Config["safety"]> = {}) =>
  reviewSafety(cfg(overrides), { now: NOW });

function gap(r: ReturnType<typeof review>, key: string) {
  return r.gaps.find((g) => g.key === key) ?? null;
}
function rail(r: ReturnType<typeof review>, key: string) {
  return r.guardrails.find((g) => g.key === key)!;
}

describe("verdict tiers", () => {
  it("defaults (no USD ceiling) → exposed via the USD-ceiling critical", () => {
    const r = review();
    expect(r.verdict).toBe("exposed");
    expect(gap(r, "usdCeiling")?.severity).toBe("critical");
  });

  it("safety disabled → exposed with a master-switch critical", () => {
    const r = review({ enabled: false });
    expect(r.verdict).toBe("exposed");
    expect(gap(r, "enabled")?.severity).toBe("critical");
    expect(rail(r, "enabled").state).toBe("off");
  });

  it("USD ceiling set but loose slippage → moderate (warn, no critical)", () => {
    const r = review({ perTxUsdLimit: 100, maxSlippageBps: LOOSE_SLIPPAGE_BPS, tokenBlacklist: { base: ["0xabc"] } });
    expect(r.counts.critical).toBe(0);
    expect(r.verdict).toBe("moderate");
    expect(gap(r, "maxSlippageBps")?.severity).toBe("warn");
  });

  it("well-locked-down config → hardened with zero gaps above info", () => {
    const r = review({
      perTxUsdLimit: 100,
      dailyUsdLimit: 1000,
      maxSlippageBps: 200,
      tokenWhitelist: { base: ["0xaaa", "0xbbb"] },
      maxApprovalUsdLimit: 500,
      gas: { maxGasPctOfTrade: 10 },
      minTradeIntervalMs: 60_000,
      positionCaps: [{ pattern: "playbook:*", token: "WETH", maxBaseAmount: 1 }],
      drawdownCircuitBreaker: { enabled: true, maxDrawdownPct: 15, autoResumeAtPct: null, scope: "global" },
      tradeApproval: { enabled: true, thresholdUsd: 100, expiresMinutes: 60 },
    });
    expect(r.counts.critical).toBe(0);
    expect(r.counts.warn).toBe(0);
    expect(r.verdict).toBe("hardened");
  });
});

describe("spend ceiling (critical)", () => {
  it("a single USD limit clears the ceiling critical", () => {
    expect(gap(review({ perTxUsdLimit: 50 }), "usdCeiling")).toBeNull();
    expect(gap(review({ dailyUsdLimit: 500 }), "usdCeiling")).toBeNull();
  });

  it("renders the active limit values in the inventory", () => {
    const r = review({ perTxUsdLimit: 250, dailyUsdLimit: 2000 });
    expect(rail(r, "perTxUsdLimit").detail).toMatch(/\$250\/tx/);
    expect(rail(r, "dailyUsdLimit").detail).toMatch(/\$2000\/day/);
  });
});

describe("token safety (warn → info)", () => {
  it("no list + no probe → warn", () => {
    const r = review({ perTxUsdLimit: 10 }); // clear the USD critical to isolate
    expect(gap(r, "tokenSafety")?.severity).toBe("warn");
  });

  it("honeypot probe on but no lists → downgrades to info", () => {
    const r = review({
      perTxUsdLimit: 10,
      autoTokenCheck: { enabled: true, cacheTtlMs: 86_400_000, failOnSuspicious: true, probeUsd: 5, skipWhitelisted: true },
    });
    expect(gap(r, "tokenSafety")?.severity).toBe("info");
    expect(rail(r, "autoTokenCheck").state).toBe("active");
  });

  it("a whitelist clears the token-safety gap entirely", () => {
    const r = review({ perTxUsdLimit: 10, tokenWhitelist: { base: ["0xaaa"] } });
    expect(gap(r, "tokenSafety")).toBeNull();
    expect(rail(r, "tokenWhitelist").detail).toMatch(/1 token\(s\) across 1 chain\(s\)/);
  });
});

describe("approvals", () => {
  it("infinite approvals permitted → warn + inventory shows it off", () => {
    const r = review({ perTxUsdLimit: 10, tokenBlacklist: { base: ["0x1"] }, allowInfiniteApprovals: true });
    expect(gap(r, "allowInfiniteApprovals")?.severity).toBe("warn");
    expect(rail(r, "allowInfiniteApprovals").state).toBe("off");
  });

  it("default (infinite blocked) → no gap + inventory active", () => {
    const r = review({ perTxUsdLimit: 10 });
    expect(gap(r, "allowInfiniteApprovals")).toBeNull();
    expect(rail(r, "allowInfiniteApprovals").state).toBe("active");
  });
});

describe("info-level omissions each produce one gap with a fix", () => {
  it("gas / rate / exposure / drawdown / approval gate / approval cap", () => {
    const r = review({ perTxUsdLimit: 10, tokenBlacklist: { base: ["0x1"] } });
    for (const key of ["gasBudget", "minTradeIntervalMs", "exposureCaps", "drawdownCircuitBreaker", "tradeApproval", "maxApprovalUsdLimit"]) {
      const x = gap(r, key);
      expect(x, key).not.toBeNull();
      expect(x!.severity).toBe("info");
      expect(x!.fix.length).toBeGreaterThan(0);
    }
  });
});

describe("concentration limit (v72)", () => {
  it("is a gap (info) when unset; the guardrail reads off", () => {
    const r = review({ perTxUsdLimit: 10, tokenBlacklist: { base: ["0x1"] } });
    expect(rail(r, "maxConcentration").state).toBe("off");
    const g = gap(r, "concentration");
    expect(g).not.toBeNull();
    expect(g!.severity).toBe("info");
    expect(g!.finding).toMatch(/cross-strategy blind spot/);
  });

  it("is active + no gap once configured", () => {
    const r = review({ perTxUsdLimit: 10, maxConcentrationPct: 50 });
    expect(rail(r, "maxConcentration").state).toBe("active");
    expect(rail(r, "maxConcentration").detail).toMatch(/50%/);
    expect(gap(r, "concentration")).toBeNull();
  });
});

describe("MEV protection guardrail (v77)", () => {
  it("is a gap (info) + reads off when no private relay is configured", () => {
    const r = review({ perTxUsdLimit: 10 });
    expect(rail(r, "mevProtection").state).toBe("off");
    const g = gap(r, "mevProtection");
    expect(g).not.toBeNull();
    expect(g!.severity).toBe("info");
    expect(g!.finding).toMatch(/sandwich/i);
  });
});

describe("safetyPromoteBlocker — the v52 promote gate", () => {
  it("blocks on a critical gap (no USD ceiling), naming the finding + fix", () => {
    const blocker = safetyPromoteBlocker(review());
    expect(blocker).not.toBeNull();
    expect(blocker).toMatch(/not adequately guarded/);
    expect(blocker).toMatch(/USD ceiling/);
    expect(blocker).toMatch(/fix:/);
  });

  it("blocks when safety is disabled", () => {
    expect(safetyPromoteBlocker(review({ enabled: false }))).toMatch(/bypassed/);
  });

  it("does NOT block on warn-only posture (loose slippage, infinite approvals)", () => {
    const r = review({ perTxUsdLimit: 100, maxSlippageBps: LOOSE_SLIPPAGE_BPS, allowInfiniteApprovals: true, tokenBlacklist: { base: ["0x1"] } });
    expect(r.verdict).toBe("moderate");
    expect(safetyPromoteBlocker(r)).toBeNull();
  });

  it("does NOT block a hardened wallet", () => {
    const r = review({ perTxUsdLimit: 100, tokenBlacklist: { base: ["0x1"] } });
    expect(safetyPromoteBlocker(r)).toBeNull();
  });
});

describe("counts + rendering", () => {
  it("counts active vs total guardrails and gap severities", () => {
    const r = review();
    expect(r.counts.totalGuardrails).toBe(r.guardrails.length);
    expect(r.counts.activeGuardrails).toBe(r.guardrails.filter((g) => g.state === "active").length);
    expect(r.counts.critical + r.counts.warn + r.counts.info).toBe(r.gaps.length);
  });

  it("renders verdict, gap fixes, and the active-protections list", () => {
    const text = renderSafetyReview(review({ perTxUsdLimit: 100, allowInfiniteApprovals: true, tokenBlacklist: { base: ["0x1"] } }));
    expect(text).toMatch(/Safety posture — /);
    expect(text).toMatch(/guardrails active/);
    expect(text).toMatch(/fix: /);
    expect(text).toMatch(/Active protections:/);
  });
});
