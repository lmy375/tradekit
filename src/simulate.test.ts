// Tests for decodeRevert — the parser that turns on-chain revert bytes into a human
// string. The string flows into toToolError, which matches it against patterns from
// iter27 (slippage, TRANSFER_FROM_FAILED, etc.) to choose an error code + nextActions.
// Breaking this function silently breaks the agent's recovery UX across every revert.

import { describe, it, expect } from "vitest";
import { encodeAbiParameters } from "viem";
import { decodeRevert } from "./simulate.js";

/** Build an Error(string) revert payload as viem would deliver it. */
function errorString(msg: string): `0x${string}` {
  const encoded = encodeAbiParameters([{ type: "string" }], [msg]);
  return ("0x08c379a0" + encoded.slice(2)) as `0x${string}`;
}

/** Build a Panic(uint256) revert payload (code is the panic ID, e.g. 0x11 for overflow). */
function panic(code: bigint): `0x${string}` {
  const encoded = encodeAbiParameters([{ type: "uint256" }], [code]);
  return ("0x4e487b71" + encoded.slice(2)) as `0x${string}`;
}

describe("decodeRevert", () => {
  it("returns undefined for undefined input", () => {
    expect(decodeRevert(undefined)).toBeUndefined();
  });

  it("returns undefined for empty (0x) input", () => {
    expect(decodeRevert("0x")).toBeUndefined();
  });

  it("decodes Error(string) — the common revert('…') case", () => {
    expect(decodeRevert(errorString("Slippage exceeded"))).toBe("Slippage exceeded");
    expect(decodeRevert(errorString("TransferHelper: TRANSFER_FROM_FAILED"))).toBe(
      "TransferHelper: TRANSFER_FROM_FAILED",
    );
  });

  it("decodes Error(string) for empty string (corner case)", () => {
    expect(decodeRevert(errorString(""))).toBe("");
  });

  it("decodes Panic(uint256) to a human-readable name (iter144 — was bare hex pre-fix)", () => {
    // 0x11 = arithmetic overflow/underflow (the most common panic in production). The
    // human name lets operators understand what went wrong without consulting the spec,
    // and lets toToolError pattern-match on "overflow" / "underflow" for cleaner codes.
    expect(decodeRevert(panic(0x11n))).toContain("arithmetic overflow/underflow");
    expect(decodeRevert(panic(0x11n))).toContain("0x11");
    // 0x32 = array out-of-bounds.
    expect(decodeRevert(panic(0x32n))).toContain("array index out of bounds");
    expect(decodeRevert(panic(0x32n))).toContain("0x32");
    // 0x12 = divide by zero.
    expect(decodeRevert(panic(0x12n))).toContain("division/modulo by zero");
  });

  it("falls back to 'Panic(0xNN)' for unknown panic codes", () => {
    // An unspec'd code (compilers may add new ones). Still informative — at least the
    // operator knows it's a Solidity panic and the hex code.
    expect(decodeRevert(panic(0x99n))).toBe("Panic(0x99)");
  });

  it("returns raw hex for an unknown selector (caller still gets *something*)", () => {
    // Custom-error selector with no decoder.
    const custom = "0xdeadbeef00000000000000000000000000000000000000000000000000000000" as const;
    expect(decodeRevert(custom)).toBe(custom);
  });

  it("falls back to raw hex when Error(string) payload is malformed", () => {
    // Selector matches Error(string) but the body isn't valid string-encoded data.
    const malformed = "0x08c379a000" as `0x${string}`;
    // Should not throw; should return the original hex as best-effort.
    const out = decodeRevert(malformed);
    expect(out).toBe(malformed);
  });

  it("preserves non-ASCII content in revert strings (e.g. UTF-8 quoted reasons)", () => {
    // Some routers revert with unicode messages (e.g. CJK error strings from L2 frontends).
    const msg = "余额不足"; // "insufficient balance" in Chinese
    expect(decodeRevert(errorString(msg))).toBe(msg);
  });

  it("decodes OZ v5 custom-error selectors to readable names (iter93)", () => {
    // Without this mapping, the iter58 error classifier sees `0xe450d38c…` and can't
    // map it to INSUFFICIENT_BALANCE, so the agent loses its recovery hint. After
    // iter93, decodeRevert returns "ERC20InsufficientBalance" → toToolError's pattern
    // table matches → user gets the right structured error + hint.
    expect(decodeRevert("0xe450d38c0000000000000000000000000000000000000000000000000000000000000000")).toBe(
      "ERC20InsufficientBalance",
    );
    expect(decodeRevert("0xfb8f41b2")).toBe("ERC20InsufficientAllowance");
    // Other OZ v5 selectors we recognize.
    expect(decodeRevert("0x96c6fd1e")).toBe("ERC20InvalidSender");
    expect(decodeRevert("0xec442f05")).toBe("ERC20InvalidReceiver");
    expect(decodeRevert("0xcd786059")).toBe("AddressInsufficientBalance");
    expect(decodeRevert("0x1425ea42")).toBe("FailedInnerCall");
  });

  it("matches custom-error selectors case-insensitively (some RPCs uppercase the hex)", () => {
    expect(decodeRevert("0xE450D38C00000000")).toBe("ERC20InsufficientBalance");
  });
});
