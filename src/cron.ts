// Standard 5-field UTC cron parser + nextRun calculator.
//
// Format:  m h dom mon dow
//   m   minute      0-59
//   h   hour        0-23
//   dom day-of-month 1-31
//   mon month       1-12
//   dow day-of-week 0-6 (0=Sunday, 7 normalized to 0)
//
// Each field supports:
//   *           every value
//   N           exact value
//   N,M,O       list
//   N-M         range (inclusive)
//   */S         step over the whole range
//   N-M/S       step over a range
//
// Day-of-month / day-of-week interaction follows the POSIX convention:
//   - If both fields are wildcards, every day matches.
//   - If exactly one is restricted, only that one matches.
//   - If BOTH are restricted, the match is an OR — `0 10 1 * 1` fires on
//     the 1st of every month AND every Monday. Standard cron lore; gotcha
//     for first-time cron users but consistent with Vixie cron / Linux.
//
// Macros: @hourly @daily @weekly @monthly @yearly @annually. These compile
// to a canonical 5-field expression so the rest of the pipeline stays
// uniform.
//
// All computation is UTC. Operators that want local-time scheduling either
// shift the cron expression themselves (a 7am-Eastern daily run becomes
// `0 11 * * *` in UTC half the year and `0 12 * * *` the other half — DST
// is the operator's problem; we don't pretend) or use the `every` shorthand.
//
// Performance contract: parseCron is allocation-bounded by O(field-cardinality)
// and is called once per schedule create + at engine boot. nextRun is called
// once per active schedule per engine tick (typically once per minute) so
// keeping it ≤ 1ms per call matters — the implementation is a deterministic
// minute-by-minute walk capped at a safety horizon (366 days ahead) so a
// pathological "Feb 30" expression returns null rather than spinning forever.

import { ToolError } from "./errors.js";

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the dayOfMonth field was explicitly restricted (not `*`). */
  domRestricted: boolean;
  /** True when the dayOfWeek field was explicitly restricted (not `*`). */
  dowRestricted: boolean;
  /** Original expression — surfaced in error messages + serialization. */
  source: string;
}

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

interface FieldSpec {
  name: "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 },
];

/**
 * Parse a cron expression into a ParsedCron set-representation.
 *
 * Throws ToolError("INVALID_PARAMS") on malformed input — the entry point
 * for this is operator-supplied text (CLI flag / MCP arg), so the error
 * message names the offending field for actionable feedback.
 */
export function parseCron(expr: string): ParsedCron {
  const trimmed = expr.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new ToolError("INVALID_PARAMS", "cron expression is empty.");
  }
  const expanded = MACROS[trimmed] ?? trimmed;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new ToolError(
      "INVALID_PARAMS",
      `cron expression "${expr}" must have 5 fields (m h dom mon dow). Macros: ${Object.keys(MACROS).join(" ")}.`,
    );
  }
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    sets.push(parseField(parts[i], FIELDS[i]));
  }
  // Normalize day-of-week: cron accepts 0 and 7 for Sunday. Collapse to 0
  // so the matcher only checks one form.
  if (sets[4].has(7)) {
    sets[4].delete(7);
    sets[4].add(0);
  }
  return {
    minute: sets[0],
    hour: sets[1],
    dayOfMonth: sets[2],
    month: sets[3],
    dayOfWeek: sets[4],
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
    source: expr.trim(),
  };
}

function parseField(raw: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  // Comma-separated list at the top level; each element is itself either a
  // wildcard, a number, a range, or a step.
  for (const piece of raw.split(",")) {
    parsePiece(piece, spec, out);
  }
  if (out.size === 0) {
    throw new ToolError("INVALID_PARAMS", `cron field "${spec.name}" produced no valid values from "${raw}".`);
  }
  return out;
}

function parsePiece(piece: string, spec: FieldSpec, out: Set<number>): void {
  // Step: split on '/'. Left side is "range or wildcard"; right is the step
  // size. `*/5` and `1-30/5` and `1/5` (single value + step is uncommon
  // but accepted by Linux cron — interpreted as range [N, max]).
  let stepStr: string | undefined;
  let rangePart = piece;
  if (piece.includes("/")) {
    const splitAt = piece.indexOf("/");
    rangePart = piece.slice(0, splitAt);
    stepStr = piece.slice(splitAt + 1);
  }
  let step = 1;
  if (stepStr !== undefined) {
    if (!/^\d+$/.test(stepStr)) {
      throw new ToolError("INVALID_PARAMS", `cron field "${spec.name}": invalid step "${stepStr}" in "${piece}".`);
    }
    step = parseInt(stepStr, 10);
    if (step <= 0) {
      throw new ToolError("INVALID_PARAMS", `cron field "${spec.name}": step must be > 0 in "${piece}".`);
    }
  }

  let lo: number;
  let hi: number;
  if (rangePart === "*") {
    lo = spec.min;
    hi = spec.max;
  } else if (rangePart.includes("-")) {
    const [loStr, hiStr] = rangePart.split("-", 2);
    if (!/^\d+$/.test(loStr) || !/^\d+$/.test(hiStr)) {
      throw new ToolError("INVALID_PARAMS", `cron field "${spec.name}": invalid range "${rangePart}".`);
    }
    lo = parseInt(loStr, 10);
    hi = parseInt(hiStr, 10);
    if (lo > hi) {
      throw new ToolError("INVALID_PARAMS", `cron field "${spec.name}": range start ${lo} > end ${hi}.`);
    }
  } else {
    if (!/^\d+$/.test(rangePart)) {
      throw new ToolError("INVALID_PARAMS", `cron field "${spec.name}": invalid value "${rangePart}".`);
    }
    lo = parseInt(rangePart, 10);
    // Linux-cron quirk: "5/15" means "from 5 to max, step 15". When step
    // is supplied without an explicit range, the upper bound widens.
    hi = stepStr !== undefined ? spec.max : lo;
  }

  // Day-of-week accepts 7 = Sunday, so the user-facing range is 0-7 even
  // though the canonical storage is 0-6 (normalized after parse).
  if (lo < spec.min || hi > spec.max) {
    throw new ToolError(
      "INVALID_PARAMS",
      `cron field "${spec.name}": value out of range [${spec.min}-${spec.max}] in "${piece}".`,
    );
  }
  for (let v = lo; v <= hi; v += step) out.add(v);
}

// ── nextRun ──────────────────────────────────────────────────

/** Safety horizon for the minute-by-minute walk. Set wide enough to cover
 *  any plausible legitimate cron — including Feb 29, which only fires every
 *  4 years, so the from-now lookahead must span >2 years (worst case: just
 *  past Feb 29 of a leap year → 4 years to the next). 5 years is comfortable.
 *  Pathological expressions like "0 0 30 2 *" (Feb 30, never matches) hit
 *  this bound and we throw rather than loop. */
const NEXT_RUN_MAX_MINUTES_AHEAD = 5 * 366 * 24 * 60;

/**
 * Return the next UTC datetime strictly AFTER `from` at which the
 * expression fires. Returns null when no match exists within the safety
 * horizon (one year ahead — adequate for any real schedule).
 *
 * The "strictly after" semantic matters for the engine: when a schedule
 * just fired at minute M, the next nextRun(parsed, M) call must yield
 * M+1+something, never M itself, otherwise the engine would re-fire on
 * every tick within the same minute.
 *
 * Implementation: minute-by-minute walk. Standard cron implementations
 * use field-by-field jumping for speed; for our workload (≤ thousands of
 * schedules, polled every ~30s, parsed sets are O(60)) the simpler walk
 * is fast enough and easier to verify against the OR-of-dom-dow rule.
 */
export function nextRun(parsed: ParsedCron, from: Date): Date {
  // Start at the NEXT minute after `from`. We add exactly 60_000 - (ms-into-minute) so
  // a non-aligned timestamp jumps to the minute boundary; an already-aligned one
  // advances by a full minute.
  const t0 = from.getTime();
  const msIntoMinute = t0 % 60_000;
  let cursor = new Date(t0 - msIntoMinute + 60_000);

  for (let i = 0; i < NEXT_RUN_MAX_MINUTES_AHEAD; i++) {
    if (matchesAt(parsed, cursor)) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  // Pathological expression. Surface as a cleared schedule rather than
  // looping indefinitely.
  throw new ToolError(
    "INVALID_PARAMS",
    `cron expression "${parsed.source}" yields no firing within ${NEXT_RUN_MAX_MINUTES_AHEAD / (24 * 60)} days — check for impossible combinations (e.g. "0 0 30 2 *", Feb 30).`,
  );
}

/** Pure predicate: does the parsed expression match this UTC moment? */
export function matchesAt(parsed: ParsedCron, t: Date): boolean {
  const minute = t.getUTCMinutes();
  const hour = t.getUTCHours();
  const dom = t.getUTCDate();
  const mon = t.getUTCMonth() + 1; // 0-indexed in JS, 1-indexed in cron
  const dow = t.getUTCDay();
  if (!parsed.minute.has(minute)) return false;
  if (!parsed.hour.has(hour)) return false;
  if (!parsed.month.has(mon)) return false;
  // POSIX day-of-month / day-of-week interaction. When both fields are
  // restricted (non-wildcard), match is OR. When only one is restricted,
  // only that field gates. When neither, both pass (so accept).
  if (parsed.domRestricted && parsed.dowRestricted) {
    if (!parsed.dayOfMonth.has(dom) && !parsed.dayOfWeek.has(dow)) return false;
  } else if (parsed.domRestricted) {
    if (!parsed.dayOfMonth.has(dom)) return false;
  } else if (parsed.dowRestricted) {
    if (!parsed.dayOfWeek.has(dow)) return false;
  }
  return true;
}

// ── duration shorthand ───────────────────────────────────────

/**
 * Compile an "every <duration>" shorthand into a cron expression.
 *
 *   every 1h  → "0 * * * *"   (top of every hour)
 *   every 30m → "(slash-30) * * * *"
 *   every 1d  → "0 0 * * *"   (midnight UTC daily)
 *   every 7d  → "0 0 * * 0"   (Sunday midnight — exact 7-day cadence)
 *
 * The shorthand is convenience; for finer control operators pass `--cron`
 * directly. We deliberately reject ambiguous durations:
 *   - sub-minute resolution ("every 30s") rejected — cron is 1-min granularity
 *   - "every 2h" cleanly maps to `0 *\/2 * * *`; "every 3h" too; but "every
 *     5h" doesn't cleanly map because 24 isn't divisible by 5 (you'd get
 *     5,10,15,20 hours then a 4-hour gap at midnight). We reject such cases
 *     with a clear message so operators know to use --cron explicitly.
 *
 * Returns the cron expression string. Always validate by re-parsing — the
 * caller does this once at schedule create time.
 */
export function durationToCron(raw: string): string {
  const m = /^(\d+)([smhd])$/i.exec(raw.trim());
  if (!m) {
    throw new ToolError(
      "INVALID_PARAMS",
      `--every "${raw}" — use formats like 30m, 1h, 6h, 1d, 7d.`,
    );
  }
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (n <= 0) {
    throw new ToolError("INVALID_PARAMS", `--every must be positive (got "${raw}").`);
  }
  if (unit === "s") {
    throw new ToolError(
      "INVALID_PARAMS",
      `--every "${raw}" — sub-minute granularity not supported by cron. Use 1m or larger.`,
    );
  }
  if (unit === "m") {
    // Reject any minute count that doesn't divide an hour evenly — `*/7`
    // would fire at 0,7,14,21,28,35,42,49,56 then wrap to 0 with a 4-min
    // gap at the hour boundary. That uneven cadence almost certainly
    // surprises the operator; if they really want it they can pass --cron.
    if (n > 1 && 60 % n !== 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--every ${raw} doesn't evenly divide an hour — use --cron explicitly for irregular cadences.`,
      );
    }
    if (n >= 60) return "0 * * * *";
    return `*/${n} * * * *`;
  }
  if (unit === "h") {
    if (n > 1 && 24 % n !== 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--every ${raw} doesn't evenly divide a day — use --cron explicitly for irregular cadences.`,
      );
    }
    if (n >= 24) return "0 0 * * *";
    if (n === 1) return "0 * * * *";
    return `0 */${n} * * *`;
  }
  // unit === "d". Use day-of-month step. NOTE: cron's */N stepping over
  // day-of-month restarts at the beginning of each month, so `every 7d`
  // fires on the 1st, 8th, 15th, 22nd, 29th — then jumps to the 1st of
  // the next month (a 2-3 day gap). For exact 7-day cadence, operators
  // should use `0 0 * * 0` (weekly) which is what most "every 7d" people
  // actually mean. We document this in the help text.
  if (n === 1) return "0 0 * * *";
  if (n === 7) return "0 0 * * 0"; // ergonomic alias for weekly
  return `0 0 */${n} * *`;
}
