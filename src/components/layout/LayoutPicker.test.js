import { describe, expect, test, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import LayoutPicker from "./LayoutPicker.vue";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("LayoutPicker", () => {
  test("renders nothing when layoutPickerAnchor is null", () => {
    const wrapper = mount(LayoutPicker, { attachTo: document.body });
    expect(document.querySelector(".layout-picker")).toBeNull();
    wrapper.unmount();
  });

  test("renders layout buttons with SVG thumbnails when anchor is set", () => {
    const store = useAppStore();
    store.layoutPickerAnchor = { top: 40, bottom: 60, left: 100, right: 200, width: 100, height: 20 };
    const wrapper = mount(LayoutPicker, { attachTo: document.body });
    const picker = document.querySelector(".layout-picker");
    expect(picker).not.toBeNull();
    const buttons = picker.querySelectorAll("button");
    // 5 non-solo layouts
    expect(buttons.length).toBe(5);
    // Each button has an SVG thumbnail
    buttons.forEach((btn) => {
      expect(btn.querySelector("svg")).not.toBeNull();
    });
    wrapper.unmount();
  });
});
