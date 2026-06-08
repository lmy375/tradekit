// MCP security tools: allowances, approve, revoke. The "manage what's pre-authorized
// to spend from your wallet" surface — a key risk lens.

import { z } from "zod";
import { parseUnits, type Address } from "viem";
import { resolveProfile } from "../config.js";
import { resolveToken, assertAddressEIP55, unknownTokenError } from "../chains.js";
import { listAllowances, approveToken, revokeToken, planRevokeAll, executeRevokeAll } from "../approvals.js";
import { getToken } from "../tokens.js";
import { ToolError, toToolError } from "../errors.js";
import { ok, fail, runTool, type RegisterFn } from "./runtime.js";

// Iter292: assertCheckedSpender consolidated into assertAddressEIP55 (shared with
// cli/approvals.ts). Same two-step shape + checksum pattern; thin wrapper here pins
// the "spender" label so call sites stay readable.
const assertCheckedSpender = (raw: string): `0x${string}` =>
  assertAddressEIP55("spender", raw) as `0x${string}`;

export const registerSecurityTools: RegisterFn = (server, rt) => {
  // ── allowances ────────────────────────────────────────────
  server.tool(
    "allowances",
    "List non-zero ERC20 approvals for the active wallet on a chain. Probes known aggregator routers + the chain profile's tokens. Use this to audit standing approvals (a major attack surface) and to clean up old ones. Returns { ok, units, count, summary: { total, infinite, unknownSpender }, allowances[], elapsedMs } with each allowance carrying spender, spenderLabel, token, symbol, amount, display. Iter780 — summary pre-computes the at-a-glance risk signals (infinite = allowance ≥ 2^255 / drain vector; unknownSpender = no curated label / verify out-of-band before trusting); for full risk classification call audit_allowances. Iter941 — elapsedMs is wall-clock for the RPC fan-out (tokens × spenders probe); agents tail this for chain-RPC degradation. Errors: WALLET_NOT_FOUND (no wallet — details.reason discriminates the state); UNKNOWN_ACCOUNT (typo'd account label — details.suggestion may carry a close match); UNKNOWN_CHAIN (chain typo); RPC_FAILED (chain unreachable — nextActions carries a scoped doctor call).",
    {
      chain: z.string().optional(),
      // Iter276: shape-validate each address up front. Pre-iter276 the zod schema
      // accepted any string per array entry; a malformed input like ["abc"] sailed
      // through and blew up several hops later inside viem's contract-read with a
      // confusing error. EIP-55 checksum is NOT required here — these are probe
      // candidates (read-only), not approval recipients — so any valid shape is fine.
      tokens: z
        .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/, "token addresses must be 0x-prefixed 40 hex chars"))
        .optional()
        .describe("Optional token addresses to probe (defaults to chain profile tokens)."),
      extraSpenders: z
        .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/, "spender addresses must be 0x-prefixed 40 hex chars"))
        .optional()
        .describe("Additional spender addresses to probe."),
      account: z.string().optional().describe("HD account label override; defaults to active."),
    },
    async ({ chain, tokens, extraSpenders, account }) => {
      try {
        return ok(
          await runTool("allowances", rt.opts, { chain, tokens, extraSpenders, account }, chain, async () => {
            // Iter941: wall-clock for the listAllowances RPC fan-out
            // (tokens × spenders probe). Agents in watch mode detect
            // chain-level RPC degradation as elapsed jumps.
            const t0 = Date.now();
            const config = rt.getConfig();
            const wallet = await rt.getContext(chain, account);
            const profile = resolveProfile(wallet.chain, config);
            const rows = await listAllowances(
              { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger: rt.opts.logger },
              {
                tokens: tokens as `0x${string}`[] | undefined,
                extraSpenders: extraSpenders as `0x${string}`[] | undefined,
              },
            );
            // Iter780: pre-compute at-a-glance risk counts so agents triaging
            // exposure don't iterate. Same INFINITE_THRESHOLD (2^255) the iter606
            // audit + iter712 CLI footer use; `unknownSpender` flags rows whose
            // spender isn't in the curated KNOWN_ROUTERS registry (a "verify
            // before trusting" signal — agents should refuse a trade through
            // any unknown-spender allowance unless out-of-band verified).
            const INFINITE_THRESHOLD = 1n << 255n;
            let infiniteCount = 0;
            let unknownSpenderCount = 0;
            for (const r of rows) {
              if (r.allowance >= INFINITE_THRESHOLD) infiniteCount++;
              if (r.spenderLabel == null) unknownSpenderCount++;
            }
            return {
              ok: true,
              units: { allowance: "raw token units; display also shows decimal" },
              count: rows.length,
              summary: {
                total: rows.length,
                infinite: infiniteCount,
                unknownSpender: unknownSpenderCount,
              },
              allowances: rows,
              elapsedMs: Date.now() - t0,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── approve ───────────────────────────────────────────────
  server.tool(
    "approve",
    "Approve an ERC20 token allowance for a spender. Pass infinite=true for max approval (blocked by safety unless override=true or safety.allowInfiniteApprovals=true). Units: amount is in token decimal units. Result also carries (iter681) `spenderIsKnown` (boolean), `spenderLabel` (when known), `spenderClassification` (`router` for curated aggregators like KyberSwap/OpenOcean/Uniswap, `whitelist` for config-driven matches, `address-book` for operator-labeled, `unknown` otherwise) — agents approving to a spender with `spenderIsKnown=false` should treat the allowance as higher-risk and verify the spender out-of-band before proceeding to a follow-up trade that would use it. Errors: INVALID_PARAMS (no amount AND no infinite — explicit intent required), UNKNOWN_TOKEN (symbol/address can't be resolved on this chain; details.suggestion may carry a close match), TOKEN_BLOCKED, CONTRACT_BLOCKED (spender not in safety.contractWhitelist — nextActions points to config push), SAFEGUARD_TRIGGERED (infinite without override), AMOUNT_EXCEEDS_LIMIT (USD value over maxApprovalUsdLimit cap), TX_TIMEOUT (tx sent but no receipt within waitForReceipt timeout — row is persisted as pending; reconcile to resolve), TX_REVERTED (sendTransaction itself rejected — gas too low / nonce conflict / replacement-underpriced; classifyReason patterns provide actionable nextActions). On a reverted on-chain approve (status=\"failed\") the result carries explorerUrl + a viewTx nextAction; the tx still cost gas.",
    {
      chain: z.string().optional(),
      token: z.string().describe("ERC20 token address or symbol (must resolve via chain profile)."),
      spender: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "spender must be 0x-prefixed 40 hex chars (20-byte EVM address)")
        .describe("Contract address to grant the approval to."),
      amount: z.string().optional().describe("Decimal amount (e.g. \"100\"). Mutually exclusive with infinite."),
      infinite: z.boolean().optional().describe("If true, approve maxUint256 (blocked by safety unless `override=true` or `safety.allowInfiniteApprovals=true`). Default: false."),
      override: z.boolean().optional().describe("Bypass the infinite-approval safety gate (use cautiously — defeats the safety.allowInfiniteApprovals=false setting). Default: false."),
      account: z.string().optional().describe("HD account label override; defaults to active."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("approve", rt.opts, input, input.chain, async () => {
            const config = rt.getConfig();
            const wallet = await rt.getContext(input.chain, input.account);
            const profile = resolveProfile(wallet.chain, config);
            // resolveToken already passes through a well-shaped 0x-prefixed address;
            // calling it for both symbols and raw addresses is enough.
            const tokenAddr = resolveToken(profile, input.token);
            // Iter353: shared helper from chains.ts surfaces the iter345 "Did you mean" hint.
            if (!tokenAddr) throw unknownTokenError("token", input.token, profile);
            const meta = await getToken(wallet.publicClient, profile, tokenAddr);
            if (meta.isNative) throw new ToolError("INVALID_PARAMS", "Native asset cannot be approved.");
            // Iter275: require explicit intent (matches CLI). Pre-iter275 an agent
            // calling `approve { token, spender }` with neither amount nor infinite
            // silently sent approve(spender, 0) — a hidden revoke. The dedicated
            // `revoke` tool exists for the zero case.
            if (!input.infinite && !input.amount) {
              throw new ToolError(
                "INVALID_PARAMS",
                "approve requires either `amount` (decimal) or `infinite: true`. To set the allowance to zero, use the dedicated `revoke` tool instead.",
              );
            }
            const amountBn = input.infinite ? undefined : parseUnits(input.amount!, meta.decimals);
            // Iter281: same rounds-to-0 guard as iter280/iter281. Tiny decimal amount
            // that parses to 0n at low token decimals would silently turn an approve
            // into a revoke. Reject explicitly.
            if (!input.infinite && amountBn === 0n) {
              const { formatUnits } = await import("viem");
              throw new ToolError(
                "INVALID_PARAMS",
                `amount "${input.amount}" rounds to 0 raw units at ${meta.decimals} decimals — too small to grant. Use at least the minimum representable amount (${formatUnits(1n, meta.decimals)}). To revoke an existing allowance, use the dedicated \`revoke\` tool instead.`,
              );
            }
            return await approveToken(
              {
                publicClient: wallet.publicClient,
                walletClient: wallet.walletClient,
                profile,
                logger: rt.opts.logger,
                config,
              },
              {
                token: tokenAddr,
                spender: assertCheckedSpender(input.spender),
                amount: amountBn,
                infinite: input.infinite,
                override: input.override,
              },
            );
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── revoke ────────────────────────────────────────────────
  server.tool(
    "revoke",
    "Revoke an ERC20 allowance (set to 0). Equivalent to `approve` with amount=0. Safety guardrails (token blacklist, contract whitelist, USD caps) are bypassed for revokes — removing exposure is always permitted. Errors: UNKNOWN_TOKEN (symbol/address can't be resolved on this chain; details.suggestion may carry a close match), TX_TIMEOUT (tx sent but no receipt within waitForReceipt timeout — row is persisted as pending; reconcile to resolve), TX_REVERTED (sendTransaction itself rejected — gas too low / nonce conflict / replacement-underpriced; classifyReason patterns provide actionable nextActions). Pre-iter600 only UNKNOWN_TOKEN was documented; an agent that hit a gas-too-low revoke had no signal what to retry. On a reverted on-chain revoke the result carries explorerUrl + a viewTx nextAction.",
    {
      chain: z.string().optional(),
      token: z.string(),
      spender: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "spender must be 0x-prefixed 40 hex chars (20-byte EVM address)"),
      account: z.string().optional().describe("HD account label override; defaults to active."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("revoke", rt.opts, input, input.chain, async () => {
            const config = rt.getConfig();
            const wallet = await rt.getContext(input.chain, input.account);
            const profile = resolveProfile(wallet.chain, config);
            const tokenAddr = resolveToken(profile, input.token);
            // Iter353: shared helper from chains.ts surfaces the iter345 "Did you mean" hint.
            if (!tokenAddr) throw unknownTokenError("token", input.token, profile);
            return await revokeToken(
              { publicClient: wallet.publicClient, walletClient: wallet.walletClient, profile, logger: rt.opts.logger },
              { token: tokenAddr, spender: assertCheckedSpender(input.spender) },
            );
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── check_token (iter609) ─────────────────────────────────
  // Probe a token for honeypot / high-tax behavior via a buy+sell round-trip
  // simulation. Read-only (eth_call only, zero gas). Use BEFORE buying an
  // unknown token to detect the most common rug patterns.
  server.tool(
    "check_token",
    "Probe a token for honeypot or high-tax behavior via a buy+sell round-trip simulation. Returns { ok, chain, token, symbol, decimals, probeUsd, probeNativeAmount, buyQuoted, buySimulated, buyRevertReason?, expectedTokenOut?, sellQuoted, sellSimulated, sellRevertReason?, expectedNativeOut?, roundTripLossPct, suspiciousLossPct, verdict, reasons[], timestamp, elapsedMs }. Iter942 — elapsedMs is wall-clock for the ~4 RPC roundtrip probe; spikes flag a degraded chain RPC where honeypot detection becomes unreliable. verdict: 'ok' (round-trip succeeds within slippage+gas budget), 'suspicious' (loss exceeds threshold — likely high-tax token), 'honeypot' (buy works but sell quote/simulate fails — classic drain pattern), 'unknown' (insufficient info, e.g. no liquidity). Pure read-only — costs ~4 RPC roundtrips, zero gas. Use before buying an unknown token to detect rugs BEFORE committing real funds. Note: probes from current state only — time-locked or owner-gated sells that activate later won't be detected; treat as a sanity check, not a guarantee.",
    {
      chain: z.string().optional(),
      token: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "token must be 0x-prefixed 40 hex chars (20-byte EVM address)")
        .describe("Token address to probe."),
      probeUsd: z
        .number()
        .positive()
        .max(1000)
        .optional()
        .describe("USD-denominated probe size (default 10). Larger = more realistic but moves the pool; smaller = better signal on illiquid tokens. Capped at $1000."),
      suspiciousLossPct: z
        .number()
        .positive()
        .max(100)
        .optional()
        .describe("Round-trip loss % above which verdict='suspicious' (default 20). Account for slippage + gas + transfer tax."),
      account: z.string().optional().describe("HD account label override; defaults to active. Used only as the simulator's from-address; no signing."),
    },
    async ({ chain, token, probeUsd, suspiciousLossPct, account }) => {
      try {
        return ok(
          await runTool("check_token", rt.opts, { chain, token, probeUsd, suspiciousLossPct, account }, chain, async () => {
            // Iter942: wall-clock for the buy+sell round-trip simulation
            // (~4 RPC roundtrips per checkTokenSafety call). Agents pre-trade
            // use this to detect chain-RPC degradation that would otherwise
            // make honeypot probes unreliable.
            const t0 = Date.now();
            const config = rt.getConfig();
            const wallet = await rt.getContext(chain, account);
            const profile = resolveProfile(wallet.chain, config);
            const { checkTokenSafety } = await import("../tokenSafety.js");
            const report = await checkTokenSafety({
              token: token as `0x${string}`,
              probeUsd,
              suspiciousLossPct,
              publicClient: wallet.publicClient,
              walletAddress: wallet.account.address as `0x${string}`,
              profile,
              config,
              logger: rt.opts.logger,
            });
            return { ok: true, ...report, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── audit_allowances (iter606) ────────────────────────────
  // Layer risk scoring on top of `allowances` — surface dangerous standing
  // approvals first instead of the flat list. Returns the same allowance set
  // augmented with severity (ok/warn/critical), per-allowance findings (reason
  // codes + messages), usdExposure estimate (null for infinite or unpriced),
  // and a typed recommendedAction (revoke tool params pre-filled).
  //
  // Pre-iter606 an agent calling `allowances` had to recognize each spender by
  // heart to spot the dangerous ones. The audit makes the worst-first ordering
  // structural so the agent's "should I revoke this?" decision becomes
  // straightforward.
  server.tool(
    "audit_allowances",
    "Risk-score every standing ERC20 approval for the active wallet. Single-chain mode (`chain` set, no `chains`) returns { ok, chain, owner, timestamp, counts, severity, allowances[], elapsedMs, recommendedActions[] } — iter749 elapsedMs (wall-clock for listAllowances RPC fan-out + per-token price lookups + optional freshness scan + scoring); iter788 severity (worst-bucket string 'ok' | 'warn' | 'critical' — branch on this for at-a-glance status instead of computing counts.critical > 0 etc). Iter632 multi-chain mode (`chains` set, OR \"all\") returns { ok, timestamp, chains[], chainsScanned[], perChain: { [chain]: report }, errors[], counts, severity, allowances[], recommendedActions[] } where allowances[] is the cross-chain MERGED list sorted by severity then USD desc (each entry carries `chain`); per-chain reports each carry their own elapsedMs + severity for cross-chain comparison. Use multi-chain to triage exposure across a multi-chain wallet in ONE call. allowances[] is sorted CRITICAL → WARN → OK; within each bucket by usdExposure descending (unbounded infinite first). Risk codes: infinite_unknown_spender (critical — classic wallet-drain vector), infinite_known_router (warn), large_usd_exposure (warn), blacklisted_token_still_approved (warn), stale_approval (warn, iter617 — only fires when lookbackBlocks is provided; multi-chain mode SKIPS the freshness scan for cost). Each allowance carries a typed `recommendedAction` (iter681) with the revoke tool's exact params so an agent can dispatch directly. Iter838: top-level `recommendedActions[]` pre-filters the TOP-3 critical allowances by USD exposure (infinite/unbounded ranked first) — agents trying to revoke 'the worst' approvals without iterating 47 entries get the high-urgency subset in one field read. Multi-chain version aggregates the cross-chain top-3 (an infinite Base approval ranks against an Arbitrum one naturally via the USD sort). Empty when severity='ok'. Use as the entry-point for security cleanup: audit → revoke (single) or revoke_all (bulk).",
    {
      chain: z.string().optional(),
      chains: z
        .union([z.array(z.string()), z.literal("all")])
        .optional()
        .describe(
          "Iter632: array of chain names OR \"all\". When set, returns the multi-chain aggregate shape (perChain + cross-chain merged allowances). Takes precedence over `chain`. Freshness scan is skipped in multi-chain mode for cost reasons.",
        ),
      account: z.string().optional().describe("HD account label override; defaults to active."),
      usdThreshold: z
        .number()
        .positive()
        .optional()
        .describe("USD value over which a finite allowance is flagged as large_usd_exposure. Default 10000."),
      lookbackBlocks: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Iter617: when set (single-chain mode only), scan this many blocks back from head for Approval events to age each (token, spender). Adds `grantedAt` to each allowance + enables the stale_approval risk signal. Costs N/5000 eth_getLogs RPC calls; omit for the cheap audit. Ignored in multi-chain mode.",
        ),
      staleDays: z
        .number()
        .positive()
        .optional()
        .describe("Iter617: days after which an approval is flagged stale_approval. Default 180."),
    },
    async ({ chain, chains, account, usdThreshold, lookbackBlocks, staleDays }) => {
      try {
        return ok(
          await runTool("audit_allowances", rt.opts, { chain, chains, account, usdThreshold, lookbackBlocks, staleDays }, chain, async () => {
            // Iter632: multi-chain branch.
            if (chains !== undefined) {
              const { listChains } = await import("../chains.js");
              const { getCurrentPrice } = await import("../price.js");
              const { KNOWN_ROUTERS } = await import("../routers.js");
              const { auditAllowanceList, aggregateMultiChainAudits } = await import("../approvalAudit.js");
              const config = rt.getConfig();
              const allChains = [...listChains(), ...Object.keys(config.chains)];
              const targets = chains === "all" ? allChains : chains;
              const knownRouters = new Set(KNOWN_ROUTERS.map((r) => r.address.toLowerCase()));
              const perChainReports = [];
              const errors: Array<{ chain: string; message: string }> = [];

              for (const chainName of targets) {
                // Iter749: per-chain wall clock.
                const tChain = Date.now();
                try {
                  const wallet = await rt.getContext(chainName, account);
                  const profile = resolveProfile(chainName, config);
                  const rows = await listAllowances(
                    { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger: rt.opts.logger },
                    {},
                  );
                  if (rows.length === 0) continue;
                  const uniqueTokens = Array.from(new Set(rows.map((r) => r.token.toLowerCase())));
                  const priceResults = await Promise.all(
                    uniqueTokens.map(async (t) => {
                      try {
                        const p = await getCurrentPrice(t as `0x${string}`, rt.opts.logger);
                        return { token: t, price: p };
                      } catch {
                        return { token: t, price: null };
                      }
                    }),
                  );
                  const tokenPrices = new Map<string, number>();
                  for (const r of priceResults) {
                    if (r.price != null) tokenPrices.set(r.token, r.price);
                  }
                  const r = auditAllowanceList(rows, {
                    chain: chainName,
                    config,
                    knownRouters,
                    tokenPrices,
                    usdThreshold,
                    owner: wallet.account.address,
                  });
                  r.elapsedMs = Date.now() - tChain;
                  perChainReports.push(r);
                } catch (e) {
                  errors.push({ chain: chainName, message: (e as Error).message });
                  rt.opts.logger.debug(`audit_allowances multi-chain: ${chainName} failed: ${(e as Error).message}`);
                }
              }
              return {
                ok: true,
                ...aggregateMultiChainAudits({ perChainReports, chainsScanned: targets, errors }),
              };
            }

            // Iter749: wall-clock encompasses listAllowances + price fan-out
            // + optional freshness scan + scoring.
            const t0 = Date.now();
            const config = rt.getConfig();
            const wallet = await rt.getContext(chain, account);
            const profile = resolveProfile(wallet.chain, config);
            const rows = await listAllowances(
              { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger: rt.opts.logger },
              {},
            );
            const { getCurrentPrice } = await import("../price.js");
            const uniqueTokens = Array.from(new Set(rows.map((r) => r.token.toLowerCase())));
            const priceResults = await Promise.all(
              uniqueTokens.map(async (t) => {
                try {
                  const p = await getCurrentPrice(t as `0x${string}`, rt.opts.logger);
                  return { token: t, price: p };
                } catch {
                  return { token: t, price: null };
                }
              }),
            );
            const tokenPrices = new Map<string, number>();
            for (const r of priceResults) {
              if (r.price != null) tokenPrices.set(r.token, r.price);
            }
            const { KNOWN_ROUTERS } = await import("../routers.js");
            const knownRouters = new Set(KNOWN_ROUTERS.map((r) => r.address.toLowerCase()));

            // Iter617: optional freshness scan — same logic the CLI uses.
            let freshness: Map<string, { timestamp: string | null; blockNumber: number; txHash: string }> | undefined;
            if (lookbackBlocks != null && lookbackBlocks > 0 && rows.length > 0) {
              const { scanApprovalFreshness } = await import("../approvalFreshness.js");
              const latest = await wallet.publicClient.getBlockNumber();
              const lb = BigInt(lookbackBlocks);
              const fromBlock = latest > lb ? latest - lb : 0n;
              const fr = await scanApprovalFreshness({
                publicClient: wallet.publicClient,
                profile,
                owner: wallet.account.address,
                fromBlock,
                toBlock: latest,
                logger: rt.opts.logger,
              });
              freshness = new Map();
              for (const e of fr.entries) {
                freshness.set(`${e.token}:${e.spender}`, {
                  timestamp: e.timestamp ?? null,
                  blockNumber: e.blockNumber,
                  txHash: e.txHash,
                });
              }
            }

            const { auditAllowanceList } = await import("../approvalAudit.js");
            const report = auditAllowanceList(rows, {
              chain: wallet.chain,
              config,
              knownRouters,
              tokenPrices,
              usdThreshold,
              owner: wallet.account.address,
              freshness,
              staleDays,
            });
            report.elapsedMs = Date.now() - t0;
            return { ok: true, ...report };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── revoke_all (iter604) ──────────────────────────────────
  // Bulk-revoke standing approvals — closes the cross-surface gap pre-iter604
  // had (CLI's `allowances revoke-all` had no MCP equivalent, forcing agents
  // to loop the single-shot `revoke` tool serially with no gas pre-check).
  //
  // Operation modes (via the dryRun flag):
  //   - dryRun=true (DEFAULT): preflight only. Returns target list + gas
  //     estimate + walletNativeBalance + hasGasFunds. No tx sent.
  //   - dryRun=false + confirm=true: executes the loop. Requires confirm so a
  //     stray "dryRun: false" doesn't accidentally fire 20 revoke txs.
  //
  // Filters narrow the target set: `spender` matches an exact address (the
  // common case — "revoke everything I gave to Uniswap V2 router"); `token`
  // matches a token symbol OR address (case-insensitive). Both filters can be
  // combined.
  server.tool(
    "revoke_all",
    "Bulk-revoke standing ERC20 approvals matching the given filters (or all if no filters). Default dryRun=true returns the target list + total gas estimate + affordability check WITHOUT sending. Pass dryRun=false + confirm=true to execute the loop. Returns { action: \"preflight\"|\"revoked\"|\"noop-empty\", ... } with action-discriminated shape. Errors: INSUFFICIENT_BALANCE (estimated gas exceeds wallet's native — surfaced BEFORE the loop starts so you don't run half the revokes and stall; details.reason='bulk_revoke_gas_shortfall'), INVALID_PARAMS (confirm not set when dryRun=false), UNKNOWN_CHAIN, RPC_FAILED. Use to clean up after a chain rotation or to revoke a compromised aggregator's standing approvals in one call.",
    {
      chain: z.string().optional(),
      spender: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "spender must be 0x-prefixed 40 hex chars (20-byte EVM address)")
        .optional()
        .describe("Restrict to allowances granted to this spender (case-insensitive). Omit to match all spenders."),
      token: z
        .string()
        .optional()
        .describe("Restrict to this token (case-insensitive symbol OR 0x-prefixed address). Omit to match all tokens."),
      dryRun: z
        .boolean()
        .optional()
        .describe("If true (default), returns the preflight plan without sending. Pass false (with confirm=true) to execute."),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true when dryRun=false — explicit opt-in for the bulk revoke. Parity with CLI's --yes."),
      account: z.string().optional().describe("HD account label override; defaults to active."),
    },
    async ({ chain, spender, token, dryRun, confirm, account }) => {
      try {
        return ok(
          await runTool("revoke_all", rt.opts, { chain, spender, token, dryRun, confirm, account }, chain, async () => {
            const config = rt.getConfig();
            const wallet = await rt.getContext(chain, account);
            const profile = resolveProfile(wallet.chain, config);

            const plan = await planRevokeAll(
              { publicClient: wallet.publicClient, profile, owner: wallet.account.address, logger: rt.opts.logger },
              { spender: spender as Address | undefined, token },
            );

            if (plan.targets.length === 0) {
              return { ok: true, action: "noop-empty" as const, chain: plan.chain, count: 0, timestamp: new Date().toISOString() };
            }

            // Default dryRun=true: return the preflight plan, don't execute.
            const isDryRun = dryRun !== false;
            if (isDryRun) {
              return { ok: true, ...plan, timestamp: new Date().toISOString() };
            }

            // Real run requires explicit confirm — pre-iter604 the CLI required
            // --yes; MCP needs the same opt-in to prevent a typo "dryRun: false"
            // from firing 20 revoke txs.
            if (confirm !== true) {
              throw new ToolError(
                "INVALID_PARAMS",
                "revoke_all with dryRun=false requires explicit confirm=true. The bulk revoke sends one tx per matching approval — confirm only when that's what you want.",
                { details: { reason: "confirm_required", targetCount: plan.targets.length } },
              );
            }

            // Gas-affordability gate — same as CLI iter604.
            if (!plan.hasGasFunds) {
              throw new ToolError(
                "INSUFFICIENT_BALANCE",
                `Wallet has ${plan.walletNativeBalance} ${profile.nativeSymbol} but estimated bulk-revoke cost is ${plan.estimatedGasNative} ${profile.nativeSymbol}. Top up native, or call with dryRun=true to preview.`,
                {
                  details: {
                    balance: plan.walletNativeBalance,
                    required: plan.estimatedGasNative,
                    symbol: profile.nativeSymbol,
                    chain: plan.chain,
                    targetCount: plan.targets.length,
                    reason: "bulk_revoke_gas_shortfall",
                  },
                },
              );
            }

            const report = await executeRevokeAll(
              { publicClient: wallet.publicClient, walletClient: wallet.walletClient, profile, logger: rt.opts.logger, config },
              plan.targets,
            );
            return { ok: true, ...report, timestamp: new Date().toISOString() };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── safety_drawdown (iter26) ───────────────────────────────
  //
  // Inspect drawdown circuit breaker state. Distinct from the
  // stateless "is drawdown configured?" check — this surfaces the
  // PERSISTED peak + current value + tripped flag per scope.
  server.tool(
    "safety_drawdown",
    "Inspect drawdown circuit breaker state. Returns peak USD, last observed value, computed drawdown %, tripped flag + tripped_at timestamp per scope. When `engine.safety.drawdownCircuitBreaker.enabled=true`, this also returns the configured maxDrawdownPct + autoResumeAtPct so agents can compute the recovery threshold ($peak × (1 - autoResumeAtPct/100)) without re-reading config. Empty state means the next trade will seed the peak.",
    {
      scope: z.string().optional().describe("Scope key — v1 supports 'global' only. Omit for all scopes."),
    },
    async ({ scope }) => {
      try {
        return ok(
          await runTool("safety_drawdown", rt.opts, { scope }, undefined, async () => {
            const { getDrawdownState, listDrawdownStates } = await import("../db.js");
            const { loadConfig } = await import("../config.js");
            const cfg = loadConfig().safety.drawdownCircuitBreaker;
            const states = scope
              ? [getDrawdownState(scope)].filter((s): s is NonNullable<typeof s> => s != null)
              : listDrawdownStates();
            const hydrated = states.map((s) => {
              const drawdownPct = s.last_value_usd != null && s.peak_usd > 0
                ? ((s.peak_usd - s.last_value_usd) / s.peak_usd) * 100
                : null;
              return {
                scope: s.scope_key,
                peak_usd: s.peak_usd,
                peak_at: s.peak_at,
                last_value_usd: s.last_value_usd,
                drawdown_pct: drawdownPct,
                tripped: s.tripped_at != null,
                tripped_at: s.tripped_at,
                updated_at: s.updated_at,
              };
            });
            return {
              ok: true,
              configured: cfg != null,
              enabled: cfg?.enabled ?? false,
              config: cfg ?? null,
              states: hydrated,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── safety_reset_drawdown (iter26) ─────────────────────────
  //
  // Clear the tripped flag (manual reset). Optional `new_peak_usd`
  // re-anchors the peak; default re-anchors to the most recently
  // observed value (prevents immediate re-tripping). Destructive
  // (mutates the breaker state); requires `yes: true`.
  server.tool(
    "safety_reset_drawdown",
    "Clear the drawdown circuit breaker's tripped flag and optionally re-anchor the peak USD. Without `new_peak_usd`, the peak re-anchors to the most recently observed value (prevents the breaker from re-tripping immediately on the next trade). With it, the peak takes on the explicit value. Destructive: requires `yes: true`. Errors: INVALID_PARAMS (no state for scope; yes flag missing).",
    {
      scope: z.string().optional().describe("Scope key — v1 supports 'global' only; default 'global'."),
      new_peak_usd: z.number().positive().optional().describe("Explicit re-anchor value. Default: re-anchor to last observed value."),
      yes: z.literal(true).describe("Confirmation flag — reset mutates breaker state; must be `true`."),
    },
    async ({ scope, new_peak_usd, yes }) => {
      try {
        return ok(
          await runTool("safety_reset_drawdown", rt.opts, { scope, new_peak_usd, yes }, undefined, async () => {
            if (!yes) {
              throw new ToolError("INVALID_PARAMS", `Confirmation flag required: pass yes=true.`);
            }
            const { resetDrawdownState } = await import("../db.js");
            const scopeKey = scope ?? "global";
            const after = resetDrawdownState({ scopeKey, newPeakUsd: new_peak_usd });
            if (!after) {
              throw new ToolError("INVALID_PARAMS", `No drawdown state for scope "${scopeKey}". Nothing to reset.`);
            }
            return {
              ok: true,
              state: {
                scope: after.scope_key,
                peak_usd: after.peak_usd,
                peak_at: after.peak_at,
                tripped: after.tripped_at != null,
                tripped_at: after.tripped_at,
                last_value_usd: after.last_value_usd,
                updated_at: after.updated_at,
              },
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );
};
