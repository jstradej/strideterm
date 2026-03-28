import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";

/**
 * Screen-specific E2E tests verifying that the app loads correctly with
 * different fixture data. Tests focus on what's visible by default
 * (sidebar, workspace list, basic pane presence) to catch regressions.
 */

let portCounter = 4300;
function nextPort() { return portCounter++; }

async function openApp(page, mock) {
  await page.goto(`${mock.url}/?token=${mock.token}`);
  await expect(page.getByRole("heading", { name: "strIDEterm", exact: true })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Docker workspace fixture
// ---------------------------------------------------------------------------
test.describe("Docker workspace", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "docker-containers", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("workspace loads without errors", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Docker Services")).toBeVisible();
  });

  test("shell tab is visible for active workspace", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Shell")).toBeVisible();
  });

  test("no JS errors on page", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await openApp(page, mock);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Git merge conflict fixture
// ---------------------------------------------------------------------------
test.describe("Git merge conflict workspace", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "git-merge-conflict", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("workspace loads without errors", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Web App")).toBeVisible();
  });

  test("panels are visible", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Shell")).toBeVisible();
    await expect(page.getByText("Claude Code")).toBeVisible();
  });

  test("no JS errors with conflict state in payload", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await openApp(page, mock);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GitHub PR inbox fixture
// ---------------------------------------------------------------------------
test.describe("GitHub PR inbox workspace", () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockServer({ fixture: "github-pr-inbox", port: nextPort() }); });
  test.afterAll(async () => { await mock?.close(); });

  test("workspace loads without errors", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Main Project")).toBeVisible();
  });

  test("github connection indicator visible in sidebar", async ({ page }) => {
    await openApp(page, mock);
    // GitHub section should be present when connections exist
    await expect(page.getByText("GitHub")).toBeVisible({ timeout: 5_000 });
  });

  test("no JS errors with PR inbox data", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await openApp(page, mock);
    expect(errors).toEqual([]);
  });
});

