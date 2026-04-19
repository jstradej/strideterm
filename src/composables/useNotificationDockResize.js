import { onMounted, onBeforeUnmount, watch } from "vue";
import { writeNotificationDockWidth, readNotificationDockWidth } from "../app/helpers.js";
import { useNotificationStore } from "../stores/notifications.js";

const DOCK_MIN = 200;
const DOCK_MAX_PX = 600;
const MAX_VIEWPORT_RATIO = 0.4;
const DOCK_DEFAULT = 360;

function effectiveMax() {
  const vw = window.innerWidth || 1200;
  return Math.min(DOCK_MAX_PX, Math.floor(vw * MAX_VIEWPORT_RATIO));
}

export function useNotificationDockResize(frameRef) {
  const notifStore = useNotificationStore();

  let resizing = false;
  let startX = 0;
  let startWidth = 0;

  function getPanelEl() {
    return document.querySelector(".notification-center--pinned");
  }

  function onMousedown(event) {
    const handle = event.target.closest('[data-role="notif-dock-resize-handle"]');
    if (!handle) return;
    if (!notifStore.pinned) return;
    event.preventDefault();
    resizing = true;
    startX = event.clientX;
    const panel = getPanelEl();
    startWidth = panel ? panel.getBoundingClientRect().width : DOCK_DEFAULT;
    frameRef.value?.classList.add("frame--resizing");
    handle.classList.add("notif-dock-resize-handle--active");
  }

  function onMousemove(event) {
    if (!resizing) return;
    // Dragging LEFT grows the right dock, so invert the delta.
    const delta = startX - event.clientX;
    const rawWidth = startWidth + delta;
    const clampedWidth = Math.max(DOCK_MIN, Math.min(effectiveMax(), rawWidth));
    frameRef.value?.style.setProperty("--notif-dock-width", `${clampedWidth}px`);
  }

  function onMouseup() {
    if (!resizing) return;
    resizing = false;
    frameRef.value?.classList.remove("frame--resizing");
    document
      .querySelectorAll('[data-role="notif-dock-resize-handle"]')
      .forEach((h) => h.classList.remove("notif-dock-resize-handle--active"));
    const panel = getPanelEl();
    if (panel) {
      writeNotificationDockWidth(Math.round(panel.getBoundingClientRect().width));
    }
  }

  function onDoubleClick(event) {
    const handle = event.target.closest('[data-role="notif-dock-resize-handle"]');
    if (!handle) return;
    event.preventDefault();
    frameRef.value?.style.setProperty("--notif-dock-width", `${DOCK_DEFAULT}px`);
    writeNotificationDockWidth(DOCK_DEFAULT);
  }

  function onWindowResize() {
    if (!notifStore.pinned) return;
    const panel = getPanelEl();
    if (!panel || !frameRef.value) return;
    const current = panel.getBoundingClientRect().width;
    const max = effectiveMax();
    if (current > max) {
      frameRef.value.style.setProperty("--notif-dock-width", `${max}px`);
      writeNotificationDockWidth(max);
    }
  }

  // Restore saved width whenever the dock becomes pinned (handle only exists then).
  watch(
    () => notifStore.pinned,
    (pinned) => {
      if (!pinned) return;
      const saved = readNotificationDockWidth();
      if (saved && frameRef.value) {
        const clamped = Math.max(DOCK_MIN, Math.min(effectiveMax(), saved));
        frameRef.value.style.setProperty("--notif-dock-width", `${clamped}px`);
      }
    },
    { immediate: true },
  );

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
