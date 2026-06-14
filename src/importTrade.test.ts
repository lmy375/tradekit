// Tests for classify() — the heuristic that converts a decoded on-chain tx into
// a PnL-trackable trade row. Hits all four branches: stable→non-stable buy,
// non-stable→stable sell, pure transfer-out, incoming-only (airdrop).

import { describe, it, expect, vi } from "vitest";
// v108: mock historical pricing so importValueUsd's non-stablecoin branch is
// deterministic + offline. WETH prices at $2000; everything else is unpriceable.
vi.mock("./price.js", () => ({
  getHistoricalPrice: vi.fn(async (addr: string) => (addr.toLowerCase() === "0xweth" ? 2000 : null)),
}));
import { classify, importValueUsd } from "./importTrade.js";
import type { DecodedTx, TokenMove } from "./decodeTx.js";
import type { TradeRow } from "./db.js";
import type { ChainProfile } from "./chains.js";
import type { Logger } from "./logger.js";

const HASH = "0xaaaa";
const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
// Iter243: classify() now takes the timestamp as an explicit arg (block timestamp for
// historical imports, now() for live). Locked-down value so tests are deterministic.
const TS = "2026-01-15T12:34:56.000Z";

function move(symbol: string, delta: bigint, decimals = 18, token = symbol === "ETH" ? "NATIVE" : TOKEN_A): TokenMove {
  const abs = delta < 0n ? -delta : delta;
  const sign = delta < 0n ? "-" : "+";
  return {
    delta,
    amount: sign + (Number(abs) / 10 ** decimals).toString(),
    symbol,
    decimals,
    token: token as TokenMove["token"],
  };
}

function decoded(moves: TokenMove[]): DecodedTx {
  return { hash: HASH, status: "success", from: "0xuser", to: null, nativeValue: "0", moves };
}

describe("classify (importTrade)", () => {
  it("USDC out + non-stable in → buy (stable side = quote)", () => {
    const d = decoded([move("USDC", -10_000_000n, 6), move("XYZ", 1_000_000_000_000_000_000n, 18, TOKEN_B)]);
    const r = classify(d, "base", "alice", TS);
    if ("skip" in r) throw new Error("expected a trade, got skip: " + r.skip);
    expect(r.direction).toBe("buy");
    expect(r.base_symbol).toBe("XYZ");
    expect(r.quote_symbol).toBe("USDC");
    expect(r.aggregator).not.toBe("transfer");
    expect(r.tx_hash).toBe(HASH);
  });

  it("non-stable out + USDC in → sell", () => {
    const d = decoded([
      move("XYZ", -1_000_000_000_000_000_000n, 18, TOKEN_B),
      move("USDC", 10_000_000n, 6),
    ]);
    const r = classify(d, "base", "alice", TS);
    if ("skip" in r) throw new Error("unexpected skip");
    expect(r.direction).toBe("sell");
    expect(r.base_symbol).toBe("XYZ");
    expect(r.quote_symbol).toBe("USDC");
  });

  it("only debits (outbound transfer) → sell with aggregator=transfer", () => {
    const d = decoded([move("USDC", -10_000_000n, 6)]);
    const r = classify(d, "base", "alice", TS);
    if ("skip" in r) throw new Error("unexpected skip");
    expect(r.direction).toBe("sell");
    expect(r.aggregator).toBe("transfer");
    expect(r.base_symbol).toBe("USDC");
    expect(r.quote_amount).toBe("0");
  });

  it("only credits (airdrop/claim) → buy with aggregator=incoming", () => {
    const d = decoded([move("DROP", 1_000_000_000_000_000_000n, 18, TOKEN_B)]);
    const r = classify(d, "base", "alice", TS);
    if ("skip" in r) throw new Error("unexpected skip");
    expect(r.direction).toBe("buy");
    expect(r.aggregator).toBe("incoming");
    expect(r.quote_amount).toBe("0");
  });

  it("no movements → skip", () => {
    const d = decoded([]);
    const r = classify(d, "base", "alice", TS);
    expect("skip" in r ? r.skip : null).toMatch(/no token movements/);
  });

  it("stamps the row with the caller-supplied timestamp (iter243 — block time on historical imports)", () => {
    // Regression for iter243: pre-iter243 classify hard-coded `new Date()` inside, so
    // importing a 6-month-old transaction landed it under today's date in PnL/history.
    // Now the caller is responsible for the timestamp.
    const d = decoded([move("USDC", -10n, 6), move("XYZ", 1n, 18, TOKEN_B)]);
    const r = classify(d, "base", "alice", "2025-08-01T00:00:00Z") as { timestamp: string };
    expect(r.timestamp).toBe("2025-08-01T00:00:00Z");
  });

  it("preserves chain + account on the row", () => {
    const d = decoded([move("USDC", -10n, 6), move("XYZ", 1n, 18, TOKEN_B)]);
    const r = classify(d, "arbitrum", "bob", TS) as { chain: string; account: string; timestamp: string };
    expect(r.chain).toBe("arbitrum");
    expect(r.account).toBe("bob");
    expect(r.timestamp).toBe(TS);
  });
});

// v108: imported / `trades sync`-backfilled rows get a trade-time value_usd so
// their P&L + tax + budgets match live trades (not the current-price approximation).
describe("importValueUsd (v108)", () => {
  const profile = { weth: "0xWETH" } as unknown as ChainProfile;
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
  const row = (over: Partial<TradeRow>): TradeRow =>
    ({ quote_symbol: "USDC", quote_amount: "100", quote_token: "0xq", timestamp: TS, direction: "buy", base_amount: "1", ...over } as TradeRow);

  it("stablecoin quote → $1 × amount, NO network call", async () => {
    const v = await importValueUsd(row({ quote_symbol: "USDC", quote_amount: "250" }), profile, logger);
    expect(v).toBe(250);
  });

  it("non-stablecoin quote → amount × historical quote price", async () => {
    // 0.5 WETH @ historical $2000 → $1000.
    const v = await importValueUsd(row({ quote_symbol: "WETH", quote_token: "0xWETH", quote_amount: "0.5" }), profile, logger);
    expect(v).toBe(1000);
  });

  it("native quote (empty token) prices via WETH", async () => {
    const v = await importValueUsd(row({ quote_symbol: "ETH", quote_token: "", quote_amount: "0.5" }), profile, logger);
    expect(v).toBe(1000); // priced through profile.weth
  });

  it("unpriceable non-stablecoin quote → null (fallback to approximation)", async () => {
    const v = await importValueUsd(row({ quote_symbol: "PEPE", quote_token: "0xunknown", quote_amount: "100" }), profile, logger);
    expect(v).toBeNull();
  });

  it("zero/airdrop quote amount → null (no cost basis)", async () => {
    const v = await importValueUsd(row({ quote_symbol: "USDC", quote_amount: "0" }), profile, logger);
    expect(v).toBeNull();
  });
});
