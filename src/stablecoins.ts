/**
 * The ONE stablecoin registry (v85).
 *
 * USD-pegged quote tokens are valued at $1 for deterministic P&L / tax / trade
 * classification across every surface. But each surface had its OWN inline
 * isStablecoin with a DIFFERENT list, so the same trade could be valued on one
 * surface and skipped on another:
 *   - pnl / tradeExport / aggregatorStats / pairStats / importTrade recognized
 *     BUSD, USDP, TUSD — but paperPnl did NOT.
 *   - paperPnl recognized USDBC, LUSD, GUSD, USDS — but the others did NOT.
 * So an LUSD-quoted trade was $1 in the paper book yet UNPRICED in the real PnL
 * and tax export; a BUSD-quoted trade the reverse. Same class of cross-surface
 * drift the cost-basis unification (v71/v82) killed — here it was live.
 *
 * This is the UNION of every prior list (all are genuine USD stablecoins),
 * defined once so the surfaces can no longer disagree on what a dollar is.
 * Symbols are compared upper-cased; "USDC.e" / "USDC.E" both match.
 */
export const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set([
  "USDC",
  "USDC.E", // bridged USDC (Arbitrum/Optimism/etc.)
  "USDT",
  "DAI",
  "BUSD", // Binance USD (deprecated, historically $1)
  "FRAX",
  "USDP", // Pax Dollar
  "TUSD", // TrueUSD
  "USDBC", // USD Base Coin
  "LUSD", // Liquity USD
  "GUSD", // Gemini Dollar
  "USDS", // Sky/Maker USDS
]);

/** True when `symbol` is a recognized USD stablecoin (≈ $1 quote). Case-insensitive. */
export function isStablecoin(symbol: string | null | undefined): boolean {
  return symbol != null && symbol !== "" && STABLECOIN_SYMBOLS.has(symbol.toUpperCase());
}
