import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchApp, closeApp, settleForScreenshot, type LaunchedApp } from "./helpers.js";

/**
 * Visual regression tests — opt-in via the `@visual` tag.
 *
 * Each spec captures a full-page screenshot and compares against a
 * baseline stored in test/electron-e2e/__screenshots__/. Pass-threshold
 * is generous (10 % of pixels may differ) — the goal is to catch
 * catastrophic regressions (blank page, unmounted Vue tree, broken CSS,
 * errored dialog) NOT pixel-perfect rendering.
 *
 * Baselines are platform-specific: Playwright suffixes them with
 * `-darwin`/`-linux`/`-win32`. Generate locally with:
 *
 *     npm run test:e2e:electron:update
 *
 * The CI workflow excludes @visual to avoid flaky cross-OS pixel diffs.
 */

test.describe("Visual snapshots @visual", () => {
  let empty: LaunchedApp | undefined;
  let seeded: LaunchedApp | undefined;

  test.beforeAll(async () => {
    empty = await launchApp("empty");
    seeded = await launchApp("seeded");
  });

  test.afterAll(async () => {
    await closeApp(empty);
    await closeApp(seeded);
  });

  test("empty: welcome screen", async () => {
    const { page } = empty!;
    await page.getByText("Welcome to", { exact: false }).waitFor();
    await settleForScreenshot(page);
    await expect(page).toHaveScreenshot("empty-welcome.png");
  });

  test("empty: settings dialog (General tab)", async () => {
    const { page } = empty!;
    await page.locator("button.sidebar__icon-btn[title^='Open the Settings dialog']").click();
    await expect(page.locator(".overlay h2")).toHaveText("Settings");
    await settleForScreenshot(page);
    await expect(page).toHaveScreenshot("empty-settings-general.png");
    await page.locator(".overlay").getByRole("button", { name: "Cancel" }).first().click();
  });

  test("empty: help dialog", async () => {
    const { page } = empty!;
    await page.locator("button.sidebar__icon-btn[title^='Open the Help dialog']").click();
    await page.getByText("Getting Started").waitFor();
    await settleForScreenshot(page);
    await expect(page).toHaveScreenshot("empty-help.png");
    await page.locator(".overlay").getByRole("button", { name: "Close" }).first().click();
  });

  test("empty: new workspace template picker", async () => {
    const { page } = empty!;
    await page.locator("button.sidebar__icon-btn[title^='Open the New Workspace picker']").click();
    await page.getByText("Empty Workspace").waitFor();
    await settleForScreenshot(page);
    await expect(page).toHaveScreenshot("empty-new-workspace.png");
    await page.locator(".overlay").getByRole("button", { name: "Close" }).first().click();
  });

  test("seeded: sidebar with three workspaces", async () => {
    const { page } = seeded!;
    await page.getByText("Frontend App").waitFor();
    await settleForScreenshot(page);
    await expect(page).toHaveScreenshot("seeded-sidebar.png");
  });
});

/**
 * Git Stashes tab visual snapshot (plan §9.5).
 *
 * Seeds a *real* throwaway git repo with three stashes, points a terminal
 * workspace at it, and boots straight into the Git pane (activeViewId =
 * `git:ws-stash`). The backend runs real git against the repo — the snapshot,
 * stash list, file lists, and Monaco diff all flow through the production
 * IPC path, so this exercises the whole feature end-to-end, not a mock.
 *
 * Stash commit dates are pinned relative to seed-time `now` (4h / 2d / 5d
 * ago), so the relative-age chips render the same short labels on every run
 * even though the baseline PNG is static — the repo is re-seeded each run.
 */
test.describe("Visual snapshots — git stashes @visual", () => {
  let app: LaunchedApp | undefined;
  let repoDir: string | undefined;

  test.beforeAll(async () => {
    repoDir = await seedStashRepo();
    app = await launchApp("git-stashes", {
      patchState: (state) => {
        const workspaces = (state.workspaces as Array<{ id: string; cwd: string }>) || [];
        const ws = workspaces.find((w) => w.id === "ws-stash");
        if (ws) ws.cwd = repoDir!;
      },
    });
  });

  test.afterAll(async () => {
    await closeApp(app);
    if (repoDir) await rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("stashes tab: list + expanded entry + file diff", async () => {
    const { page } = app!;

    // The Git tab is added to the tab strip only after the async startup
    // snapshot refresh detects the repo — wait for it, then open the Git
    // pane and switch to the Stashes sub-tab.
    const gitTab = page.locator('.tab[data-view-id="git:ws-stash"]');
    await gitTab.waitFor({ timeout: 30_000 });
    await gitTab.click();
    await page.locator(".git-tabs__item", { hasText: "Stashes" }).waitFor({ timeout: 15_000 });
    await page.locator(".git-tabs__item", { hasText: "Stashes" }).click();

    // All three stashes render in the list.
    await expect(page.locator(".stash-item")).toHaveCount(3, { timeout: 15_000 });

    // Select + expand the middle entry (stash@{1}), then load a file diff in
    // the detail pane so Monaco mounts with real content.
    const middle = page.locator(".stash-item").nth(1);
    await middle.locator(".stash-item__row").click();
    await middle.locator(".stash-item__chevron").click();

    const firstFile = page.locator(".stash-detail__file").first();
    await firstFile.waitFor({ timeout: 15_000 });
    await firstFile.click();
    // Wait for Monaco's rendered diff text (the gutter .monaco-editor stays
    // hidden, so target the visible code lines instead).
    await page.locator(".stash-detail .mdp .view-lines").first().waitFor({ timeout: 20_000 });

    await settleForScreenshot(page, 500);
    await expect(page).toHaveScreenshot("git-stashes-tab.png");
  });
});

/**
 * Create a temp git repo with three stashes. Returns the repo path.
 * Dates are offset from the current clock so age chips stay stable.
 */
async function seedStashRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "strideterm-stash-repo-"));
  const nowSec = Math.floor(Date.now() / 1000);
  const at = (secAgo: number) => `@${nowSec - secAgo} +0000`;
  const git = (args: string[], dateSec?: number) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "pipe",
      env:
        dateSec === undefined
          ? process.env
          : { ...process.env, GIT_AUTHOR_DATE: at(dateSec), GIT_COMMITTER_DATE: at(dateSec) },
    });
  const write = (name: string, body: string) => writeFile(path.join(dir, name), body, "utf8");

  git(["init", "-b", "master"]);
  git(["config", "user.email", "e2e@example.com"]);
  git(["config", "user.name", "E2E Bot"]);
  git(["config", "commit.gpgsign", "false"]);

  await write("alpha.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  await write("beta.ts", "export function beta() {\n  return 0;\n}\n");
  await write("gamma.ts", "export const gamma = [];\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"], 6 * 86400);

  // Stash #1 (ends up at stash@{2}, ~5d ago): single-file change.
  await write("alpha.ts", "export const a = 11;\nexport const b = 2;\nexport const c = 3;\n");
  git(["stash", "push", "-m", "experiment with widget layout"], 5 * 86400);

  // Stash #2 (ends up at stash@{1}, ~2d ago, the expanded one): two files.
  await write("beta.ts", "export function beta() {\n  return 42;\n}\n");
  await write("gamma.ts", "export const gamma = [1, 2, 3];\n");
  git(["stash", "push", "-m", "WIP fix flaky watcher test"], 2 * 86400);

  // Stash #3 (ends up at stash@{0}, ~4h ago): single-file change.
  await write("alpha.ts", "export const a = 1;\nexport const b = 22;\nexport const c = 3;\n");
  git(["stash", "push", "-m", "tidy imports and dead code"], 4 * 3600);

  return dir;
}
