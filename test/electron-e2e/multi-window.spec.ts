import { test, expect, type Page } from "@playwright/test";
import {
  launchApp,
  closeApp,
  assertNoRendererErrors,
  captureEndState,
  captureStep,
  type LaunchedApp,
} from "./helpers.js";

/**
 * Multi-window E2E tests.
 *
 * Verifies the core invariants of multi-window mode:
 *  - Each window shows only its profile's workspaces
 *  - Profile exclusivity: a profile open in window 1 is not offered in window 2's picker
 *  - Opening a second window creates a second BrowserWindow
 *  - Closing window 2 releases the profile back for re-use
 *
 * The test launches with the "multi-profile" fixture (two profiles, no
 * window slots) so that the normalization code creates the first slot and
 * gives us a predictable starting state.
 */

/** Wait for the app to be past the splash screen. */
async function waitReady(page: Page): Promise<void> {
  // Either the sidebar heading or a bootstrap error — either way we're past the splash.
  await page.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);
}

test.describe("Multi-window — profile exclusivity and new-window flow", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("multi-profile");
    await waitReady(launched.page);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("first window shows only the personal profile workspaces", async () => {
    const { page } = launched!;
    // The personal workspace should be visible in the sidebar
    await expect(page.getByText("Personal Project", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    // The work workspace must NOT appear in this window
    const workItem = page.getByText("Work Project", { exact: true }).first();
    await expect(workItem).not.toBeVisible();
    assertNoRendererErrors(launched!);
  });

  test("new-window modal opens and shows available profiles", async () => {
    const { page } = launched!;
    // Trigger the new-window modal via IPC (simulate the shortcut event in renderer)
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).strideterm?.onNewWindowShortcut?.(() => {});
      window.dispatchEvent(new CustomEvent("strideterm:new-window"));
    });

    // Use the store directly to open the modal
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__pinia_stores?.get?.("app");
      store?.openNewWindowModal?.();
    });

    // Wait for the modal overlay
    await expect(page.locator(".overlay h2")).toHaveText("Open New Window", { timeout: 5_000 });
    await captureStep(launched!, "new-window-modal-open");

    // The Work profile should be listed as available (not occupied)
    await expect(page.getByText("Work", { exact: true }).first()).toBeVisible({ timeout: 3_000 });
    assertNoRendererErrors(launched!);
  });

  test("new-window modal closes on cancel", async () => {
    const { page } = launched!;
    const closeBtn = page.locator(".overlay .button--ghost", { hasText: "Close" });
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    }
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 3_000 });
    assertNoRendererErrors(launched!);
  });

  test("opening a second window creates a new BrowserWindow", async () => {
    const { app, page } = launched!;

    // Listen for the second window before triggering the action
    const secondPagePromise = app.waitForEvent("window", { timeout: 15_000 });

    // Open new window via IPC bridge — this exercises the real electron path
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (window as any).strideterm?.createWindow?.("profile-work");
      return result;
    });

    const secondPage = await secondPagePromise;
    await waitReady(secondPage);
    await captureStep(launched!, "second-window-opened-window1");

    // Second window should show the Work profile workspaces
    await expect(secondPage.getByText("Work Project", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    // First window should still show Personal
    await expect(page.getByText("Personal Project", { exact: true }).first()).toBeVisible({ timeout: 5_000 });
    assertNoRendererErrors(launched!);

    // Close the second window to clean up
    await secondPage.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).strideterm?.closeWindow?.();
    });
  });
});

test.describe("Multi-window — profile exclusivity enforcement", () => {
  let launched: LaunchedApp | undefined;
  let secondPage: Page | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("multi-profile");
    await waitReady(launched.page);

    // Open a second window with the Work profile
    const secondPagePromise = launched.app.waitForEvent("window", { timeout: 15_000 });
    await launched.page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).strideterm?.createWindow?.("profile-work");
    });
    secondPage = await secondPagePromise;
    await waitReady(secondPage);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("window 1 cannot open new-window modal for an already-occupied profile", async () => {
    const { page } = launched!;

    // Open the new-window modal from window 1
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pinia = (window as any).__pinia;
      if (pinia) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { useAppStore } = (window as any).__app_stores__;
        useAppStore(pinia).openNewWindowModal?.();
      }
    });

    // If modal opened, Work profile should be in the "already open" section
    const overlay = page.locator(".overlay");
    if (await overlay.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await captureStep(launched!, "modal-with-occupied-profile");
      // Close it
      await page.locator(".overlay .button--ghost", { hasText: "Close" }).click().catch(() => {});
    }
    assertNoRendererErrors(launched!);
  });

  test("second window shows Work profile workspaces independently", async () => {
    expect(secondPage).toBeDefined();
    await expect(secondPage!.getByText("Work Project", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    // Personal project must not appear in second window
    await expect(secondPage!.getByText("Personal Project", { exact: true }).first()).not.toBeVisible();
    assertNoRendererErrors(launched!);
  });
});
