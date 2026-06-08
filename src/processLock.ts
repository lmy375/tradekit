// Iter611: cross-process advisory lock for wallet/account mutations.
//
// Pre-iter611 a concurrent `tradekit wallet create` + `tradekit account add`
// could race on accounts.json / mnemonic.json mid-write. Atomic temp+rename
// (iter341 writeFileSecure) prevents partial-write CORRUPTION but doesn't
// stop two complete writes from clobbering each other in either order.
//
// Strategy: file-system advisory lock via atomic O_EXCL lockfile creation.
//   - acquire: openSync(lockPath, "wx") — fails if file exists (= someone
//     else holds the lock). On success, write our pid + timestamp + a
//     human-readable description into the file so doctor can identify a
//     stale lock holder.
//   - release: unlinkSync(lockPath). Called in a finally block so a thrown
//     error during the critical section still releases.
//   - stale lock recovery: if the lock file exists AND the recorded pid is
//     dead (kill(pid, 0) throws ESRCH), we release the stale lock and proceed.
//     Same pattern shell utilities like flock(1) use.
//
// This is NOT a kernel-level lock (no fcntl/flock) — file-system-only. Works
// across processes on the same machine; doesn't work across NFS mounts where
// O_EXCL semantics vary by server. Good enough for tradekit's single-machine
// data-dir convention.

import { existsSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir } from "./secureIo.js";
import { ToolError } from "./errors.js";

/**
 * Resolve the lock-file path for a given mutation kind. Each lock is named so
 * doctor / human ops can identify it. The lock lives in the data dir so it
 * inherits the umask 0o077 + chmod 0o600 conventions.
 */
function lockPath(dataDir: string, name: string): string {
  return join(dataDir, `.lock.${name}`);
}

export interface LockHolder {
  /** OS pid that wrote the lock. */
  pid: number;
  /** ISO timestamp the lock was acquired. */
  acquiredAt: string;
  /** Free-form purpose string the holder declared. */
  purpose: string;
}

/**
 * Iter611: pure stale-lock detection. Given the recorded pid, is the holder
 * still alive? Uses `process.kill(pid, 0)` which sends signal 0 — doesn't
 * affect the target but throws ESRCH if no such process exists.
 *
 * Returns true when the pid is dead (lock is stale, safe to claim).
 * Returns false when the pid is alive (must wait).
 *
 * Exported for unit testing and for doctor's stale-lock probe.
 */
export function isHolderDead(pid: number): boolean {
  if (pid <= 0 || !Number.isFinite(pid)) return true; // garbage pid → stale
  // Can't check our own pid for liveness (always alive); a self-lock is a bug
  // higher up the stack, not a stale lock — treat as alive.
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false; // signal succeeded → alive
  } catch (e) {
    // ESRCH = no such process. EPERM = exists but we don't have permission to
    // signal it (still alive, just not ours to manage). Treat ESRCH as dead,
    // EPERM as alive (conservative).
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ESRCH";
  }
}

/**
 * Acquire a named lock with stale-holder cleanup. Throws ToolError if the
 * lock is held by an alive process; otherwise creates the lock atomically
 * and returns a release function the caller must call (typically via a
 * try/finally).
 */
export function acquireLock(
  dataDir: string,
  name: string,
  purpose: string,
): { release: () => void; holder: LockHolder } {
  ensureDataDir(dataDir);
  const path = lockPath(dataDir, name);

  // If a lock file exists, check whether it's stale.
  if (existsSync(path)) {
    let holder: LockHolder | null = null;
    try {
      const content = readFileSync(path, "utf-8");
      holder = JSON.parse(content) as LockHolder;
    } catch {
      // Lockfile exists but is unreadable / unparseable. Treat as stale
      // (corruption from a crashed write). Safe path is to clean up and proceed.
      holder = null;
    }
    if (holder && !isHolderDead(holder.pid)) {
      // Lock is alive — refuse to proceed.
      throw new ToolError(
        "WALLET_LOCKED",
        `Another tradekit process (pid ${holder.pid}, ${purpose === holder.purpose ? "same operation" : `running '${holder.purpose}'`}) holds the ${name} lock since ${holder.acquiredAt}. Wait for it to finish or kill the holder if it's stuck.`,
        {
          details: {
            lockName: name,
            holderPid: holder.pid,
            holderPurpose: holder.purpose,
            holderAcquiredAt: holder.acquiredAt,
            reason: "lock_held",
          },
        },
      );
    }
    // Stale: remove and continue.
    try {
      unlinkSync(path);
    } catch {
      // Race: someone else cleaned it up between our checks. That's fine.
    }
  }

  // Atomic-create the lock file.
  const holder: LockHolder = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    purpose,
  };
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    // Race: another process beat us to creating the lock between our existsSync
    // check and openSync. Surface as WALLET_LOCKED — same semantic.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new ToolError(
        "WALLET_LOCKED",
        `Another tradekit process acquired the ${name} lock concurrently with this one. Retry in a moment.`,
        { details: { lockName: name, reason: "lock_race" } },
      );
    }
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }

  return {
    holder,
    release: () => {
      try {
        unlinkSync(path);
      } catch {
        // Already gone — operator manually cleared, or doctor stale-cleaned, etc.
        // Nothing actionable; just don't crash on release.
      }
    },
  };
}

/**
 * Iter611: convenience wrapper — run an async operation under a lock. Always
 * releases (even on throw). Most callers should use this rather than the raw
 * acquire/release pair.
 */
export async function withLock<T>(
  dataDir: string,
  name: string,
  purpose: string,
  op: () => Promise<T> | T,
): Promise<T> {
  const lock = acquireLock(dataDir, name, purpose);
  try {
    return await op();
  } finally {
    lock.release();
  }
}

/**
 * Iter611: doctor-side probe. Inspects every .lock.* file in the data dir.
 * Returns the list with each marked as held / stale.
 */
export interface LockProbeEntry {
  name: string;
  path: string;
  holder: LockHolder | null;
  status: "held" | "stale" | "corrupt";
}

export function probeLocks(dataDir: string): LockProbeEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return [];
  }
  const out: LockProbeEntry[] = [];
  for (const file of entries) {
    if (!file.startsWith(".lock.")) continue;
    const name = file.slice(".lock.".length);
    const path = join(dataDir, file);
    let holder: LockHolder | null = null;
    let status: LockProbeEntry["status"];
    try {
      holder = JSON.parse(readFileSync(path, "utf-8")) as LockHolder;
      status = isHolderDead(holder.pid) ? "stale" : "held";
    } catch {
      status = "corrupt";
    }
    out.push({ name, path, holder, status });
  }
  return out;
}
