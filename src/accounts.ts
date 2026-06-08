import { existsSync, readFileSync } from "fs";
import { writeFileSecure, chmodSecureIfExists, ensureDataDir } from "./secureIo.js";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "crypto";
import {
  generateMnemonic,
  mnemonicToAccount,
  english,
} from "viem/accounts";
import type { Address, HDAccount } from "viem";
import { DATA_DIR, MNEMONIC_PATH, ACCOUNTS_PATH, WALLET_PATH, KEYSTORE_LABEL } from "./constants.js";
import { ToolError, wrongPasswordError } from "./errors.js";
import { closestMatch } from "./format.js";
import { acquireLock } from "./processLock.js";

/**
 * Iter611: wraps an accounts-file or mnemonic-keystore mutation under the
 * shared "wallet" cross-process lock. Pre-iter611 a `tradekit wallet create`
 * + `tradekit account add` racing across processes could clobber accounts.json
 * (atomic temp+rename prevents partial-write but not last-write-wins).
 */
function withWalletLock<T>(purpose: string, fn: () => T): T {
  const lock = acquireLock(DATA_DIR, "wallet", purpose);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/**
 * Build an UNKNOWN_ACCOUNT error with a "Did you mean" hint when the requested label
 * is a single typo away from a known label. Iter344 — same UX as iter162/164 (command
 * + sub-action typos) and iter343 (chain typos). Centralized so the three call sites
 * (deriveAccount, setActiveAccount, loadWallet) give consistent feedback.
 */
export function unknownAccountError(label: string, knownLabels: readonly string[]): ToolError {
  const suggestion = closestMatch(label, knownLabels as string[]);
  const suggestionNote = suggestion ? ` Did you mean "${suggestion}"?` : "";
  const known = knownLabels.length > 0 ? knownLabels.map((l) => `"${l}"`).join(", ") : "(none)";
  return new ToolError(
    "UNKNOWN_ACCOUNT",
    `No account labeled "${label}".${suggestionNote} Known: ${known}.`,
    { details: { label, knownLabels, suggestion } },
  );
}

// ── encrypted mnemonic keystore (scrypt + AES-256-GCM) ───────

interface MnemonicKeystore {
  v: 1;
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  kdfparams: { salt: string; N: number; r: number; p: number; dkLen: 32 };
  iv: string;
  ciphertext: string;
  authTag: string;
  /** First derived account (index 0) for display purposes only. */
  firstAddress: Address;
}

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
}

export function encryptMnemonic(mnemonic: string, password: string, firstAddress: Address): MnemonicKeystore {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(mnemonic, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    v: 1,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    kdfparams: { salt: salt.toString("hex"), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: 32 },
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: authTag.toString("hex"),
    firstAddress,
  };
}

export function decryptMnemonic(keystore: MnemonicKeystore, password: string): string {
  const salt = Buffer.from(keystore.kdfparams.salt, "hex");
  const key = deriveKey(password, salt);
  const iv = Buffer.from(keystore.iv, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(keystore.authTag, "hex"));
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(keystore.ciphertext, "hex")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw wrongPasswordError("mnemonic");
  }
}

// ── accounts.json: labelled HD account list ──────────────────

export interface AccountEntry {
  label: string;
  /** BIP-44 path index, e.g. 0 means m/44'/60'/0'/0/0 */
  index: number;
  /** Cached address for the derivation (for offline display). */
  address: Address;
  createdAt: string;
}

export interface AccountsFile {
  version: 1;
  /** Which account label is currently active. */
  active: string;
  accounts: AccountEntry[];
}

function defaultAccountsFile(firstAddress: Address): AccountsFile {
  return {
    version: 1,
    active: "default",
    accounts: [{ label: "default", index: 0, address: firstAddress, createdAt: new Date().toISOString() }],
  };
}

export function loadAccountsFile(): AccountsFile | null {
  if (!existsSync(ACCOUNTS_PATH)) return null;
  // Pre-iter180 a corrupted accounts.json silently returned null, so the tool
  // behaved as if only the single-key keystore existed — hiding the HD wallet
  // entirely. Surface parse failures loudly so the user can recover instead of
  // wondering why their HD accounts disappeared.
  let raw: string;
  try {
    raw = readFileSync(ACCOUNTS_PATH, "utf-8");
  } catch (e) {
    throw new ToolError(
      "INTERNAL_ERROR",
      `Failed to read ${ACCOUNTS_PATH}: ${(e as Error).message}`,
      { details: { path: ACCOUNTS_PATH, reason: "read_failed" } },
    );
  }
  try {
    return JSON.parse(raw) as AccountsFile;
  } catch (e) {
    throw new ToolError(
      "INTERNAL_ERROR",
      `${ACCOUNTS_PATH} is corrupted (${(e as Error).message}). Restore it from backup if you have one. mnemonic.json (the encrypted seed) is unaffected — your funds aren't lost; only the labelled-account index is broken.`,
      { details: { path: ACCOUNTS_PATH, reason: "corrupted" } },
    );
  }
}

export function saveAccountsFile(file: AccountsFile): void {
  ensureDataDir(DATA_DIR);
  writeFileSecure(ACCOUNTS_PATH, JSON.stringify(file, null, 2) + "\n");
}

// ── high-level operations ────────────────────────────────────

export function hasMnemonic(): boolean {
  return existsSync(MNEMONIC_PATH);
}

export function loadMnemonicKeystore(): MnemonicKeystore {
  if (!existsSync(MNEMONIC_PATH)) {
    throw new ToolError(
      "WALLET_NOT_FOUND",
      "No mnemonic wallet found. Run `tradekit account create-mnemonic` first.",
      { details: { path: MNEMONIC_PATH, reason: "no_mnemonic" } },
    );
  }
  // Promote legacy 0644 → 0600 on every read so older installs upgrade silently.
  chmodSecureIfExists(MNEMONIC_PATH);
  let raw: string;
  try {
    raw = readFileSync(MNEMONIC_PATH, "utf-8");
  } catch (e) {
    throw new ToolError(
      "INTERNAL_ERROR",
      `Failed to read ${MNEMONIC_PATH}: ${(e as Error).message}`,
      { details: { path: MNEMONIC_PATH, reason: "read_failed" } },
    );
  }
  try {
    return JSON.parse(raw) as MnemonicKeystore;
  } catch (e) {
    // CATASTROPHIC: a corrupted mnemonic.json means the encrypted seed is unreadable
    // and the wallet's funds are unrecoverable from this install. Be explicit so the
    // user goes to their backup (mnemonic phrase paper / vault) immediately instead
    // of thinking it's some recoverable parse issue.
    throw new ToolError(
      "INTERNAL_ERROR",
      `${MNEMONIC_PATH} is corrupted and cannot be parsed (${(e as Error).message}). Your encrypted seed is unreadable — the only recovery is restoring the file from backup OR re-importing the 12/24-word mnemonic via 'tradekit account import-mnemonic'. accounts.json is unaffected but useless without the seed.`,
      { details: { path: MNEMONIC_PATH, reason: "corrupted", severity: "catastrophic" } },
    );
  }
}

export function saveMnemonicKeystore(ks: MnemonicKeystore): void {
  ensureDataDir(DATA_DIR);
  writeFileSecure(MNEMONIC_PATH, JSON.stringify(ks, null, 2) + "\n");
}

/**
 * Create a new mnemonic and persist its encrypted keystore + accounts.json with a single
 * "default" account at index 0. Returns the mnemonic so the user can back it up.
 */
export function createMnemonicWallet(password: string): { mnemonic: string; address: Address } {
  // Iter611: serialize wallet creation across processes. Otherwise two
  // concurrent `account create-mnemonic` invocations could both pass the
  // existsSync check, both write, and the last writer wins — silently
  // overwriting the first wallet's mnemonic.
  return withWalletLock("createMnemonicWallet", () => {
    if (existsSync(MNEMONIC_PATH)) {
      throw new ToolError(
        "WALLET_EXISTS",
        `Mnemonic wallet already exists at ${MNEMONIC_PATH}. Delete the file to recreate.`,
        { details: { path: MNEMONIC_PATH, operation: "create" } },
      );
    }
    const mnemonic = generateMnemonic(english);
    const acc = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    saveMnemonicKeystore(encryptMnemonic(mnemonic, password, acc.address));
    saveAccountsFile(defaultAccountsFile(acc.address));
    return { mnemonic, address: acc.address };
  });
}

/** Import an existing mnemonic. */
export function importMnemonicWallet(mnemonic: string, password: string): Address {
  // Iter611: same lock as createMnemonicWallet. The two flows are
  // interchangeable — both produce a mnemonic.json + accounts.json pair —
  // and shouldn't be allowed to overlap.
  return withWalletLock("importMnemonicWallet", () => {
    if (existsSync(MNEMONIC_PATH)) {
      throw new ToolError(
        "WALLET_EXISTS",
        `Mnemonic wallet already exists at ${MNEMONIC_PATH}. Delete the file to overwrite.`,
        { details: { path: MNEMONIC_PATH, operation: "import" } },
      );
    }
    const trimmed = mnemonic.trim().replace(/\s+/g, " ");
    let acc: HDAccount;
    try {
      acc = mnemonicToAccount(trimmed, { addressIndex: 0 });
    } catch (e) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Invalid mnemonic: ${(e as Error).message}`,
        { details: { reason: "mnemonic_parse_failed" } },
      );
    }
    saveMnemonicKeystore(encryptMnemonic(trimmed, password, acc.address));
    saveAccountsFile(defaultAccountsFile(acc.address));
    return acc.address;
  });
}

/** Derive an HDAccount for a given label using the encrypted mnemonic. */
export function deriveAccount(label: string, password: string): HDAccount {
  const ks = loadMnemonicKeystore();
  const file = loadAccountsFile();
  if (!file) {
    throw new ToolError(
      "WALLET_NOT_FOUND",
      "accounts.json not found. Recreate via `tradekit account create-mnemonic`.",
      { details: { path: ACCOUNTS_PATH, reason: "no_accounts_index" } },
    );
  }
  const entry = file.accounts.find((a) => a.label === label);
  if (!entry) {
    throw unknownAccountError(label, file.accounts.map((a) => a.label));
  }
  const mnemonic = decryptMnemonic(ks, password);
  return mnemonicToAccount(mnemonic, { addressIndex: entry.index });
}

/** Add a new derived account at the next available index. */
export function addAccount(label: string, password: string, indexOverride?: number): AccountEntry {
  // Iter611: serialize across processes. Two concurrent `account add` calls
  // racing each other would both pass the duplicate-label check, both compute
  // the same next-index, and the last writer would clobber. The lock makes
  // each addAccount serial w.r.t. every other wallet mutation.
  return withWalletLock(`addAccount(${label})`, () => addAccountInner(label, password, indexOverride));
}

function addAccountInner(label: string, password: string, indexOverride?: number): AccountEntry {
  const ks = loadMnemonicKeystore();
  const file = loadAccountsFile();
  if (!file) {
    // Iter301: same actionable shape as the line-133 message just above (loadMnemonicKeystore).
    throw new ToolError(
      "WALLET_NOT_FOUND",
      "accounts.json not found. Run `tradekit account create-mnemonic` (new HD wallet) or `tradekit account import-mnemonic` (existing 12/24-word seed) first.",
      { details: { path: ACCOUNTS_PATH, reason: "no_accounts_index" } },
    );
  }
  const trimmedLabel = label.trim();
  if (trimmedLabel.length === 0) {
    throw new ToolError("INVALID_PARAMS", "Account label cannot be empty or whitespace-only.");
  }
  // Iter519: reserve the literal string "keystore" so an HD account can't collide
  // with the single-key keystore identifier (KEYSTORE_LABEL constant used everywhere
  // for audit attribution, wallet-view text Account-line gating, dual-wallet
  // disambiguation). Pre-iter519 nothing stopped a user from `account add keystore`,
  // which would silently break iter505's `if (label !== "keystore")` text gate +
  // every other site that treats "keystore" as the single-key marker.
  if (trimmedLabel.toLowerCase() === KEYSTORE_LABEL) {
    throw new ToolError(
      "INVALID_PARAMS",
      `"${KEYSTORE_LABEL}" is reserved as the single-key wallet identifier — pick a different HD account label.`,
      { details: { label: trimmedLabel, reason: "reserved_label", reservedLabel: KEYSTORE_LABEL } },
    );
  }
  if (file.accounts.some((a) => a.label === trimmedLabel)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Account label "${trimmedLabel}" already exists.`,
      { details: { label: trimmedLabel, reason: "duplicate_label", existingLabels: file.accounts.map((a) => a.label) } },
    );
  }
  // Pre-iter140 a user could do `account add main2 --index 0` and the new account would
  // share the same derivation path as "default" — same address, same private key, two
  // labels pointing at one wallet. Reject explicit index reuse so the user doesn't
  // accidentally manage two pointers to the same key as if they were separate funds.
  if (typeof indexOverride === "number") {
    const collision = file.accounts.find((a) => a.index === indexOverride);
    if (collision) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Index ${indexOverride} is already used by account "${collision.label}" (${collision.address}). Use a different --index, or omit it for the next available.`,
        {
          details: {
            requestedIndex: indexOverride,
            collisionLabel: collision.label,
            collisionAddress: collision.address,
            reason: "index_reuse",
            nextAvailableIndex: file.accounts.reduce((max, a) => Math.max(max, a.index), -1) + 1,
          },
        },
      );
    }
  }
  const index =
    indexOverride ?? (file.accounts.reduce((max, a) => Math.max(max, a.index), -1) + 1);
  const mnemonic = decryptMnemonic(ks, password);
  const derived = mnemonicToAccount(mnemonic, { addressIndex: index });
  const entry: AccountEntry = {
    label: trimmedLabel,
    index,
    address: derived.address,
    createdAt: new Date().toISOString(),
  };
  file.accounts.push(entry);
  saveAccountsFile(file);
  return entry;
}

export function setActiveAccount(label: string): AccountsFile {
  // Iter611: serialize. Concurrent `account use A` + `account use B` would
  // race the same accounts.json — the last writer's label wins silently. The
  // lock makes the order deterministic and the loser sees WALLET_LOCKED.
  return withWalletLock(`setActiveAccount(${label})`, () => setActiveAccountInner(label));
}

function setActiveAccountInner(label: string): AccountsFile {
  const file = loadAccountsFile();
  if (!file) {
    throw new ToolError(
      "WALLET_NOT_FOUND",
      "accounts.json not found. Run `tradekit account create-mnemonic` or `tradekit account import-mnemonic` first.",
      { details: { path: ACCOUNTS_PATH, reason: "no_accounts_index" } },
    );
  }
  const trimmed = label.trim();
  if (!file.accounts.some((a) => a.label === trimmed)) {
    // List the known labels in the error — pre-iter141 a typo'd `account use mian`
    // surfaced as just `No account labeled "mian"` and the user had to run `account
    // list` separately to see what to pick. Iter344: also suggest the closest match.
    throw unknownAccountError(trimmed, file.accounts.map((a) => a.label));
  }
  file.active = trimmed;
  saveAccountsFile(file);
  return file;
}

export function listAccounts(): AccountsFile | null {
  return loadAccountsFile();
}

export function activeAccountEntry(): AccountEntry | null {
  // Best-effort: callers like the audit-attribution path use this and shouldn't crash
  // when accounts.json is corrupted. loadAccountsFile still throws for callers that
  // explicitly need the file (account list/use/add) so the operator sees the recovery
  // message. Here we degrade to "no active account known".
  let file: AccountsFile | null;
  try {
    file = loadAccountsFile();
  } catch {
    return null;
  }
  if (!file) return null;
  return file.accounts.find((a) => a.label === file.active) ?? null;
}

/** Returns true if either a single-key keystore or a mnemonic keystore exists. */
export function anyWalletExists(): boolean {
  return existsSync(WALLET_PATH) || existsSync(MNEMONIC_PATH);
}
