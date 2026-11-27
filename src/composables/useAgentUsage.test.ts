import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, reactive } from "vue";
import { flushPromises, mount } from "@vue/test-utils";

const { readAgentUsage, state } = vi.hoisted(() => ({
  readAgentUsage: vi.fn(),
  state: { activeSessionId: "session-a" },
}));
const reactiveState = reactive(state);
vi.mock("../stores/app.js", () => ({
  useAppStore: () => Object.assign(reactiveState, { getApi: () => ({ readAgentUsage }) }),
}));

import { useAgentUsage } from "./useAgentUsage.js";

const Consumer = defineComponent({
  setup() {
    const usage = useAgentUsage();
    return () => h("output", String(usage.entries.value.length));
  },
});

describe("useAgentUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readAgentUsage.mockReset();
    reactiveState.activeSessionId = "session-a";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => vi.useRealTimers());

  it("shares an initial request across mounted consumers and retries on manual refresh", async () => {
    readAgentUsage
      .mockImplementationOnce(() => {
        throw new Error("Desktop bridge disconnected");
      })
      .mockResolvedValueOnce([]);
    const first = mount(Consumer);
    const second = mount(Consumer);
    await flushPromises();
    expect(readAgentUsage).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    first.unmount();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(readAgentUsage).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(readAgentUsage).toHaveBeenCalledTimes(2);
    second.unmount();

    readAgentUsage.mockResolvedValue([]);
    const retry = mount(
      defineComponent({
        setup() {
          const usage = useAgentUsage();
          return () => h("button", { onClick: () => void usage.refresh() }, "Refresh");
        },
      }),
    );
    await flushPromises();
    await retry.get("button").trigger("click");
    await flushPromises();
    expect(readAgentUsage).toHaveBeenCalledTimes(4);
    expect(readAgentUsage).toHaveBeenLastCalledWith("session-a", true);
    retry.unmount();
  });

  it("discards a previous session result and refreshes for the selected session", async () => {
    let resolveOld!: (value: []) => void;
    readAgentUsage
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce([]);
    const wrapper = mount(Consumer);
    reactiveState.activeSessionId = "session-b";
    await flushPromises();
    expect(readAgentUsage).toHaveBeenNthCalledWith(2, "session-b");
    resolveOld([]);
    await flushPromises();
    wrapper.unmount();
    expect(readAgentUsage).toHaveBeenCalledTimes(2);
  });

  it("removes session-bound Gemini usage immediately when the selected session changes", async () => {
    readAgentUsage.mockResolvedValueOnce([
      { provider: "gemini", checkedAt: 1, windows: [{ label: "Daily", usedPercent: 10 }] },
    ]);
    readAgentUsage.mockImplementationOnce(() => new Promise(() => {}));
    const wrapper = mount(Consumer);
    await flushPromises();
    expect(wrapper.text()).toBe("1");
    reactiveState.activeSessionId = "session-b";
    await nextTick();
    expect(wrapper.text()).toBe("0");
    expect(readAgentUsage).toHaveBeenLastCalledWith("session-b");
    wrapper.unmount();
  });

  it("filters windows that reset while a usage request was in flight", async () => {
    let resolveRead!: (
      value: [
        { provider: "claude"; checkedAt: number; windows: { label: string; usedPercent: number; resetsAt: number }[] },
      ],
    ) => void;
    readAgentUsage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const WindowConsumer = defineComponent({
      setup() {
        const usage = useAgentUsage();
        return () => h("output", String(usage.entries.value.reduce((total, entry) => total + entry.windows.length, 0)));
      },
    });
    const wrapper = mount(WindowConsumer);
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(1_500);
    resolveRead([
      {
        provider: "claude",
        checkedAt: startedAt,
        windows: [
          { label: "Already reset", usedPercent: 100, resetsAt: startedAt + 1_000 },
          { label: "Still active", usedPercent: 20, resetsAt: startedAt + 11_000 },
        ],
      },
    ]);
    await flushPromises();
    expect(wrapper.text()).toBe("1");
    await vi.advanceTimersByTimeAsync(9_501);
    expect(readAgentUsage).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("cleans up the polling timer after the final consumer unmounts", async () => {
    readAgentUsage.mockResolvedValue([]);
    const wrapper = mount(Consumer);
    await flushPromises();
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(readAgentUsage).toHaveBeenCalledTimes(1);
  });

  it("rechecks separate logins at reset and retains historical readings", async () => {
    const reset = Date.now() + 60_000;
    const quota = [{ label: "Weekly", usedPercent: 95, resetsAt: reset }];
    const entry = {
      provider: "claude",
      checkedAt: Date.now(),
      windows: [],
      otherAccounts: [
        { id: "profile", label: "Work", status: "separate-login", windows: quota },
        { id: "former", label: "Former", status: "last-seen", windows: quota },
      ],
    };
    readAgentUsage.mockResolvedValue([entry]);
    const wrapper = mount(
      defineComponent({
        setup() {
          const usage = useAgentUsage();
          return () =>
            h("output", usage.entries.value[0]?.otherAccounts?.map((account) => account.windows?.length).join("/"));
        },
      }),
    );
    try {
      await flushPromises();
      expect(wrapper.text()).toBe("1/1");
      await vi.advanceTimersByTimeAsync(60_002);
      expect(readAgentUsage).toHaveBeenCalledTimes(2);
      expect(wrapper.text()).toBe("0/1");
    } finally {
      wrapper.unmount();
    }
  });

  it("requests new account data after an older refresh completes", async () => {
    let finish!: () => void;
    readAgentUsage
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve([]);
          }),
      )
      .mockResolvedValueOnce([{ provider: "codex", windows: [], checkedAt: Date.now() }]);
    const wrapper = mount(
      defineComponent({
        setup() {
          const usage = useAgentUsage();
          return () =>
            h("button", { onClick: () => void usage.refreshAfterAccountChange() }, String(usage.entries.value.length));
        },
      }),
    );
    try {
      await wrapper.get("button").trigger("click");
      expect(readAgentUsage).toHaveBeenCalledTimes(1);
      finish();
      await flushPromises();
      expect(readAgentUsage).toHaveBeenNthCalledWith(2, "session-a", true);
      expect(wrapper.text()).toBe("1");
    } finally {
      wrapper.unmount();
    }
  });
});
