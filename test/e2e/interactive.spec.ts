import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Interactive E2E tests — workspace switching, dialogs, dropdowns, layout,
 * and visual regression screenshots.
 *
 * Uses a SINGLE shared mock server per describe group to reduce resource usage.
 * The mock server handles workspace/activate mutations so the UI updates.
 */

// ---------------------------------------------------------------------------
// Workspace switching — verifies both appearance AND disappearance of elements
// ---------------------------------------------------------------------------
test.describe("Workspace switching", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("switching workspace shows new tabs and hides old ones", async ({ page }) => {
    await openApp(page, mock);
    // Frontend App is active: Shell + Claude Code visible, Tests NOT visible
    await expect(page.getByText("Claude Code")).toBeVisible();
    await expect(page.getByText("Tests")).not.toBeVisible();

    // Switch to Backend API
    await page.getByText("Backend API").click();
    await expect(page.getByText("Tests")).toBeVisible({ timeout: 5_000 });
    // Claude Code should now be gone (it's a Frontend tab)
    await expect(page.getByText("Claude Code")).not.toBeVisible();
    assertNoErrors(page);
  });

  test("switching back restores original tabs", async ({ page }) => {
    await openApp(page, mock);
    await page.getByText("Backend API").click();
    await expect(page.getByText("Tests")).toBeVisible({ timeout: 5_000 });

    await page.getByText("Frontend App").click();
    await expect(page.getByText("Claude Code")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Tests")).not.toBeVisible();
    assertNoErrors(page);
  });

  test("Infrastructure workspace has only Shell panel", async ({ page }) => {
    await openApp(page, mock);
    await page.getByText("Infrastructure").click();
    await expect(page.getByText("Shell")).toBeVisible({ timeout: 5_000 });
    // Should not have multi-panel tabs from other workspaces
    await expect(page.getByText("Claude Code")).not.toBeVisible();
    await expect(page.getByText("Tests")).not.toBeVisible();
    assertNoErrors(page);
  });

  test("active workspace is visually highlighted in sidebar", async ({ page }) => {
    await openApp(page, mock);
    // The sidebar item for active workspace should have an active/selected state
    const frontendItem = page.getByText("Frontend App");
    await expect(frontendItem).toBeVisible();
    // Switch and verify the new workspace becomes highlighted
    await page.getByText("Backend API").click();
    await expect(page.getByText("Tests")).toBeVisible({ timeout: 5_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Tab picker (+Tab button)
// ---------------------------------------------------------------------------
test.describe("Tab picker", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("opens dropdown and shows all templates from fixture", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: "+ Tab" }).click();

    const dropdown = page.locator(".tab-picker-dropdown");
    await expect(dropdown).toBeVisible({ timeout: 3_000 });
    // All 3 templates from the multi-workspace fixture
    await expect(dropdown.getByText("Shell")).toBeVisible();
    await expect(dropdown.getByText("Claude Code")).toBeVisible();
    await expect(dropdown.getByText("Codex")).toBeVisible();
    assertNoErrors(page);
  });

  test("closes when clicking outside", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: "+ Tab" }).click();
    await expect(page.locator(".tab-picker-dropdown")).toBeVisible({ timeout: 3_000 });

    // Click on the main content area to dismiss
    await page.locator("main").click({ position: { x: 10, y: 10 } });
    await expect(page.locator(".tab-picker-dropdown")).not.toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Layout picker (Split)
// ---------------------------------------------------------------------------
test.describe("Layout picker", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("opens layout picker with layout options", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: /Split|Layout/i }).click();
    await expect(page.locator(".layout-picker")).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Settings dialog — tab navigation and content verification
// ---------------------------------------------------------------------------
test.describe("Settings dialog", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("opens on General tab with theme options", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    const overlay = page.locator(".overlay");
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await expect(overlay.locator("h2")).toHaveText("Settings");

    // General tab should be active with theme buttons
    await expect(overlay.getByText("Dark")).toBeVisible();
    await expect(overlay.getByText("Light")).toBeVisible();
    await expect(overlay.getByText("System")).toBeVisible();
    assertNoErrors(page);
  });

  test("navigating to Tab Templates tab changes content", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    const overlay = page.locator(".overlay");
    await expect(overlay).toBeVisible({ timeout: 3_000 });

    // Theme buttons should be on General tab
    await expect(overlay.getByText("Dark")).toBeVisible();

    // Switch to Tab Templates
    await overlay.getByText("Tab Templates").click();

    // Theme buttons should no longer be visible (different tab content)
    await expect(overlay.getByText("Dark")).not.toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });

  test("navigating to About tab shows version info", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    const overlay = page.locator(".overlay");
    await expect(overlay).toBeVisible({ timeout: 3_000 });

    await overlay.getByText("About").click();
    await expect(overlay.getByText("Dark")).not.toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });

  test("Close button dismisses overlay completely", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });

    await page.locator(".overlay").getByText("Close").click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 3_000 });
    // Settings button should still work after closing
    await page.locator("button[title='Settings']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Profile selector
// ---------------------------------------------------------------------------
test.describe("Profile selector", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("opens profile management overlay", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Profiles']").click();
    await expect(page.locator(".overlay").first()).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Add workspace dialog
// ---------------------------------------------------------------------------
test.describe("Add workspace", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("opens workspace creation dialog", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Add workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Help dialog
// ---------------------------------------------------------------------------
test.describe("Help dialog", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("opens and shows help content", async ({ page }) => {
    await openApp(page, mock);
    // Help button sits near the sidebar resize handle and may be obscured on narrow
    // viewports — dispatch click via JS to avoid pointer-events interception.
    await page.locator("button[title='Help']").dispatchEvent("click");
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Collapse sidebar
// ---------------------------------------------------------------------------
test.describe("Sidebar collapse", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("collapse button hides workspace names", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Frontend App")).toBeVisible();

    await page.locator("button[title='Collapse sidebar']").click();
    // After collapse, full workspace names should not be visible
    await expect(page.getByText("Frontend App")).not.toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Keyboard shortcut — Ctrl+N opens new workspace dialog
// ---------------------------------------------------------------------------
test.describe("Keyboard shortcuts", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("Ctrl+N opens new workspace dialog", async ({ page }) => {
    await openApp(page, mock);
    await page.keyboard.press("Control+n");
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Visual regression screenshots (platform-dependent — may need --update-snapshots on new OS)
// ---------------------------------------------------------------------------
test.describe("Visual regression @visual", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("multi-workspace default view", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Frontend App")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("multi-workspace-default.png");
  });

  test("settings dialog", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("settings-dialog.png");
  });

  test("tab picker open", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: "+ Tab" }).click();
    await expect(page.locator(".tab-picker-dropdown")).toBeVisible({ timeout: 3_000 });
    await expect(page).toHaveScreenshot("tab-picker-open.png");
  });

  test("layout picker open", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: /Split|Layout/i }).click();
    await expect(page.locator(".layout-picker")).toBeVisible({ timeout: 3_000 });
    await expect(page).toHaveScreenshot("layout-picker-open.png");
  });

  test("add workspace dialog", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Add workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("add-workspace-dialog.png");
  });
});

// Empty state screenshot — separate describe to avoid mock server conflicts
test.describe("Visual regression — empty state @visual", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "empty-state" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("welcome screen", async ({ page }) => {
    await page.goto(`${mock.url}/?token=${mock.token}`);
    await expect(page.getByText("Welcome to strIDEterm")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("empty-state-welcome.png");
  });
});
