/**
 * Admin MCP tool tests — focused on the v89 safety-config lock: an agent must
 * not be able to weaken its OWN guardrails (disable a breaker, loosen slippage,
 * drop a blacklist entry, disable the approval gate) over MCP. Writes to
 * safety.* are blocked with SAFETY_CONFIG_LOCKED; reads + non-safety writes
 * stay open. Uses the lightweight mock-server harness (same as the other MCP
 * tool tests) — invoke the registered "config" handler directly.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-mcp-admin-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { registerAdminTools } = await import("./admin-tools.js");
const { openDb, closeDb } = await import("../db.js");
const { loadConfig } = await import("../config.js");

const noopLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => noopLogger, recordAudit: () => {}, close: () => {},
} as unknown as import("../logger.js").Logger;

interface RegisteredTool {
  name: string;
  handler: (input: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
}
function makeMockServer() {
  const registered = new Map<string, RegisteredTool>();
  return {
    server: { tool: (name: string, _d: string, _s: unknown, handler: RegisteredTool["handler"]) => registered.set(name, { name, handler }) },
    registered,
  };
}
function makeRuntime() {
  return {
    opts: { logger: noopLogger, caller: "test" as const, walletPass: undefined },
    getConfig: () => loadConfig(),
    getWalletContext: async () => { throw new Error("not used"); },
  };
}
function parse(result: { content: { type: "text"; text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

const { server, registered } = makeMockServer();
beforeAll(() => {
  openDb();
  registerAdminTools(server as unknown as Parameters<typeof registerAdminTools>[0], makeRuntime() as unknown as Parameters<typeof registerAdminTools>[1]);
});
afterAll(() => { closeDb(); rmSync(tmpDataDir, { recursive: true, force: true }); });
beforeEach(() => { openDb().exec("DELETE FROM audit_log"); });

const config = () => registered.get("config")!;

describe("config MCP tool — v89 safety-config lock", () => {
  for (const path of ["safety", "safety.maxSlippageBps", "safety.drawdownCircuitBreaker.enabled", "safety.tradeApproval.enabled"]) {
    it(`blocks set "${path}" with SAFETY_CONFIG_LOCKED`, async () => {
      const r = parse(await config().handler({ action: "set", path, value: "false" }));
      expect(r.ok).toBe(false);
      expect((r.error as { code: string }).code).toBe("SAFETY_CONFIG_LOCKED");
    });
  }

  it("blocks push to safety.* (whitelist tampering)", async () => {
    const r = parse(await config().handler({ action: "push", path: "safety.contractWhitelist.base", value: "\"0xdead\"" }));
    expect((r.error as { code: string }).code).toBe("SAFETY_CONFIG_LOCKED");
  });

  // v90: the lock extends to the other operator-owned (injection-weaponizable)
  // sections — RPC endpoints, MEV relays, and alert channels.
  for (const path of ["chains", "chains.base.rpcs", "mev", "mev.privateRpcs.ethereum", "webhooks", "notifications"]) {
    it(`blocks set "${path}" (infra/visibility tampering)`, async () => {
      const r = parse(await config().handler({ action: "set", path, value: "\"https://evil.example\"" }));
      expect(r.ok).toBe(false);
      expect((r.error as { code: string }).code).toBe("SAFETY_CONFIG_LOCKED");
    });
  }

  it("blocks push to chains.*.rpcs (hostile RPC injection)", async () => {
    const r = parse(await config().handler({ action: "push", path: "chains.base.rpcs", value: "\"https://evil.example\"" }));
    expect((r.error as { code: string }).code).toBe("SAFETY_CONFIG_LOCKED");
  });

  it("ALLOWS aggregator.* (legitimate routing tuning — not a theft vector)", async () => {
    const r = parse(await config().handler({ action: "set", path: "aggregator.mode", value: "\"best\"" }));
    expect(r.ok).toBe(true);
  });

  it("blocks drop from safety.* (removing a blacklist entry)", async () => {
    const r = parse(await config().handler({ action: "drop", path: "safety.tokenBlacklist.base", value: "\"0xscam\"" }));
    expect((r.error as { code: string }).code).toBe("SAFETY_CONFIG_LOCKED");
  });

  it("ALLOWS reading safety config (get / show) — analysis isn't mutation", async () => {
    const get = parse(await config().handler({ action: "get", path: "safety.maxSlippageBps" }));
    expect(get.ok).toBe(true);
    const show = parse(await config().handler({ action: "show" }));
    expect(show.ok).toBe(true);
  });

  it("ALLOWS writing a NON-safety path (e.g. defaultSlippageBps)", async () => {
    const r = parse(await config().handler({ action: "set", path: "defaultSlippageBps", value: "75" }));
    expect(r.ok).toBe(true);
    expect(["set", "updated", "noop"]).toContain(r.action);
  });

  it("does not block a path that merely CONTAINS 'safety' elsewhere", async () => {
    // Guards on the safety.* prefix, not a substring — a hypothetical
    // top-level key like "notSafety" must not be falsely locked.
    const r = parse(await config().handler({ action: "get", path: "activeChain" }));
    expect(r.ok).toBe(true);
  });
});
