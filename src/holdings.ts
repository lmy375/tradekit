import {
  createPublicClient,
  formatEther,
  formatUnits,
  type Address,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { getCurrentPrice } from "./price.js";
import { listChains, makeTransport, type ChainProfile } from "./chains.js";
import { getToken, readBalance } from "./tokens.js";
import type { Config } from "./config.js";
import { resolveProfile } from "./config.js";
import { ToolError, rpcFailedChainError } from "./errors.js";
import { sanitizeForLogLine, type Logger } from "./logger.js";

export interface TokenBalance {
  symbol: string;
  token: Address | "NATIVE";
  amount: string;
  decimals: number;
  usd?: number;
}

export interface ChainHoldings {
  chain: string;
  chainId: number;
  address: Address;
  /** ISO timestamp when this chain's balances were fetched — lets consumers reason
   *  about freshness and compare across chains in a multi-chain scan. */
  timestamp: string;
  balances: TokenBalance[];
  totalUsd?: number;
}

async function readOne(
  client: PublicClient<Transport, Chain>,
  profile: ChainProfile,
  owner: Address,
  token: Address,
): Promise<{ balance: bigint; decimals: number; symbol: string } | null> {
  try {
    const [balance, meta] = await Promise.all([
      readBalance(client, token, owner),
      getToken(client, profile, token),
    ]);
    return { balance, decimals: meta.decimals, symbol: meta.symbol };
  } catch {
    return null;
  }
}

/**
 * Scan an address's balances on a single chain. Includes native + the chain profile's
 * known token list. (For broader scans, an indexer like Etherscan would be required —
 * out of scope for the free tier.)
 */
export async function holdingsOnChain(
  owner: Address,
  chainName: string,
  config: Config,
  logger: Logger,
): Promise<ChainHoldings> {
  const profile = resolveProfile(chainName, config);
  const userRpcs = config.chains[chainName]?.rpcs ?? [];
  const transport = makeTransport(profile, userRpcs);
  const client = createPublicClient({ chain: profile.viemChain, transport }) as PublicClient<Transport, Chain>;

  const balances: TokenBalance[] = [];

  // Two-phase scan so we don't serialize N RPC calls and then N price calls.
  // Phase 1: read native balance + every ERC20 balance in parallel.
  // Phase 2: for tokens that actually have a non-zero balance, fetch USD prices in parallel.
  // Price fetches are gated on Phase 1 because price-of-zero-balance is wasted work.
  const erc20Targets = Object.values(profile.tokens).filter(
    (addr) => addr.toLowerCase() !== profile.weth.toLowerCase(), // WETH covered by native row
  );

  // Iter262: track WHY a read failed so we can distinguish "RPC outage" from
  // "wallet genuinely has 0". Pre-iter262 a chain-wide RPC failure produced an
  // all-zero ChainHoldings indistinguishable from an empty wallet — the chain
  // silently dropped out of formatHoldings (which skips zero-balance chains) with
  // no signal to the operator that nothing had been queried successfully.
  let nativeReadFailed = false;
  const [nativeBalance, erc20Results] = await Promise.all([
    client.getBalance({ address: owner }).catch((e) => {
      // Iter475: sanitize before logging (iter474 helper). Same reasoning as the
      // outer holdingsMultiChain catch — viem multi-line errors would otherwise
      // inject fake log entries into server.log.
      logger.error(sanitizeForLogLine(`holdings ${chainName} native error: ${(e as Error).message}`));
      nativeReadFailed = true;
      return 0n;
    }),
    Promise.all(erc20Targets.map((addr) => readOne(client, profile, owner, addr))),
  ]);
  // If the native call failed AND every ERC20 probe also failed, this is a
  // chain-wide RPC outage, not an empty wallet. Throw RPC_FAILED so the
  // holdingsMultiChain caller surfaces it in `errors[]` rather than silently
  // collapsing the chain to "0 balance everywhere".
  if (nativeReadFailed && erc20Targets.length > 0 && erc20Results.every((r) => r === null)) {
    throw rpcFailedChainError(
      chainName,
      `All RPC reads failed for ${chainName} (native + every ERC20 probe). The chain is unreachable; check connectivity or rotate to a healthy endpoint via \`tradekit doctor --chains ${chainName}\`.`,
      "balanceOf+native_batch",
      { extraDetails: { probedTokens: erc20Targets.length, reason: "all_reads_failed" } },
    );
  }

  type Pending = { symbol: string; token: string; amount: string; decimals: number; priceAddr: string };
  const pending: Pending[] = [];
  pending.push({
    symbol: profile.nativeSymbol,
    token: "NATIVE",
    amount: formatEther(nativeBalance),
    decimals: 18,
    priceAddr: profile.weth,
  });
  erc20Targets.forEach((addr, i) => {
    const res = erc20Results[i];
    if (!res || res.balance === 0n) return;
    pending.push({
      symbol: res.symbol,
      token: addr,
      amount: formatUnits(res.balance, res.decimals),
      decimals: res.decimals,
      priceAddr: addr,
    });
  });

  // Parallel price lookups; per-token errors fall through to undefined USD.
  const prices = await Promise.all(
    pending.map((p) => getCurrentPrice(p.priceAddr, logger).catch(() => null)),
  );
  pending.forEach((p, i) => {
    const price = prices[i] ?? undefined;
    balances.push({
      symbol: p.symbol,
      token: p.token as Address | "NATIVE",
      amount: p.amount,
      decimals: p.decimals,
      usd: price != null ? parseFloat(p.amount) * price : undefined,
    });
  });

  let totalUsd: number | undefined;
  for (const b of balances) {
    if (b.usd != null) totalUsd = (totalUsd ?? 0) + b.usd;
  }

  return {
    chain: profile.name,
    chainId: profile.chainId,
    address: owner,
    timestamp: new Date().toISOString(),
    balances,
    totalUsd,
  };
}

/** Scan multiple chains in parallel for the same address. */
export interface ChainHoldingsError {
  chain: string;
  message: string;
}

/**
 * Multi-chain holdings scan. Pre-iter190 a per-chain failure was silently dropped
 * from the result array; an operator with funds on a chain whose RPC was down saw
 * "no balances" with no diagnostic. The result now carries an explicit errors list
 * alongside the successful reports so callers can surface "fetched 5/6 chains".
 *
 * Default scan covers built-in chains AND any custom chains defined in config.chains
 * (iter235). Pre-iter235 the default was built-ins only, so an operator who added a
 * custom chain (zora/blast/scroll/…) ran `tradekit holdings` and silently didn't
 * see their balances on it. Same blind spot as iter231/232/233 but in a much more
 * important command — operators don't read changelogs to learn that a default skips
 * the chain they just configured. Pass an explicit `chains` array to override.
 */
export async function holdingsMultiChain(
  owner: Address,
  config: Config,
  logger: Logger,
  chains?: string[],
): Promise<{ reports: ChainHoldings[]; errors: ChainHoldingsError[] }> {
  const customChains = Object.keys(config.chains ?? {}).filter(
    (c) => !listChains().includes(c.toLowerCase()),
  );
  const targets = chains ?? [...listChains(), ...customChains];
  const results = await Promise.all(
    targets.map(async (c) => {
      try {
        return { ok: true as const, chain: c, report: await holdingsOnChain(owner, c, config, logger) };
      } catch (e) {
        const message = (e as Error).message;
        // Iter475: sanitize before logging (iter474 helper) — RPC/viem errors are
        // multi-line and would inject fake log entries into server.log otherwise.
        // The `message` field in the returned ChainHoldingsError stays raw so
        // /api/holdings consumers see the full multi-line text in their JSON.
        logger.error(sanitizeForLogLine(`holdings ${c}: ${message}`));
        return { ok: false as const, chain: c, message };
      }
    }),
  );
  const reports: ChainHoldings[] = [];
  const errors: ChainHoldingsError[] = [];
  for (const r of results) {
    if (r.ok) reports.push(r.report);
    else errors.push({ chain: r.chain, message: r.message });
  }
  return { reports, errors };
}

/**
 * Format a USD amount. Anything strictly between $0 and $0.005 prints as "<$0.01"
 * instead of "$0.00" — pre-iter123 a dust position worth $0.003 displayed as exactly
 * "$0.00", which is misleading (operators glance at it and assume the token is worthless,
 * but it's actually unpriced rounding noise — and might be many such positions summing
 * to real money in the grand total).
 */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.005) return "<$0.01";
  if (n < 0 && n > -0.005) return ">-$0.01";
  // Sign-before-dollar to match accounting convention (iter229/230). Pre-iter230 a
  // realized loss showed as "$-5.30" — non-standard for any finance display.
  if (n < 0) return `-$${Math.abs(n).toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Adaptive-precision price formatter. toFixed(4) renders sub-cent memecoin prices as
 * "$0.0000" (rounded to zero, indistinguishable from "no price"). For prices below
 * $0.01 we show enough decimals to expose at least 4 significant digits, so a token
 * at $0.0000123 prints as "$0.00001230" not "$0.0000".
 */
export function formatPrice(n: number): string {
  if (n === 0) return "$0";
  // Put the minus sign BEFORE the dollar (accounting convention) — pre-iter229 this
  // produced "$-1.50" which is non-standard and harder to scan.
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(4)}`;
  // Below 1 cent: pick a decimal count that surfaces 4 significant digits past the
  // leading zeros. log10 gives the position of the leading non-zero digit. Trim
  // unnecessary trailing zeros so $0.001 prints as "$0.001" not "$0.0010000".
  const leadingZeros = Math.floor(-Math.log10(abs));
  const decimals = Math.min(leadingZeros + 4, 18);
  const fixed = abs.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  return `${sign}$${fixed}`;
}

export function formatHoldings(
  reports: ChainHoldings[],
  opts: { minUsd?: number; lastTradeAtMap?: Map<string, string> } = {},
): string {
  const lines: string[] = [];
  let grandTotal = 0;
  let grandUnpriced = 0;
  // Iter709: count dust filtered globally so the operator sees the total
  // hidden volume — silent filtering would obscure positions that matter.
  let grandFiltered = 0;
  let grandFilteredUsd = 0;
  const minUsd = opts.minUsd;
  const lastMap = opts.lastTradeAtMap;
  for (const r of reports) {
    if (r.balances.every((b) => parseFloat(b.amount) === 0)) continue;
    lines.push(`${r.chain} (${r.chainId})`);
    let unpriced = 0;
    let filtered = 0;
    let filteredUsd = 0;
    for (const b of r.balances) {
      const amt = parseFloat(b.amount);
      if (amt === 0) continue;
      // Iter709: dust filter. Unpriced balances NEVER get filtered — operator
      // can't decide based on $0 if we don't know the value (might be valuable
      // long-tail token). Skipping only PRICED balances below threshold.
      if (minUsd != null && b.usd != null && b.usd < minUsd) {
        filtered += 1;
        filteredUsd += b.usd;
        continue;
      }
      const usd = b.usd != null ? ` (${formatUsd(b.usd)})` : "";
      if (b.usd == null) unpriced += 1;
      // Iter716: per-symbol lastTradeAt from the optional caller-provided map.
      // Tokens never traded (e.g. airdrops, deposits) get no suffix — keeps
      // the line clean. YYYY-MM-DD compact form matches iter715 accounts list.
      const last = lastMap?.get(`${r.chain}:${b.symbol.toUpperCase()}`);
      const lastBit = last ? `   last trade: ${last.slice(0, 10)}` : "";
      lines.push(`  ${b.symbol.padEnd(10)} ${b.amount}${usd}${lastBit}`);
    }
    if (r.totalUsd != null) {
      // Surface unpriced-token count alongside the subtotal so the operator knows the
      // number isn't the full picture. Pre-iter123 a long-tail token with no price
      // silently dropped out of both the subtotal and the grand total, and the
      // operator had no signal that anything was missing.
      const unpricedNote = unpriced > 0 ? `  (+${unpriced} unpriced)` : "";
      const dustNote = filtered > 0 ? `  (+${filtered} dust ${formatUsd(filteredUsd)})` : "";
      lines.push(`  Subtotal: ${formatUsd(r.totalUsd)}${unpricedNote}${dustNote}`);
      grandTotal += r.totalUsd;
    }
    grandUnpriced += unpriced;
    grandFiltered += filtered;
    grandFilteredUsd += filteredUsd;
    lines.push("");
  }
  if (lines.length === 0) {
    // Iter747: onboarding hint for the empty-state. Fresh operators (or any
    // operator on a chain where this account simply has no funds) get more
    // than "No balances found." — surface the scanned address and the
    // most-likely next actions. Address is recovered from the first report
    // (any of them — same owner across all scanned chains for a given
    // command invocation). Chain hint listed: scanning more chains catches
    // the most common case (account funded on a chain not in the current
    // --chains filter); scanning more accounts catches the second
    // (operator on the wrong active wallet).
    lines.push("No balances found.");
    const ownerAddr = reports[0]?.address;
    if (ownerAddr) {
      const chainsLabel = reports.map((r) => r.chain).join(", ");
      lines.push("");
      lines.push(`  ℹ Scanned address ${ownerAddr} on ${chainsLabel || "no chains"}.`);
      lines.push("    - To fund: send tokens to this address on a chain tradekit knows about.");
      lines.push("    - Other chains: `tradekit holdings --chains all`");
      lines.push("    - Other accounts: `tradekit holdings --accounts all`");
    }
  } else {
    const unpricedNote = grandUnpriced > 0 ? `  (+${grandUnpriced} unpriced)` : "";
    const dustNote = grandFiltered > 0 ? `  (+${grandFiltered} dust ${formatUsd(grandFilteredUsd)} filtered by --min-usd)` : "";
    lines.push(`Grand total: ${formatUsd(grandTotal)}${unpricedNote}${dustNote}`);
  }
  return lines.join("\n");
}
