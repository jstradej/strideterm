import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import GitHistoryFilters from "./GitHistoryFilters.vue";
import CustomSelect from "../../common/CustomSelect.vue";

function mountFilters(props: Record<string, unknown> = {}) {
  return mount(GitHistoryFilters, {
    props: { knownAuthors: ["alice", "bob"], baseBranchOptions: ["origin/main"], ...props },
    attachTo: document.body,
  });
}

describe("GitHistoryFilters", () => {
  test("renders the full labels when not compact", () => {
    const wrapper = mountFilters();
    const text = wrapper.text();
    expect(text).toContain("User: All");
    expect(text).toContain("Date: All");
    expect(text).toContain("Sort: Date");
    expect(text).toContain("View: Graph");
    expect(text).toContain("Limit: 500");
    expect(text).toContain("Compare: off");
    expect(wrapper.find('input[placeholder="+ path…"]').exists()).toBe(true);
    expect(wrapper.findAll("button").some((b) => b.text() === "Clear")).toBe(true);
    wrapper.unmount();
  });

  test("compact shows short labels when inactive and values when active", async () => {
    const wrapper = mountFilters({ compact: true });
    expect(wrapper.text()).toContain("User");
    expect(wrapper.text()).not.toContain("User: All");
    expect(wrapper.get(".git-branches__paths-button").text()).toBe("Paths ▾");
    expect(wrapper.findAll("button").some((b) => b.text() === "Clear")).toBe(false);
    await wrapper.setProps({ userFilter: "alice", pathsFilter: ["a", "b"], dateFilter: "week" } as never);
    expect(wrapper.text()).toContain("User: alice");
    expect(wrapper.text()).toContain("Date: This week");
    expect(wrapper.get(".git-branches__paths-button").text()).toContain("Paths: 2");
    wrapper.unmount();
  });

  test("emits model updates and clear", async () => {
    const wrapper = mountFilters({ hasActiveFilters: true });
    wrapper.findComponent(CustomSelect).vm.$emit("update:modelValue", "bob");
    expect(wrapper.emitted("update:userFilter")![0]).toEqual(["bob"]);
    const input = wrapper.get('input[placeholder="+ path…"]');
    await input.setValue("src/x.ts");
    await input.trigger("keydown.enter");
    expect(wrapper.emitted("update:pathsFilter")![0]).toEqual([["src/x.ts"]]);
    await wrapper
      .findAll("button")
      .find((b) => b.text().startsWith("Sort:"))!
      .trigger("click");
    expect(wrapper.emitted("update:topoOrder")![0]).toEqual([true]);
    await wrapper
      .findAll("button")
      .find((b) => b.text().startsWith("View:"))!
      .trigger("click");
    expect(wrapper.emitted("update:viewMode")![0]).toEqual(["flat"]);
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Clear")!
      .trigger("click");
    expect(wrapper.emitted("clear")).toHaveLength(1);
    wrapper.unmount();
  });
});
