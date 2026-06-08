// Iter626: `tradekit verify` CLI. Orchestrates the integrity checks across
// subsystems. Pure compute lives in src/verify.ts; this file handles the
// CLI shape (target flag, password optional for backup) + text rendering.

import { ToolError } from "../errors.js";
import { loadConfig } from "../config.js";
import { listChains } from "../chains.js";
import { getKeystoreAddress } from "../wallet.js";
import { hasMnemonic, loadMnemonicKeystore, decryptMnemonic } from "../accounts.js";
import { mnemonicToAccount } from "viem/accounts";
import { openDb } from "../db.js";
import {
  verifyBackupBundle,
  verifyConfigIntegrity,
  verifyDbIntegrity,
  summarizeChecks,
  type VerifyCheckResult,
  type VerifyTarget,
} from "../verify.js";
import { makeCliLogger, printJson } from "./helpers.js";

const SCHEMA_VERSION = 3; // iter618 introduced v3 (portfolio_snapshots)

export async function verifyCommand(flags: Record<string, string>, positional: string[]) {
  // Iter626: positional[1] = target. Defaults to "all" (every check) when
  // omitted. `backup` requires a positional[2] = file path.
  const rawTarget = (positional[1] ?? "all").toLowerCase();
  const validTargets: VerifyTarget[] = ["all", "backup", "wallet", "config", "db"];
  if (!validTargets.includes(rawTarget as VerifyTarget)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Unknown verify target "${rawTarget}". Valid: ${validTargets.join(", ")}.`,
    );
  }
  const target = rawTarget as VerifyTarget;
  const logger = makeCliLogger(flags);
  // Iter785: wall-clock encompassing all check phases (backup decrypt + wallet
  // re-derive + config validation + DB integrity scan).
  const t0 = Date.now();
  try {
    const checks: VerifyCheckResult[] = [];
    const wantBackup = target === "all" || target === "backup";
    const wantWallet = target === "all" || target === "wallet";
    const wantConfig = target === "all" || target === "config";
    const wantDb = target === "all" || target === "db";

    if (wantBackup) {
      // Backup is opt-in within "all" mode — when no --file is supplied, we
      // record a single "skipped" check rather than scanning every possible path.
      const file = positional[2] ?? flags["file"];
      if (target === "backup" && !file) {
        throw new ToolError(
          "INVALID_PARAMS",
          "Usage: tradekit verify backup <file> [--pass <password>] [--json]",
        );
      }
      if (file) {
        const password = flags["pass"] ?? process.env.WALLET_PASS ?? null;
        const backupChecks = await verifyBackupBundle({ file, password, logger });
        checks.push(...backupChecks);
      } else if (target === "all") {
        checks.push({
          name: "backup.skipped",
          ok: true,
          message: "No backup file specified — backup checks skipped. Use `tradekit verify backup <file>` to verify a specific backup.",
        });
      }
    }

    if (wantWallet) {
      checks.push(...verifyWalletState());
    }

    if (wantConfig) {
      const config = loadConfig();
      const knownChains = [...listChains(), ...Object.keys(config.chains)];
      checks.push(...verifyConfigIntegrity(config, knownChains));
    }

    if (wantDb) {
      checks.push(...gatherDbChecks());
    }

    const report = summarizeChecks(target, checks);
    // Iter785: stamp wall-clock before render (matches the iter727/728/749
    // orchestrator-set pattern).
    report.elapsedMs = Date.now() - t0;

    if (flags["json"] === "true") {
      // Spread the report (which already includes `ok`) so JSON consumers get
      // the canonical shape — no need to wrap in another envelope.
      printJson({ ...report });
      return;
    }

    // Iter760: --quiet filters rendered output to non-ok checks. Parallel to
    // iter752 doctor --quiet + iter734 health --quiet — same cron-tail UX
    // discipline. Summary counts come from the UNFILTERED report so passed/
    // failed numbers stay authoritative. JSON shape ignores --quiet
    // (consumers parse the full results array regardless).
    const quiet = flags["quiet"] === "true" || flags["quiet"] === "";
    const summary = flags["summary"] === "true" || flags["summary"] === "";
    renderReport(report, { quiet, summary });
    if (!report.ok) {
      // Iter626: non-zero exit on failure so CI/cron can detect issues.
      // Pre-print so the operator sees the report first.
      process.exit(1);
    }
  } finally {
    logger.close();
  }
}

/**
 * Iter626: wallet integrity check. Re-derives the address from each stored
 * source (keystore + HD mnemonic) and confirms each is in a state we can
 * recover from. We can't decrypt the keystore without the password, so this
 * check is structural: file exists, parses, and reports its expected address.
 */
function verifyWalletState(): VerifyCheckResult[] {
  const checks: VerifyCheckResult[] = [];

  // Keystore presence.
  const keystoreAddr = getKeystoreAddress();
  if (keystoreAddr) {
    checks.push({
      name: "wallet.keystore.present",
      ok: true,
      message: `Keystore file present, derived address ${keystoreAddr}.`,
      details: { address: keystoreAddr },
    });
  } else {
    checks.push({
      name: "wallet.keystore.absent",
      ok: true,
      message: "No keystore configured (HD mnemonic may be in use instead).",
    });
  }

  // HD mnemonic presence — we don't read the password-encrypted file here;
  // just check it exists. Reading would require requirePassword.
  if (hasMnemonic()) {
    try {
      // Attempt to re-derive address 0 from the mnemonic file via the existing
      // loader. This requires WALLET_PASS in the env — we skip the actual
      // re-derive when WALLET_PASS isn't set to avoid spurious failures.
      if (process.env.WALLET_PASS) {
        const ks = loadMnemonicKeystore();
        const mnemonic = decryptMnemonic(ks, process.env.WALLET_PASS);
        const account = mnemonicToAccount(mnemonic);
        checks.push({
          name: "wallet.mnemonic.derives",
          ok: true,
          message: `HD mnemonic decrypts + derives account-0 address ${account.address}.`,
          details: { address: account.address },
        });
      } else {
        checks.push({
          name: "wallet.mnemonic.present",
          ok: true,
          message: "HD mnemonic file present. Set WALLET_PASS to verify decryption + address derivation.",
        });
      }
    } catch (e) {
      checks.push({
        name: "wallet.mnemonic.derive_failed",
        ok: false,
        message: `HD mnemonic exists but failed to derive: ${(e as Error).message}. Wrong password or corrupted file.`,
      });
    }
  } else {
    checks.push({
      name: "wallet.mnemonic.absent",
      ok: true,
      message: "No HD mnemonic configured.",
    });
  }

  if (!keystoreAddr && !hasMnemonic()) {
    checks.push({
      name: "wallet.none",
      ok: false,
      message: "No wallet configured. Run `tradekit init` or `tradekit wallet create`.",
    });
  }

  return checks;
}

/** Iter626: gather DB stats + call the pure verifyDbIntegrity helper. */
function gatherDbChecks(): VerifyCheckResult[] {
  try {
    const db = openDb();
    const schemaRow = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
    const pendingTotal = (db.prepare("SELECT COUNT(*) AS c FROM trades WHERE status = 'pending'").get() as { c: number }).c;
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    const pendingStale = (db
      .prepare("SELECT COUNT(*) AS c FROM trades WHERE status = 'pending' AND timestamp < ?")
      .get(cutoff) as { c: number }).c;
    const auditRows = (db.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
    return verifyDbIntegrity({
      schemaVersion: schemaRow.v ?? 0,
      expectedSchemaVersion: SCHEMA_VERSION,
      pendingCount: pendingTotal,
      pendingOlderThan24h: pendingStale,
      auditRowCount: auditRows,
    });
  } catch (e) {
    return [
      {
        name: "db.open_failed",
        ok: false,
        message: `Cannot open DB: ${(e as Error).message}. Database may be missing or corrupted.`,
      },
    ];
  }
}

function renderReport(
  report: ReturnType<typeof summarizeChecks>,
  opts: { quiet?: boolean; summary?: boolean } = {},
) {
  // Iter785: elapsedMs suffix — parity with iter731/744/758/762 reconcile/pnl/etc.
  const elapsedSuffix = report.elapsedMs != null
    ? `  (${(report.elapsedMs / 1000).toFixed(1)}s)`
    : "";
  // Iter808: severity badge — parity with iter305 preflight convention.
  // Operators eyeballing verify output see pass/fail at a glance.
  const badge = report.severity === "ok" ? "🟢 OK  " : "🔴 FAIL";
  // Iter847: --summary prints a cron/Slack-friendly single-liner. Parallel
  // to iter846 health --summary + iter847 doctor --summary. Includes
  // target/counts/top-2 failed check names so the alert subject identifies
  // WHICH checks failed without scrolling.
  if (opts.summary) {
    const parts: string[] = [
      `target=${report.target}`,
      `${report.passed}/${report.checks.length} passed`,
    ];
    if (report.failed > 0) {
      const failedNames = report.checks.filter((c) => !c.ok).slice(0, 2).map((c) => c.name);
      parts.push(`top: ${failedNames.join(", ")}`);
    }
    // Iter901: append ISO timestamp for consistency with health/doctor/
    // pending --summary lines. Lets Slack/log-aggregation correlate alerts
    // by time across all 6 cron-friendly commands.
    parts.push(new Date().toISOString());
    console.log(`${badge}  tradekit verify · ${parts.join(" · ")}${elapsedSuffix}`);
    return;
  }
  console.log(`${badge}  Verification — target=${report.target}, ${report.passed}/${report.checks.length} passed${elapsedSuffix}`);
  console.log("=".repeat(60));
  // Iter760: --quiet filters the rendered list to non-ok rows. Empty body
  // under --quiet renders an honest one-liner instead of nothing (same
  // pattern as iter752 doctor --quiet).
  const rendered = opts.quiet ? report.checks.filter((c) => !c.ok) : report.checks;
  if (rendered.length === 0 && opts.quiet) {
    console.log(`  (all ${report.passed} checks ok — --quiet suppressed details)`);
  } else {
    for (const check of rendered) {
      const badge = check.ok ? "✓" : "✗";
      console.log(`  ${badge}  ${check.name}`);
      console.log(`     ${check.message}`);
    }
  }
  console.log("");
  if (report.ok) {
    console.log(`All ${report.passed} checks passed.`);
  } else {
    console.log(`⚠️  ${report.failed} check${report.failed === 1 ? "" : "s"} failed.`);
  }
}
