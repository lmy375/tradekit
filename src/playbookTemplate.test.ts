/**
 * Playbook template tests.
 *
 * Layers:
 *   1. Detection (isTemplate)
 *   2. Vars-declaration parser (parseTemplateVars)
 *   3. Resolution (resolveVars) — defaults + required + type validation
 *   4. Rendering (renderTemplate) — whole-field replacement vs
 *      embedded interpolation, recursive walk, error collection
 *   5. Orchestrator (renderPlaybookTemplate) — full pipeline
 *   6. CLI helpers (parseVarFlags, coerceVarsByDeclaration)
 *   7. Integration with parsePlaybookSpec (round-trip)
 */

import { describe, it, expect } from "vitest";
import {
  isTemplate,
  parseTemplateVars,
  resolveVars,
  renderTemplate,
  renderPlaybookTemplate,
  parseVarFlags,
  coerceVarsByDeclaration,
} from "./playbookTemplate.js";
import { parsePlaybookSpec } from "./playbooks.js";
import { ToolError } from "./errors.js";

// ── detection ────────────────────────────────────────────────

describe("isTemplate", () => {
  it("detects vars section", () => {
    expect(isTemplate({ vars: { X: { type: "string" } }, strategies: [] })).toBe(true);
  });
  it("detects embedded placeholders without vars section", () => {
    expect(isTemplate({ name: "{{X}}", strategies: [] })).toBe(true);
  });
  it("returns false for plain playbook", () => {
    expect(isTemplate({ name: "plain", strategies: [{ type: "order" }] })).toBe(false);
  });
  it("returns false for non-object input", () => {
    expect(isTemplate("string")).toBe(false);
    expect(isTemplate(null)).toBe(false);
    expect(isTemplate([])).toBe(false);
  });
});

// ── vars declarations parser ─────────────────────────────────

describe("parseTemplateVars", () => {
  it("accepts a valid declarations block", () => {
    const decls = parseTemplateVars({
      ASSET: { type: "string", required: true, description: "Base symbol" },
      TRAIL_PCT: { type: "number", default: 5 },
      DRY_RUN: { type: "boolean", default: false },
    });
    expect(decls.ASSET).toEqual({ type: "string", required: true, description: "Base symbol" });
    expect(decls.TRAIL_PCT).toEqual({ type: "number", default: 5 });
    expect(decls.DRY_RUN).toEqual({ type: "boolean", default: false });
  });

  it("rejects bad var name", () => {
    expect(() => parseTemplateVars({ "lower-name": { type: "string" } })).toThrow(/var name must match/);
    expect(() => parseTemplateVars({ "1NUMERIC": { type: "string" } })).toThrow(/var name must match/);
  });

  it("rejects unknown type", () => {
    expect(() => parseTemplateVars({ X: { type: "color" } })).toThrow(/type:/);
  });

  it("rejects default of wrong type", () => {
    expect(() => parseTemplateVars({ X: { type: "number", default: "hello" } })).toThrow(/default: must be number/);
  });

  it("rejects required not-boolean", () => {
    expect(() => parseTemplateVars({ X: { type: "string", required: "yes" } })).toThrow(/required: must be boolean/);
  });

  it("collects multiple errors into one message", () => {
    let msg = "";
    try {
      parseTemplateVars({
        "bad-name": { type: "string" },
        OK: { type: "color" },
        X: { type: "number", default: "abc" },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/var name must match/);
    expect(msg).toMatch(/type:/);
    expect(msg).toMatch(/default:/);
  });

  it("rejects non-object declarations section", () => {
    expect(() => parseTemplateVars("hello")).toThrow(/must be an object/);
    expect(() => parseTemplateVars([])).toThrow(/must be an object/);
  });
});

// ── resolveVars ──────────────────────────────────────────────

describe("resolveVars", () => {
  it("applies defaults when value not provided", () => {
    const r = resolveVars({
      declared: { TRAIL_PCT: { type: "number", default: 5 } },
      provided: {},
    });
    expect(r.resolved.TRAIL_PCT).toBe(5);
    expect(r.warnings).toEqual([]);
  });

  it("overrides defaults with provided values", () => {
    const r = resolveVars({
      declared: { TRAIL_PCT: { type: "number", default: 5 } },
      provided: { TRAIL_PCT: 10 },
    });
    expect(r.resolved.TRAIL_PCT).toBe(10);
  });

  it("errors when required var is missing", () => {
    expect(() =>
      resolveVars({
        declared: { ASSET: { type: "string", required: true } },
        provided: {},
      }),
    ).toThrow(/vars\.ASSET: required/);
  });

  it("required vars satisfied by defaults", () => {
    const r = resolveVars({
      declared: { ASSET: { type: "string", required: true, default: "ETH" } },
      provided: {},
    });
    expect(r.resolved.ASSET).toBe("ETH");
  });

  it("errors on type mismatch", () => {
    expect(() =>
      resolveVars({
        declared: { PRICE: { type: "number", required: true } },
        provided: { PRICE: "not a number" },
      }),
    ).toThrow(/expected number, got string/);
  });

  it("undeclared provided vars become warnings, not errors", () => {
    const r = resolveVars({
      declared: { ASSET: { type: "string", default: "ETH" } },
      provided: { UNDECLARED: "value" },
    });
    expect(r.resolved.UNDECLARED).toBe("value");
    expect(r.warnings).toContainEqual(expect.stringMatching(/UNDECLARED.*not declared/));
  });

  it("omits non-required, non-defaulted, non-provided vars from result", () => {
    const r = resolveVars({
      declared: { OPTIONAL: { type: "string" } },
      provided: {},
    });
    expect(Object.keys(r.resolved)).not.toContain("OPTIONAL");
  });

  it("collects multiple errors", () => {
    let msg = "";
    try {
      resolveVars({
        declared: {
          A: { type: "string", required: true },
          B: { type: "number", required: true },
          C: { type: "number" },
        },
        provided: { C: "bad" },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/vars\.A: required/);
    expect(msg).toMatch(/vars\.B: required/);
    expect(msg).toMatch(/vars\.C: expected number/);
  });
});

// ── renderTemplate ───────────────────────────────────────────

describe("renderTemplate — whole-field substitution preserves type", () => {
  it("number stays number", () => {
    const out = renderTemplate({
      spec: { trailPct: "{{TRAIL_PCT}}" },
      vars: { TRAIL_PCT: 5 },
    });
    expect(out).toEqual({ trailPct: 5 });
  });

  it("boolean stays boolean", () => {
    const out = renderTemplate({
      spec: { enabled: "{{FLAG}}" },
      vars: { FLAG: true },
    });
    expect(out).toEqual({ enabled: true });
  });

  it("string stays string", () => {
    const out = renderTemplate({
      spec: { base: "{{ASSET}}" },
      vars: { ASSET: "WBTC" },
    });
    expect(out).toEqual({ base: "WBTC" });
  });

  it("whitespace inside braces is tolerated", () => {
    const out = renderTemplate({
      spec: { v: "{{  TRAIL_PCT  }}" },
      vars: { TRAIL_PCT: 5 },
    });
    expect(out).toEqual({ v: 5 });
  });
});

describe("renderTemplate — embedded substitution interpolates", () => {
  it("string with var becomes string", () => {
    const out = renderTemplate({
      spec: { name: "{{ASSET}}-bracket" },
      vars: { ASSET: "WBTC" },
    });
    expect(out).toEqual({ name: "WBTC-bracket" });
  });

  it("number var coerced via String() when embedded", () => {
    const out = renderTemplate({
      spec: { name: "trail-{{PCT}}pct" },
      vars: { PCT: 5 },
    });
    expect(out).toEqual({ name: "trail-5pct" });
  });

  it("multiple placeholders in one string", () => {
    const out = renderTemplate({
      spec: { name: "{{A}}-vs-{{B}}" },
      vars: { A: "ETH", B: "USDC" },
    });
    expect(out).toEqual({ name: "ETH-vs-USDC" });
  });
});

describe("renderTemplate — recursive walk", () => {
  it("walks nested objects + arrays", () => {
    const out = renderTemplate({
      spec: {
        name: "{{NAME}}",
        strategies: [
          { id: "trail", trailPct: "{{TRAIL_PCT}}", base: "{{ASSET}}" },
          { id: "dca", quoteAmount: "{{DCA}}", base: "{{ASSET}}" },
        ],
      },
      vars: { NAME: "test", TRAIL_PCT: 5, ASSET: "ETH", DCA: 100 },
    });
    expect(out).toEqual({
      name: "test",
      strategies: [
        { id: "trail", trailPct: 5, base: "ETH" },
        { id: "dca", quoteAmount: 100, base: "ETH" },
      ],
    });
  });

  it("preserves non-string scalars verbatim", () => {
    const out = renderTemplate({
      spec: { a: 42, b: true, c: null, d: 3.14 },
      vars: {},
    });
    expect(out).toEqual({ a: 42, b: true, c: null, d: 3.14 });
  });

  it("strips top-level `vars` declarations section", () => {
    const out = renderTemplate({
      spec: {
        name: "{{ASSET}}",
        vars: { ASSET: { type: "string" } },
        strategies: [],
      },
      vars: { ASSET: "ETH" },
    });
    expect(out).toEqual({ name: "ETH", strategies: [] });
  });

  it("does NOT strip nested `vars` keys (only top-level)", () => {
    const out = renderTemplate({
      spec: { strategies: [{ vars: { meta: "{{X}}" } }] },
      vars: { X: "kept" },
    });
    expect(out).toEqual({ strategies: [{ vars: { meta: "kept" } }] });
  });
});

describe("renderTemplate — missing vars", () => {
  it("errors on undefined var reference", () => {
    expect(() =>
      renderTemplate({
        spec: { name: "{{UNKNOWN}}" },
        vars: {},
      }),
    ).toThrow(/references undefined variable/);
  });

  it("collects multiple missing-var errors", () => {
    let msg = "";
    try {
      renderTemplate({
        spec: { a: "{{A}}", b: "prefix-{{B}}-suffix" },
        vars: {},
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/undefined variable "A"/);
    expect(msg).toMatch(/undefined variable "B"/);
  });

  it("error path names the JSON location", () => {
    let msg = "";
    try {
      renderTemplate({
        spec: { strategies: [{ baseAmount: "{{AMOUNT}}" }] },
        vars: {},
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/strategies\[0\]\.baseAmount/);
  });
});

// ── orchestrator ─────────────────────────────────────────────

describe("renderPlaybookTemplate", () => {
  it("passes through non-template spec unchanged", () => {
    const spec = { name: "plain", strategies: [{ type: "order" }] };
    const result = renderPlaybookTemplate({ raw: spec });
    expect(result.wasTemplate).toBe(false);
    expect(result.rendered).toEqual(spec);
  });

  it("errors when --var supplied for non-template spec", () => {
    const spec = { name: "plain", strategies: [] };
    expect(() =>
      renderPlaybookTemplate({ raw: spec, provided: { X: "value" } }),
    ).toThrow(/no template variables/);
  });

  it("renders a template with defaults", () => {
    const spec = {
      name: "{{NAME}}",
      vars: {
        NAME: { type: "string", default: "default-name" },
      },
      strategies: [],
    };
    const result = renderPlaybookTemplate({ raw: spec });
    expect(result.wasTemplate).toBe(true);
    expect(result.rendered).toEqual({ name: "default-name", strategies: [] });
    expect(result.vars.NAME).toBe("default-name");
  });

  it("renders a template with provided override", () => {
    const spec = {
      name: "{{NAME}}",
      vars: {
        NAME: { type: "string", default: "default-name" },
      },
      strategies: [],
    };
    const result = renderPlaybookTemplate({ raw: spec, provided: { NAME: "custom" } });
    expect(result.rendered).toEqual({ name: "custom", strategies: [] });
    expect(result.vars.NAME).toBe("custom");
  });

  it("template with only embedded placeholders (no vars section)", () => {
    const spec = { name: "{{X}}", strategies: [] };
    const result = renderPlaybookTemplate({ raw: spec, provided: { X: "value" } });
    expect(result.wasTemplate).toBe(true);
    expect(result.rendered).toEqual({ name: "value", strategies: [] });
    expect(result.warnings).toContainEqual(expect.stringMatching(/X.*not declared/));
  });
});

// ── CLI helpers ──────────────────────────────────────────────

describe("parseVarFlags", () => {
  it("parses NAME=VALUE pairs", () => {
    expect(parseVarFlags(["ASSET=ETH", "PRICE=2000"])).toEqual({
      ASSET: "ETH",
      PRICE: "2000",
    });
  });

  it("preserves '=' in value", () => {
    expect(parseVarFlags(["EXPR=a=b"])).toEqual({ EXPR: "a=b" });
  });

  it("rejects missing '='", () => {
    expect(() => parseVarFlags(["INVALID"])).toThrow(/must be NAME=VALUE/);
  });

  it("rejects empty name", () => {
    expect(() => parseVarFlags(["=value"])).toThrow(/must be NAME=VALUE/);
  });

  it("rejects bad var name format", () => {
    expect(() => parseVarFlags(["lower=value"])).toThrow(/must match/);
    expect(() => parseVarFlags(["1NUM=value"])).toThrow(/must match/);
  });

  it("later assignments overwrite earlier", () => {
    expect(parseVarFlags(["A=first", "A=second"])).toEqual({ A: "second" });
  });
});

describe("coerceVarsByDeclaration", () => {
  const declarations = {
    ASSET: { type: "string" as const },
    PRICE: { type: "number" as const },
    DRY_RUN: { type: "boolean" as const },
  };

  it("strings pass through", () => {
    const result = coerceVarsByDeclaration({ ASSET: "ETH" }, declarations);
    expect(result.ASSET).toBe("ETH");
  });

  it("string '5' coerces to number 5 for number-typed var", () => {
    const result = coerceVarsByDeclaration({ PRICE: "5" }, declarations);
    expect(result.PRICE).toBe(5);
    expect(typeof result.PRICE).toBe("number");
  });

  it("string 'true' / '1' coerces to boolean true", () => {
    expect(coerceVarsByDeclaration({ DRY_RUN: "true" }, declarations).DRY_RUN).toBe(true);
    expect(coerceVarsByDeclaration({ DRY_RUN: "TRUE" }, declarations).DRY_RUN).toBe(true);
    expect(coerceVarsByDeclaration({ DRY_RUN: "1" }, declarations).DRY_RUN).toBe(true);
    expect(coerceVarsByDeclaration({ DRY_RUN: "false" }, declarations).DRY_RUN).toBe(false);
    expect(coerceVarsByDeclaration({ DRY_RUN: "0" }, declarations).DRY_RUN).toBe(false);
  });

  it("errors on non-numeric for number-typed var", () => {
    expect(() => coerceVarsByDeclaration({ PRICE: "abc" }, declarations)).toThrow(/expected number/);
  });

  it("errors on non-boolean for boolean-typed var", () => {
    expect(() => coerceVarsByDeclaration({ DRY_RUN: "maybe" }, declarations)).toThrow(/expected boolean/);
  });

  it("accepts already-typed values from --vars-file", () => {
    const result = coerceVarsByDeclaration({ PRICE: 100, DRY_RUN: true }, declarations);
    expect(result.PRICE).toBe(100);
    expect(result.DRY_RUN).toBe(true);
  });

  it("rejects mismatched typed values", () => {
    expect(() => coerceVarsByDeclaration({ PRICE: "hello" as never }, declarations)).toThrow();
  });

  it("undeclared vars pass through without coercion", () => {
    const result = coerceVarsByDeclaration({ UNDECLARED: "raw" }, declarations);
    expect(result.UNDECLARED).toBe("raw");
  });
});

// ── end-to-end integration with parsePlaybookSpec ────────────

describe("template → parsePlaybookSpec round-trip", () => {
  it("renders a realistic bracket template", () => {
    const template = {
      name: "{{ASSET}}-bracket-dca",
      description: "trailing-stop + bracket + DCA for {{ASSET}}",
      chain: "base",
      vars: {
        ASSET:       { type: "string", required: true },
        QUOTE:       { type: "string", default: "USDC" },
        TRAIL_PCT:   { type: "number", default: 5 },
        TP_PRICE:    { type: "number", required: true },
        SL_PRICE:    { type: "number", required: true },
        BASE_AMOUNT: { type: "number", required: true },
        DCA_USD:     { type: "number", default: 100 },
      },
      strategies: [
        { id: "trail", type: "order", side: "sell", trigger: "trailing",
          trailPct: "{{TRAIL_PCT}}", baseAmount: "{{BASE_AMOUNT}}",
          base: "{{ASSET}}", quote: "{{QUOTE}}" },
        { id: "tp", type: "order", side: "sell", trigger: "price_above",
          price: "{{TP_PRICE}}", baseAmount: "{{BASE_AMOUNT}}",
          base: "{{ASSET}}", quote: "{{QUOTE}}", group: "bracket" },
        { id: "sl", type: "order", side: "sell", trigger: "price_below",
          price: "{{SL_PRICE}}", baseAmount: "{{BASE_AMOUNT}}",
          base: "{{ASSET}}", quote: "{{QUOTE}}", group: "bracket" },
        { id: "dca", type: "schedule", side: "buy", every: "7d",
          quoteAmount: "{{DCA_USD}}", base: "{{ASSET}}", quote: "{{QUOTE}}" },
      ],
    };
    const { rendered } = renderPlaybookTemplate({
      raw: template,
      provided: {
        ASSET: "WBTC",
        TP_PRICE: 130000,
        SL_PRICE: 80000,
        BASE_AMOUNT: 0.1,
      },
    });
    // The rendered output should parse cleanly as a playbook spec.
    const parsed = parsePlaybookSpec(rendered);
    expect(parsed.name).toBe("WBTC-bracket-dca");
    expect(parsed.strategies.length).toBe(4);
    const trail = parsed.strategies[0];
    expect(trail.type).toBe("order");
    if (trail.type === "order") {
      expect(trail.trailPct).toBe(5);
      expect(trail.baseAmount).toBe(0.1);
      expect(trail.base).toBe("WBTC");
      expect(trail.quote).toBe("USDC");
    }
    const tp = parsed.strategies[1];
    if (tp.type === "order") {
      expect(tp.price).toBe(130000);
      expect(tp.group).toBe("bracket");
    }
  });

  it("template missing required vars throws BEFORE parsePlaybookSpec sees it", () => {
    const template = {
      name: "{{ASSET}}",
      vars: { ASSET: { type: "string", required: true } },
      strategies: [],
    };
    let err: { code?: string; message?: string } | undefined;
    try {
      renderPlaybookTemplate({ raw: template });
    } catch (e) {
      err = e as { code?: string; message?: string };
    }
    expect(err?.code).toBe("INVALID_PARAMS");
    expect(err?.message).toMatch(/vars\.ASSET: required/);
  });
});

// ── safety: input not mutated ────────────────────────────────

describe("renderTemplate immutability", () => {
  it("does not mutate the input spec", () => {
    const spec = { name: "{{X}}", strategies: [{ id: "{{Y}}" }] };
    const before = JSON.parse(JSON.stringify(spec));
    renderTemplate({ spec, vars: { X: "name", Y: "id" } });
    expect(spec).toEqual(before);
  });

  it("can be called multiple times with different vars", () => {
    const spec = { name: "{{X}}", strategies: [] };
    const out1 = renderTemplate({ spec, vars: { X: "first" } });
    const out2 = renderTemplate({ spec, vars: { X: "second" } });
    expect(out1).toEqual({ name: "first", strategies: [] });
    expect(out2).toEqual({ name: "second", strategies: [] });
  });
});

// ── ToolError surface ────────────────────────────────────────

describe("error codes", () => {
  it("missing required var throws ToolError with INVALID_PARAMS", () => {
    let err: ToolError | undefined;
    try {
      resolveVars({
        declared: { X: { type: "string", required: true } },
        provided: {},
      });
    } catch (e) {
      err = e as ToolError;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect(err?.code).toBe("INVALID_PARAMS");
  });
});
