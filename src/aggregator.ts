import type { Address } from "viem";
import { ToolError } from "./errors.js";
import type { ChainProfile } from "./chains.js";
import { sanitizeForLogLine, type Logger } from "./logger.js";
import type { Config } from "./config.js";
import { fetchWithTimeout } from "./http.js";
import { compactMessage } from "./format.js";

/**
 * Aggregator-agnostic swap quote. Every provider normalises to this shape so the
 * trade executor doesn't need to know which provider it's calling.
 */
export interface AggregatorQuote {
  /** Which provider produced this quote. */
  provider: string;
  /** Input token (the native sentinel 0xeee... is normalised back to native here for callers). */
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  /** Minimum tokenOut after slippage (encoded into calldata already). */
  amountOutMinimum: bigint;
  /** Address the user must approve for tokenIn (skipped for native). */
  allowanceTarget: Address;
  /** Calldata to send. */
  to: Address;
  data: `0x${string}`;
  value: bigint;
  /** Gas estimate from the provider (may be 0 if unknown). */
  gas?: bigint;
  /**
   * Iter602: when aggregator.mode = "best", the winning quote carries every other
   * candidate's headline numbers so callers can audit the spread without re-quoting.
   * Each alternative names the provider, its amountOut, and the bps gap vs the winner
   * (positive means the winner was better; negative would mean the alternative was
   * actually higher, which is a sort bug). Errored providers also appear here with
   * their error message so the operator sees who fell over.
   *
   * Always empty in mode="first" (no race happened).
   */
  alternatives?: Array<
    | { provider: string; status: "ok"; amountOut: bigint; bpsBehindWinner: number }
    | { provider: string; status: "error"; message: string }
  >;
}

const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

function isNative(addr: Address): boolean {
  return addr.toLowerCase() === NATIVE_SENTINEL.toLowerCase();
}

/** Get decimals for a token using the shared tokens.ts cache. Native = 18. */
async function readDecimalsBestEffort(p: QuoteParams, token: Address): Promise<number> {
  if (isNative(token)) return 18;
  const { getToken } = await import("./tokens.js");
  // We need a PublicClient to read from chain. Build a lightweight one from the profile's RPCs.
  // (Avoids dragging a viem client into every aggregator call.)
  const { createPublicClient, http } = await import("viem");
  const client = createPublicClient({ chain: p.profile.viemChain, transport: http(p.profile.rpcs[0]) });
  try {
    const meta = await getToken(client as never, p.profile, token);
    return meta.decimals;
  } catch {
    return 18;
  }
}

/** BigInt → decimal string with N fractional digits (no rounding). */
function formatUnitsBig(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${intPart}${frac ? "." + frac : ""}`;
}

const KYBER_CHAIN_NAMES: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
};

interface QuoteParams {
  profile: ChainProfile;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Slippage in basis points (e.g. 50 = 0.5%). */
  slippageBps: number;
  from: Address;
  recipient?: Address;
}

// ── KyberSwap ────────────────────────────────────────────────

async function quoteFromKyberSwap(p: QuoteParams, logger: Logger): Promise<AggregatorQuote> {
  const chainName = KYBER_CHAIN_NAMES[p.profile.chainId];
  if (!chainName) throw new ToolError("AGGREGATOR_FAILED", `KyberSwap does not support chainId ${p.profile.chainId}`);

  const tokenInQ = isNative(p.tokenIn) ? NATIVE_SENTINEL : p.tokenIn;
  const tokenOutQ = isNative(p.tokenOut) ? NATIVE_SENTINEL : p.tokenOut;

  const routesUrl = `https://aggregator-api.kyberswap.com/${chainName}/api/v1/routes`;
  const params = new URLSearchParams({
    tokenIn: tokenInQ,
    tokenOut: tokenOutQ,
    amountIn: p.amountIn.toString(),
    gasInclude: "true",
  });
  logger.debug(`KyberSwap GET ${routesUrl}?${params}`);
  // Quote endpoints are idempotent — retry on 429/503/timeout so a single flap doesn't
  // bounce trade flow into "no aggregator could quote".
  const routesRes = await fetchWithTimeout(
    `${routesUrl}?${params}`,
    { headers: { "x-client-id": "tradekit" } },
    { retries: 2 },
  );
  if (!routesRes.ok) {
    throw new ToolError("AGGREGATOR_FAILED", `KyberSwap routes ${routesRes.status} ${routesRes.statusText}`);
  }
  const routesBody = (await routesRes.json()) as {
    code: number;
    message: string;
    data?: { routeSummary?: unknown };
  };
  if (routesBody.code !== 0 || !routesBody.data?.routeSummary) {
    // Iter390: actionable hint. When no route is found, operators have three real
    // options: smaller trade size (might fit a less-liquid pool), different token
    // pair, or wait (liquidity comes and goes intraday). Listing them inline turns
    // a dead-end error into a decision tree.
    throw new ToolError(
      "INSUFFICIENT_LIQUIDITY",
      `KyberSwap: ${routesBody.message || "no route"}`,
      {
        nextActions: [
          { tool: "quote", reason: "Try a smaller amount — illiquid pairs often only quote up to a threshold." },
          { tool: "quote", reason: "Try a different quote token (e.g., USDC ↔ WETH instead of USDC ↔ <obscure>) — liquidity routes through major pairs." },
        ],
      },
    );
  }

  const buildUrl = `https://aggregator-api.kyberswap.com/${chainName}/api/v1/route/build`;
  const buildRes = await fetchWithTimeout(buildUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-client-id": "tradekit" },
    body: JSON.stringify({
      routeSummary: routesBody.data.routeSummary,
      sender: p.from,
      recipient: p.recipient ?? p.from,
      slippageTolerance: p.slippageBps,
      enableGasEstimation: true,
      source: "tradekit",
    }),
  });
  if (!buildRes.ok) {
    throw new ToolError("AGGREGATOR_FAILED", `KyberSwap build ${buildRes.status} ${buildRes.statusText}`);
  }
  const buildBody = (await buildRes.json()) as {
    code: number;
    message: string;
    data?: {
      amountIn: string;
      amountOut: string;
      amountInUsd?: string;
      amountOutUsd?: string;
      gas: string;
      routerAddress: string;
      data: string;
      transactionValue: string;
    };
  };
  if (buildBody.code !== 0 || !buildBody.data) {
    throw new ToolError("AGGREGATOR_FAILED", `KyberSwap build: ${buildBody.message || "no data"}`);
  }
  const d = buildBody.data;
  const amountOut = BigInt(d.amountOut);
  const slipBps = BigInt(p.slippageBps);
  const amountOutMinimum = amountOut - (amountOut * slipBps) / 10000n;

  return {
    provider: "kyberswap",
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    amountIn: BigInt(d.amountIn),
    amountOut,
    amountOutMinimum,
    allowanceTarget: d.routerAddress as Address,
    to: d.routerAddress as Address,
    data: d.data as `0x${string}`,
    value: BigInt(d.transactionValue || (isNative(p.tokenIn) ? p.amountIn.toString() : "0")),
    gas: d.gas ? BigInt(d.gas) : undefined,
  };
}

// ── OpenOcean ────────────────────────────────────────────────

async function quoteFromOpenOcean(p: QuoteParams, logger: Logger): Promise<AggregatorQuote> {
  const inAddr = isNative(p.tokenIn) ? NATIVE_SENTINEL : p.tokenIn;
  const outAddr = isNative(p.tokenOut) ? NATIVE_SENTINEL : p.tokenOut;
  const slipPct = (p.slippageBps / 100).toString();

  // OpenOcean v3 expects `amount` in DECIMAL (human) units, not wei. We need the input
  // token's decimals to convert. To avoid an extra RPC call we look up by token list first
  // and fall back to reading decimals() on chain.
  const inDecimals = await readDecimalsBestEffort(p, inAddr);
  const amountHuman = formatUnitsBig(p.amountIn, inDecimals);
  const url = `https://open-api.openocean.finance/v3/${p.profile.chainId}/swap_quote`;
  const params = new URLSearchParams({
    inTokenAddress: inAddr,
    outTokenAddress: outAddr,
    amount: amountHuman,
    gasPrice: "5",
    slippage: slipPct,
    account: p.from,
  });
  logger.debug(`OpenOcean GET ${url}?${params}`);
  const res = await fetchWithTimeout(`${url}?${params}`, undefined, { retries: 2 });
  if (!res.ok) {
    throw new ToolError("AGGREGATOR_FAILED", `OpenOcean ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    code: number;
    data?: {
      inAmount: string;
      outAmount: string;
      minOutAmount: string;
      to: string;
      data: string;
      value: string;
      estimatedGas?: string;
    };
    error?: string;
  };
  if (body.code !== 200 || !body.data) {
    throw new ToolError("AGGREGATOR_FAILED", `OpenOcean: ${body.error || "no data"}`);
  }
  return {
    provider: "openocean",
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    amountIn: BigInt(body.data.inAmount),
    amountOut: BigInt(body.data.outAmount),
    amountOutMinimum: BigInt(body.data.minOutAmount),
    allowanceTarget: body.data.to as Address,
    to: body.data.to as Address,
    data: body.data.data as `0x${string}`,
    value: BigInt(body.data.value || "0"),
    gas: body.data.estimatedGas ? BigInt(body.data.estimatedGas) : undefined,
  };
}

// ── 0x v2 (optional, requires API key) ──────────────────────

async function quoteFromZeroEx(p: QuoteParams, apiKey: string, logger: Logger): Promise<AggregatorQuote> {
  const sellToken = isNative(p.tokenIn) ? "ETH" : p.tokenIn;
  const buyToken = isNative(p.tokenOut) ? "ETH" : p.tokenOut;
  const url = "https://api.0x.org/swap/permit2/quote";
  const params = new URLSearchParams({
    chainId: p.profile.chainId.toString(),
    sellToken,
    buyToken,
    sellAmount: p.amountIn.toString(),
    taker: p.from,
    slippageBps: p.slippageBps.toString(),
  });
  logger.debug(`0x GET ${url}?${params}`);
  const res = await fetchWithTimeout(
    `${url}?${params}`,
    { headers: { "0x-api-key": apiKey, "0x-version": "v2" } },
    { retries: 2 },
  );
  if (!res.ok) {
    // Iter285: distinguish auth failures from generic upstream errors. Pre-iter285
    // a wrong/expired 0x API key showed up as `AGGREGATOR_FAILED: 0x 401 Unauthorized`
    // with no hint that the key was the problem; operators thought 0x was down and
    // tried again later. 401/403 deserve a specific message + recovery hint pointing
    // at the config path holding the key.
    if (res.status === 401 || res.status === 403) {
      throw new ToolError(
        "AGGREGATOR_FAILED",
        `0x rejected the API key (${res.status} ${res.statusText}). Update aggregator.apiKeys."0x" via \`tradekit config set aggregator.apiKeys."0x" YOUR_KEY\`, or remove it to fall back to kyberswap/openocean.`,
      );
    }
    throw new ToolError("AGGREGATOR_FAILED", `0x ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    transaction?: { to: string; data: string; value: string; gas?: string };
    buyAmount?: string;
    sellAmount?: string;
    minBuyAmount?: string;
    issues?: { allowance?: { spender: string } };
    liquidityAvailable?: boolean;
  };
  if (body.liquidityAvailable === false || !body.transaction || !body.buyAmount) {
    // Iter390: same actionable hint as the kyberswap branch above.
    throw new ToolError(
      "INSUFFICIENT_LIQUIDITY",
      "0x: no liquidity for this pair",
      {
        nextActions: [
          { tool: "quote", reason: "Try a smaller amount — illiquid pairs often only quote up to a threshold." },
          { tool: "quote", reason: "Try a different quote token (e.g., route through USDC or WETH) — liquidity tends to concentrate on major pairs." },
        ],
      },
    );
  }
  return {
    provider: "0x",
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    amountIn: BigInt(body.sellAmount!),
    amountOut: BigInt(body.buyAmount),
    amountOutMinimum: BigInt(body.minBuyAmount ?? body.buyAmount),
    allowanceTarget: (body.issues?.allowance?.spender ?? body.transaction.to) as Address,
    to: body.transaction.to as Address,
    data: body.transaction.data as `0x${string}`,
    value: BigInt(body.transaction.value || "0"),
    gas: body.transaction.gas ? BigInt(body.transaction.gas) : undefined,
  };
}

// ── 1inch v6 (optional, requires API key) ────────────────────

async function quoteFromOneInch(p: QuoteParams, apiKey: string, logger: Logger): Promise<AggregatorQuote> {
  const inAddr = isNative(p.tokenIn) ? NATIVE_SENTINEL : p.tokenIn;
  const outAddr = isNative(p.tokenOut) ? NATIVE_SENTINEL : p.tokenOut;
  const url = `https://api.1inch.dev/swap/v6.0/${p.profile.chainId}/swap`;
  const params = new URLSearchParams({
    src: inAddr,
    dst: outAddr,
    amount: p.amountIn.toString(),
    from: p.from,
    slippage: (p.slippageBps / 100).toString(),
    disableEstimate: "true",
  });
  logger.debug(`1inch GET ${url}?${params}`);
  const res = await fetchWithTimeout(
    `${url}?${params}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    { retries: 2 },
  );
  if (!res.ok) {
    // Iter285: same auth-vs-generic distinction as the 0x path. A bad/expired Bearer
    // token surfaces with a 401 from 1inch — make the recovery hint point at the
    // right config key.
    if (res.status === 401 || res.status === 403) {
      throw new ToolError(
        "AGGREGATOR_FAILED",
        `1inch rejected the API key (${res.status} ${res.statusText}). Update aggregator.apiKeys."1inch" via \`tradekit config set aggregator.apiKeys."1inch" YOUR_KEY\`, or remove it to fall back to kyberswap/openocean.`,
      );
    }
    throw new ToolError("AGGREGATOR_FAILED", `1inch ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    dstAmount?: string;
    tx?: { to: string; data: string; value: string; gas?: number };
  };
  if (!body.tx || !body.dstAmount) {
    throw new ToolError("AGGREGATOR_FAILED", "1inch: malformed response");
  }
  const amountOut = BigInt(body.dstAmount);
  const slipBps = BigInt(p.slippageBps);
  const amountOutMinimum = amountOut - (amountOut * slipBps) / 10000n;
  return {
    provider: "1inch",
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    amountIn: p.amountIn,
    amountOut,
    amountOutMinimum,
    allowanceTarget: body.tx.to as Address,
    to: body.tx.to as Address,
    data: body.tx.data as `0x${string}`,
    value: BigInt(body.tx.value || "0"),
    gas: body.tx.gas ? BigInt(body.tx.gas) : undefined,
  };
}

// ── top-level dispatch ───────────────────────────────────────

export type ProviderName = "kyberswap" | "openocean" | "0x" | "1inch";

const DEFAULT_ORDER: ProviderName[] = ["kyberswap", "openocean", "0x", "1inch"];

/**
 * Resolve the final attempt order: user-preferred providers first, then the built-in
 * default order, dedup'd by first occurrence (so preferred items keep their priority),
 * with the `exclude` set filtered out (used by the simulation-revert retry loop to
 * avoid re-quoting from a provider that just produced a bad quote).
 *
 * Exported so the resolution rules are unit-testable independently of any HTTP work.
 */
export function resolveAggregatorOrder(
  preferred: ProviderName[],
  exclude: ProviderName[] = [],
): ProviderName[] {
  const excludeSet = new Set(exclude);
  return [...preferred, ...DEFAULT_ORDER].filter(
    (v, i, a) => a.indexOf(v) === i && !excludeSet.has(v),
  );
}

/**
 * Iter602: dispatch a single provider quote. Centralizes the per-provider switch
 * (including API-key gating for the paid providers) so both `aggregateQuote` (mode
 * "first", sequential) and `aggregateQuoteBest` (mode "best", parallel race) share
 * one code path. Throws if the provider is configured but its API key is missing —
 * the caller decides whether that's fatal (sequential: skip + continue) or counted
 * as a failed candidate (parallel: include in alternatives + don't pick).
 */
async function quoteFromProvider(
  provider: ProviderName,
  p: QuoteParams,
  config: Config,
  logger: Logger,
): Promise<AggregatorQuote> {
  const apiKeys = config.aggregator?.apiKeys ?? {};
  switch (provider) {
    case "kyberswap":
      return quoteFromKyberSwap(p, logger);
    case "openocean":
      return quoteFromOpenOcean(p, logger);
    case "0x": {
      const key = apiKeys["0x"];
      if (!key) throw new Error("0x is in preferred order but no API key configured");
      return quoteFromZeroEx(p, key, logger);
    }
    case "1inch": {
      const key = apiKeys["1inch"];
      if (!key) throw new Error("1inch is in preferred order but no API key configured");
      return quoteFromOneInch(p, key, logger);
    }
  }
}

/**
 * Try aggregators in user-configured order, returning the first successful quote.
 * Throws AGGREGATOR_FAILED with details of all attempts if every provider fails.
 *
 * `exclude` skips listed providers (used when retrying after a simulation revert).
 *
 * Iter602: when config.aggregator.mode === "best", delegates to aggregateQuoteBest
 * for a parallel race + best-price pick. Default mode "first" preserves the
 * pre-iter602 behavior so existing deployments don't see a behavior change without
 * opting in via config.
 */
export async function aggregateQuote(
  p: QuoteParams,
  config: Config,
  logger: Logger,
  exclude: ProviderName[] = [],
): Promise<AggregatorQuote> {
  if (config.aggregator?.mode === "best") {
    return aggregateQuoteBest(p, config, logger, exclude);
  }
  const preferred = (config.aggregator?.preferred ?? []) as ProviderName[];
  const order = resolveAggregatorOrder(preferred, exclude);

  const apiKeys = config.aggregator?.apiKeys ?? {};
  const errors: { provider: string; message: string }[] = [];

  for (const provider of order) {
    // API-key gate: skip silently when the user hasn't configured a key for a paid
    // provider. quoteFromProvider would throw a clear error, but for the sequential
    // path "skip + continue" is the more useful semantic — pre-iter602 the inline
    // continue did this; preserve that here so the loop falls through to the next
    // candidate without polluting `errors[]` with a "missing key" entry.
    if ((provider === "0x" || provider === "1inch") && !apiKeys[provider]) {
      logger.debug(`Skipping ${provider}: no API key configured`);
      continue;
    }
    try {
      logger.info(`Aggregator quote via ${provider}: ${p.amountIn} ${p.tokenIn} → ${p.tokenOut}`);
      return await quoteFromProvider(provider, p, config, logger);
    } catch (e) {
      const message = (e as Error).message;
      errors.push({ provider, message });
      // Iter476: sanitize before logging (iter474 helper) — viem/HTTP multi-line.
      logger.error(sanitizeForLogLine(`Aggregator ${provider} failed: ${message}`));
    }
  }

  // Pre-iter178 the message was just "All aggregators failed" — operators (and
  // agents) had to dig into details.attempts to find out which providers were tried
  // or why. Surface the provider list AND a one-line summary of each failure inline
  // so the message is self-contained for the common 2-provider case.
  if (errors.length === 0) {
    // Order was empty — e.g. exclude={kyber, openocean} and 0x/1inch have no API keys.
    // Pre-iter178 this produced "All aggregators failed" with no hint about why nothing
    // was tried. Tell the operator exactly which path is closed.
    throw new ToolError(
      "AGGREGATOR_FAILED",
      `No aggregator available: every option was excluded${exclude.length ? ` (excluded: ${exclude.join(", ")})` : ""}${
        order.length === 0 && exclude.length === 0
          ? "; check config.aggregator.preferred or set 0x/1inch API keys"
          : ""
      }.`,
      { details: { excluded: exclude, configuredPreferred: preferred } },
    );
  }
  const summary = errors.map((e) => `${e.provider}: ${compactMessage(e.message, 60)}`).join("; ");
  throw new ToolError(
    "AGGREGATOR_FAILED",
    `All aggregators failed (${errors.length} tried). ${summary}`,
    { details: { attempts: errors } },
  );
}

/**
 * Iter602: pure winner-selection + alternatives helper. Split out from
 * aggregateQuoteBest so the ranking logic (sort by amountOut, tie-break by
 * preferred order, bps-math) is unit-testable without going through real HTTP.
 *
 * `eligibleOrder` is used for deterministic tie-breaking: when two providers
 * return the exact same amountOut, prefer the one that appears earlier in the
 * eligible order — matches what the sequential ("first") mode would have picked.
 *
 * Returns the winner quote (with `alternatives[]` attached) plus the list of
 * losers in case the caller wants to log a summary. On all-failures, returns
 * null so the caller can throw AGGREGATOR_FAILED with the right message.
 */
export function pickBestQuote(
  successes: { provider: ProviderName; quote: AggregatorQuote }[],
  failures: { provider: ProviderName; message: string }[],
  eligibleOrder: ProviderName[],
): { winner: AggregatorQuote; loserSummary: string } | null {
  if (successes.length === 0) return null;
  // Sort by descending amountOut; on ties prefer earlier-in-order provider.
  const sorted = [...successes].sort((a, b) => {
    if (b.quote.amountOut !== a.quote.amountOut) {
      return b.quote.amountOut > a.quote.amountOut ? 1 : -1;
    }
    return eligibleOrder.indexOf(a.provider) - eligibleOrder.indexOf(b.provider);
  });
  const winner = sorted[0];
  const winnerAmount = winner.quote.amountOut;

  const alternatives: NonNullable<AggregatorQuote["alternatives"]> = [];
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    // bps = (winner - alt) / winner * 10000. Use bigint math to avoid float
    // error on 18-decimal amounts. Guard against winnerAmount=0 (degenerate).
    const diff = winnerAmount - s.quote.amountOut;
    const bps = winnerAmount > 0n ? Number((diff * 10000n) / winnerAmount) : 0;
    alternatives.push({
      provider: s.provider,
      status: "ok",
      amountOut: s.quote.amountOut,
      bpsBehindWinner: bps,
    });
  }
  for (const f of failures) {
    alternatives.push({ provider: f.provider, status: "error", message: f.message });
  }

  const loserSummary = alternatives
    .map((a) => (a.status === "ok" ? `${a.provider} -${a.bpsBehindWinner}bps` : `${a.provider} ERR`))
    .join(", ");

  return { winner: { ...winner.quote, alternatives }, loserSummary };
}

/**
 * Iter602: race every eligible provider in parallel via Promise.allSettled and
 * return the quote with the highest `amountOut`. The winner's `alternatives[]`
 * carries every other candidate's headline (ok → amountOut + bpsBehindWinner;
 * error → message) so the operator can audit the spread without re-quoting.
 *
 * Latency property: total time = max(provider latency), vs sum-of-attempts in
 * mode="first". On a normal pair where every provider succeeds, the race is the
 * latency of the slowest provider (~500ms on average); the sequential path would
 * still only hit one provider so it's faster in the happy case. The "best" mode
 * pays for parallelism with extra HTTP traffic — the win is on volatile / thin
 * liquidity pairs where the price spread is material (sometimes >100 bps on
 * obscure pairs).
 *
 * Eligibility: same as aggregateQuote — providers in `preferred` order, minus
 * `exclude`, minus paid providers (0x / 1inch) without an API key. If zero
 * eligible providers, throws AGGREGATOR_FAILED with the "no aggregator
 * available" message (parity with the sequential path's empty-order branch).
 */
export async function aggregateQuoteBest(
  p: QuoteParams,
  config: Config,
  logger: Logger,
  exclude: ProviderName[] = [],
): Promise<AggregatorQuote> {
  const preferred = (config.aggregator?.preferred ?? []) as ProviderName[];
  const order = resolveAggregatorOrder(preferred, exclude);
  const apiKeys = config.aggregator?.apiKeys ?? {};
  // Filter to eligible providers (paid providers with no key are silently skipped,
  // same semantic as the sequential path).
  const eligible = order.filter((provider) => {
    if ((provider === "0x" || provider === "1inch") && !apiKeys[provider]) {
      logger.debug(`Skipping ${provider}: no API key configured`);
      return false;
    }
    return true;
  });
  if (eligible.length === 0) {
    throw new ToolError(
      "AGGREGATOR_FAILED",
      `No aggregator available: every option was excluded${exclude.length ? ` (excluded: ${exclude.join(", ")})` : ""}${
        order.length === 0 && exclude.length === 0
          ? "; check config.aggregator.preferred or set 0x/1inch API keys"
          : ""
      }.`,
      { details: { excluded: exclude, configuredPreferred: preferred } },
    );
  }

  logger.info(
    `Aggregator best-of-${eligible.length} race (${eligible.join(", ")}): ${p.amountIn} ${p.tokenIn} → ${p.tokenOut}`,
  );

  // Race every eligible provider in parallel. Promise.allSettled never rejects so
  // we always get back a per-provider outcome — winners get their quote, losers
  // surface their error. This is the parallel cousin of the sequential loop's
  // try/catch — same per-provider isolation.
  const settled = await Promise.allSettled(
    eligible.map((provider) =>
      quoteFromProvider(provider, p, config, logger).then((quote) => ({ provider, quote })),
    ),
  );

  // Partition into ok / err so we can pick the winner from ok and report err in
  // alternatives.
  const successes: { provider: ProviderName; quote: AggregatorQuote }[] = [];
  const failures: { provider: ProviderName; message: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const provider = eligible[i];
    if (outcome.status === "fulfilled") {
      successes.push({ provider, quote: outcome.value.quote });
    } else {
      const message = (outcome.reason as Error)?.message ?? String(outcome.reason);
      failures.push({ provider, message });
      logger.error(sanitizeForLogLine(`Aggregator ${provider} failed: ${message}`));
    }
  }

  const picked = pickBestQuote(successes, failures, eligible);
  if (picked === null) {
    // Every provider failed — parity with sequential's all-failed branch.
    const summary = failures.map((e) => `${e.provider}: ${compactMessage(e.message, 60)}`).join("; ");
    throw new ToolError(
      "AGGREGATOR_FAILED",
      `All aggregators failed (${failures.length} tried in parallel). ${summary}`,
      { details: { attempts: failures, mode: "best" } },
    );
  }

  if (picked.loserSummary) {
    logger.info(
      `Aggregator best-of-${eligible.length} winner: ${picked.winner.provider} (alts: ${picked.loserSummary})`,
    );
  } else {
    logger.info(`Aggregator best-of-${eligible.length} winner: ${picked.winner.provider} (only candidate)`);
  }

  return picked.winner;
}
