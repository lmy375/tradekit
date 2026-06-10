# tradekit

A production-grade CLI / MCP / Web framework for AI agents trading ERC-20 tokens on EVM DEXes.

- **Aggregator-first** swap routing — KyberSwap / OpenOcean free; 0x / 1inch optional. Configurable `mode: first|best` (race for best price vs lowest-latency). Automatic fallback to the next aggregator if simulation reverts (pool drift between quote and call is real).
- **MEV-protected submission** — when configured, write transactions route through a private relay (Flashbots Protect, MEV Blocker, Merkle Private RPC, etc.) instead of the public mempool. Sandwich-attack mitigation on mainnet; no behavior change on chains without a configured relay. Reads stay on public RPCs (most relays buffer txs privately for some blocks before propagation). `doctor` probes the relay's reachability + chainId on every run so a wrong / dead URL surfaces before a trade does.
- **Conditional orders** — limit / stop-loss / take-profit / **trailing-stop** via a polling off-chain engine. `tradekit order create --side buy --trigger price_below --price 2900 --quoteAmount 100` registers a standing intent; trailing stops use `--trigger trailing --trail-pct 5` to track the high-water mark (for sells) or low-water mark (for buys) and fire on retracement / rebound. `tradekit order run` (one-shot or `--watch`) fires triggered orders through the SAME `executeTrade` path as manual swaps, so every safety guardrail + audit row applies verbatim. Persistent + resumable: the engine writes the water mark to disk every tick, so a restart resumes tracking from where it left off.
- **Prometheus metrics endpoint** — `/metrics` route on the web server, `--metrics-port` on the engine, or `tradekit metrics` as a one-shot CLI. Exposes trades/orders/schedules/rebalance counts by status, audit error breakdown, engine running state + uptime, per-worker tick + failure counts + staleness gauges. Stateless snapshot model: every metric is read from existing DB state + status file at scrape time, no in-memory counter accounting. Labels are bounded enums (no wallet addresses, no USD values) — safe to expose on a private network without leaking ops detail.
- **OCO (One-Cancels-Other) order groups** — link two or more orders with `--group <id>` and the engine auto-cancels the rest when any peer fires. Take-profit-or-stop-loss brackets, multi-level take-profit ladders, "any-of-three exit prices" patterns. Cascade fires on engine-driven terminal transitions (filled / failed / expired); manual cancel opts in via `--cascade`. Each cancelled peer carries reason `OCO_PEER_FIRED` or `OCO_OPERATOR_CASCADE` for forensic visibility, and an `order.cancelled_oco` notification fires per cancelled peer.
- **Portfolio rebalancing** — declarative target-weight plans. `tradekit rebalance create --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]'` registers a plan; the engine periodically evaluates portfolio drift and fires corrective trades through `executeTrade` when drift exceeds the configured threshold. Each plan covers one chain + one account; trades route through a quote anchor (default chain USDC). Skips sub-threshold legs to avoid gas burn on micro-corrections. Composes with: position limits (rebalance respects them), MEV protection (corrective trades route through private RPCs), engine supervisor (runs as a 4th worker alongside orders/schedules/reconcile).
- **Scheduled / recurring trades (DCA)** — cron-driven sibling of the conditional-orders engine. `tradekit schedule create --side buy --every 7d --quoteAmount 100` registers a weekly DCA; `tradekit schedule run` fires due trades through `executeTrade`. Full cron expression support (`0 10 * * 1`), `@hourly`/`@daily`/`@weekly`/`@monthly` macros, `--max-runs N` lifetime cap, pause / resume / cancel lifecycle. Each fire emits a `schedule.fired` notification.
- **Unified engine supervisor** — `tradekit engine run` fans out orders + schedules + reconcile workers in one process. Single keystore decrypt at boot, process-locked (a second invocation immediately fails with the holder's pid), graceful shutdown that drains in-flight ticks, hourly `engine.heartbeat` push so monitoring confirms liveness. The natural production deployment unit — one systemd service / container replacing three separate daemons.
- **Push notifications** — Slack / Discord / Telegram / generic-webhook delivery of operationally interesting events (`order.filled`, `order.failed`, `trade.failed`, `approval.infinite`). Format auto-detected from the webhook host. Best-effort with built-in dedup so a stuck order can't spam your channel.
- **Multi-chain** — Ethereum, Base, Arbitrum, Optimism, BNB, Polygon with multi-RPC failover (viem `fallback` over 4 public endpoints per chain).
- **Wallet** — encrypted single-key keystore or BIP-39 HD mnemonic with multi-account (label + index). Address book (`tradekit address`) for named recipient aliases.
- **Standing approvals** — `allowances` + `allowances audit` (risk-scored: infinite-unknown-spender, large-USD-exposure, stale) + `approve` / `revoke` / `revoke-all`. First-class CLI + MCP tools so agents can audit and clean up token exposure independently of swaps.
- **Safety guardrails** — per-tx / daily USD limits, token & contract whitelists, slippage cap, gas budget (% of trade + native cap per chain), per-account rate limit, **portfolio-aware position limits** (cap a token's weight as % of portfolio — "max 70% ETH", "min 10% USDC reserve"; runs the trade through a predicted-after-trade composition check), **pre-trade auto-honeypot probe** (every long-tail token gets a buy+sell roundtrip simulation before the trade fires; cached per-(chain,token) for 24h to amortize). Triggered guards return stable error codes (`SAFEGUARD_TRIGGERED`, `AMOUNT_EXCEEDS_LIMIT`, `GAS_BUDGET_EXCEEDED`, `POSITION_LIMIT_EXCEEDED`, `TOKEN_BLOCKED`, …) with `next_actions` hints.
- **Dry-run** — every write tool supports `simulate=true` (revert-aware via `eth_call` + `estimateGas`); aggregator auto-fallback on simulation revert. `trade preview` / `trade preflight` for inspect-before-execute.
- **Persistence** — Node 22 built-in `node:sqlite` at `~/.tradekit/tradekit.db` (no native compile step). Five tables: `trades`, `audit_log`, `portfolio_snapshots`, `sync_bookmarks`, `schema_version`.
- **PnL** — weighted-average cost-basis-based realized + unrealized P&L from your trade history. Multi-window (1d/7d/30d), strategy-scoped (`--strategy DCA`), staleness-aware (flags sync bookmarks >48h old).
- **Operator dashboard** — `tradekit health` composes portfolio + 7d PnL + trade quality + standing approvals + structured `recommendedActions[]` for agent dispatch. `--summary` produces a single-line cron/Slack-friendly digest.
- **On-chain backfill** — `tradekit trades sync` scans on-chain Transfer logs to import trades made outside tradekit (Uniswap UI, MEV bots, custom routers). Idempotent on tx_hash; bookmark-resumed across cron runs.
- **Stuck-tx recovery** — `tradekit pending` diagnoses every pending tx (gas underpriced / nonce blocked / stale) with structured verdict; `tradekit tx speedup` / `tx cancel` for replacement-at-same-nonce.
- **Audit log** — every MCP / CLI / web invocation lands in `audit_log` with caller, params, result, tx hash. Inspect with `tradekit audit` / `tradekit audit summary`.
- **Web UI** — config, holdings, trade, PnL, audit, TradingView Lightweight Charts K-line backed by OKX public data.
- **Structured errors + structured actions** for agents — every failure has a stable `code` + `next_actions`; every monitoring/diagnostic success has `severity` + `recommendedActions[]` for at-a-glance branching.
- **Cron-friendly monitoring** — `--summary` (one-line digest) + `--strict` (exit 1 on actionable state) + `--watch N` (re-run every N sec, JSONL stream under `--json`) across health, doctor, verify, reconcile, trades sync.
- **Encrypted backup** — `tradekit backup export/restore` for full-state archival; CLI-only (off the agent surface for safety).
- **Quiet by default** — CLI shows results only; `--verbose` for full DEBUG, `--quiet` for non-ok rows only. File log at `~/.tradekit/server.log` (rotates at `TRADEKIT_LOG_ROTATE_BYTES`, default 5MB).

Requires Node ≥ 22.5.0 (uses the built-in `node:sqlite`).

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands) — [Wallet & accounts](#wallet--accounts) · [Configuration](#configuration) · [Trading](#trading) · [Approvals](#approvals-security-critical) · [Data & ops](#data--ops) · [Health check](#health-check) · [Global flags](#global-flags) · [MCP server](#mcp-server) · [Web mode](#web-mode)
- [Password resolution](#password-resolution)
- [Supported chains](#supported-chains) — [Custom chain](#custom-chain)
- [Safety guardrails](#safety-guardrails)
- [Agent integration](#agent-integration) — [Error shape](#error-shape) · [Success shape](#success-shape) · [Pre-aggregated summary fields](#pre-aggregated-summary-fields) · [Install-status check](#install-status-check) · [Units](#units)
- [Data storage](#data-storage)
- [Tests](#tests)
- [License](#license)

## Install

```bash
npm install -g tradekit
# or
npx tradekit help
```

## Quick start

```bash
# Guided one-time setup (wallet + active chain + safety guardrails +
# the production observability preset: decision journals, DB retention,
# alert watcher with starter rules — one Y answer, idempotent re-runs)
tradekit init

# Operator dashboard — portfolio + 7d PnL + standing approvals + nextActions
tradekit health

# Check holdings across all configured chains
tradekit holdings

# Get a quote (no tx sent)
tradekit quote --chain base --direction sell --base ETH --quote USDC --baseAmount 0.001

# Simulate a buy
tradekit trade buy --chain base --quoteAmount 10 --simulate

# Execute (omit --simulate)
tradekit trade buy --chain base --quoteAmount 10

# Cron-friendly monitoring (single-line output, exit 1 on issues)
tradekit doctor --summary --strict        # config + RPC + wallet integrity + ops hygiene (retention, paper book, alert coverage, engine liveness)
tradekit health --summary --strict        # portfolio + PnL + alerts
tradekit pending --summary --strict       # stuck-tx triage
tradekit reconcile --summary              # confirm pending tx receipts
```

`tradekit init` walks through the hd-vs-keystore wallet choice with sensible defaults — pick `[h]d` (default) for a 12-word BIP-39 mnemonic supporting multiple accounts, or `[k]eystore` for a single encrypted private key. Already know what you want? Skip `init` and run `tradekit wallet create` or `tradekit account create-mnemonic` directly.

## Commands

### Wallet & accounts

```bash
tradekit wallet create | import | export | view [--chain <name>]
tradekit account create-mnemonic | import-mnemonic | list
tradekit account add <label> [--index N] | use <label>
tradekit address list | add <name> <0x-addr> [--note "..."] | remove <name>
# Address book (iter614): named recipient aliases for `transfer --to <name>`.
# Reduces paste-typo risk on transfers — pre-iter614 every transfer required
# pasting the full 0x address, which is the #1 self-inflicted loss vector.
```

### Configuration

```bash
tradekit config show
tradekit config get  <dotted.path>          # e.g. safety.perTxUsdLimit
tradekit config set  <dotted.path> <value>  # value is JSON-parsed if possible
tradekit config push <dotted.path> <item>   # append to an array (e.g. safety.tokenBlacklist.base)
tradekit config drop <dotted.path> <item>   # remove from an array
tradekit config validate                    # re-run schema validation against the on-disk config
tradekit config path                        # print config file path
```

### Trading

```bash
tradekit quote --chain <name> --direction buy|sell \
  --base ETH|<addr> --quote USDC|<addr> \
  --baseAmount|--quoteAmount <decimal> [--slippage <bps>] [--auto-slippage]

tradekit trade buy|sell --chain <name> [--base ...] [--quote ...] \
  --baseAmount|--quoteAmount <decimal> [--slippage <bps> | --auto-slippage] [--strategy TAG] [--simulate]

# Inspect-before-execute: shows safety verdict + simulated balance/price/slippage WITHOUT submitting
tradekit trade preview  buy|sell --chain X --base ETH --quote USDC --baseAmount 0.01 [--strict] [--json]
tradekit trade preflight buy|sell --chain X --base ETH --quote USDC --baseAmount 0.01 [--strict] [--json]
# preview = full preview with balance + price impact + safety pre-flight (read-only RPC, no tx)
# preflight = JUST the safety pre-flight verdict (go / no_go / warn). Pipe into a gate before `trade buy`.

# Quote → review → buy with lock-in (iter641): refuse if live re-quote diverges by more than N bps
tradekit quote --chain base --direction sell --base ETH --quote USDC --baseAmount 0.1 --json | \
  jq -r .amountOut | xargs -I{} tradekit trade sell --chain base --baseAmount 0.1 \
    --expected-out {} --max-deviation-bps 50
```

**`--auto-slippage`** (iter641) — derive the slippage cap from the realized-slippage history of the canonical pair (median + safety margin). Requires ≥5 prior samples; falls back to `--slippage` / config default otherwise. Use when you'd rather have the tool tune slippage from your data than guess a number.

**`--strategy TAG`** (iter648) — tag the trade with a free-form label (e.g. `DCA`, `swing`, `mev-arb`). Later: `tradekit pnl --strategy DCA` slices PnL to one tagged campaign; `tradekit strategies` lists all tags seen.

**`--simulate`** runs the full pipeline via `eth_call` + `estimateGas` without submitting. The aggregator auto-falls back to the next preferred provider if the simulation reverts (pool drift between quote and call is real).

**Aggregator selection** — control which DEX aggregator (KyberSwap / OpenOcean / 0x / 1inch) services each quote via config:

```bash
tradekit config set aggregator.preferred '["kyberswap","openocean"]'
tradekit config set aggregator.mode "best"           # iter602: race all preferred in parallel, pick highest amountOut
# or:
tradekit config set aggregator.mode "first"          # default — try in order, return first successful quote
```

**`mode: "first"`** is lowest-latency but can leave price on the table when a later-listed aggregator quotes better. **`mode: "best"`** races every eligible provider via `Promise.allSettled`, returns the best quote, and surfaces losers in `result.alternatives[]` so the spread is auditable. Latency = slowest provider's response time. Use `best` on volatile or thin-liquidity pairs; `first` on familiar pairs where saving 200ms matters more than a few bps.

Quality-driven tuning: `tradekit trades analyze --json` (iter623 aggregator stats) carries a `recommendedAggregator` field — agents detect config drift by comparing it with `config.aggregator.preferred[0]`.

### Conditional orders

Standing intents that fire when the live USD price of the base token satisfies a predicate. The engine routes triggered orders through the same `executeTrade` path as manual swaps — every safety guardrail (per-tx / daily USD caps, slippage limit, gas budget, token & contract whitelists, rate limit) applies verbatim and every fill lands in `trades` + `audit_log` with `[order #N]` stamped on the note.

```bash
tradekit order create --side buy --trigger price_below --price 2900 \
  --base ETH --quote USDC --quoteAmount 100 --slippage 50 --expires-in 7d
# → Created order #3   ○ active
#     Trigger: ETH ≤ $2900  (price_below)
#     Intent:  buy ETH for 100 USDC on base (account: main)
#     Expires: 2026-06-06T...

tradekit order list                                 # active by default
tradekit order list --status all --json
tradekit order show 3
tradekit order cancel 3                             # interactive confirm on TTY
tradekit order run --once                           # single tick (cron-friendly)
tradekit order run --strict --json                  # daemon: watch=30 by default
```

Mapping to the five classic order types:

| Type          | `--side` | `--trigger`     | Required           | Use case                       |
|---------------|----------|-----------------|--------------------|--------------------------------|
| limit-buy     | `buy`    | `price_below`   | `--price`          | Buy the dip                    |
| limit-sell    | `sell`   | `price_above`   | `--price`          | Sell into strength             |
| stop-loss     | `sell`   | `price_below`   | `--price`          | Cut losses below threshold     |
| take-profit   | `sell`   | `price_above`   | `--price`          | Lock in gains above threshold  |
| trailing-stop | `sell`   | `trailing`      | `--trail-pct`      | Lock in profits as price runs — fires when peak retraces by N% |
| trailing-buy  | `buy`    | `trailing`      | `--trail-pct`      | Buy a rebound — fires when low rebounds by N%                  |

**Trailing stops** (`--trigger trailing`) track a running high-water mark (sells) or low-water mark (buys) and fire when the price retraces by `--trail-pct N` from that mark. Unlike a static `price_below` stop-loss, the trail follows the price upward — every new high raises the fire threshold by the same fraction, so a rally captures more gains before the inevitable retrace fires the sell.

```bash
# Trail 5% below the HWM, no activation gate (starts trailing immediately)
tradekit order create --side sell --trigger trailing --trail-pct 5 \
  --base ETH --quote USDC --baseAmount 0.5

# "Start trailing AFTER ETH hits $3500" — activation gate via --price
tradekit order create --side sell --trigger trailing --trail-pct 5 --price 3500 \
  --base ETH --quote USDC --baseAmount 0.5
```

`order show <id>` and `order list` render the current state: `HWM $3500 → fires at $3325` once the trail is tracking. State is durable — the water mark is persisted to disk on every improvement, so an engine restart resumes from the last seen high without losing the trail.

**Order decision journal — `tradekit order replay <id>` (iter25).** When `engine.orderJournal.enabled=true`, the orders engine writes a row to `order_check_log` on each STATE-CHANGING tick (HWM advanced, proximity crossed, fire, error). Naive "log every tick" would produce ~10M rows/year at 30s intervals × 10 active orders; state-change sampling reduces this to typically 5-20 rows per order's full lifecycle while preserving the full forensic signal.

**Crash-safe fire accounting (v33) — the engine never double-buys.** Two windows used to allow a double-fire: (1) the engine crashes between tx-send and `recordScheduleFire` — on restart the schedule is still "due" and refires; (2) a `TX_TIMEOUT`'d tx (sent, unconfirmed) confirms during a v32 retry backoff — the retry would resubmit the occurrence. The engine now runs a **crash-window guard** before every fire: real fires stamp `[schedule #<id>]` into the trade note and paper fires carry `source_type/source_id`, so the guard can ask "does a trade attributable to THIS occurrence already exist?" (timestamp ≥ the occurrence's original due time — for retry slots the window reaches back past the consumed backoff). If evidence exists (`pending` or `success`; reverted rows don't count — the swap didn't deliver), the occurrence is **booked from the evidence trade** (amounts + txHash are on the row): `run_count` advances, totals accumulate, `next_run_at` moves on, a `schedule.recovered` warn notification explains what happened, and the journal records `recovered`. Nothing is refired; on_fill hooks are deliberately skipped on recovery (the notification says so). Trades from properly-booked past fires always predate the current `next_run_at`, so they can never false-match. Rebalance gets the symmetric guard: **unconfirmed legs** from an interrupted run defer the evaluation (`skipped_pending_legs`, no quota consumed, no failure stamped) because the snapshot doesn't reflect them yet — once they confirm, drift is recomputed from the post-leg portfolio and re-evaluation is safe by construction.

**Orders complete the triangle** — and for them the guard fixes a live bug, not just a crash window: a `TX_TIMEOUT` left the order ACTIVE for next-tick retry, so a timed-out-but-landed tx would be refired sixty seconds later. Orders fire ONCE ever, so the evidence window is the order's whole lifetime (`created_at`): any pending/success trade stamped `[order #<id>]` (or paper source ids) books the fill from the evidence row (`fill_tx_hash`, `fill_price`, amounts), the journal records `recovered` (`order replay` shows ♻), an `order.recovered` warn notification explains, and — critically — the **OCO cascade still runs**: a booked take-profit kills its stop-loss arm exactly like a live fill would, so no orphaned exit survives. on_fill hooks are skipped on recovery, same as schedules.

**Transient-failure retry (v32) — one bad RPC second no longer costs a weekly DCA its whole week.** Pre-v32, ANY fire failure advanced `next_run_at` to the next natural cron slot — correct for terminal failures (a safeguard violation or short balance would fail identically on retry), but a silent occurrence loss for transient ones (RPC flake, rate limit, aggregator hiccup). The engine now classifies the failure: transient codes park the row on an exponential-backoff retry slot (`engine.fireRetry` — default 5m → 10m → 20m, 3 attempts; `last_run_status='retry_pending'`, `retry_count` on the row) while terminal codes advance immediately. Two hard bounds keep retries safe: the retry slot never crosses the **next natural occurrence** (retrying then would double-fire — the next occurrence supersedes) nor `end_at`. Budget exhaustion falls through to the old advance-and-record path with an escalated critical "occurrence LOST after N attempts" notification — individual retry attempts only warn. Success, terminal failure, and exhaustion all reset the counter. The same mechanism guards rebalance evaluations (snapshot/wallet failures retry; per-leg failures don't — completed legs must not double-execute). Journaled as `retry_scheduled` decisions in both replay journals; `schedule show` / `rebalance show` flag when `next_run_at` is a retry slot. Disable via `engine.fireRetry.enabled=false`.

**Schedule + rebalance decision journals (v29) — forensic parity across all three engines.** `engine.scheduleJournal.enabled` / `engine.rebalanceJournal.enabled` journal the other two engines' decisions to `schedule_check_log` / `rebalance_check_log`, replayed via `tradekit schedule replay <id>` / `tradekit rebalance replay <id>` (MCP: `schedule_replay` / `rebalance_replay`). Schedules record every fired / fire_failed / retired (end_at, max_runs) / locked-skip / on_fill hook outcome with run numbers and tx hashes — "why didn't my DCA fire this morning?" becomes one command. Rebalance records EVERY evaluated occurrence *including in-band ones* with `max_drift_pct`: the drift history is the point — operators watch drift creep toward the threshold instead of being surprised by the fire. Both engines are due-driven so cardinality is naturally bounded (a 6h-cron plan writes ≤4 rows/day); the one repeat case — engine-lock skips re-evaluating every tick — dedupes at the writer. The journals also feed the unified timeline (`--kinds schedule.journal,rebalance.journal`) and `schedule show` / `rebalance show` print a recent-decisions tail inline. Prunable via `db.retention.scheduleCheckLogDays` / `rebalanceCheckLogDays`.

```bash
# Enable journaling (opt-in, default off)
tradekit config set engine.orderJournal '{"enabled":true,"proximityPct":5,"retentionDays":30}'

# After some ticks elapsed, replay the decision history
tradekit order replay 14
```

Sample output:

```
Order #14  sell 1 ETH  trailing 5% (activation $3000)
  Status:        filled
  Chain:         base
  Created:       2026-05-01T12:00:00Z
  Filled:        2026-05-02T20:00:00Z

Decision timeline (5 entries):

  2026-05-01 12:00:00 UTC    $2800.00                                    ○ waiting for activation
  2026-05-01 14:00:00 UTC    $3050.00  HWM $3050.00 thr $2897.50         ⚙ tracking started, HWM seeded
  2026-05-01 18:00:00 UTC    $3200.00  HWM $3200.00 thr $3040.00         ⚙ HWM advanced
  2026-05-01 19:00:00 UTC    $3100.00  HWM $3200.00 thr $3040.00         ⚠ near threshold
  2026-05-01 20:00:00 UTC    $3030.00  HWM $3200.00 thr $3040.00         🔥 FIRED
```

**Nine decision states:**
- `activation_pending` ○ — trailing order waiting for activation gate
- `tracking_started` ⚙ — first tick after activation; HWM seeded
- `hwm_advanced` ⚙ — water mark moved
- `near_threshold` ⚠ — price first within `proximityPct` of fire threshold
- `triggered_fired` 🔥 — engine fired the order
- `triggered_skipped` ⏸ — trigger satisfied but engine declined (dry-run, engine lock, rate-limit, balance, safety); notes carry the reason
- `error` ✕ — engine path error (price fetch failed, wallet load failed, trade exception — transient AND terminal; notes carry the error code so replay answers "why did this order flip to failed?")
- `edited_by_operator` ✎ — order edited in-place; notes carry the field diff
- `expired` ⌛ — engine retired the order (now ≥ `expires_at`); the replay timeline ends explicitly instead of just stopping. Also written by the pre-fire expiry re-check (an order whose `expires_at` passes during the price fetch / keystore decrypt is retired instead of fired)

**Sampling decisions** (`shouldLogCheck`): a tick produces a journal row when ANY of:
1. First entry for the order
2. Terminal decision (`triggered_fired` / `triggered_skipped` / `error` / `expired`) — always logged for forensic context
3. Decision state changed from prior entry
4. Water mark advanced (or null↔number transition)
5. Price first crossed within `proximityPct` of threshold

Routine "still tracking, no change" ticks are skipped entirely — the operator loses no signal because every interesting transition gets a row.

**Replay answers questions the existing surface can't.** "Why did this trailing stop fire at $3030 and not when ETH first hit $3000 four hours earlier?" The journal shows HWM $3200 was set during the 18:00 spike → threshold became $3040 → the 20:00 dip crossed it. Without the journal, the operator sees only `fill_price: $3030` and has to log-archaeologize the HWM trajectory.

**Cardinality cost.** For an active trailing order over 30 days at 30s tick intervals: 86,400 ticks. Typical: 5-20 journal rows. That's <0.05% write amplification vs naive logging.

**Pruning.** `pruneOrderCheckLog(beforeIso)` is exposed for doctor-driven retention. v1 doesn't auto-prune; operators can wire it into their existing audit-prune cron.

**OCO (One-Cancels-Other) groups.** Link multiple orders with `--group <id>`. When any peer transitions to a terminal state via the engine (filled / failed / expired), the engine auto-cancels the remaining active peers in the same group.

```bash
# Classic take-profit-or-stop-loss bracket: whichever fires first, cancel the other.
tradekit order create --side sell --trigger price_above --price 4000 \
  --base ETH --quote USDC --baseAmount 0.5 --group eth-exit

tradekit order create --side sell --trigger price_below --price 2700 \
  --base ETH --quote USDC --baseAmount 0.5 --group eth-exit

# Three-level take-profit ladder — whichever level fires first, cancel the others.
for price in 3500 4000 4500; do
  tradekit order create --side sell --trigger price_above --price $price \
    --base ETH --quote USDC --baseAmount 0.2 --group tp-ladder
done

# Manual cancel — does NOT cascade by default (single-leg update is intentional).
tradekit order cancel 42

# Manual cancel WITH cascade — cancels the rest of the group too.
tradekit order cancel 42 --cascade
```

**Group id format:** alphanumeric + dash + underscore, ≤ 64 chars. Operator-supplied; tradekit doesn't enforce shape constraints beyond syntax (groups can span different sides, triggers, even different chains — the link is the string match).

**Why both auto + manual cascade?** Auto-cascade on terminal transitions (`OCO_PEER_FIRED`) is the canonical OCO semantic — "fire one, cancel the rest". Manual cancel without cascade is for the common case of "update one leg, keep the others"; cascade-on-manual would surprise operators. The `--cascade` flag opts in to "I want to abandon the whole group" — peers carry reason `OCO_OPERATOR_CASCADE` so post-hoc audit can distinguish operator intent from engine action.

**`order show <id>` renders peer state** — when the order has a `group_id`, the show output lists every peer in the group with its current status and (for cancelled peers) the cancellation reason. Avoids running a separate `order list --group X` to understand the bracket state.

**Engine lifecycle.** Orders only fire while `tradekit order run` (or the equivalent `order_run` MCP tool) is being called. Three deployment patterns:

1. **Long-running daemon** — `tradekit order run --strict --json --watch 30` under systemd / Docker / `pm2`; emits one JSONL record per tick.
2. **Cron** — `* * * * * tradekit order run --once --strict --json >> /var/log/tradekit-orders.log` (one tick per minute, exit code as alert gate).
3. **Agent-driven** — an MCP agent (e.g. inside Claude Desktop) calls `order_run` on its own schedule.

Each tick prices every active order's base token via CoinGecko → DexScreener fallback (same oracle stack as `tradekit price`), evaluates the trigger, and stamps `last_checked_at` + `last_checked_price` on every row whether or not it triggered — so `order list` lets you verify the engine is actually running without enabling DEBUG logs.

Transient errors (RPC blip, CoinGecko rate-limit) leave the order **active** for retry on the next tick. Terminal errors (revert, guardrail tripped, balance insufficient) flip the row to `failed` so a misconfigured order can't burn gas across hundreds of ticks. The trade-off is documented per code in the order's `last_error_code` column.

### Engine (unified supervisor)

The production deployment unit. `tradekit engine run` is a single process that ticks orders + schedules + reconcile on their independent cadences. Replaces the three separate `*  run` daemons with one systemd service / one container / one health check / one keystore decrypt at boot.

```bash
# Daemon mode — runs forever, ticks every worker on its own interval
WALLET_PASS=$(cat ~/.wallet-pass) tradekit engine run

# One-shot for cron (single tick round, then exit)
tradekit engine run --once --strict --json >> /var/log/tradekit-engine.log

# Subset deployment — only the read-only reconcile worker (no password needed)
tradekit engine run --workers reconcile

# Dry-run — evaluate triggers + advance bookkeeping without sending tx
tradekit engine run --dry-run --once

# Inspect a running engine from another shell
tradekit engine status              # human-readable
tradekit engine status --json | jq  # for monitoring scripts
```

**Workers** (configurable via `config.engine.workers.*`):

| Worker | Default interval | Needs password? | Notes |
|---|---|---|---|
| `orders` | 30s | yes (unless dry-run) | Price-triggered conditional orders |
| `schedules` | 60s | yes (unless dry-run) | Cron-driven DCA / recurring trades |
| `reconcile` | 60s | **no** (read-only) | Pending-tx receipt sweep |
| `rebalance` | 300s | yes (unless dry-run) | Portfolio drift correction (target-weight plans) |
| `digest` | 300s | **no** (read-only) | v31: pushes the daily digest through the notify channels (no-op until `notifications.digest.enabled`) |

**Process lock.** The supervisor takes a file-system advisory lock (`~/.tradekit/.lock.engine`) at boot. A second `engine run` invocation immediately fails with `WALLET_LOCKED` + the holder's pid + uptime. Stale-lock cleanup handles a previous crashed run. Pairs with the existing wallet/account locks so the engine plays nicely with one-shot `wallet create` / `account add` commands.

**Graceful shutdown.** `SIGINT` / `SIGTERM` set a stop flag; the scheduling loop polls it between sleeps (≤ 1s). An in-flight tick is **always allowed to complete** — never kill a tick mid-trade. After the in-flight tick returns, the supervisor writes a final status update, releases the lock, emits `engine.stopped`, and exits.

**Heartbeat.** Every `config.engine.heartbeatIntervalMs` (default 1h), the supervisor emits `engine.heartbeat` via the notification system. Payload includes uptime + per-worker `_ticks` / `_failures` counters. Monitoring channels confirm "engine is alive" without parsing logs. Set to 0 to disable.

**Status file.** On every tick the supervisor writes `~/.tradekit/.engine.status.json` with per-worker counters, last-tick timestamps, and last-error messages. `tradekit engine status` reads + augments with freshness signals (seconds since each worker's last tick + whether the supervisor pid is still alive). Monitoring scripts can alert on stalled workers via the `--json` output.

**Global kill switch (iter28).** One command halts ALL trading paths for incident response:

```bash
tradekit engine lock --reason "investigating tx revert spike"
# All trading paths now reject with ENGINE_LOCKED.

tradekit engine unlock
# Trading resumes on the next tick (or immediately for manual trades).
```

What gets blocked when the engine is locked:

| Surface | Behavior when locked |
|---|---|
| Manual trades (`trade.ts`) | Hard-reject with `ENGINE_LOCKED` at the top of `executeTrade` |
| Orders engine | **Continues ticking** (HWM tracking, last_checked updates) but **skips the fire path**. Trailing stops stay correctly positioned for resume. |
| Schedules engine | Skips fires; `next_run_at` NOT advanced (so the missed fire happens immediately on unlock). |
| Rebalance engine | Skips drift evaluation entirely (no portfolio fetch — saves the expensive multi-token RPC). |
| Post-fill hooks | Skipped — defense-in-depth (the parent fire would have been skipped first). |
| `--simulate` trades | Exempt — read-only, no state change. |
| Read-only commands (status, holdings, portfolio, ...) | Always allowed. |

**Why orders keep ticking but skip firing.** Operators want trailing stops to STAY POSITIONED while the lock is active. If a trail's HWM was $3500 when the lock happened and during the lock window ETH hits $3800, the HWM should advance to $3800 so when the operator unlocks, the threshold is fresh. Skipping ticks entirely would leave the trail with stale state and potentially mis-fire on resume.

**Persistent across restarts.** The lock state lives in the `engine_lock` DB table (single row). A restarted engine reads the row at boot and respects the existing lock. CLI + engine + MCP server all share the same state.

**Error shape.** `ENGINE_LOCKED` carries `details.{lockedAt, reason, lockedBy, blockedContext}` and `nextActions[]` pointing at `engine_unlock` for agents that hit the rejection during automated workflows. The `status` dashboard surfaces the lock prominently at the top of the engine section.

**Notification events.** `engine.locked` (warn) on transition unlocked→locked; `engine.unlocked` (info) on the reverse. Idempotent re-locks/re-unlocks don't double-notify. Useful for paged channels — a key compromise scenario should both lock the engine AND notify the operator on their phone.

**systemd template** for the production deployment pattern:

```ini
[Unit]
Description=tradekit engine
After=network-online.target

[Service]
Environment=WALLET_PASS=...
ExecStart=/usr/local/bin/tradekit engine run --json
Restart=on-failure
RestartSec=10
KillSignal=SIGINT          # graceful shutdown — drains in-flight ticks
TimeoutStopSec=60          # tick timeout + small buffer

[Install]
WantedBy=multi-user.target
```

`tradekit order run` and `tradekit schedule run` remain first-class — operators wanting per-feature deployment (different host for each worker, separate password environments, etc.) keep using them.

### Portfolio rebalancing

Declarative target-weight plans that drift the portfolio back toward operator-defined allocations. Each plan periodically evaluates the live portfolio composition; when max drift exceeds the threshold, the engine fires corrective trades through the same `executeTrade` pipeline as manual swaps.

```bash
# Create a "core" 60/40 ETH/USDC plan that evaluates every 6 hours.
tradekit rebalance create --name core-folio \
  --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]' \
  --drift-threshold 5 --min-trade-usd 10 \
  --chain base --account main

tradekit rebalance list                        # active plans
tradekit rebalance show 1                      # detail incl. last-run telemetry
tradekit rebalance run --once --dry-run        # evaluate without firing
tradekit rebalance pause 1                     # engine ignores while paused

# Re-weight IN PLACE — run_count / max_runs accounting + last-run telemetry
# survive (cancel+create would reset them). Same edit discipline as
# `order edit` / `schedule edit`; frozen: chain, account, quote token, start-at.
tradekit rebalance edit 1 --targets '[{"token":"ETH","targetPct":70},{"token":"USDC","targetPct":30}]' \
  --drift-threshold 8

# Paper variant: drift is measured against the VIRTUAL book and corrective
# legs fill it — no chain reads, no keystore, no real trades. Seed first.
tradekit paper deposit --chain base --token ETH  --amount 0.5
tradekit paper deposit --chain base --token USDC --amount 1000
tradekit rebalance create --name paper-folio --paper true \
  --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]' \
  --chain base --account main
```

**How drift is computed.** For each target token: `currentPct = tokenUsd / portfolioUsd × 100`. The plan fires when `max(|currentPct - targetPct|) ≥ driftThresholdPct`. The corrective trades are computed by:
1. For each over-weight target: sell the USD excess INTO `quoteToken`.
2. For each under-weight target: buy the USD deficit FROM `quoteToken`.
3. Sells fire first to raise the quote balance available for the buys.
4. Per-leg trades below `minTradeUsd` skip — avoids gas burn on tiny corrections.

The quote anchor (the plan's `quoteToken`, default chain USDC) is excluded from the trade list — its weight settles via the cross-trades naturally.

**Configuration knobs:**

| Field | Default | Effect |
|---|---|---|
| `targets[]` | — | Required. List of `{token, targetPct}`. Must sum to exactly 100 (±0.01). |
| `driftThresholdPct` | 5 | Min drift (any target's `|current% - target%|`) that triggers a fire. |
| `minTradeUsd` | 10 | Per-leg minimum trade size. Sub-threshold legs skip. |
| `quoteToken` | chain USDC | Routing anchor (symbol or address). |
| `cron` | `0 */6 * * *` | Evaluation cadence (5-field UTC cron; macros accepted). |
| `slippageBps` | config default | Per-trade slippage cap (capped above by `safety.maxSlippageBps`). |
| `startAt` / `endAt` / `maxRuns` | — | Optional bounds. |

**Engine integration.** Rebalancing is a 4th worker in the unified engine supervisor (sibling to orders / schedules / reconcile), default tick interval 5 minutes. The worker is enabled by default; deployments that don't want it set `engine.workers.rebalance.enabled: false`. When no plan is configured, the tick is a cheap no-op (early-returns on `dueRebalancePlans` empty).

**Lifecycle.** Same as schedules: `active → paused → active` loop, terminal states `completed` (max_runs reached or past end_at) + `cancelled`. Failed fires stay active for next-tick retry. Notification events: `rebalance.executed` (info, with leg-level results in the body), `rebalance.skipped` (info — in-band or dry-run), `rebalance.failed` (warn). All composable with the same Slack/Discord/Telegram channels as the other engine events.

**Composes with the other safety primitives.** A rebalance trade goes through the SAME safety pipeline as a manual buy: per-tx USD cap, daily USD cap, slippage cap, gas budget, token & contract whitelists, position limits. If the rebalance trade would push ETH past `safety.positionLimits[].maxPctOfPortfolio`, the trade is rejected with `POSITION_LIMIT_EXCEEDED` (and the next leg keeps going). If MEV protection is configured for the chain, the rebalance trade routes through the private relay.

### Playbooks (declarative strategy bundles)

A playbook is a JSON file that declares a complete trading strategy as a bundle of primitives — orders, schedules, rebalance plans — that get deployed atomically and torn down together. Before playbooks, deploying a real strategy meant typing 4-6 separate CLI commands by hand with no transaction safety; a mid-deploy failure left a partial strategy active, and tear-down meant remembering which IDs to cancel. Playbooks make all three concerns (atomicity, idempotency, tear-down) explicit and reproducible.

```bash
tradekit playbook validate ./eth-strategy.json    # parse + structural check; no DB writes
tradekit playbook deploy   ./eth-strategy.json    # atomic create-all; rolls back on any failure
tradekit playbook list                            # all deployed playbooks
tradekit playbook show 1                          # per-primitive deployment status
tradekit playbook destroy 1                       # cancel every owned primitive
```

**Example spec.** Trailing-stop + OCO bracket (TP+SL) + weekly DCA, all priced in the same chain/account:

```json
{
  "name": "eth-bracket-with-dca",
  "description": "trailing stop with bracket + weekly DCA",
  "chain": "base",
  "account": "main",
  "strategies": [
    { "id": "trail", "type": "order", "side": "sell", "trigger": "trailing", "trailPct": 5, "baseAmount": 1, "base": "ETH", "quote": "USDC" },
    { "id": "sl",    "type": "order", "side": "sell", "trigger": "price_below", "price": 2700, "baseAmount": 1, "base": "ETH", "quote": "USDC", "group": "bracket" },
    { "id": "tp",    "type": "order", "side": "sell", "trigger": "price_above", "price": 4000, "baseAmount": 1, "base": "ETH", "quote": "USDC", "group": "bracket" },
    { "id": "dca",   "type": "schedule", "side": "buy", "every": "7d", "quoteAmount": 100, "base": "ETH", "quote": "USDC",
      "onFill": { "type": "createOrder", "spec": { "side": "sell", "trigger": "trailing", "trailPct": 5,
                  "base": "ETH", "quote": "USDC", "baseAmount": "{{filled.baseAmount}}" } } }
  ]
}
```

**Post-fill hooks are first-class spec fields.** The `dca` entry above declares the iter27 `on_fill` hook inline: every weekly fire auto-creates a trailing-stop on exactly the slice just bought. Pre-this, the declarative format couldn't express "DCA + auto-bracket" — the single most common composite strategy — and operators had to deploy, then hand-edit each schedule with `schedule edit --on-fill`. Hook `{{filled.X}}` placeholders are lowercase-dotted, so they pass through the (uppercase-only) playbook template renderer untouched — a template can parameterize the hook's `trailPct` with `{{TRAIL}}` while leaving `{{filled.baseAmount}}` for the engine. `playbook replace` treats `onFill` as an in-place-editable field (run counters survive a hook change); `backtest playbook` SIMULATES the hooks — each schedule fire spawns the follow-up order through the production `renderOnFillSpec` renderer (typed `{{filled.X}}` substitution included), sized to the simulated fill, evaluating from the next datapoint exactly like the live engine. The full DCA+bracket composite is backtestable end-to-end.

**Atomic deploy in 4 phases.**
1. *Validate*: parse the JSON, structurally validate every strategy entry, resolve chain/account/token symbols against the live config. No DB writes — failures surface every error in one message so the operator fixes the file once.
2. *Insert playbook row* with `status='deploying'`. Now a row id exists for strategy-tag stamping.
3. *Create primitives sequentially* via the same `createOrderRow` / `createScheduleRow` / `createRebalancePlanRow` paths as manual CLI commands. Each gets `strategy = "playbook:<id>"` stamped on the existing strategy column. OCO `group` names get prefixed with `pb<id>-` so two playbooks with the same local group don't accidentally cross-cancel via OCO cascade.
4. *Commit* by flipping status to `deployed`. On any failure: cancel every primitive already created in this call + delete the playbook row → leave the system in pre-deploy state. Errors include the underlying `INVALID_PARAMS` code + the number of rolled-back primitives in `details.rolledBack`.

**Idempotency.** Each playbook spec is canonicalized (object keys sorted alphabetically) and SHA-256 hashed. Re-deploying the SAME hash with the SAME name → no-op (returns the existing playbook id, `alreadyDeployed=true`). Re-deploying a DIFFERENT hash with the same name → INVALID_PARAMS error pointing at `playbook destroy <id>` first. A previously-destroyed playbook with the same name can be redeployed cleanly (the lookup is scoped to non-destroyed rows).

**Tear-down (`playbook destroy <id>`).** SELECT every primitive with `strategy = 'playbook:<id>'`, cancel each via the same `cancelOrderById` / `cancelScheduleById` / `cancelRebalancePlanById` paths as manual cancel. Already-terminal primitives (filled / expired / cancelled / completed) are reported in `alreadyTerminal` and left alone. Cancel errors on individual rows don't abort — they collect in `errors` so a corrupt OCO peer can't prevent destroying the rest of the bundle.

**Composability.** Because primitives are stamped with `strategy=playbook:<id>`, every existing strategy-tag filter works on the bundle:

```bash
tradekit order list      --strategy playbook:1
tradekit schedule list   --strategy playbook:1
tradekit rebalance list  --strategy playbook:1
tradekit trades          --strategy playbook:1     # historical fills attributed to the playbook
tradekit pnl             --strategy playbook:1     # PnL aggregated by playbook
```

This composes with every observability primitive (`pnl`, `strategies`, `pairs`, `audit`) that already accepts a strategy filter — the playbook becomes a first-class unit of analysis without changing those tables.

**Version control by default.** A `.json` file lives in git; `git log eth-strategy.json` is the strategy's history. CI can run `tradekit playbook validate` against every changed file to gate merges.

**Database surface.** New `playbooks` table (v17 migration): `id`, `name`, `source_path`, `source_hash`, `spec_json`, `status` (`deploying`/`deployed`/`destroyed`/`failed`), `deployed_at`, `destroyed_at`. No FK to the primitive tables — owning is by string-match on the `strategy` column, which lets the playbook layer evolve without touching the orders/schedules/rebalance_plans schemas.

#### Diff + replace (iter29) — strategy iteration without state loss

Operators iterating on a deployed strategy (change `trailPct` from 5% to 10%, add a 4th DCA leg, remove an SL bracket) previously had to `destroy + deploy` — losing all running state, no atomicity, no preview. iter29 adds two operations:

```bash
# Read-only preview — what would change?
tradekit playbook diff 1 ./eth-strategy-v2.json

# Atomically apply — cancel removed/modified-old + create added/modified-new
tradekit playbook replace 1 ./eth-strategy-v2.json --yes
```

**Diff classification.** Each primitive ends up in one of four buckets:
- `unchanged` — identical spec, no action
- `modified` — same structural shape (matched by `(type, side, base, quote)` + trigger for orders), at least one field differs
- `added` — new primitive with no structural match in old
- `removed` — old primitive with no structural match in new

**Structural matching** catches the common case: change `trailPct: 5 → 10` on the trailing-stop → classified as **modified** (not removed+added). The field-level changes are surfaced so operators see exactly what they're applying.

**Atomic replace** runs in 4 phases:
1. **Parse + render new spec** via the existing pipeline (templates, validation gates)
2. **Compute diff** against current state — each `modified` entry is also classified by **apply mode**: `edit` (in-place) vs `recreate` (cancel + create)
3. **Pre-validate** every primitive — edits via the same validators `order edit`/`schedule edit` use, creates via the deploy validators; if ANY would fail (unknown token, invalid trigger, missing required field), abort BEFORE touching state
4. **Apply**: cancel removed + modified-recreate, edit modified-edit in place, create added + modified-recreate-new; update playbook row's `spec_json` + `source_hash` + `deployed_at`

**Failure semantics.** Pre-validation catches the most common failures (chain resolution, token resolution, missing fields) BEFORE any cancellation, so a defective new spec can't leave the playbook in partial state. Mid-apply DB errors bubble with diagnostic context pointing operators at `tradekit playbook show <id>` for state inspection.

**State preservation (v2).** A `modified` primitive whose changes are all in-place editable (price, trailPct, amounts, slippage, expiry/endAt, maxRuns, cadence, note) routes through the SAME edit machinery as `tradekit order edit` / `schedule edit`: it keeps its row id, its trailing **HWM water mark**, its `run_count` / `max_runs` accounting, and gains an `edited_by_operator` journal row — full forensic continuity. Only changes to frozen identity fields (OCO `group`, `chain`, `account`, schedule `startAt`/`name`) force cancel+recreate — and even then, recreated schedules and rebalance plans **carry their run counters** (`run_count`, `last_run_at`, fill totals) to the new row so `max_runs` accounting survives. Rebalance plans gained in-place edit too (`rebalance edit`): target re-weights, drift threshold, min-trade, cadence, caps all edit in place; only quote-token / startAt changes force recreate (with counter carry). The diff preview shows the apply mode per entry; `willResetTrailingHwm` now fires only when a trailing order genuinely must be recreated. `--fresh-state` opts out of all preservation (v1 behavior: recreate everything, reset HWM + counters) — useful when the operator *wants* tracking to restart.

**Paper preservation (v2).** `deploy --paper` isn't recorded in the spec, so replace **infers** paper-ness from the playbook's owned rows: if every owned primitive is paper, recreated + added primitives are created paper too. Pre-v2 this was a real hole — replacing a paper playbook silently created the new primitives as REAL-trading ones. An explicit `paper` arg on the API overrides the inference.

**CI integration.** `playbook diff` is read-only — perfect for "diff this PR's strategy spec against deployed state" gates. `--json` output gives structured field-level changes for automated review:

```bash
tradekit playbook diff 1 ./pr.json --json | jq '.diff.summary, .diff.willResetTrailingHwm'
```

#### Strategy report (iter31) — unified observability

Pre-iter31, answering "how is my strategy doing?" required running 7+ separate commands (`playbook show`, `order list --strategy`, `schedule list --strategy`, `trades --strategy`, `pnl --strategy`, `slippage --strategy`, ...). The data was all there; what was missing was a single composable view. `tradekit strategy report` collapses every angle into one call.

```bash
# Bare number resolves to playbook:N
tradekit strategy report 1

# Free-form tag works the same way
tradekit strategy report dca-eth

# Fast tick check — only the sections agents typically poll
tradekit strategy report 1 --sections id,forward --no-prices --json

# Window the performance section
tradekit strategy report 1 --window 7d
tradekit strategy report 1 --window all
```

**Seven sections**, each independent + sub-selectable via `--sections`:

| Section       | What it surfaces                                                                |
|---------------|---------------------------------------------------------------------------------|
| `identity`    | Playbook name + deployment metadata + age + mode (real/paper)                  |
| `composition` | Every owned order/schedule/rebalance with lifecycle counts                     |
| `performance` | Fills, success rate, realized PnL, slippage p50/p95/max (windowed)             |
| `position`    | Net `(chain, token)` accumulation across all fills                              |
| `risk`        | Strategy-budget consumption (lifetime/daily/perFire) + per-strategy drawdown   |
| `activity`    | Recent fills + failures + order-journal entries, newest-first                  |
| `forward`     | Next schedule fire + per-active-order distance-to-trigger + `wouldFireNow` flag + per-plan rebalance drift proximity (persisted telemetry, no oracle call) |

**Paper-aware.** Mode is auto-detected: if every active primitive has `paper=1` (or the only trade history is paper), the report switches to paper mode and pulls performance / position / activity from `paper_trades`. Override with `--mode real` / `--mode paper` for ambiguous cases.

**Forward signals** call the same trigger predicates the engine uses (`isOrderTriggered`, `evaluateTrailingTrigger`) so the report and the engine never disagree on whether something would fire right now. Trailing orders surface their HWM + the computed retracement threshold. Live spot price is fetched best-effort (opt out via `--no-prices` for offline use); agents calling the MCP version get a deterministic network-free response by default.

**MCP tool.** `strategy_report` exposes the same surface to agents — one call replaces 7+ pre-iter31 calls. Agents wanting a near-real-time tick check pass `sections: ["identity", "forward"]` to skip the heavier aggregation paths.

**v1 limitations.**
- ~~Open positions are NOT marked-to-market in the report itself~~ — closed: `strategy report <id> --mtm` adds an opt-in VALUATION section with cost-basis positions marked at live oracle prices (realized / unrealized / total / per-position detail), in BOTH modes via the same core `paper pnl --mtm` uses. Real-mode caveat: gas excluded — `tradekit pnl` owns full portfolio accounting.
- Drawdown is shown for the per-strategy scope (`strategy:<tag>`) only; the `global` portfolio breaker has its own surface via `safety drawdown`.

#### Strategy alerts (iter32) — proactive notifications

The strategy report (iter31) gives operators a great PULL surface — but in production they need PUSH. `tradekit strategy alerts` is a rules-driven watcher that emits notifications when a strategy's health crosses operator-defined thresholds. Re-uses the existing notify stack (Slack / Discord / Telegram / generic webhook); 8 rule types cover the operationally important failure modes — including `drift_proximity`, which reads each rebalance plan's persisted last-run drift and fires when it reaches a configurable percentage of the plan's own threshold (the "rebalance is about to trade" heads-up, with no oracle call).

```bash
# After enabling safety.strategyAlerts in config:
tradekit strategy alerts show-rules           # which rules are configured + which strategies they match
tradekit strategy alerts run --once           # evaluate now; emits notifications on OK↔active transitions
tradekit strategy alerts run --watch 60       # daemon mode (every 60s); Ctrl-C to stop
tradekit strategy alerts list --active-only   # which alerts are currently firing
tradekit strategy alerts reset --tag dca-eth  # re-arm the rules for one strategy
tradekit strategy alerts history --tag dca-eth --event fired --limit 50
                                              # v28: full fire/resolve history (durable journal)

# Inline in the report:
tradekit strategy report 1 --alerts

# Mark-to-market: cost-basis positions at live prices (works real + paper):
tradekit strategy report 1 --mtm
```

**Durable transition journal (v28).** Every fired/resolved transition also lands a row in the `alert_events` table at the moment the notification is emitted — exact timestamp, the violated value, and (for resolves) the alerting duration. `strategy alerts history` (CLI) and `alert_history` (MCP) page it; `timeline_query` reads it for `alert.fired` / `alert.resolved` events (falling back to state-row reconstruction only for pre-v28 windows). Unlike `alerts list` — which shows CURRENT state — the journal keeps the full history: a flapping alert that fired and resolved five times shows all ten transitions. Prunable via `db.retention.alertEventsDays`.

**Configuration** lives at `safety.strategyAlerts` in `~/.tradekit/config.json`:

```json
{
  "safety": {
    "strategyAlerts": {
      "enabled": true,
      "rules": [
        { "type": "staleness",          "thresholdSeconds": 172800 },
        { "type": "slippage_trend",     "baselineBps": 50, "alertMultiplier": 1.5, "minSampleSize": 5 },
        { "type": "success_rate_drop",  "minRate": 0.8, "minSampleSize": 10 },
        { "type": "failure_streak",     "alertCount": 3, "action": "pause" },
        { "type": "budget_approach",    "warnPct": 0.8 },
        { "type": "drawdown_threshold", "alertPct": 10 },
        { "type": "trigger_proximity",  "alertDistancePct": 2, "appliesTo": ["playbook:*"] },
        { "type": "drift_proximity",    "alertPctOfThreshold": 80 }
      ]
    }
  }
}
```

**Nine rule types**:

| Rule                  | Triggers when…                                                              |
|-----------------------|------------------------------------------------------------------------------|
| `staleness`           | No fills for ≥ `thresholdSeconds` (DCA stuck / silent budget exhaustion)    |
| `slippage_trend`      | Avg slippage ≥ `baselineBps × alertMultiplier` (regime change / dry liquidity) |
| `success_rate_drop`   | Fill success rate drops below `minRate` (slippage too tight / token issue)  |
| `failure_streak`      | `alertCount` consecutive terminal failures (urgent — could be a new bug)    |
| `budget_approach`     | Any matching budget consumed ≥ `warnPct` (early warn vs hard limit)         |
| `drawdown_threshold`  | Per-strategy drawdown ≥ `alertPct` (early warn vs portfolio breaker)        |
| `trigger_proximity`   | Any active order within `alertDistancePct` of firing (heads-up)             |
| `drift_proximity`     | Any owned rebalance plan's last drift ≥ `alertPctOfThreshold`% of its threshold |
| `funding_runway`      | The strategy's spend-token balance runs out within `thresholdDays` (forecast)  |

Each rule supports an optional `appliesTo` filter (`["playbook:*", "dca-eth"]`) to scope thresholds per strategy, `note` for free-text rationale that ships in the notification body, and `action` to choose what a fire DOES (see the circuit breaker below).

**Fire-once-per-transition.** State is persisted in `strategy_alert_state` (v25 migration). When a rule transitions OK→active the watcher fires ONE notification; the next tick recognizes the state row and stays silent. When the condition clears, a paired `strategy.alert.resolved.<rule_type>` event fires with the alert's lifetime duration. No notification storms.

**Inapplicable rules are silent.** When a rule can't be evaluated (insufficient sample size, no live price for `trigger_proximity`, no per-strategy drawdown configured), it neither fires nor resolves — the prior state row stays intact for the next tick. This avoids both false positives (one bad fill triggers slippage_trend) and false negatives (evaluation failed silently marked as "resolved").

**Operational pattern.** Run `strategy alerts run --watch 60` as a sidecar to the engine supervisor. The watcher is a read-side process — it builds cheap section-filtered `StrategyReport`s, evaluates rules, dispatches notifications, and writes the dedup state. It never submits trades; the only engine state it can touch is the non-destructive pause flip when a circuit-breaker rule fires. Failure modes stay bounded: a watcher crash never affects the trading engine, and vice versa.

**Resetting after acknowledgment.** When the operator has investigated + addressed an alert, `tradekit strategy alerts reset --tag X --rule Y` clears the state row so the rule re-arms. The next violation emits a fresh fire notification — useful when the underlying issue gets re-triggered later.

#### Emergency stop — `tradekit panic`

When something is wrong — compromised-key suspicion, a runaway strategy, exchange-wide chaos — the operator should not have to remember four commands and a tag list. One command composes the safety primitives:

```bash
tradekit panic --reason "key may be leaked"
# → engine LOCKED (every fire path gates on the lock from the next tick)
# → every active order / schedule / rebalance plan PAUSED — tagged or untagged
tradekit panic --cancel-orders --yes      # terminal variant: orders cancelled, not paused
tradekit panic release                    # unlock; everything STAYS paused for selective resume
tradekit panic release --resume-all       # false alarm — resume everything (schedules recompute next_run_at)
```

The two layers are deliberate: the engine lock acts fastest, the pause makes the stop **durable across an unlock** and explicit in every list view. Release defaults to unlock-only because panic decisions are made under stress — resuming is the calm-state decision (`strategy resume <tag>` / `order resume <id>`). `--cancel-orders` always requires the explicit `--yes` (an interactive prompt under stress invites mistakes in both directions). A critical `engine.panic` notification (which breaks through quiet hours by severity) records the counts. **Not exposed over MCP** — the same CLI-only safety boundary as backup: an agent, or a prompt-injected agent, must be unable to mass-cancel orders or release a human-engaged panic.

#### Circuit breaker — alerts that act, not just notify

A notification at 3am is only useful if someone is awake to read it. Any alert rule can carry `"action": "pause"` — when it fires, the watcher doesn't just notify: it **bulk-pauses every primitive the strategy owns** (orders, schedules, rebalance plans) and emits a critical `strategy.alert.circuit_breaker` notification listing exactly what was paused. The system protects itself first; the operator investigates at a humane hour.

```jsonc
{ "type": "failure_streak", "alertCount": 3, "action": "pause", "appliesTo": ["playbook:*"] }
```

**Why pausing (and not cancelling) is safe to automate.** Pause is fully reversible: run counters, trailing high-water marks, OCO groups, and `next_run_at` semantics all survive. A false-positive breaker trip costs missed fires, never destroyed state. Cancellation stays a human decision.

**Fire-transition-only.** The breaker acts when the rule transitions OK → violated, never on `still_active` ticks. After investigating, `tradekit strategy resume <tag>` brings everything back — and the still-violated rule will NOT immediately re-pause (your resume is a deliberate override). Only after the rule resolves and fires fresh does the breaker act again.

**Paused-state semantics** (designed so a breaker trip can't strand dangerous state):
- Paused **orders** still expire on their `expires_at` (time bounds validity, not activity) and still die to OCO peer fires — a paused stop-loss is cancelled the moment its take-profit sibling fills, so resuming it later can't re-arm an exit for a closed position.
- Paused **schedules / rebalance plans** recompute `next_run_at` from now on resume — missed windows are skipped, not backfilled.
- Trailing watermarks freeze across the pause; a stop that fires immediately on resume because price fell meanwhile is correct stop behavior.

**Manual twin.** `tradekit strategy pause <tag>` / `strategy resume <tag>` (MCP: `strategy_pause` / `strategy_resume`) run the same machinery by hand — one command to take a whole strategy offline while you investigate, instead of hand-pausing 12 orders, 2 schedules, and a rebalance plan. Individual orders gained pause/resume parity too: `order pause <id>` / `order resume <id>` (MCP: `order_pause` / `order_resume`).

**Failure escalation.** If the pause itself errors, the alert still fires but a `strategy.alert.circuit_breaker_failed` critical notification escalates — the operator must know the system did NOT protect itself. Breaker trips are journaled to `alert_events` (`event: "breaker_paused"`, with the paused ids) and surface in the unified timeline as `alert.breaker` events.

#### Equity curve — "how has my total portfolio value moved?" (v37)

The single most-wanted operator chart. `portfolio_snapshots` (iter618) already stored point-in-time totals but only on manual `tradekit snapshot` runs — so the curve had no feed. v37 adds the **engine snapshot worker** (`engine.workers.snapshot`, enabled by the init observability preset): it ticks hourly but records only when the freshest `engine-auto` snapshot is older than `engine.snapshotEveryHours` (default 24) — one full multi-chain RPC + price scan per day, not per hour. Manual snapshots contribute to the curve but don't reset the auto cadence (your afternoon portfolio inspection shouldn't skip tonight's data point).

```bash
tradekit equity --since 90d
#   ▁▂▂▃▅▄▆▇█▇█  2026-03-12 → 2026-06-10 · 90 points
#   now $12,840.21 · start $10,002.10 · change +$2,838.11 (+28.4%)
#   peak $13,102.55 on 2026-06-02 · max drawdown 9.3%
```

**Scope discipline**: a curve only makes sense within ONE scan scope (`accounts_key × chains_key`) — mixing scopes makes the line jump on *coverage* changes, not value changes. Unpinned queries default to the most-snapshotted scope (echoed back as `scopeSource: "defaulted"`); `availableScopes` lists the rest. Pure DB read everywhere it's served: CLI `tradekit equity`, MCP `equity_curve`, web `GET /api/equity` + an inline 90-day chart on the PnL tab (teal up / red down, no charting dependency).

#### Funding runway — "will my automation run out of money, and when?"

The most common automation failure is discovered at the worst moment: a schedule fires, the balance is short, and the operator learns from a `fire_failed` notification — reactive, repeated on every subsequent fire, often at 3am. `tradekit runway` turns that into a forecast:

```bash
tradekit runway                       # all accounts/chains, 90d horizon
tradekit runway --strategy playbook:7 --days 30
tradekit runway --json | jq '.buckets[0]'
```

```
USDC  ·  default/base
  ✗  runs out 2026-07-06 (26.0d) — covers 3/12 fires
  balance 350  ·  one-shot reserved 0  ·  burn/30d 400
    schedule #4 (dca-weekly): 100 per fire, cron "0 0 * * 1"  [playbook:7]
```

**How it computes.** Walks every ACTIVE schedule's upcoming cron occurrences (respecting `end_at` and the remaining `max_runs` budget), reserves every ACTIVE order's one-shot spend up-front (an order can fire any moment), and replays them chronologically against the current balance of each spend token — the paper book for paper primitives, on-chain `balanceOf` for real ones (read-only; no keystore). Buckets key on (account, chain, paper, token): a paper DCA never counts against the real wallet.

**Price-free and exact.** Buys burn the quote token (`quote_amount` per fire); sells burn the base token. Primitives sized in the *opposite* denomination (a buy specified in base amount) have an unknowable spend without a price oracle — they're listed under `skipped` rather than silently guessed. Rebalance plans are out of scope by design: their trades are drift-dependent and sells fund the buys — no fixed burn rate exists.

**Gas is fuel too (v34.5).** Every REAL fire burns native gas regardless of the spend token — a wallet flush with USDC but dry of ETH fails every fire, and it's the most common beginner failure. The report's `gas` section groups real schedules + active orders by (account, chain), estimates per-fire gas from the **historical average over the last 50 successful trades** (`gas_cost_native`), and replays the same occurrence stream against the native balance: `⛽ default/base · gas runs out ~2026-07-02 (21d) — covers 53/90 fires · ~0.0004/fire (n=37)`. Honesty rules: no trade history → no estimate, no verdict (exposure still listed); gas prices move, so `exhaustsAt` is order-of-magnitude; paper fires burn nothing and never appear; rebalance evaluations are excluded (0..N legs per occurrence). The `funding_runway` alert rule considers gas buckets alongside token buckets — **the shortest fuse decides** — so "out of gas in 5 days" pages exactly like "out of USDC in 5 days".

**Push, not pull.** The `funding_runway` alert rule closes the loop:

```jsonc
{ "type": "funding_runway", "thresholdDays": 7 }
```

fires when any spend token is projected to run dry within a week — and with `"action": "pause"` the circuit breaker stops the strategy from firing into guaranteed failures until it's refunded. The rule reads the opt-in `runway` report section (`strategy report <tag> --sections identity,runway`), so balance reads happen only when the rule is configured. Buckets whose balance fetch failed are skipped, never guessed — a dead RPC must not page anyone. MCP: the `runway` tool returns the same report for agents.

#### DB lifecycle (iter40) — integrity / retention / auto-backup

After 12 iters of capability accumulation, the SQLite file is a critical long-term asset: 500K+ audit rows, 100K+ order journal entries, paper trades, alert state, engine events. Pre-iter40 it grew indefinitely and got backed up only when the operator remembered `tradekit backup export`. iter40 adds set-and-forget DB hygiene.

```bash
# Observability — what's accumulating?
tradekit db stats
tradekit db stats --json | jq '.stats.rowCounts'

# Periodic health check (cron-friendly — exit 1 on corruption)
tradekit db integrity-check

# Apply the retention policy (after you've configured it)
tradekit db prune --dry-run     # preview cutoffs without DELETEing
tradekit db prune                # apply

# One-shot manual backup
tradekit db backup                                   # timestamped file in data dir
tradekit db backup --dest /external/drive/snap.db   # explicit destination

# Rotate the auto-backup dir
tradekit db rotate --retain 14
```

**Three independent capabilities** — all default-disabled, opt-in via config:

1. **Integrity check** — `PRAGMA integrity_check` wrapped in a typed result. CLI / MCP / engine worker share one path.

2. **Retention prune** — per-table cutoffs in days. **Successful trades are NEVER auto-pruned** (tax records). Only `failed`/`reverted` terminal trades are touchable, and only when explicitly enabled.

3. **Auto-backup** — atomic SQLite copy via `VACUUM INTO`. Timestamped filenames + FIFO rotation.

**Configuration** (defaults shown — all enabled flags default false):

```json
{
  "db": {
    "retention": {
      "enabled": false,
      "auditLogDays": null,          // explicitly NULL = never prune audit_log
      "paperTradesDays": null,
      "orderCheckLogDays": null,
      "engineEventsDays": null,
      "alertEventsDays": null,
      "scheduleCheckLogDays": null,
      "rebalanceCheckLogDays": null,
      "failedTradesDays": null
    },
    "backup": {
      "enabled": false,
      "intervalHours": 24,
      "destDir": "backups",
      "retainCount": 7
    },
    "integrityCheck": {
      "enabled": false,
      "intervalHours": 24
    }
  }
}
```

To run all three in the background, enable the `db_maintenance` engine worker:

```bash
tradekit config set engine.workers.db_maintenance.enabled true
tradekit config set db.retention.enabled true
tradekit config set db.retention.auditLogDays 90
tradekit config set db.retention.orderCheckLogDays 30
tradekit config set db.backup.enabled true
tradekit config set db.integrityCheck.enabled true
# Next engine tick picks all this up via iter35 hot-reload.
```

**Read-only worker.** `db_maintenance` is in the iter33 `READ_ONLY_WORKERS` set — runs without keystore decryption. You can stand it up standalone with `tradekit engine run --workers db_maintenance --dry-run` if you only want DB hygiene without trading.

**Forensic trail.** Every subtask success/failure emits an iter39 engine event:
- `db.integrity_failed` (critical) — corruption detected
- `db.prune_failed` (warn) — retention SQL threw
- `db.backup_failed` (critical) — VACUUM INTO failed
- `db.backup_ok` (info) — successful backup with size + duration

```
$ tradekit engine events --types db.backup_ok,db.backup_failed --since 7d
Engine events (7 rows, since 2026-05-24T...):
  · 2026-05-24 03:00:00Z db.backup_ok      destPath=~/.tradekit/backups/tradekit-20260524030000.db sizeBytes=2400000 durationMs=85
  · 2026-05-25 03:00:00Z db.backup_ok      ...
  ...
  ✕ 2026-05-29 03:00:00Z db.backup_failed  error=ENOSPC: no space left on device
  ...
```

Operator sees exactly when backups stopped working + why.

**Sample stats output:**

```
$ tradekit db stats
DB stats: /Users/me/.tradekit/tradekit.db

  Disk:    main 47.3MB · WAL 4.1MB · SHM 32.0KB · total 51.4MB

  Row counts:
    audit_log                234,521
    order_check_log          12,847
    trades                   3,210
    engine_events            1,402
    paper_trades             892
    orders                   145
    schedules                23
    strategy_alert_state     8
    drawdown_state           1
    engine_lock              1
    (empty: portfolio_snapshots, sync_bookmarks, rebalance_plans, ...)

  Retention preview:
    audit_log                would prune rows older than 2026-03-01T12:00:00Z
    order_check_log          would prune rows older than 2026-05-01T12:00:00Z
    paper_trades             skipped (db.retention.paperTradesDays=null (unset))
    engine_events            skipped (db.retention.engineEventsDays=null (unset))
    alert_events             skipped (db.retention.alertEventsDays=null (unset))
    schedule_check_log       skipped (db.retention.scheduleCheckLogDays=null (unset))
    rebalance_check_log      skipped (db.retention.rebalanceCheckLogDays=null (unset))
    trades                   skipped (db.retention.failedTradesDays=null (unset))

  Run `tradekit db prune --dry-run` to see actual counts; `tradekit db prune` to apply.
```

**MCP** exposes `db_stats` + `db_integrity_check` for agents implementing automated DB hygiene monitoring.

**Coexistence with `backup export`.** The existing iter28+ `tradekit backup export` produces encrypted multi-asset backups (wallet keystore + config + optional DB) for disaster recovery / cross-host migration. iter40's `db backup` is SQLite-only — a simple, fast, atomic snapshot used by the auto-backup path and for same-host quick rollback. Both stay.

**v1 limitations.**
- Retention is age-based only ("keep last 90 days"). No "keep last N rows" option in v1.
- Auto-backup uses VACUUM INTO — atomic but produces full copies (no incremental). For <1GB DBs this is fine; multi-GB DBs may want an external lifecycle policy.

#### Engine events (iter39) — durable engine state transitions

Pre-iter39, the engine's lifecycle + worker resilience + config reload transitions surfaced only as **transient notifications** (iter28+). On every process restart they vanished. Operators answering "when did my engine restart last week?", "how many times has the orders worker degraded this month?", "who reloaded config 3 days ago and what changed?" had to grep rotated Slack history.

iter39 adds a v26 `engine_events` table that **side-by-side** persists every notification-emitting transition. Existing monitoring continues unchanged; what's new is the durable forensic trail.

```bash
# Default: last 24h of engine events
tradekit engine events

# Last week's worker resilience incidents
tradekit engine events --since 7d --types worker.degraded,worker.recovered

# Just the critical events (config reload failures, fatal stops, locks)
tradekit engine events --severity critical --since 30d

# Filter by worker for targeted debugging
tradekit engine events --worker orders --types worker.degraded

# Machine-driven
tradekit engine events --since 24h --json | jq '.events[] | select(.event_type=="worker.degraded")'
```

**Persisted event types** (8 total — heartbeats deliberately not persisted; high-cardinality, operators use `engine status` for liveness):

| Event type             | When                                                     | Severity                |
|------------------------|----------------------------------------------------------|-------------------------|
| `engine.started`       | supervisor boots (after lock acquired)                   | info                    |
| `engine.stopped`       | supervisor exits                                         | info / critical (fatal) |
| `engine.lock`          | operator engages iter28 kill switch                      | warn                    |
| `engine.unlock`        | operator releases iter28 kill switch                     | info                    |
| `worker.degraded`      | iter33 resilience: N consecutive failures crossed threshold | warn                    |
| `worker.recovered`     | iter33 resilience: first success after degraded streak    | info                    |
| `config.reloaded`      | iter35 SIGHUP succeeded                                  | matches preflight impact |
| `config.reload_failed` | iter35 SIGHUP found invalid config                       | critical                |

**Cross-reference with notifications.** Every `dedup_key` matches the corresponding iter28+ notification dedupKey. Operators pairing Slack history + DB rows can join by key.

**Sample output:**

```
$ tradekit engine events --since 24h

Engine events (8 rows, since 2026-05-30T14:00:00Z):
  2 critical · 3 warn · 3 info

  · 2026-05-30 14:00:00Z engine.started         pid=12345 workers=orders,schedules,reconcile,rebalance,alerts
  ⚠ 2026-05-30 16:30:00Z worker.degraded        [orders] consecutive=3 effective=60000ms
  · 2026-05-30 16:33:15Z worker.recovered       [orders] after=3 fails
  ⚠ 2026-05-30 18:00:00Z engine.lock            locked by cli: oracle outage investigation
  · 2026-05-30 19:30:00Z engine.unlock          unlocked by cli
  ✕ 2026-05-30 23:15:00Z config.reload_failed   Zod: safety.maxSlippageBps must be number
  ⚠ 2026-05-30 23:18:00Z config.reloaded        diff=5 critical=2 warn=1
  ✕ 2026-05-31 02:00:00Z engine.stopped         uptime=43200s fatal=RPC pool exhausted
```

The story tells itself end-to-end: the engine ran for 12h, hit a transient RPC degradation at 16:30 (recovered 3m later), operator manually locked at 18:00 to investigate an oracle issue, unlocked at 19:30, then made a config typo at 23:15 (the reload failed cleanly without affecting trading), fixed and reloaded at 23:18, and ultimately died 2h later from RPC pool exhaustion. Every step durably recorded.

**Timeline integration.** `tradekit timeline` (iter36) now reads engine events directly from this table instead of inferring from audit_log. The previous heuristic missed `worker.degraded` / `worker.recovered` / `config.reload*` entirely — these were notification-only. The unified timeline now surfaces them with exact data.

**Error-safe persistence.** Every constructor wraps `insertEngineEvent` in try/catch + `logger.warn`. A DB hiccup during `engine.stopped` write MUST NOT crash the supervisor's shutdown — notifications remain the synchronous-required path; the DB layer is the durable-but-best-effort companion.

**MCP** exposes `engine_events` with the same filter set. Agents driving autonomous incident response query the table once instead of orchestrating 4+ separate notification-history lookups.

**v1 limitations.**
- Heartbeats not persisted (high cardinality; use `engine status` for liveness).
- `engine_events` is intentionally scoped to *engine* events, not per-strategy domain. The per-strategy gap closed in v28: `alert.fired` / `alert.resolved` now persist to their own `alert_events` table (see *Strategy alerts*).
- No auto-prune — operator can call `pruneEngineEvents(beforeIso)` via `doctor` or a cron.

#### Price layer overhaul (iter38) — batch fetch + provider stats

Production scalability bottleneck: an operator running 5+ deployed strategies hits CoinGecko's free-tier rate limit (~30 req/min) because the orders engine's cache-cold tick made N independent HTTP calls for N distinct base tokens. iter38 collapses that to ONE batched call (CoinGecko's `/simple/price?ids=...,...` supports comma-separated batch — we just weren't using it) and adds per-provider observability so operators can debug rate-limit incidents instead of guessing.

```bash
# See where your API calls are going
tradekit price stats
tradekit price stats --json | jq '.providers[] | select(.lastErrorCode!=null)'

# Reset between monitoring scrapes
tradekit price stats --reset
```

**Three coordinated changes:**

1. **`getCurrentPrices(addresses, logger)`** — new batch entry point. Cache lookup → in-flight dedup → group by provider → ONE CoinGecko call per chunk of ≤250 tokens → parallel DexScreener fallback for the rest. Failed CoinGecko tokens auto-fall-back to DexScreener per-token. Single-token convenience `getCurrentPriceBatched` provided.

2. **Engine prefetch.** `runOrderTick` now calls `getCurrentPrices(distinctBaseTokens)` BEFORE iterating active orders. A tick with 15 distinct tokens is now ONE HTTP call instead of 15 sequential ones. The per-order loop reads from the warm cache.

3. **Per-provider stats** (`priceStats.ts`). Every call to CoinGecko / DexScreener records a `ProviderCall` (latency, ok flag, error code, tokens-requested vs tokens-returned). `tradekit price stats` surfaces them — calls, hit rate, latency p50/p95/max, last error per provider.

**Backward compatibility.** `getCurrentPrice(token, logger)` API unchanged — the legacy single-token path stays for every existing caller. Just both paths now record stats. The 60s success / 15s null TTL caches (iter132) are unchanged; both paths share them via the new `priceCacheShared.ts` module (no circular import).

**Sample stats output:**

```
Price provider stats (in-memory, since process start):

  coingecko
    Calls:    47  (45 ok, 2 fail = 4.3%)
    Tokens:   210 returned / 230 requested  (91.3% hit rate)
    Latency:  avg 312ms · p50 280 · p95 1100 · max 2500  (last 47 samples)
    Last err: HTTP_429 at 2026-05-31T14:32:00Z
    Window:   2026-05-31T10:00:00Z → 2026-05-31T14:35:00Z

  dexscreener
    Calls:    18  (18 ok, 0 fail = 0.0%)
    Tokens:   14 returned / 18 requested  (77.8% hit rate)
    Latency:  avg 180ms · p50 150 · p95 380 · max 500  (last 18 samples)
```

The operator with that snapshot sees: CoinGecko had 2 failures (one was the most recent — `HTTP_429` at 14:32 — confirming they're hitting the rate limit), hit rate is 91% (some tokens not on CoinGecko fell through to DexScreener), p95 latency 1.1s suggests the rate-limit window is throttling them. Actionable signal in one command.

**Error classification.** `classifyFetchError` maps unknown thrown errors to 8 known codes: `HTTP_429`, `HTTP_5xx`, `HTTP_4xx`, `TIMEOUT`, `NETWORK_ERROR`, `PARSE_ERROR`, `UNKNOWN_ERROR`. Checks both `Error.name` and `Error.message` so `SyntaxError` (which carries its discriminator in `name`) classifies as `PARSE_ERROR`.

**Resilience.** Stats are in-memory only and never block the price path. CoinGecko chunk failure → tokens fall back to DexScreener individually. DexScreener failure → null cached for 15s, next tick retries. A single bad chunk never poisons the rest of the tick.

**MCP** exposes `price_stats` with optional `reset: true` for monitoring scripts that want delta-since-last-scrape semantics.

**v1 limitations.**
- DexScreener has no batch endpoint — fallback stays per-token, parallelized via `Promise.allSettled`.
- Stats are in-memory only. Production deployments wanting historical telemetry should scrape `/metrics` (engine `--metrics-port`) or future-iter export to Prometheus.
- 250-token chunk cap on CoinGecko is a conservative URL-length guard; real limits are higher but 250 keeps the URL under 5KB.

#### Bulk operations (iter37) — scoped halt / resume

The middle ground between iter28 engine_lock (global kill — pauses EVERY trading path across every strategy) and per-primitive `order cancel` / `schedule pause` (too granular when you have a deployed strategy with 12 active primitives). During an incident response the operator wants to "halt everything tagged `dca-eth` while I investigate" — one command, atomic, one notification, with a preview before execution.

```bash
# Preview-then-confirm flow (the safest default)
tradekit bulk halt --strategy dca-eth                    # prints plan, prompts 'type halt to confirm'
tradekit bulk halt --strategy dca-eth --dry-run          # plan only, never mutates
tradekit bulk halt --strategy dca-eth --yes              # skip prompt (script-friendly)

# Filter by chain / account / multiple
tradekit bulk halt --chain arbitrum
tradekit bulk halt --account alice
tradekit bulk halt --strategy dca-eth --chain base --types orders

# Resume the reversible parts (cancelled orders are terminal — recreate via `order create`)
tradekit bulk resume --strategy dca-eth
tradekit bulk resume --strategy dca-eth --types schedules

# Machine-driven (JSON, auto-confirm)
tradekit bulk halt --strategy dca-eth --json | jq '.applied'
```

**Plan/execute split.** `bulk halt` is two phases — a pure planner that classifies every matching primitive into `cancel` / `pause` / `skip` (with reason), and an atomic executor that runs the classified plan inside a single DB transaction. The CLI renders the plan before prompting; `--dry-run` stops after the plan.

**Halt semantics:**

| Type        | Operation | Reversible? |
|-------------|-----------|-------------|
| orders      | cancel    | NO (terminal — must recreate) |
| schedules   | pause     | YES (`bulk resume`) |
| rebalances  | pause     | YES (`bulk resume`) |

Already-terminal primitives (filled orders, completed schedules) are classified as `skip` with a clear reason — operators see they weren't ignored.

**Scope is required.** Without `--strategy` / `--chain` / `--account` (or explicit `--all`), bulk halt refuses to run with `INVALID_PARAMS`. The unscoped case would touch every primitive across every account on every chain — too easy to misfire. The genuine global kill switch is `engine lock`.

**Atomic + audit-coherent.** All mutations run inside one `BEGIN/COMMIT`. Operators reading `audit_log` by timestamp see one bulk batch instead of N staggered rows. One bulk-level `bulk.halt` notification goes to Slack/Discord — not N per-primitive cancels. Per-row failures are collected (not thrown) so a mid-batch race doesn't undo the successful ops.

**Sample output:**

```
$ tradekit bulk halt --strategy dca-eth

Bulk halt plan: strategy=dca-eth

  Would affect 5 primitive(s):
    orders     to cancel: 3
    schedules  to pause:  1
    rebalances to pause:  1
  Skipped (already terminal): 2
    already filled: 2

  orders:
    ✕ cancel  #42    SELL 1 ETH/USDC  ≤ $1900       (active → cancel)
    ✕ cancel  #43    SELL 1 ETH/USDC  ≥ $3000       (active → cancel)
    ✕ cancel  #44    BUY 100 ETH/USDC trailing 5%   (active → cancel)
    · skip    #21    SELL 1 ETH/USDC  ≤ $1900       (already filled)
    · skip    #22    SELL 1 ETH/USDC  ≥ $3000       (already filled)
  schedules:
    ⏸ pause   #5     BUY 100 ETH/USDC  @ 0 10 * * *  (active → pause)
  rebalances:
    ⏸ pause   #2     rebal-q1 (4 targets, drift 5%)  (active → pause)

Type 'halt' to confirm halting 5 primitive(s): halt

Bulk halt: 5 applied, 2 skipped, 0 error(s).
```

**MCP** exposes `bulk_halt` + `bulk_resume` with the same filter set + `dryRun` parameter. Agents driving autonomous incident response (e.g. a watcher that triggers halt when iter32 alerts cross a threshold) get the same plan-then-execute safety semantics.

**Idempotent.** Running the same `bulk halt` twice in a row is safe — the second run sees every previously-affected row as already-terminal-or-paused, classifies them all as `skip`, and reports `0 applied, N skipped`.

#### Forensic timeline (iter36) — unified chronological event view

The third leg of the observability stool. iter31 strategy report answers "how is strategy X doing right now?" (state, per-strategy). iter32 strategy alerts answers "tell me when X goes wrong" (push, threshold). iter36 timeline answers "what happened between 13:55 and 14:05?" (time, cross-strategy).

```bash
# Default: last 4h, all events, newest-first
tradekit timeline

# Recent failures only
tradekit timeline --severity critical

# What broke in the last hour on Base?
tradekit timeline --since 1h --chain base --severity warn

# Incident triage during an alert burst
tradekit timeline --since 30m --kinds trade.failure,audit.error,alert.fired

# Per-strategy investigation
tradekit timeline --strategy dca-eth --since 1d

# Pipe-friendly
tradekit timeline --since 4h --json | jq '.events[] | select(.severity=="critical")'
```

**Event sources** — all merged into one chronological stream:

| Kind                | Source                                         | Severity heuristic                              |
|---------------------|------------------------------------------------|--------------------------------------------------|
| `trade.fill`        | `trades` where status=success                  | info                                             |
| `trade.failure`     | `trades` where status=failed/reverted          | critical                                         |
| `trade.pending`     | `trades` where status=pending                  | warn                                             |
| `paper.fill`        | `paper_trades`                                 | info                                             |
| `order.journal`     | `order_check_log` (firing decisions, errors)   | varies (error=critical, fired=warn, etc.)        |
| `order.edited`      | `order_check_log` decision="edited_by_operator"| info                                             |
| `schedule.journal`  | `schedule_check_log` (v29 — fires, failures, retirements, hooks) | fire_failed=critical, locked/hook_failed=warn, else info |
| `rebalance.journal` | `rebalance_check_log` (v29 — incl. in_band drift readings) | failed/partial=critical, fired/locked=warn, in_band=info |
| `audit.tool`        | `audit_log` rows without error_code            | warn for elevated tools (engine_lock, revoke, …) |
| `audit.error`       | `audit_log` rows with error_code set           | critical                                         |
| `alert.fired`       | `strategy_alert_state` first_triggered_at      | per-rule (drawdown_threshold=critical, …)        |
| `alert.resolved`    | `strategy_alert_state` last_evaluated_at       | info                                             |

**Smart filtering** — the iter25 `tracking_started` / `hwm_advanced` journal events (per-tick state machine breadcrumbs) are deliberately filtered OUT of timeline. A 4h window with a few trailing stops produces tens of those per order; they belong in `order replay <id>` (per-order forensic), not in cross-strategy timeline.

**Sample output:**

```
$ tradekit timeline --since 1h --severity warn

Timeline (8 events, since 1h ago):

  3 critical · 4 warn · 1 info

  ✕ 2026-05-31 14:02:15Z trade.failure    TRADE FAILED SELL 1 ETH: insufficient liquidity for SLIPPAGE 50bps
  ✕ 2026-05-31 14:01:55Z trade.failure    TRADE FAILED SELL 1 ETH: insufficient liquidity for SLIPPAGE 50bps
  ⚠ 2026-05-31 14:01:30Z alert.fired      ALERT FIRED dca-eth: success_rate_drop
  ⚠ 2026-05-31 14:00:45Z order.journal    ORDER #42 triggered_fired @ $2850 (HWM 3000, -5%)
  ✕ 2026-05-31 13:58:12Z audit.error      AUDIT trade: SLIPPAGE_EXCEEDED — slippage 850bps > cap 500bps
  ⚠ 2026-05-31 13:57:00Z audit.tool       AUDIT engine_lock (tx 0x…)
  ⚠ 2026-05-31 13:55:30Z order.journal    ORDER #51 near_threshold @ $2855
  · 2026-05-31 13:50:00Z order.edited     ORDER #42 edited by operator — {"trailPct":[3,5]}
```

The story tells itself: operator edited an order to widen the trail at 13:50, didn't help; near_threshold at 13:55 was the warning; engine_lock fired at 13:57 (likely operator response); a manual trade caught the cap at 13:58; the strategy went into success_rate_drop alert at 14:01 with two consecutive trade failures.

**Filter design.** Each filter passes through to the per-source SQL query so we don't bring every row into memory just to filter. Limit applies AFTER the global merge + sort, so `--limit 50` is the global newest-50 across all sources — not "50 from each source then truncate."

**Stable ordering.** Timestamp DESC, then kind name, then id DESC as tiebreakers. Same query at the same moment always returns rows in the same order — important for CI snapshot diffs and JSON-tail piping.

**MCP** exposes `timeline_query` with the same filter set. Agents investigating an incident make one MCP call instead of orchestrating 6+ separate queries — and they get back a uniformly-typed `TimelineEvent[]` that can drive autonomous remediation flows.

**v1 limitations — both since closed.**
- ~~`alert.resolved` detection is a heuristic~~ — v28 added the `alert_events` table: every fired/resolved transition is journaled at the moment the watcher emits the notification, so the timeline reads exact timestamps and full repeat history (an alert that fired+resolved 5 times shows all 10 transitions; the heuristic collapsed them to one of each). The state-row heuristic remains only as the fallback for windows that predate the migration.
- ~~Engine lock/unlock transitions surface via `audit_log`~~ — iter39 added the dedicated `engine_events` table.

#### Config hot-reload (iter35) — SIGHUP + impact preflight

Pre-iter35, every config change required a full engine restart — re-decrypting the keystore (the scrypt cost is real), losing in-flight tick state, briefly leaving trading unprotected. Unix daemons solved this in 1991 with `SIGHUP`. iter35 brings the same pattern to tradekit and pairs it with structured impact analysis that surfaces "this change breaks 23 active orders" BEFORE the operator hits enter.

```bash
# 1. Preflight before changing anything — does this break my running strategies?
tradekit config preflight --file ./new-config.json
tradekit config preflight --file ./new-config.json --strict --json  # CI gate

# 2. Make the change — the engine picks it up automatically via SIGHUP
tradekit config set safety.maxSlippageBps 200
# stderr: [engine: SIGHUP sent to pid 12345 — config reload in flight]

# 3. Force a reload manually (e.g. after editing the file by hand)
tradekit config reload
```

**Preflight rule coverage** (11 analyzers, each ~50 lines):

| Field                                              | Tightening detection       | Active-state impact                          |
|----------------------------------------------------|----------------------------|----------------------------------------------|
| `safety.maxSlippageBps`                            | lower number = tighter     | orders/schedules with `slippage_bps > new`   |
| `safety.perTxUsdLimit`, `dailyUsdLimit`            | lower = tighter            | warn-level (per-trade impact unknown until fire) |
| `safety.tokenBlacklist`                            | additions tighten          | primitives referencing blacklisted tokens     |
| `safety.tokenWhitelist`                            | enabling / removing tokens | primitives outside the whitelist              |
| `safety.strategyBudgets`                           | added rules / lower caps   | warn (consumption checked at trade time)      |
| `safety.drawdownCircuitBreaker.maxDrawdownPct`     | lower = tighter            | drawdown scopes already past new threshold    |
| `engine.workers.*.{enabled,intervalMs}`            | disable / interval changes | informational                                 |
| `safety.strategyAlerts.{enabled,rules}`            | disable / rule add/remove  | informational                                 |
| `engine.resilience.enabled`                        | disable = looser           | warn (backoff layer goes away)                |
| `defaultSlippageBps`                               | lower = tighter            | informational (only affects new trades)       |

Each warning carries a severity:
- **critical** — current state violates new rules; operator MUST act
- **warn** — future fires might block
- **info** — observable but harmless

```
$ tradekit config preflight --file ./tighter.json
Config preflight: 5 change(s).
  2 critical · 1 warn · 2 info
  Affected primitives: 3 order(s), 1 schedule(s)

Diffs:
  [tightened] safety.maxSlippageBps  500 → 200
  [added    ] safety.perTxUsdLimit   null → 500
  [tightened] safety.strategyBudgets[playbook:1]  ...
  [changed  ] engine.workers.orders.intervalMs  30000 → 60000
  [tightened] safety.tokenBlacklist  +1 token

Warnings:
  ✕ [critical] safety.maxSlippageBps tightened 500 → 200; 3 active primitive(s) carry a higher per-row slippage and will block on next fire.
      → order #42: slippage_bps=300 exceeds new cap 200
      → order #51: slippage_bps=400 exceeds new cap 200
      → schedule #7: slippage_bps=250 exceeds new cap 200
  ✕ [critical] 1 token added to safety.tokenBlacklist; 1 active primitive references it.
      → order #88: references blacklisted token
  ⚠ [warn] safety.perTxUsdLimit added at $500. Trades estimated above this will block.
  · [info] safety.strategyBudgets[playbook:1] tightened: lifetimeUsd $5000 → $3000.
  · [info] Engine worker "orders" interval 30s → 60s.
```

**Hot-reload flow** (what happens on SIGHUP):
1. `loadConfig()` re-reads `~/.tradekit/config.json` from disk.
2. `configSchema.parse()` validates the new shape. Parse failure → `config.reload_failed` notification (critical) emitted, OLD config retained, supervisor keeps running on it. No silent fallback.
3. `computeConfigImpact()` runs against the active state — the same code path as `config preflight`.
4. `ConfigRef.set(newConfig)` atomically swaps. Workers reading on the next tick see the new config; in-flight ticks finish on the old config.
5. `config.reloaded` notification emitted with severity matching the highest preflight warning + a body summarizing critical/warn warnings.

**Auto-kick on mutation.** `tradekit config set / push / drop` automatically sends `SIGHUP` to the running engine after the disk write. No-op when no engine is running. The operator never has to remember to restart.

**Race-safe by construction.** `ConfigRef` is a single-writer container; the SIGHUP handler is the only writer; workers are read-only. Mid-tick consistency: each `worker.tick()` reads the config once at the top and uses it throughout. A reload mid-tick is invisible — that tick uses fully-old config; the NEXT tick uses fully-new config. No half-swap.

**Atomic.** Validation happens BEFORE the swap. A malformed config never replaces the running config — it stays at the previous valid state with a `config.reload_failed` warning.

**MCP** exposes `config_preflight` (an inline-`proposed` shape with optional `merge` flag for partial overlays). Agents adjusting safety parameters programmatically can preflight before writing to disk. `config_reload` is deliberately NOT exposed — cross-process signals are a host privilege; agents trigger reload by writing the file and calling the host's CLI.

#### In-place edit (iter34) — modify orders + schedules without losing state

Pre-iter34, adjusting a deployed primitive meant `cancel` + `create` — losing trailing HWM, attempt counter, schedule run_count, journal continuity. For trailing stops this hurts: the HWM has been tracking for hours/days and gets thrown away because the operator wanted to tighten the trail by 2 points. iter34 adds in-place edit that preserves all engine-managed state.

```bash
# Tighten a trailing stop's retracement — HWM is preserved
tradekit order edit 42 --trail-pct 7

# Change DCA cadence; run_count + total_base_filled survive
tradekit schedule edit 5 --every 12h

# Extend an order's expiry
tradekit order edit 42 --expires-in 30d

# Switch a schedule to paper mode for a few cycles
tradekit schedule edit 5 --paper true

# Bulk parameter tune via JSON
tradekit order edit 42 --slippage-bps 75 --note "tightened after volatility spike"
tradekit order edit 42 --json
```

**State preservation invariant.** The DB UPDATE statement only touches the operator-editable column subset. Engine-managed columns (`water_mark_usd`, `attempts`, `last_checked_at`, `last_checked_price`, fill data) are NEVER in the SET clause. Two writers, zero column overlap, zero race window.

**Editable vs frozen.**

| Editable                                                              | Frozen (cancel+create instead)         |
|-----------------------------------------------------------------------|-----------------------------------------|
| target_price, trail_pct, base/quote amount, slippage, auto-slippage   | side, chain, account                    |
| expires_at, strategy, note, paper                                     | base/quote token, trigger type          |
| (schedule) cron/every, end_at, max_runs, on_fill spec                 | (schedule) start_at, OCO group          |

**Cron edit auto-recomputes next_run_at.** The operator's intent is "fire on the next natural occurrence of the new cron" — preserving the old next_run_at (computed against the OLD cron) would be stale.

**max_runs cannot be lowered below run_count.** Pushing a schedule into "already past the cap" would orphan it. Set max_runs equal to run_count to retire after the next fire instead.

**Atomic + race-safe.** The UPDATE is guarded on `status='active'` (orders) or `status IN ('active','paused')` (schedules). If a concurrent engine tick has already flipped the row to filled/failed/expired between fetch and write, the edit aborts with a clear `INVALID_PARAMS` reporting the current status. No silent overwrites.

**Forensic journal continuity.** Every successful edit appends an `order_check_log` entry with `decision="edited_by_operator"` and the JSON-encoded field diff. When the order eventually fires, `tradekit order replay <id>` shows operator edits inline with engine ticks — full lifecycle history.

```
$ tradekit order replay 42
 ✓ 2026-05-20T14:00:00Z  tracking_started  HWM seeded @ $2450
 ⚙ 2026-05-21T03:15:00Z  hwm_advanced       HWM → $2500
 ✎ 2026-05-22T09:30:00Z  edited_by_operator {"trailPct":[5,7]}
 ⚙ 2026-05-23T14:20:00Z  hwm_advanced       HWM → $2620
 🔥 2026-05-25T08:45:00Z  triggered_fired    @ $2436 (HWM 2620, -7%)
```

**No-op edits are free.** Pass the same value that's already stored: empty diff → no journal write, no `updated_at` bump. Idempotent retry is cheap.

**MCP** exposes `order_edit` + `schedule_edit` with the same field contract. Agents iterating on a strategy (e.g. an autotuner adjusting slippage based on recent realized stats) get the same state-preserving semantics one-shot.

#### Engine resilience (iter33) — backoff, tick timing, alerts as a worker

Production daemons fail in characteristic ways: an RPC dies for an hour, a price oracle rate-limits, a chain reorgs. Pre-iter33 the engine kept hammering at base interval — wasted load, notification storms, no visibility into "is this worker getting slower over time?". Iter33 closes that gap with three coordinated improvements.

**Alerts as a first-class worker.** The iter32 strategy-alerts watcher is now built into `tradekit engine run`. No more sidecar process to manage. Read-only worker (no wallet password needed when running `--workers alerts` alone).

```bash
# Single process now does orders + schedules + reconcile + rebalance + alerts:
tradekit engine run

# Subset for a specific deployment shape:
tradekit engine run --workers orders,alerts          # only orders + alerts
tradekit engine run --workers alerts --dry-run        # alerts-only daemon (no password needed)
```

**Per-worker exponential backoff.** When a worker accumulates `thresholdFailures` consecutive failures (default 3), its effective tick interval grows geometrically — `interval × backoffMultiplier` each subsequent failure, capped at `maxBackoffMs` (default 10 min). On the first success: full reset to base interval. Each transition emits a structured notification:

- `engine.worker.degraded` (warn) — first time crossing into backoff. Fields include the consecutive-failure count, the new effective interval, the last error.
- `engine.worker.recovered` (info) — first success after a degraded streak. Fields include how many failures preceded recovery.

Notifications are deduplicated per-worker so a long backoff doesn't spam Slack.

**Sliding-window tick timing.** Every tick's duration is recorded in a bounded ring buffer (default last 20). `engine status` surfaces `avg / p50 / p95 / max` per worker:

```
Engine ● RUNNING
  pid: 12345    started: 2026-05-31T10:00:00Z  (uptime 4h)
  status file last updated: 2s ago

Workers (5):
  ● orders     interval=30s  ticks=480  ok=478  fail=2 (0.4%)  last=2s ago  next=in 28s
    tick time: avg 180ms · p50 165 · p95 410 · max 920
  ● schedules  interval=60s  ticks=240  ok=240  fail=0 (0.0%)  last=12s ago  next=in 48s
    tick time: avg 45ms · p50 40 · p95 90 · max 180
  ⚠ reconcile  interval=60s  ticks=240  ok=235  fail=5 (2.1%)  last=4s ago  next=in 8m
    BACKOFF: 5 consecutive failures → effective interval 480s
    tick time: avg 2.3s · p50 1.8s · p95 5.1s · max 9.4s
  ● rebalance  interval=300s  ticks=48  ok=48  fail=0 (0.0%)  last=2m ago  next=in 3m
    tick time: avg 1.2s · p50 1.1s · p95 1.8s · max 2.4s
  ● alerts     interval=300s  ticks=48  ok=48  fail=0 (0.0%)  last=2m ago  next=in 3m
    tick time: avg 110ms · p50 100 · p95 180 · max 240
```

**Configuration** lives at `engine.resilience` in `~/.tradekit/config.json`:

```json
{
  "engine": {
    "resilience": {
      "enabled": true,
      "thresholdFailures": 3,
      "backoffMultiplier": 2,
      "maxBackoffMs": 600000,
      "tickTimingWindow": 20
    }
  }
}
```

**Defaults are deliberately conservative.** Three consecutive failures before backoff kicks in (a single RPC blip won't trip the alarm). 2× multiplier (familiar exponential pattern). 10-minute cap (operators investigating an incident still want some signal, not a worker that's fully off).

**Invariants:**
- The multiplier itself is capped at `maxBackoffMs / baseIntervalMs` so it never grows unbounded after the effective interval has hit the cap. Without this, `still_active` transitions would emit notifications forever as the multiplier kept growing past the visible cap.
- The alerts worker reports `ok=true` when its tick completes without throwing — *firing an alert IS the successful outcome*. Using `ok=!alertsFired` would degrade the alerts worker the moment a real alert fired, which is exactly when the operator needs it most.

**JSON output** (`engine status --json`) surfaces every new field unmodified — Prometheus scrapes and dashboards get full visibility without parsing prose.

#### Paper trading (iter30)

Validate a strategy against **real-time** market conditions (live prices, real volatility, real triggers firing) **without** risking real capital. Bridges the gap between historical backtests (`tradekit backtest` — past data, may miss regime changes) and live deployment (real money). Same engine, same triggers, same notifications — only the FIRE step writes to a virtual book instead of submitting an on-chain transaction.

```bash
# 1. Seed the virtual book (paper buys enforce virtual balance)
tradekit paper deposit --chain base --token USDC --amount 10000

# 2. Deploy a playbook in paper mode
tradekit playbook deploy ./eth-strategy.json --paper

# 3. Run the engine as usual — paper orders/schedules tick alongside real ones
tradekit engine run --once

# 4. Inspect paper fills + P&L
tradekit paper trades
tradekit paper balances
tradekit paper pnl          # realized only (deterministic)
tradekit paper pnl --mtm    # + open positions marked at current prices

# 5. If the strategy looks good, PROMOTE it to real trading IN PLACE —
#    trailing HWM, run counters, and drift telemetry all survive
#    (destroy + redeploy would reset exactly the state the paper run built).
tradekit playbook promote 1
```

**Promote / demote.** `playbook promote <id>` flips every live primitive between paper and real through the same in-place edit machinery as `order edit` / `schedule edit` / `rebalance edit`: a trailing stop that tracked a $3,500 HWM in paper keeps protecting from $3,500 the moment it's real, and the flip lands an `edited_by_operator` row in the order journal. `--to paper` demotes a live strategy back to the sandbox (e.g. after a config scare) — symmetric, state-preserving. Terminal primitives are skipped with reasons; promotion to real requires interactive confirmation (or `--yes`). **Funding preflight (v36).** Before the flip, the promote asks the runway machinery the only question that matters at this moment: *if these primitives were real right now, could the actual wallet fund them?* Paper primitives are bucketed as-if-real (`assumeReal`), spend tokens AND the gas estimate are checked against on-chain balances, and findings print worst-first: `✗ USDC cannot fund even ONE fire` / `⚠ covers 3/4 fires — runs out ~Jul 6` / `gas: no trade history`. Advisory by default — `--require-funded` (MCP `requireFunded: true`, strongly recommended for agent-driven promotes) aborts with `INSUFFICIENT_BALANCE` on a cannot-fund-one-fire finding. Honesty rule: a dead RPC reports `balance UNKNOWN` and warns but never blocks (an outage must not gate a promote the operator wants); `--skip-preflight` disables entirely. MCP: `playbook_promote` with `yes: true` returns the preflight in the result.

**Per-primitive flag.** `--paper` is also available on `order create` / `schedule create` / `rebalance create` for one-off paper primitives. `playbook deploy --paper` cascades the flag across every order/schedule/rebalance entry in the spec.

**What's identical to real mode.** Trigger predicates, trailing watermarks, OCO cascade, schedule cron / `next_run_at` advancement, post-fill hooks, notifications, engine lock (`tradekit engine lock` halts paper too), error codes (transient vs terminal classification). A failing paper trade emits `order.failed` / `schedule.failed` notifications using the same dedupKey pattern as real failures — operator workflow is unchanged.

**What's different (deliberately).**
- **No keystore decryption.** Paper orders use the read-only wallet path; a paper-only deployment can run without ever loading the encrypted private key.
- **Skips capital-tracking safety rails.** Drawdown circuit breaker, strategy budgets, daily USD caps, position limits — all skipped. These track *real* capital; paper trades shouldn't deplete real budgets. Engine lock IS still honored.
- **Worst-case slippage model.** `spot × (1 ± slippageBps/10000)` in the trader-unfavorable direction. Real fills sometimes BEAT spot (router finds a better route); pessimistic accounting tells operators how the strategy performs when liquidity works against them — the answer that matters for risk sizing.
- **Synthetic tx hash.** Format: `paper:<id>:<timestamp>`. The `paper:` prefix breaks every explorer-link helper's `0x..` assumption, so nothing tries to view a paper "tx" on Etherscan.
- **No gas.** Paper trades are gas-free. Strategies that are only profitable when gas is cheap should still validate against historical gas via `tradekit backtest`.

**Virtual book schema.** Two new tables (v24 migration):
- `paper_trades` — mirrors the `trades` shape; carries `source_type` (order / schedule / rebalance / manual) + `source_id` for attribution. Indexed on `(strategy, timestamp)` so per-strategy queries stay fast.
- `paper_balances` — per `(account, chain, token)` running virtual balance. `paper deposit` writes here; `executePaperTrade` reads + atomically updates.

**Pre-existing primitives are unaffected.** The v24 migration adds a `paper INTEGER NOT NULL DEFAULT 0` column to `orders` and `schedules` (v27 extends it to `rebalance_plans`). Every pre-existing row keeps `paper=0` and runs through the unchanged real-trading path.

**Rebalance plans are paper-aware too (v27).** `rebalance create --paper true` registers a plan whose drift is evaluated against the VIRTUAL book — `paper balances` IS the portfolio, not the on-chain wallet. Corrective legs fire through `executePaperTrade` and fill back into the same virtual book, which is what makes the plan converge: after a correction lands, the next tick re-reads the (now-corrected) book and sees drift back inside the threshold. `playbook deploy --paper` with a rebalance entry in the spec cascades the flag the same way it does for orders/schedules — the pre-v27 fail-fast INVALID_PARAMS is gone. Seed the book with `paper deposit` first; an empty virtual book is an empty-portfolio skip, not an error. Paper plans use the read-only wallet path (no keystore decryption) and their fills land in `paper_trades` with `source_type='rebalance'`.

**Realized trajectory (v31).** Every MTM summary also carries `realizedTimeline` — one cumulative point per realizing sell, fully deterministic (no marks involved). The CLI renders it as a sparkline (`▁▂▄▆█`) in `paper pnl --mtm` and the strategy report's valuation section: the same +\$500 total reads completely differently as a steady climb vs a spike-and-give-back, and now you can see which one you have.

**Mark-to-market is opt-in (`--mtm`).** By default `paper pnl` reports REALIZED P&L only (sum of quote received − quote spent) — a deterministic, pure function of the fill journal that scripted consumers can diff across runs. `paper pnl --mtm` (or `mtm: true` on the MCP `paper_pnl` tool) adds the full mark-to-market view: positions are rebuilt from the journal with the SAME weighted-average cost-basis model the real-trade `pnl` report uses, then open positions are marked at current oracle prices — realized, unrealized, total, open value, and per-position detail. One memoized oracle call per distinct held token; the native sentinel prices via the chain's WETH (same convention as paper rebalance drift).

Two accounting rules worth knowing:
- **Deposits are capital, not P&L.** `paper deposit` writes a balance with no journal row, so deposit-seeded inventory has no cost basis. Selling it realizes *nothing* — the proceeds are reported separately per position (`untrackedSellBase` / `untrackedSellQuote`) instead of inflating realized P&L. Same stance a brokerage statement takes.
- **Only stablecoin-quoted fills enter cost basis.** A volatile-quote fill (e.g. PEPE/WETH) has no USD anchor at trade time; such fills still count in the cash-flow fields but are excluded from cost basis and surfaced via `skippedNonStableQuote` — exactly the rule the real-trade pnl report applies.

#### Templating (iter21)

Playbook files can be parameterized with `{{NAME}}` substitutions. ONE template covers many deployments — operators stop maintaining N near-identical files for the "same pattern on different assets / thresholds / wallets".

```json
{
  "name": "{{ASSET}}-bracket-dca",
  "description": "trailing + bracket + DCA for {{ASSET}}",
  "chain": "base",
  "vars": {
    "ASSET":       { "type": "string", "required": true, "description": "Base token symbol" },
    "QUOTE":       { "type": "string", "default": "USDC" },
    "TRAIL_PCT":   { "type": "number", "default": 5 },
    "TP_PRICE":    { "type": "number", "required": true },
    "SL_PRICE":    { "type": "number", "required": true },
    "BASE_AMOUNT": { "type": "number", "required": true },
    "DCA_USD":     { "type": "number", "default": 100 }
  },
  "strategies": [
    { "id": "trail", "type": "order", "side": "sell", "trigger": "trailing",
      "trailPct": "{{TRAIL_PCT}}", "baseAmount": "{{BASE_AMOUNT}}",
      "base": "{{ASSET}}", "quote": "{{QUOTE}}" },
    { "id": "tp", "type": "order", "side": "sell", "trigger": "price_above",
      "price": "{{TP_PRICE}}", "baseAmount": "{{BASE_AMOUNT}}",
      "base": "{{ASSET}}", "quote": "{{QUOTE}}", "group": "bracket" },
    { "id": "sl", "type": "order", "side": "sell", "trigger": "price_below",
      "price": "{{SL_PRICE}}", "baseAmount": "{{BASE_AMOUNT}}",
      "base": "{{ASSET}}", "quote": "{{QUOTE}}", "group": "bracket" },
    { "id": "dca", "type": "schedule", "side": "buy", "every": "7d",
      "quoteAmount": "{{DCA_USD}}", "base": "{{ASSET}}", "quote": "{{QUOTE}}" }
  ]
}
```

Deploy variants with `--var NAME=VALUE` (repeatable) or `--vars-file PATH` (JSON object):

```bash
# Inline vars for an ETH deployment
tradekit playbook deploy ./asset-bracket.tmpl.json \
  --var ASSET=ETH --var TP_PRICE=4000 --var SL_PRICE=2700 --var BASE_AMOUNT=1

# WBTC variant from a vars file
echo '{"ASSET":"WBTC","TP_PRICE":130000,"SL_PRICE":80000,"BASE_AMOUNT":0.1}' > wbtc.vars.json
tradekit playbook deploy ./asset-bracket.tmpl.json --vars-file wbtc.vars.json

# Override one var on top of a vars file (precedence: --var > --vars-file > default)
tradekit playbook deploy ./asset-bracket.tmpl.json --vars-file wbtc.vars.json --var DCA_USD=250

# Backtest the same template against historical prices
tradekit backtest playbook ./asset-bracket.tmpl.json \
  --balance '{"ETH":1,"USDC":3000}' --since 30d \
  --var ASSET=ETH --var TP_PRICE=4000 --var SL_PRICE=2700 --var BASE_AMOUNT=1
```

**Type-aware substitution.** `"trailPct": "{{TRAIL_PCT}}"` (whole-field placeholder) renders to `"trailPct": 5` (number), not `"trailPct": "5"` (string the parser would reject). `"name": "{{ASSET}}-bracket"` (embedded placeholder) renders to `"name": "WBTC-bracket"` via String() coercion. Different policies because JSON strings are strings — without whole-field type preservation, every numeric template variable would need wrapping logic the parser rejects.

**Validation pipeline.**
1. `--vars-file` JSON parses; non-object content errors.
2. `--var NAME=VALUE` flags parse; non-uppercase / bad-syntax names error.
3. Merge precedence: defaults < `--vars-file` < `--var`.
4. Coerce string-typed values (always strings from CLI) to declared types (`"5"` → `5` for number-typed vars).
5. Resolve: required vars without a value error; type mismatches error; undeclared vars become warnings (typo-catching).
6. Render: walks the JSON tree, substitutes; unknown var references error with the JSON path (`strategies[2].baseAmount: references undefined variable "AMOUNT"`).
7. Output passes to `parsePlaybookSpec` — structurally identical to a hand-written v1 playbook.

Errors collect into one message — operators fix all template problems in one pass, same UX as the playbook + safety validators.

**Backward compat.** Playbooks without `vars` AND without `{{...}}` substitutions skip rendering entirely. Existing v1 files work unchanged. `--var` / `--vars-file` supplied for a non-template file is an explicit error (operator probably meant to use a template).

**`playbook validate` shows resolved vars.** Useful in CI: parse the template, render with placeholder vars, validate the output — fails fast on template / spec errors without touching the DB.

### Backtesting (historical strategy simulation)

Replays a single order or schedule against a CoinGecko historical price series + a starting balance. Tells you exactly **when your strategy would have fired**, at what price, and what cumulative PnL it would have produced — without deploying real money. The same trigger predicates the live engine uses (`isOrderTriggered`, `evaluateTrailingTrigger`, `matchesAt`) drive the simulation, so backtest behavior matches production behavior by construction.

```bash
# A 5% trailing-stop sell on 1 ETH over the past 30 days, starting from 1 ETH + 0 USDC.
tradekit backtest order \
  --chain base --base ETH --quote USDC \
  --side sell --trigger trailing --trail-pct 5 \
  --baseAmount 1 \
  --balance '{"ETH":1,"USDC":0}' \
  --since 30d

# A weekly $100 ETH DCA over the past 6 months, starting from 3000 USDC.
tradekit backtest schedule \
  --chain base --base ETH --quote USDC \
  --side buy --every 7d --quoteAmount 100 \
  --balance '{"USDC":3000}' \
  --since 6m

# Multi-asset: would 60/40 ETH/USDC with a 5% drift threshold have beaten
# HODL over the past year — and how many corrections would it have fired?
tradekit backtest rebalance \
  --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]' \
  --drift-threshold 5 --every 6h --since 365d

tradekit backtest list                   # recent runs, newest first
tradekit backtest show 7                 # full detail with fire timeline
```

**Rebalance backtest (multi-asset).** The single-pair simulators can't model a target-weight plan, so `backtest rebalance` gets its own engine: one CoinGecko series per target token (recognized stablecoins synthesize a flat $1 series instead of burning an API call), evaluation at the cron's occurrences with at-or-before price lookups (robust to misaligned sample timestamps), and the live engine's leg mechanics — sells fund the quote anchor first, buys draw from it, per-leg `minTradeUsd` skip, and anchor shortfalls CLAMP rather than mint money. The default starting book is `--initial-usd` (default $10k) split at target weights at window-start prices, which makes `PnL − hold-PnL` the pure **rebalancing alpha**: typically negative in trending markets (rebalancing sells winners early), positive in mean-reverting chop (it systematically buys dips). Optional `--slippage-bps` applies the paper-trading worst-case model per leg to stress the alpha against execution costs.

**Parameter sweep.** The follow-up question — *which threshold / cadence is best for this pair?* — is a grid run away: any `--sweep-thresholds 1,3,5,10` / `--sweep-cadences 1h,6h,1d` / `--sweep-min-trades 10,100` flag re-runs the pure simulator for every combination over the SAME fetched series (zero extra CoinGecko calls), ranks the variants by PnL with a ★ winner, and persists each variant as a `backtest_runs` row plus the grid as one `backtest_comparisons` row — `tradekit backtest compare show <id>` re-renders the table later, and the MCP `backtest_rebalance` tool takes the same `sweep_*` arrays. Capped at 60 variants per grid.

**What you get.** Strategy PnL + a counterfactual `hold` PnL (what your starting balance would be worth if you'd done nothing), plus the timeline of every simulated fire with timestamp, price, and balance delta. The `--json` output is the same shape the persisted row deserializes into, so `backtest show <id>` returns the same data structure as the original run.

**Resolution.** Tied to CoinGecko's free-tier `market_chart` endpoint: ≤1 day → 5-minute samples, ≤90 days → hourly samples, >90 days → daily samples. A trailing-stop with sub-hourly retracements isn't accurately testable beyond 90 days; daily-cadence strategies (DCA, weekly rebalance) work cleanly over multi-year windows.

**What's NOT simulated.** Gas cost, slippage, MEV impact, safety guardrails. The data resolution doesn't support pool-impact modeling, and operators want to know "would the trigger have fired" — guardrails would mask that signal. The strategy spec is what you validate; the live engine adds the production behaviors on top.

**Persisted to `backtest_runs`.** Every run gets an id (visible via `backtest list`). The strategy spec, balances, fire timeline, window, and counterfactual all persist so `backtest show <id>` re-renders without re-fetching CoinGecko data.

**Multi-strategy backtest (`backtest playbook`).** Replays a full [playbook](#playbooks-declarative-strategy-bundles) (multiple orders + schedules) against one shared price series with a shared simulated balance. The simulator handles cross-strategy interactions that single-strategy mode can't:

```bash
tradekit backtest playbook ./eth-strategy.json \
  --balance '{"ETH":2,"USDC":1000}' \
  --since 30d
```

OCO cascade fires DURING simulation — when a peer fills (e.g. TP triggers), other active peers in the same group flip to `cancelled` and don't fire on subsequent ticks. Shared balance is sequential: an order filling at hour 5 reduces the USDC available for a schedule that fires at hour 5 in the same tick (orders evaluate before schedules each tick — matches the live engine). A strategy that halts on insufficient balance is parked as `cancelled` so the rest of the bundle continues evaluating.

**Per-strategy breakdown.** The output shows each strategy's `finalStatus` (`filled` / `cancelled` / `completed` / `active`), fire count, and cumulative base/quote delta — answering "which leg of my bracket actually carried the trade" and "did the DCA budget survive the trailing stop's exit".

**Constraints (v1).** Every order/schedule in the playbook must reference the same base/quote pair (one price series). Rebalance plans are unsupported (intrinsically multi-asset). The validator names every violation in one error message + points at the single-strategy `backtest order` / `backtest schedule` commands as a fallback for components you want to inspect in isolation.

#### Multi-scenario comparison (iter22)

The direct payoff of [templating](#templating-iter21). When operators have a parameterizable playbook, the natural next workflow is **parameter sweeping** — backtest the same template with multiple variable bags and pick the winner. `backtest compare` runs all scenarios against one shared price series + a fresh balance per scenario and surfaces a comparison table:

```json
// trail-sweep.json
{
  "name": "trail-pct-sweep",
  "scenarios": [
    { "name": "5pct",  "file": "./trail.tmpl.json", "vars": { "TRAIL_PCT": 5,  "BASE_AMOUNT": 1, "ASSET": "ETH" } },
    { "name": "10pct", "file": "./trail.tmpl.json", "vars": { "TRAIL_PCT": 10, "BASE_AMOUNT": 1, "ASSET": "ETH" } },
    { "name": "15pct", "file": "./trail.tmpl.json", "vars": { "TRAIL_PCT": 15, "BASE_AMOUNT": 1, "ASSET": "ETH" } }
  ]
}
```

```bash
tradekit backtest compare ./trail-sweep.json \
  --balance '{"ETH":1,"USDC":0}' --since 60d

tradekit backtest compare list                # recent comparisons
tradekit backtest compare show 3              # re-render stored comparison
```

Output:

```
Backtest comparison #3 "trail-pct-sweep"
  Window:        2026-03-31T... → 2026-05-30T...
  Datapoints:    1440 (CoinGecko base)
  Pair:          ETH/USDC
  Scenarios:     3

  NAME                     PNL       VS HOLD  FIRES   FINAL USD   RUN  WINNER
  ----------------------------------------------------------------------------
  5pct                  +$245.18    +$520.18      1   $2245.18    #14   ★
  10pct                 +$180.42    +$455.42      1   $2180.42    #15
  15pct                  -$74.91    +$199.91      1   $2074.91    #16

  HOLD (no trades)       -$275.00          —      0   $2275.00     —

Winner: 5pct  (PnL +$245.18, +$520.18 vs hold, run #14)
```

**Winner semantics.** Highest PnL among scenarios that fired at least one fill. The `vs hold` column makes the comparison vs. doing-nothing visible — a "winner" that still underperforms hold is clearly marked. When every scenario halts before any fill, the runner reports "No winner" (forcing a misleading pick would be worse than admitting no data).

**Same-pair invariant.** Every scenario must reference the same `base/quote` pair across its non-rebalance strategies. Comparison happens against one price series; mixed-pair scenarios surface upfront with a structured error pointing at running independent comparisons per pair. Rebalance plans are intrinsically multi-asset and don't fit the shared-series comparison — use the dedicated `tradekit backtest rebalance` instead.

**Persistence.** Each scenario writes a regular `backtest_runs` row so `tradekit backtest show <run_id>` works on individual scenarios. The comparison summary lives in v20 `backtest_comparisons` linking those rows by id list, so `backtest compare show <id>` re-renders without re-running simulations OR re-fetching CoinGecko data.

**Scope limits.** v1 caps comparisons at 50 scenarios per file (split larger sweeps into multiple files). Relative `file` paths in scenarios.json resolve against the scenarios file's directory — `./trail.tmpl.json` means "next to scenarios.json", not "wherever the CLI runs from".

### Metrics (Prometheus / observability)

The single most-asked-for production capability: structured numerical metrics on a scrapable endpoint. `tradekit` exposes the canonical Prometheus text exposition format (version 0.0.4) — every major scraper consumes it: Prometheus, VictoriaMetrics, Grafana Cloud, Datadog Agent, OpenTelemetry Collector, etc.

**Three delivery surfaces** that all share the same core:

```bash
# 1. One-shot CLI — cron + node_exporter textfile collector
* * * * *  tradekit metrics > /var/lib/node_exporter/textfile_collector/tradekit.prom

# 2. Web server route — live scraping (when `tradekit web` is running)
curl http://127.0.0.1:3030/metrics
curl http://127.0.0.1:3030/healthz    # load-balancer probe

# 3. Engine standalone listener — single-process production deployment
tradekit engine run --metrics-port 9090
curl http://127.0.0.1:9090/metrics
```

Sample output:

```
# HELP tradekit_engine_running 1 when the engine supervisor is alive (pid alive + not stopping), else 0.
# TYPE tradekit_engine_running gauge
tradekit_engine_running 1
# HELP tradekit_engine_worker_last_tick_seconds_ago Seconds since each worker's most recent tick; -1 when never ticked. Use `> N` for stalled-worker alerts.
# TYPE tradekit_engine_worker_last_tick_seconds_ago gauge
tradekit_engine_worker_last_tick_seconds_ago{worker="orders"} 12
tradekit_engine_worker_last_tick_seconds_ago{worker="schedules"} 47
tradekit_engine_worker_last_tick_seconds_ago{worker="reconcile"} 47
tradekit_engine_worker_last_tick_seconds_ago{worker="rebalance"} 134
# HELP tradekit_orders_total Total conditional orders persisted, labeled by status.
# TYPE tradekit_orders_total counter
tradekit_orders_total{status="active"} 8
tradekit_orders_total{status="filled"} 23
tradekit_orders_total{status="cancelled"} 4
tradekit_orders_total{status="expired"} 1
tradekit_orders_total{status="failed"} 2
# HELP tradekit_trades_total Total trades persisted, labeled by chain + status (success/failed/pending).
# TYPE tradekit_trades_total counter
tradekit_trades_total{chain="base",status="success"} 41
tradekit_trades_total{chain="base",status="pending"} 1
tradekit_trades_total{chain="arbitrum",status="success"} 7
# ... more families ...
```

**Metric inventory:**

| Family | Type | Cardinality | Use |
|---|---|---|---|
| `tradekit_build_info{version,node}` | info (= gauge 1) | 1 | Version label join |
| `tradekit_trades_total{chain,status}` | counter | chain × status | Trade volume / failure rate |
| `tradekit_pending_trades` | gauge | 1 | Stuck-tx alerting |
| `tradekit_orders_total{status}` | counter | 5 | Order pipeline state |
| `tradekit_schedules_total{status}` | counter | 4 | DCA pipeline state |
| `tradekit_schedule_fires_total` | counter | 1 | DCA throughput |
| `tradekit_rebalance_plans_total{status}` | counter | 4 | Rebalance pipeline state |
| `tradekit_rebalance_runs_total` | counter | 1 | Rebalance throughput |
| `tradekit_audit_rows_total{result}` | counter | 2 (ok/err) | Overall activity rate |
| `tradekit_audit_errors_total{error_code}` | counter | ≤21 (top-20 + other) | Error-code breakdown |
| `tradekit_engine_running` | gauge | 1 | Liveness alert |
| `tradekit_engine_uptime_seconds` | gauge | 1 | Restart detection |
| `tradekit_engine_worker_ticks_total{worker}` | counter | 4 workers | Tick rate |
| `tradekit_engine_worker_failures_total{worker}` | counter | 4 workers | Worker-specific failures |
| `tradekit_engine_worker_last_tick_seconds_ago{worker}` | gauge | 4 workers | Stalled-worker alert (`> threshold`) |

**Cardinality discipline.** Every label is a bounded enum. Chains and statuses are small finite sets; worker names are 4 fixed strings; the top-20-cap on error codes prevents a runaway agent generating distinct codes from blowing up the time-series index. **No wallet addresses, USD values, token amounts, strategy tags, or account labels are ever exposed as labels** — those would either bloat cardinality (unbounded sets) or leak operator info to anyone scraping.

**Production alerting examples:**

```promql
# Engine is dead OR draining
tradekit_engine_running == 0

# A worker hasn't ticked in 5 minutes
tradekit_engine_worker_last_tick_seconds_ago > 300

# Trade failure rate spiking
rate(tradekit_trades_total{status="failed"}[5m]) > 0.1

# Stuck pending txs piling up
tradekit_pending_trades > 5

# An error code surging
topk(5, rate(tradekit_audit_errors_total[10m]))
```

**Stateless snapshot model.** Every metric is computed from existing persistent state (DB row counts, the engine's `.engine.status.json` file). No in-memory counters; no event-bus instrumentation; no race conditions between scrapes. A scrape is a small SQL pass + a status-file read — typically a few ms.

### Scheduled / recurring trades (DCA)

The time-triggered sibling of conditional orders. Standing intents that fire the same trade on a cron schedule — the classic DCA / scheduled-buy primitive — routed through the same `executeTrade` flow as manual swaps, so every safety guardrail + audit row + notification applies verbatim.

```bash
# Weekly DCA — $100 of ETH every 7 days
tradekit schedule create --side buy --every 7d --base ETH --quote USDC --quoteAmount 100 \
  --name dca-eth --strategy dca

# Monday 10:00 UTC; capped at 12 fires (1 quarter)
tradekit schedule create --side buy --cron "0 10 * * 1" --quoteAmount 100 --max-runs 12

tradekit schedule list                                 # active by default
tradekit schedule show 1
tradekit schedule pause 1                              # engine ignores while paused
tradekit schedule resume 1                             # next_run_at recomputed
tradekit schedule cancel 1                             # terminal
tradekit schedule run --once                           # one tick (cron-friendly)
tradekit schedule run --strict --json                  # daemon: watch=30 by default
```

**Cron expressions** — standard 5-field UTC (`m h dom mon dow`) with `*`, ranges `1-5`, lists `1,3,5`, steps `*/5`, and `1-30/5`. Macros: `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. Day-of-month / day-of-week follows POSIX OR semantics — `0 10 1 * 1` fires on the 1st of each month AND every Monday at 10:00 UTC.

**Duration shorthand** — `--every 30m`, `1h`, `6h`, `1d`, `7d`. Compiles to the equivalent cron at create time and is stored in canonical form. Cadences that don't divide an hour or day evenly are rejected (use `--cron` for those).

**Bounds** — optional `--start-at <ISO>` (engine skips fires before this), `--end-at <ISO>` (schedule flips to `completed` when reached), `--max-runs N` (lifetime cap on SUCCESSFUL fires; common for bounded campaigns like "buy 12 weekly chunks"). Failed attempts don't consume the cap — a `--max-runs 12` campaign always delivers 12 actual buys even if some occurrences hit transient RPC errors along the way.

**Lifecycle** — `active → paused → active` loop while running; terminal states are `completed` (reached max_runs or end_at) and `cancelled` (operator action). Failed fires stay `active` so each cron occurrence is evaluated independently — the row carries `last_error_code / last_error_message` for diagnosis, and `schedule.failed` fires via the notification system.

**Run telemetry** — `run_count` (successful fires only), `total_base_filled`, `total_quote_spent`, `last_run_at`, `last_run_tx_hash` accumulate on every fire. `schedule show <id>` surfaces all of them at-a-glance — quick "how much have I DCA'd into ETH so far".

**Post-fill hooks (iter27).** Auto-create a follow-up order after each successful fire. The classic use case: DCA buys ETH → auto-create a trailing-stop on the amount just bought. Pre-iter27 operators had to manually create the follow-up after every fire; with hooks, the schedule self-manages.

```bash
# DCA buy + auto-trailing-stop on each fire
tradekit schedule create --side buy --every 7d --base ETH --quote USDC --quoteAmount 100 \
  --on-fill '{
    "type": "createOrder",
    "spec": {
      "side": "sell",
      "trigger": "trailing",
      "trailPct": 10,
      "baseAmount": "{{filled.baseAmount}}",
      "base": "ETH",
      "quote": "USDC"
    }
  }'
```

After each weekly DCA fire, a new trailing-stop on EXACTLY the amount just bought (rendered from `{{filled.baseAmount}}`) is created. Twelve weekly fires → twelve trailing-stops, each scoped to the slice they were created for.

**Template variables** (per-fire context):
- `{{filled.baseAmount}}` — base token amount filled (string decimal)
- `{{filled.quoteAmount}}` — quote spent (string decimal)
- `{{filled.fillPriceUsd}}` — USD price at fill (number)
- `{{filled.txHash}}` — fill tx hash (string)
- `{{filled.fireNumber}}` — 1-indexed fire counter (number)

**Type-aware substitution** — `"baseAmount": "{{filled.baseAmount}}"` (whole-field placeholder) renders to `"baseAmount": "0.04"` (string-typed amount); embedded `"bracket-{{filled.fireNumber}}"` coerces to string for concatenation. Same semantics as iter21 playbook templates.

**Validation at create time.** The hook spec is rendered with fake fill data and run through the order-spec validator BEFORE the schedule row persists. Misconfiguration (unknown variable, missing trail_pct, invalid trigger) surfaces immediately — not months later on the first fire.

**Orders chain too (v31).** The same hook attaches to conditional orders — `order create … --on-fill '{...}'` (or `onFill` in playbook order entries / MCP `order_create`): a limit buy at \$1,800 that fills auto-creates the trailing stop for exactly the bought amount. One fire per order (`fireNumber` is always 1); `order replay` shows `hook_created` / `hook_failed` alongside the fill; `order edit --on-fill/--unset on-fill` mutates it in place; the playbook backtest simulates order hooks the same way it does schedule hooks.

#### Config history + rollback (v36) — change management for the file that controls real money

Every `saveConfig` now records a deduped, source-tagged snapshot to `config_history` ("`cli:config set safety.maxSlippageBps`", "`rollback:#12`", the init preset, engine hot-reload writes — all attributable):

```bash
tradekit config history
#   #14  2026-06-11T03:22:41Z  9f2c01ab…  cli:config set safety.maxSlippageBps ← current
#   #13  2026-06-10T09:00:12Z  77ab3c90…  cli:config push notifications.channels
tradekit config diff-version 13        # dot-path diff vs current
tradekit config rollback 13 --yes      # schema-validated restore + SIGHUP hot-reload
```

Design points: recording is **best-effort and never blocks the save** (the file write is the contract); it only starts once the DB exists (a pure-config user doesn't get a database spawned by `config set`); identical content dedupes by hash so idempotent re-saves don't pile rows. Rollback **parses the stored snapshot through the current schema first** — old versions forward-fill newer fields with their defaults instead of stripping them, and hard validation errors abort before anything is written. A rollback records a *new* version: history only grows, the mistaken version stays for forensics. Prunable via `db.retention.configHistoryDays`.

#### Realized-gains export (v36) — tax season, one command

```bash
tradekit export gains --year 2026 --out gains-2026.csv
#   42 realization(s) in 2026-01-01 → 2026-12-31 (real)
#   total gain 1,284.31 · proceeds 18,402.77 · cost basis 17,118.46
#   method: WEIGHTED-AVERAGE cost basis · gas excluded · not tax advice
```

Every P&L surface already shares one weighted-average cost-basis engine; the walker computed per-sell realizations internally and threw them away. v36 exposes them: each realizing sell becomes a record (date, amount sold, proceeds, cost basis, gain, avg cost at sale, tx hash) — CSV to stdout (pipeable; summary + disclaimers on stderr so they never corrupt the stream) or `--out FILE`; `--json` and MCP `gains_report` for structured consumers. Deterministic: a pure fill-journal walk, no oracle, so the same window always exports identical rows.

**The subtlety that matters:** cost basis is path-dependent, so the walk always sees **full history** and the window filters only the *output* records — a 2025 buy correctly funds a 2026 sell's basis instead of surfacing as a bogus untracked sell. Method caveats stamped on every export: weighted-average (not FIFO/specific-lot — some jurisdictions require otherwise), stablecoin-quote fills only (skips counted), gas excluded (`tradekit pnl` owns gas accounting), sells without a tracked basis reported separately and never folded into gains. Not tax advice.

#### Signal-triggered orders (v35) — event-driven execution

The fourth trigger type. Instead of polling price, the order fires when a named **external signal** arrives — the TradingView-alert integration pattern:

```bash
# 1. Arm the intent (amounts + safety rails are YOURS, set now):
tradekit order create --side buy --trigger signal --signal-name tv-breakout \
  --base ETH --quote USDC --quoteAmount 500

# 2. Enable the webhook (separate secret — webhook URLs leak in third-party UIs):
tradekit config set webhooks.signalSecret "$(openssl rand -hex 16)"

# 3. Point TradingView's alert at:
#    POST https://your-host:3030/api/signal/tv-breakout?key=<secret>
# (or fire manually / from agents: `tradekit signal fire tv-breakout`, MCP signal_fire)
```

**Semantics, precisely.** A signal is a **point event**: one event fires every active listener **armed before it arrived** (late-armed orders never fire on stale signals), then is consumed — at-most-once delivery per listener, and a transiently-failed fire does NOT retry on the same event (the moment passed; the failure notification tells you). Dry-run ticks and engine-lock skips never consume events. Unclaimed events expire after 1h. Expiry, OCO groups, on_fill hooks, dynamic sizing, and the v33 crash-window guard all apply to signal orders exactly as to price-triggered ones — and every fire routes through `executeTrade` with the full safety stack.

**Observability (v36.5).** Signals flow through every forensic surface: the timeline gains `signal.received` events (consumed → info with the fired order id; **PENDING / expired-unclaimed → warn** — an alert that arrived and fired nothing is exactly the integration-debugging signal), the daily digest counts `Signals received: N (M fired, K fired NOTHING ⚠)`, `tradekit doctor` warns when signal-armed orders exist but `webhooks.signalSecret` is unset (the webhook endpoint is silently disabled), the web Automation tab renders `on signal "X"` triggers, and `GET /api/signals` serves the inbox.

**Risk profile, honestly.** The webhook endpoint is the one inbound-write surface on the otherwise read-only web API. It's bounded by construction: a forged signal can only fire orders **you pre-armed with your own amounts** — it cannot choose tokens, sizes, or direction. The secret is constant-time compared, ≥16 chars, and unset means the endpoint 404s. Signal orders can't be backtested (no signal history) and hook legs can't be signal-armed (nothing to validate against) — both rejected at create with clear messages.

**Hook failures don't unwind the fill.** If the hook errors at fire time (e.g. the rendered amount is too small for slippage cap), the fill stays — the trade already happened — and a `schedule.on_fill_failed` notification fires with the error code. Operators can investigate + create the follow-up manually. Success emits `schedule.on_fill_created`.

**No recursion.** Hook-created orders never carry hooks themselves (the hook spec dialect has no `onFill` field). So a DCA's hook creates a trailing-stop; when the trailing-stop later fires, no further hook fires. Bounded by construction.

**Strategy tag propagates.** The auto-created order inherits the schedule's `strategy` column verbatim. A schedule tagged `playbook:1` produces orders tagged `playbook:1` → tradekit's playbook + strategy-budget filters cover them automatically.

**Position-level sizing — `"max"` and `"N%"` (v35).** Order and schedule amounts accept the `max` sentinel on the **spend side** (sell → `baseAmount`, buy → `quoteAmount`): it resolves to the live balance at **fire time** — on-chain for real fires, the virtual book for paper, the sim balance in backtests. This makes the most natural stop-loss finally expressible: a DCA grows your position week after week, and ONE `order create --side sell --trigger trailing --trail-pct 10 --baseAmount max` protects **all of it** — no fixed slice, no per-fire restacking, the stop automatically covers whatever you hold when it fires. Percentages complete the family (v35.5): `"37.5%"` resolves to that fraction of the spendable balance at fire time — `100%` ≡ `max` by construction, integer ppm math so 18-decimals balances don't drift. They make **scale-out** expressible: a bracket of `[{price_above 2600, baseAmount: "50%"}, {trailing 10%, baseAmount: "max"}]` takes half off at the target and trails *whatever remains* — each leg sized against the position **as it is when that leg fires**, which is exactly the semantic you want after partial exits. Receive-side sentinels are rejected at create with a teaching error (that side is derived from the quote), garbage amounts — including `150%` — now fail at create instead of at first fire, and the funding runway lists dynamically-sized primitives under `skipped` with an explicit reason (their spend is a function of whatever is there). Caveat: multiple simultaneous `max` stops on the same token race — the first to fire takes the position; pair them in an OCO group. Manual trades inherit the percentage form too (`trade sell --baseAmount 25%`).

**Per-fire OCO brackets.** Combine `{{filled.fireNumber}}` with the `group` field to give each fire its own OCO group:

```jsonc
{
  "type": "createOrder",
  "spec": {
    "side": "sell", "trigger": "price_above", "price": 5000,
    "baseAmount": "{{filled.baseAmount}}",
    "base": "ETH", "quote": "USDC",
    "group": "bracket-{{filled.fireNumber}}"
  }
}
```

Fire 1 → order with group `bracket-1`. Fire 2 → order with group `bracket-2`. Each fire's bracket is independent — no cross-fire OCO cascade.

**Multi-leg brackets (`createOrders`).** One fill can spawn several follow-up orders atomically — the classic bracket is a take-profit AND a stop-loss on the slice just bought, where either fire cancels the other:

```jsonc
{
  "type": "createOrders",
  "specs": [
    { "side": "sell", "trigger": "price_above", "price": 3000,
      "baseAmount": "{{filled.baseAmount}}", "base": "ETH", "quote": "USDC" },
    { "side": "sell", "trigger": "price_below", "price": 1500,
      "baseAmount": "{{filled.baseAmount}}", "base": "ETH", "quote": "USDC" }
  ]
}
```

2–4 legs per hook. Legs that declare no explicit `group` are **auto-OCO-paired per fire** (generated group `hook-<parent>-<fireNumber>`): the TP fires → the SL dies, and vice versa — no manual group bookkeeping, and each fire's bracket is independent of the previous fire's. Declare an explicit `group` on any leg to take over pairing yourself. Leg creation is **all-or-nothing**: if leg 2 fails validation at fire time, leg 1 is rolled back (cancelled, row kept for forensics) before the `on_fill_failed` notification — a bracket with only one arm never survives. Works everywhere `createOrder` does: schedule + order hooks, playbook entries, and the playbook backtest (the sim spawns every leg and replays the OCO cascade — `dca:hook#1.1` / `dca:hook#1.2` in per-strategy stats).

**Paper inheritance.** Hook orders inherit the parent's paper flag: a paper DCA's bracket lives on the paper book, never the real one.

### MEV-protected submission (private mempool)

Public-mempool DEX trades on Ethereum mainnet (and to varying degrees on other chains) are routinely sandwich-attacked: bots front-run the swap, manipulate price, then back-run for arbitrage. Typical extracted value: 0.5–3% per trade. Tradekit's safety guardrails (slippage cap, gas budget, position limits) **don't address this** — they limit what tradekit will *let* a trade do, not what the public mempool can do *to* a trade in transit.

The standard mitigation is to submit signed transactions through a private-relay RPC that forwards directly to block builders without exposing the tx to the public mempool. Tradekit supports this on a per-chain basis:

```bash
tradekit config set mev.enabled true
tradekit config set mev.privateRpcs.ethereum 'https://rpc.flashbots.net/fast'
tradekit config set mev.labels.ethereum 'Flashbots Protect'

# Verify reachability + chainId + latency:
tradekit doctor
#   ✓  mev:ethereum (Flashbots Protect)  reachable in 234ms
```

| Relay | URL | Notes |
|---|---|---|
| Flashbots Protect | `https://rpc.flashbots.net/fast` | Free; "fast" endpoint includes more builders for faster inclusion |
| MEV Blocker | `https://rpc.mevblocker.io` | Free; refunds back to the user instead of builder |
| Merkle Private RPC | `https://rpc.merkle.io/<api-key>` | Free tier + paid tiers; API key in the URL path |
| BloXroute / Eden / others | various | Most JSON-RPC-compatible relays work via the same config |

**Reads vs writes.** Reads (balance, receipts, `eth_call`) continue to use the public-RPC fallback chain. Writes (every `walletClient.writeContract` / `sendTransaction` call) route through the private relay. This split exists because most relays buffer the submitted tx privately for some blocks before propagation — `eth_getTransactionByHash` on a freshly-submitted private tx returns "not found" until inclusion, which would hang every receipt wait.

**Failure mode** — `mev.fallbackToPublic` (default `false`):
- `false`: a private-relay outage **hard-fails the trade** rather than leak to the public mempool. The MEV-protection guarantee is preserved. Recommended.
- `true`: viem falls over to public RPCs if the private leg errors. Trade lands; MEV protection may not. For operators who care more about availability than leakage.

**Secret hygiene.** Private-RPC URLs that embed API keys (Merkle, others) are redacted host-only in `tradekit config show`, in the audit log, and in MCP `config show`. Path is replaced with `[REDACTED]`. Use `tradekit config show --show-secrets` for the raw value.

**Per-chain opt-in.** Only chains with a `privateRpcs[<chain>]` entry route privately — others submit publicly as before. So enabling MEV for ethereum doesn't affect base or arbitrum trades. Set `enabled: false` to disable globally.

### Notifications (push delivery)

Webhook channels for push-based delivery of operationally interesting events — the natural complement to the order engine and the cron-watch loops. Configure one or more channels in `config.notifications.channels[]`:

```bash
tradekit config push notifications.channels '{
  "name": "ops-slack",
  "url": "https://hooks.slack.com/services/T0XXXX/B0XXXX/abcdef",
  "events": ["order.filled", "order.failed", "trade.failed", "approval.infinite"],
  "minSeverity": "info"
}'

tradekit notify list                    # show configured channels (URLs path-masked)
tradekit notify test --channel ops-slack
```

**Auto-detected formats:**

| URL host pattern | Format | Payload |
|---|---|---|
| `hooks.slack.com` | Slack | Block Kit (header + section + context) |
| `discord.com/api/webhooks` | Discord | Single embed with color + fields |
| `api.telegram.org/bot…/sendMessage?chat_id=…` | Telegram | MarkdownV2 text |
| anything else | Generic | `POST {event, severity, title, body, fields, link, timestamp}` |

**Built-in events:**

| Event | Severity | When |
|---|---|---|
| `order.filled` | info | Order trigger met + trade succeeded |
| `order.failed` | warn (revert) / critical (terminal) | Order's trade reverted on-chain / safeguard tripped |
| `order.expired` | info | Order hit its `expires_at` without firing |
| `order.cancelled_oco` | info | Order auto-cancelled because an OCO peer fired (one event per cancelled peer) |
| `schedule.fired` | info | Recurring schedule fired a trade successfully |
| `schedule.on_fill_created` | info | Post-fill hook auto-created a follow-up order (iter27) |
| `schedule.on_fill_failed` | warn | Post-fill hook errored AFTER the fill landed — manual follow-up may be needed |
| `digest.daily` | verdict-mapped (healthy=info, attention=warn, critical=critical) | v31 engine-pushed daily digest (notifications.digest) |
| `schedule.failed` | warn (revert) / critical (terminal) | Schedule's trade failed; schedule stays active for the next slot |
| `schedule.completed` | info | Schedule reached `max_runs` or `end_at` |
| `trade.failed` | warn | Any direct swap reverted on-chain |
| `approval.infinite` | critical | A successful `maxUint256` approval was granted (highest-risk on-chain action) |
| `engine.locked` | warn | Iter28 — operator engaged the global kill switch; all trading paths now reject |
| `engine.unlocked` | info | Iter28 — kill switch cleared; trading resumed |

**Per-channel filtering** — Each channel has optional `events: [...]` (allowlist; empty/absent = all) and `minSeverity` (floor; `info` lets everything through, `critical` restricts to critical-only).

**Dedup** — `config.notifications.dedupWindowMs` (default 60s) suppresses identical `(channel, dedupKey)` pairs within the window. A repeatedly-failing order produces one alert per minute, not one per tick.

**Digest carries the equity move (v38).** With the v37 snapshot feed in place, the daily digest's first question — "how did the portfolio do?" — finally has a line: `EQUITY: $10,002 → $10,184 (+$182, +1.82%) · 4 snapshots`, scope-disciplined like every equity surface, and silently omitted (never failing) when the feed has fewer than two points in the window.

**Quiet hours (v34) — nothing lost, nobody woken.** Severity routing has no time dimension: an info-level `schedule.fired` at 3am is noise, but muting the channel overnight also mutes the 3am `circuit_breaker`. `notifications.quietHours` adds the time axis:

```jsonc
{
  "notifications": {
    "quietHours": { "enabled": true, "startHourUtc": 22, "endHourUtc": 7, "breakthroughSeverity": "critical" },
    "channels": [
      { "name": "ops-slack", "url": "https://hooks.slack.com/..." },
      { "name": "pager", "url": "https://...", "minSeverity": "critical", "ignoreQuietHours": true }
    ]
  }
}
```

Inside the window (wraps midnight when `start > end`), notifications below `breakthroughSeverity` are **queued, not dropped** — they land in the v34 `notification_queue` table and flush as **one summary notification** when the window ends ("12 suppressed during quiet hours: 1 critical · 4 warn · 7 info" plus the last 15 titles, carrying the max severity of the batch). Three flush triggers: the first post-window delivery (opportunistic, so the summary lands before the event that woke the channel), the engine digest worker tick (covers uneventful mornings), and `tradekit notify flush` (`--force` flushes mid-window). `breakthroughSeverity` events always deliver immediately, as does any channel with `ignoreQuietHours: true` — the pager pattern. Failure honesty: if the summary webhook fails, rows stay queued for the next attempt; if the enqueue itself fails, the notification delivers immediately (fail open — a broken queue must never eat alerts). Inspect with `notify queue`; prune via `db.retention.notificationQueueDays`.

**Reliability invariant** — Webhook delivery is **best-effort and never throws out of a trade or engine tick**. A Slack outage cannot block a fill. All failures land in `~/.tradekit/server.log` for after-the-fact triage.

**Security** — Webhook URLs embed bearer tokens in the path. They are redacted everywhere they could leak: `notify list`, `config show` (use `--show-secrets` for the raw value), the audit log, and MCP `notify_list`. Only the on-disk config holds the raw value (mode 0600).

### Approvals (security-critical)

```bash
tradekit allowances [--chain <name>] [--account <label>] [--json]
# Probes well-known aggregator routers × chain profile's token list; reports
# anything non-zero. Use this before/after trading to audit standing exposure.

tradekit allowances audit [--chain X | --chains a,b,c | --chains all] [--lookback-blocks N] [--usd-threshold N] [--json]
# Risk-score every standing approval: infinite_unknown_spender (CRITICAL), large_usd_exposure (WARN),
# stale_approval (WARN — only with --lookback-blocks), etc. Returns a structured `recommendedActions[]`
# carrying the top-3 critical revoke targets by USD exposure (infinite ranked first). Multi-chain mode
# aggregates the cross-chain top-3 — operators with critical approvals on 5 chains see the 3 most
# urgent to revoke without scanning all rows.

tradekit allowances revoke-all [--chain X] [--account L] [--spender X] [--token Y] [--simulate] [--yes]
# Bulk revoke matching rows. Pair with `audit` output to script "revoke everything critical":
#   tradekit allowances audit --json | jq -r '.recommendedActions[].params.spender' | \
#     xargs -n1 -I{} tradekit allowances revoke-all --spender {} --yes

tradekit approve <token> <spender> [--amount <decimal> | --infinite] [--force-infinite] [--chain X] [--account L]
tradekit revoke  <token> <spender> [--chain X] [--account L]
```

`approve` is governed by the same `safety` config that guards swaps:

- **Token blacklist** — refuses to approve listed tokens
- **Contract whitelist** — only allows approving listed spenders (when whitelist is non-empty)
- **Infinite approval gate** — `--infinite` requires `--force-infinite` (or `safety.allowInfiniteApprovals=true`)
- **`safety.maxApprovalUsdLimit`** — caps a single approval's USD-priced value

### Data & ops

```bash
tradekit health    [--accounts X,Y|all] [--chains a,b,c] [--summary] [--strict] [--quiet] [--json] [--watch N]
                   # Operator dashboard: portfolio + 7d PnL + trade quality + standing approvals + nextActions.
tradekit status    [--section S,S,...] [--json] [--watch N]
                   # Operational dashboard: engine workers, near-trigger orders, scheduled fires, rebalance drift,
                   # playbook deployments, drawdown breaker, strategy budgets, 24h audit anomalies,
                   # currently-firing strategy alerts (+24h transitions), paper-trading snapshot.
                   # Composes ~10 read-side queries into one situational-awareness view; sub-100ms, zero RPC.
                   # Sections: engine,orders,schedules,rebalance,playbooks,drawdown,budgets,activity,alerts,paper.
tradekit digest    [--window 1h|24h|7d|30d] [--format text|slack|json] [--compare] [--strict]
                   # Windowed activity report. Pairs with status (right-now vs window). Slack-format pipes
                   # directly into a Slack incoming webhook for daily cron reports. --strict exits 2 on critical.
tradekit holdings [<address> | --account <label>] [--chains base,arbitrum,...|all] [--strict] [--json] [--watch N]
tradekit portfolio [--accounts a,b,c|all] [--chains a,b,c|all] [--limit N] [--strict] [--json]
tradekit pnl       [--chain <name>] [--account <label>] [--accounts a,b,c|all] [--windows 1d,7d,30d] [--json]
tradekit trades    [--chain <name>] [--account <label>] [--token T] [--status pending|success|failed]
                   [--note <substr>] [--limit N] [--format table|csv|json] [--out <file>]
tradekit trades sync [--chain X] [--account L] [--since-days N] [--strict] [--summary] [--json]
                     # Backfill DB from on-chain history (idempotent on tx_hash; bookmark-resumed).
tradekit trades analyze [--since YYYY-MM-DD] [--aggregator <name>] [--strict] [--json]
                     # Aggregator quality scorecard (slippage stats by aggregator).
tradekit price     <symbol|addr> [--chain <name>] [--period 1d|1w|1m|1y] [--strict] [--json] [--watch N]
tradekit trending  [<query>] [--chain <name>] [--limit N]
tradekit audit     [--limit N] [--since YYYY-MM-DD] [--tool T] [--account L] [--chain X] [--caller cli|mcp|web]
tradekit audit summary [--since N] [--tool T]    # aggregated counts + error rate (cron-friendly)
tradekit audit prune --before YYYY-MM-DD [--yes] # preview + delete old audit rows
tradekit viewTx    <hash> [--chain <name>]
tradekit chains                       # list chains; the active one is marked *
tradekit chain     [<name>]           # show or switch the active chain
tradekit reconcile [--chain X] [--account L] [--watch=Ns] [--summary] [--json]
                   # Walk pending trades, query chain receipts, update status.
tradekit pending   [--chain X] [--account L] [--strict] [--summary] [--json]
                   # Diagnose stuck txs (gas / nonce / mempool) with verdict per row.
tradekit tx speedup <hash> [--chain X] [--multiplier N] [--pass <pw>] [--json]
                   # Replace a stuck pending tx with a higher-gas replacement at the same nonce
                   # (default ×1.2). Use when `pending` returns action=speedup.
tradekit tx cancel  <hash> --yes [--chain X] [--multiplier N] [--pass <pw>] [--json]
                   # DESTRUCTIVE: replace pending tx with a zero-value self-send at same nonce
                   # (cancels the original intent). Use when `pending` returns action=cancel.
tradekit doctor    [--chains base,arbitrum,…|all] [--strict] [--summary] [--quiet] [--json] [--watch N]
tradekit verify    [all | backup <file> | wallet | config | db] [--strict] [--summary] [--quiet] [--json]
                   # Integrity check suite (data + config + wallet integrity).
```

### Operational status dashboard (iter23)

`tradekit status` composes engine workers + active orders/schedules/rebalance plans + playbooks + drawdown breaker + strategy budgets + 24h audit anomalies into ONE situational-awareness view. Distinct from `tradekit health` (financial summary) — `status` answers "what is the engine actively managing RIGHT NOW + what's near firing / tripping".

```
TRADEKIT STATUS  ·  2026-05-30T14:00:00.000Z

ENGINE
  pid=12345  started 2h 14m ago  updated 25s ago
  ● orders     last tick 25s ago  (interval 30s, 245 ok, 2 fails)  ← TX_REVERTED on 0xabc...
  ● schedules  last tick 30s ago  (interval 30s, 12 ok)
  ● rebalance  last tick 4m ago   (interval 5m, 9 ok)
  ✕ reconcile  last tick 2h ago   (interval 60s, 0 ok)  ← stale > 4× interval

ORDERS  (3 active, 12 filled, 1 cancelled, 0 expired, 0 failed)
  Closest to trigger:
    #14   sell ETH/USDC  price_above $3000              cur=  $2952.40   1.61% away
    #19   sell ETH/USDC  trailing 5% (HWM $2980.00)     cur=  $2952.40   4.10% away
    #22   sell ETH/USDC  price_above $4000              cur=  $2952.40  35.49% away

SCHEDULES  (2 active, 0 paused)
  #5    eth-weekly-dca   cron "0 0 * * 0"  next fire 2d 14h  (4 runs)
  #7    wbtc-monthly     cron "0 0 1 * *"  next fire 22d 0h  (0 runs)

REBALANCE PLANS  (1 active)
  #2    core-folio       chain=base  drift>5%  next eval 4h 12m  · last drift 3.20%, 0 legs

PLAYBOOKS  (1 deployed)
  #1    eth-bracket-dca  deployed 14d ago

DRAWDOWN BREAKER
  enabled (maxDrawdown 15%, autoResume<5%)
  scope=global  peak $5240.00  last $4980.20  drawdown 4.96%  ● ok

STRATEGY BUDGETS
  playbook:*           [2 matches]  lifetime $1247.50/$5000.00 (25%)  24h $145.00/$500.00 (29%)
  arb-experiment                    lifetime $250.00/$1000.00 (25%)  per-fire cap $50.00

LAST 24H  (47 audit rows, 3 errors)
  Top errors:
    SLIPPAGE_TOO_HIGH               2 occurrences  (last 2026-05-30T11:32:00Z)
    RPC_FAILED                      1 occurrence   (last 2026-05-30T09:45:00Z)
```

**Section filter.** `--section orders,drawdown` renders only the requested sections. Default = all 8.

**Near-trigger calculation.** Each active order's stored `last_checked_price` (set by the orders engine on every tick) gives the percentage distance to fire WITHOUT a fresh RPC. Stale price reads (> 1h) get an `⚠ stale check` annotation. Trailing orders use `water_mark × (1 ± trail_pct/100)` for the threshold.

**Sub-100ms, zero RPC.** ~10 indexed DB queries + 1 status-file read. No oracle calls. The "current price" shown for each near-trigger order is the engine's most recent observation; freshness flagged when > 1h.

**Composition by construction.** Reuses every existing DB helper (`listOrders`, `listSchedules`, `orderCountsByStatus`, `auditSummary`, etc.) — no new persistence, no new schema. New module is purely orchestration + rendering.

**Watchable.** `--watch 30` re-renders every 30 seconds, suitable for a side terminal during incident response or active strategy monitoring.

### Activity digest (iter24)

`tradekit digest` is the natural complement to `status`:
- **`status`** answers "what is the engine doing **right now**".
- **`digest`** answers "what happened over the last **N hours/days**".

Composes trades + strategy fires + alerts + paper activity + safety events + top errors over a window into a single operator-facing report. Three formats:

```bash
tradekit digest --window 24h                       # text (terminal)
tradekit digest --window 24h --format slack        # markdown for Slack webhook
tradekit digest --window 24h --format json         # structured shape
tradekit digest --window 7d --compare              # add prior-window delta
tradekit digest --window 24h --strict              # exit 2 on 🔴 critical verdict
```

**Slack-ready output** unlocks the cron-friendly daily-report workflow:

```bash
# /etc/cron.d/tradekit-digest
0 9 * * * tradekit digest --window 24h --format slack | \
  curl -X POST -H 'Content-Type: text/plain' --data-binary @- $SLACK_WEBHOOK
```

**…or skip the cron entirely (v31).** The engine's `digest` worker pushes the same markdown through the configured notify channels (Slack / Discord / Telegram / webhook) once per UTC day:

```bash
tradekit config set notifications.digest '{"enabled":true,"hourUtc":9,"window":"24h","minVerdict":"healthy"}'
# engine restart not needed — SIGHUP hot-reload picks it up
```

At most one send per UTC day at (or after) `hourUtc`, deduped across restarts via a marker file. `minVerdict: "attention"` turns the digest into a *page-only-when-something's-wrong* report — a below-gate day isn't marked sent, so the digest goes out the moment health degrades past the gate. Same `renderDigestMarkdown` renderer as `--format slack`, so channel formatting is identical to the cron path.

The slack format uses Slack's mrkdwn (`*bold*`, `_italic_`, `\`code\``) for direct rendering in a channel — no JSON-wrapping required.

**v28/v29 awareness.** The digest reads the durable journals directly: an **ALERTS** section counts exact fired/resolved transitions in the window (plus the currently-active snapshot and top rule types), a **PAPER** section makes dry-run strategies visible in the daily report, and the fires section adds journal-exact schedule/rebalance counts when `engine.scheduleJournal` / `rebalanceJournal` are enabled — the legacy `last_run_at` approximation can't distinguish "fired once" from "fired 10×", and *can't see a failure that was followed by a success at all*. Journal failure counts and window alert activity feed the health verdict (`attention` reasons), so the cron'd Slack digest pages on the things the legacy counters silently missed.

**Example output (slack format):**

```
🟡 *Tradekit digest* · 24h · attention
_2026-05-29 12:00 UTC → 2026-05-30 12:00 UTC_

*Reasons:*
• error rate 15.4% > 10% threshold
• 3 safety blocks during window
• 2 orders failed during window

*Trades:* 47 (43✓ 4✗) · $12.4k volume · 91% success
*Top strategies:* `playbook:1`×24 `manual-dca`×12 `arb-bot`×5

*Strategy fires:* 7 filled · 2 cancelled · 5 schedules fired

*Safety:* 3 budget blocks · 1 honeypot block

*Errors:* 4/26 (15.4%) `SLIPPAGE_TOO_HIGH`×3 `RPC_FAILED`×1
```

**Verdict tiers:**
- 🟢 **healthy** — no concerning signals
- 🟡 **attention** — error rate > 10%, budget utilization > 80%, safety blocks fired, or any orders failed
- 🔴 **critical** — drawdown breaker tripped (in window OR currently), or error rate > 25%

`--strict` exits with code 2 on critical (operators wire this into PagerDuty / cron-mailer for paging).

**Comparison mode** (`--compare`) computes the same digest for the immediately-prior window of the same length and surfaces deltas:

```
COMPARISON vs prior 24h:
  Trades:        47 (+8)
  USD volume:    $12.4k (+$3.2k)
  Orders filled: 7 (-2)
  Audit errors:  4 (+1)
```

**Performance.** ~6 indexed DB queries bounded by `since=window_start`. Sub-100ms on a typical install with millions of audit rows.

**Window range.** 1 minute to 90 days. Beyond 90d the audit log + trades table grow large enough that the "top errors + recent fires" signal degrades; operators wanting a long window should split into shorter windows.

### Health check

`tradekit doctor` runs a fast pass over: Node version, data dir / DB writable, config schema, wallet presence, all known RPCs for the active chain, both free aggregators (KyberSwap + OpenOcean), and the DexScreener price API. Exits 1 if any check is critical-fail; `--strict` promotes warns to exit-1 too (CI-friendly). `--summary` prints a single-line digest for cron / Slack subjects.

```
🟢 OK   tradekit health check  (tradekit 1.1.1)

  ✓  node                   22.16.0
  ✓  data_dir               /Users/.../tradekit
  ✓  config                 valid (0 chain override(s), active=base)
  ✓  wallet                 single-key keystore → 0x76e8…67a8
  ✓  sqlite                 ~/.tradekit/tradekit.db (trades=3, audit=73)
  !  rpc:base               3/4 reachable (down: base.llamarpc.com)
  ✓  agg:kyberswap          reachable in 550ms
  ✓  agg:openocean          reachable in 1505ms
  ✓  price (DexScreener)    reachable

8 ok · 1 warn · 0 fail
```

In `--summary` mode the same check renders as one line, suitable for piping into alerting:

```
🟡 WARN  tradekit doctor · 8 ok · 1 warn · 0 fail · top: rpc:base · 2026-05-30T...
```

### Global flags

| Flag         | Default | Effect                                                                 |
|--------------|---------|------------------------------------------------------------------------|
| `--verbose`  | off     | Mirror DEBUG+INFO logs to stderr (handy for debugging).                |
| `--quiet`    | off     | Cron-friendly noise reduction. On `health` / `doctor` / `verify`, filters output to non-ok rows so tail-watching cron logs only show signals worth reading. Without `--json`, also silences stderr. |
| `--json`     | off     | Machine-readable JSON output where applicable (`holdings`, `quote`, `pnl`, …). Combined with `--watch`, emits compact JSONL one-line-per-tick (consumable by `jq -c`, Vector, Fluent Bit). |
| `--strict`   | off     | Exit 1 on actionable bad state. Each command's strict trigger matches its domain — doctor (warnings), trades sync (chunk errors), health (critical nextActions), pnl (stale data), gas/price/holdings/portfolio (per-chain failures), preflight (no_go), token check (honeypot/suspicious). Use in cron pipelines to gate downstream steps on exit code. |
| `--watch [N]`| off     | Re-run a read-only command every N seconds (default 5; min 1, max 3600). Clears the screen between ticks; `--json` mode emits JSONL stream instead. Supported on `health`, `doctor`, `reconcile`, `pending`, `sync`, `holdings`, `pnl`, `gas`, `price`. |
| `--summary`  | off     | Single-line cron/Slack-friendly digest instead of the multi-line text view. Available on `health`, `doctor`, `verify`, `reconcile`, `trades sync`, `pending`. Field-collapse pattern: healthy state is short; degraded state grows fields naturally as errors appear. JSON output unchanged. |
| `--chain X`  | active  | Run the command against chain X without changing the active chain.     |
| `--pass P`   | env     | Wallet password (also `WALLET_PASS` env var). Only required for real trade/transfer/approve/revoke + wallet management; `quote`, any `--simulate` run, and read-only inspect commands run without a password. |

### MCP server

```bash
tradekit mcp --pass <password>
```

Starts an MCP stdio server exposing 112 tools across six groups:

- **Data / inspect** (18) — `chains`, `gas`, `price`, `check_price`, `holdings`, `portfolio`, `portfolio_snapshot`, `portfolio_history`, `portfolio_diff`, `trending`, `pnl`, `viewTx`, `health`, `token_info`, `aggregator_stats`, `pair_stats`, `slippage_suggest`, `strategies_list`
- **Trade & automation** (30) — `quote`, `buy`, `sell`, `transfer`, `import_trade`, `preview_trade`, `preflight_trade`, `sweep_balances`, `order_create`, `order_list`, `order_show`, `order_cancel`, `order_edit`, `order_run`, `schedule_create`, `schedule_list`, `schedule_show`, `schedule_pause`, `schedule_resume`, `schedule_cancel`, `schedule_edit`, `schedule_run`, `rebalance_create`, `rebalance_list`, `rebalance_show`, `rebalance_edit`, `rebalance_pause`, `rebalance_resume`, `rebalance_cancel`, `rebalance_run`
- **Security** (8) — `allowances`, `audit_allowances`, `approve`, `revoke`, `revoke_all`, `check_token`, `safety_drawdown`, `safety_reset_drawdown`
- **Admin / diagnostics** (26) — `status`, `accounts`, `audit`, `reconcile`, `recent_trades`, `config`, `config_preflight`, `doctor`, `verify`, `sync_trades`, `list_sync_bookmarks`, `address`, `analyze_trade`, `diagnose_pending`, `speedup_tx`, `cancel_tx`, `notify_list`, `notify_test`, `engine_run`, `engine_status`, `engine_lock`, `engine_unlock`, `bulk_halt`, `bulk_resume`, `db_stats`, `db_integrity_check`
- **Strategy & backtest** (13) — `playbook_validate`, `playbook_deploy`, `playbook_list`, `playbook_show`, `playbook_diff`, `playbook_replace`, `playbook_promote`, `playbook_destroy`, `backtest_order`, `backtest_playbook`, `backtest_rebalance`, `backtest_compare`, `strategy_report`
- **Observability** (13) — `status_dashboard`, `digest_summary`, `order_replay`, `schedule_replay`, `rebalance_replay`, `backtest_list`, `backtest_show`, `backtest_compare_list`, `backtest_compare_show`, `timeline_query`, `engine_events`, `alert_history`, `price_stats`
- **Paper trading** (5) — `paper_balances`, `paper_trades`, `paper_pnl`, `paper_deposit`, `paper_reset` — manage the virtual book that `paper: true` orders / schedules / playbooks trade against (seed funds, inspect positions + fills, realized P&L, reset) so an agent can dry-run a whole strategy without touching real capital.

Every write tool accepts `simulate: true`. Errors are structured (see *Agent integration* below). Every monitoring/diagnostic tool exposes a top-level `severity` field ('ok' | 'warn' | 'critical' / 'fail') and a `recommendedActions[]` array carrying structured `NextAction[]` dispatch hints — agents branch on `severity` for at-a-glance status and iterate `recommendedActions` to auto-remediate without parsing prose.

MCP client config (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "tradekit": {
      "command": "npx",
      "args": ["-y", "tradekit", "mcp"],
      "env": { "WALLET_PASS": "your-password" }
    }
  }
}
```

### Web mode

```bash
tradekit web --port 3030 --pass <password>
```

The server prints a one-time URL with an embedded per-session auth token; open it to land on a single-page React UI:

- **Overview** — wallet status + quick info
- **Holdings** — multi-chain balances with USD
- **Trade** — execute or simulate from the browser, with size-fraction safety hints
- **Automation** — the engine's situational view: liveness + lock + per-worker health, currently-firing alerts, orders/schedules/rebalance tables with decision-journal drill-in (rebalance rows render drift as a progress bar toward the threshold), deployed playbooks, the paper book, and an on-demand funding-runway card (per spend-token verdicts, red under 7 days); 15s auto-refresh, read-only by construction
- **Timeline** — the forensic event stream in the browser: every subsystem in one chronological view (trades, decision journals incl. v32 retries + v33 recoveries, alert fires/resolves/breaker trips, engine lifecycle), with window / severity / kind-group / strategy filters, expandable per-event details, date dividers, 30s auto-refresh
- **Strategy** — the per-tag deep dive: identity + lifecycle composition, window performance (fills / success rate / net quote / slippage percentiles), net positions, risk (budget consumption bars + drawdown), forward signals (next fire, pending triggers, rebalance drift bars), recent activity. Same `buildStrategyReport` core as the CLI — numbers match by construction; deliberately network-free (live-priced valuation stays on the CLI where oracle cost is opted into)
- **Chart** — TradingView Lightweight Charts driven by OKX public candles
- **Trades / PnL / Audit** — history tables backed by SQLite
- **Approvals** — per-row revoke and bulk **Revoke ALL**
- **Config** — JSON config editing with server-side Zod validation

#### Read-only automation API

The web server also exposes the automation engine's observability core as token-authed, **read-only** JSON routes — built for wall-mounted dashboards and external monitors, and consumed by the same core helpers the CLI/MCP use (numbers match across surfaces by construction). No wallet, no keystore, no RPC, no writes — a leaked dashboard token can't fire trades through these:

| Route | Returns |
|---|---|
| `GET /api/engine` | engine status file + lock state (`running`, per-worker ticks, lock reason) |
| `GET /api/dashboard[?sections=…]` | the full 10-section status dashboard (same `gatherStatusReport` core as `tradekit status` / MCP `status_dashboard`) |
| `GET /api/orders[?status&chain&account&strategy&limit]` | conditional orders; `/api/orders/:id` adds the decision-journal tail |
| `GET /api/schedules[…]`, `/api/schedules/:id` | DCA schedules + v29 journal tail (fires, failures, retirements, hooks) |
| `GET /api/rebalance[…]`, `/api/rebalance/:id` | rebalance plans + the drift history journal — the dashboard's "how close to firing?" series |
| `GET /api/playbooks`, `/api/playbooks/:id` | deployments + spec + every owned primitive |
| `GET /api/paper[?account&chain]` | virtual balances + realized P&L (same `summarizePaperPnl` core) |
| `GET /api/timeline[?since&until&kinds&strategy&minSeverity&limit]` | the unified forensic event stream (every kind in `ALL_EVENT_KINDS` — the CLI, MCP, and web whitelists now share one registry) |
| `GET /api/runway[?days&chain&account&strategy]` | the funding-runway forecast (on-demand — real buckets read on-chain balances) |
| `GET /api/strategies` | strategy tags: trade history ∪ live primitives (zero-fill playbooks included, live-first sort) |
| `GET /api/alerts[?tag&limit]` | active alert states + the v28 transition history |
| `GET /api/strategy-report/:tag[?window&mode]` | the full multi-section strategy report (offline build — no live prices; MTM stays on CLI/MCP where it's explicitly opted into) |

#### Architecture

The server is **Express 5**; the frontend is **React 18 + Mantine 7**, bundled with **Vite**. Auth is a per-session random token accepted via `Authorization: Bearer`, `tk_token` cookie, or `?token=` query (the cookie is set on the bootstrap `GET /?token=…`). All endpoints under `/api/*` use a structured error middleware that emits `{ok:false, error:{code,message}}`. BigInt values are serialized via an Express-level `json replacer`. SPA routes fall back to `index.html`. Graceful shutdown on SIGINT/SIGTERM closes the SQLite WAL cleanly.

The web UI sources live in `webui/`. To rebuild the bundle:

```bash
pnpm build       # builds the server (tsc) + the React bundle (vite)
pnpm build:webui # just the React bundle
```

For UI development with hot reload, run the server and Vite dev side-by-side:

```bash
WALLET_PASS=... tradekit web                 # one terminal
pnpm -C webui dev                            # another; opens http://localhost:5173
```
The Vite dev server proxies `/api` to the running tradekit web (default port 3030).

## Password resolution

For commands that need to decrypt the wallet:

1. `--pass <password>`
2. `WALLET_PASS` env var
3. Interactive prompt (CLI only — never available in MCP / web)

## Supported chains

| Chain    | ID    | Native | Aggregators       |
|----------|-------|--------|-------------------|
| ethereum | 1     | ETH    | KyberSwap, OpenOcean, 0x*, 1inch* |
| base     | 8453  | ETH    | KyberSwap, OpenOcean, 0x*, 1inch* |
| arbitrum | 42161 | ETH    | KyberSwap, OpenOcean, 0x*, 1inch* |
| optimism | 10    | ETH    | KyberSwap, OpenOcean, 0x*, 1inch* |
| bnb      | 56    | BNB    | KyberSwap, OpenOcean, 0x*, 1inch* |
| polygon  | 137   | POL    | KyberSwap, OpenOcean, 0x*, 1inch* |

`*` requires an API key in config (`aggregator.apiKeys.0x` / `.1inch`).

### Custom chain

Add a chain not in the built-in list by writing to `chains.<name>` in config. Example for adding Zora (L3):

```bash
tradekit config push chains.zora '{
  "chainId": 7777777,
  "rpcs": ["https://rpc.zora.energy"],
  "explorer": "https://explorer.zora.energy",
  "nativeSymbol": "ETH",
  "weth": "0x4200000000000000000000000000000000000006",
  "usdc": "0xCccCCccc7021b32EBb4e8C08314bD62F7c653EC4"
}'
```

After: `tradekit chains` shows zora alongside the built-ins; `tradekit holdings --chains zora` queries it; trades route via the chain's profile when KyberSwap / OpenOcean support it. iter211/iter340 ensure custom chains flow into `--chains all`, `doctor --chains all`, and the trade-pair resolver.

## Safety guardrails

All checks live under `safety` in the config. Defaults:

```jsonc
{
  "safety": {
    "enabled": true,
    "maxSlippageBps": 500,         // hard cap on slippage (5%)
    "perTxUsdLimit": null,         // unset → unlimited
    "dailyUsdLimit": null,         // unset → unlimited
    "maxApprovalUsdLimit": null,   // unset → no cap on per-approval USD value
    "allowInfiniteApprovals": false, // require --force-infinite (CLI) / override=true (MCP) to grant maxUint256
    "tokenWhitelist": null,        // { "base": ["0x..."] }
    "tokenBlacklist": null,
    "contractWhitelist": null,     // restrict swap target contracts (and approval spenders)
    "gas": {                       // gas-budget guardrails (iter620). Opt-in; default off.
      "maxGasPctOfTrade": 10,     //   fail when (estimatedGasUsd / inputUsd × 100) > N. Catches "30% gas on a $5 swap" mainnet foot-shoots.
      "maxGasNativePerChain": {    //   absolute native cap per chain.
        "ethereum": 0.01,          //   never pay > 0.01 ETH for any single trade on mainnet
        "base": 0.001
      }
    },
    "minTradeIntervalMs": null,    // per-account rate limit (iter633). Set to 60000 → max 1 trade/min/account.
                                    // Catches runaway-bot loops that spam small trades within the daily USD cap.
    "positionLimits": [             // portfolio-aware caps. Each entry caps a token's weight as % of portfolio.
      { "chain": "base", "token": "ETH",  "maxPctOfPortfolio": 70 },     // don't drift over 70% ETH on base
      { "chain": "base", "token": "USDC", "minPctOfPortfolio": 10 },     // always keep ≥ 10% USDC reserve
      { "chain": "*",    "token": "WBTC", "maxPctOfPortfolio": 30 }      // 30% WBTC cap portfolio-wide
    ],
    "positionLimitsFailOnUnpriced": false, // soft-skip when oracle is down (default); set true to fail closed
    "autoTokenCheck": {                    // pre-trade auto-honeypot probe (default off)
      "enabled": true,
      "cacheTtlMs": 86400000,             // verdicts cached for 24h
      "failOnSuspicious": true,            // block on suspicious (high tax); false = warn-only
      "probeUsd": 5,                       // size of the round-trip probe
      "skipWhitelisted": true              // tokens in safety.tokenWhitelist skip the probe
    },
    "strategyBudgets": [                  // per-strategy USD spend caps (iter19; default off)
      { "tag": "playbook:*", "lifetimeUsd": 5000, "dailyUsd": 500 },
      { "tag": "arb-experiment", "perFireUsd": 50, "dailyUsd": 200 },
      { "tag": "manual-dca", "lifetimeUsd": 10000 }
    ],
    "drawdownCircuitBreaker": {           // state-aware capital-loss circuit breaker (iter20; default off)
      "enabled": true,
      "maxDrawdownPct": 15,               // trip when portfolio drops 15% below peak
      "autoResumeAtPct": null,             // null = manual reset only; else auto-clear when drawdown < N%
      "scope": "global"                    // v1 sums portfolio USD across all accounts + chains
    }
  }
}
```

**Position limits** catch portfolio-composition drift that the per-trade USD limits can't see — an agent making many small "in budget" trades can still arbitrarily concentrate the portfolio. Pre-trade the engine fetches the current portfolio, applies the predicted trade delta, and checks every matching limit against the predicted composition. The `chain: "*"` wildcard sums across chains (useful for "max 30% in WBTC anywhere"). Min-floor limits suppress when the floor was ALREADY breached pre-trade — otherwise a drifted reserve would deadlock all subsequent trading. Soft-skips with a warning when the trade or portfolio can't be priced; opt into hard-fail via `positionLimitsFailOnUnpriced: true`. Skipped entirely when `positionLimits` is empty / undefined → zero overhead for installs that don't use the feature.

**Auto-honeypot probe** catches the class of "buy works, sell reverts" tokens that slippage/USD limits are symptom-blind to. Before every trade fires (skipped on `--simulate` since dry-runs don't move funds), the engine probes the input AND output tokens via the same buy+sell roundtrip simulation that `tradekit token check` uses. The honeypot verdict always blocks with `TOKEN_BLOCKED`; the suspicious verdict (≥20% net loss on the roundtrip — high-tax tokens) blocks when `failOnSuspicious=true` and warns otherwise. Verdicts are cached per (chain, token) in the v15 `token_safety_cache` table for `cacheTtlMs` (24h default), so trades against the same token within the window pay zero probe overhead. Smart short-circuits — native, chain canonical USDC/WETH/WBTC, and operator's `safety.tokenWhitelist` skip the probe entirely. Unknown verdicts (illiquid token, aggregator outage) **fail-open** to a warning so an infra blip doesn't cascade into a tradekit-wide outage.

**Strategy budgets** scope USD spend caps to a specific `strategy` tag — orthogonal to the global per-tx and daily-USD caps. An operator running multiple playbooks can now say "this playbook can spend at most $5000 lifetime", "this experiment can spend $200/day", "this DCA leg can never exceed $50 per fire" — INDEPENDENTLY of the global caps. Three cap windows per rule, any combination:
- `lifetimeUsd`: cumulative across all-time success+pending trades
- `dailyUsd`: rolling 24h
- `perFireUsd`: per-trade ceiling (stricter than global `maxUsdPerTx`, scoped to one tag)

Tag matching supports exact strings (`arb-bot`) AND suffix wildcards (`playbook:*` matches any playbook id — composes with the playbook auto-tagging from iter12). Multiple matching rules → ALL must pass. Trades without a strategy tag skip the check entirely. Tripped budgets throw `STRATEGY_BUDGET_EXCEEDED` with structured details (tag, window, capUsd, spentUsd, predictedUsd) and `nextActions[]` pointing at `tradekit strategies --budget` for inspection.

The budget aggregator (`usdSpentUnderStrategy`) reads from the existing `trades` table — no new schema for per-strategy tracking. A v18 composite index on `(strategy, timestamp)` keeps the SUM query cheap on multi-year history. The check fires AFTER the aggregator quote (we need predicted USD) but BEFORE any state-changing call — a tripped budget never burns gas.

Live consumption is surfaced via `tradekit strategies --budget`:

```
2 strategy budgets configured:

  Tag pattern:  playbook:*
  Matches:      playbook:1, playbook:7
  Lifetime:     $1247.50 / $5000.00 (25%)  →  remaining $3752.50
  24h rolling:  $145.00 / $500.00 (29%)    →  remaining $355.00

  Tag pattern:  arb-experiment
  Lifetime:     $250.00 / $1000.00 (25%)   →  remaining $750.00
  Per-fire:     cap $50.00
```

**Drawdown circuit breaker** is the first STATE-AWARE safety primitive. Every guardrail above is **forward-looking** — it evaluates each trade against a rule and approves or rejects. None of them react to actual realized capital losses. A trailing-stop that fires too late + a DCA buying into a downtrend + a rebalance churning in volatile markets can all stay "in spec" while bleeding money. The drawdown breaker fills that gap: it tracks the operator's portfolio peak USD value over time, and when current value falls below `peak × (1 - maxDrawdownPct/100)`, refuses new trades until manually reset.

Trade-time logic:
1. After the aggregator quote, fetch the live portfolio USD across the operator's owner address (multi-chain). Reused from position limits when configured; independently fetched otherwise.
2. Look up the breaker's prior state (peak, tripped flag) from the v19 `drawdown_state` table.
3. New high → ratchet peak up, allow.
4. Within band (drawdown below threshold) → allow + update last value.
5. Crossed threshold → trip + persist `tripped_at` + throw `DRAWDOWN_CIRCUIT_BREAKER_TRIPPED`.
6. Already tripped + `autoResumeAtPct` configured + recovered past resume threshold → clear tripped flag, allow.
7. Already tripped + still in trip zone → throw.

**Fail-open on missing data**: an unpriced portfolio (oracle outage, all tokens off-listing) soft-skips the check rather than tripping the breaker — same posture as the existing per-tx USD limits. State is persistent across engine restarts; one row per scope.

Inspection + manual reset:

```bash
tradekit safety drawdown                          # current peak, last value, drawdown %, tripped state
tradekit safety reset-drawdown                    # clear tripped + re-anchor peak to last value
tradekit safety reset-drawdown --peak 5000        # clear tripped + re-anchor peak to specific value
```

Skipped on `--simulate` (dry runs don't change the trajectory). Skipped entirely when `drawdownCircuitBreaker.enabled=false` (default). Auto-resume defaults to null — the safer default since an operator should investigate WHY the breaker tripped before resuming, and a surprise auto-resume after a partial recovery could re-enable a losing strategy.

Triggered guardrails throw structured errors: `SLIPPAGE_TOO_HIGH`, `TOKEN_BLOCKED`, `CONTRACT_BLOCKED`, `AMOUNT_EXCEEDS_LIMIT`, `GAS_BUDGET_EXCEEDED`, `POSITION_LIMIT_EXCEEDED`, `STRATEGY_BUDGET_EXCEEDED`, `DRAWDOWN_CIRCUIT_BREAKER_TRIPPED`, `SAFEGUARD_TRIGGERED`. `POSITION_LIMIT_EXCEEDED` details name the exact token, current %, predicted %, and target band — operators get a one-shot remediation (resize the trade, or rebalance the offending position first). `TOKEN_BLOCKED` from the auto-honeypot path carries `autoTokenCheck: true` in details + `nextActions[]` pointing at `tradekit token check` for manual confirmation. `STRATEGY_BUDGET_EXCEEDED` details name the matched rule + tripped window, so an agent receiving the error can disposition: resize the trade, wait for the 24h window to roll, or escalate to the operator. `DRAWDOWN_CIRCUIT_BREAKER_TRIPPED` details name the scope, peak, current USD, drawdown %, and tripped_at timestamp + points the agent at `tradekit health` to investigate before clearing.

Per-trade bypass — when an operator needs to override a guardrail for one specific trade: `--force-gas` (CLI) / `forceGas: true` (MCP) for the gas budget; `--force-infinite` for infinite approvals. Bypasses land in `audit_log` with the override flag set, so post-incident review can trace every override-driven trade.

Defensive defaults: destructive MCP operations (e.g. `audit { action: "prune" }`) default to dry-run; the agent must explicitly pass `dryRun: false` to actually delete. EIP-55 checksum verification is enforced on transfer recipients and approve/revoke spenders to catch single-character paste typos before funds move.

## Agent integration

### Error shape

Every MCP tool returns either a JSON success body or, on failure, a `ToolError`:

```jsonc
{
  "ok": false,
  "error": {
    "code": "NEEDS_APPROVAL",            // stable, machine-readable
    "message": "Approval is required before the swap can be executed.",
    "details": { "token": "0x...", "spender": "0x..." }
  },
  "next_actions": [
    {
      "tool": "approve",
      "params": { "token": "0x...", "spender": "0x...", "amount": "1000000" },
      "reason": "Approval is required before the swap can be executed."
    }
  ]
}
```

Stable error codes:

```
INVALID_PARAMS UNKNOWN_CHAIN UNKNOWN_TOKEN UNKNOWN_ACCOUNT UNKNOWN_RECIPIENT
WALLET_LOCKED WALLET_NOT_FOUND WALLET_EXISTS WRONG_PASSWORD
RPC_FAILED RPC_RATE_LIMITED TX_NOT_FOUND TX_TIMEOUT TX_REVERTED
INSUFFICIENT_LIQUIDITY QUOTE_FAILED AGGREGATOR_FAILED QUOTE_DEVIATION_EXCEEDED
INSUFFICIENT_BALANCE NEEDS_APPROVAL SLIPPAGE_EXCEEDED SLIPPAGE_TOO_HIGH
SIMULATION_FAILED TRANSFER_FAILED
SAFEGUARD_TRIGGERED TOKEN_BLOCKED CONTRACT_BLOCKED
AMOUNT_EXCEEDS_LIMIT GAS_BUDGET_EXCEEDED POSITION_LIMIT_EXCEEDED
STRATEGY_BUDGET_EXCEEDED DRAWDOWN_CIRCUIT_BREAKER_TRIPPED
API_ERROR INTERNAL_ERROR
```

### MCP tool catalog (iter26)

Tools exposed via the `tradekit mcp` server, grouped by domain:

**Wallet + Account ops:** `status` `accounts` `audit` `address` `reconcile` `recent_trades` `config` `doctor` `verify` `speedup_tx` `cancel_tx` `sync_trades` `list_sync_bookmarks` `analyze_trade` `diagnose_pending`

**Data / inspection:** `chains` `gas` `price` `check_price` `holdings` `portfolio` `portfolio_snapshot` `portfolio_history` `portfolio_diff` `health` `token_info` `aggregator_stats` `pair_stats` `slippage_suggest` `strategies_list` `trending` `pnl` `viewTx`

**Trade execution:** `quote` `buy` `sell` `import_trade` `transfer` `preview_trade` `preflight_trade` `sweep_balances`

**Conditional orders + schedules + engine + rebalance:** `order_create` `order_list` `order_show` `order_cancel` `order_run` `schedule_create` `schedule_list` `schedule_show` `schedule_pause` `schedule_resume` `schedule_cancel` `schedule_run` `engine_run` `engine_status` `rebalance_create` `rebalance_list` `rebalance_show` `rebalance_pause` `rebalance_resume` `rebalance_cancel` `rebalance_run`

**Security / approvals:** `allowances` `audit_allowances` `approve` `revoke` `revoke_all` `check_token`

**Notifications:** `notify_list` `notify_test`

**Paper trading (virtual book):** `paper_balances` `paper_trades` `paper_pnl` `paper_deposit` `paper_reset`
- Manage the synthetic book that `paper: true` orders / schedules / playbooks fire against — the full dry-run loop over MCP, no real funds, no CLI fallback
- `paper_deposit` seeds/adjusts a virtual balance (mode `credit` adds, mode `set` overwrites; decimals come from the same on-chain getToken lookup the trade flow uses)
- `paper_pnl` is quote-denominated P&L per strategy via the same cores the CLI uses (numbers match across surfaces); default output is realized-only and deterministic, `mtm: true` adds cost-basis positions marked at current oracle prices (realized / unrealized / total / per-position detail)
- `paper_reset` is destructive (wipes balances + fill journal for a scope) and requires `confirm: true`; omitting both `account` and `chain` wipes the whole book

**Iter26 — strategy lifecycle (playbooks + backtests):**
- **Playbook management:** `playbook_validate` `playbook_deploy` `playbook_list` `playbook_show` `playbook_diff` `playbook_replace` `playbook_promote` `playbook_destroy`
  - All accept structured JSON specs directly (no file paths required)
  - Template support: pass `vars: { NAME: value }` to render `{{NAME}}` placeholders before validation
  - `playbook_deploy` is atomic (mid-deploy failure rolls back), idempotent on spec hash, and takes `paper: true` to deploy the whole strategy against the virtual book — the complete dry-run loop over MCP (deploy paper → watch `paper_trades` → read `paper_pnl mtm:true` → `playbook_replace` to iterate → redeploy real)
  - `playbook_diff` is the read-only preview: four buckets (unchanged/modified/added/removed), field-level changes, and per-entry `applyMode` (edit-in-place vs cancel+recreate) so an agent knows whether a change preserves trailing HWM / run counters BEFORE applying
  - `playbook_replace` applies a new spec atomically with the v2 state-preservation semantics (in-place edits where possible, run-counter carry on recreate, paper-ness inherited from owned rows); `preserve_state: false` opts into a full state reset; requires `yes: true`
  - `playbook_destroy` requires `yes: true` and cascades cancel to all owned primitives
- **Backtests:** `backtest_order` `backtest_playbook` `backtest_rebalance` `backtest_compare` `backtest_list` `backtest_show` `backtest_compare_list` `backtest_compare_show`
  - Single-strategy + multi-strategy + multi-scenario comparison
  - All persist results; `backtest_show` / `backtest_compare_show` re-render without re-fetching CoinGecko

**Iter26 — operational observability:**
- `status_dashboard` — engine + orders + schedules + rebalance + playbooks + drawdown + budgets + 24h audit dashboard with optional section filter
- `digest_summary` — windowed activity digest with 3-tier health verdict + optional comparison-vs-prior-window
- `order_replay` — forensic decision timeline for an order (requires `engine.orderJournal.enabled=true`)

**Iter26 — safety stack inspection:**
- `safety_drawdown` — drawdown circuit breaker state per scope (peak / current / drawdown % / tripped flag)
- `safety_reset_drawdown` — clear tripped flag + optionally re-anchor peak (requires `yes: true`)

Every tool returns `ok: true` on success or `isError: true` with a structured `ToolError` shape on failure. The `code` field is stable for branching; `details` carries operation-specific context; `next_actions[]` (when present) points the agent at the next tool to call.

### Success shape

**Every** MCP success response includes `ok: true` (iter889 auto-envelope). Tools that do substantive work (RPC roundtrips, external-API calls, multi-row computation, write ops) also include **`elapsedMs`** for wall-clock latency tracking — iter908-918 covers every such tool:

```jsonc
{
  "ok": true,
  "elapsedMs": 234,                       // present on RPC/API/compute tools (not on cheap reads)
  /* … tool-specific fields … */
}
```

Cheap-read tools (`chains`, `accounts list`, `strategies_list`, `address list`) omit `elapsedMs` — the work is constant-time + sub-millisecond. Agents reading `response.elapsedMs ?? 0` for latency histograms work uniformly across both categories.

**Monitoring / diagnostic tools** (`health`, `doctor`, `verify`, `reconcile`, `sync_trades`, `pnl`, `portfolio`, `token_info`, `aggregator_stats`, `pair_stats`, `audit_allowances`, `audit summary`, `diagnose_pending`) additionally include `severity` + `recommendedActions[]` for structured agent dispatch:

```jsonc
{
  "ok": true,
  "timestamp": "2026-05-30T11:24:33Z",
  "elapsedMs": 1234,
  "severity": "warn",                     // 'ok' | 'warn' | 'critical' | 'fail' (tool-dependent)
  "recommendedActions": [                 // structured NextAction[] — empty when severity='ok'
    {
      "tool": "sync_trades",
      "params": { "chain": "arbitrum", "account": "main" },
      "reason": "Bookmark for arbitrum/main hasn't advanced in 3.1d — PnL may be missing recent trades."
    },
    {
      "tool": "diagnose_pending",
      "params": { "chain": "base" },
      "reason": "1 trade still pending after reconcile — diagnose stuck txs."
    }
  ],
  /* … tool-specific fields … */
}
```

**Branch on `severity` for at-a-glance status:**

```ts
const report = await mcp.call("health");
if (report.severity === "critical") page_oncall(report);
else if (report.severity !== "ok") log_warning(report);
```

**Iterate `recommendedActions[]` to auto-remediate** without parsing prose:

```ts
for (const action of report.recommendedActions) {
  await mcp.call(action.tool, action.params);   // tool + params are dispatch-ready
}
```

Every `recommendedActions[].tool` is guaranteed to be a registered MCP tool (enforced via the iter589 invariant test).

### Pre-aggregated summary fields

List-returning tools (`holdings`, `audit list`, `accounts`, `recent_trades`, `diagnose_pending`) include a top-level `summary` object pre-computing the most-useful aggregates so agents don't have to walk the array:

```jsonc
{
  "ok": true,
  "summary": { "total": 47, "errors": 3, "byStatus": { "pending": 2, "success": 45 } },
  "items": [ /* … 47 entries … */ ]
}
```

### Install-status check

For CI / scripts wanting to verify "is tradekit configured on this host?" without depending on text output, `tradekit --json` (no positional command) returns a status object:

```jsonc
// configured (wallet exists):
{ "ok": true,  "version": "1.1.1", "node": "22.16.0", "platform": "darwin",
  "arch": "arm64", "wallet": "0xabc...", "account": "main",
  "activeChain": "base", "needsInit": false }

// not configured (no wallet):
{ "ok": false, "version": "1.1.1", "node": "22.16.0", "platform": "darwin",
  "arch": "arm64", "wallet": null, "account": null,
  "activeChain": "base", "needsInit": true,
  "hint": "Run `tradekit init` for a guided setup." }
```

Branch on `.ok` to detect the configured state, or `.needsInit` for the explicit "this install needs setup" signal. Cron / Docker entrypoints:

```bash
if tradekit --json | jq -e .ok > /dev/null; then
  tradekit health --summary --strict
else
  echo "tradekit not configured on $(hostname)" >&2; exit 1
fi
```

### Units

Units are documented in every tool description:
- `slippageBps` is basis points (50 = 0.5%)
- amounts are decimal strings ("1.5" = 1.5 ETH, not wei)
- addresses are 0x-prefixed
- USD values are numeric (not strings)
- timestamps are ISO 8601 UTC strings
- elapsed times are in milliseconds (`elapsedMs`)
- block heights and large integers are stringified BigInts (JSON-safe)

## Data storage

```
~/.tradekit/
├─ config.json       # configuration (CLI / web / MCP all share it)
├─ wallet.json       # encrypted single-key keystore (web3-eth-accounts format)
├─ mnemonic.json     # encrypted BIP-39 mnemonic keystore (scrypt + AES-256-GCM)
├─ accounts.json     # HD account label → derivation index
├─ tradekit.db       # SQLite — see tables below
└─ server.log        # rolling text log (rotates at TRADEKIT_LOG_ROTATE_BYTES, default 5MB)
```

SQLite tables (managed via numbered migrations in `db.ts`):

| Table                  | Purpose                                                                |
|------------------------|------------------------------------------------------------------------|
| `trades`               | Every executed/imported swap — base/quote, amounts, price, slippage, gas, status, tx hash, strategy tag |
| `audit_log`            | Every MCP/CLI/web invocation — caller, params, result, error code, tx hash; prunable via `audit prune` |
| `portfolio_snapshots`  | Point-in-time portfolio captures for `portfolio_diff` history series (iter618) |
| `sync_bookmarks`       | Per-(chain, account, owner) resume state for incremental `trades sync` (iter737) |
| `orders`               | Conditional / limit orders — standing intents the engine fires on price triggers; carries the fill audit trail (filled_at, fill_tx_hash, fill_price) |
| `schedules`            | Recurring / DCA schedules — cron-driven standing intents; carries `next_run_at` cursor + run telemetry (`run_count`, `total_base_filled`, `total_quote_spent`) |
| `rebalance_plans`      | Portfolio target-weight plans — declarative `{token, targetPct}[]` specs + cron cadence + drift threshold; the engine fires corrective trades when drift exceeds threshold |
| `token_safety_cache`   | Pre-trade auto-honeypot verdicts keyed on (chain, token_address) — buy+sell roundtrip probe results with TTL. Avoids re-probing on every trade |
| `backtest_runs`        | Persisted historical-strategy-simulation results. Each row = one `backtest order`/`backtest schedule`/`backtest playbook` invocation with its spec, balance, fire timeline, PnL, and `vs hold` counterfactual |
| `backtest_comparisons` | Multi-scenario backtest summaries (iter22). Each row groups N `backtest_runs` rows under a comparison name with per-scenario stats + winner index |
| `playbooks`            | Declarative multi-primitive strategy bundles. Owns child orders/schedules/rebalance plans via the `strategy = playbook:<id>` tag on each. Atomic deploy with mid-failure rollback; tear-down cascades through the same cancel paths as manual CLI |
| `drawdown_state`       | Drawdown circuit breaker state. Single row per scope tracks portfolio peak USD + tripped flag for the iter20 capital-loss circuit breaker |
| `order_check_log`      | Iter25 order decision journal. State-change-sampled rows for every active order's engine evaluation — powers `tradekit order replay <id>` |
| `engine_lock`          | Iter28 global kill switch. Single-row state (id=1) checked by every fire path; persists across engine restarts |
| `schema_version`       | Migration cursor; never touched manually                               |

File permissions: dirs `0o700`, secret files (`wallet.json`, `mnemonic.json`) `0o600`. The DB and audit log are not encrypted at rest — use full-disk encryption if the host is shared.

### Backup & restore

```bash
tradekit backup export <file> [--include-db] [--force] [--pass <pw>]
# Encrypted bundle of config.json + wallet.json + mnemonic.json + accounts.json.
# Pass --include-db to also include tradekit.db (typically MB-sized; only when
# the trade/audit history is irreplaceable). The bundle is encrypted with the
# wallet password — no separate encryption key.

tradekit backup restore <file> [--force] [--pass <pw>]
# Decrypt + restore into the data dir. Refuses to overwrite existing files
# without --force (interactive 'restore' confirm prompts when on a TTY).

tradekit verify backup <file> [--pass <pw>]
# Non-destructive integrity check: decrypts + parses + validates schema,
# does NOT write anything. Use to verify backup integrity on a different host
# before relying on it for disaster recovery.
```

The backup contract is **deliberately CLI-only** — never exposed as an MCP tool. Restore is destructive (overwrites the operator's wallet); keeping it off the agent surface is a safety boundary.

## Tests

Two test layers:

**Unit tests** (Vitest) — 55 test files, ~1370 tests covering:

- **Pure-logic units**: `safety.enforceSafety`, `decodeTx.classify`, `gas.verdictForChain`, `chains.resolveToken`, `config.setConfigPath` / `parseConfigValue`, `errors.toToolError`
- **Report composers**: `pnl`, `portfolio`, `health`, `reconcile`, `aggregatorStats`, `pairStats`, `approvalAudit`, `tokenInfo`, `activitySync`
- **DB layer**: schema migrations, query correctness, sync bookmarks, audit-log filters, portfolio snapshots
- **CLI helpers**: argv parsing, watch-mode JSONL streaming, flag-typo warnings (distance-1 Levenshtein), date filters
- **Invariants** (regression guards): every `nextAction.tool` references a registered MCP tool (iter589), every `server.tool(NAME)` is declared in `MCP_TOOLS` (iter877), every `case "X":` top-level command is in the typo-detection list (iter878)

```bash
pnpm test           # one-shot
pnpm test:watch     # watch mode
```

Tests use Vitest with `pool: "forks"` for SQLite tests (each worker gets its own DB) and `TRADEKIT_DATA_DIR` overrides for destructive-op smoke tests.

**Smoke** (bash) — integration suite that runs the built binary against the live test wallet (read-only + one simulated trade — never sends a real tx):

```bash
pnpm build
WALLET_PASS=<your-password> bash scripts/smoke.sh
```

Both are designed to be safe to run repeatedly. The smoke script self-cleans any rows it inserts so reruns are reproducible.

## License

MIT
