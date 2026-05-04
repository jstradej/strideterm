import { defineConfig } from "@playwright/test";

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
  // Allow overriding the dev server port via VITE_DEV_PORT — useful when
  // running tests in a worktree while the main repo's dev server already
  // owns port 1420.
  webServer: {
    command: process.env.VITE_DEV_PORT
      ? `npm run dev:web -- --port ${process.env.VITE_DEV_PORT}`
      : "npm run dev:web",
    port: Number(process.env.VITE_DEV_PORT || 1420),
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
