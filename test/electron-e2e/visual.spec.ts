import { test, expect } from "@playwright/test";
import { launchApp, closeApp, settleForScreenshot, type LaunchedApp } from "./helpers.js";

/**
 * Visual regression tests — opt-in via the `@visual` tag.
 *
 * Each spec captures a full-page screenshot and compares against a
 * baseline stored in test/electron-e2e/__screenshots__/. Pass-threshold
 * is generous (10 % of pixels may differ) — the goal is to catch
 * catastrophic regressions (blank page, unmounted Vue tree, broken CSS,
 * errored dialog) NOT pixel-perfect rendering.
 *
 * Baselines are platform-specific: Playwright suffixes them with
 * `-darwin`/`-linux`/`-win32`. Generate locally with:
 *
 *     npm run test:e2e:electron:update
 *
 * The CI workflow excludes @visual to avoid flaky cross-OS pixel diffs.
 */

test.describe("Visual snapshots @visual", () => {
  let empty: LaunchedApp | undefined;
  let seeded: LaunchedApp | undefined;

  test.beforeAll(async () => {
    empty = await launchApp("empty");
    seeded = await launchApp("seeded");
  });

  test.afterAll(async () => {
    await closeApp(empty);
    await closeApp(seeded);
  });

  test("empty: welcome screen", async () => {
    const { page } = empty!;
    await page.getByText("Welcome to", { exact: false }).waitFor();
    await settleForScreenshot(page);
    await expect(page).toHaveScreenshot("empty-welcome.png");
  });

  test("empty: settings dialog (General tab)", async () => {
    const { page } = empty!;
    await page.locator("button.sidebar__icon-btn[title^='Open the Settings dialog']").click();
    await expect(page.locator(".overlay h2")).toHaveText("Settings");
    await settleForScreenshot(page);
    await expect(page).toHaveScreenshot("empty-settings-general.png");
    await page.locator(".overlay").getByRole("button", { name: "Cancel" }).first().click();
  });

  test("empty: help dialog", async () => {
    const { page } = empty!;
    await page.locator("button.sidebar__icon-btn[title^='Open the Help dialog']").click();
    await page.getByText("Getting Started").waitFor();
    await settleForScreenshot(page);
    await expect(page).toHaveScreenshot("empty-help.png");
    await page.locator(".overlay").getByRole("button", { name: "Close" }).first().click();
  });

  test("empty: new workspace template picker", async () => {
    const { page } = empty!;
    await page.locator("button.sidebar__icon-btn[title^='Open the New Workspace picker']").click();
    await page.getByText("Empty Workspace").waitFor();
    await settleForScreenshot(page);
    await expect(page).toHaveScreenshot("empty-new-workspace.png");
    await page.locator(".overlay").getByRole("button", { name: "Close" }).first().click();
  });

  test("seeded: sidebar with three workspaces", async () => {
    const { page } = seeded!;
    await page.getByText("Frontend App").waitFor();
    await settleForScreenshot(page);
    await expect(page).toHaveScreenshot("seeded-sidebar.png");
  });
});
