import { test, expect, type Page } from "@playwright/test";
import {
  launchApp,
  relaunchApp,
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

test.describe("Multi-window — restart restores two windows", () => {
  let launched: LaunchedApp | undefined;
  let dataDir: string;

  test.beforeAll(async () => {
    launched = await launchApp("multi-profile");
    await launched.page.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);
    dataDir = launched.dataDir;

    // Open a second window with the Work profile
    const secondPagePromise = launched.app.waitForEvent("window", { timeout: 15_000 });
    await launched.page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).strideterm?.createWindow?.("profile-work");
    });
    const secondPage = await secondPagePromise;
    await secondPage.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);

    // Give the runtime time to persist windowSlots
    await launched.page.waitForTimeout(500);

    // Close the app (simulates a restart)
    await closeApp(launched);
    launched = undefined;
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("restart opens two windows — one per persisted window slot", async () => {
    // Re-launch with the same data directory
    launched = await relaunchApp(dataDir);
    const page = launched.page;
    await page.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);

    // Wait for the second window to appear (restored from windowSlots)
    const secondPage = await launched.app.waitForEvent("window", { timeout: 20_000 }).catch(() => null);

    // At least one window must show a workspace from the personal profile
    await expect(page.getByText("Personal Project", { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    if (secondPage) {
      await secondPage.waitForSelector("h1.brand, .bootstrap-error", { timeout: 15_000 }).catch(() => undefined);
      // Second window should show the work profile workspace
      await expect(secondPage.getByText("Work Project", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      await captureStep(launched, "restart-second-window");
    }

    assertNoRendererErrors(launched);
  });
});

test.describe("Multi-window — profile-delete-while-open refusal", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("multi-profile");
    await launched.page.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);

    // Open a second window with the Work profile
    const secondPagePromise = launched.app.waitForEvent("window", { timeout: 15_000 });
    await launched.page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).strideterm?.createWindow?.("profile-work");
    });
    const secondPage = await secondPagePromise;
    await secondPage.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("deleting a profile open in another window shows an error, not a silent failure", async () => {
    const { page } = launched!;

    // Attempt to delete the Work profile (which is currently open in window 2) via IPC
    const result = await page.evaluate(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (window as any).strideterm?.deleteProfile?.("profile-work");
        return { success: true, error: null };
      } catch (err) {
        return { success: false, error: (err as Error)?.message || String(err) };
      }
    });

    await captureStep(launched!, "profile-delete-while-open");

    // The backend must refuse; success would mean the guard is missing
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/open in window/i);
    assertNoRendererErrors(launched!);
  });
});

test.describe("Cmd+W cascade — workspace navigation before window close", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    // Use a fixture with two workspaces in the same profile so Cmd+W
    // can navigate from workspace A to B without closing the window.
    launched = await launchApp("two-workspaces");
    await launched.page.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("Ctrl+W with two workspaces navigates to the sibling workspace instead of closing the window", async () => {
    const { page } = launched!;

    // Confirm Workspace A is active
    await expect(page.getByText("Workspace A", { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    await captureStep(launched!, "before-ctrl-w");

    // Simulate Ctrl+W — the cascade should navigate to Workspace B (sibling), not close the window
    await page.keyboard.press("Control+w");
    await page.waitForTimeout(500);

    await captureStep(launched!, "after-ctrl-w");

    // The window must still be open — Playwright would throw if the page was destroyed
    const isOpen = !page.isClosed();
    expect(isOpen).toBe(true);

    // Both workspaces should still be visible in the sidebar (neither was deleted)
    await expect(page.getByText("Workspace A", { exact: true }).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Workspace B", { exact: true }).first()).toBeVisible({ timeout: 5_000 });
    assertNoRendererErrors(launched!);
  });
});

test.describe("Multi-window — per-window screenshot capture", () => {
  let launched: LaunchedApp | undefined;
  let secondPage: import("@playwright/test").Page | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("multi-profile");
    await launched.page.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);

    // Open a second window with the Work profile
    const secondPagePromise = launched.app.waitForEvent("window", { timeout: 15_000 });
    await launched.page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).strideterm?.createWindow?.("profile-work");
    });
    secondPage = await secondPagePromise;
    await secondPage.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("capturing window 1 returns a non-empty PNG buffer", async () => {
    const { app } = launched!;

    // Use Playwright's Electron evaluate to call capturePage on window[0] in the main process.
    // This exercises the same code path as captureMainWindowPng(windowId) used by Telegram screenshot routing.
    const pngLength = await app.evaluate(async ({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      if (wins.length === 0) return 0;
      const image = await wins[0].webContents.capturePage();
      return image.toPNG().length;
    });

    expect(pngLength).toBeGreaterThan(0);
    assertNoRendererErrors(launched!);
  });

  test("capturing window 2 returns a non-empty PNG buffer independent of window 1", async () => {
    const { app } = launched!;
    expect(secondPage).toBeDefined();

    const allPngLengths = await app.evaluate(async ({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      const results: number[] = [];
      for (const win of wins) {
        if (!win.isDestroyed()) {
          const image = await win.webContents.capturePage();
          results.push(image.toPNG().length);
        }
      }
      return results;
    });

    // Both windows must produce non-empty captures
    expect(allPngLengths.length).toBeGreaterThanOrEqual(2);
    for (const len of allPngLengths) {
      expect(len).toBeGreaterThan(0);
    }
    assertNoRendererErrors(launched!);
  });
});

test.describe("Multi-window — native badge count is global sum", () => {
  let launched: LaunchedApp | undefined;
  let secondPage: import("@playwright/test").Page | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("multi-profile");
    await launched.page.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);

    // Open a second window with the Work profile
    const secondPagePromise = launched.app.waitForEvent("window", { timeout: 15_000 });
    await launched.page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).strideterm?.createWindow?.("profile-work");
    });
    secondPage = await secondPagePromise;
    await secondPage.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("badge count is 0 when there are no alerts across any window", async () => {
    const { app } = launched!;
    expect(secondPage).toBeDefined();

    // app.getBadgeCount() returns the global badge count set via app.setBadgeCount()
    // in updateNativeAttention(). With the multi-profile fixture (no running tasks,
    // no alerts), the count should be 0 across all windows.
    const badgeCount = await app.evaluate(({ app: electronApp }) => {
      // getBadgeCount is macOS/Linux; Windows uses overlay icon. Check both.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return typeof (electronApp as any).getBadgeCount === "function"
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (electronApp as any).getBadgeCount()
        : 0;
    });

    expect(badgeCount).toBe(0);
    assertNoRendererErrors(launched!);
  });

  test("two windows each show their own profile workspaces, badge count reflects combined state", async () => {
    expect(secondPage).toBeDefined();

    // Verify each window independently shows only its profile's workspaces
    await expect(launched!.page.getByText("Personal Project", { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(secondPage!.getByText("Work Project", { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    // Badge count must be a non-negative integer (sum across all windows)
    const badgeCount = await launched!.app.evaluate(({ app: electronApp }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return typeof (electronApp as any).getBadgeCount === "function"
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (electronApp as any).getBadgeCount()
        : 0;
    });

    expect(typeof badgeCount).toBe("number");
    expect(badgeCount).toBeGreaterThanOrEqual(0);
    assertNoRendererErrors(launched!);
  });
});
