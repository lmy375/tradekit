/**
 * Schedule post-fill hook tests.
 *
 * Layers:
 *   1. Pure parser (parseOnFillSpec) — every error branch + multi-
 *      error collection
 *   2. Pure renderer (renderOnFillSpec) — type-aware substitution,
 *      embedded interpolation, unknown-var detection, immutability
 *   3. Validation at create (validateOnFillSpec) — rendered spec
 *      passes downstream order-validator gates; bad specs error
 *      with INVALID_PARAMS
 *   4. End-to-end executor (executeOnFillHook) — full fire-time
 *      path against real DB, verifies the new order persists with
 *      correct rendered values + inherited strategy tag
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-scheduleHooks-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const {
  parseOnFillSpec,
  renderOnFillSpec,
  validateOnFillSpec,
  executeOnFillHook,
  onFillLegs,
  autoHookGroup,
  MAX_ON_FILL_LEGS,
} = await import("./scheduleHooks.js");
const {
  openDb,
  closeDb,
  getOrderById,
} = await import("./db.js");
const { loadConfig } = await import("./config.js");

const ETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM orders");
});

// ── parseOnFillSpec ──────────────────────────────────────────

describe("parseOnFillSpec — happy path", () => {
  it("accepts a valid createOrder hook", () => {
    const spec = parseOnFillSpec({
      type: "createOrder",
      spec: {
        side: "sell",
        trigger: "trailing",
        trailPct: 10,
        baseAmount: "{{filled.baseAmount}}",
        base: "ETH",
        quote: "USDC",
      },
    });
    expect(spec.type).toBe("createOrder");
    expect(onFillLegs(spec)[0]!.side).toBe("sell");
  });

  it("accepts price-trigger hooks", () => {
    const spec = parseOnFillSpec({
      type: "createOrder",
      spec: {
        side: "sell", trigger: "price_above", price: 5000,
        baseAmount: "{{filled.baseAmount}}",
        base: "ETH", quote: "USDC",
      },
    });
    expect(onFillLegs(spec)[0]!.trigger).toBe("price_above");
  });
});

describe("parseOnFillSpec — error paths", () => {
  it("rejects non-object input", () => {
    expect(() => parseOnFillSpec("hi")).toThrow(/JSON object/);
    expect(() => parseOnFillSpec(null)).toThrow(/JSON object/);
    expect(() => parseOnFillSpec([])).toThrow(/JSON object/);
  });

  it("rejects non-createOrder types", () => {
    expect(() =>
      parseOnFillSpec({ type: "notify", spec: {} }),
    ).toThrow(/createOrder.*createOrders/);
  });

  it("rejects missing spec field", () => {
    expect(() =>
      parseOnFillSpec({ type: "createOrder" }),
    ).toThrow(/spec: required/);
  });

  it("rejects invalid side", () => {
    expect(() =>
      parseOnFillSpec({
        type: "createOrder",
        spec: { side: "long", trigger: "trailing", trailPct: 5, baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC" },
      }),
    ).toThrow(/spec\.side/);
  });

  it("rejects invalid trigger", () => {
    expect(() =>
      parseOnFillSpec({
        type: "createOrder",
        spec: { side: "sell", trigger: "rsi", base: "ETH", quote: "USDC", baseAmount: "1" },
      }),
    ).toThrow(/spec\.trigger/);
  });

  it("rejects missing base/quote/amount", () => {
    expect(() =>
      parseOnFillSpec({
        type: "createOrder",
        spec: { side: "sell", trigger: "trailing", trailPct: 5 },
      }),
    ).toThrow();
  });

  it("collects multiple errors", () => {
    let msg = "";
    try {
      parseOnFillSpec({
        type: "createOrder",
        spec: { side: "wrong", trigger: "wrong" },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/spec\.side/);
    expect(msg).toMatch(/spec\.trigger/);
  });
});

// ── renderOnFillSpec ─────────────────────────────────────────

describe("renderOnFillSpec — whole-field substitution preserves type", () => {
  it("string-typed value (baseAmount = '0.04')", () => {
    const out = renderOnFillSpec({
      spec: {
        type: "createOrder",
        spec: {
          side: "sell", trigger: "trailing", trailPct: 5,
          baseAmount: "{{filled.baseAmount}}",
          base: "ETH", quote: "USDC",
        },
      },
      fill: { baseAmount: "0.04", quoteAmount: "100", fillPriceUsd: 2500, txHash: "0xabc", fireNumber: 1 },
    });
    expect(onFillLegs(out)[0]!.baseAmount).toBe("0.04");
  });

  it("number-typed value (fillPriceUsd = 2500)", () => {
    const out = renderOnFillSpec({
      spec: {
        type: "createOrder",
        spec: {
          side: "sell", trigger: "price_above",
          price: "{{filled.fillPriceUsd}}",
          baseAmount: "1",
          base: "ETH", quote: "USDC",
        },
      },
      fill: { baseAmount: "1", quoteAmount: "100", fillPriceUsd: 2500, txHash: "0xabc", fireNumber: 1 },
    });
    expect(onFillLegs(out)[0]!.price).toBe(2500);
    expect(typeof onFillLegs(out)[0]!.price).toBe("number");
  });

  it("number-typed value (fireNumber = 3)", () => {
    const out = renderOnFillSpec({
      spec: {
        type: "createOrder",
        spec: {
          side: "sell", trigger: "trailing",
          trailPct: "{{filled.fireNumber}}",
          baseAmount: "1",
          base: "ETH", quote: "USDC",
        },
      },
      fill: { baseAmount: "1", quoteAmount: "100", fillPriceUsd: 2500, txHash: "0xabc", fireNumber: 3 },
    });
    expect(onFillLegs(out)[0]!.trailPct).toBe(3);
    expect(typeof onFillLegs(out)[0]!.trailPct).toBe("number");
  });
});

describe("renderOnFillSpec — embedded interpolation", () => {
  it("group name with fire counter", () => {
    const out = renderOnFillSpec({
      spec: {
        type: "createOrder",
        spec: {
          side: "sell", trigger: "price_above", price: 5000,
          baseAmount: "1",
          base: "ETH", quote: "USDC",
          group: "bracket-{{filled.fireNumber}}",
        },
      },
      fill: { baseAmount: "1", quoteAmount: "100", fillPriceUsd: 2500, txHash: "0xabc", fireNumber: 7 },
    });
    expect(onFillLegs(out)[0]!.group).toBe("bracket-7");
  });

  it("note with multiple placeholders", () => {
    const out = renderOnFillSpec({
      spec: {
        type: "createOrder",
        spec: {
          side: "sell", trigger: "trailing", trailPct: 5,
          baseAmount: "1",
          base: "ETH", quote: "USDC",
          note: "bought {{filled.baseAmount}} ETH at ${{filled.fillPriceUsd}}",
        },
      },
      fill: { baseAmount: "0.04", quoteAmount: "100", fillPriceUsd: 2500, txHash: "0xabc", fireNumber: 1 },
    });
    expect(onFillLegs(out)[0]!.note).toBe("bought 0.04 ETH at $2500");
  });
});

describe("renderOnFillSpec — unknown variables", () => {
  it("rejects unknown filled.X references", () => {
    expect(() =>
      renderOnFillSpec({
        spec: {
          type: "createOrder",
          spec: {
            side: "sell", trigger: "trailing", trailPct: 5,
            baseAmount: "{{filled.unknownField}}",
            base: "ETH", quote: "USDC",
          },
        },
        fill: { baseAmount: "1", quoteAmount: "100", fillPriceUsd: 2500, txHash: "0xabc", fireNumber: 1 },
      }),
    ).toThrow(/unknown variable filled\.unknownField/);
  });

  it("collects multiple unknown-var errors with path info", () => {
    let msg = "";
    try {
      renderOnFillSpec({
        spec: {
          type: "createOrder",
          spec: {
            side: "sell", trigger: "trailing", trailPct: 5,
            baseAmount: "{{filled.badA}}",
            base: "ETH", quote: "USDC",
            note: "{{filled.badB}}",
          },
        },
        fill: { baseAmount: "1", quoteAmount: "100", fillPriceUsd: 2500, txHash: "0xabc", fireNumber: 1 },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/badA/);
    expect(msg).toMatch(/badB/);
  });
});

describe("renderOnFillSpec — immutability", () => {
  it("does not mutate the input spec", () => {
    const spec = {
      type: "createOrder" as const,
      spec: {
        side: "sell" as const, trigger: "trailing" as const, trailPct: 5,
        baseAmount: "{{filled.baseAmount}}",
        base: "ETH", quote: "USDC",
      },
    };
    const before = JSON.parse(JSON.stringify(spec));
    renderOnFillSpec({
      spec,
      fill: { baseAmount: "1", quoteAmount: "100", fillPriceUsd: 2500, txHash: "0xabc", fireNumber: 1 },
    });
    expect(spec).toEqual(before);
  });
});

// ── validateOnFillSpec ──────────────────────────────────────

describe("validateOnFillSpec — create-time gate", () => {
  it("accepts a valid trailing-stop hook", () => {
    const { spec } = validateOnFillSpec({
      raw: {
        type: "createOrder",
        spec: {
          side: "sell", trigger: "trailing", trailPct: 10,
          baseAmount: "{{filled.baseAmount}}",
          base: "ETH", quote: "USDC",
        },
      },
      chain: "base", account: "default", config: loadConfig(),
      baseAddress: ETH, quoteAddress: USDC,
    });
    expect(spec.type).toBe("createOrder");
  });

  it("rejects trailing without trailPct (catches at create)", () => {
    expect(() =>
      validateOnFillSpec({
        raw: {
          type: "createOrder",
          spec: {
            side: "sell", trigger: "trailing",
            // missing trailPct
            baseAmount: "{{filled.baseAmount}}",
            base: "ETH", quote: "USDC",
          },
        },
        chain: "base", account: "default", config: loadConfig(),
        baseAddress: ETH, quoteAddress: USDC,
      }),
    ).toThrow(/trailPct/);
  });

  it("rejects price_above without a positive price", () => {
    expect(() =>
      validateOnFillSpec({
        raw: {
          type: "createOrder",
          spec: {
            side: "sell", trigger: "price_above",
            // missing price
            baseAmount: "{{filled.baseAmount}}",
            base: "ETH", quote: "USDC",
          },
        },
        chain: "base", account: "default", config: loadConfig(),
        baseAddress: ETH, quoteAddress: USDC,
      }),
    ).toThrow(/price/);
  });

  it("rejects both base + quote amount supplied", () => {
    expect(() =>
      validateOnFillSpec({
        raw: {
          type: "createOrder",
          spec: {
            side: "sell", trigger: "trailing", trailPct: 5,
            baseAmount: "{{filled.baseAmount}}",
            quoteAmount: "{{filled.quoteAmount}}",
            base: "ETH", quote: "USDC",
          },
        },
        chain: "base", account: "default", config: loadConfig(),
        baseAddress: ETH, quoteAddress: USDC,
      }),
    ).toThrow(/exactly one of baseAmount/);
  });

  it("rejects unknown variable references", () => {
    expect(() =>
      validateOnFillSpec({
        raw: {
          type: "createOrder",
          spec: {
            side: "sell", trigger: "trailing", trailPct: 5,
            baseAmount: "{{filled.bogus}}",
            base: "ETH", quote: "USDC",
          },
        },
        chain: "base", account: "default", config: loadConfig(),
        baseAddress: ETH, quoteAddress: USDC,
      }),
    ).toThrow(/unknown variable filled\.bogus/);
  });
});

// ── executeOnFillHook ───────────────────────────────────────

describe("executeOnFillHook — end-to-end", () => {
  it("creates a follow-up order with rendered fields", () => {
    const result = executeOnFillHook({
      spec: {
        type: "createOrder",
        spec: {
          side: "sell", trigger: "trailing", trailPct: 10,
          baseAmount: "{{filled.baseAmount}}",
          base: "ETH", quote: "USDC",
        },
      },
      fill: {
        baseAmount: "0.04",
        quoteAmount: "100",
        fillPriceUsd: 2500,
        txHash: "0x" + "ab".repeat(32),
        fireNumber: 1,
      },
      chain: "base",
      account: "default",
      baseAddress: ETH,
      quoteAddress: USDC,
      strategyTag: null,
      paper: false,
      parentRef: "schedule#1",
      config: loadConfig(),
    });
    expect(result.orderId).toBeGreaterThan(0);

    const order = getOrderById(result.orderId);
    expect(order).not.toBeNull();
    expect(order?.side).toBe("sell");
    expect(order?.trigger_type).toBe("trailing");
    expect(order?.trail_pct).toBe(10);
    expect(order?.base_amount).toBe("0.04");
    expect(order?.note).toMatch(/auto-created by schedule#1 on_fill/);
  });

  it("propagates strategy tag to the follow-up order", () => {
    const result = executeOnFillHook({
      spec: {
        type: "createOrder",
        spec: {
          side: "sell", trigger: "trailing", trailPct: 10,
          baseAmount: "{{filled.baseAmount}}",
          base: "ETH", quote: "USDC",
        },
      },
      fill: {
        baseAmount: "0.04",
        quoteAmount: "100",
        fillPriceUsd: 2500,
        txHash: "0x" + "ab".repeat(32),
        fireNumber: 5,
      },
      chain: "base",
      account: "default",
      baseAddress: ETH,
      quoteAddress: USDC,
      strategyTag: "playbook:42",
      paper: false,
      parentRef: "schedule#1",
      config: loadConfig(),
    });
    const order = getOrderById(result.orderId);
    expect(order?.strategy).toBe("playbook:42");
    // Note carries the fire counter.
    expect(order?.note).toMatch(/fire #5/);
  });

  it("renders fire-counter into group name for per-fire OCO brackets", () => {
    const result = executeOnFillHook({
      spec: {
        type: "createOrder",
        spec: {
          side: "sell", trigger: "price_above", price: 5000,
          baseAmount: "{{filled.baseAmount}}",
          base: "ETH", quote: "USDC",
          group: "bracket-{{filled.fireNumber}}",
        },
      },
      fill: {
        baseAmount: "0.04",
        quoteAmount: "100",
        fillPriceUsd: 2500,
        txHash: "0xabc",
        fireNumber: 3,
      },
      chain: "base",
      account: "default",
      baseAddress: ETH,
      quoteAddress: USDC,
      strategyTag: null,
      paper: false,
      parentRef: "schedule#1",
      config: loadConfig(),
    });
    const order = getOrderById(result.orderId);
    expect(order?.group_id).toBe("bracket-3");
  });

  it("rendered price (whole-field) preserves number type via createOrderRow", () => {
    // The fill rendered into price has type number; downstream
    // createOrderRow expects number. If the renderer accidentally
    // string-typed the result, createOrderRow's validator would
    // throw. End-to-end success is the assertion.
    const result = executeOnFillHook({
      spec: {
        type: "createOrder",
        spec: {
          side: "sell", trigger: "price_above",
          price: "{{filled.fillPriceUsd}}",
          baseAmount: "{{filled.baseAmount}}",
          base: "ETH", quote: "USDC",
        },
      },
      fill: {
        baseAmount: "0.04",
        quoteAmount: "100",
        fillPriceUsd: 3000,
        txHash: "0xabc",
        fireNumber: 1,
      },
      chain: "base",
      account: "default",
      baseAddress: ETH,
      quoteAddress: USDC,
      strategyTag: null,
      paper: false,
      parentRef: "schedule#1",
      config: loadConfig(),
    });
    const order = getOrderById(result.orderId);
    expect(order?.target_price_usd).toBe(3000);
  });

  it("fill-time render failure surfaces as INVALID_PARAMS", () => {
    expect(() =>
      executeOnFillHook({
        spec: {
          type: "createOrder",
          spec: {
            side: "sell", trigger: "trailing", trailPct: 5,
            baseAmount: "{{filled.bogus}}",
            base: "ETH", quote: "USDC",
          },
        },
        fill: {
          baseAmount: "0.04",
          quoteAmount: "100",
          fillPriceUsd: 2500,
          txHash: "0xabc",
          fireNumber: 1,
        },
        chain: "base",
        account: "default",
        baseAddress: ETH,
        quoteAddress: USDC,
        strategyTag: null,
        paper: false,
        parentRef: "schedule#1",
        config: loadConfig(),
      }),
    ).toThrow(/unknown variable/);
  });
});

// ── multi-leg brackets (createOrders) ───────────────────────

describe("parseOnFillSpec — createOrders multi-leg", () => {
  const tpLeg = {
    side: "sell", trigger: "price_above", price: 3000,
    baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC",
  };
  const slLeg = {
    side: "sell", trigger: "price_below", price: 1500,
    baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC",
  };

  it("accepts a two-leg bracket", () => {
    const spec = parseOnFillSpec({ type: "createOrders", specs: [tpLeg, slLeg] });
    expect(spec.type).toBe("createOrders");
    expect(onFillLegs(spec)).toHaveLength(2);
  });

  it("rejects an empty specs array", () => {
    expect(() => parseOnFillSpec({ type: "createOrders", specs: [] }))
      .toThrow(/non-empty array/);
  });

  it("rejects missing specs for createOrders", () => {
    expect(() => parseOnFillSpec({ type: "createOrders" }))
      .toThrow(/non-empty array/);
  });

  it(`caps legs at MAX_ON_FILL_LEGS (${4})`, () => {
    const specs = Array.from({ length: MAX_ON_FILL_LEGS + 1 }, () => ({ ...tpLeg }));
    expect(() => parseOnFillSpec({ type: "createOrders", specs }))
      .toThrow(/at most 4 legs/);
  });

  it("errors carry the leg index in the path", () => {
    let msg = "";
    try {
      parseOnFillSpec({ type: "createOrders", specs: [tpLeg, { side: "wrong", trigger: "wrong" }] });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/specs\[1\]\.side/);
    expect(msg).toMatch(/specs\[1\]\.trigger/);
    expect(msg).not.toMatch(/specs\[0\]/);
  });

  it("rejects a non-object leg", () => {
    expect(() => parseOnFillSpec({ type: "createOrders", specs: [tpLeg, "nope"] }))
      .toThrow(/specs\[1\]: must be an object/);
  });
});

describe("autoHookGroup — bracket pairing rules", () => {
  const leg = (group?: string) => ({
    side: "sell" as const, trigger: "price_above" as const, price: 3000,
    baseAmount: "1", base: "ETH", quote: "USDC", group,
  });

  it("single leg → no auto group", () => {
    expect(autoHookGroup([leg()], "schedule#7", 3)).toBeUndefined();
  });

  it("two group-less legs → shared generated group", () => {
    expect(autoHookGroup([leg(), leg()], "schedule#7", 3)).toBe("hook-schedule-7-3");
  });

  it("any explicit group disables auto-pairing", () => {
    expect(autoHookGroup([leg("mine"), leg()], "schedule#7", 3)).toBeUndefined();
  });
});

describe("renderOnFillSpec — multi-leg substitution", () => {
  it("substitutes placeholders in every leg", () => {
    const out = renderOnFillSpec({
      spec: {
        type: "createOrders",
        specs: [
          { side: "sell", trigger: "price_above", price: 3000, baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC" },
          { side: "sell", trigger: "price_below", price: 1500, baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC" },
        ],
      },
      fill: { baseAmount: "0.5", quoteAmount: "1000", fillPriceUsd: 2000, txHash: "0xabc", fireNumber: 2 },
    });
    const legs = onFillLegs(out);
    expect(legs[0]!.baseAmount).toBe("0.5");
    expect(legs[1]!.baseAmount).toBe("0.5");
  });

  it("unknown-var errors carry the specs[i] path", () => {
    let msg = "";
    try {
      renderOnFillSpec({
        spec: {
          type: "createOrders",
          specs: [
            { side: "sell", trigger: "price_above", price: 3000, baseAmount: "1", base: "ETH", quote: "USDC" },
            { side: "sell", trigger: "price_below", price: 1500, baseAmount: "{{filled.bogus}}", base: "ETH", quote: "USDC" },
          ],
        },
        fill: { baseAmount: "1", quoteAmount: "100", fillPriceUsd: 2000, txHash: "0xabc", fireNumber: 1 },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/specs\[1\]/);
    expect(msg).toMatch(/bogus/);
  });
});

describe("validateOnFillSpec — multi-leg create-time gate", () => {
  it("accepts a valid TP+SL bracket", () => {
    const { spec } = validateOnFillSpec({
      raw: {
        type: "createOrders",
        specs: [
          { side: "sell", trigger: "price_above", price: 3000, baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC" },
          { side: "sell", trigger: "price_below", price: 1500, baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC" },
        ],
      },
      chain: "base", account: "default", config: loadConfig(),
      baseAddress: ETH, quoteAddress: USDC,
    });
    expect(onFillLegs(spec)).toHaveLength(2);
  });

  it("semantic failures name the failing leg", () => {
    expect(() =>
      validateOnFillSpec({
        raw: {
          type: "createOrders",
          specs: [
            { side: "sell", trigger: "price_above", price: 3000, baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC" },
            { side: "sell", trigger: "price_below", baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC" },
          ],
        },
        chain: "base", account: "default", config: loadConfig(),
        baseAddress: ETH, quoteAddress: USDC,
      }),
    ).toThrow(/specs\[1\]\.price/);
  });
});

describe("executeOnFillHook — multi-leg brackets", () => {
  const fill = {
    baseAmount: "0.5",
    quoteAmount: "1000",
    fillPriceUsd: 2000,
    txHash: "0x" + "cd".repeat(32),
    fireNumber: 3,
  };
  const bracket = {
    type: "createOrders" as const,
    specs: [
      { side: "sell" as const, trigger: "price_above" as const, price: 3000, baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC" },
      { side: "sell" as const, trigger: "price_below" as const, price: 1500, baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC" },
    ],
  };

  it("creates both legs sharing the auto-OCO group", () => {
    const result = executeOnFillHook({
      spec: bracket,
      fill,
      chain: "base", account: "default",
      baseAddress: ETH, quoteAddress: USDC,
      strategyTag: "playbook:7",
      paper: false,
      parentRef: "schedule#7",
      config: loadConfig(),
    });
    expect(result.orderIds).toHaveLength(2);
    expect(result.orderId).toBe(result.orderIds[0]);

    const tp = getOrderById(result.orderIds[0]!);
    const sl = getOrderById(result.orderIds[1]!);
    expect(tp?.trigger_type).toBe("price_above");
    expect(sl?.trigger_type).toBe("price_below");
    // The bracket pairing: both legs in one generated OCO group.
    expect(tp?.group_id).toBe("hook-schedule-7-3");
    expect(sl?.group_id).toBe("hook-schedule-7-3");
    // Both sized to the fill.
    expect(tp?.base_amount).toBe("0.5");
    expect(sl?.base_amount).toBe("0.5");
    // Strategy tag propagates to every leg.
    expect(tp?.strategy).toBe("playbook:7");
    expect(sl?.strategy).toBe("playbook:7");
    // Default notes carry the leg counter.
    expect(tp?.note).toMatch(/leg 1\/2/);
    expect(sl?.note).toMatch(/leg 2\/2/);
  });

  it("an explicit leg group is kept verbatim (auto-pairing off)", () => {
    const result = executeOnFillHook({
      spec: {
        type: "createOrders",
        specs: [
          { ...bracket.specs[0]!, group: "my-bracket" },
          { ...bracket.specs[1]! },
        ],
      },
      fill,
      chain: "base", account: "default",
      baseAddress: ETH, quoteAddress: USDC,
      strategyTag: null,
      paper: false,
      parentRef: "schedule#7",
      config: loadConfig(),
    });
    const tp = getOrderById(result.orderIds[0]!);
    const sl = getOrderById(result.orderIds[1]!);
    expect(tp?.group_id).toBe("my-bracket");
    expect(sl?.group_id).toBeNull();
  });

  it("single-leg hooks get no auto group", () => {
    const result = executeOnFillHook({
      spec: { type: "createOrder", spec: { ...bracket.specs[0]! } },
      fill,
      chain: "base", account: "default",
      baseAddress: ETH, quoteAddress: USDC,
      strategyTag: null,
      paper: false,
      parentRef: "schedule#7",
      config: loadConfig(),
    });
    expect(getOrderById(result.orderId)?.group_id).toBeNull();
  });

  it("hook orders inherit the parent's paper flag", () => {
    const result = executeOnFillHook({
      spec: bracket,
      fill,
      chain: "base", account: "default",
      baseAddress: ETH, quoteAddress: USDC,
      strategyTag: null,
      paper: true,
      parentRef: "schedule#9",
      config: loadConfig(),
    });
    for (const id of result.orderIds) {
      expect(getOrderById(id)?.paper).toBe(1);
    }
  });

  it("real-mode parents spawn real-mode legs (paper=0)", () => {
    const result = executeOnFillHook({
      spec: { type: "createOrder", spec: { ...bracket.specs[0]! } },
      fill,
      chain: "base", account: "default",
      baseAddress: ETH, quoteAddress: USDC,
      strategyTag: null,
      paper: false,
      parentRef: "order#4",
      config: loadConfig(),
    });
    expect(getOrderById(result.orderId)?.paper).toBe(0);
  });

  it("a failing leg rolls back the already-created legs (all-or-nothing)", () => {
    const db = openDb();
    let err = "";
    try {
      executeOnFillHook({
        spec: {
          type: "createOrders",
          specs: [
            { ...bracket.specs[0]! },
            // trailing without trailPct → createOrderRow rejects leg 2
            { side: "sell", trigger: "trailing", baseAmount: "{{filled.baseAmount}}", base: "ETH", quote: "USDC" },
          ],
        },
        fill,
        chain: "base", account: "default",
        baseAddress: ETH, quoteAddress: USDC,
        strategyTag: null,
        paper: false,
        parentRef: "schedule#7",
        config: loadConfig(),
      });
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toMatch(/leg 2\/2 failed/);
    expect(err).toMatch(/Rolled back 1 already-created leg/);
    // Leg 1 was cancelled, not deleted (forensics), and nothing stays active.
    const active = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'active'`).get() as { n: number };
    expect(active.n).toBe(0);
    const cancelled = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'cancelled'`).get() as { n: number };
    expect(cancelled.n).toBe(1);
  });
});
