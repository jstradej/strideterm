/**
 * Wiring coverage for useSidebarResize's usePanelResize configuration —
 * usePanelResize.test.ts already exhaustively covers the generic drag/clamp/
 * collapse mechanics in isolation; this file locks down the sidebar-specific
 * config (constants, the appStore.sidebarCollapsed collapse gate, and
 * writeSidebarWidth persistence) through the real composable.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, shallowRef } from "vue";
import { useSidebarResize } from "./useSidebarResize.js";
import { useAppStore } from "../stores/app.js";

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
  handleEl.dataset.role = "sidebar-resize-handle";
  const sidebarEl = document.createElement("div");
  stubWidth(sidebarEl, 300);
  document.body.append(frameEl, handleEl, sidebarEl);

  const Host = defineComponent({
    setup() {
      const frameRef = shallowRef<HTMLElement | null>(frameEl);
      const sidebarRef = shallowRef<HTMLElement | null>(sidebarEl);
      useSidebarResize(frameRef, sidebarRef);
      return () => h("div");
    },
  });

  const wrapper = mount(Host);
  liveWrappers.push(wrapper);

  return { frameEl, handleEl, sidebarEl };
}

describe("useSidebarResize", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  test("drags the sidebar within the configured min/max and persists via writeSidebarWidth", () => {
    const { frameEl, handleEl, sidebarEl } = buildHarness();
    stubWidth(sidebarEl, 300);

    dispatchOn(handleEl, "mousedown", { clientX: 100 });
    dispatchOn(window, "mousemove", { clientX: 40 }); // 300 - 60 = 240, within [180, 600]
    expect(frameEl.style.getPropertyValue("--sidebar-width")).toBe("240px");

    // 300 - 150 = 150: below SIDEBAR_MIN(180) but still above COLLAPSE_THRESHOLD(100),
    // so it clamps to the min instead of triggering the collapse branch.
    dispatchOn(window, "mousemove", { clientX: -50 });
    expect(frameEl.style.getPropertyValue("--sidebar-width")).toBe("180px");

    stubWidth(sidebarEl, 180);
    dispatchOn(window, "mouseup");
    expect(window.localStorage.getItem("strideterm-sidebar-width")).toBe("180");
  });

  test("dragging below COLLAPSE_THRESHOLD(100) sets appStore.sidebarCollapsed instead of resizing", () => {
    const store = useAppStore();
    expect(store.sidebarCollapsed).toBe(false);
    const { frameEl, handleEl } = buildHarness();

    dispatchOn(handleEl, "mousedown", { clientX: 500 });
    dispatchOn(window, "mousemove", { clientX: 150 }); // 300 - 350 = -50, below threshold(100)

    expect(store.sidebarCollapsed).toBe(true);
    expect(frameEl.style.getPropertyValue("--sidebar-width")).toBe("");
  });

  test("dragging back above the threshold un-collapses and resumes resizing", () => {
    const store = useAppStore();
    store.sidebarCollapsed = true;
    const { frameEl, handleEl } = buildHarness();

    dispatchOn(handleEl, "mousedown", { clientX: 500 });
    // startWidth falls back to collapsedFallbackWidth(84) since collapse.get() is true
    // and the frame has no --sidebar-collapsed-width computed style in jsdom.
    dispatchOn(window, "mousemove", { clientX: 700 }); // 84 + 200 = 284, above threshold(100)

    expect(store.sidebarCollapsed).toBe(false);
    expect(frameEl.style.getPropertyValue("--sidebar-width")).toBe("284px");
  });

  test("double-click resets to SIDEBAR_DEFAULT(248) and persists it", () => {
    const { frameEl, handleEl } = buildHarness();

    dispatchOn(handleEl, "dblclick");

    expect(frameEl.style.getPropertyValue("--sidebar-width")).toBe("248px");
    expect(window.localStorage.getItem("strideterm-sidebar-width")).toBe("248");
  });
});
