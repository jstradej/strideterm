import { describe, expect, it } from "vitest";
import type { AutomationEvent } from "../../shared/automation-events.js";
import { automationPollIntervalMs } from "./automation-poll-interval.js";

const settings = {
  github: {
    defaultPollSeconds: 120,
    connections: [
      { id: "g", enabled: true, pollSeconds: 30 },
      { id: "g2", enabled: true, pollSeconds: 60 },
    ],
  },
  azureDevops: { defaultPollSeconds: 90, connections: [{ id: "a", enabled: true }] },
  jira: {
    defaultPollSeconds: 900,
    connections: [{ id: "j", profileId: "p", enabled: true, pollSeconds: 1200 }],
    queries: [{ id: "q", connectionId: "j", profileId: "p", pollSeconds: 1800 }],
  },
};
const base = { id: "e", detectedAt: "2026-01-01T00:00:00Z", profileId: "p", connectionId: "g" };
describe("automation event polling interval", () => {
  it("uses the provider's actual shared polling frequency", () => {
    expect(automationPollIntervalMs({ ...base, source: "github", kind: "pr-new" }, settings)).toBe(30_000);
    expect(
      automationPollIntervalMs({ ...base, source: "azure-devops", kind: "pr-new", connectionId: "a" }, settings),
    ).toBe(90_000);
  });
  it("uses the Jira query frequency and never takes a different profile's query", () => {
    const event: AutomationEvent = {
      ...base,
      source: "jira",
      kind: "jira-issue-changed",
      connectionId: "j",
      jira: { issueId: "1", issueKey: "P-1", queryId: "q" },
    };
    expect(automationPollIntervalMs(event, settings)).toBe(1_800_000);
    expect(automationPollIntervalMs({ ...event, profileId: "other" }, settings)).toBe(900_000);
  });
});
