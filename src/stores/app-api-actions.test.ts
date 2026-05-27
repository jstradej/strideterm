import { describe, expect, it, beforeEach } from "vitest";
import { ref, shallowRef } from "vue";
import { createApiActions } from "./app-api-actions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makeCtx(payloadValue: AnyApi) {
  return {
    payload: shallowRef(payloadValue),
    activeViewId: ref<string | null>(null),
    activeSessionId: ref<string | null>(null),
    splitGroup: ref(null),
    remoteAccessMode: ref("lan"),
    selectedLanUrl: ref(""),
    getApi: () => ({ isRemote: false }),
    withSuppressedBroadcast: async (fn: () => Promise<void>) => fn(),
    confirmInApp: async () => true,
  } as AnyApi;
}

describe("createApiActions.getRemoteShareUrl", () => {
  beforeEach(() => {
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-b" } };
  });

  it("includes this desktop window's profile context in generated remote URLs", () => {
    const ctx = makeCtx({
      remoteAccess: {
        urls: ["http://192.168.1.20:7333"],
        tunnel: { publicUrl: "" },
      },
      appState: {
        settings: {
          remoteAccess: {
            token: "remote-token",
            customPublicUrl: "",
          },
        },
        windowSlots: [
          { id: "win-a", profileId: "profile-a" },
          { id: "win-b", profileId: "profile-b" },
        ],
      },
    });
    const actions = createApiActions(ctx);

    expect(actions.getRemoteShareUrl()).toBe("http://192.168.1.20:7333/?token=remote-token&profileId=profile-b");
  });
});
