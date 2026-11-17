import { describe, expect, it, vi } from "vitest";
import { buildReviewActivityEvent, buildConnectionErrorEvent } from "../shared/review-activity.js";
import {
  AutomationEventBus,
  AutomationCheckTracker,
  jiraPollToAutomationEvent,
  reviewActivityToAutomationEvent,
} from "./automation-event-bus.js";

describe("automation event bus", () => {
  it("emits completed checks only after a pending state for the same PR head", () => {
    const publish = vi.fn();
    const tracker = new AutomationCheckTracker(publish, Date.parse("2025-12-31T23:59:00Z"));
    const summary = {
      prKey: "c:42",
      profileId: "p",
      connectionId: "c",
      role: "author",
      repository: { fullName: "org/repo" },
      pullRequest: { number: 42, title: "PR", headSha: "sha-1", targetRefName: "refs/heads/main" },
      checks: { items: [{ id: "check:1", name: "CI", state: "pending" }] },
    };
    const at = "2026-01-01T00:00:00.000Z";
    tracker.observe("github", summary, at);
    tracker.observe(
      "github",
      {
        ...summary,
        pullRequest: { ...summary.pullRequest, headSha: "sha-2" },
        checks: { items: [{ id: "check:1", name: "CI", state: "failed" }] },
      },
      at,
    );
    expect(publish).not.toHaveBeenCalled();
    tracker.observe("github", { ...summary, checks: { items: [{ id: "check:1", name: "CI", state: "failed" }] } }, at);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "pr-check-finished",
        pr: expect.objectContaining({ headSha: "sha-1", targetBranch: "main" }),
        check: { checkId: "check:1", name: "CI", result: "failed" },
      }),
    );
    tracker.observe("github", { ...summary, checks: { items: [{ id: "check:1", name: "CI", state: "failed" }] } }, at);
    expect(publish).toHaveBeenCalledOnce();
  });
  it("normalizes Azure PR and check metadata", () => {
    const publish = vi.fn();
    const tracker = new AutomationCheckTracker(publish, Date.parse("2025-12-31T23:59:00Z"));
    const summary = {
      prKey: "ado:42",
      profileId: "p",
      connectionId: "c",
      role: "reviewer",
      repository: { name: "repo" },
      pullRequest: { id: 42, title: "PR", sourceCommitId: "head", isDraft: true },
      checks: { items: [{ id: "policy:1", state: "pending" }] },
    };
    tracker.observe("azure-devops", summary, "2026-01-01T00:00:00Z");
    tracker.observe(
      "azure-devops",
      { ...summary, checks: { items: [{ id: "policy:1", state: "succeeded" }] } },
      "2026-01-01T00:00:01Z",
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "azure-devops",
        pr: expect.objectContaining({ repositoryName: "repo", pullRequestNumber: 42, headSha: "head", draft: true }),
      }),
    );
  });
  it("seeds check state during the startup grace period without sending events", () => {
    const publish = vi.fn();
    const tracker = new AutomationCheckTracker(publish, Date.parse("2026-01-01T00:00:00Z"));
    const summary = {
      prKey: "c:42",
      profileId: "p",
      connectionId: "c",
      role: "author",
      repository: { fullName: "org/repo" },
      pullRequest: { number: 42, headSha: "sha" },
      checks: { items: [{ id: "ci", state: "pending" }] },
    };
    tracker.observe("github", summary, "2026-01-01T00:00:01Z");
    tracker.observe(
      "github",
      { ...summary, checks: { items: [{ id: "ci", state: "failed" }] } },
      "2026-01-01T00:00:02Z",
    );
    tracker.observe(
      "github",
      { ...summary, checks: { items: [{ id: "ci", state: "failed" }] } },
      "2026-01-01T00:00:11Z",
    );
    expect(publish).not.toHaveBeenCalled();
  });
  it("uses detection time, retains metadata and excludes comment content", () => {
    const event = buildReviewActivityEvent({
      provider: "github",
      summary: {
        prKey: "connection:42",
        connectionId: "connection",
        profileId: "p",
        role: "reviewer",
        repository: { fullName: "org/repo" },
        pullRequest: { number: 42, title: "Example", targetRefName: "main", headSha: "abc" },
      },
      kind: "pr-new-comment",
      at: "2026-01-01T00:00:00Z",
      title: "title",
      body: "private comment",
    });
    const result = reviewActivityToAutomationEvent(event, "2026-01-02T00:00:00Z");
    expect(result).toMatchObject({
      detectedAt: "2026-01-02T00:00:00Z",
      profileId: "p",
      pr: { targetBranch: "main", headSha: "abc" },
    });
    expect(JSON.stringify(result)).not.toContain("private comment");
  });
  it("does not forward connection failures and supports unsubscribe", () => {
    const error = buildConnectionErrorEvent({
      provider: "github",
      connection: { id: "x" },
      prevState: null,
      currentStatus: "error",
      currentError: "failure",
      at: "2026-01-01T00:00:00Z",
    });
    expect(error && reviewActivityToAutomationEvent(error, "2026-01-01T00:00:00Z")).toBeNull();
    const bus = new AutomationEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();
    if (error) bus.publishReviewActivity([error], "2026-01-01T00:00:00Z");
    expect(listener).not.toHaveBeenCalled();
  });
  it("maps Jira poll notifications without issue content", () => {
    const notification = {
      profileId: "p",
      connectionId: "c",
      queryId: "q",
      eventId: "e",
      type: "changed" as const,
      issueId: "12",
      issueKey: "PRJ-12",
      observedAt: Date.parse("2026-01-01T00:00:00Z"),
    };
    expect(jiraPollToAutomationEvent(notification)).toEqual({
      id: "e",
      detectedAt: "2026-01-01T00:00:00.000Z",
      source: "jira",
      kind: "jira-issue-changed",
      profileId: "p",
      connectionId: "c",
      jira: { issueId: "12", issueKey: "PRJ-12", queryId: "q" },
    });
  });
});
