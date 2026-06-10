/**
 * Strategy playbooks.
 *
 * Declarative, version-controllable, atomically-deployable bundles of
 * trading primitives. A playbook is a JSON file naming a set of orders,
 * schedules, and/or rebalance plans that should be created together.
 * The deploy operation is all-or-nothing: any per-primitive failure
 * rolls back every primitive already created in the same call, leaving
 * the system in pre-deploy state.
 *
 * Why this exists. Pre-playbook, operators deploying a multi-primitive
 * strategy (e.g. "trailing-stop + OCO bracket + weekly DCA") had to
 * type 4+ CLI commands by hand. A mid-deploy failure left a partial
 * strategy active. Tear-down meant remembering which IDs to cancel.
 * Version-control meant `audit_log` archaeology. Playbooks make all
 * three concerns explicit + reproducible.
 *
 * Mechanism. Each primitive a playbook creates gets stamped:
 *   - `strategy = "playbook:<id>"` on the existing strategy column
 *   - OCO `group = "pb<id>-<localname>"` (renamed from the local
 *     `group` in the spec) so two playbooks with the same local
 *     group name don't accidentally cross-cancel via OCO cascade
 *
 * Tear-down (`destroyPlaybook`) is a SELECT by strategy-tag plus a
 * cancel-each pass through the same paths as manual cancel. No FK to
 * the primitive tables — the string-match approach lets the playbook
 * layer evolve without touching the primitive schemas.
 *
 * Idempotency. Re-deploying a playbook with the same name + same
 * source hash is a no-op (returns the existing id). Re-deploying with
 * a different hash is an error pointing at `playbook destroy <id>`
 * first. A previously-destroyed playbook with the same name can be
 * redeployed cleanly.
 */

import { createHash } from "node:crypto";
import { ToolError } from "./errors.js";
import { loadConfig, type Config } from "./config.js";
import { resolveProfile } from "./config.js";
import { resolveTradePair } from "./chains.js";
import { createOrderRow, cancelOrderById, type CreateOrderArgs } from "./orders.js";
import { createScheduleRow, cancelScheduleById, type CreateScheduleArgs } from "./schedules.js";
import { parseOnFillSpec } from "./scheduleHooks.js";
import { editOrder } from "./orderEdit.js";
import { editSchedule } from "./scheduleEdit.js";
import { editRebalancePlan } from "./rebalanceEdit.js";
import { createRebalancePlanRow, cancelRebalancePlanById, type CreateRebalancePlanArgs } from "./rebalance.js";
import {
  insertPlaybook,
  updatePlaybookStatus,
  deletePlaybook,
  getPlaybookById,
  findActivePlaybookByName,
  listOrders,
  listSchedules,
  listRebalancePlans,
  type PlaybookRow,
  type OrderRow,
  type ScheduleRow,
  type RebalanceRow,
} from "./db.js";

// ── spec types ───────────────────────────────────────────────

export type OrderSpec = {
  id?: string;
  type: "order";
  side: "buy" | "sell";
  trigger: "price_below" | "price_above" | "trailing";
  price?: number;
  trailPct?: number;
  base: string;
  quote: string;
  baseAmount?: string | number;
  quoteAmount?: string | number;
  slippageBps?: number;
  autoSlippage?: boolean;
  expiresAt?: string;
  /** Local group id within the playbook. Will be namespaced to
   *  `pb<playbookId>-<localname>` at deploy time. */
  group?: string;
  chain?: string;
  account?: string;
  note?: string;
  /** v31: post-fill hook — same dialect as schedule onFill. The
   *  chained order auto-creates after THIS order fills. */
  onFill?: unknown;
};

export type ScheduleSpec = {
  id?: string;
  type: "schedule";
  side: "buy" | "sell";
  cron?: string;
  every?: string;
  base: string;
  quote: string;
  baseAmount?: string | number;
  quoteAmount?: string | number;
  slippageBps?: number;
  autoSlippage?: boolean;
  startAt?: string;
  endAt?: string;
  maxRuns?: number;
  name?: string;
  chain?: string;
  account?: string;
  note?: string;
  /** Post-fill hook (iter27 schedule on_fill): auto-create a follow-up
   *  order after each successful fire. Same shape `schedule create
   *  --on-fill` takes — { type: "createOrder", spec: { side, trigger,
   *  ... } } with `{{filled.X}}` template substitution. Structurally
   *  validated at parse time; the full chain-aware validation (token
   *  resolution, fake-fill render through the order validators) runs
   *  at deploy time inside createScheduleRow. */
  onFill?: unknown;
};

export type RebalanceSpec = {
  id?: string;
  type: "rebalance";
  targets: Array<{ token: string; targetPct: number }>;
  quoteToken?: string;
  driftThresholdPct?: number;
  minTradeUsd?: number;
  cron?: string;
  startAt?: string;
  endAt?: string;
  maxRuns?: number;
  slippageBps?: number;
  autoSlippage?: boolean;
  name?: string;
  chain?: string;
  account?: string;
  note?: string;
};

export type StrategySpec = OrderSpec | ScheduleSpec | RebalanceSpec;

export interface PlaybookSpec {
  /** Required. Operator-facing label + idempotency key. Pattern:
   *  `[A-Za-z0-9_-]{1,64}`. */
  name: string;
  /** Spec format version. v1 only for now; serves as a forward-compat
   *  hook if the spec shape ever evolves. */
  version?: number;
  /** Free-form description. Surfaced in `playbook show`. */
  description?: string;
  /** Default chain for primitives that don't specify their own. */
  chain?: string;
  /** Default account for primitives that don't specify their own. */
  account?: string;
  strategies: StrategySpec[];
}

// ── parser / validator ───────────────────────────────────────

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parse + validate a raw spec object. Throws ToolError("INVALID_PARAMS")
 * with all errors collected into a single message so the operator
 * fixes the file once instead of in fix-rerun loops.
 *
 * Validation is structural only — it does NOT call the per-primitive
 * createRow validators (which need a Config + a profile). That happens
 * in the deploy phase. Splitting the responsibilities means
 * `playbook validate <file>` can run in CI without a live config.
 */
export function parsePlaybookSpec(raw: unknown): PlaybookSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolError("INVALID_PARAMS", `Playbook spec must be a JSON object (got ${typeof raw}).`);
  }
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  // ── top-level ──
  if (typeof r.name !== "string" || !NAME_PATTERN.test(r.name)) {
    errors.push(
      `name: required string matching ${NAME_PATTERN} (got ${JSON.stringify(r.name)})`,
    );
  }
  if (r.version != null && r.version !== 1) {
    errors.push(`version: only version 1 is supported (got ${JSON.stringify(r.version)})`);
  }
  if (r.chain != null && typeof r.chain !== "string") {
    errors.push(`chain: must be a string`);
  }
  if (r.account != null && typeof r.account !== "string") {
    errors.push(`account: must be a string`);
  }
  if (r.description != null && typeof r.description !== "string") {
    errors.push(`description: must be a string`);
  }
  if (!Array.isArray(r.strategies)) {
    errors.push(`strategies: required array`);
    throw new ToolError("INVALID_PARAMS", `Invalid playbook spec:\n  ${errors.join("\n  ")}`);
  }
  if ((r.strategies as unknown[]).length === 0) {
    errors.push(`strategies: must contain at least one entry`);
  }

  // ── per-strategy ──
  const seenIds = new Set<string>();
  const strategies: StrategySpec[] = [];
  (r.strategies as unknown[]).forEach((entry, i) => {
    const prefix = `strategies[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${prefix}: must be an object`);
      return;
    }
    const s = entry as Record<string, unknown>;
    if (s.id != null) {
      if (typeof s.id !== "string" || !NAME_PATTERN.test(s.id)) {
        errors.push(`${prefix}.id: must match ${NAME_PATTERN}`);
      } else if (seenIds.has(s.id)) {
        errors.push(`${prefix}.id: "${s.id}" is duplicated within the playbook`);
      } else {
        seenIds.add(s.id);
      }
    }
    if (typeof s.type !== "string") {
      errors.push(`${prefix}.type: required string ("order" | "schedule" | "rebalance")`);
      return;
    }
    switch (s.type) {
      case "order":
        validateOrderSpec(s, prefix, errors);
        strategies.push(s as unknown as OrderSpec);
        break;
      case "schedule":
        validateScheduleSpec(s, prefix, errors);
        strategies.push(s as unknown as ScheduleSpec);
        break;
      case "rebalance":
        validateRebalanceSpec(s, prefix, errors);
        strategies.push(s as unknown as RebalanceSpec);
        break;
      default:
        errors.push(
          `${prefix}.type: must be "order" | "schedule" | "rebalance" (got ${JSON.stringify(s.type)})`,
        );
    }
  });

  if (errors.length) {
    throw new ToolError("INVALID_PARAMS", `Invalid playbook spec:\n  ${errors.join("\n  ")}`);
  }

  return {
    name: r.name as string,
    version: (r.version as number | undefined) ?? 1,
    description: r.description as string | undefined,
    chain: r.chain as string | undefined,
    account: r.account as string | undefined,
    strategies,
  };
}

function validateOrderSpec(s: Record<string, unknown>, prefix: string, errors: string[]): void {
  if (s.side !== "buy" && s.side !== "sell") {
    errors.push(`${prefix}.side: must be "buy" or "sell"`);
  }
  if (
    s.trigger !== "price_below" &&
    s.trigger !== "price_above" &&
    s.trigger !== "trailing"
  ) {
    errors.push(`${prefix}.trigger: must be "price_below" | "price_above" | "trailing"`);
  }
  if (s.trigger === "trailing") {
    if (s.trailPct == null || typeof s.trailPct !== "number" || !(s.trailPct > 0 && s.trailPct <= 100)) {
      errors.push(`${prefix}.trailPct: required number in (0, 100] for trailing orders`);
    }
  } else if (s.trigger === "price_below" || s.trigger === "price_above") {
    if (s.price == null || typeof s.price !== "number" || !(s.price > 0)) {
      errors.push(`${prefix}.price: required positive number for ${s.trigger}`);
    }
  }
  if (typeof s.base !== "string" || s.base === "") {
    errors.push(`${prefix}.base: required non-empty string`);
  }
  if (typeof s.quote !== "string" || s.quote === "") {
    errors.push(`${prefix}.quote: required non-empty string`);
  }
  const hasBase = s.baseAmount != null;
  const hasQuote = s.quoteAmount != null;
  if (hasBase === hasQuote) {
    errors.push(`${prefix}: provide exactly one of baseAmount / quoteAmount`);
  }
  if (s.group != null) {
    if (typeof s.group !== "string" || !NAME_PATTERN.test(s.group)) {
      errors.push(`${prefix}.group: must match ${NAME_PATTERN}`);
    }
  }
  if (s.expiresAt != null && typeof s.expiresAt !== "string") {
    errors.push(`${prefix}.expiresAt: must be ISO-8601 string`);
  }
  if (s.slippageBps != null && (typeof s.slippageBps !== "number" || !Number.isInteger(s.slippageBps) || s.slippageBps <= 0 || s.slippageBps > 10_000)) {
    errors.push(`${prefix}.slippageBps: must be integer in (0, 10000]`);
  }
  if (s.onFill != null) {
    try {
      parseOnFillSpec(s.onFill);
    } catch (e) {
      errors.push(`${prefix}.onFill: ${(e as Error).message.replace(/\n\s*/g, " ")}`);
    }
  }
}

function validateScheduleSpec(s: Record<string, unknown>, prefix: string, errors: string[]): void {
  if (s.side !== "buy" && s.side !== "sell") {
    errors.push(`${prefix}.side: must be "buy" or "sell"`);
  }
  const hasCron = s.cron != null;
  const hasEvery = s.every != null;
  if (hasCron === hasEvery) {
    errors.push(`${prefix}: provide exactly one of cron / every`);
  }
  if (typeof s.base !== "string" || s.base === "") {
    errors.push(`${prefix}.base: required non-empty string`);
  }
  if (typeof s.quote !== "string" || s.quote === "") {
    errors.push(`${prefix}.quote: required non-empty string`);
  }
  const hasBase = s.baseAmount != null;
  const hasQuote = s.quoteAmount != null;
  if (hasBase === hasQuote) {
    errors.push(`${prefix}: provide exactly one of baseAmount / quoteAmount`);
  }
  if (s.maxRuns != null && (typeof s.maxRuns !== "number" || !Number.isInteger(s.maxRuns) || s.maxRuns <= 0)) {
    errors.push(`${prefix}.maxRuns: must be positive integer`);
  }
  if (s.onFill != null) {
    // Structural gate only — parseOnFillSpec checks the shape (type:
    // "createOrder", spec.side/trigger/amounts) without touching the
    // chain. Token resolution + fake-fill rendering happen at deploy
    // time so a template spec with {{VAR}} placeholders still parses.
    try {
      parseOnFillSpec(s.onFill);
    } catch (e) {
      errors.push(`${prefix}.onFill: ${(e as Error).message.replace(/\n\s*/g, " ")}`);
    }
  }
}

function validateRebalanceSpec(s: Record<string, unknown>, prefix: string, errors: string[]): void {
  if (!Array.isArray(s.targets)) {
    errors.push(`${prefix}.targets: required array of { token, targetPct }`);
    return;
  }
  if (s.targets.length === 0) {
    errors.push(`${prefix}.targets: must contain at least one entry`);
  }
  s.targets.forEach((t, j) => {
    const tp = `${prefix}.targets[${j}]`;
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      errors.push(`${tp}: must be an object`);
      return;
    }
    const tr = t as Record<string, unknown>;
    if (typeof tr.token !== "string" || tr.token === "") {
      errors.push(`${tp}.token: required non-empty string`);
    }
    if (typeof tr.targetPct !== "number" || !(tr.targetPct > 0) || tr.targetPct > 100) {
      errors.push(`${tp}.targetPct: required number in (0, 100]`);
    }
  });
  if (s.driftThresholdPct != null && (typeof s.driftThresholdPct !== "number" || s.driftThresholdPct <= 0 || s.driftThresholdPct > 100)) {
    errors.push(`${prefix}.driftThresholdPct: must be number in (0, 100]`);
  }
  if (s.minTradeUsd != null && (typeof s.minTradeUsd !== "number" || s.minTradeUsd < 0)) {
    errors.push(`${prefix}.minTradeUsd: must be non-negative number`);
  }
  if (s.maxRuns != null && (typeof s.maxRuns !== "number" || !Number.isInteger(s.maxRuns) || s.maxRuns <= 0)) {
    errors.push(`${prefix}.maxRuns: must be positive integer`);
  }
}

// ── canonical hashing ────────────────────────────────────────

/**
 * Compute a SHA-256 hex hash of the playbook spec. The hash is the
 * idempotency key — re-deploying with the same hash is a no-op, with
 * different hash is an error.
 *
 * Canonicalization rules: object keys sorted alphabetically at every
 * depth; numbers preserved as-is (no float normalization needed since
 * we only accept what the parser emitted); arrays preserved in order
 * (order is meaningful for strategy lists).
 */
export function hashSpec(spec: PlaybookSpec): string {
  const canonical = canonicalJSON(spec);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Exported for playbookReplace's field-change detection: a deployed
 *  spec round-trips through canonicalJSON (key-sorted) while the
 *  incoming spec is in author key order — comparing with plain
 *  JSON.stringify produces phantom "changed" flags on nested-object
 *  fields (rebalance targets). Canonical comparison is order-blind. */
export function canonicalJSON(v: unknown): string {
  if (v === undefined) return "null"; // JSON has no undefined; coerce to null
  if (v === null || typeof v !== "object") {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return "[" + v.map((x) => canonicalJSON(x)).join(",") + "]";
  }
  const obj = v as Record<string, unknown>;
  // Skip undefined-valued keys outright — these come from optional fields
  // that the parser leaves unset. Including them with "null" placeholders
  // would make the hash sensitive to "is the optional field present" vs
  // "is it set to null", which the user can't tell apart from the JSON they typed.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]))
      .join(",") +
    "}"
  );
}

// ── deploy ───────────────────────────────────────────────────

export interface DeployedItem {
  /** Local id within the playbook spec (the operator's `id` field, or
   *  `strategies[N]` when omitted). */
  localId: string;
  /** "order" | "schedule" | "rebalance" */
  type: StrategySpec["type"];
  /** Database row id assigned by the primitive table. */
  rowId: number;
  /** Human-readable summary: "sell 1 ETH @ trail 5%", "buy 100 USDC every 7d", etc. */
  summary: string;
}

export interface DeployResult {
  /** Database row id of the playbook record. */
  playbookId: number;
  /** Already deployed (idempotent re-deploy of same hash). */
  alreadyDeployed: boolean;
  /** Per-strategy outcome. Empty when alreadyDeployed=true. */
  items: DeployedItem[];
}

/**
 * Deploy a parsed playbook spec atomically.
 *
 * Steps:
 *   1. Idempotency check: look up an active playbook by name. If found
 *      with the same hash → return alreadyDeployed=true. If different
 *      hash → throw INVALID_PARAMS asking to destroy first.
 *   2. Insert playbook row with status='deploying'. Now we have the
 *      playbook id available for strategy-tag stamping.
 *   3. For each strategy, create the row via the primitive's
 *      createRow helper. Group names are prefixed with `pb<id>-`.
 *      Stamp `strategy = playbook:<id>` so tear-down can find them.
 *   4. On any failure, rollback: cancel each already-created primitive
 *      + delete the playbook row → leave the system in pre-deploy state.
 *   5. On success, flip status to 'deployed'.
 *
 * Returns the playbook id + per-item outcome.
 */
export function deployPlaybook(args: {
  spec: PlaybookSpec;
  sourcePath: string | null;
  config?: Config;
  /** Iter30: cascade-set the paper flag on every primitive in the
   *  spec. Used by `tradekit playbook deploy --paper` to validate a
   *  fresh playbook against live market conditions without risking
   *  capital. Per-primitive paper overrides in the spec itself are
   *  NOT supported in v1 — paper is a deploy-time switch. */
  paper?: boolean;
}): DeployResult {
  const { spec, sourcePath } = args;
  const config = args.config ?? loadConfig();
  const paper = args.paper === true;

  const specJson = canonicalJSON(spec);
  const hash = hashSpec(spec);

  const existing = findActivePlaybookByName(spec.name);
  if (existing) {
    if (existing.source_hash === hash) {
      return { playbookId: existing.id, alreadyDeployed: true, items: [] };
    }
    // Recovery paths, best first: playbook_replace applies the new spec
    // to the EXISTING deployment with state preservation (trailing HWM,
    // run counters survive) — destroy+redeploy is the state-losing
    // fallback. Both exist as MCP tools, so structured nextActions are
    // attached for agent dispatch (errors.test.ts pins the tool names).
    throw new ToolError(
      "INVALID_PARAMS",
      `Playbook "${spec.name}" is already deployed as #${existing.id} with a different spec. ` +
        `To iterate on the deployed strategy WITHOUT losing running state, use ` +
        `\`tradekit playbook replace ${existing.id} <spec-file>\` (or the playbook_replace MCP tool). ` +
        `To start over, destroy first with \`tradekit playbook destroy ${existing.id}\`, then redeploy.`,
      {
        details: {
          existing_id: existing.id,
          existing_hash: existing.source_hash,
          incoming_hash: hash,
        },
        nextActions: [
          {
            tool: "playbook_diff",
            params: { id: existing.id },
            reason: "Preview what the new spec would change against the deployed playbook (read-only).",
          },
          {
            tool: "playbook_replace",
            params: { id: existing.id, yes: true },
            reason: "Apply the new spec to the existing deployment — preserves trailing HWM + run counters where possible.",
          },
          {
            tool: "playbook_destroy",
            params: { id: existing.id, yes: true },
            reason: "Tear down the existing deployment to start fresh (loses all running state).",
          },
        ],
      },
    );
  }

  const playbookId = insertPlaybook({
    name: spec.name,
    sourcePath,
    sourceHash: hash,
    specJson,
  });

  const items: DeployedItem[] = [];
  const strategyTag = `playbook:${playbookId}`;
  try {
    spec.strategies.forEach((entry, i) => {
      const localId = entry.id ?? `strategies[${i}]`;
      const created = createOnePrimitive({
        entry,
        localId,
        playbookId,
        strategyTag,
        spec,
        config,
        paper,
      });
      items.push(created);
    });
    updatePlaybookStatus(playbookId, "deployed");
    return { playbookId, alreadyDeployed: false, items };
  } catch (err) {
    rollbackPlaybook(playbookId, items);
    if (err instanceof ToolError) {
      throw new ToolError(
        err.code,
        `Playbook "${spec.name}" deploy failed and was rolled back: ${err.message}`,
        {
          details: { ...(err.details ?? {}), playbookId, rolledBack: items.length },
          ...(err.nextActions ? { nextActions: err.nextActions } : {}),
          cause: err,
        },
      );
    }
    throw err;
  }
}

/** Iter29: exported for the playbook-replace orchestrator which
 *  reuses this single create-path to ensure identical semantics
 *  (group namespacing, strategy tag, default chain/account, etc.)
 *  between fresh deploys and replaces. */
export function createOnePrimitive(args: {
  entry: StrategySpec;
  localId: string;
  playbookId: number;
  strategyTag: string;
  spec: PlaybookSpec;
  config: Config;
  /** Iter30: when true the produced primitives are marked paper.
   *  v27: applies to ALL three primitive types — orders, schedules,
   *  AND rebalance plans (paper rebalance evaluates drift against the
   *  virtual book and fires legs through executePaperTrade). */
  paper?: boolean;
}): DeployedItem {
  const { entry, localId, playbookId, strategyTag, spec, config } = args;
  const paper = args.paper === true;
  const chainName = entry.chain ?? spec.chain ?? config.activeChain;
  const profile = resolveProfile(chainName, config);
  // `account` is a label string the engine resolves at fire-time. We don't
  // pre-resolve here — the live engine call (executeTrade) does it via
  // resolveWalletForAccount, with the same error semantics as a manual
  // `tradekit order create --account L`. Pre-resolving would just double
  // the failure points without catching anything the create-row validators
  // don't catch later.
  const accountLabel = entry.account ?? spec.account ?? "default";

  switch (entry.type) {
    case "order": {
      const pair = resolveTradePair(profile, entry.base, entry.quote);
      const createArgs: CreateOrderArgs = {
        side: entry.side,
        trigger: entry.trigger,
        targetPriceUsd: entry.trigger === "trailing" ? entry.price : entry.price,
        trailPct: entry.trailPct,
        chain: profile.name,
        account: accountLabel,
        base: pair.base,
        quote: pair.quote,
        baseAmount: entry.baseAmount != null ? String(entry.baseAmount) : undefined,
        quoteAmount: entry.quoteAmount != null ? String(entry.quoteAmount) : undefined,
        slippageBps: entry.slippageBps,
        autoSlippage: entry.autoSlippage,
        expiresAt: entry.expiresAt,
        strategy: strategyTag,
        note: entry.note,
        group: entry.group ? `pb${playbookId}-${entry.group}` : undefined,
        paper,
        onFill: entry.onFill,
      };
      const row = createOrderRow(createArgs, config);
      return {
        localId,
        type: "order",
        rowId: row.id!,
        summary: describeOrder(entry),
      };
    }
    case "schedule": {
      const pair = resolveTradePair(profile, entry.base, entry.quote);
      const createArgs: CreateScheduleArgs = {
        name: entry.name,
        cron: entry.cron,
        every: entry.every,
        side: entry.side,
        chain: profile.name,
        account: accountLabel,
        base: pair.base,
        quote: pair.quote,
        baseAmount: entry.baseAmount != null ? String(entry.baseAmount) : undefined,
        quoteAmount: entry.quoteAmount != null ? String(entry.quoteAmount) : undefined,
        slippageBps: entry.slippageBps,
        autoSlippage: entry.autoSlippage,
        startAt: entry.startAt,
        endAt: entry.endAt,
        maxRuns: entry.maxRuns,
        strategy: strategyTag,
        note: entry.note,
        onFill: entry.onFill,
        paper,
      };
      const row = createScheduleRow(createArgs, config);
      return {
        localId,
        type: "schedule",
        rowId: row.id!,
        summary: describeSchedule(entry),
      };
    }
    case "rebalance": {
      // v27: rebalance is paper-aware — a `--paper` deploy now cascades to
      // rebalance entries too (drift evaluated against the virtual book,
      // legs routed through executePaperTrade). Pre-v27 this branch
      // rejected paper deploys containing rebalance entries outright.
      const createArgs: CreateRebalancePlanArgs = {
        name: entry.name,
        account: accountLabel,
        chain: profile.name,
        quoteToken: entry.quoteToken,
        targets: entry.targets,
        driftThresholdPct: entry.driftThresholdPct,
        minTradeUsd: entry.minTradeUsd,
        cron: entry.cron,
        startAt: entry.startAt,
        endAt: entry.endAt,
        maxRuns: entry.maxRuns,
        slippageBps: entry.slippageBps,
        autoSlippage: entry.autoSlippage,
        strategy: strategyTag,
        note: entry.note,
        paper,
      };
      const row = createRebalancePlanRow(createArgs, config);
      return {
        localId,
        type: "rebalance",
        rowId: row.id!,
        summary: describeRebalance(entry),
      };
    }
  }
}

/** Iter29: exported for the playbookReplace diff renderer. */
export function describeOrder(s: OrderSpec): string {
  const amount = s.baseAmount != null ? `${s.baseAmount} ${s.base}` : `${s.quoteAmount} ${s.quote}`;
  if (s.trigger === "trailing") {
    return `${s.side} ${amount} — trailing ${s.trailPct}% (activation $${s.price ?? "now"})`;
  }
  return `${s.side} ${amount} — ${s.trigger} $${s.price}`;
}

/** Iter29: exported for the playbookReplace diff renderer. */
export function describeSchedule(s: ScheduleSpec): string {
  const amount = s.baseAmount != null ? `${s.baseAmount} ${s.base}` : `${s.quoteAmount} ${s.quote}`;
  const cadence = s.cron ? `cron "${s.cron}"` : `every ${s.every}`;
  return `${s.side} ${amount} ${cadence}` + (s.maxRuns ? ` (max ${s.maxRuns})` : "");
}

/** Iter29: exported for the playbookReplace diff renderer. */
export function describeRebalance(s: RebalanceSpec): string {
  const tgts = s.targets.map((t) => `${t.token}=${t.targetPct}%`).join(" / ");
  return `targets ${tgts} (drift>${s.driftThresholdPct ?? 5}%)`;
}

/** Cancel every primitive created during a failed deploy + remove the
 *  playbook row entirely. Best-effort: a cancel failure on one row
 *  doesn't stop us trying the rest; we collect errors for the outer
 *  caller to surface but don't throw mid-rollback. */
function rollbackPlaybook(playbookId: number, items: DeployedItem[]): void {
  for (const item of items) {
    try {
      cancelByType(item.type, item.rowId);
    } catch {
      // Swallow — rollback is best-effort. The playbook row gets removed
      // either way; the operator can manually clean up any orphans via
      // `tradekit order/schedule/rebalance list --strategy playbook:<id>`.
    }
  }
  try {
    deletePlaybook(playbookId);
  } catch {
    // If even the playbook-row delete fails, mark it 'failed' as a
    // forensic breadcrumb. Future deploys with the same name will see
    // the 'failed' row and require manual cleanup.
    try {
      updatePlaybookStatus(playbookId, "failed");
    } catch {
      /* give up */
    }
  }
}

/** Iter29: exported for the playbookReplace orchestrator which
 *  needs to cancel primitives identified via the same type union. */
export function cancelByType(type: StrategySpec["type"], rowId: number): void {
  switch (type) {
    case "order":
      cancelOrderById(rowId);
      return;
    case "schedule":
      cancelScheduleById(rowId);
      return;
    case "rebalance":
      cancelRebalancePlanById(rowId);
      return;
  }
}

// ── destroy ──────────────────────────────────────────────────

export interface DestroyResult {
  playbookId: number;
  /** Primitives that were active when destroy began + got cancelled. */
  cancelled: Array<{ type: StrategySpec["type"]; rowId: number }>;
  /** Primitives that were already in a terminal state (filled, expired,
   *  cancelled, completed) when destroy began. Left alone. */
  alreadyTerminal: Array<{ type: StrategySpec["type"]; rowId: number; status: string }>;
  /** Errors collected during cancel — destroy continues past them so
   *  partial-cancel state doesn't get worse on a per-row failure. */
  errors: Array<{ type: StrategySpec["type"]; rowId: number; message: string }>;
}

/**
 * Tear down a deployed playbook. Cancels every primitive owned by the
 * playbook (orders / schedules / rebalance plans tagged
 * `playbook:<id>`) and marks the playbook row 'destroyed'.
 *
 * Idempotent: calling destroy on an already-destroyed playbook returns
 * a result with empty cancelled lists. Already-terminal primitives are
 * reported separately so the operator sees what was historically owned
 * by the playbook.
 *
 * Cancel errors are collected but don't abort — a corrupt OCO peer
 * shouldn't prevent destroying the rest of the playbook.
 */
export function destroyPlaybook(playbookId: number): DestroyResult {
  const playbook = getPlaybookById(playbookId);
  if (!playbook) {
    throw new ToolError("INVALID_PARAMS", `No playbook with id ${playbookId}.`);
  }
  if (playbook.status === "destroyed") {
    return {
      playbookId,
      cancelled: [],
      alreadyTerminal: [],
      errors: [],
    };
  }

  const tag = `playbook:${playbookId}`;
  const result: DestroyResult = {
    playbookId,
    cancelled: [],
    alreadyTerminal: [],
    errors: [],
  };

  // Orders.
  for (const order of listOrders({ status: "all", strategy: tag })) {
    handleOnePrimitive("order", order.id!, order.status, () => cancelOrderById(order.id!), result);
  }
  // Schedules.
  for (const sched of listSchedules({ status: "all", strategy: tag })) {
    handleOnePrimitive("schedule", sched.id!, sched.status, () => cancelScheduleById(sched.id!), result);
  }
  // Rebalance plans.
  for (const plan of listRebalancePlans({ status: "all", strategy: tag })) {
    handleOnePrimitive("rebalance", plan.id!, plan.status, () => cancelRebalancePlanById(plan.id!), result);
  }

  updatePlaybookStatus(playbookId, "destroyed");
  return result;
}

function handleOnePrimitive(
  type: StrategySpec["type"],
  rowId: number,
  status: string,
  cancelFn: () => void,
  out: DestroyResult,
): void {
  const terminal =
    status === "filled" ||
    status === "cancelled" ||
    status === "expired" ||
    status === "failed" ||
    status === "completed";
  if (terminal) {
    out.alreadyTerminal.push({ type, rowId, status });
    return;
  }
  try {
    cancelFn();
    out.cancelled.push({ type, rowId });
  } catch (e) {
    out.errors.push({ type, rowId, message: (e as Error).message });
  }
}

// ── show / list helpers (CLI-facing) ─────────────────────────

// ── promote (paper ⇄ real, in place) ─────────────────────────

export interface PromoteResult {
  playbookId: number;
  /** Target mode after the promotion. */
  to: "real" | "paper";
  /** Primitives whose paper flag was flipped IN PLACE — same row id,
   *  trailing HWM / run counters / drift telemetry all preserved. */
  flipped: Array<{ type: "order" | "schedule" | "rebalance"; rowId: number }>;
  /** Primitives left untouched, with the reason (already in the
   *  target mode, or in a terminal/non-editable status). */
  skipped: Array<{ type: "order" | "schedule" | "rebalance"; rowId: number; reason: string }>;
  /** True when every live primitive was already in the target mode —
   *  the promote was a no-op. */
  alreadyInTarget: boolean;
}

/**
 * Flip a deployed playbook between paper and real trading IN PLACE.
 *
 * Closes the dry-run loop's last manual step. The documented v1 path
 * was "destroy + redeploy without --paper" — which throws away
 * exactly the state the paper validation accumulated: trailing HWM
 * water marks, schedule run counters, rebalance drift telemetry.
 * Promote routes every live primitive through the SAME in-place edit
 * machinery operators use directly (orderEdit / scheduleEdit /
 * rebalanceEdit), so the strategy goes live mid-stride: a trailing
 * stop that tracked a $3,500 HWM in paper keeps protecting from
 * $3,500 the moment it's real.
 *
 * Scope rules:
 *   - orders: ACTIVE rows only (orders have no paused state; terminal
 *     rows are history, not strategy)
 *   - schedules + rebalance plans: ACTIVE + PAUSED (paused rows are
 *     legitimate promote targets — operator may resume later)
 *   - rows already in the target mode are reported as skipped
 *
 * Direction is symmetric: `to: "paper"` demotes a live strategy back
 * to the sandbox (e.g. after a config scare) without losing state.
 *
 * NOT checked here (deliberately): real balances. A paper strategy
 * may reference amounts the real wallet can't cover — that's the
 * same failure mode any real primitive has, surfaced at fire time
 * with the usual error trail + notifications. The CLI prints a
 * preflight reminder instead of hard-gating.
 */
export function promotePlaybook(args: {
  playbookId: number;
  to: "real" | "paper";
  config?: Config;
}): PromoteResult {
  const config = args.config ?? loadConfig();
  const playbook = getPlaybookById(args.playbookId);
  if (!playbook) {
    throw new ToolError("INVALID_PARAMS", `No playbook with id ${args.playbookId}.`);
  }
  if (playbook.status !== "deployed") {
    throw new ToolError(
      "INVALID_PARAMS",
      `Playbook #${args.playbookId} is "${playbook.status}" — only deployed playbooks can be promoted.`,
    );
  }
  const targetPaper = args.to === "paper";
  const strategyTag = `playbook:${args.playbookId}`;
  const orders = listOrders({ status: "all", strategy: strategyTag });
  const schedules = listSchedules({ status: "all", strategy: strategyTag });
  const rebalances = listRebalancePlans({ status: "all", strategy: strategyTag });

  if (orders.length + schedules.length + rebalances.length === 0) {
    throw new ToolError("INVALID_PARAMS", `Playbook #${args.playbookId} owns no primitives.`);
  }

  const flipped: PromoteResult["flipped"] = [];
  const skipped: PromoteResult["skipped"] = [];

  for (const o of orders) {
    if (o.id == null) continue;
    if (o.status !== "active") {
      skipped.push({ type: "order", rowId: o.id, reason: `status ${o.status}` });
      continue;
    }
    if ((o.paper ?? 0) === (targetPaper ? 1 : 0)) {
      skipped.push({ type: "order", rowId: o.id, reason: `already ${args.to}` });
      continue;
    }
    // editOrder journals the flip as edited_by_operator — the order's
    // forensic timeline shows exactly when it went live.
    editOrder({ id: o.id, changes: { paper: targetPaper }, config });
    flipped.push({ type: "order", rowId: o.id });
  }
  for (const sc of schedules) {
    if (sc.id == null) continue;
    if (sc.status !== "active" && sc.status !== "paused") {
      skipped.push({ type: "schedule", rowId: sc.id, reason: `status ${sc.status}` });
      continue;
    }
    if ((sc.paper ?? 0) === (targetPaper ? 1 : 0)) {
      skipped.push({ type: "schedule", rowId: sc.id, reason: `already ${args.to}` });
      continue;
    }
    editSchedule({ id: sc.id, changes: { paper: targetPaper }, config });
    flipped.push({ type: "schedule", rowId: sc.id });
  }
  for (const rb of rebalances) {
    if (rb.id == null) continue;
    if (rb.status !== "active" && rb.status !== "paused") {
      skipped.push({ type: "rebalance", rowId: rb.id, reason: `status ${rb.status}` });
      continue;
    }
    if ((rb.paper ?? 0) === (targetPaper ? 1 : 0)) {
      skipped.push({ type: "rebalance", rowId: rb.id, reason: `already ${args.to}` });
      continue;
    }
    editRebalancePlan({ id: rb.id, changes: { paper: targetPaper }, config });
    flipped.push({ type: "rebalance", rowId: rb.id });
  }

  return {
    playbookId: args.playbookId,
    to: args.to,
    flipped,
    skipped,
    alreadyInTarget: flipped.length === 0,
  };
}

export interface PlaybookDetail {
  row: PlaybookRow;
  spec: PlaybookSpec;
  orders: OrderRow[];
  schedules: ScheduleRow[];
  rebalances: RebalanceRow[];
}

/** Hydrate a playbook row + collect every primitive owned by it. Used
 *  by `playbook show <id>`. */
export function getPlaybookDetail(id: number): PlaybookDetail {
  const row = getPlaybookById(id);
  if (!row) throw new ToolError("INVALID_PARAMS", `No playbook with id ${id}.`);
  const tag = `playbook:${id}`;
  return {
    row,
    spec: JSON.parse(row.spec_json) as PlaybookSpec,
    orders: listOrders({ status: "all", strategy: tag }),
    schedules: listSchedules({ status: "all", strategy: tag }),
    rebalances: listRebalancePlans({ status: "all", strategy: tag }),
  };
}
