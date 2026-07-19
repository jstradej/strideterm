import { onBeforeUnmount, watch, type Ref } from "vue";

export type DismissEventName = "click" | "mousedown" | "pointerdown";

export interface UseDismissableOptions {
  /** Called when a qualifying event lands outside every container (and outside `ignoreSelector`, if given). */
  onDismiss: () => void;
  eventName?: DismissEventName;
  capture?: boolean;
  /** Extra `target.closest()` selector treated as "inside" even though the
   *  matched element isn't one of `containers` — e.g. an opener button
   *  elsewhere in the DOM whose own click already flipped `isOpen`. */
  ignoreSelector?: string;
  /** Defer (re)attaching the listener to the next animation frame. Needed when
   *  the SAME event that flips `isOpen` to true also bubbles to `document` in
   *  the same dispatch (opener and dismiss listener share `eventName`) — without
   *  this, the opening event would immediately dismiss what it just opened. */
  deferAttach?: boolean;
}

type Containers = Ref<HTMLElement | null> | Ref<HTMLElement | null>[];

function toArray(containers: Containers): Ref<HTMLElement | null>[] {
  return Array.isArray(containers) ? containers : [containers];
}

/**
 * Shared "close on outside click" wiring — see useDismissable.test.ts for what
 * this replaced. The listener is only attached while `isOpen` is true, so
 * callers don't each need their own onMounted/onBeforeUnmount pair.
 */
export function useDismissable(
  isOpen: Ref<boolean> | (() => boolean),
  containers: Containers,
  options: UseDismissableOptions,
): void {
  const { onDismiss, eventName = "click", capture = false, ignoreSelector, deferAttach = false } = options;
  const refs = toArray(containers);
  const isOpenGetter = typeof isOpen === "function" ? isOpen : () => isOpen.value;

  function handleEvent(e: Event): void {
    const target = e.target as Node | null;
    if (!target) return;
    if (ignoreSelector && target instanceof Element && target.closest(ignoreSelector)) return;
    const inside = refs.some((r) => r.value && r.value.contains(target));
    if (!inside) onDismiss();
  }

  function attach(): void {
    document.addEventListener(eventName, handleEvent, capture);
  }
  function detach(): void {
    document.removeEventListener(eventName, handleEvent, capture);
  }

  watch(
    isOpenGetter,
    (open) => {
      detach();
      if (!open) return;
      if (deferAttach) requestAnimationFrame(attach);
      else attach();
    },
    { immediate: true },
  );

  onBeforeUnmount(detach);
}
