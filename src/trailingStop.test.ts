// Tests for the trailing-stop pure logic (trailingStop.ts). No DB, no
// RPC — value-in / value-out coverage of:
//   - evaluateTrailingTrigger: water-mark progression, threshold math,
//     activation gating, edge cases
//   - validateTrailingCreate: input rules
//   - describeTrailingState: render formatting

import { describe, it, expect } from "vitest";

import {
  evaluateTrailingTrigger,
  validateTrailingCreate,
  describeTrailingState,
  type TrailingOrderView,
} from "./trailingStop.js";

// ── helpers ──────────────────────────────────────────────────

function sellTrail(overrides: Partial<TrailingOrderView> = {}): TrailingOrderView {
  return {
    side: "sell",
    trigger_type: "trailing",
    target_price_usd: null,
    trail_pct: 5,
    water_mark_usd: null,
    ...overrides,
  };
}

function buyTrail(overrides: Partial<TrailingOrderView> = {}): TrailingOrderView {
  return {
    side: "buy",
    trigger_type: "trailing",
    target_price_usd: null,
    trail_pct: 5,
    water_mark_usd: null,
    ...overrides,
  };
}

// ── evaluateTrailingTrigger: non-trailing + invalid input ───

describe("evaluateTrailingTrigger — short-circuits", () => {
  it("non-trailing trigger → tracking=false with reason", () => {
    const order: TrailingOrderView = {
      side: "sell",
      trigger_type: "price_below",
      target_price_usd: 3000,
      trail_pct: null,
      water_mark_usd: null,
    };
    const r = evaluateTrailingTrigger(order, 3100);
    expect(r.tracking).toBe(false);
    expect(r.notTrackingReason).toBe("not_trailing");
    expect(r.triggered).toBe(false);
  });

  it("invalid current price (null / NaN / ≤ 0) → tracking=false", () => {
    expect(evaluateTrailingTrigger(sellTrail(), null).tracking).toBe(false);
    expect(evaluateTrailingTrigger(sellTrail(), Number.NaN).tracking).toBe(false);
    expect(evaluateTrailingTrigger(sellTrail(), -1).tracking).toBe(false);
    expect(evaluateTrailingTrigger(sellTrail(), 0).tracking).toBe(false);
  });

  it("missing/invalid trail_pct → tracking=false", () => {
    expect(evaluateTrailingTrigger(sellTrail({ trail_pct: null }), 3000).notTrackingReason).toBe("missing_trail_pct");
    expect(evaluateTrailingTrigger(sellTrail({ trail_pct: 0 }), 3000).notTrackingReason).toBe("missing_trail_pct");
    expect(evaluateTrailingTrigger(sellTrail({ trail_pct: 101 }), 3000).notTrackingReason).toBe("missing_trail_pct");
    expect(evaluateTrailingTrigger(sellTrail({ trail_pct: Number.NaN }), 3000).notTrackingReason).toBe("missing_trail_pct");
  });
});

// ── sell-trail water-mark progression ────────────────────────

describe("evaluateTrailingTrigger — sell trail (HWM)", () => {
  it("first tick sets initial water mark + computes threshold", () => {
    const r = evaluateTrailingTrigger(sellTrail({ trail_pct: 5 }), 3000);
    expect(r.tracking).toBe(true);
    expect(r.nextWaterMark).toBe(3000);
    expect(r.waterMarkChanged).toBe(true); // first-tick write
    expect(r.fireThreshold).toBeCloseTo(2850, 6); // 3000 × (1 - 0.05)
    expect(r.triggered).toBe(false);
  });

  it("rising price keeps moving HWM up + threshold up", () => {
    // Tick 1 at 3000.
    let order = sellTrail({ trail_pct: 5 });
    let r = evaluateTrailingTrigger(order, 3000);
    expect(r.nextWaterMark).toBe(3000);

    // Tick 2 at 3200 — HWM moves up; threshold rises with it.
    order = { ...order, water_mark_usd: 3000 };
    r = evaluateTrailingTrigger(order, 3200);
    expect(r.nextWaterMark).toBe(3200);
    expect(r.waterMarkChanged).toBe(true);
    expect(r.fireThreshold).toBeCloseTo(3040, 6); // 3200 × 0.95
    expect(r.triggered).toBe(false);

    // Tick 3 at 3300 — HWM keeps rising.
    order = { ...order, water_mark_usd: 3200 };
    r = evaluateTrailingTrigger(order, 3300);
    expect(r.nextWaterMark).toBe(3300);
    expect(r.fireThreshold).toBeCloseTo(3135, 6);
  });

  it("flat price doesn't change the HWM (waterMarkChanged=false)", () => {
    const order = sellTrail({ trail_pct: 5, water_mark_usd: 3200 });
    const r = evaluateTrailingTrigger(order, 3200);
    expect(r.nextWaterMark).toBe(3200);
    expect(r.waterMarkChanged).toBe(false);
    expect(r.triggered).toBe(false);
  });

  it("falling-but-above-threshold doesn't fire", () => {
    const order = sellTrail({ trail_pct: 5, water_mark_usd: 3200 });
    // Threshold = 3040. Current 3100 is below HWM but above threshold.
    const r = evaluateTrailingTrigger(order, 3100);
    expect(r.nextWaterMark).toBe(3200); // unchanged
    expect(r.waterMarkChanged).toBe(false);
    expect(r.fireThreshold).toBeCloseTo(3040, 6);
    expect(r.triggered).toBe(false);
  });

  it("crossing threshold downward fires (locks in retracement)", () => {
    const order = sellTrail({ trail_pct: 5, water_mark_usd: 3200 });
    // Threshold 3040 — current 3000 is below it.
    const r = evaluateTrailingTrigger(order, 3000);
    expect(r.tracking).toBe(true);
    expect(r.triggered).toBe(true);
    expect(r.fireThreshold).toBeCloseTo(3040, 6);
  });

  it("exact threshold also fires (inclusive ≤)", () => {
    const order = sellTrail({ trail_pct: 5, water_mark_usd: 3200 });
    const r = evaluateTrailingTrigger(order, 3040);
    expect(r.triggered).toBe(true);
  });
});

// ── buy-trail water-mark progression ─────────────────────────

describe("evaluateTrailingTrigger — buy trail (LWM)", () => {
  it("first tick sets initial water mark + computes upward threshold", () => {
    const r = evaluateTrailingTrigger(buyTrail({ trail_pct: 5 }), 3000);
    expect(r.tracking).toBe(true);
    expect(r.nextWaterMark).toBe(3000);
    expect(r.fireThreshold).toBeCloseTo(3150, 6); // 3000 × 1.05
    expect(r.triggered).toBe(false);
  });

  it("falling price moves LWM down + threshold down", () => {
    let order = buyTrail({ trail_pct: 5, water_mark_usd: 3000 });
    let r = evaluateTrailingTrigger(order, 2800);
    expect(r.nextWaterMark).toBe(2800);
    expect(r.waterMarkChanged).toBe(true);
    expect(r.fireThreshold).toBeCloseTo(2940, 6);

    order = { ...order, water_mark_usd: 2800 };
    r = evaluateTrailingTrigger(order, 2700);
    expect(r.nextWaterMark).toBe(2700);
    expect(r.fireThreshold).toBeCloseTo(2835, 6);
  });

  it("rebound past threshold fires", () => {
    const order = buyTrail({ trail_pct: 5, water_mark_usd: 2700 });
    // Threshold 2835 — current 2850 rebounded above it.
    const r = evaluateTrailingTrigger(order, 2850);
    expect(r.triggered).toBe(true);
  });

  it("rising-but-below-threshold doesn't fire", () => {
    const order = buyTrail({ trail_pct: 5, water_mark_usd: 2700 });
    const r = evaluateTrailingTrigger(order, 2800);
    expect(r.nextWaterMark).toBe(2700);
    expect(r.fireThreshold).toBeCloseTo(2835, 6);
    expect(r.triggered).toBe(false);
  });
});

// ── activation gate ──────────────────────────────────────────

describe("evaluateTrailingTrigger — activation gate", () => {
  it("sell-trail: current below activation → not tracking yet", () => {
    const order = sellTrail({ trail_pct: 5, target_price_usd: 3500 });
    const r = evaluateTrailingTrigger(order, 3400);
    expect(r.tracking).toBe(false);
    expect(r.notTrackingReason).toBe("below_activation");
    expect(r.nextWaterMark).toBeNull();
    expect(r.triggered).toBe(false);
  });

  it("sell-trail: hitting activation starts tracking same tick", () => {
    const order = sellTrail({ trail_pct: 5, target_price_usd: 3500 });
    const r = evaluateTrailingTrigger(order, 3500);
    expect(r.tracking).toBe(true);
    expect(r.nextWaterMark).toBe(3500);
    expect(r.waterMarkChanged).toBe(true);
  });

  it("sell-trail: water_mark_usd already set → activation gate is bypassed", () => {
    // Once tracking has started, the activation gate is history — even
    // if the price dips back below the original activation it stays
    // tracked.
    const order = sellTrail({ trail_pct: 5, target_price_usd: 3500, water_mark_usd: 3500 });
    const r = evaluateTrailingTrigger(order, 3400);
    expect(r.tracking).toBe(true);
    expect(r.nextWaterMark).toBe(3500); // unchanged
  });

  it("buy-trail: current above activation → not tracking yet", () => {
    const order = buyTrail({ trail_pct: 5, target_price_usd: 2500 });
    const r = evaluateTrailingTrigger(order, 2600);
    expect(r.tracking).toBe(false);
    expect(r.notTrackingReason).toBe("above_activation");
  });

  it("buy-trail: dipping to activation starts tracking", () => {
    const order = buyTrail({ trail_pct: 5, target_price_usd: 2500 });
    const r = evaluateTrailingTrigger(order, 2500);
    expect(r.tracking).toBe(true);
    expect(r.nextWaterMark).toBe(2500);
  });
});

// ── single-tick fire-on-first-tick edge ──────────────────────

describe("evaluateTrailingTrigger — pathological / edge cases", () => {
  it("first tick can never fire (water mark = current price → threshold below current)", () => {
    // A 5% sell-trail with first tick at 3000: HWM=3000, threshold=2850.
    // current=3000 is NOT ≤ 2850, so triggered=false. Verified.
    const r = evaluateTrailingTrigger(sellTrail({ trail_pct: 5 }), 3000);
    expect(r.triggered).toBe(false);
  });

  it("trail_pct=100 on sell with HWM=3000 → threshold=0 → never fires", () => {
    const order = sellTrail({ trail_pct: 100, water_mark_usd: 3000 });
    const r = evaluateTrailingTrigger(order, 1); // anything > 0
    expect(r.fireThreshold).toBe(0);
    expect(r.triggered).toBe(false); // 1 > 0 (sell needs current ≤ threshold)
  });

  it("doesn't mutate the input order object", () => {
    const order = sellTrail({ trail_pct: 5, water_mark_usd: 3000 });
    const before = JSON.stringify(order);
    evaluateTrailingTrigger(order, 3200);
    expect(JSON.stringify(order)).toBe(before);
  });
});

// ── validateTrailingCreate ───────────────────────────────────

describe("validateTrailingCreate", () => {
  it("requires trailPct", () => {
    expect(() => validateTrailingCreate({ side: "sell" })).toThrow(/trail-pct/);
  });

  it("rejects trailPct outside (0, 100]", () => {
    expect(() => validateTrailingCreate({ side: "sell", trailPct: 0 })).toThrow(/0, 100/);
    expect(() => validateTrailingCreate({ side: "sell", trailPct: -1 })).toThrow(/0, 100/);
    expect(() => validateTrailingCreate({ side: "sell", trailPct: 101 })).toThrow(/0, 100/);
    expect(() => validateTrailingCreate({ side: "sell", trailPct: Number.NaN })).toThrow();
  });

  it("accepts trailPct exactly 100 (degenerate but parseable)", () => {
    expect(validateTrailingCreate({ side: "sell", trailPct: 100 })).toEqual({
      trail_pct: 100,
      target_price_usd: null,
    });
  });

  it("rejects non-positive activationPriceUsd", () => {
    expect(() => validateTrailingCreate({ side: "sell", trailPct: 5, activationPriceUsd: 0 })).toThrow();
    expect(() => validateTrailingCreate({ side: "sell", trailPct: 5, activationPriceUsd: -1 })).toThrow();
  });

  it("activation gate stored on the row", () => {
    expect(validateTrailingCreate({ side: "sell", trailPct: 5, activationPriceUsd: 3500 })).toEqual({
      trail_pct: 5,
      target_price_usd: 3500,
    });
  });

  it("happy path with no activation gate", () => {
    expect(validateTrailingCreate({ side: "sell", trailPct: 5 })).toEqual({
      trail_pct: 5,
      target_price_usd: null,
    });
  });
});

// ── describeTrailingState ────────────────────────────────────

describe("describeTrailingState", () => {
  it("returns empty string for non-trailing orders", () => {
    expect(
      describeTrailingState(
        { side: "sell", trigger_type: "price_below", target_price_usd: 3000, trail_pct: null, water_mark_usd: null },
        "ETH",
      ),
    ).toBe("");
  });

  it("pre-activation (gate set, water mark null) names the gate direction", () => {
    const desc = describeTrailingState(sellTrail({ trail_pct: 5, target_price_usd: 3500 }), "ETH");
    expect(desc).toMatch(/awaiting activation/);
    expect(desc).toMatch(/above \$3500/);
  });

  it("buy-trail pre-activation says 'below'", () => {
    const desc = describeTrailingState(buyTrail({ trail_pct: 5, target_price_usd: 2500 }), "ETH");
    expect(desc).toMatch(/below \$2500/);
  });

  it("active tracking renders HWM + computed threshold", () => {
    const desc = describeTrailingState(sellTrail({ trail_pct: 5, water_mark_usd: 3200 }), "ETH");
    expect(desc).toMatch(/HWM/);
    expect(desc).toMatch(/\$3200\.0000/);
    expect(desc).toMatch(/drops to/);
    expect(desc).toMatch(/\$3040\.0000/); // 3200 × 0.95
  });

  it("buy-trail active tracking renders LWM + upward threshold", () => {
    const desc = describeTrailingState(buyTrail({ trail_pct: 5, water_mark_usd: 2700 }), "ETH");
    expect(desc).toMatch(/LWM/);
    expect(desc).toMatch(/rises to/);
    expect(desc).toMatch(/\$2835\.0000/); // 2700 × 1.05
  });
});
