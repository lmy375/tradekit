// Global test guard (v63): GUARANTEE that no test ever resolves DATA_DIR
// to the operator's real ~/.tradekit.
//
// constants.ts computes `DATA_DIR = process.env.TRADEKIT_DATA_DIR || ~/.tradekit`
// ONCE, at first import. Most test files set TRADEKIT_DATA_DIR to a temp dir
// at their module top before importing db/config — but a STATIC (hoisted)
// import of any config-touching module resolves `constants` BEFORE that
// assignment runs, so DATA_DIR falls through to the real home. That made
// such tests read AND WRITE the developer's real config file
// (doctor.test.ts demonstrably wrote engine keys into ~/.tradekit/config.json).
//
// setupFiles run in each test file's context BEFORE the file module (and its
// hoisted imports) evaluate. Setting a temp dir here when none is set turns
// the dangerous (unset → home) case into (unset → temp). It does NOT override
// a file that sets its own dir at module top — that assignment runs after
// this and wins for that file's own (dynamic) imports — so per-file isolation
// is preserved; this is purely a floor that keeps the real home off-limits.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.TRADEKIT_DATA_DIR) {
  process.env.TRADEKIT_DATA_DIR = mkdtempSync(join(tmpdir(), "tradekit-vitest-floor-"));
}
