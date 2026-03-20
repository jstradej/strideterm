import { onMounted, onBeforeUnmount } from "vue";
import { writeSidebarWidth } from "../app/helpers.js";
import { useAppStore } from "../stores/app.js";

const COLLAPSE_THRESHOLD = 100;
const SIDEBAR_MIN = 110;
const SIDEBAR_MAX = 500;

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
      : sidebar.getBoundingClientRect().width;
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
      const clampedWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, rawWidth));
      frame?.style.setProperty("--sidebar-width", `${clampedWidth}px`);
    }
  }

  function onMouseup() {
    if (!resizing) return;
    resizing = false;
    const frame = frameRef.value;
    const sidebar = sidebarRef.value;
    frame?.classList.remove("frame--resizing");
    frame?.querySelectorAll('[data-role="sidebar-resize-handle"]')
      .forEach((h) => h.classList.remove("sidebar-resize-handle--active"));
    if (!store.sidebarCollapsed && sidebar) {
      writeSidebarWidth(Math.round(sidebar.getBoundingClientRect().width));
    }
  }

  onMounted(() => {
    sidebarRef.value?.addEventListener("mousedown", onMousedown);
    window.addEventListener("mousemove", onMousemove);
    window.addEventListener("mouseup", onMouseup);
  });

  onBeforeUnmount(() => {
    sidebarRef.value?.removeEventListener("mousedown", onMousedown);
    window.removeEventListener("mousemove", onMousemove);
    window.removeEventListener("mouseup", onMouseup);
  });
}
