// MCP paper-trading tools.
//
// Paper trading runs orders / schedules / playbooks against a virtual
// book that mirrors the on-chain shape but never submits a transaction
// (see paperTrade.ts). The CLI already exposes the full lifecycle
// (`tradekit paper trades/balances/deposit/pnl/reset`); this module
// brings the same surface to MCP so an agent can dry-run an entire
// strategy against the virtual book — seed funds, inspect the
// position book, page the fill journal, read realized P&L, and reset —
// WITHOUT touching real capital or shelling out to the CLI.
//
// Why this matters for agents: paper mode is the safety primitive. An
// agent validating a new OCO ladder / DCA cadence / trailing level
// should be able to flip `paper: true` on the primitives AND manage
// the virtual book entirely through MCP. Before this module the agent
// could fire paper trades (via the order/schedule `paper` flag) but
// had no MCP way to see the results or manage the book — a real gap
// in the dry-run loop.
//
// Design parity with the CLI (cli/paper.ts):
//   - Decimals come from the same on-chain getToken lookup the trade
//     flow uses; balances are decimal strings keyed by (account, chain,
//     token).
//   - paper_deposit defaults to CREDIT mode (add to balance); pass
//     mode:"set" to overwrite to an exact value. Negative credit is
//     rejected (use a debit via mode:"set" or a negative... no — the
//     CLI rejects negative credit; we mirror that).
//   - paper_reset is DESTRUCTIVE (deletes rows) so it requires
//     confirm:true — the same opt-in discipline revoke_all / audit
//     prune use. A scope-less reset wipes EVERY account+chain.
//
// All tools route through runTool so each call lands an audit row and
// carries elapsedMs, consistent with the rest of the MCP surface.

import { z } from "zod";
import { resolveProfile } from "../config.js";
import { resolveToken } from "../chains.js";
import { getToken } from "../tokens.js";
import {
  setPaperBalance,
  adjustPaperBalance,
  summarizePaperPnl,
} from "../paperTrade.js";
import { computePaperPnlMtm, defaultPaperPriceFetcher } from "../paperPnl.js";
import {
  listPaperTrades,
  listPaperBalances,
  resetPaperState,
  type ListPaperTradesFilter,
} from "../db.js";
import { ToolError, toToolError } from "../errors.js";
import { ok, fail, runTool, type RegisterFn } from "./runtime.js";

export const registerPaperTools: RegisterFn = (server, rt) => {
  // ── paper_balances ───────────────────────────────────────────
  server.tool(
    "paper_balances",
    "List virtual (paper) token balances — the synthetic book that `paper: true` orders / schedules / playbooks trade against. Returns { ok, count, balances: [{ account, chain, token, balance, updated_at }], elapsedMs }. `balance` is a decimal string in the token's native units; `token` is the 0x address. Filters: `account` and `chain` (both optional; omit for all scopes). Empty book → balances=[] (not an error) — seed it with paper_deposit before firing paper buys. This is read-only and never touches real funds or the chain.",
    {
      account: z.string().optional().describe("Account label filter (default: all accounts)."),
      chain: z.string().optional().describe("Chain filter (default: all chains)."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("paper_balances", rt.opts, input, input.chain, async () => {
            const t0 = Date.now();
            const filter: { account?: string; chain?: string } = {};
            if (input.account) filter.account = input.account;
            if (input.chain) filter.chain = input.chain;
            const balances = listPaperBalances(filter);
            return { count: balances.length, balances, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── paper_trades ─────────────────────────────────────────────
  server.tool(
    "paper_trades",
    "Page the paper-trade fill journal — every virtual fill produced by `paper: true` primitives. Returns { ok, count, trades: [{ id, timestamp, source_type, source_id, chain, account, direction, base_token, base_symbol, base_amount, quote_token, quote_symbol, quote_amount, price, slippage_bps, strategy, notes }], elapsedMs }, newest-first. `source_type` is order|schedule|rebalance|manual and `source_id` ties the fill back to the spawning primitive. Filters (all optional): `account`, `chain`, `strategy`, `source` (order|schedule|rebalance|manual), `since`/`until` (ISO-8601), `limit` (default unbounded — pass a cap for large books). Read-only; for a P&L roll-up use paper_pnl instead of summing this yourself.",
    {
      account: z.string().optional(),
      chain: z.string().optional(),
      strategy: z.string().optional(),
      source: z.enum(["order", "schedule", "rebalance", "manual"]).optional().describe("Filter by spawning primitive type."),
      since: z.string().optional().describe("ISO-8601 lower bound (inclusive) on fill timestamp."),
      until: z.string().optional().describe("ISO-8601 upper bound (inclusive) on fill timestamp."),
      limit: z.number().int().positive().max(10_000).optional(),
    },
    async (input) => {
      try {
        return ok(
          await runTool("paper_trades", rt.opts, input, input.chain, async () => {
            const t0 = Date.now();
            const filter: ListPaperTradesFilter = {};
            if (input.account) filter.account = input.account;
            if (input.chain) filter.chain = input.chain;
            if (input.strategy) filter.strategy = input.strategy;
            if (input.source) filter.sourceType = input.source;
            if (input.since) filter.sinceIso = input.since;
            if (input.until) filter.untilIso = input.until;
            if (input.limit != null) filter.limit = input.limit;
            const trades = listPaperTrades(filter);
            return { count: trades.length, trades, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── paper_pnl ────────────────────────────────────────────────
  server.tool(
    "paper_pnl",
    "Quote-denominated P&L for paper trades, grouped by strategy. DEFAULT (deterministic, journal-only): returns { ok, count, summaries: [{ strategy, fills, buys, sells, quoteSpent, quoteReceived, netQuote, firstFillAt, lastFillAt }], elapsedMs }, sorted by fill count desc — REALIZED cash flow only (`netQuote = quoteReceived - quoteSpent`). Pass `mtm: true` for mark-to-market: each summary becomes a SUPERSET adding { realizedQuote (weighted-average cost-basis realized), unrealizedQuote (open positions marked at current oracle prices; null when every open position is unpriced), totalQuote, openValueQuote, positions: [{ chain, token, symbol, amount, avgCostQuote, realizedQuote, currentPriceQuote, unrealizedQuote, valueQuote, trades, lastTradeAt, untrackedSellBase, untrackedSellQuote }], unpricedPositionCount, skippedNonStableQuote }, plus a top-level `mtm: true` and `timestamp` (when the price marks were fetched). MTM notes: deposits are capital not P&L — base sold without a tracked paper-buy realizes nothing and is reported via untrackedSell*; fills with a non-stablecoin quote are excluded from cost basis (skippedNonStableQuote); one memoized oracle call per distinct held token. mtm results are NOT deterministic (live prices) — omit `mtm` when diffing across runs. Fills with no strategy tag fold into the '(unattributed)' bucket. Filters: `account`, `chain`, `strategy` (all optional). Same cores (summarizePaperPnl / computePaperPnlMtm) as the CLI `paper pnl [--mtm]`, so numbers match exactly across surfaces.",
    {
      account: z.string().optional(),
      chain: z.string().optional(),
      strategy: z.string().optional(),
      mtm: z.boolean().optional().describe("Mark open positions to market via live oracle prices. Adds cost-basis realized/unrealized/total + per-position detail. Non-deterministic — omit for stable, journal-only output."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("paper_pnl", rt.opts, input, input.chain, async () => {
            const t0 = Date.now();
            // Cap at 5000 like the CLI — a realized-P&L roll-up over more
            // than 5k paper fills is almost certainly a runaway book; the
            // cap keeps the aggregation bounded.
            const filter: ListPaperTradesFilter = { limit: 5000 };
            if (input.account) filter.account = input.account;
            if (input.chain) filter.chain = input.chain;
            if (input.strategy) filter.strategy = input.strategy;
            const rows = listPaperTrades(filter);
            if (input.mtm === true) {
              const report = await computePaperPnlMtm(rows, defaultPaperPriceFetcher(rt.getConfig(), rt.opts.logger));
              return { mtm: true, timestamp: report.timestamp, count: report.summaries.length, summaries: report.summaries, elapsedMs: Date.now() - t0 };
            }
            const summaries = summarizePaperPnl(rows);
            return { count: summaries.length, summaries, elapsedMs: Date.now() - t0 };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── paper_deposit ────────────────────────────────────────────
  server.tool(
    "paper_deposit",
    "Seed or adjust a virtual balance so paper buys have something to spend. Two modes: mode='credit' (default — ADD `amount` to the existing balance) or mode='set' (OVERWRITE to exactly `amount`). `amount` is a decimal string in the token's native units. Negative `amount` is rejected in credit mode (a debit would silently shrink the book — use mode='set' to lower a balance explicitly). The token's decimals are read on-chain via the same getToken lookup the trade flow uses, so symbols (ETH/USDC/WBTC) and 0x addresses both work. Returns { ok, mode, account, chain, token, symbol, balance, elapsedMs } where `balance` is the resulting decimal balance. This only mutates the virtual book — no real funds move, no transaction is sent. Errors: UNKNOWN_TOKEN (symbol/address not resolvable on the chain), INVALID_PARAMS (bad amount / negative credit), PAPER_INSUFFICIENT_BALANCE (a mode='set' to negative, or a credit underflow — cannot happen for positive credit).",
    {
      token: z.string().describe("Token symbol (USDC/WETH/ETH/…) or 0x address to credit."),
      amount: z.string().describe("Decimal amount in the token's native units (e.g. \"10000\" for 10k USDC)."),
      mode: z.enum(["credit", "set"]).optional().describe("credit (default): add to balance. set: overwrite to exact value."),
      chain: z.string().optional().describe("Chain (default: active chain)."),
      account: z.string().optional().describe("Account label (default: active account)."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("paper_deposit", rt.opts, input, input.chain, async () => {
            const t0 = Date.now();
            const config = rt.getConfig();
            // getContext resolves the canonical (chain, account) labels and
            // gives a publicClient for the on-chain decimals lookup. The MCP
            // server runs with a password so this never prompts.
            const wallet = await rt.getContext(input.chain, input.account);
            const profile = resolveProfile(wallet.chain, config);
            const tokenAddr = resolveToken(profile, input.token);
            if (!tokenAddr) {
              throw new ToolError(
                "UNKNOWN_TOKEN",
                `Token "${input.token}" not recognized on chain "${wallet.chain}".`,
                { details: { token: input.token, chain: wallet.chain } },
              );
            }
            const mode = input.mode ?? "credit";
            if (mode === "credit" && input.amount.startsWith("-")) {
              throw new ToolError(
                "INVALID_PARAMS",
                "Negative amount in credit mode is a debit. Use mode='set' to overwrite to a lower exact balance, or pass a positive amount to credit.",
              );
            }
            const meta = await getToken(wallet.publicClient, profile, tokenAddr);
            if (mode === "set") {
              setPaperBalance({ account: wallet.label, chain: wallet.chain, token: tokenAddr, decimals: meta.decimals, amount: input.amount });
            } else {
              adjustPaperBalance({ account: wallet.label, chain: wallet.chain, token: tokenAddr, decimals: meta.decimals, delta: input.amount });
            }
            const after = listPaperBalances({ account: wallet.label, chain: wallet.chain }).find(
              (r) => r.token.toLowerCase() === tokenAddr.toLowerCase(),
            );
            return {
              mode,
              account: wallet.label,
              chain: wallet.chain,
              token: tokenAddr,
              symbol: meta.symbol,
              balance: after?.balance ?? "0",
              elapsedMs: Date.now() - t0,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );

  // ── paper_reset ──────────────────────────────────────────────
  server.tool(
    "paper_reset",
    "Wipe paper state (virtual balances + the fill journal) for a scope. DESTRUCTIVE — deletes rows — so it requires confirm:true (mirrors the CLI's --yes gate and revoke_all's confirm). Scope: pass `account` and/or `chain` to wipe just that slice; omit BOTH to wipe EVERY account on EVERY chain (a full paper-book reset). Returns { ok, scope: {account?, chain?}, balancesRemoved, tradesRemoved, elapsedMs }. Real funds are never affected — this only clears the synthetic book. Use between strategy dry-runs to start from a clean book. Errors: INVALID_PARAMS (confirm not set to true).",
    {
      confirm: z.boolean().describe("Must be true. Guards against accidental wipes — the operation deletes virtual balances + paper trade rows."),
      account: z.string().optional().describe("Scope to one account (default: all accounts)."),
      chain: z.string().optional().describe("Scope to one chain (default: all chains)."),
    },
    async (input) => {
      try {
        return ok(
          await runTool("paper_reset", rt.opts, input, input.chain, async () => {
            const t0 = Date.now();
            if (input.confirm !== true) {
              const scope =
                input.account || input.chain
                  ? `account=${input.account ?? "*"} chain=${input.chain ?? "*"}`
                  : "ALL paper state (every account, every chain)";
              throw new ToolError(
                "INVALID_PARAMS",
                `paper_reset is destructive (wipes ${scope}). Re-call with confirm:true to proceed.`,
                { details: { account: input.account ?? null, chain: input.chain ?? null } },
              );
            }
            const filter: { account?: string; chain?: string } = {};
            if (input.account) filter.account = input.account;
            if (input.chain) filter.chain = input.chain;
            const result = resetPaperState(filter);
            return {
              scope: { account: input.account ?? null, chain: input.chain ?? null },
              ...result,
              elapsedMs: Date.now() - t0,
            };
          }),
        );
      } catch (e) {
        return fail(toToolError(e));
      }
    },
  );
};
