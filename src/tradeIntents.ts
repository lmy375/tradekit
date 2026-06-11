/**
 * Trade intents — the human-in-the-loop approval gate (v47).
 *
 * Static safety caps answer "what may an agent EVER do"; they can't
 * express "below $500 the agent trades autonomously, above it I want
 * to look first". This module is that middle band: when
 * safety.tradeApproval is enabled and an MCP buy/sell crosses the
 * threshold, the trade is NOT executed — the resolved request plus
 * its simulate-preview (full safety stack + live quote: exactly what
 * the reviewer needs) lands as a PENDING intent, and the agent gets
 * a pending_approval result (a success shape, not an error — agents
 * must not blind-retry it).
 *
 * Security boundary, deliberately asymmetric:
 *   - MCP (the agent surface) can CREATE intents and LIST them.
 *   - Approve / reject / execute is CLI-ONLY (`tradekit intents`) —
 *     the same boundary as backup/panic. A prompt-injected agent
 *     must never be able to approve its own spending. The CLI trade
 *     path itself is NOT gated: it already sits behind the wallet
 *     password, i.e. the human.
 *
 * Approve-time drift protection: the preview's amountOut is replayed
 * as expectedAmountOut (default 100bps tolerance) so a quote from an
 * hour ago can't silently execute into a moved market. Intents
 * expire (default 60min) — a stale quote should never execute days
 * later.
 */

import { ToolError } from "./errors.js";
import type { Config } from "./config.js";
import {
  getTradeIntentById,
  insertTradeIntent,
  listTradeIntents,
  sweepExpiredTradeIntents,
  transitionTradeIntent,
  type TradeIntentRow,
  type TradeIntentStatus,
} from "./db.js";

export type { TradeIntentRow, TradeIntentStatus };

export interface ApprovalGateConfig {
  enabled: boolean;
  thresholdUsd: number | null;
  expiresMinutes: number;
}

export function approvalGateConfig(config: Config): ApprovalGateConfig | null {
  const c = config.safety?.tradeApproval;
  if (!c?.enabled) return null;
  return { enabled: true, thresholdUsd: c.thresholdUsd ?? null, expiresMinutes: c.expiresMinutes ?? 60 };
}

/** Does THIS trade need a human? Pure: thresholdUsd null = every
 *  agent trade; otherwise estUsd at-or-above the threshold. An
 *  unpriceable trade (estUsd null) with a threshold set is gated
 *  CONSERVATIVELY — "couldn't price it" must not mean "waved through". */
export function needsApproval(gate: ApprovalGateConfig, estUsd: number | null): boolean {
  if (gate.thresholdUsd == null) return true;
  if (estUsd == null) return true;
  return estUsd >= gate.thresholdUsd;
}

export interface CreateIntentArgs {
  tool: "buy" | "sell";
  chain: string;
  account: string | null;
  /** The resolved request the approver will re-execute (TradeRequest
   *  fields + any caller context worth replaying). */
  request: Record<string, unknown>;
  /** The simulate TradeResult — the reviewer's full context. */
  preview: Record<string, unknown> | null;
  estUsd: number | null;
  reason: string | null;
  expiresMinutes: number;
  now?: Date;
}

export interface PendingIntentSummary {
  intentId: number;
  status: "pending_approval";
  estUsd: number | null;
  expiresAt: string;
  approveHint: string;
}

export function createTradeIntent(args: CreateIntentArgs): PendingIntentSummary {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + args.expiresMinutes * 60_000).toISOString();
  const intentId = insertTradeIntent({
    createdAt: now.toISOString(),
    tool: args.tool,
    chain: args.chain,
    account: args.account,
    requestJson: JSON.stringify(args.request),
    previewJson: args.preview ? JSON.stringify(args.preview) : null,
    estUsd: args.estUsd,
    reason: args.reason,
    expiresAt,
  });
  return {
    intentId,
    status: "pending_approval",
    estUsd: args.estUsd,
    expiresAt,
    approveHint: `tradekit intents approve ${intentId}  (review first: tradekit intents show ${intentId})`,
  };
}

/** Sweep + fetch, enforcing "actionable" (pending, unexpired). */
export function getActionableIntent(id: number, now: Date = new Date()): TradeIntentRow {
  sweepExpiredTradeIntents(now.toISOString());
  const row = getTradeIntentById(id);
  if (!row) throw new ToolError("INVALID_PARAMS", `No trade intent #${id}.`);
  if (row.status !== "pending") {
    throw new ToolError(
      "INVALID_PARAMS",
      `Intent #${id} is ${row.status} — only pending intents can be decided. ${row.status === "expired" ? "The agent can re-propose; a fresh quote will be taken." : ""}`.trim(),
    );
  }
  return row;
}

export function rejectTradeIntent(args: { id: number; note?: string; now?: Date }): TradeIntentRow {
  const now = args.now ?? new Date();
  getActionableIntent(args.id, now);
  const ok = transitionTradeIntent({
    id: args.id,
    from: "pending",
    to: "rejected",
    decidedAt: now.toISOString(),
    decidedNote: args.note ?? null,
  });
  if (!ok) throw new ToolError("INVALID_PARAMS", `Intent #${args.id} was decided concurrently — re-check its status.`);
  return getTradeIntentById(args.id)!;
}

/**
 * Approve = claim (race-safe transition pending→executed is done in
 * two steps: we DON'T pre-transition; instead the executor calls
 * back). The CLI flow:
 *   1. const intent = getActionableIntent(id)
 *   2. run the trade (wallet password, deviation protection)
 *   3. completeApprovedIntent({id, outcome})
 * Between 1 and 3 a concurrent reject loses: completeApprovedIntent's
 * guarded transition fails loudly rather than double-finalizing.
 */
export function completeApprovedIntent(args: {
  id: number;
  outcome: "executed" | "failed";
  resultJson: string;
  note?: string;
  now?: Date;
}): void {
  const now = args.now ?? new Date();
  const ok = transitionTradeIntent({
    id: args.id,
    from: "pending",
    to: args.outcome,
    decidedAt: now.toISOString(),
    decidedNote: args.note ?? "approved",
    executedAt: now.toISOString(),
    resultJson: args.resultJson,
  });
  if (!ok) {
    throw new ToolError(
      "INVALID_PARAMS",
      `Intent #${args.id} changed state during execution (concurrent decision?) — the trade outcome is in the trades table; reconcile the intent manually with \`tradekit intents show ${args.id}\`.`,
    );
  }
}

export function listIntents(filter: { status?: TradeIntentStatus; limit?: number } = {}, now: Date = new Date()): TradeIntentRow[] {
  sweepExpiredTradeIntents(now.toISOString());
  return listTradeIntents(filter);
}

/** Best-effort "an agent wants to spend money" page. Never throws —
 *  a broken webhook must not break intent creation. */
export async function notifyIntentCreated(args: {
  intent: PendingIntentSummary;
  tool: "buy" | "sell";
  pairLabel: string;
  reason: string | null;
  config: Config;
  logger: { warn: (msg: string, fields?: Record<string, unknown>) => void };
}): Promise<void> {
  try {
    const { notify } = await import("./notify.js");
    await notify(
      {
        event: "trade.approval_pending",
        severity: "warn",
        title: `Agent trade awaiting approval: ${args.tool} ${args.pairLabel}${args.intent.estUsd != null ? ` (~$${args.intent.estUsd.toFixed(2)})` : ""}`,
        body: `${args.reason ? `Reason: ${args.reason}\n` : ""}Expires ${args.intent.expiresAt}\nReview: tradekit intents show ${args.intent.intentId}`,
        fields: { intentId: args.intent.intentId, estUsd: args.intent.estUsd, expiresAt: args.intent.expiresAt },
      },
      args.config,
      args.logger as never,
    );
  } catch (e) {
    args.logger.warn("trade-intent notification failed (intent still created)", { error: (e as Error).message });
  }
}
