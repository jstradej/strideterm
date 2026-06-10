<template>
  <div class="dialog gcd" style="width: min(820px, 100%); max-height: min(680px, 90vh)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ headerEyebrow }}</p>
        <h2>{{ headerTitle }}</h2>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="dlg.loading && !dlg.conflicts.length" class="gcd__loading">Loading conflicts…</div>

    <!-- Error -->
    <div v-else-if="dlg.error" class="gcd__error">{{ dlg.error }}</div>

    <!-- Merge editor view -->
    <MergeEditorPanel
      v-else-if="mergeTarget"
      :file-path="mergeTarget.path"
      :conflict-type="mergeTarget.conflictType"
      :workspace-id="workspaceId"
      :root-path="dlg.rootPath"
      :sides="operationSides"
      @apply="onMergeApply"
      @cancel="mergeTarget = null"
    />

    <!-- Conflict list view -->
    <template v-else>
      <div class="gcd__body">
        <table class="gcd__table">
          <thead>
            <tr>
              <th class="gcd__th gcd__th--file">File</th>
              <th class="gcd__th gcd__th--type">Type</th>
              <th class="gcd__th gcd__th--status">Status</th>
              <th class="gcd__th gcd__th--actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in dlg.conflicts" :key="f.path" :class="['gcd__row', { 'gcd__row--resolved': f.resolved }]">
              <td class="gcd__td gcd__td--file" :title="f.path">{{ fileName(f.path) }}</td>
              <td class="gcd__td gcd__td--type">{{ conflictTypeLabel(f) }}</td>
              <td class="gcd__td gcd__td--status">
                <span :class="['gcd__badge', f.resolved ? 'gcd__badge--ok' : 'gcd__badge--warn']">
                  {{ f.resolved ? "resolved" : "pending" }}
                </span>
              </td>
              <td class="gcd__td gcd__td--actions">
                <!-- Resolved row -->
                <template v-if="f.resolved">
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    :disabled="!!busyFile"
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
                    @click="onResolve(f, 'ours')"
                  >
                    {{ oursLabel }}
                  </button>
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    :disabled="!!busyFile"
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
                    @click="onResolve(f, 'ours')"
                  >
                    {{ oursLabel }}
                  </button>
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    :disabled="!!busyFile"
                    @click="onResolve(f, 'theirs')"
                  >
                    {{ theirsLabel }}
                  </button>
                  <button
                    type="button"
                    class="button button--small"
                    :disabled="!!busyFile"
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
      <div v-if="pendingCount > 0" class="gcd__bulk">
        <button
          type="button"
          class="button button--ghost button--small"
          :disabled="!!busyFile"
          @click="onAcceptAll('ours')"
        >
          Accept all: {{ oursLabel }}
        </button>
        <button
          type="button"
          class="button button--ghost button--small"
          :disabled="!!busyFile"
          @click="onAcceptAll('theirs')"
        >
          Accept all: {{ theirsLabel }}
        </button>
      </div>

      <!-- Confirm dialogs (skip / abort) -->
      <div v-if="confirmSkip" class="gcd__confirm">
        <p>Skip this commit and continue rebasing?</p>
        <div class="gcd__confirm-actions">
          <button type="button" class="button button--ghost button--small" @click="confirmSkip = false">Cancel</button>
          <button type="button" class="button button--small" @click="onConfirmSkip">Skip commit</button>
        </div>
      </div>
      <div v-if="confirmAbort" class="gcd__confirm">
        <p>Abort the operation? All resolved files will be rolled back.</p>
        <div class="gcd__confirm-actions">
          <button type="button" class="button button--ghost button--small" @click="confirmAbort = false">Cancel</button>
          <button type="button" class="button button--small danger" @click="onConfirmAbort">Abort</button>
        </div>
      </div>

      <!-- Footer -->
      <footer class="dialog__footer gcd__footer">
        <div class="gcd__footer-left">
          <button
            v-if="canSkip"
            type="button"
            class="button button--ghost button--small"
            :disabled="!!busyFile"
            @click="confirmSkip = true"
          >
            Skip commit
          </button>
          <button
            type="button"
            class="button button--ghost button--small danger"
            :disabled="!!busyFile"
            @click="confirmAbort = true"
          >
            Abort
          </button>
        </div>
        <div class="gcd__footer-right">
          <span class="gcd__pending-count">{{ pendingCount > 0 ? `${pendingCount} pending` : "All resolved" }}</span>
          <button type="button" class="button button--ghost" :disabled="!!busyFile" @click="emit('close')">
            Close
          </button>
          <button
            type="button"
            class="button"
            :disabled="pendingCount > 0 || !!busyFile || !operationState?.inProgress"
            :title="pendingCount > 0 ? 'Resolve all conflicts before continuing' : ''"
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
import { computed, defineAsyncComponent, onMounted, ref } from "vue";
import { useGitUiStore } from "../../stores/git-ui.js";
import { useAppStore } from "../../stores/app.js";

const MergeEditorPanel = defineAsyncComponent(() => import("./MergeEditorPanel.vue"));

const props = defineProps<{
  workspaceId: string;
  rootPath: string;
}>();

const emit = defineEmits<{ (e: "close"): void }>();

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snapshot = computed(
  () => appStore.getGitSnapshot(props.workspaceId, props.rootPath) as Record<string, any> | null,
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

// Per-file busy state (file path or empty string)
const busyFile = ref("");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mergeTarget = ref<Record<string, any> | null>(null);

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
  const ui = gitUiStore.get(props.workspaceId);
  if (!ui.conflictDialog?.open) emit("close");
}

async function onConfirmSkip() {
  confirmSkip.value = false;
  await gitUiStore.skipConflictCommit(props.workspaceId);
  const ui = gitUiStore.get(props.workspaceId);
  if (!ui.conflictDialog?.open) emit("close");
}

async function onConfirmAbort() {
  confirmAbort.value = false;
  await gitUiStore.abortFromConflictDialog(props.workspaceId);
  emit("close");
}

onMounted(() => {
  // Initialize if not already
  const ui = gitUiStore.get(props.workspaceId);
  if (!ui.conflictDialog) {
    gitUiStore.openConflictDialog(props.workspaceId, props.rootPath);
  }
});
</script>

<style scoped>
.gcd {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.gcd__loading,
.gcd__error {
  padding: 20px;
  color: var(--muted);
  font-size: 13px;
}

.gcd__error {
  color: var(--danger, #e44);
}

.gcd__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 20px;
}

.gcd__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.gcd__th {
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

.gcd__th--file {
  width: 35%;
}
.gcd__th--type {
  width: 20%;
}
.gcd__th--status {
  width: 12%;
}
.gcd__th--actions {
  width: 33%;
}

.gcd__row {
  transition: background 0.1s;
}

.gcd__row:hover {
  background: var(--hover);
}

.gcd__row--resolved {
  opacity: 0.65;
}

.gcd__td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.gcd__td--file {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gcd__td--actions {
  white-space: nowrap;
}

.gcd__td--actions .button {
  margin-right: 4px;
}

.gcd__badge {
  display: inline-block;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  white-space: nowrap;
}

.gcd__badge--warn {
  background: var(--warn-bg, rgba(255, 165, 0, 0.15));
  color: var(--warn, orange);
}

.gcd__badge--ok {
  background: var(--ok-bg, rgba(0, 180, 80, 0.12));
  color: var(--ok, #0b6);
}

.gcd__bulk {
  padding: 8px 20px;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 8px;
}

.gcd__confirm {
  padding: 10px 20px;
  background: var(--warn-bg, rgba(255, 165, 0, 0.08));
  border-top: 1px solid var(--border);
  font-size: 13px;
}

.gcd__confirm p {
  margin: 0 0 8px;
}

.gcd__confirm-actions {
  display: flex;
  gap: 8px;
}

.gcd__footer {
  justify-content: space-between;
  flex-wrap: nowrap;
  gap: 8px;
}

.gcd__footer-left {
  display: flex;
  gap: 8px;
}

.gcd__footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gcd__pending-count {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

.danger {
  color: var(--danger, #e44);
}
</style>
