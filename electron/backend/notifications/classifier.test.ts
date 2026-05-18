import { describe, expect, test } from "vitest";
import { classifyHookEvent } from "./classifier.js";

describe("classifyHookEvent — Notification hook", () => {
  test("permission_prompt → user-facing, T1, urgent, waiting", () => {
    expect(classifyHookEvent("Notification", "permission_prompt")).toEqual({
      userFacing: true,
      tier: 1,
      urgency: "urgent",
      kind: "waiting",
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

  test("elicitation_dialog → user-facing, T1, normal, waiting", () => {
    expect(classifyHookEvent("Notification", "elicitation_dialog")).toMatchObject({
      userFacing: true,
      urgency: "normal",
    });
  });

  test("auth_success → system-only (log)", () => {
    expect(classifyHookEvent("Notification", "auth_success")).toEqual({ userFacing: false });
  });

  test("empty subtype defaults to normal idle", () => {
    expect(classifyHookEvent("Notification", "")).toMatchObject({
      userFacing: true,
      tier: 1,
      urgency: "normal",
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
  test("SubagentStop → user-facing, T1, normal, subagent_done", () => {
    expect(classifyHookEvent("SubagentStop")).toMatchObject({
      userFacing: true,
      tier: 1,
      urgency: "normal",
      kind: "subagent_done",
    });
  });

  test("SubagentStop kind is distinct from completed (so users can filter independently)", () => {
    const sub = classifyHookEvent("SubagentStop");
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
