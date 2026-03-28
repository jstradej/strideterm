import { expect } from "@playwright/test";

/**
 * Navigate to the mock server and wait for the app to render.
 * Also installs pageerror tracking so any JS exception fails the test.
 */
export async function openApp(page, mock) {
  // Track JS errors — any uncaught exception will fail the test in assertNoErrors()
  if (!page.__errorTracker) {
    page.__errorTracker = [];
    page.on("pageerror", (err) => page.__errorTracker.push(err.message));
  }
  await page.goto(`${mock.url}/?token=${mock.token}`);
  await expect(page.getByRole("heading", { name: "strIDEterm", exact: true })).toBeVisible();
}

/**
 * Assert that no JS errors occurred during the test.
 * Call at the end of tests that interact heavily with the UI.
 */
export function assertNoErrors(page) {
  const errors = page.__errorTracker || [];
  expect(errors, `Unexpected JS errors: ${errors.join(", ")}`).toEqual([]);
}
