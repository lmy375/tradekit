// Shared text helpers (formatting + simple parsing) used by CLI display, MCP, and
// web. Tiny by design — only depends on ./errors for the typed throw on bad input.

import { ToolError } from "./errors.js";

/**
 * Collapse whitespace and truncate a free-form message for stable single-line display.
 * Used everywhere we render upstream error messages (RPC errors, zod issues, viem
 * stack traces) into bounded tables / log lines. Pre-iter197 the same pattern was
 * inlined at 7+ sites; centralizing makes it easy to evolve (e.g. add a "[truncated]"
 * suffix later) without hunting.
 *
 * Behavior:
 *  - undefined/null → empty string
 *  - collapses runs of any whitespace (\\n, \\r, \\t, multiple spaces) to a single space
 *  - trims leading/trailing whitespace
 *  - if longer than `max`, slices to (max - 3) and appends "..." (so total stays ≤ max)
 */
export function compactMessage(msg: string | null | undefined, max: number): string {
  if (msg == null) return "";
  const flat = msg.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 3)) + "...";
}

/**
 * Parse a CLI/MCP/web date-or-datetime filter input into a canonical ISO timestamp.
 *
 * Accepts:
 *   - undefined / null                      → undefined
 *   - "2026-05-28"                          → "2026-05-28T00:00:00Z" (date-only → start of day UTC)
 *   - "2026-05-28T12:00:00Z" / RFC3339 etc. → passes through (validated by Date.parse)
 *   - "today" / "yesterday"                 → iter356: start of that day (UTC)
 *   - "1h" / "24h" / "7d" / "30d"           → iter356: now minus that duration
 *
 * Throws ToolError("INVALID_PARAMS") on unparseable input.
 *
 * Extracted iter242: the parse-and-validate pattern was inlined at 4 sites
 * (web /api/audit, mcp/admin-tools audit + prune, cli/inspect audit). Centralizing
 * lets us evolve the accepted format once — iter356 honoured iter242's TODO and
 * added the relative shortcuts that operators reach for most often.
 */
export function parseDateFilter(input: string | null | undefined, flagName: string): string | undefined {
  if (input == null) return undefined;
  const trimmed = input.trim().toLowerCase();
  // Iter371: explicit empty-string handling. Pre-iter371 `--since ""` (or `--since=`)
  // fell through to the iso-parse branch and threw "Invalid --since:" with a trailing
  // colon and no value — operator couldn't tell whether their input was lost or rejected.
  // Now: if the operator clearly passed an empty value, say so directly. (We don't treat
  // it as "no filter" — that's what omitting the flag entirely does; explicit empty is
  // most likely a shell-quoting mistake worth surfacing.)
  if (trimmed === "") {
    throw new ToolError(
      "INVALID_PARAMS",
      `${flagName} was passed but its value is empty. Omit the flag entirely to skip filtering, or supply a value (YYYY-MM-DD, today, 24h, 7d, etc).`,
    );
  }

  // Calendar-day anchors. "today" = start-of-day-UTC; "yesterday" = same minus 24h.
  if (trimmed === "today" || trimmed === "yesterday") {
    const now = new Date();
    const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (trimmed === "yesterday") utc.setUTCDate(utc.getUTCDate() - 1);
    return utc.toISOString();
  }
  // Relative durations: "Nh" or "Nd". Different semantic from yesterday — these
  // are "now minus N hours/days" sliding windows, not calendar boundaries.
  const rel = /^(\d+)([hd])$/.exec(trimmed);
  if (rel) {
    const n = parseInt(rel[1], 10);
    if (n <= 0) {
      throw new ToolError("INVALID_PARAMS", `Invalid ${flagName}: ${input} — relative duration must be positive.`);
    }
    const unitMs = rel[2] === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return new Date(Date.now() - n * unitMs).toISOString();
  }

  const iso = /T/.test(input) ? input : `${input}T00:00:00Z`;
  if (Number.isNaN(Date.parse(iso))) {
    throw new ToolError("INVALID_PARAMS", `Invalid ${flagName}: ${input}`);
  }
  return iso;
}

/**
 * Tiny Levenshtein distance + closest-match for typo suggestions. Returns the closest
 * candidate within edit distance 2 (catches single typos and transpositions) or null.
 *
 * Iter343: moved from cli/helpers.ts to break the src/→src/cli/ reverse-import that
 * would have been needed for config.ts to surface "did you mean" on UNKNOWN_CHAIN.
 * Bounded by the longest candidate name (~15 chars), so the O(n*m) cost is irrelevant —
 * runs only on the unknown-name error path.
 */
export function closestMatch(input: string, candidates: string[]): string | null {
  if (!input) return null;
  let best: { name: string; dist: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(input.toLowerCase(), c.toLowerCase());
    if (best == null || d < best.dist) best = { name: c, dist: d };
  }
  return best && best.dist <= 2 ? best.name : null;
}

/**
 * Order-preserving dedupe for string arrays. Iter347 extracted so the CLI's
 * parseChainsFlag (iter346) and web's /api/holdings ?chains= parser share one
 * implementation — both need "first-seen-wins" so an operator's `--chains base,arb,base`
 * keeps base in front of arb (the order the operator typed) rather than alphabetizing.
 */
export function dedupeFirstSeen<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of items) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
