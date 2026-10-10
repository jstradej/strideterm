import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

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
      expect(layout.gridColumns.split(" ")).toHaveLength(3);
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
