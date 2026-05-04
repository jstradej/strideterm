import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Mobile / responsive E2E tests for GitHub PR review.
 *
 * AzureReviewPane is provider-aware (it handles both Azure and GitHub
 * reviews via review.provider on the workspace) — same chrome, same
 * mobile breakpoints. This spec uses the github-pr-review fixture which
 * pre-positions a workspace with review.provider="github" so the same
 * popover triggers we asserted on the Azure side are exercised against
 * GitHub PR data.
 */

test.describe("GitHub Review pane — mocked", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "github-pr-review" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("loads the GitHub PR detail with title + repo + branch", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Mobile-friendly Azure DevOps + GitHub panes")).toBeVisible({ timeout: 10_000 });
    // The branch chip uses the github source ref (no refs/heads/ prefix).
    await expect(page.getByText(/mobilnivzled/)).toBeVisible();
    assertNoErrors(page);
  });

  test("desktop viewport shows Refresh inline (no popover triggers)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openApp(page, mock);
    await expect(page.getByText("Mobile-friendly Azure DevOps + GitHub panes")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".review-shell__menu-trigger")).toBeHidden();
    await expect(page.locator(".review-shell__tabs-trigger")).toBeHidden();
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeVisible();
    assertNoErrors(page);
  });

  test("portrait mobile collapses the GitHub review chrome", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Mobile-friendly Azure DevOps + GitHub panes")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".review-shell__menu-trigger")).toBeVisible();
    await expect(page.locator(".review-shell__tabs-trigger")).toBeVisible();
    assertNoErrors(page);
  });

  test("clicking ⋮ Actions surfaces Refresh + Browser for the GitHub PR", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Mobile-friendly Azure DevOps + GitHub panes")).toBeVisible({ timeout: 10_000 });
    await page.locator(".review-shell__menu-trigger").click();
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Browser/ })).toBeVisible();
    await page.locator(".review-shell__menu-backdrop").click();
    await expect(page.getByRole("button", { name: /^Refresh/ })).toBeHidden();
    assertNoErrors(page);
  });

  test("subtabs popover surfaces Pipelines and Files for the GitHub PR", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, mock);
    await expect(page.getByText("Mobile-friendly Azure DevOps + GitHub panes")).toBeVisible({ timeout: 10_000 });
    await page.locator(".review-shell__tabs-trigger").click();
    const popover = page.locator(".review-shell--tabs-menu-open .review-subtabs");
    await expect(popover).toBeVisible();
    await expect(popover.getByRole("button", { name: /^Files/ })).toBeVisible();
    await expect(popover.getByRole("button", { name: /^Pipelines/ })).toBeVisible();
    assertNoErrors(page);
  });
});
