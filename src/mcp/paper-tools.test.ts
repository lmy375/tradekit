/**
 * Paper-trading MCP tool tests.
 *
 * Verifies the paper-tools surface (5 tools: paper_balances,
 * paper_trades, paper_pnl, paper_deposit, paper_reset) registers via
 * server.tool() AND each handler is wired to the right core helper.
 * Uses a lightweight mock server (same pattern as strategy-tools.test.ts)
 * that captures registered handlers so we can invoke them directly
 * without standing up a real MCP transport.
 *
 * The DB-backed tools (balances/trades/pnl/reset) run against a tmp
 * TRADEKIT_DATA_DIR. paper_deposit is exercised with the native token
 * (ETH) so getToken short-circuits to decimals=18 without an RPC call —
 * keeping the test offline + deterministic.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-mcp-paper-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

// paper_pnl mtm:true routes through defaultPaperPriceFetcher → price.js.
// Pin the oracle so the MTM tests stay offline + deterministic. The
// native sentinel is priced via the chain's WETH (Base: 0x4200…0006).
vi.mock("../price.js", () => ({
  getCurrentPrice: vi.fn(async (token: string) =>
    token.toLowerCase() === "0x4200000000000000000000000000000000000006" ? 2500 : null,
  ),
}));

const { registerPaperTools } = await import("./paper-tools.js");
const { openDb, closeDb, recordPaperTrade } = await import("../db.js");
const { setPaperBalance } = await import("../paperTrade.js");
const { loadConfig: loadConfigStatic } = await import("../config.js");

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
  recordAudit: () => {},
  close: () => {},
} as unknown as import("../logger.js").Logger;

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = openDb();
  db.exec("DELETE FROM paper_trades");
  db.exec("DELETE FROM paper_balances");
});

// ── mock MCP server ──────────────────────────────────────────

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
}

function makeMockServer(): { server: { tool: (name: string, desc: string, schema: Record<string, unknown>, handler: RegisteredTool["handler"]) => void }; registered: Map<string, RegisteredTool> } {
  const registered = new Map<string, RegisteredTool>();
  return {
    server: {
      tool: (name, description, schema, handler) => {
        registered.set(name, { name, description, schema, handler });
      },
    },
    registered,
  };
}

const activeChain = loadConfigStatic().activeChain;
const activeAccount = loadConfigStatic().activeAccount;

// Runtime mock. getContext returns a fake wallet context. paper_deposit
// reads `.label`, `.chain`, and `.publicClient` (the latter for the
// token-decimals lookup inside getToken). On Base, "ETH" resolves to
// WETH — a real ERC20 — so getToken DOES call readContract; we stub it
// to return decimals=18 / symbol="WETH" so the test stays offline and
// deterministic without a live RPC.
function makeRuntime() {
  const readContract = async (req: { functionName: string }) => {
    if (req.functionName === "decimals") return 18;
    if (req.functionName === "symbol") return "WETH";
    if (req.functionName === "name") return "Wrapped Ether";
    throw new Error(`unexpected readContract: ${req.functionName}`);
  };
  return {
    opts: { logger: noopLogger, caller: "test" as const, walletPass: undefined },
    getConfig: () => loadConfigStatic(),
    getContext: async (_chain?: string, _account?: string) => ({
      label: activeAccount,
      chain: activeChain,
      account: { address: "0x0000000000000000000000000000000000000001" },
      publicClient: { readContract } as never,
    }),
    invalidateContextCache: () => {},
  };
}

function parseResult(result: { content: { type: "text"; text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

function seedTrade(over: Partial<Parameters<typeof recordPaperTrade>[0]> = {}): number {
  return recordPaperTrade({
    timestamp: new Date().toISOString(),
    source_type: "order",
    source_id: 1,
    chain: activeChain,
    account: activeAccount,
    direction: "buy",
    base_token: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    base_symbol: "ETH",
    base_amount: "1",
    quote_token: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    quote_symbol: "USDC",
    quote_amount: "2000",
    price: "2000",
    slippage_bps: 50,
    strategy: "dca",
    notes: null,
    ...over,
  });
}

// ── registration ─────────────────────────────────────────────

describe("registerPaperTools — registration", () => {
  it("registers exactly the 5 expected tools", () => {
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const names = Array.from(registered.keys()).sort();
    expect(names).toEqual([
      "paper_balances",
      "paper_deposit",
      "paper_pnl",
      "paper_reset",
      "paper_trades",
    ]);
  });

  it("every tool has a substantive description", () => {
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    for (const t of registered.values()) {
      expect(t.description.length).toBeGreaterThan(40);
    }
  });
});

// ── paper_balances ───────────────────────────────────────────

describe("paper_balances", () => {
  it("returns empty list when book is empty", async () => {
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_balances")!.handler({});
    const p = parseResult(r) as { ok: boolean; count: number; balances: unknown[]; elapsedMs: number };
    expect(p.ok).toBe(true);
    expect(p.count).toBe(0);
    expect(p.balances).toEqual([]);
    expect(typeof p.elapsedMs).toBe("number");
  });

  it("lists seeded balances", async () => {
    setPaperBalance({ account: activeAccount, chain: activeChain, token: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 6, amount: "5000" });
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_balances")!.handler({});
    const p = parseResult(r) as { ok: boolean; count: number; balances: { balance: string }[] };
    expect(p.ok).toBe(true);
    expect(p.count).toBe(1);
    expect(p.balances[0].balance).toBe("5000");
  });
});

// ── paper_trades ─────────────────────────────────────────────

describe("paper_trades", () => {
  it("pages the fill journal", async () => {
    seedTrade();
    seedTrade({ direction: "sell", quote_amount: "2100" });
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_trades")!.handler({});
    const p = parseResult(r) as { ok: boolean; count: number; trades: { direction: string }[] };
    expect(p.ok).toBe(true);
    expect(p.count).toBe(2);
  });

  it("filters by source type", async () => {
    seedTrade({ source_type: "order" });
    seedTrade({ source_type: "schedule" });
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_trades")!.handler({ source: "schedule" });
    const p = parseResult(r) as { count: number; trades: { source_type: string }[] };
    expect(p.count).toBe(1);
    expect(p.trades[0].source_type).toBe("schedule");
  });
});

// ── paper_pnl ────────────────────────────────────────────────

describe("paper_pnl", () => {
  it("rolls up realized P&L per strategy (matches summarizePaperPnl)", async () => {
    // dca: buy 2000, sell 2100 → net +100
    seedTrade({ direction: "buy", quote_amount: "2000", strategy: "dca" });
    seedTrade({ direction: "sell", quote_amount: "2100", strategy: "dca" });
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_pnl")!.handler({});
    const p = parseResult(r) as { ok: boolean; count: number; summaries: { strategy: string; fills: number; netQuote: number }[] };
    expect(p.ok).toBe(true);
    expect(p.count).toBe(1);
    expect(p.summaries[0].strategy).toBe("dca");
    expect(p.summaries[0].fills).toBe(2);
    expect(p.summaries[0].netQuote).toBeCloseTo(100, 6);
  });

  it("folds untagged fills into (unattributed)", async () => {
    seedTrade({ strategy: null });
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_pnl")!.handler({});
    const p = parseResult(r) as { summaries: { strategy: string }[] };
    expect(p.summaries[0].strategy).toBe("(unattributed)");
  });

  it("default (no mtm) output carries NO mtm fields — backward-compatible shape", async () => {
    seedTrade({});
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const p = parseResult(await registered.get("paper_pnl")!.handler({})) as Record<string, unknown> & {
      summaries: Record<string, unknown>[];
    };
    expect(p["mtm"]).toBeUndefined();
    expect(p["timestamp"]).toBeUndefined();
    expect(p.summaries[0]["positions"]).toBeUndefined();
    expect(p.summaries[0]["unrealizedQuote"]).toBeUndefined();
  });

  it("mtm:true marks the open position at the oracle price (native via WETH)", async () => {
    // Buy 1 ETH @ 2000 USDC; mocked oracle says WETH = 2500.
    seedTrade({ direction: "buy", base_amount: "1", quote_amount: "2000", strategy: "dca" });
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_pnl")!.handler({ mtm: true });
    const p = parseResult(r) as {
      ok: boolean;
      mtm: boolean;
      timestamp: string;
      summaries: {
        strategy: string;
        netQuote: number;
        realizedQuote: number;
        unrealizedQuote: number | null;
        totalQuote: number;
        unpricedPositionCount: number;
        positions: { symbol: string | null; amount: number; avgCostQuote: number; currentPriceQuote: number | null; unrealizedQuote: number | null }[];
      }[];
    };
    expect(p.ok).toBe(true);
    expect(p.mtm).toBe(true);
    expect(typeof p.timestamp).toBe("string");
    const s = p.summaries[0];
    expect(s.strategy).toBe("dca");
    // Legacy field keeps cash-flow semantics (buy → negative).
    expect(s.netQuote).toBeCloseTo(-2000, 6);
    expect(s.realizedQuote).toBe(0);
    expect(s.unrealizedQuote).toBeCloseTo(500, 6);
    expect(s.totalQuote).toBeCloseTo(500, 6);
    expect(s.unpricedPositionCount).toBe(0);
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0].amount).toBeCloseTo(1, 9);
    expect(s.positions[0].avgCostQuote).toBeCloseTo(2000, 6);
    expect(s.positions[0].currentPriceQuote).toBe(2500);
  });

  it("mtm:true realizes cost-basis P&L on a round-trip and reports flat", async () => {
    seedTrade({ direction: "buy", base_amount: "1", quote_amount: "2000", strategy: "dca", timestamp: "2026-06-01T00:00:00.000Z" });
    seedTrade({ direction: "sell", base_amount: "1", quote_amount: "2300", strategy: "dca", timestamp: "2026-06-02T00:00:00.000Z" });
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const p = parseResult(await registered.get("paper_pnl")!.handler({ mtm: true })) as {
      summaries: { realizedQuote: number; unrealizedQuote: number | null; totalQuote: number }[];
    };
    expect(p.summaries[0].realizedQuote).toBeCloseTo(300, 6);
    expect(p.summaries[0].unrealizedQuote).toBe(0); // flat — nothing open
    expect(p.summaries[0].totalQuote).toBeCloseTo(300, 6);
  });
});

// ── paper_deposit ────────────────────────────────────────────

describe("paper_deposit", () => {
  it("credits the native token without an RPC call", async () => {
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_deposit")!.handler({ token: "ETH", amount: "5" });
    const p = parseResult(r) as { ok: boolean; mode: string; symbol: string; balance: string };
    expect(p.ok).toBe(true);
    expect(p.mode).toBe("credit");
    expect(p.balance).toBe("5");
  });

  it("credit accumulates on top of prior balance", async () => {
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    await registered.get("paper_deposit")!.handler({ token: "ETH", amount: "5" });
    const r = await registered.get("paper_deposit")!.handler({ token: "ETH", amount: "3" });
    const p = parseResult(r) as { balance: string };
    expect(p.balance).toBe("8");
  });

  it("set mode overwrites to the exact balance", async () => {
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    await registered.get("paper_deposit")!.handler({ token: "ETH", amount: "5" });
    const r = await registered.get("paper_deposit")!.handler({ token: "ETH", amount: "2", mode: "set" });
    const p = parseResult(r) as { mode: string; balance: string };
    expect(p.mode).toBe("set");
    expect(p.balance).toBe("2");
  });

  it("rejects negative amount in credit mode", async () => {
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_deposit")!.handler({ token: "ETH", amount: "-5" });
    expect(r.isError).toBe(true);
    const p = parseResult(r) as { ok: boolean; error: { code: string } };
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("INVALID_PARAMS");
  });

  it("rejects an unknown token", async () => {
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_deposit")!.handler({ token: "NOTAREALTOKEN", amount: "5" });
    expect(r.isError).toBe(true);
    const p = parseResult(r) as { error: { code: string } };
    expect(p.error.code).toBe("UNKNOWN_TOKEN");
  });
});

// ── paper_reset ──────────────────────────────────────────────

describe("paper_reset", () => {
  it("refuses without confirm:true", async () => {
    seedTrade();
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_reset")!.handler({});
    expect(r.isError).toBe(true);
    const p = parseResult(r) as { ok: boolean; error: { code: string } };
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("INVALID_PARAMS");
    // The trade must still be there — refusal is non-destructive.
    const list = await registered.get("paper_trades")!.handler({});
    expect((parseResult(list) as { count: number }).count).toBe(1);
  });

  it("wipes balances + trades with confirm:true", async () => {
    seedTrade();
    setPaperBalance({ account: activeAccount, chain: activeChain, token: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 6, amount: "5000" });
    const { server, registered } = makeMockServer();
    registerPaperTools(server as never, makeRuntime() as never);
    const r = await registered.get("paper_reset")!.handler({ confirm: true });
    const p = parseResult(r) as { ok: boolean; balancesRemoved: number; tradesRemoved: number };
    expect(p.ok).toBe(true);
    expect(p.balancesRemoved).toBe(1);
    expect(p.tradesRemoved).toBe(1);
    const list = await registered.get("paper_trades")!.handler({});
    expect((parseResult(list) as { count: number }).count).toBe(0);
  });
});
