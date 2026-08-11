import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";
import { useGlobalEvents } from "./useGlobalEvents.js";
import { useTerminalStore } from "../stores/terminal.js";
import { isMobileViewport } from "./useIsNarrow.js";

/**
 * useGlobalEvents wires window/document listeners that force xterm panes
 * to re-fit when the viewport changes. The tests here lock down the two
 * mobile-specific paths added to fix the "blank terminal on mobile" bug:
 *
 *  - orientationchange schedules the same deferred fits as a mobile breakpoint
 *    flip (Android WebViews that don't fire window.resize on rotation)
 *  - flipping isMobileViewport (desktop↔mobile breakpoint cross) re-fits
 *    after the layout has settled (RAF + 120ms + 300ms), not just on the
 *    single window.resize tick that fires before reflow finishes
 *
 * The desktop-only paths (resize, focus, visibilitychange, visualViewport)
 * are simpler and intentionally not retested here — they predate this fix.
 */

const Host = defineComponent({
  setup() {
    useGlobalEvents();
    return () => h("div");
  },
});

describe("useGlobalEvents — mobile transitions", () => {
  let scheduleSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    isMobileViewport.value = false;
    const store = useTerminalStore();
    scheduleSpy = vi.fn();
    // Pretend at least one terminal is open so the gate inside useGlobalEvents
    // (`if (termStore.views.size > 0)`) is satisfied without spinning up a real
    // controller. Pinia setup stores expose `views` already unwrapped from the
    // shallowRef, so we work with the Map directly.
    (store.views as unknown as Map<string, unknown>).set("sid", {});
    store.scheduleAllVisibleResize = scheduleSpy as unknown as typeof store.scheduleAllVisibleResize;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("orientationchange schedules deferred visible-pane re-fits", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const wrapper = mount(Host);

    window.dispatchEvent(new Event("orientationchange"));

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120);
    expect(scheduleSpy).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(180);
    expect(scheduleSpy).toHaveBeenCalledTimes(3);

    rafSpy.mockRestore();
    wrapper.unmount();
  });

  test("isMobileViewport flip schedules three deferred fits (RAF + 120ms + 300ms)", async () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const wrapper = mount(Host);

    isMobileViewport.value = true;
    // Wait for Vue's reactivity to flush the watcher.
    await Promise.resolve();

    // RAF callback fired synchronously via the mock above.
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(120);
    expect(scheduleSpy).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(180); // total 300ms since flip
    expect(scheduleSpy).toHaveBeenCalledTimes(3);

    rafSpy.mockRestore();
    wrapper.unmount();
  });

  test("unmount cancels pending deferred mobile-transition fits", async () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const wrapper = mount(Host);

    isMobileViewport.value = true;
    await Promise.resolve();

    // RAF fit already fired; unmount before the 120ms/300ms timeouts run.
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    wrapper.unmount();

    vi.advanceTimersByTime(500);
    // No further calls — timeouts were cleared by the unmount cleanup.
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    rafSpy.mockRestore();
  });

  test("listeners are removed on unmount (orientationchange is a no-op after)", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const wrapper = mount(Host);
    wrapper.unmount();

    window.dispatchEvent(new Event("orientationchange"));
    expect(scheduleSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(scheduleSpy).not.toHaveBeenCalled();

    rafSpy.mockRestore();
  });
});

describe("useGlobalEvents — empty-store guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    isMobileViewport.value = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("orientationchange is a no-op when no terminals are mounted", () => {
    const store = useTerminalStore();
    const spy = vi.fn();
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    store.scheduleAllVisibleResize = spy as unknown as typeof store.scheduleAllVisibleResize;
    // views.size === 0 by default

    const wrapper = mount(Host);
    window.dispatchEvent(new Event("orientationchange"));

    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(spy).not.toHaveBeenCalled();

    rafSpy.mockRestore();
    wrapper.unmount();
  });
});

describe("useGlobalEvents — hidden-window animation freeze", () => {
  function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    isMobileViewport.value = false;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.documentElement.classList.remove("app-hidden");
  });

  test("hiding the window adds app-hidden, showing it again removes it", () => {
    const wrapper = mount(Host);

    setVisibility("hidden");
    expect(document.documentElement.classList.contains("app-hidden")).toBe(true);

    setVisibility("visible");
    expect(document.documentElement.classList.contains("app-hidden")).toBe(false);

    wrapper.unmount();
  });

  test("mounting while already hidden marks the document immediately", () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });

    const wrapper = mount(Host);

    expect(document.documentElement.classList.contains("app-hidden")).toBe(true);

    wrapper.unmount();
  });

  test("unmount clears the class so a torn-down app never leaves animations frozen", () => {
    const wrapper = mount(Host);
    setVisibility("hidden");

    wrapper.unmount();

    expect(document.documentElement.classList.contains("app-hidden")).toBe(false);
  });
});

describe("useGlobalEvents — desktop window:visibility bridge", () => {
  // Electron pins document.visibilityState to "visible" while
  // backgroundThrottling is disabled, so the desktop path must work with the
  // document reporting "visible" the entire time.
  let emit: (payload: { hidden: boolean }) => void;

  beforeEach(() => {
    setActivePinia(createPinia());
    isMobileViewport.value = false;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.documentElement.classList.remove("app-hidden");
    (window as unknown as { strideterm?: unknown }).strideterm = {
      onWindowVisibility: (handler: (payload: { hidden: boolean }) => void) => {
        emit = handler;
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { strideterm?: unknown }).strideterm;
  });

  test("minimize freezes animations even though the document still reports visible", () => {
    const wrapper = mount(Host);

    emit({ hidden: true });
    expect(document.visibilityState).toBe("visible");
    expect(document.documentElement.classList.contains("app-hidden")).toBe(true);

    emit({ hidden: false });
    expect(document.documentElement.classList.contains("app-hidden")).toBe(false);

    wrapper.unmount();
  });

  test("a visible document does not un-freeze a minimized window", () => {
    const wrapper = mount(Host);

    emit({ hidden: true });
    // Any unrelated visibilitychange must not clear the window's own state.
    document.dispatchEvent(new Event("visibilitychange"));

    expect(document.documentElement.classList.contains("app-hidden")).toBe(true);

    wrapper.unmount();
  });

  test("restoring re-fits visible panes", () => {
    const store = useTerminalStore();
    const spy = vi.fn();
    (store.views as unknown as Map<string, unknown>).set("sid", {});
    store.scheduleAllVisibleResize = spy as unknown as typeof store.scheduleAllVisibleResize;

    const wrapper = mount(Host);
    emit({ hidden: true });
    expect(spy).not.toHaveBeenCalled();

    emit({ hidden: false });
    expect(spy).toHaveBeenCalled();

    wrapper.unmount();
  });
});
