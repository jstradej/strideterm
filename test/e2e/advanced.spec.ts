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
    await page.locator("button[title^='Create a task workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".overlay h2")).toHaveText("Create task workspace");
    assertNoErrors(page);
  });

  test("shows task assignment textarea", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title^='Create a task workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });

    // Task assignment textarea
    await expect(page.locator(".overlay textarea[placeholder='Describe the task for the Worker agent']")).toBeVisible({
      timeout: 3_000,
    });
    assertNoErrors(page);
  });

  test("shows worker and judge provider dropdowns", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title^='Create a task workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });

    // Worker agent section
    await expect(page.locator(".overlay").getByText("Worker agent")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".overlay").getByText("Judge agent")).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });

  test("provider dropdown includes OpenCode option", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title^='Create a task workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });

    // Open the worker provider dropdown
    const workerSection = page.locator(".agent-config-section").first();
    await expect(workerSection).toBeVisible({ timeout: 3_000 });
    const workerProviderSelect = workerSection.locator(".custom-select").first();
    await workerProviderSelect.click();

    // OpenCode should be in the dropdown options. Use the option role
    // directly to avoid matching the listbox container, which also has a
    // class containing the substring "select__option".
    await expect(page.getByRole("option", { name: "OpenCode" })).toBeVisible({
      timeout: 3_000,
    });
    assertNoErrors(page);
  });

  test("closes dialog on Escape", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title^='Create a task workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await page.keyboard.press("Escape");
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
    await page.locator("button[title^='Open the New Workspace picker']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".overlay").getByText("Empty Workspace")).toBeVisible();
    await expect(page.locator(".overlay").getByText("Agent Task Runner")).toBeVisible();
    assertNoErrors(page);
  });

  test("Agent Task Runner opens task creation dialog", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title^='Open the New Workspace picker']").click();
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
  // .td lives in TaskDashboardPane, a separate Vite chunk that loads on demand.
  // On busy CI runners that chunk fetch + Vue mount can stretch past the
  // default 30s per-test budget. Raise the ceiling so individual `expect`s with
  // a generous timeout (see below) can actually wait the full duration without
  // the harness killing the test first. Playwright still resolves as soon as
  // the element appears — only a real breakage waits the full 2 minutes.
  test.describe.configure({ timeout: 120_000 });

  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
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
  test.afterAll(async () => {
    await mock?.close();
  });

  test("renders task workspace in sidebar", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByText("Auth Refactor Task")).toBeVisible();
    assertNoErrors(page);
  });

  // The five tests below are skipped at the e2e layer because Worker/Judge
  // panes are empty xterms in tests by definition (no agent process runs in
  // CI) and the resulting empty split layout interacts badly with Vite's
  // lazy-chunk loading for TaskDashboardPane — the dashboard pane intermittently
  // never mounts. Equivalent assertions now live as fast component tests in
  // src/components/workspace/TaskDashboardPane.test.ts: description heading,
  // Status active by default, Start/Continue/Pause/Send back/Reset state
  // gating, the five top-level tabs, tab switching. The e2e shell still covers
  // the integration sanity check via `renders task workspace in sidebar`
  // above + `Task workspace split layout` further down.
  test.skip("task dashboard pane is visible with task description", async ({ page }) => {
    await openApp(page, mock);
    const dashboardPane = page.locator(".workspace-pane--task-dashboard");
    await expect(dashboardPane).toBeVisible({ timeout: 60_000 });
    await expect(dashboardPane.getByText("Refactor the authentication module")).toBeVisible({
      timeout: 60_000,
    });
    assertNoErrors(page);
  });

  test.skip("task dashboard shows status tab by default", async ({ page }) => {
    await openApp(page, mock);
    const dashboard = page.locator(".td");
    await expect(dashboard).toBeVisible({ timeout: 60_000 });
    await expect(dashboard.locator(".td__tab--active")).toContainText("Status");
    assertNoErrors(page);
  });

  test.skip("task dashboard Start button is visible in idle state", async ({ page }) => {
    await openApp(page, mock);
    const dashboard = page.locator(".td");
    await expect(dashboard).toBeVisible({ timeout: 60_000 });
    await expect(dashboard.locator("button", { hasText: "Start" })).toBeVisible({ timeout: 3_000 });
    assertNoErrors(page);
  });

  test.skip("switching to Assignment tab loads Monaco editor with TASK.md content", async ({ page }) => {
    await openApp(page, mock);
    const dashboard = page.locator(".td");
    await expect(dashboard).toBeVisible({ timeout: 60_000 });
    await dashboard.locator(".td__tab", { hasText: /Assignment|Files/ }).click();
    await expect(page.locator(".monaco-editor-container, .td__editor-wrap")).toBeVisible({
      timeout: 10_000,
    });
    assertNoErrors(page);
  });

  test.skip("file tabs show Task and Judge options", async ({ page }) => {
    await openApp(page, mock);
    const dashboard = page.locator(".td");
    await expect(dashboard).toBeVisible({ timeout: 60_000 });
    await dashboard.locator(".td__tab", { hasText: /Assignment|Files/ }).click();
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
    await page.locator("button[title^='Edit this workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    // Should show "Edit workspace" heading (not "Add workspace" or "Create task workspace")
    await expect(page.locator(".overlay h2")).toHaveText("Edit workspace");
    assertNoErrors(page);
  });

  test("edit dialog shows current workspace name", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title^='Edit this workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    // Name field should be filled with the current workspace name
    const nameInput = page.locator(".overlay input[name='name']");
    await expect(nameInput).toHaveValue("Frontend App");
    assertNoErrors(page);
  });

  test("edit dialog shows tab templates including OpenCode", async ({ page }) => {
    await openApp(page, mock);
    await page.locator("button[title^='Edit this workspace']").click();
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
    await page.locator("button[title^='Create a task workspace']").click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 3_000 });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("task-creation-dialog.png");
  });
});
