/**
 * `tradekit note` — operator annotations in the forensic timeline (v37).
 *
 * The timeline was all machine events; notes add the human layer:
 * "moved the stop because CPI tomorrow", "rotated RPC, base flaky".
 * They merge into `tradekit timeline` (kind note.operator) so "what
 * did I do around the time things broke" is one view.
 */

import { ToolError } from "../errors.js";
import { printJson, subcommandError } from "./helpers.js";

export async function noteCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  switch (action) {
    case "add": {
      const text = positional.slice(2).join(" ").trim();
      if (!text) {
        throw new ToolError("INVALID_PARAMS", `Usage: tradekit note add "what you did and why" [--strategy TAG] [--at ISO]`);
      }
      if (text.length > 2000) {
        throw new ToolError("INVALID_PARAMS", `Note too long (${text.length} chars; max 2000). Long context belongs in a runbook — link it.`);
      }
      let at = new Date().toISOString();
      if (flags["at"]) {
        const t = Date.parse(flags["at"]);
        if (!Number.isFinite(t)) throw new ToolError("INVALID_PARAMS", `--at must be ISO-8601 (got "${flags["at"]}").`);
        at = new Date(t).toISOString();
      }
      const { insertOperatorNote } = await import("../db.js");
      const id = insertOperatorNote({ at, text, strategy: flags["strategy"] ?? null, source: "cli" });
      if (flags["json"] === "true") printJson({ ok: true, id, at });
      else console.log(`Note #${id} recorded${flags["strategy"] ? ` (strategy ${flags["strategy"]})` : ""} — it shows in \`tradekit timeline\`.`);
      break;
    }
    case "list": {
      const { listOperatorNotes } = await import("../db.js");
      const notes = listOperatorNotes({
        strategy: flags["strategy"],
        limit: flags["limit"] ? parseInt(flags["limit"], 10) : 50,
      });
      if (flags["json"] === "true") {
        printJson({ ok: true, count: notes.length, notes });
        break;
      }
      if (notes.length === 0) {
        console.log("No notes yet — record context with: tradekit note add \"…\"");
        break;
      }
      for (const n of notes) {
        console.log(`  #${n.id}  ${n.at}  [${n.source}]${n.strategy ? `  (${n.strategy})` : ""}`);
        console.log(`      ${n.text}`);
      }
      break;
    }
    case "rm": {
      const id = parseInt(positional[2] ?? "", 10);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ToolError("INVALID_PARAMS", "Usage: tradekit note rm <id>");
      }
      const { deleteOperatorNote } = await import("../db.js");
      const n = deleteOperatorNote(id);
      if (n === 0) throw new ToolError("INVALID_PARAMS", `No note #${id}.`);
      if (flags["json"] === "true") printJson({ ok: true, deleted: id });
      else console.log(`Note #${id} deleted.`);
      break;
    }
    default:
      throw subcommandError("note", action, ["add", "list", "rm"]);
  }
}
