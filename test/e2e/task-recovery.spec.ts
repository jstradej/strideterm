import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Task recovery dialog E2E.
 *
 * The fixture seeds two recovery candidates in `meta.recoveryCandidates`. On
 * boot the app should detect them and open TaskRecoveryDialog. We exercise
 * the user-facing flow: pick a decision per task, click Confirm, assert the
 * resolve IPC fires with the expected payload, dialog closes.
 */

test.describe("Task recovery dialog", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;

  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "task-recovery" });
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test("dialog opens automatically when crash candidates are present", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByRole("heading", { name: "Unfinished agent tasks detected" })).toBeVisible({
      timeout: 5_000,
    });

    // Both candidates rendered as separate items
    await expect(page.getByText("Auth Refactor", { exact: true })).toBeVisible();
    await expect(page.getByText("Refactor billing", { exact: true })).toBeVisible();

    // Round / phase / fs-state metadata for each
    await expect(page.getByText(/Round 3\/8/)).toBeVisible();
    await expect(page.getByText("Worker running")).toBeVisible();
    await expect(page.getByText(/Round 1\/4/)).toBeVisible();
    await expect(page.getByText("Judge evaluating")).toBeVisible();

    assertNoErrors(page);
  });

  test("profile badge shows for non-default profiles", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByRole("heading", { name: "Unfinished agent tasks detected" })).toBeVisible({
      timeout: 5_000,
    });

    // The "Refactor billing" task is in profile "work" → badge visible
    await expect(page.locator(".recovery-item__profile").filter({ hasText: "Work" })).toBeVisible();

    assertNoErrors(page);
  });

  test("confirm sends resolve POST with per-task decisions", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByRole("heading", { name: "Unfinished agent tasks detected" })).toBeVisible({
      timeout: 5_000,
    });

    // Default decision is "continue" for all — change one to "skip".
    // Use label.radio-label filter because the label also contains hint text ("Leave task paused"),
    // so exact-text matching against "Skip" alone won't work.
    await page.locator(".recovery-item").nth(1).locator("label.radio-label").filter({ hasText: "Skip" }).click();

    // Click Confirm and capture the resolve request
    const resolveRequest = page.waitForRequest(
      (req) => req.url().endsWith("/api/task-recovery/resolve") && req.method() === "POST",
    );
    await page.getByRole("button", { name: "Confirm" }).click();
    const req = await resolveRequest;
    const body = JSON.parse(req.postData() || "{}");

    // The runtime IPC takes { decisions } — transport wraps it as the POST body
    expect(body.decisions).toBeDefined();
    expect(body.decisions["ws-auth"]).toBe("continue");
    expect(body.decisions["ws-billing"]).toBe("skip");

    // Dialog should close after confirm
    await expect(page.getByRole("heading", { name: "Unfinished agent tasks detected" })).not.toBeVisible({
      timeout: 3_000,
    });

    assertNoErrors(page);
  });

  test("Skip all sends skip for every candidate", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByRole("heading", { name: "Unfinished agent tasks detected" })).toBeVisible({
      timeout: 5_000,
    });

    const resolveRequest = page.waitForRequest(
      (req) => req.url().endsWith("/api/task-recovery/resolve") && req.method() === "POST",
    );
    await page.getByRole("button", { name: "Skip all" }).click();
    const req = await resolveRequest;
    const body = JSON.parse(req.postData() || "{}");

    expect(body.decisions["ws-auth"]).toBe("skip");
    expect(body.decisions["ws-billing"]).toBe("skip");

    await expect(page.getByRole("heading", { name: "Unfinished agent tasks detected" })).not.toBeVisible({
      timeout: 3_000,
    });

    assertNoErrors(page);
  });
});

test.describe("No recovery candidates", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;

  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "empty-state" });
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test("dialog does not open when there are no candidates", async ({ page }) => {
    await openApp(page, mock);
    // Wait a moment for hydration to complete
    await page.waitForTimeout(500);
    await expect(page.getByRole("heading", { name: "Unfinished agent tasks detected" })).not.toBeVisible();
    assertNoErrors(page);
  });
});
