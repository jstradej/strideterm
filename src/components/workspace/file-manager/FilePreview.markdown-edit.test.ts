import { mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { beforeEach, describe, expect, test, vi } from "vitest";
import FilePreview from "./FilePreview.vue";

const mocks = vi.hoisted(() => ({
  store: null as object | null,
  editorMounts: 0,
  editorUnmounts: 0,
}));

vi.mock("../../../stores/file-manager.js", () => ({ useFileManagerStore: () => mocks.store }));
vi.mock("./FileEditor.vue", () => ({
  default: {
    template: '<div class="mock-file-editor">Monaco editor</div>',
    mounted() {
      mocks.editorMounts += 1;
    },
    unmounted() {
      mocks.editorUnmounts += 1;
    },
  },
}));

describe("FilePreview Markdown edit mode", () => {
  beforeEach(() => {
    mocks.editorMounts = 0;
    mocks.editorUnmounts = 0;
    mocks.store = reactive({
      selectedEntry: {
        name: "README.md",
        relativePath: "README.md",
        kind: "file",
        size: 100,
        modifiedAt: "2026-11-05T00:00:00.000Z",
      },
      preview: { kind: "text", content: "# Saved version" },
      editMode: true,
      editContent: "# Initial source",
      editDirty: false,
      columnSelection: false,
      gitIsRepo: true,
      getStatusFor: () => ({ status: "modified" }),
      openDiff: vi.fn(),
      startEdit: vi.fn(),
      saveEdit: vi.fn(),
      discardEdit: vi.fn(),
    });
  });

  test("previews the unsaved buffer and returns to the same dirty editor for Save", async () => {
    const store = mocks.store as {
      editContent: string;
      editDirty: boolean;
      editMode: boolean;
      saveEdit: ReturnType<typeof vi.fn>;
    };
    const wrapper = mount(FilePreview);
    store.editContent = "# Unsaved draft";
    store.editDirty = true;
    await nextTick();

    expect(wrapper.find(".mock-file-editor").exists()).toBe(true);
    expect(mocks.editorMounts).toBe(1);
    const toolbarButtons = wrapper.findAll(".file-preview__actions button").map((button) => button.text().trim());
    const columnSelection = () =>
      wrapper.findAll(".file-preview__actions button").find((button) => button.text().trim() === "Column selection")!
        .element as HTMLButtonElement;
    expect(columnSelection().disabled).toBe(false);

    await wrapper.findAll(".file-preview__view-modes button")[1].trigger("click");

    expect(wrapper.get(".markdown-content").text()).toContain("Unsaved draft");
    expect((wrapper.get(".mock-file-editor").element as HTMLElement).style.display).toBe("none");
    expect(mocks.editorMounts).toBe(1);
    expect(mocks.editorUnmounts).toBe(0);
    expect(wrapper.findAll(".file-preview__actions button").map((button) => button.text().trim())).toEqual(
      toolbarButtons,
    );
    expect(columnSelection().disabled).toBe(true);
    expect((wrapper.get("button.button:not(.button--ghost)").element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.text()).toContain("Diff");
    expect(wrapper.text()).toContain("Reveal");

    await wrapper.findAll(".file-preview__view-modes button")[0].trigger("click");

    expect(wrapper.find(".markdown-content").exists()).toBe(false);
    expect((wrapper.get(".mock-file-editor").element as HTMLElement).style.display).not.toBe("none");
    expect(store.editContent).toBe("# Unsaved draft");
    expect(store.editDirty).toBe(true);
    expect(mocks.editorMounts).toBe(1);
    expect(mocks.editorUnmounts).toBe(0);
    expect(columnSelection().disabled).toBe(false);

    await wrapper.get("button.button:not(.button--ghost)").trigger("click");
    expect(store.saveEdit).toHaveBeenCalledOnce();

    store.editMode = false;
    await nextTick();
    expect(wrapper.findAll(".file-preview__view-modes button").some((button) => button.text() === "Source")).toBe(true);
  });
});
