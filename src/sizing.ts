/**
 * v35.5 dynamic-sizing sentinels, shared by every execution layer.
 *
 * Amounts on orders / schedules / hooks / manual trades accept three
 * forms on the SPEND side (sell → baseAmount, buy → quoteAmount):
 *
 *   "1.5"   — fixed decimal, resolved at create time (classic)
 *   "max"   — the full spendable balance at FIRE time (v35)
 *   "37.5%" — that fraction of the spendable balance at FIRE time
 *
 * "Spendable" is layer-specific: on-chain balance (with the native
 * gas reserve subtracted on native sells) for real fires, the
 * virtual book for paper, the sim balance for backtests. The
 * percentage applies to the spendable amount — "100%" and "max" are
 * equivalent by construction.
 *
 * Why percentages matter: they make scale-out expressible. A
 * multi-leg bracket of `[{price_above, 50%}, {trailing, max}]` takes
 * half off at the target and trails the rest — each leg sized
 * against whatever the position IS when that leg fires.
 *
 * Pure module — no imports from the trading layers (everyone imports
 * us; we import nobody), so there is exactly one definition of what
 * a sizing sentinel means.
 */

export type SizingSentinel =
  | { kind: "max" }
  | { kind: "pct"; /** (0, 1] */ fraction: number };

const PCT_RX = /^(\d+(?:\.\d+)?)\s*%$/;

/**
 * Parse a raw amount string into a sentinel, or null when it's a
 * plain value (decimal — or garbage, which the caller's numeric
 * validation rejects). Throws nothing: invalid percentages (0%,
 * >100%) return null so the caller's "positive decimal" error
 * names the actual input.
 */
export function parseSizingSentinel(raw: string): SizingSentinel | null {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "max") return { kind: "max" };
  const m = PCT_RX.exec(trimmed);
  if (m) {
    const pct = parseFloat(m[1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
    return { kind: "pct", fraction: pct / 100 };
  }
  return null;
}

/** Is this raw amount any dynamic sentinel ("max" or a percentage)? */
export function isDynamicAmount(raw: string | null | undefined): boolean {
  return raw != null && parseSizingSentinel(raw) != null;
}

/**
 * Apply a sentinel to a bigint spendable amount. Percentages use
 * parts-per-million integer math (no float drift on 18-decimals
 * balances); "max" is identity.
 */
export function applyFractionBig(spendable: bigint, sentinel: SizingSentinel): bigint {
  if (sentinel.kind === "max") return spendable;
  const ppm = BigInt(Math.round(sentinel.fraction * 1_000_000));
  return (spendable * ppm) / 1_000_000n;
}

/** Float twin for the backtest simulator's number balances. */
export function applyFraction(spendable: number, sentinel: SizingSentinel): number {
  if (sentinel.kind === "max") return spendable;
  return spendable * sentinel.fraction;
}

/** Operator-facing description for logs ("max" / "37.5%"). */
export function describeSentinel(sentinel: SizingSentinel): string {
  return sentinel.kind === "max" ? "max" : `${(sentinel.fraction * 100).toFixed(4).replace(/\.?0+$/, "")}%`;
}
