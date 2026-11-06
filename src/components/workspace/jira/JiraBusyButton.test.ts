import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import JiraBusyButton from "./JiraBusyButton.vue";

function mountButton(label: string, props: { busy?: boolean; disabled?: boolean } = {}) {
  const wrapper = mount(JiraBusyButton, { props, slots: { default: label } });
  return Object.assign(wrapper, {
    setBusy: (busy: boolean) =>
      (wrapper as unknown as { setProps(p: { busy: boolean }): Promise<void> }).setProps({ busy }),
  });
}

describe("JiraBusyButton", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("keeps its label in the DOM while busy and only shows the spinner after the delay", async () => {
    const wrapper = mountButton("Pin as workspace", { busy: false });
    expect(wrapper.text()).toBe("Pin as workspace");
    expect(wrapper.attributes("aria-busy")).toBeUndefined();

    await wrapper.setBusy(true);
    expect(wrapper.text()).toBe("Pin as workspace");
    expect(wrapper.attributes("aria-busy")).toBe("true");
    expect(wrapper.classes()).not.toContain("button--pending");

    await vi.advanceTimersByTimeAsync(250);
    expect(wrapper.classes()).toContain("button--pending");
    expect(wrapper.text()).toBe("Pin as workspace");
    expect(wrapper.attributes("disabled")).toBeUndefined();
  });

  test("a fast action never shows the spinner", async () => {
    const wrapper = mountButton("Search", { busy: false });
    await wrapper.setBusy(true);
    await vi.advanceTimersByTimeAsync(100);
    await wrapper.setBusy(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(wrapper.classes()).not.toContain("button--pending");
    expect(wrapper.attributes("aria-busy")).toBeUndefined();
  });

  test("disabled is only for a missing precondition", () => {
    const wrapper = mountButton("Save", { disabled: true });
    expect(wrapper.attributes("disabled")).toBeDefined();
  });
});
