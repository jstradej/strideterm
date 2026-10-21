<template>
  <div
    ref="changesRoot"
    class="git-section git-section--changes"
    :class="{ 'git-changes--mobile': compactChanges }"
    :data-mode="mobileMode ? mobileMode : undefined"
    :data-layout="compactChanges ? mobileLayout : undefined"
  >
    <header v-if="mobileMode" class="git-changes__mobile-head">
      <button
        v-if="mobileMode === 'list'"
        class="git-changes__mobile-branch button button--ghost"
        type="button"
        title="Browse and switch branches"
        :disabled="!!gitUi.busyAction || operation.inProgress"
        @click="gitUiStore.gitSwitchTab(workspaceId, 'branches')"
      >
        {{ snapshot.branch || "Detached HEAD" }} ▾
      </button>
      <button
        v-if="mobileMode === 'list'"
        type="button"
        class="button button--ghost"
        aria-label="Refresh repository"
        @click="gitUiStore.refreshGit(workspaceId)"
      >
        ↻
      </button>
      <button v-if="mobileMode !== 'list'" type="button" class="button button--ghost" @click="returnToList">
        ‹ Changes
      </button>
      <span
        v-if="mobileMode === 'diff'"
        class="git-changes__mobile-path"
        :title="gitUi.selectedDiff?.path"
        :aria-label="gitUi.selectedDiff?.path"
      >
        <span class="git-changes__mobile-path-prefix">{{ selectedPathPrefix }}</span>
        <strong>{{ selectedPathBase }}</strong>
      </span>
      <span v-if="mobileMode === 'commit'">Commit changes</span>
      <button
        v-if="mobileMode === 'diff'"
        type="button"
        class="button button--ghost"
        aria-label="Previous file"
        @click="moveDiff(-1)"
      >
        ↑
      </button>
      <button
        v-if="mobileMode === 'diff'"
        type="button"
        class="button button--ghost"
        aria-label="Next file"
        @click="moveDiff(1)"
      >
        ↓
      </button>
    </header>
    <nav
      v-if="mobileMode === 'list' || (mobileLayout === 'split' && mobileMode === 'diff')"
      class="git-changes__filters"
      aria-label="Change scope filter"
    >
      <button
        v-for="filter in scopeFilters"
        :key="filter.id"
        type="button"
        :aria-pressed="activeFilter === filter.id"
        :class="{ active: activeFilter === filter.id }"
        @click="activeFilter = filter.id"
      >
        {{ filter.label }}<span>{{ filter.id === "all" ? distinctPaths.size : scopeCounts[filter.id] }}</span>
      </button>
    </nav>

    <div class="git-changes__body">
      <div class="git-changes__layout">
        <Splitpanes v-if="!compactChanges" :horizontal="isNarrow" class="default-theme git-changes__splitpanes">
          <Pane :size="40" :min-size="20">
            <div class="git-section__files git-section__files--split">
              <article class="git-card">
                <div v-if="!compactChanges" class="section-head">
                  <div>
                    <p class="eyebrow">Changes</p>
                    <h3>{{ snapshot.dirty ? "Working tree overview" : "No local changes" }}</h3>
                  </div>
                </div>
                <div
                  v-if="isDetachedHead && !compactChanges"
                  class="git-info-banner git-info-banner--warn"
                  style="margin-bottom: 8px"
                >
                  <strong>Detached HEAD</strong>
                  <p>You are on a detached HEAD. Commits will be lost unless you create a branch.</p>
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    @click="gitUiStore.gitCreateBranch(workspaceId, `branch-from-detached`, '')"
                  >
                    Create branch from HEAD
                  </button>
                </div>
                <GitDiffStat v-if="!compactChanges" :stat="snapshot.diffStat" />
                <GitChangeTree
                  :files="allChangedFiles"
                  :selected-path="gitUi.selectedDiff?.path || ''"
                  :selected-scope="gitUi.selectedDiff?.scope || ''"
                  :selectable="snapshot.dirty"
                  :selected-set="selectedPaths"
                  :grouped="compactChanges"
                  :scope-filter="mobileMode ? activeFilter : 'all'"
                  :staging-enabled="newView"
                  :staging-busy="!!gitUi.busyAction || operation.inProgress"
                  @select="onFileSelect"
                  @toggle-select="toggleSelect"
                  @context-menu="onFileContextMenu"
                  @stage-file="onStageFile"
                />
                <div v-if="newView && snapshot.dirty" class="git-commit-form" style="margin-top: 12px">
                  <input
                    v-model="stagedCommitMessage"
                    name="commit-staged-message"
                    type="text"
                    placeholder="Commit staged changes"
                    :disabled="!!gitUi.busyAction || operation.inProgress"
                    @keydown.enter="onCommitStaged"
                  />
                  <button
                    type="button"
                    class="button"
                    :disabled="
                      !!gitUi.busyAction ||
                      !stagedCommitMessage.trim() ||
                      stagedFiles.size === 0 ||
                      operation.inProgress
                    "
                    @click="onCommitStaged"
                  >
                    Commit staged ({{ stagedFiles.size }} {{ stagedFiles.size === 1 ? "file" : "files" }})
                  </button>
                </div>
                <div
                  v-else-if="!newView && !mobileMode && snapshot.dirty"
                  class="git-commit-form"
                  style="margin-top: 12px"
                >
                  <input
                    v-model="commitMessage"
                    name="commit-message"
                    type="text"
                    placeholder="Commit message"
                    :disabled="operation.inProgress"
                    :title="!snapshot.staged?.length && snapshot.dirty ? 'Will stage and commit all changes' : ''"
                    @keydown.enter="onCommitAll"
                  />
                  <button
                    type="button"
                    class="button"
                    :disabled="
                      !!gitUi.busyAction || !commitMessage.trim() || operation.inProgress || !!gitUi.pendingAction
                    "
                    :title="commitButtonTitle"
                    @click="onCommitAll"
                  >
                    {{ commitButtonLabel }}
                  </button>
                </div>
                <div v-if="!mobileMode && snapshot.dirty" class="git-stash-form" style="margin-top: 8px">
                  <input
                    v-model="stashMessage"
                    name="stash-message"
                    type="text"
                    class="git-stash-form__message"
                    placeholder="Stash message (optional)"
                    :disabled="stashBusy"
                  />
                  <label class="git-stash-form__untracked" title="Also stash files git isn't tracking yet">
                    <input
                      type="checkbox"
                      :checked="includeUntracked"
                      :disabled="stashBusy"
                      @change="onToggleUntracked"
                    />
                    <span>Include untracked</span>
                  </label>
                  <div class="git-stash-form__buttons">
                    <button
                      type="button"
                      class="button button--ghost button--small"
                      :disabled="stashBusy || !distinctPaths.size"
                      :title="allSelected ? 'Uncheck every file' : 'Check every changed file'"
                      @click="toggleSelectAll"
                    >
                      {{ allSelected ? "Clear" : "Select all" }}
                    </button>
                    <button
                      type="button"
                      class="button button--small"
                      :disabled="stashBusy || selectedPaths.size === 0"
                      title="Stash only the checked files — the rest stay in your working tree. The message above names the stash."
                      @click="onStashSelected"
                    >
                      {{ stashBusy ? "Stashing…" : `Stash selected (${selectedPaths.size})` }}
                    </button>
                    <button
                      type="button"
                      class="button button--ghost button--small"
                      :disabled="stashBusy"
                      title="Stash the entire working tree and clear it. The message above names the stash."
                      @click="onStashAll"
                    >
                      Stash all
                    </button>
                  </div>
                </div>
                <div
                  v-if="!mobileMode && initialCommitPrompt"
                  class="git-info-banner git-info-banner--warn"
                  style="margin-top: 8px"
                >
                  <strong>No commits yet</strong>
                  <p>
                    Stash needs an initial commit to attach to. Create an empty initial commit now and stash on top of
                    it?
                  </p>
                  <div class="git-stash-form__buttons" style="margin-left: 0">
                    <button
                      type="button"
                      class="button button--small"
                      :disabled="stashBusy"
                      @click="confirmCreateInitialCommit"
                    >
                      {{ stashBusy ? "Working…" : "Create empty commit & stash" }}
                    </button>
                    <button
                      type="button"
                      class="button button--ghost button--small"
                      :disabled="stashBusy"
                      @click="clearInitialCommitPrompt"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </article>
            </div>
          </Pane>
          <Pane :size="60" :min-size="25">
            <div class="git-section__preview git-section__preview--diff">
              <article class="git-card git-card--diff">
                <div v-if="!compactChanges" class="section-head">
                  <div>
                    <p class="eyebrow">Diff Preview</p>
                    <h3>{{ gitUi.selectedDiff?.path || "Select a file" }}</h3>
                  </div>
                </div>
                <div class="git-monaco-host">
                  <p v-if="newView && gitUi.selectedDiff?.path" class="git-changes__diff-scope">{{ diffLayerLabel }}</p>
                  <div
                    v-if="
                      newView &&
                      gitUi.selectedDiff?.scope !== 'untracked' &&
                      gitUi.selectedDiff?.scope !== 'conflict' &&
                      monacoDiffPayload?.diffToken
                    "
                    class="git-changes__hunk-actions"
                  >
                    <button
                      v-for="(hunk, index) in diffHunks"
                      :key="`${index}:${hunk.slice(0, 40)}`"
                      type="button"
                      class="button button--ghost button--small"
                      :disabled="!!gitUi.busyAction || operation.inProgress || monacoDiffLoading"
                      @click="onStageHunk(hunk, index)"
                    >
                      {{ gitUi.selectedDiff?.scope === "staged" ? "Unstage" : "Stage" }} hunk {{ index + 1 }}
                    </button>
                  </div>
                  <MonacoDiffPanel
                    v-if="gitUi.selectedDiff?.path"
                    :payload="monacoDiffPayload"
                    :loading="monacoDiffLoading"
                    :initial-inline="compactChanges"
                  />
                  <p v-else class="git-card__hint">Click a file to load a diff preview.</p>
                </div>
              </article>
            </div>
          </Pane>
        </Splitpanes>
        <div v-show="compactChanges && mobileMode !== 'commit'" class="git-changes__mobile-panes">
          <div
            class="git-changes__mobile-list"
            :class="{ 'is-visible': mobileMode === 'list' || mobileLayout === 'split' }"
          >
            <div
              v-if="compactChanges && mobileMode === 'list' && isDetachedHead"
              class="git-info-banner git-info-banner--warn git-changes__detached-banner"
            >
              <strong>Detached HEAD</strong><span>Commits may be lost unless you create a branch.</span>
              <button
                type="button"
                class="button button--ghost button--small"
                @click="gitUiStore.gitCreateBranch(workspaceId, 'branch-from-detached', '')"
              >
                Create branch
              </button>
            </div>
            <GitChangeTree
              :key="`${workspaceId}:${activeRootPath}`"
              v-model:expanded-set="mobileExpandedDirectories"
              :files="allChangedFiles"
              :selected-path="gitUi.selectedDiff?.path || ''"
              :selected-scope="gitUi.selectedDiff?.scope || ''"
              :selectable="snapshot.dirty"
              :selected-set="selectedPaths"
              :grouped="true"
              :scope-filter="activeFilter"
              :staging-enabled="newView"
              :staging-busy="!!gitUi.busyAction || operation.inProgress"
              @select="onFileSelect"
              @toggle-select="toggleSelect"
              @context-menu="onFileContextMenu"
              @stage-file="onStageFile"
            />
            <details
              v-if="compactChanges && mobileMode === 'list' && snapshot.dirty"
              class="git-changes__mobile-actions"
            >
              <summary>More actions</summary>
              <div class="git-stash-form">
                <input
                  v-model="stashMessage"
                  name="mobile-stash-message"
                  type="text"
                  class="git-stash-form__message"
                  placeholder="Stash message (optional)"
                  :disabled="stashBusy"
                />
                <label class="git-stash-form__untracked"
                  ><input
                    type="checkbox"
                    :checked="includeUntracked"
                    :disabled="stashBusy"
                    @change="onToggleUntracked"
                  /><span>Include untracked</span></label
                >
                <button
                  type="button"
                  class="button button--small"
                  :disabled="stashBusy || !selectedPaths.size"
                  @click="onStashSelected"
                >
                  Stash selected ({{ selectedPaths.size }})
                </button>
                <button
                  type="button"
                  class="button button--ghost button--small"
                  :disabled="stashBusy"
                  @click="onStashAll"
                >
                  Stash all
                </button>
              </div>
              <div v-if="initialCommitPrompt" class="git-info-banner git-info-banner--warn">
                <strong>No commits yet</strong>
                <p>Create an empty initial commit before stashing?</p>
                <button
                  type="button"
                  class="button button--small"
                  :disabled="stashBusy"
                  @click="confirmCreateInitialCommit"
                >
                  Create empty commit & stash
                </button>
                <button
                  type="button"
                  class="button button--ghost button--small"
                  :disabled="stashBusy"
                  @click="clearInitialCommitPrompt"
                >
                  Cancel
                </button>
              </div>
            </details>
          </div>
          <div
            class="git-changes__mobile-diff"
            :class="{ 'is-visible': mobileMode === 'diff' || mobileLayout === 'split' }"
          >
            <MonacoDiffPanel
              v-if="compactChanges && gitUi.selectedDiff?.path"
              :payload="monacoDiffPayload"
              :loading="monacoDiffLoading"
              :initial-inline="true"
            />
            <p v-else class="git-card__hint">Select a file to load a diff preview.</p>
          </div>
        </div>
        <section v-if="mobileMode === 'commit'" class="git-changes__commit-screen">
          <label :for="commitMessageId">Commit message</label>
          <textarea
            :id="commitMessageId"
            ref="commitMessageInput"
            v-model="commitMessage"
            placeholder="Describe the change…"
            :disabled="commitBusy || !!gitUi.busyAction || operation.inProgress"
          />
          <strong>{{
            selectedPaths.size ? `Selected paths (${selectedPaths.size})` : `All changes (${distinctPaths.size} files)`
          }}</strong>
          <p>Selection is by path. Staged and unstaged changes to the same file are committed together.</p>
          <p v-if="renameSelection.previousPaths.length">Renamed files include their previous path.</p>
        </section>
      </div>
    </div>

    <footer v-if="mobileMode" class="git-changes__mobile-dock">
      <template v-if="mobileMode === 'list' || (mobileLayout === 'split' && mobileMode === 'diff')">
        <span>{{ selectedPaths.size ? `${selectedPaths.size} selected` : `${distinctPaths.size} files` }}</span>
        <button v-if="snapshot.dirty" type="button" class="button" @click="openMobileCommit">
          {{ selectedPaths.size ? `Commit ${selectedPaths.size}…` : "Commit all…" }}
        </button>
      </template>
      <template v-else-if="mobileMode === 'commit'">
        <button type="button" class="button button--ghost" @click="returnToList">Back to changes</button>
        <button
          type="button"
          class="button"
          :disabled="
            commitBusy || !!gitUi.busyAction || !commitMessage.trim() || operation.inProgress || !!gitUi.pendingAction
          "
          @click="submitMobileCommit"
        >
          {{ commitButtonLabel }}
        </button>
      </template>
    </footer>

    <!-- File / directory context menu (right-click a changed entry) -->
    <Teleport to="body">
      <div
        v-if="fileMenu"
        ref="fileMenuRef"
        class="context-menu"
        :style="{ position: 'fixed', left: fileMenu.x + 'px', top: fileMenu.y + 'px', zIndex: 9999 }"
        @click.stop
      >
        <button
          type="button"
          class="context-menu__item"
          title="Append this path to the repository's .gitignore (anchored, so only this exact path is ignored). Files git already tracks keep showing until untracked."
          @click="onMenuIgnore"
        >
          <span class="context-menu__icon">&#x29B8;</span><span>Add to .gitignore</span>
        </button>
        <button type="button" class="context-menu__item context-menu__item--danger" @click="onMenuDelete">
          <span class="context-menu__icon">&#x2715;</span>
          <span>{{ deleteMenuLabel }}</span>
        </button>
      </div>
    </Teleport>

    <!-- Delete confirm -->
    <Teleport to="body">
      <div v-if="deleteDialog" class="fm-dialog-backdrop" @mousedown.self="deleteDialog = null">
        <div class="fm-dialog">
          <h3>{{ deleteDialogTitle }}</h3>
          <p v-if="deleteDialog.paths.length > 1" class="fm-dialog__text">
            Permanently delete <strong>{{ deleteDialog.paths.length }}</strong> selected files from disk? This cannot be
            undone.
          </p>
          <p v-else class="fm-dialog__text">
            Permanently delete <strong>{{ deleteDialog.name }}</strong>
            {{ deleteDialog.kind === "dir" ? "and everything inside it" : "" }} from disk? This cannot be undone.
          </p>
          <div class="fm-dialog__actions">
            <button type="button" class="button button--ghost" @click="deleteDialog = null">Cancel</button>
            <button type="button" class="button" style="background: var(--danger)" @click="confirmDelete">
              Delete
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";
import { useGitStashStore } from "../../../stores/git-stash.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { userFacingMessage } from "../../../lib/error-message.js";
import { useContextMenu } from "../../../composables/useContextMenu.js";
import GitDiffStat from "./GitDiffStat.vue";
import GitChangeTree from "./GitChangeTree.vue";
import { useIsNarrow } from "../../../composables/useIsNarrow.js";
import { useMonacoDiffLoader } from "../../../composables/useMonacoDiffLoader.js";
import { buildCommitSelection } from "./commit-selection.js";

const MonacoDiffPanel = defineAsyncComponent(() => import("../../shared/MonacoDiffPanel.vue"));

const props = withDefaults(
  defineProps<{
    workspaceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitUi: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    operation: Record<string, any>;
    activeRootPath?: string;
    isDetachedHead?: boolean;
    newView?: boolean;
  }>(),
  { activeRootPath: "", isDetachedHead: false, newView: false },
);

const appStore = useAppStore();
const gitUiStore = useGitUiStore();
const stashStore = useGitStashStore();
const notifications = useNotificationStore();
const { isNarrow } = useIsNarrow();
const changesRoot = ref<HTMLElement | null>(null);
const mobileMode = ref<"list" | "diff" | "commit" | "">("");
const mobileLayout = ref<"single" | "split">("single");
const activeFilter = ref("all");
const commitBusy = ref(false);
const commitMessageId = useId();
const stagedCommitMessage = computed({
  get: () => gitUiStore.getStagedCommitMessage(props.workspaceId, props.activeRootPath),
  set: (message: string) => gitUiStore.setStagedCommitMessage(props.workspaceId, props.activeRootPath, message),
});
const commitMessageInput = ref<HTMLTextAreaElement | null>(null);
const mobileExpandedDirectories = ref<Set<string>>(new Set());
let resizeObserver: ResizeObserver | null = null;
let mobileViewport = false;
const compactChanges = ref(false);
let changesWidth = 0;

const scopeFilters = [
  { id: "all", label: "All" },
  { id: "staged", label: "Staged" },
  { id: "unstaged", label: "Unstaged" },
  { id: "untracked", label: "New" },
] as const;

const scopeCounts = computed(() => ({
  staged: new Set(allChangedFiles.value.filter((file) => file.scope === "staged").map((file) => file.path)).size,
  unstaged: new Set(allChangedFiles.value.filter((file) => file.scope === "unstaged").map((file) => file.path)).size,
  untracked: new Set(allChangedFiles.value.filter((file) => file.scope === "untracked").map((file) => file.path)).size,
}));
const stagedFiles = computed(
  () => new Set(allChangedFiles.value.filter((file) => file.scope === "staged").map((file) => file.path)),
);
const diffLayerLabel = computed(() => {
  const scope = String(props.gitUi.selectedDiff?.scope || "unstaged");
  if (scope === "staged") return "HEAD → Index";
  if (scope === "untracked") return "Untracked file · not in Index";
  return "Index → Working tree";
});
const diffHunks = computed(() => {
  const diff = String((monacoDiffPayload.value as Record<string, unknown> | null)?.diff || "");
  return diff.split(/(?=^@@ )/m).filter((part) => part.startsWith("@@ "));
});
function onStageFile(payload: { path: string; staged: boolean; scope: string }) {
  if (payload.scope === "conflict") return;
  if (payload.staged) void gitUiStore.gitUnstageFile(props.workspaceId, payload.path);
  else void gitUiStore.gitStageFile(props.workspaceId, payload.path);
}
async function onStageHunk(hunk: string, index: number) {
  const selection = props.gitUi.selectedDiff;
  const preview = monacoDiffPayload.value as Record<string, unknown> | null;
  const token = String(preview?.diffToken || "");
  if (!selection?.path || !token || !hunk) return;
  const staged = selection.scope === "staged";
  const ok = await gitUiStore.gitStageHunk(props.workspaceId, {
    path: selection.path,
    action: staged ? "unstage" : "stage",
    scope: staged ? "staged" : "unstaged",
    diffToken: token,
    hunk: `${String(preview?.diffHeader || "")}${hunk}`,
  });
  if (!ok)
    notifications.showError(
      "Could not apply hunk",
      "The diff changed or the selected hunk could not be staged. Refresh the diff and try again.",
    );
  else {
    void diffLoader.load(selection.path, selection.scope);
    notifications.pushEphemeralToast({
      title: "Git",
      body: `Hunk ${index + 1} updated.`,
      kind: "info",
      durationMs: 2500,
    });
  }
}
async function onCommitStaged() {
  if (!stagedCommitMessage.value.trim()) return;
  if (await gitUiStore.gitCommitStaged(props.workspaceId, stagedCommitMessage.value))
    gitUiStore.setStagedCommitMessage(props.workspaceId, props.activeRootPath, "");
}

function updateMobileLayout() {
  if (typeof window === "undefined") return;
  mobileViewport = window.matchMedia("(max-width: 768px), (max-height: 500px)").matches;
  compactChanges.value = mobileViewport || changesWidth < 640 || mobileMode.value === "commit";
  mobileMode.value = compactChanges.value ? mobileMode.value || "list" : "";
  mobileLayout.value = compactChanges.value && changesWidth >= 640 ? "split" : "single";
}

onMounted(() => {
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver((entries) => {
      changesWidth = entries[0]?.contentRect.width || 0;
      updateMobileLayout();
    });
    if (changesRoot.value) resizeObserver.observe(changesRoot.value);
  }
  window.addEventListener("resize", updateMobileLayout);
  updateMobileLayout();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener("resize", updateMobileLayout);
});

const allChangedFiles = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const push = (f: any, scope: string) => {
    const key = `${scope}:${f.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      ...f,
      scope,
      stagedStatus: f.stagedStatus || (scope === "staged" ? f.code || "" : ""),
      unstagedStatus: f.unstagedStatus || (scope === "unstaged" ? f.code || "" : ""),
    });
  };
  for (const f of props.snapshot?.staged || []) push(f, "staged");
  for (const f of props.snapshot?.unstaged || []) push(f, "unstaged");
  for (const path of props.operation.conflicts || []) push({ path, code: "UU" }, "unstaged");
  // Working-tree conflicts with no operation in progress (e.g. stash pop/apply)
  // live only in changes.unstaged.files, not the raw unstaged array — surface
  // them so they render and can be clicked to open the Conflict Center.
  for (const f of props.snapshot?.changes?.unstaged?.files || []) {
    if (f?.kind === "conflict") push(f, "unstaged");
  }
  for (const f of props.snapshot?.untracked || []) push(f, "untracked");
  return out;
});

const conflictPaths = computed(() => {
  const set = new Set<string>(props.operation.conflicts || []);
  for (const f of props.snapshot?.changes?.unstaged?.files || []) {
    if (f?.kind === "conflict") set.add(f.path as string);
  }
  return set;
});

function onFileSelect(path: string, scope: string) {
  // Conflicted files open the Conflicts tab instead of the diff preview
  if (conflictPaths.value.has(path)) {
    gitUiStore.openConflictDialog(props.workspaceId, props.activeRootPath);
    gitUiStore.gitSwitchTab(props.workspaceId, "conflicts");
    return;
  }
  gitUiStore.gitSelectDiff(props.workspaceId, path, scope);
}

function diffSourceForScope(scope: string) {
  return scope === "staged" ? "staged" : "head";
}

// Working-tree file diff — shared seq-guarded loader (see
// useMonacoDiffLoader.ts), also used by GitBranchesTab.vue's commit diff.
const diffLoader = useMonacoDiffLoader(async (path: string, scope: string) => {
  const api = appStore.getApi() as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: getApi() returns untyped API object
  const payload = await api.gitDiffPreview({
    workspaceId: props.workspaceId,
    rootPath: props.activeRootPath,
    path,
    scope: scope === "staged" ? "staged" : scope === "untracked" ? "untracked" : "unstaged",
  });
  if (payload?.leftContent?.includes("\0") || payload?.rightContent?.includes("\0")) {
    return {
      ...payload,
      ok: false,
      leftContent: "",
      rightContent: "",
      leftError: "Binary file; text diff is unavailable.",
      rightError: "",
    };
  }
  const diff = String(payload?.diff || "");
  const hunks = diff.split(/(?=^@@ )/m).filter((part: string) => part.startsWith("@@ "));
  const language = path.split(".").pop() || "plaintext";
  const [leftContent = "", rightContent = ""] = hunks.length ? parsePatchHunk(hunks[0]) : ["", ""];
  return {
    ...payload,
    leftContent,
    rightContent,
    leftError: payload?.ok === false ? String(payload.summary || "Diff unavailable") : "",
    rightError: "",
    language,
    diff,
    hunks,
  };
}, "Failed to load diff");

function parsePatchHunk(hunk: string): [string, string] {
  const left: string[] = [];
  const right: string[] = [];
  for (const line of hunk.split("\n").slice(1)) {
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) right.push(line.slice(1));
    else if (line.startsWith("-")) left.push(line.slice(1));
    else if (line.startsWith(" ")) {
      left.push(line.slice(1));
      right.push(line.slice(1));
    }
  }
  return [left.join("\n"), right.join("\n")];
}
const monacoDiffPayload = diffLoader.payload;
const monacoDiffLoading = diffLoader.loading;

function loadMonacoDiff(path: string, scope: string) {
  if (!props.activeRootPath || !path) {
    monacoDiffPayload.value = null;
    return;
  }
  void diffLoader.load(path, scope);
}

// `immediate` so the diff loads when the tab mounts with a pre-selected
// file (e.g. user switched tabs and came back) — the parent's selectedDiff
// stays valid across tab switches but our local payload ref resets.
watch(
  () => props.gitUi.selectedDiff,
  (sel) => {
    if (!sel?.path) {
      monacoDiffPayload.value = null;
      return;
    }
    loadMonacoDiff(sel.path, sel.scope);
  },
  { deep: true, immediate: true },
);

watch(
  () => props.activeRootPath,
  (rootPath) => {
    const selection = props.gitUi.selectedDiff;
    if (selection?.path && rootPath) void diffLoader.load(selection.path, selection.scope);
    else monacoDiffPayload.value = null;
  },
);

const commitMessage = ref("");

watch(
  () => [props.workspaceId, props.activeRootPath],
  () => {
    selectedPaths.value = new Set();
    mobileExpandedDirectories.value = new Set();
    commitMessage.value = "";
    activeFilter.value = "all";
    mobileMode.value = compactChanges.value ? "list" : "";
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  },
);

// Commit button mirrors the stash row: label + tooltip switch to a
// selection-scoped commit whenever files are checked, otherwise commit all.
const commitButtonLabel = computed(() => {
  if (props.gitUi.busyAction === "commit") return "Committing…";
  return selectedPaths.value.size ? `Commit selected (${selectedPaths.value.size})` : "Commit all";
});
const commitButtonTitle = computed(() =>
  selectedPaths.value.size
    ? `Stage and commit only the ${selectedPaths.value.size} checked file(s) with the message above — everything else stays in your working tree.`
    : "Stage every modified, added, deleted, and untracked file in the working tree and create a commit with the message above. Equivalent to git add -A && git commit -m '…'.",
);

// The checked paths and, SEPARATELY, the old names of any checked renames
// (renames only — a copy's source must survive). See commit-selection.ts.
function commitSelection(): { paths: string[]; previousPaths: string[] } {
  return buildCommitSelection(allChangedFiles.value, selectedPaths.value);
}

function onCommitAll() {
  const msg = commitMessage.value.trim();
  if (!msg) return;
  const { paths, previousPaths } = commitSelection();
  gitUiStore.gitCommitAll(
    props.workspaceId,
    msg,
    paths.length ? paths : undefined,
    previousPaths.length ? previousPaths : undefined,
  );
  commitMessage.value = "";
}

function returnToList() {
  mobileMode.value = "list";
  updateMobileLayout();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function openMobileCommit() {
  if (!props.snapshot.dirty) return;
  mobileMode.value = "commit";
  void nextTick(() => commitMessageInput.value?.focus());
}

async function submitMobileCommit() {
  const message = commitMessage.value.trim();
  if (!message || commitBusy.value) return;
  const { paths, previousPaths } = commitSelection();
  const workspaceId = props.workspaceId;
  const rootPath = props.activeRootPath;
  commitBusy.value = true;
  try {
    await gitUiStore.gitCommitAll(
      props.workspaceId,
      message,
      paths.length ? paths : undefined,
      previousPaths.length ? previousPaths : undefined,
    );
    if (workspaceId !== props.workspaceId || rootPath !== props.activeRootPath || props.gitUi.lastResult?.ok === false)
      return;
    commitMessage.value = "";
    mobileMode.value = "list";
    updateMobileLayout();
  } finally {
    commitBusy.value = false;
  }
}

function moveDiff(direction: number) {
  const paths = [...new Set<string>(filteredFiles.value.map((file) => file.path))];
  if (!paths.length) return;
  const selected = props.gitUi.selectedDiff;
  const index = paths.indexOf(selected?.path);
  const current = index < 0 ? (direction > 0 ? -1 : 0) : index;
  const path = paths[(current + direction + paths.length) % paths.length];
  const next =
    filteredFiles.value.find((file) => file.path === path && file.scope === selected?.scope) ||
    filteredFiles.value.find((file) => file.path === path)!;
  onFileSelect(next.path, next.scope);
}

// --- Selective stash ---
const stashState = computed(() => stashStore.get(props.workspaceId));
const stashBusy = computed(() => stashState.value.busyAction === "create");
const includeUntracked = computed(() => stashState.value.includeUntrackedNext);
const stashMessage = ref("");
const selectedPaths = ref<Set<string>>(new Set());

// Distinct repo-relative paths (a file can appear twice — staged + unstaged —
// but a stash takes the whole path, so collapse to one entry per path).
const distinctPaths = computed(() => {
  const s = new Set<string>();
  for (const f of allChangedFiles.value) s.add(f.path as string);
  return s;
});

const filteredFiles = computed(() =>
  !compactChanges.value || activeFilter.value === "all"
    ? allChangedFiles.value
    : allChangedFiles.value.filter((file) => file.scope === activeFilter.value),
);

const renameSelection = computed(() => buildCommitSelection(allChangedFiles.value, selectedPaths.value));
const selectedPathPrefix = computed(() => {
  const path = String(props.gitUi.selectedDiff?.path || "");
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
});
const selectedPathBase = computed(
  () =>
    String(props.gitUi.selectedDiff?.path || "")
      .split("/")
      .pop() || "",
);

watch(
  () => props.gitUi.selectedDiff,
  (selection) => {
    if (compactChanges.value && selection?.path && mobileMode.value !== "commit") {
      mobileMode.value = "diff";
    }
  },
);

const allSelected = computed(
  () => distinctPaths.value.size > 0 && [...distinctPaths.value].every((p) => selectedPaths.value.has(p)),
);

// Drop selections for files that vanished (e.g. after a stash/commit refresh).
watch(distinctPaths, (paths) => {
  if (!selectedPaths.value.size) return;
  const next = new Set<string>();
  for (const p of selectedPaths.value) if (paths.has(p)) next.add(p);
  if (next.size !== selectedPaths.value.size) selectedPaths.value = next;
});

function toggleSelect(path: string) {
  const next = new Set(selectedPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  selectedPaths.value = next;
}

function toggleSelectAll() {
  selectedPaths.value = allSelected.value ? new Set() : new Set(distinctPaths.value);
}

function onToggleUntracked(e: Event) {
  stashStore.setIncludeUntrackedNext(props.workspaceId, (e.target as HTMLInputElement).checked);
}

// Inline prompt shown when a stash is blocked by an unborn HEAD (no commits
// yet). Holds a thunk that retries the original stash — selected vs all —
// after the user accepts creating an empty initial commit.
const initialCommitPrompt = ref<null | (() => Promise<void>)>(null);

function clearInitialCommitPrompt() {
  initialCommitPrompt.value = null;
}

async function confirmCreateInitialCommit() {
  const retry = initialCommitPrompt.value;
  initialCommitPrompt.value = null;
  if (retry) await retry();
}

async function runSelectedStash(allowEmptyInitialCommit: boolean) {
  // A path-scoped stash of an untracked file requires --include-untracked, or
  // git hard-fails: "pathspec '…' did not match any file(s) known to git".
  // Checking a file in the tree is the explicit intent to stash it, so force
  // the flag whenever the selection contains an untracked file — regardless of
  // the global toggle. (-u is a no-op for tracked paths in a pathspec and never
  // sweeps untracked files outside it, so this can't over-stash.)
  const untrackedPaths = new Set(
    allChangedFiles.value.filter((f) => f.scope === "untracked").map((f) => f.path as string),
  );
  const selectionHasUntracked = [...selectedPaths.value].some((p) => untrackedPaths.has(p));
  const { ok, needsInitialCommit } = await stashStore.createStash(props.workspaceId, {
    message: stashMessage.value.trim(),
    includeUntracked: includeUntracked.value || selectionHasUntracked,
    paths: [...selectedPaths.value],
    allowEmptyInitialCommit,
  });
  if (needsInitialCommit) {
    initialCommitPrompt.value = () => runSelectedStash(true);
    return;
  }
  if (ok) {
    stashMessage.value = "";
    selectedPaths.value = new Set();
  }
}

async function runAllStash(allowEmptyInitialCommit: boolean) {
  const { ok, needsInitialCommit } = await stashStore.createStash(props.workspaceId, {
    message: stashMessage.value.trim(),
    includeUntracked: includeUntracked.value,
    allowEmptyInitialCommit,
  });
  if (needsInitialCommit) {
    initialCommitPrompt.value = () => runAllStash(true);
    return;
  }
  if (ok) {
    stashMessage.value = "";
    selectedPaths.value = new Set();
  }
}

async function onStashSelected() {
  if (!selectedPaths.value.size || stashBusy.value) return;
  await runSelectedStash(false);
}

async function onStashAll() {
  if (stashBusy.value) return;
  await runAllStash(false);
}

// --- Right-click actions (delete / add to .gitignore) ---
// `batch` holds the checked-file selection when the right-clicked entry is one
// of several selected files — the delete action then targets the whole set.
const fileMenu = ref<{
  x: number;
  y: number;
  path: string;
  name: string;
  kind: "file" | "dir";
  batch: string[] | null;
} | null>(null);
const fileMenuRef = ref<HTMLElement | null>(null);
const deleteDialog = ref<{ paths: string[]; name: string; kind: "file" | "dir" } | null>(null);

const deleteMenuLabel = computed(() => {
  const m = fileMenu.value;
  if (!m) return "Delete";
  if (m.batch && m.batch.length > 1) return `Delete ${m.batch.length} selected files`;
  return m.kind === "dir" ? "Delete folder" : "Delete file";
});

const deleteDialogTitle = computed(() => {
  const d = deleteDialog.value;
  if (!d) return "";
  if (d.paths.length > 1) return "Delete selected files?";
  return d.kind === "dir" ? "Delete folder?" : "Delete file?";
});

function onFileContextMenu(payload: { path: string; name: string; kind: "file" | "dir"; x: number; y: number }) {
  // Right-clicking a checked file inside a multi-selection makes the menu act
  // on every checked file; right-clicking elsewhere acts on the single target.
  const inSelection = payload.kind === "file" && selectedPaths.value.has(payload.path);
  const batch = inSelection && selectedPaths.value.size > 1 ? [...selectedPaths.value] : null;
  fileMenu.value = { ...payload, batch };
}

function onMenuDelete() {
  const target = fileMenu.value;
  fileMenu.value = null;
  if (!target) return;
  if (target.batch && target.batch.length > 1) {
    deleteDialog.value = { paths: target.batch, name: target.name, kind: "file" };
  } else {
    deleteDialog.value = { paths: [target.path], name: target.name, kind: target.kind };
  }
}

async function confirmDelete() {
  const target = deleteDialog.value;
  deleteDialog.value = null;
  if (!target || !props.activeRootPath || !target.paths.length) return;
  const api = appStore.getApi() as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: getApi() returns untyped API object
  // Catch per-item so one locked/permission-denied file doesn't abort the rest
  // of the batch — mirrors DockerImagesTable.vue's askBulkRemove.
  const deleted = new Set<string>();
  let failed = 0;
  for (const relativePath of target.paths) {
    try {
      await api.fileDelete({ rootPath: props.activeRootPath, relativePath });
      deleted.add(relativePath);
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    notifications.showError("Some files could not be deleted", `${failed} of ${target.paths.length} failed.`, {
      workspaceId: props.workspaceId,
    });
  }
  // Drop the diff preview if the deleted file (or, for a folder, anything
  // inside it) was the one being viewed.
  const selected = props.gitUi.selectedDiff?.path as string | undefined;
  const hitSelected =
    !!selected &&
    (deleted.has(selected) || (target.kind === "dir" && [...deleted].some((p) => selected.startsWith(p + "/"))));
  if (hitSelected) gitUiStore.gitClearSelectedDiff(props.workspaceId);
  selectedPaths.value = new Set(
    [...selectedPaths.value].filter(
      (p) => !deleted.has(p) && !(target.kind === "dir" && [...deleted].some((d) => p.startsWith(d + "/"))),
    ),
  );
  await gitUiStore.refreshGit(props.workspaceId);
}

async function onMenuIgnore() {
  const target = fileMenu.value;
  fileMenu.value = null;
  if (!target || !props.activeRootPath) return;
  const api = appStore.getApi() as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: getApi() returns untyped API object
  try {
    await api.fileGitIgnore({
      rootPath: props.activeRootPath,
      relativePath: target.path,
      isDirectory: target.kind === "dir",
    });
  } catch (e) {
    notifications.showError("Failed to update .gitignore", `${target.name}: ${userFacingMessage(e, "Unknown error")}`, {
      workspaceId: props.workspaceId,
    });
    return;
  }
  // Newly ignored untracked entries vanish from the status; the modified
  // .gitignore itself shows up instead.
  await gitUiStore.refreshGit(props.workspaceId);
}

useContextMenu({
  isOpen: () => !!fileMenu.value,
  menuRef: fileMenuRef,
  onClose: () => {
    fileMenu.value = null;
  },
});
</script>

<style scoped>
.git-section--changes {
  display: flex;
  flex-direction: column;
  grid-template-columns: none;
  grid-template-rows: none;
  align-content: stretch;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.git-changes__body {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.git-changes--mobile {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  gap: 0;
  padding-bottom: 0;
}

.git-changes__mobile-head,
.git-changes__mobile-dock,
.git-changes__filters {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.git-changes__mobile-branch {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.git-changes__mobile-path {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.git-changes__mobile-path-prefix {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
}

.git-changes__mobile-path strong {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-changes__filters button {
  min-height: 34px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 16px;
  background: transparent;
  color: var(--muted);
  white-space: nowrap;
}

.git-changes__filters button.active {
  border-color: var(--accent);
  color: var(--accent);
}

.git-changes__filters span {
  margin-left: 5px;
  opacity: 0.75;
}

.git-changes--mobile .git-changes__body {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.git-changes__layout {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.git-changes__mobile-panes {
  display: none;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.git-changes--mobile .git-changes__mobile-panes {
  display: flex;
}

.git-changes__mobile-list,
.git-changes__mobile-diff {
  display: none;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.git-changes__mobile-list.is-visible,
.git-changes__mobile-diff.is-visible {
  display: flex;
  flex-direction: column;
}

.git-changes__mobile-list > :deep(.gct) {
  flex: 1;
  min-height: 0;
  height: auto;
  overflow: auto;
}

.git-changes__mobile-list {
  overflow: hidden;
}

.git-changes__mobile-diff > :deep(.mdp) {
  flex: 1;
  min-height: 0;
}

.git-changes--mobile[data-layout="single"] .git-changes__mobile-list.is-visible,
.git-changes--mobile[data-layout="single"] .git-changes__mobile-diff.is-visible {
  width: 100%;
}

.git-changes--mobile[data-layout="split"] .git-changes__mobile-list.is-visible {
  flex: 0 0 36%;
  border-right: 1px solid var(--border);
}

.git-changes--mobile[data-layout="split"] .git-changes__mobile-diff.is-visible {
  flex: 1;
}

.git-changes--mobile[data-mode="commit"] .git-changes__mobile-panes {
  display: none;
}

.git-changes__mobile-diff,
.git-changes__commit-screen {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.git-changes__commit-screen {
  height: 100%;
  box-sizing: border-box;
  padding: 8px;
}

.git-changes__commit-screen {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.git-changes__commit-screen textarea {
  flex: 1 1 110px;
  width: 100%;
  min-height: 64px;
  box-sizing: border-box;
  resize: vertical;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-elevated);
  color: var(--text);
  font: inherit;
  font-size: 16px;
}

.git-changes__mobile-dock {
  justify-content: space-between;
  padding-bottom: max(8px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--border);
  border-bottom: 0;
}

.git-changes__mobile-actions {
  flex: 0 0 auto;
  border-top: 1px solid var(--border);
  padding: 4px 8px;
  max-height: 70%;
  overflow: auto;
}

.git-changes__mobile-actions summary {
  min-height: 28px;
  color: var(--muted);
  font-size: 11px;
}

.git-changes__mobile-actions .git-stash-form {
  padding: 6px 0;
}

.git-changes__detached-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 8px;
  padding: 6px;
  font-size: 11px;
}

.git-changes__detached-banner span {
  flex: 1;
}

.git-changes--mobile[data-mode="commit"] .git-changes__mobile-dock {
  padding-bottom: max(8px, env(safe-area-inset-bottom), var(--strideterm-keyboard-bottom, 0px));
}

@media (max-width: 639px) {
  .git-changes__filters {
    justify-content: space-between;
    padding: 4px;
  }

  .git-changes__filters button {
    padding: 3px 5px;
    font-size: 11px;
  }
}

@media (max-height: 500px) {
  .git-changes--mobile[data-layout="split"]:not([data-mode="commit"]) {
    display: grid;
    grid-template-columns: minmax(230px, 36%) minmax(0, 1fr);
    grid-template-rows: 34px minmax(0, 1fr) auto;
  }

  .git-changes--mobile[data-layout="split"]:not([data-mode="commit"]) .git-changes__mobile-head {
    grid-column: 2;
    grid-row: 1;
    min-width: 0;
    padding: 2px 6px;
    border: 0;
  }

  .git-changes--mobile[data-layout="split"] .git-changes__filters {
    grid-column: 1;
    grid-row: 1;
    align-self: start;
    min-width: 0;
    overflow-x: auto;
    padding: 0 4px;
    border: 0;
  }

  .git-changes--mobile[data-layout="split"] .git-changes__filters button {
    flex: 0 0 auto;
    min-height: 28px;
    padding: 2px 5px;
    font-size: 10px;
  }

  .git-changes--mobile[data-layout="split"] .git-changes__body {
    display: contents;
  }

  .git-changes--mobile[data-layout="split"]:not([data-mode="commit"]) .git-changes__layout {
    display: contents;
  }

  .git-changes--mobile[data-layout="split"] .git-changes__mobile-panes {
    display: contents;
  }

  .git-changes--mobile[data-layout="split"] .git-changes__mobile-list {
    grid-column: 1;
    grid-row: 2;
    margin-top: 0;
    border-right: 1px solid var(--border);
  }

  .git-changes--mobile[data-layout="split"] .git-changes__mobile-diff {
    grid-column: 2;
    grid-row: 2;
    min-height: 0;
  }

  .git-changes--mobile[data-layout="split"] .git-changes__mobile-dock {
    grid-column: 1 / -1;
    grid-row: 3;
    min-height: 32px;
    padding: 2px 6px;
  }

  .git-changes--mobile[data-layout="split"] .git-changes__mobile-dock .button,
  .git-changes--mobile[data-layout="split"] .git-changes__mobile-head .button {
    min-height: 28px;
    padding: 2px 6px;
  }

  .git-changes__mobile-actions {
    padding: 0 6px;
  }

  .git-changes__mobile-actions summary {
    min-height: 24px;
  }

  .git-changes--mobile[data-layout="split"][data-mode="commit"] .git-changes__body {
    display: flex;
  }

  .git-changes--mobile[data-layout="split"][data-mode="commit"] .git-changes__mobile-panes {
    display: none;
  }
}

/* Splitpanes default-theme has higher specificity (.default-theme.splitpanes
   .splitpanes__pane = 3 classes) than our override, and its bg #f2f2f2 leaks
   through unless we use !important. */
:deep(.git-changes__splitpanes.splitpanes) {
  background: transparent !important;
}

:deep(.git-changes__splitpanes.splitpanes > .splitpanes__pane) {
  background: transparent !important;
  overflow: hidden;
}

:deep(.git-changes__splitpanes.splitpanes > .splitpanes__splitter) {
  background: var(--border) !important;
  min-width: 3px;
  min-height: 3px;
}

:deep(.git-changes__splitpanes.splitpanes > .splitpanes__splitter:hover) {
  background: var(--accent) !important;
}

.git-section__files--split {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding-right: 6px;
}

@media (max-width: 768px), (max-height: 500px) {
  .git-section__files--split {
    padding-right: 0;
    padding-bottom: 6px;
  }
}

/* Monaco diff host needs explicit flex sizing so the editor gets a real
   height instead of collapsing inside the auto-overflow column. */
.git-section__preview--diff {
  display: flex !important;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  height: 100%;
}

.git-card--diff {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.git-monaco-host {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}

.git-monaco-host > .git-card__hint {
  margin: auto;
  color: var(--muted);
}

.git-stash-form {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.git-stash-form__message {
  flex: 1 1 160px;
  min-width: 120px;
}

.git-stash-form__untracked {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

.git-stash-form__untracked input {
  width: auto;
  margin: 0;
}

.git-stash-form__buttons {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

/* Delete-confirm dialog — Teleported to body, but Vue keeps this component's
   scoped attribute on the teleported nodes, so these rules still apply. */
.fm-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9998;
}

.fm-dialog {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  min-width: 320px;
  box-shadow: var(--shadow);
}

.fm-dialog h3 {
  margin: 0 0 12px;
  font-size: 14px;
}

.fm-dialog__text {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--muted);
}

.fm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>
