// File-write helpers for files containing key material or per-user secrets.
//
// Default writeFileSync produces 0644 (-rw-r--r--) files on POSIX — readable by any
// local user. For an encrypted keystore this still enables offline brute-force if the
// password is weak; for the mnemonic keystore the same risk applies; for config files
// it leaks API keys to other users on shared hosts.
//
// writeFileSecure writes with mode 0o600 AND chmods explicitly after — the {mode}
// option only takes effect on file CREATE, so an existing 0644 file from an older
// install would otherwise remain world-readable forever.

import { writeFileSync, chmodSync, mkdirSync, existsSync, renameSync, unlinkSync } from "fs";
import { dirname, basename, join } from "path";
import { ToolError } from "./errors.js";

/**
 * Iter386/388: shared mkdir-with-friendly-error for the tradekit data directory.
 * Pre-iter386 a bad TRADEKIT_DATA_DIR override (typo, deleted dir, etc.) surfaced as
 * a bare `ENOENT: no such file or directory, mkdir '/some/bad/path'` — operators who
 * forgot they'd exported the env var didn't immediately connect the dot. This wrapper
 * names the env-var override in the error message when set. Called by logger / db /
 * wallet / config / accounts (every module that lazy-creates DATA_DIR on first write).
 *
 * Iter388: when TRADEKIT_DATA_DIR isn't set, the data dir falls back to $HOME/.tradekit.
 * A bad HOME (e.g., HOME=/dev/null in a stripped CI environment) produces the same
 * surprise — surface that case explicitly too.
 */
export function ensureDataDir(dataDir: string): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    const msg = (e as Error).message;
    let overrideNote = "";
    if (process.env.TRADEKIT_DATA_DIR) {
      overrideNote = ` TRADEKIT_DATA_DIR is set to "${process.env.TRADEKIT_DATA_DIR}" — unset it or point it at a writable path.`;
    } else if (process.env.HOME && dataDir.startsWith(process.env.HOME)) {
      overrideNote = ` HOME is "${process.env.HOME}" (the data dir falls back to $HOME/.tradekit when TRADEKIT_DATA_DIR is unset) — point HOME at a real home directory or set TRADEKIT_DATA_DIR explicitly.`;
    }
    throw new ToolError(
      "INTERNAL_ERROR",
      `Could not create data dir at ${dataDir}: ${msg}.${overrideNote}`,
      {
        details: {
          dataDir,
          tradekitDataDir: process.env.TRADEKIT_DATA_DIR ?? null,
          home: process.env.HOME ?? null,
        },
      },
    );
  }
}

export function writeFileSecure(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Iter341: write to a temp file and atomic-rename onto the final path. Pre-iter341
  // a direct writeFileSync left the file truncated if the process was killed mid-write
  // (SIGKILL, OOM, power loss) — the next tradekit run then hit a JSON-parse error on
  // config.json or accounts.json with no easy recovery (operator had to delete the
  // half-written file). POSIX rename(2) is atomic on the same filesystem AND preserves
  // the source's mode bits, so the 0o600 mode on the tmp survives the rename. We name
  // the tmp with a unique pid+counter suffix so two concurrent writers can't collide
  // (last-writer-wins is unchanged — the goal here is "no half-written state visible",
  // not cross-process serialization).
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${tmpCounter++}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows: NTFS ACLs don't map cleanly to POSIX mode bits. The {mode: 0o600} hint
      // above already covers the create case on platforms that honor it; nothing useful
      // to do here on Windows beyond best-effort.
    }
    renameSync(tmp, path);
  } catch (e) {
    // Clean up the tmp if the rename failed (disk full, cross-device, EBUSY on Windows).
    try { unlinkSync(tmp); } catch { /* tmp may not exist — best-effort */ }
    throw e;
  }

  // Promote the parent directory to 0700 if it's group/world-accessible. Legacy
  // installs (created before iter128's mkdir mode hint) keep the OS-default 0755 —
  // files inside are still owner-only via writeFileSecure, but a permissive parent
  // dir lets other local users `ls` filenames. iter206 added a doctor warning;
  // iter207 actively fixes it on the next secure write so existing installs get
  // tightened automatically without operator action.
  chmodSecureDirIfLoose(dir);
}

let tmpCounter = 0;

/**
 * Promote an existing file to 0600 if it isn't already. Called once at module-load by
 * the wallet/mnemonic/accounts modules so that even *read-only* operations (which
 * don't trigger a write) eventually tighten perms on legacy installs.
 *
 * Idempotent and silent — never throws on chmod failure (Windows, weird filesystems).
 */
export function chmodSecureIfExists(path: string): void {
  if (!existsSync(path)) return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // see writeFileSecure comment
  }
}

/**
 * Tighten a directory to 0700 if it's currently group/world-accessible. Idempotent;
 * silent on failure. Used by writeFileSecure to retroactively fix legacy data-dir
 * modes — see iter206/207 comments.
 */
export function chmodSecureDirIfLoose(path: string): void {
  if (!existsSync(path)) return;
  try {
    // statSync would tell us the current mode; chmod is idempotent so we don't need
    // to read first. Use the require side-loaded statSync via dynamic so the unused
    // import doesn't drift. Actually: just chmod unconditionally — 0700 is correct
    // for any directory used exclusively by tradekit.
    chmodSync(path, 0o700);
  } catch {
    // see writeFileSecure comment
  }
}
