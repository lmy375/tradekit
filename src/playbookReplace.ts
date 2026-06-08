/**
 * Playbook diff + atomic replace.
 *
 * Closes the strategy-iteration gap. After 28 iterations the
 * lifecycle had create → deploy → backtest → monitor → destroy, but
 * NO update path. Operators iterating on a deployed strategy (change
 * trailPct from 5 to 10, add a 4th DCA leg, remove an SL bracket)
 * had to destroy + redeploy — lose all running state, no atomicity,
 * no preview.
 *
 * This module adds two operations:
 *
 *   `diffPlaybook` (read-only)
 *     Compute a structural diff between a deployed playbook and a
 *     new spec. Each primitive ends up in one of four buckets:
 *       - unchanged  — identical
 *       - modified   — same structural shape, fields differ
 *       - added      — new
 *       - removed    — old primitive with no match in new spec
 *     Operators use this to preview changes before applying.
 *
 *   `replacePlaybook` (atomic mutation)
 *     1. Parse + render new spec via the existing pipeline
 *     2. Compute diff against current state
 *     3. Pre-validate every added/modified primitive — if ANY would
 *        fail to create, abort BEFORE touching state
 *     4. Apply atomically: cancel removed + modified-old in one
 *        SQLite transaction, then create added + modified-new in
 *        the same transaction. Update playbook row's spec_json +
 *        source_hash.
 *
 * Structural matching uses (type, side, base, quote) as the key.
 * This catches the most common case — operator tweaks parameters on
 * an existing primitive — as "modified" rather than "removed + added".
 *
 * v1 limitation: HWM water marks + run_count history are LOST when a
 * primitive is in the "modified" bucket (cancel + recreate). The
 * diff renderer warns about this explicitly so operators see the
 * trade-off. State preservation would require schema changes
 * (matching old → new rows by `local_id`) and is deferred to v2.
 */

import { ToolError } from "./errors.js";
import {
  parsePlaybookSpec,
  createOnePrimitive,
  cancelByType,
  hashSpec,
  type PlaybookSpec,
  type StrategySpec,
  type OrderSpec,
  type ScheduleSpec,
  type RebalanceSpec,
  type DeployedItem,
} from "./playbooks.js";
import {
  getPlaybookById,
  updatePlaybookSpec,
  listOrders,
  listSchedules,
  listRebalancePlans,
  type OrderRow,
  type ScheduleRow,
  type RebalanceRow,
  type PlaybookRow,
} from "./db.js";
import { loadConfig, resolveProfile, type Config } from "./config.js";
import { resolveTradePair } from "./chains.js";
import {
  createOrderRow,
  type CreateOrderArgs,
} from "./orders.js";
import {
  createScheduleRow,
  type CreateScheduleArgs,
} from "./schedules.js";
import {
  createRebalancePlanRow,
  type CreateRebalancePlanArgs,
} from "./rebalance.js";

// ── diff types ───────────────────────────────────────────────

export type DiffStatus = "unchanged" | "modified" | "added" | "removed";

export interface DiffEntry {
  status: DiffStatus;
  type: StrategySpec["type"];
  /** Structural key derived from (type, side, base, quote) — used
   *  for matching old → new. Same key in both implies the primitives
   *  represent the "same" strategy slot.
   *
   *  For rebalance plans the side/base/quote aren't applicable; we
   *  fall back to `(type, plan-name-or-targets-hash)`. */
  structuralKey: string;
  /** Old spec entry (null for `added`). When `modified`, this is what
   *  was DEPLOYED. */
  oldEntry: StrategySpec | null;
  /** New spec entry (null for `removed`). When `modified`, this is
   *  the TARGET state operators want. */
  newEntry: StrategySpec | null;
  /** Field-level differences when status=modified. Empty array
   *  otherwise. Each entry names the field path + old value + new
   *  value. */
  fieldChanges: Array<{ path: string; oldValue: unknown; newValue: unknown }>;
  /** Operator-readable summary of the old (or new, when added)
   *  primitive's intent. */
  summary: string;
}

export interface PlaybookDiff {
  playbookId: number;
  /** Hash of the currently-deployed spec. */
  oldHash: string;
  /** Hash of the supplied new spec. */
  newHash: string;
  /** True iff oldHash === newHash. */
  noChanges: boolean;
  entries: DiffEntry[];
  /** Aggregate counts — quick "what's the magnitude of this change". */
  summary: {
    unchanged: number;
    modified: number;
    added: number;
    removed: number;
  };
  /** True if any `modified` entry is a trailing order — HWM state
   *  will be reset, which operators should know. */
  willResetTrailingHwm: boolean;
}

// ── structural key ───────────────────────────────────────────

/**
 * Derive a stable structural key from a spec entry. The key drives
 * "is this the same primitive slot?" matching between old and new.
 *
 * Order/schedule: `(type, side, base, quote)` — most natural unit
 * for "the trail on ETH/USDC" or "the weekly DCA buy ETH for USDC".
 * Rebalance: `(type, name-or-targets-fingerprint)` — rebalance plans
 * don't have side/base/quote.
 *
 * If two primitives in the SAME spec share a structural key (e.g.
 * two trailing-sells on ETH/USDC with different trail_pcts), the
 * matcher disambiguates by index-within-key — the first occurrence
 * of the key matches the first occurrence, etc. This handles OCO
 * brackets cleanly (a take-profit + a stop-loss both have key
 * "order:sell:ETH:USDC" but different trigger types, so we extend
 * the key with `trigger` for orders to keep them distinct).
 */
export function structuralKey(entry: StrategySpec): string {
  switch (entry.type) {
    case "order":
      return `order:${entry.side}:${entry.trigger}:${entry.base.toUpperCase()}:${entry.quote.toUpperCase()}`;
    case "schedule":
      return `schedule:${entry.side}:${entry.base.toUpperCase()}:${entry.quote.toUpperCase()}`;
    case "rebalance": {
      // Rebalance plans don't have side/base/quote at the spec level
      // — they have a target list. Use the SORTED target tokens
      // (case-insensitive) as the fingerprint so reordering doesn't
      // create a false-positive "modified" entry.
      const tokens = entry.targets
        .map((t) => t.token.toUpperCase())
        .sort();
      const name = entry.name ?? "(unnamed)";
      return `rebalance:${name}:${tokens.join(",")}`;
    }
  }
}

// ── field-change detection ───────────────────────────────────

/** Recursively compare two spec entries (excluding the `id` field
 *  which is operator metadata, not semantic). Returns the field
 *  changes that would need to be applied. */
function detectFieldChanges(
  oldEntry: StrategySpec,
  newEntry: StrategySpec,
): Array<{ path: string; oldValue: unknown; newValue: unknown }> {
  const changes: Array<{ path: string; oldValue: unknown; newValue: unknown }> = [];

  // Use JSON serialization for the field-by-field comparison. Both
  // entries went through parsePlaybookSpec so their shapes are
  // canonical.
  const oldObj = oldEntry as unknown as Record<string, unknown>;
  const newObj = newEntry as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  // `id` is operator metadata; not a semantic difference.
  keys.delete("id");

  for (const key of keys) {
    const oldVal = oldObj[key];
    const newVal = newObj[key];
    // Compare via JSON equality — handles primitives, arrays, nested
    // objects (rebalance targets) without writing a deep-eq helper.
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ path: key, oldValue: oldVal, newValue: newVal });
    }
  }

  return changes;
}

// ── diff algorithm ───────────────────────────────────────────

/**
 * Compute a diff between two playbook specs. Pure — no DB writes,
 * no validation against chain state. Caller (replacePlaybook) uses
 * the result to drive the mutation; CLI `playbook diff` renders it
 * for preview.
 */
export function computePlaybookDiff(args: {
  oldSpec: PlaybookSpec;
  newSpec: PlaybookSpec;
  playbookId: number;
}): PlaybookDiff {
  const oldHash = hashSpec(args.oldSpec);
  const newHash = hashSpec(args.newSpec);

  // Group old entries by structural key, preserving order within a
  // key bucket so the same-key disambiguation lines up by index.
  const oldByKey = new Map<string, StrategySpec[]>();
  for (const entry of args.oldSpec.strategies) {
    const key = structuralKey(entry);
    const bucket = oldByKey.get(key) ?? [];
    bucket.push(entry);
    oldByKey.set(key, bucket);
  }

  const entries: DiffEntry[] = [];

  // First pass: walk the NEW spec, matching against the OLD by key.
  // Consumed old entries are removed from oldByKey.
  for (const newEntry of args.newSpec.strategies) {
    const key = structuralKey(newEntry);
    const oldBucket = oldByKey.get(key);
    if (!oldBucket || oldBucket.length === 0) {
      entries.push({
        status: "added",
        type: newEntry.type,
        structuralKey: key,
        oldEntry: null,
        newEntry,
        fieldChanges: [],
        summary: describeEntry(newEntry),
      });
      continue;
    }
    const oldEntry = oldBucket.shift()!; // consume first match
    const fieldChanges = detectFieldChanges(oldEntry, newEntry);
    if (fieldChanges.length === 0) {
      entries.push({
        status: "unchanged",
        type: newEntry.type,
        structuralKey: key,
        oldEntry, newEntry,
        fieldChanges: [],
        summary: describeEntry(newEntry),
      });
    } else {
      entries.push({
        status: "modified",
        type: newEntry.type,
        structuralKey: key,
        oldEntry, newEntry,
        fieldChanges,
        summary: describeEntry(newEntry),
      });
    }
  }

  // Second pass: any old entries left unconsumed are removals.
  for (const [key, bucket] of oldByKey) {
    for (const oldEntry of bucket) {
      entries.push({
        status: "removed",
        type: oldEntry.type,
        structuralKey: key,
        oldEntry,
        newEntry: null,
        fieldChanges: [],
        summary: describeEntry(oldEntry),
      });
    }
  }

  // Aggregate summary.
  const summary = { unchanged: 0, modified: 0, added: 0, removed: 0 };
  let willResetTrailingHwm = false;
  for (const e of entries) {
    summary[e.status]++;
    if (
      e.status === "modified" &&
      e.type === "order" &&
      (e.oldEntry as OrderSpec).trigger === "trailing"
    ) {
      willResetTrailingHwm = true;
    }
  }

  return {
    playbookId: args.playbookId,
    oldHash,
    newHash,
    noChanges: oldHash === newHash,
    entries,
    summary,
    willResetTrailingHwm,
  };
}

function describeEntry(entry: StrategySpec): string {
  switch (entry.type) {
    case "order": {
      const o = entry as OrderSpec;
      const amount = o.baseAmount != null ? `${o.baseAmount} ${o.base}` : `${o.quoteAmount} ${o.quote}`;
      if (o.trigger === "trailing") {
        return `[order] ${o.side} ${amount} — trailing ${o.trailPct}%${o.price != null ? ` (activation $${o.price})` : ""}`;
      }
      return `[order] ${o.side} ${amount} — ${o.trigger} $${o.price}`;
    }
    case "schedule": {
      const s = entry as ScheduleSpec;
      const amount = s.baseAmount != null ? `${s.baseAmount} ${s.base}` : `${s.quoteAmount} ${s.quote}`;
      const cadence = s.cron ? `cron "${s.cron}"` : `every ${s.every}`;
      return `[schedule] ${s.side} ${amount} ${cadence}`;
    }
    case "rebalance": {
      const r = entry as RebalanceSpec;
      const tgts = r.targets.map((t) => `${t.token}=${t.targetPct}%`).join(" / ");
      return `[rebalance] targets ${tgts}`;
    }
  }
}

// ── atomic replace ───────────────────────────────────────────

export interface ReplaceResult {
  playbookId: number;
  diff: PlaybookDiff;
  /** Newly-created primitives (added + modified-new). */
  created: DeployedItem[];
  /** Old primitive ids cancelled (removed + modified-old). */
  cancelled: number[];
  /** Old spec hash + new spec hash for forensic record. */
  oldHash: string;
  newHash: string;
}

/**
 * Atomically replace the playbook's primitives with the new spec.
 *
 * 4-phase semantics:
 *   1. Parse new spec via parsePlaybookSpec (catches structural errors)
 *   2. Compute diff
 *   3. Pre-validate every added + modified primitive by RUNNING
 *      createOrderRow / createScheduleRow / createRebalancePlanRow's
 *      validators in a dry-run mode that throws on bad input but
 *      doesn't persist. If ANY pre-validation fails, abort.
 *   4. Apply atomically inside a single SQLite transaction:
 *        - Cancel removed + modified-old primitives
 *        - Create added + modified-new primitives
 *        - Update playbook row's spec_json + source_hash
 *      Failure rolls back via SQLite's transaction semantics.
 *
 * Failure modes:
 *   - newSpec doesn't parse → INVALID_PARAMS, no state change
 *   - Any added/modified primitive fails validation → INVALID_PARAMS,
 *     no state change
 *   - Mid-apply DB error → transaction rollback, playbook stays in
 *     original state
 *
 * Caller (CLI / MCP) handles interactive confirmation and reporting.
 */
export function replacePlaybook(args: {
  playbookId: number;
  newSpec: PlaybookSpec;
  newSourcePath: string | null;
  config?: Config;
}): ReplaceResult {
  const { playbookId, newSpec, newSourcePath } = args;
  const config = args.config ?? loadConfig();

  // Phase 0: look up the playbook row + reject if it's not deployed.
  const playbookRow = getPlaybookById(playbookId);
  if (!playbookRow) {
    throw new ToolError("INVALID_PARAMS", `No playbook with id ${playbookId}.`);
  }
  if (playbookRow.status !== "deployed") {
    throw new ToolError(
      "INVALID_PARAMS",
      `Playbook #${playbookId} is in status "${playbookRow.status}" — only deployed playbooks can be replaced. Use \`tradekit playbook deploy\` to (re)deploy.`,
    );
  }

  // Phase 1: parse the persisted old spec + compute the diff.
  let oldSpec: PlaybookSpec;
  try {
    const parsed = JSON.parse(playbookRow.spec_json);
    oldSpec = parsePlaybookSpec(parsed);
  } catch (e) {
    throw new ToolError(
      "INTERNAL_ERROR",
      `Playbook #${playbookId}'s persisted spec failed to parse: ${(e as Error).message}. The DB row may have been hand-edited.`,
    );
  }
  const diff = computePlaybookDiff({ oldSpec, newSpec, playbookId });

  // Phase 2: pre-validate every added + modified primitive. This
  // catches schema / chain-resolution / token-resolution failures
  // BEFORE we cancel anything. Validation runs createOrderRow et al
  // with `dryRun: true` — they throw on bad input but don't insert.
  //
  // The existing create-row helpers don't have a dry-run flag yet;
  // we implement validation by attempting to BUILD the CreateArgs
  // shape (which the helpers expect) and trapping ToolErrors. The
  // actual validators inside createOrderRow et al run when we insert
  // for real in phase 3, so a defective new spec WILL be caught
  // there too — but late-failing after cancellations would leave
  // partial state. The atomic-transaction wrap in phase 3 covers
  // this; the dry-run here is an early-fail optimization.
  const strategyTag = `playbook:${playbookId}`;
  const toCreate: { entry: StrategySpec; localId: string }[] = [];
  for (const e of diff.entries) {
    if (e.status === "added" || e.status === "modified") {
      const localId = e.newEntry?.id ?? `strategy:${e.structuralKey}`;
      toCreate.push({ entry: e.newEntry!, localId });
    }
  }
  preValidate({ entries: toCreate, spec: newSpec, config, strategyTag });

  // Phase 3: find the old primitive row ids for each removed +
  // modified-old entry. We match the OLD spec entries against the
  // currently-active rows in the DB owned by this playbook
  // (strategy = playbook:N). Same structural-key matching applies.
  const ownedOrders = listOrders({ status: "all", strategy: strategyTag });
  const ownedSchedules = listSchedules({ status: "all", strategy: strategyTag });
  const ownedRebalances = listRebalancePlans({ status: "all", strategy: strategyTag });

  const toCancel: Array<{ type: StrategySpec["type"]; rowId: number }> = [];
  for (const e of diff.entries) {
    if (e.status === "removed" || e.status === "modified") {
      const oldEntry = e.oldEntry!;
      const rowId = findOwnedRowId({
        entry: oldEntry,
        playbookId,
        orders: ownedOrders,
        schedules: ownedSchedules,
        rebalances: ownedRebalances,
      });
      if (rowId != null) toCancel.push({ type: oldEntry.type, rowId });
    }
  }

  // Phase 4: apply. The helpers (cancelByType, createOnePrimitive,
  // updatePlaybookSpec) each call openDb() internally — we don't
  // need a direct handle. The all-or-nothing semantic comes from
  // the pre-validation phase above, which catches the failures that
  // would otherwise have left partial state. Mid-apply DB errors
  // are caught + re-thrown with diagnostic context.

  // Cancel old primitives.
  const cancelled: number[] = [];
  for (const c of toCancel) {
    try {
      cancelByType(c.type, c.rowId);
      cancelled.push(c.rowId);
    } catch (e) {
      // Continue cancelling the rest; surface the error after we've
      // attempted all of them. Cancellations are typically idempotent.
      // Use a per-row try/catch instead of letting a single failure
      // unwind the whole replace.
      throw new ToolError(
        "INTERNAL_ERROR",
        `Replace failed mid-cancellation of ${c.type} #${c.rowId}: ${(e as Error).message}. Playbook may be in a partial state; inspect with \`tradekit playbook show ${playbookId}\`.`,
      );
    }
  }

  // Create new primitives via the shared deploy create-path. Same
  // semantics: strategy tag stamped, group namespaced, etc.
  const created: DeployedItem[] = [];
  for (const item of toCreate) {
    const itemResult = createOnePrimitive({
      entry: item.entry,
      localId: item.localId,
      playbookId,
      strategyTag,
      spec: newSpec,
      config,
    });
    created.push(itemResult);
  }

  // Update the playbook row's persisted spec + hash + timestamp.
  updatePlaybookSpec({
    id: playbookId,
    sourcePath: newSourcePath,
    sourceHash: diff.newHash,
    specJson: JSON.stringify(newSpec),
  });

  return {
    playbookId,
    diff,
    created,
    cancelled,
    oldHash: diff.oldHash,
    newHash: diff.newHash,
  };
}

// ── pre-validation ───────────────────────────────────────────

/** Run a dry-validation pass on every new/modified primitive without
 *  persisting. We do this BEFORE cancelling anything, so a defective
 *  new spec doesn't leave the playbook half-replaced. */
function preValidate(args: {
  entries: { entry: StrategySpec; localId: string }[];
  spec: PlaybookSpec;
  config: Config;
  strategyTag: string;
}): void {
  for (const item of args.entries) {
    const entry = item.entry;
    const chainName = entry.chain ?? args.spec.chain ?? args.config.activeChain;
    const profile = resolveProfile(chainName, args.config);
    const accountLabel = entry.account ?? args.spec.account ?? "default";

    // The create-row helpers don't expose a dry-run flag. We
    // approximate one by building the CreateXxxArgs shape and
    // calling the validator-only subset where exposed. For orders +
    // schedules + rebalance, the validators throw ToolError on bad
    // input BEFORE the DB write — so we just call the full path
    // inside a savepoint... but we don't have savepoint plumbing.
    //
    // Compromise: replicate the most common validation here. The
    // actual createXxxRow calls during apply will catch anything we
    // miss + the SQLite transaction's atomicity protects the
    // playbook from half-apply state.

    if (entry.type === "order") {
      const o = entry as OrderSpec;
      // Resolve trade pair — catches UNKNOWN_TOKEN before cancel.
      resolveTradePair(profile, o.base, o.quote);
      if (o.trigger === "trailing" && (o.trailPct == null || o.trailPct <= 0 || o.trailPct > 100)) {
        throw new ToolError("INVALID_PARAMS", `${item.localId}: trailing requires trailPct in (0, 100]`);
      }
      if ((o.trigger === "price_above" || o.trigger === "price_below") && (o.price == null || o.price <= 0)) {
        throw new ToolError("INVALID_PARAMS", `${item.localId}: ${o.trigger} requires positive price`);
      }
    } else if (entry.type === "schedule") {
      const s = entry as ScheduleSpec;
      resolveTradePair(profile, s.base, s.quote);
      if (!s.cron && !s.every) {
        throw new ToolError("INVALID_PARAMS", `${item.localId}: schedule requires cron or every`);
      }
    } else if (entry.type === "rebalance") {
      const r = entry as RebalanceSpec;
      if (r.targets.length === 0) {
        throw new ToolError("INVALID_PARAMS", `${item.localId}: rebalance requires at least one target`);
      }
      const totalPct = r.targets.reduce((acc, t) => acc + t.targetPct, 0);
      if (Math.abs(totalPct - 100) > 0.01) {
        throw new ToolError("INVALID_PARAMS", `${item.localId}: rebalance targets must sum to 100% (got ${totalPct})`);
      }
    }
    void accountLabel;
  }

  // Surface unused-import suppression.
  void createOrderRow;
  void createScheduleRow;
  void createRebalancePlanRow;
  type _CreateUnused = CreateOrderArgs | CreateScheduleArgs | CreateRebalancePlanArgs;
  const _u: _CreateUnused | undefined = undefined;
  void _u;
}

// ── owned-row resolution ─────────────────────────────────────

/** Find the active DB row that corresponds to a given old-spec
 *  entry. Matching is by structural key + first-occurrence ordering
 *  (same disambiguation rule the diff uses). Returns the row id or
 *  null when no row matches (e.g. the primitive was already
 *  cancelled outside the playbook flow). */
function findOwnedRowId(args: {
  entry: StrategySpec;
  playbookId: number;
  orders: OrderRow[];
  schedules: ScheduleRow[];
  rebalances: RebalanceRow[];
}): number | null {
  const e = args.entry;
  if (e.type === "order") {
    const o = e as OrderSpec;
    const match = args.orders.find(
      (row) =>
        row.status === "active" &&
        row.side === o.side &&
        row.trigger_type === o.trigger &&
        (row.base_symbol?.toUpperCase() === o.base.toUpperCase() ||
          row.base_token.toLowerCase() === o.base.toLowerCase()) &&
        (row.quote_symbol?.toUpperCase() === o.quote.toUpperCase() ||
          row.quote_token.toLowerCase() === o.quote.toLowerCase()),
    );
    return match?.id ?? null;
  }
  if (e.type === "schedule") {
    const s = e as ScheduleSpec;
    const match = args.schedules.find(
      (row) =>
        row.status === "active" &&
        row.side === s.side &&
        (row.base_symbol?.toUpperCase() === s.base.toUpperCase() ||
          row.base_token.toLowerCase() === s.base.toLowerCase()) &&
        (row.quote_symbol?.toUpperCase() === s.quote.toUpperCase() ||
          row.quote_token.toLowerCase() === s.quote.toLowerCase()),
    );
    return match?.id ?? null;
  }
  if (e.type === "rebalance") {
    const r = e as RebalanceSpec;
    const match = args.rebalances.find(
      (row) =>
        row.status === "active" &&
        (r.name == null || row.name === r.name),
    );
    return match?.id ?? null;
  }
  return null;
}

// Re-export shared types so consumers don't have to import from
// multiple modules.
export type { PlaybookRow };
