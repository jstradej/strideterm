import { describe, expect, test } from "vitest";
import { classifyHookEvent } from "./classifier.js";

describe("classifyHookEvent — Notification hook", () => {
  test("permission_prompt → user-facing, T1, urgent, question", () => {
    expect(classifyHookEvent("Notification", "permission_prompt")).toEqual({
      userFacing: true,
      tier: 1,
      urgency: "urgent",
      kind: "question",
      detail: "hook:Notification:permission_prompt",
    });
  });

  test("idle_prompt → user-facing, T1, normal, waiting", () => {
    expect(classifyHookEvent("Notification", "idle_prompt")).toEqual({
      userFacing: true,
      tier: 1,
      urgency: "normal",
      kind: "waiting",
      detail: "hook:Notification:idle_prompt",
    });
  });

  test.each(["elicitation_dialog", "elicitation_url_dialog"])("%s → question, normal urgency", (subtype) => {
    expect(classifyHookEvent("Notification", subtype)).toEqual({
      userFacing: true,
      tier: 1,
      urgency: "normal",
      kind: "question",
      detail: `hook:Notification:${subtype}`,
    });
  });

  test("agent_needs_input → question, normal urgency", () => {
    expect(classifyHookEvent("Notification", "agent_needs_input")).toEqual({
      userFacing: true,
      tier: 1,
      urgency: "normal",
      kind: "question",
      detail: "hook:Notification:agent_needs_input",
    });
  });

  test("a blocking question is never classified as plain waiting", () => {
    for (const subtype of ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]) {
      expect(classifyHookEvent("Notification", subtype).kind).toBe("question");
    }
    // idle_prompt is the only "waiting" left: the agent stopped talking, but
    // it is not asking anything.
    expect(classifyHookEvent("Notification", "idle_prompt").kind).toBe("waiting");
  });

  test("auth_success → system-only (log)", () => {
    expect(classifyHookEvent("Notification", "auth_success")).toEqual({ userFacing: false });
  });

  test.each([
    "agent_completed",
    "elicitation_complete",
    "elicitation_response",
    "quota_auto_resume_fired",
    "quota_auto_resume_stale",
    "quota_auto_resume_disabled",
  ])("%s stays system-only (documented subtype we deliberately don't alert on)", (subtype) => {
    expect(classifyHookEvent("Notification", subtype)).toEqual({ userFacing: false });
  });

  test("empty subtype defaults to normal idle waiting", () => {
    expect(classifyHookEvent("Notification", "")).toMatchObject({
      userFacing: true,
      tier: 1,
      urgency: "normal",
      kind: "waiting",
    });
  });

  test("unknown subtype is system-only (prevents noise)", () => {
    expect(classifyHookEvent("Notification", "some_future_type")).toEqual({ userFacing: false });
  });
});

describe("classifyHookEvent — Stop hook", () => {
  test("Stop → user-facing, T1, normal, completed (dispatcher gates task workspaces)", () => {
    expect(classifyHookEvent("Stop")).toMatchObject({
      userFacing: true,
      tier: 1,
      urgency: "normal",
      kind: "completed",
    });
  });
});

describe("classifyHookEvent — SubagentStop", () => {
  test("SubagentStop → system-only by default (sub-agent pings are opt-in)", () => {
    expect(classifyHookEvent("SubagentStop")).toEqual({ userFacing: false });
    expect(classifyHookEvent("SubagentStop", "", {})).toEqual({ userFacing: false });
    expect(classifyHookEvent("SubagentStop", "", { subagentCompletion: false })).toEqual({ userFacing: false });
  });

  test("SubagentStop → user-facing, T1, normal, subagent_done when opted in", () => {
    expect(classifyHookEvent("SubagentStop", "", { subagentCompletion: true })).toMatchObject({
      userFacing: true,
      tier: 1,
      urgency: "normal",
      kind: "subagent_done",
    });
  });

  test("opted-in SubagentStop kind is distinct from completed (so users can filter independently)", () => {
    const sub = classifyHookEvent("SubagentStop", "", { subagentCompletion: true });
    const stop = classifyHookEvent("Stop");
    expect(sub.kind).not.toBe(stop.kind);
  });
});

describe("classifyHookEvent — UserPromptSubmit", () => {
  test("UserPromptSubmit → system-only (side-effect hook)", () => {
    expect(classifyHookEvent("UserPromptSubmit")).toEqual({ userFacing: false });
  });
});

describe("classifyHookEvent — unconfigured volume hooks", () => {
  test.each(["PreToolUse", "PostToolUse", "PreCompact"])("%s → system-only", (hook) => {
    expect(classifyHookEvent(hook)).toEqual({ userFacing: false });
  });
});

describe("classifyHookEvent — unknown hook names", () => {
  test("PermissionRequest → system-only (the alert is raised from the later permission_prompt)", () => {
    // Deliberate: another hook of the user's (or our own auto-approve) may
    // resolve the request instantly, and alerting from PermissionRequest would
    // then pop a question nobody ever had to answer.
    expect(classifyHookEvent("PermissionRequest")).toEqual({ userFacing: false });
  });

  test("unknown hook → system-only", () => {
    expect(classifyHookEvent("SomeFutureHook")).toEqual({ userFacing: false });
    expect(classifyHookEvent("")).toEqual({ userFacing: false });
    expect(classifyHookEvent(null)).toEqual({ userFacing: false });
    expect(classifyHookEvent(undefined)).toEqual({ userFacing: false });
  });
});

describe("classifyHookEvent — defensive coercion", () => {
  test("whitespace in hook / subtype is trimmed", () => {
    expect(classifyHookEvent("  Notification  ", "  idle_prompt  ")).toMatchObject({
      userFacing: true,
      urgency: "normal",
    });
  });

  test("non-string args are coerced", () => {
    expect(classifyHookEvent(123)).toEqual({ userFacing: false });
    expect(classifyHookEvent("Notification", { obj: 1 })).toEqual({ userFacing: false });
  });
});
