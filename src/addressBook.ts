// Iter614: address book — named recipient aliases for transfer flows.
//
// Why it matters:
//   - Typo risk on 42-char hex addresses is real. A single bad character →
//     funds sent to a different address → lost forever.
//   - Clipboard-hijack malware swaps copied addresses to attacker-controlled
//     ones at paste time. Address book defends against this since the
//     `@alias` resolution uses the saved address, not whatever's currently on
//     clipboard.
//   - Repeat recipients (cold wallet, exchange deposit, frequent contacts) are
//     a real production workflow. Saved names eliminate the per-transfer
//     paste step.
//
// Security model:
//   - File at $HOME/.tradekit/address-book.json, mode 0600 (same as wallet.json).
//   - Atomic temp+rename via writeFileSecure (iter341).
//   - Names: case-insensitive, [a-zA-Z0-9_-]+ only, max 64 chars (operator
//     types these; allowing arbitrary unicode invites visual-spoofing attacks
//     where two visually-identical names point to different addresses).
//   - Address validation: EIP-55 checksum or raw hex accepted; normalized to
//     lowercase (matches everywhere else in tradekit).

import { existsSync, readFileSync } from "node:fs";
import { isAddress, type Address } from "viem";
import { writeFileSecure, chmodSecureIfExists } from "./secureIo.js";
import { ADDRESS_BOOK_PATH, DATA_DIR } from "./constants.js";
import { ToolError } from "./errors.js";
import { closestMatch } from "./format.js";
import { acquireLock } from "./processLock.js";

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LENGTH = 64;
const MAX_NOTE_LENGTH = 200;
const MAX_ENTRIES = 200;

export interface AddressEntry {
  /** Name as the operator typed it — preserved case for display. Lookups are
   *  case-insensitive. */
  name: string;
  /** EIP-55-checksummed for display; lowercased for comparison. */
  address: Address;
  /** Free-form note (max 200 chars). E.g. "Coinbase deposit", "Cold wallet (2/3 multisig)". */
  note?: string;
  createdAt: string;
}

export interface AddressBook {
  version: 1;
  entries: AddressEntry[];
}

function emptyBook(): AddressBook {
  return { version: 1, entries: [] };
}

export function loadAddressBook(): AddressBook {
  if (!existsSync(ADDRESS_BOOK_PATH)) return emptyBook();
  chmodSecureIfExists(ADDRESS_BOOK_PATH); // promote legacy 0644 → 0600
  try {
    const raw = readFileSync(ADDRESS_BOOK_PATH, "utf-8");
    const parsed = JSON.parse(raw) as AddressBook;
    // Tolerate older or malformed shapes by reverting to empty + warning at
    // throw-call-site if we somehow loaded a non-array `entries`.
    if (!parsed || !Array.isArray(parsed.entries)) {
      throw new ToolError(
        "INTERNAL_ERROR",
        `${ADDRESS_BOOK_PATH} is corrupted (missing or malformed entries array). Restore from backup or delete the file to reset.`,
        { details: { path: ADDRESS_BOOK_PATH, reason: "corrupted" } },
      );
    }
    return parsed;
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(
      "INTERNAL_ERROR",
      `${ADDRESS_BOOK_PATH} is unreadable (${(e as Error).message}). Restore from backup or delete the file to reset.`,
      { details: { path: ADDRESS_BOOK_PATH, reason: "corrupted" } },
    );
  }
}

export function saveAddressBook(book: AddressBook): void {
  writeFileSecure(ADDRESS_BOOK_PATH, JSON.stringify(book, null, 2));
}

/**
 * Iter614: validate a name. Strict rules — see module header for rationale.
 * Throws ToolError("INVALID_PARAMS") with structured details when invalid.
 * Exported for unit testing.
 */
export function validateAddressName(name: string): void {
  if (!name || name.length === 0) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Address book name cannot be empty.",
      { details: { reason: "empty_name" } },
    );
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Address book name too long (${name.length} chars; max ${MAX_NAME_LENGTH}).`,
      { details: { reason: "name_too_long", providedLength: name.length, max: MAX_NAME_LENGTH } },
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Address book name "${name}" contains invalid characters. Use only [a-zA-Z0-9_-] (no spaces, no unicode — visual-spoofing risk).`,
      { details: { reason: "invalid_name_chars", providedName: name } },
    );
  }
}

/**
 * Iter614: case-insensitive lookup. Returns the canonical entry (preserves
 * original-case `name`) when found, null otherwise.
 */
export function findEntry(book: AddressBook, name: string): AddressEntry | null {
  const lower = name.toLowerCase();
  return book.entries.find((e) => e.name.toLowerCase() === lower) ?? null;
}

/**
 * Iter678: find an entry by its on-chain address (case-insensitive). Used by
 * the transfer flow to surface "known recipient: @alice" vs "first-time
 * recipient" at simulate + send time — a safety signal against clipboard
 * hijack, address poisoning, and checksum-valid typos.
 *
 * Returns null when no entry matches. Distinct from findEntry (which is by
 * `name`). Linear scan — book is capped at 200 entries.
 */
export function findByAddress(book: AddressBook, address: string): AddressEntry | null {
  const lower = address.toLowerCase();
  return book.entries.find((e) => e.address.toLowerCase() === lower) ?? null;
}

/**
 * Iter614: parse a recipient input. If it starts with `@`, look up in the
 * address book and return the resolved address. Otherwise return the input
 * unchanged (the caller validates as an address separately).
 *
 * Errors:
 * - UNKNOWN_RECIPIENT with iter343-style "Did you mean" suggestion when the
 *   alias doesn't match any saved entry.
 *
 * Returns the raw input when there's no `@` prefix, so the existing transfer
 * flow's address validation (iter138 isAddress check) still fires for typos
 * in raw addresses.
 */
export function resolveRecipient(input: string): { address: string; alias?: string } {
  if (!input.startsWith("@")) return { address: input };
  const alias = input.slice(1);
  validateAddressName(alias);
  const book = loadAddressBook();
  const entry = findEntry(book, alias);
  if (!entry) {
    const suggestion = closestMatch(
      alias,
      book.entries.map((e) => e.name),
    );
    const hint = suggestion ? ` Did you mean "@${suggestion}"?` : "";
    throw new ToolError(
      "UNKNOWN_RECIPIENT",
      `No address book entry named "@${alias}".${hint} Run \`tradekit address list\` to see saved aliases.`,
      {
        details: {
          providedAlias: alias,
          suggestion,
          known: book.entries.map((e) => e.name),
          reason: "alias_not_found",
        },
      },
    );
  }
  return { address: entry.address, alias: entry.name };
}

/**
 * Iter614: add a new entry. Validates name + address + note. Refuses to
 * overwrite an existing entry — operator must remove first. Cross-process
 * safe via the iter611 lock.
 *
 * Returns the persisted entry (canonical form: original-case name, EIP-55
 * checksummed address — wait, we lowercase. See module header).
 */
export function addAddressEntry(args: {
  name: string;
  address: string;
  note?: string;
  /** If true, overwrite an existing entry with this name. Default false. */
  overwrite?: boolean;
}): AddressEntry {
  validateAddressName(args.name);
  if (!isAddress(args.address, { strict: false })) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Invalid address: ${args.address} (expected 0x-prefixed 40 hex chars).`,
      { details: { providedAddress: args.address, reason: "bad_address_shape" } },
    );
  }
  if (args.note && args.note.length > MAX_NOTE_LENGTH) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Note too long (${args.note.length} chars; max ${MAX_NOTE_LENGTH}).`,
      { details: { reason: "note_too_long", providedLength: args.note.length, max: MAX_NOTE_LENGTH } },
    );
  }
  const lower = args.address.toLowerCase() as Address;

  const lock = acquireLock(DATA_DIR, "address-book", `addAddressEntry(${args.name})`);
  try {
    const book = loadAddressBook();
    if (book.entries.length >= MAX_ENTRIES) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Address book is full (max ${MAX_ENTRIES} entries). Remove unused entries before adding new ones.`,
        { details: { reason: "book_full", max: MAX_ENTRIES, current: book.entries.length } },
      );
    }
    const existing = findEntry(book, args.name);
    if (existing && !args.overwrite) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Address book entry "${args.name}" already exists pointing to ${existing.address}. Pass overwrite=true (CLI: --force) to replace.`,
        {
          details: {
            reason: "name_exists",
            existingAddress: existing.address,
            providedAddress: lower,
          },
        },
      );
    }
    const entry: AddressEntry = {
      name: args.name,
      address: lower,
      note: args.note,
      createdAt: new Date().toISOString(),
    };
    if (existing) {
      // Overwrite — replace in-place to preserve order.
      const idx = book.entries.findIndex((e) => e.name.toLowerCase() === args.name.toLowerCase());
      book.entries[idx] = entry;
    } else {
      book.entries.push(entry);
    }
    saveAddressBook(book);
    return entry;
  } finally {
    lock.release();
  }
}

/**
 * Iter614: remove an entry by name. Returns the removed entry (for the CLI's
 * "removed X" confirmation), or throws UNKNOWN_RECIPIENT with suggestion.
 */
export function removeAddressEntry(name: string): AddressEntry {
  validateAddressName(name);
  const lock = acquireLock(DATA_DIR, "address-book", `removeAddressEntry(${name})`);
  try {
    const book = loadAddressBook();
    const entry = findEntry(book, name);
    if (!entry) {
      const suggestion = closestMatch(
        name,
        book.entries.map((e) => e.name),
      );
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
      throw new ToolError(
        "UNKNOWN_RECIPIENT",
        `No address book entry named "${name}".${hint}`,
        {
          details: {
            providedName: name,
            suggestion,
            known: book.entries.map((e) => e.name),
            reason: "alias_not_found",
          },
        },
      );
    }
    book.entries = book.entries.filter((e) => e.name.toLowerCase() !== name.toLowerCase());
    saveAddressBook(book);
    return entry;
  } finally {
    lock.release();
  }
}

export function listAddressEntries(): AddressEntry[] {
  return loadAddressBook().entries;
}
