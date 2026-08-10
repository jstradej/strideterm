import { ref, computed, watch } from "vue";
import type { Ref } from "vue";
import type { Transport } from "../transport.js";
import type { WorkspaceState } from "../../electron/shared/types/state.js";
import type { TaskState } from "../../electron/shared/types/task.js";

// Files the user actively edits belong in the Assignment tab. TODO.md is the
// worker's notebook; JUDGE_TODO.md is the judge's audit; the JSONL log is
// system-managed. Those live on disk under .strideterm/tasks/<taskId>/ and
// can be opened via the regular file manager for the rare cases someone wants
// to inspect or reset them by hand.
//
// WORKER.md is only present in the new split format — older tasks have rules
// embedded in TASK.md and don't ship a Worker tab. The composable probes its
// existence at mount and updates the tab list reactively. Attached (Companion
// loop) tasks reuse the same file/probe for their own "Worker rules" tab —
// durable rules for the Primary, not the standard Worker's rules.
const TASK_FILE_NAME = "TASK.md";
const WORKER_FILE_NAME = "WORKER.md";
const JUDGE_FILE_NAME = "JUDGE_PROMPT.md";
// Attached mode (Companion loop) only — see docs/agent-task-runner.md.
const CONTEXT_FILE_NAME = "CONTEXT.md";
const HANDOFF_FILE_NAME = "HANDOFF.md";
const VERIFICATION_FILE_NAME = "VERIFICATION.md";

const COMPANION_ROLE_LABELS: Record<string, string> = {
  reviewer: "Reviewer",
  planner: "Planner",
  consultant: "Consultant",
  critic: "Critic",
};

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
  const activeFile = ref(TASK_FILE_NAME);
  const fileContents = ref<Record<string, string>>({});
  const fileDirtyFlags = ref<Record<string, boolean>>({});
  const activeFileContent = ref("");
  const fileLoading = ref(false);
  const fileError = ref("");
  const fileSaveStatus = ref("");
  const saving = ref(false);
  // null = haven't probed yet; true/false = result of disk probe.
  const workerFileExists = ref<boolean | null>(null);
  const contextFileExists = ref<boolean | null>(null);
  const verificationFileExists = ref<boolean | null>(null);
  let suppressDirty = false;

  const taskDir = computed(() => {
    const cwd = workspace.value?.cwd;
    const taskId = taskState.value?.taskId;
    if (!cwd || !taskId) return null;
    return `.strideterm/tasks/${taskId}`;
  });

  const isAttached = computed(() => taskState.value?.mode === "attached");
  const companionRoleLabel = computed(
    () => COMPANION_ROLE_LABELS[taskState.value?.companionRole || "reviewer"] || "Judge",
  );

  const taskFiles = computed(() => {
    if (isAttached.value) {
      const list = [
        {
          name: TASK_FILE_NAME,
          label: "Your focus",
          description: "Explicit user focus and later clarifications — the highest-authority task scope.",
        },
      ];
      if (contextFileExists.value) {
        list.push({
          name: CONTEXT_FILE_NAME,
          label: "Context",
          description: "Captured scope from the Primary conversation. Editable before you approve the brief.",
        });
      }
      if (workerFileExists.value) {
        list.push({
          name: WORKER_FILE_NAME,
          label: "Worker rules",
          description: "Durable operating rules for the Primary across this companion loop.",
        });
      }
      list.push({
        name: HANDOFF_FILE_NAME,
        label: "Handoff",
        description: "Current progress snapshot written by the Primary — evidence, never scope authority.",
      });
      if (verificationFileExists.value) {
        list.push({
          name: VERIFICATION_FILE_NAME,
          label: "Verification",
          description: "Primary-recorded command results for the next companion review.",
        });
      }
      list.push({
        name: JUDGE_FILE_NAME,
        label: `${companionRoleLabel.value} customization`,
        description: `Additional ${companionRoleLabel.value} instructions only — can add focus, never replace the runner contract or role policy.`,
      });
      return list.map((file) => ({
        name: file.name,
        label: file.label,
        description: file.description,
        dirty: !!fileDirtyFlags.value[file.name],
      }));
    }

    const list = [
      {
        name: TASK_FILE_NAME,
        label: "Task",
        description: "Brief — what the Worker should do. The user writes this.",
      },
    ];
    if (workerFileExists.value) {
      list.push({
        name: WORKER_FILE_NAME,
        label: "Worker",
        description:
          "Operational rules and verification checklist for the Worker. Edit only if you know what you're changing.",
      });
    }
    list.push({
      name: JUDGE_FILE_NAME,
      label: "Judge",
      description: "Custom evaluation instructions for the Judge. Edit only if you know what you're changing.",
    });
    return list.map((file) => ({
      name: file.name,
      label: file.label,
      description: file.description,
      dirty: !!fileDirtyFlags.value[file.name],
    }));
  });

  const activeFileDirty = computed(() => !!fileDirtyFlags.value[activeFile.value]);

  const editorLanguage = computed(() => {
    const name = activeFile.value;
    if (name.endsWith(".jsonl") || name.endsWith(".json")) return "json";
    if (name.endsWith(".md")) return "markdown";
    return "plaintext";
  });

  // Existence probes — fileRead returns content or throws, so any failure is
  // treated as "doesn't exist yet" (old single-file tasks hide the Worker
  // tab; a not-yet-captured attached task hides Context/Verification).
  async function probeFileExists(name: string): Promise<boolean> {
    if (!api?.fileRead || !taskDir.value || !workspace.value?.cwd) return false;
    try {
      await api.fileRead({ rootPath: workspace.value.cwd, relativePath: `${taskDir.value}/${name}` });
      return true;
    } catch {
      return false;
    }
  }

  async function probeWorkerFile() {
    workerFileExists.value = await probeFileExists(WORKER_FILE_NAME);
  }

  async function probeAttachedFiles() {
    contextFileExists.value = await probeFileExists(CONTEXT_FILE_NAME);
    verificationFileExists.value = await probeFileExists(VERIFICATION_FILE_NAME);
    workerFileExists.value = await probeFileExists(WORKER_FILE_NAME);
  }

  watch(
    () => taskState.value?.taskId,
    (taskId) => {
      if (taskId) {
        if (isAttached.value) probeAttachedFiles();
        else probeWorkerFile();
      } else {
        workerFileExists.value = null;
        contextFileExists.value = null;
        verificationFileExists.value = null;
      }
    },
    { immediate: true },
  );

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
      // If the user just saved WORKER.md (e.g. on a legacy task they're
      // upgrading by hand), surface the Worker tab now instead of waiting
      // for the next mount.
      if (activeFile.value === WORKER_FILE_NAME && !workerFileExists.value) {
        workerFileExists.value = true;
      }
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
