import { expect, test } from "@playwright/test";
import { startMockServer } from "../mock-server.js";
import { assertNoErrors, openApp } from "./helpers.js";

test.describe("Automation dialog responsive layout", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({ fixture: "activity-forest" });
  });
  test.afterAll(async () => {
    await mock.close();
  });
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 667, height: 375 },
  ]) {
    test(`dialog fits at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await openApp(page, mock);
      if (viewport.width < 768) await page.locator(".mobile-hamburger").click();
      const card = page.locator('[data-workspace-id="ws-repo"]').last();
      const menu = card.locator(".workspace-card__action--menu");
      await card.scrollIntoViewIfNeeded();
      await expect(menu).toBeInViewport();
      if (viewport.width >= 768) await card.hover();
      await expect(menu).toHaveCSS("opacity", "1");
      await menu.click();
      await page.getByRole("button", { name: /Create automation/i }).click();
      const dialog = page.locator(".automation-dialog");
      await expect(dialog.getByRole("heading", { name: "Create automation" })).toBeVisible();
      await expect(dialog.getByText("The application must be running", { exact: false })).toBeVisible();
      await dialog.getByRole("button", { name: "Missed runs help", exact: true }).focus();
      const scheduleHelp = page.locator('[role="tooltip"][data-open="true"]');
      await expect(scheduleHelp).toContainText("even if several slots were missed");
      const scheduleHelpBounds = await scheduleHelp.boundingBox();
      expect(scheduleHelpBounds!.x).toBeGreaterThanOrEqual(0);
      expect(scheduleHelpBounds!.x + scheduleHelpBounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(scheduleHelpBounds!.y).toBeGreaterThanOrEqual(0);
      expect(scheduleHelpBounds!.y + scheduleHelpBounds!.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({ path: testInfo.outputPath("missed-runs-help.png") });
      await page.keyboard.press("Escape");
      await expect(scheduleHelp).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("schedule-dialog.png") });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "light";
      });
      await page.screenshot({ path: testInfo.outputPath("schedule-dialog-light.png") });
      const body = dialog.locator(".automation-form__body");
      await dialog.getByLabel("Prompt", { exact: true }).fill("Check the repository and summarize the result.");
      await dialog.getByTestId("sandbox-checkbox").check();
      await expect(dialog.getByTestId("sandbox-not-protected")).toBeHidden();
      await dialog.locator(".sandbox-section__summary").click();
      await expect(dialog.getByTestId("sandbox-not-protected")).toBeVisible();
      await dialog.locator(".sandbox-section__summary").click();
      const checkboxStyles = await dialog.locator('input[type="checkbox"]').evaluateAll((elements) =>
        elements.map((element) => ({
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          fontSize: getComputedStyle(element.closest("label")!).fontSize,
        })),
      );
      expect(new Set(checkboxStyles.map((style) => JSON.stringify(style))).size).toBe(1);
      for (const style of checkboxStyles) {
        expect(style.width).toBeLessThanOrEqual(16);
        expect(style.height).toBeLessThanOrEqual(16);
        expect(Number.parseFloat(style.fontSize)).toBeLessThanOrEqual(14);
      }
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("automation-options-light.png") });
      await dialog.getByLabel("Checkout", { exact: true }).selectOption("worktree");
      await dialog.getByLabel("New branch").fill("automation/nightly");
      await dialog
        .locator("select")
        .filter({ has: page.locator('option[value="event"]') })
        .selectOption("event");
      await dialog.getByRole("button", { name: "Event data and prompt help" }).click();
      const help = page.locator('[role="tooltip"][data-open="true"]');
      await expect(help).toContainText("no placeholder substitution");
      await expect(help).toContainText("pullRequestNumber");
      await expect(help).toContainText("JSON array");
      const helpBounds = await help.boundingBox();
      expect(helpBounds!.x).toBeGreaterThanOrEqual(0);
      expect(helpBounds!.x + helpBounds!.width).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: testInfo.outputPath("event-prompt-help.png") });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      const eventContext = dialog.getByRole("region", { name: "Event data example" });
      const eventJson = eventContext.getByLabel("Example EVENT.json");
      await expect(eventJson).toContainText('"pullRequestNumber": 42');
      await expect(eventJson).toContainText('"title": "Fix login redirect"');
      await expect(eventContext.getByRole("button", { name: "Insert event instructions" })).toBeVisible();
      await eventContext.scrollIntoViewIfNeeded();
      const eventSize = await eventContext.evaluate((element) => ({
        scroll: element.scrollWidth,
        client: element.clientWidth,
        right: element.getBoundingClientRect().right,
      }));
      expect(eventSize.scroll).toBeLessThanOrEqual(eventSize.client + 1);
      expect(eventSize.right).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: testInfo.outputPath("prompt-event-data-example.png") });
      await dialog.getByRole("checkbox", { name: "Check finished", exact: true }).check();
      await eventContext.getByLabel("Example event", { exact: true }).selectOption("pr-check-finished");
      await expect(eventJson).toContainText('"result": "succeeded"');
      await dialog.getByRole("checkbox", { name: "Check finished", exact: true }).uncheck();
      await expect(eventJson).not.toContainText('"check":');
      await dialog.getByLabel("Run location", { exact: true }).selectOption("pr-review");
      await expect(dialog.getByText("The agent receives review tools only", { exact: false })).toBeVisible();
      const checkbox = dialog.getByRole("checkbox", { name: "Pull request added", exact: false });
      const checkboxSize = await checkbox.evaluate((element) => element.getBoundingClientRect().width);
      expect(checkboxSize).toBeLessThan(24);
      await checkbox.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: testInfo.outputPath("event-dialog.png") });
      const dimensions = await dialog.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        rect: element.getBoundingClientRect().toJSON(),
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
      expect(dimensions.rect.right).toBeLessThanOrEqual(viewport.width + 1);
      await dialog.getByRole("button", { name: "Cancel" }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("pr-review-dialog.png") });
      await dialog.getByLabel("Run location", { exact: true }).selectOption("automation");
      await dialog.getByLabel("Name", { exact: true }).fill("Worktree retry");
      const requests: Array<{ idempotencyKey: string; checkout: { branch: string } }> = [];
      await page.route("**/api/automation/create", (route) => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({
          json: requests.length === 1 ? { operationId: "worktree-create" } : { workspaceId: "ws-repo" },
        });
      });
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Creating worktree…", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await page.evaluate(async () => {
        const storePath = "/stores/app.ts";
        const app = (await import(storePath)).useAppStore();
        const outcome = {
          operationId: "worktree-create",
          kind: "automation.provision",
          profileId: "default",
          finishedAt: new Date().toISOString(),
          error: { code: "FAILED", message: "Branch automation/nightly already exists. Choose a different branch." },
        };
        app.payload = { ...app.payload, operations: { running: [], lastResults: [outcome] } };
      });
      await expect(dialog.getByRole("alert")).toContainText("Choose a different branch");
      await expect(dialog.getByRole("alert")).toBeInViewport();
      await expect(dialog.getByRole("alert")).toHaveCSS("color", "rgb(183, 40, 76)");
      await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Worktree retry");
      await expect(dialog.getByLabel("Prompt", { exact: true })).toHaveValue(
        "Check the repository and summarize the result.",
      );
      await expect(dialog.getByLabel("New branch")).toHaveValue("automation/nightly");
      await page.screenshot({ path: testInfo.outputPath("worktree-error-retained.png") });
      await dialog.getByLabel("New branch").fill("automation/corrected");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden();
      expect(requests).toHaveLength(2);
      expect(requests[1]!.checkout.branch).toBe("automation/corrected");
      expect(requests[1]!.idempotencyKey).not.toBe(requests[0]!.idempotencyKey);
      assertNoErrors(page);
    });
  }
});

test.describe("Automation dashboard responsive layout", () => {
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  test.beforeAll(async () => {
    mock = await startMockServer({
      fixture: "activity-forest",
      patchState(payload) {
        const parent = payload.appState.workspaces.find((workspace: { id: string }) => workspace.id === "ws-repo");
        const workspace = {
          ...parent,
          id: "auto-view",
          name: "Nightly check",
          kind: "automation",
          sandboxEnabled: true,
          activePanelId: "auto-dash",
          activeViewId: "automation-dashboard:auto-dash",
          panels: [
            { id: "auto-dash", title: "Dashboard", command: "__automation-dashboard__", startup: "none" },
            { id: "auto-agent", title: "Agent", command: "claude", startup: "manual" },
          ],
          automation: {
            parentWorkspaceId: parent.id,
            enabled: true,
            trigger: { type: "schedule", kind: "interval", everyMinutes: 60, anchor: "2026-01-01T00:00:00Z" },
            executor: { type: "agent", agent: { providerId: "claude", model: "", skipPermissions: false } },
            prompt: "Check the repository and summarize the result.\n".repeat(60),
            location: "automation",
            policy: { maxRunMinutes: 60, catchUp: "skip", maxRunsPerHour: 6, subjectCooldownMinutes: 10 },
            createdBy: { kind: "desktop" },
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            enabledAt: "2026-01-01T00:00:00Z",
          },
        };
        payload.appState.workspaces.push(workspace);
        payload.attention = {
          ...payload.attention,
          isolation: { ...payload.attention?.isolation, "auto-view:auto-agent": true },
        };
        payload.appState.workspaces.push({
          ...workspace,
          id: "event-auto",
          name: "Review incoming PRs",
          panels: [{ id: "event-dash", title: "Dashboard", command: "__automation-dashboard__", startup: "none" }],
          automation: { ...workspace.automation, trigger: { type: "event", source: "github", kinds: ["pr-new"] } },
        });
        payload.appState.activeWorkspaceId = workspace.id;
        payload.appState.activeProjectId = workspace.id;
        payload.workspace = {
          workspace,
          project: workspace,
          sessions: [
            {
              sessionId: "auto-view:auto-agent",
              panelId: "auto-agent",
              title: "Agent",
              command: "claude",
              status: "exited",
            },
          ],
        };
        payload.automations = {
          paused: false,
          byWorkspaceId: {
            [workspace.id]: {
              state: "idle",
              nextRunAt: "2026-11-18T07:00:00Z",
              pending: [{ subject: "github:org/repo#42", eventCount: 2 }],
              lastRun: {
                runId: "failed",
                state: "failed",
                startedAt: "2026-11-17T08:00:00Z",
                reason: "terminal-exit",
                exitCode: 17,
                sessionId: "auto-view:auto-agent",
              },
            },
          },
          recentRuns: [],
        };
      },
    });
  });
  test.afterAll(async () => {
    await mock.close();
  });
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 667, height: 375 },
  ]) {
    test(`dashboard fits at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.clock.setFixedTime(new Date("2026-11-17T12:00:00Z"));
      const deletedRuns = new Set<string>();
      await page.route("**/api/automation/delete-runs", (route) => {
        for (const id of route.request().postDataJSON().runIds) deletedRuns.add(id);
        return route.fulfill({ json: { deleted: deletedRuns.size } });
      });
      await page.route("**/api/automation/runs", (route) =>
        route.fulfill({
          json: {
            runs: [
              {
                runId: "failed",
                state: "failed",
                startedAt: "2026-11-17T08:00:00Z",
                reason: "terminal-exit",
                exitCode: 17,
                sessionId: "auto-view:auto-agent",
              },
              {
                runId: "completed",
                state: "succeeded",
                startedAt: "2026-11-17T07:00:00Z",
                resultExcerpt: "Repository checks passed",
              },
              { runId: "skipped", state: "skipped", startedAt: "2026-11-16T07:00:00Z", reason: "automations-paused" },
              { runId: "interrupted", state: "interrupted", startedAt: "2026-11-15T07:00:00Z" },
            ].filter((run) => !deletedRuns.has(run.runId)),
            total: 4 - deletedRuns.size,
          },
        }),
      );
      await page.route("**/api/automation/run-result", (route) =>
        route.fulfill({
          json:
            route.request().postDataJSON().runId === "failed"
              ? {
                  result: null,
                  output: "Error: provider authentication failed.\nSign in to the agent and retry.",
                  exitCode: 17,
                }
              : { result: "All repository checks passed.\nNo changes needed." },
        }),
      );
      await page.setViewportSize(viewport);
      await openApp(page, mock);
      const dashboard = page.getByTestId("automation-dashboard");
      await expect(dashboard.getByRole("heading", { name: "Nightly check" })).toBeVisible();
      await expect(dashboard.getByRole("button", { name: "Run now" })).toBeVisible();
      await expect(
        page.locator('.tab-strip .tab[data-view-id="automation-dashboard:auto-dash"]').first(),
      ).toHaveJSProperty("previousElementSibling", null);
      await expect(dashboard.getByText("github:org/repo#42 · 2")).toBeVisible();
      const promptSize = await dashboard
        .locator(".prompt")
        .evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }));
      expect(promptSize.scroll).toBeGreaterThan(promptSize.client);
      expect(promptSize.client).toBeLessThan(viewport.height / 2);
      await page.screenshot({ path: testInfo.outputPath("dashboard.png") });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "light";
      });
      await page.screenshot({ path: testInfo.outputPath("dashboard-light.png") });
      await expect(dashboard.locator('.run-state[data-state="succeeded"]')).toHaveCSS("color", "rgb(46, 125, 50)");
      await expect(dashboard.locator('.run-state[data-state="failed"]')).toHaveCSS("color", "rgb(183, 40, 76)");
      await expect(dashboard.locator('.run-state[data-state="interrupted"]')).toHaveCSS("color", "rgb(159, 47, 37)");
      const periods = dashboard.getByRole("group", { name: "Run history period" });
      await periods.getByRole("button", { name: "Today", exact: true }).click();
      await expect(dashboard.locator(".runs li")).toHaveCount(2);
      await dashboard.getByLabel("Filter run history by state").selectOption("failed");
      await dashboard.getByLabel("Search run history").fill("exit");
      await expect(dashboard.locator(".runs li")).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath("filtered-run-history-light.png") });
      await dashboard.getByRole("button", { name: "Clear filters", exact: true }).click();
      await periods.getByRole("button", { name: "Yesterday", exact: true }).click();
      await expect(dashboard.locator(".runs li")).toHaveCount(1);
      await expect(dashboard.locator(".runs li")).toContainText(/skipped/i);
      await periods.getByRole("button", { name: "Last 7 days", exact: true }).click();
      await expect(dashboard.locator(".runs li")).toHaveCount(4);
      await dashboard.getByRole("button", { name: "Clear filters", exact: true }).click();
      const originalSummary = await page.evaluate(async () => {
        const storePath = "/stores/app.ts";
        const app = (await import(storePath)).useAppStore();
        const summary = JSON.parse(JSON.stringify(app.payload.automations.byWorkspaceId["auto-view"]));
        const currentRun = {
          runId: "active-status",
          state: "running",
          startedAt: new Date().toISOString(),
          sessionId: "auto-view:auto-agent",
        };
        app.payload = {
          ...app.payload,
          automations: {
            ...app.payload.automations,
            byWorkspaceId: {
              ...app.payload.automations.byWorkspaceId,
              "auto-view": { ...summary, currentRun },
            },
          },
        };
        return summary;
      });
      await expect(dashboard.locator(".status-badge")).toHaveCSS("color", "rgb(194, 106, 10)");
      await expect(dashboard.locator(".status-badge .automation-status__spinner")).toBeVisible();
      await page.evaluate(async () => {
        const storePath = "/stores/app.ts";
        const app = (await import(storePath)).useAppStore();
        const summary = app.payload.automations.byWorkspaceId["auto-view"];
        app.payload = {
          ...app.payload,
          automations: {
            ...app.payload.automations,
            byWorkspaceId: {
              ...app.payload.automations.byWorkspaceId,
              "auto-view": { ...summary, currentRun: { ...summary.currentRun, state: "awaiting-user" } },
            },
          },
        };
      });
      await expect(dashboard.locator(".status-badge")).toHaveCSS("color", "rgb(183, 121, 31)");
      await expect(dashboard.locator(".status-badge .automation-status__spinner")).toHaveCount(0);
      await expect(dashboard.getByText("The agent is waiting for your answer")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("waiting-for-confirmation-light.png") });
      await page.evaluate(async (summary) => {
        const storePath = "/stores/app.ts";
        const app = (await import(storePath)).useAppStore();
        app.payload = {
          ...app.payload,
          automations: {
            ...app.payload.automations,
            byWorkspaceId: {
              ...app.payload.automations.byWorkspaceId,
              "auto-view": summary,
            },
          },
        };
      }, originalSummary);
      await page.evaluate(async () => {
        const storePath = "/stores/sandbox-requests.ts";
        const { useSandboxRequestsStore } = await import(storePath);
        await useSandboxRequestsStore().start({
          onSandboxDenied: () => () => undefined,
          onSandboxDeniedSettled: () => () => undefined,
          listSandboxRequests: async () => [
            {
              id: "network-request",
              workspaceId: "auto-view",
              sessionId: "auto-view:auto-agent",
              host: "http-intake.logs.us5.datadoghq.com",
              port: 443,
              at: Date.now(),
              state: "pending",
            },
          ],
        });
      });
      const attention = dashboard.locator(".dashboard-section--attention");
      await expect(attention.getByText("Action required · Network access")).toBeVisible();
      await expect(attention.getByTestId("sandbox-request")).toBeVisible();
      const toastClose = page.locator(".notification-toast__close");
      if (await toastClose.isVisible()) await toastClose.click();
      await expect(page.locator(".notification-toast")).toBeHidden();
      await expect(attention).toHaveCSS("border-left-width", "4px");
      expect(await attention.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
        await dashboard
          .locator(".dashboard-section")
          .last()
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      );
      await attention.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("action-required-light.png") });
      await page.evaluate(async () => {
        const storePath = "/stores/sandbox-requests.ts";
        const { useSandboxRequestsStore } = await import(storePath);
        useSandboxRequestsStore().records.splice(0);
      });
      await dashboard
        .locator(".runs li")
        .filter({ hasText: "The agent exited with code 17" })
        .getByRole("button", { name: "Details", exact: true })
        .click();
      await expect(dashboard.locator(".run-output")).toContainText("Error: provider authentication failed.");
      await page.screenshot({ path: testInfo.outputPath("failed-run-details-light.png") });
      if (viewport.width === 1280) {
        await dashboard.locator('.run-state[data-state="interrupted"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("run-status-colors-light.png") });
      }
      await dashboard.locator(".result").getByRole("button", { name: "Close", exact: true }).click();
      await dashboard.getByRole("button", { name: "Result", exact: true }).click();
      await expect(dashboard.getByText("All repository checks passed.", { exact: false })).toBeVisible();
      await dashboard.locator(".result").evaluate((element) => element.scrollIntoView({ block: "end" }));
      await expect(dashboard.locator(".result pre")).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("dashboard-result.png") });
      const size = await dashboard.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
        right: element.getBoundingClientRect().right,
      }));
      expect(size.scroll).toBeLessThanOrEqual(size.client + 1);
      expect(size.right).toBeLessThanOrEqual(viewport.width + 1);

      await expect(page.locator(".automation-pause")).toHaveCount(0);
      await page.locator('[data-role="notification-bell"]:visible').click();
      const center = page.locator(".notification-center");
      if (viewport.width >= 768)
        await center.evaluate((element) => {
          (element as HTMLElement).style.width = "600px";
        });
      if (await center.locator(".notification-center__tabmenu-toggle").isVisible()) {
        await center.locator(".notification-center__tabmenu-toggle").click();
        await center.getByRole("menuitem", { name: "Automations", exact: true }).click();
      } else {
        await center.getByRole("button", { name: "Automations", exact: true }).click();
      }
      const overview = center.getByRole("region", { name: "Automations", exact: true });
      await expect(overview.getByRole("button", { name: "Pause all", exact: true })).toBeVisible();
      await expect(overview.getByText("Every 60 minutes")).toBeVisible();
      await expect(overview.getByText(/^Next:/)).toBeVisible();
      await expect(overview.locator(".automation-overview")).toHaveCount(2);
      await overview.getByLabel("Filter automations by trigger").selectOption("event");
      await expect(overview.getByTitle("Open Review incoming PRs automation dashboard")).toBeVisible();
      await expect(overview.locator(".automation-overview")).toHaveCount(1);
      await overview.getByLabel("Filter automations by state").selectOption("failed");
      await expect(overview.getByText("No automations match these filters.")).toBeVisible();
      await overview.getByRole("button", { name: "Clear filters", exact: true }).click();
      await overview.getByLabel("Search automations", { exact: true }).fill("nightly");
      await overview.getByLabel("Filter automations by state").selectOption("failed");
      await expect(overview.locator(".automation-overview")).toHaveCount(1);
      const overviewSize = await overview.evaluate((element) => ({
        scroll: element.scrollWidth,
        client: element.clientWidth,
        right: element.getBoundingClientRect().right,
      }));
      expect(overviewSize.scroll).toBeLessThanOrEqual(overviewSize.client + 1);
      expect(overviewSize.right).toBeLessThanOrEqual(viewport.width + 1);
      await page.screenshot({ path: testInfo.outputPath("automations-overview.png") });
      await overview.getByTitle("Open Nightly check automation dashboard").click();
      await expect(center).not.toBeVisible();
      await expect(dashboard.getByRole("heading", { name: "Nightly check" })).toBeVisible();
      const closeResult = dashboard.locator(".result").getByRole("button", { name: "Close", exact: true });
      if (await closeResult.isVisible()) await closeResult.click();
      await dashboard.getByLabel("Filter run history by state").selectOption("failed");
      await dashboard.locator(".runs li").getByRole("button", { name: "Delete", exact: true }).click();
      const confirmation = page.locator(".overlay .dialog");
      await expect(confirmation.getByRole("heading", { name: "Delete run record?" })).toBeVisible();
      await expect(confirmation).toContainText("Result files in the workspace remain");
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(deletedRuns.size).toBe(0);
      await dashboard.getByRole("button", { name: "Delete finished (1)", exact: true }).click();
      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(dashboard.getByText("No runs match these filters.", { exact: true })).toBeVisible();
      expect([...deletedRuns]).toEqual(["failed"]);
      await dashboard.getByRole("button", { name: "Clear filters", exact: true }).click();
      await expect(dashboard.locator(".runs li")).toHaveCount(3);
      await page.route("**/api/automation/runs", (route) => route.fulfill({ json: { runs: [], total: 0 } }));
      await dashboard.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(dashboard.getByText("No runs yet.", { exact: true })).toBeVisible();
      await dashboard.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: testInfo.outputPath("dashboard-empty-light.png") });
      if (viewport.width >= 768) {
        // Exercise desktop focus with the real xterm, while keeping the test
        // transport connected to the local mock instead of Electron IPC.
        await page.evaluate(async () => {
          const appPath = "/stores/app.ts";
          const terminalPath = "/stores/terminal.ts";
          const app = (await import(appPath)).useAppStore();
          (await import(terminalPath)).useTerminalStore().init(
            { ...app.getApi(), isRemote: false },
            {},
            {
              getActiveSessionId: () => app.activeSessionId,
              getOverlay: () => app.overlay,
              getPayload: () => app.payload,
            },
          );
        });
      }
      await dashboard.locator(".dashboard-header").getByRole("button", { name: "Open agent", exact: true }).click();
      await expect(page.locator('.terminal-host[data-session-id="auto-view:auto-agent"]')).toBeVisible();
      await expect(dashboard).not.toBeVisible();
      if (viewport.width >= 768) {
        const input = page.locator('.terminal-host[data-session-id="auto-view:auto-agent"] .xterm-helper-textarea');
        await expect(input).toBeFocused();
        // Store-driven navigation (e.g. another opener/notification) must also
        // focus the agent, without a button-specific focus call.
        await page.evaluate(async () => {
          const path = "/stores/app.ts";
          await (await import(path)).useAppStore().activateView("automation-dashboard:auto-dash");
        });
        await expect(dashboard).toBeVisible();
        await page.evaluate(async () => {
          const path = "/stores/app.ts";
          await (await import(path)).useAppStore().activateView("auto-view:auto-agent");
        });
        await expect(input).toBeFocused();
        const inputCount = mock.terminalInputs.length;
        await page.keyboard.press("Enter");
        await expect
          .poll(() =>
            mock.terminalInputs
              .slice(inputCount)
              .some((input) => input.sessionId === "auto-view:auto-agent" && input.data === "\r"),
          )
          .toBe(true);
        await page.evaluate(async () => {
          const storePath = "/stores/app.ts";
          const app = (await import(storePath)).useAppStore();
          app.payload = {
            ...app.payload,
            workspace: {
              ...app.payload.workspace,
              sessions: app.payload.workspace.sessions.map((session: { sessionId: string }) =>
                session.sessionId === "auto-view:auto-agent"
                  ? { ...session, activity: "running", status: "running" }
                  : session,
              ),
            },
          };
        });
        const agentTab = page.locator('.tab-strip .tab[data-view-id="auto-view:auto-agent"]').first();
        await expect(agentTab.getByTestId("tab-isolated")).toBeVisible();
        await expect(agentTab.locator(".tab__status-text")).toHaveText("running");
        const badge = await agentTab.getByTestId("tab-isolated").boundingBox();
        const status = await agentTab.locator(".tab__status-text").boundingBox();
        expect(badge!.x + badge!.width).toBeLessThanOrEqual(status!.x);
        await page.screenshot({ path: testInfo.outputPath("isolated-running-tabs.png") });
      }
      assertNoErrors(page);
    });
  }
});
