// Tests for configReload.ts (iter35). Pure-ish: uses a stub loadFn
// instead of real ~/.tradekit/config.json file watching.

import { describe, it, expect, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigRef,
  buildSighupHandler,
  kickRunningEngine,
} from "./configReload.js";
import { configSchema, type Config } from "./config.js";
import type { Logger } from "./logger.js";

function silent(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    recordAudit: vi.fn(),
  } as unknown as Logger;
}

const baseCfg: Config = configSchema.parse({});

function withSafety(over: Partial<Config["safety"]>): Config {
  return configSchema.parse({
    safety: { enabled: true, maxSlippageBps: 500, allowInfiniteApprovals: false, ...over },
  });
}

// ── ConfigRef ───────────────────────────────────────────────

describe("ConfigRef", () => {
  it("returns the initial value", () => {
    const ref = new ConfigRef(baseCfg);
    expect(ref.get()).toBe(baseCfg);
  });

  it("atomically swaps", () => {
    const ref = new ConfigRef(baseCfg);
    const next = withSafety({ maxSlippageBps: 200 });
    ref.set(next);
    expect(ref.get()).toBe(next);
    expect(ref.get().safety.maxSlippageBps).toBe(200);
  });
});

// ── buildSighupHandler ──────────────────────────────────────

describe("buildSighupHandler — success path", () => {
  it("swaps the ref + emits config.reloaded notification", async () => {
    const ref = new ConfigRef(baseCfg);
    const next = withSafety({ maxSlippageBps: 300 });
    const notifyFn = vi.fn();
    const handler = buildSighupHandler({
      ref,
      logger: silent(),
      loadFn: () => next,
      notifyFn,
    });
    const r = await handler();
    expect(r.ok).toBe(true);
    expect(r.diffCount).toBe(1);
    // The handler re-parses via configSchema, so ref.get() is
    // structurally equal but not reference-equal to `next`.
    expect(ref.get()).toEqual(next);
    expect(ref.get().safety.maxSlippageBps).toBe(300);
    expect(notifyFn).toHaveBeenCalledTimes(1);
    const evt = notifyFn.mock.calls[0][0];
    expect(evt.event).toBe("config.reloaded");
  });

  it("preflights against the active state when provided", async () => {
    const ref = new ConfigRef(baseCfg);
    const next = withSafety({ maxSlippageBps: 100 });
    const notifyFn = vi.fn();
    const handler = buildSighupHandler({
      ref,
      logger: silent(),
      loadFn: () => next,
      stateProvider: () => ({
        orders: [
          {
            id: 1,
            status: "active",
            chain: "base",
            account: "default",
            side: "sell",
            trigger_type: "price_below",
            target_price_usd: 1900,
            trail_pct: null,
            water_mark_usd: null,
            base_token: "0xeth",
            base_symbol: "ETH",
            quote_token: "0xusdc",
            quote_symbol: "USDC",
            base_amount: "1",
            quote_amount: null,
            slippage_bps: 200, // exceeds new cap 100
            auto_slippage: 0,
            expires_at: null,
            strategy: null,
            note: null,
            attempts: 0,
            last_checked_at: null,
            last_checked_price: null,
            last_error_code: null,
            last_error_message: null,
            filled_at: null,
            fill_tx_hash: null,
            fill_price: null,
            fill_base_amount: null,
            fill_quote_amount: null,
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
          } as never,
        ],
      }),
      notifyFn,
    });
    const r = await handler();
    expect(r.ok).toBe(true);
    expect(r.criticalCount).toBeGreaterThan(0);
    const evt = notifyFn.mock.calls[0][0];
    expect(evt.severity).toBe("critical");
  });

  it("emits info severity when there are no warnings", async () => {
    const ref = new ConfigRef(baseCfg);
    const next = baseCfg;
    const notifyFn = vi.fn();
    const handler = buildSighupHandler({
      ref,
      logger: silent(),
      loadFn: () => next,
      notifyFn,
    });
    const r = await handler();
    expect(r.ok).toBe(true);
    expect(r.diffCount).toBe(0);
    expect(notifyFn.mock.calls[0][0].severity).toBe("info");
  });
});

describe("buildSighupHandler — failure path", () => {
  it("keeps the old config when loadFn throws", async () => {
    const ref = new ConfigRef(baseCfg);
    const notifyFn = vi.fn();
    const handler = buildSighupHandler({
      ref,
      logger: silent(),
      loadFn: () => {
        throw new Error("simulated parse failure");
      },
      notifyFn,
    });
    const r = await handler();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/parse failure/);
    expect(ref.get()).toBe(baseCfg);
    const evt = notifyFn.mock.calls[0][0];
    expect(evt.event).toBe("config.reload_failed");
    expect(evt.severity).toBe("critical");
  });

  it("keeps the old config when schema.parse rejects the new shape", async () => {
    const ref = new ConfigRef(baseCfg);
    const notifyFn = vi.fn();
    const handler = buildSighupHandler({
      ref,
      logger: silent(),
      // Return an obviously broken shape — Zod will reject.
      loadFn: () => ({ safety: { maxSlippageBps: "not-a-number" } } as never),
      notifyFn,
    });
    const r = await handler();
    expect(r.ok).toBe(false);
    expect(ref.get()).toBe(baseCfg);
  });
});

// ── kickRunningEngine ───────────────────────────────────────

describe("kickRunningEngine", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "tradekit-cfg-reload-test-"));

  function writeStatus(pid: number) {
    const path = join(tmpDir, "status.json");
    writeFileSync(path, JSON.stringify({ pid, startedAt: "x", updatedAt: "x", workers: [], stopping: false }));
    return path;
  }

  it("no-ops when status file is missing", () => {
    const r = kickRunningEngine({ statusPath: join(tmpDir, "absent.json") });
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe("no_status_file");
  });

  it("refuses to signal self", () => {
    const path = writeStatus(process.pid);
    const r = kickRunningEngine({ statusPath: path });
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe("self");
  });

  it("returns stale_pid when probe ESRCHs", () => {
    const path = writeStatus(1 /* almost certainly not us */);
    const r = kickRunningEngine({
      statusPath: path,
      signalFn: (_pid, _sig) => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      },
    });
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe("stale_pid");
  });

  it("delivers SIGHUP when probe + signal both succeed", () => {
    const path = writeStatus(12345);
    const sigs: { pid: number; sig: NodeJS.Signals | 0 }[] = [];
    const r = kickRunningEngine({
      statusPath: path,
      signalFn: (pid, sig) => {
        sigs.push({ pid, sig });
      },
    });
    expect(r.delivered).toBe(true);
    expect(r.pid).toBe(12345);
    expect(sigs).toEqual([
      { pid: 12345, sig: 0 },
      { pid: 12345, sig: "SIGHUP" },
    ]);
  });

  it("treats EPERM as a signal error", () => {
    const path = writeStatus(12345);
    const r = kickRunningEngine({
      statusPath: path,
      signalFn: () => {
        const err = new Error("eperm") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
    });
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe("signal_error");
  });

  it("classifies a malformed status file as stale_pid", () => {
    const path = join(tmpDir, "garbage.json");
    writeFileSync(path, "{not json");
    const r = kickRunningEngine({ statusPath: path });
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe("stale_pid");
  });

  // Cleanup once at the end.
  it("cleans up the temp dir", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
