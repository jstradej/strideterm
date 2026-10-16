import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

const viewports = [
  { width: 320, height: 568, name: "320x568" },
  { width: 390, height: 844, name: "390x844" },
  { width: 667, height: 375, name: "667x375" },
  { width: 844, height: 390, name: "844x390" },
  { width: 768, height: 1024, name: "768x1024" },
  { width: 1024, height: 768, name: "1024x768" },
  { width: 820, height: 1180, name: "820x1180" },
  { width: 1180, height: 820, name: "1180x820" },
  { width: 1440, height: 900, name: "1440x900" },
] as const;

type MockHandle = Awaited<ReturnType<typeof startMockServer>>;
const viewportMetrics: Record<string, unknown>[] = [];

async function openChanges(page: Page, mock: MockHandle, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await openApp(page, mock);
  const gitTab = page.locator('[data-role="tab-strip"] button.tab[data-view-id="git:ws-app"]');
  if (await gitTab.isVisible()) await gitTab.click();
  else {
    await page.locator(".mobile-tab-picker__trigger").click();
    await page.locator(".mobile-tab-picker__item").filter({ hasText: "Git" }).click();
  }
  await expect(page.locator(".git-view")).toBeVisible();
  const tabsTrigger = page.locator(".git-view__tabs-trigger");
  await expect
    .poll(async () => (await tabsTrigger.isVisible()) || (await page.locator(".git-tabs").isVisible()))
    .toBe(true);
  if (await tabsTrigger.isVisible()) {
    if ((await tabsTrigger.getAttribute("aria-expanded")) !== "true") await tabsTrigger.click();
    await expect(page.locator(".git-tabs")).toBeVisible();
  } else {
    await expect(page.locator(".git-tabs")).toBeVisible();
  }
  await page.locator('.git-tabs [role="tab"]', { hasText: /^Changes/ }).click();
  await expect(page.locator(".git-section--changes")).toBeVisible();
}

async function saveScreenshot(page: Page, name: string, state: string) {
  const target = path.resolve(".private", `mobile-git-implemented-${name}-${state}.png`);
  await mkdir(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, fullPage: false });
}

async function assertNoHorizontalOverflow(page: Page, mobile: boolean) {
  const metrics = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    height: window.innerHeight,
    buttons: [...document.querySelectorAll<HTMLElement>("button, input[type=checkbox]")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          label: el.getAttribute("aria-label") || el.title || el.innerText || `${el.tagName}.${el.className}`,
          clips: (() => {
            const result: string[] = [];
            let parent = el.parentElement;
            while (parent) {
              const style = getComputedStyle(parent);
              if (/(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
                const box = parent.getBoundingClientRect();
                if (
                  (style.overflowX !== "visible" && (rect.left < box.left || rect.right > box.right)) ||
                  (style.overflowY !== "visible" && (rect.top < box.top || rect.bottom > box.bottom))
                )
                  result.push(`${parent.tagName}.${parent.className}`);
              }
              parent = parent.parentElement;
            }
            return result;
          })(),
        };
      })
      .filter(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.left < document.documentElement.clientWidth &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight,
      )
      .filter((rect) => rect.clips.length === 0),
  }));
  expect(metrics.scroll, "document should not scroll horizontally").toBeLessThanOrEqual(metrics.client + 1);
  for (const button of metrics.buttons) {
    expect(button.left, `Visible control starts within viewport: ${button.label}`).toBeGreaterThanOrEqual(-1);
    expect(button.right, `Visible control ends within viewport: ${button.label}`).toBeLessThanOrEqual(
      metrics.client + 1,
    );
    expect(button.top, `Visible control starts within viewport: ${button.label}`).toBeGreaterThanOrEqual(-1);
    expect(
      button.bottom,
      `Visible control ends within viewport: ${button.label}; rect=${JSON.stringify(button)}; viewportHeight=${metrics.height}`,
    ).toBeLessThanOrEqual(metrics.height + 1);
    expect(button.width).toBeGreaterThan(0);
    expect(button.height).toBeGreaterThan(0);
  }
  if (mobile) {
    const inputBar = page.locator(".mobile-input-bar");
    const bar = (await inputBar.count()) ? await inputBar.boundingBox() : null;
    if (bar) {
      for (const button of metrics.buttons) {
        expect(
          button.bottom <= bar.y || button.top >= bar.y + bar.height,
          "Git action remains clear of remote input bar",
        ).toBe(true);
      }
    }
  }
}

test.describe("mobile Git Changes responsive renderer", () => {
  let mock: MockHandle;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "mobile-git" });
  });
  test.afterAll(async () => mock?.close());
  test.afterAll(async () => {
    await writeFile(
      path.resolve(".private", "mobile-git-implemented-metrics.json"),
      `${JSON.stringify(viewportMetrics, null, 2)}\n`,
    );
  });

  for (const viewport of viewports) {
    test(`layout, list/detail/back, scope groups, and commit fit ${viewport.name}`, async ({ page }) => {
      await openChanges(page, mock, viewport);
      const root = page.locator(".git-section--changes");
      const mobile = await root.evaluate((el) => el.classList.contains("git-changes--mobile"));
      const layout = await root.getAttribute("data-layout");
      if (mobile) {
        await expect(root).toHaveAttribute("data-mode", "list");
        if (viewport.height <= 500 && viewport.width >= 800) await expect(root).toHaveAttribute("data-layout", "split");
        const filters = page.getByRole("navigation", { name: "Change scope filter" });
        await expect(filters.getByRole("button", { name: /^All/ })).toBeVisible();
        await expect(filters.getByRole("button", { name: /^Staged/ })).toBeVisible();
        await expect(filters.getByRole("button", { name: /^Unstaged/ })).toBeVisible();
        await expect(filters.getByRole("button", { name: /^New/ })).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Open src/components/workspace/git/GitPane.vue staged diff" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Open src/components/workspace/git/GitPane.vue unstaged diff" }),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: "Open src/legacy/old-mobile.css staged diff" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Open docs/mobile-git-notes.md untracked diff" })).toBeVisible();
        await expect(page.locator(".gct-node__row").filter({ hasText: "conflict-resolver.ts" })).toBeVisible();
        await expect(page.locator(".git-changes__mobile-list .gct")).toBeVisible();
        await filters.getByRole("button", { name: /^Staged/ }).click();
        await expect(
          page.getByRole("button", { name: "Open src/components/workspace/git/GitPane.vue staged diff" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Open src/components/workspace/git/GitPane.vue unstaged diff" }),
        ).toHaveCount(0);
        await filters.getByRole("button", { name: /^All/ }).click();
      } else {
        await expect(page.locator(".git-section__files--split .gct")).toBeVisible();
      }
      await saveScreenshot(page, viewport.name, "list");

      const scroller = page.locator(
        mobile ? ".git-changes__mobile-list > .gct" : ".git-section__files--split > .git-card > .gct",
      );
      const listBox = await scroller.boundingBox();
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      if (mobile) await page.getByRole("button", { name: "Open src/legacy/old-mobile.css staged diff" }).click();
      else await page.locator(".gct-node__row").filter({ hasText: "old-mobile.css" }).first().click();
      if (mobile) {
        await expect(root).toHaveAttribute("data-mode", "diff");
        await expect(page.locator(".git-changes__mobile-path")).toContainText("old-mobile.css");
        if (layout === "split") {
          await expect(page.locator(".git-changes__mobile-list .gct")).toBeVisible();
          const editorBody = page.locator(".git-changes__mobile-diff .mdp__body");
          await expect(editorBody).toBeVisible();
          const editorBox = await editorBody.boundingBox();
          expect(editorBox?.height, "split diff editor needs a usable vertical canvas").toBeGreaterThanOrEqual(100);
          expect(editorBox?.width, "split diff editor needs a usable horizontal canvas").toBeGreaterThanOrEqual(200);
        }
      }
      const diffView = mobile ? page.locator(".git-changes__mobile-diff") : page.locator(".git-section__preview--diff");
      await expect(diffView.locator(".monaco-editor, .mdp__body").first()).toBeVisible({ timeout: 15_000 });
      await expect(diffView.locator(".monaco-editor .view-lines").last()).toContainText("after:", { timeout: 15_000 });
      const beforeScroll = await scroller.evaluate((el) => el.scrollTop);
      await saveScreenshot(page, viewport.name, "diff");
      const diffMetrics = await diffView.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const body = el.querySelector<HTMLElement>(".mdp__body")?.getBoundingClientRect();
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          editorWidth: body?.width ?? 0,
          editorHeight: body?.height ?? 0,
        };
      });
      if (mobile) {
        await page.getByRole("button", { name: "‹ Changes" }).click();
        await expect(root).toHaveAttribute("data-mode", "list");
      }

      if (mobile && layout !== "split") {
        await page.getByRole("button", { name: "Open src/assets/logo.png staged diff" }).click();
        await expect(page.locator(".git-changes__mobile-diff .mdp__overlay--error")).toContainText(
          "Binary file; text diff is unavailable.",
        );
        await page.getByRole("button", { name: "‹ Changes" }).click();
      }
      if ((await scroller.count()) && beforeScroll > 0)
        await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(beforeScroll - 2);

      const selection = page
        .getByRole("checkbox", {
          name: "Select src/components/workspace/git/GitPane.vue for commit and stash",
        })
        .first();
      await selection.check();
      if (mobile) await page.getByRole("button", { name: "Commit 1…" }).click();
      const message = mobile
        ? page.getByRole("textbox", { name: "Commit message" })
        : page.locator("input[name='commit-message']");
      if (mobile) await expect(root).toHaveAttribute("data-mode", "commit");
      const commitText = mobile ? "Improve mobile Git layout\nPreserve selected files" : "Improve mobile Git layout";
      await message.fill(commitText);
      await expect(message).toHaveValue(commitText);
      if (mobile) await expect(page.getByRole("button", { name: "Commit selected (1)" })).toBeVisible();
      await saveScreenshot(page, viewport.name, "commit");
      await assertNoHorizontalOverflow(page, mobile);
      const ctaLocator = mobile
        ? page.getByRole("button", { name: "Commit selected (1)" })
        : page
            .locator(".git-section--changes button")
            .filter({ hasText: /^Commit/ })
            .last();
      const ctaBox = await ctaLocator.boundingBox();
      viewportMetrics.push({
        viewport: viewport.name,
        mode: mobile ? "mobile" : "desktop",
        layout,
        listWidth: listBox?.width ?? 0,
        diff: diffMetrics,
        cta: ctaBox ? { x: ctaBox.x, y: ctaBox.y, width: ctaBox.width, height: ctaBox.height } : null,
      });
      if (mobile) {
        await page.getByRole("button", { name: "Back to changes" }).click();
        await expect(root).toHaveAttribute("data-mode", "list");
      }
      if (viewport.name === "390x844") {
        await page
          .getByRole("checkbox", {
            name: "Select src/components/workspace/git/GitPane.vue for commit and stash",
          })
          .check();
        const groupRow = page
          .locator(".git-changes__mobile-list .gct-node__row--folder")
          .filter({ hasText: "workspace" })
          .first();
        const group = groupRow.locator("xpath=ancestor::*[@role='treeitem'][1]");
        await groupRow.click();
        await expect(group).toHaveAttribute("aria-expanded", "false");
        await page.setViewportSize({ width: 1024, height: 768 });
        await expect(
          page
            .locator(
              '.git-section__files--split input[type="checkbox"][aria-label="Select src/components/workspace/git/GitPane.vue for commit and stash"]',
            )
            .first(),
        ).toBeChecked();
        await page.setViewportSize({ width: 768, height: 1024 });
        await expect(
          page
            .locator('.git-changes__mobile-list [role="treeitem"][aria-expanded="false"]')
            .filter({ hasText: "workspace" })
            .first(),
        ).toBeVisible();
        await page
          .locator(".git-changes__mobile-list .gct-node__row--folder")
          .filter({ hasText: "workspace" })
          .first()
          .click();
        await expect(
          page.getByRole("checkbox", {
            name: "Select src/components/workspace/git/GitPane.vue for commit and stash",
          }),
        ).toBeChecked();
        await page.getByRole("button", { name: "Commit 1…" }).click();
        const rotationMessage = page.getByRole("textbox", { name: "Commit message" });
        const rotationText = "Tablet rotation commit\nKeep this second line";
        await rotationMessage.fill(rotationText);
        await page.setViewportSize({ width: 1024, height: 768 });
        await expect(root).toHaveAttribute("data-mode", "commit");
        await expect(rotationMessage).toHaveValue(rotationText);
        const rotationCta = page.getByRole("button", { name: "Commit selected (1)" });
        await expect(rotationCta).toBeVisible();
        await page.setViewportSize({ width: 768, height: 1024 });
        await expect(root).toHaveAttribute("data-mode", "commit");
        await expect(rotationMessage).toHaveValue(rotationText);
        await expect(rotationCta).toBeVisible();
        await page.getByRole("button", { name: "Back to changes" }).click();
        await expect(root).toHaveAttribute("data-mode", "list");
      }
      if (viewport.name === "320x568" && mobile) {
        await page.getByRole("button", { name: "Commit 1…" }).click();
        const keyboardMessage = page.getByRole("textbox", { name: "Commit message" });
        await keyboardMessage.fill("Mobile keyboard viewport check\nSecond line");
        await page.setViewportSize({ width: 320, height: 390 });
        await expect(keyboardMessage).toBeVisible();
        await assertNoHorizontalOverflow(page, true);
        const commitButton = page.getByRole("button", { name: "Commit selected (1)" });
        await expect(commitButton).toBeVisible();
        await expect
          .poll(async () => {
            const box = await commitButton.boundingBox();
            return box ? box.y + box.height : 0;
          })
          .toBeGreaterThan(0);
        const cta = await commitButton.boundingBox();
        expect(cta ? cta.y + cta.height : 999).toBeLessThanOrEqual(391);
      }
      assertNoErrors(page);
    });
  }
});

test("native keyboard channel keeps commit controls above the keyboard without shrinking the document twice", async ({
  page,
}) => {
  const mock = await startMockServer({ fixture: "mobile-git" });
  try {
    await page.addInitScript(() => {
      window.StridetermViewport = { postMessage: () => {} };
    });
    await openChanges(page, mock, { width: 320, height: 568 });
    await page
      .getByRole("checkbox", {
        name: "Select src/components/workspace/git/GitPane.vue for commit and stash",
      })
      .first()
      .check();
    await page.getByRole("button", { name: "Commit 1…" }).click();
    const message = page.getByRole("textbox", { name: "Commit message" });
    await message.fill("Native keyboard commit\nSecond line");
    await expect.poll(() => page.evaluate(() => Boolean(window.__stridetermViewport?.update))).toBe(true);
    await page.evaluate(() => {
      window.__stridetermViewport?.update({ width: 320, height: 568, bottom: 250 });
    });
    await expect(page.locator("html")).toHaveClass(/native-keyboard-viewport/);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--strideterm-keyboard-bottom")))
      .toBe("250px");
    await expect(message).toBeVisible();
    const cta = page.getByRole("button", { name: "Commit selected (1)" });
    const dock = page.locator(".git-changes__mobile-dock");
    await expect(cta).toBeVisible();
    const visibleBottom = 568 - 250;
    const [messageBox, ctaBox, dockBox] = await Promise.all([
      message.boundingBox(),
      cta.boundingBox(),
      dock.boundingBox(),
    ]);
    expect(messageBox).not.toBeNull();
    expect(ctaBox).not.toBeNull();
    expect(dockBox).not.toBeNull();
    expect(messageBox!.y + messageBox!.height).toBeLessThanOrEqual(visibleBottom);
    expect(messageBox!.y + messageBox!.height).toBeLessThanOrEqual(dockBox!.y + 1);
    expect(ctaBox!.y + ctaBox!.height).toBeLessThanOrEqual(visibleBottom);
    expect(await page.evaluate(() => document.documentElement.style.height)).toBe("568px");
    expect(await page.evaluate(() => document.documentElement.clientHeight)).toBe(568);
    await writeFile(
      path.resolve(".private", "mobile-git-implemented-320x568-native-keyboard-metrics.json"),
      `${JSON.stringify(
        {
          viewport: { width: 320, height: 568, keyboardBottom: 250, uncoveredBottom: visibleBottom },
          textarea: messageBox,
          dock: dockBox,
          cta: ctaBox,
          documentHeight: 568,
        },
        null,
        2,
      )}\n`,
    );
    await saveScreenshot(page, "320x568", "native-keyboard");
    assertNoErrors(page);
  } finally {
    await mock.close();
  }
});
