import { test, expect, type Page } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

// Read terminal text from the DOM renderer's `.xterm-rows` (see mobile-input-bar.spec.ts).
test.use({
  launchOptions: { args: ["--disable-webgl"] },
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

/**
 * A phone tap on the terminal. The terminal's touchstart calls
 * preventDefault() to own scrolling and pinch, which also stops Chromium from
 * turning the tap into mouse events — so nothing a desktop mouse clicks
 * answered a finger: a full-screen TUI's own controls (Claude Code's
 * "1 new message", the /config tabs) or a link in the output.
 */

const SESSION_ID = "ws-frontend:panel-shell";
const INPUT = "[data-role='mobile-input-bar-input']";

// The modes Claude Code's full-screen TUI turns on — alternate screen, mouse
// tracking up to any-motion (1000/1002/1003), focus reports (1004), SGR
// encoding (1006) — and a control at row 5, column 3.
const TUI_OUTPUT =
  "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h\x1b[2J\x1b[5;3H1 new message (ctrl+End)";
const URL_OUTPUT = "\r\n$ open docs\r\nsee https://example.com/strideterm-docs for more\r\n";

/** Viewport centre of `needle` inside the session's rendered rows. */
async function centerOf(page: Page, needle: string): Promise<{ x: number; y: number }> {
  const rows = page.locator(`.terminal-host[data-session-id="${SESSION_ID}"] .xterm-rows`);
  await expect(rows).toContainText(needle);
  const point = await rows.evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    return null;
  }, needle);
  expect(point, `"${needle}" is not one text run in the DOM renderer`).not.toBeNull();
  return point!;
}

/** Counts the mouse events the BROWSER produced on the terminal, as opposed to the app's own. */
async function countTrustedMouseDowns(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { __trustedMouseDowns: number };
    w.__trustedMouseDowns = 0;
    document.addEventListener(
      "mousedown",
      (event) => {
        if (event.isTrusted) w.__trustedMouseDowns += 1;
      },
      true,
    );
  });
  return () => page.evaluate(() => (window as unknown as { __trustedMouseDowns: number }).__trustedMouseDowns);
}

const xtermTextareaFocused = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.classList.contains("xterm-helper-textarea"));

test.describe("Terminal tap — mouse-tracking TUI", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace", terminalOutput: { [SESSION_ID]: TUI_OUTPUT } });
  });
  test.afterAll(async () => {
    await mock?.close();
  });
  test.beforeEach(() => {
    mock.terminalInputs.length = 0;
  });

  // xterm's own answer when the replay turns 1004 on comes from its hidden
  // textarea — focus-out on a phone, which told the app a connected phone had
  // left. The client reports what it actually shows instead.
  test("the terminal the client shows is reported focused, not xterm's textarea", async ({ page }) => {
    await openApp(page, mock);
    await centerOf(page, "new message");

    await expect
      .poll(() => mock.terminalInputs.filter((input) => input.sessionId === SESSION_ID))
      .toEqual([{ sessionId: SESSION_ID, data: "\x1b[I" }]);

    assertNoErrors(page);
  });

  // The app gets the pointer's arrival before the press — an app that
  // highlights what is under the pointer clicks what it drew as hovered — and
  // both travel as ONE input, so the backend can space them at the PTY.
  test("a tap on the TUI's control sends the arrival and the click of that cell as one input", async ({ page }) => {
    await openApp(page, mock);
    const target = await centerOf(page, "new message");
    const trustedMouseDowns = await countTrustedMouseDowns(page);
    await expect.poll(() => mock.terminalInputs.length).toBeGreaterThan(0);
    mock.terminalInputs.length = 0;

    await page.touchscreen.tap(target.x, target.y);

    await expect.poll(() => mock.terminalInputs.length).toBe(1);
    const [input] = mock.terminalInputs;
    const column = input.data.match(/^\x1b\[<0;(\d+);5M/)?.[1];
    // "1 new message (ctrl+End)" spans columns 3–26.
    expect(Number(column)).toBeGreaterThanOrEqual(3);
    expect(Number(column)).toBeLessThanOrEqual(26);
    expect(input).toEqual({
      sessionId: SESSION_ID,
      data: `\x1b[<0;${column};5M\x1b[<0;${column};5m`,
      pointerArrival: `\x1b[<35;${column};5M`,
    });
    // The browser itself produced no mouse event — the click is the app's own.
    expect(await trustedMouseDowns()).toBe(0);
    expect(await xtermTextareaFocused(page)).toBe(false);

    assertNoErrors(page);
  });

  test("the composer keeps its focus when the tap clicks the TUI", async ({ page }) => {
    await openApp(page, mock);
    const target = await centerOf(page, "new message");
    await page.locator(INPUT).tap();
    await expect(page.locator(INPUT)).toBeFocused();

    await page.touchscreen.tap(target.x, target.y);

    await expect.poll(() => mock.terminalInputs.length).toBeGreaterThan(0);
    await expect(page.locator(INPUT)).toBeFocused();
    expect(await xtermTextareaFocused(page)).toBe(false);
    await expect(page.locator(".xterm-helper-textarea").first()).toBeEnabled();

    assertNoErrors(page);
  });
});

test.describe("Terminal tap — links in plain output", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "multi-workspace", terminalOutput: { [SESSION_ID]: URL_OUTPUT } });
  });
  test.afterAll(async () => {
    await mock?.close();
  });
  test.beforeEach(async ({ page }) => {
    mock.terminalInputs.length = 0;
    await page.addInitScript(() => {
      const w = window as unknown as { __opened: string[] };
      w.__opened = [];
      window.open = (url?: string | URL) => {
        w.__opened.push(String(url));
        return null;
      };
    });
  });
  const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

  test("a tap on a URL opens it", async ({ page }) => {
    await openApp(page, mock);
    const target = await centerOf(page, "example.com/strideterm-docs");

    await page.touchscreen.tap(target.x, target.y);

    await expect.poll(() => opened(page)).toEqual(["https://example.com/strideterm-docs"]);
    expect(mock.terminalInputs).toEqual([]);
    expect(await xtermTextareaFocused(page)).toBe(false);

    assertNoErrors(page);
  });

  test("a tap beside the link opens nothing and sends nothing", async ({ page }) => {
    await openApp(page, mock);
    const target = await centerOf(page, "open docs");

    await page.touchscreen.tap(target.x, target.y);
    // Give a wrongly forwarded click time to arrive before asserting it did not.
    await page.waitForTimeout(300);

    expect(await opened(page)).toEqual([]);
    expect(mock.terminalInputs).toEqual([]);
    expect(await xtermTextareaFocused(page)).toBe(false);

    assertNoErrors(page);
  });
});
