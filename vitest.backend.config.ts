import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "electron/backend/**/*.test.js",
      "electron/backend/**/*.test.ts",
      // Shared, framework-free helpers (e.g. workspace-display) — node env
      // is fine since they don't touch DOM. Including them here avoids
      // a separate vitest config for a handful of pure-function tests.
      "electron/shared/**/*.test.js",
      "electron/shared/**/*.test.ts",
      // Electron-adapter modules that sit beside main.ts (e.g. the
      // performance-metrics sampler). Pure, node-env-friendly logic.
      "electron/*.test.js",
      "electron/*.test.ts",
    ],
    // Windows CI runners hit the default 5000ms ceiling on a few runtime
    // tests that exercise the full createRuntime → stop lifecycle (e.g.
    // "does not rewrite the store during runtime stop" — body itself is
    // trivial, but createFixture + runtime.stop wall-clock exceeds 5s
    // there on cold workers). Linux / macOS finish in ~2s. Bumping to
    // 30s eliminates the Windows-only flake without hiding genuinely
    // hung tests.
    testTimeout: 30_000,
    // The shared notify-URL registry lives in the user's HOME by design (it
    // has to be reachable from every data dir). A test run must never write
    // there, so point both sides of the hook — runtime.ts and notify.mjs — at
    // a scratch directory instead.
    env: {
      STRIDETERM_HOOKS_DIR: fileURLToPath(new URL("./node_modules/.tmp/strideterm-hooks-test", import.meta.url)),
    },
  },
});
