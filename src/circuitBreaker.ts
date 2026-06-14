/**
 * Shared failure circuit-breaker (v62) — for cron-firing primitives that
 * would otherwise fire-and-fail FOREVER.
 *
 * v61 introduced this for schedules; v62 generalizes it. A schedule or a
 * rebalance plan that reverts every fire (bad config, dead pool, a token
 * that never passes its honeypot probe) keeps firing on every cron window,
 * burning gas on each revert — `fireRetry` only bounds the TRANSIENT retry,
 * and strategy alerts only NOTIFY. When the breaker is enabled and a
 * primitive's CONSECUTIVE terminal-failure count crosses the threshold,
 * this pauses it and pages the operator (critical), who investigates then
 * `resume`s (which clears the streak).
 *
 * Pure-ish: the only effects are the injected `pause` and the notification.
 * Both schedules.ts and rebalance.ts route through this so the mechanism
 * (and its message/dedup shape) can't diverge.
 */

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { tryNotify } from "./notify.js";

export interface FailureCircuitBreakerConfig {
  enabled: boolean;
  maxConsecutiveFailures: number;
}

export type CircuitBreakerKind = "schedule" | "rebalance";

/**
 * Pause + notify when the consecutive-failure streak crosses the threshold.
 * Returns true when it paused; false when the breaker is disabled, the
 * count is under the threshold, or the pause was a no-op (the row wasn't
 * active — e.g. a concurrent cancel won the race).
 */
export async function tripCircuitBreakerIfNeeded(args: {
  kind: CircuitBreakerKind;
  id: number;
  name: string | null;
  chain: string;
  account: string;
  /** Consecutive terminal failures AFTER this failure (the value
   *  recordScheduleError / recordRebalanceError just returned). */
  failCount: number;
  /** Error code of the failure that tripped it (for the page). */
  lastCode: string;
  breaker: FailureCircuitBreakerConfig | undefined;
  /** Injected pause helper — returns > 0 when it actually paused an
   *  active row (dbPauseSchedule / dbPauseRebalancePlan semantics). */
  pause: (id: number) => number;
  config: Config;
  logger: Logger;
}): Promise<boolean> {
  const { breaker } = args;
  if (!breaker?.enabled || args.failCount < breaker.maxConsecutiveFailures) return false;
  if (args.pause(args.id) <= 0) return false;

  const label = args.kind === "schedule" ? "Schedule" : "Rebalance plan";
  const resumeCmd = args.kind === "schedule"
    ? `tradekit schedule resume ${args.id}`
    : `tradekit rebalance resume ${args.id}`;
  await tryNotify(
    {
      event: `${args.kind}.circuit_broken`,
      severity: "critical",
      title: `${label} #${args.id}${args.name ? ` (${args.name})` : ""} AUTO-PAUSED — ${args.failCount} consecutive failures`,
      body:
        `The circuit-breaker tripped after ${args.failCount} consecutive terminal failures ` +
        `(threshold ${breaker.maxConsecutiveFailures}; last error ${args.lastCode}). The ${args.kind} is ` +
        `paused so it stops retrying and burning gas. Investigate, then \`${resumeCmd}\` to re-enable ` +
        `(clears the streak).`,
      fields: {
        id: args.id,
        chain: args.chain,
        account: args.account,
        consecutiveFailures: args.failCount,
        threshold: breaker.maxConsecutiveFailures,
        lastErrorCode: args.lastCode,
      },
      dedupKey: `${args.kind}.circuit_broken:${args.id}`,
    },
    args.config,
    args.logger,
  );
  return true;
}
