// Read-only inspection CLI commands: holdings, trending, pnl, trades, audit, viewTx,
// price. Lifted from index.ts. The watch-mode wrappers split each command into a
// public entry that pipes through `withWatch` and a `Once` worker that does the actual
// I/O — same pattern that index.ts used inline.

import type { Address } from "viem";
import { loadConfig, resolveProfile } from "../config.js";
import { activeWalletAddress, activeWalletLabel } from "../wallet.js";
import { resolveToken, unknownTokenError } from "../chains.js";
import { holdingsMultiChain, formatHoldings, formatUsd } from "../holdings.js";
import { searchToken, tokenByAddress, trendingOnChain, formatPairs } from "../trending.js";
import { computePnL, formatPnLReport } from "../pnl.js";
import { recentTrades, recentAudit, pruneAudit, auditPruneStats, TRADE_COLUMNS, matchesTradeToken, failureReasonHistogram } from "../db.js";
import { getCurrentPrice, getPriceHistory } from "../price.js";
import { ToolError, rpcFailedChainError } from "../errors.js";
import { prompt } from "../cli.js";
import { makeCliLogger, printJson, withWatch, csvField, assertTxHash, tradeStatusMarker, parseIntFlag, parseFloatFlag, parseChainsFlag } from "./helpers.js";
import { compactMessage, parseDateFilter } from "../format.js";
import { listChains } from "../chains.js";

// ── holdings ─────────────────────────────────────────────────

export async function holdingsCommand(flags: Record<string, string>, positional: string[]) {
  await withWatch(flags, () => holdingsCommandOnce(flags, positional));
}

async function holdingsCommandOnce(flags: Record<string, string>, positional: string[]) {
  const config = loadConfig();
  let target = positional[1] as Address | undefined;
  // Iter265: address + --account is ambiguous. Pre-iter265 the positional silently
  // won; an operator who typed both (e.g., a script that drops --account when an
  // address is provided but accidentally kept both) had no signal that --account
  // was discarded. Force the operator to pick — same spirit as iter249's "no silent
  // selection" principle. MCP's address-wins behavior is documented in the tool
  // description; CLI doesn't have that affordance, so reject is the clearer choice.
  if (target && flags["account"]) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Pass either a positional address OR --account <label>, not both. Got address "${target}" and --account "${flags["account"]}".`,
    );
  }
  if (target) {
    // Reject malformed input early — otherwise viem deep inside holdingsMultiChain
    // would throw a confusing message about contract reads against a bad address.
    // Pre-iter158 this used a length-only check (≥42 + "0x" prefix) which let
    // non-hex 42-char inputs like 0xzzzz...zzzz through; same fix as iter122 made
    // in resolveToken — use viem's proper isAddress (accepts both lowercase and
    // EIP-55 checksum forms).
    const { isAddress } = await import("viem");
    if (!isAddress(target, { strict: false })) {
      throw new ToolError("INVALID_PARAMS", `Invalid address "${target}" — expected 0x-prefixed 40 hex chars.`);
    }
  } else if (flags["account"]) {
    // Iter263: --account looks up the HD account's address without requiring a
    // password (the address is stored in accounts.json — only signing needs the key).
    // Iter284: also handle the synthetic "keystore" label that account-list uses for
    // single-key wallets — `--account keystore` lookups must work for keystore-only
    // installs, matching MCP/web behavior.
    const { listAccounts } = await import("../accounts.js");
    const file = listAccounts();
    const entry = file?.accounts.find((a) => a.label === flags["account"]);
    if (entry) {
      target = entry.address;
    } else if (flags["account"].toLowerCase() === "keystore") {
      const { getKeystoreAddress } = await import("../wallet.js");
      const ks = getKeystoreAddress();
      if (!ks) {
        throw new ToolError(
          "WALLET_NOT_FOUND",
          `--account keystore requested but no single-key keystore exists. Run \`tradekit wallet create\` first, or use a different account label.`,
          { details: { requestedAccount: "keystore", reason: "keystore_requested_but_absent" } },
        );
      }
      target = ks;
    } else {
      // Iter381: route through unknownAccountError (iter344) so the typo-suggestion
      // helper fires. Pre-iter381 this site had its own inlined error message — no
      // "Did you mean" hint, just the known list. The known set includes both HD
      // labels AND the synthetic "keystore" label when a single-key keystore exists.
      const { getKeystoreAddress } = await import("../wallet.js");
      const { unknownAccountError } = await import("../accounts.js");
      const knownLabels = [
        ...(file?.accounts ?? []).map((a) => a.label),
        ...(getKeystoreAddress() ? ["keystore"] : []),
      ];
      throw unknownAccountError(flags["account"], knownLabels);
    }
  } else {
    const addr = activeWalletAddress();
    // Iter546: same paste-ready CLI form as iter545/iter546 in walletView /
    // approvals. Holdings can take an arbitrary --address override, so name that
    // path too.
    if (!addr) {
      throw new ToolError(
        "WALLET_NOT_FOUND",
        "No wallet found and no positional address provided. Run `tradekit init` for setup, OR call `tradekit holdings <0x-address>` to query an arbitrary address.",
        { details: { reason: "no_wallet" } },
      );
    }
    target = addr;
  }
  const chains = parseChainsFlag(flags["chains"], [...listChains(), ...Object.keys(config.chains)]);
  const logger = makeCliLogger(flags);
  try {
    const { reports, errors } = await holdingsMultiChain(target, config, logger, chains);
    // Iter716: load lastTradeAt per (chain, symbol) so both text + JSON paths
    // can surface "when did this token last trade?" alongside its balance.
    // Scoped to the resolved account label when one is set; falls back to a
    // global lookup when querying by raw address (we don't know which
    // operator account holds it).
    const { lastTradeAtBySymbol } = await import("../db.js");
    const lastTradeAtMap = lastTradeAtBySymbol(
      flags["account"] ? { account: flags["account"] } : {},
    );
    if (flags["json"] === "true") {
      // Iter716: enrich each balance with lastTradeAt when known. Pre-iter716
      // JSON consumers see the same shape minus the new optional field —
      // additive, no breaking changes.
      const enriched = reports.map((r) => ({
        ...r,
        balances: r.balances.map((b) => {
          const key = `${r.chain}:${b.symbol.toUpperCase()}`;
          const last = lastTradeAtMap.get(key);
          return last ? { ...b, lastTradeAt: last } : b;
        }),
      }));
      printJson(enriched);
      if (errors.length > 0) {
        console.error(JSON.stringify({ errors }));
      }
    } else {
      // Iter709: --min-usd parses to a positive number; reject garbage at the
      // boundary so a typo doesn't silently disable filtering.
      const minUsd = parseFloatFlag(flags["min-usd"], "--min-usd", { min: 0 });
      // Iter820: severity badge — same trigger as iter770 --strict (any
      // per-chain fetch failure). Mirrors iter808-819 across the rest of
      // the CLI surface.
      const holdingsBadge = errors.length > 0 ? "🟡 WARN" : "🟢 OK  ";
      console.log(`${holdingsBadge}  Address: ${target}`);
      console.log("");
      console.log(formatHoldings(reports, { ...(minUsd != null ? { minUsd } : {}), lastTradeAtMap }));
      if (errors.length > 0) {
        console.log("");
        console.log(`⚠  ${errors.length} chain${errors.length === 1 ? "" : "s"} couldn't be fetched (RPC error?):`);
        for (const e of errors) console.log(`     ${e.chain.padEnd(10)} ${compactMessage(e.message, 70)}`);
      }
    }
    // Iter770: --strict exit-code surface. Triggers when any per-chain fetch
    // failed (the existing errors[] array). Operators monitoring multi-chain
    // holdings get an exit-code gate for "at least one chain's view is
    // incomplete" — without it, scripted consumers parsing the JSON would
    // miss the warning that lives in errors[] (it's not part of the per-chain
    // balance shape they're walking). Symmetric with iter761 gas / iter769
    // price — all three gate on external-source health.
    const strict = flags["strict"] === "true" || flags["strict"] === "";
    if (strict && errors.length > 0) {
      // process.exitCode (not process.exit) — main()'s audit-insert finally
      // runs first (iter351 pattern).
      process.exitCode = 1;
    }
  } finally {
    logger.close();
  }
}

// ── portfolio (iter605) ──────────────────────────────────────
//
// `tradekit portfolio` — multi-account, multi-chain aggregate. Defaults to ALL
// accounts (HD + keystore) and the same chain set holdings uses. The output is
// a per-token roll-up sorted by USD descending + concentration analysis (top 1,
// top 3, top 5 cumulative %). Flags mirror holdings: --json, --chains, --accounts.
//
// --accounts accepts:
//   - omitted: default → "all" (every HD + keystore)
//   - "all": every HD + keystore (explicit)
//   - comma-list: "alice,bob,keystore" — case-sensitive label match
//
// Errors:
// - INVALID_PARAMS: --accounts contains an unknown label (uses iter344
//   unknownAccountError so the message carries a "Did you mean" suggestion).

export async function portfolioCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const logger = makeCliLogger(flags);
  try {
    const { resolveAccountsForPortfolio, aggregatePortfolio } = await import("../portfolio.js");
    const { listAccounts } = await import("../accounts.js");
    const { getKeystoreAddress } = await import("../wallet.js");
    const { KEYSTORE_LABEL } = await import("../constants.js");
    const { unknownAccountError } = await import("../accounts.js");

    // Resolve --accounts. Default: "all" (every account). Special "all" still
    // expands to the same set; comma-list resolves each label individually and
    // surfaces unknown labels via iter344 unknownAccountError.
    let accountLabels: string[] | "all" | undefined;
    const rawAccounts = flags["accounts"];
    if (rawAccounts == null || rawAccounts === "all") {
      accountLabels = "all";
    } else {
      const parts = rawAccounts.split(",").map((s) => s.trim()).filter(Boolean);
      const file = listAccounts();
      const knownLabels = [
        ...(file?.accounts ?? []).map((a) => a.label),
        ...(getKeystoreAddress() ? [KEYSTORE_LABEL] : []),
      ];
      for (const p of parts) {
        if (!knownLabels.includes(p)) throw unknownAccountError(p, knownLabels);
      }
      accountLabels = parts;
    }

    const accounts = resolveAccountsForPortfolio(accountLabels);
    if (accounts.length === 0) {
      throw new ToolError(
        "WALLET_NOT_FOUND",
        "Portfolio scan requires at least one wallet. Run `tradekit init` for setup, or `tradekit account create-mnemonic` (HD) / `tradekit wallet create` (single-key).",
        { details: { reason: "no_wallet", requestedAccounts: accountLabels === "all" ? "all" : accountLabels } },
      );
    }

    const chains = parseChainsFlag(flags["chains"], [...listChains(), ...Object.keys(config.chains)]);
    const report = await aggregatePortfolio({ accounts, config, logger, chains });

    // Iter717: enrich each TokenAggregate with lastTradeAt = MAX across
    // contributing chains. Done post-aggregation (not inside the pure
    // aggregateTokens) to keep the aggregator pure and avoid a DB
    // dependency in the analytics layer.
    const { lastTradeAtBySymbol } = await import("../db.js");
    const lastMap = lastTradeAtBySymbol();
    for (const t of report.tokens) {
      let max: string | undefined;
      for (const e of t.perChain) {
        const last = lastMap.get(`${e.chain}:${t.symbol.toUpperCase()}`);
        if (last && (!max || last > max)) max = last;
      }
      if (max) t.lastTradeAt = max;
    }

    // Iter796: --strict gate evaluated for BOTH json and text render paths.
    // Captured here so the JSON early-return below still honors it.
    const strict = flags["strict"] === "true" || flags["strict"] === "";
    const applyStrict = () => {
      if (strict && report.errors.length > 0) process.exitCode = 1;
    };

    if (flags["json"] === "true") {
      printJson({ ok: true, ...report });
      applyStrict();
      return;
    }

    // Text mode: account list → per-token roll-up sorted by USD → concentration.
    const accLabels = report.accounts.map((a) => a.label).join(", ");
    // Iter810: severity badge — parity with iter808/809.
    const portfolioBadge = report.severity === "ok" ? "🟢 OK  " : "🟡 WARN";
    console.log(`${portfolioBadge}  Portfolio across ${report.accounts.length} account${report.accounts.length === 1 ? "" : "s"} (${accLabels}) on ${report.chains.length} chain${report.chains.length === 1 ? "" : "s"}:`);
    console.log("");
    console.log(`  Total USD:  ${formatUsd(report.totalUsd)}`);
    if (report.unpricedPositionCount > 0) {
      console.log(`  Unpriced:   ${report.unpricedPositionCount} position${report.unpricedPositionCount === 1 ? "" : "s"} (not included in total)`);
    }
    if (report.errors.length > 0) {
      console.log(`  Failed:     ${report.errors.length} (account, chain) scan${report.errors.length === 1 ? "" : "s"}`);
    }
    // Iter759: onboarding hint for the empty-state. Fresh operators running
    // `tradekit portfolio` after install see $0 across the board and don't
    // know what to do. Parallel to iter745 pnl + iter747 holdings hints —
    // surface the scanned scope + the three actual root causes (no funds /
    // wrong chains / wrong accounts). Conditional on truly-empty: zero
    // priced AND zero unpriced positions. Operators with unpriced
    // long-tail tokens get the existing unpriced note instead — that's
    // the right signal there.
    if (report.tokens.length === 0 && report.unpricedPositionCount === 0) {
      const ownerAddrs = report.accounts.map((a) => `${a.label}=${a.address}`).join(", ");
      console.log("");
      console.log(`  ℹ No positions found on the scanned scope.`);
      console.log(`    - To fund: send tokens to one of ${ownerAddrs}.`);
      console.log(`    - Other chains: \`tradekit portfolio --chains all\``);
      console.log(`    - Other accounts: \`tradekit portfolio --accounts all\``);
    }
    console.log("");
    console.log("  Concentration (% of priced portfolio):");
    console.log(`    Top 1:  ${report.concentration.top1.toFixed(1)}%`);
    console.log(`    Top 3:  ${report.concentration.top3.toFixed(1)}%`);
    console.log(`    Top 5:  ${report.concentration.top5.toFixed(1)}%`);
    console.log("");
    console.log("  Top holdings:");
    console.log("    Symbol       USD          %        Last         Per-chain");
    console.log("    " + "-".repeat(95));
    const topN = Math.min(report.tokens.length, parseInt(flags["limit"] ?? "10", 10) || 10);
    for (let i = 0; i < topN; i++) {
      const t = report.tokens[i];
      const usdStr = t.totalUsd != null ? formatUsd(t.totalUsd) : "—";
      const pctStr = t.percentOfPortfolio != null ? `${t.percentOfPortfolio.toFixed(1)}%` : "—";
      // Iter717: lastTradeAt as YYYY-MM-DD (full ISO in --json). "—" for never-traded.
      const lastStr = t.lastTradeAt ? t.lastTradeAt.slice(0, 10) : "—";
      const perChain = t.perChain.map((e) => `${e.chain}=${e.amount}`).join(", ");
      console.log(`    ${t.symbol.padEnd(12)} ${usdStr.padEnd(12)} ${pctStr.padEnd(8)} ${lastStr.padEnd(12)} ${perChain}`);
    }
    if (report.errors.length > 0) {
      console.log("");
      console.log("  Errors:");
      for (const e of report.errors) {
        console.log(`    ✗ ${e.account} / ${e.chain}: ${e.message}`);
      }
    }
    // Iter842: surface iter833 recommendedActions inline. Mirrors iter839/840
    // /841 footer convention. Portfolio's actions cover stale-sync hints,
    // empty-holdings hints, and per-chain error follow-ups — all paste-ready
    // prose for text-mode operators.
    if (report.recommendedActions.length > 0) {
      console.log("");
      console.log("Next steps:");
      for (const a of report.recommendedActions) {
        console.log(`  → ${a.reason}`);
      }
    }
    // Iter796: --strict exit gate (text-mode path). The JSON path applied it
    // before returning above; the helper centralizes the rule. Symmetric
    // with iter770 holdings / iter761 gas / iter772 preflight strict modes.
    applyStrict();
  } finally {
    logger.close();
  }
}

// ── portfolio snapshot / history / diff (iter618) ────────────
//
// Historical portfolio state. PnL captures realized trades; these capture the
// FULL position view at a point in time so operators can compare states across
// dates ("how has my portfolio changed since last week?").
//
// Saved snapshots live in the portfolio_snapshots table (db.ts v3 migration).
// The data column is the full PortfolioReport JSON — diffing reconstructs by
// parsing both blobs through the pure diffSnapshots helper.
//
// Scope contract: snapshots store `accounts_key`/`chains_key` (sorted comma-
// joined scope ids). Diff lookups filter by the CURRENT scan's scope key so
// we never compare "5 chains" vs "1 chain" — that would mis-attribute missing
// chains as "positions removed".

/**
 * Iter618: build the same PortfolioReport `portfolioCommand` builds, then
 * persist it. Reuses the same accounts/chains flag resolution path for
 * consistency.
 */
export async function portfolioSnapshotCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const logger = makeCliLogger(flags);
  try {
    const { resolveAccountsForPortfolio, aggregatePortfolio } = await import("../portfolio.js");
    const { listAccounts, unknownAccountError } = await import("../accounts.js");
    const { getKeystoreAddress } = await import("../wallet.js");
    const { KEYSTORE_LABEL } = await import("../constants.js");

    let accountLabels: string[] | "all" | undefined;
    const rawAccounts = flags["accounts"];
    if (rawAccounts == null || rawAccounts === "all") {
      accountLabels = "all";
    } else {
      const parts = rawAccounts.split(",").map((s) => s.trim()).filter(Boolean);
      const file = listAccounts();
      const knownLabels = [
        ...(file?.accounts ?? []).map((a) => a.label),
        ...(getKeystoreAddress() ? [KEYSTORE_LABEL] : []),
      ];
      for (const p of parts) {
        if (!knownLabels.includes(p)) throw unknownAccountError(p, knownLabels);
      }
      accountLabels = parts;
    }

    const accounts = resolveAccountsForPortfolio(accountLabels);
    if (accounts.length === 0) {
      throw new ToolError(
        "WALLET_NOT_FOUND",
        "Portfolio snapshot requires at least one wallet. Run `tradekit init` or `tradekit account create-mnemonic`.",
        { details: { reason: "no_wallet" } },
      );
    }

    const chains = parseChainsFlag(flags["chains"], [...listChains(), ...Object.keys(config.chains)]);
    const report = await aggregatePortfolio({ accounts, config, logger, chains });

    const { scopeKey } = await import("../portfolioSnapshots.js");
    const { insertPortfolioSnapshot } = await import("../db.js");
    const accountsKey = scopeKey(report.accounts.map((a) => a.label));
    const chainsKey = scopeKey(report.chains);
    const note = flags["note"] ?? null;
    const id = insertPortfolioSnapshot({
      timestamp: report.timestamp,
      total_usd: report.totalUsd,
      accounts_key: accountsKey,
      chains_key: chainsKey,
      token_count: report.tokens.length,
      note,
      data: JSON.stringify(report),
    });

    if (flags["json"] === "true") {
      printJson({
        ok: true,
        action: "snapshot_saved",
        id,
        timestamp: report.timestamp,
        totalUsd: report.totalUsd,
        accountsKey,
        chainsKey,
        tokenCount: report.tokens.length,
        note,
      });
      return;
    }
    console.log(`Portfolio snapshot saved (id=${id}):`);
    console.log(`  Timestamp:   ${report.timestamp}`);
    console.log(`  Total USD:   ${formatUsd(report.totalUsd)}`);
    console.log(`  Accounts:    ${accountsKey}`);
    console.log(`  Chains:      ${chainsKey}`);
    console.log(`  Tokens:      ${report.tokens.length}`);
    if (note) console.log(`  Note:        ${note}`);
    console.log("");
    console.log(`Compare against this snapshot later: \`tradekit portfolio diff ${id}\` or \`tradekit portfolio diff 7d\` (relative).`);
  } finally {
    logger.close();
  }
}

/**
 * Iter618: list saved snapshots (most recent first, metadata only — `data`
 * blob is excluded from the listing for performance and screen real estate).
 */
export async function portfolioHistoryCommand(flags: Record<string, string>) {
  const limit = flags["limit"] ? parseInt(flags["limit"], 10) : 20;
  const { listPortfolioSnapshots } = await import("../db.js");
  const rows = listPortfolioSnapshots({ limit });

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      count: rows.length,
      snapshots: rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        totalUsd: r.total_usd,
        accountsKey: r.accounts_key,
        chainsKey: r.chains_key,
        tokenCount: r.token_count,
        note: r.note,
      })),
    });
    return;
  }
  if (rows.length === 0) {
    console.log("No portfolio snapshots saved yet. Run `tradekit portfolio snapshot` to capture the current state.");
    return;
  }
  console.log(`Portfolio history (${rows.length} snapshot${rows.length === 1 ? "" : "s"}):`);
  console.log("");
  console.log("  ID       Timestamp                Total USD       Tokens   Scope (accounts × chains)                              Note");
  console.log("  " + "-".repeat(140));
  for (const r of rows) {
    const usdStr = r.total_usd != null ? formatUsd(r.total_usd).padEnd(14) : "—".padEnd(14);
    const scope = `${r.accounts_key} × ${r.chains_key}`.slice(0, 53).padEnd(53);
    console.log(
      `  ${String(r.id).padEnd(7)}  ${r.timestamp.padEnd(24)} ${usdStr}  ${String(r.token_count).padEnd(6)}   ${scope}   ${r.note ?? ""}`,
    );
  }
}

/**
 * Iter618: diff a past snapshot against the CURRENT live portfolio.
 *
 * `<ref>` accepts:
 *   - numeric id (1, 42)
 *   - relative shorthand (7d, 24h)
 *   - "today" / "yesterday"
 *   - ISO date / timestamp
 *
 * Scope-matching: the live portfolio uses the same --accounts/--chains flags
 * `portfolio` does; the lookup finds a past snapshot with the same scope key
 * so the diff is apples-to-apples.
 */
export async function portfolioDiffCommand(
  flags: Record<string, string>,
  positional: string[],
) {
  const ref = positional[2];
  if (!ref) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Usage: tradekit portfolio diff <snapshot-id | 7d | today | 2026-05-01> [--accounts ...] [--chains ...] [--json]",
    );
  }

  const config = loadConfig();
  const logger = makeCliLogger(flags);
  try {
    const { resolveAccountsForPortfolio, aggregatePortfolio } = await import("../portfolio.js");
    const { listAccounts, unknownAccountError } = await import("../accounts.js");
    const { getKeystoreAddress } = await import("../wallet.js");
    const { KEYSTORE_LABEL } = await import("../constants.js");
    const { resolveSnapshotRef, scopeKey, diffSnapshots } = await import("../portfolioSnapshots.js");
    const { getPortfolioSnapshot, findPortfolioSnapshotAsOf } = await import("../db.js");

    let accountLabels: string[] | "all" | undefined;
    const rawAccounts = flags["accounts"];
    if (rawAccounts == null || rawAccounts === "all") {
      accountLabels = "all";
    } else {
      const parts = rawAccounts.split(",").map((s) => s.trim()).filter(Boolean);
      const file = listAccounts();
      const knownLabels = [
        ...(file?.accounts ?? []).map((a) => a.label),
        ...(getKeystoreAddress() ? [KEYSTORE_LABEL] : []),
      ];
      for (const p of parts) {
        if (!knownLabels.includes(p)) throw unknownAccountError(p, knownLabels);
      }
      accountLabels = parts;
    }

    const accounts = resolveAccountsForPortfolio(accountLabels);
    if (accounts.length === 0) {
      throw new ToolError(
        "WALLET_NOT_FOUND",
        "Portfolio diff requires at least one wallet.",
        { details: { reason: "no_wallet" } },
      );
    }
    const chains = parseChainsFlag(flags["chains"], [...listChains(), ...Object.keys(config.chains)]);

    // Compute CURRENT live portfolio first — keeps the timestamp tight against
    // the diff write-out.
    const current = await aggregatePortfolio({ accounts, config, logger, chains });
    const accountsKey = scopeKey(current.accounts.map((a) => a.label));
    const chainsKey = scopeKey(current.chains);

    // Resolve the past snapshot.
    let resolved;
    try {
      resolved = resolveSnapshotRef(ref);
    } catch (e) {
      throw new ToolError("INVALID_PARAMS", (e as Error).message);
    }

    let prevRow;
    if (resolved.kind === "id") {
      prevRow = getPortfolioSnapshot(resolved.id);
      if (!prevRow) {
        throw new ToolError(
          "INVALID_PARAMS",
          `No snapshot with id=${resolved.id}. Use \`tradekit portfolio history\` to list saved ids.`,
        );
      }
      // Iter618: warn (don't error) when the explicit id has a different scope —
      // operator picked it intentionally, so respect that, but flag the mismatch.
      if (prevRow.accounts_key !== accountsKey || prevRow.chains_key !== chainsKey) {
        logger.warn(
          `Scope mismatch: snapshot #${resolved.id} captured "${prevRow.accounts_key} × ${prevRow.chains_key}" but current scan is "${accountsKey} × ${chainsKey}". Diff may show false adds/removes.`,
        );
      }
    } else {
      prevRow = findPortfolioSnapshotAsOf({
        asOf: resolved.iso,
        accountsKey,
        chainsKey,
      });
      if (!prevRow) {
        throw new ToolError(
          "INVALID_PARAMS",
          `No snapshot at or before ${resolved.iso} for scope "${accountsKey} × ${chainsKey}". Take a snapshot first with \`tradekit portfolio snapshot\`, or pass a different ref.`,
        );
      }
    }

    const prev = JSON.parse(prevRow.data);
    const delta = diffSnapshots(prev, current);

    if (flags["json"] === "true") {
      printJson({ ok: true, prevSnapshotId: prevRow.id, ...delta });
      return;
    }

    // Text mode.
    console.log(`Portfolio diff: snapshot #${prevRow.id} → current`);
    console.log("");
    console.log(`  Prev:        ${prev.timestamp}  ${formatUsd(prev.totalUsd)}  (${prev.tokens.length} tokens)`);
    console.log(`  Current:     ${current.timestamp}  ${formatUsd(current.totalUsd)}  (${current.tokens.length} tokens)`);
    const arrow = delta.totalUsdDelta > 0 ? "↑" : delta.totalUsdDelta < 0 ? "↓" : "→";
    const pctStr = delta.totalUsdDeltaPct != null ? ` (${delta.totalUsdDeltaPct.toFixed(2)}%)` : "";
    console.log(`  Δ USD:       ${arrow} ${formatUsd(Math.abs(delta.totalUsdDelta))}${pctStr}`);
    console.log("");

    if (delta.added.length > 0) {
      console.log(`  + Added (${delta.added.length}):`);
      for (const t of delta.added.slice(0, 10)) {
        const usdStr = t.currentUsd != null ? formatUsd(t.currentUsd) : "—";
        console.log(`      + ${t.symbol.padEnd(12)} ${usdStr}`);
      }
      console.log("");
    }
    if (delta.removed.length > 0) {
      console.log(`  - Removed (${delta.removed.length}):`);
      for (const t of delta.removed.slice(0, 10)) {
        const usdStr = t.prevUsd != null ? formatUsd(t.prevUsd) : "—";
        console.log(`      - ${t.symbol.padEnd(12)} ${usdStr}`);
      }
      console.log("");
    }
    if (delta.changed.length > 0) {
      console.log(`  ~ Changed (${delta.changed.length}) — top movers:`);
      console.log("      Symbol       Δ USD            Δ %       Prev USD       Current USD");
      console.log("      " + "-".repeat(78));
      for (const t of delta.changed.slice(0, 10)) {
        const deltaStr = t.usdDelta != null ? `${t.usdDelta >= 0 ? "+" : ""}${formatUsd(t.usdDelta)}` : "—";
        const pctStr2 = t.usdDeltaPct != null ? `${t.usdDeltaPct >= 0 ? "+" : ""}${t.usdDeltaPct.toFixed(1)}%` : "—";
        const prevStr = t.prevUsd != null ? formatUsd(t.prevUsd) : "—";
        const currStr = t.currentUsd != null ? formatUsd(t.currentUsd) : "—";
        console.log(
          `      ${t.symbol.padEnd(12)} ${deltaStr.padEnd(16)} ${pctStr2.padEnd(9)} ${prevStr.padEnd(14)} ${currStr}`,
        );
      }
    }
  } finally {
    logger.close();
  }
}

// ── trending ─────────────────────────────────────────────────

export async function trendingCommand(flags: Record<string, string>, positional: string[]) {
  const config = loadConfig();
  const query = positional[1];
  const chain = flags["chain"] ?? config.activeChain;
  const logger = makeCliLogger(flags);
  try {
    let pairs;
    if (query) {
      // Decide between address-lookup vs name-search via proper hex+length check.
      // Pre-iter158 we used length-only (≥42 + "0x") which sent non-hex 42-char
      // inputs into tokenByAddress, where they failed with a confusing message
      // instead of falling through to the more permissive searchToken path.
      const { isAddress } = await import("viem");
      if (isAddress(query, { strict: false })) {
        pairs = await tokenByAddress(chain, query, logger);
      } else {
        pairs = await searchToken(query, logger);
      }
    } else {
      pairs = await trendingOnChain(chain, logger, parseIntFlag(flags["limit"], "--limit", { min: 1, max: 100 }) ?? 10);
    }
    if (flags["json"] === "true") {
      // Iter422: wrap with {ok, query, chain, pairs, timestamp} — same iter375/377
      // envelope discipline. Pre-iter422 emitted a bare array; consumers couldn't
      // distinguish "trending returned nothing" from "filter excluded everything"
      // and had no timestamp for cache-staleness checks. Forward-only shape change
      // — same precedent set by iter375 (token list) and iter377 (chains).
      printJson({
        ok: true,
        query: query ?? null,
        chain,
        pairs,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log(formatPairs(pairs));
    }
  } finally {
    logger.close();
  }
}

// ── aggregator stats (iter623) ───────────────────────────────
//
// Per-aggregator quality scorecard. Pulls the trade history + iter619 analyses
// + runs the pure computeAggregatorStats compose. Operators trading via
// multiple aggregators see WHICH one is winning instead of having to bisect
// recent_trades by hand.
//
// Filters mirror `trades`: --since DATE (default 30d), --account L,
// --chain X. Output mode --json returns the structured AggregatorStatsReport;
// text mode prints a sorted table + the optional recommendation line.

export async function aggregatorStatsCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const logger = makeCliLogger(flags);
  try {
    const account = flags["account"] ?? activeWalletLabel();
    const since = flags["since"]
      ? (parseDateFilter(flags["since"], "since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString())
      : new Date(Date.now() - 30 * 86_400_000).toISOString();

    const { recentTrades } = await import("../db.js");
    // Iter663: --strategy filter scopes the stats to one strategy's trades.
    // Closes the attribution loop with iter648 — answers "across my DCA
    // strategy, which aggregator was best?" rather than blending strategy
    // and exploration noise. Same convention as pnl --strategy: the filter
    // applies, math runs on the filtered subset.
    const rows = recentTrades({ chain: flags["chain"], account, since, limit: 10_000, strategy: flags["strategy"] });

    // Iter623: only success rows feed slippage stats (failures have no
    // on-chain deltas). But we keep ALL rows for the success-rate compute.
    const { analyzeStoredTrade } = await import("../tradeAnalysis.js");
    const successRows = rows.filter((r) => r.status === "success");
    const analyses = [];
    if (successRows.length > 0) {
      // Per-chain walletcache to avoid reconstructing the public client.
      const walletByChain = new Map<string, ReturnType<typeof loadReadOnlyWallet>>();
      const { loadReadOnlyWallet } = await import("../wallet.js");
      for (const row of successRows) {
        try {
          let wallet = walletByChain.get(row.chain);
          if (!wallet) {
            const profile = resolveProfile(row.chain, config);
            const extraRpcs = config.chains[row.chain]?.rpcs ?? [];
            wallet = loadReadOnlyWallet(profile, extraRpcs, account);
            walletByChain.set(row.chain, wallet);
          }
          const profile = resolveProfile(row.chain, config);
          analyses.push(
            await analyzeStoredTrade({ row, publicClient: wallet.publicClient, profile, logger }),
          );
        } catch (e) {
          logger.debug(`aggregator stats: analysis skipped for ${row.tx_hash}: ${(e as Error).message}`);
        }
      }
    }

    const { computeAggregatorStats } = await import("../aggregatorStats.js");
    const report = computeAggregatorStats(rows, analyses, { since });

    if (flags["json"] === "true") {
      printJson({ ok: true, ...report });
      return;
    }

    if (report.byAggregator.length === 0) {
      console.log("No trades found in the window. Use --since to widen the lookback.");
      return;
    }

    const sinceStr = report.since ? new Date(report.since).toISOString().slice(0, 10) : "all-time";
    // Iter744: elapsedMs suffix — parity with iter731 reconcile/pnl/portfolio.
    const elapsedSuffix = report.elapsedMs != null
      ? `  (${(report.elapsedMs / 1000).toFixed(1)}s)`
      : "";
    // Iter815: severity badge — parity with iter808-814 convention. Reads
    // iter803 severity (ok/warn) derived from underperformer warnings count.
    const aggBadge = report.severity === "ok" ? "🟢 OK  " : "🟡 WARN";
    console.log(`${aggBadge}  Aggregator quality — ${report.totalTrades} trade${report.totalTrades === 1 ? "" : "s"} since ${sinceStr}${elapsedSuffix}`);
    console.log("");
    // Iter703: index aggregators by their config.aggregator.preferred rank.
    // Operators reading the stats want to know whether their CONFIG order
    // matches the DATA order. We use the same rank source as the runtime
    // fallback chain — so a row showing "#1" really is the first one tried
    // on every quote in "first" mode.
    const preferredRank = new Map<string, number>();
    (config.aggregator?.preferred ?? []).forEach((name, i) => {
      preferredRank.set(name.toLowerCase(), i + 1);
    });
    console.log("  Aggregator     Trades    Success    Median slip   p95 slip    Avg slip    Volume(USD)            Last         Config");
    console.log("  " + "-".repeat(128));
    for (const s of report.byAggregator) {
      const successRate = s.successRate != null ? `${(s.successRate * 100).toFixed(1)}%` : "—";
      const median = s.medianSlippageBps != null ? `${s.medianSlippageBps.toFixed(1)} bps` : "—";
      const p95 = s.p95SlippageBps != null ? `${s.p95SlippageBps.toFixed(1)} bps` : "—";
      const avg = s.avgSlippageBps != null ? `${s.avgSlippageBps.toFixed(1)} bps` : "—";
      const vol = s.totalUsdVolume > 0
        ? `$${s.totalUsdVolume.toLocaleString("en-US", { maximumFractionDigits: 0 })}${s.volumeNotePartial ? "+" : ""}`
        : "—";
      // Iter701: lastSeen as YYYY-MM-DD compact form (full ISO in --json).
      const lastSeen = s.lastSeen ? s.lastSeen.slice(0, 10) : "—";
      // Iter703: preferred-rank annotation. "#1"/"#2"/etc. when in the list,
      // "—" when not in preferred (rows for "unknown" / "transfer" / etc.).
      const rank = preferredRank.get(s.aggregator.toLowerCase());
      const rankStr = rank != null ? `#${rank}` : "—";
      console.log(
        `  ${s.aggregator.padEnd(14)} ${String(s.tradeCount).padEnd(9)} ${successRate.padEnd(10)} ${median.padEnd(13)} ${p95.padEnd(11)} ${avg.padEnd(11)} ${vol.padEnd(22)} ${lastSeen.padEnd(12)} ${rankStr}`,
      );
    }
    if (report.recommendation) {
      console.log("");
      console.log(`  ▸ ${report.recommendation}`);
      // Iter733: when the data-recommended aggregator isn't the operator's
      // configured #1, surface a paste-ready config command. Operators
      // running aggregator stats AS a config-tuning exercise get the next
      // step inline. Skipped when there's no preferred list (operator using
      // defaults) — telling them to push to an unconfigured list isn't
      // actionable yet.
      const top = config.aggregator?.preferred?.[0];
      if (
        report.recommendedAggregator &&
        top &&
        report.recommendedAggregator !== top
      ) {
        console.log(
          `    Config currently leads with "${top}" — to switch run: tradekit config set aggregator.preferred '["${report.recommendedAggregator}","${top}"${(config.aggregator?.preferred ?? []).filter((a) => a !== top && a !== report.recommendedAggregator).map((a) => `,"${a}"`).join("")}]'`,
        );
      }
    }
    // Iter688: symmetric underperformer warnings. Placed AFTER the
    // recommendation so the operator's eye flows winner → loser.
    if (report.warnings && report.warnings.length > 0) {
      console.log("");
      for (const w of report.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }
    // Show verdict-bucket distribution for the leader. Operators want to know
    // "what FRACTION of my kyberswap trades were excellent vs major_slip".
    if (report.byAggregator[0].analyzedCount > 0) {
      const top = report.byAggregator[0];
      const verdicts = Object.entries(top.byVerdict);
      if (verdicts.length > 0) {
        console.log("");
        console.log(`  ${top.aggregator} verdict mix:  ${verdicts.map(([k, v]) => `${k}=${v}`).join("  ")}`);
      }
    }
    // Iter672: per-aggregator failure reason footer for aggregators that
    // had failures. Surfaces "openocean fails with X, kyberswap with Y" —
    // different debugging paths. Only shown when failureReasons is non-empty
    // to keep healthy-state output clean.
    for (const s of report.byAggregator) {
      if (s.failureReasons.length === 0) continue;
      // Cap at top 3 to keep the footer compact; full list lives in --json.
      const top3 = s.failureReasons.slice(0, 3);
      const summary = top3.map((r) => `${r.reason}=${r.count}`).join("  ");
      console.log(`  ${s.aggregator} failure reasons:  ${summary}${s.failureReasons.length > 3 ? `  (+${s.failureReasons.length - 3} more)` : ""}`);
    }
    // Iter844: surface iter835 recommendedActions inline. Aggregator stats
    // dispatches cover "config underperformer detected → re-run with
    // analyze_trade" and "low data → run more trades to build a sample".
    // Mirrors iter839-843 footer convention. Skips when the array is empty
    // (healthy distribution, no actionable signals).
    if (report.recommendedActions.length > 0) {
      console.log("");
      console.log("Next steps:");
      for (const a of report.recommendedActions) {
        console.log(`  → ${a.reason}`);
      }
    }
  } finally {
    logger.close();
  }
}

// ── pairs stats (iter634) ────────────────────────────────────
//
// Per-pair slippage scorecard. Orthogonal to iter623 aggregator stats —
// buckets by canonical BASE/QUOTE pair instead of by aggregator. Same fan-
// out path (trades + iter619 analyses) just feeding a different pure compute.

// ── strategies list (iter651) ────────────────────────────────
//
// Directory of distinct strategy tags. Operators with many tagged trades
// (iter648) want to see what's been used — catches typos, surfaces
// little-used tags, scopes follow-up `pnl --strategy X` queries.

export async function strategiesListCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const logger = makeCliLogger(flags);
  try {
    // Iter19: `--budget` switches into the budget-consumption view. The
    // budget view doesn't intersect with the strategy directory listing
    // (it's keyed on configured rule patterns, not on which tags have
    // history) — different concept, different output, but lives under
    // the same command for discoverability.
    if (flags["budget"] === "true") {
      await renderBudgetView(flags);
      return;
    }

    const account = flags["account"] ?? activeWalletLabel();
    const { listDistinctStrategies } = await import("../db.js");
    const rows = listDistinctStrategies({
      account: flags["account"] ? account : undefined,
      chain: flags["chain"],
    });

    if (flags["json"] === "true") {
      printJson({ ok: true, count: rows.length, strategies: rows });
      return;
    }

    if (rows.length === 0) {
      const scope = flags["account"] || flags["chain"]
        ? ` (filter: account=${flags["account"] ?? "*"}, chain=${flags["chain"] ?? "*"})`
        : "";
      console.log(`No strategies tagged${scope}. Tag a trade with \`tradekit trade buy --strategy <tag>\` to start tracking.`);
      return;
    }

    console.log(`${rows.length} strateg${rows.length === 1 ? "y" : "ies"} found:`);
    console.log("");
    console.log("  Strategy                Trades   First used               Last used");
    console.log("  " + "-".repeat(85));
    for (const r of rows) {
      const first = r.firstUsed.slice(0, 19);
      const last = r.lastUsed.slice(0, 19);
      console.log(
        `  ${r.strategy.padEnd(22)} ${String(r.tradeCount).padStart(6)}   ${first}      ${last}`,
      );
    }
    if (rows.length >= 2) {
      console.log("");
      console.log("Run `tradekit pnl --strategy <tag>` to see realized PnL scoped to one strategy.");
    }
  } finally {
    logger.close();
  }
}

/**
 * Iter19: per-strategy budget consumption view. Shows configured
 * budgets (safety.strategyBudgets) with live consumption + remaining
 * USD for each cap window. Renders only when --budget is set.
 *
 * Optional --tag filters to a single rule pattern; useful when an
 * operator has many rules + only cares about one. The default
 * (no --tag) shows every configured rule.
 */
async function renderBudgetView(flags: Record<string, string>): Promise<void> {
  const config = loadConfig();
  const allBudgets = config.safety.strategyBudgets ?? [];
  if (allBudgets.length === 0) {
    if (flags["json"] === "true") {
      printJson({ ok: true, budgets: [] });
      return;
    }
    console.log(`No strategy budgets configured.`);
    console.log(``);
    console.log(`Add one with: tradekit config set safety.strategyBudgets '[{"tag":"playbook:*","lifetimeUsd":5000,"dailyUsd":500}]'`);
    return;
  }
  const tagFilter = flags["tag"];
  const budgets = tagFilter ? allBudgets.filter((r) => r.tag === tagFilter) : allBudgets;
  if (budgets.length === 0) {
    throw new ToolError("INVALID_PARAMS", `No budget rule matches --tag "${tagFilter}". Configured tags: ${allBudgets.map((r) => r.tag).join(", ")}`);
  }

  const { computeBudgetConsumption } = await import("../strategyBudget.js");
  const consumption = computeBudgetConsumption({ budgets });

  if (flags["json"] === "true") {
    printJson({ ok: true, budgets: consumption });
    return;
  }

  console.log(`${consumption.length} strategy budget${consumption.length === 1 ? "" : "s"} configured:`);
  console.log("");
  for (const c of consumption) {
    const { rule, lifetimeSpentUsd, dailySpentUsd, matchedTags, remaining } = c;
    console.log(`  Tag pattern:  ${rule.tag}`);
    if (matchedTags.length > 1 || (matchedTags.length === 1 && matchedTags[0] !== rule.tag)) {
      console.log(`  Matches:      ${matchedTags.length === 0 ? "(no trades yet)" : matchedTags.join(", ")}`);
    }
    if (rule.lifetimeUsd != null) {
      const pct = lifetimeSpentUsd != null && rule.lifetimeUsd > 0
        ? ` (${Math.min(100, (lifetimeSpentUsd / rule.lifetimeUsd) * 100).toFixed(0)}%)`
        : "";
      console.log(`  Lifetime:     $${(lifetimeSpentUsd ?? 0).toFixed(2)} / $${rule.lifetimeUsd.toFixed(2)}${pct}  →  remaining $${(remaining.lifetime ?? 0).toFixed(2)}`);
    }
    if (rule.dailyUsd != null) {
      const pct = dailySpentUsd != null && rule.dailyUsd > 0
        ? ` (${Math.min(100, (dailySpentUsd / rule.dailyUsd) * 100).toFixed(0)}%)`
        : "";
      console.log(`  24h rolling:  $${(dailySpentUsd ?? 0).toFixed(2)} / $${rule.dailyUsd.toFixed(2)}${pct}  →  remaining $${(remaining.daily ?? 0).toFixed(2)}`);
    }
    if (rule.perFireUsd != null) {
      console.log(`  Per-fire:     cap $${rule.perFireUsd.toFixed(2)}`);
    }
    console.log("");
  }
}

// ── slippage suggest (iter644) ───────────────────────────────
//
// Standalone slippage suggestion preview. Same compute the trade flow uses
// when --auto-slippage is set; this command lets operators inspect the
// suggestion without executing.

export async function slippageSuggestCommand(
  flags: Record<string, string>,
  positional: string[],
) {
  // positional layout: ["slippage", "suggest", "<base>", "<quote>"]
  const baseArg = positional[2];
  const quoteArg = positional[3];
  if (!baseArg || !quoteArg) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Usage: tradekit slippage suggest <base> <quote> [--chain X] [--account L] [--lookback-days N] [--json]",
    );
  }
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  const logger = makeCliLogger(flags);
  try {
    // Resolve symbols + addresses via the same path the trade CLI uses.
    const { resolveTradePair } = await import("../chains.js");
    const resolved = resolveTradePair(profile, baseArg, quoteArg);
    const baseSymbolUp = baseArg.toUpperCase();
    const quoteSymbolUp = quoteArg.toUpperCase();
    const baseAddress = resolved.base === "ETH" ? undefined : (resolved.base as string);
    const quoteAddress = resolved.quote as string;

    const account = flags["account"] ?? activeWalletLabel();
    const lookbackDays = flags["lookback-days"] ? parseInt(flags["lookback-days"], 10) : undefined;

    const { previewSlippageSuggestion } = await import("../slippageSuggest.js");
    const report = await previewSlippageSuggestion({
      config,
      logger,
      account,
      baseSymbol: baseSymbolUp,
      quoteSymbol: quoteSymbolUp,
      baseAddress,
      quoteAddress,
      lookbackDays,
    });

    if (flags["json"] === "true") {
      printJson({ ok: true, ...report });
      return;
    }

    const s = report.suggestion;
    console.log(`Slippage suggestion — ${report.pairSymbol} (account=${report.account})`);
    console.log("=".repeat(60));
    console.log(`  Lookback:        since ${report.since.slice(0, 10)}`);
    console.log(`  Samples found:   ${s.sampleCount}`);
    if (s.medianBps != null) {
      console.log(`  Median realized: ${s.medianBps.toFixed(1)} bps`);
    }
    if (s.p95Bps != null) {
      console.log(`  p95 realized:    ${s.p95Bps.toFixed(1)} bps`);
    }
    console.log(`  Default cap:     ${report.defaultBps} bps`);
    console.log(`  Safety max:      ${report.maxBps} bps`);
    console.log("");
    console.log(`  → Suggested:     ${s.suggestedBps} bps`);
    console.log(`     Reason:       ${s.reason}`);
    if (s.flooredAtDefault) {
      console.log("     (p95+buffer was below your default — using default)");
    }
    if (s.cappedAtMax) {
      console.log("     (p95+buffer exceeded safety.maxSlippageBps — capped)");
    }
    if (s.reason === "insufficient_history" || s.reason === "no_history") {
      console.log("");
      console.log("  Need >= 5 historical samples on this pair for a data-driven suggestion.");
      console.log("  Tip: run `tradekit reconcile --backfill-slippage` to populate from legacy success trades.");
    }
  } finally {
    logger.close();
  }
}

export async function pairStatsCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const logger = makeCliLogger(flags);
  try {
    const account = flags["account"] ?? activeWalletLabel();
    const { parseDateFilter } = await import("../format.js");
    const since = flags["since"]
      ? (parseDateFilter(flags["since"], "since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString())
      : new Date(Date.now() - 30 * 86_400_000).toISOString();

    const { recentTrades } = await import("../db.js");
    // Iter663: --strategy filter (mirrors aggregator stats).
    const rows = recentTrades({ chain: flags["chain"], account, since, limit: 10_000, strategy: flags["strategy"] });

    const { analyzeStoredTrade } = await import("../tradeAnalysis.js");
    const successRows = rows.filter((r) => r.status === "success");
    const analyses = [];
    if (successRows.length > 0) {
      const { loadReadOnlyWallet } = await import("../wallet.js");
      const walletByChain = new Map<string, ReturnType<typeof loadReadOnlyWallet>>();
      for (const row of successRows) {
        try {
          let wallet = walletByChain.get(row.chain);
          if (!wallet) {
            const profile = resolveProfile(row.chain, config);
            const extraRpcs = config.chains[row.chain]?.rpcs ?? [];
            wallet = loadReadOnlyWallet(profile, extraRpcs, account);
            walletByChain.set(row.chain, wallet);
          }
          const profile = resolveProfile(row.chain, config);
          analyses.push(
            await analyzeStoredTrade({ row, publicClient: wallet.publicClient, profile, logger }),
          );
        } catch (e) {
          logger.debug(`pair stats: analysis skipped for ${row.tx_hash}: ${(e as Error).message}`);
        }
      }
    }

    const { computePairStats } = await import("../pairStats.js");
    const report = computePairStats(rows, analyses, { since });

    if (flags["json"] === "true") {
      printJson({ ok: true, ...report });
      return;
    }

    if (report.byPair.length === 0) {
      console.log("No trades found in the window. Use --since to widen the lookback.");
      return;
    }

    const sinceStr = report.since ? new Date(report.since).toISOString().slice(0, 10) : "all-time";
    // Iter758: elapsedMs suffix — parity with iter731/744 reconcile/pnl/aggregator.
    const elapsedSuffix = report.elapsedMs != null
      ? `  (${(report.elapsedMs / 1000).toFixed(1)}s)`
      : "";
    // Iter815: severity badge — parallel to aggregator stats badge above.
    const pairBadge = report.severity === "ok" ? "🟢 OK  " : "🟡 WARN";
    console.log(`${pairBadge}  Pair slippage — ${report.totalTrades} trade${report.totalTrades === 1 ? "" : "s"} since ${sinceStr}${elapsedSuffix}`);
    console.log("");
    console.log("  Pair                 Trades    Success    Median slip   p95 slip    Avg slip    Volume(USD)            Last");
    console.log("  " + "-".repeat(125));
    // Iter721: --limit replaces the hardcoded 30-cap. Aggregate math
    // (totalTrades, warnings) is computed pre-trim so the totals still
    // reflect the full pair set — only the per-row detail is capped.
    // Default 30 preserves pre-iter721 behavior for existing scripts.
    const pairLimit = parseIntFlag(flags["limit"], "--limit", { min: 1, max: 1000 }) ?? 30;
    for (const p of report.byPair.slice(0, pairLimit)) {
      const successRate = p.successRate != null ? `${(p.successRate * 100).toFixed(1)}%` : "—";
      const median = p.medianSlippageBps != null ? `${p.medianSlippageBps.toFixed(1)} bps` : "—";
      const p95 = p.p95SlippageBps != null ? `${p.p95SlippageBps.toFixed(1)} bps` : "—";
      const avg = p.avgSlippageBps != null ? `${p.avgSlippageBps.toFixed(1)} bps` : "—";
      const vol = p.totalUsdVolume > 0
        ? `$${p.totalUsdVolume.toLocaleString("en-US", { maximumFractionDigits: 0 })}${p.volumeNotePartial ? "+" : ""}`
        : "—";
      // Iter702: lastSeen as YYYY-MM-DD (full ISO in --json).
      const lastSeen = p.lastSeen ? p.lastSeen.slice(0, 10) : "—";
      console.log(
        `  ${p.pair.padEnd(20)} ${String(p.tradeCount).padEnd(9)} ${successRate.padEnd(10)} ${median.padEnd(13)} ${p95.padEnd(11)} ${avg.padEnd(11)} ${vol.padEnd(22)} ${lastSeen}`,
      );
    }
    if (report.byPair.length > pairLimit) {
      console.log(`  … and ${report.byPair.length - pairLimit} more (use --limit N or --json for the full list)`);
    }
    // Iter690: pair underperformer warnings.
    if (report.warnings && report.warnings.length > 0) {
      console.log("");
      for (const w of report.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }
    // Iter673: per-pair failure reason footer. Skips pairs with no failures
    // to keep the output focused. Cap at top 3 per pair for compactness.
    const pairsWithFailures = report.byPair.filter((p) => p.failureReasons.length > 0);
    if (pairsWithFailures.length > 0) {
      console.log("");
      console.log("  Failure reasons by pair:");
      for (const p of pairsWithFailures.slice(0, 10)) {
        const top3 = p.failureReasons.slice(0, 3);
        const summary = top3.map((r) => `${r.reason}=${r.count}`).join("  ");
        console.log(`    ${p.pair.padEnd(20)}  ${summary}${p.failureReasons.length > 3 ? `  (+${p.failureReasons.length - 3} more)` : ""}`);
      }
      if (pairsWithFailures.length > 10) {
        console.log(`    … and ${pairsWithFailures.length - 10} more pair${pairsWithFailures.length - 10 === 1 ? "" : "s"} with failures (use --json)`);
      }
    }
    // Iter844: surface iter836 recommendedActions inline. Pair stats
    // dispatches cover "high-slip pair detected → tune slippage cap or check
    // aggregator routing". Mirrors iter839-843 footer convention.
    if (report.recommendedActions.length > 0) {
      console.log("");
      console.log("Next steps:");
      for (const a of report.recommendedActions) {
        console.log(`  → ${a.reason}`);
      }
    }
  } finally {
    logger.close();
  }
}

// ── pnl ──────────────────────────────────────────────────────

export async function pnlCommand(flags: Record<string, string>) {
  await withWatch(flags, () => pnlCommandOnce(flags));
}

async function pnlCommandOnce(flags: Record<string, string>) {
  const chain = flags["chain"];
  // Iter501: use activeWalletLabel so the implicit account falls back to "keystore"
  // when accounts.json is orphaned (mnemonic.json missing) — matches what loadWallet
  // would do, so the filter matches the rows that the actual trade flow wrote.
  // Iter624: --accounts a,b,c | --accounts all resolves to multi-account aggregate
  // path; --account L (singular) keeps the original single-account behavior.
  const account = flags["account"] ?? activeWalletLabel();
  const logger = makeCliLogger(flags);
  try {
    // Iter615: --since/--until is a single window; --windows accepts a comma list
    // of relative durations or labels. Each comma-list entry can be:
    //   - "all": no time bound (label="all-time")
    //   - "Nd"/"Nh"/"today"/"yesterday": same shortcut grammar as audit/--since (parseDateFilter)
    //   - ISO "YYYY-MM-DD..YYYY-MM-DD": explicit since..until pair
    //   - ISO "YYYY-MM-DD": since=that date, until=now
    const { parseDateFilter } = await import("../format.js");
    const windows: import("../pnl.js").PnLWindow[] = [];
    if (flags["since"] || flags["until"]) {
      const since = flags["since"] ? parseDateFilter(flags["since"], "since") ?? undefined : undefined;
      const until = flags["until"] ? parseDateFilter(flags["until"], "until") ?? undefined : undefined;
      windows.push({ since, until, label: "custom" });
    }
    if (flags["windows"]) {
      const specs = flags["windows"].split(",").map((s) => s.trim()).filter(Boolean);
      for (const spec of specs) {
        if (spec.toLowerCase() === "all" || spec.toLowerCase() === "all-time") {
          windows.push({ label: "all-time" });
          continue;
        }
        // ISO range form "FROM..TO"
        if (spec.includes("..")) {
          const [a, b] = spec.split("..");
          const since = parseDateFilter(a, "windows") ?? undefined;
          const until = parseDateFilter(b, "windows") ?? undefined;
          windows.push({ since, until, label: spec });
          continue;
        }
        // Relative shortcut or ISO date
        const since = parseDateFilter(spec, "windows") ?? undefined;
        windows.push({ since, label: spec });
      }
    }

    // Iter624: multi-account path. --accounts a,b,c | --accounts all resolves
    // a label list and runs aggregateMultiAccountPnL. Default (no --accounts)
    // stays on the single-account computePnL — same behavior as pre-iter624.
    const accountsFlag = flags["accounts"];
    if (accountsFlag) {
      const { listAccounts, unknownAccountError } = await import("../accounts.js");
      const { getKeystoreAddress } = await import("../wallet.js");
      const { KEYSTORE_LABEL } = await import("../constants.js");
      const { aggregateMultiAccountPnL } = await import("../pnl.js");

      const file = listAccounts();
      const knownLabels = [
        ...(file?.accounts ?? []).map((a) => a.label),
        ...(getKeystoreAddress() ? [KEYSTORE_LABEL] : []),
      ];

      let labels: string[];
      if (accountsFlag === "all") {
        labels = knownLabels;
      } else {
        labels = accountsFlag.split(",").map((s) => s.trim()).filter(Boolean);
        for (const p of labels) {
          if (!knownLabels.includes(p)) throw unknownAccountError(p, knownLabels);
        }
      }
      if (labels.length === 0) {
        throw new ToolError(
          "WALLET_NOT_FOUND",
          "No accounts to aggregate. Run `tradekit account create-mnemonic` or pass explicit labels.",
        );
      }
      const aggregate = await aggregateMultiAccountPnL(
        labels,
        { chain, windows: windows.length > 0 ? windows : undefined, strategy: flags["strategy"] },
        logger,
      );
      if (flags["json"] === "true") {
        printJson({ ok: true, ...aggregate });
        applyPnlStrictExit(flags, aggregate.dataFreshness, aggregate.errors.length);
        return;
      }
      // Text mode: aggregate header + per-account breakdown + windows table.
      // Iter819: severity badge — parity with formatPnLReport.
      const aggBadge = aggregate.severity === "ok" ? "🟢 OK  " : "🟡 WARN";
      console.log(`${aggBadge}  PnL aggregate across ${aggregate.accounts.length} account${aggregate.accounts.length === 1 ? "" : "s"} (${aggregate.accounts.join(", ")})${chain ? ` on ${chain}` : ""}:`);
      // Iter741: aggregate stale-sync warning — one line per stale bookmark.
      // Mirrors the per-account formatPnLReport rendering for consistency.
      if (aggregate.dataFreshness && aggregate.dataFreshness.staleBookmarks.length > 0) {
        for (const s of aggregate.dataFreshness.staleBookmarks) {
          const ageStr = s.ageHours >= 24
            ? `${(s.ageHours / 24).toFixed(1)}d`
            : `${s.ageHours.toFixed(1)}h`;
          console.log(`  ⚠ Sync stale: ${s.chain}/${s.account} bookmark not advanced in ${ageStr} — PnL may be missing recent trades.`);
        }
      }
      console.log("");
      console.log(`  Total realized:     ${fmtSignedUsd(aggregate.totalRealizedUsd)}`);
      console.log(`  Total unrealized:   ${fmtSignedUsd(aggregate.totalUnrealizedUsd)}`);
      console.log(`  Total gas:          ${fmtSignedUsd(-aggregate.totalGasUsd)}`);
      console.log(`  Net realized:       ${fmtSignedUsd(aggregate.totalRealizedAfterGasUsd)}`);
      if (aggregate.errors.length > 0) {
        console.log("");
        console.log(`  Errors: ${aggregate.errors.length} account${aggregate.errors.length === 1 ? "" : "s"} failed`);
        for (const e of aggregate.errors) {
          console.log(`    ✗ ${e.account}: ${e.message}`);
        }
      }
      if (aggregate.windows && aggregate.windows.length > 0) {
        console.log("");
        console.log("Windowed realized PnL (aggregate):");
        console.log("  Window               Realized($)   Gas($)        Net($)");
        console.log("  -------------------------------------------------------------");
        for (const w of aggregate.windows) {
          const label = (w.label ?? `${w.since ?? "−∞"}..${w.until ?? "now"}`).padEnd(20);
          console.log(
            `  ${label} ${w.realizedUsd.toFixed(2).padEnd(13)} ${w.totalGasUsd.toFixed(2).padEnd(13)} ${w.realizedAfterGasUsd.toFixed(2)}`,
          );
        }
      }
      if (aggregate.perAccount.length > 1) {
        console.log("");
        console.log("Per-account breakdown:");
        console.log("  Account              Realized($)   Unrealized($)   Gas($)        Net($)");
        console.log("  -------------------------------------------------------------------------");
        // Iter763: per-account stale marker. The header banner says "something
        // is stale"; the per-row marker says WHICH ROW contributed misleadingly.
        // Operators scanning aggregate breakdowns get an at-a-glance signal
        // instead of needing to cross-reference the header warning against the
        // table. Reads from each per-account report's iter741 dataFreshness;
        // ANY stale bookmark for the account marks the row.
        for (const r of aggregate.perAccount) {
          const isStale = (r.dataFreshness?.staleBookmarks.length ?? 0) > 0;
          const staleBit = isStale ? "  [sync stale]" : "";
          console.log(
            `  ${r.account.padEnd(20)} ${r.totalRealizedUsd.toFixed(2).padEnd(13)} ${r.totalUnrealizedUsd.toFixed(2).padEnd(15)} ${r.totalGasUsd.toFixed(2).padEnd(13)} ${r.totalRealizedAfterGasUsd.toFixed(2)}${staleBit}`,
          );
        }
      }
      applyPnlStrictExit(flags, aggregate.dataFreshness, aggregate.errors.length);
      return;
    }

    const report = await computePnL(
      account,
      { chain, windows: windows.length > 0 ? windows : undefined, strategy: flags["strategy"] },
      logger,
    );
    if (flags["json"] === "true") {
      // Iter445: spread the report under an `ok: true` envelope for parity with
      // iter431/432 (account list, wallet view). Purely additive — every existing
      // field (account, chain, positions, gas, totals, timestamp) is unchanged.
      printJson({ ok: true, ...report });
    } else {
      console.log(formatPnLReport(report));
      // Iter615: append a per-window summary table when windows were requested.
      if (report.windows && report.windows.length > 0) {
        console.log("");
        console.log("Windowed realized PnL:");
        console.log("  Window               Realized($)   Gas($)        Net($)");
        console.log("  -------------------------------------------------------------");
        for (const w of report.windows) {
          const label = (w.label ?? `${w.since ?? "−∞"}..${w.until ?? "now"}`).padEnd(20);
          console.log(
            `  ${label} ${w.realizedUsd.toFixed(2).padEnd(13)} ${w.totalGasUsd.toFixed(2).padEnd(13)} ${w.realizedAfterGasUsd.toFixed(2)}`,
          );
          if (w.positions.length > 0) {
            for (const p of w.positions) {
              console.log(`      ${p.symbol.padEnd(10)} ${p.chain.padEnd(10)} ${p.realizedUsd.toFixed(2)}`);
            }
          }
        }
      }
      // Iter627: cross-chain by-symbol roll-up. Show by default when the
      // operator has positions on >1 chain — that's when the rollup carries
      // actual new information vs the existing per-chain positions table.
      // --by-symbol forces the display even on single-chain reports;
      // --no-by-symbol suppresses it.
      const symbolRollup = report.byTokenSymbol ?? [];
      const multiChain = symbolRollup.some((r) => r.chains.length > 1);
      const forceOn = flags["by-symbol"] === "true";
      const forceOff = flags["no-by-symbol"] === "true";
      if (symbolRollup.length > 0 && !forceOff && (forceOn || multiChain)) {
        console.log("");
        console.log("By symbol (cross-chain roll-up):");
        console.log("  Symbol     Amount             AvgCost($)     Realized($)   Unrealized($)  Total($)    Chains");
        console.log("  " + "-".repeat(102));
        for (const r of symbolRollup) {
          const unpriced = r.unpricedChainCount > 0 ? `*${r.unpricedChainCount}` : "";
          const chainsStr = r.chains.join(",") + unpriced;
          console.log(
            `  ${r.symbol.padEnd(10)} ${r.amount.padEnd(18)} ${r.avgCostUsd.toFixed(2).padEnd(14)} ${r.realizedUsd.toFixed(2).padEnd(13)} ${r.unrealizedUsd.toFixed(2).padEnd(14)} ${r.totalUsd.toFixed(2).padEnd(11)} ${chainsStr}`,
          );
        }
        if (symbolRollup.some((r) => r.unpricedChainCount > 0)) {
          console.log("  * = N chains had no current-price oracle; their positions don't contribute to unrealized.");
        }
      }
      // Iter636: per-aggregator realized USD breakdown. Show when >1
      // aggregator appears (otherwise it's redundant with the total realized).
      const byAgg = report.byAggregator ?? [];
      if (byAgg.length > 1 || flags["by-aggregator"] === "true") {
        console.log("");
        console.log("By aggregator (realized USD):");
        console.log("  Aggregator       Realized($)     Trades");
        console.log("  " + "-".repeat(45));
        for (const a of byAgg) {
          console.log(
            `  ${a.aggregator.padEnd(16)} ${a.realizedUsd.toFixed(2).padStart(13)}     ${a.tradeCount}`,
          );
        }
      }
      // Iter639: per-pair realized USD breakdown. Same display gate as
      // byAggregator — show when >1 pair (otherwise the by-symbol table
      // already covers the single-pair case).
      const byPair = report.byPair ?? [];
      if (byPair.length > 1 || flags["by-pair"] === "true") {
        console.log("");
        console.log("By pair (realized USD):");
        console.log("  Pair                  Realized($)     Trades");
        console.log("  " + "-".repeat(48));
        for (const p of byPair) {
          console.log(
            `  ${p.pair.padEnd(20)} ${p.realizedUsd.toFixed(2).padStart(13)}     ${p.tradeCount}`,
          );
        }
      }
      // Iter649: per-strategy realized USD breakdown. Display gate: show when
      // there's at least one strategy-tagged row + something else (multiple
      // strategies, or untagged vs tagged). Pure "(none)"-only operators see
      // nothing useful here.
      const byStrategy = report.byStrategy ?? [];
      if ((byStrategy.length > 1 || flags["by-strategy"] === "true") && byStrategy.some((s) => s.strategy !== "(none)")) {
        console.log("");
        console.log("By strategy (realized USD):");
        console.log("  Strategy              Realized($)     Trades");
        console.log("  " + "-".repeat(48));
        for (const s of byStrategy) {
          console.log(
            `  ${s.strategy.padEnd(20)} ${s.realizedUsd.toFixed(2).padStart(13)}     ${s.tradeCount}`,
          );
        }
      }
    }
    applyPnlStrictExit(flags, report.dataFreshness, 0);
  } finally {
    logger.close();
  }
}

/**
 * Iter756: shared --strict gate for the pnl command. Exits 1 when (a) any
 * stale-sync bookmark is present in dataFreshness OR (b) errorCount > 0 for
 * the multi-account branch's per-account errors. Both signal "the PnL numbers
 * may be misleading" — operators piping `pnl --json` into dashboards / alerting
 * gate on the exit code rather than parsing the structure. Default behavior
 * unchanged (back-compat). Mirrors doctor --strict / health --strict (iter755)
 * / trades sync --strict (iter754). process.exitCode (not process.exit) so
 * main()'s audit-insert finally block still runs (iter351 pattern).
 */
function applyPnlStrictExit(
  flags: Record<string, string>,
  dataFreshness: { staleBookmarks: { account: string }[] } | undefined,
  errorCount: number,
): void {
  const strict = flags["strict"] === "true" || flags["strict"] === "";
  if (!strict) return;
  const hasStale = (dataFreshness?.staleBookmarks.length ?? 0) > 0;
  const hasErrors = errorCount > 0;
  if (hasStale || hasErrors) process.exitCode = 1;
}

/** Iter624: format a signed USD number with leading sign. */
function fmtSignedUsd(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

// ── trades (view + export) ───────────────────────────────────

export async function tradesCommand(flags: Record<string, string>, positional: string[] = []) {
  // Iter607: `tradekit trades sync` subcommand — backfill local DB from
  // on-chain history. Read-only on local state; touches the chain via
  // eth_getLogs.
  if (positional[1] === "sync") {
    return await tradesSyncCommand(flags);
  }
  // Iter619: `tradekit trades analyze [<tx-hash> | --recent N]` — post-trade
  // execution quality analysis. Compares stored quoted amounts against the
  // on-chain achieved amounts; reports realized slippage + quality verdict.
  if (positional[1] === "analyze") {
    return await tradesAnalyzeCommand(flags, positional);
  }
  // Iter739: `tradekit trades bookmarks` — list per-(chain,account,owner) sync
  // bookmarks with age + last-synced block. Cron operators running multiple
  // accounts × chains need a fast "where is each sync pointing?" view.
  if (positional[1] === "bookmarks") {
    return await tradesBookmarksCommand(flags);
  }
  await withWatch(flags, () => tradesCommandOnce(flags));
}

// Iter739: `tradekit trades bookmarks` — operator-facing listing of sync
// bookmarks. Read-only. Age computed in-process from updatedAt ISO so the
// output reads naturally ("2h ago", "3d ago") without an extra column.
async function tradesBookmarksCommand(flags: Record<string, string>) {
  const { listSyncBookmarks } = await import("../db.js");
  const bookmarks = listSyncBookmarks();
  const now = Date.now();
  // Iter767: pre-compute fresh/stale counts using the same 48h threshold as
  // iter741 PnL / iter746 accounts / iter748 MCP / iter767 MCP list_sync_bookmarks.
  // One staleness rule across every surface; operators learn it once.
  const STALE_HOURS = 48;
  const thresholdMs = STALE_HOURS * 3_600_000;
  const summary = { fresh: 0, stale: 0, staleAfterHours: STALE_HOURS };
  const rows = bookmarks.map((b) => {
    const ageMs = now - new Date(b.updatedAt).getTime();
    if (ageMs > thresholdMs) summary.stale++;
    else summary.fresh++;
    return {
      chain: b.chain,
      account: b.account,
      owner: b.owner,
      lastSyncedBlock: b.lastSyncedBlock.toString(),
      updatedAt: b.updatedAt,
      ageMs,
    };
  });

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      bookmarks: rows,
      count: rows.length,
      summary,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (rows.length === 0) {
    console.log("No sync bookmarks. Run `tradekit trades sync` to create one.");
    return;
  }

  // Iter767: surface stale count in the header so operators see it without
  // computing ages mentally row-by-row. Inline marker on stale rows mirrors
  // iter746 accounts-list convention.
  const staleSuffix = summary.stale > 0 ? `, ${summary.stale} stale` : "";
  // Iter822: severity badge — parity with iter808-821 across CLI surfaces.
  const bookBadge = summary.stale > 0 ? "🟡 WARN" : "🟢 OK  ";
  console.log(`${bookBadge}  Sync bookmarks (${rows.length}${staleSuffix}):`);
  for (const r of rows) {
    // Single-line per bookmark: chain/account, last block, age. Owner shown
    // truncated since it's recoverable from accounts list.
    const ownerShort = `${r.owner.slice(0, 6)}…${r.owner.slice(-4)}`;
    const staleBit = r.ageMs > thresholdMs ? "  [stale]" : "";
    console.log(`  ${r.chain}/${r.account}  ${ownerShort}  block ${r.lastSyncedBlock}  ${formatAge(r.ageMs)} ago${staleBit}`);
  }
  console.log(`\nClear a bookmark with: tradekit trades sync --reset-bookmark --chain X --account Y`);
}

// Iter739: compact age formatter for the bookmarks list. Single resolution —
// the most-significant unit. Matches the "Resumed from bookmark" / "5d ago"
// style operators already see in audit and pending-trade output.
function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

// Iter619: post-trade quality analysis. The pure-core comparison lives in
// tradeAnalysis.ts; this orchestrator handles the CLI shape (single hash vs
// --recent N) + formatting.
async function tradesAnalyzeCommand(flags: Record<string, string>, positional: string[]) {
  const config = loadConfig();
  const logger = makeCliLogger(flags);
  try {
    const { recentTrades } = await import("../db.js");
    const { analyzeStoredTrade } = await import("../tradeAnalysis.js");
    const { loadReadOnlyWallet } = await import("../wallet.js");

    // Mode 1: explicit tx hash → look it up in DB, analyze the row.
    // Mode 2: --recent N → analyze the N most-recent SUCCESS rows.
    const txHash = positional[2];
    const recent = flags["recent"] ? parseInt(flags["recent"], 10) : null;
    if (!txHash && !recent) {
      throw new ToolError(
        "INVALID_PARAMS",
        "Usage: tradekit trades analyze <tx-hash> [--chain X] [--json] OR tradekit trades analyze --recent N [--chain X] [--json]",
      );
    }

    let rows;
    if (txHash) {
      const candidate = recentTrades({ chain: flags["chain"], account: flags["account"], limit: 1000 })
        .filter((r) => r.tx_hash.toLowerCase() === txHash.toLowerCase());
      if (candidate.length === 0) {
        throw new ToolError(
          "INVALID_PARAMS",
          `No trade row found for tx ${txHash} in the DB. The tx may not have been recorded — try \`tradekit trade import ${txHash}\` first.`,
        );
      }
      rows = candidate;
    } else {
      // Iter667: --status filter. Default "success" preserves pre-iter667
      // behavior. "failed" unlocks the iter666 revert-reason batch view —
      // operators investigating a wave of failures can run
      // `trades analyze --recent 10 --status=failed` to see all reasons at
      // once. "all" includes everything.
      //
      // Pool sizing: when filtering, query 10× the requested N from the DB
      // and post-filter, so `--recent 10 --status=failed` means "last 10
      // failed trades" rather than "the failed rows among the last 10 of
      // any status" (sparse for healthy installs).
      const statusFilter = (flags["status"] ?? "success").toLowerCase();
      const VALID_STATUS = new Set(["success", "failed", "all"]);
      if (!VALID_STATUS.has(statusFilter)) {
        throw new ToolError(
          "INVALID_PARAMS",
          `Invalid --status "${flags["status"]}" — expected one of: success, failed, all.`,
        );
      }
      const wantedN = recent ?? 10;
      const poolSize = statusFilter === "all" ? wantedN : wantedN * 10;
      const pool = recentTrades({
        chain: flags["chain"],
        account: flags["account"],
        limit: poolSize,
        // Iter664/iter665: scope analyses to a strategy or aggregator. Matches
        // the iter663 filter pattern across aggregator/pair/trades commands.
        // Useful for "analyze my last 20 DCA trades" or "analyze my last 20
        // openocean trades" without falling back to jq.
        strategy: flags["strategy"],
        aggregator: flags["aggregator"],
      });
      const matching =
        statusFilter === "all"
          ? pool
          : pool.filter((r) => r.status === statusFilter);
      rows = matching.slice(0, wantedN);
      if (rows.length === 0) {
        const noun = statusFilter === "all" ? "trades" : `${statusFilter} trades`;
        if (flags["json"] === "true") {
          printJson({ ok: true, count: 0, analyses: [], note: `No ${noun} to analyze.` });
          return;
        }
        console.log(`No ${noun} in the recent set — nothing to analyze.`);
        return;
      }
    }

    // Build a per-chain wallet cache. The analyzer needs the publicClient +
    // profile; loadReadOnlyWallet caches by chain name internally so this is
    // safe to call once per chain.
    const walletByChain = new Map<string, ReturnType<typeof loadReadOnlyWallet>>();
    const analyses = [];
    for (const row of rows) {
      let wallet = walletByChain.get(row.chain);
      if (!wallet) {
        const profile = resolveProfile(row.chain, config);
        const extraRpcs = config.chains[row.chain]?.rpcs ?? [];
        wallet = loadReadOnlyWallet(profile, extraRpcs, flags["account"]);
        walletByChain.set(row.chain, wallet);
      }
      const profile = resolveProfile(row.chain, config);
      const analyzed = await analyzeStoredTrade({
        row,
        publicClient: wallet.publicClient,
        profile,
        logger,
      });
      analyses.push(analyzed);
    }

    // Iter778: --strict exit-code gate. Triggers when any analyzed trade
    // exceeded the slippage thresholds (major_slip / extreme_slip).
    // "reverted" / "pending" stay exit 0 — reverted is a known failure
    // tracked elsewhere (reconcile + iter669 revert_reason), pending is
    // mid-lifecycle and not a quality signal yet. minor_slip stays exit 0
    // too — small slippage is normal, alerting on it would flood cron mail.
    // Pipeline pattern:
    //   tradekit trades analyze --recent 10 --strict  →  cron alert when
    //   recent execution quality degrades.
    const strict = flags["strict"] === "true" || flags["strict"] === "";
    const hasBadSlip = analyses.some(
      (a) => a.finding.code === "major_slip" || a.finding.code === "extreme_slip",
    );

    if (flags["json"] === "true") {
      printJson({ ok: true, count: analyses.length, analyses });
      if (strict && hasBadSlip) process.exitCode = 1;
      return;
    }

    // Iter816: severity badge — parity with iter808-815 convention. Reuses
    // hasBadSlip (same trigger as iter778 --strict) so the badge and the
    // exit-code gate fire on the same condition.
    const analyzeBadge = hasBadSlip ? "🟡 WARN" : "🟢 OK  ";

    // Text mode: one block per row when analyzing a single hash, one-line
    // summary table for --recent N.
    if (txHash) {
      const a = analyses[0];
      console.log(`${analyzeBadge}  Trade analysis for ${a.txHash}:`);
      console.log(`  Chain:     ${a.chain}`);
      console.log(`  Direction: ${a.direction} ${a.baseSymbol ?? "?"} / ${a.quoteSymbol ?? "?"}`);
      console.log(`  Verdict:   ${verdictBadge(a.finding.code)} ${a.finding.code}`);
      console.log(`  ${a.finding.message}`);
      if (a.comparison) {
        console.log("");
        console.log("  Quoted vs Actual:");
        console.log(`    base:  quoted=${a.comparison.quoted.baseAmount}   actual=${a.comparison.actual.baseAmount}`);
        console.log(`    quote: quoted=${a.comparison.quoted.quoteAmount}  actual=${a.comparison.actual.quoteAmount}`);
        console.log(`    price: quoted=${a.comparison.quoted.pricePerBase.toFixed(8)}  actual=${a.comparison.actual.pricePerBase.toFixed(8)}`);
        console.log(`    Realized slippage: ${a.comparison.slippageBps.toFixed(1)} bps`);
        console.log(`    Output delta:      ${a.comparison.outputDelta >= 0 ? "+" : ""}${a.comparison.outputDelta.toFixed(8)} (${a.direction === "buy" ? a.baseSymbol : a.quoteSymbol})`);
      }
      if (a.gasCostNative) {
        console.log(`  Gas cost: ${a.gasCostNative} (native)`);
      }
    } else {
      // Iter667: header noun reflects the actual status mix. Pre-iter667 it
      // was hardcoded "success" which became misleading once --status=failed/
      // all was allowed.
      const allFailed = analyses.length > 0 && analyses.every((a) => a.finding.code === "reverted");
      const allSuccess = analyses.length > 0 && analyses.every((a) => a.finding.code !== "reverted" && a.finding.code !== "pending");
      const headerNoun = allFailed ? "failed trade" : allSuccess ? "success trade" : "trade";
      console.log(`${analyzeBadge}  Trade analysis for last ${analyses.length} ${headerNoun}${analyses.length === 1 ? "" : "s"}:`);
      console.log("");
      console.log("  Verdict      Direction  Pair                  Slippage bps   Tx");
      console.log("  " + "-".repeat(98));
      for (const a of analyses) {
        const pair = `${a.baseSymbol ?? "?"} / ${a.quoteSymbol ?? "?"}`.padEnd(20);
        const slip = a.comparison ? `${a.comparison.slippageBps.toFixed(1).padStart(8)} bps` : "    —    ";
        const verdictStr = `${verdictBadge(a.finding.code)} ${a.finding.code}`.padEnd(20);
        const txShort = a.txHash.slice(0, 10) + "…" + a.txHash.slice(-8);
        console.log(`  ${verdictStr} ${a.direction.padEnd(9)} ${pair}  ${slip}    ${txShort}`);
        // Iter668: per-row footer for reverted trades — surfaces the iter666-
        // extracted revert reason inline so an operator running
        // `--status=failed` sees WHY each trade reverted right in the table.
        // Matches the pattern in `trades` text mode (notes footer line).
        if (a.revertReason) {
          console.log(`       ↳ ${compactMessage(a.revertReason, 100)}`);
        }
      }
      // Aggregate one-liner: median slippage + count by verdict.
      const slips = analyses.flatMap((a) => (a.comparison ? [a.comparison.slippageBps] : []));
      const counts: Record<string, number> = {};
      for (const a of analyses) counts[a.finding.code] = (counts[a.finding.code] ?? 0) + 1;
      if (slips.length > 0) {
        const sorted = [...slips].sort((x, y) => x - y);
        const median = sorted[Math.floor(sorted.length / 2)];
        const avg = sorted.reduce((s, n) => s + n, 0) / sorted.length;
        console.log("");
        console.log(`  Median slippage: ${median.toFixed(1)} bps   Avg: ${avg.toFixed(1)} bps   Counted: ${slips.length}/${analyses.length}`);
      }
      console.log(`  By verdict: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    }
    if (strict && hasBadSlip) process.exitCode = 1;
  } finally {
    logger.close();
  }
}

function verdictBadge(code: string): string {
  switch (code) {
    case "excellent":
    case "ok":
      return "🟢";
    case "minor_slip":
      return "🟡";
    case "major_slip":
    case "extreme_slip":
      return "🔴";
    case "reverted":
    case "pending":
      return "⚪";
    default:
      return "❓";
  }
}

async function tradesSyncCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  const logger = makeCliLogger(flags);

  try {
    const { loadReadOnlyWallet } = await import("../wallet.js");
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    const wallet = loadReadOnlyWallet(profile, extraRpcs, flags["account"]);
    const accountLabel = flags["account"] ?? wallet.label;

    // Iter738: --reset-bookmark clears the stored bookmark BEFORE deriving the
    // block range. Then proceeds through the normal flow (which will see no
    // bookmark and fall back to 30d). Done before resolveBookmarkAware so the
    // reset is observable in this same run.
    if (flags["reset-bookmark"] === "true") {
      const { clearSyncBookmark } = await import("../db.js");
      const cleared = clearSyncBookmark(chainName, accountLabel, wallet.account.address);
      if (cleared > 0) {
        console.log(`Cleared sync bookmark for ${chainName}/${accountLabel}.`);
      } else {
        console.log(`No sync bookmark to clear for ${chainName}/${accountLabel}.`);
      }
    }

    // Block range: --from-block + --to-block (both numbers) OR --since (default-relative).
    // Default --since: 30d. Default --to-block: "latest" (resolved via getBlockNumber).
    const toBlock: bigint = flags["to-block"]
      ? BigInt(flags["to-block"])
      : await wallet.publicClient.getBlockNumber();

    const { resolveBookmarkAwareFromBlock } = await import("../activitySync.js");
    // Iter738: --no-bookmark opts out of resume; default is bookmark-aware.
    const useBookmark = flags["no-bookmark"] !== "true";
    const explicitFromBlock = flags["from-block"] ? BigInt(flags["from-block"]) : undefined;
    const sinceDaysExplicit = flags["since-days"] ? parseInt(flags["since-days"], 10) : undefined;
    const { fromBlock, bookmarkUsed, resumedFromBlock } = resolveBookmarkAwareFromBlock({
      chain: chainName,
      account: accountLabel,
      owner: wallet.account.address as Address,
      toBlock,
      ...(explicitFromBlock != null ? { explicitFromBlock } : {}),
      ...(sinceDaysExplicit != null ? { sinceDaysExplicit } : {}),
      useBookmark,
    });

    const chunkSize = flags["chunk-size"] ? BigInt(flags["chunk-size"]) : undefined;

    const { scanWalletActivity, advanceBookmarkAfterSync } = await import("../activitySync.js");
    const report = await scanWalletActivity({
      publicClient: wallet.publicClient,
      profile,
      owner: wallet.account.address as Address,
      fromBlock,
      toBlock,
      account: accountLabel,
      logger,
      chunkSize,
    });

    // Iter738: advance bookmark on full success. Per-tx errors don't block —
    // the eth_getLogs scan was complete; per-tx decode failures are caller's
    // problem (they show up in errors[]).
    const advancedToBlock = useBookmark
      ? advanceBookmarkAfterSync({
          chain: chainName,
          account: accountLabel,
          owner: wallet.account.address as Address,
          toBlock,
          chunkErrors: report.chunkErrors,
        })
      : undefined;

    // Attach bookmark metadata for the user-facing report. Only present when
    // any bookmark interaction occurred — keeps the report compact when the
    // operator explicitly overrode and didn't touch the bookmark layer.
    if (bookmarkUsed || advancedToBlock !== undefined) {
      report.bookmark = {
        used: bookmarkUsed,
        ...(resumedFromBlock != null ? { resumedFromBlock } : {}),
        ...(advancedToBlock !== undefined ? { advancedToBlock } : {}),
      };
    }

    if (flags["json"] === "true") {
      // BigInts can't survive JSON.stringify — coerce to strings.
      const bookmarkJson = report.bookmark
        ? {
            used: report.bookmark.used,
            ...(report.bookmark.resumedFromBlock != null
              ? { resumedFromBlock: report.bookmark.resumedFromBlock.toString() }
              : {}),
            ...(report.bookmark.advancedToBlock != null
              ? { advancedToBlock: report.bookmark.advancedToBlock.toString() }
              : {}),
          }
        : undefined;
      printJson({
        ok: true,
        ...report,
        fromBlock: report.fromBlock.toString(),
        toBlock: report.toBlock.toString(),
        ...(bookmarkJson ? { bookmark: bookmarkJson } : {}),
      });
      return;
    }

    // Iter736: elapsedMs suffix on the header — parity with iter731
    // reconcile/pnl. RPC-heavy log scanning is the slowest CLI command, so the
    // timing is more useful here than anywhere else.
    const elapsedSuffix = report.elapsedMs != null
      ? ` (${(report.elapsedMs / 1000).toFixed(1)}s)`
      : "";
    // Iter809: severity badge — parity with iter808 verify / iter305 preflight.
    const syncBadge = report.severity === "ok" ? "🟢 OK  " : "🟡 WARN";
    // Iter848: --summary cron/Slack-friendly single-liner. Parallel to iter846/
    // 847 health/doctor/verify --summary + iter848 reconcile --summary.
    // Compresses the multi-line sync report (blocks scanned + per-row insert/
    // skip/error rows) into a single status string. Bookmark advance reflected
    // by "bm=<block>" suffix when present.
    if (flags["summary"] === "true" || flags["summary"] === "") {
      const parts: string[] = [
        `chain=${report.chain}`,
        `blocks=${report.fromBlock}-${report.toBlock}`,
        `scanned=${report.scannedTxCount}`,
        `imported=${report.inserted}`,
      ];
      if (report.errors.length > 0) parts.push(`errors=${report.errors.length}`);
      if (report.chunkErrors.length > 0) parts.push(`chunkErrors=${report.chunkErrors.length}`);
      if (report.bookmark?.advancedToBlock != null) {
        parts.push(`bm=${report.bookmark.advancedToBlock}`);
      }
      // Iter901: append ISO timestamp for consistency with health/doctor/
      // pending --summary lines.
      parts.push(new Date().toISOString());
      console.log(`${syncBadge}  tradekit sync · ${parts.join(" · ")}${elapsedSuffix}`);
      return;
    }
    console.log(`${syncBadge}  Activity sync on ${report.chain} for ${report.owner}:${elapsedSuffix}`);
    if (report.bookmark?.used && report.bookmark.resumedFromBlock != null) {
      // Iter742: append a "behind tip" hint to the resume line when the gap
      // is non-trivial. Helps operators gauge "this is a quick catchup"
      // (silent) vs "this is going to take a while" (hours/days hint).
      const { formatBlocksBehindHint } = await import("../activitySync.js");
      const gap = report.toBlock - report.bookmark.resumedFromBlock;
      const behindHint = formatBlocksBehindHint(gap, report.chain);
      const behindSuffix = behindHint ? `  (${gap.toString()} blocks, ${behindHint})` : "";
      console.log(`  Resumed from bookmark at block ${report.bookmark.resumedFromBlock}${behindSuffix}`);
    }
    console.log(`  Blocks ${report.fromBlock} → ${report.toBlock}`);
    console.log(`  Scanned ${report.scannedTxCount} unique tx${report.scannedTxCount === 1 ? "" : "es"}`);
    console.log(`  Inserted:   ${report.inserted}`);
    console.log(`  Duplicates: ${report.duplicates} (already in DB)`);
    console.log(`  Skipped:    ${report.skipped} (not classifiable as a trade)`);
    if (report.errors.length > 0) {
      console.log(`  Errors:     ${report.errors.length}`);
      for (const e of report.errors.slice(0, 10)) {
        console.log(`    ✗ ${e.txHash}: ${e.message}`);
      }
      if (report.errors.length > 10) console.log(`    … and ${report.errors.length - 10} more`);
    }
    if (report.chunkErrors.length > 0) {
      console.log(`  Chunk errors: ${report.chunkErrors.length} (consider --chunk-size N to shrink range per request)`);
      console.log(`  Bookmark not advanced — retry will rescan ${report.fromBlock} → ${report.toBlock} (dedup absorbs duplicates).`);
    } else if (report.bookmark?.advancedToBlock != null) {
      console.log(`  Bookmark advanced → ${report.bookmark.advancedToBlock}`);
    }

    // Iter840: surface iter832 recommendedActions inline. Operators reading
    // `tradekit trades sync` see paste-ready guidance for follow-ups (e.g. run
    // reconcile when txs were imported, re-sync a stuck range, etc.) without
    // having to inspect the JSON form. Mirrors iter839 reconcile footer.
    if (report.recommendedActions.length > 0) {
      console.log("");
      console.log("Next steps:");
      for (const a of report.recommendedActions) {
        console.log(`  → ${a.reason}`);
      }
    }

    // Iter754: --strict exit-code surface. Cron pipelines + systemd timers
    // gate on the process exit code; pre-iter754 sync exited 0 even when
    // chunkErrors absorbed RPC failures, so a stuck cron silently kept
    // "succeeding". Strict mode flips that — any chunk or per-tx error
    // surfaces as exit 1, letting alerting tools fire. Default behavior
    // unchanged for back-compat: existing `tradekit trades sync && pnl`
    // pipelines keep flowing through transient RPC blips.
    const strict = flags["strict"] === "true" || flags["strict"] === "";
    if (strict && (report.chunkErrors.length > 0 || report.errors.length > 0)) {
      // process.exitCode (not process.exit) so main()'s audit-insert finally
      // block still runs — same pattern doctor uses (iter351).
      process.exitCode = 1;
    }
  } finally {
    logger.close();
  }
}

async function tradesCommandOnce(flags: Record<string, string>) {
  // Cap at 100k — anything larger is almost certainly a typo, and unbounded LIMIT
  // would happily scan a multi-year trade history.
  const limit = parseIntFlag(flags["limit"], "--limit", { min: 1, max: 100_000 }) ?? 100;
  const chain = flags["chain"];
  // Iter713: --accounts is mutually exclusive with --account (same convention
  // as iter624 PnL / iter265 holdings). Pre-iter713 you had to run trades N
  // times for N HD accounts. Now `--accounts all` or `--accounts a,b,c`
  // returns the merged view, sorted by timestamp desc, sliced to --limit.
  if (flags["account"] && flags["accounts"]) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Pass either --account or --accounts, not both. Got --account=${flags["account"]} and --accounts=${flags["accounts"]}.`,
    );
  }
  // Iter501: use activeWalletLabel so the implicit account falls back to "keystore"
  // when accounts.json is orphaned (mnemonic.json missing) — matches what loadWallet
  // would do, so the filter matches the rows that the actual trade flow wrote.
  const account = flags["account"] ?? activeWalletLabel();
  // Iter713: resolve --accounts before the query branch. "all" → every HD
  // account + keystore. Comma list → those specific labels.
  let accountLabels: string[] | undefined;
  if (flags["accounts"]) {
    const { resolveAccountsForPortfolio } = await import("../portfolio.js");
    const raw = flags["accounts"].trim();
    const selector: string[] | "all" =
      raw === "all" ? "all" : raw.split(",").map((s) => s.trim()).filter(Boolean);
    const resolved = resolveAccountsForPortfolio(selector);
    if (resolved.length === 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `No accounts resolved from --accounts="${flags["accounts"]}". Use \`tradekit account list\` to see available labels.`,
      );
    }
    accountLabels = resolved.map((a) => a.label);
  }
  const format = (flags["format"] ?? "table").toLowerCase();
  // Validate up front. Pre-iter130 a typo like `--format scv` silently fell through the
  // switch with body=undefined and then `writeFileSync(out, undefined)` threw a
  // confusing TypeError from inside fs instead of a clear INVALID_PARAMS at the boundary.
  if (!["table", "csv", "json", "tax"].includes(format)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Invalid --format "${flags["format"]}" — expected one of: table, csv, json, tax.`,
    );
  }
  const outPath = flags["out"];
  const includeLegacy = flags["include-legacy"] === "true";
  // Iter357: --since support (mirrors audit's --since). Same parseDateFilter shape,
  // so today / yesterday / Nh / Nd shortcuts (iter356) all work here.
  const sinceIso = parseDateFilter(flags["since"], "--since");
  // Iter411: same future-date guard the audit command has (this file, ~line 384).
  // A typo like --since 2027-01-01 silently filters away every row and reads as
  // "no trades" — warn loudly so the operator catches the wrong year.
  if (sinceIso && Date.parse(sinceIso) > Date.now() + 60_000) {
    console.error(`⚠  --since ${sinceIso} is in the future — no trades will match. Did you typo the year?`);
  }

  // Iter648/iter661/iter662: structured filters pushed down to the DB query
  // (indexed where possible). --tx is normalized at the DB layer; we just
  // validate format here so a typo gives a clear error instead of "no rows".
  let txFilter: string | undefined;
  if (flags["tx"]) {
    txFilter = assertTxHash(flags["tx"], "--tx");
  }
  // Iter713: when --accounts is set, fan out queries per account and merge.
  // The per-account limit is the FULL --limit so we never under-fetch (e.g.
  // 3 accounts × limit=10 might leave 5 from each visible after merge); the
  // final slice trims to the requested limit. For single-account paths
  // (default or --account), this is exactly the pre-iter713 query.
  let rows: ReturnType<typeof recentTrades>;
  if (accountLabels) {
    const perAccount = accountLabels.flatMap((acct) =>
      recentTrades({
        chain,
        account: acct,
        limit,
        since: sinceIso,
        strategy: flags["strategy"],
        txHash: txFilter,
        aggregator: flags["aggregator"],
      }),
    );
    // Merge: sort by timestamp desc (matches recentTrades single-account
    // ordering — see iter245 in db.ts), then id desc as the tiebreaker for
    // same-millisecond rows.
    perAccount.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return b.timestamp.localeCompare(a.timestamp);
      return (b.id ?? 0) - (a.id ?? 0);
    });
    rows = perAccount.slice(0, limit);
  } else {
    rows = recentTrades({
      chain,
      account,
      limit,
      since: sinceIso,
      strategy: flags["strategy"],
      txHash: txFilter,
      aggregator: flags["aggregator"],
    });
  }
  // Legacy CSV-imported trades have empty base/quote token info — hide them by default.
  if (!includeLegacy) {
    rows = rows.filter((r) => !(r.notes ?? "").includes("legacy trade.csv"));
  }
  const tokenFilter = flags["token"];
  if (tokenFilter) {
    const q = tokenFilter.toLowerCase();
    rows = rows.filter((r) => matchesTradeToken(r, q));
  }
  // --status=pending|success|failed — typical use is finding stuck pending rows after
  // a doctor warning. --pending is a discoverable shorthand. Lowercased to accept
  // `--status Failed` etc — pre-iter130 a case mismatch silently returned zero rows.
  const statusFilter = flags["pending"] === "true" ? "pending" : flags["status"]?.toLowerCase();
  if (statusFilter) {
    const VALID = new Set(["pending", "success", "failed"]);
    if (!VALID.has(statusFilter)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Invalid --status "${flags["status"]}" — expected one of: ${[...VALID].join(", ")}.`,
      );
    }
    rows = rows.filter((r) => r.status === statusFilter);
  }
  // --note <substring> — case-insensitive substring match against the trade row's
  // `notes` field. Lets agents tag trades with `--note "DCA #4"` and later retrieve
  // every row from that campaign via `tradekit trades --note DCA`.
  const noteFilter = flags["note"];
  if (noteFilter) {
    const needle = noteFilter.toLowerCase();
    rows = rows.filter((r) => (r.notes ?? "").toLowerCase().includes(needle));
  }

  let body: string;
  switch (format) {
    case "json":
      body = JSON.stringify(rows, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
      break;
    case "csv": {
      // Pre-iter156: empty result emitted nothing (no header) — downstream tools
      // (csv.DictReader, Excel, awk) couldn't even infer the schema. Now we always
      // emit the canonical header so the file is parseable even with zero data rows.
      const header = TRADE_COLUMNS.join(",");
      const lines = rows.map((r) =>
        TRADE_COLUMNS.map((col) => csvField((r as unknown as Record<string, unknown>)[col])).join(","),
      );
      body = [header, ...lines].join("\n") + "\n";
      break;
    }
    case "tax": {
      // Iter616: tax-grade enriched CSV. Same chronological cost-basis math
      // iter615 uses, with 4 derived columns appended: cost_basis_usd,
      // proceeds_usd, realized_pnl_usd, gas_usd. Path-dependent — runs against
      // the FULL filtered row set in order, so cost basis matches what pnl
      // shows. Note: any `--since/--token/--note` filters applied earlier
      // affect the input — for tax-accurate cost basis the operator should
      // export with NO filters and post-process the CSV.
      const { enrichTradesForExport, quoteUsdAtTradeForExport, ENRICHED_COLUMNS } = await import("../tradeExport.js");
      // Build a quote-USD-live map for non-stable rows (matches computePnL).
      const nonStableQuotes = Array.from(new Set(rows.filter((r) => r.quote_symbol && !/^(USDC|USDT|DAI|BUSD|FRAX|USDP|TUSD|USDC\.e)$/i.test(r.quote_symbol)).map((r) => r.quote_token)));
      const quoteUsdLive = new Map<string, number | null>(
        await Promise.all(
          nonStableQuotes.map(async (addr) => [addr, await getCurrentPrice(addr, makeCliLogger(flags)).catch(() => null)] as const),
        ),
      );
      // Build per-chain gas USD price map.
      const chains = Array.from(new Set(rows.map((r) => r.chain)));
      const gasUsdEntries = await Promise.all(
        chains.map(async (c) => {
          const { getBuiltinProfile } = await import("../chains.js");
          const profile = getBuiltinProfile(c);
          if (!profile) return [c, null] as const;
          const p = await getCurrentPrice(profile.weth, makeCliLogger(flags)).catch(() => null);
          return [c, p] as const;
        }),
      );
      const gasUsdPerChain = new Map<string, number | null>(gasUsdEntries);
      const enriched = enrichTradesForExport(
        rows,
        (row) => quoteUsdAtTradeForExport(row) ?? quoteUsdLive.get(row.quote_token) ?? null,
        gasUsdPerChain,
      );
      const header = ENRICHED_COLUMNS.join(",");
      const lines = enriched.map((r) =>
        ENRICHED_COLUMNS.map((col) => csvField((r as unknown as Record<string, unknown>)[col])).join(","),
      );
      body = [header, ...lines].join("\n") + "\n";
      break;
    }
    case "table":
    default: {
      // Iter750: stale-sync banner. When the scoped account(s) have at least
      // one bookmark older than the iter741 PNL_STALE_BOOKMARK_HOURS (48h),
      // prepend a warning — the displayed listing may be missing trades that
      // happened since the bookmark stopped advancing. Same signal PnL /
      // health / accounts-list already carry; operators see it in the place
      // they're most likely to MISS the gap (eyeballing recent trades).
      // Skipped for JSON/CSV/tax (those go through the format-specific
      // branches above; machine consumers read freshness via accounts list).
      const scopedLabels = accountLabels ?? [account];
      const { listSyncBookmarks } = await import("../db.js");
      const allBookmarks = listSyncBookmarks();
      const STALE_HOURS = 48;
      const thresholdMs = STALE_HOURS * 3_600_000;
      const nowMs = Date.now();
      const staleEntries = allBookmarks
        .filter((b) => scopedLabels.includes(b.account))
        .filter((b) => !chain || b.chain === chain)
        .filter((b) => nowMs - new Date(b.updatedAt).getTime() > thresholdMs)
        .map((b) => ({
          account: b.account,
          chain: b.chain,
          ageHours: (nowMs - new Date(b.updatedAt).getTime()) / 3_600_000,
        }));
      const staleBanner = staleEntries.length > 0
        ? staleEntries
            .map((s) => {
              const ageStr = s.ageHours >= 24
                ? `${(s.ageHours / 24).toFixed(1)}d`
                : `${s.ageHours.toFixed(1)}h`;
              return `⚠ Sync stale: ${s.chain}/${s.account} bookmark not advanced in ${ageStr} — listing may be missing recent trades. Run \`tradekit trades sync\` or check the cron.`;
            })
            .join("\n") + "\n\n"
        : "";

      if (rows.length === 0) {
        // Pre-iter237 "No trades." gave operators no signal that the result was scoped
        // to a single account. A user with trades only on HD account "bob" who ran
        // `tradekit trades` while "alice" was active would see "No trades." and assume
        // their history was lost — when really they just needed `--account bob` (or to
        // switch active). Surface the resolved account + any explicit filters so the
        // operator immediately sees the query scope. Same spirit as iter236 for audit.
        // Iter713: empty-state message reflects whether --accounts was used.
        const scopeBits = accountLabels
          ? [`accounts=${accountLabels.join(",")}`]
          : [`account=${account}`];
        if (chain) scopeBits.push(`chain=${chain}`);
        if (tokenFilter) scopeBits.push(`token=${tokenFilter}`);
        if (statusFilter) scopeBits.push(`status=${statusFilter}`);
        if (noteFilter) scopeBits.push(`note=${noteFilter}`);
        if (sinceIso) scopeBits.push(`since=${sinceIso}`);
        if (flags["strategy"]) scopeBits.push(`strategy=${flags["strategy"]}`);
        if (txFilter) scopeBits.push(`tx=${txFilter}`);
        if (flags["aggregator"]) scopeBits.push(`aggregator=${flags["aggregator"]}`);
        body = `${staleBanner}No trades found for: ${scopeBits.join(", ")}.\n`;
        break;
      }
      const lines: string[] = [];
      if (staleBanner) {
        lines.push(staleBanner.trimEnd());
        lines.push(""); // visual gap before the header
      }
      // Iter652/iter657: auto-show extra columns when ANY row in the result
      // carries iter641 / iter648 / iter646 data. Avoids cluttering legacy-
      // only datasets with empty columns; surfaces the rich data without
      // needing --format json.
      const showSlippage = rows.some((t) => t.realized_slippage_bps != null);
      const showStrategy = rows.some((t) => t.strategy != null && t.strategy !== "");
      const showGasUsd = rows.some((t) => t.gas_cost_usd_at_trade != null);
      const slipHdr = showSlippage ? " Slip(bps) " : "";
      const stratHdr = showStrategy ? " Strategy             " : "";
      const gasUsdHdr = showGasUsd ? " Gas($) " : "";
      // Leading 1-char marker draws the eye to non-success rows when scanning a long
      // history. Pre-iter125 the status was just the trailing word, so a failed trade
      // looked nearly identical to a success at a glance (only the last word differed).
      lines.push(
        `  Time                 Chain     Account   Dir   Amount                     Quote                     Price          Aggregator    Status  ${slipHdr}${stratHdr}${gasUsdHdr} Tx`,
      );
      lines.push("-".repeat(172 + (showSlippage ? 11 : 0) + (showStrategy ? 22 : 0) + (showGasUsd ? 8 : 0)));
      for (const t of rows) {
        const time = t.timestamp.slice(0, 19).replace("T", " ");
        const baseDisplay = `${t.base_amount} ${t.base_symbol ?? ""}`.trim();
        const quoteDisplay = `${t.quote_amount} ${t.quote_symbol ?? ""}`.trim();
        const txShort = (t.tx_hash ?? "").slice(0, 18) + (t.tx_hash ? "…" : "");
        const dir = t.aggregator === "transfer" ? "xfer" : t.direction;
        const marker = tradeStatusMarker(t.status);
        // Iter652: format the optional columns. NULL → "—" placeholder so
        // alignment stays consistent.
        const slipCol = showSlippage
          ? ` ${(t.realized_slippage_bps != null ? t.realized_slippage_bps.toFixed(1) : "—").padStart(9)} `
          : "";
        const stratCol = showStrategy ? ` ${(t.strategy ?? "—").padEnd(20)} ` : "";
        const gasUsdCol = showGasUsd
          ? ` ${(t.gas_cost_usd_at_trade != null ? Number(t.gas_cost_usd_at_trade).toFixed(2) : "—").padStart(6)} `
          : "";
        lines.push(
          `${marker} ${time}  ${t.chain.padEnd(9)} ${t.account.padEnd(9)} ${dir.padEnd(5)} ${baseDisplay.padEnd(26)} ${quoteDisplay.padEnd(25)} ${t.price.padEnd(14)} ${(t.aggregator ?? "?").padEnd(13)} ${t.status.padEnd(7)} ${slipCol}${stratCol}${gasUsdCol}${txShort}`,
        );
        // Iter669: failed-row footer surfaces the persisted revert reason
        // when present. Placed BEFORE the notes footer so the operator sees
        // the actionable revert text first (notes is free-form / often
        // verbose). Both can render: revert reason + notes on separate lines.
        if (t.status === "failed" && t.revert_reason) {
          lines.push(`       ↳ reverted: ${compactMessage(t.revert_reason, 200)}`);
        }
        if (t.notes && !t.notes.startsWith("imported")) {
          // Collapse whitespace via the shared helper. The JSON and CSV outputs
          // (iter120) preserve the original; only the table view normalizes.
          lines.push(`       ↳ ${compactMessage(t.notes, 500)}`);
        }
      }
      // Iter675: failure-reason histogram footer. Fires when the displayed
      // set has 2+ failed rows. Pattern recognition aid — operator running
      // `trades --status=failed` sees the histogram inline; operator running
      // any filter that happens to surface multiple failures gets the same
      // signal without extra commands. Uses the shared db.ts helper so the
      // bucketing rules stay in sync with health (iter671), aggregator stats
      // (iter672), and pair stats (iter673).
      const histogram = failureReasonHistogram(rows);
      const failedTotal = histogram.reduce((s, h) => s + h.count, 0);
      if (failedTotal >= 2) {
        const top5 = histogram.slice(0, 5);
        lines.push("");
        lines.push(
          `  Failure reasons (${failedTotal} row${failedTotal === 1 ? "" : "s"}): ${top5.map((h) => `${h.reason}=${h.count}`).join("  ")}`,
        );
        // Iter699: dominant reason's last-seen timestamp. Only surface for
        // the top-1 to keep the footer compact — full per-reason timestamps
        // live in --format json.
        if (top5[0]?.lastSeen) {
          const ts = top5[0].lastSeen.slice(0, 16).replace("T", " ");
          lines.push(`  Dominant "${top5[0].reason}" last seen: ${ts}`);
        }
        if (histogram.length > 5) {
          lines.push(`  … and ${histogram.length - 5} more reason${histogram.length - 5 === 1 ? "" : "s"} (--format json for full breakdown)`);
        }
      }
      body = lines.join("\n") + "\n";
      break;
    }
  }

  if (outPath) {
    const { writeFileSync } = await import("fs");
    writeFileSync(outPath, body);
    console.error(`Wrote ${rows.length} trade(s) to ${outPath}`);
  } else {
    process.stdout.write(body);
  }
}

// ── audit ────────────────────────────────────────────────────

export async function auditCommand(flags: Record<string, string>, positional: string[]) {
  // Iter631: `tradekit audit summary` — aggregated activity + error stats.
  // Distinct from `audit` (which lists rows) — this groups + counts. Use to
  // answer "how many errors in the last 24h" without scrolling listings.
  if (positional[1] === "summary") {
    const sinceFlag = flags["since"];
    const since = sinceFlag ? parseDateFilter(sinceFlag, "--since") : undefined;
    const { auditSummary } = await import("../db.js");
    const summary = auditSummary({
      since: since ?? undefined,
      tool: flags["tool"],
      account: flags["account"],
      chain: flags["chain"],
      caller: flags["caller"],
    });
    if (flags["json"] === "true") {
      printJson({ ok: true, ...summary });
      return;
    }
    if (summary.totalRows === 0) {
      console.log("No audit rows match the filter.");
      return;
    }
    const errorRatePct = summary.totalRows > 0 ? (summary.errorRows / summary.totalRows) * 100 : 0;
    // Iter771: elapsedMs suffix — parity with iter731 reconcile/pnl/etc.
    const elapsedSuffix = summary.elapsedMs != null
      ? `  (${(summary.elapsedMs / 1000).toFixed(1)}s)`
      : "";
    console.log(`Audit summary (${summary.totalRows.toLocaleString("en-US")} rows)${elapsedSuffix}`);
    console.log("=".repeat(60));
    if (summary.earliest && summary.latest) {
      console.log(`  Range:        ${summary.earliest} → ${summary.latest}`);
    }
    console.log(`  Errors:       ${summary.errorRows.toLocaleString("en-US")} (${errorRatePct.toFixed(2)}% error rate)`);
    console.log("");
    console.log("  By tool (top 15):");
    for (const t of summary.byTool.slice(0, 15)) {
      const errPct = t.count > 0 ? (t.errorCount / t.count) * 100 : 0;
      const errStr = t.errorCount > 0 ? `  ${t.errorCount} err (${errPct.toFixed(1)}%)` : "";
      // Iter698: lastSeen alongside count + error rate.
      const lastSeen = t.lastSeen.slice(0, 16).replace("T", " ");
      console.log(`    ${t.tool.padEnd(24)} ${String(t.count).padStart(6)}${errStr}  last: ${lastSeen}`);
    }
    if (summary.byErrorCode.length > 0) {
      console.log("");
      console.log("  By error code:");
      for (const e of summary.byErrorCode.slice(0, 10)) {
        // Iter697: lastSeen surfaces alongside the count — operators
        // investigating "when did this happen last?" don't need a follow-up
        // listing. Trim to YYYY-MM-DD HH:MM for compactness.
        const lastSeen = e.lastSeen.slice(0, 16).replace("T", " ");
        console.log(`    ${e.errorCode.padEnd(28)} ${String(e.count).padStart(6)}  last: ${lastSeen}`);
      }
    }
    if (summary.byCaller.length > 1) {
      console.log("");
      console.log("  By caller:");
      for (const c of summary.byCaller) {
        const lastSeen = c.lastSeen.slice(0, 16).replace("T", " ");
        console.log(`    ${c.caller.padEnd(10)} ${String(c.count).padStart(6)}  last: ${lastSeen}`);
      }
    }
    if (summary.byChain.length > 1) {
      console.log("");
      console.log("  By chain:");
      for (const c of summary.byChain) {
        const lastSeen = c.lastSeen.slice(0, 16).replace("T", " ");
        console.log(`    ${c.chain.padEnd(14)} ${String(c.count).padStart(6)}  last: ${lastSeen}`);
      }
    }
    // Iter843: surface iter834/iter837 recommendedActions inline. The audit
    // summary's per-tool + per-error-code dispatches (e.g. high error rate on
    // a tool → re-run with logger.debug; specific error codes → suggested
    // remediation) are paste-ready prose for operators reading the text view.
    // Mirrors iter839/840/841/842 footer convention.
    if (summary.recommendedActions.length > 0) {
      console.log("");
      console.log("Next steps:");
      for (const a of summary.recommendedActions) {
        console.log(`  → ${a.reason}`);
      }
    }
    return;
  }

  if (positional[1] === "prune") {
    const before = flags["before"];
    if (!before) throw new ToolError("INVALID_PARAMS", "Usage: tradekit audit prune --before <DATE> [--yes]  (DATE: YYYY-MM-DD, ISO, today, yesterday, Nh, Nd — e.g. `--before today` for all-but-today)");
    const beforeIso = parseDateFilter(before, "--before")!;
    // Defensive: reject dates more than 1 year in the future. Catches the operator
    // typo "2099" / "9999" / wrong-year shift that would otherwise nuke ALL audit
    // history in --yes mode without ever showing a preview. The non-yes path's
    // preview already catches obvious typos but this guards scripted invocations.
    const oneYearFromNow = Date.now() + 365 * 24 * 60 * 60 * 1000;
    if (Date.parse(beforeIso) > oneYearFromNow) {
      throw new ToolError(
        "INVALID_PARAMS",
        `--before ${beforeIso} is more than a year in the future. Did you typo the year? (To delete everything older than now, use today's date.)`,
      );
    }
    // Preview first — operators have been known to typo the year and nuke months of
    // compliance trail. Showing the count + date range catches "I meant last year"
    // before the DELETE runs.
    const stats = auditPruneStats(beforeIso);
    const wantJson = flags["json"] === "true";
    if (stats.count === 0) {
      // Iter378: --json output for scripted compliance-trail cleanup. Same three-action
      // discriminator (pruned / aborted / noop-empty) as MCP's audit prune shape.
      if (wantJson) {
        // Iter456: ok:true envelope parity (iter450). Additive — keeps existing
        // {action, before, count, timestamp} discriminator-driven shape.
        printJson({ ok: true, action: "noop-empty", before: beforeIso, count: 0, timestamp: new Date().toISOString() });
      } else {
        console.log(`Nothing to prune (no audit entries before ${beforeIso}).`);
      }
      return;
    }
    // Iter799: surface percentage + remaining count so operators catch
    // year-typos. Typing 2020 instead of 2024 on a long-running install
    // would show "99% of N total rows" which is obviously wrong — well
    // before the y/N confirmation gate. Cheap single-row COUNT.
    const { openDb } = await import("../db.js");
    const totalRows = (openDb().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    const pruneShare = totalRows > 0 ? (stats.count / totalRows) * 100 : 0;
    const remaining = totalRows - stats.count;
    if (!wantJson) {
      console.log(
        `Would prune ${stats.count} audit entr${stats.count === 1 ? "y" : "ies"} ` +
          `from ${stats.oldestPruned} through ${stats.newestPruned} ` +
          `(${pruneShare.toFixed(1)}% of ${totalRows.toLocaleString("en-US")} total, ${remaining.toLocaleString("en-US")} will remain).`,
      );
    }
    if (flags["yes"] !== "true") {
      const answer = await prompt("Proceed? (yes/no): ");
      if (answer.toLowerCase() !== "yes") {
        if (wantJson) {
          printJson({
            // Iter456: ok:true envelope parity (iter450). Operator-aborted (typed no
            // at the confirmation prompt) is still a successful command run.
            ok: true,
            action: "aborted",
            before: beforeIso,
            wouldPrune: stats.count,
            oldestPruned: stats.oldestPruned,
            newestPruned: stats.newestPruned,
            timestamp: new Date().toISOString(),
          });
        } else {
          console.log("Aborted.");
        }
        return;
      }
    }
    const n = pruneAudit(beforeIso);
    if (wantJson) {
      printJson({
        // Iter456: ok:true envelope parity (iter450).
        ok: true,
        action: "pruned",
        before: beforeIso,
        count: n,
        oldestPruned: stats.oldestPruned,
        newestPruned: stats.newestPruned,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log(`Pruned ${n} audit entr${n === 1 ? "y" : "ies"} before ${beforeIso}.`);
    }
    return;
  }

  const limit = parseIntFlag(flags["limit"], "--limit", { min: 1, max: 100_000 }) ?? 30;
  const sinceIso = parseDateFilter(flags["since"], "--since");
  // Future-dated --since always returns empty — easy to misread as "no audit
  // history" when really the filter excludes everything. Warn loudly so the
  // operator notices the wrong year / typo.
  if (sinceIso && Date.parse(sinceIso) > Date.now() + 60_000) {
    console.error(`⚠  --since ${sinceIso} is in the future — no audit entries will match. Did you typo the year?`);
  }
  // Iter370: validate --caller. Pre-iter370 `tradekit audit --caller banana` silently
  // returned 0 rows because the DB filter just no-op'd on an unknown value. Same
  // iter130/iter241 class issue that --status had. Valid values are the three caller
  // surfaces the audit_log records.
  const callerFilter = flags["caller"]?.toLowerCase();
  if (callerFilter) {
    const VALID = new Set(["cli", "mcp", "web"]);
    if (!VALID.has(callerFilter)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Invalid --caller "${flags["caller"]}" — expected one of: ${[...VALID].join(", ")}.`,
      );
    }
  }
  // Iter695: --error-code accepts the canonical error code (SLIPPAGE_EXCEEDED,
  // TOKEN_BLOCKED, etc). Uppercased so `--error-code slippage_exceeded` works.
  // Iter696: --errors-only filters to rows with non-null error_code. Common
  // investigation flow: "what's been breaking?" — analogous to
  // `trades --status=failed`.
  // Iter705: --tx exact tx-hash lookup. Validate at the boundary so a typo
  // gives INVALID_PARAMS instead of zero rows (same defensive pattern as
  // iter661's trades --tx).
  const errorCodeFilter = flags["error-code"]?.toUpperCase();
  const errorsOnly = flags["errors-only"] === "true";
  let txFilter: string | undefined;
  if (flags["tx"]) {
    txFilter = assertTxHash(flags["tx"], "--tx");
  }
  const entries = recentAudit(limit, {
    since: sinceIso,
    tool: flags["tool"],
    account: flags["account"],
    chain: flags["chain"],
    caller: callerFilter,
    errorCode: errorCodeFilter,
    errorsOnly,
    txHash: txFilter,
  });
  if (flags["json"] === "true") {
    printJson(entries);
  } else {
    if (entries.length === 0) {
      // Pre-iter236 the text mode silently printed nothing on empty results — operators
      // running `tradekit audit --tool quote --account foo` on a fresh install couldn't
      // tell if audit was broken or just empty. Match the trades-command empty-state
      // wording, and when filters are active surface them so a typo'd --tool / --chain
      // doesn't masquerade as "no audit history".
      const activeFilters: string[] = [];
      if (flags["tool"]) activeFilters.push(`tool=${flags["tool"]}`);
      if (flags["account"]) activeFilters.push(`account=${flags["account"]}`);
      if (flags["chain"]) activeFilters.push(`chain=${flags["chain"]}`);
      if (flags["caller"]) activeFilters.push(`caller=${flags["caller"]}`);
      if (sinceIso) activeFilters.push(`since=${sinceIso}`);
      if (errorCodeFilter) activeFilters.push(`error-code=${errorCodeFilter}`);
      if (errorsOnly) activeFilters.push(`errors-only=true`);
      if (txFilter) activeFilters.push(`tx=${txFilter}`);
      if (activeFilters.length > 0) {
        console.log(`No audit entries matching: ${activeFilters.join(", ")}.`);
      } else {
        console.log("No audit entries.");
      }
      return;
    }
    for (const e of entries) {
      const status = e.result === "ok" ? "OK " : `ERR(${e.error_code})`;
      // Show caller (cli/mcp/web) so operators can tell which surface drove the call.
      // Iter201/202 added web audit; without this column the entries look identical.
      const caller = (e.caller ?? "?").padEnd(5);
      console.log(
        `${e.timestamp}  ${status.padEnd(20)} ${caller} ${e.tool.padEnd(12)} chain=${e.chain ?? "-"}  account=${e.account ?? "-"}`,
      );
      if (e.error_message) {
        // compactMessage handles the collapse + cap with "..." suffix (iter197).
        console.log(`    ${compactMessage(e.error_message, 200)}`);
      }
      if (e.tx_hash) console.log(`    tx: ${e.tx_hash}`);
    }
    // Iter710: footer summary so operators see total + error rate without
    // a separate `audit summary` call. Skipped for single-row results where
    // counting is trivial.
    if (entries.length >= 2) {
      const errCount = entries.filter((e) => e.error_code != null).length;
      const errPct = (errCount / entries.length) * 100;
      const errBit = errCount > 0
        ? ` — ${errCount} error${errCount === 1 ? "" : "s"} (${errPct.toFixed(1)}%)`
        : "";
      console.log("");
      console.log(`  ${entries.length} entries shown${errBit}`);
    }
  }
}

// ── viewTx ───────────────────────────────────────────────────

export async function viewTxCommand(flags: Record<string, string>, positional: string[]) {
  const txHashRaw = positional[1];
  if (!txHashRaw) throw new ToolError("INVALID_PARAMS", "Usage: tradekit viewTx <hash> [--chain <name>]");
  const txHash = assertTxHash(txHashRaw);
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  // Public-only — no wallet password needed.
  const { createPublicClient } = await import("viem");
  const { makeTransport } = await import("../chains.js");
  const { decodeTx, formatDecodedTx } = await import("../decodeTx.js");
  const transport = makeTransport(profile, config.chains[chainName]?.rpcs ?? []);
  const client = createPublicClient({ chain: profile.viemChain, transport });
  try {
    const decoded = await decodeTx(client as never, profile, txHash);
    if (flags["json"] === "true") {
      // Iter447: spread under `ok: true` envelope for parity with iter445/446
      // (pnl, reconcile). Additive — every existing DecodedTx field (status,
      // moves, summary, etc.) stays at top level so scripts reading
      // `.status` / `.moves` continue to work unchanged.
      printJson({ ok: true, ...decoded });
    } else {
      console.log(formatDecodedTx(decoded, profile));
    }
  } catch (e) {
    // Iter336: distinguish "tx doesn't exist on this chain" from "RPC failed to answer."
    // Pre-iter336 every exception from decodeTx was wrapped as TX_NOT_FOUND, so an
    // operator whose RPC was timing out or returning 5xx saw "Transaction not found on
    // <chain>" with the iter300 chain-mismatch hint — sending them down the wrong
    // debugging path (checking other chains, re-checking the hash) when the actual fix
    // is "retry, or add a fallback RPC." viem labels the not-found case specifically as
    // `TransactionNotFoundError`; anything else is treated as a transport issue.
    const name = (e as { name?: string } | null)?.name;
    if (name === "TransactionNotFoundError") {
      // Iter300: name the chain queried and the common causes. Pre-iter300 a TX_NOT_FOUND
      // gave no hint that the operator might be querying the wrong chain (typical cause:
      // paste from etherscan when --chain defaults to base, or vice versa).
      throw new ToolError(
        "TX_NOT_FOUND",
        `Transaction ${txHash} not found on ${chainName}. Possible causes: (1) tx is on a different chain — try --chain <name>; (2) tx is very recent and not yet propagated to this RPC; (3) tx hash is wrong (re-check the 0x-prefixed 64-hex value).`,
        { cause: e },
      );
    }
    const msg = (e as { shortMessage?: string; message?: string } | null)?.shortMessage
      ?? (e as { message?: string } | null)?.message
      ?? String(e);
    throw rpcFailedChainError(
      chainName,
      `Could not query ${chainName} for transaction ${txHash}: ${msg}. The RPC may be down or rate-limited — retry, or add a fallback RPC via \`config push chains.${chainName}.rpcs <url>\`.`,
      "getTransactionReceipt",
      { cause: e, extraDetails: { txHash } },
    );
  }
}

// ── price ────────────────────────────────────────────────────

export async function priceCommand(flags: Record<string, string>, positional: string[]) {
  // Iter38: route `tradekit price stats` to the provider-stats
  // observability surface. Single-token lookups (`price ETH`) still
  // flow through priceCommandOnce. The subaction discriminator
  // lives in positional[1].
  if (positional[1] === "stats") {
    await priceStatsCommand(flags);
    return;
  }
  // Iter328: thread through withWatch so `tradekit price ETH --watch` polls
  // periodically. Iter238 mentioned this use case in a comment but the wrapper
  // was never wired up — the comment was aspirational. Now the response-envelope
  // timestamp (iter238) is actually useful for spotting cache staleness across
  // successive iterations.
  await withWatch(flags, () => priceCommandOnce(flags, positional));
}

/** Iter38: per-provider price-fetch observability. Surfaces the
 *  in-memory counters from priceStats — call counts, hit rates,
 *  latency percentiles, last error per provider. Reset-able. */
export async function priceStatsCommand(flags: Record<string, string>) {
  const { getProviderStats, resetProviderStats } = await import("../priceStats.js");
  if (flags["reset"] === "true") {
    resetProviderStats();
    if (flags["json"] === "true") {
      printJson({ ok: true, reset: true });
    } else {
      console.log("Price provider stats reset.");
    }
    return;
  }
  const stats = getProviderStats();
  if (flags["json"] === "true") {
    printJson({ ok: true, providers: stats });
    return;
  }
  if (stats.length === 0) {
    console.log("No price provider stats yet — no price fetches recorded since process start.");
    console.log("Run a few orders ticks or `tradekit price ETH` to populate.");
    return;
  }
  console.log("Price provider stats (in-memory, since process start):");
  for (const s of stats) {
    const failRate = s.totalCalls > 0 ? ((s.failures / s.totalCalls) * 100).toFixed(1) : "0.0";
    const hitPct = (s.hitRate * 100).toFixed(1);
    console.log(`\n  ${s.provider}`);
    console.log(`    Calls:    ${s.totalCalls}  (${s.successes} ok, ${s.failures} fail = ${failRate}%)`);
    console.log(`    Tokens:   ${s.tokensReturned} returned / ${s.tokensRequested} requested  (${hitPct}% hit rate)`);
    if (s.timing) {
      console.log(
        `    Latency:  avg ${s.timing.avgMs.toFixed(0)}ms · p50 ${s.timing.p50Ms.toFixed(0)} · p95 ${s.timing.p95Ms.toFixed(0)} · max ${s.timing.maxMs.toFixed(0)}  (last ${s.timing.count} samples)`,
      );
    }
    if (s.lastErrorCode) {
      const when = s.lastErrorAt ? ` at ${s.lastErrorAt}` : "";
      console.log(`    Last err: ${s.lastErrorCode}${when}`);
    }
    if (s.observedSince && s.observedUntil) {
      console.log(`    Window:   ${s.observedSince} → ${s.observedUntil}`);
    }
  }
  console.log("");
  console.log("Stats are in-memory only and reset on process restart. Use --reset to clear within this process.");
}

async function priceCommandOnce(flags: Record<string, string>, positional: string[]) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  const tokenInput = positional[1] ?? "ETH";
  // resolveToken already passes through any well-shaped 0x address (chains.ts L228).
  // We deliberately reject malformed 0x inputs ("0xabc") instead of forwarding them to
  // the price API, which would return a cryptic "N/A".
  const resolved = resolveToken(profile, tokenInput);
  if (!resolved) {
    // Iter296: include the chain name so operators on a non-default chain see WHY
    // their symbol didn't resolve. Pre-iter296 `tradekit price PEPE --chain arbitrum`
    // on a profile that doesn't have PEPE produced just "Cannot resolve token PEPE" —
    // unclear whether the symbol was unknown anywhere or just on this chain.
    // Iter345: shared helper adds a "Did you mean" hint via closestMatch.
    throw unknownTokenError("token", tokenInput, profile);
  }
  const logger = makeCliLogger(flags);
  try {
    const period = flags["period"] ?? "1d";
    // Iter295: validate --period at the boundary even in JSON mode. Pre-iter295 a typo
    // like `--period 1week --json` silently produced JSON with no history (JSON mode
    // skips the preformatted history blob), so the typo looked successful. Now we
    // verify the period BEFORE deciding which output mode to use.
    const VALID_PERIODS = new Set(["1d", "1w", "1m", "1y"]);
    if (!VALID_PERIODS.has(period)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Invalid --period "${period}" — expected one of: ${[...VALID_PERIODS].join(", ")}.`,
      );
    }
    const { formatPrice } = await import("../holdings.js");
    // Iter769: --strict exit-code surface. When the price fetch returns null
    // (oracle unavailable, network failure, unknown token), exit 1 so cron
    // monitoring can alert on oracle health. Symmetric with iter761 gas
    // --strict — both gate on "external source unhealthy". Computed AFTER
    // print so the operator sees the result first. process.exitCode (not
    // process.exit) so main()'s audit-insert finally block runs (iter351).
    const strict = flags["strict"] === "true" || flags["strict"] === "";
    if (flags["json"] === "true") {
      // JSON mode: skip the history blob (which is preformatted text) and surface
      // just the structured current price. Scripted consumers wanting "what does
      // ETH cost right now?" get a clean shape they can pipe into other tooling.
      const current = await getCurrentPrice(resolved, logger);
      printJson({
        // Iter448: ok:true envelope parity (continues iter445/446/447 arc).
        // Additive — does not change the existing {token, chain, priceUsd, ...} shape.
        ok: true,
        token: resolved,
        chain: chainName,
        priceUsd: current,
        priceUsdFormatted: current != null ? formatPrice(current) : null,
        // Iter238: response-envelope timestamp for parity with gas (iter218),
        // holdings (iter219), pnl/reconcile (iter220), trade/transfer (iter221),
        // doctor (iter222). Lets consumers reason about freshness when polling
        // (e.g. `tradekit price ETH --watch --json`).
        timestamp: new Date().toISOString(),
      });
      if (strict && current == null) process.exitCode = 1;
      return;
    }
    const [current, history] = await Promise.all([
      getCurrentPrice(resolved, logger),
      getPriceHistory(resolved, period, logger),
    ]);
    console.log(`Token: ${resolved}`);
    console.log(`Current: ${current != null ? formatPrice(current) : "N/A"}`);
    console.log("");
    console.log(history);
    if (strict && current == null) process.exitCode = 1;
  } finally {
    logger.close();
  }
}

// ── price-check (iter613) ────────────────────────────────────
//
// `tradekit price-check <token>` — cross-source price sanity probe.
// Fans out to CoinGecko + DexScreener in parallel + compares.

export async function priceCheckCommand(
  flags: Record<string, string>,
  positional: string[],
) {
  const tokenAddress = positional[1];
  if (!tokenAddress) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Usage: tradekit price-check <token-address-or-symbol> [--tolerance-pct N] [--extreme-pct N] [--json]",
      { details: { reason: "missing_token" } },
    );
  }
  // Resolve symbol→address if needed (same as `price` command does). Otherwise
  // the operator can pass a raw 0x address directly.
  let resolved = tokenAddress;
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    const config = loadConfig();
    const chainName = flags["chain"] ?? config.activeChain;
    const profile = resolveProfile(chainName, config);
    const r = resolveToken(profile, tokenAddress);
    if (!r) throw unknownTokenError(tokenAddress, tokenAddress, profile);
    resolved = r;
  }
  const logger = makeCliLogger(flags);
  try {
    const tolerancePct = flags["tolerance-pct"] ? parseFloat(flags["tolerance-pct"]) : undefined;
    const extremePct = flags["extreme-pct"] ? parseFloat(flags["extreme-pct"]) : undefined;
    const { crossCheckPrice, shortVerdictLine } = await import("../priceCrossCheck.js");
    const check = await crossCheckPrice({
      tokenAddress: resolved,
      logger,
      tolerancePct,
      extremePct,
    });

    // Iter777: --strict exit-code gate. Actionable-bad verdicts are
    // "suspicious" (sources disagree beyond tolerance) and "extreme" (sources
    // disagree by a lot). "one_source" stays exit 0 — only one oracle had a
    // price, but the result isn't itself wrong; "unknown" stays exit 0 too
    // (no probe data, not bad-detected). Pipeline gates only on KNOWN
    // divergence. Symmetric with iter772 preflight / iter776 token check —
    // each strict mode triggers on the command's actionable-bad states.
    const strict = flags["strict"] === "true" || flags["strict"] === "";
    const isBad = check.verdict === "suspicious" || check.verdict === "extreme";

    if (flags["json"] === "true") {
      printJson({ ok: true, ...check });
      if (strict && isBad) process.exitCode = 1;
      return;
    }
    console.log(shortVerdictLine(check));
    console.log("");
    console.log(`  Token:         ${check.token}`);
    console.log(`  CoinGecko:     ${check.coinGeckoPrice != null ? `$${check.coinGeckoPrice}` : "—"}`);
    console.log(`  DexScreener:   ${check.dexScreenerPrice != null ? `$${check.dexScreenerPrice}` : "—"}`);
    if (check.divergencePct != null && check.divergencePct !== Infinity) {
      console.log(`  Divergence:    ${check.divergencePct.toFixed(2)}% (tolerance ${check.tolerancePct}%, extreme ${check.extremePct}%)`);
    }
    console.log("");
    console.log("  Reasoning:");
    console.log(`    ${check.reason}`);
    if (strict && isBad) process.exitCode = 1;
  } finally {
    logger.close();
  }
}
