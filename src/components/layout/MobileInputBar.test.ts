/**
 * Component tests for MobileInputBar — the mobile composer that bypasses the
 * xterm.js Android IME bug (xtermjs/xterm.js#3600) by composing lines in a
 * plain input and submitting it to the PTY through Transport.submitTerminal.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import MobileInputBar from "./MobileInputBar.vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { useNotificationStore } from "../../stores/notifications.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const SESSION_ID = "ws-a:panel-shell";
// Workspace credited with the work for a write into SESSION_ID.
const ORIGIN_WS = "ws-a";
const COLLAPSED_KEY = "strideterm-mobile-input-collapsed";

function mockScreenOrientation(initialType: string) {
  let type = initialType;
  const orientation = new EventTarget() as unknown as ScreenOrientation;
  Object.defineProperty(orientation, "type", { configurable: true, get: () => type });
  const descriptor = Object.getOwnPropertyDescriptor(window.screen, "orientation");
  Object.defineProperty(window.screen, "orientation", { configurable: true, value: orientation });
  return {
    setType(nextType: string) {
      type = nextType;
      orientation.dispatchEvent(new Event("change"));
    },
    restore() {
      if (descriptor) Object.defineProperty(window.screen, "orientation", descriptor);
      else Reflect.deleteProperty(window.screen, "orientation");
    },
  };
}

function mockPhysicalScreenSize(width: number, height: number) {
  const descriptors = new Map(
    ["orientation", "width", "height"].map((key) => [key, Object.getOwnPropertyDescriptor(window.screen, key)]),
  );
  Object.defineProperty(window.screen, "orientation", { configurable: true, value: undefined });
  Object.defineProperty(window.screen, "width", { configurable: true, value: width });
  Object.defineProperty(window.screen, "height", { configurable: true, value: height });
  return {
    restore() {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(window.screen, key, descriptor);
        else Reflect.deleteProperty(window.screen, key);
      }
    },
  };
}

function mountBar({
  isRemote = true,
  sessionId = SESSION_ID as string | null,
  attachTo,
}: { isRemote?: boolean; sessionId?: string | null; attachTo?: Element } = {}): {
  wrapper: VueWrapper;
  writeTerminal: Mock;
  submitTerminal: Mock;
} {
  const store = useAppStore();
  store.activeViewId = sessionId;
  store.activeSessionId = sessionId;
  const writeTerminal = vi.fn();
  const submitTerminal = vi.fn();
  const wrapper = mount(MobileInputBar, {
    attachTo,
    global: {
      provide: { [apiKey]: { isRemote, writeTerminal, submitTerminal } as AnyApi },
    },
  });
  return { wrapper, writeTerminal, submitTerminal };
}

describe("MobileInputBar", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem(COLLAPSED_KEY);
    window.localStorage.removeItem("strideterm.mobile.hideKeyboardAfterSend");
    // The bar persists its unsent draft per terminal session in sessionStorage, so a return from the
    // background restores what the user was typing (production hardening §5 "Session" 6). jsdom keeps
    // one storage for the whole file, so without this a draft from one case would be restored into the
    // next one's field — which is exactly what the store must NOT do across browsing contexts.
    window.sessionStorage.clear();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
    delete (window as AnyApi).StridetermHost;
    delete window.StridetermViewport;
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

  it("landscape types into the draft without sending, supports selection, and restores the system keyboard in portrait", async () => {
    let portrait = false;
    const screenOrientation = mockScreenOrientation("landscape-primary");
    const listeners: Array<() => void> = [];
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          get matches() {
            return query === "(orientation: portrait)" ? portrait : true;
          },
          addEventListener: (_event: string, fn: () => void) => listeners.push(fn),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const { wrapper, writeTerminal } = mountBar();
    try {
      await nextTick();
      expect(wrapper.find(".mobile-input-bar__input").exists()).toBe(false);
      await wrapper.get(".mobile-input-bar__expand").trigger("click");
      const input = wrapper.get<HTMLTextAreaElement>(".mobile-input-bar__input");
      expect(input.attributes("inputmode")).toBe("text");
      expect(wrapper.get(".mobile-input-bar").classes()).toContain("mobile-input-bar--system");
      expect(wrapper.find(".compact-terminal-keyboard").exists()).toBe(false);
      await wrapper.get(".mobile-input-bar__key--more").trigger("click");
      await wrapper.get("[data-role='mobile-input-bar-keyboard-mode']").trigger("click");
      expect(input.attributes("inputmode")).toBe("none");
      await input.setValue("ac");
      input.element.setSelectionRange(1, 1);
      await wrapper
        .findAll(".compact-terminal-keyboard button")
        .find((b) => b.text() === "b")!
        .trigger("click");
      await nextTick();
      expect(input.element.value).toBe("abc");
      await wrapper.get('[aria-label="Backspace"]').trigger("click");
      await nextTick();
      expect(input.element.value).toBe("ac");
      expect(writeTerminal).not.toHaveBeenCalled();
      await wrapper.get(".mobile-input-bar__key--more").trigger("click");
      await wrapper.get("[data-role='mobile-input-bar-keyboard-mode']").trigger("click");
      expect(input.attributes("inputmode")).toBe("text");
      expect(wrapper.find(".compact-terminal-keyboard").exists()).toBe(false);
      portrait = true;
      screenOrientation.setType("portrait-primary");
      listeners.forEach((fn) => fn());
      await nextTick();
      expect(wrapper.classes()).not.toContain("mobile-input-bar--landscape");
      expect(input.element.value).toBe("ac");
      expect(writeTerminal).not.toHaveBeenCalled();
    } finally {
      wrapper.unmount();
      media.mockRestore();
      screenOrientation.restore();
    }
  });

  it.each(["Screen Orientation API", "physical screen dimensions fallback"] as const)(
    "keeps the composer focused when the keyboard makes a portrait viewport look landscape (%s)",
    async (orientationSource) => {
      let viewportPortrait = true;
      const listeners: Array<() => void> = [];
      const media = vi.spyOn(window, "matchMedia").mockImplementation(
        (query) =>
          ({
            get matches() {
              return query === "(orientation: portrait)" ? viewportPortrait : true;
            },
            addEventListener: (_event: string, fn: () => void) => listeners.push(fn),
            removeEventListener: vi.fn(),
          }) as unknown as MediaQueryList,
      );
      const physicalScreen =
        orientationSource === "Screen Orientation API"
          ? mockScreenOrientation("portrait-primary")
          : mockPhysicalScreenSize(393, 852);
      const { wrapper } = mountBar();
      try {
        await nextTick();
        document.body.appendChild(wrapper.element);
        const input = wrapper.get<HTMLTextAreaElement>(".mobile-input-bar__input").element;
        input.focus();
        expect(document.activeElement).toBe(input);

        // Android Chrome can resize the CSS viewport below its width while the
        // physical phone stays portrait and its text input still owns focus.
        viewportPortrait = false;
        listeners.forEach((fn) => fn());
        await nextTick();

        expect(wrapper.find(".mobile-input-bar--landscape").exists()).toBe(false);
        expect(wrapper.find(".mobile-input-bar__input").exists()).toBe(true);
        expect(document.activeElement).toBe(input);
      } finally {
        viewportPortrait = true;
        listeners.forEach((fn) => fn());
        wrapper.unmount();
        media.mockRestore();
        physicalScreen.restore();
      }
    },
  );

  it("keeps viewport orientation behavior for fine-pointer desktop layouts", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query !== "(any-pointer: coarse)",
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const screenOrientation = mockScreenOrientation("landscape-primary");
    const { wrapper } = mountBar();
    try {
      await nextTick();
      expect(wrapper.find(".mobile-input-bar--landscape").exists()).toBe(false);
    } finally {
      wrapper.unmount();
      media.mockRestore();
      screenOrientation.restore();
    }
  });

  it("shows quick-key help on touch long-press without sending, then preserves short taps", async () => {
    vi.useFakeTimers();
    const { wrapper, writeTerminal } = mountBar();
    try {
      const escape = wrapper.get(".mobile-input-bar__key");
      const pointer = (type: string, clientX = 20, clientY = 30) => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperties(event, {
          pointerType: { value: "touch" },
          pointerId: { value: 7 },
          clientX: { value: clientX },
          clientY: { value: clientY },
        });
        escape.element.dispatchEvent(event);
      };
      pointer("pointerdown");
      await vi.advanceTimersByTimeAsync(501);
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain("Send Escape");
      expect(escape.attributes("aria-describedby")).toBe("mobile-input-bar-key-help");
      pointer("pointerup");
      await escape.trigger("click");
      expect(writeTerminal).not.toHaveBeenCalled();

      document.body.querySelector<HTMLButtonElement>('[aria-label="Dismiss key help"]')?.click();
      await nextTick();
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      await escape.trigger("click");
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "\x1b", ORIGIN_WS);
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  it("cancels touch help when a finger moves and still recovers the next tap", async () => {
    vi.useFakeTimers();
    const { wrapper, writeTerminal } = mountBar();
    try {
      const escape = wrapper.get(".mobile-input-bar__key");
      const pointer = (type: string, clientX: number, clientY: number) => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperties(event, {
          pointerType: { value: "touch" },
          pointerId: { value: 9 },
          clientX: { value: clientX },
          clientY: { value: clientY },
        });
        escape.element.dispatchEvent(event);
      };
      pointer("pointerdown", 20, 30);
      pointer("pointermove", 38, 30);
      await vi.advanceTimersByTimeAsync(501);
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      pointer("pointerup", 38, 30);
      // A fresh touch clears a stale suppression even if the browser omitted
      // the swipe's synthesized click.
      pointer("pointerdown", 20, 30);
      pointer("pointerup", 20, 30);
      await escape.trigger("click");
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "\x1b", ORIGIN_WS);
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  it("opens the system input at a wide landscape viewport and preserves an explicit keyboard choice", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(any-pointer: coarse)",
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const screenOrientation = mockScreenOrientation("landscape-primary");
    const { wrapper } = mountBar();
    try {
      await nextTick();
      expect(wrapper.find(".mobile-input-bar--landscape").exists()).toBe(false);
      expect(wrapper.find(".compact-terminal-keyboard").exists()).toBe(false);

      document.documentElement.classList.add("native-session-rail");
      window.dispatchEvent(new Event("strideterm:focus-composer"));
      await flushPromises();

      expect(wrapper.find(".mobile-input-bar--system").exists()).toBe(true);
      expect(wrapper.find(".compact-terminal-keyboard").exists()).toBe(false);
      expect(wrapper.get("[data-role='mobile-input-bar-input']").attributes("inputmode")).toBe("text");

      await wrapper.get(".mobile-input-bar__key--more").trigger("click");
      await wrapper.get("[data-role='mobile-input-bar-keyboard-mode']").trigger("click");
      expect(wrapper.find(".compact-terminal-keyboard").exists()).toBe(true);
      expect(wrapper.get("[data-role='mobile-input-bar-input']").attributes("inputmode")).toBe("none");

      window.dispatchEvent(new Event("strideterm:focus-composer"));
      await flushPromises();
      expect(wrapper.find(".compact-terminal-keyboard").exists()).toBe(true);
      expect(wrapper.get("[data-role='mobile-input-bar-input']").attributes("inputmode")).toBe("none");

      await wrapper.get(".mobile-input-bar__key--more").trigger("click");
      await wrapper.get("[data-role='mobile-input-bar-keyboard-mode']").trigger("click");
      expect(wrapper.find(".compact-terminal-keyboard").exists()).toBe(false);
      expect(wrapper.get("[data-role='mobile-input-bar-input']").attributes("inputmode")).toBe("text");
    } finally {
      wrapper.unmount();
      document.documentElement.classList.remove("native-session-rail");
      screenOrientation.restore();
      media.mockRestore();
    }
  });

  it("keeps the native landscape composer visible without opening the keyboard on rotation", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(any-pointer: coarse)",
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    window.localStorage.setItem(COLLAPSED_KEY, "1");
    window.localStorage.setItem("strideterm.mobile.hideKeyboardAfterSend", "true");
    const screenOrientation = mockScreenOrientation("portrait-primary");
    const { wrapper } = mountBar();
    try {
      await nextTick();
      document.body.appendChild(wrapper.element);
      document.documentElement.classList.add("native-session-rail");
      await flushPromises();
      screenOrientation.setType("landscape-primary");
      await nextTick();

      const input = wrapper.get<HTMLTextAreaElement>(".mobile-input-bar__input").element;
      expect(wrapper.find(".mobile-input-bar--landscape").exists()).toBe(true);
      expect(wrapper.find(".mobile-input-bar__expand").exists()).toBe(false);
      expect(document.activeElement).not.toBe(input);
      await wrapper.get(".mobile-input-bar__key--more").trigger("click");
      expect(wrapper.text()).toContain("Hide keyboard");
      await wrapper.get(".mobile-input-bar__key--more").trigger("click");

      await wrapper.get(".mobile-input-bar__input").setValue("echo sent");
      await wrapper.get(".mobile-input-bar__row").trigger("submit");
      await nextTick();
      expect(wrapper.find(".mobile-input-bar__expand").exists()).toBe(false);
      expect(wrapper.find(".mobile-input-bar__input").exists()).toBe(true);
      expect(document.activeElement).not.toBe(input);

      await wrapper.get(".mobile-input-bar__key--more").trigger("click");
      await wrapper.get("[data-role='mobile-input-bar-keyboard-mode']").trigger("click");
      expect(input.inputMode).toBe("none");
      expect(wrapper.find(".compact-terminal-keyboard").exists()).toBe(true);

      window.dispatchEvent(new CustomEvent("strideterm:toggle-system-keyboard", { detail: { show: true } }));
      await flushPromises();
      expect(document.activeElement).toBe(input);
      expect(wrapper.find(".mobile-input-bar__expand").exists()).toBe(false);
      expect(input.inputMode).toBe("text");
      expect(wrapper.find(".compact-terminal-keyboard").exists()).toBe(false);
      const focusEvents: string[] = [];
      input.addEventListener("blur", () => focusEvents.push("blur"));
      input.addEventListener("focus", () => focusEvents.push("focus"));
      window.dispatchEvent(new CustomEvent("strideterm:toggle-system-keyboard", { detail: { show: true } }));
      await flushPromises();
      expect(document.activeElement).toBe(input);
      expect(focusEvents).toEqual(["blur", "focus"]);

      window.dispatchEvent(new CustomEvent("strideterm:toggle-system-keyboard", { detail: { show: false } }));
      expect(document.activeElement).not.toBe(input);
      expect(wrapper.find(".mobile-input-bar__expand").exists()).toBe(false);
    } finally {
      wrapper.unmount();
      document.documentElement.classList.remove("native-session-rail");
      media.mockRestore();
      screenOrientation.restore();
    }
  });

  it("expands a collapsed native portrait composer before showing the system keyboard", async () => {
    window.localStorage.setItem(COLLAPSED_KEY, "1");
    document.documentElement.classList.add("native-session-rail");
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(any-pointer: coarse)" || query === "(orientation: portrait)",
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const screenOrientation = mockScreenOrientation("portrait-primary");
    const { wrapper } = mountBar({ attachTo: document.body });
    try {
      await nextTick();
      expect(wrapper.find(".mobile-input-bar__expand").exists()).toBe(true);

      window.dispatchEvent(new CustomEvent("strideterm:toggle-system-keyboard", { detail: { show: true } }));
      await flushPromises();
      const input = wrapper.get<HTMLTextAreaElement>(".mobile-input-bar__input").element;
      expect(wrapper.find(".mobile-input-bar__expand").exists()).toBe(false);
      expect(document.activeElement).toBe(input);

      window.dispatchEvent(new CustomEvent("strideterm:toggle-system-keyboard", { detail: { show: false } }));
      expect(document.activeElement).not.toBe(input);
      expect(wrapper.find(".mobile-input-bar__input").exists()).toBe(true);
    } finally {
      wrapper.unmount();
      document.documentElement.classList.remove("native-session-rail");
      screenOrientation.restore();
      media.mockRestore();
    }
  });

  it("shows fitting landscape keys in the side rail and moves every other key into the menu", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(any-pointer: coarse)",
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const screenOrientation = mockScreenOrientation("landscape-primary");
    document.documentElement.classList.add("native-session-rail");
    const workspace = document.createElement("div");
    const terminal = document.createElement("div");
    terminal.className = "workspace-pane__body--terminal";
    document.body.appendChild(workspace);
    const observerDisconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { wrapper } = mountBar({ attachTo: workspace });
    const componentRoot = wrapper.get(".mobile-input-bar").element as HTMLElement;
    const workspaceMain = componentRoot.parentElement!;
    workspaceMain.className = "workspace-main";
    workspaceMain.append(terminal);
    const rect = (top: number, bottom: number, width: number): DOMRect =>
      ({
        x: 0,
        y: top,
        left: 0,
        top,
        right: width,
        bottom,
        width,
        height: bottom - top,
        toJSON: () => ({}),
      }) as DOMRect;
    const setRect = (element: HTMLElement, getRect: () => DOMRect) =>
      Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: getRect });
    let inset = 0;
    setRect(workspaceMain, () => rect(0, 390 - inset, inset ? 320 : 400));
    setRect(terminal, () => rect(100, 350 - inset, inset ? 316 : 296));
    setRect(componentRoot, () =>
      componentRoot.classList.contains("mobile-input-bar--rail")
        ? rect(0, 390 - inset, inset ? 320 : 400)
        : rect(342, 390, inset ? 320 : 400),
    );
    setRect(wrapper.get(".mobile-input-bar__row").element as HTMLElement, () => rect(342, 390, 400));
    try {
      await flushPromises();
      window.dispatchEvent(new CustomEvent("strideterm:toggle-system-keyboard", { detail: { show: true } }));
      await flushPromises();
      window.dispatchEvent(new Event("resize"));
      await nextTick();
      expect(wrapper.get(".mobile-input-bar").classes()).toContain("mobile-input-bar--rail");
      expect(
        wrapper.findAll(".mobile-input-bar__keys > .mobile-input-bar__key:not(.mobile-input-bar__key--more)"),
      ).toHaveLength(4);

      await wrapper.get(".mobile-input-bar__key--more").trigger("click");
      const visible = wrapper
        .findAll(".mobile-input-bar__keys > .mobile-input-bar__key:not(.mobile-input-bar__key--more)")
        .map((button) => button.attributes("aria-label"));
      const overflow = wrapper.findAll('.mobile-input-bar__menu-item[title^="Send"]').map((button) => button.text());
      expect(visible).toEqual(["Esc", "Tab", "↑", "↓"]);
      expect(overflow).toHaveLength(12);
      expect(overflow.join(" ")).toContain("Ctrl+C");
      expect(wrapper.findAll('.mobile-input-bar__menu-item[title^="Send Ctrl+C"]')).toHaveLength(1);

      await wrapper.get(".mobile-input-bar__key--more").trigger("click");
      inset = 142;
      document.documentElement.style.setProperty("--strideterm-keyboard-bottom", "142px");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
      expect(wrapper.get(".mobile-input-bar").classes()).toContain("mobile-input-bar--rail");
      expect(
        wrapper.findAll(".mobile-input-bar__keys > .mobile-input-bar__key:not(.mobile-input-bar__key--more)"),
      ).toHaveLength(1);

      inset = 180;
      document.documentElement.style.setProperty("--strideterm-keyboard-bottom", "180px");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
      expect(wrapper.get(".mobile-input-bar").classes()).not.toContain("mobile-input-bar--rail");
      expect(
        wrapper.findAll(".mobile-input-bar__keys > .mobile-input-bar__key:not(.mobile-input-bar__key--more)"),
      ).toHaveLength(1);

      inset = 0;
      document.documentElement.style.removeProperty("--strideterm-keyboard-bottom");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
      expect(wrapper.get(".mobile-input-bar").classes()).toContain("mobile-input-bar--rail");
      expect(
        wrapper.findAll(".mobile-input-bar__keys > .mobile-input-bar__key:not(.mobile-input-bar__key--more)"),
      ).toHaveLength(4);
      wrapper.unmount();
      expect(observerDisconnect).toHaveBeenCalled();
    } finally {
      wrapper.unmount();
      observerDisconnect.mockRestore();
      workspace.remove();
      document.documentElement.style.removeProperty("--strideterm-keyboard-bottom");
      document.documentElement.classList.remove("native-session-rail");
      screenOrientation.restore();
      media.mockRestore();
    }
  });

  it("cancels pending keyboard shows on a later hide, rotation, or unmount", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(any-pointer: coarse)",
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const screenOrientation = mockScreenOrientation("landscape-primary");
    document.documentElement.classList.add("native-session-rail");
    const { wrapper } = mountBar();
    try {
      await nextTick();
      document.body.appendChild(wrapper.element);
      const input = wrapper.get<HTMLTextAreaElement>(".mobile-input-bar__input").element;

      window.dispatchEvent(new CustomEvent("strideterm:toggle-system-keyboard", { detail: { show: true } }));
      window.dispatchEvent(new CustomEvent("strideterm:toggle-system-keyboard", { detail: { show: false } }));
      await flushPromises();
      expect(document.activeElement).not.toBe(input);

      window.dispatchEvent(new CustomEvent("strideterm:toggle-system-keyboard", { detail: { show: true } }));
      screenOrientation.setType("portrait-primary");
      await flushPromises();
      expect(document.activeElement).not.toBe(input);

      screenOrientation.setType("landscape-primary");
      await nextTick();
      window.dispatchEvent(new CustomEvent("strideterm:toggle-system-keyboard", { detail: { show: true } }));
      wrapper.unmount();
      await flushPromises();
      expect(document.activeElement).not.toBe(input);
    } finally {
      wrapper.unmount();
      document.documentElement.classList.remove("native-session-rail");
      media.mockRestore();
      screenOrientation.restore();
    }
  });

  it("does not switch a wide desktop with touch support into mobile landscape mode", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(any-pointer: coarse)" || query === "(orientation: landscape)",
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const screenOrientation = mockScreenOrientation("landscape-primary");
    const { wrapper } = mountBar();
    try {
      await nextTick();
      expect(wrapper.find(".mobile-input-bar--landscape").exists()).toBe(false);
    } finally {
      wrapper.unmount();
      screenOrientation.restore();
      media.mockRestore();
    }
  });

  it("optionally hides after sending and remembers the choice", async () => {
    const { wrapper, submitTerminal } = mountBar();
    await wrapper.get(".mobile-input-bar__key--more").trigger("click");
    const option = wrapper.get('[role="menuitemcheckbox"]');
    expect(option.attributes("aria-checked")).toBe("false");
    await option.trigger("click");
    expect(localStorage.getItem("strideterm.mobile.hideKeyboardAfterSend")).toBe("true");
    await wrapper.get(".mobile-input-bar__input").setValue("draft");
    await wrapper.get("form").trigger("submit");
    expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "draft", ORIGIN_WS);
    expect(wrapper.find(".mobile-input-bar__input").exists()).toBe(false);
    wrapper.unmount();
  });

  describe("visibility gating", () => {
    it("reports keyboard availability to the native rail as tabs change", async () => {
      const postMessage = vi.fn();
      window.StridetermViewport = { postMessage };
      const { wrapper } = mountBar();
      expect(JSON.parse(postMessage.mock.calls.at(-1)![0])).toEqual({ type: "keyboard-available", available: true });
      const store = useAppStore();
      store.activeSessionId = null;
      store.activeViewId = "files:ws-a";
      await nextTick();
      expect(JSON.parse(postMessage.mock.calls.at(-1)![0])).toEqual({ type: "keyboard-available", available: false });
      wrapper.unmount();
      delete window.StridetermViewport;
    });

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
      const submitTerminal = vi.fn();
      const wrapper = mount(MobileInputBar, {
        global: { provide: { [apiKey]: { isRemote: true, writeTerminal, submitTerminal } as AnyApi } },
      });

      expect(wrapper.find("[data-role='mobile-input-bar']").exists()).toBe(true);
      await wrapper.find("[data-role='mobile-input-bar-input']").setValue("pwd");
      await wrapper.find("form").trigger("submit");
      expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "pwd", ORIGIN_WS);
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
    // Fake timers prove submits never schedule a second, potentially stale Enter.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    describe("Enter handling", () => {
      const input = (wrapper: VueWrapper) => wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']");
      const toggleEditor = async (wrapper: VueWrapper) => {
        await wrapper.get(".mobile-input-bar__editor-toggle").trigger("click");
        await nextTick();
      };

      it("sends on Enter in normal mode and keeps Shift+Enter as a newline", async () => {
        const { wrapper, submitTerminal } = mountBar();
        const editor = input(wrapper);
        await editor.setValue("ls -la");
        await editor.trigger("keydown", { key: "Enter", shiftKey: true });
        expect(submitTerminal).not.toHaveBeenCalled();
        await editor.trigger("keydown", { key: "Enter" });
        expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "ls -la", ORIGIN_WS);
      });

      it("sends on Ctrl+Enter and Cmd+Enter in normal mode", async () => {
        const { wrapper, submitTerminal } = mountBar();
        const editor = input(wrapper);
        await editor.setValue("one");
        await editor.trigger("keydown", { key: "Enter", ctrlKey: true });
        await editor.setValue("two");
        await editor.trigger("keydown", { key: "Enter", metaKey: true });
        expect(submitTerminal).toHaveBeenNthCalledWith(1, SESSION_ID, "one", ORIGIN_WS);
        expect(submitTerminal).toHaveBeenNthCalledWith(2, SESSION_ID, "two", ORIGIN_WS);
      });

      it("keeps Enter in the draft in editor mode and sends on Ctrl+Enter", async () => {
        vi.spyOn(useTerminalStore(), "isBracketedPasteEnabled").mockReturnValue(true);
        const { wrapper, submitTerminal } = mountBar();
        await toggleEditor(wrapper);
        const editor = input(wrapper);
        await editor.setValue("first line\nsecond line");
        await editor.trigger("keydown", { key: "Enter", ctrlKey: false });
        expect(editor.element.value).toBe("first line\nsecond line");
        expect(submitTerminal).not.toHaveBeenCalled();
        await editor.trigger("keydown", { key: "Enter", ctrlKey: true });
        expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "first line\nsecond line", ORIGIN_WS);
      });

      it("does not intercept Enter while an IME composition is active", async () => {
        const { wrapper, submitTerminal } = mountBar();
        const editor = input(wrapper);
        await editor.setValue("příkaz");
        await editor.trigger("keydown", { key: "Enter", isComposing: true });
        expect(submitTerminal).not.toHaveBeenCalled();
        await editor.trigger("compositionstart");
        await editor.trigger("keydown", { key: "Enter" });
        expect(submitTerminal).not.toHaveBeenCalled();
      });

      it("flips enterkeyhint and placeholder with the editor mode", async () => {
        const { wrapper } = mountBar();
        const editor = input(wrapper);
        expect(editor.attributes("enterkeyhint")).toBe("send");
        expect(editor.attributes("placeholder")).toBe("Type a command — ⏎ sends it");
        await toggleEditor(wrapper);
        expect(editor.attributes("enterkeyhint")).toBe("enter");
        expect(editor.attributes("placeholder")).toContain("⏎ adds a line");
        await toggleEditor(wrapper);
        expect(editor.attributes("enterkeyhint")).toBe("send");
      });
    });

    describe("multi-line confirm", () => {
      const NOTICE = "[data-role='mobile-input-bar-multiline-notice']";

      it("asks to confirm a multi-line draft when bracketed paste is not known to be on", async () => {
        const { wrapper, submitTerminal } = mountBar();
        const editor = wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']");
        await editor.setValue("first\nsecond");
        await wrapper.get("form").trigger("submit");
        expect(submitTerminal).not.toHaveBeenCalled();
        expect(wrapper.get(NOTICE).text()).toContain("bracketed paste");
        expect(editor.element.value).toBe("first\nsecond");
        await wrapper.get("form").trigger("submit");
        expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "first\nsecond", ORIGIN_WS);
        expect(wrapper.find(NOTICE).exists()).toBe(false);
      });

      it("asks again when the draft changes after the notice", async () => {
        const { wrapper, submitTerminal } = mountBar();
        const editor = wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']");
        await editor.setValue("first\nsecond");
        await wrapper.get("form").trigger("submit");
        await editor.setValue("first\nsecond\nthird");
        expect(wrapper.find(NOTICE).exists()).toBe(false);
        await wrapper.get("form").trigger("submit");
        expect(submitTerminal).not.toHaveBeenCalled();
        expect(wrapper.find(NOTICE).exists()).toBe(true);
      });

      it("drops the pending confirm when the target session changes", async () => {
        const { wrapper, submitTerminal } = mountBar();
        const editor = wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']");
        await editor.setValue("first\nsecond");
        await wrapper.get("form").trigger("submit");
        const store = useAppStore();
        store.activeViewId = "ws-a:panel-other";
        store.activeSessionId = "ws-a:panel-other";
        await nextTick();
        expect(wrapper.find(NOTICE).exists()).toBe(false);
        await editor.setValue("first\nsecond");
        await wrapper.get("form").trigger("submit");
        expect(submitTerminal).not.toHaveBeenCalled();
        expect(wrapper.find(NOTICE).exists()).toBe(true);
      });

      it("sends a multi-line draft at once when bracketed paste is on", async () => {
        const mode = vi.spyOn(useTerminalStore(), "isBracketedPasteEnabled").mockReturnValue(true);
        const { wrapper, submitTerminal } = mountBar();
        await wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']").setValue("first\nsecond");
        await wrapper.get("form").trigger("submit");
        expect(mode).toHaveBeenCalledWith(SESSION_ID);
        expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "first\nsecond", ORIGIN_WS);
        expect(wrapper.find(NOTICE).exists()).toBe(false);
      });

      it("never asks for a single-line draft", async () => {
        const { wrapper, submitTerminal } = mountBar();
        await wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']").setValue("pwd");
        await wrapper.get("form").trigger("submit");
        expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "pwd", ORIGIN_WS);
      });
    });

    it("offers a larger editor without replacing or sending the draft", async () => {
      const { wrapper, submitTerminal } = mountBar();
      await wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']").setValue("keep\nthis draft");
      await wrapper.get(".mobile-input-bar__editor-toggle").trigger("click");
      await nextTick();
      expect(wrapper.find(".mobile-input-bar--editor-expanded").exists()).toBe(true);
      expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("keep\nthis draft");
      expect(submitTerminal).not.toHaveBeenCalled();
      await wrapper.get(".mobile-input-bar__editor-toggle").trigger("click");
      expect(wrapper.find(".mobile-input-bar--editor-expanded").exists()).toBe(false);
      expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("keep\nthis draft");
    });

    it("captures the caret and inserts a validated attachment path without sending", async () => {
      const postMessage = vi.fn();
      (window as AnyApi).StridetermHost = { postMessage };
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']");
      await input.setValue("echo done");
      input.element.setSelectionRange(5, 5);
      await wrapper.get(".mobile-input-bar__key--attachment").trigger("click");
      const request = JSON.parse(postMessage.mock.calls[0][0]);
      expect(request).toMatchObject({
        type: "attachment-compose",
        draft: "echo done",
        selectionStart: 5,
        selectionEnd: 5,
        sessionId: SESSION_ID,
        workspaceId: ORIGIN_WS,
      });
      window.dispatchEvent(
        new CustomEvent("strideterm:attachment-compose-result", {
          detail: {
            requestId: request.requestId,
            profileId: request.profileId,
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            path: ".strideterm/attachments/123e4567-e89b-12d3-a456-426614174000/report.txt",
            prompt: request.draft,
            action: "insert",
          },
        }),
      );
      await nextTick();
      expect(input.element.value).toBe(
        'echo ".strideterm/attachments/123e4567-e89b-12d3-a456-426614174000/report.txt" done',
      );
      expect(writeTerminal).not.toHaveBeenCalled();
      expect(JSON.parse(postMessage.mock.calls.at(-1)![0])).toMatchObject({
        type: "attachment-compose-ack",
        requestId: request.requestId,
        ok: true,
      });
      wrapper.unmount();
    });

    it("opens attachment compose when the native menu requests it", async () => {
      const postMessage = vi.fn();
      (window as AnyApi).StridetermHost = { postMessage };
      const { wrapper } = mountBar();
      await wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']").setValue("prompt");
      await nextTick();
      window.dispatchEvent(new CustomEvent("strideterm:attachment-compose-open"));
      const opened = JSON.parse(postMessage.mock.calls.at(-1)![0]);
      expect(opened).toMatchObject({
        type: "attachment-compose",
        draft: "prompt",
        sessionId: SESSION_ID,
      });
      window.dispatchEvent(
        new CustomEvent("strideterm:attachment-compose-cancel", {
          detail: { requestId: opened.requestId },
        }),
      );
      window.dispatchEvent(new CustomEvent("strideterm:attachment-compose-open"));
      expect(postMessage.mock.calls.length).toBeGreaterThan(1);
      wrapper.unmount();
    });

    it("expands a collapsed bar after a native insert without sending", async () => {
      window.localStorage.setItem(COLLAPSED_KEY, "true");
      const postMessage = vi.fn();
      (window as AnyApi).StridetermHost = { postMessage };
      const { wrapper, writeTerminal } = mountBar();
      window.dispatchEvent(new CustomEvent("strideterm:attachment-compose-open"));
      const request = JSON.parse(postMessage.mock.calls.at(-1)![0]);
      window.dispatchEvent(
        new CustomEvent("strideterm:attachment-compose-result", {
          detail: {
            ...request,
            path: ".strideterm/attachments/123e4567-e89b-12d3-a456-426614174000/file.txt",
            prompt: request.draft,
            action: "insert",
          },
        }),
      );
      await nextTick();
      expect(wrapper.find("[data-role='mobile-input-bar-input']").exists()).toBe(true);
      expect(writeTerminal).not.toHaveBeenCalled();
      wrapper.unmount();
    });

    it("sends an attachment result through the normal composer routine", async () => {
      const postMessage = vi.fn();
      (window as AnyApi).StridetermHost = { postMessage };
      const { wrapper, submitTerminal } = mountBar();
      const input = wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']");
      await input.setValue("cat");
      await wrapper.get(".mobile-input-bar__key--attachment").trigger("click");
      const request = JSON.parse(postMessage.mock.calls[0][0]);
      window.dispatchEvent(
        new CustomEvent("strideterm:attachment-compose-result", {
          detail: {
            ...request,
            path: ".strideterm/attachments/123e4567-e89b-12d3-a456-426614174000/a.txt",
            prompt: "cat",
            action: "send",
          },
        }),
      );
      expect(submitTerminal).toHaveBeenCalledWith(
        SESSION_ID,
        'cat ".strideterm/attachments/123e4567-e89b-12d3-a456-426614174000/a.txt"',
        ORIGIN_WS,
      );
      expect(submitTerminal).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(200);
      expect(submitTerminal).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    });

    it("rejects a stale draft and acknowledges duplicate results without sending twice", async () => {
      const postMessage = vi.fn();
      (window as AnyApi).StridetermHost = { postMessage };
      const { wrapper, submitTerminal } = mountBar();
      const input = wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']");
      await input.setValue("old");
      await wrapper.get(".mobile-input-bar__key--attachment").trigger("click");
      const request = JSON.parse(postMessage.mock.calls[0][0]);
      await input.setValue("changed");
      const detail = {
        ...request,
        path: ".strideterm/attachments/123e4567-e89b-12d3-a456-426614174000/a.txt",
        prompt: "old",
        action: "send",
      };
      window.dispatchEvent(new CustomEvent("strideterm:attachment-compose-result", { detail }));
      expect(input.element.value).toBe("changed");
      expect(submitTerminal).not.toHaveBeenCalled();
      const count = postMessage.mock.calls.length;
      window.dispatchEvent(new CustomEvent("strideterm:attachment-compose-result", { detail }));
      expect(postMessage).toHaveBeenCalledTimes(count + 1);
      expect(JSON.parse(postMessage.mock.calls.at(-1)![0])).toMatchObject({
        type: "attachment-compose-ack",
        requestId: request.requestId,
        ok: false,
      });
      wrapper.unmount();
    });

    it("does not treat a reused request id with changed result data as a retry", async () => {
      const postMessage = vi.fn();
      (window as AnyApi).StridetermHost = { postMessage };
      const { wrapper, writeTerminal } = mountBar();
      await wrapper.get<HTMLTextAreaElement>("[data-role='mobile-input-bar-input']").setValue("cat");
      await wrapper.get(".mobile-input-bar__key--attachment").trigger("click");
      const request = JSON.parse(postMessage.mock.calls[0][0]);
      const result = {
        ...request,
        path: ".strideterm/attachments/123e4567-e89b-12d3-a456-426614174000/a.txt",
        prompt: "cat",
        action: "send",
      };
      window.dispatchEvent(new CustomEvent("strideterm:attachment-compose-result", { detail: result }));
      const before = writeTerminal.mock.calls.length;
      window.dispatchEvent(
        new CustomEvent("strideterm:attachment-compose-result", { detail: { ...result, action: "insert" } }),
      );
      expect(writeTerminal.mock.calls.length).toBe(before);
      expect(JSON.parse(postMessage.mock.calls.at(-1)![0])).toMatchObject({
        type: "attachment-compose-ack",
        ok: false,
      });
      wrapper.unmount();
    });

    it("submits the composed line once and schedules no delayed Enter", async () => {
      const { wrapper, writeTerminal, submitTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("echo mobile-composer");
      await wrapper.find("form").trigger("submit");

      expect(submitTerminal).toHaveBeenCalledTimes(1);
      expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "echo mobile-composer", ORIGIN_WS);
      expect(writeTerminal).not.toHaveBeenCalled();
      expect((input.element as HTMLTextAreaElement).value).toBe("");

      vi.advanceTimersByTime(200);
      expect(submitTerminal).toHaveBeenCalledTimes(1);
      expect(writeTerminal).not.toHaveBeenCalled();
    });

    it("preserves leading/trailing whitespace in the composed line", async () => {
      const { wrapper, submitTerminal } = mountBar();
      await wrapper.find("[data-role='mobile-input-bar-input']").setValue("ls ");
      await wrapper.find("form").trigger("submit");

      expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "ls ", ORIGIN_WS);
      vi.advanceTimersByTime(200);
      expect(submitTerminal).toHaveBeenCalledTimes(1);
    });

    it("sends a bare Enter immediately when the field is empty", async () => {
      const { wrapper, submitTerminal } = mountBar();
      await wrapper.find("form").trigger("submit");

      expect(submitTerminal).toHaveBeenCalledTimes(1);
      expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "", ORIGIN_WS);
      // Empty draft still submits an Enter in the backend's atomic operation.
      vi.advanceTimersByTime(500);
      expect(submitTerminal).toHaveBeenCalledTimes(1);
    });

    it("routes the delayed Enter to the session that received the text", async () => {
      const { wrapper, submitTerminal } = mountBar();
      const store = useAppStore();
      await wrapper.find("[data-role='mobile-input-bar-input']").setValue("echo hi");
      await wrapper.find("form").trigger("submit");
      expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "echo hi", ORIGIN_WS);

      // A later timer tick cannot route an extra Enter to either session.
      store.activeViewId = "ws-a:panel-other";
      store.activeSessionId = "ws-a:panel-other";
      await nextTick();

      vi.advanceTimersByTime(200);
      expect(submitTerminal).toHaveBeenCalledTimes(1);
    });

    it("sends the committed IME composition result", async () => {
      const { wrapper, submitTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      const element = input.element as HTMLTextAreaElement;

      await input.trigger("compositionstart");
      element.value = "prik";
      await input.trigger("input");
      element.value = "příkaz";
      await input.trigger("compositionend");
      await wrapper.find("form").trigger("submit");

      expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "příkaz", ORIGIN_WS);
      vi.advanceTimersByTime(200);
      expect(submitTerminal).toHaveBeenCalledTimes(1);
    });

    it("defers submit until the active IME composition commits", async () => {
      const { wrapper, submitTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      const element = input.element as HTMLTextAreaElement;

      await input.trigger("compositionstart");
      element.value = "prik";
      await input.trigger("input");
      await wrapper.find("form").trigger("submit");
      expect(submitTerminal).not.toHaveBeenCalled();

      element.value = "příkaz";
      await input.trigger("compositionend");
      await nextTick();

      expect(submitTerminal).toHaveBeenCalledTimes(1);
      expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "příkaz", ORIGIN_WS);
      vi.advanceTimersByTime(200);
      expect(submitTerminal).toHaveBeenCalledTimes(1);
    });

    it("clears a pending draft when the target session changes", async () => {
      const { wrapper, submitTerminal } = mountBar();
      const store = useAppStore();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("do not forward");

      store.activeViewId = "ws-a:panel-other";
      store.activeSessionId = "ws-a:panel-other";
      await nextTick();

      expect((input.element as HTMLTextAreaElement).value).toBe("");
      await wrapper.find("form").trigger("submit");
      expect(submitTerminal).toHaveBeenCalledWith("ws-a:panel-other", "", ORIGIN_WS);
    });
  });

  describe("⋯ menu", () => {
    // ← → and ^C moved off the top row into this menu, alongside Home/End/Ctrl+R/Ctrl+L.
    const MENU_KEYS: Array<[glyph: string, seq: string]> = [
      ["⌥↑", "\x1b[1;3A"],
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
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, seq, ORIGIN_WS);
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
      expect((input.element as HTMLTextAreaElement).value).toBe("/");
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
        expect((input.element as HTMLTextAreaElement).value).toBe(cmd);
        expect(writeTerminal).not.toHaveBeenCalled();
      },
    );

    it("Select text opens the panel for the session this bar writes to", async () => {
      const termStore = useTerminalStore();
      const request = vi.spyOn(termStore, "requestTextSelection").mockReturnValue(true);
      const { wrapper, writeTerminal } = mountBar();

      await wrapper.find("button.mobile-input-bar__key--more").trigger("click");
      await wrapper.find("[data-role='mobile-input-bar-select-text']").trigger("click");

      expect(request).toHaveBeenCalledWith(SESSION_ID);
      // Selecting text is not input: nothing may reach the shell.
      expect(writeTerminal).not.toHaveBeenCalled();
      expect(wrapper.find("button.mobile-input-bar__menu-item").exists()).toBe(false);
    });

    it("Select text follows a tab switch to the new target session", async () => {
      const termStore = useTerminalStore();
      const request = vi.spyOn(termStore, "requestTextSelection").mockReturnValue(true);
      const store = useAppStore();
      const { wrapper } = mountBar();
      store.activeViewId = "ws-a:panel-other";
      store.activeSessionId = "ws-a:panel-other";
      await nextTick();

      await wrapper.find("button.mobile-input-bar__key--more").trigger("click");
      await wrapper.find("[data-role='mobile-input-bar-select-text']").trigger("click");

      expect(request).toHaveBeenCalledWith("ws-a:panel-other");
    });

    it("says so instead of failing silently when the terminal can't be snapshotted", async () => {
      const termStore = useTerminalStore();
      vi.spyOn(termStore, "requestTextSelection").mockReturnValue(false);
      const toast = vi.spyOn(useNotificationStore(), "pushEphemeralToast").mockReturnValue("toast-1");
      const { wrapper } = mountBar();

      await wrapper.find("button.mobile-input-bar__key--more").trigger("click");
      await wrapper.find("[data-role='mobile-input-bar-select-text']").trigger("click");

      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Can't select text", kind: "error" }));
    });

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
      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, seq, ORIGIN_WS);
    });

    it.each([["Esc", "\x1b"]])("discards the local draft before sending cancel key %s", async (label, seq) => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("partial command");

      const button = wrapper.findAll("button.mobile-input-bar__key").find((b) => b.text() === label);
      await button!.trigger("click");

      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, seq, ORIGIN_WS);
      expect((input.element as HTMLTextAreaElement).value).toBe("");
    });

    it("does not restore a discarded IME draft after its compositionend event", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      const element = input.element as HTMLTextAreaElement;

      await input.trigger("compositionstart");
      element.value = "unfinished";
      await input.trigger("input");
      const esc = wrapper.findAll("button.mobile-input-bar__key").find((b) => b.text() === "Esc");
      await esc!.trigger("click");

      element.value = "unfinished";
      await input.trigger("compositionend");

      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "\x1b", ORIGIN_WS);
      expect(element.value).toBe("");
    });

    it("flushes the composed draft before sending Tab for shell completion", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("git che");

      const tab = wrapper.findAll("button.mobile-input-bar__key").find((b) => b.text() === "Tab");
      await tab!.trigger("click");

      expect(writeTerminal).toHaveBeenCalledWith(SESSION_ID, "git che\t", ORIGIN_WS);
      expect((input.element as HTMLTextAreaElement).value).toBe("");
    });
  });

  describe("slash key", () => {
    it("appends '/' to the draft without sending anything", async () => {
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("echo ");

      await wrapper.find(".mobile-input-bar__key--slash").trigger("click");

      expect((input.element as HTMLTextAreaElement).value).toBe("echo /");
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

      expect((input.element as HTMLTextAreaElement).value).toBe("sudo npm run dev");
      expect(writeTerminal).not.toHaveBeenCalled();
    });

    it("preserves line breaks from clipboard content", async () => {
      mockClipboard("line one\r\nline two\nline three");
      const { wrapper } = mountBar();

      await wrapper.find(PASTE).trigger("click");
      await flushPromises();

      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      expect((input.element as HTMLTextAreaElement).value).toBe("line one\nline two\nline three");
    });

    it("leaves the draft untouched when the clipboard read is blocked", async () => {
      mockClipboard(null);
      const { wrapper, writeTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      await input.setValue("keep me");

      await wrapper.find(PASTE).trigger("click");
      await flushPromises();

      expect((input.element as HTMLTextAreaElement).value).toBe("keep me");
      expect(writeTerminal).not.toHaveBeenCalled();
    });

    it("commits an active IME composition before appending", async () => {
      mockClipboard("pasted");
      const { wrapper, submitTerminal } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      const element = input.element as HTMLTextAreaElement;

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
      expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "prikpasted", ORIGIN_WS);
    });
  });

  describe("password-manager autofill", () => {
    // Mobile password managers classify the single-field composer form as a
    // login, offer to save what gets sent, and autofill the remembered value
    // back on the next page load — text the user never typed, one ⏎ from the
    // PTY. The field opts out declaratively and drops foreign values as a
    // backstop for managers that ignore the attributes.
    it("keeps keyboard predictions enabled while opting out of password managers", () => {
      const { wrapper } = mountBar();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");

      expect(wrapper.find("form").attributes("autocomplete")).toBe("off");
      expect(input.attributes("autocomplete")).toBe("on");
      expect(input.attributes("autocorrect")).toBe("on");
      expect(input.attributes("spellcheck")).toBe("true");
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
        const { wrapper, submitTerminal } = mountBar();
        const input = wrapper.find("[data-role='mobile-input-bar-input']");
        // Autofill sets the value and dispatches input, exactly like setValue.
        await input.setValue("Ahoj");

        vi.advanceTimersByTime(600);
        await nextTick();

        expect((input.element as HTMLTextAreaElement).value).toBe("");
        // The foreign value is gone from the draft too — ⏎ sends a bare Enter.
        await wrapper.find("form").trigger("submit");
        expect(submitTerminal).toHaveBeenCalledTimes(1);
        expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "", ORIGIN_WS);
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

        expect((wrapper.find("[data-role='mobile-input-bar-input']").element as HTMLTextAreaElement).value).toBe(
          expected,
        );
      });

      it("keeps text typed into the field after the user focused it", async () => {
        const { wrapper, submitTerminal } = mountBar();
        const input = wrapper.find("[data-role='mobile-input-bar-input']");
        await input.trigger("focus");
        await input.setValue("echo typed");

        vi.advanceTimersByTime(600);
        await nextTick();

        expect((input.element as HTMLTextAreaElement).value).toBe("echo typed");
        await wrapper.find("form").trigger("submit");
        expect(submitTerminal).toHaveBeenCalledWith(SESSION_ID, "echo typed", ORIGIN_WS);
      });
    });
  });

  describe("the unsent draft survives a re-bootstrap", () => {
    // Production hardening §5 "Session" 6: the mobile app tears the relay session down after a grace
    // period in the background and re-bootstraps on return — a full page load. What the user was
    // typing has to come back, and it has to come back as a DRAFT: nothing may be written to the PTY
    // without a new action from them.
    it("restores what was typed after the page is reloaded, and sends nothing on its own", async () => {
      const first = mountBar();
      const input = first.wrapper.find("textarea");
      await input.setValue("git rebase -i HEAD~3");
      await nextTick();
      first.wrapper.unmount();

      // A brand-new component, as after a reload: same session, same origin, new page.
      const second = mountBar();
      await nextTick();
      expect((second.wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("git rebase -i HEAD~3");
      expect(second.writeTerminal).not.toHaveBeenCalled();

      // And submitting is what sends it — the draft was one deliberate action away, not zero. (The
      // Enter follows as its own delayed write; the "composing and sending" suite covers that half.)
      await second.wrapper.find("form").trigger("submit");
      expect(second.submitTerminal).toHaveBeenCalledWith(SESSION_ID, "git rebase -i HEAD~3", ORIGIN_WS);
    });

    it("keeps one session's draft out of another session's field", async () => {
      const first = mountBar();
      await first.wrapper.find("textarea").setValue("only for the shell panel");
      await nextTick();
      first.wrapper.unmount();

      const second = mountBar({ sessionId: "ws-a:panel-other" });
      await nextTick();
      expect((second.wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("");
    });

    it("a draft cleared by sending is not resurrected by the next mount", async () => {
      const first = mountBar();
      await first.wrapper.find("textarea").setValue("echo done");
      await nextTick();
      await first.wrapper.find("form").trigger("submit");
      await nextTick();
      first.wrapper.unmount();

      const second = mountBar();
      await nextTick();
      expect((second.wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("");
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
      expect(document.activeElement).not.toBe(wrapper.find("[data-role='mobile-input-bar-input']").element);
    });

    it("does not autofocus the editor after expanding", async () => {
      window.localStorage.setItem(COLLAPSED_KEY, "1");
      const { wrapper } = mountBar();

      await wrapper.find(".mobile-input-bar__expand").trigger("click");
      await nextTick();
      const input = wrapper.find("[data-role='mobile-input-bar-input']");
      expect(document.activeElement).not.toBe(input.element);
      expect(input.attributes()).not.toHaveProperty("autofocus");
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
    const submitTerminal = vi.fn();
    const wrapper = mount(MobileInputBar, {
      global: { provide: { [apiKey]: { isRemote: true, writeTerminal, submitTerminal } as AnyApi } },
    });
    await flushPromises();

    const input = wrapper.find("textarea");
    expect(input.exists()).toBe(true);
    await input.setValue("hello");
    await wrapper.find("form").trigger("submit");
    await nextTick();

    // The virtual view id must never reach the PTY layer — and the write is
    // credited to the TASK workspace the user is actually typing in, not to
    // the source workspace that happens to own the session (V2 plan, Fáze 3).
    expect(submitTerminal).toHaveBeenCalledWith("ws-source:panel-primary", "hello", "ws-task");
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

    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(writeTerminal).not.toHaveBeenCalled();
  });
});
