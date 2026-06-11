/**
 * Idempotency keys for the manual/agent trade paths (v45).
 *
 * The engine's own fires have had replay protection since v33 (the
 * crash-window guard books an already-sent occurrence from its
 * evidence trade). The HUMAN/AGENT paths had none: an MCP `buy`
 * whose transport times out after the tx was sent gets retried by
 * every sane agent loop, and that retry is a DOUBLE TRADE — the
 * single worst failure mode an agent-facing trading tool can have.
 *
 * Protocol (Stripe-shaped):
 *   - Caller supplies `idempotencyKey` (8–128 chars, [A-Za-z0-9_-]).
 *   - First invocation claims the key (atomic INSERT — the PRIMARY
 *     KEY is the race arbiter), runs the trade, records the terminal
 *     outcome (success OR ToolError) on the row.
 *   - A retry with the same key + same request replays the recorded
 *     outcome verbatim, marked `replayed: true`. It does NOT
 *     re-execute. A recorded failure replays as the same failure —
 *     "fixed the problem, trying again" is a NEW logical request and
 *     needs a new key.
 *   - Same key + DIFFERENT request → IDEMPOTENCY_CONFLICT (409).
 *   - Key still in_flight → REQUEST_IN_FLIGHT (409). Never assume
 *     the original died: the tx may be in the mempool. The error's
 *     nextActions say what to check; after verifying nothing was
 *     sent, `releaseIdempotencyKey` (CLI `tradekit trade release-key`
 *     path) unfences it.
 *   - in_flight rows older than IN_FLIGHT_TTL_MS are reported with
 *     stale: true in the error details — the process probably died —
 *     but are STILL not auto-retried (dying after tx-send is exactly
 *     the dangerous case).
 *
 * Keys expire via db.retention.idempotencyKeysDays (dbLifecycle) —
 * replay protection is an operational window, not an archive.
 */

import { createHash } from "node:crypto";
import { ToolError } from "./errors.js";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  deleteIdempotencyKey,
  getIdempotencyKey,
} from "./db.js";

const KEY_RX = /^[A-Za-z0-9_-]{8,128}$/;
/** After this long an in_flight row is reported stale (process
 *  probably died) — reported, not auto-released. */
export const IN_FLIGHT_TTL_MS = 10 * 60_000;

export function validateIdempotencyKey(key: string): void {
  if (!KEY_RX.test(key)) {
    throw new ToolError(
      "INVALID_PARAMS",
      `idempotencyKey must match [A-Za-z0-9_-]{8,128} (got "${key}") — use a UUID or similar; ≥8 chars so accidental collisions don't replay someone else's trade.`,
    );
  }
}

/** Canonical request fingerprint: stable across key order, so the
 *  "same request" test doesn't depend on caller serialization.
 *  undefined values are dropped (absent ≡ undefined). */
export function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex").slice(0, 16);
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(",")}}`;
}

export interface IdempotentOutcome<T> {
  result: T;
  /** True when this is the recorded outcome of an earlier invocation
   *  — nothing was executed on this call. */
  replayed: boolean;
}

/**
 * Run `exec` exactly once per (key, request). The terminal outcome —
 * success value or thrown ToolError — is recorded on the key and
 * replayed verbatim on retries.
 */
export async function withIdempotency<T>(args: {
  key: string | undefined;
  tool: string;
  /** The request object to fingerprint — pass the caller's input,
   *  minus the key itself. */
  requestArgs: unknown;
  exec: () => Promise<T>;
  now?: Date;
}): Promise<IdempotentOutcome<T>> {
  if (args.key == null) {
    return { result: await args.exec(), replayed: false };
  }
  validateIdempotencyKey(args.key);
  const argsHash = hashArgs(args.requestArgs);
  const nowIso = (args.now ?? new Date()).toISOString();

  if (!claimIdempotencyKey({ key: args.key, tool: args.tool, argsHash, now: nowIso })) {
    const row = getIdempotencyKey(args.key);
    if (!row) {
      // Claim lost a race AND the row vanished (released between the
      // two statements) — treat as conflict rather than silently
      // executing; the operator is actively touching this key.
      throw new ToolError("REQUEST_IN_FLIGHT", `idempotencyKey "${args.key}" is being modified concurrently — retry in a moment.`);
    }
    if (row.tool !== args.tool || row.args_hash !== argsHash) {
      throw new ToolError(
        "IDEMPOTENCY_CONFLICT",
        `idempotencyKey "${args.key}" was already used for a DIFFERENT request (${row.tool}, recorded ${row.created_at}). Keys bind to one logical request — use a fresh key.`,
        { details: { recordedTool: row.tool, recordedAt: row.created_at } },
      );
    }
    if (row.status === "in_flight") {
      const ageMs = (args.now ?? new Date()).getTime() - Date.parse(row.created_at);
      const stale = ageMs > IN_FLIGHT_TTL_MS;
      throw new ToolError(
        "REQUEST_IN_FLIGHT",
        stale
          ? `idempotencyKey "${args.key}" has an in-flight invocation from ${row.created_at} that likely died mid-execution. Do NOT retry blindly — the tx may have been sent. Check recent trades / pending txs first; if nothing was sent, release the key with \`tradekit trade release-key ${args.key}\` and retry.`
          : `idempotencyKey "${args.key}" is still executing (started ${row.created_at}). Don't retry — the original invocation will land or fail on its own; re-poll with the same key to read its outcome.`,
        { details: { startedAt: row.created_at, stale } },
      );
    }
    // Terminal — replay the recorded outcome verbatim.
    const recorded = JSON.parse(row.result_json ?? "null") as
      | { kind: "success"; value: T }
      | { kind: "error"; code: string; message: string; details?: unknown };
    if (recorded && (recorded as { kind?: string }).kind === "error") {
      const e = recorded as { code: string; message: string; details?: unknown };
      throw new ToolError(e.code as never, `[replayed] ${e.message}`, {
        details: { ...(e.details as Record<string, unknown> | undefined), replayed: true },
      });
    }
    return { result: (recorded as { value: T }).value, replayed: true };
  }

  // Fresh claim — execute and record the terminal outcome.
  try {
    const value = await args.exec();
    completeIdempotencyKey({
      key: args.key,
      status: "done",
      resultJson: JSON.stringify({ kind: "success", value }),
    });
    return { result: value, replayed: false };
  } catch (e) {
    if (e instanceof ToolError) {
      completeIdempotencyKey({
        key: args.key,
        status: "failed",
        resultJson: JSON.stringify({ kind: "error", code: e.code, message: e.message, details: e.details }),
      });
    } else {
      // Non-ToolError crash: we can't claim to know the outcome
      // (process-level failure mid-send is possible). Leave the row
      // in_flight so retries hit the REQUEST_IN_FLIGHT fence instead
      // of silently double-trading.
    }
    throw e;
  }
}

/** Explicit unfence after the operator verified nothing was sent. */
export function releaseIdempotencyKey(key: string): boolean {
  validateIdempotencyKey(key);
  const row = getIdempotencyKey(key);
  if (!row) return false;
  if (row.status !== "in_flight") {
    throw new ToolError(
      "IDEMPOTENCY_CONFLICT",
      `idempotencyKey "${key}" is terminal (${row.status}) — terminal keys replay their outcome and never need releasing. Use a new key for a new request.`,
    );
  }
  return deleteIdempotencyKey(key) > 0;
}
