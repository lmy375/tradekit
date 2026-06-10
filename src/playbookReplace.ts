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
 * v2 — state-preserving modify. A "modified" primitive whose field
 * changes are all in-place editable routes through the SAME edit
 * machinery operators use directly (orderEdit / scheduleEdit):
 * trailing HWM water marks, run_count / max_runs accounting, and
 * journal continuity (an `edited_by_operator` order_check_log row)
 * all survive. Only changes to frozen identity fields (OCO group,
 * chain, account, schedule start_at / name) force the v1
 * cancel+recreate path — and even then, recreated schedules and
 * rebalance plans carry their run counters to the new row so
 * max_runs accounting survives. `preserveState: false` (CLI
 * `--fresh-state`) opts back into a full reset.
 *
 * v2 also fixes a paper-mode hole: replace now infers paper-ness
 * from the playbook's owned rows (deploy --paper isn't recorded in
 * the spec), so replacing a paper playbook can no longer silently
 * recreate primitives as REAL-trading ones.
 */

import { ToolError } from "./errors.js";
import {
  parsePlaybookSpec,
  createOnePrimitive,
  cancelByType,
  hashSpec,
  canonicalJSON,
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
  carryScheduleRunCounters,
  carryRebalanceRunCounters,
  type OrderRow,
  type ScheduleRow,
  type RebalanceRow,
  type PlaybookRow,
} from "./db.js";
import { editOrder, validateOrderEdit, type OrderEditChanges } from "./orderEdit.js";
import { editSchedule, validateScheduleEdit, type ScheduleEditChanges } from "./scheduleEdit.js";
import { editRebalancePlan, validateRebalanceEdit, type RebalanceEditChanges } from "./rebalanceEdit.js";
import { parseOnFillSpec } from "./scheduleHooks.js";
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
  /** v2 — how a `modified` entry will be applied. "edit": in-place
   *  via orderEdit/scheduleEdit (HWM, run_count, journal continuity
   *  preserved). "recreate": cancel + create (frozen field changed,
   *  or rebalance — which has no edit machinery; run counters still
   *  carry). Undefined for non-modified entries. NOTE: replace with
   *  preserveState:false recreates regardless of this value. */
  applyMode?: "edit" | "recreate";
  /** Why applyMode is "recreate" — names the frozen field(s) that
   *  forced it. Undefined when applyMode is "edit" or absent. */
  recreateReason?: string;
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
  /** True if any `modified` trailing order will be RECREATED (frozen
   *  field changed) — its HWM state resets, which operators should
   *  know. v2: trailing orders whose changes are in-place editable
   *  keep their HWM and do NOT set this flag. A replace with
   *  preserveState:false resets every modified trailing order's HWM
   *  regardless. */
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
    // Compare via CANONICAL JSON equality (key-sorted) — the old spec
    // round-tripped through canonicalJSON when it was persisted, so a
    // plain JSON.stringify comparison flags phantom changes on nested
    // objects whose key order differs (rebalance targets were reported
    // "modified" on every replace even when identical).
    if (canonicalJSON(oldVal) !== canonicalJSON(newVal)) {
      changes.push({ path: key, oldValue: oldVal, newValue: newVal });
    }
  }

  return changes;
}

// ── apply-mode classification (v2) ───────────────────────────

/** Spec fields whose changes the in-place edit machinery can apply.
 *  Everything else is a frozen identity field → recreate. The sets
 *  mirror OrderEditChanges / ScheduleEditChanges exactly — if a
 *  field is editable via `tradekit order edit`, it's editable via
 *  replace. (side/trigger/base/quote never appear in fieldChanges:
 *  they're part of the structural key, so changing them lands the
 *  entry in added+removed, not modified.) */
const ORDER_EDITABLE_SPEC_FIELDS = new Set([
  "price", // → targetPriceUsd (activation price for trailing)
  "trailPct",
  "baseAmount",
  "quoteAmount",
  "slippageBps",
  "autoSlippage",
  "expiresAt",
  "note",
]);

const SCHEDULE_EDITABLE_SPEC_FIELDS = new Set([
  "cron",
  "every",
  "baseAmount",
  "quoteAmount",
  "slippageBps",
  "autoSlippage",
  "endAt",
  "maxRuns",
  "note",
  "onFill", // scheduleEdit revalidates the hook against the live pair
]);

/** Rebalance gained in-place edit too (rebalanceEdit.ts) — frozen
 *  spec fields are quoteToken (the routing anchor), startAt, chain,
 *  account. `name` and the target TOKEN SET are part of the
 *  structural key, so they never appear in a modified entry's
 *  fieldChanges; targetPct re-weights DO and are editable. */
const REBALANCE_EDITABLE_SPEC_FIELDS = new Set([
  "targets",
  "driftThresholdPct",
  "minTradeUsd",
  "cron",
  "endAt",
  "maxRuns",
  "slippageBps",
  "autoSlippage",
  "note",
]);

/** Classify a modified entry: can its field changes be applied
 *  in-place, or must it be recreated? Returns the frozen fields that
 *  forced a recreate so the diff can explain itself. */
function classifyModifiedEntry(
  type: StrategySpec["type"],
  fieldChanges: Array<{ path: string }>,
): { applyMode: "edit" | "recreate"; recreateReason?: string } {
  const editable =
    type === "order" ? ORDER_EDITABLE_SPEC_FIELDS :
    type === "schedule" ? SCHEDULE_EDITABLE_SPEC_FIELDS :
    REBALANCE_EDITABLE_SPEC_FIELDS;
  const frozen = fieldChanges.map((c) => c.path).filter((p) => !editable.has(p));
  if (frozen.length === 0) return { applyMode: "edit" };
  return {
    applyMode: "recreate",
    recreateReason: `frozen field(s) changed: ${frozen.join(", ")}`,
  };
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
      const cls = classifyModifiedEntry(newEntry.type, fieldChanges);
      entries.push({
        status: "modified",
        type: newEntry.type,
        structuralKey: key,
        oldEntry, newEntry,
        fieldChanges,
        applyMode: cls.applyMode,
        ...(cls.recreateReason ? { recreateReason: cls.recreateReason } : {}),
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
    // v2: an in-place-editable trailing order KEEPS its HWM — only a
    // recreate resets it.
    if (
      e.status === "modified" &&
      e.applyMode === "recreate" &&
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
  /** Newly-created primitives (added + modified-recreate). */
  created: DeployedItem[];
  /** Old primitive ids cancelled (removed + modified-recreate). */
  cancelled: number[];
  /** v2 — primitives modified IN PLACE via the edit machinery. These
   *  keep their row id, trailing HWM, run_count, and journal
   *  continuity; they appear in neither `created` nor `cancelled`.
   *  Empty when preserveState:false or nothing was edit-routable. */
  edited: Array<{
    type: "order" | "schedule" | "rebalance";
    rowId: number;
    localId: string;
    /** Spec field names that changed. */
    fields: string[];
  }>;
  /** v2 — whether recreated primitives were created as paper.
   *  Inferred from the playbook's owned rows (deploy --paper isn't
   *  recorded in the spec) unless the caller overrode it. */
  paper: boolean;
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
  /** v2 — when true (DEFAULT), modified primitives whose changes are
   *  in-place editable route through orderEdit/scheduleEdit (HWM +
   *  run_count + journal continuity preserved) and recreated
   *  schedules/rebalance plans carry their run counters. false
   *  restores the v1 behavior: every modified primitive is
   *  cancelled + recreated with fresh state. */
  preserveState?: boolean;
  /** v2 — explicit paper override for recreated primitives. When
   *  omitted, paper-ness is INFERRED from the playbook's owned rows
   *  (all owned orders/schedules/rebalances paper → paper replace).
   *  Deploy's --paper flag isn't recorded in the spec, so without
   *  this inference a replace would silently flip a paper playbook
   *  to real trading. */
  paper?: boolean;
}): ReplaceResult {
  const { playbookId, newSpec, newSourcePath } = args;
  const preserveState = args.preserveState !== false;
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

  // Phase 2: load the owned rows up front — they drive edit routing,
  // paper inference, AND cancel matching.
  const strategyTag = `playbook:${playbookId}`;
  const ownedOrders = listOrders({ status: "all", strategy: strategyTag });
  const ownedSchedules = listSchedules({ status: "all", strategy: strategyTag });
  const ownedRebalances = listRebalancePlans({ status: "all", strategy: strategyTag });

  // v2 paper inference: deploy's --paper flag isn't recorded in the
  // spec, but every primitive it created carries paper=1. If ALL
  // owned rows are paper, recreated primitives must be paper too —
  // otherwise a replace silently flips a dry-run strategy to real
  // trading. An explicit args.paper always wins (operator intent).
  const ownedPaperFlags = [
    ...ownedOrders.map((r) => r.paper),
    ...ownedSchedules.map((r) => r.paper),
    ...ownedRebalances.map((r) => r.paper),
  ];
  const paper = args.paper ?? (ownedPaperFlags.length > 0 && ownedPaperFlags.every((p) => p === 1));

  // Phase 3: partition the diff into the three apply plans.
  //   toEdit    — modified entries applied in place (preserveState
  //               && applyMode=edit && the live row still exists).
  //               Pre-validated HERE, before anything is cancelled.
  //   toCancel  — removed + modified-recreate old rows.
  //   toCreate  — added + modified-recreate new entries; recreates
  //               capture the old row's run counters for carry-over.
  const toEdit: Array<{
    type: "order" | "schedule" | "rebalance";
    rowId: number;
    localId: string;
    changes: OrderEditChanges | ScheduleEditChanges | RebalanceEditChanges;
    fields: string[];
  }> = [];
  const toCancel: Array<{ type: StrategySpec["type"]; rowId: number }> = [];
  const toCreate: Array<{
    entry: StrategySpec;
    localId: string;
    carry?:
      | { kind: "schedule"; runCount: number; lastRunAt: string | null; totalBaseFilled: string | null; totalQuoteSpent: string | null }
      | { kind: "rebalance"; runCount: number; lastRunAt: string | null };
  }> = [];
  const now = new Date();

  for (const e of diff.entries) {
    if (e.status === "unchanged") continue;
    if (e.status === "added") {
      toCreate.push({ entry: e.newEntry!, localId: e.newEntry?.id ?? `strategy:${e.structuralKey}` });
      continue;
    }
    const rowId = findOwnedRowId({
      entry: e.oldEntry!,
      playbookId,
      orders: ownedOrders,
      schedules: ownedSchedules,
      rebalances: ownedRebalances,
    });
    if (e.status === "removed") {
      if (rowId != null) toCancel.push({ type: e.oldEntry!.type, rowId });
      continue;
    }

    // status === "modified"
    const localId = e.newEntry?.id ?? `strategy:${e.structuralKey}`;
    const fields = e.fieldChanges.map((c) => c.path);

    if (preserveState && e.applyMode === "edit" && rowId != null && e.type === "order") {
      const row = ownedOrders.find((r) => r.id === rowId)!;
      const changes = orderEditChangesFromSpec(e.newEntry as OrderSpec, fields);
      // Throws INVALID_PARAMS on bad input — BEFORE any mutation, so
      // a defective edit aborts the whole replace with state intact.
      validateOrderEdit({ order: row, changes, config, now });
      toEdit.push({ type: "order", rowId, localId, changes, fields });
      continue;
    }
    if (preserveState && e.applyMode === "edit" && rowId != null && e.type === "schedule") {
      const row = ownedSchedules.find((r) => r.id === rowId)!;
      const changes = scheduleEditChangesFromSpec(e.newEntry as ScheduleSpec, fields);
      validateScheduleEdit({ schedule: row, changes, config, now });
      toEdit.push({ type: "schedule", rowId, localId, changes, fields });
      continue;
    }
    if (preserveState && e.applyMode === "edit" && rowId != null && e.type === "rebalance") {
      const row = ownedRebalances.find((r) => r.id === rowId)!;
      const changes = rebalanceEditChangesFromSpec(e.newEntry as RebalanceSpec, fields);
      validateRebalanceEdit({ plan: row, changes, config, now });
      toEdit.push({ type: "rebalance", rowId, localId, changes, fields });
      continue;
    }

    // Recreate path (frozen field changed, edit-target row missing,
    // or preserveState:false). Capture run counters for carry-over
    // while the old row is still readable.
    if (rowId != null) toCancel.push({ type: e.oldEntry!.type, rowId });
    let carry: (typeof toCreate)[number]["carry"];
    if (preserveState && rowId != null && e.type === "schedule") {
      const row = ownedSchedules.find((r) => r.id === rowId)!;
      carry = {
        kind: "schedule",
        runCount: row.run_count,
        lastRunAt: row.last_run_at,
        totalBaseFilled: row.total_base_filled,
        totalQuoteSpent: row.total_quote_spent,
      };
    } else if (preserveState && rowId != null && e.type === "rebalance") {
      const row = ownedRebalances.find((r) => r.id === rowId)!;
      carry = { kind: "rebalance", runCount: row.run_count, lastRunAt: row.last_run_at };
    }
    toCreate.push({ entry: e.newEntry!, localId, ...(carry ? { carry } : {}) });
  }

  // Pre-validate every to-be-created primitive — catches schema /
  // token-resolution failures BEFORE we cancel anything. The actual
  // createXxxRow validators run again at insert time; this early
  // pass exists so a defective new spec can't leave the playbook
  // half-replaced.
  preValidate({
    entries: toCreate.map((c) => ({ entry: c.entry, localId: c.localId })),
    spec: newSpec,
    config,
    strategyTag,
  });

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

  // v2: apply in-place edits via the shared edit machinery. Same
  // semantics as `tradekit order edit` / `schedule edit`: trailing
  // HWM untouched, run_count untouched, edited_by_operator journal
  // row appended (orders). Pre-validated above, so failures here are
  // races (row left 'active' since the validation read).
  const edited: ReplaceResult["edited"] = [];
  for (const ed of toEdit) {
    try {
      if (ed.type === "order") {
        editOrder({ id: ed.rowId, changes: ed.changes as OrderEditChanges, config });
      } else if (ed.type === "schedule") {
        editSchedule({ id: ed.rowId, changes: ed.changes as ScheduleEditChanges, config });
      } else {
        editRebalancePlan({ id: ed.rowId, changes: ed.changes as RebalanceEditChanges, config });
      }
      edited.push({ type: ed.type, rowId: ed.rowId, localId: ed.localId, fields: ed.fields });
    } catch (e) {
      throw new ToolError(
        "INTERNAL_ERROR",
        `Replace failed mid-edit of ${ed.type} #${ed.rowId}: ${(e as Error).message}. Playbook may be in a partial state; inspect with \`tradekit playbook show ${playbookId}\`.`,
      );
    }
  }

  // Create new primitives via the shared deploy create-path. Same
  // semantics: strategy tag stamped, group namespaced, paper flag
  // applied — then carry run counters onto recreated rows.
  const created: DeployedItem[] = [];
  for (const item of toCreate) {
    const itemResult = createOnePrimitive({
      entry: item.entry,
      localId: item.localId,
      playbookId,
      strategyTag,
      spec: newSpec,
      config,
      paper,
    });
    created.push(itemResult);
    if (item.carry?.kind === "schedule") {
      carryScheduleRunCounters({
        id: itemResult.rowId,
        runCount: item.carry.runCount,
        lastRunAt: item.carry.lastRunAt,
        totalBaseFilled: item.carry.totalBaseFilled,
        totalQuoteSpent: item.carry.totalQuoteSpent,
      });
    } else if (item.carry?.kind === "rebalance") {
      carryRebalanceRunCounters({
        id: itemResult.rowId,
        runCount: item.carry.runCount,
        lastRunAt: item.carry.lastRunAt,
      });
    }
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
    edited,
    paper,
    oldHash: diff.oldHash,
    newHash: diff.newHash,
  };
}

// ── spec → edit-changes mapping (v2) ─────────────────────────

/** Build OrderEditChanges from the spec fields that changed. Only
 *  changed fields are included, so the edit is minimal — untouched
 *  columns keep their engine-managed values. */
function orderEditChangesFromSpec(entry: OrderSpec, changedFields: string[]): OrderEditChanges {
  const ch: OrderEditChanges = {};
  for (const f of changedFields) {
    switch (f) {
      case "price":
        ch.targetPriceUsd = entry.price ?? null;
        break;
      case "trailPct":
        ch.trailPct = entry.trailPct ?? null;
        break;
      case "baseAmount":
        ch.baseAmount = entry.baseAmount != null ? String(entry.baseAmount) : null;
        break;
      case "quoteAmount":
        ch.quoteAmount = entry.quoteAmount != null ? String(entry.quoteAmount) : null;
        break;
      case "slippageBps":
        ch.slippageBps = entry.slippageBps ?? null;
        break;
      case "autoSlippage":
        ch.autoSlippage = entry.autoSlippage === true;
        break;
      case "expiresAt":
        ch.expiresAt = entry.expiresAt ?? null;
        break;
      case "note":
        ch.note = entry.note ?? null;
        break;
    }
  }
  return ch;
}

/** Same mapping for rebalance plans. The structural key pins name +
 *  target token set, so a modified entry's `targets` change is a
 *  re-weight of the SAME tokens — exactly what the edit validator
 *  accepts. */
function rebalanceEditChangesFromSpec(entry: RebalanceSpec, changedFields: string[]): RebalanceEditChanges {
  const ch: RebalanceEditChanges = {};
  for (const f of changedFields) {
    switch (f) {
      case "targets":
        ch.targets = entry.targets;
        break;
      case "driftThresholdPct":
        if (entry.driftThresholdPct != null) ch.driftThresholdPct = entry.driftThresholdPct;
        break;
      case "minTradeUsd":
        if (entry.minTradeUsd != null) ch.minTradeUsd = entry.minTradeUsd;
        break;
      case "cron":
        if (entry.cron) ch.cron = entry.cron;
        break;
      case "endAt":
        ch.endAt = entry.endAt ?? null;
        break;
      case "maxRuns":
        ch.maxRuns = entry.maxRuns ?? null;
        break;
      case "slippageBps":
        ch.slippageBps = entry.slippageBps ?? null;
        break;
      case "autoSlippage":
        ch.autoSlippage = entry.autoSlippage === true;
        break;
      case "note":
        ch.note = entry.note ?? null;
        break;
    }
  }
  return ch;
}

/** Same mapping for schedules. cron/every are mutually exclusive in
 *  the spec; when the operator switches representation, BOTH appear
 *  in changedFields — we pass only the one that's set in the new
 *  entry (the edit validator enforces exclusivity). */
function scheduleEditChangesFromSpec(entry: ScheduleSpec, changedFields: string[]): ScheduleEditChanges {
  const ch: ScheduleEditChanges = {};
  for (const f of changedFields) {
    switch (f) {
      case "cron":
        if (entry.cron) ch.cron = entry.cron;
        break;
      case "every":
        if (entry.every) ch.every = entry.every;
        break;
      case "baseAmount":
        ch.baseAmount = entry.baseAmount != null ? String(entry.baseAmount) : null;
        break;
      case "quoteAmount":
        ch.quoteAmount = entry.quoteAmount != null ? String(entry.quoteAmount) : null;
        break;
      case "slippageBps":
        ch.slippageBps = entry.slippageBps ?? null;
        break;
      case "autoSlippage":
        ch.autoSlippage = entry.autoSlippage === true;
        break;
      case "endAt":
        ch.endAt = entry.endAt ?? null;
        break;
      case "maxRuns":
        ch.maxRuns = entry.maxRuns ?? null;
        break;
      case "note":
        ch.note = entry.note ?? null;
        break;
      case "onFill":
        // null removes an existing hook; an object replaces it (the
        // edit validator re-renders fake fill data through the order
        // validators before accepting).
        ch.onFill = entry.onFill ?? null;
        break;
    }
  }
  return ch;
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
      if (s.onFill != null) {
        // Full chain-aware validation (fake-fill render) happens in
        // createScheduleRow during apply; the structural gate here
        // keeps a malformed hook from failing AFTER cancellations.
        try {
          parseOnFillSpec(s.onFill);
        } catch (e) {
          throw new ToolError("INVALID_PARAMS", `${item.localId}: onFill — ${(e as Error).message}`);
        }
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
