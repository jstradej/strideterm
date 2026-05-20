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
 * Functional smoke flows — boot the real Electron shell and click through
 * a handful of screens. Each test ends with assertNoRendererErrors() so
 * that any uncaught JS exception or console.error from the renderer
 * fails the test, even when the visible DOM looks fine.
 *
 * These run on Linux + Windows + macOS in CI. Pixel-level visual
 * regression lives in visual.spec.ts (tagged @visual, opt-in).
 */

test.describe("Electron shell — empty state", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("empty");
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("window opens and renders the sidebar", async () => {
    const { page } = launched!;
    await expect(page.getByRole("heading", { name: "strIDEterm", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("button.sidebar__icon-btn[title^='Open the New Workspace picker']")).toBeVisible();
    await expect(page.locator("button.sidebar__icon-btn[title^='Open the Settings dialog']")).toBeVisible();
    await expect(page.locator("button.sidebar__icon-btn[title^='Open the Help dialog']")).toBeVisible();
    await expect(page.locator("button[data-role='notification-bell']")).toBeVisible();
    assertNoRendererErrors(launched!);
  });

  test("welcome screen guides the user through first-run steps", async () => {
    const { page } = launched!;
    await expect(page.getByText("Welcome to", { exact: false })).toBeVisible();
    await expect(page.getByText("Create a workspace", { exact: true })).toBeVisible();
    await expect(page.getByText("Pick a working directory")).toBeVisible();
    assertNoRendererErrors(launched!);
  });

  test("Settings dialog: General tab opens and closes", async () => {
    const { page } = launched!;
    await page.locator("button.sidebar__icon-btn[title^='Open the Settings dialog']").click();
    await expect(page.locator(".overlay h2")).toHaveText("Settings");
    await expect(page.getByText("Theme", { exact: false }).first()).toBeVisible({ timeout: 5_000 });
    await captureStep(launched!, "settings-general-open");
    await page.locator(".overlay").getByRole("button", { name: "Cancel" }).first().click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 5_000 });
    assertNoRendererErrors(launched!);
  });

  test("Settings dialog: switching to About tab reveals app metadata", async () => {
    const { page } = launched!;
    await page.locator("button.sidebar__icon-btn[title^='Open the Settings dialog']").click();
    await page.locator(".settings-tab-btn", { hasText: "About" }).click();
    await expect(page.locator(".settings-tab-content")).toBeVisible();
    await captureStep(launched!, "settings-about-open");
    await page.locator(".overlay").getByRole("button", { name: "Cancel" }).first().click();
    await expect(page.locator(".overlay")).not.toBeVisible();
    assertNoRendererErrors(launched!);
  });

  test("Help dialog opens with keyboard-shortcuts heading", async () => {
    const { page } = launched!;
    await page.locator("button.sidebar__icon-btn[title^='Open the Help dialog']").click();
    await expect(page.locator(".overlay h2")).toContainText("Help");
    await expect(page.getByText("Getting Started")).toBeVisible();
    await captureStep(launched!, "help-open");
    await page.locator(".overlay").getByRole("button", { name: "Close" }).first().click();
    await expect(page.locator(".overlay")).not.toBeVisible();
    assertNoRendererErrors(launched!);
  });

  test("Add workspace flow opens the template picker", async () => {
    const { page } = launched!;
    await page.locator("button.sidebar__icon-btn[title^='Open the New Workspace picker']").click();
    await expect(page.locator(".overlay h2")).toContainText("Choose a template");
    await expect(page.getByText("Empty Workspace")).toBeVisible();
    await captureStep(launched!, "new-workspace-picker-open");
    await page.locator(".overlay").getByRole("button", { name: "Close" }).first().click();
    await expect(page.locator(".overlay")).not.toBeVisible();
    assertNoRendererErrors(launched!);
  });
});

test.describe("Electron shell — seeded state", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("seeded");
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("renders all seeded workspaces in the sidebar", async () => {
    const { page } = launched!;
    await expect(page.getByText("Frontend App")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Backend API")).toBeVisible();
    await expect(page.getByText("Infrastructure")).toBeVisible();
    assertNoRendererErrors(launched!);
  });

  test("activating Backend reveals its panels and hides the others", async () => {
    const { page } = launched!;
    await expect(page.getByText("Shell").first()).toBeVisible();
    await page.getByText("Backend API").click();
    await expect(page.getByText("Tests")).toBeVisible({ timeout: 5_000 });
    await captureStep(launched!, "seeded-backend-active");
    assertNoRendererErrors(launched!);
  });

  test("switching back to Frontend hides the Backend-only Tests tab", async () => {
    const { page } = launched!;
    await page.getByText("Frontend App").click();
    await expect(page.getByText("Tests")).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Shell").first()).toBeVisible();
    await captureStep(launched!, "seeded-frontend-active");
    assertNoRendererErrors(launched!);
  });
});
