import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["electron/backend/**/*.test.js", "electron/backend/**/*.test.ts"],
    // Windows CI runners hit the default 5000ms ceiling on a few runtime
    // tests that exercise the full createRuntime → stop lifecycle (e.g.
    // "does not rewrite the store during runtime stop" — body itself is
    // trivial, but createFixture + runtime.stop wall-clock exceeds 5s
    // there on cold workers). Linux / macOS finish in ~2s. Bumping to
    // 30s eliminates the Windows-only flake without hiding genuinely
    // hung tests.
    testTimeout: 30_000,
  },
});
