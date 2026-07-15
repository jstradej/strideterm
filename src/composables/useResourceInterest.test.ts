/**
 * Component-level coverage for useResourceInterest — the slim-core detail
 * interest that mounted panes declare. These mount MULTIPLE harness instances
 * (standing in for workspace-grid cells / mobile focused cell) and assert the
 * remote-details store's interest set through the real ref-counting, exercising:
 *   - a wide grid with several visible cells (multiple instances at once);
 *   - two cells rendering the SAME resource (ref-count keeps it interested until
 *     the last unmounts);
 *   - a cell's key changing (grid reassignment / tab switch);
 *   - a mobile focus change / responsive collapse (non-focused cells unmount);
 *   - full teardown clearing every interest.
 *
 * useAppStore is mocked to a minimal remote store so the composable's
 * remote-only guard passes without booting the full app store/transport.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../stores/app.js", () => ({ useAppStore: () => ({ isRemoteTransport: true }) }));

import { useResourceInterest } from "./useResourceInterest.js";
import { useRemoteDetailsStore } from "../stores/remote-details.js";

const Cell = defineComponent({
  props: { rkey: { type: [String, Array, null] as unknown as () => string | string[] | null, default: null } },
  setup(props) {
    useResourceInterest(() => props.rkey as string | string[] | null);
    return () => h("div");
  },
});

describe("useResourceInterest — grid / mobile / responsive interest", () => {
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    const details = useRemoteDetailsStore();
    details._resetForTest(() => 0);
    // A remote transport whose calls we don't care about here — init just flips
    // the store to enabled so interest is actually tracked.
    details.init({
      isRemote: true,
      subscribeResources: () => {},
      onResourceInvalidate: () => {},
      fetchResourceDetail: async () => null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  afterEach(() => {
    useRemoteDetailsStore()._resetForTest();
  });

  const interests = () => [...useRemoteDetailsStore()._interests].sort();

  it("tracks a wide grid, ref-counts a shared resource, follows key changes, and clears on teardown", async () => {
    const opts = { global: { plugins: [pinia] } };
    // Wide grid: three visible cells; two render the same workspace's git detail.
    const c1 = mount(Cell, { props: { rkey: "git:ws1" }, ...opts });
    const c2 = mount(Cell, { props: { rkey: "git:ws2" }, ...opts });
    const c3 = mount(Cell, { props: { rkey: "git:ws1" }, ...opts });
    await nextTick();
    expect(interests()).toEqual(["git:ws1", "git:ws2"]);

    // Grid reassignment: cell 2 now shows a different workspace.
    await c2.setProps({ rkey: "git:ws3" });
    await nextTick();
    expect(interests()).toEqual(["git:ws1", "git:ws3"]);

    // One of the two ws1 cells unmounts (responsive collapse) — ws1 is still
    // interested because the other cell holds it (ref-count > 0).
    c3.unmount();
    await nextTick();
    expect(interests()).toEqual(["git:ws1", "git:ws3"]);

    // Mobile focus change: collapse to the single focused cell (ws3) — the other
    // cells unmount, so their interests drop.
    c1.unmount();
    await nextTick();
    expect(interests()).toEqual(["git:ws3"]);

    // Full teardown clears every interest.
    c2.unmount();
    await nextTick();
    expect(interests()).toEqual([]);
  });

  it("a cell declaring multiple keys (review pane) tracks them all and drops them together", async () => {
    const opts = { global: { plugins: [pinia] } };
    const cell = mount(Cell, { props: { rkey: ["azure-pr:pr1", "review-bridge:pr1", "git:ws1"] }, ...opts });
    await nextTick();
    expect(interests()).toEqual(["azure-pr:pr1", "git:ws1", "review-bridge:pr1"]);

    // Switching the active PR moves the whole set.
    await cell.setProps({ rkey: ["azure-pr:pr2", "review-bridge:pr2", "git:ws1"] });
    await nextTick();
    expect(interests()).toEqual(["azure-pr:pr2", "git:ws1", "review-bridge:pr2"]);

    cell.unmount();
    await nextTick();
    expect(interests()).toEqual([]);
  });
});
