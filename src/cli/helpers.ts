// Shared helpers used by every CLI command module. Kept tight and import-free of the
// command-specific modules so the helper layer stays at the bottom of the dependency
// graph.

import { createLogger, type LogLevel } from "../logger.js";
import { promptPassword } from "../cli.js";
import { ToolError } from "../errors.js";

export { prompt, promptPassword } from "../cli.js";

/**
 * Build a logger for CLI commands respecting the standard verbosity flags:
 *   --quiet     → silent stderr
 *   --verbose   → debug stderr (mirrors everything)
 *   (default)   → warn+ on stderr (clean console output)
 * The file log at ~/.tradekit/server.log always receives DEBUG and above.
 */
export function makeCliLogger(flags: Record<string, string>) {
  // Iter334: detect the contradiction up front. Pre-iter334 `--quiet --verbose` silently
  // resolved to silent (the if-chain checked quiet first), so an operator who typed both
  // — easy to do via shell aliases that already include one and a manual additional flag —
  // got the opposite of what they expected with no signal. The cost of explicit
  // INVALID_PARAMS is one re-run; the cost of silent loss is a missed warning or debug
  // line they were specifically looking for.
  if (flags["quiet"] === "true" && flags["verbose"] === "true") {
    throw new ToolError(
      "INVALID_PARAMS",
      "--quiet and --verbose are contradictory; pick one (default is warn-level).",
    );
  }
  let level: LogLevel = "warn";
  if (flags["quiet"] === "true") level = "silent";
  else if (flags["verbose"] === "true") level = "debug";
  return createLogger({ stderrLevel: level });
}

/** Resolve the wallet password from --pass, $WALLET_PASS, or an interactive prompt. */
export async function requirePassword(flags: Record<string, string>): Promise<string> {
  if (flags["pass"]) return flags["pass"];
  const envPass = process.env.WALLET_PASS;
  if (envPass) return envPass;
  return promptPassword("Enter wallet password: ");
}

/** Iter792: module-level compact-mode flag. withWatch flips it to true when
 *  --json is set so the per-tick output is true JSONL (one line per record,
 *  no embedded newlines) — required by strict line-by-line stream parsers
 *  like `jq -c .` or Vector / Fluent Bit ingesters. One-shot --json (no
 *  watch) keeps the pretty-printed multi-line form for human readability. */
let compactJsonMode = false;
export function setCompactJsonMode(compact: boolean): void {
  compactJsonMode = compact;
}

/** Stable bigint-aware JSON printer for `--json` paths. */
export function printJson(x: unknown): void {
  const indent = compactJsonMode ? undefined : 2;
  console.log(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), indent));
}

/**
 * Closest-match for command typo suggestions. Re-exports the shared helper from
 * format.ts so both src/ and src/cli/ use the same Levenshtein implementation.
 * Iter343: extracted to format.ts to break the would-be reverse import when
 * config.ts started surfacing chain typo suggestions.
 */
import { closestMatch, dedupeFirstSeen } from "../format.js";
export const closestCommand = closestMatch;

/**
 * Build an INVALID_PARAMS error for a sub-action typo, with a "did you mean" hint when
 * the typo is within edit distance 2 of a valid action. Shared so every multi-action
 * command (wallet / account / trade / config / token) gives consistent feedback.
 */
export function subcommandError(command: string, action: string | undefined, valid: string[]): ToolError {
  if (action == null) {
    return new ToolError(
      "INVALID_PARAMS",
      `${command} requires an action. Valid: ${valid.join(", ")}.`,
      { details: { command, providedAction: null, validActions: valid } },
    );
  }
  const guess = closestCommand(action, valid);
  const hint = guess ? ` Did you mean '${guess}'?` : ` Valid: ${valid.join(", ")}.`;
  return new ToolError(
    "INVALID_PARAMS",
    `Unknown ${command} action: ${action}.${hint}`,
    { details: { command, providedAction: action, validActions: valid, suggestion: guess } },
  );
}

/**
 * Sanity-check a freshly-typed password BEFORE encrypting a new keystore with it. The
 * keystore's KDF (scrypt) is strong against parallel brute force only when the secret
 * itself isn't trivial. Pre-iter137 a user could create a wallet "secured" by an empty
 * string or single character — anyone with the (now 0600) keystore could still crack
 * those in seconds. We refuse empty (always a mistake) and warn loudly on weak.
 *
 * Returns the validated password (unchanged). For interactive flows the warnings
 * print on stderr; for non-interactive callers they appear in the logger.
 *
 * Operator override: pass `allowWeak: true` to skip everything (CI/test scenarios).
 */
export function checkPasswordStrength(
  pass: string,
  opts: { allowWeak?: boolean } = {},
): { warnings: string[] } {
  if (!opts.allowWeak && pass.length === 0) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Password cannot be empty. Use a long passphrase or set WALLET_PASS to a strong secret.",
    );
  }
  const warnings: string[] = [];
  if (!opts.allowWeak) {
    if (pass.length < 8) warnings.push(`Password is only ${pass.length} characters — recommend at least 12.`);
    if (pass.length >= 8 && pass.length < 12) warnings.push("Password is shorter than 12 chars — consider lengthening.");
    if (/^\d+$/.test(pass)) warnings.push("Password is digits-only — easily brute-forced.");
    if (/^[a-zA-Z]+$/.test(pass)) warnings.push("Password is letters-only — add digits/symbols for entropy.");
    if (["password", "12345678", "qwerty", "letmein", "tradekit"].includes(pass.toLowerCase())) {
      warnings.push("Password is in the top-1000 common-passwords list — change before relying on this wallet.");
    }
  }
  return { warnings };
}

/**
 * Parse a `--chains a,b,c` style flag into a clean array of chain names. Handles:
 *   - whitespace around items (`--chains "base, arbitrum"` → ["base", "arbitrum"])
 *   - empty entries (`--chains base,,arbitrum` → ["base", "arbitrum"])
 *   - case normalization (`--chains Base,ARBITRUM` → ["base", "arbitrum"])
 *   - typo rejection: if `validNames` is provided, any entry not in the set throws
 *     INVALID_PARAMS with the typo + the valid list. Pre-iter134, typos like
 *     `--chains bse,arbitrum` silently dropped "bse" deep in the call stack and the
 *     user only got partial results with no signal that anything was missing.
 *
 * Returns undefined when the flag wasn't supplied.
 */
export function parseChainsFlag(
  raw: string | undefined,
  validNames?: readonly string[],
): string[] | undefined {
  if (raw == null) return undefined;
  // Iter261: "all" shorthand expands to validNames (built-ins + any custom chains the
  // caller passed). Pre-iter261 only doctor recognized "all" via a duplicated
  // expansion in cli/admin.ts; gas and holdings rejected it as "Unknown chain".
  // Centralizing here so every --chains-aware command honors the same shorthand.
  if (raw.trim().toLowerCase() === "all") {
    if (!validNames) {
      throw new ToolError("INVALID_PARAMS", "--chains all is only supported where a chain set is available.");
    }
    // Iter366: dedupe the "all" expansion too. Pre-iter366 if a caller built validNames
    // by concatenating built-ins + custom chains and a custom name happened to lowercase
    // to a built-in name (defensive — shouldn't happen with iter97's chain-key normalization
    // but iter315's empty-shells were a sign that defensive de-dup is worth it everywhere),
    // `--chains all` would run that chain twice. Cheap to apply the iter347 dedupe here too.
    return dedupeFirstSeen(validNames.map((c) => c.toLowerCase()));
  }
  const rawParsed = raw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
  if (rawParsed.length === 0) {
    throw new ToolError("INVALID_PARAMS", `Invalid --chains "${raw}" — expected a comma-separated list.`);
  }
  // Iter346/347: deduplicate while preserving first-seen order. Pre-iter346 a typo'd
  // `--chains base,arbitrum,base` (easy to do via shell history / copy-paste) ran the
  // RPC checks twice for "base", emitted two audit rows for the same chain, and made
  // commands like `holdings --chains all,base` (operator overcautiously appending the
  // active chain) silently waste a roundtrip. Iter347 extracted the dedupe helper to
  // format.ts so the web's /api/holdings ?chains= parser shares the implementation.
  const parsed = dedupeFirstSeen(rawParsed);
  if (validNames) {
    const valid = new Set(validNames.map((c) => c.toLowerCase()));
    const unknown = parsed.filter((c) => !valid.has(c));
    if (unknown.length > 0) {
      // Iter346: suggest the closest known chain for the first unknown token — same UX
      // as iter343's resolveProfile UNKNOWN_CHAIN, but at the multi-chain entry point
      // (gas / holdings / doctor / reconcile) so a typo'd list doesn't dead-end either.
      const validList = [...valid];
      const suggestion = closestMatch(unknown[0], validList);
      const suggestionNote = suggestion ? ` Did you mean "${suggestion}"?` : "";
      throw new ToolError(
        "INVALID_PARAMS",
        `Unknown chain(s) in --chains: ${unknown.join(", ")}.${suggestionNote} Valid: ${validList.join(", ")}.`,
        { details: { unknownChains: unknown, validChains: validList, suggestion } },
      );
    }
  }
  return parsed;
}

/**
 * Parse and validate a non-negative decimal CLI flag (e.g. --per-tx-limit 100.5).
 * Same defensive shape as parseIntFlag — strict regex pre-check rejects partial-numeric
 * strings ("12abc"). parseFloat alone would silently truncate those. Floats accept dot
 * or trailing dot ("12." → 12). Exponential notation deliberately not allowed; the
 * config schema doesn't use it and accepting it would mask copy-paste accidents.
 */
export function parseFloatFlag(
  raw: string | undefined,
  label: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (raw == null) return undefined;
  if (!/^-?\d+(\.\d*)?$/.test(raw) && !/^-?\.\d+$/.test(raw)) {
    throw new ToolError("INVALID_PARAMS", `Invalid ${label} "${raw}" — expected a decimal number.`);
  }
  const n = parseFloat(raw);
  const min = opts.min ?? 0;
  if (n < min) {
    throw new ToolError("INVALID_PARAMS", `Invalid ${label} ${n} — must be ≥ ${min}.`);
  }
  if (opts.max != null && n > opts.max) {
    throw new ToolError("INVALID_PARAMS", `Invalid ${label} ${n} — must be ≤ ${opts.max}.`);
  }
  return n;
}

/**
 * Parse and validate a non-negative integer CLI flag (e.g. --limit 100, --tail 50,
 * --port 3030). Returns undefined when the flag wasn't supplied. Rejects:
 *   - non-numeric strings (`--limit abc`) — pre-iter131 these became NaN, then SQL
 *     LIMIT NaN coerced to 0 or behaved oddly; user got an empty result with no
 *     diagnostic.
 *   - floats (`--limit 3.5`) — parseInt would have silently truncated.
 *   - negative values (`--limit -1`) — SQLite LIMIT -1 returns ALL rows, a security
 *     footgun for an unbounded scan.
 *   - values above an optional `max` (defends `--limit 9999999999`).
 *
 * Always throws ToolError("INVALID_PARAMS") on bad input so the boundary catches the
 * typo rather than a deeper layer surfacing a confusing error.
 */
export function parseIntFlag(
  raw: string | undefined,
  label: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (raw == null) return undefined;
  // Tighten before parseInt: parseInt("12abc") would return 12 silently.
  if (!/^-?\d+$/.test(raw)) {
    throw new ToolError("INVALID_PARAMS", `Invalid ${label} "${raw}" — expected an integer.`);
  }
  const n = parseInt(raw, 10);
  const min = opts.min ?? 0;
  if (n < min) {
    throw new ToolError("INVALID_PARAMS", `Invalid ${label} ${n} — must be ≥ ${min}.`);
  }
  if (opts.max != null && n > opts.max) {
    throw new ToolError("INVALID_PARAMS", `Invalid ${label} ${n} — must be ≤ ${opts.max}.`);
  }
  return n;
}

/**
 * Single-character status marker for `trades` / `wallet view` recent-trades rows.
 * Visible only on non-success rows so failed/pending trades pop out when an operator
 * scans a long history — pre-iter125 a failed trade differed from a success only in
 * the trailing status word, which was easy to miss at a glance.
 *
 * Markers: `!` failed, `~` pending, ` ` success (intentionally invisible — alignment
 * stays consistent without adding noise to the common case).
 */
export function tradeStatusMarker(status: string): string {
  if (status === "failed") return "!";
  if (status === "pending") return "~";
  return " ";
}

/**
 * Iter659: resolve the strategy tag for a trade command. `--strategy` wins;
 * absent that, fall back to the TRADEKIT_STRATEGY env. Whitespace-only env
 * values collapse to undefined so a stray space in shell config doesn't tag
 * trades with " ". Pure function so it's unit-testable without booting the
 * trade pipeline.
 */
export function resolveStrategy(
  flagValue: string | undefined,
  envValue: string | undefined,
): string | undefined {
  if (flagValue !== undefined) return flagValue;
  const trimmed = envValue?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate a tx-hash CLI argument and return it as a typed `0x${string}`. Catches typos
 * (wrong length, non-hex chars, missing 0x prefix) up-front with a clear INVALID_PARAMS
 * message — pre-iter121 a typo'd hash hit the RPC and surfaced as a misleading
 * "TX_NOT_FOUND" or an opaque viem stack trace, leaving the user unable to distinguish
 * "I typoed" from "the tx is genuinely missing on this chain".
 *
 * Format: 0x-prefixed, exactly 64 hex chars (32-byte transaction hash).
 */
export function assertTxHash(raw: string, label = "tx hash"): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Invalid ${label} "${raw}" — expected 0x-prefixed 64 hex chars (32 bytes).`,
    );
  }
  return raw as `0x${string}`;
}

/**
 * Escape a value for inclusion as a CSV field per RFC 4180. Quotes the field whenever
 * it contains a comma, double-quote, CR, or LF, and doubles any embedded quotes inside
 * the quoted output. The previous inline implementation only checked for commas, so a
 * trade note like `say "hi"` or anything containing a newline silently corrupted the
 * row (Excel column mis-alignment, awk-style splits producing wrong field counts).
 *
 * Exported (not inlined) so it can be unit-tested independently of database fixtures.
 */
export function csvField(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // Iter454: CSV-injection mitigation. Excel/LibreOffice/Numbers treat a cell that
  // starts with =, +, -, @, tab, or CR as a formula. Notes are agent-writable
  // (and operator-supplied) free text — a malicious payload like `=cmd|'/c calc'!A1`
  // could execute when the operator opens the exported file in Excel. Prepend a
  // single quote (the canonical OWASP mitigation) so the cell stays literal text.
  // Quote stripping at import time is the operator's job; we err on the side of
  // safety since execution-on-open is the worse failure mode.
  // Iter472: known false-positive — a leading `-` on a NEGATIVE NUMBER (e.g.,
  // String(-100n) → "-100") gets the leading-quote treatment, making Excel treat
  // it as text and breaking SUM/AVG formulas. TRADE_COLUMNS doesn't currently
  // produce negative values (gas_used/gas_price_wei are positive by chain semantics;
  // amounts/prices are formatted positive via formatUnits with direction tracked
  // separately). If a future column becomes signed, the export would surface that
  // as text — fix it at the source (output magnitude + sign as separate columns)
  // rather than narrowing the iter454 mitigation, which would re-open the injection
  // hole via a `-cmd|...` payload.
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * If `--watch [N]` is set, re-run `fn` every N seconds (default 5), clearing the
 * screen between iterations. Quits cleanly on Ctrl-C. Otherwise just runs `fn` once.
 */
export async function withWatch(
  flags: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const watchVal = flags["watch"];
  if (!watchVal) {
    await fn();
    return;
  }
  // Pre-iter142 raw parseInt(watchVal) was used: `--watch abc` produced NaN, and
  // setTimeout(NaN) coerces to a 1ms refresh — the watch loop spun the CPU and
  // flooded RPCs. Cap upper at 3600s to prevent `--watch 99999999` from looking
  // like a stuck process.
  const interval =
    watchVal === "true" || watchVal === ""
      ? 5
      : parseIntFlag(watchVal, "--watch", { min: 1, max: 3600 }) ?? 5;
  let stopped = false;
  const onSig = () => {
    stopped = true;
    process.stdout.write("\n");
  };
  process.on("SIGINT", onSig);
  // When --json is also set, the operator is most likely piping output to jq / a
  // monitoring tool — clearing the screen and printing a banner each iteration would
  // corrupt the JSON stream. In that case skip the banner; each fn() invocation
  // emits a standalone JSON value, suitable for line-by-line streaming consumption.
  const jsonMode = flags["json"] === "true";
  // Iter792: in jsonMode, switch printJson to compact (one-line) so the watch
  // stream is true JSONL — strict parsers (`jq -c`, Vector, Fluent Bit) read
  // line-by-line without embedded-newline confusion. The flag is restored
  // in the finally block so subsequent one-shot --json paths in the same
  // process (web server / MCP-CLI hybrid) get pretty-printed output.
  const priorCompactMode = false;
  if (jsonMode) setCompactJsonMode(true);
  try {
    while (!stopped) {
      if (!jsonMode) {
        process.stdout.write("\x1b[2J\x1b[H");
        process.stdout.write(
          `tradekit watch (refresh ${interval}s — ctrl-c to stop)   ${new Date().toLocaleTimeString()}\n` +
            "─".repeat(80) +
            "\n\n",
        );
      }
      try {
        await fn();
      } catch (e) {
        // Surface the ToolError code when available so transient failures (RPC_FAILED,
        // TX_TIMEOUT) are distinguishable from real config issues (INVALID_PARAMS) at
        // a glance during a watch session.
        const code = (e as { code?: string }).code;
        console.error(code ? `Error [${code}]: ${(e as Error).message}` : `Error: ${(e as Error).message}`);
      }
      if (stopped) break;
      await new Promise<void>((r) => {
        const t = setTimeout(r, interval * 1000);
        const i = setInterval(() => {
          if (stopped) {
            clearTimeout(t);
            clearInterval(i);
            r();
          }
        }, 100);
        t.unref?.();
        i.unref?.();
      });
    }
  } finally {
    process.off("SIGINT", onSig);
    // Iter792: restore prior compact mode so a withWatch-then-one-shot
    // sequence in the same process (rare but possible — embedded tests,
    // hybrid CLI/MCP runners) doesn't leak the compact setting.
    if (jsonMode) setCompactJsonMode(priorCompactMode);
  }
}

/** Tiny argv parser. Long flags `--key value` or `--bool`; everything else is positional. */
/** Iter800: critical monitoring flags whose silent typo costs real money /
 *  reliability. --stict instead of --strict in a cron line disables
 *  exit-code alerting; --waatch disables watch mode. A small known-typo
 *  detector warns at parse time without rejecting (operators may legitimately
 *  pass other flags). Each entry must be lowercase. */
const CRITICAL_FLAGS = [
  "strict",
  "quiet",
  "watch",
  "summary",
  "json",
  "yes",
  "force",
  "verbose",
  "simulate",
];

/** Iter800: stderr warning when a flag is exactly distance 1 from a critical
 *  flag (substitution / single insertion / deletion / single transposition).
 *  Distance-1 keeps false positives minimal — "stricter" (distance 2 from
 *  "strict") doesn't warn; "stict" does. */
function warnFlagTypos(flagKeys: readonly string[]): void {
  const seen = new Set(flagKeys.map((k) => k.toLowerCase()));
  for (const key of flagKeys) {
    const k = key.toLowerCase();
    if (CRITICAL_FLAGS.includes(k)) continue;
    for (const target of CRITICAL_FLAGS) {
      if (seen.has(target)) continue; // operator already passed the canonical form
      if (levenshteinDistance(k, target) === 1) {
        process.stderr.write(
          `Warning: --${key} looks like a typo of --${target}. Re-run with --${target} if that's what you meant.\n`,
        );
        break;
      }
    }
  }
}

/** Iter800: minimal Levenshtein for distance ≤ 1 detection. Inlined (not the
 *  shared format.ts version) because we only need a 1-or-not bound — a
 *  bounded check is cheaper than the full DP matrix. Returns 0/1/2+ where 2+
 *  is "definitely not a typo". */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return 2; // length differs too much for distance 1
  // Substitution case (equal length): exactly one mismatched position.
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diff++;
        if (diff > 1) return 2;
      }
    }
    return diff;
  }
  // Insertion/deletion case (|la-lb|==1): the shorter must be a substring of
  // the longer with one position skipped.
  const [shorter, longer] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else if (!skipped) {
      skipped = true;
      j++;
    } else {
      return 2;
    }
  }
  return 1;
}

/**
 * Iter21: collect every `--<flagName> VALUE` occurrence from a raw
 * argv. The standard `parseArgs` folds duplicate flag keys into a
 * single map entry (last wins) — useful for the 99% case but breaks
 * repeatable flags like `--var NAME=VALUE` where each occurrence
 * carries DIFFERENT data. Templating uses this to capture `--var
 * ASSET=ETH --var PRICE=3000 --var QUOTE=USDC` as three values.
 *
 * Accepts the same `--key=value` AND `--key value` forms parseArgs
 * does. Empty arrays mean "flag wasn't specified" — callers choose
 * how to surface that.
 */
export function collectRepeatableFlag(args: string[], flagName: string): string[] {
  const out: string[] = [];
  const pattern = `--${flagName}`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === pattern) {
      const next = args[i + 1];
      if (next != null && !next.startsWith("--")) {
        out.push(next);
        i++;
      }
      continue;
    }
    if (arg.startsWith(pattern + "=")) {
      out.push(arg.slice(pattern.length + 1));
    }
  }
  return out;
}

export function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      // Support both Unix conventions: `--key value` and `--key=value`.
      // Pre-iter135 only the space form worked — `--pass=secret` was parsed as a single
      // flag with key="pass=secret" and value="true", so the password was effectively
      // ignored. The user got a misleading "wrong password" because the env-var fallback
      // (or prompt) kicked in. Splitting on the first `=` brings parity with every other
      // CLI in the ecosystem.
      const body = arg.slice(2);
      const eqIdx = body.indexOf("=");
      if (eqIdx !== -1) {
        flags[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
        continue;
      }
      const key = body;
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  // Iter800: scan parsed flag keys for typos of critical monitoring flags.
  // Run AFTER parsing so we have the full set (caller can branch on the seen
  // set to avoid warning when both the typo and canonical form are present —
  // probably intentional in that case).
  warnFlagTypos(Object.keys(flags));
  return { positional, flags };
}
