/**
 * Coverage for the recursive ReviewFileTree component (review-code-quality
 * finding 3.5). It replaces two hand-unrolled copies of this markup (Files
 * tab + Conflicts tab in AzureReviewPane.vue) that were each hardcoded to
 * exactly 3 levels deep (dir -> dir -> file), silently truncating any path
 * nested deeper than that. This component self-references for nested
 * directories, so it must render correctly at ANY depth.
 */
import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import ReviewFileTree from "./ReviewFileTree.vue";

function mountTree(files: Array<{ path: string; changeType?: string }>, selectedFile = "") {
  return mount(ReviewFileTree, {
    props: { files, selectedFile },
  });
}

describe("ReviewFileTree — shallow tree (regression guard matching the old hand-unrolled behavior)", () => {
  test("renders a 2-level tree: a directory containing multiple files", () => {
    // A 3rd file under an unrelated top-level dir keeps the common-prefix
    // stripping from consuming "src" itself (it only strips a prefix all
    // files agree on), so "src" renders as a real, findable directory node.
    const wrapper = mountTree([
      { path: "src/a.ts", changeType: "edit" },
      { path: "src/b.ts", changeType: "add" },
      { path: "docs/readme.md", changeType: "edit" },
    ]);

    expect(wrapper.findAll(".review-tree-dir").length).toBe(2);
    const dirLabels = wrapper.findAll(".review-tree-dir__label").map((l) => l.text());
    expect(dirLabels).toEqual(
      expect.arrayContaining([expect.stringContaining("src"), expect.stringContaining("docs")]),
    );
    expect(wrapper.find('[title="src/a.ts"]').exists()).toBe(true);
    expect(wrapper.find('[title="src/b.ts"]').exists()).toBe(true);
    expect(wrapper.find('[title="docs/readme.md"]').exists()).toBe(true);
  });

  test("a root-level file with no directory renders as a plain leaf button", () => {
    const wrapper = mountTree([{ path: "README.md", changeType: "edit" }]);

    expect(wrapper.findAll(".review-tree-dir").length).toBe(0);
    const fileButtons = wrapper.findAll(".review-tree-file");
    expect(fileButtons).toHaveLength(1);
    expect(fileButtons[0].text()).toContain("README.md");
  });

  test("clicking a file button emits select-file with the file's path", async () => {
    const wrapper = mountTree([{ path: "src/a.ts", changeType: "edit" }]);
    await wrapper.find(".review-tree-file").trigger("click");

    expect(wrapper.emitted("select-file")).toBeTruthy();
    expect(wrapper.emitted("select-file")![0]).toEqual(["src/a.ts"]);
  });

  test("the selected file gets the --active modifier class", () => {
    const wrapper = mountTree(
      [
        { path: "src/a.ts", changeType: "edit" },
        { path: "src/b.ts", changeType: "edit" },
      ],
      "src/b.ts",
    );
    const active = wrapper.find('[title="src/b.ts"]');
    expect(active.classes()).toContain("review-tree-file--active");
    const inactive = wrapper.find('[title="src/a.ts"]');
    expect(inactive.classes()).not.toContain("review-tree-file--active");
  });

  test("change-type badges render add/delete/edit labels correctly", () => {
    const wrapper = mountTree([
      { path: "new.ts", changeType: "add" },
      { path: "old.ts", changeType: "delete" },
      { path: "changed.ts", changeType: "edit" },
    ]);
    expect(wrapper.find('[title="new.ts"] .diff-add').text()).toBe("A");
    expect(wrapper.find('[title="old.ts"] .diff-del').text()).toBe("D");
    expect(wrapper.find('[title="changed.ts"] .diff-meta').text()).toBe("M");
  });
});

describe("ReviewFileTree — recursion at arbitrary depth (the fix: old hand-unrolled markup stopped at 3 levels)", () => {
  // These drive the component via its internal recursion prop (`nodes`)
  // directly, with a hand-built tree, so the assertion is about the
  // self-recursion itself and isn't entangled with the separate
  // prefix-stripping/single-child-dir-collapsing heuristics that `files`
  // building applies (covered by the "realistic" tests below).
  test("a hand-built 4-level-deep tree (3 nested dirs + 1 file) renders every level and the file is clickable", async () => {
    const tree = [
      {
        name: "L1",
        key: "L1",
        children: [
          {
            name: "L2",
            key: "L1/L2",
            children: [
              {
                name: "L3",
                key: "L1/L2/L3",
                children: [{ name: "deep.ts", key: "L1/L2/L3/deep.ts", path: "L1/L2/L3/deep.ts", changeType: "edit" }],
              },
            ],
          },
        ],
      },
    ];
    const wrapper = mount(ReviewFileTree, { props: { nodes: tree, selectedFile: "" } });

    const dirLabels = wrapper.findAll(".review-tree-dir__label").map((l) => l.text());
    expect(dirLabels).toEqual(["L1", "L2", "L3"]);

    const fileButton = wrapper.find('[title="L1/L2/L3/deep.ts"]');
    expect(fileButton.exists()).toBe(true);
    await fileButton.trigger("click");
    expect(wrapper.emitted("select-file")![0]).toEqual(["L1/L2/L3/deep.ts"]);
  });

  test("a hand-built 5-level-deep tree (4 nested dirs + 1 file) still reaches the file", async () => {
    const tree = [
      {
        name: "L1",
        key: "L1",
        children: [
          {
            name: "L2",
            key: "L1/L2",
            children: [
              {
                name: "L3",
                key: "L1/L2/L3",
                children: [
                  {
                    name: "L4",
                    key: "L1/L2/L3/L4",
                    children: [
                      {
                        name: "deepest.ts",
                        key: "L1/L2/L3/L4/deepest.ts",
                        path: "L1/L2/L3/L4/deepest.ts",
                        changeType: "add",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const wrapper = mount(ReviewFileTree, { props: { nodes: tree, selectedFile: "" } });

    const fileButton = wrapper.find('[title="L1/L2/L3/L4/deepest.ts"]');
    expect(fileButton.exists()).toBe(true);
    expect(fileButton.find(".diff-add").text()).toBe("A");
    await fileButton.trigger("click");
    expect(wrapper.emitted("select-file")![0]).toEqual(["L1/L2/L3/L4/deepest.ts"]);
  });

  // Realistic end-to-end case using the actual `files` prop AzureReviewPane
  // passes in (a flat changed-files list), with branching that prevents the
  // single-child-dir collapse from merging every level into one label, so
  // multiple real `.review-tree-dir` levels are exercised.
  test("a realistic changed-files list with a 4-segment-deep path is reachable via the files prop", async () => {
    const deepPath = "src/L1/L2/L3/deep.ts";
    const wrapper = mountTree([
      { path: "src/L1/sibling-a.ts", changeType: "edit" }, // keeps "L1" from collapsing into its child
      { path: "src/L1/L2/sibling-b.ts", changeType: "edit" }, // keeps "L2" from collapsing into its child
      { path: deepPath, changeType: "edit" },
      // An unrelated top-level file caps the common-prefix stripping at
      // "src" only (rather than "src/L1"), so "L1" still renders as its
      // own directory level below.
      { path: "src/other-top.ts", changeType: "edit" },
    ]);

    // "src" is the shared prefix and gets stripped from the display, but the
    // full original path is preserved for identification/selection.
    expect(wrapper.findAll(".review-tree-dir").length).toBe(3);
    const fileButton = wrapper.find(`[title="${deepPath}"]`);
    expect(fileButton.exists()).toBe(true);
    await fileButton.trigger("click");
    expect(wrapper.emitted("select-file")![0]).toEqual([deepPath]);
  });
});
