import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  assertNoRendererErrors,
  captureEndState,
  captureStep,
  type LaunchedApp,
} from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_FILE = path.join(__dirname, "fixtures", "docker-mock-state.json");

/**
 * Docker workspace tests against the mocked DockerState fixture.
 *
 * Most strideterm CI runners don't have docker installed, so the existing
 * `docker-workspace.spec.ts` only verifies the pane survives both
 * available/unavailable paths. These tests opt into the
 * `STRIDETERM_DOCKER_MOCK_FILE` hook on the backend so we always see the
 * "available" branch with deterministic containers, images, volumes, and
 * networks — and can exercise tree expansion, container selection, and
 * resource list switching.
 *
 * Coverage is intentionally shallow: tree renders, selecting nodes opens the
 * matching detail tab, header summary reflects the mock counts. Going deeper
 * (live logs, exec shell, stats) needs a richer mock that the streamer
 * binaries can talk to; that's out of scope for the smoke layer.
 */
test.describe("Docker workspace (mocked state)", () => {
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    launched = await launchApp("docker-mock-workspace", { dockerMockFile: MOCK_FILE });
  });

  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await captureEndState(launched, testInfo);
  });

  test.afterAll(async () => {
    await closeApp(launched);
  });

  test("renders the splitpanes layout with the mocked tree roots", async () => {
    const { page } = launched!;
    const paneBody = page.locator(".workspace-pane__body--docker");
    await expect(paneBody).toBeVisible({ timeout: 15_000 });

    // Mock backend → docker is "available" → splitpanes must render.
    const splitpanes = page.locator(".docker-splitpanes");
    await expect(splitpanes).toBeVisible({ timeout: 15_000 });

    const tree = page.locator(".docker-tree");
    await expect(tree).toBeVisible();

    // Top-level nodes (single backend + single context collapse up): the
    // compose project plus the Images/Volumes/Networks groups. We assert
    // their labels are present without forcing expand state.
    await expect(page.getByRole("treeitem").filter({ hasText: "mock-app" }).first()).toBeVisible();
    await expect(
      page
        .getByRole("treeitem")
        .filter({ hasText: /Images \(3\)/ })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByRole("treeitem")
        .filter({ hasText: /Volumes \(1\)/ })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByRole("treeitem")
        .filter({ hasText: /Networks \(2\)/ })
        .first(),
    ).toBeVisible();

    await captureStep(launched!, "docker-mock-tree-roots");
    assertNoRendererErrors(launched!);
  });

  test("expanding the compose project surfaces the mocked containers", async () => {
    const { page } = launched!;

    // Click the project row — for project nodes the row click toggles expand
    // AND selects the project. After expansion the three service containers
    // (web/api/db) appear as descendants.
    const projectRow = page.getByRole("treeitem").filter({ hasText: "mock-app" }).first();
    await projectRow.waitFor({ state: "visible", timeout: 10_000 });
    await projectRow.click();

    await expect(page.getByRole("treeitem").filter({ hasText: /^web$/ }).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("treeitem").filter({ hasText: /^api$/ }).first()).toBeVisible();
    await expect(page.getByRole("treeitem").filter({ hasText: /^db$/ }).first()).toBeVisible();

    await captureStep(launched!, "docker-mock-project-expanded");
    assertNoRendererErrors(launched!);
  });

  test("clicking a container opens its detail tab", async () => {
    const { page } = launched!;

    const webRow = page.getByRole("treeitem").filter({ hasText: /^web$/ }).first();
    await webRow.waitFor({ state: "visible", timeout: 10_000 });
    await webRow.click();

    // Detail panel must now render the container view (not the empty
    // placeholder).
    const detail = page.locator(".docker-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator(".docker-detail__empty")).toHaveCount(0);

    await captureStep(launched!, "docker-mock-container-selected");
    assertNoRendererErrors(launched!);
  });

  test("docker header renders with the title label", async () => {
    const { page } = launched!;
    // DockerHeader hosts the title + disk-usage chips; even when df is empty
    // the header itself must render. We assert the title cell so we don't
    // flake on the loading-vs-loaded df text.
    const header = page.locator(".docker-header");
    await expect(header).toBeVisible({ timeout: 15_000 });
    await expect(header.locator(".docker-header__label")).toHaveText("Docker");
    assertNoRendererErrors(launched!);
  });
});
