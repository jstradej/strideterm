import { ref, onMounted, onBeforeUnmount } from "vue";

const NARROW_QUERY = "(max-width: 768px)";
const MOBILE_QUERY = "(max-width: 768px), (max-height: 500px)";

export function useIsNarrow() {
  const isNarrow = ref(false);
  const isMobile = ref(false);
  let narrowMql: MediaQueryList | null = null;
  let mobileMql: MediaQueryList | null = null;

  function update() {
    if (narrowMql) isNarrow.value = narrowMql.matches;
    if (mobileMql) isMobile.value = mobileMql.matches;
  }

  onMounted(() => {
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

  return { isNarrow, isMobile };
}
