/**
 * Order decision journal tests.
 *
 * Layers:
 *   1. Pure predicate (shouldLogCheck) — every decision branch,
 *      no-state-change short-circuit, HWM change detection,
 *      proximity crossings, terminal-decision always-log
 *   2. Observation builder (buildObservation) — non-trailing vs
 *      trailing, fired/skipped/error overrides
 *   3. DB-integration (recordCheckEntry + replayOrder) — write
 *      gating, replay query, count, prune
 *   4. Decision marker / label helpers
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-orderjournal-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  shouldLogCheck,
  buildObservation,
  recordCheckEntry,
  replayOrder,
  decisionMarker,
  decisionLabel,
} = await import("./orderJournal.js");
const {
  openDb,
  closeDb,
  insertOrderCheckEntry,
  replayOrderEntries,
  countOrderCheckEntries,
  pruneOrderCheckLog,
  getLatestOrderCheckEntry,
} = await import("./db.js");
type OrderRow = import("./db.js").OrderRow;
type OrderCheckLogRow = import("./db.js").OrderCheckLogRow;

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM order_check_log");
});

const enabledConfig = { enabled: true, proximityPct: 5 };

function mkRow(overrides: Partial<OrderCheckLogRow> = {}): OrderCheckLogRow {
  return {
    id: 1,
    order_id: 1,
    checked_at: "2026-05-01T12:00:00Z",
    price_usd: 1000,
    water_mark_usd: 1000,
    threshold_usd: 950,
    decision: "hwm_advanced",
    notes: null,
    ...overrides,
  };
}

// ── shouldLogCheck — feature disabled ────────────────────────

describe("shouldLogCheck — feature disabled", () => {
  it("returns false regardless of state when enabled=false", () => {
    const config = { enabled: false, proximityPct: 5 };
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 100, waterMarkUsd: null, thresholdUsd: null, decision: "triggered_fired" },
      prior: null, config,
    })).toBe(false);
  });
});

// ── shouldLogCheck — first entry ─────────────────────────────

describe("shouldLogCheck — first entry", () => {
  it("always logs when prior is null", () => {
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 1000, waterMarkUsd: 1000, thresholdUsd: 950, decision: "tracking_started" },
      prior: null, config: enabledConfig,
    })).toBe(true);
  });
});

// ── shouldLogCheck — terminal decisions ──────────────────────

describe("shouldLogCheck — terminal decisions always log", () => {
  it("triggered_fired logs even when prior decision was the same", () => {
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 1000, waterMarkUsd: null, thresholdUsd: 950, decision: "triggered_fired" },
      prior: mkRow({ decision: "triggered_fired" }),
      config: enabledConfig,
    })).toBe(true);
  });

  it("triggered_skipped logs even with same prior", () => {
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 1000, waterMarkUsd: null, thresholdUsd: 950, decision: "triggered_skipped" },
      prior: mkRow({ decision: "triggered_skipped" }),
      config: enabledConfig,
    })).toBe(true);
  });

  it("error always logs (distinct notes carry context)", () => {
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: null, waterMarkUsd: null, thresholdUsd: null, decision: "error", notes: "RPC timeout" },
      prior: mkRow({ decision: "error", notes: "previous error" }),
      config: enabledConfig,
    })).toBe(true);
  });
});

// ── shouldLogCheck — decision changes ────────────────────────

describe("shouldLogCheck — decision-state changes", () => {
  it("logs when decision differs from prior", () => {
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 1100, waterMarkUsd: 1100, thresholdUsd: 1045, decision: "hwm_advanced" },
      prior: mkRow({ decision: "tracking_started" }),
      config: enabledConfig,
    })).toBe(true);
  });

  it("logs activation_pending → tracking_started transition", () => {
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 1000, waterMarkUsd: 1000, thresholdUsd: 950, decision: "tracking_started" },
      prior: mkRow({ decision: "activation_pending", water_mark_usd: null }),
      config: enabledConfig,
    })).toBe(true);
  });
});

// ── shouldLogCheck — HWM changes ─────────────────────────────

describe("shouldLogCheck — HWM advancement", () => {
  it("logs when HWM moved", () => {
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 1100, waterMarkUsd: 1100, thresholdUsd: 1045, decision: "hwm_advanced" },
      prior: mkRow({ water_mark_usd: 1000 }),
      config: enabledConfig,
    })).toBe(true);
  });

  it("logs when null→number (activation transition)", () => {
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 1000, waterMarkUsd: 1000, thresholdUsd: 950, decision: "near_threshold" },
      prior: mkRow({ water_mark_usd: null }),
      config: enabledConfig,
    })).toBe(true);
  });

  it("does NOT log when HWM unchanged + same decision", () => {
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 1050, waterMarkUsd: 1100, thresholdUsd: 1045, decision: "near_threshold" },
      prior: mkRow({ decision: "near_threshold", water_mark_usd: 1100, threshold_usd: 1045, price_usd: 1080 }),
      config: enabledConfig,
    })).toBe(false);
  });
});

// ── shouldLogCheck — proximity crossings ─────────────────────

describe("shouldLogCheck — proximity crossings", () => {
  it("logs when price first enters within proximityPct of threshold", () => {
    // Prior: price $1100, threshold $1045 → 5.0% away (just outside).
    // Current: price $1080, threshold $1045 → 3.2% away (inside 5%).
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 1080, waterMarkUsd: 1100, thresholdUsd: 1045, decision: "near_threshold" },
      prior: mkRow({
        decision: "near_threshold",
        water_mark_usd: 1100, threshold_usd: 1045, price_usd: 1200, // 12.9% away
      }),
      config: enabledConfig,
    })).toBe(true);
  });

  it("does NOT log when already inside proximity zone + no HWM/decision change", () => {
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: 1070, waterMarkUsd: 1100, thresholdUsd: 1045, decision: "near_threshold" },
      prior: mkRow({
        decision: "near_threshold",
        water_mark_usd: 1100, threshold_usd: 1045, price_usd: 1080, // already 3.2% away
      }),
      config: enabledConfig,
    })).toBe(false);
  });

  it("does NOT log when proximity check N/A (price or threshold missing)", () => {
    // Prior mirrors current: same decision, same HWM (null both
    // sides), no price/threshold to compute proximity. No reason to
    // log.
    expect(shouldLogCheck({
      current: { orderId: 1, checkedAt: "x", priceUsd: null, waterMarkUsd: null, thresholdUsd: null, decision: "near_threshold" },
      prior: mkRow({ decision: "near_threshold", water_mark_usd: null, price_usd: null, threshold_usd: null }),
      config: enabledConfig,
    })).toBe(false);
  });
});

// ── buildObservation — fired / skipped / error overrides ─────

function mkOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 1,
    created_at: "2026-05-01T12:00:00Z",
    updated_at: "2026-05-01T12:00:00Z",
    on_fill_json: null,
    status: "active",
    side: "sell",
    trigger_type: "trailing",
    target_price_usd: 3000,
    trail_pct: 5,
    water_mark_usd: 3100,
    chain: "base",
    account: "default",
    base_token: "0xeeee",
    base_symbol: "ETH",
    quote_token: "0xqqqq",
    quote_symbol: "USDC",
    base_amount: "1",
    quote_amount: null,
    slippage_bps: null,
    auto_slippage: 0,
    expires_at: null,
    strategy: null,
    note: null,
    attempts: 0,
    last_checked_at: null,
    last_checked_price: null,
    last_error_code: null,
    last_error_message: null,
    filled_at: null,
    fill_tx_hash: null,
    fill_price: null,
    fill_base_amount: null,
    fill_quote_amount: null,
    ...overrides,
  };
}

describe("buildObservation — terminal overrides", () => {
  it("fired override sets decision='triggered_fired'", () => {
    const obs = buildObservation({
      order: mkOrder(),
      priceUsd: 2950,
      checkedAt: "2026-05-02T16:00:00Z",
      fired: true,
    });
    expect(obs.decision).toBe("triggered_fired");
    expect(obs.priceUsd).toBe(2950);
  });

  it("skipped override sets decision='triggered_skipped'", () => {
    const obs = buildObservation({
      order: mkOrder(),
      priceUsd: 2950,
      checkedAt: "2026-05-02T16:00:00Z",
      skipped: true,
    });
    expect(obs.decision).toBe("triggered_skipped");
  });

  it("error override sets decision='error' with notes", () => {
    const obs = buildObservation({
      order: mkOrder(),
      priceUsd: null,
      checkedAt: "2026-05-02T16:00:00Z",
      errorMessage: "RPC timeout",
    });
    expect(obs.decision).toBe("error");
    expect(obs.notes).toBe("RPC timeout");
  });
});

// ── buildObservation — trailing transitions ──────────────────

describe("buildObservation — trailing", () => {
  it("activation_pending when below activation gate", () => {
    const obs = buildObservation({
      order: mkOrder({ water_mark_usd: null, target_price_usd: 3500, side: "sell" }),
      priceUsd: 3000,
      checkedAt: "x",
    });
    expect(obs.decision).toBe("activation_pending");
    expect(obs.waterMarkUsd).toBeNull();
  });

  it("tracking_started when activation just hit (prior HWM null)", () => {
    const obs = buildObservation({
      order: mkOrder({ water_mark_usd: null, target_price_usd: 3000, side: "sell" }),
      priceUsd: 3050,
      checkedAt: "x",
    });
    expect(obs.decision).toBe("tracking_started");
    expect(obs.waterMarkUsd).toBe(3050);
  });

  it("hwm_advanced when price exceeds prior HWM", () => {
    const obs = buildObservation({
      order: mkOrder({ water_mark_usd: 3100, target_price_usd: 3000, side: "sell" }),
      priceUsd: 3200,
      checkedAt: "x",
    });
    expect(obs.decision).toBe("hwm_advanced");
    expect(obs.waterMarkUsd).toBe(3200);
  });

  it("near_threshold when tracking + HWM unchanged", () => {
    const obs = buildObservation({
      order: mkOrder({ water_mark_usd: 3100, target_price_usd: 3000, side: "sell" }),
      priceUsd: 3050, // below prior HWM 3100, so HWM doesn't advance
      checkedAt: "x",
    });
    expect(obs.decision).toBe("near_threshold");
    expect(obs.waterMarkUsd).toBe(3100); // unchanged
  });

  it("computed threshold for trailing sell uses HWM × (1 - trail/100)", () => {
    const obs = buildObservation({
      order: mkOrder({ water_mark_usd: 3000, trail_pct: 5, side: "sell" }),
      priceUsd: 3050,
      checkedAt: "x",
    });
    // Updated HWM = 3050; threshold = 3050 × 0.95 = 2897.5
    expect(obs.thresholdUsd).toBeCloseTo(2897.5, 5);
  });
});

// ── buildObservation — non-trailing ──────────────────────────

describe("buildObservation — price_above / price_below", () => {
  it("threshold = target_price_usd", () => {
    const obs = buildObservation({
      order: mkOrder({ trigger_type: "price_above", target_price_usd: 3500, water_mark_usd: null, trail_pct: null }),
      priceUsd: 3200,
      checkedAt: "x",
    });
    expect(obs.thresholdUsd).toBe(3500);
    expect(obs.waterMarkUsd).toBeNull();
  });

  // Regression: this was a no-op ternary (`triggered ? "near_threshold"
  // : "near_threshold"`) — BOTH branches wrote near_threshold, so replay
  // could not distinguish "approaching the threshold" from "trigger met
  // but the engine didn't fire".
  it("non-triggered price order observes near_threshold", () => {
    const obs = buildObservation({
      order: mkOrder({ trigger_type: "price_above", target_price_usd: 3500, water_mark_usd: null, trail_pct: null }),
      priceUsd: 3200, // 3200 < 3500 — not triggered
      checkedAt: "x",
    });
    expect(obs.decision).toBe("near_threshold");
    expect(obs.notes ?? null).toBeNull();
  });

  it("triggered-but-unflagged price order observes triggered_skipped (not near_threshold)", () => {
    const obs = buildObservation({
      order: mkOrder({ trigger_type: "price_above", target_price_usd: 3500, water_mark_usd: null, trail_pct: null }),
      priceUsd: 3600, // 3600 >= 3500 — trigger satisfied, no fired/skipped flag
      checkedAt: "x",
    });
    expect(obs.decision).toBe("triggered_skipped");
    expect(obs.notes).toContain("trigger satisfied");
  });

  it("price_below symmetric: triggered observes triggered_skipped", () => {
    const obs = buildObservation({
      order: mkOrder({ trigger_type: "price_below", target_price_usd: 3000, water_mark_usd: null, trail_pct: null }),
      priceUsd: 2900, // 2900 <= 3000 — triggered
      checkedAt: "x",
    });
    expect(obs.decision).toBe("triggered_skipped");
  });
});

describe("buildObservation — expired override", () => {
  it("expired override sets decision='expired' with expires_at note", () => {
    const obs = buildObservation({
      order: mkOrder({ expires_at: "2026-05-02T00:00:00Z" }),
      priceUsd: null,
      checkedAt: "2026-05-02T00:00:05Z",
      expired: true,
    });
    expect(obs.decision).toBe("expired");
    expect(obs.notes).toContain("2026-05-02T00:00:00Z");
  });

  it("expired override carries explicit notes when provided", () => {
    const obs = buildObservation({
      order: mkOrder({ expires_at: "2026-05-02T00:00:00Z" }),
      priceUsd: 3100,
      checkedAt: "x",
      expired: true,
      notes: "expired between trigger evaluation and fire",
    });
    expect(obs.decision).toBe("expired");
    expect(obs.notes).toBe("expired between trigger evaluation and fire");
    expect(obs.priceUsd).toBe(3100);
  });

  it("expired is a terminal decision — shouldLogCheck always logs it", () => {
    expect(
      shouldLogCheck({
        current: { orderId: 1, checkedAt: "x", priceUsd: null, waterMarkUsd: null, thresholdUsd: null, decision: "expired" },
        prior: mkRow({ decision: "expired" }), // even a duplicate logs
        config: { enabled: true, proximityPct: 5 },
      }),
    ).toBe(true);
  });

  it("skipped override carries notes (lock reason context)", () => {
    const obs = buildObservation({
      order: mkOrder(),
      priceUsd: 2950,
      checkedAt: "x",
      skipped: true,
      notes: "engine locked: incident response",
    });
    expect(obs.decision).toBe("triggered_skipped");
    expect(obs.notes).toBe("engine locked: incident response");
  });
});

// ── recordCheckEntry — DB writes + gating ────────────────────

describe("recordCheckEntry", () => {
  it("returns wrote=false when feature disabled", () => {
    const r = recordCheckEntry({
      observation: { orderId: 1, checkedAt: "x", priceUsd: 100, waterMarkUsd: null, thresholdUsd: null, decision: "triggered_fired" },
      config: { enabled: false, proximityPct: 5 },
    });
    expect(r.wrote).toBe(false);
    expect(r.rowId).toBeNull();
  });

  it("writes first entry when feature enabled", () => {
    const r = recordCheckEntry({
      observation: { orderId: 1, checkedAt: "2026-05-01T12:00:00Z", priceUsd: 1000, waterMarkUsd: 1000, thresholdUsd: 950, decision: "tracking_started" },
      config: enabledConfig,
    });
    expect(r.wrote).toBe(true);
    expect(r.rowId).toBeGreaterThan(0);
  });

  it("does NOT write when state hasn't changed", () => {
    // Seed a prior entry.
    insertOrderCheckEntry({
      orderId: 1, checkedAt: "2026-05-01T12:00:00Z",
      priceUsd: 1100, waterMarkUsd: 1100, thresholdUsd: 1045,
      decision: "near_threshold", notes: null,
    });
    // Submit a "no change" check — same decision, same HWM, price still
    // far from threshold (12% away).
    const r = recordCheckEntry({
      observation: {
        orderId: 1, checkedAt: "2026-05-01T12:01:00Z",
        priceUsd: 1180, waterMarkUsd: 1100, thresholdUsd: 1045, decision: "near_threshold",
      },
      config: enabledConfig,
    });
    expect(r.wrote).toBe(false);
    expect(countOrderCheckEntries(1)).toBe(1);
  });

  it("writes when HWM advanced", () => {
    insertOrderCheckEntry({
      orderId: 1, checkedAt: "2026-05-01T12:00:00Z",
      priceUsd: 1100, waterMarkUsd: 1100, thresholdUsd: 1045,
      decision: "hwm_advanced", notes: null,
    });
    const r = recordCheckEntry({
      observation: {
        orderId: 1, checkedAt: "2026-05-01T12:01:00Z",
        priceUsd: 1200, waterMarkUsd: 1200, thresholdUsd: 1140, decision: "hwm_advanced",
      },
      config: enabledConfig,
    });
    expect(r.wrote).toBe(true);
    expect(countOrderCheckEntries(1)).toBe(2);
  });

  it("respects priorLookup injection seam", () => {
    let lookupCalls = 0;
    const customPrior = {
      id: 999, order_id: 1, checked_at: "x",
      price_usd: 1100, water_mark_usd: 1100, threshold_usd: 1045,
      decision: "near_threshold" as const, notes: null,
    };
    const r = recordCheckEntry({
      observation: {
        orderId: 1, checkedAt: "2026-05-01T12:01:00Z",
        priceUsd: 1180, waterMarkUsd: 1100, thresholdUsd: 1045, decision: "near_threshold",
      },
      config: enabledConfig,
      priorLookup: () => { lookupCalls++; return customPrior; },
    });
    expect(lookupCalls).toBe(1);
    expect(r.wrote).toBe(false); // injected prior matches → no change
  });

  it("error decisions always write (multiple errors keep distinct notes)", () => {
    insertOrderCheckEntry({
      orderId: 1, checkedAt: "2026-05-01T12:00:00Z",
      priceUsd: null, waterMarkUsd: null, thresholdUsd: null,
      decision: "error", notes: "RPC timeout (try 1)",
    });
    const r = recordCheckEntry({
      observation: {
        orderId: 1, checkedAt: "2026-05-01T12:00:30Z",
        priceUsd: null, waterMarkUsd: null, thresholdUsd: null, decision: "error",
        notes: "RPC timeout (try 2)",
      },
      config: enabledConfig,
    });
    expect(r.wrote).toBe(true);
    expect(countOrderCheckEntries(1)).toBe(2);
  });
});

// ── replayOrder ──────────────────────────────────────────────

describe("replayOrder", () => {
  it("returns entries in chronological order", () => {
    insertOrderCheckEntry({ orderId: 1, checkedAt: "2026-05-01T15:00:00Z", priceUsd: 1100, waterMarkUsd: 1100, thresholdUsd: 1045, decision: "hwm_advanced", notes: null });
    insertOrderCheckEntry({ orderId: 1, checkedAt: "2026-05-01T12:00:00Z", priceUsd: 1000, waterMarkUsd: 1000, thresholdUsd: 950, decision: "tracking_started", notes: null });
    insertOrderCheckEntry({ orderId: 1, checkedAt: "2026-05-01T18:00:00Z", priceUsd: 950, waterMarkUsd: 1100, thresholdUsd: 1045, decision: "triggered_fired", notes: null });

    const result = replayOrder(1);
    expect(result.totalEntries).toBe(3);
    expect(result.entries.map((e) => e.checked_at)).toEqual([
      "2026-05-01T12:00:00Z",
      "2026-05-01T15:00:00Z",
      "2026-05-01T18:00:00Z",
    ]);
  });

  it("respects --limit", () => {
    for (let i = 0; i < 5; i++) {
      insertOrderCheckEntry({
        orderId: 1, checkedAt: `2026-05-01T${String(12 + i).padStart(2, "0")}:00:00Z`,
        priceUsd: 1000, waterMarkUsd: null, thresholdUsd: null, decision: "near_threshold", notes: null,
      });
    }
    const result = replayOrder(1, 3);
    expect(result.totalEntries).toBe(5); // totalEntries ignores limit
    expect(result.entries.length).toBe(3);
  });

  it("returns empty entries when order has no journal", () => {
    const result = replayOrder(999);
    expect(result.totalEntries).toBe(0);
    expect(result.entries).toEqual([]);
  });
});

// ── pruning ──────────────────────────────────────────────────

describe("pruneOrderCheckLog", () => {
  it("deletes entries older than the supplied timestamp", () => {
    insertOrderCheckEntry({ orderId: 1, checkedAt: "2026-04-01T12:00:00Z", priceUsd: 1000, waterMarkUsd: null, thresholdUsd: null, decision: "tracking_started", notes: null });
    insertOrderCheckEntry({ orderId: 1, checkedAt: "2026-05-01T12:00:00Z", priceUsd: 1100, waterMarkUsd: null, thresholdUsd: null, decision: "hwm_advanced", notes: null });
    insertOrderCheckEntry({ orderId: 1, checkedAt: "2026-06-01T12:00:00Z", priceUsd: 1200, waterMarkUsd: null, thresholdUsd: null, decision: "triggered_fired", notes: null });

    const deleted = pruneOrderCheckLog("2026-05-15T00:00:00Z");
    expect(deleted).toBe(2); // April + May 1st
    expect(countOrderCheckEntries(1)).toBe(1);
  });
});

// ── decision markers ─────────────────────────────────────────

describe("decisionMarker + decisionLabel", () => {
  it("returns a non-empty marker + label for every decision", () => {
    const decisions = [
      "activation_pending", "tracking_started", "hwm_advanced",
      "near_threshold", "triggered_fired", "triggered_skipped", "error",
      "edited_by_operator", "expired",
    ] as const;
    for (const d of decisions) {
      expect(decisionMarker(d).length).toBeGreaterThan(0);
      expect(decisionLabel(d).length).toBeGreaterThan(0);
    }
  });

  it("triggered_fired uses 🔥", () => {
    expect(decisionMarker("triggered_fired")).toBe("🔥");
  });
});

// ── end-to-end: simulate an order lifecycle ──────────────────

describe("end-to-end lifecycle", () => {
  it("records sampled journal across a trailing-order lifecycle", () => {
    const orderId = 1;
    const config = enabledConfig;

    // Tick 1: pre-activation (price 2800, activation 3000) — should log.
    let r = recordCheckEntry({
      observation: buildObservation({
        order: mkOrder({ water_mark_usd: null, target_price_usd: 3000, side: "sell" }),
        priceUsd: 2800,
        checkedAt: "2026-05-01T12:00:00Z",
      }),
      config,
    });
    expect(r.wrote).toBe(true);

    // Tick 2: still pre-activation (price 2900) — same decision + HWM
    // unchanged → no log.
    r = recordCheckEntry({
      observation: buildObservation({
        order: mkOrder({ water_mark_usd: null, target_price_usd: 3000, side: "sell" }),
        priceUsd: 2900,
        checkedAt: "2026-05-01T12:01:00Z",
      }),
      config,
    });
    expect(r.wrote).toBe(false);

    // Tick 3: activation reached (price 3050, HWM seeded) — decision
    // changed activation_pending → tracking_started → log.
    r = recordCheckEntry({
      observation: buildObservation({
        order: mkOrder({ water_mark_usd: null, target_price_usd: 3000, side: "sell" }),
        priceUsd: 3050,
        checkedAt: "2026-05-01T14:00:00Z",
      }),
      config,
    });
    expect(r.wrote).toBe(true);

    // Tick 4: HWM advances (price 3200) — log.
    r = recordCheckEntry({
      observation: buildObservation({
        order: mkOrder({ water_mark_usd: 3050, target_price_usd: 3000, side: "sell" }),
        priceUsd: 3200,
        checkedAt: "2026-05-01T18:00:00Z",
      }),
      config,
    });
    expect(r.wrote).toBe(true);

    // Tick 5: pullback to 3100 — HWM unchanged (was 3050 in the row,
    // simulator passes order with prior HWM 3200). Actually let me
    // think — the engine writes HWM to the DB after each tick; the
    // observation reflects the post-tick HWM. Here we're simulating
    // an order with HWM 3200 + a pullback. evaluateTrailingTrigger
    // says next HWM is 3200 (unchanged); the observation reports
    // decision=near_threshold + HWM=3200. Prior entry: HWM=3200,
    // decision=hwm_advanced. So decision changed (hwm_advanced →
    // near_threshold) → log.
    r = recordCheckEntry({
      observation: buildObservation({
        order: mkOrder({ water_mark_usd: 3200, target_price_usd: 3000, side: "sell" }),
        priceUsd: 3100,
        checkedAt: "2026-05-01T19:00:00Z",
      }),
      config,
    });
    expect(r.wrote).toBe(true);

    // Tick 6: another pullback to 3050 — same decision, same HWM,
    // proximity already crossed → no log.
    r = recordCheckEntry({
      observation: buildObservation({
        order: mkOrder({ water_mark_usd: 3200, target_price_usd: 3000, side: "sell" }),
        priceUsd: 3050,
        checkedAt: "2026-05-01T19:30:00Z",
      }),
      config,
    });
    // Prior threshold was 3200 * 0.95 = 3040; current price 3050 is
    // 0.33% from threshold. Prior price 3100 was 1.94% from same
    // threshold → both within 5% proximity → NOT a crossing → no log.
    expect(r.wrote).toBe(false);

    // Tick 7: FIRED — engine overrides with fired=true.
    r = recordCheckEntry({
      observation: buildObservation({
        order: mkOrder({ water_mark_usd: 3200, target_price_usd: 3000, side: "sell" }),
        priceUsd: 3030,
        checkedAt: "2026-05-01T20:00:00Z",
        fired: true,
      }),
      config,
    });
    expect(r.wrote).toBe(true);

    // Replay timeline should show exactly the 5 logged events.
    const replay = replayOrder(orderId);
    expect(replay.totalEntries).toBe(5);
    expect(replay.entries.map((e) => e.decision)).toEqual([
      "activation_pending",
      "tracking_started",
      "hwm_advanced",
      "near_threshold",
      "triggered_fired",
    ]);
  });
});

// ── unused-import suppression ────────────────────────────────

void replayOrderEntries;
void getLatestOrderCheckEntry;
