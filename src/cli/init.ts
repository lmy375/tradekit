// The first-run wizard. Walks a fresh user through wallet + active chain + basic safety
// guardrails. Interactive by default; supports a fully non-interactive path driven by
// flags + WALLET_PASS env so the same command works in CI / scripts.

import { loadConfig, saveConfig, resolveProfile, setConfigPath } from "../config.js";
import { listChains } from "../chains.js";
import { activeWalletAddress, createWallet } from "../wallet.js";
import { createMnemonicWallet, hasMnemonic } from "../accounts.js";
import { getKeystoreAddress } from "../wallet.js";
import { ToolError } from "../errors.js";
import { makeCliLogger, prompt, promptPassword, checkPasswordStrength, parseIntFlag, parseFloatFlag } from "./helpers.js";

/**
 * Safe to re-run: skips steps that are already configured.
 */
export async function initCommand(flags: Record<string, string>) {
  // Iter333: previously `|| !!process.env.WALLET_PASS` — so any operator who exported
  // WALLET_PASS for daily use (the recommended setup to avoid retyping the password) got
  // a silently-non-interactive init: steps 2 (chain) and 3 (safety) skipped their
  // prompts and used flag-or-default values, with no signal that the wizard was running
  // in scripted mode. WALLET_PASS being set is "the password is available" — not "I want
  // scripted mode." The right proxy for "scripted" is the absence of a TTY (CI runners,
  // Docker entrypoints without -t, piped stdin). The explicit --non-interactive flag
  // remains the primary toggle for operators who genuinely want unattended runs.
  // Note: even on TTY, if pass is needed and WALLET_PASS is set, line ~51 still picks it
  // up — so this doesn't introduce a new prompt for the password itself; only the chain
  // and safety steps are restored to their interactive default.
  const nonInteractive = flags["non-interactive"] === "true" || !process.stdin.isTTY;

  console.log("");
  console.log("┌─ tradekit setup ─────────────────────────────────────────────┐");
  console.log("│  Walk through wallet + chain + safety. Re-run any time.      │");
  console.log("└──────────────────────────────────────────────────────────────┘");
  console.log("");

  // ── Step 1: wallet ──
  const haveSingle = !!getKeystoreAddress();
  const haveHd = hasMnemonic();
  if (haveSingle || haveHd) {
    const addr = activeWalletAddress();
    console.log(`Step 1/3  Wallet:  already configured  (${haveHd ? "HD" : "single-key"} → ${addr})`);
  } else {
    console.log("Step 1/3  Wallet:");
    // Iter368: explicit --wallet-type beats the prompt even in interactive mode (same
    // "explicit flag = already decided" rule as the safety step below).
    const choice = flags["wallet-type"] != null
      ? flags["wallet-type"]
      : nonInteractive
        ? "hd"
        : await prompt("  Type — [h]d mnemonic (default), [k]eystore single key, [s]kip: ");
    const c = (choice || "hd").toLowerCase();
    // Validate the chosen type up front. Pre-iter194 anything that wasn't "skip"/"s"
    // or "k"/"keystore" silently fell through to HD — so `--wallet-type oops` quietly
    // created a 24-word seed when the operator might have wanted single-key. Reject
    // typos explicitly.
    const VALID_TYPES = new Set(["h", "hd", "k", "keystore", "s", "skip"]);
    if (!VALID_TYPES.has(c)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Invalid --wallet-type "${choice}" — expected one of: hd (default), keystore, skip.`,
      );
    }
    if (c === "skip" || c === "s") {
      console.log("  (skipped — set up with `tradekit wallet create` or `tradekit account create-mnemonic`)");
    } else {
      let pass = flags["pass"] ?? process.env.WALLET_PASS;
      if (!pass) {
        // Iter259: fail loudly when non-interactive but no password supplied. Pre-iter259
        // the code would call promptPassword from a non-interactive context — on a TTY-less
        // process (CI runner, docker entrypoint), readline would hang waiting for input
        // that never comes. The operator saw a "stuck" `tradekit init` with no signal that
        // a flag was missing.
        if (nonInteractive) {
          throw new ToolError(
            "INVALID_PARAMS",
            "init was invoked non-interactively (--non-interactive or no TTY) but no password is set. Pass --pass <password> or set WALLET_PASS=<password> in the environment.",
          );
        }
        pass = await promptPassword("  Enter a password for the wallet: ");
        const pass2 = await promptPassword("  Confirm password: ");
        if (pass !== pass2) throw new ToolError("INVALID_PARAMS", "Passwords do not match.");
      }
      // Refuse empty; warn loudly on weak. The keystore lives at 0600 now (iter128),
      // but defense-in-depth: a weak password is the obvious foothold for anyone who
      // gets read access to ~/.tradekit/.
      const { warnings } = checkPasswordStrength(pass);
      for (const w of warnings) console.error(`  ⚠  ${w}`);
      if (c === "k" || c === "keystore") {
        const address = await createWallet(pass, makeCliLogger(flags));
        console.log(`  ✓ Single-key wallet created: ${address}`);
      } else {
        const { mnemonic, address } = createMnemonicWallet(pass);
        console.log(`  ✓ HD wallet created (default account): ${address}`);
        console.log("");
        console.log("  ⚠  Back up this mnemonic NOW. It is the only way to recover the wallet:");
        console.log("");
        console.log(`      ${mnemonic}`);
      }
    }
  }
  console.log("");

  // ── Step 2: active chain ──
  const config = loadConfig();
  // Iter340: include custom-configured chains alongside built-ins. Pre-iter340 the
  // prompt and the error message both listed only listChains() (built-ins), so an
  // operator who'd already set up a custom chain (zora, blast, an internal L3, …)
  // couldn't see it as an option and the error claimed their valid choice "must be
  // one of: [built-ins]". Same blind spot iter161 (chains command), iter211
  // (parseChainsFlag), iter231 (web /api/status), iter235 (default holdings scan)
  // each fixed in their own surface — init was the holdout.
  const customChainNames = Object.keys(config.chains ?? {}).filter(
    (c) => !listChains().includes(c.toLowerCase()),
  );
  const allChainNames = [...listChains(), ...customChainNames];
  console.log(`Step 2/3  Active chain — currently: ${config.activeChain}`);
  // Iter368: explicit --chain beats the prompt in interactive mode too.
  const chainChoice = flags["chain"] != null
    ? flags["chain"]
    : nonInteractive
      ? config.activeChain
      : (await prompt(`  Pick chain (one of: ${allChainNames.join(", ")}) [${config.activeChain}]: `)) ||
        config.activeChain;
  if (chainChoice !== config.activeChain) {
    // Iter385: let resolveProfile's UNKNOWN_CHAIN propagate. Pre-iter385 we caught it
    // and re-threw a message without iter343's "Did you mean" suggestion — operators
    // typing `--chain baes` in init saw a worse error than from any other surface.
    // resolveProfile already includes the full known list AND the suggestion.
    resolveProfile(chainChoice, config);
    saveConfig(setConfigPath(config, "activeChain", chainChoice));
    console.log(`  ✓ Active chain → ${chainChoice}`);
  } else {
    console.log(`  (kept: ${chainChoice})`);
  }
  console.log("");

  // ── Step 3: safety ──
  const cur = loadConfig();
  console.log("Step 3/3  Safety guardrails (production-grade defaults):");
  // Iter368: honor explicit safety flags in interactive mode too. Pre-iter368 the
  // wizard only consulted flags when nonInteractive=true — so an operator running
  //   `tradekit init --per-tx-limit 100`
  // (interactively, no --non-interactive) had their explicit choice silently ignored
  // and got prompted for the limit anyway. The flag form is "I've already decided";
  // prompts should only fire for steps without an explicit answer.
  const perTxAnswer = flags["per-tx-limit"] != null
    ? flags["per-tx-limit"]
    : nonInteractive
      ? undefined
      : await prompt(`  Max USD per transaction [${cur.safety.perTxUsdLimit ?? "unset"}, blank to skip]: `);
  if (perTxAnswer && perTxAnswer.trim() !== "") {
    // Cap at $10M — anything larger is almost certainly a typo (extra zero) and the
    // safety check is supposed to PROTECT against that exact mistake. Min 0.01 so a
    // sub-cent value can't accidentally disable the check via a typo'd "0".
    const n = parseFloatFlag(perTxAnswer.trim(), "per-tx-limit", { min: 0.01, max: 10_000_000 });
    if (n != null) {
      saveConfig(setConfigPath(loadConfig(), "safety.perTxUsdLimit", n));
      console.log(`  ✓ safety.perTxUsdLimit = ${n}`);
    }
  }
  const slippageAnswer = flags["max-slippage-bps"] != null
    ? flags["max-slippage-bps"]
    : nonInteractive
      ? undefined
      : await prompt(`  Max slippage in bps [${cur.safety.maxSlippageBps}, blank to keep]: `);
  if (slippageAnswer && slippageAnswer.trim() !== "") {
    // 5000 bps = 50% — above that, a swap is effectively unbounded and the safety
    // check stops being meaningful. Pre-iter143 parseInt("12abc") was 12, silently
    // accepted.
    const n = parseIntFlag(slippageAnswer.trim(), "max-slippage-bps", { min: 1, max: 5000 });
    if (n != null) {
      saveConfig(setConfigPath(loadConfig(), "safety.maxSlippageBps", n));
      console.log(`  ✓ safety.maxSlippageBps = ${n}`);
    }
  }
  if (cur.safety.allowInfiniteApprovals === false) {
    const allowAnswer = flags["allow-infinite-approvals"] != null
      ? flags["allow-infinite-approvals"]
      : nonInteractive
        ? "n"
        : await prompt("  Allow infinite approvals without per-call override? (y/N): ");
    const v = (allowAnswer ?? "").trim().toLowerCase();
    if (v === "y" || v === "yes" || allowAnswer === "true") {
      saveConfig(setConfigPath(loadConfig(), "safety.allowInfiniteApprovals", true));
      console.log("  ✓ safety.allowInfiniteApprovals = true  (use cautiously)");
    } else {
      console.log("  (kept: infinite approvals require explicit override)");
    }
  }
  console.log("");
  console.log("Done. Next steps:");
  console.log("  • `tradekit doctor`               — verify everything is healthy");
  // Tailor wallet-related steps to actual state. Pre-iter216 we always suggested
  // `wallet view` and `quote` — but if the user skipped wallet setup, those would
  // fail with WALLET_NOT_FOUND. Surface `wallet create` / `account create-mnemonic`
  // as the real next step in that case.
  if (activeWalletAddress()) {
    // Iter859: drop the `quote --baseAmount 0.001` suggestion — pre-iter859
    // this was a broken example (missing --direction / --base / --quote, would
    // fail with INVALID_PARAMS the moment the operator hit enter). Replace
    // with `holdings` (always works, no required flags) + `health` (operator
    // dashboard added in iter621, more useful than wallet view for ongoing
    // operations).
    console.log("  • `tradekit holdings`             — see your balances across chains");
    console.log("  • `tradekit health`               — operator dashboard (portfolio + PnL + alerts)");
    console.log("  • `tradekit quote --chain base --direction sell --base ETH --quote USDC --baseAmount 0.001`");
    console.log("                                   — try a real quote (no tx sent)");
  } else {
    console.log("  • `tradekit account create-mnemonic`  — create an HD wallet (or `wallet create` for single-key)");
  }
}
