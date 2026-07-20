/**
 * Wiring coverage for useNotificationDockResize's usePanelResize configuration
 * plus its own distinct logic: the `watch(notifStore.pinned)` block (lines
 * 34-45) that restores the saved dock width and clamps it to effectiveMax()
 * whenever the dock becomes pinned. usePanelResize.test.ts already covers the
 * generic drag/clamp mechanics in isolation, so this file focuses on what's
 * unique to this consumer: the notifStore.pinned canResize gate and the
 * restore-on-pin watcher.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, nextTick, shallowRef } from "vue";
import { useNotificationDockResize } from "./useNotificationDockResize.js";
import { useNotificationStore } from "../stores/notifications.js";

let liveWrappers: VueWrapper[] = [];

afterEach(() => {
  liveWrappers.forEach((w) => w.unmount());
  liveWrappers = [];
  document.body.innerHTML = "";
  window.localStorage.clear();
});

function stubWidth(el: HTMLElement, width: number) {
  el.getBoundingClientRect = () => ({ width }) as DOMRect;
}

function dispatchOn(target: EventTarget, type: string, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

function buildHarness() {
  const frameEl = document.createElement("div");
  const handleEl = document.createElement("div");
  handleEl.dataset.role = "notif-dock-resize-handle";
  const panelEl = document.createElement("div");
  panelEl.className = "notification-center--pinned";
  stubWidth(panelEl, 300);
  document.body.append(frameEl, handleEl, panelEl);

  const Host = defineComponent({
    setup() {
      const frameRef = shallowRef<HTMLElement | null>(frameEl);
      useNotificationDockResize(frameRef);
      return () => h("div");
    },
  });

  const wrapper = mount(Host);
  liveWrappers.push(wrapper);

  return { frameEl, handleEl, panelEl };
}

describe("useNotificationDockResize", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  test("canResize is gated on notifStore.pinned — dragging while unpinned is a no-op", () => {
    const store = useNotificationStore();
    store.pinned = false;
    const { frameEl, handleEl } = buildHarness();

    dispatchOn(handleEl, "mousedown", { clientX: 100 });
    dispatchOn(window, "mousemove", { clientX: 500 });

    expect(frameEl.style.getPropertyValue("--notif-dock-width")).toBe("");
  });

  test("once pinned, dragging resizes with invert semantics and persists on mouseup", () => {
    const store = useNotificationStore();
    store.pinned = true;
    const { frameEl, handleEl, panelEl } = buildHarness();

    dispatchOn(handleEl, "mousedown", { clientX: 200 });
    // invert:true => startX(200) - clientX(150) = 50 => 300 + 50 = 350
    dispatchOn(window, "mousemove", { clientX: 150 });
    expect(frameEl.style.getPropertyValue("--notif-dock-width")).toBe("350px");

    stubWidth(panelEl, 350);
    dispatchOn(window, "mouseup");
    expect(window.localStorage.getItem("strideterm-notif-dock-width")).toBe("350");
  });

  test("becoming pinned restores the saved width from localStorage, clamped to effectiveMax", async () => {
    // DOCK_MAX_PX is 600, further capped to 40% of the viewport width; jsdom's
    // default innerWidth is 1024, so effectiveMax() = min(600, floor(1024*0.4)) = 409.
    // 300 is comfortably under that, so it should be restored unclamped.
    window.localStorage.setItem("strideterm-notif-dock-width", "300");
    const store = useNotificationStore();
    store.pinned = false;
    const { frameEl } = buildHarness();

    expect(frameEl.style.getPropertyValue("--notif-dock-width")).toBe("");

    store.pinned = true;
    await nextTick();

    expect(frameEl.style.getPropertyValue("--notif-dock-width")).toBe("300px");
  });

  test("a saved width above effectiveMax() is clamped down when restored", async () => {
    // readNotificationDockWidth() accepts persisted values up to 1200, but
    // effectiveMax() here is min(600, floor(1024*0.4)) = 409 — so a valid
    // saved value can still exceed the current viewport-capped max.
    window.localStorage.setItem("strideterm-notif-dock-width", "1000");
    const store = useNotificationStore();
    store.pinned = false;
    const { frameEl } = buildHarness();

    store.pinned = true;
    await nextTick();

    const expectedMax = Math.min(600, Math.floor((window.innerWidth || 1200) * 0.4));
    expect(frameEl.style.getPropertyValue("--notif-dock-width")).toBe(`${expectedMax}px`);
  });

  test("the watch fires immediately on mount when the dock starts out already pinned", () => {
    window.localStorage.setItem("strideterm-notif-dock-width", "280");
    const store = useNotificationStore();
    store.pinned = true;
    const { frameEl } = buildHarness();

    expect(frameEl.style.getPropertyValue("--notif-dock-width")).toBe("280px");
  });

  test("becoming pinned with no saved width does not touch the CSS var", () => {
    const store = useNotificationStore();
    store.pinned = false;
    const { frameEl } = buildHarness();

    store.pinned = true;

    expect(frameEl.style.getPropertyValue("--notif-dock-width")).toBe("");
  });

  test("unpinning is a no-op for the restore watcher", async () => {
    window.localStorage.setItem("strideterm-notif-dock-width", "280");
    const store = useNotificationStore();
    store.pinned = true;
    const { frameEl } = buildHarness();
    expect(frameEl.style.getPropertyValue("--notif-dock-width")).toBe("280px");

    frameEl.style.setProperty("--notif-dock-width", "123px");
    store.pinned = false;
    await nextTick();

    expect(frameEl.style.getPropertyValue("--notif-dock-width")).toBe("123px");
  });
});
