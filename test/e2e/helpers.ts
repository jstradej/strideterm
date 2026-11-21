import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

interface MockServer {
  url: string;
  token: string;
}

declare module "@playwright/test" {
  interface Page {
    __errorTracker?: string[];
  }
}

export async function openApp(page: Page, mock: MockServer): Promise<void> {
  // Track JS errors — any uncaught exception will fail the test in assertNoErrors()
  if (!page.__errorTracker) {
    page.__errorTracker = [];
    page.on("pageerror", (err) => page.__errorTracker!.push(err.message));
  }
  await page.goto(`${mock.url}/?token=${mock.token}`);
  await expect(page.getByRole("heading", { name: "strIDEterm", exact: true })).toBeVisible();
}

export function assertNoErrors(page: Page): void {
  const errors = page.__errorTracker || [];
  expect(errors, `Unexpected JS errors: ${errors.join(", ")}`).toEqual([]);
}

/** Opens a CustomSelect from its trigger button and picks the option with this label (the app has no native select). */
export async function pickOption(trigger: Locator, label: string): Promise<void> {
  await trigger.click();
  await trigger.page().getByRole("listbox").getByRole("option", { name: label, exact: true }).click();
}
