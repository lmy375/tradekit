// Scheduled / recurring trades engine — DCA (dollar-cost averaging) primitive.
//
// Standing intents that fire on a CRON-EXPRESSION schedule, routed through
// `executeTrade` so every safety guardrail, audit row, and structured-error
// pathway is inherited (same architectural pattern as the orders engine,
// just time-triggered instead of price-triggered).
//
// Lifecycle (status column):
//   active     → engine fires when now >= next_run_at
//   paused     → operator-paused; engine ignores; resumeSchedule reactivates
//   completed  → engine reached max_runs OR observed now > end_at; terminal
//   cancelled  → operator-cancelled; terminal
//
// Failure handling:
//   - Transient (RPC down, rate limit): advance next_run_at one period and
//     leave active. Operators running a daily DCA don't want a 1-tick blip
//     to reset their schedule.
//   - Terminal (revert, SAFEGUARD_TRIGGERED, INSUFFICIENT_BALANCE): same —
//     advance next_run_at, leave active. The failure is recorded on the row
//     (last_error_*) AND emitted via `schedule.failed`. The DCA semantic is
//     "try each occurrence independently"; operators wanting strict
//     halt-on-error pause the schedule from their notification callback.
//   - Cron error (impossible expression after the engine reaches an edge):
//     terminal — mark completed with last_error_code so the operator sees
//     the row in `schedule list --status completed`.

import type { Address, PublicClient, WalletClient, Account, Transport, Chain } from "viem";
import { ToolError, type NextAction } from "./errors.js";
import { executeTrade, type TradeRequest, type TradeContext, type TradeResult } from "./trade.js";
import { executePaperTrade, type PaperTradeContext } from "./paperTrade.js";
import { resolveTradePair } from "./chains.js";
import { resolveProfile, loadConfig, type Config } from "./config.js";
import {
  insertSchedule,
  getScheduleById,
  listSchedules,
  dueSchedules,
  setScheduleNextRunAt,
  recordScheduleFire,
  recordScheduleError,
  pauseSchedule as dbPauseSchedule,
  resumeSchedule as dbResumeSchedule,
  cancelSchedule as dbCancelSchedule,
  scheduleCountsByStatus,
  type ScheduleRow,
  type ScheduleStatus,
  type InsertScheduleArgs,
} from "./db.js";
import { parseCron, nextRun, durationToCron } from "./cron.js";
import type { Logger } from "./logger.js";
import type { ChainProfile } from "./chains.js";
import { loadWallet, loadReadOnlyWallet } from "./wallet.js";
import { tryNotify } from "./notify.js";
import { validateOnFillSpec } from "./scheduleHooks.js";

export type { ScheduleRow, ScheduleStatus, ScheduleFilter } from "./db.js";

// ── creation ─────────────────────────────────────────────────

export interface CreateScheduleArgs {
  /** Operator-facing label. Optional but recommended — surfaces in list views
   *  and notification payloads. */
  name?: string;
  /** 5-field cron expression OR a macro (@hourly, @daily, etc.). Either
   *  `cron` or `every` is required (exactly one). */
  cron?: string;
  /** Duration shorthand: 30m, 1h, 6h, 1d, 7d. Compiled to cron via durationToCron. */
  every?: string;
  side: "buy" | "sell";
  chain: string;
  account: string;
  base: Address | "ETH";
  quote: Address;
  baseAmount?: string;
  quoteAmount?: string;
  slippageBps?: number;
  autoSlippage?: boolean;
  /** ISO-8601 start; engine ignores fires before this. */
  startAt?: string;
  /** ISO-8601 end; engine marks completed when this passes. */
  endAt?: string;
  /** Lifetime cap on fires. Common: max_runs=12 for a year of monthly DCA. */
  maxRuns?: number;
  strategy?: string;
  note?: string;
  /** Iter27: optional post-fill hook spec. When supplied, the engine
   *  auto-creates a follow-up order after each successful fire.
   *  Validated at create time — fake fill data rendered through
   *  createOrderRow's validator gates so misconfiguration surfaces
   *  before the first fire. NULL = no hook. */
  onFill?: unknown;
  /** Iter30: when true the schedule fires against the virtual book
   *  rather than executing on-chain. Default false. */
  paper?: boolean;
}

function resolveSymbols(
  profile: ChainProfile,
  base: Address | "ETH",
  quote: Address,
): { baseSym: string | null; quoteSym: string | null } {
  const lookupSym = (addr: Address): string | null => {
    const target = addr.toLowerCase();
    for (const [sym, tokAddr] of Object.entries(profile.tokens ?? {})) {
      if (tokAddr.toLowerCase() === target) return sym;
    }
    return null;
  };
  const baseSym = base === "ETH" ? profile.nativeSymbol : lookupSym(base);
  return { baseSym, quoteSym: lookupSym(quote) };
}

/**
 * Create a recurring schedule. Validates the request shape, parses the cron
 * expression, computes the initial next_run_at, and persists the row.
 *
 * Validation:
 *   - exactly one of cron / every
 *   - exactly one of baseAmount / quoteAmount
 *   - startAt / endAt are ISO-8601 if set; endAt > startAt
 *   - maxRuns is a positive integer if set
 *   - slippageBps in (0, 10000]
 *   - cron expression must yield a firing within 5 years (parseCron+nextRun)
 */
export function createScheduleRow(args: CreateScheduleArgs, config: Config = loadConfig()): ScheduleRow {
  if (args.side !== "buy" && args.side !== "sell") {
    throw new ToolError("INVALID_PARAMS", `side must be "buy" or "sell" (got "${args.side}").`);
  }
  const hasCron = args.cron != null && args.cron !== "";
  const hasEvery = args.every != null && args.every !== "";
  if (hasCron === hasEvery) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Specify exactly one of cron / every. e.g. `--cron \"0 10 * * 1\"` for Monday 10am UTC, or `--every 1d` for daily.",
    );
  }
  const cronExpr = hasCron ? args.cron! : durationToCron(args.every!);
  const parsed = parseCron(cronExpr); // throws on malformed

  const hasBase = args.baseAmount != null && args.baseAmount !== "";
  const hasQuote = args.quoteAmount != null && args.quoteAmount !== "";
  if (hasBase === hasQuote) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Specify exactly one of baseAmount / quoteAmount (matches the trade contract — the other side is derived at fill time from the live quote).",
    );
  }
  if (args.slippageBps != null && (!Number.isInteger(args.slippageBps) || args.slippageBps <= 0 || args.slippageBps > 10_000)) {
    throw new ToolError("INVALID_PARAMS", `slippageBps must be an integer in (0, 10000] (got ${args.slippageBps}).`);
  }
  const now = new Date();
  let startAt: string | null = null;
  if (args.startAt) {
    const t = Date.parse(args.startAt);
    if (!Number.isFinite(t)) {
      throw new ToolError("INVALID_PARAMS", `startAt must be a valid ISO-8601 timestamp (got "${args.startAt}").`);
    }
    startAt = new Date(t).toISOString();
  }
  let endAt: string | null = null;
  if (args.endAt) {
    const t = Date.parse(args.endAt);
    if (!Number.isFinite(t)) {
      throw new ToolError("INVALID_PARAMS", `endAt must be a valid ISO-8601 timestamp (got "${args.endAt}").`);
    }
    endAt = new Date(t).toISOString();
    if (t <= now.getTime()) {
      throw new ToolError("INVALID_PARAMS", `endAt must be in the future (got "${args.endAt}").`);
    }
    if (startAt && Date.parse(startAt) >= t) {
      throw new ToolError("INVALID_PARAMS", `endAt must be after startAt.`);
    }
  }
  if (args.maxRuns != null && (!Number.isInteger(args.maxRuns) || args.maxRuns <= 0)) {
    throw new ToolError("INVALID_PARAMS", `maxRuns must be a positive integer (got ${args.maxRuns}).`);
  }

  // Compute the initial next_run_at. If startAt is in the future, the first
  // fire must be at-or-after startAt — we walk from (startAt - 1 minute) so
  // the strictly-after semantic of nextRun yields the first matching minute
  // ≥ startAt. Otherwise walk from now.
  const startCursor =
    startAt && Date.parse(startAt) > now.getTime()
      ? new Date(Date.parse(startAt) - 60_000)
      : now;
  const firstRun = nextRun(parsed, startCursor);
  if (endAt && firstRun.getTime() > Date.parse(endAt)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `cron "${cronExpr}" never fires before endAt (${endAt}). Adjust cron or extend endAt.`,
    );
  }

  const profile = resolveProfile(args.chain, config);
  const { base, quote } = resolveTradePair(profile, args.base, args.quote);
  const { baseSym, quoteSym } = resolveSymbols(profile, base, quote);

  // Iter27: validate the post-fill hook spec (if supplied) BEFORE
  // inserting the schedule row. The validator renders the hook with
  // fake fill data + runs the resulting order spec through the
  // createOrderRow-equivalent gates. Catches typos / invalid trigger
  // configurations / missing required fields at create time, not
  // months later on the first fire.
  //
  // createScheduleRow is sync — but ESM bans require(). We use a
  // static top-level import (added below in the imports section)
  // since validateOnFillSpec has no circular dependency back to
  // schedules.ts (it only depends on orders.ts + db.ts).
  let onFillJson: string | null = null;
  if (args.onFill != null) {
    validateOnFillSpec({
      raw: args.onFill,
      chain: profile.name,
      account: args.account,
      config,
      baseAddress: base,
      quoteAddress: quote,
    });
    onFillJson = JSON.stringify(args.onFill);
  }

  const insertArgs: InsertScheduleArgs = {
    name: args.name ?? null,
    cron_expr: cronExpr,
    next_run_at: firstRun.toISOString(),
    side: args.side,
    chain: profile.name,
    account: args.account,
    base_token: base as string,
    base_symbol: baseSym,
    quote_token: quote as string,
    quote_symbol: quoteSym,
    base_amount: hasBase ? args.baseAmount! : null,
    quote_amount: hasQuote ? args.quoteAmount! : null,
    slippage_bps: args.slippageBps ?? null,
    auto_slippage: args.autoSlippage ?? false,
    start_at: startAt,
    end_at: endAt,
    max_runs: args.maxRuns ?? null,
    strategy: args.strategy ?? null,
    note: args.note ?? null,
    on_fill_json: onFillJson,
    paper: args.paper === true,
  };
  const id = insertSchedule(insertArgs);
  const row = getScheduleById(id);
  if (!row) {
    throw new ToolError("INTERNAL_ERROR", `Schedule ${id} disappeared immediately after insert.`);
  }
  return row;
}

// ── lifecycle ────────────────────────────────────────────────

export function pauseScheduleById(id: number): ScheduleRow {
  const existing = getScheduleById(id);
  if (!existing) throw new ToolError("INVALID_PARAMS", `Schedule #${id} not found.`, { details: { scheduleId: id } });
  const r = dbPauseSchedule(id);
  if (r === -1) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Schedule #${id} is ${existing.status} — only active schedules can be paused.`,
      { details: { scheduleId: id, currentStatus: existing.status } },
    );
  }
  return getScheduleById(id) ?? existing;
}

export function resumeScheduleById(id: number, now: Date = new Date()): ScheduleRow {
  const existing = getScheduleById(id);
  if (!existing) throw new ToolError("INVALID_PARAMS", `Schedule #${id} not found.`, { details: { scheduleId: id } });
  // Recompute next_run_at so the resumed schedule fires on its next natural
  // slot rather than backfilling every missed window. DCA semantic: paused
  // == "skip until I say go", not "queue them up".
  const parsed = parseCron(existing.cron_expr);
  const next = nextRun(parsed, now);
  const r = dbResumeSchedule(id, next.toISOString());
  if (r === -1) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Schedule #${id} is ${existing.status} — only paused schedules can be resumed.`,
      { details: { scheduleId: id, currentStatus: existing.status } },
    );
  }
  return getScheduleById(id) ?? existing;
}

export function cancelScheduleById(id: number): ScheduleRow {
  const existing = getScheduleById(id);
  if (!existing) throw new ToolError("INVALID_PARAMS", `Schedule #${id} not found.`, { details: { scheduleId: id } });
  dbCancelSchedule(id);
  return getScheduleById(id) ?? existing;
}

// ── engine tick ──────────────────────────────────────────────

export interface ScheduleTickArgs {
  chain?: string;
  account?: string;
  password?: string;
  dryRun?: boolean;
  logger: Logger;
  /** Override "now" for testing. Defaults to `new Date()`. */
  now?: Date;
}

export interface ScheduleFireReport {
  scheduleId: number;
  name: string | null;
  status: "fired" | "failed" | "skipped" | "completed";
  txHash?: string;
  errorCode?: string;
  errorMessage?: string;
  nextRunAt?: string;
}

export interface ScheduleTickReport {
  ok: true;
  timestamp: string;
  elapsedMs: number;
  severity: "ok" | "warn" | "critical";
  due: number;
  fired: number;
  failed: number;
  completed: number;
  skipped: number;
  fires: ScheduleFireReport[];
  recommendedActions: NextAction[];
}

/** Conservative classifier — see orders.ts isTransientErrorCode for the
 *  same rationale. Schedules apply the same split because the engine paths
 *  share the same shapes of failure. */
function isTransientErrorCode(code: string): boolean {
  return (
    code === "RPC_FAILED" ||
    code === "RPC_RATE_LIMITED" ||
    code === "API_ERROR" ||
    code === "TX_TIMEOUT" ||
    code === "QUOTE_FAILED" ||
    code === "AGGREGATOR_FAILED"
  );
}

/**
 * Single engine tick: fire every schedule whose `next_run_at` has passed.
 *
 * The query is `dueSchedules(asOfIso)` which uses the indexed range scan
 * on `next_run_at` so an idle tick over thousands of schedules is cheap.
 * Each fire runs sequentially per account (the executeTrade flow already
 * serializes via accountLock); per-tick parallelism across distinct
 * accounts is intentionally NOT added here — DCA cadences are coarse
 * (typically ≥ 1 hour between fires) so amortizing wallet decryption
 * matters more than wall-clock latency.
 */
export async function runScheduleTick(args: ScheduleTickArgs): Promise<ScheduleTickReport> {
  const startedAt = Date.now();
  const now = args.now ?? new Date();
  let due = dueSchedules(now.toISOString());
  if (args.chain) due = due.filter((s) => s.chain === args.chain!.toLowerCase());
  if (args.account) due = due.filter((s) => s.account === args.account);

  const fires: ScheduleFireReport[] = [];
  let fired = 0;
  let failed = 0;
  let completed = 0;
  let skipped = 0;

  const config = loadConfig();

  // Walk in deterministic id order. dueSchedules already orders by id ASC,
  // but be explicit so future caller-side merges don't surprise us.
  due.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

  // Lazy wallet cache keyed by `${chain}:${account}` so multiple due
  // schedules for the same account share one keystore decrypt per tick.
  type Built = {
    profile: ChainProfile;
    publicClient: PublicClient<Transport, Chain>;
    walletClient: WalletClient<Transport, Chain, Account>;
    label: string;
  };
  const built = new Map<string, Built>();
  async function ensureWallet(
    chain: string,
    account: string,
    opts: { readOnly?: boolean } = {},
  ): Promise<Built> {
    // Iter30: opts.readOnly forces the read-only client even when a
    // password is available — paper schedules don't need (and
    // shouldn't decrypt) the keystore.
    const key = `${chain}:${account}`;
    const cached = built.get(key);
    if (cached) return cached;
    const profile = resolveProfile(chain, config);
    const extraRpcs = config.chains[chain]?.rpcs ?? [];
    const wallet = args.dryRun || opts.readOnly || !args.password
      ? loadReadOnlyWallet(profile, extraRpcs, account)
      : await loadWallet(args.password, profile, extraRpcs, args.logger, account);
    const out: Built = {
      profile,
      publicClient: wallet.publicClient,
      walletClient: wallet.walletClient,
      label: wallet.label,
    };
    built.set(key, out);
    return out;
  }

  for (const schedule of due) {
    if (schedule.id == null) continue;

    // 1) Pre-firing checks: start_at gate, end_at gate, max_runs gate.
    if (schedule.start_at && Date.parse(schedule.start_at) > now.getTime()) {
      // start_at is in the future — engine got here because next_run_at
      // is in the past, which shouldn't happen if createScheduleRow did
      // its job. Defensively re-anchor next_run_at to start_at + parse.
      const parsed = parseCron(schedule.cron_expr);
      const nextAt = nextRun(parsed, new Date(Date.parse(schedule.start_at) - 60_000));
      setScheduleNextRunAt(schedule.id, nextAt.toISOString());
      skipped += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "skipped",
        errorCode: "PRE_START",
        errorMessage: `Schedule has not reached start_at (${schedule.start_at}).`,
        nextRunAt: nextAt.toISOString(),
      });
      continue;
    }
    if (schedule.end_at && Date.parse(schedule.end_at) <= now.getTime()) {
      // End-of-life: flip to completed. recordScheduleFire isn't right
      // here (no fill happened); update the DB row directly.
      const db = (await import("./db.js")).openDb();
      db.prepare(`UPDATE schedules SET status = 'completed', updated_at = ? WHERE id = ?`).run(
        now.toISOString(),
        schedule.id,
      );
      completed += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "completed",
      });
      await tryNotify(
        {
          event: "schedule.completed",
          severity: "info",
          title: `Schedule #${schedule.id}${schedule.name ? ` (${schedule.name})` : ""} completed (end_at reached)`,
          fields: {
            id: schedule.id,
            chain: schedule.chain,
            account: schedule.account,
            runCount: schedule.run_count,
            endAt: schedule.end_at,
            totalBaseFilled: schedule.total_base_filled,
            totalQuoteSpent: schedule.total_quote_spent,
          },
          dedupKey: `schedule.completed:${schedule.id}`,
        },
        config,
        args.logger,
      );
      continue;
    }
    if (schedule.max_runs != null && schedule.run_count >= schedule.max_runs) {
      const db = (await import("./db.js")).openDb();
      db.prepare(`UPDATE schedules SET status = 'completed', updated_at = ? WHERE id = ?`).run(
        now.toISOString(),
        schedule.id,
      );
      completed += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "completed",
      });
      await tryNotify(
        {
          event: "schedule.completed",
          severity: "info",
          title: `Schedule #${schedule.id}${schedule.name ? ` (${schedule.name})` : ""} completed (max_runs ${schedule.max_runs} reached)`,
          fields: {
            id: schedule.id,
            chain: schedule.chain,
            account: schedule.account,
            runCount: schedule.run_count,
            maxRuns: schedule.max_runs,
            totalBaseFilled: schedule.total_base_filled,
            totalQuoteSpent: schedule.total_quote_spent,
          },
          dedupKey: `schedule.completed:${schedule.id}`,
        },
        config,
        args.logger,
      );
      continue;
    }

    // 2) Compute the NEXT next_run_at — needed both on success and failure
    // paths so the engine doesn't refire on every tick within the same
    // minute. Parse once; cache the result for the fail-path too.
    let parsed: ReturnType<typeof parseCron>;
    let nextAt: Date;
    try {
      parsed = parseCron(schedule.cron_expr);
      nextAt = nextRun(parsed, now);
    } catch (e) {
      // The cron expression got into a bad state (shouldn't happen after
      // createScheduleRow's validation but defense-in-depth). Mark
      // completed so the engine stops touching this row.
      const msg = (e as Error).message ?? String(e);
      const db = (await import("./db.js")).openDb();
      db.prepare(
        `UPDATE schedules SET status = 'completed', last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?`,
      ).run("INVALID_PARAMS", msg, now.toISOString(), schedule.id);
      completed += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "completed",
        errorCode: "INVALID_PARAMS",
        errorMessage: msg,
      });
      continue;
    }

    if (args.dryRun) {
      // Dry-run: advance next_run_at so a repeated dry-run doesn't keep
      // hitting the same row. The engine treats the dry-run window as if
      // it had fired, just without sending.
      setScheduleNextRunAt(schedule.id, nextAt.toISOString());
      skipped += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "skipped",
        errorCode: "DRY_RUN",
        errorMessage: "Due but dry-run requested — not firing.",
        nextRunAt: nextAt.toISOString(),
      });
      continue;
    }

    // Iter28: engine lock. The schedule is "due" but the global kill
    // switch is active. Skip the fire — DON'T advance next_run_at so
    // the schedule fires immediately when the engine unlocks (the
    // operator wants a missed window to fire as soon as possible).
    // Record the skip as a transient ENGINE_LOCKED on the row so
    // `schedule show` surfaces the reason.
    const { isEngineLocked: _isLocked, getEngineLockState: _lockState } = await import("./engineLock.js");
    if (_isLocked()) {
      const lock = _lockState();
      const lockReason = lock.reason ?? "(no reason)";
      args.logger.info(
        `schedule #${schedule.id} due but engine locked (${lockReason}) — skipping fire`,
      );
      // Stamp the error trail without advancing next_run_at — the
      // engine retries on the next tick.
      const { setOrderError } = await import("./db.js");
      void setOrderError; // helper for orders only; schedules.ts doesn't have setScheduleError
      // We use the existing recordScheduleError shape but DON'T
      // advance next_run_at (pass the current next_run_at unchanged).
      recordScheduleError(
        schedule.id,
        schedule.next_run_at, // unchanged
        "ENGINE_LOCKED",
        `engine locked: ${lockReason}`,
      );
      skipped += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "skipped",
        errorCode: "ENGINE_LOCKED",
        errorMessage: `engine locked: ${lockReason}`,
        nextRunAt: schedule.next_run_at,
      });
      continue;
    }

    // 3) Build the wallet (lazy). Paper schedules use the read-only
    //    path — no keystore decryption needed.
    const isPaperSchedule = (schedule.paper ?? 0) === 1;
    let walletBuilt: Built;
    try {
      walletBuilt = await ensureWallet(schedule.chain, schedule.account, {
        readOnly: isPaperSchedule,
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const code = (e as { code?: string }).code ?? "WALLET_LOCKED";
      // Wallet load is a config / password problem. Record on the row but
      // ALSO advance next_run_at — otherwise the engine re-tries every tick.
      recordScheduleError(schedule.id, nextAt.toISOString(), code, msg);
      failed += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "failed",
        errorCode: code,
        errorMessage: msg,
        nextRunAt: nextAt.toISOString(),
      });
      continue;
    }

    // 4) Execute the trade. Mirrors orders.ts — fully reuses
    //    executeTrade for real schedules; routes to executePaperTrade
    //    for paper. The post-fire bookkeeping (recordScheduleFire,
    //    on_fill hook, notifications) is shared.
    let result: TradeResult | null = null;
    try {
      if (isPaperSchedule) {
        const paperCtx: PaperTradeContext = {
          publicClient: walletBuilt.publicClient,
          profile: walletBuilt.profile,
          config,
          logger: args.logger,
          accountLabel: walletBuilt.label,
        };
        const paperResult = await executePaperTrade(
          {
            direction: schedule.side,
            base: schedule.base_token as Address | "ETH",
            quote: schedule.quote_token as Address,
            baseAmount: schedule.base_amount ?? undefined,
            quoteAmount: schedule.quote_amount ?? undefined,
            slippageBps: schedule.slippage_bps ?? undefined,
            note: schedule.note
              ? `[schedule #${schedule.id}] ${schedule.note}`
              : `[schedule #${schedule.id}]`,
            strategy: schedule.strategy ?? undefined,
            source: { type: "schedule", id: schedule.id ?? null },
          },
          paperCtx,
        );
        result = paperResult as unknown as TradeResult;
      } else {
        const req: TradeRequest = {
          direction: schedule.side,
          base: schedule.base_token as Address | "ETH",
          quote: schedule.quote_token as Address,
          baseAmount: schedule.base_amount ?? undefined,
          quoteAmount: schedule.quote_amount ?? undefined,
          slippageBps: schedule.slippage_bps ?? undefined,
          autoSlippage: schedule.auto_slippage === 1,
          simulate: false,
          note: schedule.note
            ? `[schedule #${schedule.id}] ${schedule.note}`
            : `[schedule #${schedule.id}]`,
          strategy: schedule.strategy ?? undefined,
        };
        const ctx: TradeContext = {
          publicClient: walletBuilt.publicClient,
          walletClient: walletBuilt.walletClient,
          profile: walletBuilt.profile,
          config,
          logger: args.logger,
          accountLabel: walletBuilt.label,
        };
        result = await executeTrade(req, ctx);
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const code = (e as { code?: string }).code ?? "INTERNAL_ERROR";
      // Transient AND terminal both advance next_run_at — DCA's per-occurrence
      // semantic. The error trail stays on the row for diagnosis.
      recordScheduleError(schedule.id, nextAt.toISOString(), code, msg);
      failed += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "failed",
        errorCode: code,
        errorMessage: msg,
        nextRunAt: nextAt.toISOString(),
      });
      // critical severity for terminal errors (safeguard, balance) so
      // pageable channels light up; warn for transient.
      await tryNotify(
        {
          event: "schedule.failed",
          severity: isTransientErrorCode(code) ? "warn" : "critical",
          title: `Schedule #${schedule.id}${schedule.name ? ` (${schedule.name})` : ""} failed: ${code}`,
          body: msg,
          fields: {
            id: schedule.id,
            chain: schedule.chain,
            account: schedule.account,
            errorCode: code,
            nextRunAt: nextAt.toISOString(),
          },
          dedupKey: `schedule.failed:${schedule.id}:${code}`,
        },
        config,
        args.logger,
      );
      continue;
    }

    if (result && result.txHash && result.status !== "failed") {
      const willCompleteOnMaxRuns =
        schedule.max_runs != null && schedule.run_count + 1 >= schedule.max_runs;
      const willCompleteOnEndAt =
        schedule.end_at != null && Date.parse(schedule.end_at) <= nextAt.getTime();
      const completedNow = willCompleteOnMaxRuns || willCompleteOnEndAt;
      recordScheduleFire(schedule.id, {
        nextRunAt: nextAt.toISOString(),
        txHash: result.txHash,
        baseAmount: result.baseAmount,
        quoteAmount: result.quoteAmount,
        completed: completedNow,
      });
      fired += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "fired",
        txHash: result.txHash,
        nextRunAt: nextAt.toISOString(),
      });

      // Iter27: schedule post-fill hook. Auto-create a follow-up
      // order using template variables interpolating the fill data.
      // Hook failure DOES NOT unwind the fill — the trade already
      // happened. We emit a `schedule.on_fill_failed` notification
      // with the error code so operators can intervene + create the
      // follow-up manually.
      let onFillOrderId: number | null = null;
      let onFillError: { code: string; message: string } | null = null;
      if (schedule.on_fill_json) {
        try {
          const { parseOnFillSpec, executeOnFillHook } = await import("./scheduleHooks.js");
          const rawHook = JSON.parse(schedule.on_fill_json);
          const hookSpec = parseOnFillSpec(rawHook);
          const fireResult = executeOnFillHook({
            spec: hookSpec,
            fill: {
              baseAmount: result.baseAmount ?? "0",
              quoteAmount: result.quoteAmount ?? "0",
              fillPriceUsd: result.estimatedUsd != null && parseFloat(result.baseAmount ?? "0") > 0
                ? result.estimatedUsd / parseFloat(result.baseAmount ?? "1")
                : null,
              txHash: result.txHash,
              fireNumber: schedule.run_count + 1,
            },
            chain: schedule.chain,
            account: schedule.account,
            baseAddress: schedule.base_token as Address | "ETH",
            quoteAddress: schedule.quote_token as Address,
            strategyTag: schedule.strategy ?? null,
            config,
          });
          onFillOrderId = fireResult.orderId;
          await tryNotify(
            {
              event: "schedule.on_fill_created",
              severity: "info",
              title: `Schedule #${schedule.id} on-fill hook created order #${onFillOrderId}`,
              body: `After DCA fire #${schedule.run_count + 1}, auto-created follow-up order from on_fill spec.`,
              fields: {
                scheduleId: schedule.id,
                orderId: onFillOrderId,
                fireNumber: schedule.run_count + 1,
                chain: schedule.chain,
              },
              dedupKey: `schedule.on_fill_created:${schedule.id}:${schedule.run_count + 1}`,
            },
            config,
            args.logger,
          );
        } catch (e) {
          const code = (e as { code?: string }).code ?? "INTERNAL_ERROR";
          const msg = (e as Error).message ?? String(e);
          onFillError = { code, message: msg };
          args.logger.error(`schedule #${schedule.id} on_fill hook failed: ${msg}`);
          await tryNotify(
            {
              event: "schedule.on_fill_failed",
              severity: "warn",
              title: `Schedule #${schedule.id} on-fill hook failed: ${code}`,
              body: `Fill succeeded (tx ${result.txHash}) but the on_fill hook errored. Trade NOT unwound; manual follow-up required.\n\n${msg}`,
              fields: {
                scheduleId: schedule.id,
                fireNumber: schedule.run_count + 1,
                chain: schedule.chain,
                errorCode: code,
                txHash: result.txHash,
              },
              dedupKey: `schedule.on_fill_failed:${schedule.id}:${schedule.run_count + 1}`,
            },
            config,
            args.logger,
          );
        }
      }
      // Attach hook outcome to the fire report so engine consumers see it.
      const fireReportLast = fires[fires.length - 1];
      if (fireReportLast && onFillOrderId != null) {
        (fireReportLast as { onFillOrderId?: number }).onFillOrderId = onFillOrderId;
      }
      if (fireReportLast && onFillError) {
        (fireReportLast as { onFillError?: { code: string; message: string } }).onFillError = onFillError;
      }

      await tryNotify(
        {
          event: "schedule.fired",
          severity: "info",
          title: `Schedule #${schedule.id}${schedule.name ? ` (${schedule.name})` : ""} fired · ${schedule.side} ${result.baseAmount} ${result.baseSymbol ?? "base"}`,
          body: `Next run: ${nextAt.toISOString()}.`,
          fields: {
            id: schedule.id,
            chain: schedule.chain,
            account: schedule.account,
            txHash: result.txHash,
            baseAmount: result.baseAmount,
            quoteAmount: result.quoteAmount,
            aggregator: result.aggregator,
            runCount: schedule.run_count + 1,
            maxRuns: schedule.max_runs,
            nextRunAt: nextAt.toISOString(),
          },
          link: result.txHash ? `${walletBuilt.profile.explorer}/tx/${result.txHash}` : undefined,
          dedupKey: `schedule.fired:${schedule.id}:${schedule.run_count + 1}`,
        },
        config,
        args.logger,
      );
      if (completedNow) {
        completed += 1;
        await tryNotify(
          {
            event: "schedule.completed",
            severity: "info",
            title: `Schedule #${schedule.id}${schedule.name ? ` (${schedule.name})` : ""} completed`,
            body: willCompleteOnMaxRuns
              ? `Reached max_runs (${schedule.max_runs}).`
              : `Reached end_at (${schedule.end_at}).`,
            fields: {
              id: schedule.id,
              chain: schedule.chain,
              account: schedule.account,
              runCount: schedule.run_count + 1,
              maxRuns: schedule.max_runs,
              endAt: schedule.end_at,
            },
            dedupKey: `schedule.completed:${schedule.id}`,
          },
          config,
          args.logger,
        );
      }
    } else if (result && result.status === "failed") {
      // Trade landed on-chain but reverted. Record + advance next_run_at +
      // notify. Same semantic as the executeTrade-throw path above.
      const msg = result.simulation?.revertReason ?? "trade reverted on-chain";
      recordScheduleError(schedule.id, nextAt.toISOString(), "TX_REVERTED", msg);
      failed += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "failed",
        txHash: result.txHash,
        errorCode: "TX_REVERTED",
        errorMessage: msg,
        nextRunAt: nextAt.toISOString(),
      });
      await tryNotify(
        {
          event: "schedule.failed",
          severity: "warn",
          title: `Schedule #${schedule.id}${schedule.name ? ` (${schedule.name})` : ""} reverted on-chain`,
          body: msg,
          fields: {
            id: schedule.id,
            chain: schedule.chain,
            account: schedule.account,
            errorCode: "TX_REVERTED",
            txHash: result.txHash,
            nextRunAt: nextAt.toISOString(),
          },
          link: result.txHash ? `${walletBuilt.profile.explorer}/tx/${result.txHash}` : undefined,
          dedupKey: `schedule.failed:${schedule.id}:TX_REVERTED`,
        },
        config,
        args.logger,
      );
    } else {
      // No tx hash — treat as transient.
      recordScheduleError(schedule.id, nextAt.toISOString(), "INTERNAL_ERROR", "executeTrade returned no tx hash");
      failed += 1;
      fires.push({
        scheduleId: schedule.id,
        name: schedule.name,
        status: "failed",
        errorCode: "INTERNAL_ERROR",
        errorMessage: "no tx hash",
        nextRunAt: nextAt.toISOString(),
      });
    }
  }

  const severity: "ok" | "warn" | "critical" =
    failed > 0 ? "warn" : "ok";
  const recommendedActions: NextAction[] = [];
  if (failed > 0) {
    recommendedActions.push({
      tool: "schedule_list",
      params: { status: "active", limit: 20 },
      reason: `${failed} schedule(s) failed this tick — review last_error_* via \`tradekit schedule list --status active\` and \`tradekit schedule show <id>\`.`,
    });
  }
  return {
    ok: true,
    timestamp: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    severity,
    due: due.length,
    fired,
    failed,
    completed,
    skipped,
    fires,
    recommendedActions,
  };
}

// ── re-exports ───────────────────────────────────────────────

export { listSchedules, getScheduleById, scheduleCountsByStatus };
