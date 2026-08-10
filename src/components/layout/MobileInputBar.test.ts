/**
 * Component tests for MobileInputBar — the mobile composer that bypasses the
 * xterm.js Android IME bug (xtermjs/xterm.js#3600) by composing lines in a
 * plain input and pushing them to the PTY via Transport.writeTerminal.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import MobileInputBar from "./MobileInputBar.vue";
import { apiKey } from "../../types/keys.js";
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
      provide: { [apiKey]: { isRemote, writeTerminal } as AnyApi },
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
        global: { provide: { [apiKey]: { isRemote: true, writeTerminal } as AnyApi } },
      });

      expect(wrapper.find("[data-role='mobile-input-bar']").exists()).toBe(true);
      await wrapper.find("[data-role='mobile-input-bar-input']").setValue("pwd");
      await wrapper.find("form").trigger("submit");
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "pwd");
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
        global: { provide: { [apiKey]: { isRemote: true, writeTerminal: vi.fn() } as AnyApi } },
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
        global: { provide: { [apiKey]: { isRemote: true, writeTerminal: vi.fn() } as AnyApi } },
      });
      expect(wrapper.find("[data-role='mobile-input-bar']").exists()).toBe(false);
    });
  });

  describe("composing and sending", () => {
    // The Enter is written separately after SUBMIT_DELAY_MS (agent TUIs would
    // swallow a \r arriving in the same chunk as the text — see the component).
    // Fake timers make the delayed write assertable.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sends the composed line, then Enter as a separate delayed write", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("echo mobile-composer");
      await wrapper.find("form").trigger("submit");

      expect(writeTerminal).toHaveBeenCalledTimes(1);
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "echo mobile-composer");
      expect((input.element as HTMLInputElement).value).toBe("");

      vi.advanceTimersByTime(200);
      expect(writeTerminal).toHaveBeenCalledTimes(2);
      expect(writeTerminal).toHaveBeenLastCalledWith(SESSION_ID, "\r");
    });

    it("preserves leading/trailing whitespace in the composed line", async () => {
      const { wrapper, writeTerminal } = mountBar();
      await wrapper.find("[data-role='mobile-input-bar-input']").setValue("ls ");
      await wrapper.find("form").trigger("submit");

      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "ls ");
      vi.advanceTimersByTime(200);
      expect(writeTerminal).toHaveBeenLastCalledWith(SESSION_ID, "\r");
    });

    it("sends a bare Enter immediately when the field is empty", async () => {
      const { wrapper, writeTerminal } = mountBar();
      await wrapper.find("form").trigger("submit");

      expect(writeTerminal).toHaveBeenCalledTimes(1);
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "\r");
      // No stray delayed write follows a bare Enter.
      vi.advanceTimersByTime(500);
      expect(writeTerminal).toHaveBeenCalledTimes(1);
    });

    it("routes the delayed Enter to the session that received the text", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const store = useAppStore();
      await wrapper.find("[data-role='mobile-input-bar-input']").setValue("echo hi");
      await wrapper.find("form").trigger("submit");
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "echo hi");

      // Tab switch during the submit delay — the pending Enter still belongs
      // to the terminal that got the text, not the newly active one.
      store.activeViewId = "ws-a:panel-other";
      store.activeSessionId = "ws-a:panel-other";
      await nextTick();

      vi.advanceTimersByTime(200);
      expect(writeTerminal).toHaveBeenLastCalledWith(SESSION_ID, "\r");
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

      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "příkaz");
      vi.advanceTimersByTime(200);
      expect(writeTerminal).toHaveBeenLastCalledWith(SESSION_ID, "\r");
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
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "příkaz");
      vi.advanceTimersByTime(200);
      expect(writeTerminal).toHaveBeenCalledTimes(2);
      expect(writeTerminal).toHaveBeenLastCalledWith(SESSION_ID, "\r");
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

  describe("⋯ menu", () => {
    // ← → and ^C moved off the top row into this menu, alongside Home/End/Ctrl+R/Ctrl+L.
    const MENU_KEYS: Array<[glyph: string, seq: string]> = [
      ["←", "\x1b[D"],
      ["→", "\x1b[C"],
      ["⇤", "\x1b[H"],
      ["⇥", "\x1b[F"],
      ["^⇤", "\x1b[1;5H"],
      ["^⇥", "\x1b[1;5F"],
      ["^C", "\x03"],
      ["⌕", "\x12"],
      ["␌", "\x0c"],
    ];

    it.each(MENU_KEYS)("sends the right sequence for menu key %s", async (glyph, seq) => {
      const { wrapper, writeTerminal } = mountBar();
      await wrapper.find("button.mobile-input-bar__key--more").trigger("click");
      const item = wrapper.findAll("button.mobile-input-bar__menu-item").find((b) => b.text().startsWith(glyph));
      expect(item, `menu key "${glyph}" should exist`).toBeTruthy();
      await item!.trigger("click");
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, seq);
    });

    it("inserts '/' into the draft without sending it", async () => {
      const { wrapper, writeTerminal } = mountBar();
      await wrapper.find("button.mobile-input-bar__key--more").trigger("click");
      const slash = wrapper
        .findAll("button.mobile-input-bar__menu-item")
        .find((b) => b.text().includes("Slash command"));
      expect(slash).toBeTruthy();
      await slash!.trigger("click");
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      expect((input.element as HTMLInputElement).value).toBe("/");
      expect(writeTerminal).not.toHaveBeenCalled();
    });

    it.each(["/clear", "/model", "/usage", "/status"])(
      "puts the quick command %s into the draft without sending",
      async (cmd) => {
        const { wrapper, writeTerminal } = mountBar();
        await wrapper.find("button.mobile-input-bar__key--more").trigger("click");
        const item = wrapper.findAll("button.mobile-input-bar__menu-item").find((b) => b.text() === cmd);
        expect(item, `menu item "${cmd}" should exist`).toBeTruthy();
        await item!.trigger("click");
        const input = wrapper.find("[data-role='mobile-input-bar-input']");
        expect((input.element as HTMLInputElement).value).toBe(cmd);
        expect(writeTerminal).not.toHaveBeenCalled();
      },
    );

    it("closes the menu after choosing an item", async () => {
      const { wrapper } = mountBar();
      await wrapper.find("button.mobile-input-bar__key--more").trigger("click");
      expect(wrapper.find("button.mobile-input-bar__menu-item").exists()).toBe(true);
      await wrapper.findAll("button.mobile-input-bar__menu-item")[0].trigger("click");
      expect(wrapper.find("button.mobile-input-bar__menu-item").exists()).toBe(false);
    });
  });

  describe("accessory keys", () => {
    const EXPECTED: Array<[label: string, seq: string]> = [
      ["Esc", "\x1b"],
      ["Tab", "\t"],
      ["⇧Tab", "\x1b[Z"],
      ["↑", "\x1b[A"],
      ["↓", "\x1b[B"],
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

    it.each([["Esc", "\x1b"]])("discards the local draft before sending cancel key %s", async (label, seq) => {
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

  describe("slash key", () => {
    it("appends '/' to the draft without sending anything", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("echo ");

      await wrapper.find(".mobile-input-bar__key--slash").trigger("click");

      expect((input.element as HTMLInputElement).value).toBe("echo /");
      expect(writeTerminal).not.toHaveBeenCalled();
    });
  });

  describe("clipboard paste button", () => {
    const PASTE = ".mobile-input-bar__key--paste";

    function mockClipboard(text: string | null): void {
      Object.defineProperty(window.navigator, "clipboard", {
        value: {
          readText: () => (text === null ? Promise.reject(new Error("denied")) : Promise.resolve(text)),
        },
        configurable: true,
      });
    }

    it("appends the clipboard text to the draft without sending anything", async () => {
      mockClipboard("npm run dev");
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("sudo ");

      await wrapper.find(PASTE).trigger("click");
      await flushPromises();

      expect((input.element as HTMLInputElement).value).toBe("sudo npm run dev");
      expect(writeTerminal).not.toHaveBeenCalled();
    });

    it("flattens multi-line clipboard content to single spaces", async () => {
      mockClipboard("line one\r\nline two\nline three");
      const { wrapper } = mountBar();

      await wrapper.find(PASTE).trigger("click");
      await flushPromises();

      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      expect((input.element as HTMLInputElement).value).toBe("line one line two line three");
    });

    it("leaves the draft untouched when the clipboard read is blocked", async () => {
      mockClipboard(null);
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("keep me");

      await wrapper.find(PASTE).trigger("click");
      await flushPromises();

      expect((input.element as HTMLInputElement).value).toBe("keep me");
      expect(writeTerminal).not.toHaveBeenCalled();
    });

    it("commits an active IME composition before appending", async () => {
      mockClipboard("pasted");
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      const element = input.element as HTMLInputElement;

      await input.trigger("compositionstart");
      element.value = "prik";
      await input.trigger("input");
      await wrapper.find(PASTE).trigger("click");
      await flushPromises();

      expect(element.value).toBe("prikpasted");
      // The late compositionend must not clobber the merged draft.
      await input.trigger("compositionend");
      expect(element.value).toBe("prikpasted");

      await wrapper.find("form").trigger("submit");
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "prikpasted");
    });
  });

  describe("password-manager autofill", () => {
    // Mobile password managers classify the single-field composer form as a
    // login, offer to save what gets sent, and autofill the remembered value
    // back on the next page load — text the user never typed, one ⏎ from the
    // PTY. The field opts out declaratively and drops foreign values as a
    // backstop for managers that ignore the attributes.
    it("opts out of autofill on both the form and the field", () => {
      const { wrapper } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");

      expect(wrapper.find("form").attributes("autocomplete")).toBe("off");
      expect(input.attributes("autocomplete")).toBe("off");
      // Vendor opt-outs: 1Password, LastPass, Bitwarden, Dashlane.
      expect(input.attributes()).toHaveProperty("data-1p-ignore");
      expect(input.attributes("data-lpignore")).toBe("true");
      expect(input.attributes("data-bwignore")).toBe("true");
      expect(input.attributes("data-form-type")).toBe("other");
    });

    describe("with fake timers", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it("drops a value autofilled into a field the user never touched", async () => {
        const { wrapper, writeTerminal } = mountBar();
        const input = wrapper.find("[data-role='mobile-input-bar-input']");
        // Autofill sets the value and dispatches input, exactly like setValue.
        await input.setValue("Ahoj");

        vi.advanceTimersByTime(600);
        await nextTick();

        expect((input.element as HTMLInputElement).value).toBe("");
        // The foreign value is gone from the draft too — ⏎ sends a bare Enter.
        await wrapper.find("form").trigger("submit");
        expect(writeTerminal).toHaveBeenCalledTimes(1);
        expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "\r");
      });

      it.each([
        [".mobile-input-bar__key--slash", "/"],
        [".mobile-input-bar__key--paste", "pasted"],
      ])("keeps a draft the bar itself wrote via %s", async (button, expected) => {
        Object.defineProperty(window.navigator, "clipboard", {
          value: { readText: () => Promise.resolve("pasted") },
          configurable: true,
        });
        const { wrapper } = mountBar();
        // The accessory buttons never focus the field on tap (mousedown.prevent),
        // so the drop guard must not mistake their insert for an autofill.
        await wrapper.find(button).trigger("click");
        await flushPromises();

        vi.advanceTimersByTime(600);
        await nextTick();

        expect((wrapper.find("[data-role='mobile-input-bar-input']").element as HTMLInputElement).value).toBe(expected);
      });

      it("keeps text typed into the field after the user focused it", async () => {
        const { wrapper, writeTerminal } = mountBar();
        const input = wrapper.find("[data-role='mobile-input-bar-input']");
        await input.trigger("focus");
        await input.setValue("echo typed");

        vi.advanceTimersByTime(600);
        await nextTick();

        expect((input.element as HTMLInputElement).value).toBe("echo typed");
        await wrapper.find("form").trigger("submit");
        expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "echo typed");
      });
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

describe("MobileInputBar — relocated Companion Primary", () => {
  function relocationPayload(state: string): AnyApi {
    const source = {
      id: "ws-source",
      name: "Live conversation",
      kind: "terminal",
      profileId: "default",
      panels: [{ id: "panel-primary", title: "Claude", command: "claude" }],
    };
    const task = {
      id: "ws-task",
      name: "Reviewer",
      kind: "task",
      profileId: "default",
      panels: [
        { id: "panel-dashboard", title: "Dashboard", command: "__task-dashboard__" },
        { id: "panel-judge", title: "Reviewer", command: "codex" },
      ],
      task: {
        mode: "attached",
        state,
        workerWorkspaceId: "ws-source",
        workerPanelId: "panel-primary",
        judgePanelId: "panel-judge",
        companionRole: "reviewer",
      },
    };
    return {
      appState: {
        activeWorkspaceId: "ws-task",
        workspaces: [source, task],
        profiles: [],
        windowSlots: [],
        settings: {},
      },
      workspace: {
        workspace: task,
        // The task workspace's OWN sessions — the source Primary is not here.
        sessions: [{ sessionId: "ws-task:panel-judge", panelId: "panel-judge", title: "Reviewer" }],
      },
      attention: { sessions: {}, byWorkspace: {} },
      taskRunner: {},
    };
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem(COLLAPSED_KEY);
    (window as AnyApi).strideterm = { startupFlags: { windowId: "" } };
  });

  it("writes to the source PTY while the Primary is hosted in the task workspace", async () => {
    const store = useAppStore();
    store.payload = relocationPayload("running") as AnyApi;
    store.activeViewId = "attached-primary:ws-task";
    store.activeSessionId = "ws-source:panel-primary";

    const writeTerminal = vi.fn();
    const wrapper = mount(MobileInputBar, {
      global: { provide: { [apiKey]: { isRemote: true, writeTerminal } as AnyApi } },
    });
    await flushPromises();

    const input = wrapper.find("input");
    expect(input.exists()).toBe(true);
    await input.setValue("hello");
    await wrapper.find("form").trigger("submit");
    await nextTick();

    // The virtual view id must never reach the PTY layer.
    expect(writeTerminal).toHaveBeenCalledWith("ws-source:panel-primary", "hello");
  });

  it("has no write target once the loop finishes and the alias is gone", async () => {
    const store = useAppStore();
    store.payload = relocationPayload("completed") as AnyApi;
    store.activeViewId = "attached-primary:ws-task";
    store.activeSessionId = "ws-source:panel-primary";

    const writeTerminal = vi.fn();
    const wrapper = mount(MobileInputBar, {
      global: { provide: { [apiKey]: { isRemote: true, writeTerminal } as AnyApi } },
    });
    await flushPromises();

    expect(wrapper.find("input").exists()).toBe(false);
    expect(writeTerminal).not.toHaveBeenCalled();
  });
});
