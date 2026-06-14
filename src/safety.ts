import { maxUint256, type Address } from "viem";
import { ToolError } from "./errors.js";
import type { Config } from "./config.js";
import { dailyUsdVolume } from "./db.js";
import type { Logger } from "./logger.js";

export interface SafetyCheckInput {
  chain: string;
  account: string;
  tokenIn: Address;
  tokenOut: Address;
  /** Contract that will be called (aggregator router / SwapRouter). */
  toContract: Address;
  /** Estimated USD value of the trade (positive). May be omitted when unknown — limits then skipped. */
  estimatedUsd?: number;
  /** Slippage in basis points the trade is requesting. */
  slippageBps: number;
  /**
   * When true, skip the contractWhitelist check on `toContract`. Used by transfers
   * where `toContract` is an EOA recipient (not an aggregator router) — the
   * whitelist is meant to gate router/spender contracts for swaps, not lock down
   * who an operator can send funds to. Iter318: pre-iter318 transfer.ts's comment
   * claimed this skip happened but the code didn't actually implement it; an
   * operator with contractWhitelist set would have transfers rejected against the
   * router list, which was never the intent.
   */
  isTransferRecipient?: boolean;
}

function lowerSet(addrs: readonly string[] | undefined): Set<string> | undefined {
  return addrs ? new Set(addrs.map((a) => a.toLowerCase())) : undefined;
}

/**
 * Case-insensitive lookup on a chain-keyed record. The CLI/MCP config commands
 * normalize chain names to lowercase (iter95), but users who hand-edit the JSON
 * config sometimes write "Base" or "Arbitrum". profile.name is canonical-lowercase,
 * so a raw `rec[chain]` would miss those entries. Walk the keys once.
 */
function chainLookup<T>(rec: Record<string, T> | undefined, chain: string): T | undefined {
  if (!rec) return undefined;
  if (rec[chain] !== undefined) return rec[chain];
  const lc = chain.toLowerCase();
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lc) return rec[k];
  }
  return undefined;
}

/**
 * Iter405: extracted the "cheap" subset of safety checks — slippage cap + token
 * whitelist/blacklist — so trade.ts can run them BEFORE the aggregator HTTP roundtrip
 * (iter403/404). Both checks are pure config-vs-input comparisons that don't need
 * any aggregator info. The full enforceSafety runs all 5 checks; this runs just the
 * first 2. enforceSafety calls this helper at its head, so the canonical
 * implementation lives in one place and trade.ts's pre-flight uses the same code.
 *
 * Input shape is the same SafetyCheckInput minus the contract / USD fields, which
 * the cheap checks don't reference.
 */
export function enforcePreflightSafety(
  input: Pick<SafetyCheckInput, "chain" | "tokenIn" | "tokenOut" | "slippageBps">,
  config: Config,
  logger: Logger,
): void {
  const s = config.safety;
  if (!s.enabled) {
    logger.debug("Safety disabled — skipping guardrails");
    return;
  }

  // 1. Slippage cap
  if (input.slippageBps > s.maxSlippageBps) {
    throw new ToolError(
      "SLIPPAGE_TOO_HIGH",
      `Requested slippage ${input.slippageBps} bps exceeds safety cap ${s.maxSlippageBps} bps.`,
      {
        details: { requested: input.slippageBps, cap: s.maxSlippageBps },
        nextActions: [
          {
            // Iter587: pre-iter587 this dispatched to a `trade` umbrella that didn't
            // resolve to any real tool (no MCP tool by that name; CLI's `trade` takes
            // a positional buy|sell). The agent reading this nextAction had no
            // dispatch target. Use `quote` instead: it's the canonical pre-flight tool,
            // it's read-only (no funds at risk if the agent dispatches automatically),
            // and a successful quote confirms the resized slippageBps is acceptable
            // before the agent then calls buy/sell. The reason text already names the
            // actual retry path.
            tool: "quote",
            params: { slippageBps: s.maxSlippageBps },
            reason: `Retry the trade with slippage at or below the configured cap of ${s.maxSlippageBps} bps. Quote first to verify the new params, then call buy/sell. CLI: \`tradekit trade <buy|sell> --slippage ${s.maxSlippageBps} ...\`; MCP: call buy/sell with slippageBps=${s.maxSlippageBps}.`,
          },
        ],
      },
    );
  }

  // 2. Token whitelist / blacklist
  const tokensIn = [input.tokenIn.toLowerCase(), input.tokenOut.toLowerCase()];
  const whitelist = lowerSet(chainLookup(s.tokenWhitelist, input.chain));
  if (whitelist && whitelist.size > 0) {
    for (const t of tokensIn) {
      if (!whitelist.has(t)) {
        // Include the whitelist + recovery hint, mirroring the contract-whitelist
        // block below. Pre-iter183 the operator/agent saw only "Token X not in
        // whitelist" with no info on what's allowed or how to add it.
        throw new ToolError("TOKEN_BLOCKED", `Token ${t} not in whitelist for chain "${input.chain}".`, {
          details: { token: t, chain: input.chain, whitelist: [...whitelist] },
          nextActions: [
            {
              tool: "config",
              params: { action: "push", path: `safety.tokenWhitelist.${input.chain}`, value: t },
              // Iter512: embed the copy-paste CLI form (iter435/508 convention).
              // The bare reason left a CLI user to translate { action, path, value }
              // into `tradekit config push <path> <value>` mentally.
              reason: `Add this token to the whitelist if you trust it — run \`tradekit config push safety.tokenWhitelist.${input.chain} ${t}\`.`,
            },
          ],
        });
      }
    }
  }
  const blacklist = lowerSet(chainLookup(s.tokenBlacklist, input.chain));
  if (blacklist) {
    for (const t of tokensIn) {
      if (blacklist.has(t)) {
        throw new ToolError("TOKEN_BLOCKED", `Token ${t} is blacklisted on chain "${input.chain}".`, {
          details: { token: t, chain: input.chain, blacklist: [...blacklist] },
          // Deliberately NO nextAction here: blacklisted = the operator explicitly
          // chose to refuse this token. Auto-suggesting "remove from blacklist" would
          // be backwards. They can drop it manually via `config drop` if needed.
        });
      }
    }
  }
}

/**
 * Enforce all configured guardrails. Throws ToolError with code SAFEGUARD_TRIGGERED or
 * a more specific safety code when blocked. Returns silently when all checks pass.
 */
export function enforceSafety(input: SafetyCheckInput, config: Config, logger: Logger): void {
  // Iter405: the first two checks (slippage + tokens) live in enforcePreflightSafety
  // now so callers like trade.ts can run them before the aggregator HTTP roundtrip.
  // Calling it here keeps enforceSafety's contract — "all 5 checks run" — intact.
  enforcePreflightSafety(input, config, logger);
  const s = config.safety;
  if (!s.enabled) return; // already logged by preflight

  // 3. Contract whitelist — applies to swap target contracts (aggregator routers /
  // SwapRouter). Iter318: skip for transfers, where `toContract` is an EOA recipient
  // — the whitelist semantic is "trusted routers/spenders," not "allowed payees."
  const contracts = lowerSet(chainLookup(s.contractWhitelist, input.chain));
  if (!input.isTransferRecipient && contracts && contracts.size > 0) {
    if (!contracts.has(input.toContract.toLowerCase())) {
      throw new ToolError(
        "CONTRACT_BLOCKED",
        `Target contract ${input.toContract} is not in the whitelist for chain "${input.chain}".`,
        {
          details: { contract: input.toContract, chain: input.chain, whitelist: [...contracts] },
          nextActions: [
            {
              // The CLI command is `tradekit config push <path> <value>` and the MCP
              // config tool uses path/value too — match those parameter names so an
              // agent can mechanically invoke the suggested action.
              tool: "config",
              params: {
                action: "push",
                path: `safety.contractWhitelist.${input.chain}`,
                value: input.toContract,
              },
              // Iter512: same copy-paste CLI form as the token-whitelist hint above.
              reason: `Add this contract to the whitelist if you trust it — run \`tradekit config push safety.contractWhitelist.${input.chain} ${input.toContract}\`.`,
            },
          ],
        },
      );
    }
  }

  // 4. Per-tx USD limit
  // Silent bypass hole: if estimatedUsd is null (price API down, brand-new token with no
  // DexScreener listing) BOTH the per-tx AND daily limits skip. The trade still goes
  // through the slippage cap + blacklist + contract whitelist, but the dollar guardrails
  // are off. Surface this loudly when USD limits are configured so the operator notices.
  if (input.estimatedUsd == null && (s.perTxUsdLimit != null || s.dailyUsdLimit != null)) {
    logger.warn(
      `Safety: USD pricing unavailable for trade ${input.tokenIn} → ${input.tokenOut} on ${input.chain}; ` +
        `per-tx/daily USD limits NOT enforced for this trade. Slippage and token-list guards still apply.`,
    );
  }
  if (input.estimatedUsd != null) {
    // 4. Per-tx USD limit — extracted to enforcePerTxUsdLimit (iter; v125) so
    // executePaperTrade can run the SAME check (the dry-run must reject exactly
    // where real would). Stateless (this trade vs the cap), so it's safe to
    // share verbatim.
    enforcePerTxUsdLimit(input.estimatedUsd, config);
    // 5. Daily USD limit (sums all SUCCESSful trades in the last 24h for this account)
    if (s.dailyUsdLimit != null) {
      const usedToday = dailyUsdVolume(input.account, input.chain);
      if (usedToday + input.estimatedUsd > s.dailyUsdLimit) {
        const remaining = Math.max(0, s.dailyUsdLimit - usedToday);
        throw new ToolError(
          "AMOUNT_EXCEEDS_LIMIT",
          `Trade would push 24h volume to $${(usedToday + input.estimatedUsd).toFixed(
            2,
          )}, over daily limit $${s.dailyUsdLimit.toFixed(2)}.`,
          {
            details: {
              estimatedUsd: input.estimatedUsd,
              usedToday,
              dailyUsdLimit: s.dailyUsdLimit,
              remainingToday: remaining,
            },
            // Iter307: surface the EXACT remaining budget so the agent can resize the
            // trade. "Wait for older trades to age out" is the alternative but harder to
            // automate against — the remaining-budget number is actionable right now.
            nextActions: [
              {
                // Iter587: `quote` instead of nonexistent `trade` umbrella.
                tool: "quote",
                reason: `Remaining 24h budget for this account is $${remaining.toFixed(2)}. Reduce the trade amount to fit (quote first to verify), wait for older trades to roll out of the 24h window, or use a different account.`,
              },
            ],
          },
        );
      }
    }
  }

  logger.debug("Safety checks passed");
}

/**
 * v125: the per-tx USD cap, extracted so BOTH the live path (enforceSafety) and
 * the paper dry-run (executePaperTrade) enforce it from one definition — a
 * paper trade sized past the per-tx limit must reject exactly where a real one
 * would, or the dry-run overstates what the strategy could actually do live.
 * Stateless: only this trade's USD value vs the cap. No-op when safety is
 * disabled, the cap is unset, or the trade couldn't be priced.
 */
export function enforcePerTxUsdLimit(estimatedUsd: number | null, config: Config): void {
  const s = config.safety;
  if (!s.enabled || s.perTxUsdLimit == null || estimatedUsd == null) return;
  if (estimatedUsd > s.perTxUsdLimit) {
    throw new ToolError(
      "AMOUNT_EXCEEDS_LIMIT",
      `Trade size $${estimatedUsd.toFixed(2)} exceeds per-tx limit $${s.perTxUsdLimit.toFixed(2)}.`,
      {
        details: { estimatedUsd, perTxUsdLimit: s.perTxUsdLimit },
        // Iter307: don't suggest raising the limit — that bypasses the safety the
        // operator opted into. Suggest splitting/resizing instead.
        nextActions: [
          {
            tool: "quote",
            reason: `Reduce the trade amount to keep estimated value ≤ $${s.perTxUsdLimit.toFixed(2)}, or split into multiple smaller trades. Quote first to verify the resized amount.`,
          },
        ],
      },
    );
  }
}

// ── rate-limit guard (iter633) ────────────────────────────────

export interface RateLimitInput {
  account: string;
  chain?: string;
  /** Most-recent trade timestamp (ISO) for this account, or null when none. */
  lastTradeTimestamp: string | null;
  /** Override "now" — injection point for time-dependent tests. */
  nowMs?: number;
}

/**
 * Iter633: pure rate-limit check. Pre-iter633 a buggy bot could loop
 * `trade buy` 1000×/sec; per-tx and daily USD limits protect the size of
 * each trade but don't protect against the rate. minTradeIntervalMs adds
 * a cooldown enforced from the DB's most-recent trade timestamp.
 *
 * `null` lastTradeTimestamp = no prior trades = always passes.
 *
 * Returns void on pass; throws SAFEGUARD_TRIGGERED on fail with structured
 * details (reason: "rate_limited", elapsedMs, requiredMs) so an agent can
 * branch on the policy hit AND know how long to wait before retrying.
 *
 * Exported pure for unit testing without standing up the DB.
 */
export function enforceRateLimit(input: RateLimitInput, config: Config, logger: Logger): void {
  const s = config.safety;
  if (!s.enabled) return;
  const min = s.minTradeIntervalMs;
  if (min == null || min <= 0) return;

  if (!input.lastTradeTimestamp) {
    // No prior trades = always allow.
    return;
  }

  const now = input.nowMs ?? Date.now();
  const lastMs = Date.parse(input.lastTradeTimestamp);
  if (!Number.isFinite(lastMs)) {
    // Defensive: malformed timestamp in DB shouldn't block trades. Log + pass.
    logger.warn(
      `Rate-limit check: account ${input.account} lastTradeTimestamp "${input.lastTradeTimestamp}" is unparseable. Skipping check.`,
    );
    return;
  }
  const elapsedMs = now - lastMs;
  if (elapsedMs < 0) {
    // Clock skew or future-dated row. Pass (the timestamp is unreliable).
    logger.warn(
      `Rate-limit check: lastTradeTimestamp is in the future (clock skew?). Skipping check.`,
    );
    return;
  }
  if (elapsedMs >= min) return;

  const waitMs = min - elapsedMs;
  throw new ToolError(
    "SAFEGUARD_TRIGGERED",
    `Trade rate-limit: last trade was ${elapsedMs}ms ago; minimum interval is ${min}ms. Wait ${waitMs}ms then retry.`,
    {
      details: {
        reason: "rate_limited",
        account: input.account,
        chain: input.chain,
        elapsedMs,
        minTradeIntervalMs: min,
        waitMs,
        lastTradeTimestamp: input.lastTradeTimestamp,
      },
      nextActions: [
        {
          // Iter633: an agent retrying after the cooldown should re-quote
          // anyway (market may have moved). Send to `quote` rather than
          // hinting buy/sell directly.
          tool: "quote",
          reason: `Wait ${Math.ceil(waitMs / 1000)}s (rate-limit cooldown). Re-quote before retrying — market may have moved during the wait.`,
        },
      ],
    },
  );
}

// ── gas budget guard (iter620) ────────────────────────────────

export interface GasBudgetInput {
  chain: string;
  /** Estimated gas cost in native units (decimal). E.g. "0.005" ETH. */
  estimatedGasNative: number;
  /** USD value of the gas cost. Undefined when native price feed is down. */
  estimatedGasUsd?: number;
  /** USD value of the trade input (what's being SENT in). */
  estimatedTradeUsd?: number;
}

/**
 * Iter620: pure gas-budget check. Pre-iter620 the preview (iter608) computed
 * `gasPctOfInput` but trade execution never enforced a limit — operators saw
 * the "gas is 30% of trade" preview text and the trade still went through.
 *
 * Two checks, both opt-in (defaults to no cap so existing trades behave the
 * same as before):
 *   1. maxGasPctOfTrade: gas USD / trade USD × 100 must not exceed the cap.
 *      Catches "gas dominates economics" — e.g. a 0.02 ETH swap on mainnet
 *      where gas is half the trade value.
 *   2. maxGasNativePerChain[chain]: absolute cap on native gas spend. Catches
 *      "I never want to pay > 0.01 ETH for ANY trade regardless of size".
 *
 * When estimatedGasUsd or estimatedTradeUsd is undefined (price feed gap),
 * the percent check skips with a warn log so operators know it didn't run.
 * The absolute-native check ALWAYS runs when configured — it doesn't need
 * USD prices.
 *
 * Returns void on pass; throws GAS_BUDGET_EXCEEDED on fail. Exported pure so
 * unit tests can pin the threshold behavior without a network mock.
 */
export function enforceGasBudget(input: GasBudgetInput, config: Config, logger: Logger): void {
  const s = config.safety;
  if (!s.enabled) return;
  const gas = s.gas;
  if (!gas) return;

  // Check 1: absolute native gas cap (doesn't need USD).
  const nativeCap = chainLookup(gas.maxGasNativePerChain, input.chain);
  if (nativeCap != null && input.estimatedGasNative > nativeCap) {
    throw new ToolError(
      "GAS_BUDGET_EXCEEDED",
      `Estimated gas ${input.estimatedGasNative} native exceeds budget cap ${nativeCap} on ${input.chain}.`,
      {
        details: {
          chain: input.chain,
          estimatedGasNative: input.estimatedGasNative,
          maxGasNative: nativeCap,
          reason: "absolute_native_cap",
        },
        nextActions: [
          {
            // Iter620: agent path → re-quote with a delay (gas may drop), or
            // resize the trade so the % calculation tolerates the gas, or
            // raise the cap if this is a legitimate high-gas environment.
            tool: "quote",
            reason: `Gas is currently ${input.estimatedGasNative} native on ${input.chain}, above the configured budget of ${nativeCap}. Options: wait for gas to drop (re-quote later), or raise the cap with \`tradekit config set safety.gas.maxGasNativePerChain.${input.chain} ${input.estimatedGasNative * 1.5}\`.`,
          },
        ],
      },
    );
  }

  // Check 2: gas as % of trade USD. Skips when prices aren't available.
  if (gas.maxGasPctOfTrade != null) {
    if (input.estimatedGasUsd == null || input.estimatedTradeUsd == null) {
      logger.warn(
        `Safety: gas budget %-of-trade check SKIPPED for ${input.chain} (gas or trade USD price unavailable). ` +
          `Absolute-native cap still applies if configured.`,
      );
      return;
    }
    if (input.estimatedTradeUsd <= 0) {
      // Defensive: avoid divide-by-zero on a malformed trade. Don't fire the
      // check; let other safety rails handle it.
      return;
    }
    const pct = (input.estimatedGasUsd / input.estimatedTradeUsd) * 100;
    if (pct > gas.maxGasPctOfTrade) {
      throw new ToolError(
        "GAS_BUDGET_EXCEEDED",
        `Estimated gas $${input.estimatedGasUsd.toFixed(2)} is ${pct.toFixed(1)}% of trade value $${input.estimatedTradeUsd.toFixed(2)}, above the ${gas.maxGasPctOfTrade}% cap.`,
        {
          details: {
            chain: input.chain,
            estimatedGasUsd: input.estimatedGasUsd,
            estimatedTradeUsd: input.estimatedTradeUsd,
            actualPct: pct,
            maxGasPctOfTrade: gas.maxGasPctOfTrade,
            reason: "pct_of_trade_cap",
          },
          nextActions: [
            {
              tool: "quote",
              reason: `Gas would consume ${pct.toFixed(1)}% of this trade (cap ${gas.maxGasPctOfTrade}%). Options: increase the trade size so gas % drops, wait for gas to fall, or raise the cap with \`tradekit config set safety.gas.maxGasPctOfTrade ${Math.ceil(pct + 5)}\`.`,
            },
          ],
        },
      );
    }
  }
}

// ── approve-specific guard ───────────────────────────────────

export interface ApprovalSafetyInput {
  chain: string;
  token: Address;
  spender: Address;
  /** Raw amount being approved. `2^256-1` (maxUint256) is the conventional "infinite". */
  amount: bigint;
  /** Decimals of the token (so we can derive a USD value). */
  decimals: number;
  /** Current USD price per token unit, if known. */
  tokenUsdPrice?: number;
  /** Caller can pass override=true to bypass the infinite-approval gate. */
  override?: boolean;
}

/**
 * Iter413: extracted the "cheap" subset of approval-safety checks — token
 * whitelist/blacklist, spender contract whitelist, infinite-approval gate. None of
 * these need tokenUsdPrice, so approvals.ts can run them BEFORE the HTTP price
 * roundtrip. Same iter405-style split that trade.ts uses for swap safety.
 *
 * The full enforceApprovalSafety still runs all 4 checks (USD cap at step 4 is the
 * one that needs price). It calls this helper at its head, so the canonical
 * implementation lives in one place.
 */
export function enforcePreflightApprovalSafety(
  input: Pick<ApprovalSafetyInput, "chain" | "token" | "spender" | "amount" | "override">,
  config: Config,
  logger: Logger,
): void {
  const s = config.safety;
  if (!s.enabled) {
    logger.debug("Safety disabled — skipping approval guards");
    return;
  }

  const tokenLc = input.token.toLowerCase();
  const spenderLc = input.spender.toLowerCase();

  // 1. Token whitelist / blacklist (case-insensitive chain-key lookup; see chainLookup)
  const whitelist = lowerSet(chainLookup(s.tokenWhitelist, input.chain));
  if (whitelist && whitelist.size > 0 && !whitelist.has(tokenLc)) {
    throw new ToolError("TOKEN_BLOCKED", `Token ${input.token} not in whitelist for chain "${input.chain}".`, {
      details: { token: input.token, chain: input.chain },
    });
  }
  const blacklist = lowerSet(chainLookup(s.tokenBlacklist, input.chain));
  if (blacklist && blacklist.has(tokenLc)) {
    throw new ToolError("TOKEN_BLOCKED", `Token ${input.token} is blacklisted on chain "${input.chain}".`, {
      details: { token: input.token, chain: input.chain },
    });
  }

  // 2. Contract (spender) whitelist
  const spenders = lowerSet(chainLookup(s.contractWhitelist, input.chain));
  if (spenders && spenders.size > 0 && !spenders.has(spenderLc)) {
    throw new ToolError(
      "CONTRACT_BLOCKED",
      `Spender ${input.spender} is not in the contract whitelist for chain "${input.chain}".`,
      {
        details: { spender: input.spender, chain: input.chain, whitelist: [...spenders] },
        nextActions: [
          {
            // Match the MCP config tool's actual schema (action / path / value) — same
            // shape as the matching contract-blocked nextAction above. Pre-iter150 this
            // hint used `append` which was a stale fictional param name from before
            // the config-tool refactor; an agent mechanically invoking it got a zod
            // validation failure instead of the intended whitelist push.
            tool: "config",
            params: {
              action: "push",
              path: `safety.contractWhitelist.${input.chain}`,
              value: input.spender,
            },
            // Iter512: embed the copy-paste CLI form so the operator/agent doesn't
            // have to translate the structured { action, path, value } into a
            // command line. Same iter435/508 convention.
            reason: `Add the spender to the whitelist if you trust it — run \`tradekit config push safety.contractWhitelist.${input.chain} ${input.spender}\`.`,
          },
        ],
      },
    );
  }

  // 3. Infinite-approval gate. Anything within an order of magnitude of maxUint256
  //    counts as "infinite" — wallets like MetaMask consider >= 2^255 infinite.
  const INFINITE_THRESHOLD = maxUint256 / 2n;
  if (input.amount >= INFINITE_THRESHOLD && !s.allowInfiniteApprovals && !input.override) {
    throw new ToolError(
      "SAFEGUARD_TRIGGERED",
      "Infinite approvals are blocked by safety policy. Pass override=true (MCP) or --force-infinite (CLI), or set safety.allowInfiniteApprovals=true to allow.",
      {
        details: { spender: input.spender, token: input.token },
        nextActions: [
          {
            tool: "approve",
            params: { token: input.token, spender: input.spender, amount: "<a finite amount>" },
            // Iter514: embed the copy-paste CLI form (iter435/508/512/513 convention).
            // The CLI approve command takes <token> <spender> as positional args plus
            // --amount as a flag, so the form mirrors that exactly.
            reason: `Prefer finite approvals — run \`tradekit approve ${input.token} ${input.spender} --amount <a finite amount>\` instead; revoke later via the revoke tool.`,
          },
        ],
      },
    );
  }
}

export function enforceApprovalSafety(input: ApprovalSafetyInput, config: Config, logger: Logger): void {
  // Iter413: cheap subset lives in enforcePreflightApprovalSafety so approvals.ts can
  // run it before the price-lookup HTTP call. Chain through it here so the contract —
  // "all 4 checks run" — stays intact.
  enforcePreflightApprovalSafety(input, config, logger);
  const s = config.safety;
  if (!s.enabled) return; // already logged by preflight

  const INFINITE_THRESHOLD = maxUint256 / 2n;

  // 4. Max approval USD value (when price + limit are both known)
  if (s.maxApprovalUsdLimit != null && input.tokenUsdPrice != null && input.amount < INFINITE_THRESHOLD) {
    const human = Number(input.amount) / 10 ** input.decimals;
    const usd = human * input.tokenUsdPrice;
    if (usd > s.maxApprovalUsdLimit) {
      // Iter308: compute the max amount that fits within the cap and surface it as
      // a next-action. Same actionable-error pattern as iter307 (daily-USD remaining).
      // Operator/agent can resize the approval to exactly fit instead of guessing.
      const maxAllowedAmount = s.maxApprovalUsdLimit / input.tokenUsdPrice;
      throw new ToolError(
        "AMOUNT_EXCEEDS_LIMIT",
        `Approval value $${usd.toFixed(2)} exceeds safety cap $${s.maxApprovalUsdLimit.toFixed(2)}.`,
        {
          details: {
            approvalUsd: usd,
            cap: s.maxApprovalUsdLimit,
            token: input.token,
            spender: input.spender,
            maxAllowedAmount: maxAllowedAmount.toString(),
          },
          nextActions: [
            {
              tool: "approve",
              params: { token: input.token, spender: input.spender, amount: maxAllowedAmount.toFixed(input.decimals) },
              // Iter514: embed paste-ready CLI command — the safe-bounded amount
              // is computable here, so the operator can run the exact command
              // without doing the cap math themselves.
              reason: `Approve up to ${maxAllowedAmount.toFixed(Math.min(input.decimals, 8))} ${input.token} (~$${s.maxApprovalUsdLimit.toFixed(2)}) instead — run \`tradekit approve ${input.token} ${input.spender} --amount ${maxAllowedAmount.toFixed(Math.min(input.decimals, 8))}\`. To grant more, raise safety.maxApprovalUsdLimit in config first.`,
            },
          ],
        },
      );
    }
  }

  logger.debug("Approval safety checks passed");
}
