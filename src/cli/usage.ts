import { CONFIG_PATH, WALLET_PATH, MNEMONIC_PATH, ACCOUNTS_PATH, DB_PATH } from "../constants.js";
import { tradekitVersion } from "../version.js";

export function printUsage() {
  // Iter400: show tradekit version in the help banner so operators reading help
  // output in a support ticket / screenshot / paste include the version implicitly.
  // Closes the version-visibility arc (iter391/393/395/396/399) at the help surface.
  console.log(`tradekit ${tradekitVersion()}
Usage: tradekit <command> [action] [options]

OVERVIEW
  panic [--reason "..."] [--cancel-orders] [--yes] [--json]
        EMERGENCY STOP: locks the engine (every fire path gates on the lock
        from the next tick) AND pauses every active order / schedule /
        rebalance plan — tagged or not. Reversible by design; --cancel-orders
        is TERMINAL and demands an explicit --yes. CLI-only (no MCP — same
        safety boundary as backup: agents can neither engage nor release it).
  panic release [--resume-all] [--yes] [--json]
        Unlock the engine. Default leaves everything PAUSED for selective
        resume after investigating; --resume-all is the false-alarm lever.
  health [--accounts X,Y | --accounts all] [--chains a,b,c] [--quiet] [--strict] [--summary] [--json] [--watch N]
        --quiet: filter nextActions to severity=critical (for cron tail loops)
        --strict: exit 1 when any critical nextAction or per-section error (iter755 — cron alerting gate)
        --summary: print a single-line digest instead of the multi-section dashboard (iter846 — for Slack/cron alerting subjects)
        Operator dashboard: portfolio + 7d PnL + trade quality + standing approvals + next-action suggestions in one read.
        Per-section partial failure tolerated — one bad RPC drops that section without aborting the rest.

SETUP
  init                                First-run wizard (wallet + chain + safety + observability)
        [--non-interactive] [--wallet-type hd|keystore|skip] [--chain X]
        [--per-tx-limit N] [--max-slippage-bps N] [--allow-infinite-approvals true|false]
        [--observability true|false]
        Step 4 applies the production observability preset in one answer: decision
        journals (order/schedule/rebalance replay + drift history), DB retention
        (audit/events 180d, journals 60d), and the alert watcher with 5 starter
        rules. Never clobbers operator-tuned config; idempotent; re-run anytime.
  doctor [--chains a,b,c | --chains all] [--pass P] [--strict] [--quiet] [--summary] [--json] [--verbose]
        Health check; --pass verifies keystore decrypts; --strict treats warnings as failures (CI-friendly); --quiet hides ok rows (iter752); --summary prints a one-line cron/Slack-friendly digest (iter847).
        Ops-hygiene pack (offline): retention (journal tables growing unbounded vs
        db.retention knobs), paper book (live paper primitives with an EMPTY virtual
        book), alerts (automation running unwatched; CURRENTLY-FIRING alerts go warn —
        --strict in cron pages on them), engine liveness (live primitives but the
        engine never ran / status file stale).
        v38 pack (offline): stale engine lock (>24h, names the panic release
        lever), equity feed (snapshot worker enabled but never/stale-recorded
        → curve flatlining), quiet hours (zero-length window; stuck flush with
        >24h queued), parked retry slots (v32 backoff slot in the past — engine
        not consuming), forgotten panic (everything paused + zero active +
        unlocked).
  verify [all | backup <file> | wallet | config | db] [--pass <pw>] [--quiet] [--summary] [--json]
        Integrity check suite: backup (non-destructive decrypt+parse), wallet (re-derive address), config (orphan token refs, unknown-chain safety entries), db (schema, stale pending, audit size). Exit 1 on any failure.
        --quiet hides ok rows (iter760 — parallel to doctor/health --quiet); --summary prints a one-line cron/Slack-friendly digest (iter847).
  version [--json]                    Print version + Node info (--json for scripts)
  help                                This message

WALLET & ACCOUNTS
  wallet create [--json] | import [--json] | export [--yes] | view [--chain <name>] [--json]
  account create-mnemonic [--json] | import-mnemonic [--json] | list [--chain X] [--no-balances] [--json]
  account add <label> [--index N] [--json] | use <label> [--json]
  address list [--json] | add <name> <0x-addr> [--note "..."] [--force] [--json] | remove <name> [--json]
        Named recipient aliases. Use @name in transfer flows; defends against typos + clipboard-hijack.

CHAIN & CONFIG
  chains [--json]                     List built-in + custom chains (active marked *)
  chain [<name>] [--json]             Show or switch active chain (--json on switch: {previousChain, activeChain, changed, timestamp})
  config show [--show-secrets] | get <path> | path | validate
  config set <path> <value> [--json]  Set a single value (JSON-encoded; --json emits action discriminator).
                                       Iter35: when an engine supervisor is running, automatically sends SIGHUP
                                       after the write so the change takes effect without restart.
  config push <path> <value> [--json] Append to an array field (--json: action: pushed|noop-already-present)
  config drop <path> <value> [--json] Remove an item from an array field (--json: action: dropped|noop-not-found)
        v38 positionCaps: safety.positionCaps = [{pattern, token,
        maxBaseAmount?, maxCostQuote?}] — NET-exposure caps per (strategy,
        token): buys past the cap reject with POSITION_CAP_EXCEEDED; sells
        always pass (they reduce exposure and free room). Same weighted-avg
        model as all P&L surfaces; enforced in real AND paper paths.
  config history [--limit N] [--json]
        v36: every config save records a deduped snapshot (source-tagged:
        which command changed it). The file that controls live safety caps
        finally has change tracking.
  config diff-version <id> [--json]      Current config vs a stored version, dot-path diff
  config rollback <id> [--yes] [--json]
        Restore a stored version. Without --yes: previews the field changes.
        Schema-validated first (old snapshots forward-fill newer fields with
        defaults); recorded as a NEW version — history only grows, the
        mistake stays for forensics. Hot-reloads a running engine (SIGHUP).
  config preflight [--file PATH] [--strict] [--json]
        Iter35: dry-run impact analysis. Without --file, validates the currently-saved config; with --file
        PATH, diffs the file against the saved config and shows what would change (per-key) + which active
        primitives would be impacted (e.g. orders that exceed a new maxSlippageBps). --strict exits 1 when
        any critical-severity warning is present (CI gate before deploying a config change).
  config reload [--json]
        Iter35: trigger a hot-reload on the running engine. Looks up the supervisor pid from the status
        file + sends SIGHUP. No-op when no engine is running. Mirrors nginx-style \`-s reload\` UX.
  token list [<chain>] [--json] | add <chain> <symbol> <addr> [--json] | remove <chain> <symbol> [--json]
  token check <addr> [--chain X] [--probe-usd N] [--strict] [--json]
        Buy+sell round-trip probe — detects honeypots / high-tax tokens BEFORE committing real funds.
        --strict exits 1 on verdict=honeypot|suspicious (iter776 — pipeline gate before trade).
  token info <addr> [--chain X] [--account L] [--json]
        Unified per-token report: balance + USD, standing approvals + risk, recent trades, advisory. One call to investigate exposure on a specific token

TRADING
  quote --direction buy|sell --base <t> --quote <t> --baseAmount|--quoteAmount <n|max>
        [--slippage <bps>] [--account <label>] [--chain X] [--json]
  trade buy | sell                    Send a swap via aggregator
  trade preview buy|sell --base X --quote Y --baseAmount A | --quoteAmount A [--slippage N] [--strict] [--json]
        Read-only pre-trade analysis: price impact, slippage cushion, gas %, balance fraction, safety pre-flight.
        --strict exits 1 when safety pre-flight fails (iter798 — pipeline gate before actual swap).
  trade preflight buy|sell --base X --quote Y --baseAmount A | --quoteAmount A [--slippage N] [--strict] [--json]
                  [--skip-honeypot] [--skip-price-check] [--skip-history]
        Composite pre-trade safety check: preview + token honeypot probe + cross-source price + historical slippage → go/caution/no_go verdict.
        --strict exits 1 when verdict=no_go (iter772 — pipeline gate before actual swap).
        [--base ETH|<addr>] [--quote USDC|<addr>] [--baseAmount|--quoteAmount <n|max>]
        [--slippage <bps>] [--simulate] [--note "..."] [--account <label>] [--chain X]
        [--idempotency-key K]
        v45: --idempotency-key (8–128 chars [A-Za-z0-9_-], e.g. a UUID) fences
        transport-retry double trades: a retry with the same key REPLAYS the
        recorded outcome (marked replayed) instead of re-executing. Same key +
        different request → IDEMPOTENCY_CONFLICT. Key still executing →
        REQUEST_IN_FLIGHT (never assume the original died — the tx may be in
        the mempool; check 'tradekit trades' first). Recorded failures replay
        as failures: fixed-and-retrying is a new request → new key. Keys expire
        via db.retention.idempotencyKeysDays.
  trade release-key <key> [--json]
        v45: unfence an in-flight key after a process died mid-execution AND
        you verified nothing was sent. Terminal keys are never releasable.
  trade import <tx-hash> [--chain X] [--account L]    Backfill external swap into PnL
  transfer <token|ETH> <to> <amount|max> [--chain X] [--simulate] [--note "..."] [--account L] [--burn]
  sweep [--to <label>] [--from <a,b,c>] [--chain X] [--min-usd N] [--exclude tok,tok] [--exclude-unpriced] [--simulate] [--yes] [--json]
        Multi-source balance consolidation — plans + executes transfers from sources to target. Requires --yes (or interactive 'sweep' confirmation)

NOTIFICATIONS (push-delivered alerts)
  notify list [--json]                    Show configured channels + auto-detected format. URLs path-masked
  notify queue [--json]                   v34: notifications suppressed by quiet hours, pending flush
  notify flush [--force] [--json]         v34: deliver the suppressed-summary now (--force: even mid-window)
        Quiet hours: config set notifications.quietHours.enabled true
        Inside [startHourUtc, endHourUtc) (default 22→07 UTC, wraps midnight),
        notifications below breakthroughSeverity (default critical) queue
        instead of delivering — flushed as ONE summary when the window ends
        (auto on the first post-window event, on the engine digest tick, or
        manually). Channels with "ignoreQuietHours": true always deliver —
        set it on the pager channel. Nothing is lost, nobody is woken.
  notify test [--channel NAME] [--event EVT] [--severity info|warn|critical] [--json]
        Dispatch a synthetic event to verify wiring. Returns per-channel ok/skipped/failed report.
        Set up channels via config:
          tradekit config push notifications.channels '{"name":"ops-slack","url":"https://hooks.slack.com/...","events":["order.filled","order.failed","trade.failed","approval.infinite"]}'
        URL host detected automatically — hooks.slack.com → Slack blocks, discord.com/api/webhooks → Discord embed,
        api.telegram.org/bot... → Telegram MarkdownV2, anything else → generic JSON POST. Dedup window
        (default 60s) suppresses identical events so a stuck order doesn't spam the channel.

ENGINE (unified supervisor — production deployment unit)
  engine run [--once] [--workers orders,schedules,reconcile,rebalance,alerts,digest,db_maintenance] [--dry-run]
             [--pass <pw>] [--strict] [--json]
             [--metrics-port N] [--metrics-host 127.0.0.1]
        Single-process daemon that ticks orders + schedules + reconcile + rebalance + alerts on
        independent cadences from one wallet decryption. Replaces the three separate
        'order run / schedule run' daemons + iter32 alerts sidecar with one systemd
        service / container / health check. Holds a process lock so a second invocation immediately
        fails with WALLET_LOCKED + the holder pid. Emits engine.heartbeat every hour (configurable
        via config.engine.heartbeatIntervalMs) and engine.started / engine.stopped at lifetime
        boundaries. --once does a single tick round (cron-friendly). --workers subsets the active
        list. --dry-run evaluates triggers + advances bookkeeping without sending trades.
        --metrics-port spins up a tiny standalone HTTP listener exposing /metrics (Prometheus
        text format) + /healthz; bound to loopback by default (--metrics-host changes the bind).
        Iter33: per-worker exponential backoff on N consecutive failures (default 3 → 2× each
        further failure, capped 10min). Backoff/recovery emits engine.worker.degraded /
        engine.worker.recovered notifications. Tick durations tracked over a sliding window
        (default 20) for p50/p95/max visibility.
  engine status [--json]
        Show worker state from ~/.tradekit/.engine.status.json (written by the supervisor on
        every tick). Per-worker tick counters, last-tick-at, last-error, next-tick-due-at.
        Iter33: also surfaces degraded flag, consecutiveFailures, effectiveIntervalMs (after
        backoff), and tick-time percentiles (avg / p50 / p95 / max) so an operator spots a
        slow-but-still-passing worker before it crosses the failure threshold.
        --json includes derived staleness (seconds since each worker's last tick) so monitoring
        scripts can alert on stalled workers without parsing prose.
  engine lock [--reason "..."] [--yes] [--json]
        Engage the global kill switch. ALL trading paths (orders engine, schedules engine,
        rebalance engine, manual trades, post-fill hooks) reject with ENGINE_LOCKED until
        engine unlock runs. Orders engine continues TICKING (HWM tracking stays fresh) but
        skips the fire path — trailing stops stay correctly positioned for resume.
        Use for incident response or maintenance windows.
  engine unlock [--yes] [--json]
        Release the kill switch. Trading paths resume on next tick (or immediately for
        manual trades). Idempotent.
  engine events [--since 24h|ISO] [--until ISO] [--types engine.started,worker.degraded,...]
                [--severity info|warn|critical] [--worker NAME] [--limit N] [--json]
        Iter39: forensic view of the v26 engine_events table. Durable record of engine
        lifecycle (started/stopped), kill-switch (lock/unlock), worker resilience
        (degraded/recovered), and config reload events. Survives process restart — unlike
        notifications, which are transient. Default window: last 24h.
        Answers "when did my engine restart last week?", "how many times has the orders
        worker degraded this month?", "who reloaded config 3 days ago and what changed?".

METRICS (Prometheus-style observability)
  metrics [--json]
        One-shot snapshot of operational metrics on stdout. Default format is Prometheus text
        exposition (text/plain; version=0.0.4); --json gives the structured shape. Cron-friendly
        for node_exporter textfile-collector integration:
            * * * * * tradekit metrics > /var/lib/node_exporter/textfile_collector/tradekit.prom
        Live scraping endpoints are exposed by:
            - the web server's /metrics route (when 'tradekit web' is running)
            - the engine's --metrics-port listener (single-process deployments)
        Metrics include: trades/orders/schedules/rebalance-plans counts by status, audit row
        + error breakdown, engine running state + uptime, per-worker tick counts + failure
        counts + last-tick staleness. Labels are bounded enums (no wallet addresses, no USD
        values, no strategy tags) — safe to expose to a private network without leaking ops detail.

PORTFOLIO REBALANCING
  rebalance create --account L --chain X
                   --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]'
                   [--cron "0 */6 * * *"] [--drift-threshold 5] [--min-trade-usd 10]
                   [--quote-token USDC] [--slippage <bps>] [--auto-slippage]
                   [--start-at <ISO>] [--end-at <ISO>] [--max-runs N]
                   [--name X] [--strategy TAG] [--note "..."] [--paper true|false] [--json]
        Declarative target-weight plan. On each engine tick the plan evaluates the live
        portfolio, computes per-target drift, and (if max drift >= threshold) fires the
        corrective trades through executeTrade. Trades route through the quote anchor
        (defaults to chain USDC). Each plan is scoped to ONE chain + ONE account.
        Targets must sum to exactly 100%. Sub-min-trade-usd legs skip to avoid gas
        burn on tiny corrections.
        --paper true: drift is evaluated against the VIRTUAL book (paper balances), and
        corrective legs fill the virtual book — no chain reads, no keystore, no real
        trades. Seed with 'paper deposit' first or every tick is an empty-portfolio skip.
  rebalance list [--status all|active|paused|completed|cancelled] [--chain X] [--account L]
                 [--strategy TAG] [--limit N] [--json]
  rebalance show <id> [--json]                 Full detail incl. last-run telemetry
  rebalance edit <id> [--targets '[{"token":"ETH","targetPct":70},...]'] [--drift-threshold N]
                 [--min-trade-usd N] [--cron "..."|--every 6h] [--end-at <ISO>|null]
                 [--max-runs N|null] [--slippage <bps>] [--auto-slippage true|false]
                 [--strategy TAG] [--note "..."] [--name X] [--paper true|false] [--json]
        In-place edit — run_count / max_runs accounting + last-run telemetry are
        PRESERVED (vs cancel+create, which resets them). Targets re-weighting uses
        the same validation as create (sum exactly 100). Frozen: chain, account,
        quote token (routing anchor), start-at. Cron/every change recomputes
        next_run_at from now. maxRuns cannot drop below the current run_count.
  rebalance replay <id> [--limit N] [--json]
        v29: forensic decision timeline — every evaluated occurrence incl. IN-BAND
        ones with max drift (watch drift creep toward the threshold), plus fired /
        partial_failure / failed / dry_run / locked-skip with leg counts. Requires
        engine.rebalanceJournal.enabled=true. Prunable: db.retention.rebalanceCheckLogDays.
  rebalance pause <id> [--json]                Pause (engine ignores until resumed)
  rebalance resume <id> [--json]               Resume (next_run_at recomputed)
  rebalance cancel <id> [--yes] [--json]       Cancel (terminal — use pause for temporary)
  rebalance run [--once] [--chain X] [--account L] [--dry-run] [--pass <pw>]
                [--strict] [--json] [--watch N]
        Run the rebalance engine. Without --once, defaults to --watch 300 (5min).

SCHEDULED / RECURRING TRADES (DCA)
  schedule create --side buy|sell (--cron "<5-field>" | --every 1h|6h|1d|7d)
                  --base ETH|<addr> --quote USDC|<addr>
                  (--baseAmount A | --quoteAmount A)
                  [--slippage <bps>] [--auto-slippage]
                  [--name NAME] [--start-at <ISO>] [--end-at <ISO>] [--max-runs N]
                  [--strategy TAG] [--note "..."] [--chain X] [--account L] [--json]
                  [--on-fill '<json>' | --on-fill-file <path>]
        --on-fill / --on-fill-file: post-fill hook spec. Validated at create time.
        After each successful fire, auto-creates follow-up order(s) with template variables
        interpolating fill data: {{filled.baseAmount}}, {{filled.fillPriceUsd}},
        {{filled.txHash}}, {{filled.fireNumber}}. Example for DCA + auto-trailing-stop:
        --on-fill '{"type":"createOrder","spec":{"side":"sell","trigger":"trailing",
        "trailPct":10,"baseAmount":"{{filled.baseAmount}}","base":"ETH","quote":"USDC"}}'
        Multi-leg brackets: {"type":"createOrders","specs":[{...TP...},{...SL...}]} creates
        2–4 orders per fire, all-or-nothing; legs without an explicit "group" are auto-
        OCO-paired per fire (TP fires → SL cancels, and vice versa). Hook orders inherit
        the schedule's paper flag.
        Standing intent that fires the same trade on a cron schedule. Each fire routes
        through executeTrade — so per-tx / daily USD limits, slippage cap, gas budget,
        token & contract whitelists, rate limit, and audit log all apply just like a
        manual trade. Common DCA setup: '--side buy --every 7d --quoteAmount 100' buys
        $100 of base every 7 days; '--cron "0 10 * * 1"' runs Monday 10:00 UTC; '--max-runs 12'
        caps lifetime fires (a year of weekly DCA). Macros: @hourly @daily @weekly @monthly.
  schedule list [--status all|active|paused|completed|cancelled] [--chain X] [--account L]
                [--strategy TAG] [--limit N] [--json]
  schedule show <id> [--json]                Full detail incl. run telemetry + totals
  schedule pause <id> [--json]               Pause (engine ignores until resumed)
  schedule resume <id> [--json]              Resume (next_run_at recomputed from now)
  schedule cancel <id> [--yes] [--json]      Cancel (terminal — use pause for temporary)
  schedule edit <id> [--cron "<5-field>" | --every 1h|1d] [--base-amount A | --quote-amount A]
                     [--slippage-bps N] [--auto-slippage true|false] [--end-at ISO]
                     [--max-runs N] [--note "..."] [--strategy TAG] [--paper true|false]
                     [--on-fill '<json>' | --on-fill-file PATH]
                     [--unset end-at,max-runs,note,strategy,slippage-bps,on-fill] [--json]
        Iter34: in-place edit of an active or paused schedule. Cron change recomputes
        next_run_at; run_count + total_base_filled / total_quote_spent are preserved
        across the edit. max_runs cannot be lowered below the current run_count
        (set equal to retire after the next fire). Terminal (completed/cancelled)
        schedules are not editable — cancel + create a new one instead.
  schedule run [--once] [--chain X] [--account L] [--dry-run] [--pass <pw>]
               [--strict] [--json] [--watch N]
        Run the schedule engine. Without --once, defaults to --watch 30 (daemon mode).
        Each tick scans active schedules with next_run_at <= now, fires due ones via
        executeTrade, advances next_run_at. --dry-run advances time but never sends tx.
        v32 transient retry: a TRANSIENT fire failure (RPC flake, rate limit,
        aggregator hiccup) parks the row on an exponential-backoff retry slot
        (engine.fireRetry — default 5m/10m/20m, 3 attempts) instead of losing the
        occurrence to the next cron slot. The retry never crosses the next natural
        occurrence or end_at; budget exhaustion escalates to a critical
        "occurrence LOST" notification. Terminal failures (safeguard, balance)
        never retry. Same mechanism guards rebalance evaluations. Disable with
        \`config set engine.fireRetry.enabled false\`.
        v33 crash-window guard: before every fire the engine checks for a trade
        already attributable to THIS occurrence (engine crash between tx-send and
        bookkeeping, or a timed-out tx that confirmed during a retry backoff). If
        found, the occurrence is BOOKED from the evidence trade — never refired,
        never double-bought. Emits schedule.recovered; journals "recovered".
  schedule replay <id> [--limit N] [--json]
        v29: forensic decision timeline — every fired / fire_failed / retired /
        locked-skip / on_fill hook outcome with timestamps, run numbers, tx hashes.
        Requires engine.scheduleJournal.enabled=true (default off). Answers "why
        didn't my DCA fire this morning?". Prunable: db.retention.scheduleCheckLogDays.

TRADE APPROVAL (v47 — human-in-the-loop for agent trades)
  intents list [--status pending|executed|failed|rejected|expired] [--limit N] [--json]
        Agent-proposed trades awaiting (or past) your decision. Created when
        safety.tradeApproval gates an MCP buy/sell: enabled=true +
        thresholdUsd (null = every agent trade). The agent gets a
        pending_approval result (NOT an error) and polls intents_list;
        a notification pages you with the intent id.
  intents show <id> [--json]
        Full review context: the resolved request, the simulate PREVIEW the
        agent's trade was priced against (full safety stack ran), the agent's
        stated reason, expiry, and (after decision) the outcome.
  intents approve <id> [--max-deviation-bps N] [--force] [--note "..."] [--json]
        Re-executes the recorded request behind YOUR wallet password. The
        preview's received-amount is replayed as expectedAmountOut (default
        100bps tolerance) so an hour-old quote can't silently execute into a
        moved market — QUOTE_DEVIATION_EXCEEDED names the live numbers;
        --force skips the check. Outcome (executed/failed) is recorded on
        the intent. Approve/reject is CLI-ONLY by design — same security
        boundary as backup/panic: a prompt-injected agent must never approve
        its own spending.
  intents reject <id> [--note "..."] [--json]
        Terminal. Pending intents auto-expire after
        safety.tradeApproval.expiresMinutes (default 60) — a stale quote
        should never execute days later.
        Visibility (v47.5): pending intents surface in the digest (verdict →
        attention), 'tradekit doctor' (intents check), the timeline
        (intent.created / intent.decided — expiry shows as EXPIRED
        un-reviewed), and the web Overview banner (GET /api/intents).

EXECUTION QUALITY (v44)
  execution [--since 30d|12h|ISO] [--chain X] [--account L] [--json]
        Execution analytics over REAL fills: signed realized slippage
        (positive = unfavorable vs quote) cut by aggregator / pair /
        order-size bucket, per-chain gas in native units, a trailing-7d
        vs prior trend, and threshold-gated recommendations (prefer the
        better aggregator or aggregator.mode "best"; split orders when
        slippage grows with size; degradation warning; low-coverage
        pointer at 'tradekit reconcile'). Paper fills excluded —
        simulated slippage isn't execution quality. Deterministic +
        offline (one DB scan, no oracle; gas stays native on purpose).
        MCP: execution_report.

INCIDENT (v39 — the one-command postmortem)
  incident [--window 4h|24h|7d] [--strategy TAG] [--out FILE] [--json]
        Compose the window's digest verdict, activity counts, CONFIG CHANGES
        ("what changed before it broke"), operator/agent notes, and the
        critical/warn event tail into one markdown postmortem — reviewer
        order: verdict → activity → config → notes → events. Pure
        composition over the existing gatherers, so it can never disagree
        with the surfaces it summarizes. Untagged notes survive --strategy
        (global context). MCP: incident_report (read it FIRST when
        investigating; it tells you where to drill).

NOTES (v37 — the timeline's human layer)
  note add "what you did and why" [--strategy TAG] [--at ISO] [--json]
        Record context into the forensic timeline (kind note.operator):
        "moved the stop because CPI tomorrow", "rotated RPC, base flaky".
        Untagged notes are global; --strategy scopes to one tag's view.
        Shows in \`tradekit timeline\` next to the machine events — "what
        did I do around the time things broke" becomes one view. Agents
        leave handoff reasoning via MCP note_add.
  note list [--strategy TAG] [--limit N] [--json]
  note rm <id> [--json]      No auto-retention — deletion is explicit.

EXPORT (v36 — realized gains, tax season)
  export gains [--year N | --since ISO --until ISO] [--mode real|paper]
               [--account L] [--chain X] [--strategy TAG]
               [--out FILE | --json]
        Per-sell cost-basis realizations as CSV (stdout, pipeable; summary +
        disclaimers go to stderr): date, amount sold, proceeds, cost basis,
        gain, avg cost, tx hash. Same weighted-average engine every P&L
        surface shares — deterministic, pure fill-journal walk, no oracle.
        The basis walk always sees FULL history; --year/--since filter the
        OUTPUT rows only (a 2025 buy correctly funds a 2026 sell's basis).
        Caveats on every export: weighted-average (not FIFO/specific-lot),
        stablecoin-quote fills only, gas excluded, untracked sells reported
        separately. Not tax advice. MCP: gains_report (JSON).

SIGNALS (v35 — event-driven orders)
  signal fire <name> [--payload '<json>'] [--json]
        Drop a signal event in the inbox — the manual/test twin of the
        TradingView webhook. The next engine tick fires EVERY active order
        armed on this name that was created BEFORE the event arrived
        (late-armed orders never fire on stale signals). At-most-once per
        listener; unclaimed events expire after 1h.
  signal list [--name X] [--limit N] [--json]
        Event inbox with consumption state (PENDING / consumed by order #N /
        expired unclaimed) — "did my TradingView alert arrive?"
        Webhook ingestion: POST /api/signal/<name>?key=<secret> on the web
        server (config set webhooks.signalSecret <16+ chars> to enable; a
        SEPARATE secret from the dashboard token — webhook URLs leak).
        A forged signal can only fire orders YOU pre-armed with your own
        amounts + safety rails.

CONDITIONAL ORDERS
  order create --side buy|sell --trigger price_below|price_above|trailing|signal
               (price triggers: --price <USD>) (trailing: --trail-pct <N> [--price <activation>])
               (signal: --signal-name <name> — fires when the named external
               signal arrives; no price, no polling; expiry/OCO/hooks normal)
               --base ETH|<addr> --quote USDC|<addr>
               (--baseAmount A|max|N% | --quoteAmount A|max|N%) [--slippage <bps>] [--auto-slippage]
               v35 dynamic sizing: "max" resolves to the LIVE balance at fire
               time (sell → whole base position; buy → whole quote balance);
               "N%" (0 < N ≤ 100) to that fraction of it — scale-out brackets
               like [50% at target, max trailing] size each leg against the
               position AS IT IS when that leg fires. ONE trailing stop with
               --baseAmount max protects the entire growing position. Spend
               side only; works for real (on-chain), paper (virtual book),
               and backtests (sim balance); manual trades accept both too.
               [--expires-in 30s|15m|2h|7d|4w | --expires-at <ISO>]
               [--start-in 30m|2h|1d | --start-at <ISO>]  ← v38: activation
               boundary — the engine ignores the order until then: no trigger
               eval, no trailing watermark (pre-announcement chop can't set
               the HWM), signals received before it never fire the order.
               Expiry still applies during pre-start (validity ≠ activity).
               [--on-fill '<json>' | --on-fill-file <path>]  ← v31: chain follow-up
               order(s) after THIS order fills (same {{filled.X}} dialect as schedule
               hooks; e.g. limit buy → auto-trailing the position, or limit buy →
               TP+SL bracket via {"type":"createOrders","specs":[...]} with auto-OCO
               pairing). --unset on-fill via 'order edit' removes it.
               [--group <id>] [--strategy TAG] [--note "..."] [--chain X] [--account L] [--json]
        Standing intent that fires when the configured trigger satisfies. At fire time the
        engine routes through executeTrade — so every safety guardrail (USD limits, slippage
        cap, gas budget, token blacklists, position limits) applies verbatim. Common patterns:
          limit-buy:    --side buy  --trigger price_below   (buy the dip; --price = threshold)
          limit-sell:   --side sell --trigger price_above   (sell into strength)
          stop-loss:    --side sell --trigger price_below   (cut losses)
          take-profit:  --side sell --trigger price_above   (lock in gains)
          trailing stop: --side sell --trigger trailing --trail-pct 5 [--price 3500]
                        (tracks the high-water mark; fires when price retraces 5%. Optional
                         --price = activation gate: don't start trailing until the price first
                         crosses it. Symmetric for buys: tracks the low and fires on rebound.)
          OCO bracket:  create two (or more) orders with the same --group X. When ANY fires
                        (filled/failed/expired), the engine auto-cancels the rest with reason
                        OCO_PEER_FIRED. Pattern: 'sell at $4000 OR stop at $2700'.
  order list [--status all|active|filled|cancelled|expired|failed] [--chain X] [--account L]
             [--strategy TAG] [--group <id>] [--limit N] [--json]
        List orders. Status defaults to 'active'. JSON output carries pre-aggregated counts.
        --group filters to one OCO group (useful to inspect peer state).
  order show <id> [--json]                                Full detail incl. fill / error trail + OCO peer state when group_id set
  order cancel <id> [--yes] [--cascade] [--json]          Cancel an active order. --cascade also cancels the rest of the OCO group with reason OCO_OPERATOR_CASCADE
  order pause <id> [--json]                               Pause: the engine stops evaluating the trigger until resumed.
        Non-destructive (vs cancel). While paused: expires_at STILL retires the
        order, and an OCO peer fire STILL cancels it (a paused bracket arm must
        die with its sibling). Trailing HWM is preserved across the pause.
  order resume <id> [--json]                              Resume a paused order (re-evaluated from the next tick)
  order edit <id> [--target-price N] [--trail-pct N]
                  [--base-amount A | --quote-amount A] [--slippage-bps N]
                  [--auto-slippage true|false] [--expires-in 7d | --expires-at ISO]
                  [--note "..."] [--strategy TAG] [--paper true|false]
                  [--unset target-price,trail-pct,expires-at,note,strategy,slippage-bps] [--json]
        Iter34: in-place edit of an active order. State-preserving: trailing HWM,
        attempt counter, and order_check_log journal continuity are all kept.
        Trigger type / side / chain / account / base+quote token / OCO group are
        FROZEN (changing them means a different order — cancel + create instead).
        Each successful edit appends an order_check_log entry with
        decision="edited_by_operator" so 'order replay <id>' shows the edit
        inline with the trigger evaluations. Terminal orders are rejected; the
        edit aborts if the order moves to filled/failed/expired/cancelled
        between fetch and update.
  order run [--once] [--chain X] [--account L] [--dry-run] [--pass <pw>]
            [--strict] [--json] [--watch N]
        Run the order engine. Without --once, defaults to --watch 30 (a long-running daemon).
        Each tick: price every active order's base token, fire triggers via executeTrade,
        stamp last_checked + error trail. --dry-run evaluates triggers without sending tx.
        --strict exits 1 on any failed/transient outcome (cron alert gate). --json --watch N
        emits compact JSONL (jq -c / Vector / Fluent Bit).
  order replay <id> [--limit N] [--json]
        Forensic decision timeline for an order — every state-changing engine tick
        (activation, HWM advances, proximity crossings, fires, errors). Requires
        engine.orderJournal.enabled=true (opt-in, default off). Answers "why did this
        trail fire HERE and not earlier?" without log archaeology.

STRATEGY OBSERVABILITY (iter31 — unified report; iter32 — alerts)
  strategy report <id|tag> [--window 1d|7d|30d|90d|all] [--mode real|paper|auto]
                           [--sections id,comp,perf,pos,risk,act,fwd,mtm] [--no-prices]
                           [--mtm] [--alerts] [--json]
        Comprehensive multi-section report for any strategy tag. A bare number resolves to
        playbook:N; free-form tags (\`dca-eth\`) are taken verbatim. Seven sections:
          identity     — playbook name + deployment + age + mode (real/paper)
          composition  — every owned order/schedule/rebalance + lifecycle counts
          performance  — fills, success rate, realized P&L, slippage p50/p95/max (window)
          position     — net (chain, token) accumulation across all fills
          risk         — strategy-budget consumption + per-strategy drawdown
          activity     — recent fills + failures + order journal entries
          forward      — next schedule fire + per-order distance-to-trigger +
                         per-plan rebalance drift proximity (persisted, no oracle)
        --mtm adds an eighth, opt-in VALUATION section: cost-basis positions (same
        weighted-average core as \`paper pnl --mtm\` — numbers match across surfaces)
        marked at live oracle prices, realized/unrealized/total + per-position detail.
        Works in BOTH modes (real mode walks status=success trades; gas excluded —
        \`tradekit pnl\` owns full portfolio accounting).
        --sections lets agents request a fast subset (e.g. \`identity,forward\` for
        a near-real-time tick check). Default window 30d. --no-prices skips the
        forward-section price lookup when the operator wants a network-free snapshot.
        --alerts appends active strategy_alert_state rows (iter32 watcher output).
  strategy list [--chain X] [--account L] [--json]
        Alias for \`strategies list\` — surfaces every distinct strategy tag in the
        trades table with fill counts and last-seen timestamps.
  equity [--accounts-key X] [--chains-key Y] [--since 30d|ISO] [--json]
        v37: the equity curve — total portfolio USD over time, from
        portfolio_snapshots (pure DB read; sparkline + change/peak/max-drawdown).
        Data feed: enable the engine snapshot worker (records one auto-snapshot
        per engine.snapshotEveryHours, default daily):
          tradekit config set engine.workers.snapshot.enabled true
        (the init --observability preset enables it). Manual \`tradekit snapshot\`
        rows contribute too. Scope-disciplined: one accounts×chains scope per
        curve (mixing scopes would jump on coverage, not value); defaults to
        the most-snapshotted scope.
        v46: output includes a risk line — max drawdown (% + USD, peak→trough),
        annualized vol + sharpe — computed by the SAME math as the backtest
        risk block (metricsFromCurve), so live and simulated risk compare 1:1.
  runway [--chain X] [--account L] [--strategy TAG] [--days N] [--json]
        Funding-runway forecast: will my automation run out of money, and WHEN?
        Walks every active schedule's upcoming cron fires (respecting end-at +
        remaining max-runs budget) + reserves active orders' one-shot spends,
        replayed against current balances (paper book for paper primitives,
        on-chain read for real). Price-free spend accounting: buys burn quote,
        sells burn base; opposite-denomination sizing is listed as skipped.
        "USDC covers 3 more DCA fires; runs out Thursday" — BEFORE the first
        fire_failed. v34.5: a gas section estimates native-gas burn for REAL
        fires from recent trade history (avg gas_cost_native × upcoming
        occurrences vs native balance) — the most common beginner failure
        (full of USDC, dry of ETH) becomes a forecast too. Pair with the
        funding_runway alert rule for push — token and gas buckets both
        count, shortest fuse decides (or action:"pause" to stop firing
        into guaranteed failures).
  strategy pause <tag> [--json]
        Bulk-pause EVERY active primitive (orders / schedules / rebalance plans)
        owned by the strategy tag in one command. Non-destructive — nothing is
        cancelled; run counters / trailing HWMs / OCO groups all survive. This is
        the manual twin of the alert circuit breaker (rule action: "pause").
  strategy resume <tag> [--json]
        Bulk-resume every paused primitive owned by the tag. Schedules + rebalance
        plans recompute next_run_at from now (skip missed windows, don't backfill).
        Blanket by tag — also resumes primitives paused individually by hand.
  strategy alerts list [--tag X] [--active-only] [--json]
        List every (tag, ruleType) alert state row recorded by the watcher.
        --active-only filters to currently-firing alerts; useful in cron checks.
  strategy alerts show-rules [--json]
        Print the configured rules + which active strategy tags each one matches.
        Validates a fresh config change before running the watcher.
  strategy alerts run [--once | --watch N] [--tag X] [--dry-run] [--json]
        Run the watcher: enumerate strategies, evaluate every applicable rule,
        emit notifications on OK↔active transitions. --once is the default;
        --watch N runs forever at N-second cadence (N ≥ 5).
        v37 --dry-run: the threshold-tuning loop — evaluate + print per-rule
        verdicts (✓ ok / ✗ would fire / · inapplicable) with ZERO side
        effects: no notifications, no state writes, no journal, no circuit
        breaker. The next real run still sees the fresh ok→active edge.
        CIRCUIT BREAKER: a rule with "action": "pause" doesn't just notify on
        fire — it bulk-pauses every primitive the strategy owns (same machinery
        as 'strategy pause') and emits a critical *.circuit_breaker notification
        with the paused ids. Fire-transition only: a still-violated rule never
        re-pauses, so a deliberate 'strategy resume' sticks until the rule
        resolves and fires fresh. Breaker failures escalate via
        *.circuit_breaker_failed (the strategy is still running!).
  strategy alerts reset [--tag X] [--rule TYPE] [--yes] [--json]
        Clear alert state rows. Re-arms the rule so the next violation will
        emit a fresh fire notification. Interactive confirmation unless --yes.
  strategy alerts history [--tag X] [--rule TYPE] [--event fired|resolved]
                          [--since ISO] [--until ISO] [--limit N] [--json]
        Page the durable alert_events journal (v28): every fired/resolved
        transition with exact timestamps, the violated value, and (for
        resolves) the alerting duration. Unlike 'list' (current state) this
        is the FULL history — repeated fire/resolve cycles all appear.
        Prunable via db.retention.alertEventsDays.
  Configuration (in config.json under safety.strategyAlerts):
    enabled: true
    rules:  [{type: "staleness", thresholdSeconds: 172800},
             {type: "drift_proximity", alertPctOfThreshold: 80},  // rebalance about to trade
             {type: "slippage_trend", baselineBps: 50, alertMultiplier: 1.5},
             {type: "success_rate_drop", minRate: 0.8, minSampleSize: 10},
             {type: "failure_streak", alertCount: 3},
             {type: "budget_approach", warnPct: 0.8},
             {type: "drawdown_threshold", alertPct: 10},
             {type: "trigger_proximity", alertDistancePct: 2}]
    Each rule supports optional \`appliesTo: ["playbook:*", "dca-eth"]\` filter
    and \`note: "..."\` rationale included in notification body.

DB LIFECYCLE (iter40 — integrity check + retention + auto-backup)
  db stats [--json]
        Per-table row counts, file size (main + WAL + SHM), and what the retention policy
        WOULD prune given current config. The first stop for "how big is my DB and what's
        accumulating?".
  db integrity-check [--json]
        Wraps PRAGMA integrity_check. Exit 1 on corruption (cron-friendly health gate).
  db prune [--dry-run] [--json]
        Apply the per-table retention policy. --dry-run reports cutoffs without DELETEing.
        Requires db.retention.enabled=true + per-table {auditLogDays, paperTradesDays,
        orderCheckLogDays, engineEventsDays, failedTradesDays} configured (default NULL =
        never prune that table). Successful trades are NEVER auto-pruned (tax records).
  db backup [--dest PATH] [--json]
        Atomic SQLite snapshot via VACUUM INTO. Default destination is a timestamped file
        in the data dir. --dest accepts absolute or DATA_DIR-relative paths.
  db rotate [--retain N] [--json]
        Apply rotation to the configured backup dir — keep most recent N (default from
        db.backup.retainCount).
  Background worker:
    Engine-pushed daily digest: notifications.digest {"enabled":true,"hourUtc":9,
    "window":"24h","minVerdict":"healthy|attention|critical"} — the digest worker
    sends the slack-format digest through the notify channels once per UTC day
    (no external cron). minVerdict=attention = only when something needs attention.
    Set engine.workers.db_maintenance.enabled=true to run integrity check + retention +
    auto-backup on internally-tracked cadences (db.integrityCheck.intervalHours,
    db.backup.intervalHours). Read-only (no password). Subtask success/failure surfaces in
    'engine events' via iter39.

BULK OPERATIONS (iter37 — scoped halt/resume with preview)
  bulk halt   [--strategy X] [--chain Y] [--account Z]
              [--types orders,schedules,rebalances]
              [--all] [--dry-run] [--yes] [--json]
        Cancel all matching orders + pause matching schedules + pause matching rebalances —
        atomically, in one DB transaction, with ONE bulk-level notification.
        At least one filter scope is required (--strategy / --chain / --account / --all).
        Without --yes: prints the plan + prompts 'type halt to confirm'.
        --dry-run: prints the plan, never mutates.
        --json: emits structured plan + result; skips confirmation (machine-driven).
        The middle ground between iter28 engine_lock (global kill) and per-primitive cancel/pause.
  bulk resume [--strategy X] [--chain Y] [--account Z]
              [--types schedules,rebalances]
              [--all] [--dry-run] [--yes] [--json]
        Re-enable paused schedules + rebalances. Cancelled orders are terminal — recreate via
        'order create' or 'playbook replace' instead (the --types list refuses 'orders').

FORENSIC TIMELINE (iter36 — cross-strategy chronological event view)
  timeline [--since 4h|1d|2026-01-01T00:00:00Z] [--until ISO]
           [--chain X] [--account L] [--strategy TAG]
           [--kinds trade.fill,trade.failure,paper.fill,order.edited,audit.tool,audit.error,alert.fired,alert.resolved,order.journal,schedule.journal,rebalance.journal,trade.pending]
           [--severity info|warn|critical]
           [--no-paper] [--limit N] [--json]
        Merges events from trades + paper_trades + audit_log + order_check_log + strategy_alert_state
        into one chronological stream (newest-first). Answers "what happened in this window?" in
        one command — pre-iter36 the same investigation required 6+ separate commands + manual
        timestamp merging. Default window: last 4h. Default limit: 100.
        Severity floor: critical = current state violation; warn = elevated tool action; info = routine.
        --kinds filters to specific event types; --severity drops everything below the floor.
        --no-paper hides paper.fill events for a "real-trades only" forensic view.
        --json emits the typed TimelineEvent[] for downstream piping (jq / Vector / Fluent Bit).
        Composes with iter31 strategy report ("what is X doing?") and iter32 alerts ("notify me when X").

PAPER TRADING (virtual book, no on-chain submission)
  paper deposit --token SYMBOL|ADDR --amount <N> [--chain X] [--account L] [--set] [--yes] [--json]
        Seed the virtual book with a starting balance. Default mode credits the existing
        balance; --set OVERWRITES to an exact amount (used after a reset). Required before
        firing paper buys — every paper trade enforces the virtual balance, so the operator
        must explicitly fund the book.
  paper trades [--account L] [--chain X] [--strategy TAG] [--source order|schedule|rebalance|manual]
               [--since ISO] [--until ISO] [--limit N] [--json]
        Chronological journal of paper fills. Same filters as 'trades' so a strategy can
        be evaluated identically in paper + real.
  paper balances [--account L] [--chain X] [--json]
        Virtual balances per (account, chain, token). Empty until 'paper deposit' has run.
  paper pnl [--account L] [--chain X] [--strategy TAG] [--mtm] [--json]
        Realized P&L per strategy (quote-denominated). Default output is deterministic
        (pure function of the fill journal). --mtm adds mark-to-market: cost-basis
        positions (weighted-average, same model as the real-trade pnl report) marked
        at current oracle prices — realized + unrealized + total + per-position detail.
        Deposits are capital, not P&L: base sold without a tracked paper-buy realizes
        nothing and is reported separately (untracked figures).
  paper reset [--account L] [--chain X] [--yes] [--json]
        WIPE paper state. Without --account/--chain, wipes EVERY account on every chain.
        Interactive confirmation required unless --yes.
  Per-primitive paper mode:
    order create   ... --paper      ← engine fires this order against the virtual book
    schedule create ... --paper     ← engine fires this schedule against the virtual book
    playbook deploy <file> --paper  ← cascades --paper across every order/schedule in the spec

STATEFUL SAFETY
  safety drawdown [--scope global] [--json]
        Show portfolio drawdown circuit-breaker state. Peak USD, last observed value, drawdown %,
        and tripped status per scope. Reveals whether the breaker would block trading right now.
  safety reset-drawdown [--scope global] [--peak USD] [--yes] [--json]
        Clear tripped state + optionally re-anchor peak to a specific value. Without --peak, the
        peak re-anchors to last observed value (prevents immediate re-tripping). Interactive
        confirmation required for a tripped scope unless --yes.

PLAYBOOKS (declarative strategy bundles)
  playbook validate <file> [--var NAME=VALUE ...] [--vars-file FILE] [--json]
        Parse + structurally validate a playbook JSON spec without touching the DB. Renders
        any {{...}} template substitutions first; vars from --var override --vars-file. Useful in CI.
  playbook deploy <file> [--var NAME=VALUE ...] [--vars-file FILE] [--json]
        Atomically create every primitive in the spec (orders / schedules / rebalance plans).
        Mid-deploy failure rolls back the whole bundle. Idempotent on the spec hash —
        redeploying the same file is a no-op; redeploying with a different hash + same name
        is an error pointing at 'playbook destroy' first.
        Each primitive gets stamped strategy=playbook:N so the bundle is queryable across
        order/schedule/rebalance list --strategy playbook:N.
        OCO group names are namespaced to pb<id>-<localname> so two playbooks with the
        same local group don't cross-cancel.
        v37: order entries accept trigger "signal" + "signalName" — a playbook
        can bundle a signal-armed entry with its brackets/schedules. signalName
        is NOT pb-namespaced (the external alert name is global; several
        playbooks listening to one signal is a feature). Signal entries are
        replayed by playbook BACKTESTS against recorded history (--signals-from-history); rejected when no history is provided.
        Schedule entries can declare post-fill hooks inline ("onFill": {"type":"createOrder",
        "spec": {...}} or multi-leg {"type":"createOrders","specs":[...]} — same shape as
        schedule create --on-fill, {{filled.X}} placeholders supported); validated
        structurally at parse + chain-aware at deploy.
        For templates: declare {{vars}} in the JSON, supply via --var NAME=VALUE (repeatable)
        or --vars-file PATH (JSON object). --var overrides --vars-file on conflict.
  playbook list [--status all|deploying|deployed|destroyed|failed] [--limit N] [--json]
        List playbook deployments. Default status=deployed.
  playbook show <id> [--json]
        Full detail incl. parsed spec + every owned primitive (orders / schedules / rebalance plans) with current status.
  playbook destroy <id> [--yes] [--json]
        Cancel every owned ACTIVE primitive + mark playbook destroyed. Already-terminal primitives
        (filled / expired / cancelled / completed) are reported but left alone.
  playbook diff <id> <new-spec-file> [--var NAME=VAL ...] [--vars-file PATH] [--json]
        Read-only preview of what 'playbook replace' would change. Classifies each primitive
        as unchanged / modified / added / removed; lists field-level changes for modified
        plus the apply mode (edit-in-place vs cancel+recreate). Useful in CI for spec PRs.
  playbook promote <id> [--to real|paper] [--yes] [--require-funded] [--skip-preflight] [--json]
        v36 preflight: promotes to REAL first ask the funding runway "could the
        real wallet fund this?" — paper primitives bucketed as-if-real, spend
        tokens AND gas vs the actual on-chain balances. Findings print worst-
        first (✗ cannot fund one fire / ⚠ runs out in Nd / balance unknown).
        Advisory by default; --require-funded aborts on a cannot-fund-one-fire
        finding (a dead RPC warns, never blocks); --skip-preflight for
        RPC-less environments.
        Flip every live primitive between paper and real IN PLACE — trailing HWM,
        run counters, drift telemetry all survive (vs destroy+redeploy, which
        resets them). The dry-run loop's graduation step; --to paper demotes a
        live strategy back to the sandbox. Promotion to real asks for the
        'promote' confirmation phrase unless --yes; real balances are NOT
        pre-checked — sanity-check with 'tradekit holdings' + trade preflight.
  playbook promote-check <id> [--json]
        v49: "is this paper strategy ready for real money?" — the strategy-
        quality half of the promote decision (promote runs the funding half).
        Composes: runtime evidence (floors: 7d + 5 fills → NOT READY below),
        realized+MTM paper PnL, the v48 paper-book risk block (drawdown/vol/
        sharpe — book-level, disclosed), and the FRICTION REALITY cross-check:
        paper fills' ASSUMED slippage vs your REAL fills' realized slippage +
        gas, projected onto the paper cadence as $/month and % of paper PnL
        (>50% → caution: "the edge may not survive real execution"). Verdict
        ready | caution | not_ready with every flag named. MCP:
        playbook_promote_check.
  playbook outcome <id> [--json]
        v50: "did promoting this strategy deliver what paper promised?" — the
        BACKWARD half of the pipeline (promote-check is the forward half).
        Compares the frozen paper baseline (paper_trades) against the live fills
        (trades) for the same strategy tag, normalized per-fill + per-week so a
        50-fill paper run and a 6-fill live run compare fairly. Both eras run
        through the SAME cost-basis walker → apples-to-apples realized PnL.
        Verdict on_track | underperforming | diverged | insufficient_data:
        diverged = paper made money but live fills realize ≤ 0; underperforming
        = live per-fill PnL < 60% of paper, or live slippage > 1.5× the paper
        assumption, or live cadence < 50% of paper. Deterministic (verdict keys
        off realized PnL + live execution quality + cadence, never MTM marks).
        MCP: playbook_outcome.
  playbook replace <id> <new-spec-file> [--var NAME=VAL ...] [--vars-file PATH]
                   [--fresh-state] [--yes] [--json]
        Atomically apply a new playbook spec. Modified primitives whose changes are all
        in-place editable (price, trailPct, amounts, slippage, expiry/end, maxRuns, note,
        cadence, onFill hook) are EDITED via the same machinery as 'order edit' / 'schedule edit' —
        trailing HWM, run counters, and journal continuity survive. Changes to frozen
        fields (OCO group, chain, account, schedule startAt/name) force cancel+recreate;
        recreated schedules/rebalance plans still carry run_count so max_runs accounting
        survives. --fresh-state opts out (v1 behavior: recreate everything, reset state).
        Paper-ness is inferred from the playbook's owned rows, so replacing a --paper
        deployment stays paper. Pre-validates BEFORE cancellation so a defective new
        spec can't leave partial state.

BACKTESTING (historical strategy simulation)
  backtest order --side buy|sell --trigger price_below|price_above|trailing
                 (price triggers: --price <USD>) (trailing: --trail-pct <N> [--price <activation>])
                 --base ETH|<addr> --quote USDC|<addr>
                 (--baseAmount A | --quoteAmount A)
                 --balance '{"ETH":1.5,"USDC":3000}'
                 --since 30d|4w|6m|<N-days> [--chain X] [--json]
                 [--slippage-bps N] [--gas-usd X] [--costs-from-history]
        Replay a single order against a CoinGecko price series. Reuses the SAME trigger
        predicates the live engine uses (isOrderTriggered, evaluateTrailingTrigger), so
        the simulator fires when production would have fired. CoinGecko resolution:
        ≤1 day = 5min; ≤90 days = hourly; >90 days = daily.
        RISK METRICS (v41, all backtest commands): results carry max drawdown
        (%/USD/peak→trough), annualized vol + sharpe, time-in-market, and a
        downsampled equity curve — for BOTH the strategy and the hold
        counterfactual (one scale, honest comparison). Persisted to
        backtest_runs.metrics_json; 'backtest show' re-renders offline and
        'backtest compare' adds a MAX DD column.
        COST-AWARE MODE (v40, all backtest commands): the default sim is friction-free,
        which flatters active strategies vs hold. --slippage-bps degrades the received
        side of every fill; --gas-usd charges a flat USD per fill against final equity;
        --costs-from-history calibrates missing knobs from YOUR recorded real trades
        (avg |realized slippage| + avg gas × current native price). Explicit flags win
        over history. The HOLD counterfactual stays frictionless on purpose.
  backtest schedule --side buy|sell (--cron "<5-field>" | --every 1h|6h|1d|7d)
                    --base ETH|<addr> --quote USDC|<addr>
                    (--baseAmount A | --quoteAmount A) [--max-runs N]
                    --balance '{"USDC":3000}'
                    --since 30d [--chain X] [--json]
                    [--slippage-bps N] [--gas-usd X] [--costs-from-history]
        Replay a recurring schedule (DCA / time-based fires) against the price series.
        Each datapoint where the cron matches AND balance suffices simulates one fill.
        Cost-aware mode matters MOST here: 30 fires/month × slippage + gas is exactly
        the friction a zero-cost sim hides.
  backtest playbook <file>
                    --balance '{"ETH":1,"USDC":3000}'
                    --since 30d [--chain X] [--base ETH] [--quote USDC] [--json]
                    [--var NAME=VALUE ...] [--vars-file FILE] [--signals-from-history]
                    [--slippage-bps N] [--gas-usd X] [--costs-from-history]
        Replay a FULL playbook spec (multiple orders + schedules) against one shared price
        series with a shared simulated balance. OCO cascade fires during simulation —
        when a peer fills, the rest of the group transitions to cancelled. Schedule
        on_fill hooks are SIMULATED: each fire spawns the follow-up order (production
        renderer, {{filled.X}} substitution, sized to the simulated fill) which then
        trades like any other order — DCA+bracket composites backtest end-to-end. Per-strategy
        stats (fire count, base/quote delta, final status) surface alongside total PnL.
        MULTI-PAIR (v43): bundles mixing bases (ETH/USDC + WBTC/USDC) fetch one
        series per unique base (max 6) and walk a merged timeline — each strategy
        prices off its own base, all trading from ONE shared quote balance (quote
        must be shared bundle-wide; hook legs trade their parent's pair). Rebalance
        plans stay excluded ('backtest rebalance' is their own multi-asset sim).
        Base/quote inferred from the first non-rebalance strategy when --base /
        --quote aren't passed.
        Templates supported: --var / --vars-file work identically to 'playbook deploy'.
        Signal-triggered entries replay against RECORDED signal history with
        --signals-from-history ("with the alerts I actually received, how would this
        have done?") — each entry fires at the first datapoint at-or-after a matching
        arrival in the signal inbox; without the flag they stay rejected (no history
        to replay is a guess, not a simulation).
  backtest rebalance --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]'
                     [--drift-threshold 5] [--min-trade-usd 10] [--cron "..."|--every 6h]
                     [--quote-token USDC] [--slippage-bps N] [--max-runs N]
                     [--balance '{"ETH":1,"USDC":2000}' | --initial-usd 10000]
                     [--since 90d] [--chain X] [--json]
                     [--sweep-thresholds 1,3,5,10] [--sweep-cadences 1h,6h,1d]
                     [--sweep-min-trades 10,100]
        Multi-asset rebalance backtest — one CoinGecko series per target (stablecoins
        synthesize a flat $1 series). Walks the cron's occurrences across the window,
        fires corrective legs with the live engine's mechanics (sells fund the quote
        anchor, buys draw from it, per-leg min-trade skip, shortfall clamps). Default
        starting book: --initial-usd split at target weights at window-start prices,
        so PnL − hold-PnL is the pure REBALANCING ALPHA vs HODL of the same book.
        Any --sweep-* flag flips to GRID mode: every threshold×cadence×min-trade
        combination re-runs over the same fetched series (zero extra API calls),
        ranked by PnL with a ★ winner; persists one backtest_comparisons row so
        'backtest compare show <id>' re-renders the table later. Max 60 variants.
  backtest compare <scenarios.json>
                    --balance '{"ETH":1,"USDC":3000}'
                    --since 60d [--chain X] [--json]
                    [--slippage-bps N] [--gas-usd X] [--costs-from-history]
        Multi-scenario backtest: replay N scenarios (each a {name, file, vars} triple) against
        ONE shared price series + a fresh balance copy per scenario. Same-pair invariant enforced
        — every scenario must reference the same base/quote (comparison is across strategies,
        not assets). Output: per-scenario PnL, vs-hold delta, fires, winner marker, hold counterfactual.
        Persists each scenario as a regular backtest_runs row + a backtest_comparisons summary
        for 'backtest compare show <id>' later.
  backtest compare list [--chain X] [--limit N] [--json]
        Recent comparison runs, newest-first. Shows pair, scenario count, winner.
  backtest compare show <id> [--json]
        Re-render a stored comparison without re-running simulations.
  backtest list [--strategy-type order|schedule|playbook|rebalance] [--chain X] [--limit N] [--json]
        Recent backtest runs sorted newest-first. Shows pair, fire count, strategy PnL, hold PnL.
  backtest show <id> [--json]
        Full detail including spec, balances, fire timeline, and Vs-hold comparison.

APPROVALS (security)
  allowances [--chain X] [--account L] [--json]     List standing approvals
  allowances audit [--chain X | --chains a,b,c | --chains all] [--account L] [--usd-threshold N] [--lookback-blocks N] [--stale-days N] [--json]
        Risk-score every standing approval; surfaces dangerous ones first (sorted CRITICAL → WARN → OK)
        --lookback-blocks N: scan recent Approval events to age each pair; flags "set and forget" approvals as stale_approval
        --chains aggregates across multiple chains: merged cross-chain list + per-chain breakdown + per-chain error capture (freshness scan skipped in multi-chain mode)
  allowances revoke-all [--spender X] [--token Y] [--account L] [--simulate] [--yes] [--json]
  approve <token> <spender> [--amount <decimal> | --infinite] [--force-infinite] [--account L]
  revoke <token> <spender> [--account L]

INSPECT (read-only — all support --watch [N] except viewTx/audit)
  status [--section S,S,...] [--watch N] [--json]
        Operational dashboard: engine workers, near-trigger orders, scheduled fires,
        rebalance drift, playbook deployments, drawdown breaker, strategy budgets, 24h audit.
        Sections: engine, orders, schedules, rebalance, playbooks, drawdown, budgets,
        activity, alerts (currently-firing + 24h transitions), paper (book + live
        paper primitives + 24h fills).
        Composes 10+ read-side queries into one situational-awareness view; sub-100ms, zero RPC.
        Different from 'health' — health is financial summary, status is operational.
  digest [--window 1h|24h|7d|30d] [--format text|slack|json] [--compare] [--strict]
        Windowed activity report: trades, strategy fires, safety events (drawdown trips,
        budget warnings, blocks), top errors, optional comparison vs prior window. Three
        formats: text (terminal), slack (markdown for direct webhook delivery), json (struct).
        Pairs with 'status' — status is right-now, digest is window summary. Cron-friendly:
        --format slack pipes directly into a Slack incoming webhook for daily reports.
        --strict exits 2 on a 🔴 critical verdict (drawdown trip, error rate > 25%).
  wallet view [--chain X] [--json]    Balances + standing approvals + recent trades
  holdings [<address> | --account L] [--chains a,b,c | --chains all] [--min-usd N] [--strict] [--json] [--watch N]
        --strict exits 1 when any chain's fetch failed (iter770 — multi-chain completeness gate).
        --min-usd: hide positions below USD threshold (unpriced tokens always shown). Filtered count + total surface in the subtotal/grand-total notes
  portfolio [--accounts a,b,c | --accounts all] [--chains a,b,c | --chains all] [--limit N] [--strict] [--json]
        Multi-account aggregate: per-token roll-up sorted by USD + concentration (top1/3/5 %).
        --strict exits 1 when any per-(account, chain) scan failed (iter796 — cron completeness gate).
  portfolio snapshot [--accounts ...] [--chains ...] [--note "..."] [--json]
        v48: --paper snapshots the VIRTUAL book instead — live-priced, written
        under the "paper:<account>" equity scope (bypasses the worker cadence).
        Curve + risk: tradekit equity --accounts-key "paper:default". The engine
        snapshot worker records both feeds (engine.snapshotIncludePaper, default
        true; no-op when the paper book is empty).
        Save current portfolio to DB for later diff. PnL only tracks realized trades; this captures full position state at a point in time
  portfolio history [--limit N] [--json]
        List saved snapshots (most recent first)
  portfolio diff <id | 7d | today | 2026-05-01> [--accounts ...] [--chains ...] [--json]
        Diff a past snapshot against the current LIVE portfolio. Shows added/removed tokens + biggest USD movers
  gas    [--chain X | --chains a,b,c] [--strict] [--json] [--watch N]    Current EIP-1559 fees; --strict exits 1 when any chain's snapshot failed (iter761).
  price  <symbol|addr> [--chain X] [--period 1d|1w|1m|1y] [--strict] [--json] [--watch N]
        --strict exits 1 when the price oracle returns null (iter769 — cron oracle health gate).
  price stats [--reset] [--json]
        Iter38: per-provider observability for the price-fetch layer (CoinGecko + DexScreener).
        Shows calls / hit rate / latency p50/p95 / last error per provider since process start.
        --reset clears the in-memory counters. Helpful for "why am I getting rate-limited?"
        and for periodic monitoring scrapes. Stats are in-memory only; resets on process restart.
  price-check <symbol|addr> [--chain X] [--tolerance-pct N] [--extreme-pct N] [--strict] [--json]
        Cross-source sanity probe: compares CoinGecko vs DexScreener; flags divergence (pool manipulation / stale data).
        --strict exits 1 on verdict=suspicious|extreme (iter777 — pipeline gate before trade).
  pnl    [--chain X] [--account L | --accounts a,b,c | --accounts all] [--since DATE] [--until DATE] [--windows 7d,30d,all] [--strategy TAG] [--by-symbol] [--no-by-symbol] [--strict] [--json]
        Realized + unrealized + gas. --windows: comma-list of relative (7d, 24h, today, yesterday) or ISO ranges (2026-01-01..2026-03-31)
        --accounts aggregates across multiple accounts: per-account breakdown + summed totals + per-account error capture
        --strategy scopes to trades tagged with this strategy (iter648 indexed column, distinct from --note)
        --by-symbol forces the cross-chain by-symbol roll-up (shown by default when positions span >1 chain)
  trades [--chain X] [--account L | --accounts a,b,c | --accounts all] [--token T]
         [--status pending|success|failed | --pending] [--note <substring>]
         [--strategy TAG] [--tx 0x..] [--aggregator NAME] [--since DATE] [--limit N]
         [--format table|csv|json|tax] [--out F]
         (--accounts: multi-account listing, merged + sorted desc by timestamp, sliced to --limit)
         (--tx: exact tx-hash lookup; --aggregator: kyberswap/openocean/0x/1inch/transfer)
         (--format tax: enriched CSV with cost_basis_usd, proceeds_usd, realized_pnl_usd, gas_usd columns)
         (--since: same DATE shorthand as audit — today, yesterday, 24h, 7d, ISO)
  trades sync [--chain X] [--account L] [--since-days N | --from-block N --to-block N] [--chunk-size N]
              [--no-bookmark | --reset-bookmark] [--strict] [--summary] [--json]
        Backfill DB from on-chain history: scans Transfer events involving the wallet, imports each swap (idempotent on tx_hash)
        (default: resumes from the last successful sync's block — iter738. --no-bookmark forces 30d fallback; --reset-bookmark clears stored state.)
        (--strict exits 1 when chunk or per-tx errors occurred — iter754, lets cron/systemd/CI gate on sync health without parsing JSON.)
        (--summary prints a one-line cron/Slack-friendly digest — iter848.)
  trades bookmarks [--json]
        List sync bookmarks: per-(chain,account,owner) last successfully-synced block + age. Read-only view of iter737 resume state.
  trades analyze <tx-hash> | --recent N [--chain X] [--account L] [--strategy TAG] [--aggregator NAME]
         [--status success|failed|all (default success)] [--strict] [--json]
        Post-trade execution quality: compares quoted vs actual on-chain amounts; reports realized slippage + quality verdict (excellent/ok/minor_slip/major_slip/extreme_slip).
        --strict exits 1 when any analyzed trade has verdict major_slip|extreme_slip (iter778 — cron quality gate).
  aggregator stats [--since DATE] [--chain X] [--account L] [--strategy TAG] [--json]
        Per-aggregator quality scorecard: trade count, success rate, median+p95 realized slippage, total volume.
        Recommends a winner when sample sizes support it (>=10 trades, >=10 bps margin)
  pairs stats [--since DATE] [--chain X] [--account L] [--strategy TAG] [--limit N (default 30)] [--json]
        Per-token-pair slippage scorecard: which pairs give bad fills (orthogonal to aggregator stats — averaging over routes vs. averaging over pairs surfaces different signals)
  slippage suggest <base> <quote> [--chain X] [--account L] [--lookback-days N] [--json]
        Preview the auto-slippage recommendation for a pair (p95 of realized history + 25% buffer, capped at safety max). Read-only counterpart to trade buy --auto-slippage
  strategies [list] [--chain X] [--account L] [--json]
        List distinct strategy tags from trades with tradeCount + first/last-used timestamps. Discovery + typo-catch for the iter648 tagging feature
  strategies --budget [--tag X] [--json]
        Per-strategy budget consumption view. Shows lifetime + 24h spend against each
        configured cap in safety.strategyBudgets, with remaining USD headroom. --tag X
        filters to a single rule pattern.
  trending [<query>] [--chain X] [--limit N] [--json]
  viewTx <hash> [--chain X] [--json]  Decode swap deltas + summary

MAINTENANCE
  reconcile [--chain X] [--account Y] [--watch=Ns] [--summary] [--json]
        Query chain for pending trades and update their status. --watch=60 reruns every 60s (iter751 — drop-in cron replacement).
        --summary prints a one-line cron/Slack-friendly digest (iter848).
  reconcile --verify-recent N [--chain X] [--account Y] [--auto-mark] [--max-reorg-depth D] [--json]
        Re-check the last N success trades for reorg-driven status flips. Conservative (flags suspects, no DB mutation); --auto-mark promotes reorg_failed → failed (reorg_missing is never auto-marked)
        --max-reorg-depth (default 256): skip trades buried deeper than D blocks (uses stored block_number — cheap pre-filter)
  reconcile --backfill-blocks [N] [--chain X] [--account Y] [--json]
        One-time maintenance: walks legacy success trades with NULL block_number, fetches receipt blocks, persists. Default limit 500. Idempotent. Re-run as needed for older history
  reconcile --backfill-slippage [N] [--chain X] [--account Y] [--json]
        One-time maintenance: walks legacy success swaps with NULL realized_slippage_bps, runs iter619 analysis, persists. Default 200 (each row = 2 RPC calls). Unlocks --auto-slippage for historical data
  reconcile --backfill-gas-usd [N] [--chain X] [--account Y] [--json]
        One-time maintenance: walks legacy success swaps with NULL gas_cost_usd_at_trade, looks up CoinGecko historical native price at the trade's timestamp, persists. Default 200 (CoinGecko rate-limited, date-cached). Unlocks tax-quarter accuracy
  reconcile --backfill-revert-reasons [N] [--chain X] [--account Y] [--json]
        One-time maintenance: walks legacy failed trades with NULL revert_reason but a captured block_number, runs eth_call replay at block-1, decodes + persists. Default 200. Inconclusive rows stay NULL for future retry
  reconcile --backfill-all [--chain X] [--account Y] [--json]
        Run all four backfills (blocks + slippage + gas-USD + revert-reasons) in sequence. Convenience for post-upgrade catch-up. Each mode applies its own default limit
  pending [--chain X] [--account Y] [--tx-hash <h>] [--watch=Ns] [--strict] [--summary] [--json]
        Diagnose stuck/pending trades — classifies WHY each is stuck (gas underpriced vs nonce blocked vs stale) and recommends an action (wait/speedup/cancel-earlier-nonce).
        --watch=30 reruns the diagnosis every 30s so operators see verdicts evolve as gas markets shift (iter753).
        --strict exits 1 when any tx needs operator action (speedup / cancel / investigate) — iter757, lets cron alert on stuck-not-waiting state.
        --summary prints a one-line cron/Slack-friendly digest with byAction mix (iter899).
  tx speedup <hash> [--chain X] [--multiplier N] [--pass <pw>] [--json]
        Replace a stuck pending tx with a higher-gas replacement at the same nonce (default ×1.2; min 1.1)
  tx cancel  <hash> --yes [--chain X] [--multiplier N] [--pass <pw>] [--json]
        DESTRUCTIVE: replace pending tx with a zero-value self-send at same nonce (cancels the original)
  audit  [--limit N] [--since DATE] [--tool T] [--account L] [--chain X] [--caller cli|mcp|web]
         [--error-code CODE] [--errors-only] [--tx 0x..] [--json]
        --since accepts: YYYY-MM-DD, ISO timestamp, today, yesterday, 1h..48h, 1d..30d
        --error-code: exact match against canonical code (e.g. SLIPPAGE_EXCEEDED). --errors-only: rows where error_code is set
        --tx: full audit history for one tx hash (submit + reconcile + view-tx calls)
  audit summary [--since DATE] [--tool T] [--account L] [--chain X] [--caller cli|mcp|web] [--json]
        Aggregated stats: by tool, error code, caller, chain + error rate. Cron-friendly via --json
  audit prune --before DATE [--yes] [--json]   Preview + delete old audit rows (same DATE shorthand as --since; --json: action: pruned|aborted|noop-empty)
  logs   [--tail N] [--follow]        Tail ~/.tradekit/server.log
  backup export <file> [--include-db] [--force] [--pass <pw>] [--json]
        Encrypt the full data dir into a single bundle (mnemonic + wallet + accounts + config, opt-in db)
  backup restore <file> [--force] [--pass <pw>] [--json]
        Decrypt + restore a backup into the data dir. --force overwrites existing files (interactive 'restore' confirm prompts when TTY)

SERVERS
  mcp [--pass <pw>]                   Start MCP stdio server for AI agents
  web [--port 3030] [--host 127.0.0.1] [--pass <pw>]  Single-page UI + REST API
        Read-only automation routes (token-authed, zero RPC/writes): /api/engine, /api/dashboard,
        /api/orders[/:id], /api/schedules[/:id], /api/rebalance[/:id] (each :id with
        its decision-journal tail), /api/playbooks[/:id], /api/paper, /api/timeline,
        /api/alerts, /api/strategy-report/:tag — dashboard/monitor consumption.

GLOBAL FLAGS
  --pass <pw>          Wallet password (or set WALLET_PASS env). Only required for real
                       trade/transfer/approve/revoke (and wallet create/import/export);
                       quote, --simulate trades, --simulate transfers, and all INSPECT
                       commands run without a password.
  --json               Machine-readable JSON output. Combined with --watch, emits compact one-line
                       JSONL per tick (iter792 — line-by-line parseable by 'jq -c', Vector, Fluent Bit).
  --quiet              Cron-friendly noise reduction. Filters output to non-ok rows on health (iter734)
                       / doctor (iter752) / verify (iter760). Operators tail-watching cron logs see
                       only signals worth reading.
  --strict             Exit 1 on actionable bad state. Each command's strict trigger matches its
                       domain — doctor (warnings), trades sync (chunk errors), health (critical
                       nextActions), pnl (stale data), pending (actionable verdicts), gas/price/
                       holdings/portfolio (per-chain failures), preflight (no_go), token check
                       (honeypot/suspicious), price-check (suspicious/extreme), trades analyze
                       (major_slip/extreme_slip), trade preview (safety fail). Use in cron pipelines
                       to gate downstream steps on exit code (iter754-798).
  --watch [N]          Re-run the command every N seconds (default 5; min 1, max 3600). Clears the
                       screen between ticks; --json mode emits JSONL stream instead. Supported on
                       health, doctor, reconcile, pending, sync, holdings, pnl, gas, price (iter751+).
  --summary            Single-line cron/Slack-friendly digest instead of the multi-line text view.
                       Available on health (iter846), doctor / verify (iter847), reconcile / trades
                       sync (iter848), pending (iter899). Field-collapse pattern: healthy state is
                       short; degraded state grows fields naturally as errors appear, so operators
                       scanning a chat channel see degradation by length alone. JSON mode unchanged.
  --verbose            Mirror DEBUG+INFO logs to stderr (debugging — verbose).
  --simulate           For write ops: dry-run without sending tx. Runs password-free
                       since no signing happens; uses the active address as the eth_call
                       sender so on-chain checks (balance, allowance) match a real send.
  --force-gas          Bypass the gas-budget safety check (safety.gas.maxGasPctOfTrade /
                       safety.gas.maxGasNativePerChain). Logged at warn level for audit.
  --expected-out N     Lock-in: amountOut captured from a prior quote (decimal). Trade fails
                       with QUOTE_DEVIATION_EXCEEDED if the live re-quote diverges by more
                       than --max-deviation-bps (default 100). Use for quote → review → buy flows.
  --max-deviation-bps N  Tolerance for --expected-out (default 100 = 1%).
  --auto-slippage      Derive slippage cap from your own realized-slippage history on the
                       canonical pair (iter641-stored). Requires ≥5 samples; falls back to
                       --slippage / config default with smaller samples. Ignored when --slippage is set.

ENVIRONMENT
  WALLET_PASS                  Wallet password (alternative to --pass)
  TRADEKIT_DATA_DIR            Override data dir (default: $HOME/.tradekit)
  TRADEKIT_WEB_TOKEN           Pin the web auth token (default: random per run; 16+ chars)
  TRADEKIT_HTTP_TIMEOUT_MS     External API timeout (default: 8000)
  TRADEKIT_RECEIPT_TIMEOUT_MS  Tx-confirmation wait (default: 90000)
  TRADEKIT_LOG_ROTATE_BYTES    server.log rotation threshold (default: 50MB)
  TRADEKIT_STRATEGY            Default --strategy for trade commands (per-trade flag overrides)

Files:
  Config:    ${CONFIG_PATH}
  Wallet:    ${WALLET_PATH}
  Mnemonic:  ${MNEMONIC_PATH}
  Accounts:  ${ACCOUNTS_PATH}
  Database:  ${DB_PATH}`);
}
