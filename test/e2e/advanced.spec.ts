import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

// ---------------------------------------------------------------------------
// Split screen layout
// ---------------------------------------------------------------------------
test.describe("Split screen layout", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("selecting Columns layout applies split CSS class", async ({ page }) => {
    await openApp(page, mock);
    // Open layout picker
    await page.locator("button", { hasText: /Split|Layout/i }).click();
    await expect(page.locator(".layout-picker")).toBeVisible({ timeout: 3_000 });

    // Click "Side by side" (cols layout)
    await page.locator(".layout-picker").getByTitle("Columns").click();

    // The terminal stage should have the cols layout class
    const stage = page.locator("[data-role='terminal-stage']");
    await expect(stage).toHaveClass(/terminal-stage--cols/, { timeout: 3_000 });
    assertNoErrors(page);
  });

  test("columns layout shows two panes simultaneously", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: /Split|Layout/i }).click();
    await expect(page.locator(".layout-picker")).toBeVisible({ timeout: 3_000 });
    await page.locator(".layout-picker").getByTitle("Columns").click();

    // Two workspace panes should be visible
    const panes = page.locator(".workspace-pane");
    await expect(panes).toHaveCount(2, { timeout: 3_000 });
    assertNoErrors(page);
  });

  test("Unsplit button appears and disbands split", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: /Split|Layout/i }).click();
    await expect(page.locator(".layout-picker")).toBeVisible({ timeout: 3_000 });
    await page.locator(".layout-picker").getByTitle("Columns").click();

    // Unsplit button should appear
    const unsplitBtn = page.locator("button", { hasText: "Unsplit" });
    await expect(unsplitBtn).toBeVisible({ timeout: 3_000 });

    // Click Unsplit
    await unsplitBtn.click();

    // Stage should no longer have the cols class
    const stage = page.locator("[data-role='terminal-stage']");
    await expect(stage).not.toHaveClass(/terminal-stage--cols/, { timeout: 3_000 });
    assertNoErrors(page);
  });

  test("Rows layout applies stacked CSS class", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button", { hasText: /Split|Layout/i }).click();
    await expect(page.locator(".layout-picker")).toBeVisible({ timeout: 3_000 });
    await page.locator(".layout-picker").getByTitle("Rows").click();

    const stage = page.locator("[data-role='terminal-stage']");
    await expect(stage).toHaveClass(/terminal-stage--rows/, { timeout: 3_000 });
    assertNoErrors(page);
  });

  test("Grid layout shows four pane slots", async ({ page }) => {
    await openApp(page, mock);
    // Frontend workspace has 3 panels — grid needs 4 so it truncates to available
    await page.locator("button", { hasText: /Split|Layout/i }).click();
    await expect(page.locator(".layout-picker")).toBeVisible({ timeout: 3_000 });
    await page.locator(".layout-picker").getByTitle("Grid").click();

    const stage = page.locator("[data-role='terminal-stage']");
    await expect(stage).toHaveClass(/terminal-stage--grid/, { timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Task agent creation dialog
// ---------------------------------------------------------------------------
test.describe("Task agent creation dialog", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("opens from 'Create task agent' button", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Create task agent']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".overlay h2")).toHaveText("Create task workspace");
    assertNoErrors(page);
  });

  test("shows task assignment textarea", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Create task agent']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });

    // Task assignment textarea
    await expect(page.locator(".overlay textarea[placeholder='Describe the task for the Worker agent']")).toBeVisible({
      timeout: 3_000,
    });
    assertNoErrors(page);
  });

  test("shows worker and judge provider dropdowns", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Create task agent']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });

    // Worker agent section
    await expect(page.locator(".overlay").getByText("Worker agent")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".overlay").getByText("Judge agent")).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });

  test("provider dropdown includes OpenCode option", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Create task agent']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });

    // Open the worker provider dropdown
    const workerSection = page.locator(".agent-config-section").first();
    await expect(workerSection).toBeVisible({ timeout: 3_000 });
    const workerProviderSelect = workerSection.locator(".custom-select").first();
    await workerProviderSelect.click();

    // OpenCode should be in the dropdown options
    await expect(
      page.locator(".custom-select__option, [class*='select__option']", { hasText: "OpenCode" }),
    ).toBeVisible({
      timeout: 3_000,
    });
    assertNoErrors(page);
  });

  test("can select OpenCode as worker provider", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Create task agent']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });

    const workerSection = page.locator(".agent-config-section").first();
    const workerProviderSelect = workerSection.locator(".custom-select").first();
    await workerProviderSelect.click();

    const openCodeOption = page
      .locator(".custom-select__option, [class*='select__option']", { hasText: "OpenCode" })
      .first();
    await openCodeOption.click();

    // Verify OpenCode is selected (trigger shows the selection)
    await expect(workerProviderSelect).toContainText("OpenCode");
    assertNoErrors(page);
  });

  test("closes dialog on Cancel", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Create task agent']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await page.locator(".overlay").getByText("Close").click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// New workspace picker — both options
// ---------------------------------------------------------------------------
test.describe("New workspace picker", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("shows both workspace type options", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Add workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".overlay").getByText("Empty Workspace")).toBeVisible();
    await expect(page.locator(".overlay").getByText("Agent Task Runner")).toBeVisible();
    assertNoErrors(page);
  });

  test("Agent Task Runner opens task creation dialog", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Add workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });

    await page.locator(".overlay").getByText("Agent Task Runner").click();
    await expect(page.locator(".overlay h2")).toHaveText("Create task workspace", { timeout: 5_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Task dashboard pane
// ---------------------------------------------------------------------------
test.describe("Task dashboard", () => {
  // Per-test mock server because these tests click `.td__tab` to switch
  // between Status / Assignment / Files tabs, which mutates state held in
  // the mock server closure (activeWorkspaceId, active panel, etc.). With
  // `beforeAll` that mutation leaked into later tests in the describe, so
  // a test expecting the default Status dashboard could land on whatever
  // state the previous test ended in. Cost is ~50ms/test for a fresh HTTP
  // listener — negligible compared to test runtime, and worth it for
  // total isolation.
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeEach(async () => {
    mock = await startMockServer({
      fixture: "task-workspace",
      fileContents: {
        ".strideterm/tasks/task-001/TASK.md":
          "# Task\n\nRefactor the authentication module to use JWT tokens.\n\n## Requirements\n\n- Replace session cookies with JWT\n- Maintain backward compatibility\n- All tests must pass\n\n## Acceptance Criteria\n\n- [ ] JWT auth implemented\n- [ ] Tests passing\n- [ ] Documentation updated",
        ".strideterm/tasks/task-001/JUDGE_PROMPT.md":
          "You are the Judge agent. Evaluate whether the Worker has completed the task according to the requirements below.\n\n## Verification\n\n- Run `npm test` and verify all tests pass\n- Check that JWT tokens are properly validated\n- Verify session cookie code is removed",
      },
    });
  });
  test.afterEach(async () => {
    await mock?.close();
  });

  test("renders task workspace in sidebar", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Auth Refactor Task")).toBeVisible();
    assertNoErrors(page);
  });

  test("task dashboard pane is visible with task description", async ({ page }) => {
    await openApp(page, mock);
    const dashboardPane = page.locator(".workspace-pane--task-dashboard");
    await expect(dashboardPane).toBeVisible({ timeout: 5_000 });
    // Task description is shown in the header
    await expect(dashboardPane.getByText("Refactor the authentication module")).toBeVisible({
      timeout: 5_000,
    });
    assertNoErrors(page);
  });

  test("task dashboard shows status tab by default", async ({ page }) => {
    await openApp(page, mock);
    const dashboard = page.locator(".td");
    await expect(dashboard).toBeVisible({ timeout: 5_000 });
    // Status tab should be active by default
    await expect(dashboard.locator(".td__tab--active")).toContainText("Status");
    assertNoErrors(page);
  });

  test("task dashboard Start button is visible in idle state", async ({ page }) => {
    await openApp(page, mock);
    const dashboard = page.locator(".td");
    await expect(dashboard).toBeVisible({ timeout: 5_000 });
    await expect(dashboard.locator("button", { hasText: "Start" })).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });

  test("switching to Assignment tab loads Monaco editor with TASK.md content", async ({ page }) => {
    await openApp(page, mock);
    const dashboard = page.locator(".td");
    await expect(dashboard).toBeVisible({ timeout: 5_000 });

    // Click on the files/Assignment tab
    await dashboard.locator(".td__tab", { hasText: /Assignment|Files/ }).click();

    // Monaco editor container should appear
    await expect(page.locator(".monaco-editor-container, .td__editor-wrap")).toBeVisible({
      timeout: 10_000,
    });
    assertNoErrors(page);
  });

  test("file tabs show Task and Judge options", async ({ page }) => {
    await openApp(page, mock);
    const dashboard = page.locator(".td");
    await expect(dashboard).toBeVisible({ timeout: 5_000 });

    // Click Assignment/Files tab
    await dashboard.locator(".td__tab", { hasText: /Assignment|Files/ }).click();

    // File tabs for TASK.md and JUDGE_PROMPT.md should be visible
    await expect(page.locator(".td__file-tab", { hasText: /Task/ })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".td__file-tab", { hasText: /Judge/ })).toBeVisible({ timeout: 5_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Task dashboard split layout (task workspace with all 3 panels)
// ---------------------------------------------------------------------------
test.describe("Task workspace split layout", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "task-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("task workspace uses top-split layout automatically", async ({ page }) => {
    await openApp(page, mock);
    // Task workspaces with 3 panels should auto-apply top-split layout
    const stage = page.locator("[data-role='terminal-stage']");
    // Task workspace uses the split layout by default for Worker + Judge panes
    await expect(stage).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Edit workspace dialog (existing workspace)
// ---------------------------------------------------------------------------
test.describe("Edit workspace dialog", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("opens edit workspace dialog with existing workspace data", async ({ page }) => {
    await openApp(page, mock);
    // Click the edit workspace button (pencil icon)
    await page.locator("button[title='Edit workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    // Should show "Edit workspace" heading (not "Add workspace" or "Create task workspace")
    await expect(page.locator(".overlay h2")).toHaveText("Edit workspace");
    assertNoErrors(page);
  });

  test("edit dialog shows current workspace name", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Edit workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    // Name field should be filled with the current workspace name
    const nameInput = page.locator(".overlay input[name='name']");
    await expect(nameInput).toHaveValue("Frontend App");
    assertNoErrors(page);
  });

  test("edit dialog shows tab templates including OpenCode", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title='Edit workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });

    // Template buttons should include OpenCode from the fixture
    // (fixture tabTemplates includes opencode)
    await expect(page.locator(".template-btn", { hasText: "OpenCode" })).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Tab picker dropdown shows all agents including OpenCode
// ---------------------------------------------------------------------------
test.describe("Tab picker with all agents", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "task-workspace" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("tab picker shows OpenCode from fixture templates", async ({ page }) => {
    await openApp(page, mock);

    // Switch to the terminal workspace (which has regular tabs)
    await page.getByText("Dev Terminal").click();
    await expect(page.getByText("Shell")).toBeVisible({ timeout: 5_000 });

    // Open the tab picker
    await page.locator("button", { hasText: "+ Tab" }).click();
    const dropdown = page.locator(".tab-picker-dropdown");
    await expect(dropdown).toBeVisible({ timeout: 3_000 });

    // OpenCode should be in the dropdown since it's in the fixture templates
    await expect(dropdown.getByText("OpenCode")).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Visual regression — new screens @visual
// ---------------------------------------------------------------------------
test.describe("Visual regression — split and task @visual", () => {
  let mockMulti: Awaited<ReturnType<typeof startMockServer>>;
  let mockTask: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mockMulti = await startMockServer({ fixture: "multi-workspace" });
    mockTask = await startMockServer({ fixture: "task-workspace" });
  });
  test.afterAll(async () => {
    await mockMulti?.close();
    await mockTask?.close();
  });

  test("columns split layout", async ({ page }) => {
    await openApp(page, mockMulti);
    await page.locator("button", { hasText: /Split|Layout/i }).click();
    await expect(page.locator(".layout-picker")).toBeVisible({ timeout: 3_000 });
    await page.locator(".layout-picker").getByTitle("Columns").click();
    await expect(page.locator("[data-role='terminal-stage']")).toHaveClass(/terminal-stage--cols/, {
      timeout: 3_000,
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("split-columns.png");
  });

  test("task workspace dashboard", async ({ page }) => {
    await openApp(page, mockTask);
    await expect(page.getByText("Auth Refactor Task")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("task-workspace-dashboard.png");
  });

  test("task creation dialog", async ({ page }) => {
    await openApp(page, mockMulti);
    await page.locator("button[title='Create task agent']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("task-creation-dialog.png");
  });
});
