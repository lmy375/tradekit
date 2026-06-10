/**
 * Config change-history tests (v36).
 *
 * Layers:
 *   1. saveConfig hook — records once the DB exists, dedupes by
 *      content hash, tags sources, never blocks the save
 *   2. db helpers — list/get/latest/prune round trip
 *   3. rollback semantics (via the same primitives the CLI uses) —
 *      schema validation forward-fills old snapshots; rollback
 *      records a NEW version
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-configHistory-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { openDb, closeDb, listConfigHistory, getConfigHistoryById, latestConfigHistory, pruneConfigHistory, insertConfigHistory } = await import("./db.js");
const { loadConfig, saveConfig, configSchema, setConfigPath } = await import("./config.js");

beforeAll(() => { openDb(); }); // DB must exist for the hook to record
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => {
  openDb().exec("DELETE FROM config_history");
});

describe("saveConfig — history hook", () => {
  it("records a version with source, dedupes identical content", () => {
    const cfg = loadConfig();
    saveConfig(setConfigPath(cfg, "defaultSlippageBps", 77), { source: "cli:config set defaultSlippageBps" });
    expect(listConfigHistory()).toHaveLength(1);
    expect(listConfigHistory()[0].source).toBe("cli:config set defaultSlippageBps");

    // Idempotent re-save of the SAME content → no new row.
    saveConfig(loadConfig(), { source: "noop-resave" });
    expect(listConfigHistory()).toHaveLength(1);

    // A real change → second row, newest first.
    saveConfig(setConfigPath(loadConfig(), "defaultSlippageBps", 88), { source: "second" });
    const rows = listConfigHistory();
    expect(rows).toHaveLength(2);
    expect(rows[0].source).toBe("second");
    expect(rows[0].hash).not.toBe(rows[1].hash);
  });

  it("the stored content round-trips through the schema", () => {
    saveConfig(setConfigPath(loadConfig(), "defaultSlippageBps", 99), { source: "x" });
    const latest = latestConfigHistory()!;
    const parsed = configSchema.parse(JSON.parse(latest.content));
    expect(parsed.defaultSlippageBps).toBe(99);
  });
});

describe("rollback semantics", () => {
  it("an old snapshot restores prior values and records a NEW version", () => {
    saveConfig(setConfigPath(loadConfig(), "defaultSlippageBps", 50), { source: "v1" });
    const v1 = latestConfigHistory()!;
    saveConfig(setConfigPath(loadConfig(), "defaultSlippageBps", 500), { source: "v2-mistake" });
    expect(loadConfig().defaultSlippageBps).toBe(500);

    // Rollback = parse stored content through the schema + save with
    // a rollback source (exactly what the CLI does).
    const candidate = configSchema.parse(JSON.parse(getConfigHistoryById(v1.id)!.content));
    saveConfig(candidate, { source: `rollback:#${v1.id}` });

    expect(loadConfig().defaultSlippageBps).toBe(50);
    const rows = listConfigHistory();
    expect(rows[0].source).toBe(`rollback:#${v1.id}`);
    // History only grows — the mistake version is preserved for forensics.
    expect(rows.map((r) => r.source)).toContain("v2-mistake");
  });

  it("schema parse forward-fills snapshots that predate newer fields", () => {
    // Simulate an ancient snapshot missing recent config sections.
    const ancient = { activeChain: "base", activeAccount: "default", defaultSlippageBps: 42, chains: {} };
    const id = insertConfigHistory({
      savedAt: "2025-01-01T00:00:00Z",
      hash: "ancient0000000",
      source: "test",
      content: JSON.stringify(ancient),
    });
    const row = getConfigHistoryById(id)!;
    const parsed = configSchema.parse(JSON.parse(row.content));
    expect(parsed.defaultSlippageBps).toBe(42);
    // Newer sections come back with their defaults — rollback can't
    // strip the schema.
    expect(parsed.engine.fireRetry.enabled).toBe(true);
    expect(parsed.notifications.quietHours.enabled).toBe(false);
  });
});

describe("db helpers", () => {
  it("prune drops old rows by saved_at", () => {
    insertConfigHistory({ savedAt: "2025-01-01T00:00:00Z", hash: "a", source: null, content: "{}" });
    insertConfigHistory({ savedAt: "2026-06-01T00:00:00Z", hash: "b", source: null, content: "{}" });
    expect(pruneConfigHistory("2026-01-01T00:00:00Z")).toBe(1);
    expect(listConfigHistory()).toHaveLength(1);
    expect(listConfigHistory()[0].hash).toBe("b");
  });
});
