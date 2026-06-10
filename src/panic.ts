/**
 * Emergency stop — the one-command "oh shit" lever.
 *
 * When something is wrong (compromised key suspicion, runaway
 * strategy, exchange-wide chaos), the operator should not have to
 * remember four commands and a tag list. `tradekit panic` composes
 * the existing safety primitives into one atomic action:
 *
 *   1. ENGINE LOCK — every fire path hard-gates on the lock, so
 *      nothing executes from the next tick on. Fastest-acting layer.
 *   2. PAUSE EVERYTHING — every active order / schedule / rebalance
 *      plan flips to paused, regardless of strategy tag (including
 *      untagged primitives the tag-based `strategy pause` can't
 *      reach). Belt and suspenders: the stop survives an engine
 *      unlock, and the state is explicit in every list view.
 *   3. (opt-in) CANCEL ORDERS — terminal, for "I never want these
 *      to fire" situations. Off by default because pause is
 *      reversible and panic decisions are made under stress.
 *
 * Release is deliberately conservative: `panic release` unlocks the
 * engine but leaves everything paused — the operator resumes
 * selectively (`strategy resume <tag>`, `order resume <id>`) after
 * investigating. `--resume-all` exists for the false-alarm case.
 *
 * NOT exposed over MCP — same CLI-only safety boundary as backup:
 * an agent (or a prompt-injected agent) must not be able to mass-
 * cancel orders; and conversely a panic engaged by a human must not
 * be releasable by an agent.
 */

import {
  listOrders,
  listSchedules,
  pauseOrder,
  pauseSchedule,
  pauseRebalancePlan,
  cancelOrder,
  resumeOrder,
} from "./db.js";
import { listRebalancePlans } from "./rebalance.js";
import { resumeScheduleById } from "./schedules.js";
import { resumeRebalancePlanById } from "./rebalance.js";
import { lockEngine, unlockEngine, getEngineLockState, isEngineLockedFromRow } from "./engineLock.js";
import { tryNotify } from "./notify.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

export interface PanicReport {
  engagedAt: string;
  reason: string | null;
  /** True when the engine was ALREADY locked before this panic. */
  alreadyLocked: boolean;
  paused: { orders: number[]; schedules: number[]; rebalances: number[] };
  /** Only populated with cancelOrders: true. */
  cancelledOrders: number[];
  totalStopped: number;
}

export interface ReleaseReport {
  releasedAt: string;
  unlocked: boolean;
  /** Only populated with resumeAll: true. */
  resumed: { orders: number[]; schedules: number[]; rebalances: number[] };
}

export async function executePanic(args: {
  reason?: string;
  /** Cancel active orders (terminal) instead of pausing them. */
  cancelOrders?: boolean;
  config: Config;
  logger: Logger;
  notifyFn?: typeof tryNotify;
}): Promise<PanicReport> {
  const now = new Date().toISOString();
  const reason = args.reason?.trim() || null;

  // 1) Engine lock FIRST — it gates every fire path from the next
  // tick, so the window between "operator hits enter" and "nothing
  // can execute" is as small as possible.
  const prior = getEngineLockState();
  const alreadyLocked = isEngineLockedFromRow(prior);
  await lockEngine({
    reason: `PANIC${reason ? `: ${reason}` : ""}`,
    lockedBy: "panic",
    config: args.config,
    logger: args.logger,
  });

  // 2) Pause (or cancel) everything active, tag or no tag.
  const report: PanicReport = {
    engagedAt: now,
    reason,
    alreadyLocked,
    paused: { orders: [], schedules: [], rebalances: [] },
    cancelledOrders: [],
    totalStopped: 0,
  };

  for (const o of listOrders({ status: "active" })) {
    if (o.id == null) continue;
    if (args.cancelOrders) {
      if (cancelOrder(o.id) > 0) report.cancelledOrders.push(o.id);
    } else if (pauseOrder(o.id) > 0) {
      report.paused.orders.push(o.id);
    }
  }
  for (const s of listSchedules({ status: "active" })) {
    if (s.id == null) continue;
    if (pauseSchedule(s.id) > 0) report.paused.schedules.push(s.id);
  }
  for (const r of listRebalancePlans({ status: "active" })) {
    if (r.id == null) continue;
    if (pauseRebalancePlan(r.id) > 0) report.paused.rebalances.push(r.id);
  }
  report.totalStopped =
    report.paused.orders.length +
    report.paused.schedules.length +
    report.paused.rebalances.length +
    report.cancelledOrders.length;

  args.logger.warn(
    `PANIC engaged${reason ? ` (${reason})` : ""}: engine locked; ` +
      `paused ${report.paused.orders.length} order(s), ${report.paused.schedules.length} schedule(s), ` +
      `${report.paused.rebalances.length} rebalance plan(s)` +
      (report.cancelledOrders.length ? `; CANCELLED ${report.cancelledOrders.length} order(s)` : ""),
  );

  const notify = args.notifyFn ?? tryNotify;
  await notify(
    {
      event: "engine.panic",
      severity: "critical",
      title: `PANIC engaged — engine locked, ${report.totalStopped} primitive(s) stopped`,
      body:
        `${reason ?? "(no reason given)"}\n\n` +
        `Paused: ${report.paused.orders.length} order(s), ${report.paused.schedules.length} schedule(s), ${report.paused.rebalances.length} rebalance plan(s).` +
        (report.cancelledOrders.length ? `\nCANCELLED (terminal): ${report.cancelledOrders.length} order(s).` : "") +
        `\n\nRelease with: tradekit panic release  (engine unlocks; everything STAYS paused for selective resume)`,
      fields: {
        reason,
        ordersPaused: report.paused.orders.length,
        schedulesPaused: report.paused.schedules.length,
        rebalancesPaused: report.paused.rebalances.length,
        ordersCancelled: report.cancelledOrders.length,
        alreadyLocked,
      },
      dedupKey: `engine.panic:${now}`,
    },
    args.config,
    args.logger,
  );

  return report;
}

export async function releasePanic(args: {
  /** Also resume every paused primitive (false-alarm case). Default:
   *  unlock only — the operator resumes selectively. */
  resumeAll?: boolean;
  config: Config;
  logger: Logger;
  notifyFn?: typeof tryNotify;
}): Promise<ReleaseReport> {
  const now = new Date();
  await unlockEngine({ config: args.config, logger: args.logger, unlockedBy: "panic-release" });

  const report: ReleaseReport = {
    releasedAt: now.toISOString(),
    unlocked: true,
    resumed: { orders: [], schedules: [], rebalances: [] },
  };

  if (args.resumeAll) {
    for (const o of listOrders({ status: "paused" })) {
      if (o.id == null) continue;
      if (resumeOrder(o.id) > 0) report.resumed.orders.push(o.id);
    }
    for (const s of listSchedules({ status: "paused" })) {
      if (s.id == null) continue;
      resumeScheduleById(s.id, now);
      report.resumed.schedules.push(s.id);
    }
    for (const r of listRebalancePlans({ status: "paused" })) {
      if (r.id == null) continue;
      resumeRebalancePlanById(r.id, now);
      report.resumed.rebalances.push(r.id);
    }
  }

  const resumedTotal =
    report.resumed.orders.length + report.resumed.schedules.length + report.resumed.rebalances.length;
  args.logger.warn(
    `panic released: engine unlocked${args.resumeAll ? `; resumed ${resumedTotal} primitive(s)` : "; primitives remain paused (resume selectively)"}`,
  );

  const notify = args.notifyFn ?? tryNotify;
  await notify(
    {
      event: "engine.panic_released",
      severity: "warn",
      title: `Panic released — engine unlocked${args.resumeAll ? `, ${resumedTotal} primitive(s) resumed` : ", primitives remain paused"}`,
      body: args.resumeAll
        ? `Resumed ${report.resumed.orders.length} order(s), ${report.resumed.schedules.length} schedule(s), ${report.resumed.rebalances.length} rebalance plan(s).`
        : `Everything stays paused — resume selectively via strategy resume <tag> / order resume <id> / schedule resume <id>.`,
      fields: {
        resumeAll: args.resumeAll === true,
        ordersResumed: report.resumed.orders.length,
        schedulesResumed: report.resumed.schedules.length,
        rebalancesResumed: report.resumed.rebalances.length,
      },
      dedupKey: `engine.panic_released:${report.releasedAt}`,
    },
    args.config,
    args.logger,
  );

  return report;
}
