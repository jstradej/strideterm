import { test, expect, type Locator } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

async function expectContained(locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
      overflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
  expect(bounds.overflow).toBeLessThanOrEqual(1);
}

test("Files tabs, drafts, diff and dialogs survive phone and tablet rotations", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const longName = "very-long-filename-component-for-responsive-testing.ts";
  const contents: Record<string, string> = {
    "package.json": '{ "name": "responsive-files" }\n',
    [longName]: "export const value = 1;\n",
    "src/nested.ts": "export const nested = true;\n",
  };
  const entry = (path: string) => ({
    name: path.split("/").pop(),
    relativePath: path,
    kind: "file",
    size: 104,
    modifiedAt: "2026-10-10T12:00:00.000Z",
    extension: path.endsWith(".json") ? ".json" : ".ts",
    isHidden: false,
  });
  const mock = await startMockServer({
    fixture: "workspace-grid",
    patchState: (payload) => {
      payload.appState.workspaceGrid = null;
      payload.workspace.workspace.activeViewId = "files:panel-files";
      payload.workspace.workspace.activePanelId = "panel-files";
      payload.appState.workspaces.find((workspace: { id: string }) => workspace.id === "ws-pr").activeViewId =
        "files:panel-files";
    },
  });
  try {
    await page.route("**/api/file/list", (route) => {
      const path = route.request().postDataJSON()?.relativePath || "";
      return route.fulfill({
        json: {
          path,
          entries: path
            ? [entry("src/nested.ts")]
            : [
                { name: "src", relativePath: "src", kind: "directory", isHidden: false },
                entry("package.json"),
                entry(longName),
              ],
        },
      });
    });
    await page.route("**/api/file/git-status", (route) =>
      route.fulfill({
        json: { isRepo: true, root: "C:/temp/test", entries: { [longName]: { status: "modified" } }, directories: {} },
      }),
    );
    await page.route("**/api/file/git-refs", (route) =>
      route.fulfill({ json: { isRepo: true, branches: ["main"], tags: [], commits: [], currentBranch: "main" } }),
    );
    await page.route("**/api/file/git-diff", (route) =>
      route.fulfill({
        json: {
          ok: true,
          language: "typescript",
          leftLabel: "HEAD",
          rightLabel: "Working Tree",
          leftContent: "export const value = 0;\n",
          rightContent: contents[longName],
          leftMissing: false,
          rightMissing: false,
          source: "head",
          revision: "HEAD",
        },
      }),
    );
    for (const endpoint of ["read", "preview"]) {
      await page.route("**/api/file/" + endpoint, (route) =>
        route.fulfill({
          json: {
            kind: "text",
            content: contents[route.request().postDataJSON().relativePath] || "",
            mimeType: "text/plain",
          },
        }),
      );
    }
    await openApp(page, mock);
    await page.setViewportSize({ width: 390, height: 844 });
    const treeFile = (name: string) => page.locator(".tree-node__label").filter({ hasText: name });
    await treeFile("package.json").click();
    await page.getByRole("button", { name: "Explorer", exact: true }).click();
    await treeFile(longName).click();
    const tabs = page.locator(".file-manager__editor-tab");
    const longTab = tabs.filter({ hasText: longName });
    const packageTab = tabs.filter({ hasText: "package.json" });
    await expect(tabs).toHaveCount(2);
    const editor = page.locator(".file-preview .monaco-editor");
    await expect(editor.locator(".view-lines")).toContainText("export const value");
    await editor.locator(".view-line").first().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("// retained draft");
    await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toBeVisible();

    const sizes = [
      { name: "phone-portrait", width: 390, height: 844 },
      { name: "phone-landscape", width: 844, height: 390 },
      { name: "tablet-portrait", width: 768, height: 1024 },
      { name: "tablet-landscape", width: 1024, height: 768 },
    ];
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await expect(editor.locator(".view-lines")).toContainText("retained draft");
      await expectContained(page.locator(".workspace-pane__body--files"));
      await expectContained(page.locator(".file-preview__header"));
      if (size.width < 680) {
        await page.getByRole("button", { name: "Explorer", exact: true }).click();
        await expectContained(page.locator(".file-manager__tree"));
        await page.screenshot({ path: testInfo.outputPath(size.name + "-tree.png") });
        await treeFile(longName).click();
        await expect(editor).toBeVisible();
      }
      await packageTab.click();
      await expect(editor.locator(".view-lines")).toContainText("responsive-files");
      await longTab.click();
      await expect(editor.locator(".view-lines")).toContainText("retained draft");
      await page.screenshot({ path: testInfo.outputPath(size.name + "-editor.png") });

      await page.getByRole("button", { name: "Diff", exact: true }).click();
      const diff = page.locator(".fm-diff-inline");
      await expect(diff.locator(".monaco-editor .view-lines").last()).toContainText("export const value");
      await expect(diff.locator(".mdp__nav-counter")).toContainText("1 / 1");
      await expectContained(diff);
      expect((await diff.locator(".mdp__body").boundingBox())!.height).toBeGreaterThanOrEqual(80);
      await page.screenshot({ path: testInfo.outputPath(size.name + "-diff.png") });
      await packageTab.click();
      await expect(diff).toHaveCount(0);
      await longTab.click();
      await expect(diff).toBeVisible();
      await page.getByRole("button", { name: "← Back to file" }).click();
      await expect(editor.locator(".view-lines")).toContainText("retained draft");

      await page.getByRole("button", { name: "+ File", exact: true }).click();
      await expectContained(page.locator(".fm-dialog"));
      await page.screenshot({ path: testInfo.outputPath(size.name + "-create.png") });
      await page.locator(".fm-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Close all", exact: true }).click();
      await expect(page.getByText("Close all files?", { exact: true })).toBeVisible();
      await expectContained(page.getByRole("button", { name: "Discard and close", exact: true }));
      await page.screenshot({ path: testInfo.outputPath(size.name + "-confirm.png") });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(tabs).toHaveCount(2);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Column selection", exact: true }).click();
    await expect(page.getByRole("button", { name: "Column selection", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Toggle file manager layout" }).click();
    const views = page.getByRole("navigation", { name: "Files views" });
    await views.getByRole("button", { name: "Files", exact: true }).click();
    await expectContained(page.locator(".file-list"));
    await page.screenshot({ path: testInfo.outputPath("phone-browser-list.png") });
    await page.locator(".fli--list").filter({ hasText: longName }).click();
    await expect(editor.locator(".view-lines")).toContainText("retained draft");
    await views.getByRole("button", { name: "Files", exact: true }).click();
    await page.locator(".fli--list").filter({ hasText: longName }).click();
    await expect(editor).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("phone-browser-preview.png") });
    await views.getByRole("button", { name: "Folders", exact: true }).click();
    await expect(treeFile("package.json")).toHaveCount(0);
    await treeFile("src").click();
    await expect(page.locator(".fli--list").filter({ hasText: "nested.ts" })).toBeVisible();
    await views.getByRole("button", { name: "Folders", exact: true }).click();
    await treeFile("src").click();
    await expect(page.locator(".file-list")).toBeVisible();
    assertNoErrors(page);
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure.png") });
    throw error;
  } finally {
    await page.close();
    await mock.close();
  }
});

test("Files list keeps a visible name column in narrow containers", async ({ page }) => {
  const mock = await startMockServer({
    fixture: "workspace-grid",
    patchState: (payload) => {
      payload.workspace.workspace.activeViewId = "files:panel-files";
      payload.workspace.workspace.activePanelId = "panel-files";
      payload.appState.workspaces.find((workspace: { id: string }) => workspace.id === "ws-pr").activeViewId =
        "files:panel-files";
    },
  });
  try {
    await page.route("**/api/file/list", (route) =>
      route.fulfill({
        json: {
          path: "",
          entries: [
            {
              name: "Review.txt",
              relativePath: "Review.txt",
              kind: "file",
              size: 104,
              modifiedAt: "2026-10-10T12:00:00.000Z",
              extension: ".txt",
              isHidden: false,
            },
          ],
        },
      }),
    );
    await openApp(page, mock);
    await page.getByRole("button", { name: "Toggle file manager layout" }).click();

    const list = page.locator(".file-list");
    const row = page.locator(".fli--list");
    await expect(list).toBeVisible();
    await expect(row).toBeVisible();

    for (const width of [320, 360]) {
      const layout = await list.evaluate((element, containerWidth) => {
        const el = element as HTMLElement;
        el.style.width = `${containerWidth}px`;
        const rowEl = el.querySelector<HTMLElement>(".fli--list")!;
        const name = rowEl.querySelector<HTMLElement>(".fli__col--name")!;
        const filename = rowEl.querySelector<HTMLElement>(".fli__fname")!;
        return {
          containerWidth: el.clientWidth,
          nameWidth: name.getBoundingClientRect().width,
          filenameWidth: filename.getBoundingClientRect().width,
          typeDisplay: getComputedStyle(rowEl.querySelector<HTMLElement>(".fli__col--type")!).display,
          gridColumns: getComputedStyle(rowEl).gridTemplateColumns,
          filename: filename.textContent,
        };
      }, width);

      expect(layout.containerWidth).toBe(width);
      expect(layout.nameWidth).toBeGreaterThanOrEqual(96);
      expect(layout.filenameWidth).toBeGreaterThan(0);
      expect(layout.typeDisplay).toBe("none");
      expect(layout.gridColumns.split(" ")).toHaveLength(2);
      expect(layout.filename).toBe("Review.txt");
    }

    const wideLayout = await list.evaluate((element) => {
      const el = element as HTMLElement;
      el.style.width = "700px";
      const headerType = el.querySelector<HTMLElement>(".file-list__header .file-list__col--type")!;
      const rowType = el.querySelector<HTMLElement>(".fli__col--type")!;
      return {
        headerTypeWidth: headerType.getBoundingClientRect().width,
        rowTypeWidth: rowType.getBoundingClientRect().width,
        typeDisplay: getComputedStyle(rowType).display,
      };
    });
    expect(wideLayout.typeDisplay).not.toBe("none");
    expect(wideLayout.headerTypeWidth).toBe(90);
    expect(wideLayout.rowTypeWidth).toBe(90);
    assertNoErrors(page);
  } finally {
    await page.close();
    await mock.close();
  }
});
