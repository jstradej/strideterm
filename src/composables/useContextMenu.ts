import { onBeforeUnmount, onMounted, type Ref } from "vue";
import { useDismissable, type DismissEventName } from "./useDismissable.js";

export interface UseContextMenuOptions {
  /** Whether the menu is currently open — while false, the outside-click and
   *  Escape listeners stay detached. */
  isOpen: Ref<boolean> | (() => boolean);
  /** The menu's rendered root — outside clicks are measured against this. */
  menuRef: Ref<HTMLElement | null>;
  /** Clears whatever backs `isOpen` — a local `ref.value = null`, or a store
   *  action like `store.hideContextMenu()`. Called on outside click AND Escape. */
  onClose: () => void;
  eventName?: DismissEventName;
  ignoreSelector?: string;
}

/**
 * Right-click-menu wiring shared by every Teleported `.context-menu` popup:
 * dismiss on outside click plus a companion document-level Escape listener,
 * mounted and torn down together. See useContextMenu.test.ts for what this
 * replaced. Positioning / viewport-clamping stays with each caller — the
 * clamp math differs subtly between menus that overwrite their own state
 * object (SidebarPanel, FileManagerPane) vs. ones with separate display refs
 * (ContextMenu.vue), so folding it in here would risk a re-render loop for
 * the former.
 */
export function useContextMenu(options: UseContextMenuOptions): void {
  const { isOpen, menuRef, onClose, eventName = "click", ignoreSelector } = options;

  useDismissable(isOpen, menuRef, { onDismiss: onClose, eventName, ignoreSelector });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose();
  }
  onMounted(() => document.addEventListener("keydown", onKeydown));
  onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
}
