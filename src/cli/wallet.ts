// Wallet + HD account CLI commands. Lifted from index.ts.

import { existsSync } from "fs";
import { WALLET_PATH, MNEMONIC_PATH } from "../constants.js";
import { loadConfig, resolveProfile } from "../config.js";
import { assertKnownChain } from "../chains.js";
import {
  createWallet,
  importWallet,
  exportWallet,
  activeWalletAddress,
  activeWalletLabel,
  getKeystoreAddress,
} from "../wallet.js";
import {
  createMnemonicWallet,
  importMnemonicWallet,
  hasMnemonic,
  listAccounts,
  addAccount,
  setActiveAccount,
} from "../accounts.js";
import { holdingsOnChain, formatHoldings, formatUsd } from "../holdings.js";
import { listAllowances } from "../approvals.js";
import { recentTrades } from "../db.js";
import { ToolError } from "../errors.js";
import { sanitizeForLogLine } from "../logger.js";
import { makeCliLogger, printJson, prompt, promptPassword, requirePassword, withWatch, tradeStatusMarker, parseIntFlag, checkPasswordStrength } from "./helpers.js";

// ── single-key wallet commands ─────────────────────────────────

export async function walletCreate(flags: Record<string, string>) {
  if (existsSync(WALLET_PATH)) {
    // Iter452: surface what's being overwritten + the catastrophic consequence.
    // Pre-iter452 the prompt just said "Wallet already exists. Overwrite?" — an
    // operator typing "yes" might not realize the existing keystore (which holds
    // their PRIVATE KEY) is about to be replaced with a brand-new key, losing
    // access to any funds at the existing address. Surfacing the existing address
    // makes the consequence concrete; the explicit "PERMANENT" warning forces the
    // operator to think twice.
    const existingAddress = getKeystoreAddress();
    if (existingAddress) {
      console.log(`⚠  PERMANENT: this will overwrite the existing keystore at ${WALLET_PATH}.`);
      console.log(`⚠  The current wallet at ${existingAddress} will be UNRECOVERABLE without its private key backup.`);
    } else {
      console.log(`⚠  An existing (but unreadable) keystore is at ${WALLET_PATH}.`);
    }
    const answer = await prompt("Type 'yes' to overwrite, anything else to abort: ");
    // Iter332: print "Aborted." rather than silently returning. Operators conditioned by
    // apt/brew often type "y" — the prompt insists on full "yes" (deliberate friction for
    // a destructive overwrite), but without an explicit Aborted line the silent exit looks
    // like a hang or crash. The three other destructive confirms (export, audit prune,
    // revoke-all) already say "Aborted." — this aligns the rest.
    if (answer.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }
  const nonInteractive = flags["pass"] || process.env.WALLET_PASS;
  let pass: string;
  if (nonInteractive) pass = await requirePassword(flags);
  else {
    pass = await promptPassword("Enter password: ");
    const pass2 = await promptPassword("Confirm password: ");
    if (pass !== pass2) throw new ToolError("INVALID_PARAMS", "Passwords do not match.");
  }
  // Refuse empty; warn loudly on weak. Same check applied across init / wallet
  // create+import / account create-mnemonic so no wallet-create path skips the gate.
  const { warnings } = checkPasswordStrength(pass);
  for (const w of warnings) console.error(`⚠  ${w}`);
  const logger = makeCliLogger(flags);
  try {
    const address = await createWallet(pass, logger);
    // Iter330: JSON output for scripted setup. createdAt = now (the wallet file's
    // mtime is set by writeFileSecure but isn't surfaced — generate here for parity
    // with accountAdd's JSON shape and audit traceability).
    if (flags["json"] === "true") {
      printJson({ ok: true, kind: "keystore", address, createdAt: new Date().toISOString() });
    } else {
      console.log(`Wallet created: ${address}`);
    }
  } finally {
    logger.close();
  }
}

export async function walletImport(flags: Record<string, string>) {
  if (existsSync(WALLET_PATH)) {
    // Iter452: same destructive-overwrite warning as walletCreate. Importing a new
    // private key over an existing keystore is just as catastrophic as creating
    // a fresh one — the previous wallet's funds become unrecoverable without
    // the operator's external backup of its private key.
    const existingAddress = getKeystoreAddress();
    if (existingAddress) {
      console.log(`⚠  PERMANENT: this will overwrite the existing keystore at ${WALLET_PATH}.`);
      console.log(`⚠  The current wallet at ${existingAddress} will be UNRECOVERABLE without its private key backup.`);
    } else {
      console.log(`⚠  An existing (but unreadable) keystore is at ${WALLET_PATH}.`);
    }
    const answer = await prompt("Type 'yes' to overwrite with the imported key, anything else to abort: ");
    if (answer.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }
  // promptPassword (no-echo) — private keys are higher-stakes than passwords:
  // they're plaintext-equivalent to the wallet itself, and `prompt()`'s echo would
  // expose the key on screen, in scrollback, in screen recordings, and in many
  // terminal-emulator logs. The BIP-39/keystore decrypt step validates the input.
  const privateKey = await promptPassword("Enter private key (not echoed): ");
  const nonInteractive = flags["pass"] || process.env.WALLET_PASS;
  let pass: string;
  if (nonInteractive) pass = await requirePassword(flags);
  else {
    pass = await promptPassword("Enter password: ");
    const pass2 = await promptPassword("Confirm password: ");
    if (pass !== pass2) throw new ToolError("INVALID_PARAMS", "Passwords do not match.");
  }
  const { warnings } = checkPasswordStrength(pass);
  for (const w of warnings) console.error(`⚠  ${w}`);
  const logger = makeCliLogger(flags);
  try {
    const address = await importWallet(privateKey, pass, logger);
    // Iter330: JSON output parity with walletCreate. Same shape — scripts can
    // handle create and import uniformly.
    if (flags["json"] === "true") {
      printJson({ ok: true, kind: "keystore", address, createdAt: new Date().toISOString() });
    } else {
      console.log(`Wallet imported: ${address}`);
      console.log(`Next: run \`tradekit wallet view\` to inspect balances.`);
    }
  } finally {
    logger.close();
  }
}

export async function walletExport(flags: Record<string, string>) {
  // Refuse to dump the private key without explicit user acknowledgement. The export
  // prints to stdout — visible in scrollback, screen recordings, terminal-emulator
  // logs, and anything piped (` | tee export.txt` accidentally goes everywhere). One
  // confirmation is cheap; the consequence of a leaked private key is total.
  // Non-interactive scripts pass --yes to skip.
  if (flags["yes"] !== "true") {
    // Iter457: name WHICH wallet is about to be exported. An operator with both an
    // HD mnemonic and a single-key keystore (iter331's dual-wallet case) might think
    // they're exporting one when really they're exporting the other (walletExport is
    // single-key-only; HD uses `account export-mnemonic` if it existed — currently
    // not exposed). Surfacing the address forces a deliberate "yes, that's the one"
    // before printing the key. Falls back to "the single-key wallet" when the address
    // can't be read (corrupted keystore — still better to confirm than leak).
    const targetAddr = getKeystoreAddress();
    const subject = targetAddr ? `the private key for ${targetAddr}` : "the single-key wallet's private key";
    console.error(
      `⚠  This will print ${subject} to stdout. Anyone watching the terminal — or anything reading the output stream — gets full control of this wallet.`,
    );
    const answer = await prompt("Continue? (yes/no): ");
    if (answer.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }
  const pass = await requirePassword(flags);
  const logger = makeCliLogger(flags);
  try {
    const pk = await exportWallet(pass, logger);
    console.log(pk);
  } finally {
    logger.close();
  }
}

export async function walletView(flags: Record<string, string>) {
  await withWatch(flags, () => walletViewOnce(flags));
}

async function walletViewOnce(flags: Record<string, string>) {
  const address = activeWalletAddress();
  // Iter545: paste-ready CLI form (iter435/508/etc convention). Pre-iter545 the
  // hint used quoted-but-not-paste-ready labels — `tradekit init` is the friendlier
  // first-time path that walks both wallet options.
  if (!address) {
    throw new ToolError(
      "WALLET_NOT_FOUND",
      "No wallet found. Run `tradekit init` for a guided setup, or `tradekit wallet create` (single-key) / `tradekit account create-mnemonic` (HD) directly.",
      { details: { reason: "no_wallet" } },
    );
  }

  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  const logger = makeCliLogger(flags);
  try {
    // Balances — public RPC only, no password needed.
    const reports = await holdingsOnChain(address, chainName, config, logger);

    // Standing allowances — surfaces risk exposure inline.
    const { createPublicClient } = await import("viem");
    const { makeTransport } = await import("../chains.js");
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    const publicClient = createPublicClient({
      chain: profile.viemChain,
      transport: makeTransport(profile, extraRpcs),
    });
    // Iter451: don't silently swallow listAllowances errors. Pre-iter451 a thrown
    // allowance check (RPC failure, transport error, custom chain with broken token
    // list) was indistinguishable from "no standing approvals" — the operator saw
    // an empty list and might assume their wallet had no outstanding exposure when
    // really the check failed. Log the warning so it surfaces in stderr (at warn
    // level) and server.log; empty array still returned so the composite snapshot
    // doesn't fail entirely.
    let allowancesError: string | null = null;
    const allowances = await listAllowances(
      { publicClient: publicClient as never, profile, owner: address, logger },
      {},
    ).catch((e: unknown) => {
      const msg = (e as Error).message ?? String(e);
      allowancesError = msg;
      // Iter478: sanitize before logging — listAllowances catches viem errors.
      logger.warn(sanitizeForLogLine(`wallet view: allowance check failed — ${msg}. Standing approvals shown below may be incomplete.`));
      return [];
    });

    // Recent trades for this account/chain. Iter501: route the account fallback
    // through activeWalletLabel so the filter matches the rows trades actually
    // wrote — in the orphan-accounts.json case the trade went to "keystore" but
    // activeAccountEntry().label would say "alice", and the recent-trades list
    // would silently show nothing (or someone else's history).
    const trades = recentTrades({
      account: activeWalletLabel(),
      chain: chainName,
      limit: 5,
    });

    if (flags["json"] === "true") {
      // Composite snapshot — same data the text view shows, in one structured payload
      // for agents / dashboards. Pre-iter210 there was no way to get this without three
      // separate calls (holdings, allowances, trades).
      printJson({
        // Iter432: ok: true envelope parity (continues iter431's account list pass).
        // Purely additive — does not change the existing fields.
        ok: true,
        address,
        // Iter505: account field now mirrors activeWalletLabel (matches what
        // loadWallet would use). Pre-iter505 the field was `null` for keystore-only
        // setups and `"alice"` in the orphan-accounts case — both diverged from
        // what trade/transfer attribution would record. Now consistent with the
        // iter499-504 arc: the field is always a usable account label.
        account: activeWalletLabel(),
        chain: { name: profile.name, chainId: profile.chainId },
        balances: reports,
        allowances,
        // Iter451: surface the allowance-check failure to programmatic consumers
        // too. null when the check succeeded (most cases); error message string
        // when it didn't. Lets a dashboard distinguish "no approvals" from
        // "approvals couldn't be checked" without parsing stderr.
        allowancesError,
        recentTrades: trades,
        // Iter247: top-level snapshot timestamp for parity with gas/holdings/pnl/etc
        // (iter218-238). `balances.timestamp` exists but reflects only the balance read;
        // a consumer wanting the freshness of the COMPOSITE snapshot needs a single ISO
        // that covers all three sub-reads.
        timestamp: new Date().toISOString(),
      });
      return;
    }

    console.log(`Address: ${address}`);
    // Iter505: show the Account line only when the active wallet is HD (label !=
    // "keystore"). Pre-iter505 the orphan-accounts.json case displayed
    // `Account: alice` while iter499 had already made `Address` resolve to the
    // keystore — confusing to the operator. activeWalletLabel applies the same
    // mnemonic.json gate as everything else.
    const label = activeWalletLabel();
    if (label !== "keystore") console.log(`Account: ${label}`);
    console.log(`Chain: ${profile.name} (${profile.chainId})`);
    console.log("");
    console.log(formatHoldings([reports]));

    if (allowances.length > 0) {
      console.log("");
      console.log("Standing approvals (review for unused exposure):");
      for (const r of allowances) {
        const flag = r.display === "infinite" ? "  ⚠ INFINITE" : "";
        console.log(`  ${r.symbol.padEnd(8)} ${r.display.padEnd(16)} → ${r.spenderLabel ?? r.spender}${flag}`);
      }
    } else if (allowancesError) {
      // Iter451: surface the allowance-check failure in text mode too. Pre-iter451
      // a failed enumeration printed nothing here, indistinguishable from "no standing
      // approvals" — a misleading security signal. Iter461: clarify wording — when
      // the list is empty AND the check failed, "the list above" was misleading (no
      // list was rendered). Now states the actual situation: the check itself failed,
      // so unknown — not the same as "zero approvals exist".
      console.log("");
      console.log("⚠  Standing approvals: check failed — could not enumerate. Use `tradekit allowances` to retry, or check the RPC for this chain.");
    }

    if (trades.length > 0) {
      console.log("");
      console.log("Recent trades:");
      for (const t of trades) {
        const sign = t.direction === "buy" ? "+" : "-";
        const marker = tradeStatusMarker(t.status);
        console.log(
          `${marker} ${t.timestamp.slice(0, 19).replace("T", " ")}  ${t.direction.toUpperCase().padEnd(4)} ` +
            `${sign}${t.base_amount} ${t.base_symbol ?? ""}  @ ${t.price}  via ${t.aggregator ?? "?"}  ${t.status}`,
        );
      }
    }
  } finally {
    logger.close();
  }
}

// ── HD account commands ────────────────────────────────────────

export async function accountCreate(flags: Record<string, string>) {
  if (hasMnemonic()) {
    // Iter453: same iter452-style destructive-overwrite warning for the HD mnemonic
    // path. Overwriting the mnemonic abandons EVERY derived account (each labelled
    // entry in accounts.json) — the addresses live on but the private keys become
    // unrecoverable without the original seed. Surfacing the labels makes the
    // consequence concrete instead of leaving the operator to imagine it.
    const file = listAccounts();
    const labels = file?.accounts.map((a) => `${a.label} (${a.address})`).join(", ");
    console.log(`⚠  PERMANENT: this will overwrite the existing mnemonic at ${MNEMONIC_PATH}.`);
    if (labels) {
      console.log(`⚠  All derived accounts will become UNRECOVERABLE without the original seed: ${labels}.`);
    } else {
      console.log(`⚠  The existing mnemonic will become UNRECOVERABLE without its seed backup.`);
    }
    const answer = await prompt("Type 'yes' to overwrite, anything else to abort: ");
    if (answer.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }
  const nonInteractive = flags["pass"] || process.env.WALLET_PASS;
  let pass: string;
  if (nonInteractive) pass = await requirePassword(flags);
  else {
    pass = await promptPassword("Enter password: ");
    const pass2 = await promptPassword("Confirm password: ");
    if (pass !== pass2) throw new ToolError("INVALID_PARAMS", "Passwords do not match.");
  }
  const { warnings } = checkPasswordStrength(pass);
  for (const w of warnings) console.error(`⚠  ${w}`);
  const { mnemonic, address } = createMnemonicWallet(pass);
  // Iter364: --json for scripted HD setup. The mnemonic IS the recoverable secret —
  // text mode prints it with an IMPORTANT prose banner; JSON mode includes it as a
  // field, leaving secret-handling to the calling pipeline (encrypted backup store,
  // KMS, whatever). No additional --yes gate here because creating a wallet without
  // seeing its mnemonic is useless: the mnemonic display is inherent to the command.
  // Same shape conventions as iter330 (walletCreate/Import) and iter283 (accountImport).
  if (flags["json"] === "true") {
    printJson({ ok: true, kind: "hd", address, defaultLabel: "default", mnemonic, createdAt: new Date().toISOString() });
    return;
  }
  console.log(`HD wallet created.`);
  console.log(`Default account address: ${address}`);
  console.log("");
  console.log(`IMPORTANT — back up this mnemonic. It is the only way to recover the wallet:`);
  console.log("");
  console.log(`  ${mnemonic}`);
}

export async function accountImport(flags: Record<string, string>) {
  if (hasMnemonic()) {
    // Iter453: same destructive-overwrite warning as accountCreate. Importing a
    // new mnemonic over an existing one orphans every derived account just as
    // certainly as creating a fresh mnemonic does.
    const file = listAccounts();
    const labels = file?.accounts.map((a) => `${a.label} (${a.address})`).join(", ");
    console.log(`⚠  PERMANENT: this will overwrite the existing mnemonic at ${MNEMONIC_PATH}.`);
    if (labels) {
      console.log(`⚠  All derived accounts will become UNRECOVERABLE without the original seed: ${labels}.`);
    } else {
      console.log(`⚠  The existing mnemonic will become UNRECOVERABLE without its seed backup.`);
    }
    const answer = await prompt("Type 'yes' to overwrite with the imported mnemonic, anything else to abort: ");
    if (answer.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }
  // No-echo (same reasoning as wallet import). BIP-39 checksum in importMnemonicWallet
  // catches typos cleanly, so the lack of visual feedback isn't a usability risk.
  const mnemonic = await promptPassword("Enter mnemonic (not echoed; words separated by spaces): ");
  // Iter317: double-confirm password in interactive mode. Pre-iter317 the password
  // was prompted once; a typo encrypted the mnemonic with the wrong key, and the
  // operator only discovered it on first decrypt (next trade or account list).
  // Recovery required re-importing the mnemonic — usually fine but easy to avoid.
  // walletImport / accountCreate already do this confirm; accountImport was the holdout.
  const nonInteractive = flags["pass"] || process.env.WALLET_PASS;
  let pass: string;
  if (nonInteractive) {
    pass = await requirePassword(flags);
  } else {
    pass = await promptPassword("Enter password: ");
    const pass2 = await promptPassword("Confirm password: ");
    if (pass !== pass2) throw new ToolError("INVALID_PARAMS", "Passwords do not match.");
  }
  const { warnings } = checkPasswordStrength(pass);
  for (const w of warnings) console.error(`⚠  ${w}`);
  const address = importMnemonicWallet(mnemonic, pass);
  // Iter330: JSON output for scripted HD setup. Shape matches walletCreate/Import.
  if (flags["json"] === "true") {
    printJson({ ok: true, kind: "hd", address, defaultLabel: "default", createdAt: new Date().toISOString() });
  } else {
    console.log(`HD wallet imported. Default account: ${address}`);
    console.log(`Next: \`tradekit wallet view\` (inspect) or \`tradekit account add <label>\` (derive more accounts).`);
  }
}

/**
 * Iter746: pure helper computing the set of account labels with at least one
 * stale sync bookmark. "Stale" matches the iter741 PnL threshold (48h) so
 * the marker emitted here is consistent with the warnings PnL / health /
 * doctor already surface. ANY bookmark across ANY chain for the account
 * being stale puts the account in the set — operators don't think about
 * "stale on chain X but fresh on Y", they think "is this account being
 * synced or not". Exported for unit testing.
 */
export function computeStaleAccountSet(
  bookmarks: ReadonlyArray<{ account: string; updatedAt: string }>,
  nowMs: number,
  staleAfterHours = 48,
): Set<string> {
  const thresholdMs = staleAfterHours * 3_600_000;
  const out = new Set<string>();
  for (const b of bookmarks) {
    const ageMs = nowMs - new Date(b.updatedAt).getTime();
    if (ageMs > thresholdMs) out.add(b.account);
  }
  return out;
}

export async function accountList(flags: Record<string, string>) {
  const file = listAccounts();
  const config = loadConfig();
  // Iter383: validate --chain up-front via assertKnownChain (iter286/287) so a typo
  // like `--chain baes` is rejected with the iter343 typo suggestion instead of being
  // silently dropped. Pre-iter383 the --no-balances / --json fast paths skipped
  // resolveProfile entirely, so a typo'd chain produced no error — operator could
  // think they got "balances on chain X" but really got just the labels.
  assertKnownChain(flags["chain"], config);
  const chainName = flags["chain"] ?? config.activeChain;

  // Single-key fallback: never hide the active wallet from inspection.
  if (!file) {
    const keystoreAddr = getKeystoreAddress();
    if (!keystoreAddr) {
      // Iter339: honor --json on the empty-state path. Pre-iter339 a scripted consumer
      // doing `tradekit account list --json | jq` on a fresh install got the text
      // "No wallet configured." which crashed jq with a parse error — the JSON contract
      // was silently violated by the very first command an automation script might run.
      // Now emit the same shape as the populated paths (active=null, accounts=[]) so
      // consumers get a stable parseable result; the text hint stays on the human path.
      if (flags["json"] === "true") {
        // Iter431: ok: true field for envelope parity with other tradekit --json
        // surfaces (iter422 closed the last bare-array; this closes the last
        // ok-less envelope on account list). Purely additive — does not change
        // the existing {active, accounts, timestamp} shape.
        printJson({ ok: true, active: null, accounts: [], timestamp: new Date().toISOString() });
      } else {
        console.log("No wallet configured. Run 'tradekit wallet create' or 'tradekit account create-mnemonic'.");
      }
      return;
    }
    if (flags["no-balances"] === "true" || flags["json"] === "true") {
      const out = {
        // Iter431: ok: true for envelope parity (see comment above on null-active branch).
        ok: true,
        active: "keystore",
        accounts: [{ label: "keystore", index: 0, address: keystoreAddr, createdAt: null }],
        // Iter323: snapshot timestamp for parity with iter247/248 composite snapshots.
        timestamp: new Date().toISOString(),
      };
      if (flags["json"] === "true") printJson(out);
      else {
        console.log("Active: keystore  (single-key wallet — no HD mnemonic)");
        console.log("");
        console.log(` * keystore             index=0  ${keystoreAddr}`);
      }
      return;
    }
    const logger = makeCliLogger(flags);
    try {
      const r = await holdingsOnChain(keystoreAddr, chainName, config, logger);
      const nonZero = r.balances.filter((b) => parseFloat(b.amount) > 0);
      const balStr =
        nonZero.length === 0
          ? "(empty)"
          : nonZero.map((b) => `${b.amount} ${b.symbol}${b.usd != null ? ` (${formatUsd(b.usd)})` : ""}`).join(", ");
      console.log("Active: keystore  Chain: " + chainName + "    (single-key wallet — no HD mnemonic)");
      console.log("");
      console.log(` *  keystore             index=0  ${keystoreAddr}  ${balStr}`);
    } finally {
      logger.close();
    }
    return;
  }

  // Iter746: per-account stale-sync set — single DB read, used by both render
  // paths (--no-balances + default). An account is "sync stale" when ANY of
  // its (chain, account, owner) bookmarks across all chains hasn't advanced
  // in PNL_STALE_BOOKMARK_HOURS=48h (same threshold as PnL/health/doctor).
  // Operators scanning their accounts list see the same staleness signal
  // already surfaced elsewhere; one consistent threshold across surfaces.
  const { listSyncBookmarks, accountActivitySummary } = await import("../db.js");
  const staleAccountSet = computeStaleAccountSet(listSyncBookmarks(), Date.now());

  // --no-balances fast path
  if (flags["no-balances"] === "true") {
    // Iter715/iter735: per-account activity — cheap GROUP BY query against
    // trades. Surfaces "actively trading" + "how active" at a glance for
    // operators with many HD accounts.
    const activity = accountActivitySummary();
    if (flags["json"] === "true") {
      // Iter823: pre-computed summary so dashboards don't iterate the accounts
      // array to compute counts. Symmetric with iter767/779/780/781 — same
      // "save the iteration" pattern. Always-present zero baselines.
      let withTrades = 0;
      for (const a of file.accounts) {
        if (activity.get(a.label)) withTrades++;
      }
      printJson({
        // Iter431: ok: true for envelope parity.
        ok: true,
        active: file.active,
        summary: {
          total: file.accounts.length,
          withTrades,
          stale: staleAccountSet.size,
        },
        accounts: file.accounts.map((a) => {
          const act = activity.get(a.label);
          const base = act
            ? {
                ...a,
                tradeCount: act.tradeCount,
                firstTradeAt: act.firstTradeAt,
                lastTradeAt: act.lastTradeAt,
              }
            : { ...a };
          // Iter746: surface syncStale only when true — absent = fresh / no bookmarks.
          return staleAccountSet.has(a.label) ? { ...base, syncStale: true } : base;
        }),
        // Iter323: snapshot timestamp parity (iter247/248).
        timestamp: new Date().toISOString(),
      });
      return;
    }
    // Iter821: severity badge — any account stale triggers 🟡 WARN.
    // Same trigger that drives the per-row [sync stale] markers below.
    const noBalBadge = staleAccountSet.size > 0 ? "🟡 WARN" : "🟢 OK  ";
    console.log(`${noBalBadge}  Active: ${file.active}`);
    console.log("");
    for (const a of file.accounts) {
      const marker = a.label === file.active ? "*" : " ";
      const act = activity.get(a.label);
      const activityBit = act
        ? `  ${act.tradeCount} trade${act.tradeCount === 1 ? "" : "s"}, last: ${act.lastTradeAt.slice(0, 10)}`
        : "  (no trades)";
      // Iter746: stale-sync marker. Same threshold as iter741 PnL warning;
      // keeps the signal consistent across surfaces.
      const staleBit = staleAccountSet.has(a.label) ? "  [sync stale]" : "";
      console.log(` ${marker} ${a.label.padEnd(20)} index=${a.index}  ${a.address}${activityBit}${staleBit}`);
    }
    return;
  }

  // Default: balances per account on the active chain.
  const logger = makeCliLogger(flags);
  // Iter715/iter735: per-account activity — same query as the no-balances path.
  const activity = accountActivitySummary();
  try {
    const reports = await Promise.all(
      file.accounts.map(async (a) => {
        try {
          const r = await holdingsOnChain(a.address, chainName, config, logger);
          return { label: a.label, index: a.index, address: a.address, report: r, error: null };
        } catch (e) {
          // Capture the error MESSAGE so JSON consumers can distinguish (and possibly
          // surface) WHY a particular account failed, not just THAT it failed. The
          // text view (line 322) just shows "(balance unknown — RPC error)"; JSON
          // gets the actual error message.
          return {
            label: a.label,
            index: a.index,
            address: a.address,
            report: null,
            error: (e as Error).message,
          };
        }
      }),
    );
    if (flags["json"] === "true") {
      // Iter823: pre-computed summary for the with-balances path. Includes
      // rpcErrors count surfacing accounts whose balance couldn't be fetched
      // (their `report` field is null). Same pattern as the no-balances path
      // above + a chain-error count.
      let withTrades = 0;
      let rpcErrors = 0;
      for (const r of reports) {
        if (activity.get(r.label)) withTrades++;
        if (r.report == null) rpcErrors++;
      }
      printJson({
        // Iter431: ok: true for envelope parity.
        ok: true,
        active: file.active,
        chain: chainName,
        summary: {
          total: reports.length,
          withTrades,
          stale: staleAccountSet.size,
          rpcErrors,
        },
        accounts: reports.map((r) => {
          const act = activity.get(r.label);
          const base = act
            ? {
                ...r,
                tradeCount: act.tradeCount,
                firstTradeAt: act.firstTradeAt,
                lastTradeAt: act.lastTradeAt,
              }
            : { ...r };
          // Iter746: surface syncStale only when true (additive).
          return staleAccountSet.has(r.label) ? { ...base, syncStale: true } : base;
        }),
        // Iter323: snapshot timestamp parity (iter247/248). This path's `reports`
        // are per-account holdings — each has its own balance.timestamp; the
        // envelope timestamp marks when the composite scan was assembled.
        timestamp: new Date().toISOString(),
      });
      return;
    }
    // Iter821: severity badge — any stale account OR any RPC-failed account
    // triggers 🟡 WARN. Covers both the iter746 stale signal AND fetch-side
    // failures surfaced inline as "(balance unknown — RPC error)".
    const anyRpcFail = reports.some((r) => r.report == null);
    const balBadge = staleAccountSet.size > 0 || anyRpcFail ? "🟡 WARN" : "🟢 OK  ";
    console.log(`${balBadge}  Active: ${file.active}    Chain: ${chainName}`);
    console.log("");
    console.log("    Label                Index  Address                                       Balances (non-zero)");
    console.log("    " + "-".repeat(115));
    // Iter783: accumulate cross-account USD total for the footer summary.
    // Operators eyeballing accounts list want "how much across everything?"
    // without manually summing the per-row [$X.XX] columns. Skipped when
    // every account is balance-unknown (RPC errors everywhere) — the existing
    // per-row message already explains that case.
    let grandTotal = 0;
    let pricedAccountCount = 0;
    for (const r of reports) {
      const marker = r.label === file.active ? "*" : " ";
      // Distinguish "RPC failed → don't know" from "actually empty". Pre-iter189 both
      // showed "(empty)" — an operator with RPC issues thought their funds had vanished.
      let balStr: string;
      if (r.report == null) {
        balStr = "(balance unknown — RPC error)";
      } else {
        const nonZero = r.report.balances.filter((b) => parseFloat(b.amount) > 0);
        balStr =
          nonZero.length === 0
            ? "(empty)"
            : nonZero.map((b) => `${b.amount} ${b.symbol}${b.usd != null ? ` (${formatUsd(b.usd)})` : ""}`).join(", ");
      }
      const total = r.report?.totalUsd != null ? `  [${formatUsd(r.report.totalUsd)}]` : "";
      if (r.report?.totalUsd != null) {
        grandTotal += r.report.totalUsd;
        pricedAccountCount += 1;
      }
      // Iter715/iter735: append per-account activity (count + last) when known.
      const act = activity.get(r.label);
      const activityBit = act
        ? `   ${act.tradeCount} trade${act.tradeCount === 1 ? "" : "s"}, last: ${act.lastTradeAt.slice(0, 10)}`
        : "";
      // Iter746: stale-sync marker — same threshold/style as the no-balances path.
      const staleBit = staleAccountSet.has(r.label) ? "  [sync stale]" : "";
      console.log(` ${marker}  ${r.label.padEnd(20)} ${String(r.index).padEnd(6)} ${r.address}  ${balStr}${total}${activityBit}${staleBit}`);
    }
    // Iter783: footer total across accounts. Only shown when ≥2 accounts had
    // priced balances — single-account view doesn't benefit from the sum.
    if (pricedAccountCount >= 2) {
      console.log("");
      console.log(`    Total across ${pricedAccountCount} account${pricedAccountCount === 1 ? "" : "s"}: ${formatUsd(grandTotal)}`);
    }
  } finally {
    logger.close();
  }
}

export async function accountAdd(flags: Record<string, string>, label: string | undefined) {
  if (!label) throw new ToolError("INVALID_PARAMS", "Usage: tradekit account add <label> [--index N]");
  // Iter304: parse --index BEFORE prompting for password. Pre-iter304 a typo'd
  // `--index abc` made the operator type a password before learning the flag was
  // bad. Same fail-fast pattern as iter302/303. HD derivation indices are
  // conventionally bounded by the hardened-key cap; we cap at 2^31-1 to stay in
  // the non-hardened range.
  const index = parseIntFlag(flags["index"], "--index", { min: 0, max: 2_147_483_647 });
  const pass = await requirePassword(flags);
  const entry = addAccount(label, pass, index);
  // Iter329: JSON output for scripted setup (e.g., a deployment script provisioning
  // multiple HD accounts wants the new address programmatically). Text mode unchanged.
  if (flags["json"] === "true") {
    printJson(entry);
    return;
  }
  console.log(`Added account "${entry.label}" at index ${entry.index}: ${entry.address}`);
}

export async function accountUse(label: string | undefined, flags: Record<string, string> = {}) {
  if (!label) {
    // Help the operator pick the right label: include the known list and active marker.
    const file = listAccounts();
    if (!file || file.accounts.length === 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        "Usage: tradekit account use <label>. No accounts yet — run `account create-mnemonic` first.",
      );
    }
    const known = file.accounts.map((a) => (a.label === file.active ? `${a.label} (active)` : a.label)).join(", ");
    throw new ToolError(
      "INVALID_PARAMS",
      `Usage: tradekit account use <label>. Known: ${known}.`,
    );
  }
  // Iter327: report whether the active account actually changed. Same honesty
  // discipline as iter312 (config set) / iter326 (chain switch).
  const beforeFile = listAccounts();
  const previous = beforeFile?.active;
  const file = setActiveAccount(label);
  const changed = previous !== file.active;
  // Iter360: --json output for scripted setup. Same honesty signal (changed: true/false)
  // as iter312/iter326/iter327 emit in text mode — automation now gets it as structured
  // data instead of having to parse the "(no change: …)" vs "Active account: … → …" lines.
  if (flags["json"] === "true") {
    printJson({
      // Iter449: ok:true envelope parity (continues iter445-448 arc).
      ok: true,
      previousActive: previous ?? null,
      active: file.active,
      changed,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (changed) {
    console.log(`Active account: ${previous ?? "(none)"} → ${file.active}.`);
  } else {
    console.log(`(no change: active account was already ${file.active})`);
  }
}

// ── address book (iter614) ───────────────────────────────────
//
// `tradekit address add <name> <addr> [--note "..."]`
// `tradekit address list`
// `tradekit address remove <name>`
//
// The address book defends against typos + clipboard-hijack by saving the
// canonical address once. Recipients in transfer flows can reference
// `@name` to resolve via the book.

export async function addressCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  switch (action) {
    case "add": {
      const name = positional[2];
      const address = positional[3];
      if (!name || !address) {
        throw new ToolError(
          "INVALID_PARAMS",
          "Usage: tradekit address add <name> <0x-address> [--note \"...\"] [--force]",
          { details: { reason: "missing_args" } },
        );
      }
      const { addAddressEntry } = await import("../addressBook.js");
      const entry = addAddressEntry({
        name,
        address,
        note: flags["note"],
        overwrite: flags["force"] === "true",
      });
      if (flags["json"] === "true") {
        printJson({ ok: true, action: "added", entry });
        return;
      }
      console.log(`Added @${entry.name} → ${entry.address}`);
      if (entry.note) console.log(`  Note: ${entry.note}`);
      break;
    }
    case "remove": {
      const name = positional[2];
      if (!name) {
        throw new ToolError(
          "INVALID_PARAMS",
          "Usage: tradekit address remove <name>",
          { details: { reason: "missing_name" } },
        );
      }
      const { removeAddressEntry } = await import("../addressBook.js");
      const removed = removeAddressEntry(name);
      if (flags["json"] === "true") {
        printJson({ ok: true, action: "removed", entry: removed });
        return;
      }
      console.log(`Removed @${removed.name} (${removed.address})`);
      break;
    }
    case "list":
    case undefined: {
      const { listAddressEntries } = await import("../addressBook.js");
      const entries = listAddressEntries();
      if (flags["json"] === "true") {
        printJson({ ok: true, entries });
        return;
      }
      if (entries.length === 0) {
        console.log("(no address book entries — add one with `tradekit address add <name> <0x-address>`)");
        return;
      }
      console.log(`Address book (${entries.length} ${entries.length === 1 ? "entry" : "entries"}):`);
      console.log("");
      for (const e of entries) {
        console.log(`  @${e.name.padEnd(20)} ${e.address}${e.note ? "  — " + e.note : ""}`);
      }
      break;
    }
    default:
      throw new ToolError(
        "INVALID_PARAMS",
        `Unknown address action: ${action}. Valid: add, list, remove.`,
        { details: { action, reason: "unknown_action" } },
      );
  }
}

// ── backup (iter612) ─────────────────────────────────────────
//
// `tradekit backup export <file>` — encrypted full-state backup
// `tradekit backup restore <file>` — decrypt + write to data dir

export async function backupExport(flags: Record<string, string>, positional: string[]) {
  const outputPath = positional[2];
  if (!outputPath) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Usage: tradekit backup export <output-file> [--include-db] [--pass <password>]",
      { details: { reason: "missing_output_path" } },
    );
  }
  // Refuse to overwrite an existing file unless --force — same blast-radius
  // discipline as wallet export / restore. Prevents an operator from typing
  // a filename that conflicts with an existing backup and silently losing it.
  if (existsSync(outputPath) && flags["force"] !== "true") {
    throw new ToolError(
      "INVALID_PARAMS",
      `Output file ${outputPath} already exists. Re-run with --force to overwrite.`,
      { details: { reason: "would_overwrite", outputPath } },
    );
  }

  // Backup password: distinct from the wallet password (operator might want
  // different passwords). Prompt explicitly so they don't conflate the two.
  const pass = flags["pass"] ?? (await promptPassword("Backup encryption password: "));
  if (!pass) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Backup password cannot be empty.",
      { details: { reason: "empty_password" } },
    );
  }
  // Iter612: re-prompt for confirmation when interactive — the password is
  // the only thing protecting the bundle, a typo means an unrecoverable backup.
  if (!flags["pass"] && process.stdin.isTTY) {
    const pass2 = await promptPassword("Re-enter password: ");
    if (pass !== pass2) {
      throw new ToolError(
        "INVALID_PARAMS",
        "Passwords do not match. Backup aborted to prevent unrecoverable file.",
        { details: { reason: "password_mismatch" } },
      );
    }
  }
  checkPasswordStrength(pass);

  const includeDb = flags["include-db"] === "true";
  const { createBackup } = await import("../backup.js");
  const summary = createBackup({ outputPath, password: pass, includeDb });

  if (flags["json"] === "true") {
    printJson({ ok: true, ...summary });
    return;
  }
  console.log(`Backup written: ${summary.outputPath}`);
  console.log(`  Files:    ${summary.files.join(", ")}`);
  console.log(`  Size:     ${(summary.fileSizeBytes / 1024).toFixed(1)} KB`);
  console.log(`  DB included: ${summary.includesDb ? "yes" : "no"}`);
  console.log(`  Created:  ${summary.createdAt}`);
  console.log("");
  console.log("⚠ Store this file offline (USB / password manager attachment / secondary machine).");
  console.log("  The password is the ONLY thing protecting the bundle — if it's lost, the backup is unrecoverable.");
}

export async function backupRestore(flags: Record<string, string>, positional: string[]) {
  const inputPath = positional[2];
  if (!inputPath) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Usage: tradekit backup restore <input-file> [--force] [--pass <password>]",
      { details: { reason: "missing_input_path" } },
    );
  }

  const pass = flags["pass"] ?? (await promptPassword("Backup encryption password: "));
  if (!pass) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Backup password cannot be empty.",
      { details: { reason: "empty_password" } },
    );
  }

  const forceOverwrite = flags["force"] === "true";
  // Iter612: confirm BEFORE restoring when interactive AND --force is set.
  // forceOverwrite=true means existing wallet state will be replaced — operator
  // must explicitly confirm to prevent accidental clobber.
  if (forceOverwrite && process.stdin.isTTY) {
    console.warn("⚠ --force will OVERWRITE existing wallet state in the data dir.");
    const ans = await prompt("Type 'restore' to confirm: ");
    if (ans.trim().toLowerCase() !== "restore") {
      console.log("Aborted.");
      return;
    }
  }

  const { restoreBackup } = await import("../backup.js");
  const summary = restoreBackup({ inputPath, password: pass, forceOverwrite });

  if (flags["json"] === "true") {
    printJson({ ok: true, ...summary });
    return;
  }
  console.log(`Backup restored from: ${inputPath}`);
  console.log(`  Original backup date: ${summary.backupCreatedAt}`);
  console.log(`  Files written:        ${summary.restoredFiles.join(", ")}`);
  if (summary.skippedFiles.length > 0) {
    console.log(`  Files skipped:        ${summary.skippedFiles.join(", ")}`);
  }
  // Reminder — the restored mnemonic.json/wallet.json still need the ORIGINAL
  // wallet password (not the backup password) to decrypt.
  console.log("");
  console.log("Note: the restored mnemonic.json / wallet.json still need the ORIGINAL wallet password");
  console.log("to decrypt. The backup password only protected the bundle.");
}
