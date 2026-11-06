import { describe, expect, it } from "vitest";
import {
  jiraViewPreferencesKey,
  readJiraViewPreferences,
  writeLastJiraSearch,
  writeJiraViewPreferences,
  type JiraViewPreferences,
} from "./jira-view-preferences";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

describe("Jira view preferences", () => {
  it("restores the selected board and view after reconstruction", () => {
    const storage = memoryStorage();
    writeJiraViewPreferences(
      "profile-a",
      "workspace-a",
      {
        connectionId: "conn-1",
        boardId: "42",
        boardName: "Platform",
        boardType: "scrum",
        activeView: "board",
        boardMode: "sprints",
        selectedSprintId: "7",
      },
      storage,
    );
    expect(readJiraViewPreferences("profile-a", "workspace-a", storage)).toMatchObject({
      connectionId: "conn-1",
      boardId: "42",
      boardName: "Platform",
      activeView: "board",
      boardMode: "sprints",
      selectedSprintId: "7",
    });
  });

  it("isolates values by profile and workspace", () => {
    const storage = memoryStorage();
    writeJiraViewPreferences("profile-a", "workspace-a", { boardId: "1" }, storage);
    writeJiraViewPreferences("profile-b", "workspace-a", { boardId: "2" }, storage);
    expect(readJiraViewPreferences("profile-a", "workspace-a", storage).boardId).toBe("1");
    expect(readJiraViewPreferences("profile-a", "workspace-b", storage).boardId).toBeNull();
    expect(readJiraViewPreferences("profile-b", "workspace-a", storage).boardId).toBe("2");
  });

  it("uses defaults for malformed, unsupported, and legacy records", () => {
    const storage = memoryStorage();
    storage.setItem(jiraViewPreferencesKey("p", "w"), "{broken");
    expect(readJiraViewPreferences("p", "w", storage).activeView).toBe("issues");
    storage.setItem(jiraViewPreferencesKey("p", "w"), JSON.stringify({ boardId: "legacy" }));
    expect(readJiraViewPreferences("p", "w", storage).boardId).toBeNull();
    storage.setItem(
      jiraViewPreferencesKey("p", "w"),
      JSON.stringify({ version: 99, preferences: { boardId: "future" } }),
    );
    expect(readJiraViewPreferences("p", "w", storage).boardId).toBeNull();
  });

  it("migrates v1 preferences and stores only bounded successful search scope", () => {
    const storage = memoryStorage();
    const key = jiraViewPreferencesKey("p", "w");
    storage.setItem(
      key,
      JSON.stringify({ version: 1, preferences: { connectionId: "conn-1", boardId: "42", activeView: "board" } }),
    );
    expect(readJiraViewPreferences("p", "w", storage)).toMatchObject({
      boardId: "42",
      activeView: "board",
      lastSearch: null,
    });
    const result = writeLastJiraSearch(
      "p",
      "w",
      { connectionId: "conn-1", jql: 'assignee = "human-1"', kind: "my-issues", label: "My issues", filterId: null },
      storage,
    );
    expect(result.lastSearch).toMatchObject({ connectionId: "conn-1", kind: "my-issues", label: "My issues" });
    expect(JSON.parse(storage.getItem(key) || "{}")).not.toHaveProperty("issues");
  });

  it("rejects invalid or oversized JQL without replacing the last successful query", () => {
    const storage = memoryStorage();
    const first = writeLastJiraSearch(
      "p",
      "w",
      { connectionId: "conn-1", jql: "project = PROJ", kind: "jql", label: null, filterId: null },
      storage,
    );
    expect(first.lastSearch?.jql).toBe("project = PROJ");
    const unchanged = writeLastJiraSearch(
      "p",
      "w",
      { connectionId: "conn-1", jql: "x".repeat(2001), kind: "jql", label: null, filterId: null },
      storage,
    );
    expect(unchanged.lastSearch?.jql).toBe("project = PROJ");
  });

  it("bounds filters and validates assignee identity and enum values", () => {
    const storage = memoryStorage();
    const filters = Array.from({ length: 60 }, (_, index) => String(index + 1));
    const prefs: Partial<JiraViewPreferences> = {
      quickFilterIds: [...filters, "1"],
      assignee: { id: "acct-1", displayName: "Alex", kind: "cloud" },
      activeView: "invalid" as JiraViewPreferences["activeView"],
    };
    const result = writeJiraViewPreferences("p", "w", prefs, storage);
    expect(result.quickFilterIds).toHaveLength(50);
    expect(result.quickFilterIds[0]).toBe("1");
    expect(result.assignee).toEqual({ id: "acct-1", displayName: "Alex", kind: "cloud" });
    expect(result.activeView).toBe("issues");
  });

  it("rejects invalid Jira numeric ids without truncating opaque identities", () => {
    const storage = memoryStorage();
    const result = writeJiraViewPreferences(
      "p",
      "w",
      {
        connectionId: "opaque/connection:one",
        boardId: "9007199254740992",
        selectedSprintId: "3.5",
        quickFilterIds: ["1", "2x", "9007199254740992", "4".repeat(301)],
      },
      storage,
    );
    expect(result.connectionId).toBe("opaque/connection:one");
    expect(result.boardId).toBeNull();
    expect(result.selectedSprintId).toBeNull();
    expect(result.quickFilterIds).toEqual(["1"]);
  });

  it("persists unassigned distinctly and returns fresh defaults", () => {
    const storage = memoryStorage();
    const result = writeJiraViewPreferences("p", "w", { assignee: { kind: "unassigned" } }, storage);
    expect(readJiraViewPreferences("p", "w", storage).assignee).toEqual({ kind: "unassigned" });
    result.quickFilterIds.push("99");
    expect(readJiraViewPreferences("empty", "w", storage).quickFilterIds).toEqual([]);
    expect(readJiraViewPreferences("empty", "w", storage).quickFilterIds).not.toBe(
      readJiraViewPreferences("empty", "w", storage).quickFilterIds,
    );
  });

  it("defaults the completed-issue window to 14 days and keeps an explicit all-time choice", () => {
    const storage = memoryStorage();
    expect(readJiraViewPreferences("p", "w", storage)).toMatchObject({ doneWithinDays: 14, issueSort: "updated" });
    writeJiraViewPreferences("p", "w", { doneWithinDays: null, issueSort: "priority" }, storage);
    expect(readJiraViewPreferences("p", "w", storage)).toMatchObject({ doneWithinDays: null, issueSort: "priority" });
    writeJiraViewPreferences(
      "p",
      "w",
      { doneWithinDays: 5 as never, issueSort: "random" as JiraViewPreferences["issueSort"] },
      storage,
    );
    expect(readJiraViewPreferences("p", "w", storage)).toMatchObject({ doneWithinDays: 14, issueSort: "updated" });
  });

  it("keeps the page usable when storage reads or writes are blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readJiraViewPreferences("p", "w", blocked).boardId).toBeNull();
    expect(writeJiraViewPreferences("p", "w", { boardId: "42" }, blocked).boardId).toBe("42");
  });

  it("round-trips the smart filters per profile and workspace, and cleans what it cannot trust", () => {
    const storage = memoryStorage();
    expect(readJiraViewPreferences("p", "w", storage).smartFilters).toEqual([]);
    writeJiraViewPreferences("p", "w", { smartFilters: ["open", "watching", "assigned-to-me"] }, storage);
    expect(readJiraViewPreferences("p", "w", storage).smartFilters).toEqual(["assigned-to-me", "open"]);
    expect(readJiraViewPreferences("other", "w", storage).smartFilters).toEqual([]);
    expect(readJiraViewPreferences("p", "other", storage).smartFilters).toEqual([]);
    storage.setItem(
      jiraViewPreferencesKey("p", "w"),
      JSON.stringify({ version: 3, preferences: { smartFilters: ["assignee = x", 7, "unassigned"] } }),
    );
    expect(readJiraViewPreferences("p", "w", storage).smartFilters).toEqual(["unassigned"]);
  });

  it("reads a version 2 envelope without smart filters as none", () => {
    const storage = memoryStorage();
    storage.setItem(
      jiraViewPreferencesKey("p", "w"),
      JSON.stringify({ version: 2, preferences: { connectionId: "conn-1" } }),
    );
    const read = readJiraViewPreferences("p", "w", storage);
    expect(read.connectionId).toBe("conn-1");
    expect(read.smartFilters).toEqual([]);
  });
});
