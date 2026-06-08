import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSecure, chmodSecureIfExists } from "./secureIo.js";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// chmod is meaningful only on POSIX. Windows has NTFS ACLs that don't map to POSIX
// mode bits — fs.chmodSync exists but the mode you read back has limited meaning.
const isPosix = process.platform !== "win32";
const itPosix = isPosix ? it : it.skip;

describe("writeFileSecure (iter128 — key-material file perms)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tradekit-secureio-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  itPosix("writes new file with 0600 (-rw-------)", () => {
    const path = join(dir, "new.txt");
    writeFileSecure(path, "secret");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  itPosix("tightens an existing 0644 file to 0600 (regression: legacy installs)", () => {
    const path = join(dir, "legacy.txt");
    // Simulate pre-iter128 wallet.json: created with default 0644.
    writeFileSync(path, "old contents");
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    writeFileSecure(path, "new contents");

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("writes file contents correctly", () => {
    const path = join(dir, "content.txt");
    writeFileSecure(path, "hello\nworld\n");
    const { readFileSync } = require("fs");
    expect(readFileSync(path, "utf-8")).toBe("hello\nworld\n");
  });

  it("creates parent directory if missing (recursive)", () => {
    const path = join(dir, "nested", "deeper", "file.txt");
    writeFileSecure(path, "x");
    expect(existsSync(path)).toBe(true);
  });
});

describe("chmodSecureIfExists (iter128 — silent legacy promotion on read)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tradekit-chmod-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  itPosix("promotes 0644 → 0600 on an existing file", () => {
    const path = join(dir, "legacy.txt");
    writeFileSync(path, "x");
    chmodSync(path, 0o644);
    chmodSecureIfExists(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("is a no-op when the file does not exist (silent)", () => {
    chmodSecureIfExists(join(dir, "does-not-exist.txt"));
    // No throw is the assertion.
  });

  itPosix("leaves an already-0600 file unchanged", () => {
    const path = join(dir, "already-tight.txt");
    writeFileSync(path, "x");
    chmodSync(path, 0o600);
    chmodSecureIfExists(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
