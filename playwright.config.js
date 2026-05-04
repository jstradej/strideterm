import { defineConfig } from "@playwright/test";

// Default the dev-server port to 1421 instead of vite's usual 1420. The
// repo lives inside a git worktree, and a separate vite instance running
// from the parent working tree often owns 1420 — playwright's
// `reuseExistingServer: true` would happily reuse that *wrong* server,
// which serves stale source from the other worktree (no responsive
// chrome, no /mock= hash, no commit-info dialog) and the mobile e2e
// suite would silently test the wrong code.
//
// Setting VITE_DEV_PORT here also makes the mock server proxy match the
// vite instance we just spawned (test/mock-server.ts reads it).
//
// Override with `VITE_DEV_PORT=<n> npx playwright test` if 1421 is busy.
process.env.VITE_DEV_PORT = process.env.VITE_DEV_PORT || "1421";
const VITE_PORT = Number(process.env.VITE_DEV_PORT);

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  grep: process.env.CI ? /^(?!.*@visual)/ : undefined,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
    },
  },
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 5_000,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run dev:web -- --port ${VITE_PORT}`,
    port: VITE_PORT,
    reuseExistingServer: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
});
