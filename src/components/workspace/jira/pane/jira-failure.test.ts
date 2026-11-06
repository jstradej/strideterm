import { describe, expect, test } from "vitest";
import {
  composeFailureText,
  formatJiraFailureStatus,
  isJiraAccessFailure,
  isSupersededActivation,
  jiraFailureCode,
  jiraFailureReason,
  jiraFailureStatus,
} from "./jira-failure.js";

/** The shape the preload `invokeJira` and the remote transport throw for a Jira failure. */
function desktopFailure(message: string, code: string, retryAfterMs?: number) {
  return Object.assign(new Error(message), {
    code,
    jiraError: { code, ...(retryAfterMs ? { retryAfterMs } : {}) },
  });
}

describe("Jira failure helpers", () => {
  test("read the code and Retry-After from the desktop Error shape", () => {
    const failure = desktopFailure("Throttled.", "rate-limited", 2500);
    expect(jiraFailureCode(failure)).toBe("rate-limited");
    expect(jiraFailureStatus(failure)).toEqual({ code: "rate-limited", retryAfterMs: 2500 });
    expect(formatJiraFailureStatus(jiraFailureStatus(failure)!)).toBe(
      "Jira rate limit reached · Retry after 3 seconds.",
    );
  });

  test("treat access codes in the desktop shape as access failures and leave other codes alone", () => {
    for (const code of ["auth-expired", "permission-denied", "not-found"])
      expect(isJiraAccessFailure(desktopFailure("x", code))).toBe(true);
    expect(isJiraAccessFailure(desktopFailure("x", "rate-limited"))).toBe(false);
    expect(isJiraAccessFailure(new Error("plain"))).toBe(false);
    expect(isJiraAccessFailure("auth-expired")).toBe(false);
  });

  test("the code on a bare IPC rejection is not invented", () => {
    expect(jiraFailureStatus(new Error("Error invoking remote method 'jira:search': Error: boom"))).toBeNull();
  });

  test("strip the IPC wrapper and an error class prefix from the reason", () => {
    expect(jiraFailureReason(new Error("Error invoking remote method 'jira:search': JiraRequestError: Bad JQL"))).toBe(
      "Bad JQL",
    );
    expect(jiraFailureReason(new Error("TypeError: nope"))).toBe("nope");
    expect(jiraFailureReason({ error: "Wrapped reason" })).toBe("Wrapped reason");
    expect(jiraFailureReason(undefined)).toBe("");
  });

  test("put the action first and keep the context alone when there is no reason", () => {
    expect(composeFailureText("Could not load board.", new Error("Offline"))).toBe("Could not load board: Offline");
    expect(composeFailureText("Could not load board", undefined)).toBe("Could not load board.");
    expect(composeFailureText("Could not load board", new Error("Could not load board"))).toBe("Could not load board.");
  });

  test("recognise a superseded activation", () => {
    expect(isSupersededActivation(new Error("View activation was superseded"))).toBe(true);
    expect(isSupersededActivation(new Error("Workspace not found"))).toBe(false);
  });
});
