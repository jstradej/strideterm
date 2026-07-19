import { watch } from "vue";
import type { Ref } from "vue";
import { writeNotificationDockWidth, readNotificationDockWidth } from "../app/helpers.js";
import { useNotificationStore } from "../stores/notifications.js";
import { usePanelResize } from "./usePanelResize.js";

const DOCK_MIN = 200;
const DOCK_MAX_PX = 600;
const MAX_VIEWPORT_RATIO = 0.4;
const DOCK_DEFAULT = 360;

function getPanelEl() {
  return document.querySelector(".notification-center--pinned");
}

export function useNotificationDockResize(frameRef: Ref<HTMLElement | null | undefined>) {
  const notifStore = useNotificationStore();

  const { effectiveMax } = usePanelResize({
    frameRef,
    cssVar: "--notif-dock-width",
    handleRole: "notif-dock-resize-handle",
    min: DOCK_MIN,
    max: DOCK_MAX_PX,
    maxViewportRatio: MAX_VIEWPORT_RATIO,
    defaultWidth: DOCK_DEFAULT,
    invert: true,
    getMeasureEl: getPanelEl,
    writeWidth: writeNotificationDockWidth,
    canResize: () => notifStore.pinned,
  });

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
}
