// Tests for normalizePrivateKey (iter138). Other wallet behavior (keystore encrypt /
// decrypt, HD derivation) needs a tmp data dir + interactive password and is exercised
// by the smoke + integration paths instead.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePrivateKey } from "./wallet.js";
import { ToolError } from "./errors.js";

// A canonical valid hex string. Not a real key — generated deterministically.
const HEX64 = "a".repeat(64);

describe("normalizePrivateKey (iter138 — clear errors for bad input)", () => {
  it("accepts the canonical 0x-prefixed 64-hex form", () => {
    expect(normalizePrivateKey(`0x${HEX64}`)).toBe(`0x${HEX64}`);
  });

  it("accepts the bare 64-hex form (some explorers/hardware exports omit 0x)", () => {
    expect(normalizePrivateKey(HEX64)).toBe(`0x${HEX64}`);
  });

  it("trims surrounding whitespace (paste-from-terminal artifact)", () => {
    expect(normalizePrivateKey(`  0x${HEX64}\n`)).toBe(`0x${HEX64}`);
  });

  it("normalizes uppercase hex to lowercase (canonical form for the keystore)", () => {
    const upper = `0x${"A".repeat(64)}`;
    expect(normalizePrivateKey(upper)).toBe(`0x${"a".repeat(64)}`);
  });

  it("accepts the 0X prefix variant (uppercase X)", () => {
    expect(normalizePrivateKey(`0X${HEX64}`)).toBe(`0x${HEX64}`);
  });

  it("rejects short input with a length-aware INVALID_PARAMS", () => {
    try {
      normalizePrivateKey("0xabc");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("INVALID_PARAMS");
      // Error should include the actual char count so the user can spot a paste truncation.
      expect((e as ToolError).message).toContain("got 3 chars");
    }
  });

  it("rejects long input (extra char from paste artifact)", () => {
    expect(() => normalizePrivateKey(`0x${HEX64}f`)).toThrow(ToolError);
  });

  it("rejects non-hex characters (typo: O instead of 0, l instead of 1)", () => {
    expect(() => normalizePrivateKey("0x" + "g".repeat(64))).toThrow(ToolError);
    expect(() => normalizePrivateKey("0x" + "z".repeat(64))).toThrow(ToolError);
  });

  it("rejects empty string", () => {
    expect(() => normalizePrivateKey("")).toThrow(ToolError);
  });

  it("rejects 0x with nothing after", () => {
    expect(() => normalizePrivateKey("0x")).toThrow(ToolError);
  });

  it("error message guides the user (mentions expected format)", () => {
    try {
      normalizePrivateKey("typo");
    } catch (e) {
      expect((e as ToolError).message).toContain("64 hex chars");
      expect((e as ToolError).message).toContain("0x-prefixed");
    }
  });
});

describe("loadReadOnlyWallet (iter486 — password-free read-only wallet)", () => {
  // Iter486/488 made `quote` + `transfer --simulate` run without prompting for the
  // wallet password. These tests pin the address-resolution contract so a future
  // refactor can't silently return the wrong `from` (which would land an eth_call's
  // gas/balance check against the WRONG account and confuse the operator).
  let tmpDir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tradekit-readonly-test-"));
    savedDataDir = process.env.TRADEKIT_DATA_DIR;
    process.env.TRADEKIT_DATA_DIR = tmpDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TRADEKIT_DATA_DIR;
    else process.env.TRADEKIT_DATA_DIR = savedDataDir;
    vi.resetModules();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importFresh() {
    // Re-import the modules so constants.ts re-evaluates DATA_DIR against tmpDir.
    const wallet = await import("./wallet.js");
    const config = await import("./config.js");
    return { wallet, config };
  }

  it("returns the keystore address when only wallet.json exists (no accounts.json)", async () => {
    // Minimal keystore JSON — just enough for getKeystoreAddress to read .address.
    // The crypto section is irrelevant to read-only mode (we never decrypt).
    const addr = "0xabcdef1234567890aBcdef1234567890aBcdEF12";
    writeFileSync(join(tmpDir, "wallet.json"), JSON.stringify({ address: addr.slice(2), crypto: {} }));
    const { wallet, config } = await importFresh();
    const profile = config.resolveProfile("base", { version: 1, chains: {}, activeChain: "base" } as never);
    const ctx = wallet.loadReadOnlyWallet(profile, []);
    expect(ctx.walletClient.account.address.toLowerCase()).toBe(addr.toLowerCase());
    expect(ctx.label).toBe("keystore");
  });

  it("returns the active HD account address when accounts.json + mnemonic.json exist", async () => {
    const aliceAddr = "0x1111111111111111111111111111111111111111";
    const bobAddr = "0x2222222222222222222222222222222222222222";
    writeFileSync(join(tmpDir, "mnemonic.json"), JSON.stringify({ encrypted: "irrelevant" }));
    writeFileSync(
      join(tmpDir, "accounts.json"),
      JSON.stringify({
        version: 1,
        active: "alice",
        accounts: [
          { label: "alice", index: 0, address: aliceAddr, createdAt: "2024-01-01T00:00:00Z" },
          { label: "bob", index: 1, address: bobAddr, createdAt: "2024-01-02T00:00:00Z" },
        ],
      }),
    );
    const { wallet, config } = await importFresh();
    const profile = config.resolveProfile("base", { version: 1, chains: {}, activeChain: "base" } as never);
    const ctx = wallet.loadReadOnlyWallet(profile, []);
    expect(ctx.walletClient.account.address.toLowerCase()).toBe(aliceAddr.toLowerCase());
    expect(ctx.label).toBe("alice");
  });

  it("honors the accountLabel override (used by --account flag)", async () => {
    const aliceAddr = "0x1111111111111111111111111111111111111111";
    const bobAddr = "0x2222222222222222222222222222222222222222";
    writeFileSync(join(tmpDir, "mnemonic.json"), JSON.stringify({ encrypted: "irrelevant" }));
    writeFileSync(
      join(tmpDir, "accounts.json"),
      JSON.stringify({
        version: 1,
        active: "alice",
        accounts: [
          { label: "alice", index: 0, address: aliceAddr, createdAt: "2024-01-01T00:00:00Z" },
          { label: "bob", index: 1, address: bobAddr, createdAt: "2024-01-02T00:00:00Z" },
        ],
      }),
    );
    const { wallet, config } = await importFresh();
    const profile = config.resolveProfile("base", { version: 1, chains: {}, activeChain: "base" } as never);
    const ctx = wallet.loadReadOnlyWallet(profile, [], "bob");
    expect(ctx.walletClient.account.address.toLowerCase()).toBe(bobAddr.toLowerCase());
    expect(ctx.label).toBe("bob");
  });

  it("throws UNKNOWN_ACCOUNT with a Did-you-mean hint on a typo'd accountLabel", async () => {
    const aliceAddr = "0x1111111111111111111111111111111111111111";
    writeFileSync(join(tmpDir, "mnemonic.json"), JSON.stringify({ encrypted: "irrelevant" }));
    writeFileSync(
      join(tmpDir, "accounts.json"),
      JSON.stringify({
        version: 1,
        active: "alice",
        accounts: [{ label: "alice", index: 0, address: aliceAddr, createdAt: "2024-01-01T00:00:00Z" }],
      }),
    );
    const { wallet, config } = await importFresh();
    const profile = config.resolveProfile("base", { version: 1, chains: {}, activeChain: "base" } as never);
    // Iter524: tighten — verify both the code (via the thrown object) AND the Did-you-mean
    // hint in the message. The earlier regex /UNKNOWN_ACCOUNT|alice/ matched on either,
    // so a regression that dropped the code would slip through.
    try {
      wallet.loadReadOnlyWallet(profile, [], "alic");
      throw new Error("expected loadReadOnlyWallet to throw on unknown account");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("UNKNOWN_ACCOUNT");
      expect((e as Error).message).toMatch(/Did you mean "alice"/);
    }
  });

  it("throws WALLET_NOT_FOUND when neither wallet.json nor accounts.json exists", async () => {
    // mkdir TRADEKIT_DATA_DIR but write no wallet files
    mkdirSync(tmpDir, { recursive: true });
    const { wallet, config } = await importFresh();
    const profile = config.resolveProfile("base", { version: 1, chains: {}, activeChain: "base" } as never);
    // Iter525: same iter524 tightening — verify BOTH the error code AND the message
    // hint text. .toThrow's regex only sees .message; the loose disjunction
    // /WALLET_NOT_FOUND|No wallet found/ effectively only checked the message.
    try {
      wallet.loadReadOnlyWallet(profile, []);
      throw new Error("expected loadReadOnlyWallet to throw with no wallet files");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("WALLET_NOT_FOUND");
      expect((e as Error).message).toMatch(/No wallet found/);
      // Iter581: pin the iter577/580 reason-discriminator contract so a regression
      // dropping the structured field gets caught. An init-wizard / restore-tool
      // branches on details.reason to know what state to recover from.
      const details = (e as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("no_wallet");
      // Iter577 also pins the checkedPaths shape so a doctor can see exactly which
      // paths were probed when the wallet was missing.
      expect(details?.checkedPaths).toMatchObject({
        keystore: expect.any(String),
        mnemonic: expect.any(String),
      });
    }
  });

  describe("activeWalletAddress (iter499 — gated parity with loadWallet)", () => {
    // The mirror of the iter504 activeWalletLabel suite — same 4 cases with
    // address as the return value. Pre-iter499 the HD branch fired on just
    // accounts.json existence; now both functions gate identically.
    it("returns HD account address when both accounts.json + mnemonic.json exist", async () => {
      const aliceAddr = "0x1111111111111111111111111111111111111111";
      writeFileSync(join(tmpDir, "mnemonic.json"), JSON.stringify({ encrypted: "irrelevant" }));
      writeFileSync(
        join(tmpDir, "accounts.json"),
        JSON.stringify({
          version: 1,
          active: "alice",
          accounts: [{ label: "alice", index: 0, address: aliceAddr, createdAt: "2024-01-01T00:00:00Z" }],
        }),
      );
      const { wallet } = await importFresh();
      expect(wallet.activeWalletAddress()?.toLowerCase()).toBe(aliceAddr.toLowerCase());
    });

    it("returns keystore address when only wallet.json exists", async () => {
      const addr = "0xabcdef1234567890abcdef1234567890abcdef12";
      writeFileSync(join(tmpDir, "wallet.json"), JSON.stringify({ address: addr.slice(2), crypto: {} }));
      const { wallet } = await importFresh();
      expect(wallet.activeWalletAddress()?.toLowerCase()).toBe(addr.toLowerCase());
    });

    it("returns null when no wallet files exist", async () => {
      mkdirSync(tmpDir, { recursive: true });
      const { wallet } = await importFresh();
      expect(wallet.activeWalletAddress()).toBeNull();
    });

    it("iter521: HD takes precedence in the dual-wallet case (HD + keystore both present)", async () => {
      // Doctor surfaces this state as "HD mnemonic + single-key keystore (HD takes
      // precedence)" (iter331); loadWallet also prefers HD. activeWalletAddress
      // mirrors that — without this pin, a future refactor flipping the precedence
      // could let the keystore address win silently while loadWallet still picks HD.
      const aliceAddr = "0x1111111111111111111111111111111111111111";
      const keystoreAddr = "0xabcdef1234567890abcdef1234567890abcdef12";
      writeFileSync(join(tmpDir, "mnemonic.json"), JSON.stringify({ encrypted: "irrelevant" }));
      writeFileSync(
        join(tmpDir, "accounts.json"),
        JSON.stringify({
          version: 1,
          active: "alice",
          accounts: [{ label: "alice", index: 0, address: aliceAddr, createdAt: "2024-01-01T00:00:00Z" }],
        }),
      );
      writeFileSync(join(tmpDir, "wallet.json"), JSON.stringify({ address: keystoreAddr.slice(2), crypto: {} }));
      const { wallet } = await importFresh();
      expect(wallet.activeWalletAddress()?.toLowerCase()).toBe(aliceAddr.toLowerCase());
      expect(wallet.activeWalletLabel()).toBe("alice");
    });
  });

  it("iter499: activeWalletAddress returns keystore (not orphan HD) when accounts.json is orphaned", async () => {
    // Pre-iter499 activeWalletAddress checked just activeAccountEntry() — returning
    // the orphan HD address that loadWallet couldn't actually derive. Now it gates
    // HD on MNEMONIC_PATH existence (mirroring loadWallet/loadReadOnlyWallet) so the
    // doctor command + the trade flow see the same "active" address.
    const keystoreAddr = "0xabcdef1234567890abcdef1234567890abcdef12";
    writeFileSync(join(tmpDir, "wallet.json"), JSON.stringify({ address: keystoreAddr.slice(2), crypto: {} }));
    writeFileSync(
      join(tmpDir, "accounts.json"),
      JSON.stringify({
        version: 1,
        active: "alice",
        accounts: [{ label: "alice", index: 0, address: "0x1111111111111111111111111111111111111111", createdAt: "2024-01-01T00:00:00Z" }],
      }),
    );
    // No mnemonic.json — orphan state.
    const { wallet } = await importFresh();
    expect(wallet.activeWalletAddress()?.toLowerCase()).toBe(keystoreAddr.toLowerCase());
  });

  describe("activeWalletLabel (iter500 — single source of truth for active label)", () => {
    // The audit log + the trade DB row's `account` field + every fallback in
    // CLI/MCP/web routes through this. A regression here desyncs every account
    // attribution across surfaces.
    it("returns the HD active label when both accounts.json and mnemonic.json exist", async () => {
      writeFileSync(join(tmpDir, "mnemonic.json"), JSON.stringify({ encrypted: "irrelevant" }));
      writeFileSync(
        join(tmpDir, "accounts.json"),
        JSON.stringify({
          version: 1,
          active: "alice",
          accounts: [{ label: "alice", index: 0, address: "0x1111111111111111111111111111111111111111", createdAt: "2024-01-01T00:00:00Z" }],
        }),
      );
      const { wallet } = await importFresh();
      expect(wallet.activeWalletLabel()).toBe("alice");
    });

    it("returns 'keystore' when only wallet.json exists", async () => {
      const addr = "0xabcdef1234567890abcdef1234567890abcdef12";
      writeFileSync(join(tmpDir, "wallet.json"), JSON.stringify({ address: addr.slice(2), crypto: {} }));
      const { wallet } = await importFresh();
      expect(wallet.activeWalletLabel()).toBe("keystore");
    });

    it("returns 'keystore' in the orphan-accounts.json case (mnemonic missing)", async () => {
      // Same condition that iter501 fixed across CLI/MCP/web — every consumer
      // should agree that this returns "keystore", matching what loadWallet does.
      writeFileSync(join(tmpDir, "wallet.json"), JSON.stringify({ address: "abcdef1234567890abcdef1234567890abcdef12", crypto: {} }));
      writeFileSync(
        join(tmpDir, "accounts.json"),
        JSON.stringify({
          version: 1,
          active: "alice",
          accounts: [{ label: "alice", index: 0, address: "0x1111111111111111111111111111111111111111", createdAt: "2024-01-01T00:00:00Z" }],
        }),
      );
      const { wallet } = await importFresh();
      expect(wallet.activeWalletLabel()).toBe("keystore");
    });

    it("returns 'keystore' even with no wallet files (defensive default)", async () => {
      // Some call sites (e.g. CLI audit attribution) read activeWalletLabel BEFORE
      // verifying the wallet exists. The defensive default keeps it from returning
      // undefined / crashing — downstream checks (anyWalletExists etc.) handle the
      // real "no wallet" case.
      mkdirSync(tmpDir, { recursive: true });
      const { wallet } = await importFresh();
      expect(wallet.activeWalletLabel()).toBe("keystore");
    });
  });

  it("falls back to keystore when accounts.json exists but mnemonic.json is missing (orphaned-accounts edge case)", async () => {
    // Iter498: a user who deleted ~/.tradekit/mnemonic.json (panic-cleanup, bad backup
    // restore, etc.) leaves an orphaned accounts.json behind. loadWallet (and now
    // loadReadOnlyWallet) gates the HD branch on BOTH files; with mnemonic missing
    // we should fall through to the single-key keystore path rather than throw
    // UNKNOWN_ACCOUNT or return a wrong address. This pins that gate behavior.
    const keystoreAddr = "0xabcdef1234567890abcdef1234567890abcdef12";
    writeFileSync(join(tmpDir, "wallet.json"), JSON.stringify({ address: keystoreAddr.slice(2), crypto: {} }));
    // accounts.json present but mnemonic.json absent — the orphaned state.
    writeFileSync(
      join(tmpDir, "accounts.json"),
      JSON.stringify({
        version: 1,
        active: "alice",
        accounts: [{ label: "alice", index: 0, address: "0x1111111111111111111111111111111111111111", createdAt: "2024-01-01T00:00:00Z" }],
      }),
    );
    const { wallet, config } = await importFresh();
    const profile = config.resolveProfile("base", { version: 1, chains: {}, activeChain: "base" } as never);
    const ctx = wallet.loadReadOnlyWallet(profile, []);
    // Fell back to keystore — NOT the orphan accounts.json entry.
    expect(ctx.walletClient.account.address.toLowerCase()).toBe(keystoreAddr.toLowerCase());
    expect(ctx.label).toBe("keystore");
  });
});
