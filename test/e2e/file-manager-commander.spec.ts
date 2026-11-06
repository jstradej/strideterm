import { test, expect, type Locator, type Page } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

type Entry = {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size?: number;
  modifiedAt: string;
  extension?: string;
  isHidden: boolean;
};

const dir = (path: string, modifiedAt: string): Entry => {
  const name = path.split("/").pop()!;
  return { name, relativePath: path, kind: "directory", modifiedAt, isHidden: name.startsWith(".") };
};

const file = (path: string, size: number, modifiedAt: string): Entry => {
  const name = path.split("/").pop()!;
  const dot = name.lastIndexOf(".");
  return {
    name,
    relativePath: path,
    kind: "file",
    size,
    modifiedAt,
    extension: dot > 0 ? name.slice(dot) : "",
    isHidden: name.startsWith("."),
  };
};

const LONG_NAME = "very-long-filename-component-for-responsive-testing-purposes.config.ts";

const TREE: Record<string, Entry[]> = {
  "": [
    dir("src", "2026-10-28T09:14:00.000Z"),
    dir("docs", "2026-10-21T16:40:00.000Z"),
    dir("test", "2026-10-30T11:05:00.000Z"),
    dir(".github", "2026-09-02T08:00:00.000Z"),
    file("package.json", 2481, "2026-10-30T12:20:00.000Z"),
    file("README.md", 7340, "2026-10-12T10:00:00.000Z"),
    file("tsconfig.json", 612, "2026-08-19T14:31:00.000Z"),
    file("vite.config.ts", 1873, "2026-10-02T17:45:00.000Z"),
    file(".gitignore", 214, "2026-07-01T09:00:00.000Z"),
    file("archive.tar.gz", 4_812_340, "2026-10-01T22:10:00.000Z"),
    file("logo.png", 18_204, "2026-06-15T13:00:00.000Z"),
    file("notes.txt", 932, "2026-11-01T08:30:00.000Z"),
    file(LONG_NAME, 1402, "2026-10-29T19:59:00.000Z"),
  ],
  src: [
    dir("src/components", "2026-10-27T15:00:00.000Z"),
    dir("src/stores", "2026-10-26T10:30:00.000Z"),
    file("src/App.vue", 5120, "2026-10-28T09:14:00.000Z"),
    file("src/main.ts", 1288, "2026-10-30T12:19:00.000Z"),
    file("src/router.ts", 2210, "2026-10-14T11:11:00.000Z"),
    file("src/styles.css", 18_944, "2026-10-09T07:50:00.000Z"),
  ],
  "src/components": [
    file("src/components/Button.vue", 1650, "2026-10-27T15:00:00.000Z"),
    file("src/components/Dialog.vue", 4380, "2026-10-25T12:12:00.000Z"),
    file("src/components/FileList.vue", 9120, "2026-10-20T18:40:00.000Z"),
  ],
  docs: [
    dir("docs/images", "2026-10-03T09:00:00.000Z"),
    file("docs/architecture.md", 12_880, "2026-10-21T16:40:00.000Z"),
    file("docs/guide.md", 6402, "2026-10-18T13:05:00.000Z"),
    file("docs/faq.md", 2210, "2026-09-29T10:00:00.000Z"),
  ],
  test: [file("test/app.spec.ts", 3320, "2026-10-30T11:05:00.000Z")],
  ".github": [file(".github/ci.yml", 880, "2026-09-02T08:00:00.000Z")],
};

const README = `# strideterm

A multi-workspace terminal.

## Getting started

  npm install
  npm run dev

Open the Files tab and pick the Commander layout to browse
two folders side by side.
`;

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

async function settle(page: Page) {
  await page.waitForTimeout(400);
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

const row = (panel: Locator, label: string) =>
  panel.locator(".fcp__row", { has: panel.page().locator(".fcp__name", { hasText: label }) }).first();

test("Commander layout browses two panels, previews a file and fits every size and theme", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
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
      return route.fulfill({ json: { path, entries: TREE[path] || [] } });
    });
    await page.route("**/api/file/git-status", (route) =>
      route.fulfill({
        json: {
          isRepo: true,
          root: "C:/temp/test",
          entries: {
            "package.json": { status: "modified" },
            "src/main.ts": { status: "modified" },
            "notes.txt": { status: "untracked" },
          },
          directories: { src: "modified" },
        },
      }),
    );
    await page.route("**/api/file/preview", (route) => {
      const path = route.request().postDataJSON().relativePath as string;
      return route.fulfill({
        json: {
          kind: "text",
          content: path === "README.md" ? README : `// ${path}\nexport const value = 1;\n`,
          mimeType: "text/plain",
        },
      });
    });
    await page.route("**/api/file/read", (route) => {
      const path = route.request().postDataJSON().relativePath as string;
      return route.fulfill({
        json: { content: path === "README.md" ? README : `// ${path}\nexport const value = 1;\n` },
      });
    });

    await openApp(page, mock);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Commander layout" }).click();
    const panels = page.locator(".fcp");
    await expect(panels).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Commander layout" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: ".*", exact: true }).click();

    const left = panels.nth(0);
    const right = panels.nth(1);
    await expect(row(left, "[.github]")).toBeVisible();
    await expect(left.locator(".fcp__row")).toHaveCount(13);

    // Browse into a folder and back, the cursor returns to the folder we came from.
    await row(left, "[src]").click();
    await page.keyboard.press("Enter");
    await expect(left.locator(".fcp__path")).toHaveText(`${await rootName(left)}/src/*.*`);
    await row(left, "[components]").click();
    await page.keyboard.press("Enter");
    await expect(left.locator(".fcp__path")).toContainText("src/components/*.*");
    await expect(left.locator(".fcp__row")).toHaveCount(4);
    await page.keyboard.press("Backspace");
    await expect(left.locator(".fcp__row--cursor .fcp__name")).toHaveText("[components]");
    await page.keyboard.press("Backspace");
    await expect(left.locator(".fcp__path")).not.toContainText("/src");
    await expect(left.locator(".fcp__row--cursor .fcp__name")).toHaveText("[src]");

    await row(left, "[docs]").dblclick();
    await expect(left.locator(".fcp__path")).toContainText("/docs/*.*");
    await page.keyboard.press("Backspace");
    await expect(left.locator(".fcp__path")).not.toContainText("/docs");

    // Mark one file (it turns bold red) and open docs in the right panel.
    await row(left, "package.json").click();
    await page.keyboard.press("Insert");
    await expect(left.locator(".fcp__row--marked")).toHaveCount(1);
    await expect(left.locator(".fcp__status")).toContainText("2.4 k / ");
    await page.keyboard.press("Tab");
    await expect(right).toHaveClass(/fcp--active/);
    await row(right, "[docs]").click();
    await page.keyboard.press("Enter");
    await expect(right.locator(".fcp__path")).toContainText("docs/*.*");
    await expect(row(left, "package.json").locator(".fcp__c--git")).toHaveText("M");
    await expect(row(left, "notes.txt").locator(".fcp__c--git")).toHaveText("U");
    await page.keyboard.press("Tab");
    await expect(left).toHaveClass(/fcp--active/);

    const sizes = [
      { name: "desktop-1440x900", width: 1440, height: 900 },
      { name: "laptop-1024x768", width: 1024, height: 768 },
      { name: "tablet-768x1024", width: 768, height: 1024 },
      { name: "phone-390x844", width: 390, height: 844 },
      { name: "phone-landscape-844x390", width: 844, height: 390 },
    ];
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      const commander = page.locator(".fc");
      await expectContained(commander);
      await expectContained(page.locator(".workspace-pane__body--files"));
      await expectContained(page.locator(".fc__fkeys"));
      await expectNoPageOverflow(page);
      const paneWidth = await page.locator(".workspace-pane__body--files").evaluate((el) => el.clientWidth);
      await expect(panels).toHaveCount(paneWidth <= 680 ? 1 : 2);
      await settle(page);
      await page.screenshot({ path: testInfo.outputPath(`dark-${size.name}.png`) });
      if (paneWidth <= 680) {
        await page.getByRole("navigation", { name: "Commander panels" }).getByRole("button", { name: "Right" }).click();
        await expect(panels.first().locator(".fcp__path")).toContainText("docs/*.*");
        await expectContained(panels.first());
        await expectNoPageOverflow(page);
        await settle(page);
        await page.screenshot({ path: testInfo.outputPath(`dark-${size.name}-right.png`) });
        await page.getByRole("navigation", { name: "Commander panels" }).getByRole("button", { name: "Left" }).click();
      }
    }

    // Quick View on a text file: the inactive panel becomes the preview.
    await page.setViewportSize({ width: 1440, height: 900 });
    await row(panels.nth(0), "README.md").click();
    await page.keyboard.press("F3");
    await expect(page.locator(".fcq__title-text")).toHaveText("Quick View: README.md");
    await expect(page.locator(".fcq__code .view-lines")).toContainText("Getting started");
    // Highlighted: Monaco tokenises the markdown, so some tokens get a colour class other than the default mtk1.
    await expect(page.locator(".fcq__code .view-lines span[class^='mtk']:not(.mtk1)").first()).toBeVisible();
    await expect(page.locator(".fcp")).toHaveCount(1);
    await expectContained(page.locator(".fcq"));
    await settle(page);
    await page.screenshot({ path: testInfo.outputPath("dark-quickview-desktop-1440x900.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const switcher = page.getByRole("navigation", { name: "Commander panels" });
    await switcher.getByRole("button", { name: "View" }).click();
    await expect(page.locator(".fcq__code .view-lines")).toContainText("Getting started");
    await expectContained(page.locator(".fcq"));
    await expectNoPageOverflow(page);
    await settle(page);
    await page.screenshot({ path: testInfo.outputPath("dark-quickview-phone-390x844.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press("Escape");
    await expect(page.locator(".fcq")).toHaveCount(0);

    // Quick search by typing: the cursor jumps to the matching row and the prefix shows over the status line.
    await row(left, "package.json").click();
    await page.keyboard.press("n");
    await expect(left.locator(".fcp__search")).toHaveText("Search: n");
    await expect(left.locator(".fcp__row--cursor .fcp__name")).toContainText("notes");
    await expectContained(left.locator(".fcp__search"));
    await page.keyboard.press("q");
    await expect(left.locator(".fcp__search")).toHaveText("Search: n");
    await settle(page);
    await page.screenshot({ path: testInfo.outputPath("dark-search-desktop-1440x900.png") });
    await page.keyboard.press("Escape");
    await expect(left.locator(".fcp__search")).toHaveCount(0);

    // F5 copies the marked entries (package.json, marked earlier) into the other panel folder after a confirm.
    let copyBody: Record<string, string> | null = null;
    await page.route("**/api/file/copy", (route) => {
      copyBody = route.request().postDataJSON();
      return route.fulfill({ json: {} });
    });
    await page.keyboard.press("F5");
    await page.locator(".confirm-dialog").getByRole("button", { name: "Copy", exact: true }).click();
    await expect.poll(() => copyBody).toMatchObject({ fromPath: "package.json", toPath: "docs/package.json" });
    await expect(page.locator(".confirm-dialog")).toHaveCount(0);

    // Coming back to the Files tab puts the keyboard straight into the active panel.
    const cursorBefore = await left.locator(".fcp__row--cursor .fcp__name").textContent();
    await page.locator(".tab", { hasText: "Shell" }).first().click();
    await expect(page.locator(".fc")).toHaveCount(0);
    await page.locator(".tab", { hasText: "Files" }).first().click();
    await expect(panels).toHaveCount(2);
    await expect(page.locator(".fc")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(left.locator(".fcp__row--cursor .fcp__name")).not.toHaveText(cursorBefore ?? "");
    await page.keyboard.press("ArrowUp");
    await expect(left.locator(".fcp__row--cursor .fcp__name")).toHaveText(cursorBefore ?? "");

    // Light theme.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await expectContained(page.locator(".fc"));
      await expectNoPageOverflow(page);
      await settle(page);
      await page.screenshot({ path: testInfo.outputPath(`light-${size.name}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await row(panels.nth(0), "README.md").click();
    await page.keyboard.press("F3");
    await expect(page.locator(".fcq__code .monaco-editor")).toBeVisible();
    await settle(page);
    await page.screenshot({ path: testInfo.outputPath("light-quickview-desktop-1440x900.png") });

    await page.keyboard.press("F3");
    await expect(page.locator(".fcq")).toHaveCount(0);

    // Edit from the context menu (and F4) opens the editor in the other panel and stays in the commander.
    await row(panels.nth(0), "README.md").click({ button: "right" });
    await page.locator(".context-menu").getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("button", { name: "Commander layout" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".fce__title-text")).toContainText("Edit: README.md");
    await expect(page.locator(".fce .monaco-editor .view-lines")).toContainText("Getting started");
    await expect(page.locator(".fcp")).toHaveCount(1);
    await expectContained(page.locator(".fce"));
    await settle(page);
    await page.screenshot({ path: testInfo.outputPath("light-editor-desktop-1440x900.png") });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".fce")).toBeVisible();
    await expectContained(page.locator(".fce"));
    await expectNoPageOverflow(page);
    await settle(page);
    await page.screenshot({ path: testInfo.outputPath("dark-editor-phone-390x844.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".fce").getByRole("button", { name: "Close editor" }).click();
    await expect(page.locator(".fce")).toHaveCount(0);
    await expect(page.locator(".fcp")).toHaveCount(2);
    await page.keyboard.press("F4");
    await expect(page.locator(".fce__title-text")).toContainText("Edit: README.md");
    await page.keyboard.press("F4");
    await expect(page.locator(".fce")).toHaveCount(0);

    // The terminal opens inside the commander, in the other panel, and never becomes a tab.
    const tabCount = await page.locator(".tab").count();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Open a terminal in this folder" }).first().click();
    await expect(page.locator(".fct")).toBeVisible();
    await expect(page.locator(".fcp")).toHaveCount(1);
    await expect(page.locator(".fct .workspace-pane__body--terminal")).toBeVisible();
    await expect(page.locator(".tab")).toHaveCount(tabCount);
    await expectContained(page.locator(".fct"));
    await expectNoPageOverflow(page);
    await settle(page);
    await page.screenshot({ path: testInfo.outputPath("dark-terminal-desktop-1440x900.png") });
    await page.getByRole("button", { name: "Open a terminal in this folder" }).first().click();
    await expect(page.locator(".fct").getByRole("tab")).toHaveCount(2);
    await expect(page.locator(".fct").getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
    await page.locator(".fct").getByRole("tab").first().click();
    await expect(page.locator(".fct").getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".fct .workspace-pane__body--terminal")).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    const terminalSwitcher = page.getByRole("navigation", { name: "Commander panels" });
    await terminalSwitcher.getByRole("button", { name: "Terminal" }).click();
    await expectContained(page.locator(".fct"));
    await expectNoPageOverflow(page);
    await expect(page.locator(".fct").getByRole("tab")).toHaveCount(2);
    await settle(page);
    await page.screenshot({ path: testInfo.outputPath("dark-terminal-phone-390x844.png") });
    await terminalSwitcher.getByRole("button", { name: "Left" }).click();
    await expect(page.locator(".fct")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".fct")).toBeVisible();
    await page.locator(".fcp").first().click();
    await page.keyboard.press("Control+o");
    await expect(page.locator(".fct")).toHaveCount(0);
    await expect(page.locator(".fcp")).toHaveCount(2);
    await page.keyboard.press("Control+o");
    await expect(page.locator(".fct")).toBeVisible();

    // The other layouts still come back and keep working.
    await page.getByRole("button", { name: "Browser layout" }).click();
    await expect(page.locator(".file-list")).toBeVisible();
    await page.getByRole("button", { name: "Commander layout" }).click();
    await expect(page.locator(".fc")).toBeVisible();
    assertNoErrors(page);
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure.png") });
    throw error;
  } finally {
    await page.close();
    await mock.close();
  }
});

async function rootName(panel: Locator): Promise<string> {
  const text = (await panel.locator(".fcp__drive-btn").first().innerText()).trim();
  return text.replace(/^▣\s*/, "");
}
