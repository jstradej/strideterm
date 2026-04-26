import { ref, computed } from "vue";
import type { Ref } from "vue";
import type { Transport } from "../transport.js";
import type { WorkspaceState } from "../../electron/shared/types/state.js";
import type { TaskState } from "../../electron/shared/types/task.js";

// Only the files the user actively *writes* belong in the Assignment tab.
// TODO.md is the worker's notebook; JUDGE_TODO.md is the judge's audit; the
// JSONL log is system-managed. Those live on disk under
// .strideterm/tasks/<taskId>/ and can be opened via the regular file manager
// for the rare cases someone wants to inspect or reset them by hand.
const TASK_FILES: { name: string; label: string }[] = [
  { name: "TASK.md", label: "Task" },
  { name: "JUDGE_PROMPT.md", label: "Judge" },
];

/**
 * Composable for task dashboard file editing.
 * Encapsulates file loading, switching, saving, and dirty tracking —
 * moves I/O out of the component into a reusable hook.
 */
export function useTaskFiles(
  api: Transport,
  workspace: Ref<WorkspaceState | null | undefined>,
  taskState: Ref<TaskState | null | undefined>,
) {
  const activeFile = ref("TASK.md");
  const fileContents = ref<Record<string, string>>({}); // { "TASK.md": "...", ... }
  const fileDirtyFlags = ref<Record<string, boolean>>({}); // { "TASK.md": true, ... }
  const activeFileContent = ref("");
  const fileLoading = ref(false);
  const fileError = ref("");
  const fileSaveStatus = ref("");
  const saving = ref(false);
  let suppressDirty = false;

  const taskDir = computed(() => {
    const cwd = workspace.value?.cwd;
    const taskId = taskState.value?.taskId;
    if (!cwd || !taskId) return null;
    return `.strideterm/tasks/${taskId}`;
  });

  const taskFiles = computed(() =>
    TASK_FILES.map((file) => ({
      name: file.name,
      label: file.label,
      dirty: !!fileDirtyFlags.value[file.name],
    })),
  );

  const activeFileDirty = computed(() => !!fileDirtyFlags.value[activeFile.value]);

  const editorLanguage = computed(() => {
    const name = activeFile.value;
    if (name.endsWith(".jsonl") || name.endsWith(".json")) return "json";
    if (name.endsWith(".md")) return "markdown";
    return "plaintext";
  });

  async function loadFile(name: string) {
    if (!api || !api.fileRead || !taskDir.value || !workspace.value?.cwd) return;
    fileLoading.value = true;
    fileError.value = "";
    try {
      const result = await api.fileRead({
        rootPath: workspace.value.cwd,
        relativePath: `${taskDir.value}/${name}`,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content = ((result as any)?.content ?? "") as string;
      fileContents.value[name] = content;
      fileDirtyFlags.value[name] = false;
      if (activeFile.value === name) {
        suppressDirty = true;
        activeFileContent.value = content;
        setTimeout(() => {
          suppressDirty = false;
        }, 100);
      }
    } catch {
      fileError.value = `Could not load ${name}. Start the task first to create task files.`;
    } finally {
      fileLoading.value = false;
    }
  }

  function switchFile(name: string) {
    if (activeFile.value) {
      fileContents.value[activeFile.value] = activeFileContent.value;
    }
    activeFile.value = name;
    suppressDirty = true;
    activeFileContent.value = fileContents.value[name] ?? "";
    setTimeout(() => {
      suppressDirty = false;
    }, 100);
    if (!(name in fileContents.value)) {
      loadFile(name);
    }
  }

  function markFileDirty() {
    if (suppressDirty) return;
    fileDirtyFlags.value[activeFile.value] = true;
    fileSaveStatus.value = "";
  }

  async function saveActiveFile() {
    if (!api || !api.fileWrite || !taskDir.value || !workspace.value?.cwd) return;
    if (saving.value) return; // Guard against double-save
    saving.value = true;
    fileSaveStatus.value = "Saving...";
    try {
      await api.fileWrite({
        rootPath: workspace.value.cwd,
        relativePath: `${taskDir.value}/${activeFile.value}`,
        content: activeFileContent.value,
      });
      fileContents.value[activeFile.value] = activeFileContent.value;
      suppressDirty = true;
      fileDirtyFlags.value[activeFile.value] = false;
      fileSaveStatus.value = "\u2713 Saved";
      setTimeout(() => {
        suppressDirty = false;
      }, 100);
      setTimeout(() => {
        if (fileSaveStatus.value === "\u2713 Saved") fileSaveStatus.value = "";
      }, 3000);
    } catch (err) {
      suppressDirty = false;
      fileSaveStatus.value = "\u2717 Save failed!";
      console.error("[task-dashboard] save failed:", err);
    } finally {
      saving.value = false;
    }
  }

  async function reloadActiveFile() {
    await loadFile(activeFile.value);
  }

  return {
    activeFile,
    activeFileContent,
    activeFileDirty,
    editorLanguage,
    fileContents,
    fileError,
    fileLoading,
    fileSaveStatus,
    taskFiles,
    loadFile,
    markFileDirty,
    reloadActiveFile,
    saveActiveFile,
    switchFile,
  };
}
