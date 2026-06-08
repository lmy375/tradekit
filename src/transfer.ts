import {
  getAddress,
  parseUnits,
  formatUnits,
  formatEther,
  encodeFunctionData,
  type Address,
  type PublicClient,
  type WalletClient,
  type Account,
  type Transport,
  type Chain,
} from "viem";
import { ERC20_ABI } from "./constants.js";
import { ToolError, toToolError, type NextAction } from "./errors.js";
import { getToken, isNativeSentinel, NATIVE_TOKEN } from "./tokens.js";
import { waitForReceiptWithTimeout } from "./receipt.js";
import { withAccountLock, accountLockKey } from "./accountLock.js";
import { simulateTx, type SimulationResult } from "./simulate.js";
import { enforceSafety, enforcePreflightSafety } from "./safety.js";
import { getCurrentPrice } from "./price.js";
import { assertAddressEIP55, type ChainProfile } from "./chains.js";
import type { Config } from "./config.js";
import { sanitizeForLogLine, type Logger } from "./logger.js";

export interface TransferRequest {
  /** Token address, "ETH"/"NATIVE", or the native sentinel. */
  token: Address | "ETH";
  /** Recipient address. */
  to: Address;
  /** Decimal amount (e.g. "0.001"). Resolved against the token's decimals. */
  amount: string;
  /** If true, simulate only. */
  simulate?: boolean;
  /** Free-form note recorded alongside the transfer row (same shape as trade.ts). */
  note?: string;
  /** Iter355: explicit opt-in for sending to the zero address (a permanent burn). */
  allowBurn?: boolean;
}

export interface TransferContext {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
  profile: ChainProfile;
  config: Config;
  logger: Logger;
  accountLabel: string;
}

export interface TransferResult {
  ok: boolean;
  simulated: boolean;
  /** ISO timestamp when the transfer was executed (or simulated). */
  timestamp: string;
  token: Address;
  symbol: string;
  to: Address;
  amount: string;
  /** USD value of the transfer (best-effort). */
  estimatedUsd?: number;
  /** Fraction of the sender's balance this transfer consumes (0..1). >0.5 deserves a glance. */
  balanceFraction?: number;
  /** Iter407: when "max" was used on a native transfer, the amount we reserved for gas
   *  (decimal native units). Lets --json consumers know what was held back without
   *  parsing the iter325 info log. Absent for ERC20 max (no reserve needed) and for
   *  explicit-amount transfers. */
  gasReserveNative?: string;
  isNative: boolean;
  txHash?: `0x${string}`;
  status?: "success" | "failed";
  gasUsed?: string;
  gasCostNative?: string;
  /** Gas cost in USD (best-effort; null when native-token price isn't known). */
  gasCostUsd?: number;
  simulation?: SimulationResult;
  /** Block-explorer URL for the tx, populated whenever a hash exists (success OR
   *  revert). Iter483 parity with trade.ts iter482 — pre-iter483 the URL only
   *  appeared inside decoded.explorerUrl, which is only computed on success, so a
   *  reverted transfer left the operator with a bare hash. */
  explorerUrl?: string;
  decoded?: import("./decodeTx.js").DecodedTx;
  nextActions?: NextAction[];
  /** Iter677: persisted revert reason when status=failed and the eth_call
   *  replay extracted it. Mirrors AnalyzedTrade.revertReason. Operators
   *  (agents) can branch on this without re-querying the row. */
  revertReason?: string;
  /** Iter678: address-book lookup result for the recipient. Surfaced on
   *  both simulate and real-send paths so the operator sees the signal
   *  BEFORE committing the send. `label` is the @alias when found; absent
   *  means the recipient isn't in the book. Combined with the boolean
   *  flag so consumers can distinguish "looked up — known" from "looked
   *  up — unknown" vs "lookup wasn't done" (book missing / IO error).
   *  Iter680: `recipientNote` carries the entry's free-form note when
   *  present (e.g. "Coinbase deposit", "Cold wallet 2/3 multisig"). */
  recipientIsKnown?: boolean;
  recipientLabel?: string;
  recipientNote?: string;
  /** Iter683: predictive failure pattern for transfers to THIS recipient on
   *  this chain. Mirrors TradeResult.recentFailurePattern (iter682). Surfaced
   *  on both simulate and real-send paths so operators get the historical
   *  context before committing. Only populated when there are ≥3 failures in
   *  the last 7d AND a dominant reason has ≥50% share. */
  recentFailurePattern?: {
    total: number;
    windowDays: number;
    dominantReason: string;
    dominantCount: number;
    /** Iter700: see TradeResult.recentFailurePattern.dominantLastSeen. */
    dominantLastSeen?: string;
    /** Iter686: structured next actions derived from classifyReason. Same
     *  shape as TradeResult.recentFailurePattern.suggestedActions. */
    suggestedActions?: NextAction[];
  };
  /** Iter916: wall-clock from executeTransferInner entry to return. Mirrors
   *  iter915 TradeResult.elapsedMs + the rest of the MCP tool convention.
   *  Best-effort; absent on paths that haven't been timed (none currently). */
  elapsedMs?: number;
}

/**
 * Send an ERC20 token or the chain's native asset.
 *
 * Safety: routes through the same enforceSafety() used for swaps so per-tx / daily USD
 * limits and token blacklist apply uniformly. We deliberately do NOT enforce the
 * contractWhitelist on `to` — a transfer's recipient is the END USER, not an aggregator
 * contract, and whitelisting end-user addresses is impractical.
 *
 * Recipients are required to be checksum-valid; common typos (no leading 0x, wrong length)
 * fail with INVALID_PARAMS before any network call.
 */
export async function executeTransfer(req: TransferRequest, ctx: TransferContext): Promise<TransferResult> {
  // Simulations are read-only and never debit the daily USD bucket, so we don't lock
  // them. Real transfers share the same dailyUsdVolume budget as trades and must
  // serialize per-account — otherwise a parallel trade+transfer can both pass the
  // safety gate before either has inserted its DB row.
  if (req.simulate) return executeTransferInner(req, ctx);
  return withAccountLock(accountLockKey(ctx.accountLabel), () => executeTransferInner(req, ctx));
}

async function executeTransferInner(req: TransferRequest, ctx: TransferContext): Promise<TransferResult> {
  // Iter916: wall-clock for transfer (matches iter915 trade.elapsedMs +
  // MCP-tool convention). Receipt wait dominates real-send latency; agents
  // tailing transfers in batch flows get uniform timing visibility.
  const t0 = Date.now();
  // 1. Validate recipient (iter292: via the shared assertAddressEIP55 helper).
  // Original iter256 rationale: transfers are irreversible — a single-char typo in
  // a checksummed address pasted from a block explorer should be caught HERE, not
  // after the funds are gone. Lowercase-as-escape-hatch is preserved.
  assertAddressEIP55("recipient", req.to);
  const recipient = getAddress(req.to);

  // Self-transfer is a common copy-paste mistake. ERC20 self-send is a no-op for
  // balances (just burns gas); native self-send is similarly pointless. For the
  // multi-account-funding case the operator should use `--account <other-label>` to
  // route from a different HD index, then transfer to the current wallet — that's
  // the only legitimate "send-to-self" workflow this tool supports.
  if (recipient.toLowerCase() === ctx.walletClient.account.address.toLowerCase()) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Recipient equals the sender's address. Self-transfer would only burn gas. If you meant to move between HD accounts, run from the other account via --account <label>.",
      {
        details: { recipient, sender: ctx.walletClient.account.address },
        nextActions: [
          {
            tool: "accounts",
            params: { action: "list" },
            reason: "List HD accounts to pick a different sender — then re-call transfer from that account (CLI: `tradekit account list`, then `tradekit transfer --account <other-label> ...`).",
          },
        ],
      },
    );
  }
  // Iter355: zero-address transfers permanently burn the tokens. EIP-55 happily
  // accepts 0x0000…0000 as a valid address (it's all-lowercase ⇒ checksum-not-
  // specified per spec), so a single-keystroke typo of all zeros silently sails
  // through to a real on-chain burn. The catastrophic-by-default case is far more
  // common than legitimate burning via this tool; require explicit `--burn` to
  // acknowledge. Same opt-in friction discipline as walletExport (iter106's --yes).
  // 0xdead and project-specific burn addresses look like real addresses and aren't
  // detected — operators using those have made a deliberate choice; the zero
  // address is the one that gets typed by accident.
  if (recipient === "0x0000000000000000000000000000000000000000") {
    if (req.allowBurn !== true) {
      throw new ToolError(
        "INVALID_PARAMS",
        "Recipient is the zero address — this would permanently BURN the tokens. If that's intentional, pass --burn (CLI) or allowBurn: true (MCP/web). Did you mean to paste a different address?",
        { details: { recipient } },
      );
    }
    ctx.logger.warn("transfer → burning tokens to 0x0 (allowBurn=true acknowledged)");
  }

  // Iter678: address-book lookup for the recipient. Performed BEFORE the
  // simulate-vs-real branch so both paths surface the signal — operators
  // running `quote`/`simulate=true` should see "first-time recipient" on
  // the dry-run before they commit. Best-effort: file IO failure falls
  // through with the fields undefined (matches "lookup not performed").
  let recipientIsKnown: boolean | undefined;
  let recipientLabel: string | undefined;
  let recipientNote: string | undefined;
  try {
    const { loadAddressBook, findByAddress } = await import("./addressBook.js");
    const book = loadAddressBook();
    const entry = findByAddress(book, recipient);
    recipientIsKnown = entry != null;
    if (entry) {
      recipientLabel = entry.name;
      // Iter680: surface the address-book note inline. Operators who labeled
      // "@coinbase-deposit-arbitrum (corporate treasury hot wallet, rotated
      // 2026-01)" should see the note RIGHT THERE at send time.
      if (entry.note) recipientNote = entry.note;
    }
  } catch (e) {
    ctx.logger.debug(`iter678 address-book lookup failed: ${(e as Error).message}`);
  }

  // Iter683: predictive failure pattern check — same shape as iter682's
  // trade-flow check but scoped to "transfers from this account to this
  // recipient". Surfaces "your last 3 transfers to this address all
  // reverted with X" before committing the next one.
  let recentFailurePattern: TransferResult["recentFailurePattern"];
  try {
    const { recentRecipientFailureHistogram } = await import("./db.js");
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const pattern = recentRecipientFailureHistogram({
      chain: ctx.profile.name,
      account: ctx.accountLabel,
      recipient,
      sinceIso: sevenDaysAgo,
    });
    if (pattern.total >= 3) {
      const dominant = pattern.reasons.find(
        (r) => r.reason !== "(unknown)" && r.count >= Math.ceil(pattern.total / 2),
      );
      if (dominant) {
        // Iter686: same classifyReason wiring as the trade flow.
        const { classifyReason } = await import("./errors.js");
        const classified = classifyReason(dominant.reason);
        recentFailurePattern = {
          total: pattern.total,
          windowDays: 7,
          dominantReason: dominant.reason,
          dominantCount: dominant.count,
          // Iter700: dominant reason's most-recent timestamp.
          ...(dominant.lastSeen ? { dominantLastSeen: dominant.lastSeen } : {}),
          ...(classified?.nextActions ? { suggestedActions: classified.nextActions } : {}),
        };
        const lastBit = dominant.lastSeen ? ` (last: ${dominant.lastSeen.slice(0, 16).replace("T", " ")})` : "";
        ctx.logger.warn(
          `⚠ Recent failure pattern on transfers to ${recipient}: ${dominant.count}/${pattern.total} failed in last 7d with "${dominant.reason}"${lastBit}.`,
        );
      }
    }
  } catch (e) {
    ctx.logger.debug(`iter683 pattern check failed: ${(e as Error).message}`);
  }

  // 2. Resolve token
  const isNative =
    req.token === "ETH" ||
    (typeof req.token === "string" && req.token.toUpperCase() === "ETH") ||
    (typeof req.token === "string" && req.token.toUpperCase() === "NATIVE") ||
    (typeof req.token === "string" && isNativeSentinel(req.token as Address));
  const tokenAddr: Address = isNative ? NATIVE_TOKEN : (req.token as Address);
  const meta = isNative
    ? { address: NATIVE_TOKEN, decimals: 18, symbol: ctx.profile.nativeSymbol, isNative: true, chainId: ctx.profile.chainId }
    : await getToken(ctx.publicClient, ctx.profile, tokenAddr);

  // Read the sender's balance ONCE — used both for "max" sizing AND the pre-flight
  // sufficiency check below. (Previously this was 2 separate reads in series on the
  // max path, and the native path additionally serialized getBalance → estimateFeesPerGas.)
  const balanceP: Promise<bigint> = isNative
    ? ctx.publicClient.getBalance({ address: ctx.walletClient.account.address }).catch(() => 0n)
    : (ctx.publicClient
        .readContract({
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [ctx.walletClient.account.address],
        })
        .catch(() => 0n) as Promise<bigint>);

  let amountRaw: bigint;
  let preBal: bigint;
  // Iter407: capture the reserve so the result can carry it back to --json consumers
  // (the info log from iter325 covers human/text mode but JSON scripts couldn't see
  // what was held back).
  let gasReserveNative: string | undefined;
  if (req.amount.toLowerCase() === "max") {
    if (isNative) {
      // Balance + fees in parallel — independent reads; doing them sequentially used
      // to add ~2 RPC roundtrips of latency to every native "max" send.
      const [bal, fees] = await Promise.all([
        balanceP,
        ctx.publicClient.estimateFeesPerGas().catch(() => null),
      ]);
      let gasPriceWei = fees?.maxFeePerGas ?? fees?.gasPrice ?? 0n;
      if (gasPriceWei === 0n) {
        try { gasPriceWei = await ctx.publicClient.getGasPrice(); } catch { /* keep 0 */ }
      }
      // Reserve = ~21000 (simple send) * estimated maxFee per gas, with a 2x safety multiplier.
      const reserve = 21000n * gasPriceWei * 2n;
      gasReserveNative = formatEther(reserve);
      amountRaw = bal > reserve ? bal - reserve : 0n;
      if (amountRaw === 0n) {
        throw new ToolError(
          "INSUFFICIENT_BALANCE",
          `Native balance ${formatEther(bal)} is below the gas reserve (${formatEther(reserve)}). Nothing to send.`,
          {
            details: {
              have: formatEther(bal),
              need: formatEther(reserve),
              symbol: meta.symbol,
              balance: formatEther(bal),
              reserve: formatEther(reserve),
            },
            nextActions: [
              {
                tool: "holdings",
                params: { chains: [ctx.profile.name], account: ctx.accountLabel },
                reason: `Check the native balance — run \`tradekit holdings --chains ${ctx.profile.name} --account ${ctx.accountLabel}\` to see the gas budget, then top up so a send covers gas plus the desired amount.`,
              },
            ],
          },
        );
      }
      preBal = bal;
      req = { ...req, amount: formatUnits(amountRaw, meta.decimals) };
      // Iter325: surface the reserve so operators understand WHY the sent amount is
      // less than their full balance. Pre-iter325 the silent reservation looked like
      // "the tool lost some of my ETH" — info-level log is enough for --verbose; the
      // result struct keeps the adjusted amount only (it's what actually went).
      ctx.logger.info(
        `transfer max → reserved ${formatEther(reserve)} ${meta.symbol} for gas; sending ${formatUnits(amountRaw, meta.decimals)} (full balance was ${formatEther(bal)}).`,
      );
    } else {
      const bal = await balanceP;
      if (bal === 0n) {
        throw new ToolError(
          "INSUFFICIENT_BALANCE",
          `Zero balance of ${meta.symbol}; nothing to send.`,
          {
            details: { have: "0", need: "any positive amount", symbol: meta.symbol },
            nextActions: [
              {
                tool: "holdings",
                params: { chains: [ctx.profile.name], account: ctx.accountLabel },
                reason: `Check the token balance — run \`tradekit holdings --chains ${ctx.profile.name} --account ${ctx.accountLabel}\` to see what's actually held on this chain, then transfer in or pick a different token.`,
              },
            ],
          },
        );
      }
      amountRaw = bal;
      preBal = bal;
      req = { ...req, amount: formatUnits(amountRaw, meta.decimals) };
    }
  } else {
    amountRaw = parseUnits(req.amount, meta.decimals);
    // Iter281: same rounds-to-0 guard as iter280 (trade.ts). parseUnits("0.0000001", 6)
    // returns 0n — looks positive at the decimal level but flows zero raw units to the
    // chain. Differentiate "user typed a negative number" from "too small to represent."
    if (amountRaw < 0n) {
      throw new ToolError(
        "INVALID_PARAMS",
        `Amount must be positive (got ${req.amount}).`,
        { details: { providedAmount: req.amount, symbol: meta.symbol } },
      );
    }
    if (amountRaw === 0n) {
      const minRepresentable = formatUnits(1n, meta.decimals);
      throw new ToolError(
        "INVALID_PARAMS",
        `Amount "${req.amount}" rounds to 0 raw units at ${meta.decimals} decimals — too small to send. Use at least the minimum representable amount (${minRepresentable}).`,
        {
          details: { providedAmount: req.amount, decimals: meta.decimals, minRepresentable, symbol: meta.symbol },
          nextActions: [
            {
              tool: "transfer",
              params: { amount: minRepresentable },
              reason: `Re-call transfer with at least ${minRepresentable} ${meta.symbol} (CLI: \`tradekit transfer --amount ${minRepresentable} ...\`).`,
            },
          ],
        },
      );
    }
    // For non-max we still need the balance for the sufficiency check + balanceFraction.
    preBal = await balanceP;
    if (preBal < amountRaw) {
      throw new ToolError(
        "INSUFFICIENT_BALANCE",
        isNative
          ? `Not enough native balance: have ${formatEther(preBal)} ${meta.symbol}, sending ${req.amount}.`
          : `Not enough ${meta.symbol}: have ${formatUnits(preBal, meta.decimals)}, sending ${req.amount}.`,
        {
          details: {
            have: isNative ? formatEther(preBal) : formatUnits(preBal, meta.decimals),
            need: req.amount,
            symbol: meta.symbol,
          },
          // Iter496: scoped holdings hint — same iter495 pattern that trade.ts uses,
          // so an agent recovering from INSUFFICIENT_BALANCE on transfer gets the
          // same actionable next-step shape. Cross-surface tool name (CLI / MCP / web).
          nextActions: [
            {
              tool: "holdings",
              params: { chains: [ctx.profile.name], account: ctx.accountLabel },
              // Iter508: same copy-paste CLI form as trade.ts iter495 — CLI text
              // mode only renders tool + reason, so the command line goes in the
              // reason for CLI users; MCP / web agents read params.
              reason: `Check the token balance — run \`tradekit holdings --chains ${ctx.profile.name} --account ${ctx.accountLabel}\` to see balances on this chain, then top up or reduce the amount.`,
            },
          ],
        },
      );
    }
  }
  const balanceFraction = preBal > 0n
    ? parseFloat(formatUnits(amountRaw, meta.decimals)) / parseFloat(formatUnits(preBal, meta.decimals))
    : undefined;

  // Iter412: pre-flight the token whitelist/blacklist check before the price lookup
  // below — same defense-in-depth pattern iter403/404/405 added for trade.ts. The
  // full enforceSafety still runs at step 5 (per-tx + daily USD limits need estimatedUsd
  // and depend on the price lookup), but a blacklisted token shouldn't waste an HTTP
  // roundtrip to coingecko/dexscreener. slippageBps is hardcoded 0 here since transfers
  // have no slippage — the slippage cap inside enforcePreflightSafety is then a no-op.
  // Iter425: static import — same module is already imported at top of file for
  // enforceSafety, dynamic import was needless overhead.
  enforcePreflightSafety(
    { chain: ctx.profile.name, tokenIn: tokenAddr, tokenOut: tokenAddr, slippageBps: 0 },
    ctx.config,
    ctx.logger,
  );

  // 4. USD estimate for safety limits + native USD for gas-cost conversion.
  // When the token IS the native asset we only need one price; otherwise fetch both
  // in parallel so gas-USD conversion doesn't add latency.
  let estimatedUsd: number | undefined;
  let nativeUsd: number | null = null;
  try {
    if (isNative) {
      const px = await getCurrentPrice(ctx.profile.weth, ctx.logger);
      if (px != null) {
        estimatedUsd = parseFloat(req.amount) * px;
        nativeUsd = px;
      }
    } else {
      const [tokenPx, nativePx] = await Promise.all([
        getCurrentPrice(tokenAddr, ctx.logger).catch(() => null),
        getCurrentPrice(ctx.profile.weth, ctx.logger).catch(() => null),
      ]);
      if (tokenPx != null) estimatedUsd = parseFloat(req.amount) * tokenPx;
      nativeUsd = nativePx;
    }
  } catch {
    /* best-effort */
  }

  // 5. Safety check. tokenIn=tokenOut=token (so token whitelist/blacklist still
  // applies to the transferred asset). Iter318: pass isTransferRecipient=true so
  // the contractWhitelist (which gates router contracts for swaps) is bypassed —
  // the recipient is an EOA, not a router, and locking down recipient EOAs is not
  // the documented intent of that policy.
  enforceSafety(
    {
      chain: ctx.profile.name,
      account: ctx.accountLabel,
      tokenIn: tokenAddr,
      tokenOut: tokenAddr,
      toContract: recipient,
      estimatedUsd,
      slippageBps: 0, // transfers have no slippage
      isTransferRecipient: true,
    },
    ctx.config,
    ctx.logger,
  );

  // 5a. Portfolio-aware position limits (same hook as the trade flow).
  // A transfer removes value from the sent token — so min-floor limits
  // ("always keep ≥ 10% in USDC") fire when a transfer would deplete the
  // reserve. Max-cap limits never fire on a transfer (transfers don't
  // increase any token's share except by removing others). Skipped when
  // estimatedUsd isn't available (same posture as the per-tx USD limit).
  if (ctx.config.safety.positionLimits && ctx.config.safety.positionLimits.length > 0) {
    const { enforcePositionLimits, deltaForTransfer } = await import("./positionLimits.js");
    const delta = deltaForTransfer({
      chain: ctx.profile.name,
      estimatedUsd,
      tokenAddress: isNative ? "NATIVE" : tokenAddr,
      tokenIsNative: isNative,
    });
    await enforcePositionLimits({
      chain: ctx.profile.name,
      delta,
      config: ctx.config,
      logger: ctx.logger,
      fetchPortfolio: async () => {
        const { holdingsOnChain, holdingsMultiChain } = await import("./holdings.js");
        const { chainHoldingsToSnapshot } = await import("./positionLimits.js");
        const limits = ctx.config.safety.positionLimits!;
        const hasWildcard = limits.some((l) => l.chain === "*");
        const owner = ctx.walletClient.account.address;
        let reports: import("./holdings.js").ChainHoldings[];
        if (hasWildcard) {
          const multi = await holdingsMultiChain(owner, ctx.config, ctx.logger);
          reports = multi.reports;
        } else {
          reports = [await holdingsOnChain(owner, ctx.profile.name, ctx.config, ctx.logger)];
        }
        return chainHoldingsToSnapshot(reports);
      },
    });
  }

  // 6. Build the tx
  let data: `0x${string}` = "0x";
  let value: bigint = 0n;
  let to: Address;
  if (isNative) {
    to = recipient;
    value = amountRaw;
  } else {
    to = tokenAddr;
    // encodeFunctionData(transfer(to, amount))
    // Iter426: was a dynamic import — viem is already statically imported at the top
    // of this file for getAddress / parseUnits / formatEther; pulling encodeFunctionData
    // through the dynamic loader added overhead with no isolation benefit.
    data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [recipient, amountRaw],
    });
  }

  // 7. Simulate
  const simulation = req.simulate
    ? await simulateTx({
        publicClient: ctx.publicClient,
        from: ctx.walletClient.account.address,
        to,
        data,
        value,
        logger: ctx.logger,
      }).catch((e) => {
        // Iter476: sanitize before logging (iter474 helper) — viem multi-line.
        ctx.logger.error(sanitizeForLogLine(`transfer simulate failed: ${(e as Error).message}`));
        return undefined;
      })
    : undefined;

  if (req.simulate) {
    let simGasUsd: number | undefined;
    if (simulation?.gasCostNative && nativeUsd != null) {
      const n = parseFloat(simulation.gasCostNative);
      if (Number.isFinite(n)) simGasUsd = n * nativeUsd;
    }
    return {
      ok: simulation?.ok !== false,
      simulated: true,
      timestamp: new Date().toISOString(),
      token: tokenAddr,
      symbol: meta.symbol,
      to: recipient,
      amount: req.amount,
      estimatedUsd,
      balanceFraction,
      gasReserveNative,
      isNative,
      simulation,
      gasCostUsd: simGasUsd,
      ...(recipientIsKnown !== undefined ? { recipientIsKnown } : {}),
      ...(recipientLabel ? { recipientLabel } : {}),
      ...(recipientNote ? { recipientNote } : {}),
      ...(recentFailurePattern ? { recentFailurePattern } : {}),
      elapsedMs: Date.now() - t0,
    };
  }

  // 8. Send
  let txHash: `0x${string}`;
  try {
    if (isNative) {
      txHash = await ctx.walletClient.sendTransaction({ to: recipient, value });
    } else {
      txHash = await ctx.walletClient.writeContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [recipient, amountRaw],
      });
    }
    ctx.logger.info(`Transfer tx sent: ${txHash}`);
  } catch (e) {
    throw toToolError(e, "TX_REVERTED");
  }

  // Persist the transfer in the trades DB so dailyUsdVolume picks it up — without
  // this, multiple transfers each pass the daily-USD safety check independently and
  // the budget cap is silently bypassed. aggregator="transfer" is the sentinel that
  // tells pnl.aggregateTrades to skip these rows (they aren't swaps).
  const recordTransferRow = (
    status: "success" | "failed" | "pending",
    gasUsed: string | null,
    gasCostNative: string | null,
    // Iter677: revert reason for direct-failure transfers (parallel to iter676's
    // trade.ts change). Pre-iter677 a failed transfer's row had NULL
    // revert_reason and the only path to "why" was the explorer URL.
    blockNumber: number | null = null,
    revertReason: string | null = null,
  ) => {
    try {
      ctx.logger.recordTrade({
        timestamp: new Date().toISOString(),
        chain: ctx.profile.name,
        account: ctx.accountLabel,
        direction: "sell",
        base_token: tokenAddr,
        base_symbol: meta.symbol,
        base_amount: req.amount,
        quote_token: "",
        quote_symbol: "USD",
        quote_amount: (estimatedUsd ?? 0).toString(),
        price: "0",
        tx_hash: txHash,
        status,
        gas_used: gasUsed,
        gas_price_wei: null,
        gas_cost_native: gasCostNative,
        aggregator: "transfer",
        fee_tier: null,
        notes: req.note
          ? `${req.note}  •  transfer to ${recipient}`
          : `transfer to ${recipient}`,
        block_number: blockNumber,
        revert_reason: revertReason,
      });
    } catch (e) {
      // Iter476: sanitize before logging — DB error messages from node:sqlite are
      // usually one line, but the iter474 helper protects against future format
      // changes that could include newlines.
      ctx.logger.error(sanitizeForLogLine(
        `Transfer persisted on-chain but DB write failed: ${txHash} status=${status}. ` +
          `Cause: ${(e as Error).message}`,
      ));
    }
  };

  let receipt: Awaited<ReturnType<typeof waitForReceiptWithTimeout>>;
  try {
    receipt = await waitForReceiptWithTimeout(ctx.publicClient, txHash, ctx.profile);
  } catch (e) {
    // Same pattern as trade.ts: tx is broadcast; record as pending so the daily budget
    // accounts for it even if the receipt times out, then propagate the timeout.
    recordTransferRow("pending", null, null);
    throw e;
  }
  const status: "success" | "failed" = receipt.status === "success" ? "success" : "failed";
  const gasUsed = receipt.gasUsed.toString();
  const gasCostNative = formatEther(receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n));
  let gasCostUsd: number | undefined;
  if (nativeUsd != null) {
    const n = parseFloat(gasCostNative);
    if (Number.isFinite(n)) gasCostUsd = n * nativeUsd;
  }
  // Iter677: extract revert reason at execute time for failed transfers
  // (parallel to iter676 trade.ts change). Best-effort — never block the
  // transfer record on the enrichment. Transfers are high-stakes and
  // operators want to know WHY a fund move failed without leaving tradekit.
  let directFailRevertReason: string | null = null;
  const blockNumber = receipt.blockNumber != null ? Number(receipt.blockNumber) : null;
  if (status === "failed" && blockNumber != null) {
    try {
      const { extractRevertReasonByHash } = await import("./tradeAnalysis.js");
      const reason = await extractRevertReasonByHash({
        publicClient: ctx.publicClient,
        txHash,
        blockNumber,
        logger: ctx.logger,
      });
      if (reason) directFailRevertReason = reason;
    } catch (e) {
      ctx.logger.debug(`iter677 revert-reason extraction failed: ${(e as Error).message}`);
    }
  }
  recordTransferRow(status, gasUsed, gasCostNative, blockNumber, directFailRevertReason);

  // 9. Auto-decode (matches the swap flow's post-trade verification). Pass the
  // already-fetched receipt so decodeTx skips its own getTransactionReceipt call.
  let decoded: import("./decodeTx.js").DecodedTx | undefined;
  if (status === "success") {
    try {
      const { decodeTx } = await import("./decodeTx.js");
      decoded = await decodeTx(ctx.publicClient, ctx.profile, txHash, receipt);
    } catch (e) {
      ctx.logger.debug(`post-transfer decode failed: ${(e as Error).message}`);
    }
  }

  return {
    ok: status === "success",
    simulated: false,
    timestamp: new Date().toISOString(),
    token: tokenAddr,
    symbol: meta.symbol,
    to: recipient,
    amount: req.amount,
    estimatedUsd,
    balanceFraction,
    gasReserveNative,
    isNative,
    txHash,
    status,
    gasUsed,
    gasCostNative,
    gasCostUsd,
    explorerUrl: ctx.profile.explorer ? `${ctx.profile.explorer}/tx/${txHash}` : undefined,
    decoded,
    // Iter677: surface the extracted revert reason on the result so MCP /
    // CLI consumers don't have to re-query the row.
    ...(directFailRevertReason ? { revertReason: directFailRevertReason } : {}),
    // Iter678/iter680: same address-book signal on the real-send result.
    ...(recipientIsKnown !== undefined ? { recipientIsKnown } : {}),
    ...(recipientLabel ? { recipientLabel } : {}),
    ...(recipientNote ? { recipientNote } : {}),
    // Iter683: predictive failure pattern on real-send result.
    ...(recentFailurePattern ? { recentFailurePattern } : {}),
    // Iter494: same explorerUrl-field-not-"above" wording fix as trade.ts.
    // Iter513: same CLI-command-in-reason convention as trade.ts iter513.
    // Iter531: add chain to params (trade.ts parity) — MCP agents dispatching
    // viewTx without explicit chain default to activeChain, which may have changed
    // since the transfer ran.
    // Iter677: when we already captured the revert reason, the nextAction
    // message stops pointing to the explorerUrl (the reason is right here);
    // viewTx is still useful for confirming token deltas.
    nextActions: status === "failed"
      ? [{
          tool: "viewTx",
          params: { txHash, chain: ctx.profile.name },
          reason: directFailRevertReason
            ? `Transfer reverted: ${directFailRevertReason}. Run \`tradekit viewTx ${txHash} --chain ${ctx.profile.name}\` to confirm there were no partial token movements before the revert.`
            : `Re-confirm the failed status + token deltas — run \`tradekit viewTx ${txHash} --chain ${ctx.profile.name}\`. For the on-chain revert reason, open the explorerUrl field of this result.`,
        }]
      : undefined,
    elapsedMs: Date.now() - t0,
  };
}
