// Iter611: unit tests for the cross-process lock module. Verifies acquire,
// release, stale-holder detection, and the probe helper used by doctor.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, withLock, isHolderDead, probeLocks } from "./processLock.js";
import { ToolError } from "./errors.js";

describe("isHolderDead (iter611)", () => {
  it("returns true for invalid pid (0, negative, NaN)", () => {
    expect(isHolderDead(0)).toBe(true);
    expect(isHolderDead(-1)).toBe(true);
    expect(isHolderDead(NaN)).toBe(true);
  });

  it("returns true for a pid that doesn't exist on the system", () => {
    // 99999 is virtually guaranteed not to be a live process on any sane host.
    expect(isHolderDead(99999)).toBe(true);
  });

  it("returns false for our own process (self-pid is always 'alive')", () => {
    // Self-locking is treated as a higher-stack-level bug, not a stale lock.
    // The function returns "alive" so the caller surfaces WALLET_LOCKED rather
    // than silently claiming the self-held lock.
    expect(isHolderDead(process.pid)).toBe(false);
  });
});

describe("acquireLock + release (iter611)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tradekit-lock-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates a lockfile on acquire + removes on release", () => {
    const lockFile = join(dataDir, ".lock.test");
    expect(existsSync(lockFile)).toBe(false);
    const lock = acquireLock(dataDir, "test", "unit test");
    expect(existsSync(lockFile)).toBe(true);
    expect(lock.holder.pid).toBe(process.pid);
    expect(lock.holder.purpose).toBe("unit test");
    expect(lock.holder.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    lock.release();
    expect(existsSync(lockFile)).toBe(false);
  });

  it("the lockfile content is JSON with pid, acquiredAt, purpose", () => {
    const lock = acquireLock(dataDir, "wallet", "createWallet");
    const lockFile = join(dataDir, ".lock.wallet");
    const content = JSON.parse(readFileSync(lockFile, "utf-8"));
    expect(content.pid).toBe(process.pid);
    expect(content.purpose).toBe("createWallet");
    expect(content.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    lock.release();
  });

  it("re-acquire after release succeeds (the lock is genuinely released)", () => {
    const lock1 = acquireLock(dataDir, "test", "first holder");
    lock1.release();
    const lock2 = acquireLock(dataDir, "test", "second holder");
    expect(lock2.holder.purpose).toBe("second holder");
    lock2.release();
  });

  it("acquire on a held lock throws WALLET_LOCKED with structured details", () => {
    // Write a fake lockfile pointing to OUR pid — isHolderDead returns false
    // so the acquire treats it as alive.
    const lockFile = join(dataDir, ".lock.test");
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        purpose: "first holder",
      }),
    );
    try {
      acquireLock(dataDir, "test", "second holder");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("WALLET_LOCKED");
      const details = (err as unknown as { details?: Record<string, unknown> }).details;
      expect(details?.lockName).toBe("test");
      expect(details?.holderPid).toBe(process.pid);
      expect(details?.holderPurpose).toBe("first holder");
      expect(details?.reason).toBe("lock_held");
    }
  });

  it("acquire over a STALE lockfile (dead pid) succeeds and overwrites", () => {
    // Pre-existing lockfile from a "crashed" process (pid 99999 doesn't exist).
    const lockFile = join(dataDir, ".lock.test");
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 99999,
        acquiredAt: "2020-01-01T00:00:00.000Z",
        purpose: "crashed predecessor",
      }),
    );
    const lock = acquireLock(dataDir, "test", "recovery");
    expect(lock.holder.pid).toBe(process.pid);
    expect(lock.holder.purpose).toBe("recovery");
    lock.release();
  });

  it("acquire over a CORRUPT lockfile (unreadable JSON) succeeds and overwrites", () => {
    // Stale lock from a write that crashed before fsync — content is garbage.
    const lockFile = join(dataDir, ".lock.test");
    writeFileSync(lockFile, "not-valid-json{{{");
    const lock = acquireLock(dataDir, "test", "recovery");
    expect(lock.holder.pid).toBe(process.pid);
    lock.release();
  });

  it("release is idempotent (multiple releases don't throw)", () => {
    const lock = acquireLock(dataDir, "test", "unit test");
    lock.release();
    // Second release should silently no-op, not throw "ENOENT".
    expect(() => lock.release()).not.toThrow();
  });

  it("different lock names don't conflict", () => {
    const a = acquireLock(dataDir, "wallet", "wallet op");
    const b = acquireLock(dataDir, "config", "config op");
    expect(existsSync(join(dataDir, ".lock.wallet"))).toBe(true);
    expect(existsSync(join(dataDir, ".lock.config"))).toBe(true);
    a.release();
    b.release();
  });
});

describe("withLock wrapper (iter611)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tradekit-lock-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("runs the operation under the lock + releases after success", async () => {
    const lockFile = join(dataDir, ".lock.test");
    let lockFileHeldDuringOp = false;
    const result = await withLock(dataDir, "test", "test op", () => {
      lockFileHeldDuringOp = existsSync(lockFile);
      return "result-value";
    });
    expect(result).toBe("result-value");
    expect(lockFileHeldDuringOp).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("releases the lock even when the operation throws", async () => {
    const lockFile = join(dataDir, ".lock.test");
    await expect(
      withLock(dataDir, "test", "test op", () => {
        throw new Error("inside-op failure");
      }),
    ).rejects.toThrow(/inside-op failure/);
    // Lock must still be released.
    expect(existsSync(lockFile)).toBe(false);
  });

  it("works with async operations", async () => {
    const lockFile = join(dataDir, ".lock.test");
    const result = await withLock(dataDir, "test", "test op", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return existsSync(lockFile) ? "still-locked" : "no-lock";
    });
    expect(result).toBe("still-locked");
    expect(existsSync(lockFile)).toBe(false);
  });
});

describe("probeLocks (iter611)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tradekit-lock-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns empty for an empty data dir", () => {
    expect(probeLocks(dataDir)).toEqual([]);
  });

  it("returns empty for a non-existent data dir", () => {
    expect(probeLocks(join(dataDir, "does-not-exist"))).toEqual([]);
  });

  it("identifies held locks (alive pid)", () => {
    const lock = acquireLock(dataDir, "wallet", "live operation");
    const probes = probeLocks(dataDir);
    expect(probes).toHaveLength(1);
    expect(probes[0].name).toBe("wallet");
    expect(probes[0].status).toBe("held");
    expect(probes[0].holder?.pid).toBe(process.pid);
    lock.release();
  });

  it("identifies stale locks (dead pid)", () => {
    const lockFile = join(dataDir, ".lock.stale");
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 99999,
        acquiredAt: "2020-01-01T00:00:00.000Z",
        purpose: "crashed predecessor",
      }),
    );
    const probes = probeLocks(dataDir);
    expect(probes).toHaveLength(1);
    expect(probes[0].name).toBe("stale");
    expect(probes[0].status).toBe("stale");
    expect(probes[0].holder?.pid).toBe(99999);
  });

  it("identifies corrupt locks (unreadable JSON)", () => {
    writeFileSync(join(dataDir, ".lock.corrupt"), "garbage");
    const probes = probeLocks(dataDir);
    expect(probes).toHaveLength(1);
    expect(probes[0].name).toBe("corrupt");
    expect(probes[0].status).toBe("corrupt");
    expect(probes[0].holder).toBeNull();
  });

  it("ignores non-lock files in the data dir", () => {
    writeFileSync(join(dataDir, "config.json"), "{}");
    writeFileSync(join(dataDir, "wallet.json"), "{}");
    writeFileSync(join(dataDir, ".other-hidden"), "");
    expect(probeLocks(dataDir)).toEqual([]);
  });

  it("can find multiple locks simultaneously", () => {
    const a = acquireLock(dataDir, "wallet", "op A");
    const b = acquireLock(dataDir, "config", "op B");
    const probes = probeLocks(dataDir);
    expect(probes).toHaveLength(2);
    expect(probes.map((p) => p.name).sort()).toEqual(["config", "wallet"]);
    a.release();
    b.release();
  });
});
