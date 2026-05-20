<template>
  <div class="git-section git-section--graph">
    <div class="git-graph__header">
      <div class="git-graph__title">
        <strong>Commit graph</strong>
        <span v-if="loadedCount" class="git-graph__count">{{ loadedCount }} commits</span>
        <span v-if="graphError" class="git-graph__error">— {{ graphError }}</span>
      </div>
      <div class="git-graph__header-actions">
        <label class="git-graph__filter">
          <input v-model="includeRemotes" type="checkbox" />
          Include remotes
        </label>
        <label class="git-graph__filter">
          Limit
          <CustomSelect
            class="git-graph__limit-select"
            :model-value="limit"
            :options="limitOptions"
            @change="(v) => onLimitChange(Number(v))"
          />
        </label>
        <button
          type="button"
          class="button button--ghost button--small"
          :disabled="graphLoading"
          title="Re-read the commit topology from git log. Local read only — no fetch."
          @click="refresh"
        >
          {{ graphLoading ? "Loading…" : "Refresh" }}
        </button>
      </div>
    </div>

    <div class="git-graph__split">
      <Splitpanes :horizontal="isNarrow" class="default-theme git-graph__splitpanes">
        <Pane :size="55" :min-size="25">
          <GitTreeGraph
            :commits="commits"
            :head="head"
            :refs="refs"
            :selected-hash="selectedHash"
            :loading="graphLoading"
            :error="graphError"
            @select="onSelectCommit"
            @open="onOpenCommitDialog"
          />
        </Pane>
        <Pane :size="45" :min-size="25">
          <Splitpanes horizontal class="default-theme git-graph__splitpanes">
            <Pane :size="40" :min-size="15">
              <div class="git-graph__commit-files">
                <div v-if="!selectedHash" class="git-graph__placeholder">Select a commit to see its files.</div>
                <div v-else-if="commitFilesLoading" class="git-graph__placeholder">Loading…</div>
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
              <div class="git-graph__commit-diff">
                <MonacoDiffPanel v-if="selectedCommitFile" :payload="commitDiffPayload" :loading="commitDiffLoading" />
                <div v-else class="git-graph__placeholder">
                  {{ selectedHash ? "Pick a file to view its diff." : "" }}
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
import GitTreeGraph from "./GitTreeGraph.vue";
import GitChangeTree from "./GitChangeTree.vue";
import CustomSelect from "../../common/CustomSelect.vue";
import { useIsNarrow } from "../../../composables/useIsNarrow.js";

const MonacoDiffPanel = defineAsyncComponent(() => import("../../shared/MonacoDiffPanel.vue"));

const props = withDefaults(
  defineProps<{
    workspaceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitUi: Record<string, any>;
    activeRootPath?: string;
  }>(),
  { activeRootPath: "" },
);

const appStore = useAppStore();
const gitUiStore = useGitUiStore();
const { isNarrow } = useIsNarrow();

const includeRemotes = ref(true);
const limit = ref<number>(300);
const limitOptions = [
  { value: 100, label: "100" },
  { value: 300, label: "300" },
  { value: 500, label: "500" },
  { value: 1000, label: "1 000" },
  { value: 2000, label: "2 000" },
];

const graphLoading = computed(() => props.gitUi?.graphLoading === true);
const graphError = computed(() => String(props.gitUi?.graphError || ""));

interface GraphCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  relativeDate: string;
  isoDate: string;
  refs: string[];
}

const commits = computed<GraphCommit[]>(() => (props.gitUi?.graph?.commits as GraphCommit[]) || []);
const head = computed(() => String(props.gitUi?.graph?.head || ""));
const refs = computed<Record<string, string>>(() => (props.gitUi?.graph?.refs as Record<string, string>) || {});
const loadedCount = computed(() => commits.value.length);

const selectedHash = computed(() => String(props.gitUi?.selectedCommit || ""));

function refresh() {
  gitUiStore.gitLoadGraph(props.workspaceId, { limit: limit.value, includeRemotes: includeRemotes.value });
}

function onLimitChange(next: number) {
  limit.value = next;
  refresh();
}

watch([includeRemotes], refresh);

// Auto-load when entering the tab for the first time, and when the workspace
// or active root changes (cache key implicitly tracks both).
watch(
  () => [props.workspaceId, props.activeRootPath],
  () => {
    refresh();
  },
  { immediate: true },
);

// --- File / diff panes (shared with History tab) ---
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
  if (!hash || !props.activeRootPath) {
    commitFiles.value = [];
    return;
  }
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
  if (!hash || !relativePath || !props.activeRootPath) {
    commitDiffPayload.value = null;
    return;
  }
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

function onSelectCommit(hash: string) {
  if (!hash) return;
  gitUiStore.gitSelectCommit(props.workspaceId, hash);
}

function onSelectCommitFile(path: string) {
  selectedCommitFile.value = path;
  if (selectedHash.value) loadCommitFileDiff(selectedHash.value, path);
}

function onOpenCommitDialog(hash: string) {
  // Find the row data so the dialog opens with a meaningful seed.
  const entry = commits.value.find((c) => c.hash === hash);
  appStore.openDialog("GitCommitInfoDialog", {
    workspaceId: props.workspaceId,
    rootPath: props.activeRootPath || "",
    hash: entry?.shortHash || hash,
    seed: {
      shortHash: entry?.shortHash || "",
      hash: entry?.hash || hash,
      subject: entry?.subject || "",
      author: entry?.author || "",
      relativeDate: entry?.relativeDate || "",
      refs: (entry?.refs || []).join(", "),
    },
    onClose: () => appStore.closeDialog(),
  });
}

watch(
  () => selectedHash.value,
  (hash) => {
    selectedCommitFile.value = "";
    commitDiffPayload.value = null;
    if (hash) loadCommitFiles(hash);
    else commitFiles.value = [];
  },
  { immediate: true },
);
</script>

<style scoped>
.git-section--graph {
  display: flex !important;
  flex-direction: column;
  grid-template-columns: none !important;
  grid-template-rows: none !important;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.git-graph__header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
  flex: 0 0 auto;
}

.git-graph__title {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}

.git-graph__title strong {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--muted);
}

.git-graph__count {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.git-graph__error {
  font-size: 11px;
  color: #e07b8e;
}

.git-graph__header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.git-graph__filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
}

.git-graph__filter input {
  margin: 0;
}

.git-graph__limit-select {
  width: 90px;
}

.git-graph__split {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.git-graph__commit-files,
.git-graph__commit-diff {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
}

.git-graph__commit-diff {
  position: relative;
}

.git-graph__commit-diff > * {
  flex: 1;
  min-height: 0;
}

.git-graph__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: 12px;
  font-style: italic;
}

:deep(.git-graph__splitpanes.splitpanes) {
  background: transparent !important;
}

:deep(.git-graph__splitpanes.splitpanes > .splitpanes__pane) {
  background: transparent !important;
  overflow: hidden;
}

:deep(.git-graph__splitpanes.splitpanes > .splitpanes__splitter) {
  background: var(--border) !important;
  min-width: 3px;
  min-height: 3px;
}

:deep(.git-graph__splitpanes.splitpanes > .splitpanes__splitter:hover) {
  background: var(--accent) !important;
}
</style>
