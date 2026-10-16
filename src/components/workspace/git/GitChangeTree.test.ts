import { describe, expect, test } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick, type ComponentPublicInstance } from "vue";
import GitChangeTree from "./GitChangeTree.vue";

type GitChangeTreeTestProps = {
  grouped?: boolean;
  files?: Array<Record<string, unknown>>;
  scopeFilter?: string;
};
type GitChangeTreeTestWrapper = VueWrapper<
  InstanceType<typeof GitChangeTree>,
  ComponentPublicInstance<GitChangeTreeTestProps>
>;

describe("GitChangeTree grouped mobile mode", () => {
  test("groups staged and unstaged entries for one path with scope-specific chips", async () => {
    const wrapper = mount(GitChangeTree, {
      props: {
        grouped: true,
        files: [
          { path: "src/shared.ts", code: "M", stagedStatus: "M", scope: "staged" },
          { path: "src/shared.ts", code: "M", unstagedStatus: "M", scope: "unstaged" },
          { path: "src/other.ts", code: "A", scope: "staged" },
          { path: "src/new.ts", code: "??", scope: "untracked" },
        ],
      },
    }) as GitChangeTreeTestWrapper;

    expect(wrapper.findAll(".gct-node__name").map((n) => n.text())).toContain("shared.ts");
    expect(wrapper.findAll(".gct-node__name").filter((n) => n.text() === "shared.ts")).toHaveLength(1);
    const chips = wrapper.findAll("button.gct-node__scope");
    expect(chips.map((button) => button.attributes("aria-label"))).toEqual(
      expect.arrayContaining(["Open src/shared.ts staged diff", "Open src/shared.ts unstaged diff"]),
    );

    await wrapper.setProps({ scopeFilter: "staged" });
    expect(wrapper.findAll(".gct-node__name").filter((n) => n.text() === "shared.ts")).toHaveLength(1);
    expect(wrapper.findAll("button.gct-node__scope").map((button) => button.text())).not.toContain("WT");
    expect(wrapper.findAll(".gct-node__name").map((n) => n.text())).not.toContain("new.ts");
    await wrapper.setProps({ scopeFilter: "unstaged" });
    expect(wrapper.findAll("button.gct-node__scope").map((button) => button.text())).toEqual(["WT"]);
  });

  test("preserves a collapsed directory across scope filters and file list updates", async () => {
    const files = [
      { path: "src/deep/one.ts", code: "M", scope: "unstaged" },
      { path: "src/deep/two.ts", code: "M", scope: "staged" },
      { path: "src/deep/three.ts", code: "M", scope: "staged" },
      { path: "src/other/four.ts", code: "M", scope: "staged" },
    ];
    const wrapper = mount(GitChangeTree, {
      props: { grouped: true, files },
    }) as GitChangeTreeTestWrapper;
    const deepDirectory = wrapper.findAll(".gct-node").find((node) => node.text().includes("deep"));
    expect(deepDirectory).toBeTruthy();
    expect(deepDirectory!.attributes("aria-expanded")).toBe("true");
    const row = deepDirectory!.get(":scope > .gct-node__row");
    await row.trigger("click");
    await nextTick();
    expect(deepDirectory!.attributes("aria-expanded")).toBe("false");

    await wrapper.setProps({ scopeFilter: "staged" });
    await wrapper.setProps({ files: [...files, { path: "src/deep/four.ts", code: "M", scope: "unstaged" }] });
    await nextTick();
    const updatedDirectory = wrapper.findAll(".gct-node").find((node) => node.text().includes("deep"));
    expect(updatedDirectory?.attributes("aria-expanded")).toBe("false");
    await updatedDirectory!.get(":scope > .gct-node__row").trigger("click");
    expect(updatedDirectory!.attributes("aria-expanded")).toBe("true");
  });

  test("Space on a file row toggles its checkbox without selecting the diff", async () => {
    const wrapper = mount(GitChangeTree, {
      props: {
        grouped: true,
        selectable: true,
        files: [{ path: "src/a.ts", code: "M", scope: "unstaged" }],
      },
    }) as GitChangeTreeTestWrapper;
    const checkbox = wrapper.get(".gct-node__check");
    await checkbox.trigger("keydown", { key: " " });
    await checkbox.setValue(true);

    expect(wrapper.emitted("toggle-select")).toEqual([["src/a.ts"]]);
    expect(wrapper.emitted("select")).toBeUndefined();
  });
});
