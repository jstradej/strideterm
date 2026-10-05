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
});
