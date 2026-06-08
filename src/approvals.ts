import {
  type Address,
  type PublicClient,
  type WalletClient,
  type Account,
  type Transport,
  type Chain,
  maxUint256,
} from "viem";
import { ERC20_ABI } from "./constants.js";
import { ToolError, toToolError } from "./errors.js";
import { getToken, readAllowance } from "./tokens.js";
import { KNOWN_ROUTERS } from "./routers.js";
import { waitForReceiptWithTimeout } from "./receipt.js";
import { enforceApprovalSafety, enforcePreflightApprovalSafety } from "./safety.js";
import { getCurrentPrice } from "./price.js";
import type { Config } from "./config.js";
import type { ChainProfile } from "./chains.js";
import type { Logger } from "./logger.js";

export interface ApprovalRow {
  token: Address;
  symbol: string;
  decimals: number;
  spender: Address;
  /** Raw allowance in token units. */
  allowance: bigint;
  /** "infinite" if at or above 2^255, else a decimal string. */
  display: string;
  /** Spender label, if known (e.g. "kyberswap router"). */
  spenderLabel?: string;
}

/**
 * Spenders we'll probe by default when listing allowances on a chain. Pulls from the
 * shared KNOWN_ROUTERS registry so adding a new aggregator in one place automatically
 * gets surfaced here too. We also include the profile's own Uniswap V3 SwapRouter02
 * (per-chain address — distinct from the L2 deployment in KNOWN_ROUTERS).
 */
function defaultSpenders(profile: ChainProfile): { address: Address; label: string }[] {
  const out: { address: Address; label: string }[] = [];
  if (profile.uniswapV3) {
    out.push({ address: profile.uniswapV3.swapRouter02, label: "Uniswap V3 SwapRouter02" });
  }
  for (const r of KNOWN_ROUTERS) {
    // Avoid a duplicate row if the profile's V3 router happens to match the L2 canonical one.
    if (profile.uniswapV3 && r.address.toLowerCase() === profile.uniswapV3.swapRouter02.toLowerCase()) continue;
    out.push({ address: r.address, label: r.label });
  }
  return out;
}

/** Tokens to probe for allowances: profile's tokens + WETH + USDC. */
function tokensToProbe(profile: ChainProfile): Address[] {
  const set = new Set<string>();
  for (const t of Object.values(profile.tokens)) set.add((t as string).toLowerCase());
  set.add(profile.usdc.toLowerCase());
  set.add(profile.weth.toLowerCase());
  return [...set] as Address[];
}

/**
 * List non-zero allowances for the active wallet on a chain.
 * We probe (profile_tokens) × (known_spenders + explicit extras) and return rows where
 * `allowance > 0`. This avoids needing an event indexer.
 */
export async function listAllowances(
  ctx: {
    publicClient: PublicClient<Transport, Chain>;
    profile: ChainProfile;
    owner: Address;
    logger: Logger;
  },
  options: { extraSpenders?: Address[]; tokens?: Address[] } = {},
): Promise<ApprovalRow[]> {
  const tokens = options.tokens && options.tokens.length > 0 ? options.tokens : tokensToProbe(ctx.profile);
  const knownSpenders = defaultSpenders(ctx.profile);
  const extraSpenders = (options.extraSpenders ?? []).map((s) => ({ address: s, label: "user" }));
  const spenders = [...knownSpenders, ...extraSpenders];

  const rows: ApprovalRow[] = [];
  // Parallelise the (token × spender) cross-product
  await Promise.all(
    tokens.flatMap((token) =>
      spenders.map(async (spender) => {
        try {
          const allowance = await readAllowance(ctx.publicClient, token, ctx.owner, spender.address);
          if (allowance === 0n) return;
          const meta = await getToken(ctx.publicClient, ctx.profile, token);
          const display = allowance >= 1n << 255n ? "infinite" : formatUnitsBigDecimal(allowance, meta.decimals);
          rows.push({
            token,
            symbol: meta.symbol,
            decimals: meta.decimals,
            spender: spender.address,
            allowance,
            display,
            spenderLabel: spender.label,
          });
        } catch (e) {
          ctx.logger.debug(`allowance read failed token=${token} spender=${spender.address}: ${(e as Error).message}`);
        }
      }),
    ),
  );
  // Sort: largest allowance first
  rows.sort((a, b) => (b.allowance > a.allowance ? 1 : b.allowance < a.allowance ? -1 : 0));
  return rows;
}

/** Set or change an ERC20 allowance for the wallet. */
export interface ApproveResult {
  txHash: `0x${string}`;
  status: "success" | "failed";
  token: Address;
  spender: Address;
  amount: bigint;
  gasUsed: string;
  gasCostNative: string;
  /** Gas in USD (best-effort; null when the native price isn't known). */
  gasCostUsd?: number;
  /** Iter681: spender classification surfaced on the result. `isKnown`
   *  true when the spender resolves to a curated router (KNOWN_ROUTERS or
   *  profile-derived), an entry in config.safety.contractWhitelist for
   *  this chain, or the operator's address book. `source` discriminates
   *  the match — "router" for curated, "whitelist" for config-driven,
   *  "address-book" for operator-labeled. Absent when classification
   *  wasn't done (no profile context). */
  spenderIsKnown?: boolean;
  spenderLabel?: string;
  spenderClassification?: "router" | "whitelist" | "address-book" | "unknown";
}

/**
 * Iter681: classify a spender address against the operator's known/trusted set.
 * Used by approve to surface "✓ Known aggregator" vs "⚠ Unknown spender" at
 * send time. Pure / synchronous: address-book lookup uses the cached file
 * read but does no network I/O.
 *
 * Resolution order (first match wins):
 *   1. KNOWN_ROUTERS / profile defaultSpenders — curated routers (KyberSwap,
 *      OpenOcean, Uniswap, 0x, 1inch, etc.) we ship hardcoded
 *   2. config.safety.contractWhitelist for this chain — operator-curated
 *      trusted spenders (corporate treasury, custom integrations)
 *   3. Address book — operator labeled this address explicitly
 *
 * Everything else → "unknown". The classification is informational; safety
 * guardrails (enforcePreflightApprovalSafety) are the hard block.
 */
export async function classifySpender(
  spender: Address,
  profile: ChainProfile,
  config?: Config,
): Promise<{ isKnown: boolean; label?: string; source: "router" | "whitelist" | "address-book" | "unknown" }> {
  const lower = spender.toLowerCase();

  // 1. Curated routers (per-chain + cross-chain).
  for (const r of defaultSpenders(profile)) {
    if (r.address.toLowerCase() === lower) {
      return { isKnown: true, label: r.label, source: "router" };
    }
  }

  // 2. Operator-curated whitelist (per-chain).
  const whitelist = config?.safety?.contractWhitelist?.[profile.name];
  if (whitelist) {
    for (const addr of whitelist) {
      if ((addr as string).toLowerCase() === lower) {
        return { isKnown: true, label: "operator whitelist", source: "whitelist" };
      }
    }
  }

  // 3. Address book — operators sometimes label aggregators or custom
  // contracts they trust beyond what the whitelist captures (e.g. "alice's
  // multisig that approves to a custom DEX adapter"). Best-effort: file IO
  // failure falls through to "unknown" rather than masking with a fake match.
  try {
    const { loadAddressBook, findByAddress } = await import("./addressBook.js");
    const book = loadAddressBook();
    const entry = findByAddress(book, spender);
    if (entry) {
      return { isKnown: true, label: entry.name, source: "address-book" };
    }
  } catch {
    /* fall through */
  }

  return { isKnown: false, source: "unknown" };
}

export async function approveToken(
  ctx: {
    publicClient: PublicClient<Transport, Chain>;
    walletClient: WalletClient<Transport, Chain, Account>;
    profile: ChainProfile;
    logger: Logger;
    /** Optional config — when provided, safety guardrails are enforced. Pass undefined
     *  only for trusted in-process callers (e.g. the trade flow's internal auto-approve,
     *  which has already been gated by enforceSafety on the swap itself). */
    config?: Config;
  },
  args: { token: Address; spender: Address; amount?: bigint; /** if true, set to maxUint256 ("infinite") */ infinite?: boolean; /** bypass infinite-approval gate */ override?: boolean },
): Promise<ApproveResult> {
  const meta = await getToken(ctx.publicClient, ctx.profile, args.token);
  if (meta.isNative) throw new ToolError("INVALID_PARAMS", "Cannot approve the native asset.");
  const amount = args.infinite ? maxUint256 : args.amount ?? 0n;

  // Safety guardrails (only on direct user-initiated approvals; in-trade auto-approve
  // is already governed by the swap's safety check). We deliberately skip safety
  // for `amount === 0` (revokes): removing an existing allowance is always a
  // security-positive action, even for blacklisted tokens or unwhitelisted spenders.
  if (ctx.config && amount > 0n) {
    // Iter413: pre-flight the cheap config-only checks (token whitelist/blacklist,
    // spender contract whitelist, infinite-approval gate) BEFORE the price-lookup
    // HTTP roundtrip. Same fail-fast pattern iter403/404/405 applied to trade.ts
    // and iter412 applied to transfer.ts. (Iter425: import is static — same module
    // is already pulled in at top of file for enforceApprovalSafety, so a dynamic
    // import here was needless overhead.)
    enforcePreflightApprovalSafety(
      { chain: ctx.profile.name, token: args.token, spender: args.spender, amount, override: args.override },
      ctx.config,
      ctx.logger,
    );
    const tokenUsdPrice = (await getCurrentPrice(args.token, ctx.logger).catch(() => null)) ?? undefined;
    enforceApprovalSafety(
      {
        chain: ctx.profile.name,
        token: args.token,
        spender: args.spender,
        amount,
        decimals: meta.decimals,
        tokenUsdPrice,
        override: args.override,
      },
      ctx.config,
      ctx.logger,
    );
  }

  // Iter681: classify the spender BEFORE the on-chain call so the operator
  // / agent has the signal before the irreversible signature. Best-effort —
  // never block on classification.
  let classification: Awaited<ReturnType<typeof classifySpender>> | undefined;
  try {
    classification = await classifySpender(args.spender, ctx.profile, ctx.config);
    if (!classification.isKnown) {
      ctx.logger.warn(
        `⚠ Approving unknown spender ${args.spender} on ${ctx.profile.name}. Spender is not a curated aggregator router, not in your contractWhitelist, and not in your address book. If this is intentional, add to safety.contractWhitelist or address book to silence this warning.`,
      );
    } else {
      ctx.logger.info(`Spender resolves to "${classification.label}" (source: ${classification.source})`);
    }
  } catch (e) {
    ctx.logger.debug(`iter681 classifySpender failed: ${(e as Error).message}`);
  }

  ctx.logger.info(`Approving ${meta.symbol} (${args.token}) → ${args.spender} amount=${amount === maxUint256 ? "infinite" : amount}`);
  let txHash: `0x${string}`;
  try {
    txHash = await ctx.walletClient.writeContract({
      address: args.token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [args.spender, amount],
    });
  } catch (e) {
    throw toToolError(e, "TX_REVERTED");
  }
  const receipt = await waitForReceiptWithTimeout(ctx.publicClient, txHash, ctx.profile);
  const status: "success" | "failed" = receipt.status === "success" ? "success" : "failed";
  const gasUsed = receipt.gasUsed.toString();
  const gasCostWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
  const gasCostNative = formatUnitsBigDecimal(gasCostWei, 18);
  // Best-effort gas-in-USD. iter132's price cache makes this nearly free in the
  // common case where another flow already fetched the native price recently.
  let gasCostUsd: number | undefined;
  try {
    const px = await getCurrentPrice(ctx.profile.weth, ctx.logger);
    if (px != null) {
      const n = parseFloat(gasCostNative);
      if (Number.isFinite(n)) gasCostUsd = n * px;
    }
  } catch {
    /* best-effort */
  }

  ctx.logger.info(`Approve ${status}: ${txHash} gas=${gasUsed}`);

  // Push-notify on a successful infinite approval — these are the highest-
  // risk on-chain action a wallet can take (revoking later requires a
  // separate tx; a malicious or compromised spender can drain the token).
  // critical severity so even minSeverity=critical channels see this. The
  // approval-audit suite can already detect them post-hoc; this gets
  // operators paged the moment one lands. Skipped on revoke (amount=0) and
  // on failure (no on-chain effect).
  if (status === "success" && amount === maxUint256 && ctx.config) {
    try {
      const { tryNotify } = await import("./notify.js");
      await tryNotify(
        {
          event: "approval.infinite",
          severity: "critical",
          title: `Infinite approval granted: ${meta.symbol ?? args.token} → ${args.spender}`,
          body: classification?.isKnown
            ? `Spender resolves to "${classification.label}" (${classification.source}).`
            : `⚠ Spender is unknown (not a curated router, not in contractWhitelist, not in address book). Verify before this token can be moved.`,
          fields: {
            chain: ctx.profile.name,
            token: meta.symbol ?? args.token,
            tokenAddress: args.token,
            spender: args.spender,
            spenderKnown: classification?.isKnown ?? null,
            spenderLabel: classification?.label ?? null,
            txHash,
          },
          link: ctx.profile.explorer ? `${ctx.profile.explorer}/tx/${txHash}` : undefined,
          // Dedup on (spender, token) so a back-to-back retry of the same
          // approve doesn't double-alert. Different spender / different
          // token = different dedup bucket.
          dedupKey: `approval.infinite:${args.token}:${args.spender}`.toLowerCase(),
        },
        ctx.config,
        ctx.logger,
      );
    } catch (e) {
      ctx.logger.debug(`approval.infinite notify dispatch threw: ${(e as Error).message}`);
    }
  }

  return {
    txHash,
    status,
    token: args.token,
    spender: args.spender,
    amount,
    gasUsed,
    gasCostNative,
    gasCostUsd,
    // Iter681: surface the classification on the result. MCP agents can
    // branch on `spenderIsKnown === false` post-execute to confirm whether
    // a future second-leg approve to the same spender is safe.
    ...(classification
      ? {
          spenderIsKnown: classification.isKnown,
          spenderClassification: classification.source,
          ...(classification.label ? { spenderLabel: classification.label } : {}),
        }
      : {}),
  };
}

/** Revoke (set allowance to 0). Same surface as approve. */
export async function revokeToken(
  ctx: {
    publicClient: PublicClient<Transport, Chain>;
    walletClient: WalletClient<Transport, Chain, Account>;
    profile: ChainProfile;
    logger: Logger;
    config?: Config;
  },
  args: { token: Address; spender: Address },
): Promise<ApproveResult> {
  return approveToken(ctx, { token: args.token, spender: args.spender, amount: 0n });
}

// ── bulk revoke (iter604) ────────────────────────────────────
//
// Pre-iter604 this logic lived inline in cli/approvals.ts so only the CLI had
// it; an MCP agent doing security cleanup could only revoke one approval at a
// time. Extracted here so MCP's `revoke_all` and CLI's `allowances revoke-all`
// share one implementation — no behavior drift across surfaces.
//
// The function operates in TWO modes:
//   - preflight: read-only. Builds the target list (listAllowances + filters)
//     and estimates total gas vs current native balance. Returns
//     RevokeAllPreflight. Used for --simulate / dry-run / MCP pre-check.
//   - execute: full revoke loop. Requires walletClient. Returns
//     RevokeAllExecuted with per-target status.

export interface RevokeAllFilters {
  /** Restrict to allowances granted to this spender address (case-insensitive). */
  spender?: Address;
  /** Restrict to this token. Accepts either an address (case-insensitive) or a
   *  case-insensitive symbol match. Matches the iter302 filter semantic the CLI uses. */
  token?: string;
}

export interface RevokeAllTarget {
  token: Address;
  symbol: string;
  spender: Address;
  spenderLabel: string | null;
  display: string;
}

export interface RevokeAllPreflight {
  action: "preflight";
  targets: RevokeAllTarget[];
  /** Per-revoke gas estimate × target count, in native units. ~50k gas/revoke is a
   *  conservative upper bound — actual usage runs 30-46k depending on the token's
   *  approve() implementation. We use 50k to avoid under-funded surprises. */
  estimatedGasNative: string;
  estimatedGasUsd: number | null;
  walletNativeBalance: string;
  /** True when wallet's native balance ≥ estimated gas cost. False surfaces a
   *  pre-flight INSUFFICIENT_BALANCE situation so the caller can refuse to start
   *  the loop instead of running half the revokes and stalling at #N. */
  hasGasFunds: boolean;
  chain: string;
}

export interface RevokeAllPerTarget {
  token: Address;
  symbol: string;
  spender: Address;
  spenderLabel: string | null;
  status: "success" | "failed" | "error";
  txHash?: `0x${string}`;
  error?: string;
}

export interface RevokeAllExecuted {
  action: "revoked";
  revoked: number;
  failed: number;
  /** Sum of per-target gasCostNative as a number (may have float drift on very large
   *  bulk runs — acceptable since this is a logging/audit field, not a financial
   *  source-of-truth). */
  gasNative: number;
  gasUsd: number | null;
  results: RevokeAllPerTarget[];
  chain: string;
}

const PER_REVOKE_GAS_ESTIMATE = 50_000n;

/**
 * Iter604: pure filter for bulk-revoke targets — separated from planRevokeAll
 * so the matching rules (case-insensitive spender + symbol/address token
 * matching) are unit-testable without a live chain.
 *
 * Rules:
 * - `filters.spender` matches r.spender exactly (lowercased).
 * - `filters.token` matches EITHER r.symbol OR r.token address (both lowercased).
 *   This is the same dual-match semantic CLI users expect — `--token USDC` and
 *   `--token 0xa0b8...` both work.
 * - No filter set → all rows match.
 * - When both filters are set, BOTH must match (AND).
 */
export function filterRevokeTargets(
  rows: ApprovalRow[],
  filters: RevokeAllFilters,
): RevokeAllTarget[] {
  const spenderFilter = filters.spender?.toLowerCase();
  const tokenFilter = filters.token?.toLowerCase();
  return rows
    .filter((r) => {
      if (spenderFilter && r.spender.toLowerCase() !== spenderFilter) return false;
      if (tokenFilter && r.symbol.toLowerCase() !== tokenFilter && r.token.toLowerCase() !== tokenFilter) {
        return false;
      }
      return true;
    })
    .map((r) => ({
      token: r.token,
      symbol: r.symbol,
      spender: r.spender,
      spenderLabel: r.spenderLabel ?? null,
      display: r.display,
    }));
}

export async function planRevokeAll(
  ctx: {
    publicClient: PublicClient<Transport, Chain>;
    profile: ChainProfile;
    logger: Logger;
    owner: Address;
  },
  filters: RevokeAllFilters,
): Promise<RevokeAllPreflight> {
  const rows = await listAllowances(
    { publicClient: ctx.publicClient, profile: ctx.profile, owner: ctx.owner, logger: ctx.logger },
    {},
  );
  const targets = filterRevokeTargets(rows, filters);

  // Gas pre-check: each revoke costs ~50k gas at current maxFeePerGas. Sum,
  // compare against wallet native balance. The native balance fetch runs in
  // parallel with the gas-price read for fastest preflight.
  const [balanceRes, feesRes] = await Promise.all([
    ctx.publicClient.getBalance({ address: ctx.owner }).catch(() => 0n),
    ctx.publicClient.estimateFeesPerGas().catch(() => null),
  ]);
  const balance = balanceRes;
  const gasPriceWei = feesRes?.maxFeePerGas ?? feesRes?.gasPrice ?? 0n;
  const totalGasWei = PER_REVOKE_GAS_ESTIMATE * gasPriceWei * BigInt(targets.length);
  const estimatedGasNative = formatUnitsBigDecimal(totalGasWei, 18);
  const walletNativeBalance = formatUnitsBigDecimal(balance, 18);
  const hasGasFunds = balance >= totalGasWei;

  // USD price — best-effort, doesn't fail the preflight.
  let estimatedGasUsd: number | null = null;
  try {
    const nativeUsd = await getCurrentPrice(ctx.profile.weth, ctx.logger);
    if (nativeUsd != null) estimatedGasUsd = parseFloat(estimatedGasNative) * nativeUsd;
  } catch {
    /* leave as null */
  }

  return {
    action: "preflight",
    targets,
    estimatedGasNative,
    estimatedGasUsd,
    walletNativeBalance,
    hasGasFunds,
    chain: ctx.profile.name,
  };
}

export async function executeRevokeAll(
  ctx: {
    publicClient: PublicClient<Transport, Chain>;
    walletClient: WalletClient<Transport, Chain, Account>;
    profile: ChainProfile;
    logger: Logger;
    config?: Config;
  },
  targets: RevokeAllTarget[],
): Promise<RevokeAllExecuted> {
  let revoked = 0;
  let failed = 0;
  let totalGasNative = 0;
  let totalGasUsd = 0;
  let totalGasUsdKnown = false;
  const results: RevokeAllPerTarget[] = [];

  for (const t of targets) {
    try {
      const result = await revokeToken(ctx, { token: t.token, spender: t.spender });
      const n = parseFloat(result.gasCostNative);
      if (Number.isFinite(n)) totalGasNative += n;
      if (result.gasCostUsd != null) {
        totalGasUsd += result.gasCostUsd;
        totalGasUsdKnown = true;
      }
      if (result.status === "success") {
        revoked++;
        results.push({ token: t.token, symbol: t.symbol, spender: t.spender, spenderLabel: t.spenderLabel, status: "success", txHash: result.txHash });
      } else {
        failed++;
        results.push({ token: t.token, symbol: t.symbol, spender: t.spender, spenderLabel: t.spenderLabel, status: "failed", txHash: result.txHash });
      }
    } catch (e) {
      failed++;
      const msg = (e as Error).message;
      results.push({ token: t.token, symbol: t.symbol, spender: t.spender, spenderLabel: t.spenderLabel, status: "error", error: msg });
    }
  }

  return {
    action: "revoked",
    revoked,
    failed,
    gasNative: totalGasNative,
    gasUsd: totalGasUsdKnown ? totalGasUsd : null,
    results,
    chain: ctx.profile.name,
  };
}

// ── shared helper (small enough to inline; avoids circular import with simulate.ts) ─

function formatUnitsBigDecimal(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${intPart}${frac ? "." + frac : ""}`;
}
