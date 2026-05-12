import { describe, it, expect, beforeEach } from "vitest";
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
});
