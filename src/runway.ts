/**
 * Funding runway — proactive "will my automation run out of money?"
 *
 * The most common automation failure is discovered at the worst
 * moment: a schedule fires, the balance is short, and the operator
 * learns from a `schedule.fire_failed` notification — reactive,
 * repeated (every subsequent fire fails too), and often at 3am.
 *
 * This module turns that into a forecast. It walks every ACTIVE
 * schedule's upcoming cron occurrences (respecting end_at and the
 * max_runs budget), reserves the one-shot spend of every ACTIVE
 * order, and replays them chronologically against the CURRENT
 * balance of each spend token: "your USDC covers 3 more DCA fires;
 * it runs out on Thursday."
 *
 * Spend-token accounting is price-free and exact:
 *   buy  → spends the QUOTE token (quote_amount per fire)
 *   sell → spends the BASE token (base_amount per fire)
 * Primitives sized in the OPPOSITE denomination (a buy specified in
 * base_amount) have an unknowable spend without a price oracle —
 * they are listed in `skipped` rather than silently guessed.
 *
 * Rebalance plans are intentionally OUT of scope: their trades are
 * drift-dependent (unknowable ahead of time) and sells-first legs
 * fund their own buys — they don't have a fixed burn rate. Their
 * failure mode is covered by drift alerts + fire notifications.
 *
 * Balances come from a pluggable fetcher: the paper book for paper
 * primitives, on-chain balanceOf for real ones. Buckets are keyed
 * (account, chain, paper, token) — a paper DCA never counts against
 * the real wallet and vice versa.
 */

import { listOrders, listSchedules, getPaperBalance, recentGasStats, type OrderRow, type ScheduleRow } from "./db.js";
import { parseCron, nextRun } from "./cron.js";
import { loadConfig, resolveProfile, type Config } from "./config.js";
import { ToolError } from "./errors.js";

// ── types ───────────────────────────────────────────────────

/** One recurring or one-shot spend commitment. */
export interface RunwayObligation {
  kind: "schedule" | "order";
  id: number;
  name: string | null;
  strategy: string | null;
  /** Decimal spend per fire (schedules) or total (orders). */
  amountPerFire: number;
  /** Schedules only: the cron driving the recurrence. */
  cron: string | null;
}

/** A primitive whose spend can't be computed without a price. */
export interface RunwaySkipped {
  kind: "schedule" | "order";
  id: number;
  reason: string;
}

/** Runway verdict for one (account, chain, paper, token) bucket. */
export interface TokenRunwayBucket {
  account: string;
  chain: string;
  paper: boolean;
  /** Canonical spend token: "native" or the lowercase ERC20 address. */
  token: string;
  symbol: string | null;
  /** Current balance in token units. null = fetch failed (verdict "unknown"). */
  balance: number | null;
  /** Sum of one-shot order spends — reserved up-front because an
   *  order can fire at any moment. */
  oneShotReserved: number;
  /** Recurring spend per 30 days, from the occurrence walk. */
  burn30d: number;
  /** Fires inside the horizon across all schedules in the bucket. */
  totalFiresInHorizon: number;
  /** How many of those fires the current balance covers (after the
   *  one-shot reserve). Equal to totalFiresInHorizon when nothing
   *  runs dry inside the horizon. */
  firesCovered: number;
  /** Projected instant the balance goes negative. null = survives
   *  the whole horizon. */
  exhaustsAt: string | null;
  /** Days from now until exhaustsAt. null when exhaustsAt is null. */
  runwayDays: number | null;
  obligations: RunwayObligation[];
}

/** v34.5: gas-runway verdict for one (account, chain) — REAL
 *  primitives only (paper fires burn no gas). The walk reuses the
 *  same cron occurrence merge as token buckets, charging the
 *  historical average gas per fire at every upcoming schedule
 *  occurrence, with active orders reserved one-shot. Rebalance
 *  evaluations are excluded (0..N legs per occurrence — unknowable).
 *  NOTE: this is an ESTIMATE — gas prices move; treat exhaustsAt as
 *  order-of-magnitude. Native SELL schedules also appear as a token
 *  bucket ("native" spend); the two views share one balance but are
 *  reported independently. */
export interface GasRunwayBucket {
  account: string;
  chain: string;
  /** Native balance. null = fetch failed. */
  balance: number | null;
  /** Historical average gas per fire. null = no priced trade history
   *  on this (chain, account) — no estimate is attempted. */
  avgGasPerFire: number | null;
  gasSamples: number;
  /** Real fires in the horizon (schedules) + one-shot orders reserved. */
  totalFiresInHorizon: number;
  oneShotOrders: number;
  firesCovered: number;
  exhaustsAt: string | null;
  runwayDays: number | null;
}

export interface RunwayReport {
  generatedAt: string;
  horizonDays: number;
  buckets: TokenRunwayBucket[];
  /** v34.5: per-(account, chain) native-gas forecast for REAL
   *  primitives. Empty when no real schedules/orders exist. */
  gas: GasRunwayBucket[];
  skipped: RunwaySkipped[];
}

/** Pluggable balance source. `token` is canonical ("native" |
 *  lowercase address). Return null on fetch failure — the bucket is
 *  reported with verdict "unknown" instead of poisoning the report. */
export type RunwayBalanceFetcher = (args: {
  account: string;
  chain: string;
  token: string;
  paper: boolean;
}) => Promise<{ amount: number; symbol?: string | null } | null>;

// ── token canonicalization ──────────────────────────────────

const NATIVE_FORMS = new Set(["eth", "native"]);

/** Schedules/orders store base_token as "ETH" sentinel or an address;
 *  quote_token is always an address. Canonicalize for bucket keys. */
export function canonicalSpendToken(raw: string): string {
  if (NATIVE_FORMS.has(raw.toLowerCase())) return "native";
  return raw.toLowerCase();
}

// ── obligation collection (pure) ────────────────────────────

interface SpendSide {
  token: string;
  symbol: string | null;
  amount: number | null;
}

function spendOf(row: Pick<ScheduleRow, "side" | "base_token" | "base_symbol" | "quote_token" | "quote_symbol" | "base_amount" | "quote_amount">): SpendSide {
  if (row.side === "buy") {
    return {
      token: row.quote_token,
      symbol: row.quote_symbol,
      amount: row.quote_amount != null ? parseFloat(row.quote_amount) : null,
    };
  }
  return {
    token: row.base_token,
    symbol: row.base_symbol,
    amount: row.base_amount != null ? parseFloat(row.base_amount) : null,
  };
}

// ── occurrence walk (pure) ──────────────────────────────────

interface ScheduleStream {
  obligation: RunwayObligation;
  /** Mutable cursor: next occurrence time. */
  nextAt: Date;
  parsed: ReturnType<typeof parseCron>;
  /** Remaining successful fires the max_runs budget allows. Infinity
   *  when unbounded. */
  remainingRuns: number;
  endAt: Date | null;
}

export interface RunwayWalkResult {
  totalFiresInHorizon: number;
  firesCovered: number;
  exhaustsAt: string | null;
  runwayDays: number | null;
  burn30d: number;
}

/** Chronological merge-walk of every schedule's upcoming fires in
 *  the bucket. `startBalance` is the balance AFTER subtracting the
 *  one-shot order reserve. Exported for direct unit testing. */
export function walkRunway(args: {
  schedules: Array<{
    obligation: RunwayObligation;
    cron: string;
    nextRunAt: string;
    endAt: string | null;
    remainingRuns: number; // Infinity when unbounded
  }>;
  startBalance: number;
  now: Date;
  horizonDays: number;
}): RunwayWalkResult {
  const { now, horizonDays } = args;
  const horizonEnd = new Date(now.getTime() + horizonDays * 86_400_000);
  const FIRE_CAP = 2000; // runaway guard: a 1m-cron schedule over 90d is ~129k fires — cap, don't hang

  const streams: ScheduleStream[] = args.schedules
    .filter((s) => s.remainingRuns > 0)
    .map((s) => {
      const parsed = parseCron(s.cron);
      // A past-due next_run_at fires "now" (the engine is about to
      // pick it up); future ones fire on schedule.
      const firstAt = new Date(Math.max(Date.parse(s.nextRunAt), now.getTime()));
      return {
        obligation: s.obligation,
        nextAt: firstAt,
        parsed,
        remainingRuns: s.remainingRuns,
        endAt: s.endAt ? new Date(s.endAt) : null,
      };
    })
    .filter((s) => s.endAt == null || s.nextAt <= s.endAt);

  let remaining = args.startBalance;
  let fires = 0;
  let covered = 0;
  let exhaustsAt: string | null = remaining < 0 ? now.toISOString() : null;
  let spent30d = 0;
  const burnWindowEnd = new Date(now.getTime() + 30 * 86_400_000);

  while (streams.length > 0 && fires < FIRE_CAP) {
    // Pick the earliest stream.
    let idx = 0;
    for (let i = 1; i < streams.length; i++) {
      if (streams[i].nextAt < streams[idx].nextAt) idx = i;
    }
    const s = streams[idx];
    if (s.nextAt > horizonEnd) break;

    fires += 1;
    remaining -= s.obligation.amountPerFire;
    if (s.nextAt <= burnWindowEnd) spent30d += s.obligation.amountPerFire;
    if (remaining >= 0) {
      covered += 1;
    } else if (exhaustsAt == null) {
      exhaustsAt = s.nextAt.toISOString();
    }

    // Advance the cursor.
    s.remainingRuns -= 1;
    const next = nextRun(s.parsed, s.nextAt);
    if (s.remainingRuns <= 0 || (s.endAt != null && next > s.endAt)) {
      streams.splice(idx, 1);
    } else {
      s.nextAt = next;
    }
  }

  const runwayDays = exhaustsAt == null
    ? null
    : Math.max(0, (Date.parse(exhaustsAt) - now.getTime()) / 86_400_000);

  return {
    totalFiresInHorizon: fires,
    firesCovered: covered,
    exhaustsAt,
    runwayDays,
    burn30d: spent30d,
  };
}

// ── report assembly ─────────────────────────────────────────

export interface ComputeRunwayArgs {
  chain?: string;
  account?: string;
  /** Exact strategy tag filter — scopes the forecast to one
   *  strategy's own primitives (used by the funding_runway alert). */
  strategy?: string;
  horizonDays?: number;
  balanceFetcher: RunwayBalanceFetcher;
  /** Historical gas estimator (test seam). Defaults to db
   *  recentGasStats. Return null = no estimate. */
  gasStatsFn?: (chain: string, account: string) => { avgGasNative: number; samples: number } | null;
  now?: Date;
}

export async function computeFundingRunway(args: ComputeRunwayArgs): Promise<RunwayReport> {
  const now = args.now ?? new Date();
  const horizonDays = args.horizonDays ?? 90;
  if (!(horizonDays > 0) || horizonDays > 366) {
    throw new ToolError("INVALID_PARAMS", `horizonDays must be in (0, 366] (got ${horizonDays}).`);
  }

  const schedules = listSchedules({ status: "active", chain: args.chain, account: args.account, strategy: args.strategy });
  const orders = listOrders({ status: "active", chain: args.chain, account: args.account, strategy: args.strategy });

  const skipped: RunwaySkipped[] = [];

  interface BucketAccum {
    account: string;
    chain: string;
    paper: boolean;
    token: string;
    symbol: string | null;
    oneShot: number;
    schedules: Array<{
      obligation: RunwayObligation;
      cron: string;
      nextRunAt: string;
      endAt: string | null;
      remainingRuns: number;
    }>;
    obligations: RunwayObligation[];
  }
  const buckets = new Map<string, BucketAccum>();

  const bucketFor = (row: { account: string; chain: string }, paper: boolean, spend: SpendSide): BucketAccum => {
    const token = canonicalSpendToken(spend.token);
    const key = `${row.account} ${row.chain.toLowerCase()} ${paper ? 1 : 0} ${token}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        account: row.account,
        chain: row.chain.toLowerCase(),
        paper,
        token,
        symbol: spend.symbol,
        oneShot: 0,
        schedules: [],
        obligations: [],
      };
      buckets.set(key, b);
    }
    if (b.symbol == null && spend.symbol != null) b.symbol = spend.symbol;
    return b;
  };

  for (const s of schedules) {
    if (s.id == null) continue;
    const spend = spendOf(s);
    if (spend.amount == null || !Number.isFinite(spend.amount)) {
      skipped.push({
        kind: "schedule",
        id: s.id,
        reason: `${s.side} sized in the opposite denomination — spend per fire needs a price; excluded from runway math`,
      });
      continue;
    }
    const remainingRuns = s.max_runs != null ? Math.max(0, s.max_runs - s.run_count) : Infinity;
    const obligation: RunwayObligation = {
      kind: "schedule",
      id: s.id,
      name: s.name,
      strategy: s.strategy,
      amountPerFire: spend.amount,
      cron: s.cron_expr,
    };
    const b = bucketFor(s, (s.paper ?? 0) === 1, spend);
    b.obligations.push(obligation);
    b.schedules.push({
      obligation,
      cron: s.cron_expr,
      nextRunAt: s.next_run_at,
      endAt: s.end_at,
      remainingRuns,
    });
  }

  for (const o of orders) {
    if (o.id == null) continue;
    const spend = spendOf({
      side: o.side,
      base_token: o.base_token,
      base_symbol: o.base_symbol,
      quote_token: o.quote_token,
      quote_symbol: o.quote_symbol,
      base_amount: o.base_amount,
      quote_amount: o.quote_amount,
    });
    if (spend.amount == null || !Number.isFinite(spend.amount)) {
      skipped.push({
        kind: "order",
        id: o.id,
        reason: `${o.side} sized in the opposite denomination — spend needs a price; excluded from runway math`,
      });
      continue;
    }
    const obligation: RunwayObligation = {
      kind: "order",
      id: o.id,
      name: null,
      strategy: o.strategy,
      amountPerFire: spend.amount,
      cron: null,
    };
    const b = bucketFor(o, (o.paper ?? 0) === 1, spend);
    b.obligations.push(obligation);
    b.oneShot += spend.amount;
  }

  const out: TokenRunwayBucket[] = [];
  for (const b of buckets.values()) {
    const fetched = await args.balanceFetcher({
      account: b.account,
      chain: b.chain,
      token: b.token,
      paper: b.paper,
    });
    const balance = fetched?.amount ?? null;
    if (fetched?.symbol != null && b.symbol == null) b.symbol = fetched.symbol;

    let walk: RunwayWalkResult;
    if (balance == null) {
      // Balance unknown — still report the obligations so the
      // operator sees WHAT would burn, just not how long it lasts.
      walk = { totalFiresInHorizon: 0, firesCovered: 0, exhaustsAt: null, runwayDays: null, burn30d: 0 };
      const probe = walkRunway({ schedules: b.schedules, startBalance: Number.MAX_SAFE_INTEGER, now, horizonDays });
      walk.totalFiresInHorizon = probe.totalFiresInHorizon;
      walk.burn30d = probe.burn30d;
    } else {
      walk = walkRunway({ schedules: b.schedules, startBalance: balance - b.oneShot, now, horizonDays });
    }

    out.push({
      account: b.account,
      chain: b.chain,
      paper: b.paper,
      token: b.token,
      symbol: b.symbol,
      balance,
      oneShotReserved: b.oneShot,
      burn30d: walk.burn30d,
      totalFiresInHorizon: walk.totalFiresInHorizon,
      firesCovered: walk.firesCovered,
      exhaustsAt: walk.exhaustsAt,
      runwayDays: walk.runwayDays,
      obligations: b.obligations,
    });
  }

  // Deterministic ordering: shortest runway first (the interesting
  // rows), then by account/chain/token for stability.
  out.sort((a, z) => {
    const ra = a.runwayDays ?? Number.POSITIVE_INFINITY;
    const rz = z.runwayDays ?? Number.POSITIVE_INFINITY;
    if (ra !== rz) return ra - rz;
    return `${a.account}/${a.chain}/${a.token}`.localeCompare(`${z.account}/${z.chain}/${z.token}`);
  });

  // ── v34.5 gas buckets ─────────────────────────────────────
  // Every REAL fire burns native gas regardless of the spend token —
  // a wallet flush with USDC but dry of ETH fails every fire. Group
  // real schedules + active orders by (account, chain), estimate
  // per-fire gas from recent trade history, and replay the SAME
  // occurrence stream against the native balance.
  const gasStats = args.gasStatsFn ?? ((c: string, a: string) => recentGasStats(c, a));
  interface GasAccum {
    account: string;
    chain: string;
    schedules: Array<{
      obligation: RunwayObligation;
      cron: string;
      nextRunAt: string;
      endAt: string | null;
      remainingRuns: number;
    }>;
    orders: number;
  }
  const gasGroups = new Map<string, GasAccum>();
  for (const s of schedules) {
    if (s.id == null || (s.paper ?? 0) === 1) continue;
    const key = `${s.account} ${s.chain.toLowerCase()}`;
    let g = gasGroups.get(key);
    if (!g) {
      g = { account: s.account, chain: s.chain.toLowerCase(), schedules: [], orders: 0 };
      gasGroups.set(key, g);
    }
    g.schedules.push({
      obligation: { kind: "schedule", id: s.id, name: s.name, strategy: s.strategy, amountPerFire: 0, cron: s.cron_expr },
      cron: s.cron_expr,
      nextRunAt: s.next_run_at,
      endAt: s.end_at,
      remainingRuns: s.max_runs != null ? Math.max(0, s.max_runs - s.run_count) : Infinity,
    });
  }
  for (const o of orders) {
    if (o.id == null || (o.paper ?? 0) === 1) continue;
    const key = `${o.account} ${o.chain.toLowerCase()}`;
    let g = gasGroups.get(key);
    if (!g) {
      g = { account: o.account, chain: o.chain.toLowerCase(), schedules: [], orders: 0 };
      gasGroups.set(key, g);
    }
    g.orders += 1;
  }

  const gas: GasRunwayBucket[] = [];
  for (const g of gasGroups.values()) {
    const stats = gasStats(g.chain, g.account);
    const fetched = await args.balanceFetcher({ account: g.account, chain: g.chain, token: "native", paper: false });
    const balance = fetched?.amount ?? null;

    if (stats == null || balance == null) {
      // No estimate possible — still report fire counts so the
      // operator sees the exposure even without a verdict.
      const probe = walkRunway({
        schedules: g.schedules.map((s) => ({ ...s, obligation: { ...s.obligation, amountPerFire: 0 } })),
        startBalance: Number.MAX_SAFE_INTEGER,
        now,
        horizonDays,
      });
      gas.push({
        account: g.account,
        chain: g.chain,
        balance,
        avgGasPerFire: stats?.avgGasNative ?? null,
        gasSamples: stats?.samples ?? 0,
        totalFiresInHorizon: probe.totalFiresInHorizon,
        oneShotOrders: g.orders,
        firesCovered: 0,
        exhaustsAt: null,
        runwayDays: null,
      });
      continue;
    }

    const walk = walkRunway({
      schedules: g.schedules.map((s) => ({ ...s, obligation: { ...s.obligation, amountPerFire: stats.avgGasNative } })),
      startBalance: balance - g.orders * stats.avgGasNative,
      now,
      horizonDays,
    });
    gas.push({
      account: g.account,
      chain: g.chain,
      balance,
      avgGasPerFire: stats.avgGasNative,
      gasSamples: stats.samples,
      totalFiresInHorizon: walk.totalFiresInHorizon,
      oneShotOrders: g.orders,
      firesCovered: walk.firesCovered,
      exhaustsAt: walk.exhaustsAt,
      runwayDays: walk.runwayDays,
    });
  }
  gas.sort((a, z) => (a.runwayDays ?? Infinity) - (z.runwayDays ?? Infinity));

  return {
    generatedAt: now.toISOString(),
    horizonDays,
    buckets: out,
    gas,
    skipped,
  };
}

// ── default balance fetcher ─────────────────────────────────

/**
 * Production fetcher: paper buckets read the virtual book; real
 * buckets read on-chain (native getBalance / ERC20 balanceOf via a
 * read-only wallet — no keystore decrypt). Returns null on any
 * failure so one dead RPC degrades a bucket to "unknown" instead of
 * killing the whole report.
 */
export function defaultRunwayBalanceFetcher(config: Config = loadConfig()): RunwayBalanceFetcher {
  return async ({ account, chain, token, paper }) => {
    try {
      if (paper) {
        const { NATIVE_TOKEN } = await import("./tokens.js");
        const lookupKeys = token === "native" ? [NATIVE_TOKEN as string, "ETH"] : [token];
        for (const key of lookupKeys) {
          const row = getPaperBalance(account, chain, key) ?? getPaperBalance(account, chain, key.toLowerCase());
          if (row) return { amount: parseFloat(row.balance) };
        }
        return { amount: 0 }; // empty virtual book is a real answer, not a failure
      }

      const profile = resolveProfile(chain, config);
      const extraRpcs = config.chains[chain]?.rpcs ?? [];
      const { loadReadOnlyWallet } = await import("./wallet.js");
      const wallet = loadReadOnlyWallet(profile, extraRpcs, account);
      const owner = wallet.walletClient.account.address;

      if (token === "native") {
        const raw = await wallet.publicClient.getBalance({ address: owner });
        return { amount: Number(raw) / 1e18 };
      }
      const { getToken } = await import("./tokens.js");
      const { ERC20_ABI } = await import("./constants.js");
      const meta = await getToken(wallet.publicClient, profile, token as `0x${string}`);
      const raw = (await wallet.publicClient.readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [owner],
      })) as bigint;
      return { amount: Number(raw) / 10 ** meta.decimals, symbol: meta.symbol };
    } catch {
      return null;
    }
  };
}
