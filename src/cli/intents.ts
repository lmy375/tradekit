/**
 * `tradekit intents` — the human side of the v47 approval gate.
 *
 * Agents propose (MCP buy/sell lands a pending intent when
 * safety.tradeApproval gates it); the operator reviews and decides
 * HERE — approve re-executes the recorded request behind the wallet
 * password, with the preview's amountOut replayed as drift
 * protection. Approve/reject deliberately has no MCP twin.
 */

import { ToolError } from "../errors.js";
import { printJson, subcommandError, requirePassword, makeCliLogger, parseIntFlag } from "./helpers.js";
import type { TradeIntentRow } from "../tradeIntents.js";

function summaryLine(r: TradeIntentRow): string {
  const req = JSON.parse(r.request_json) as { base?: string; quote?: string; baseAmount?: string; quoteAmount?: string };
  const amt = r.tool === "buy" ? `${req.quoteAmount} quote` : `${req.baseAmount} base`;
  return `#${String(r.id).padStart(3)}  ${r.status.padEnd(8)}  ${r.tool.padEnd(4)}  ${String(req.base ?? "?").slice(0, 10)}/${String(req.quote ?? "?").slice(0, 10)}  ${amt}${r.est_usd != null ? `  ~$${r.est_usd.toFixed(2)}` : ""}  ${r.created_at.slice(0, 16)}${r.status === "pending" ? `  expires ${r.expires_at.slice(11, 16)}Z` : ""}`;
}

export async function intentsCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  const { listIntents, getActionableIntent, rejectTradeIntent, completeApprovedIntent } =
    await import("../tradeIntents.js");
  const { getTradeIntentById } = await import("../db.js");

  switch (action) {
    case "list": {
      const status = flags["status"] as TradeIntentRow["status"] | undefined;
      if (status && !["pending", "executed", "failed", "rejected", "expired"].includes(status)) {
        throw new ToolError("INVALID_PARAMS", `--status must be pending | executed | failed | rejected | expired.`);
      }
      const rows = listIntents({ status, limit: parseIntFlag(flags["limit"], "--limit", { min: 1, max: 500 }) ?? 50 });
      if (flags["json"] === "true") {
        printJson({ ok: true, count: rows.length, intents: rows });
        break;
      }
      if (rows.length === 0) {
        console.log(status ? `No ${status} intents.` : "No trade intents — agents file them when safety.tradeApproval gates a trade.");
        break;
      }
      for (const r of rows) console.log(`  ${summaryLine(r)}${r.reason ? `\n      reason: ${r.reason}` : ""}`);
      const pending = rows.filter((r) => r.status === "pending").length;
      if (pending > 0) console.log(`\n${pending} pending — review: tradekit intents show <id> · decide: approve/reject <id>`);
      break;
    }

    case "show": {
      const id = parseInt(positional[2] ?? "", 10);
      if (!Number.isInteger(id) || id <= 0) throw new ToolError("INVALID_PARAMS", "Usage: tradekit intents show <id>");
      // listIntents sweeps expiry lazily; do the same here.
      listIntents({ limit: 1 });
      const r = getTradeIntentById(id);
      if (!r) throw new ToolError("INVALID_PARAMS", `No trade intent #${id}.`);
      if (flags["json"] === "true") {
        printJson({
          ok: true,
          intent: {
            ...r,
            request: JSON.parse(r.request_json),
            preview: r.preview_json ? JSON.parse(r.preview_json) : null,
            result: r.result_json ? JSON.parse(r.result_json) : null,
          },
        });
        break;
      }
      const preview = r.preview_json
        ? (JSON.parse(r.preview_json) as { price?: string; baseAmount?: string; quoteAmount?: string; aggregator?: string; estimatedUsd?: number })
        : null;
      console.log(summaryLine(r));
      if (r.reason) console.log(`  reason:    ${r.reason}`);
      if (preview) {
        console.log(`  preview:   ${r.tool} ${preview.baseAmount} base ⇄ ${preview.quoteAmount} quote @ ${preview.price} via ${preview.aggregator}`);
      }
      console.log(`  chain:     ${r.chain}${r.account ? ` · account ${r.account}` : ""}`);
      if (r.decided_at) console.log(`  decided:   ${r.decided_at} (${r.decided_note ?? r.status})`);
      if (r.result_json) {
        const res = JSON.parse(r.result_json) as { txHash?: string; status?: string; error?: { code?: string } };
        console.log(`  result:    ${res.status ?? res.error?.code ?? "?"}${res.txHash ? ` tx ${res.txHash}` : ""}`);
      }
      if (r.status === "pending") {
        console.log(`\n  Approve (re-quotes with drift protection): tradekit intents approve ${id}`);
        console.log(`  Reject:                                     tradekit intents reject ${id} --note "..."`);
      }
      break;
    }

    case "approve": {
      const id = parseInt(positional[2] ?? "", 10);
      if (!Number.isInteger(id) || id <= 0) throw new ToolError("INVALID_PARAMS", "Usage: tradekit intents approve <id>");
      const intent = getActionableIntent(id);
      const req = JSON.parse(intent.request_json) as import("../trade.js").TradeRequest & { chain?: string; account?: string };
      const preview = intent.preview_json
        ? (JSON.parse(intent.preview_json) as { quoteAmount?: string; baseAmount?: string })
        : null;

      const { loadConfig, resolveProfile } = await import("../config.js");
      const { loadWallet } = await import("../wallet.js");
      const { executeTrade } = await import("../trade.js");
      const config = loadConfig();
      const profile = resolveProfile(intent.chain, config);
      const logger = makeCliLogger(flags);
      const wallet = await loadWallet(
        await requirePassword(flags),
        profile,
        config.chains[intent.chain]?.rpcs ?? [],
        logger,
        intent.account ?? undefined,
      );

      // Drift protection: the preview's RECEIVED side becomes the
      // expectation; default 100bps tolerance, overridable, skippable
      // with --force (the deviation error names the live numbers).
      const expectedOut = req.direction === "buy" ? preview?.baseAmount : preview?.quoteAmount;
      const maxDev = parseIntFlag(flags["max-deviation-bps"], "--max-deviation-bps", { min: 1, max: 5000 });
      const execReq = {
        ...req,
        simulate: false,
        expectedAmountOut: flags["force"] === "true" ? undefined : (req.expectedAmountOut ?? expectedOut),
        maxQuoteDeviationBps: flags["force"] === "true" ? undefined : (maxDev ?? 100),
      };

      try {
        const result = await executeTrade(execReq, {
          publicClient: wallet.publicClient,
          walletClient: wallet.walletClient,
          profile,
          config,
          logger,
          accountLabel: wallet.label,
        });
        completeApprovedIntent({ id, outcome: "executed", resultJson: JSON.stringify(result), note: flags["note"] ?? "approved" });
        if (flags["json"] === "true") printJson({ ...result, ok: true, intentId: id });
        else {
          console.log(`Intent #${id} approved + executed: ${result.status ?? "sent"}${result.txHash ? ` tx ${result.txHash}` : ""}`);
        }
      } catch (e) {
        if (e instanceof ToolError) {
          completeApprovedIntent({
            id,
            outcome: "failed",
            resultJson: JSON.stringify({ error: { code: e.code, message: e.message } }),
            note: flags["note"] ?? "approved",
          });
        }
        throw e;
      }
      break;
    }

    case "reject": {
      const id = parseInt(positional[2] ?? "", 10);
      if (!Number.isInteger(id) || id <= 0) throw new ToolError("INVALID_PARAMS", "Usage: tradekit intents reject <id> [--note \"...\"]");
      const row = rejectTradeIntent({ id, note: flags["note"] });
      if (flags["json"] === "true") printJson({ ok: true, intent: row });
      else console.log(`Intent #${id} rejected${flags["note"] ? ` (${flags["note"]})` : ""}. The agent sees the decision via intents_list.`);
      break;
    }

    default:
      throw subcommandError("intents", action, ["list", "show", "approve", "reject"]);
  }
}
