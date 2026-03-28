import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
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
    command: "npm run dev:web",
    port: 1420,
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
