/**
 * Touch selection fallback for terminals without a tab menu.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const controllerOptions = vi.hoisted(() => ({ outputSessions: null as Set<string> | null }));
vi.mock("../../app/terminal-controller.js", () => ({
  createTerminalController: (options: { outputSessions: Set<string> }) => {
    controllerOptions.outputSessions = options.outputSessions;
    return {
      attachTerminalPane: vi.fn(),
      detachTerminalPane: vi.fn(),
      syncTheme: vi.fn(),
      syncFontSize: vi.fn(),
      scheduleAllVisibleResize: vi.fn(),
      syncRemoteFocus: vi.fn(),
    };
  },
}));
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import TerminalPane from "./TerminalPane.vue";
import { useTerminalStore } from "../../stores/terminal.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const SESSION_ID = "ws-a:panel-shell";
const COARSE = "(any-pointer: coarse)";

// useIsNarrow seeds its shared refs at import time and re-reads matchMedia in
// onMounted, so the media-query override only reaches the DOM on the next tick.
async function mountPane(textSelectionInMenu = false): Promise<VueWrapper> {
  const wrapper = mount(TerminalPane, {
    props: { sessionId: SESSION_ID, textSelectionInMenu },
    attachTo: document.body,
  });
  await nextTick();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TerminalPane select-text control", () => {
  it("is offered on touchscreens when the pane has no selection menu", async () => {
    globalThis.setMatchMediaResult(COARSE, true);
    const wrapper = await mountPane();

    expect(wrapper.find("[data-role='terminal-select-text']").exists()).toBe(true);
  });

  it("keeps the terminal output clear when Select text is available in the tab menu", async () => {
    globalThis.setMatchMediaResult(COARSE, true);
    const wrapper = await mountPane(true);

    expect(wrapper.find("[data-role='terminal-select-text']").exists()).toBe(false);
  });

  it("stays out of the way on a pointer-only machine", async () => {
    globalThis.setMatchMediaResult(COARSE, false);
    const wrapper = await mountPane();

    expect(wrapper.find("[data-role='terminal-select-text']").exists()).toBe(false);
  });

  it("opens the panel for this pane's own session", async () => {
    globalThis.setMatchMediaResult(COARSE, true);
    const termStore = useTerminalStore();
    const request = vi.spyOn(termStore, "requestTextSelection").mockReturnValue(true);
    const wrapper = await mountPane();

    await wrapper.find("[data-role='terminal-select-text']").trigger("click");

    expect(request).toHaveBeenCalledWith(SESSION_ID);
  });

  it("carries a label a screen reader can announce", async () => {
    globalThis.setMatchMediaResult(COARSE, true);
    const wrapper = await mountPane();

    const button = wrapper.find("[data-role='terminal-select-text']");
    expect(button.attributes("aria-label")).toBe("Select text from this terminal");
    expect(button.attributes("title")).toContain("Long-pressing the terminal does the same");
  });
});

describe("TerminalPane starting indicator", () => {
  function initStore() {
    const termStore = useTerminalStore();
    termStore.init(
      { isRemote: false, onTerminalData: vi.fn(), onTerminalReplay: vi.fn(), onTerminalExit: vi.fn() } as AnyApi,
      {},
      { getActiveSessionId: () => null, getOverlay: () => null, getPayload: () => null },
    );
  }

  async function mountStarting(startingAllowed: boolean): Promise<VueWrapper> {
    const wrapper = mount(TerminalPane, {
      props: { sessionId: SESSION_ID, startingAllowed },
      attachTo: document.body,
    });
    await nextTick();
    return wrapper;
  }

  it("shows a spinner while a running session has produced no output, then hides it", async () => {
    initStore();
    const wrapper = await mountStarting(true);
    expect(wrapper.find("[data-role='terminal-starting']").text()).toContain("Starting");

    controllerOptions.outputSessions!.add(SESSION_ID);
    await nextTick();
    expect(wrapper.find("[data-role='terminal-starting']").exists()).toBe(false);
  });

  it("stays hidden for a session that is not running", async () => {
    initStore();
    const wrapper = await mountStarting(false);
    expect(wrapper.find("[data-role='terminal-starting']").exists()).toBe(false);
  });
});
