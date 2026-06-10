/**
 * Per-strategy position caps (v38) — the third risk axis.
 *
 * The safety stack had two axes:
 *   - portfolio drawdown breaker (total value falls X% from peak)
 *   - strategy budgets (cumulative SPEND, lifetime/daily)
 * Neither expresses the most intuitive risk statement: "strategy X
 * may not HOLD more than N units (or $N cost basis) of token Y."
 * Budgets count gross spend — sells never free room, so a
 * buy-sell-buy churn strategy exhausts its budget while holding
 * nothing. Position caps count NET exposure: buys add, sells
 * subtract (weighted-average cost reduction, the same model every
 * P&L surface uses), so room is freed when the position is reduced.
 *
 * Enforcement points: executeTrade (real) and executePaperTrade,
 * post-quote (the buy's base acquisition is known) and pre-send.
 * SELLS ARE NEVER BLOCKED — they reduce exposure; blocking an exit
 * because a cap is "exceeded" would be actively dangerous.
 *
 * Scope: per (strategy tag, token), ACROSS chains — net exposure to
 * an asset is what the operator caps, not per-chain bookkeeping.
 * Token matches by symbol (case-insensitive) or address.
 *
 * Soft-skip posture: trades without a strategy tag are not capped
 * (manual trades answer to the operator-wide USD limits); missing
 * fill history reads as zero position.
 */

import { ToolError } from "./errors.js";
import { recentTrades, listPaperTrades } from "./db.js";

export interface PositionCapRule {
  /** Tag pattern: exact ("dca-eth") or prefix wildcard ("playbook:*"). */
  pattern: string;
  /** Token to cap — symbol (case-insensitive) or 0x address. */
  token: string;
  /** Max NET base units the strategy may hold after the buy. */
  maxBaseAmount?: number;
  /** Max NET tracked cost basis (quote units ≈ USD for stable quotes). */
  maxCostQuote?: number;
  note?: string;
}

/** Same matching convention as strategyBudgets / alert appliesTo. */
export function capMatchesTag(rule: PositionCapRule, tag: string | null | undefined): boolean {
  if (!tag) return false;
  if (rule.pattern.endsWith("*")) return tag.startsWith(rule.pattern.slice(0, -1));
  return rule.pattern === tag;
}

function tokenMatches(rule: PositionCapRule, baseToken: string, baseSymbol: string | null): boolean {
  const t = rule.token.toLowerCase();
  if (t.startsWith("0x")) return baseToken.toLowerCase() === t;
  return (baseSymbol ?? "").toLowerCase() === t || baseToken.toLowerCase() === t;
}

export interface FillRowLite {
  timestamp: string;
  direction: string;
  base_token: string;
  base_symbol: string | null;
  base_amount: string;
  quote_amount: string;
}

/** Net position for (rows already scoped to one strategy) × token.
 *  Weighted-average cost model — identical semantics to the MTM
 *  walker so cap math can never disagree with the P&L surfaces. */
export function netPosition(
  rows: readonly FillRowLite[],
  rule: Pick<PositionCapRule, "token">,
): { baseAmount: number; costQuote: number } {
  const sorted = [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let amount = 0;
  let cost = 0;
  for (const r of sorted) {
    if (!tokenMatches(rule as PositionCapRule, r.base_token, r.base_symbol)) continue;
    const base = parseFloat(r.base_amount);
    const quote = parseFloat(r.quote_amount);
    if (!Number.isFinite(base) || !Number.isFinite(quote) || base <= 0) continue;
    if (r.direction === "buy") {
      amount += base;
      cost += quote;
    } else {
      const avg = amount > 0 ? cost / amount : 0;
      const sold = Math.min(base, Math.max(0, amount));
      amount -= sold;
      cost = Math.max(0, cost - avg * sold);
    }
  }
  return { baseAmount: amount, costQuote: cost };
}

/** Production rows loader: success real trades OR paper fills for one tag. */
export function defaultFillRows(tag: string, paper: boolean): FillRowLite[] {
  if (paper) {
    return listPaperTrades({}).filter((r) => r.strategy === tag) as unknown as FillRowLite[];
  }
  return recentTrades({ strategy: tag, limit: 100_000 }).filter((t) => t.status === "success") as unknown as FillRowLite[];
}

/**
 * Throws POSITION_CAP_EXCEEDED when a BUY would push the strategy's
 * net holding of the token past a configured cap. No-op for sells,
 * untagged trades, or unconfigured installs.
 */
export function enforcePositionCap(args: {
  strategyTag: string | null | undefined;
  direction: "buy" | "sell";
  baseToken: string;
  baseSymbol: string | null;
  /** Estimated base acquired by THIS buy (post-quote). */
  addBaseAmount: number;
  /** Quote spent by THIS buy. */
  addCostQuote: number;
  caps: PositionCapRule[] | undefined;
  paper: boolean;
  /** Injection seam — defaults to the real fill loader. */
  rowsLookup?: (tag: string, paper: boolean) => FillRowLite[];
}): void {
  if (args.direction !== "buy") return; // sells reduce exposure — never blocked
  if (!args.caps || args.caps.length === 0) return;
  const tag = args.strategyTag;
  if (!tag) return;

  const applicable = args.caps.filter(
    (c) => capMatchesTag(c, tag) && tokenMatches(c, args.baseToken, args.baseSymbol),
  );
  if (applicable.length === 0) return;

  const rows = (args.rowsLookup ?? defaultFillRows)(tag, args.paper);
  // Position computed once per enforcement (netPosition filters by
  // token internally); every applicable cap checks the same numbers.
  const current = netPosition(rows, { token: args.baseToken });

  for (const cap of applicable) {
    if (cap.maxBaseAmount != null && current.baseAmount + args.addBaseAmount > cap.maxBaseAmount) {
      throw new ToolError(
        "POSITION_CAP_EXCEEDED",
        `Position cap: strategy "${tag}" holds ${current.baseAmount} ${args.baseSymbol ?? args.baseToken} ` +
          `(net); this buy adds ${args.addBaseAmount} → ${current.baseAmount + args.addBaseAmount}, ` +
          `over the ${cap.maxBaseAmount} cap (pattern "${cap.pattern}"${cap.note ? `: ${cap.note}` : ""}). ` +
          `Sells free room — the cap counts NET exposure, not spend.`,
        {
          details: {
            tag,
            token: args.baseToken,
            symbol: args.baseSymbol,
            currentBaseAmount: current.baseAmount,
            addBaseAmount: args.addBaseAmount,
            maxBaseAmount: cap.maxBaseAmount,
            pattern: cap.pattern,
          },
        },
      );
    }
    if (cap.maxCostQuote != null && current.costQuote + args.addCostQuote > cap.maxCostQuote) {
      throw new ToolError(
        "POSITION_CAP_EXCEEDED",
        `Position cap: strategy "${tag}" carries ${current.costQuote.toFixed(2)} tracked cost basis in ` +
          `${args.baseSymbol ?? args.baseToken}; this buy adds ${args.addCostQuote.toFixed(2)} → ` +
          `${(current.costQuote + args.addCostQuote).toFixed(2)}, over the ${cap.maxCostQuote} cap ` +
          `(pattern "${cap.pattern}"${cap.note ? `: ${cap.note}` : ""}).`,
        {
          details: {
            tag,
            token: args.baseToken,
            symbol: args.baseSymbol,
            currentCostQuote: current.costQuote,
            addCostQuote: args.addCostQuote,
            maxCostQuote: cap.maxCostQuote,
            pattern: cap.pattern,
          },
        },
      );
    }
  }
}
