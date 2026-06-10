// Config / chain / token CLI commands. Lifted from index.ts.

import { CONFIG_PATH } from "../constants.js";
import {
  loadConfig,
  saveConfig,
  resolveProfile,
  setConfigPath,
  parseConfigValue,
  pushConfigArray,
  dropConfigArray,
  redactConfigForDisplay,
  getConfigPath,
  type Config,
  configSchema,
} from "../config.js";
import { listChains } from "../chains.js";
import { toToolError, ToolError } from "../errors.js";
import { printJson, subcommandError, makeCliLogger } from "./helpers.js";
import { computeConfigImpact, type ConfigImpact } from "../configPreflight.js";
import { kickRunningEngine } from "../configReload.js";
import {
  listOrders as listOrdersFromDb,
  listSchedules as listSchedulesFromDb,
  listDrawdownStates as listDrawdownStatesFromDb,
} from "../db.js";

// Iter35: auto-kick the running engine after every successful
// mutation so the operator never has to remember "send SIGHUP".
// Best-effort: no-op when the engine isn't running, and never
// blocks the CLI command's success path.
function autoKickEngine(): void {
  try {
    const r = kickRunningEngine();
    if (r.delivered) {
      // Print a one-liner so the operator knows what happened.
      // Going to stderr so --json stdout stays clean.
      console.error(`[engine: SIGHUP sent to pid ${r.pid} — config reload in flight]`);
    }
  } catch {
    // Defensive: never let the kick path affect the mutation
    // command's exit status.
  }
}

/** Read the saved config + a tentative future config, compute the
 *  impact. Used by both `config preflight` and (one day) `config
 *  set --preflight`. Pure-ish: only DB reads. */
function computeImpactAgainstActive(args: { oldConfig: Config; newConfig: Config }): ConfigImpact {
  // Lazy DB import — keeps the config CLI cheap when no preflight
  // is requested (most invocations).
  return computeConfigImpact({
    oldConfig: args.oldConfig,
    newConfig: args.newConfig,
    state: loadActiveState(),
  });
}

function loadActiveState(): import("../configPreflight.js").ActiveState {
  // Best-effort. If the DB is unavailable, return an empty state —
  // the preflight will still surface field-level diffs (no
  // primitive impact analysis).
  try {
    return {
      orders: listOrdersFromDb({}),
      schedules: listSchedulesFromDb({}),
      drawdowns: listDrawdownStatesFromDb(),
    };
  } catch {
    return {};
  }
}

// ── config show / get / set / push / drop / path / validate ─

export async function configCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  // `validate` is the only action that doesn't load+then-mutate.
  if (action === "validate") {
    // Iter350: honor --json. Pre-iter350 the validate path ignored --json — scripts
    // doing `tradekit config validate --json | jq` got the human text on stdout/stderr
    // and crashed jq. CI pipelines that want to gate on config validity (without
    // grepping free-form text) now get a stable shape. Success: ok:true + summary
    // counts so dashboards can chart "N chain overrides configured". Failure: the
    // iter337 envelope shape (ok:false + nested error) for consistency with all other
    // --json error surfaces.
    const wantJson = flags["json"] === "true";
    try {
      const cfg = loadConfig();
      if (wantJson) {
        printJson({
          ok: true,
          activeChain: cfg.activeChain,
          chainOverrides: Object.keys(cfg.chains).length,
        });
      } else {
        console.log(
          `OK — config is valid (active chain: ${cfg.activeChain}, ${Object.keys(cfg.chains).length} chain override(s)).`,
        );
      }
      return;
    } catch (e) {
      const te = toToolError(e);
      if (wantJson) {
        // Goes to stdout (not stderr) because validate's --json IS the result: the
        // command's whole purpose is "tell me if config is valid". Different from
        // iter337's pattern of "stdout=success data, stderr=error envelope" because
        // here the failure IS the data the operator asked for.
        printJson(te.toJSON());
      } else {
        console.error(`FAIL — ${te.message}`);
        if (te.details) console.error(JSON.stringify(te.details, null, 2));
      }
      // Iter352: process.exitCode (not process.exit) so main()'s failure-audit block
      // still records this run. Same iter351-class fix. Note we don't throw — the
      // operator asked "validate", we answered "no, it's invalid", and that IS the
      // requested result rather than an unexpected error path.
      process.exitCode = 1;
      return;
    }
  }

  const config = loadConfig();
  switch (action) {
    case undefined:
    case "show": {
      // Redact aggregator API keys by default — `tradekit config show` output is
      // commonly piped/shared (support tickets, screenshots, paste in chat). Opt back
      // in with --show-secrets when you actually want to copy them somewhere.
      const showSecrets = flags["show-secrets"] === "true";
      printJson(showSecrets ? config : redactConfigForDisplay(config));
      break;
    }
    case "path":
      console.log(CONFIG_PATH);
      break;
    case "get": {
      const path = positional[2];
      if (!path) throw new ToolError("INVALID_PARAMS", "Usage: tradekit config get <dotted.path>");
      // Iter279: use the exported getConfigPath helper instead of an inline copy.
      // Same behavior; one source of truth shared with MCP's config tool.
      const v = getConfigPath(config, path);
      if (v === undefined) {
        // Iter349: --json mode mirrors MCP's contract — `{path, value: null, set: false}`
        // on stdout, exit 0. Pre-iter349 the path was always `console.error + process.exit(1)`,
        // so a script doing `tradekit config get X --json | jq` got a parse error on the
        // very first query of an unset key (empty stdout). MCP returns null without
        // erroring (admin-tools.ts:302) — bringing the CLI to parity removes the surprise
        // when an operator/agent uses both surfaces. Text mode keeps the historical
        // stderr + exit 1 so existing shell scripts that rely on the exit code still work.
        if (flags["json"] === "true") {
          // Iter450: ok:true envelope parity (iter445-449 arc).
          printJson({ ok: true, path, value: null, set: false });
        } else {
          // Iter352: process.exitCode (not process.exit) so main()'s success-audit
          // block still runs. Same iter351-class fix as doctor. Pre-iter352 the
          // text-mode not-set path bypassed the audit insert — `config get nonexistent`
          // produced exit 1 with no audit row, while `config get activeChain`
          // produced exit 0 WITH an audit row. The audit table then looked like
          // operators only ever queried valid paths, which would have hidden
          // typo'd-path scripting issues from any forensic review.
          console.error(`(not set: ${path})`);
          process.exitCode = 1;
        }
        break;
      }
      if (flags["json"] === "true") {
        // Iter450: ok:true envelope parity (iter445-449 arc).
        printJson({ ok: true, path, value: v, set: true });
      } else {
        printJson(v);
      }
      break;
    }
    case "set": {
      const path = positional[2];
      const rawValue = positional[3] ?? flags["value"];
      if (!path) throw new ToolError("INVALID_PARAMS", "Usage: tradekit config set <dotted.path> <value>");
      const parsed = rawValue === undefined ? undefined : parseConfigValue(rawValue);
      const prev = getConfigPath(config, path);
      const next = setConfigPath(config, path, parsed);
      saveConfig(next, { source: `cli:config set ${path}` });
      autoKickEngine();
      // Iter312: distinguish ADD / UPDATE / REMOVE / NO-OP so the operator sees what
      // actually changed. Pre-iter312 every set printed "Updated: X = Y" regardless of
      // whether the value moved. Same honesty discipline as iter310/311 token add/remove.
      // Iter363: --json output mirrors MCP's iter313 shape (action discriminator) so
      // both surfaces are consistent.
      let action: "set" | "updated" | "removed" | "noop";
      if (parsed === undefined) action = prev === undefined ? "noop" : "removed";
      else if (prev === undefined) action = "set";
      else if (JSON.stringify(prev) === JSON.stringify(parsed)) action = "noop";
      else action = "updated";
      if (flags["json"] === "true") {
        printJson({
          // Iter450: ok:true envelope parity (iter445-449 arc).
          ok: true,
          action, path,
          previousValue: prev ?? null,
          value: parsed ?? null,
          timestamp: new Date().toISOString(),
        });
        break;
      }
      if (action === "removed") {
        console.log(`Removed: ${path} (was ${JSON.stringify(prev)})`);
      } else if (action === "set") {
        console.log(`Set: ${path} = ${JSON.stringify(parsed)}`);
      } else if (action === "updated") {
        console.log(`Updated: ${path} = ${JSON.stringify(parsed)} (was ${JSON.stringify(prev)})`);
      } else if (parsed === undefined) {
        console.log(`(no change: ${path} was already unset)`);
      } else {
        console.log(`(no change: ${path} was already ${JSON.stringify(parsed)})`);
      }
      break;
    }
    case "push": {
      const path = positional[2];
      const rawValue = positional[3] ?? flags["value"];
      if (!path || rawValue === undefined)
        throw new ToolError("INVALID_PARAMS", "Usage: tradekit config push <dotted.path> <value>");
      const parsedNew = parseConfigValue(rawValue);
      const { config: next, alreadyPresent, length } = pushConfigArray(config, path, parsedNew);
      // Iter363: --json output. Two outcomes: pushed (new) or noop-already-present.
      if (!alreadyPresent) {
        saveConfig(next, { source: `cli:config push` });
        autoKickEngine();
      }
      if (flags["json"] === "true") {
        printJson({
          // Iter450: ok:true envelope parity (iter445-449 arc).
          ok: true,
          action: alreadyPresent ? "noop-already-present" : "pushed",
          path, value: parsedNew, length,
          timestamp: new Date().toISOString(),
        });
        break;
      }
      if (alreadyPresent) console.log(`(already present: ${path} contains ${JSON.stringify(parsedNew)})`);
      else console.log(`Pushed: ${path} now has ${length} item${length === 1 ? "" : "s"}.`);
      break;
    }
    case "drop": {
      const path = positional[2];
      const rawValue = positional[3] ?? flags["value"];
      if (!path || rawValue === undefined)
        throw new ToolError("INVALID_PARAMS", "Usage: tradekit config drop <dotted.path> <value>");
      const parsedDrop = parseConfigValue(rawValue);
      const { config: next, removed, length } = dropConfigArray(config, path, parsedDrop);
      // Iter363: --json output. Two outcomes: dropped (removed) or noop-not-found.
      if (removed) {
        saveConfig(next, { source: `cli:config drop` });
        autoKickEngine();
      }
      if (flags["json"] === "true") {
        printJson({
          // Iter450: ok:true envelope parity (iter445-449 arc).
          ok: true,
          action: removed ? "dropped" : "noop-not-found",
          path, value: parsedDrop, length,
          timestamp: new Date().toISOString(),
        });
        break;
      }
      if (!removed) console.log(`(not found: ${path} did not contain ${JSON.stringify(parsedDrop)})`);
      else console.log(`Dropped: ${path} now has ${length} item${length === 1 ? "" : "s"}.`);
      break;
    }
    case "preflight": {
      // Iter35: dry-run impact analysis. Two modes:
      //   (1) --file PATH: read a tentative config from PATH and diff
      //       it against the currently-saved config. Used by CI gates
      //       on a PR-modified config.
      //   (2) no --file: compare the CURRENTLY-SAVED config against
      //       what the supervisor LAST loaded. v1 simplification:
      //       since we don't persist the supervisor's loaded snapshot,
      //       this collapses to "no diff" — informative output that
      //       tells the operator how to use the command. Future iters
      //       can persist the last-reloaded-at snapshot.
      const filePath = flags["file"];
      let newConfig: Config;
      if (filePath) {
        try {
          const { readFileSync } = await import("node:fs");
          const raw = JSON.parse(readFileSync(filePath, "utf8"));
          // Use the same loader path validation as on-disk reads.
          // configSchema.parse normalizes defaults + rejects bad keys.
          const { configSchema } = await import("../config.js");
          newConfig = configSchema.parse(raw);
        } catch (e) {
          throw new ToolError("INVALID_PARAMS", `Could not load --file "${filePath}": ${(e as Error).message}`);
        }
      } else {
        // Compare current → current — no diff. Mostly a "is anything
        // wrong with my current config?" smoke test.
        newConfig = config;
      }
      const impact = computeImpactAgainstActive({ oldConfig: config, newConfig });
      if (flags["json"] === "true") {
        printJson({ ok: true, impact });
        if (flags["strict"] === "true" && impact.summary.criticalCount > 0) {
          process.exitCode = 1;
        }
        break;
      }
      if (impact.diff.length === 0) {
        console.log("No semantic differences between the configs.");
        break;
      }
      console.log(`Config preflight: ${impact.diff.length} change(s).`);
      console.log(
        `  ${impact.summary.criticalCount} critical · ${impact.summary.warnCount} warn · ${impact.summary.infoCount} info`,
      );
      if (impact.summary.affectedOrders + impact.summary.affectedSchedules > 0) {
        console.log(
          `  Affected primitives: ${impact.summary.affectedOrders} order(s), ${impact.summary.affectedSchedules} schedule(s)`,
        );
      }
      console.log("");
      console.log("Diffs:");
      for (const d of impact.diff) {
        const arrow = d.oldValue == null ? "+" : d.newValue == null ? "−" : "→";
        console.log(`  [${d.kind.padEnd(9)}] ${d.path}  ${JSON.stringify(d.oldValue)} ${arrow} ${JSON.stringify(d.newValue)}`);
      }
      if (impact.warnings.length > 0) {
        console.log("");
        console.log("Warnings:");
        for (const w of impact.warnings) {
          const badge = w.severity === "critical" ? "✕" : w.severity === "warn" ? "⚠" : "·";
          console.log(`  ${badge} [${w.severity}] ${w.message}`);
          for (const a of w.affected.slice(0, 5)) {
            console.log(`      → ${a.type} #${a.id}: ${a.reason}`);
          }
          if (w.affected.length > 5) {
            console.log(`      …and ${w.affected.length - 5} more.`);
          }
        }
      }
      if (flags["strict"] === "true" && impact.summary.criticalCount > 0) {
        process.exitCode = 1;
      }
      break;
    }
    case "reload": {
      // Iter35: trigger a hot-reload on a running engine. No-op when
      // no engine is running (the next `engine run` picks up the
      // current config naturally). Mirrors `nginx -s reload` /
      // `systemctl reload` UX.
      const r = kickRunningEngine();
      if (flags["json"] === "true") {
        printJson({ ok: true, ...r });
        if (!r.delivered && r.reason !== "no_status_file") process.exitCode = 1;
        break;
      }
      if (r.delivered) {
        console.log(`SIGHUP sent to engine pid ${r.pid}; reload in flight (watch logs / notifications for completion).`);
      } else if (r.reason === "no_status_file") {
        console.log("No engine status file found. The engine isn't running on this install; nothing to reload.");
      } else if (r.reason === "stale_pid") {
        console.log("Engine status file exists but the pid is no longer alive (stale crash residue). Nothing to reload.");
      } else if (r.reason === "self") {
        console.log("Refusing to signal the current process (you're running this from inside the engine).");
      } else {
        console.log(`Could not deliver SIGHUP to pid ${r.pid}: ${r.reason}.`);
        process.exitCode = 1;
      }
      break;
    }
    case "history": {
      const { listConfigHistory, latestConfigHistory } = await import("../db.js");
      const rows = listConfigHistory(flags["limit"] ? parseInt(flags["limit"], 10) : 20);
      if (flags["json"] === "true") {
        printJson({ ok: true, count: rows.length, history: rows });
        break;
      }
      if (rows.length === 0) {
        console.log("No config history yet — versions record on every config save (once the DB exists).");
        break;
      }
      const latest = latestConfigHistory();
      for (const r of rows) {
        const marker = latest && r.id === latest.id ? " ← current" : "";
        console.log(`  #${r.id}  ${r.saved_at}  ${r.hash}  ${r.source ?? "(unknown source)"}${marker}`);
      }
      console.log(`\nInspect: tradekit config diff-version <id> · Roll back: tradekit config rollback <id> --yes`);
      break;
    }
    case "diff-version": {
      const idArg = parseInt(positional[2] ?? "", 10);
      if (!Number.isInteger(idArg) || idArg <= 0) {
        throw new ToolError("INVALID_PARAMS", "Usage: tradekit config diff-version <history-id>");
      }
      const { getConfigHistoryById } = await import("../db.js");
      const row = getConfigHistoryById(idArg);
      if (!row) throw new ToolError("INVALID_PARAMS", `No config history #${idArg}.`);
      const old = JSON.parse(row.content) as Record<string, unknown>;
      const cur = JSON.parse(JSON.stringify(loadConfig())) as Record<string, unknown>;
      const diffs = diffFlat(old, cur);
      if (flags["json"] === "true") {
        printJson({ ok: true, id: idArg, savedAt: row.saved_at, diffs });
        break;
      }
      if (diffs.length === 0) {
        console.log(`Version #${idArg} (${row.saved_at}) is identical to the current config.`);
        break;
      }
      console.log(`Current config vs version #${idArg} (${row.saved_at}):`);
      for (const d of diffs) {
        console.log(`  ${d.path}`);
        console.log(`    then: ${JSON.stringify(d.oldValue)}`);
        console.log(`    now:  ${JSON.stringify(d.newValue)}`);
      }
      break;
    }
    case "rollback": {
      const idArg = parseInt(positional[2] ?? "", 10);
      if (!Number.isInteger(idArg) || idArg <= 0) {
        throw new ToolError("INVALID_PARAMS", "Usage: tradekit config rollback <history-id> --yes");
      }
      const { getConfigHistoryById } = await import("../db.js");
      const row = getConfigHistoryById(idArg);
      if (!row) throw new ToolError("INVALID_PARAMS", `No config history #${idArg}.`);
      // Schema-validate the stored snapshot BEFORE writing — an old
      // version may predate schema additions; configSchema's defaults
      // fill forward-compatible gaps, hard validation errors abort.
      const candidate = configSchema.parse(JSON.parse(row.content));
      const diffs = diffFlat(JSON.parse(JSON.stringify(loadConfig())) as Record<string, unknown>, JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>);
      if (flags["yes"] !== "true") {
        console.log(`Rollback to version #${idArg} (${row.saved_at}, ${row.source ?? "unknown source"}) would change ${diffs.length} field(s):`);
        for (const d of diffs.slice(0, 12)) {
          console.log(`  ${d.path}: ${JSON.stringify(d.oldValue)} → ${JSON.stringify(d.newValue)}`);
        }
        if (diffs.length > 12) console.log(`  … ${diffs.length - 12} more`);
        console.log(`\nConfirm with --yes (config controls live safety caps — review first).`);
        break;
      }
      saveConfig(candidate, { source: `rollback:#${idArg}` });
      autoKickEngine();
      if (flags["json"] === "true") {
        printJson({ ok: true, rolledBackTo: idArg, changedFields: diffs.length });
      } else {
        console.log(`Rolled back to version #${idArg} — ${diffs.length} field(s) changed. (Recorded as a NEW history version; nothing is lost.)`);
      }
      break;
    }
    default:
      throw subcommandError("config", action, [
        "show", "get", "set", "push", "drop", "path", "validate", "preflight", "reload",
        "history", "diff-version", "rollback",
      ]);
  }
}

/** v36: flat dot-path diff between two plain config objects.
 *  Arrays compare as values (JSON equality) — element-level diffs of
 *  channel lists read worse than whole-value ones. */
function diffFlat(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
): Array<{ path: string; oldValue: unknown; newValue: unknown }> {
  const out: Array<{ path: string; oldValue: unknown; newValue: unknown }> = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    const aIsObj = a != null && typeof a === "object" && !Array.isArray(a);
    const bIsObj = b != null && typeof b === "object" && !Array.isArray(b);
    if (aIsObj && bIsObj) {
      const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
      for (const k of keys) {
        walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ path, oldValue: a, newValue: b });
    }
  };
  walk(oldObj, newObj, "");
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

// ── chains / chain ──────────────────────────────────────────

export async function chainsCommand(flags: Record<string, string> = {}) {
  const config = loadConfig();
  // Built-ins + any custom chains the user added via config.chains.<name>.*. Pre-iter161
  // this only listed built-ins, hiding any custom L2/L3 the operator had wired up via
  // `config set chains.zora.chainId 7777777 ...`. Now both are visible with a marker
  // showing which entries are operator-defined.
  const customNames = Object.keys(config.chains ?? {}).filter(
    (c) => !listChains().includes(c.toLowerCase()),
  );
  const all = [...listChains(), ...customNames];

  if (flags["json"] === "true") {
    const entries = all.map((name) => {
      const isCustom = customNames.includes(name);
      try {
        const profile = resolveProfile(name, config);
        return {
          name,
          chainId: profile.chainId,
          nativeSymbol: profile.nativeSymbol,
          rpcCount: profile.rpcs.length,
          explorer: profile.explorer,
          active: name === config.activeChain,
          custom: isCustom,
        };
      } catch {
        return { name, custom: isCustom, incomplete: true, active: name === config.activeChain };
      }
    });
    // Iter377: include a snapshot timestamp like iter375 (token list), iter247/248
    // (composite snapshots), iter323 (account list). Snapshot freshness lets a
    // monitoring script tell `chains` responses apart over time without having to
    // wrap them itself.
    printJson({
      // Iter450: ok:true envelope parity (iter445-449 arc).
      ok: true,
      activeChain: config.activeChain,
      chains: entries,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  console.log(`Active chain: ${config.activeChain}\n`);
  for (const name of all) {
    let profile;
    try {
      profile = resolveProfile(name, config);
    } catch {
      // Custom chain entry exists in config but doesn't pass required-fields check
      // (iter101's empty-shell scenario). Still surface it so the user notices.
      console.log(` ${name.padEnd(10)} (incomplete — see 'doctor' or 'config show')`);
      continue;
    }
    const marker = name === config.activeChain ? "*" : " ";
    const customTag = customNames.includes(name) ? " [custom]" : "";
    console.log(
      `${marker} ${name.padEnd(10)} chainId=${profile.chainId}  native=${profile.nativeSymbol}  rpcs=${profile.rpcs.length}  explorer=${profile.explorer}${customTag}`,
    );
  }
}

/** Set the active chain (validates the chain exists first). */
export async function chainCommand(positional: string[], flags: Record<string, string> = {}) {
  const raw = positional[1];
  if (!raw) {
    await chainsCommand(flags);
    return;
  }
  // resolveProfile lowercases internally but config keys are case-sensitive — write
  // the canonical lowercase form so subsequent `config.chains[lower]` lookups hit.
  const name = raw.toLowerCase();
  const config = loadConfig();
  resolveProfile(name, config); // throws UNKNOWN_CHAIN if neither built-in nor overridden
  // Iter327: report whether the chain actually changed. Pre-iter327 `tradekit chain
  // base` (when base was already active) silently rewrote the config with the same
  // value and logged "Active chain: base" — same kind of dishonest success message
  // iter312 fixed for `config set`. Now the no-op case is distinct.
  const previous = config.activeChain;
  const changed = previous !== name;
  if (changed) {
    const next = setConfigPath(config, "activeChain", name);
    saveConfig(next);
  }
  // Iter361: --json output for scripted setup. Same {previousActive, active, changed,
  // timestamp} shape as iter360's accountUse so automation can branch on `changed` for
  // both the chain and the account switch with one parser. Pre-iter361 scripts piping
  // `tradekit chain X --json` to jq crashed on the human "Active chain: X → Y." text.
  if (flags["json"] === "true") {
    printJson({
      // Iter449: ok:true envelope parity (continues iter445-448 arc).
      ok: true,
      previousChain: previous,
      activeChain: name,
      changed,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (changed) console.log(`Active chain: ${previous} → ${name}.`);
  else console.log(`(no change: active chain was already ${name})`);
}

// ── token (list / add / remove) ─────────────────────────────

export async function tokenCommand(
  action: string | undefined,
  flags: Record<string, string>,
  positional: string[],
) {
  switch (action) {
    case "add": {
      const chain = positional[2]?.toLowerCase();
      const symbol = positional[3];
      const address = positional[4];
      if (!chain || !symbol || !address) {
        throw new ToolError("INVALID_PARAMS", "Usage: tradekit token add <chain> <symbol> <address>");
      }
      const { isAddress, getAddress } = await import("viem");
      if (!isAddress(address, { strict: false })) {
        throw new ToolError("INVALID_PARAMS", `Invalid address: ${address}`);
      }
      const checksummed = getAddress(address.toLowerCase() as `0x${string}`);

      const config = loadConfig();
      const profile = resolveProfile(chain, config); // ensures the chain exists
      // Iter311: distinguish ADD-new from UPDATE-existing from SHADOW-builtin. Pre-
      // iter311 every `token add` printed "Added ${symbol}" — operator overwriting a
      // built-in or an existing override got no signal that they'd shadowed/replaced
      // something. Same honesty discipline as iter310's `token remove` fix.
      const { getBuiltinProfile } = await import("../chains.js");
      const builtin = getBuiltinProfile(chain);
      const existingOverride = config.chains[chain]?.tokens?.[symbol];
      const isBuiltinSymbol = builtin ? symbol in builtin.tokens : false;
      const path = `chains.${chain}.tokens.${symbol}`;
      const next = setConfigPath(config, path, checksummed);
      saveConfig(next);
      // Iter362: --json output. Same iter313-style discriminator (action: added/updated/
      // shadowed) so scripts can branch on the three iter311 outcomes without parsing
      // the human-readable lines. Pre-iter362 scripts piping `token add ... --json | jq`
      // crashed; now they get a stable shape.
      const overrideCount = Object.keys(next.chains[chain]?.tokens ?? {}).length;
      const builtinCount = Object.keys(profile.tokens).length - overrideCount;
      let action: "added" | "updated" | "shadowed";
      let previousAddress: string | null = null;
      if (existingOverride) {
        action = "updated";
        previousAddress = existingOverride;
      } else if (isBuiltinSymbol) {
        action = "shadowed";
        previousAddress = builtin!.tokens[symbol];
      } else {
        action = "added";
      }
      if (flags["json"] === "true") {
        printJson({
          // Iter450: ok:true envelope parity (iter445-449 arc).
          ok: true,
          action, chain, symbol,
          address: checksummed,
          previousAddress,
          tokenCount: { overrides: overrideCount, builtin: builtinCount },
          timestamp: new Date().toISOString(),
        });
        break;
      }
      if (action === "updated") {
        console.log(`Updated ${symbol} override on ${chain}: ${previousAddress} → ${checksummed}.`);
      } else if (action === "shadowed") {
        console.log(`Added ${symbol} override on ${chain}, shadowing the built-in (was ${previousAddress} → ${checksummed}).`);
      } else {
        console.log(`Added ${symbol} → ${checksummed} on ${chain}.`);
      }
      console.log(
        `Tokens registered on ${chain}: ${overrideCount} override(s) + ${builtinCount} builtin.`,
      );
      break;
    }
    case "list": {
      const chain = (positional[2] ?? loadConfig().activeChain).toLowerCase();
      const config = loadConfig();
      const profile = resolveProfile(chain, config);
      // Distinguish built-in token entries from user-added overrides so an operator
      // who just ran `token add CUSTOM 0x...` can verify it landed. Pre-iter188 the
      // list merged both and showed no provenance.
      const { getBuiltinProfile } = await import("../chains.js");
      const builtin = getBuiltinProfile(chain);
      const builtinSyms = new Set(builtin ? Object.keys(builtin.tokens) : []);
      const overrides = config.chains[chain]?.tokens ?? {};
      if (flags["json"] === "true") {
        // Iter375: include `chain` and a snapshot `timestamp` so scripts processing
        // multiple chains' token lists can tell the responses apart, and so the
        // shape matches the iter247/248/323 envelope convention used elsewhere.
        printJson({
          // Iter450: ok:true envelope parity (iter445-449 arc).
          ok: true,
          chain,
          tokens: profile.tokens,
          builtin: Object.fromEntries(Object.entries(profile.tokens).filter(([s]) => builtinSyms.has(s) && !(s in overrides))),
          custom: overrides,
          timestamp: new Date().toISOString(),
        });
      } else {
        const sorted = Object.entries(profile.tokens).sort(([a], [b]) => a.localeCompare(b));
        if (sorted.length === 0) {
          // Common for custom chains where the operator hasn't added tokens yet.
          // Pre-iter213 the output was just a bare "Tokens on chain:" header with
          // no rows — looked like the command had hung or rendered wrong.
          console.log(`No tokens registered on ${chain}. Add one with \`tradekit token add ${chain} <SYMBOL> <0xaddress>\`.`);
        } else {
          console.log(`Tokens on ${chain}:`);
          for (const [sym, addr] of sorted) {
            const overridden = sym in overrides;
            const tag = overridden ? (builtinSyms.has(sym) ? " [override]" : " [custom]") : "";
            console.log(`  ${sym.padEnd(10)} ${addr}${tag}`);
          }
        }
      }
      break;
    }
    case "remove": {
      const chain = positional[2]?.toLowerCase();
      const symbol = positional[3];
      if (!chain || !symbol) throw new ToolError("INVALID_PARAMS", "Usage: tradekit token remove <chain> <symbol>");
      const config = loadConfig();
      // Iter310: distinguish "actually removed an override" from "no-op because the
      // symbol was built-in or never present." Pre-iter310 the message always claimed
      // "Removed ${symbol}" — an operator running `token remove base USDC` (USDC is
      // built-in on base) saw "Removed USDC" but `token list base` still showed USDC.
      // Misleading. Now: explicit feedback on what actually happened.
      const overrides = config.chains[chain]?.tokens ?? {};
      const wasOverride = symbol in overrides;
      // Iter362: --json shape mirrors iter310's three outcomes as a discriminator.
      // action: removed | noop-builtin | noop-missing.
      if (!wasOverride) {
        const { getBuiltinProfile } = await import("../chains.js");
        const builtin = getBuiltinProfile(chain);
        const isBuiltin = builtin && symbol in builtin.tokens;
        if (flags["json"] === "true") {
          printJson({
            // Iter450: ok:true envelope parity (iter445-449 arc).
            ok: true,
            action: isBuiltin ? "noop-builtin" : "noop-missing",
            chain, symbol,
            removedAddress: null,
            timestamp: new Date().toISOString(),
          });
          break;
        }
        if (isBuiltin) {
          console.log(`${symbol} is a built-in token on ${chain} and can't be removed (no override exists to remove). To shadow it, use \`tradekit token add ${chain} ${symbol} <new-address>\`.`);
        } else {
          console.log(`No ${symbol} override on ${chain} — nothing to remove.`);
        }
        break;
      }
      const removedAddress = overrides[symbol];
      const next = setConfigPath(config, `chains.${chain}.tokens.${symbol}`, undefined);
      saveConfig(next);
      if (flags["json"] === "true") {
        printJson({
          // Iter450: ok:true envelope parity (iter445-449 arc).
          ok: true,
          action: "removed",
          chain, symbol,
          removedAddress,
          timestamp: new Date().toISOString(),
        });
        break;
      }
      console.log(`Removed ${symbol} override from ${chain}.`);
      break;
    }
    // Iter609: `tradekit token check <address>` — run a buy+sell round-trip
    // simulation probe to detect honeypots / high-transfer-tax tokens BEFORE
    // committing real funds. Costs ~4 RPC roundtrips, zero gas.
    case "check": {
      const address = positional[2];
      if (!address) {
        throw new ToolError("INVALID_PARAMS", "Usage: tradekit token check <address> [--chain <name>] [--probe-usd <N>]");
      }
      const { isAddress } = await import("viem");
      if (!isAddress(address, { strict: false })) {
        throw new ToolError(
          "INVALID_PARAMS",
          `Invalid token address: ${address} (expected 0x-prefixed 40 hex chars)`,
          { details: { providedAddress: address, reason: "bad_address_shape" } },
        );
      }
      const config = loadConfig();
      const chainName = flags["chain"] ?? config.activeChain;
      const profile = resolveProfile(chainName, config);
      const probeUsd = flags["probe-usd"] ? parseFloat(flags["probe-usd"]) : undefined;
      const logger = makeCliLogger(flags);

      try {
        const { loadReadOnlyWallet } = await import("../wallet.js");
        const extraRpcs = config.chains[chainName]?.rpcs ?? [];
        const wallet = loadReadOnlyWallet(profile, extraRpcs, flags["account"]);
        const { checkTokenSafety, shortVerdictLine } = await import("../tokenSafety.js");
        const report = await checkTokenSafety({
          token: address as `0x${string}`,
          probeUsd,
          publicClient: wallet.publicClient,
          walletAddress: wallet.account.address as `0x${string}`,
          profile,
          config,
          logger,
        });

        // Iter776: --strict exit-code gate. honeypot + suspicious are the
        // actionable-bad verdicts (don't trade this); ok + unknown stay exit 0
        // (unknown means the probe was inconclusive, not bad-detected, so a
        // pipeline that conservatively wants to refuse on unknown can layer
        // its own check on the JSON verdict field). process.exitCode (not
        // process.exit) so main()'s audit-insert finally block runs.
        const strict = flags["strict"] === "true" || flags["strict"] === "";
        const isBad = report.verdict === "honeypot" || report.verdict === "suspicious";

        if (flags["json"] === "true") {
          printJson({ ok: true, ...report });
          if (strict && isBad) process.exitCode = 1;
          break;
        }

        console.log(shortVerdictLine(report));
        console.log("");
        console.log(`  Chain:        ${report.chain}`);
        console.log(`  Token:        ${report.symbol} (${report.token})`);
        console.log(`  Probe size:   $${report.probeUsd} ≈ ${report.probeNativeAmount} ${profile.nativeSymbol}`);
        console.log("");
        console.log(`  Buy:`);
        console.log(`    Quoted:     ${report.buyQuoted ? "yes" : "NO"}`);
        console.log(`    Simulated:  ${report.buySimulated ? "yes" : "NO"}${report.buyRevertReason ? " (" + report.buyRevertReason + ")" : ""}`);
        if (report.expectedTokenOut) console.log(`    Expected:   ${report.expectedTokenOut} ${report.symbol}`);
        console.log(`  Sell:`);
        console.log(`    Quoted:     ${report.sellQuoted ? "yes" : "NO"}`);
        console.log(`    Simulated:  ${report.sellSimulated ? "yes" : "NO"}${report.sellRevertReason ? " (" + report.sellRevertReason + ")" : ""}`);
        if (report.expectedNativeOut) console.log(`    Expected:   ${report.expectedNativeOut} ${profile.nativeSymbol}`);
        if (report.roundTripLossPct != null) {
          console.log("");
          console.log(`  Round-trip loss: ${report.roundTripLossPct.toFixed(2)}% (suspicious threshold: ${report.suspiciousLossPct}%)`);
        }
        console.log("");
        console.log("  Reasoning:");
        for (const r of report.reasons) console.log(`    - ${r}`);
        if (strict && isBad) process.exitCode = 1;
      } finally {
        logger.close();
      }
      break;
    }
    // Iter629: `tradekit token info <address>` — unified per-token report
    // (metadata + price + balance + approvals + recent trades + advisory).
    // Composes existing primitives into one read so operators investigating
    // a token don't run 5 separate commands.
    case "info": {
      const address = positional[2];
      if (!address) {
        throw new ToolError(
          "INVALID_PARAMS",
          "Usage: tradekit token info <address> [--chain <name>] [--account <label>] [--json]",
        );
      }
      const { isAddress, getAddress } = await import("viem");
      if (!isAddress(address, { strict: false })) {
        throw new ToolError(
          "INVALID_PARAMS",
          `Invalid token address: ${address} (expected 0x-prefixed 40 hex chars)`,
          { details: { providedAddress: address, reason: "bad_address_shape" } },
        );
      }
      const config = loadConfig();
      const chainName = flags["chain"] ?? config.activeChain;
      const profile = resolveProfile(chainName, config);
      const logger = makeCliLogger(flags);
      try {
        const { loadReadOnlyWallet } = await import("../wallet.js");
        const extraRpcs = config.chains[chainName]?.rpcs ?? [];
        const wallet = loadReadOnlyWallet(profile, extraRpcs, flags["account"]);
        const { gatherTokenInfo } = await import("../tokenInfo.js");
        const report = await gatherTokenInfo({
          chain: chainName,
          address: getAddress(address.toLowerCase() as `0x${string}`),
          owner: wallet.account.address,
          publicClient: wallet.publicClient,
          profile,
          config,
          logger,
        });

        if (flags["json"] === "true") {
          printJson({ ok: true, ...report });
          break;
        }

        // Iter762: elapsedMs suffix — parity with iter731 reconcile/pnl/etc.
        const elapsedSuffix = report.elapsedMs != null
          ? `  (${(report.elapsedMs / 1000).toFixed(1)}s)`
          : "";
        console.log(`Token info — ${report.symbol} on ${report.chain}${elapsedSuffix}`);
        console.log("=".repeat(60));
        console.log(`  Address:       ${report.address}`);
        console.log(`  Decimals:      ${report.decimals}`);
        if (report.priceUsd != null) {
          console.log(`  Price:         $${report.priceUsd.toLocaleString("en-US", { maximumFractionDigits: 6 })}`);
          console.log(`                 source: ${report.priceSource}`);
        } else {
          console.log("  Price:         — (no oracle)");
        }
        console.log("");
        console.log(`  Owner:         ${report.owner}`);
        console.log(`  Balance:       ${report.balance} ${report.symbol}`);
        if (report.balanceUsd != null) {
          console.log(`  Balance USD:   $${report.balanceUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
        }
        console.log("");
        console.log(`  Approvals on this token: ${report.approvals.length} (${report.approvalCounts.critical} critical, ${report.approvalCounts.warn} warn, ${report.approvalCounts.ok} ok)`);
        for (const a of report.approvals.slice(0, 10)) {
          const badge = a.severity === "critical" ? "🔴" : a.severity === "warn" ? "🟡" : "🟢";
          const sp = a.spenderLabel ?? a.spender;
          console.log(`    ${badge}  ${a.display.padEnd(16)} → ${sp}`);
        }
        if (report.recentTrades.length > 0) {
          console.log("");
          console.log(`  Recent trades involving ${report.symbol}: ${report.totalTradeCount} total`);
          for (const t of report.recentTrades) {
            const pair = `${t.baseSymbol ?? "?"}/${t.quoteSymbol ?? "?"}`;
            console.log(`    ${t.timestamp.slice(0, 19)}  ${t.direction.padEnd(8)} ${pair.padEnd(16)} ${t.baseAmount.padEnd(14)} ${t.status}`);
          }
        }
        if (report.advisory) {
          console.log("");
          console.log(`  ▸ ${report.advisory}`);
        }
        // Iter845: surface iter829 recommendedActions inline. Token info
        // dispatches cover critical-approval revoke hints + price-check
        // re-runs when no oracle is found. Mirrors iter839-844 footer
        // convention. Skips when empty (clean token, no actionable signals).
        if (report.recommendedActions.length > 0) {
          console.log("");
          console.log("Next steps:");
          for (const a of report.recommendedActions) {
            console.log(`  → ${a.reason}`);
          }
        }
      } finally {
        logger.close();
      }
      break;
    }
    default:
      throw subcommandError("token", action, ["add", "list", "remove", "check", "info"]);
  }
}
