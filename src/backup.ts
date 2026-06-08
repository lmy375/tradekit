// Iter612: encrypted full-state backup + restore for the local data dir.
//
// Pre-iter612 the only recovery path if a machine died was the operator's
// paper-backed mnemonic phrase — which only covers HD accounts. Single-key
// keystore (wallet.json), custom-chain config, token overrides, trade history,
// and audit log were lost entirely.
//
// Iter612 packs the full data-dir state into one encrypted bundle that can be
// stored offline (USB, password manager attachment, secondary machine). On
// restore, decrypts to a clean DATA_DIR.
//
// Crypto: scrypt(password, salt) → 32-byte key → AES-256-GCM encrypt the
// JSON-serialized bundle. Same primitive set accounts.ts uses for mnemonic
// encryption — proven, audit-able, and the operator already trusts it for
// their seed.
//
// SECURITY:
// - Backup output is encrypted, but the bundle CONTAINS the encrypted mnemonic
//   keystore. Two layers: (1) the operator's mnemonic-encryption password
//   protects the seed inside, (2) the backup password protects the whole
//   bundle. Operator can use the same or different passwords; this module
//   doesn't enforce either way.
// - Restore is destructive (overwrites DATA_DIR contents). Requires --force
//   (or `forceOverwrite: true`) when any target file already exists, so a
//   stray restore command can't silently clobber a live wallet.

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { DATA_DIR, WALLET_PATH, MNEMONIC_PATH, ACCOUNTS_PATH, DB_PATH, CONFIG_PATH } from "./constants.js";
import { writeFileSecure, ensureDataDir } from "./secureIo.js";
import { ToolError, wrongPasswordError } from "./errors.js";

/** Same scrypt params as accounts.ts mnemonic encryption — proven choice. */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;

/** Backup format version. Bumped on incompatible changes. */
const BACKUP_FORMAT_VERSION = 1;

/** Magic prefix on the file so an accidental open can be recognized as a
 *  tradekit backup before any decryption attempt. */
const MAGIC = "TKBACKUP";

export interface BackupBundle {
  /** Map of filename → file contents (base64-encoded). Files that didn't exist
   *  at backup time aren't present. */
  files: Record<string, string>;
  /** ISO timestamp of when the backup was created. */
  createdAt: string;
  /** Whether the backup includes the trade DB (large; opt-in). */
  includesDb: boolean;
  /** Format version. */
  formatVersion: number;
}

export interface EncryptedBackup {
  magic: typeof MAGIC;
  v: typeof BACKUP_FORMAT_VERSION;
  kdf: "scrypt";
  kdfparams: { salt: string; N: number; r: number; p: number; dkLen: typeof SCRYPT_DKLEN };
  cipher: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface BackupSummary {
  /** Files included in the bundle. */
  files: string[];
  /** Path of the backup file written. */
  outputPath: string;
  /** Size of the encrypted output in bytes (file system size). */
  fileSizeBytes: number;
  /** ISO timestamp of when this backup was created. */
  createdAt: string;
  includesDb: boolean;
}

export interface RestoreSummary {
  /** Files written to DATA_DIR. */
  restoredFiles: string[];
  /** Files in the bundle that already existed locally and were SKIPPED (when
   *  forceOverwrite is false). When forceOverwrite is true this is always empty. */
  skippedFiles: string[];
  /** ISO timestamp of the original backup (from BackupBundle.createdAt). */
  backupCreatedAt: string;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT_DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

/**
 * Iter612: pure encryption — encrypt an arbitrary bundle with a password.
 * Extracted as its own helper so the encrypt/decrypt roundtrip is unit-testable
 * without touching the filesystem.
 */
export function encryptBundle(bundle: BackupBundle, password: string): EncryptedBackup {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    magic: MAGIC,
    v: BACKUP_FORMAT_VERSION,
    kdf: "scrypt",
    kdfparams: { salt: salt.toString("hex"), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: SCRYPT_DKLEN },
    cipher: "aes-256-gcm",
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/**
 * Iter612: pure decryption. Validates the magic + version BEFORE attempting
 * the (slow) scrypt key derivation — fail fast on a wrong file.
 */
export function decryptBundle(encrypted: EncryptedBackup, password: string): BackupBundle {
  // Magic + version checks come first — they're cheap and catch the
  // "wrong file" case before the operator burns scrypt CPU just to hit
  // a GCM auth failure.
  if (encrypted.magic !== MAGIC) {
    throw new ToolError(
      "INVALID_PARAMS",
      `File is not a tradekit backup (missing or wrong magic header).`,
      { details: { reason: "bad_magic", expected: MAGIC, actual: encrypted.magic } },
    );
  }
  if (encrypted.v !== BACKUP_FORMAT_VERSION) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Unsupported backup format version ${encrypted.v}. This build expects v${BACKUP_FORMAT_VERSION}.`,
      { details: { reason: "version_mismatch", expected: BACKUP_FORMAT_VERSION, actual: encrypted.v } },
    );
  }
  const salt = Buffer.from(encrypted.kdfparams.salt, "hex");
  const key = deriveKey(password, salt);
  const iv = Buffer.from(encrypted.iv, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "hex"));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "hex")), decipher.final()]);
  } catch {
    throw wrongPasswordError("mnemonic"); // reuses the iter435 password-error builder
  }
  try {
    return JSON.parse(plain.toString("utf8")) as BackupBundle;
  } catch (e) {
    throw new ToolError(
      "INTERNAL_ERROR",
      `Backup decrypted but contents are corrupt (${(e as Error).message}). The file may have been tampered with.`,
      { details: { reason: "corrupt_bundle" } },
    );
  }
}

/**
 * The default file set we back up. Each entry maps a friendly key (used in the
 * bundle's `files` map) to the absolute path on disk. Files that don't exist
 * at backup time are silently omitted from the bundle.
 *
 * Iter612: DB is opt-in because it can be MBs for a long-running operator and
 * is reconstructible (lossy) via `tradekit trades sync` (iter607) — the
 * irreplaceable items are the keystores + config.
 */
export function defaultBackupFiles(includeDb: boolean): Record<string, string> {
  const map: Record<string, string> = {
    "mnemonic.json": MNEMONIC_PATH,
    "wallet.json": WALLET_PATH,
    "accounts.json": ACCOUNTS_PATH,
    "config.json": CONFIG_PATH,
  };
  if (includeDb) {
    map["tradekit.db"] = DB_PATH;
  }
  return map;
}

/**
 * Read the files-to-back-up from disk + serialize into a BackupBundle.
 * Pure-ish: needs node:fs but no chain interaction. Separated from
 * createBackup so the bundle construction can be tested.
 */
export function buildBackupBundle(
  fileMap: Record<string, string>,
  includesDb: boolean,
): BackupBundle {
  const files: Record<string, string> = {};
  for (const [name, path] of Object.entries(fileMap)) {
    if (!existsSync(path)) continue;
    const data = readFileSync(path);
    files[name] = data.toString("base64");
  }
  return {
    files,
    createdAt: new Date().toISOString(),
    includesDb,
    formatVersion: BACKUP_FORMAT_VERSION,
  };
}

/**
 * Create an encrypted backup. Reads the data dir, builds + encrypts the bundle,
 * writes to outputPath. Returns a summary so the CLI/operator sees what was
 * included.
 */
export function createBackup(args: {
  outputPath: string;
  password: string;
  includeDb?: boolean;
  /** Override the default file map (test injection). */
  fileMap?: Record<string, string>;
}): BackupSummary {
  if (args.password.length === 0) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Backup requires a non-empty password to encrypt the bundle. Use a long passphrase.",
      { details: { reason: "empty_password" } },
    );
  }
  const fileMap = args.fileMap ?? defaultBackupFiles(args.includeDb === true);
  const bundle = buildBackupBundle(fileMap, args.includeDb === true);
  if (Object.keys(bundle.files).length === 0) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Nothing to back up — no tradekit state files exist in the data directory. Run \`tradekit init\` first.`,
      { details: { reason: "empty_data_dir", dataDir: DATA_DIR } },
    );
  }
  const encrypted = encryptBundle(bundle, args.password);
  // Pretty-print for human inspectability — JSON.stringify with indent=2 is
  // fine since the heavy bytes (ciphertext) are already hex.
  writeFileSecure(args.outputPath, JSON.stringify(encrypted, null, 2));
  const stat = statSync(args.outputPath);
  return {
    files: Object.keys(bundle.files),
    outputPath: args.outputPath,
    fileSizeBytes: stat.size,
    createdAt: bundle.createdAt,
    includesDb: bundle.includesDb,
  };
}

/**
 * Restore a previously-created backup into the data dir. Refuses to overwrite
 * existing files unless `forceOverwrite: true` is passed — guards against
 * "I ran restore on the wrong box and clobbered a live wallet".
 */
export function restoreBackup(args: {
  inputPath: string;
  password: string;
  forceOverwrite?: boolean;
  /** Override the data dir target (test injection). */
  targetDir?: string;
  /** Override the default file map (test injection). */
  fileMap?: Record<string, string>;
}): RestoreSummary {
  if (!existsSync(args.inputPath)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Backup file not found: ${args.inputPath}`,
      { details: { reason: "file_not_found", path: args.inputPath } },
    );
  }
  let encrypted: EncryptedBackup;
  try {
    const raw = readFileSync(args.inputPath, "utf-8");
    encrypted = JSON.parse(raw) as EncryptedBackup;
  } catch (e) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Backup file is not valid JSON (${(e as Error).message}). The file may be corrupt or not a tradekit backup.`,
      { details: { reason: "bad_json", path: args.inputPath } },
    );
  }
  const bundle = decryptBundle(encrypted, args.password);

  const targetDir = args.targetDir ?? DATA_DIR;
  ensureDataDir(targetDir);

  const fileMap = args.fileMap ?? defaultBackupFiles(bundle.includesDb);

  // Pre-flight: check for collisions BEFORE writing anything. This way we
  // either restore everything or nothing — no half-restored state.
  const collisions: string[] = [];
  for (const name of Object.keys(bundle.files)) {
    const target = fileMap[name] ?? join(targetDir, name);
    if (existsSync(target)) collisions.push(name);
  }
  if (collisions.length > 0 && !args.forceOverwrite) {
    throw new ToolError(
      "WALLET_EXISTS",
      `Restore would overwrite ${collisions.length} existing file(s): ${collisions.join(", ")}. Pass forceOverwrite/--force to proceed (DESTRUCTIVE — replaces current wallet state).`,
      {
        details: {
          reason: "would_overwrite",
          collisions,
          targetDir,
        },
      },
    );
  }

  const restoredFiles: string[] = [];
  const skippedFiles: string[] = [];
  for (const [name, b64] of Object.entries(bundle.files)) {
    const target = fileMap[name] ?? join(targetDir, name);
    // Defensive: ensure the target's parent exists (data dir already does,
    // but if a test injects a nested target this catches it).
    ensureDataDir(dirname(target));
    const data = Buffer.from(b64, "base64");
    writeFileSync(target, data, { mode: 0o600 });
    restoredFiles.push(name);
  }

  return {
    restoredFiles,
    skippedFiles,
    backupCreatedAt: bundle.createdAt,
  };
}
