import { onMounted, onBeforeUnmount } from "vue";
import { writeSidebarWidth } from "../app/helpers.js";
import { useAppStore } from "../stores/app.js";

const COLLAPSE_THRESHOLD = 100;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX_PX = 600;
const MAX_VIEWPORT_RATIO = 0.4;
const SIDEBAR_DEFAULT = 248;

function effectiveMax() {
  const vw = window.innerWidth || 1200;
  return Math.min(SIDEBAR_MAX_PX, Math.floor(vw * MAX_VIEWPORT_RATIO));
}

export function useSidebarResize(frameRef, sidebarRef) {
  const store = useAppStore();

  let resizing = false;
  let startX = 0;
  let startWidth = 0;

  function onMousedown(event) {
    const handle = event.target.closest('[data-role="sidebar-resize-handle"]');
    if (!handle) return;
    event.preventDefault();
    resizing = true;
    startX = event.clientX;
    const frame = frameRef.value;
    const sidebar = sidebarRef.value;
    startWidth = store.sidebarCollapsed
      ? Number.parseFloat(getComputedStyle(frame).getPropertyValue("--sidebar-collapsed-width")) || 84
      : sidebar?.getBoundingClientRect().width || SIDEBAR_DEFAULT;
    frame?.classList.add("frame--resizing");
    handle.classList.add("sidebar-resize-handle--active");
  }

  function onMousemove(event) {
    if (!resizing) return;
    const delta = event.clientX - startX;
    const rawWidth = startWidth + delta;
    const frame = frameRef.value;

    if (rawWidth < COLLAPSE_THRESHOLD) {
      if (!store.sidebarCollapsed) store.sidebarCollapsed = true;
    } else {
      if (store.sidebarCollapsed) store.sidebarCollapsed = false;
      const clampedWidth = Math.max(SIDEBAR_MIN, Math.min(effectiveMax(), rawWidth));
      frame?.style.setProperty("--sidebar-width", `${clampedWidth}px`);
    }
  }

  function onMouseup() {
    if (!resizing) return;
    resizing = false;
    const frame = frameRef.value;
    const sidebar = sidebarRef.value;
    frame?.classList.remove("frame--resizing");
    document
      .querySelectorAll('[data-role="sidebar-resize-handle"]')
      .forEach((h) => h.classList.remove("sidebar-resize-handle--active"));
    if (!store.sidebarCollapsed && sidebar) {
      writeSidebarWidth(Math.round(sidebar.getBoundingClientRect().width));
    }
  }

  function onDoubleClick(event) {
    const handle = event.target.closest('[data-role="sidebar-resize-handle"]');
    if (!handle) return;
    event.preventDefault();
    if (store.sidebarCollapsed) store.sidebarCollapsed = false;
    frameRef.value?.style.setProperty("--sidebar-width", `${SIDEBAR_DEFAULT}px`);
    writeSidebarWidth(SIDEBAR_DEFAULT);
  }

  function onWindowResize() {
    if (store.sidebarCollapsed) return;
    const frame = frameRef.value;
    const sidebar = sidebarRef.value;
    if (!frame || !sidebar) return;
    const current = sidebar.getBoundingClientRect().width;
    const max = effectiveMax();
    if (current > max) {
      frame.style.setProperty("--sidebar-width", `${max}px`);
      writeSidebarWidth(max);
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
}
