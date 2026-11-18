import { expect, test } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { assertNoErrors, openApp } from "./helpers.js";

test.use({ hasTouch: true });

const longDomain = `${"logs".repeat(15)}.${"region".repeat(10)}.${"service".repeat(8)}.example.com`;
let mock: Awaited<ReturnType<typeof startMockServer>>;

test.beforeAll(async () => {
  mock = await startMockServer({
    fixture: "activity-forest",
    patchState(payload) {
      const workspace = payload.appState.workspaces.find((item: { id: string }) => item.id === "ws-repo");
      workspace.sandboxEnabled = true;
      workspace.sandboxAllowedDomains = [longDomain];
      payload.appState.tabTemplates = Array.from({ length: 20 }, (_, index) => ({
        id: `template-${index}`,
        title: `Shell template ${index + 1}`,
        command: "",
      }));
    },
  });
});

test.afterAll(async () => {
  await mock.close();
});

test("keeps workspace isolation settings readable in portrait and landscape", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openApp(page, mock);
  await page.locator(".mobile-hamburger").tap();
  const card = page.locator('[data-workspace-id="ws-repo"]').last();
  await card.locator(".workspace-card__action--menu").tap();
  await page.getByTitle("Open the workspace editor", { exact: false }).tap();

  const dialog = page.locator(".overlay .dialog");
  await expect(dialog.getByRole("heading", { name: "Edit workspace" })).toBeVisible();
  await expect(dialog.getByTestId("sandbox-checkbox")).toBeChecked();
  await expect(dialog.getByTestId("sandbox-checkbox")).toBeDisabled();
  const destination = dialog.getByText(longDomain, { exact: true });
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await destination.scrollIntoViewIfNeeded();
    const size = await dialog.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(size.scroll).toBeLessThanOrEqual(size.client + 1);
    await expect(destination).toBeInViewport({ ratio: 1 });
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
  await expect(dialog).toBeHidden();
  assertNoErrors(page);
});

test("reaches and opens tmux attachment from a long tab picker in landscape", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.route("**/api/ssh/hosts/list", (route) =>
    route.fulfill({ json: [{ id: "host-mini", host: "mini.local", name: "Mini", profileId: "default" }] }),
  );
  await page.route("**/api/ssh/keys/list", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/ssh/certs/list", (route) => route.fulfill({ json: [] }));
  await openApp(page, mock);
  await page.locator(".mobile-hamburger").tap();
  await page.locator('[data-workspace-id="ws-repo"]').last().tap();
  await page.getByRole("button", { name: "Add tab", exact: true }).tap();

  const picker = page.locator(".tab-picker-dropdown");
  await expect(picker).toBeInViewport({ ratio: 1 });
  await picker.getByRole("button", { name: /Attach to tmux/ }).tap();
  const dialog = page.locator(".edit-tab-dialog");
  await expect(dialog.getByTestId("tmux-attach")).toBeChecked();
  await expect(dialog.getByText("Enter the session name. To browse sessions, use the desktop app.")).toBeVisible();
  await dialog.getByTestId("tmux-session-name").fill("shared-builds");
  const access = dialog.getByRole("combobox", { name: /Session access/ });
  await access.selectOption("read-only");
  await expect(dialog.getByRole("button", { name: "Attach to tmux", exact: true })).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByTestId("tmux-session-name")).toHaveValue("shared-builds");
  await expect(access).toHaveValue("read-only");
  await expect(dialog.getByRole("button", { name: "Attach to tmux", exact: true })).toBeInViewport({ ratio: 1 });
  assertNoErrors(page);
});
