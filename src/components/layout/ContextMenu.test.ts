import { describe, expect, test, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ContextMenu from "./ContextMenu.vue";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("ContextMenu", () => {
  test("renders nothing when contextMenu is null", () => {
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    expect(wrapper.find(".context-menu").exists()).toBe(false);
    wrapper.unmount();
  });

  test("renders terminal actions as buttons for a terminal tab", () => {
    const store = useAppStore();
    store.contextMenu = { viewId: "term:1", x: 100, y: 200 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu");
    expect(menu).not.toBeNull();
    const buttons = (menu as Element).querySelectorAll("button");
    const texts = Array.from(buttons).map((b) => b.textContent);
    expect(texts.some((t) => t.includes("Restart"))).toBe(true);
    wrapper.unmount();
  });

  test("renders group actions when tab is in split group", () => {
    const store = useAppStore();
    store.contextMenu = { viewId: "term:1", x: 50, y: 50 };
    store.splitGroup = { layout: "cols", viewIds: ["term:1", "term:2"] };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu");
    expect(menu).not.toBeNull();
    const text = (menu as Element).textContent;
    expect(text).toContain("Remove from split");
    expect(text).toContain("Disband split");
    wrapper.unmount();
  });
});
