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
 * Docker workspace smoke tests.
 *
 * These run against the real Electron shell with a fixture that has a single
 * docker workspace. Docker itself may not be available on CI runners — the
 * tests deliberately verify the UI renders correctly in both states:
 * - Docker unavailable: the "unavailable" card should appear.
 * - Docker available (opportunistic): the split-pane tree/detail layout should
 *   be visible. This branch is skipped when Docker is not present.
 *
 * Layout invariant: the splitpanes split must be left/right (tree left,
 * detail right), NOT top/bottom — enforced by the absence of the
 * `horizontal` prop on <Splitpanes> in DockerPane.vue.
 */
test.describe("Docker workspace", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("docker-workspace");
  });

  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("Docker workspace activates and shows either tree or unavailable state", async () => {
    const { page } = launched!;
    // Wait for the workspace tab in the sidebar specifically (the new
    // DockerHeader also renders "Docker" text, so a plain getByText is now
    // ambiguous and matches both).
    await expect(page.getByTitle(/Docker \(Ctrl\+\d\)/)).toBeVisible({ timeout: 15_000 });

    // The pane body must be rendered.
    const paneBody = page.locator(".workspace-pane__body--docker");
    await expect(paneBody).toBeVisible({ timeout: 10_000 });

    await captureStep(launched!, "docker-pane-initial");
    assertNoRendererErrors(launched!);
  });

  test("shows unavailable state or loading state — not a blank screen", async () => {
    const { page } = launched!;
    const paneBody = page.locator(".workspace-pane__body--docker");
    await expect(paneBody).toBeVisible({ timeout: 10_000 });

    // Either the unavailable card, the loading spinner, or the splitpanes layout must be present.
    const unavailable = page.locator(".docker-unavailable");
    const loading = page.locator(".docker-loading");
    const splitpanes = page.locator(".docker-splitpanes");

    const anyVisible = await Promise.any([
      unavailable.waitFor({ state: "visible", timeout: 8_000 }).then(() => "unavailable"),
      loading.waitFor({ state: "visible", timeout: 8_000 }).then(() => "loading"),
      splitpanes.waitFor({ state: "visible", timeout: 8_000 }).then(() => "splitpanes"),
    ]);

    expect(["unavailable", "loading", "splitpanes"]).toContain(anyVisible);
    assertNoRendererErrors(launched!);
  });

  test("splitpanes layout is left/right (vertical separator) when Docker is available", async () => {
    const { page } = launched!;
    const splitpanes = page.locator(".docker-splitpanes");

    // Only assert layout when the split actually rendered (Docker available).
    const isVisible = await splitpanes.isVisible().catch(() => false);
    if (!isVisible) {
      test.skip();
      return;
    }

    // Left pane must contain the tree wrapper; right pane must contain the detail.
    await expect(page.locator(".docker-pane-left")).toBeVisible();
    await expect(page.locator(".docker-pane-right")).toBeVisible();

    // Verify left/right layout: left pane x-position must be less than right pane x-position.
    const leftBox = await page.locator(".docker-pane-left").boundingBox();
    const rightBox = await page.locator(".docker-pane-right").boundingBox();

    if (leftBox && rightBox) {
      expect(leftBox.x).toBeLessThan(rightBox.x);
      // In a vertical split (left/right), both panes share the same y-position
      expect(Math.abs(leftBox.y - rightBox.y)).toBeLessThan(10);
    }

    await captureStep(launched!, "docker-splitpanes-layout");
    assertNoRendererErrors(launched!);
  });
});
