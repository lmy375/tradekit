/**
 * Structured error codes for tradekit. Every error surfaced to an Agent / CLI
 * carries a stable machine-readable code so callers can branch on it.
 */
export type ErrorCode =
  // input
  | "INVALID_PARAMS"
  | "UNKNOWN_CHAIN"
  | "UNKNOWN_TOKEN"
  | "UNKNOWN_ACCOUNT"
  // Iter614: address-book alias resolution failure (`@name` doesn't match any saved entry).
  | "UNKNOWN_RECIPIENT"

  // wallet
  | "WALLET_LOCKED"
  | "WALLET_NOT_FOUND"
  | "WALLET_EXISTS"
  | "WRONG_PASSWORD"

  // network / rpc
  | "RPC_FAILED"
  | "RPC_RATE_LIMITED"
  | "TX_NOT_FOUND"

  // quote / liquidity
  | "INSUFFICIENT_LIQUIDITY"
  | "QUOTE_FAILED"
  | "AGGREGATOR_FAILED"

  // execution
  | "INSUFFICIENT_BALANCE"
  | "NEEDS_APPROVAL"
  | "SLIPPAGE_EXCEEDED"
  | "SIMULATION_FAILED"
  | "TX_REVERTED"
  | "TX_TIMEOUT"

  // safety
  | "SAFEGUARD_TRIGGERED"
  | "TOKEN_BLOCKED"
  | "CONTRACT_BLOCKED"
  | "AMOUNT_EXCEEDS_LIMIT"
  | "SLIPPAGE_TOO_HIGH"
  // Iter620: gas budget tripped (operator-configured cap on absolute native gas
  // or gas-as-%-of-trade USD). Distinct from SAFEGUARD_TRIGGERED so an agent can
  // branch on "this is just expensive gas, retry later" vs. "policy violation".
  | "GAS_BUDGET_EXCEEDED"
  // Portfolio-aware position limit tripped (safety.positionLimits): the trade
  // would push a token's weight outside its configured min/max % band. Distinct
  // from AMOUNT_EXCEEDS_LIMIT (which gates the SIZE of individual trades) and
  // SAFEGUARD_TRIGGERED (catch-all) so agents can branch on "rebalance needed"
  // specifically — and the error details name exactly which limit hit (current
  // %, predicted %, target band) for a one-shot remediation.
  | "POSITION_LIMIT_EXCEEDED"
  // Iter19: per-strategy budget tripped (safety.strategyBudgets). The trade's
  // predicted USD value would push the strategy tag's cumulative spend past a
  // configured cap (lifetime / 24h / per-fire). Distinct from
  // AMOUNT_EXCEEDS_LIMIT (global per-tx cap) and SAFEGUARD_TRIGGERED (catch-all)
  // — agents can branch on "I'm out of budget on THIS strategy" specifically.
  // Error details name the tag, which window tripped, current spend, predicted
  // spend, and the configured cap — so an operator's next action is unambiguous
  // (resize, wait for the window to roll, or raise the cap).
  | "STRATEGY_BUDGET_EXCEEDED"
  | "POSITION_CAP_EXCEEDED"
  // Iter20: portfolio drawdown circuit breaker tripped (safety.drawdownCircuitBreaker).
  // The portfolio's current USD value has fallen below peak × (1 - maxDrawdownPct/100),
  // OR the breaker was already tripped from a previous trade and hasn't been reset.
  // Distinct from POSITION_LIMIT_EXCEEDED (which gates composition) and
  // STRATEGY_BUDGET_EXCEEDED (which gates per-strategy spend) — this one is purely
  // about capital trajectory. Error details name the scope, peak, current value,
  // observed drawdown %, configured threshold, and tripped_at timestamp.
  | "DRAWDOWN_CIRCUIT_BREAKER_TRIPPED"
  // Iter28: global engine kill switch is active. ALL trading paths
  // (orders engine, schedules, rebalance, manual trades, post-fill
  // hooks) reject with this code until an operator runs
  // `tradekit engine unlock`. Distinct from SAFEGUARD_TRIGGERED
  // (per-rule violation) and DRAWDOWN_CIRCUIT_BREAKER_TRIPPED
  // (per-state condition) — this is "operator pulled the kill
  // switch for incident response / maintenance".
  | "ENGINE_LOCKED"
  // Iter625: trade's actual quoted amount diverged from the caller-supplied
  // expected amount by more than the tolerance. Distinct from SLIPPAGE_TOO_HIGH
  // (that's about per-tx max slippage in the router); this catches "market moved
  // between quote and execute" — the spread between two QUOTES, not between
  // quote and fill.
  | "QUOTE_DEVIATION_EXCEEDED"

  // Iter30: paper trading specific.
  //   PRICE_UNAVAILABLE — paper trades require a real-time spot
  //     price to size the virtual fill; aborted when both
  //     CoinGecko + DexScreener miss.
  //   PAPER_INSUFFICIENT_BALANCE — the virtual book doesn't have
  //     enough of the input token for the trade. Distinct from
  //     INSUFFICIENT_BALANCE (which is about on-chain balances)
  //     so dashboards / agents can tell whether the operator
  //     needs to seed the virtual book vs. fund the wallet.
  | "PRICE_UNAVAILABLE"
  | "PAPER_INSUFFICIENT_BALANCE"

  // external API
  | "API_ERROR"

  // catch-all
  | "INTERNAL_ERROR";

export interface NextAction {
  tool: string;
  params?: Record<string, unknown>;
  reason: string;
}

export class ToolError extends Error {
  code: ErrorCode;
  details?: Record<string, unknown>;
  nextActions?: NextAction[];

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; nextActions?: NextAction[]; cause?: unknown },
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = options?.details;
    this.nextActions = options?.nextActions;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
      next_actions: this.nextActions,
    };
  }
}

/**
 * Iter435: shared WRONG_PASSWORD builder. The three call sites (single-key decryptKeystore,
 * loadWallet keystore branch, accounts.ts decrypt) all throw the same code with cosmetically
 * different messages and no actionable hints. Operators hitting this typically have one
 * of three problems: (1) typed the wrong password, (2) have a stale WALLET_PASS env from
 * a previous wallet, (3) corrupted keystore. Pointing them at the env var explicitly
 * catches the most common case — the env-var pitfall is invisible because shells don't
 * usually surface inherited environment in error messages.
 */
export function wrongPasswordError(subject: "keystore" | "mnemonic"): ToolError {
  const envSet = !!process.env.WALLET_PASS;
  const detail = envSet
    ? " WALLET_PASS is set in your environment — if you recently rotated your wallet, the env var may be stale. Try `unset WALLET_PASS` and re-run with --pass, or update the env var."
    : " Pass --pass <correct-password>, or set WALLET_PASS in your environment.";
  return new ToolError(
    "WRONG_PASSWORD",
    `Failed to decrypt ${subject} — wrong password?${detail}`,
    {
      details: { walletPassEnvSet: envSet, subject },
      nextActions: [
        {
          tool: "doctor",
          params: { pass: "<correct-password>" },
          reason: "Run `tradekit doctor --pass <correct-password>` to verify the password decrypts the keystore.",
        },
      ],
    },
  );
}

/**
 * Iter574: shared builder for chain-level RPC_FAILED errors. Pre-iter574 four sites
 * (holdings.ts chain-wide outage, gas.ts × 2 fee/block reads, cli/inspect.ts viewTx)
 * each constructed their own ToolError with the same shape — chain in details, paste-
 * ready `tradekit doctor --chains <X>` in the reason, doctor nextAction with the
 * chain pre-scoped. Iter571/572/573 made them consistent; this helper collapses the
 * pattern so future RPC_FAILED throws can't drift.
 *
 * The caller supplies the chain name, the verbose context message (kept distinct per
 * site since the underlying RPC operation differs), and an `operation` discriminator
 * for details.operation so a script can branch on which call failed without parsing
 * the message. Extra detail fields can be merged in via `extraDetails`.
 */
export function rpcFailedChainError(
  chainName: string,
  message: string,
  operation: string,
  opts?: { cause?: unknown; extraDetails?: Record<string, unknown> },
): ToolError {
  return new ToolError(
    "RPC_FAILED",
    message,
    {
      cause: opts?.cause,
      details: { chain: chainName, operation, reason: "rpc_read_failed", ...opts?.extraDetails },
      nextActions: [
        {
          tool: "doctor",
          params: { chains: [chainName] },
          reason: `Check RPC health for ${chainName} to identify the failing endpoint (CLI: \`tradekit doctor --chains ${chainName}\`).`,
        },
      ],
    },
  );
}

/**
 * Pattern → error-code classifier for raw RPC/viem error strings. Ordered most-specific
 * first; the first match wins. Each entry can attach static nextActions hints that the
 * agent can mechanically follow.
 *
 * Adding a new pattern: pick the most distinctive substring (lowercase) and the most
 * specific code. If the recovery is mechanical (re-try, raise slippage, top up gas),
 * add a nextActions hint; otherwise leave it to the agent's judgment.
 */
// Iter588: export to let the cross-surface tool-name invariant test (errors.test.ts)
// walk every pattern's nextActions and assert the tool name maps to a real MCP tool.
// Pre-iter588 the test had no programmatic way to iterate the patterns.
export const ERROR_PATTERNS: {
  match: (lower: string) => boolean;
  code: ErrorCode;
  nextActions?: NextAction[];
}[] = [
  // Rate limit — exponential backoff or switch RPC.
  {
    match: (s) => s.includes("rate limit") || s.includes("429") || s.includes("too many requests"),
    code: "RPC_RATE_LIMITED",
  },
  // User cancelled in their wallet UI — not retryable without user action.
  { match: (s) => s.includes("user rejected") || s.includes("user denied"), code: "TX_REVERTED" },
  // Slippage revert from router. Recovery: re-quote with higher slippageBps.
  {
    match: (s) =>
      s.includes("slippage") ||
      s.includes("insufficient_output_amount") ||
      s.includes("price impact too high") ||
      s.includes("minreturn") ||
      s.includes("return amount is not enough"),
    code: "SLIPPAGE_EXCEEDED",
    // Iter529: same paste-ready CLI form. classifyReason has no slippageBps context
    // so the command stays parameter-templated — the operator/agent substitutes the
    // previous value + a bps increase before running.
    nextActions: [{ tool: "quote", reason: "Re-quote with a higher slippageBps (e.g. previous + 50bps). Run `tradekit quote --slippage <new-bps>` (CLI) or call the quote tool with slippageBps set (MCP)." }],
  },
  // Insufficient ERC20 balance — must check BEFORE the allowance pattern below, since
  // the OZ revert strings "exceeds balance" and "exceeds allowance" share the word
  // "exceeds" and we want to route them to different codes.
  {
    match: (s) =>
      s.includes("erc20: transfer amount exceeds balance") ||
      s.includes("bep20: transfer amount exceeds balance") ||
      s.includes("erc20insufficientbalance") ||
      s.includes("transfer amount exceeds balance"),
    code: "INSUFFICIENT_BALANCE",
    // Iter492: `holdings` exists as a tool on every surface (CLI / MCP / web);
    // pre-iter492 the hint named `wallet`, which is a CLI command but NOT an MCP /
    // web tool — an agent receiving this error couldn't mechanically dispatch to it.
    // Iter526: same iter508/520 paste-ready CLI form. classifyReason doesn't have
    // chain/account context (it's a pattern matcher over error strings), so the
    // command is unscoped — but `tradekit holdings` defaults to all-chains scan,
    // which is what the operator needs when they don't know where the shortfall is.
    nextActions: [{ tool: "holdings", reason: "Check current balances — run `tradekit holdings` (CLI) or call the holdings tool (MCP). Then reduce trade size or top up the input token." }],
  },
  // Allowance was consumed mid-flight or never granted. Recovery: re-approve. Patterns
  // are narrowed to the actual OZ revert shapes so we don't misclassify any revert
  // that incidentally contains the word "allowance" (e.g. a custom router message).
  {
    match: (s) =>
      s.includes("transfer_from_failed") ||
      s.includes("transferfrom failed") ||
      s.includes("erc20: transfer amount exceeds allowance") ||
      s.includes("erc20insufficientallowance") ||
      s.includes("insufficient allowance"),
    code: "NEEDS_APPROVAL",
    // Iter530: paste-ready CLI form (templated — classifier has no token/spender
    // context). Operator/agent substitutes from the trade's input token + the
    // aggregator's allowanceTarget (visible in the trade result's allowanceTarget
    // field, or via `tradekit allowances` to inspect current state).
    nextActions: [{ tool: "approve", reason: "Re-approve the router for the input token; previous allowance was insufficient. Run `tradekit approve <token> <spender> --amount <amount>` (CLI) or call the approve tool with token/spender/amount (MCP); inspect current allowances first via `tradekit allowances` if needed." }],
  },
  // Nonce conflict — another tx is pending or one was just mined. Recovery: wait + retry.
  {
    match: (s) =>
      s.includes("nonce too low") ||
      s.includes("nonce has already been used") ||
      s.includes("known transaction") ||
      s.includes("already known"),
    code: "TX_REVERTED",
    // Iter492: same `wallet` → `holdings` cross-surface fix as the INSUFFICIENT_BALANCE
    // sibling above; `recent_trades` would also fit but holdings keeps the agent-action
    // surface consistent across the file.
    // Iter520: name the CLI command form too. `recent_trades` is the MCP tool name;
    // the CLI command for the same data is `tradekit trades --pending`. Both surfaces
    // get an actionable hint they can mechanically dispatch.
    nextActions: [{ tool: "recent_trades", reason: "Wait for any pending tx to confirm, then retry — nonce was reused. Inspect with `tradekit trades --pending` (CLI) or the recent_trades tool (MCP) to spot pending rows." }],
  },
  // Replacement-underpriced — bump gas to replace pending.
  {
    match: (s) => s.includes("replacement transaction underpriced") || s.includes("underpriced"),
    code: "TX_REVERTED",
    // Iter530: reword to match what tradekit actually supports. The original
    // "Retry with a higher gas tip" implied a knob tradekit doesn't expose —
    // viem auto-estimates fees on each call, so re-running pulls a fresh
    // (typically higher) estimate after the pending tx clears or drops.
    // Iter587: `quote` is a real cross-surface tool; `trade` was an umbrella with
    // no MCP destination. Quote first to verify the retry params before re-dispatching.
    nextActions: [{ tool: "quote", reason: "Wait for the previous pending tx to confirm or drop, then re-run via quote (to verify) + buy/sell — viem re-estimates fees per call, so the retry picks up the latest gas market. Inspect with `tradekit trades --pending` first to see which tx is blocking." }],
  },
  // Native balance < value+gas. Catch BEFORE the generic "insufficient" check.
  {
    match: (s) => s.includes("insufficient funds for gas") || s.includes("insufficient funds for transfer"),
    code: "INSUFFICIENT_BALANCE",
    // Iter492: `wallet` is a CLI command but not an MCP / web tool; `holdings` exists
    // on every surface so the agent can mechanically dispatch.
    // Iter526: paste-ready CLI form. Same unscoped command as the sibling
    // INSUFFICIENT_BALANCE pattern above — classifyReason doesn't have chain context.
    nextActions: [{ tool: "holdings", reason: "Top up the native gas token, or reduce trade size — run `tradekit holdings` (CLI) or call the holdings tool (MCP) to see native balances per chain." }],
  },
  // Generic insufficient — usually ERC20.
  {
    match: (s) => s.includes("insufficient funds") || s.includes("insufficient balance"),
    code: "INSUFFICIENT_BALANCE",
  },
  // Network unreachable / DNS / connection refused / explicit timeout. Suggest a
  // different RPC URL or run doctor to identify which endpoint is misbehaving.
  // "timeout after Nms" matches the exact message thrown by http.ts:fetchWithTimeout
  // (iter28). The OS-level ETIMEDOUT (no "after") covers TCP-level hangs too.
  {
    match: (s) =>
      s.includes("econnrefused") ||
      s.includes("enotfound") ||
      s.includes("etimedout") ||
      s.includes("timeout after") ||
      s.includes("network request failed") ||
      s.includes("fetch failed"),
    code: "RPC_FAILED",
    // Iter527: embed paste-ready `tradekit doctor` (same iter508/520/526 convention).
    // Pre-iter527 the reason said "run doctor" — a CLI user had to know that doctor
    // is the command and that it has a --chains flag for scoping. Now the command is
    // visible and the iter428 chainId report comes by default.
    nextActions: [{ tool: "doctor", reason: "RPC endpoint unreachable — run `tradekit doctor` to check connectivity + per-endpoint chainIds, or update chains.<chain>.rpcs in config." }],
  },
  // Iter439: viem's ChainMismatchError fires when the RPC reports a chainId that
  // doesn't match the chain we configured (e.g., operator pasted an arbitrum URL
  // into chains.base.rpcs — same class that iter428 catches at doctor time, but
  // this is the trade-time path for operators who didn't run doctor). Route to
  // RPC_FAILED with a doctor hint that names iter428's check so the operator
  // immediately knows to run doctor for a per-endpoint chainId report.
  {
    match: (s) =>
      s.includes("does not match the target chain") ||
      s.includes("chainmismatcherror"),
    code: "RPC_FAILED",
    nextActions: [{
      tool: "doctor",
      // Iter440: was "iter428 checks every RPC's chainId..." — internal iter numbers are
      // meaningless to operators reading this hint in a paste/screenshot. Rephrase
      // without leaking the iteration label; the behavior is what matters.
      reason: "RPC reports a different chainId than configured. Run `tradekit doctor` to see the per-endpoint chainId report and identify which URL in chains.<chain>.rpcs is misconfigured. Most likely cause: a URL pasted from another chain's docs.",
    }],
  },
  // Generic execution revert (no decodable reason).
  {
    match: (s) => s.includes("execution reverted") || s.includes("vm exception") || s.includes("transaction reverted"),
    code: "TX_REVERTED",
  },
];

/**
 * Map a ToolError code → HTTP status for the web layer. Lets the frontend branch on
 * the response status (re-auth on 401, retry on 5xx, surface to user on 4xx) without
 * having to parse the body and string-match every code.
 *
 * Categories:
 *   401 — auth needed (wallet locked / password missing)
 *   403 — forbidden by policy (safeguards: token/contract block, USD cap, slippage cap)
 *   404 — resource not found (tx hash unknown, wallet missing)
 *   409 — conflict (wallet already exists)
 *   400 — caller-fixable bad input or on-chain user error
 *   502 — upstream failure (aggregator, RPC, external API)
 *   503 — backpressure (rate limited)
 *   504 — timeout (receipt didn't land in time)
 *   500 — unmapped / internal
 */
export function httpStatusForCode(code: ErrorCode): number {
  switch (code) {
    case "WALLET_LOCKED":
    case "WRONG_PASSWORD":
      return 401;
    case "SAFEGUARD_TRIGGERED":
    case "TOKEN_BLOCKED":
    case "CONTRACT_BLOCKED":
    case "AMOUNT_EXCEEDS_LIMIT":
    case "SLIPPAGE_TOO_HIGH":
    case "GAS_BUDGET_EXCEEDED":
    case "QUOTE_DEVIATION_EXCEEDED":
    case "POSITION_LIMIT_EXCEEDED":
    case "STRATEGY_BUDGET_EXCEEDED":
    case "POSITION_CAP_EXCEEDED":
    case "DRAWDOWN_CIRCUIT_BREAKER_TRIPPED":
    case "ENGINE_LOCKED":
      return 403;
    case "TX_NOT_FOUND":
    case "WALLET_NOT_FOUND":
    case "UNKNOWN_CHAIN":
    case "UNKNOWN_TOKEN":
    case "UNKNOWN_ACCOUNT":
    case "UNKNOWN_RECIPIENT":
      return 404;
    case "WALLET_EXISTS":
      return 409;
    case "RPC_RATE_LIMITED":
      return 503;
    case "RPC_FAILED":
    case "AGGREGATOR_FAILED":
    case "QUOTE_FAILED":
    case "API_ERROR":
      return 502;
    case "TX_TIMEOUT":
      return 504;
    case "INTERNAL_ERROR":
      return 500;
    // INVALID_PARAMS, INSUFFICIENT_BALANCE, INSUFFICIENT_LIQUIDITY, NEEDS_APPROVAL,
    // SLIPPAGE_EXCEEDED, SIMULATION_FAILED, TX_REVERTED — all caller-fixable user errors.
    case "INVALID_PARAMS":
    case "INSUFFICIENT_BALANCE":
    case "INSUFFICIENT_LIQUIDITY":
    case "NEEDS_APPROVAL":
    case "SLIPPAGE_EXCEEDED":
    case "SIMULATION_FAILED":
    case "TX_REVERTED":
    case "PAPER_INSUFFICIENT_BALANCE":
      return 400;
    case "PRICE_UNAVAILABLE":
      return 502;
  }
}

/**
 * Detect a ZodError without importing zod (duck-typed). Zod errors have an `issues`
 * array of `{code, path, message, ...}` and a `name === "ZodError"`. We turn them
 * into a single human-readable line per issue so CLI/MCP users see "safety.dailyUsdLimit:
 * Expected number, received string" instead of a JSON dump.
 */
function isZodErrorShape(e: unknown): e is { name: string; issues: { path: (string | number)[]; message: string }[] } {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: unknown; issues?: unknown };
  return err.name === "ZodError" && Array.isArray(err.issues);
}

function formatZodIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .map((iss) => {
      const path = iss.path.length > 0 ? iss.path.join(".") : "(root)";
      return `${path}: ${iss.message}`;
    })
    .join("; ");
}

/** Wrap an unknown thrown value into a ToolError. */
/**
 * Run the ERROR_PATTERNS classifier against a free-form string (e.g. a revert reason
 * that didn't come through as a thrown Error). Used by trade.ts to refine the generic
 * SIMULATION_FAILED into specific codes — pre-iter145 a simulated revert with
 * "ERC20: transfer amount exceeds balance" was surfaced to the agent as a generic
 * SIMULATION_FAILED with a re-quote hint, when it actually needed INSUFFICIENT_BALANCE
 * + a top-up hint. Returns null if no pattern matches; caller falls back to its own
 * code.
 */
export function classifyReason(
  reason: string,
): { code: ErrorCode; nextActions?: NextAction[] } | null {
  const lower = reason.toLowerCase();
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.match(lower)) return { code: pattern.code, nextActions: pattern.nextActions };
  }
  return null;
}

export function toToolError(e: unknown, fallbackCode: ErrorCode = "INTERNAL_ERROR"): ToolError {
  if (e instanceof ToolError) return e;
  if (isZodErrorShape(e)) {
    // Validation failures from config / MCP / web input all funnel through here.
    // Surface as INVALID_PARAMS so the agent's recovery logic branches correctly,
    // and keep the structured issues in details for tooling that wants the raw shape.
    return new ToolError("INVALID_PARAMS", formatZodIssues(e.issues), {
      details: { issues: e.issues },
      cause: e,
    });
  }
  if (e instanceof Error) {
    const lower = e.message.toLowerCase();
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.match(lower)) {
        return new ToolError(pattern.code, e.message, {
          cause: e,
          nextActions: pattern.nextActions,
        });
      }
    }
    return new ToolError(fallbackCode, e.message, { cause: e });
  }
  return new ToolError(fallbackCode, String(e));
}
