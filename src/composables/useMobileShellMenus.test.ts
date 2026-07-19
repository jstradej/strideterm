/**
 * Isolated coverage for the mobile popover state machine shared by GitPane,
 * AzureReviewPane, and InboxPane.vue (formerly AzureInboxPane/GitHubInboxPane;
 * see those panes' responsive-chrome tests for the DOM-level assertions).
 * This file exercises the composable directly through a synthetic host
 * component with a made-up tab-select action, so it stays independent of any
 * one pane's markup.
 */
import { describe, expect, test, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import { useMobileShellMenus } from "./useMobileShellMenus.js";
import { isMobileViewport } from "./useIsNarrow.js";

declare const setMatchMediaResult: (query: string, matches: boolean) => void;

function makeHost(onSelectTab: (id: string) => void) {
  return defineComponent({
    setup() {
      return useMobileShellMenus({ onSelectTab });
    },
    template: `
      <div>
        <button class="tabs-trigger" @click="toggleTabsMenu">tabs</button>
        <button class="actions-trigger" @click="toggleActionsMenu">actions</button>
        <button class="backdrop" @click="closeAllMenus">backdrop</button>
        <button class="pick-foo" @click="onTabClick('foo')">pick foo</button>
        <div v-if="isMobile" class="is-mobile"></div>
        <div v-if="menuOpen" class="menu-open"></div>
        <div v-if="tabsMenuOpen" class="tabs-menu-open"></div>
      </div>
    `,
  });
}

describe("useMobileShellMenus", () => {
  afterEach(() => {
    isMobileViewport.value = false;
  });

  test("toggleActionsMenu opens the actions popover; clicking again closes it", async () => {
    const wrapper = mount(makeHost(() => {}));
    expect(wrapper.find(".menu-open").exists()).toBe(false);

    await wrapper.find(".actions-trigger").trigger("click");
    expect(wrapper.find(".menu-open").exists()).toBe(true);

    await wrapper.find(".actions-trigger").trigger("click");
    expect(wrapper.find(".menu-open").exists()).toBe(false);
  });

  test("toggleTabsMenu opens the tabs popover; clicking again closes it", async () => {
    const wrapper = mount(makeHost(() => {}));
    await wrapper.find(".tabs-trigger").trigger("click");
    expect(wrapper.find(".tabs-menu-open").exists()).toBe(true);

    await wrapper.find(".tabs-trigger").trigger("click");
    expect(wrapper.find(".tabs-menu-open").exists()).toBe(false);
  });

  test("the two popovers are mutually exclusive — opening one closes the other", async () => {
    const wrapper = mount(makeHost(() => {}));

    await wrapper.find(".tabs-trigger").trigger("click");
    expect(wrapper.find(".tabs-menu-open").exists()).toBe(true);

    await wrapper.find(".actions-trigger").trigger("click");
    expect(wrapper.find(".menu-open").exists()).toBe(true);
    expect(wrapper.find(".tabs-menu-open").exists()).toBe(false);

    await wrapper.find(".tabs-trigger").trigger("click");
    expect(wrapper.find(".tabs-menu-open").exists()).toBe(true);
    expect(wrapper.find(".menu-open").exists()).toBe(false);
  });

  test("closeAllMenus closes both popovers regardless of which is open", async () => {
    const wrapper = mount(makeHost(() => {}));
    await wrapper.find(".actions-trigger").trigger("click");
    expect(wrapper.find(".menu-open").exists()).toBe(true);

    await wrapper.find(".backdrop").trigger("click");
    expect(wrapper.find(".menu-open").exists()).toBe(false);
    expect(wrapper.find(".tabs-menu-open").exists()).toBe(false);
  });

  test("onTabClick invokes the caller's onSelectTab with the picked id and closes the tabs popover", async () => {
    const onSelectTab = vi.fn();
    const wrapper = mount(makeHost(onSelectTab));

    await wrapper.find(".tabs-trigger").trigger("click");
    expect(wrapper.find(".tabs-menu-open").exists()).toBe(true);

    await wrapper.find(".pick-foo").trigger("click");
    expect(onSelectTab).toHaveBeenCalledTimes(1);
    expect(onSelectTab).toHaveBeenCalledWith("foo");
    expect(wrapper.find(".tabs-menu-open").exists()).toBe(false);
  });

  test("onTabClick is a no-op on the tabs-popover state when it was already closed", async () => {
    const onSelectTab = vi.fn();
    const wrapper = mount(makeHost(onSelectTab));

    await wrapper.find(".pick-foo").trigger("click");
    expect(onSelectTab).toHaveBeenCalledWith("foo");
    expect(wrapper.find(".tabs-menu-open").exists()).toBe(false);
  });

  test("crossing back above the mobile breakpoint closes both open popovers", async () => {
    setMatchMediaResult("(max-width: 768px), (max-height: 500px)", true);
    const wrapper = mount(makeHost(() => {}));
    // useIsNarrow's onMounted re-reads matchMedia and updates the shared ref
    // AFTER the initial synchronous render, so the DOM only reflects it once
    // the resulting re-render has flushed.
    await nextTick();
    expect(wrapper.find(".is-mobile").exists()).toBe(true);

    await wrapper.find(".actions-trigger").trigger("click");
    expect(wrapper.find(".menu-open").exists()).toBe(true);

    // Simulate the viewport crossing back to desktop (module-level ref that
    // useIsNarrow's mql "change" listener would otherwise update).
    isMobileViewport.value = false;
    await nextTick();

    expect(wrapper.find(".is-mobile").exists()).toBe(false);
    expect(wrapper.find(".menu-open").exists()).toBe(false);
  });
});
