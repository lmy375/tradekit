/**
 * Playbook templating — `{{var}}` substitution layer.
 *
 * Templates are a thin pre-processor over playbook JSON. A template
 * file looks identical to a regular playbook spec EXCEPT:
 *   - it may carry a `vars` declarations section listing the
 *     substitution variables, their types, defaults, and required
 *     flags
 *   - any string value anywhere in the JSON may contain `{{NAME}}`
 *     references which get replaced at render time
 *
 * Rendering is two-phase:
 *   1. resolveVars: merge supplied vars (CLI --var + --vars-file) on
 *      top of declared defaults. Validate types. Collect every
 *      violation into one error message — same UX as the playbook
 *      parser's "fix once" philosophy.
 *   2. renderTemplate: recursive JSON walker. Strings that are
 *      ENTIRELY a single placeholder (`"{{X}}"`) get replaced with
 *      the var's raw typed value (number stays number, boolean
 *      stays boolean). Strings with EMBEDDED placeholders
 *      (`"prefix {{X}} suffix"`) get string-interpolated.
 *
 * This split matters: the playbook parser is strict-typed (it
 * rejects strings where numbers are expected). Whole-field
 * substitution preserves the type; embedded substitution doesn't.
 * Without this distinction operators would have to wrap every
 * numeric template value in a string and the playbook parser would
 * reject the rendered output.
 *
 * Output: a rendered JSON object that is structurally identical to
 * a hand-written playbook spec — the `vars` section is stripped,
 * every `{{...}}` is replaced. The renderer never mutates input
 * objects; safe to call multiple times on the same template with
 * different var bags.
 *
 * Pre-processor architecture. The playbook layer (playbooks.ts) is
 * UNAWARE of templating. The pipeline:
 *
 *   raw JSON → renderPlaybookTemplate(vars) → parsePlaybookSpec → deploy
 *
 * Files without a `vars` section AND without `{{` substitutions
 * skip rendering entirely (pure backward compat for the v1 playbook
 * format).
 */

import { ToolError } from "./errors.js";

// ── types ────────────────────────────────────────────────────

export type VarType = "string" | "number" | "boolean";
export type VarValue = string | number | boolean;

export interface VarDeclaration {
  type: VarType;
  default?: VarValue;
  required?: boolean;
  description?: string;
}

export type VarDeclarations = Record<string, VarDeclaration>;
export type VarBag = Record<string, VarValue>;

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Match `{{NAME}}` with optional whitespace inside braces. */
const PLACEHOLDER_RX = /\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g;
/** True iff the value is a string that consists ENTIRELY of a single
 *  placeholder (whitespace permitted around the var name). When true,
 *  the substituted value's type is preserved. */
const WHOLE_FIELD_RX = /^\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}$/;

// ── detection ────────────────────────────────────────────────

/**
 * Does this JSON look like a template? Two signals — either suffices:
 *   - has a `vars` declarations section
 *   - contains a `{{NAME}}` placeholder anywhere
 *
 * Cheap stringify scan; the alternative (full tree walk) costs more
 * than serializing for the typical < 10KB playbook spec.
 */
export function isTemplate(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if (obj.vars && typeof obj.vars === "object" && !Array.isArray(obj.vars)) return true;
  return JSON.stringify(raw).includes("{{");
}

// ── parsing the vars declarations ────────────────────────────

export function parseTemplateVars(raw: unknown): VarDeclarations {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolError("INVALID_PARAMS", `Template "vars" section must be an object.`);
  }
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];
  const out: VarDeclarations = {};
  for (const [name, decl] of Object.entries(r)) {
    if (!NAME_PATTERN.test(name)) {
      errors.push(`vars.${name}: var name must match ${NAME_PATTERN}`);
      continue;
    }
    if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
      errors.push(`vars.${name}: declaration must be an object`);
      continue;
    }
    const d = decl as Record<string, unknown>;
    if (d.type !== "string" && d.type !== "number" && d.type !== "boolean") {
      errors.push(`vars.${name}.type: must be "string" | "number" | "boolean" (got ${JSON.stringify(d.type)})`);
      continue;
    }
    const out1: VarDeclaration = { type: d.type };
    if (d.required != null) {
      if (typeof d.required !== "boolean") {
        errors.push(`vars.${name}.required: must be boolean`);
      } else {
        out1.required = d.required;
      }
    }
    if (d.description != null) {
      if (typeof d.description !== "string") {
        errors.push(`vars.${name}.description: must be string`);
      } else {
        out1.description = d.description;
      }
    }
    if (d.default !== undefined) {
      if (!matchesType(d.default, d.type)) {
        errors.push(`vars.${name}.default: must be ${d.type} (got ${typeof d.default})`);
      } else {
        out1.default = d.default as VarValue;
      }
    }
    out[name] = out1;
  }
  if (errors.length) {
    throw new ToolError("INVALID_PARAMS", `Invalid template vars section:\n  ${errors.join("\n  ")}`);
  }
  return out;
}

function matchesType(v: unknown, t: VarType): boolean {
  if (t === "string") return typeof v === "string";
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  if (t === "boolean") return typeof v === "boolean";
  return false;
}

// ── resolve provided + declared into a usable var bag ────────

/**
 * Merge provided vars on top of declared defaults. Validate each
 * resulting var against its declared type. Vars provided WITHOUT a
 * declaration are accepted with a warning (collected in `warnings`)
 * because operators frequently iterate on templates by adding vars
 * without remembering to update the declarations.
 *
 * Required vars without a value (and without a default) throw
 * INVALID_PARAMS. Type mismatches do too. All violations collected
 * into one message.
 */
export interface ResolveVarsResult {
  resolved: VarBag;
  /** Vars that were supplied but not declared. Not an error, but
   *  surfaced in `validate` output so operators can catch typos. */
  warnings: string[];
}

export function resolveVars(args: {
  declared: VarDeclarations;
  provided: Record<string, unknown>;
}): ResolveVarsResult {
  const { declared, provided } = args;
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: VarBag = {};

  // First pass: every declared var must either have a default or a
  // provided value (when required); type must match declared type.
  for (const [name, decl] of Object.entries(declared)) {
    let value: unknown;
    if (Object.prototype.hasOwnProperty.call(provided, name)) {
      value = provided[name];
    } else if (decl.default !== undefined) {
      value = decl.default;
    } else if (decl.required) {
      errors.push(`vars.${name}: required (declared type=${decl.type})${decl.description ? ` — ${decl.description}` : ""}`);
      continue;
    } else {
      // Undeclared default + not provided + not required → omit from
      // resolved bag. Substitution will error out cleanly if any
      // placeholder references it.
      continue;
    }
    if (!matchesType(value, decl.type)) {
      errors.push(`vars.${name}: expected ${decl.type}, got ${typeof value} (${JSON.stringify(value)})`);
      continue;
    }
    resolved[name] = value as VarValue;
  }

  // Second pass: vars provided but not declared are warnings (typo
  // safety) — they're still passed through to substitution.
  for (const name of Object.keys(provided)) {
    if (Object.prototype.hasOwnProperty.call(declared, name)) continue;
    const value = provided[name];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      errors.push(`vars.${name}: undeclared var must be string | number | boolean (got ${typeof value})`);
      continue;
    }
    warnings.push(`vars.${name}: provided but not declared in template — typo?`);
    resolved[name] = value;
  }

  if (errors.length) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Failed to resolve template variables:\n  ${errors.join("\n  ")}`,
    );
  }
  return { resolved, warnings };
}

// ── render: walk the JSON tree, substitute ───────────────────

/**
 * Walk the spec JSON, substituting placeholders. Returns a NEW
 * structure (input is not mutated).
 *
 * - String values matching WHOLE_FIELD_RX → replaced with raw typed
 *   value. The output type matches the var's declared type, so a
 *   `"trailPct": "{{N}}"` template renders to `"trailPct": 5`.
 * - String values with embedded placeholders → string interpolation
 *   with String(var) coercion.
 * - Missing var references → collected into errors; throw INVALID_PARAMS.
 * - Non-string / non-object / non-array values pass through.
 *
 * The `vars` top-level key is stripped from the output — that's
 * metadata, not part of the playbook spec.
 */
export function renderTemplate(args: {
  spec: unknown;
  vars: VarBag;
}): unknown {
  const errors: string[] = [];
  const visited = new Set<string>(); // track which vars were referenced (debug only)

  function substring(value: string, path: string): unknown {
    // Whole-field placeholder → preserve var's type.
    const wholeMatch = WHOLE_FIELD_RX.exec(value);
    if (wholeMatch) {
      const name = wholeMatch[1];
      if (!Object.prototype.hasOwnProperty.call(args.vars, name)) {
        errors.push(`${path}: references undefined variable ${JSON.stringify(name)}`);
        return value; // placeholder preserved for forensic clarity
      }
      visited.add(name);
      return args.vars[name];
    }
    // Embedded placeholder(s) → string interpolation.
    let saw = false;
    const result = value.replace(PLACEHOLDER_RX, (m, name: string) => {
      saw = true;
      if (!Object.prototype.hasOwnProperty.call(args.vars, name)) {
        errors.push(`${path}: references undefined variable ${JSON.stringify(name)}`);
        return m;
      }
      visited.add(name);
      const v = args.vars[name];
      return String(v);
    });
    return saw ? result : value;
  }

  function walk(node: unknown, path: string): unknown {
    if (node === null) return null;
    if (typeof node === "string") return substring(node, path);
    if (typeof node === "number" || typeof node === "boolean") return node;
    if (Array.isArray(node)) {
      return node.map((v, i) => walk(v, `${path}[${i}]`));
    }
    if (typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (path === "" && k === "vars") continue; // strip declarations section
        out[k] = walk(v, path === "" ? k : `${path}.${k}`);
      }
      return out;
    }
    return node;
  }

  const result = walk(args.spec, "");
  if (errors.length) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Template rendering failed:\n  ${errors.join("\n  ")}`,
    );
  }
  return result;
}

// ── orchestrator: full template → rendered spec ──────────────

export interface RenderPlaybookTemplateResult {
  /** Rendered spec — ready to pass to parsePlaybookSpec. */
  rendered: unknown;
  /** Resolved var bag (defaults + provided merged). Surfaced in
   *  `validate` output for operator review. */
  vars: VarBag;
  /** Non-fatal warnings (e.g. undeclared vars supplied). */
  warnings: string[];
  /** Var declarations parsed from the template (or empty when
   *  template had no `vars` section). */
  declarations: VarDeclarations;
  /** True iff the input was detected as a template; false means it
   *  passed through unchanged. */
  wasTemplate: boolean;
}

/**
 * One-call orchestrator. Detects whether the input is a template,
 * parses its `vars` declarations, merges provided vars on top of
 * defaults, validates types, and renders the spec.
 *
 * For non-template input: passes through verbatim with
 * wasTemplate=false. Lets callers run the orchestrator unconditionally
 * without checking detection upfront.
 */
export function renderPlaybookTemplate(args: {
  raw: unknown;
  provided?: Record<string, unknown>;
}): RenderPlaybookTemplateResult {
  const provided = args.provided ?? {};
  if (!isTemplate(args.raw)) {
    if (Object.keys(provided).length > 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--var / --vars-file supplied but the spec file has no template variables (no \`vars\` section and no \`{{...}}\` placeholders). Remove the vars OR convert the file into a template.`,
      );
    }
    return {
      rendered: args.raw,
      vars: {},
      warnings: [],
      declarations: {},
      wasTemplate: false,
    };
  }

  const obj = args.raw as Record<string, unknown>;
  const declarations = obj.vars != null ? parseTemplateVars(obj.vars) : {};
  const { resolved, warnings } = resolveVars({ declared: declarations, provided });
  const rendered = renderTemplate({ spec: args.raw, vars: resolved });
  return {
    rendered,
    vars: resolved,
    warnings,
    declarations,
    wasTemplate: true,
  };
}

// ── CLI helpers (extracted for testability) ──────────────────

/**
 * Parse a list of `NAME=VALUE` strings (typed by the caller) into a
 * map. Values are passed through as STRINGS — type coercion happens
 * during resolveVars based on the declared type. This means
 * `--var COUNT=5` produces `{ COUNT: "5" }`, and if `COUNT` is
 * declared as a number, resolveVars will coerce-or-error.
 *
 * Conflict policy: later --var assignments overwrite earlier ones
 * for the same name. --vars-file values are merged at a lower
 * precedence by the caller.
 */
export function parseVarFlags(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of raw) {
    const eq = item.indexOf("=");
    if (eq <= 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--var must be NAME=VALUE (got "${item}"). NAME must match ${NAME_PATTERN}.`,
      );
    }
    const name = item.slice(0, eq);
    const value = item.slice(eq + 1);
    if (!NAME_PATTERN.test(name)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--var name "${name}" must match ${NAME_PATTERN} (uppercase, underscore, digits; starts with uppercase).`,
      );
    }
    out[name] = value;
  }
  return out;
}

/**
 * Coerce a string from `--var NAME=VALUE` to the declared type. Used
 * by the CLI before calling resolveVars — number-typed vars from
 * --var arrive as strings ("5"), but resolveVars expects numbers.
 *
 * Booleans accept: "true" / "false" / "1" / "0" (case-insensitive).
 * Numbers: parseFloat with finite check.
 * Strings: pass through.
 */
export function coerceVarsByDeclaration(
  provided: Record<string, string | number | boolean>,
  declarations: VarDeclarations,
): Record<string, VarValue> {
  const errors: string[] = [];
  const out: Record<string, VarValue> = {};
  for (const [name, raw] of Object.entries(provided)) {
    const decl = declarations[name];
    if (!decl) {
      // Undeclared — leave as-is; resolveVars will surface as a
      // warning + still accept the value.
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        out[name] = raw;
      } else {
        errors.push(`--var ${name}: undeclared values must be string | number | boolean`);
      }
      continue;
    }
    if (typeof raw !== "string") {
      // Already typed (came from --vars-file as a JSON number/bool).
      if (matchesType(raw, decl.type)) {
        out[name] = raw;
      } else {
        errors.push(`--var ${name}: expected ${decl.type}, got ${typeof raw}`);
      }
      continue;
    }
    // String-typed input → coerce to declared type.
    if (decl.type === "string") {
      out[name] = raw;
    } else if (decl.type === "number") {
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) {
        errors.push(`--var ${name}: expected number, got non-numeric string ${JSON.stringify(raw)}`);
      } else {
        out[name] = n;
      }
    } else if (decl.type === "boolean") {
      const lower = raw.toLowerCase();
      if (lower === "true" || lower === "1") out[name] = true;
      else if (lower === "false" || lower === "0") out[name] = false;
      else errors.push(`--var ${name}: expected boolean (true|false|1|0), got ${JSON.stringify(raw)}`);
    }
  }
  if (errors.length) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Failed to coerce template variables:\n  ${errors.join("\n  ")}`,
    );
  }
  return out;
}
