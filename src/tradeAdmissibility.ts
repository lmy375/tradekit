/**
 * Pre-trade limit projection (v54) — "will this specific trade actually
 * be ADMITTED, or will it bounce off a limit at execution?"
 *
 * The gap this closes: `trade preview` / `preview_trade` only runs the
 * CHEAP safety subset (enforcePreflightSafety = slippage cap + token
 * allow/deny lists; iter405). The STATE-DEPENDENT execution guardrails —
 * per-tx / daily USD limits, contract whitelist, per-strategy budgets,
 * net-exposure position caps, the trade rate limit, the gas budget —
 * only fire at execution time. So an agent can read `safety.passes =
 * true`, call buy, and get a SAFEGUARD_TRIGGERED / STRATEGY_BUDGET_
 * EXCEEDED / POSITION_CAP_EXCEEDED rejection it had no way to foresee.
 *
 * This projects the FULL execution-time gauntlet for a prospective
 * trade. The load-bearing design choice: it runs the REAL throwing
 * enforcers (enforceSafety / enforceRateLimit / enforceStrategyBudget /
 * enforcePositionCap / enforceGasBudget) in try/catch rather than
 * re-deriving thresholds — so the projection can NEVER diverge from
 * what execution actually does. A preview that lies is worse than no
 * preview; reusing the enforcement code makes lying impossible.
 *
 * Deterministic + offline (config + the trades/drawdown tables, no RPC).
 * Injection seam for the last-trade lookup keeps tests pure.
 */

import type { Address } from "viem";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { ToolError } from "./errors.js";
import {
  enforceSafety,
  enforceRateLimit,
  enforceGasBudget,
  type GasBudgetInput,
} from "./safety.js";
import { enforceStrategyBudget } from "./strategyBudget.js";
import { enforceStrategyLossBreaker } from "./strategyCompare.js";
import { enforcePositionCap } from "./positionCaps.js";
import { lastTradeAtByAccount } from "./db.js";

export type LimitCheckName =
  | "core_safety"
  | "rate_limit"
  | "strategy_budget"
  | "strategy_loss"
  | "position_cap"
  | "gas_budget";

export interface LimitCheck {
  name: LimitCheckName;
  label: string;
  /** True when this guardrail would admit the trade (or is not configured). */
  passes: boolean;
  /** Structured ToolError code when it would reject. */
  code?: string;
  /** The exact rejection message the agent would see at execution. */
  message?: string;
}

export interface TradeLimitProjection {
  /** True when the trade would pass EVERY state-dependent execution
   *  guardrail — i.e. `buy`/`sell` would not bounce off a limit. The
   *  cheap slippage+token checks live in the preview's `safety` field;
   *  this is the complete-picture admissibility. */
  admissible: boolean;
  /** Every guardrail evaluated (only configured ones appear). */
  checks: LimitCheck[];
  /** Subset that would reject the trade, in evaluation order. */
  blocking: LimitCheck[];
}

/** Run one throwing enforcer; a ToolError becomes a non-passing check
 *  (its code + message preserved), anything else re-throws. */
function runCheck(name: LimitCheckName, label: string, fn: () => void): LimitCheck {
  try {
    fn();
    return { name, label, passes: true };
  } catch (e) {
    if (e instanceof ToolError) {
      return { name, label, passes: false, code: e.code, message: e.message };
    }
    throw e;
  }
}

export function projectTradeLimits(args: {
  config: Config;
  logger: Logger;
  chain: string;
  account: string;
  tokenIn: Address;
  tokenOut: Address;
  toContract: Address;
  estimatedUsd: number | null;
  slippageBps: number;
  direction: "buy" | "sell";
  /** Strategy tag — enables per-strategy budget + position-cap projection.
   *  Untagged trades skip those (no rules match an untagged trade). */
  strategy?: string | null;
  baseToken?: Address;
  baseSymbol?: string | null;
  /** Base units this buy would acquire (post-quote) — for position caps. */
  addBaseAmount?: number | null;
  /** Quote (≈ USD) this buy would spend — for position caps. */
  addCostQuote?: number | null;
  paper?: boolean;
  /** Gas metrics for the gas-budget check. Omit to skip it. */
  gas?: GasBudgetInput | null;
  /** Test seam: last-trade timestamp per account (for the rate limit). */
  lastTradeAtFn?: () => Map<string, string>;
  /** Test seam: "now" for the rate-limit elapsed computation. */
  now?: Date;
}): TradeLimitProjection {
  const { config, logger } = args;
  const s = config.safety;
  const checks: LimitCheck[] = [];

  // ── core safety: contract whitelist + per-tx + daily USD (also
  //    re-runs slippage + token lists — harmless, keeps it the canonical
  //    "would the full pre-trade check pass" boolean). ──
  checks.push(
    runCheck("core_safety", "USD limits + token/contract guards", () =>
      enforceSafety(
        {
          chain: args.chain,
          account: args.account,
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          toContract: args.toContract,
          estimatedUsd: args.estimatedUsd ?? undefined,
          slippageBps: args.slippageBps,
        },
        config,
        logger,
      ),
    ),
  );

  // ── trade rate limit ──
  if (s.minTradeIntervalMs != null && s.minTradeIntervalMs > 0) {
    const lastMap = (args.lastTradeAtFn ?? lastTradeAtByAccount)();
    checks.push(
      runCheck("rate_limit", "Trade rate limit", () =>
        enforceRateLimit(
          {
            account: args.account,
            chain: args.chain,
            lastTradeTimestamp: lastMap.get(args.account) ?? null,
            ...(args.now ? { nowMs: args.now.getTime() } : {}),
          },
          config,
          logger,
        ),
      ),
    );
  }

  // ── per-strategy budget (lifetime / 24h / per-fire) ──
  if (args.strategy && s.strategyBudgets && s.strategyBudgets.length > 0) {
    checks.push(
      runCheck("strategy_budget", "Per-strategy budget", () =>
        enforceStrategyBudget({
          strategyTag: args.strategy,
          predictedUsd: args.estimatedUsd ?? 0,
          budgets: s.strategyBudgets,
        }),
      ),
    );
  }

  // ── per-strategy realized-loss breaker (v84, buys only) ──
  if (args.strategy && args.direction === "buy" && s.maxStrategyLossUsd != null) {
    checks.push(
      runCheck("strategy_loss", "Strategy loss breaker", () =>
        enforceStrategyLossBreaker({
          strategyTag: args.strategy,
          maxLossUsd: s.maxStrategyLossUsd,
          account: args.account,
        }),
      ),
    );
  }

  // ── net-exposure position cap (buys only) ──
  if (
    args.strategy &&
    args.direction === "buy" &&
    args.baseToken &&
    s.positionCaps &&
    s.positionCaps.length > 0 &&
    args.addBaseAmount != null &&
    args.addCostQuote != null
  ) {
    checks.push(
      runCheck("position_cap", "Net-exposure cap", () =>
        enforcePositionCap({
          strategyTag: args.strategy,
          direction: "buy",
          baseToken: args.baseToken!,
          baseSymbol: args.baseSymbol ?? null,
          addBaseAmount: args.addBaseAmount!,
          addCostQuote: args.addCostQuote!,
          caps: s.positionCaps,
          paper: args.paper ?? false,
        }),
      ),
    );
  }

  // ── gas budget ──
  if (args.gas && s.gas) {
    checks.push(runCheck("gas_budget", "Gas budget", () => enforceGasBudget(args.gas!, config, logger)));
  }

  const blocking = checks.filter((c) => !c.passes);
  return { admissible: blocking.length === 0, checks, blocking };
}
