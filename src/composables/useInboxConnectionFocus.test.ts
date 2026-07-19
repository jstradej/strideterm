/**
 * Isolated coverage for the "connection error" deep-link handling shared by
 * AzureInboxPane and GitHubInboxPane: switch to the Connections tab and
 * highlight + scroll to the targeted connection, ignoring requests that are
 * stale or belong to another pane. This logic was byte-identical in both
 * panes before being extracted here.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useInboxConnectionFocus } from "./useInboxConnectionFocus.js";
import { useAppStore } from "../stores/app.js";

function makeHost(myConnectionIds: Set<string>) {
  return defineComponent({
    setup() {
      const ids = ref(myConnectionIds);
      const activeTab = ref("all");
      const { connectionListRef, highlightedConnectionId } = useInboxConnectionFocus(ids, activeTab);
      return { connectionListRef, highlightedConnectionId, activeTab };
    },
    template: `
      <div>
        <span class="active-tab">{{ activeTab }}</span>
        <span class="highlighted">{{ highlightedConnectionId }}</span>
        <div ref="connectionListRef">
          <div data-connection-id="conn-a"></div>
          <div data-connection-id="conn-b"></div>
        </div>
      </div>
    `,
  });
}

describe("useInboxConnectionFocus", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    Element.prototype.scrollIntoView = vi.fn();
  });

  test("a focus request for one of this pane's connections switches to Connections and highlights it", async () => {
    const wrapper = mount(makeHost(new Set(["conn-a", "conn-b"])));
    const appStore = useAppStore();

    appStore.requestInboxConnectionFocus("azure", "conn-a");
    await nextTick();

    expect(wrapper.find(".active-tab").text()).toBe("connections");
    expect(wrapper.find(".highlighted").text()).toBe("conn-a");
    // Consumed so it fires once — a later unrelated visit shouldn't re-trigger it.
    expect(appStore.inboxConnectionFocus).toBeNull();
  });

  test("a request for a connection outside this pane's set is ignored", async () => {
    const wrapper = mount(makeHost(new Set(["conn-a"])));
    const appStore = useAppStore();

    appStore.requestInboxConnectionFocus("github", "conn-other");
    await nextTick();

    expect(wrapper.find(".active-tab").text()).toBe("all");
    expect(wrapper.find(".highlighted").text()).toBe("");
    // Not consumed — belongs to whichever pane actually owns "conn-other".
    expect(appStore.inboxConnectionFocus?.connectionId).toBe("conn-other");
  });

  test("a stale request (older than 15s) is ignored", async () => {
    const wrapper = mount(makeHost(new Set(["conn-a"])));
    const appStore = useAppStore();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(1_000_000); // ts recorded when the request was made
    appStore.requestInboxConnectionFocus("azure", "conn-a");
    nowSpy.mockReturnValue(1_000_000 + 20_000); // "now" when the watcher evaluates it

    await nextTick();

    expect(wrapper.find(".active-tab").text()).toBe("all");
    expect(wrapper.find(".highlighted").text()).toBe("");
    nowSpy.mockRestore();
  });
});
