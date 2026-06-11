/**
 * Idempotency-key tests (v45) — the manual/agent path's replay
 * protection. The dangerous invariants are pinned hard: a terminal
 * key NEVER re-executes, an in-flight key NEVER auto-retries, and a
 * reused key with different args NEVER silently replays.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "tradekit-idem-test-"));
process.env.TRADEKIT_DATA_DIR = tmpDataDir;

const { withIdempotency, hashArgs, releaseIdempotencyKey, validateIdempotencyKey, IN_FLIGHT_TTL_MS } =
  await import("./idempotency.js");
const { openDb, closeDb, getIdempotencyKey, claimIdempotencyKey, pruneIdempotencyKeys } =
  await import("./db.js");
const { ToolError } = await import("./errors.js");

beforeAll(() => { openDb(); });
afterAll(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});
beforeEach(() => { openDb().exec("DELETE FROM idempotency_keys"); });

const KEY = "test-key-0001";
const REQ = { direction: "buy", quoteAmount: "100", base: "ETH", quote: "USDC" };

async function run<T>(over: Partial<Parameters<typeof withIdempotency<T>>[0]> = {}, exec?: () => Promise<T>) {
  return withIdempotency<T>({
    key: KEY,
    tool: "buy",
    requestArgs: REQ,
    exec: exec ?? (async () => ({ txHash: "0xabc", status: "success" }) as T),
    ...over,
  });
}

describe("hashArgs", () => {
  it("is key-order independent and drops undefined (absent ≡ undefined)", () => {
    expect(hashArgs({ a: 1, b: "x" })).toBe(hashArgs({ b: "x", a: 1 }));
    expect(hashArgs({ a: 1, b: undefined })).toBe(hashArgs({ a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(hashArgs({ nested: { z: 1, a: [1, 2] } })).toBe(hashArgs({ nested: { a: [1, 2], z: 1 } }));
  });
});

describe("validateIdempotencyKey", () => {
  it("requires 8–128 chars of [A-Za-z0-9_-]", () => {
    expect(() => validateIdempotencyKey("short")).toThrow(/8,128|8–128|must match/);
    expect(() => validateIdempotencyKey("has spaces!")).toThrow(ToolError);
    expect(() => validateIdempotencyKey("a".repeat(129))).toThrow(ToolError);
    expect(() => validateIdempotencyKey("ok_key-12345")).not.toThrow();
  });
});

describe("withIdempotency — happy paths", () => {
  it("no key → plain execution, nothing recorded", async () => {
    const r = await run({ key: undefined });
    expect(r.replayed).toBe(false);
    expect(getIdempotencyKey(KEY)).toBeNull();
  });

  it("first call executes and records; second call REPLAYS without executing", async () => {
    let calls = 0;
    const exec = async () => { calls++; return { txHash: "0xabc" }; };
    const first = await run({}, exec);
    expect(first.replayed).toBe(false);
    expect(calls).toBe(1);
    expect(getIdempotencyKey(KEY)!.status).toBe("done");

    const second = await run({}, exec);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ txHash: "0xabc" });
    expect(calls).toBe(1); // THE invariant: no re-execution
  });

  it("a recorded ToolError replays as the same error, marked replayed", async () => {
    let calls = 0;
    const failing = async () => { calls++; throw new ToolError("INSUFFICIENT_BALANCE", "need 100, have 5", { details: { required: "100" } }); };
    await expect(run({}, failing)).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(getIdempotencyKey(KEY)!.status).toBe("failed");

    await expect(run({}, failing)).rejects.toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      message: expect.stringMatching(/^\[replayed\]/),
      details: expect.objectContaining({ replayed: true, required: "100" }),
    });
    expect(calls).toBe(1); // fixing the problem needs a NEW key — pinned
  });
});

describe("withIdempotency — conflict fences", () => {
  it("same key + different args → IDEMPOTENCY_CONFLICT, no execution", async () => {
    await run();
    let executed = false;
    await expect(
      run({ requestArgs: { ...REQ, quoteAmount: "999" } }, async () => { executed = true; return {}; }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(executed).toBe(false);
  });

  it("same key + different tool → IDEMPOTENCY_CONFLICT", async () => {
    await run();
    await expect(run({ tool: "sell" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("in-flight key → REQUEST_IN_FLIGHT; stale in-flight stays fenced but flags stale:true", async () => {
    // Simulate a died-mid-execution row by claiming without completing.
    claimIdempotencyKey({ key: KEY, tool: "buy", argsHash: hashArgs(REQ) });
    let executed = false;
    await expect(run({}, async () => { executed = true; return {}; }))
      .rejects.toMatchObject({ code: "REQUEST_IN_FLIGHT", details: expect.objectContaining({ stale: false }) });
    expect(executed).toBe(false);

    // Age the row past the TTL — STILL fenced (tx may be in mempool), but reported stale.
    openDb().prepare(`UPDATE idempotency_keys SET created_at = ? WHERE key = ?`)
      .run(new Date(Date.now() - IN_FLIGHT_TTL_MS - 60_000).toISOString(), KEY);
    await expect(run({}, async () => { executed = true; return {}; }))
      .rejects.toMatchObject({
        code: "REQUEST_IN_FLIGHT",
        message: expect.stringMatching(/release-key/),
        details: expect.objectContaining({ stale: true }),
      });
    expect(executed).toBe(false);
  });

  it("a non-ToolError crash leaves the key IN_FLIGHT (outcome unknown → fence retries)", async () => {
    await expect(run({}, async () => { throw new Error("process-level boom"); })).rejects.toThrow(/boom/);
    expect(getIdempotencyKey(KEY)!.status).toBe("in_flight");
    await expect(run()).rejects.toMatchObject({ code: "REQUEST_IN_FLIGHT" });
  });
});

describe("releaseIdempotencyKey", () => {
  it("releases an in-flight key; the next call executes fresh", async () => {
    claimIdempotencyKey({ key: KEY, tool: "buy", argsHash: hashArgs(REQ) });
    expect(releaseIdempotencyKey(KEY)).toBe(true);
    const r = await run();
    expect(r.replayed).toBe(false);
  });

  it("refuses to release a TERMINAL key (it replays; releasing would re-arm a done trade)", async () => {
    await run();
    expect(() => releaseIdempotencyKey(KEY)).toThrow(/terminal/);
  });

  it("missing key → false", () => {
    expect(releaseIdempotencyKey("never-existed-key")).toBe(false);
  });
});

describe("pruneIdempotencyKeys (retention)", () => {
  it("prunes by created_at cutoff", async () => {
    await run();
    openDb().prepare(`UPDATE idempotency_keys SET created_at = '2020-01-01T00:00:00Z' WHERE key = ?`).run(KEY);
    claimIdempotencyKey({ key: "fresh-key-0001", tool: "buy", argsHash: "x" });
    expect(pruneIdempotencyKeys("2025-01-01T00:00:00Z")).toBe(1);
    expect(getIdempotencyKey(KEY)).toBeNull();
    expect(getIdempotencyKey("fresh-key-0001")).not.toBeNull();
  });
});
