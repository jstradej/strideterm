import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import JiraProjectScopePicker from "./JiraProjectScopePicker.vue";

const projects = [
  { id: "1", key: "APP", name: "Applications" },
  { id: "2", key: "OPS", name: "Operations" },
];

describe("JiraProjectScopePicker", () => {
  it("shows inherited defaults, searches by name, and emits an explicit selection", async () => {
    const wrapper = mount(JiraProjectScopePicker, {
      props: { modelValue: null, defaultProjectKeys: ["APP"], projects },
    });
    expect(wrapper.get("summary").text()).toContain("Default · APP");
    await wrapper.get("summary").trigger("click");
    await wrapper.get('input[type="search"]').setValue("operations");
    expect(wrapper.findAll(".jira-project-scope-picker__project")).toHaveLength(1);
    const checkbox = wrapper.get('.jira-project-scope-picker__project input[type="checkbox"]');
    await checkbox.setValue(true);
    await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([["APP", "OPS"]]);
  });

  it("supports a bounded manual Jira project key outside the loaded catalog", async () => {
    const wrapper = mount(JiraProjectScopePicker, { props: { modelValue: [], projects } });
    await wrapper.get("summary").trigger("click");
    await wrapper.get('input[type="search"]').setValue("legacy_42");
    await wrapper.get(".jira-project-scope-picker__manual").trigger("click");
    await wrapper.get(".jira-project-scope-picker__apply").trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([["LEGACY_42"]]);
  });

  it("discards unsubmitted project changes with Cancel and restores focus", async () => {
    const wrapper = mount(JiraProjectScopePicker, {
      attachTo: document.body,
      props: { modelValue: null, defaultProjectKeys: ["APP"], projects },
    });
    await wrapper.get("summary").trigger("click");
    await wrapper.findAll('.jira-project-scope-picker__project input[type="checkbox"]')[1]!.setValue(true);
    await wrapper.get(".jira-project-scope-picker__cancel").trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.get("details").element).toHaveProperty("open", false);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(document.activeElement).toBe(wrapper.get("summary").element);
    expect(wrapper.get("summary").text()).toContain("Default · APP");
    wrapper.unmount();
  });

  it("closes on Escape without applying and returns focus to the Projects control", async () => {
    const wrapper = mount(JiraProjectScopePicker, {
      attachTo: document.body,
      props: { modelValue: [], projects },
    });
    await wrapper.get("summary").trigger("click");
    await wrapper.get('input[type="search"]').trigger("keydown", { key: "Escape" });
    await wrapper.vm.$nextTick();
    expect(wrapper.get("details").element).toHaveProperty("open", false);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(document.activeElement).toBe(wrapper.get("summary").element);
    wrapper.unmount();
  });

  it("keeps keyboard focus inside the fixed picker without discarding its draft", async () => {
    const matchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true }) as MediaQueryList),
    });
    const wrapper = mount(JiraProjectScopePicker, {
      attachTo: document.body,
      props: { modelValue: ["APP"], projects },
    });
    try {
      const details = wrapper.get("details");
      const summary = wrapper.get("summary");
      await summary.trigger("click");
      await wrapper.vm.$nextTick();
      const content = wrapper.get(".jira-project-scope-picker__content");
      const first = content.get("button:not(:disabled)");
      expect(document.activeElement).toBe(first.element);
      expect(content.element.contains(document.activeElement)).toBe(true);
      const opsCheckbox = wrapper.findAll('.jira-project-scope-picker__project input[type="checkbox"]')[1]!;
      await opsCheckbox.setValue(true);
      const apply = wrapper.get(".jira-project-scope-picker__apply");
      (apply.element as HTMLButtonElement).focus();
      await apply.trigger("keydown", { key: "Tab" });

      expect(document.activeElement).toBe(first.element);
      expect((details.element as HTMLDetailsElement).open).toBe(true);
      expect((opsCheckbox.element as HTMLInputElement).checked).toBe(true);
      expect(wrapper.emitted("update:modelValue")).toBeUndefined();

      await first.trigger("keydown", { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(apply.element);
      await apply.trigger("click");
      expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([["APP", "OPS"]]);
      expect((details.element as HTMLDetailsElement).open).toBe(false);
      await wrapper.vm.$nextTick();
      expect(document.activeElement).toBe(summary.element);
    } finally {
      wrapper.unmount();
      if (matchMedia) Object.defineProperty(window, "matchMedia", matchMedia);
      else Reflect.deleteProperty(window, "matchMedia");
    }
  });

  it("keeps the expanded Apply action in a bounded short-viewport panel", async () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const height = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 420 });
    const wrapper = mount(JiraProjectScopePicker, {
      attachTo: document.body,
      props: { modelValue: null, defaultProjectKeys: ["APP"], projects },
    });
    try {
      await wrapper.get("summary").trigger("click");
      const panel = wrapper.get(".jira-project-scope-picker__content");
      const apply = wrapper.get(".jira-project-scope-picker__apply");
      expect(panel.attributes("tabindex")).toBe("0");
      expect(panel.attributes("aria-label")).toBe("Project scope options");
      const source = readFileSync("src/components/workspace/jira/JiraProjectScopePicker.vue", "utf8");
      expect(source).toMatch(/position:\s*fixed/);
      expect(source).toMatch(/max-height:\s*calc\(100dvh - 16px\)/);
      expect(source).toMatch(/overflow-y:\s*auto/);
      expect(source).toMatch(/position:\s*sticky/);
      const applyButton = apply.element as HTMLButtonElement;
      applyButton.focus();
      expect(document.activeElement).toBe(applyButton);
    } finally {
      wrapper.unmount();
      if (width) Object.defineProperty(window, "innerWidth", width);
      if (height) Object.defineProperty(window, "innerHeight", height);
    }
  });

  it("shows a spinner while loading but keeps the controls usable, unlike disabled", async () => {
    const wrapper = mount(JiraProjectScopePicker, { props: { modelValue: [], projects: [], loading: true } });
    await wrapper.get("summary").trigger("click");
    expect(wrapper.get(".jira-project-scope-picker__loading").text()).toContain("Loading projects");
    expect(wrapper.find(".jira-project-scope-picker__loading .spinner").exists()).toBe(true);
    expect(wrapper.get('input[type="search"]').attributes("disabled")).toBeUndefined();
    await wrapper.setProps({ loading: false, disabled: true, projects } as never);
    expect(wrapper.get('input[type="search"]').attributes("disabled")).toBeDefined();
  });

  it("treats the older busy prop like disabled", async () => {
    const wrapper = mount(JiraProjectScopePicker, { props: { modelValue: [], projects, busy: true } });
    await wrapper.get("summary").trigger("click");
    expect(wrapper.get(".jira-project-scope-picker__apply").attributes("disabled")).toBeDefined();
    expect(wrapper.get('input[type="search"]').attributes("disabled")).toBeDefined();
  });

  it("pins the selected projects to the top when it opens", async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ id: index, key: `P${index}`, name: `Project ${index}` }));
    const wrapper = mount(JiraProjectScopePicker, { props: { modelValue: ["P3", "P4"], projects: many } });
    await wrapper.get("summary").trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const keys = wrapper.findAll(".jira-project-scope-picker__project strong").map((item) => item.text());
    expect(keys.slice(0, 2).sort()).toEqual(["P3", "P4"]);
    expect(keys).toHaveLength(5);
  });

  it("says how many projects match when the list is capped at 40", async () => {
    const many = Array.from({ length: 55 }, (_, index) => ({ id: index, key: `P${index}`, name: `Project ${index}` }));
    const wrapper = mount(JiraProjectScopePicker, { props: { modelValue: [], projects: many } });
    await wrapper.get("summary").trigger("click");
    expect(wrapper.findAll(".jira-project-scope-picker__project")).toHaveLength(40);
    expect(wrapper.text()).toContain("Showing 40 of 55 — refine the search.");
    await wrapper.get('input[type="search"]').setValue("Project 1");
    expect(wrapper.text()).not.toContain("refine the search");
  });

  it("uses only defined theme tokens and 44px rows only for touch and narrow screens", () => {
    const source = readFileSync("src/components/workspace/jira/JiraProjectScopePicker.vue", "utf8");
    const base = readFileSync("src/styles/base.css", "utf8");
    for (const token of new Set(source.match(/var\(--[a-z-]+/g) || [])) {
      const name = token.slice(4);
      expect(base.includes(`${name}:`) || ["--tint"].includes(name), `${name} is defined`).toBe(true);
    }
    const css = source.slice(source.indexOf("<style"));
    let outsideMedia = "";
    for (let i = 0; i < css.length; i++) {
      if (!css.startsWith("@media", i)) {
        outsideMedia += css[i];
        continue;
      }
      let depth = 0;
      for (i = css.indexOf("{", i); i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) break;
      }
    }
    expect(outsideMedia).not.toContain("44px");
  });
});
