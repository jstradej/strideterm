import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationState } from "../../shared/automation.js";
import type { AutomationEvent } from "../../shared/automation-events.js";
import { AutomationJournal } from "./automation-journal.js";
import { AutomationEventRouter, matchesAutomationEvent, type EventAutomation } from "./automation-event-router.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const definition: EventAutomation = {
  workspaceId: "auto",
  profileId: "p1",
  automation: {
    parentWorkspaceId: "root",
    enabled: true,
    enabledAt: "2026-01-01T00:00:00Z",
    trigger: { type: "event", source: "github", kinds: ["pr-new"] },
    executor: { type: "agent", agent: { providerId: "claude", model: "", skipPermissions: false } },
    prompt: "",
    location: "automation",
    policy: { maxRunMinutes: 60, catchUp: "skip", maxRunsPerHour: 6, subjectCooldownMinutes: 10 },
    createdBy: { kind: "desktop" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } satisfies AutomationState,
};
const event: AutomationEvent = {
  id: "e1",
  detectedAt: "2026-01-01T00:10:00Z",
  source: "github",
  kind: "pr-new",
  profileId: "p1",
  connectionId: "a",
  pr: {
    prKey: "a:1",
    repositoryName: "org/repo",
    pullRequestNumber: 1,
    title: "PR",
    webUrl: "https://example.com",
    headSha: "abc",
    role: "reviewer",
    draft: false,
  },
};
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "automation-events-"));
  dirs.push(dir);
  const journal = new AutomationJournal(dir, () => {});
  const ready = vi.fn();
  return { journal, ready, router: new AutomationEventRouter(journal, ready) };
}
describe("automation event router", () => {
  it("enforces profile and enable-time boundaries", () => {
    expect(matchesAutomationEvent(definition, event)).toBe(true);
    expect(matchesAutomationEvent(definition, { ...event, profileId: "p2" })).toBe(false);
    expect(matchesAutomationEvent(definition, { ...event, detectedAt: "2025-12-31T00:00:00Z" })).toBe(false);
  });
  it("matches target branches with or without the Git ref prefix", () => {
    const rule = structuredClone(definition);
    if (rule.automation.trigger.type !== "event") throw new Error("Expected event trigger");
    rule.automation.trigger.targetBranches = ["main"];
    expect(matchesAutomationEvent(rule, { ...event, pr: { ...event.pr!, targetBranch: "refs/heads/main" } })).toBe(
      true,
    );
    rule.automation.trigger.targetBranches = ["refs/heads/main"];
    expect(matchesAutomationEvent(rule, { ...event, pr: { ...event.pr!, targetBranch: "main" } })).toBe(true);
    expect(matchesAutomationEvent(rule, { ...event, pr: { ...event.pr!, targetBranch: "other" } })).toBe(false);
  });
  it("deduplicates across restarts and merges the same subject from separate connections", async () => {
    const { journal, ready, router } = await setup();
    await router.route(definition, { ...event, body: "secret" } as AutomationEvent, 60_000);
    await new AutomationEventRouter(journal, ready).route(definition, event, 60_000);
    await router.route(
      definition,
      { ...event, id: "e2", connectionId: "b", pr: { ...event.pr!, prKey: "b:1" } },
      60_000,
    );
    const state = await journal.read("auto");
    expect(state.pendingEvents).toHaveLength(1);
    expect(state.pendingEvents[0]!.events).toHaveLength(2);
    expect(JSON.stringify(state)).not.toContain("secret");
    expect(ready).toHaveBeenCalledTimes(2);
  });
  it("enforces connection, repository, role and Jira query filters", () => {
    const rule = structuredClone(definition);
    if (rule.automation.trigger.type !== "event") throw new Error("Expected event trigger");
    Object.assign(rule.automation.trigger, { connectionId: "a", repositories: ["org/repo"], role: "reviewer" });
    expect(matchesAutomationEvent(rule, event)).toBe(true);
    expect(matchesAutomationEvent(rule, { ...event, connectionId: "other" })).toBe(false);
    expect(matchesAutomationEvent(rule, { ...event, pr: { ...event.pr!, repositoryName: "other" } })).toBe(false);
    expect(matchesAutomationEvent(rule, { ...event, pr: { ...event.pr!, role: "author" } })).toBe(false);
    rule.automation.trigger = { type: "event", source: "jira", kinds: ["jira-issue-added"], jiraQueryId: "query" };
    const jira = {
      id: "jira",
      detectedAt: event.detectedAt,
      source: "jira" as const,
      kind: "jira-issue-added" as const,
      profileId: "p1",
      connectionId: "a",
      jira: { issueId: "1", issueKey: "A-1", queryId: "query" },
    };
    expect(matchesAutomationEvent(rule, jira)).toBe(true);
    expect(matchesAutomationEvent(rule, { ...jira, jira: { ...jira.jira, queryId: "other" } })).toBe(false);
  });
  it("records queue overflow and still merges events for an existing subject", async () => {
    const { journal, router } = await setup();
    await journal.update("auto", (state) => {
      for (let i = 0; i < 20; i++) state.pendingEvents.push({ subject: `pr:github:org/repo:${i}`, events: [] });
    });
    await router.route(definition, { ...event, pr: { ...event.pr!, pullRequestNumber: 21 } }, 60_000);
    await router.route(definition, { ...event, id: "merge" }, 60_000);
    const state = await journal.read("auto");
    expect(state.pendingEvents).toHaveLength(20);
    expect(state.pendingEvents[1]!.events).toHaveLength(1);
    expect(state.runs.at(-1)).toMatchObject({ state: "skipped", reason: "queue-full" });
  });
  it("respects the post-finish poll window and subject cooldown boundary", async () => {
    const { journal, router } = await setup();
    await journal.update("auto", (state) =>
      state.runs.push({
        runId: "run",
        state: "succeeded",
        trigger: { type: "event" },
        subject: "pr:github:org/repo:1",
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:09:30Z",
      }),
    );
    await router.route(definition, event, 60_000);
    await router.route(definition, { ...event, id: "after", detectedAt: "2026-01-01T00:10:31Z" }, 60_000);
    const state = await journal.read("auto");
    expect(state.runs.at(-1)).toMatchObject({ state: "skipped", reason: "cooldown" });
    expect(state.pendingEvents[0]?.events).toHaveLength(1);
  });
  it("records an event during its own subject's run as cooldown", async () => {
    const { journal, router } = await setup();
    await journal.update("auto", (state) => {
      state.runs.push({
        runId: "run",
        state: "running",
        trigger: { type: "event" },
        subject: "pr:github:org/repo:1",
        startedAt: "2026-01-01T00:05:00Z",
      });
    });
    await router.route(definition, event, 60_000);
    const state = await journal.read("auto");
    expect(state.pendingEvents).toHaveLength(0);
    expect(state.runs.at(-1)).toMatchObject({ state: "skipped", reason: "cooldown" });
  });
});
