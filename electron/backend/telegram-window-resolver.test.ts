import { describe, expect, test } from "vitest";
import { resolveTelegramWindow } from "./telegram-window-resolver.js";

const slots = [
  { id: "win-1", profileId: "work", activeWorkspaceId: "ws-a", activeSessionId: "ws-a:shell", lastFocusedAt: 1_000 },
  { id: "win-2", profileId: "work", activeWorkspaceId: "ws-b", activeSessionId: "", lastFocusedAt: 3_000 },
  { id: "win-3", profileId: "personal", activeWorkspaceId: "ws-p", activeSessionId: "", lastFocusedAt: 2_000 },
];

describe("resolveTelegramWindow", () => {
  test("explicit windowId wins over everything", () => {
    const resolution = resolveTelegramWindow(
      { windowId: "win-explicit", profileId: "work", workspaceId: "ws-b" },
      slots,
    );
    expect(resolution).toEqual({ windowId: "win-explicit", reason: "explicit-window" });
  });

  test("runtime-only command resolves to no-window-required (never opens a window)", () => {
    const resolution = resolveTelegramWindow({ profileId: "work", requiresDesktopWindow: false }, []);
    expect(resolution.reason).toBe("no-window-required");
    expect(resolution.windowId).toBeUndefined();
  });

  test("no profileId resolves to no-window-required (legacy primary-window fallback)", () => {
    expect(resolveTelegramWindow({}, slots).reason).toBe("no-window-required");
  });

  test("workspace-visible wins over last-focused", () => {
    // win-2 is last-focused, but win-1 already shows ws-a.
    const resolution = resolveTelegramWindow({ profileId: "work", workspaceId: "ws-a" }, slots);
    expect(resolution.windowId).toBe("win-1");
    expect(resolution.reason).toBe("workspace-visible");
  });

  test("session-visible wins as well", () => {
    const resolution = resolveTelegramWindow({ profileId: "work", sessionId: "ws-a:shell" }, slots);
    expect(resolution.windowId).toBe("win-1");
    expect(resolution.reason).toBe("workspace-visible");
  });

  test("last-focused wins for targeted actions when the workspace is not visible (open review)", () => {
    const resolution = resolveTelegramWindow({ profileId: "work", workspaceId: "ws-hidden" }, slots);
    expect(resolution.windowId).toBe("win-2");
    expect(resolution.reason).toBe("last-focused-profile-window");
    expect(resolution.candidates).toHaveLength(2);
  });

  test("single profile window is used directly", () => {
    const resolution = resolveTelegramWindow({ profileId: "personal" }, slots);
    expect(resolution.windowId).toBe("win-3");
    expect(resolution.reason).toBe("only-profile-window");
  });

  test("screenshot-current with multiple windows returns needs-user-choice with candidates", () => {
    const resolution = resolveTelegramWindow({ profileId: "work", requireExplicitWindowWhenAmbiguous: true }, slots);
    expect(resolution.reason).toBe("needs-user-choice");
    expect(resolution.windowId).toBeUndefined();
    expect(resolution.candidates?.map((c) => c.windowId)).toEqual(["win-1", "win-2"]);
  });

  test("no window + allowCreateWindow returns needs-new-window (workspace screenshot / open review)", () => {
    const resolution = resolveTelegramWindow({ profileId: "closed-profile", allowCreateWindow: true }, slots);
    expect(resolution.reason).toBe("needs-new-window");
    expect(resolution.candidates).toEqual([]);
  });

  test("no window without allowCreateWindow returns needs-user-choice with empty candidates (screenshot current)", () => {
    const resolution = resolveTelegramWindow(
      { profileId: "closed-profile", requireExplicitWindowWhenAmbiguous: true },
      slots,
    );
    expect(resolution.reason).toBe("needs-user-choice");
    expect(resolution.candidates).toEqual([]);
  });

  test("'default' profileId matches slots without an explicit profileId", () => {
    const resolution = resolveTelegramWindow({ profileId: "default" }, [
      { id: "win-x" },
      { id: "win-y", profileId: "default" },
    ]);
    // Both match "default"; ambiguity without targeting falls to last-focused
    // (both lastFocusedAt undefined → first after stable sort).
    expect(resolution.candidates).toHaveLength(2);
    expect(resolution.reason).toBe("last-focused-profile-window");
  });

  test("empty-string profileId is treated as missing, not 'default'", () => {
    const resolution = resolveTelegramWindow({ profileId: "" }, [{ id: "win-y", profileId: "default" }]);
    expect(resolution.reason).toBe("no-window-required");
  });

  test("preferVisibleWorkspace=false skips the visibility shortcut", () => {
    const resolution = resolveTelegramWindow(
      { profileId: "work", workspaceId: "ws-a", preferVisibleWorkspace: false },
      slots,
    );
    expect(resolution.windowId).toBe("win-2");
    expect(resolution.reason).toBe("last-focused-profile-window");
  });
});
