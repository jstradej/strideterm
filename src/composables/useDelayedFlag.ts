import { onScopeDispose, ref, watch, type Ref } from "vue";

export interface DelayedFlagOptions {
  delayMs?: number;
  minVisibleMs?: number;
}

export function useDelayedFlag(source: Ref<boolean>, options: DelayedFlagOptions = {}): Ref<boolean> {
  const delayMs = options.delayMs ?? 200;
  const minVisibleMs = options.minVisibleMs ?? 300;
  const visible = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shownAt = 0;

  function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  watch(
    source,
    (on) => {
      clear();
      if (on) {
        if (visible.value) return;
        timer = setTimeout(() => {
          timer = null;
          shownAt = Date.now();
          visible.value = true;
        }, delayMs);
        return;
      }
      if (!visible.value) return;
      const remaining = minVisibleMs - (Date.now() - shownAt);
      if (remaining <= 0) {
        visible.value = false;
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        visible.value = false;
      }, remaining);
    },
    { immediate: true },
  );

  onScopeDispose(clear);
  return visible;
}
