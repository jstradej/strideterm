import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Mobile / responsive E2E tests for the Azure DevOps Inbox pane. Drives the
 * mocked azure-pr-inbox fixture so we can assert layout behaviour without
 * standing up a real Azure DevOps backend.
 *
 * The viewport sizes mirror the breakpoints we use in CSS:
 *   - Desktop (1280×720): toolbar inline, tabs inline
 *   - Mobile portrait (390×844): tabs/actions collapse into popovers
 *   - Mobile landscape (844×390): same compound (max-height) breakpoint
 */

test.describe("Azure DevOps Inbox — mocked", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "azure-pr-inbox" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("loads workspace and shows PR rows from the mock inbox", async ({ page }) => {
    await openApp(page, mock);
    // Default tab is "Needs attention", which has 2 mocked PRs.
    await expect(page.getByText("Add tunnel URL command for Telegram bot")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Refactor azure-devops-manager poll loop")).toBeVisible();
    assertNoErrors(page);
  });

  test("desktop viewport shows tabs and actions inline (no popover triggers)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openApp(page, mock);
    await expect(page.locator(".azure-inbox__tabs-trigger")).toBeHidden();
    await expect(page.locator(".azure-inbox__menu-trigger")).toBeHidden();
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeVisible();
    assertNoErrors(page);
  });

  test("portrait mobile viewport collapses chrome into popover triggers", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    // Wait for inbox to render
    await expect(page.getByText("Add tunnel URL command for Telegram bot")).toBeVisible({ timeout: 10_000 });
    // Both popover triggers visible at the top
    await expect(page.locator(".azure-inbox__tabs-trigger")).toBeVisible();
    await expect(page.locator(".azure-inbox__menu-trigger")).toBeVisible();
    // Toolbar is collapsed — no inline Refresh button
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeHidden();
    assertNoErrors(page);
  });

  test("clicking ⋮ Actions opens the actions popover with Refresh + Add connection", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Add tunnel URL command for Telegram bot")).toBeVisible({ timeout: 10_000 });
    await page.locator(".azure-inbox__menu-trigger").click();
    // Refresh + Add connection now visible inside the popover
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Add connection/ })).toBeVisible();
    // Backdrop dismisses the popover
    await page.locator(".azure-inbox__menu-backdrop").click();
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeHidden();
    assertNoErrors(page);
  });

  test("clicking the tabs trigger opens the tabs popover and selecting a tab closes it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Add tunnel URL command for Telegram bot")).toBeVisible({ timeout: 10_000 });
    await page.locator(".azure-inbox__tabs-trigger").click();
    // Stacked tab list now visible — has the typical tab labels
    const popover = page.locator(".azure-inbox--tabs-menu-open .azure-inbox__toolbar");
    await expect(popover).toBeVisible();
    await expect(popover.getByRole("button", { name: /^My PRs/ })).toBeVisible();
    // Pick "My PRs" → popover dismisses, only my-PR rows remain
    await popover.getByRole("button", { name: /^My PRs/ }).click();
    await expect(popover).toBeHidden();
    await expect(page.getByText("Refactor azure-devops-manager poll loop")).toBeVisible();
    // The reviewer-only PR shouldn't show under My PRs
    await expect(page.getByText("Documentation polish for Worktrees tab")).toBeHidden();
    assertNoErrors(page);
  });

  test("PR row layout switches to stacked (action buttons full-width)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    const firstRow = page.locator(".azure-pr-row").first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    const flexDirection = await firstRow.evaluate((el) => getComputedStyle(el).flexDirection);
    // Mobile rule sets flex-direction: column so the action cluster gets a
    // full row to itself instead of being squeezed off-screen.
    expect(flexDirection).toBe("column");
    assertNoErrors(page);
  });
});
