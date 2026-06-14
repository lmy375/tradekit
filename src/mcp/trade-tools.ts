// MCP trade tools: quote, buy, sell, import_trade, transfer. Each is a thin shim that
// resolves tokens, routes through the safety/aggregator/simulate/audit pipeline in
// trade.ts, and either records the trade or returns the simulation result.

import { isAddress } from "viem";
import { resolveProfile } from "../config.js";
import { resolveToken, resolveTradePair, unknownTokenError } from "../chains.js";
import { executeTrade, type TradeRequest } from "../trade.js";
import { ToolError, toToolError } from "../errors.js";
import { z } from "zod";
import { ok, fail, runTool, type RegisterFn } from "./runtime.js";

export const registerTradeTools: RegisterFn = (server, rt) => {
  // ── quote ─────────────────────────────────────────────────
  server.tool(
    "quote",
    "Get a swap quote without sending a tx. Returns aggregator, expected amounts (decimal strings), price (quote/base), the contract that would need approval (result.allowanceTarget), and `elapsedMs` (iter915 — wall-clock incl. aggregator HTTP roundtrip + simulate; iter638 phaseTiming nested object has per-phase breakdown). Also surfaces `recentFailurePattern` (iter682) when ≥3 trades on this base/quote pair have failed in the last 7d with one dominant reason (≥50% share) — agents should check this field before deciding whether to follow through with buy/sell, and consider `autoSlippage=true` when dominantReason is slippage-related ('Too little received', 'minReturn not met'). Units: slippageBps is basis points (50 = 0.5%). Direction is inferred from amount: quoteAmount → buy (spend N quote), baseAmount → sell (sell N base). Errors mirror buy/sell minus the on-chain-revert codes (since quote never sends): INSUFFICIENT_BALANCE (fail-fast pre-flight; details.balance/required/symbol), INSUFFICIENT_LIQUIDITY (no route), SLIPPAGE_TOO_HIGH (over safety cap — nextActions carries the cap value as slippageBps so agents can retry directly), TOKEN_BLOCKED, CONTRACT_BLOCKED, INVALID_PARAMS, AGGREGATOR_FAILED (every aggregator declined — details.attempts lists what was tried). Use this BEFORE buy/sell for low-stakes verification of price + allowanceTarget + failure-pattern signal.",
    {
      chain: z.string().optional(),
      direction: z.enum(["buy", "sell"]).optional().describe("Optional — inferred from quoteAmount/baseAmount if omitted."),
      base: z.string().optional().describe("Base token symbol or address. Default: ETH."),
      quote: z.string().optional().describe("Quote token symbol or address. Default: USDC."),
      baseAmount: z.string().optional().describe("For sell: decimal amount of base to sell."),
      quoteAmount: z.string().optional().describe("For buy: decimal amount of quote to spend."),
      slippageBps: z.number().int().min(1).max(5000).optional(),
      account: z.string().optional().describe("HD account label override; defaults to active. Match the account you'll later pass to buy/sell so the quote's from-address reflects the actual signer."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("quote", rt.opts, input, input.chain, async () => {
            const config = rt.getConfig();
            const wallet = await rt.getContext(input.chain, input.account);
            const profile = resolveProfile(wallet.chain, config);
            const { base, quote } = resolveTradePair(
              profile,
              input.base ?? "ETH",
              input.quote ?? "USDC",
            );
            let direction = input.direction;
            if (!direction) {
              if (input.quoteAmount && !input.baseAmount) direction = "buy";
              else if (input.baseAmount && !input.quoteAmount) direction = "sell";
              else throw new ToolError("INVALID_PARAMS", "Specify direction, or exactly one of baseAmount/quoteAmount.");
            }
            const req: TradeRequest = {
              direction,
              base,
              quote,
              baseAmount: input.baseAmount,
              quoteAmount: input.quoteAmount,
              slippageBps: input.slippageBps,
              simulate: true,
            };
            return await executeTrade(req, {
              publicClient: wallet.publicClient,
              walletClient: wallet.walletClient,
              profile,
              config,
              logger: rt.opts.logger,
              accountLabel: wallet.label,
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── buy / sell ────────────────────────────────────────────
  for (const direction of ["buy", "sell"] as const) {
    server.tool(
      direction,
      `${direction === "buy" ? "Buy" : "Sell"} the base token via DEX aggregator. ${
        direction === "buy"
          ? "Pass `quoteAmount` (the amount of quote token to SPEND); `baseAmount` is not accepted for buy."
          : "Pass `baseAmount` (the amount of base token to SELL); `quoteAmount` is not accepted for sell."
      } Either amount field accepts "max" for full balance (with a gas reserve on native; the held-back amount is surfaced as result.gasReserveNative so the agent can echo it to the user). Result also carries (when populated): \`recentFailurePattern\` (iter682 — { total, windowDays, dominantReason, dominantCount } — set when ≥3 trades on this base/quote pair failed in the last 7d AND a single non-unknown reason has ≥50% share; agents should treat as a signal to use \`autoSlippage=true\` or pick a different aggregator before the next attempt). Errors: INSUFFICIENT_BALANCE (fail-fast pre-flight before aggregator roundtrip — details.balance/required/symbol name the shortfall; nextActions carries a scoped holdings call), INSUFFICIENT_LIQUIDITY (no route — try smaller amount or different quote token; nextActions carries hints), NEEDS_APPROVAL (pre-flight simulate caught an insufficient allowance — nextActions points to approve), SLIPPAGE_TOO_HIGH (over safety cap — nextActions carries the cap value as slippageBps so agents can retry directly), SLIPPAGE_EXCEEDED (simulate detected slippage revert — nextActions points to quote with higher slippageBps), AMOUNT_EXCEEDS_LIMIT (per-tx / daily USD cap — for daily, details.remainingToday names the exact remaining budget so the agent can resize without re-deriving), TOKEN_BLOCKED, CONTRACT_BLOCKED (aggregator router not in safety.contractWhitelist — nextActions points to config push), INVALID_PARAMS (base == quote token is rejected as degenerate), TX_TIMEOUT (tx sent but no receipt within waitForReceipt timeout — the row is persisted as pending; the reconcile tool / 'tradekit reconcile' will resolve it), TX_REVERTED (sendTransaction itself rejected — gas too low, nonce conflict, replacement-underpriced — distinct from on-chain revert which surfaces as status="failed"; classifyReason patterns provide actionable nextActions). On a reverted on-chain swap (status="failed") the persisted row carries the iter666/669 \`revertReason\` (decoded Error(string), Panic, or known custom error); agents calling \`recent_trades\` or \`analyze_trade\` afterwards read that field instead of the explorerUrl. The result also carries explorerUrl + a viewTx nextAction. Units: slippageBps is basis points (50 = 0.5%); amounts are decimal strings.`,
      {
        chain: z.string().optional(),
        base: z.string().optional().describe("Base token symbol or address. Default: ETH."),
        quote: z.string().optional().describe("Quote token symbol or address. Default: USDC."),
        baseAmount: z.string().optional().describe(
          direction === "buy"
            ? "Not accepted for buy — pass quoteAmount (amount of quote to spend) instead."
            : "Amount of base token to sell (decimal string, or \"max\" for full balance).",
        ),
        quoteAmount: z.string().optional().describe(
          direction === "buy"
            ? "Amount of quote token to spend (decimal string, or \"max\" for full balance)."
            : "Not accepted for sell — pass baseAmount (amount of base to sell) instead.",
        ),
        slippageBps: z.number().int().min(1).max(5000).optional().describe(
          "Max slippage in basis points (50 = 0.5%). Defaults to config.defaultSlippageBps (50bps unless changed). Capped above by safety.maxSlippageBps.",
        ),
        simulate: z.boolean().optional().describe("If true, simulate only (no tx sent). Default: false (real trade is sent). Use the `quote` tool for a pure dry-run."),
        note: z.string().optional().describe("Optional human-readable annotation (e.g. 'DCA #4', 'stop-loss'). Saved in trades.notes."),
        account: z.string().optional().describe("HD account label override; defaults to the active account."),
        forceGas: z
          .boolean()
          .optional()
          .describe(
            "Iter620: bypass the gas-budget safety check (safety.gas.maxGasPctOfTrade / maxGasNativePerChain). Use only when the operator has explicitly accepted current gas costs. Other safety rails (slippage, USD limits, blacklists) are unaffected.",
          ),
        expectedAmountOut: z
          .string()
          .optional()
          .describe(
            "Iter625: lock-in protection. Pass the amountOut from a prior `quote` call (decimal string). After the live re-quote, deviation worse than `maxQuoteDeviationBps` fails with QUOTE_DEVIATION_EXCEEDED. Use to bind a multi-step flow (quote → human review → buy) so market drift can't silently change the deal. Omit to skip the check (default).",
          ),
        maxQuoteDeviationBps: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe(
            "Iter625: tolerance for expectedAmountOut comparison, in basis points. Default 100 (1%). Only consulted when expectedAmountOut is set.",
          ),
        autoSlippage: z
          .boolean()
          .optional()
          .describe(
            "Iter642: derive slippage from realized history on the canonical pair (p95 + 25% buffer, capped at safety.maxSlippageBps). Ignored when slippageBps is explicitly set. Requires >=5 historical samples on the pair; falls back to defaultSlippageBps with smaller samples.",
          ),
        strategy: z
          .string()
          .max(100)
          .optional()
          .describe(
            "Iter648: structured strategy tag stored on the trade row (e.g. 'dca-eth', 'rebal-q1'). Indexed for cross-cut queries — `recent_trades` + `pnl` both accept a strategy filter. Distinct from `note` which is free-text.",
          ),
        approvalReason: z
          .string()
          .max(500)
          .optional()
          .describe(
            "v47: when safety.tradeApproval gates this trade, your stated reason is shown to the human reviewer alongside the quote preview — one sentence on WHY this trade, e.g. 'TV breakout signal + funding reset'. Ignored when no approval is needed.",
          ),
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            "v45: replay protection — STRONGLY recommended for every real (non-simulate) trade an agent sends. 8–128 chars [A-Za-z0-9_-]; generate a UUID per logical trade and REUSE it on transport-timeout retries: the retry replays the recorded outcome (marked replayed:true) instead of double-trading. Same key + different request → IDEMPOTENCY_CONFLICT. Key still executing → REQUEST_IN_FLIGHT (do NOT assume the original died; the tx may be in the mempool — check recent_trades first). A recorded failure replays as that failure: fixing the problem and retrying is a NEW logical trade → new key.",
          ),
        ...(direction === "buy"
          ? {
              protectTrailPct: z
                .number()
                .min(0.1)
                .max(99)
                .optional()
                .describe(
                  "v79: SOURCE-LEVEL protection — after this buy fills, auto-create a trailing-stop sell for the received amount at this % retracement, so the new position is never unprotected. The proactive twin of position_protection (detect) / protect_positions (fix after the fact). Response carries `autoProtect` { created, orderId, trailPct, amount }. Ignored on simulate. Reuses the validated order_create path (whitelist/amount/audit); a stop-creation failure leaves the successful trade intact (reported, never thrown).",
                ),
            }
          : {}),
      },
      async (input) => {
        try {
          return ok(
            await runTool(direction, rt.opts, input, input.chain, async () => {
              const config = rt.getConfig();
              const wallet = await rt.getContext(input.chain, input.account);
              const profile = resolveProfile(wallet.chain, config);
              const { base, quote } = resolveTradePair(
                profile,
                input.base ?? "ETH",
                input.quote ?? "USDC",
              );
              const req: TradeRequest = {
                direction,
                base,
                quote,
                baseAmount: input.baseAmount,
                quoteAmount: input.quoteAmount,
                slippageBps: input.slippageBps,
                simulate: input.simulate ?? false,
                note: input.note,
                forceGas: input.forceGas,
                expectedAmountOut: input.expectedAmountOut,
                maxQuoteDeviationBps: input.maxQuoteDeviationBps,
                autoSlippage: input.autoSlippage,
                strategy: input.strategy,
              };
              const ctx = {
                publicClient: wallet.publicClient,
                walletClient: wallet.walletClient,
                profile,
                config,
                logger: rt.opts.logger,
                accountLabel: wallet.label,
              };
              const { withIdempotency } = await import("../idempotency.js");
              const { result, replayed } = await withIdempotency({
                key: input.idempotencyKey,
                tool: direction,
                // Fingerprint the caller's request minus the key itself
                // — the same key with changed amounts must CONFLICT,
                // not silently replay the old trade.
                requestArgs: { ...input, idempotencyKey: undefined },
                exec: async () => {
                  // v47: human-in-the-loop approval gate (agent surface
                  // only — the CLI path sits behind the wallet password,
                  // i.e. the human). The pending result is a SUCCESS
                  // shape so agent loops don't blind-retry, and it's
                  // recorded under the idempotency key so a transport
                  // retry replays the SAME intent instead of filing
                  // duplicates.
                  const { approvalGateConfig, needsApproval, createTradeIntent, notifyIntentCreated } =
                    await import("../tradeIntents.js");
                  const gate = approvalGateConfig(config);
                  if (gate && !(input.simulate ?? false)) {
                    // Price + safety-check the request WITHOUT sending:
                    // the simulate preview is the reviewer's context.
                    const preview = await executeTrade({ ...req, simulate: true }, ctx);
                    const estUsd = preview.estimatedUsd ?? (Number.isFinite(parseFloat(preview.quoteAmount)) ? parseFloat(preview.quoteAmount) : null);
                    if (needsApproval(gate, estUsd)) {
                      const intent = createTradeIntent({
                        tool: direction,
                        chain: wallet.chain,
                        account: wallet.label ?? null,
                        request: { ...req, chain: wallet.chain, account: wallet.label },
                        preview: preview as unknown as Record<string, unknown>,
                        estUsd,
                        reason: input.approvalReason ?? null,
                        expiresMinutes: gate.expiresMinutes,
                      });
                      await notifyIntentCreated({
                        intent,
                        tool: direction,
                        pairLabel: `${preview.baseSymbol ?? input.base ?? "?"}/${preview.quoteSymbol ?? input.quote ?? "?"}`,
                        reason: input.approvalReason ?? null,
                        config,
                        logger: rt.opts.logger,
                      });
                      return {
                        ok: true,
                        ...intent,
                        preview: {
                          price: preview.price,
                          baseAmount: preview.baseAmount,
                          quoteAmount: preview.quoteAmount,
                          aggregator: preview.aggregator,
                        },
                        note: "Trade NOT executed — safety.tradeApproval gated it. A human must run `tradekit intents approve` (CLI-only by design). Poll intents_list for the decision; do NOT re-submit this trade.",
                      };
                    }
                  }
                  return await executeTrade(req, ctx);
                },
              });
              // v79: source-level protection — attach a trailing stop to a
              // fresh BUY fill. Only on a non-replayed real success (a replay's
              // stop was created on the original run; a sim/approval-gate result
              // has no fill). Best-effort: never disturbs the trade result.
              const protectTrailPct = (input as { protectTrailPct?: number }).protectTrailPct;
              if (
                direction === "buy" &&
                protectTrailPct != null &&
                !replayed &&
                !(input.simulate ?? false) &&
                (result as { status?: string }).status === "success"
              ) {
                const { createEntryStop } = await import("../protect.js");
                const autoProtect = await createEntryStop({
                  result: result as unknown as Parameters<typeof createEntryStop>[0]["result"],
                  trailPct: protectTrailPct,
                  config,
                  account: wallet.label,
                  chain: wallet.chain,
                });
                return { ...result, autoProtect };
              }
              return replayed ? { ...result, replayed: true } : result;
            }),
          );
        } catch (e) {
          return fail(toToolError(e));
        }
      },
    );
  }

  // ── v47: trade intents (read-only — approve/reject is CLI-only) ──
  server.tool(
    "intents_list",
    "v47: list agent-proposed trade intents awaiting (or past) human approval. Agents use this to POLL the decision on a pending_approval result from buy/sell — status flips to executed/failed (with result detail via the CLI) or rejected/expired. Approve/reject is deliberately NOT exposed over MCP (same security boundary as backup/panic: a prompt-injected agent must never approve its own spending) — a human runs `tradekit intents approve <id>`.",
    {
      status: z.enum(["pending", "executed", "failed", "rejected", "expired"]).optional().describe("Filter by status. Default: all."),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async (input) => {
      try {
        return ok(
          await runTool("intents_list", rt.opts, input, undefined, async () => {
            const { listIntents } = await import("../tradeIntents.js");
            const rows = listIntents({ status: input.status, limit: input.limit });
            return {
              ok: true,
              count: rows.length,
              intents: rows.map((r) => ({
                id: r.id,
                status: r.status,
                tool: r.tool,
                chain: r.chain,
                account: r.account,
                est_usd: r.est_usd,
                reason: r.reason,
                created_at: r.created_at,
                expires_at: r.expires_at,
                decided_at: r.decided_at,
                decided_note: r.decided_note,
              })),
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── sweep_balances (iter610) ──────────────────────────────
  // Multi-source balance consolidation. Plan + (optionally) execute transfers
  // from N source accounts to one target on one chain. Closes the HD-wallet
  // consolidation gap pre-iter610 had — operators ran 30+ separate `transfer`
  // tool calls and tracked outcomes manually.
  server.tool(
    "sweep_balances",
    "Consolidate balances from multiple source accounts into a single target on one chain. dryRun=true (default) returns the full plan (which token from which source, total USD value moved, total gas estimate) WITHOUT sending. Pass dryRun=false + confirm=true to execute. Filters: minUsd skips dust below threshold, exclude (symbol or address comma-list) blocks specific tokens, excludeUnpriced skips tokens with no price data. Plan/result also carries (iter679/iter680) `targetIsKnown` + `targetLabel` + `targetNote` — address-book lookup of the destination so agents can verify a labeled destination before invoking with confirm=true. Returns action-discriminated shape: \"noop-empty\" (nothing to sweep) | \"simulated\"/\"plan\" (dryRun result) | \"executed\" (after real run). Errors: INVALID_PARAMS (no target, no sources after filters, confirm not set when dryRun=false), UNKNOWN_ACCOUNT (typo'd source/target label).",
    {
      chain: z.string().optional(),
      target: z
        .string()
        .optional()
        .describe("Target account label (where balances consolidate to). Default: the currently-active account."),
      sources: z
        .array(z.string())
        .optional()
        .describe("Array of source account labels. Default: every HD account + keystore except the target."),
      minUsd: z.number().positive().optional().describe("Skip transfers whose USD value is below this threshold."),
      exclude: z.array(z.string()).optional().describe("Skip these tokens by symbol or address (case-insensitive)."),
      excludeUnpriced: z.boolean().optional().describe("Skip tokens with no USD price (default false)."),
      dryRun: z.boolean().optional().describe("If true (default), return the plan without sending. Pass false + confirm=true to execute."),
      confirm: z.boolean().optional().describe("Required when dryRun=false. Explicit opt-in for the bulk transfer."),
      pass: z.string().optional().describe("Wallet password (or set WALLET_PASS env). Required when dryRun=false — signs every source's transfer."),
    },
    async ({ chain, target, sources, minUsd, exclude, excludeUnpriced, dryRun, confirm, pass }) => {
      try {
        return ok(
          await runTool("sweep_balances", rt.opts, { chain, target, sources, minUsd, exclude, excludeUnpriced, dryRun, confirm }, chain, async () => {
            const config = rt.getConfig();
            const { resolveProfile: rp } = await import("../config.js");
            const { listAccounts } = await import("../accounts.js");
            const { getKeystoreAddress } = await import("../wallet.js");
            const { KEYSTORE_LABEL } = await import("../constants.js");
            const wallet = await rt.getContext(chain);
            const profile = rp(wallet.chain, config);

            const accountsFile = listAccounts();
            const keystoreAddr = getKeystoreAddress();
            const known: Array<{ label: string; address: `0x${string}` }> = [
              ...(accountsFile?.accounts ?? []).map((a) => ({ label: a.label, address: a.address })),
              ...(keystoreAddr ? [{ label: KEYSTORE_LABEL, address: keystoreAddr }] : []),
            ];

            const targetLabel = target ?? accountsFile?.active ?? KEYSTORE_LABEL;
            const tgt = known.find((a) => a.label === targetLabel);
            if (!tgt) {
              const { unknownAccountError } = await import("../accounts.js");
              throw unknownAccountError(targetLabel, known.map((a) => a.label));
            }

            const sourceLabels = sources ?? known.filter((a) => a.label !== tgt.label).map((a) => a.label);
            const { unknownAccountError } = await import("../accounts.js");
            for (const lbl of sourceLabels) {
              if (!known.some((a) => a.label === lbl)) {
                throw unknownAccountError(lbl, known.map((a) => a.label));
              }
            }
            const sourceList = known.filter((a) => sourceLabels.includes(a.label));

            const { planSweep, executeSweep } = await import("../sweep.js");
            const plan = await planSweep({
              sources: sourceList,
              target: tgt.address,
              filters: { minUsd, exclude, excludeUnpriced: excludeUnpriced === true },
              ctx: {
                publicClient: wallet.publicClient,
                profile,
                config,
                logger: rt.opts.logger,
              },
            });

            if (plan.transfers.length === 0) {
              return {
                ok: true,
                action: "noop-empty" as const,
                target: tgt.address,
                targetLabel: tgt.label,
                chain: plan.chain,
                skipped: plan.skipped,
                timestamp: plan.timestamp,
              };
            }

            const isDryRun = dryRun !== false;
            if (isDryRun) {
              return { ok: true, action: "plan" as const, targetLabel: tgt.label, ...plan };
            }

            if (confirm !== true) {
              throw new ToolError(
                "INVALID_PARAMS",
                "sweep_balances with dryRun=false requires explicit confirm=true. The bulk transfer sends one tx per source × token — confirm only when that's what you want.",
                { details: { reason: "confirm_required", transferCount: plan.transfers.length } },
              );
            }

            const walletPass = pass ?? process.env.WALLET_PASS;
            if (!walletPass) {
              throw new ToolError(
                "WRONG_PASSWORD",
                "sweep_balances requires the wallet password to sign each source's transfers.",
                { details: { reason: "missing_password" } },
              );
            }

            const { loadWallet } = await import("../wallet.js");
            const extraRpcs = config.chains[profile.name]?.rpcs ?? [];
            const report = await executeSweep({
              plan,
              loadWalletForSource: async (label) => {
                const w = await loadWallet(walletPass, profile, extraRpcs, rt.opts.logger, label);
                return {
                  ctx: {
                    publicClient: w.publicClient,
                    walletClient: w.walletClient,
                    profile,
                    config,
                    logger: rt.opts.logger,
                    accountLabel: label,
                  },
                };
              },
              logger: rt.opts.logger,
            });
            return { ok: true, action: "executed" as const, targetLabel: tgt.label, ...report };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── preview_trade (iter608) ───────────────────────────────
  // Unified pre-trade analysis. Read-only (no submit, no password) — combines
  // aggregator quote + USD valuation both sides + gas-USD estimate + wallet
  // balance fraction + safety pre-flight outcome. Use BEFORE buy/sell to
  // verify the trade is safe and economical to submit.
  server.tool(
    "preview_trade",
    "Unified read-only pre-trade analysis. Returns { ok, chain, direction, baseToken, baseSymbol, quoteToken, quoteSymbol, provider, alternatives?, to, allowanceTarget, metrics, safety, timestamp, recentFailurePattern?, marketContext?, mevExposure? }. metrics carries amountIn/amountOut/amountOutMinimum (decimal), inputUsd/outputUsd/outputUsdFloor, slippageCushionBps, effectivePrice, estimatedGasNative/estimatedGasUsd/gasPctOfInput (flag when >5% — gas-dominated trade), walletBalance/balanceFractionPct (catches fat-finger amount typos), currentAllowance/hasSufficientAllowance (signals whether an approve is needed first). safety.passes = would enforcePreflightSafety allow this trade? When safety.passes=false the rejection field carries the typed code/message/details so the agent can fix the issue (SLIPPAGE_TOO_HIGH, TOKEN_BLOCKED, CONTRACT_BLOCKED, AMOUNT_EXCEEDS_LIMIT) without re-quoting just to learn what failed. `recentFailurePattern` (iter694 — same shape as quote/buy/sell) surfaces when ≥3 trades on this base/quote pair failed in last 7d with one dominant reason at ≥50% share; suggestedActions field carries the iter686 classifier-derived next steps. v54: `limits` projects the STATE-DEPENDENT execution guardrails (per-tx/daily USD, contract whitelist, rate limit, per-strategy budget, position cap, gas budget) for THIS trade via the real enforcers — `limits.admissible=false` + `limits.blocking[]` means buy/sell WOULD be rejected at execution even though `safety.passes` (the cheap slippage+token subset) is true. Pass `strategy` to include the per-strategy budget + position-cap checks. v69: `marketContext` answers WHEN (not just whether) — where the base price sits in its recent range, the trend/24h move, volatility, plus a direction-aware `timing` flag ('favorable'/'neutral'/'caution') + plain-language `notes` (buying near a high / into a falling knife → caution; selling into strength → favorable). Best-effort: absent when the base has no CoinGecko mapping. v77: `mevExposure` (pure — chain + config, no RPC) flags sandwich risk: { chain, protected, sandwichRisk ('high'/'medium'/'low'), exposed, advisory } — exposed=true means a public-mempool chain (Ethereum especially) with NO MEV protection active, where trades leak ~0.5-3% to sandwich bots. Pass quoteAmount for buy direction or baseAmount for sell. Errors mirror quote: INVALID_PARAMS (missing/wrong amount field), UNKNOWN_TOKEN, UNKNOWN_CHAIN, AGGREGATOR_FAILED.",
    {
      direction: z.enum(["buy", "sell"]).describe("buy = spend quote, sell = sell base"),
      chain: z.string().optional(),
      base: z.string().optional().describe("Base token symbol or address. Default: ETH."),
      quote: z.string().optional().describe("Quote token symbol or address. Default: USDC."),
      baseAmount: z.string().optional().describe("Required for direction=sell — decimal amount of base to sell."),
      quoteAmount: z.string().optional().describe("Required for direction=buy — decimal amount of quote to spend."),
      slippageBps: z.number().int().min(1).max(10_000).optional().describe("Slippage in bps. Defaults to config.defaultSlippageBps."),
      account: z.string().optional().describe("HD account label override; defaults to active."),
      autoSlippage: z.boolean().optional().describe(
        "Iter645: derive slippage from realized history on the pair (same logic as buy/sell autoSlippage). When set + slippageBps undefined, replaces default. Response carries `slippageSuggestion` so the caller can verify what was used.",
      ),
      strategy: z.string().max(100).optional().describe(
        "v54: strategy tag the trade would be stamped with. When set, the `limits` projection also evaluates the per-strategy budget + net-exposure position cap that gate a tagged trade at execution — so a tagged agent trade's `limits.admissible` is complete.",
      ),
    },
    async ({ direction, chain, base, quote: quoteSym, baseAmount, quoteAmount, slippageBps, account, autoSlippage, strategy }) => {
      try {
        return ok(
          await runTool("preview_trade", rt.opts, { direction, chain, base, quote: quoteSym, baseAmount, quoteAmount, slippageBps, account, autoSlippage, strategy }, chain, async () => {
            const config = rt.getConfig();
            const wallet = await rt.getContext(chain, account);
            const { resolveProfile: rp } = await import("../config.js");
            const profile = rp(wallet.chain, config);
            const { resolveTradePair } = await import("../chains.js");
            const { base: baseResolved, quote: quoteAddr } = resolveTradePair(profile, base ?? "ETH", quoteSym ?? "USDC");
            // Iter608: normalize "ETH" sentinel to NATIVE_TOKEN for the downstream API.
            const { NATIVE_TOKEN } = await import("../tokens.js");
            const baseAddr: `0x${string}` = baseResolved === "ETH" ? NATIVE_TOKEN : (baseResolved as `0x${string}`);

            // Resolve amounts to raw bigint.
            let baseAmountRaw: bigint | undefined;
            let quoteAmountRaw: bigint | undefined;
            const { getToken } = await import("../tokens.js");
            const { parseUnits } = await import("viem");
            if (direction === "buy") {
              if (!quoteAmount) {
                throw new ToolError("INVALID_PARAMS", "preview_trade direction=buy requires quoteAmount.", {
                  details: { direction: "buy", missingField: "quoteAmount" },
                });
              }
              const quoteIsNative = quoteAddr === NATIVE_TOKEN;
              const meta = quoteIsNative
                ? { decimals: 18, symbol: profile.nativeSymbol }
                : await getToken(wallet.publicClient, profile, quoteAddr);
              quoteAmountRaw = parseUnits(quoteAmount, meta.decimals);
            } else {
              if (!baseAmount) {
                throw new ToolError("INVALID_PARAMS", "preview_trade direction=sell requires baseAmount.", {
                  details: { direction: "sell", missingField: "baseAmount" },
                });
              }
              const baseIsNative = baseAddr === NATIVE_TOKEN;
              const meta = baseIsNative
                ? { decimals: 18, symbol: profile.nativeSymbol }
                : await getToken(wallet.publicClient, profile, baseAddr);
              baseAmountRaw = parseUnits(baseAmount, meta.decimals);
            }

            // Iter645: resolve autoSlippage in the shim layer (same pattern
            // as preview/preflight CLI handlers). Explicit slippageBps still wins.
            let resolvedSlippage = slippageBps ?? config.defaultSlippageBps;
            let slippageSuggestion: import("../slippageSuggest.js").SlippageSuggestion | undefined;
            if (autoSlippage && slippageBps == null) {
              try {
                const { previewSlippageSuggestion } = await import("../slippageSuggest.js");
                const suggestionReport = await previewSlippageSuggestion({
                  config,
                  logger: rt.opts.logger,
                  account: wallet.label,
                  baseSymbol: (base ?? "ETH").toUpperCase(),
                  quoteSymbol: (quoteSym ?? "USDC").toUpperCase(),
                  baseAddress: baseResolved === "ETH" ? undefined : (baseResolved as string),
                  quoteAddress: quoteAddr as string,
                });
                resolvedSlippage = suggestionReport.suggestion.suggestedBps;
                slippageSuggestion = suggestionReport.suggestion;
              } catch {
                // Best-effort.
              }
            }

            const { previewTrade } = await import("../tradePreview.js");
            const report = await previewTrade({
              direction,
              base: baseAddr,
              quote: quoteAddr,
              baseAmount: baseAmountRaw,
              quoteAmount: quoteAmountRaw,
              slippageBps: resolvedSlippage,
              publicClient: wallet.publicClient,
              walletAddress: wallet.account.address as `0x${string}`,
              account: wallet.label,
              profile,
              config,
              logger: rt.opts.logger,
              strategy,
            });
            return { ok: true, ...report, ...(slippageSuggestion ? { slippageSuggestion } : {}) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── preflight_trade (iter630) ─────────────────────────────
  // Composite pre-trade safety check. Combines preview (iter608) + token
  // safety (iter609) + cross-source price (iter613) + history slippage
  // (iter619) into one go/caution/no_go verdict. Use BEFORE buy/sell to
  // catch issues in one call.
  server.tool(
    "preflight_trade",
    "Composite pre-trade safety check. Returns { ok, chain, direction, baseSymbol, quoteSymbol, timestamp, verdict, reasons[], preview?, tokenSafety?, priceCrossCheck?, history?, portfolioGate? }. v73 `portfolioGate` carries the projected portfolio-level gates — { drawdown: {blocks, approaching, drawdownPct, thresholdPct} | null, concentration: ConcentrationRisk | null } — so the agent sees the drawdown breaker / concentration outcome BEFORE firing (these gate at execution against a live valuation the limit projection can't see). Skipped via skipPortfolio; auto-skipped when neither gate is configured. verdict ∈ 'go' / 'caution' / 'no_go'. Reasons each have a stable code ('token_honeypot', 'token_suspicious', 'price_extreme_divergence', 'price_suspicious_divergence', 'preview_safety_failed', 'limit_would_reject', 'high_realized_slippage_history', 'gas_pct_high', 'balance_fraction_high', 'approval_needed', 'market_timing_caution', 'market_timing_ok', 'preview_ok', 'token_ok', 'price_ok', 'history_ok', 'check_skipped') + severity (critical/warn/info) + source. no_go fires on critical findings (honeypot, extreme price divergence, preview-safety failure, v54 'limit_would_reject' — a configured per-tx/daily/budget/cap/rate guardrail that would reject the trade at execution, or v73 'drawdown_would_trip' — the portfolio drawdown circuit breaker would halt trading right now); caution fires on warns (incl. v69 'market_timing_caution' — buying near the recent high / into a falling knife, or selling near the recent low; v73 'drawdown_approaching' — drawdown ≥80% of the trip threshold; v73 'concentration_high' — this buy would push a token over safety.maxConcentrationPct; v77 'mev_exposed' — public-mempool chain with no MEV protection (≈0.5-3% sandwich leak); timing/portfolio/mev signals nudge to caution but don't block); otherwise go. The embedded preview.marketContext carries the full timing read (rangePositionPct, changePctWindow, volatility, a direction-aware 'timing' flag + plain-language notes) so the agent can decide WHEN, not just whether the trade is safe. Source reports embedded for callers who want details. Skip-flags let agents bypass expensive checks: skipHoneypot avoids the ~4-RPC round-trip probe, skipPriceCheck avoids the CoinGecko+DexScreener fan-out, skipHistory avoids DB+RPC for analyzing past trades. Use before dispatching buy/sell — agents branching on report.verdict can refuse no_go automatically.",
    {
      direction: z.enum(["buy", "sell"]),
      chain: z.string().optional(),
      base: z.string().optional().describe("Default: ETH."),
      quote: z.string().optional().describe("Default: USDC."),
      baseAmount: z.string().optional(),
      quoteAmount: z.string().optional(),
      slippageBps: z.number().int().min(1).max(10_000).optional(),
      account: z.string().optional(),
      skipHoneypot: z.boolean().optional().describe("Skip iter609 token safety probe (saves ~4 RPC roundtrips when the token is well-known)."),
      skipPriceCheck: z.boolean().optional().describe("Skip iter613 cross-source price check (saves CoinGecko + DexScreener API calls)."),
      skipHistory: z.boolean().optional().describe("Skip iter619 historical slippage lookup (saves DB query + analysis-side RPC)."),
      skipPortfolio: z.boolean().optional().describe("v73: skip the portfolio-gate projection (drawdown breaker + concentration). It fetches multi-chain holdings; skip when speed matters. Auto-skipped when neither gate is configured."),
      autoSlippage: z.boolean().optional().describe(
        "Iter645: derive slippage from realized history for the pair. Same data-driven recommendation as buy/sell autoSlippage. Response includes slippageSuggestion field.",
      ),
      strategy: z.string().max(100).optional().describe(
        "v54: strategy tag the trade would carry. When set, the verdict also reflects the per-strategy budget + net-exposure position cap (a configured limit that would reject the trade → no_go with code 'limit_would_reject').",
      ),
    },
    async ({
      direction,
      chain,
      base,
      quote: quoteSym,
      baseAmount,
      quoteAmount,
      slippageBps,
      account,
      skipHoneypot,
      skipPriceCheck,
      skipHistory,
      skipPortfolio,
      autoSlippage,
      strategy,
    }) => {
      try {
        return ok(
          await runTool(
            "preflight_trade",
            rt.opts,
            { direction, chain, base, quote: quoteSym, baseAmount, quoteAmount, slippageBps, account, skipHoneypot, skipPriceCheck, skipHistory, strategy },
            chain,
            async () => {
              const config = rt.getConfig();
              const wallet = await rt.getContext(chain, account);
              const { resolveProfile: rp } = await import("../config.js");
              const profile = rp(wallet.chain, config);
              const { resolveTradePair } = await import("../chains.js");
              const { base: baseResolved, quote: quoteAddr } = resolveTradePair(profile, base ?? "ETH", quoteSym ?? "USDC");
              const { NATIVE_TOKEN } = await import("../tokens.js");
              const baseAddr: `0x${string}` = baseResolved === "ETH" ? NATIVE_TOKEN : (baseResolved as `0x${string}`);

              let baseAmountRaw: bigint | undefined;
              let quoteAmountRaw: bigint | undefined;
              const { getToken } = await import("../tokens.js");
              const { parseUnits } = await import("viem");
              if (direction === "buy") {
                if (!quoteAmount) {
                  throw new ToolError("INVALID_PARAMS", "preflight_trade direction=buy requires quoteAmount.", {
                    details: { direction: "buy", missingField: "quoteAmount" },
                  });
                }
                const quoteIsNative = quoteAddr === NATIVE_TOKEN;
                const meta = quoteIsNative
                  ? { decimals: 18, symbol: profile.nativeSymbol }
                  : await getToken(wallet.publicClient, profile, quoteAddr);
                quoteAmountRaw = parseUnits(quoteAmount, meta.decimals);
              } else {
                if (!baseAmount) {
                  throw new ToolError("INVALID_PARAMS", "preflight_trade direction=sell requires baseAmount.", {
                    details: { direction: "sell", missingField: "baseAmount" },
                  });
                }
                const baseIsNative = baseAddr === NATIVE_TOKEN;
                const meta = baseIsNative
                  ? { decimals: 18, symbol: profile.nativeSymbol }
                  : await getToken(wallet.publicClient, profile, baseAddr);
                baseAmountRaw = parseUnits(baseAmount, meta.decimals);
              }

              // Iter645: autoSlippage resolution.
              let resolvedSlippage = slippageBps ?? config.defaultSlippageBps;
              let slippageSuggestion: import("../slippageSuggest.js").SlippageSuggestion | undefined;
              if (autoSlippage && slippageBps == null) {
                try {
                  const { previewSlippageSuggestion } = await import("../slippageSuggest.js");
                  const suggestionReport = await previewSlippageSuggestion({
                    config,
                    logger: rt.opts.logger,
                    account: wallet.label,
                    baseSymbol: (base ?? "ETH").toUpperCase(),
                    quoteSymbol: (quoteSym ?? "USDC").toUpperCase(),
                    baseAddress: baseResolved === "ETH" ? undefined : (baseResolved as string),
                    quoteAddress: quoteAddr as string,
                  });
                  resolvedSlippage = suggestionReport.suggestion.suggestedBps;
                  slippageSuggestion = suggestionReport.suggestion;
                } catch {
                  // Best-effort.
                }
              }

              const { runPreflight } = await import("../preflight.js");
              const report = await runPreflight({
                req: {
                  direction,
                  base: baseAddr,
                  quote: quoteAddr,
                  baseAmount: baseAmountRaw,
                  quoteAmount: quoteAmountRaw,
                  slippageBps: resolvedSlippage,
                  skipHoneypot,
                  skipPriceCheck,
                  skipHistory,
                  skipPortfolio,
                  strategy,
                },
                publicClient: wallet.publicClient,
                walletAddress: wallet.account.address as `0x${string}`,
                profile,
                config,
                logger: rt.opts.logger,
                accountLabel: wallet.label,
              });
              return { ok: true, ...report, ...(slippageSuggestion ? { slippageSuggestion } : {}) };
            },
          ),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── preflight_history (v74) ───────────────────────────────
  // The decision journal. Every preflight_trade run is persisted with its
  // verdict + reasons — including the caution/no_go runs (trades the agent
  // REFUSED), which leave no trace in the trades log. Surfaces the agent's
  // risk discipline for an operator auditing autonomous behavior.
  server.tool(
    "preflight_history",
    "v74: the preflight DECISION JOURNAL. Every preflight_trade run is logged with its go/caution/no_go verdict + reasons — crucially including the caution/no_go runs (trades the agent REFUSED), which leave NO trace in the trades log. This is the only surface that shows the agent's risk JUDGMENT (the bad trades it correctly avoided), not just the trades it made — exactly what an operator needs to trust an autonomous agent. Returns { ok, breakdown: {total, go, caution, no_go}, runs: [{ id, timestamp, chain, account, direction, base_symbol, quote_symbol, strategy, verdict, est_usd, critical_count, warn_count, reasons[] }] }. Filters: `days` (lookback window), `verdict` (go|caution|no_go), `strategy`, `limit` (default 20, newest-first). Use to audit go/no-go behavior, or correlate decisions with the trades that followed (by timestamp/pair).",
    {
      days: z.number().int().min(1).max(3650).optional().describe("Lookback window in days. Omit for all-time."),
      verdict: z.enum(["go", "caution", "no_go"]).optional().describe("Filter to one verdict — e.g. no_go to review refused trades."),
      strategy: z.string().optional().describe("Filter to one strategy tag."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max runs returned, newest-first. Default 20."),
    },
    async ({ days, verdict, strategy, limit }) => {
      try {
        return ok(
          await runTool("preflight_history", rt.opts, { days, verdict, strategy, limit }, undefined, async () => {
            const { listPreflightRuns, preflightVerdictBreakdown } = await import("../db.js");
            const sinceIso = days != null ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
            const breakdown = preflightVerdictBreakdown({ sinceIso, strategy });
            const runs = listPreflightRuns({ sinceIso, verdict, strategy, limit: limit ?? 20 }).map((r) => ({
              ...r,
              reasons: JSON.parse(r.reasons_json),
            }));
            return { ok: true, breakdown, runs };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── preflight_calibration (v75) ───────────────────────────
  // Closes the loop on the v74 journal: were the recorded verdicts actually
  // predictive? Correlates each preflight decision to the trade that followed
  // and reports per-verdict outcomes (fill/fail/slippage).
  server.tool(
    "preflight_calibration",
    "v75: are the preflight verdicts PREDICTIVE, or noise? Closes the loop on the v74 decision journal by correlating each recorded verdict to the trade that followed and reporting how those trades turned out. Returns { ok, windowMinutes, totalRuns, totalMatched, byVerdict: [{ verdict, runs, matched, filled, failed, pending, medianSlippageBps }], summary, generatedAt }. The operator's deepest trust question — not 'what did the agent decide' (preflight_history) but 'was its judgment GOOD': if 'go' trades fill cleanly while 'caution' trades slip worse / fail more, preflight is well-calibrated and the agent's discipline is meaningful; if outcomes are indistinguishable, the signal is noise (summary states which). Correlation is by proximity (same chain/account/pair/direction, nearest trade within `window` minutes AFTER the decision, one trade per run) — a labelled heuristic for an AGGREGATE read, since decisions and trades aren't hard-linked. Filters: `days` (lookback), `window` (match window, default 30m), `strategy`.",
    {
      days: z.number().int().min(1).max(3650).optional().describe("Lookback window in days. Omit for all-time."),
      window: z.number().int().min(1).max(1440).optional().describe("Decision→trade correlation window in minutes. Default 30."),
      strategy: z.string().optional().describe("Filter to one strategy tag."),
    },
    async ({ days, window, strategy }) => {
      try {
        return ok(
          await runTool("preflight_calibration", rt.opts, { days, window, strategy }, undefined, async () => {
            const { gatherPreflightCalibration } = await import("../preflightCalibration.js");
            const sinceIso = days != null ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
            const report = gatherPreflightCalibration({ windowMinutes: window, sinceIso, strategy });
            return { ok: true, ...report };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── import_trade ──────────────────────────────────────────
  server.tool(
    "import_trade",
    "Backfill an external swap (done on Uniswap UI, a bot, or any other tool) into the local trades DB so PnL is accurate. Decodes the tx, classifies it (stablecoin side is treated as quote), and inserts a row. Idempotent on tx_hash. Errors: TX_NOT_FOUND (tx unknown on this chain — try a different chain), RPC_FAILED (RPC down/rate-limited; retry or add a fallback RPC via config push chains.<chain>.rpcs), no-op on duplicate.",
    {
      chain: z.string().optional(),
      txHash: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be 0x-prefixed 64 hex chars (32-byte transaction hash)")
        .describe("Transaction hash to import."),
      account: z.string().optional().describe("Account label to attribute the trade to (default: active)."),
    },
    async ({ chain, txHash, account }) => {
      try {
        return ok(
          await runTool("import_trade", rt.opts, { chain, txHash, account }, chain, async () => {
            // Iter918: wall-clock for the import (decodeTx RPC roundtrip + DB
            // insert). Latency dominated by the decodeTx call.
            const t0 = Date.now();
            const config = rt.getConfig();
            const wallet = await rt.getContext(chain);
            const profile = resolveProfile(wallet.chain, config);
            const { importTradeFromTx } = await import("../importTrade.js");
            const acct = account ?? wallet.label;
            const result = await importTradeFromTx(wallet.publicClient, profile, txHash as `0x${string}`, acct, rt.opts.logger);
            return { ...result, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── conditional orders ────────────────────────────────────
  //
  // order_create / order_list / order_show / order_cancel / order_run.
  // Operators / agents can register standing intents that fire when the
  // live USD price for the base token satisfies a predicate (≤ X for
  // price_below, ≥ X for price_above). The engine routes triggered orders
  // through executeTrade so safety guardrails + audit + structured errors
  // are inherited verbatim.

  server.tool(
    "order_create",
    "Create a conditional / limit / trailing-stop / signal-armed order: a standing intent the engine fires when the configured trigger fires. Four trigger types: price_below (fires when base USD ≤ targetPriceUsd), price_above (fires when ≥ targetPriceUsd), trailing (tracks a high-water mark for sells / low-water mark for buys and fires when the price retraces by trailPct% from the mark). Trailing stops can include an optional activationPriceUsd gate that defers tracking until the price first crosses that level — useful for 'only start trailing after ETH hits $3500'. At fill time, the engine routes the trade through executeTrade so every safety guardrail (USD limits, slippage cap, gas budget, blacklists, rate limit, position limits) and the audit log apply just like a manual buy/sell. The engine MUST be running for orders to fire (use `order_run` for one-shot ticks or the unified `engine_run` / `tradekit engine run` daemon). Errors: INVALID_PARAMS (bad side/trigger, missing amount, non-positive price, expiry in the past, trailPct outside (0,100], trailPct on a non-trailing trigger, targetPriceUsd missing for price_below/price_above), UNKNOWN_TOKEN (base/quote can't be resolved on this chain), UNKNOWN_CHAIN. Returns the persisted OrderRow with assigned id, status='active', water_mark_usd starting null for trailing orders. Units: targetPriceUsd / trailPct / activationPriceUsd are numbers; amounts are decimal strings; expiresAt is ISO-8601; slippageBps is basis points.",
    {
      chain: z.string().optional().describe("Chain to operate on (default: active chain)."),
      account: z.string().optional().describe("Account label (default: active account)."),
      side: z.enum(["buy", "sell"]).describe("buy = spend quote to acquire base; sell = sell base for quote."),
      trigger: z
        .enum(["price_below", "price_above", "trailing", "signal"])
        .describe("price_below: fires when base USD price ≤ targetPriceUsd. price_above: fires when ≥ target. trailing: tracks HWM (sells) / LWM (buys) and fires when price retraces by trailPct%. signal (v35): event-driven — fires when the named external signal arrives (webhook POST /api/signal/:name, `tradekit signal fire`, or MCP signal_fire); requires signalName, no price."),
      targetPriceUsd: z
        .number()
        .positive()
        .optional()
        .describe("For price_below / price_above: REQUIRED — the trigger threshold. For trailing: OPTIONAL — activation gate (engine waits until current price ≥ this for sells / ≤ this for buys before starting to trail). Omit on trailing to start tracking immediately."),
      trailPct: z
        .number()
        .positive()
        .max(100)
        .optional()
        .describe("Trailing-only: % retracement from the water mark that fires the order. Range (0, 100]. Required for trigger=trailing; rejected for other trigger types."),
      activationPriceUsd: z
        .number()
        .positive()
        .optional()
        .describe("Trailing-only convenience alias for targetPriceUsd when describing the activation gate. If both are set, targetPriceUsd wins. Provided so agent code reads more naturally (`activationPriceUsd: 3500` vs `targetPriceUsd: 3500` for a trailing order)."),
      base: z.string().optional().describe("Base token (symbol or address). Default: ETH."),
      quote: z.string().optional().describe("Quote token (symbol or address). Default: USDC."),
      baseAmount: z.string().optional().describe("Decimal amount of base to trade, \"max\", or \"N%\" (sells only — both resolve against the LIVE position at fire time: max = everything, N% = that fraction; a [50% at target, max trailing] bracket is the classic scale-out). Mutually exclusive with quoteAmount."),
      quoteAmount: z.string().optional().describe("Decimal amount of quote to spend (buy) or receive (sell), \"max\", or \"N%\" (buys only — resolves against the live quote balance at fire time). Mutually exclusive with baseAmount."),
      slippageBps: z.number().int().min(1).max(10_000).optional().describe("Slippage cap in basis points (50 = 0.5%). Capped above by safety.maxSlippageBps at fill time."),
      autoSlippage: z.boolean().optional().describe("Derive slippage from realized history on the pair at fill time. Ignored when slippageBps is set."),
      expiresAt: z.string().optional().describe("ISO-8601 timestamp at which the order expires unfired."),
      expiresIn: z
        .string()
        .regex(/^\d+(?:\.\d+)?[smhdw]$/i)
        .optional()
        .describe("Relative duration shorthand (30s, 15m, 2h, 7d, 4w). Converted to an absolute expiresAt at create time. Mutually exclusive with expiresAt."),
      strategy: z.string().max(100).optional().describe("Strategy tag stamped on the trade when the order fills (indexed; same column as trade strategy)."),
      note: z.string().optional().describe("Free-form note saved on the order row + on the eventual trade row."),
      startAt: z.string().optional().describe("v38: ISO activation boundary — the engine ignores the order entirely until then (no trigger eval, no trailing watermark, no signal eligibility for events received before it). Expiry still applies during pre-start. Must precede expiresAt."),
      signalName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe("v35: REQUIRED for trigger='signal' — the external signal name this order arms on. The order fires when a signal with this name arrives AFTER the order was created (late-armed orders never fire on stale signals). Signals are point events: at-most-once delivery per listener."),
      onFill: z.unknown().optional().describe("Post-fill hook: { type: 'createOrder', spec: {...} } for one follow-up, or { type: 'createOrders', specs: [{...}, {...}] } for a multi-leg bracket (2–4 legs; legs without explicit `group` are auto-OCO-paired, e.g. take-profit + stop-loss that cancel each other). {{filled.X}} placeholders interpolate the fill. Auto-creates the follow-up order(s) after THIS order fills (e.g. limit buy → auto-trailing, or limit buy → TP+SL bracket). Validated with fake fill data at create time; hook failure at fire time keeps the fill; multi-leg creation is all-or-nothing (partial legs roll back). Hook orders inherit this order's paper flag."),
      group: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/, "group must match /^[A-Za-z0-9_-]+$/ (letters, digits, dash, underscore)")
        .max(64)
        .optional()
        .describe("OCO (One-Cancels-Other) group identifier. Orders sharing this string form an OCO group: when ANY peer transitions to a terminal state via the engine (filled/failed/expired), the engine cancels the remaining active peers with reason OCO_PEER_FIRED. Use for entry+exit-bracket patterns (TP + SL share a group), take-profit ladders (multiple sells at different prices share a group), or any other 'whichever fires first wins' pattern."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("order_create", rt.opts, input, input.chain, async () => {
            const t0 = Date.now();
            const config = rt.getConfig();
            const wallet = await rt.getContext(input.chain, input.account);
            const profile = resolveProfile(wallet.chain, config);
            const { base, quote } = resolveTradePair(
              profile,
              input.base ?? "ETH",
              input.quote ?? "USDC",
            );
            let expiresAt: string | undefined = input.expiresAt;
            if (input.expiresIn) {
              if (expiresAt) {
                throw new ToolError("INVALID_PARAMS", "Pass expiresAt OR expiresIn, not both.");
              }
              const { parseDurationToDate } = await import("../orders.js");
              const dt = parseDurationToDate(input.expiresIn);
              if (!dt) {
                throw new ToolError(
                  "INVALID_PARAMS",
                  `Invalid expiresIn "${input.expiresIn}" — use formats like 30s, 15m, 2h, 7d, 4w.`,
                );
              }
              expiresAt = dt.toISOString();
            }
            const { createOrderRow } = await import("../orders.js");
            // For trailing orders, accept both `targetPriceUsd` and the
            // synonym `activationPriceUsd` as the activation gate; the
            // typed shape lets either flow through. createOrderRow handles
            // the trigger-type specific semantics.
            const resolvedActivation =
              input.trigger === "trailing"
                ? input.targetPriceUsd ?? input.activationPriceUsd
                : input.targetPriceUsd;
            const row = createOrderRow(
              {
                side: input.side,
                trigger: input.trigger,
                targetPriceUsd: resolvedActivation,
                trailPct: input.trailPct,
                chain: wallet.chain,
                account: wallet.label,
                base,
                quote,
                baseAmount: input.baseAmount,
                quoteAmount: input.quoteAmount,
                slippageBps: input.slippageBps,
                autoSlippage: input.autoSlippage,
                expiresAt,
                strategy: input.strategy,
                note: input.note,
                group: input.group,
                onFill: input.onFill,
                signalName: input.signalName,
                startAt: input.startAt,
              },
              config,
            );
            return { order: row, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "order_list",
    "List conditional orders with pre-aggregated status counts in `summary`. Default status='active'; pass 'all' to see every order ever created. Use this to verify the engine is doing its job — `last_checked_at` + `last_checked_price` on each active row let agents tell at a glance whether the engine has ticked recently and what price it last observed. Filter combinations: chain + account + strategy + group (OCO group id). The group filter is exact-match — useful for inspecting the state of a specific OCO group ('which peers are still active in group X'). Returns { ok, summary: { total, byStatus: {active, paused, filled, cancelled, expired, failed} }, items: OrderRow[] }.",
    {
      status: z
        .enum(["all", "active", "paused", "filled", "cancelled", "expired", "failed"])
        .optional()
        .describe("Status filter (default: 'active')."),
      chain: z.string().optional(),
      account: z.string().optional(),
      strategy: z.string().optional(),
      group: z.string().optional().describe("OCO group id filter (exact match) — returns only orders sharing this group_id."),
      limit: z.number().int().positive().max(1000).optional().describe("Cap on rows returned (default: all matching)."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("order_list", rt.opts, input, input.chain, async () => {
            const { listOrders } = await import("../orders.js");
            const { orderCountsByStatus } = await import("../db.js");
            const items = listOrders({
              status: input.status ?? "active",
              chain: input.chain,
              account: input.account,
              strategy: input.strategy,
              group: input.group,
              limit: input.limit,
            });
            const byStatus = orderCountsByStatus();
            return { summary: { total: items.length, byStatus }, items };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "order_show",
    "Fetch a single order by id. Returns the full OrderRow including the fill audit trail (filled_at, fill_tx_hash, fill_price, fill_base_amount, fill_quote_amount) for filled rows and last_error_code / last_error_message for any active row that's encountered transient errors. Errors: INVALID_PARAMS (unknown id).",
    {
      id: z.number().int().positive().describe("Order id (assigned by order_create)."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("order_show", rt.opts, input, undefined, async () => {
            const { getOrderById } = await import("../orders.js");
            const row = getOrderById(input.id);
            if (!row) {
              throw new ToolError("INVALID_PARAMS", `Order #${input.id} not found.`, { details: { orderId: input.id } });
            }
            return { order: row };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "order_cancel",
    "Cancel an active order. Idempotent on already-cancelled rows (returns the row unchanged). Refuses to cancel rows in terminal state (filled / expired) — those are historical and can't be reactivated; use order_create to register a new intent. Pass `cascade: true` to ALSO cancel every active peer in the order's OCO group (reason OCO_OPERATOR_CASCADE on each peer). By default, manual cancel does NOT cascade — operators updating one leg of an OCO would be surprised if their peers vanished. Errors: INVALID_PARAMS (unknown id, already-terminal status, cascade=true on an order without a group_id).",
    {
      id: z.number().int().positive().describe("Order id to cancel."),
      cascade: z
        .boolean()
        .optional()
        .describe("When true AND the order has a group_id, ALSO cancel every active peer in the group. Errors with INVALID_PARAMS when the order has no group_id (likely typo)."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("order_cancel", rt.opts, input, undefined, async () => {
            const { cancelOrderById } = await import("../orders.js");
            const row = cancelOrderById(input.id, { cascade: input.cascade });
            return { order: row };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "order_pause",
    "Pause an active order: the engine stops evaluating its trigger until resumed. Non-destructive — pause/resume is the safe way to take an order offline while investigating (vs cancel, which is terminal). While paused: expiry STILL applies (a paused order whose expiresAt passes is retired as expired — time bounds the order's validity, not its activity) and OCO peers can STILL cancel it (a paused bracket arm dies when its sibling fires — otherwise resuming it later would re-arm an exit for a position that already closed). Trailing watermarks are preserved. Bulk variant: strategy_pause pauses every primitive owned by a tag. Errors: INVALID_PARAMS (unknown id, status not active).",
    {
      id: z.number().int().positive().describe("Order id to pause."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("order_pause", rt.opts, input, undefined, async () => {
            const { pauseOrderById } = await import("../orders.js");
            return { order: pauseOrderById(input.id) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "order_resume",
    "Resume a paused order: the engine evaluates its trigger again from the next tick. The trailing high-water mark continues from where the pause left it — a stop that fires immediately because price fell during the pause is correct stop behavior. Errors: INVALID_PARAMS (unknown id, status not paused).",
    {
      id: z.number().int().positive().describe("Order id to resume."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("order_resume", rt.opts, input, undefined, async () => {
            const { resumeOrderById } = await import("../orders.js");
            return { order: resumeOrderById(input.id) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "signal_fire",
    "v35: fire a named external signal — the manual twin of the TradingView webhook (POST /api/signal/:name). Drops ONE event in the signal inbox; the next engine tick fires EVERY active signal-armed order (trigger='signal', matching signalName) that was created BEFORE the event arrived (late-armed orders never fire on stale signals). Signals are point events: at-most-once delivery per listener; events with no eligible listener expire unclaimed after 1h. Strictly less powerful than the buy/sell tools (it can only trigger orders the operator pre-armed with their own amounts + safety rails). Returns { id, name, armedListeners }.",
    {
      name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe("Signal name to fire."),
      payload: z.unknown().optional().describe("Optional JSON payload stored on the event for forensics (≤4KB)."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("signal_fire", rt.opts, input, undefined, async () => {
            const { insertSignalEvent, listOrders } = await import("../db.js");
            const payload = input.payload != null ? JSON.stringify(input.payload).slice(0, 4096) : null;
            const id = insertSignalEvent({ name: input.name, receivedAt: new Date().toISOString(), source: "mcp", payloadJson: payload });
            const armedListeners = listOrders({ status: "active" }).filter(
              (o) => o.trigger_type === "signal" && o.signal_name === input.name,
            ).length;
            return { id, name: input.name, armedListeners };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "signal_list",
    "v35: list signal events (newest first) with consumption state — PENDING / consumed by order #N / expired unclaimed. The forensic answer to 'did my TradingView alert arrive, and what did it fire?'.",
    {
      name: z.string().optional().describe("Filter to one signal name."),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async (input) => {
      try {
        return ok(
          await runTool("signal_list", rt.opts, input, undefined, async () => {
            const { listSignalEvents } = await import("../db.js");
            return { events: listSignalEvents({ name: input.name, limit: input.limit }) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // Iter34: order_edit — in-place mutation of an active order.
  // Preserves trailing HWM + attempt counter + journal continuity.
  // Same field-validation contract as order_create. Engine-managed
  // columns (water_mark_usd, last_checked_at, fill_*) are NEVER
  // touched by the edit path.
  server.tool(
    "order_edit",
    "Edit an active order in-place WITHOUT losing trailing HWM, attempt counter, or journal continuity. Only the fields the operator passes are touched; engine-managed columns (water mark, last checked, fills) remain. Frozen fields (side, chain, account, base/quote token, trigger type, OCO group) — changing those means a different order, cancel + create instead. Each successful edit journals an entry with decision='edited_by_operator'. Race-safe: guarded on status='active' so a concurrent fire/expire wins cleanly — no silent overwrites. Errors: INVALID_PARAMS (unknown id, terminal status, exactly-one-amount violation, malformed expires_at, unset on required field), SLIPPAGE_TOO_HIGH (edit exceeds safety.maxSlippageBps).",
    {
      id: z.number().int().positive().describe("Order id to edit."),
      targetPriceUsd: z.number().positive().optional().describe("New target USD price (price triggers) or activation price (trailing). Pass null to clear the activation gate on trailing orders."),
      trailPct: z.number().positive().max(100).optional().describe("New trail % retracement; trailing orders only."),
      baseAmount: z.string().optional().describe("New base amount (decimal string). Mutually exclusive with quoteAmount via the exactly-one invariant."),
      quoteAmount: z.string().optional().describe("New quote amount (decimal string)."),
      slippageBps: z.number().int().min(1).max(10_000).optional().describe("New slippage cap. Must not exceed safety.maxSlippageBps."),
      autoSlippage: z.boolean().optional().describe("Toggle auto-slippage."),
      expiresAt: z.string().optional().describe("New ISO-8601 expiry. Must be in the future."),
      strategy: z.string().optional().describe("New strategy tag."),
      note: z.string().optional().describe("New free-text note."),
      paper: z.boolean().optional().describe("Toggle paper mode (iter30)."),
      onFill: z.unknown().optional().describe("Replacement on_fill hook spec: createOrder (single follow-up) or createOrders (multi-leg bracket). Pass null to remove an existing hook. Revalidated against the order's pair."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("order_edit", rt.opts, input, undefined, async () => {
            const { editOrder } = await import("../orderEdit.js");
            const changes: Record<string, unknown> = {};
            // Forward only the keys the agent actually passed so the
            // diff layer doesn't see "set to undefined" as an edit.
            if ("targetPriceUsd" in input) changes.targetPriceUsd = input.targetPriceUsd;
            if ("trailPct" in input) changes.trailPct = input.trailPct;
            if ("baseAmount" in input) changes.baseAmount = input.baseAmount;
            if ("quoteAmount" in input) changes.quoteAmount = input.quoteAmount;
            if ("slippageBps" in input) changes.slippageBps = input.slippageBps;
            if ("autoSlippage" in input) changes.autoSlippage = input.autoSlippage;
            if ("expiresAt" in input) changes.expiresAt = input.expiresAt;
            if ("strategy" in input) changes.strategy = input.strategy;
            if ("note" in input) changes.note = input.note;
            if ("paper" in input) changes.paper = input.paper;
            if ("onFill" in input) changes.onFill = input.onFill;
            const result = editOrder({ id: input.id, changes });
            return {
              orderId: input.id,
              changed: result.diff.length > 0,
              diff: result.diff,
              order: result.order,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "order_run",
    "Run ONE engine tick: walk active orders, price each base token, evaluate triggers, fire executeTrade for satisfied predicates. Returns a structured report with severity ('ok' | 'warn' | 'critical') + recommendedActions[] dispatch hints. Counts: scanned (active rows considered), triggered (predicate satisfied), filled (executeTrade succeeded), failedCount (terminal failures — revert / safety violation), expiredCount (rolled to expired this tick), transientErrorCount (RPC blip / rate limit — order stays active for retry). Pass dryRun=true to evaluate triggers without sending tx (useful for agent self-checks). Idempotent: re-running the tick is safe — once an order flips to filled / failed / expired / cancelled the engine no longer touches it. Agents that want a long-running engine should call this on a schedule (every 30-60s) or use the CLI `tradekit order run` daemon (which loops in-process). Errors: WALLET_LOCKED (only when an order actually triggers AND password unavailable — pure read-only ticks succeed without a password).",
    {
      chain: z.string().optional().describe("Restrict the scan to one chain (default: every chain with active orders)."),
      account: z.string().optional().describe("Restrict the scan to one account label."),
      dryRun: z.boolean().optional().describe("Evaluate triggers + record observations but never fire trades. Default: false."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("order_run", rt.opts, input, input.chain, async () => {
            const { runOrderTick } = await import("../orders.js");
            return await runOrderTick({
              chain: input.chain,
              account: input.account,
              // Pass the server's stored wallet password; runOrderTick will
              // only consume it when it actually needs to sign.
              password: input.dryRun ? undefined : rt.opts.walletPass,
              dryRun: input.dryRun,
              logger: rt.opts.logger,
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── scheduled / recurring trades (DCA primitive) ─────────
  //
  // schedule_create / schedule_list / schedule_show / schedule_pause /
  // schedule_resume / schedule_cancel / schedule_run. Cron-driven sibling
  // of the order engine. Same architectural pattern: standing intents
  // fired through executeTrade so safety + audit + notifications inherit.

  server.tool(
    "schedule_create",
    "Create a recurring (DCA) schedule: a standing intent that fires the same trade on a cron schedule. Each fire routes through executeTrade — every safety guardrail (USD limits, slippage cap, gas budget, blacklists, rate limit) and audit row applies just like a manual buy/sell. The engine MUST be running for schedules to fire — start it via `schedule_run` (one-shot for cron) or `tradekit schedule run` (long-running daemon). Common patterns: weekly DCA buy (`every: \"7d\"`, `side: \"buy\"`, `quoteAmount: \"100\"`), Monday-morning rebalance (`cron: \"0 10 * * 1\"`), bounded campaigns with `maxRuns`. Errors: INVALID_PARAMS (bad side / both-or-neither cron+every / both-or-neither baseAmount+quoteAmount / non-positive maxRuns / endAt-in-past / endAt-before-startAt / cron-never-fires-before-endAt), UNKNOWN_TOKEN, UNKNOWN_CHAIN. Returns the persisted ScheduleRow with assigned id, computed next_run_at, and status='active'.",
    {
      chain: z.string().optional().describe("Chain to operate on (default: active chain)."),
      account: z.string().optional().describe("Account label (default: active account)."),
      side: z.enum(["buy", "sell"]).describe("Trade direction at each fire."),
      cron: z
        .string()
        .optional()
        .describe("5-field UTC cron expression (e.g. \"0 10 * * 1\" for Monday 10am UTC). Macros: @hourly @daily @weekly @monthly @yearly. Mutually exclusive with `every`."),
      every: z
        .string()
        .regex(/^\d+[smhd]$/i)
        .optional()
        .describe("Duration shorthand (30m, 1h, 6h, 1d, 7d). Compiles to cron at create time. Mutually exclusive with `cron`."),
      base: z.string().optional().describe("Base token (symbol or address). Default: ETH."),
      quote: z.string().optional().describe("Quote token (symbol or address). Default: USDC."),
      baseAmount: z.string().optional().describe("Decimal amount of base per fire, \"max\", or \"N%\" (sells only — resolves against the live balance at EACH fire: max = staged liquidation, 10% = exponential decay sell-down). Mutually exclusive with quoteAmount."),
      quoteAmount: z.string().optional().describe("Decimal amount of quote per fire, \"max\", or \"N%\" (buys only — resolves against the live balance each fire). Mutually exclusive with baseAmount."),
      slippageBps: z.number().int().min(1).max(10_000).optional(),
      autoSlippage: z.boolean().optional(),
      name: z.string().optional().describe("Operator label for list views + notifications."),
      startAt: z.string().optional().describe("ISO-8601 timestamp before which the engine skips fires."),
      endAt: z.string().optional().describe("ISO-8601 timestamp at which the schedule is marked completed (must be > now and > startAt)."),
      maxRuns: z.number().int().positive().optional().describe("Lifetime cap on SUCCESSFUL fires. Schedule flips to 'completed' when reached. Failed attempts (RPC down, safeguard, balance) do NOT consume quota — a maxRuns=12 monthly DCA always delivers 12 actual buys."),
      strategy: z.string().max(100).optional(),
      note: z.string().optional(),
      onFill: z.unknown().optional().describe("Post-fill hook executed after EACH successful fire: { type: 'createOrder', spec: {...} } for one follow-up order, or { type: 'createOrders', specs: [{...}, {...}] } for a multi-leg bracket (2–4 legs; legs without explicit `group` are auto-OCO-paired per fire — the classic DCA + TP/SL bracket). {{filled.X}} placeholders (baseAmount, quoteAmount, fillPriceUsd, txHash, fireNumber) interpolate the actual fill. Validated with fake fill data at create time; hook failure at fire time keeps the fill (notified + journaled); multi-leg creation is all-or-nothing. Hook orders inherit the schedule's paper flag."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("schedule_create", rt.opts, input, input.chain, async () => {
            const t0 = Date.now();
            const config = rt.getConfig();
            const wallet = await rt.getContext(input.chain, input.account);
            const profile = resolveProfile(wallet.chain, config);
            const { base, quote } = resolveTradePair(profile, input.base ?? "ETH", input.quote ?? "USDC");
            const { createScheduleRow } = await import("../schedules.js");
            const row = createScheduleRow(
              {
                name: input.name,
                cron: input.cron,
                every: input.every,
                side: input.side,
                chain: wallet.chain,
                account: wallet.label,
                base,
                quote,
                baseAmount: input.baseAmount,
                quoteAmount: input.quoteAmount,
                slippageBps: input.slippageBps,
                autoSlippage: input.autoSlippage,
                startAt: input.startAt,
                endAt: input.endAt,
                maxRuns: input.maxRuns,
                strategy: input.strategy,
                note: input.note,
                onFill: input.onFill,
              },
              config,
            );
            return { schedule: row, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "schedule_list",
    "List schedules with pre-aggregated status counts. Default status='active'. The `next_run_at` field on each row tells agents when the schedule will next attempt to fire — handy for verifying the engine is healthy without running engine_run yourself. Returns { ok, summary: { total, byStatus: {active,paused,completed,cancelled} }, items: ScheduleRow[] }.",
    {
      status: z.enum(["all", "active", "paused", "completed", "cancelled"]).optional(),
      chain: z.string().optional(),
      account: z.string().optional(),
      strategy: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    async (input) => {
      try {
        return ok(
          await runTool("schedule_list", rt.opts, input, input.chain, async () => {
            const { listSchedules } = await import("../schedules.js");
            const { scheduleCountsByStatus } = await import("../db.js");
            const items = listSchedules({
              status: input.status ?? "active",
              chain: input.chain,
              account: input.account,
              strategy: input.strategy,
              limit: input.limit,
            });
            const byStatus = scheduleCountsByStatus();
            return { summary: { total: items.length, byStatus }, items };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "schedule_show",
    "Fetch a single schedule by id, with full run telemetry (run_count, total_base_filled, total_quote_spent, last_run_at, last_run_status, last_error_*). Errors: INVALID_PARAMS (unknown id).",
    { id: z.number().int().positive() },
    async (input) => {
      try {
        return ok(
          await runTool("schedule_show", rt.opts, input, undefined, async () => {
            const { getScheduleById } = await import("../schedules.js");
            const row = getScheduleById(input.id);
            if (!row) {
              throw new ToolError("INVALID_PARAMS", `Schedule #${input.id} not found.`, { details: { scheduleId: input.id } });
            }
            return { schedule: row };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "schedule_pause",
    "Pause an active schedule. The engine ignores paused schedules; resume via schedule_resume. Errors: INVALID_PARAMS (unknown id, not active).",
    { id: z.number().int().positive() },
    async (input) => {
      try {
        return ok(
          await runTool("schedule_pause", rt.opts, input, undefined, async () => {
            const { pauseScheduleById } = await import("../schedules.js");
            return { schedule: pauseScheduleById(input.id) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "schedule_resume",
    "Resume a paused schedule. next_run_at is recomputed from the cron expression at resume time (the engine does NOT backfill missed fires from the pause window — that's the explicit DCA semantic). Errors: INVALID_PARAMS (unknown id, not paused).",
    { id: z.number().int().positive() },
    async (input) => {
      try {
        return ok(
          await runTool("schedule_resume", rt.opts, input, undefined, async () => {
            const { resumeScheduleById } = await import("../schedules.js");
            return { schedule: resumeScheduleById(input.id) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "schedule_cancel",
    "Cancel a schedule (terminal — use schedule_pause for temporary). Idempotent on already-cancelled / completed rows. Errors: INVALID_PARAMS (unknown id).",
    { id: z.number().int().positive() },
    async (input) => {
      try {
        return ok(
          await runTool("schedule_cancel", rt.opts, input, undefined, async () => {
            const { cancelScheduleById } = await import("../schedules.js");
            return { schedule: cancelScheduleById(input.id) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // Iter34: schedule_edit — in-place mutation. Preserves run_count
  // + total_base_filled + total_quote_spent. Cron change recomputes
  // next_run_at automatically.
  server.tool(
    "schedule_edit",
    "Edit an active OR paused schedule in-place. State-preserving: run_count + total_base_filled + total_quote_spent stay. Cron change auto-recomputes next_run_at from now (the new cron fires on its next natural occurrence; preserving the old next_run_at would be stale). Frozen fields: side, chain, account, base/quote token. maxRuns cannot be lowered below the current run_count — set it equal to retire after the next fire instead. Terminal states (completed/cancelled) reject. Errors: INVALID_PARAMS (terminal, bad cron, both cron+every, maxRuns < run_count, bad amounts), SLIPPAGE_TOO_HIGH (exceeds safety.maxSlippageBps).",
    {
      id: z.number().int().positive().describe("Schedule id to edit."),
      cron: z.string().optional().describe("New cron expression. Mutually exclusive with every."),
      every: z.string().optional().describe("New duration shorthand (1h, 6h, 1d, 7d). Compiles to cron internally."),
      baseAmount: z.string().optional().describe("New base amount. Pair-exclusive with quoteAmount."),
      quoteAmount: z.string().optional().describe("New quote amount."),
      slippageBps: z.number().int().min(1).max(10_000).optional(),
      autoSlippage: z.boolean().optional(),
      endAt: z.string().optional().describe("New ISO-8601 end-at. Must be in the future."),
      maxRuns: z.number().int().min(1).optional().describe("New lifetime fire cap. Must be >= current run_count."),
      strategy: z.string().optional(),
      note: z.string().optional(),
      paper: z.boolean().optional(),
      onFill: z.unknown().optional().describe("Replacement on_fill spec: createOrder (single follow-up) or createOrders (multi-leg bracket). Pass null to remove an existing hook."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("schedule_edit", rt.opts, input, undefined, async () => {
            const { editSchedule } = await import("../scheduleEdit.js");
            const changes: Record<string, unknown> = {};
            if ("cron" in input) changes.cron = input.cron;
            if ("every" in input) changes.every = input.every;
            if ("baseAmount" in input) changes.baseAmount = input.baseAmount;
            if ("quoteAmount" in input) changes.quoteAmount = input.quoteAmount;
            if ("slippageBps" in input) changes.slippageBps = input.slippageBps;
            if ("autoSlippage" in input) changes.autoSlippage = input.autoSlippage;
            if ("endAt" in input) changes.endAt = input.endAt;
            if ("maxRuns" in input) changes.maxRuns = input.maxRuns;
            if ("strategy" in input) changes.strategy = input.strategy;
            if ("note" in input) changes.note = input.note;
            if ("paper" in input) changes.paper = input.paper;
            if ("onFill" in input) changes.onFill = input.onFill;
            if ("onFill" in input) changes.onFill = input.onFill;
            const result = editSchedule({ id: input.id, changes });
            return {
              scheduleId: input.id,
              changed: result.diff.length > 0,
              diff: result.diff,
              schedule: result.schedule,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "schedule_run",
    "Run ONE engine tick: walk active schedules with next_run_at <= now, fire each via executeTrade, advance next_run_at to the next cron slot. Idempotent — re-running the tick is safe (a fired schedule's next_run_at has already advanced, so it's no longer due). Pass dryRun=true to advance next_run_at without sending tx. Returns ScheduleTickReport with per-fire detail. Use this on a cron (e.g. every minute) for cron-driven deployment, or use the CLI `tradekit schedule run` for an in-process daemon.",
    {
      chain: z.string().optional(),
      account: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async (input) => {
      try {
        return ok(
          await runTool("schedule_run", rt.opts, input, input.chain, async () => {
            const { runScheduleTick } = await import("../schedules.js");
            return await runScheduleTick({
              chain: input.chain,
              account: input.account,
              password: input.dryRun ? undefined : rt.opts.walletPass,
              dryRun: input.dryRun,
              logger: rt.opts.logger,
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── portfolio rebalancing ────────────────────────────────
  //
  // rebalance_create / list / show / pause / resume / cancel / run.
  // Same architectural pattern as orders + schedules. Declarative
  // target-weight specs; the engine evaluates drift on a cron cadence
  // and fires corrective trades through executeTrade when max drift
  // exceeds the configured threshold.

  server.tool(
    "rebalance_preview",
    "v56: ad-hoc rebalance ANALYSIS — 'if I targeted this allocation, what's my drift RIGHT NOW and what trades correct it?' — WITHOUT deploying a plan. Read-only: fetches the current (or paper) portfolio, runs the SAME computeDrift + planRebalanceTrades the engine tick uses, and returns { totalUsd, maxDriftPct, wouldFire (vs an optional driftThresholdPct), drift[] (per-target current% → target% + drift + USD delta), steps[] (corrective trades in execution order — sells before buys), skipped[] (legs below minTradeUsd), totalTradeUsd }. Use to DECIDE whether/what to rebalance before committing a rebalance_create plan, or to size a one-off manual rebalance. Targets must sum to 100% (same rule as rebalance_create). Deterministic given the portfolio snapshot; no plan row, no engine, no keystore. Errors: INVALID_PARAMS (targets don't sum to 100, <2 targets), UNKNOWN_CHAIN.",
    {
      targets: z
        .array(
          z.object({
            token: z.string().describe("Token symbol (ETH/USDC/WBTC) or 0x address."),
            targetPct: z.number().min(0).max(100).describe("Target weight % of portfolio. Must sum to 100."),
          }),
        )
        .min(2)
        .describe("Target weights. ≥2 entries; must sum to exactly 100% (±0.01)."),
      chain: z.string().optional().describe("Chain (default: active chain)."),
      account: z.string().optional().describe("Account label (default: active account)."),
      quoteToken: z.string().optional().describe("Routing anchor (default: USDC). The token corrective trades route through; excluded from the trade list."),
      minTradeUsd: z.number().nonnegative().optional().describe("Per-leg min USD; sub-threshold legs land in skipped[]. Default 0 (show every leg)."),
      driftThresholdPct: z.number().min(0).max(100).optional().describe("Optional: contextualize wouldFire — true when maxDriftPct ≥ this (the threshold a deployed plan would use)."),
      paper: z.boolean().optional().describe("Evaluate against the VIRTUAL paper book (paper_balances) instead of on-chain holdings. Default false."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("rebalance_preview", rt.opts, input, input.chain, async () => {
            const config = rt.getConfig();
            const chain = input.chain ?? config.activeChain;
            const account = input.account ?? config.activeAccount ?? "default";
            const { gatherRebalancePreview } = await import("../rebalance.js");
            return {
              ok: true,
              ...(await gatherRebalancePreview({
                targets: input.targets,
                chain,
                account,
                quoteToken: input.quoteToken ?? "USDC",
                config,
                logger: rt.opts.logger,
                paper: input.paper,
                minTradeUsd: input.minTradeUsd,
                driftThresholdPct: input.driftThresholdPct,
              })),
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "rebalance_create",
    "Create a portfolio rebalance plan: a declarative target-weight spec that the engine periodically evaluates and corrects toward. Each plan covers ONE chain + ONE account; multi-chain operators create one plan per chain. On each engine tick the plan fetches the portfolio, computes per-target drift, and (if max drift >= driftThresholdPct) fires the corrective trades through executeTrade — every safety guardrail (USD limits, slippage cap, gas budget, position limits) applies just like a manual swap. Trades route through quoteToken (defaults to chain USDC): over-weight tokens sell INTO it, then under-weight tokens BUY FROM it. Per-leg trades below minTradeUsd skip to avoid gas burn on micro-corrections. Targets MUST sum to exactly 100%. Common patterns: 'core' folio at 60/40 ETH/USDC; bracketed alt-coin sleeve; cash-reserve-floor (one target at 20% USDC). Errors: INVALID_PARAMS (targets don't sum to 100, duplicate tokens, bad cron, malformed dates, slippage out of range, maxRuns ≤ 0), UNKNOWN_CHAIN, UNKNOWN_TOKEN (a target token can't be resolved on this chain). Returns the persisted RebalanceRow with assigned id, status='active', next_run_at computed from the cron.",
    {
      chain: z.string().optional().describe("Chain to operate on (default: active chain)."),
      account: z.string().optional().describe("Account label (default: active account)."),
      name: z.string().optional().describe("Operator label for list views + notifications."),
      targets: z
        .array(
          z.object({
            token: z.string().describe("Token symbol (ETH/USDC/WBTC) or 0x address."),
            targetPct: z.number().min(0).max(100).describe("Target weight as % of portfolio. Must sum to 100 across all targets."),
          }),
        )
        .min(2)
        .describe("Target weights. At least 2 entries required; weights must sum to exactly 100% (±0.01 tolerance)."),
      quoteToken: z.string().optional().describe("Routing anchor for rebalance trades (default: chain USDC). Symbol or 0x address."),
      driftThresholdPct: z.number().positive().max(100).optional().describe("Min drift (any target's |current - target| %) to trigger a fire. Default 5%."),
      minTradeUsd: z.number().nonnegative().optional().describe("Per-leg min trade USD; sub-threshold legs skip. Default $10."),
      cron: z.string().optional().describe("5-field cron expression in UTC for evaluation cadence. Default `0 */6 * * *` (every 6 hours). Macros @hourly / @daily / @weekly / @monthly accepted."),
      slippageBps: z.number().int().min(1).max(10_000).optional(),
      autoSlippage: z.boolean().optional(),
      startAt: z.string().optional().describe("ISO-8601 timestamp before which the engine skips fires."),
      endAt: z.string().optional().describe("ISO-8601 timestamp at which the plan flips to completed."),
      maxRuns: z.number().int().positive().optional().describe("Lifetime cap on EXECUTED rebalances. Failed attempts (portfolio fetch error, wallet failure) do not consume quota."),
      strategy: z.string().max(100).optional(),
      note: z.string().optional(),
      paper: z
        .boolean()
        .optional()
        .describe("v27: paper plan — drift is evaluated against the VIRTUAL book (paper_balances) and corrective legs route through executePaperTrade. No chain trades, no keystore. Seed the book first via paper_deposit; inspect fills via paper_trades (source='rebalance'). Default false."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("rebalance_create", rt.opts, input, input.chain, async () => {
            const t0 = Date.now();
            const config = rt.getConfig();
            const wallet = await rt.getContext(input.chain, input.account);
            const { createRebalancePlanRow } = await import("../rebalance.js");
            const row = createRebalancePlanRow(
              {
                name: input.name,
                account: wallet.label,
                chain: wallet.chain,
                quoteToken: input.quoteToken,
                targets: input.targets,
                driftThresholdPct: input.driftThresholdPct,
                minTradeUsd: input.minTradeUsd,
                cron: input.cron,
                startAt: input.startAt,
                endAt: input.endAt,
                maxRuns: input.maxRuns,
                slippageBps: input.slippageBps,
                autoSlippage: input.autoSlippage,
                strategy: input.strategy,
                note: input.note,
                paper: input.paper,
              },
              config,
            );
            return { plan: row, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "rebalance_list",
    "List rebalance plans with pre-aggregated status counts. Default status='active'. The `next_run_at` field on each row tells agents when the plan will next be evaluated. Returns { ok, summary: { total, byStatus: {active,paused,completed,cancelled} }, items: RebalanceRow[] }.",
    {
      status: z.enum(["all", "active", "paused", "completed", "cancelled"]).optional(),
      chain: z.string().optional(),
      account: z.string().optional(),
      strategy: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    async (input) => {
      try {
        return ok(
          await runTool("rebalance_list", rt.opts, input, input.chain, async () => {
            const { listRebalancePlans } = await import("../rebalance.js");
            const { rebalancePlanCountsByStatus } = await import("../db.js");
            const items = listRebalancePlans({
              status: input.status ?? "active",
              chain: input.chain,
              account: input.account,
              strategy: input.strategy,
              limit: input.limit,
            });
            const byStatus = rebalancePlanCountsByStatus();
            return { summary: { total: items.length, byStatus }, items };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "rebalance_show",
    "Fetch a single rebalance plan by id, with full last-run telemetry (max drift observed, executed/skipped leg counts, last error). Errors: INVALID_PARAMS (unknown id).",
    { id: z.number().int().positive() },
    async (input) => {
      try {
        return ok(
          await runTool("rebalance_show", rt.opts, input, undefined, async () => {
            const { getRebalancePlanById } = await import("../rebalance.js");
            const row = getRebalancePlanById(input.id);
            if (!row) {
              throw new ToolError("INVALID_PARAMS", `Rebalance plan #${input.id} not found.`, { details: { planId: input.id } });
            }
            return { plan: row };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // rebalance_edit — in-place mutation, completing the primitive-edit
  // triangle (order_edit preserves trailing HWM, schedule_edit
  // preserves run counters, rebalance_edit preserves run_count +
  // last-run telemetry).
  server.tool(
    "rebalance_edit",
    "Edit an active OR paused rebalance plan in-place. State-preserving: run_count / max_runs accounting + last-run telemetry stay (vs cancel+create, which resets them). Editable: targets (re-weighting — same validation as create: sum exactly 100, no dupes; token set changes allowed, the next tick evaluates the new composition), driftThresholdPct, minTradeUsd, cron/every (recomputes next_run_at from now), endAt, maxRuns (>= current run_count), slippageBps, autoSlippage, strategy, note, name, paper. Frozen: chain, account, quote token (the routing anchor — every leg prices through it), startAt. Terminal states (completed/cancelled) reject. Returns { planId, changed, diff: [{field, oldValue, newValue}], plan }. Errors: INVALID_PARAMS (terminal, bad targets, maxRuns < run_count, bad cron, past endAt), SLIPPAGE_TOO_HIGH (exceeds safety.maxSlippageBps).",
    {
      id: z.number().int().positive().describe("Rebalance plan id to edit."),
      targets: z
        .array(z.object({ token: z.string(), targetPct: z.number().positive() }))
        .optional()
        .describe("Replacement target list — must sum to exactly 100."),
      driftThresholdPct: z.number().optional().describe("New drift threshold in percent, (0, 100)."),
      minTradeUsd: z.number().optional().describe("New per-leg minimum trade size in USD (>= 0)."),
      cron: z.string().optional().describe("New cron expression. Mutually exclusive with every."),
      every: z.string().optional().describe("New duration shorthand (6h, 1d, 7d)."),
      endAt: z.string().nullable().optional().describe("New ISO-8601 end-at (future). Pass null to clear."),
      maxRuns: z.number().int().min(1).nullable().optional().describe("New lifetime cap on EXECUTED rebalances. Must be >= current run_count. Pass null to clear."),
      slippageBps: z.number().int().min(1).max(10_000).optional(),
      autoSlippage: z.boolean().optional(),
      strategy: z.string().optional(),
      note: z.string().optional(),
      name: z.string().optional(),
      paper: z.boolean().optional().describe("Flip the plan between paper (virtual book) and real trading."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("rebalance_edit", rt.opts, input, undefined, async () => {
            const { editRebalancePlan } = await import("../rebalanceEdit.js");
            const changes: Record<string, unknown> = {};
            for (const k of [
              "targets", "driftThresholdPct", "minTradeUsd", "cron", "every",
              "endAt", "maxRuns", "slippageBps", "autoSlippage", "strategy",
              "note", "name", "paper",
            ] as const) {
              if (k in input && (input as Record<string, unknown>)[k] !== undefined) {
                changes[k] = (input as Record<string, unknown>)[k];
              }
            }
            const result = editRebalancePlan({ id: input.id, changes });
            return {
              planId: input.id,
              changed: result.diff.length > 0,
              diff: result.diff,
              plan: result.plan,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "rebalance_pause",
    "Pause an active rebalance plan. The engine ignores paused plans; resume via rebalance_resume. Errors: INVALID_PARAMS (unknown id, not active).",
    { id: z.number().int().positive() },
    async (input) => {
      try {
        return ok(
          await runTool("rebalance_pause", rt.opts, input, undefined, async () => {
            const { pauseRebalancePlanById } = await import("../rebalance.js");
            return { plan: pauseRebalancePlanById(input.id) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "rebalance_resume",
    "Resume a paused rebalance plan. next_run_at is recomputed from the cron at resume time (engine does NOT backfill missed evaluation windows). Errors: INVALID_PARAMS (unknown id, not paused).",
    { id: z.number().int().positive() },
    async (input) => {
      try {
        return ok(
          await runTool("rebalance_resume", rt.opts, input, undefined, async () => {
            const { resumeRebalancePlanById } = await import("../rebalance.js");
            return { plan: resumeRebalancePlanById(input.id) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "rebalance_cancel",
    "Cancel a rebalance plan (terminal — use rebalance_pause for temporary). Idempotent on already-cancelled / completed rows. Errors: INVALID_PARAMS (unknown id).",
    { id: z.number().int().positive() },
    async (input) => {
      try {
        return ok(
          await runTool("rebalance_cancel", rt.opts, input, undefined, async () => {
            const { cancelRebalancePlanById } = await import("../rebalance.js");
            return { plan: cancelRebalancePlanById(input.id) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "rebalance_run",
    "Run ONE engine tick for rebalance plans: walk every active plan with next_run_at <= now, fetch its portfolio, compute drift, fire corrective trades when max drift >= threshold. Each plan is processed independently — a single bad plan can't kill the tick. Returns the RebalanceTickReport with per-plan fire status (executed / skipped / failed / completed) including per-leg trade results when fires. Pass dryRun=true to evaluate without sending tx. Use this on a schedule (engine_run handles this automatically when the rebalance worker is enabled) OR for one-shot agent-driven evaluation.",
    {
      chain: z.string().optional(),
      account: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async (input) => {
      try {
        return ok(
          await runTool("rebalance_run", rt.opts, input, input.chain, async () => {
            const { runRebalanceTick } = await import("../rebalance.js");
            return await runRebalanceTick({
              chain: input.chain,
              account: input.account,
              password: input.dryRun ? undefined : rt.opts.walletPass,
              dryRun: input.dryRun,
              logger: rt.opts.logger,
            });
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── transfer ──────────────────────────────────────────────
  server.tool(
    "transfer",
    "Send a native asset or ERC20 token to an address. Uses the same safety guardrails as swaps (per-tx / daily USD limits, token blacklist). Pass simulate=true to dry-run. amount accepts \"max\" to send the full balance (with a gas reserve when native; the held-back amount is surfaced as result.gasReserveNative). Units: decimal amount in token units. Result also carries: `recipientIsKnown` (iter678 boolean — true when recipient is in the address book, false when first-time, absent when lookup failed), `recipientLabel` (the @alias when known), `recipientNote` (iter680 free-form note when present, e.g. 'Coinbase deposit'), `recentFailurePattern` (iter683 — { total, windowDays, dominantReason, dominantCount } — set when ≥3 transfers to THIS recipient failed in last 7d with ≥50% share on one reason; treat as signal to verify the recipient is still accepting transfers before retrying), and on failed sends `revertReason` (iter677 — eth_call-replay-decoded reason for the on-chain revert). Errors: INVALID_PARAMS (bad address / self-send / zero amount / zero-address recipient unless allowBurn=true), INSUFFICIENT_BALANCE (fail-fast pre-submit check — details.have/need name the shortfall; nextActions carries a scoped holdings call), TOKEN_BLOCKED, AMOUNT_EXCEEDS_LIMIT (per-tx / daily USD cap — for daily, details.remainingToday names the exact remaining budget so the agent can resize without re-deriving), TX_TIMEOUT (tx sent but no receipt within waitForReceipt timeout — the row is persisted as pending; the reconcile tool / 'tradekit reconcile' will resolve it), TX_REVERTED (sendTransaction itself rejected — gas too low, nonce conflict, replacement-underpriced — distinct from on-chain revert which surfaces as status=\"failed\"; classifyReason patterns provide actionable nextActions). On a reverted on-chain transfer (status=\"failed\") the result carries explorerUrl + a viewTx nextAction; the tx still cost gas.",
    {
      chain: z.string().optional(),
      token: z.string().describe("Token symbol/address or 'ETH'/'NATIVE'."),
      to: z
        .string()
        .regex(
          /^(?:0x[0-9a-fA-F]{40}|@[a-zA-Z0-9_-]+)$/,
          "to must be 0x-prefixed 40 hex chars OR an @alias from the address book",
        )
        .describe("Recipient — either a 0x-prefixed address OR an @alias from the address book (resolved before the transfer fires)."),
      amount: z.string().describe("Decimal amount in token units, or \"max\" for full balance."),
      simulate: z.boolean().optional().describe("If true, simulate only (no tx sent). Default: false (real transfer is sent)."),
      note: z.string().optional().describe("Optional annotation saved alongside the transfer row (campaign tag, intent, etc)."),
      account: z.string().optional().describe("HD account label override; defaults to active."),
      allowBurn: z.boolean().optional().describe("Explicit opt-in for sending to the zero address (a permanent burn). Defaults false — tradekit refuses the 0x0 recipient without this flag, since the all-zeros address is a common copy-paste typo with catastrophic consequences."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("transfer", rt.opts, input, input.chain, async () => {
            const config = rt.getConfig();
            const wallet = await rt.getContext(input.chain, input.account);
            const profile = resolveProfile(wallet.chain, config);
            const tokenResolved =
              input.token.toUpperCase() === "ETH" || input.token.toUpperCase() === "NATIVE"
                ? "ETH"
                : isAddress(input.token, { strict: false })
                  ? (input.token as `0x${string}`)
                  : resolveToken(profile, input.token);
            if (!tokenResolved) {
              // Iter353: shared helper from chains.ts surfaces the iter345 "Did you mean"
              // hint via closestMatch (skipped for 0x-prefixed inputs).
              throw unknownTokenError("token", input.token, profile);
            }
            // Iter614: resolve @alias recipients via the address book.
            // Schema regex already validated the input shape (either 0x... or @name).
            const { resolveRecipient, loadAddressBook, findByAddress, assertTransferAllowed } = await import("../addressBook.js");
            const { address: resolvedTo } = resolveRecipient(input.to);
            // v91: fund-exfiltration gate — when transferAllowlistOnly is on, an
            // agent may only transfer to operator-curated (address-book)
            // recipients. The CLI path (operator) skips this. Simulate is also
            // gated so a dry-run can't be used to confirm an unlisted recipient.
            assertTransferAllowed({
              allowlistOnly: config.safety.transferAllowlistOnly === true,
              recipientKnown: findByAddress(loadAddressBook(), resolvedTo) != null,
              recipient: resolvedTo,
            });
            const { executeTransfer } = await import("../transfer.js");
            return await executeTransfer(
              {
                token: tokenResolved as `0x${string}` | "ETH",
                to: resolvedTo as `0x${string}`,
                amount: input.amount,
                simulate: input.simulate ?? false,
                note: input.note,
                allowBurn: input.allowBurn,
              },
              {
                publicClient: wallet.publicClient,
                walletClient: wallet.walletClient,
                profile,
                config,
                logger: rt.opts.logger,
                accountLabel: wallet.label,
              },
            );
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );
};
