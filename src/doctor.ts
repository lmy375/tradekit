import { existsSync, accessSync, statSync, constants as fsConstants } from "fs";
import { createPublicClient, http } from "viem";
import { CONFIG_PATH, DATA_DIR, WALLET_PATH, MNEMONIC_PATH, ACCOUNTS_PATH, DB_PATH, SERVER_LOG_PATH } from "./constants.js";
import { loadConfig, resolveProfile } from "./config.js";
import { listChains } from "./chains.js";
import { openDb } from "./db.js";
import { anyWalletExists } from "./accounts.js";
import { activeWalletAddress, activeWalletLabel } from "./wallet.js";
import { fetchWithTimeout } from "./http.js";
import { compactMessage } from "./format.js";
import { probeMevRpc, resolveMevSubmit } from "./mev.js";
import type { Logger } from "./logger.js";
import type { Config } from "./config.js";

export type CheckSeverity = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  severity: CheckSeverity;
  message: string;
  /** Optional remediation hint shown to the user. */
  hint?: string;
  /** Optional structured detail rows printed indented under the summary line. */
  details?: { label: string; ok: boolean; latencyMs?: number; note?: string }[];
}

const TIMEOUT_MS = 5000;

// ── individual checks ────────────────────────────────────────

async function checkNodeVersion(): Promise<CheckResult> {
  const [maj] = process.versions.node.split(".").map((s) => parseInt(s, 10));
  if (maj < 22) {
    return {
      name: "node version",
      severity: "fail",
      message: `Node ${process.versions.node} (need ≥ 22.5)`,
      hint: "tradekit uses the built-in node:sqlite module which was added in Node 22.5.0.",
    };
  }
  return { name: "node version", severity: "ok", message: process.versions.node };
}

async function checkDataDir(): Promise<CheckResult> {
  if (!existsSync(DATA_DIR)) {
    return {
      name: "data dir",
      severity: "warn",
      message: `${DATA_DIR} not found`,
      hint: "Run any tradekit command and the directory will be created on demand.",
    };
  }
  try {
    accessSync(DATA_DIR, fsConstants.W_OK);
  } catch {
    return { name: "data dir", severity: "fail", message: `${DATA_DIR} not writable` };
  }
  // Defense in depth (POSIX only): warn when the directory is group/world-accessible.
  // Files inside are 0600 (iter128/129) so contents can't be read, but a permissive
  // dir lets other local users see WHAT files exist (wallet.json, mnemonic.json) —
  // useful reconnaissance for an attacker. Legacy installs predating iter128's mode
  // hint won't have been tightened automatically.
  if (process.platform !== "win32") {
    try {
      const mode = statSync(DATA_DIR).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        return {
          name: "data dir",
          severity: "warn",
          message: `${DATA_DIR} (mode ${mode.toString(8)})`,
          hint: `Tighten to owner-only: \`chmod 700 ${DATA_DIR}\` — files inside are already 0600 but the dir lets other local users see filenames.`,
        };
      }
    } catch {
      // stat failure is non-critical; W_OK already succeeded above.
    }
  }
  return { name: "data dir", severity: "ok", message: DATA_DIR };
}

/**
 * Iter354+iter359: surface stale `.<name>.<pid>.<counter>.tmp` files left behind by
 * a previous tradekit that crashed between writeFileSync and renameSync (iter341's
 * atomic-write path). These are hidden dotfiles operators don't see in normal ls;
 * they accumulate silently and clutter the dir.
 *
 * Iter359 split this out of checkDataDir so it surfaces ALONGSIDE the loose-perm
 * warning iter354 acknowledged could hide it. Now operators see both at once and
 * can address them independently.
 *
 * Only warn for files older than 5 minutes — anything younger could be an in-flight
 * write from a concurrent process. Files match the iter341 pattern: dot-prefixed,
 * ".tmp" suffix.
 */
async function checkStaleTmps(): Promise<CheckResult> {
  if (!existsSync(DATA_DIR)) {
    return { name: "tmp files", severity: "ok", message: "no data dir yet" };
  }
  try {
    const { readdirSync } = await import("fs");
    const entries = readdirSync(DATA_DIR);
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const stale: string[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(".") || !entry.endsWith(".tmp")) continue;
      try {
        const st = statSync(`${DATA_DIR}/${entry}`);
        if (st.mtimeMs < fiveMinAgo) stale.push(entry);
      } catch { /* skip unreadable entries */ }
    }
    if (stale.length > 0) {
      return {
        name: "tmp files",
        severity: "warn",
        message: `${stale.length} stale tmp file${stale.length === 1 ? "" : "s"} in ${DATA_DIR}`,
        // Iter440: was "Atomic-write (iter341) prevents new ones" — internal iter
        // number is jargon to operators. Drop the label; the behavior is what matters.
        hint: `Orphan tmp files from a previous crashed write: ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? "..." : ""}. Safe to delete: \`rm ${DATA_DIR}/.*.tmp\`. Atomic temp-rename writes prevent new ones — these are legacy from before that change.`,
      };
    }
    return { name: "tmp files", severity: "ok", message: "no stale tmp files" };
  } catch {
    // readdir failure is non-critical; data-dir's own check already covers writability.
    return { name: "tmp files", severity: "ok", message: "(skipped — could not list)" };
  }
}

/**
 * Iter611: probe process-lock files in the data dir. Distinguishes alive
 * holders (lock is currently held — informational) from stale holders (the
 * recorded pid is dead — operator can safely remove). A stale lock blocks
 * future wallet mutations until cleaned up.
 */
async function checkStaleLocks(): Promise<CheckResult> {
  if (!existsSync(DATA_DIR)) {
    return { name: "process locks", severity: "ok", message: "no data dir yet" };
  }
  try {
    const { probeLocks } = await import("./processLock.js");
    const entries = probeLocks(DATA_DIR);
    if (entries.length === 0) {
      return { name: "process locks", severity: "ok", message: "no active locks" };
    }
    const stale = entries.filter((e) => e.status === "stale" || e.status === "corrupt");
    if (stale.length > 0) {
      const summary = stale
        .map((s) =>
          s.status === "stale" && s.holder
            ? `${s.name} (pid ${s.holder.pid} from ${s.holder.acquiredAt} — DEAD)`
            : `${s.name} (corrupt)`,
        )
        .join("; ");
      return {
        name: "process locks",
        severity: "warn",
        message: `${stale.length} stale lock${stale.length === 1 ? "" : "s"}: ${summary}`,
        hint: `A previous tradekit process crashed mid-operation and left these locks. New wallet mutations will block. Safe to delete: \`rm ${DATA_DIR}/.lock.*\``,
      };
    }
    // All entries alive — informational, not a warning.
    const held = entries
      .map((e) =>
        e.holder
          ? `${e.name} (pid ${e.holder.pid}, '${e.holder.purpose}')`
          : `${e.name} (?)`,
      )
      .join("; ");
    return {
      name: "process locks",
      severity: "ok",
      message: `${entries.length} active lock${entries.length === 1 ? "" : "s"}: ${held}`,
    };
  } catch {
    return { name: "process locks", severity: "ok", message: "(skipped — could not list)" };
  }
}

async function checkConfig(): Promise<CheckResult> {
  try {
    const cfg = loadConfig();
    // Empty chain-override shells (e.g. {chains: {base: {tokens: {}}}}) are leftover from
    // partially-cleaned-up token add/remove cycles. They take precedence in resolveProfile's
    // override-detection path — but with all fields effectively absent, they're no-ops
    // that just clutter the config. Flag for cleanup. An override is "empty" if every
    // present value is itself empty (undefined / [] / {}).
    const isEmptyValue = (v: unknown): boolean => {
      if (v === undefined || v === null) return true;
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
      return false;
    };
    const emptyOverrides = Object.entries(cfg.chains).filter(([, ov]) => {
      const v = ov as Record<string, unknown>;
      return Object.values(v).every(isEmptyValue);
    });
    // Iter316: detect "partial custom chain" — entries with SOME fields set but
    // missing required ones (chainId / rpcs / weth / usdc). Pre-iter316 doctor only
    // flagged fully-empty shells; a half-configured custom chain (e.g. operator typed
    // chainId + rpcs but forgot weth/usdc, then walked away) passed doctor but
    // exploded at first use with iter315's required-field error. Catch it here.
    const builtinNames = new Set(listChains());
    const partialChains: string[] = [];
    for (const [name, ov] of Object.entries(cfg.chains)) {
      if (builtinNames.has(name.toLowerCase())) continue; // built-ins get fields from the registry
      if (Object.values(ov as Record<string, unknown>).every(isEmptyValue)) continue; // covered by emptyOverrides
      try {
        resolveProfile(name, cfg);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("missing required field")) partialChains.push(`${name} (${msg.replace(/^Custom chain ".*?" missing required field: /, "")})`);
      }
    }
    const overrideCount = Object.keys(cfg.chains).length;
    // Iter415: validate that `activeChain` itself resolves. Pre-iter415 doctor printed
    // "valid, active=bsae" even when activeChain was a typo — the failure surfaced
    // later as a cryptic UNKNOWN_CHAIN in checkRpc with no pointer back to the config
    // line that's broken. resolveProfile's error (iter343) already names the typo and
    // suggests the closest match; surface it directly so the operator fixes the right
    // thing first.
    try {
      resolveProfile(cfg.activeChain, cfg);
    } catch (e) {
      return {
        name: "config",
        severity: "fail",
        message: `activeChain "${cfg.activeChain}" does not resolve`,
        hint: compactMessage((e as Error).message, 200),
      };
    }
    if (partialChains.length > 0) {
      return {
        name: "config",
        severity: "warn",
        message: `valid (${overrideCount} chain override(s), active=${cfg.activeChain}) — ${partialChains.length} custom chain${partialChains.length === 1 ? " is" : "s are"} partially configured`,
        hint: `Incomplete: ${partialChains.join("; ")}. Trades / holdings / gas on these chains will fail until the required fields are set.`,
      };
    }
    if (emptyOverrides.length > 0) {
      return {
        name: "config",
        severity: "warn",
        message: `valid (${overrideCount} chain override(s), active=${cfg.activeChain}) — ${emptyOverrides.length} are empty shells`,
        hint: `Remove with: ${emptyOverrides.map(([c]) => `tradekit config set chains.${c}`).join(" ; ")}`,
      };
    }
    return {
      name: "config",
      severity: "ok",
      message: `valid (${overrideCount} chain override(s), active=${cfg.activeChain})`,
    };
  } catch (e) {
    return {
      name: "config",
      severity: "fail",
      message: `invalid: ${compactMessage((e as Error).message, 120)}`,
      hint: `Open ${CONFIG_PATH} and fix the schema errors, or rm it to reset to defaults.`,
    };
  }
}

async function checkSafety(): Promise<CheckResult> {
  try {
    const cfg = loadConfig();
    if (!cfg.safety.enabled) {
      return {
        name: "safety",
        severity: "warn",
        message: "safety.enabled = false — no per-tx limits, blacklists, or approval gates enforced",
        hint: "Set safety.enabled=true via `tradekit config set safety.enabled true` for production use.",
      };
    }

    // Identify missing-but-recommended hardening settings.
    const missing: string[] = [];
    if (cfg.safety.perTxUsdLimit == null) missing.push("perTxUsdLimit");
    if (cfg.safety.dailyUsdLimit == null) missing.push("dailyUsdLimit");
    if (cfg.safety.maxApprovalUsdLimit == null) missing.push("maxApprovalUsdLimit");

    const bits: string[] = [];
    if (cfg.safety.perTxUsdLimit != null) bits.push(`perTx=$${cfg.safety.perTxUsdLimit}`);
    if (cfg.safety.dailyUsdLimit != null) bits.push(`daily=$${cfg.safety.dailyUsdLimit}`);
    if (cfg.safety.maxApprovalUsdLimit != null) bits.push(`approve=$${cfg.safety.maxApprovalUsdLimit}`);
    bits.push(`slippage≤${cfg.safety.maxSlippageBps}bps`);
    bits.push(cfg.safety.allowInfiniteApprovals ? "∞-approvals=ALLOWED" : "∞-approvals=blocked");
    // Iter797: surface the newer iter620 gas budget + iter633 rate limit so
    // operators reading doctor see EVERY active guard, not just the iter606
    // originals. Only shown when configured (default-off settings stay quiet).
    if (cfg.safety.gas?.maxGasPctOfTrade != null) {
      bits.push(`gas≤${cfg.safety.gas.maxGasPctOfTrade}%`);
    }
    const gasCapEntries = Object.entries(cfg.safety.gas?.maxGasNativePerChain ?? {});
    if (gasCapEntries.length > 0) {
      // Compact: one entry inline, multi-entry summarized as "(N chains)".
      if (gasCapEntries.length === 1) {
        const [chain, cap] = gasCapEntries[0];
        bits.push(`gas≤${cap}${chain === "ethereum" ? "ETH" : ""} on ${chain}`);
      } else {
        bits.push(`gas-cap=${gasCapEntries.length}chains`);
      }
    }
    if (cfg.safety.minTradeIntervalMs != null && cfg.safety.minTradeIntervalMs > 0) {
      // Human-readable: < 60s as ms, otherwise as seconds.
      const ms = cfg.safety.minTradeIntervalMs;
      const display = ms < 60_000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
      bits.push(`min-interval=${display}`);
    }

    // Internal-consistency warnings — these are misconfigurations the operator likely
    // didn't intend. Each is a soft inconsistency, not a hard error, so we surface them
    // as a `warn` with a specific hint.
    const inconsistencies: string[] = [];
    if (
      cfg.safety.maxApprovalUsdLimit != null &&
      cfg.safety.perTxUsdLimit != null &&
      cfg.safety.maxApprovalUsdLimit < cfg.safety.perTxUsdLimit
    ) {
      inconsistencies.push(
        `maxApprovalUsdLimit ($${cfg.safety.maxApprovalUsdLimit}) < perTxUsdLimit ($${cfg.safety.perTxUsdLimit}); approves to swap routers will fail before the swap is blocked`,
      );
    }
    if (
      cfg.safety.dailyUsdLimit != null &&
      cfg.safety.perTxUsdLimit != null &&
      cfg.safety.dailyUsdLimit < cfg.safety.perTxUsdLimit
    ) {
      inconsistencies.push(
        `dailyUsdLimit ($${cfg.safety.dailyUsdLimit}) < perTxUsdLimit ($${cfg.safety.perTxUsdLimit}); a single trade can exceed the daily allowance`,
      );
    }
    if (cfg.safety.maxSlippageBps < cfg.defaultSlippageBps) {
      inconsistencies.push(
        `maxSlippageBps (${cfg.safety.maxSlippageBps}) < defaultSlippageBps (${cfg.defaultSlippageBps}); every trade will hit SLIPPAGE_TOO_HIGH unless you override slippage per call`,
      );
    }
    // Empty whitelist arrays are particularly insidious: enforceSafety only treats a
    // whitelist as "active" when size > 0, so {} or [] silently means "allow everything"
    // — but a user who set `safety.tokenWhitelist.base = []` almost certainly meant the
    // opposite ("block everything until I add some"). The actual block-everything case
    // is contractWhitelist with at least one entry that excludes all routers; harder to
    // detect statically. Flag the suspicious zero-entry case.
    for (const [chain, list] of Object.entries(cfg.safety.tokenWhitelist ?? {})) {
      if (Array.isArray(list) && list.length === 0) {
        inconsistencies.push(
          `safety.tokenWhitelist.${chain} is set to [] (empty) — currently a no-op, but a future "block everything until allow-listed" change would deny all trades on ${chain}. Either populate it or remove the key.`,
        );
      }
    }
    for (const [chain, list] of Object.entries(cfg.safety.contractWhitelist ?? {})) {
      if (Array.isArray(list) && list.length === 0) {
        inconsistencies.push(
          `safety.contractWhitelist.${chain} is set to [] (empty) — same caveat as tokenWhitelist. Remove the key or populate it.`,
        );
      }
    }
    // Iter414: catch typo'd chain keys in safety policy maps. enforcePreflightSafety
    // looks up by chain name (case-insensitive via chainLookup), so `safety.tokenWhitelist.bsae`
    // silently never applies on `base` trades — the whitelist exists in the config but
    // is a permanent no-op. Operator only finds out when an attack actually slips through.
    // Resolve known chains: built-in profiles + custom chains declared in cfg.chains.
    const knownChains = new Set<string>([
      ...listChains().map((c) => c.toLowerCase()),
      ...Object.keys(cfg.chains ?? {}).map((c) => c.toLowerCase()),
    ]);
    for (const policy of ["tokenWhitelist", "tokenBlacklist", "contractWhitelist"] as const) {
      for (const chain of Object.keys(cfg.safety[policy] ?? {})) {
        if (!knownChains.has(chain.toLowerCase())) {
          inconsistencies.push(
            `safety.${policy}.${chain} references an unknown chain — this policy never applies. Known: ${[...knownChains].join(", ")}.`,
          );
        }
      }
    }

    if (inconsistencies.length > 0) {
      return {
        name: "safety",
        severity: "warn",
        message: `${bits.join("  ")}  (${inconsistencies.length} inconsistenc${inconsistencies.length === 1 ? "y" : "ies"})`,
        hint: inconsistencies.join(" | "),
      };
    }

    if (missing.length === 3) {
      // None of the USD limits set — the slippage cap and infinite-approval gate are still
      // active, but the agent could still spend the entire wallet in one transaction.
      return {
        name: "safety",
        severity: "warn",
        message: `${bits.join("  ")}  (no USD limits set)`,
        hint: `Consider setting safety.perTxUsdLimit and safety.dailyUsdLimit to cap accidental large trades. Example: \`tradekit config set safety.perTxUsdLimit 100\`.`,
      };
    }
    if (missing.length > 0) {
      return {
        name: "safety",
        severity: "ok",
        message: `${bits.join("  ")}  (unset: ${missing.join(",")})`,
      };
    }
    return { name: "safety", severity: "ok", message: bits.join("  ") };
  } catch {
    return { name: "safety", severity: "warn", message: "could not load safety config" };
  }
}

async function checkWallet(opts: { walletPass?: string; logger: Logger }): Promise<CheckResult> {
  if (!anyWalletExists()) {
    return {
      name: "wallet",
      severity: "warn",
      message: "no wallet configured",
      // Iter864: prefer `tradekit init` over the two raw wallet commands.
      // init walks the operator through the hd-vs-keystore choice with
      // sensible defaults; pre-iter864 hint asked them to pick before they
      // knew the trade-offs. Mirrors the iter858 banner / iter859 init
      // closing message / iter862 needsInit:true field — all surfaces now
      // point at the same canonical first-run path.
      hint: "Run `tradekit init` for a guided setup (or `tradekit wallet create` / `tradekit account create-mnemonic` directly if you already know which wallet type you want).",
    };
  }
  const addr = activeWalletAddress();
  if (!addr) {
    // Iter324: upgraded to "fail" because every trade/transfer/approve path requires
    // the address. Pre-iter324 doctor said "warn" + no hint — operators saw a yellow
    // marker and thought the issue was non-blocking, then hit the same problem on
    // their first trade with a less-clear error.
    return {
      name: "wallet",
      severity: "fail",
      message: "keystore present but active wallet address unreadable",
      hint: "accounts.json may be corrupted, or the active label may not exist among derived accounts. Run `tradekit account list` to inspect; restore accounts.json from backup OR re-run `tradekit account import-mnemonic` with your seed to rebuild.",
    };
  }
  // Iter331: when BOTH a mnemonic AND a single-key keystore exist, surface both
  // — loadWallet prefers HD (so `kind` was previously labeled "HD mnemonic" with
  // no signal that an additional keystore was sitting unused on disk). Operators
  // who imported both at some point lose track; doctor should remind them.
  const hasHD = existsSync(MNEMONIC_PATH);
  const hasKeystore = existsSync(WALLET_PATH);
  const kind = hasHD && hasKeystore
    ? "HD mnemonic + single-key keystore (HD takes precedence)"
    : hasHD ? "HD mnemonic" : hasKeystore ? "single-key keystore" : "unknown";
  // Iter506: append the active account label when it's HD-derived. Pre-iter506 the
  // doctor wallet line was `HD mnemonic → 0xabc...` — the operator couldn't tell
  // WHICH HD account is active without running `account list` separately. Hides
  // when label === "keystore" because `kind` already says "single-key keystore",
  // so `(keystore)` would be redundant. activeWalletLabel uses the iter500 gate so
  // it matches what loadWallet actually picks.
  const label = activeWalletLabel();
  const labelSuffix = label !== "keystore" ? ` (${label})` : "";

  // Iter503: warn loudly on the orphan-accounts.json state (accounts.json present,
  // mnemonic.json missing). The iter499-502 fix made every tradekit surface fall
  // back to the keystore cleanly, but the operator might never realize the HD
  // accounts in accounts.json are no longer reachable (no mnemonic = no signing
  // keys). doctor is the right place to surface this — silent recovery hides the
  // data loss. Severity: warn (not fail) because the keystore IS usable, just
  // not the HD accounts the operator may have been counting on.
  if (existsSync(ACCOUNTS_PATH) && !hasHD) {
    return {
      name: "wallet",
      severity: "warn",
      message: `${kind} → ${addr}${labelSuffix} (orphaned accounts.json detected)`,
      hint: `accounts.json exists at ${ACCOUNTS_PATH} but mnemonic.json is missing — the HD accounts listed inside are no longer derivable (no seed = no signing keys). tradekit fell back to the single-key keystore for this run. To recover the HD accounts, restore mnemonic.json from backup OR re-import the seed via \`tradekit account import-mnemonic\`. If you intentionally removed the mnemonic, delete ${ACCOUNTS_PATH} to clear this warning.`,
    };
  }

  // Iter536: warn on the iter519-reservation-collision state — a pre-iter519 install
  // could have an HD account literally labeled "keystore" (the single-key wallet
  // identifier). iter519 blocks new ones, but existing collisions persist; they
  // confuse iter505's wallet-view text gate, iter500-502's audit attribution, and
  // every dual-wallet disambiguation. Surface so the operator can rename via
  // accounts.json edit (no built-in "account rename" tool).
  if (hasHD) {
    try {
      const { loadAccountsFile } = await import("./accounts.js");
      const file = loadAccountsFile();
      const collision = file?.accounts.find((a) => a.label.toLowerCase() === "keystore");
      if (collision) {
        return {
          name: "wallet",
          severity: "warn",
          message: `${kind} → ${addr}${labelSuffix} (HD account labeled "${collision.label}" collides with reserved "keystore")`,
          hint: `An HD account is labeled "${collision.label}", which collides with the reserved single-key wallet identifier. iter519 blocks NEW additions, but this account was created before that gate. To resolve, edit ${ACCOUNTS_PATH} and rename the account's label, then re-run doctor.`,
        };
      }
    } catch {
      // loadAccountsFile may throw on corrupt accounts.json — that's handled by the
      // activeWalletAddress check above (returns null, which we caught with the
      // "address unreadable" return earlier). Suppress here.
    }
  }

  // Optional decryption check: only attempts when a password is explicitly provided.
  // Without it, doctor stays a no-secrets health check. With it, we catch typo'd
  // WALLET_PASS / corrupted keystore at config time instead of at first trade.
  if (opts.walletPass) {
    try {
      const config = loadConfig();
      const profile = resolveProfile(config.activeChain, config);
      const extraRpcs = config.chains[config.activeChain]?.rpcs ?? [];
      const { loadWallet } = await import("./wallet.js");
      await loadWallet(opts.walletPass, profile, extraRpcs, opts.logger);
      return { name: "wallet", severity: "ok", message: `${kind} → ${addr}${labelSuffix} (password verified)` };
    } catch (e) {
      const msg = (e as Error).message;
      // WRONG_PASSWORD shape comes from wallet.ts via ToolError; keep the code visible.
      const code = (e as { code?: string }).code ?? "";
      return {
        name: "wallet",
        severity: "fail",
        message: `${kind} → ${addr}${labelSuffix} (decrypt failed${code ? `: ${code}` : ""})`,
        // Iter437: was 120-char slice. Iter435's wrongPasswordError emits a longer
        // message that names the WALLET_PASS env-var pitfall AND tells the operator
        // how to recover — clipping at 120 cut off "Try `unset WALLET_PASS` and re-run
        // with --pass, or update the env var." right where the actionable advice
        // begins. 240 fits the longest iter435 form with room to spare; other ToolError
        // messages that land here (rare) are well under that.
        hint: msg.slice(0, 240),
      };
    }
  }
  return { name: "wallet", severity: "ok", message: `${kind} → ${addr}${labelSuffix}` };
}

async function checkDb(): Promise<CheckResult> {
  try {
    const db = openDb();
    const tradesCount = (db.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n;
    const auditCount = (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    // Oldest audit timestamp helps operators decide WHEN to prune (--before <date>).
    // Without it the "100K rows" warning gave no hint about which date threshold makes sense.
    const oldestRow = db
      .prepare("SELECT timestamp FROM audit_log ORDER BY timestamp ASC LIMIT 1")
      .get() as { timestamp: string } | undefined;
    const oldestDate = oldestRow ? oldestRow.timestamp.slice(0, 10) : null;
    // File size — informational, also feeds the warn threshold.
    let sizeBytes = 0;
    try {
      const { statSync } = await import("fs");
      sizeBytes = statSync(DB_PATH).size;
    } catch {
      /* ignore */
    }
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
    const auditSuffix = oldestDate ? ` since ${oldestDate}` : "";

    // Warn at thresholds that start to affect query latency / disk on a typical laptop.
    if (auditCount > 100_000 || sizeBytes > 50 * 1024 * 1024) {
      // Iter250 had used a literal "90 days ago" date computed at doctor-run time so
      // the hint worked on both macOS and Linux (vs an earlier `$(date -v-90d ...)`
      // that broke on Linux). Iter367 swaps to the iter356 relative-duration shortcut
      // `--before 90d` — same intent ("trim entries older than 90 days"), but the
      // operator can copy-paste the command verbatim weeks later and it still does the
      // right thing relative to NOW. The literal date drifted with each doctor invocation;
      // the relative form is durable.
      return {
        name: "sqlite",
        severity: "warn",
        message: `${DB_PATH} (trades=${tradesCount}, audit=${auditCount}${auditSuffix}, ${sizeMb}MB) — audit table is large`,
        hint: `Run \`tradekit audit prune --before 90d\` (or any older Nd shortcut, e.g. 30d / 180d / 365d) to trim entries.`,
      };
    }
    // Iter782: ok severity but emit a gentle hint when audit history spans
    // >180d AND has accumulated rows (>10k). This is the "small but old"
    // case the size threshold misses — operators with light usage over a
    // long time. Severity stays ok (not a problem); hint nudges toward
    // compliance-friendly pruning without forcing action.
    let hintBit: string | undefined;
    if (oldestRow && auditCount > 10_000) {
      const ageMs = Date.now() - new Date(oldestRow.timestamp).getTime();
      const ageDays = Math.floor(ageMs / 86_400_000);
      if (ageDays > 180) {
        hintBit = `Audit history spans ${ageDays} days. Consider \`tradekit audit prune --before 180d\` for compliance hygiene.`;
      }
    }
    return {
      name: "sqlite",
      severity: "ok",
      message: `${DB_PATH} (trades=${tradesCount}, audit=${auditCount}${auditSuffix}, ${sizeMb}MB)`,
      ...(hintBit ? { hint: hintBit } : {}),
    };
  } catch (e) {
    // Most catchable failure mode here is a corrupted SQLite file (interrupted write,
    // disk full mid-WAL-checkpoint, manual edit). Without a hint operators see a raw
    // node:sqlite error message and don't know that the recovery is to back up the file
    // and let tradekit recreate it.
    return {
      name: "sqlite",
      severity: "fail",
      message: compactMessage((e as Error).message, 120),
      hint: `If the DB is unrecoverable: \`mv ${DB_PATH} ${DB_PATH}.broken\` to back it up, then re-run any tradekit command — a fresh schema will be created. Trade history will be lost; PnL will reset.`,
    };
  }
}

async function checkServerLog(): Promise<CheckResult> {
  if (!existsSync(SERVER_LOG_PATH)) {
    return { name: "server log", severity: "ok", message: "(not created yet)" };
  }
  try {
    const size = statSync(SERVER_LOG_PATH).size;
    const mb = (size / (1024 * 1024)).toFixed(1);
    // The logger auto-rotates above 50MB on startup. A live log >100MB means either
    // the threshold was overridden or the process has been running long enough to
    // accumulate that much without restart — both worth surfacing.
    if (size > 100 * 1024 * 1024) {
      return {
        name: "server log",
        severity: "warn",
        message: `${mb}MB at ${SERVER_LOG_PATH}`,
        hint: `Restart the server to rotate, or set TRADEKIT_LOG_ROTATE_BYTES lower. Old log is preserved at server.log.1`,
      };
    }
    return { name: "server log", severity: "ok", message: `${mb}MB` };
  } catch (e) {
    return { name: "server log", severity: "warn", message: (e as Error).message };
  }
}

// Iter740: stale sync-bookmark check. Pre-iter740 a cron operator whose
// nightly `tradekit trades sync` cron quietly stopped (mistyped systemd
// unit, container OOM-killed, scheduler paused) had no signal — the local
// trades DB silently froze in time. Doctor surfaces this by reading
// iter737 listSyncBookmarks and flagging any bookmark older than the
// threshold. >7d = warn (cron probably broken). 2-7d = ok with note
// (operator should investigate but might be intentional). 0 bookmarks =
// ok with "no bookmarks tracked" (perfectly fine — operator hasn't
// adopted iter737 resume yet).
export async function checkSyncBookmarks(): Promise<CheckResult> {
  try {
    const { listSyncBookmarks } = await import("./db.js");
    const bookmarks = listSyncBookmarks();
    if (bookmarks.length === 0) {
      return {
        name: "sync bookmarks",
        severity: "ok",
        message: "none tracked (run `tradekit trades sync` to start)",
      };
    }
    const now = Date.now();
    // Surface the OLDEST bookmark — that's the one most likely to indicate
    // a stopped cron. Operator with N healthy bookmarks + 1 broken doesn't
    // get a false-positive from the average.
    let oldestAgeMs = 0;
    let oldestRef = "";
    for (const b of bookmarks) {
      const age = now - new Date(b.updatedAt).getTime();
      if (age > oldestAgeMs) {
        oldestAgeMs = age;
        oldestRef = `${b.chain}/${b.account}`;
      }
    }
    const oldestDays = oldestAgeMs / 86_400_000;
    const ageStr = oldestDays >= 1
      ? `${oldestDays.toFixed(1)}d`
      : `${Math.round(oldestAgeMs / 3_600_000)}h`;
    if (oldestDays > 7) {
      return {
        name: "sync bookmarks",
        severity: "warn",
        message: `${bookmarks.length} tracked, oldest ${oldestRef} updated ${ageStr} ago`,
        hint: `A bookmark older than 7 days usually means the sync cron stopped. Verify the scheduler is still running \`tradekit trades sync\` for this account, or clear the bookmark with --reset-bookmark if the account is deliberately archived.`,
      };
    }
    return {
      name: "sync bookmarks",
      severity: "ok",
      message: `${bookmarks.length} tracked, oldest ${ageStr} ago`,
    };
  } catch (e) {
    return { name: "sync bookmarks", severity: "warn", message: (e as Error).message };
  }
}

async function checkPendingTrades(): Promise<CheckResult> {
  try {
    const db = openDb();
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM trades WHERE status = 'pending'")
      .get() as { n: number };
    const n = row.n;
    // A few pending rows are normal (transient receipt timeouts). Many pending rows
    // suggests systemic RPC reliability problems — or, more often, txs that have since
    // confirmed but the operator never ran `tradekit reconcile` to update their status.
    if (n > 20) {
      return {
        name: "pending trades",
        severity: "warn",
        message: `${n} trades stuck in 'pending' state`,
        hint: `Each pending row still counts toward the daily USD budget. Run \`tradekit reconcile\` to query the chain and update statuses; if many stay pending, check RPC health.`,
      };
    }
    if (n > 0) {
      return { name: "pending trades", severity: "ok", message: `${n} pending` };
    }
    return { name: "pending trades", severity: "ok", message: "none" };
  } catch (e) {
    return { name: "pending trades", severity: "warn", message: (e as Error).message };
  }
}

async function checkRpc(chainName: string, logger: Logger): Promise<CheckResult> {
  const config = loadConfig();
  try {
    const profile = resolveProfile(chainName, config);
    const overrides = config.chains[chainName]?.rpcs ?? [];
    const candidates = [...overrides, ...profile.rpcs];
    // Probe every RPC in parallel. Sequentially this was up to (TIMEOUT_MS × N) on a
    // chain with 4 dead endpoints; now it's capped at one TIMEOUT_MS per chain.
    const results = await Promise.all(
      candidates.map(async (url) => {
        const start = Date.now();
        try {
          const client = createPublicClient({ chain: profile.viemChain, transport: http(url, { timeout: TIMEOUT_MS, retryCount: 0 }) });
          // Iter428: probe block + chainId in parallel and verify the RPC actually
          // serves the configured chain. A misconfigured RPC URL (e.g., an arbitrum
          // URL pasted into chains.base.rpcs by mistake) would otherwise pass with
          // a healthy block number — and the next trade would land on arbitrum
          // with base's signature, almost certainly reverting on different token
          // addresses. Catching this at doctor time avoids that catastrophe.
          const [block, chainId] = await Promise.all([client.getBlockNumber(), client.getChainId()]);
          const latency = Date.now() - start;
          if (chainId !== profile.chainId) {
            return {
              url,
              ok: false as const,
              // Keep terse — compactMessage truncates at 60 chars in the per-endpoint
              // detail row (doctor text mode). Fits comfortably under that cap.
              error: `wrong chainId: RPC=${chainId}, expected=${profile.chainId}`,
            };
          }
          logger.debug(`rpc ${url} ok block=${block} chainId=${chainId} ${latency}ms`);
          return { url, ok: true as const, latencyMs: latency };
        } catch (e) {
          return { url, ok: false as const, error: compactMessage((e as Error).message, 60) };
        }
      }),
    );
    const okCount = results.filter((r) => r.ok).length;
    // Build details array shared by all return paths (so operators can always see which
    // endpoint is slow / dead, not just the aggregate).
    const details = results.map((r) => ({
      label: new URL(r.url).host,
      ok: r.ok,
      latencyMs: r.latencyMs,
      note: r.error,
    }));

    if (okCount === 0) {
      // Iter430: when EVERY endpoint failed because it reported the wrong chainId
      // (iter428's check), the generic "Add a working RPC" hint sends the operator
      // down the wrong debugging path — the endpoints ARE reachable, they're just
      // wired to the wrong chain. Detect that case and route the hint accordingly.
      const allWrongChain = results.every((r) => !r.ok && /wrong chainId/.test(r.error ?? ""));
      const hint = allWrongChain
        ? `Every configured RPC for "${chainName}" serves a different chainId. Verify the URLs in \`tradekit config get chains.${chainName}.rpcs\` actually point to ${chainName} (chainId ${profile.chainId}) — a common mistake is pasting an RPC URL from another L2's docs.`
        : "Add a working RPC via `tradekit config set chains." + chainName + ".rpcs '[\"https://your-rpc\"]'`.";
      return {
        name: `rpc:${chainName}`,
        severity: "fail",
        message: `0/${candidates.length} RPC endpoints reachable`,
        hint,
        details,
      };
    }
    if (okCount < candidates.length) {
      const failed = results.filter((r) => !r.ok).map((r) => new URL(r.url).host).join(",");
      return {
        name: `rpc:${chainName}`,
        severity: "warn",
        message: `${okCount}/${candidates.length} reachable (down: ${failed})`,
        details,
      };
    }
    const best = Math.min(...results.map((r) => r.latencyMs ?? Infinity));
    // Even if every endpoint responds within TIMEOUT_MS, a slow best-case latency
    // hurts trading directly — quote-build and submit each pay this cost, and slippage
    // exposure grows with the round-trip. Warn at >1500ms (twice typical L2 RTT,
    // generous for mainnet) so operators get a signal to add a closer RPC before they
    // hit a real failure.
    if (best > 1500) {
      return {
        name: `rpc:${chainName}`,
        severity: "warn",
        message: `${okCount}/${candidates.length} reachable, but fastest is ${best}ms — slow`,
        hint: "Consider adding a closer / faster RPC via `tradekit config set chains." + chainName + ".rpcs '[\"https://your-rpc\"]'`. Trade latency directly affects slippage.",
        details,
      };
    }
    return {
      name: `rpc:${chainName}`,
      severity: "ok",
      message: `${okCount}/${candidates.length} reachable, fastest ${best}ms`,
      details,
    };
  } catch (e) {
    return { name: `rpc:${chainName}`, severity: "fail", message: (e as Error).message };
  }
}

/**
 * Probe each MEV-protected submission RPC configured for the chains
 * being checked. Skipped entirely when MEV isn't enabled.
 *
 * Returns one CheckResult per chain that has a privateRpc entry:
 *   - ok: reachable + reports the chain's expected chainId
 *   - warn: reachable but slow (>1500ms; mirrors the aggregator threshold —
 *     slow private relay means slow trade submission)
 *   - fail: not reachable / wrong chainId / RPC error
 *
 * Naming convention: `mev:<chain> (<Label>)` so doctor's row renderer
 * surfaces the operator-facing label inline. Helps an operator scanning
 * a multi-chain doctor output spot which relay is which.
 */
async function checkMevRelays(config: Config, chains: string[]): Promise<CheckResult[]> {
  if (!config.mev?.enabled) return [];
  const out: CheckResult[] = [];
  // Probe each chain in parallel. We don't probe chains that have no
  // privateRpc — they fall through to public submission, no check needed.
  const probes = chains
    .map((chainName) => {
      const resolved = resolveMevSubmit(config.mev, chainName);
      if (!resolved.active || !resolved.privateUrl) return null;
      let profile: ReturnType<typeof resolveProfile>;
      try {
        profile = resolveProfile(chainName, config);
      } catch {
        // Unknown chain in config.mev.privateRpcs — surface but skip.
        return Promise.resolve<CheckResult>({
          name: `mev:${chainName}`,
          severity: "warn",
          message: `unknown chain in mev.privateRpcs — entry ignored`,
        });
      }
      const label = resolved.label ?? "private relay";
      return probeMevRpc(resolved.privateUrl, profile.chainId, TIMEOUT_MS).then((r): CheckResult => {
        const head = `mev:${chainName} (${label})`;
        if (!r.reachable) {
          return {
            name: head,
            severity: "fail",
            message: r.error ?? "unreachable",
            hint:
              "If the relay is intentionally offline, set mev.fallbackToPublic=true to degrade-gracefully to public RPCs, or temporarily mev.enabled=false to disable MEV protection on all chains.",
          };
        }
        if (r.elapsedMs > 1500) {
          return {
            name: head,
            severity: "warn",
            message: `reachable but slow (${r.elapsedMs}ms)`,
            hint: "Slow relay = slow trade submission. Consider an alternative private RPC for this chain.",
          };
        }
        return { name: head, severity: "ok", message: `reachable in ${r.elapsedMs}ms` };
      });
    })
    .filter((p): p is Promise<CheckResult> => p !== null);
  const settled = await Promise.all(probes);
  out.push(...settled);
  return out;
}

async function checkAggregator(name: string, probe: () => Promise<boolean>): Promise<CheckResult> {
  try {
    const start = Date.now();
    const ok = await probe();
    const latency = Date.now() - start;
    if (!ok) return { name: `agg:${name}`, severity: "warn", message: "reachable but returned non-success" };
    // Mirror checkRpc (iter154): warn on >1500ms quote-build latency since that delay
    // sits between quote and submit, growing slippage exposure. Same threshold —
    // aggregator quote endpoints typically respond in 200-600ms when healthy.
    if (latency > 1500) {
      return {
        name: `agg:${name}`,
        severity: "warn",
        message: `reachable but slow (${latency}ms)`,
        hint: "Check aggregator status, or move this provider lower in config.aggregator.preferred.",
      };
    }
    return { name: `agg:${name}`, severity: "ok", message: `reachable in ${latency}ms` };
  } catch (e) {
    return { name: `agg:${name}`, severity: "warn", message: compactMessage((e as Error).message, 60) };
  }
}

/**
 * Iter660: surface the state of recognized environment variables.
 *
 * Tradekit's env surface keeps growing (TRADEKIT_DATA_DIR, _WEB_TOKEN, _HTTP_TIMEOUT_MS,
 * _RECEIPT_TIMEOUT_MS, _LOG_ROTATE_BYTES, _STRATEGY plus WALLET_PASS). Each adds an
 * invisible default that, if left stale in a shell profile, silently shapes every
 * subsequent run. Operators have no way to ask "what's in effect right now?" without
 * grepping their dotfiles. Doctor reports it.
 *
 * Sensitivity: WALLET_PASS and TRADEKIT_WEB_TOKEN values are NEVER printed — only
 * "(set)" / "(unset)". The wallet password is the master key; the web token would
 * let anyone reach the local server. Both leak via shoulder-surf if shown.
 *
 * Severity is "ok": this is informational. We do flag WALLET_PASS=set with a hint
 * since it materially changes wallet UX (skips the prompt — operators forgetting
 * they set it can be surprised by trades that don't ask for a password).
 */
// ── ops-hygiene pack (v30) ───────────────────────────────────
//
// The automation arc added journals (order/schedule/rebalance check
// logs, alert_events), the paper book, the alert watcher, and the
// engine supervisor — each with config knobs an operator can leave
// half-wired. These checks catch the four production footguns:
// unbounded journal growth, paper primitives with an empty book,
// automation running unwatched, and primitives configured while the
// engine never runs. All offline (DB + config + status file).

/** Growing tables vs their retention knobs. Unbounded growth is only
 *  a problem once the table is actually large — warn at 50k rows
 *  with the knob unset; report counts otherwise. */
export async function checkRetentionHygiene(): Promise<CheckResult> {
  const WARN_ROWS = 50_000;
  try {
    const config = loadConfig();
    const db = openDb();
    const tables: Array<{ table: string; knob: string; days: number | null }> = [
      { table: "audit_log", knob: "auditLogDays", days: config.db.retention.auditLogDays },
      { table: "order_check_log", knob: "orderCheckLogDays", days: config.db.retention.orderCheckLogDays },
      { table: "schedule_check_log", knob: "scheduleCheckLogDays", days: config.db.retention.scheduleCheckLogDays },
      { table: "rebalance_check_log", knob: "rebalanceCheckLogDays", days: config.db.retention.rebalanceCheckLogDays },
      { table: "alert_events", knob: "alertEventsDays", days: config.db.retention.alertEventsDays },
      { table: "engine_events", knob: "engineEventsDays", days: config.db.retention.engineEventsDays },
      { table: "paper_trades", knob: "paperTradesDays", days: config.db.retention.paperTradesDays },
    ];
    const details: CheckResult["details"] = [];
    const offenders: string[] = [];
    let total = 0;
    for (const t of tables) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get() as { n: number }).n;
      total += n;
      const retained = config.db.retention.enabled && t.days != null;
      const unbounded = !retained && n >= WARN_ROWS;
      if (unbounded) offenders.push(`${t.table} (${n.toLocaleString()} rows)`);
      details.push({
        label: t.table,
        ok: !unbounded,
        note: `${n.toLocaleString()} rows · ${retained ? `${t.days}d retention` : "no retention"}`,
      });
    }
    if (offenders.length > 0) {
      return {
        name: "retention",
        severity: "warn",
        message: `${offenders.length} journal table(s) growing unbounded: ${offenders.join(", ")}`,
        hint: `set db.retention.enabled=true + the per-table *Days knobs (e.g. \`tradekit config set db.retention.auditLogDays 90\`), then \`tradekit db prune\``,
        details,
      };
    }
    return {
      name: "retention",
      severity: "ok",
      message: config.db.retention.enabled
        ? `${total.toLocaleString()} journal rows across ${tables.length} tables (retention on)`
        : `${total.toLocaleString()} journal rows (retention off — fine at this size)`,
      details,
    };
  } catch (e) {
    return { name: "retention", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** Active paper primitives whose (account, chain) book is EMPTY —
 *  every fire will fail with PAPER_INSUFFICIENT_BALANCE. */
export async function checkPaperReadiness(): Promise<CheckResult> {
  try {
    const { listOrders, listSchedules, listPaperBalances } = await import("./db.js");
    const { listRebalancePlans } = await import("./rebalance.js");
    const scopes = new Map<string, { orders: number; schedules: number; rebalances: number }>();
    const bump = (account: string, chain: string, kind: "orders" | "schedules" | "rebalances") => {
      const key = `${account}:${chain}`;
      const cur = scopes.get(key) ?? { orders: 0, schedules: 0, rebalances: 0 };
      cur[kind] += 1;
      scopes.set(key, cur);
    };
    for (const o of listOrders({ status: "active" })) if ((o.paper ?? 0) === 1) bump(o.account, o.chain, "orders");
    for (const sc of listSchedules({ status: "active" })) if ((sc.paper ?? 0) === 1) bump(sc.account, sc.chain, "schedules");
    for (const r of listRebalancePlans({ status: "active" })) if ((r.paper ?? 0) === 1) bump(r.account, r.chain, "rebalances");

    if (scopes.size === 0) {
      return { name: "paper book", severity: "ok", message: "no live paper primitives" };
    }
    const funded = new Set(
      listPaperBalances({})
        .filter((b) => parseFloat(b.balance) > 0)
        .map((b) => `${b.account}:${b.chain}`),
    );
    const details: CheckResult["details"] = [];
    const starved: string[] = [];
    for (const [key, counts] of scopes) {
      const has = funded.has(key);
      const live = counts.orders + counts.schedules + counts.rebalances;
      if (!has) starved.push(key);
      details.push({ label: key, ok: has, note: `${live} live paper primitive(s) · book ${has ? "funded" : "EMPTY"}` });
    }
    if (starved.length > 0) {
      return {
        name: "paper book",
        severity: "warn",
        message: `${starved.length} scope(s) with live paper primitives but an EMPTY virtual book: ${starved.join(", ")}`,
        hint: `every paper fire will fail with PAPER_INSUFFICIENT_BALANCE — seed with \`tradekit paper deposit --token USDC --amount 10000\``,
        details,
      };
    }
    return { name: "paper book", severity: "ok", message: `${scopes.size} scope(s) with live paper primitives, all funded`, details };
  } catch (e) {
    return { name: "paper book", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** Automation running unwatched: active primitives + alert watcher
 *  disabled. Also surfaces CURRENTLY-FIRING alerts — doctor --strict
 *  in CI/cron goes red while something is alerting. */
export async function checkAlertsCoverage(): Promise<CheckResult> {
  try {
    const config = loadConfig();
    const { listOrders, listSchedules, listStrategyAlertStates } = await import("./db.js");
    const { listRebalancePlans } = await import("./rebalance.js");
    const liveCount =
      listOrders({ status: "active" }).length +
      listSchedules({ status: "active" }).length +
      listRebalancePlans({ status: "active" }).length;
    const alertsCfg = (config.safety as { strategyAlerts?: { enabled?: boolean; rules?: unknown[] } }).strategyAlerts;
    const enabled = alertsCfg?.enabled === true && (alertsCfg.rules?.length ?? 0) > 0;

    const active = listStrategyAlertStates({ active: true });
    if (active.length > 0) {
      return {
        name: "alerts",
        severity: "warn",
        message: `${active.length} strategy alert(s) CURRENTLY FIRING: ${active.slice(0, 5).map((a) => `${a.tag}/${a.rule_type}`).join(", ")}${active.length > 5 ? ", …" : ""}`,
        hint: `inspect with \`tradekit strategy alerts list --active-only\`; history via \`tradekit strategy alerts history\``,
      };
    }
    if (liveCount > 0 && !enabled) {
      return {
        name: "alerts",
        severity: "warn",
        message: `${liveCount} live automation primitive(s) but the alert watcher is ${alertsCfg?.enabled === true ? "enabled with ZERO rules" : "disabled"}`,
        hint: `automation is running unwatched — enable safety.strategyAlerts with at least failure_streak + staleness rules (see README "Strategy alerts")`,
      };
    }
    return {
      name: "alerts",
      severity: "ok",
      message: enabled
        ? `watcher on (${alertsCfg!.rules!.length} rule${alertsCfg!.rules!.length === 1 ? "" : "s"}), nothing firing`
        : "no live primitives — watcher optional",
    };
  } catch (e) {
    return { name: "alerts", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** Primitives configured while the engine never runs — the classic
 *  silent footgun: orders created, engine down, nothing fires. */
export async function checkEngineLiveness(): Promise<CheckResult> {
  const STALE_SECONDS = 6 * 3600;
  try {
    const { listOrders, listSchedules } = await import("./db.js");
    const { listRebalancePlans } = await import("./rebalance.js");
    const { readEngineStatus } = await import("./engine.js");
    const liveCount =
      listOrders({ status: "active" }).length +
      listSchedules({ status: "active" }).length +
      listRebalancePlans({ status: "active" }).length;
    if (liveCount === 0) {
      return { name: "engine liveness", severity: "ok", message: "no live primitives — engine optional" };
    }
    const status = readEngineStatus();
    if (!status) {
      return {
        name: "engine liveness",
        severity: "warn",
        message: `${liveCount} live primitive(s) but the engine has NEVER run on this install`,
        hint: `nothing will fire until the engine ticks — start it with \`tradekit engine run\` (or a systemd/pm2 unit)`,
      };
    }
    const ageSec = Math.floor((Date.now() - Date.parse(status.updatedAt)) / 1000);
    if (status.stopping || ageSec > STALE_SECONDS) {
      return {
        name: "engine liveness",
        severity: "warn",
        message: `${liveCount} live primitive(s) but the engine status file is ${Math.floor(ageSec / 3600)}h stale (last update ${status.updatedAt})`,
        hint: `the engine looks down — check \`tradekit engine status\` and restart it`,
      };
    }
    return {
      name: "engine liveness",
      severity: "ok",
      message: `engine alive (pid ${status.pid}, last tick ${ageSec}s ago) · ${liveCount} live primitive(s)`,
    };
  } catch (e) {
    return { name: "engine liveness", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** v106: notification-delivery health. A channel that worked at setup but
 *  later died (rotated/revoked webhook) fails SILENTLY — the operator stops
 *  getting digests/alerts/approval-pages and doesn't know. This catches a
 *  channel with a consecutive-failure streak so the operator learns their
 *  alerts aren't landing the next time they run doctor (the pull-based path
 *  that survives even when the push path is the thing that's broken). */
export const NOTIFY_FAILURE_STREAK_WARN = 3;
export async function checkNotificationDelivery(): Promise<CheckResult> {
  try {
    const { listNotificationHealth } = await import("./db.js");
    const rows = listNotificationHealth();
    if (rows.length === 0) {
      return { name: "notification delivery", severity: "ok", message: "no delivery attempts recorded yet (no events fired, or no channels)" };
    }
    const failing = rows.filter((r) => r.consecutive_failures >= NOTIFY_FAILURE_STREAK_WARN);
    if (failing.length > 0) {
      const worst = [...failing].sort((a, b) => b.consecutive_failures - a.consecutive_failures)[0];
      return {
        name: "notification delivery",
        // fail: a dead alert channel means flying blind during incidents.
        severity: "fail",
        message:
          `${failing.length} notification channel(s) failing — "${worst.channel_name}" has ${worst.consecutive_failures} consecutive failures` +
          `${worst.last_success_at ? ` (last success ${worst.last_success_at})` : " (never delivered)"}${worst.last_error ? `: ${worst.last_error}` : ""}`,
        hint: "your alerts/digests may not be reaching you — verify the channel URL with `tradekit notify test`, then fix config.notifications.channels",
      };
    }
    const healthy = rows.filter((r) => r.last_success_at != null).length;
    return { name: "notification delivery", severity: "ok", message: `${healthy}/${rows.length} channel(s) delivering` };
  } catch (e) {
    return { name: "notification delivery", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** v38: a long-standing engine lock (especially one engaged by
 *  panic) means automation is FULLY stopped — easy to forget after
 *  the incident that caused it. */
export async function checkEngineLockStale(): Promise<CheckResult> {
  const STALE_HOURS = 24;
  try {
    const { getEngineLockState, isEngineLockedFromRow } = await import("./engineLock.js");
    const lock = getEngineLockState();
    if (!isEngineLockedFromRow(lock)) {
      return { name: "engine lock", severity: "ok", message: "engine not locked" };
    }
    const ageH = lock.locked_at ? (Date.now() - Date.parse(lock.locked_at)) / 3_600_000 : null;
    if (ageH != null && ageH > STALE_HOURS) {
      const byPanic = lock.locked_by === "panic";
      return {
        name: "engine lock",
        severity: "warn",
        message: `engine LOCKED for ${ageH.toFixed(0)}h (by ${lock.locked_by ?? "?"}${lock.reason ? `: ${lock.reason}` : ""}) — every fire path is stopped`,
        hint: byPanic
          ? "release with `tradekit panic release` (primitives stay paused for selective resume)"
          : "release with `tradekit engine unlock` if the incident is resolved",
      };
    }
    return {
      name: "engine lock",
      severity: "ok",
      message: `engine locked (recent — ${ageH == null ? "?" : ageH.toFixed(1)}h, by ${lock.locked_by ?? "?"})`,
    };
  } catch (e) {
    return { name: "engine lock", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** v38: the equity curve is only as alive as its feed. When the
 *  snapshot worker is ENABLED but the freshest engine-auto snapshot
 *  is older than 2× the cadence, the worker is dead or its RPC scans
 *  keep failing — the curve silently flatlines. */
export async function checkSnapshotFeed(): Promise<CheckResult> {
  try {
    const config = loadConfig();
    const enabled = config.engine?.workers?.snapshot?.enabled === true;
    if (!enabled) {
      return { name: "equity feed", severity: "ok", message: "snapshot worker off — equity curve has no auto feed (enable engine.workers.snapshot)" };
    }
    const everyHours = config.engine?.snapshotEveryHours ?? 24;
    const { listPortfolioSnapshots } = await import("./db.js");
    const { AUTO_SNAPSHOT_NOTE } = await import("./snapshotWorker.js");
    const recent = listPortfolioSnapshots({ limit: 100 });
    const lastAuto = recent.find((r) => r.note === AUTO_SNAPSHOT_NOTE);
    if (!lastAuto) {
      return {
        name: "equity feed",
        severity: "warn",
        message: "snapshot worker is enabled but has NEVER recorded — equity curve has no data",
        hint: "is the engine running? check `tradekit engine status`; the worker skips quietly when the portfolio scan fails (RPC)",
      };
    }
    const ageH = (Date.now() - Date.parse(lastAuto.timestamp)) / 3_600_000;
    if (ageH > 2 * everyHours) {
      return {
        name: "equity feed",
        severity: "warn",
        message: `last auto-snapshot is ${ageH.toFixed(0)}h old (cadence ${everyHours}h) — the equity curve is flatlining`,
        hint: "engine down, worker disabled mid-flight, or every portfolio scan failing (RPC) — check engine status + server log",
      };
    }
    return { name: "equity feed", severity: "ok", message: `last auto-snapshot ${ageH.toFixed(1)}h ago (cadence ${everyHours}h)` };
  } catch (e) {
    return { name: "equity feed", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** v38: quiet-hours health — a stuck flush silently eats the morning
 *  summary; a zero-length window means the feature is configured but
 *  never active. */
export async function checkQuietHours(): Promise<CheckResult> {
  try {
    const config = loadConfig();
    const qh = config.notifications?.quietHours;
    if (!qh?.enabled) {
      return { name: "quiet hours", severity: "ok", message: "quiet hours off" };
    }
    if (qh.startHourUtc === qh.endHourUtc) {
      return {
        name: "quiet hours",
        severity: "warn",
        message: `quiet hours enabled but startHourUtc === endHourUtc (${qh.startHourUtc}) — a zero-length window is NEVER active`,
        hint: "set distinct hours (e.g. 22 → 7) or disable the feature",
      };
    }
    const { pendingQueuedNotifications } = await import("./db.js");
    const pending = pendingQueuedNotifications(500);
    if (pending.length > 0) {
      const oldest = pending[0];
      const ageH = (Date.now() - Date.parse(oldest.queued_at)) / 3_600_000;
      if (ageH > 24) {
        return {
          name: "quiet hours",
          severity: "warn",
          message: `${pending.length} suppressed notification(s) queued for ${ageH.toFixed(0)}h — the flush appears stuck`,
          hint: "flush manually with `tradekit notify flush` (a failing summary webhook leaves rows queued; check `tradekit notify test`)",
        };
      }
      return { name: "quiet hours", severity: "ok", message: `window ${qh.startHourUtc}→${qh.endHourUtc} UTC · ${pending.length} pending (fresh)` };
    }
    return { name: "quiet hours", severity: "ok", message: `window ${qh.startHourUtc}→${qh.endHourUtc} UTC · queue empty` };
  } catch (e) {
    return { name: "quiet hours", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** v38: a retry slot in the past means the v32 backoff parked a
 *  schedule/plan and the engine never came back to consume it — the
 *  occurrence is in limbo until the engine ticks. */
export async function checkRetryParked(): Promise<CheckResult> {
  const LIMBO_MS = 3_600_000; // 1h past the retry slot
  try {
    const { listSchedules } = await import("./db.js");
    const { listRebalancePlans } = await import("./rebalance.js");
    const now = Date.now();
    const parked: string[] = [];
    for (const s of listSchedules({ status: "active" })) {
      if ((s.retry_count ?? 0) > 0 && now - Date.parse(s.next_run_at) > LIMBO_MS) {
        parked.push(`schedule #${s.id} (attempt ${s.retry_count}, slot ${s.next_run_at})`);
      }
    }
    for (const r of listRebalancePlans({ status: "active" })) {
      if ((r.retry_count ?? 0) > 0 && r.next_run_at != null && now - Date.parse(r.next_run_at) > LIMBO_MS) {
        parked.push(`rebalance #${r.id} (attempt ${r.retry_count}, slot ${r.next_run_at})`);
      }
    }
    if (parked.length > 0) {
      return {
        name: "retry slots",
        severity: "warn",
        message: `${parked.length} primitive(s) parked on a PAST retry slot — the engine isn't consuming them: ${parked.slice(0, 3).join("; ")}${parked.length > 3 ? "; …" : ""}`,
        hint: "the engine looks down — the occurrence stays in limbo until it ticks; check `tradekit engine status`",
      };
    }
    return { name: "retry slots", severity: "ok", message: "no parked retries" };
  } catch (e) {
    return { name: "retry slots", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** v38: everything paused + nothing active + engine unlocked smells
 *  like a forgotten panic — the operator released the lock but never
 *  resumed anything. */
export async function checkPausedForgotten(): Promise<CheckResult> {
  try {
    const { listOrders, listSchedules } = await import("./db.js");
    const { listRebalancePlans } = await import("./rebalance.js");
    const { getEngineLockState, isEngineLockedFromRow } = await import("./engineLock.js");
    const paused =
      listOrders({ status: "paused" }).length +
      listSchedules({ status: "paused" }).length +
      listRebalancePlans({ status: "paused" }).length;
    if (paused === 0) {
      return { name: "paused primitives", severity: "ok", message: "none paused" };
    }
    const active =
      listOrders({ status: "active" }).length +
      listSchedules({ status: "active" }).length +
      listRebalancePlans({ status: "active" }).length;
    if (active === 0 && !isEngineLockedFromRow(getEngineLockState())) {
      return {
        name: "paused primitives",
        severity: "warn",
        message: `${paused} primitive(s) paused, ZERO active, engine unlocked — forgotten panic/breaker?`,
        hint: "resume selectively (`tradekit strategy resume <tag>`) or everything (`tradekit panic release --resume-all`)",
      };
    }
    return { name: "paused primitives", severity: "ok", message: `${paused} paused · ${active} active` };
  } catch (e) {
    return { name: "paused primitives", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** v36.5: signal-armed orders need an ingestion path. If the
 *  webhook secret is unset, signals can only arrive via CLI/MCP —
 *  fine for agent-driven flows, but an operator who armed orders for
 *  TradingView alerts is silently waiting forever. */
export async function checkSignalReadiness(): Promise<CheckResult> {
  try {
    const { listOrders } = await import("./db.js");
    const armed = listOrders({ status: "active" }).filter((o) => o.trigger_type === "signal");
    if (armed.length === 0) {
      return { name: "signals", severity: "ok", message: "no signal-armed orders" };
    }
    const config = loadConfig();
    if (!config.webhooks?.signalSecret) {
      return {
        name: "signals",
        severity: "warn",
        message: `${armed.length} signal-armed order(s) but webhooks.signalSecret is UNSET — the webhook endpoint is disabled (signals only arrive via 'tradekit signal fire' / MCP)`,
        hint: "wire TradingView: `tradekit config set webhooks.signalSecret <16+ random chars>` then POST /api/signal/<name>?key=<secret>",
      };
    }
    return { name: "signals", severity: "ok", message: `${armed.length} signal-armed order(s) · webhook ingestion enabled` };
  } catch (e) {
    return { name: "signals", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

/** v47.5: an open pending intent means an agent is BLOCKED waiting
 *  on a human; expiries in the last 7d mean proposals are dying
 *  un-reviewed (the operator isn't seeing the notifications). */
export async function checkPendingIntents(now: Date = new Date()): Promise<CheckResult> {
  try {
    const { listIntents } = await import("./tradeIntents.js");
    const rows = listIntents({ limit: 200 }, now);
    const pending = rows.filter((r) => r.status === "pending");
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const expiredRecently = rows.filter((r) => r.status === "expired" && r.expires_at >= weekAgo);
    if (pending.length > 0) {
      const soonest = pending.reduce((min, r) => (r.expires_at < min ? r.expires_at : min), pending[0].expires_at);
      return {
        name: "intents",
        severity: "warn",
        message: `${pending.length} agent trade(s) AWAITING APPROVAL (soonest expiry ${soonest}) — the agent is blocked until you decide`,
        hint: `review: tradekit intents list · approve/reject: tradekit intents approve|reject <id>`,
      };
    }
    if (expiredRecently.length > 0) {
      return {
        name: "intents",
        severity: "warn",
        message: `${expiredRecently.length} agent proposal(s) expired UN-REVIEWED in the last 7d — approval requests are being missed`,
        hint: "check notification channels deliver trade.approval_pending, or raise safety.tradeApproval.expiresMinutes",
      };
    }
    const gateOn = loadConfig().safety?.tradeApproval?.enabled === true;
    return { name: "intents", severity: "ok", message: gateOn ? "approval gate on · queue clear" : "approval gate off (safety.tradeApproval)" };
  } catch (e) {
    return { name: "intents", severity: "warn", message: `check failed: ${(e as Error).message}` };
  }
}

export async function checkEnv(): Promise<CheckResult> {
  const SENSITIVE = new Set(["WALLET_PASS", "TRADEKIT_WEB_TOKEN"]);
  const KNOWN = [
    "TRADEKIT_DATA_DIR",
    "TRADEKIT_WEB_TOKEN",
    "TRADEKIT_HTTP_TIMEOUT_MS",
    "TRADEKIT_RECEIPT_TIMEOUT_MS",
    "TRADEKIT_LOG_ROTATE_BYTES",
    "TRADEKIT_STRATEGY",
    "WALLET_PASS",
  ];
  const details: { label: string; ok: boolean; note?: string }[] = [];
  const setSummary: string[] = [];
  let walletPassSet = false;
  for (const name of KNOWN) {
    const raw = process.env[name];
    const isSet = raw !== undefined && raw !== "";
    if (!isSet) {
      details.push({ label: name, ok: false, note: "(unset)" });
      continue;
    }
    if (SENSITIVE.has(name)) {
      details.push({ label: name, ok: true, note: "(set, value hidden)" });
      setSummary.push(`${name}=(set)`);
      if (name === "WALLET_PASS") walletPassSet = true;
    } else {
      // Truncate long values (e.g. a paths) in the inline summary; full value in details.
      const compact = raw.length > 40 ? raw.slice(0, 37) + "…" : raw;
      details.push({ label: name, ok: true, note: raw });
      setSummary.push(`${name}=${compact}`);
    }
  }
  const setCount = setSummary.length;
  const baseMsg =
    setCount === 0
      ? "no recognized env vars set"
      : `${setCount} set: ${setSummary.join(", ")}`;
  // WALLET_PASS skips the password prompt — operators who set it long ago and
  // forget can be surprised by trades that don't ask. Surface inline in the
  // message rather than as a hint: formatDoctorResults skips hints for ok-
  // severity checks, but we still want this note to be visible by default.
  const message = walletPassSet
    ? `${baseMsg}. WALLET_PASS skips the prompt — unset if unintended.`
    : baseMsg;
  return { name: "env vars", severity: "ok", message, details };
}

async function checkPriceApi(): Promise<CheckResult> {
  // DexScreener is our universal fallback; if that's down, prices break silently.
  try {
    const r = await fetchWithTimeout(
      "https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      undefined,
      TIMEOUT_MS,
    );
    return r.ok
      ? { name: "price (DexScreener)", severity: "ok", message: "reachable" }
      : { name: "price (DexScreener)", severity: "warn", message: `HTTP ${r.status}` };
  } catch (e) {
    return { name: "price (DexScreener)", severity: "warn", message: compactMessage((e as Error).message, 60) };
  }
}

// ── orchestrator ─────────────────────────────────────────────

export interface DoctorOptions {
  /** Which chains to check RPCs for. Default: just the active chain. Pass "all" for all built-in chains. */
  chains?: string[];
  /** When supplied, doctor will attempt to decrypt the keystore and report success/failure. */
  walletPass?: string;
  logger: Logger;
}

export async function runDoctor(opts: DoctorOptions): Promise<{ timestamp: string; results: CheckResult[]; criticalFailures: number; elapsedMs: number }> {
  // Iter908: track wall-clock elapsed so --summary (iter847) can surface
  // (Ns) parens for parity with health/verify/reconcile/sync --summary lines.
  // Operators tailing cron logs spot performance regression at a glance.
  const t0 = Date.now();
  const config = loadConfig();
  // "all" expands to built-in + user-configured custom chains. Pre-iter211 it was
  // built-in only — a user with a custom L3 wired up via config.chains.* wouldn't
  // have their custom chain checked even when explicitly asking for everything.
  const customChains = Object.keys(config.chains ?? {}).filter(
    (c) => !listChains().includes(c.toLowerCase()),
  );
  const chains =
    opts.chains && opts.chains.length > 0
      ? opts.chains.includes("all")
        ? [...listChains(), ...customChains]
        : opts.chains
      : [config.activeChain];

  const results: CheckResult[] = [];
  results.push(await checkNodeVersion());
  results.push(await checkDataDir());
  results.push(await checkStaleTmps());
  results.push(await checkStaleLocks());
  results.push(await checkConfig());
  results.push(await checkSafety());
  results.push(await checkWallet({ walletPass: opts.walletPass, logger: opts.logger }));
  results.push(await checkDb());
  results.push(await checkServerLog());
  results.push(await checkPendingTrades());
  results.push(await checkSyncBookmarks());
  // v30 ops-hygiene pack (offline: DB + config + status file).
  results.push(await checkRetentionHygiene());
  results.push(await checkPaperReadiness());
  results.push(await checkAlertsCoverage());
  results.push(await checkEngineLiveness());
  // v38 hygiene pack for the newer subsystems (all offline).
  results.push(await checkEngineLockStale());
  results.push(await checkSnapshotFeed());
  results.push(await checkQuietHours());
  results.push(await checkRetryParked());
  results.push(await checkPausedForgotten());
  results.push(await checkSignalReadiness());
  results.push(await checkPendingIntents());
  results.push(await checkNotificationDelivery());

  // RPCs (parallel)
  results.push(...(await Promise.all(chains.map((c) => checkRpc(c, opts.logger)))));

  // Aggregators (probe via a trivial GET)
  results.push(
    ...(await Promise.all([
      checkAggregator("kyberswap", async () => {
        const r = await fetchWithTimeout("https://aggregator-api.kyberswap.com/base/api/v1/routes?tokenIn=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&tokenOut=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amountIn=1000000000000000", { headers: { "x-client-id": "tradekit" } }, TIMEOUT_MS);
        return r.ok;
      }),
      checkAggregator("openocean", async () => {
        const r = await fetchWithTimeout(
          "https://open-api.openocean.finance/v3/8453/swap_quote?inTokenAddress=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&outTokenAddress=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amount=0.001&gasPrice=1&slippage=1&account=0x0000000000000000000000000000000000000001",
          undefined,
          TIMEOUT_MS,
        );
        return r.ok;
      }),
    ])),
  );

  // MEV-protected submission RPCs (when configured for any of the chains
  // under scan). Each entry is probed independently. A reachable +
  // chain-matching relay surfaces as `mev:<chain> (Label)  reachable in
  // Nms`; mismatches / failures surface as warn / fail with the precise
  // reason so operators can diagnose without grepping logs.
  results.push(...(await checkMevRelays(config, chains)));

  results.push(await checkPriceApi());
  results.push(await checkEnv());

  const criticalFailures = results.filter((r) => r.severity === "fail").length;
  return { timestamp: new Date().toISOString(), results, criticalFailures, elapsedMs: Date.now() - t0 };
}

export function formatDoctorResults(results: CheckResult[], opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  const ICONS: Record<CheckSeverity, string> = { ok: "✓", warn: "!", fail: "✗" };
  for (const r of results) {
    const icon = ICONS[r.severity];
    lines.push(`  ${icon}  ${r.name.padEnd(22)} ${r.message}`);
    // Per-endpoint detail rows: shown for warn/fail by default (so operators see why)
    // and for everything when --verbose.
    if (r.details && (opts.verbose || r.severity !== "ok")) {
      for (const d of r.details) {
        const dIcon = d.ok ? "✓" : "✗";
        const lat = d.latencyMs != null ? `${d.latencyMs}ms`.padStart(7) : "       ";
        const note = d.note ? `  ${compactMessage(d.note, 60)}` : "";
        lines.push(`        ${dIcon} ${d.label.padEnd(35)} ${lat}${note}`);
      }
    }
    if (r.hint && r.severity !== "ok") {
      lines.push(`     ${"".padEnd(22)} → ${r.hint}`);
    }
  }
  return lines.join("\n");
}
