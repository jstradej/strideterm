import { afterEach, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import NextRunTime from "./NextRunTime.vue";

afterEach(() => {
  vi.useRealTimers();
});

it("updates the countdown, handles overdue runs, and releases its timer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  const wrapper = mount(NextRunTime, { props: { at: "2026-11-17T12:01:05Z" } });
  expect(wrapper.text()).toContain("(in 1m 5s)");
  await vi.advanceTimersByTimeAsync(5000);
  expect(wrapper.text()).toContain("(in 1m 0s)");
  await vi.advanceTimersByTimeAsync(61000);
  expect(wrapper.text()).toContain("(due now)");
  await wrapper.setProps({ at: "2026-11-18T14:00:00Z" } as never);
  expect(wrapper.text()).toContain("(in 1d 1h)");
  await wrapper.setProps({ at: "invalid" } as never);
  expect(wrapper.text()).toBe("invalid");
  wrapper.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
