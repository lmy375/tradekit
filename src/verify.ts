// Iter626: tradekit verify — integrity check suite.
//
// Pre-iter626 operators had no way to validate a backup short of restoring it
// (destructive), no way to spot orphan token references in config, no way to
// confirm the keystore actually decrypts to the address the tool reports as
// "active". This module ships a single command that runs all those checks
// non-destructively.
//
// Design:
//   - Each subsystem produces a list of VerifyCheckResult (name + ok + message
//     + optional structured details). One BIG report aggregates them.
//   - Pure-where-possible: config + db integrity helpers are pure (no I/O).
//     Backup + wallet require I/O.
//   - Per-check failure is captured — one bad check doesn't abort the suite.
//   - Output is agent-friendly: structured `details` carry actionable data
//     (e.g. orphan token's chain + symbol so an agent can dispatch
//     `config drop ...`).

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAddress } from "viem";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { decryptBundle, type EncryptedBackup, type BackupBundle } from "./backup.js";

export interface VerifyCheckResult {
  /** Stable name an agent can branch on. */
  name: string;
  ok: boolean;
  /** Human-readable description; failure mode for ok=false, success summary for ok=true. */
  message: string;
  /** Structured payload — e.g. orphan token's address. */
  details?: Record<string, unknown>;
}

export type VerifyTarget = "all" | "backup" | "wallet" | "config" | "db";

export interface VerifyReport {
  timestamp: string;
  target: VerifyTarget;
  checks: VerifyCheckResult[];
  passed: number;
  failed: number;
  /** True when every check passed. */
  ok: boolean;
  /** Iter805: cross-report consistency — every major report type carries a
   *  severity string for at-a-glance status. Verify is binary so this maps
   *  to `ok` (every check passed) | `fail` (any check failed). Always
   *  present. Symmetric with iter786/787/788/801/802/803/804 severity
   *  fields. */
  severity: "ok" | "fail";
  /** Iter826: pre-filtered slice of checks where ok === false. Dashboards
   *  rendering "what's broken in verify" branch on this field instead of
   *  filtering checks[]. Symmetric with iter825 doctor failedChecks. Always
   *  present (empty array on a clean run); length === failed count. */
  failedChecks: VerifyCheckResult[];
  /** Iter785: wall-clock ms for the full verify orchestration. Verify touches
   *  RPC (re-derive keystore address) + DB (schema, audit size) + filesystem
   *  (backup decrypt+parse) — useful to see how long checks took on degraded
   *  RPCs / large audit tables. Symmetric with elapsedMs across other major
   *  report types. Set externally by the CLI/MCP orchestrator since
   *  summarizeChecks is pure (matches the iter727/728 multi-account-pnl /
   *  portfolio pattern). Absent on synthetic reports built without an
   *  orchestrator. */
  elapsedMs?: number;
}

/**
 * Iter626: pure config integrity check. Walks the config and surfaces:
 *   - Tokens defined for chains that aren't in built-ins or chain overrides
 *   - Token addresses that aren't valid 0x-addresses
 *   - Empty chain overrides (chains.<x> with no useful fields set)
 *   - tokenBlacklist / tokenWhitelist / contractWhitelist entries referencing
 *     chains the config doesn't know about
 *
 * Exported pure so unit tests can pin behavior without spinning up the
 * config loader.
 *
 * `knownChainNames` is the union of built-ins + custom — caller computes
 * via `[...listChains(), ...Object.keys(config.chains)]`.
 */
export function verifyConfigIntegrity(
  config: Config,
  knownChainNames: readonly string[],
): VerifyCheckResult[] {
  const checks: VerifyCheckResult[] = [];
  const knownSet = new Set(knownChainNames.map((c) => c.toLowerCase()));

  // Check 1: every custom chain override has either chainId or rpcs (else it's
  // an orphan shell that does nothing).
  for (const [name, override] of Object.entries(config.chains ?? {})) {
    const isShell =
      !override.chainId &&
      (!override.rpcs || override.rpcs.length === 0) &&
      !override.weth &&
      !override.usdc &&
      (!override.tokens || Object.keys(override.tokens).length === 0);
    if (isShell) {
      checks.push({
        name: `config.chains.${name}.empty`,
        ok: false,
        message: `Chain override "${name}" has no chainId, rpcs, weth, usdc, or tokens — it's an empty shell that does nothing.`,
        details: { chain: name },
      });
    }
  }
  if (Object.keys(config.chains ?? {}).filter((n) => {
    const o = config.chains[n];
    return (
      !o.chainId &&
      (!o.rpcs || o.rpcs.length === 0) &&
      !o.weth &&
      !o.usdc &&
      (!o.tokens || Object.keys(o.tokens).length === 0)
    );
  }).length === 0) {
    checks.push({
      name: "config.chains.no_empty_shells",
      ok: true,
      message: "No empty chain shells found.",
    });
  }

  // Check 2: per-chain custom tokens — every address parses as a valid 0x address.
  let bogusTokenCount = 0;
  for (const [chainName, override] of Object.entries(config.chains ?? {})) {
    if (!override.tokens) continue;
    for (const [sym, addr] of Object.entries(override.tokens)) {
      if (!isAddress(addr)) {
        checks.push({
          name: `config.chains.${chainName}.tokens.${sym}.invalid_address`,
          ok: false,
          message: `Token "${sym}" on chain "${chainName}" has invalid address ${addr} — not a 0x-prefixed 40-hex-char address.`,
          details: { chain: chainName, symbol: sym, address: addr },
        });
        bogusTokenCount++;
      }
    }
  }
  if (bogusTokenCount === 0) {
    checks.push({
      name: "config.tokens.all_valid_addresses",
      ok: true,
      message: "All custom token addresses are valid.",
    });
  }

  // Check 3: safety lists (tokenWhitelist / tokenBlacklist / contractWhitelist)
  // — each chain key in these maps must be a known chain. Orphan keys are
  // silent failures (the safety check uses chainLookup which case-insensitively
  // matches; an unknown chain just no-ops).
  const safetyMaps = [
    { key: "tokenWhitelist", map: config.safety?.tokenWhitelist },
    { key: "tokenBlacklist", map: config.safety?.tokenBlacklist },
    { key: "contractWhitelist", map: config.safety?.contractWhitelist },
  ] as const;
  let safetyOrphans = 0;
  for (const { key, map } of safetyMaps) {
    if (!map) continue;
    for (const chain of Object.keys(map)) {
      if (!knownSet.has(chain.toLowerCase())) {
        checks.push({
          name: `config.safety.${key}.${chain}.unknown_chain`,
          ok: false,
          message: `safety.${key} has entries for unknown chain "${chain}". The safety check silently won't fire for these. Add the chain to config.chains or remove the entry.`,
          details: { safetyField: key, chain },
        });
        safetyOrphans++;
      }
    }
  }
  if (safetyOrphans === 0) {
    checks.push({
      name: "config.safety.no_orphan_chain_refs",
      ok: true,
      message: "Safety token/contract lists reference only known chains.",
    });
  }

  // Check 4: aggregator.preferred is non-empty (else `aggregateQuote` would
  // fail every call).
  if (!config.aggregator?.preferred || config.aggregator.preferred.length === 0) {
    checks.push({
      name: "config.aggregator.preferred.empty",
      ok: false,
      message: "aggregator.preferred is empty. Set at least one (kyberswap, openocean, 0x, 1inch).",
      details: { current: config.aggregator?.preferred ?? [] },
    });
  } else {
    checks.push({
      name: "config.aggregator.preferred.set",
      ok: true,
      message: `aggregator.preferred is set to [${config.aggregator.preferred.join(", ")}].`,
    });
  }

  return checks;
}

/**
 * Iter626: pure DB integrity check. Surfaces:
 *   - Schema version (sanity — must be the current version)
 *   - Pending trades older than 24h (likely stuck or reorg'd; reconcile won't auto-clean)
 *   - Audit-log size warning (>100k rows → prune recommended)
 *
 * `db` is the raw DatabaseSync handle. Pure compute — the caller does the
 * single `openDb()` and passes it in.
 */
export function verifyDbIntegrity(args: {
  schemaVersion: number;
  expectedSchemaVersion: number;
  pendingCount: number;
  pendingOlderThan24h: number;
  auditRowCount: number;
}): VerifyCheckResult[] {
  const checks: VerifyCheckResult[] = [];

  if (args.schemaVersion === args.expectedSchemaVersion) {
    checks.push({
      name: "db.schema.current",
      ok: true,
      message: `DB schema is at v${args.schemaVersion} (current).`,
    });
  } else {
    checks.push({
      name: "db.schema.mismatch",
      ok: false,
      message: `DB schema is at v${args.schemaVersion} but this build expects v${args.expectedSchemaVersion}. Run any command that opens the DB to trigger migrations.`,
      details: { actual: args.schemaVersion, expected: args.expectedSchemaVersion },
    });
  }

  if (args.pendingOlderThan24h > 0) {
    checks.push({
      name: "db.pending.stale",
      ok: false,
      message: `${args.pendingOlderThan24h} pending trade${args.pendingOlderThan24h === 1 ? "" : "s"} older than 24h. Run \`tradekit pending\` to diagnose, or \`tradekit reconcile\` to refresh from chain.`,
      details: { stalePendingCount: args.pendingOlderThan24h, totalPending: args.pendingCount },
    });
  } else if (args.pendingCount > 0) {
    checks.push({
      name: "db.pending.recent",
      ok: true,
      message: `${args.pendingCount} pending trade${args.pendingCount === 1 ? "" : "s"} (all <24h old).`,
    });
  } else {
    checks.push({
      name: "db.pending.none",
      ok: true,
      message: "No pending trades.",
    });
  }

  // Audit log size — 100k threshold matches iter120's doctor threshold.
  if (args.auditRowCount > 100_000) {
    checks.push({
      name: "db.audit.large",
      ok: false,
      message: `Audit log has ${args.auditRowCount.toLocaleString("en-US")} rows. Consider \`tradekit audit prune --before 30d\` to trim — large audit tables slow queries.`,
      details: { rowCount: args.auditRowCount, threshold: 100_000 },
    });
  } else {
    checks.push({
      name: "db.audit.size_ok",
      ok: true,
      message: `Audit log: ${args.auditRowCount.toLocaleString("en-US")} rows (under prune threshold).`,
    });
  }

  return checks;
}

/**
 * Iter626: verify a backup bundle without restoring. Reads the file, decrypts
 * via decryptBundle (which validates magic + version cheaply BEFORE the slow
 * scrypt KDF runs), then validates each contained file can be parsed/decoded.
 *
 * Returns a list of per-check results. Throws only when the file can't be
 * READ at all (file missing / not JSON-shaped) — encryption failures land in
 * the check list as ok=false so the caller can branch on which check failed.
 *
 * `password` may be empty when the operator only wants to confirm the magic +
 * structural integrity without unlocking; in that case the decrypt checks
 * are skipped (logged ok=false with reason "no_password_supplied").
 */
export async function verifyBackupBundle(args: {
  file: string;
  password: string | null;
  logger: Logger;
}): Promise<VerifyCheckResult[]> {
  const checks: VerifyCheckResult[] = [];

  // Phase 1: file presence + readability.
  if (!existsSync(args.file)) {
    checks.push({
      name: "backup.file.exists",
      ok: false,
      message: `Backup file not found: ${args.file}`,
      details: { path: args.file },
    });
    return checks;
  }

  let raw: string;
  try {
    raw = readFileSync(args.file, "utf8");
    const stats = statSync(args.file);
    checks.push({
      name: "backup.file.readable",
      ok: true,
      message: `Backup file present (${stats.size} bytes).`,
      details: { path: args.file, bytes: stats.size },
    });
  } catch (e) {
    checks.push({
      name: "backup.file.readable",
      ok: false,
      message: `Cannot read backup file: ${(e as Error).message}`,
      details: { path: args.file },
    });
    return checks;
  }

  // Phase 2: JSON structure + magic validation (no decryption needed yet).
  let encrypted: EncryptedBackup;
  try {
    encrypted = JSON.parse(raw) as EncryptedBackup;
  } catch (e) {
    checks.push({
      name: "backup.json.parse",
      ok: false,
      message: `Backup file is not valid JSON: ${(e as Error).message}. Was the file corrupted or partially written?`,
    });
    return checks;
  }
  checks.push({ name: "backup.json.parse", ok: true, message: "Backup file is valid JSON." });

  if (encrypted.magic !== "TKBACKUP") {
    checks.push({
      name: "backup.magic",
      ok: false,
      message: `File magic is "${encrypted.magic}" — not a tradekit backup. Expected "TKBACKUP".`,
      details: { magic: encrypted.magic },
    });
    return checks;
  }
  checks.push({ name: "backup.magic", ok: true, message: "Magic prefix is TKBACKUP." });

  if (typeof encrypted.v !== "number") {
    checks.push({
      name: "backup.version",
      ok: false,
      message: `Backup format version is missing or invalid.`,
      details: { version: encrypted.v },
    });
    return checks;
  }
  checks.push({
    name: "backup.version",
    ok: true,
    message: `Backup format version v${encrypted.v}.`,
    details: { version: encrypted.v },
  });

  // Phase 3: decrypt (requires password).
  if (!args.password) {
    checks.push({
      name: "backup.decrypt",
      ok: false,
      message: "No password supplied — structural integrity verified but contents NOT decrypted. Re-run with --pass to fully verify.",
      details: { reason: "no_password_supplied" },
    });
    return checks;
  }

  let bundle: BackupBundle;
  try {
    bundle = decryptBundle(encrypted, args.password);
    checks.push({
      name: "backup.decrypt",
      ok: true,
      message: "Backup decrypted successfully.",
    });
  } catch (e) {
    checks.push({
      name: "backup.decrypt",
      ok: false,
      message: `Decryption failed: ${(e as Error).message}. Wrong password, corrupted ciphertext, or tampered authTag.`,
    });
    return checks;
  }

  // Phase 4: per-file content sanity. We don't need to fully parse — we just
  // check each file is non-empty base64 and decodes to plausible content.
  const expectedFiles = ["mnemonic.json", "wallet.json", "accounts.json", "config.json"];
  for (const filename of expectedFiles) {
    const content = bundle.files[filename];
    if (content == null) {
      // mnemonic/wallet may be absent depending on what the operator backed up.
      checks.push({
        name: `backup.file.${filename}`,
        ok: true,
        message: `${filename} not in backup (operator may have skipped it).`,
      });
      continue;
    }
    try {
      const decoded = Buffer.from(content, "base64").toString("utf8");
      // Mnemonic/wallet/accounts/config are all JSON. Verify each parses.
      JSON.parse(decoded);
      checks.push({
        name: `backup.file.${filename}`,
        ok: true,
        message: `${filename} present and parses as JSON (${decoded.length} bytes decoded).`,
        details: { bytes: decoded.length },
      });
    } catch (e) {
      checks.push({
        name: `backup.file.${filename}`,
        ok: false,
        message: `${filename} content is corrupted: ${(e as Error).message}. Backup may have been tampered after encryption.`,
      });
    }
  }

  // Phase 5: bundle metadata sanity.
  if (typeof bundle.createdAt !== "string" || !bundle.createdAt) {
    checks.push({
      name: "backup.metadata.createdAt",
      ok: false,
      message: "Backup bundle has no createdAt timestamp. Format version mismatch suspected.",
    });
  } else {
    checks.push({
      name: "backup.metadata.createdAt",
      ok: true,
      message: `Backup created at ${bundle.createdAt}.`,
      details: { createdAt: bundle.createdAt, includesDb: bundle.includesDb },
    });
  }

  args.logger.debug(`Backup verification completed: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed.`);
  return checks;
}

/**
 * Iter626: summarize a list of check results into the report shape. Pure.
 * Exported for testing — also used by the CLI/MCP layer.
 */
export function summarizeChecks(target: VerifyTarget, checks: VerifyCheckResult[]): VerifyReport {
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  return {
    timestamp: new Date().toISOString(),
    target,
    checks,
    passed,
    failed,
    ok: failed === 0,
    severity: failed === 0 ? "ok" : "fail",
    failedChecks: checks.filter((c) => !c.ok),
  };
}
