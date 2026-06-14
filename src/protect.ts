/**
 * Protect action (v79) — turn the v76 unprotected-position AUDIT into a
 * one-call FIX: create trailing-stop sell orders that cover the exposed amount.
 *
 * Iterations v72–v78 made the product tell you about risk comprehensively — but
 * it was all read-only. An autonomous agent that detects $64k of WBTC with no
 * downside exit (v76) then had to hand-compose an order_create with the right
 * side / token / amount / trail. This closes the loop: `protect` audits the
 * book, and for each unprotected (or partially-protected) position creates a
 * trailing stop sized to exactly the UNCOVERED amount, skipping what's already
 * protected. The first action-oriented capability after a long detection streak
 * — detection without an easy fix is half the value for an autonomous agent.
 *
 * Orders are created through the SAME validated createOrderRow path order_create
 * uses (whitelist / amount / slippage checks + audit), so this adds no new
 * trust surface. Idempotent across runs: a position protected by a prior run is
 * skipped. Supports simulate (plan only).
 */

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { OrderRow } from "./db.js";
import type { PositionProtectionReport } from "./positionProtection.js";

/** Default trailing-stop retracement when the caller doesn't specify one. A
 *  protective stop wants room to ride normal volatility without whipsawing —
 *  15% is a sane crash-protection default, not a tight trade stop. */
export const DEFAULT_PROTECT_TRAIL_PCT = 15;

export interface ProtectionTarget {
  chain: string;
  token: string;
  symbol: string | null;
  /** Base units to cover — exactly the position's UNPROTECTED remainder. */
  amount: number;
  /** Prior status (unprotected | partial) — partial means a stop already
   *  covers part of it and we're topping up the remainder. */
  priorStatus: string;
}

/**
 * Pure: from a protection audit, pick the positions that need a protective
 * order + the amount to cover. Skips fully-protected positions; covers only the
 * unprotected remainder of partials (no double-counting existing stops).
 */
export function selectPositionsToProtect(
  report: PositionProtectionReport,
  opts: { token?: string } = {},
): ProtectionTarget[] {
  const want = opts.token?.toLowerCase();
  return report.positions
    .filter((p) => p.status !== "protected")
    .filter((p) => p.unprotectedAmount > 0)
    .filter(
      (p) =>
        want == null ||
        p.token.toLowerCase() === want ||
        (p.symbol != null && p.symbol.toLowerCase() === want),
    )
    .map((p) => ({
      chain: p.chain,
      token: p.token,
      symbol: p.symbol,
      amount: p.unprotectedAmount,
      priorStatus: p.status,
    }));
}

export interface ProtectResult {
  trailPct: number;
  simulate: boolean;
  /** Orders created (or, when simulate, the specs that WOULD be created). */
  created: Array<{
    chain: string;
    symbol: string | null;
    amount: number;
    trailPct: number;
    orderId?: number;
  }>;
  /** Positions left as-is because a stop already fully covers them. */
  alreadyProtected: Array<{ chain: string; symbol: string | null }>;
  /** Targets that errored at creation (e.g. token blacklisted) — never aborts the batch. */
  failed: Array<{ chain: string; symbol: string | null; error: string }>;
  summary: string;
  generatedAt: string;
}

/**
 * Audit the book + create a trailing stop for every unprotected position.
 * `simulate` returns the plan without creating. Per-target failures are
 * captured (the batch never half-aborts).
 */
export async function protectPositions(args: {
  config: Config;
  logger: Logger;
  account?: string;
  chain?: string;
  token?: string;
  mode?: "real" | "paper";
  trailPct?: number;
  simulate?: boolean;
  now?: Date;
}): Promise<ProtectResult> {
  const trailPct = args.trailPct ?? DEFAULT_PROTECT_TRAIL_PCT;
  const simulate = args.simulate ?? false;
  const mode = args.mode ?? "real";
  const account = args.account ?? args.config.activeAccount ?? "default";

  const { gatherPositionProtection } = await import("./positionProtection.js");
  const report = await gatherPositionProtection({ mode, account, chain: args.chain, config: args.config, now: args.now });
  const targets = selectPositionsToProtect(report, { token: args.token });

  const { resolveProfile } = await import("./config.js");
  const { NATIVE_TOKEN } = await import("./tokens.js");
  const { createOrderRow } = await import("./orders.js");

  const created: ProtectResult["created"] = [];
  const failed: ProtectResult["failed"] = [];

  for (const t of targets) {
    try {
      const profile = resolveProfile(t.chain, args.config);
      const isNative = t.token.toLowerCase() === NATIVE_TOKEN.toLowerCase();
      const base = isNative ? ("ETH" as const) : (t.token as `0x${string}`);
      const quote = profile.usdc as `0x${string}`;
      if (simulate) {
        created.push({ chain: t.chain, symbol: t.symbol, amount: t.amount, trailPct });
        continue;
      }
      const row = createOrderRow(
        {
          side: "sell",
          trigger: "trailing",
          trailPct,
          chain: t.chain,
          account,
          base,
          quote,
          baseAmount: String(t.amount),
          // Crash protection is long-lived — no expiry. Paper book gets a
          // paper order so a dry-run book is protected symmetrically.
          paper: mode === "paper",
          note: `auto-protect (v79): ${trailPct}% trailing stop on the unprotected ${t.symbol ?? "position"}`,
        },
        args.config,
      );
      created.push({ chain: t.chain, symbol: t.symbol, amount: t.amount, trailPct, orderId: row.id });
    } catch (e) {
      failed.push({ chain: t.chain, symbol: t.symbol, error: (e as Error).message });
    }
  }

  const alreadyProtected = report.positions
    .filter((p) => p.status === "protected")
    .map((p) => ({ chain: p.chain, symbol: p.symbol }));

  const verb = simulate ? "Would create" : "Created";
  const summary =
    targets.length === 0
      ? report.positions.length === 0
        ? "No open positions to protect."
        : `All ${report.positions.length} position(s) already protected — nothing to do.`
      : `${verb} ${created.length} trailing-stop(s) at ${trailPct}%` +
        (failed.length > 0 ? ` · ${failed.length} failed` : "") +
        (alreadyProtected.length > 0 ? ` · ${alreadyProtected.length} already protected` : "") +
        ".";

  return {
    trailPct,
    simulate,
    created,
    alreadyProtected,
    failed,
    summary,
    generatedAt: (args.now ?? new Date()).toISOString(),
  };
}

export interface EntryStopResult {
  created: boolean;
  orderId?: number;
  trailPct?: number;
  amount?: number;
  symbol?: string | null;
  /** v117: when a take-profit target is requested, the stop + a price_above
   *  sell are created as an OCO BRACKET (one fills → engine cancels the other).
   *  These name the take-profit leg + the shared group. */
  takeProfitOrderId?: number;
  takeProfitPriceUsd?: number;
  groupId?: string;
  /** Take-profit leg couldn't be created (e.g. no entry USD price) — the stop
   *  still protects. */
  takeProfitSkipped?: string;
  /** Why no stop was created (not a buy / not filled / no amount). */
  skipped?: string;
  /** Order creation threw (e.g. token blacklisted) — the TRADE still happened. */
  error?: string;
}

/**
 * v79: source-level protection — create a trailing stop for a just-filled BUY,
 * so the position is guarded the moment it exists (vs. protectPositions, which
 * fixes already-unprotected holdings after the fact). Called by buy/sell at the
 * caller level AFTER executeTrade returns success — it never touches the
 * execution path. Best-effort: a stop-creation failure leaves the (successful)
 * trade intact and is reported, never thrown.
 */
export async function createEntryStop(args: {
  result: {
    direction: "buy" | "sell";
    status?: "success" | "failed";
    baseToken: string;
    baseSymbol?: string;
    quoteToken: string;
    baseAmount: string;
  };
  trailPct: number;
  config: Config;
  account: string;
  chain: string;
  paper?: boolean;
  /** v117: when set (> 0), ALSO create a take-profit (price_above sell) at
   *  entryPriceUsd × (1 + takeProfitPct/100), OCO-grouped with the stop → a
   *  complete bracket. Needs entryPriceUsd to place the target. */
  takeProfitPct?: number;
  /** USD price per base at entry (estimatedUsd ÷ baseAmount) — robust across
   *  quote tokens. Required to compute the take-profit target. */
  entryPriceUsd?: number | null;
  /** Tx hash of the entry, for a stable OCO group id. */
  txHash?: string;
}): Promise<EntryStopResult> {
  const symbol = args.result.baseSymbol ?? null;
  if (args.result.direction !== "buy") {
    return { created: false, symbol, skipped: "only buys are auto-protected (a sell reduces exposure)" };
  }
  if (args.result.status !== "success") {
    return { created: false, symbol, skipped: "trade did not fill" };
  }
  const amount = parseFloat(args.result.baseAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { created: false, symbol, skipped: "no base amount received to protect" };
  }
  try {
    const { resolveProfile } = await import("./config.js");
    const { NATIVE_TOKEN } = await import("./tokens.js");
    const { createOrderRow } = await import("./orders.js");
    const isNative = args.result.baseToken.toLowerCase() === NATIVE_TOKEN.toLowerCase();
    const base = isNative ? ("ETH" as const) : (args.result.baseToken as `0x${string}`);
    const profile = resolveProfile(args.chain, args.config);
    // Sell back to the quote the buy used (fallback to the chain's USDC).
    const quote = (args.result.quoteToken ?? profile.usdc) as `0x${string}`;
    // v117: when a take-profit is requested AND we can place it, the stop + TP
    // share an OCO group so the engine cancels the survivor when one fills.
    const wantBracket = args.takeProfitPct != null && args.takeProfitPct > 0;
    const tpTargetUsd =
      wantBracket && args.entryPriceUsd != null && args.entryPriceUsd > 0
        ? args.entryPriceUsd * (1 + args.takeProfitPct! / 100)
        : null;
    const group = tpTargetUsd != null ? `bracket-${(args.txHash ?? "").replace(/^0x/, "").slice(0, 16) || "entry"}` : undefined;
    const row = createOrderRow(
      {
        side: "sell",
        trigger: "trailing",
        trailPct: args.trailPct,
        chain: args.chain,
        account: args.account,
        base,
        quote,
        baseAmount: String(amount),
        paper: args.paper ?? false,
        group,
        note: `auto-protect on entry (v79): ${args.trailPct}% trailing stop on the ${symbol ?? "position"} just bought`,
      },
      args.config,
    );
    const out: EntryStopResult = { created: true, orderId: row.id, trailPct: args.trailPct, amount, symbol };
    if (wantBracket) {
      if (tpTargetUsd == null) {
        out.takeProfitSkipped = "no entry USD price — can't place the take-profit target (stop still active)";
      } else {
        out.groupId = group;
        try {
          const tp = createOrderRow(
            {
              side: "sell",
              trigger: "price_above",
              targetPriceUsd: tpTargetUsd,
              chain: args.chain,
              account: args.account,
              base,
              quote,
              baseAmount: String(amount),
              paper: args.paper ?? false,
              group,
              note: `auto take-profit on entry (v117): sell at $${tpTargetUsd.toFixed(6)} (+${args.takeProfitPct}% from entry), OCO with stop #${row.id}`,
            },
            args.config,
          );
          out.takeProfitOrderId = tp.id;
          out.takeProfitPriceUsd = tpTargetUsd;
        } catch (e) {
          // The stop is already in place; report the TP failure without throwing.
          out.takeProfitSkipped = (e as Error).message;
        }
      }
    }
    return out;
  } catch (e) {
    return { created: false, symbol, error: (e as Error).message };
  }
}

export function renderProtectResult(r: ProtectResult): string {
  const lines: string[] = [];
  lines.push(`Protect positions — ${r.summary}`);
  if (r.created.length > 0) {
    lines.push("");
    lines.push(`  ${r.simulate ? "Planned" : "Created"} trailing stops:`);
    for (const c of r.created) {
      lines.push(`   ${r.simulate ? "•" : "✓"} ${(c.symbol ?? "?")}  ${c.amount.toPrecision(4)} @ ${c.trailPct}% trailing${c.orderId != null ? `  (order #${c.orderId})` : ""}`);
    }
  }
  if (r.failed.length > 0) {
    lines.push("");
    for (const f of r.failed) lines.push(`   ✗ ${f.symbol ?? "?"} (${f.chain}): ${f.error}`);
  }
  return lines.join("\n");
}
