import { mount } from "@vue/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";

import {
  JIRA_DRAWER_KEY_STEP,
  JIRA_DRAWER_MIN_WIDTH,
  jiraDrawerWidthKey,
  useJiraDrawerWidth,
} from "./pane/useJiraDrawerWidth.js";

const profile = ref("p1");

const Harness = defineComponent({
  setup() {
    const split = ref<HTMLElement | null>(null);
    const drawer = useJiraDrawerWidth(() => profile.value, split);
    return () =>
      h("div", { ref: split, class: "split", style: drawer.style.value }, [
        h("div", {
          class: "sep",
          role: "separator",
          "aria-orientation": "vertical",
          tabindex: 0,
          ...drawer.aria.value,
          onPointerdown: drawer.startResize,
          onDblclick: drawer.resetWidth,
          onKeydown: drawer.onKeydown,
        }),
      ]);
  },
});

function mountHarness() {
  return mount(Harness, { attachTo: document.body });
}

const widthVar = (wrapper: ReturnType<typeof mountHarness>) =>
  (wrapper.get(".split").element as HTMLElement).style.getPropertyValue("--jira-drawer-w");

describe("Jira board drawer width", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { value: 1000, configurable: true });
  });
  afterAll(() => {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  });
  beforeEach(() => {
    localStorage.clear();
    profile.value = "p1";
  });
  afterEach(() => localStorage.clear());

  test("separator exposes its accessible range", async () => {
    const wrapper = mountHarness();
    await nextTick();
    const sep = wrapper.get(".sep");
    expect(sep.attributes("role")).toBe("separator");
    expect(sep.attributes("aria-orientation")).toBe("vertical");
    expect(sep.attributes("tabindex")).toBe("0");
    expect(sep.attributes("aria-valuemin")).toBe(String(JIRA_DRAWER_MIN_WIDTH));
    expect(sep.attributes("aria-valuenow")).toBeDefined();
    expect(sep.attributes("aria-valuemax")).toBeDefined();
    wrapper.unmount();
  });

  test("keyboard steps widen on left, narrow on right, clamp, and persist per profile", async () => {
    const wrapper = mountHarness();
    const sep = wrapper.get(".sep");
    const start = Number(sep.attributes("aria-valuenow"));
    await sep.trigger("keydown", { key: "ArrowLeft" });
    expect(Number(sep.attributes("aria-valuenow"))).toBe(start + JIRA_DRAWER_KEY_STEP);
    expect(localStorage.getItem(jiraDrawerWidthKey("p1"))).toBe(String(start + JIRA_DRAWER_KEY_STEP));
    for (let i = 0; i < 40; i++) await sep.trigger("keydown", { key: "ArrowLeft" });
    expect(Number(sep.attributes("aria-valuenow"))).toBe(680);
    for (let i = 0; i < 60; i++) await sep.trigger("keydown", { key: "ArrowRight" });
    expect(Number(sep.attributes("aria-valuenow"))).toBe(JIRA_DRAWER_MIN_WIDTH);
    expect(localStorage.getItem(jiraDrawerWidthKey("p2"))).toBeNull();
    wrapper.unmount();
  });

  test("double-click resets to the default and forgets the stored width", async () => {
    localStorage.setItem(jiraDrawerWidthKey("p1"), "500");
    const wrapper = mountHarness();
    expect(widthVar(wrapper)).toBe("500px");
    await wrapper.get(".sep").trigger("dblclick");
    expect(widthVar(wrapper)).toBe("");
    expect(localStorage.getItem(jiraDrawerWidthKey("p1"))).toBeNull();
    wrapper.unmount();
  });

  test("dragging left widens and persists on release; too-small stored values are ignored", async () => {
    localStorage.setItem(jiraDrawerWidthKey("p2"), "100");
    const wrapper = mountHarness();
    const sep = wrapper.get(".sep");
    expect(widthVar(wrapper)).toBe("");
    const start = Number(sep.attributes("aria-valuenow"));
    sep.element.dispatchEvent(new MouseEvent("pointerdown", { clientX: 600, bubbles: true }));
    sep.element.dispatchEvent(new MouseEvent("pointermove", { clientX: 540 }));
    await nextTick();
    expect(Number(sep.attributes("aria-valuenow"))).toBe(start + 60);
    sep.element.dispatchEvent(new MouseEvent("pointerup"));
    expect(localStorage.getItem(jiraDrawerWidthKey("p1"))).toBe(String(start + 60));
    wrapper.unmount();
  });

  test("a stored width belongs to its profile", async () => {
    localStorage.setItem(jiraDrawerWidthKey("p2"), "450");
    const wrapper = mountHarness();
    expect(widthVar(wrapper)).toBe("");
    profile.value = "p2";
    await nextTick();
    expect(widthVar(wrapper)).toBe("450px");
    wrapper.unmount();
  });

  test("a blocked localStorage does not break resizing", async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      const wrapper = mountHarness();
      const sep = wrapper.get(".sep");
      const start = Number(sep.attributes("aria-valuenow"));
      await sep.trigger("keydown", { key: "ArrowLeft" });
      expect(Number(sep.attributes("aria-valuenow"))).toBe(start + JIRA_DRAWER_KEY_STEP);
      wrapper.unmount();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
