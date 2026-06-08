// Unit tests for shared CLI helpers. Pulled out separately because the helpers in this
// module have no DB/wallet deps — they're cheap pure functions worth covering thoroughly.

import { describe, it, expect } from "vitest";
import { csvField, assertTxHash, tradeStatusMarker, parseIntFlag, parseFloatFlag, parseChainsFlag, parseArgs, checkPasswordStrength, closestCommand, subcommandError, makeCliLogger, resolveStrategy } from "./helpers.js";
import { ToolError } from "../errors.js";

describe("csvField (iter120 — RFC 4180 escaping)", () => {
  it("returns empty string for null and undefined", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("passes plain ASCII values through unquoted", () => {
    expect(csvField("hello")).toBe("hello");
    expect(csvField("0xabc123")).toBe("0xabc123");
    expect(csvField(42)).toBe("42");
    expect(csvField(0)).toBe("0"); // not coerced to ""
  });

  it("quotes values containing a comma", () => {
    expect(csvField("hello, world")).toBe('"hello, world"');
  });

  it("quotes AND doubles embedded double-quotes (regression: pre-iter120 left these unescaped)", () => {
    // A user note like: say "hi"
    // Before iter120: the row became   ...,say "hi",...    — splitting on `,` ok, but
    // Excel sees mismatched quote count and corrupts subsequent fields.
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes values containing newlines (regression: pre-iter120 broke the row entirely)", () => {
    // Before iter120: a note with \n produced a CSV with one row per line of notes —
    // tools downstream saw N+1 rows instead of N.
    expect(csvField("multi\nline note")).toBe('"multi\nline note"');
    expect(csvField("with carriage\rreturn")).toBe('"with carriage\rreturn"');
    expect(csvField("crlf\r\nstyle")).toBe('"crlf\r\nstyle"');
  });

  it("handles a value that is just a double-quote", () => {
    expect(csvField('"')).toBe('""""');
  });

  it("does not quote values that only contain non-special characters", () => {
    // Single quote, semicolon, pipe, embedded tab — none are special in RFC 4180.
    // Iter469: restored the embedded-tab case dropped during the iter454 add. The
    // iter454 mitigation only fires on a LEADING `\t` (formula trigger); mid-string
    // tabs pass through unchanged, which this test now pins explicitly.
    expect(csvField("it's fine")).toBe("it's fine");
    expect(csvField("a;b|c")).toBe("a;b|c");
    expect(csvField("a;b|c\td")).toBe("a;b|c\td");
  });

  describe("iter454 — CSV-injection mitigation (formula-prefix escape)", () => {
    it("prepends a single quote to values starting with =", () => {
      // The classic Excel CSV-injection payload. A note like this in trades.csv
      // would execute the embedded command when the operator opens in Excel.
      expect(csvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    });

    it("prepends a single quote to values starting with +, -, @, tab, CR", () => {
      // Each of these is treated by Excel as a formula starter (or a DDE prefix
      // in the case of @ / leading tab) when it's the first char of the cell.
      expect(csvField("+1+1")).toBe("'+1+1");
      expect(csvField("-1+1")).toBe("'-1+1");
      expect(csvField("@SUM(A1:A10)")).toBe("'@SUM(A1:A10)");
      // \t isn't in RFC 4180's quoting set so the leading-quote-only form is
      // sufficient. \r IS in the quoting set so the layered output wraps it.
      expect(csvField("\tinject")).toBe("'\tinject");
      expect(csvField("\rinject")).toBe('"\'\rinject"');
    });

    it("does NOT prepend when the formula char appears mid-string", () => {
      // Only the FIRST character matters for Excel's formula detection.
      expect(csvField("hello=world")).toBe("hello=world");
      expect(csvField("a + b")).toBe("a + b");
      expect(csvField("ETH-USD")).toBe("ETH-USD");
    });

    it("still escapes commas/quotes/newlines after the leading-quote prefix", () => {
      // Layered case: a payload that needs both injection-mitigation AND RFC 4180
      // quoting. The leading-quote goes first, then the whole thing gets wrapped.
      expect(csvField('=evil, "stuff"')).toBe('"\'=evil, ""stuff"""');
    });

    it("leaves empty strings alone (no false positive on the empty case)", () => {
      expect(csvField("")).toBe("");
    });

    it("iter464: does NOT double-prefix a value that legitimately starts with an apostrophe", () => {
      // Operator-supplied note like "'best trade'" is legitimate free text — apostrophe
      // is NOT a formula-trigger char (Excel uses it as a "force text" escape, so a
      // value already starting with ' is text-by-default to Excel anyway). iter454's
      // regex deliberately excludes ' from [=+\-@\t\r] for this reason; iter464 pins
      // the absence of a false-positive double-prefix.
      expect(csvField("'best trade'")).toBe("'best trade'");
      expect(csvField("'")).toBe("'");
    });

    it("iter465: passes through positive numbers + BigInt + non-formula leading digits", () => {
      // The iter454 mitigation is targeted at agent-controlled free text (notes). Pin
      // that ordinary numeric values — including BigInt (gas_used / gas_price_wei
      // in TRADE_COLUMNS) — pass through unchanged. Regression here would mean
      // trade exports turn into text-formatted columns and downstream sum/average
      // formulas in Excel break.
      expect(csvField(0)).toBe("0");
      expect(csvField(42)).toBe("42");
      expect(csvField(0.5)).toBe("0.5");
      expect(csvField(123n)).toBe("123");
      expect(csvField(1e-5)).toBe("0.00001"); // JS coerces small floats to decimal not scientific
      expect(csvField("1e-5")).toBe("1e-5"); // scientific-notation strings are mid-string `-`, no trigger
      // BigInt with realistic gas-cost magnitude.
      expect(csvField(123456789012345678n)).toBe("123456789012345678");
    });
  });
});

describe("assertTxHash (iter121 — reject typo'd tx hashes up-front)", () => {
  const VALID = "0x" + "a".repeat(64);

  it("accepts a 0x-prefixed 64-hex string", () => {
    expect(assertTxHash(VALID)).toBe(VALID);
  });

  it("accepts mixed-case hex (block explorers commonly return uppercase)", () => {
    const mixed = "0x" + "ABCdef0123456789".repeat(4);
    expect(assertTxHash(mixed)).toBe(mixed);
  });

  it("rejects missing 0x prefix with INVALID_PARAMS (not TX_NOT_FOUND)", () => {
    // Regression: pre-iter121 this hit the RPC and surfaced as "TX_NOT_FOUND",
    // making the user think their tx had vanished when really they'd typed wrong.
    expect(() => assertTxHash("a".repeat(66))).toThrow(ToolError);
    try {
      assertTxHash("a".repeat(66));
    } catch (e) {
      expect((e as ToolError).code).toBe("INVALID_PARAMS");
    }
  });

  it("rejects wrong-length hashes", () => {
    expect(() => assertTxHash("0xabc")).toThrow(ToolError);
    expect(() => assertTxHash("0x" + "a".repeat(63))).toThrow(ToolError); // one short
    expect(() => assertTxHash("0x" + "a".repeat(65))).toThrow(ToolError); // one long
    expect(() => assertTxHash("0x" + "a".repeat(40))).toThrow(ToolError); // address length, not tx
  });

  it("rejects non-hex characters", () => {
    expect(() => assertTxHash("0x" + "g".repeat(64))).toThrow(ToolError);
    expect(() => assertTxHash("0x" + "z" + "a".repeat(63))).toThrow(ToolError);
  });

  it("rejects empty string", () => {
    expect(() => assertTxHash("")).toThrow(ToolError);
  });

  it("includes the offending value in the error message so users can spot the typo", () => {
    try {
      assertTxHash("0xtypo");
    } catch (e) {
      expect((e as ToolError).message).toContain("0xtypo");
      expect((e as ToolError).message).toContain("64 hex chars");
    }
  });
});

describe("checkPasswordStrength (iter137 — wallet-create gate)", () => {
  it("rejects empty password with INVALID_PARAMS", () => {
    expect(() => checkPasswordStrength("")).toThrow(ToolError);
  });

  it("warns on short passwords (<8 chars)", () => {
    const { warnings } = checkPasswordStrength("abc");
    expect(warnings.some((w) => w.includes("only 3 characters"))).toBe(true);
  });

  it("warns on between 8 and 12 chars (still allowed)", () => {
    const { warnings } = checkPasswordStrength("password1"); // 9 chars, mixed
    expect(warnings.some((w) => w.includes("shorter than 12"))).toBe(true);
  });

  it("warns on digits-only password", () => {
    const { warnings } = checkPasswordStrength("123456789012");
    expect(warnings.some((w) => w.includes("digits-only"))).toBe(true);
  });

  it("warns on letters-only password", () => {
    const { warnings } = checkPasswordStrength("abcdefghijkl");
    expect(warnings.some((w) => w.includes("letters-only"))).toBe(true);
  });

  it("warns on common-password list entries (case-insensitive)", () => {
    const { warnings } = checkPasswordStrength("Password");
    expect(warnings.some((w) => w.includes("common-passwords list"))).toBe(true);
  });

  it("returns no warnings for a strong password", () => {
    const { warnings } = checkPasswordStrength("Tr@deK1t-2026-S0lid!");
    expect(warnings).toEqual([]);
  });

  it("allowWeak override skips all checks (CI/test escape hatch)", () => {
    expect(checkPasswordStrength("", { allowWeak: true }).warnings).toEqual([]);
    expect(checkPasswordStrength("x", { allowWeak: true }).warnings).toEqual([]);
  });
});

describe("parseArgs (iter135 — accept --key=value)", () => {
  it("parses space-separated flags (original supported form)", () => {
    const { flags, positional } = parseArgs(["--chain", "base", "--limit", "10"]);
    expect(flags).toEqual({ chain: "base", limit: "10" });
    expect(positional).toEqual([]);
  });

  it("parses equals-separated flags (regression: pre-iter135 broke --key=value)", () => {
    // Before iter135 `--pass=secret` parsed as flag {pass=secret: "true"} — the password
    // never reached requirePassword and the user got a misleading wrong-password error.
    const { flags } = parseArgs(["--chain=base", "--limit=10"]);
    expect(flags).toEqual({ chain: "base", limit: "10" });
  });

  it("handles values that themselves contain '=' (e.g. URLs with query strings)", () => {
    const { flags } = parseArgs(["--url=https://api.example.com/v1?q=foo"]);
    expect(flags.url).toBe("https://api.example.com/v1?q=foo");
  });

  it("handles empty value after equals (--key=)", () => {
    const { flags } = parseArgs(["--key="]);
    expect(flags.key).toBe("");
  });

  it("mixes both forms in one invocation", () => {
    const { flags } = parseArgs(["--chain", "base", "--limit=10", "--json"]);
    expect(flags).toEqual({ chain: "base", limit: "10", json: "true" });
  });

  it("collects positionals and ignores them in flag parsing", () => {
    const { positional, flags } = parseArgs(["trade", "buy", "--chain=base"]);
    expect(positional).toEqual(["trade", "buy"]);
    expect(flags).toEqual({ chain: "base" });
  });

  it("treats a flag followed by another flag as a boolean true (no value consumed)", () => {
    const { flags } = parseArgs(["--simulate", "--chain", "base"]);
    expect(flags).toEqual({ simulate: "true", chain: "base" });
  });

  it("iter800: warns on distance-1 typo of a critical monitoring flag", () => {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      parseArgs(["--stict"]);
      expect(captured).toContain("--stict");
      expect(captured).toContain("--strict");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("iter800: does NOT warn when the canonical flag is also present (operator passed both — likely intentional)", () => {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      parseArgs(["--stict", "--strict"]);
      expect(captured).toBe("");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("iter800: does NOT warn on distance-2 flags (avoids false positives like 'stricter')", () => {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      parseArgs(["--stricter"]); // distance 2 from strict
      expect(captured).toBe("");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("iter800: detects insertion typo (--watc → --watch)", () => {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      parseArgs(["--watc"]);
      expect(captured).toContain("--watch");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("iter857: detects distance-1 typo of --summary (added to CRITICAL_FLAGS)", () => {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      parseArgs(["--sumary"]); // distance 1 from summary
      expect(captured).toContain("--sumary");
      expect(captured).toContain("--summary");
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe("parseChainsFlag (iter134 — cleaner --chains parsing)", () => {
  const valid = ["base", "arbitrum", "optimism"];

  it("returns undefined when the flag wasn't supplied", () => {
    expect(parseChainsFlag(undefined)).toBeUndefined();
  });

  it("parses a simple comma list", () => {
    expect(parseChainsFlag("base,arbitrum")).toEqual(["base", "arbitrum"]);
  });

  it("trims whitespace around entries (regression: pre-iter134, ' arbitrum' didn't match)", () => {
    expect(parseChainsFlag("base, arbitrum, optimism ")).toEqual(["base", "arbitrum", "optimism"]);
  });

  it("drops empty entries from double commas", () => {
    expect(parseChainsFlag("base,,arbitrum")).toEqual(["base", "arbitrum"]);
  });

  it("lowercases for canonical match", () => {
    expect(parseChainsFlag("Base,ARBITRUM")).toEqual(["base", "arbitrum"]);
  });

  it("rejects all-whitespace / empty input with INVALID_PARAMS", () => {
    expect(() => parseChainsFlag(",,,")).toThrow(ToolError);
    expect(() => parseChainsFlag("   ")).toThrow(ToolError);
  });

  it("with validNames: rejects unknown chains and lists them in the error", () => {
    // Regression: pre-iter134, --chains bse,arbitrum silently dropped "bse" deep in
    // the multi-chain runner and the user saw partial results with no signal.
    try {
      parseChainsFlag("base,bse,arbitrum", valid);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("INVALID_PARAMS");
      expect((e as ToolError).message).toContain("bse");
      expect((e as ToolError).message).toContain("base, arbitrum, optimism");
    }
  });

  it("with validNames: case-insensitive against the valid list", () => {
    expect(parseChainsFlag("BASE,Arbitrum", valid)).toEqual(["base", "arbitrum"]);
  });

  it("with no validNames: passes any non-empty content through (typo check opt-in)", () => {
    expect(parseChainsFlag("anything,goes")).toEqual(["anything", "goes"]);
  });

  it("'all' (iter261) expands to the full validNames list", () => {
    // Regression: pre-iter261 every --chains-aware command needed its own "all"
    // pre-expansion. Now it's central.
    const full = ["base", "arbitrum", "optimism", "zora"];
    expect(parseChainsFlag("all", full)).toEqual(full);
    expect(parseChainsFlag("ALL", full)).toEqual(full); // case-insensitive
    expect(parseChainsFlag("  all  ", full)).toEqual(full); // tolerates whitespace
  });

  it("'all' without validNames throws (no chain set to expand to)", () => {
    expect(() => parseChainsFlag("all")).toThrow(ToolError);
  });

  it("Iter366: 'all' expansion is deduped too (defense in depth)", () => {
    // Defensive: if a caller built validNames by concatenating built-ins + custom
    // chains and a name happened to repeat (case mismatch slipping through, manual
    // misuse), `--chains all` previously returned duplicates → double RPC traffic
    // for the same chain. Now it routes through dedupeFirstSeen like the
    // comma-split path.
    const dupes = ["base", "BASE", "arbitrum", "base"];
    expect(parseChainsFlag("all", dupes)).toEqual(["base", "arbitrum"]);
  });

  // Iter346: dedupe + typo suggestion
  it("dedupes a repeated chain entry, preserving first-seen order", () => {
    // Pre-iter346: `--chains base,arbitrum,base` ran the RPC checks twice for "base",
    // doubling audit rows for the same chain.
    expect(parseChainsFlag("base,arbitrum,base")).toEqual(["base", "arbitrum"]);
  });

  it("dedupes case-insensitive duplicates after normalization", () => {
    expect(parseChainsFlag("Base,BASE,base")).toEqual(["base"]);
  });

  it("with validNames: surfaces a 'Did you mean' hint for a single-typo chain", () => {
    try {
      parseChainsFlag("baes,arbitrum", valid);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("INVALID_PARAMS");
      expect((e as ToolError).message).toContain('Did you mean "base"?');
    }
  });

  it("with validNames: omits 'Did you mean' when no candidate is close enough", () => {
    try {
      parseChainsFlag("zzzzz,arbitrum", valid);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).message).not.toMatch(/Did you mean/);
    }
  });

  // Iter565: pin the iter564 structured-details contract so a script consuming
  // the --json error envelope can branch on details.{unknownChains, validChains,
  // suggestion} without regex-parsing the prose.
  it("Iter564: unknown-chain throw carries details.unknownChains + validChains + suggestion", () => {
    try {
      parseChainsFlag("baes,arbitrum", valid);
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INVALID_PARAMS");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details).toBeDefined();
      expect(details?.unknownChains).toEqual(["baes"]);
      expect(details?.validChains).toEqual([...valid]);
      expect(details?.suggestion).toBe("base");
    }
  });

  it("Iter564: details.suggestion is null when no candidate is close enough", () => {
    try {
      parseChainsFlag("zzzzz,arbitrum", valid);
      throw new Error("should have thrown");
    } catch (e) {
      const details = (e as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.suggestion).toBeNull();
      expect(details?.unknownChains).toEqual(["zzzzz"]);
    }
  });
});

describe("parseFloatFlag (iter143 — decimal flag parsing for perTxUsdLimit etc)", () => {
  it("returns undefined when the flag wasn't supplied", () => {
    expect(parseFloatFlag(undefined, "--x")).toBeUndefined();
  });

  it("accepts plain integers", () => {
    expect(parseFloatFlag("100", "--x")).toBe(100);
  });

  it("accepts decimals", () => {
    expect(parseFloatFlag("100.5", "--x")).toBe(100.5);
    expect(parseFloatFlag("0.01", "--x")).toBe(0.01);
  });

  it("accepts leading dot (.5)", () => {
    expect(parseFloatFlag(".5", "--x")).toBe(0.5);
  });

  it("accepts trailing dot (12.)", () => {
    expect(parseFloatFlag("12.", "--x")).toBe(12);
  });

  it("rejects partial-numeric strings (regression: parseFloat('12abc') = 12 silently)", () => {
    expect(() => parseFloatFlag("12abc", "--x")).toThrow(ToolError);
  });

  it("rejects non-numeric", () => {
    expect(() => parseFloatFlag("abc", "--x")).toThrow(ToolError);
  });

  it("rejects exponential notation (deliberately — masks paste errors)", () => {
    expect(() => parseFloatFlag("1e6", "--x")).toThrow(ToolError);
  });

  it("respects min override", () => {
    expect(() => parseFloatFlag("0.001", "--x", { min: 0.01 })).toThrow(ToolError);
    expect(parseFloatFlag("0.01", "--x", { min: 0.01 })).toBe(0.01);
  });

  it("respects max override", () => {
    expect(() => parseFloatFlag("100.01", "--x", { max: 100 })).toThrow(ToolError);
    expect(parseFloatFlag("100", "--x", { max: 100 })).toBe(100);
  });

  it("rejects negative by default", () => {
    expect(() => parseFloatFlag("-1", "--x")).toThrow(ToolError);
  });
});

describe("parseIntFlag (iter131 — bounded numeric flag parsing)", () => {
  it("returns undefined when the flag wasn't supplied", () => {
    expect(parseIntFlag(undefined, "--limit")).toBeUndefined();
  });

  it("parses a valid non-negative integer", () => {
    expect(parseIntFlag("100", "--limit")).toBe(100);
    expect(parseIntFlag("0", "--limit")).toBe(0);
  });

  it("rejects non-numeric strings (regression: parseInt('abc') = NaN silently)", () => {
    expect(() => parseIntFlag("abc", "--limit")).toThrow(ToolError);
  });

  it("rejects partial-numeric strings (regression: parseInt('12abc') = 12 silently)", () => {
    expect(() => parseIntFlag("12abc", "--limit")).toThrow(ToolError);
  });

  it("rejects floats (parseInt would have truncated)", () => {
    expect(() => parseIntFlag("3.5", "--limit")).toThrow(ToolError);
  });

  it("rejects negative values by default (regression: SQL LIMIT -1 returns ALL rows)", () => {
    try {
      parseIntFlag("-1", "--limit");
    } catch (e) {
      expect((e as ToolError).code).toBe("INVALID_PARAMS");
      expect((e as ToolError).message).toContain("must be ≥ 0");
    }
  });

  it("respects min override", () => {
    expect(() => parseIntFlag("0", "--limit", { min: 1 })).toThrow(ToolError);
    expect(parseIntFlag("1", "--limit", { min: 1 })).toBe(1);
  });

  it("respects max override", () => {
    expect(() => parseIntFlag("1000", "--limit", { max: 100 })).toThrow(ToolError);
    expect(parseIntFlag("100", "--limit", { max: 100 })).toBe(100);
  });

  it("error messages include the offending value", () => {
    try {
      parseIntFlag("abc", "--limit");
    } catch (e) {
      expect((e as ToolError).message).toContain("abc");
      expect((e as ToolError).message).toContain("--limit");
    }
  });
});

describe("tradeStatusMarker (iter125 — make failed/pending trades pop)", () => {
  it("returns '!' for failed", () => {
    expect(tradeStatusMarker("failed")).toBe("!");
  });

  it("returns '~' for pending", () => {
    expect(tradeStatusMarker("pending")).toBe("~");
  });

  it("returns a single space for success (invisible in tables, preserves alignment)", () => {
    expect(tradeStatusMarker("success")).toBe(" ");
  });

  it("returns a single space for any unknown status (forward-compat with future statuses)", () => {
    // If we ever add a new status, we shouldn't accidentally hide it with a stale marker.
    expect(tradeStatusMarker("reverted")).toBe(" ");
    expect(tradeStatusMarker("")).toBe(" ");
  });

  it("always returns exactly 1 char so column alignment never shifts", () => {
    for (const s of ["failed", "pending", "success", "unknown", ""]) {
      expect(tradeStatusMarker(s).length).toBe(1);
    }
  });
});

describe("closestCommand (iter162 — typo suggestions)", () => {
  const known = ["wallet", "account", "trade", "trades", "holdings", "config", "doctor"];

  it("returns null for empty input (no suggestion when user typed nothing meaningful)", () => {
    expect(closestCommand("", known)).toBeNull();
  });

  it("returns the exact match (distance 0) when there is one", () => {
    expect(closestCommand("wallet", known)).toBe("wallet");
  });

  it("catches a single-char typo", () => {
    expect(closestCommand("walelt", known)).toBe("wallet");
    expect(closestCommand("trad", known)).toBe("trade");
  });

  it("catches a transposition", () => {
    // 'doctorr' has 1 insertion from 'doctor' → distance 1
    expect(closestCommand("doctorr", known)).toBe("doctor");
  });

  it("matches case-insensitively", () => {
    expect(closestCommand("WALLET", known)).toBe("wallet");
    expect(closestCommand("Account", known)).toBe("account");
  });

  it("returns null when no candidate is within distance 2", () => {
    // 'banana' is far from every known command
    expect(closestCommand("banana", known)).toBeNull();
  });

  it("picks the closest when multiple candidates are within range", () => {
    // 'trades' (distance 0) wins over 'trade' (distance 1) when input is "trades"
    expect(closestCommand("trades", known)).toBe("trades");
    // 'trade' (distance 0) wins over 'trades' (distance 1) when input is "trade"
    expect(closestCommand("trade", known)).toBe("trade");
  });
});

describe("subcommandError (iter164 — shared 'did you mean' for action typos)", () => {
  it("missing action produces a 'requires an action' message with the valid list", () => {
    const e = subcommandError("wallet", undefined, ["create", "import", "view"]);
    expect(e).toBeInstanceOf(ToolError);
    expect(e.code).toBe("INVALID_PARAMS");
    expect(e.message).toContain("wallet requires an action");
    expect(e.message).toContain("create");
    expect(e.message).toContain("view");
  });

  it("typo'd action suggests the closest match", () => {
    const e = subcommandError("wallet", "creat", ["create", "import", "view"]);
    expect(e.message).toContain("Unknown wallet action: creat");
    expect(e.message).toContain("Did you mean 'create'?");
  });

  it("far-off action lists the valid options instead of a wrong suggestion", () => {
    const e = subcommandError("wallet", "banana", ["create", "import", "view"]);
    expect(e.message).toContain("Unknown wallet action: banana");
    expect(e.message).toContain("Valid:");
    expect(e.message).toContain("create");
    // No spurious "Did you mean" for an out-of-range typo.
    expect(e.message).not.toMatch(/Did you mean/);
  });

  // Iter566: pin the iter563 structured-details contract so a CLI script consuming
  // --json error envelopes can branch on details.{command, providedAction,
  // validActions, suggestion} without regex-parsing the prose.
  it("Iter563: missing action carries details with providedAction=null", () => {
    const e = subcommandError("wallet", undefined, ["create", "import", "view"]);
    const details = (e as unknown as { details?: Record<string, unknown> }).details;
    expect(details).toBeDefined();
    expect(details?.command).toBe("wallet");
    expect(details?.providedAction).toBeNull();
    expect(details?.validActions).toEqual(["create", "import", "view"]);
  });

  it("Iter563: typo'd action carries details with the close-match suggestion", () => {
    const e = subcommandError("wallet", "creat", ["create", "import", "view"]);
    const details = (e as unknown as { details?: Record<string, unknown> }).details;
    expect(details?.command).toBe("wallet");
    expect(details?.providedAction).toBe("creat");
    expect(details?.validActions).toEqual(["create", "import", "view"]);
    expect(details?.suggestion).toBe("create");
  });

  it("Iter563: far-off action carries details with suggestion=null", () => {
    const e = subcommandError("wallet", "banana", ["create", "import", "view"]);
    const details = (e as unknown as { details?: Record<string, unknown> }).details;
    expect(details?.providedAction).toBe("banana");
    expect(details?.suggestion).toBeNull();
  });
});

describe("makeCliLogger (iter334 — reject contradictory --quiet --verbose)", () => {
  it("accepts neither flag (defaults to warn)", () => {
    expect(() => makeCliLogger({})).not.toThrow();
  });

  it("accepts --quiet alone", () => {
    expect(() => makeCliLogger({ quiet: "true" })).not.toThrow();
  });

  it("accepts --verbose alone", () => {
    expect(() => makeCliLogger({ verbose: "true" })).not.toThrow();
  });

  it("rejects --quiet --verbose together (pre-iter334 silently picked quiet)", () => {
    let caught: unknown;
    try {
      makeCliLogger({ quiet: "true", verbose: "true" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as ToolError).code).toBe("INVALID_PARAMS");
    expect((caught as ToolError).message).toContain("contradictory");
  });
});

describe("resolveStrategy (iter659 — TRADEKIT_STRATEGY env fallback)", () => {
  it("returns --strategy when set", () => {
    expect(resolveStrategy("rebal-q1", "dca")).toBe("rebal-q1");
  });

  it("falls back to env when --strategy is undefined", () => {
    expect(resolveStrategy(undefined, "dca")).toBe("dca");
  });

  it("returns undefined when both are unset", () => {
    expect(resolveStrategy(undefined, undefined)).toBeUndefined();
  });

  it("treats empty-string env as unset", () => {
    expect(resolveStrategy(undefined, "")).toBeUndefined();
  });

  it("treats whitespace-only env as unset", () => {
    expect(resolveStrategy(undefined, "   ")).toBeUndefined();
  });

  it("trims surrounding whitespace from env", () => {
    expect(resolveStrategy(undefined, "  dca  ")).toBe("dca");
  });

  it("preserves --strategy verbatim (no trim) since CLI parser already trimmed", () => {
    // Flag wins even if env is also set
    expect(resolveStrategy("explicit", "envval")).toBe("explicit");
  });

  it("flag-wins over env even when flag is empty string (operator opts out)", () => {
    // An empty --strategy "" is unusual but should still beat env — operator
    // is explicitly saying "no tag". Pre-iter659 there was no env so the
    // null/empty distinction didn't matter; with env present, flag-presence
    // is the override signal.
    expect(resolveStrategy("", "envval")).toBe("");
  });
});

// Iter878: parallel to iter877 (MCP_TOOLS registration invariant). The
// typo-detection `known` list in src/index.ts must include every top-level
// command registered as a case statement. iter856 supposedly closed this list
// but missed `tx`; iter878 fixed it AND adds this test to prevent the same
// drift from happening again. Future top-level commands added to the case
// switch will auto-fail this test if not also added to `known`.
describe("Iter878: typo-detection `known` list covers every top-level command case", () => {
  it("every 6-space-indented case in src/index.ts (excluding flag forms) is in known[]", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const indexPath = join(import.meta.dirname ?? ".", "..", "index.ts");
    const text = readFileSync(indexPath, "utf8");
    // Top-level switch cases are at exactly 6 spaces of indent (the outer
    // switch lives inside a try inside main()). Sub-switches are at 10+.
    // The regex matches case "X": at 6-space indent only.
    const cases = new Set<string>();
    for (const m of text.matchAll(/^      case "([a-zA-Z-]+)":/gm)) {
      const name = m[1];
      // Skip flag-style aliases (--help, --version, -h, -v) — those aren't
      // typo-detection targets, just aliases for the canonical command.
      if (name.startsWith("-")) continue;
      cases.add(name);
    }
    // Extract the `known` array literal as it appears in source.
    const knownMatch = text.match(/const known = \[\s*([\s\S]*?)\s*\];/);
    expect(knownMatch).not.toBeNull();
    const known = new Set(
      Array.from(knownMatch![1].matchAll(/"([a-zA-Z-]+)"/g)).map((m) => m[1]),
    );
    const missing: string[] = [];
    for (const cmd of cases) {
      if (!known.has(cmd)) missing.push(cmd);
    }
    // Failure: a top-level command exists but typo-detection won't suggest it
    // when the operator typos. Add it to the known list at the same site.
    expect(missing).toEqual([]);
  });
});
