import { describe, expect, test } from "vitest";
import { jiraConnectionMetadataSchema } from "../../../../../electron/backend/ipc-schemas.js";
import { splitJiraKeys, validateJiraMetadataDraft, type JiraMetadataDraftInput } from "./jira-metadata-validation.js";

const valid: JiraMetadataDraftInput = {
  label: "Engineering",
  accountPurpose: "personal",
  issueKeyPrefixesText: "APP, OPS",
  defaultJql: "project = APP",
  projectKeysText: "APP",
  pollSeconds: 120,
};

function schemaAccepts(draft: JiraMetadataDraftInput) {
  return jiraConnectionMetadataSchema.safeParse({
    connectionId: "jira-1",
    label: draft.label,
    accountPurpose: draft.accountPurpose,
    issueKeyPrefixes: splitJiraKeys(draft.issueKeyPrefixesText),
    defaultJql: draft.defaultJql,
    projectKeys: splitJiraKeys(draft.projectKeysText),
    pollSeconds: typeof draft.pollSeconds === "number" ? draft.pollSeconds : Number(draft.pollSeconds),
  }).success;
}

describe("validateJiraMetadataDraft", () => {
  const keys = (count: number) => Array.from({ length: count }, (_, index) => `K${index}`).join(",");
  const cases: Array<[string, JiraMetadataDraftInput]> = [
    ["a valid draft", valid],
    ["lower-case keys", { ...valid, issueKeyPrefixesText: "app, ops", projectKeysText: "app" }],
    ["an empty label", { ...valid, label: "   " }],
    ["a label of 80 characters", { ...valid, label: "x".repeat(80) }],
    ["a label of 81 characters", { ...valid, label: "x".repeat(81) }],
    ["a prefix starting with a digit", { ...valid, issueKeyPrefixesText: "APP, 9BAD" }],
    ["a prefix with a dash", { ...valid, issueKeyPrefixesText: "AP-P" }],
    ["a prefix of 20 characters", { ...valid, issueKeyPrefixesText: "A".repeat(20) }],
    ["a prefix of 21 characters", { ...valid, issueKeyPrefixesText: "A".repeat(21) }],
    ["50 prefixes", { ...valid, issueKeyPrefixesText: keys(50) }],
    ["51 prefixes", { ...valid, issueKeyPrefixesText: keys(51) }],
    ["100 project keys", { ...valid, projectKeysText: keys(100) }],
    ["101 project keys", { ...valid, projectKeysText: keys(101) }],
    ["a bad project key", { ...valid, projectKeysText: "APP, _x" }],
    ["JQL of 2000 characters", { ...valid, defaultJql: "j".repeat(2000) }],
    ["JQL of 2001 characters", { ...valid, defaultJql: "j".repeat(2001) }],
    ["a poll interval of 59", { ...valid, pollSeconds: 59 }],
    ["a poll interval of 60", { ...valid, pollSeconds: 60 }],
    ["a poll interval of 3600", { ...valid, pollSeconds: 3600 }],
    ["a poll interval of 3601", { ...valid, pollSeconds: 3601 }],
    ["a fractional poll interval", { ...valid, pollSeconds: 90.5 }],
    ["a cleared poll interval", { ...valid, pollSeconds: "" }],
  ];

  test.each(cases)("agrees with jiraConnectionMetadataSchema for %s", (_name, draft) => {
    expect(validateJiraMetadataDraft(draft).ok).toBe(schemaAccepts(draft));
  });

  test("a valid draft yields a payload the schema accepts as-is", () => {
    const result = validateJiraMetadataDraft({ ...valid, issueKeyPrefixesText: "app, OPS, app" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.issueKeyPrefixes).toEqual(["APP", "OPS"]);
    expect(jiraConnectionMetadataSchema.safeParse({ connectionId: "jira-1", ...result.value }).success).toBe(true);
  });

  test("names the field and the offending value", () => {
    const result = validateJiraMetadataDraft({ ...valid, issueKeyPrefixesText: "APP, 9bad", pollSeconds: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.issueKeyPrefixes).toContain("9BAD");
    expect(result.errors.pollSeconds).toContain("60 and 3600");
    expect(result.errors.label).toBeUndefined();
  });
});
