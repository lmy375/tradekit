// Iter626: tests for the pure helpers in verify.ts. Backup IO test runs
// against a real tmpdir-encrypted file via the existing encryptBundle helper
// — that's the most production-faithful way to verify the verify path.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyConfigIntegrity,
  verifyDbIntegrity,
  verifyBackupBundle,
  summarizeChecks,
} from "./verify.js";
import { encryptBundle } from "./backup.js";
import type { Config } from "./config.js";

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  recordTrade: () => 0,
  readRecentTrades: () => [],
  recordAudit: () => 0,
  close: () => {},
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    activeChain: "base",
    activeAccount: "default",
    defaultSlippageBps: 50,
    chains: {},
    aggregator: { preferred: ["kyberswap", "openocean"], mode: "first" },
    safety: { enabled: true, maxSlippageBps: 500, allowInfiniteApprovals: false },
    ...overrides,
  } as Config;
}

// ── verifyConfigIntegrity ──────────────────────────────────

describe("verifyConfigIntegrity", () => {
  it("returns no_empty_shells ok when no orphan chains exist", () => {
    const cfg = makeConfig();
    const checks = verifyConfigIntegrity(cfg, ["base", "arbitrum"]);
    expect(checks.find((c) => c.name === "config.chains.no_empty_shells")?.ok).toBe(true);
  });

  it("flags empty chain shells", () => {
    const cfg = makeConfig({
      chains: {
        ghost: {} as any,
      },
    });
    const checks = verifyConfigIntegrity(cfg, ["base", "ghost"]);
    expect(checks.find((c) => c.name === "config.chains.ghost.empty")?.ok).toBe(false);
  });

  it("does NOT flag chain with rpcs as empty", () => {
    const cfg = makeConfig({
      chains: {
        custom: { rpcs: ["https://example.com/rpc"] } as any,
      },
    });
    const checks = verifyConfigIntegrity(cfg, ["base", "custom"]);
    expect(checks.find((c) => c.name === "config.chains.custom.empty")).toBeUndefined();
  });

  it("flags invalid token addresses", () => {
    const cfg = makeConfig({
      chains: {
        base: { tokens: { PEPE: "0xnot-a-valid-address" } } as any,
      },
    });
    const checks = verifyConfigIntegrity(cfg, ["base"]);
    expect(
      checks.find((c) => c.name === "config.chains.base.tokens.PEPE.invalid_address")?.ok,
    ).toBe(false);
  });

  it("flags safety entries referencing unknown chains", () => {
    const cfg = makeConfig({
      safety: {
        enabled: true,
        maxSlippageBps: 500,
        allowInfiniteApprovals: false,
        tokenBlacklist: { unknown_chain: ["0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"] },
      },
    } as any);
    const checks = verifyConfigIntegrity(cfg, ["base"]);
    expect(
      checks.find((c) => c.name === "config.safety.tokenBlacklist.unknown_chain.unknown_chain")?.ok,
    ).toBe(false);
  });

  it("case-insensitive chain matching in safety lists", () => {
    const cfg = makeConfig({
      safety: {
        enabled: true,
        maxSlippageBps: 500,
        allowInfiniteApprovals: false,
        tokenBlacklist: { Base: ["0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"] },
      },
    } as any);
    const checks = verifyConfigIntegrity(cfg, ["base"]);
    // "Base" should match "base" (case-insensitive)
    const orphan = checks.find((c) => c.name === "config.safety.tokenBlacklist.Base.unknown_chain");
    expect(orphan).toBeUndefined();
  });

  it("flags empty aggregator.preferred", () => {
    const cfg = makeConfig({
      aggregator: { preferred: [], mode: "first" } as any,
    });
    const checks = verifyConfigIntegrity(cfg, ["base"]);
    expect(checks.find((c) => c.name === "config.aggregator.preferred.empty")?.ok).toBe(false);
  });

  it("aggregator check passes when preferred has entries", () => {
    const cfg = makeConfig();
    const checks = verifyConfigIntegrity(cfg, ["base"]);
    expect(checks.find((c) => c.name === "config.aggregator.preferred.set")?.ok).toBe(true);
  });
});

// ── verifyDbIntegrity ──────────────────────────────────────

describe("verifyDbIntegrity", () => {
  it("flags schema mismatch", () => {
    const checks = verifyDbIntegrity({
      schemaVersion: 2,
      expectedSchemaVersion: 3,
      pendingCount: 0,
      pendingOlderThan24h: 0,
      auditRowCount: 0,
    });
    expect(checks.find((c) => c.name === "db.schema.mismatch")?.ok).toBe(false);
  });

  it("schema.current passes when version matches", () => {
    const checks = verifyDbIntegrity({
      schemaVersion: 3,
      expectedSchemaVersion: 3,
      pendingCount: 0,
      pendingOlderThan24h: 0,
      auditRowCount: 0,
    });
    expect(checks.find((c) => c.name === "db.schema.current")?.ok).toBe(true);
  });

  it("flags stale-pending trades", () => {
    const checks = verifyDbIntegrity({
      schemaVersion: 3,
      expectedSchemaVersion: 3,
      pendingCount: 5,
      pendingOlderThan24h: 3,
      auditRowCount: 100,
    });
    const stale = checks.find((c) => c.name === "db.pending.stale");
    expect(stale?.ok).toBe(false);
    expect(stale?.details?.stalePendingCount).toBe(3);
  });

  it("pending.recent passes when no stale pending", () => {
    const checks = verifyDbIntegrity({
      schemaVersion: 3,
      expectedSchemaVersion: 3,
      pendingCount: 2,
      pendingOlderThan24h: 0,
      auditRowCount: 100,
    });
    expect(checks.find((c) => c.name === "db.pending.recent")?.ok).toBe(true);
  });

  it("pending.none passes when no pending at all", () => {
    const checks = verifyDbIntegrity({
      schemaVersion: 3,
      expectedSchemaVersion: 3,
      pendingCount: 0,
      pendingOlderThan24h: 0,
      auditRowCount: 100,
    });
    expect(checks.find((c) => c.name === "db.pending.none")?.ok).toBe(true);
  });

  it("flags large audit log (>100k rows)", () => {
    const checks = verifyDbIntegrity({
      schemaVersion: 3,
      expectedSchemaVersion: 3,
      pendingCount: 0,
      pendingOlderThan24h: 0,
      auditRowCount: 150_000,
    });
    expect(checks.find((c) => c.name === "db.audit.large")?.ok).toBe(false);
  });

  it("audit.size_ok passes under threshold", () => {
    const checks = verifyDbIntegrity({
      schemaVersion: 3,
      expectedSchemaVersion: 3,
      pendingCount: 0,
      pendingOlderThan24h: 0,
      auditRowCount: 5_000,
    });
    expect(checks.find((c) => c.name === "db.audit.size_ok")?.ok).toBe(true);
  });
});

// ── verifyBackupBundle (file IO via tmpdir) ────────────────

describe("verifyBackupBundle (file IO)", () => {
  let tmp: string;

  function tmpfile(name: string): string {
    return join(tmp, name);
  }

  function createBackupFile(filename: string, password: string): void {
    const bundle = {
      files: {
        "mnemonic.json": Buffer.from('{"address":"0x1234"}').toString("base64"),
        "config.json": Buffer.from('{"activeChain":"base"}').toString("base64"),
      },
      createdAt: "2026-05-29T00:00:00Z",
      includesDb: false,
      formatVersion: 1,
    };
    const encrypted = encryptBundle(bundle, password);
    writeFileSync(filename, JSON.stringify(encrypted));
  }

  beforeEach();
  function beforeEach() {
    tmp = mkdtempSync(join(tmpdir(), "tradekit-verify-test-"));
  }
  function afterEach() {
    rmSync(tmp, { recursive: true, force: true });
  }

  it("returns file_not_found check when path doesn't exist", async () => {
    afterEach();
    beforeEach();
    const checks = await verifyBackupBundle({
      file: tmpfile("does-not-exist.bak"),
      password: "anything",
      logger: stubLogger,
    });
    expect(checks[0].name).toBe("backup.file.exists");
    expect(checks[0].ok).toBe(false);
    afterEach();
  });

  it("verifies a real encrypted backup end-to-end with correct password", async () => {
    afterEach();
    beforeEach();
    const path = tmpfile("good.bak");
    createBackupFile(path, "correct-password");
    const checks = await verifyBackupBundle({
      file: path,
      password: "correct-password",
      logger: stubLogger,
    });
    // All checks should pass.
    expect(checks.find((c) => c.name === "backup.file.readable")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "backup.json.parse")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "backup.magic")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "backup.version")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "backup.decrypt")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "backup.file.mnemonic.json")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "backup.file.config.json")?.ok).toBe(true);
    afterEach();
  });

  it("flags decrypt failure with wrong password", async () => {
    afterEach();
    beforeEach();
    const path = tmpfile("good.bak");
    createBackupFile(path, "correct-password");
    const checks = await verifyBackupBundle({
      file: path,
      password: "WRONG-password",
      logger: stubLogger,
    });
    expect(checks.find((c) => c.name === "backup.decrypt")?.ok).toBe(false);
    afterEach();
  });

  it("flags bad magic on a non-tradekit JSON file", async () => {
    afterEach();
    beforeEach();
    const path = tmpfile("bogus.bak");
    writeFileSync(path, JSON.stringify({ magic: "NOT-A-TK-BACKUP", v: 1 }));
    const checks = await verifyBackupBundle({
      file: path,
      password: "anything",
      logger: stubLogger,
    });
    expect(checks.find((c) => c.name === "backup.magic")?.ok).toBe(false);
    afterEach();
  });

  it("flags malformed JSON", async () => {
    afterEach();
    beforeEach();
    const path = tmpfile("garbage.bak");
    writeFileSync(path, "this is not json at all {{{");
    const checks = await verifyBackupBundle({
      file: path,
      password: "anything",
      logger: stubLogger,
    });
    expect(checks.find((c) => c.name === "backup.json.parse")?.ok).toBe(false);
    afterEach();
  });

  it("structural check works without password", async () => {
    afterEach();
    beforeEach();
    const path = tmpfile("good.bak");
    createBackupFile(path, "secret");
    const checks = await verifyBackupBundle({
      file: path,
      password: null,
      logger: stubLogger,
    });
    expect(checks.find((c) => c.name === "backup.magic")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "backup.version")?.ok).toBe(true);
    const decryptCheck = checks.find((c) => c.name === "backup.decrypt");
    expect(decryptCheck?.ok).toBe(false);
    expect(decryptCheck?.details?.reason).toBe("no_password_supplied");
    afterEach();
  });
});

// ── summarizeChecks ────────────────────────────────────────

describe("summarizeChecks", () => {
  it("counts passed/failed correctly", () => {
    const report = summarizeChecks("all", [
      { name: "a", ok: true, message: "" },
      { name: "b", ok: false, message: "" },
      { name: "c", ok: true, message: "" },
    ]);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.ok).toBe(false);
  });

  it("ok=true when all checks pass", () => {
    const report = summarizeChecks("config", [
      { name: "a", ok: true, message: "" },
      { name: "b", ok: true, message: "" },
    ]);
    expect(report.ok).toBe(true);
  });

  it("ok=true on empty checks (no checks ran → nothing failed)", () => {
    const report = summarizeChecks("config", []);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
  });
});
