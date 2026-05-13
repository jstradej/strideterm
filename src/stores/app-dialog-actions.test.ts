import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref, shallowRef } from "vue";
import { createDialogActions } from "./app-dialog-actions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makeCtx(payloadValue: AnyApi) {
  return {
    overlay: ref<string | null>(null),
    overlayProps: ref<Record<string, unknown>>({}),
    contextMenu: ref(null),
    layoutPickerAnchor: ref(null),
    layoutPickerMode: ref("grid"),
    payload: shallowRef(payloadValue),
    activeViewId: ref<string | null>(null),
    activeSessionId: ref<string | null>(null),
    splitGroup: ref(null),
    suppressBroadcast: ref(false),
    hiddenViewIds: ref(new Set<string>()),
    getApi: () => ({}),
    withSuppressedBroadcast: async (fn: () => Promise<void>) => fn(),
    getPanelByViewId: () => null,
    createWorktree: async () => undefined,
    quickAddTemplateTab: async () => undefined,
  } as AnyApi;
}

describe("createDialogActions.openProfilesDialog", () => {
  beforeEach(() => {
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-a" } };
  });

  it("marks this window's slot profile active instead of the global last-active profile", () => {
    const ctx = makeCtx({
      appState: {
        activeProfileId: "profile-b",
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [],
        windowSlots: [
          { id: "win-a", profileId: "profile-a", activeWorkspaceId: "ws-a" },
          { id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" },
        ],
      },
    });
    const actions = createDialogActions(ctx);

    actions.openProfilesDialog();

    expect(ctx.overlay.value).toBe("ProfilesDialog");
    expect(ctx.overlayProps.value.activeProfileId).toBe("profile-a");
  });

  it("uses the first real profile as active in remote mode when remoteClient is absent", () => {
    const ctx = makeCtx({
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [],
        windowSlots: [{ id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" }],
      },
    });
    ctx.getApi = () => ({ isRemote: true });
    const actions = createDialogActions(ctx);

    actions.openProfilesDialog();

    expect(ctx.overlay.value).toBe("ProfilesDialog");
    expect(ctx.overlayProps.value.activeProfileId).toBe("profile-a");
  });

  it("uses the first real profile as active in remote mode when remoteClient profile is stale", () => {
    const ctx = makeCtx({
      remoteClient: { id: "session-a", profileId: "deleted-profile", activeWorkspaceId: "", activeSessionId: "" },
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [],
        windowSlots: [{ id: "win-b", profileId: "profile-b", activeWorkspaceId: "ws-b" }],
      },
    });
    ctx.getApi = () => ({ isRemote: true });
    const actions = createDialogActions(ctx);

    actions.openProfilesDialog();

    expect(ctx.overlay.value).toBe("ProfilesDialog");
    expect(ctx.overlayProps.value.activeProfileId).toBe("profile-a");
  });

  it("optimistically scopes remote profile activation to the browser client", async () => {
    let resolveActivate: (value: unknown) => void = () => undefined;
    const activateProfile = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveActivate = resolve;
        }),
    );
    const ctx = makeCtx({
      remoteClient: { id: "session-a", profileId: "profile-a", activeWorkspaceId: "ws-a", activeSessionId: "ws-a:p1" },
      appState: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        workspaces: [
          { id: "ws-a", profileId: "profile-a", panels: [] },
          { id: "ws-b", profileId: "profile-b", panels: [] },
        ],
        windowSlots: [{ id: "win-a", profileId: "profile-a", activeWorkspaceId: "ws-a" }],
      },
    });
    ctx.getApi = () => ({ isRemote: true, activateProfile });
    const actions = createDialogActions(ctx);

    actions.openProfilesDialog();
    const activation = (ctx.overlayProps.value.onActivate as (profileId: string) => Promise<void>)("profile-b");

    expect(ctx.payload.value.remoteClient).toMatchObject({
      profileId: "profile-b",
      activeWorkspaceId: "ws-b",
      activeSessionId: "",
    });

    const serverPayload = {
      ...ctx.payload.value,
      remoteClient: { id: "session-a", profileId: "profile-b", activeWorkspaceId: "ws-b", activeSessionId: "" },
    };
    resolveActivate(serverPayload);
    await activation;

    expect(activateProfile).toHaveBeenCalledWith("profile-b");
    expect(ctx.overlay.value).toBeNull();
  });
});
