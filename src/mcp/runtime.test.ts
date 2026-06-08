// Iter890: regression tests for the iter889 ok() envelope discipline. Helper
// must idempotently add `ok: true` to plain-object payloads, leave already-
// enveloped payloads unchanged, and pass through non-objects (arrays,
// primitives, null) untouched. Without these tests, a future refactor of
// runtime.ts could regress the agent-facing envelope contract silently.

import { describe, it, expect } from "vitest";
import { ok, fail } from "./runtime.js";
import { ToolError } from "../errors.js";

function payloadFrom(result: ReturnType<typeof ok>): unknown {
  // The helper wraps the JSON in the MCP text-content envelope. Tests assert
  // on the parsed JSON payload, not the transport wrapper.
  return JSON.parse(result.content[0].text);
}

describe("Iter889: ok() envelope discipline", () => {
  it("adds ok:true to a plain object without an existing ok field", () => {
    const out = payloadFrom(ok({ txHash: "0xabc", status: "success" }));
    expect(out).toEqual({ ok: true, txHash: "0xabc", status: "success" });
  });

  it("preserves an existing ok:true (idempotent)", () => {
    const out = payloadFrom(ok({ ok: true, report: "data" }));
    expect(out).toEqual({ ok: true, report: "data" });
  });

  it("preserves an existing ok:false (does not flip to true)", () => {
    // Legitimate use case: a tool returning a "negative result" success
    // (e.g. price-check verdict that found divergence). Helper must not
    // pretend everything is fine.
    const out = payloadFrom(ok({ ok: false, reason: "divergence" }));
    expect(out).toEqual({ ok: false, reason: "divergence" });
  });

  it("passes arrays through unchanged", () => {
    // Arrays can't carry ok at the top level (would change the type to
    // object). Helper leaves them as-is — same back-compat contract as
    // the CLI bare-array printJson holdouts.
    const out = payloadFrom(ok([1, 2, 3]));
    expect(out).toEqual([1, 2, 3]);
  });

  it("passes null through unchanged", () => {
    const out = payloadFrom(ok(null));
    expect(out).toEqual(null);
  });

  it("passes a bare string through unchanged", () => {
    const out = payloadFrom(ok("hello"));
    expect(out).toEqual("hello");
  });

  it("preserves nested objects and BigInt stringification", () => {
    const out = payloadFrom(ok({
      tx: { hash: "0x123", value: 1000000n },
    }));
    // ok:true added at top; BigInt stringified via jsonReplacer.
    expect(out).toEqual({
      ok: true,
      tx: { hash: "0x123", value: "1000000" },
    });
  });

  it("envelopes objects with falsy non-ok fields", () => {
    // Edge case: payload has `data: null` but no `ok` field. Helper should
    // still add ok:true. The check is `"ok" in payload`, not truthiness.
    const out = payloadFrom(ok({ data: null, count: 0 }));
    expect(out).toEqual({ ok: true, data: null, count: 0 });
  });

  it("iter905: class instances pass through without losing data", () => {
    // Pre-iter905, `{ ok: true, ...new Date() }` would produce `{ok: true}`
    // because Date has no own enumerable properties. Result: caller's data
    // silently dropped. iter905 detects non-plain prototypes and passes the
    // instance through unchanged so Date's toJSON / JSON.stringify path
    // produces the canonical ISO-string serialization.
    const date = new Date("2026-05-30T11:24:33Z");
    const out = payloadFrom(ok(date));
    expect(out).toEqual("2026-05-30T11:24:33.000Z");
  });

  it("iter905: null-prototype objects ARE enveloped (still safe to spread)", () => {
    // Edge case: Object.create(null) produces an object with no prototype.
    // The spread works correctly (own properties enumerate normally), so
    // these should be enveloped like plain objects.
    const payload = Object.create(null);
    payload.foo = "bar";
    const out = payloadFrom(ok(payload));
    expect(out).toEqual({ ok: true, foo: "bar" });
  });

  it("iter920: payloads with elapsedMs (iter908-918) still get ok envelope", () => {
    // The iter908-918 campaign added elapsedMs to every substantive MCP
    // tool's response. The helper must envelope these correctly — the
    // payload has elapsedMs but NO `ok` field, so ok:true should be
    // prepended without affecting elapsedMs.
    const out = payloadFrom(ok({
      txHash: "0xabc",
      status: "success",
      elapsedMs: 234,
    }));
    expect(out).toEqual({
      ok: true,
      txHash: "0xabc",
      status: "success",
      elapsedMs: 234,
    });
  });

  it("iter920: payloads pre-enveloped + with elapsedMs preserve both fields", () => {
    // Sites that explicitly return `{ok:true, ...report, elapsedMs}` (e.g.
    // iter908 doctor, iter918 import_trade) should pass through unchanged.
    const out = payloadFrom(ok({
      ok: true,
      report: { data: 1 },
      elapsedMs: 567,
    }));
    expect(out).toEqual({
      ok: true,
      report: { data: 1 },
      elapsedMs: 567,
    });
  });
});

// Iter921: symmetric tests for the fail() error path. Paired with ok(); both
// are the canonical MCP envelope helpers, so coverage should be symmetric.
describe("fail() error envelope", () => {
  it("returns isError:true in the MCP transport wrapper", () => {
    const result = fail(new ToolError("RPC_FAILED", "chain unreachable"));
    expect(result.isError).toBe(true);
  });

  it("payload has ok:false + error{code,message}", () => {
    const result = fail(new ToolError("RPC_FAILED", "chain unreachable"));
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("RPC_FAILED");
    expect(payload.error.message).toBe("chain unreachable");
  });

  it("includes details when provided", () => {
    const result = fail(
      new ToolError("UNKNOWN_CHAIN", "no such chain", { details: { chain: "baes", suggestion: "base" } }),
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.details).toEqual({ chain: "baes", suggestion: "base" });
  });

  it("includes nextActions when provided", () => {
    const result = fail(
      new ToolError("NEEDS_APPROVAL", "need approval", {
        nextActions: [{ tool: "approve", params: { token: "0xabc", spender: "0xdef" }, reason: "approve first" }],
      }),
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.next_actions).toEqual([
      { tool: "approve", params: { token: "0xabc", spender: "0xdef" }, reason: "approve first" },
    ]);
  });

  it("payload includes ok:false even without details/nextActions", () => {
    // Bare ToolError — confirms the minimal happy-path envelope shape.
    const result = fail(new ToolError("INTERNAL_ERROR", "boom"));
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
  });
});
