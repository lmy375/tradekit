/**
 * Portfolio drawdown circuit breaker.
 *
 * The first STATE-AWARE safety primitive. Every other guardrail in
 * src/safety.ts evaluates trades against forward-looking rules:
 *   - slippage cap: "is this trade's slippage tolerable?"
 *   - USD limits: "does this trade exceed per-tx / daily caps?"
 *   - gas budget: "is the gas cost reasonable?"
 *   - position limits: "would this trade push composition out of band?"
 *   - honeypot probe: "is this token safe?"
 *   - strategy budget: "have I spent too much under this tag?"
 *
 * None of these react to actual realized capital losses. A trailing-
 * stop that fires too late, a DCA buying into a downtrend, a rebalance
 * churning in volatile markets — all stay "in spec" while bleeding
 * money. This breaker fills that gap: it tracks the portfolio's peak
 * USD value over time and refuses new trades when current value falls
 * below `peak × (1 - maxDrawdownPct/100)`.
 *
 * Persistence: see db.ts v19 migration. State is a single row keyed
 * on scope ("global" in v1). Peak ratchets up monotonically as trades
 * observe new highs. Once tripped, stays tripped until the operator
 * manually resets via `tradekit safety reset-drawdown` OR (when
 * configured) current value auto-recovers past
 * `peak × (1 - autoResumeAtPct/100)`.
 *
 * Injection seam: `portfolioFetch` lets tests stub the live USD value
 * without standing up holdings + RPC infrastructure. Production callers
 * pass the value already in hand from the position-limits portfolio
 * fetch (no double-fetch).
 */

import { ToolError } from "./errors.js";
import {
  getDrawdownState,
  upsertDrawdownState,
  setDrawdownTripped,
  type DrawdownStateRow,
} from "./db.js";
import type { Config } from "./config.js";

// ── types ────────────────────────────────────────────────────

export interface DrawdownConfig {
  enabled: boolean;
  maxDrawdownPct: number;
  autoResumeAtPct: number | null;
  scope: "global";
}

/** Pure-function outcome of evaluating a single (currentUsd, state,
 *  config) tuple. The DB-backed enforcer maps these outcomes to row
 *  writes + thrown errors. Split out as a pure shape so the test suite
 *  can verify every branch without DB setup. */
export type DrawdownOutcome =
  | { kind: "no-state"; nextPeak: number; nextPeakAt: string }
  | { kind: "ratchet-up"; nextPeak: number; nextPeakAt: string }
  | { kind: "auto-resume"; peak: number; currentUsd: number; drawdownPct: number }
  | { kind: "still-tripped"; peak: number; trippedAt: string; currentUsd: number; drawdownPct: number }
  | { kind: "trip-now"; peak: number; trippedAt: string; currentUsd: number; drawdownPct: number; thresholdPct: number }
  | { kind: "within-band"; peak: number; currentUsd: number; drawdownPct: number };

// ── pure evaluator ───────────────────────────────────────────

/**
 * Pure decision function. Given current portfolio USD, prior state, and
 * config — what should happen?
 *
 *   no-state    → first observation; persist current as peak, allow.
 *   ratchet-up  → new high; persist new peak, allow.
 *   auto-resume → was tripped, current recovered past resume threshold,
 *                 clear tripped, allow.
 *   still-tripped → was tripped, hasn't recovered, BLOCK.
 *   trip-now    → current crossed threshold for the first time, BLOCK
 *                 and persist tripped_at.
 *   within-band → current is in the drawdown band but above threshold;
 *                 allow + update last_value_usd.
 */
export function evaluateDrawdown(args: {
  currentUsd: number;
  state: DrawdownStateRow | null;
  config: DrawdownConfig;
  now?: Date;
}): DrawdownOutcome {
  const { currentUsd, state, config } = args;
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();

  if (!Number.isFinite(currentUsd) || currentUsd <= 0) {
    // Treat unpriced / zero portfolios as no-op — we can't compute
    // drawdown without a valid current value. The caller logs the
    // warning; we don't trip on missing data (avoids a price-oracle
    // outage cascading into a tradekit-wide stop).
    return state
      ? { kind: "within-band", peak: state.peak_usd, currentUsd, drawdownPct: 0 }
      : { kind: "no-state", nextPeak: 0, nextPeakAt: nowIso };
  }

  if (!state) {
    return { kind: "no-state", nextPeak: currentUsd, nextPeakAt: nowIso };
  }

  // New high → ratchet up. This implicitly clears any tripped state:
  // if the portfolio recovered past its previous peak, the breaker
  // has by definition fully recovered. The auto-resume path below
  // handles partial recoveries (between threshold and previous peak).
  if (currentUsd > state.peak_usd) {
    return { kind: "ratchet-up", nextPeak: currentUsd, nextPeakAt: nowIso };
  }

  const peak = state.peak_usd;
  const drawdownPct = peak > 0 ? ((peak - currentUsd) / peak) * 100 : 0;
  const thresholdPct = config.maxDrawdownPct;

  if (state.tripped_at) {
    // Auto-resume path: drawdown has shrunk past the configured
    // recovery threshold (which must be < trip threshold).
    if (config.autoResumeAtPct != null && drawdownPct < config.autoResumeAtPct) {
      return { kind: "auto-resume", peak, currentUsd, drawdownPct };
    }
    return {
      kind: "still-tripped",
      peak,
      trippedAt: state.tripped_at,
      currentUsd,
      drawdownPct,
    };
  }

  if (drawdownPct >= thresholdPct) {
    return {
      kind: "trip-now",
      peak,
      trippedAt: nowIso,
      currentUsd,
      drawdownPct,
      thresholdPct,
    };
  }

  return { kind: "within-band", peak, currentUsd, drawdownPct };
}

// ── DB-backed enforcer ───────────────────────────────────────

export interface EnforceDrawdownArgs {
  /** Current portfolio USD value, passed in from the caller. The trade
   *  pipeline already fetches this for position limits; reusing it
   *  avoids a second RPC round. */
  currentUsd: number;
  config: Config;
  scope?: string;
}

/**
 * Throwing wrapper. Returns silently on allow, throws
 * DRAWDOWN_CIRCUIT_BREAKER_TRIPPED on block. Side-effects:
 *   - persists new peak on ratchet-up + no-state
 *   - persists tripped_at on trip-now
 *   - clears tripped_at on auto-resume
 *   - updates last_value_usd on every observation
 *
 * Skipped entirely when:
 *   - `drawdownCircuitBreaker` is undefined or enabled=false
 *   - currentUsd is null / 0 / NaN (unpriced portfolio)
 */
export function enforceDrawdownCircuitBreaker(args: EnforceDrawdownArgs): void {
  const cfg = args.config.safety.drawdownCircuitBreaker;
  if (!cfg || !cfg.enabled) return;
  if (!Number.isFinite(args.currentUsd) || args.currentUsd <= 0) return;

  const scopeKey = args.scope ?? cfg.scope;
  const state = getDrawdownState(scopeKey);
  const outcome = evaluateDrawdown({
    currentUsd: args.currentUsd,
    state,
    config: cfg,
  });

  switch (outcome.kind) {
    case "no-state":
      upsertDrawdownState({
        scopeKey,
        peakUsd: outcome.nextPeak,
        peakAt: outcome.nextPeakAt,
        trippedAt: null,
        lastValueUsd: args.currentUsd,
      });
      return;
    case "ratchet-up":
      upsertDrawdownState({
        scopeKey,
        peakUsd: outcome.nextPeak,
        peakAt: outcome.nextPeakAt,
        trippedAt: null,
        lastValueUsd: args.currentUsd,
      });
      return;
    case "auto-resume":
      setDrawdownTripped({ scopeKey, trippedAt: null, lastValueUsd: args.currentUsd });
      return;
    case "within-band":
      // Update last_value_usd so `safety drawdown` shows the most
      // recent reading without forcing a portfolio refetch. Peak +
      // tripped state are unchanged.
      if (state) {
        setDrawdownTripped({ scopeKey, trippedAt: null, lastValueUsd: args.currentUsd });
      }
      return;
    case "trip-now": {
      // Persist the trip BEFORE throwing so a downstream catch+retry
      // doesn't bypass the breaker by burying the state mutation.
      setDrawdownTripped({
        scopeKey,
        trippedAt: outcome.trippedAt,
        lastValueUsd: args.currentUsd,
      });
      throw buildTrippedError({
        scope: scopeKey,
        peak: outcome.peak,
        currentUsd: outcome.currentUsd,
        drawdownPct: outcome.drawdownPct,
        thresholdPct: outcome.thresholdPct,
        trippedAt: outcome.trippedAt,
        freshTrip: true,
      });
    }
    case "still-tripped":
      // Even when blocked, update last_value_usd — operators want to
      // see "how close to recovery" without forcing a refetch.
      setDrawdownTripped({
        scopeKey,
        trippedAt: outcome.trippedAt,
        lastValueUsd: args.currentUsd,
      });
      throw buildTrippedError({
        scope: scopeKey,
        peak: outcome.peak,
        currentUsd: outcome.currentUsd,
        drawdownPct: outcome.drawdownPct,
        thresholdPct: cfg.maxDrawdownPct,
        trippedAt: outcome.trippedAt,
        freshTrip: false,
      });
  }
}

function buildTrippedError(args: {
  scope: string;
  peak: number;
  currentUsd: number;
  drawdownPct: number;
  thresholdPct: number;
  trippedAt: string;
  freshTrip: boolean;
}): ToolError {
  const msgPrefix = args.freshTrip
    ? `Drawdown circuit breaker tripping NOW for scope "${args.scope}"`
    : `Drawdown circuit breaker is currently tripped for scope "${args.scope}"`;
  return new ToolError(
    "DRAWDOWN_CIRCUIT_BREAKER_TRIPPED",
    `${msgPrefix}: portfolio $${args.currentUsd.toFixed(2)} is ${args.drawdownPct.toFixed(2)}% below peak $${args.peak.toFixed(2)} (threshold ${args.thresholdPct.toFixed(2)}%). ` +
      `Investigate the loss + reset with \`tradekit safety reset-drawdown\` to resume trading.`,
    {
      details: {
        scope: args.scope,
        peakUsd: args.peak,
        currentUsd: args.currentUsd,
        drawdownPct: args.drawdownPct,
        thresholdPct: args.thresholdPct,
        trippedAt: args.trippedAt,
        freshTrip: args.freshTrip,
      },
      nextActions: [
        {
          tool: "health",
          reason: `Review portfolio health to identify the source of the drawdown before resuming trading. The breaker tripped at ${args.trippedAt}.`,
        },
        {
          tool: "config",
          reason: `Inspect \`safety.drawdownCircuitBreaker\` via \`tradekit config show\` to see the configured threshold.`,
        },
      ],
    },
  );
}
