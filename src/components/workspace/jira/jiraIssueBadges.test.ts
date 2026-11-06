import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import JiraIssueBadges from "./JiraIssueBadges.vue";
import { readFileSync } from "node:fs";
import { classifyJiraIssueType, jiraPriorityLevel } from "./jiraIssueBadges";

describe("Jira issue badge classification", () => {
  it.each([
    ["Bug", "bug"],
    ["User Story", "story"],
    ["Task", "task"],
    ["Sub-task", "subtask"],
    ["Epic", "epic"],
    ["Custom Request", "unknown"],
  ] as const)("classifies %s as %s", (label, kind) => {
    expect(classifyJiraIssueType(label)).toBe(kind);
  });

  it.each([
    ["Highest", 5],
    ["Blocker", 5],
    ["High", 4],
    ["Critical", 4],
    ["Medium", 3],
    ["Low", 2],
    ["Lowest", 1],
    ["Trivial", 1],
    ["A", 5],
    ["c", 3],
    ["Custom P1", null],
  ] as const)("maps priority %s to level %s", (label, level) => {
    expect(jiraPriorityLevel(label)).toBe(level);
  });

  it("keeps Highest, High, Medium, Low and Lowest apart instead of folding them into three letters", () => {
    const levels = ["Highest", "High", "Medium", "Low", "Lowest"].map((name) => jiraPriorityLevel(name));
    expect(new Set(levels).size).toBe(5);
  });

  it.each(["Highest", "High", "Medium", "Low", "Lowest"])("shows Jira's own name %s, never A/B/C", (name) => {
    const wrapper = mount(JiraIssueBadges, { props: { priority: name, only: "priority", minimal: true } });
    expect(wrapper.text()).toBe(name);
    expect(wrapper.findAll(".jira-badge__bar")).toHaveLength(5);
  });

  it("lights as many bars as the priority has steps", () => {
    const lit = (name: string) =>
      mount(JiraIssueBadges, { props: { priority: name, only: "priority" } }).findAll(
        ".jira-badge__bar:not(.jira-badge__bar--off)",
      ).length;
    expect([lit("Highest"), lit("High"), lit("Medium"), lit("Low"), lit("Lowest")]).toEqual([5, 4, 3, 2, 1]);
  });

  it("styles badges with theme status tokens, not hard-coded colours or undefined variables", () => {
    const source = readFileSync("src/components/workspace/jira/JiraIssueBadges.vue", "utf8");
    const css = source.slice(source.indexOf("<style"));
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(css).not.toContain("--text-secondary");
    expect(css).toContain("--status-failed");
  });

  it("keeps compact badges accessible and preserves unknown labels", () => {
    const wrapper = mount(JiraIssueBadges, {
      props: { issueType: "Custom Request", priority: "Expedite", compact: true },
    });
    expect(wrapper.get('[aria-label="Issue type: Custom Request"]').text()).toContain("Custom Request");
    expect(wrapper.get('[aria-label="Priority: Expedite"]').text()).toContain("Expedite");
    expect(wrapper.text()).toContain("Custom Request");
  });
});
