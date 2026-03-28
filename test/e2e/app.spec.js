import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";

/**
 * E2E tests for strIDEterm using mock server fixtures.
 *
 * The mock server proxies Vite for static content and serves fixture
 * data for /api and /ws, so the frontend loads and connects from a
 * single origin — exactly like the real remote-server.js works.
 */

let portCounter = 4100;
function nextPort() { return portCounter++; }

/** Navigate to the mock server and wait for the app to render. */
async function openApp(page, mock) {
  await page.goto(`${mock.url}/?token=${mock.token}`);
  await expect(page.getByRole("heading", { name: "strIDEterm", exact: true })).toBeVisible();
}

test.describe("Empty state", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "empty-state", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("shows sidebar with app title", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByRole("heading", { name: "strIDEterm", exact: true })).toBeVisible();
  });

  test("shows add-workspace button in sidebar", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.locator("button[title='Add workspace']")).toBeVisible();
  });

  test("shows empty workspace placeholder", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Select or create a workspace")).toBeVisible();
  });

  test("shows welcome create-workspace button", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Create your first workspace")).toBeVisible();
  });

  test("notification bell is present", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.locator("button[title='Notifications']")).toBeVisible();
  });

  test("version from fixture is displayed", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("1.3.1-test")).toBeVisible();
  });
});

test.describe("Multi-workspace state", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "multi-workspace", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("renders all workspaces in sidebar", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Frontend App")).toBeVisible();
    await expect(page.getByText("Backend API")).toBeVisible();
    await expect(page.getByText("Infrastructure")).toBeVisible();
  });

  test("active workspace shows panel tabs", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Shell")).toBeVisible();
    await expect(page.getByText("Claude Code")).toBeVisible();
  });

  test("settings button opens dialog", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Settings']").click();
    await expect(page.locator(".overlay h2")).toBeVisible({ timeout: 3_000 });
  });

  test("sidebar shows profile selector", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Default")).toBeVisible();
  });
});
