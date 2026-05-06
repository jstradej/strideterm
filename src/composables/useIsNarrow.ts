import { ref, onMounted, onBeforeUnmount, type Ref } from "vue";

const NARROW_QUERY = "(max-width: 768px)";
const MOBILE_QUERY = "(max-width: 768px), (max-height: 500px)";

// Module-level shared refs. Every component that mounts the composable
// updates these via its own per-instance matchMedia listener — the listeners
// stay per-instance (same as the original implementation, no shared lifetime
// to argue about) but they all write into the same ref so non-component code
// (Pinia store, plain modules) can read the live value too.
const sharedIsNarrow = ref(false);
const sharedIsMobile = ref(false);

/**
 * Module-level reactive flags shared across every consumer. Safe to read from
 * outside a component (e.g. inside a Pinia store) — the value is updated by
 * any mounted component using `useIsNarrow`. If no component has mounted yet
 * the value defaults to `false` (desktop layout, no popovers).
 */
export const isMobileViewport: Ref<boolean> = sharedIsMobile;
export const isNarrowViewport: Ref<boolean> = sharedIsNarrow;

export function useIsNarrow() {
  let narrowMql: MediaQueryList | null = null;
  let mobileMql: MediaQueryList | null = null;

  function update() {
    if (narrowMql) sharedIsNarrow.value = narrowMql.matches;
    if (mobileMql) sharedIsMobile.value = mobileMql.matches;
  }

  onMounted(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    narrowMql = window.matchMedia(NARROW_QUERY);
    mobileMql = window.matchMedia(MOBILE_QUERY);
    update();
    narrowMql.addEventListener("change", update);
    mobileMql.addEventListener("change", update);
  });

  onBeforeUnmount(() => {
    narrowMql?.removeEventListener("change", update);
    mobileMql?.removeEventListener("change", update);
    narrowMql = null;
    mobileMql = null;
  });

  return { isNarrow: sharedIsNarrow, isMobile: sharedIsMobile };
}
