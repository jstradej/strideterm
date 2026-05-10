import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

test.describe("Workspace grid layout", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;

  test.beforeEach(async () => {
    mock = await startMockServer({ fixture: "workspace-grid" });
  });

  test.afterEach(async ({ page }) => {
    await page.close();
    await mock?.close();
  });

  test("fills the remaining workspace area and keeps equal cell heights after tab changes", async ({ page }) => {
    await page.setViewportSize({ width: 1758, height: 974 });
    await openApp(page, mock);
    await expect(page.locator(".workspace-grid")).toBeVisible();

    const before = await gridMetrics(page);
    expect(Math.abs(before.gridBottom - before.mainBottom)).toBeLessThanOrEqual(1);
    expect(new Set(before.cellHeights.map((height) => Math.round(height * 10) / 10)).size).toBe(1);

    const tabs = page.locator(".workspace-grid__cell").first().locator(".tab");
    const count = Math.min(await tabs.count(), 4);
    for (let i = 0; i < count; i += 1) {
      await tabs.nth(i).click();
    }

    const after = await gridMetrics(page);
    expect(after.gridHeight).toBe(before.gridHeight);
    expect(after.cellHeights).toEqual(before.cellHeights);
    assertNoErrors(page);
  });

  test("opens workspace-grid layout variants from the hero chip", async ({ page }) => {
    await page.setViewportSize({ width: 1758, height: 974 });
    await openApp(page, mock);

    await page.locator("[data-role='workspace-layout-chip']").click();
    const picker = page.locator(".layout-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("button", { name: "Columns" })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Rows" })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Top split" })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Left split" })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Grid" })).toBeVisible();

    await picker.getByRole("button", { name: "Top split" }).click();
    await expect(page.locator(".layout-picker")).not.toBeVisible();
    await expect(page.locator(".workspace-grid--top-split")).toBeVisible();
    await expect(page.locator(".workspace-grid__cell")).toHaveCount(3);
    let metrics = await gridMetrics(page);
    expect(Math.abs(metrics.gridBottom - metrics.mainBottom)).toBeLessThanOrEqual(1);

    await page.locator("[data-role='workspace-layout-chip']").click();
    const reopenedPicker = page.locator(".layout-picker");
    await expect(reopenedPicker).toBeVisible();
    await expect(reopenedPicker.getByRole("button", { name: "Top split" })).toHaveClass(/layout-picker__item--active/);
    await reopenedPicker.getByRole("button", { name: "Grid" }).click();
    await expect(page.locator(".workspace-grid--grid")).toBeVisible();
    await expect(page.locator(".workspace-grid__cell")).toHaveCount(4);
    metrics = await gridMetrics(page);
    expect(Math.abs(metrics.gridBottom - metrics.mainBottom)).toBeLessThanOrEqual(1);

    assertNoErrors(page);
  });

  test("sidebar selection hides the grid for outside workspaces and restores it for grid members", async ({ page }) => {
    await page.setViewportSize({ width: 1758, height: 974 });
    await openApp(page, mock);
    await expect(page.locator(".workspace-grid")).toBeVisible();

    await page.getByText("test / test555").click();
    await expect(page.locator(".workspace-grid")).not.toBeVisible();
    await expect(page.locator(".terminal-stage")).toBeVisible();
    await expect(page.locator(".tab-strip:not(.tab-strip--compact)")).toBeVisible();
    await expect(page.locator(".workspace-list__split-group")).toBeVisible();

    await page.locator(".workspace-list__split-group").getByText("PR test").click();
    await expect(page.locator(".workspace-grid")).toBeVisible();
    const metrics = await gridMetrics(page);
    expect(Math.abs(metrics.gridBottom - metrics.mainBottom)).toBeLessThanOrEqual(1);
    expect(new Set(metrics.cellHeights.map((height) => Math.round(height * 10) / 10)).size).toBe(1);

    assertNoErrors(page);
  });

  test("collapses grid-cell tabs to the compact picker in constrained viewports", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await openApp(page, mock);

    await expect(page.locator(".tab-strip-compact-picker__trigger").first()).toBeVisible();
    await expect(page.locator(".workspace-cell .tab-strip--compact .tab").first()).toBeHidden();

    await page.locator(".tab-strip-compact-picker__trigger").nth(2).click();
    const dropdown = page.locator(".tab-strip-compact-picker__dropdown");
    await expect(dropdown).toBeVisible();
    await expect(dropdown.getByText("Judge (Claude Code opus)")).toBeVisible();

    await dropdown
      .locator(".tab-strip-compact-picker__item", { hasText: "Judge (Claude Code opus)" })
      .locator(".tab-strip-compact-picker__item-menu")
      .click();
    await expect(dropdown).toBeVisible();
    await expect(dropdown.locator(".tab-strip-compact-picker__item--menu-target")).toContainText(
      "Judge (Claude Code opus)",
    );
    await expect(page.locator(".context-menu")).toBeVisible();
    await expect(page.locator(".context-menu")).toContainText("Restart");
    await expect(page.locator(".context-menu")).toContainText("Close tab");

    await page.locator(".context-menu").getByText("Restart").click();
    await expect(page.locator(".context-menu")).not.toBeVisible();
    await expect(dropdown).not.toBeVisible();

    assertNoErrors(page);
  });

  test("uses the compact picker in short mobile-style grid mode", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 480 });
    await openApp(page, mock);

    await expect(page.locator(".workspace-grid--solo")).toBeVisible();
    await expect(page.locator(".workspace-grid__cell:visible")).toHaveCount(1);
    await expect(page.locator(".tab-strip-compact-picker__trigger:visible")).toHaveCount(1);

    const metrics = await gridMetrics(page);
    expect(Math.abs(metrics.gridBottom - metrics.mainBottom)).toBeLessThanOrEqual(1);
    assertNoErrors(page);
  });

  // ── Ghost rendering: workspaces in the grid stay visible in the regular
  //    sidebar tree (as dimmed ghosts) so parent/child structure isn't
  //    broken when nodes get pinned to grid slots.

  test("grid workspace renders as a ghost in the tree (preserves tree position)", async ({ page }) => {
    await page.setViewportSize({ width: 1758, height: 974 });
    await openApp(page, mock);
    await expect(page.locator(".workspace-grid")).toBeVisible();

    // ws-pr is in the grid (slot 1) per the fixture. It should render twice:
    // once inside the "In split" group, once as a dimmed ghost in the tree.
    const splitInstance = page.locator('.workspace-list__split-group [data-workspace-id="ws-pr"]');
    const treeInstance = page.locator('[data-role="workspace-list"] > [data-workspace-id="ws-pr"]');
    await expect(splitInstance).toHaveCount(1);
    await expect(treeInstance).toHaveCount(1);

    // The tree instance must carry the ghost styling marker and a slot badge.
    await expect(treeInstance).toHaveClass(/workspace-card--in-grid/);
    await expect(treeInstance.locator(".workspace-card__slot")).toHaveText("1");

    assertNoErrors(page);
  });

  test("workspace not in grid renders once with no ghost styling", async ({ page }) => {
    await page.setViewportSize({ width: 1758, height: 974 });
    await openApp(page, mock);

    // ws-extra ("test / test555") is the one workspace outside the grid.
    const allInstances = page.locator('[data-workspace-id="ws-extra"]');
    await expect(allInstances).toHaveCount(1);

    const card = allInstances.first();
    await expect(card).not.toHaveClass(/workspace-card--in-grid/);
    await expect(card.locator(".workspace-card__slot")).toHaveCount(0);

    assertNoErrors(page);
  });

  test("clicking a ghost in the tree focuses the matching cell without disbanding the grid", async ({ page }) => {
    await page.setViewportSize({ width: 1758, height: 974 });
    await openApp(page, mock);
    await expect(page.locator(".workspace-grid")).toBeVisible();

    // Fixture starts with ws-pr active → cell index 0 is focused.
    await expect(page.locator(".workspace-grid__cell").nth(0)).toHaveClass(/workspace-grid__cell--focused/);

    // Click the ghost of ws-task in the tree (slot 2, cell index 1). Activation
    // through the sidebar must NOT remove ws-task from the grid — it should
    // simply move focus to that cell.
    const ghost = page.locator('[data-role="workspace-list"] > [data-workspace-id="ws-task"]');
    await ghost.click();

    await expect(page.locator(".workspace-grid")).toBeVisible();
    await expect(page.locator(".workspace-grid__cell").nth(1)).toHaveClass(/workspace-grid__cell--focused/);
    // ws-task must still occupy a grid slot (the split-group entry is still there).
    await expect(page.locator('.workspace-list__split-group [data-workspace-id="ws-task"]')).toHaveCount(1);

    assertNoErrors(page);
  });

  // ── Chip decoupling: the WorkspaceLayoutChip in the hero reflects only
  //    the multi-workspace grid layout. Tab-split (panes inside one
  //    workspace) lives on the terminal toolbar.

  test("hero chip mirrors the workspace-grid layout, falls back to Solo on disband", async ({ page }) => {
    await page.setViewportSize({ width: 1758, height: 974 });
    await openApp(page, mock);
    await expect(page.locator(".workspace-grid")).toBeVisible();

    const chip = page.locator("[data-role='workspace-layout-chip']");
    // Fixture loads the "grid" layout (2×2).
    await expect(chip.locator(".workspace-layout-chip__label")).toHaveText("2 × 2 grid");
    await expect(chip).toHaveClass(/workspace-layout-chip--active/);

    // Disband the grid via the Unsplit button next to the chip.
    await page.locator(".workspace-layout-chip--unsplit").click();
    await expect(page.locator(".workspace-grid")).not.toBeVisible();

    // Chip drops to Solo and the Unsplit button disappears — even if the
    // active workspace happens to have a tab-split (the chip must not read
    // splitGroup state).
    await expect(chip.locator(".workspace-layout-chip__label")).toHaveText("Solo");
    await expect(chip).not.toHaveClass(/workspace-layout-chip--active/);
    await expect(page.locator(".workspace-layout-chip--unsplit")).toHaveCount(0);

    assertNoErrors(page);
  });
});

async function gridMetrics(page: import("@playwright/test").Page): Promise<{
  mainBottom: number;
  gridBottom: number;
  gridHeight: number;
  cellHeights: number[];
}> {
  return page.evaluate(() => {
    const main = document.querySelector(".workspace-main") as HTMLElement;
    const grid = document.querySelector(".workspace-grid") as HTMLElement;
    const mainRect = main.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    return {
      mainBottom: mainRect.bottom,
      gridBottom: gridRect.bottom,
      gridHeight: gridRect.height,
      cellHeights: Array.from(document.querySelectorAll(".workspace-grid__cell")).map(
        (cell) => (cell as HTMLElement).getBoundingClientRect().height,
      ),
    };
  });
}
