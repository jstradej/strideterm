import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { nextTick } from "vue";
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
    expect(wrapper.text()).not.toContain("User: All");
    expect(wrapper.get(".git-branches__paths-button").text()).toBe("Paths▾");
    expect(wrapper.get(".git-branches__user-button").text()).toBe("User▾");
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

  describe("compact menus", () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => {
      document.body.innerHTML = "";
    });
    const menu = () => document.body.querySelector(".git-history-menu__menu") as HTMLElement;
    const key = (k: string) => menu().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const rowByText = (text: string) =>
      [...document.body.querySelectorAll<HTMLElement>(".git-history-menu__row")].find((r) =>
        r.textContent?.includes(text),
      )!;

    test("User menu: Select… searches authors, picks one and remembers it", async () => {
      const wrapper = mountFilters({ compact: true, knownAuthors: ["alice", "bob"] });
      await wrapper.get(".git-branches__user-button").trigger("click");
      expect(menu().textContent).toContain("Select…");
      expect(menu().textContent).not.toContain("All users");
      rowByText("Select…").click();
      await nextTick();
      const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search authors"]')!;
      search.value = "bo";
      search.dispatchEvent(new Event("input"));
      await nextTick();
      key("Enter");
      await nextTick();
      expect(wrapper.emitted("update:userFilter")![0]).toEqual(["bob"]);
      expect(JSON.parse(localStorage.getItem("strideterm:git-history:recent-authors")!)).toEqual(["bob"]);
      expect(document.body.querySelector(".git-history-menu__menu")).toBeNull();
      wrapper.unmount();
    });

    test("User menu: recent authors and All users; Escape steps back, then closes", async () => {
      localStorage.setItem("strideterm:git-history:recent-authors", JSON.stringify(["alice"]));
      const wrapper = mountFilters({ compact: true, userFilter: "bob" });
      await wrapper.get(".git-branches__user-button").trigger("click");
      expect(menu().textContent).toContain("All users");
      expect(menu().textContent).toContain("Recent");
      expect(menu().textContent).toContain("alice");
      key("ArrowDown");
      key("Enter");
      await nextTick();
      expect(document.body.querySelector('input[aria-label="Search authors"]')).not.toBeNull();
      key("Escape");
      await nextTick();
      expect(document.body.querySelector('input[aria-label="Search authors"]')).toBeNull();
      key("Escape");
      await nextTick();
      expect(document.body.querySelector(".git-history-menu__menu")).toBeNull();
      wrapper.unmount();
    });

    test("Paths popover: adds, lists, removes and remembers paths", async () => {
      localStorage.setItem("strideterm:git-history:recent-paths", JSON.stringify(["docs"]));
      const wrapper = mountFilters({ compact: true, pathsFilter: ["src"] });
      await wrapper.get(".git-branches__paths-button").trigger("click");
      const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Add path filter"]')!;
      expect(input.placeholder).toBe("Path relative to the repository root…");
      expect(document.body.textContent).toContain("Press Enter to add. Commits touching any listed path are shown.");
      input.value = "src/x.ts";
      input.dispatchEvent(new Event("input"));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await nextTick();
      expect(wrapper.emitted("update:pathsFilter")![0]).toEqual([["src", "src/x.ts"]]);
      expect(JSON.parse(localStorage.getItem("strideterm:git-history:recent-paths")!)).toEqual(["src/x.ts", "docs"]);
      document.body.querySelector<HTMLElement>('[aria-label="Remove path filter src"]')!.click();
      expect(wrapper.emitted("update:pathsFilter")![1]).toEqual([["src/x.ts"]]);
      rowByText("docs").click();
      expect(wrapper.emitted("update:pathsFilter")![2]).toEqual([["src/x.ts", "docs"]]);
      key("Escape");
      await nextTick();
      expect(document.body.querySelector(".git-history-menu__menu")).toBeNull();
      wrapper.unmount();
    });
  });
});
