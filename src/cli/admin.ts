// Operator-facing CLI commands: gas, logs, version, doctor. Lifted from index.ts.

import { SERVER_LOG_PATH } from "../constants.js";
import { loadConfig, resolveProfile } from "../config.js";
import { listChains, assertKnownChain } from "../chains.js";
import { ToolError } from "../errors.js";
import { tradekitVersion } from "../version.js";
import { makeCliLogger, printJson, withWatch, parseIntFlag, parseChainsFlag, parseFloatFlag, requirePassword, subcommandError, prompt } from "./helpers.js";

// ── gas ──────────────────────────────────────────────────────

export async function gasCommand(flags: Record<string, string>) {
  await withWatch(flags, () => gasCommandOnce(flags));
}

async function gasCommandOnce(flags: Record<string, string>) {
  const { gasSnapshot, formatGasSnapshot } = await import("../gas.js");
  const config = loadConfig();
  // Iter348: reject the contradictory combination up front. Pre-iter348 if an operator
  // passed both `--chain base` and `--chains arbitrum,optimism`, parseChainsFlag won
  // and --chain was silently ignored — exactly the iter334 "don't conflate signals"
  // class. Same nul resolution exists nowhere else (doctor / holdings expose only
  // --chains; reconcile only --chain), so this is the lone gap.
  if (flags["chain"] && flags["chains"]) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Pass either --chain <name> (one chain) OR --chains <a,b,c> (a list), not both.",
    );
  }
  const chains =
    parseChainsFlag(flags["chains"], [...listChains(), ...Object.keys(config.chains)]) ?? [
      flags["chain"] ?? config.activeChain,
    ];
  const logger = makeCliLogger(flags);
  try {
    const snapshots = await Promise.all(
      chains.map(async (c) => {
        try {
          const profile = resolveProfile(c, config);
          return await gasSnapshot(profile, config.chains[c]?.rpcs ?? [], logger);
        } catch (e) {
          return { error: (e as Error).message, chain: c };
        }
      }),
    );
    if (flags["json"] === "true") {
      printJson(snapshots);
      // fall through to strict gate so the gate still applies in JSON mode
    } else {
      for (const s of snapshots) {
        if ("error" in s) {
          const { compactMessage } = await import("../format.js");
          console.error(`Error on ${s.chain}: ${compactMessage(s.error, 200)}`);
          continue;
        }
        console.log(formatGasSnapshot(s as Awaited<ReturnType<typeof gasSnapshot>>));
        console.log("");
      }
    }
    // Iter761: --strict exit-code surface. Closes the strict family across all
    // cron-friendly monitoring commands (doctor, health, trades sync, pnl,
    // pending, now gas). Triggers when any per-chain snapshot failed — cron
    // operators monitoring gas across N chains learn from exit code that an
    // RPC degraded, without parsing the JSON array for error entries.
    // process.exitCode (not process.exit) so main()'s audit-insert finally
    // block still runs (iter351 pattern).
    const strict = flags["strict"] === "true" || flags["strict"] === "";
    if (strict && snapshots.some((s) => "error" in s)) {
      process.exitCode = 1;
    }
  } finally {
    logger.close();
  }
}

// ── logs ─────────────────────────────────────────────────────

export async function logsCommand(flags: Record<string, string>) {
  // Destructure every fs helper we need up front — avoids a CommonJS-style require()
  // inside an ESM module (which only works because of dual-mode interop; not portable
  // and a lint flag if strict ESM rules ever land).
  const { statSync, existsSync, watchFile, unwatchFile, openSync, readSync, closeSync } =
    await import("fs");
  if (!existsSync(SERVER_LOG_PATH)) {
    console.log(`(no log file at ${SERVER_LOG_PATH} yet)`);
    return;
  }
  const tail = parseIntFlag(flags["tail"], "--tail", { min: 1, max: 100_000 }) ?? 50;

  // Iter255: tail-from-EOF instead of reading the whole file. Pre-iter255 we did
  // `readFileSync(SERVER_LOG_PATH, "utf-8").split("\n").slice(-tail)` — for a 100MB log
  // near the rotate threshold, that's ~99.999MB of wasted I/O + memory just to print
  // 50 lines. Read in 64KB chunks backward from EOF, accumulating newlines until we
  // have `tail+1` of them (the +1 covers the trailing newline at EOF). Falls back to
  // reading the whole file ONLY when smaller than one chunk (so tiny logs don't pay
  // the seek overhead).
  function readTail(path: string, n: number): string {
    const size = statSync(path).size;
    if (size === 0) return "";
    const fd = openSync(path, "r");
    try {
      const CHUNK = 64 * 1024;
      // Tiny files: just slurp.
      if (size <= CHUNK) {
        const buf = Buffer.alloc(size);
        readSync(fd, buf, 0, size, 0);
        const all = buf.toString("utf-8").split("\n").filter((l) => l.length > 0);
        return all.slice(-n).join("\n");
      }
      // Read chunks backward, accumulating as BYTES (not strings) so UTF-8 multi-byte
      // characters that straddle a chunk boundary aren't corrupted — pre-iter305 each
      // chunk was decoded in isolation, producing replacement chars at boundaries
      // (would only affect non-ASCII content in logs, e.g. an emoji in an error
      // message, but worth fixing). Decode the whole accumulator once at the end.
      //
      // Newline counting works on the BUFFER directly since 0x0A is a 1-byte char in
      // UTF-8 with no overlap with multi-byte continuation byte ranges.
      let position = size;
      const chunks: Buffer[] = [];
      let newlineCount = 0;
      while (position > 0 && newlineCount <= n) {
        const readLen = Math.min(CHUNK, position);
        position -= readLen;
        const buf = Buffer.alloc(readLen);
        readSync(fd, buf, 0, readLen, position);
        chunks.unshift(buf);
        for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) newlineCount++;
      }
      const combined = Buffer.concat(chunks).toString("utf-8");
      const lines = combined.split("\n").filter((l) => l.length > 0);
      return lines.slice(-n).join("\n");
    } finally {
      closeSync(fd);
    }
  }

  const tailText = readTail(SERVER_LOG_PATH, tail);
  if (tailText) process.stdout.write(tailText + "\n");

  if (flags["follow"] !== "true") return;

  // Follow mode: stat-poll based. Node's fs.watch is unreliable cross-platform.
  let lastSize = statSync(SERVER_LOG_PATH).size;
  watchFile(SERVER_LOG_PATH, { interval: 1000 }, (curr) => {
    if (curr.size < lastSize) lastSize = 0; // truncation / rotation — restart
    if (curr.size > lastSize) {
      const fd = openSync(SERVER_LOG_PATH, "r");
      const len = curr.size - lastSize;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, lastSize);
      closeSync(fd);
      process.stdout.write(buf.toString("utf-8"));
      lastSize = curr.size;
    }
  });
  process.on("SIGINT", () => {
    unwatchFile(SERVER_LOG_PATH);
    process.exit(0);
  });
  await new Promise(() => {});
}

// ── version ──────────────────────────────────────────────────

export async function versionCommand(flags: Record<string, string> = {}) {
  // Iter393: shared version helper (src/version.ts). Pre-iter393 the path-walking +
  // JSON-parse for package.json was inlined here AND not available to the web server's
  // /api/status endpoint — adding version to /api/status would have duplicated this
  // logic. Centralized + memoized so the lookup runs at most once per process.
  // Iter433: version is now statically imported at the top of this file. The
  // dynamic import here was needless overhead — version.ts has no init side effects
  // beyond reading package.json once (iter393's memoized cache).
  const version = tradekitVersion();
  // Iter319: structured JSON output for scripted consumers (CI gates, monitoring
  // dashboards) that want to read the version programmatically. Parsing the text
  // form ("tradekit 1.1.0  (node 22.16.0)") is fragile; JSON is stable.
  if (flags["json"] === "true") {
    // Iter886: ok:true envelope for parity with every other CLI JSON
    // command. Pre-iter886 this was the lone holdout returning a bare
    // object — agents iterating `commands.map(c => mcp.call(c).ok)` had
    // to special-case version. Pure additive: existing readers of
    // `.tradekit` / `.node` / `.platform` / `.arch` keep working.
    printJson({
      ok: true,
      tradekit: version,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    });
    return;
  }
  console.log(`tradekit ${version}  (node ${process.versions.node})`);
}

// ── doctor ───────────────────────────────────────────────────

export async function doctorCommand(flags: Record<string, string>) {
  const { runDoctor, formatDoctorResults } = await import("../doctor.js");
  const cfgForChains = loadConfig();
  // Iter261: parseChainsFlag now handles "all" centrally. Previously this command had
  // its own pre-expansion to work around parseChainsFlag rejecting "all" as unknown
  // (iter211). Now it Just Works for every --chains-aware command (gas, holdings,
  // doctor) without duplication.
  const allChains = [...listChains(), ...Object.keys(cfgForChains.chains)];
  const chains = parseChainsFlag(flags["chains"], allChains);
  // Optional: when --pass or WALLET_PASS is provided, doctor will attempt to decrypt
  // the keystore. Stays opt-in so the no-secrets health-check path keeps working.
  const walletPass = flags["pass"] ?? process.env.WALLET_PASS;
  const logger = makeCliLogger(flags);
  try {
    const { results, criticalFailures, timestamp, elapsedMs } = await runDoctor({ chains, walletPass, logger });
    const warnCount = results.filter((r) => r.severity === "warn").length;
    const okCount = results.filter((r) => r.severity === "ok").length;
    // `--strict` (or `--strict=true`) makes warnings also non-zero. Useful in CI pipelines
    // where "RPC degraded" or "empty config shell" should fail the gate, not just inform.
    const strict = flags["strict"] === "true" || flags["strict"] === "";
    const ok = criticalFailures === 0 && (!strict || warnCount === 0);
    // Iter752: --quiet filters output to non-ok rows. Parallel to iter734
    // health --quiet (which filters nextActions to severity=critical). The
    // SUMMARY counts remain authoritative (computed BEFORE filtering) so
    // monitoring scripts comparing `summary.ok/warn/fail` numbers see no
    // change; only the rendered results[] list shrinks. Useful for
    // cron-tail dashboards where ok rows are noise.
    const quiet = flags["quiet"] === "true" || flags["quiet"] === "";
    const filteredResults = quiet
      ? results.filter((r) => r.severity !== "ok")
      : results;
    // Iter787: worst-bucket severity derived from the result counts. Lets
    // dashboards branch on one string ("doctor.severity === 'fail'") instead
    // of computing from summary.fail > 0 / warn > 0. Symmetric with iter786
    // health.severity. Priority order: fail > warn > ok (matches the doctor
    // CheckSeverity union ordering used in checkResult.severity).
    const severity: "ok" | "warn" | "fail" =
      criticalFailures > 0 ? "fail" : warnCount > 0 ? "warn" : "ok";

    if (flags["json"] === "true") {
      // Summary first so monitoring/Prometheus scripts can read severity counts at
      // /api/doctor-style endpoints without walking `results`.
      // Iter395: include tradekit + node version so operators comparing doctor reports
      // across deployments / over time can attribute differences to a version bump
      // versus an environmental change. Matches the iter393 /api/status shape.
      // Iter433: import was dynamic; hoisted to top-level static import.
      // Iter825: pre-filter the non-ok checks into a separate list. Dashboards
      // rendering "what's broken" branch on this field without iterating
      // results[]. Filter runs over the UNFILTERED results so the list is
      // accurate even under --quiet (which only affects the rendered
      // `results` field for text mode parity).
      const failedChecks = results.filter((r) => r.severity !== "ok");
      printJson({
        ok,
        timestamp,
        elapsedMs,
        version: { tradekit: tradekitVersion(), node: process.versions.node },
        summary: { ok: okCount, warn: warnCount, fail: criticalFailures },
        severity,
        strict,
        failedChecks,
        results: filteredResults,
      });
    } else {
      // Iter399: include tradekit version in the text-mode banner too. JSON mode
      // already exposes it (iter395); text mode forced operators to mentally combine
      // doctor + version. One line cost; matches the iter396 server-startup banner
      // ("tradekit X.Y.Z, node A.B.C") format so output looks consistent across
      // surfaces.
      // Iter433: import was dynamic; hoisted to top-level static import.
      // Iter817: severity badge — parity with iter808-816. Reads iter787
      // severity (ok/warn/fail). Operators see worst-bucket status above
      // the per-check icons.
      const DOCTOR_BADGE: Record<typeof severity, string> = {
        ok: "🟢 OK  ",
        warn: "🟡 WARN",
        fail: "🔴 FAIL",
      };
      // Iter847: --summary prints a cron/Slack-friendly single-liner. Parallel
      // to iter846 health --summary. Includes severity + counts + top 2 failed
      // check names (when present) so the alert subject communicates not just
      // "doctor failing" but WHICH checks. Skips the multi-row table entirely.
      if (flags["summary"] === "true" || flags["summary"] === "") {
        const parts: string[] = [`${okCount} ok`, `${warnCount} warn`, `${criticalFailures} fail`];
        if (criticalFailures > 0 || warnCount > 0) {
          const failed = results.filter((r) => r.severity !== "ok").slice(0, 2).map((r) => r.name);
          parts.push(`top: ${failed.join(", ")}`);
        }
        parts.push(timestamp);
        // Iter908: append elapsed parens for parity with health/verify/reconcile/
        // sync --summary lines. Uses the new iter908 runDoctor elapsedMs field.
        const elapsed = elapsedMs != null ? `  (${(elapsedMs / 1000).toFixed(1)}s)` : "";
        console.log(`${DOCTOR_BADGE[severity]}  tradekit doctor · ${parts.join(" · ")}${elapsed}`);
      } else {
        console.log(`${DOCTOR_BADGE[severity]}  tradekit health check  (tradekit ${tradekitVersion()})`);
        console.log("");
        if (quiet && filteredResults.length === 0) {
          // All checks ok under --quiet → render an honest one-liner instead of
          // an empty body that looks broken.
          console.log("  (all checks ok — --quiet suppressed details)");
        } else {
          console.log(formatDoctorResults(filteredResults, { verbose: flags["verbose"] === "true" }));
        }
        console.log("");
        console.log(`${okCount} ok · ${warnCount} warn · ${criticalFailures} fail${strict && warnCount > 0 ? " (strict: warnings count as failures)" : ""}`);
      }
    }
    // Iter351: process.exitCode (not process.exit) so main()'s success-audit block in
    // index.ts still runs before the process drains. Pre-iter351 a doctor run that
    // found critical failures (or --strict + warnings) jumped straight to exit, skipping
    // the audit insert — operators querying audit_log saw rows for healthy runs but
    // not unhealthy ones. Misleading. process.exitCode sets the exit code for when the
    // event loop empties; finally + main()'s downstream code still runs.
    if (!ok) process.exitCode = 1;
  } finally {
    logger.close();
  }
}

// ── reconcile ────────────────────────────────────────────────

export async function reconcileCommand(flags: Record<string, string>) {
  const config = loadConfig();
  // Iter286+iter287: validate --chain via the shared assertKnownChain helper. Pre-iter286
  // a typo silently filtered to zero rows; pre-iter287 the check was duplicated inline.
  assertKnownChain(flags["chain"], config);
  const logger = makeCliLogger(flags);
  try {
    // Iter656: --backfill-all runs all three backfills in sequence. One
    // command for post-upgrade catch-up instead of three.
    if (flags["backfill-all"] !== undefined) {
      const { backfillAll, formatBackfillAllReport } = await import("../reconcile.js");
      const report = await backfillAll({
        config,
        logger,
        chain: flags["chain"],
        account: flags["account"],
      });
      if (flags["json"] === "true") {
        printJson({ ok: true, ...report });
      } else {
        console.log(formatBackfillAllReport(report));
      }
      return;
    }

    // Iter670: --backfill-revert-reasons N walks legacy failed trades that
    // have a block_number captured but NULL revert_reason and persists the
    // iter666 eth_call-replay result. Fourth member of the backfill family.
    if (flags["backfill-revert-reasons"] !== undefined) {
      const rawLimit = flags["backfill-revert-reasons"];
      const limit =
        rawLimit === "" || rawLimit === "true" ? undefined : parseInt(rawLimit, 10);
      if (rawLimit && rawLimit !== "true" && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
        throw new ToolError(
          "INVALID_PARAMS",
          `--backfill-revert-reasons expects a positive integer or no value (default 200). Got "${rawLimit}".`,
        );
      }
      const { backfillRevertReasons, formatBackfillRevertReasonReport } = await import("../reconcile.js");
      const report = await backfillRevertReasons({
        config,
        logger,
        limit,
        chain: flags["chain"],
        account: flags["account"],
      });
      if (flags["json"] === "true") {
        printJson({ ok: true, ...report });
      } else {
        console.log(formatBackfillRevertReasonReport(report));
      }
      return;
    }

    // Iter654: --backfill-gas-usd N walks legacy success swaps and persists
    // gas_cost_usd_at_trade using CoinGecko's historical price endpoint.
    // Symmetric with --backfill-blocks (iter637) + --backfill-slippage (iter643).
    if (flags["backfill-gas-usd"] !== undefined) {
      const rawLimit = flags["backfill-gas-usd"];
      const limit =
        rawLimit === "" || rawLimit === "true" ? undefined : parseInt(rawLimit, 10);
      if (rawLimit && rawLimit !== "true" && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
        throw new ToolError(
          "INVALID_PARAMS",
          `--backfill-gas-usd expects a positive integer or no value (default 200). Got "${rawLimit}".`,
        );
      }
      const { backfillGasUsd, formatBackfillGasUsdReport } = await import("../reconcile.js");
      const report = await backfillGasUsd({
        config,
        logger,
        limit,
        chain: flags["chain"],
        account: flags["account"],
      });
      if (flags["json"] === "true") {
        printJson({ ok: true, ...report });
      } else {
        console.log(formatBackfillGasUsdReport(report));
      }
      return;
    }

    // Iter643: --backfill-slippage N runs iter619 analysis on legacy success
    // swaps and persists realized_slippage_bps. Unlocks iter642 auto-slippage
    // for operators with pre-iter641 history. Symmetric with --backfill-blocks.
    if (flags["backfill-slippage"] !== undefined) {
      const rawLimit = flags["backfill-slippage"];
      const limit =
        rawLimit === "" || rawLimit === "true" ? undefined : parseInt(rawLimit, 10);
      if (rawLimit && rawLimit !== "true" && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
        throw new ToolError(
          "INVALID_PARAMS",
          `--backfill-slippage expects a positive integer or no value (default 200). Got "${rawLimit}".`,
        );
      }
      const { backfillRealizedSlippage, formatBackfillSlippageReport } = await import("../reconcile.js");
      const report = await backfillRealizedSlippage({
        config,
        logger,
        limit,
        chain: flags["chain"],
        account: flags["account"],
      });
      if (flags["json"] === "true") {
        printJson({ ok: true, ...report });
      } else {
        console.log(formatBackfillSlippageReport(report));
      }
      return;
    }

    // Iter637: --backfill-blocks N walks legacy success trades without
    // block_number and fetches receipt.blockNumber from the chain. One-time
    // maintenance for operators with trade history predating iter635.
    if (flags["backfill-blocks"] !== undefined) {
      // Accept --backfill-blocks (no arg, default 500) OR --backfill-blocks N.
      const rawLimit = flags["backfill-blocks"];
      const limit =
        rawLimit === "" || rawLimit === "true" ? undefined : parseInt(rawLimit, 10);
      if (rawLimit && rawLimit !== "true" && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
        throw new ToolError(
          "INVALID_PARAMS",
          `--backfill-blocks expects a positive integer or no value (default 500). Got "${rawLimit}".`,
        );
      }
      const { backfillBlockNumbers, formatBackfillBlocksReport } = await import("../reconcile.js");
      const report = await backfillBlockNumbers({
        config,
        logger,
        limit,
        chain: flags["chain"],
        account: flags["account"],
      });
      if (flags["json"] === "true") {
        printJson({ ok: true, ...report });
      } else {
        console.log(formatBackfillBlocksReport(report));
      }
      return;
    }

    // Iter628: --verify-recent N re-checks recent success trades against the
    // chain to detect reorgs. Distinct from the default pending-trade reconcile
    // — they touch different rows so we run as a separate path.
    if (flags["verify-recent"]) {
      const limit = parseInt(flags["verify-recent"], 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new ToolError(
          "INVALID_PARAMS",
          `--verify-recent expects a positive integer, got "${flags["verify-recent"]}".`,
        );
      }
      const { verifyRecentSuccess, formatVerifyRecentReport } = await import("../reconcile.js");
      const report = await verifyRecentSuccess({
        config,
        logger,
        limit,
        chain: flags["chain"],
        account: flags["account"],
        // --auto-mark promotes reorg_failed suspects to status=failed. Default
        // off (conservative — operator decides).
        autoMark: flags["auto-mark"] === "true",
        // Iter635: skip rows buried > N blocks deep. Default 256.
        maxReorgDepth: flags["max-reorg-depth"]
          ? parseInt(flags["max-reorg-depth"], 10)
          : undefined,
      });
      if (flags["json"] === "true") {
        printJson({ ok: true, ...report });
      } else {
        console.log(formatVerifyRecentReport(report));
        if (report.suspects.length > 0 && !flags["auto-mark"]) {
          console.log("");
          console.log("(Suspects flagged but DB not mutated — re-run with --auto-mark to promote reorg_failed → failed.)");
        }
      }
      return;
    }

    // Iter751: default pending sweep supports --watch. Backfill/verify modes
    // fall through their own early returns above and don't reach here; --watch
    // there would loop one-shot catch-up operations and waste RPC budget.
    if (flags["watch"]) {
      // Logger lifecycle is per-iteration inside reconcilePendingOnce.
      logger.close();
      await withWatch(flags, () => reconcilePendingOnce(flags, config));
      return;
    }
    await reconcilePendingOnce(flags, config, logger);
  } finally {
    logger.close();
  }
}

/**
 * Iter751: extracted default pending-sweep so reconcileCommand can wrap it
 * via withWatch. Accepts an optional pre-made logger so the non-watch path
 * keeps reusing the outer logger (no double-create); watch path creates a
 * fresh logger per tick.
 */
async function reconcilePendingOnce(
  flags: Record<string, string>,
  config: ReturnType<typeof loadConfig>,
  externalLogger?: ReturnType<typeof makeCliLogger>,
) {
  const logger = externalLogger ?? makeCliLogger(flags);
  try {
    const { reconcilePending, formatReconcileReport } = await import("../reconcile.js");
    const report = await reconcilePending({
      config,
      logger,
      chain: flags["chain"],
      account: flags["account"],
    });
    if (flags["json"] === "true") {
      // Iter446: spread under `ok: true` envelope for parity with iter422/431/432/445.
      // Additive — every existing ReconcileReport field stays at top level.
      printJson({ ok: true, ...report });
    } else if (flags["summary"] === "true" || flags["summary"] === "") {
      // Iter848: cron/Slack-friendly single-liner. Parallel to iter846/847
      // health/doctor/verify --summary. Empty-clean case still emits a one-
      // liner so cron-tail dashboards see "OK · scanned=0" rather than the
      // multi-line empty banner.
      const badge = report.severity === "ok" ? "🟢 OK  " : "🟡 WARN";
      // Iter902: parens form for elapsed, matching verify/sync convention.
      // Pre-iter902 reconcile alone used the `· 0.1s` separator form; now
      // all 3 elapsed-bearing summaries use `(Ns)`.
      const elapsed = report.elapsedMs != null
        ? `  (${(report.elapsedMs / 1000).toFixed(1)}s)`
        : "";
      const parts: string[] = [`scanned=${report.scanned}`];
      if (report.scanned > 0) {
        parts.push(`ok=${report.resolvedSuccess}`);
        parts.push(`fail=${report.resolvedFailed}`);
        parts.push(`pending=${report.stillPending}`);
      }
      if (report.errors.length > 0) parts.push(`errors=${report.errors.length}`);
      // Iter901: append ISO timestamp for consistency with health/doctor/
      // pending --summary lines.
      parts.push(new Date().toISOString());
      console.log(`${badge}  tradekit reconcile · ${parts.join(" · ")}${elapsed}`);
    } else {
      console.log(formatReconcileReport(report));
    }
  } finally {
    // Only close when WE created it. The outer reconcileCommand finally-block
    // closes its own logger on the non-watch path.
    if (!externalLogger) logger.close();
  }
}

// ── pending (iter622) ────────────────────────────────────────
//
// `tradekit pending` — diagnose every pending trade and recommend an action.
// Pre-iter622 an operator with stuck trades knew the hash + that it was
// pending but had to manually decide why. This pipeline pulls the same
// triage info etherscan + a nonce calculator + a gas-watcher would surface,
// and emits a structured verdict per tx.
//
// Modes:
//   - No filter: every pending trade across all chains.
//   - --chain X / --account Y / --tx-hash <hash>: narrow the scope.
//
// Per-row failure is tolerated — RPC outages on one chain don't break the
// list. The diagnosis carries enough fields that JSON consumers can branch
// (action ∈ wait/speedup/speedup_high/cancel_or_speedup_earlier/...).

export async function pendingCommand(flags: Record<string, string>) {
  // Iter753: --watch support. Pending diagnostics is naturally re-run-friendly
  // — gas market changes, nonces advance, txs confirm/drop. Operators chasing
  // a stuck tx want to see the verdict evolve in real time. Each tick runs
  // pendingCommandOnce which builds its own logger so log rotation works.
  await withWatch(flags, () => pendingCommandOnce(flags));
}

async function pendingCommandOnce(flags: Record<string, string>) {
  // Iter909: wall-clock elapsed for --summary parity with the 5 other cron
  // commands (health/doctor/verify/reconcile/sync). Pending runs N per-tx
  // RPC diagnoses sequentially with a wallet-cache; tracking the total time
  // lets operators tailing cron logs spot performance regression in the
  // diagnose loop (e.g. one chain's RPC degraded).
  const t0 = Date.now();
  const config = loadConfig();
  assertKnownChain(flags["chain"], config);
  const logger = makeCliLogger(flags);
  try {
    const { pendingTrades } = await import("../db.js");
    const { diagnosePendingTx } = await import("../pendingDiagnostics.js");
    const { loadReadOnlyWallet } = await import("../wallet.js");
    const { resolveProfile } = await import("../config.js");

    let rows = pendingTrades({ chain: flags["chain"], account: flags["account"] });
    if (flags["tx-hash"]) {
      rows = rows.filter((r) => r.tx_hash.toLowerCase() === flags["tx-hash"].toLowerCase());
    }

    if (rows.length === 0) {
      const elapsedMs = Date.now() - t0;
      if (flags["json"] === "true") {
        printJson({ ok: true, count: 0, diagnoses: [], elapsedMs });
        return;
      }
      // Iter899: --summary one-liner parity with health/doctor/verify/reconcile/
      // sync. Empty-clean case still emits a digest so cron-tail dashboards
      // see "0 pending" rather than the multi-line "No pending trades…" line.
      if (flags["summary"] === "true" || flags["summary"] === "") {
        // Iter909: append elapsed parens for full cron --summary parity.
        const elapsed = `  (${(elapsedMs / 1000).toFixed(1)}s)`;
        console.log(`🟢 OK    tradekit pending · 0 pending · ${new Date().toISOString()}${elapsed}`);
        return;
      }
      console.log("No pending trades to diagnose.");
      return;
    }

    // Cache (chain → wallet) so we don't reconstruct the public client per row.
    const walletByChain = new Map<string, ReturnType<typeof loadReadOnlyWallet>>();
    const diagnoses = [];
    for (const row of rows) {
      try {
        let wallet = walletByChain.get(row.chain);
        if (!wallet) {
          const profile = resolveProfile(row.chain, config);
          const extraRpcs = config.chains[row.chain]?.rpcs ?? [];
          wallet = loadReadOnlyWallet(profile, extraRpcs, row.account);
          walletByChain.set(row.chain, wallet);
        }
        const profile = resolveProfile(row.chain, config);
        const diagnosis = await diagnosePendingTx({
          row,
          walletAddress: wallet.account.address,
          publicClient: wallet.publicClient,
          profile,
          logger,
        });
        diagnoses.push(diagnosis);
      } catch (e) {
        // Best-effort: skip and log. Keep going so one bad chain doesn't kill the table.
        logger.warn(`pending: diagnosis failed for ${row.tx_hash} on ${row.chain}: ${(e as Error).message}`);
      }
    }

    // Iter789: pre-compute by-action counts so dashboards / agents don't
    // iterate diagnoses[] to learn the action mix. Symmetric with iter766
    // recent_trades / iter779 audit / iter780 allowances summary pattern.
    // Always-present zero baseline for every PendingAction key so consumers
    // don't need presence checks. Sum across buckets === count.
    const byAction: Record<string, number> = {
      wait: 0,
      speedup: 0,
      speedup_high: 0,
      cancel_or_speedup_earlier: 0,
      investigate_stale: 0,
      wait_and_recheck: 0,
      unknown: 0,
    };
    for (const d of diagnoses) {
      if (d.action in byAction) byAction[d.action]++;
      else byAction.unknown++;
    }
    const summary = { byAction };

    if (flags["json"] === "true") {
      // Iter909: include elapsedMs (wall-clock incl. per-tx RPC roundtrips).
      printJson({ ok: true, count: diagnoses.length, summary, diagnoses, elapsedMs: Date.now() - t0 });
      return;
    }

    // Iter814: severity badge. Same actionable-verdict set as iter757
    // --strict — derives the same signal both surfaces use. Empty path
    // earlier already returned with "No pending trades to diagnose."; here
    // we only reach when count > 0.
    const ACTIONABLE_VERDICTS = new Set([
      "speedup",
      "speedup_high",
      "cancel_or_speedup_earlier",
      "investigate_stale",
    ]);
    const pendingBadge = diagnoses.some((d) => ACTIONABLE_VERDICTS.has(d.action))
      ? "🟡 WARN"
      : "🟢 OK  ";
    // Iter899: --summary cron/Slack-friendly single-liner. Parallel to iter846/
    // 847/848. Uses the iter789 byAction pre-aggregation to surface the
    // verdict mix on the same line (e.g. "3 speedup, 1 cancel, 4 wait").
    if (flags["summary"] === "true" || flags["summary"] === "") {
      const nonZero = Object.entries(byAction).filter(([, n]) => n > 0);
      const mix = nonZero.length > 0
        ? nonZero.map(([k, n]) => `${n} ${k}`).join(", ")
        : "";
      const parts: string[] = [`${diagnoses.length} pending`];
      if (mix) parts.push(mix);
      parts.push(new Date().toISOString());
      // Iter909: append elapsed parens for full cron --summary parity.
      const elapsed = `  (${((Date.now() - t0) / 1000).toFixed(1)}s)`;
      console.log(`${pendingBadge}  tradekit pending · ${parts.join(" · ")}${elapsed}`);
      return;
    }
    // Text: header + one block per tx with the verdict.
    console.log(`${pendingBadge}  Pending trade diagnostics — ${diagnoses.length} tx${diagnoses.length === 1 ? "" : "es"}:`);
    // Iter790: surface the iter789 byAction summary as a header line so
    // operators see verdict mix at-a-glance without scrolling per-tx blocks.
    // Skipped when count <= 1 (the per-tx block already tells the whole
    // story). Mirrors iter784 health header summary discipline. Only
    // non-zero buckets are listed for compactness — the JSON output carries
    // every bucket for consumers needing the zero-baseline shape.
    if (diagnoses.length > 1) {
      const nonZero = Object.entries(byAction).filter(([, n]) => n > 0);
      if (nonZero.length > 0) {
        const bits = nonZero.map(([k, n]) => `${n} ${k}`).join(", ");
        console.log(`  Mix: ${bits}`);
      }
    }
    console.log("");
    for (const d of diagnoses) {
      const badge = actionBadge(d.action);
      console.log(`  ${badge}  ${d.txHash}`);
      console.log(`     Chain:        ${d.chain}, account=${d.account}`);
      console.log(`     Age:          ${formatAge(d.ageSeconds)} (${d.ageBucket})`);
      if (d.txNonce != null && d.walletNonce != null) {
        console.log(`     Nonce:        tx=${d.txNonce}, wallet=${d.walletNonce} (${d.nonceState})`);
      }
      if (d.maxFeeGwei != null && d.currentBaseFeeGwei != null) {
        console.log(`     Gas:          maxFee=${d.maxFeeGwei} gwei, base=${d.currentBaseFeeGwei} gwei (${d.gasState})`);
      }
      console.log(`     Verdict:      ${d.action}`);
      console.log(`     ${d.message}`);
      if (d.command) {
        console.log(`     → ${d.command}`);
      }
      console.log("");
    }

    // Iter757: --strict exit-code surface. Closes the cron-strict pentagon
    // (doctor, health, trades sync, pnl, pending). Triggers on actionable
    // verdicts only — operator-attention required:
    //   - speedup / speedup_high  : gas needs bumping
    //   - cancel_or_speedup_earlier : an earlier-nonce tx is blocking
    //   - investigate_stale       : may have already landed under different hash
    // The 'wait' / 'wait_and_recheck' / 'unknown' verdicts DON'T trigger —
    // those are normal lifecycle states + zero-information states; --strict
    // there would alert on every pending row and defeat the signal.
    const strict = flags["strict"] === "true" || flags["strict"] === "";
    if (strict) {
      const ACTIONABLE = new Set([
        "speedup",
        "speedup_high",
        "cancel_or_speedup_earlier",
        "investigate_stale",
      ]);
      if (diagnoses.some((d) => ACTIONABLE.has(d.action))) {
        // process.exitCode (not process.exit) — main()'s audit-insert finally
        // block still runs (iter351 pattern).
        process.exitCode = 1;
      }
    }
  } finally {
    logger.close();
  }
}

function actionBadge(action: string): string {
  switch (action) {
    case "wait":
    case "wait_and_recheck":
      return "🟢 WAIT  ";
    case "speedup":
      return "🟡 SPEED ";
    case "speedup_high":
      return "🔴 BUMP! ";
    case "cancel_or_speedup_earlier":
      return "🔴 BLOCK ";
    case "investigate_stale":
      return "🟣 STALE ";
    default:
      return "❓ UNKWN ";
  }
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

// ── tx (iter603) ─────────────────────────────────────────────
// `tradekit tx <action> <hash>` — stuck-tx recovery.
//
// Actions:
//   speedup <hash>             — re-send the original tx at the same nonce with higher gas
//   cancel  <hash> --yes       — replace with a zero-value self-send at same nonce + higher gas
//
// Both honor --chain (defaults to active), --multiplier (defaults to 1.2),
// --pass / WALLET_PASS (required, signs the replacement), and --json for
// scripted output.
//
// Iter603: cancel requires --yes (CLI parity with MCP's `confirm: true`) since
// the original tx's intent is dropped — same opt-in discipline iter106 / iter355
// applied to other destructive paths.

export async function txCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  const valid = ["speedup", "cancel"];
  if (!action) throw subcommandError("tx", action, valid);
  if (!valid.includes(action)) throw subcommandError("tx", action, valid);

  const txHash = positional[1]; // positional[0] is the action itself in the iter dispatch
  if (!txHash) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Usage: tradekit tx ${action} <txHash> [--chain <name>] [--multiplier <n>] [--pass <password>]${action === "cancel" ? " --yes" : ""}.`,
      { details: { action, reason: "missing_tx_hash" } },
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Invalid txHash "${txHash}" — expected 0x-prefixed 64 hex chars (32-byte transaction hash).`,
      { details: { providedTxHash: txHash, reason: "bad_tx_hash_shape" } },
    );
  }

  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  const multiplier = parseFloatFlag(flags["multiplier"], "--multiplier", { min: 1.1, max: 10 }) ?? 1.2;
  const logger = makeCliLogger(flags);

  try {
    if (action === "cancel" && flags["yes"] !== "true") {
      // Pre-iter603 there was no cancel; iter603 introduces it with the same
      // --yes discipline as other destructive ops. The check is up-front, BEFORE
      // password prompt, so an operator who forgot --yes doesn't waste a
      // password type.
      console.error(
        `Cancel will REPLACE tx ${txHash} with a zero-value self-send at the same nonce. The original swap/transfer/approve will NOT execute. Pass --yes to confirm.`,
      );
      // Iter603: confirm via TTY prompt if interactive (matches the iter453
      // mnemonic-overwrite UX), otherwise just refuse.
      if (process.stdin.isTTY) {
        const answer = await prompt("Proceed with cancel? Type 'cancel' to confirm: ");
        if (answer.trim().toLowerCase() !== "cancel") {
          console.log("Aborted.");
          return;
        }
      } else {
        process.exitCode = 1;
        throw new ToolError("INVALID_PARAMS", "Cancel refused: --yes flag required for non-interactive use.", {
          details: { action: "cancel", reason: "yes_required" },
        });
      }
    }

    const pass = await requirePassword(flags);
    const { loadWallet } = await import("../wallet.js");
    const wallet = await loadWallet(pass, profile, config.chains[profile.name]?.rpcs ?? [], logger);
    const { speedupTx, cancelTx } = await import("../txOps.js");
    const txCtx = {
      publicClient: wallet.publicClient,
      walletClient: wallet.walletClient,
      profile,
      logger,
    };

    const result =
      action === "speedup"
        ? await speedupTx({ txHash: txHash as `0x${string}`, multiplier, ctx: txCtx })
        : await cancelTx({ txHash: txHash as `0x${string}`, multiplier, ctx: txCtx });

    if (flags["json"] === "true") {
      printJson({ ok: true, ...result });
      return;
    }

    // Text output: one-line header + a few key fields.
    const newH = "newHash" in result ? result.newHash : result.cancelHash;
    console.log(`${result.action === "speedup" ? "Speedup" : "Cancel"} sent: ${newH}`);
    console.log(`  Original: ${result.originalHash} (nonce ${result.nonce})`);
    console.log(
      `  Gas:      ${result.originalGas.maxFeePerGas} → ${result.newGas.maxFeePerGas} gwei (×${result.multiplier})`,
    );
    if (result.explorerUrl) console.log(`  ${result.explorerUrl}`);
  } finally {
    logger.close();
  }
}
