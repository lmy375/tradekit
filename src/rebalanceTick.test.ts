/**
 * runRebalanceTick integration tests — first coverage for the
 * rebalance engine's main loop (due gating → bounds → drift eval →
 * planning → leg execution → run telemetry).
 *
 * Offline harness: the portfolio comes from the injected
 * `fetchPortfolio` (a first-class test seam on RebalanceTickArgs),
 * the wallet boundary is mocked, and `executeTrade` is mocked so leg
 * execution never touches an aggregator or the chain. resolveToken /
 * profile resolution run REAL code against the static base-chain
 * token map.
 *
 * Pinned semantics:
 *   - in-band (drift < threshold) records a "skipped" run and
 *     advances next_run_at — no trades, no wallet load
 *   - partial leg failure reports PARTIAL_FAILURE but still records
 *     the run (executed legs are real fills; the operator must see
 *     them)
 *   - failures do NOT consume max_runs quota (run_count counts
 *     executed rebalances only — regression guard for the
 *     recordRebalanceError fix)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-rebalancetick-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

// ── I/O boundary mocks (must precede module imports) ─────────

vi.mock("./price.js", () => ({
  getCurrentPrice: vi.fn(),
  getCurrentPrices: vi.fn(async () => ({})),
}));

vi.mock("./tokens.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./tokens.js")>();
  return {
    ...orig,
    getToken: vi.fn(async (_pc: unknown, profile: { nativeSymbol: string }, address: string) => {
      const addr = String(address).toLowerCase();
      if (addr === USDC.toLowerCase()) {
        return { address, chainId: 8453, decimals: 6, symbol: "USDC", isNative: false };
      }
      if (orig.isNativeSentinel(address as never)) {
        return { address, chainId: 8453, decimals: 18, symbol: profile.nativeSymbol, isNative: true };
      }
      return { address, chainId: 8453, decimals: 18, symbol: "WETH", isNative: false };
    }),
  };
});

vi.mock("./wallet.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./wallet.js")>();
  return {
    ...orig,
    loadReadOnlyWallet: vi.fn(() => ({
      publicClient: {},
      walletClient: {},
      label: "default",
      account: { address: "0x0000000000000000000000000000000000000001" },
    })),
    loadWallet: vi.fn(),
  };
});

vi.mock("./trade.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./trade.js")>();
  return {
    ...orig,
    executeTrade: vi.fn(),
  };
});

// Token addresses — base-chain USDC (the plan's quote anchor in tests).
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const { runRebalanceTick } = await import("./rebalance.js");
const { openDb, closeDb, insertRebalancePlan, getRebalancePlanById, listPaperTrades } = await import("./db.js");
type InsertRebalancePlanArgs = import("./db.js").InsertRebalancePlanArgs;
type PortfolioSnapshot = import("./positionLimits.js").PortfolioSnapshot;
type PortfolioToken = import("./positionLimits.js").PortfolioToken;
const { loadConfig } = await import("./config.js");
const { lockEngine, unlockEngine } = await import("./engineLock.js");
const { executeTrade } = await import("./trade.js");
const { loadReadOnlyWallet } = await import("./wallet.js");
const { setPaperBalance } = await import("./paperTrade.js");
const { NATIVE_TOKEN } = await import("./tokens.js");
const { getCurrentPrice } = await import("./price.js");

const mockedExecuteTrade = vi.mocked(executeTrade);
const mockedReadOnlyWallet = vi.mocked(loadReadOnlyWallet);
const mockedPrice = vi.mocked(getCurrentPrice);

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
  recordAudit: () => {},
  close: () => {},
} as unknown as import("./logger.js").Logger;

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM rebalance_plans");
  db.exec("DELETE FROM rebalance_check_log");
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM paper_balances");
  vi.clearAllMocks();
  // Spot prices for the paper path: USDC $1, everything else (WETH /
  // native sentinel) $2000. Real-plan tests inject snapshots directly
  // and never hit this.
  mockedPrice.mockImplementation(async (address: string) =>
    String(address).toLowerCase() === USDC.toLowerCase() ? 1 : 2000,
  );
  mockedReadOnlyWallet.mockImplementation(() => ({
    publicClient: {},
    walletClient: {},
    label: "default",
    account: { address: "0x0000000000000000000000000000000000000001" },
  }) as never);
  // Default: every leg succeeds with a synthetic hash.
  mockedExecuteTrade.mockImplementation(async () => ({
    ok: true,
    simulated: false,
    txHash: "0xmocked",
    status: "success",
    baseAmount: "1",
    quoteAmount: "100",
    aggregator: "mock",
  }) as never);
});

// ── seeding helpers ──────────────────────────────────────────

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

function seedPlan(over: Partial<InsertRebalancePlanArgs> = {}): number {
  return insertRebalancePlan({
    name: "core-folio",
    account: "default",
    chain: "base",
    quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // base USDC (lowercased)
    quote_symbol: "USDC",
    targets: [
      { token: "ETH", targetPct: 60 },
      { token: "USDC", targetPct: 40 },
    ],
    drift_threshold_pct: 5,
    min_trade_usd: 10,
    cron_expr: "0 */6 * * *",
    next_run_at: PAST, // due by default
    start_at: null,
    end_at: null,
    max_runs: null,
    slippage_bps: 50,
    auto_slippage: false,
    strategy: "tick-test",
    note: null,
    ...over,
  });
}

function tok(overrides: Partial<PortfolioToken> = {}): PortfolioToken {
  return { chain: "base", symbol: "ETH", address: "NATIVE", usd: 600, ...overrides };
}

function snapshotOf(tokens: PortfolioToken[]): PortfolioSnapshot {
  let total = 0;
  let hasUnpriced = false;
  for (const t of tokens) {
    if (t.usd == null) hasUnpriced = true;
    else total += t.usd;
  }
  return { totalUsd: total, hasUnpriced, tokens };
}

// 80/20 ETH/USDC vs 60/40 target → ETH +20% drift, $200 to move.
const DRIFTED = snapshotOf([
  tok({ symbol: "ETH", address: "NATIVE", usd: 800 }),
  tok({ symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", usd: 200 }),
]);
// Exactly on target — no drift.
const BALANCED = snapshotOf([
  tok({ symbol: "ETH", address: "NATIVE", usd: 600 }),
  tok({ symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", usd: 400 }),
]);

const tick = (over: Partial<Parameters<typeof runRebalanceTick>[0]> = {}) =>
  runRebalanceTick({
    logger: noopLogger,
    fetchPortfolio: async () => DRIFTED,
    ...over,
  });

// ── due gating + bounds ──────────────────────────────────────

describe("runRebalanceTick — due gating + bounds", () => {
  it("ignores plans whose next_run_at is in the future", async () => {
    seedPlan({ next_run_at: FUTURE });
    const report = await tick();
    expect(report.due).toBe(0);
  });

  it("end_at in the past completes the plan without evaluating", async () => {
    const id = seedPlan({ end_at: PAST });
    const report = await tick();
    expect(report.completed).toBe(1);
    expect(getRebalancePlanById(id)?.status).toBe("completed");
    expect(mockedExecuteTrade).not.toHaveBeenCalled();
  });

  it("run_count >= max_runs completes the plan without evaluating", async () => {
    const id = seedPlan({ max_runs: 3 });
    openDb().prepare(`UPDATE rebalance_plans SET run_count = 3 WHERE id = ?`).run(id);
    const report = await tick();
    expect(report.completed).toBe(1);
    expect(getRebalancePlanById(id)?.status).toBe("completed");
  });

  it("an unparseable cron terminates the plan (completed + INVALID_PARAMS)", async () => {
    const id = seedPlan();
    openDb().prepare(`UPDATE rebalance_plans SET cron_expr = 'garbage' WHERE id = ?`).run(id);
    const report = await tick();
    expect(report.completed).toBe(1);
    expect(getRebalancePlanById(id)?.last_error_code).toBe("INVALID_PARAMS");
  });

  it("corrupt targets_json terminates the plan", async () => {
    const id = seedPlan();
    openDb().prepare(`UPDATE rebalance_plans SET targets_json = '{not json' WHERE id = ?`).run(id);
    const report = await tick();
    expect(report.completed).toBe(1);
    expect(getRebalancePlanById(id)?.last_error_message).toBe("corrupt targets_json");
  });
});

// ── drift evaluation ─────────────────────────────────────────

describe("runRebalanceTick — drift evaluation", () => {
  it("in-band drift records a skipped run and advances next_run_at (no trades)", async () => {
    const id = seedPlan();
    const report = await tick({ fetchPortfolio: async () => BALANCED });
    expect(report.skipped).toBe(1);
    expect(report.fires[0].status).toBe("skipped");
    expect(report.fires[0].errorMessage).toContain("within threshold");
    const row = getRebalancePlanById(id)!;
    expect(row.last_run_status).toBe("skipped");
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now());
    expect(mockedExecuteTrade).not.toHaveBeenCalled();
  });

  it("empty portfolio records a skipped run with the empty-portfolio reason", async () => {
    seedPlan();
    const report = await tick({ fetchPortfolio: async () => snapshotOf([]) });
    expect(report.skipped).toBe(1);
    expect(report.fires[0].errorMessage).toContain("Empty portfolio");
    expect(mockedExecuteTrade).not.toHaveBeenCalled();
  });

  it("a TRANSIENT portfolio fetch failure parks the plan on a v32 retry slot", async () => {
    const id = seedPlan({ max_runs: 5 });
    const err = Object.assign(new Error("rpc down"), { code: "RPC_FAILED" });
    const before = Date.now();
    const report = await tick({ fetchPortfolio: async () => { throw err; } });
    // v32: transient → bounded retry, NOT a lost occurrence.
    expect(report.failed).toBe(0);
    expect(report.retried).toBe(1);
    expect(report.fires[0].status).toBe("retry_pending");
    const row = getRebalancePlanById(id)!;
    expect(row.status).toBe("active");
    expect(row.retry_count).toBe(1);
    expect(row.last_run_status).toBe("retry_pending");
    expect(row.last_error_code).toBe("RPC_FAILED");
    // Retry slot ≈ now + 5m (default backoff), well before the 6h cron.
    const delta = Date.parse(row.next_run_at) - before;
    expect(delta).toBeGreaterThan(4 * 60_000);
    expect(delta).toBeLessThan(6 * 60_000);
    // Failures never consume max_runs quota.
    expect(row.run_count).toBe(0);
  });

  it("a TERMINAL fetch failure advances to the natural slot without retrying", async () => {
    const id = seedPlan({ max_runs: 5 });
    const err = Object.assign(new Error("nope"), { code: "INVALID_PARAMS" });
    const report = await tick({ fetchPortfolio: async () => { throw err; } });
    expect(report.failed).toBe(1);
    expect(report.retried).toBe(0);
    const row = getRebalancePlanById(id)!;
    expect(row.retry_count).toBe(0);
    expect(row.last_run_status).toBe("failed");
    // Advanced to the natural cron slot (way past the 5m backoff window).
    expect(Date.parse(row.next_run_at) - Date.now()).toBeGreaterThan(10 * 60_000);
    expect(row.run_count).toBe(0);
  });

  it("retry budget exhaustion falls through to the natural slot + resets the counter", async () => {
    const id = seedPlan();
    openDb().prepare(`UPDATE rebalance_plans SET retry_count = 3 WHERE id = ?`).run(id);
    const err = Object.assign(new Error("rpc still down"), { code: "RPC_FAILED" });
    const report = await tick({ fetchPortfolio: async () => { throw err; } });
    expect(report.failed).toBe(1);
    expect(report.retried).toBe(0);
    const row = getRebalancePlanById(id)!;
    expect(row.retry_count).toBe(0); // reset for the next occurrence
    expect(row.last_run_status).toBe("failed");
    expect(Date.parse(row.next_run_at) - Date.now()).toBeGreaterThan(10 * 60_000);
  });
});

// ── execution ────────────────────────────────────────────────

describe("runRebalanceTick — execution", () => {
  it("executes corrective legs when drift exceeds threshold", async () => {
    const id = seedPlan();
    const report = await tick();
    expect(report.executed).toBe(1);
    const fire = report.fires[0];
    expect(fire.status).toBe("executed");
    expect(fire.maxDriftPct).toBeCloseTo(20, 4); // 80% actual vs 60% target
    expect(fire.executed.length).toBeGreaterThan(0);
    expect(fire.executed.every((l) => l.ok && l.txHash === "0xmocked")).toBe(true);

    // executeTrade got a USD-denominated quoteAmount for the ETH leg ($200 to move).
    const req = mockedExecuteTrade.mock.calls[0][0];
    expect(req.direction).toBe("sell"); // ETH over-weight → sell into quote
    expect(req.base).toBe("ETH");
    expect(parseFloat(req.quoteAmount!)).toBeCloseTo(200, 1);

    const row = getRebalancePlanById(id)!;
    expect(row.run_count).toBe(1);
    expect(row.last_run_status).toBe("executed");
    expect(row.last_run_max_drift_pct).toBeCloseTo(20, 4);
    expect(row.last_run_executed_count).toBe(1);
  });

  it("dry-run advances next_run_at without firing", async () => {
    const id = seedPlan();
    const report = await tick({ dryRun: true });
    expect(report.skipped).toBe(1);
    expect(report.fires[0].errorCode).toBe("DRY_RUN");
    expect(report.fires[0].executed[0]?.description).toContain("[DRY-RUN]");
    expect(mockedExecuteTrade).not.toHaveBeenCalled();
    expect(Date.parse(getRebalancePlanById(id)!.next_run_at)).toBeGreaterThan(Date.now());
  });

  it("a leg failure reports PARTIAL_FAILURE but still records the run", async () => {
    const id = seedPlan({
      targets: [
        { token: "ETH", targetPct: 40 },
        { token: "DAI", targetPct: 40 },
        { token: "USDC", targetPct: 20 },
      ],
    });
    // ETH heavily over, DAI heavily under → 2 legs (sell ETH, buy DAI).
    const threeWay = snapshotOf([
      tok({ symbol: "ETH", address: "NATIVE", usd: 800 }),
      tok({ symbol: "DAI", address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", usd: 0 }),
      tok({ symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", usd: 200 }),
    ]);
    mockedExecuteTrade
      .mockImplementationOnce(async () => ({
        ok: true, simulated: false, txHash: "0xleg1", status: "success",
        baseAmount: "1", quoteAmount: "400", aggregator: "mock",
      }) as never)
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("no route"), { code: "INSUFFICIENT_LIQUIDITY" });
      });
    const report = await tick({ fetchPortfolio: async () => threeWay });
    expect(report.failed).toBe(1);
    const fire = report.fires[0];
    expect(fire.status).toBe("failed");
    expect(fire.errorCode).toBe("PARTIAL_FAILURE");
    expect(fire.executed.filter((l) => l.ok)).toHaveLength(1);
    expect(fire.executed.filter((l) => !l.ok)).toHaveLength(1);
    // The run is still recorded — one leg DID fill on-chain.
    const row = getRebalancePlanById(id)!;
    expect(row.run_count).toBe(1);
    expect(row.last_run_executed_count).toBe(1);
  });

  it("a fire that reaches max_runs flips the plan to completed", async () => {
    const id = seedPlan({ max_runs: 1 });
    await tick();
    const row = getRebalancePlanById(id)!;
    expect(row.run_count).toBe(1);
    expect(row.status).toBe("completed");
  });

  it("wallet load failure records the error and advances next_run_at", async () => {
    const id = seedPlan();
    const err = Object.assign(new Error("keystore gone"), { code: "WALLET_NOT_FOUND" });
    mockedReadOnlyWallet.mockImplementation(() => { throw err; });
    const report = await tick();
    expect(report.failed).toBe(1);
    const row = getRebalancePlanById(id)!;
    expect(row.status).toBe("active");
    expect(row.last_error_code).toBe("WALLET_NOT_FOUND");
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now());
  });
});

// ── paper mode (v27) ─────────────────────────────────────────

describe("runRebalanceTick — paper mode", () => {
  function seedPaperBook(args: { eth: string; usdc: string }): void {
    setPaperBalance({ account: "default", chain: "base", token: NATIVE_TOKEN, decimals: 18, amount: args.eth });
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: args.usdc });
  }

  it("evaluates drift against the VIRTUAL book and fires legs into it (no real trades)", async () => {
    // Virtual book: 0.4 ETH (×$2000 = $800) + 200 USDC → ETH at 80%
    // vs 60% target → $200 over-weight, drift 20% ≥ threshold 5%.
    seedPaperBook({ eth: "0.4", usdc: "200" });
    const id = seedPlan({ paper: true });

    // NO injected fetcher — the default paper fetcher must build the
    // snapshot from paper_balances itself.
    const report = await runRebalanceTick({ logger: noopLogger });
    expect(report.executed).toBe(1);
    const fire = report.fires[0];
    expect(fire.status).toBe("executed");
    expect(fire.maxDriftPct).toBeCloseTo(20, 1);
    expect(fire.executed).toHaveLength(1);
    expect(fire.executed[0].txHash).toMatch(/^paper:/); // virtual fill, not on-chain

    // The real trade path must never run for a paper plan.
    expect(mockedExecuteTrade).not.toHaveBeenCalled();

    // The fill landed in the paper journal, attributed to this plan.
    const fills = listPaperTrades({});
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ source_type: "rebalance", source_id: id, direction: "sell" });

    const row = getRebalancePlanById(id)!;
    expect(row.run_count).toBe(1);
    expect(row.last_run_status).toBe("executed");
  });

  it("CONVERGES: after the corrective fire, the next tick is in-band", async () => {
    seedPaperBook({ eth: "0.4", usdc: "200" });
    const id = seedPlan({ paper: true });

    // Tick 1: fires the $200 ETH→USDC correction against the book.
    const r1 = await runRebalanceTick({ logger: noopLogger });
    expect(r1.executed).toBe(1);

    // Re-arm next_run_at (tick 1 advanced it to the next cron slot).
    openDb().prepare(`UPDATE rebalance_plans SET next_run_at = ? WHERE id = ?`).run(PAST, id);

    // Tick 2: the virtual book moved (≈0.30 ETH / ≈400 USDC ≈ 60/40),
    // so drift is now within the 5% threshold → in-band skip. This is
    // the feedback loop paper mode exists to validate — a paper plan
    // evaluated against the REAL portfolio would re-fire the same
    // correction forever.
    const r2 = await runRebalanceTick({ logger: noopLogger });
    expect(r2.executed).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.fires[0].errorMessage).toContain("within threshold");
    expect(r2.fires[0].maxDriftPct!).toBeLessThan(5);
    // Still exactly one paper fill — no duplicate correction.
    expect(listPaperTrades({})).toHaveLength(1);
  });

  it("an empty virtual book records the empty-portfolio skip", async () => {
    const id = seedPlan({ paper: true });
    const report = await runRebalanceTick({ logger: noopLogger });
    expect(report.skipped).toBe(1);
    expect(report.fires[0].errorMessage).toContain("Empty portfolio");
    expect(getRebalancePlanById(id)?.last_run_status).toBe("skipped");
  });

  it("a paper leg failure (insufficient virtual balance) reports PARTIAL_FAILURE without touching real trades", async () => {
    // Book values the portfolio (ETH 80%) but we then drain the ETH row
    // to a sliver so the SELL leg's debit overdraws → PAPER_INSUFFICIENT_BALANCE.
    seedPaperBook({ eth: "0.4", usdc: "200" });
    const id = seedPlan({ paper: true });
    // Inject a paper fetcher pinned to the drifted view, then shrink the
    // actual book under it.
    const fetchPaperPortfolio = async () => DRIFTED;
    setPaperBalance({ account: "default", chain: "base", token: NATIVE_TOKEN, decimals: 18, amount: "0.01" });
    const report = await runRebalanceTick({ logger: noopLogger, fetchPaperPortfolio });
    expect(report.failed).toBe(1);
    expect(report.fires[0].errorCode).toBe("PARTIAL_FAILURE");
    expect(report.fires[0].executed[0].ok).toBe(false);
    expect(report.fires[0].executed[0].error).toContain("Virtual");
    expect(mockedExecuteTrade).not.toHaveBeenCalled();
    expect(getRebalancePlanById(id)?.run_count).toBe(1); // run recorded (attempted execution)
  });
});

// ── engine lock ──────────────────────────────────────────────

describe("runRebalanceTick — engine lock", () => {
  it("skips every due plan with ENGINE_LOCKED and severity=warn (no portfolio fetch)", async () => {
    const config = loadConfig();
    await lockEngine({ reason: "incident", lockedBy: "test", config, logger: noopLogger });
    try {
      seedPlan();
      seedPlan({ name: "second" });
      let fetched = 0;
      const report = await tick({ fetchPortfolio: async () => { fetched += 1; return DRIFTED; } });
      expect(report.due).toBe(2);
      expect(report.skipped).toBe(2);
      expect(report.severity).toBe("warn");
      expect(report.fires.every((f) => f.errorCode === "ENGINE_LOCKED")).toBe(true);
      expect(fetched).toBe(0); // lock short-circuits BEFORE the expensive fetch
      expect(mockedExecuteTrade).not.toHaveBeenCalled();
    } finally {
      await unlockEngine({ unlockedBy: "test", config, logger: noopLogger });
    }
  });
});

// ── v29: decision journal ────────────────────────────────────

describe("runRebalanceTick — decision journal (v29)", () => {
  function seedPaperBook2(args: { eth: string; usdc: string }): void {
    setPaperBalance({ account: "default", chain: "base", token: NATIVE_TOKEN, decimals: 18, amount: args.eth });
    setPaperBalance({ account: "default", chain: "base", token: USDC, decimals: 6, amount: args.usdc });
  }

  async function withJournal<T>(fn: () => Promise<T>): Promise<T> {
    const { loadConfig, saveConfig } = await import("./config.js");
    const cfg = loadConfig();
    saveConfig({ ...cfg, engine: { ...cfg.engine, rebalanceJournal: { enabled: true } } } as never);
    try {
      return await fn();
    } finally {
      saveConfig(cfg);
    }
  }

  it("journal is OFF by default — evaluations write no rows", async () => {
    seedPaperBook2({ eth: "0.4", usdc: "200" });
    seedPlan({ paper: true });
    await runRebalanceTick({ logger: noopLogger });
    const n = (openDb().prepare(`SELECT COUNT(*) AS n FROM rebalance_check_log`).get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("a fire journals 'fired' with drift, threshold, and leg counts", async () => {
    await withJournal(async () => {
      seedPaperBook2({ eth: "0.4", usdc: "200" }); // 80/20 vs 60/40 → 20pt drift
      const id = seedPlan({ paper: true });
      await runRebalanceTick({ logger: noopLogger });
      const { replayRebalanceEntries } = await import("./db.js");
      const entries = replayRebalanceEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].decision).toBe("fired");
      expect(entries[0].max_drift_pct).toBeCloseTo(20, 1);
      expect(entries[0].threshold_pct).toBe(5);
      expect(entries[0].executed_count).toBe(1);
    });
  });

  it("in-band evaluations journal the DRIFT HISTORY (the headline feature)", async () => {
    await withJournal(async () => {
      // Book exactly at 60/40 → in band; drift recorded anyway.
      seedPaperBook2({ eth: "0.3", usdc: "400" }); // 0.3×2000=600 / 400 → 60/40
      const id = seedPlan({ paper: true });
      const r = await runRebalanceTick({ logger: noopLogger });
      expect(r.skipped).toBe(1);
      const { replayRebalanceEntries } = await import("./db.js");
      const entries = replayRebalanceEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].decision).toBe("in_band");
      expect(entries[0].max_drift_pct).toBeLessThan(5);
      expect(entries[0].threshold_pct).toBe(5);
    });
  });

  it("paper leg failure journals partial_failure with the leg counts", async () => {
    await withJournal(async () => {
      // Drifted book but almost no ETH to actually sell → the leg
      // fails with PAPER_INSUFFICIENT_BALANCE → PARTIAL_FAILURE.
      seedPaperBook2({ eth: "0.01", usdc: "200" });
      const id = seedPlan({ paper: true });
      await runRebalanceTick({
        logger: noopLogger,
        fetchPaperPortfolio: async () => ({
          totalUsd: 1000,
          hasUnpriced: false,
          tokens: [
            { chain: "base", symbol: "ETH", address: "NATIVE", usd: 800 },
            { chain: "base", symbol: "USDC", address: USDC, usd: 200 },
          ],
        }),
      });
      const { replayRebalanceEntries } = await import("./db.js");
      const entries = replayRebalanceEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0].decision).toBe("partial_failure");
      expect(entries[0].error_code).toBe("PARTIAL_FAILURE");
      expect(entries[0].executed_count).toBe(0);
    });
  });
});

// ── v33: crash-window pending-legs guard ─────────────────────

describe("runRebalanceTick — v33 pending-legs guard", () => {
  const USDC2 = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const WETH2 = "0x4200000000000000000000000000000000000006";

  async function seedLegTrade(planId: number, status: "pending" | "success", agoMs = 0) {
    const { insertTrade } = await import("./db.js");
    insertTrade({
      timestamp: new Date(Date.now() - agoMs).toISOString(),
      chain: "base", account: "default", direction: "buy",
      base_token: WETH2, base_symbol: "WETH", base_amount: "0.1",
      quote_token: USDC2, quote_symbol: "USDC", quote_amount: "200",
      price: "2000",
      tx_hash: `0xleg${status}`,
      status,
      gas_used: null, gas_price_wei: null, gas_cost_native: null,
      aggregator: "kyberswap", fee_tier: null,
      notes: `[rebalance #${planId}]`,
      strategy: null,
      realized_slippage_bps: null,
    });
  }

  it("unconfirmed legs from an interrupted run defer the evaluation (no quota, no failure)", async () => {
    const id = seedPlan({ paper: false } as never);
    await seedLegTrade(id, "pending");
    let fetcherCalls = 0;
    const report = await tick({ fetchPortfolio: async () => { fetcherCalls += 1; throw new Error("unreachable"); } });
    expect(report.skipped).toBe(1);
    expect(report.failed).toBe(0);
    expect(fetcherCalls).toBe(0); // deferred BEFORE the snapshot fetch
    const fire = report.fires[0];
    expect(fire.status).toBe("skipped");
    expect(fire.errorCode).toBe("PENDING_LEGS");
    const row = getRebalancePlanById(id)!;
    expect(row.run_count).toBe(0); // no quota consumed
    expect(row.last_run_status).toBe("deferred");
    expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.now()); // advanced
  });

  it("CONFIRMED legs don't defer — drift is recomputed from the post-leg portfolio", async () => {
    const id = seedPlan({ paper: false } as never);
    await seedLegTrade(id, "success");
    const err = Object.assign(new Error("fetch reached"), { code: "INVALID_PARAMS" });
    let fetcherCalls = 0;
    const report = await tick({ fetchPortfolio: async () => { fetcherCalls += 1; throw err; } });
    // The guard let the evaluation proceed (it then failed at our stub fetcher).
    expect(fetcherCalls).toBe(1);
    expect(report.failed).toBe(1);
    void id;
  });

});
