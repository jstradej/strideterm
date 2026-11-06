import { describe, expect, it } from "vitest";
import {
  DEFAULT_JIRA_COMMENT_ATTRIBUTION,
  applyJiraCommentAttribution,
  normalizeJiraCommentAttribution,
  renderJiraCommentAttribution,
} from "./jira-comment-attribution.js";

const on = { enabled: true, text: "On behalf of {user} via {account}", position: "before" as const };

describe("jira comment attribution", () => {
  it("fills placeholders and keeps unknown ones", () => {
    expect(renderJiraCommentAttribution(on, { user: "Jaromír", account: "bot" })).toBe("On behalf of Jaromír via bot");
    expect(renderJiraCommentAttribution({ ...on, text: "{who} {user}" }, { user: "A" })).toBe("{who} A");
  });

  it("falls back from the own identity to the profile name to nothing", () => {
    expect(renderJiraCommentAttribution(on, { profile: "Work" })).toBe("On behalf of Work via");
    expect(renderJiraCommentAttribution({ ...on, text: "By {user}!" }, {})).toBe("By !");
  });

  it("cleans placeholder values", () => {
    const out = renderJiraCommentAttribution(on, { user: `A\n\u0007B${"x".repeat(300)}`, account: "z" });
    expect(out).not.toContain("\u0007");
    expect(out).not.toMatch(/A\nB/);
    expect(out.length).toBeLessThan(300);
  });

  it("is empty when disabled or the text is blank", () => {
    expect(renderJiraCommentAttribution({ ...on, enabled: false }, {})).toBe("");
    expect(renderJiraCommentAttribution({ ...on, text: "  \u0001 " }, {})).toBe("");
    expect(renderJiraCommentAttribution(undefined, {})).toBe("");
  });

  it("places the text before or after the body", () => {
    expect(applyJiraCommentAttribution("Body", { enabled: true, text: "T", position: "before" }, {})).toBe("T\n\nBody");
    expect(applyJiraCommentAttribution("Body", { enabled: true, text: "T", position: "after" }, {})).toBe("Body\n\nT");
    expect(applyJiraCommentAttribution("Body", { enabled: false, text: "T", position: "after" }, {})).toBe("Body");
  });

  it("normalizes: default for missing or invalid, user value kept, text limited", () => {
    expect(normalizeJiraCommentAttribution(undefined)).toEqual(DEFAULT_JIRA_COMMENT_ATTRIBUTION);
    expect(normalizeJiraCommentAttribution({ enabled: "yes", text: "x", position: "before" })).toEqual(
      DEFAULT_JIRA_COMMENT_ATTRIBUTION,
    );
    expect(normalizeJiraCommentAttribution({ enabled: true, text: "x", position: "middle" })).toEqual(
      DEFAULT_JIRA_COMMENT_ATTRIBUTION,
    );
    expect(normalizeJiraCommentAttribution({ enabled: false, text: "", position: "after" })).toEqual({
      enabled: false,
      text: "",
      position: "after",
    });
    const long = normalizeJiraCommentAttribution({
      enabled: true,
      text: `  a\u0001b\nc${"y".repeat(600)}`,
      position: "before",
    });
    expect(long.text.length).toBeLessThanOrEqual(500);
    expect(long.text.startsWith("ab\nc")).toBe(true);
  });
});
