import { defineConfig } from "vitest/config";

// `pnpm smoke`: opt-in tests against real accounts and CLIs (docs/RUNNING.md § 14).
export default defineConfig({
  test: {
    include: ["apps/desktop/smoke/**/*.smoke.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--disable-warning=ExperimentalWarning"] } },
    testTimeout: 240_000,
    fileParallelism: false,
  },
});
