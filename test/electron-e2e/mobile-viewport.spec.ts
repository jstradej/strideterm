import { test, expect } from "@playwright/test";
import { launchApp, closeApp, assertNoRendererErrors, captureEndState, type LaunchedApp } from "./helpers.js";

/**
 * Smoke tests at a phone-sized window. The Electron e2e job runs against
 * the OS matrix (ubuntu / windows / macos), so this spec is the first line
 * of "the responsive layout still boots and engages on every platform" —
 * it doesn't try to be exhaustive about every mobile-only widget.
 *
 * The browser e2e suite (test/e2e/*-mobile.spec.ts) covers the rich UX
 * checks at the same viewport but runs only on linux/chromium.
 */

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe("Mobile viewport — Electron smoke across OS matrix", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("seeded", { windowSize: MOBILE_VIEWPORT });
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("renderer reports a phone-sized viewport", async () => {
    const { page } = launched!;
    // Sanity check that our env-driven window-size override actually
    // landed — without this, every other "mobile" assertion below would
    // pass by accident at desktop dimensions.
    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(innerWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    const isNarrow = await page.evaluate(() => window.matchMedia("(max-width: 768px)").matches);
    expect(isNarrow).toBe(true);
  });

  test("app boots without renderer errors and renders the sidebar", async () => {
    const { page } = launched!;
    await expect(page.locator('[data-role="workspace-list"]')).toBeVisible({ timeout: 15_000 });
    // Seeded fixture has three workspaces — at least one card should land
    // in the sidebar regardless of layout.
    await expect(page.locator("[data-workspace-id]").first()).toBeVisible({ timeout: 5_000 });
    assertNoRendererErrors(launched!);
  });

  test("hero workspace-grid chip is hidden on mobile (mobile-only behavior engages)", async () => {
    const { page } = launched!;
    // WorkspaceLayoutChip carries v-if="!isMobile" — its absence is a
    // direct signal that the renderer accepted the narrow viewport and
    // composables/useIsNarrow swung mobile-mode on.
    await expect(page.locator(".workspace-layout-chip-group")).toHaveCount(0);
    assertNoRendererErrors(launched!);
  });
});
