// MCP data / inspect tools: chains, gas, price, holdings, trending, pnl, viewTx. All
// read-only; none mutate chain state or wallet config.

import { z } from "zod";
import { isAddress, type Address } from "viem";
import { resolveProfile, loadConfig } from "../config.js";
import { resolveToken, listChains, unknownTokenError } from "../chains.js";
import { activeWalletLabel } from "../wallet.js";
import { getCurrentPrice, getPriceHistory } from "../price.js";
import { holdingsMultiChain } from "../holdings.js";
import { searchToken, tokenByAddress, trendingOnChain } from "../trending.js";
import { computePnL } from "../pnl.js";
import { ToolError, toToolError } from "../errors.js";
import { ok, fail, runTool, type RegisterFn } from "./runtime.js";

export const registerDataTools: RegisterFn = (server, rt) => {
  // ── chains ────────────────────────────────────────────────
  server.tool(
    "chains",
    "List supported chain names — built-in profiles (base, arbitrum, optimism, etc.) plus any custom chains the operator has wired up via `config push chains.<name>`. Returns { ok, chains[] }. Read-only, cheap; no errors fire on the happy path. Use as a discovery call when an agent needs to enumerate which chains it can target before calling chain-scoped tools.",
    {},
    async () => {
      try {
        const config = rt.getConfig();
        const customChains = Object.keys(config.chains ?? {}).filter(
          (c) => !listChains().includes(c.toLowerCase()),
        );
        // Same custom-chain inclusion as iter161 / iter211 / iter231 / iter232. Agent
        // calling this tool to enumerate options sees ALL chains the operator has
        // wired up, not just the six built-ins.
        return ok({ ok: true, chains: [...listChains(), ...customChains] });
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── gas ───────────────────────────────────────────────────
  server.tool(
    "gas",
    "Current gas conditions for a chain: EIP-1559 base / priority / max fee (gwei), native price (USD), estimated cost of a typical aggregator swap (native + USD), and a coarse verdict (cheap/normal/expensive). Result also carries `elapsedMs` (iter913 — wall-clock for the gas-snapshot RPC fan-out; chain congestion correlates with elevated elapsed, so agents tail this as an early indicator of mainnet gas spikes). Use this before submitting a trade — gas spikes on Ethereum and Polygon are real production hazards. Errors: RPC_FAILED (chain unreachable on the configured RPCs — nextActions carries a doctor call with chain pre-scoped, details.{chain, operation, reason}); UNKNOWN_CHAIN (typo or missing custom-chain config — details.suggestion carries the closest match when available).",
    {
      chain: z.string().optional().describe("Chain name (default: active chain)."),
      chains: z.array(z.string()).optional().describe("Multiple chains; if set, returns an array."),
    },
    async ({ chain, chains }) => {
      try {
        return ok(
          await runTool("gas", rt.opts, { chain, chains }, chain, async () => {
            // Iter913: wall-clock for the (possibly multi-chain) gas snapshot
            // RPC fan-out. Gas is consulted pre-trade; latency spikes on Eth/
            // Polygon mainnet correlate with the very gas spikes the tool is
            // meant to detect.
            const t0 = Date.now();
            const { gasSnapshot } = await import("../gas.js");
            const config = rt.getConfig();
            const targets = chains && chains.length > 0 ? chains : [chain ?? config.activeChain];
            const snapshots = await Promise.all(
              targets.map(async (c) => {
                try {
                  const profile = resolveProfile(c, config);
                  return await gasSnapshot(profile, config.chains[c]?.rpcs ?? [], rt.opts.logger);
                } catch (e) {
                  return { error: (e as Error).message, chain: c };
                }
              }),
            );
            const elapsedMs = Date.now() - t0;
            return targets.length === 1
              ? { ok: true, units: { gwei: "gwei", native: "decimal native", usd: "USD" }, ...snapshots[0], elapsedMs }
              : { ok: true, units: { gwei: "gwei", native: "decimal native", usd: "USD" }, snapshots, elapsedMs };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── price ─────────────────────────────────────────────────
  server.tool(
    "price",
    "Current USD price and historical trend for a token. Returns `{ ok, units, token, current, history, timestamp, elapsedMs }`. Iter913 — elapsedMs is wall-clock for the parallel CoinGecko + DexScreener fetch + fallback chain; agents tail this to detect external-API degradation. Units: price is USD per token. Errors: UNKNOWN_TOKEN (symbol not in the chain's known list — pass an address instead or run `tradekit token add`); UNKNOWN_CHAIN (typo or missing custom-chain config — details.suggestion carries the closest match when available). `period` is validated as an enum at the MCP boundary; values other than the four allowed periods are rejected before reaching the tool.",
    {
      chain: z.string().optional(),
      token: z.string().optional().describe("Token symbol or address. Default: native (ETH)."),
      period: z.enum(["1d", "1w", "1m", "1y"]).optional(),
    },
    async ({ chain, token, period }) => {
      try {
        return ok(
          await runTool("price", rt.opts, { chain, token, period }, chain, async () => {
            // Iter913: wall-clock for the parallel current-price + history
            // fetch (CoinGecko + DexScreener fallback chain). External-API
            // latency matters; iter912 holdings already documents the
            // pattern for cross-API surfaces.
            const t0 = Date.now();
            const config = rt.getConfig();
            const profile = resolveProfile(chain ?? config.activeChain, config);
            // Pre-iter122 there was a "?? (token.startsWith('0x') ? ...)" fallback that
            // bypassed validation — historically there to catch malformed-but-0x-prefixed
            // inputs that the old resolveToken rejected. Now that resolveToken uses
            // viem's isAddress (proper hex+length check), the fallback would just leak
            // bad bytes downstream. Drop it; UNKNOWN_TOKEN is the honest answer.
            const resolved = token ? resolveToken(profile, token) : profile.weth;
            if (!resolved) {
              // Iter297: same actionable error shape as the CLI's price command
              // (iter296) — name the chain + suggest the address fallback.
              // Iter353: shared helper now adds the iter345 "Did you mean" suggestion
              // for symbol-like inputs (skips 0x addresses, where Levenshtein is noise).
              throw unknownTokenError("token", token ?? "(none)", profile);
            }
            const [current, history] = await Promise.all([
              getCurrentPrice(resolved, rt.opts.logger),
              getPriceHistory(resolved, period ?? "1d", rt.opts.logger),
            ]);
            // Iter238: response-envelope timestamp for freshness — every other
            // snapshot/result tool has one (iter218-222). Matters here because
            // upstream price API responses are cached (iter132) and consumers
            // re-querying may want to see how stale the answer is.
            return {
              ok: true,
              units: { price: "USD per token" },
              token: resolved,
              current,
              history,
              timestamp: new Date().toISOString(),
              elapsedMs: Date.now() - t0,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── price_context (v64) ───────────────────────────────────
  // Entry-timing context: where the price sits in its recent range +
  // trend + volatility. Complements `price` (spot + raw history blob) and
  // `trending` (volume/liquidity discovery) — this is the "WHEN" signal.
  server.tool(
    "price_context",
    "v64: recent price CONTEXT for entry/exit timing — where the current price sits in its recent range, the trend, and how choppy it's been. Distinct from `price` (spot + a raw history blob) and `trending` (volume/liquidity discovery): this answers WHEN, not just what it costs or what's hot. Returns { ok, token, coinId, windowDays, samples, currentPriceUsd, low, high, rangePositionPct (0=at low, 100=at high; null if flat), changePctWindow, changePct24h (null if window <24h), rangeWidthPct, volatilityPct (stddev of period returns; null if <2 samples), summary (plain-language one-liner) }. Use before sizing/timing a buy: 'near the 7d high' vs 'near the 7d low' is a very different entry. `days` is the lookback window (default 7). Returns ok:false UNKNOWN_TOKEN when the token has no CoinGecko mapping (too new / unmapped) — degrade gracefully, don't treat as fatal. Deterministic given the series; source is the same CoinGecko market_chart the backtester uses. Errors: UNKNOWN_TOKEN (symbol not on the chain), UNKNOWN_CHAIN.",
    {
      chain: z.string().optional(),
      token: z.string().optional().describe("Token symbol or address. Default: native (mapped to WETH for the price series)."),
      days: z.number().int().min(1).max(3650).optional().describe("Lookback window in days. Default 7."),
    },
    async ({ chain, token, days }) => {
      try {
        return ok(
          await runTool("price_context", rt.opts, { chain, token, days }, chain, async () => {
            const config = rt.getConfig();
            const profile = resolveProfile(chain ?? config.activeChain, config);
            const resolved = token ? resolveToken(profile, token) : profile.weth;
            if (!resolved) throw unknownTokenError("token", token ?? "(none)", profile);
            const tokenAddr = /^0x[0-9a-fA-F]{40}$/.test(resolved) ? resolved : profile.weth;
            const { gatherPriceContext } = await import("../priceContext.js");
            const report = await gatherPriceContext({
              tokenAddress: tokenAddr,
              windowDays: days ?? 7,
              config,
              logger: rt.opts.logger,
            });
            if (report == null) {
              throw new ToolError(
                "UNKNOWN_TOKEN",
                `No CoinGecko price history for ${token ?? resolved} — too new or unmapped; price context unavailable.`,
              );
            }
            return { ok: true, token: (token ?? "ETH").toUpperCase(), ...report };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── trade_sizing (v70) ────────────────────────────────────
  // The actionable inverse of safety_headroom: not "how much room is left
  // per limit" but "what's the LARGEST single trade admissible right now,
  // and which limit binds". Over-sizing is a top way an autonomous agent
  // blows up; this converts the safety posture into a concrete safe size.
  server.tool(
    "trade_sizing",
    "v70: solve for the MAX single trade admissible right now. Where `preflight_trade` answers 'is THIS size OK?' and `safety_headroom` reports 'room left per limit', this answers the question every trade faces — 'what's the LARGEST I can spend before something rejects it, and which limit binds?'. Returns { ok, account, chain, direction, strategy, token, maxTradeUsd (min across all USD limits; null = unbounded by policy), binding (the tightest constraint: {kind,label,capUsd,scope,detail}), constraints[] (every USD limit considered, ascending), priceUsd, maxBaseAmount (maxTradeUsd ÷ price), caveats[] }. Folds in: per-tx cap, daily-remaining, the matching strategy budget's tightest window (per-fire/lifetime/daily — pass `strategy`), and on a BUY the net-exposure position cap's cost room (pass `token`). Reuses the SAME consumption lookups the real enforcers use (zero divergence). Best-effort base-token price → maxBaseAmount + base-amount cap conversion; caveats flag anything NOT folded in (missing strategy/token, base cap w/o price) so the number is never silently over-trusted. Always recommends preflighting the chosen size. Deterministic given consumption + price. Errors: UNKNOWN_TOKEN, UNKNOWN_CHAIN.",
    {
      direction: z.enum(["buy", "sell"]).describe("buy = spend quote to acquire base; sell = dispose base. Position caps only constrain buys."),
      chain: z.string().optional(),
      token: z.string().optional().describe("Base token symbol or address — needed to scope net-exposure position caps. Default: native (WETH for pricing)."),
      strategy: z.string().optional().describe("Strategy tag this trade would carry — folds the matching strategy budget into the ceiling."),
    },
    async ({ direction, chain, token, strategy }) => {
      try {
        return ok(
          await runTool("trade_sizing", rt.opts, { direction, chain, token, strategy }, chain, async () => {
            const config = rt.getConfig();
            const profile = resolveProfile(chain ?? config.activeChain, config);
            const resolved = token ? resolveToken(profile, token) : profile.weth;
            if (!resolved) throw unknownTokenError("token", token ?? "(none)", profile);
            const priceAddr = /^0x[0-9a-fA-F]{40}$/.test(resolved) ? resolved : profile.weth;
            // Best-effort price for the token-amount conversion — sizing is
            // policy-limit based, so a missing price degrades to a caveat.
            const priceUsd = await getCurrentPrice(priceAddr, rt.opts.logger).catch(() => null);
            const { gatherTradeSizing } = await import("../tradeSizing.js");
            const report = gatherTradeSizing({
              direction,
              config,
              chain: chain ?? config.activeChain ?? undefined,
              strategy: strategy ?? null,
              token: token ?? (resolved === profile.weth ? profile.nativeSymbol : resolved),
              priceUsd,
            });
            return { ok: true, ...report };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── holdings ──────────────────────────────────────────────
  server.tool(
    "holdings",
    "Multi-chain balances for any address (defaults to the active wallet). Includes native + the chain profile's known token list. Pass EITHER `address` (arbitrary 0x address) OR `account` (HD account label) — not both. Returns { ok, units, summary, reports, errors, elapsedMs, filtered_dust_count?, filtered_dust_usd? }. Iter781 — summary pre-computes cross-chain aggregates ({chainCount, chainsWithBalances, totalUsd, totalPositions, totalUnpricedPositions, errorCount}) so agents triage at a glance without iterating reports[]. Iter912 — elapsedMs is wall-clock for the parallel multi-chain RPC fan-out + per-token price lookups; agents in watch mode detect chain-level RPC degradation as the elapsed jumps. Each balance entry carries `lastTradeAt` (iter718 — ISO timestamp of the most-recent trade on this chain+symbol for the resolved account; absent when never traded — e.g. airdrops/deposits) so agents triage active positions vs long-held / dust without a follow-up recent_trades call. `min_usd` (iter711): filter out priced positions below this USD threshold — unpriced tokens always show (can't classify without USD). Filtered count + total USD surface as `filtered_dust_count` and `filtered_dust_usd` per-chain, plus across chains in the response root, so agents see exactly what was hidden. Per-chain RPC failures (one chain down) are reported as entries in result.errors[] and don't fail the whole call; if EVERY chain's read fails the call throws RPC_FAILED with a doctor next-action. Errors: INVALID_PARAMS (both address + account set, or empty chains array), UNKNOWN_ACCOUNT (typo'd account label — details.suggestion may carry a close match), RPC_FAILED (every chain unreachable).",
    {
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "address must be 0x-prefixed 40 hex chars (20-byte EVM address)")
        .optional()
        .describe("0x address to query. Mutually exclusive with `account`."),
      account: z.string().optional().describe("HD account label override; defaults to active. Mutually exclusive with `address`."),
      chains: z.array(z.string()).optional().describe("Subset of chain names. If omitted, scans all built-in chains plus any custom chains defined in config."),
      min_usd: z.number().nonnegative().optional().describe("Iter711: filter priced positions below this USD threshold. Unpriced positions ALWAYS show. Hidden positions are summarized in filtered_dust_count + filtered_dust_usd."),
    },
    async ({ address, account, chains, min_usd }) => {
      try {
        return ok(
          await runTool("holdings", rt.opts, { address, account, chains, min_usd }, undefined, async () => {
            // Iter912: wall-clock for the multi-chain holdings fan-out
            // (parallel RPC + per-token price lookups + last-trade DB query).
            // Latency dominates this call (4-6 chains × 100-500ms each);
            // tracking it lets agents in watch mode detect chain-level RPC
            // degradation as the elapsed jumps.
            const t0 = Date.now();
            // Iter266: reject the ambiguous "both" case explicitly. Pre-iter266 address
            // silently won and account was ignored; an agent passing both got no signal
            // that one of its parameters was discarded. Match the CLI's iter265 behavior
            // so an agent gets the same contract across CLI/MCP surfaces.
            if (address && account) {
              throw new ToolError(
                "INVALID_PARAMS",
                `Pass either address OR account, not both. Got address="${address}" and account="${account}".`,
              );
            }
            const config = rt.getConfig();
            let target = address as Address | undefined;
            if (!target) {
              // No raw address — resolve via getContext so `account` overrides the active.
              const wallet = await rt.getContext(undefined, account);
              target = wallet.account.address;
            }
            const { reports, errors } = await holdingsMultiChain(target, config, rt.opts.logger, chains);
            // Iter718: per-(chain, symbol) lastTradeAt for agent triage —
            // parallel to iter716 CLI surface. Scope to the resolved
            // `account` when one was passed so a raw-address query (no
            // operator account context) returns global last-trade info.
            const { lastTradeAtBySymbol } = await import("../db.js");
            const lastMap = lastTradeAtBySymbol(account ? { account } : {});
            // Iter711: apply dust filter to the response. Unpriced balances
            // ALWAYS pass through (can't decide); only `usd != null && usd <
            // min_usd` is filtered. Summary fields communicate what was hidden.
            // Iter718: also enrich kept balances with lastTradeAt when known.
            let totalFilteredCount = 0;
            let totalFilteredUsd = 0;
            const filteredReports = reports.map((r) => {
              let filteredCount = 0;
              let filteredUsd = 0;
              const kept = r.balances
                .filter((b) => {
                  if (min_usd != null && b.usd != null && b.usd < min_usd) {
                    filteredCount += 1;
                    filteredUsd += b.usd;
                    return false;
                  }
                  return true;
                })
                .map((b) => {
                  const last = lastMap.get(`${r.chain}:${b.symbol.toUpperCase()}`);
                  return last ? { ...b, lastTradeAt: last } : b;
                });
              totalFilteredCount += filteredCount;
              totalFilteredUsd += filteredUsd;
              return {
                ...r,
                balances: kept,
                ...(filteredCount > 0
                  ? { filtered_dust_count: filteredCount, filtered_dust_usd: filteredUsd }
                  : {}),
              };
            });
            // Iter781: pre-computed cross-chain summary so agents don't iterate
            // reports[] to learn aggregates. Symmetric with iter766/767/779/780
            // summary fields. Each entry is well-defined for the empty case:
            //   - chainCount: number of chains scanned (including failed)
            //   - chainsWithBalances: chains where at least one non-zero balance
            //   - totalUsd: sum across reports' totalUsd (priced only — honest)
            //   - totalPositions: total non-zero balances across all reports
            //   - totalUnpricedPositions: same but with usd == null
            //   - errorCount: failed-chain count (mirrors errors.length)
            let totalUsd = 0;
            let chainsWithBalances = 0;
            let totalPositions = 0;
            let totalUnpricedPositions = 0;
            for (const r of filteredReports) {
              if (typeof r.totalUsd === "number") totalUsd += r.totalUsd;
              const nonZero = r.balances.filter((b) => parseFloat(b.amount) > 0);
              if (nonZero.length > 0) chainsWithBalances += 1;
              for (const b of nonZero) {
                totalPositions += 1;
                if (b.usd == null) totalUnpricedPositions += 1;
              }
            }
            return {
              ok: true,
              units: { amount: "decimal", usd: "USD" },
              summary: {
                chainCount: filteredReports.length + errors.length,
                chainsWithBalances,
                totalUsd,
                totalPositions,
                totalUnpricedPositions,
                errorCount: errors.length,
              },
              reports: filteredReports,
              errors,
              elapsedMs: Date.now() - t0,
              ...(min_usd != null && totalFilteredCount > 0
                ? { filtered_dust_count: totalFilteredCount, filtered_dust_usd: totalFilteredUsd }
                : {}),
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── check_price (iter613) ─────────────────────────────────
  // Cross-source price sanity probe. Fans out to CoinGecko + DexScreener in
  // PARALLEL (vs the fallback chain getCurrentPrice uses) so the agent sees
  // BOTH numbers + the divergence. Flags pool manipulation / stale-liquidity /
  // honeypot pricing tricks that a single-oracle preview would miss.
  server.tool(
    "check_price",
    "Cross-source price sanity check. Fans out to CoinGecko and DexScreener in parallel and compares — flags divergence beyond tolerance (default 5%) as 'suspicious', beyond extreme (default 20%) as 'extreme'. Returns { ok, token, coinGeckoPrice, dexScreenerPrice, absoluteDiff, divergencePct, tolerancePct, extremePct, verdict, reason, timestamp, elapsedMs }. Iter914 — elapsedMs is wall-clock for the parallel cross-source fetch; useful to detect external-API rate limiting. verdict: 'ok' (sources agree) | 'suspicious' (5-20% apart, possibly low liquidity or stale data) | 'extreme' (>20% apart, likely pool manipulation or honeypot price trick) | 'one_source' (only one returned, no cross-check possible) | 'unknown' (neither tracks this token). Use BEFORE trading an unknown token to verify the on-chain DEX price isn't being spoofed.",
    {
      token: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "token must be 0x-prefixed 40 hex chars (20-byte EVM address)")
        .describe("Token address to cross-check."),
      tolerancePct: z
        .number()
        .positive()
        .max(100)
        .optional()
        .describe("Divergence % above which verdict='suspicious' (default 5)."),
      extremePct: z
        .number()
        .positive()
        .max(1000)
        .optional()
        .describe("Divergence % above which verdict='extreme' (default 20)."),
    },
    async ({ token, tolerancePct, extremePct }) => {
      try {
        return ok(
          await runTool("check_price", rt.opts, { token, tolerancePct, extremePct }, undefined, async () => {
            // Iter914: wall-clock for the parallel CoinGecko + DexScreener
            // fetch. Cross-check tool is called pre-trade for unknown tokens;
            // latency degradation on either source needs visibility.
            const t0 = Date.now();
            const { crossCheckPrice } = await import("../priceCrossCheck.js");
            const check = await crossCheckPrice({
              tokenAddress: token,
              logger: rt.opts.logger,
              tolerancePct,
              extremePct,
            });
            return { ok: true, ...check, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── portfolio (iter605) ───────────────────────────────────
  // Aggregate `holdings` across multiple accounts in one call. Closes the gap
  // pre-iter605 where an agent inspecting an HD wallet with 5 accounts had to
  // dispatch 5 separate `holdings` calls + fold the results in-agent.
  server.tool(
    "portfolio",
    "Aggregate holdings across multiple accounts and chains in one call. Returns { ok, accounts[], chains[], snapshots[], errors[], totalUsd, unpricedPositionCount, tokens[], concentration, severity, recommendedActions[] } where tokens[] is per-token roll-up sorted by totalUsd desc with percentOfPortfolio + perChain breakdown + `lastTradeAt` (iter719 — MAX across contributing chains of when this symbol last traded; absent for never-traded tokens like airdrops/deposits), and concentration carries top1/top3/top5 cumulative %. v72: `concentrationRisk` is the GUARDRAIL verdict against safety.maxConcentrationPct — { thresholdPct, verdict ('ok'|'warn'|'unconfigured'), largestPct, largestSymbol, breaches[] {symbol, percentOfPortfolio, overByPct}, summary }. This catches the CROSS-STRATEGY blind spot per-(strategy,token) position caps miss: several strategies can each stay within their cap while the whole book drifts into one token. verdict='unconfigured' means no limit is set (a visible gap, surfaced in `safety review` too); 'warn' flips top-level severity to 'warn'. Filters: `accounts` accepts an array of labels OR \"all\" (default — every HD account + keystore); `chains` defaults to all built-in + custom (same as holdings). Per-(account, chain) failures land in errors[] without aborting — operator with one bad RPC still sees the rest of the portfolio. Unpriced positions count separately so totalUsd is honest (not silently undercounting tokens without a price). Iter807: top-level `severity` is 'ok' (clean scan) or 'warn' (any errors[] entry OR stale sync bookmark detected) — branch on this for at-a-glance health. Iter833: `recommendedActions[]` carries structured NextAction[] for stale-sync recovery + per-chain scan-error follow-ups; empty when severity='ok'. Use as a portfolio overview / risk snapshot; for a single account's per-chain breakdown use `holdings` instead. Errors: UNKNOWN_ACCOUNT (typo'd label in the accounts array — details.suggestion may carry a close match), WALLET_NOT_FOUND (no accounts configured at all).",
    {
      accounts: z
        .union([z.array(z.string()), z.literal("all")])
        .optional()
        .describe("Array of account labels, or the string \"all\" (default). Omit to scan every HD + keystore account."),
      chains: z.array(z.string()).optional().describe("Subset of chain names. Omit to scan every built-in + custom chain."),
      limit: z.number().int().positive().max(100).optional().describe("Max number of token rows in result.tokens[] (default 50). The roll-up itself is computed across ALL tokens; this only trims the display."),
    },
    async ({ accounts, chains, limit }) => {
      try {
        return ok(
          await runTool("portfolio", rt.opts, { accounts, chains, limit }, undefined, async () => {
            const config = rt.getConfig();
            const { resolveAccountsForPortfolio, aggregatePortfolio } = await import("../portfolio.js");
            const { listAccounts } = await import("../accounts.js");
            const { getKeystoreAddress } = await import("../wallet.js");
            const { KEYSTORE_LABEL } = await import("../constants.js");
            const { unknownAccountError } = await import("../accounts.js");

            // Validate account labels at the boundary before any chain read.
            // Same iter344-style suggestion mechanism as the rest of the codebase.
            let acctSpec: string[] | "all" | undefined;
            if (accounts === undefined || accounts === "all") {
              acctSpec = "all";
            } else {
              const file = listAccounts();
              const knownLabels = [
                ...(file?.accounts ?? []).map((a) => a.label),
                ...(getKeystoreAddress() ? [KEYSTORE_LABEL] : []),
              ];
              for (const p of accounts) {
                if (!knownLabels.includes(p)) throw unknownAccountError(p, knownLabels);
              }
              acctSpec = accounts;
            }

            const resolved = resolveAccountsForPortfolio(acctSpec);
            if (resolved.length === 0) {
              throw new ToolError(
                "WALLET_NOT_FOUND",
                "Portfolio scan requires at least one wallet. Run init or create an account first.",
                { details: { reason: "no_wallet", requestedAccounts: acctSpec === "all" ? "all" : acctSpec } },
              );
            }

            const report = await aggregatePortfolio({ accounts: resolved, config, logger: rt.opts.logger, chains });
            // Iter719: enrich each TokenAggregate with lastTradeAt (MAX across
            // contributing chains' last-trade of this symbol). Parallel to
            // iter717's CLI surface. Done here at the MCP boundary so the
            // pure aggregatePortfolio compute stays DB-free.
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
            const cap = limit ?? 50;
            return {
              ok: true,
              units: { amount: "decimal", usd: "USD", concentrationPct: "percentage 0-100" },
              ...report,
              // Trim tokens[] to the display cap. The aggregate math (totalUsd,
              // concentration) is computed pre-trim so it still reflects the
              // full portfolio — only the per-token detail rows are capped.
              tokens: report.tokens.slice(0, cap),
              tokensReturned: Math.min(report.tokens.length, cap),
              tokensTotal: report.tokens.length,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── open_positions (v65) ──────────────────────────────────
  // Exit-decision context: per open position, cost basis + unrealized P&L
  // + holding period + the tax term it WOULD be if sold now. The exit
  // counterpart to price_context (entry timing); completes v60's realized-
  // gains holding period for OPEN positions.
  server.tool(
    "open_positions",
    "v65: open-position review for EXIT timing. For each currently-held position returns cost basis, current value, unrealized P&L (abs + %), the weighted-average acquisition date, holding days, and — the actionable tax signal — projectedTerm ('short' / 'long' / 'untracked' if sold NOW) + daysToLongTerm (how long until short-term flips to long-term). Plus a summary { totalCostBasisQuote, totalValueQuote, totalUnrealizedQuote, unpricedCount, approachingLongTerm (short-term positions within 30d of long-term) }. Use to decide WHEN to exit: 'WETH is 340d held, 25d to long-term rates — wait' is a concrete decision this surfaces and nothing else did. The exit counterpart to price_context (entry timing) and the open-position completion of the gains report's realized holding period. Runs the same cost-basis walker every P&L surface shares; the strategy tag is stripped so positions are PORTFOLIO-level (total per (chain,token)) unless `strategy` scopes it. Deterministic given live marks. mode='real' (success trades) default; 'paper' reviews the virtual book. Errors: none typical (empty → no positions).",
    {
      mode: z.enum(["real", "paper"]).optional().describe("Default real (success trades). paper reviews the virtual book."),
      account: z.string().optional(),
      chain: z.string().optional(),
      strategy: z.string().optional().describe("Scope to one strategy tag's positions (else portfolio-level across all)."),
      withContext: z.boolean().optional().describe("v67: attach recent price context (range position + trend) per position for EXIT timing — is the price near a recent high (good exit) or low? Each position carries priceContext { windowDays, low, high, rangePositionPct (0=low,100=high), changePctWindow, summary } (null when the token has no CoinGecko mapping). Off by default — it fetches a price series per token (cheap on the v66 cache, but a cold portfolio is N CoinGecko calls)."),
      contextDays: z.number().int().min(1).max(3650).optional().describe("Lookback window (days) for withContext. Default 7."),
    },
    async ({ mode, account, chain, strategy, withContext, contextDays }) => {
      try {
        return ok(
          await runTool("open_positions", rt.opts, { mode, account, chain, strategy, withContext, contextDays }, chain, async () => {
            const { gatherOpenPositions } = await import("../openPositions.js");
            return { ok: true, ...(await gatherOpenPositions({ mode: mode ?? "real", account, chain, strategy, withContext, contextDays, config: rt.getConfig() })) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── position_protection (v76) ─────────────────────────────
  // Cross-references open positions against active stop/trailing sell orders
  // to surface UNPROTECTED downside exposure — a position with no automated
  // exit can crater the book in a crash, and nothing else flags it.
  server.tool(
    "position_protection",
    "v76: which open positions have NO downside protection, and how much value is exposed? Cross-references open positions (v65) against active SELL orders that exit on a fall — a trailing stop or a price_below stop-loss. An autonomous agent accumulates spot positions; one unguarded holding can crater the book in a crash, and no other surface flags it. Returns { ok, positions: [{ chain, token, symbol, heldAmount, heldValueUsd, protectedAmount, unprotectedAmount, unprotectedValueUsd, status ('protected'|'partial'|'unprotected'), protectingOrders[] {id, triggerType, coversAmount, trailPct, targetPriceUsd}, takeProfitOrders }], totalValueUsd, totalUnprotectedValueUsd, unprotectedCount, partialCount, unpricedCount, summary }, sorted most-exposed first. Take-profit orders (price_above sells) are an UPSIDE exit, counted separately — NOT crash protection. Dynamic order sizes resolve: 'max' covers the whole position, 'N%' that fraction. mode='real' (default) audits real holdings; 'paper' the virtual book. Use to find holdings that need a stop, or as a risk gate (totalUnprotectedValueUsd). Deterministic given live marks.",
    {
      mode: z.enum(["real", "paper"]).optional().describe("Default real. paper audits the virtual book."),
      account: z.string().optional(),
      chain: z.string().optional(),
    },
    async ({ mode, account, chain }) => {
      try {
        return ok(
          await runTool("position_protection", rt.opts, { mode, account, chain }, chain, async () => {
            const { gatherPositionProtection } = await import("../positionProtection.js");
            return { ok: true, ...(await gatherPositionProtection({ mode: mode ?? "real", account, chain, config: rt.getConfig() })) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── risk_posture (v78) ────────────────────────────────────
  // Unified runtime risk verdict: synthesizes exposure headroom + portfolio
  // concentration + unprotected value-at-risk + MEV exposure into ONE
  // branchable signal so an agent can halt when its own book turns dangerous.
  server.tool(
    "risk_posture",
    "v78: the single 'is my book in danger RIGHT NOW?' verdict. Synthesizes the runtime risk signals — exposure headroom (v53: tripped/exhausted/approaching limits incl. the drawdown breaker), portfolio concentration (v72), unprotected value-at-risk (v76), and MEV exposure (v77) — into ONE verdict + ranked concerns. Returns { ok, verdict ('ok'|'elevated'|'critical'), concerns: [{ severity ('critical'|'warn'), code, message, source }] (worst-first), checked[] (dimensions evaluated), skipped[] (dimensions that errored — e.g. RPC down), summary }. verdict is 'critical' when any limit is tripped/exhausted (a can't-trade state), 'elevated' on concentration / >50%-unprotected / approaching-limit / MEV warnings, else 'ok'. Adds NO new analysis — pure synthesis of the existing signals, each best-effort. Use as a monitoring gate (halt/page on verdict='critical') or an agent self-check before a trading session — one call instead of polling headroom + concentration + protection + mev separately. Heavier dimensions (concentration, protection) need on-chain reads; a failure degrades that dimension into skipped[], never fabricated.",
    {
      account: z.string().optional(),
      chain: z.string().optional(),
    },
    async ({ account, chain }) => {
      try {
        return ok(
          await runTool("risk_posture", rt.opts, { account, chain }, chain, async () => {
            const { gatherRiskPosture } = await import("../riskPosture.js");
            return { ok: true, ...(await gatherRiskPosture({ config: rt.getConfig(), logger: rt.opts.logger, account, chain })) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── portfolio_snapshot / portfolio_history / portfolio_diff (iter618) ──
  // Persist + compare portfolio states over time. PnL captures realized trades
  // only; these capture the FULL position view (priced + unpriced, all
  // accounts × chains) so an agent can answer "how has the unrealized portfolio
  // changed since last week" without re-fetching historical balances.
  //
  // Workflow:
  //   1. `portfolio_snapshot` to persist current state (returns id).
  //   2. Later, `portfolio_diff` with the id (or relative ref like "7d") to
  //      see what changed.
  //   3. `portfolio_history` lists saved snapshots.
  //
  // Scope contract: snapshots store the (accounts × chains) scope key. Diff
  // lookups filter by the CURRENT scan's scope so we don't mis-attribute
  // missing chains/accounts as "positions removed".
  server.tool(
    "portfolio_snapshot",
    "Persist the current portfolio (live aggregatePortfolio result) into the snapshots table for future diff comparisons. Returns { ok, action: \"snapshot_saved\", id, timestamp, totalUsd, accountsKey, chainsKey, tokenCount, note }. The id can later be passed to portfolio_diff for an explicit comparison; relative refs (\"7d\") also work without a known id. Use before a major trade / position change to capture before/after, or on a cron schedule to build a history series. Scope (accounts × chains) determines diffability — only snapshots taken with the SAME scope are comparable.",
    {
      accounts: z
        .union([z.array(z.string()), z.literal("all")])
        .optional()
        .describe("Array of account labels, or \"all\" (default). Determines the snapshot's accounts scope."),
      chains: z.array(z.string()).optional().describe("Subset of chain names. Determines the snapshot's chains scope."),
      note: z.string().max(200).optional().describe("Free-text note (e.g. \"before rotating ETH→stables\"). Stored alongside the snapshot."),
    },
    async ({ accounts, chains, note }) => {
      try {
        return ok(
          await runTool("portfolio_snapshot", rt.opts, { accounts, chains, note }, undefined, async () => {
            const config = rt.getConfig();
            const { resolveAccountsForPortfolio, aggregatePortfolio } = await import("../portfolio.js");
            const { listAccounts, unknownAccountError } = await import("../accounts.js");
            const { getKeystoreAddress } = await import("../wallet.js");
            const { KEYSTORE_LABEL } = await import("../constants.js");

            let acctSpec: string[] | "all" | undefined;
            if (accounts === undefined || accounts === "all") {
              acctSpec = "all";
            } else {
              const file = listAccounts();
              const knownLabels = [
                ...(file?.accounts ?? []).map((a) => a.label),
                ...(getKeystoreAddress() ? [KEYSTORE_LABEL] : []),
              ];
              for (const p of accounts) {
                if (!knownLabels.includes(p)) throw unknownAccountError(p, knownLabels);
              }
              acctSpec = accounts;
            }

            const resolved = resolveAccountsForPortfolio(acctSpec);
            if (resolved.length === 0) {
              throw new ToolError(
                "WALLET_NOT_FOUND",
                "Portfolio snapshot requires at least one wallet.",
                { details: { reason: "no_wallet" } },
              );
            }
            const report = await aggregatePortfolio({ accounts: resolved, config, logger: rt.opts.logger, chains });

            const { scopeKey } = await import("../portfolioSnapshots.js");
            const { insertPortfolioSnapshot } = await import("../db.js");
            const accountsKey = scopeKey(report.accounts.map((a) => a.label));
            const chainsKey = scopeKey(report.chains);
            const id = insertPortfolioSnapshot({
              timestamp: report.timestamp,
              total_usd: report.totalUsd,
              accounts_key: accountsKey,
              chains_key: chainsKey,
              token_count: report.tokens.length,
              note: note ?? null,
              data: JSON.stringify(report),
            });

            return {
              ok: true,
              action: "snapshot_saved",
              id,
              timestamp: report.timestamp,
              totalUsd: report.totalUsd,
              accountsKey,
              chainsKey,
              tokenCount: report.tokens.length,
              note: note ?? null,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "portfolio_history",
    "List saved portfolio snapshots (most recent first). Returns { ok, count, snapshots: [ { id, timestamp, totalUsd, accountsKey, chainsKey, tokenCount, note } ] }. Excludes the heavy data blob — use portfolio_diff for the full reconstruction. Use to discover saved ids before calling portfolio_diff with an explicit id, or to graph total_usd over time externally.",
    {
      limit: z.number().int().positive().max(500).optional().describe("Max rows to return (default 20)."),
      accountsKey: z.string().optional().describe("Filter to snapshots with this exact accounts scope key (sorted-comma-joined label list)."),
      chainsKey: z.string().optional().describe("Filter to snapshots with this exact chains scope key."),
    },
    async ({ limit, accountsKey, chainsKey }) => {
      try {
        return ok(
          await runTool("portfolio_history", rt.opts, { limit, accountsKey, chainsKey }, undefined, async () => {
            const { listPortfolioSnapshots } = await import("../db.js");
            const rows = listPortfolioSnapshots({ limit: limit ?? 20, accountsKey, chainsKey });
            return {
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
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  server.tool(
    "portfolio_diff",
    "Diff a past portfolio snapshot against the current LIVE state. Returns { ok, prevSnapshotId, prev: {timestamp, totalUsd, tokenCount}, current: {...}, totalUsdDelta, totalUsdDeltaPct, added[], removed[], changed[], unchanged[] }. The added/removed/changed arrays carry per-token details (symbol, prev/current USD + amount, deltas, deltaPct). `changed` is sorted by ABSOLUTE USD delta descending — biggest movers first regardless of direction. Use to answer \"what's changed since [point in time]\" — e.g. report.changed[0] is the biggest mover. Errors: INVALID_PARAMS (ref didn't resolve or no matching snapshot for scope/date).",
    {
      ref: z
        .string()
        .describe("Snapshot reference: numeric id (\"1\", \"42\"), relative ago (\"7d\", \"24h\"), \"today\", \"yesterday\", or ISO date/timestamp (\"2026-05-01\"). For relative/date refs, the most-recent snapshot at-or-before that point with matching scope is used."),
      accounts: z
        .union([z.array(z.string()), z.literal("all")])
        .optional()
        .describe("Scope of the CURRENT live portfolio (the comparison side). Should match the saved snapshot's scope for a meaningful diff."),
      chains: z.array(z.string()).optional().describe("Chain scope of the CURRENT side."),
    },
    async ({ ref, accounts, chains }) => {
      try {
        return ok(
          await runTool("portfolio_diff", rt.opts, { ref, accounts, chains }, undefined, async () => {
            const config = rt.getConfig();
            const { resolveAccountsForPortfolio, aggregatePortfolio } = await import("../portfolio.js");
            const { listAccounts, unknownAccountError } = await import("../accounts.js");
            const { getKeystoreAddress } = await import("../wallet.js");
            const { KEYSTORE_LABEL } = await import("../constants.js");
            const { resolveSnapshotRef, scopeKey, diffSnapshots } = await import("../portfolioSnapshots.js");
            const { getPortfolioSnapshot, findPortfolioSnapshotAsOf } = await import("../db.js");

            let acctSpec: string[] | "all" | undefined;
            if (accounts === undefined || accounts === "all") {
              acctSpec = "all";
            } else {
              const file = listAccounts();
              const knownLabels = [
                ...(file?.accounts ?? []).map((a) => a.label),
                ...(getKeystoreAddress() ? [KEYSTORE_LABEL] : []),
              ];
              for (const p of accounts) {
                if (!knownLabels.includes(p)) throw unknownAccountError(p, knownLabels);
              }
              acctSpec = accounts;
            }
            const resolved = resolveAccountsForPortfolio(acctSpec);
            if (resolved.length === 0) {
              throw new ToolError("WALLET_NOT_FOUND", "Portfolio diff requires at least one wallet.", {
                details: { reason: "no_wallet" },
              });
            }
            const current = await aggregatePortfolio({ accounts: resolved, config, logger: rt.opts.logger, chains });
            const accountsKey = scopeKey(current.accounts.map((a) => a.label));
            const chainsKey = scopeKey(current.chains);

            let resolvedRef;
            try {
              resolvedRef = resolveSnapshotRef(ref);
            } catch (e) {
              throw new ToolError("INVALID_PARAMS", (e as Error).message);
            }
            let prevRow;
            if (resolvedRef.kind === "id") {
              prevRow = getPortfolioSnapshot(resolvedRef.id);
              if (!prevRow) {
                throw new ToolError(
                  "INVALID_PARAMS",
                  `No snapshot with id=${resolvedRef.id}. Call portfolio_history first to list saved ids.`,
                );
              }
            } else {
              prevRow = findPortfolioSnapshotAsOf({ asOf: resolvedRef.iso, accountsKey, chainsKey });
              if (!prevRow) {
                throw new ToolError(
                  "INVALID_PARAMS",
                  `No snapshot at or before ${resolvedRef.iso} for scope "${accountsKey} × ${chainsKey}". Call portfolio_snapshot to capture state first.`,
                );
              }
            }
            const prev = JSON.parse(prevRow.data);
            const delta = diffSnapshots(prev, current);
            return { ok: true, prevSnapshotId: prevRow.id, ...delta };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── health (iter621) ──────────────────────────────────────
  // Operator dashboard. Single call returns the same composition `tradekit
  // health` builds at the CLI: portfolio + 7d PnL + recent-trade quality +
  // standing approvals + suggested next actions.
  //
  // Per-section failure tolerated — one bad RPC drops that section into
  // errors[] without aborting the rest of the report. Agents inspecting
  // health.errors[] can branch on the section that failed.
  server.tool(
    "health",
    "Operator dashboard — single call returning current portfolio snapshot + 7d PnL + trade quality + standing approvals + composed next-action suggestions. Returns { ok, timestamp, elapsedMs, scope: {accounts[], chains[]}, portfolio?: {totalUsd, delta24h?, delta7d?, top[], concentration, ...}, pnl?: {realized7dUsd, unrealizedUsd, gas7dUsd, netAfterGas7dUsd, topWinner?, topLoser?}, trades?: {total, success/failed/pending counts, median/avg slippageBps, byVerdict}, security?: {totalApprovals, criticalCount, warnCount, topConcerns[]}, errors[], nextActions[], nextActionsSummary, severity, criticalActions[] }. Iter764 — nextActionsSummary pre-computes {critical, high, medium, low} counts so agents don't iterate. Iter786 — top-level severity is the worst-bucket string ('ok' | 'critical' | 'high' | 'medium' | 'low'); branch on this for at-a-glance status. Iter827 — `criticalActions` is a pre-filtered slice of nextActions where severity==='critical' (always present, empty array when no critical actions). Dashboards / pager triggers branch on this field directly without iterating nextActions[]. Each top-level section is OPTIONAL — a failed sub-query drops the section into errors[] and the rest of the report still returns. nextActions[] is rule-derived (e.g. \"5 critical approvals → revoke_critical\"); each action carries a code + command + message so agents can dispatch automatically. Use as the morning briefing for an agent overseeing one or more accounts.",
    {
      chains: z.array(z.string()).optional().describe("Subset of chain names. Omit to scan every built-in + custom chain (same default as portfolio)."),
      accounts: z
        .union([z.array(z.string()), z.literal("all")])
        .optional()
        .describe("Array of account labels, or \"all\" (default). PnL section uses the first resolved account."),
    },
    async ({ chains, accounts }) => {
      try {
        return ok(
          await runTool("health", rt.opts, { chains, accounts }, undefined, async () => {
            // Iter729: measure full health orchestration wall-clock.
            const t0 = Date.now();
            const config = rt.getConfig();
            const { resolveAccountsForPortfolio, aggregatePortfolio } = await import("../portfolio.js");
            const { listAccounts, unknownAccountError } = await import("../accounts.js");
            const { getKeystoreAddress } = await import("../wallet.js");
            const { KEYSTORE_LABEL } = await import("../constants.js");
            const { composeHealthReport } = await import("../health.js");

            let acctSpec: string[] | "all" | undefined;
            if (accounts === undefined || accounts === "all") {
              acctSpec = "all";
            } else {
              const file = listAccounts();
              const knownLabels = [
                ...(file?.accounts ?? []).map((a) => a.label),
                ...(getKeystoreAddress() ? [KEYSTORE_LABEL] : []),
              ];
              for (const p of accounts) {
                if (!knownLabels.includes(p)) throw unknownAccountError(p, knownLabels);
              }
              acctSpec = accounts;
            }
            const resolved = resolveAccountsForPortfolio(acctSpec);
            if (resolved.length === 0) {
              throw new ToolError("WALLET_NOT_FOUND", "Health requires at least one wallet.", {
                details: { reason: "no_wallet" },
              });
            }
            const allChains = [...listChains(), ...Object.keys(config.chains)];
            const scopedChains = chains ?? allChains;
            const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
            const pnlAccount = resolved[0].label;

            // Fan out reads in parallel. Per-section catch → { error } sentinel.
            const portfolioP = aggregatePortfolio({ accounts: resolved, config, logger: rt.opts.logger, chains: scopedChains })
              .catch((e) => ({ error: (e as Error).message }) as { error: string });
            // Iter624: aggregate PnL across ALL accounts in scope. Same
            // adaptation pattern as the CLI — convert MultiAccountPnLReport
            // to a PnLReport-shape that composeHealthReport already accepts.
            const { aggregateMultiAccountPnL } = await import("../pnl.js");
            const pnlP = aggregateMultiAccountPnL(
              resolved.map((a) => a.label),
              { windows: [{ since: since7d, label: "7d" }] },
              rt.opts.logger,
            )
              .then((agg) => ({
                account: agg.accounts.join(","),
                chain: agg.chain,
                timestamp: agg.timestamp,
                positions: [],
                gas: [],
                totalRealizedUsd: agg.totalRealizedUsd,
                totalUnrealizedUsd: agg.totalUnrealizedUsd,
                totalGasUsd: agg.totalGasUsd,
                totalRealizedAfterGasUsd: agg.totalRealizedAfterGasUsd,
                windows: agg.windows,
                // Iter640: byPair passes through for health's top-pair signal.
                byPair: agg.byPair,
                // Iter650: byStrategy similarly.
                byStrategy: agg.byStrategy,
                // Iter818: propagate severity from the aggregate.
                severity: agg.severity,
                // Iter830: propagate recommendedActions from the aggregate.
                recommendedActions: agg.recommendedActions,
              }))
              .catch((e) => ({ error: (e as Error).message }) as { error: string });

            const { recentTrades } = await import("../db.js");
            let rows: ReturnType<typeof recentTrades> | { error: string };
            try {
              rows = recentTrades({ account: pnlAccount, limit: 50 });
            } catch (e) {
              rows = { error: (e as Error).message };
            }

            const approvalsP = (async () => {
              try {
                const { listAllowances } = await import("../approvals.js");
                const { auditAllowanceList } = await import("../approvalAudit.js");
                const { KNOWN_ROUTERS } = await import("../routers.js");
                const knownRouters = new Set(KNOWN_ROUTERS.map((r) => r.address.toLowerCase()));
                const reports = [];
                for (const chainName of scopedChains) {
                  try {
                    const wallet = await rt.getContext(chainName, pnlAccount);
                    const profile = resolveProfile(chainName, config);
                    const rs = await listAllowances(
                      { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger: rt.opts.logger },
                      {},
                    );
                    if (rs.length === 0) continue;
                    reports.push(
                      auditAllowanceList(rs, {
                        chain: chainName,
                        config,
                        knownRouters,
                        tokenPrices: new Map(),
                        owner: wallet.account.address as Address,
                      }),
                    );
                  } catch (e) {
                    rt.opts.logger.debug(`health: approval audit skipped on ${chainName}: ${(e as Error).message}`);
                  }
                }
                return reports;
              } catch (e) {
                return { error: (e as Error).message } as { error: string };
              }
            })();

            const analyses = await (async () => {
              if (!Array.isArray(rows)) return { error: (rows as { error: string }).error };
              const { analyzeStoredTrade } = await import("../tradeAnalysis.js");
              // Iter653: same pattern as CLI — only fan out to legacy rows
              // that lack iter641 stored slippage. Modern rows pay zero RPC.
              const candidates = rows.filter((r) => r.status === "success" && r.timestamp >= since7d).slice(0, 10);
              const legacyRows = candidates.filter((r) => r.realized_slippage_bps == null);
              const out = [];
              for (const row of legacyRows) {
                try {
                  const wallet = await rt.getContext(row.chain, pnlAccount);
                  const profile = resolveProfile(row.chain, config);
                  out.push(
                    await analyzeStoredTrade({ row, publicClient: wallet.publicClient, profile, logger: rt.opts.logger }),
                  );
                } catch (e) {
                  rt.opts.logger.debug(`health: analyze skipped for ${row.tx_hash}: ${(e as Error).message}`);
                }
              }
              return out;
            })();

            // Iter618 snapshot inputs (best-effort).
            const { listPortfolioSnapshots, findPortfolioSnapshotAsOf } = await import("../db.js");
            let snapshotInputs: {
              daysSinceLastSnapshot?: number;
              lastSnapshotAt?: string;
              delta24h?: ReturnType<typeof composeHealthReport>["portfolio"] extends infer T
                ? T extends { delta24h?: infer D } ? D : undefined
                : undefined;
              delta7d?: ReturnType<typeof composeHealthReport>["portfolio"] extends infer T
                ? T extends { delta7d?: infer D } ? D : undefined
                : undefined;
            } = {};
            try {
              const portfolioResolved = await portfolioP;
              const accountsKey = Array.isArray((portfolioResolved as { accounts?: unknown }).accounts)
                ? [...(portfolioResolved as { accounts: { label: string }[] }).accounts]
                    .map((a) => a.label.toLowerCase())
                    .sort()
                    .join(",")
                : "";
              const chainsKey = [...scopedChains].map((c) => c.toLowerCase()).sort().join(",");
              const recent = listPortfolioSnapshots({ limit: 1, accountsKey, chainsKey });
              snapshotInputs.lastSnapshotAt = recent[0]?.timestamp;
              if (snapshotInputs.lastSnapshotAt) {
                snapshotInputs.daysSinceLastSnapshot = Math.floor(
                  (Date.now() - new Date(snapshotInputs.lastSnapshotAt).getTime()) / 86_400_000,
                );
              }
              if (portfolioResolved && !(portfolioResolved as { error?: string }).error && accountsKey && chainsKey) {
                const totalUsd = (portfolioResolved as { totalUsd: number }).totalUsd;
                const snap24h = findPortfolioSnapshotAsOf({
                  asOf: new Date(Date.now() - 24 * 3600_000).toISOString(),
                  accountsKey,
                  chainsKey,
                });
                if (snap24h?.total_usd != null) {
                  const d = totalUsd - snap24h.total_usd;
                  snapshotInputs.delta24h = {
                    totalUsdDelta: d,
                    pct: snap24h.total_usd > 0 ? (d / snap24h.total_usd) * 100 : null,
                    snapshotId: snap24h.id!,
                  };
                }
                const snap7d = findPortfolioSnapshotAsOf({ asOf: since7d, accountsKey, chainsKey });
                if (snap7d?.total_usd != null) {
                  const d = totalUsd - snap7d.total_usd;
                  snapshotInputs.delta7d = {
                    totalUsdDelta: d,
                    pct: snap7d.total_usd > 0 ? (d / snap7d.total_usd) * 100 : null,
                    snapshotId: snap7d.id!,
                  };
                }
              }
            } catch (e) {
              rt.opts.logger.debug(`health: snapshot inputs failed: ${(e as Error).message}`);
            }

            const [portfolio, pnl, approvalAudits] = await Promise.all([portfolioP, pnlP, approvalsP]);

            // Iter655/iter658: legacy-row count for backfill recommendations.
            // Counts are global (no account filter) — backfill commands don't
            // accept --account, and per-account counts would hide other-
            // account rows so the same nextAction would recur after a "clean"
            // run.
            let legacyBackfillCounts:
              | {
                  missingBlockNumber: number;
                  missingSlippage: number;
                  missingGasUsd: number;
                  missingRevertReason: number;
                }
              | undefined;
            try {
              const dbModule = await import("../db.js");
              legacyBackfillCounts = dbModule.legacyBackfillCounts({});
            } catch (e) {
              rt.opts.logger.debug(`legacy backfill count failed: ${(e as Error).message}`);
            }

            // v55: runtime headroom for the safety section (best-effort).
            let healthHeadroom: import("../safetyHeadroom.js").SafetyHeadroomReport | { error: string } | undefined;
            try {
              const { gatherSafetyHeadroom } = await import("../safetyHeadroom.js");
              healthHeadroom = gatherSafetyHeadroom({ config });
            } catch (e) {
              healthHeadroom = { error: (e as Error).message };
            }

            return {
              ok: true,
              ...composeHealthReport({
                scope: { accounts: resolved, chains: scopedChains },
                portfolio,
                pnl,
                approvalAudits,
                analyses,
                recentRows: rows,
                since7d,
                daysSinceLastSnapshot: snapshotInputs.daysSinceLastSnapshot,
                portfolioDelta24h: snapshotInputs.delta24h,
                portfolioDelta7d: snapshotInputs.delta7d,
                lastSnapshotAt: snapshotInputs.lastSnapshotAt,
                legacyBackfillCounts,
                config,
                headroom: healthHeadroom,
                // Iter729: orchestration wall-clock for the MCP path.
                elapsedMs: Date.now() - t0,
              }),
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── token_info (iter629) ──────────────────────────────────
  // Unified per-token report: metadata + price + wallet balance + standing
  // approvals (with severity from iter606) + recent trades + advisory.
  // Composition over existing primitives — closes the "5 commands to
  // investigate a token" UX gap.
  //
  // Distinct from `check_token` (iter609): that one's a binary safety verdict
  // via round-trip simulation; this one's an OPERATIONAL view (your balance,
  // your approvals, your history). Use both together — token_info for "what's
  // my exposure", check_token for "is this safe to buy".
  server.tool(
    "token_info",
    "Unified per-token operational report. Returns { ok, chain, address, symbol, decimals, timestamp, elapsedMs, priceUsd, priceSource, balance, balanceUsd, owner, approvals: [ { spender, spenderLabel, display, severity, recommendedAction? } ], approvalCounts: {critical, warn, ok}, approvalSeverity, recentTrades: [ { timestamp, direction, baseSymbol, quoteSymbol, baseAmount, quoteAmount, status, txHash } ], totalTradeCount, advisory?, recommendedActions[] }. approvals sorted critical → warn → ok; each carries an inline `recommendedAction` NextAction (iter681) for the per-row revoke dispatch. advisory is a one-line message surfacing the most actionable signal (critical/warn approvals, missing price oracle). Iter802: `approvalSeverity` is the worst-bucket across approvals[] ('ok' | 'warn' | 'critical') — agents branch on this for at-a-glance exposure. Iter829: top-level `recommendedActions[]` aggregates critical-approval revoke dispatches + price-check follow-ups when no oracle is found; empty array when clean. Use to investigate exposure on a specific token in ONE call — pre-iter629 required holdings + allowances + price + trades commands separately. Distinct from check_token (which is the binary safety verdict via simulation). Errors: UNKNOWN_TOKEN (metadata fetch failed — bad address or contract doesn't implement ERC20), UNKNOWN_CHAIN.",
    {
      chain: z.string().optional(),
      token: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "token must be 0x-prefixed 40 hex chars (20-byte EVM address)")
        .describe("Token address to inspect."),
      account: z.string().optional().describe("HD account label override; defaults to active. Determines whose balance + approvals are surfaced."),
      recentLimit: z.number().int().positive().max(50).optional().describe("Max recent trades to include (default 10). totalTradeCount is unbounded for context."),
    },
    async ({ chain, token, account, recentLimit }) => {
      try {
        return ok(
          await runTool("token_info", rt.opts, { chain, token, account, recentLimit }, chain, async () => {
            const config = rt.getConfig();
            const wallet = await rt.getContext(chain, account);
            const profile = resolveProfile(wallet.chain, config);
            const { gatherTokenInfo } = await import("../tokenInfo.js");
            const { getAddress } = await import("viem");
            const report = await gatherTokenInfo({
              chain: wallet.chain,
              address: getAddress(token.toLowerCase() as `0x${string}`),
              owner: wallet.account.address,
              publicClient: wallet.publicClient,
              profile,
              config,
              logger: rt.opts.logger,
              recentLimit,
            });
            return { ok: true, ...report };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── aggregator_stats (iter623) ────────────────────────────
  // Per-aggregator quality scorecard. Closes the "which aggregator gives me
  // better fills?" question with a structured report an agent can branch on
  // (e.g. switch config.aggregator.preferred order based on the data).
  server.tool(
    "aggregator_stats",
    "Per-aggregator quality scorecard derived from trade history + iter619 analyses. Returns { ok, timestamp, elapsedMs, since?, totalTrades, byAggregator: [ { aggregator, tradeCount, successCount, failedCount, pendingCount, successRate, medianSlippageBps, p95SlippageBps, avgSlippageBps, totalUsdVolume, volumeNotePartial, analyzedCount, byVerdict, failureReasons, lastSeen (iter701 — ISO timestamp of the most-recent trade via this aggregator; absent only when bucket is empty) } ], recommendation?, recommendedAggregator? (iter733 — structured winner name; agents compare directly with config.aggregator.preferred[0] to detect config drift without parsing prose), warnings (iter688 — array of strings flagging underperformers when success-rate gap ≥15 pct or median-slippage gap ≥50 bps; agents reorder `config.aggregator.preferred` to deprioritize the flagged aggregators), severity, recommendedActions[] }. byAggregator sorted by tradeCount desc (most-used first). Slippage stats: median = typical fill, p95 = bad-day exposure, avg = mean (pulled by outliers). p95 only populated when analyzedCount >= 5 (smaller samples aren't meaningful). recommendation surfaces ONLY when sample sizes support it (>=10 analyzed trades per aggregator being compared; >=10 bps median margin OR >=5 pct success-rate margin). totalUsdVolume sums only stablecoin-quoted success trades; volumeNotePartial flags when non-stable rows were skipped. Iter803: top-level `severity` is 'ok' or 'warn' (warn = warnings[] non-empty, i.e. flagged underperformers). Iter835: `recommendedActions[]` carries structured NextAction[] dispatching to `analyze_trade` for underperformer deep-dives; empty when severity='ok'. `strategy` (iter663): scope to one strategy's trades — answers 'within my DCA strategy, which aggregator was best?' rather than blending strategies. Use to pick which aggregator to set as `config.aggregator.preferred[0]` based on realized fill quality.",
    {
      since: z.string().optional().describe("ISO date/timestamp or shorthand (today, yesterday, 7d, 30d). Default 30d ago."),
      chain: z.string().optional(),
      account: z.string().optional().describe("HD account label override; defaults to active."),
      strategy: z.string().optional().describe("Iter663: scope stats to one strategy tag (exact match against the iter648 strategy column)."),
    },
    async ({ since, chain, account, strategy }) => {
      try {
        return ok(
          await runTool("aggregator_stats", rt.opts, { since, chain, account, strategy }, chain, async () => {
            const { recentTrades } = await import("../db.js");
            const { analyzeStoredTrade } = await import("../tradeAnalysis.js");
            const { computeAggregatorStats } = await import("../aggregatorStats.js");
            const { parseDateFilter } = await import("../format.js");

            const config = rt.getConfig();
            const sinceIso = since
              ? (parseDateFilter(since, "since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString())
              : new Date(Date.now() - 30 * 86_400_000).toISOString();

            const rows = recentTrades({ chain, account, since: sinceIso, limit: 10_000, strategy });
            const successRows = rows.filter((r) => r.status === "success");
            const analyses = [];
            if (successRows.length > 0) {
              const walletByChain = new Map<string, Awaited<ReturnType<typeof rt.getContext>>>();
              for (const row of successRows) {
                try {
                  let wallet = walletByChain.get(row.chain);
                  if (!wallet) {
                    wallet = await rt.getContext(row.chain, row.account);
                    walletByChain.set(row.chain, wallet);
                  }
                  const profile = resolveProfile(row.chain, config);
                  analyses.push(
                    await analyzeStoredTrade({ row, publicClient: wallet.publicClient, profile, logger: rt.opts.logger }),
                  );
                } catch (e) {
                  rt.opts.logger.debug(`aggregator_stats: analysis skipped for ${row.tx_hash}: ${(e as Error).message}`);
                }
              }
            }
            return { ok: true, ...computeAggregatorStats(rows, analyses, { since: sinceIso }) };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── aggregator_tune (v58) ─────────────────────────────────
  // Closes the execution-quality learning loop: turns aggregator_stats'
  // descriptive per-aggregator quality into the PRESCRIPTIVE optimal
  // config.aggregator.preferred order + a mode recommendation. Read-only —
  // returns the recommendation; the agent applies via the `config` tool
  // (set aggregator.preferred) if it chooses.
  server.tool(
    "aggregator_tune",
    "v58: rank aggregators by REALIZED fill quality into the optimal config.aggregator.preferred order — closing the loop aggregator_stats opens (which only DESCRIBES quality). Reliability-first ranking (a failed fill wastes gas AND misses the trade — worse than a few bps of slippage), bucketed by success rate then median realized slippage as the tiebreak; only aggregators with ≥10 trades are ranked on merit. Returns { ok, recommendedPreferred (best-first — what to set), recommendedOrder (full resolved), currentOrder, changed, ranking[] (per-aggregator rank/successRate/medianSlippageBps/eligible/note), recommendedMode ('best' when the eligible slippage spread ≥15bps and you're on 'first' — racing beats a fixed order; null = keep current), modeReason, eligibleCount, insufficient (true when <2 eligible → keep current) }. Read-only: apply by calling `config` with action=set, path=aggregator.preferred, value=recommendedPreferred. Uses the STORED realized_slippage_bps (no per-trade RPC). Mainly benefits mode='first'; for 'best' the order matters less (it races all). Errors: UNKNOWN_CHAIN.",
    {
      since: z.string().optional().describe("ISO date/timestamp or shorthand (7d, 30d). Default 30d ago."),
      chain: z.string().optional(),
      account: z.string().optional().describe("HD account label override; defaults to active."),
      strategy: z.string().optional().describe("Scope to one strategy tag's trades (exact match)."),
    },
    async ({ since, chain, account, strategy }) => {
      try {
        return ok(
          await runTool("aggregator_tune", rt.opts, { since, chain, account, strategy }, chain, async () => {
            const { recentTrades } = await import("../db.js");
            const { computeAggregatorStats, deriveAggregatorTuning } = await import("../aggregatorStats.js");
            const { parseDateFilter } = await import("../format.js");
            const config = rt.getConfig();
            const sinceIso = since
              ? (parseDateFilter(since, "since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString())
              : new Date(Date.now() - 30 * 86_400_000).toISOString();
            // Tuning rides on stored realized_slippage_bps — no RPC analysis.
            const rows = recentTrades({ chain, account, since: sinceIso, limit: 10_000, strategy });
            const report = computeAggregatorStats(rows, [], { since: sinceIso });
            const tuning = deriveAggregatorTuning({
              stats: report.byAggregator,
              currentPreferred: config.aggregator?.preferred ?? [],
              currentMode: config.aggregator?.mode ?? "first",
            });
            return { ok: true, totalTrades: report.totalTrades, since: sinceIso, ...tuning };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── pair_stats (iter634) ──────────────────────────────────
  // Per-pair slippage scorecard. Orthogonal to aggregator_stats — buckets
  // by canonical BASE/QUOTE pair instead of by aggregator. Use to identify
  // which pairs are giving bad fills regardless of which aggregator
  // executed them.
  server.tool(
    "pair_stats",
    "Per-pair slippage scorecard from trade history + iter619 analyses. Returns { ok, timestamp, elapsedMs, since?, totalTrades, byPair: [ { pair, baseSymbols[], quoteSymbols[], tradeCount, successCount, failedCount, pendingCount, successRate, medianSlippageBps, p95SlippageBps, avgSlippageBps, totalUsdVolume, volumeNotePartial, analyzedCount, byVerdict, failureReasons (iter673), lastSeen (iter702 — ISO timestamp of most-recent trade on this pair) } ], warnings (iter690 — strings flagging pairs with high median slippage gap or failure-reason concentration), pairsReturned, pairsTotal (iter721 — pairsReturned ≤ limit; pairsTotal is the pre-trim count for honest scope reporting), severity, recommendedActions[] }. pair is canonicalized as 'BASE/QUOTE' lexicographically (both directions of a pair bucket together). byPair sorted by tradeCount desc. Orthogonal to aggregator_stats: this answers 'are my ETH/PEPE fills bad because of the route or because PEPE is illiquid?' — aggregator stats average over pairs and hide pair-level variance. Iter803: top-level `severity` is 'ok' or 'warn' (warn = warnings[] non-empty). Iter836: `recommendedActions[]` carries structured NextAction[] suggesting slippage-cap tuning or route inspection for the worst pairs; empty when severity='ok'. `strategy` (iter663): scope to one strategy's trades. `limit` (iter721): trim returned byPair[] (default 50; aggregate math + warnings computed pre-trim across the full set). Use to tune strategy by pair (e.g. raise slippage cap for high-variance pairs, keep tight for stable pairs).",
    {
      since: z.string().optional().describe("ISO date/timestamp or shorthand (today, yesterday, 7d, 30d). Default 30d ago."),
      chain: z.string().optional(),
      account: z.string().optional().describe("HD account label override; defaults to active."),
      strategy: z.string().optional().describe("Iter663: scope stats to one strategy tag."),
      limit: z.number().int().positive().max(1000).optional().describe("Iter721: cap returned byPair[]. Default 50. Aggregate math (totalTrades, warnings) computed pre-trim across the full set."),
    },
    async ({ since, chain, account, strategy, limit }) => {
      try {
        return ok(
          await runTool("pair_stats", rt.opts, { since, chain, account, strategy, limit }, chain, async () => {
            const { recentTrades } = await import("../db.js");
            const { analyzeStoredTrade } = await import("../tradeAnalysis.js");
            const { computePairStats } = await import("../pairStats.js");
            const { parseDateFilter } = await import("../format.js");

            const config = rt.getConfig();
            const sinceIso = since
              ? (parseDateFilter(since, "since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString())
              : new Date(Date.now() - 30 * 86_400_000).toISOString();

            const rows = recentTrades({ chain, account, since: sinceIso, limit: 10_000, strategy });
            const successRows = rows.filter((r) => r.status === "success");
            const analyses = [];
            if (successRows.length > 0) {
              const walletByChain = new Map<string, Awaited<ReturnType<typeof rt.getContext>>>();
              for (const row of successRows) {
                try {
                  let wallet = walletByChain.get(row.chain);
                  if (!wallet) {
                    wallet = await rt.getContext(row.chain, row.account);
                    walletByChain.set(row.chain, wallet);
                  }
                  const profile = resolveProfile(row.chain, config);
                  analyses.push(
                    await analyzeStoredTrade({ row, publicClient: wallet.publicClient, profile, logger: rt.opts.logger }),
                  );
                } catch (e) {
                  rt.opts.logger.debug(`pair_stats: analysis skipped for ${row.tx_hash}: ${(e as Error).message}`);
                }
              }
            }
            const report = computePairStats(rows, analyses, { since: sinceIso });
            // Iter721: trim byPair[] to the requested limit (default 50).
            // Aggregate math + warnings stay full-set so the totals stay
            // honest. pairsReturned / pairsTotal mirror portfolio's shape.
            const cap = limit ?? 50;
            return {
              ok: true,
              ...report,
              byPair: report.byPair.slice(0, cap),
              pairsReturned: Math.min(report.byPair.length, cap),
              pairsTotal: report.byPair.length,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── strategies_list (iter651) ─────────────────────────────
  // Directory of distinct strategy tags. Useful for agents wanting to scope
  // a subsequent pnl/recent_trades call to a specific strategy without
  // guessing the tag name.
  server.tool(
    "strategies_list",
    "List distinct strategy tags from the trades DB with trade count + first/last-used timestamps. Returns { ok, count, strategies: [{ strategy, tradeCount, firstUsed, lastUsed }] }. Sorted by lastUsed desc (most-recently-active first). NULL strategies are excluded — operators querying untagged volume use `recent_trades` directly. Use as a discovery call before scoping pnl / recent_trades by `strategy`.",
    {
      account: z.string().optional().describe("Filter to a single account. Default: all accounts."),
      chain: z.string().optional(),
    },
    async ({ account, chain }) => {
      try {
        return ok(
          await runTool("strategies_list", rt.opts, { account, chain }, chain, async () => {
            const { listDistinctStrategies } = await import("../db.js");
            const rows = listDistinctStrategies({ account, chain });
            return { ok: true, count: rows.length, strategies: rows };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── slippage_suggest (iter644) ────────────────────────────
  // Preview the iter642 auto-slippage recommendation without executing a
  // trade. Same pure logic the trade flow uses with autoSlippage=true.
  server.tool(
    "slippage_suggest",
    "Preview the data-driven slippage suggestion for a token pair. Returns { ok, pairSymbol, pairAddress?, account, since, defaultBps, maxBps, suggestion: { suggestedBps, sampleCount, p95Bps, medianBps, flooredAtDefault, cappedAtMax, reason } }. Reason codes: 'from_history' (happy path: p95+25% recommended), 'from_history_floored' (suggestion below default — using default), 'from_history_capped' (above safety max — capped), 'insufficient_history' (<5 samples, using default), 'no_history' (0 samples, using default). Uses iter641-stored realized_slippage_bps for cheap lookup. Operators with pre-iter641 data should run `reconcile { backfillSlippage: N }` first. Use as the read-only counterpart to trade tools' autoSlippage param.",
    {
      base: z.string().describe("Base token symbol (e.g. 'ETH') or 0x-prefixed address."),
      quote: z.string().describe("Quote token symbol (e.g. 'USDC') or 0x-prefixed address."),
      chain: z.string().optional(),
      account: z.string().optional().describe("HD account label override; defaults to active."),
      lookbackDays: z.number().int().positive().max(365).optional().describe("Days of trade history to consider. Default 30."),
    },
    async ({ base, quote, chain, account, lookbackDays }) => {
      try {
        return ok(
          await runTool("slippage_suggest", rt.opts, { base, quote, chain, account, lookbackDays }, chain, async () => {
            const config = rt.getConfig();
            const wallet = await rt.getContext(chain, account);
            const profile = resolveProfile(wallet.chain, config);
            const { resolveTradePair } = await import("../chains.js");
            const resolved = resolveTradePair(profile, base, quote);
            const { previewSlippageSuggestion } = await import("../slippageSuggest.js");
            const report = await previewSlippageSuggestion({
              config,
              logger: rt.opts.logger,
              account: wallet.label,
              baseSymbol: base.toUpperCase(),
              quoteSymbol: quote.toUpperCase(),
              baseAddress: resolved.base === "ETH" ? undefined : (resolved.base as string),
              quoteAddress: resolved.quote as string,
              lookbackDays,
            });
            return { ok: true, ...report };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── trending ──────────────────────────────────────────────
  server.tool(
    "trending",
    "DexScreener trending pairs by chain (when `query` omitted) or token lookup by symbol / 0x-prefixed address (when `query` set). Returns { ok, query, chain, pairs[], timestamp, elapsedMs } where each pair has baseToken, quoteToken, priceUsd, volume24h, liquidityUsd, dexId, pairAddress. Iter914 — elapsedMs is wall-clock for the DexScreener / GeckoTerminal API call; agents tail this to detect upstream rate limiting. Units: priceUsd is USD per base; volume/liquidity are USD. Empty result (no matches / cold trending list) returns pairs=[] — not an error. Errors: UNKNOWN_CHAIN (typo, with iter343 suggestion), AGGREGATOR_FAILED (DexScreener API rate-limited or down — operator can retry; no doctor recovery since this is an external API).",
    {
      chain: z.string().optional(),
      query: z.string().optional().describe("Search term (symbol or address). If omitted, returns boosted trending pairs."),
      limit: z.number().int().positive().max(50).optional(),
    },
    async ({ chain, query, limit }) => {
      try {
        return ok(
          await runTool("trending", rt.opts, { chain, query, limit }, chain, async () => {
            // Iter914: wall-clock for the DexScreener / GeckoTerminal API
            // call. Trending is a discovery surface frequently called from
            // the web UI; latency surfacing helps operators spot rate-limit
            // throttling on the upstream APIs.
            const t0 = Date.now();
            // Iter423: parity with iter422's {ok, query, chain, pairs, timestamp} envelope
            // on CLI + /api/trending. Same call-context fields so an agent diffing CLI
            // and MCP transcripts sees identical structure. `chain` resolves to the
            // active chain when omitted (the same resolution this branch already did
            // for the trendingOnChain path) so the response always names the chain that
            // was actually queried.
            const resolvedChain = chain ?? loadConfig().activeChain;
            const timestamp = new Date().toISOString();
            if (query) {
              // Use isAddress so a 42-char non-hex query falls through to searchToken
              // (the looser, name-based search) instead of failing inside tokenByAddress.
              const pairs = isAddress(query, { strict: false }) && chain
                ? await tokenByAddress(chain, query, rt.opts.logger)
                : await searchToken(query, rt.opts.logger);
              return { ok: true, query, chain: resolvedChain, pairs, timestamp, elapsedMs: Date.now() - t0 };
            }
            const pairs = await trendingOnChain(resolvedChain, rt.opts.logger, limit ?? 10);
            return { ok: true, query: null, chain: resolvedChain, pairs, timestamp, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── pnl ───────────────────────────────────────────────────
  server.tool(
    "pnl",
    "Realized + unrealized PnL computed from historical trades. Units: cost basis and PnL are USD; gas is native asset units. Empty trade DB returns zero-PnL with the report's positions array empty — not an error. Filters: `account` defaults to the active wallet label (orphan-accounts.json safe via iter502); `chain` defaults to all chains the trade DB has rows for. Iter615: `windows` returns per-window realized + gas + per-position breakdown. Iter624: `accounts` (array of labels OR \"all\") returns an AGGREGATE shape across multiple accounts. Iter627: `byTokenSymbol[]` ONE entry per unique symbol (sort by totalUsd desc). Iter636: `byAggregator[]` returns { aggregator, realizedUsd, tradeCount } sorted by realizedUsd desc — cross-cuts iter623 quality stats with USD outcomes. Iter639: `byPair[]` returns realized USD per canonical pair. Iter648: `strategy` filter scopes to a specific strategy tag. Iter649: `byStrategy[]` returns realized USD per strategy tag — completes the 4-axis PnL view (symbol/aggregator/pair/strategy). NULL strategy rows bucket as '(none)' so untagged volume is honest. Use to answer 'is my DCA outperforming swing trades' without scoping with --strategy. Iter706/707/708: every position-like entry carries `lastTradeAt` (ISO timestamp of the most-recent contributing row, propagated via MAX): `positions[].lastTradeAt` (per chain+symbol), `byTokenSymbol[].lastTradeAt` (MAX across chains), `byAggregator[].lastTradeAt` (MAX across rows + across accounts on the aggregate shape), `byPair[].lastTradeAt`, `byStrategy[].lastTradeAt`. Agents use this for staleness triage — a position with lastTradeAt 6 months ago is dust; a `byAggregator` entry with lastTradeAt last week is actively in rotation. Iter745: `tradeCount` is the count of trades contributing to this report — agents triage 'is this empty PnL because no trades or because all trades are still pending?'. Iter765/768: `firstTradeAt` and `latestTradeAt` ISO timestamps frame the PnL window (absent for empty PnL). Iter741: `dataFreshness` is present when any sync bookmark is >48h stale — its `staleBookmarks[]` array carries {chain, account, ageHours} for each stuck cron; PnL may be missing recent trades when this field appears. Iter818: top-level `severity` is 'ok' when dataFreshness is absent, 'warn' when present — branch on this for at-a-glance freshness. Iter830: `recommendedActions[]` carries structured dispatch (NextAction[]) for each stale bookmark — agents call `sync_trades` per row to recover; empty array when severity='ok'. Per-account RPC failures land in errors[] without aborting. Errors: UNKNOWN_ACCOUNT, UNKNOWN_CHAIN.",
    {
      account: z.string().optional().describe("Account label for single-account PnL (default: active). Ignored when `accounts` is set."),
      accounts: z
        .union([z.array(z.string()), z.literal("all")])
        .optional()
        .describe(
          "Iter624: array of account labels OR \"all\". When set, returns the multi-account aggregate shape (perAccount + totals + errors). `accounts` takes precedence over `account`.",
        ),
      chain: z.string().optional(),
      windows: z
        .array(
          z.object({
            since: z.string().optional(),
            until: z.string().optional(),
            label: z.string().optional(),
          }),
        )
        .optional()
        .describe(
          "Iter615: array of time windows for realized-PnL attribution. Each window: { since?: ISO, until?: ISO, label?: string }. Half-open semantic. Pass [{label:'7d',since:<7d ago>},{label:'all-time'}] for a comparative view. Position cost basis stays correct (full chronological pass) — windows only filter realized-attribution.",
        ),
      strategy: z
        .string()
        .optional()
        .describe(
          "Iter648: scope PnL to trades tagged with this strategy (e.g. 'dca-eth'). Different from chain/account filters — operators run multiple strategies on the same wallet and want per-strategy PnL attribution.",
        ),
    },
    async ({ account, accounts, chain, windows, strategy }) => {
      try {
        return ok(
          await runTool("pnl", rt.opts, { account, accounts, chain, windows, strategy }, chain, async () => {
            // Iter624: multi-account aggregate path takes precedence.
            if (accounts !== undefined) {
              const { listAccounts, unknownAccountError } = await import("../accounts.js");
              const { getKeystoreAddress } = await import("../wallet.js");
              const { KEYSTORE_LABEL } = await import("../constants.js");
              const { aggregateMultiAccountPnL } = await import("../pnl.js");
              const file = listAccounts();
              const knownLabels = [
                ...(file?.accounts ?? []).map((a) => a.label),
                ...(getKeystoreAddress() ? [KEYSTORE_LABEL] : []),
              ];
              const labels =
                accounts === "all"
                  ? knownLabels
                  : accounts.map((p) => {
                      if (!knownLabels.includes(p)) throw unknownAccountError(p, knownLabels);
                      return p;
                    });
              if (labels.length === 0) {
                throw new ToolError("WALLET_NOT_FOUND", "No accounts available to aggregate.");
              }
              const aggregate = await aggregateMultiAccountPnL(labels, { chain, windows, strategy }, rt.opts.logger);
              return { ok: true, units: { pnl: "USD", gas: "native" }, ...aggregate };
            }
            // Iter502: activeWalletLabel matches loadWallet's gate (orphan-accounts.json
            // case returns "keystore" not the dead HD label) — same iter500/501 pattern.
            const target = account ?? activeWalletLabel();
            const report = await computePnL(target, { chain, windows, strategy }, rt.opts.logger);
            return { ok: true, units: { pnl: "USD", gas: "native" }, ...report };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── viewTx ────────────────────────────────────────────────
  server.tool(
    "viewTx",
    "Look up a transaction by hash and decode its swap movements (net token deltas for the sender, derived from Transfer events). Returns ok/status, block, gas, decoded `moves[]`, a one-line `summary` like \"swapped 0.001 ETH → 2.07 USDC\", and `elapsedMs` (iter914 — wall-clock for the RPC roundtrip fetching the receipt + decoding Transfer events; useful when investigating a tx on a degraded chain RPC). Units: token amounts are signed decimal strings (+received / -sent). Errors: TX_NOT_FOUND (receipt is null — tx may be on a different chain, very recent, or the hash is wrong; details.{chain, txHash}); RPC_FAILED (RPC-side failure during getTransactionReceipt — nextActions carries a doctor call with chain pre-scoped, details.{chain, txHash, operation, reason}).",
    {
      chain: z.string().optional(),
      txHash: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be 0x-prefixed 64 hex chars (32-byte transaction hash)"),
    },
    async ({ chain, txHash }) => {
      try {
        return ok(
          await runTool("viewTx", rt.opts, { chain, txHash }, chain, async () => {
            // Iter914: wall-clock for the RPC roundtrip to fetch + decode the
            // tx receipt + Transfer events. Useful for operators investigating
            // a specific tx on a degraded RPC.
            const t0 = Date.now();
            const config = rt.getConfig();
            const wallet = await rt.getContext(chain);
            const profile = resolveProfile(wallet.chain, config);
            const { decodeTx } = await import("../decodeTx.js");
            try {
              const decoded = await decodeTx(wallet.publicClient, profile, txHash as `0x${string}`);
              return { ok: true, ...decoded, elapsedMs: Date.now() - t0 };
            } catch (e) {
              // Iter300: name the chain queried + common causes. Agents often guess the
              // chain wrong; explicit chain name in the message helps them retry with
              // the correct one rather than re-asking the user.
              throw new ToolError(
                "TX_NOT_FOUND",
                `Transaction ${txHash} not found on ${wallet.chain}. Possible causes: (1) tx is on a different chain — retry with chain=<name>; (2) tx is very recent and not yet propagated to this RPC; (3) tx hash is wrong.`,
                { cause: e },
              );
            }
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );
};
