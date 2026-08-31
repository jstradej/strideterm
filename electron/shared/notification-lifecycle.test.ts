import { describe, expect, test } from "vitest";
import { notificationTargetRemovedSchema } from "./notification-lifecycle.js";

describe("notificationTargetRemovedSchema", () => {
  test("accepts a workspace removal", () => {
    const parsed = notificationTargetRemovedSchema.parse({
      target: "workspace",
      workspaceId: "ws-1",
      profileId: "default",
    });
    expect(parsed).toEqual({ target: "workspace", workspaceId: "ws-1", profileId: "default" });
  });

  test("accepts a view removal", () => {
    const parsed = notificationTargetRemovedSchema.parse({
      target: "view",
      workspaceId: "ws-1",
      viewId: "ws-1:panel-a",
      profileId: "work",
    });
    expect(parsed).toEqual({
      target: "view",
      workspaceId: "ws-1",
      viewId: "ws-1:panel-a",
      profileId: "work",
    });
  });

  test("rejects an unknown target", () => {
    expect(
      notificationTargetRemovedSchema.safeParse({ target: "panel", workspaceId: "ws-1", profileId: "default" }).success,
    ).toBe(false);
  });

  test("rejects a view removal missing its viewId", () => {
    expect(
      notificationTargetRemovedSchema.safeParse({ target: "view", workspaceId: "ws-1", profileId: "default" }).success,
    ).toBe(false);
  });

  // Empty identifiers are the dangerous case, not merely absent ones: an empty
  // workspaceId would match nothing (or, on a sloppier receiver, everything),
  // and an empty profileId would silently route a removal to the wrong viewer.
  test("rejects empty identifiers", () => {
    for (const bad of [
      { target: "workspace", workspaceId: "", profileId: "default" },
      { target: "workspace", workspaceId: "ws-1", profileId: "" },
      { target: "view", workspaceId: "ws-1", viewId: "", profileId: "default" },
    ]) {
      expect(notificationTargetRemovedSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("rejects extra fields", () => {
    expect(
      notificationTargetRemovedSchema.safeParse({
        target: "workspace",
        workspaceId: "ws-1",
        profileId: "default",
        viewId: "ws-1:panel-a",
      }).success,
    ).toBe(false);
  });

  test("rejects a non-object payload", () => {
    for (const bad of [null, undefined, "workspace", 3, []]) {
      expect(notificationTargetRemovedSchema.safeParse(bad).success).toBe(false);
    }
  });
});
