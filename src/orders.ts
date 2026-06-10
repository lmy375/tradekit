// Conditional/limit orders engine.
//
// Off-chain orders stored in the SQLite `orders` table (db.ts v10). Standing
// intents are polled by `runOrderTick`, which fetches the current USD price
// for each active order's base token, compares against the trigger predicate
// (price_below / price_above), and routes triggered orders through the
// existing `executeTrade` pipeline. Every safety guardrail, audit row, and
// structured-error pathway used by manual trades is inherited verbatim —
// the engine is a thin scheduler, not a parallel trade flow.
//
// Lifecycle (status column):
//   active   → engine evaluates every tick
//   filled   → executeTrade returned success; fill_tx_hash + fill_price stamped
//   cancelled → operator cancelled
//   expired  → expires_at passed without firing
//   failed   → executeTrade reverted or threw a terminal (non-retryable) error
//
// Why off-chain rather than on-chain limit orders (1inch, CowSwap, etc.):
// on-chain protocols require EIP-712 typed-data signing, allowance flows
// tuned to a specific maker contract, and they each have their own fee
// model. Off-chain orders compose naturally with tradekit's aggregator-first
// trade flow — the operator gets the same routing on a triggered limit as
// on a manual swap. The trade-off: the engine must be running (cron job,
// daemon, web mode, MCP) for orders to fire — this is documented in the
// CLI/MCP tool descriptions.

import type { Address, PublicClient, WalletClient, Account, Transport, Chain } from "viem";
import { ToolError, type NextAction } from "./errors.js";
import { executeTrade, type TradeRequest, type TradeContext, type TradeResult } from "./trade.js";
import { executePaperTrade, type PaperTradeContext } from "./paperTrade.js";
import { resolveTradePair } from "./chains.js";
import { resolveProfile, type Config } from "./config.js";
import { loadConfig } from "./config.js";
import { getCurrentPrice } from "./price.js";
import { getCurrentPrices } from "./priceBatch.js";
import {
  insertOrder,
  getOrderById,
  listOrders,
  activeOrders,
  recordOrderCheck,
  markOrderFilled,
  markOrderFailed,
  markOrderExpired,
  cancelOrder as dbCancelOrder,
  cancelOcoPeers,
  setOrderError,
  orderCountsByStatus,
  type OrderRow,
  type OrderStatus,
  type OrderSide,
  type OrderTrigger,
  type InsertOrderArgs,
  type OrderFilter,
} from "./db.js";
import type { Logger } from "./logger.js";
import type { ChainProfile } from "./chains.js";
import { loadWallet, loadReadOnlyWallet } from "./wallet.js";
import { tryNotify } from "./notify.js";
import {
  evaluateTrailingTrigger,
  validateTrailingCreate,
} from "./trailingStop.js";

export type { OrderRow, OrderStatus, OrderSide, OrderTrigger, OrderFilter } from "./db.js";

// ── notification helpers ─────────────────────────────────────
//
// Built once per emit-point so the orders engine has a uniform event shape
// across order.filled / failed / expired. Best-effort: failures land in the
// logger and never bubble out of the engine tick.

function orderExplorerUrl(order: OrderRow, profile: ChainProfile, txHash: string | null | undefined): string | undefined {
  if (!txHash) return undefined;
  return `${profile.explorer}/tx/${txHash}`;
}

function summarizeIntent(order: OrderRow): string {
  if (order.base_amount) {
    return `${order.side} ${order.base_amount} ${order.base_symbol ?? "base"}`;
  }
  if (order.quote_amount) {
    return `${order.side} ${order.base_symbol ?? "base"} for ${order.quote_amount} ${order.quote_symbol ?? "quote"}`;
  }
  return order.side;
}

function summarizeTrigger(order: OrderRow): string {
  const sym = order.base_symbol ?? "base";
  if (order.trigger_type === "trailing") {
    // Trailing fires when the price retraces by trail_pct from the
    // water mark. When the water mark is set, name it. Otherwise show
    // the activation gate or just the trail %.
    const trail = order.trail_pct ?? 0;
    if (order.water_mark_usd != null) {
      const dir = order.side === "sell" ? "from HWM" : "from LWM";
      return `${sym} trailing ${trail}% ${dir} $${order.water_mark_usd.toFixed(4)}`;
    }
    if (order.target_price_usd != null) {
      const dir = order.side === "sell" ? "above" : "below";
      return `${sym} trailing ${trail}% (activates ${dir} $${order.target_price_usd})`;
    }
    return `${sym} trailing ${trail}%`;
  }
  const cmp = order.trigger_type === "price_below" ? "≤" : "≥";
  return `${sym} ${cmp} $${order.target_price_usd}`;
}

/**
 * OCO cascade helper: when `firedOrder` has a group_id and just transitioned
 * to a terminal state via the ENGINE, cancel its active peers + emit one
 * notification per cancelled peer. No-op when group_id is null or no peers
 * are active.
 *
 * The cascade is intentionally NOT recursive — `cancelled` is not a state
 * the engine cascades from (only filled/failed/expired do). So a 3-way
 * group with order #1 firing cancels #2 + #3 in one pass; cancelling
 * #2/#3 themselves does NOT then try to cancel #1 (which is already
 * terminal anyway).
 *
 * Reason: `OCO_PEER_FIRED` stamped on each cancelled peer's last_error_code
 * for forensic visibility — `tradekit order show <id>` surfaces this so
 * operators understand WHY a peer was cancelled without having to trace
 * the audit log.
 */
async function cascadeOcoIfApplicable(
  firedOrder: OrderRow,
  config: import("./config.js").Config,
  logger: Logger,
  context: { firedAs: "filled" | "failed" | "expired"; firedReason?: string },
): Promise<void> {
  if (!firedOrder.group_id || firedOrder.id == null) return;
  const { cancelOcoPeers } = await import("./db.js");
  const reasonMsg = `Order #${firedOrder.id} (group ${firedOrder.group_id}) ${context.firedAs}; OCO peer cancelled.`;
  const cancelledIds = cancelOcoPeers(firedOrder.id, firedOrder.group_id, "OCO_PEER_FIRED", reasonMsg);
  if (cancelledIds.length === 0) return;
  logger.info(
    `OCO cascade: order #${firedOrder.id} ${context.firedAs} → cancelled ${cancelledIds.length} peer(s) in group "${firedOrder.group_id}": ${cancelledIds.join(", ")}`,
  );
  // One notification per cancelled peer — operators consuming Slack
  // notifications often filter by event type; bundling N cancellations
  // into one event would either hide them all behind one filter rule or
  // require the operator to write custom payload parsing. Individual
  // events are more uniform.
  for (const peerId of cancelledIds) {
    await tryNotify(
      {
        event: "order.cancelled_oco",
        severity: "info",
        title: `Order #${peerId} cancelled by OCO peer #${firedOrder.id}`,
        body: `OCO group "${firedOrder.group_id}": peer #${firedOrder.id} ${context.firedAs}${context.firedReason ? ` (${context.firedReason})` : ""}. This order was auto-cancelled because the engine fired a sibling.`,
        fields: {
          cancelledOrderId: peerId,
          firedOrderId: firedOrder.id,
          firedAs: context.firedAs,
          groupId: firedOrder.group_id,
          firedReason: context.firedReason,
        },
        // One dedup key per (cancelled peer, fired sibling) pair — so a
        // sibling firing twice (shouldn't happen, but defensive) doesn't
        // double-alert; the cancelled-peer's terminal state guarantees
        // only one cascade ever lands per peer.
        dedupKey: `order.cancelled_oco:${peerId}:${firedOrder.id}`,
      },
      config,
      logger,
    );
  }
}

// ── duration parsing ─────────────────────────────────────────

/**
 * Parse a human-friendly duration string (e.g. `30s`, `15m`, `2h`, `7d`,
 * `4w`) into a Date that is `now + duration`. Returns null for invalid
 * input. The supported unit set is deliberately tight — operators specifying
 * `--expires-in 1mo` (ambiguous: month or minute?) get an explicit error
 * rather than a silent surprise.
 *
 * Exported for the CLI flag-parser and direct MCP callers; unit-testable
 * without booting the engine.
 */
export function parseDurationToDate(raw: string, now: Date = new Date()): Date | null {
  const m = /^(\d+(?:\.\d+)?)([smhdw])$/i.exec(raw.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const MS: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const ms = n * MS[unit];
  // Guard against absurd durations producing Infinity dates.
  if (!Number.isFinite(ms) || ms > 10 * 365 * 86_400_000) return null;
  return new Date(now.getTime() + ms);
}

// ── trigger predicate ────────────────────────────────────────

/**
 * Pure predicate: given a current price + order, return whether the trigger
 * is satisfied. Splitting this out makes the engine logic unit-testable
 * without standing up the RPC + executeTrade stack.
 *
 * `null` current price = "we couldn't price it" — never triggers. The engine
 * records that case via setOrderError so the operator can see it.
 */
export function isOrderTriggered(order: Pick<OrderRow, "trigger_type" | "target_price_usd">, currentPriceUsd: number | null): boolean {
  if (currentPriceUsd == null) return false;
  if (!Number.isFinite(currentPriceUsd) || currentPriceUsd <= 0) return false;
  // price_below / price_above triggers require target_price_usd populated —
  // createOrderRow validates this. Guard defensively so a forced row with
  // NULL target doesn't crash the engine.
  if (order.target_price_usd == null) return false;
  if (order.trigger_type === "price_below") return currentPriceUsd <= order.target_price_usd;
  if (order.trigger_type === "price_above") return currentPriceUsd >= order.target_price_usd;
  // Trailing orders have their own predicate in trailingStop.ts — this
  // helper intentionally returns false for them so the engine can route
  // through the dedicated path.
  return false;
}

/** Pure predicate: has the order's expiry window passed? */
export function isOrderExpired(order: Pick<OrderRow, "expires_at">, now: Date = new Date()): boolean {
  if (!order.expires_at) return false;
  const t = Date.parse(order.expires_at);
  if (!Number.isFinite(t)) return false;
  return now.getTime() >= t;
}

// ── creation ─────────────────────────────────────────────────

export interface CreateOrderArgs {
  /** "buy" the base token (spending quote), or "sell" base (receiving quote). */
  side: OrderSide;
  /** "price_below" or "price_above" — see OrderTrigger doc. */
  trigger: OrderTrigger;
  /** Target USD price of the base token; the predicate fires when the live
   *  CoinGecko/DexScreener price crosses it. */
  /** Required for price_below / price_above; OPTIONAL for trailing
   *  (activation gate — null means "trail from creation"). */
  targetPriceUsd?: number;
  /** Required for `trigger: "trailing"`. % retracement that fires the
   *  order (e.g. 5 = 5%). Range (0, 100]. */
  trailPct?: number;
  chain: string;
  account: string;
  /** Resolved base token address (or "ETH" / "NATIVE" for the chain's native). */
  base: Address | "ETH";
  /** Resolved quote token address. */
  quote: Address;
  baseAmount?: string;
  quoteAmount?: string;
  slippageBps?: number;
  autoSlippage?: boolean;
  /** ISO-8601 timestamp at which the order expires unfired. */
  expiresAt?: string;
  strategy?: string;
  note?: string;
  /** OCO (One-Cancels-Other) group identifier. When set, this order
   *  becomes a peer of any existing orders sharing the same string.
   *  When ANY group peer transitions to a terminal state via the engine
   *  (filled/failed/expired), the engine cancels the remaining active
   *  peers — auto-cleanup for entry+exit-bracket and ladder patterns.
   *  Pattern: alphanumeric / dash / underscore, ≤ 64 chars. */
  group?: string;
  /** Iter30: when true the order fires against the virtual book
   *  instead of executing on-chain. Triggers still tick (price polling
   *  / watermark / expiry / OCO cascade); only the terminal FIRE step
   *  differs. Defaults to false. */
  paper?: boolean;
}

/** Resolve display symbols for the base/quote pair so list views can show
 *  human-readable labels without an RPC roundtrip per row. profile.tokens is
 *  symbol → address; we invert that lookup once per call (cheap — chain
 *  profiles have <20 entries). Best-effort: returns null for any address
 *  not on the chain's well-known token list. */
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
 * Create a new conditional order. Validates the request shape, resolves token
 * symbols, and inserts the row. Returns the full OrderRow as stored so the
 * caller can echo the assigned id back to the operator.
 *
 * Validation is strict — invalid args throw ToolError("INVALID_PARAMS")
 * before anything is persisted:
 *   - exactly one of baseAmount / quoteAmount
 *   - targetPriceUsd > 0
 *   - expiresAt (if set) is in the future
 *   - side / trigger are recognized literals
 */
export function createOrderRow(args: CreateOrderArgs, config: Config = loadConfig()): OrderRow {
  if (args.side !== "buy" && args.side !== "sell") {
    throw new ToolError("INVALID_PARAMS", `side must be "buy" or "sell" (got "${args.side}").`);
  }
  if (args.trigger !== "price_below" && args.trigger !== "price_above" && args.trigger !== "trailing") {
    throw new ToolError(
      "INVALID_PARAMS",
      `trigger must be "price_below", "price_above", or "trailing" (got "${args.trigger}").`,
    );
  }
  // Trigger-specific validation. Price-based triggers require
  // targetPriceUsd; trailing requires trailPct and accepts targetPriceUsd
  // as an optional activation gate.
  let trail_pct: number | null = null;
  let target_price_usd_resolved: number | null = null;
  if (args.trigger === "trailing") {
    // Delegate to the trailingStop validator so the rules live in one
    // place (and the activation gate's interaction with side is checked
    // structurally there). The validator does NOT require targetPriceUsd
    // — passing it through enables the optional activation gate.
    const v = validateTrailingCreate({
      side: args.side,
      trailPct: args.trailPct,
      activationPriceUsd: args.targetPriceUsd,
    });
    trail_pct = v.trail_pct;
    target_price_usd_resolved = v.target_price_usd;
  } else {
    if (args.targetPriceUsd == null || !Number.isFinite(args.targetPriceUsd) || args.targetPriceUsd <= 0) {
      throw new ToolError(
        "INVALID_PARAMS",
        `targetPriceUsd must be a positive number for ${args.trigger} triggers (got ${args.targetPriceUsd}).`,
      );
    }
    if (args.trailPct != null) {
      throw new ToolError(
        "INVALID_PARAMS",
        `trailPct is only meaningful with trigger="trailing"; omit it for ${args.trigger} triggers.`,
      );
    }
    target_price_usd_resolved = args.targetPriceUsd;
  }
  const hasBase = args.baseAmount != null && args.baseAmount !== "";
  const hasQuote = args.quoteAmount != null && args.quoteAmount !== "";
  if (hasBase === hasQuote) {
    throw new ToolError(
      "INVALID_PARAMS",
      "Specify exactly one of baseAmount / quoteAmount (matches the trade quote contract — the other side is derived at fill time from the live quote).",
    );
  }
  if (args.slippageBps != null && (!Number.isInteger(args.slippageBps) || args.slippageBps <= 0 || args.slippageBps > 10_000)) {
    throw new ToolError("INVALID_PARAMS", `slippageBps must be an integer in (0, 10000] (got ${args.slippageBps}).`);
  }
  if (args.expiresAt) {
    const t = Date.parse(args.expiresAt);
    if (!Number.isFinite(t)) {
      throw new ToolError("INVALID_PARAMS", `expiresAt must be a valid ISO-8601 timestamp (got "${args.expiresAt}").`);
    }
    if (t <= Date.now()) {
      throw new ToolError("INVALID_PARAMS", `expiresAt must be in the future (got "${args.expiresAt}").`);
    }
  }
  // OCO group id validation — operator-supplied string used to link orders
  // into one-cancels-other groups. Tight character class (alphanumeric +
  // dash + underscore) keeps groups grep-friendly + path-safe and avoids
  // surprises like quoting issues in shell scripts.
  let group: string | null = null;
  if (args.group != null && args.group !== "") {
    const trimmed = args.group.trim();
    if (trimmed.length === 0 || trimmed.length > 64) {
      throw new ToolError("INVALID_PARAMS", `group must be 1-64 chars (got ${trimmed.length}).`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
      throw new ToolError(
        "INVALID_PARAMS",
        `group must match /^[A-Za-z0-9_-]+$/ (got "${args.group}"). Use only letters, digits, dash, or underscore.`,
      );
    }
    group = trimmed;
  }
  const profile = resolveProfile(args.chain, config);
  // Re-resolve the pair so we error early on UNKNOWN_TOKEN even when the
  // caller passed an alias. resolveTradePair canonicalizes to Address-typed
  // values matching what the engine will execute later.
  const { base, quote } = resolveTradePair(profile, args.base, args.quote);
  const { baseSym, quoteSym } = resolveSymbols(profile, base, quote);

  const insertArgs: InsertOrderArgs = {
    side: args.side,
    trigger_type: args.trigger,
    // target_price_usd: for price_below/above this is the trigger
    // threshold; for trailing it's the optional activation gate (null
    // when "trail from creation").
    target_price_usd: target_price_usd_resolved,
    trail_pct,
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
    expires_at: args.expiresAt ?? null,
    strategy: args.strategy ?? null,
    note: args.note ?? null,
    group_id: group,
    paper: args.paper === true,
  };
  const id = insertOrder(insertArgs);
  const row = getOrderById(id);
  if (!row) {
    // Defensive — insertOrder just returned the rowid.
    throw new ToolError("INTERNAL_ERROR", `Order ${id} disappeared immediately after insert.`);
  }
  return row;
}

// ── cancellation / inspection ───────────────────────────────

/** Operator-initiated cancel. Wraps db.cancelOrder with the proper structured
 *  errors so CLI / MCP callers get a uniform shape.
 *
 *  Cascade semantics: by default, manual cancel does NOT cancel OCO peers
 *  (a manual cancel is an intentional act; cascading would surprise an
 *  operator updating one leg). Pass `cascade: true` to opt into cancelling
 *  the rest of the group at the same time. Peers cancelled this way carry
 *  reason `OCO_OPERATOR_CASCADE` (distinct from the engine-driven
 *  `OCO_PEER_FIRED` for forensic visibility).
 *
 *  Returns the cancelled OrderRow. The `cascadedPeerIds` field (when present)
 *  carries the IDs of any peers that were also cancelled.
 */
export function cancelOrderById(
  id: number,
  opts: { cascade?: boolean } = {},
): OrderRow & { cascadedPeerIds?: number[] } {
  const existing = getOrderById(id);
  if (!existing) {
    throw new ToolError("INVALID_PARAMS", `Order #${id} not found.`, {
      details: { orderId: id },
    });
  }
  const r = dbCancelOrder(id);
  if (r === -1) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Order #${id} is already ${existing.status} — cannot cancel a terminal-state order.`,
      { details: { orderId: id, currentStatus: existing.status } },
    );
  }
  let cascadedPeerIds: number[] = [];
  if (opts.cascade && existing.group_id) {
    // Re-use the same cascade helper used by the engine, but tagged with
    // the operator-cascade reason so forensic queries can distinguish
    // "the engine pulled this peer" vs "the operator pulled the group".
    // Synchronous (DB-only) call — no notifications fire for operator
    // cascade since the operator initiated it intentionally; the audit
    // log + last_error_code on each peer is the trail.
    cascadedPeerIds = cancelOcoPeers(
      id,
      existing.group_id,
      "OCO_OPERATOR_CASCADE",
      `Operator cancelled order #${id} (group ${existing.group_id}) with --cascade.`,
    );
  }
  const after = getOrderById(id);
  const row = after ?? existing;
  return cascadedPeerIds.length > 0
    ? { ...row, cascadedPeerIds }
    : row;
}

// ── engine tick ──────────────────────────────────────────────

export interface OrderTickArgs {
  /** Restrict the scan to one chain. Default: all chains with active orders. */
  chain?: string;
  /** Restrict the scan to one account. Default: all accounts. */
  account?: string;
  /** Resolved wallet password (required when an order would be FILLED — read-
   *  only ticks that only do price checks don't need it). */
  password?: string;
  /** When true, evaluate triggers + record price observations but do NOT
   *  send any trades. Useful for cron mode in `--dry-run` audits, and for
   *  the engine's "look but don't touch" preview. */
  dryRun?: boolean;
  logger: Logger;
}

export interface OrderTickFillReport {
  orderId: number;
  status: "filled" | "failed" | "skipped";
  /** Price observed at trigger time. Always populated for fills/failures;
   *  may be null for skipped (e.g. unpriceable token). */
  observedPriceUsd: number | null;
  /** Trade tx hash (success path only). */
  txHash?: string;
  /** Error code for failed/skipped fills. */
  errorCode?: string;
  errorMessage?: string;
}

export interface OrderTickReport {
  ok: true;
  timestamp: string;
  /** Wall-clock for the full tick. */
  elapsedMs: number;
  /** 'ok' when no terminal failures; 'warn' when ≥1 transient error; 'critical'
   *  when ≥1 terminal (failed) trade fired. */
  severity: "ok" | "warn" | "critical";
  scanned: number;
  triggered: number;
  filled: number;
  failedCount: number;
  expiredCount: number;
  transientErrorCount: number;
  /** Per-order fill outcomes for the orders that triggered this tick. Skipped
   *  rows (price unknown, etc.) are also surfaced so a watching operator can
   *  see why a near-triggering row didn't fire. */
  fills: OrderTickFillReport[];
  /** NextAction[] dispatch — empty when severity='ok'. */
  recommendedActions: NextAction[];
}

/**
 * Run a single order-evaluation tick. Walks all active orders matching the
 * filter, prices each base token, evaluates the trigger, and routes triggered
 * orders through executeTrade. All errors are caught + recorded — a single
 * bad row never kills the tick.
 *
 * This is the unit the CLI `order run` and the MCP `order_run` tool both
 * call. CLI watch-mode loops it; MCP exposes it for cron-like agent loops.
 */
export async function runOrderTick(args: OrderTickArgs): Promise<OrderTickReport> {
  const startedAt = Date.now();
  const orders = activeOrders({ chain: args.chain, account: args.account });
  const fills: OrderTickFillReport[] = [];
  let transientErrors = 0;
  let filled = 0;
  let failed = 0;
  let expired = 0;
  let triggered = 0;

  // Group orders by (chain, account) so we open one wallet per group. Each
  // tick that fires a real trade decrypts the keystore once per account —
  // amortizes the scrypt cost across many orders for the same account.
  // For dry-run (read-only) ticks we don't decrypt at all.
  const config = loadConfig();

  // Walk in deterministic id order so tick output is reproducible.
  orders.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

  // Iter38: prefetch every distinct base-token price in ONE batch
  // before iterating. Pre-iter38 a cache-cold tick with 15 distinct
  // tokens made 15 sequential HTTP calls; the batch path collapses
  // CoinGecko-mapped tokens into a single `/simple/price?ids=...`
  // call and parallelizes DexScreener fallback. After this call
  // returns, the per-order `getCurrentPrice` inside the loop is a
  // pure cache hit. This is the single biggest scalability win for
  // operators running 5+ deployed strategies on CoinGecko free tier.
  const distinctPriceTargets = new Set<string>();
  for (const o of orders) {
    if (o.base_token === "ETH" || o.base_token === "NATIVE") {
      const profile = resolveProfile(o.chain, config);
      distinctPriceTargets.add(profile.weth.toLowerCase());
    } else {
      distinctPriceTargets.add(o.base_token.toLowerCase());
    }
  }
  if (distinctPriceTargets.size > 0) {
    try {
      // Best-effort. Errors here are non-fatal: the per-order
      // `getCurrentPrice` inside the loop will fall back to its
      // own provider chain. Prefetch just primes the cache.
      await getCurrentPrices(Array.from(distinctPriceTargets), args.logger);
    } catch (e) {
      args.logger.debug(`order tick: price prefetch failed: ${(e as Error).message}`);
    }
  }

  // Lazy wallet cache: key = `${chain}:${account}` → loaded TradeContext (sans
  // logger, which we add per-call). We only build the context when a row
  // actually triggers — most ticks evaluate triggers and find them unmet,
  // so we shouldn't pay the wallet-load cost on a no-op tick.
  type Built = { profile: ChainProfile; publicClient: PublicClient<Transport, Chain>; walletClient: WalletClient<Transport, Chain, Account>; label: string };
  const built = new Map<string, Built>();

  async function ensureWallet(chain: string, account: string, opts: { readOnly?: boolean } = {}): Promise<Built> {
    // Paper orders use the same cache namespace — they only need a
    // publicClient, and the read-only walletClient that
    // loadReadOnlyWallet returns is harmless (signing methods exist
    // but executePaperTrade never calls them).
    const key = `${chain}:${account}`;
    const cached = built.get(key);
    if (cached) return cached;
    const profile = resolveProfile(chain, config);
    const extraRpcs = config.chains[chain]?.rpcs ?? [];
    const wallet = args.dryRun || opts.readOnly || !args.password
      ? loadReadOnlyWallet(profile, extraRpcs, account)
      : await loadWallet(args.password, profile, extraRpcs, args.logger, account);
    const ctx: Built = {
      profile,
      publicClient: wallet.publicClient,
      walletClient: wallet.walletClient,
      label: wallet.label,
    };
    built.set(key, ctx);
    return ctx;
  }

  // Iter25 journal config — hoisted out of the loop so EVERY per-order
  // path (including the expiry retirement that runs before the price
  // fetch) can record. Cheap no-op when the feature is disabled.
  const journalConfig = {
    enabled: config.engine.orderJournal.enabled,
    proximityPct: config.engine.orderJournal.proximityPct,
  };
  const journalFor = async (
    order: OrderRow,
    priceUsd: number | null,
    overrides: { fired?: boolean; skipped?: boolean; expired?: boolean; notes?: string; errorMessage?: string } = {},
  ) => {
    if (!journalConfig.enabled) return;
    const { recordCheckEntry, buildObservation } = await import("./orderJournal.js");
    recordCheckEntry({
      observation: buildObservation({
        order, priceUsd, checkedAt: new Date().toISOString(), ...overrides,
      }),
      config: journalConfig,
    });
  };

  // Shared expiry retirement: mark + journal + notify + OCO cascade.
  // Called from BOTH the step-1 pre-price check and the pre-fire
  // re-check (the window between them spans price fetch + keystore
  // decrypt, which can take seconds — an order must not fire after
  // its expires_at even when the trigger matched before it).
  const retireExpired = async (order: OrderRow, priceUsd: number | null) => {
    markOrderExpired(order.id!);
    expired += 1;
    await journalFor(order, priceUsd, { expired: true });
    // Notify: order expired. info severity — expiry is expected, not an
    // alert; operators monitoring at minSeverity=warn won't see this.
    await tryNotify(
      {
        event: "order.expired",
        severity: "info",
        title: `Order #${order.id} expired (${summarizeIntent(order)})`,
        fields: {
          id: order.id,
          chain: order.chain,
          account: order.account,
          trigger: summarizeTrigger(order),
          expiresAt: order.expires_at,
        },
        dedupKey: `order.expired:${order.id}`,
      },
      config,
      args.logger,
    );
    // OCO cascade: an expired peer cancels the rest of its group.
    await cascadeOcoIfApplicable(order, config, args.logger, {
      firedAs: "expired",
      firedReason: `expires_at ${order.expires_at}`,
    });
  };

  for (const order of orders) {
    if (order.id == null) continue;
    // 1) Expiry check — runs even before the price fetch since it's free.
    if (isOrderExpired(order)) {
      await retireExpired(order, null);
      continue;
    }

    // 2) Price fetch. We price the BASE token in USD — same convention used by
    //    holdings/portfolio. Failures here are transient (CoinGecko rate-limit,
    //    DexScreener flaky) — record + continue. The engine doesn't escalate
    //    unpriced rows to failed because the next tick might succeed.
    //
    //    Native sentinel handling: base_token may be the literal "ETH" string
    //    (resolveTradePair preserves the sentinel so executeTrade takes the
    //    native code path). The price oracle wants a real address — substitute
    //    the chain's WETH so the lookup succeeds. price-equivalent: ETH USD
    //    price tracks WETH USD price within sub-bp on every supported chain.
    let priceTarget: Address = order.base_token as Address;
    if (order.base_token === "ETH" || order.base_token === "NATIVE") {
      // Lazy-resolve the profile to grab WETH. Doing this only when needed
      // avoids an unnecessary loadConfig on the hot all-ERC20 path.
      const profile = resolveProfile(order.chain, config);
      priceTarget = profile.weth;
    }
    let currentPrice: number | null = null;
    try {
      currentPrice = await getCurrentPrice(priceTarget, args.logger);
    } catch (e) {
      args.logger.warn(`order #${order.id}: price fetch failed: ${(e as Error).message}`);
    }
    recordOrderCheck(order.id, currentPrice);

    // Iter25: order decision journal. Build the observation reflecting
    // this tick's evaluation; the journal helper applies the sampling
    // predicate (only writes on state changes). Cheap no-op when the
    // feature is disabled (default).
    const recordJournal = (overrides: { fired?: boolean; skipped?: boolean; expired?: boolean; notes?: string; errorMessage?: string } = {}) =>
      journalFor(order, currentPrice, overrides);

    if (currentPrice == null) {
      transientErrors += 1;
      setOrderError(order.id, "API_ERROR", "price unavailable from CoinGecko/DexScreener");
      await recordJournal({ errorMessage: "price unavailable from CoinGecko/DexScreener" });
      continue;
    }

    // 3) Trigger evaluation.
    //
    // Two paths:
    //   a) Legacy price_below / price_above: pure isOrderTriggered predicate.
    //   b) Trailing: evaluateTrailingTrigger which ALSO updates the water
    //      mark — the engine persists the new mark via updateOrderWaterMark
    //      even when no fire happens (state is durable across restarts).
    let triggered_this_tick = false;
    if (order.trigger_type === "trailing") {
      const evaluation = evaluateTrailingTrigger(order, currentPrice);
      // Persist a water-mark improvement (or first-tick write) regardless
      // of whether the order fires. This is the row's "I'm watching" state.
      if (evaluation.waterMarkChanged && evaluation.nextWaterMark != null) {
        const { updateOrderWaterMark } = await import("./db.js");
        updateOrderWaterMark(order.id, evaluation.nextWaterMark);
        // Reflect the update in the in-memory copy so downstream notification
        // payloads have the fresh value.
        order.water_mark_usd = evaluation.nextWaterMark;
      }
      // Below-activation / above-activation states log + continue; they
      // do NOT count as a transient error because the order is exactly
      // doing what it was configured to do (waiting for the gate).
      if (!evaluation.tracking) {
        args.logger.debug(
          `order #${order.id}: trailing trigger not tracking (${evaluation.notTrackingReason ?? "?"})`,
        );
        await recordJournal();
        continue;
      }
      if (!evaluation.triggered) {
        await recordJournal();
        continue;
      }
      triggered_this_tick = true;
    } else {
      if (!isOrderTriggered(order, currentPrice)) {
        await recordJournal();
        continue;
      }
      triggered_this_tick = true;
    }
    if (!triggered_this_tick) continue;
    triggered += 1;

    if (args.dryRun) {
      fills.push({ orderId: order.id, status: "skipped", observedPriceUsd: currentPrice, errorCode: "DRY_RUN", errorMessage: "Triggered but dry-run requested — not firing." });
      await recordJournal({ skipped: true });
      continue;
    }

    // Iter28: engine lock. Trail continues tracking (HWM stays
    // fresh), but the FIRE path is gated until the operator runs
    // `tradekit engine unlock`. Each skip is logged on the order
    // row + reported in the tick result; the journal records the
    // skip with the lock context.
    const { isEngineLocked, getEngineLockState } = await import("./engineLock.js");
    if (isEngineLocked()) {
      const lockState = getEngineLockState();
      const msg = `engine locked: ${lockState.reason ?? "(no reason)"}`;
      fills.push({
        orderId: order.id, status: "skipped",
        observedPriceUsd: currentPrice,
        errorCode: "ENGINE_LOCKED", errorMessage: msg,
      });
      setOrderError(order.id, "ENGINE_LOCKED", msg);
      await recordJournal({ skipped: true, notes: msg });
      continue;
    }

    // Pre-fire expiry re-check. The step-1 check ran BEFORE the price
    // fetch; on a slow tick (HTTP price call + per-account keystore
    // decrypt for an earlier order) seconds can pass — enough for a
    // 4) Build the wallet (lazy — only when we actually need to fire).
    //    Iter30: paper orders use a read-only client (no keystore
    //    decryption) — the same path as dry-run ticks. This means a
    //    paper-only deployment can run without exposing the private
    //    key at all, which is exactly what an operator validating a
    //    new strategy wants.
    const isPaperOrder = (order.paper ?? 0) === 1;
    let walletBuilt: Built;
    try {
      walletBuilt = await ensureWallet(order.chain, order.account, {
        readOnly: isPaperOrder,
      });
    } catch (e) {
      // Wallet load failures are typically password/keystore issues — a
      // terminal config problem, not a per-order one. Record the error on
      // THIS order but continue the loop so subsequent orders that target
      // OTHER accounts (different keystores) still get a chance.
      const msg = (e as Error).message ?? String(e);
      const code = (e as { code?: string }).code ?? "WALLET_LOCKED";
      transientErrors += 1;
      setOrderError(order.id, code, msg);
      fills.push({ orderId: order.id, status: "skipped", observedPriceUsd: currentPrice, errorCode: code, errorMessage: msg });
      await recordJournal({ errorMessage: `${code}: ${msg}` });
      continue;
    }

    // Pre-fire expiry re-check. The step-1 check ran BEFORE the price
    // fetch and the wallet build; on a slow tick (HTTP price call +
    // keystore scrypt decrypt) seconds can pass — enough for a
    // short-dated order to cross its expires_at between evaluation and
    // fire. Firing outside the validity window violates the operator's
    // explicit intent, so retire instead of firing. Same cascade
    // semantics as the step-1 path (an expired OCO peer cancels the
    // rest of its group).
    if (isOrderExpired(order)) {
      await retireExpired(order, currentPrice);
      continue;
    }

    // 5) Execute. The TradeRequest mirrors `tradekit trade buy/sell` 1:1 so
    //    every guardrail (safety check, gas budget, rate limit, …) and every
    //    instrumentation surface (audit_log row, trade row) applies verbatim.
    //    For paper orders we take a parallel branch through executePaperTrade
    //    which writes to the virtual book instead — same result shape (txHash
    //    etc.) so the post-fire bookkeeping below is shared.
    let result: TradeResult | null = null;
    try {
      if (isPaperOrder) {
        const paperCtx: PaperTradeContext = {
          publicClient: walletBuilt.publicClient,
          profile: walletBuilt.profile,
          config,
          logger: args.logger,
          accountLabel: walletBuilt.label,
        };
        const paperResult = await executePaperTrade(
          {
            direction: order.side,
            base: order.base_token as Address | "ETH",
            quote: order.quote_token as Address,
            baseAmount: order.base_amount ?? undefined,
            quoteAmount: order.quote_amount ?? undefined,
            slippageBps: order.slippage_bps ?? undefined,
            note: order.note ? `[order #${order.id}] ${order.note}` : `[order #${order.id}]`,
            strategy: order.strategy ?? undefined,
            source: { type: "order", id: order.id ?? null },
          },
          paperCtx,
        );
        // Cast: PaperTradeResult is a structural superset of the
        // TradeResult subset we use below (ok, simulated, txHash,
        // baseAmount, quoteAmount, aggregator, status). Keeping the
        // post-fire bookkeeping branch unified means new behavior
        // (notifications, OCO cascade, journal) automatically
        // applies to paper too.
        result = paperResult as unknown as TradeResult;
      } else {
        const req: TradeRequest = {
          direction: order.side,
          base: order.base_token as Address | "ETH",
          quote: order.quote_token as Address,
          baseAmount: order.base_amount ?? undefined,
          quoteAmount: order.quote_amount ?? undefined,
          slippageBps: order.slippage_bps ?? undefined,
          autoSlippage: order.auto_slippage === 1,
          simulate: false,
          note: order.note ? `[order #${order.id}] ${order.note}` : `[order #${order.id}]`,
          strategy: order.strategy ?? undefined,
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
      // Classify: transient (RPC down, rate limit) vs terminal (revert,
      // blacklist, USD cap). Transient errors leave the order ACTIVE so the
      // next tick retries; terminal errors flip it to FAILED.
      if (isTransientErrorCode(code)) {
        transientErrors += 1;
        setOrderError(order.id, code, msg);
        fills.push({ orderId: order.id, status: "skipped", observedPriceUsd: currentPrice, errorCode: code, errorMessage: msg });
        // Journal: trigger matched but the fire attempt failed transiently
        // (RPC flake, rate limit). Order stays active; replay shows WHY
        // this tick didn't convert the trigger into a fill.
        await recordJournal({ errorMessage: `${code}: ${msg}` });
      } else {
        markOrderFailed(order.id, code, msg);
        failed += 1;
        fills.push({ orderId: order.id, status: "failed", observedPriceUsd: currentPrice, errorCode: code, errorMessage: msg });
        // Journal: terminal failure (safeguard tripped, insufficient
        // balance, blacklist…). This is the single most forensically
        // important entry after a fill — pre-fix the timeline simply
        // stopped here and `order replay` couldn't answer "why did this
        // order flip to failed?".
        await recordJournal({ errorMessage: `${code}: ${msg}` });
        // Notify: terminal failure path (safeguard tripped, balance
        // insufficient, etc.). critical severity — distinguished from the
        // TX_REVERTED warn case because these block the operator's intent
        // entirely (a config / liquidity / safety issue, not a fill that
        // happened to revert).
        await tryNotify(
          {
            event: "order.failed",
            severity: "critical",
            title: `Order #${order.id} failed: ${code}`,
            body: msg,
            fields: {
              id: order.id,
              chain: order.chain,
              account: order.account,
              errorCode: code,
              triggerPrice: order.target_price_usd,
              observedPrice: currentPrice,
            },
            dedupKey: `order.failed:${order.id}`,
          },
          config,
          args.logger,
        );
        // OCO cascade for terminal failures. A failed peer DOES cascade —
        // an unfillable order on one side of an OCO group usually means
        // the operator's exit plan has changed (safeguard tripped, balance
        // gone), so cancelling the rest is the natural cleanup.
        await cascadeOcoIfApplicable(order, config, args.logger, {
          firedAs: "failed",
          firedReason: code,
        });
      }
      continue;
    }

    if (result && result.txHash && result.status !== "failed") {
      // Compute fill_price USD (best-effort) — quote_amount × current quote
      // price OR fall back to currentPrice (price at trigger time). The
      // trade's `price` field is base/quote, not USD; we already have a USD
      // price for base in `currentPrice`.
      const fillPriceUsd = currentPrice;
      markOrderFilled(order.id, {
        tx_hash: result.txHash,
        fill_price: fillPriceUsd,
        base_amount: result.baseAmount,
        quote_amount: result.quoteAmount,
      });
      await recordJournal({ fired: true });
      filled += 1;
      fills.push({ orderId: order.id, status: "filled", observedPriceUsd: currentPrice, txHash: result.txHash });
      // Notify: order filled. info severity — successful fill is good news,
      // but most operators want to know about it. dedupKey matches the
      // order id so the (very unlikely) retry of the same fill never spams.
      await tryNotify(
        {
          event: "order.filled",
          severity: "info",
          title: `Order #${order.id} filled · ${summarizeIntent(order)}`,
          body: `Trigger: ${summarizeTrigger(order)}. Filled at \$${fillPriceUsd}.`,
          fields: {
            id: order.id,
            chain: order.chain,
            account: order.account,
            txHash: result.txHash,
            baseAmount: result.baseAmount,
            quoteAmount: result.quoteAmount,
            fillPriceUsd,
            aggregator: result.aggregator,
            // Trailing-stop telemetry: report the final water mark + the
            // retracement size from it. Lets operators see how much of
            // a peak was captured (sell trail) or how much of a dip was
            // bought (buy trail) in the notification itself.
            trailWaterMarkUsd: order.trigger_type === "trailing" ? order.water_mark_usd : undefined,
            trailPct: order.trigger_type === "trailing" ? order.trail_pct : undefined,
          },
          link: orderExplorerUrl(order, walletBuilt.profile, result.txHash),
          dedupKey: `order.filled:${order.id}`,
        },
        config,
        args.logger,
      );
      // OCO cascade on a SUCCESSFUL fill — the canonical case for OCO:
      // a take-profit fires + auto-cancels its paired stop-loss (or
      // vice versa), or a multi-level ladder fires + cancels the
      // remaining levels.
      await cascadeOcoIfApplicable(order, config, args.logger, {
        firedAs: "filled",
        firedReason: `${result.txHash}`,
      });
    } else if (result && result.status === "failed") {
      // Trade landed on-chain but reverted. Terminal — flip to failed.
      const msg = result.simulation?.revertReason ?? "trade reverted on-chain";
      markOrderFailed(order.id, "TX_REVERTED", msg);
      await recordJournal({ errorMessage: `TX_REVERTED: ${msg}` });
      failed += 1;
      fills.push({ orderId: order.id, status: "failed", observedPriceUsd: currentPrice, txHash: result.txHash, errorCode: "TX_REVERTED", errorMessage: msg });
      // Notify: order failed. warn severity — a fill that reverted is
      // actionable (gas was spent, the operator may want to retry or
      // diagnose the pair). Critical reserved for safeguard-class events.
      await tryNotify(
        {
          event: "order.failed",
          severity: "warn",
          title: `Order #${order.id} reverted on-chain · ${summarizeIntent(order)}`,
          body: msg,
          fields: {
            id: order.id,
            chain: order.chain,
            account: order.account,
            txHash: result.txHash,
            errorCode: "TX_REVERTED",
          },
          link: orderExplorerUrl(order, walletBuilt.profile, result.txHash),
          dedupKey: `order.failed:${order.id}`,
        },
        config,
        args.logger,
      );
      // OCO cascade on a TX_REVERTED on-chain failure. Same logic as
      // the safeguard-failure cascade above — peer's exit plan is no
      // longer coherent; clean up the siblings.
      await cascadeOcoIfApplicable(order, config, args.logger, {
        firedAs: "failed",
        firedReason: "TX_REVERTED",
      });
    } else {
      // No tx hash means simulate-only or an unusual path — treat as transient.
      transientErrors += 1;
      setOrderError(order.id, "INTERNAL_ERROR", "executeTrade returned no tx hash");
      fills.push({ orderId: order.id, status: "skipped", observedPriceUsd: currentPrice, errorCode: "INTERNAL_ERROR", errorMessage: "no tx hash" });
      await recordJournal({ errorMessage: "INTERNAL_ERROR: executeTrade returned no tx hash" });
    }
  }

  const severity: "ok" | "warn" | "critical" = failed > 0 ? "critical" : transientErrors > 0 ? "warn" : "ok";
  const recommendedActions: NextAction[] = [];
  if (failed > 0) {
    recommendedActions.push({
      tool: "order_list",
      params: { status: "failed", limit: 10 },
      reason: `${failed} order(s) failed this tick — inspect with \`tradekit order list --status failed\`.`,
    });
  }
  if (transientErrors > 0) {
    recommendedActions.push({
      tool: "doctor",
      params: {},
      reason: `${transientErrors} transient error(s) this tick (RPC / price API) — run \`tradekit doctor\` to triage.`,
    });
  }
  return {
    ok: true,
    timestamp: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    severity,
    scanned: orders.length,
    triggered,
    filled,
    failedCount: failed,
    expiredCount: expired,
    transientErrorCount: transientErrors,
    fills,
    recommendedActions,
  };
}

/**
 * Error codes the engine considers transient (worth retrying next tick).
 * Anything else is terminal — flips the order to `failed`.
 *
 * Conservative on retry-ability: rate limits and network blips are obvious
 * retries; revert / safety / param errors are terminal (the next tick would
 * reproduce them). When in doubt we flip to failed so a runaway misconfigured
 * order doesn't burn gas repeatedly across ticks.
 */
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

// ── re-export DB helpers so consumers import from one module ─

export { listOrders, getOrderById, orderCountsByStatus };
