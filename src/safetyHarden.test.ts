/**
 * Safety-hardening plan tests (v93). The plan fills guardrail GAPS with safe
 * defaults, leaves already-configured guardrails untouched, and surfaces
 * scale-specific USD limits as still-needed unless the operator supplied them.
 * Pure — configs from configSchema.parse({}).
 */

import { describe, it, expect } from "vitest";
import { configSchema, setConfigPath, type Config } from "./config.js";
import { buildHardeningPlan, HARDENING_DEFAULTS } from "./safetyHarden.js";

const base = configSchema.parse({});
const cfg = (over: Partial<Config["safety"]> = {}): Config =>
  ({ ...base, safety: { ...base.safety, ...over } }) as Config;

function change(plan: ReturnType<typeof buildHardeningPlan>, path: string) {
  return plan.changes.find((c) => c.path === path);
}

describe("buildHardeningPlan", () => {
  it("a fresh config gets the structural defaults recommended", () => {
    const plan = buildHardeningPlan(cfg());
    expect(change(plan, "safety.drawdownCircuitBreaker")!.recommended).toMatchObject({ enabled: true, maxDrawdownPct: HARDENING_DEFAULTS.maxDrawdownPct });
    expect(change(plan, "safety.maxConcentrationPct")!.recommended).toBe(HARDENING_DEFAULTS.maxConcentrationPct);
    expect(change(plan, "safety.transferAllowlistOnly")!.recommended).toBe(true);
  });

  it("USD limits land in stillNeeded without flags, become changes with flags", () => {
    const without = buildHardeningPlan(cfg());
    expect(without.stillNeeded.map((n) => n.path)).toContain("safety.perTxUsdLimit");
    expect(change(without, "safety.perTxUsdLimit")).toBeUndefined();

    const withFlags = buildHardeningPlan(cfg(), { perTradeUsd: 500, dailyUsd: 2000, maxStrategyLossUsd: 300 });
    expect(change(withFlags, "safety.perTxUsdLimit")!.recommended).toBe(500);
    expect(change(withFlags, "safety.dailyUsdLimit")!.recommended).toBe(2000);
    expect(change(withFlags, "safety.maxStrategyLossUsd")!.recommended).toBe(300);
    expect(withFlags.stillNeeded).toHaveLength(0);
  });

  it("FILLS GAPS ONLY — already-configured guardrails are left untouched", () => {
    const plan = buildHardeningPlan(
      cfg({
        drawdownCircuitBreaker: { enabled: true, maxDrawdownPct: 10, autoResumeAtPct: null, scope: "global" },
        maxConcentrationPct: 70,
        transferAllowlistOnly: true,
        perTxUsdLimit: 999,
      }),
      { perTradeUsd: 500 },
    );
    expect(change(plan, "safety.drawdownCircuitBreaker")).toBeUndefined();
    expect(change(plan, "safety.maxConcentrationPct")).toBeUndefined();
    expect(change(plan, "safety.transferAllowlistOnly")).toBeUndefined();
    // operator's own perTxUsdLimit is NOT overwritten by the flag
    expect(change(plan, "safety.perTxUsdLimit")).toBeUndefined();
    expect(plan.alreadyHardened).toEqual(expect.arrayContaining([
      "safety.drawdownCircuitBreaker", "safety.maxConcentrationPct", "safety.transferAllowlistOnly", "safety.perTxUsdLimit",
    ]));
  });

  it("recommends turning OFF infinite approvals when they're enabled", () => {
    const plan = buildHardeningPlan(cfg({ allowInfiniteApprovals: true }));
    expect(change(plan, "safety.allowInfiniteApprovals")!.recommended).toBe(false);
  });

  it("an already-hardened config yields no changes", () => {
    const plan = buildHardeningPlan(
      cfg({
        drawdownCircuitBreaker: { enabled: true, maxDrawdownPct: 20, autoResumeAtPct: null, scope: "global" },
        maxConcentrationPct: 50,
        transferAllowlistOnly: true,
        allowInfiniteApprovals: false,
        perTxUsdLimit: 500,
        dailyUsdLimit: 2000,
        maxStrategyLossUsd: 300,
      }),
    );
    expect(plan.changes).toHaveLength(0);
    expect(plan.stillNeeded).toHaveLength(0);
  });

  it("the recommended config is schema-valid (applies cleanly)", () => {
    // Every recommended value must pass configSchema when set — catch a bad default.
    let next = cfg();
    for (const c of buildHardeningPlan(cfg(), { perTradeUsd: 500, dailyUsd: 2000, maxStrategyLossUsd: 300 }).changes) {
      next = setConfigPath(next, c.path, c.recommended);
    }
    expect(() => configSchema.parse(next)).not.toThrow();
  });
});
