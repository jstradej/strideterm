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

function dispatchPointer(target: EventTarget, type: string, init: PointerEventInit = {}) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init }));
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

    dispatchPointer(handleEl, "pointerdown", { clientX: 100, pointerType: "mouse", button: 0 });
    dispatchPointer(window, "pointermove", { clientX: 140, pointerType: "mouse" }); // startWidth(300) + 40

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("340px");
  });

  test("pointermove before any pointerdown is a no-op", () => {
    const { frameEl } = buildHarness();

    dispatchPointer(window, "pointermove", { clientX: 500 });

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("");
  });

  test("clamps the resolved width to the configured minimum", () => {
    const { frameEl, handleEl } = buildHarness({ min: 150 });

    dispatchPointer(handleEl, "pointerdown", { clientX: 100 });
    dispatchPointer(window, "pointermove", { clientX: -100 }); // 300 - 200 = 100, below min(150)

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("150px");
  });

  test("clamps the resolved width to the configured maximum", () => {
    const { frameEl, handleEl } = buildHarness({ max: 400 });

    dispatchPointer(handleEl, "pointerdown", { clientX: 100 });
    dispatchPointer(window, "pointermove", { clientX: 900 }); // 300 + 800 = 1100, above max(400)

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("400px");
  });

  test("invert:true grows the panel when dragging toward negative X", () => {
    const { frameEl, handleEl } = buildHarness({ invert: true });

    dispatchPointer(handleEl, "pointerdown", { clientX: 200 });
    dispatchPointer(window, "pointermove", { clientX: 150 }); // startX(200) - clientX(150) = 50 => 300+50

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("350px");
  });

  test("mouseup ends the drag and persists the currently measured (rounded) width", () => {
    const { handleEl, measureEl, writeWidth } = buildHarness();

    dispatchPointer(handleEl, "pointerdown", { clientX: 100 });
    dispatchPointer(window, "pointermove", { clientX: 140 });
    // Simulate layout having caught up to the CSS var by the time mouseup fires.
    stubWidth(measureEl, 340.6);
    dispatchPointer(window, "pointerup");

    expect(writeWidth).toHaveBeenCalledWith(341);
  });

  test("pointerup with no active drag does not persist anything", () => {
    const { writeWidth } = buildHarness();

    dispatchPointer(window, "pointerup");

    expect(writeWidth).not.toHaveBeenCalled();
  });

  test("double-click resets to the default width and persists it", () => {
    const { frameEl, handleEl, writeWidth } = buildHarness({ defaultWidth: 275 });

    handleEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("275px");
    expect(writeWidth).toHaveBeenCalledWith(275);
  });

  test("canResize() gates pointerdown — a false gate blocks the drag entirely", () => {
    const { frameEl, handleEl } = buildHarness({ canResize: () => false });

    dispatchPointer(handleEl, "pointerdown", { clientX: 100 });
    dispatchPointer(window, "pointermove", { clientX: 500 });

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

    dispatchPointer(handleEl, "pointerdown", { clientX: 100 });
    dispatchPointer(window, "pointermove", { clientX: -250 }); // 300 - 350 = -50, below threshold(100)

    expect(collapsed).toBe(true);
    expect(frameEl.style.getPropertyValue("--test-width")).toBe("");
  });

  test("touch pointer resizes and pointercancel ends the drag without losing the final width", () => {
    const { frameEl, handleEl, measureEl, writeWidth } = buildHarness();
    const capture = vi.fn();
    handleEl.setPointerCapture = capture;

    dispatchPointer(handleEl, "pointerdown", { clientX: 100, pointerType: "touch" });
    dispatchPointer(window, "pointermove", { clientX: 160, pointerType: "touch" });
    expect(capture).toHaveBeenCalledWith(1);
    expect(frameEl.style.getPropertyValue("--test-width")).toBe("360px");
    expect(frameEl.classList.contains("frame--resizing")).toBe(true);

    stubWidth(measureEl, 360);
    dispatchPointer(window, "pointercancel", { clientX: 160, pointerType: "touch" });
    expect(frameEl.classList.contains("frame--resizing")).toBe(false);
    expect(handleEl.classList.contains("test-resize-handle--active")).toBe(false);
    expect(writeWidth).toHaveBeenCalledWith(360);
  });

  test("events from another pointer cannot move or end the active drag", () => {
    const { frameEl, handleEl, writeWidth } = buildHarness();
    dispatchPointer(handleEl, "pointerdown", { clientX: 100, pointerId: 1 });
    dispatchPointer(window, "pointermove", { clientX: 500, pointerId: 2 });
    dispatchPointer(window, "pointerup", { pointerId: 2 });

    expect(frameEl.style.getPropertyValue("--test-width")).toBe("");
    expect(frameEl.classList.contains("frame--resizing")).toBe(true);
    expect(writeWidth).not.toHaveBeenCalled();
  });

  test("unmounting during a drag clears active resize state", () => {
    const { frameEl, handleEl } = buildHarness();
    dispatchPointer(handleEl, "pointerdown", { clientX: 100 });
    expect(frameEl.classList.contains("frame--resizing")).toBe(true);

    liveWrappers[0].unmount();

    expect(frameEl.classList.contains("frame--resizing")).toBe(false);
    expect(handleEl.classList.contains("test-resize-handle--active")).toBe(false);
  });

  test("max is additionally capped by maxViewportRatio via effectiveMax()", () => {
    const { getEffectiveMax } = buildHarness({ max: 1000, maxViewportRatio: 0.4 });

    const vw = window.innerWidth || 1200;
    expect(getEffectiveMax()).toBe(Math.min(1000, Math.floor(vw * 0.4)));
  });
});
