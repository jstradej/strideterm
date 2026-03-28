import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";

/**
 * Interactive E2E tests — buttons, dialogs, workspace switching, layout,
 * tab picker, and visual screenshot regression.
 *
 * Uses the multi-workspace fixture with stateful mock server so that
 * workspace activation and settings mutations are reflected in the UI.
 */

let portCounter = 4400;
function nextPort() { return portCounter++; }

async function openApp(page, mock) {
  await page.goto(`${mock.url}/?token=${mock.token}`);
  await expect(page.getByRole("heading", { name: "strIDEterm", exact: true })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Visual screenshots — golden file regression
// ---------------------------------------------------------------------------
test.describe("Visual regression", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "multi-workspace", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("multi-workspace default view", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Frontend App")).toBeVisible();
    await page.waitForTimeout(500); // let animations settle
    await expect(page).toHaveScreenshot("multi-workspace-default.png");
  });

  test("settings dialog open", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    await expect(page.locator(".overlay h2")).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("settings-dialog.png");
  });
});

// ---------------------------------------------------------------------------
// Workspace switching
// ---------------------------------------------------------------------------
test.describe("Workspace switching", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "multi-workspace", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("clicking another workspace switches the active view", async ({ page }) => {
    await openApp(page, mock);
    // Initially Frontend App is active
    await expect(page.getByText("Shell")).toBeVisible();
    await expect(page.getByText("Claude Code")).toBeVisible();

    // Click Backend API workspace
    await page.getByText("Backend API").click();
    // Wait for the UI to update — backend has "Tests" panel
    await expect(page.getByText("Tests")).toBeVisible({ timeout: 5_000 });
  });

  test("switching back to original workspace restores tabs", async ({ page }) => {
    await openApp(page, mock);
    // Switch to Backend
    await page.getByText("Backend API").click();
    await expect(page.getByText("Tests")).toBeVisible({ timeout: 5_000 });

    // Switch back to Frontend
    await page.getByText("Frontend App").click();
    await expect(page.getByText("Claude Code")).toBeVisible({ timeout: 5_000 });
  });

  test("switching to Infrastructure workspace shows single panel", async ({ page }) => {
    await openApp(page, mock);
    await page.getByText("Infrastructure").click();
    await expect(page.getByText("Shell")).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// +Tab button and tab picker
// ---------------------------------------------------------------------------
test.describe("Tab picker", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "multi-workspace", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("+Tab button opens tab picker dropdown", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: "+ Tab" }).click();
    // Tab picker dropdown should appear with template options
    await expect(page.locator(".tab-picker-dropdown")).toBeVisible({ timeout: 3_000 });
  });

  test("tab picker shows available templates", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: "+ Tab" }).click();
    await expect(page.locator(".tab-picker-dropdown")).toBeVisible({ timeout: 3_000 });
    // Templates from fixture
    await expect(page.locator(".tab-picker-dropdown").getByText("Shell")).toBeVisible();
    await expect(page.locator(".tab-picker-dropdown").getByText("Claude Code")).toBeVisible();
    await expect(page.locator(".tab-picker-dropdown").getByText("Codex")).toBeVisible();
  });

  test("tab picker screenshot", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: "+ Tab" }).click();
    await expect(page.locator(".tab-picker-dropdown")).toBeVisible({ timeout: 3_000 });
    await expect(page).toHaveScreenshot("tab-picker-open.png");
  });
});

// ---------------------------------------------------------------------------
// Layout picker (Split)
// ---------------------------------------------------------------------------
test.describe("Layout picker", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "multi-workspace", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("Layout/Split button opens layout picker", async ({ page }) => {
    await openApp(page, mock);
    // The button shows "Split" or "Layout"
    const layoutBtn = page.locator("button", { hasText: /Split|Layout/i });
    await layoutBtn.click();
    // Layout picker should appear
    await expect(page.locator(".layout-picker")).toBeVisible({ timeout: 3_000 });
  });

  test("layout picker screenshot", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: /Split|Layout/i }).click();
    await expect(page.locator(".layout-picker")).toBeVisible({ timeout: 3_000 });
    await expect(page).toHaveScreenshot("layout-picker-open.png");
  });
});

// ---------------------------------------------------------------------------
// Settings dialog tabs
// ---------------------------------------------------------------------------
test.describe("Settings dialog navigation", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "multi-workspace", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("settings opens on General tab", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    await expect(page.locator(".overlay")).toBeVisible();
    await expect(page.getByText("General")).toBeVisible();
  });

  test("settings has theme options", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    await expect(page.locator(".overlay")).toBeVisible();
    await expect(page.getByText("Dark")).toBeVisible();
    await expect(page.getByText("Light")).toBeVisible();
    await expect(page.getByText("System")).toBeVisible();
  });

  test("settings can navigate to Tab Templates tab", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    await expect(page.locator(".overlay")).toBeVisible();
    await page.getByText("Tab Templates").click();
    await expect(page.getByText("Tab Templates")).toBeVisible();
  });

  test("settings Close button dismisses dialog", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    await expect(page.locator(".overlay")).toBeVisible();
    await page.getByText("Close").click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// Profile selector
// ---------------------------------------------------------------------------
test.describe("Profile selector", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "multi-workspace", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("Profiles button opens profile dialog/menu", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Profiles']").click();
    // Should show profile management UI (overlay or dropdown)
    await expect(page.locator(".overlay, .profile-menu, .profile-dialog").first()).toBeVisible({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// Add workspace flow
// ---------------------------------------------------------------------------
test.describe("Add workspace", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "multi-workspace", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("Add workspace button opens workspace dialog", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Add workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
  });

  test("add workspace dialog screenshot", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Add workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("add-workspace-dialog.png");
  });
});

// ---------------------------------------------------------------------------
// Help dialog
// ---------------------------------------------------------------------------
test.describe("Help dialog", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "multi-workspace", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("Help button opens help overlay", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Help']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// Empty state visual screenshot (separate mock to avoid connection issues)
// ---------------------------------------------------------------------------
test.describe("Empty state visual", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "empty-state", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("welcome screen screenshot", async ({ page }) => {
    await page.goto(`${mock.url}/?token=${mock.token}`);
    await expect(page.getByText("Welcome to strIDEterm")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("empty-state-welcome.png");
  });
});
