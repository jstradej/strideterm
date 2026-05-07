import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Core UI E2E tests — empty state and multi-workspace baseline.
 */

test.describe("Empty state", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "empty-state" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("shows sidebar with app title and core buttons", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByRole("heading", { name: "strIDEterm", exact: true })).toBeVisible();
    await expect(page.locator("button.sidebar__icon-btn[title^='Open the New Workspace picker']")).toBeVisible();
    await expect(page.locator("button.sidebar__icon-btn[title^='Open the Settings dialog']")).toBeVisible();
    await expect(page.locator("button.sidebar__icon-btn[title^='Open the Help dialog']")).toBeVisible();
    await expect(page.locator("button[data-role='notification-bell']")).toBeVisible();
    assertNoErrors(page);
  });

  test("shows empty workspace placeholder and welcome screen", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Select or create a workspace")).toBeVisible();
    await expect(page.getByText("Welcome to strIDEterm")).toBeVisible();
    await expect(page.getByText("Create your first workspace")).toBeVisible();
    assertNoErrors(page);
  });

  test("version from fixture is displayed", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("1.3.1-test")).toBeVisible();
    assertNoErrors(page);
  });

  test("no workspaces listed in sidebar", async ({ page }) => {
    await openApp(page, mock);
    // Sidebar should NOT show any workspace entries — only the profile selector
    await expect(page.getByText("Frontend App")).not.toBeVisible();
    await expect(page.getByText("Backend API")).not.toBeVisible();
    assertNoErrors(page);
  });
});

test.describe("Multi-workspace state", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("renders all workspaces in sidebar", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Frontend App")).toBeVisible();
    await expect(page.getByText("Backend API")).toBeVisible();
    await expect(page.getByText("Infrastructure")).toBeVisible();
    assertNoErrors(page);
  });

  test("active workspace shows its panel tabs and not other workspace tabs", async ({ page }) => {
    await openApp(page, mock);
    // Frontend App (active) has Shell, Claude Code, Dev Server panels
    await expect(page.getByText("Shell")).toBeVisible();
    await expect(page.getByText("Claude Code")).toBeVisible();
    // Backend API's "Tests" panel should NOT be visible when Frontend is active
    await expect(page.getByText("Tests")).not.toBeVisible();
    assertNoErrors(page);
  });

  test("settings dialog opens and closes cleanly", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title^='Open the Settings dialog']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".overlay h2")).toHaveText("Settings");
    // Close it
    await page.locator(".overlay").getByText("Close").click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });

  test("sidebar shows active profile name", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.locator("button.profile-bar[title^='Open the Profiles dialog']")).toBeVisible();
    await expect(page.getByText("Default")).toBeVisible();
    assertNoErrors(page);
  });
});
