import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from "vue";

/**
 * "Is the user currently aiming at the workspace list?"
 *
 * The sidebar's two dynamic surfaces freeze their membership and order while
 * this is true, so a background task finishing or a new one starting cannot
 * move a click target out from under the pointer (V3 review, §2).
 *
 * Three inputs, all of them plain DOM/renderer state — there is no webview or
 * transport involved, the sidebar is ordinary Vue DOM in the renderer:
 *
 *   - `pointerenter` / `pointerleave` on the list element (desktop aiming);
 *   - `focusin` / `focusout` inside the list (keyboard navigation, which has
 *     no pointer at all);
 *   - `drawerOpen`, the mobile/narrow drawer's own lifetime. On a touch drawer
 *     the user is already committed the moment it opens — well before any
 *     pointer lands on a row — so the whole open drawer is one interaction.
 *
 * Leaving with the pointer or the focus starts a short GRACE interval instead
 * of unlocking immediately: a pointer that slips off a row on its way to the
 * next one, or a focus that hops between two rows, must not trigger a reflow
 * mid-gesture. Coming back inside cancels the pending unlock.
 *
 * The four handlers are returned rather than attached here, so the caller binds
 * them in its template like any other listener — the element then cannot be
 * live for a tick before the lock is watching it.
 */

/** Grace before a pointer/focus exit actually unlocks. V3 asks for 400–600 ms. */
export const SIDEBAR_UNLOCK_GRACE_MS = 500;

export interface SidebarInteractionLock {
  /** True while the dynamic surfaces must keep their frozen keys and order. */
  locked: ComputedRef<boolean>;
  onPointerEnter(): void;
  onPointerLeave(): void;
  onFocusIn(): void;
  onFocusOut(event: FocusEvent): void;
}

export function useSidebarInteractionLock({
  element,
  drawerOpen,
  graceMs = SIDEBAR_UNLOCK_GRACE_MS,
}: {
  /** The list element — used only to tell an inside focus move from a real exit. */
  element: Ref<HTMLElement | null>;
  /** True while the mobile/narrow sidebar drawer is open. */
  drawerOpen: Ref<boolean> | ComputedRef<boolean>;
  graceMs?: number;
}): SidebarInteractionLock {
  const pointerInside = ref(false);
  const focusInside = ref(false);
  const graceActive = ref(false);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelGrace(): void {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    graceActive.value = false;
  }

  function startGrace(): void {
    if (graceTimer) return;
    graceActive.value = true;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      graceActive.value = false;
    }, graceMs);
  }

  /** Pointer and focus are the only two inputs the grace applies to. */
  const aiming = computed(() => pointerInside.value || focusInside.value);
  watch(aiming, (isAiming) => {
    if (isAiming) cancelGrace();
    // No element means there is nothing left to come back to, so the grace —
    // whose whole purpose is to survive a slip on the way to the next row —
    // would only delay the release for no reason.
    else if (element.value) startGrace();
    else cancelGrace();
  });

  // The element disappearing (unmount, v-if) means nothing can be aimed at.
  watch(element, (host) => {
    if (host) return;
    pointerInside.value = false;
    focusInside.value = false;
    cancelGrace();
  });

  onUnmounted(cancelGrace);

  // The drawer is NOT graced: it is an explicit open/close, and V3 wants the
  // pending state to land only after it has closed.
  const locked = computed(() => drawerOpen.value || aiming.value || graceActive.value);

  return {
    locked,
    onPointerEnter(): void {
      pointerInside.value = true;
    },
    onPointerLeave(): void {
      pointerInside.value = false;
    },
    onFocusIn(): void {
      focusInside.value = true;
    },
    onFocusOut(event: FocusEvent): void {
      // A focus move BETWEEN two rows fires focusout on the old one before
      // focusin on the new one. Only a target genuinely outside the list ends
      // the keyboard interaction; `relatedTarget` is null when focus left the
      // document entirely, which also counts as leaving.
      const next = event.relatedTarget as Node | null;
      const host = element.value;
      if (next && host && host.contains(next)) return;
      focusInside.value = false;
    },
  };
}
