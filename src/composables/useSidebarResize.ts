import type { Ref } from "vue";
import { writeSidebarWidth } from "../app/helpers.js";
import { useAppStore } from "../stores/app.js";
import { usePanelResize } from "./usePanelResize.js";

const COLLAPSE_THRESHOLD = 100;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX_PX = 600;
const MAX_VIEWPORT_RATIO = 0.4;
const SIDEBAR_DEFAULT = 248;

export function useSidebarResize(
  frameRef: Ref<HTMLElement | null | undefined>,
  sidebarRef: Ref<HTMLElement | null | undefined>,
) {
  const store = useAppStore();

  usePanelResize({
    frameRef,
    cssVar: "--sidebar-width",
    handleRole: "sidebar-resize-handle",
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX_PX,
    maxViewportRatio: MAX_VIEWPORT_RATIO,
    defaultWidth: SIDEBAR_DEFAULT,
    getMeasureEl: () => sidebarRef.value,
    writeWidth: writeSidebarWidth,
    collapse: {
      threshold: COLLAPSE_THRESHOLD,
      get: () => store.sidebarCollapsed,
      set: (collapsed) => {
        store.sidebarCollapsed = collapsed;
      },
      collapsedCssVar: "--sidebar-collapsed-width",
      collapsedFallbackWidth: 84,
    },
  });
}
