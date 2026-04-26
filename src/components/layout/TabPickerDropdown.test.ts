import { describe, expect, test, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TabPickerDropdown from "./TabPickerDropdown.vue";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

const ANCHOR = { top: 40, bottom: 60, left: 100, right: 200, width: 100, height: 20 };

describe("TabPickerDropdown", () => {
  test("renders nothing when anchorRect is null", () => {
    const wrapper = mount(TabPickerDropdown, {
      props: { anchorRect: null },
      attachTo: document.body,
    });
    expect(document.querySelector(".tab-picker-dropdown")).toBeNull();
    wrapper.unmount();
  });

  test("renders fallback template buttons and custom tab option (no platform filter)", () => {
    const wrapper = mount(TabPickerDropdown, {
      props: { anchorRect: ANCHOR },
      attachTo: document.body,
    });
    const dropdown = document.querySelector(".tab-picker-dropdown");
    expect(dropdown).not.toBeNull();
    const buttons = dropdown.querySelectorAll("button");
    // Without meta.platform set, platform-specific templates are NOT filtered out
    // (7 fallback + 1 SSH + 1 custom).
    expect(buttons.length).toBe(9);
    const texts = Array.from(buttons).map((b) => b.textContent.trim());
    expect(texts.some((t) => t.includes("Shell"))).toBe(true);
    expect(texts.some((t) => t.includes("SSH"))).toBe(true);
    expect(texts.some((t) => t.includes("Custom"))).toBe(true);
    wrapper.unmount();
  });

  test("filters fallback templates by platform when meta.platform is set (win32)", () => {
    const store = useAppStore();
    store.payload = { meta: { platform: "win32" } };
    const wrapper = mount(TabPickerDropdown, {
      props: { anchorRect: ANCHOR },
      attachTo: document.body,
    });
    const dropdown = document.querySelector(".tab-picker-dropdown");
    const texts = Array.from(dropdown.querySelectorAll("button")).map((b) => b.textContent.trim());
    expect(texts.some((t) => t.includes("PowerShell"))).toBe(true);
    expect(texts.some((t) => t.includes("Bash"))).toBe(false);
    expect(texts.some((t) => t.includes("Zsh"))).toBe(false);
    wrapper.unmount();
  });

  test("filters fallback templates by platform when meta.platform is set (linux)", () => {
    const store = useAppStore();
    store.payload = { meta: { platform: "linux" } };
    const wrapper = mount(TabPickerDropdown, {
      props: { anchorRect: ANCHOR },
      attachTo: document.body,
    });
    const dropdown = document.querySelector(".tab-picker-dropdown");
    const texts = Array.from(dropdown.querySelectorAll("button")).map((b) => b.textContent.trim());
    expect(texts.some((t) => t.includes("Bash"))).toBe(true);
    expect(texts.some((t) => t.includes("Zsh"))).toBe(true);
    expect(texts.some((t) => t.includes("PowerShell"))).toBe(false);
    wrapper.unmount();
  });

  test("renders store-configured templates when available", () => {
    const store = useAppStore();
    store.payload = {
      appState: {
        tabTemplates: [
          { title: "Dev Server", command: "npm run dev", icon: "\u{1F680}" },
          { title: "Tests", command: "npm test", icon: "\u2705" },
        ],
      },
    };
    const wrapper = mount(TabPickerDropdown, {
      props: { anchorRect: ANCHOR },
      attachTo: document.body,
    });
    const dropdown = document.querySelector(".tab-picker-dropdown");
    const texts = Array.from(dropdown.querySelectorAll("button")).map((b) => b.textContent);
    expect(texts.some((t) => t.includes("Dev Server"))).toBe(true);
    expect(texts.some((t) => t.includes("Tests"))).toBe(true);
    wrapper.unmount();
  });
});
