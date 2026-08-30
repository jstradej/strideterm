import { test, expect, type Page } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * V6 review, §"P1 UX — activity cluster přetéká už při defaultních 248 px".
 *
 * The 15:07 screenshot: the nested recent rows run past the sidebar's right
 * edge, so the cluster border, the trailing time and part of the name end up
 * under the workspace panel — with `overflow-x: hidden` on the list masking the
 * overflow instead of the row adapting to the width it actually has.
 *
 * jsdom has no layout, so the unit tests can only assert that the CSS says the
 * right thing. THESE tests measure real bounding boxes in Chromium, at the
 * default width and at the two narrower ones the plan's width budget names
 * (248 / 220 / 200 px). The fixture is deliberately hostile: six levels of
 * nesting and names far longer than any panel can show.
 */

const SIDEBAR_WIDTHS = [248, 220, 200];

/** Fresh `lastWorkedAt` stamps — the recent window is the last 24 hours. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stampRecent(payload: any): void {
  const now = Date.now();
  const minutesAgo: Record<string, number> = {
    "ws-az": 40,
    "ws-repo": 32,
    "ws-pr": 12,
    "ws-review": 8,
    "ws-deep": 5,
    "ws-deepest": 2,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const ws of payload.appState.workspaces as any[]) {
    const minutes = minutesAgo[ws.id];
    if (minutes !== undefined) ws.lastWorkedAt = new Date(now - minutes * 60_000).toISOString();
  }
  // The task has been running for three hours — long enough for a stable
  // elapsed and short enough to stay in the RUNNING surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const task = (payload.appState.workspaces as any[]).find((ws) => ws.id === "ws-task");
  if (task?.task) task.task.startedAt = new Date(now - 3 * 60 * 60_000).toISOString();
}

async function setSidebarWidth(page: Page, width: number): Promise<void> {
  await page.evaluate((px) => {
    const frame = document.querySelector(".frame") as HTMLElement | null;
    frame?.style.setProperty("--sidebar-width", `${px}px`);
  }, width);
  // One frame for the container query and the grid track to settle.
  await page.waitForFunction(
    (px) => (document.querySelector(".sidebar") as HTMLElement)?.getBoundingClientRect().width <= px + 1,
    width,
  );
}

test.describe("Sidebar activity surfaces — responsive containment", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;

  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "activity-forest", patchState: stampRecent });
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test.beforeEach(async ({ page }) => {
    await openApp(page, mock);
    await expect(page.locator('[data-role="recent-shortcuts"]')).toBeVisible();
    await expect(page.locator('[data-role="running-agents"]')).toBeVisible();
  });

  test("no cluster or row escapes the sidebar at 248, 220 or 200 px", async ({ page }) => {
    for (const width of SIDEBAR_WIDTHS) {
      await setSidebarWidth(page, width);

      const overflow = await page.evaluate(() => {
        const sidebar = document.querySelector(".sidebar") as HTMLElement;
        const list = document.querySelector('[data-role="workspace-list"]') as HTMLElement;
        const sidebarRight = sidebar.getBoundingClientRect().right;
        const problems: string[] = [];

        for (const cluster of Array.from(document.querySelectorAll(".activity-cluster"))) {
          const clusterBox = (cluster as HTMLElement).getBoundingClientRect();
          if (clusterBox.right > sidebarRight + 0.5) {
            problems.push(`cluster right ${clusterBox.right} > sidebar ${sidebarRight}`);
          }
          for (const row of Array.from(cluster.querySelectorAll(".activity-row"))) {
            const rowBox = (row as HTMLElement).getBoundingClientRect();
            if (rowBox.right > clusterBox.right + 0.5) {
              problems.push(`row ${row.getAttribute("data-row-key")} right ${rowBox.right} > cluster`);
            }
          }
        }
        // The panel adapts; it never asks the user to scroll sideways.
        if (list.scrollWidth > list.clientWidth + 1) {
          problems.push(`list scrollWidth ${list.scrollWidth} > clientWidth ${list.clientWidth}`);
        }
        return problems;
      });

      expect(overflow, `sidebar ${width}px`).toEqual([]);
    }
    assertNoErrors(page);
  });

  test("every activity row keeps its whole trailing time, at every supported width", async ({ page }) => {
    for (const width of SIDEBAR_WIDTHS) {
      await setSidebarWidth(page, width);

      const clipped = await page.evaluate(() => {
        const problems: string[] = [];
        for (const row of Array.from(document.querySelectorAll(".activity-row"))) {
          const trailing = row.querySelector(".activity-row__trailing") as HTMLElement | null;
          if (!trailing) continue;
          const rowBox = (row as HTMLElement).getBoundingClientRect();
          const box = trailing.getBoundingClientRect();
          const key = row.getAttribute("data-row-key") || "";
          if (box.width === 0) problems.push(`${key}: trailing collapsed`);
          if (box.right > rowBox.right + 0.5) problems.push(`${key}: trailing past the row`);
          if (trailing.scrollWidth > trailing.clientWidth + 1) problems.push(`${key}: trailing ellipsised`);
        }
        return problems;
      });

      expect(clipped, `sidebar ${width}px`).toEqual([]);
    }
    assertNoErrors(page);
  });

  test("the text column is the only thing that shrinks — the label ellipsises before the tail", async ({ page }) => {
    await setSidebarWidth(page, 200);

    const measured = await page.evaluate(() => {
      // The PR row's name is far longer than any supported panel width.
      const row = document.querySelector('.recent-shortcuts [data-workspace-id="ws-pr"]') as HTMLElement;
      const label = row.querySelector(".activity-row__label") as HTMLElement;
      const trailing = row.querySelector(".activity-row__trailing") as HTMLElement;
      return {
        labelTruncated: label.scrollWidth > label.clientWidth,
        trailingIntact: trailing.scrollWidth <= trailing.clientWidth + 1,
        labelRight: label.getBoundingClientRect().right,
        trailingLeft: trailing.getBoundingClientRect().left,
      };
    });

    // The names in this fixture are far longer than 200 px can show, so the
    // label MUST be ellipsised — and the tail must not have moved for it.
    expect(measured.labelTruncated).toBe(true);
    expect(measured.trailingIntact).toBe(true);
    expect(measured.labelRight).toBeLessThanOrEqual(measured.trailingLeft + 0.5);
    assertNoErrors(page);
  });

  test("a deep branch does not overflow, and its indent saturates", async ({ page }) => {
    await setSidebarWidth(page, 200);

    const depths = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.recent-shortcuts [data-role="activity-node-row"]'));
      const list = document.querySelector('[data-role="workspace-list"]') as HTMLElement;
      const listRight = list.getBoundingClientRect().right;
      return rows.map((row) => {
        const el = row as HTMLElement;
        const text = el.querySelector(".activity-row__text") as HTMLElement;
        return {
          depth: Number(el.getAttribute("data-depth")),
          left: el.getBoundingClientRect().left,
          right: el.getBoundingClientRect().right,
          overflows: el.getBoundingClientRect().right > listRight + 0.5,
          textWidth: text.getBoundingClientRect().width,
        };
      });
    });

    // The fixture nests six levels; depth 1, 3 and 5 all have to be present.
    expect(depths.map((d) => d.depth)).toEqual(expect.arrayContaining([1, 3, 5]));
    for (const row of depths) {
      expect(row.overflows, `depth ${row.depth}`).toBe(false);
      // A saturated indent means the deepest row still has a usable name.
      expect(row.textWidth, `depth ${row.depth} text budget`).toBeGreaterThan(20);
    }
    const deepest = depths.find((d) => d.depth === 5)!;
    const capped = depths.find((d) => d.depth === 3)!;
    expect(deepest.left).toBeCloseTo(capped.left, 0);
    assertNoErrors(page);
  });

  test("the running state stays on one line and never covers the elapsed", async ({ page }) => {
    await setSidebarWidth(page, 248);

    const running = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.running-agents [data-role="activity-node-row"]'));
      const row = rows[0] as HTMLElement;
      const state = row.querySelector(".activity-row__state") as HTMLElement;
      const trailing = row.querySelector(".activity-row__trailing") as HTMLElement;
      const stateBox = state.getBoundingClientRect();
      const trailingBox = trailing.getBoundingClientRect();
      return {
        text: state.textContent?.trim(),
        height: row.getBoundingClientRect().height,
        lineHeight: stateBox.height,
        overlaps: stateBox.right > trailingBox.left + 0.5,
        contextRowCount: document.querySelectorAll('.running-agents [data-role="activity-context-row"]').length,
      };
    });

    // The short label, not the raw sixteen-character `judge-evaluating`.
    expect(running.text).toBe("judging");
    expect(running.overlaps).toBe(false);
    // One line: the state box is nowhere near two rows of 10px text.
    expect(running.lineHeight).toBeLessThan(20);
    expect(running.height).toBeLessThan(60);
    expect(running.contextRowCount).toBeGreaterThan(0);
    assertNoErrors(page);
  });

  test("the status dot, the grid badge and the attention cue are overlays with no layout cost", async ({ page }) => {
    await setSidebarWidth(page, 248);

    const overlays = await page.evaluate(() => {
      const row = document.querySelector('.running-agents [data-role="activity-node-row"]') as HTMLElement;
      const before = row.getBoundingClientRect();
      const badge = row.querySelector(".activity-row__badge") as HTMLElement;
      const badgeBefore = badge.getBoundingClientRect();
      const dot = row.querySelector(".activity-row__status-dot") as HTMLElement | null;
      const dotPosition = dot ? getComputedStyle(dot).position : "";
      // Remove the dot: an overlay costs the row nothing, so nothing moves.
      dot?.remove();
      const after = row.getBoundingClientRect();
      const badgeAfter = badge.getBoundingClientRect();
      return {
        hadDot: !!dot,
        dotPosition,
        sameRow: before.height === after.height && before.width === after.width,
        sameBadge: badgeBefore.width === badgeAfter.width && badgeBefore.height === badgeAfter.height,
      };
    });

    expect(overlays.hadDot).toBe(true);
    expect(overlays.dotPosition).toBe("absolute");
    expect(overlays.sameRow).toBe(true);
    expect(overlays.sameBadge).toBe(true);
    assertNoErrors(page);
  });

  test("the status dot, the grid-slot badge and the attention cue never overlap each other", async ({ page }) => {
    await setSidebarWidth(page, 248);

    const boxes = await page.evaluate(() => {
      // The fixture pins the running task to a grid slot AND gives it three
      // attention alerts, so all three cues are on one row at once.
      const row = document.querySelector('.running-agents [data-role="activity-node-row"]') as HTMLElement;
      const pick = (selector: string) => {
        const el = row.querySelector(selector) as HTMLElement | null;
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      return {
        status: pick(".activity-row__status-dot"),
        slot: pick(".activity-row__slot"),
        attention: pick(".activity-row__attention"),
      };
    });

    expect(boxes.status, "status dot").not.toBeNull();
    expect(boxes.slot, "grid slot badge").not.toBeNull();
    expect(boxes.attention, "attention cue").not.toBeNull();

    const overlaps = (a: NonNullable<typeof boxes.status>, b: NonNullable<typeof boxes.status>): boolean =>
      a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

    // Three different anchors: bottom-right of the badge, top-right of the
    // badge, top-right of the row. None of them may cover another.
    expect(overlaps(boxes.status!, boxes.slot!), "status vs slot").toBe(false);
    expect(overlaps(boxes.status!, boxes.attention!), "status vs attention").toBe(false);
    expect(overlaps(boxes.slot!, boxes.attention!), "slot vs attention").toBe(false);
    assertNoErrors(page);
  });

  test("a longer running state cannot resize the row or move the elapsed", async ({ page }) => {
    await setSidebarWidth(page, 248);

    const stable = await page.evaluate(() => {
      const row = document.querySelector('.running-agents [data-role="activity-node-row"]') as HTMLElement;
      const state = row.querySelector(".activity-row__state") as HTMLElement;
      const trailing = row.querySelector(".activity-row__trailing") as HTMLElement;
      const before = { row: row.getBoundingClientRect(), trailing: trailing.getBoundingClientRect() };

      // What a background state change looks like to the layout: the slot is
      // reserved and fixed, so even the raw sixteen-character state cannot
      // grow it, wrap it, or push the elapsed.
      state.textContent = "judge-evaluating-and-then-some";
      const after = { row: row.getBoundingClientRect(), trailing: trailing.getBoundingClientRect() };

      return {
        sameHeight: before.row.height === after.row.height,
        sameWidth: before.row.width === after.row.width,
        sameTrailingLeft: before.trailing.left === after.trailing.left,
        stateEllipsised: state.scrollWidth > state.clientWidth,
      };
    });

    expect(stable.sameHeight).toBe(true);
    expect(stable.sameWidth).toBe(true);
    expect(stable.sameTrailingLeft).toBe(true);
    expect(stable.stateEllipsised).toBe(true);
    assertNoErrors(page);
  });

  test("the focus outline of a narrow row stays inside the sidebar", async ({ page }) => {
    await setSidebarWidth(page, 200);

    const inside = await page.evaluate(() => {
      const sidebar = (document.querySelector(".sidebar") as HTMLElement).getBoundingClientRect();
      const row = document.querySelector('.recent-shortcuts [data-role="activity-node-row"]') as HTMLElement;
      row.focus();
      const box = row.getBoundingClientRect();
      // The outline is drawn with `outline-offset: -2px`, i.e. INSIDE the row,
      // so the row's own box is the whole of it.
      return {
        offset: getComputedStyle(row).outlineOffset,
        withinLeft: box.left >= sidebar.left - 0.5,
        withinRight: box.right <= sidebar.right + 0.5,
        focused: document.activeElement === row,
      };
    });

    expect(inside.focused).toBe(true);
    expect(inside.offset).toBe("-2px");
    expect(inside.withinLeft).toBe(true);
    expect(inside.withinRight).toBe(true);
    assertNoErrors(page);
  });

  test("a coarse pointer gets its larger hit targets, still entirely inside the sidebar", async ({ browser }) => {
    // `@media (pointer: coarse)` follows touch capability in Chromium, so the
    // narrow-drawer / mobile case needs its own touch-enabled context.
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 1280, height: 720 } });
    const touchPage = await context.newPage();
    try {
      await openApp(touchPage, mock);
      await expect(touchPage.locator('[data-role="recent-shortcuts"]')).toBeVisible();
      await setSidebarWidth(touchPage, 200);

      const targets = await touchPage.evaluate(() => {
        const sidebar = (document.querySelector(".sidebar") as HTMLElement).getBoundingClientRect();
        return Array.from(document.querySelectorAll(".activity-row")).map((row) => {
          const el = row as HTMLElement;
          const box = el.getBoundingClientRect();
          return {
            role: el.getAttribute("data-role"),
            height: box.height,
            inside: box.left >= sidebar.left - 0.5 && box.right <= sidebar.right + 0.5,
          };
        });
      });

      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(target.inside).toBe(true);
        expect(target.height).toBeGreaterThanOrEqual(target.role === "activity-context-row" ? 32 : 40);
      }
      assertNoErrors(touchPage);
    } finally {
      await context.close();
    }
  });

  test("the collapsed strip renders neither dynamic section", async ({ page }) => {
    await page.locator("button[data-role='sidebar-collapse']").click();

    await expect(page.locator('[data-role="running-agents"]')).toBeHidden();
    await expect(page.locator('[data-role="recent-shortcuts"]')).toBeHidden();
    assertNoErrors(page);
  });
});
