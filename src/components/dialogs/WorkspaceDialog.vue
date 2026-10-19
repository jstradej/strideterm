<template>
  <div class="dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ isCreatingTask ? "Agent Task Runner" : "Workspace" }}</p>
        <h2>{{ isCreatingTask ? "Create task workspace" : workspace ? "Edit workspace" : "Add workspace" }}</h2>
      </div>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <!-- Docker workspaces don't run shells from a cwd and don't probe git,
           so the directory field is just noise. Hide it entirely; defaults to
           empty on submit (see handleSubmit). -->
      <label v-if="!isDocker">
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
            data-validation-required="Choose the base repository directory for this task workspace."
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
        <input
          v-model="draft.name"
          name="name"
          required
          data-validation-required="Enter a name for this workspace."
          maxlength="60"
        />
      </label>
      <!-- Badge / accent / notes rarely need editing during creation, so
           they're tucked behind a collapsed disclosure to keep the primary
           fields (cwd, name, task) above the fold. -->
      <details class="appearance-details">
        <summary class="appearance-summary">Appearance & notes</summary>
        <div class="appearance-content">
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
        </div>
      </details>

      <!-- Docker workspace: no manual panels -->
      <p v-if="isDocker" class="info-box">
        Docker tabs (shells, logs) are created from the Docker manager inside the workspace. No manual tab setup needed.
      </p>

      <!-- Task workspace: task-specific fields -->
      <template v-else-if="isTask">
        <label
          v-if="isCreatingTask"
          class="checkbox-label"
          :class="{ 'checkbox-label--disabled': cwdIsGitRepo === false }"
          :title="
            cwdIsGitRepo === false
              ? 'The selected directory is not a git repository. Initialize with `git init` there to enable this option.'
              : 'Create a git worktree from the base repository so the task agent works on an isolated branch.'
          "
        >
          <input v-model="draft.useWorktree" type="checkbox" :disabled="cwdIsGitRepo === false" />
          <span>Create in git worktree</span>
          <span v-if="cwdIsGitRepo === false" class="field-hint field-hint--inline">(not a git repo)</span>
        </label>

        <label v-if="isCreatingTask && draft.useWorktree">
          <span>Branch name *</span>
          <input
            v-model="draft.worktreeBranch"
            name="worktreeBranch"
            placeholder="e.g. task/add-pagination"
            :required="draft.useWorktree"
            data-validation-required="Enter a branch name for the task worktree."
            maxlength="200"
            pattern="[\-a-zA-Z0-9._\/]+"
            title="Only letters, numbers, dots, hyphens, slashes, or underscores"
          />
          <span class="field-hint"
            >A new branch will be created from the current HEAD. The agent will work in an isolated worktree
            directory.</span
          >
        </label>

        <!-- §14: repo picker when parent workspace is multi-repo -->
        <label v-if="isCreatingTask && draft.useWorktree && parentIsMultiRepo">
          <span>Target repository *</span>
          <CustomSelect
            v-model="draft.repositoryForWorktree"
            placeholder="Select a repository…"
            :options="repositoryForWorktreeOptions"
          />
          <span class="field-hint">The worktree will be created inside the selected repository directory.</span>
        </label>

        <label title="This text is written to TASK.md and sent as the initial prompt to the Worker agent.">
          <span>Task assignment</span>
          <textarea
            v-model="draft.task.description"
            rows="4"
            placeholder="Describe the task for the Worker agent"
            :maxlength="TASK_BRIEF_MAX_CHARS"
          />
          <span class="field-hint">{{ TASK_BRIEF_HINT }}</span>
          <span
            class="field-hint field-counter"
            :class="{ 'field-counter--near-limit': taskDescriptionLength > TASK_BRIEF_MAX_CHARS * 0.9 }"
          >
            {{ formatBriefCounter(taskDescriptionLength) }}
          </span>
        </label>
        <div class="grid">
          <label>
            <span>Max rounds</span>
            <input v-model.number="draft.task.maxRounds" type="number" min="1" max="100" />
          </label>
        </div>
        <!-- Worker agent configuration -->
        <AgentProviderConfig
          v-model:provider="draft.workerProvider"
          v-model:panel-command="workerPanel.command"
          v-model:command-override="draft.workerCommandOverride"
          role="worker"
          :provider-options="providerOptions"
        />

        <!-- Judge agent configuration -->
        <AgentProviderConfig
          v-model:provider="draft.judgeProvider"
          v-model:panel-command="judgePanel.command"
          v-model:command-override="draft.judgeCommandOverride"
          role="judge"
          :provider-options="providerOptions"
        />

        <p v-if="isCreatingTask && !claudeAvailable && workerNeedsClaudeWarning" class="warning-box">
          Claude Code CLI (claude) was not found on your PATH. The selected provider requires it.
        </p>

        <p v-if="isCreatingTask && draft.useWorktree" class="info-box">
          The agent will work in <code>{{ worktreePreviewPath }}</code
          >. Control files, git commits, and all changes stay isolated in this worktree.
        </p>
        <p v-else class="info-box">
          Control files are managed automatically. Refine the Task brief or Judge instructions any time from the
          Dashboard's Assignment tab.
        </p>
      </template>

      <!-- Terminal / Azure workspace: panel editor -->
      <template v-else>
        <p v-if="isAzure" class="info-box">
          This workspace is the Azure DevOps parent. Its checkout root is used for managed review checkouts, and these
          tabs are copied into each new review subworkspace.
        </p>
        <label
          v-if="showInternalMcpOption"
          class="internal-mcp-option"
          :title="
            isAzure
              ? 'Sets the default for newly created New Branch and manual PR workspaces. Existing workspaces keep their own setting.'
              : 'Controls whether agents in this workspace can access strIDEterm task tools.'
          "
        >
          <input
            v-model="draft.internalMcpEnabled"
            type="checkbox"
            data-testid="internal-mcp-checkbox"
            :disabled="internalMcpLocked"
          />
          Allow internal MCP for agents
          <span class="internal-mcp-hint">
            Lets Claude Code, Codex, GitHub Copilot or OpenCode agents create and monitor tasks in strIDEterm.
            <template v-if="internalMcpLocked"> Desktop only — change it in the desktop app.</template>
            <template v-if="isAzure">
              Applies to new workspaces created with New Branch or opened manually for a PR. Existing workspaces keep
              their own setting.
            </template>
            <template v-else>Applies to agent sessions started after saving.</template>
          </span>
        </label>
        <PanelEditor
          v-model:panels="draft.panels"
          :tab-templates="tabTemplates"
          :heading="isAzure ? 'Review workspace tabs' : 'Terminal tabs'"
        />
        <section
          v-if="isAzure && !isMobileSession"
          class="review-agent-preparation"
          data-testid="review-agent-preparation"
        >
          <h3>Prepare an agent for review checkouts</h3>
          <p class="field-hint">
            Prepare the selected agent for future PR and New Branch workspaces. Confirm any trust prompt in the
            temporary terminal.
          </p>
          <label
            :title="
              draft.kind === 'azure'
                ? 'Choose the Azure DevOps connection used to discover and prepare review repositories.'
                : 'Choose the GitHub connection used to discover and prepare review repositories.'
            "
          >
            <span>Connection</span>
            <CustomSelect
              v-model="preparationConnectionId"
              placeholder="Select a connection…"
              :disabled="preparationLoading || submitting"
              :options="preparationConnectionOptions"
            />
          </label>
          <label
            v-if="draft.kind === 'azure'"
            title="Choose the Azure DevOps project whose repositories you want to prepare."
          >
            <span>Project</span>
            <CustomSelect
              v-model="preparationProjectName"
              placeholder="Select a project…"
              :disabled="preparationLoading || submitting"
              :options="preparationProjectOptions"
              @change="loadPreparationRepositories"
            />
          </label>
          <div class="review-agent-repositories">
            <div class="review-agent-repositories__heading">
              <span title="Select which repositories should get a temporary agent setup terminal.">Repositories</span>
              <button
                type="button"
                class="button button--ghost"
                :disabled="!preparationRepositories.length || preparationLoading"
                :title="
                  selectedPreparationRepositoryKeys.length === preparationRepositories.length
                    ? 'Clear the repository selection.'
                    : 'Select every repository listed here.'
                "
                @click="toggleAllPreparationRepositories"
              >
                {{
                  selectedPreparationRepositoryKeys.length === preparationRepositories.length
                    ? "Clear all"
                    : "Select all"
                }}
              </button>
            </div>
            <label
              v-for="repository in preparationRepositories"
              :key="repository.key"
              class="review-agent-repository"
              :title="`Prepare a trust setup terminal for ${repository.label}.`"
            >
              <input
                v-model="selectedPreparationRepositoryKeys"
                type="checkbox"
                :value="repository.key"
                :disabled="preparationLoading || submitting"
              />
              <span>{{ repository.label }}</span>
            </label>
          </div>
          <label
            title="Choose an agent tab configured above. Its saved command runs unchanged at the stable cached repository root used by future PR worktrees. If the agent stores trust at this repository root, confirming it here can apply to future worktrees."
          >
            <span>Agent tab</span>
            <CustomSelect
              v-model="preparationPanelId"
              placeholder="Select an agent tab…"
              :disabled="preparationLoading || submitting"
              :options="preparationPanelOptions"
            />
          </label>
          <p v-if="preparationLoading" class="field-hint">Loading repositories…</p>
          <p v-if="preparationError" class="dialog__error" role="alert">{{ preparationError }}</p>
          <button
            type="button"
            class="button button--ghost"
            data-testid="prepare-review-agent"
            title="Save this workspace, then open temporary setup terminals for the selected repositories, one at a time. Confirm any trust prompt yourself. No additional workspace is added."
            :disabled="!canPrepareAgent || submitting || preparationLoading"
            @click="prepareReviewAgent"
          >
            Save and prepare agent
          </button>
        </section>
      </template>

      <!-- Detach review link — workspace is linked to a PR review -->
      <div v-if="canDetachReview" class="review-link-section">
        <div class="review-link-banner">
          <strong>Linked to PR review</strong>
          <span class="review-link-banner__detail">{{ reviewLinkLabel }}</span>
        </div>
        <p class="review-link-hint">
          Detaching makes this a normal workspace — git operations like Rebase, Merge, Push, and Force push become
          available again. The PR data on the server is not touched. Click "Save workspace" to apply.
        </p>
        <button type="button" class="button button--ghost button--danger" @click="detachReview">
          Detach from PR review
        </button>
      </div>

      <!-- Multi-repo detection banner (non-task, non-review, non-nested workspaces) -->
      <div v-if="showMultiRepoSection" class="multi-repo-section">
        <div class="multi-repo-banner">
          <span>Found {{ childRepoCount }} git repositories inside this directory.</span>
          <button
            type="button"
            class="button button--ghost multi-repo-rescan-btn"
            :disabled="rescanning"
            @click="rescanDirectory"
          >
            {{ rescanning ? "Scanning\u2026" : "Re-scan" }}
          </button>
        </div>
        <p v-if="rescanError" class="multi-repo-hint" style="color: var(--danger, #e53935)">{{ rescanError }}</p>
        <label class="multi-repo-toggle">
          <input
            type="checkbox"
            :checked="enableMultiRepo"
            @change="enableMultiRepo = ($event.target as HTMLInputElement).checked"
          />
          Treat as multi-repo workspace
        </label>
        <template v-if="enableMultiRepo">
          <label v-if="cwdIsGitRepo" class="multi-repo-parent-toggle">
            <input
              type="checkbox"
              :checked="includeParentAsRepo"
              @change="includeParentAsRepo = ($event.target as HTMLInputElement).checked"
            />
            Include parent directory as a repository
          </label>
          <details class="multi-repo-edit">
            <summary>Edit list ({{ draft.gitRoots?.length || 0 }} selected)</summary>
            <div v-for="repo in cwdProbeResult?.childRepos || []" :key="repo" class="multi-repo-repo-item">
              <label>
                <input
                  type="checkbox"
                  :checked="draft.gitRoots?.includes(repo)"
                  @change="
                    (e: Event) => {
                      if ((e.target as HTMLInputElement).checked) {
                        draft.gitRoots = [...(draft.gitRoots || []), repo].sort((a, b) =>
                          a.localeCompare(b, undefined, { sensitivity: 'accent' }),
                        );
                      } else {
                        draft.gitRoots = (draft.gitRoots || []).filter((r) => r !== repo);
                      }
                    }
                  "
                />
                {{ repo.split(/[\\/]/).at(-1) }}
                <span class="repo-path">{{ repo }}</span>
              </label>
            </div>
          </details>
          <p class="multi-repo-hint">
            Selecting this treats each detected repository as a peer — the Git pane shows a repo switcher, and new tabs
            can target any child cwd.
            <span v-if="cwdProbeResult?.truncated"> Scan was truncated — add more repos manually if missing. </span>
          </p>
        </template>
      </div>

      <div v-if="errorMessage" class="dialog__error" role="alert">
        <span class="dialog__error-icon" aria-hidden="true">⚠</span>
        <span class="dialog__error-text">{{ errorMessage }}</span>
      </div>

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

<script setup lang="ts">
import { reactive, computed, inject, ref, watch, onMounted, useAttrs } from "vue";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import type { StartReviewAgentPreparation } from "../../../electron/backend/ipc-schemas.js";
import { cloneWorkspace, createEmptyWorkspace } from "../../workspace-state.js";
import { APP_CONFIG } from "../../../config/app-config.js";
import { safeColor } from "../../app/helpers.js";
import { TASK_BRIEF_MAX_CHARS, TASK_BRIEF_HINT, formatBriefCounter } from "../../app/task-brief.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { pickPath } from "../../lib/pick-path.js";
import { rlog } from "../../lib/renderer-log.js";
import { BADGE_ICONS } from "../../lib/badge-icons.js";
import { PROVIDER_CHOICES, type ProviderConfig } from "../../lib/agent-providers.js";
import PanelEditor from "./PanelEditor.vue";
import CustomSelect from "../common/CustomSelect.vue";
import AgentProviderConfig from "./AgentProviderConfig.vue";
import { parseAgentCommand } from "../../../electron/shared/agent-ssh.js";

defineOptions({ inheritAttrs: false });

interface TaskConfig {
  description?: string;
  maxRounds?: number;
  workerPanelId?: string;
  judgePanelId?: string;
}

interface PanelEntry {
  id: string;
  title: string;
  command: string;
  shell: boolean;
  startup: string;
  launch?: unknown;
}

interface GitRootEntry {
  childRepos?: string[];
  truncated?: boolean;
}

type ReviewAgentPreparationSelection = StartReviewAgentPreparation extends infer Request
  ? Request extends object
    ? Omit<Request, "parentWorkspaceId" | "idempotencyKey">
    : never
  : never;

interface PreparationConnection {
  id: string;
  label?: string;
  enabled?: boolean;
  profileId?: string;
}

interface WorkspaceDraft {
  id: string;
  name: string;
  icon: string;
  color: string;
  kind: string;
  source: string;
  pluginId: string;
  cwd: string;
  notes: string;
  activePanelId: string;
  panels: PanelEntry[];
  // task-specific
  useWorktree?: boolean;
  worktreeBranch?: string;
  repositoryForWorktree?: string;
  task: TaskConfig;
  workerProvider: ProviderConfig;
  judgeProvider: ProviderConfig;
  workerCommandOverride: boolean;
  judgeCommandOverride: boolean;
  // internal MCP opt-in (workspace level, desktop-only to change)
  internalMcpEnabled?: boolean;
  // multi-repo
  gitRoots?: string[];
  // review workspace
  review?: { prKey?: string };
  // parent workspace reference (set during submit for task workspaces)
  parentWorkspaceId?: string;
  // index for dynamic property access in backward-compat code
  [key: string]: unknown;
}

interface TabTemplate {
  title: string;
  command: string;
  icon?: string;
}

interface Props {
  workspace?: Record<string, unknown> | null;
  tabTemplates?: TabTemplate[];
  creating?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  workspace: null,
  tabTemplates: () => [],
  creating: false,
});

// Intentionally NOT declaring "submit" in defineEmits — Vue strips declared
// events from $attrs, which would make attrs.onSubmit undefined and silently
// swallow any rejection from the parent's async submit handler. Treating
// onSubmit as a regular callback prop via useAttrs lets us await + catch.
const emit = defineEmits<{
  cancel: [];
}>();
const attrs = useAttrs();

const api = inject<Transport>(apiKey);

const cwdPlaceholder = APP_CONFIG.ui.defaultProjectCwdPlaceholder;

// Build a mutable reactive draft
const rawDraft = (props.workspace ? cloneWorkspace(props.workspace) : createEmptyWorkspace()) as WorkspaceDraft;
rawDraft.color = safeColor(rawDraft.color);
// A task marker is a backend safety boundary, so an ordinary workspace must
// never acquire one merely because it passed through this shared dialog.
if ((rawDraft.kind === "task" || props.creating) && !rawDraft.task) {
  rawDraft.task = { description: "", maxRounds: 10 };
}
if (!rawDraft.workerProvider) rawDraft.workerProvider = { providerId: "claude", model: "sonnet" };
if (!rawDraft.judgeProvider) rawDraft.judgeProvider = { providerId: "claude", model: "opus" };
// Backward compat with old workspaces: ensure skipPermissions default
if (rawDraft.kind === "task" || props.creating) {
  for (const key of ["workerProvider", "judgeProvider"] as const) {
    const provider = rawDraft[key];
    if (provider.skipPermissions === undefined) {
      const p = PROVIDER_CHOICES.find((c) => c.id === provider.providerId);
      provider.skipPermissions = p?.defaultSkipPermissions ?? false;
    }
  }
}
if (rawDraft.workerCommandOverride === undefined) rawDraft.workerCommandOverride = false;
if (rawDraft.judgeCommandOverride === undefined) rawDraft.judgeCommandOverride = false;
if (!("gitRoots" in rawDraft)) rawDraft.gitRoots = [];
if (!("repositoryForWorktree" in rawDraft)) rawDraft.repositoryForWorktree = "";
// Task workspaces never carry the grant; everything else defaults to off.
if (rawDraft.kind === "task") delete rawDraft.internalMcpEnabled;
else rawDraft.internalMcpEnabled = rawDraft.internalMcpEnabled === true;
const draft = reactive(rawDraft);

const store = useAppStore();
const isMobileSession = computed(() => store.isMobileSession());

const preparationConnections = computed(() => {
  const integrations = store.payload?.appState?.settings?.integrations as
    Record<string, { connections?: PreparationConnection[] }> | undefined;
  const key = draft.kind === "github" ? "github" : "azureDevops";
  const activeProfileId = String(draft.profileId || store.myActiveProfileId || "default");
  return (integrations?.[key]?.connections || []).filter(
    (connection) => connection.enabled !== false && String(connection.profileId || "default") === activeProfileId,
  );
});
const preparationPanels = computed(() =>
  (draft.panels || []).filter((panel) => !panel.launch && !!parseAgentCommand(panel.command)),
);
const preparationConnectionOptions = computed(() =>
  preparationConnections.value.map((connection) => ({
    value: connection.id,
    label: connection.label || connection.id,
  })),
);
const preparationProjectOptions = computed(() =>
  preparationProjects.value.map((project) => ({ value: project.name, label: project.name })),
);
const preparationPanelOptions = computed(() =>
  preparationPanels.value.map((panel) => ({ value: panel.id, label: panel.title || panel.command })),
);
const preparationConnectionId = ref("");
const preparationProjectName = ref("");
const selectedPreparationRepositoryKeys = ref<string[]>([]);
const preparationPanelId = ref("");
const preparationProjects = ref<{ name: string }[]>([]);
const preparationRepositories = ref<{ key: string; label: string; id?: string; owner?: string; repo?: string }[]>([]);
const preparationLoading = ref(false);
const preparationError = ref("");
let preparationLoadGeneration = 0;
const canPrepareAgent = computed(
  () =>
    !isMobileSession.value &&
    preparationConnections.value.some((connection) => connection.id === preparationConnectionId.value) &&
    (draft.kind !== "azure" || !!preparationProjectName.value) &&
    selectedPreparationRepositoryKeys.value.length > 0 &&
    selectedPreparationRepositoryKeys.value.every((key) =>
      preparationRepositories.value.some((repository) => repository.key === key),
    ) &&
    preparationPanels.value.some((panel) => panel.id === preparationPanelId.value) &&
    typeof attrs.onPrepareAgent === "function",
);

watch(
  preparationConnections,
  (connections) => {
    if (!connections.some((connection) => connection.id === preparationConnectionId.value)) {
      preparationConnectionId.value = connections.length === 1 ? connections[0].id : "";
      preparationProjectName.value = "";
      preparationProjects.value = [];
      preparationRepositories.value = [];
    }
  },
  { immediate: true },
);
watch(
  preparationPanels,
  (panels) => {
    if (!panels.some((panel) => panel.id === preparationPanelId.value)) {
      preparationPanelId.value = panels.length === 1 ? panels[0].id : "";
    }
  },
  { immediate: true },
);
watch(preparationConnectionId, () => void loadPreparationProjects(), { immediate: true });

const isDocker = computed(() => draft.kind === "docker");
const isAzure = computed(() => draft.kind === "azure" || draft.kind === "github");
const isTask = computed(() => draft.kind === "task");
const isCreatingTask = computed(() => isTask.value && props.creating);
const showInternalMcpOption = computed(() => !isTask.value && !isDocker.value);
const internalMcpLocked = computed(() => store.isRemoteTransport);
const taskDescriptionLength = computed(() => (draft.task?.description || "").length);

const submitting = ref(false);
// Inline error surface — shown as a banner above the footer when the parent
// onSubmit handler rejects (e.g. backend git error). Cleared on each submit
// attempt so stale errors don't linger after the user corrects the input.
const errorMessage = ref("");

// Git-repo probe result for the current cwd. null = unknown (still loading
// or API unavailable), true = git repo, false = plain directory. Used to
// gate the "Create in git worktree" checkbox so the user can't pick an
// impossible path that would fail at submit time.
const cwdIsGitRepo = ref<boolean | null>(null);
interface ProbeResult {
  isGitRepo?: boolean;
  childRepos?: string[];
  truncated?: boolean;
  prKey?: string;
  [key: string]: unknown;
}
const cwdProbeResult = ref<ProbeResult | null>(null); // { isGitRepo, childRepos, truncated }
const rescanning = ref(false);
const rescanError = ref("");
// Track whether the user has edited the Name field — once they have, we
// stop overwriting it with the auto-filled "{folder} · {branch}" pattern.
const nameAutoGenerated = ref(!(draft.name || "").trim());

function basenameOf(p: string) {
  const trimmed = String(p || "")
    .trim()
    .replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function buildAutoName() {
  const base = basenameOf(draft.cwd);
  if (!base) return "";
  const branch = (draft.worktreeBranch || "").trim();
  return draft.useWorktree && branch ? `${base} - ${branch}` : base;
}

// Auto-fill Name from cwd basename (+ branch when worktree is on). Stops
// overwriting as soon as the user types something that doesn't match the
// auto-generated pattern — their edit wins.
watch(
  [() => draft.cwd, () => draft.useWorktree, () => draft.worktreeBranch],
  () => {
    if (!isCreatingTask.value || !nameAutoGenerated.value) return;
    const next = buildAutoName();
    if (next) draft.name = next;
  },
  { immediate: true },
);
watch(
  () => draft.name,
  (val) => {
    if (!isCreatingTask.value) return;
    if (!val) {
      nameAutoGenerated.value = true;
      return;
    }
    if (val !== buildAutoName()) nameAutoGenerated.value = false;
  },
);

// Probe whether the cwd is a git repo and detect child repos for multi-root.
// Debounced so typing into the path field doesn't spam the backend.
let gitProbeTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => draft.cwd,
  (cwd) => {
    if (gitProbeTimer) clearTimeout(gitProbeTimer);
    const trimmed = (cwd || "").trim();
    if (!trimmed) {
      cwdIsGitRepo.value = null;
      cwdProbeResult.value = null;
      return;
    }
    // While the probe is in flight treat state as unknown — avoids a
    // frame of "(not a git repo)" when the user is mid-typing a valid path.
    if (isCreatingTask.value) cwdIsGitRepo.value = null;
    gitProbeTimer = setTimeout(async () => {
      if ((draft.cwd || "").trim() !== trimmed) return;
      try {
        const [repoResult, probeResult] = await Promise.all([
          api?.checkIsGitRepo ? api.checkIsGitRepo(trimmed) : null,
          api?.probeDirectory ? api.probeDirectory(trimmed).catch(() => null) : null,
        ]);
        const typedRepoResult = repoResult as { isGitRepo?: boolean } | null;
        const typedProbeResult = probeResult as ProbeResult | null;
        if ((draft.cwd || "").trim() !== trimmed) return;
        if (typedRepoResult !== null) {
          cwdIsGitRepo.value = !!typedRepoResult?.isGitRepo;
          if (isCreatingTask.value && !typedRepoResult?.isGitRepo && draft.useWorktree) {
            draft.useWorktree = false;
          }
        }
        cwdProbeResult.value = typedProbeResult;
      } catch {
        // On probe failure, stay permissive — don't block on a transient error.
        cwdIsGitRepo.value = null;
        cwdProbeResult.value = null;
      }
    }, 350);
  },
  { immediate: true },
);

// Claude availability (cached in payload, re-checked before dialog opens)
const claudeAvailable = computed(() => store.payload?.environment?.claudeAvailable !== false);

// §14: parent workspace lookup for task workspaces
const parentWorkspace = computed(() => {
  if (!isCreatingTask.value) return null;
  const normCwd = (draft.cwd || "")
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
  if (!normCwd) return null;
  const activeProfileId = store.myActiveProfileId || "default";
  return (
    (store.filteredWorkspaces || []).find(
      (ws) =>
        ws.kind !== "task" &&
        (ws.profileId || "default") === activeProfileId &&
        (ws.cwd || "")
          .replace(/[\\/]+$/, "")
          .replace(/\\/g, "/")
          .toLowerCase() === normCwd,
    ) || null
  );
});
const parentIsMultiRepo = computed(
  () => Array.isArray(parentWorkspace.value?.gitRoots) && parentWorkspace.value.gitRoots.length >= 2,
);
const parentGitRoots = computed(() => parentWorkspace.value?.gitRoots || []);

// Multi-repo detection
const childRepoCount = computed(() => cwdProbeResult.value?.childRepos?.length || 0);
// Hide when task workspace (shown differently via parent lookup) or parent is already multi-repo (no nesting)
const showMultiRepoSection = computed(
  () => !isReviewWorkspace.value && !isTask.value && !parentIsMultiRepo.value && childRepoCount.value >= 2,
);
const isReviewWorkspace = computed(() => isAzure.value || !!draft.review?.prKey);
// True for workspaces linked to a specific PR (any provider, any checkout
// mode). Azure parent workspaces (kind === "azure") don't have a prKey, so
// they're correctly excluded.
const canDetachReview = computed(() => !!draft.review?.prKey);
const reviewLinkLabel = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = draft.review as any;
  if (!r) return "";
  const provider =
    r.provider === "github" ? "GitHub" : r.provider === "azure-devops" ? "Azure DevOps" : r.provider || "";
  const repo = r.repository?.name || "";
  const prId = r.pullRequest?.number || r.pullRequest?.id || "";
  const title = r.pullRequest?.title || "";
  const head = [provider, repo].filter(Boolean).join(" ");
  const tail = [prId ? `PR #${prId}` : "", title].filter(Boolean).join(" — ");
  return [head, tail].filter(Boolean).join(" · ");
});
function detachReview() {
  // Clear the review marker. Also strip the auto-set notes prefix (Azure /
  // GitHub managed review checkouts add it on creation, and the lifecycle
  // pass treats it as a re-attach hint), so the next backend poll doesn't
  // re-attach the metadata.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (draft as any).review = null;
  if (/^(Azure DevOps|GitHub) review workspace for /.test(draft.notes || "")) {
    draft.notes = "";
  }
}
const enableMultiRepo = computed({
  get: () => (draft.gitRoots?.length || 0) >= 2,
  set: (val) => {
    if (val) {
      draft.gitRoots = [...(cwdProbeResult.value?.childRepos || [])].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "accent" }),
      );
    } else {
      draft.gitRoots = [];
    }
  },
});
const includeParentAsRepo = computed({
  get: () => !!(cwdIsGitRepo.value && draft.gitRoots?.includes && draft.gitRoots.includes(draft.cwd)),
  set: (val) => {
    if (!draft.gitRoots) draft.gitRoots = [];
    if (val && !draft.gitRoots.includes(draft.cwd)) {
      draft.gitRoots = [draft.cwd, ...draft.gitRoots].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "accent" }),
      );
    } else if (!val) {
      draft.gitRoots = draft.gitRoots.filter((r) => r !== draft.cwd);
    }
  },
});

// Provider availability — populated asynchronously from checkProviders()
const providerAvailability = ref<Record<string, { available?: boolean }>>({});

onMounted(async () => {
  if (api?.checkProviders) {
    try {
      const result = (await api.checkProviders?.()) as Record<string, { available?: boolean }> | undefined;
      if (result) providerAvailability.value = result;
    } catch (err) {
      rlog("warn", "WorkspaceDialog: checkProviders failed, provider availability may be stale", {
        err: (err as Error)?.message || String(err),
      });
    }
  }
});

const workerNeedsClaudeWarning = computed(() => {
  const pid = draft.workerProvider?.providerId || draft.judgeProvider?.providerId;
  return pid === "claude" || !pid;
});

const providerOptions = computed(() =>
  PROVIDER_CHOICES.map((p) => ({
    value: p.id,
    label: `${p.name}${providerAvailability.value[p.id]?.available === false ? " (not found)" : ""}`,
    disabled: providerAvailability.value[p.id]?.available === false,
  })),
);

const repositoryForWorktreeOptions = computed(() =>
  parentGitRoots.value.map((root: string) => ({
    value: root,
    label: `${root.split(/[\\/]/).filter(Boolean).at(-1)} — ${root}`,
  })),
);

// For task workspaces: direct references to worker/judge panels for editing
const workerPanel = computed(
  () => draft.panels?.find((p) => p.id === draft.task?.workerPanelId) || { command: "claude" },
);
const judgePanel = computed(
  () => draft.panels?.find((p) => p.id === draft.task?.judgePanelId) || { command: "claude" },
);

// --- Worktree branch auto-generation (task creation only) ---
const branchAutoGenerated = ref(true);

function slugifyBranch(text: string) {
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
    draft.worktreeBranch = slugifyBranch(desc ?? "");
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
    if (draft.useWorktree && parentIsMultiRepo.value && !draft.repositoryForWorktree) return false;
  }
  if (submitting.value) return false;
  return true;
});

async function browseCwd() {
  const browseDirectory = api?.browseDirectory;
  if (!browseDirectory) return;
  const selected = await pickPath(() => browseDirectory(draft.cwd || ""));
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

async function rescanDirectory() {
  const trimmed = (draft.cwd || "").trim();
  if (!trimmed || !api?.probeDirectory) return;
  rescanning.value = true;
  rescanError.value = "";
  try {
    cwdProbeResult.value = (await api.probeDirectory(trimmed)) as ProbeResult | null;
  } catch (err) {
    rescanError.value = (err as Error)?.message || "Failed to re-scan directory.";
  } finally {
    rescanning.value = false;
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

async function loadPreparationProjects() {
  const generation = ++preparationLoadGeneration;
  const connectionId = preparationConnectionId.value;
  const profileId = String(draft.profileId || store.myActiveProfileId || "default");
  const kind = draft.kind;
  preparationError.value = "";
  if (kind === "azure") preparationProjectName.value = "";
  selectedPreparationRepositoryKeys.value = [];
  preparationProjects.value = [];
  preparationRepositories.value = [];
  if (store.isMobileSession() || !connectionId || !api) return;
  if (kind === "github") {
    await loadPreparationRepositories();
    return;
  }
  preparationLoading.value = true;
  try {
    const result = (await api.azureQuickFixListProjects?.({
      connectionId,
    })) as { projects?: { id?: string; name: string }[] } | undefined;
    if (
      generation !== preparationLoadGeneration ||
      preparationConnectionId.value !== connectionId ||
      draft.kind !== kind ||
      String(draft.profileId || store.myActiveProfileId || "default") !== profileId ||
      !preparationConnections.value.some((connection) => connection.id === connectionId)
    )
      return;
    preparationProjects.value = result?.projects || [];
    if (preparationProjects.value.length === 1) {
      preparationProjectName.value = preparationProjects.value[0].name;
      await loadPreparationRepositories();
    }
  } catch (err) {
    if (generation === preparationLoadGeneration) reportPreparationError("Couldn't load review projects", err);
  } finally {
    if (generation === preparationLoadGeneration) preparationLoading.value = false;
  }
}

async function loadPreparationRepositories() {
  const generation = ++preparationLoadGeneration;
  const connectionId = preparationConnectionId.value;
  const projectName = preparationProjectName.value;
  const profileId = String(draft.profileId || store.myActiveProfileId || "default");
  const kind = draft.kind;
  preparationError.value = "";
  selectedPreparationRepositoryKeys.value = [];
  preparationRepositories.value = [];
  if (store.isMobileSession() || !connectionId || !api || (kind === "azure" && !projectName)) return;
  preparationLoading.value = true;
  try {
    const result =
      kind === "azure"
        ? ((await api.azureQuickFixListRepositories?.({
            connectionId,
            projectName,
          })) as { repositories?: { id?: string; name: string }[] } | undefined)
        : ((await api.githubQuickFixListRepos?.({ connectionId })) as
            { repositories?: { name: string; fullName?: string; owner?: string }[] } | undefined);
    if (
      generation !== preparationLoadGeneration ||
      preparationConnectionId.value !== connectionId ||
      preparationProjectName.value !== projectName ||
      draft.kind !== kind ||
      String(draft.profileId || store.myActiveProfileId || "default") !== profileId ||
      !preparationConnections.value.some((connection) => connection.id === connectionId)
    )
      return;
    const repositories = result?.repositories || [];
    preparationRepositories.value =
      kind === "azure"
        ? (repositories as { id?: string; name: string }[])
            .filter((repository) => repository.id !== undefined)
            .map((repository) => ({ key: String(repository.id), id: String(repository.id), label: repository.name }))
        : (repositories as { name: string; fullName?: string; owner?: string }[])
            .filter((repository) => repository.owner && repository.name)
            .map((repository) => ({
              key: `${repository.owner}/${repository.name}`,
              owner: repository.owner,
              repo: repository.name,
              label: repository.fullName || `${repository.owner}/${repository.name}`,
            }));
    if (preparationRepositories.value.length === 1) {
      selectedPreparationRepositoryKeys.value = [preparationRepositories.value[0].key];
    }
  } catch (err) {
    if (generation === preparationLoadGeneration) reportPreparationError("Couldn't load review repositories", err);
  } finally {
    if (generation === preparationLoadGeneration) preparationLoading.value = false;
  }
}

function reportPreparationError(title: string, error: unknown): void {
  preparationError.value = extractErrorMessage(error);
  useNotificationStore().showError(title, error, {
    workspaceId: draft.id,
    profileId: String(draft.profileId || store.myActiveProfileId || "default"),
  });
}

function toggleAllPreparationRepositories(): void {
  const allKeys = preparationRepositories.value.map((repository) => repository.key);
  selectedPreparationRepositoryKeys.value =
    selectedPreparationRepositoryKeys.value.length === allKeys.length ? [] : allKeys;
}

async function prepareReviewAgent() {
  if (store.isMobileSession() || !canPrepareAgent.value) return;
  const repositories = preparationRepositories.value.filter((entry) =>
    selectedPreparationRepositoryKeys.value.includes(entry.key),
  );
  if (!repositories.length) return;
  preparationLoading.value = true;
  preparationError.value = "";
  submitting.value = true;
  try {
    const request = {
      workspace: {
        ...draft,
        name: draft.name.trim(),
        icon: draft.icon.trim() || APP_CONFIG.ui.defaultProjectIcon,
        cwd: draft.cwd.trim(),
        notes: draft.notes.trim(),
        panels: draft.panels.map((panel) => ({
          ...panel,
          title: panel.title.trim() || APP_CONFIG.ui.defaultPanelTitle,
          command: panel.command.trim() || "",
          startup: APP_CONFIG.ui.defaultPanelStartup,
        })),
      } as WorkspaceDraft,
      selections: repositories.map((repository) => ({
        repositoryName: repository.label,
        selection:
          draft.kind === "azure"
            ? {
                provider: "azure-devops" as const,
                connectionId: preparationConnectionId.value,
                projectName: preparationProjectName.value,
                repositoryId: repository.id!,
                panelId: preparationPanelId.value,
              }
            : {
                provider: "github" as const,
                connectionId: preparationConnectionId.value,
                owner: repository.owner!,
                repo: repository.repo!,
                panelId: preparationPanelId.value,
              },
      })),
    } satisfies {
      workspace: WorkspaceDraft;
      selections: { repositoryName: string; selection: ReviewAgentPreparationSelection }[];
    };
    const callback = attrs.onPrepareAgent as ((value: typeof request) => Promise<unknown>) | undefined;
    await callback?.(request);
  } catch (err) {
    reportPreparationError("Couldn't prepare the agent setup terminal", err);
  } finally {
    preparationLoading.value = false;
    submitting.value = false;
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

  if (isCreatingTask.value) {
    // §14: When the parent is multi-repo and a worktree is requested, use the selected repo as the effective cwd.
    if (draft.useWorktree && parentIsMultiRepo.value && draft.repositoryForWorktree) {
      result.cwd = draft.repositoryForWorktree;
    }
    // Propagate the known parent workspace ID so the handler doesn't need to re-detect it.
    if (parentWorkspace.value) {
      result.parentWorkspaceId = parentWorkspace.value.id;
    }
    // Non-worktree task inside a multi-repo parent inherits gitRoots so the git pane works.
    if (!draft.useWorktree && parentIsMultiRepo.value) {
      result.gitRoots = parentGitRoots.value;
    }
  }

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
      result.activePanelId = result.panels[0]?.id || "";
    }
  }

  submitting.value = true;
  errorMessage.value = "";
  try {
    // Call the parent-provided onSubmit directly (via attrs) rather than
    // emit so we can await the async handler and catch its rejection —
    // emit is fire-and-forget and would swallow backend errors, leaving
    // the dialog open with no feedback about what went wrong.
    await (attrs.onSubmit as ((result: unknown) => Promise<void>) | undefined)?.(result);
  } catch (err) {
    errorMessage.value = extractErrorMessage(err);
  } finally {
    submitting.value = false;
  }
}

// Error surfaced by either the backend (Electron IPC forwards "Error: …")
// or a thrown Error from the parent handler. Strip the leading "Error:
// Error invoking remote method '…': Error:" prefix that Electron wraps
// around remote rejections — it's noise for end users.
function extractErrorMessage(err: unknown): string {
  const raw = (err as Error)?.message || String(err || "Unknown error");
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
}
</script>

<style scoped>
.internal-mcp-option {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
}
.review-agent-preparation {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.review-agent-preparation h3 {
  margin: 0;
  font-size: 14px;
}
.review-agent-preparation .field-hint {
  margin: 0;
}
.review-agent-repositories {
  display: grid;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.review-agent-repositories__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.review-agent-repository {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}
.review-agent-repository input[type="checkbox"] {
  width: auto;
  flex: 0 0 auto;
  margin: 2px 0 0;
  accent-color: var(--accent);
}
.review-agent-repository span {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  text-transform: none;
  letter-spacing: normal;
}
.internal-mcp-option input[type="checkbox"] {
  width: auto;
  flex: none;
  margin: 0;
}
/* Undo the global `label span` field-caption style (overlay.css). */
.internal-mcp-hint {
  flex-basis: 100%;
  font-size: 11px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--muted);
}
.appearance-details {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
  padding: 6px 10px;
}
.appearance-summary {
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
  padding: 2px 0;
}
.appearance-summary:hover {
  color: var(--text);
}
.appearance-details[open] .appearance-summary {
  margin-bottom: 8px;
  color: var(--text);
}
.appearance-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
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
.checkbox-label--disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.checkbox-label--disabled input[type="checkbox"] {
  cursor: not-allowed;
}
.field-hint {
  display: block;
  font-size: 11px;
  color: var(--muted, #888);
  margin-top: 4px;
  line-height: 1.4;
}
.field-hint--inline {
  display: inline;
  margin: 0 0 0 4px;
  font-style: italic;
}
.field-counter {
  text-align: right;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}
.field-counter--near-limit {
  color: var(--accent, #ffa424);
}
.multi-repo-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
}
.review-link-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  background: rgba(255, 200, 100, 0.05);
}
.review-link-banner {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
}
.review-link-banner__detail {
  color: var(--muted);
}
.review-link-hint {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
.multi-repo-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
}
.multi-repo-rescan-btn {
  padding: 2px 8px;
  font-size: 12px;
  opacity: 0.7;
}
.multi-repo-rescan-btn:not(:disabled):hover {
  opacity: 1;
}
.multi-repo-toggle {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
}
.multi-repo-toggle input[type="checkbox"],
.multi-repo-parent-toggle input[type="checkbox"] {
  width: auto;
  flex: none;
  margin: 0;
}
.multi-repo-parent-toggle {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.85;
}
.multi-repo-edit {
  font-size: 12px;
}
.multi-repo-edit summary {
  cursor: pointer;
  color: var(--muted);
  padding: 2px 0;
}
.multi-repo-repo-item {
  padding: 3px 0 3px 16px;
}
.multi-repo-repo-item label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  flex-direction: row;
}
.repo-path {
  font-size: 10px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
}
.multi-repo-hint {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
  margin: 0;
}
</style>
