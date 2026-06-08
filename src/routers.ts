import type { Address } from "viem";

/**
 * Canonical DEX aggregator and router addresses, normalized to lowercase. These
 * are protocol-deployed at the same address across most EVM chains (intentional —
 * deterministic deployment via CREATE2), so we can reason about them globally.
 *
 * Two callers consume this:
 *   - approvals.ts probes these addresses as default spenders, so `tradekit allowances`
 *     surfaces outstanding approvals to any known router.
 *   - importTrade.ts classifies a transaction's `to` address to attribute external
 *     swaps to the right aggregator (kyberswap, openocean, 1inch, etc.) in PnL.
 *
 * Keep this list authoritative: adding a router here makes both call sites pick it up.
 */
export const KNOWN_ROUTERS: { address: Address; label: string; aggregator: string }[] = [
  {
    address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address,
    label: "KyberSwap MetaAggregationRouter v2",
    aggregator: "kyberswap",
  },
  {
    address: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64" as Address,
    label: "OpenOcean Exchange v2",
    aggregator: "openocean",
  },
  {
    address: "0x6ff5693b99212da76ad316178a184ab56d299b43" as Address,
    label: "Uniswap Universal Router",
    aggregator: "uniswap-universal",
  },
  {
    // Note: Uniswap V3 SwapRouter02 is deployed at the SAME address on most chains
    // (0x2626664c… on Base) — but Ethereum uses 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45.
    // The per-chain Uniswap V3 router is also surfaced via profile.uniswapV3.swapRouter02
    // in defaultSpenders; this entry catches the cross-chain Base/Optimism/Arbitrum/Polygon
    // address for transaction-attribution purposes.
    address: "0x2626664c2603336e57b271c5c0b26f421741e481" as Address,
    label: "Uniswap V3 SwapRouter02 (Base/L2s)",
    aggregator: "uniswap-v3",
  },
  {
    address: "0x7f6cee965959295cc64d0e6c00d99d6532d8e86b" as Address,
    label: "0x v2 Settler (Base)",
    aggregator: "0x",
  },
  {
    address: "0x111111125421ca6dc452d289314280a0f8842a65" as Address,
    label: "1inch v6 Aggregator",
    aggregator: "1inch",
  },
];

/** Lowercased-address → label, for O(1) lookup in classifyAggregator etc. */
export const ROUTER_BY_ADDRESS: Map<string, { label: string; aggregator: string }> = new Map(
  KNOWN_ROUTERS.map((r) => [r.address.toLowerCase(), { label: r.label, aggregator: r.aggregator }]),
);
