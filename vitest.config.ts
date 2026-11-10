import { configDefaults, defineConfig } from "vitest/config";

// The factory core's suites spawn git, gates and child processes; t3code-factory ran them with
// these timeouts and a git config set through the environment.
export default defineConfig({
  test: {
    // .factory/ holds a run's scratch, including other checkouts with their own tests.
    exclude: [...configDefaults.exclude, ".factory/**"],
    setupFiles: ["./test/setup/gitConfig.setup.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
