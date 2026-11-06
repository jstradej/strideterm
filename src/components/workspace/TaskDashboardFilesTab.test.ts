import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { describe, expect, test, vi } from "vitest";
import TaskDashboardFilesTab from "./TaskDashboardFilesTab.vue";

vi.mock("../shared/MonacoEditor.vue", () => ({
  __esModule: true,
  default: {
    props: ["modelValue"],
    emits: ["update:model-value"],
    template:
      '<textarea class="monaco-stub" :value="modelValue" @input="$emit(\'update:model-value\', $event.target.value)" />',
  },
}));

describe("TaskDashboardFilesTab Markdown mode", () => {
  test("keeps dirty Markdown edits when switching to Preview and back", async () => {
    const Host = defineComponent({
      components: { TaskDashboardFilesTab },
      setup() {
        return {
          taskFiles: [{ name: "TASK.md" }],
          activeFile: ref("TASK.md"),
          activeFileContent: ref("# Original"),
          activeFileDirty: ref(false),
          editorLanguage: "markdown",
          fileLoading: false,
          fileError: "",
          fileSaveStatus: "",
        };
      },
      template: `
        <TaskDashboardFilesTab
          :task-files="taskFiles"
          :active-file="activeFile"
          :active-file-content="activeFileContent"
          :active-file-dirty="activeFileDirty"
          :editor-language="editorLanguage"
          :file-loading="fileLoading"
          :file-error="fileError"
          :file-save-status="fileSaveStatus"
          @update:active-file-content="activeFileContent = $event"
          @mark-dirty="activeFileDirty = true"
        />
      `,
    });
    const wrapper = mount(Host);
    await flushPromises();

    await wrapper.get("textarea").setValue("# Unsaved change");
    const editor = wrapper.get("textarea").element;
    expect(wrapper.get("button").text()).toContain("TASK.md");
    expect((wrapper.get("button.button--sm").element as HTMLButtonElement).disabled).toBe(false);

    await wrapper.get(".td__markdown-modes button").trigger("click");
    expect(wrapper.get(".markdown-content").text()).toContain("Unsaved change");
    expect(wrapper.get("textarea").element).toBe(editor);

    await wrapper.get(".td__markdown-modes button:last-child").trigger("click");
    expect(wrapper.get("textarea").element).toBe(editor);
    expect((editor as HTMLTextAreaElement).value).toBe("# Unsaved change");
    expect((wrapper.get("button.button--sm").element as HTMLButtonElement).disabled).toBe(false);
  });
});
