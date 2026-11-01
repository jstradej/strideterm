import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import FileTree from "./FileTree.vue";

describe("FileTree layout filtering", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("shows only root and nested folders in browser layout, and files after switching to editor layout", async () => {
    const store = useFileManagerStore();
    const rootDirectory = { name: "repo", relativePath: "", kind: "directory" as const };
    const folder = { name: "src", relativePath: "src", kind: "directory" as const };
    const rootFile = { name: "readme.md", relativePath: "readme.md", kind: "file" as const };
    const nestedFolder = { name: "nested", relativePath: "src/nested", kind: "directory" as const };
    const nestedFile = { name: "main.ts", relativePath: "src/main.ts", kind: "file" as const };
    const deepFile = { name: "deep.ts", relativePath: "src/nested/deep.ts", kind: "file" as const };
    store.rootPath = "C:/repo";
    store.treeNodes = new Map([
      [
        "",
        {
          entry: rootDirectory,
          children: [
            { entry: rootFile, children: null, expanded: false },
            { entry: folder, children: null, expanded: true },
          ],
          expanded: true,
        },
      ],
      [
        "src",
        {
          entry: folder,
          children: [
            { entry: nestedFile, children: null, expanded: false },
            { entry: nestedFolder, children: null, expanded: true },
          ],
          expanded: true,
        },
      ],
      [
        "src/nested",
        { entry: nestedFolder, children: [{ entry: deepFile, children: null, expanded: false }], expanded: true },
      ],
    ]);

    const wrapper = mount(FileTree, { props: { editorLayout: false } });
    expect(wrapper.text()).toContain("src");
    expect(wrapper.text()).toContain("nested");
    expect(wrapper.text()).not.toContain("readme.md");
    expect(wrapper.text()).not.toContain("main.ts");
    expect(wrapper.text()).not.toContain("deep.ts");

    await wrapper.setProps({ editorLayout: true });
    expect(wrapper.text()).toContain("readme.md");
    expect(wrapper.text()).toContain("main.ts");
    expect(wrapper.text()).toContain("deep.ts");
    wrapper.unmount();
  });
});

describe("FileTree name filter", () => {
  beforeEach(() => setActivePinia(createPinia()));

  const dir = (relativePath: string) => ({
    name: relativePath.split("/").at(-1)!,
    relativePath,
    kind: "directory" as const,
  });
  const file = (relativePath: string) => ({
    name: relativePath.split("/").at(-1)!,
    relativePath,
    kind: "file" as const,
  });
  const leaf = (entry: ReturnType<typeof dir> | ReturnType<typeof file>) => ({
    entry,
    children: null,
    expanded: false,
  });

  function seedTree() {
    const store = useFileManagerStore();
    store.rootPath = "C:/repo";
    const loaded = (entry: ReturnType<typeof dir>, children: ReturnType<typeof leaf>[]) => ({
      entry,
      children,
      expanded: true,
    });
    store.treeNodes = new Map([
      [
        "",
        loaded(dir(""), [
          leaf(dir("assets")),
          leaf(dir("dist")),
          leaf(dir("dist-electron")),
          leaf(dir("node_modules")),
          leaf(dir("src")),
          leaf(file("readme.md")),
        ]),
      ],
      ["dist", loaded(dir("dist"), [leaf(file("dist/index.js")), leaf(dir("dist/assets"))])],
      ["src", loaded(dir("src"), [leaf(file("src/dist-path.ts")), leaf(file("src/main.ts")), leaf(dir("src/lib"))])],
      ["src/lib", loaded(dir("src/lib"), [leaf(dir("src/lib/distro"))])],
    ]);
    return store;
  }

  const labels = (wrapper: ReturnType<typeof mount>) => wrapper.findAll(".tree-node__name").map((node) => node.text());

  it("hides folders whose name and loaded contents do not match, and lists a matching folder in full", () => {
    const store = seedTree();
    store.filterText = " DIST ";

    const wrapper = mount(FileTree, { props: { editorLayout: true } });

    expect(labels(wrapper)).toEqual([
      "dist",
      "index.js",
      "assets",
      "dist-electron",
      "src",
      "dist-path.ts",
      "lib",
      "distro",
    ]);
    wrapper.unmount();
  });

  it("keeps an unmatched folder in the folder-only layout only for a matching loaded subfolder", () => {
    const store = seedTree();
    store.filterText = "distro";

    const wrapper = mount(FileTree, { props: { editorLayout: false } });

    expect(labels(wrapper)).toEqual(["src", "lib", "distro"]);
    wrapper.unmount();
  });

  it("shows the empty message when nothing loaded matches", () => {
    const store = seedTree();
    store.filterText = "nothing-like-this";

    const wrapper = mount(FileTree, { props: { editorLayout: true } });

    expect(labels(wrapper)).toEqual([]);
    expect(wrapper.text()).toContain("No matching files");
    wrapper.unmount();
  });
});
