import { computed, onScopeDispose, watch } from "vue";
import { rlog } from "../lib/renderer-log.js";
import { useAppStore } from "../stores/app.js";
import { isPeerWindow } from "../window-backend.js";

const REPORT_DELAY_MS = 300;

/**
 * A window of this desktop that shows another computer's profile has no local state for the main process to
 * count, so it tells the main process how many alerts it has (title count, overlay icon, taskbar flash).
 * The number is the one the window title shows, for the profile on screen. 0 clears.
 */
export function usePeerWindowAttention(): void {
  if (!isPeerWindow()) return;
  const appStore = useAppStore();
  const count = computed(() => appStore.attentionSummary.count);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reported = -1;

  function report(next: number): void {
    if (next === reported) return;
    reported = next;
    const preload = (
      window as unknown as { strideterm?: { setPeerWindowAttention?: (count: number) => Promise<void> } }
    ).strideterm;
    if (!preload?.setPeerWindowAttention) return;
    preload.setPeerWindowAttention(next).catch((err: unknown) => {
      reported = -1;
      rlog("warn", "[peer] could not report the window's alert count", { count: next, error: (err as Error)?.message });
    });
  }

  watch(
    count,
    (next) => {
      clearTimeout(timer);
      timer = setTimeout(() => report(next), REPORT_DELAY_MS);
    },
    { immediate: true },
  );

  onScopeDispose(() => clearTimeout(timer));
}
