// Tests for errors.ts — the structured error code system that every tool uses.
// These pin down the wire shape (toJSON), code mapping (toToolError), and
// error-class invariants. They're cheap to run and catch real production-grade bugs
// like silently downgrading a meaningful error to INTERNAL_ERROR.

import { describe, it, expect, afterEach } from "vitest";
import { ToolError, toToolError, classifyReason, httpStatusForCode, wrongPasswordError, rpcFailedChainError, ERROR_PATTERNS, type ErrorCode } from "./errors.js";

describe("ToolError", () => {
  it("carries the structured code, message, details, and nextActions", () => {
    const err = new ToolError("INSUFFICIENT_LIQUIDITY", "no route", {
      details: { tokenIn: "0xabc" },
      nextActions: [{ tool: "buy", params: { slippageBps: 100 }, reason: "try wider slippage" }],
    });
    expect(err.code).toBe("INSUFFICIENT_LIQUIDITY");
    expect(err.message).toBe("no route");
    expect(err.details).toEqual({ tokenIn: "0xabc" });
    expect(err.nextActions?.[0].tool).toBe("buy");
    expect(err instanceof Error).toBe(true);
  });

  it("toJSON yields the agent-readable shape (ok:false + error{code,message})", () => {
    const json = new ToolError("RPC_RATE_LIMITED", "429").toJSON();
    expect(json).toMatchObject({ ok: false, error: { code: "RPC_RATE_LIMITED", message: "429" } });
  });
});

describe("toToolError", () => {
  it("passes through an existing ToolError unchanged", () => {
    const original = new ToolError("WALLET_LOCKED", "bad pw");
    expect(toToolError(original)).toBe(original);
  });

  it("classifies rate-limit messages → RPC_RATE_LIMITED", () => {
    const e = new Error("Server returned 429 rate limit");
    expect(toToolError(e).code).toBe("RPC_RATE_LIMITED");
  });

  it("classifies insufficient-balance messages → INSUFFICIENT_BALANCE", () => {
    expect(toToolError(new Error("insufficient funds for gas")).code).toBe("INSUFFICIENT_BALANCE");
    expect(toToolError(new Error("Insufficient balance for X")).code).toBe("INSUFFICIENT_BALANCE");
  });

  it("classifies user-rejected messages → TX_REVERTED", () => {
    expect(toToolError(new Error("User rejected the request")).code).toBe("TX_REVERTED");
  });

  it("defaults to INTERNAL_ERROR for unknown messages", () => {
    expect(toToolError(new Error("something weird happened")).code).toBe("INTERNAL_ERROR");
  });

  it("honors a custom fallback code", () => {
    const code: ErrorCode = "AGGREGATOR_FAILED";
    expect(toToolError(new Error("kyberswap timeout"), code).code).toBe(code);
  });

  it("wraps non-Error throws as INTERNAL_ERROR", () => {
    expect(toToolError("just a string").code).toBe("INTERNAL_ERROR");
    expect(toToolError({ random: 1 }).code).toBe("INTERNAL_ERROR");
  });

  it("classifies slippage reverts → SLIPPAGE_EXCEEDED with re-quote hint", () => {
    const err = toToolError(new Error("execution reverted: Return amount is not enough"));
    expect(err.code).toBe("SLIPPAGE_EXCEEDED");
    expect(err.nextActions?.[0].tool).toBe("quote");
    // Iter540: pin iter529's paste-ready `tradekit quote --slippage <new-bps>` embed.
    expect(err.nextActions?.[0].reason).toMatch(/`tradekit quote --slippage/);
    expect(toToolError(new Error("INSUFFICIENT_OUTPUT_AMOUNT")).code).toBe("SLIPPAGE_EXCEEDED");
    expect(toToolError(new Error("Price impact too high")).code).toBe("SLIPPAGE_EXCEEDED");
  });

  it("classifies allowance / transferFrom failures → NEEDS_APPROVAL with re-approve hint", () => {
    const err = toToolError(new Error("TransferHelper: TRANSFER_FROM_FAILED"));
    expect(err.code).toBe("NEEDS_APPROVAL");
    expect(err.nextActions?.[0].tool).toBe("approve");
    // Iter540: pin iter530's paste-ready `tradekit approve <token> <spender> --amount`
    // embed. The token/spender stay as <placeholders> since classifyReason has no
    // context — the operator/agent substitutes.
    expect(err.nextActions?.[0].reason).toMatch(/`tradekit approve <token> <spender>/);
    expect(toToolError(new Error("ERC20: transfer amount exceeds allowance")).code).toBe("NEEDS_APPROVAL");
    // OZ v5 uses a custom-error name; the string form sometimes ends up in stack traces.
    expect(toToolError(new Error("execution reverted: ERC20InsufficientAllowance")).code).toBe("NEEDS_APPROVAL");
  });

  it("distinguishes 'exceeds balance' (INSUFFICIENT_BALANCE) from 'exceeds allowance' (NEEDS_APPROVAL)", () => {
    // Before iter58 the NEEDS_APPROVAL pattern matched anything containing "allowance",
    // and `exceeds balance` reverts had no specific classifier and fell through to
    // generic TX_REVERTED — the agent's recovery logic chose re-approve instead of
    // top-up. Pin the routing in both directions so a future ordering change doesn't
    // silently misclassify.
    const balanceErr = toToolError(new Error("ERC20: transfer amount exceeds balance"));
    expect(balanceErr.code).toBe("INSUFFICIENT_BALANCE");
    expect(balanceErr.nextActions?.[0].reason).toMatch(/balance|top up/i);
    // Iter538: pin iter526's paste-ready `tradekit holdings` embed. A regression
    // that reverted the reason to the pre-iter526 bare hint ("Check current balances
    // — reduce trade size...") would still match /balance|top up/i above, slipping
    // through. The explicit command-embed check guards it.
    expect(balanceErr.nextActions?.[0].reason).toMatch(/`tradekit holdings`/);

    expect(toToolError(new Error("BEP20: transfer amount exceeds balance")).code).toBe("INSUFFICIENT_BALANCE");
    expect(toToolError(new Error("execution reverted: ERC20InsufficientBalance")).code).toBe("INSUFFICIENT_BALANCE");
  });

  it("classifies nonce conflicts → TX_REVERTED with wait-and-retry hint", () => {
    const err = toToolError(new Error("nonce too low"));
    expect(err.code).toBe("TX_REVERTED");
    expect(err.nextActions?.[0].reason).toMatch(/nonce/i);
    expect(toToolError(new Error("nonce has already been used")).code).toBe("TX_REVERTED");
    expect(toToolError(new Error("already known transaction")).code).toBe("TX_REVERTED");
  });

  it("classifies replacement-underpriced → TX_REVERTED with bump-gas hint", () => {
    const err = toToolError(new Error("replacement transaction underpriced"));
    expect(err.code).toBe("TX_REVERTED");
    expect(err.nextActions?.[0].reason).toMatch(/gas|tip/i);
    // Iter541: pin iter530's reworded honest hint — tradekit doesn't expose a
    // gas-tip flag; viem re-estimates per call. The reason now mentions
    // `tradekit trades --pending` for inspecting the blocking tx.
    expect(err.nextActions?.[0].reason).toMatch(/`tradekit trades --pending`/);
  });

  it("distinguishes insufficient-funds-for-gas (with hint) from generic insufficient", () => {
    const gasErr = toToolError(new Error("insufficient funds for gas * price + value"));
    expect(gasErr.code).toBe("INSUFFICIENT_BALANCE");
    expect(gasErr.nextActions?.[0].reason).toMatch(/native|gas|reduce/i);
    // Iter493: pin iter492 — tool must name a surface that exists on CLI / MCP / web.
    // Pre-iter492 this was `wallet` (CLI command only).
    expect(gasErr.nextActions?.[0].tool).toBe("holdings");
    // Iter541: pin iter526's paste-ready `tradekit holdings` embed in the
    // gas-funds reason (separate pattern from the generic INSUFFICIENT_BALANCE).
    expect(gasErr.nextActions?.[0].reason).toMatch(/`tradekit holdings`/);
    // Plain "insufficient balance" still classified but without the gas-specific hint
    const balErr = toToolError(new Error("ERC20: insufficient balance"));
    expect(balErr.code).toBe("INSUFFICIENT_BALANCE");
    expect(balErr.nextActions).toBeUndefined();
  });

  it("iter492: nonce-reused hint points at recent_trades (cross-surface tool)", () => {
    // Pre-iter492 this nextAction named `wallet`, which exists only as a CLI command.
    // An MCP / web agent receiving the error couldn't mechanically dispatch.
    const err = toToolError(new Error("nonce too low"));
    expect(err.code).toBe("TX_REVERTED");
    expect(err.nextActions?.[0].tool).toBe("recent_trades");
    expect(err.nextActions?.[0].reason).toMatch(/nonce|pending/i);
    // Iter539: pin iter520's paste-ready CLI command + MCP tool name. The earlier
    // /nonce|pending/i check matches the pre-iter520 short reason too — explicit
    // command-embed check prevents the regression.
    expect(err.nextActions?.[0].reason).toMatch(/`tradekit trades --pending`/);
    expect(err.nextActions?.[0].reason).toMatch(/recent_trades/);
  });

  it("classifies network connectivity failures → RPC_FAILED with doctor hint", () => {
    const err = toToolError(new Error("fetch failed: ECONNREFUSED 127.0.0.1:8545"));
    expect(err.code).toBe("RPC_FAILED");
    expect(err.nextActions?.[0].tool).toBe("doctor");
    // Iter537: pin iter527's paste-ready `tradekit doctor` embed in the reason text.
    // A regression that dropped the command form (back to "run doctor to check…")
    // would slip past the tool-name-only check above.
    expect(err.nextActions?.[0].reason).toMatch(/`tradekit doctor`/);
    expect(toToolError(new Error("ETIMEDOUT")).code).toBe("RPC_FAILED");
    expect(toToolError(new Error("getaddrinfo ENOTFOUND mainnet.example")).code).toBe("RPC_FAILED");
    // iter105: http.ts fetchWithTimeout throws "timeout after Nms" — used to slip
    // through to the fallback code (AGGREGATOR_FAILED in the aggregator context).
    expect(toToolError(new Error("timeout after 8000ms")).code).toBe("RPC_FAILED");
  });

  it("classifies generic execution-reverted → TX_REVERTED (no nextActions)", () => {
    const err = toToolError(new Error("execution reverted"));
    expect(err.code).toBe("TX_REVERTED");
    expect(err.nextActions).toBeUndefined();
  });

  it("rate limit pattern catches '429' alone too", () => {
    expect(toToolError(new Error("HTTP 429")).code).toBe("RPC_RATE_LIMITED");
    expect(toToolError(new Error("too many requests")).code).toBe("RPC_RATE_LIMITED");
  });
});

describe("ZodError → INVALID_PARAMS", () => {
  // We don't import zod here — toToolError detects ZodError by duck-typing
  // {name: "ZodError", issues: [...]}, so a hand-crafted object exercises the path.
  function fakeZod(issues: { path: (string | number)[]; message: string }[]) {
    return Object.assign(new Error("zod"), { name: "ZodError", issues });
  }

  it("recognized via duck-typing (no zod import in errors.ts)", () => {
    const err = toToolError(
      fakeZod([{ path: ["safety", "dailyUsdLimit"], message: "Expected number, received string" }]),
    );
    expect(err.code).toBe("INVALID_PARAMS");
    expect(err.message).toBe("safety.dailyUsdLimit: Expected number, received string");
  });

  it("joins multiple issues into one human line per issue (semicolon-separated)", () => {
    const err = toToolError(
      fakeZod([
        { path: ["safety", "maxSlippageBps"], message: "Expected integer" },
        { path: ["activeChain"], message: "Required" },
      ]),
    );
    expect(err.message).toBe(
      "safety.maxSlippageBps: Expected integer; activeChain: Required",
    );
  });

  it("preserves the raw issues array in details for tooling", () => {
    const issues = [{ path: ["x"], message: "msg" }];
    const err = toToolError(fakeZod(issues));
    expect(err.details).toEqual({ issues });
  });

  it("renders (root) for an issue with empty path", () => {
    const err = toToolError(fakeZod([{ path: [], message: "must be object" }]));
    expect(err.message).toBe("(root): must be object");
  });
});

describe("httpStatusForCode", () => {
  // The frontend branches on these — these tests pin the contract so a future
  // re-categorization doesn't silently break "if (status === 401) re-login".
  it("WALLET_LOCKED / WRONG_PASSWORD → 401 (re-auth)", () => {
    expect(httpStatusForCode("WALLET_LOCKED")).toBe(401);
    expect(httpStatusForCode("WRONG_PASSWORD")).toBe(401);
  });

  it("SAFEGUARD_TRIGGERED + policy-block codes → 403 (forbidden by config, not retryable)", () => {
    expect(httpStatusForCode("SAFEGUARD_TRIGGERED")).toBe(403);
    expect(httpStatusForCode("TOKEN_BLOCKED")).toBe(403);
    expect(httpStatusForCode("CONTRACT_BLOCKED")).toBe(403);
    expect(httpStatusForCode("AMOUNT_EXCEEDS_LIMIT")).toBe(403);
    expect(httpStatusForCode("SLIPPAGE_TOO_HIGH")).toBe(403);
  });

  it("404 for not-found resources (tx hash unknown, wallet missing, unknown chain/token/account)", () => {
    expect(httpStatusForCode("TX_NOT_FOUND")).toBe(404);
    expect(httpStatusForCode("WALLET_NOT_FOUND")).toBe(404);
    expect(httpStatusForCode("UNKNOWN_CHAIN")).toBe(404);
    expect(httpStatusForCode("UNKNOWN_TOKEN")).toBe(404);
    expect(httpStatusForCode("UNKNOWN_ACCOUNT")).toBe(404);
  });

  it("WALLET_EXISTS → 409 (create conflict)", () => {
    expect(httpStatusForCode("WALLET_EXISTS")).toBe(409);
  });

  it("upstream failures → 502 (retryable, not the user's fault)", () => {
    expect(httpStatusForCode("RPC_FAILED")).toBe(502);
    expect(httpStatusForCode("AGGREGATOR_FAILED")).toBe(502);
    expect(httpStatusForCode("QUOTE_FAILED")).toBe(502);
    expect(httpStatusForCode("API_ERROR")).toBe(502);
  });

  it("RPC_RATE_LIMITED → 503 (backpressure, retry with backoff)", () => {
    expect(httpStatusForCode("RPC_RATE_LIMITED")).toBe(503);
  });

  it("TX_TIMEOUT → 504 (signals 'check tx separately' rather than 'broken')", () => {
    expect(httpStatusForCode("TX_TIMEOUT")).toBe(504);
  });

  it("INTERNAL_ERROR → 500 (genuinely unmapped)", () => {
    expect(httpStatusForCode("INTERNAL_ERROR")).toBe(500);
  });

  it("user-fixable errors → 400 (caller submitted something bad)", () => {
    expect(httpStatusForCode("INVALID_PARAMS")).toBe(400);
    expect(httpStatusForCode("INSUFFICIENT_BALANCE")).toBe(400);
    expect(httpStatusForCode("INSUFFICIENT_LIQUIDITY")).toBe(400);
    expect(httpStatusForCode("NEEDS_APPROVAL")).toBe(400);
    expect(httpStatusForCode("SLIPPAGE_EXCEEDED")).toBe(400);
    expect(httpStatusForCode("SIMULATION_FAILED")).toBe(400);
    expect(httpStatusForCode("TX_REVERTED")).toBe(400);
  });
});

describe("classifyReason (iter145 — string-only classifier for simulation reverts)", () => {
  it("maps slippage revert strings → SLIPPAGE_EXCEEDED + re-quote hint", () => {
    const r = classifyReason("execution reverted: minReturn not met");
    expect(r?.code).toBe("SLIPPAGE_EXCEEDED");
    expect(r?.nextActions?.[0].tool).toBe("quote");
  });

  it("maps OZ ERC20InsufficientBalance → INSUFFICIENT_BALANCE + top-up hint", () => {
    // The decodeRevert path turns the selector into this name; classifyReason then
    // maps the name to the proper code via the existing pattern table.
    const r = classifyReason("ERC20: transfer amount exceeds balance");
    expect(r?.code).toBe("INSUFFICIENT_BALANCE");
    // Iter492: changed `wallet` → `holdings` so the hint names a tool that exists on
    // every surface (CLI / MCP / web). `wallet` is only a CLI command.
    expect(r?.nextActions?.[0].tool).toBe("holdings");
  });

  it("maps insufficient-allowance reverts → NEEDS_APPROVAL", () => {
    const r = classifyReason("ERC20: transfer amount exceeds allowance");
    expect(r?.code).toBe("NEEDS_APPROVAL");
    expect(r?.nextActions?.[0].tool).toBe("approve");
  });

  it("returns null when no pattern matches (caller falls back)", () => {
    expect(classifyReason("some bizarre custom contract revert string")).toBeNull();
  });

  it("iter439: viem ChainMismatchError → RPC_FAILED + doctor next-action pointing at iter428", () => {
    // Exact format viem produces (verified against node_modules/viem/_esm/errors/chain.js).
    const r = classifyReason(
      "The current chain of the wallet (id: 42161) does not match the target chain for the transaction (id: 8453 – Base).",
    );
    expect(r?.code).toBe("RPC_FAILED");
    expect(r?.nextActions?.[0].tool).toBe("doctor");
    expect(r?.nextActions?.[0].reason).toMatch(/different chainId/);
    // Iter547: also pin the paste-ready `tradekit doctor` embed in iter439's reason.
    // Same iter537-541 pinning discipline for cross-surface CLI command embeds.
    expect(r?.nextActions?.[0].reason).toMatch(/`tradekit doctor`/);
  });
});

describe("wrongPasswordError (iter435)", () => {
  // env mutation needs careful save/restore so test order doesn't matter.
  const originalEnv = process.env.WALLET_PASS;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WALLET_PASS;
    else process.env.WALLET_PASS = originalEnv;
  });

  it("uses WRONG_PASSWORD code regardless of env state", () => {
    delete process.env.WALLET_PASS;
    expect(wrongPasswordError("keystore").code).toBe("WRONG_PASSWORD");
    process.env.WALLET_PASS = "anything";
    expect(wrongPasswordError("keystore").code).toBe("WRONG_PASSWORD");
  });

  it("names WALLET_PASS env-var pitfall when env is set (the invisible-failure case)", () => {
    process.env.WALLET_PASS = "stale-from-previous-wallet";
    const err = wrongPasswordError("keystore");
    expect(err.message).toMatch(/WALLET_PASS is set in your environment/);
    expect(err.message).toMatch(/unset WALLET_PASS/);
    expect(err.details).toMatchObject({ walletPassEnvSet: true, subject: "keystore" });
  });

  it("falls back to a generic --pass / WALLET_PASS hint when env is unset", () => {
    delete process.env.WALLET_PASS;
    const err = wrongPasswordError("mnemonic");
    expect(err.message).toMatch(/Pass --pass <correct-password>/);
    expect(err.message).not.toMatch(/WALLET_PASS is set/);
    expect(err.details).toMatchObject({ walletPassEnvSet: false, subject: "mnemonic" });
  });

  it("carries a doctor next-action so agents can mechanically verify the password", () => {
    delete process.env.WALLET_PASS;
    const err = wrongPasswordError("keystore");
    expect(err.nextActions?.[0].tool).toBe("doctor");
    expect(err.nextActions?.[0].params).toMatchObject({ pass: expect.any(String) });
    // Iter548: pin the full paste-ready CLI prefix not just the bare flag string —
    // a regression that dropped the `tradekit` prefix would still match /doctor --pass/.
    expect(err.nextActions?.[0].reason).toMatch(/`tradekit doctor --pass/);
    // Iter549: pin that params.pass is the literal placeholder text. The agent
    // dispatching this nextAction must substitute the real password — passing the
    // literal "<correct-password>" string would attempt to decrypt with that
    // literal which is almost certainly wrong. The placeholder convention is what
    // iter435 settled on; a regression sending undefined or empty would also break
    // the contract.
    expect(err.nextActions?.[0].params?.pass).toBe("<correct-password>");
  });
});

describe("rpcFailedChainError (iter574)", () => {
  it("returns a ToolError with code RPC_FAILED and the supplied message", () => {
    const err = rpcFailedChainError("base", "Could not fetch block number on base: timeout", "getBlockNumber");
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("RPC_FAILED");
    expect(err.message).toMatch(/timeout/);
  });

  it("carries details.{chain, operation, reason} so a script can branch structurally", () => {
    const err = rpcFailedChainError("arbitrum", "msg", "estimateFeesPerGas");
    expect(err.details).toMatchObject({
      chain: "arbitrum",
      operation: "estimateFeesPerGas",
      reason: "rpc_read_failed",
    });
  });

  it("merges extraDetails into details (e.g. txHash from cli/inspect)", () => {
    const err = rpcFailedChainError("base", "msg", "getTransactionReceipt", { extraDetails: { txHash: "0xabc" } });
    expect(err.details).toMatchObject({
      chain: "base",
      operation: "getTransactionReceipt",
      reason: "rpc_read_failed",
      txHash: "0xabc",
    });
  });

  it("carries a typed doctor nextAction with chain pre-scoped", () => {
    const err = rpcFailedChainError("optimism", "msg", "op");
    expect(err.nextActions?.[0].tool).toBe("doctor");
    expect(err.nextActions?.[0].params).toMatchObject({ chains: ["optimism"] });
    // The reason embeds the paste-ready CLI form per the iter435 convention.
    expect(err.nextActions?.[0].reason).toMatch(/`tradekit doctor --chains optimism`/);
  });

  it("propagates cause when supplied (preserves viem stack for debug logs)", () => {
    const cause = new Error("underlying viem error");
    const err = rpcFailedChainError("base", "msg", "op", { cause });
    expect((err as unknown as { cause?: unknown }).cause).toBe(cause);
  });
});

describe("nextAction tool names map to real MCP tools (iter586/587/588 invariant)", () => {
  // The canonical MCP tool registry. Drift here means an MCP tool was added or
  // renamed without updating this list — fail loudly so the next person adds it.
  // Pre-iter586 `doctor` was missing (the wrongPasswordError/rpcFailedChainError
  // helpers emitted nextActions pointing at it). Pre-iter587 `trade` was emitted
  // by safety.ts but never registered. Both were caught by audit; this test
  // codifies the contract so future drift gets caught before merge.
  const MCP_TOOLS = new Set([
    // admin-tools.ts: status, accounts, audit, reconcile, recent_trades, config, doctor, speedup_tx, cancel_tx
    "status", "accounts", "audit", "reconcile", "recent_trades", "config", "doctor",
    // Iter603: stuck-tx recovery surface.
    "speedup_tx", "cancel_tx",
    // Iter607: on-chain backfill surface.
    "sync_trades",
    // Iter739: sync-bookmark inspection (per-(chain,account,owner) resume state).
    "list_sync_bookmarks",
    // Iter614: address book (named recipient aliases).
    "address",
    // Iter619: trade execution quality analysis.
    "analyze_trade",
    // Iter622: stuck-tx diagnostic.
    "diagnose_pending",
    // Iter626: integrity verification suite.
    "verify",
    // data-tools.ts: chains, gas, price, holdings, portfolio, trending, pnl, viewTx, check_price
    "chains", "gas", "price", "holdings", "portfolio", "trending", "pnl", "viewTx", "check_price",
  // v64: recent price range/trend/position for entry-timing.
  "price_context",
    // v65: open-position review (cost basis + unrealized + holding/term) for exit-timing.
    "open_positions",
    // v70: solve for the max admissible trade size (inverse of safety_headroom).
    "trade_sizing",
    // v74: preflight decision journal (verdicts incl. refused trades).
    "preflight_history",
    // v75: preflight calibration — did the verdicts predict outcomes?
    "preflight_calibration",
    // Iter618: portfolio history capture + diff.
    "portfolio_snapshot", "portfolio_history", "portfolio_diff",
    // Iter621: operator dashboard.
    "health",
    // Iter623: aggregator quality stats.
    "aggregator_stats",
    // v58: data-driven aggregator routing tuning.
    "aggregator_tune",
    // Iter629: unified token report.
    "token_info",
    // Iter634: per-pair slippage stats.
    "pair_stats",
    // Iter644: standalone slippage suggestion.
    "slippage_suggest",
    // Iter651: distinct strategy tags directory.
    "strategies_list",
    // trade-tools.ts: quote, buy, sell, import_trade, transfer, preview_trade, preflight_trade, sweep_balances
    "quote", "buy", "sell", "import_trade", "transfer", "preview_trade", "preflight_trade", "sweep_balances",
    // Conditional / limit orders surface (order create/list/show/cancel/run).
    "order_create", "order_list", "order_show", "order_cancel", "order_pause", "order_resume", "order_edit", "order_run",
    "signal_fire", "signal_list",
    // Notification / webhook channels surface (notify list/test).
    "notify_list", "notify_test",
    // Scheduled / recurring trades surface (schedule create/list/show/pause/resume/cancel/run).
    "schedule_create", "schedule_list", "schedule_show", "schedule_pause", "schedule_resume", "schedule_cancel", "schedule_edit", "schedule_run",
    // Unified engine supervisor (engine_run for one-shot tick, engine_status for read-only status).
    "engine_run", "engine_status",
    // Iter28: global kill switch (lock + unlock).
    "engine_lock", "engine_unlock",
    // Iter35: config hot-reload preflight (no MCP tool for reload itself —
    // sending signals to other processes is out-of-band; agents that want
    // to trigger reload write the file + call the host's `config reload`
    // CLI surface).
    "config_preflight",
    // Iter37: bulk halt/resume primitives — scoped operational halt.
    "bulk_halt", "bulk_resume",
    // Portfolio rebalancing (rebalance create/list/show/pause/resume/cancel/run).
    "rebalance_create", "rebalance_list", "rebalance_show", "rebalance_edit", "rebalance_pause", "rebalance_resume", "rebalance_cancel", "rebalance_run",
    // v56: ad-hoc drift + corrective-trade preview (no plan row).
    "rebalance_preview",
    // security-tools.ts: allowances, audit_allowances, approve, revoke, revoke_all, check_token
    "allowances", "audit_allowances", "approve", "revoke", "revoke_all", "check_token",
    // Iter26: safety stack — drawdown breaker inspection + reset.
    "safety_drawdown", "safety_reset_drawdown",
    // v51: consolidated guardrail posture audit.
    "safety_review",
    // v53: runtime headroom across every active limit.
    "safety_headroom",
    // Iter26: strategy lifecycle (playbooks + backtests) exposed for agent control.
    // v2: playbook_diff + playbook_replace — strategy iteration over MCP.
    "playbook_validate", "playbook_deploy", "playbook_list", "playbook_show", "playbook_destroy",
    "playbook_diff", "playbook_replace", "playbook_promote",
    "backtest_order", "backtest_playbook", "backtest_compare", "backtest_rebalance",
    // Iter26: observability — status dashboard, windowed digest, forensic order replay,
    // backtest history retrieval.
    "status_dashboard", "digest_summary", "order_replay", "schedule_replay", "rebalance_replay",
    "backtest_list", "backtest_show", "backtest_compare_list", "backtest_compare_show",
    // Iter31: unified strategy observability report.
    "strategy_report",
    // Strategy-level bulk control (manual circuit breaker).
    "strategy_pause", "strategy_resume",
    // Funding-runway forecast (read-only).
    "runway",
    // Equity curve from portfolio snapshots (read-only).
    "equity_curve",
    // Realized-gains report (read-only, deterministic).
    "gains_report",
    // Operator notes — the timeline's human layer.
    "note_add", "note_list",
    // One-command postmortem (read-only composition).
    "incident_report",
    "execution_report",
    "intents_list",
    "playbook_promote_check",
    // v50: backward half of the trust pipeline — did the promote deliver?
    "playbook_outcome",
    // Iter36: forensic timeline (cross-strategy chronological events).
    "timeline_query",
    // Iter38: per-provider price-fetch observability.
    "price_stats",
    // Iter39: durable engine state transitions.
    "engine_events",
    // v28: durable strategy-alert transition journal.
    "alert_history",
    // Iter40: DB lifecycle observability.
    "db_stats", "db_integrity_check",
    // paper-tools.ts: virtual-book management for dry-run strategies
    // (closes the CLI/MCP parity gap — paper trades could fire via the
    // order/schedule `paper` flag but had no MCP management surface).
    "paper_balances", "paper_trades", "paper_pnl", "paper_deposit", "paper_reset",
  ]);

  it("ERROR_PATTERNS nextActions only reference registered MCP tools", () => {
    const orphans: { code: string; tool: string }[] = [];
    for (const pattern of ERROR_PATTERNS) {
      for (const na of pattern.nextActions ?? []) {
        if (!MCP_TOOLS.has(na.tool)) orphans.push({ code: pattern.code, tool: na.tool });
      }
    }
    expect(orphans).toEqual([]);
  });

  it("wrongPasswordError nextActions only reference registered MCP tools", () => {
    delete process.env.WALLET_PASS;
    const err = wrongPasswordError("keystore");
    for (const na of err.nextActions ?? []) {
      expect(MCP_TOOLS.has(na.tool)).toBe(true);
    }
  });

  it("rpcFailedChainError nextActions only reference registered MCP tools", () => {
    const err = rpcFailedChainError("base", "msg", "op");
    for (const na of err.nextActions ?? []) {
      expect(MCP_TOOLS.has(na.tool)).toBe(true);
    }
  });

  // Iter589: ERROR_PATTERNS / wrongPasswordError / rpcFailedChainError cover the
  // shared helpers but many nextActions live inline in safety.ts, trade.ts,
  // transfer.ts, price.ts, holdings.ts, receipt.ts, cli/inspect.ts. A regex
  // scan over src/ is the only way to catch them centrally without registering
  // every individual call site. The scan is conservative — it matches the exact
  // `tool: "..."` literal form that all current sites use.
  it("Iter589: every `tool: \"...\"` literal in src/ references a registered MCP tool", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const srcDir = join(import.meta.dirname ?? ".", "..", "src");
    const orphans: { file: string; tool: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
          if (entry === "node_modules" || entry === ".claude") continue;
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(/\btool:\s*"([a-zA-Z_]+)"/g)) {
          const toolName = m[1];
          if (!MCP_TOOLS.has(toolName)) orphans.push({ file: full, tool: toolName });
        }
      }
    };
    walk(srcDir);
    // Failure surfaces the exact file + tool name so a fix can be targeted.
    expect(orphans).toEqual([]);
  });

  // Iter877: reverse invariant. iter589 catches "references that aren't in
  // the set"; this catches "registrations that aren't in the set." iter876
  // exposed the gap — `list_sync_bookmarks` (iter739) was registered in
  // admin-tools.ts but missing from MCP_TOOLS for 100+ iters. Without this
  // test, future MCP tools added by `server.tool(NAME, ...)` calls won't
  // auto-fail when the maintainer forgets to update MCP_TOOLS.
  //
  // The trade-tools.ts buy/sell loop is an exception — the registration is
  // `server.tool(direction, ...)` where direction is a loop variable. The
  // regex only matches string-literal first-arg registrations; buy/sell
  // are added manually below so the invariant still covers them.
  it("Iter877: every server.tool(NAME, ...) in src/mcp/*.ts is in MCP_TOOLS", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const mcpDir = join(import.meta.dirname ?? ".", "..", "src", "mcp");
    const registered = new Set<string>(["buy", "sell"]); // iter877: trade-tools.ts loop adds these
    for (const entry of readdirSync(mcpDir)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const text = readFileSync(join(mcpDir, entry), "utf8");
      // Match server.tool("NAME", ... — the canonical registration form.
      // Tolerates whitespace + multi-line wrapping (the actual code style).
      for (const m of text.matchAll(/server\.tool\(\s*"([a-zA-Z_]+)"/g)) {
        registered.add(m[1]);
      }
    }
    const missing: string[] = [];
    for (const name of registered) {
      if (!MCP_TOOLS.has(name)) missing.push(name);
    }
    // Failure means a new tool was added via server.tool() but MCP_TOOLS
    // wasn't updated — add it alongside the registration site.
    expect(missing).toEqual([]);
  });
});
