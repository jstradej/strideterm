import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Screen-specific E2E tests — verify the app handles different fixture
 * payloads without JS errors and renders the expected UI.
 */

test.describe("Docker workspace", () => {
  let mock;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "docker-containers" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("loads workspace and shows expected UI elements", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Docker Services")).toBeVisible();
    await expect(page.getByText("Shell")).toBeVisible();
    // Should NOT show workspaces from other fixtures
    await expect(page.getByText("Frontend App")).not.toBeVisible();
    assertNoErrors(page);
  });
});

test.describe("Git merge conflict workspace", () => {
  let mock;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "git-merge-conflict" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("loads workspace with conflict data without errors", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Web App")).toBeVisible();
    await expect(page.getByText("Shell")).toBeVisible();
    await expect(page.getByText("Claude Code")).toBeVisible();
    assertNoErrors(page);
  });
});

test.describe("GitHub PR inbox workspace", () => {
  let mock;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "github-pr-inbox" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("loads workspace with PR data and shows GitHub section", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Main Project")).toBeVisible();
    await expect(page.getByText("GitHub")).toBeVisible({ timeout: 5_000 });
    assertNoErrors(page);
  });
});
