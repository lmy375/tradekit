/**
 * Engine kill switch — global fail-safe mode.
 *
 * Single command halts ALL trading paths:
 *   - Orders engine: continues ticking (HWM tracking stays fresh)
 *     but SKIPS the fire path.
 *   - Schedules engine: skips all fires.
 *   - Rebalance engine: skips drift evaluation entirely.
 *   - Manual trades (executeTrade): hard-reject with ENGINE_LOCKED.
 *   - Post-fill hooks: skipped (defense-in-depth).
 *
 * Why a DB row instead of a config field: engines tick continuously.
 * A config-based lock would need process restart or hot-reload. A
 * DB row is queried per tick (~µs cost) and changes propagate
 * instantly across processes (CLI + engine + MCP server all see
 * the same state).
 *
 * Why orders still tick but skip firing: operators want trailing
 * stops to STAY POSITIONED while locked. If HWM was $3500 at lock
 * time and ETH hits $3800 during the lock window, the trail's HWM
 * should advance to $3800 so it fires from the fresh threshold on
 * unlock. Skipping ticks entirely would leave the trail with stale
 * state and potentially mis-fire on resume.
 *
 * Composes with the existing safety stack: position limits, strategy
 * budgets, and drawdown breaker are per-rule / per-state guards;
 * this is the operator-initiated kill switch one level above.
 */

import { ToolError, type ToolError as ToolErrorT } from "./errors.js";
import {
  getEngineLock,
  setEngineLock as dbSetEngineLock,
  clearEngineLock as dbClearEngineLock,
  type EngineLockRow,
} from "./db.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { tryNotify } from "./notify.js";
import { recordEngineLock, recordEngineUnlock } from "./engineEvents.js";

// ── predicate ────────────────────────────────────────────────

/**
 * Pure predicate over a row. Engines use the higher-level
 * `assertEngineNotLocked` to throw on locked state; this function is
 * for callers that want to BRANCH on the result (e.g. orders engine
 * skips fire but continues HWM tracking).
 */
export function isEngineLockedFromRow(row: EngineLockRow): boolean {
  return row.active === 1;
}

/** Read the lock state. Single-row indexed read; sub-millisecond. */
export function isEngineLocked(): boolean {
  return isEngineLockedFromRow(getEngineLock());
}

/** Read the full lock state (active + reason + locked_at + locked_by).
 *  Used by `status` dashboard + ENGINE_LOCKED error details. */
export function getEngineLockState(): EngineLockRow {
  return getEngineLock();
}

// ── trade-time enforcement ───────────────────────────────────

/**
 * Throw ENGINE_LOCKED when the lock is active. Called at the top of
 * `executeTrade` for manual trades — the lock applies BEFORE any
 * RPC roundtrip, aggregator call, or simulation cost.
 *
 * Error includes the lock context (reason, locked_at, locked_by) so
 * incident responders know WHY when they hit the rejection.
 * `nextActions[]` points at `tradekit engine unlock`.
 */
export function assertEngineNotLocked(args: { context: string }): void {
  const row = getEngineLock();
  if (!isEngineLockedFromRow(row)) return;
  throw new ToolError(
    "ENGINE_LOCKED",
    `Engine is locked (${args.context} blocked). ` +
      `Reason: ${row.reason ?? "(not specified)"}. ` +
      `Locked at: ${row.locked_at ?? "(unknown)"} by ${row.locked_by ?? "(unknown)"}. ` +
      `Run \`tradekit engine unlock\` to resume trading.`,
    {
      details: {
        lockedAt: row.locked_at,
        reason: row.reason,
        lockedBy: row.locked_by,
        blockedContext: args.context,
      },
      nextActions: [
        {
          tool: "engine_unlock",
          reason: `Investigate the reason for the lock, then run \`tradekit engine unlock\` (or call engine_unlock via MCP) to resume trading. Trailing-stop HWM tracking continues during the lock — orders will fire on unlock based on fresh state.`,
        },
      ],
    },
  );
}

// ── high-level lock / unlock ─────────────────────────────────

export interface LockEngineArgs {
  reason: string | null;
  lockedBy: string;
  config: Config;
  logger: Logger;
}

/**
 * High-level lock op. Persists the row + emits an `engine.locked`
 * notification + logs at warn level. Audit-log integration is
 * driven by the CLI/MCP `runTool` wrapper (which already audits
 * tool calls); this function focuses on the state mutation + side
 * effects that should happen REGARDLESS of caller surface.
 *
 * Returns the new row. Idempotent — re-locking an already-locked
 * engine just updates the timestamp + reason.
 */
export async function lockEngine(args: LockEngineArgs): Promise<EngineLockRow> {
  const prior = getEngineLock();
  const row = dbSetEngineLock({ reason: args.reason, lockedBy: args.lockedBy });
  // Only emit a notification when transitioning from unlocked → locked.
  // Idempotent re-lock (already-locked) shouldn't spam channels.
  if (!isEngineLockedFromRow(prior)) {
    args.logger.warn(
      `engine locked by ${args.lockedBy}: ${args.reason ?? "(no reason given)"}`,
    );
    await tryNotify(
      {
        event: "engine.locked",
        severity: "warn",
        title: `Engine locked by ${args.lockedBy}`,
        body: `All trading paths (orders, schedules, rebalance, manual trades) will reject until unlocked.\n\nReason: ${args.reason ?? "(no reason given)"}\nLocked at: ${row.locked_at}`,
        fields: {
          reason: args.reason,
          lockedBy: args.lockedBy,
          lockedAt: row.locked_at,
        },
        dedupKey: `engine.locked:${row.locked_at}`,
      },
      args.config,
      args.logger,
    );
    // Iter39: durable engine event mirrors the notification.
    recordEngineLock({
      lockedAt: row.locked_at!,
      reason: args.reason,
      lockedBy: args.lockedBy,
      logger: args.logger,
    });
  }
  return row;
}

export interface UnlockEngineArgs {
  config: Config;
  logger: Logger;
  unlockedBy: string;
}

/**
 * High-level unlock op. Clears the row + emits an `engine.unlocked`
 * notification. Idempotent — clearing an already-unlocked engine is
 * a no-op (no notification, no log).
 */
export async function unlockEngine(args: UnlockEngineArgs): Promise<EngineLockRow> {
  const prior = getEngineLock();
  if (!isEngineLockedFromRow(prior)) {
    return prior; // already unlocked — no-op
  }
  const row = dbClearEngineLock();
  const lockedFor = prior.locked_at
    ? `${Math.floor((Date.now() - Date.parse(prior.locked_at)) / 1000)}s`
    : "unknown";
  args.logger.info(`engine unlocked by ${args.unlockedBy} after ${lockedFor}`);
  await tryNotify(
    {
      event: "engine.unlocked",
      severity: "info",
      title: `Engine unlocked by ${args.unlockedBy}`,
      body: `Trading resumed. Lock duration: ${lockedFor}.\nPrevious reason: ${prior.reason ?? "(none)"}.`,
      fields: {
        unlockedBy: args.unlockedBy,
        lockedFor,
        previousReason: prior.reason,
      },
      dedupKey: `engine.unlocked:${row.updated_at}`,
    },
    args.config,
    args.logger,
  );
  // Iter39: durable engine.unlock event. pairedLockedAt lets the
  // operator (or timeline UI) link the lock + unlock rows.
  recordEngineUnlock({
    unlockedAt: row.updated_at,
    unlockedBy: args.unlockedBy,
    pairedLockedAt: prior.locked_at ?? null,
    logger: args.logger,
  });
  return row;
}

// ── fire-path soft-skip helper ───────────────────────────────

/**
 * Soft-skip helper for engines that should CONTINUE ticking when
 * locked but skip their FIRE / EVAL paths. Logs a debug-level
 * message once per tick describing the skip; the caller is expected
 * to short-circuit the per-row fire loop.
 *
 * Returns true when locked (caller should skip), false otherwise.
 */
export function softSkipIfLocked(args: {
  context: string;
  logger: Logger;
}): boolean {
  const row = getEngineLock();
  if (!isEngineLockedFromRow(row)) return false;
  args.logger.debug(
    `${args.context}: engine locked (reason: ${row.reason ?? "n/a"}) — skipping fires`,
  );
  return true;
}

// Re-export the type for downstream consumers + unused-import
// suppression for the imported `ToolErrorT` alias.
export type { EngineLockRow } from "./db.js";
const _toolErrTypeReExport: ToolErrorT | undefined = undefined;
void _toolErrTypeReExport;
