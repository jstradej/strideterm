<template>
  <div class="dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ isCreatingTask ? "Agent Task Runner" : "Workspace" }}</p>
        <h2>{{ isCreatingTask ? "Create task workspace" : workspace ? "Edit workspace" : "Add workspace" }}</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span
          >{{
            isAzure
              ? "Review checkout root"
              : isCreatingTask && draft.useWorktree
                ? "Base repository"
                : "Working directory"
          }}{{ isCreatingTask ? " *" : "" }}</span
        >
        <div class="input-with-action">
          <input
            v-model="draft.cwd"
            name="cwd"
            :placeholder="isCreatingTask && draft.useWorktree ? 'Path to git repository root' : cwdPlaceholder"
            :required="isCreatingTask"
            maxlength="500"
            @change="onCwdChange"
          />
          <button
            v-if="api?.browseDirectory"
            type="button"
            class="button button--ghost input-with-action__btn"
            @click="browseCwd"
          >
            Browse
          </button>
        </div>
      </label>
      <label>
        <span>Name</span>
        <input v-model="draft.name" name="name" required maxlength="60" />
      </label>
      <div class="grid">
        <label>
          <span>Badge</span>
          <input v-model="draft.icon" name="icon" maxlength="4" />
          <div class="icon-picker">
            <button
              v-for="icon in BADGE_ICONS"
              :key="icon"
              type="button"
              class="button button--ghost icon-picker__btn"
              @click="draft.icon = icon"
            >
              {{ icon }}
            </button>
          </div>
        </label>
        <label>
          <span>Accent</span>
          <div class="accent-row">
            <input v-model="draft.color" name="color" type="color" class="color-input" />
            <span class="color-preview" :style="{ background: draft.color }"></span>
          </div>
        </label>
      </div>
      <label>
        <span>Notes</span>
        <textarea
          v-model="draft.notes"
          name="notes"
          rows="3"
          placeholder="What belongs in this workspace?"
          maxlength="500"
        />
      </label>

      <!-- Docker workspace: no manual panels -->
      <p v-if="isDocker" class="info-box">
        Docker tabs (shells, logs) are created from the Docker manager inside the workspace. No manual tab setup needed.
      </p>

      <!-- Task workspace: task-specific fields -->
      <template v-else-if="isTask">
        <label
          v-if="isCreatingTask"
          class="checkbox-label"
          title="Create a git worktree from the base repository so the task agent works on an isolated branch."
        >
          <input v-model="draft.useWorktree" type="checkbox" />
          <span>Create in git worktree</span>
        </label>

        <label v-if="isCreatingTask && draft.useWorktree">
          <span>Branch name *</span>
          <input
            v-model="draft.worktreeBranch"
            name="worktreeBranch"
            placeholder="e.g. task/add-pagination"
            :required="draft.useWorktree"
            maxlength="200"
            pattern="[a-zA-Z0-9._/\-]+"
            title="Only letters, numbers, dots, hyphens, slashes, or underscores"
          />
          <span class="field-hint"
            >A new branch will be created from the current HEAD. The agent will work in an isolated worktree
            directory.</span
          >
        </label>

        <label title="This text is written to TASK.md and sent as the initial prompt to the Worker agent.">
          <span>Task assignment</span>
          <textarea
            v-model="draft.task.description"
            rows="4"
            placeholder="Describe the task for the Worker agent"
            maxlength="5000"
          />
        </label>
        <div class="grid">
          <label>
            <span>Max rounds</span>
            <input v-model.number="draft.task.maxRounds" type="number" min="1" max="100" />
          </label>
        </div>
        <label
          title="Command used to launch the Worker agent. Add flags like --dangerously-skip-permissions or --mcp-config as needed."
        >
          <span>Worker command</span>
          <input v-model="workerPanel.command" placeholder="claude" maxlength="500" />
        </label>
        <label
          title="Command used to launch the Judge agent. Usually the same as Worker but can use a different model or configuration."
        >
          <span>Judge command</span>
          <input v-model="judgePanel.command" placeholder="claude" maxlength="500" />
        </label>

        <p v-if="isCreatingTask && !claudeAvailable" class="warning-box">
          Claude Code CLI (claude) was not found on your PATH. The Worker and Judge panels require it to run.
        </p>

        <p v-if="isCreatingTask && draft.useWorktree" class="info-box">
          The agent will work in <code>{{ worktreePreviewPath }}</code
          >. Control files, git commits, and all changes stay isolated in this worktree.
        </p>
        <p v-else class="info-box">
          Control files (TASK.md, TODO.md, FINISH_CRITERIA.md, WORK_LOCK) are managed automatically. Edit them in the
          Dashboard.
        </p>
      </template>

      <!-- Terminal / Azure workspace: panel editor -->
      <template v-else>
        <p v-if="isAzure" class="info-box">
          This workspace is the Azure DevOps parent. Its checkout root is used for managed review checkouts, and these
          tabs are copied into each new review subworkspace.
        </p>
        <PanelEditor
          v-model:panels="draft.panels"
          :tab-templates="tabTemplates"
          :heading="isAzure ? 'Review workspace tabs' : 'Terminal tabs'"
        />
      </template>

      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" :disabled="submitting" @click="emit('cancel')">
          Cancel
        </button>
        <button type="submit" class="button" :disabled="!canSubmit || submitting">
          {{ submitting ? "Creating\u2026" : isCreatingTask ? "Create workspace" : "Save workspace" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup>
import { reactive, computed, inject, ref, watch } from "vue";
import { cloneWorkspace, createEmptyWorkspace } from "../../workspace-state.js";
import { APP_CONFIG } from "../../../config/app-config.js";
import { safeColor } from "../../app/helpers.js";
import { useAppStore } from "../../stores/app.js";
import PanelEditor from "./PanelEditor.vue";

const BADGE_ICONS = [
  "\u{1F4BB}",
  "\u{2328}",
  "\u{1F527}",
  "\u2699",
  "\u{1F6E0}",
  "\u{1F4E6}",
  "\u{1F528}",
  "\u{1F5A5}",
  "\u{1F4C4}",
  "\u{1F4DD}",
  "\u{270F}",
  "\u{2702}",
  "\u{1F33F}",
  "\u{1F500}",
  "\u{1F4CB}",
  "\u{1F433}",
  "\u{1F3D7}",
  "\u{2601}",
  "\u{1F310}",
  "\u{1F50C}",
  "\u{1F4E1}",
  "\u{1F680}",
  "\u{1F5C4}",
  "\u{1F4BE}",
  "\u{1F4CA}",
  "\u{1F4C8}",
  "\u{1F9EA}",
  "\u2705",
  "\u{1F50D}",
  "\u{1F41B}",
  "\u{1F916}",
  "\u{1F9E0}",
  "\u2728",
  "\u26A1",
  "\u{1F3AF}",
  "\u{1F512}",
  "\u{1F511}",
  "\u{1F4C1}",
  "\u{1F4A1}",
  "\u2B50",
  "\u{1F3A8}",
  "\u{1F525}",
  "\u{1F48E}",
  "\u{2764}",
  "\u{1F4AC}",
  "\u{1F514}",
  "\u{1F6A9}",
  "\u{1F5D1}",
];

const props = defineProps({
  workspace: { type: Object, default: null },
  tabTemplates: { type: Array, default: () => [] },
  creating: { type: Boolean, default: false },
});

const emit = defineEmits(["cancel", "submit"]);

const api = inject("api");

const cwdPlaceholder = APP_CONFIG.ui.defaultProjectCwdPlaceholder;

// Build a mutable reactive draft
const rawDraft = props.workspace ? cloneWorkspace(props.workspace) : createEmptyWorkspace();
rawDraft.color = safeColor(rawDraft.color);
const draft = reactive(rawDraft);

const store = useAppStore();

const isDocker = computed(() => draft.kind === "docker");
const isAzure = computed(() => draft.kind === "azure" || draft.kind === "github");
const isTask = computed(() => draft.kind === "task");
const isCreatingTask = computed(() => isTask.value && props.creating);

const submitting = ref(false);

// Claude availability (cached in payload, re-checked before dialog opens)
const claudeAvailable = computed(() => store.payload?.environment?.claudeAvailable !== false);

// For task workspaces: direct references to worker/judge panels for editing
const workerPanel = computed(
  () => draft.panels?.find((p) => p.id === draft.task?.workerPanelId) || { command: "claude" },
);
const judgePanel = computed(
  () => draft.panels?.find((p) => p.id === draft.task?.judgePanelId) || { command: "claude" },
);

// --- Worktree branch auto-generation (task creation only) ---
const branchAutoGenerated = ref(true);

function slugifyBranch(text) {
  if (!text) return "";
  return (
    "task/" +
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60)
  );
}

watch(
  () => draft.task?.description,
  (desc) => {
    if (!isCreatingTask.value || !draft.useWorktree || !branchAutoGenerated.value) return;
    draft.worktreeBranch = slugifyBranch(desc);
  },
);
watch(
  () => draft.worktreeBranch,
  (val, oldVal) => {
    if (!isCreatingTask.value) return;
    if (!val && oldVal) {
      branchAutoGenerated.value = true;
      return;
    }
    if (val && val !== slugifyBranch(draft.task?.description || "")) {
      branchAutoGenerated.value = false;
    }
  },
);

const worktreePreviewPath = computed(() => {
  const base = (draft.cwd || "").trim().replace(/[\\/]+$/, "");
  const branch = (draft.worktreeBranch || "branch").replace(/\//g, "-");
  return base ? `${base}/.strideterm/tree/${branch}` : `.strideterm/tree/${branch}`;
});

const canSubmit = computed(() => {
  if (isCreatingTask.value) {
    if (!(draft.cwd || "").trim()) return false;
    if (draft.useWorktree && !(draft.worktreeBranch || "").trim()) return false;
  }
  if (submitting.value) return false;
  return true;
});

async function browseCwd() {
  if (!api?.browseDirectory) return;
  const selected = await api.browseDirectory(draft.cwd || "");
  if (!selected) return;
  draft.cwd = selected;
  if (!draft.name.trim() || draft.name === APP_CONFIG.ui.defaultPanelTitle) {
    const dirName = selected
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop();
    if (dirName) draft.name = dirName;
  }
}

function onCwdChange() {
  const value = draft.cwd.trim();
  if (value && !draft.name.trim()) {
    const dirName = value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop();
    if (dirName) draft.name = dirName;
  }
}

async function handleSubmit() {
  const result = {
    ...draft,
    name: draft.name.trim(),
    icon: draft.icon.trim() || APP_CONFIG.ui.defaultProjectIcon,
    cwd: draft.cwd.trim(),
    notes: draft.notes.trim(),
  };

  if (!isDocker.value && !isTask.value) {
    result.panels = draft.panels.map((panel) => ({
      ...panel,
      title: panel.title.trim() || APP_CONFIG.ui.defaultPanelTitle,
      command: panel.command.trim() || "",
      startup: APP_CONFIG.ui.defaultPanelStartup,
    }));
    if (result.panels.length === 0) {
      const panelId = `panel-${crypto.randomUUID()}`;
      result.panels = [
        {
          id: panelId,
          title: APP_CONFIG.ui.defaultPanelTitle,
          command: "",
          shell: true,
          startup: APP_CONFIG.ui.defaultPanelStartup,
        },
      ];
    }
    if (!result.panels.some((p) => p.id === result.activePanelId)) {
      result.activePanelId = result.panels[0]?.id || null;
    }
  }

  submitting.value = true;
  try {
    emit("submit", result);
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.icon-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, 32px);
  gap: 4px;
  max-height: 120px;
  overflow-y: auto;
  margin-top: 6px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
}
.icon-picker__btn {
  padding: 0;
  width: 32px;
  height: 32px;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 3px;
}
.accent-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.color-input {
  width: 48px;
  height: 36px;
  padding: 2px;
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
}
.color-preview {
  flex: 1;
  height: 36px;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.info-box {
  color: var(--muted);
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px;
}
.warning-box {
  background: rgba(255, 152, 0, 0.12);
  border: 1px solid rgba(255, 152, 0, 0.3);
  color: #ffcc80;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.checkbox-label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  cursor: pointer;
}
.checkbox-label span {
  font-size: 13px;
}
.field-hint {
  display: block;
  font-size: 11px;
  color: var(--muted, #888);
  margin-top: 4px;
  line-height: 1.4;
}
</style>
