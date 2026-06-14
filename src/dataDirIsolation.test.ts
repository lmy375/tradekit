// v63: regression guard for the test-isolation bug where the suite could
// read AND WRITE the operator's real ~/.tradekit (a hoisted config-touching
// import resolved constants.DATA_DIR before any test set TRADEKIT_DATA_DIR).
//
// This file deliberately sets NO TRADEKIT_DATA_DIR of its own and imports
// constants STATICALLY (hoisted) — exactly the pattern that used to fall
// through to the real home. With the vitest.setup.ts floor in place, DATA_DIR
// must instead resolve to a temp dir. If someone removes the floor, this test
// fails — surfacing the whole class of "tests touch the real config" bugs.

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./constants.js";

describe("test data-dir isolation (v63)", () => {
  it("never resolves DATA_DIR to the operator's real ~/.tradekit", () => {
    expect(DATA_DIR).not.toBe(join(homedir(), ".tradekit"));
  });

  it("DATA_DIR points at a TRADEKIT_DATA_DIR temp dir during tests", () => {
    // The floor (or a per-file override) always sets the env in tests.
    expect(process.env.TRADEKIT_DATA_DIR).toBeTruthy();
    expect(DATA_DIR).toBe(process.env.TRADEKIT_DATA_DIR);
  });
});
