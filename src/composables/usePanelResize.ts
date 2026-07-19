import { onMounted, onBeforeUnmount } from "vue";
import type { Ref } from "vue";

/**
 * Optional collapse behavior: below `threshold` px the panel snaps to a
 * collapsed state instead of resizing (used by the sidebar; the
 * notification dock has no collapsed state and omits this).
 */
export interface PanelCollapseOptions {
  /** rawWidth below this snaps to collapsed instead of resizing. */
  threshold: number;
  get: () => boolean;
  set: (collapsed: boolean) => void;
  /** CSS var read off the frame's computed style for the collapsed-state width. */
  collapsedCssVar: string;
  /** Fallback width (px) when the collapsed CSS var isn't set/parseable. */
  collapsedFallbackWidth: number;
}

export interface UsePanelResizeOptions {
  /** Frame element that owns the CSS custom property and the `frame--resizing` class during drag. */
  frameRef: Ref<HTMLElement | null | undefined>;
  /** CSS custom property written with the resolved width, e.g. "--sidebar-width". */
  cssVar: string;
  /** `data-role` value on the drag handle; also used to build the `${handleRole}--active` class. */
  handleRole: string;
  /** Minimum width in px. */
  min: number;
  /** Maximum width in px (also capped to a fraction of the viewport width). */
  max: number;
  /** Fraction of the viewport width that additionally caps `max`. */
  maxViewportRatio: number;
  /** Width restored on double-click, and used as the drag-start width when no element is measurable. */
  defaultWidth: number;
  /** True when dragging toward negative X grows the panel (e.g. a right-docked panel). */
  invert?: boolean;
  /** Element whose current rendered width is the resize baseline. */
  getMeasureEl: () => Element | null | undefined;
  /** Persist the resolved width (e.g. to localStorage). */
  writeWidth: (px: number) => void;
  /** Gate on whether a mousedown on the handle may start a drag. Defaults to always-true. */
  canResize?: () => boolean;
  /** Collapse-below-threshold behavior; omit for panels with no collapsed state. */
  collapse?: PanelCollapseOptions;
}

export function usePanelResize(options: UsePanelResizeOptions) {
  const {
    frameRef,
    cssVar,
    handleRole,
    min,
    max,
    maxViewportRatio,
    defaultWidth,
    invert = false,
    getMeasureEl,
    writeWidth,
    canResize = () => true,
    collapse,
  } = options;

  const handleSelector = `[data-role="${handleRole}"]`;
  const activeClass = `${handleRole}--active`;

  function effectiveMax(): number {
    const vw = window.innerWidth || 1200;
    return Math.min(max, Math.floor(vw * maxViewportRatio));
  }

  let resizing = false;
  let startX = 0;
  let startWidth = 0;

  function onMousedown(event: MouseEvent) {
    const handle = (event.target as Element | null)?.closest(handleSelector);
    if (!handle) return;
    if (!canResize()) return;
    event.preventDefault();
    resizing = true;
    startX = event.clientX;
    const frame = frameRef.value;
    startWidth = collapse?.get()
      ? Number.parseFloat(frame ? getComputedStyle(frame).getPropertyValue(collapse.collapsedCssVar) : "") ||
        collapse.collapsedFallbackWidth
      : getMeasureEl()?.getBoundingClientRect().width || defaultWidth;
    frame?.classList.add("frame--resizing");
    handle.classList.add(activeClass);
  }

  function onMousemove(event: MouseEvent) {
    if (!resizing) return;
    const delta = invert ? startX - event.clientX : event.clientX - startX;
    const rawWidth = startWidth + delta;
    const frame = frameRef.value;

    if (collapse && rawWidth < collapse.threshold) {
      if (!collapse.get()) collapse.set(true);
      return;
    }
    if (collapse?.get()) collapse.set(false);
    const clampedWidth = Math.max(min, Math.min(effectiveMax(), rawWidth));
    frame?.style.setProperty(cssVar, `${clampedWidth}px`);
  }

  function onMouseup() {
    if (!resizing) return;
    resizing = false;
    const frame = frameRef.value;
    frame?.classList.remove("frame--resizing");
    document.querySelectorAll(handleSelector).forEach((h) => h.classList.remove(activeClass));
    if (!collapse?.get()) {
      const measureEl = getMeasureEl();
      if (measureEl) writeWidth(Math.round(measureEl.getBoundingClientRect().width));
    }
  }

  function onDoubleClick(event: MouseEvent) {
    const handle = (event.target as Element | null)?.closest(handleSelector);
    if (!handle) return;
    event.preventDefault();
    if (collapse?.get()) collapse.set(false);
    frameRef.value?.style.setProperty(cssVar, `${defaultWidth}px`);
    writeWidth(defaultWidth);
  }

  function onWindowResize() {
    if (collapse?.get()) return;
    if (!canResize()) return;
    const frame = frameRef.value;
    const measureEl = getMeasureEl();
    if (!frame || !measureEl) return;
    const current = measureEl.getBoundingClientRect().width;
    const maxNow = effectiveMax();
    if (current > maxNow) {
      frame.style.setProperty(cssVar, `${maxNow}px`);
      writeWidth(maxNow);
    }
  }

  onMounted(() => {
    document.addEventListener("mousedown", onMousedown);
    document.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("mousemove", onMousemove);
    window.addEventListener("mouseup", onMouseup);
    window.addEventListener("resize", onWindowResize);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("mousedown", onMousedown);
    document.removeEventListener("dblclick", onDoubleClick);
    window.removeEventListener("mousemove", onMousemove);
    window.removeEventListener("mouseup", onMouseup);
    window.removeEventListener("resize", onWindowResize);
  });

  return { effectiveMax };
}
