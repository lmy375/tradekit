// Trade-flow CLI commands: quote (sim-only), trade buy/sell (real), trade import
// (backfill), and transfer (native/ERC20 send). Lifted from index.ts so each block
// stays focused and the dispatcher stays small.

import type { Address } from "viem";
import { loadConfig, resolveProfile } from "../config.js";
import { loadWallet, loadReadOnlyWallet, activeWalletLabel } from "../wallet.js";
import { resolveToken, resolveTradePair, assertAddressEIP55, unknownTokenError } from "../chains.js";
import { executeTrade, type TradeRequest } from "../trade.js";
import { formatUsd } from "../holdings.js";
import { ToolError } from "../errors.js";
import { makeCliLogger, printJson, requirePassword, assertTxHash, parseIntFlag, resolveStrategy } from "./helpers.js";

export async function quoteCommand(flags: Record<string, string>) {
  // Infer direction from amount flag if not explicit. Use ToolError so the CLI error
  // handler renders the right code (INVALID_PARAMS, not INTERNAL_ERROR) and the audit
  // log classifies correctly.
  let dir: "buy" | "sell" | undefined = flags["direction"] as "buy" | "sell" | undefined;
  if (!dir) {
    if (flags["quoteAmount"] && !flags["baseAmount"]) dir = "buy";
    else if (flags["baseAmount"] && !flags["quoteAmount"]) dir = "sell";
    else
      throw new ToolError(
        "INVALID_PARAMS",
        "Specify --direction buy|sell, or pass exactly one of --baseAmount / --quoteAmount.",
      );
  }
  if (dir !== "buy" && dir !== "sell") {
    throw new ToolError("INVALID_PARAMS", `--direction must be buy or sell (got "${dir}")`);
  }
  await tradeOrQuote(dir, { ...flags, simulate: "true" });
}

export async function tradeCommand(direction: "buy" | "sell", flags: Record<string, string>) {
  await tradeOrQuote(direction, flags);
}

/**
 * Shared implementation behind both `quote` and `trade buy|sell`. The difference is
 * purely the `--simulate` flag; the rest of the flow (safety check, aggregator with
 * fallback, optional auto-decode, audit recording) is identical.
 */
async function tradeOrQuote(direction: "buy" | "sell", flags: Record<string, string>) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  // Resolve the trade pair BEFORE prompting for password — an unresolvable base/quote
  // throws UNKNOWN_TOKEN here, saving the user from typing a password just to learn
  // they had a typo in --base / --quote.
  const { base, quote } = resolveTradePair(
    profile,
    flags["base"] ?? "ETH",
    flags["quote"] ?? "USDC",
  );
  // Iter302: parse --slippage BEFORE prompting for password. Pre-iter302 the parse ran
  // after loadWallet so an out-of-range/garbage value threw INVALID_PARAMS only after
  // the operator typed a password. Same fail-fast UX as the pair check above.
  // Iter455: min:1 aligns with safetySchema's z.number().int().min(1) bound. Pre-iter455
  // --slippage 0 was technically accepted at the CLI but guaranteed a revert at submit
  // time (any output less than expected fails the swap). Reject at the boundary so
  // operators don't waste an aggregator roundtrip + a gas-estimate on a doomed trade.
  // Max stays at 10_000 (100%) since safety.maxSlippageBps caps at 5000 anyway — the
  // CLI is permissive on max so safety can reject with its iter403 SLIPPAGE_TOO_HIGH.
  const slippageBps = parseIntFlag(flags["slippage"], "--slippage", { min: 1, max: 10_000 });
  // Iter486: quote is a dry-run — no signing happens, so we can skip the password
  // prompt entirely. Pre-iter486 every `tradekit quote …` invocation forced the user
  // to type their wallet password (or set WALLET_PASS) for a path that never decrypts
  // the keystore. Now `quote` (and any other simulate=true caller) uses a JSON-RPC
  // walletClient with just the active address — the address is enough for eth_call's
  // `from`, and the missing private key means accidental signing attempts hard-fail
  // at the viem boundary. Same iter384 spirit (read-only ergonomics for read-only paths).
  const isSimulateOnly = flags["simulate"] === "true";
  const logger = makeCliLogger(flags);
  try {
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    const wallet = isSimulateOnly
      ? loadReadOnlyWallet(profile, extraRpcs, flags["account"])
      : await loadWallet(await requirePassword(flags), profile, extraRpcs, logger, flags["account"]);
    const req: TradeRequest = {
      direction,
      base,
      quote,
      baseAmount: flags["baseAmount"],
      quoteAmount: flags["quoteAmount"],
      slippageBps,
      simulate: flags["simulate"] === "true",
      note: flags["note"],
      // Iter620: --force-gas bypasses the gas-budget safety check. Bypass is
      // logged at warn level so the audit trail still shows operator intent.
      forceGas: flags["force-gas"] === "true",
      // Iter625: --expected-out N locks in the amountOut from a prior quote.
      // After the live re-quote, deviation > --max-deviation-bps (default 100)
      // fails with QUOTE_DEVIATION_EXCEEDED.
      expectedAmountOut: flags["expected-out"],
      maxQuoteDeviationBps: flags["max-deviation-bps"]
        ? parseInt(flags["max-deviation-bps"], 10)
        : undefined,
      // Iter642: --auto-slippage derives the slippage cap from realized
      // history for the canonical pair. Ignored when --slippage is set.
      autoSlippage: flags["auto-slippage"] === "true",
      // Iter648: --strategy tags the trade for cross-cut analysis.
      // Iter659: resolveStrategy() also honors TRADEKIT_STRATEGY for a per-
      // shell default; --strategy still wins for per-trade overrides. MCP
      // doesn't honor the env: agents should pass strategy explicitly.
      strategy: resolveStrategy(flags["strategy"], process.env.TRADEKIT_STRATEGY),
    };

    // v45: --idempotency-key fences transport-retry double trades.
    // The fingerprint is the resolved request (pair + amounts +
    // direction) so the same key with changed amounts CONFLICTS.
    const { withIdempotency } = await import("../idempotency.js");
    const { result, replayed } = await withIdempotency({
      key: flags["idempotency-key"],
      tool: direction,
      requestArgs: { ...req, chain: chainName, account: flags["account"] },
      exec: () =>
        executeTrade(req, {
          publicClient: wallet.publicClient,
          walletClient: wallet.walletClient,
          profile,
          config,
          logger,
          accountLabel: wallet.label,
        }),
    });
    if (replayed && flags["json"] !== "true") {
      console.log(`⚠ replayed: this key already completed — showing the RECORDED outcome; nothing was executed now.`);
    }

    if (flags["json"] === "true") {
      printJson(replayed ? { ...result, replayed: true } : result);
    } else {
      console.log(`${result.direction.toUpperCase()} ${result.simulated ? "(SIMULATION)" : (result.status?.toUpperCase() ?? "SENT")}`);
      // Iter684/iter687: predictive failure pattern at the TOP of the output.
      // iter684 surfaced a generic suggestion; iter687 surfaces the
      // classifier-derived specific suggestion when classifyReason matched
      // the dominant reason. Falls back to the generic line when the reason
      // isn't in the pattern table (custom router strings, unusual reverts).
      if (result.recentFailurePattern) {
        const p = result.recentFailurePattern;
        // Iter700: append the dominant reason's lastSeen so operators see
        // ongoing-vs-stale at a glance.
        const lastBit = p.dominantLastSeen
          ? ` (last: ${p.dominantLastSeen.slice(0, 16).replace("T", " ")})`
          : "";
        console.log(
          `  ⚠ Recent failure pattern: ${p.dominantCount}/${p.total} ${result.baseSymbol ?? "?"}/${result.quoteSymbol ?? "?"} trades in last ${p.windowDays}d failed with "${p.dominantReason}"${lastBit}.`,
        );
        if (p.suggestedActions && p.suggestedActions.length > 0) {
          for (const a of p.suggestedActions) {
            console.log(`    → ${a.reason}`);
          }
        } else {
          console.log(`    Consider --auto-slippage, a wider --slippage, or a different aggregator.`);
        }
      }
      console.log(`  Aggregator: ${result.aggregator}`);
      console.log(`  Base:  ${result.baseAmount} ${result.baseSymbol ?? result.baseToken}`);
      console.log(`  Quote: ${result.quoteAmount} ${result.quoteSymbol ?? result.quoteToken}`);
      console.log(`  Price: ${result.price} ${result.quoteSymbol ?? "QUOTE"}/${result.baseSymbol ?? "BASE"}`);
      if (result.estimatedUsd != null) console.log(`  USD value (est): ${formatUsd(result.estimatedUsd)}`);
      if (result.balanceFraction != null && result.balanceFraction >= 0.5) {
        const pct = (result.balanceFraction * 100).toFixed(1);
        const marker = result.balanceFraction > 1 ? "✗ EXCEEDS balance!" : "⚠ large fraction";
        console.log(`  Size:    ${pct}% of input-token balance   ${marker}`);
      }
      // Iter409: surface the iter326 sell-max gas reserve in text mode too. Pre-iter409
      // operators reading the summary saw the post-reserve `Base:` amount and had to
      // squint at server.log (iter326 info-level) to learn what was held back. Now
      // text mode is at parity with the iter408 JSON shape.
      if (result.gasReserveNative) {
        console.log(`  Reserved: ${result.gasReserveNative} ${result.baseSymbol ?? "base"} for swap gas`);
      }
      console.log(`  Allowance target: ${result.allowanceTarget}`);
      console.log(`  Router: ${result.to}`);
      if (result.simulation) {
        console.log(`  Simulation: ${result.simulation.ok ? "OK" : "WOULD REVERT"}`);
        if (result.simulation.revertReason) console.log(`    Revert: ${result.simulation.revertReason}`);
        const gasUsdNote = result.gasCostUsd != null ? ` ≈ ${formatUsd(result.gasCostUsd)}` : "";
        console.log(`    Gas:  ${result.simulation.gas}  (~${result.simulation.gasCostNative} native${gasUsdNote})`);
      }
      if (result.txHash) console.log(`  Tx: ${result.txHash}`);
      if (result.decoded && result.decoded.status === "success") {
        if (result.decoded.summary) console.log(`  Settled: ${result.decoded.summary}`);
        if (result.decoded.gasUsed) {
          const gasUsdNote = result.gasCostUsd != null ? ` ≈ ${formatUsd(result.gasCostUsd)}` : "";
          console.log(
            `  Gas:    ${result.decoded.gasUsed} units @ ${result.decoded.effectiveGasPriceGwei ?? "?"} gwei (~${result.gasCostNative} native${gasUsdNote})`,
          );
        }
      }
      // Iter482: surface explorerUrl for BOTH success AND failed trades. Pre-iter482
      // it was nested under `decoded.explorerUrl`, only set on success — a reverted
      // trade left the operator with a bare hash and no click-target. Now both paths
      // print Explorer; the failed path additionally surfaces the viewTx next-action
      // via the generic nextActions loop below.
      if (result.explorerUrl) console.log(`  Explorer: ${result.explorerUrl}`);
      if (result.nextActions && result.nextActions.length) {
        console.log("  next_actions:");
        for (const na of result.nextActions) console.log(`    - ${na.tool}: ${na.reason}`);
      }
      // Iter638: surface phase timing in --verbose mode. Stays out of default
      // output to keep happy-path terse; operators investigating slow trades
      // pass --verbose.
      if (result.phaseTiming && flags["verbose"] === "true") {
        const t = result.phaseTiming;
        console.log(`  Timing (ms): quote=${t.quoteMs} simulate=${t.simulateMs} send=${t.sendMs} receipt=${t.receiptMs} total=${t.totalMs}`);
      }
    }
  } finally {
    logger.close();
  }
}

// ── trade preview (iter608) ──────────────────────────────────
//
// `tradekit trade preview <buy|sell>` — unified pre-trade analysis. Read-only:
// no password required, no submit. Returns the structured TradePreviewReport
// directly via --json, or a formatted text report otherwise.

export async function tradePreviewCommand(
  direction: "buy" | "sell",
  flags: Record<string, string>,
) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  const { base: baseResolved, quote } = resolveTradePair(profile, flags["base"] ?? "ETH", flags["quote"] ?? "USDC");
  // Iter608: resolveTradePair returns "ETH" sentinel for natives; downstream
  // tradePreview API + rest of the codebase use NATIVE_TOKEN (EIP-7528 placeholder).
  const { NATIVE_TOKEN } = await import("../tokens.js");
  const base: Address = baseResolved === "ETH" ? NATIVE_TOKEN : (baseResolved as Address);
  // Iter645: --auto-slippage resolves before previewTrade — same compute the
  // trade flow uses, just done in the CLI shim. Explicit --slippage still wins.
  const explicitSlippage = parseIntFlag(flags["slippage"], "--slippage", { min: 1, max: 10_000 });
  let slippageBps = explicitSlippage ?? config.defaultSlippageBps;
  let slippageSuggestion: import("../slippageSuggest.js").SlippageSuggestion | undefined;
  if (flags["auto-slippage"] === "true" && explicitSlippage == null) {
    try {
      const { previewSlippageSuggestion } = await import("../slippageSuggest.js");
      const acct = flags["account"] ?? (await import("../wallet.js")).activeWalletLabel();
      const suggestionReport = await previewSlippageSuggestion({
        config,
        logger: makeCliLogger(flags),
        account: acct,
        baseSymbol: (flags["base"] ?? "ETH").toUpperCase(),
        quoteSymbol: (flags["quote"] ?? "USDC").toUpperCase(),
        baseAddress: baseResolved === "ETH" ? undefined : (baseResolved as string),
        quoteAddress: quote as string,
      });
      slippageBps = suggestionReport.suggestion.suggestedBps;
      slippageSuggestion = suggestionReport.suggestion;
    } catch {
      // Best-effort: fall back to default slippage on lookup failure.
    }
  }
  const logger = makeCliLogger(flags);

  try {
    const { loadReadOnlyWallet } = await import("../wallet.js");
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    const wallet = loadReadOnlyWallet(profile, extraRpcs, flags["account"]);

    let baseAmountRaw: bigint | undefined;
    let quoteAmountRaw: bigint | undefined;
    if (direction === "buy") {
      if (!flags["quoteAmount"]) {
        throw new ToolError(
          "INVALID_PARAMS",
          "buy preview requires --quoteAmount (amount of quote token to SPEND).",
          { details: { direction, missingField: "quoteAmount" } },
        );
      }
      const { getToken } = await import("../tokens.js");
      const meta = await getToken(wallet.publicClient, profile, quote);
      const { parseUnits } = await import("viem");
      quoteAmountRaw = parseUnits(flags["quoteAmount"], meta.decimals);
    } else {
      if (!flags["baseAmount"]) {
        throw new ToolError(
          "INVALID_PARAMS",
          "sell preview requires --baseAmount (amount of base token to SELL).",
          { details: { direction, missingField: "baseAmount" } },
        );
      }
      const baseIsNative = base === NATIVE_TOKEN;
      const meta = baseIsNative
        ? { decimals: 18, symbol: profile.nativeSymbol }
        : await (await import("../tokens.js")).getToken(wallet.publicClient, profile, base);
      const { parseUnits } = await import("viem");
      baseAmountRaw = parseUnits(flags["baseAmount"], meta.decimals);
    }

    const { previewTrade } = await import("../tradePreview.js");
    const report = await previewTrade({
      direction,
      base,
      quote,
      baseAmount: baseAmountRaw,
      quoteAmount: quoteAmountRaw,
      slippageBps,
      publicClient: wallet.publicClient,
      walletAddress: wallet.account.address as Address,
      account: wallet.label,
      profile,
      config,
      logger,
      strategy: flags["strategy"] ?? null,
    });

    // Iter798: --strict exit-code gate. Triggers when safety.passes is false
    // (pre-trade safety check rejected). Lighter cousin to iter772 preflight
    // --strict — preview is single-source analysis, preflight runs the
    // composite probe. Pipeline pattern: tradekit trade preview ... --strict
    // && tradekit trade buy ... — abort the trade when safety fails.
    // process.exitCode (not process.exit) — iter351 pattern preserves audit-
    // insert finally.
    const strict = flags["strict"] === "true" || flags["strict"] === "";

    if (flags["json"] === "true") {
      printJson({ ok: true, ...report, ...(slippageSuggestion ? { slippageSuggestion } : {}) });
      if (strict && (!report.safety.passes || report.limits?.admissible === false)) process.exitCode = 1;
      return;
    }

    const m = report.metrics;
    const usd = (v: number | null) => (v == null ? "—" : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
    const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}%`);
    const sevMark = report.safety.passes ? "🟢 PASS" : "🔴 FAIL";

    console.log(`Trade preview on ${report.chain}:`);
    console.log("");
    console.log(`  Direction:    ${report.direction.toUpperCase()} ${report.baseSymbol} / ${report.quoteSymbol}`);
    // Iter694: surface the predictive failure pattern right after the
    // direction line — same placement as iter684 in the regular trade
    // output. Operators preview-ing the trade see the warning before
    // scanning metrics + safety.
    if (report.recentFailurePattern) {
      const p = report.recentFailurePattern;
      const lastBit = p.dominantLastSeen
        ? ` (last: ${p.dominantLastSeen.slice(0, 16).replace("T", " ")})`
        : "";
      console.log(
        `  ⚠ Recent failure pattern: ${p.dominantCount}/${p.total} ${report.baseSymbol}/${report.quoteSymbol} trades in last ${p.windowDays}d failed with "${p.dominantReason}"${lastBit}.`,
      );
      if (p.suggestedActions && p.suggestedActions.length > 0) {
        for (const a of p.suggestedActions) {
          console.log(`    → ${a.reason}`);
        }
      }
    }
    console.log(`  Provider:     ${report.provider}`);
    console.log("");
    console.log(`  Amount in:    ${m.amountIn}  (${usd(m.inputUsd)})`);
    console.log(`  Amount out:   ${m.amountOut}  (${usd(m.outputUsd)})`);
    console.log(`  Min received: ${m.amountOutMinimum}  (${usd(m.outputUsdFloor)})`);
    // Iter645: when --auto-slippage produced a suggestion, surface the reason
    // + sample count so operators see WHY this slippage was chosen.
    const slipNote = slippageSuggestion
      ? ` (auto: ${slippageSuggestion.reason}, ${slippageSuggestion.sampleCount} samples)`
      : "";
    console.log(`  Slippage cushion: ${m.slippageCushionBps} bps (requested ${slippageBps} bps${slipNote})`);
    if (m.effectivePrice != null) {
      console.log(`  Effective price:  ${m.effectivePrice.toLocaleString("en-US", { maximumFractionDigits: 8 })} ${report.quoteSymbol}/${report.baseSymbol}`);
    }
    console.log("");
    console.log(`  Wallet balance:   ${m.walletBalance}`);
    console.log(`  Balance fraction: ${pct(m.balanceFractionPct)}`);
    if (m.currentAllowance != null) {
      console.log(`  Current allowance: ${m.currentAllowance} (sufficient: ${m.hasSufficientAllowance ? "yes" : "NO — approve first"})`);
    } else {
      console.log(`  Allowance:        n/a (native input)`);
    }
    console.log("");
    if (m.estimatedGasNative != null) {
      console.log(`  Gas estimate:     ${m.estimatedGasNative} ${profile.nativeSymbol}  (${usd(m.estimatedGasUsd)})`);
      if (m.gasPctOfInput != null) {
        const flag = m.gasPctOfInput > 5 ? " ⚠ gas is >5% of input — small trade with disproportionate gas" : "";
        console.log(`  Gas % of input:   ${pct(m.gasPctOfInput)}${flag}`);
      }
    }
    console.log("");
    console.log(`  Safety pre-flight: ${sevMark}`);
    if (!report.safety.passes && report.safety.rejection) {
      console.log(`    ${report.safety.rejection.code}: ${report.safety.rejection.message}`);
    }
    // v54: full execution-limit projection — the state-dependent guardrails
    // that `safety` (cheap slippage+token subset) doesn't cover.
    if (report.limits) {
      const adm = report.limits.admissible ? "🟢 ADMISSIBLE" : "🔴 WOULD REJECT";
      console.log(`  Limit projection:  ${adm}`);
      if (!report.limits.admissible) {
        for (const b of report.limits.blocking) {
          console.log(`    ✗ ${b.label}${b.code ? ` [${b.code}]` : ""}: ${b.message ?? ""}`);
        }
      }
    }
    // v69: market-timing context — where the base price sits + a
    // direction-aware read of whether now is a good moment for this trade.
    if (report.marketContext) {
      const mc = report.marketContext;
      const mark = mc.timing === "caution" ? "🟡 CAUTION" : mc.timing === "favorable" ? "🟢 FAVORABLE" : "⚪ NEUTRAL";
      console.log("");
      console.log(`  Market timing:     ${mark} (${mc.windowDays}d)`);
      console.log(`    ${mc.summary}`);
      for (const n of mc.notes) console.log(`    • ${n}`);
    }
    if (report.alternatives && report.alternatives.length > 0) {
      console.log("");
      console.log(`  Aggregator alternatives (best-of-N race):`);
      for (const a of report.alternatives) {
        if (a.status === "ok") {
          console.log(`    ${a.provider}: -${a.bpsBehindWinner} bps`);
        } else {
          console.log(`    ${a.provider}: ERR (${a.message.slice(0, 60)})`);
        }
      }
    }
    // Iter798: strict gate (text-mode path). v54: also fail when a
    // configured execution limit would reject the trade.
    if (strict && (!report.safety.passes || report.limits?.admissible === false)) process.exitCode = 1;
  } finally {
    logger.close();
  }
}

// ── trade import ─────────────────────────────────────────────

export async function tradeImportCommand(flags: Record<string, string>, positional: string[]) {
  const txHashRaw = positional[2];
  if (!txHashRaw) throw new ToolError("INVALID_PARAMS", "Usage: tradekit trade import <tx-hash> [--chain <name>] [--account <label>]");
  const txHash = assertTxHash(txHashRaw);
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  // Iter502: activeWalletLabel gate matches loadWallet — trade import attributes the
  // backfilled row to the actual active wallet identity (orphan-accounts case
  // returns "keystore", not the dead HD label).
  const account = flags["account"] ?? activeWalletLabel();
  const logger = makeCliLogger(flags);
  try {
    const { createPublicClient } = await import("viem");
    const { makeTransport } = await import("../chains.js");
    const { importTradeFromTx } = await import("../importTrade.js");
    const transport = makeTransport(profile, config.chains[chainName]?.rpcs ?? []);
    const client = createPublicClient({ chain: profile.viemChain, transport });
    const result = await importTradeFromTx(client as never, profile, txHash, account, logger);

    if (flags["json"] === "true") {
      printJson(result);
      return;
    }
    switch (result.status) {
      case "inserted":
        console.log(`Imported trade #${result.rowId}`);
        if (result.trade) {
          const t = result.trade;
          console.log(`  ${t.direction.toUpperCase()}  ${t.base_amount} ${t.base_symbol ?? ""} → ${t.quote_amount} ${t.quote_symbol ?? ""}`);
          if (t.price !== "0") console.log(`  Price: ${t.price}`);
          console.log(`  Aggregator: ${t.aggregator}`);
          console.log(`  Tx: ${t.tx_hash}`);
        }
        break;
      case "duplicate":
        console.log(`Already imported: ${result.reason}`);
        break;
      case "skipped":
        console.log(`Skipped: ${result.reason}`);
        break;
    }
  } finally {
    logger.close();
  }
}

// ── transfer ────────────────────────────────────────────────

export async function transferCommand(flags: Record<string, string>, positional: string[]) {
  const tokenArg = positional[1];
  const rawTo = positional[2];
  const amount = positional[3] ?? flags["amount"];
  if (!tokenArg || !rawTo || !amount) {
    throw new ToolError("INVALID_PARAMS", "Usage: tradekit transfer <token|ETH> <to|@alias> <amount> [--chain <name>] [--simulate] [--json]");
  }
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  // Iter614: resolve address-book aliases BEFORE the EIP-55 check. An @alias
  // input expands to the saved address; a plain 0x... passes through unchanged.
  // UNKNOWN_RECIPIENT fires here for unknown aliases with iter343-style "Did
  // you mean" suggestion.
  const { resolveRecipient } = await import("../addressBook.js");
  const { address: to, alias } = resolveRecipient(rawTo);
  if (alias) {
    console.error(`Resolved @${alias} → ${to}`);
  }
  // Validate recipient BEFORE prompting for password (iter292: via shared helper).
  // executeTransfer re-validates anyway; the early call saves the operator a
  // keystroke on a typo'd recipient.
  assertAddressEIP55("recipient", to);
  const tokenResolved =
    tokenArg.toUpperCase() === "ETH" || tokenArg.toUpperCase() === "NATIVE"
      ? "ETH"
      : resolveToken(profile, tokenArg);
  // Iter353: shared helper from chains.ts surfaces the iter345 "Did you mean" hint.
  if (!tokenResolved) throw unknownTokenError("token", tokenArg, profile);
  // Iter488: extend iter486's password-free simulate pattern to transfer. Pre-iter488
  // every `tradekit transfer ... --simulate` invocation prompted for the wallet
  // password — same pointless decrypt the quote command suffered from, since the
  // simulate path never signs. With this gate, simulate-only transfers use the
  // read-only wallet (just the public address); real transfers still go through
  // requirePassword + loadWallet for actual signing.
  const isSimulateOnly = flags["simulate"] === "true";
  const logger = makeCliLogger(flags);
  try {
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    const wallet = isSimulateOnly
      ? loadReadOnlyWallet(profile, extraRpcs, flags["account"])
      : await loadWallet(await requirePassword(flags), profile, extraRpcs, logger, flags["account"]);

    const { executeTransfer } = await import("../transfer.js");
    const result = await executeTransfer(
      {
        token: tokenResolved as Address | "ETH",
        to: to as Address,
        amount,
        simulate: flags["simulate"] === "true",
        note: flags["note"],
        // Iter355: --burn explicitly acknowledges sending to 0x0 (a permanent burn).
        allowBurn: flags["burn"] === "true",
      },
      {
        publicClient: wallet.publicClient,
        walletClient: wallet.walletClient,
        profile,
        config,
        logger,
        accountLabel: wallet.label,
      },
    );

    if (flags["json"] === "true") {
      printJson(result);
      return;
    }

    console.log(`TRANSFER ${result.simulated ? "(SIMULATION)" : (result.status?.toUpperCase() ?? "SENT")}`);
    // Iter684/iter687: predictive failure pattern + classifier-derived
    // suggestion. Same pattern as the trade flow above.
    if (result.recentFailurePattern) {
      const p = result.recentFailurePattern;
      const lastBit = p.dominantLastSeen
        ? ` (last: ${p.dominantLastSeen.slice(0, 16).replace("T", " ")})`
        : "";
      console.log(
        `  ⚠ Recent failure pattern: ${p.dominantCount}/${p.total} transfers to this address in last ${p.windowDays}d failed with "${p.dominantReason}"${lastBit}.`,
      );
      if (p.suggestedActions && p.suggestedActions.length > 0) {
        for (const a of p.suggestedActions) {
          console.log(`    → ${a.reason}`);
        }
      }
    }
    console.log(`  ${result.amount} ${result.symbol}  →  ${result.to}`);
    // Iter678: address-book signal placed RIGHT BELOW the recipient line so
    // it's the next thing an operator sees. Known → confirmation; unknown →
    // warning. Skip rendering when the lookup wasn't done (book IO error).
    if (result.recipientIsKnown === true && result.recipientLabel) {
      // Iter680: append the note when the entry has one — pre-iter680 the
      // operator saw just "@cold-wallet" and had to recall what that meant.
      const noteSuffix = result.recipientNote ? ` (${result.recipientNote})` : "";
      console.log(`  ✓ Known recipient: @${result.recipientLabel}${noteSuffix}`);
    } else if (result.recipientIsKnown === false) {
      console.log(`  ⚠ First-time recipient — not in your address book.`);
      console.log(`    If this is a trusted counterparty, add: tradekit address add <name> ${result.to}`);
    }
    if (result.estimatedUsd != null) console.log(`  USD value (est): ${formatUsd(result.estimatedUsd)}`);
    if (result.balanceFraction != null && result.balanceFraction >= 0.5) {
      const pct = (result.balanceFraction * 100).toFixed(1);
      console.log(`  Size:    ${pct}% of your ${result.symbol} balance${result.balanceFraction > 0.99 ? " (essentially the entire balance)" : ""}`);
    }
    // Iter409: surface the iter325 transfer-max gas reserve in text mode too — parity
    // with the iter407 JSON addition. Only fires for native max-mode (ERC20 has no
    // native reserve; explicit amounts don't compute one).
    if (result.gasReserveNative) {
      console.log(`  Reserved: ${result.gasReserveNative} ${result.symbol} for transfer gas`);
    }
    if (result.simulation) {
      console.log(`  Simulation: ${result.simulation.ok ? "OK" : "WOULD REVERT"}`);
      if (result.simulation.revertReason) console.log(`    Revert: ${result.simulation.revertReason}`);
      const gasUsdNote = result.gasCostUsd != null ? ` ≈ ${formatUsd(result.gasCostUsd)}` : "";
      console.log(`    Gas:  ${result.simulation.gas}  (~${result.simulation.gasCostNative} native${gasUsdNote})`);
    }
    if (result.txHash) console.log(`  Tx: ${result.txHash}`);
    // Iter483: prefer the top-level explorerUrl (present for both success AND failed
    // transfers). Pre-iter483 we only showed decoded.explorerUrl which is unset on
    // revert — leaving the operator with no click-target to investigate.
    if (result.explorerUrl) console.log(`  Explorer: ${result.explorerUrl}`);
    if (result.gasUsed) {
      const gasUsdNote = result.gasCostUsd != null ? ` ≈ ${formatUsd(result.gasCostUsd)}` : "";
      console.log(`  Gas: ${result.gasUsed}  (~${result.gasCostNative} native${gasUsdNote})`);
    }
    if (result.nextActions && result.nextActions.length) {
      console.log("  next_actions:");
      for (const na of result.nextActions) console.log(`    - ${na.tool}: ${na.reason}`);
    }
  } finally {
    logger.close();
  }
}

// ── sweep (iter610) ──────────────────────────────────────────
//
// `tradekit sweep` — multi-source balance consolidation. Plan + (optionally)
// execute transfers from a set of source accounts to a single target on one
// chain. Default sources = every HD account except the target; default target =
// the currently-active account.

export async function sweepCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  const logger = makeCliLogger(flags);

  try {
    const { listAccounts } = await import("../accounts.js");
    const { getKeystoreAddress } = await import("../wallet.js");
    const { KEYSTORE_LABEL } = await import("../constants.js");

    // Resolve target. --to <label> picks an account by label; otherwise default
    // is the active account.
    const accountsFile = listAccounts();
    const keystoreAddr = getKeystoreAddress();
    const known: Array<{ label: string; address: Address }> = [
      ...(accountsFile?.accounts ?? []).map((a) => ({ label: a.label, address: a.address })),
      ...(keystoreAddr ? [{ label: KEYSTORE_LABEL, address: keystoreAddr }] : []),
    ];
    if (known.length < 2) {
      throw new ToolError(
        "INVALID_PARAMS",
        "Sweep requires at least 2 accounts (one source + one target). Add HD accounts via `tradekit account add <label>` first.",
        { details: { reason: "insufficient_accounts", count: known.length } },
      );
    }

    const targetLabel = flags["to"] ?? accountsFile?.active ?? KEYSTORE_LABEL;
    const target = known.find((a) => a.label === targetLabel);
    if (!target) {
      const { unknownAccountError } = await import("../accounts.js");
      throw unknownAccountError(targetLabel, known.map((a) => a.label));
    }

    // Resolve sources. --from <comma-list> OR every known account except the target.
    let sourceLabels: string[];
    if (flags["from"]) {
      sourceLabels = flags["from"].split(",").map((s) => s.trim()).filter(Boolean);
      const { unknownAccountError } = await import("../accounts.js");
      for (const lbl of sourceLabels) {
        if (!known.some((a) => a.label === lbl)) {
          throw unknownAccountError(lbl, known.map((a) => a.label));
        }
      }
    } else {
      sourceLabels = known.filter((a) => a.label !== target.label).map((a) => a.label);
    }
    const sources = known.filter((a) => sourceLabels.includes(a.label));

    // Filters.
    const filters = {
      minUsd: flags["min-usd"] ? parseFloat(flags["min-usd"]) : undefined,
      exclude: flags["exclude"] ? flags["exclude"].split(",").map((s) => s.trim()) : undefined,
      excludeUnpriced: flags["exclude-unpriced"] === "true",
    };

    const { planSweep, executeSweep } = await import("../sweep.js");
    const { loadReadOnlyWallet } = await import("../wallet.js");
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    // For planning we just need a public client; use the keystore-fallback
    // loadReadOnlyWallet to avoid prompting for password during the plan phase.
    const probeWallet = loadReadOnlyWallet(profile, extraRpcs);

    const plan = await planSweep({
      sources,
      target: target.address,
      filters,
      ctx: {
        publicClient: probeWallet.publicClient,
        profile,
        config,
        logger,
      },
    });

    const wantJson = flags["json"] === "true";

    if (plan.transfers.length === 0) {
      if (wantJson) {
        printJson({
          ok: true,
          action: "noop-empty",
          target: target.address,
          targetLabel: target.label,
          chain: chainName,
          skipped: plan.skipped,
          timestamp: new Date().toISOString(),
        });
      } else {
        console.log(`Sweep on ${chainName} → ${target.label} (${target.address}):`);
        console.log("");
        console.log("(No transfers to make — every source is empty or filtered out.)");
        if (plan.skipped.length > 0) {
          console.log("");
          console.log(`  Skipped ${plan.skipped.length} token${plan.skipped.length === 1 ? "" : "s"}:`);
          for (const s of plan.skipped) {
            console.log(`    ${s.source}: ${s.amount} ${s.symbol} — ${s.reason}`);
          }
        }
      }
      return;
    }

    if (!wantJson) {
      console.log(`Sweep plan on ${chainName} → ${target.label} (${target.address}):`);
      // Iter679: address-book signal for the sweep target. Sweep moves the
      // entire balance — surface whether the destination is a labeled
      // address before the operator commits. Renders nothing when lookup
      // wasn't done (book IO error). The HD-account label (target.label
      // above) and the address-book label are independent — operators can
      // see both for sanity ("HD label 'main' resolves to address-book
      // alias @cold-wallet").
      if (plan.targetIsKnown === true && plan.targetLabel) {
        const noteSuffix = plan.targetNote ? ` (${plan.targetNote})` : "";
        console.log(`  ✓ Known address-book entry: @${plan.targetLabel}${noteSuffix}`);
      } else if (plan.targetIsKnown === false) {
        console.log(`  ⚠ Target not in your address book.`);
        console.log(`    If this is a trusted destination, add: tradekit address add <name> ${plan.target}`);
      }
      console.log("");
      console.log(`  ${plan.transfers.length} transfer${plan.transfers.length === 1 ? "" : "s"} from ${new Set(plan.transfers.map((t) => t.source)).size} source${new Set(plan.transfers.map((t) => t.source)).size === 1 ? "" : "s"}:`);
      console.log("");
      for (const t of plan.transfers) {
        const usdStr = t.usdValue != null ? `$${t.usdValue.toFixed(2)}` : "—";
        console.log(`    ${t.source}: ${t.amount} ${t.symbol}  (${usdStr})`);
      }
      console.log("");
      console.log(`  Total value:  ~$${plan.totalUsdValue.toFixed(2)}`);
      console.log(`  Total gas:    ~${plan.totalGasNative} ${profile.nativeSymbol}${plan.totalGasUsd != null ? ` ≈ $${plan.totalGasUsd.toFixed(2)}` : ""}`);
      if (plan.skipped.length > 0) {
        console.log("");
        console.log(`  Skipped (${plan.skipped.length}): ${plan.skipped.map((s) => `${s.source}/${s.symbol}`).join(", ")}`);
      }
    }

    if (flags["simulate"] === "true") {
      if (wantJson) {
        printJson({ ok: true, action: "simulated", ...plan });
      } else {
        console.log("");
        console.log("(--simulate: no transfers sent.)");
      }
      return;
    }

    // Real run requires --yes (CLI parity with iter604 revoke-all + iter603 cancel).
    if (flags["yes"] !== "true") {
      const { prompt } = await import("./helpers.js");
      const answer = await prompt(`\nExecute sweep? Type 'sweep' to confirm: `);
      if (answer.trim().toLowerCase() !== "sweep") {
        if (wantJson) {
          printJson({ ok: true, action: "aborted", ...plan });
        } else {
          console.log("Aborted.");
        }
        return;
      }
    }

    // Need password for signing each source. Resolve once and reuse via
    // loadWalletForSource closure.
    const pass = await requirePassword(flags);
    const { loadWallet } = await import("../wallet.js");

    const report = await executeSweep({
      plan,
      loadWalletForSource: async (label) => {
        const wallet = await loadWallet(pass, profile, extraRpcs, logger, label);
        return {
          ctx: {
            publicClient: wallet.publicClient,
            walletClient: wallet.walletClient,
            profile,
            config,
            logger,
            accountLabel: label,
          },
        };
      },
      logger,
    });

    if (wantJson) {
      printJson({ ok: true, action: "executed", ...report });
      return;
    }

    console.log("");
    for (const r of report.transfers) {
      if (r.status === "success") {
        console.log(`  ✓ ${r.source} → ${r.amount} ${r.symbol}  tx=${r.txHash}`);
      } else if (r.status === "failed") {
        console.log(`  ✗ ${r.source} → ${r.amount} ${r.symbol}  tx=${r.txHash}  (on-chain failed)`);
      } else {
        console.log(`  ✗ ${r.source} → ${r.amount} ${r.symbol}  ${r.error}`);
      }
    }
    console.log("");
    const gasUsdStr = report.totalGasUsd != null ? ` ≈ $${report.totalGasUsd.toFixed(2)}` : "";
    console.log(`Done: ${report.successCount} success, ${report.failedCount} failed, ${report.errorCount} errored, ${report.skippedCount} skipped. Gas: ${report.totalGasNative.toFixed(6)} ${profile.nativeSymbol}${gasUsdStr}.`);
  } finally {
    logger.close();
  }
}

// ── trade preflight (iter630) ────────────────────────────────
//
// `tradekit trade preflight <buy|sell>` — composite pre-trade safety check
// that runs preview + token safety + price cross-check + history slippage in
// parallel and emits a go/caution/no_go verdict with structured reasons.
//
// Use this BEFORE a real trade to catch issues (honeypot, price manipulation,
// stuck on bad route history) in ONE call instead of running the four
// individual commands separately.
//
// Flags mirror `trade preview`. Additional skip-flags let operators bypass
// expensive checks (e.g. --skip-honeypot when the token is well-known).

export async function tradePreflightCommand(
  direction: "buy" | "sell",
  flags: Record<string, string>,
) {
  const config = loadConfig();
  const chainName = flags["chain"] ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  const { base: baseResolved, quote } = resolveTradePair(profile, flags["base"] ?? "ETH", flags["quote"] ?? "USDC");
  const { NATIVE_TOKEN } = await import("../tokens.js");
  const base: Address = baseResolved === "ETH" ? NATIVE_TOKEN : (baseResolved as Address);
  // Iter645: same auto-slippage resolution as preview (above).
  const explicitSlippagePreflight = parseIntFlag(flags["slippage"], "--slippage", { min: 1, max: 10_000 });
  let slippageBps = explicitSlippagePreflight ?? config.defaultSlippageBps;
  let preflightSlippageSuggestion: import("../slippageSuggest.js").SlippageSuggestion | undefined;
  if (flags["auto-slippage"] === "true" && explicitSlippagePreflight == null) {
    try {
      const { previewSlippageSuggestion } = await import("../slippageSuggest.js");
      const acct = flags["account"] ?? (await import("../wallet.js")).activeWalletLabel();
      const suggestionReport = await previewSlippageSuggestion({
        config,
        logger: makeCliLogger(flags),
        account: acct,
        baseSymbol: (flags["base"] ?? "ETH").toUpperCase(),
        quoteSymbol: (flags["quote"] ?? "USDC").toUpperCase(),
        baseAddress: baseResolved === "ETH" ? undefined : (baseResolved as string),
        quoteAddress: quote as string,
      });
      slippageBps = suggestionReport.suggestion.suggestedBps;
      preflightSlippageSuggestion = suggestionReport.suggestion;
    } catch {
      // Best-effort fallback.
    }
  }
  const logger = makeCliLogger(flags);

  try {
    const { loadReadOnlyWallet } = await import("../wallet.js");
    const extraRpcs = config.chains[chainName]?.rpcs ?? [];
    const wallet = loadReadOnlyWallet(profile, extraRpcs, flags["account"]);

    let baseAmountRaw: bigint | undefined;
    let quoteAmountRaw: bigint | undefined;
    if (direction === "buy") {
      if (!flags["quoteAmount"]) {
        throw new ToolError(
          "INVALID_PARAMS",
          "buy preflight requires --quoteAmount (amount of quote token to SPEND).",
          { details: { direction, missingField: "quoteAmount" } },
        );
      }
      const { getToken } = await import("../tokens.js");
      const meta = await getToken(wallet.publicClient, profile, quote);
      const { parseUnits } = await import("viem");
      quoteAmountRaw = parseUnits(flags["quoteAmount"], meta.decimals);
    } else {
      if (!flags["baseAmount"]) {
        throw new ToolError(
          "INVALID_PARAMS",
          "sell preflight requires --baseAmount (amount of base token to SELL).",
          { details: { direction, missingField: "baseAmount" } },
        );
      }
      const baseIsNative = base === NATIVE_TOKEN;
      const meta = baseIsNative
        ? { decimals: 18, symbol: profile.nativeSymbol }
        : await (await import("../tokens.js")).getToken(wallet.publicClient, profile, base);
      const { parseUnits } = await import("viem");
      baseAmountRaw = parseUnits(flags["baseAmount"], meta.decimals);
    }

    const { runPreflight } = await import("../preflight.js");
    const report = await runPreflight({
      req: {
        direction,
        base,
        quote,
        baseAmount: baseAmountRaw,
        quoteAmount: quoteAmountRaw,
        slippageBps,
        skipHoneypot: flags["skip-honeypot"] === "true",
        skipPriceCheck: flags["skip-price-check"] === "true",
        skipHistory: flags["skip-history"] === "true",
        skipPortfolio: flags["skip-portfolio"] === "true",
        strategy: flags["strategy"],
      },
      publicClient: wallet.publicClient,
      walletAddress: wallet.account.address as Address,
      profile,
      config,
      logger,
      accountLabel: wallet.label,
    });

    // Iter772: --strict exit-code surface. Closes the cron-strict family for
    // the LAST major monitoring-relevant command. Triggers ONLY on verdict
    // === "no_go" — caution stays exit 0 because its semantics are
    // "review-then-proceed", not "block". Pipelines wanting to gate execution
    // on preflight outcome:
    //   tradekit trade preflight buy ... --strict && tradekit trade buy ...
    // process.exitCode (not process.exit) — main()'s audit-insert finally
    // block still runs (iter351 pattern).
    const strict = flags["strict"] === "true" || flags["strict"] === "";

    if (flags["json"] === "true") {
      printJson({ ok: true, ...report, ...(preflightSlippageSuggestion ? { slippageSuggestion: preflightSlippageSuggestion } : {}) });
      if (strict && report.verdict === "no_go") process.exitCode = 1;
      return;
    }

    const verdictBadge =
      report.verdict === "go" ? "🟢 GO" : report.verdict === "caution" ? "🟡 CAUTION" : "🔴 NO-GO";
    console.log(`Preflight ${direction} ${report.baseSymbol}/${report.quoteSymbol} on ${report.chain}:`);
    console.log("");
    console.log(`  Verdict: ${verdictBadge}`);
    // Iter645: surface the auto-slippage suggestion when used.
    if (preflightSlippageSuggestion) {
      console.log(`  Slippage:  ${slippageBps} bps (auto: ${preflightSlippageSuggestion.reason}, ${preflightSlippageSuggestion.sampleCount} samples)`);
    }
    console.log("");
    console.log(`  Findings (${report.reasons.length}):`);
    for (const r of report.reasons) {
      const sev =
        r.severity === "critical" ? "🔴 CRIT" : r.severity === "warn" ? "🟡 WARN" : "ℹ️  INFO";
      console.log(`    ${sev}  ${r.code}`);
      console.log(`           ${r.message}`);
    }
    if (report.verdict === "no_go") {
      console.log("");
      console.log("DO NOT EXECUTE this trade as-is. Address the critical findings first.");
    } else if (report.verdict === "caution") {
      console.log("");
      console.log("Proceed with care — review the warnings above before executing.");
    }
    if (strict && report.verdict === "no_go") process.exitCode = 1;
  } finally {
    logger.close();
  }
}

// v74: preflight decision journal — `tradekit trade preflight history`.
// Every preflight run with its verdict, including the caution/no_go decisions
// (trades the agent REFUSED) that leave no trace in the trades log. Surfaces
// the agent's risk discipline for an operator auditing autonomous behavior.
export async function tradePreflightHistoryCommand(flags: Record<string, string>) {
  const { listPreflightRuns, preflightVerdictBreakdown } = await import("../db.js");
  const limit = parseIntFlag(flags["limit"] ?? "20", "--limit", { min: 1, max: 1000 }) ?? 20;
  const days = parseIntFlag(flags["days"], "--days", { min: 1 });
  const sinceIso =
    days != null && days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
  const verdict = flags["verdict"];
  if (verdict != null && !["go", "caution", "no_go"].includes(verdict)) {
    throw new ToolError("INVALID_PARAMS", `--verdict must be go | caution | no_go (got "${verdict}").`);
  }
  const strategy = flags["strategy"];
  const runs = listPreflightRuns({ limit, verdict, strategy, sinceIso });
  const breakdown = preflightVerdictBreakdown({ sinceIso, strategy });

  if (flags["json"] === "true") {
    printJson({
      ok: true,
      breakdown,
      runs: runs.map((r) => ({ ...r, reasons: JSON.parse(r.reasons_json) })),
    });
    return;
  }

  const win = sinceIso ? `last ${days}d` : "all time";
  console.log(`Preflight decision journal — ${win}`);
  const refusedPct =
    breakdown.total > 0 ? (((breakdown.caution + breakdown.no_go) / breakdown.total) * 100).toFixed(0) : "0";
  console.log(
    `  Verdicts: ${breakdown.go} go · ${breakdown.caution} caution · ${breakdown.no_go} no-go ` +
      `(${breakdown.total} total · ${refusedPct}% flagged caution/no-go)`,
  );
  if (runs.length === 0) {
    console.log("  No preflight runs recorded yet.");
    return;
  }
  console.log("");
  console.log("  When                 Dir   Pair            Verdict   Est$       Top finding");
  console.log("  " + "-".repeat(98));
  for (const r of runs) {
    const when = r.timestamp.slice(0, 19).replace("T", " ");
    const pair = `${r.base_symbol ?? "?"}/${r.quote_symbol ?? "?"}`.padEnd(15);
    const badge = r.verdict === "go" ? "🟢 go" : r.verdict === "caution" ? "🟡 caution" : "🔴 no-go";
    const est = r.est_usd != null ? `$${r.est_usd.toFixed(0)}`.padEnd(10) : "—".padEnd(10);
    // Show the worst-severity reason as the headline.
    let topFinding = "";
    try {
      const reasons = JSON.parse(r.reasons_json) as Array<{ severity: string; message: string }>;
      const worst =
        reasons.find((x) => x.severity === "critical") ??
        reasons.find((x) => x.severity === "warn") ??
        reasons[0];
      topFinding = worst ? worst.message.slice(0, 60) : "";
    } catch {
      /* ignore malformed */
    }
    console.log(
      `  ${when}  ${r.direction.padEnd(4)}  ${pair} ${badge.padEnd(10)} ${est} ${topFinding}`,
    );
  }
}

// v75: preflight calibration — `tradekit trade preflight calibration`.
// Correlates each recorded preflight verdict to the trade that followed and
// shows whether the verdicts actually predicted outcomes (fill rate, realized
// slippage). The operator's deepest trust question: was the agent's judgment
// GOOD, not just recorded.
export async function tradePreflightCalibrationCommand(flags: Record<string, string>) {
  const { gatherPreflightCalibration } = await import("../preflightCalibration.js");
  const days = parseIntFlag(flags["days"], "--days", { min: 1 });
  const windowMinutes = parseIntFlag(flags["window"], "--window", { min: 1 }) ?? 30;
  const sinceIso = days != null && days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
  const report = gatherPreflightCalibration({ windowMinutes, sinceIso, strategy: flags["strategy"] });

  if (flags["json"] === "true") {
    printJson({ ok: true, ...report });
    return;
  }

  const win = sinceIso ? `last ${days}d` : "all time";
  console.log(`Preflight calibration — ${win} (trade match window ±${report.windowMinutes}m)`);
  console.log(`  ${report.totalRuns} preflight runs · ${report.totalMatched} correlated to a trade`);
  console.log("");
  console.log("  Verdict   Runs  Traded  Filled  Failed  Median slip");
  console.log("  " + "-".repeat(58));
  for (const v of report.byVerdict) {
    const badge = v.verdict === "go" ? "go     " : v.verdict === "caution" ? "caution" : "no_go  ";
    const slip = v.medianSlippageBps != null ? `${v.medianSlippageBps.toFixed(0)}bps` : "—";
    console.log(
      `  ${badge}  ${String(v.runs).padStart(4)}  ${String(v.matched).padStart(6)}  ${String(v.filled).padStart(6)}  ${String(v.failed).padStart(6)}  ${slip.padStart(11)}`,
    );
  }
  console.log("");
  console.log(`  → ${report.summary}`);
  console.log("");
  console.log("  Note: decisions↔trades are correlated by proximity (same pair/dir, nearest");
  console.log("  trade within the window), not a hard link — an aggregate read, not per-trade truth.");
}
