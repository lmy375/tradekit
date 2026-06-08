import {
  formatEther,
  formatUnits,
  type Address,
  type PublicClient,
  type Transport,
  type Chain,
  type Hex,
  type Log,
} from "viem";
import { getToken } from "./tokens.js";
import type { ChainProfile } from "./chains.js";

/** ERC20 Transfer(address,address,uint256) topic0. */
const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** WETH Deposit(address,uint256) and Withdrawal(address,uint256) topics — used to detect ETH wrap/unwrap. */
const WETH_DEPOSIT_TOPIC: Hex = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const WETH_WITHDRAWAL_TOPIC: Hex = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

export interface TokenMove {
  /** Net change for the user (positive = received, negative = sent). */
  delta: bigint;
  /** Formatted decimal string with sign. */
  amount: string;
  symbol: string;
  decimals: number;
  token: Address | "NATIVE";
}

export interface CounterpartyInfo {
  /** Contract addresses that appear in `to`/`from` of relevant Transfer events. */
  contracts: Address[];
}

export interface DecodedTx {
  hash: string;
  status: "success" | "failed" | "pending";
  block?: number;
  from: Address;
  to: Address | null;
  /** Native value transferred top-level (excludes WETH wrap/unwrap inferred from logs). */
  nativeValue: string;
  /** Net token movements for `from` (the tx originator). */
  moves: TokenMove[];
  gasUsed?: string;
  effectiveGasPriceGwei?: string;
  /** Total gas in native (gasUsed × effectiveGasPrice / 1e18). Decimal string. */
  gasCostNative?: string;
  explorerUrl?: string;
  /** Inferred summary string — "swapped 0.001 ETH → 2.073 USDC" or similar. Empty if no swap pattern. */
  summary?: string;
}

function topicToAddress(topic: Hex): Address {
  // topics are 32-byte; address is the low 20 bytes
  return ("0x" + topic.slice(-40)) as Address;
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function fmtSigned(delta: bigint, decimals: number): string {
  const s = formatUnits(delta < 0n ? -delta : delta, decimals);
  return (delta >= 0n ? "+" : "-") + s;
}

/**
 * Pure: from a list of logs + the user's address + the tx's top-level value, compute
 * the user's net delta per token address (lowercased). "NATIVE" is the sentinel key
 * for the chain's native asset. WETH Withdrawal events credit native when the burner
 * is the user (router-on-behalf-of cases are skipped — see the comment in decodeTx).
 *
 * Extracted from decodeTx so the log-walking heuristic can be unit-tested without an
 * RPC mock. decodeTx still owns metadata resolution + the final formatting.
 */
export function computeDeltasFromLogs(args: {
  fromAddress: Address;
  txValue: bigint;
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[];
  wethAddress: Address;
}): Map<string, bigint> {
  const { fromAddress, txValue, logs, wethAddress } = args;
  const deltas = new Map<string, bigint>();
  const user = fromAddress.toLowerCase();
  const wethLc = wethAddress.toLowerCase();

  if (txValue > 0n) {
    deltas.set("NATIVE", (deltas.get("NATIVE") ?? 0n) - txValue);
  }

  for (const log of logs) {
    if (!log.topics || log.topics.length === 0) continue;
    const topic0 = log.topics[0];

    if (topic0 === TRANSFER_TOPIC && log.topics.length >= 3 && log.data) {
      const from = topicToAddress(log.topics[1]);
      const to = topicToAddress(log.topics[2]);
      const value = BigInt(log.data);
      const tokenLc = log.address.toLowerCase();
      if (from.toLowerCase() === user) {
        deltas.set(tokenLc, (deltas.get(tokenLc) ?? 0n) - value);
      }
      if (to.toLowerCase() === user) {
        deltas.set(tokenLc, (deltas.get(tokenLc) ?? 0n) + value);
      }
    } else if (
      topic0 === WETH_WITHDRAWAL_TOPIC &&
      log.address.toLowerCase() === wethLc &&
      log.topics.length >= 2 &&
      log.data
    ) {
      // User unwrapped WETH → gets native back. (Router-on-behalf-of unwraps are
      // ignored here because we'd need a balance diff to infer them.)
      const src = topicToAddress(log.topics[1]);
      if (src.toLowerCase() === user) {
        const value = BigInt(log.data);
        deltas.set("NATIVE", (deltas.get("NATIVE") ?? 0n) + value);
      }
    }
    // WETH Deposit is informational — the corresponding Transfer event already adjusts
    // the user's WETH balance, and the ETH was debited via tx.value (or by a router
    // call that took the ETH from them).
  }

  return deltas;
}

/**
 * Decode a tx's logs into net token movements for the originator.
 *
 * Strategy: filter Transfer events; for each, if `to == user` add value, if `from == user` subtract.
 * WETH Deposit/Withdrawal are normalised to native ETH so a wrap+swap reads as ETH-out, not WETH-out.
 */
export async function decodeTx(
  publicClient: PublicClient<Transport, Chain>,
  profile: ChainProfile,
  txHash: Hex,
  /**
   * If the caller already has the receipt in hand (trade.ts after waitForReceipt),
   * pass it to skip one RPC roundtrip on the post-trade decode path. The tx fetch
   * still runs because we need tx.from / tx.value / tx.to.
   */
  prefetchedReceipt?: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>,
): Promise<DecodedTx> {
  // tx + receipt are independent reads — parallelize so we don't add a roundtrip just
  // to find out the tx is still pending. getTransactionReceipt throws when the tx isn't
  // mined yet; we treat that as "pending" via `.catch(() => undefined)`.
  const [tx, receipt] = await Promise.all([
    publicClient.getTransaction({ hash: txHash }),
    prefetchedReceipt
      ? Promise.resolve(prefetchedReceipt as Awaited<ReturnType<typeof publicClient.getTransactionReceipt>> | undefined)
      : publicClient.getTransactionReceipt({ hash: txHash }).catch(() => undefined),
  ]);

  if (!receipt) {
    return {
      hash: txHash,
      status: "pending",
      from: tx.from,
      to: tx.to,
      nativeValue: formatEther(tx.value),
      moves: [],
      explorerUrl: profile.explorer ? `${profile.explorer}/tx/${txHash}` : undefined,
    };
  }

  const user = tx.from;
  const deltas = computeDeltasFromLogs({
    fromAddress: user,
    txValue: tx.value,
    logs: (receipt.logs as Log[]).map((l) => ({
      address: l.address,
      topics: (l.topics ?? []) as Hex[],
      data: (l.data ?? "0x") as Hex,
    })),
    wethAddress: profile.weth,
  });

  // Resolve metadata for each ERC20 token that moved. Run getToken in parallel — a
  // typical swap touches 2 ERC20s (in + out); the iter81 in-flight dedup means if
  // executeTrade already fetched them this is free.
  const erc20Entries = [...deltas.entries()].filter(([k, d]) => k !== "NATIVE" && d !== 0n);
  const erc20Metas = await Promise.all(
    erc20Entries.map(([k]) =>
      getToken(publicClient, profile, k as Address).catch(() => null),
    ),
  );
  const moves: TokenMove[] = [];
  // Native first (no metadata read needed).
  const nativeDelta = deltas.get("NATIVE") ?? 0n;
  if (nativeDelta !== 0n) {
    moves.push({
      delta: nativeDelta,
      amount: fmtSigned(nativeDelta, 18),
      symbol: profile.nativeSymbol,
      decimals: 18,
      token: "NATIVE",
    });
  }
  erc20Entries.forEach(([key, delta], i) => {
    const meta = erc20Metas[i];
    if (meta) {
      moves.push({
        delta,
        amount: fmtSigned(delta, meta.decimals),
        symbol: meta.symbol,
        decimals: meta.decimals,
        token: meta.address,
      });
    } else {
      moves.push({
        delta,
        amount: fmtSigned(delta, 18),
        symbol: key.slice(0, 8),
        decimals: 18,
        token: key as Address,
      });
    }
  });

  // Sort: incoming (positive) first, descending in absolute size
  moves.sort((a, b) => {
    const av = a.delta < 0n ? -a.delta : a.delta;
    const bv = b.delta < 0n ? -b.delta : b.delta;
    if ((a.delta > 0n) !== (b.delta > 0n)) return a.delta > 0n ? -1 : 1;
    return bv > av ? 1 : -1;
  });

  // Build a one-line summary if it looks like a swap (one debit + one credit, ignoring WETH dust)
  const debits = moves.filter((m) => m.delta < 0n);
  const credits = moves.filter((m) => m.delta > 0n);
  let summary: string | undefined;
  if (debits.length >= 1 && credits.length >= 1) {
    const main_out = debits[0];
    const main_in = credits[0];
    summary = `swapped ${main_out.amount.replace(/^-/, "")} ${main_out.symbol} → ${main_in.amount.replace(/^\+/, "")} ${main_in.symbol}`;
  }

  return {
    hash: txHash,
    status: receipt.status === "success" ? "success" : "failed",
    block: Number(receipt.blockNumber),
    from: tx.from,
    to: tx.to,
    nativeValue: formatEther(tx.value),
    moves,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceGwei: receipt.effectiveGasPrice ? formatUnits(receipt.effectiveGasPrice, 9) : undefined,
    gasCostNative: receipt.effectiveGasPrice
      ? formatEther(receipt.gasUsed * receipt.effectiveGasPrice)
      : undefined,
    explorerUrl: profile.explorer ? `${profile.explorer}/tx/${txHash}` : undefined,
    summary,
  };
}

export function formatDecodedTx(d: DecodedTx, profile: ChainProfile): string {
  const lines: string[] = [];
  lines.push(`Tx:           ${d.hash}`);
  lines.push(`Status:       ${d.status}`);
  if (d.block != null) lines.push(`Block:        ${d.block}`);
  lines.push(`From:         ${d.from}`);
  if (d.to) lines.push(`To:           ${d.to}`);
  if (parseFloat(d.nativeValue) !== 0) {
    lines.push(`Native value: ${d.nativeValue} ${profile.nativeSymbol}`);
  }
  if (d.gasUsed) {
    const costNote = d.gasCostNative ? `  (~${d.gasCostNative} ${profile.nativeSymbol})` : "";
    lines.push(`Gas used:     ${d.gasUsed}  @ ${d.effectiveGasPriceGwei ?? "?"} gwei${costNote}`);
  }
  if (d.explorerUrl) lines.push(`Explorer:     ${d.explorerUrl}`);

  if (d.summary) {
    lines.push("");
    lines.push(`Summary:      ${d.summary}`);
  }
  if (d.moves.length > 0) {
    lines.push("");
    lines.push("Token moves:");
    for (const m of d.moves) {
      lines.push(`  ${m.amount.padStart(22)} ${m.symbol}`);
    }
  }
  return lines.join("\n");
}
