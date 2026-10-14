/**
 * A request the desktop REFUSES while the connection is fine, inside the native app.
 *
 * Such a refusal used to report `connected:false`, which was misleading (the phone showed
 * "reconnecting" and dropped the terminal's readiness). It now goes to the banner instead — and the
 * banner is not rendered inside the native app (WorkspaceHero.vue: `v-if="isRemote && !isNativeMobile
 * && …"`). So there the refusal must surface on its own, or an action whose caller shows no toast would
 * end in silence. The real remote transport and the real app store; the 403 body is the one the
 * desktop's mobile route gate answers with (remote-server.ts `evaluateMobileSessionRequest`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createRemoteTransport } from "./transport.js";
import { useAppStore } from "./stores/app.js";
import { useNotificationStore } from "./stores/notifications.js";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  constructor(readonly url: string) {}
  addEventListener() {}
  send() {}
  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

const REFUSAL = JSON.stringify({ error: "Not available to a mobile session", reason: "profile" });

function serverState() {
  return {
    remoteClient: {
      id: "client-1",
      profileId: "p1",
      activeWorkspaceId: "ws1",
      activeSessionId: "",
      workspaceGrid: null,
    },
    appState: {
      profiles: [{ id: "p1", name: "P1", color: "#fff", workspaceIds: [] }],
      workspaces: [{ id: "ws1", name: "One", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" }],
      settings: {},
    },
  };
}

describe("a refused user action inside the native app", () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let originalFetch: typeof globalThis.fetch;
  let posted: string[];

  beforeEach(() => {
    setActivePinia(createPinia());
    posted = [];
    originalWebSocket = globalThis.WebSocket;
    originalFetch = globalThis.fetch;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("/api/remote-client/profile/activate")
        ? ({ ok: false, status: 403, text: async () => REFUSAL } as Response)
        : ({ ok: true, status: 200, json: async () => serverState() } as Response),
    );
  });

  afterEach(() => {
    (window as unknown as Record<string, { suspend?: () => void } | undefined>).__stridetermRemote?.suspend?.();
    delete (window as unknown as Record<string, unknown>).StridetermHost;
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  });

  async function openApp() {
    const transport = createRemoteTransport();
    const store = useAppStore();
    store.init(transport);
    await vi.waitFor(() => expect(store.payload).toBeTruthy());
    return store;
  }

  test("is shown as a toast, without telling the app the connection dropped", async () => {
    (window as unknown as Record<string, unknown>).StridetermHost = { postMessage: (m: string) => posted.push(m) };
    const store = await openApp();
    const notifications = useNotificationStore();

    // A caller that shows nothing of its own.
    await store.activateProfile("p2").catch(() => {});

    expect(notifications.persistentToasts).toEqual([
      expect.objectContaining({
        kind: "error",
        title: "Not available to a mobile session",
        body: expect.stringContaining("Check the pairing on the desktop"),
      }),
    ]);
    const connectionStates = posted.map((raw) => JSON.parse(raw)).filter((m) => m.type === "connection-state");
    expect(connectionStates.some((m) => m.connected === false)).toBe(false);

    // The same refusal again a moment later: still one toast on screen.
    await store.activateProfile("p2").catch(() => {});
    expect(notifications.persistentToasts).toHaveLength(1);
  });

  test("in a browser tab the banner carries it, so no toast is added", async () => {
    const store = await openApp();
    await store.activateProfile("p2").catch(() => {});
    expect(store.remoteConnectionIssue).toBe("Not available to a mobile session");
    expect(useNotificationStore().persistentToasts).toEqual([]);
  });
});
