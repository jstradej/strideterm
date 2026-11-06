import { describe, expect, it, vi } from "vitest";
import {
  jiraCommentDraftDtoSchema,
  jiraConnectionDtoSchema,
  jiraIssueDtoSchema,
  jiraProjectDtoSchema,
  jiraTaskContextDtoSchema,
  jiraVerifyConnectionDtoSchema,
  jiraWriteJournalEntryDtoSchema,
  jiraWriteReconcileResultDtoSchema,
} from "../ipc-schemas.js";
import { createJiraHandlers } from "./runtime-jira-handlers.js";
import { JiraWriteJournal, type JiraWriteJournalState } from "./jira-write-journal.js";

const ref = { provider: "jira", connectionId: "dc-1", issueId: "100", issueKey: "ABC-1" };

function setup(fetchOverride?: typeof fetch) {
  const connection = {
    id: "dc-1",
    profileId: "profile-1",
    label: "Jira",
    enabled: true,
    deployment: "data-center" as const,
    webUrl: "https://jira.example.test",
    apiBaseUrl: "https://jira.example.test/jira",
    auth: { kind: "dc-pat" as const, secretRef: "jira:pat" },
    accountPurpose: "personal" as const,
    verifiedIdentity: { kind: "data-center" as const, name: "bot", displayName: "Bot" },
    ownIdentity: { kind: "data-center" as const, name: "alice", displayName: "Alice" },
  };
  const cloudConnection = {
    id: "cloud-1",
    profileId: "profile-1",
    label: "Jira Cloud",
    enabled: true,
    deployment: "cloud" as const,
    webUrl: "https://team.atlassian.net",
    apiBaseUrl: "",
    cloudId: "cloud-id-1",
    auth: { kind: "cloud-api-token" as const, secretRef: "hidden-ref", email: "me@example.com" },
    accountPurpose: "technical" as const,
    verifiedIdentity: { kind: "cloud" as const, accountId: "api-id", displayName: "API Bot" },
  };
  const state = {
    settings: {
      integrations: {
        jira: {
          connections: [connection, cloudConnection],
          queries: [
            {
              id: "q1",
              profileId: "profile-1",
              connectionId: "dc-1",
              name: "Mine",
              jql: "project = ABC",
              notificationsEnabled: false,
              updatedAt: "2026-10-23T00:00:00Z",
            },
          ],
        },
      },
    },
    profiles: [{ id: "profile-1", name: "Alice" }],
    workspaces: [
      {
        id: "workspace-1",
        profileId: "profile-1",
        jiraMcpEnabled: true,
        jiraMcpCommentDrafts: [
          {
            id: "agent-draft-1",
            ref,
            body: "Agent suggestion",
            sourceWorkspaceId: "workspace-1",
            createdAt: "2026-10-23T00:00:01Z",
          },
        ],
        task: {
          jiraIssueRefs: [ref],
          jiraPreparedSnapshot: [
            {
              ref,
              fields: {
                summary: "Selected issue",
                status: "Open",
                comments: [{ id: "c1", author: "Alice", created: "today", body: "selected comment" }],
              },
            },
          ],
          jiraIssueSnapshots: [
            {
              ref,
              fields: {
                summary: "Selected issue",
                status: "Open",
                issueType: "Task",
                projectKey: "ABC",
                updated: "today",
              },
              hash: "a".repeat(64),
            },
          ],
          jiraCommentDrafts: [
            {
              id: "draft-1",
              ref,
              body: "Draft text",
              sourceWorkspaceId: "workspace-1",
              createdAt: "2026-10-23T00:00:00Z",
            },
          ],
        },
      },
    ],
  };
  const secrets = new Map<string, string>([["jira:pat", "local-test-token"]]);
  const credentialStore = {
    isEncryptionAvailable: () => true,
    getSecret: (key: string) => secrets.get(key) || "",
    setSecret: vi.fn(async (key: string, value: string) => {
      secrets.set(key, value);
    }),
    deleteSecret: vi.fn(async (key: string) => {
      secrets.delete(key);
    }),
  };
  const store = { mutate: async (fn: (_draft: typeof state) => void) => fn(state) };
  const fetchImpl =
    fetchOverride ||
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/myself")) return new Response(JSON.stringify({ name: "bot", displayName: "Bot" }));
      if (url.pathname.endsWith("/project"))
        return new Response(JSON.stringify([{ id: "1", key: "ABC", name: "Project ABC" }]));
      if (url.pathname.endsWith("/remotelink")) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify({}));
    });
  const context = { credentialStore, store, fetchImpl, getState: () => state, getViewerProfileId: () => "profile-1" };
  const handlers = createJiraHandlers(context);
  return { handlers, connection, secrets, fetchImpl, state, context };
}

describe("Jira runtime output contracts", () => {
  it("returns bounded issue details through the runtime DTO and strips unmodeled provider fields", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/issue/100"))
        return new Response(
          JSON.stringify({
            id: "100",
            key: "ABC-1",
            providerDebugToken: "must-not-cross-the-contract",
            fields: {
              summary: "Issue details",
              status: { id: "10001", name: "Open", statusCategory: { key: "new", colorName: "blue-gray" } },
              issuetype: { name: "Task" },
              project: { key: "ABC" },
              updated: "2026-10-23T00:00:00Z",
              created: "2026-10-20T00:00:00Z",
              assignee: { displayName: "Alice" },
              reporter: { displayName: "Bob" },
              priority: { name: "High" },
              resolution: { name: "Fixed" },
              labels: ["customer"],
              components: [{ name: "Desktop" }],
              fixVersions: [{ name: "1.2.0" }],
              description: "*Steps* to reproduce",
              attachment: [{ id: "42", filename: "log.txt", mimeType: "text/plain", size: 12 }],
              issuelinks: [
                {
                  type: { name: "Blocks" },
                  outwardIssue: { key: "ABC-2", fields: { summary: "Blocked issue", status: { name: "Open" } } },
                },
              ],
              providerInternalField: "must-not-cross-the-contract",
            },
          }),
        );
      return new Response(JSON.stringify({}));
    });
    const { handlers } = setup(fetchImpl as typeof fetch);

    const issue = await handlers.jiraGetIssue({ connectionId: "dc-1", issueId: "100" }, "window");

    expect(jiraIssueDtoSchema.parse(issue)).toMatchObject({
      ref: { connectionId: "dc-1", issueId: "100", issueKey: "ABC-1" },
      status: "Open",
      statusId: "10001",
      statusCategory: "new",
      priority: "High",
      reporter: "Bob",
      created: "2026-10-20T00:00:00Z",
      resolution: "Fixed",
      labels: ["customer"],
      components: ["Desktop"],
      versions: ["1.2.0"],
      description: "Steps to reproduce",
      descriptionMarkdown: "**Steps** to reproduce",
      attachments: [{ id: "42", fileName: "log.txt", mediaType: "text/plain", sizeBytes: 12 }],
      issueLinks: [
        { type: "Blocks", direction: "outward", issueKey: "ABC-2", summary: "Blocked issue", status: "Open" },
      ],
    });
    expect(issue).not.toHaveProperty("providerDebugToken");
    expect(issue).not.toHaveProperty("providerInternalField");
    expect(jiraIssueDtoSchema.parse({ ...issue, futureProviderField: "must-be-stripped" })).not.toHaveProperty(
      "futureProviderField",
    );
  });

  it("validates actual runtime connection, identity, task comments, drafts, and projects", async () => {
    const { handlers, connection, fetchImpl } = setup();
    const connections = await handlers.jiraListConnections("window");
    expect(jiraConnectionDtoSchema.array().max(100).parse(connections)).toHaveLength(2);
    expect(connections[0].auth).toEqual({ kind: "dc-pat" });
    expect(connections[0].auth).not.toHaveProperty("secretRef");
    expect(connections[1]).toMatchObject({
      deployment: "cloud",
      verifiedIdentity: { kind: "cloud", accountId: "api-id" },
      auth: { kind: "cloud-api-token", email: "me@example.com" },
    });
    expect(connections[1].auth).not.toHaveProperty("secretRef");
    expect(jiraVerifyConnectionDtoSchema.parse(await handlers.jiraVerifyConnection("dc-1", "window"))).toMatchObject({
      ok: true,
      identity: { kind: "data-center", name: "bot" },
      health: { state: "verified" },
    });
    expect(jiraTaskContextDtoSchema.parse(await handlers.jiraGetTaskContext("workspace-1", "window"))).toMatchObject({
      jiraPreparedSnapshot: [{ fields: { comments: [{ body: "selected comment" }] } }],
    });
    expect(
      jiraCommentDraftDtoSchema
        .array()
        .max(100)
        .parse(await handlers.listJiraCommentDrafts("workspace-1", "window")),
    ).toHaveLength(2);
    await handlers.deleteJiraCommentDraft({ sourceWorkspaceId: "workspace-1", draftId: "agent-draft-1" }, "window");
    expect(await handlers.listJiraCommentDrafts("workspace-1", "window")).toHaveLength(1);
    expect(jiraProjectDtoSchema.array().parse(await handlers.jiraListProjects("dc-1", "window"))).toEqual([
      { id: "1", key: "ABC", name: "Project ABC" },
    ]);
    expect(fetchImpl).toHaveBeenCalled();
    expect(connection.auth.secretRef).toBe("jira:pat");
  });

  it("validates actual persisted history and read-only reconciliation output", async () => {
    const { handlers, secrets } = setup();
    const tempStore = {
      value: undefined as JiraWriteJournalState | undefined,
      async load() {
        return this.value;
      },
      async save(value: JiraWriteJournalState) {
        this.value = value;
      },
    };
    const journal = new JiraWriteJournal({ store: tempStore });
    const entry = await journal.begin({
      profileId: "profile-1",
      connectionId: "dc-1",
      issueId: "100",
      issueKey: "ABC-1",
      kind: "remote-link",
      fingerprint: "b".repeat(64),
      requester: "Alice",
      apiActor: "Bot (bot)",
      metadata: { kind: "remote-link", globalId: "pr:42", submittedAt: Date.now() },
    });
    await journal.markUnknown(entry.id);
    secrets.set("jira:write-journal:profile-1", JSON.stringify(tempStore.value));
    const history = await handlers.jiraGetWriteHistory({ connectionId: "dc-1" }, "window");
    expect(jiraWriteJournalEntryDtoSchema.array().max(100).parse(history)[0].state).toBe("unknown");
    expect(
      jiraWriteReconcileResultDtoSchema.parse(await handlers.jiraReconcileWrite(entry.id, "window")),
    ).toMatchObject({ status: "reconciled", outcome: "not-applied" });
  });

  it("returns a sanitized health DTO for a real rate-limit response", async () => {
    const { handlers } = setup(
      vi.fn(
        async () => new Response("provider-body accessToken=hidden", { status: 429, headers: { "Retry-After": "2" } }),
      ),
    );
    const result = await handlers.jiraVerifyConnection("dc-1", "window");
    expect(jiraVerifyConnectionDtoSchema.parse(result)).toMatchObject({
      ok: false,
      health: { state: "rate-limited", retryAfterMs: 2000 },
    });
    expect(JSON.stringify(result)).not.toContain("accessToken");
  });
});
