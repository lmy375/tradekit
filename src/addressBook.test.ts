// Iter614: unit tests for the address book module. Pin the validation rules
// (name shape, address shape, note length, book size), the case-insensitive
// lookup, and the @alias resolution with "Did you mean" suggestion.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateAddressName,
  findEntry,
  findByAddress,
  assertTransferAllowed,
  type AddressBook,
} from "./addressBook.js";
import { ToolError } from "./errors.js";

describe("assertTransferAllowed (v91 fund-exfiltration gate)", () => {
  const R = "0x1111111111111111111111111111111111111111";
  it("throws TRANSFER_RECIPIENT_NOT_ALLOWED for an unknown recipient when allowlistOnly is on", () => {
    expect(() => assertTransferAllowed({ allowlistOnly: true, recipientKnown: false, recipient: R })).toThrowError(ToolError);
    try {
      assertTransferAllowed({ allowlistOnly: true, recipientKnown: false, recipient: R });
    } catch (e) {
      expect((e as ToolError).code).toBe("TRANSFER_RECIPIENT_NOT_ALLOWED");
      expect((e as ToolError).message).toContain(R);
    }
  });
  it("allows a KNOWN recipient even when allowlistOnly is on", () => {
    expect(() => assertTransferAllowed({ allowlistOnly: true, recipientKnown: true, recipient: R })).not.toThrow();
  });
  it("is a no-op when allowlistOnly is off (unknown recipient passes)", () => {
    expect(() => assertTransferAllowed({ allowlistOnly: false, recipientKnown: false, recipient: R })).not.toThrow();
  });
});

// Per-test TRADEKIT_DATA_DIR + vi.resetModules + re-import so constants.ts's
// ADDRESS_BOOK_PATH re-evaluates against the per-test dir each iteration.
// Same pattern wallet.test.ts uses since iter489.
let originalDataDir: string | undefined;
let testDataDir: string;

// Lazy-loaded mutable module surface — re-imported per test.
let bookMod: typeof import("./addressBook.js");

beforeEach(async () => {
  originalDataDir = process.env.TRADEKIT_DATA_DIR;
  testDataDir = mkdtempSync(join(tmpdir(), "tradekit-addressbook-test-"));
  process.env.TRADEKIT_DATA_DIR = testDataDir;
  vi.resetModules();
  bookMod = await import("./addressBook.js");
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.TRADEKIT_DATA_DIR;
  else process.env.TRADEKIT_DATA_DIR = originalDataDir;
  vi.resetModules();
  rmSync(testDataDir, { recursive: true, force: true });
});

const COLD = "0x1234567890123456789012345678901234567890";
const EXCHANGE = "0xabcdef0123456789012345678901234567890123";

describe("validateAddressName (iter614)", () => {
  it("accepts standard names: alphanum + underscore + dash", () => {
    expect(() => validateAddressName("cold-wallet")).not.toThrow();
    expect(() => validateAddressName("Exchange_Deposit_1")).not.toThrow();
    expect(() => validateAddressName("alice")).not.toThrow();
    expect(() => validateAddressName("A")).not.toThrow();
  });

  it("rejects empty names", () => {
    try {
      validateAddressName("");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INVALID_PARAMS");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("empty_name");
    }
  });

  it("rejects names with spaces (visual-spoofing-defense)", () => {
    expect(() => validateAddressName("cold wallet")).toThrow(/invalid characters/);
  });

  it("rejects names with special characters (only [a-zA-Z0-9_-])", () => {
    expect(() => validateAddressName("cold.wallet")).toThrow();
    expect(() => validateAddressName("cold@wallet")).toThrow();
    expect(() => validateAddressName("cold/wallet")).toThrow();
  });

  it("rejects unicode names (visual-spoofing-defense — e.g. Cyrillic 'a' vs Latin 'a')", () => {
    expect(() => validateAddressName("аlice")).toThrow(); // first char is Cyrillic
    expect(() => validateAddressName("中文")).toThrow();
  });

  it("rejects names longer than 64 chars", () => {
    const long = "a".repeat(65);
    try {
      validateAddressName(long);
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("name_too_long");
    }
  });

  it("accepts a name at the exact 64-char boundary", () => {
    const max = "a".repeat(64);
    expect(() => validateAddressName(max)).not.toThrow();
  });
});

describe("findEntry (iter614)", () => {
  const book: AddressBook = {
    version: 1,
    entries: [
      { name: "Cold-Wallet", address: COLD as `0x${string}`, createdAt: "2026-01-01T00:00:00.000Z" },
      { name: "Exchange", address: EXCHANGE as `0x${string}`, createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  };

  it("finds by exact name", () => {
    const e = findEntry(book, "Cold-Wallet");
    expect(e?.address).toBe(COLD);
  });

  it("finds case-insensitively (operator types `cold-wallet`, book has `Cold-Wallet`)", () => {
    const e = findEntry(book, "cold-wallet");
    expect(e?.address).toBe(COLD);
    const e2 = findEntry(book, "COLD-WALLET");
    expect(e2?.address).toBe(COLD);
  });

  it("returns null for unknown name", () => {
    expect(findEntry(book, "unknown")).toBeNull();
  });

  it("preserves the canonical original-case name when found", () => {
    const e = findEntry(book, "cold-wallet");
    expect(e?.name).toBe("Cold-Wallet"); // case preserved from the saved entry
  });
});

describe("findByAddress (iter678)", () => {
  const book: AddressBook = {
    version: 1,
    entries: [
      { name: "Cold-Wallet", address: COLD as `0x${string}`, createdAt: "2026-01-01T00:00:00.000Z" },
      { name: "Exchange", address: EXCHANGE as `0x${string}`, createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  };

  it("finds by exact address (matching case)", () => {
    const e = findByAddress(book, COLD);
    expect(e?.name).toBe("Cold-Wallet");
  });

  it("finds case-insensitively (EIP-55 checksum variants match the stored address)", () => {
    const upper = COLD.toUpperCase().replace("0X", "0x");
    const lower = COLD.toLowerCase();
    expect(findByAddress(book, upper)?.name).toBe("Cold-Wallet");
    expect(findByAddress(book, lower)?.name).toBe("Cold-Wallet");
  });

  it("returns null when the address is not in the book", () => {
    expect(findByAddress(book, "0x" + "ab".repeat(20))).toBeNull();
  });

  it("returns null on an empty book", () => {
    expect(findByAddress({ version: 1, entries: [] }, COLD)).toBeNull();
  });
});

describe("addAddressEntry → listAddressEntries roundtrip (iter614)", () => {
  it("adds a new entry and lists it", () => {
    const entry = bookMod.addAddressEntry({ name: "cold", address: COLD });
    expect(entry.name).toBe("cold");
    expect(entry.address).toBe(COLD.toLowerCase());
    const list = bookMod.listAddressEntries();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("cold");
  });

  it("normalizes address to lowercase (consistency with iter97 chain-key normalization)", () => {
    const mixed = "0xABCdef0123456789012345678901234567890123";
    const entry = bookMod.addAddressEntry({ name: "mixed", address: mixed });
    expect(entry.address).toBe(mixed.toLowerCase());
  });

  it("stores optional note", () => {
    const entry = bookMod.addAddressEntry({ name: "exchange", address: EXCHANGE, note: "Coinbase deposit" });
    expect(entry.note).toBe("Coinbase deposit");
    expect(bookMod.listAddressEntries()[0].note).toBe("Coinbase deposit");
  });

  it("rejects duplicate name without overwrite=true", () => {
    bookMod.addAddressEntry({ name: "cold", address: COLD });
    try {
      bookMod.addAddressEntry({ name: "cold", address: EXCHANGE });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INVALID_PARAMS");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("name_exists");
      expect(details?.existingAddress).toBe(COLD.toLowerCase());
    }
  });

  it("overwrite=true replaces the existing entry in-place (order preserved)", () => {
    bookMod.addAddressEntry({ name: "cold", address: COLD });
    bookMod.addAddressEntry({ name: "other", address: EXCHANGE });
    bookMod.addAddressEntry({ name: "cold", address: EXCHANGE, overwrite: true });
    const list = bookMod.listAddressEntries();
    // Cold is still at index 0 (in-place replace, not push-to-end).
    expect(list[0].name).toBe("cold");
    expect(list[0].address).toBe(EXCHANGE.toLowerCase());
    expect(list[1].name).toBe("other");
  });

  it("duplicate detection is case-insensitive", () => {
    bookMod.addAddressEntry({ name: "Cold", address: COLD });
    try {
      bookMod.addAddressEntry({ name: "cold", address: EXCHANGE });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("INVALID_PARAMS");
    }
  });

  it("rejects bad address shape with structured detail", () => {
    try {
      bookMod.addAddressEntry({ name: "bad", address: "not-an-address" });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("bad_address_shape");
    }
  });

  it("rejects note longer than 200 chars", () => {
    try {
      bookMod.addAddressEntry({ name: "x", address: COLD, note: "a".repeat(201) });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("note_too_long");
    }
  });

  it("persists to disk in JSON form (the saved file is human-readable)", () => {
    bookMod.addAddressEntry({ name: "cold", address: COLD, note: "Cold storage" });
    const path = join(testDataDir, "address-book.json");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe(1);
    expect(parsed.entries[0].name).toBe("cold");
    expect(parsed.entries[0].address).toBe(COLD.toLowerCase());
  });
});

describe("removeAddressEntry (iter614)", () => {
  it("removes by name + returns the removed entry", () => {
    bookMod.addAddressEntry({ name: "cold", address: COLD });
    const removed = bookMod.removeAddressEntry("cold");
    expect(removed.address).toBe(COLD.toLowerCase());
    expect(bookMod.listAddressEntries()).toHaveLength(0);
  });

  it("case-insensitive remove (operator can type either case)", () => {
    bookMod.addAddressEntry({ name: "Cold-Wallet", address: COLD });
    bookMod.removeAddressEntry("cold-wallet");
    expect(bookMod.listAddressEntries()).toHaveLength(0);
  });

  it("UNKNOWN_RECIPIENT with 'Did you mean' suggestion for typo", () => {
    bookMod.addAddressEntry({ name: "exchange", address: EXCHANGE });
    bookMod.addAddressEntry({ name: "cold", address: COLD });
    try {
      bookMod.removeAddressEntry("exchage"); // typo: missing 'n'
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("UNKNOWN_RECIPIENT");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.suggestion).toBe("exchange");
      expect(err.message).toMatch(/Did you mean "exchange"/);
    }
  });
});

describe("resolveRecipient (iter614)", () => {
  it("passes through raw 0x addresses unchanged (no lookup)", () => {
    expect(bookMod.resolveRecipient(COLD)).toEqual({ address: COLD });
  });

  it("resolves @alias to the saved address", () => {
    bookMod.addAddressEntry({ name: "cold", address: COLD });
    const result = bookMod.resolveRecipient("@cold");
    expect(result.address).toBe(COLD.toLowerCase());
    expect(result.alias).toBe("cold");
  });

  it("@alias is case-insensitive in lookup", () => {
    bookMod.addAddressEntry({ name: "ColdWallet", address: COLD });
    const result = bookMod.resolveRecipient("@coldwallet");
    expect(result.address).toBe(COLD.toLowerCase());
    expect(result.alias).toBe("ColdWallet"); // canonical case from the saved entry
  });

  it("UNKNOWN_RECIPIENT on missing alias + suggestion", () => {
    bookMod.addAddressEntry({ name: "cold-wallet", address: COLD });
    try {
      bookMod.resolveRecipient("@cold-walet"); // typo
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("UNKNOWN_RECIPIENT");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.suggestion).toBe("cold-wallet");
      expect(err.message).toMatch(/Did you mean "@cold-wallet"/);
    }
  });

  it("invalid alias shape (`@<bad chars>`) fails with INVALID_PARAMS, not UNKNOWN_RECIPIENT", () => {
    try {
      bookMod.resolveRecipient("@cold wallet"); // space — bad name shape
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INVALID_PARAMS");
    }
  });
});

describe("loadAddressBook corruption recovery (iter614)", () => {
  it("returns empty book when the file doesn't exist", () => {
    expect(bookMod.loadAddressBook().entries).toEqual([]);
  });

  it("INTERNAL_ERROR with structured detail on corrupted JSON", () => {
    const path = join(testDataDir, "address-book.json");
    writeFileSync(path, "not-valid-json{{{");
    try {
      bookMod.loadAddressBook();
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INTERNAL_ERROR");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("corrupted");
    }
  });

  it("INTERNAL_ERROR when JSON parses but entries[] is missing", () => {
    const path = join(testDataDir, "address-book.json");
    writeFileSync(path, JSON.stringify({ version: 1, somethingElse: [] }));
    try {
      bookMod.loadAddressBook();
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INTERNAL_ERROR");
    }
  });
});

describe("saveAddressBook write→read roundtrip (iter614)", () => {
  it("save + load returns the same book", () => {
    const book: AddressBook = {
      version: 1,
      entries: [
        { name: "x", address: COLD as `0x${string}`, createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    };
    bookMod.saveAddressBook(book);
    expect(bookMod.loadAddressBook()).toEqual(book);
  });
});
