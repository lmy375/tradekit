import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // v63: pin TRADEKIT_DATA_DIR to a temp dir before any test module loads,
    // so a hoisted config-touching import can never resolve DATA_DIR to the
    // real ~/.tradekit (which had let tests read/write the operator's config).
    setupFiles: ["./vitest.setup.ts"],
    // Tests run against the TS source directly (no build step). Node 22's
    // experimental SQLite flag is needed for any test that imports db.ts.
    pool: "forks",
    forks: {
      execArgv: ["--experimental-sqlite", "--no-warnings=ExperimentalWarning"],
    },
    testTimeout: 10_000,
  },
});
