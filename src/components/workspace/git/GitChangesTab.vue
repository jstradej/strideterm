<template>
  <div class="git-section git-section--changes">
    <div class="git-changes__body">
      <Splitpanes class="default-theme git-changes__splitpanes">
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
                @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)"
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
                  title="Stage all changes and commit"
                  @click="onCommitAll"
                >
                  {{ gitUi.busyAction === "commit" ? "Committing…" : "Commit all" }}
                </button>
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
import GitDiffStat from "./GitDiffStat.vue";
import GitChangeTree from "./GitChangeTree.vue";

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = await api.fileGitDiff({
      rootPath: props.activeRootPath,
      relativePath: path,
      source: diffSourceForScope(scope),
      revisionRef: "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
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
</style>
