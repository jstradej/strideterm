import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import JiraPerson from "./JiraPerson.vue";
import {
  formatJiraRelativeTime,
  jiraPersonHue,
  jiraPersonInitials,
  jiraPersonName,
  jiraPersonOrganization,
  jiraStatusTone,
} from "./jiraPeople";

describe("Jira people", () => {
  it("separates the organisation suffix from the display name", () => {
    expect(jiraPersonName("Doe, Jane (Acme Ltd.)")).toBe("Doe, Jane");
    expect(jiraPersonOrganization("Doe, Jane (Acme Ltd.)")).toBe("Acme Ltd.");
    expect(jiraPersonName("Alice")).toBe("Alice");
    expect(jiraPersonOrganization("Alice")).toBe("");
  });

  it.each([
    ["Doe, Jane (Acme Ltd.)", "JD"],
    ["Smith, John 2 (Acme Ltd.)", "JS"],
    ["Roe, Richard (Partner)", "RR"],
    ["John Smith", "JS"],
    ["Alice", "AL"],
    ["W9NIZLA", "WN"],
    ["", "?"],
  ])("derives initials for %s", (name, initials) => {
    expect(jiraPersonInitials(name)).toBe(initials);
  });

  it("keeps avatar colours stable per person", () => {
    expect(jiraPersonHue("Doe, Jane")).toBe(jiraPersonHue("Doe, Jane"));
    expect(new Set(["A", "B", "C", "D", "E", "F"].map(jiraPersonHue)).size).toBeGreaterThan(1);
  });

  it("renders an unassigned placeholder and marks the user's own avatar", () => {
    expect(mount(JiraPerson).text()).toBe("Unassigned");
    const own = mount(JiraPerson, { props: { displayName: "Smith, John 2 (Acme Ltd.)", me: true } });
    expect(own.text()).toContain("JS");
    expect(own.text()).toContain("Smith, John 2");
    expect(own.attributes("title")).toBe("Smith, John 2 (Acme Ltd.) (you)");
    expect(own.classes()).toContain("jira-person--me");
  });
});

describe("Jira status tone", () => {
  it.each([
    ["To Do", "todo"],
    ["In Progress", "progress"],
    ["Waiting", "waiting"],
    ["Code Review", "review"],
    ["Testing", "testing"],
    ["Ready for testing", "testing"],
    ["Done", "done"],
    ["Closed", "done"],
    ["Cancelled", "cancelled"],
    ["Canceled", "cancelled"],
    ["Rejected", "cancelled"],
    ["Blocked", "blocked"],
    ["Pending", "waiting"],
    ["Selected for Development", "todo"],
  ] as const)("maps %s to %s", (name, tone) => {
    expect(jiraStatusTone(name)).toBe(tone);
  });

  it("keeps Cancelled and Rejected apart from done, and Blocked apart from Pending, even in the done category", () => {
    expect(jiraStatusTone("Cancelled", "done")).toBe("cancelled");
    expect(jiraStatusTone("Blocked", "indeterminate")).not.toBe(jiraStatusTone("Pending", "indeterminate"));
  });

  it("prefers the Jira status category over the name", () => {
    expect(jiraStatusTone("Accepted", "done")).toBe("done");
    expect(jiraStatusTone("Triage", "new")).toBe("todo");
    expect(jiraStatusTone("Triage", "indeterminate")).toBe("progress");
  });
});

describe("relative Jira time", () => {
  it("formats past timestamps and keeps unparsable values", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(formatJiraRelativeTime("2026-10-24T12:00:00Z", now)).toBe("2 days ago");
    expect(formatJiraRelativeTime("today", now)).toBe("today");
    expect(formatJiraRelativeTime(undefined, now)).toBe("");
  });
});
