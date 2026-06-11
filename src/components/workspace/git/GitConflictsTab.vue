<template>
  <div class="gct">
    <div class="gct__head">
      <p class="eyebrow">{{ headerEyebrow }}</p>
      <h3>{{ headerTitle }}</h3>
    </div>

    <!-- Loading -->
    <div v-if="dlg.loading && !dlg.conflicts.length" class="gct__loading">Loading conflicts…</div>

    <!-- Error -->
    <div v-else-if="dlg.error" class="gct__error">{{ dlg.error }}</div>

    <!-- Merge editor view (inline, fills the tab) -->
    <template v-else-if="mergeTarget">
      <!-- File-level context bar: where am I, how many files left -->
      <div class="gct__mergebar">
        <button
          type="button"
          class="button button--ghost button--small"
          title="Back to the conflict file list"
          @click="onMergeNav(null)"
        >
          ◀ Files
        </button>
        <span class="gct__mergebar-pos" :title="mergeTarget.path">
          <template v-if="mergeFileIdx >= 0"
            >File {{ mergeFileIdx + 1 }} of {{ mergeFiles.length }} unresolved</template
          >
          <template v-else>{{ mergeFiles.length }} unresolved</template>
          <template v-if="resolvedCount > 0"> · {{ resolvedCount }} resolved</template>
        </span>
        <div class="gct__mergebar-nav">
          <button
            type="button"
            class="button button--ghost button--small"
            :disabled="!prevMergeFile"
            :title="
              prevMergeFile ? `Open previous unresolved file: ${prevMergeFile.path}` : 'No previous unresolved file'
            "
            @click="prevMergeFile && onMergeNav(prevMergeFile)"
          >
            ◀ Prev file
          </button>
          <button
            type="button"
            class="button button--ghost button--small"
            :disabled="!nextMergeFile"
            :title="nextMergeFile ? `Open next unresolved file: ${nextMergeFile.path}` : 'No next unresolved file'"
            @click="nextMergeFile && onMergeNav(nextMergeFile)"
          >
            Next file ▶
          </button>
        </div>
      </div>

      <!-- Unsaved-edits guard when switching files from the bar -->
      <div v-if="confirmSwitch" class="gct__confirm">
        <p>Discard unsaved changes to the Result and switch files?</p>
        <div class="gct__confirm-actions">
          <button
            type="button"
            class="button button--ghost button--small"
            title="Stay on this file and keep the changes"
            @click="confirmSwitch = false"
          >
            Keep editing
          </button>
          <button
            type="button"
            class="button button--small danger"
            title="Throw away the edits to Result and open the other file"
            @click="onConfirmSwitch"
          >
            Discard
          </button>
        </div>
      </div>

      <MergeEditorPanel
        :key="mergeTarget.path"
        ref="mergePanel"
        :file-path="mergeTarget.path"
        :conflict-type="mergeTarget.conflictType"
        :workspace-id="workspaceId"
        :root-path="dlg.rootPath"
        :sides="operationSides"
        @apply="onMergeApply"
        @cancel="mergeTarget = null"
      />
    </template>

    <!-- Conflict list view -->
    <template v-else>
      <div class="gct__body">
        <table class="gct__table">
          <thead>
            <tr>
              <th class="gct__th gct__th--file">File</th>
              <th class="gct__th gct__th--type">Type</th>
              <th class="gct__th gct__th--status">Status</th>
              <th class="gct__th gct__th--actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in dlg.conflicts" :key="f.path" :class="['gct__row', { 'gct__row--resolved': f.resolved }]">
              <td class="gct__td gct__td--file" :title="f.path">{{ fileName(f.path) }}</td>
              <td class="gct__td gct__td--type">{{ conflictTypeLabel(f) }}</td>
              <td class="gct__td gct__td--status">
                <span :class="['gct__badge', f.resolved ? 'gct__badge--ok' : 'gct__badge--warn']">
                  {{ f.resolved ? "resolved" : "pending" }}
                </span>
              </td>
              <td class="gct__td gct__td--actions">
                <!-- Resolved row -->
                <template v-if="f.resolved">
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    :disabled="!!busyFile"
                    title="Undo the resolution — restore the conflict markers and mark this file as pending again"
                    @click="onUnresolve(f)"
                  >
                    Undo
                  </button>
                </template>

                <!-- delete/add conflicts — no merge editor -->
                <template v-else-if="f.conflictType === 'deleted-by-us'">
                  <button
                    type="button"
                    class="button button--small"
                    :disabled="!!busyFile"
                    :title="`Accept ${oursLabel}'s deletion`"
                    @click="onResolve(f, 'ours')"
                  >
                    Delete ({{ oursLabel }})
                  </button>
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    :disabled="!!busyFile"
                    :title="`Keep ${theirsLabel}'s modification`"
                    @click="onResolve(f, 'theirs')"
                  >
                    Keep ({{ theirsLabel }})
                  </button>
                </template>

                <template v-else-if="f.conflictType === 'deleted-by-them'">
                  <button
                    type="button"
                    class="button button--small"
                    :disabled="!!busyFile"
                    :title="`Keep ${oursLabel}'s modification`"
                    @click="onResolve(f, 'ours')"
                  >
                    Keep ({{ oursLabel }})
                  </button>
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    :disabled="!!busyFile"
                    :title="`Accept ${theirsLabel}'s deletion`"
                    @click="onResolve(f, 'delete')"
                  >
                    Delete ({{ theirsLabel }})
                  </button>
                </template>

                <!-- binary or no-base: ours/theirs only -->
                <template v-else-if="f.binary">
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    :disabled="!!busyFile"
                    :title="`Resolve with ${oursLabel}'s version of the file`"
                    @click="onResolve(f, 'ours')"
                  >
                    {{ oursLabel }}
                  </button>
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    :disabled="!!busyFile"
                    :title="`Resolve with ${theirsLabel}'s version of the file`"
                    @click="onResolve(f, 'theirs')"
                  >
                    {{ theirsLabel }}
                  </button>
                </template>

                <!-- both-modified / both-added: full editor available -->
                <template v-else>
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    :disabled="!!busyFile"
                    :title="`Resolve with ${oursLabel}'s version — discard ${theirsLabel}'s changes to this file`"
                    @click="onResolve(f, 'ours')"
                  >
                    {{ oursLabel }}
                  </button>
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    :disabled="!!busyFile"
                    :title="`Resolve with ${theirsLabel}'s version — discard ${oursLabel}'s changes to this file`"
                    @click="onResolve(f, 'theirs')"
                  >
                    {{ theirsLabel }}
                  </button>
                  <button
                    type="button"
                    class="button button--small"
                    :disabled="!!busyFile"
                    title="Open the three-way merge editor to combine both versions by hand"
                    @click="onOpenMergeEditor(f)"
                  >
                    Merge…
                  </button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Bulk actions -->
      <div v-if="pendingCount > 0" class="gct__bulk">
        <button
          type="button"
          class="button button--ghost button--small"
          :disabled="!!busyFile"
          :title="`Resolve every pending file with ${oursLabel}'s version in one go`"
          @click="onAcceptAll('ours')"
        >
          Accept all: {{ oursLabel }}
        </button>
        <button
          type="button"
          class="button button--ghost button--small"
          :disabled="!!busyFile"
          :title="`Resolve every pending file with ${theirsLabel}'s version in one go`"
          @click="onAcceptAll('theirs')"
        >
          Accept all: {{ theirsLabel }}
        </button>
      </div>

      <!-- Confirm prompts (skip / abort) -->
      <div v-if="confirmSkip" class="gct__confirm">
        <p>Skip this commit and continue rebasing?</p>
        <div class="gct__confirm-actions">
          <button
            type="button"
            class="button button--ghost button--small"
            title="Keep resolving — nothing is skipped"
            @click="confirmSkip = false"
          >
            Cancel
          </button>
          <button
            type="button"
            class="button button--small"
            title="Drop this commit's changes and move on to the next commit"
            @click="onConfirmSkip"
          >
            Skip commit
          </button>
        </div>
      </div>
      <div v-if="confirmAbort" class="gct__confirm">
        <p>Abort the operation? All resolved files will be rolled back.</p>
        <div class="gct__confirm-actions">
          <button
            type="button"
            class="button button--ghost button--small"
            title="Keep resolving — the operation stays in progress"
            @click="confirmAbort = false"
          >
            Cancel
          </button>
          <button
            type="button"
            class="button button--small danger"
            title="Roll back everything and return the repository to the state before the operation"
            @click="onConfirmAbort"
          >
            Abort
          </button>
        </div>
      </div>

      <!-- Footer -->
      <footer class="gct__footer">
        <div class="gct__footer-left">
          <button
            v-if="canSkip"
            type="button"
            class="button button--ghost button--small"
            title="Drop this commit entirely and continue the operation with the next one"
            :disabled="!!busyFile"
            @click="confirmSkip = true"
          >
            Skip commit
          </button>
          <button
            type="button"
            class="button button--ghost button--small danger"
            title="Cancel the whole operation and restore the repository to the state before it started"
            :disabled="!!busyFile"
            @click="confirmAbort = true"
          >
            Abort
          </button>
        </div>
        <div class="gct__footer-right">
          <span class="gct__pending-count">{{ pendingCount > 0 ? `${pendingCount} pending` : "All resolved" }}</span>
          <!-- Working-tree conflicts (e.g. stash pop) have no operation to
            continue — Close is the only way to dismiss the tab. -->
          <button
            v-if="!operationState?.inProgress"
            type="button"
            class="button button--ghost"
            title="Dismiss this tab — resolved files stay resolved in the working tree"
            :disabled="!!busyFile"
            @click="onClose"
          >
            Close
          </button>
          <button
            v-else
            type="button"
            class="button"
            :disabled="pendingCount > 0 || !!busyFile"
            :title="
              pendingCount > 0
                ? 'Resolve all conflicts before continuing'
                : 'Commit the resolutions and resume the operation with the next commit'
            "
            @click="onContinue"
          >
            {{ continueLabel }}
          </button>
        </div>
      </footer>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from "vue";
import { useGitUiStore } from "../../../stores/git-ui.js";
import { useAppStore } from "../../../stores/app.js";

const MergeEditorPanel = defineAsyncComponent(() => import("../../dialogs/MergeEditorPanel.vue"));

const props = defineProps<{
  workspaceId: string;
  rootPath: string;
}>();

const gitUiStore = useGitUiStore();
const appStore = useAppStore();

const dlg = computed(() => {
  const ui = gitUiStore.get(props.workspaceId);
  return (
    ui.conflictDialog || {
      open: false,
      workspaceId: props.workspaceId,
      rootPath: props.rootPath,
      conflicts: [],
      loading: false,
      error: "",
    }
  );
});

const snapshot = computed(
  () =>
    appStore.getGitSnapshot(props.workspaceId, dlg.value.rootPath || props.rootPath) as Record<string, unknown> | null,
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const operationState = computed(() => snapshot.value?.operationState as Record<string, any> | null);

const operationSides = computed(() => operationState.value?.sides as { ours: string; theirs: string } | null);
const oursLabel = computed(() => operationSides.value?.ours || "Ours");
const theirsLabel = computed(() => operationSides.value?.theirs || "Theirs");

const canSkip = computed(() => operationState.value?.canSkip === true);

const headerEyebrow = computed(() => {
  const kind = operationState.value?.kind || "";
  const progress = operationState.value?.progress as { current: number; total: number } | null;
  const progressStr = progress ? ` · commit ${progress.current}/${progress.total}` : "";
  return kind ? `Resolve conflicts — ${kind}${progressStr}` : "Resolve conflicts";
});

const headerTitle = computed(() => {
  const subject = operationState.value?.currentCommit?.subject as string | undefined;
  if (subject) return subject;
  if (operationState.value?.inProgress) return operationState.value?.label || "In progress";
  return "Working tree conflicts";
});

const continueLabel = computed(() => {
  const kind = operationState.value?.kind || "";
  return kind ? `Continue ${kind}` : "Continue";
});

const pendingCount = computed(() => dlg.value.conflicts.filter((c) => !c.resolved).length);
const resolvedCount = computed(() => dlg.value.conflicts.filter((c) => c.resolved).length);

// Per-file busy state (file path or empty string)
const busyFile = ref("");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mergeTarget = ref<Record<string, any> | null>(null);
const mergePanel = ref<{ isDirty: () => boolean } | null>(null);

// Files the merge editor can open: pending, text, with both sides present.
const mergeFiles = computed(() =>
  dlg.value.conflicts.filter(
    (f) => !f.resolved && !f.binary && f.conflictType !== "deleted-by-us" && f.conflictType !== "deleted-by-them",
  ),
);
const mergeFileIdx = computed(() => mergeFiles.value.findIndex((f) => f.path === mergeTarget.value?.path));
const prevMergeFile = computed(() => (mergeFileIdx.value > 0 ? mergeFiles.value[mergeFileIdx.value - 1] : null));
const nextMergeFile = computed(() =>
  mergeFileIdx.value >= 0 && mergeFileIdx.value < mergeFiles.value.length - 1
    ? mergeFiles.value[mergeFileIdx.value + 1]
    : null,
);

const confirmSwitch = ref(false);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pendingNavTarget = ref<Record<string, any> | null>(null);

const confirmSkip = ref(false);
const confirmAbort = ref(false);

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function conflictTypeLabel(f: Record<string, any>): string {
  const map: Record<string, string> = {
    "both-modified": "both modified",
    "both-added": "both added",
    "deleted-by-us": "deleted by ours",
    "deleted-by-them": "deleted by theirs",
  };
  const label = map[f.conflictType as string] || (f.conflictType as string) || "conflict";
  return f.binary ? `${label} (binary)` : label;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function onResolve(f: Record<string, any>, mode: "ours" | "theirs" | "delete") {
  busyFile.value = f.path as string;
  try {
    await gitUiStore.resolveConflictFile(props.workspaceId, f.path as string, mode);
  } finally {
    busyFile.value = "";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function onUnresolve(f: Record<string, any>) {
  busyFile.value = f.path as string;
  try {
    await gitUiStore.unresolveConflictFile(props.workspaceId, f.path as string);
  } finally {
    busyFile.value = "";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onOpenMergeEditor(f: Record<string, any>) {
  mergeTarget.value = f;
}

// Navigate from the merge-editor context bar — to another file or back to the
// list (target null). Unsaved Result edits get an explicit discard confirm.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onMergeNav(target: Record<string, any> | null) {
  if (mergePanel.value?.isDirty()) {
    pendingNavTarget.value = target;
    confirmSwitch.value = true;
    return;
  }
  mergeTarget.value = target;
}

function onConfirmSwitch() {
  confirmSwitch.value = false;
  mergeTarget.value = pendingNavTarget.value;
  pendingNavTarget.value = null;
}

async function onMergeApply() {
  mergeTarget.value = null;
  await gitUiStore.loadConflicts(props.workspaceId);
}

async function onAcceptAll(side: "ours" | "theirs") {
  for (const f of dlg.value.conflicts) {
    if (f.resolved) continue;
    // delete-type conflicts need special modes
    let mode: "ours" | "theirs" | "delete" = side;
    if (f.conflictType === "deleted-by-us" && side === "theirs") mode = "theirs";
    if (f.conflictType === "deleted-by-them" && side === "theirs") mode = "delete";
    busyFile.value = f.path;
    try {
      await gitUiStore.resolveConflictFile(props.workspaceId, f.path, mode);
    } finally {
      busyFile.value = "";
    }
  }
}

async function onContinue() {
  await gitUiStore.continueAfterConflicts(props.workspaceId);
}

function onClose() {
  gitUiStore.closeConflictDialog(props.workspaceId);
}

async function onConfirmSkip() {
  confirmSkip.value = false;
  await gitUiStore.skipConflictCommit(props.workspaceId);
}

async function onConfirmAbort() {
  confirmAbort.value = false;
  await gitUiStore.abortFromConflictDialog(props.workspaceId);
}

// Drop a stale switch-confirm whenever the merge target actually changes
// (apply, cancel, or a confirmed switch).
watch(mergeTarget, () => {
  confirmSwitch.value = false;
  pendingNavTarget.value = null;
});

onMounted(() => {
  // The tab can be reached directly (tab click) without going through an
  // action that initialized the conflict state — (re)open so the list loads.
  const ui = gitUiStore.get(props.workspaceId);
  if (!ui.conflictDialog?.open) {
    gitUiStore.openConflictDialog(props.workspaceId, props.rootPath);
  }
});

// Live reconcile: if the conflict set changes underneath us — e.g. a file is
// resolved outside the app (lazygit/CLI) while the tab is open — the existing
// git snapshot refresh updates operationState.conflicts. Re-load the conflict
// list when that count changes, so the tab reflects reality. Skipped while the
// merge editor is showing to avoid yanking it out from under the user.
watch(
  () => (operationState.value?.conflicts as unknown[] | undefined)?.length ?? 0,
  () => {
    if (!dlg.value.open || mergeTarget.value || dlg.value.loading) return;
    void gitUiStore.loadConflicts(props.workspaceId);
  },
);
</script>

<style scoped>
.gct {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.gct__head {
  padding: 14px 20px 10px;
  border-bottom: 1px solid var(--border);
}

.gct__head h3 {
  margin: 2px 0 0;
}

.gct__mergebar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--border);
}

.gct__mergebar-pos {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

.gct__mergebar-nav {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.gct__loading,
.gct__error {
  padding: 20px;
  color: var(--muted);
  font-size: 13px;
}

.gct__error {
  color: var(--danger, #e44);
}

.gct__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 20px;
}

.gct__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.gct__th {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
}

.gct__th--file {
  width: 35%;
}
.gct__th--type {
  width: 20%;
}
.gct__th--status {
  width: 12%;
}
.gct__th--actions {
  width: 33%;
}

.gct__row {
  transition: background 0.1s;
}

.gct__row:hover {
  background: var(--hover);
}

.gct__row--resolved {
  opacity: 0.65;
}

.gct__td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.gct__td--file {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gct__td--actions {
  white-space: nowrap;
}

.gct__td--actions .button {
  margin-right: 4px;
}

.gct__badge {
  display: inline-block;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  white-space: nowrap;
}

.gct__badge--warn {
  background: var(--warn-bg, rgba(255, 165, 0, 0.15));
  color: var(--warn, orange);
}

.gct__badge--ok {
  background: var(--ok-bg, rgba(0, 180, 80, 0.12));
  color: var(--ok, #0b6);
}

.gct__bulk {
  padding: 8px 20px;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 8px;
}

.gct__confirm {
  padding: 10px 20px;
  background: var(--warn-bg, rgba(255, 165, 0, 0.08));
  border-top: 1px solid var(--border);
  font-size: 13px;
}

.gct__confirm p {
  margin: 0 0 8px;
}

.gct__confirm-actions {
  display: flex;
  gap: 8px;
}

.gct__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: nowrap;
  gap: 8px;
  padding: 10px 20px;
  border-top: 1px solid var(--border);
}

.gct__footer-left {
  display: flex;
  gap: 8px;
}

.gct__footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gct__pending-count {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

.danger {
  color: var(--danger, #e44);
}
</style>
