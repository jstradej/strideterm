import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";

export const JIRA_DRAWER_MIN_WIDTH = 340;
export const JIRA_DRAWER_MIN_BOARD_WIDTH = 320;
export const JIRA_DRAWER_KEY_STEP = 24;
const FALLBACK_SPLIT_WIDTH = 1200;

export function jiraDrawerWidthKey(profileId: string): string {
  return `strideterm-jira-drawer-width:${encodeURIComponent(profileId)}`;
}

function readStoredWidth(profileId: string): number | null {
  try {
    const raw = Number(localStorage.getItem(jiraDrawerWidthKey(profileId)));
    return Number.isFinite(raw) && raw >= JIRA_DRAWER_MIN_WIDTH ? raw : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(profileId: string, width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(jiraDrawerWidthKey(profileId));
    else localStorage.setItem(jiraDrawerWidthKey(profileId), String(Math.round(width)));
  } catch {
    // The width is a per-client convenience; losing it only means the default returns next time.
  }
}

export function useJiraDrawerWidth(profileId: () => string, split: Ref<HTMLElement | null>) {
  const stored = ref<number | null>(readStoredWidth(profileId()));
  watch(profileId, (next) => {
    stored.value = readStoredWidth(next);
  });

  const splitSize = ref(0);
  let observer: ResizeObserver | undefined;
  watch(
    split,
    (element) => {
      observer?.disconnect();
      splitSize.value = element?.clientWidth ?? 0;
      if (!element || typeof ResizeObserver === "undefined") return;
      observer = new ResizeObserver(() => {
        splitSize.value = element.clientWidth;
      });
      observer.observe(element);
    },
    { immediate: true, flush: "post" },
  );
  onBeforeUnmount(() => observer?.disconnect());

  function splitWidth(): number {
    return splitSize.value || FALLBACK_SPLIT_WIDTH;
  }
  function maxWidth(): number {
    return Math.max(JIRA_DRAWER_MIN_WIDTH, splitWidth() - JIRA_DRAWER_MIN_BOARD_WIDTH);
  }
  function clampWidth(width: number): number {
    return Math.min(maxWidth(), Math.max(JIRA_DRAWER_MIN_WIDTH, width));
  }
  function defaultWidth(): number {
    return Math.min(560, Math.max(360, splitWidth() * 0.42));
  }

  const width = computed(() => clampWidth(stored.value ?? defaultWidth()));
  const style = computed(() =>
    stored.value === null ? undefined : { "--jira-drawer-w": `${Math.round(width.value)}px` },
  );
  const aria = computed(() => ({
    "aria-valuenow": Math.round(width.value),
    "aria-valuemin": JIRA_DRAWER_MIN_WIDTH,
    "aria-valuemax": Math.round(maxWidth()),
  }));

  function startResize(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width.value;
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
    const onMove = (move: PointerEvent) => {
      stored.value = clampWidth(startWidth - (move.clientX - startX));
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      if (stored.value !== null) writeStoredWidth(profileId(), stored.value);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  function resetWidth(): void {
    stored.value = null;
    writeStoredWidth(profileId(), null);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    stored.value = clampWidth(width.value + (event.key === "ArrowLeft" ? JIRA_DRAWER_KEY_STEP : -JIRA_DRAWER_KEY_STEP));
    writeStoredWidth(profileId(), stored.value);
  }

  return { width, style, aria, startResize, resetWidth, onKeydown };
}
