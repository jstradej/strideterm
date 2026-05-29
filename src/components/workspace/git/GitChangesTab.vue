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
                @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)"
                @toggle-select="toggleSelect"
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
                  title="Stage every modified, added, deleted, and untracked file in the working tree and create a commit with the message above. Equivalent to git add -A && git commit -m '…'."
                  @click="onCommitAll"
                >
                  {{ gitUi.busyAction === "commit" ? "Committing…" : "Commit all" }}
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
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";
import { useGitStashStore } from "../../../stores/git-stash.js";
import GitDiffStat from "./GitDiffStat.vue";
import GitChangeTree from "./GitChangeTree.vue";
import { useIsNarrow } from "../../../composables/useIsNarrow.js";

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
  for (const f of props.snapshot?.untracked || []) push(f, "untracked");
  return out;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const monacoDiffPayload = ref<Record<string, any> | null>(null);
const monacoDiffLoading = ref(false);
let monacoDiffSeq = 0;

function diffSourceForScope(scope: string) {
  return scope === "staged" ? "staged" : "head";
}

async function loadMonacoDiff(path: string, scope: string) {
  if (!props.activeRootPath || !path) {
    monacoDiffPayload.value = null;
    return;
  }
  const seq = ++monacoDiffSeq;
  monacoDiffLoading.value = true;
  try {
    const api = appStore.getApi() as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: getApi() returns untyped API object
    const payload = (await api.fileGitDiff({
      rootPath: props.activeRootPath,
      relativePath: path,
      source: diffSourceForScope(scope),
      revisionRef: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    if (seq !== monacoDiffSeq) return;
    monacoDiffPayload.value = payload;
  } catch (err) {
    if (seq !== monacoDiffSeq) return;
    monacoDiffPayload.value = {
      ok: false,
      leftError: (err as Error)?.message || "Failed to load diff",
      leftContent: "",
      rightContent: "",
      leftLabel: "",
      rightLabel: "",
      leftMissing: true,
      rightMissing: true,
      language: "plaintext",
    };
  } finally {
    if (seq === monacoDiffSeq) monacoDiffLoading.value = false;
  }
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
function onCommitAll() {
  const msg = commitMessage.value.trim();
  if (!msg) return;
  gitUiStore.gitCommitAll(props.workspaceId, msg);
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
</style>
