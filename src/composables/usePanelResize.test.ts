import { describe, expect, test, vi, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, shallowRef } from "vue";
import { usePanelResize } from "./usePanelResize.js";
import type { UsePanelResizeOptions } from "./usePanelResize.js";

// usePanelResize registers its listeners on `document`/`window` (not scoped to
// the component's own root), so every harness built in a test MUST be
// unmounted afterwards or its listeners leak into later tests and double-fire.
let liveWrappers: VueWrapper[] = [];

afterEach(() => {
  liveWrappers.forEach((w) => w.unmount());
  liveWrappers = [];
  document.body.innerHTML = "";
});

function stubWidth(el: HTMLElement, width: number) {
  el.getBoundingClientRect = () => ({ width }) as DOMRect;
}

function dispatchOn(target: EventTarget, type: string, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

function buildHarness(overrides: Partial<UsePanelResizeOptions> = {}) {
  const frameEl = document.createElement("div");
  const handleEl = document.createElement("div");
  handleEl.dataset.role = "test-resize-handle";
  const measureEl = document.createElement("div");
  stubWidth(measureEl, 300);
  document.body.append(frameEl, handleEl, measureEl);

  const writeWidth = vi.fn();
  let effectiveMax: (() => number) | null = null;

  const Host = defineComponent({
    setup() {
      const frameRef = shallowRef<HTMLElement | null>(frameEl);
      const result = usePanelResize({
        frameRef,
        cssVar: "--test-width",
        handleRole: "test-resize-handle",
        min: 100,
        max: 500,
        // 1 so effectiveMax() reduces to plain `max` regardless of jsdom's innerWidth.
        maxViewportRatio: 1,
        defaultWidth: 250,
        getMeasureEl: () => measureEl,
        writeWidth,
        ...overrides,
      });
      effectiveMax = result.effectiveMax;
      return () => h("div");
    },
  });

  const wrapper = mount(Host);
  liveWrappers.push(wrapper);

  return {
    frameEl,
    handleEl,
    measureEl,
    writeWidth,
    getEffectiveMax: () => effectiveMax!(),
  };
}

describe("usePanelResize", () => {
  test("mousedown on the handle starts a drag; mousemove writes the clamped width to the CSS var", () => {
    const { frameEl, handleEl } = buildHarness();

    dispatchOn(handleEl, "mousedown", { clientX: 100 });
    dispatchOn(window, "mousemove", { clientX: 140 }); // startWidth(300) + 40

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("340px");
  });

  test("mousemove before any mousedown is a no-op", () => {
    const { frameEl } = buildHarness();

    dispatchOn(window, "mousemove", { clientX: 500 });

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("");
  });

  test("clamps the resolved width to the configured minimum", () => {
    const { frameEl, handleEl } = buildHarness({ min: 150 });

    dispatchOn(handleEl, "mousedown", { clientX: 100 });
    dispatchOn(window, "mousemove", { clientX: -100 }); // 300 - 200 = 100, below min(150)

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("150px");
  });

  test("clamps the resolved width to the configured maximum", () => {
    const { frameEl, handleEl } = buildHarness({ max: 400 });

    dispatchOn(handleEl, "mousedown", { clientX: 100 });
    dispatchOn(window, "mousemove", { clientX: 900 }); // 300 + 800 = 1100, above max(400)

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("400px");
  });

  test("invert:true grows the panel when dragging toward negative X", () => {
    const { frameEl, handleEl } = buildHarness({ invert: true });

    dispatchOn(handleEl, "mousedown", { clientX: 200 });
    dispatchOn(window, "mousemove", { clientX: 150 }); // startX(200) - clientX(150) = 50 => 300+50

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("350px");
  });

  test("mouseup ends the drag and persists the currently measured (rounded) width", () => {
    const { handleEl, measureEl, writeWidth } = buildHarness();

    dispatchOn(handleEl, "mousedown", { clientX: 100 });
    dispatchOn(window, "mousemove", { clientX: 140 });
    // Simulate layout having caught up to the CSS var by the time mouseup fires.
    stubWidth(measureEl, 340.6);
    dispatchOn(window, "mouseup");

    expect(writeWidth).toHaveBeenCalledWith(341);
  });

  test("mouseup with no active drag does not persist anything", () => {
    const { writeWidth } = buildHarness();

    dispatchOn(window, "mouseup");

    expect(writeWidth).not.toHaveBeenCalled();
  });

  test("double-click resets to the default width and persists it", () => {
    const { frameEl, handleEl, writeWidth } = buildHarness({ defaultWidth: 275 });

    dispatchOn(handleEl, "dblclick");

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("275px");
    expect(writeWidth).toHaveBeenCalledWith(275);
  });

  test("canResize() gates mousedown — a false gate blocks the drag entirely", () => {
    const { frameEl, handleEl } = buildHarness({ canResize: () => false });

    dispatchOn(handleEl, "mousedown", { clientX: 100 });
    dispatchOn(window, "mousemove", { clientX: 500 });

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("");
  });

  test("collapse: dragging below the threshold flips collapsed instead of writing the CSS var", () => {
    let collapsed = false;
    const { frameEl, handleEl } = buildHarness({
      collapse: {
        threshold: 100,
        get: () => collapsed,
        set: (v) => {
          collapsed = v;
        },
        collapsedCssVar: "--test-collapsed-width",
        collapsedFallbackWidth: 84,
      },
    });

    dispatchOn(handleEl, "mousedown", { clientX: 100 });
    dispatchOn(window, "mousemove", { clientX: -250 }); // 300 - 350 = -50, below threshold(100)

    expect(collapsed).toBe(true);
    expect(frameEl.style.getPropertyValue("--test-width")).toBe("");
  });

  test("max is additionally capped by maxViewportRatio via effectiveMax()", () => {
    const { getEffectiveMax } = buildHarness({ max: 1000, maxViewportRatio: 0.4 });

    const vw = window.innerWidth || 1200;
    expect(getEffectiveMax()).toBe(Math.min(1000, Math.floor(vw * 0.4)));
  });
});
