/**
 * Risk-posture synthesis tests (v78). The combiner is the load-bearing logic:
 * fold exposure headroom + concentration + unprotected value + MEV into ONE
 * verdict (ok/elevated/critical) + ranked concerns. Pure — synthetic component
 * inputs, no IO.
 */

import { describe, it, expect } from "vitest";
import { combineRiskPosture, UNPROTECTED_ELEVATED_FRAC } from "./riskPosture.js";
import type { SafetyHeadroomReport } from "./safetyHeadroom.js";
import type { ConcentrationRisk } from "./portfolio.js";
import type { MevExposure } from "./mev.js";

function headroom(entries: Array<{ status: string; label?: string; detail?: string }>): SafetyHeadroomReport {
  return {
    generatedAt: "2026-06-14T00:00:00Z",
    account: "default",
    chain: "base",
    entries: entries.map((e, i) => ({
      key: `k${i}`,
      label: e.label ?? "Limit",
      scope: "x",
      limit: 100,
      used: 0,
      remaining: 100,
      utilizationPct: 0,
      status: e.status as SafetyHeadroomReport["entries"][number]["status"],
      detail: e.detail ?? "detail",
    })),
    binding: null,
    counts: { ok: 0, approaching: 0, exhausted: 0, tripped: 0 },
  };
}
const conc = (verdict: "ok" | "warn" | "unconfigured"): ConcentrationRisk => ({
  thresholdPct: 50, verdict, largestPct: 80, largestSymbol: "WETH",
  breaches: verdict === "warn" ? [{ symbol: "WETH", percentOfPortfolio: 80, overByPct: 30 }] : [],
  summary: verdict === "warn" ? "CONCENTRATED: WETH 80%" : "ok",
});
const mev = (exposed: boolean): MevExposure => ({
  chain: "ethereum", protected: !exposed, sandwichRisk: "high", exposed, advisory: exposed ? "exposed" : "protected",
});

describe("combineRiskPosture", () => {
  it("no signals problematic → verdict ok", () => {
    const r = combineRiskPosture({ headroom: headroom([{ status: "ok" }]), concentration: conc("ok"), mev: mev(false) });
    expect(r.verdict).toBe("ok");
    expect(r.concerns).toHaveLength(0);
    expect(r.checked).toContain("headroom");
  });

  it("a tripped limit → CRITICAL", () => {
    const r = combineRiskPosture({ headroom: headroom([{ status: "tripped", label: "Drawdown breaker", detail: "TRIPPED" }]) });
    expect(r.verdict).toBe("critical");
    expect(r.concerns[0].code).toBe("limit_tripped");
    expect(r.concerns[0].severity).toBe("critical");
  });

  it("an exhausted limit → CRITICAL", () => {
    const r = combineRiskPosture({ headroom: headroom([{ status: "exhausted", label: "Daily USD cap" }]) });
    expect(r.verdict).toBe("critical");
    expect(r.concerns[0].code).toBe("limit_exhausted");
  });

  it("approaching + concentration + mev → ELEVATED (all warns)", () => {
    const r = combineRiskPosture({
      headroom: headroom([{ status: "approaching", label: "Daily USD cap" }]),
      concentration: conc("warn"),
      mev: mev(true),
    });
    expect(r.verdict).toBe("elevated");
    expect(r.concerns.map((c) => c.code).sort()).toEqual(["concentration_high", "limit_approaching", "mev_exposed"]);
  });

  it("unprotected value over half the book → elevated concern", () => {
    const r = combineRiskPosture({
      protection: { totalValueUsd: 10000, totalUnprotectedValueUsd: 6000, unprotectedCount: 1, partialCount: 0 },
    });
    expect(r.verdict).toBe("elevated");
    expect(r.concerns[0].code).toBe("unprotected_exposure");
    expect(r.concerns[0].message).toMatch(/60% of the book/);
  });

  it("unprotected value UNDER the threshold → no concern", () => {
    const frac = UNPROTECTED_ELEVATED_FRAC - 0.1;
    const r = combineRiskPosture({
      protection: { totalValueUsd: 10000, totalUnprotectedValueUsd: 10000 * frac, unprotectedCount: 1, partialCount: 0 },
    });
    expect(r.concerns.find((c) => c.code === "unprotected_exposure")).toBeUndefined();
  });

  it("critical ranks before warn regardless of input order", () => {
    const r = combineRiskPosture({
      concentration: conc("warn"), // warn, added first
      headroom: headroom([{ status: "tripped", label: "Drawdown" }]), // critical, added later
    });
    expect(r.verdict).toBe("critical");
    expect(r.concerns[0].severity).toBe("critical"); // critical floated to the top
  });

  it("records which dimensions were checked", () => {
    const r = combineRiskPosture({ headroom: headroom([{ status: "ok" }]), mev: mev(false) });
    expect(r.checked).toEqual(["headroom", "mev"]);
    expect(r.checked).not.toContain("concentration");
  });

  it("no inputs at all → ok with an honest summary", () => {
    const r = combineRiskPosture({});
    expect(r.verdict).toBe("ok");
    expect(r.summary).toMatch(/No risk signals/);
  });
});
