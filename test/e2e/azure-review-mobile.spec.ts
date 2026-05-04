import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Mobile / responsive E2E tests for the Azure DevOps Review pane. The
 * azure-pr-review fixture pre-positions a workspace whose activeViewId
 * is "review:ws-azure-review", so the review pane mounts on bootstrap
 * (no need to drive the inbox → click-Review → wait-for-pane workflow,
 * which would require a richer backend mock).
 */

test.describe("Azure DevOps Review pane — mocked", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "azure-pr-review" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("loads the PR detail with title, branch refs, and reviewer chips", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Add tunnel URL command for Telegram bot")).toBeVisible({ timeout: 10_000 });
    // Branch chip rendering uses `${source} → ${target}`; assert the source half.
    await expect(page.getByText(/feat\/telegram-tunnel/)).toBeVisible();
    assertNoErrors(page);
  });

  test("desktop viewport keeps the review chrome inline (no popover triggers)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openApp(page, mock);
    await expect(page.getByText("Add tunnel URL command for Telegram bot")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".review-shell__menu-trigger")).toBeHidden();
    await expect(page.locator(".review-shell__tabs-trigger")).toBeHidden();
    // The review toolbar carries Refresh + Browser inline on desktop.
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeVisible();
    assertNoErrors(page);
  });

  test("portrait mobile collapses the review chrome into popover triggers", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Add tunnel URL command for Telegram bot")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".review-shell__menu-trigger")).toBeVisible();
    await expect(page.locator(".review-shell__tabs-trigger")).toBeVisible();
    // Inline Refresh button is gone — it lives in the popover now.
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeHidden();
    assertNoErrors(page);
  });

  test("clicking ⋮ Actions opens the review actions popover", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Add tunnel URL command for Telegram bot")).toBeVisible({ timeout: 10_000 });
    await page.locator(".review-shell__menu-trigger").click();
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Browser/ })).toBeVisible();
    // Backdrop dismisses
    await page.locator(".review-shell__menu-backdrop").click();
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeHidden();
    assertNoErrors(page);
  });

  test("clicking the tabs trigger opens the review subtabs popover", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Add tunnel URL command for Telegram bot")).toBeVisible({ timeout: 10_000 });
    await page.locator(".review-shell__tabs-trigger").click();
    const popover = page.locator(".review-shell--tabs-menu-open .review-subtabs");
    await expect(popover).toBeVisible();
    // Subtab labels: Summary, Files, Comments, Conflicts, Pipelines, Agent
    await expect(popover.getByRole("button", { name: /^Files/ })).toBeVisible();
    await expect(popover.getByRole("button", { name: /^Pipelines/ })).toBeVisible();
    // Switching tab dismisses the popover.
    await popover.getByRole("button", { name: /^Files/ }).click();
    await expect(popover).toBeHidden();
    assertNoErrors(page);
  });

  test("Files tab split stacks vertically in portrait (file tree on top, diff below)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Add tunnel URL command for Telegram bot")).toBeVisible({ timeout: 10_000 });
    // Switch to Files tab via the tabs popover.
    await page.locator(".review-shell__tabs-trigger").click();
    const popover = page.locator(".review-shell--tabs-menu-open .review-subtabs");
    await popover.getByRole("button", { name: /^Files/ }).click();
    // Files split exists and is laid out as a single grid column on portrait.
    const split = page.locator(".review-files-split").first();
    await expect(split).toBeVisible({ timeout: 10_000 });
    const gridColumns = await split.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    // Single-column grid (rather than the desktop "minmax(260px, 0.38fr) minmax(0, 1fr)").
    // We just check that there's only ONE track value (no space between numbers).
    const trackCount = gridColumns.trim().split(/\s+/).length;
    expect(trackCount).toBe(1);
    assertNoErrors(page);
  });
});
