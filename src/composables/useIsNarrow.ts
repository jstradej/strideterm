import { ref, onMounted, onBeforeUnmount, type Ref } from "vue";

const NARROW_QUERY = "(max-width: 768px)";
const MOBILE_QUERY = "(max-width: 768px), (max-height: 500px)";
const PORTRAIT_QUERY = "(orientation: portrait)";

// Module-level shared refs. Initialized synchronously from matchMedia.matches
// so the correct value is available before any component onMounted fires.
// Every mounted component also registers a per-instance change listener so the
// refs stay in sync when the viewport is resized.
const sharedIsNarrow = ref(
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_QUERY).matches
    : false,
);
const sharedIsMobile = ref(
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MOBILE_QUERY).matches
    : false,
);
const sharedIsPortrait = ref(
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(PORTRAIT_QUERY).matches
    : true,
);

/**
 * Module-level reactive flags shared across every consumer. Safe to read from
 * outside a component (e.g. inside a Pinia store) — the value is updated by
 * any mounted component using `useIsNarrow`. If no component has mounted yet
 * the value defaults to `false` (desktop layout, no popovers).
 */
export const isMobileViewport: Ref<boolean> = sharedIsMobile;
export const isNarrowViewport: Ref<boolean> = sharedIsNarrow;
export const isPortraitViewport: Ref<boolean> = sharedIsPortrait;

export function useIsNarrow() {
  let narrowMql: MediaQueryList | null = null;
  let mobileMql: MediaQueryList | null = null;
  let portraitMql: MediaQueryList | null = null;

  function update() {
    if (narrowMql) sharedIsNarrow.value = narrowMql.matches;
    if (mobileMql) sharedIsMobile.value = mobileMql.matches;
    if (portraitMql) sharedIsPortrait.value = portraitMql.matches;
  }

  onMounted(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    narrowMql = window.matchMedia(NARROW_QUERY);
    mobileMql = window.matchMedia(MOBILE_QUERY);
    portraitMql = window.matchMedia(PORTRAIT_QUERY);
    update();
    narrowMql.addEventListener("change", update);
    mobileMql.addEventListener("change", update);
    portraitMql.addEventListener("change", update);
  });

  onBeforeUnmount(() => {
    narrowMql?.removeEventListener("change", update);
    mobileMql?.removeEventListener("change", update);
    portraitMql?.removeEventListener("change", update);
    narrowMql = null;
    mobileMql = null;
    portraitMql = null;
  });

  return { isNarrow: sharedIsNarrow, isMobile: sharedIsMobile, isPortrait: sharedIsPortrait };
}
