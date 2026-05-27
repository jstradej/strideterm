import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export type FixtureName =
  | "empty"
  | "seeded"
  | "grid"
  | "multi-profile"
  | "two-workspaces"
  | "remote-multi-profile"
  | "docker-workspace"
  | "docker-mock-workspace";

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  errors: string[];
}

export interface LaunchOptions {
  /**
   * Override the Electron BrowserWindow size. The default (1100×720) keeps
   * deterministic screenshots across the OS matrix. Pass a smaller size
   * to drive the renderer into its narrow / mobile layout — the helper
   * also lowers the min-size envs so Electron actually honours the
   * requested width/height instead of clamping to the desktop floor.
   */
  windowSize?: { width: number; height: number };
  /**
   * Path to a Docker mock-state JSON file. When set, the backend's
   * DockerManager.refresh() short-circuits to this file instead of probing
   * the docker CLI — lets CI runners without docker exercise the Docker UI
   * deterministically. The file shape mirrors `DockerState` (see
   * `fixtures/docker-mock-state.json` for the canonical example).
   */
  dockerMockFile?: string;
}

export async function launchApp(fixture: FixtureName = "empty", options: LaunchOptions = {}): Promise<LaunchedApp> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "strideterm-e2e-"));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dataDir is mkdtemp output
  await mkdir(dataDir, { recursive: true });
  await copyFile(path.join(__dirname, "fixtures", `${fixture}.json`), path.join(dataDir, "strideterm-state.json"));

  const width = options.windowSize?.width ?? 1100;
  const height = options.windowSize?.height ?? 720;
  // Filter out the optional values from process.env so the resulting type
  // satisfies Playwright's Record<string, string> contract — Electron's
  // launch options reject `undefined` entries.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.STRIDETERM_FORCE_DIST = "1";
  env.STRIDETERM_SHELL_INTEGRATION = "0";
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1";
  // Playwright's app.close() can't respond to the renderer-side close-confirm
  // dialog — bypass it so test teardown doesn't hang on workspaces / running tasks.
  env.STRIDETERM_E2E_SKIP_CLOSE_CONFIRM = "1";
  // Pin window size for deterministic screenshots across the OS matrix.
  // Default (1560×940) is wider than some CI virtual displays — the
  // window then collapses to minWindowWidth and the sidebar ends up
  // looking enormous. 1280×800 fits comfortably on every runner.
  env.STRIDETERM_WINDOW_WIDTH = String(width);
  env.STRIDETERM_WINDOW_HEIGHT = String(height);
  // When the caller asks for a size below the production min-window floor
  // (1100×720), drop the floor too — otherwise Electron silently clamps
  // and the renderer never sees the narrow layout we wanted to test.
  if (options.windowSize) {
    env.STRIDETERM_MIN_WINDOW_WIDTH = String(width);
    env.STRIDETERM_MIN_WINDOW_HEIGHT = String(height);
  }
  if (options.dockerMockFile) {
    env.STRIDETERM_DOCKER_MOCK_FILE = options.dockerMockFile;
  }

  const app = await electron.launch({
    // Pass the repo root (where package.json lives) — Electron reads the
    // "main" field there. Pointing directly at main.js makes
    // `app.getAppPath()` resolve to dist-electron/electron, which then
    // breaks the preload path (it gets joined onto itself).
    args: [REPO_ROOT, `--data-dir=${dataDir}`],
    env,
    timeout: 60_000,
  });

  const page = await app.firstWindow({ timeout: 30_000 });
  const errors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`console.error: ${msg.text()}`);
    }
    console.log(`[renderer:${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
    console.log(`[renderer:pageerror] ${err.message}`);
  });

  await page.waitForLoadState("load");
  await page.waitForSelector("h1, h2", { timeout: 30_000 }).catch(() => undefined);
  return { app, page, dataDir, errors };
}

/**
 * Re-launch the app against an existing data directory (for restart-restore tests).
 * The caller is responsible for closing the previous app instance first.
 */
export async function relaunchApp(dataDir: string, options: LaunchOptions = {}): Promise<LaunchedApp> {
  const width = options.windowSize?.width ?? 1100;
  const height = options.windowSize?.height ?? 720;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.STRIDETERM_FORCE_DIST = "1";
  env.STRIDETERM_SHELL_INTEGRATION = "0";
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1";
  // Playwright's app.close() can't respond to the renderer-side close-confirm
  // dialog — bypass it so test teardown doesn't hang on workspaces / running tasks.
  env.STRIDETERM_E2E_SKIP_CLOSE_CONFIRM = "1";
  env.STRIDETERM_WINDOW_WIDTH = String(width);
  env.STRIDETERM_WINDOW_HEIGHT = String(height);
  if (options.windowSize) {
    env.STRIDETERM_MIN_WINDOW_WIDTH = String(width);
    env.STRIDETERM_MIN_WINDOW_HEIGHT = String(height);
  }

  const app = await electron.launch({
    args: [REPO_ROOT, `--data-dir=${dataDir}`],
    env,
    timeout: 60_000,
  });

  const page = await app.firstWindow({ timeout: 30_000 });
  const errors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    console.log(`[renderer:${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
    console.log(`[renderer:pageerror] ${err.message}`);
  });

  await page.waitForLoadState("load");
  await page.waitForSelector("h1, h2", { timeout: 30_000 }).catch(() => undefined);
  return { app, page, dataDir, errors };
}

export async function closeApp(launched: LaunchedApp | undefined): Promise<void> {
  if (!launched) return;
  try {
    await launched.app.close();
  } catch {
    // Electron occasionally exits before close() resolves on Windows.
  }
}

/**
 * Drains and asserts on renderer errors collected since the last call.
 *
 * Call at the end of each test; the array is cleared so the next test
 * starts with a clean slate even when the Electron app is shared via
 * beforeAll.
 */
export function assertNoRendererErrors(launched: LaunchedApp): void {
  const drained = launched.errors.splice(0);
  expect(drained, `Renderer raised errors: ${drained.join(" | ")}`).toEqual([]);
}

/**
 * Helper for visual snapshots — gives the renderer a moment to settle
 * (animations, layout shift) before taking the picture. Without this,
 * pixel diffs flake on transitions.
 */
export async function settleForScreenshot(page: Page, ms = 250): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(ms);
}

/**
 * Captures the renderer at the end of a test and attaches the PNG to the
 * Playwright HTML report. Playwright's `screenshot: "on"` setting drops
 * shots when a Page is reused across tests via beforeAll, so we take
 * them ourselves in afterEach.
 *
 * @param launched the LaunchedApp returned from launchApp()
 * @param testInfo the TestInfo handed in by Playwright's afterEach
 */
export async function captureEndState(
  launched: LaunchedApp | undefined,
  testInfo: import("@playwright/test").TestInfo,
): Promise<void> {
  if (!launched || launched.page.isClosed()) return;
  try {
    const buffer = await launched.page.screenshot({ fullPage: false });
    await testInfo.attach("end-state", { body: buffer, contentType: "image/png" });
  } catch {
    // Window may have been torn down mid-teardown — non-fatal for the test.
  }
}

/**
 * Snap a screenshot mid-test and attach it to the report under `label`.
 * Use after each meaningful interaction so the report ends up with a
 * picture of every screen the suite visits — not just the final state
 * (which often dedupes back to "welcome screen" once dialogs close).
 */
export async function captureStep(launched: LaunchedApp, label: string): Promise<void> {
  if (launched.page.isClosed()) return;
  try {
    const buffer = await launched.page.screenshot({ fullPage: false });
    await test.info().attach(label, { body: buffer, contentType: "image/png" });
  } catch {
    // Best-effort — never fail a test because a debugging screenshot didn't take.
  }
}
