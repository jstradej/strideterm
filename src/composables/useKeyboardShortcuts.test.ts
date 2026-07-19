/**
 * `handleKeydown` is registered directly as a raw `keydown` DOM listener, so
 * any rejection from an awaited store/transport call inside it has nowhere
 * useful to go — DOM listeners don't propagate promise rejections. These
 * tests lock down the fix: the whole handler body is wrapped so a rejection
 * is caught, logged via `rlog`, and surfaced as a toast instead of vanishing
 * silently mid-keystroke.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts.js";
import { useAppStore } from "../stores/app.js";
import { rlog } from "../lib/renderer-log.js";

vi.mock("../lib/renderer-log.js", () => ({
  rlog: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function buildApi(overrides: AnyApi = {}): AnyApi {
  return {
    restartTerminal: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function mountHarness(api: AnyApi) {
  return mount(
    defineComponent({
      setup() {
        useKeyboardShortcuts(api);
        return () => h("div");
      },
    }),
  );
}

function dispatchKeydown(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

// Flush the microtask queue enough times for handleKeydown's inner await
// chain (handleKeydownInner's await -> the rejection -> the outer catch) to
// settle.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("useKeyboardShortcuts — unhandled rejection guard", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  test("Ctrl+R: a rejecting api.restartTerminal() is caught and logged, not thrown", async () => {
    const api = buildApi({ restartTerminal: vi.fn().mockRejectedValue(new Error("restart failed")) });
    const appStore = useAppStore();
    appStore.activeSessionId = "workspace-1:panel-1";
    const wrapper = mountHarness(api);

    expect(() => {
      dispatchKeydown({ key: "r", ctrlKey: true });
    }).not.toThrow();

    await flushMicrotasks();

    expect(api.restartTerminal).toHaveBeenCalledWith("workspace-1:panel-1");
    expect(rlog).toHaveBeenCalledWith(
      "error",
      "[keyboard-shortcut] handler failed",
      expect.objectContaining({ key: "r", error: "restart failed" }),
    );

    wrapper.unmount();
  });

  test("Ctrl+1: a rejecting appStore.activateWorkspaceInGrid() is caught and logged, not thrown", async () => {
    const api = buildApi();
    const appStore = useAppStore();
    appStore.payload = {
      appState: {
        workspaces: [{ id: "ws-1", name: "WS1", panels: [] }],
      },
    } as AnyApi;
    appStore.activateWorkspaceInGrid = vi.fn().mockRejectedValue(new Error("activate failed"));
    const wrapper = mountHarness(api);

    expect(() => {
      dispatchKeydown({ code: "Digit1", ctrlKey: true });
    }).not.toThrow();

    await flushMicrotasks();

    expect(appStore.activateWorkspaceInGrid).toHaveBeenCalledWith("ws-1");
    expect(rlog).toHaveBeenCalledWith(
      "error",
      "[keyboard-shortcut] handler failed",
      expect.objectContaining({ code: "Digit1", error: "activate failed" }),
    );

    wrapper.unmount();
  });
});
