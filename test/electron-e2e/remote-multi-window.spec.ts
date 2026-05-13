/**
 * Remote multi-window E2E tests.
 *
 * Verifies the core invariants of per-remote-client identity:
 *  - A remote browser client has its own active profile / workspace, independent
 *    of desktop window slots.
 *  - Switching profiles via the remote API does not evict or affect desktop windows.
 *  - Desktop window slots are the source of "badge" data (profile already open on
 *    desktop Window N) — the remote client sees this via the composed payload.
 *  - Closing a desktop window removes it from windowSlots; the remote client's
 *    own identity is unaffected.
 *  - Desktop profile exclusivity is enforced against other desktop windows only;
 *    a remote client occupying a profile does not count as a window slot.
 *
 * The test uses the "remote-multi-profile" fixture (remote access enabled on
 * port 48891 with a fixed token) and makes HTTP requests directly to the remote
 * server using Node's http module and global fetch — no browser tab required.
 */
import { test, expect, type Page } from "@playwright/test";
import http from "node:http";
import {
  launchApp,
  closeApp,
  assertNoRendererErrors,
  captureEndState,
  captureStep,
  type LaunchedApp,
} from "./helpers.js";

const REMOTE_PORT = 48891;
const REMOTE_AUTH = "e2e-remote-test-token";
const SESSION_COOKIE = "strideterm_session";

async function waitReady(page: Page): Promise<void> {
  await page.waitForSelector("h1.brand, .bootstrap-error", { timeout: 20_000 }).catch(() => undefined);
}

/**
 * Poll until the remote HTTP server is accepting connections.
 * Returns as soon as the server responds with any HTTP status.
 */
async function waitForRemoteServer(port: number, maxWaitMs = 15_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        resolve(true);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Remote server on port ${port} did not become ready within ${maxWaitMs}ms`);
}

/**
 * Bootstrap a remote browser session by hitting the token-redirect endpoint.
 * Returns the full `Cookie: strideterm_session=…` header value ready for use
 * in subsequent requests.
 */
function bootstrapRemoteSession(port: number, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, (res) => {
      const setCookies = res.headers["set-cookie"] ?? [];
      const sessionEntry = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      if (!sessionEntry) {
        reject(
          new Error(
            `No session cookie in response (status ${res.statusCode}). Set-Cookie: ${JSON.stringify(setCookies)}`,
          ),
        );
      } else {
        const value = sessionEntry.split(";")[0]; // strip cookie attributes
        resolve(value); // "strideterm_session=<id>"
      }
      res.resume();
    });
    req.on("error", reject);
  });
}

async function remotePost(port: number, cookie: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function remoteGetState(port: number, cookie: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { Cookie: cookie },
  });
  return res.json();
}

test.describe("Remote — per-client profile identity with two desktop windows", () => {
  let launched: LaunchedApp | undefined;
  let secondPage: Page | undefined;
  let remoteCookie = "";

  test.beforeAll(async () => {
    launched = await launchApp("remote-multi-profile");
    await waitReady(launched.page);

    // Wait for the remote HTTP server to accept connections.
    await waitForRemoteServer(REMOTE_PORT);

    // Open second window with profile-work (mirrors multi-window.spec.ts pattern).
    const secondPagePromise = launched.app.waitForEvent("window", { timeout: 15_000 });
    await launched.page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).strideterm?.createWindow?.("profile-work");
    });
    secondPage = await secondPagePromise;
    await waitReady(secondPage);

    // Bootstrap a remote browser session via the token-redirect flow.
    remoteCookie = await bootstrapRemoteSession(REMOTE_PORT, REMOTE_AUTH);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("remote client activates profile-personal — windowSlots stay unchanged", async () => {
    await remotePost(REMOTE_PORT, remoteCookie, "/api/remote-client/profile/activate", {
      profileId: "profile-personal",
    });

    const payload = await remoteGetState(REMOTE_PORT, remoteCookie);

    // Remote client sees profile-personal as its own active profile.
    expect(payload.remoteClient?.profileId).toBe("profile-personal");

    // Both desktop windows are still reflected in windowSlots.
    const slots: { profileId: string }[] = payload.appState?.windowSlots ?? [];
    expect(slots.some((s) => s.profileId === "profile-personal")).toBe(true);
    expect(slots.some((s) => s.profileId === "profile-work")).toBe(true);

    await captureStep(launched!, "remote-activates-personal");
    assertNoRendererErrors(launched!);
  });

  test("remote switching to a desktop-occupied profile does not evict that window", async () => {
    // profile-work is in W2 on the desktop; remote also switches to it.
    await remotePost(REMOTE_PORT, remoteCookie, "/api/remote-client/profile/activate", {
      profileId: "profile-work",
    });

    const payload = await remoteGetState(REMOTE_PORT, remoteCookie);

    // Remote now has profile-work.
    expect(payload.remoteClient?.profileId).toBe("profile-work");

    // W2 must still show Work Project — not evicted by the remote activation.
    await expect(secondPage!.getByText("Work Project", { exact: true }).first()).toBeVisible({ timeout: 5_000 });

    // The composed payload's windowSlots still contain profile-work (W2 is alive).
    // Frontend uses this to render the "Open on desktop Window N" badge.
    const slots: { profileId: string }[] = payload.appState?.windowSlots ?? [];
    expect(slots.some((s) => s.profileId === "profile-work")).toBe(true);

    await captureStep(launched!, "remote-same-as-desktop-w2");
    assertNoRendererErrors(launched!);
  });

  test("closing desktop W2 removes profile-work from windowSlots; remote identity stays", async () => {
    // Remote is still on profile-work (from previous test). Close W2.
    await secondPage!.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).strideterm?.closeWindow?.();
    });

    // Give the runtime time to remove the window slot.
    await launched!.page.waitForTimeout(500);

    const payload = await remoteGetState(REMOTE_PORT, remoteCookie);

    // Remote's own identity is preserved: the registry only falls back when
    // the profile is deleted entirely, not just when its desktop window closes.
    expect(payload.remoteClient?.profileId).toBe("profile-work");

    // windowSlots no longer contains profile-work — badge data is gone.
    const slots: { profileId: string }[] = payload.appState?.windowSlots ?? [];
    expect(slots.some((s) => s.profileId === "profile-work")).toBe(false);

    await captureStep(launched!, "w2-closed-badge-gone");
    assertNoRendererErrors(launched!);
  });
});

test.describe("Remote — desktop profile exclusivity is unaffected by remote client", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("remote-multi-profile");
    await waitReady(launched.page);
    await waitForRemoteServer(REMOTE_PORT);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object-destructure even when unused
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("desktop refuses a duplicate window even when remote also has that profile", async () => {
    const { page } = launched!;

    // Open W2 with profile-work.
    const secondPagePromise = launched!.app.waitForEvent("window", { timeout: 15_000 });
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).strideterm?.createWindow?.("profile-work");
    });
    const secondPage = await secondPagePromise;
    await waitReady(secondPage);

    // Establish a remote session and also activate profile-work.
    // This must NOT affect the desktop exclusivity guard.
    const cookie = await bootstrapRemoteSession(REMOTE_PORT, REMOTE_AUTH);
    await remotePost(REMOTE_PORT, cookie, "/api/remote-client/profile/activate", { profileId: "profile-work" });

    // Attempt to create a THIRD window for profile-work (already in W2 on desktop).
    const result = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (window as any).strideterm?.createWindow?.("profile-work");

      return res as { error?: string; windowId?: string };
    });

    await captureStep(launched!, "exclusivity-refused");

    // The call must be refused — profile-work is already in W2.
    expect(result?.error).toMatch(/already open/i);

    // Confirm no third window was created.
    const windowCount = await launched!.app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
    );
    expect(windowCount).toBe(2);

    assertNoRendererErrors(launched!);
  });
});
