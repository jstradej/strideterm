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
