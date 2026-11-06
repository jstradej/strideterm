import { describe, expect, it } from "vitest";
import { autolinkJiraText, jiraCandidates, jiraIssueUrl } from "./jira-issue-links.js";

const route = {
  connectionId: "c1",
  label: "Engineering",
  webUrl: "https://jira.example/path",
  issueKeyPrefixes: ["ENG"],
};

describe("jira issue links", () => {
  it("matches literal configured prefixes and builds a safe browse URL", () => {
    expect(jiraCandidates("ENG-42", [route])).toEqual([route]);
    expect(jiraIssueUrl(route, "ENG-42")).toBe("https://jira.example/path/browse/ENG-42");
    expect(jiraCandidates("OPS-42", [route])).toEqual([]);
    // eslint-disable-next-line no-script-url -- verifies unsafe configured URLs are rejected
    expect(jiraIssueUrl({ ...route, webUrl: "javascript:alert(1)" }, "ENG-42")).toBeNull();
  });

  it("autolinks only unique mappings and respects token boundaries", () => {
    expect(autolinkJiraText("See ENG-42, xENG-42 and ENG-42x", [route])).toContain(
      'href="https://jira.example/path/browse/ENG-42"',
    );
    expect(autolinkJiraText("ENG-42", [route, { ...route, connectionId: "c2", label: "Other" }])).toContain(
      "jira-issue-chooser",
    );
    expect(autolinkJiraText("<img src=x> ENG-42", [route])).toContain("&lt;img src=x&gt;");
  });
});
