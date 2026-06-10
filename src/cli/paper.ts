// CLI surface for paper trading mode (iter30).
//
// Paper trading runs orders/schedules against a virtual book that
// mirrors the on-chain shape but never submits a transaction. The
// CLI here gives operators tools to:
//
//   - paper deposit  — seed the virtual book with a starting balance
//                      so paper buys have something to spend.
//   - paper balances — list virtual balances for review.
//   - paper trades   — page through the paper_trades journal.
//   - paper pnl      — per-strategy realized P&L summary; --mtm adds
//                      cost-basis positions marked at current prices.
//   - paper reset    — wipe paper state (per-scope or globally).
//
// Design notes:
//
//  * All write commands prompt for `--yes` confirmation by default
//    because a wipe / large deposit is hard to undo manually.
//  * --json mode is supported on every subcommand so agents can
//    consume the same surface as the human operator.
//  * Decimals: balances are stored as decimal strings keyed by
//    (account, chain, token); the CLI converts to/from BigInt via
//    parseUnits at the boundary. Token decimals come from the same
//    on-chain getToken lookup the trade flow uses.

import type { PublicClient, Transport, Chain } from "viem";
import { createPublicClient } from "viem";
import { ToolError } from "../errors.js";
import {
  listPaperTrades,
  listPaperBalances,
  resetPaperState,
  type PaperBalanceRow,
} from "../db.js";
import { loadConfig, resolveProfile } from "../config.js";
import { resolveToken, makeTransport } from "../chains.js";
import { getToken } from "../tokens.js";
import { setPaperBalance, adjustPaperBalance, summarizePaperPnl } from "../paperTrade.js";
import { computePaperPnlMtm, defaultPaperPriceFetcher, type PaperPnlMtmSummary } from "../paperPnl.js";
import { printJson, prompt, subcommandError, makeCliLogger } from "./helpers.js";

// ── shared helpers ──────────────────────────────────────────

function readOnlyPublicClient(profile: ReturnType<typeof resolveProfile>, extraRpcs: string[] = []): PublicClient<Transport, Chain> {
  // Paper CLI needs token decimals for parseUnits — we open a
  // read-only publicClient (no wallet) so the operator can run
  // these commands without a loaded keystore.
  return createPublicClient({
    chain: profile.viemChain,
    transport: makeTransport(profile, extraRpcs),
  }) as PublicClient<Transport, Chain>;
}

function resolveAccountLabel(flags: Record<string, string>, config: ReturnType<typeof loadConfig>): string {
  return flags["account"] ?? config.activeAccount;
}

function resolveChainName(flags: Record<string, string>, config: ReturnType<typeof loadConfig>): string {
  return flags["chain"] ?? config.activeChain;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

function fmtRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ── trades ──────────────────────────────────────────────────

export async function paperTradesCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const filter: Parameters<typeof listPaperTrades>[0] = {};
  if (flags["account"]) filter.account = flags["account"];
  if (flags["chain"]) filter.chain = flags["chain"];
  if (flags["strategy"]) filter.strategy = flags["strategy"];
  if (flags["source"]) {
    const src = flags["source"];
    if (src !== "order" && src !== "schedule" && src !== "rebalance" && src !== "manual") {
      throw new ToolError("INVALID_PARAMS", `--source must be one of order, schedule, rebalance, manual (got "${src}").`);
    }
    filter.sourceType = src;
  }
  if (flags["since"]) filter.sinceIso = flags["since"];
  if (flags["until"]) filter.untilIso = flags["until"];
  if (flags["limit"]) {
    const n = parseInt(flags["limit"], 10);
    if (Number.isFinite(n) && n > 0) filter.limit = n;
  }
  const rows = listPaperTrades(filter);

  if (flags["json"] === "true") {
    printJson({ ok: true, count: rows.length, trades: rows });
    return;
  }

  if (rows.length === 0) {
    console.log("No paper trades found.");
    console.log("");
    console.log("Hint: deploy a playbook with --paper or create an order/schedule with --paper");
    console.log(`Active scope: chain=${config.activeChain} account=${config.activeAccount}`);
    return;
  }

  console.log(`${rows.length} paper trade(s):`);
  for (const r of rows) {
    const src = r.source_id ? `${r.source_type}#${r.source_id}` : r.source_type;
    const strat = r.strategy ? ` ${r.strategy}` : "";
    console.log(
      `  [${r.id}] ${fmtRelative(r.timestamp)}  ${src}${strat}  ` +
        `${r.direction.toUpperCase()} ${r.base_amount} ${r.base_symbol ?? "?"} ` +
        `↔ ${r.quote_amount} ${r.quote_symbol ?? "?"}  @ ${r.price} (slip ${r.slippage_bps ?? 0}bps)`,
    );
  }
}

// ── balances ────────────────────────────────────────────────

export async function paperBalancesCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const filter: { account?: string; chain?: string } = {};
  if (flags["account"]) filter.account = flags["account"];
  if (flags["chain"]) filter.chain = flags["chain"];
  const rows = listPaperBalances(filter);

  if (flags["json"] === "true") {
    printJson({ ok: true, count: rows.length, balances: rows });
    return;
  }

  if (rows.length === 0) {
    console.log("No virtual balances.");
    console.log("");
    console.log("Seed the virtual book before firing paper trades:");
    console.log("  tradekit paper deposit --token USDC --amount 10000");
    return;
  }

  // Group by (account, chain) for readability.
  const grouped = new Map<string, PaperBalanceRow[]>();
  for (const r of rows) {
    const key = `${r.account} on ${r.chain}`;
    const arr = grouped.get(key) ?? [];
    arr.push(r);
    grouped.set(key, arr);
  }
  for (const [key, group] of grouped) {
    console.log(`\n${key}:`);
    for (const r of group) {
      console.log(`  ${r.balance.padStart(20)} ${r.token}  (updated ${fmtRelative(r.updated_at)})`);
    }
  }
}

// ── deposit ─────────────────────────────────────────────────

export async function paperDepositCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const chain = resolveChainName(flags, config);
  const account = resolveAccountLabel(flags, config);
  const profile = resolveProfile(chain, config);

  const tokenInput = flags["token"];
  if (!tokenInput) {
    throw new ToolError(
      "INVALID_PARAMS",
      "--token is required. Pass an address or a known symbol (USDC, WETH, ETH, …).",
    );
  }
  const tokenAddr = resolveToken(profile, tokenInput);
  if (!tokenAddr) {
    throw new ToolError("UNKNOWN_TOKEN", `Token "${tokenInput}" not recognized on chain "${chain}".`);
  }

  const amount = flags["amount"];
  if (!amount) {
    throw new ToolError("INVALID_PARAMS", "--amount is required (decimal string in the token's native units).");
  }

  const mode = flags["set"] === "true" ? "set" : "credit";
  if (mode === "credit" && amount.startsWith("-")) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Negative amount with default credit mode is a debit; use --set to overwrite to an exact balance, or pass a positive amount.",
    );
  }

  const extraRpcs = config.chains[chain]?.rpcs ?? [];
  const pc = readOnlyPublicClient(profile, extraRpcs);
  const meta = await getToken(pc, profile, tokenAddr);

  if (flags["yes"] !== "true" && flags["json"] !== "true") {
    const verb = mode === "set" ? "OVERWRITE" : "CREDIT";
    const ans = await prompt(`${verb} ${amount} ${meta.symbol} to virtual ${account} on ${chain}? [y/N] `);
    if (!/^y(es)?$/i.test(ans.trim())) {
      console.log("Cancelled.");
      return;
    }
  }

  if (mode === "set") {
    setPaperBalance({ account, chain, token: tokenAddr, decimals: meta.decimals, amount });
  } else {
    adjustPaperBalance({ account, chain, token: tokenAddr, decimals: meta.decimals, delta: amount });
  }
  const after = listPaperBalances({ account, chain }).find(
    (r) => r.token.toLowerCase() === tokenAddr.toLowerCase(),
  );

  if (flags["json"] === "true") {
    printJson({ ok: true, mode, account, chain, token: tokenAddr, symbol: meta.symbol, balance: after?.balance ?? "0" });
    return;
  }
  console.log(`Virtual balance: ${after?.balance ?? "0"} ${meta.symbol} (${account} on ${chain})`);
}

// ── pnl ─────────────────────────────────────────────────────
//
// Default: realized P&L per strategy — a pure, deterministic function
// of the fill journal (scripted consumers can diff it across runs).
//
// --mtm opts into mark-to-market: cost-basis positions are rebuilt
// from the journal (weighted-average model, same as the real-trade
// pnl report) and open positions are marked at the current oracle
// price. One oracle call per distinct held token (memoized), so the
// command stays cheap; the trade-off is non-determinism, which is
// why MTM is a flag and not the default.

export async function paperPnlCommand(flags: Record<string, string>) {
  const config = loadConfig();
  const filter: Parameters<typeof listPaperTrades>[0] = { limit: 5000 };
  if (flags["account"]) filter.account = flags["account"];
  if (flags["chain"]) filter.chain = flags["chain"];
  if (flags["strategy"]) filter.strategy = flags["strategy"];
  const rows = listPaperTrades(filter);

  if (flags["mtm"] === "true") {
    const logger = makeCliLogger(flags);
    const report = await computePaperPnlMtm(rows, defaultPaperPriceFetcher(config, logger));

    if (flags["json"] === "true") {
      printJson({ ok: true, mtm: true, timestamp: report.timestamp, count: report.summaries.length, summaries: report.summaries });
      return;
    }
    if (report.summaries.length === 0) {
      console.log("No paper trades to compute P&L from.");
      return;
    }
    console.log("Paper P&L (mark-to-market, quote-denominated, per strategy):");
    console.log("");
    for (const s of report.summaries) renderMtmSummary(s);
    console.log("Realized uses weighted-average cost basis; deposits are capital, not P&L —");
    console.log("base sold without a tracked buy realizes nothing (see untracked figures above).");
    return;
  }

  // Iter: aggregation lives in the shared summarizePaperPnl() core so
  // the CLI and the MCP `paper_pnl` tool report identical numbers.
  const summaries = summarizePaperPnl(rows);

  if (flags["json"] === "true") {
    printJson({ ok: true, count: summaries.length, summaries });
    return;
  }

  if (summaries.length === 0) {
    console.log("No paper trades to compute P&L from.");
    return;
  }
  console.log("Paper P&L (realized, quote-denominated, per strategy):");
  console.log("");
  for (const s of summaries) {
    const sign = s.netQuote >= 0 ? "+" : "";
    console.log(`  ${s.strategy.padEnd(24)}  fills=${s.fills}  buy=${s.buys}  sell=${s.sells}`);
    console.log(`    spent ${fmtUsd(s.quoteSpent)}  received ${fmtUsd(s.quoteReceived)}  net ${sign}${fmtUsd(s.netQuote)}`);
    if (s.firstFillAt && s.lastFillAt) {
      console.log(`    window: ${fmtRelative(s.firstFillAt)} → ${fmtRelative(s.lastFillAt)}`);
    }
    console.log("");
  }
  console.log("Note: Realized only. Open positions are NOT marked-to-market — re-run with --mtm for total P&L including unrealized.");
}

function fmtSigned(n: number): string {
  return `${n >= 0 ? "+" : ""}${fmtUsd(n)}`;
}

function renderMtmSummary(s: PaperPnlMtmSummary): void {
  console.log(`  ${s.strategy.padEnd(24)}  fills=${s.fills}  buy=${s.buys}  sell=${s.sells}`);
  const unreal = s.unrealizedQuote == null ? "— (unpriced)" : fmtSigned(s.unrealizedQuote);
  console.log(`    realized ${fmtSigned(s.realizedQuote)}  unrealized ${unreal}  total ${fmtSigned(s.totalQuote)}  open value ${fmtUsd(s.openValueQuote)}`);
  for (const p of s.positions) {
    if (p.amount <= 0 && p.realizedQuote === 0 && p.untrackedSellBase === 0) continue;
    const sym = p.symbol ?? p.token.slice(0, 10);
    if (p.amount > 0) {
      const mark = p.currentPriceQuote == null
        ? "price unavailable"
        : `@ ${fmtUsd(p.currentPriceQuote)} (avg cost ${fmtUsd(p.avgCostQuote)}) unrealized ${p.unrealizedQuote == null ? "—" : fmtSigned(p.unrealizedQuote)}`;
      console.log(`      ${sym.padEnd(10)} ${p.amount.toFixed(6)} held ${mark}`);
    } else {
      console.log(`      ${sym.padEnd(10)} flat  realized ${fmtSigned(p.realizedQuote)}`);
    }
    if (p.untrackedSellBase > 0) {
      console.log(`        ⚠ ${p.untrackedSellBase.toFixed(6)} ${sym} sold without tracked cost basis (deposit-seeded) — ${fmtUsd(p.untrackedSellQuote)} proceeds excluded from realized`);
    }
  }
  if (s.unpricedPositionCount > 0) {
    console.log(`    ⚠ ${s.unpricedPositionCount} open position(s) unpriced — unrealized/total are partial`);
  }
  if (s.skippedNonStableQuote > 0) {
    console.log(`    ⚠ ${s.skippedNonStableQuote} fill(s) with non-stablecoin quote excluded from cost basis`);
  }
  console.log("");
}

// ── reset ───────────────────────────────────────────────────

export async function paperResetCommand(flags: Record<string, string>) {
  const filter: { account?: string; chain?: string } = {};
  if (flags["account"]) filter.account = flags["account"];
  if (flags["chain"]) filter.chain = flags["chain"];

  // Default: scope-less wipe is destructive; require --yes unless json.
  const scopeDesc =
    filter.account || filter.chain
      ? `account=${filter.account ?? "*"} chain=${filter.chain ?? "*"}`
      : "ALL paper state (every account, every chain)";

  if (flags["yes"] !== "true" && flags["json"] !== "true") {
    const ans = await prompt(`This will WIPE ${scopeDesc}. Continue? [y/N] `);
    if (!/^y(es)?$/i.test(ans.trim())) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = resetPaperState(filter);
  if (flags["json"] === "true") {
    printJson({ ok: true, scope: filter, ...result });
    return;
  }
  console.log(`Removed ${result.balancesRemoved} balance row(s), ${result.tradesRemoved} trade row(s).`);
}

// ── dispatch ────────────────────────────────────────────────

export async function paperCommand(
  action: string | undefined,
  flags: Record<string, string>,
  _positional: string[],
) {
  switch (action) {
    case "trades":
      await paperTradesCommand(flags);
      break;
    case "balances":
      await paperBalancesCommand(flags);
      break;
    case "deposit":
      await paperDepositCommand(flags);
      break;
    case "pnl":
      await paperPnlCommand(flags);
      break;
    case "reset":
      await paperResetCommand(flags);
      break;
    default:
      throw subcommandError("paper", action, ["trades", "balances", "deposit", "pnl", "reset"]);
  }
}
