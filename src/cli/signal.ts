/**
 * `tradekit signal` — fire / inspect external signal events (v35).
 *
 * `signal fire <name>` is the manual/test twin of the webhook
 * (POST /api/signal/:name): it drops one event in the inbox; the
 * next engine tick fires every signal-armed order that was created
 * before the event arrived.
 */

import { ToolError } from "../errors.js";
import { printJson, subcommandError } from "./helpers.js";

const NAME_RX = /^[A-Za-z0-9_-]{1,64}$/;

export async function signalCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  switch (action) {
    case "fire": {
      const name = positional[2];
      if (!name || !NAME_RX.test(name)) {
        throw new ToolError("INVALID_PARAMS", `Usage: tradekit signal fire <name>  (name: [A-Za-z0-9_-]{1,64})`);
      }
      let payload: string | null = null;
      if (flags["payload"]) {
        try {
          payload = JSON.stringify(JSON.parse(flags["payload"])).slice(0, 4096);
        } catch {
          throw new ToolError("INVALID_PARAMS", `--payload must be valid JSON.`);
        }
      }
      const { insertSignalEvent, listOrders } = await import("../db.js");
      const id = insertSignalEvent({ name, receivedAt: new Date().toISOString(), source: "cli", payloadJson: payload });
      const listeners = listOrders({ status: "active" }).filter(
        (o) => o.trigger_type === "signal" && o.signal_name === name,
      );
      if (flags["json"] === "true") {
        printJson({ ok: true, id, name, armedListeners: listeners.length });
        return;
      }
      console.log(`Signal "${name}" fired (event #${id}).`);
      if (listeners.length === 0) {
        console.log(`  ⚠ no active order is armed on this signal — the event expires unclaimed after 1h.`);
      } else {
        console.log(`  ${listeners.length} armed listener(s) will fire on the next engine tick: #${listeners.map((l) => l.id).join(", #")}`);
      }
      break;
    }
    case "list": {
      const { listSignalEvents } = await import("../db.js");
      const events = listSignalEvents({
        name: flags["name"],
        limit: flags["limit"] ? parseInt(flags["limit"], 10) : 50,
      });
      if (flags["json"] === "true") {
        printJson({ ok: true, count: events.length, events });
        return;
      }
      if (events.length === 0) {
        console.log("No signal events.");
        return;
      }
      for (const e of events) {
        const state = e.consumed_at
          ? e.consumed_by_order != null
            ? `consumed by order #${e.consumed_by_order}`
            : "expired unclaimed"
          : "PENDING";
        console.log(`  #${e.id}  ${e.received_at}  ${e.name}  [${e.source}]  ${state}`);
      }
      break;
    }
    default:
      throw subcommandError("signal", action, ["fire", "list"]);
  }
}
