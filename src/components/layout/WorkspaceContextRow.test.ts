import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import WorkspaceContextRow from "./WorkspaceContextRow.vue";

describe("WorkspaceContextRow", () => {
  it("renders the workspace name, icon, and depth-based indentation", () => {
    const wrapper = mount(WorkspaceContextRow, { props: { name: "Azure DevOps", icon: "🔷", depth: 2 } });

    expect(wrapper.text()).toContain("Azure DevOps");
    expect(wrapper.get(".workspace-context-row__icon").text()).toBe("🔷");
    expect(wrapper.get(".workspace-context-row").attributes("style")).toContain("margin-left: 32px");
  });

  it("is a non-interactive label: no button, no draggable attribute, no interactive controls", () => {
    const wrapper = mount(WorkspaceContextRow, { props: { name: "web-app PR #123", icon: "AZ", depth: 1 } });

    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.find("[draggable]").exists()).toBe(false);
    // No index/time/star/status/attention/kebab affordances of a real card.
    expect(wrapper.find(".workspace-card__index").exists()).toBe(false);
    expect(wrapper.find(".workspace-card__star").exists()).toBe(false);
    expect(wrapper.find(".workspace-card__status-dot").exists()).toBe(false);
    expect(wrapper.find(".workspace-card__attention").exists()).toBe(false);
    expect(wrapper.find(".workspace-card__action--menu").exists()).toBe(false);
  });

  it("emits nothing — has no listeners to click or drag", () => {
    const wrapper = mount(WorkspaceContextRow, { props: { name: "root", icon: "📁", depth: 0 } });
    expect(Object.keys(wrapper.emitted())).toHaveLength(0);
  });
});
