import { describe, expect, test } from "vitest";
import { buildExternalNotificationEvent } from "./external-notification-event.js";

describe("buildExternalNotificationEvent", () => {
  test("waiting alerts are high priority with reply actions", () => {
    const event = buildExternalNotificationEvent({
      eventId: "evt-1",
      profileId: "default",
      workspaceId: "ws-1",
      sessionId: "ws-1:shell",
      panelId: "shell",
      kind: "waiting",
      urgency: "normal",
      title: "Waiting for input",
      detail: "hook:Notification:idle_prompt",
      createdAt: 1_000,
    });

    expect(event).toMatchObject({
      eventId: "evt-1",
      profileId: "default",
      workspaceId: "ws-1",
      sessionId: "ws-1:shell",
      panelId: "shell",
      kind: "waiting",
      priority: "high",
      dedupeKey: "ws-1:ws-1:shell:waiting",
      collapseKey: null,
      createdAt: 1_000,
    });
    expect(event.actions).toEqual(["task.sendInstruction", "task.pause", "notification.acknowledge"]);
  });

  test("urgent urgency always maps to high priority regardless of kind", () => {
    const event = buildExternalNotificationEvent({
      eventId: "evt-2",
      profileId: "default",
      workspaceId: "ws-1",
      kind: "pipeline",
      urgency: "urgent",
      title: "Check failed",
    });
    expect(event.priority).toBe("high");
    expect(event.collapseKey).toBeNull();
  });

  test("info and subagent_done kinds are low priority and collapse", () => {
    const info = buildExternalNotificationEvent({
      eventId: "evt-3",
      profileId: "default",
      workspaceId: "ws-1",
      panelId: "shell",
      kind: "info",
      title: "Info",
    });
    expect(info.priority).toBe("low");
    expect(info.collapseKey).toBe(info.dedupeKey);

    const subagent = buildExternalNotificationEvent({
      eventId: "evt-4",
      profileId: "default",
      workspaceId: "ws-1",
      panelId: "shell",
      kind: "subagent_done",
      title: "Subagent done",
    });
    expect(subagent.priority).toBe("low");
    expect(subagent.collapseKey).toBe(subagent.dedupeKey);
  });

  test("completed/review/pipeline (non-urgent) are normal priority, no collapse, acknowledge-only", () => {
    for (const kind of ["completed", "review", "pipeline"]) {
      const event = buildExternalNotificationEvent({
        eventId: `evt-${kind}`,
        profileId: "default",
        workspaceId: "ws-1",
        kind,
        title: kind,
      });
      expect(event.priority).toBe("normal");
      expect(event.collapseKey).toBeNull();
      expect(event.actions).toEqual(["notification.acknowledge"]);
    }
  });

  test("only ready PR review notifications offer the basic-review action", () => {
    const base = { eventId: "pr", profileId: "p1", workspaceId: "ws", kind: "review", title: "PR review" };
    expect(
      buildExternalNotificationEvent({
        ...base,
        provider: "github",
        prKey: "repo#42",
        draftState: "ready",
      }).actions,
    ).toEqual(["review.start", "notification.acknowledge"]);
    expect(
      buildExternalNotificationEvent({
        ...base,
        provider: "github",
        prKey: "repo#42",
        draftState: "draft",
      }).actions,
    ).toEqual(["notification.acknowledge"]);
    expect(
      buildExternalNotificationEvent({
        ...base,
        provider: "github",
        prKey: "repo#42",
        draftState: "ready",
        reviewStatus: "started",
        operationId: "op-1",
      }).actions,
    ).toEqual(["notification.acknowledge"]);
    expect(buildExternalNotificationEvent({ ...base, draftState: "ready" }).actions).toEqual([
      "notification.acknowledge",
    ]);
  });

  test("defaults profileId to 'default' and kind to 'info' when omitted", () => {
    const event = buildExternalNotificationEvent({
      eventId: "evt-5",
      profileId: "",
      workspaceId: "ws-1",
      kind: "",
      title: "x",
    });
    expect(event.profileId).toBe("default");
    expect(event.kind).toBe("info");
    expect(event.priority).toBe("low");
  });

  test("preserves mobile display context and omits absent exit codes", () => {
    const event = buildExternalNotificationEvent({
      eventId: "evt-context",
      profileId: "p1",
      workspaceId: "ws-1",
      sessionId: "ws-1:panel-1",
      panelId: "panel-1",
      kind: "completed",
      title: "Shell",
      detail: "Command finished\n\nRecent terminal output:\npassed",
      workspaceName: "api",
      taskId: "task-42",
      tab: "Tests",
      activity: "pnpm test",
      exitCode: 0,
      durationMs: 12_345,
    });

    expect(event).toMatchObject({
      workspaceName: "api",
      taskId: "task-42",
      tab: "Tests",
      activity: "pnpm test",
      exitCode: 0,
      durationMs: 12_345,
    });
    expect(
      buildExternalNotificationEvent({
        eventId: "evt-no-exit",
        profileId: "p1",
        workspaceId: "ws-1",
        kind: "waiting",
        title: "Shell",
      }),
    ).not.toHaveProperty("exitCode");
  });

  test("sanitizes terminal control reports from activity before truncation", () => {
    const event = buildExternalNotificationEvent({
      eventId: "evt-terminal-activity",
      profileId: "p1",
      workspaceId: "ws-1",
      kind: "completed",
      title: "Agent finished",
      activity: "[<35;52;28M[<0;75;55M[<0;75;55m [I/O] make test",
    });

    expect(event.activity).toBe("[I/O] make test");
  });

  test("normalizes derived review, pipeline, and review-start IDs deterministically", () => {
    const sourceIds = [
      "azure:org/project:repo:pull-request:42:pr-new:2026-10-19T12:34:56.789Z",
      "github:owner/repo#42:review:ready",
      "pipeline:project:build:run-42:2026-10-19T12:34:56.789Z",
      "review-start:ws-1:operation:op-42:accepted",
    ];
    const normalize = (eventId: string) =>
      buildExternalNotificationEvent({
        eventId,
        profileId: "default",
        workspaceId: "ws-1",
        kind: "review",
        title: "Review",
      }).eventId;

    const normalized = sourceIds.map(normalize);
    expect(normalized).toHaveLength(sourceIds.length);
    expect(new Set(normalized).size).toBe(sourceIds.length);
    expect(normalized).toEqual(sourceIds.map(normalize));
    expect(normalized.every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))).toBe(true);
  });

  test("preserves valid boundary IDs and hashes overlength or invalid IDs without sanitization collisions", () => {
    const normalize = (eventId: string) =>
      buildExternalNotificationEvent({
        eventId,
        profileId: "default",
        workspaceId: "ws-1",
        kind: "pipeline",
        title: "Pipeline",
      }).eventId;
    const atLimit = `A${"_".repeat(127)}`;
    const overLimit = `${atLimit}x`;

    expect(normalize(atLimit)).toBe(atLimit);
    expect(normalize(overLimit)).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(normalize(overLimit)).not.toBe(atLimit);
    expect(normalize("review:ready")).not.toBe(normalize("review.ready"));
  });

  test("hashes every opaque ID outside the protocol safe alphabet", () => {
    const normalize = (eventId: string) =>
      buildExternalNotificationEvent({
        eventId,
        profileId: "default",
        workspaceId: "ws-1",
        kind: "pipeline",
        title: "Pipeline",
      }).eventId;
    const invalidIds = [
      "colon:id",
      "dot.id",
      "slash/id",
      "back\\slash",
      "hash#id",
      "dollar$id",
      "left[id",
      "right]id",
      "space id",
      "line\nfeed",
      "carriage\rreturn",
      "tab\tid",
      "nul\0id",
      "del\u007fid",
      "café",
      "emoji-😀",
      "",
      "x".repeat(129),
    ];

    for (const sourceId of invalidIds) {
      expect(normalize(sourceId), JSON.stringify(sourceId)).toMatch(/^evt-[0-9a-f]{64}$/);
    }
    expect(normalize("Az09_-")).toBe("Az09_-");
  });
});
