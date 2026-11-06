import { describe, expect, it } from "vitest";
import { stripJiraPrivatePayload } from "./jira-payload.js";

describe("generic Jira payload redaction", () => {
  it("removes bodies, drafts and polling membership but keeps issue refs/summaries", () => {
    const payload = {
      appState: {
        settings: {
          integrations: {
            jira: {
              connections: [
                {
                  id: "j1",
                  clientCertificatePath: "C:\\private\\client.pfx",
                  auth: { kind: "dc-apim", secretRef: "secret", passphraseRef: "secret-pass" },
                },
              ],
              pollingState: { watches: { secret: "APP-1" } },
              writeJournal: [{ fingerprint: "private-operation-metadata" }],
            },
          },
        },
        workspaces: [
          {
            jiraMcpCommentDrafts: [{ id: "d1", body: "agent-written private draft" }],
            workItems: [
              {
                ref: { connectionId: "j1", issueId: "1", issueKey: "APP-1" },
                summary: "Small safe summary",
                status: "Open",
              },
            ],
            task: {
              jiraIssueRefs: [{ connectionId: "j1", issueId: "1" }],
              jiraPreparedSnapshot: [{ fields: { description: "private issue body", comments: "private comments" } }],
              jiraCommentDrafts: [{ body: "private draft" }],
            },
          },
        ],
      },
    };
    stripJiraPrivatePayload(payload);
    expect(payload.appState.workspaces[0].workItems[0].summary).toBe("Small safe summary");
    expect(payload.appState.workspaces[0].task.jiraIssueRefs).toHaveLength(1);
    expect(payload.appState.workspaces[0].task).not.toHaveProperty("jiraPreparedSnapshot");
    expect(payload.appState.workspaces[0].task).not.toHaveProperty("jiraCommentDrafts");
    expect(payload.appState.workspaces[0]).not.toHaveProperty("jiraMcpCommentDrafts");
    expect(JSON.stringify(payload)).not.toContain("agent-written private draft");
    expect(payload.appState.settings.integrations.jira).not.toHaveProperty("pollingState");
    expect(payload.appState.settings.integrations.jira).not.toHaveProperty("writeJournal");
    expect(payload.appState.settings.integrations.jira.connections[0].auth).toEqual({ kind: "dc-apim" });
    expect(JSON.stringify(payload)).not.toContain("secret-pass");
    expect(JSON.stringify(payload)).not.toContain('secret"}');
  });
});
