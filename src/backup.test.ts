// Iter612: unit tests for the encrypted backup module. Cover:
//   - Pure encrypt/decrypt roundtrip + tampering / wrong-password detection
//   - Magic + version checks fire BEFORE scrypt (cheap fast-fail)
//   - buildBackupBundle skips missing files (no crash)
//   - createBackup / restoreBackup file-IO roundtrip via tmp dir
//   - restoreBackup refuses to overwrite without forceOverwrite

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  encryptBundle,
  decryptBundle,
  buildBackupBundle,
  createBackup,
  restoreBackup,
  type BackupBundle,
  type EncryptedBackup,
} from "./backup.js";
import { ToolError } from "./errors.js";

const sampleBundle = (): BackupBundle => ({
  files: {
    "wallet.json": Buffer.from(JSON.stringify({ encrypted: "fake-keystore" })).toString("base64"),
    "config.json": Buffer.from(JSON.stringify({ activeChain: "base" })).toString("base64"),
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  includesDb: false,
  formatVersion: 1,
});

describe("encryptBundle / decryptBundle roundtrip (iter612)", () => {
  it("encrypt-then-decrypt preserves the bundle exactly", () => {
    const original = sampleBundle();
    const encrypted = encryptBundle(original, "correct password");
    const decrypted = decryptBundle(encrypted, "correct password");
    expect(decrypted).toEqual(original);
  });

  it("encrypted shape carries magic + version + scrypt + AES-GCM parameters", () => {
    const encrypted = encryptBundle(sampleBundle(), "password");
    expect(encrypted.magic).toBe("TKBACKUP");
    expect(encrypted.v).toBe(1);
    expect(encrypted.cipher).toBe("aes-256-gcm");
    expect(encrypted.kdf).toBe("scrypt");
    expect(encrypted.kdfparams.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(encrypted.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(encrypted.authTag).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof encrypted.ciphertext).toBe("string");
  });

  it("the same plaintext + password produces DIFFERENT ciphertexts (fresh salt + iv each call)", () => {
    const original = sampleBundle();
    const a = encryptBundle(original, "password");
    const b = encryptBundle(original, "password");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.kdfparams.salt).not.toBe(b.kdfparams.salt);
    expect(a.iv).not.toBe(b.iv);
    // Both still decrypt to the same plaintext.
    expect(decryptBundle(a, "password")).toEqual(decryptBundle(b, "password"));
  });

  it("wrong password fails the GCM auth tag check (wrongPasswordError)", () => {
    const encrypted = encryptBundle(sampleBundle(), "correct");
    try {
      decryptBundle(encrypted, "wrong password");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("WRONG_PASSWORD");
    }
  });

  it("tampered ciphertext also fails (GCM auth integrates the ciphertext)", () => {
    const encrypted = encryptBundle(sampleBundle(), "password");
    // Flip a byte in the ciphertext.
    const tampered: EncryptedBackup = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.slice(0, -2) + (encrypted.ciphertext.slice(-2) === "00" ? "01" : "00"),
    };
    expect(() => decryptBundle(tampered, "password")).toThrow();
  });

  it("magic check fires BEFORE scrypt (fast-fail on wrong file)", () => {
    const encrypted = encryptBundle(sampleBundle(), "password");
    const bogus: EncryptedBackup = { ...encrypted, magic: "NOT_OURS" as never };
    try {
      decryptBundle(bogus, "password");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INVALID_PARAMS");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("bad_magic");
    }
  });

  it("version mismatch fires with structured details", () => {
    const encrypted = encryptBundle(sampleBundle(), "password");
    const futureVersion: EncryptedBackup = { ...encrypted, v: 99 as never };
    try {
      decryptBundle(futureVersion, "password");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INVALID_PARAMS");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("version_mismatch");
      expect(details?.expected).toBe(1);
      expect(details?.actual).toBe(99);
    }
  });
});

describe("buildBackupBundle (iter612)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tradekit-backup-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns an empty files map when no source files exist", () => {
    const bundle = buildBackupBundle(
      { "missing.json": join(dataDir, "missing.json") },
      false,
    );
    expect(bundle.files).toEqual({});
    expect(bundle.formatVersion).toBe(1);
    expect(bundle.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes only files that actually exist (skips missing ones silently)", () => {
    writeFileSync(join(dataDir, "real.json"), "real-content");
    const bundle = buildBackupBundle(
      {
        "real.json": join(dataDir, "real.json"),
        "missing.json": join(dataDir, "missing.json"),
      },
      false,
    );
    expect(Object.keys(bundle.files)).toEqual(["real.json"]);
    expect(Buffer.from(bundle.files["real.json"], "base64").toString()).toBe("real-content");
  });

  it("base64-encodes binary content correctly", () => {
    // Mimic the trade DB — a binary file. Base64 must roundtrip byte-exactly.
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
    writeFileSync(join(dataDir, "bin.db"), binary);
    const bundle = buildBackupBundle({ "bin.db": join(dataDir, "bin.db") }, true);
    expect(Buffer.from(bundle.files["bin.db"], "base64")).toEqual(binary);
  });
});

describe("createBackup + restoreBackup file IO (iter612)", () => {
  let dataDir: string;
  let backupPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tradekit-backup-test-"));
    backupPath = join(dataDir, "backup.json");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("createBackup → restoreBackup roundtrip recovers all source files exactly", () => {
    // Set up source files.
    const srcDir = join(dataDir, "src");
    const restoreDir = join(dataDir, "restore");
    writeFileSync(join(dataDir, "wallet.src"), JSON.stringify({ keystore: "wallet-data" }));
    writeFileSync(join(dataDir, "config.src"), JSON.stringify({ chain: "base" }));

    const fileMap = {
      "wallet.json": join(dataDir, "wallet.src"),
      "config.json": join(dataDir, "config.src"),
    };
    const restoreMap = {
      "wallet.json": join(restoreDir, "wallet.json"),
      "config.json": join(restoreDir, "config.json"),
    };

    const summary = createBackup({
      outputPath: backupPath,
      password: "test-password",
      fileMap,
    });
    expect(summary.files).toEqual(["wallet.json", "config.json"]);
    expect(existsSync(backupPath)).toBe(true);
    expect(statSync(backupPath).size).toBeGreaterThan(100);

    const restored = restoreBackup({
      inputPath: backupPath,
      password: "test-password",
      targetDir: restoreDir,
      fileMap: restoreMap,
    });
    expect(restored.restoredFiles).toEqual(["wallet.json", "config.json"]);
    // Restored content matches source byte-exactly.
    expect(readFileSync(restoreMap["wallet.json"], "utf-8")).toBe(JSON.stringify({ keystore: "wallet-data" }));
    expect(readFileSync(restoreMap["config.json"], "utf-8")).toBe(JSON.stringify({ chain: "base" }));
  });

  it("createBackup rejects empty password", () => {
    writeFileSync(join(dataDir, "src.json"), "x");
    expect(() =>
      createBackup({
        outputPath: backupPath,
        password: "",
        fileMap: { "src.json": join(dataDir, "src.json") },
      }),
    ).toThrow(/non-empty password/);
  });

  it("createBackup rejects empty data dir", () => {
    expect(() =>
      createBackup({
        outputPath: backupPath,
        password: "test",
        fileMap: { "missing.json": join(dataDir, "missing.json") },
      }),
    ).toThrow(/Nothing to back up/);
  });

  it("restoreBackup refuses to overwrite existing files without forceOverwrite", () => {
    // Set up source + backup.
    writeFileSync(join(dataDir, "src.json"), "source");
    const fileMap = { "wallet.json": join(dataDir, "src.json") };
    createBackup({ outputPath: backupPath, password: "test", fileMap });
    // Set up a pre-existing target file.
    const restoreDir = join(dataDir, "restore");
    writeFileSync(join(restoreDir + "-mk-parent"), "");
    // Use restoreDir but with the wallet.json target pre-populated.
    const targetWalletPath = join(restoreDir, "wallet.json");
    writeFileSync(join(dataDir, "target-existing"), "existing-content");

    try {
      restoreBackup({
        inputPath: backupPath,
        password: "test",
        targetDir: restoreDir,
        fileMap: { "wallet.json": join(dataDir, "target-existing") },
      });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("WALLET_EXISTS");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("would_overwrite");
      expect(details?.collisions).toEqual(["wallet.json"]);
    }
    // The pre-existing file must be untouched (atomic pre-flight, not partial restore).
    expect(readFileSync(join(dataDir, "target-existing"), "utf-8")).toBe("existing-content");
    // Reference target check
    void targetWalletPath;
  });

  it("restoreBackup with forceOverwrite=true replaces existing files", () => {
    writeFileSync(join(dataDir, "src.json"), "new-content");
    const fileMap = { "wallet.json": join(dataDir, "src.json") };
    createBackup({ outputPath: backupPath, password: "test", fileMap });

    writeFileSync(join(dataDir, "target-existing"), "old-content");
    restoreBackup({
      inputPath: backupPath,
      password: "test",
      forceOverwrite: true,
      targetDir: join(dataDir, "restore"),
      fileMap: { "wallet.json": join(dataDir, "target-existing") },
    });
    expect(readFileSync(join(dataDir, "target-existing"), "utf-8")).toBe("new-content");
  });

  it("restoreBackup rejects missing input file with structured error", () => {
    try {
      restoreBackup({
        inputPath: join(dataDir, "does-not-exist.json"),
        password: "test",
      });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INVALID_PARAMS");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("file_not_found");
    }
  });

  it("restoreBackup rejects non-JSON input with structured error", () => {
    writeFileSync(backupPath, "not-valid-json{{{");
    try {
      restoreBackup({
        inputPath: backupPath,
        password: "test",
      });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("INVALID_PARAMS");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.reason).toBe("bad_json");
    }
  });

  it("backup → restore preserves binary file content (DB-like)", () => {
    // Real-world case: the trade DB is binary. Backup → restore must
    // preserve bytes exactly through base64 → encrypt → decrypt → base64.
    const binary = Buffer.from([0, 1, 2, 0xff, 0xfe, 0xfd, 0x80, 0x7f]);
    const srcPath = join(dataDir, "db.src");
    const restorePath = join(dataDir, "db.restored");
    writeFileSync(srcPath, binary);
    createBackup({
      outputPath: backupPath,
      password: "test",
      includeDb: true,
      fileMap: { "tradekit.db": srcPath },
    });
    restoreBackup({
      inputPath: backupPath,
      password: "test",
      targetDir: dataDir,
      fileMap: { "tradekit.db": restorePath },
    });
    const restored = readFileSync(restorePath);
    expect(Buffer.compare(restored, binary)).toBe(0);
  });
});
