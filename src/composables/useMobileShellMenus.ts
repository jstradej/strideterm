import { ref, watch } from "vue";
import { useIsNarrow } from "./useIsNarrow.js";

export interface UseMobileShellMenusOptions {
  /**
   * Invoked when a tab is picked via the mobile tabs popover (or the inline
   * tab strip, which reuses the same handler) — receives the clicked tab id.
   * Each pane owns its own tab-switching logic (a store action vs. a local
   * ref), so that stays a caller-supplied callback rather than something
   * this composable does itself.
   */
  onSelectTab: (id: string) => void;
}

/**
 * Shared mobile-chrome wiring for workspace panes that collapse their tab
 * strip + action toolbar into two popover triggers ("tabs" and "⋮ Actions")
 * below `useIsNarrow`'s mobile breakpoint. This state machine was
 * byte-identical across GitPane, AzureReviewPane, AzureInboxPane, and
 * GitHubInboxPane — each pane still renders its own trigger markup and
 * toolbar/menu items; this composable only owns menuOpen/tabsMenuOpen.
 *
 * At most one popover is open at a time (opening one closes the other), and
 * both close automatically when the viewport crosses back above the mobile
 * breakpoint so a resize/rotate never strands an open menu.
 */
export function useMobileShellMenus(options: UseMobileShellMenusOptions) {
  const { isMobile } = useIsNarrow();
  const menuOpen = ref(false);
  const tabsMenuOpen = ref(false);

  watch(isMobile, (mobile) => {
    if (!mobile) {
      menuOpen.value = false;
      tabsMenuOpen.value = false;
    }
  });

  function toggleActionsMenu() {
    if (menuOpen.value) {
      menuOpen.value = false;
    } else {
      menuOpen.value = true;
      tabsMenuOpen.value = false;
    }
  }

  function toggleTabsMenu() {
    if (tabsMenuOpen.value) {
      tabsMenuOpen.value = false;
    } else {
      tabsMenuOpen.value = true;
      menuOpen.value = false;
    }
  }

  function closeAllMenus() {
    menuOpen.value = false;
    tabsMenuOpen.value = false;
  }

  function onTabClick(id: string) {
    options.onSelectTab(id);
    if (tabsMenuOpen.value) tabsMenuOpen.value = false;
  }

  return { isMobile, menuOpen, tabsMenuOpen, toggleActionsMenu, toggleTabsMenu, closeAllMenus, onTabClick };
}
