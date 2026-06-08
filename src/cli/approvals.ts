// Approval CLI commands. Lifted from index.ts so the dispatcher stays small. Logic is
// byte-for-byte identical to the previous inline definitions.

import { parseUnits, maxUint256, type Address } from "viem";
import { loadConfig, resolveProfile } from "../config.js";
import { loadWallet, loadReadOnlyWallet, activeWalletAddress, getKeystoreAddress } from "../wallet.js";
import { resolveToken, unknownTokenError } from "../chains.js";
import { listAllowances, approveToken, revokeToken, planRevokeAll, executeRevokeAll } from "../approvals.js";
import { formatUsd } from "../holdings.js";
import { ToolError } from "../errors.js";

// Iter292: assertAddress moved to chains.ts as assertAddressEIP55 (shared with MCP
// security-tools.ts which had a near-identical copy). Same two-step shape + checksum
// pattern; this file just re-exports under the original local name for call-site stability.
import { assertAddressEIP55 } from "../chains.js";
const assertAddress = assertAddressEIP55;
import { getToken } from "../tokens.js";
import { makeCliLogger, printJson, prompt, requirePassword } from "./helpers.js";

export async function allowancesCommand(flags: Record<string, string>, positional: string[]) {
  // Subcommand: `allowances revoke-all` for bulk security cleanup.
  if (positional[1] === "revoke-all") {
    return await allowancesRevokeAll(flags);
  }
  // Iter606: `allowances audit` — score every standing approval, surface
  // dangerous ones first. Read-only (same address-lookup pattern as list).
  if (positional[1] === "audit") {
    return await allowancesAudit(flags);
  }
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  const logger = makeCliLogger(flags);
  try {
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    // Iter384: listing standing approvals is read-only — no signing required, so no
    // password prompt. Pre-iter384 `tradekit allowances` always called requirePassword
    // + loadWallet, dropping into the keystore decrypt path even though the operator
    // only wanted to see what was approved. Same iter263 address-only-lookup pattern
    // that holdings has used since iter263: get the owner address from accounts.json
    // (HD label or default-active) or getKeystoreAddress() (single-key); both store
    // the address, only signing needs the private key.
    const { listAccounts } = await import("../accounts.js");
    let owner: `0x${string}` | undefined;
    if (flags["account"]) {
      const file = listAccounts();
      const entry = file?.accounts.find((a) => a.label === flags["account"]);
      if (entry) {
        owner = entry.address;
      } else if (flags["account"].toLowerCase() === "keystore") {
        owner = getKeystoreAddress() ?? undefined;
        if (!owner) {
          throw new ToolError(
            "WALLET_NOT_FOUND",
            `--account keystore requested but no single-key keystore exists. Run \`tradekit wallet create\` first.`,
            { details: { requestedAccount: "keystore", reason: "keystore_requested_but_absent" } },
          );
        }
      } else {
        const { unknownAccountError } = await import("../accounts.js");
        const knownLabels = [
          ...(file?.accounts ?? []).map((a) => a.label),
          ...(getKeystoreAddress() ? ["keystore"] : []),
        ];
        throw unknownAccountError(flags["account"], knownLabels);
      }
    } else {
      // Default to the active wallet address. Iter511: route through activeWalletAddress
      // — the iter499 gate makes the orphan-accounts.json case fall back to keystore
      // (matching loadWallet), so the allowances list scans the address that signing
      // operations actually use. Pre-iter511 this read activeAccountEntry directly and
      // returned the orphan HD address in that case — leaking approvals from a
      // no-longer-derivable address while the operator's signing wallet is the keystore.
      owner = activeWalletAddress() as `0x${string}` | undefined;
      // Iter546: paste-ready CLI form parity with iter545's walletView fix.
      // `wallet create` was the bare command name; now both options carry the
      // `tradekit` prefix + recommends `tradekit init` for first-time setup.
      if (!owner) {
        throw new ToolError(
          "WALLET_NOT_FOUND",
          "No wallet found. Run `tradekit init` for a guided setup, or `tradekit wallet create` (single-key) / `tradekit account create-mnemonic` (HD) directly.",
          { details: { reason: "no_wallet" } },
        );
      }
    }
    // Build a minimal publicClient — no walletClient, no decryption.
    const { createPublicClient } = await import("viem");
    const { makeTransport } = await import("../chains.js");
    const publicClient = createPublicClient({
      chain: profile.viemChain,
      transport: makeTransport(profile, extraRpcs),
    });
    const rows = await listAllowances(
      { publicClient: publicClient as never, profile, owner, logger },
      {},
    );
    if (flags["json"] === "true") {
      printJson(rows);
      return;
    }
    if (rows.length === 0) {
      console.log(`No non-zero allowances on ${chainName}.`);
      return;
    }
    console.log(`Allowances on ${chainName} for ${owner}:`);
    console.log("");
    console.log("  Symbol      Allowance        Spender                                       Label");
    console.log("  " + "-".repeat(106));
    for (const r of rows) {
      console.log(`  ${r.symbol.padEnd(11)} ${r.display.padEnd(16)} ${r.spender}  ${r.spenderLabel ?? ""}`);
    }
    // Iter712: risk-summary footer. Counts:
    //   - infinite: allowance >= 2^255 (same threshold as iter606 audit)
    //   - unknownSpender: spenderLabel is null (not a curated router via
    //     iter681's defaultSpenders). The audit command (`allowances audit`)
    //     has the full classifier, but for the quick list-view signal a
    //     simple "label present?" check is the right granularity.
    if (rows.length >= 2) {
      const INFINITE_THRESHOLD = 1n << 255n;
      const infiniteCount = rows.filter((r) => r.allowance >= INFINITE_THRESHOLD).length;
      const unknownSpenderCount = rows.filter((r) => r.spenderLabel == null).length;
      const bits: string[] = [];
      if (infiniteCount > 0) bits.push(`${infiniteCount} infinite`);
      if (unknownSpenderCount > 0) bits.push(`${unknownSpenderCount} to unknown spender`);
      const tail = bits.length > 0 ? ` — ${bits.join(", ")}` : "";
      console.log("");
      console.log(`  ${rows.length} allowance${rows.length === 1 ? "" : "s"}${tail}`);
      if (infiniteCount > 0 || unknownSpenderCount > 0) {
        console.log(`  Run \`tradekit allowances audit\` for risk classification.`);
      }
    }
  } finally {
    logger.close();
  }
}

/**
 * Iter606: `tradekit allowances audit` — score every standing approval, surface
 * dangerous ones first. Read-only (uses the same loadReadOnlyWallet path as
 * `allowances list`, no password prompt). Compatible with --json and --usd-threshold.
 */
export async function allowancesAudit(flags: Record<string, string>) {
  const config = loadConfig();
  const logger = makeCliLogger(flags);
  try {
    // Iter632: --chains a,b,c | --chains all routes to the multi-chain
    // aggregate. Single-chain path (--chain X or default active chain) stays
    // unchanged — same code path as pre-iter632.
    if (flags["chains"]) {
      return await allowancesAuditMultiChain(flags, config, logger);
    }
    // Iter749: wall-clock timer encompassing all RPC phases (listAllowances,
    // price fan-out, optional freshness scan) plus the pure scoring step.
    const t0 = Date.now();
    const chainName = flags["chain"] ?? config.activeChain;
    const profile = resolveProfile(chainName, config);
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    const wallet = loadReadOnlyWallet(profile, extraRpcs, flags["account"]);
    const rows = await listAllowances(
      { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger },
      {},
    );

    // Build the token-price map IN PARALLEL — one getCurrentPrice per unique
    // token. The audit core treats prices as injected so this stays pure.
    const { getCurrentPrice } = await import("../price.js");
    const uniqueTokens = Array.from(new Set(rows.map((r) => r.token.toLowerCase())));
    const priceResults = await Promise.all(
      uniqueTokens.map(async (t) => {
        try {
          const p = await getCurrentPrice(t as Address, logger);
          return { token: t, price: p };
        } catch {
          return { token: t, price: null };
        }
      }),
    );
    const tokenPrices = new Map<string, number>();
    for (const r of priceResults) {
      if (r.price != null) tokenPrices.set(r.token, r.price);
    }

    const { KNOWN_ROUTERS } = await import("../routers.js");
    const knownRouters = new Set(KNOWN_ROUTERS.map((r) => r.address.toLowerCase()));
    const usdThreshold = flags["usd-threshold"]
      ? parseFloat(flags["usd-threshold"])
      : undefined;
    const staleDays = flags["stale-days"] ? parseInt(flags["stale-days"], 10) : undefined;

    // Iter617: optional freshness scan. When --lookback-blocks N is supplied
    // (or --lookback-days N — converted to a block range via the chain's avg
    // block time below), we scan recent Approval events to age each pair.
    // Skipped by default because the RPC cost on big chains is non-trivial.
    let freshness: Map<string, { timestamp: string | null; blockNumber: number; txHash: string }> | undefined;
    const lookbackBlocks = flags["lookback-blocks"]
      ? BigInt(flags["lookback-blocks"])
      : undefined;
    if (lookbackBlocks != null && rows.length > 0) {
      const { scanApprovalFreshness } = await import("../approvalFreshness.js");
      const latest = await wallet.publicClient.getBlockNumber();
      const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
      const report = await scanApprovalFreshness({
        publicClient: wallet.publicClient,
        profile,
        owner: wallet.account.address,
        fromBlock,
        toBlock: latest,
        logger,
      });
      freshness = new Map();
      for (const e of report.entries) {
        freshness.set(`${e.token}:${e.spender}`, {
          timestamp: e.timestamp ?? null,
          blockNumber: e.blockNumber,
          txHash: e.txHash,
        });
      }
      logger.info(
        `Freshness scan: ${report.rawEventCount} raw events, ${report.entries.length} unique (token, spender) pairs, ${report.chunkErrors.length} chunk failures`,
      );
    }

    const { auditAllowanceList } = await import("../approvalAudit.js");
    const report = auditAllowanceList(rows, {
      chain: chainName,
      config,
      knownRouters,
      tokenPrices,
      usdThreshold,
      owner: wallet.account.address,
      freshness,
      staleDays,
    });
    // Iter749: stamp wall-clock duration before render.
    report.elapsedMs = Date.now() - t0;

    if (flags["json"] === "true") {
      printJson({ ok: true, ...report });
      return;
    }

    // Text mode: counts + per-row table sorted by severity then USD desc.
    // Iter749: elapsedMs suffix parity with iter731 reconcile/pnl.
    const elapsedSuffix = report.elapsedMs != null
      ? `  (${(report.elapsedMs / 1000).toFixed(1)}s)`
      : "";
    // Iter813: severity badge — parity with iter808/812 convention. Audit
    // uses the 3-color scheme matching iter788 severity (ok/warn/critical).
    const AUDIT_BADGE: Record<typeof report.severity, string> = {
      ok: "🟢 OK  ",
      warn: "🟡 WARN",
      critical: "🔴 CRIT",
    };
    console.log(`${AUDIT_BADGE[report.severity]}  Allowance audit on ${chainName} for ${wallet.account.address}:${elapsedSuffix}`);
    console.log("");
    console.log(`  Critical: ${report.counts.critical}`);
    console.log(`  Warn:     ${report.counts.warn}`);
    console.log(`  OK:       ${report.counts.ok}`);
    console.log(`  Total:    ${report.counts.total}`);
    if (report.counts.total === 0) {
      console.log("");
      console.log("(No standing approvals on this chain.)");
      return;
    }
    console.log("");
    // Iter617: include Age column only when freshness was scanned (otherwise the
    // column is all "—" and just adds visual noise).
    const showAge = freshness != null;
    const ageHeader = showAge ? "Age          " : "";
    console.log(`  Sev      Symbol      Allowance        Exposure       ${ageHeader}Spender                                       Findings`);
    console.log("  " + "-".repeat(showAge ? 165 : 150));
    const sevMark = (s: typeof report.allowances[number]["severity"]) =>
      s === "critical" ? "🔴 CRIT" : s === "warn" ? "🟡 WARN" : "🟢 OK  ";
    const { formatAgo } = showAge ? await import("../approvalFreshness.js") : { formatAgo: (_: string) => "" };
    for (const a of report.allowances) {
      const exposure =
        a.usdExposure == null ? "—" : `$${a.usdExposure.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
      const findings = a.findings
        .filter((f) => f.code !== "ok")
        .map((f) => f.code)
        .join(", ") || "ok";
      const ageCol = showAge
        ? (a.grantedAt?.timestamp
            ? formatAgo(a.grantedAt.timestamp).padEnd(13)
            : (a.agedOutOfLookback ? "older window ".padEnd(13) : "—".padEnd(13)))
        : "";
      console.log(
        `  ${sevMark(a.severity)}  ${a.symbol.padEnd(11)} ${a.display.padEnd(16)} ${exposure.padEnd(14)} ${ageCol}${a.spender}  ${findings}`,
      );
    }
    // Iter841: surface iter838 top-3 critical recommendedActions inline.
    // Replaces the prior generic `Cleanup: …` hint with paste-ready,
    // USD-prioritized prose. The structured array was already in the JSON
    // form since iter838 — this exposes it to text-mode operators too.
    if (report.recommendedActions.length > 0) {
      console.log("");
      console.log("Next steps (top critical, by USD exposure):");
      for (const a of report.recommendedActions) {
        console.log(`  → ${a.reason}`);
      }
    } else if (report.counts.warn > 0) {
      // Fallback for warn-only audits (no critical → iter838 leaves the array
      // empty). Generic cleanup hint preserves operator guidance.
      console.log("");
      console.log(
        `Cleanup: \`tradekit allowances revoke-all --spender <addr>\` (or --token) to bulk-revoke matching rows.`,
      );
    }
  } finally {
    logger.close();
  }
}

/**
 * Iter632: cross-chain audit. Fan out audit per chain, aggregate via the
 * iter632 pure aggregator. Per-chain errors land in errors[] without
 * aborting — operators with a flaky RPC on one chain still see the rest.
 *
 * Cheap path: skips freshness scan (which is per-chain expensive). Operators
 * who need freshness across chains run per-chain audits with --lookback-blocks
 * individually.
 */
async function allowancesAuditMultiChain(
  flags: Record<string, string>,
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof makeCliLogger>,
) {
  const { listChains: lc } = await import("../chains.js");
  const { getCurrentPrice } = await import("../price.js");
  const { KNOWN_ROUTERS } = await import("../routers.js");
  const { auditAllowanceList, aggregateMultiChainAudits } = await import("../approvalAudit.js");

  const allChains = [...lc(), ...Object.keys(config.chains)];
  const rawChains = flags["chains"];
  const chains =
    rawChains === "all"
      ? allChains
      : rawChains.split(",").map((s) => s.trim()).filter(Boolean);

  const usdThreshold = flags["usd-threshold"] ? parseFloat(flags["usd-threshold"]) : undefined;
  const knownRouters = new Set(KNOWN_ROUTERS.map((r) => r.address.toLowerCase()));

  const perChainReports = [];
  const errors: Array<{ chain: string; message: string }> = [];

  for (const chainName of chains) {
    // Iter749: per-chain wall clock so each report carries its own elapsedMs.
    // The aggregator below doesn't need a single roll-up — individual entries
    // expose where the time went for cross-chain comparison.
    const tChain = Date.now();
    try {
      const profile = resolveProfile(chainName, config);
      const extraRpcs = config.chains[chainName]?.rpcs ?? [];
      const wallet = loadReadOnlyWallet(profile, extraRpcs, flags["account"]);
      const rows = await listAllowances(
        { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger },
        {},
      );
      if (rows.length === 0) continue;

      const uniqueTokens = Array.from(new Set(rows.map((r) => r.token.toLowerCase())));
      const priceResults = await Promise.all(
        uniqueTokens.map(async (t) => {
          try {
            const p = await getCurrentPrice(t as Address, logger);
            return { token: t, price: p };
          } catch {
            return { token: t, price: null };
          }
        }),
      );
      const tokenPrices = new Map<string, number>();
      for (const r of priceResults) {
        if (r.price != null) tokenPrices.set(r.token, r.price);
      }

      const r = auditAllowanceList(rows, {
        chain: chainName,
        config,
        knownRouters,
        tokenPrices,
        usdThreshold,
        owner: wallet.account.address,
      });
      r.elapsedMs = Date.now() - tChain;
      perChainReports.push(r);
    } catch (e) {
      errors.push({ chain: chainName, message: (e as Error).message });
      logger.warn(`allowances audit: ${chainName} failed: ${(e as Error).message}`);
    }
  }

  const aggregate = aggregateMultiChainAudits({
    perChainReports,
    chainsScanned: chains,
    errors,
  });

  if (flags["json"] === "true") {
    printJson({ ok: true, ...aggregate });
    return;
  }

  // Iter813: severity badge — same scheme as single-chain audit + iter788
  // multi-chain severity (roll-up across all chains).
  const MULTI_BADGE: Record<typeof aggregate.severity, string> = {
    ok: "🟢 OK  ",
    warn: "🟡 WARN",
    critical: "🔴 CRIT",
  };
  console.log(`${MULTI_BADGE[aggregate.severity]}  Cross-chain allowance audit (${aggregate.chains.length}/${aggregate.chainsScanned.length} chains):`);
  console.log("");
  console.log(`  Critical: ${aggregate.counts.critical}`);
  console.log(`  Warn:     ${aggregate.counts.warn}`);
  console.log(`  OK:       ${aggregate.counts.ok}`);
  console.log(`  Total:    ${aggregate.counts.total}`);
  if (aggregate.errors.length > 0) {
    console.log(`  Errors:   ${aggregate.errors.length} chain${aggregate.errors.length === 1 ? "" : "s"} failed`);
    for (const e of aggregate.errors) {
      console.log(`    ✗ ${e.chain}: ${e.message}`);
    }
  }
  if (aggregate.counts.total === 0) {
    console.log("");
    console.log("(No standing approvals across the scanned chains.)");
    return;
  }
  console.log("");
  console.log("  Sev      Chain      Symbol      Allowance        Exposure       Spender                                       Findings");
  console.log("  " + "-".repeat(165));
  const sevMark = (s: "critical" | "warn" | "ok") =>
    s === "critical" ? "🔴 CRIT" : s === "warn" ? "🟡 WARN" : "🟢 OK  ";
  // Cap the cross-chain display at top 50 — biggest risks first. Full list
  // available via --json for scripted consumers.
  for (const a of aggregate.allowances.slice(0, 50)) {
    const exposure =
      a.usdExposure == null ? "—" : `$${a.usdExposure.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    const findings = a.findings
      .filter((f) => f.code !== "ok")
      .map((f) => f.code)
      .join(", ") || "ok";
    console.log(
      `  ${sevMark(a.severity)}  ${a.chain.padEnd(10)} ${a.symbol.padEnd(11)} ${a.display.padEnd(16)} ${exposure.padEnd(14)} ${a.spender}  ${findings}`,
    );
  }
  if (aggregate.allowances.length > 50) {
    console.log(`  … and ${aggregate.allowances.length - 50} more (use --json for the full list)`);
  }
  // Iter841: cross-chain audit also gets the iter838 top-3 critical footer.
  // Aggregator returns the cross-chain top-3 sorted by USD exposure (infinite
  // first). Operators with critical approvals on 5 chains see the 3 most
  // urgent without scanning all 50 displayed rows.
  if (aggregate.recommendedActions.length > 0) {
    console.log("");
    console.log("Next steps (top critical across chains, by USD exposure):");
    for (const a of aggregate.recommendedActions) {
      console.log(`  → ${a.reason}`);
    }
  }
}

/**
 * Bulk-revoke standing approvals — probes the same set as `allowances list`, filters by
 * --spender / --token, simulates (prints plan + exits) or sends one revoke tx per
 * matching approval after a y/N confirmation unless --yes.
 */
export async function allowancesRevokeAll(flags: Record<string, string>) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  // Iter302: validate filter inputs BEFORE prompting for the password. Pre-iter302
  // the iter283 validation ran AFTER requirePassword — operator typing
  // `revoke-all --spender 0xshort` had to enter their password before learning the
  // flag was malformed. Same UX rationale as approveCommand which validates first
  // ("Validate inputs BEFORE prompting for password — typing a password and then
  // learning your spender is malformed is a frustrating UX.").
  if (flags["spender"] && !/^0x[0-9a-fA-F]{40}$/.test(flags["spender"])) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Invalid --spender "${flags["spender"]}" — expected 0x-prefixed 40 hex chars.`,
    );
  }
  // Iter517: extend iter486/488's password-free simulate to revoke-all. The simulate
  // path lists targets via publicClient (no signing) — same situation as quote / transfer
  // --simulate. Pre-iter517 every dry-run still paid a keystore decrypt just to read the
  // active address. With the gate: simulate uses loadReadOnlyWallet (just the public
  // address); real revoke still goes through requirePassword + loadWallet for signing.
  const isSimulateOnly = flags["simulate"] === "true";
  const logger = makeCliLogger(flags);
  try {
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    const wallet = isSimulateOnly
      ? loadReadOnlyWallet(profile, extraRpcs, flags["account"])
      : await loadWallet(await requirePassword(flags), profile, extraRpcs, logger, flags["account"]);
    const wantJson = flags["json"] === "true";

    // Iter604: route through extracted planRevokeAll — same filter semantics,
    // now also runs the gas-affordability pre-check. Pre-iter604 inline logic
    // skipped this so a 20-allowance cleanup could run out of gas at #14.
    const plan = await planRevokeAll(
      { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger },
      { spender: flags["spender"] as Address | undefined, token: flags["token"] },
    );
    const targets = plan.targets;

    if (targets.length === 0) {
      if (wantJson) {
        printJson({ ok: true, action: "noop-empty", chain: chainName, count: 0, timestamp: new Date().toISOString() });
      } else {
        console.log(`No matching approvals to revoke on ${chainName}.`);
      }
      return;
    }

    if (!wantJson) {
      console.log(`Found ${targets.length} approval${targets.length === 1 ? "" : "s"} to revoke on ${chainName}:`);
      console.log("");
      for (const r of targets) {
        console.log(`  ${r.symbol.padEnd(8)} ${r.display.padEnd(16)} → ${r.spenderLabel ?? r.spender}`);
      }
      // Iter604: surface estimated gas cost + affordability in text mode so the
      // operator sees the bulk cost before confirming. plan.estimatedGasUsd is
      // null when price API is down — render only the native amount in that case.
      const gasUsdStr = plan.estimatedGasUsd != null ? ` ≈ ${formatUsd(plan.estimatedGasUsd)}` : "";
      console.log("");
      console.log(`  Estimated total gas: ${plan.estimatedGasNative} ${profile.nativeSymbol}${gasUsdStr}`);
      console.log(`  Wallet balance:      ${plan.walletNativeBalance} ${profile.nativeSymbol}`);
      if (!plan.hasGasFunds) {
        console.log(`  ⚠ INSUFFICIENT NATIVE BALANCE — top up before running.`);
      }
    }

    if (flags["simulate"] === "true") {
      if (wantJson) {
        printJson({
          ok: true,
          action: "simulated",
          chain: chainName,
          count: targets.length,
          targets,
          estimatedGasNative: plan.estimatedGasNative,
          estimatedGasUsd: plan.estimatedGasUsd,
          walletNativeBalance: plan.walletNativeBalance,
          hasGasFunds: plan.hasGasFunds,
          timestamp: new Date().toISOString(),
        });
      } else {
        console.log("");
        console.log(`(--simulate: ${targets.length} revoke tx${targets.length === 1 ? "" : "es"} would be sent.)`);
      }
      return;
    }

    // Iter604: gas-funds gate. Refuses to start a real bulk revoke that the wallet
    // can't afford to finish. Operator can override by topping up native first.
    // The check is informational in --simulate mode (above) but blocking here.
    if (!plan.hasGasFunds) {
      throw new ToolError(
        "INSUFFICIENT_BALANCE",
        `Wallet has ${plan.walletNativeBalance} ${profile.nativeSymbol} but estimated bulk-revoke cost is ${plan.estimatedGasNative} ${profile.nativeSymbol}. Top up native, or use --simulate to preview without sending.`,
        {
          details: {
            balance: plan.walletNativeBalance,
            required: plan.estimatedGasNative,
            symbol: profile.nativeSymbol,
            chain: chainName,
            targetCount: targets.length,
            reason: "bulk_revoke_gas_shortfall",
          },
        },
      );
    }

    if (flags["yes"] !== "true") {
      const answer = await prompt(`\nRevoke all ${targets.length}? (yes/no): `);
      if (answer.toLowerCase() !== "yes") {
        if (wantJson) {
          printJson({
            ok: true,
            action: "aborted",
            chain: chainName,
            wouldRevoke: targets.length,
            targets,
            timestamp: new Date().toISOString(),
          });
        } else {
          console.log("Aborted.");
        }
        return;
      }
    }

    const report = await executeRevokeAll(
      { publicClient: wallet.publicClient, walletClient: wallet.walletClient, profile, logger, config },
      targets,
    );

    if (!wantJson) {
      for (const r of report.results) {
        if (r.status === "success") {
          console.log(`  ✓ ${r.symbol} → ${r.spenderLabel ?? r.spender}  tx=${r.txHash}`);
        } else if (r.status === "failed") {
          console.log(`  ✗ ${r.symbol} → ${r.spenderLabel ?? r.spender}  tx=${r.txHash}  (failed)`);
        } else {
          console.log(`  ✗ ${r.symbol} → ${r.spenderLabel ?? r.spender}  ${r.error}`);
        }
      }
      console.log("");
      const gasNote =
        report.gasNative > 0
          ? `  Gas: ~${report.gasNative.toFixed(6)} ${profile.nativeSymbol}${
              report.gasUsd != null ? ` ≈ ${formatUsd(report.gasUsd)}` : ""
            }`
          : "";
      console.log(`Done: ${report.revoked} revoked, ${report.failed} failed.${gasNote}`);
    } else {
      printJson({ ok: true, ...report, timestamp: new Date().toISOString() });
    }
  } finally {
    logger.close();
  }
}

export async function approveCommand(flags: Record<string, string>, positional: string[]) {
  const token = positional[1];
  const spender = positional[2];
  if (!token || !spender)
    throw new ToolError("INVALID_PARAMS", "Usage: tradekit approve <token> <spender> [--amount <decimal>] [--infinite] [--chain <name>]");
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  // Validate inputs BEFORE prompting for password — typing a password and then learning
  // your spender is malformed is a frustrating UX. resolveToken passes through well-shaped
  // 0x addresses unchanged; symbol misses produce UNKNOWN_TOKEN.
  const tokenAddr = resolveToken(profile, token);
  // Iter353: shared helper from chains.ts surfaces the iter345 "Did you mean" hint.
  if (!tokenAddr) throw unknownTokenError("token", token, profile);
  const spenderAddr = assertAddress("spender", spender);
  const infinite = flags["infinite"] === "true";
  // Iter303: hoist the iter275 explicit-intent check above requirePassword. Pre-iter303
  // `tradekit approve USDC 0xspender` (no --amount, no --infinite) prompted for the
  // password BEFORE rejecting the missing-intent case. Now it fails fast.
  if (!infinite && !flags["amount"]) {
    throw new ToolError(
      "INVALID_PARAMS",
      "approve requires --amount <decimal> OR --infinite. To set the allowance to zero, use `tradekit revoke <token> <spender>` instead.",
    );
  }
  const walletPass = await requirePassword(flags);
  const logger = makeCliLogger(flags);
  try {
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    const wallet = await loadWallet(walletPass, profile, extraRpcs, logger, flags["account"]);
    const meta = await getToken(wallet.publicClient, profile, tokenAddr);
    const amount = infinite
      ? maxUint256
      : parseUnits(flags["amount"], meta.decimals);
    // Iter281: same rounds-to-0 guard as iter280 (trade.ts). User typed
    // --amount 0.0000001 to grant a tiny approval, but parseUnits returns 0n at low
    // decimals — that would skip safety (which treats 0 as a revoke) AND set the
    // allowance to 0 instead of the intended amount. Reject with a clear hint.
    if (!infinite && amount === 0n) {
      const { formatUnits } = await import("viem");
      throw new ToolError(
        "INVALID_PARAMS",
        `--amount "${flags["amount"]}" rounds to 0 raw units at ${meta.decimals} decimals — too small to grant. Use at least the minimum representable amount (${formatUnits(1n, meta.decimals)}). To revoke an existing allowance, use \`tradekit revoke\` instead.`,
      );
    }
    const result = await approveToken(
      { publicClient: wallet.publicClient, walletClient: wallet.walletClient, profile, logger, config },
      {
        token: tokenAddr,
        spender: spenderAddr,
        amount,
        infinite,
        override: flags["force-infinite"] === "true",
      },
    );
    if (flags["json"] === "true") printJson(result);
    else {
      console.log(`APPROVE ${result.status.toUpperCase()}`);
      console.log(`  Token:   ${meta.symbol} (${result.token})`);
      console.log(`  Spender: ${result.spender}`);
      console.log(`  Amount:  ${infinite ? "infinite" : flags["amount"] ?? "0"}`);
      const gasUsdNote = result.gasCostUsd != null ? ` ≈ ${formatUsd(result.gasCostUsd)}` : "";
      console.log(`  Gas:     ${result.gasUsed}  (~${result.gasCostNative} native${gasUsdNote})`);
      console.log(`  Tx:      ${result.txHash}`);
    }
  } finally {
    logger.close();
  }
}

export async function revokeCommand(flags: Record<string, string>, positional: string[]) {
  const token = positional[1];
  const spender = positional[2];
  if (!token || !spender) throw new ToolError("INVALID_PARAMS", "Usage: tradekit revoke <token> <spender> [--chain <name>]");
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  // Validate before prompting (same UX rationale as approveCommand).
  const tokenAddr = resolveToken(profile, token);
  if (!tokenAddr) throw unknownTokenError("token", token, profile);
  const spenderAddr = assertAddress("spender", spender);
  const walletPass = await requirePassword(flags);
  const logger = makeCliLogger(flags);
  try {
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    const wallet = await loadWallet(walletPass, profile, extraRpcs, logger, flags["account"]);
    const result = await revokeToken(
      { publicClient: wallet.publicClient, walletClient: wallet.walletClient, profile, logger },
      { token: tokenAddr, spender: spenderAddr },
    );
    if (flags["json"] === "true") printJson(result);
    else {
      console.log(`REVOKE ${result.status.toUpperCase()}`);
      console.log(`  Token:   ${result.token}`);
      console.log(`  Spender: ${result.spender}`);
      const gasUsdNote = result.gasCostUsd != null ? ` ≈ ${formatUsd(result.gasCostUsd)}` : "";
      console.log(`  Gas:     ${result.gasUsed}  (~${result.gasCostNative} native${gasUsdNote})`);
      console.log(`  Tx:      ${result.txHash}`);
    }
  } finally {
    logger.close();
  }
}
