/**
 * The pane-level entry point into the "Select text" panel.
 *
 * The long press does the same job, but a gesture nobody was told about is not
 * a discoverable feature — and the MobileInputBar that carries the menu entry
 * only renders on the remote transport, so a tablet driving the desktop build
 * (or any touchscreen laptop) would otherwise have no visible way in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
async function mountPane(): Promise<VueWrapper> {
  const wrapper = mount(TerminalPane, { props: { sessionId: SESSION_ID }, attachTo: document.body });
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
  it("is offered on any device with a touchscreen", async () => {
    globalThis.setMatchMediaResult(COARSE, true);
    const wrapper = await mountPane();

    expect(wrapper.find("[data-role='terminal-select-text']").exists()).toBe(true);
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
