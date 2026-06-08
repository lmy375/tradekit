// Tests for the mnemonic keystore (accounts.ts). A regression here is catastrophic —
// either user mnemonics become unreadable (lost funds) or the auth-tag verification
// silently passes for tampered ciphertext (potential attack vector). Roundtripping
// the actual viem mnemonic format guards both directions.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptMnemonic, decryptMnemonic, unknownAccountError } from "./accounts.js";
import { ToolError } from "./errors.js";
import type { Address } from "viem";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as Address;

// Scrypt at N=32768 is slow (~100ms/call). Keep the test count tight.

describe("encryptMnemonic / decryptMnemonic", () => {
  it("roundtrips the mnemonic when the password is correct", () => {
    const keystore = encryptMnemonic(MNEMONIC, "correct-horse-battery-staple", ADDRESS);
    expect(decryptMnemonic(keystore, "correct-horse-battery-staple")).toBe(MNEMONIC);
  });

  it("preserves firstAddress in the keystore for display purposes", () => {
    const keystore = encryptMnemonic(MNEMONIC, "pw", ADDRESS);
    expect(keystore.firstAddress).toBe(ADDRESS);
    expect(keystore.v).toBe(1);
    expect(keystore.cipher).toBe("aes-256-gcm");
    expect(keystore.kdf).toBe("scrypt");
  });

  it("throws WRONG_PASSWORD (not a generic error) when the password is wrong", () => {
    const keystore = encryptMnemonic(MNEMONIC, "right-pw", ADDRESS);
    try {
      decryptMnemonic(keystore, "wrong-pw");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("WRONG_PASSWORD");
      // Agents branch on the code, so the message can vary — but it should still mention "password".
      expect((e as ToolError).message).toMatch(/password/i);
    }
  });

  it("detects tampered ciphertext (AES-GCM auth tag catches it as WRONG_PASSWORD)", () => {
    // From the keystore's perspective, tampering looks identical to a wrong password —
    // both fail the AEAD check. That's the secure default.
    const keystore = encryptMnemonic(MNEMONIC, "pw", ADDRESS);
    // Flip the last hex nibble unconditionally — naive `replace(/.$/, "0")` would be a
    // no-op when the byte already ended in "0" (~1/16 chance, intermittent test failure).
    const lastChar = keystore.ciphertext.slice(-1);
    const flipped = lastChar === "f" ? "0" : (parseInt(lastChar, 16) + 1).toString(16);
    const tampered = { ...keystore, ciphertext: keystore.ciphertext.slice(0, -1) + flipped };
    expect(() => decryptMnemonic(tampered, "pw")).toThrow(ToolError);
    try {
      decryptMnemonic(tampered, "pw");
    } catch (e) {
      expect((e as ToolError).code).toBe("WRONG_PASSWORD");
    }
  });

  it("detects tampered auth tag (also classified as WRONG_PASSWORD)", () => {
    const keystore = encryptMnemonic(MNEMONIC, "pw", ADDRESS);
    // Same fix as above — flip the first nibble guaranteed.
    const firstChar = keystore.authTag.charAt(0);
    const flipped = firstChar === "f" ? "0" : (parseInt(firstChar, 16) + 1).toString(16);
    const tampered = { ...keystore, authTag: flipped + keystore.authTag.slice(1) };
    expect(() => decryptMnemonic(tampered, "pw")).toThrow(ToolError);
  });

  it("uses fresh randomness — two encryptions of the same plaintext produce different ciphertext", () => {
    // Reusing IV or salt across encryptions would catastrophically weaken AES-GCM. Each
    // encrypt() must draw fresh values; the easiest external check is observing that
    // identical (mnemonic, password) inputs produce different ciphertext+iv+salt.
    const a = encryptMnemonic(MNEMONIC, "same-pw", ADDRESS);
    const b = encryptMnemonic(MNEMONIC, "same-pw", ADDRESS);
    expect(a.iv).not.toBe(b.iv);
    expect(a.kdfparams.salt).not.toBe(b.kdfparams.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // But both must decrypt back to the same plaintext.
    expect(decryptMnemonic(a, "same-pw")).toBe(MNEMONIC);
    expect(decryptMnemonic(b, "same-pw")).toBe(MNEMONIC);
  });
});

describe("addAccount (iter140 — reject duplicate index / empty label)", () => {
  // Isolated data dir per-suite. Static imports at the top of this file already loaded
  // constants.ts against the real DATA_DIR, so we can't repoint the existing instance.
  // Use child_process to spawn a fresh tradekit process with the env var set — that's
  // the only reliable way to verify the duplicate-index check end-to-end.
  const dir = mkdtempSync(join(tmpdir(), "tradekit-addacct-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Skip when the built CLI isn't available (e.g. running tests before build:server).
  const cliPath = join(process.cwd(), "dist/index.js");
  let cliAvailable = false;
  beforeAll(async () => {
    const { existsSync } = await import("fs");
    cliAvailable = existsSync(cliPath);
  });

  function run(args: string[]): { stdout: string; stderr: string; code: number } {
    if (!cliAvailable) return { stdout: "", stderr: "(cli not built)", code: 0 };
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const r = spawnSync(
      "node",
      ["--experimental-sqlite", "--no-warnings=ExperimentalWarning", cliPath, ...args],
      {
        env: { ...process.env, TRADEKIT_DATA_DIR: dir, WALLET_PASS: "test-pass-12345" },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 0 };
  }

  it("setup: create-mnemonic seeds a default account at index 0", () => {
    if (!cliAvailable) return; // build step skipped — see beforeAll
    const r = run(["account", "create-mnemonic", "--pass", "test-pass-12345"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("HD wallet created");
  });

  it("rejects --index N that's already in use (regression: pre-iter140 happily duplicated paths)", () => {
    if (!cliAvailable) return;
    const r = run(["account", "add", "dup", "--index", "0", "--pass", "test-pass-12345"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/already used by account "default"/);
  });

  it("auto-assigns the next index when --index isn't supplied", () => {
    if (!cliAvailable) return;
    const r = run(["account", "add", "auto-indexed", "--pass", "test-pass-12345"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/at index 1/);
  });

  it("iter519: rejects the reserved 'keystore' label (case-insensitive)", () => {
    if (!cliAvailable) return;
    // The literal "keystore" is the single-key wallet identifier — letting an HD
    // account use it would break iter505's wallet-view text gate + audit attribution
    // + dual-wallet disambiguation everywhere.
    const lower = run(["account", "add", "keystore", "--pass", "test-pass-12345"]);
    expect(lower.code).not.toBe(0);
    expect(lower.stderr + lower.stdout).toMatch(/reserved.*single-key/i);
    // Also reject uppercase / mixed-case forms via the toLowerCase compare.
    const mixed = run(["account", "add", "KeyStore", "--pass", "test-pass-12345"]);
    expect(mixed.code).not.toBe(0);
    expect(mixed.stderr + mixed.stdout).toMatch(/reserved.*single-key/i);
  });
});

describe("unknownAccountError (iter344 — UNKNOWN_ACCOUNT typo suggestion)", () => {
  it("suggests the closest known label for a single-typo input", () => {
    const e = unknownAccountError("alise", ["default", "alice", "bob"]);
    expect(e).toBeInstanceOf(ToolError);
    expect(e.code).toBe("UNKNOWN_ACCOUNT");
    expect(e.message).toContain('Did you mean "alice"?');
    expect((e.details as { suggestion: string | null }).suggestion).toBe("alice");
  });

  it("omits the suggestion when no candidate is close enough", () => {
    const e = unknownAccountError("zzzzz", ["default", "alice"]);
    expect(e.message).not.toMatch(/Did you mean/);
    expect((e.details as { suggestion: string | null }).suggestion).toBeNull();
  });

  it("handles empty known list (fresh install) without crashing", () => {
    const e = unknownAccountError("anything", []);
    expect(e.message).toContain("Known: (none)");
    expect((e.details as { suggestion: string | null }).suggestion).toBeNull();
  });
});
