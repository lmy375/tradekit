import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Tests run against the TS source directly (no build step). Node 22's
    // experimental SQLite flag is needed for any test that imports db.ts.
    pool: "forks",
    forks: {
      execArgv: ["--experimental-sqlite", "--no-warnings=ExperimentalWarning"],
    },
    testTimeout: 10_000,
  },
});
