<template>
  <div class="git-section git-section--stashes">
    <!-- Toolbar -->
    <div class="stash-toolbar">
      <button
        type="button"
        class="button button--small button--ghost"
        title="Stashes are created from the Changes tab, where you can pick exactly which files to stash."
        @click="gitUiStore.gitSwitchTab(workspaceId, 'changes')"
      >
        New stash in Changes…
      </button>
      <div class="stash-toolbar__right">
        <button
          type="button"
          class="button button--small button--ghost"
          title="Import a .patch or .diff file as a new stash entry."
          :disabled="!!busyAction"
          @click="onImport"
        >
          Import patch…
        </button>
        <button
          type="button"
          class="button button--small button--ghost"
          title="Reload the stash list from git."
          :disabled="state.loading"
          @click="onRefresh"
        >
          {{ state.loading ? "Refreshing…" : "Refresh" }}
        </button>
        <span class="stash-toolbar__count">{{ entries.length }} stash{{ entries.length === 1 ? "" : "es" }}</span>
      </div>
    </div>
    <div class="stash-toolbar stash-toolbar--filter">
      <input
        v-model="filter"
        type="text"
        name="stash-filter"
        class="stash-toolbar__filter"
        placeholder="Filter by message, branch, or file…"
      />
    </div>

    <!-- Empty state -->
    <div v-if="!entries.length && !state.loading" class="stash-empty">
      <h3>No stashes</h3>
      <p>
        A stash is a snapshot of your working tree saved for later. Make changes you want to set aside, then create a
        stash from the Changes tab — you can pick exactly which files go in.
      </p>
      <div class="stash-empty__actions">
        <button
          type="button"
          class="button button--small"
          title="Open the Changes tab to pick files and create your first stash."
          @click="gitUiStore.gitSwitchTab(workspaceId, 'changes')"
        >
          Go to Changes
        </button>
        <button
          type="button"
          class="button button--small button--ghost"
          title="Import a .patch or .diff file as a new stash entry."
          @click="onImport"
        >
          Import patch…
        </button>
      </div>
    </div>

    <!-- List + detail -->
    <div v-else class="stash-body">
      <Splitpanes :horizontal="isNarrow" class="default-theme stash-splitpanes">
        <Pane :size="40" :min-size="20">
          <div class="stash-list">
            <StashListItem
              v-for="entry in filteredEntries"
              :key="entry.ref"
              :entry="entry"
              :files="state.filesByRef[entry.ref] || []"
              :selected="entry.ref === state.selectedRef"
              :expanded="expanded.has(entry.ref)"
              :busy="state.busyRef === entry.ref ? state.busyAction : ''"
              :current-branch="snapshot.branch || ''"
              @select="onSelect(entry.ref)"
              @toggle="onToggle(entry.ref)"
              @apply="onApply(entry)"
              @pop="onPop(entry)"
              @drop="onDrop(entry)"
              @branch="onBranch(entry)"
              @export="onExport(entry)"
              @copy="onCopy(entry)"
            />
            <p v-if="!filteredEntries.length" class="stash-list__empty">No stashes match the filter.</p>
          </div>
        </Pane>
        <Pane :size="60" :min-size="25">
          <div class="stash-detail-host">
            <StashDetailPane
              :workspace-id="workspaceId"
              :entry="selectedEntry"
              :files="selectedEntry ? state.filesByRef[selectedEntry.ref] || [] : []"
              :selected-file="state.selectedFile"
              :busy="state.busyRef === state.selectedRef ? state.busyAction : ''"
              @select-file="onSelectFile"
              @apply="selectedEntry && onApply(selectedEntry)"
              @pop="selectedEntry && onPop(selectedEntry)"
              @drop="selectedEntry && onDrop(selectedEntry)"
              @export="selectedEntry && onExport(selectedEntry)"
              @copy="selectedEntry && onCopy(selectedEntry)"
            />
          </div>
        </Pane>
      </Splitpanes>
    </div>

    <!-- Hidden file input for remote/web patch import -->
    <input ref="fileInputRef" type="file" accept=".patch,.diff" style="display: none" @change="onFilePicked" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useAppStore } from "../../../stores/app.js";
import { useGitStashStore } from "../../../stores/git-stash.js";
import type { StashEntry } from "../../../stores/git-stash.js";
import { useGitUiStore } from "../../../stores/git-ui.js";
import { useIsNarrow } from "../../../composables/useIsNarrow.js";
import StashListItem from "./StashListItem.vue";
import StashDetailPane from "./StashDetailPane.vue";

const props = defineProps<{
  workspaceId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  snapshot: Record<string, any>;
  activeRootPath?: string;
}>();

const appStore = useAppStore();
const stashStore = useGitStashStore();
const gitUiStore = useGitUiStore();
const { isNarrow } = useIsNarrow();

const state = computed(() => stashStore.get(props.workspaceId));
const entries = computed(() => state.value.entries);
const busyAction = computed(() => state.value.busyAction);
const expanded = ref<Set<string>>(new Set());

const filter = computed({
  get: () => state.value.filter,
  set: (v: string) => stashStore.setFilter(props.workspaceId, v),
});

const filteredEntries = computed(() => {
  const q = state.value.filter.trim().toLowerCase();
  if (!q) return entries.value;
  return entries.value.filter((e) => {
    if ((e.customMessage || "").toLowerCase().includes(q)) return true;
    if ((e.message || "").toLowerCase().includes(q)) return true;
    if ((e.branch || "").toLowerCase().includes(q)) return true;
    // Prefer the hydrated file list when present; otherwise fall back to the
    // paths returned eagerly by listStashes so the filter matches file paths
    // even for entries that were never selected/expanded.
    const loaded = state.value.filesByRef[e.ref];
    const paths = loaded ? loaded.map((f) => f.path) : e.filePaths || [];
    return paths.some((p) => p.toLowerCase().includes(q));
  });
});

const selectedEntry = computed<StashEntry | null>(
  () => entries.value.find((e) => e.ref === state.value.selectedRef) || null,
);

onMounted(async () => {
  await stashStore.loadStashes(props.workspaceId);
  if (state.value.selectedRef) await stashStore.loadFiles(props.workspaceId, state.value.selectedRef);
});

watch(
  () => state.value.selectedRef,
  async (ref) => {
    if (ref && !state.value.filesByRef[ref]) await stashStore.loadFiles(props.workspaceId, ref);
  },
);

function onRefresh() {
  stashStore.loadStashes(props.workspaceId);
}

function onSelect(ref: string) {
  stashStore.setSelected(props.workspaceId, ref);
}

async function onToggle(ref: string) {
  const next = new Set(expanded.value);
  if (next.has(ref)) {
    next.delete(ref);
  } else {
    next.add(ref);
    if (!state.value.filesByRef[ref]) await stashStore.loadFiles(props.workspaceId, ref);
  }
  expanded.value = next;
}

function onSelectFile(path: string) {
  stashStore.setSelected(props.workspaceId, state.value.selectedRef, path);
}

const label = (e: StashEntry) => e.customMessage || (e.isWipDefault ? "WIP" : "(no message)");

async function onApply(entry: StashEntry) {
  // Always confirm — keeps Apply / Pop / Drop symmetrical and acts as a
  // forcing function ("did you mean Apply or Pop?").
  const ok = await appStore.confirmInApp({
    title: "Apply stash",
    message: `Apply ${entry.ref} "${label(entry)}"?\n\nChanges will be added to your working tree. The stash entry will be kept.`,
    confirmLabel: "Apply",
  });
  if (ok) await stashStore.apply(props.workspaceId, entry.ref);
}

async function onPop(entry: StashEntry) {
  if (props.snapshot.dirty) {
    const ok = await appStore.confirmInApp({
      title: "Pop into dirty tree",
      message: "Working tree has uncommitted changes. Pop may produce merge conflicts. Continue?",
      confirmLabel: "Pop",
      danger: true,
    });
    if (!ok) return;
  }
  await stashStore.pop(props.workspaceId, entry.ref);
}

async function onDrop(entry: StashEntry) {
  const ok = await appStore.confirmInApp({
    title: "Drop stash",
    message: `Drop ${entry.ref} "${label(entry)}"?\n\nThis cannot be undone.`,
    confirmLabel: "Drop",
    danger: true,
  });
  if (ok) await stashStore.drop(props.workspaceId, entry.ref);
}

function onBranch(entry: StashEntry) {
  const dirty = !!props.snapshot.dirty;
  appStore.openDialog("PromptDialog", {
    eyebrow: "Git",
    title: `Create branch from ${entry.ref}`,
    subtitle: `"${label(entry)}" · on ${entry.branch || "(detached)"}`,
    label: "Branch name",
    placeholder: "fix-flaky-watcher-test",
    submitLabel: "Create branch",
    pattern: "^[A-Za-z0-9._/-]+$",
    invalidHint: "Use letters, digits, and . _ / - only.",
    checkboxLabel: "Switch to the new branch immediately",
    checkboxInitial: !dirty,
    checkboxHint: dirty
      ? "Working tree has uncommitted changes. Switching would require stashing them first. Unchecked, the branch is created without touching your current state."
      : "When checked, this applies and drops the stash on the new branch (equivalent to `git stash branch`). Unchecked, just creates the branch ref — the stash is kept intact and you stay on the current branch.",
    checkboxHintWarn: dirty,
    onCancel: () => appStore.closeDialog(),
    onSubmit: async (branchName: string, switchImmediately: boolean) => {
      appStore.closeDialog();
      // Re-validate against the *current* dirty state — it may have changed
      // since the dialog opened.
      if (switchImmediately && props.snapshot.dirty) {
        await toast(
          "Working tree has changed since opening this dialog. Cancel and stash your changes first, or uncheck 'Switch immediately'.",
          "error",
        );
        return;
      }
      await stashStore.branchFrom(props.workspaceId, entry.ref, branchName, switchImmediately);
    },
  });
}

async function onCopy(entry: StashEntry) {
  try {
    await navigator.clipboard?.writeText(entry.ref);
    await toast(`Copied ${entry.ref}`);
  } catch {
    await toast("Could not copy to clipboard.", "error");
  }
}

// --- Export ---

function triggerDownload(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/x-patch" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function onExport(entry: StashEntry) {
  const { ok, patch, suggestedFilename } = await stashStore.exportPatch(props.workspaceId, entry.ref);
  if (!ok || !patch) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = appStore.getApi() as any;
  if (api?.isRemote) {
    triggerDownload(patch, suggestedFilename);
    await toast(`Downloading ${suggestedFilename}`);
    return;
  }
  const filters = [{ name: "Patch", extensions: ["patch", "diff"] }];
  // The save-file handler writes `content` to the user-chosen path itself —
  // file:write can't be used here because it is gated to workspace roots and
  // the patch is typically saved to Downloads.
  const savePath = (await api.saveFile?.({ defaultPath: suggestedFilename, filters, content: patch })) as string | null;
  if (!savePath) return;
  const slash = Math.max(savePath.lastIndexOf("/"), savePath.lastIndexOf("\\"));
  const base = slash >= 0 ? savePath.slice(slash + 1) : savePath;
  await toast(`Patch saved to ${base}`);
}

// --- Import ---

const fileInputRef = ref<HTMLInputElement | null>(null);

async function onImport() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = appStore.getApi() as any;
  if (api?.isRemote) {
    fileInputRef.value?.click();
    return;
  }
  const filters = [{ name: "Patch", extensions: ["patch", "diff"] }];
  // readContent makes the dialog return { path, content } — file:read can't be
  // used here because it is gated to workspace roots and patches are typically
  // opened from Downloads.
  const picked = (await api.browseFile?.({ filters, readContent: true })) as
    { path: string; content: string } | string | null;
  if (!picked || typeof picked === "string") return;
  if (!picked.content) {
    await toast("Could not read the selected patch file.", "error");
    return;
  }
  const base = picked.path.split(/[\\/]/).pop() || "patch";
  await promptImportMessage(picked.content, deriveMessageFromName(base));
}

async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const content = await file.text();
  await promptImportMessage(content, deriveMessageFromName(file.name));
}

function deriveMessageFromName(name: string): string {
  return name.replace(/\.(patch|diff)$/i, "").replace(/[-_]+/g, " ");
}

function promptImportMessage(patch: string, suggested: string) {
  appStore.openDialog("PromptDialog", {
    eyebrow: "Git",
    title: "Import patch as stash",
    subtitle: "The imported changes become a new stash entry.",
    label: "Stash message",
    value: suggested,
    submitLabel: "Import",
    onCancel: () => appStore.closeDialog(),
    onSubmit: async (message: string) => {
      appStore.closeDialog();
      await stashStore.importPatch(props.workspaceId, patch, message);
    },
  });
}

async function toast(body: string, kind: "info" | "error" = "info") {
  const { useNotificationStore } = await import("../../../stores/notifications.js");
  useNotificationStore().pushEphemeralToast({ title: "Stashes", body, kind, durationMs: 4000 });
}
</script>

<style scoped>
.git-section--stashes {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.stash-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 4px;
  flex-wrap: wrap;
}

.stash-toolbar--filter {
  padding-top: 0;
}

.stash-toolbar__right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stash-toolbar__count {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

.stash-toolbar__filter {
  flex: 1;
  width: 100%;
}

.stash-empty {
  padding: 24px;
  text-align: center;
  color: var(--muted);
  max-width: 460px;
  margin: 0 auto;
}

.stash-empty__actions {
  margin-top: 12px;
}

.stash-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

:deep(.stash-splitpanes.splitpanes) {
  background: transparent !important;
}

:deep(.stash-splitpanes.splitpanes > .splitpanes__pane) {
  background: transparent !important;
  overflow: hidden;
}

:deep(.stash-splitpanes.splitpanes > .splitpanes__splitter) {
  background: var(--border) !important;
  min-width: 3px;
  min-height: 3px;
}

.stash-list {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding-right: 6px;
}

.stash-list__empty {
  color: var(--muted);
  font-size: 12px;
  padding: 12px;
}

.stash-detail-host {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
</style>
