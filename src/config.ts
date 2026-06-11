import { existsSync, readFileSync } from "fs";
import { writeFileSecure, ensureDataDir } from "./secureIo.js";
import { z } from "zod";
import type { Address } from "viem";
import { CONFIG_PATH, DATA_DIR, DB_PATH } from "./constants.js";
import { createHash } from "node:crypto";
import { latestConfigHistory as dbLatestConfigHistory, insertConfigHistory as dbInsertConfigHistory } from "./db.js";
import { getBuiltinProfile, listChains, type ChainProfile } from "./chains.js";
import { ToolError } from "./errors.js";
import { closestMatch } from "./format.js";

// ── schema ───────────────────────────────────────────────────

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address");

const chainOverrideSchema = z
  .object({
    chainId: z.number().int().positive().optional(),
    rpcs: z.array(z.string().url()).optional(),
    explorer: z.string().url().optional(),
    nativeSymbol: z.string().optional(),
    weth: addressSchema.optional(),
    usdc: addressSchema.optional(),
    tokens: z.record(z.string(), addressSchema).optional(),
    uniswapV3: z
      .object({
        swapRouter02: addressSchema,
        quoterV2: addressSchema,
      })
      .optional(),
    aggregators: z.array(z.enum(["kyberswap", "openocean", "0x", "1inch"])).optional(),
    base: z.string().optional(),
    quote: z.string().optional(),
  })
  .strict();

// ── strategy alert rules (iter32) ────────────────────────────
//
// Each rule is a discriminated union by `type`. A factory rather
// than a top-level const so the safety-schema reference comes
// strictly before the factory invocation (forward-reference-safe
// even though we're in module scope).
//
// Schema design constraints:
//
//  - Discriminated union for type-safety: TS narrows correctly
//    when handling each rule type in the evaluator switch.
//  - Each rule carries its own thresholds — operators express
//    different sensitivities for different rules.
//  - `appliesTo` is a tag-pattern filter that lets one config
//    cover heterogeneous strategies; empty/missing means "every
//    strategy".
//  - All rules accept `note` for free-text rationale that surfaces
//    in the notification body.
function strategyAlertRuleSchema() {
  const common = {
    appliesTo: z
      .array(z.string().min(1))
      .optional()
      .describe("Optional tag patterns to restrict this rule to. Supports `playbook:*` wildcard suffix. Empty/missing = all strategies."),
    note: z.string().optional().describe("Free-text rationale included in the alert notification body."),
    action: z
      .enum(["notify", "pause"])
      .optional()
      .describe(
        "What to do when the rule FIRES (transitions ok → violated). 'notify' (default): emit the alert notification only. 'pause': CIRCUIT BREAKER — additionally bulk-pause every primitive (orders / schedules / rebalance plans) owned by the strategy tag, then emit a critical <eventPrefix>.circuit_breaker notification with the paused ids. Pausing is non-destructive (resume with `tradekit strategy resume <tag>`); the breaker acts ONLY on the fire transition — a still-violated rule does not re-pause, so an operator's deliberate resume sticks until the rule resolves and fires again.",
      ),
  };
  return z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("staleness"),
        thresholdSeconds: z
          .number()
          .int()
          .min(60)
          .describe("Alert when the strategy hasn't fired a successful trade in this many seconds. Use 24h=86400, 48h=172800."),
        ...common,
      })
      .strict(),
    z
      .object({
        type: z.literal("slippage_trend"),
        baselineBps: z.number().int().min(0).max(10_000).describe("Reference avg slippage in bps (the strategy's expected/normal level)."),
        alertMultiplier: z.number().min(1.1).max(10).describe("Trigger when observed avg ≥ baselineBps × multiplier (e.g. 1.5 = 50% above baseline)."),
        minSampleSize: z.number().int().min(2).default(5).describe("Minimum number of slippage samples required to evaluate the rule."),
        ...common,
      })
      .strict(),
    z
      .object({
        type: z.literal("success_rate_drop"),
        minRate: z.number().min(0).max(1).describe("Alert when fill success rate drops below this fraction (0.8 = 80%)."),
        minSampleSize: z.number().int().min(2).default(10).describe("Minimum total terminal trades required (avoid alerting on a single failure)."),
        ...common,
      })
      .strict(),
    z
      .object({
        type: z.literal("failure_streak"),
        alertCount: z
          .number()
          .int()
          .min(2)
          .describe("Alert when this many consecutive terminal failures occurred (no successful fill between them)."),
        ...common,
      })
      .strict(),
    z
      .object({
        type: z.literal("budget_approach"),
        warnPct: z
          .number()
          .min(0)
          .max(1)
          .describe("Alert when ANY matching strategyBudget rule is consumed by ≥ this fraction (0.8 = 80%). Evaluated against both lifetime + daily limits independently."),
        ...common,
      })
      .strict(),
    z
      .object({
        type: z.literal("drawdown_threshold"),
        alertPct: z
          .number()
          .positive()
          .max(99)
          .describe("Alert when the per-strategy drawdown row's drawdown_pct ≥ this percentage (10 = 10%)."),
        ...common,
      })
      .strict(),
    z
      .object({
        type: z.literal("trigger_proximity"),
        alertDistancePct: z
          .number()
          .positive()
          .max(50)
          .describe("Alert when any active order's |distance_to_trigger| ≤ this percentage. Use for proactive heads-up (vs. reactive order.filled). Requires live spot price."),
        ...common,
      })
      .strict(),
    z
      .object({
        type: z.literal("drift_proximity"),
        alertPctOfThreshold: z
          .number()
          .positive()
          .max(1000)
          .describe("Alert when any owned rebalance plan's last-measured drift reaches ≥ this percentage OF ITS THRESHOLD (80 = drift at 80% of the trigger). Uses persisted last-run telemetry — no oracle call. ≥100 means the next evaluation would fire."),
        ...common,
      })
      .strict(),
    z
      .object({
        type: z.literal("position_cap_approach"),
        warnPct: z
          .number()
          .min(0)
          .max(1)
          .describe("Alert when ANY matching positionCaps rule's NET exposure reaches ≥ this fraction of its cap (0.8 = 80%). The proactive twin of the hard POSITION_CAP_EXCEEDED rejection — hear about the ceiling BEFORE a buy bounces off it."),
        ...common,
      })
      .strict(),
    z
      .object({
        type: z.literal("funding_runway"),
        thresholdDays: z
          .number()
          .positive()
          .max(365)
          .describe("Alert when the strategy's spend-token balance is projected to run out within this many days (walking actual upcoming schedule fires + reserved order spends against the current balance — paper book for paper primitives, on-chain for real). 7 = a week of fuel left. Catches insufficient-balance failures BEFORE the first fire_failed."),
        ...common,
      })
      .strict(),
  ]);
}

export type StrategyAlertRule = z.infer<ReturnType<typeof strategyAlertRuleSchema>>;

const safetySchema = z
  .object({
    enabled: z.boolean().default(true),
    perTxUsdLimit: z.number().positive().optional(),
    dailyUsdLimit: z.number().positive().optional(),
    maxSlippageBps: z.number().int().min(1).max(5000).default(500),
    tokenWhitelist: z.record(z.string(), z.array(addressSchema)).optional(),
    tokenBlacklist: z.record(z.string(), z.array(addressSchema)).optional(),
    contractWhitelist: z.record(z.string(), z.array(addressSchema)).optional(),
    /** Max USD value for an approve() call (priced by token × current price).
     *  Approvals exceeding this are blocked with SAFEGUARD_TRIGGERED. */
    maxApprovalUsdLimit: z.number().positive().optional(),
    /** If false (default), `approve --infinite` (or its MCP equivalent) requires
     *  passing override=true to bypass this check. Use to prevent agents from
     *  unbounded-approving a malicious spender. */
    allowInfiniteApprovals: z.boolean().default(false),
    /**
     * Iter620: gas budget safety. Operators trading small amounts on L1 routinely
     * find out AFTER spending gas that 20-40% of their trade went to gas. The
     * preview (iter608) computed `gasPctOfInput` but execution never enforced it.
     *
     *   maxGasPctOfTrade: hard-fail the trade when (estimatedGasUsd / inputUsd × 100)
     *                     exceeds this percentage. Default off — operators opt-in
     *                     because what's "too expensive" depends on strategy.
     *   maxGasNativePerChain: chain-keyed cap on absolute native gas cost. Use to
     *                         enforce "never pay more than 0.01 ETH for any single
     *                         trade on mainnet" regardless of trade size.
     *
     * Both checks fire only when the preview metrics are available (gas estimate
     * + USD price feeds). Operators opt out per-trade with --force-gas (CLI) or
     * forceGas: true (MCP). The bypass is auditable like every other override.
     */
    gas: z
      .object({
        maxGasPctOfTrade: z.number().positive().max(100).optional(),
        maxGasNativePerChain: z.record(z.string(), z.number().positive()).optional(),
      })
      .strict()
      .optional(),
    /**
     * Iter633: minimum interval between trades from the same account (ms).
     *
     * Production runaway-bot vulnerability: per-tx and daily USD limits guard
     * the SIZE of each trade but not the RATE. A bug that loops `trade buy`
     * 100×/second can drain a balance entirely within the daily USD limit's
     * window if each individual trade is small.
     *
     * When set, the safety check looks up the account's most-recent trade
     * timestamp from the trades DB; if (now - lastTs) < minTradeIntervalMs,
     * the trade aborts with SAFEGUARD_TRIGGERED. Pending trades count too
     * (so a stuck-then-spammed retry pattern doesn't slip through). Reads are
     * cheap (indexed query).
     *
     * Opt-in: default off (no rate limit, pre-iter633 behavior preserved).
     * Operators set this to their strategy's natural cadence — e.g. a DCA
     * bot expecting one trade/hour sets 60_000 ms (1 min) to allow some
     * jitter but catch a 1000×/sec runaway.
     */
    minTradeIntervalMs: z.number().int().nonnegative().optional(),
    /**
     * Portfolio-aware position limits. Each rule caps a token's weight within
     * the operator's portfolio as a percentage of total USD value. The safety
     * pipeline computes the predicted post-trade portfolio for every trade and
     * rejects trades that push any matching token outside its [min, max] band.
     *
     * Matching:
     *   - `chain`: a chain name (lowercase: "base", "ethereum", "arbitrum", …)
     *     OR "*" for "every chain" (portfolio-wide limits).
     *   - `token`: a symbol (case-insensitive: "ETH", "WBTC", "USDC") OR a
     *     0x-address (case-insensitive). Address-match takes priority when
     *     both interpretations are plausible.
     *   - At least one of minPctOfPortfolio / maxPctOfPortfolio is required;
     *     setting both is supported (e.g. "USDC stays in [10%, 30%]").
     *
     * The trade flow PASSES the check (with a warning) when the portfolio
     * cannot be priced (oracle outage, unknown long-tail tokens dominate).
     * Operators who want strict enforcement opt in via
     * `safety.positionLimitsFailOnUnpriced: true`.
     *
     * Defaults to undefined / empty array — no fetch, no overhead. The
     * per-trade portfolio RPC roundtrip only happens when limits are set.
     */
    positionLimits: z
      .array(
        z
          .object({
            chain: z.string().min(1),
            token: z.string().min(1),
            minPctOfPortfolio: z.number().min(0).max(100).optional(),
            maxPctOfPortfolio: z.number().min(0).max(100).optional(),
          })
          .strict()
          .refine(
            (r) => r.minPctOfPortfolio != null || r.maxPctOfPortfolio != null,
            { message: "positionLimits entry requires minPctOfPortfolio and/or maxPctOfPortfolio" },
          )
          .refine(
            (r) =>
              r.minPctOfPortfolio == null ||
              r.maxPctOfPortfolio == null ||
              r.minPctOfPortfolio <= r.maxPctOfPortfolio,
            { message: "minPctOfPortfolio must be ≤ maxPctOfPortfolio" },
          ),
      )
      .optional(),
    /** When true, refuse trades whose portfolio composition can't be fully
     *  priced (an oracle outage cascades into a tradekit outage). Default
     *  false — soft-skip with a warning so a CoinGecko blip doesn't block
     *  trading. */
    positionLimitsFailOnUnpriced: z.boolean().optional(),
    /**
     * Pre-trade automatic token-safety check (v15). When enabled, every
     * trade probes the input + output tokens via the same buy+sell
     * round-trip simulation that `tradekit token check` uses. Honeypot
     * verdicts block the trade with TOKEN_BLOCKED; suspicious verdicts
     * block when `failOnSuspicious=true` (default), otherwise log a
     * warning. Verdicts are cached per (chain, token) for `cacheTtlMs`
     * (default 24h) so trades against known-safe tokens carry zero
     * runtime cost after the first probe.
     *
     * Tokens in `safety.tokenWhitelist[chain]` skip the probe when
     * `skipWhitelisted=true` (default). Chain natives (ETH/BNB/POL) and
     * the chain's canonical USDC/WETH/WBTC always skip — these are
     * baseline-trusted assets.
     *
     * Default disabled. Operators opt in by setting enabled=true.
     */
    autoTokenCheck: z
      .object({
        enabled: z.boolean().default(false),
        cacheTtlMs: z.number().int().min(60_000).max(30 * 86_400_000).default(86_400_000),
        failOnSuspicious: z.boolean().default(true),
        probeUsd: z.number().positive().default(5),
        skipWhitelisted: z.boolean().default(true),
      })
      .strict()
      .optional(),

    /**
     * Iter19: per-strategy USD spend caps. The existing daily-USD cap +
     * per-tx cap apply globally across all trades; this layer scopes
     * caps to a specific `strategy` tag (or a tag pattern like
     * "playbook:*"). Three independent caps per rule — lifetime,
     * 24h-rolling, and per-fire — let an operator say e.g. "my
     * arb-experiment can spend $50 max per fire, no more than $200 in
     * any 24h window, and $1000 lifetime cap".
     *
     * Tag matching:
     *   - exact: "arb-experiment" matches that literal value
     *   - suffix wildcard: "playbook:*" matches any playbook id
     * Multiple rules can match the same trade — ALL must pass (most
     * restrictive cap wins).
     *
     * Untagged trades skip the check entirely (no implicit "global"
     * rule). Operators who want a default budget on every trade should
     * set safety.maxUsdPerTx + maxUsdPerDay instead.
     *
     * Pending + success trades both count toward the budget — pending
     * trades may yet confirm, so excluding them would let a careless
     * operator double-spend by firing again before the first lands.
     * Same rule dailyUsdVolume uses.
     */
    strategyBudgets: z
      .array(
        z
          .object({
            tag: z.string().min(1).describe(
              "Strategy tag pattern. Exact match (e.g. 'arb-bot') or suffix wildcard (e.g. 'playbook:*').",
            ),
            lifetimeUsd: z.number().positive().optional(),
            dailyUsd: z.number().positive().optional(),
            perFireUsd: z.number().positive().optional(),
          })
          .strict()
          .refine(
            (r) => r.lifetimeUsd != null || r.dailyUsd != null || r.perFireUsd != null,
            { message: "strategyBudgets entry requires at least one of lifetimeUsd / dailyUsd / perFireUsd" },
          ),
      )
      .optional(),

    /** v38: per-strategy NET-exposure caps — the third risk axis
     *  (drawdown = portfolio value, budgets = gross spend, position
     *  caps = net holding). Buys that would push a strategy's net
     *  position in a token past the cap throw POSITION_CAP_EXCEEDED;
     *  SELLS ARE NEVER BLOCKED (they reduce exposure). Net position
     *  uses the same weighted-average model as every P&L surface;
     *  scope is per (tag, token) ACROSS chains. */
    positionCaps: z
      .array(
        z
          .object({
            pattern: z.string().min(1).describe("Strategy tag pattern — exact or suffix wildcard ('playbook:*')."),
            token: z.string().min(1).describe("Token to cap: symbol (case-insensitive) or 0x address."),
            maxBaseAmount: z.number().positive().optional().describe("Max NET base units held after a buy."),
            maxCostQuote: z.number().positive().optional().describe("Max NET tracked cost basis (quote units)."),
            note: z.string().optional(),
          })
          .strict()
          .refine((r) => r.maxBaseAmount != null || r.maxCostQuote != null, {
            message: "positionCaps entry requires at least one of maxBaseAmount / maxCostQuote",
          }),
      )
      .optional(),

    /**
     * v47: human-in-the-loop approval gate for AGENT-proposed trades.
     * When enabled, MCP buy/sell at or above thresholdUsd is NOT
     * executed — it lands as a pending trade intent (with its
     * simulate-preview as review context) and the operator approves
     * or rejects via `tradekit intents` (CLI-ONLY — same security
     * boundary as backup/panic; a prompt-injected agent must never
     * approve its own spending). The CLI trade path is NOT gated:
     * it already has the wallet-password gate, i.e. the human.
     */
    tradeApproval: z
      .object({
        enabled: z.boolean().default(false),
        /** USD threshold at/above which agent trades need approval.
         *  null = EVERY agent trade needs approval. */
        thresholdUsd: z.number().positive().nullable().default(null),
        /** Pending intents expire after this many minutes — a stale
         *  quote should never execute days later. */
        expiresMinutes: z.number().int().min(1).max(1440).default(60),
      })
      .strict()
      .default({ enabled: false, thresholdUsd: null, expiresMinutes: 60 }),

    /**
     * Iter20: portfolio drawdown circuit breaker. Tracks the operator's
     * portfolio peak USD value across trades and refuses new trades
     * when current value falls below peak × (1 - maxDrawdownPct/100).
     * Once tripped, stays tripped until manually reset OR until current
     * value recovers past peak × (1 - autoResumeAtPct/100) when set.
     *
     * State-AWARE (vs. the rest of the safety stack which is forward-
     * looking) — this layer reacts to actual realized capital losses.
     *
     * Scope: "global" sums portfolio USD across all accounts + chains.
     * Per-account / per-chain scopes are reserved for future iters
     * (Zod rejects them for now so misconfiguration is loud).
     *
     * Defaults to disabled. Operators opt in by setting enabled=true.
     */
    drawdownCircuitBreaker: z
      .object({
        enabled: z.boolean().default(false),
        maxDrawdownPct: z.number().positive().max(99).default(15),
        /** Optional auto-resume: when current portfolio recovers to
         *  peak × (1 - autoResumeAtPct/100), clear the tripped flag
         *  automatically. Null = manual reset only (the safer default
         *  — operators should investigate WHY the trip happened before
         *  resuming). */
        autoResumeAtPct: z.number().positive().max(99).nullable().default(null),
        /** v1 supports "global" only. The literal union keeps the
         *  config strict; future variants ("account:NAME", "chain:NAME")
         *  add to the union explicitly. */
        scope: z.literal("global").default("global"),
      })
      .strict()
      .optional(),

    /**
     * Iter32: strategy alerts. Push notifications when a strategy's
     * health crosses operator-defined thresholds — staleness,
     * slippage trend, success-rate drop, failure streak, budget
     * approach, drawdown threshold, trigger proximity.
     *
     * Each rule fires exactly ONCE on the OK→active transition + a
     * matching `resolved` event on the reverse. State is persisted
     * in the `strategy_alert_state` table (v25 migration) keyed by
     * (tag, ruleType). No notification storms — same alert won't
     * fire every tick.
     *
     * Defaults to disabled; operators opt in by setting enabled=true
     * + a non-empty rules array.
     *
     * `appliesTo`: optional tag-pattern filter. Empty/undefined
     * means the rule applies to EVERY deployed strategy; a list of
     * patterns (literal tags or `playbook:*` wildcards) restricts
     * evaluation to matching tags. Useful when different strategies
     * tolerate different slippage / budget thresholds.
     */
    strategyAlerts: z
      .object({
        enabled: z.boolean().default(false),
        rules: z
          .array(strategyAlertRuleSchema())
          .default([])
          .describe("Per-rule thresholds. Empty array = no rules evaluated even when enabled=true."),
        /** Comma-separated event prefix override. Default
         *  "strategy.alert" — emits as e.g. `strategy.alert.staleness`
         *  + `strategy.alert.resolved.staleness`. */
        eventPrefix: z.string().default("strategy.alert"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .default({ enabled: true, maxSlippageBps: 500, allowInfiniteApprovals: false });

// ── notifications ────────────────────────────────────────────
//
// Webhook channels for push-based delivery of operationally interesting
// events (order fills, trade reverts, infinite approvals, …). The notify
// engine (src/notify.ts) auto-detects the payload format from the URL host
// — Slack incoming webhooks, Discord webhooks, and Telegram bot API
// `sendMessage` URLs all get format-specific bodies; anything else gets a
// generic JSON POST. Best-effort delivery only: a webhook outage is logged
// but NEVER throws, so a misconfigured Slack URL cannot block a trade.

/**
 * Event-name allowlist. Empty / undefined `events` on a channel means "all
 * events" — the most common case. When set, only listed events flow. The
 * union is kept loose (z.string()) intentionally: new event types can be
 * added in the engine without forcing every operator to update Zod-validated
 * configs first. The notify dispatcher unconditionally tolerates unknown
 * event names so a forward-compatible config never breaks startup.
 */
const notificationChannelSchema = z
  .object({
    name: z.string().min(1).describe("Operator-facing identifier for `notify test --channel NAME`."),
    url: z
      .string()
      .url()
      .describe("Webhook target URL. Format auto-detected: hooks.slack.com → Slack, discord.com/api/webhooks → Discord, api.telegram.org/bot... → Telegram, anything else → generic POST."),
    /** Event-name allowlist. Empty / undefined = all events. */
    events: z.array(z.string()).optional(),
    /** Minimum severity floor: 'info' lets everything through; 'critical' restricts to critical-only. */
    minSeverity: z.enum(["info", "warn", "critical"]).default("info"),
    enabled: z.boolean().default(true),
    /** Per-channel timeout override (ms). Default 5000. Tight cap so a hung
     *  webhook can't slow the engine more than a few seconds per tick. */
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
    /** v34: this channel delivers even during quiet hours. Set on the
     *  pager/on-call channel so critical-adjacent routing is unaffected
     *  by the global quiet window. */
    ignoreQuietHours: z.boolean().optional(),
  })
  .strict();

export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

const notificationsSchema = z
  .object({
    channels: z.array(notificationChannelSchema).default([]),
    /** Dedup window in ms. Identical events (same dedupKey) within the window
     *  are suppressed. Default 60_000 (1 min) — catches the most common storms
     *  (an order failing every tick, an RPC outage flapping) without losing
     *  unique signal. */
    dedupWindowMs: z.number().int().min(0).max(86_400_000).default(60_000),
    /** v31: engine-pushed daily digest. When enabled, the engine's
     *  digest worker sends the windowed digest through the configured
     *  channels once per UTC day at (or after) hourUtc — no external
     *  cron needed. minVerdict gates on health: "attention" means
     *  "only page me when something needs attention". */
    digest: z
      .object({
        enabled: z.boolean().default(false),
        hourUtc: z.number().int().min(0).max(23).default(9),
        window: z.string().default("24h"),
        minVerdict: z.enum(["healthy", "attention", "critical"]).default("healthy"),
      })
      .strict()
      .default({ enabled: false, hourUtc: 9, window: "24h", minVerdict: "healthy" }),
    /** v34: quiet hours. Inside the window [startHourUtc, endHourUtc)
     *  (wraps midnight when start > end), notifications BELOW
     *  breakthroughSeverity are not delivered — they queue in
     *  notification_queue and flush as ONE summary when the window
     *  ends (nothing is lost, nobody is woken). Channels with
     *  ignoreQuietHours: true always deliver. The daily digest and
     *  the flush summary itself are exempt. */
    quietHours: z
      .object({
        enabled: z.boolean().default(false),
        startHourUtc: z.number().int().min(0).max(23).default(22),
        endHourUtc: z.number().int().min(0).max(23).default(7),
        breakthroughSeverity: z.enum(["info", "warn", "critical"]).default("critical"),
      })
      .strict()
      .default({ enabled: false, startHourUtc: 22, endHourUtc: 7, breakthroughSeverity: "critical" }),
  })
  .strict()
  .default({
    channels: [],
    dedupWindowMs: 60_000,
    digest: { enabled: false, hourUtc: 9, window: "24h", minVerdict: "healthy" },
    quietHours: { enabled: false, startHourUtc: 22, endHourUtc: 7, breakthroughSeverity: "critical" },
  });

// ── engine (unified supervisor) ──────────────────────────────
//
// The engine supervisor (`src/engine.ts`) fans out per-feature workers
// (orders / schedules / reconcile) on independent cadences from one
// process. This config controls which workers run and how often.
//
// Backward compatible — defaults match the per-feature daemons' natural
// cadence so an operator running `tradekit engine run` with default config
// gets the same tick behavior as running three separate daemons.

const engineWorkerSchema = z
  .object({
    enabled: z.boolean().default(true),
    intervalMs: z
      .number()
      .int()
      .min(1000, "engine worker intervalMs must be ≥ 1000 (1s)")
      .max(86_400_000, "engine worker intervalMs must be ≤ 24h")
      .default(60_000),
  })
  .strict();

/**
 * Iter33: per-worker resilience config. When a worker fails N times
 * in a row, its effective tick interval grows geometrically up to
 * maxBackoffMs — pre-iter33, a dead RPC produced a notification +
 * load storm at every tick interval. The recovery transition emits
 * `worker.recovered` + restores the base interval.
 *
 * Defaults are deliberately conservative: 3 failures before backoff
 * kicks in (≥ 1 real outage vs a single network blip), 2× multiplier
 * (familiar exponential pattern), 10 min cap (operators investigating
 * an incident don't want the worker fully off — slow re-checks every
 * ~10 min give them signal without spam).
 */
const resilienceSchema = z
  .object({
    enabled: z.boolean().default(true),
    thresholdFailures: z.number().int().min(1).max(100).default(3),
    backoffMultiplier: z.number().min(1.5).max(10).default(2),
    maxBackoffMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
    tickTimingWindow: z.number().int().min(2).max(1000).default(20),
  })
  .strict()
  .default({
    enabled: true,
    thresholdFailures: 3,
    backoffMultiplier: 2,
    maxBackoffMs: 600_000,
    tickTimingWindow: 20,
  });

const engineSchema = z
  .object({
    workers: z
      .object({
        // Orders engine — price-triggered conditional orders. Default 30s
        // matches the standalone `order run` watch default; price oracles
        // (CoinGecko / DexScreener) cache for ~60s, so 30s polling produces
        // ~2 fresh oracle reads per minute per active order.
        orders: engineWorkerSchema.default({ enabled: true, intervalMs: 30_000 }),
        // Schedules engine — cron-driven recurring trades (DCA). 60s is
        // enough resolution for cron (which is 1-minute granularity anyway).
        schedules: engineWorkerSchema.default({ enabled: true, intervalMs: 60_000 }),
        // Reconcile — pending-tx receipt sweep. 60s is the standard cron
        // pattern; on most chains a tx confirms within ~30s, so a 60s tick
        // catches most resolutions on the next sweep after submission.
        reconcile: engineWorkerSchema.default({ enabled: true, intervalMs: 60_000 }),
        // Rebalance — portfolio drift correction. Heavier tick than orders
        // (full portfolio fetch + per-target drift math + optional multi-
        // leg trade execution). 5min default keeps the load light when no
        // plan is configured (early-return on dueRebalancePlans empty).
        rebalance: engineWorkerSchema.default({ enabled: true, intervalMs: 300_000 }),
        // Iter33: alerts worker — runs the iter32 alert tick when
        // safety.strategyAlerts.enabled=true. 5min default matches the
        // typical heart-of-things cadence operators want — quick enough
        // to catch a slippage trend before it costs much, slow enough
        // not to spam. enabled is true by default; the alert tick is
        // a no-op when no rules are configured, so the cost when
        // operators haven't opted in is one DB scan + early-return.
        alerts: engineWorkerSchema.default({ enabled: true, intervalMs: 300_000 }),
        // Iter40: db_maintenance worker — runs integrity check +
        // retention prune + auto-backup on independent cadences
        // defined in the `db.*` config sub-trees. Default disabled
        // (interval present but enabled=false). The TICK itself
        // is a no-op when db.integrityCheck.enabled / db.retention.enabled
        // / db.backup.enabled are all false — so even if the worker
        // runs, it costs effectively zero. Read-only from a wallet
        // POV (no password needed). Default interval 1h covers most
        // operational cadences (hourly check, daily backup gated by
        // its own intervalHours).
        db_maintenance: engineWorkerSchema.default({ enabled: false, intervalMs: 3_600_000 }),
        /** v31: digest-push worker. Enabled by default but a no-op
         *  until notifications.digest.enabled=true — same gating
         *  pattern as the alerts worker. */
        digest: engineWorkerSchema.default({ enabled: true, intervalMs: 300_000 }),
        /** v37: equity-snapshot worker. Records a portfolio snapshot
         *  (note 'engine-auto') when the freshest auto-snapshot is
         *  older than engine.snapshotEveryHours — the data feed for
         *  the equity curve. Default DISABLED: each snapshot is a
         *  full multi-chain RPC + price scan. Read-only (no
         *  keystore). The init observability preset enables it. */
        snapshot: engineWorkerSchema.default({ enabled: false, intervalMs: 3_600_000 }),
      })
      .strict()
      .default({}),
    /** v37: minimum hours between engine-auto portfolio snapshots.
     *  The worker ticks on workers.snapshot.intervalMs but only
     *  records when the last auto-snapshot is older than this. */
    snapshotEveryHours: z.number().int().min(1).max(168).default(24),

    /** Iter33: resilience config — controls per-worker backoff on
     *  consecutive failures + the timing window for status display. */
    resilience: resilienceSchema,
    /** Heartbeat notification interval (ms). The engine emits an
     *  `engine.heartbeat` event every N ms so operators can verify the
     *  supervisor is alive without watching logs. Set to 0 to disable
     *  heartbeats entirely. Default 1h. */
    heartbeatIntervalMs: z
      .number()
      .int()
      .min(0)
      .max(86_400_000)
      .default(3_600_000),
    /**
     * Iter25: per-order decision journal. When enabled, the orders
     * engine writes a row to `order_check_log` on each state-changing
     * tick (HWM advanced, proximity crossed, fire, error). Powers
     * `tradekit order replay <id>`.
     *
     * Sampling is automatic — typical orders accumulate 5-20 entries
     * over their lifecycle, not millions. Default off; opt-in for
     * installs that want the forensic visibility.
     */
    orderJournal: z
      .object({
        enabled: z.boolean().default(false),
        /** Percent — log a "near_threshold" entry when price first
         *  crosses within this distance of the fire threshold. */
        proximityPct: z.number().positive().max(50).default(5),
        /** Days to keep journal entries. doctor-driven pruning uses
         *  this when invoked; v1 doesn't auto-prune. */
        retentionDays: z.number().int().positive().max(365).default(30),
      })
      .strict()
      .default({ enabled: false, proximityPct: 5, retentionDays: 30 }),
    /** v29: schedule-engine decision journal (fired / fire_failed /
     *  retired / locked-skip). Due-driven → naturally low cardinality.
     *  Prunable via db.retention.scheduleCheckLogDays. */
    scheduleJournal: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .default({ enabled: false }),
    /** v29: rebalance-engine decision journal. Records EVERY evaluated
     *  occurrence incl. in_band with max_drift_pct — the drift history
     *  is the point. Prunable via db.retention.rebalanceCheckLogDays. */
    rebalanceJournal: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .default({ enabled: false }),
    /** v32: bounded retry for TRANSIENT schedule/rebalance fire
     *  failures (RPC flake, rate limit, aggregator hiccup). Pre-v32 a
     *  transient failure advanced next_run_at to the next natural
     *  cron slot — a weekly DCA lost the whole week to one bad RPC
     *  second. With retry enabled the engine parks the row on an
     *  exponential-backoff slot (backoffMinutes × 2^attempt) instead,
     *  up to maxAttempts; the retry never crosses the next natural
     *  occurrence (when it would, the engine just advances — the next
     *  occurrence supersedes). Terminal failures (safeguards, balance,
     *  blacklist) never retry: they'd fail identically. */
    fireRetry: z
      .object({
        enabled: z.boolean().default(true),
        maxAttempts: z.number().int().min(1).max(10).default(3),
        backoffMinutes: z.number().min(1).max(120).default(5),
      })
      .strict()
      .default({ enabled: true, maxAttempts: 3, backoffMinutes: 5 }),
  })
  .strict()
  .default({
    workers: {
      orders: { enabled: true, intervalMs: 30_000 },
      schedules: { enabled: true, intervalMs: 60_000 },
      reconcile: { enabled: true, intervalMs: 60_000 },
      rebalance: { enabled: true, intervalMs: 300_000 },
      alerts: { enabled: true, intervalMs: 300_000 },
      db_maintenance: { enabled: false, intervalMs: 3_600_000 },
      digest: { enabled: true, intervalMs: 300_000 },
      snapshot: { enabled: false, intervalMs: 3_600_000 },
    },
    snapshotEveryHours: 24,
    resilience: {
      enabled: true,
      thresholdFailures: 3,
      backoffMultiplier: 2,
      maxBackoffMs: 600_000,
      tickTimingWindow: 20,
    },
    heartbeatIntervalMs: 3_600_000,
    orderJournal: { enabled: false, proximityPct: 5, retentionDays: 30 },
    scheduleJournal: { enabled: false },
    rebalanceJournal: { enabled: false },
  });

export type EngineConfig = z.infer<typeof engineSchema>;
export type EngineWorkerName = "orders" | "schedules" | "reconcile" | "rebalance" | "alerts" | "db_maintenance" | "digest" | "snapshot";

// ── mev / private-mempool submission ─────────────────────────
//
// When `mev.enabled` is true and `mev.privateRpcs[<chain>]` is set, write
// transactions on that chain submit through the configured private RPC
// instead of the public mempool. Reads (balance, receipt, eth_call) keep
// using the public-RPC fallback chain — most private relays buffer txs
// for some blocks before propagation, so a private read of a freshly-
// submitted tx would return "not found" until inclusion.
//
// Operator setup is just the URL — every supported relay is a standard
// JSON-RPC endpoint. Common choices on Ethereum mainnet (free, no key):
//   - Flashbots Protect:  https://rpc.flashbots.net/fast
//   - MEV Blocker:        https://rpc.mevblocker.io
//   - Merkle Private RPC: https://rpc.merkle.io (key embedded in URL)
//
// Default `enabled=false` + `privateRpcs={}` so existing installs see
// zero behavioral change. The feature is fully additive.

const mevSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Chain → URL map. Lowercase chain keys (lowercaseChainKeys normalizes
     *  at load time so hand-written "Ethereum" still works). */
    privateRpcs: z.record(z.string(), z.string().url()).default({}),
    /**
     * When true, the wallet's submit transport falls back to public RPCs
     * if the private relay errors. When false (default), a private-RPC
     * outage hard-fails the trade — preserves the MEV-protection
     * guarantee even at the cost of availability.
     *
     * Operators who care more about "trade must land" than "trade must
     * not leak to public mempool" flip this to true. Operators who set
     * MEV protection up in the first place generally care more about not
     * leaking, hence the strict default.
     */
    fallbackToPublic: z.boolean().default(false),
    /**
     * Optional per-chain operator-facing labels. Renders in `doctor`
     * output (`agg:mev (Flashbots Protect)`) so operators can verify
     * routing at a glance.
     */
    labels: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .default({ enabled: false, privateRpcs: {}, fallbackToPublic: false, labels: {} });

export type MevConfig = z.infer<typeof mevSchema>;

const aggregatorSchema = z
  .object({
    preferred: z
      .array(z.enum(["kyberswap", "openocean", "0x", "1inch"]))
      .default(["kyberswap", "openocean"]),
    /** Optional API keys. 0x v2 and 1inch v6 require keys; kyberswap and openocean are free. */
    apiKeys: z
      .object({
        "0x": z.string().optional(),
        "1inch": z.string().optional(),
      })
      .optional(),
    /**
     * Iter602: how to combine multiple aggregators per quote.
     *
     * - "first" (default, backward-compatible): try providers in `preferred` order;
     *   return the first successful quote. Lowest latency for happy-path; can leave
     *   price on the table if a cheaper provider was further down the list.
     * - "best": race every eligible provider in parallel via Promise.allSettled and
     *   return the quote with the highest `amountOut`. Latency = slowest provider's
     *   response time (vs. sum-of-attempts in "first"); price = best available across
     *   the configured set. Losing quotes surface in `result.alternatives[]` so the
     *   operator can audit the spread.
     *
     * Use "best" on volatile or thin-liquidity pairs where the spread is material;
     * keep "first" for low-stakes / familiar pairs where saving a few hundred ms
     * matters more than a few bps. Either way, the safety pre-flight (slippage cap,
     * token whitelist, USD limits) runs on the winning quote — mode doesn't change
     * which guardrails apply.
     */
    mode: z.enum(["first", "best"]).default("first"),
  })
  .strict()
  .default({ preferred: ["kyberswap", "openocean"], mode: "first" });

// ── db lifecycle (iter40) ────────────────────────────────────
//
// Per-table retention + auto-backup + periodic integrity checks
// for long-running deployments. The engine's iter40
// db_maintenance worker reads this config. ALL features are
// opt-in (defaults disabled) — existing installs upgrade without
// behavior change.
//
// Retention defaults are conservative: even with retention enabled
// the cutoffs default to NULL (never prune). Operators have to
// explicitly set each retention window — protects against
// accidental data loss from "I just enabled this without reading
// the docs".

const dbRetentionSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Days to keep audit_log rows. NULL = never prune. */
    auditLogDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** Days to keep paper_trades. NULL = never prune. */
    paperTradesDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** Days to keep order_check_log entries. NULL = never prune. */
    orderCheckLogDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** Days to keep engine_events. NULL = never prune. */
    engineEventsDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** Days to keep alert_events (v28 strategy-alert transition journal).
     *  NULL = never prune. */
    alertEventsDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** v34: quiet-hours notification queue (flushed + ancient rows). */
    notificationQueueDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** v36: config change history. */
    configHistoryDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** Days to keep schedule_check_log (v29). NULL = never prune. */
    scheduleCheckLogDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** Days to keep rebalance_check_log (v29). NULL = never prune. */
    rebalanceCheckLogDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** v45: days to keep idempotency keys. Replay protection is an
     *  operational window, not an archive — old keys only block key
     *  reuse. NULL = never prune. */
    idempotencyKeysDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** Days to keep TERMINAL FAILED trades. NULL = never prune.
     *  Successful trades are NEVER auto-pruned — they're tax-relevant
     *  for most operators. To prune successes, use direct SQL or
     *  a future explicit knob. */
    failedTradesDays: z.number().int().min(1).max(3650).nullable().default(null),
  })
  .strict()
  .default({
    enabled: false,
    auditLogDays: null,
    paperTradesDays: null,
    orderCheckLogDays: null,
    engineEventsDays: null,
    alertEventsDays: null,
    notificationQueueDays: null,
    configHistoryDays: null,
    scheduleCheckLogDays: null,
    rebalanceCheckLogDays: null,
    failedTradesDays: null,
  });

const dbBackupSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Cadence in hours between auto-backups. Default 24 = daily. */
    intervalHours: z.number().int().min(1).max(8760).default(24),
    /** Directory for backup files. Relative paths resolve against
     *  the data dir. */
    destDir: z.string().default("backups"),
    /** Number of rotated backups to keep. Older ones get deleted. */
    retainCount: z.number().int().min(1).max(1000).default(7),
  })
  .strict()
  .default({
    enabled: false,
    intervalHours: 24,
    destDir: "backups",
    retainCount: 7,
  });

const dbIntegrityCheckSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Cadence in hours. Default 24 = daily. */
    intervalHours: z.number().int().min(1).max(8760).default(24),
  })
  .strict()
  .default({ enabled: false, intervalHours: 24 });

const dbSchema = z
  .object({
    retention: dbRetentionSchema,
    backup: dbBackupSchema,
    integrityCheck: dbIntegrityCheckSchema,
  })
  .strict()
  .default({
    retention: {
      enabled: false,
      auditLogDays: null,
      paperTradesDays: null,
      orderCheckLogDays: null,
      engineEventsDays: null,
      alertEventsDays: null,
      notificationQueueDays: null,
      configHistoryDays: null,
      scheduleCheckLogDays: null,
      rebalanceCheckLogDays: null,
      failedTradesDays: null,
    },
    backup: { enabled: false, intervalHours: 24, destDir: "backups", retainCount: 7 },
    integrityCheck: { enabled: false, intervalHours: 24 },
  });

export type DbConfig = z.infer<typeof dbSchema>;

export const configSchema = z
  .object({
    activeChain: z.string().default("base"),
    activeAccount: z.string().default("default"),
    defaultSlippageBps: z.number().int().min(1).max(5000).default(50),
    chains: z.record(z.string(), chainOverrideSchema).default({}),
    aggregator: aggregatorSchema,
    safety: safetySchema,
    /** v35: inbound webhook config. signalSecret authenticates
     *  POST /api/signal/:name (TradingView-style alert ingestion) —
     *  a SEPARATE secret from the dashboard token because webhook
     *  URLs get pasted into third-party UIs and leak. ≥16 chars.
     *  Unset = the signal endpoint is disabled (404). */
    webhooks: z
      .object({
        signalSecret: z.string().min(16).optional(),
      })
      .strict()
      .default({}),
    notifications: notificationsSchema,
    engine: engineSchema,
    mev: mevSchema,
    /** Iter40: per-table retention + auto-backup + integrity. */
    db: dbSchema,
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type ChainOverride = z.infer<typeof chainOverrideSchema>;

// ── load / save ──────────────────────────────────────────────

const DEFAULT_CONFIG: Config = configSchema.parse({});

/**
 * Lowercase the keys of a chain-keyed record. Users who hand-edit the JSON config
 * sometimes write `chains.Base.rpcs = [...]` (capital B); without normalization,
 * trade-time code that looks up by `profile.name` (always canonical lowercase) misses
 * the override. We normalize once at load so all downstream call sites just work.
 * Exported so the loadConfig contract is unit-testable in isolation.
 */
export function lowercaseChainKeys<T>(rec: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!rec) return rec;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Return a copy of the config with credential values (aggregator API keys) replaced
 * by "[REDACTED]". Use for any code path that EXPOSES the config to a recipient that
 * shouldn't see secrets: web `/api/config` (browser DevTools / response cache), MCP
 * `config show` (agent's context window), `tradekit config show` CLI output
 * (frequently pasted into support tickets/screenshots).
 *
 * The CLI provides --show-secrets for operators who legitimately need the raw value;
 * MCP and Web never reveal them because there's no legitimate workflow that needs
 * the agent or the browser to hold them.
 */
export function redactConfigForDisplay(config: Config): Config {
  let out = config;
  if (out.aggregator?.apiKeys) {
    out = {
      ...out,
      aggregator: {
        ...out.aggregator,
        apiKeys: Object.fromEntries(
          Object.entries(out.aggregator.apiKeys).map(([k, v]) => [k, v ? "[REDACTED]" : v]),
        ) as typeof out.aggregator.apiKeys,
      },
    };
  }
  // Notification channel URLs carry bearer tokens (Slack/Discord/Telegram all
  // embed them in the path) — same sensitivity class as aggregator API keys.
  // Replace each URL with a host-only fingerprint so operators reviewing
  // their config can still verify routing without exposing the secret half.
  if (out.notifications?.channels && out.notifications.channels.length > 0) {
    out = {
      ...out,
      notifications: {
        ...out.notifications,
        channels: out.notifications.channels.map((c) => ({
          ...c,
          url: redactWebhookUrl(c.url),
        })),
      },
    };
  }
  // MEV private-RPC URLs frequently embed API keys in the path
  // (e.g. https://rpc.merkle.io/<key>). Same redaction class as webhooks —
  // host-only fingerprint, path masked. Labels are operator-visible
  // strings, never sensitive.
  if (out.mev?.privateRpcs && Object.keys(out.mev.privateRpcs).length > 0) {
    out = {
      ...out,
      mev: {
        ...out.mev,
        privateRpcs: Object.fromEntries(
          Object.entries(out.mev.privateRpcs).map(([chain, url]) => [chain, redactWebhookUrl(url)]),
        ),
      },
    };
  }
  return out;
}

/**
 * Replace a webhook URL with a host-only fingerprint plus a "[REDACTED]"
 * path marker. Preserves enough signal for an operator to tell "this is the
 * Slack webhook" vs "this is the Discord webhook" without revealing the
 * authenticating path component.
 *
 * Exported for use by the audit-log redaction surface (db.ts) too — we
 * want a uniform shape across config dumps + audit rows.
 */
export function redactWebhookUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/[REDACTED]`;
  } catch {
    return "[REDACTED]";
  }
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    throw new ToolError("INTERNAL_ERROR", `Invalid JSON in config file ${CONFIG_PATH}: ${(e as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ToolError("INTERNAL_ERROR", `Config validation failed:\n${issues}`);
  }
  // Normalize every chain-keyed record so all read sites can do `rec[lowercaseChain]`.
  // Cheap (one-time on load) and idempotent.
  const cfg = parsed.data;
  cfg.activeChain = cfg.activeChain.toLowerCase();
  cfg.chains = lowercaseChainKeys(cfg.chains) ?? {};
  if (cfg.safety.tokenWhitelist) cfg.safety.tokenWhitelist = lowercaseChainKeys(cfg.safety.tokenWhitelist);
  if (cfg.safety.tokenBlacklist) cfg.safety.tokenBlacklist = lowercaseChainKeys(cfg.safety.tokenBlacklist);
  if (cfg.safety.contractWhitelist) cfg.safety.contractWhitelist = lowercaseChainKeys(cfg.safety.contractWhitelist);
  // MEV private RPCs and labels are chain-keyed — apply the same lowercase
  // normalization so a hand-edit like `mev.privateRpcs.Ethereum = "..."`
  // resolves at trade time (where profile.name is canonical lowercase).
  cfg.mev.privateRpcs = lowercaseChainKeys(cfg.mev.privateRpcs) ?? {};
  cfg.mev.labels = lowercaseChainKeys(cfg.mev.labels) ?? {};
  return cfg;
}

export function saveConfig(config: Config, opts?: { source?: string }): void {
  ensureDataDir(DATA_DIR);
  const validated = configSchema.parse(config);
  const content = JSON.stringify(validated, null, 2) + "\n";
  // Config may hold aggregator API keys — 0600 to keep them off shared-host nosy reads.
  writeFileSecure(CONFIG_PATH, content);
  recordConfigHistory(content, opts?.source ?? null);
}

/** v36: best-effort change-history snapshot. Recorded ONLY when the
 *  DB file already exists — a pure-config user who never ran a DB
 *  command must not get a database spawned by `config set`; history
 *  starts with their first real command. Deduped by content hash so
 *  idempotent re-saves (tests, presets re-applied) don't pile rows.
 *  A history failure NEVER fails the save — the file write above is
 *  the contract. */
function recordConfigHistory(content: string, source: string | null): void {
  try {
    if (!existsSync(DB_PATH)) return;
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    // Lazy require-shape: db.js is a static import-safe module (no
    // config.js dependency — verified, no cycle), but we keep the
    // import at call time via the function table to avoid loading
    // sqlite for config-only CLI paths that never save.
    const { latestConfigHistory, insertConfigHistory } = dbHistoryFns();
    const latest = latestConfigHistory();
    if (latest && latest.hash === hash) return;
    insertConfigHistory({ savedAt: new Date().toISOString(), hash, source, content });
  } catch {
    /* forensic layer only — never block the save */
  }
}

// Indirection so the static import below stays tree-shakeable in
// spirit and trivially stubbable; db.js has no config.js import
// (checked) so this is cycle-free.
function dbHistoryFns(): {
  latestConfigHistory: typeof import("./db.js").latestConfigHistory;
  insertConfigHistory: typeof import("./db.js").insertConfigHistory;
} {
  return { latestConfigHistory: dbLatestConfigHistory, insertConfigHistory: dbInsertConfigHistory };
}

export function ensureConfigFile(): void {
  if (!existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
  }
}

// ── chain profile resolution ─────────────────────────────────

/**
 * Case-insensitive lookup on a chain-keyed record. Users who hand-edit the JSON config
 * sometimes write `chains.Base.rpcs = [...]` (capital B). resolveProfile and several
 * call sites previously did a case-sensitive `rec[chain]` lookup — silently missing
 * the override. Walk the keys once: fast-path exact match, fall back to lowercase
 * comparison. Exported so any direct `config.chains[...]` site can use it.
 */
export function chainRecordLookup<T>(rec: Record<string, T> | undefined, chain: string): T | undefined {
  if (!rec) return undefined;
  if (rec[chain] !== undefined) return rec[chain];
  const lc = chain.toLowerCase();
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lc) return rec[k];
  }
  return undefined;
}

export function resolveProfile(chainName: string, config: Config): ChainProfile {
  const lower = chainName.toLowerCase();
  const builtin = getBuiltinProfile(lower);
  const override = chainRecordLookup(config.chains, lower);

  if (!builtin && !override) {
    // Surface BOTH built-in AND user-configured chain names in the error. Pre-iter157
    // a user with a custom chain in config typing a typo for that chain saw only the
    // built-in list — making them think their custom chain wasn't registered.
    const custom = Object.keys(config.chains ?? {}).filter((c) => !listChains().includes(c.toLowerCase()));
    const available = [...listChains(), ...custom];
    const customNote = custom.length ? `; configured: ${custom.join(", ")}` : "";
    // Iter343: surface the closest-match suggestion when the input is a single typo
    // away from a real chain — same UX as iter162's "did you mean" for command typos.
    // `tradekit chain baes` was previously a dead-end ("Unknown chain ... Built-in: ...");
    // now it leads with "Did you mean 'base'?" so the operator sees the fix at a glance.
    const suggestion = closestMatch(chainName, available);
    const suggestionNote = suggestion ? ` Did you mean '${suggestion}'?` : "";
    throw new ToolError(
      "UNKNOWN_CHAIN",
      `Unknown chain "${chainName}".${suggestionNote} Built-in: ${listChains().join(", ")}${customNote}.`,
      { details: { chain: chainName, available, suggestion } },
    );
  }

  if (!builtin) {
    const required = ["chainId", "rpcs", "weth", "usdc"] as const;
    for (const f of required) {
      const v = override![f];
      // Iter315: treat empty array as missing (specifically for `rpcs`). Pre-iter315
      // a custom chain with `rpcs: []` passed this required-field check (since `![]`
      // is false in JS) but later failed inside makeTransport with the less-specific
      // "No RPC available for chain X". Now: explicit failure here, with the chain name
      // and the offending field.
      const empty = v == null || (Array.isArray(v) && v.length === 0);
      if (empty) {
        throw new ToolError(
          "UNKNOWN_CHAIN",
          `Custom chain "${chainName}" missing required field: ${f}${Array.isArray(v) ? " (got empty array — supply at least one RPC URL)" : ""}.`,
          { details: { chain: chainName, missingField: f, isEmptyArray: Array.isArray(v) } },
        );
      }
    }
    return {
      name: lower,
      chainId: override!.chainId!,
      viemChain: viemChainFor(override!.chainId!, lower, override!.nativeSymbol ?? "ETH"),
      nativeSymbol: override!.nativeSymbol ?? "ETH",
      explorer: override!.explorer ?? "",
      rpcs: override!.rpcs!,
      weth: override!.weth as Address,
      usdc: override!.usdc as Address,
      tokens: (override!.tokens ?? {}) as Record<string, Address>,
      uniswapV3: override!.uniswapV3 as ChainProfile["uniswapV3"],
      aggregators: override!.aggregators ?? ["0x", "1inch"],
    };
  }

  // Merge override on top of builtin
  return {
    ...builtin,
    rpcs: override?.rpcs && override.rpcs.length > 0
      ? [...override.rpcs, ...builtin.rpcs.filter((r) => !override.rpcs!.includes(r))]
      : builtin.rpcs,
    explorer: override?.explorer ?? builtin.explorer,
    nativeSymbol: override?.nativeSymbol ?? builtin.nativeSymbol,
    weth: (override?.weth as Address) ?? builtin.weth,
    usdc: (override?.usdc as Address) ?? builtin.usdc,
    tokens: { ...builtin.tokens, ...((override?.tokens ?? {}) as Record<string, Address>) },
    uniswapV3: (override?.uniswapV3 as ChainProfile["uniswapV3"]) ?? builtin.uniswapV3,
    aggregators: override?.aggregators ?? builtin.aggregators,
  };
}

function viemChainFor(chainId: number, name: string, nativeSymbol = "ETH") {
  // For custom chains, fall back to a minimal Chain object. Honor the operator's
  // nativeSymbol so viem-internal display (error messages, etc.) doesn't mislabel
  // POL/BNB/etc. native txs as "ETH". Pre-iter186 the symbol was hardcoded "ETH".
  return {
    id: chainId,
    name,
    nativeCurrency: { name: nativeSymbol, symbol: nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [] } },
  } as ChainProfile["viemChain"];
}

// ── nested get / set helpers (used by `tradekit config get/set`) ──

export function getConfigPath(config: Config, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>((acc, k) => (acc != null && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), config);
}

export function setConfigPath(config: Config, dotted: string, value: unknown): Config {
  const parts = dotted.split(".");
  const next: Record<string, unknown> = JSON.parse(JSON.stringify(config));
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cursor[k] == null || typeof cursor[k] !== "object") cursor[k] = {};
    cursor = cursor[k] as Record<string, unknown>;
  }
  if (value === undefined) {
    delete cursor[parts[parts.length - 1]];
  } else {
    cursor[parts[parts.length - 1]] = value;
  }
  // Re-validate. Iter278: surface a friendly INVALID_PARAMS with the dotted path +
  // a flattened issues list instead of the raw ZodError stack trace. Pre-iter278
  // `tradekit config set safety.perTxUsdLimit not-a-number` produced a multi-line
  // zod stack trace with vague "Expected number, received string" at the root —
  // hard to read, didn't surface the offending value. Same shape as loadConfig's
  // error formatting.
  const result = configSchema.safeParse(next);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ToolError(
      "INVALID_PARAMS",
      `Cannot set ${dotted}=${JSON.stringify(value)} — config validation failed:\n${issues}`,
    );
  }
  return result.data;
}

/**
 * Append `value` to the array at `path`. Idempotent — duplicates are skipped (compared
 * by JSON.stringify so deep-equal works for objects). Creates the array if absent.
 * Throws if the path resolves to a non-array, non-undefined value (would silently
 * convert a number or object into an array otherwise).
 *
 * Returns the new config + a flag indicating whether the value was already present.
 * Extracted so CLI (`tradekit config push`) and MCP (`config { action: "push" }`)
 * share a single source of truth, and so the logic is directly unit-testable.
 */
export function pushConfigArray(
  config: Config,
  path: string,
  value: unknown,
): { config: Config; alreadyPresent: boolean; length: number } {
  const current = getConfigPath(config, path);
  if (current !== undefined && !Array.isArray(current)) {
    throw new ToolError("INVALID_PARAMS", `Cannot push to ${path}: current value is not an array (${typeof current}).`);
  }
  const arr = Array.isArray(current) ? [...current] : [];
  const exists = arr.some((v) => JSON.stringify(v) === JSON.stringify(value));
  if (!exists) arr.push(value);
  return { config: setConfigPath(config, path, arr), alreadyPresent: exists, length: arr.length };
}

/**
 * Remove the first occurrence of `value` from the array at `path` (deep-equal compare).
 * No-op if the value isn't present, or the path is absent entirely. Throws on non-array
 * existing values (same guard as push).
 */
export function dropConfigArray(
  config: Config,
  path: string,
  value: unknown,
): { config: Config; removed: boolean; length: number } {
  const current = getConfigPath(config, path);
  if (current !== undefined && !Array.isArray(current)) {
    throw new ToolError("INVALID_PARAMS", `Cannot drop from ${path}: current value is not an array (${typeof current}).`);
  }
  const arr = Array.isArray(current) ? [...current] : [];
  const idx = arr.findIndex((v) => JSON.stringify(v) === JSON.stringify(value));
  if (idx >= 0) arr.splice(idx, 1);
  return { config: setConfigPath(config, path, arr), removed: idx >= 0, length: arr.length };
}

/** Try to JSON.parse a string; if it fails, return the original string. */
export function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
