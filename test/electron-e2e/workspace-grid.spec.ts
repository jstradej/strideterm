import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  assertNoRendererErrors,
  captureEndState,
  captureStep,
  type LaunchedApp,
} from "./helpers.js";

/**
 * Workspace grid E2E smoke tests.
 *
 * Covers: grid show (pre-loaded fixture), workspace-cell rendering,
 * switching to a workspace not in the grid returns to solo view,
 * and navigating back to a grid workspace restores the grid.
 */

test.describe("Workspace grid — fixture pre-loads grid state", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("grid");
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("grid layout container renders when workspaceGrid state is set", async () => {
    const { page } = launched!;
    // Wait for the sidebar workspace card to land — id-based so we don't
    // collide with the same name appearing in the cell header AND the
    // dimmed ghost in the tree (strict mode would error on multiple hits).
    await expect(page.locator('[data-workspace-id="ws-frontend"]').first()).toBeVisible({ timeout: 15_000 });
    // The workspace-grid container should be present
    await expect(page.locator(".workspace-grid")).toBeVisible({ timeout: 5_000 });
    await captureStep(launched!, "grid-initial");
    assertNoRendererErrors(launched!);
  });

  test("both grid cells render with their workspace names", async () => {
    const { page } = launched!;
    // Two cells should be visible for "cols" layout with ws-frontend and ws-backend
    const cells = page.locator(".workspace-grid__cell");
    await expect(cells).toHaveCount(2, { timeout: 5_000 });
    // Each cell header shows the workspace name
    await expect(page.locator(".workspace-cell-header__name").first()).toContainText("Frontend App");
    await expect(page.locator(".workspace-cell-header__name").nth(1)).toContainText("Backend API");
    assertNoRendererErrors(launched!);
  });

  test("compact tab strips appear inside each grid cell", async () => {
    const { page } = launched!;
    const compactStrips = page.locator(".workspace-cell .tab-strip--compact");
    await expect(compactStrips).toHaveCount(2, { timeout: 5_000 });
    assertNoRendererErrors(launched!);
  });

  test("clicking Infrastructure workspace (outside grid) hides grid and shows solo view", async () => {
    const { page } = launched!;
    // Click a workspace not in the grid
    await page.getByText("Infrastructure").click();
    // Grid should disappear
    await expect(page.locator(".workspace-grid")).not.toBeVisible({ timeout: 5_000 });
    // The normal tab strip (non-compact) should be visible
    await expect(page.locator(".tab-strip:not(.tab-strip--compact)")).toBeVisible({ timeout: 5_000 });
    await captureStep(launched!, "grid-hidden-after-solo-ws");
    assertNoRendererErrors(launched!);
  });

  test("clicking a grid workspace restores the grid view", async () => {
    const { page } = launched!;
    // Click back to a workspace that is in the grid. The card now appears
    // twice in the sidebar (once in the "In split" group, once as a ghost
    // in the regular tree) so target by stable id rather than text — the
    // text-based selector hits strict-mode "two elements" otherwise.
    await page.locator('[data-workspace-id="ws-frontend"]').first().click();
    // Grid should reappear
    await expect(page.locator(".workspace-grid")).toBeVisible({ timeout: 5_000 });
    await captureStep(launched!, "grid-restored");
    assertNoRendererErrors(launched!);
  });
});

test.describe("Workspace grid — clear cell via × button", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("grid");
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("clearing a cell via × button empties the slot without removing the workspace", async () => {
    const { page } = launched!;
    await expect(page.locator(".workspace-grid")).toBeVisible({ timeout: 15_000 });
    // Click the × button on the second cell (Backend API)
    const clearBtn = page.locator(".workspace-cell").nth(1).locator(".workspace-cell-header__btn--danger");
    await clearBtn.click();
    // The cell should now show the "Pick workspace" button
    const cells = page.locator(".workspace-grid__cell");
    await expect(cells.nth(1).locator(".workspace-cell__pick-btn")).toBeVisible({ timeout: 5_000 });
    // The Backend API workspace should still appear in the sidebar (workspace
    // is NOT deleted). After the clear, ws-backend leaves the "In split"
    // group and renders only as a regular tree card (one match) — but use
    // .first() to stay robust against transient double-renders during the
    // cell clear animation.
    await expect(page.locator('[data-workspace-id="ws-backend"]').first()).toBeVisible();
    await captureStep(launched!, "grid-cell-cleared");
    assertNoRendererErrors(launched!);
  });
});

test.describe("Workspace grid — drag-drop from sidebar", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("grid");
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("dropping a workspace-id onto a grid cell updates the cell content", async () => {
    const { page } = launched!;
    await expect(page.locator(".workspace-grid")).toBeVisible({ timeout: 15_000 });

    // Dispatch a synthetic drop event carrying workspace-id = "ws-infra" onto the second cell.
    // The cell's @drop handler reads event.dataTransfer.getData("workspace-id") and calls
    // store.setGridCell(cellIndex, wsId), so this exercises the full drop path.
    await page.evaluate(() => {
      const cells = document.querySelectorAll(".workspace-cell");
      const target = cells[1] as HTMLElement;
      const dt = new DataTransfer();
      dt.setData("workspace-id", "ws-infra");
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });

    // The second cell header should now display the dropped workspace name
    await expect(page.locator(".workspace-cell-header__name").nth(1)).toContainText("Infrastructure", {
      timeout: 5_000,
    });
    await captureStep(launched!, "drag-drop-result");
    assertNoRendererErrors(launched!);
  });
});

test.describe("Workspace grid — workspace delete clears slot", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("grid");
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("deleting a workspace currently in the grid clears its slot via the normalizer", async () => {
    const { page } = launched!;
    await expect(page.locator(".workspace-grid")).toBeVisible({ timeout: 15_000 });

    // Delete ws-backend via the preload IPC bridge (mirrors what the sidebar Delete menu does).
    // normalizeWorkspaceGrid runs on the resulting state update and sets the slot to null.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.evaluate(() => (window as any).strideterm.deleteWorkspace("ws-backend"));

    // The second grid slot should become an empty cell showing "Pick workspace…"
    await expect(page.locator(".workspace-grid__cell").nth(1).locator(".workspace-cell__pick-btn")).toBeVisible({
      timeout: 5_000,
    });
    // The deleted workspace must no longer appear in the sidebar
    await expect(page.getByText("Backend API")).not.toBeVisible({ timeout: 5_000 });
    await captureStep(launched!, "workspace-deleted-slot-cleared");
    assertNoRendererErrors(launched!);
  });
});
