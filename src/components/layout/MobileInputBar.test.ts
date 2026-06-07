/**
 * Component tests for MobileInputBar — the mobile composer that bypasses the
 * xterm.js Android IME bug (xtermjs/xterm.js#3600) by composing lines in a
 * plain input and pushing them to the PTY via Transport.writeTerminal.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import MobileInputBar from "./MobileInputBar.vue";
import { useAppStore } from "../../stores/app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const SESSION_ID = "ws-a:panel-shell";
const COLLAPSED_KEY = "strideterm-mobile-input-collapsed";

function mountBar({
  isRemote = true,
  sessionId = SESSION_ID as string | null,
}: { isRemote?: boolean; sessionId?: string | null } = {}): {
  wrapper: VueWrapper;
  writeTerminal: Mock;
} {
  const store = useAppStore();
  store.activeViewId = sessionId;
  store.activeSessionId = sessionId;
  const writeTerminal = vi.fn();
  const wrapper = mount(MobileInputBar, {
    global: {
      provide: { api: { isRemote, writeTerminal } as AnyApi },
    },
  });
  return { wrapper, writeTerminal };
}

describe("MobileInputBar", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem(COLLAPSED_KEY);
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
    const store = useAppStore();
    store.payload = {
      appState: {
        activeWorkspaceId: "ws-a",
        workspaces: [],
        profiles: [],
        windowSlots: [],
        settings: {},
      },
      workspace: {
        workspace: { id: "ws-a", panels: [] },
        sessions: [
          { sessionId: SESSION_ID, panelId: "panel-shell", title: "Shell" },
          { sessionId: "ws-a:panel-other", panelId: "panel-other", title: "Other" },
        ],
      },
    } as AnyApi;
  });

  describe("visibility gating", () => {
    it("renders nothing on a non-remote (desktop IPC) transport", () => {
      const { wrapper } = mountBar({ isRemote: false });
      expect(wrapper.find("[data-role='mobile-input-bar']").exists()).toBe(false);
    });

    it("renders nothing when the active view is not a terminal session", () => {
      const { wrapper } = mountBar({ sessionId: null });
      expect(wrapper.find("[data-role='mobile-input-bar']").exists()).toBe(false);
    });

    it("renders nothing for an unknown view even when it has no known virtual-pane prefix", () => {
      const store = useAppStore();
      store.activeViewId = "plugin:custom-pane";
      store.activeSessionId = null;
      const { wrapper } = mountBar({ sessionId: null });
      store.activeViewId = "plugin:custom-pane";
      expect(wrapper.find("[data-role='mobile-input-bar']").exists()).toBe(false);
    });

    it("renders the composer for a remote transport with an active session", () => {
      const { wrapper } = mountBar();
      expect(wrapper.find("[data-role='mobile-input-bar']").exists()).toBe(true);
      expect(wrapper.find("[data-role='mobile-input-bar-input']").exists()).toBe(true);
    });

    it("falls back to activeViewId when activeSessionId is unset (clean bootstrap)", async () => {
      // After a clean remote bootstrap only activeViewId is restored —
      // activeSessionId stays null until the user switches tabs. The bar
      // must still show and write to the active terminal view.
      const store = useAppStore();
      store.activeSessionId = null;
      store.activeViewId = SESSION_ID;
      const writeTerminal = vi.fn();
      const wrapper = mount(MobileInputBar, {
        global: { provide: { api: { isRemote: true, writeTerminal } as AnyApi } },
      });

      expect(wrapper.find("[data-role='mobile-input-bar']").exists()).toBe(true);
      await wrapper.find("[data-role='mobile-input-bar-input']").setValue("pwd");
      await wrapper.find("form").trigger("submit");
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "pwd\r");
    });

    it.each([
      "git:ws-a",
      "docker:ws-a",
      "azure:ws-a",
      "github:ws-a",
      "review:ws-a",
      "browser:ws-a:1",
      "files:ws-a",
      "task-dashboard:p1",
    ])("stays hidden when the active view is the special pane %s", (viewId) => {
      const store = useAppStore();
      store.activeSessionId = null;
      store.activeViewId = viewId;
      const wrapper = mount(MobileInputBar, {
        global: { provide: { api: { isRemote: true, writeTerminal: vi.fn() } as AnyApi } },
      });
      expect(wrapper.find("[data-role='mobile-input-bar']").exists()).toBe(false);
    });

    it("stays hidden while the workspace grid is visible", () => {
      // With several workspaces on screen the routing target is ambiguous —
      // the bar hides rather than risk sending keystrokes to the wrong one.
      const store = useAppStore();
      store.activeSessionId = SESSION_ID;
      store.payload = {
        appState: {
          activeWorkspaceId: "ws-a",
          workspaces: [{ id: "ws-a", name: "A", panels: [], profileId: "default" }],
          profiles: [{ id: "default", name: "Default" }],
          windowSlots: [],
          workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-a", null] },
          settings: {},
        },
      } as AnyApi;
      const wrapper = mount(MobileInputBar, {
        global: { provide: { api: { isRemote: true, writeTerminal: vi.fn() } as AnyApi } },
      });
      expect(wrapper.find("[data-role='mobile-input-bar']").exists()).toBe(false);
    });
  });

  describe("composing and sending", () => {
    it("sends the composed line plus Enter and clears the field on submit", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("echo mobile-composer");
      await wrapper.find("form").trigger("submit");

      expect(writeTerminal).toHaveBeenCalledTimes(1);
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "echo mobile-composer\r");
      expect((input.element as HTMLInputElement).value).toBe("");
    });

    it("preserves leading/trailing whitespace in the composed line", async () => {
      const { wrapper, writeTerminal } = mountBar();
      await wrapper.find("[data-role='mobile-input-bar-input']").setValue("ls ");
      await wrapper.find("form").trigger("submit");

      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "ls \r");
    });

    it("sends a bare Enter when the field is empty", async () => {
      const { wrapper, writeTerminal } = mountBar();
      await wrapper.find("form").trigger("submit");

      expect(writeTerminal).toHaveBeenCalledTimes(1);
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "\r");
    });

    it("sends the committed IME composition result", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      const element = input.element as HTMLInputElement;

      await input.trigger("compositionstart");
      element.value = "prik";
      await input.trigger("input");
      element.value = "příkaz";
      await input.trigger("compositionend");
      await wrapper.find("form").trigger("submit");

      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "příkaz\r");
    });

    it("defers submit until the active IME composition commits", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      const element = input.element as HTMLInputElement;

      await input.trigger("compositionstart");
      element.value = "prik";
      await input.trigger("input");
      await wrapper.find("form").trigger("submit");
      expect(writeTerminal).not.toHaveBeenCalled();

      element.value = "příkaz";
      await input.trigger("compositionend");
      await nextTick();

      expect(writeTerminal).toHaveBeenCalledTimes(1);
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "příkaz\r");
    });

    it("clears a pending draft when the target session changes", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const store = useAppStore();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("do not forward");

      store.activeViewId = "ws-a:panel-other";
      store.activeSessionId = "ws-a:panel-other";
      await nextTick();

      expect((input.element as HTMLInputElement).value).toBe("");
      await wrapper.find("form").trigger("submit");
      expect(writeTerminal).toHaveBeenCalledWith("ws-a:panel-other", "\r");
    });
  });

  describe("accessory keys", () => {
    const EXPECTED: Array<[label: string, seq: string]> = [
      ["Esc", "\x1b"],
      ["Tab", "\t"],
      ["⇧Tab", "\x1b[Z"],
      ["↑", "\x1b[A"],
      ["↓", "\x1b[B"],
      ["←", "\x1b[D"],
      ["→", "\x1b[C"],
      ["^C", "\x03"],
    ];

    it.each(EXPECTED)("sends the right sequence for %s", async (label, seq) => {
      const { wrapper, writeTerminal } = mountBar();
      const button = wrapper
        .findAll("button.mobile-input-bar__key")
        .find((b) => b.text() === label && !b.classes("mobile-input-bar__key--collapse"));
      expect(button, `accessory key "${label}" should exist`).toBeTruthy();
      await button!.trigger("click");

      expect(writeTerminal).toHaveBeenCalledTimes(1);
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, seq);
    });

    it.each([
      ["Esc", "\x1b"],
      ["^C", "\x03"],
    ])("discards the local draft before sending cancel key %s", async (label, seq) => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("partial command");

      const button = wrapper.findAll("button.mobile-input-bar__key").find((b) => b.text() === label);
      await button!.trigger("click");

      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, seq);
      expect((input.element as HTMLInputElement).value).toBe("");
    });

    it("does not restore a discarded IME draft after its compositionend event", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      const element = input.element as HTMLInputElement;

      await input.trigger("compositionstart");
      element.value = "unfinished";
      await input.trigger("input");
      const esc = wrapper.findAll("button.mobile-input-bar__key").find((b) => b.text() === "Esc");
      await esc!.trigger("click");

      element.value = "unfinished";
      await input.trigger("compositionend");

      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "\x1b");
      expect(element.value).toBe("");
    });

    it("flushes the composed draft before sending Tab for shell completion", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("git che");

      const tab = wrapper.findAll("button.mobile-input-bar__key").find((b) => b.text() === "Tab");
      await tab!.trigger("click");

      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "git che\t");
      expect((input.element as HTMLInputElement).value).toBe("");
    });
  });

  describe("collapse / expand", () => {
    it("collapses to the slim handle and persists the preference", async () => {
      const { wrapper } = mountBar();
      await wrapper.find("button.mobile-input-bar__key--collapse").trigger("click");

      expect(wrapper.find(".mobile-input-bar__expand").exists()).toBe(true);
      expect(wrapper.find("[data-role='mobile-input-bar-input']").exists()).toBe(false);
      expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe("1");
    });

    it("expands back from the handle and persists the preference", async () => {
      window.localStorage.setItem(COLLAPSED_KEY, "1");
      const { wrapper, writeTerminal } = mountBar();
      expect(wrapper.find(".mobile-input-bar__expand").exists()).toBe(true);

      await wrapper.find(".mobile-input-bar__expand").trigger("click");
      await nextTick();

      expect(wrapper.find("[data-role='mobile-input-bar-input']").exists()).toBe(true);
      expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe("0");
      // Expanding alone never writes to the terminal.
      expect(writeTerminal).not.toHaveBeenCalled();
    });

    it("starts collapsed when the persisted preference says so", () => {
      window.localStorage.setItem(COLLAPSED_KEY, "1");
      const { wrapper } = mountBar();

      expect(wrapper.find(".mobile-input-bar__expand").exists()).toBe(true);
      expect(wrapper.find("[data-role='mobile-input-bar-input']").exists()).toBe(false);
    });
  });
});
