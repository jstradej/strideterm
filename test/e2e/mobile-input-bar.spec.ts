import { test, expect } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { openApp, assertNoErrors } from "./helpers.js";

/**
 * Mobile composer input bar (MobileInputBar.vue) — the workaround for the
 * upstream xterm.js Android IME bug (xtermjs/xterm.js#3600). On mobile
 * remote clients a plain <input> row is pinned under the terminal; lines
 * composed there are pushed to the PTY over the same `terminal:input` WS
 * channel that xterm's onData uses, so predictive keyboards never touch
 * xterm's hidden textarea.
 *
 * The mock server records every `terminal:input` frame in
 * `mock.terminalInputs`, which is what the send assertions read.
 */

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

// multi-workspace fixture: active workspace ws-frontend, first tab panel-shell.
const ACTIVE_SESSION_ID = "ws-frontend:panel-shell";

const BAR = "[data-role='mobile-input-bar']";
const INPUT = "[data-role='mobile-input-bar-input']";

test.describe("Mobile composer input bar", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({
      fixture: "multi-workspace",
      terminalOutput: {
        "ws-frontend:panel-shell": "\r\n$ echo shell-ready\r\nshell-ready\r\n",
      },
    });
  });
  test.afterAll(async () => {
    await mock?.close();
  });
  test.beforeEach(() => {
    mock.terminalInputs.length = 0;
  });

  test("is visible on a mobile viewport and hidden on desktop", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    await expect(page.locator(BAR)).toBeVisible();
    await expect(page.locator(INPUT)).toBeVisible();

    // Desktop viewport hides the bar via the mobile.css media query while
    // the element stays in the DOM (same pattern as .mobile-keyboard-btn).
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await expect(page.locator(BAR)).toBeHidden();

    assertNoErrors(page);
  });

  test("sends the composed line, then Enter as a separate frame", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    const input = page.locator(INPUT);
    await input.fill("echo from-mobile-composer");
    await page.locator(".mobile-input-bar__send").click();

    // Text first, Enter as its own delayed frame — a \r in the same chunk as
    // the text would be swallowed by agent TUIs' paste detection (same
    // pattern as #writeAndSubmit in agent-task-runner.ts).
    await expect
      .poll(() => mock.terminalInputs, { timeout: 5_000 })
      .toEqual([
        { sessionId: ACTIVE_SESSION_ID, data: "echo from-mobile-composer" },
        { sessionId: ACTIVE_SESSION_ID, data: "\r" },
      ]);
    // The field clears after sending so the next command starts fresh.
    await expect(input).toHaveValue("");

    assertNoErrors(page);
  });

  test("submits via the Enter key (mobile keyboards' send action)", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    const input = page.locator(INPUT);
    await input.fill("ls -la");
    await input.press("Enter");

    await expect
      .poll(() => mock.terminalInputs, { timeout: 5_000 })
      .toEqual([
        { sessionId: ACTIVE_SESSION_ID, data: "ls -la" },
        { sessionId: ACTIVE_SESSION_ID, data: "\r" },
      ]);

    assertNoErrors(page);
  });

  test("does not carry a pending draft to another terminal tab", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    const input = page.locator(INPUT);
    await input.fill("do not forward");
    await page.locator(".mobile-tab-picker__trigger").click();
    await page.locator(".mobile-tab-picker__item", { hasText: "Claude Code" }).click();

    await expect(input).toHaveValue("");
    await input.fill("pwd");
    await page.locator(".mobile-input-bar__send").click();

    await expect
      .poll(() => mock.terminalInputs, { timeout: 5_000 })
      .toContainEqual({ sessionId: "ws-frontend:panel-claude", data: "pwd" });
    expect(mock.terminalInputs).not.toContainEqual({
      sessionId: "ws-frontend:panel-claude",
      data: "do not forward",
    });

    assertNoErrors(page);
  });

  test("empty submit sends a bare Enter for confirming TUI prompts", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    await page.locator(".mobile-input-bar__send").click();

    await expect
      .poll(() => mock.terminalInputs, { timeout: 5_000 })
      .toContainEqual({ sessionId: ACTIVE_SESSION_ID, data: "\r" });

    assertNoErrors(page);
  });

  test("accessory keys send raw control sequences", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    await page.locator(".mobile-input-bar__key", { hasText: "Esc" }).first().click();
    await page.locator(".mobile-input-bar__key", { hasText: "^C" }).click();
    await page.locator(".mobile-input-bar__key", { hasText: /^↑$/ }).click();

    await expect
      .poll(() => mock.terminalInputs, { timeout: 5_000 })
      .toEqual([
        { sessionId: ACTIVE_SESSION_ID, data: "\x1b" },
        { sessionId: ACTIVE_SESSION_ID, data: "\x03" },
        { sessionId: ACTIVE_SESSION_ID, data: "\x1b[A" },
      ]);

    assertNoErrors(page);
  });

  test("paste button inserts clipboard text into the composer without sending", async ({ page, context }) => {
    // localhost is a secure context, so the async Clipboard API is available
    // once the permission is granted on the browser context.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    await page.evaluate(() => navigator.clipboard.writeText("echo from-clipboard"));
    await page.locator(".mobile-input-bar__key--paste").click();

    await expect(page.locator(INPUT)).toHaveValue("echo from-clipboard");
    // Nothing reaches the terminal until the user hits send.
    expect(mock.terminalInputs).toEqual([]);

    assertNoErrors(page);
  });

  test("flushes a pending draft before an accessory key", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    await page.locator(INPUT).fill("git che");
    await page.locator(".mobile-input-bar__key", { hasText: /^Tab$/ }).click();

    await expect
      .poll(() => mock.terminalInputs, { timeout: 5_000 })
      .toContainEqual({ sessionId: ACTIVE_SESSION_ID, data: "git che\t" });
    await expect(page.locator(INPUT)).toHaveValue("");

    assertNoErrors(page);
  });

  test("collapses to a slim handle and expands back", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    await page.locator(".mobile-input-bar__key--collapse").click();
    await expect(page.locator(INPUT)).toBeHidden();
    await expect(page.locator(".mobile-input-bar__expand")).toBeVisible();

    await page.locator(".mobile-input-bar__expand").click();
    await expect(page.locator(INPUT)).toBeVisible();
    // Expanding focuses the composer so the on-screen keyboard opens.
    await expect(page.locator(INPUT)).toBeFocused();

    assertNoErrors(page);
  });

  test("keeps the terminal usable: xterm still renders mock output above the bar", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);

    await expect(page.locator(".terminal-host .xterm-rows")).toContainText("shell-ready");

    // The bar must sit below the terminal host, not overlap it.
    const hostBottom = await page.locator(".terminal-host").evaluate((el) => el.getBoundingClientRect().bottom);
    const barTop = await page.locator(BAR).evaluate((el) => el.getBoundingClientRect().top);
    expect(hostBottom).toBeLessThanOrEqual(barTop + 1);

    assertNoErrors(page);
  });
});

// ---------------------------------------------------------------------------
// Visual regression — mobile composer bar @visual
// ---------------------------------------------------------------------------
test.describe("Visual regression — mobile input bar @visual", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({
      fixture: "multi-workspace",
      terminalOutput: {
        "ws-frontend:panel-shell": "\r\n$ echo shell-ready\r\nshell-ready\r\n",
      },
    });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test("mobile workspace with composer bar", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);
    await expect(page.locator(INPUT)).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("mobile-input-bar.png");
  });

  test("mobile workspace with composer bar collapsed", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openApp(page, mock);
    await page.locator(".mobile-input-bar__key--collapse").click();
    await expect(page.locator(".mobile-input-bar__expand")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("mobile-input-bar-collapsed.png");
  });
});
