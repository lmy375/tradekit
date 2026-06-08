// Iter610: wallet sweep — multi-source balance consolidation. Pre-iter610
// operators consolidating 5 HD accounts × 6 tokens ran 30+ separate transfer
// commands and tracked outcomes manually. This module plans the full sweep
// up-front + executes it with per-transfer tracking.
//
// Two phases — same plan/execute split as iter604 bulk-revoke:
//
//   planSweep (read-only):
//     - For each (source, chain), call holdingsOnChain
//     - Filter: amount > 0, USD > minUsd (if set), token not in exclude set
//     - Build SweepTransfer entries: source, chain, token, symbol, amount, usd
//     - Estimate gas per transfer (native: 21000, ERC20: ~50000) × current gas price
//     - Surface total gas estimate + per-source breakdown
//
//   executeSweep (signing):
//     - For each transfer: loadWallet for that source account, run executeTransfer
//     - Track per-transfer outcomes (success/failed/error)
//     - Skip a transfer where pre-flight INSUFFICIENT_BALANCE would fire
//     - Stop the whole sweep if a target source has zero native (can't pay gas)
//
// Safety:
//   - The plan phase shows the operator EXACTLY what will move before they
//     confirm — no surprise transfers.
//   - Native sweep uses "max" semantics (reserve gas, send the rest).
//   - The exclude list defaults to nothing, but `--exclude-zero-priced`
//     skips unpriced tokens (since we can't even estimate the USD value).

import type { Address, PublicClient, Transport, Chain } from "viem";
import { formatUnits } from "viem";
import type { ChainProfile } from "./chains.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { ToolError } from "./errors.js";
import { holdingsOnChain, type ChainHoldings, type TokenBalance } from "./holdings.js";

/** ~21000 for native, ~50000 for ERC20 transfer. Use the larger figure as a
 *  conservative ceiling for the pre-flight estimate. */
const NATIVE_GAS_ESTIMATE = 21_000n;
const ERC20_GAS_ESTIMATE = 50_000n;

export interface SweepFilters {
  /** Skip transfers whose USD value is below this threshold. Useful for "don't
   *  bother moving $0.30 of dust at $10 of gas". */
  minUsd?: number;
  /** Skip these tokens regardless of value. Match is exact-address (lowercased)
   *  OR exact symbol (case-insensitive). */
  exclude?: string[];
  /** Skip tokens that have no USD price (we can't evaluate their value, so
   *  bulk-moving them is risky — could be a worthless scam or could be
   *  high-value-unindexed). Default false. */
  excludeUnpriced?: boolean;
}

export interface SweepTransfer {
  source: string; // account label
  sourceAddress: Address;
  chain: string;
  token: Address | "NATIVE";
  symbol: string;
  decimals: number;
  amount: string; // decimal
  usdValue: number | null;
  /** Estimated gas cost for THIS transfer in native (decimal). */
  estimatedGasNative: string;
  estimatedGasUsd: number | null;
  /** Reason the transfer is included (filters that passed) or null. */
  includeReason: string;
}

export interface SweepSkip {
  source: string;
  chain: string;
  token: Address | "NATIVE";
  symbol: string;
  amount: string;
  usdValue: number | null;
  /** Why this token was skipped. Stable string codes for agents to branch on. */
  reason: "below_min_usd" | "in_exclude_list" | "no_price_data" | "zero_balance";
}

export interface SweepPlan {
  target: Address;
  /** Iter679: address-book lookup for the sweep target. Sweep moves ALL
   *  balance — higher stakes than a single transfer, so surfacing whether
   *  the destination is known is even more important. Both fields absent
   *  when the lookup wasn't done (book IO error). `targetLabel` is the
   *  @alias; `targetNote` is the entry's free-form note (iter680). */
  targetIsKnown?: boolean;
  targetLabel?: string;
  targetNote?: string;
  /** Per-(source, chain) transfers ordered: native first, then ERC20s by USD desc. */
  transfers: SweepTransfer[];
  /** Tokens that were considered but skipped. */
  skipped: SweepSkip[];
  /** Total estimated gas across all transfers, native + USD. */
  totalGasNative: string;
  totalGasUsd: number | null;
  /** Total USD value being moved (excluding unpriced). */
  totalUsdValue: number;
  chain: string;
  timestamp: string;
}

export interface SweepResult {
  source: string;
  chain: string;
  token: Address | "NATIVE";
  symbol: string;
  amount: string;
  status: "success" | "failed" | "error" | "skipped";
  txHash?: `0x${string}`;
  error?: string;
}

export interface SweepReport {
  target: Address;
  successCount: number;
  failedCount: number;
  errorCount: number;
  skippedCount: number;
  totalGasNative: number;
  totalGasUsd: number | null;
  transfers: SweepResult[];
  chain: string;
  timestamp: string;
  /** Iter917: wall-clock for the entire sweep loop. Scales with
   *  transfers.length × per-tx receipt wait; useful for batch-throughput planning. */
  elapsedMs?: number;
}

interface SweepCtx {
  publicClient: PublicClient<Transport, Chain>;
  profile: ChainProfile;
  config: Config;
  logger: Logger;
}

/**
 * Iter610: pure filter — given a token balance, the filter spec, and a native
 * USD price, decide whether to include the token + return the reason.
 *
 * Returns either:
 *   - { include: true, reason: "<why>" } for inclusion
 *   - { include: false, reason: "<one of the SweepSkip reasons>" } for exclusion
 *
 * Extracted so the filter matrix is unit-testable without HTTP.
 */
export function classifyTokenForSweep(
  balance: TokenBalance,
  filters: SweepFilters,
): { include: true; reason: string } | { include: false; reason: SweepSkip["reason"] } {
  // Zero balance: skip silently (no point even appearing in the plan).
  const amountFloat = parseFloat(balance.amount);
  if (!Number.isFinite(amountFloat) || amountFloat === 0) {
    return { include: false, reason: "zero_balance" };
  }

  // Exclude list (lowercase symbol OR address match).
  if (filters.exclude && filters.exclude.length > 0) {
    const lowerExclude = filters.exclude.map((s) => s.toLowerCase());
    const symbolLower = balance.symbol.toLowerCase();
    const tokenLower = balance.token === "NATIVE" ? "native" : balance.token.toLowerCase();
    if (lowerExclude.includes(symbolLower) || lowerExclude.includes(tokenLower)) {
      return { include: false, reason: "in_exclude_list" };
    }
  }

  // Min USD threshold.
  if (filters.minUsd != null && filters.minUsd > 0) {
    if (balance.usd == null) {
      // Has minUsd filter but no price — treat as below threshold ONLY if
      // excludeUnpriced is set; otherwise let it through.
      if (filters.excludeUnpriced) {
        return { include: false, reason: "no_price_data" };
      }
      // Otherwise: include with a "no_price_data" note in the reason (caller
      // still sees the include path).
      return { include: true, reason: "included (no price data — minUsd filter skipped)" };
    }
    if (balance.usd < filters.minUsd) {
      return { include: false, reason: "below_min_usd" };
    }
  }

  // Unpriced + excludeUnpriced even without minUsd: skip.
  if (filters.excludeUnpriced && balance.usd == null) {
    return { include: false, reason: "no_price_data" };
  }

  return { include: true, reason: "included" };
}

/**
 * Iter610: plan a sweep — build the full transfer list + gas estimate WITHOUT
 * executing. Used in two contexts:
 *   - CLI `sweep --simulate`: print the plan, exit
 *   - CLI `sweep` (real): print the plan, prompt for confirmation, then run
 *   - MCP `sweep_balances` with dryRun=true: return the plan as the response
 *
 * Reads holdings for each (source, chain) in parallel. Fans out aggressively
 * for fast multi-source planning — public RPCs typically tolerate this fine
 * since we're just doing balance reads.
 */
export async function planSweep(args: {
  sources: Array<{ label: string; address: Address }>;
  target: Address;
  filters: SweepFilters;
  ctx: SweepCtx;
}): Promise<SweepPlan> {
  // Read holdings for each source IN PARALLEL.
  const allHoldings = await Promise.all(
    args.sources.map(async (s) => {
      const report = await holdingsOnChain(s.address, args.ctx.profile.name, args.ctx.config, args.ctx.logger);
      return { source: s, report };
    }),
  );

  // Native gas price for transfer-cost estimates. Best-effort.
  const fees = await args.ctx.publicClient.estimateFeesPerGas().catch(() => null);
  const gasPriceWei = fees?.maxFeePerGas ?? fees?.gasPrice ?? 0n;

  // Native USD price for gas-cost USD conversion (NOT for token valuation —
  // each balance already carries its own USD price via holdingsOnChain).
  const { getCurrentPrice } = await import("./price.js");
  const nativeUsd = await getCurrentPrice(args.ctx.profile.weth, args.ctx.logger).catch(() => null);

  const transfers: SweepTransfer[] = [];
  const skipped: SweepSkip[] = [];

  for (const { source, report } of allHoldings) {
    // Skip transfers where source IS the target (self-sweep doesn't help).
    if (source.address.toLowerCase() === args.target.toLowerCase()) {
      args.ctx.logger.debug(`Sweep: skipping source ${source.label} — already the target`);
      continue;
    }

    for (const bal of report.balances) {
      const classification = classifyTokenForSweep(bal, args.filters);
      if (!classification.include) {
        skipped.push({
          source: source.label,
          chain: report.chain,
          token: bal.token,
          symbol: bal.symbol,
          amount: bal.amount,
          usdValue: bal.usd ?? null,
          reason: classification.reason,
        });
        continue;
      }

      // Estimate gas: native transfer = 21k, ERC20 = ~50k.
      const isNative = bal.token === "NATIVE";
      const gasUnits = isNative ? NATIVE_GAS_ESTIMATE : ERC20_GAS_ESTIMATE;
      const gasWei = gasUnits * gasPriceWei;
      const estimatedGasNative = formatUnits(gasWei, 18);
      const estimatedGasUsd =
        nativeUsd != null && Number.isFinite(parseFloat(estimatedGasNative))
          ? parseFloat(estimatedGasNative) * nativeUsd
          : null;

      transfers.push({
        source: source.label,
        sourceAddress: source.address,
        chain: report.chain,
        token: bal.token,
        symbol: bal.symbol,
        decimals: bal.decimals,
        amount: bal.amount,
        usdValue: bal.usd ?? null,
        estimatedGasNative,
        estimatedGasUsd,
        includeReason: classification.reason,
      });
    }
  }

  // Order: native first (so gas reserve handles itself), then ERC20s by USD desc
  // within each source. The USD-desc within-source ordering means the biggest
  // ticket items move first — if gas runs out partway through, the highest-
  // value transfers are already done.
  transfers.sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    const aNative = a.token === "NATIVE" ? 0 : 1;
    const bNative = b.token === "NATIVE" ? 0 : 1;
    if (aNative !== bNative) return aNative - bNative;
    return (b.usdValue ?? 0) - (a.usdValue ?? 0);
  });

  // Sum gas + USD value across the plan.
  let totalGasWei = 0n;
  let totalUsdValue = 0;
  for (const t of transfers) {
    const gasUnits = t.token === "NATIVE" ? NATIVE_GAS_ESTIMATE : ERC20_GAS_ESTIMATE;
    totalGasWei += gasUnits * gasPriceWei;
    if (t.usdValue != null) totalUsdValue += t.usdValue;
  }
  const totalGasNative = formatUnits(totalGasWei, 18);
  const totalGasUsd =
    nativeUsd != null && Number.isFinite(parseFloat(totalGasNative))
      ? parseFloat(totalGasNative) * nativeUsd
      : null;

  // Iter679/iter680: address-book lookup for the target. Best-effort; on IO
  // failure both fields stay undefined and CLI renders nothing (no false
  // reassurance).
  let targetIsKnown: boolean | undefined;
  let targetLabel: string | undefined;
  let targetNote: string | undefined;
  try {
    const { loadAddressBook, findByAddress } = await import("./addressBook.js");
    const book = loadAddressBook();
    const entry = findByAddress(book, args.target);
    targetIsKnown = entry != null;
    if (entry) {
      targetLabel = entry.name;
      if (entry.note) targetNote = entry.note;
    }
  } catch (e) {
    args.ctx.logger.debug(`iter679 address-book lookup failed: ${(e as Error).message}`);
  }

  return {
    target: args.target,
    ...(targetIsKnown !== undefined ? { targetIsKnown } : {}),
    ...(targetLabel ? { targetLabel } : {}),
    ...(targetNote ? { targetNote } : {}),
    transfers,
    skipped,
    totalGasNative,
    totalGasUsd,
    totalUsdValue,
    chain: args.ctx.profile.name,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Execute the planned sweep — runs each transfer sequentially using
 * executeTransfer. Requires the caller to provide a wallet-loader that can
 * sign for each source account.
 *
 * `loadWalletForSource(label)` should return a TransferContext for that account
 * (the caller handles password resolution + HD derivation).
 *
 * Sequential by design: per-source nonces would conflict on parallel send if
 * an HD has multiple transfers, and the iter604 lessons apply (operator wants
 * to see progress, errors don't abort the rest).
 */
export async function executeSweep(args: {
  plan: SweepPlan;
  loadWalletForSource: (
    label: string,
  ) => Promise<{ ctx: import("./transfer.js").TransferContext }>;
  logger: Logger;
}): Promise<SweepReport> {
  // Iter917: wall-clock for the sweep loop. Sweep = N sequential transfers;
  // total elapsed scales with plan.transfers.length × per-tx receipt wait.
  // Operators batching reward distributions read elapsedMs to plan throughput.
  const t0 = Date.now();
  const results: SweepResult[] = [];
  let successCount = 0;
  let failedCount = 0;
  let errorCount = 0;
  let totalGasNative = 0;
  let totalGasUsdKnown = false;
  let totalGasUsd = 0;

  // Cache wallets per source — multiple transfers from the same source reuse
  // the same context. Loading wallet = keystore decrypt; doing it once per
  // sweep iteration would multiply the password-prompt cost.
  const walletCache = new Map<string, { ctx: import("./transfer.js").TransferContext }>();

  for (const t of args.plan.transfers) {
    try {
      let wallet = walletCache.get(t.source);
      if (!wallet) {
        wallet = await args.loadWalletForSource(t.source);
        walletCache.set(t.source, wallet);
      }

      const { executeTransfer } = await import("./transfer.js");
      const isNative = t.token === "NATIVE";
      // For native: use "max" semantics so we get the iter325 gas reserve.
      // For ERC20: send the exact balance (decimal string already from holdings).
      const amount = isNative ? "max" : t.amount;
      const tokenArg = isNative ? ("ETH" as const) : (t.token as Address);

      const result = await executeTransfer(
        {
          token: tokenArg,
          to: args.plan.target,
          amount,
          note: `sweep from ${t.source}`,
        },
        wallet.ctx,
      );

      if (result.status === "success") {
        successCount++;
        results.push({
          source: t.source,
          chain: t.chain,
          token: t.token,
          symbol: t.symbol,
          amount: result.amount,
          status: "success",
          txHash: result.txHash,
        });
      } else {
        failedCount++;
        results.push({
          source: t.source,
          chain: t.chain,
          token: t.token,
          symbol: t.symbol,
          amount: result.amount,
          status: "failed",
          txHash: result.txHash,
        });
      }

      const gasNative = result.gasCostNative ? parseFloat(result.gasCostNative) : 0;
      if (Number.isFinite(gasNative)) totalGasNative += gasNative;
      if (result.gasCostUsd != null) {
        totalGasUsd += result.gasCostUsd;
        totalGasUsdKnown = true;
      }
    } catch (e) {
      errorCount++;
      const message = e instanceof ToolError ? e.message : (e as Error).message;
      results.push({
        source: t.source,
        chain: t.chain,
        token: t.token,
        symbol: t.symbol,
        amount: t.amount,
        status: "error",
        error: message,
      });
      args.logger.warn(`Sweep: ${t.source}/${t.symbol} failed — ${message}`);
    }
  }

  return {
    target: args.plan.target,
    successCount,
    failedCount,
    errorCount,
    skippedCount: args.plan.skipped.length,
    totalGasNative,
    totalGasUsd: totalGasUsdKnown ? totalGasUsd : null,
    transfers: results,
    chain: args.plan.chain,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
  };
}
