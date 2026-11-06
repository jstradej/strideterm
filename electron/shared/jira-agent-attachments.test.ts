import { describe, expect, it } from "vitest";
import { normalizeState } from "../backend/default-state.js";
import { jiraAgentAttachmentLimitsSchema } from "../backend/ipc-schemas.js";
import { DEFAULT_JIRA_AGENT_ATTACHMENT_LIMITS, normalizeJiraAgentAttachmentLimits } from "./jira-agent-attachments.js";

describe("normalizeJiraAgentAttachmentLimits", () => {
  it("fills defaults only for missing or invalid values and clamps the rest", () => {
    expect(normalizeJiraAgentAttachmentLimits(undefined)).toEqual(DEFAULT_JIRA_AGENT_ATTACHMENT_LIMITS);
    expect(normalizeJiraAgentAttachmentLimits({ maxFiles: "x", maxMegabytes: NaN })).toEqual(
      DEFAULT_JIRA_AGENT_ATTACHMENT_LIMITS,
    );
    expect(normalizeJiraAgentAttachmentLimits({ maxFiles: 7, maxMegabytes: 12 })).toEqual({
      maxFiles: 7,
      maxMegabytes: 12,
    });
    expect(normalizeJiraAgentAttachmentLimits({ maxFiles: 0, maxMegabytes: 99_999 })).toEqual({
      maxFiles: 1,
      maxMegabytes: 500,
    });
  });

  it("survives a state re-normalize and is filled for state that predates it", () => {
    const jiraWith = (jira: Record<string, unknown>) => ({ settings: { integrations: { jira } } }) as never;
    expect(normalizeState(jiraWith({})).settings.integrations.jira?.agentAttachments).toEqual(
      DEFAULT_JIRA_AGENT_ATTACHMENT_LIMITS,
    );
    const mine = { maxFiles: 9, maxMegabytes: 11 };
    const once = normalizeState(jiraWith({ agentAttachments: mine }));
    const twice = normalizeState(once);
    expect(twice.settings.integrations.jira?.agentAttachments).toEqual(mine);
  });

  it("has a strict, bounded IPC schema", () => {
    const ok = { maxFiles: 50, maxMegabytes: 50 };
    expect(jiraAgentAttachmentLimitsSchema.safeParse(ok).success).toBe(true);
    expect(jiraAgentAttachmentLimitsSchema.safeParse({ ...ok, maxFiles: 0 }).success).toBe(false);
    expect(jiraAgentAttachmentLimitsSchema.safeParse({ ...ok, maxMegabytes: 501 }).success).toBe(false);
    expect(jiraAgentAttachmentLimitsSchema.safeParse({ ...ok, maxFiles: 1.5 }).success).toBe(false);
    expect(jiraAgentAttachmentLimitsSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});
