import { describe, expect, test } from "vitest";
import { jiraViewIdFromTab, jiraViewTabId } from "./jira-view-tabs.js";

describe("Jira native view tab IDs", () => {
  test("keeps Issues stable and scopes saved view IDs to their full workspace ID", () => {
    expect(jiraViewTabId("profile:workspace", "issues")).toBe("jira:profile:workspace");
    const tabId = jiraViewTabId("profile:workspace", "board:view:one");
    expect(tabId).toBe("jira:profile:workspace:view:board%3Aview%3Aone");
    expect(jiraViewIdFromTab(tabId, "profile:workspace")).toBe("board:view:one");
  });

  test("rejects tabs from another workspace and malformed IDs", () => {
    expect(jiraViewIdFromTab("jira:other:view:saved", "profile:workspace")).toBeNull();
    expect(jiraViewIdFromTab("jira:profile:workspace:view:%E0%A4%A", "profile:workspace")).toBeNull();
    expect(jiraViewIdFromTab("jira:profile:workspace:view:issues", "profile:workspace")).toBeNull();
  });
});
