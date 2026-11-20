import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import MobileInputBar from "./components/layout/MobileInputBar.vue";
import ProfileBar from "./components/layout/ProfileBar.vue";
import DockerDetailSubTabs from "./components/workspace/docker/DockerDetailSubTabs.vue";
import { usePeerWindowAttention } from "./composables/usePeerWindowAttention.js";
import { isWebClient } from "./lib/client-kind.js";
import { useAppStore } from "./stores/app.js";
import { apiKey } from "./types/keys.js";
import { isPeerWindow, setWindowBackend } from "./window-backend.js";
import type { WindowBackend } from "../electron/shared/peers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const backend: Extract<WindowBackend, { kind: "peer" }> = {
  kind: "peer",
  hostId: "host-0001",
  hostLabel: "Studio Mac",
  remoteProfileId: "work",
  clientId: "peer-window-0001",
  terminalFontSize: 13,
};

const SESSION_ID = "ws-a:panel-shell";

function seedStore(): void {
  const store = useAppStore();
  store.activeViewId = SESSION_ID;
  store.activeSessionId = SESSION_ID;
  store.payload = {
    appState: {
      activeWorkspaceId: "ws-a",
      workspaces: [],
      profiles: [{ id: "work", name: "Work", color: "#ffa424" }],
      windowSlots: [],
      settings: {},
    },
    remoteClient: { profileId: "work" },
    workspace: {
      workspace: { id: "ws-a", panels: [] },
      sessions: [{ sessionId: SESSION_ID, panelId: "panel-shell", title: "Shell" }],
    },
  } as AnyApi;
}

describe("a window attached to another desktop", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    window.sessionStorage.clear();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
    delete (window as AnyApi).StridetermHost;
  });
  afterEach(() => {
    setWindowBackend({ kind: "local" });
    delete (window as AnyApi).strideterm;
    vi.useRealTimers();
  });

  describe("client kind", () => {
    it("is a web client only for a remote transport without a native shell", () => {
      expect(isWebClient({ isRemote: true, hasNativeShell: false })).toBe(true);
      expect(isWebClient({ isRemote: true })).toBe(true);
      expect(isWebClient({ isRemote: true, hasNativeShell: true })).toBe(false);
      expect(isWebClient({ isRemote: false, hasNativeShell: true })).toBe(false);
      expect(isWebClient(undefined)).toBe(false);
    });
  });

  describe("mobile input bar", () => {
    function mountBar(api: AnyApi) {
      seedStore();
      return mount(MobileInputBar, { global: { provide: { [apiKey]: api } } });
    }

    it("is shown for a web or phone client", () => {
      const wrapper = mountBar({ isRemote: true, hasNativeShell: false, writeTerminal: vi.fn() });
      expect(wrapper.find(".mobile-input-bar").exists()).toBe(true);
    });

    it("is not shown in a peer window, which is remote but has a keyboard of its own", () => {
      setWindowBackend(backend);
      const wrapper = mountBar({ isRemote: true, hasNativeShell: true, writeTerminal: vi.fn() });
      expect(wrapper.find(".mobile-input-bar").exists()).toBe(false);
    });
  });

  describe("profile bar", () => {
    function mountProfileBar() {
      seedStore();
      const store = useAppStore();
      store.isRemoteTransport = true;
      return mount(ProfileBar, { global: { provide: { [apiKey]: { isRemote: true } } } });
    }

    it("shows the host as a badge instead of the generic Remote badge", async () => {
      setWindowBackend(backend);
      const wrapper = mountProfileBar();
      await nextTick();

      const badge = wrapper.get('[data-testid="profile-bar-host-badge"]');
      expect(badge.text()).toBe("Studio Mac");
      expect(badge.attributes("title")).toBe(
        "This window shows a profile of Studio Mac. Commands run on that computer.",
      );
      expect(wrapper.text()).not.toContain("Remote");
    });

    it("shows no host badge in an ordinary window", () => {
      const wrapper = mountProfileBar();
      expect(wrapper.find('[data-testid="profile-bar-host-badge"]').exists()).toBe(false);
    });
  });

  describe("docker shell and popouts", () => {
    it("hides the Docker shell tab, which a remote client cannot attach to", () => {
      const props = { activeSubTab: "logs" as const };
      const local = mount(DockerDetailSubTabs, { props });
      expect(local.text()).toContain("Shell");

      setWindowBackend(backend);
      const peer = mount(DockerDetailSubTabs, { props });
      expect(peer.text()).not.toContain("Shell");
    });

    it("knows it is a peer window for the controls that would call a refused local channel", () => {
      expect(isPeerWindow()).toBe(false);
      setWindowBackend(backend);
      expect(isPeerWindow()).toBe(true);
    });
  });

  describe("attention", () => {
    function mountAttention() {
      return mount(
        defineComponent({
          setup() {
            usePeerWindowAttention();
            return () => h("div");
          },
        }),
      );
    }

    function seedAlerts(count: number): void {
      const app = useAppStore();
      const payload = app.payload as AnyApi;
      app.payload = {
        ...payload,
        appState: { ...payload.appState, workspaces: [{ id: "ws-a", profileId: "work", panels: [] }] },
        attention: {
          byWorkspace: {
            "ws-a": {
              alerts: Array.from({ length: count }, (_, index) => ({
                id: `a${index}`,
                kind: "done",
                at: "2026-01-01T00:00:00Z",
              })),
            },
          },
        },
      } as AnyApi;
    }

    it("reports the attention count the window title shows for the profile on screen, debounced, and 0 to clear", async () => {
      vi.useFakeTimers();
      setWindowBackend(backend);
      seedStore();
      const setPeerWindowAttention = vi.fn().mockResolvedValue(undefined);
      (window as AnyApi).strideterm = { setPeerWindowAttention, startupFlags: { windowId: "slot1" } };
      const wrapper = mountAttention();

      await vi.advanceTimersByTimeAsync(500);
      expect(setPeerWindowAttention).toHaveBeenLastCalledWith(0);

      seedAlerts(2);
      await nextTick();
      expect(setPeerWindowAttention).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(setPeerWindowAttention).toHaveBeenLastCalledWith(2);
      expect(setPeerWindowAttention).toHaveBeenCalledTimes(2);

      seedAlerts(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(setPeerWindowAttention).toHaveBeenLastCalledWith(0);
      wrapper.unmount();
    });

    it("does nothing in an ordinary window", async () => {
      vi.useFakeTimers();
      seedStore();
      const setPeerWindowAttention = vi.fn().mockResolvedValue(undefined);
      (window as AnyApi).strideterm = { setPeerWindowAttention, startupFlags: { windowId: "slot1" } };
      mountAttention();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(setPeerWindowAttention).not.toHaveBeenCalled();
    });

    it("logs and does not throw when the main process refuses the count", async () => {
      vi.useFakeTimers();
      setWindowBackend(backend);
      seedStore();
      const logRenderer = vi.fn();
      (window as AnyApi).strideterm = {
        setPeerWindowAttention: vi.fn().mockRejectedValue(new Error("refused")),
        logRenderer,
        startupFlags: { windowId: "slot1" },
      };
      mountAttention();
      await vi.advanceTimersByTimeAsync(500);
      await flushPromises();
      expect(logRenderer).toHaveBeenCalledWith("warn", expect.stringContaining("alert count"), expect.anything());
    });
  });
});
