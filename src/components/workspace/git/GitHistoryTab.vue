<template>
  <div class="git-section git-section--history">
    <div class="git-history__header git-history__header--compact">
      <GitBaseBranchPicker
        class="git-history__picker"
        label="Compare with base"
        :model-value="effectiveBaseBranch"
        :options="baseBranchOptions"
        @update:model-value="(v) => gitUiStore.gitSetBaseBranch(workspaceId, v)"
      />
      <template v-if="effectiveBaseBranch">
        <GitDiffStat :stat="compare.diffStat" />
        <span class="git-history__counter"
          ><strong>{{ compare.aheadCount || 0 }}</strong> ahead</span
        >
        <span class="git-history__counter"
          ><strong>{{ compare.behindCount || 0 }}</strong> behind</span
        >
      </template>
    </div>
    <div class="git-history__split">
      <Splitpanes :horizontal="isNarrow" class="default-theme git-history__splitpanes">
        <Pane :size="35" :min-size="20">
          <div class="git-history__log">
            <GitCommitLog
              :commits="allCommits"
              :selected-commit="gitUi.selectedCommit"
              :ahead-count="snapshot.aheadCount || 0"
              :has-more="hasMore"
              :loading-more="loadingMore"
              :page-size="pageSize"
              @select="(hash) => gitUiStore.gitSelectCommit(workspaceId, hash)"
              @load-more="loadMore"
              @show-info="onShowCommitInfo"
            />
          </div>
        </Pane>
        <Pane :size="65" :min-size="30">
          <Splitpanes horizontal class="default-theme git-history__splitpanes">
            <Pane :size="40" :min-size="15">
              <div class="git-history__commit-files">
                <div v-if="!gitUi.selectedCommit" class="git-history__placeholder">
                  Select a commit to see its files.
                </div>
                <div v-else-if="commitFilesLoading" class="git-history__placeholder">Loading…</div>
                <GitChangeTree
                  v-else
                  :files="commitFiles"
                  :selected-path="selectedCommitFile"
                  selected-scope="commit"
                  @select="onSelectCommitFile"
                />
              </div>
            </Pane>
            <Pane :size="60" :min-size="20">
              <div class="git-history__commit-diff">
                <MonacoDiffPanel v-if="selectedCommitFile" :payload="commitDiffPayload" :loading="commitDiffLoading" />
                <div v-else class="git-history__placeholder">
                  {{ gitUi.selectedCommit ? "Pick a file to view its diff." : "" }}
                </div>
              </div>
            </Pane>
          </Splitpanes>
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
import GitCommitLog from "./GitCommitLog.vue";
import GitBaseBranchPicker from "./GitBaseBranchPicker.vue";
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
    compare?: Record<string, any>;
    effectiveBaseBranch?: string;
    baseBranchOptions?: string[];
    activeRootPath?: string;
  }>(),
  { compare: () => ({}), effectiveBaseBranch: "", baseBranchOptions: () => [], activeRootPath: "" },
);

const appStore = useAppStore();
const gitUiStore = useGitUiStore();
const { isNarrow } = useIsNarrow();

const pageSize = 100;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extraCommits = ref<any[]>([]);
const hasMore = ref(true);
const loadingMore = ref(false);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const allCommits = computed<any[]>(() => {
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merged: any[] = [...(props.compare.commits || []), ...(props.snapshot?.log || []), ...extraCommits.value];
  for (const entry of merged) {
    if (!entry.shortHash || seen.has(entry.shortHash)) continue;
    seen.add(entry.shortHash);
    result.push(entry);
  }
  return result;
});

// Reset pagination when workspace or base branch changes — the cached extra
// commits are tied to the current range.
watch(
  () => [props.workspaceId, props.effectiveBaseBranch, props.activeRootPath],
  () => {
    extraCommits.value = [];
    hasMore.value = true;
    loadingMore.value = false;
  },
);

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    if (!api?.gitLogPage) {
      hasMore.value = false;
      return;
    }
    const skip = allCommits.value.length;
    const result = await api.gitLogPage({
      workspaceId: props.workspaceId,
      rootPath: props.activeRootPath,
      baseBranch: props.effectiveBaseBranch || "",
      skip,
      limit: pageSize,
    });
    if (!result || result.ok === false) {
      hasMore.value = false;
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const incoming: any[] = Array.isArray(result.commits) ? result.commits : [];
    if (!incoming.length) {
      hasMore.value = false;
    } else {
      extraCommits.value = [...extraCommits.value, ...incoming];
      hasMore.value = !!result.hasMore;
    }
  } catch {
    hasMore.value = false;
  } finally {
    loadingMore.value = false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const commitFiles = ref<any[]>([]);
const commitFilesLoading = ref(false);
const selectedCommitFile = ref("");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const commitDiffPayload = ref<Record<string, any> | null>(null);
const commitDiffLoading = ref(false);
let commitFilesSeq = 0;
let commitDiffSeq = 0;

async function loadCommitFiles(hash: string) {
  if (!hash) {
    commitFiles.value = [];
    return;
  }
  if (!props.activeRootPath) return;
  const seq = ++commitFilesSeq;
  commitFilesLoading.value = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await api.fileCommitFiles({ rootPath: props.activeRootPath, hash })) as any;
    if (seq !== commitFilesSeq) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commitFiles.value = (result?.files || []).map((f: any) => ({ ...f, scope: "commit" }));
  } catch {
    if (seq !== commitFilesSeq) return;
    commitFiles.value = [];
  } finally {
    if (seq === commitFilesSeq) commitFilesLoading.value = false;
  }
}

async function loadCommitFileDiff(hash: string, relativePath: string) {
  if (!hash || !relativePath) {
    commitDiffPayload.value = null;
    return;
  }
  if (!props.activeRootPath) return;
  const seq = ++commitDiffSeq;
  commitDiffLoading.value = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (await api.fileCommitDiff({ rootPath: props.activeRootPath, relativePath, hash })) as any;
    if (seq !== commitDiffSeq) return;
    commitDiffPayload.value = payload;
  } catch (err) {
    if (seq !== commitDiffSeq) return;
    commitDiffPayload.value = {
      ok: false,
      leftError: (err as Error)?.message || "Failed to load commit diff",
      leftContent: "",
      rightContent: "",
      leftLabel: "",
      rightLabel: "",
      leftMissing: true,
      rightMissing: true,
      language: "plaintext",
    };
  } finally {
    if (seq === commitDiffSeq) commitDiffLoading.value = false;
  }
}

// `immediate` so files load when the tab mounts with a pre-selected
// commit. Without it the commit list stays empty until the user re-clicks.
watch(
  () => props.gitUi.selectedCommit,
  (hash: string) => {
    selectedCommitFile.value = "";
    commitDiffPayload.value = null;
    if (hash) loadCommitFiles(hash);
    else commitFiles.value = [];
  },
  { immediate: true },
);

function onSelectCommitFile(path: string /* scope */) {
  selectedCommitFile.value = path;
  loadCommitFileDiff(props.gitUi.selectedCommit, path);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onShowCommitInfo(entry: any) {
  // Use the row data we already have as the seed so the dialog renders
  // immediately, and let it fetch the full body / hash / authorship
  // metadata in the background.
  appStore.openDialog("GitCommitInfoDialog", {
    workspaceId: props.workspaceId,
    rootPath: props.activeRootPath || "",
    hash: entry?.shortHash || entry?.hash || "",
    seed: {
      shortHash: entry?.shortHash || "",
      hash: entry?.hash || entry?.shortHash || "",
      subject: entry?.subject || "",
      author: entry?.author || "",
      relativeDate: entry?.relativeDate || "",
      refs: entry?.refs || "",
    },
    onClose: () => appStore.closeDialog(),
  });
}
</script>

<style scoped>
/* Compact horizontal header on top of the splitpanes. */
.git-history__header--compact {
  display: flex !important;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
  flex: 0 0 auto;
}

.git-history__picker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.git-history__picker :deep(strong) {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
}

.git-history__picker :deep(.custom-select) {
  width: 220px;
}

@media (max-width: 768px), (max-height: 500px) {
  .git-history__picker {
    flex: 1 1 100%;
  }
  .git-history__picker :deep(.custom-select) {
    width: auto;
    flex: 1 1 140px;
    min-width: 0;
  }
  .git-history__header--compact {
    padding: 6px 8px;
    gap: 6px 10px;
  }
}

.git-history__counter {
  font-size: 12px;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.git-history__counter strong {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.git-history__split {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.git-history__log,
.git-history__commit-files,
.git-history__commit-diff {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
}

.git-history__log {
  overflow: auto;
}

.git-history__commit-files {
  overflow: hidden;
}

.git-history__commit-diff {
  position: relative;
}

.git-history__commit-diff > * {
  flex: 1;
  min-height: 0;
}

.git-history__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: 12px;
  font-style: italic;
}

/* Splitpanes default-theme paints panes light gray and the splitter white
   (specificity (0,3,0) — higher than ours), so override with !important to
   force our dark surface. */
:deep(.git-history__splitpanes.splitpanes) {
  background: transparent !important;
}

:deep(.git-history__splitpanes.splitpanes > .splitpanes__pane) {
  background: transparent !important;
  overflow: hidden;
}

:deep(.git-history__splitpanes.splitpanes > .splitpanes__splitter) {
  background: var(--border) !important;
  min-width: 3px;
  min-height: 3px;
}

:deep(.git-history__splitpanes.splitpanes > .splitpanes__splitter:hover) {
  background: var(--accent) !important;
}
</style>
