import { defineConfig } from "@playwright/test";

/**
 * Playwright config for Electron E2E tests.
 *
 * Boots the real packaged Electron shell (dist-electron/electron/main.js) via
 * `_electron.launch()` against a temp --data-dir seeded with a fixture.
 *
 * Pre-requisite: `npm run build` must have produced dist/ and dist-electron/.
 * Linux CI runners need an X server (xvfb) — see `.github/workflows/e2e-tests.yml`.
 *
 * Tests tagged `@visual` are excluded by default — opt in with
 * `--grep @visual` for local pixel-diff runs. Cross-OS baselines drift
 * too easily for them to make sense in CI.
 */
export default defineConfig({
  testDir: "./test/electron-e2e",
  // Electron startup + state hydrate is heavier than a browser context.
  timeout: 60_000,
  // Run files sequentially — each spec spawns its own Electron process and
  // we don't want N copies fighting over file handles or windows.
  fullyParallel: false,
  workers: 1,
  retries: 1,
  // Auto-detect: if the user passes `--grep @visual` we skip grepInvert so
  // visual specs actually run. Default behaviour (no --grep) excludes them.
  grepInvert: (globalThis.process?.argv ?? []).some((a) => a.includes("@visual")) ? undefined : /@visual/,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // 10 % of pixels may differ from baseline — generous on purpose.
      // Goal is "page didn't catastrophically break", not pixel-perfect.
      maxDiffPixelRatio: 0.1,
      // Per-pixel anti-aliasing tolerance — keeps font-hinting drift quiet.
      threshold: 0.2,
    },
  },
  use: {
    actionTimeout: 10_000,
    // Always grab a screenshot — they're embedded in the HTML report so
    // you can scroll through every screen the suite touched, even on
    // green builds. Cheap (one PNG per test) and worth it for CI review.
    screenshot: "on",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-electron" }]],
  outputDir: "test-results-electron",
  snapshotDir: "test/electron-e2e/__screenshots__",
});
