import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

type MockHandle = Awaited<ReturnType<typeof startMockServer>>;

/**
 * Git Stashes tab — drives the web client against the `stashes` fixture, which
 * seeds three stash entries via the mock server's /api/git/stash-* endpoints.
 * Covers list render, selection + file/diff load, drop, create, apply,
 * export, and import.
 */
async function openStashesTab(page: import("@playwright/test").Page, mock: MockHandle) {
  await openApp(page, mock);
  // The Git pane is a workspace view tab; its button carries a stable
  // data-view-id of `git:<workspaceId>` (the accessible name varies — it
  // includes the dirty/clean badge and the per-tab menu glyph).
  await page.locator('[data-role="tab-strip"] button.tab[data-view-id="git:ws-app"]').click();
  await page.locator(".git-tabs").waitFor({ state: "visible" });
  await page.locator(".git-tabs button", { hasText: /^Stashes/ }).click();
}

// Mark the seeded workspace's working tree dirty so the Changes tab shows its
// stash form (it is hidden on a clean tree).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDirty(payload: any) {
  const ws = payload.git?.workspaces?.["ws-app"];
  if (ws) {
    ws.dirty = true;
    ws.dirtyCount = 2;
  }
}

test.describe("Git Stashes tab", () => {
  let mock: MockHandle;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "stashes" });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("renders one row per stash and selecting one loads its files + diff", async ({ page }) => {
    await openStashesTab(page, mock);
    const items = page.locator(".stash-item");
    await expect(items).toHaveCount(3);

    // Selecting the first stash loads its file list into the detail pane.
    await items.first().locator(".stash-item__row").click();
    await expect(page.locator(".stash-detail__file").first()).toBeVisible();

    // Clicking a file loads the Monaco diff.
    await page.locator(".stash-detail__file").first().click();
    await page.locator(".mdp__body, .monaco-editor").first().waitFor({ state: "visible", timeout: 10_000 });
    assertNoErrors(page);
  });

  test("filter narrows the visible rows", async ({ page }) => {
    await openStashesTab(page, mock);
    await page.locator(".stash-toolbar__filter").fill("experiment");
    await expect(page.locator(".stash-item")).toHaveCount(1);
    assertNoErrors(page);
  });

  test("dropping a stash removes the row after confirm", async ({ page }) => {
    await openStashesTab(page, mock);
    const first = page.locator(".stash-item").first();
    await first.locator(".stash-item__chevron").click();
    await first.locator(".stash-item__actions button", { hasText: "Drop" }).click();
    // Confirm dialog appears — accept it.
    await page.locator(".confirm-dialog").getByRole("button", { name: "Drop" }).click();
    await expect(page.locator(".stash-item")).toHaveCount(2);
    assertNoErrors(page);
  });

  test("'New stash in Changes…' jumps to the Changes tab (creation lives there now)", async ({ page }) => {
    await openStashesTab(page, mock);
    await page.locator(".stash-toolbar button", { hasText: "New stash in Changes" }).click();
    // The Changes tab is now active — its working-tree heading is visible.
    await expect(page.locator(".git-section--changes")).toBeVisible();
    assertNoErrors(page);
  });
});

// Mutating scenarios each get their own mock so list/working-tree mutations
// don't leak between tests (the suite runs serially against a shared server
// otherwise).
test.describe("Git Stashes tab — mutations", () => {
  test("creating a stash from the Changes tab adds an entry with its message", async ({ page }) => {
    const mock = await startMockServer({ fixture: "stashes", patchState: makeDirty });
    try {
      await openApp(page, mock);
      await page.locator('[data-role="tab-strip"] button.tab[data-view-id="git:ws-app"]').click();
      await page.locator(".git-tabs").waitFor({ state: "visible" });
      // Stashes are created from the Changes tab now (with optional file
      // selection); "Stash all" stashes the whole working tree.
      await page.locator(".git-tabs button", { hasText: /^Changes/ }).click();
      await page.locator(".git-stash-form__message").fill("rescue the watcher fix");
      await page.locator(".git-stash-form button", { hasText: "Stash all" }).click();
      // The new entry shows up over in the Stashes tab.
      await page.locator(".git-tabs button", { hasText: /^Stashes/ }).click();
      await expect(page.locator(".stash-item")).toHaveCount(4);
      await expect(page.locator(".stash-item").first()).toContainText("rescue the watcher fix");
      assertNoErrors(page);
    } finally {
      // Close the page first so the app stops reconnecting — otherwise the
      // mock's server.close() never drains the live WebSocket/HTTP polls.
      await page.close();
      await mock.close();
    }
  });

  test("applying a stash keeps the entry in place", async ({ page }) => {
    const mock = await startMockServer({ fixture: "stashes" });
    try {
      await openStashesTab(page, mock);

      const first = page.locator(".stash-item").first();
      await first.locator(".stash-item__chevron").click();
      await first.locator(".stash-item__actions button", { hasText: "Apply" }).click();
      await page.locator(".confirm-dialog").getByRole("button", { name: "Apply" }).click();

      // Apply leaves the stash in place (unlike pop/drop).
      await expect(page.locator(".stash-item")).toHaveCount(3);
      assertNoErrors(page);
    } finally {
      // Close the page first so the app stops reconnecting — otherwise the
      // mock's server.close() never drains the live WebSocket/HTTP polls.
      await page.close();
      await mock.close();
    }
  });

  test("exporting a stash downloads a patch containing a git diff", async ({ page }) => {
    const mock = await startMockServer({ fixture: "stashes" });
    try {
      await openStashesTab(page, mock);
      const first = page.locator(".stash-item").first();
      // Open the kebab menu and trigger the export → browser blob download.
      await first.locator('button[title="More actions"]').click();
      const downloadPromise = page.waitForEvent("download");
      await first.locator(".stash-item__menu button", { hasText: "Export .patch" }).click();
      const download = await downloadPromise;
      const path = await download.path();
      const content = await readFile(path, "utf-8");
      expect(content).toContain("diff --git");
      assertNoErrors(page);
    } finally {
      // Close the page first so the app stops reconnecting — otherwise the
      // mock's server.close() never drains the live WebSocket/HTTP polls.
      await page.close();
      await mock.close();
    }
  });

  test("importing a patch adds a new stash with the entered message", async ({ page }) => {
    const mock = await startMockServer({ fixture: "stashes" });
    try {
      await openStashesTab(page, mock);
      await expect(page.locator(".stash-item")).toHaveCount(3);

      // The hidden file input (used by the remote/web import path) receives the
      // patch directly; its change handler reads the file and opens the
      // import-message confirm dialog.
      await page.locator('.git-section--stashes input[type="file"]').setInputFiles({
        name: "imported-stash.patch",
        mimeType: "text/x-patch",
        buffer: Buffer.from("# strideterm-stash-patch v1\n# message: from header\ndiff --git a/x b/x\n"),
      });

      const dialog = page.locator(".prompt-dialog");
      await expect(dialog).toBeVisible();
      await dialog.locator("input[name=prompt-value]").fill("imported from header");
      await dialog.locator("button[type=submit]").click();

      await expect(page.locator(".stash-item")).toHaveCount(4);
      await expect(page.locator(".stash-item").first()).toContainText("imported from header");
      assertNoErrors(page);
    } finally {
      // Close the page first so the app stops reconnecting — otherwise the
      // mock's server.close() never drains the live WebSocket/HTTP polls.
      await page.close();
      await mock.close();
    }
  });
});
