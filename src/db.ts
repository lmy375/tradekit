import { existsSync, readFileSync, statSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, DB_PATH, TRADE_CSV_PATH } from "./constants.js";
import { chmodSecureIfExists, ensureDataDir } from "./secureIo.js";

// ── schema ───────────────────────────────────────────────────

const MIGRATIONS: string[] = [
  // v1 — initial
  `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT    NOT NULL,
    chain           TEXT    NOT NULL,
    account         TEXT    NOT NULL DEFAULT 'default',
    direction       TEXT    NOT NULL,
    base_token      TEXT    NOT NULL,
    base_symbol     TEXT,
    base_amount     TEXT    NOT NULL,
    quote_token     TEXT    NOT NULL,
    quote_symbol    TEXT,
    quote_amount    TEXT    NOT NULL,
    price           TEXT    NOT NULL,
    tx_hash         TEXT    NOT NULL,
    status          TEXT    NOT NULL,
    gas_used        TEXT,
    gas_price_wei   TEXT,
    gas_cost_native TEXT,
    aggregator      TEXT,
    fee_tier        INTEGER,
    notes           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_trades_chain_account ON trades (chain, account);
  CREATE INDEX IF NOT EXISTS idx_trades_ts            ON trades (timestamp);
  CREATE INDEX IF NOT EXISTS idx_trades_tx_hash       ON trades (tx_hash);
  -- Iter321: composite index for dailyUsdVolume safety-check (account + timestamp,
  -- runs on every trade attempt). Pre-iter321 the leading column of
  -- idx_trades_chain_account is chain, so account-only queries fell back to
  -- scanning idx_trades_ts and filtering. Composite (account, timestamp) lets the
  -- optimizer match account=? AND timestamp>? directly. CREATE IF NOT EXISTS is
  -- idempotent so existing DBs build the index on next open.
  CREATE INDEX IF NOT EXISTS idx_trades_account_ts    ON trades (account, timestamp);

  CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT    NOT NULL,
    caller          TEXT,
    tool            TEXT    NOT NULL,
    account         TEXT,
    chain           TEXT,
    params_json     TEXT,
    simulation_json TEXT,
    result          TEXT,
    error_code      TEXT,
    error_message   TEXT,
    tx_hash         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts      ON audit_log (timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_tool    ON audit_log (tool);
  -- Iter320: indexes for the audit filter columns. recentAudit lets operators filter
  -- by account / chain / caller in addition to timestamp + tool. For DBs hitting the
  -- doctor warn-threshold (100K+ rows) a missing index meant full-table scans on
  -- those filters; reads got linearly slower as the audit grew. Idempotent CREATE
  -- INDEX IF NOT EXISTS — existing DBs auto-build on next open.
  CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log (account);
  CREATE INDEX IF NOT EXISTS idx_audit_chain   ON audit_log (chain);
  CREATE INDEX IF NOT EXISTS idx_audit_caller  ON audit_log (caller);
  `,

  // v2 — iter611: pid column for forensic distinction between concurrent
  // processes (cron + manual + MCP server + web server all writing the same
  // audit_log). Existing rows get NULL; new rows get process.pid. Indexed so
  // queries like "show me everything caller A's PID 12345 did" stay fast on
  // large audit tables.
  `
  ALTER TABLE audit_log ADD COLUMN pid INTEGER;
  CREATE INDEX IF NOT EXISTS idx_audit_pid ON audit_log (pid);
  `,

  // v3 — iter618: portfolio_snapshots for historical state. PnL captures
  // realized trades only; this table captures the FULL position state at a
  // point in time (priced + unpriced, all accounts × chains). Operators ask
  // "how has my portfolio changed since last week" — without this the answer
  // requires running aggregatePortfolio against a stale RPC snapshot. The
  // `data` column is the full PortfolioReport JSON; downstream diff helpers
  // deserialize and diff in-process.
  //
  // total_usd is denormalized for fast "biggest snapshot ever" / "value 30d
  // ago" queries without parsing the JSON blob.
  // accounts_key + chains_key are normalized sorted-comma-joined identifiers
  // of the scan scope, so an operator can query "all snapshots that scanned
  // exactly these accounts × chains" — comparing apples to apples.
  `
  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT    NOT NULL,
    total_usd     REAL,
    accounts_key  TEXT    NOT NULL,
    chains_key    TEXT    NOT NULL,
    token_count   INTEGER NOT NULL DEFAULT 0,
    note          TEXT,
    data          TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_ts ON portfolio_snapshots (timestamp);
  CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_scope ON portfolio_snapshots (accounts_key, chains_key);
  `,

  // v4 — iter635: block_number column for receipt block tracking. Foundational
  // for iter628 reorg detection (no need to re-query the chain for every
  // success trade — block_number lets reorg-depth filtering happen at query
  // time) + future confirmation-depth checks. Additive: existing rows get
  // NULL; new rows that complete via the success path get the receipt's
  // blockNumber. Indexed so reorg-depth queries ("show me trades from blocks
  // 12345678..head") stay fast on multi-year trade history.
  `
  ALTER TABLE trades ADD COLUMN block_number INTEGER;
  CREATE INDEX IF NOT EXISTS idx_trades_block ON trades (block_number);
  `,

  // v5 — iter641: realized_slippage_bps column. Pre-iter641 iter623
  // aggregator stats and iter634 pair stats had to call iter619 analyzeStored-
  // Trade on every success row to compute realized slippage — that's a per-
  // row RPC roundtrip for `getTransactionReceipt` + `getTransaction`. On a
  // multi-month trade history this is painful (50+ rows × ~300ms each).
  //
  // Persisting the slippage at trade time (when we already have the decoded
  // receipt) makes downstream queries near-instant. Legacy rows + import-only
  // rows + reverted rows stay NULL; consumers fall back to live analysis only
  // when needed. Storing as REAL (not INTEGER) preserves sub-bp precision
  // operators might tune against.
  `
  ALTER TABLE trades ADD COLUMN realized_slippage_bps REAL;
  `,

  // v6 — iter646: gas_cost_usd_at_trade column. Pre-iter646 PnL math valued
  // gas USD using the CURRENT native price for ALL trades. That's wrong for
  // historical accuracy — a trade that paid 0.005 ETH gas at $3500/ETH last
  // month cost $17.50 then, not $15 (if ETH is $3000 today). Tax reports,
  // strategy attribution, period-over-period PnL comparisons all need the
  // trade-time USD value.
  //
  // Stored as REAL; NULL for legacy rows + pending + failed-before-receipt +
  // import rows where we have no native-price-at-time-of-block data. PnL
  // math prefers stored when available, falls back to live native × current
  // native price for legacy rows. iter637-style backfill comes later (would
  // require historical price queries which CoinGecko bills for).
  `
  ALTER TABLE trades ADD COLUMN gas_cost_usd_at_trade REAL;
  `,

  // v7 — iter648: strategy tag column. Operators run multiple strategies
  // (DCA, swing, manual arb) concurrently and want PnL scoped per strategy.
  // The `notes` field is free-text; a structured `strategy` column enables
  // fast cross-cut queries via index. Indexed so `trades --strategy dca` and
  // `pnl --strategy dca` stay cheap on multi-year history.
  `
  ALTER TABLE trades ADD COLUMN strategy TEXT;
  CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades (strategy);
  `,

  // v8 — iter669: persisted revert reason for failed trades. Reconcile
  // extracts the reason via eth_call replay (iter666 logic) when it observes
  // a failed receipt and writes it here. Stored avoids the per-analyze RPC
  // roundtrip — same pattern as iter641 stored slippage. NULL for: success
  // rows, pending rows, legacy failed rows pre-iter669, and rows where the
  // replay couldn't extract a reason. Not indexed: we expect to read by
  // tx_hash or scan failed rows for a window — neither benefits from an
  // index, and the column will be NULL for the vast majority of rows.
  `
  ALTER TABLE trades ADD COLUMN revert_reason TEXT;
  `,

  // v9 — iter737: sync_bookmarks per (chain, account, owner). Pre-iter737 a
  // daily cron running `tradekit trades sync` rescanned the full 30-day
  // default window every night — 96% wasted RPC work since 29 of those 30
  // days had been imported on prior runs (idempotent dedup absorbs it, but
  // it's still a lot of eth_getLogs traffic and the public-RPC rate limits
  // eventually push back). The bookmark records the highest block scanned
  // successfully so the next sync resumes from there.
  //
  // Why owner in the PK: an operator who rotates the mnemonic backing an
  // account label (e.g. label "main" derivation changes) gets a different
  // address. If the bookmark were keyed only on (chain, account) the new
  // address's history before the old bookmark would be silently skipped.
  // Keying on owner makes the rotation safe: lookup against the new address
  // returns null, sync falls back to the 30d default for the first run.
  //
  // updated_at is ISO-8601 — useful for the diagnostic listing helper and
  // for spotting bookmarks that haven't moved in a long time (i.e. account
  // no longer syncing). last_synced_block is the toBlock of the most recent
  // FULLY successful sync (no chunkErrors); a partial-success sync leaves
  // the bookmark alone so the operator can retry without losing coverage.
  `
  CREATE TABLE IF NOT EXISTS sync_bookmarks (
    chain              TEXT    NOT NULL,
    account            TEXT    NOT NULL,
    owner              TEXT    NOT NULL,
    last_synced_block  INTEGER NOT NULL,
    updated_at         TEXT    NOT NULL,
    PRIMARY KEY (chain, account, owner)
  );
  `,

  // v10 — conditional/limit orders. Tradekit pre-v10 only executes immediate
  // market swaps via the aggregators; an operator who wanted "buy ETH at 2900"
  // had to script `--watch` around `price` + `trade buy`, which is brittle
  // (no atomic state, no expiry, no audit). This table holds the standing
  // intents off-chain; the order engine (src/orders.ts) polls each active
  // row's current price against the trigger and routes filled triggers
  // through the existing executeTrade flow (so every guardrail, audit, and
  // structured-error pathway is inherited verbatim).
  //
  // Status lifecycle:
  //   active   → engine considers this row on every tick
  //   filled   → engine triggered + executeTrade succeeded; fill_tx_hash + fill_price recorded
  //   cancelled → operator cancelled via `order cancel`
  //   expired  → engine observed now >= expires_at on a tick; never fired
  //   failed   → executeTrade reverted or threw a non-retryable error; last_error_* recorded
  //
  // Indexes:
  //   - idx_orders_status: status='active' scans on every tick — must be fast
  //   - idx_orders_account / idx_orders_chain: per-account / per-chain listings
  //   - idx_orders_expires: future "expire stale orders" sweep
  `
  CREATE TABLE IF NOT EXISTS orders (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at           TEXT    NOT NULL,
    updated_at           TEXT    NOT NULL,
    status               TEXT    NOT NULL,
    side                 TEXT    NOT NULL,
    trigger_type         TEXT    NOT NULL,
    target_price_usd     REAL    NOT NULL,
    chain                TEXT    NOT NULL,
    account              TEXT    NOT NULL,
    base_token           TEXT    NOT NULL,
    base_symbol          TEXT,
    quote_token          TEXT    NOT NULL,
    quote_symbol         TEXT,
    base_amount          TEXT,
    quote_amount         TEXT,
    slippage_bps         INTEGER,
    auto_slippage        INTEGER NOT NULL DEFAULT 0,
    expires_at           TEXT,
    strategy             TEXT,
    note                 TEXT,
    attempts             INTEGER NOT NULL DEFAULT 0,
    last_checked_at      TEXT,
    last_checked_price   REAL,
    last_error_code      TEXT,
    last_error_message   TEXT,
    filled_at            TEXT,
    fill_tx_hash         TEXT,
    fill_price           REAL,
    fill_base_amount     TEXT,
    fill_quote_amount    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders (status);
  CREATE INDEX IF NOT EXISTS idx_orders_account  ON orders (account);
  CREATE INDEX IF NOT EXISTS idx_orders_chain    ON orders (chain);
  CREATE INDEX IF NOT EXISTS idx_orders_expires  ON orders (expires_at);
  CREATE INDEX IF NOT EXISTS idx_orders_strategy ON orders (strategy);
  `,

  // v11 — scheduled / recurring trades (DCA primitive).
  //
  // Sibling to `orders` rather than a column overlay because the semantics
  // diverge meaningfully: orders fire ONCE per row (filled/failed/expired
  // terminal); schedules fire MANY times per row with running totals and
  // a next_run_at cursor. Forcing the two into one table would need a
  // dual-mode lifecycle that no current query benefits from.
  //
  // Fields:
  //   cron_expr         5-field UTC cron (parsed in src/cron.ts)
  //   next_run_at       cached nextRun(parsed, now) result — recomputed on
  //                     every fire so the engine can SELECT WHERE next_run_at
  //                     <= now without parsing on every tick
  //   start_at / end_at optional bounds; engine skips fires outside the window
  //   max_runs          optional cap on lifetime fires; engine marks the
  //                     schedule "completed" when reached
  //   run_count         running counter; useful for partial-DCA progress UI
  //   total_*_filled    running totals (decimal strings) so a quick scan over
  //                     a schedule history shows "how much have I bought"
  //                     without joining against trades
  //   last_run_*        last-fire telemetry; populated even when last_run_status
  //                     is "failed" so the operator can see the error trail
  //                     without joining audit_log
  //
  // Status lifecycle: active → (paused → active loop)*
  //                   active → completed (max_runs reached or past end_at)
  //                   active → cancelled (operator action)
  `
  CREATE TABLE IF NOT EXISTS schedules (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at           TEXT    NOT NULL,
    updated_at           TEXT    NOT NULL,
    status               TEXT    NOT NULL,
    name                 TEXT,
    cron_expr            TEXT    NOT NULL,
    next_run_at          TEXT    NOT NULL,
    side                 TEXT    NOT NULL,
    chain                TEXT    NOT NULL,
    account              TEXT    NOT NULL,
    base_token           TEXT    NOT NULL,
    base_symbol          TEXT,
    quote_token          TEXT    NOT NULL,
    quote_symbol         TEXT,
    base_amount          TEXT,
    quote_amount         TEXT,
    slippage_bps         INTEGER,
    auto_slippage        INTEGER NOT NULL DEFAULT 0,
    start_at             TEXT,
    end_at               TEXT,
    max_runs             INTEGER,
    strategy             TEXT,
    note                 TEXT,
    run_count            INTEGER NOT NULL DEFAULT 0,
    last_run_at          TEXT,
    last_run_tx_hash     TEXT,
    last_run_status      TEXT,
    last_error_code      TEXT,
    last_error_message   TEXT,
    total_base_filled    TEXT,
    total_quote_spent    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_schedules_status   ON schedules (status);
  CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules (next_run_at);
  CREATE INDEX IF NOT EXISTS idx_schedules_account  ON schedules (account);
  CREATE INDEX IF NOT EXISTS idx_schedules_chain    ON schedules (chain);
  CREATE INDEX IF NOT EXISTS idx_schedules_strategy ON schedules (strategy);
  `,

  // v12 — trailing stops on the orders engine.
  //
  // Adds two columns + loosens one NOT NULL:
  //   - trail_pct        REAL nullable. % retracement that triggers the
  //                      order (e.g. 5 = 5%). NULL on non-trailing orders.
  //                      Required on trailing orders (application-layer).
  //   - water_mark_usd   REAL nullable. The running high (sells) / low
  //                      (buys) price observed since trail activation.
  //                      Updated by the engine on every tick where the
  //                      order is active + tracking. NULL until first
  //                      tracking tick lands.
  //   - target_price_usd REAL nullable (was NOT NULL). For trailing
  //                      orders this is the optional activation gate —
  //                      the engine won't start tracking the water mark
  //                      until current price ≥ target (sell trails) or
  //                      ≤ target (buy trails). NULL means "trail from
  //                      creation time". For legacy price_below/above
  //                      orders this column retains its meaning as the
  //                      trigger threshold and is always populated
  //                      (validated at create time).
  //
  // SQLite can't ALTER COLUMN to change a NOT NULL constraint, so we do
  // the standard table-rebuild dance: create _new with the loosened
  // schema, copy rows preserving every field, drop the old table, rename
  // _new to orders, recreate indexes. The orders table is small (≤ a few
  // thousand rows even on long-running installs) so the copy is cheap.
  //
  // foreign_keys=ON is configured in openDb, so we wrap in
  // foreign_keys=OFF for the migration window — orders has no FKs but
  // SQLite's official table-rebuild guide recommends the toggle defensively.
  `
  PRAGMA foreign_keys = OFF;

  CREATE TABLE orders_new (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at           TEXT    NOT NULL,
    updated_at           TEXT    NOT NULL,
    status               TEXT    NOT NULL,
    side                 TEXT    NOT NULL,
    trigger_type         TEXT    NOT NULL,
    target_price_usd     REAL,
    trail_pct            REAL,
    water_mark_usd       REAL,
    chain                TEXT    NOT NULL,
    account              TEXT    NOT NULL,
    base_token           TEXT    NOT NULL,
    base_symbol          TEXT,
    quote_token          TEXT    NOT NULL,
    quote_symbol         TEXT,
    base_amount          TEXT,
    quote_amount         TEXT,
    slippage_bps         INTEGER,
    auto_slippage        INTEGER NOT NULL DEFAULT 0,
    expires_at           TEXT,
    strategy             TEXT,
    note                 TEXT,
    attempts             INTEGER NOT NULL DEFAULT 0,
    last_checked_at      TEXT,
    last_checked_price   REAL,
    last_error_code      TEXT,
    last_error_message   TEXT,
    filled_at            TEXT,
    fill_tx_hash         TEXT,
    fill_price           REAL,
    fill_base_amount     TEXT,
    fill_quote_amount    TEXT
  );

  INSERT INTO orders_new (
    id, created_at, updated_at, status, side, trigger_type, target_price_usd,
    trail_pct, water_mark_usd,
    chain, account, base_token, base_symbol, quote_token, quote_symbol,
    base_amount, quote_amount, slippage_bps, auto_slippage,
    expires_at, strategy, note, attempts,
    last_checked_at, last_checked_price, last_error_code, last_error_message,
    filled_at, fill_tx_hash, fill_price, fill_base_amount, fill_quote_amount
  )
  SELECT
    id, created_at, updated_at, status, side, trigger_type, target_price_usd,
    NULL, NULL,
    chain, account, base_token, base_symbol, quote_token, quote_symbol,
    base_amount, quote_amount, slippage_bps, auto_slippage,
    expires_at, strategy, note, attempts,
    last_checked_at, last_checked_price, last_error_code, last_error_message,
    filled_at, fill_tx_hash, fill_price, fill_base_amount, fill_quote_amount
  FROM orders;

  DROP TABLE orders;
  ALTER TABLE orders_new RENAME TO orders;

  CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders (status);
  CREATE INDEX IF NOT EXISTS idx_orders_account  ON orders (account);
  CREATE INDEX IF NOT EXISTS idx_orders_chain    ON orders (chain);
  CREATE INDEX IF NOT EXISTS idx_orders_expires  ON orders (expires_at);
  CREATE INDEX IF NOT EXISTS idx_orders_strategy ON orders (strategy);

  PRAGMA foreign_keys = ON;
  `,

  // v13 — portfolio rebalance plans.
  //
  // Sibling to orders + schedules: declarative target-weight specs that the
  // engine periodically evaluates + corrects toward. Each plan covers one
  // chain + one account (multi-chain operators create one plan per chain
  // — keeps the trade-routing decision tree small).
  //
  // Fields:
  //   targets_json         JSON-serialized [{ token, targetPct }]. Validated at
  //                        create time: sum == 100, no negatives, no dupes.
  //                        token can be a symbol ("ETH", "USDC") or a 0x-address.
  //   quote_token          The stable anchor used to route every rebalance trade
  //                        (sell over-weight → quote, then quote → buy under-weight).
  //                        Defaults to the chain profile's usdc; can be overridden
  //                        per plan (e.g. an operator who prefers USDT as anchor).
  //   drift_threshold_pct  Min drift (any target's |current% - target%|) that
  //                        triggers a rebalance fire. Default 5%. Avoids
  //                        constant micro-rebalancing on minor price moves.
  //   min_trade_usd        Per-leg minimum trade size. Trades below this skip
  //                        (gas cost would dominate the correction). Default $10.
  //   cron_expr / next_run_at / start_at / end_at / max_runs
  //     Same cadence model as schedules — reuses src/cron.ts parser.
  //   last_run_*           Telemetry from the most recent tick.
  //
  // Status lifecycle: active → (paused → active loop)*
  //                   active → completed (max_runs reached or past end_at)
  //                   active → cancelled (operator action)
  `
  CREATE TABLE IF NOT EXISTS rebalance_plans (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at               TEXT    NOT NULL,
    updated_at               TEXT    NOT NULL,
    status                   TEXT    NOT NULL,
    name                     TEXT,
    account                  TEXT    NOT NULL,
    chain                    TEXT    NOT NULL,
    quote_token              TEXT    NOT NULL,
    quote_symbol             TEXT,
    targets_json             TEXT    NOT NULL,
    drift_threshold_pct      REAL    NOT NULL,
    min_trade_usd            REAL    NOT NULL,
    cron_expr                TEXT    NOT NULL,
    next_run_at              TEXT    NOT NULL,
    start_at                 TEXT,
    end_at                   TEXT,
    max_runs                 INTEGER,
    slippage_bps             INTEGER,
    auto_slippage            INTEGER NOT NULL DEFAULT 0,
    strategy                 TEXT,
    note                     TEXT,
    run_count                INTEGER NOT NULL DEFAULT 0,
    last_run_at              TEXT,
    last_run_status          TEXT,
    last_run_executed_count  INTEGER,
    last_run_skipped_count   INTEGER,
    last_run_max_drift_pct   REAL,
    last_error_code          TEXT,
    last_error_message       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rebalance_status   ON rebalance_plans (status);
  CREATE INDEX IF NOT EXISTS idx_rebalance_next_run ON rebalance_plans (next_run_at);
  CREATE INDEX IF NOT EXISTS idx_rebalance_account  ON rebalance_plans (account);
  CREATE INDEX IF NOT EXISTS idx_rebalance_chain    ON rebalance_plans (chain);
  CREATE INDEX IF NOT EXISTS idx_rebalance_strategy ON rebalance_plans (strategy);
  `,

  // v14 — OCO (One-Cancels-Other) order groups.
  //
  // Single nullable string column on the orders table. Orders sharing a
  // non-null group_id are OCO peers: when ANY peer transitions to a
  // terminal state via the engine (filled / failed / expired), the
  // engine cancels the remaining ACTIVE peers in the group.
  //
  // Operator-driven cancel does NOT cascade by default (manual cancel
  // is intentional; cascading would surprise an operator updating one
  // leg). A separate `--cascade` flag opts in to that behavior.
  //
  // group_id is intentionally a free-form string (not a FK to a
  // dedicated groups table). Operators write "take-profit-or-stop" or
  // "btc-exit-ladder" and the matching is exact-string. This avoids
  // schema overhead for what is fundamentally an OPERATOR-tagged
  // grouping concept — no constraint that the orders share chain /
  // account / direction (operators can group cross-direction sells
  // at different price levels, or cross-chain exits of the same
  // notional position).
  //
  // Index: groups are queried two ways — "find active peers of order X"
  // (used in cascade) and "list orders in group Y" (used by CLI/MCP
  // filter). Both benefit from a plain group_id index.
  `
  ALTER TABLE orders ADD COLUMN group_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_orders_group_id ON orders (group_id);
  `,

  // v15 — pre-trade auto token-safety cache.
  //
  // When `safety.autoTokenCheck.enabled=true` is set, every trade
  // (orders / schedules / rebalance / manual buy-sell) probes the
  // input + output tokens via `tokenSafety.checkTokenSafety` BEFORE
  // hitting the aggregator. The probe is expensive (2 aggregator
  // quotes + 2 eth_calls), so verdicts are cached here keyed on
  // (chain, token_address). TTL defaults to 24h.
  //
  // Schema:
  //   chain          — lowercase chain name
  //   token_address  — lowercased 0x address (NATIVE is whitelisted
  //                    and never cached)
  //   verdict        — "ok" | "suspicious" | "honeypot" | "unknown"
  //   details_json   — full TokenSafetyReport (~1KB) for forensic
  //                    inspection via `tradekit token check`
  //   checked_at     — ISO timestamp when the probe ran
  //   expires_at     — ISO timestamp; rows with expires_at < now are
  //                    treated as cache-miss + re-probed on next trade
  //   probe_usd      — USD size the probe used (for replay)
  //
  // The cache is a pure read-through: at trade time we SELECT WHERE
  // chain=? AND token_address=? AND expires_at > now. On hit, the
  // cached verdict gates the trade. On miss, we run the probe + INSERT
  // OR REPLACE the row. No background GC needed — expired rows just
  // get overwritten on the next probe.
  //
  // Idx: composite PK serves the lookup directly; no secondary indexes.
  // Volume is small (one row per (chain, token) ever traded — typically
  // < 100 rows even on busy installs).
  `
  CREATE TABLE IF NOT EXISTS token_safety_cache (
    chain          TEXT NOT NULL,
    token_address  TEXT NOT NULL,
    verdict        TEXT NOT NULL,
    details_json   TEXT,
    probe_usd      REAL,
    checked_at     TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    PRIMARY KEY (chain, token_address)
  );
  `,

  // v16 — backtest runs. Historical strategy simulation. `tradekit backtest
  // order` / `tradekit backtest schedule` replays an order or schedule
  // against a CoinGecko market-chart price series + a starting balance, and
  // persists the result here so it can be re-inspected via `backtest show
  // <id>` without re-fetching the price data.
  //
  // Schema:
  //   strategy_type   — "order" | "schedule"  (rebalance deferred)
  //   chain           — lowercase chain name the strategy targets
  //   base_symbol     — base token symbol (e.g. "ETH")
  //   quote_symbol    — quote token symbol (e.g. "USDC")
  //   spec_json       — full strategy spec the operator supplied
  //                     (OrderSpec or ScheduleSpec) for re-runs +
  //                     auditability
  //   initial_balance_json — {[symbol]: amount} as the operator gave it
  //   final_balance_json   — {[symbol]: amount} after the simulation
  //   window_start    — ISO timestamp of the first price point used
  //   window_end      — ISO timestamp of the last price point used
  //   points          — number of price datapoints in the series (so
  //                     re-runs can detect data-density mismatch)
  //   fires_json      — Array<{ts, action, priceUsd, baseDelta, quoteDelta}>
  //                     — every simulated fire in chronological order
  //   fire_count      — denormalized for `backtest list` ordering
  //   pnl_usd         — final USD value − initial USD value (using
  //                     window-end price as the snapshot price)
  //   hold_pnl_usd    — counterfactual: if no trades had fired, what
  //                     would PnL have been? Lets the operator see
  //                     whether the strategy actually outperformed
  //                     a passive hold over the window.
  //   notes           — free-form (e.g. "halted at ts X — insufficient
  //                     balance")
  //   created_at      — when the backtest was run
  //
  // No indexes beyond the PK: backtest result sets are small (operator
  // runs a handful per session; even on a busy install < 10K rows).
  // `created_at DESC` is the only common query and SQLite handles small
  // tables fine without an index.
  `
  CREATE TABLE IF NOT EXISTS backtest_runs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_type         TEXT NOT NULL,
    chain                 TEXT NOT NULL,
    base_symbol           TEXT NOT NULL,
    quote_symbol          TEXT NOT NULL,
    spec_json             TEXT NOT NULL,
    initial_balance_json  TEXT NOT NULL,
    final_balance_json    TEXT NOT NULL,
    window_start          TEXT NOT NULL,
    window_end            TEXT NOT NULL,
    points                INTEGER NOT NULL,
    fires_json            TEXT NOT NULL,
    fire_count            INTEGER NOT NULL,
    pnl_usd               REAL NOT NULL,
    hold_pnl_usd          REAL NOT NULL,
    notes                 TEXT,
    created_at            TEXT NOT NULL
  );
  `,

  // v17 — playbooks. Declarative multi-primitive strategy bundles. A
  // playbook is a JSON spec listing orders / schedules / rebalance plans
  // that should be deployed atomically together. The playbook row
  // tracks the deployment lifecycle (deploying → deployed → destroyed)
  // and links to the primitives it owns via the existing `strategy`
  // column on each table (stamped as "playbook:<id>"). The OCO group
  // namespace is similarly prefixed ("pb<id>-<localname>") so two
  // playbooks with `"group": "bracket"` don't accidentally cross-cancel.
  //
  // Schema:
  //   name           — operator-facing label (e.g. "eth-bracket-with-dca").
  //                    Must be unique across non-destroyed playbooks (the
  //                    deploy helper enforces this — UNIQUE index would
  //                    prevent re-using a name after destroy, which is
  //                    legitimate).
  //   source_path    — relative path the operator pointed `playbook
  //                    deploy` at, for forensic reference
  //   source_hash    — sha256 of the canonical spec JSON. The deploy
  //                    helper checks this against an existing
  //                    not-destroyed row with the same name; matching
  //                    hash = no-op (idempotent), differing hash =
  //                    error (destroy first).
  //   spec_json      — full parsed spec
  //   status         — 'deploying' | 'deployed' | 'destroyed' | 'failed'.
  //                    'deploying' is the brief window during
  //                    create-all; if it survives a process crash, the
  //                    rollback path in deployPlaybook makes the row
  //                    'failed' or removes it entirely.
  //   deployed_at    — ISO timestamp of successful deploy
  //   destroyed_at   — ISO timestamp of teardown
  //
  // No FK to the primitive tables — owning is by string-match on the
  // primitive's `strategy` column. This avoids a 3-way join + lets the
  // playbook layer evolve without touching the primitive schemas.
  `
  CREATE TABLE IF NOT EXISTS playbooks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    source_path  TEXT,
    source_hash  TEXT NOT NULL,
    spec_json    TEXT NOT NULL,
    status       TEXT NOT NULL,
    deployed_at  TEXT NOT NULL,
    destroyed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_playbooks_name   ON playbooks (name);
  CREATE INDEX IF NOT EXISTS idx_playbooks_status ON playbooks (status);
  `,

  // v18 — strategy-budget enforcement index. The new safety layer
  // (safety.strategyBudgets) queries `SUM(quote_amount) FROM trades
  // WHERE strategy = ? AND status IN ('success','pending')` on every
  // trade attempt under a tagged strategy. Without an index on
  // (strategy, timestamp), the query falls back to scanning
  // idx_trades_ts and filtering — fine at 1K rows, painful at 100K+.
  //
  // Composite (strategy, timestamp) covers both the lifetime query
  // (WHERE strategy = ?) and the 24h-window query (WHERE strategy = ?
  // AND timestamp > ?). CREATE IF NOT EXISTS is idempotent so existing
  // DBs build the index on next open without a backfill step.
  //
  // No new table — the budget layer reads from `trades` directly,
  // using the existing quote_amount column for the USD aggregate
  // (matching the convention dailyUsdVolume already uses).
  `
  CREATE INDEX IF NOT EXISTS idx_trades_strategy_ts ON trades (strategy, timestamp);
  `,

  // v19 — drawdown circuit breaker state.
  //
  // Tracks the portfolio peak USD value + the current tripped state
  // for the safety.drawdownCircuitBreaker feature. Keyed on a scope
  // string ("global" in v1; "account:NAME" / "chain:NAME" reserved
  // for future scope variants).
  //
  // Schema:
  //   scope_key      — composite scope identifier (e.g. "global")
  //   peak_usd       — high-water-mark portfolio USD value
  //   peak_at        — ISO timestamp when peak was last updated
  //   tripped_at     — ISO timestamp when the breaker tripped (NULL
  //                    when not tripped). Used to distinguish "fresh
  //                    install" from "tripped + sitting" at lookup
  //                    time.
  //   last_value_usd — most recent observed portfolio USD; surfaces
  //                    in `tradekit safety drawdown` without forcing a
  //                    portfolio refetch
  //   updated_at     — ISO timestamp of last row write
  //
  // Single-row-per-scope by design — the breaker is stateful but the
  // state is cheap (one row). No historical journal; operators wanting
  // a peak-history view should use portfolio_snapshots (iter618)
  // which captures full state at snapshot time.
  //
  // No FK to portfolio_snapshots — the breaker's peak is independent
  // of the snapshot history (it updates on every trade, not just on
  // manual snapshot commands). The two systems coexist with different
  // refresh cadences.
  `
  CREATE TABLE IF NOT EXISTS drawdown_state (
    scope_key       TEXT PRIMARY KEY,
    peak_usd        REAL NOT NULL,
    peak_at         TEXT NOT NULL,
    tripped_at      TEXT,
    last_value_usd  REAL,
    updated_at      TEXT NOT NULL
  );
  `,

  // v20 — backtest comparison runs. Each row represents one `backtest
  // compare` invocation across N scenarios. The individual scenario
  // results are persisted as regular `backtest_runs` rows (with
  // strategy_type='playbook'); this table stores the comparison-level
  // metadata so `backtest compare show <id>` can re-render the table
  // without re-running the simulations.
  //
  // Schema:
  //   name            — operator-facing label (from scenarios file's
  //                     top-level `name` or auto-generated)
  //   scenarios_json  — full scenarios input for forensic replay
  //   results_json    — Array<{scenarioName, runId, pnlUsd,
  //                     holdPnlUsd, fireCount, finalStatus}> — denorm
  //                     of the per-scenario outcome so list/show
  //                     don't need to join backtest_runs
  //   run_ids         — comma-joined ids of the underlying
  //                     backtest_runs rows; lets `compare show` link
  //                     to the full per-scenario detail
  //   base_symbol     — shared base (every scenario must reference
  //                     the same pair; comparison only makes sense
  //                     on one price series)
  //   quote_symbol    — shared quote
  //   chain           — shared chain
  //   window_start    — ISO timestamp of the first price point used
  //   window_end      — ISO timestamp of the last price point used
  //   winner_idx      — index into the scenarios array naming the
  //                     highest-pnl scenario; null if all scenarios
  //                     halted before any fill
  //   created_at      — when the comparison was run
  //
  // No FK to backtest_runs — the relation is by id list in `run_ids`,
  // so the comparison row stays usable even if individual run rows
  // are pruned (which doesn't happen today but keeps options open).
  `
  CREATE TABLE IF NOT EXISTS backtest_comparisons (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    scenarios_json  TEXT NOT NULL,
    results_json    TEXT NOT NULL,
    run_ids         TEXT NOT NULL,
    base_symbol     TEXT NOT NULL,
    quote_symbol    TEXT NOT NULL,
    chain           TEXT NOT NULL,
    window_start    TEXT NOT NULL,
    window_end      TEXT NOT NULL,
    winner_idx      INTEGER,
    created_at      TEXT NOT NULL
  );
  `,

  // v21 — order decision journal. Persistent record of state-changing
  // evaluations on conditional orders. Powers `tradekit order replay
  // <id>` — operators answer "why did this fire here and not earlier?"
  //
  // Sampling strategy: write a row ONLY when the order's evaluation
  // state changes from the prior row (HWM advanced, proximity crossed,
  // fired, errored). The orders engine ticks every 30s; naively
  // logging every tick at ~10 active orders produces 10M+ rows/year.
  // State-change sampling yields typically 5-20 rows per order's full
  // lifecycle — same forensic signal at <1% of the cardinality.
  //
  // Schema:
  //   order_id        — FK-style to orders.id (not enforced as FK to
  //                     stay decoupled if orders are pruned)
  //   checked_at      — ISO timestamp of the engine tick that produced
  //                     this entry
  //   price_usd       — current price observed at this tick
  //   water_mark_usd  — trailing order's HWM/LWM AFTER this tick's
  //                     update; null for non-trailing orders or
  //                     trailing orders pre-activation
  //   threshold_usd   — derived fire threshold; null when not
  //                     applicable (pre-activation, missing target)
  //   decision        — one of seven decision states (see
  //                     OrderCheckDecision in orderJournal.ts)
  //   notes           — optional free-form (error message, peer cascade
  //                     reason, etc.)
  //
  // Indexed on (order_id, checked_at) — the only query is "give me
  // the timeline for order N sorted by time". No secondary indexes;
  // pruning is by retention age, not by complex predicates.
  //
  // Pruning: doctor-driven via the existing audit prune surface. v1
  // doesn't auto-prune; operators run pruneOrderCheckLog when needed.
  `
  CREATE TABLE IF NOT EXISTS order_check_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER NOT NULL,
    checked_at      TEXT NOT NULL,
    price_usd       REAL,
    water_mark_usd  REAL,
    threshold_usd   REAL,
    decision        TEXT NOT NULL,
    notes           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_order_check_log_order_ts ON order_check_log (order_id, checked_at);
  `,

  // v22 — schedule post-fill hooks. When a schedule fires
  // successfully, optionally execute a hook action declared at
  // schedule-create time. v1 supports the highest-value action:
  // auto-create a follow-up order with template variables
  // (`{{filled.baseAmount}}`, `{{filled.fillPriceUsd}}`, etc.).
  //
  // Schema change: nullable column on the existing `schedules`
  // table. Existing rows have NULL → unchanged behavior. Operators
  // who want the feature opt in by passing `--on-fill` at schedule
  // create.
  //
  // The hook spec validation happens at schedule-create time (fake-
  // fill rendered through createOrderRow); execution happens after
  // each successful fire (real fill data substituted). Hook failures
  // do NOT unwind the fill — the trade already happened, partial
  // recovery is correct.
  `
  ALTER TABLE schedules ADD COLUMN on_fill_json TEXT;
  `,

  // v23 — engine lock / global fail-safe mode.
  //
  // Single-row table (id always = 1). Acts as the kill switch for
  // ALL trading paths: orders engine, schedules engine, rebalance
  // engine, manual trades via executeTrade, and post-fill hooks.
  //
  // Why a table instead of a config field: engines tick continuously;
  // a config-based lock would require process restart or a separate
  // hot-reload mechanism. A DB row is queried per tick (~µs cost
  // with the integer PK) and changes propagate instantly.
  //
  // Schema:
  //   id          — always 1; CHECK constraint enforces single-row
  //   active      — 0 (unlocked) | 1 (locked). INTEGER for SQLite
  //                 boolean idioms.
  //   reason      — operator-supplied free-text rationale for the
  //                 lock. Surfaced in status, notifications, and
  //                 ENGINE_LOCKED errors so incident responders
  //                 know WHY when they hit a rejection.
  //   locked_at   — ISO timestamp of when the lock was set (NULL
  //                 when unlocked).
  //   locked_by   — caller label (cli / mcp / web / engine). NULL
  //                 when unlocked.
  //   updated_at  — ISO timestamp of the most recent row write.
  //
  // Read pattern: every engine tick + every executeTrade call
  // queries this row. Reads are typically faster than the bigint
  // arithmetic in the same tick path, so the overhead is negligible.
  //
  // Pre-seeded with id=1, active=0 so the predicate always has a
  // row to read.
  `
  CREATE TABLE IF NOT EXISTS engine_lock (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    active      INTEGER NOT NULL DEFAULT 0,
    reason      TEXT,
    locked_at   TEXT,
    locked_by   TEXT,
    updated_at  TEXT NOT NULL
  );
  INSERT OR IGNORE INTO engine_lock (id, active, updated_at)
    VALUES (1, 0, '1970-01-01T00:00:00Z');
  `,

  // v24 — paper trading mode.
  //
  // Per-primitive `paper` flag on orders + schedules. When 1, the
  // engine routes the FIRE step to a virtual book (paper_trades +
  // paper_balances) instead of executeTrade — orders/schedules still
  // tick normally (price polling, trigger eval, HWM tracking) but
  // never submit a real transaction.
  //
  // Use case: validate a new strategy against REAL-TIME market
  // conditions (price volatility, real aggregator quotes) without
  // risking real capital. Bridges the gap between historical
  // backtests (iter16) and live deployment.
  //
  // Schema:
  //   - paper column on orders + schedules (rebalance deferred to v2)
  //   - paper_trades:   mirrors `trades` shape; carries source_type
  //                     + source_id for attribution
  //   - paper_balances: per-account-chain-token virtual balance map
  //
  // Backward compat: paper defaults to 0 → existing primitives are
  // unaffected. New tables empty by default; operators opt in via
  // `tradekit playbook deploy --paper` or per-primitive flag.
  `
  ALTER TABLE orders ADD COLUMN paper INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE schedules ADD COLUMN paper INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS paper_trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    source_id       INTEGER,
    chain           TEXT NOT NULL,
    account         TEXT NOT NULL,
    direction       TEXT NOT NULL,
    base_token      TEXT NOT NULL,
    base_symbol     TEXT,
    base_amount     TEXT NOT NULL,
    quote_token     TEXT NOT NULL,
    quote_symbol    TEXT,
    quote_amount    TEXT NOT NULL,
    price           TEXT NOT NULL,
    slippage_bps    INTEGER,
    strategy        TEXT,
    notes           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_paper_trades_ts ON paper_trades (timestamp);
  CREATE INDEX IF NOT EXISTS idx_paper_trades_strategy ON paper_trades (strategy, timestamp);

  CREATE TABLE IF NOT EXISTS paper_balances (
    account     TEXT NOT NULL,
    chain       TEXT NOT NULL,
    token       TEXT NOT NULL,
    balance     TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (account, chain, token)
  );
  `,

  // v25 — strategy alert state (iter32).
  //
  // Per-(strategy tag, rule type) dedup state for the proactive
  // alerts subsystem. Lets the watcher emit ONE notification when a
  // rule transitions OK→active and one `resolved` event on the
  // reverse — without spamming the same alert every tick.
  //
  // Schema:
  //   - active=1 means the rule is currently violated; the previous
  //     `fire` notification has been emitted.
  //   - first_triggered_at: ISO timestamp the rule first violated
  //     while in the OK state. Used by the CLI to render "alerting
  //     for 23m" durations.
  //   - last_evaluated_at: ISO of the most recent watcher tick that
  //     touched this row. Lets `strategy alerts list` show whether
  //     a rule is being actively evaluated vs. stale.
  //   - last_value_json: opaque JSON-serialized rule-specific
  //     payload (the measured value that triggered the rule;
  //     specific shape per rule type). Used by the CLI for display
  //     + by tests for assertion.
  //
  // Backward compat: empty table by default; rules are entirely
  // opt-in via safety.strategyAlerts.enabled=true config.
  `
  CREATE TABLE IF NOT EXISTS strategy_alert_state (
    tag                 TEXT NOT NULL,
    rule_type           TEXT NOT NULL,
    active              INTEGER NOT NULL DEFAULT 0,
    first_triggered_at  TEXT,
    last_evaluated_at   TEXT NOT NULL,
    last_value_json     TEXT,
    PRIMARY KEY (tag, rule_type)
  );
  CREATE INDEX IF NOT EXISTS idx_strategy_alert_active ON strategy_alert_state (active);
  `,

  // v26 — engine events (iter39).
  //
  // Persistent log of engine state transitions: lifecycle
  // (started/stopped), kill switch (lock/unlock), per-worker
  // resilience (degraded/recovered), config hot-reload
  // (reloaded/reload_failed). Pre-iter39 these surfaced only as
  // transient notifications that vanished on process restart;
  // operators answering "what happened to my engine yesterday?"
  // had to grep Slack history or compose audit_log heuristics
  // (iter36 timeline did the latter — imperfectly).
  //
  // Schema:
  //   - event_type: dot-namespaced string (engine.*, worker.*, config.*)
  //   - severity: info | warn | critical (matches notification model)
  //   - pid: writer's process.pid (lets operators correlate with
  //     `engine status` + distinguish concurrent processes)
  //   - worker_name: NULL except for worker.* events
  //   - fields_json: arbitrary structured payload (per event type)
  //   - dedup_key: matches the notification dedupKey when one exists,
  //     so external tools cross-referencing notify history + this
  //     table can pair rows
  //
  // High-cardinality events (heartbeats) are deliberately NOT
  // persisted — operators use `engine status` for liveness.
  `
  CREATE TABLE IF NOT EXISTS engine_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp    TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    severity     TEXT NOT NULL,
    pid          INTEGER,
    worker_name  TEXT,
    fields_json  TEXT,
    dedup_key    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_engine_events_ts ON engine_events (timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_engine_events_type ON engine_events (event_type, timestamp);
  `,
];

// ── interfaces ───────────────────────────────────────────────

export interface TradeRow {
  id?: number;
  timestamp: string;
  chain: string;
  account: string;
  direction: "buy" | "sell";
  base_token: string;
  base_symbol: string | null;
  base_amount: string;
  quote_token: string;
  quote_symbol: string | null;
  quote_amount: string;
  price: string;
  tx_hash: string;
  status: string;
  gas_used: string | null;
  gas_price_wei: string | null;
  gas_cost_native: string | null;
  aggregator: string | null;
  fee_tier: number | null;
  notes: string | null;
  /** Iter635: receipt block number. Populated when the trade resolved via the
   *  success path (executeTrade or import_trade or reconcile observing a
   *  success receipt). NULL for: pending trades, failed trades that never
   *  produced a successful receipt, and legacy pre-iter635 rows. Indexed so
   *  reorg-depth queries stay cheap on multi-year history. */
  block_number?: number | null;
  /** Iter641: realized slippage in basis points, computed at trade time from
   *  the receipt's actual deltas vs the quoted amounts. Sign: positive =
   *  unfavorable (got LESS out than quoted); negative = favorable (router
   *  beat the quote). NULL for legacy rows + import-only + reverted +
   *  pending. Consumers (iter623 aggregatorStats, iter634 pairStats) prefer
   *  stored over live analysis. */
  realized_slippage_bps?: number | null;
  /** Iter646: gas cost in USD at trade time. Computed when the trade flow
   *  knows both gas_cost_native + the native token's USD price at that
   *  moment. NULL for legacy rows + cases where the native-USD lookup
   *  failed at trade time. PnL prefers this over native × current price
   *  for historical accuracy (tax reports, period comparisons). */
  gas_cost_usd_at_trade?: number | null;
  /** Iter648: structured strategy tag (e.g. "dca-eth", "rebal-q1"). NULL
   *  when not categorized. Distinct from free-text `notes` — indexed for
   *  fast cross-cut queries. */
  strategy?: string | null;
  /** Iter669: persisted revert reason for failed trades. Captured during
   *  reconcile via an eth_call replay at the pre-inclusion block (same
   *  technique as iter666's on-demand extraction). Stored vs recomputed:
   *  reading a `trades --status=failed` list is now zero-RPC. NULL for
   *  success/pending rows, legacy failed rows, and rows where the replay
   *  couldn't extract a reason (no block_number, RPC unavailable, etc.). */
  revert_reason?: string | null;
}

/**
 * Canonical column order for CSV / JSON export. Single source of truth so the empty-
 * result case still emits a header (downstream tooling like csv.DictReader needs the
 * header to bootstrap), and so the order is contractually stable even if SQL column
 * order ever changes. Matches the TradeRow keys above.
 */
// `as const` is essential: it preserves the literal-string union for the exhaustive
// type guard below. Without it, `(typeof TRADE_COLUMNS)[number]` widens to
// `keyof TradeRow` and the guard would always pass.
export const TRADE_COLUMNS = [
  "id",
  "timestamp",
  "chain",
  "account",
  "direction",
  "base_token",
  "base_symbol",
  "base_amount",
  "quote_token",
  "quote_symbol",
  "quote_amount",
  "price",
  "tx_hash",
  "status",
  "gas_used",
  "gas_price_wei",
  "gas_cost_native",
  "aggregator",
  "fee_tier",
  "notes",
  // Iter635: receipt block number — NULL for pending/failed/legacy rows.
  "block_number",
  // Iter641: realized slippage in bps — NULL for legacy/import/failed/pending rows.
  "realized_slippage_bps",
  // Iter646: historical gas USD — NULL for legacy/import-only/native-price-miss rows.
  "gas_cost_usd_at_trade",
  // Iter648: strategy tag for cross-cut analysis.
  "strategy",
  // Iter669: persisted revert reason for failed trades (eth_call replay).
  "revert_reason",
] as const satisfies readonly (keyof TradeRow)[];

// Compile-time guard: every TradeRow field MUST appear in TRADE_COLUMNS. If a future
// schema migration adds a field to TradeRow and forgets to update the constant,
// _CSV_EXHAUSTIVE evaluates to a never type and the assignment errors at tsc time —
// catches schema drift before the CSV export silently omits the new column.
type _MissingCsvColumns = Exclude<keyof TradeRow, (typeof TRADE_COLUMNS)[number]>;
const _CSV_EXHAUSTIVE: [_MissingCsvColumns] extends [never] ? true : never = true;
void _CSV_EXHAUSTIVE;

/**
 * Trade-row token-filter predicate. Match on:
 *   - Exact base/quote SYMBOL (case-insensitive)
 *   - Exact base/quote ADDRESS (case-insensitive)
 *   - Prefix match on base/quote ADDRESS (case-insensitive) — lets the operator type
 *     a partial address (`--token 0xabc`) and find anything starting with it.
 *
 * Iter282: extracted from three call sites (CLI cli/inspect.ts, MCP mcp/admin-tools.ts,
 * web web.ts) that all had the same 5-line in-place predicate. Centralizing here means
 * future evolution (e.g. fuzzy symbol match, or a `--token-decimals` flag) happens
 * once. `needle` is expected lowercase; callers do that conversion at the boundary.
 */
export function matchesTradeToken(row: Pick<TradeRow, "base_symbol" | "quote_symbol" | "base_token" | "quote_token">, needle: string): boolean {
  const bs = (row.base_symbol ?? "").toLowerCase();
  const qs = (row.quote_symbol ?? "").toLowerCase();
  const bt = row.base_token.toLowerCase();
  const qt = row.quote_token.toLowerCase();
  return bs === needle || qs === needle || bt === needle || qt === needle
    || bt.startsWith(needle) || qt.startsWith(needle);
}

/**
 * Iter715: MAX(timestamp) per account across the trades table. Used by
 * `accounts list` to surface "last trade" per HD account — distinguishes
 * actively-trading accounts from dormant ones. Cheap: GROUP BY account is
 * a single index scan.
 *
 * Returns a Map keyed by the canonical account label (matches what
 * insertTrade wrote). Accounts with no trade rows are absent from the map.
 *
 * Iter735: kept for back-compat (existing callers iter715 CLI / iter720 MCP
 * still use it). For richer per-account data (count + first/last) use
 * accountActivitySummary().
 */
export function lastTradeAtByAccount(): Map<string, string> {
  const db = openDb();
  const rows = db
    .prepare(`SELECT account, MAX(timestamp) AS lastTradeAt FROM trades GROUP BY account`)
    .all() as Array<{ account: string; lastTradeAt: string | null }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.lastTradeAt) out.set(r.account, r.lastTradeAt);
  }
  return out;
}

/**
 * Iter735: richer per-account activity summary. Same query shape as
 * listDistinctStrategies (iter651): COUNT + MIN + MAX in one GROUP BY pass.
 *
 * Each entry: tradeCount, firstTradeAt (oldest), lastTradeAt (newest).
 * Accounts with no trades are absent. Used by `accounts list` (CLI + MCP)
 * to surface "you've done N trades on this account, first on X, last on Y".
 */
export interface AccountActivityEntry {
  account: string;
  tradeCount: number;
  firstTradeAt: string;
  lastTradeAt: string;
}

export function accountActivitySummary(): Map<string, AccountActivityEntry> {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT account, COUNT(*) AS tradeCount, MIN(timestamp) AS firstTradeAt, MAX(timestamp) AS lastTradeAt
       FROM trades GROUP BY account`,
    )
    .all() as Array<{
      account: string;
      tradeCount: number;
      firstTradeAt: string | null;
      lastTradeAt: string | null;
    }>;
  const out = new Map<string, AccountActivityEntry>();
  for (const r of rows) {
    if (r.lastTradeAt && r.firstTradeAt) {
      out.set(r.account, {
        account: r.account,
        tradeCount: r.tradeCount,
        firstTradeAt: r.firstTradeAt,
        lastTradeAt: r.lastTradeAt,
      });
    }
  }
  return out;
}

/**
 * Iter716/iter717: MAX(timestamp) per (chain, base_symbol) — when did each
 * token last trade? Used by `holdings` (per-balance display) and `portfolio`
 * (per-token aggregate) to distinguish actively-traded balances from
 * long-held positions.
 *
 * Filter: `account` scopes to one account label (defaults to all). Symbols
 * are UPPERCASED in the key because operators trade ETH/eth/Eth and chain
 * storage casing varies — uppercased lookups are the convention shared
 * with iter627 cross-chain symbol roll-up.
 *
 * Key format: `${chain}:${SYMBOL_UPPER}`. Caller composes the key from the
 * balance's chain + symbol. Cheap: GROUP BY chain, base_symbol — covered
 * by the existing trades indexes.
 */
export function lastTradeAtBySymbol(filter: { account?: string } = {}): Map<string, string> {
  const db = openDb();
  const where: string[] = ["base_symbol IS NOT NULL"];
  const args: unknown[] = [];
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  const sql = `
    SELECT chain, UPPER(base_symbol) AS symbol, MAX(timestamp) AS lastTradeAt
    FROM trades
    WHERE ${where.join(" AND ")}
    GROUP BY chain, UPPER(base_symbol)
  `;
  const rows = db
    .prepare(sql)
    .all(...(args as never[])) as Array<{ chain: string; symbol: string; lastTradeAt: string | null }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.lastTradeAt) out.set(`${r.chain}:${r.symbol}`, r.lastTradeAt);
  }
  return out;
}

/**
 * Iter682: recent failed-row count + revert-reason histogram for a specific
 * trading pair on a specific chain/account. Used by the trade flow to detect
 * "you've been failing on this pair recently for the same reason" patterns
 * BEFORE the next trade ships — predictive failure prevention rather than
 * the post-hoc iter671 detection.
 *
 * Returns: total failures in window + histogram (sorted desc, same format
 * as failureReasonHistogram). Returns empty histogram + total=0 when no
 * matching failures exist. Pair match is symmetric (base/quote ↔ quote/base)
 * since operators trade in both directions on the same pair.
 *
 * sinceIso is an ISO timestamp; window is typically 7 days.
 */
export function recentPairFailureHistogram(args: {
  chain: string;
  account: string;
  baseToken: string;
  quoteToken: string;
  sinceIso: string;
}): { total: number; reasons: Array<{ reason: string; count: number; lastSeen?: string }> } {
  const db = openDb();
  // Match by address (case-insensitive). Symmetric so a BASE→QUOTE trade
  // pairs with a QUOTE→BASE trade in the same bucket.
  const sql = `
    SELECT * FROM trades
    WHERE status = 'failed'
      AND chain = ?
      AND account = ?
      AND timestamp >= ?
      AND aggregator NOT IN ('transfer', 'incoming')
      AND (
        (LOWER(base_token) = LOWER(?) AND LOWER(quote_token) = LOWER(?))
        OR
        (LOWER(base_token) = LOWER(?) AND LOWER(quote_token) = LOWER(?))
      )
  `;
  const rows = db
    .prepare(sql)
    .all(
      args.chain.toLowerCase(),
      args.account,
      args.sinceIso,
      args.baseToken,
      args.quoteToken,
      args.quoteToken,
      args.baseToken,
    ) as unknown as TradeRow[];
  const reasons = failureReasonHistogram(rows);
  return { total: rows.length, reasons };
}

/**
 * Iter683: recent failed-transfer count + revert-reason histogram for
 * transfers from this account to a specific recipient. Same predictive-
 * failure shape as iter682's pair detection but for the transfer surface.
 *
 * Recipient is matched against the `notes` field (transfers store
 * "transfer to <recipient>" in notes — see transfer.ts). LIKE is case-
 * insensitive for ASCII in SQLite by default, which covers EIP-55 mixed
 * case.
 */
export function recentRecipientFailureHistogram(args: {
  chain: string;
  account: string;
  recipient: string;
  sinceIso: string;
}): { total: number; reasons: Array<{ reason: string; count: number; lastSeen?: string }> } {
  const db = openDb();
  const sql = `
    SELECT * FROM trades
    WHERE status = 'failed'
      AND aggregator = 'transfer'
      AND chain = ?
      AND account = ?
      AND timestamp >= ?
      AND notes LIKE ?
  `;
  const rows = db
    .prepare(sql)
    .all(
      args.chain.toLowerCase(),
      args.account,
      args.sinceIso,
      `%transfer to ${args.recipient}%`,
    ) as unknown as TradeRow[];
  const reasons = failureReasonHistogram(rows);
  return { total: rows.length, reasons };
}

/**
 * Iter675: bucket failed trade rows by revert_reason into a count histogram.
 *
 * Same shape used by iter671 (health TradesSection), iter672 (aggregator
 * stats), iter673 (pair stats), and iter675 (trades CLI footer). Extracted
 * here so the four consumers stay in sync on:
 *
 *   - NULL / whitespace-only revert_reason → "(unknown)" bucket
 *   - Non-failed rows are ignored (defensive — caller usually pre-filters)
 *   - Sort by count desc (most common first); ties keep insertion order
 *   - Iter699: lastSeen per bucket from row.timestamp (parallel to iter697
 *     audit-summary lastSeen). Operators investigating "Too little received
 *     last hit when?" get the answer without a follow-up query. Absent
 *     when the input rows don't carry timestamps (legacy callers pre-
 *     iter699 used `Pick<TradeRow, "status" | "revert_reason">`).
 *
 * Pure / synchronous: no DB or RPC. Accepts any TradeRow-shaped subset.
 */
export function failureReasonHistogram(
  rows: readonly (Pick<TradeRow, "status" | "revert_reason"> & { timestamp?: string })[],
): Array<{ reason: string; count: number; lastSeen?: string }> {
  const counts = new Map<string, { count: number; lastSeen: string | undefined }>();
  for (const r of rows) {
    if (r.status !== "failed") continue;
    const key = r.revert_reason && r.revert_reason.trim() !== "" ? r.revert_reason : "(unknown)";
    const existing = counts.get(key);
    const rowTs = r.timestamp;
    if (existing) {
      existing.count += 1;
      // Track the LATEST timestamp in the bucket. ISO strings are
      // lexicographically comparable in UTC, so string > suffices.
      if (rowTs && (existing.lastSeen == null || rowTs > existing.lastSeen)) {
        existing.lastSeen = rowTs;
      }
    } else {
      counts.set(key, { count: 1, lastSeen: rowTs ?? undefined });
    }
  }
  return Array.from(counts.entries())
    .map(([reason, v]) => (v.lastSeen ? { reason, count: v.count, lastSeen: v.lastSeen } : { reason, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

export interface AuditRow {
  id?: number;
  timestamp: string;
  caller: string | null;
  tool: string;
  account: string | null;
  chain: string | null;
  params_json: string | null;
  simulation_json: string | null;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  tx_hash: string | null;
  /** Iter611: OS process id of the writer. NULL for rows from before iter611
   *  and for rare cases where process.pid isn't available. Lets forensic
   *  queries distinguish concurrent processes — useful when investigating
   *  "what was happening on the box at 14:23". */
  pid?: number | null;
}

// ── singleton handle ─────────────────────────────────────────

let dbInstance: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  // Iter386: shared ensureDataDir wraps mkdir failure with the TRADEKIT_DATA_DIR-aware
  // error message. logger / db / wallet / config / accounts all route through this so
  // operators see the same hint no matter which module trips the bad override first.
  ensureDataDir(DATA_DIR);
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Iter611: busy_timeout so concurrent writers (cron + manual, MCP + CLI, web
  // server + reconcile) serialize gracefully instead of failing with SQLITE_BUSY.
  // 5000ms covers the longest realistic write tx in tradekit (trade insert +
  // audit_log row = a few hundred μs); anything longer means a real lock holder
  // is stuck and surfacing the error is more useful than waiting forever.
  // WAL mode already lets readers and writers proceed concurrently — this only
  // gates writer-vs-writer.
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  importLegacyCsv(db);
  dbInstance = db;
  // Tighten perms on the DB file + its WAL/SHM sidecars after open. SQLite creates these
  // with default 0644; the DB holds full trade history (addresses, amounts, tx hashes,
  // audit_log with tool params) — operationally sensitive even though no key material
  // sits here. Promotes legacy installs silently; new files get 0600 on next write.
  chmodSecureIfExists(DB_PATH);
  chmodSecureIfExists(`${DB_PATH}-wal`);
  chmodSecureIfExists(`${DB_PATH}-shm`);
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function migrate(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  let current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(i + 1);
    current = i + 1;
  }
}

// Note on parameter binding: node:sqlite supports either positional (?) or named (:name)
// placeholders. We use positional throughout so the SQL doesn't need transformation.

function importLegacyCsv(db: DatabaseSync) {
  if (!existsSync(TRADE_CSV_PATH)) return;
  // Legacy CSV holds historical trade data — same sensitivity as the DB itself. If it's
  // still around (some installs never get re-imported because the table already has rows),
  // at least tighten its perms.
  chmodSecureIfExists(TRADE_CSV_PATH);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n;
  if (count > 0) return;
  try {
    const csv = readFileSync(TRADE_CSV_PATH, "utf-8").trim();
    const lines = csv.split("\n");
    if (lines.length <= 1) return;
    const insert = db.prepare(
      `INSERT INTO trades (
        timestamp, chain, account, direction,
        base_token, base_symbol, base_amount,
        quote_token, quote_symbol, quote_amount,
        price, tx_hash, status,
        gas_used, gas_price_wei, gas_cost_native,
        aggregator, fee_tier, notes
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    db.exec("BEGIN");
    try {
      for (const line of lines.slice(1)) {
        const cells = line.split(",");
        if (cells.length < 9) continue;
        const [timestamp, direction, base_amount, quote_amount, price, tx_hash, status, gas_used, fee_tier] = cells;
        insert.run(
          timestamp,
          "base",
          "default",
          direction,
          "",
          null,
          base_amount,
          "",
          null,
          quote_amount,
          price,
          tx_hash,
          status,
          gas_used,
          null,
          null,
          "uniswap-v3",
          parseInt(fee_tier, 10) || null,
          "imported from legacy trade.csv",
        );
      }
      db.exec("COMMIT");
    } catch {
      db.exec("ROLLBACK");
    }
  } catch {
    /* best-effort */
  }
}

// ── high-level helpers ───────────────────────────────────────

export function insertTrade(row: TradeRow): number {
  const db = openDb();
  const result = db
    .prepare(
      `INSERT INTO trades (
         timestamp, chain, account, direction,
         base_token, base_symbol, base_amount,
         quote_token, quote_symbol, quote_amount,
         price, tx_hash, status,
         gas_used, gas_price_wei, gas_cost_native,
         aggregator, fee_tier, notes, block_number, realized_slippage_bps,
         gas_cost_usd_at_trade, strategy, revert_reason
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.timestamp,
      row.chain,
      row.account,
      row.direction,
      row.base_token,
      row.base_symbol,
      row.base_amount,
      row.quote_token,
      row.quote_symbol,
      row.quote_amount,
      row.price,
      row.tx_hash,
      row.status,
      row.gas_used,
      row.gas_price_wei,
      row.gas_cost_native,
      row.aggregator,
      row.fee_tier,
      // Iter270: cap free-text notes here so every caller (trade.ts / transfer.ts /
      // importTrade.ts / future) benefits from the same bound. See capTradeNotes
      // (db.ts) for the size and rationale.
      capTradeNotes(row.notes),
      // Iter635: receipt block number — NULL when not yet known (pending) or
      // legacy callers that don't supply it.
      row.block_number ?? null,
      // Iter641: realized slippage in bps — NULL until computed.
      row.realized_slippage_bps ?? null,
      // Iter646: gas USD at trade time — NULL when native price wasn't known.
      row.gas_cost_usd_at_trade ?? null,
      // Iter648: strategy tag — NULL when not categorized.
      row.strategy ?? null,
      // Iter669: revert reason — almost always NULL at insert time (trade is
      // pending). Reconcile populates on failure transitions.
      row.revert_reason ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function recentTrades(filter: { chain?: string; account?: string; limit?: number; since?: string; strategy?: string; txHash?: string; aggregator?: string }): TradeRow[] {
  const db = openDb();
  const limit = filter.limit ?? 20;
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.chain) {
    where.push("chain = ?");
    // Trades are stored with chain == profile.name (canonical lowercase). Pre-iter127
    // `tradekit pnl --chain Base` silently returned zero rows because the SQL match is
    // case-sensitive. Lowercase here so the DB layer is the single normalization point.
    args.push(filter.chain.toLowerCase());
  }
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  // Iter357: --since support. Timestamps are stored as ISO strings; lexicographic
  // ordering matches chronological for the ISO format (Z-suffixed UTC), so a string
  // comparison is correct and uses idx_trades_account_ts (iter321) when account is
  // also filtered.
  if (filter.since) {
    where.push("timestamp >= ?");
    args.push(filter.since);
  }
  // Iter648: strategy tag filter. Uses idx_trades_strategy when combined with
  // account/chain filters. Exact match — operators wanting partial match can
  // use --note for free-text search.
  if (filter.strategy) {
    where.push("strategy = ?");
    args.push(filter.strategy);
  }
  // Iter661: tx hash filter. tx_hash is unique per-row in practice so this is
  // a single-row lookup, but recentTrades returns an array — multiple imports
  // of the same hash could land more than one row, so the LIMIT still
  // applies. Normalized lowercase: viem hex casing varies (0xAb… vs 0xab…)
  // and the DB stores whatever was inserted; lowercasing both sides matches
  // the same convention as chain normalization (line 480).
  if (filter.txHash) {
    where.push("LOWER(tx_hash) = ?");
    args.push(filter.txHash.toLowerCase());
  }
  // Iter662: aggregator filter. Symmetric with the strategy filter — exact
  // match against the aggregator column (kyberswap / openocean / 0x / 1inch /
  // transfer / etc.). Lowercased for parity with the chain filter.
  if (filter.aggregator) {
    where.push("aggregator = ?");
    args.push(filter.aggregator.toLowerCase());
  }
  args.push(limit);
  // Iter245: order by timestamp DESC (was id DESC). Same root cause as iter244, but
  // user-facing this time: `tradekit trades` shows trade HISTORY, not import history.
  // After iter243 stamps imported old trades with their real block time, ordering by
  // insertion id put a freshly-imported 6-month-old trade at the TOP of the listing —
  // wrong: it happened months ago, so it belongs at the chronological position, not
  // the import position. `id` is the tiebreaker for trades at the same millisecond.
  const sql = `SELECT * FROM trades ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY timestamp DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...(args as never[])) as unknown as TradeRow[];
}

/** All pending-status trades, optionally scoped to a chain/account. Used by reconcile. */
export function pendingTrades(filter: { chain?: string; account?: string }): TradeRow[] {
  const db = openDb();
  const where: string[] = ["status = 'pending'"];
  const args: unknown[] = [];
  if (filter.chain) {
    where.push("chain = ?");
    args.push(filter.chain.toLowerCase()); // see recentTrades comment
  }
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  const sql = `SELECT * FROM trades WHERE ${where.join(" AND ")} ORDER BY id ASC`;
  return db.prepare(sql).all(...(args as never[])) as unknown as TradeRow[];
}

/** Update the on-chain outcome of a previously-recorded trade (typically pending → success/failed).
 *  Iter635: optional `block_number` argument captures the receipt's block when known.
 *  Iter641: optional `realized_slippage_bps` captures realized vs quoted at trade time.
 *  Iter646: optional `gas_cost_usd_at_trade` captures historical gas USD value.
 *  Iter669: optional `revert_reason` persisted for failed receipts.
 *  Callers that don't have any of these (legacy paths) pass undefined and the existing
 *  values in the DB are preserved. */
export function updateTradeStatus(
  id: number,
  status: "success" | "failed",
  gas: {
    gas_used: string | null;
    gas_cost_native: string | null;
    block_number?: number | null;
    realized_slippage_bps?: number | null;
    gas_cost_usd_at_trade?: number | null;
    revert_reason?: string | null;
  },
): void {
  const db = openDb();
  // Iter635/641/646/669: dynamic SET-builder for the optional columns. Undefined
  // means "leave existing value"; null means "explicit clear".
  const cols: string[] = ["status = ?", "gas_used = ?", "gas_cost_native = ?"];
  const params: unknown[] = [status, gas.gas_used, gas.gas_cost_native];
  if (gas.block_number !== undefined) {
    cols.push("block_number = ?");
    params.push(gas.block_number);
  }
  if (gas.realized_slippage_bps !== undefined) {
    cols.push("realized_slippage_bps = ?");
    params.push(gas.realized_slippage_bps);
  }
  if (gas.gas_cost_usd_at_trade !== undefined) {
    cols.push("gas_cost_usd_at_trade = ?");
    params.push(gas.gas_cost_usd_at_trade);
  }
  if (gas.revert_reason !== undefined) {
    cols.push("revert_reason = ?");
    params.push(gas.revert_reason);
  }
  params.push(id);
  db.prepare(`UPDATE trades SET ${cols.join(", ")} WHERE id = ?`).run(...(params as never[]));
}

export function allTrades(filter: { chain?: string; account?: string; strategy?: string }): TradeRow[] {
  const db = openDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.chain) {
    where.push("chain = ?");
    args.push(filter.chain.toLowerCase()); // see recentTrades comment
  }
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  // Iter648: strategy tag scope. PnL computed with --strategy filter answers
  // "how is my DCA strategy performing vs my swing trades".
  if (filter.strategy) {
    where.push("strategy = ?");
    args.push(filter.strategy);
  }
  // Iter244: order by timestamp, not id. Pre-iter244 the order was `id ASC`, which is
  // insertion order — fine for trades created live (id and timestamp agreed), but WRONG
  // for trades imported via `trade import` after iter243 started stamping rows with the
  // block timestamp. A 6-month-old swap imported today has a high `id` but an old
  // `timestamp`; PnL's weighted-average cost basis processes trades chronologically, so
  // ordering by id would have placed the historical buy AFTER later real-time sells —
  // producing nonsense cost-basis numbers. `id ASC` is kept as the tiebreaker for the
  // (uncommon) case of trades stamped at the exact same millisecond.
  const sql = `SELECT * FROM trades ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY timestamp ASC, id ASC`;
  return db.prepare(sql).all(...(args as never[])) as unknown as TradeRow[];
}

/**
 * Soft cap on the `params_json` column to keep audit rows bounded. A misuse like
 * `tradekit config set safety.tokenWhitelist.base '[10000 addresses]'` could otherwise
 * persist a multi-MB row, slowing every subsequent `tradekit audit` listing. Truncated
 * payloads still preserve their JSON prefix + a "[TRUNCATED]" marker for shape
 * recognition during debugging. The live stderr log retains the full payload.
 */
export const AUDIT_PARAMS_MAX = 32 * 1024;
export function capAuditParams(raw: string): string {
  return raw.length <= AUDIT_PARAMS_MAX ? raw : raw.slice(0, AUDIT_PARAMS_MAX) + '..."[TRUNCATED]"';
}

/**
 * Cap free-text `notes` on trades/transfers. Pre-iter270 there was no limit; an MCP
 * agent passing a multi-paragraph chain-of-thought as `note` would persist the whole
 * thing per row, bloating the DB and slowing future queries. 2KB is generous for any
 * meaningful annotation (campaign tags, intent strings, agent run-ids) — anything
 * bigger is a misuse and the truncation marker makes that visible in trade listings.
 */
export const TRADE_NOTES_MAX = 2 * 1024;
export function capTradeNotes(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  return raw.length <= TRADE_NOTES_MAX
    ? raw
    : raw.slice(0, TRADE_NOTES_MAX) + "...[TRUNCATED]";
}

/**
 * Field names whose values must NEVER be persisted to the audit log. Otherwise a
 * `tradekit doctor --pass MYPASSWORD` (iter113) would leak the wallet password as
 * plaintext into ~/.tradekit/tradekit.db and `tradekit audit` output. Matched
 * case-insensitively. Add new names here whenever a new sensitive field is introduced.
 */
const SENSITIVE_FIELDS = new Set([
  "pass",
  "password",
  "passphrase",
  "private-key",
  "privatekey",
  "private_key",
  "mnemonic",
  "seed",
  "secret",
  // Webhook URLs embed bearer tokens in the path (Slack/Discord/Telegram all
  // do this) — same redaction class as wallet secrets so audit_log dumps and
  // `config show` outputs don't leak them. Match the variants that show up
  // in different parts of the codebase (config uses `url`; admin CLI flag
  // uses `webhook` / `webhookUrl`).
  "webhook",
  "webhookurl",
  "webhook_url",
  // MEV private-RPC URLs frequently embed API keys in the path
  // (e.g. https://rpc.merkle.io/<key>). Same redaction class as webhooks.
  // The `privateRpcs` config key is a record (chain → url); the recursive
  // redactValue walks into it and we want to mask the URLs themselves.
  // We match `privaterpc` / `private_rpc` / `privaterpcs` so individual
  // chain-keyed entries plus the parent field are both covered when an
  // audit-log payload includes them (e.g. `config push mev.privateRpcs ...`).
  "privaterpc",
  "private_rpc",
  "privaterpcs",
  "private_rpcs",
]);

/**
 * Return a deep-cloned copy of `obj` with sensitive field VALUES replaced by
 * "[REDACTED]". Walks plain objects and arrays — pre-iter136 the redaction only
 * inspected the top level, so a future MCP tool taking `{auth: {password: "x"}}` or
 * `{batch: [{password: "x"}]}` would leak the secret into audit_log. Defense in depth:
 * the current call sites pass flat objects, but the recursive form is harder to misuse.
 *
 * Stops at scalar leaves and non-plain objects (Date, Buffer, etc. are kept as-is —
 * those don't legitimately appear in audit payloads).
 */
export function redactSensitiveFields<T extends Record<string, unknown>>(obj: T): T {
  return redactValue(obj) as T;
}

function redactValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactValue);
  if (v != null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE_FIELDS.has(k.toLowerCase()) ? "[REDACTED]" : redactValue(child);
    }
    return out;
  }
  return v;
}

/**
 * Cap audit-log free-text fields. params_json gets the long limit (32KB — debugging
 * large tool calls); error_message and simulation_json get the shorter limit (8KB —
 * a stack trace or a viem internal error blob can otherwise inflate the audit row
 * indefinitely). Iter271: pre-iter271 only params_json was capped — error messages
 * from upstream (RPC error with full HTTP body, viem revert with embedded bytecode,
 * zod issues list traversing a deep tree) could persist as 100KB+ blobs.
 */
export const AUDIT_TEXT_MAX = 8 * 1024;
export function capAuditText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  return raw.length <= AUDIT_TEXT_MAX
    ? raw
    : raw.slice(0, AUDIT_TEXT_MAX) + "...[TRUNCATED]";
}

export function insertAudit(row: Omit<AuditRow, "id">): number {
  const db = openDb();
  // Iter611: stamp every new row with process.pid. Callers don't pass it
  // (most call sites would forget); centralizing here ensures every audit
  // entry has the forensic info. Use the row.pid override when callers want
  // to backfill a different value (e.g. importTrade attributing to a parent
  // process), but default to the current process.
  const pid = row.pid ?? (typeof process !== "undefined" && process.pid ? process.pid : null);
  const result = db
    .prepare(
      `INSERT INTO audit_log (
         timestamp, caller, tool, account, chain,
         params_json, simulation_json, result,
         error_code, error_message, tx_hash, pid
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.timestamp,
      row.caller,
      row.tool,
      row.account,
      row.chain,
      // params_json is pre-capped by capAuditParams at every call site (iter112).
      // simulation_json + error_message go through capAuditText so a runaway upstream
      // error message can't bloat a single audit row to many KBs.
      row.params_json,
      capAuditText(row.simulation_json),
      row.result,
      row.error_code,
      capAuditText(row.error_message),
      row.tx_hash,
      pid,
    );
  return Number(result.lastInsertRowid);
}

export function recentAudit(
  limit = 50,
  opts: {
    since?: string;
    tool?: string;
    account?: string;
    chain?: string;
    caller?: string;
    /** Iter695: exact-match against the error_code column. Combine with
     *  errorsOnly=true to get all errors in a window; use alone to scope to
     *  one specific code (e.g. SLIPPAGE_EXCEEDED) for pattern investigation. */
    errorCode?: string;
    /** Iter696: when true, filter to rows where error_code IS NOT NULL.
     *  Convenience for "what's been breaking?" — symmetric to
     *  `trades --status=failed`. */
    errorsOnly?: boolean;
    /** Iter705: exact tx-hash lookup (case-insensitive). Operator running
     *  `audit --tx 0x...` sees every audit row touching that hash — submit,
     *  any reconcile, any follow-up tool call. Symmetric with iter661's
     *  trades --tx filter. */
    txHash?: string;
  } = {},
): AuditRow[] {
  const db = openDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.since) {
    where.push("timestamp >= ?");
    args.push(opts.since);
  }
  if (opts.tool) {
    where.push("tool = ?");
    args.push(opts.tool);
  }
  if (opts.account) {
    where.push("account = ?");
    args.push(opts.account);
  }
  if (opts.chain) {
    where.push("chain = ?");
    args.push(opts.chain.toLowerCase()); // see recentTrades comment — audit_log stores canonical lowercase chain
  }
  if (opts.caller) {
    where.push("caller = ?");
    args.push(opts.caller);
  }
  if (opts.errorCode) {
    // Iter695: exact match; error codes are uppercase canonical (SLIPPAGE_EXCEEDED, etc).
    where.push("error_code = ?");
    args.push(opts.errorCode);
  }
  if (opts.errorsOnly) {
    where.push("error_code IS NOT NULL");
  }
  if (opts.txHash) {
    // Iter705: lowercase comparison so EIP-55 mixed-case input matches
    // however the row was stored. Same pattern as iter661's trades filter.
    where.push("LOWER(tx_hash) = ?");
    args.push(opts.txHash.toLowerCase());
  }
  args.push(limit);
  const sql = `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...(args as never[])) as unknown as AuditRow[];
  // Defense in depth: re-redact params_json on every read. iter113/114 already redact
  // at WRITE time, so new rows are clean — but installs that existed BEFORE that fix
  // still have any plaintext credentials from old `tradekit ... --pass X` invocations
  // in their audit_log rows. Re-running the redaction on read upgrades those silently
  // without a migration step, and provides belt-and-suspenders coverage if a future
  // tool-write path forgets to redact.
  for (const r of rows) {
    if (r.params_json) {
      try {
        const parsed = JSON.parse(r.params_json);
        if (parsed && typeof parsed === "object") {
          r.params_json = JSON.stringify(redactSensitiveFields(parsed));
        }
      } catch {
        // params_json wasn't valid JSON (truncated payload or a non-JSON write from
        // some old code path). Leave it alone — capAuditParams's "[TRUNCATED]" marker
        // is the only legitimate non-JSON shape and it contains no secrets.
      }
    }
  }
  return rows;
}

// ── audit summary (iter631) ───────────────────────────────

export interface AuditSummary {
  /** Total rows matching the filter. */
  totalRows: number;
  /** Rows with error_code IS NOT NULL. Convenience for "error rate" math. */
  errorRows: number;
  /** Time range covered by the matching rows (ISO). Null when no rows matched. */
  earliest: string | null;
  latest: string | null;
  /** Per-tool counts: { tool, count, errorCount, lastSeen }. Sorted by count
   *  desc. Iter698: lastSeen added so operators can answer "is this tool
   *  still being invoked?" without a follow-up listing. */
  byTool: Array<{ tool: string; count: number; errorCount: number; lastSeen: string }>;
  /** Per-caller counts (cli/mcp/web). Iter698: includes lastSeen. */
  byCaller: Array<{ caller: string; count: number; lastSeen: string }>;
  /** Top error codes by count. Sorted desc. Iter697: each entry also carries
   *  `lastSeen` (ISO timestamp of the most recent occurrence) so operators
   *  investigating "I had SLIPPAGE_EXCEEDED once, when?" don't need a
   *  follow-up listing query. */
  byErrorCode: Array<{ errorCode: string; count: number; lastSeen: string }>;
  /** Per-chain counts. NULL chain (chain-less tools like `status`) appears
   *  as "(none)". Iter698: includes lastSeen. */
  byChain: Array<{ chain: string; count: number; lastSeen: string }>;
  /** Iter771: wall-clock ms for the auditSummary aggregation. DB-only — no
   *  RPC — but on audit tables with hundreds of thousands of rows the
   *  GROUP BY scans get measurable (50ms+ on large histories). Cron
   *  operators tracking compute over time see growth as the table grows;
   *  spike vs baseline flags "audit table needs pruning". Symmetric with
   *  iter744 aggregator stats / iter758 pair stats elapsedMs. */
  elapsedMs?: number;
  /** Iter834: structured dispatch list — one entry per tool with elevated
   *  error rate (count ≥ 3 AND rate ≥ 10%). Agents triage WHICH tools are
   *  failing systemically without iterating byTool[]. Empty when nothing
   *  qualifies. Symmetric with iter829-833 across the codebase. */
  recommendedActions: import("./errors.js").NextAction[];
}

/**
 * Iter631: aggregated audit_log summary. Groups by tool, caller, error_code,
 * chain — answers questions like "how many errors in the last 24h" and
 * "which tool fails most" without manual log scrolling.
 *
 * Filters mirror recentAudit (`since` / `tool` / `account` / `chain` /
 * `caller`) so operators can scope the same window they'd scope a listing to.
 *
 * Returns empty arrays for the bucket lists when no rows match — never null.
 * Cron-friendly: an external monitor can poll this and threshold on
 * `errorRows / totalRows`.
 */
export function auditSummary(
  opts: { since?: string; tool?: string; account?: string; chain?: string; caller?: string } = {},
): AuditSummary {
  // Iter771: wall-clock for the aggregation. SQLite GROUP BYs are fast but
  // not free at scale; useful sentinel for cron operators.
  const t0 = Date.now();
  const db = openDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.since) {
    where.push("timestamp >= ?");
    args.push(opts.since);
  }
  if (opts.tool) {
    where.push("tool = ?");
    args.push(opts.tool);
  }
  if (opts.account) {
    where.push("account = ?");
    args.push(opts.account);
  }
  if (opts.chain) {
    where.push("chain = ?");
    args.push(opts.chain.toLowerCase());
  }
  if (opts.caller) {
    where.push("caller = ?");
    args.push(opts.caller);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  // Totals + time range — one row.
  const totals = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) AS errors,
        MIN(timestamp) AS earliest,
        MAX(timestamp) AS latest
      FROM audit_log ${whereSql}`,
    )
    .get(...(args as never[])) as {
    total: number;
    errors: number | null;
    earliest: string | null;
    latest: string | null;
  };

  // Per-tool: counts + errors per tool. Iter698: lastSeen added.
  const byTool = db
    .prepare(
      `SELECT tool, COUNT(*) AS count, SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) AS errors, MAX(timestamp) AS lastSeen
       FROM audit_log ${whereSql} GROUP BY tool ORDER BY count DESC`,
    )
    .all(...(args as never[])) as unknown as { tool: string; count: number; errors: number | null; lastSeen: string }[];

  // Per-caller. Iter698: lastSeen added.
  const byCaller = db
    .prepare(
      `SELECT COALESCE(caller, '(none)') AS caller, COUNT(*) AS count, MAX(timestamp) AS lastSeen
       FROM audit_log ${whereSql} GROUP BY caller ORDER BY count DESC`,
    )
    .all(...(args as never[])) as unknown as { caller: string; count: number; lastSeen: string }[];

  // Per-error-code (excludes NULL — only actual errors).
  const errorWhereSql = where.length
    ? `WHERE error_code IS NOT NULL AND ${where.join(" AND ")}`
    : "WHERE error_code IS NOT NULL";
  // Iter697: MAX(timestamp) per group surfaces when each code last fired.
  // Cheap — covered by the existing timestamp index (audit_log is indexed
  // for the recentAudit filter columns; the MAX is a single scan within
  // each group).
  const byErrorCode = db
    .prepare(
      `SELECT error_code AS errorCode, COUNT(*) AS count, MAX(timestamp) AS lastSeen
       FROM audit_log ${errorWhereSql} GROUP BY error_code ORDER BY count DESC`,
    )
    .all(...(args as never[])) as unknown as { errorCode: string; count: number; lastSeen: string }[];

  // Per-chain. NULL chain → "(none)" so the report is honest about chain-less
  // tools (status, accounts, etc.) without dropping rows.
  // Iter698: lastSeen added to per-chain group.
  const byChain = db
    .prepare(
      `SELECT COALESCE(chain, '(none)') AS chain, COUNT(*) AS count, MAX(timestamp) AS lastSeen
       FROM audit_log ${whereSql} GROUP BY chain ORDER BY count DESC`,
    )
    .all(...(args as never[])) as unknown as { chain: string; count: number; lastSeen: string }[];

  const byToolOut = byTool.map((r) => ({ tool: r.tool, count: r.count, errorCount: r.errors ?? 0, lastSeen: r.lastSeen }));
  // Iter834: per-tool dispatch list. Trigger threshold: errorCount ≥ 3 AND
  // errorRate ≥ 10%. Below either, the signal is noise (one-off RPC blip,
  // single failed quote). Above both, it's a systemic pattern worth
  // investigating. Top-3 by error count to keep the list focused.
  const elevatedErrorRate = byToolOut
    .filter((t) => t.errorCount >= 3 && t.count > 0 && t.errorCount / t.count >= 0.1)
    .sort((a, b) => b.errorCount - a.errorCount)
    .slice(0, 3);
  const recommendedActions: import("./errors.js").NextAction[] = elevatedErrorRate.map((t) => ({
    tool: "audit",
    params: { action: "list", tool: t.tool, errors_only: true, limit: 50 },
    reason: `Tool '${t.tool}' has ${t.errorCount}/${t.count} error rate (${((t.errorCount / t.count) * 100).toFixed(1)}%) — inspect failing rows to find the systemic cause.`,
  }));
  // Iter837: per-error-code dispatch — surfaces "one specific code fires
  // across multiple tools" pattern (e.g. SLIPPAGE_EXCEEDED systemic across
  // trade.buy + trade.sell, missed by per-tool view). Threshold count ≥ 5
  // filters noise (one-off codes); top-3 keeps the list focused.
  const topErrorCodes = byErrorCode
    .filter((e) => e.count >= 5)
    .slice(0, 3);
  for (const e of topErrorCodes) {
    recommendedActions.push({
      tool: "audit",
      params: { action: "list", error_code: e.errorCode, limit: 50 },
      reason: `Error code '${e.errorCode}' fired ${e.count} time${e.count === 1 ? "" : "s"} (last: ${e.lastSeen.slice(0, 16).replace("T", " ")}) — inspect rows to find the common trigger.`,
    });
  }
  return {
    totalRows: totals.total ?? 0,
    errorRows: totals.errors ?? 0,
    earliest: totals.earliest,
    latest: totals.latest,
    byTool: byToolOut,
    byCaller,
    byErrorCode,
    byChain,
    elapsedMs: Date.now() - t0,
    recommendedActions,
  };
}

/** Delete audit entries older than `before` (ISO8601). Returns number of rows removed. */
export function pruneAudit(before: string): number {
  const db = openDb();
  const r = db.prepare("DELETE FROM audit_log WHERE timestamp < ?").run(before);
  return Number(r.changes ?? 0);
}

/**
 * Preview what `pruneAudit(before)` would delete. Returns row count + the oldest and
 * newest timestamps that would be removed (or nulls if nothing matches). Used by the
 * CLI to show operators what they're about to lose before confirming.
 */
export function auditPruneStats(before: string): {
  count: number;
  oldestPruned: string | null;
  newestPruned: string | null;
} {
  const db = openDb();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count, MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM audit_log WHERE timestamp < ?",
    )
    .get(before) as { count: number; oldest: string | null; newest: string | null };
  return { count: row.count, oldestPruned: row.oldest, newestPruned: row.newest };
}

// ── portfolio snapshots (iter618) ───────────────────────────

export interface PortfolioSnapshotRow {
  id?: number;
  timestamp: string;
  total_usd: number | null;
  accounts_key: string;
  chains_key: string;
  token_count: number;
  note: string | null;
  /** Full PortfolioReport JSON. Stored as a string in SQLite; callers parse. */
  data: string;
}

/**
 * Iter618: insert a portfolio snapshot. `data` is expected to be a fully
 * serialized PortfolioReport JSON (the caller decides what to persist — we
 * don't want db.ts to take a runtime dep on src/portfolio.ts's shape).
 * Returns the new row's id.
 */
export function insertPortfolioSnapshot(row: Omit<PortfolioSnapshotRow, "id">): number {
  const db = openDb();
  const stmt = db.prepare(`
    INSERT INTO portfolio_snapshots (timestamp, total_usd, accounts_key, chains_key, token_count, note, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    row.timestamp,
    row.total_usd,
    row.accounts_key,
    row.chains_key,
    row.token_count,
    row.note,
    row.data,
  );
  return Number(result.lastInsertRowid);
}

/**
 * Iter618: list portfolio snapshots (most recent first). Returns the row
 * WITHOUT the heavy `data` blob — operators listing history want the metadata,
 * not the full JSON. Use `getPortfolioSnapshot` to fetch the blob by id.
 */
export function listPortfolioSnapshots(filter: {
  limit?: number;
  accountsKey?: string;
  chainsKey?: string;
}): Omit<PortfolioSnapshotRow, "data">[] {
  const db = openDb();
  const args: unknown[] = [];
  let sql = "SELECT id, timestamp, total_usd, accounts_key, chains_key, token_count, note FROM portfolio_snapshots WHERE 1=1";
  if (filter.accountsKey != null) {
    sql += " AND accounts_key = ?";
    args.push(filter.accountsKey);
  }
  if (filter.chainsKey != null) {
    sql += " AND chains_key = ?";
    args.push(filter.chainsKey);
  }
  sql += " ORDER BY timestamp DESC";
  if (filter.limit != null) {
    sql += " LIMIT ?";
    args.push(filter.limit);
  }
  return db.prepare(sql).all(...(args as never[])) as unknown as Omit<PortfolioSnapshotRow, "data">[];
}

/**
 * Iter618: fetch a single snapshot by id (including data blob). Returns null
 * when the id doesn't exist — caller decides whether that's an error.
 */
export function getPortfolioSnapshot(id: number): PortfolioSnapshotRow | null {
  const db = openDb();
  const row = db
    .prepare(
      "SELECT id, timestamp, total_usd, accounts_key, chains_key, token_count, note, data FROM portfolio_snapshots WHERE id = ?",
    )
    .get(id) as PortfolioSnapshotRow | undefined;
  return row ?? null;
}

/**
 * Iter618: find the most recent snapshot AT OR BEFORE a given timestamp.
 * Lets `portfolio diff 7d` work — operator says "compare to a week ago" and
 * we pick the closest snapshot from that era. Returns null when no snapshot
 * exists in the window.
 *
 * Scope filters (accountsKey/chainsKey) ensure we only compare apples to
 * apples — a snapshot scoped to base-only shouldn't be the "as-of" reference
 * for a multi-chain portfolio.
 */
export function findPortfolioSnapshotAsOf(args: {
  asOf: string;
  accountsKey?: string;
  chainsKey?: string;
}): PortfolioSnapshotRow | null {
  const db = openDb();
  const params: unknown[] = [args.asOf];
  let sql = "SELECT id, timestamp, total_usd, accounts_key, chains_key, token_count, note, data FROM portfolio_snapshots WHERE timestamp <= ?";
  if (args.accountsKey != null) {
    sql += " AND accounts_key = ?";
    params.push(args.accountsKey);
  }
  if (args.chainsKey != null) {
    sql += " AND chains_key = ?";
    params.push(args.chainsKey);
  }
  sql += " ORDER BY timestamp DESC LIMIT 1";
  const row = db.prepare(sql).get(...(params as never[])) as PortfolioSnapshotRow | undefined;
  return row ?? null;
}

/**
 * Iter655: lightweight count query for the three "missing X" backfill axes.
 * Single SQL pass via conditional COUNT — cheap on any DB size, suitable for
 * health to call on every tick. Filters success rows + excludes
 * transfer/incoming aggregator (those don't have meaningful slippage / USD
 * gas to backfill).
 *
 * Returns counts an operator can act on:
 *   - missingBlockNumber:  row count needing iter637 backfill-blocks
 *   - missingSlippage:     row count needing iter643 backfill-slippage
 *   - missingGasUsd:       row count needing iter654 backfill-gas-usd
 *   - missingRevertReason: row count needing iter670 backfill-revert-reasons
 *
 * Note: missingRevertReason is FAILED rows (not success — the others are
 * success-only). Computed via a separate filter clause inside the same
 * single-SQL-pass so the function remains cheap.
 */
export function legacyBackfillCounts(filter: {
  chain?: string;
  account?: string;
} = {}): {
  missingBlockNumber: number;
  missingSlippage: number;
  missingGasUsd: number;
  missingRevertReason: number;
} {
  const db = openDb();
  const args: unknown[] = [];
  // Success-row counts: the existing three columns. We exclude transfer/
  // incoming aggregators since they don't have meaningful slippage/USD gas
  // to backfill.
  let whereClauses = "aggregator NOT IN ('transfer', 'incoming')";
  if (filter.chain) {
    whereClauses += " AND chain = ?";
    args.push(filter.chain.toLowerCase());
  }
  if (filter.account) {
    whereClauses += " AND account = ?";
    args.push(filter.account);
  }
  const row = db
    .prepare(
      // Inline CASE-when-status-success gates each success-only count so we
      // can still scan failed rows in the same pass for the iter670 count.
      // (Conditional COUNT is cheaper than a UNION of separate scans.)
      `SELECT
        SUM(CASE WHEN status = 'success' AND block_number IS NULL THEN 1 ELSE 0 END) AS missingBlockNumber,
        SUM(CASE WHEN status = 'success' AND realized_slippage_bps IS NULL THEN 1 ELSE 0 END) AS missingSlippage,
        SUM(CASE WHEN status = 'success' AND gas_cost_native IS NOT NULL AND gas_cost_usd_at_trade IS NULL THEN 1 ELSE 0 END) AS missingGasUsd,
        SUM(CASE WHEN status = 'failed' AND block_number IS NOT NULL AND revert_reason IS NULL THEN 1 ELSE 0 END) AS missingRevertReason
      FROM trades WHERE ${whereClauses}`,
    )
    .get(...(args as never[])) as {
    missingBlockNumber: number | null;
    missingSlippage: number | null;
    missingGasUsd: number | null;
    missingRevertReason: number | null;
  };
  return {
    missingBlockNumber: row.missingBlockNumber ?? 0,
    missingSlippage: row.missingSlippage ?? 0,
    missingGasUsd: row.missingGasUsd ?? 0,
    missingRevertReason: row.missingRevertReason ?? 0,
  };
}

/**
 * Iter654: list success trades that don't yet have gas_cost_usd_at_trade.
 * Used by `reconcile --backfill-gas-usd` to walk legacy rows + fetch
 * historical native price + persist. Rows without gas_cost_native are
 * excluded — no gas means no USD to compute. Sorted by id ASC so oldest
 * legacy rows backfill first (operators care most about long-term tax
 * accuracy).
 */
export function successTradesWithoutGasUsd(filter: {
  limit?: number;
  chain?: string;
  account?: string;
}): TradeRow[] {
  const db = openDb();
  const args: unknown[] = [];
  let sql = `SELECT * FROM trades
             WHERE status = 'success'
               AND gas_cost_native IS NOT NULL
               AND gas_cost_usd_at_trade IS NULL
               AND aggregator NOT IN ('transfer', 'incoming')`;
  if (filter.chain) {
    sql += " AND chain = ?";
    args.push(filter.chain.toLowerCase());
  }
  if (filter.account) {
    sql += " AND account = ?";
    args.push(filter.account);
  }
  sql += " ORDER BY id ASC";
  if (filter.limit != null) {
    sql += " LIMIT ?";
    args.push(filter.limit);
  }
  return db.prepare(sql).all(...(args as never[])) as unknown as TradeRow[];
}

/**
 * Iter670: list failed trades that don't yet have a persisted revert reason.
 * Mirrors the iter637/643/654 backfill query pattern. Filters: status='failed',
 * block_number IS NOT NULL (needed to pin the eth_call replay block — see
 * iter666 in tradeAnalysis.ts), revert_reason IS NULL. Sorted oldest-first
 * by id so legacy rows at greatest risk of receipt pruning get backfilled
 * first.
 */
export function failedTradesWithoutRevertReason(filter: {
  limit?: number;
  chain?: string;
  account?: string;
}): TradeRow[] {
  const db = openDb();
  const args: unknown[] = [];
  let sql = `SELECT * FROM trades
             WHERE status = 'failed'
               AND block_number IS NOT NULL
               AND revert_reason IS NULL`;
  if (filter.chain) {
    sql += " AND chain = ?";
    args.push(filter.chain.toLowerCase());
  }
  if (filter.account) {
    sql += " AND account = ?";
    args.push(filter.account);
  }
  sql += " ORDER BY id ASC";
  if (filter.limit != null) {
    sql += " LIMIT ?";
    args.push(filter.limit);
  }
  return db.prepare(sql).all(...(args as never[])) as unknown as TradeRow[];
}

/**
 * Iter643: list success trades that don't yet have realized_slippage_bps.
 * Same pattern as iter637's successTradesWithoutBlockNumber — used by
 * `reconcile --backfill-slippage` to backfill iter641-stored slippage on
 * pre-iter641 success rows. Excludes import-only rows (aggregator='transfer'
 * or 'incoming') since those don't have a "quoted" baseline to compare
 * against — realized slippage isn't meaningful for them.
 */
export function successTradesWithoutSlippage(filter: {
  limit?: number;
  chain?: string;
  account?: string;
}): TradeRow[] {
  const db = openDb();
  const args: unknown[] = [];
  let sql = `SELECT * FROM trades
             WHERE status = 'success'
               AND realized_slippage_bps IS NULL
               AND aggregator NOT IN ('transfer', 'incoming')`;
  if (filter.chain) {
    sql += " AND chain = ?";
    args.push(filter.chain.toLowerCase());
  }
  if (filter.account) {
    sql += " AND account = ?";
    args.push(filter.account);
  }
  sql += " ORDER BY id ASC";
  if (filter.limit != null) {
    sql += " LIMIT ?";
    args.push(filter.limit);
  }
  return db.prepare(sql).all(...(args as never[])) as unknown as TradeRow[];
}

/**
 * Iter637: list success trades that don't yet have a block_number captured.
 * Used by `reconcile --backfill-blocks` to walk legacy rows + fetch + persist
 * the receipt's block number. Sorted by id ASC so the oldest legacy rows
 * (with the most stale receipts at risk of pruning) get backfilled first.
 */
export function successTradesWithoutBlockNumber(filter: {
  limit?: number;
  chain?: string;
  account?: string;
}): TradeRow[] {
  const db = openDb();
  const args: unknown[] = [];
  let sql = `SELECT * FROM trades WHERE status = 'success' AND block_number IS NULL`;
  if (filter.chain) {
    sql += " AND chain = ?";
    args.push(filter.chain.toLowerCase());
  }
  if (filter.account) {
    sql += " AND account = ?";
    args.push(filter.account);
  }
  sql += " ORDER BY id ASC";
  if (filter.limit != null) {
    sql += " LIMIT ?";
    args.push(filter.limit);
  }
  return db.prepare(sql).all(...(args as never[])) as unknown as TradeRow[];
}

/**
 * Iter651: list distinct strategy tags from the trades table with trade count
 * + last-used timestamp. Helps operators discover their own tags (catches
 * typos, surfaces little-used strategies). NULL strategy rows are excluded
 * — this is a directory of EXPLICITLY-tagged strategies, not a "what's
 * untagged" view (operators querying that just look at `trades` directly).
 */
export interface StrategyListEntry {
  strategy: string;
  tradeCount: number;
  /** Most recent trade timestamp tagged with this strategy (ISO). */
  lastUsed: string;
  /** First trade timestamp tagged with this strategy (ISO). */
  firstUsed: string;
}

export function listDistinctStrategies(filter: {
  account?: string;
  chain?: string;
}): StrategyListEntry[] {
  const db = openDb();
  const args: unknown[] = [];
  let sql = `SELECT strategy AS strategy,
                    COUNT(*) AS tradeCount,
                    MAX(timestamp) AS lastUsed,
                    MIN(timestamp) AS firstUsed
             FROM trades
             WHERE strategy IS NOT NULL`;
  if (filter.account) {
    sql += " AND account = ?";
    args.push(filter.account);
  }
  if (filter.chain) {
    sql += " AND chain = ?";
    args.push(filter.chain.toLowerCase());
  }
  sql += " GROUP BY strategy ORDER BY MAX(timestamp) DESC";
  return db.prepare(sql).all(...(args as never[])) as unknown as StrategyListEntry[];
}

/**
 * Iter633: most-recent trade timestamp for a given account. Returns null when
 * the account has no trades. Includes ALL statuses (success/pending/failed) —
 * a failed trade still counts toward "did I recently try to trade" rate-limit
 * accounting, otherwise a runaway loop that always reverts wouldn't be caught.
 */
export function mostRecentTradeTimestamp(account: string, chain?: string): string | null {
  const db = openDb();
  const args: unknown[] = [account];
  let sql = "SELECT timestamp FROM trades WHERE account = ?";
  if (chain) {
    sql += " AND chain = ?";
    args.push(chain.toLowerCase());
  }
  sql += " ORDER BY timestamp DESC LIMIT 1";
  const row = db.prepare(sql).get(...(args as never[])) as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

// ── sync_bookmarks (iter737) ─────────────────────────────────

export interface SyncBookmark {
  chain: string;
  account: string;
  owner: string;
  lastSyncedBlock: bigint;
  updatedAt: string;
}

/**
 * Iter737: retrieve the sync bookmark for the (chain, account, owner) tuple.
 * Returns null when no bookmark exists or when the stored owner differs from
 * the queried owner (mnemonic rotation safety — see schema v9 comment). The
 * caller treats null as "fall back to the 30-day default lookback".
 */
export function getSyncBookmark(
  chain: string,
  account: string,
  owner: string,
): SyncBookmark | null {
  const db = openDb();
  // Lowercase the address — eth_getLogs topic encoding lowercases anyway, and
  // operators may pass checksum-cased addresses. Store + compare lowercase to
  // avoid the same wallet recording two bookmarks under different casing.
  const ownerLower = owner.toLowerCase();
  const row = db
    .prepare(
      `SELECT chain, account, owner, last_synced_block, updated_at
       FROM sync_bookmarks
       WHERE chain = ? AND account = ? AND owner = ?`,
    )
    .get(chain, account, ownerLower) as
    | { chain: string; account: string; owner: string; last_synced_block: number; updated_at: string }
    | undefined;
  if (!row) return null;
  return {
    chain: row.chain,
    account: row.account,
    owner: row.owner,
    // SQLite INTEGER fits up to 2^63 — block numbers are nowhere near that.
    // BigInt round-trip keeps the type symmetric with chunkBlockRange args.
    lastSyncedBlock: BigInt(row.last_synced_block),
    updatedAt: row.updated_at,
  };
}

/**
 * Iter737: upsert the sync bookmark. Called by trades_sync after a FULLY
 * successful scan (no chunkErrors). Idempotent — re-running with the same
 * block just bumps updated_at.
 */
export function setSyncBookmark(
  chain: string,
  account: string,
  owner: string,
  block: bigint,
): void {
  const db = openDb();
  const ownerLower = owner.toLowerCase();
  const now = new Date().toISOString();
  // SQLite INTEGER takes a JS number up to 2^53; block numbers fit comfortably.
  // bigint → number is safe in this range; assert defensively to flag future
  // chains with absurd block heights.
  if (block > 9_007_199_254_740_991n) {
    throw new Error(`block ${block} exceeds safe integer range for SQLite`);
  }
  db.prepare(
    `INSERT INTO sync_bookmarks (chain, account, owner, last_synced_block, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (chain, account, owner) DO UPDATE SET
       last_synced_block = excluded.last_synced_block,
       updated_at = excluded.updated_at`,
  ).run(chain, account, ownerLower, Number(block), now);
}

/**
 * Iter737: remove the bookmark so the next sync falls back to the 30-day
 * default. Used by the CLI --reset-bookmark flag. Returns the number of
 * rows deleted (0 or 1) for caller-side logging.
 */
export function clearSyncBookmark(
  chain: string,
  account: string,
  owner: string,
): number {
  const db = openDb();
  const ownerLower = owner.toLowerCase();
  const result = db
    .prepare(`DELETE FROM sync_bookmarks WHERE chain = ? AND account = ? AND owner = ?`)
    .run(chain, account, ownerLower);
  return Number(result.changes);
}

/**
 * Iter737: list all bookmarks for diagnostics. Useful for operators eyeballing
 * "which accounts × chains have I been syncing, and how stale are they". No
 * filtering — the table is small (one row per active sync target).
 */
export function listSyncBookmarks(): SyncBookmark[] {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT chain, account, owner, last_synced_block, updated_at
       FROM sync_bookmarks
       ORDER BY chain, account`,
    )
    .all() as Array<{ chain: string; account: string; owner: string; last_synced_block: number; updated_at: string }>;
  return rows.map((r) => ({
    chain: r.chain,
    account: r.account,
    owner: r.owner,
    lastSyncedBlock: BigInt(r.last_synced_block),
    updatedAt: r.updated_at,
  }));
}

/**
 * USD volume spent under a strategy tag. Used by the iter19 strategy-
 * budget safety layer. Sums `quote_amount` across success + pending
 * trades — pending is included for the same reason dailyUsdVolume
 * includes it: a trade that's still confirming may yet succeed, and
 * excluding it would let a careless operator double-spend their budget
 * by firing a second trade before the first lands.
 *
 * `sinceIso` is optional — omit for lifetime totals, pass an ISO
 * timestamp for windowed queries (e.g. last 24h). The composite index
 * idx_trades_strategy_ts (v18) covers both query shapes.
 *
 * Quote-USD convention matches dailyUsdVolume: we assume the quote
 * token is USD-pegged (USDC/USDT/DAI), which holds for ~all operator
 * traffic. Non-USD quotes would need a price-aware conversion, but
 * deferring that until an operator actually trades quote=WETH at scale.
 */
export function usdSpentUnderStrategy(tag: string, sinceIso?: string): number {
  const db = openDb();
  const args: (string | number)[] = [tag];
  let sql = `SELECT quote_amount FROM trades WHERE strategy = ? AND status IN ('success','pending')`;
  if (sinceIso) {
    sql += ` AND timestamp > ?`;
    args.push(sinceIso);
  }
  const rows = db.prepare(sql).all(...args) as unknown as { quote_amount: string }[];
  let total = 0;
  for (const r of rows) {
    const n = parseFloat(r.quote_amount);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

export function dailyUsdVolume(account: string, chain?: string): number {
  const db = openDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const args: unknown[] = [account, since];
  // Include 'pending' alongside 'success': a trade that timed out at receipt-wait may
  // still confirm. If we exclude it from the budget, the user can fire a second trade
  // and double-spend their daily limit. 'failed' is excluded — gas was paid, but no
  // value moved, so it shouldn't consume budget.
  let sql = `SELECT quote_amount, quote_symbol FROM trades WHERE account = ? AND timestamp > ? AND status IN ('success','pending')`;
  if (chain) {
    sql += ` AND chain = ?`;
    args.push(chain.toLowerCase()); // see recentTrades comment
  }
  const rows = db.prepare(sql).all(...(args as never[])) as unknown as { quote_amount: string; quote_symbol: string | null }[];
  let total = 0;
  for (const r of rows) {
    const n = parseFloat(r.quote_amount);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

// ── orders (v10) ─────────────────────────────────────────────
//
// Conditional/limit orders. The schema mirrors a TradeRequest plus the
// trigger metadata (target_price_usd + trigger_type), an expiry window, and
// a fill-side audit trail (filled_at/fill_tx_hash/fill_price). The order
// engine in src/orders.ts polls active rows on each tick, fires the trade
// via executeTrade when triggered, then writes back the outcome here.

export type OrderStatus = "active" | "filled" | "cancelled" | "expired" | "failed";
export type OrderSide = "buy" | "sell";
/** Trigger semantics:
 *   price_below — fires when current_price <= target_price_usd
 *   price_above — fires when current_price >= target_price_usd
 *
 * Common pairings (operator-side, not enforced by the engine):
 *   - limit buy:     side=buy,  trigger=price_below (buy the dip)
 *   - limit sell:    side=sell, trigger=price_above (sell into strength)
 *   - stop-loss:     side=sell, trigger=price_below (cut losses)
 *   - take-profit:   side=sell, trigger=price_above (lock in gains)
 *
 * We keep the two dimensions orthogonal: the engine just checks the price
 * predicate, and the operator labels their own intent via the `strategy`
 * column. Decoupling means a "buy on breakout" (side=buy, trigger=
 * price_above) is expressible without inventing a new trigger type. */
export type OrderTrigger = "price_below" | "price_above" | "trailing";

export interface OrderRow {
  id?: number;
  created_at: string;
  updated_at: string;
  status: OrderStatus;
  side: OrderSide;
  trigger_type: OrderTrigger;
  /** Target USD price.
   *   - For price_below / price_above: the trigger threshold (always set).
   *   - For trailing: the OPTIONAL activation gate. NULL means "start
   *     tracking the water mark immediately". Non-null means "wait until
   *     current price reaches X before the trail starts moving" — useful
   *     for "trail after ETH hits $3500" patterns. */
  target_price_usd: number | null;
  /** Trailing-only: % retracement that triggers the fill (e.g. 5 = 5%).
   *  NULL for non-trailing orders; required for trailing (validated at
   *  application layer in createOrderRow). */
  trail_pct: number | null;
  /** Trailing-only: running high (sell) / low (buy) USD price observed
   *  since trail activation. Updated by the engine on every tick where
   *  the order is active + activated. NULL until first tracking tick lands
   *  OR when the activation gate hasn't been reached yet. */
  water_mark_usd: number | null;
  chain: string;
  account: string;
  base_token: string;
  base_symbol: string | null;
  quote_token: string;
  quote_symbol: string | null;
  /** Decimal-string amounts. Exactly one of base_amount / quote_amount is set
   *  at creation time — matches the executeTrade contract (one is required,
   *  the other is computed at fill time from the live quote). */
  base_amount: string | null;
  quote_amount: string | null;
  slippage_bps: number | null;
  /** Stored as 0/1 because node:sqlite has no native boolean; cast back to bool
   *  on read. When 1, the engine ignores slippage_bps and runs --auto-slippage
   *  at fill time. */
  auto_slippage: number;
  expires_at: string | null;
  strategy: string | null;
  note: string | null;
  attempts: number;
  last_checked_at: string | null;
  last_checked_price: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  filled_at: string | null;
  fill_tx_hash: string | null;
  fill_price: number | null;
  fill_base_amount: string | null;
  fill_quote_amount: string | null;
  /** OCO group id (v14). Free-form operator-supplied string. Orders sharing
   *  a non-null group_id are OCO peers: when ANY peer transitions to a
   *  terminal state via the engine (filled / failed / expired), the engine
   *  cancels the remaining active peers with reason OCO_PEER_FIRED.
   *  Operator-driven cancel does NOT cascade by default — use the
   *  `--cascade` flag on `order cancel` to opt in. */
  group_id?: string | null;
  /** Paper trading flag (v24). When 1, the engine routes the FIRE step
   *  to the virtual book (paper_trades + paper_balances) instead of
   *  executeTrade. Triggers, watermarks, expiry, OCO cascade — all
   *  evaluated identically; only the terminal write differs. Defaults
   *  to 0 (real trading) — pre-v24 rows are unaffected. */
  paper?: number;
}

export interface InsertOrderArgs {
  side: OrderSide;
  trigger_type: OrderTrigger;
  /** Required for price_below / price_above; OPTIONAL (nullable) for
   *  trailing — null = no activation gate. */
  target_price_usd: number | null;
  /** Required for trailing; null for legacy trigger types. */
  trail_pct: number | null;
  chain: string;
  account: string;
  base_token: string;
  base_symbol: string | null;
  quote_token: string;
  quote_symbol: string | null;
  base_amount: string | null;
  quote_amount: string | null;
  slippage_bps: number | null;
  auto_slippage: boolean;
  expires_at: string | null;
  strategy: string | null;
  note: string | null;
  /** OCO group identifier. Null when the order isn't part of a group.
   *  Validated by createOrderRow (≤64 chars, alphanumeric/dash/underscore). */
  group_id: string | null;
  /** Iter30: when true the order fires against the virtual book instead
   *  of executing on-chain. Default false. Validated upstream. */
  paper?: boolean;
}

export function insertOrder(args: InsertOrderArgs): number {
  const db = openDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO orders (
         created_at, updated_at, status, side, trigger_type, target_price_usd, trail_pct,
         chain, account,
         base_token, base_symbol, quote_token, quote_symbol,
         base_amount, quote_amount, slippage_bps, auto_slippage,
         expires_at, strategy, note,
         attempts, group_id, paper
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      now, now, "active", args.side, args.trigger_type, args.target_price_usd, args.trail_pct,
      args.chain.toLowerCase(), args.account,
      args.base_token, args.base_symbol,
      args.quote_token, args.quote_symbol,
      args.base_amount, args.quote_amount,
      args.slippage_bps, args.auto_slippage ? 1 : 0,
      args.expires_at, args.strategy, capTradeNotes(args.note),
      0, args.group_id, args.paper ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Find ACTIVE peers of an order in the same OCO group, excluding the
 * order itself. Used by the cascade in the orders engine — when an
 * order transitions to a terminal state, we walk its group and cancel
 * the remaining peers.
 *
 * Returns empty array when `groupId` is null/undefined or when no active
 * peers exist. Indexed lookup via idx_orders_group_id keeps this cheap.
 */
export function findActiveGroupPeers(orderId: number, groupId: string | null | undefined): OrderRow[] {
  if (!groupId) return [];
  const db = openDb();
  return db
    .prepare(`SELECT * FROM orders WHERE group_id = ? AND id != ? AND status = 'active'`)
    .all(groupId, orderId) as unknown as OrderRow[];
}

/**
 * Cascade-cancel every active peer of `firedOrderId` in `groupId`,
 * stamping a structured reason on each peer. Returns the IDs of orders
 * that were actually cancelled (for telemetry).
 *
 * The cascade is non-recursive: cancelling a peer transitions it to
 * `cancelled`, which is NOT a state the engine cascades from (only
 * filled/failed/expired do). So a 3-way OCO group where order #1 fires
 * cancels #2 + #3 in one pass — no risk of infinite loops.
 *
 * `reason` is recorded in last_error_code; the engine uses
 * `OCO_PEER_FIRED` for engine-driven cascades and `OCO_OPERATOR_CASCADE`
 * for operator-initiated `cancel --cascade`.
 */
export function cancelOcoPeers(
  firedOrderId: number,
  groupId: string | null | undefined,
  reason: "OCO_PEER_FIRED" | "OCO_OPERATOR_CASCADE",
  reasonMessage: string,
): number[] {
  if (!groupId) return [];
  const db = openDb();
  const peers = findActiveGroupPeers(firedOrderId, groupId);
  if (peers.length === 0) return [];
  const now = new Date().toISOString();
  const cancelled: number[] = [];
  const stmt = db.prepare(
    `UPDATE orders SET status = 'cancelled', updated_at = ?, last_error_code = ?, last_error_message = ?
     WHERE id = ? AND status = 'active'`,
  );
  for (const peer of peers) {
    if (peer.id == null) continue;
    const result = stmt.run(now, reason, capAuditText(reasonMessage), peer.id);
    if (Number(result.changes) > 0) cancelled.push(peer.id);
  }
  return cancelled;
}

/**
 * Trailing-stop water-mark update. The engine calls this on every tick
 * where a trailing order moved its high (sell) or low (buy) mark. Pure
 * column write — caller decides whether to update (don't write when the
 * mark is unchanged so updated_at stays stable for tick-rate accounting). */
export function updateOrderWaterMark(id: number, waterMarkUsd: number): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE orders SET water_mark_usd = ?, updated_at = ? WHERE id = ?`).run(
    waterMarkUsd,
    now,
    id,
  );
}

export function getOrderById(id: number): OrderRow | null {
  const db = openDb();
  const row = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
  return row ?? null;
}

export interface OrderFilter {
  status?: OrderStatus | "all";
  chain?: string;
  account?: string;
  strategy?: string;
  /** OCO group id filter — returns only orders sharing this group_id. */
  group?: string;
  limit?: number;
}

export function listOrders(filter: OrderFilter = {}): OrderRow[] {
  const db = openDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status && filter.status !== "all") {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.chain) {
    where.push("chain = ?");
    args.push(filter.chain.toLowerCase());
  }
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  if (filter.strategy) {
    where.push("strategy = ?");
    args.push(filter.strategy);
  }
  if (filter.group) {
    where.push("group_id = ?");
    args.push(filter.group);
  }
  const sql = `SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC ${filter.limit ? "LIMIT ?" : ""}`;
  if (filter.limit) args.push(filter.limit);
  return db.prepare(sql).all(...(args as never[])) as unknown as OrderRow[];
}

/** Active orders only, optionally scoped. Used by the engine tick — keep this
 *  call extremely cheap (idx_orders_status covers the leading predicate). */
export function activeOrders(filter: { chain?: string; account?: string } = {}): OrderRow[] {
  return listOrders({ ...filter, status: "active" });
}

/** Record an engine-tick observation (price + timestamp) on an active order
 *  without changing its status. Lets `order list` show "last checked X ago at
 *  price $Y" so an operator can verify the engine is actually running. */
export function recordOrderCheck(id: number, priceUsd: number | null): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE orders SET last_checked_at = ?, last_checked_price = ?, updated_at = ?, attempts = attempts + 1 WHERE id = ?`,
  ).run(now, priceUsd, now, id);
}

/** Mark an order as filled with the fill details from a successful trade.
 *  Idempotent on status — re-firing a same-tx fill (e.g. caller crashed
 *  between trade-send and DB write last time) overwrites without complaint. */
export function markOrderFilled(
  id: number,
  fill: {
    tx_hash: string;
    fill_price: number;
    base_amount: string;
    quote_amount: string;
  },
): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE orders SET
       status = 'filled',
       updated_at = ?,
       filled_at = ?,
       fill_tx_hash = ?,
       fill_price = ?,
       fill_base_amount = ?,
       fill_quote_amount = ?,
       last_error_code = NULL,
       last_error_message = NULL
     WHERE id = ?`,
  ).run(now, now, fill.tx_hash, fill.fill_price, fill.base_amount, fill.quote_amount, id);
}

/** Mark an order as failed with an error code + message. Distinguished from
 *  "leave active and retry" — only call this for terminal failures (revert,
 *  blacklist, etc.). Transient failures (RPC down) should record the error
 *  via setOrderError and leave the status active so the next tick retries. */
export function markOrderFailed(id: number, code: string, message: string): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE orders SET status = 'failed', updated_at = ?, last_error_code = ?, last_error_message = ? WHERE id = ?`,
  ).run(now, code, capAuditText(message), id);
}

/** Mark an order as expired. Called when the engine observes now >= expires_at. */
export function markOrderExpired(id: number): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ?`).run(now, id);
}

/** Operator-initiated cancellation. Idempotent — re-cancelling a cancelled
 *  order is a no-op (returns 0). Refuses to cancel a row that already filled
 *  or expired (returns -1) — the caller surfaces an INVALID_PARAMS-equivalent
 *  to avoid silent no-ops on terminal states. */
export function cancelOrder(id: number): number {
  const db = openDb();
  const existing = getOrderById(id);
  if (!existing) return 0;
  if (existing.status === "filled" || existing.status === "expired") return -1;
  if (existing.status === "cancelled") return 0;
  const now = new Date().toISOString();
  const r = db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, id);
  return Number(r.changes);
}

/** Stamp an order with a non-terminal error encountered on a tick (e.g. RPC
 *  flake, transient simulation revert). Status stays active so the next tick
 *  retries; the error trail surfaces via `order show` / `order list --json`. */
export function setOrderError(id: number, code: string, message: string): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE orders SET updated_at = ?, last_error_code = ?, last_error_message = ? WHERE id = ?`,
  ).run(now, code, capAuditText(message), id);
}

// ── iter34: in-place edit of orders + schedules ──────────────
//
// Pre-iter34, modifying a deployed primitive meant cancel + recreate
// — losing trailing HWM, attempt counter, journal continuity. The
// helpers below apply a TARGETED column update guarded on
// `status='active'` so the engine can never silently lose an
// operator edit to a concurrent tick's writeback. The columns
// these UPDATE statements touch are a strict subset of the
// engine-writable columns; the two writers never overlap.

/** Fields the operator may edit on an active order. NON-editable
 *  by design: id, side, chain, account, base_token, quote_token,
 *  trigger_type, group_id — changing any of these means a different
 *  order; force a destroy + recreate. Engine-managed columns
 *  (attempts, last_checked_at, water_mark_usd, fill_*) are
 *  excluded — operators don't edit them.
 *
 *  Each field is independently optional. Omit a key to leave that
 *  column untouched. Pass `null` to clear (only for nullable
 *  columns — the orderEdit layer validates).
 */
export interface OrderEditableFields {
  target_price_usd?: number | null;
  trail_pct?: number | null;
  base_amount?: string | null;
  quote_amount?: string | null;
  slippage_bps?: number | null;
  auto_slippage?: boolean;
  expires_at?: string | null;
  strategy?: string | null;
  note?: string | null;
  paper?: boolean;
}

/** Apply a targeted in-place edit to an active order. Returns the
 *  row count (0 = no row matched, 1 = updated). Pure SQL — the
 *  caller (orderEdit.ts) validates first and journals after. */
export function updateOrderEditable(
  id: number,
  changes: OrderEditableFields,
): number {
  const db = openDb();
  // Build the SET clause dynamically — only columns that appear in
  // `changes` get touched. SQL keys are the column names verbatim;
  // type-safe because OrderEditableFields keys equal them 1:1.
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if ("target_price_usd" in changes) {
    sets.push("target_price_usd = ?");
    args.push(changes.target_price_usd ?? null);
  }
  if ("trail_pct" in changes) {
    sets.push("trail_pct = ?");
    args.push(changes.trail_pct ?? null);
  }
  if ("base_amount" in changes) {
    sets.push("base_amount = ?");
    args.push(changes.base_amount ?? null);
  }
  if ("quote_amount" in changes) {
    sets.push("quote_amount = ?");
    args.push(changes.quote_amount ?? null);
  }
  if ("slippage_bps" in changes) {
    sets.push("slippage_bps = ?");
    args.push(changes.slippage_bps ?? null);
  }
  if ("auto_slippage" in changes) {
    sets.push("auto_slippage = ?");
    args.push(changes.auto_slippage ? 1 : 0);
  }
  if ("expires_at" in changes) {
    sets.push("expires_at = ?");
    args.push(changes.expires_at ?? null);
  }
  if ("strategy" in changes) {
    sets.push("strategy = ?");
    args.push(changes.strategy ?? null);
  }
  if ("note" in changes) {
    sets.push("note = ?");
    args.push(changes.note ?? null);
  }
  if ("paper" in changes) {
    sets.push("paper = ?");
    args.push(changes.paper ? 1 : 0);
  }
  if (sets.length === 0) return 0;
  const now = new Date().toISOString();
  sets.push("updated_at = ?");
  args.push(now);
  args.push(id);
  // The status='active' guard makes the UPDATE a no-op if the
  // engine has just flipped the row to filled/failed/expired —
  // caller treats `changes=0` as a race-loss + reports the
  // current status to the operator.
  const sql = `UPDATE orders SET ${sets.join(", ")} WHERE id = ? AND status = 'active'`;
  const r = db.prepare(sql).run(...args);
  return Number(r.changes ?? 0);
}

/** Schedule-side counterpart. Editable fields: cron_expr +
 *  next_run_at (operator-driven cron change), slippage,
 *  auto_slippage, end_at, max_runs, base/quote amount, strategy,
 *  note, paper, on_fill_json. NON-editable: side, chain, account,
 *  base/quote token, status, start_at (immutable boundary), run_count
 *  (engine-only). */
export interface ScheduleEditableFields {
  cron_expr?: string;
  next_run_at?: string;
  base_amount?: string | null;
  quote_amount?: string | null;
  slippage_bps?: number | null;
  auto_slippage?: boolean;
  end_at?: string | null;
  max_runs?: number | null;
  strategy?: string | null;
  note?: string | null;
  paper?: boolean;
  on_fill_json?: string | null;
}

export function updateScheduleEditable(
  id: number,
  changes: ScheduleEditableFields,
): number {
  const db = openDb();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if ("cron_expr" in changes && changes.cron_expr != null) {
    sets.push("cron_expr = ?");
    args.push(changes.cron_expr);
  }
  if ("next_run_at" in changes && changes.next_run_at != null) {
    sets.push("next_run_at = ?");
    args.push(changes.next_run_at);
  }
  if ("base_amount" in changes) {
    sets.push("base_amount = ?");
    args.push(changes.base_amount ?? null);
  }
  if ("quote_amount" in changes) {
    sets.push("quote_amount = ?");
    args.push(changes.quote_amount ?? null);
  }
  if ("slippage_bps" in changes) {
    sets.push("slippage_bps = ?");
    args.push(changes.slippage_bps ?? null);
  }
  if ("auto_slippage" in changes) {
    sets.push("auto_slippage = ?");
    args.push(changes.auto_slippage ? 1 : 0);
  }
  if ("end_at" in changes) {
    sets.push("end_at = ?");
    args.push(changes.end_at ?? null);
  }
  if ("max_runs" in changes) {
    sets.push("max_runs = ?");
    args.push(changes.max_runs ?? null);
  }
  if ("strategy" in changes) {
    sets.push("strategy = ?");
    args.push(changes.strategy ?? null);
  }
  if ("note" in changes) {
    sets.push("note = ?");
    args.push(changes.note ?? null);
  }
  if ("paper" in changes) {
    sets.push("paper = ?");
    args.push(changes.paper ? 1 : 0);
  }
  if ("on_fill_json" in changes) {
    sets.push("on_fill_json = ?");
    args.push(changes.on_fill_json ?? null);
  }
  if (sets.length === 0) return 0;
  const now = new Date().toISOString();
  sets.push("updated_at = ?");
  args.push(now);
  args.push(id);
  // Guard on status='active' OR 'paused' — paused schedules are
  // legitimate edit targets (operator wants to re-tune a paused
  // schedule before resuming). Schedules go 'completed' /
  // 'cancelled' as terminal states; those can't be edited.
  const sql = `UPDATE schedules SET ${sets.join(", ")} WHERE id = ? AND status IN ('active', 'paused')`;
  const r = db.prepare(sql).run(...args);
  return Number(r.changes ?? 0);
}

// ── schedules (v11) ──────────────────────────────────────────
//
// Mirror of the orders surface, but for time-triggered recurring trades.
// The engine (src/schedules.ts) recomputes next_run_at on every fire so
// the per-tick query is a cheap indexed range scan (`WHERE status='active'
// AND next_run_at <= now`).

export type ScheduleStatus = "active" | "paused" | "completed" | "cancelled";

export interface ScheduleRow {
  id?: number;
  created_at: string;
  updated_at: string;
  status: ScheduleStatus;
  name: string | null;
  cron_expr: string;
  next_run_at: string;
  side: OrderSide;
  chain: string;
  account: string;
  base_token: string;
  base_symbol: string | null;
  quote_token: string;
  quote_symbol: string | null;
  base_amount: string | null;
  quote_amount: string | null;
  slippage_bps: number | null;
  auto_slippage: number; // 0|1 (SQLite has no boolean)
  start_at: string | null;
  end_at: string | null;
  max_runs: number | null;
  strategy: string | null;
  note: string | null;
  run_count: number;
  last_run_at: string | null;
  last_run_tx_hash: string | null;
  last_run_status: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  /** Decimal-string running total of filled base across all fires. */
  total_base_filled: string | null;
  /** Decimal-string running total of quote spent across all fires. */
  total_quote_spent: string | null;
  /** Iter27: optional JSON-serialized post-fill hook spec. When non-null,
   *  the engine executes this after each successful fire. Validated at
   *  schedule-create time (fake fill rendered through createOrderRow);
   *  executed with real fill data at fire time. v1 only supports
   *  `type: "createOrder"`. NULL = no hook (existing schedules
   *  behave unchanged). */
  on_fill_json?: string | null;
  /** Paper trading flag (v24). When 1, the schedule fires against the
   *  virtual book on each cron tick (paper_trades + paper_balances)
   *  rather than executing on-chain. Defaults to 0. */
  paper?: number;
}

export interface InsertScheduleArgs {
  name: string | null;
  cron_expr: string;
  next_run_at: string;
  side: OrderSide;
  chain: string;
  account: string;
  base_token: string;
  base_symbol: string | null;
  quote_token: string;
  quote_symbol: string | null;
  base_amount: string | null;
  quote_amount: string | null;
  slippage_bps: number | null;
  auto_slippage: boolean;
  start_at: string | null;
  end_at: string | null;
  max_runs: number | null;
  strategy: string | null;
  note: string | null;
  /** Iter27: optional JSON-serialized post-fill hook spec. NULL =
   *  no hook. Validated upstream (scheduleHooks.validateOnFillSpec)
   *  before this insert; the DB layer just persists. */
  on_fill_json?: string | null;
  /** Iter30: when true the schedule fires against the virtual book
   *  instead of executing on-chain. Default false. */
  paper?: boolean;
}

export function insertSchedule(args: InsertScheduleArgs): number {
  const db = openDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO schedules (
         created_at, updated_at, status, name, cron_expr, next_run_at,
         side, chain, account,
         base_token, base_symbol, quote_token, quote_symbol,
         base_amount, quote_amount, slippage_bps, auto_slippage,
         start_at, end_at, max_runs, strategy, note, run_count, on_fill_json, paper
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      now, now, "active", args.name, args.cron_expr, args.next_run_at,
      args.side, args.chain.toLowerCase(), args.account,
      args.base_token, args.base_symbol,
      args.quote_token, args.quote_symbol,
      args.base_amount, args.quote_amount,
      args.slippage_bps, args.auto_slippage ? 1 : 0,
      args.start_at, args.end_at, args.max_runs,
      args.strategy, capTradeNotes(args.note), 0,
      args.on_fill_json ?? null, args.paper ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}

export function getScheduleById(id: number): ScheduleRow | null {
  const db = openDb();
  const row = db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as ScheduleRow | undefined;
  return row ?? null;
}

export interface ScheduleFilter {
  status?: ScheduleStatus | "all";
  chain?: string;
  account?: string;
  strategy?: string;
  limit?: number;
}

export function listSchedules(filter: ScheduleFilter = {}): ScheduleRow[] {
  const db = openDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status && filter.status !== "all") {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.chain) {
    where.push("chain = ?");
    args.push(filter.chain.toLowerCase());
  }
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  if (filter.strategy) {
    where.push("strategy = ?");
    args.push(filter.strategy);
  }
  const sql = `SELECT * FROM schedules ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC ${filter.limit ? "LIMIT ?" : ""}`;
  if (filter.limit) args.push(filter.limit);
  return db.prepare(sql).all(...(args as never[])) as unknown as ScheduleRow[];
}

/** Active schedules whose next_run_at is ≤ the given timestamp. The engine
 *  uses this to fetch ONLY due rows per tick — cheap when most schedules
 *  aren't due (idx_schedules_next_run covers the range). */
export function dueSchedules(asOfIso: string): ScheduleRow[] {
  const db = openDb();
  return db
    .prepare(
      `SELECT * FROM schedules
       WHERE status = 'active' AND next_run_at <= ?
       ORDER BY id ASC`,
    )
    .all(asOfIso) as unknown as ScheduleRow[];
}

/** Update `next_run_at` in isolation (used when the engine reschedules a
 *  paused→resumed schedule, or after a manual nudge). Doesn't touch the
 *  run telemetry — that's recordScheduleFire's job. */
export function setScheduleNextRunAt(id: number, nextRunAt: string): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?`).run(
    nextRunAt,
    now,
    id,
  );
}

/** Stamp a successful fire onto the schedule: bump run_count, totals,
 *  last_run_*, and advance next_run_at to the freshly-computed next slot.
 *  Caller is the engine — it computes the new next_run_at via cron.nextRun
 *  before invoking this helper. */
export function recordScheduleFire(
  id: number,
  fire: {
    nextRunAt: string;
    txHash: string;
    baseAmount: string;
    quoteAmount: string;
    completed: boolean;
  },
): void {
  const db = openDb();
  const now = new Date().toISOString();
  // Append-in-place to the decimal-string totals. parseFloat is enough
  // for the precision we need (operator-facing summary, not on-chain
  // accounting); on-chain accounting comes from the trades rows.
  const existing = getScheduleById(id);
  const prevBase = existing?.total_base_filled ? parseFloat(existing.total_base_filled) : 0;
  const prevQuote = existing?.total_quote_spent ? parseFloat(existing.total_quote_spent) : 0;
  const addBase = parseFloat(fire.baseAmount);
  const addQuote = parseFloat(fire.quoteAmount);
  const newBase = Number.isFinite(prevBase + addBase) ? String(prevBase + addBase) : existing?.total_base_filled ?? null;
  const newQuote = Number.isFinite(prevQuote + addQuote) ? String(prevQuote + addQuote) : existing?.total_quote_spent ?? null;
  const newStatus: ScheduleStatus = fire.completed ? "completed" : "active";
  db.prepare(
    `UPDATE schedules SET
       status = ?,
       updated_at = ?,
       next_run_at = ?,
       last_run_at = ?,
       last_run_tx_hash = ?,
       last_run_status = 'success',
       last_error_code = NULL,
       last_error_message = NULL,
       run_count = run_count + 1,
       total_base_filled = ?,
       total_quote_spent = ?
     WHERE id = ?`,
  ).run(newStatus, now, fire.nextRunAt, now, fire.txHash, newBase, newQuote, id);
}

/** Stamp a failed fire. Status decisions:
 *   - transient (RPC down, rate limit): leave active so the next tick
 *     retries with a fresh next_run_at advanced by one schedule period.
 *   - terminal (revert, safety violation): leave active too — DCA users
 *     generally want each occurrence to be evaluated independently. We
 *     record the error trail on the row so notify + `schedule show`
 *     surface it. (Operators who want a strict halt-on-error mode can
 *     pause the schedule from the notification callback.)
 *
 *  Advances next_run_at in both cases — otherwise a failing schedule
 *  would refire on every tick within the same minute. */
export function recordScheduleError(
  id: number,
  nextRunAt: string,
  errorCode: string,
  errorMessage: string,
): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE schedules SET
       updated_at = ?,
       next_run_at = ?,
       last_run_at = ?,
       last_run_status = 'failed',
       last_error_code = ?,
       last_error_message = ?,
       run_count = run_count + 1
     WHERE id = ?`,
  ).run(now, nextRunAt, now, errorCode, capAuditText(errorMessage), id);
}

export function pauseSchedule(id: number): number {
  const db = openDb();
  const existing = getScheduleById(id);
  if (!existing) return 0;
  if (existing.status !== "active") return -1;
  const now = new Date().toISOString();
  const r = db.prepare(`UPDATE schedules SET status = 'paused', updated_at = ? WHERE id = ?`).run(now, id);
  return Number(r.changes);
}

export function resumeSchedule(id: number, nextRunAt: string): number {
  const db = openDb();
  const existing = getScheduleById(id);
  if (!existing) return 0;
  if (existing.status !== "paused") return -1;
  const now = new Date().toISOString();
  const r = db
    .prepare(`UPDATE schedules SET status = 'active', next_run_at = ?, updated_at = ? WHERE id = ?`)
    .run(nextRunAt, now, id);
  return Number(r.changes);
}

export function cancelSchedule(id: number): number {
  const db = openDb();
  const existing = getScheduleById(id);
  if (!existing) return 0;
  if (existing.status === "completed" || existing.status === "cancelled") return 0;
  const now = new Date().toISOString();
  const r = db.prepare(`UPDATE schedules SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, id);
  return Number(r.changes);
}

export function scheduleCountsByStatus(): Record<ScheduleStatus, number> {
  const db = openDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM schedules GROUP BY status`)
    .all() as Array<{ status: ScheduleStatus; n: number }>;
  const out: Record<ScheduleStatus, number> = { active: 0, paused: 0, completed: 0, cancelled: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** Aggregate counts by status — used by the `order list` summary header and
 *  the MCP order_list pre-aggregated `summary` field. Single SQL pass. */
export function orderCountsByStatus(): Record<OrderStatus, number> {
  const db = openDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status`)
    .all() as Array<{ status: OrderStatus; n: number }>;
  const out: Record<OrderStatus, number> = { active: 0, filled: 0, cancelled: 0, expired: 0, failed: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ── rebalance plans (v13) ────────────────────────────────────
//
// Same lifecycle / cadence model as schedules. The engine evaluates each
// active plan on its cron cadence, computes per-target drift, and either
// fires the rebalance trades or skips (when max drift < threshold).

export type RebalanceStatus = "active" | "paused" | "completed" | "cancelled";

export interface RebalanceTarget {
  /** Token symbol (case-insensitive) OR 0x address. */
  token: string;
  /** Target weight as % of portfolio (0-100). */
  targetPct: number;
}

export interface RebalanceRow {
  id?: number;
  created_at: string;
  updated_at: string;
  status: RebalanceStatus;
  name: string | null;
  account: string;
  chain: string;
  /** Quote token used as the routing anchor (sell over-weight → quote → buy
   *  under-weight). 0x address (lowercased). */
  quote_token: string;
  quote_symbol: string | null;
  /** JSON-serialized RebalanceTarget[]. */
  targets_json: string;
  drift_threshold_pct: number;
  min_trade_usd: number;
  cron_expr: string;
  next_run_at: string;
  start_at: string | null;
  end_at: string | null;
  max_runs: number | null;
  slippage_bps: number | null;
  auto_slippage: number;
  strategy: string | null;
  note: string | null;
  run_count: number;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_executed_count: number | null;
  last_run_skipped_count: number | null;
  last_run_max_drift_pct: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

export interface InsertRebalancePlanArgs {
  name: string | null;
  account: string;
  chain: string;
  quote_token: string;
  quote_symbol: string | null;
  targets: RebalanceTarget[];
  drift_threshold_pct: number;
  min_trade_usd: number;
  cron_expr: string;
  next_run_at: string;
  start_at: string | null;
  end_at: string | null;
  max_runs: number | null;
  slippage_bps: number | null;
  auto_slippage: boolean;
  strategy: string | null;
  note: string | null;
}

export function insertRebalancePlan(args: InsertRebalancePlanArgs): number {
  const db = openDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO rebalance_plans (
         created_at, updated_at, status, name, account, chain,
         quote_token, quote_symbol, targets_json,
         drift_threshold_pct, min_trade_usd,
         cron_expr, next_run_at, start_at, end_at, max_runs,
         slippage_bps, auto_slippage, strategy, note,
         run_count
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      now, now, "active", args.name, args.account, args.chain.toLowerCase(),
      args.quote_token.toLowerCase(), args.quote_symbol,
      JSON.stringify(args.targets),
      args.drift_threshold_pct, args.min_trade_usd,
      args.cron_expr, args.next_run_at, args.start_at, args.end_at, args.max_runs,
      args.slippage_bps, args.auto_slippage ? 1 : 0,
      args.strategy, capTradeNotes(args.note),
      0,
    );
  return Number(result.lastInsertRowid);
}

export function getRebalancePlanById(id: number): RebalanceRow | null {
  const db = openDb();
  const row = db.prepare(`SELECT * FROM rebalance_plans WHERE id = ?`).get(id) as RebalanceRow | undefined;
  return row ?? null;
}

export interface RebalancePlanFilter {
  status?: RebalanceStatus | "all";
  chain?: string;
  account?: string;
  strategy?: string;
  limit?: number;
}

export function listRebalancePlans(filter: RebalancePlanFilter = {}): RebalanceRow[] {
  const db = openDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status && filter.status !== "all") {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.chain) {
    where.push("chain = ?");
    args.push(filter.chain.toLowerCase());
  }
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  if (filter.strategy) {
    where.push("strategy = ?");
    args.push(filter.strategy);
  }
  const sql = `SELECT * FROM rebalance_plans ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC ${filter.limit ? "LIMIT ?" : ""}`;
  if (filter.limit) args.push(filter.limit);
  return db.prepare(sql).all(...(args as never[])) as unknown as RebalanceRow[];
}

/** Indexed range scan on (status='active' AND next_run_at <= asOf). */
export function dueRebalancePlans(asOfIso: string): RebalanceRow[] {
  const db = openDb();
  return db
    .prepare(
      `SELECT * FROM rebalance_plans
       WHERE status = 'active' AND next_run_at <= ?
       ORDER BY id ASC`,
    )
    .all(asOfIso) as unknown as RebalanceRow[];
}

export function setRebalancePlanNextRunAt(id: number, nextRunAt: string): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE rebalance_plans SET next_run_at = ?, updated_at = ? WHERE id = ?`).run(
    nextRunAt, now, id,
  );
}

/** Record a successful tick (whether or not trades fired). Advances
 *  next_run_at + bumps run_count + stamps the last-run telemetry. */
export function recordRebalanceRun(
  id: number,
  run: {
    nextRunAt: string;
    status: "executed" | "skipped";
    executedCount: number;
    skippedCount: number;
    maxDriftPct: number;
    completed: boolean;
  },
): void {
  const db = openDb();
  const now = new Date().toISOString();
  const newStatus: RebalanceStatus = run.completed ? "completed" : "active";
  db.prepare(
    `UPDATE rebalance_plans SET
       status = ?,
       updated_at = ?,
       next_run_at = ?,
       last_run_at = ?,
       last_run_status = ?,
       last_run_executed_count = ?,
       last_run_skipped_count = ?,
       last_run_max_drift_pct = ?,
       last_error_code = NULL,
       last_error_message = NULL,
       run_count = run_count + 1
     WHERE id = ?`,
  ).run(
    newStatus, now, run.nextRunAt, now, run.status,
    run.executedCount, run.skippedCount, run.maxDriftPct,
    id,
  );
}

/** Record a failed tick. Mirrors recordScheduleError — advance next_run_at
 *  so a failing plan doesn't refire every tick, but leave status=active
 *  for next-tick retry. Error trail stays on the row. */
export function recordRebalanceError(
  id: number,
  nextRunAt: string,
  errorCode: string,
  errorMessage: string,
): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE rebalance_plans SET
       updated_at = ?,
       next_run_at = ?,
       last_run_at = ?,
       last_run_status = 'failed',
       last_error_code = ?,
       last_error_message = ?,
       run_count = run_count + 1
     WHERE id = ?`,
  ).run(now, nextRunAt, now, errorCode, capAuditText(errorMessage), id);
}

export function pauseRebalancePlan(id: number): number {
  const db = openDb();
  const existing = getRebalancePlanById(id);
  if (!existing) return 0;
  if (existing.status !== "active") return -1;
  const now = new Date().toISOString();
  const r = db.prepare(`UPDATE rebalance_plans SET status = 'paused', updated_at = ? WHERE id = ?`).run(now, id);
  return Number(r.changes);
}

export function resumeRebalancePlan(id: number, nextRunAt: string): number {
  const db = openDb();
  const existing = getRebalancePlanById(id);
  if (!existing) return 0;
  if (existing.status !== "paused") return -1;
  const now = new Date().toISOString();
  const r = db
    .prepare(`UPDATE rebalance_plans SET status = 'active', next_run_at = ?, updated_at = ? WHERE id = ?`)
    .run(nextRunAt, now, id);
  return Number(r.changes);
}

export function cancelRebalancePlan(id: number): number {
  const db = openDb();
  const existing = getRebalancePlanById(id);
  if (!existing) return 0;
  if (existing.status === "completed" || existing.status === "cancelled") return 0;
  const now = new Date().toISOString();
  const r = db.prepare(`UPDATE rebalance_plans SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, id);
  return Number(r.changes);
}

export function rebalancePlanCountsByStatus(): Record<RebalanceStatus, number> {
  const db = openDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM rebalance_plans GROUP BY status`)
    .all() as Array<{ status: RebalanceStatus; n: number }>;
  const out: Record<RebalanceStatus, number> = { active: 0, paused: 0, completed: 0, cancelled: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ── token safety cache (v15) ─────────────────────────────────
//
// Read-through cache for the pre-trade honeypot probe. See the v15
// migration comment above for the design rationale.

export type TokenSafetyCacheVerdict = "ok" | "suspicious" | "honeypot" | "unknown";

export interface TokenSafetyCacheRow {
  chain: string;
  token_address: string;
  verdict: TokenSafetyCacheVerdict;
  /** Full TokenSafetyReport serialized to JSON. Optional — manual
   *  invocations write it, lookup callers read it for `--json` output. */
  details_json: string | null;
  probe_usd: number | null;
  checked_at: string;
  expires_at: string;
}

/** Lookup a cached verdict for (chain, token_address). Returns null when
 *  the row is missing OR expired (caller treats both as cache-miss). */
export function getCachedTokenVerdict(
  chain: string,
  tokenAddress: string,
  nowIso: string = new Date().toISOString(),
): TokenSafetyCacheRow | null {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT * FROM token_safety_cache
       WHERE chain = ? AND token_address = ? AND expires_at > ?`,
    )
    .get(chain.toLowerCase(), tokenAddress.toLowerCase(), nowIso) as
    | TokenSafetyCacheRow
    | undefined;
  return row ?? null;
}

/** Insert-or-replace a verdict row. `cacheTtlMs` determines the expires_at
 *  relative to now. Caller passes the full TokenSafetyReport JSON for
 *  forensic inspection. */
export function putCachedTokenVerdict(args: {
  chain: string;
  tokenAddress: string;
  verdict: TokenSafetyCacheVerdict;
  detailsJson: string | null;
  probeUsd: number | null;
  cacheTtlMs: number;
  now?: Date;
}): void {
  const db = openDb();
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + args.cacheTtlMs).toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO token_safety_cache
       (chain, token_address, verdict, details_json, probe_usd, checked_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.chain.toLowerCase(),
    args.tokenAddress.toLowerCase(),
    args.verdict,
    args.detailsJson,
    args.probeUsd,
    now.toISOString(),
    expiresAt,
  );
}

/** Purge cached verdicts whose expires_at is in the past. Optional GC —
 *  not strictly needed (lookups already filter by expires_at) but the
 *  doctor command exposes this for manual cleanup. Returns deleted count. */
export function clearExpiredTokenVerdicts(nowIso: string = new Date().toISOString()): number {
  const db = openDb();
  const r = db.prepare(`DELETE FROM token_safety_cache WHERE expires_at <= ?`).run(nowIso);
  return Number(r.changes);
}

/** Iterate every cached row (for `tradekit token list-safety` style
 *  inspection commands). Optional filter by chain. */
export function listCachedTokenVerdicts(filter: { chain?: string } = {}): TokenSafetyCacheRow[] {
  const db = openDb();
  if (filter.chain) {
    return db
      .prepare(`SELECT * FROM token_safety_cache WHERE chain = ? ORDER BY checked_at DESC`)
      .all(filter.chain.toLowerCase()) as unknown as TokenSafetyCacheRow[];
  }
  return db
    .prepare(`SELECT * FROM token_safety_cache ORDER BY checked_at DESC`)
    .all() as unknown as TokenSafetyCacheRow[];
}

// ── backtest runs (v16) ──────────────────────────────────────
//
// Persisted historical-strategy-simulation results. See the v16 migration
// comment above for schema rationale.

// "order" / "schedule" are single-strategy backtests; "playbook" is the
// iter18 multi-strategy backtest where multiple primitives share one
// simulated balance + timeline.
export type BacktestStrategyType = "order" | "schedule" | "playbook";

export interface BacktestRunRow {
  id: number;
  strategy_type: BacktestStrategyType;
  chain: string;
  base_symbol: string;
  quote_symbol: string;
  spec_json: string;
  initial_balance_json: string;
  final_balance_json: string;
  window_start: string;
  window_end: string;
  points: number;
  fires_json: string;
  fire_count: number;
  pnl_usd: number;
  hold_pnl_usd: number;
  notes: string | null;
  created_at: string;
}

export interface InsertBacktestRunArgs {
  strategyType: BacktestStrategyType;
  chain: string;
  baseSymbol: string;
  quoteSymbol: string;
  specJson: string;
  initialBalanceJson: string;
  finalBalanceJson: string;
  windowStart: string;
  windowEnd: string;
  points: number;
  firesJson: string;
  fireCount: number;
  pnlUsd: number;
  holdPnlUsd: number;
  notes?: string | null;
}

export function insertBacktestRun(args: InsertBacktestRunArgs): number {
  const db = openDb();
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO backtest_runs
        (strategy_type, chain, base_symbol, quote_symbol, spec_json,
         initial_balance_json, final_balance_json, window_start, window_end,
         points, fires_json, fire_count, pnl_usd, hold_pnl_usd, notes,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.strategyType,
      args.chain.toLowerCase(),
      args.baseSymbol.toUpperCase(),
      args.quoteSymbol.toUpperCase(),
      args.specJson,
      args.initialBalanceJson,
      args.finalBalanceJson,
      args.windowStart,
      args.windowEnd,
      args.points,
      args.firesJson,
      args.fireCount,
      args.pnlUsd,
      args.holdPnlUsd,
      args.notes ?? null,
      now,
    );
  return Number(r.lastInsertRowid);
}

export function getBacktestRunById(id: number): BacktestRunRow | null {
  const db = openDb();
  const row = db.prepare(`SELECT * FROM backtest_runs WHERE id = ?`).get(id) as
    | BacktestRunRow
    | undefined;
  return row ?? null;
}

export function listBacktestRuns(
  filter: {
    strategyType?: BacktestStrategyType;
    chain?: string;
    limit?: number;
  } = {},
): BacktestRunRow[] {
  const db = openDb();
  const where: string[] = [];
  // `SQLInputValue` from node:sqlite — narrower than `unknown`. The mixed
  // string/number params below all qualify.
  const params: (string | number)[] = [];
  if (filter.strategyType) {
    where.push(`strategy_type = ?`);
    params.push(filter.strategyType);
  }
  if (filter.chain) {
    where.push(`chain = ?`);
    params.push(filter.chain.toLowerCase());
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;
  params.push(limit);
  return db
    .prepare(`SELECT * FROM backtest_runs ${whereSql} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as unknown as BacktestRunRow[];
}

// ── playbooks (v17) ──────────────────────────────────────────
//
// Declarative multi-primitive strategy bundles. See the v17 migration
// comment above for schema rationale.

export type PlaybookStatus = "deploying" | "deployed" | "destroyed" | "failed";

export interface PlaybookRow {
  id: number;
  name: string;
  source_path: string | null;
  source_hash: string;
  spec_json: string;
  status: PlaybookStatus;
  deployed_at: string;
  destroyed_at: string | null;
}

export interface InsertPlaybookArgs {
  name: string;
  sourcePath: string | null;
  sourceHash: string;
  specJson: string;
}

/** Insert a new playbook row in 'deploying' state. Returns the row id so
 *  the caller can stamp `strategy = playbook:<id>` on its primitives.
 *  The deploy helper flips the status to 'deployed' (or removes the row
 *  on rollback). */
export function insertPlaybook(args: InsertPlaybookArgs): number {
  const db = openDb();
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO playbooks
        (name, source_path, source_hash, spec_json, status, deployed_at, destroyed_at)
       VALUES (?, ?, ?, ?, 'deploying', ?, NULL)`,
    )
    .run(args.name, args.sourcePath, args.sourceHash, args.specJson, now);
  return Number(r.lastInsertRowid);
}

/** Flip a playbook's status. Used by the deploy helper to mark
 *  'deployed' on success, 'failed' on a rollback that decided to keep
 *  the row for forensic reasons, and 'destroyed' on tear-down. */
/** Iter29: update a deployed playbook's stored spec + hash + source_path.
 *  Used by the `playbook replace` flow to record the new spec after a
 *  successful atomic replace. Refreshes `deployed_at` to reflect the
 *  most recent (re)deployment moment. Does NOT touch status. */
export function updatePlaybookSpec(args: {
  id: number;
  sourcePath: string | null;
  sourceHash: string;
  specJson: string;
}): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE playbooks SET source_path = ?, source_hash = ?, spec_json = ?, deployed_at = ? WHERE id = ?`,
  ).run(args.sourcePath, args.sourceHash, args.specJson, now, args.id);
}

export function updatePlaybookStatus(id: number, status: PlaybookStatus): void {
  const db = openDb();
  const now = new Date().toISOString();
  if (status === "destroyed") {
    db.prepare(`UPDATE playbooks SET status = ?, destroyed_at = ? WHERE id = ?`).run(status, now, id);
  } else {
    db.prepare(`UPDATE playbooks SET status = ? WHERE id = ?`).run(status, id);
  }
}

/** Delete a playbook row. Used by the rollback path when the deploy
 *  helper decides to leave the system in pre-deploy state (no forensic
 *  evidence of the failed attempt). Distinct from
 *  `updatePlaybookStatus(id, 'failed')` which preserves the row. */
export function deletePlaybook(id: number): void {
  const db = openDb();
  db.prepare(`DELETE FROM playbooks WHERE id = ?`).run(id);
}

export function getPlaybookById(id: number): PlaybookRow | null {
  const db = openDb();
  const row = db.prepare(`SELECT * FROM playbooks WHERE id = ?`).get(id) as PlaybookRow | undefined;
  return row ?? null;
}

/** Find a playbook by name AMONG NON-DESTROYED rows. Used by the deploy
 *  helper for idempotency: same name + same hash = no-op; same name +
 *  different hash = require destroy first. Returns null when no active
 *  playbook with that name exists (a previously destroyed one is fine
 *  to redeploy). */
export function findActivePlaybookByName(name: string): PlaybookRow | null {
  const db = openDb();
  const row = db
    .prepare(`SELECT * FROM playbooks WHERE name = ? AND status != 'destroyed' ORDER BY id DESC LIMIT 1`)
    .get(name) as PlaybookRow | undefined;
  return row ?? null;
}

export interface ListPlaybooksFilter {
  status?: PlaybookStatus | "all";
  limit?: number;
}

export function listPlaybooks(filter: ListPlaybooksFilter = {}): PlaybookRow[] {
  const db = openDb();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status && filter.status !== "all") {
    where.push(`status = ?`);
    params.push(filter.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;
  params.push(limit);
  return db
    .prepare(`SELECT * FROM playbooks ${whereSql} ORDER BY id DESC LIMIT ?`)
    .all(...params) as unknown as PlaybookRow[];
}

/** Count playbooks by status (for dashboards / metrics). */
export function playbookCountsByStatus(): Record<PlaybookStatus, number> {
  const db = openDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM playbooks GROUP BY status`)
    .all() as Array<{ status: PlaybookStatus; n: number }>;
  const out: Record<PlaybookStatus, number> = {
    deploying: 0, deployed: 0, destroyed: 0, failed: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ── drawdown state (v19) ─────────────────────────────────────
//
// Persistent peak-tracking for the drawdown circuit breaker. See the
// v19 migration comment for schema rationale.

export interface DrawdownStateRow {
  scope_key: string;
  peak_usd: number;
  peak_at: string;
  tripped_at: string | null;
  last_value_usd: number | null;
  updated_at: string;
}

export function getDrawdownState(scopeKey: string): DrawdownStateRow | null {
  const db = openDb();
  const row = db.prepare(`SELECT * FROM drawdown_state WHERE scope_key = ?`).get(scopeKey) as
    | DrawdownStateRow
    | undefined;
  return row ?? null;
}

/** Insert-or-replace the entire state row. Used by the ratchet path
 *  (new peak observed), the trip path (peak unchanged, mark tripped),
 *  and the manual reset path. Single-statement upsert keeps the trade
 *  hot path cheap. */
export function upsertDrawdownState(args: {
  scopeKey: string;
  peakUsd: number;
  peakAt: string;
  trippedAt: string | null;
  lastValueUsd: number | null;
}): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO drawdown_state (scope_key, peak_usd, peak_at, tripped_at, last_value_usd, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_key) DO UPDATE SET
       peak_usd = excluded.peak_usd,
       peak_at = excluded.peak_at,
       tripped_at = excluded.tripped_at,
       last_value_usd = excluded.last_value_usd,
       updated_at = excluded.updated_at`,
  ).run(args.scopeKey, args.peakUsd, args.peakAt, args.trippedAt, args.lastValueUsd, now);
}

/** Targeted update of just the tripped_at + last_value_usd fields
 *  without disturbing peak. Used when the breaker trips (peak stays
 *  put, only the trip timestamp + last value move) and when it
 *  auto-resumes (clear tripped_at, update last_value). */
export function setDrawdownTripped(args: {
  scopeKey: string;
  trippedAt: string | null;
  lastValueUsd: number;
}): void {
  const db = openDb();
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `UPDATE drawdown_state SET tripped_at = ?, last_value_usd = ?, updated_at = ?
       WHERE scope_key = ?`,
    )
    .run(args.trippedAt, args.lastValueUsd, now, args.scopeKey);
  if (Number(r.changes) === 0) {
    throw new Error(`setDrawdownTripped: no row for scope_key=${args.scopeKey}`);
  }
}

/** Reset all state for a scope. Used by `safety reset-drawdown` —
 *  clears the tripped flag AND re-anchors peak to the supplied value
 *  (or to lastValueUsd when not supplied; falls back to peak when
 *  neither). Returns the new state. */
export function resetDrawdownState(args: {
  scopeKey: string;
  newPeakUsd?: number;
}): DrawdownStateRow | null {
  const existing = getDrawdownState(args.scopeKey);
  if (!existing) return null;
  const newPeak = args.newPeakUsd ?? existing.last_value_usd ?? existing.peak_usd;
  const now = new Date().toISOString();
  upsertDrawdownState({
    scopeKey: args.scopeKey,
    peakUsd: newPeak,
    peakAt: now,
    trippedAt: null,
    lastValueUsd: existing.last_value_usd,
  });
  return getDrawdownState(args.scopeKey);
}

export function listDrawdownStates(): DrawdownStateRow[] {
  const db = openDb();
  return db
    .prepare(`SELECT * FROM drawdown_state ORDER BY updated_at DESC`)
    .all() as unknown as DrawdownStateRow[];
}

// ── order check log (v21) ────────────────────────────────────
//
// Persistent forensic journal for `tradekit order replay`. See the
// v21 migration comment for schema rationale.

export type OrderCheckDecision =
  | "activation_pending"
  | "tracking_started"
  | "hwm_advanced"
  | "near_threshold"
  | "triggered_fired"
  | "triggered_skipped"
  | "error"
  // Iter34: operator mutated the order in-place. The notes field
  // carries the JSON-encoded diff (old → new per field). HWM /
  // attempts / journal continuity stay intact across edits, so
  // `order replay` shows the edit alongside the trigger timeline.
  | "edited_by_operator";

export interface OrderCheckLogRow {
  id: number;
  order_id: number;
  checked_at: string;
  price_usd: number | null;
  water_mark_usd: number | null;
  threshold_usd: number | null;
  decision: OrderCheckDecision;
  notes: string | null;
}

export interface InsertOrderCheckEntryArgs {
  orderId: number;
  checkedAt: string;
  priceUsd: number | null;
  waterMarkUsd: number | null;
  thresholdUsd: number | null;
  decision: OrderCheckDecision;
  notes?: string | null;
}

export function insertOrderCheckEntry(args: InsertOrderCheckEntryArgs): number {
  const db = openDb();
  const r = db
    .prepare(
      `INSERT INTO order_check_log
        (order_id, checked_at, price_usd, water_mark_usd, threshold_usd, decision, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.orderId,
      args.checkedAt,
      args.priceUsd,
      args.waterMarkUsd,
      args.thresholdUsd,
      args.decision,
      args.notes ?? null,
    );
  return Number(r.lastInsertRowid);
}

/** Return all journal entries for an order, oldest first. The replay
 *  view renders chronologically; this is the only consumer. */
export function replayOrderEntries(orderId: number, limit?: number): OrderCheckLogRow[] {
  const db = openDb();
  const limitClause = limit ? ` LIMIT ?` : "";
  const params: (string | number)[] = [orderId];
  if (limit) params.push(limit);
  return db
    .prepare(
      `SELECT * FROM order_check_log WHERE order_id = ? ORDER BY checked_at ASC${limitClause}`,
    )
    .all(...params) as unknown as OrderCheckLogRow[];
}

/** Get the most-recently logged entry for an order. Used by the
 *  sampling predicate to decide whether the current state differs
 *  from the last logged state. */
export function getLatestOrderCheckEntry(orderId: number): OrderCheckLogRow | null {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT * FROM order_check_log WHERE order_id = ? ORDER BY checked_at DESC LIMIT 1`,
    )
    .get(orderId) as OrderCheckLogRow | undefined;
  return row ?? null;
}

/** Prune entries older than the supplied ISO timestamp. Returns count
 *  deleted. Operator-driven via `tradekit doctor prune-journal` or
 *  invoked from the engine's retention policy. */
export function pruneOrderCheckLog(beforeIso: string): number {
  const db = openDb();
  const r = db.prepare(`DELETE FROM order_check_log WHERE checked_at < ?`).run(beforeIso);
  return Number(r.changes);
}

/** Count entries for a single order — used by the replay renderer to
 *  show "showing X of Y events" when --limit truncates. */
export function countOrderCheckEntries(orderId: number): number {
  const db = openDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM order_check_log WHERE order_id = ?`)
    .get(orderId) as { n: number };
  return row.n;
}

// ── backtest comparisons (v20) ───────────────────────────────
//
// Persisted multi-scenario backtest runs. See the v20 migration
// comment for schema rationale.

export interface BacktestComparisonRow {
  id: number;
  name: string;
  scenarios_json: string;
  results_json: string;
  run_ids: string;
  base_symbol: string;
  quote_symbol: string;
  chain: string;
  window_start: string;
  window_end: string;
  winner_idx: number | null;
  created_at: string;
}

export interface InsertBacktestComparisonArgs {
  name: string;
  scenariosJson: string;
  resultsJson: string;
  runIds: number[];
  baseSymbol: string;
  quoteSymbol: string;
  chain: string;
  windowStart: string;
  windowEnd: string;
  winnerIdx: number | null;
}

export function insertBacktestComparison(args: InsertBacktestComparisonArgs): number {
  const db = openDb();
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO backtest_comparisons
        (name, scenarios_json, results_json, run_ids, base_symbol, quote_symbol,
         chain, window_start, window_end, winner_idx, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.name,
      args.scenariosJson,
      args.resultsJson,
      args.runIds.join(","),
      args.baseSymbol.toUpperCase(),
      args.quoteSymbol.toUpperCase(),
      args.chain.toLowerCase(),
      args.windowStart,
      args.windowEnd,
      args.winnerIdx,
      now,
    );
  return Number(r.lastInsertRowid);
}

export function getBacktestComparisonById(id: number): BacktestComparisonRow | null {
  const db = openDb();
  const row = db
    .prepare(`SELECT * FROM backtest_comparisons WHERE id = ?`)
    .get(id) as BacktestComparisonRow | undefined;
  return row ?? null;
}

export function listBacktestComparisons(
  filter: { chain?: string; limit?: number } = {},
): BacktestComparisonRow[] {
  const db = openDb();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.chain) {
    where.push(`chain = ?`);
    params.push(filter.chain.toLowerCase());
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit ?? 50;
  params.push(limit);
  return db
    .prepare(`SELECT * FROM backtest_comparisons ${whereSql} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as unknown as BacktestComparisonRow[];
}

// ── engine lock (v23) ────────────────────────────────────────
//
// Single-row table; the persistent state behind `tradekit engine
// lock` / `engine unlock`. Engines + trade.ts query the row at the
// start of every tick / trade call.

export interface EngineLockRow {
  id: 1;
  active: number; // 0 | 1 (SQLite has no boolean)
  reason: string | null;
  locked_at: string | null;
  locked_by: string | null;
  updated_at: string;
}

/** Read the engine lock state. Always returns a row — the v23
 *  migration seeds id=1 active=0. */
export function getEngineLock(): EngineLockRow {
  const db = openDb();
  const row = db.prepare(`SELECT * FROM engine_lock WHERE id = 1`).get() as EngineLockRow | undefined;
  if (!row) {
    // Defensive seed in case the migration's INSERT OR IGNORE ran
    // against a DB where the row was manually deleted. UPSERT here
    // matches the migration's pre-seed shape so subsequent reads
    // succeed.
    const now = new Date().toISOString();
    db.prepare(`INSERT OR REPLACE INTO engine_lock (id, active, updated_at) VALUES (1, 0, ?)`).run(now);
    return {
      id: 1, active: 0, reason: null, locked_at: null, locked_by: null, updated_at: now,
    };
  }
  return row;
}

/** Activate the lock. Idempotent — re-locking an already-locked
 *  engine just updates the timestamp + (optionally) the reason.
 *  Returns the new row. */
export function setEngineLock(args: { reason: string | null; lockedBy: string }): EngineLockRow {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE engine_lock SET active = 1, reason = ?, locked_at = ?, locked_by = ?, updated_at = ?
     WHERE id = 1`,
  ).run(args.reason, now, args.lockedBy, now);
  return getEngineLock();
}

/** Clear the lock. Idempotent — unlocking an already-unlocked engine
 *  is a no-op (returns the current row). */
export function clearEngineLock(): EngineLockRow {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE engine_lock SET active = 0, reason = NULL, locked_at = NULL, locked_by = NULL, updated_at = ?
     WHERE id = 1`,
  ).run(now);
  return getEngineLock();
}

// ── engine events (v26, iter39) ──────────────────────────────
//
// Persistent log of engine lifecycle + worker + config transitions.
// Side-car to the iter28+ notification system: tryNotify pushes the
// event to Slack/Discord/webhook, this row preserves the same event
// in SQLite so `tradekit engine events` + the iter36 timeline have
// a durable source even after a process restart.
//
// fields_json holds the event-type-specific payload (the same fields
// the notification carried). The dedup_key matches the notification
// dedupKey when one exists, so external tools cross-referencing
// notify history + this table can pair rows.

export interface EngineEventRow {
  id: number;
  timestamp: string;
  event_type: string;
  severity: "info" | "warn" | "critical";
  pid: number | null;
  worker_name: string | null;
  fields_json: string | null;
  dedup_key: string | null;
}

export interface InsertEngineEventArgs {
  timestamp: string;
  eventType: string;
  severity: "info" | "warn" | "critical";
  pid?: number | null;
  workerName?: string | null;
  fields?: Record<string, unknown> | null;
  dedupKey?: string | null;
}

export function insertEngineEvent(args: InsertEngineEventArgs): number {
  const db = openDb();
  const r = db
    .prepare(
      `INSERT INTO engine_events
         (timestamp, event_type, severity, pid, worker_name, fields_json, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.timestamp,
      args.eventType,
      args.severity,
      args.pid ?? null,
      args.workerName ?? null,
      args.fields ? JSON.stringify(args.fields) : null,
      args.dedupKey ?? null,
    );
  return Number(r.lastInsertRowid);
}

export interface ListEngineEventsFilter {
  /** Lower bound on `timestamp` (inclusive). */
  sinceIso?: string;
  /** Upper bound on `timestamp` (inclusive). */
  untilIso?: string;
  /** Exact-match event_type filter (e.g. "worker.degraded"). */
  eventType?: string;
  /** Prefix match — passing "worker." catches degraded + recovered. */
  eventTypePrefix?: string;
  /** Severity floor. */
  minSeverity?: "info" | "warn" | "critical";
  /** Restrict to events for a specific worker. */
  workerName?: string;
  /** Pid filter — useful for "events from THIS engine run only". */
  pid?: number;
  /** Caps the result set. Default 200, max 10_000. */
  limit?: number;
}

export function listEngineEvents(filter: ListEngineEventsFilter = {}): EngineEventRow[] {
  const db = openDb();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.sinceIso) {
    where.push("timestamp >= ?");
    args.push(filter.sinceIso);
  }
  if (filter.untilIso) {
    where.push("timestamp <= ?");
    args.push(filter.untilIso);
  }
  if (filter.eventType) {
    where.push("event_type = ?");
    args.push(filter.eventType);
  }
  if (filter.eventTypePrefix) {
    where.push("event_type LIKE ?");
    args.push(`${filter.eventTypePrefix}%`);
  }
  if (filter.minSeverity) {
    const rank: Record<string, number> = { info: 0, warn: 1, critical: 2 };
    const minRank = rank[filter.minSeverity] ?? 0;
    if (minRank === 1) {
      where.push("severity IN ('warn', 'critical')");
    } else if (minRank === 2) {
      where.push("severity = 'critical'");
    }
    // info: no filter — all rows pass
  }
  if (filter.workerName) {
    where.push("worker_name = ?");
    args.push(filter.workerName);
  }
  if (filter.pid != null) {
    where.push("pid = ?");
    args.push(filter.pid);
  }
  const limit = Math.max(1, Math.min(filter.limit ?? 200, 10_000));
  args.push(limit);
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM engine_events ${whereClause} ORDER BY timestamp DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...(args as never[])) as unknown as EngineEventRow[];
}

/** Operator-driven retention: delete events older than the cutoff.
 *  Default no-op when no cutoff passed. Returns the number of rows
 *  removed. */
export function pruneEngineEvents(beforeIso: string): number {
  const db = openDb();
  const r = db.prepare(`DELETE FROM engine_events WHERE timestamp < ?`).run(beforeIso);
  return Number(r.changes ?? 0);
}

// ── iter40: DB retention helpers ─────────────────────────────
//
// Per-table prune by timestamp. Each helper is conservative:
// only rows past the cutoff get deleted, and rows that might be
// referenced by live workflow (active orders / schedules /
// rebalances; non-terminal trades) are deliberately untouched.
//
// The dbLifecycle.ts module composes these via a typed retention
// policy. Operators can also invoke them directly for one-shot
// cleanups.

/** Prune audit_log rows older than the cutoff. audit_log is the
 *  highest-volume table (every CLI/MCP call writes one); operators
 *  with strict 90/180-day retention requirements get measurable
 *  disk savings. */
export function pruneOldAuditBefore(beforeIso: string): number {
  const db = openDb();
  const r = db.prepare(`DELETE FROM audit_log WHERE timestamp < ?`).run(beforeIso);
  return Number(r.changes ?? 0);
}

/** Prune paper_trades older than the cutoff. Paper data is
 *  ephemeral by design — operators iterating on strategies churn
 *  through paper trades. */
export function pruneOldPaperTradesBefore(beforeIso: string): number {
  const db = openDb();
  const r = db.prepare(`DELETE FROM paper_trades WHERE timestamp < ?`).run(beforeIso);
  return Number(r.changes ?? 0);
}

/** Prune TERMINAL trade rows (status in failed/reverted) older
 *  than the cutoff. Successful trades stay — most operators want
 *  them for tax records / PnL history. Operators wanting to prune
 *  successes too can do so via direct SQL. */
export function pruneTerminalTradesBefore(beforeIso: string): number {
  const db = openDb();
  const r = db
    .prepare(
      `DELETE FROM trades
         WHERE timestamp < ?
           AND status IN ('failed', 'reverted')`,
    )
    .run(beforeIso);
  return Number(r.changes ?? 0);
}

/** Aggregate DB file + per-table observability. Used by the iter40
 *  `tradekit db stats` CLI + the db_maintenance worker. */
export interface DbFileStats {
  /** Absolute path to the main SQLite file. */
  path: string;
  /** Size in bytes of the main DB file. 0 when the file doesn't exist
   *  yet (engine has never run). */
  mainSizeBytes: number;
  /** WAL file size in bytes (0 when WAL is checkpointed / absent). */
  walSizeBytes: number;
  /** Shared-memory file size in bytes. */
  shmSizeBytes: number;
  /** Total physical footprint = main + WAL + SHM. */
  totalSizeBytes: number;
  /** Per-table row counts. Includes every interesting table; misses
   *  show 0 rather than absent so the consumer can detect "table
   *  exists but is empty" vs "table missing entirely" externally. */
  rowCounts: Record<string, number>;
}

/** Read disk + row counts. Cheap — single COUNT(*) per table +
 *  stat() on three files. Safe to call from any context. */
export function getDbFileStats(): DbFileStats {
  const fileSize = (p: string): number => {
    try {
      return existsSync(p) ? Number(statSync(p).size) : 0;
    } catch {
      return 0;
    }
  };
  const mainSizeBytes = fileSize(DB_PATH);
  const walSizeBytes = fileSize(`${DB_PATH}-wal`);
  const shmSizeBytes = fileSize(`${DB_PATH}-shm`);

  const db = openDb();
  const tables = [
    "trades",
    "audit_log",
    "portfolio_snapshots",
    "sync_bookmarks",
    "orders",
    "schedules",
    "rebalance_plans",
    "playbooks",
    "drawdown_state",
    "order_check_log",
    "backtest_runs",
    "backtest_comparisons",
    "engine_lock",
    "paper_trades",
    "paper_balances",
    "strategy_alert_state",
    "engine_events",
  ];
  const rowCounts: Record<string, number> = {};
  for (const t of tables) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n?: number };
      rowCounts[t] = Number(r?.n ?? 0);
    } catch {
      // Table doesn't exist on this DB (pre-migration on a fresh
      // install) — leave it out of the result rather than crashing.
    }
  }
  return {
    path: DB_PATH,
    mainSizeBytes,
    walSizeBytes,
    shmSizeBytes,
    totalSizeBytes: mainSizeBytes + walSizeBytes + shmSizeBytes,
    rowCounts,
  };
}

// ── paper trading (v24) ──────────────────────────────────────
//
// Virtual-book persistence behind `--paper` orders / schedules. The
// engine routes the FIRE step through paperTrade.executePaperTrade,
// which calls these helpers to (a) credit / debit virtual balances
// and (b) append a row to the paper_trades journal.
//
// Balances are keyed by (account, chain, token). Amounts are stored
// as decimal strings — paperTrade.ts handles BigInt math at the
// application layer so we never lose precision through Number.

export interface PaperTradeRow {
  id: number;
  timestamp: string;
  /** "order" | "schedule" | "manual" — identifies the spawning primitive. */
  source_type: string;
  source_id: number | null;
  chain: string;
  account: string;
  /** "buy" | "sell" — direction relative to base_token. */
  direction: string;
  base_token: string;
  base_symbol: string | null;
  base_amount: string;
  quote_token: string;
  quote_symbol: string | null;
  quote_amount: string;
  price: string;
  slippage_bps: number | null;
  strategy: string | null;
  notes: string | null;
}

export interface PaperBalanceRow {
  account: string;
  chain: string;
  token: string;
  balance: string;
  updated_at: string;
}

export interface InsertPaperTradeArgs {
  timestamp: string;
  source_type: "order" | "schedule" | "manual";
  source_id: number | null;
  chain: string;
  account: string;
  direction: "buy" | "sell";
  base_token: string;
  base_symbol: string | null;
  base_amount: string;
  quote_token: string;
  quote_symbol: string | null;
  quote_amount: string;
  price: string;
  slippage_bps: number | null;
  strategy: string | null;
  notes: string | null;
}

/** Append a row to the paper_trades journal. Returns the inserted id. */
export function recordPaperTrade(args: InsertPaperTradeArgs): number {
  const db = openDb();
  const result = db
    .prepare(
      `INSERT INTO paper_trades (
         timestamp, source_type, source_id, chain, account, direction,
         base_token, base_symbol, base_amount,
         quote_token, quote_symbol, quote_amount,
         price, slippage_bps, strategy, notes
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      args.timestamp, args.source_type, args.source_id,
      args.chain.toLowerCase(), args.account, args.direction,
      args.base_token, args.base_symbol, args.base_amount,
      args.quote_token, args.quote_symbol, args.quote_amount,
      args.price, args.slippage_bps, args.strategy, args.notes,
    );
  return Number(result.lastInsertRowid);
}

/** Read a single virtual balance. Returns null when the key hasn't
 *  been seeded — paperTrade.ts treats null as "no balance yet" and
 *  may seed from real holdings on first use depending on caller policy. */
export function getPaperBalance(
  account: string,
  chain: string,
  token: string,
): PaperBalanceRow | null {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT account, chain, token, balance, updated_at
         FROM paper_balances
        WHERE account = ? AND chain = ? AND token = ?`,
    )
    .get(account, chain.toLowerCase(), token) as PaperBalanceRow | undefined;
  return row ?? null;
}

/** Upsert a virtual balance row. Callers pass the *new* balance — this
 *  function does NOT compute deltas. paperTrade.ts owns the BigInt
 *  arithmetic and writes the resulting balance verbatim. */
export function upsertPaperBalance(args: {
  account: string;
  chain: string;
  token: string;
  balance: string;
}): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO paper_balances (account, chain, token, balance, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(account, chain, token) DO UPDATE
       SET balance = excluded.balance,
           updated_at = excluded.updated_at`,
  ).run(args.account, args.chain.toLowerCase(), args.token, args.balance, now);
}

export interface ListPaperTradesFilter {
  account?: string;
  chain?: string;
  strategy?: string;
  sourceType?: "order" | "schedule" | "manual";
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
}

/** Chronological listing of paper trades — newest first by default.
 *  Mirrors the shape of `listTrades` so reporting code can largely
 *  share helpers. */
export function listPaperTrades(filter: ListPaperTradesFilter = {}): PaperTradeRow[] {
  const db = openDb();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  if (filter.chain) {
    where.push("chain = ?");
    args.push(filter.chain.toLowerCase());
  }
  if (filter.strategy) {
    where.push("strategy = ?");
    args.push(filter.strategy);
  }
  if (filter.sourceType) {
    where.push("source_type = ?");
    args.push(filter.sourceType);
  }
  if (filter.sinceIso) {
    where.push("timestamp >= ?");
    args.push(filter.sinceIso);
  }
  if (filter.untilIso) {
    where.push("timestamp <= ?");
    args.push(filter.untilIso);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(filter.limit ?? 200, 5000));
  args.push(limit);
  const sql = `SELECT * FROM paper_trades ${whereClause} ORDER BY timestamp DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...(args as never[])) as unknown as PaperTradeRow[];
}

/** List all virtual balance rows. Optional account / chain filter. */
export function listPaperBalances(filter: { account?: string; chain?: string } = {}): PaperBalanceRow[] {
  const db = openDb();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  if (filter.chain) {
    where.push("chain = ?");
    args.push(filter.chain.toLowerCase());
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM paper_balances ${whereClause} ORDER BY account, chain, token`;
  return db.prepare(sql).all(...(args as never[])) as unknown as PaperBalanceRow[];
}

/** Wipe paper state. Used by `tradekit paper reset` — operator wants a
 *  clean slate without dropping the underlying tables. Both balances
 *  and trade journal are cleared. Returns the number of rows removed
 *  across both tables for reporting. */
export function resetPaperState(filter: { account?: string; chain?: string } = {}): {
  balancesRemoved: number;
  tradesRemoved: number;
} {
  const db = openDb();
  const where: string[] = [];
  const args: string[] = [];
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  if (filter.chain) {
    where.push("chain = ?");
    args.push(filter.chain.toLowerCase());
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const balanceResult = db.prepare(`DELETE FROM paper_balances ${whereClause}`).run(...args);
  const tradeResult = db.prepare(`DELETE FROM paper_trades ${whereClause}`).run(...args);
  return {
    balancesRemoved: Number(balanceResult.changes ?? 0),
    tradesRemoved: Number(tradeResult.changes ?? 0),
  };
}

// ── strategy alert state (v25) ───────────────────────────────
//
// Per-(strategy tag, rule type) state row driving dedup for the
// iter32 alerts watcher. The watcher reconciles current
// evaluations against this state on every tick + emits exactly
// one notification per OK↔active transition.

export interface StrategyAlertStateRow {
  tag: string;
  rule_type: string;
  active: number; // 0 | 1 (SQLite has no boolean)
  first_triggered_at: string | null;
  last_evaluated_at: string;
  last_value_json: string | null;
}

export function getStrategyAlertState(
  tag: string,
  ruleType: string,
): StrategyAlertStateRow | null {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT * FROM strategy_alert_state WHERE tag = ? AND rule_type = ?`,
    )
    .get(tag, ruleType) as StrategyAlertStateRow | undefined;
  return row ?? null;
}

/** List every alert state row matching the filter. Returns
 *  newest-evaluated first so the CLI can render a recent-activity
 *  view without resorting. */
export function listStrategyAlertStates(filter: { tag?: string; active?: boolean } = {}): StrategyAlertStateRow[] {
  const db = openDb();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.tag) {
    where.push("tag = ?");
    args.push(filter.tag);
  }
  if (filter.active != null) {
    where.push("active = ?");
    args.push(filter.active ? 1 : 0);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM strategy_alert_state ${whereClause} ORDER BY last_evaluated_at DESC`;
  return db.prepare(sql).all(...(args as never[])) as unknown as StrategyAlertStateRow[];
}

/** Upsert the state row for a (tag, ruleType) pair. Returns the
 *  freshly-written row so the watcher can audit transitions. */
export function upsertStrategyAlertState(args: {
  tag: string;
  ruleType: string;
  active: boolean;
  firstTriggeredAt: string | null;
  lastEvaluatedAt: string;
  lastValueJson: string | null;
}): StrategyAlertStateRow {
  const db = openDb();
  db.prepare(
    `INSERT INTO strategy_alert_state
       (tag, rule_type, active, first_triggered_at, last_evaluated_at, last_value_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tag, rule_type) DO UPDATE SET
       active = excluded.active,
       first_triggered_at = excluded.first_triggered_at,
       last_evaluated_at = excluded.last_evaluated_at,
       last_value_json = excluded.last_value_json`,
  ).run(
    args.tag,
    args.ruleType,
    args.active ? 1 : 0,
    args.firstTriggeredAt,
    args.lastEvaluatedAt,
    args.lastValueJson,
  );
  return getStrategyAlertState(args.tag, args.ruleType)!;
}

/** Reset alert state — used by the CLI when the operator
 *  acknowledged an alert + wants to re-arm. Returns the number of
 *  rows removed. */
export function resetStrategyAlertState(filter: { tag?: string; ruleType?: string } = {}): number {
  const db = openDb();
  const where: string[] = [];
  const args: string[] = [];
  if (filter.tag) {
    where.push("tag = ?");
    args.push(filter.tag);
  }
  if (filter.ruleType) {
    where.push("rule_type = ?");
    args.push(filter.ruleType);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const r = db.prepare(`DELETE FROM strategy_alert_state ${whereClause}`).run(...args);
  return Number(r.changes ?? 0);
}
