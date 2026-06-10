/**
 * Observability-preset tests. applyObservabilityPreset is pure
 * (config in → config + changed[] out), so everything here runs
 * without prompts, saves, or a wallet.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TRADEKIT_DATA_DIR = mkdtempSync(join(tmpdir(), "tradekit-init-test-"));

const { applyObservabilityPreset } = await import("./init.js");
const { loadConfig, configSchema } = await import("../config.js");

describe("applyObservabilityPreset", () => {
  it("enables journals + retention + alert watcher on a default config", () => {
    const { config, changed } = applyObservabilityPreset(loadConfig());

    expect(config.engine.orderJournal.enabled).toBe(true);
    expect(config.engine.scheduleJournal.enabled).toBe(true);
    expect(config.engine.rebalanceJournal.enabled).toBe(true);

    expect(config.db.retention.enabled).toBe(true);
    expect(config.db.retention.auditLogDays).toBe(180);
    expect(config.db.retention.orderCheckLogDays).toBe(60);
    expect(config.db.retention.scheduleCheckLogDays).toBe(60);
    expect(config.db.retention.rebalanceCheckLogDays).toBe(60);
    expect(config.db.retention.alertEventsDays).toBe(180);
    expect(config.db.retention.engineEventsDays).toBe(180);
    // Deliberately untouched: paper fills are analysis data.
    expect(config.db.retention.paperTradesDays).toBeNull();

    const alerts = (config.safety as { strategyAlerts?: { enabled: boolean; rules: Array<{ type: string }> } }).strategyAlerts!;
    expect(alerts.enabled).toBe(true);
    expect(alerts.rules.map((r) => r.type).sort()).toEqual([
      "budget_approach", "drawdown_threshold", "drift_proximity", "failure_streak", "staleness",
    ]);

    expect(changed.length).toBeGreaterThanOrEqual(11);
    // The result must round-trip the schema (starter rules valid).
    expect(() => configSchema.parse(JSON.parse(JSON.stringify(config)))).not.toThrow();
  });

  it("is idempotent — a second apply changes nothing", () => {
    const first = applyObservabilityPreset(loadConfig());
    const second = applyObservabilityPreset(first.config);
    expect(second.changed).toEqual([]);
    expect(second.config).toEqual(first.config);
  });

  it("never clobbers an operator-tuned alert rule set", () => {
    const base = loadConfig();
    const tuned = {
      ...base,
      safety: {
        ...base.safety,
        strategyAlerts: {
          enabled: true,
          rules: [{ type: "failure_streak", alertCount: 7 }],
        },
      },
    } as never;
    const { config, changed } = applyObservabilityPreset(tuned);
    const alerts = (config.safety as { strategyAlerts: { rules: Array<{ type: string; alertCount?: number }> } }).strategyAlerts;
    expect(alerts.rules).toHaveLength(1);
    expect(alerts.rules[0].alertCount).toBe(7);
    expect(changed.some((c) => c.includes("strategyAlerts"))).toBe(false);
  });

  it("never clobbers operator retention days; only fills unset knobs", () => {
    const base = loadConfig();
    const tuned = {
      ...base,
      db: {
        ...base.db,
        retention: { ...base.db.retention, enabled: true, auditLogDays: 30 },
      },
    } as never;
    const { config, changed } = applyObservabilityPreset(tuned);
    expect(config.db.retention.auditLogDays).toBe(30); // operator value kept
    expect(config.db.retention.orderCheckLogDays).toBe(60); // unset → filled
    expect(changed.some((c) => c.includes("auditLogDays"))).toBe(false);
    expect(changed.some((c) => c.includes("retention.enabled"))).toBe(false);
  });
});
