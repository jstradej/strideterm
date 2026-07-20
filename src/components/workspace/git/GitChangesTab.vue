<template>
  <div class="git-section git-section--changes">
    <div class="git-changes__body">
      <Splitpanes :horizontal="isNarrow" class="default-theme git-changes__splitpanes">
        <Pane :size="40" :min-size="20">
          <div class="git-section__files git-section__files--split">
            <article class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Changes</p>
                  <h3>{{ snapshot.dirty ? "Working tree overview" : "No local changes" }}</h3>
                </div>
              </div>
              <div v-if="isDetachedHead" class="git-info-banner git-info-banner--warn" style="margin-bottom: 8px">
                <strong>Detached HEAD</strong>
                <p>You are on a detached HEAD. Commits will be lost unless you create a branch.</p>
                <button
                  v-if="!isReviewWorkspace"
                  type="button"
                  class="button button--ghost button--small"
                  @click="gitUiStore.gitCreateBranch(workspaceId, `branch-from-detached`, '')"
                >
                  Create branch from HEAD
                </button>
              </div>
              <GitDiffStat :stat="snapshot.diffStat" />
              <GitChangeTree
                :files="allChangedFiles"
                :selected-path="gitUi.selectedDiff?.path || ''"
                :selected-scope="gitUi.selectedDiff?.scope || ''"
                :selectable="snapshot.dirty && !isReviewWorkspace"
                :selected-set="selectedPaths"
                @select="onFileSelect"
                @toggle-select="toggleSelect"
                @context-menu="onFileContextMenu"
              />
              <div v-if="snapshot.dirty && !isReviewWorkspace" class="git-commit-form" style="margin-top: 12px">
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
              <div v-if="snapshot.dirty && !isReviewWorkspace" class="git-stash-form" style="margin-top: 8px">
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
              <div v-if="initialCommitPrompt" class="git-info-banner git-info-banner--warn" style="margin-top: 8px">
                <strong>No commits yet</strong>
                <p>
                  Stash needs an initial commit to attach to. Create an empty initial commit now and stash on top of it?
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
              <div class="section-head">
                <div>
                  <p class="eyebrow">Diff Preview</p>
                  <h3>{{ gitUi.selectedDiff?.path || "Select a file" }}</h3>
                </div>
              </div>
              <div class="git-monaco-host">
                <MonacoDiffPanel
                  v-if="gitUi.selectedDiff?.path"
                  :payload="monacoDiffPayload"
                  :loading="monacoDiffLoading"
                />
                <p v-else class="git-card__hint">Click a file to load a diff preview.</p>
              </div>
            </article>
          </div>
        </Pane>
      </Splitpanes>
    </div>

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
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";
import { useGitStashStore } from "../../../stores/git-stash.js";
import { useNotificationStore } from "../../../stores/notifications.js";
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
    isReviewWorkspace?: boolean;
  }>(),
  { activeRootPath: "", isDetachedHead: false, isReviewWorkspace: false },
);

const appStore = useAppStore();
const gitUiStore = useGitUiStore();
const stashStore = useGitStashStore();
const notifications = useNotificationStore();
const { isNarrow } = useIsNarrow();

const allChangedFiles = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const push = (f: any, scope: string) => {
    const key = `${scope}:${f.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...f, scope });
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
const diffLoader = useMonacoDiffLoader((path: string, scope: string) => {
  const api = appStore.getApi() as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: getApi() returns untyped API object
  return api.fileGitDiff({
    rootPath: props.activeRootPath,
    relativePath: path,
    source: diffSourceForScope(scope),
    revisionRef: "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as Promise<any>;
}, "Failed to load diff");
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

const commitMessage = ref("");

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
  // Review workspaces are read-only — no destructive file ops.
  if (props.isReviewWorkspace) return;
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
    notifications.showError("Failed to update .gitignore", `${target.name}: ${(e as Error)?.message || String(e)}`, {
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
.git-changes__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
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
