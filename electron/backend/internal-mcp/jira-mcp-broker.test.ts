import { afterEach, describe, expect, it, vi } from "vitest";
import { createInternalMcpBroker, type JiraInternalMcpApi } from "./internal-mcp-broker.js";
import type { InternalMcpScope, TaskService } from "./task-service.js";

const brokerInstances: Array<ReturnType<typeof createInternalMcpBroker>> = [];
const baseService = {
  prepare: vi.fn(),
  start: vi.fn(),
  operationGet: vi.fn(),
  taskList: vi.fn(),
  taskGet: vi.fn(),
  companionCreate: vi.fn(),
  companionStart: vi.fn(),
  companionPause: vi.fn(),
  companionAnswer: vi.fn(),
} as unknown as Pick<
  TaskService,
  | "prepare"
  | "start"
  | "operationGet"
  | "taskList"
  | "taskGet"
  | "companionCreate"
  | "companionStart"
  | "companionPause"
  | "companionAnswer"
>;
afterEach(async () => {
  await Promise.all(brokerInstances.splice(0).map((broker) => broker.close()));
});

async function startBroker(jira: JiraInternalMcpApi | undefined, live = true) {
  const broker = createInternalMcpBroker({
    service: baseService,
    ...(jira ? { jira } : {}),
    isGrantLive: () => live,
  });
  brokerInstances.push(broker);
  await broker.start();
  const grant = broker.mintGrant({
    profileId: "profile-granted",
    workspaceId: "workspace-granted",
    sessionId: "session",
    panelId: "panel",
    command: "claude",
    tasksEnabled: false,
    jiraEnabled: true,
  });
  return grant;
}

function jiraApi(impl: Partial<JiraInternalMcpApi> = {}) {
  const seen: InternalMcpScope[] = [];
  const method = (name: keyof JiraInternalMcpApi) => async (scope: InternalMcpScope, input: unknown) => {
    seen.push(scope);
    return impl[name]
      ? (impl[name] as (scope: InternalMcpScope, input: unknown) => Promise<unknown>)(scope, input)
      : { ok: true };
  };
  return {
    seen,
    api: {
      listConnections: method("listConnections"),
      getIssue: method("getIssue"),
      search: method("search"),
      getComments: method("getComments"),
      listProjects: method("listProjects"),
      listFilters: method("listFilters"),
      getFilter: method("getFilter"),
      listBoards: method("listBoards"),
      boardView: method("boardView"),
      getTransitions: method("getTransitions"),
      getAttachment: method("getAttachment"),
      linkedWork: method("linkedWork"),
      proposeComment: method("proposeComment"),
    } as JiraInternalMcpApi,
  };
}

async function call(url: string, capability: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Jira internal MCP grant dispatch", () => {
  it("dispatches read/draft operations with grant-fixed profile/workspace and strict read-only inputs", async () => {
    const { api, seen } = jiraApi();
    const grant = await startBroker(api);
    const response = await call(grant.url, grant.capability, {
      operation: "jira_search",
      input: { connectionId: "jira-1", query: "project = TEST", limit: 5 },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { ok: true } });
    expect(seen).toEqual([{ profileId: "profile-granted", workspaceId: "workspace-granted" }]);
    const widened = await call(grant.url, grant.capability, {
      operation: "jira_get_issue",
      input: { connectionId: "jira-1", issueId: "TEST-1", profileId: "profile-other" },
    });
    expect(widened.status).toBe(400);
    const write = await call(grant.url, grant.capability, {
      operation: "jira_propose_comment",
      input: { connectionId: "jira-1", issueId: "TEST-1", body: "Draft only" },
    });
    expect(write.status).toBe(200);
  });

  it("does not dispatch when grant is invalid or no Jira API was injected", async () => {
    const { api, seen } = jiraApi();
    const invalidGrant = await startBroker(api, false);
    expect(
      (
        await call(invalidGrant.url, invalidGrant.capability, {
          operation: "jira_get_issue",
          input: { connectionId: "jira-1", issueId: "TEST-1" },
        })
      ).status,
    ).toBe(403);
    expect(seen).toHaveLength(0);
    const noApi = await startBroker(undefined);
    const unavailable = await call(noApi.url, noApi.capability, {
      operation: "jira_get_issue",
      input: { connectionId: "jira-1", issueId: "TEST-1" },
    });
    expect(unavailable.status).toBe(422);
    expect(JSON.stringify(await unavailable.json())).not.toContain("token");
  });
});
