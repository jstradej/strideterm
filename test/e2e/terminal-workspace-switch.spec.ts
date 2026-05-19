import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

test.describe("Terminal workspace switching", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;

  test.beforeAll(async () => {
    mock = await startMockServer({
      fixture: "multi-workspace",
      terminalOutput: {
        "ws-frontend:panel-shell": "\r\nfrontend-shell-ready\r\n$ ",
        "ws-backend:panel-shell-2": "\r\nbackend-shell-ready\r\n$ ",
      },
    });
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test("switching away and back preserves terminal scrollback without waiting for a PTY redraw", async ({ page }) => {
    await openApp(page, mock);

    const frontendRows = page.locator('.terminal-host[data-session-id="ws-frontend:panel-shell"] .xterm-rows');
    await expect(frontendRows).toContainText("frontend-shell-ready");

    for (let i = 0; i < 5; i += 1) {
      await page.getByText("Backend API").click();
      await expect(
        page.locator('.terminal-host[data-session-id="ws-backend:panel-shell-2"] .xterm-rows'),
      ).toContainText("backend-shell-ready");

      await page.getByText("Frontend App").click();
      await expect(frontendRows).toContainText("frontend-shell-ready");
    }

    assertNoErrors(page);
  });
});
