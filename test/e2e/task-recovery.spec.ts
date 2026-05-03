import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Task recovery dialog E2E.
 *
 * Fixture seeds two candidates. The dialog presents them one-at-a-time
 * (sequential mode): only the head of the queue is rendered, each Resume /
 * Restart / Skip click sends one resolve POST and advances to the next
 * candidate. Skip all / Resume all batch all remaining decisions in one POST.
 */

test.describe("Task recovery dialog", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;

  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "task-recovery" });
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test("dialog opens automatically and shows the head candidate", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByRole("heading", { name: "Unfinished agent tasks detected" })).toBeVisible({
      timeout: 5_000,
    });

    // Only the first candidate (Auth Refactor) is rendered as a recovery item;
    // the second is queued and not yet in the DOM
    await expect(page.locator(".recovery-item__name")).toHaveText("Auth Refactor");

    await expect(page.getByText(/Round 3\/8/)).toBeVisible();
    await expect(page.getByText("Worker running")).toBeVisible();

    // Position indicator confirms there's more in the queue
    await expect(page.getByText("Task 1 of 2")).toBeVisible();

    assertNoErrors(page);
  });

  test("profile badge reflects the head candidate and updates as the queue advances", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByRole("heading", { name: "Unfinished agent tasks detected" })).toBeVisible({
      timeout: 5_000,
    });

    // First candidate (Auth Refactor) is in profile "default" → "Default" badge
    await expect(page.locator(".recovery-item__profile")).toHaveText("Default");

    // Skip first to advance to Refactor billing (profile "work")
    await page.getByRole("button", { name: "Skip", exact: true }).click();

    await expect(page.locator(".recovery-item__name")).toHaveText("Refactor billing");
    await expect(page.locator(".recovery-item__profile")).toHaveText("Work");

    assertNoErrors(page);
  });

  test("each decision sends its own resolve POST and the dialog closes when empty", async ({ page }) => {
    await openApp(page, mock);
    await expect(page.getByRole("heading", { name: "Unfinished agent tasks detected" })).toBeVisible({
      timeout: 5_000,
    });

    // Resume first task — sends POST with ws-auth: continue
    const firstResolve = page.waitForRequest(
      (req) => req.url().endsWith("/api/task-recovery/resolve") && req.method() === "POST",
    );
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    const firstBody = JSON.parse((await firstResolve).postData() || "{}");
    expect(firstBody.decisions).toEqual({ "ws-auth": "continue" });

    // Dialog advances to second candidate
    await expect(page.locator(".recovery-item__name")).toHaveText("Refactor billing");

    // Skip second task — sends POST with ws-billing: skip
    const secondResolve = page.waitForRequest(
      (req) => req.url().endsWith("/api/task-recovery/resolve") && req.method() === "POST",
    );
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    const secondBody = JSON.parse((await secondResolve).postData() || "{}");
    expect(secondBody.decisions).toEqual({ "ws-billing": "skip" });

    // Queue empty — dialog closes
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
