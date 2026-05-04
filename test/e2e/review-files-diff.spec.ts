import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Regression test for the Files tab diff render. The earlier layout used
 * display:grid with align-content:start on .review-files-split__right,
 * which collapsed Monaco's flex container to 0 height (the toolbar
 * rendered but the actual diff editor was invisible). This test selects
 * a file and asserts Monaco's body actually has height.
 */
test.describe("Review pane — Files tab diff layout", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "azure-pr-review" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  for (const viewport of [
    { name: "desktop", width: 1280, height: 720 },
    { name: "portrait phone", width: 390, height: 844 },
  ]) {
    test(`Monaco diff fills available height on ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openApp(page, mock);

      // Files tab is hidden behind a popover trigger on mobile — open the popover first.
      if (viewport.width <= 768) {
        await page.locator(".review-shell__tabs-trigger").click();
      }
      await page.locator(".review-subtabs .azure-tab", { hasText: /^Files/ }).click();

      const firstFile = page.locator(".review-tree-file").first();
      await firstFile.waitFor({ state: "visible", timeout: 5_000 });
      await firstFile.click();

      // Wait for Monaco to mount.
      await page.locator(".review-diff-monaco").waitFor({ state: "visible" });

      const heights = await page.evaluate(() => {
        const right = document.querySelector(".review-files-split__right");
        const monaco = document.querySelector(".review-diff-monaco");
        const body = document.querySelector(".mdp__body");
        return {
          right: Math.round((right as HTMLElement)?.getBoundingClientRect().height ?? 0),
          monaco: Math.round((monaco as HTMLElement)?.getBoundingClientRect().height ?? 0),
          body: Math.round((body as HTMLElement)?.getBoundingClientRect().height ?? 0),
        };
      });

      // The Monaco editor body must have meaningful height — not the
      // collapsed-to-content state where it would render at 0 height.
      expect(heights.body, JSON.stringify(heights)).toBeGreaterThan(100);
      expect(heights.monaco).toBeGreaterThan(heights.body);
      assertNoErrors(page);
    });
  }
});
