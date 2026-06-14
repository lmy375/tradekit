#!/usr/bin/env -S node --experimental-sqlite --no-warnings=ExperimentalWarning

// Tradekit CLI entry point. The dispatch table lives here; every command's
// implementation lives in src/cli/. Helpers (parseArgs, makeCliLogger, withWatch,
// requirePassword, printJson, prompt/promptPassword) all come from cli/helpers.ts.

// Tighten the process-wide file creation mask BEFORE any module that creates files runs
// (db, wallet, accounts, config, logger). New files default to 0600, group+others get
// nothing. Catches SQLite's WAL/SHM sidecars (created lazily after openDb returns) and
// any other future write paths — iter128 handled the explicit writers, this is the
// belt-and-suspenders for files created via library code we don't control.
process.umask(0o077);

import { activeWalletAddress, activeWalletLabel } from "./wallet.js";
import { toToolError, ToolError } from "./errors.js";

// Single source of truth for the helpers — index.ts no longer redeclares them.
import { parseArgs, printJson, closestCommand, subcommandError } from "./cli/helpers.js";

// ── wallet + account commands (moved to ./cli/wallet.ts) ────
import {
  walletCreate,
  walletImport,
  walletExport,
  walletView,
  accountCreate,
  accountImport,
  accountList,
  accountAdd,
  accountUse,
  backupExport,
  backupRestore,
  addressCommand,
} from "./cli/wallet.js";

// ── config / chains / chain / token (moved to ./cli/config-cmd.ts) ─
import { configCommand, chainsCommand, chainCommand, tokenCommand } from "./cli/config-cmd.js";

// ── quote / trade ────────────────────────────────────────────
// Implementations live in ./cli/trade.ts. The dispatch switch below references the
// imported names directly.
import { quoteCommand, tradeCommand, tradeImportCommand, transferCommand, tradePreviewCommand, sweepCommand } from "./cli/trade.js";

// ── inspect commands (moved to ./cli/inspect.ts) ────────────
import {
  holdingsCommand,
  trendingCommand,
  pnlCommand,
  tradesCommand,
  auditCommand,
  portfolioCommand,
  priceCheckCommand,
} from "./cli/inspect.js";

// ── transfer (moved to ./cli/trade.ts) ──────────────────────

// ── approvals (moved to ./cli/approvals.ts) ─────────────────
import { allowancesCommand, approveCommand, revokeCommand } from "./cli/approvals.js";

// ── viewTx ───────────────────────────────────────────────────

// ── viewTx + price (moved to ./cli/inspect.ts) ──────────────
import { viewTxCommand, priceCommand } from "./cli/inspect.js";

// ── init wizard ──────────────────────────────────────────────
// Lives in ./cli/init.ts now. Imported below.
import { initCommand } from "./cli/init.js";

// ── gas command ──────────────────────────────────────────────

// gas/logs/version/doctor moved to ./cli/admin.ts (imported below)


import { gasCommand, logsCommand, versionCommand, doctorCommand, reconcileCommand, txCommand, pendingCommand } from "./cli/admin.js";

// ── mcp / web servers (moved to ./cli/server.ts) ────────────
import { mcpCommand, webCommand } from "./cli/server.js";

// ── usage (moved to ./cli/usage.ts) ─────────────────────────
import { printUsage } from "./cli/usage.js";


// ── main ─────────────────────────────────────────────────────

/**
 * Commands that don't need an audit entry (pure local reads / help). Everything else
 * (wallet ops, trades, queries that touch the network, config mutations) gets logged.
 */
const NO_AUDIT_COMMANDS = new Set([
  "help", "--help", "-h",
  "version", "--version", "-v",
  undefined as unknown as string,
]);

// closestCommand + subcommandError moved to cli/helpers.ts (iter164) so non-index
// modules (config, token, audit) can share the same typo-suggestion logic.

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  // Standalone --version/--help flags (no positional command)
  if ((flags["version"] === "true" || flags["v"] === "true") && positional.length === 0) {
    await versionCommand(flags);
    return;
  }
  if ((flags["help"] === "true" || flags["h"] === "true") && positional.length === 0) {
    printUsage();
    return;
  }
  const command = positional[0];
  const action = positional[1];

  const auditStart = new Date().toISOString();
  const auditPass = !NO_AUDIT_COMMANDS.has(command);
  // Iter342: only append the action to the tool name when the command actually has
  // sub-actions. Pre-iter342 every positional[1] was concatenated, so:
  //   `tradekit chain base`          → tool="chain.base"
  //   `tradekit transfer USDC 0x... max` → tool="transfer.USDC"
  //   `tradekit viewTx 0xabc...`     → tool="viewTx.0xabc..."
  //   `tradekit price PEPE`          → tool="price.PEPE"
  //   `tradekit approve USDC 0x...`  → tool="approve.USDC"
  // ...and the audit table got bloated with one row-class per argument value. An
  // operator running `tradekit audit --tool chain` to inspect every chain switch
  // matched zero rows because "chain" was never the tool name — only "chain.base",
  // "chain.arbitrum", etc. Now: known multi-action commands (`wallet create`,
  // `trade buy`, `config set` ...) keep the dotted form; everything else collapses
  // to just the command name.
  const COMMANDS_WITH_ACTIONS = new Set([
    "wallet", "account", "config", "token", "trade", "allowances", "audit", "order", "notify", "schedule", "engine", "rebalance", "backtest", "playbook", "safety",
  ]);
  const auditTool = action && COMMANDS_WITH_ACTIONS.has(command)
    ? `${command}.${action}`
    : (command ?? "(none)");
  const auditChain = flags["chain"] ?? null;
  // Respect --account so the audit log reflects the account the command ACTUALLY ran
  // against, not the one marked active in accounts.json. Otherwise an agent juggling
  // multiple accounts shows up in audit as a single (active) attribution.
  // Iter500: route through activeWalletLabel so the audit row matches what loadWallet
  // would set as wallet.label (same mnemonic.json gate as iter499). Pre-iter500 the
  // orphaned-accounts.json case had audit say `account=alice` while the trade DB row
  // said `account=keystore` — confusing for forensics. Now both agree.
  const auditAccount = flags["account"] ?? activeWalletLabel();
  // Strip sensitive flags BEFORE serializing — otherwise `tradekit ... --pass mypassword`
  // would persist the wallet password into the audit table. WALLET_PASS env never
  // enters `flags`, so it's already safe.
  const { capAuditParams, redactSensitiveFields } = await import("./db.js");
  const auditParams = capAuditParams(
    JSON.stringify({ positional: positional.slice(1), flags: redactSensitiveFields(flags) }),
  );

  try {
    switch (command) {
      case "wallet":
        switch (action) {
          case "create":
            await walletCreate(flags); break;
          case "import":
            await walletImport(flags); break;
          case "export":
            await walletExport(flags); break;
          case "view":
            await walletView(flags); break;
          default:
            throw subcommandError("wallet", action, ["create", "import", "export", "view"]);
        }
        break;

      case "account":
        switch (action) {
          case "create-mnemonic":
            await accountCreate(flags); break;
          case "import-mnemonic":
            await accountImport(flags); break;
          case "list":
            await accountList(flags); break;
          case "add":
            await accountAdd(flags, positional[2]); break;
          case "use":
            await accountUse(positional[2], flags); break;
          default:
            throw subcommandError("account", action, [
              "create-mnemonic", "import-mnemonic", "list", "add", "use",
            ]);
        }
        break;

      case "config":
        await configCommand(action, flags, positional);
        break;

      case "chains":
        await chainsCommand(flags);
        break;

      case "chain":
        await chainCommand(positional, flags);
        break;

      case "quote":
        await quoteCommand(flags);
        break;

      case "trade":
        if (action === "buy" || action === "sell") await tradeCommand(action, flags);
        else if (action === "import") await tradeImportCommand(flags, positional);
        // Iter608: `tradekit trade preview <buy|sell>` — read-only pre-trade
        // analysis (price impact, slippage cushion, gas %, balance fraction,
        // safety pre-flight). Action position[2] carries buy/sell.
        else if (action === "preview") {
          const dir = positional[2] as "buy" | "sell" | undefined;
          if (dir !== "buy" && dir !== "sell") {
            throw subcommandError("trade preview", dir, ["buy", "sell"]);
          }
          await tradePreviewCommand(dir, flags);
        }
        // Iter630: `tradekit trade preflight <buy|sell>` — composite pre-trade
        // check that runs preview + token safety + price cross-check + history
        // slippage in parallel and emits a go/caution/no_go verdict.
        else if (action === "preflight") {
          const sub = positional[2] as string | undefined;
          // v74: `trade preflight history` — the decision journal (every run's
          // go/caution/no_go verdict, incl. the trades the agent refused).
          if (sub === "history" || sub === "log") {
            const { tradePreflightHistoryCommand } = await import("./cli/trade.js");
            await tradePreflightHistoryCommand(flags);
          } else if (sub === "calibration" || sub === "calibrate") {
            // v75: did the recorded verdicts predict the trades that followed?
            const { tradePreflightCalibrationCommand } = await import("./cli/trade.js");
            await tradePreflightCalibrationCommand(flags);
          } else {
            const dir = sub as "buy" | "sell" | undefined;
            if (dir !== "buy" && dir !== "sell") {
              throw subcommandError("trade preflight", dir, ["buy", "sell", "history", "calibration"]);
            }
            const { tradePreflightCommand } = await import("./cli/trade.js");
            await tradePreflightCommand(dir, flags);
          }
        }
        // v45: unfence an in-flight idempotency key after the operator
        // verified nothing was sent (process died mid-execution).
        else if (action === "release-key") {
          const key = positional[2];
          if (!key) {
            throw new (await import("./errors.js")).ToolError("INVALID_PARAMS", "Usage: tradekit trade release-key <key>");
          }
          const { releaseIdempotencyKey } = await import("./idempotency.js");
          const released = releaseIdempotencyKey(key);
          if (flags["json"] === "true") {
            const { printJson } = await import("./cli/helpers.js");
            printJson({ ok: true, key, released });
          } else {
            console.log(released
              ? `Key "${key}" released — a retry with this key will execute fresh. Only do this after confirming no tx was sent (tradekit trades --limit 5).`
              : `Key "${key}" not found — nothing to release.`);
          }
        } else throw subcommandError("trade", action, ["buy", "sell", "import", "preview", "preflight", "release-key"]);
        break;

      case "trades":
        await tradesCommand(flags, positional);
        break;

      // Iter605: multi-account multi-chain aggregate view. Higher-level summary
      // sibling of `holdings` — same chain/address probe under the hood, but
      // fans out across every (account, chain) pair and reports per-token
      // roll-up + concentration.
      case "portfolio":
        // Iter618: subactions for historical snapshots. `portfolio snapshot`
        // saves the current state to DB; `portfolio history` lists past
        // snapshots; `portfolio diff <ref>` compares current vs a past snapshot.
        // `portfolio` with no subaction runs the iter605 current-state view.
        if (positional[1] === "snapshot") {
          const { portfolioSnapshotCommand } = await import("./cli/inspect.js");
          await portfolioSnapshotCommand(flags);
        } else if (positional[1] === "history") {
          const { portfolioHistoryCommand } = await import("./cli/inspect.js");
          await portfolioHistoryCommand(flags);
        } else if (positional[1] === "diff") {
          const { portfolioDiffCommand } = await import("./cli/inspect.js");
          await portfolioDiffCommand(flags, positional);
        } else {
          await portfolioCommand(flags);
        }
        break;

      case "holdings":
        await holdingsCommand(flags, positional);
        break;

      case "trending":
        await trendingCommand(flags, positional);
        break;

      // Iter623: aggregator quality scorecard. Per-aggregator median/p95
      // slippage + success rate from the trade history. Helps operators
      // pick the right aggregator default.
      case "aggregator": {
        const sub = positional[1];
        if (sub === "tune") {
          // v58: rank aggregators by realized fill quality → optimal
          // config.aggregator.preferred order; --apply writes it.
          const { aggregatorTuneCommand } = await import("./cli/inspect.js");
          await aggregatorTuneCommand(flags);
          break;
        }
        if (sub !== "stats") {
          throw new (await import("./errors.js")).ToolError(
            "INVALID_PARAMS",
            "Usage: tradekit aggregator stats [--since DATE] [--account L] [--chain X] [--json]\n       tradekit aggregator tune [--since DATE] [--apply] [--json]",
          );
        }
        const { aggregatorStatsCommand } = await import("./cli/inspect.js");
        await aggregatorStatsCommand(flags);
        break;
      }

      // Iter634: per-pair slippage analytics. Orthogonal to iter623
      // aggregator stats — buckets by token pair instead of by aggregator.
      // Answers "which pairs give me bad fills" regardless of which
      // aggregator executed them.
      case "pairs": {
        if (positional[1] !== "stats") {
          throw new (await import("./errors.js")).ToolError(
            "INVALID_PARAMS",
            "Usage: tradekit pairs stats [--since DATE] [--account L] [--chain X] [--json]",
          );
        }
        const { pairStatsCommand } = await import("./cli/inspect.js");
        await pairStatsCommand(flags);
        break;
      }

      case "pnl":
        await pnlCommand(flags);
        break;

      // Iter644: standalone slippage suggestion preview.
      // `tradekit slippage suggest <base> <quote>` returns the auto-slippage
      // recommendation without executing a trade.
      case "slippage": {
        if (positional[1] !== "suggest") {
          throw new (await import("./errors.js")).ToolError(
            "INVALID_PARAMS",
            "Usage: tradekit slippage suggest <base> <quote> [--chain X] [--account L] [--lookback-days N] [--json]",
          );
        }
        const { slippageSuggestCommand } = await import("./cli/inspect.js");
        await slippageSuggestCommand(flags, positional);
        break;
      }

      // Iter651: list distinct strategy tags from the trades table. Helps
      // operators discover their own tags + spot typos.
      case "strategies": {
        if (positional[1] && positional[1] !== "list") {
          throw new (await import("./errors.js")).ToolError(
            "INVALID_PARAMS",
            "Usage: tradekit strategies [list] [--chain X] [--account L] [--json]",
          );
        }
        const { strategiesListCommand } = await import("./cli/inspect.js");
        await strategiesListCommand(flags);
        break;
      }

      case "audit":
        await auditCommand(flags, positional);
        break;

      // Iter36: forensic timeline — unified chronological event view
      // across trades / paper / audit / order journal / alerts.
      // Answers "what happened between 13:55 and 14:05?" with one
      // command. Complements iter31 strategy report (state-centric)
      // and iter32 strategy alerts (push-based).
      case "timeline": {
        const { timelineCommand } = await import("./cli/timeline.js");
        await timelineCommand(flags);
        break;
      }

      // Iter37: bulk operations — scoped halt/resume primitives.
      // Atomic + preview-first. The operational primitive between
      // engine_lock (global) and per-primitive cancel/pause.
      case "bulk": {
        const { bulkCommand } = await import("./cli/bulk.js");
        await bulkCommand(action, flags, positional);
        break;
      }

      // Iter40: DB lifecycle ops — stats / integrity / prune /
      // backup / rotate. Surfaces the db_maintenance worker
      // capabilities for one-shot operator use.
      case "db": {
        const { dbCommand } = await import("./cli/db.js");
        await dbCommand(action, flags, positional);
        break;
      }

      case "price":
        await priceCommand(flags, positional);
        break;

      // v65: open-position review — cost basis, unrealized P&L, holding
      // period + projected tax term (exit-timing context).
      case "positions": {
        const { openPositionsCommand } = await import("./cli/inspect.js");
        await openPositionsCommand(flags);
        break;
      }

      // v78: `tradekit risk` — unified runtime risk posture (one verdict
      // synthesizing exposure headroom + concentration + unprotected value +
      // MEV). --strict exits 1 on critical for cron risk gating.
      case "risk": {
        const { riskPostureCommand } = await import("./cli/inspect.js");
        await riskPostureCommand(flags);
        break;
      }

      // Iter613: `tradekit price-check <token>` — cross-source price sanity
      // probe. Compares CoinGecko and DexScreener; flags divergence (likely
      // pool manipulation, stale liquidity, or honeypot pricing trick).
      case "price-check":
        await priceCheckCommand(flags, positional);
        break;

      case "viewTx":
        await viewTxCommand(flags, positional);
        break;

      case "doctor":
        await doctorCommand(flags);
        break;

      // Iter621: `tradekit health` — operator dashboard. Composes portfolio +
      // 7d PnL + trade quality + standing approvals into one read.
      case "health": {
        const { healthCommand } = await import("./cli/health.js");
        await healthCommand(flags);
        break;
      }

      // Iter23: `tradekit status` — operational dashboard. Distinct from
      // health (financial summary); status answers "what is the engine
      // actively managing right now + what's near firing / tripping".
      // Composes engine workers + orders + schedules + rebalance +
      // playbooks + drawdown + budgets + 24h audit into one view.
      case "status": {
        const { statusCommand } = await import("./cli/status.js");
        await statusCommand(flags);
        break;
      }

      // Iter24: `tradekit digest` — windowed activity report. Pairs with
      // status (right-now snapshot); digest answers "what happened over
      // the last N hours/days". Three formats: text/slack/json. The
      // slack format is operational gold — pipe into a Slack webhook
      // for daily reports.
      case "digest": {
        const { digestCommand } = await import("./cli/digest.js");
        await digestCommand(flags);
        break;
      }

      // Iter626: `tradekit verify` — integrity check suite across backup,
      // wallet, config, db. Exits non-zero on any failed check so CI/cron
      // can detect issues automatically.
      case "verify": {
        const { verifyCommand } = await import("./cli/verify.js");
        await verifyCommand(flags, positional);
        break;
      }

      case "reconcile":
        await reconcileCommand(flags);
        break;

      // Iter622: diagnose pending trades — explain WHY each is stuck and
      // recommend an action (wait, speedup, cancel-earlier-nonce, etc.).
      case "pending":
        await pendingCommand(flags);
        break;

      case "init":
        await initCommand(flags);
        break;

      case "logs":
        await logsCommand(flags);
        break;

      case "gas":
        await gasCommand(flags);
        break;

      case "allowances":
        await allowancesCommand(flags, positional);
        break;

      case "approve":
        await approveCommand(flags, positional);
        break;

      case "revoke":
        await revokeCommand(flags, positional);
        break;

      case "transfer":
        await transferCommand(flags, positional);
        break;

      // Iter610: multi-source balance consolidation. Plans the full transfer
      // set (which token from which source) up-front + executes after explicit
      // confirmation.
      case "sweep":
        await sweepCommand(flags);
        break;

      // Iter603: tx speedup/cancel — `tradekit tx speedup <hash>` and `tradekit tx cancel <hash> --yes`.
      // Subcommand-style (`tx <action> ...`) to keep the top-level surface clean and
      // group the related ops together; mirror's MCP's speedup_tx/cancel_tx pair.
      case "tx":
        await txCommand(action, flags, positional);
        break;

      // Iter612: `tradekit backup export <file>` / `backup restore <file>` —
      // full-state encrypted backup + restore. NOT exposed at MCP (sysadmin
      // operation, password required, file-system action).
      case "backup":
        if (action === "export") await backupExport(flags, positional);
        else if (action === "restore") await backupRestore(flags, positional);
        else throw subcommandError("backup", action, ["export", "restore"]);
        break;

      // Iter614: address book — `tradekit address add|list|remove`.
      // Persistent named aliases for transfer recipients (@name resolution).
      // Defends against clipboard-hijack + typo errors.
      case "address":
        await addressCommand(action, flags, positional);
        break;

      case "token":
        await tokenCommand(action, flags, positional);
        break;

      // Conditional / limit orders: standing intents that fire when the
      // price predicate (≤ X / ≥ X) is satisfied. The engine routes
      // triggered orders through executeTrade so every safety guardrail
      // and audit row is inherited. Subactions: create / list / show /
      // cancel / run.
      case "order": {
        const { orderCommand } = await import("./cli/orders.js");
        await orderCommand(action, flags, positional);
        break;
      }

      // Notification / webhook channels — push delivery of order fills,
      // trade reverts, infinite approvals, etc. to Slack / Discord /
      // Telegram / generic webhooks. Subactions: list / test.
      case "notify": {
        const { notifyCommand } = await import("./cli/notify.js");
        await notifyCommand(action, flags);
        break;
      }

      // Recurring / scheduled trades (DCA primitive). Cron-driven engine
      // that fires trades through executeTrade on schedule. Subactions:
      // create / list / show / pause / resume / cancel / run.
      case "schedule": {
        const { scheduleCommand } = await import("./cli/schedules.js");
        await scheduleCommand(action, flags, positional);
        break;
      }

      // Unified engine supervisor — single-process daemon that runs
      // orders + schedules + reconcile on independent cadences. The
      // natural production deployment unit. Subactions: run / status.
      case "engine": {
        const { engineCommand } = await import("./cli/engine.js");
        await engineCommand(action, flags);
        break;
      }

      // Portfolio rebalancing — declarative target-weight plans. Each
      // plan periodically evaluates portfolio drift and corrects via
      // executeTrade when drift exceeds the threshold. Subactions:
      // create / list / show / pause / resume / cancel / run.
      case "rebalance": {
        const { rebalanceCommand } = await import("./cli/rebalance.js");
        await rebalanceCommand(action, flags, positional);
        break;
      }

      // Historical strategy backtesting. Replays one order or schedule
      // against a CoinGecko price series + starting balance and
      // persists the result. Subactions: order / schedule / list / show.
      case "backtest": {
        const { backtestCommand } = await import("./cli/backtest.js");
        await backtestCommand(action, flags, positional);
        break;
      }

      // Declarative strategy playbooks. A playbook JSON file specifies
      // a bundle of orders / schedules / rebalance plans that get
      // deployed atomically and torn down together. Subactions:
      // validate / deploy / list / show / destroy.
      case "playbook": {
        const { playbookCommand } = await import("./cli/playbooks.js");
        await playbookCommand(action, flags, positional);
        break;
      }

      // Stateful safety primitives. v1: drawdown circuit breaker
      // inspection + manual reset. Distinguished from `config` (which
      // edits config) and from existing `health` (which is read-only
      // health summary). Subactions: drawdown / reset-drawdown.
      case "safety": {
        const { safetyCommand } = await import("./cli/safety.js");
        await safetyCommand(action, flags, positional);
        break;
      }

      // Paper trading mode (iter30). Inspect / seed / wipe the
      // virtual book that --paper orders / schedules fire against.
      // Subactions: trades / balances / deposit / pnl / reset.
      case "paper": {
        const { paperCommand } = await import("./cli/paper.js");
        await paperCommand(action, flags, positional);
        break;
      }

      // Unified strategy observability (iter31). Pulls together
      // playbook + orders + schedules + rebalances + trades +
      // budgets + drawdown + journal into a single report keyed
      // by strategy tag. Subactions: report / list.
      case "strategy": {
        const { strategyCommand } = await import("./cli/strategy.js");
        await strategyCommand(action, flags, positional);
        break;
      }

      // v47: human-in-the-loop approval queue for agent trades.
      case "intents": {
        const { intentsCommand } = await import("./cli/intents.js");
        await intentsCommand(action, flags, positional);
        break;
      }

      // v44: execution quality — slippage by aggregator/pair/size,
      // trend vs prior window, threshold-gated recommendations.
      case "execution": {
        const { executionCommand } = await import("./cli/execution.js");
        await executionCommand(flags);
        break;
      }

      // v39: one-command postmortem — verdict + actions + failures +
      // config changes + notes + critical/warn tail as one markdown.
      case "incident": {
        const { incidentCommand } = await import("./cli/incident.js");
        await incidentCommand(flags);
        break;
      }

      // v37: operator notes — the forensic timeline's human layer.
      case "note": {
        const { noteCommand } = await import("./cli/note.js");
        await noteCommand(action, flags, positional);
        break;
      }

      // v36: realized-gains export (tax season).
      case "export": {
        const { exportCommand } = await import("./cli/export.js");
        await exportCommand(action, flags);
        break;
      }

      // v35: external signal events — fire / inspect the inbox that
      // drives signal-armed orders.
      case "signal": {
        const { signalCommand } = await import("./cli/signal.js");
        await signalCommand(action, flags, positional);
        break;
      }

      // Equity curve from portfolio snapshots (pure DB read).
      case "equity": {
        const { equityCommand } = await import("./cli/equity.js");
        await equityCommand(flags);
        break;
      }

      // Emergency stop: engine lock + pause everything in one command.
      // CLI-only by design (no MCP exposure — same safety boundary as
      // backup).
      case "panic": {
        const { panicCommand } = await import("./cli/panic.js");
        await panicCommand(action, flags, positional);
        break;
      }

      // Funding-runway forecast: will live automation run out of
      // money, and when? Walks upcoming schedule fires + reserved
      // order spends against current balances.
      case "runway": {
        const { runwayCommand } = await import("./cli/runway.js");
        await runwayCommand(flags);
        break;
      }

      // Prometheus-style metrics snapshot — one-shot stdout for cron /
      // node_exporter textfile-collector integration. Live scraping
      // goes through the web server's /metrics route or the engine's
      // --metrics-port listener.
      case "metrics": {
        const { metricsCommand } = await import("./cli/metrics.js");
        await metricsCommand(flags);
        break;
      }

      case "mcp":
        await mcpCommand(flags);
        break;

      case "web":
        await webCommand(flags);
        break;

      case "version":
      case "--version":
      case "-v":
        await versionCommand(flags);
        break;

      case undefined:
      case "help":
      case "--help":
      case "-h":
        // First-run friendly: when no command is given and no wallet exists,
        // surface the welcome banner and STOP. Iter858 — pre-iter858 we
        // printed the banner THEN immediately dumped 230 lines of usage,
        // burying the "Run `tradekit init`" nudge before the operator could
        // read it. New flow: banner-only for first-run; explicit `tradekit
        // help` for the full reference.
        if (command === undefined && !activeWalletAddress()) {
          // Iter863: --json mode emits a structured "not-yet-configured" status
          // so CI / scripts checking "is tradekit set up?" can branch on the
          // wallet field instead of parsing the banner. `ok: false` signals
          // the install isn't ready for trading; `needsInit: true` is the
          // explicit "run `tradekit init`" hint.
          if (flags["json"] === "true") {
            const { loadConfig } = await import("./config.js");
            const cfg = loadConfig();
            const version = (await import("./version.js")).tradekitVersion();
            // Iter923: include platform + arch for symmetry with the iter862
            // has-wallet path. Universally-present fields mean scripts can
            // read body.platform / body.arch without a defined-check across
            // configured vs unconfigured installs.
            printJson({
              ok: false,
              version,
              node: process.versions.node,
              platform: process.platform,
              arch: process.arch,
              wallet: null,
              account: null,
              activeChain: cfg.activeChain,
              needsInit: true,
              hint: "Run `tradekit init` for a guided setup.",
            });
            break;
          }
          console.log("");
          console.log("┌─ tradekit ──────────────────────────────────────────────────┐");
          console.log("│  Welcome! No wallet is configured yet.                      │");
          console.log("│  Run `tradekit init` for a guided setup.                    │");
          console.log("│  Run `tradekit help` to see every command.                  │");
          console.log("└─────────────────────────────────────────────────────────────┘");
          console.log("");
          break;
        }
        // Iter860: `tradekit` alone (no positional command) with a configured
        // wallet now shows a short status overview instead of the full 230-
        // line help. The full help is one keystroke away (`tradekit help`)
        // and most operators typing the bare command want a "where am I"
        // status check — not a reference manual. Explicit `tradekit help` /
        // `--help` / `-h` still print the full reference for operators
        // looking up specific commands.
        if (command === undefined) {
          const { loadConfig } = await import("./config.js");
          const cfg = loadConfig();
          const addr = activeWalletAddress();
          const label = activeWalletLabel();
          const version = (await import("./version.js")).tradekitVersion();
          // Iter862: --json mode emits a structured status object instead of
          // the iter860 text overview. Useful for scripts that want to read
          // wallet/chain/version without parsing prose. Mirrors the
          // `tradekit version --json` shape (version + node) plus the iter860
          // wallet/chain fields.
          if (flags["json"] === "true") {
            // Iter891: needsInit:false for symmetry with the iter863 no-wallet
            // path which emits needsInit:true. Universally-present field
            // means scripts can `body.needsInit` without a defined-check.
            // Iter924: include account label (HD identifier; "keystore" for
            // single-key). Scripts identifying which account is active via
            // body.account work regardless of wallet type.
            printJson({
              ok: true,
              version,
              node: process.versions.node,
              platform: process.platform,
              arch: process.arch,
              wallet: addr ?? null,
              account: label,
              activeChain: cfg.activeChain,
              needsInit: false,
            });
            break;
          }
          console.log(`tradekit ${version}`);
          console.log("");
          // Iter924: show account label alongside address so HD operators
          // (multi-account) see which account is active without running
          // `tradekit account list`. "keystore" for single-key wallets.
          console.log(`  wallet:        ${addr ?? "(none)"}${addr ? `  (${label})` : ""}`);
          console.log(`  active chain:  ${cfg.activeChain}`);
          console.log("");
          console.log("  Common commands:");
          console.log("    tradekit health         Operator dashboard");
          console.log("    tradekit holdings       Current token balances");
          console.log("    tradekit doctor         System health check");
          console.log("    tradekit help           Full command reference");
          console.log("");
          break;
        }
        printUsage();
        break;

      default: {
        // "Did you mean…" hint via Levenshtein. Typos are common (`walelt`, `quto`,
        // `holdngs`) and the full usage dump is long — surface the closest match
        // first so the operator sees the likely fix without scrolling.
        const known = [
          "wallet", "account", "address", "config", "chains", "chain", "quote", "trade", "trades",
          "holdings", "portfolio", "positions", "risk", "trending", "pnl", "audit", "price", "price-check",
          "doctor", "verify", "reconcile", "pending", "health", "init",
          "logs", "gas", "allowances", "approve", "revoke", "transfer", "sweep", "token", "viewTx",
          "aggregator", "pairs", "slippage", "strategies", "strategy", "backup", "tx", "order", "notify", "schedule", "engine", "rebalance", "backtest", "playbook", "safety", "paper", "timeline", "bulk", "db", "status", "digest", "metrics", "runway", "panic", "equity", "signal", "export", "note", "incident", "execution", "intents",
          "mcp", "web", "version", "help",
        ];
        const guess = closestCommand(command ?? "", known);
        if (guess) console.error(`\nUnknown command: ${command}. Did you mean '${guess}'?`);
        else console.error(`\nUnknown command: ${command}`);
        console.error("Run `tradekit help` to see all commands.");
        process.exit(1);
      }
    }
    // Success audit
    if (auditPass) {
      try {
        const { insertAudit } = await import("./db.js");
        insertAudit({
          timestamp: auditStart,
          caller: "cli",
          tool: auditTool,
          account: auditAccount,
          chain: auditChain,
          params_json: auditParams,
          simulation_json: null,
          result: "ok",
          error_code: null,
          error_message: null,
          tx_hash: null,
        });
      } catch {
        /* audit failure must not block CLI */
      }
    }
  } catch (e) {
    const te = toToolError(e);
    // Failure audit
    if (auditPass) {
      try {
        const { insertAudit } = await import("./db.js");
        insertAudit({
          timestamp: auditStart,
          caller: "cli",
          tool: auditTool,
          account: auditAccount,
          chain: auditChain,
          params_json: auditParams,
          simulation_json: null,
          result: "err",
          error_code: te.code,
          error_message: te.message,
          tx_hash: null,
        });
      } catch {
        /* audit failure must not block CLI */
      }
    }
    // Iter335: emit a JSON error envelope on stderr when --json was requested. Pre-iter335
    // --json only affected the success path; errors fell through to the human-readable
    // "Error [CODE]: message" lines, so a script doing
    //   result=$(tradekit ... --json) && echo "$result" | jq
    // got nothing back on failure beyond exit code 1 — it had to parse free-form stderr
    // to recover the error code and details. Stays on stderr (not stdout) so stdout
    // remains clean for `... --json | jq` even when the same script invocation fails —
    // exit code is still the primary signal.
    // Iter337: reuse ToolError.toJSON() so the shape matches the web server's error
    // response exactly: { ok: false, error: { code, message, details }, next_actions }.
    // Pre-iter337 the CLI envelope was a different shape (flat + camelCase) than the
    // web envelope (nested + snake_case), so a script targeting both surfaces had to
    // branch on shape. Now ToolError owns the single source of truth.
    if (flags["json"] === "true") {
      process.stderr.write(JSON.stringify(te.toJSON()) + "\n");
    } else {
      console.error(`Error [${te.code}]: ${te.message}`);
      if (te.details) console.error(JSON.stringify(te.details, null, 2));
      if (te.nextActions) {
        console.error("Suggested next actions:");
        for (const na of te.nextActions) console.error(`  - ${na.tool}: ${na.reason}`);
      }
    }
    process.exit(1);
  }
}

main();
