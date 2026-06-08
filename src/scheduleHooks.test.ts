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
    expect(spec.spec.side).toBe("sell");
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
    expect(spec.spec.trigger).toBe("price_above");
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
    ).toThrow(/createOrder.*supported/);
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
    expect(out.spec.baseAmount).toBe("0.04");
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
    expect(out.spec.price).toBe(2500);
    expect(typeof out.spec.price).toBe("number");
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
    expect(out.spec.trailPct).toBe(3);
    expect(typeof out.spec.trailPct).toBe("number");
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
    expect(out.spec.group).toBe("bracket-7");
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
    expect(out.spec.note).toBe("bought 0.04 ETH at $2500");
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
      config: loadConfig(),
    });
    expect(result.orderId).toBeGreaterThan(0);

    const order = getOrderById(result.orderId);
    expect(order).not.toBeNull();
    expect(order?.side).toBe("sell");
    expect(order?.trigger_type).toBe("trailing");
    expect(order?.trail_pct).toBe(10);
    expect(order?.base_amount).toBe("0.04");
    expect(order?.note).toMatch(/auto-created by schedule on_fill/);
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
        config: loadConfig(),
      }),
    ).toThrow(/unknown variable/);
  });
});
