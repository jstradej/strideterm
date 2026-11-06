import { describe, expect, it } from "vitest";
import {
  JIRA_SMART_FILTER_IDS,
  JIRA_SMART_FILTER_TITLES,
  jiraSmartFilterLabel,
  normalizeJiraSmartFilters,
} from "./jira-smart-filters.js";

describe("Jira smart filters", () => {
  it("keeps one choice per group in a stable order and drops unknown ids", () => {
    expect(normalizeJiraSmartFilters(["current-sprint", "open", "watching", "in-progress", "bogus", 3])).toEqual([
      "watching",
      "in-progress",
      "current-sprint",
    ]);
  });

  it("labels the active chips and falls back to My issues", () => {
    expect(jiraSmartFilterLabel(["assigned-to-me", "open"])).toBe("Assigned to me · Open");
    expect(jiraSmartFilterLabel([])).toBe("My issues");
  });

  it("explains every chip", () => {
    for (const id of JIRA_SMART_FILTER_IDS) expect(JIRA_SMART_FILTER_TITLES[id].length).toBeGreaterThan(5);
  });
});
