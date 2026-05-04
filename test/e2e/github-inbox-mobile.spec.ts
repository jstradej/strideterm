import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Mobile / responsive E2E tests for the GitHub Inbox pane. Mirrors the
 * Azure mobile spec but exercises GitHubInboxPane.vue + the .azure-inbox
 * shell classes (the GitHub pane reuses the same chrome).
 */

test.describe("GitHub Inbox — mocked", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "github-pr-inbox-rich" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("loads workspace and shows PR rows from the mocked inbox", async ({ page }) => {
    await openApp(page, mock);
    // Default tab is "All" for GitHubInboxPane; the rich fixture seeds 3
    // items in recentlyUpdated.
    await expect(page.getByText("Mobile-friendly Azure DevOps + GitHub panes")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Add /tunnel Telegram command")).toBeVisible();
    await expect(page.getByText("Fix WebGL fallback on integrated GPUs")).toBeVisible();
    assertNoErrors(page);
  });

  test("desktop viewport shows tabs and actions inline (no popover triggers)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openApp(page, mock);
    await expect(page.locator(".azure-inbox__tabs-trigger")).toBeHidden();
    await expect(page.locator(".azure-inbox__menu-trigger")).toBeHidden();
    // The desktop inline toolbar carries Refresh + Add connection.
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeVisible();
    assertNoErrors(page);
  });

  test("portrait mobile viewport collapses chrome into popover triggers", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Mobile-friendly Azure DevOps + GitHub panes")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".azure-inbox__tabs-trigger")).toBeVisible();
    await expect(page.locator(".azure-inbox__menu-trigger")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeHidden();
    assertNoErrors(page);
  });

  test("clicking ⋮ Actions opens the GitHub actions popover", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Mobile-friendly Azure DevOps + GitHub panes")).toBeVisible({ timeout: 10_000 });
    await page.locator(".azure-inbox__menu-trigger").click();
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Add connection/ })).toBeVisible();
    // Backdrop dismisses
    await page.locator(".azure-inbox__menu-backdrop").click();
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeHidden();
    assertNoErrors(page);
  });

  test("clicking the tabs trigger opens tabs popover and switches to My PRs", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Mobile-friendly Azure DevOps + GitHub panes")).toBeVisible({ timeout: 10_000 });
    await page.locator(".azure-inbox__tabs-trigger").click();
    const popover = page.locator(".azure-inbox--tabs-menu-open .azure-inbox__toolbar");
    await expect(popover).toBeVisible();
    await popover.getByRole("button", { name: /^My PRs/ }).click();
    await expect(popover).toBeHidden();
    // Only the "author"-role PR survives the My PRs filter.
    await expect(page.getByText("Fix WebGL fallback on integrated GPUs")).toBeVisible();
    await expect(page.getByText("Mobile-friendly Azure DevOps + GitHub panes")).toBeHidden();
    assertNoErrors(page);
  });

  test("PR row layout switches to stacked (action buttons full-width)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    const firstRow = page.locator(".azure-pr-row").first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    const flexDirection = await firstRow.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(flexDirection).toBe("column");
    assertNoErrors(page);
  });
});
