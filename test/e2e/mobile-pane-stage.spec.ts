import { test, expect, type Page } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Mobile PaneStage layout — regression tests for commit 9079ca9
 * ("fix(mobile): initialize isMobileViewport synchronously to fix blank
 * terminal").
 *
 * The bug: `sharedIsMobile` in src/composables/useIsNarrow.ts started as
 * `ref(false)` and was only corrected inside `onMounted`. Because PaneStage
 * is rendered with `v-else-if="store.payload"` it does NOT mount until the
 * very first state broadcast arrives — so when `payload` arrives together
 * with a populated `splitGroup` (workspace persisted with `splitLayout` /
 * `splitViewIds`), Vue's first synchronous render of PaneStage evaluates
 * `visibleTabs` with `isMobileViewport.value === false`, commits all
 * split-group panes to the DOM, and only afterwards does `onMounted` fire
 * and correct the ref. The brief 3-pane intermediate render is what
 * `term.open()` attached to — the subsequent re-render to solo left xterm
 * sized for a small split pane, producing the blank dark area on the
 * active panel that the commit fixed.
 *
 * Test setup details that matter:
 *
 *  - We use the dedicated `multi-workspace-split` fixture which declares
 *    `splitLayout: "top-split"` + `splitViewIds` for ws-frontend's three
 *    panels.
 *  - `delayApiStateMs: 200` makes the mock-server delay the GET
 *    /api/state response so the WebSocket `state:updated` broadcast wins
 *    the race. handleBroadcastPayload only applies the workspace UI state
 *    (splitGroup, activeViewId) when `payload.value` is still unset —
 *    without the delay, /api/state usually wins, payload.value is set
 *    directly without ever calling applyWorkspaceUIStateFromEntry, and
 *    splitGroup stays null. That mirrors a real production startup but
 *    means no fixture would ever surface the original bug.
 *  - `addInitScript` installs a MutationObserver before any page script
 *    runs and records every distinct `data-session-id` that gets attached
 *    to the DOM via a `.terminal-host` div. This is the only direct
 *    signal that distinguishes the buggy intermediate 3-pane render from
 *    the fixed single-pane render: a pane-count check on the final DOM
 *    cannot tell them apart (Vue reconciles back to 1 pane in both
 *    cases), but with the bug, the buggy render had already mounted
 *    three TerminalPane components and each ran `attachTerminalPane`
 *    against its own session. MutationObserver records carry references
 *    to the added nodes, so we can read each session id even after Vue
 *    later detaches two of the three host divs.
 */

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

const ACTIVE_VIEW_ID = "ws-frontend:panel-shell";

declare global {
  interface Window {
    __attachedSessionIds?: string[];
  }
}

/**
 * Records every distinct terminal-host element that gets inserted into the
 * DOM during the lifetime of the page. The `terminal-host` div is created
 * inside `ensureTerminal` (src/app/terminal-controller.ts) and stamped with
 * `data-session-id`; `attachTerminalPane` then appends it to the active
 * pane body. With the 9079ca9 fix in place, only the currently visible
 * pane on a mobile viewport ever runs `attachTerminalPane`, so we record
 * exactly one session id. Without the fix, the buggy intermediate render
 * commits all three split-group panes to the DOM, each TerminalPane's
 * `onMounted` runs `attachTerminalPane` for its own session, and three
 * distinct `data-session-id`s get attached before Vue re-renders to solo
 * — even though only one terminal-host survives in the final DOM.
 *
 * MutationObserver records carry references to the added nodes, so we
 * can read the session id even if the node is later removed from the
 * document. That makes this signal work where a final-state DOM count
 * does not.
 */
async function instrumentTerminalAttachments(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    window.__attachedSessionIds = [];
    const record = (sid: string | undefined | null) => {
      if (sid && !seen.has(sid)) {
        seen.add(sid);
        window.__attachedSessionIds!.push(sid);
      }
    };
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          const el = node as Element;
          if (el.matches?.(".terminal-host")) {
            record((el as HTMLElement).dataset?.sessionId);
          }
          el.querySelectorAll?.(".terminal-host").forEach((host) => {
            record((host as HTMLElement).dataset?.sessionId);
          });
        });
      }
    });
    const start = () => observer.observe(document.body, { childList: true, subtree: true });
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });
}

async function readAttachedSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__attachedSessionIds ?? []);
}

test.describe("PaneStage mobile collapse", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({
      fixture: "multi-workspace-split",
      delayApiStateMs: 200,
      terminalOutput: {
        "ws-frontend:panel-shell": "\r\n$ echo shell-ready\r\nshell-ready\r\n",
        "ws-frontend:panel-claude": "\r\nClaude mock agent ready\r\n> ",
        "ws-frontend:panel-dev": "\r\nVITE v8.0.10 ready in 421 ms\r\nLocal: http://localhost:1421/\r\n",
      },
    });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  // Sanity: confirms the fixture really wires a 3-pane splitGroup and the
  // store applies it on bootstrap. Without this passing, every other test
  // in the file is vacuous — count-1 on mobile would be the natural
  // outcome of an unset splitGroup, not of forceSoloLayout doing its job.
  test("desktop bootstrap renders all three split panes from the persisted layout", async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await openApp(page, mock);

    const stage = page.locator(".terminal-stage");
    await expect(stage).toHaveClass(/terminal-stage--top-split/);
    await expect(stage).toHaveClass(/terminal-stage--count-3/);
    await expect(page.locator(".workspace-pane")).toHaveCount(3);

    assertNoErrors(page);
  });

  test("desktop split panes attach live terminals with mock output and full cell height", async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await openApp(page, mock);

    const stage = page.locator(".terminal-stage");
    await expect(stage).toHaveClass(/terminal-stage--top-split/);
    await expect(page.locator(".workspace-pane")).toHaveCount(3);

    await expect(page.locator(".terminal-host[data-session-id]")).toHaveCount(3);
    await expect(page.locator('.terminal-host[data-session-id="ws-frontend:panel-shell"] .xterm-rows')).toContainText(
      "shell-ready",
    );
    await expect(page.locator('.terminal-host[data-session-id="ws-frontend:panel-claude"] .xterm-rows')).toContainText(
      "Claude mock agent ready",
    );
    await expect(page.locator('.terminal-host[data-session-id="ws-frontend:panel-dev"] .xterm-rows')).toContainText(
      "VITE v8.0.10 ready",
    );

    const metrics = await paneTerminalMetrics(page);
    expect(metrics).toHaveLength(3);
    for (const metric of metrics) {
      expect(metric.paneHeight).toBeGreaterThan(250);
      expect(metric.hostHeight).toBeGreaterThan(200);
      expect(metric.hostBottom).toBeLessThanOrEqual(metric.paneBottom + 1);
    }

    assertNoErrors(page);
  });

  // The regression. Viewport is set BEFORE `goto`, so when the
  // module-level `sharedIsMobile` is initialised it should already see
  // matchMedia(MOBILE_QUERY).matches === true. If a future change reverts
  // useIsNarrow back to `ref(false)` defaults, PaneStage's first
  // synchronous render commits 3 panes, each TerminalPane's onMounted
  // attaches its own xterm host, and the recorded session-id list goes
  // from 1 entry to 3 — even after Vue reconciles back to a single
  // visible pane in the final DOM.
  test("initial mobile load attaches only the active session, not the full splitGroup", async ({ page }) => {
    await instrumentTerminalAttachments(page);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    const stage = page.locator(".terminal-stage");
    await expect(stage).toHaveClass(/terminal-stage--solo/);
    await expect(stage).toHaveClass(/terminal-stage--count-1/);

    const panes = page.locator(".workspace-pane");
    await expect(panes).toHaveCount(1);
    await expect(panes.first()).toHaveAttribute("data-view-id", ACTIVE_VIEW_ID);

    // Wait for at least one terminal-host attachment to land before
    // reading the captured list, so the assertion isn't racing the
    // attachTerminalPane onMounted callback. We assert the final-DOM
    // count of `.terminal-host[data-session-id]` is exactly one as a
    // weaker double-check; the cumulative-list assertion below is the
    // one that catches the original regression.
    await expect(page.locator(".terminal-host[data-session-id]")).toHaveCount(1);

    expect(await readAttachedSessionIds(page)).toEqual([ACTIVE_VIEW_ID]);

    assertNoErrors(page);
  });

  // Symptom-level: even if Vue's reconciliation eventually settles on a
  // single-pane DOM, the original bug left xterm `open()`-ed against a
  // pane sized for the split layout — the active pane on mobile rendered
  // as a blank dark area. Verify the host has a non-trivial layout size
  // and contains an xterm instance.
  test("mobile load attaches xterm into a live, full-size container", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    const activePane = page.locator(`.workspace-pane[data-view-id="${ACTIVE_VIEW_ID}"]`);
    await expect(activePane).toBeVisible();

    const host = activePane.locator(".terminal-host");
    await expect(host).toBeVisible();

    const { width, height } = await host.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    // The pane fills the stage on mobile; we don't need pixel-perfect
    // dimensions, just confirmation that the host isn't 0×0 (blank) and
    // is meaningfully larger than a 3-pane sub-slot would have been on a
    // 390-wide viewport.
    expect(width).toBeGreaterThan(300);
    expect(height).toBeGreaterThan(300);

    // xterm.js adds the `.xterm` wrapper inside the host once
    // `term.open()` has executed against a connected element.
    await expect(host.locator(".xterm")).toBeVisible();

    assertNoErrors(page);
  });

  // Resize coverage. The fix kept the per-instance matchMedia listener
  // intact alongside the new synchronous initialisation — but it's easy
  // to imagine someone "simplifying" the composable by dropping the
  // listener once the sync init is in place. These two tests fail loudly
  // if forceSoloLayout stops responding to viewport changes.
  test("resizing mobile → desktop expands the splitGroup back to 3 panes", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    await expect(page.locator(".workspace-pane")).toHaveCount(1);

    await page.setViewportSize(DESKTOP_VIEWPORT);
    const stage = page.locator(".terminal-stage");
    await expect(stage).toHaveClass(/terminal-stage--top-split/);
    await expect(page.locator(".workspace-pane")).toHaveCount(3);
    await expect(page.locator(".terminal-host[data-session-id]")).toHaveCount(3);

    const metrics = await paneTerminalMetrics(page);
    expect(metrics).toHaveLength(3);
    for (const metric of metrics) {
      expect(metric.hostHeight).toBeGreaterThan(200);
      expect(metric.hostBottom).toBeLessThanOrEqual(metric.paneBottom + 1);
    }

    assertNoErrors(page);
  });

  test("resizing desktop → mobile collapses the splitGroup to solo", async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await openApp(page, mock);

    await expect(page.locator(".workspace-pane")).toHaveCount(3);

    await page.setViewportSize(MOBILE_VIEWPORT);
    const stage = page.locator(".terminal-stage");
    await expect(stage).toHaveClass(/terminal-stage--solo/);
    await expect(page.locator(".workspace-pane")).toHaveCount(1);

    assertNoErrors(page);
  });
});

async function paneTerminalMetrics(
  page: Page,
): Promise<Array<{ paneHeight: number; paneBottom: number; hostHeight: number; hostBottom: number }>> {
  return page.locator(".workspace-pane").evaluateAll((panes) =>
    panes.map((pane) => {
      const host = pane.querySelector(".terminal-host") as HTMLElement | null;
      const paneRect = (pane as HTMLElement).getBoundingClientRect();
      const hostRect = host?.getBoundingClientRect() ?? new DOMRect();
      return {
        paneHeight: paneRect.height,
        paneBottom: paneRect.bottom,
        hostHeight: hostRect.height,
        hostBottom: hostRect.bottom,
      };
    }),
  );
}
