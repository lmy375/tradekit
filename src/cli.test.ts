// Tests for promptPassword — exercises the byte-level keystroke handler that iter139
// rewrote so pasted multi-char buffers and UTF-8 passwords work. We mock stdin's
// raw-mode + data events because the real path needs a TTY; this isolates the logic.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promptPassword } from "./cli.js";

// Mock stdin/stderr surface that promptPassword uses. The test environment isn't a
// TTY (no real setRawMode), so we monkey-patch the methods we need and restore the
// originals in afterEach.
type DataListener = (buf: Buffer) => void;
let listeners: DataListener[] = [];
let writes: string[] = [];
const originals: Record<string, unknown> = {};

function patch(target: object, key: string, replacement: unknown) {
  originals[key] = (target as Record<string, unknown>)[key];
  (target as Record<string, unknown>)[key] = replacement;
}

function unpatchAll(target: object) {
  for (const [k, v] of Object.entries(originals)) {
    if (v === undefined) {
      delete (target as Record<string, unknown>)[k];
    } else {
      (target as Record<string, unknown>)[k] = v;
    }
  }
  for (const k of Object.keys(originals)) delete originals[k];
}

beforeEach(() => {
  listeners = [];
  writes = [];
  // process.stdin: we just need these methods to be callable without effect.
  patch(process.stdin, "setRawMode", () => process.stdin);
  patch(process.stdin, "resume", () => process.stdin);
  patch(process.stdin, "pause", () => process.stdin);
  patch(process.stdin, "isRaw", false);
  // Iter260 added an isTTY check to promptPassword so non-TTY callers fail fast.
  // For these unit tests we're SIMULATING a TTY, so force the flag true.
  patch(process.stdin, "isTTY", true);
  const realOn = process.stdin.on.bind(process.stdin) as (event: string, listener: (...args: never[]) => void) => unknown;
  patch(process.stdin, "on", (event: string, listener: (...args: never[]) => void) => {
    if (event === "data") listeners.push(listener as unknown as DataListener);
    else realOn(event, listener);
    return process.stdin;
  });
  patch(process.stdin, "removeListener", (event: string, listener: (...args: never[]) => void) => {
    if (event === "data") {
      const i = listeners.indexOf(listener as unknown as DataListener);
      if (i !== -1) listeners.splice(i, 1);
    }
    return process.stdin;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    writes.push(String(s));
    return true;
  });
});

afterEach(() => {
  unpatchAll(process.stdin);
  vi.restoreAllMocks();
});

// Send a buffer to all current listeners, mimicking a stdin data event.
function send(s: string | Buffer) {
  const buf = typeof s === "string" ? Buffer.from(s) : s;
  for (const l of listeners) l(buf);
}

describe("promptPassword (iter139 — paste-safe + UTF-8-safe)", () => {
  it("submits on a single 1-byte LF event", async () => {
    const p = promptPassword("? ");
    send("hello");
    send("\n");
    expect(await p).toBe("hello");
  });

  it("submits on CR (terminals that send \\r for Enter)", async () => {
    const p = promptPassword("? ");
    send("abc\r");
    expect(await p).toBe("abc");
  });

  it("handles a pasted multi-char buffer ending in LF (regression: pre-iter139 broke this)", async () => {
    // Mnemonic-style paste: whole 12-word string plus newline in one buffer event.
    const p = promptPassword("? ");
    send("word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12\n");
    expect(await p).toBe(
      "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12",
    );
  });

  it("drops bytes after LF in the same buffer (terminal-press-enter semantics)", async () => {
    const p = promptPassword("? ");
    send("yes\nNOISE_AFTER");
    expect(await p).toBe("yes");
  });

  it("handles UTF-8 multi-byte chars (regression: pre-iter139's String.fromCharCode broke these)", async () => {
    const p = promptPassword("? ");
    // ä = 0xC3 0xA4, ö = 0xC3 0xB6 in UTF-8
    send(Buffer.from([0x70, 0xc3, 0xa4, 0x73, 0x73, 0xc3, 0xb6, 0x72, 0x64])); // "pässörd"
    send("\n");
    expect(await p).toBe("pässörd");
  });

  it("handles UTF-8 codepoint split across two buffers (chunked terminal input)", async () => {
    const p = promptPassword("? ");
    send(Buffer.from([0x70, 0xc3])); // first half of ä
    send(Buffer.from([0xa4, 0x0a])); // second half of ä + LF
    expect(await p).toBe("pä");
  });

  it("handles backspace (DEL, 0x7f) — common Backspace key behavior on modern terminals", async () => {
    const p = promptPassword("? ");
    send("abc");
    send(Buffer.from([0x7f])); // backspace
    send("\n");
    expect(await p).toBe("ab");
  });

  it("handles backspace (BS, 0x08) — legacy Backspace mapping on some terminals", async () => {
    const p = promptPassword("? ");
    send("xyz");
    send(Buffer.from([0x08]));
    send("\n");
    expect(await p).toBe("xy");
  });

  it("backspace deletes a whole UTF-8 codepoint (walks back past continuation bytes)", async () => {
    const p = promptPassword("? ");
    send(Buffer.from([0xc3, 0xa4])); // ä
    send(Buffer.from([0x7f])); // backspace
    send("\n");
    expect(await p).toBe("");
  });

  it("ignores control chars below 0x20 (other than the ones we handle)", async () => {
    const p = promptPassword("? ");
    // VT (0x0b), FF (0x0c), arrow keys (escape sequences) — all should be dropped.
    send(Buffer.from([0x61, 0x0b, 0x62, 0x0c, 0x63])); // a<VT>b<FF>c
    send("\n");
    expect(await p).toBe("abc");
  });

  it("writes the question to stderr before reading", async () => {
    const p = promptPassword("Enter pass: ");
    send("x\n");
    await p;
    expect(writes[0]).toBe("Enter pass: ");
  });
});

describe("promptPassword (iter260 — non-TTY safeguard)", () => {
  // Regression for iter260: without the isTTY guard, calling promptPassword in a
  // non-TTY context (CI runner, docker entrypoint, /dev/null stdin) crashed deep
  // inside Node's `setRawMode is not a function`. Now it rejects up front with a
  // hint that names the env-var / flag alternatives.
  it("rejects when stdin is not a TTY", async () => {
    // Override the TTY flag set by beforeEach to simulate the non-interactive case.
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await expect(promptPassword("? ")).rejects.toThrow(/no interactive terminal/i);
  });

  it("error message names a non-interactive escape hatch (--pass / WALLET_PASS)", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await promptPassword("Enter password: ");
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      // Must surface BOTH the prompt text (so the operator knows what was being asked)
      // AND the recovery flags (so they don't have to grep docs).
      expect(msg).toContain("Enter password");
      expect(msg).toMatch(/--pass|WALLET_PASS/);
    }
  });
});
