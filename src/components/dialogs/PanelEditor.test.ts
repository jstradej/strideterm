import { describe, test, expect } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import PanelEditor from "./PanelEditor.vue";

function makePanel(overrides: Partial<{ id: string; title: string; command: string }> = {}) {
  return { id: "panel-1", title: "Shell", command: "", shell: true, startup: "default", ...overrides };
}

describe("PanelEditor", () => {
  test("adding a template panel emits update:panels with the new entry appended", async () => {
    const wrapper = mount(PanelEditor, { props: { panels: [makePanel()] } });
    await wrapper.find("button.template-btn").trigger("click"); // first built-in template
    const emitted = wrapper.emitted("update:panels");
    expect(emitted).toBeTruthy();
    const nextPanels = emitted![0][0] as Array<{ command: string }>;
    expect(nextPanels).toHaveLength(2);
  });

  test("removing a panel emits update:panels without that entry", async () => {
    const panels = [makePanel({ id: "a" }), makePanel({ id: "b" })];
    const wrapper = mount(PanelEditor, { props: { panels } });
    const removeButtons = wrapper.findAll("button").filter((b) => b.text() === "Remove");
    await removeButtons[0].trigger("click");
    const emitted = wrapper.emitted("update:panels");
    const nextPanels = emitted![0][0] as Array<{ id: string }>;
    expect(nextPanels.map((p) => p.id)).toEqual(["b"]);
  });

  test("picking a badge icon prefixes the panel title with it", async () => {
    const panels = [makePanel({ title: "Shell" })];
    const wrapper = mount(PanelEditor, { props: { panels } });
    await wrapper.find(".panel-icon-btn").trigger("click");
    const iconButtons = wrapper.findAll(".panel-icon-picker__btn");
    await iconButtons[0].trigger("click");
    // Direct nested-prop mutation (matches the existing panel.title/alertsForceOn convention).
    expect(panels[0].title.endsWith("Shell")).toBe(true);
    expect(panels[0].title.startsWith("Shell")).toBe(false);
  });

  test("filling WSL structured fields (via the shared WslCommandFields) updates panel.command", async () => {
    const panels = [makePanel()];
    const wrapper = mount(PanelEditor, { props: { panels } });
    await flushPromises();
    await wrapper.findAll('[role="tab"]')[1].trigger("click"); // Shell -> WSL
    await wrapper.find("input[placeholder*='Ubuntu-22.04']").setValue("Ubuntu-22.04");
    await wrapper.find("input[placeholder='claude --dangerously-skip-permissions']").setValue("claude");
    expect(panels[0].command).toBe(`wsl -d Ubuntu-22.04 -- bash -lic "claude; exec bash"`);
  });

  test("uses the compact segmented-control sizing (distinct from EditTabDialog's default)", () => {
    const wrapper = mount(PanelEditor, { props: { panels: [makePanel()] } });
    expect(wrapper.find(".segmented").classes()).toContain("segmented--compact");
  });
});
