<template>
  <div
    ref="paneRoot"
    class="workspace-pane__body workspace-pane__body--sftp"
    tabindex="0"
    data-testid="sftp-pane"
    @keydown="onKeydown"
    @click="closeMenu"
  >
    <PaneShell
      v-if="showHeader"
      :title="'SFTP'"
      :status="path || (error ? 'not connected' : 'connecting…')"
      :actions="headerActions"
      @action="onHeaderAction"
    />

    <div class="sftp-toolbar">
      <button
        type="button"
        class="button button--sm button--ghost"
        :disabled="!path || path === '/'"
        title="Open the parent folder"
        data-testid="sftp-up"
        @click="goUp"
      >
        ↑ Up
      </button>
      <button
        type="button"
        class="button button--sm button--ghost"
        :disabled="loading"
        title="Read the folder again"
        aria-label="Refresh"
        data-testid="sftp-refresh"
        @click="load(path || undefined)"
      >
        ↻
      </button>
      <Spinner v-if="loading" size="sm" label="Loading…" data-testid="sftp-loading-spinner" />
      <form class="sftp-toolbar__path" @submit.prevent="load(pathInput)">
        <input
          v-model="pathInput"
          name="sftp-path"
          data-testid="sftp-path"
          aria-label="Remote path"
          title="Type a remote path and press Enter"
          spellcheck="false"
          autocomplete="off"
        />
      </form>
      <span v-if="busy" class="sftp-busy" role="status" data-testid="sftp-busy"
        ><Spinner size="sm" :label="busy" /> {{ busy }}</span
      >
      <span class="sftp-toolbar__spacer" />
      <template v-if="canPickLocal">
        <button
          type="button"
          class="button button--sm"
          :disabled="!path || !!busy"
          title="Choose files on this computer and upload them to this folder"
          data-testid="sftp-upload-files"
          @click="uploadFiles"
        >
          Upload files…
        </button>
        <button
          type="button"
          class="button button--sm"
          :disabled="!path || !!busy"
          title="Choose a folder on this computer and upload it to this folder"
          data-testid="sftp-upload-folder"
          @click="uploadFolder"
        >
          Upload folder…
        </button>
      </template>
      <button
        v-if="!isMobile"
        type="button"
        class="button button--sm"
        :disabled="!selectedEntries.length || !!busy"
        :title="downloadTitle"
        data-testid="sftp-download"
        @click="download(selectedEntries)"
      >
        Download…
      </button>
      <button
        type="button"
        class="button button--sm"
        :disabled="!path || !!busy"
        title="Create a folder in this remote folder"
        data-testid="sftp-new-folder"
        @click="newFolder"
      >
        New folder…
      </button>
    </div>

    <nav class="sftp-crumbs" aria-label="Remote path">
      <button
        v-for="crumb in crumbs"
        :key="crumb.path"
        type="button"
        class="sftp-crumbs__link"
        @click="load(crumb.path)"
      >
        {{ crumb.name }}
      </button>
    </nav>

    <p v-if="isRemote && !isMobile && !canPickLocal" class="sftp-hint" data-testid="sftp-remote-hint">
      Drag files from the Files tab onto the list to upload them.
    </p>

    <div
      class="sftp-list"
      :class="{ 'sftp-list--drop': dragOver }"
      data-testid="sftp-list"
      @dragover="onDragOver"
      @dragleave="dragOver = false"
      @drop="onDrop"
    >
      <div class="sftp-row sftp-row--head" role="row">
        <button
          v-for="column in columns"
          :key="column.key"
          type="button"
          class="sftp-cell sftp-cell--head"
          :class="`sftp-cell--${column.key}`"
          :aria-sort="sort.key === column.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'"
          @click="toggleSort(column.key)"
        >
          {{ column.label }}<span v-if="sort.key === column.key">{{ sort.dir === "asc" ? " ▲" : " ▼" }}</span>
        </button>
      </div>

      <div v-if="error" class="sftp-state sftp-state--error" data-testid="sftp-error">
        <p>{{ error }}</p>
        <button type="button" class="button button--sm" @click="load(path || undefined)">Retry</button>
      </div>
      <div v-else-if="loading && !entries.length" class="sftp-state sftp-state--loading" data-testid="sftp-loading">
        <Spinner :label="path ? 'Loading…' : 'Connecting…'" /> {{ path ? "Loading…" : "Connecting…" }}
      </div>
      <div v-else-if="!entries.length" class="sftp-state" data-testid="sftp-empty">This folder is empty.</div>

      <div
        v-for="entry in sortedEntries"
        :key="entry.name"
        class="sftp-row"
        :class="{ 'sftp-row--selected': selected.has(entry.name) }"
        role="row"
        :data-testid="`sftp-row-${entry.name}`"
        @click.stop="onRowClick($event, entry)"
        @dblclick="open(entry)"
        @contextmenu.prevent.stop="onContextMenu($event, entry)"
      >
        <span class="sftp-cell sftp-cell--name">
          <span class="sftp-icon" aria-hidden="true">{{ icon(entry) }}</span>
          <span class="sftp-name">{{ entry.name }}</span>
          <small v-if="entry.linkTarget" class="sftp-link">→ {{ entry.linkTarget }}</small>
        </span>
        <span class="sftp-cell sftp-cell--size">{{ entry.type === "dir" ? "" : formatBytes(entry.size) }}</span>
        <span class="sftp-cell sftp-cell--modified">{{ formatModified(entry.mtimeMs) }}</span>
        <span class="sftp-cell sftp-cell--mode">{{ formatMode(entry) }}</span>
      </div>
      <p v-if="truncated" class="sftp-hint" data-testid="sftp-truncated">
        Only the first {{ entries.length }} items are shown.
      </p>
    </div>

    <SftpTransfersStrip
      :runs="runs"
      :speeds="transfers.speeds"
      @cancel="cancelTransfer"
      @dismiss="transfers.dismiss($event)"
    />

    <div
      v-if="menu"
      class="sftp-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      role="menu"
      data-testid="sftp-menu"
      @click.stop
    >
      <button
        v-if="!isMobile"
        type="button"
        role="menuitem"
        :disabled="!menuTargets.length"
        data-testid="sftp-menu-download"
        @click="menuAction((targets) => download(targets))"
      >
        Download…
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="menuTargets.length !== 1"
        data-testid="sftp-menu-rename"
        @click="menuAction((targets) => rename(targets[0]!))"
      >
        Rename…
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="!menuTargets.length"
        data-testid="sftp-menu-delete"
        @click="menuAction((targets) => remove(targets))"
      >
        Delete…
      </button>
      <button type="button" role="menuitem" data-testid="sftp-menu-new-folder" @click="menuAction(newFolder)">
        New folder…
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="sftp-menu-copy-path"
        @click="menuAction((targets) => copyPath(targets))"
      >
        Copy path
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SshFileEntry } from "../../../electron/shared/ssh-file-events.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { SshFileConflictError, formatBytes, useSshFileTransfersStore } from "../../stores/ssh-file-transfers.js";
import { userFacingMessage } from "../../lib/error-message.js";
import { PATHS_MIME, readDragPaths } from "../../lib/terminal-path-drop.js";
import type { CallableTransport } from "../../transport.js";
import PaneShell from "../layout/PaneShell.vue";
import Spinner from "../common/Spinner.vue";
import SftpTransfersStrip from "./sftp/SftpTransfersStrip.vue";
import {
  breadcrumbs,
  formatMode,
  formatModified,
  isNavigable,
  joinRemote,
  parentPath,
  sortEntries,
  type SftpSort,
  type SftpSortKey,
} from "./sftp/sftp-helpers.js";

const props = withDefaults(defineProps<{ workspaceId: string; panelId: string; showHeader?: boolean }>(), {
  showHeader: false,
});

const appStore = useAppStore();
const notifications = useNotificationStore();
const transfers = useSshFileTransfersStore();
const paneRoot = ref<HTMLElement | null>(null);

const path = ref("");
const pathInput = ref("");
const entries = ref<SshFileEntry[]>([]);
const truncated = ref(false);
const loading = ref(false);
const error = ref("");
const selected = ref<Set<string>>(new Set());
const sort = ref<SftpSort>({ key: "name", dir: "asc" });
const dragOver = ref(false);
const menu = ref<{ x: number; y: number; names: string[] } | null>(null);
const busy = ref("");
let anchorName = "";
let loadSeq = 0;

async function whileBusy<T>(label: string, work: () => Promise<T>): Promise<T> {
  busy.value = label;
  try {
    return await work();
  } finally {
    busy.value = "";
  }
}

const api = () => appStore.getApi() as CallableTransport;
const isRemote = computed(() => appStore.isRemoteTransport);
const isMobile = computed(() => isRemote.value && appStore.isMobileSession());
const canPickLocal = computed(() => !isRemote.value && typeof api().browsePaths === "function");
const target = () => ({ workspaceId: props.workspaceId, panelId: props.panelId });
const pathKey = () => `strideterm-sftp-path:${props.panelId}`;

const panel = computed(() => {
  const workspaces = (appStore.payload?.appState?.workspaces || []) as Array<{
    id: string;
    panels?: Array<{ id: string; title?: string }>;
  }>;
  return workspaces.find((ws) => ws.id === props.workspaceId)?.panels?.find((item) => item.id === props.panelId);
});
const hostLabel = computed(() => (panel.value?.title || "SSH host").replace(/^Files · /, ""));

const columns: Array<{ key: SftpSortKey; label: string }> = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
  { key: "modified", label: "Modified" },
  { key: "mode", label: "Mode" },
];

const crumbs = computed(() => breadcrumbs(path.value || "/"));
const sortedEntries = computed(() => sortEntries(entries.value, sort.value));
const selectedEntries = computed(() => sortedEntries.value.filter((entry) => selected.value.has(entry.name)));
const downloadTitle = computed(() => {
  if (!selectedEntries.value.length) return "Select one or more items to download";
  return isRemote.value
    ? "Download the selected items into a workspace folder on the desktop"
    : "Download the selected items to a folder on this computer";
});
const menuTargets = computed(() => entries.value.filter((entry) => menu.value?.names.includes(entry.name)));
const runs = computed(() => transfers.forWorkspace(props.workspaceId));
const runningCount = computed(() => runs.value.filter((run) => run.state === "running").length);

const headerActions = computed(() => [
  {
    className: "workspace-pane__icon-btn",
    action: "refresh",
    title: "Read the current remote folder again.",
    label: "↻",
  },
]);

function icon(entry: SshFileEntry): string {
  if (entry.type === "dir") return "📁";
  if (entry.type === "symlink") return "🔗";
  return "📄";
}

function readRememberedPath(): string | undefined {
  try {
    return window.localStorage.getItem(pathKey()) || undefined;
  } catch {
    return undefined;
  }
}

function rememberPath(value: string): void {
  try {
    window.localStorage.setItem(pathKey(), value);
  } catch {
    // UI-state persistence only; the browser still works without it.
  }
}

async function load(requested?: string): Promise<void> {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = "";
  try {
    const wanted = requested?.trim() || undefined;
    let directory = wanted;
    if (!directory) directory = path.value || readRememberedPath();
    if (!directory) directory = (await api().sshFileRealpath(target())).path;
    let listing;
    try {
      listing = await api().sshFileList({ ...target(), path: directory });
    } catch (failure) {
      // A remembered folder that is gone falls back to the tab's own start folder.
      if (wanted || (failure as { code?: string }).code !== "not-found") throw failure;
      directory = (await api().sshFileRealpath(target())).path;
      listing = await api().sshFileList({ ...target(), path: directory });
    }
    if (seq !== loadSeq) return;
    path.value = listing.path;
    pathInput.value = listing.path;
    entries.value = listing.entries;
    truncated.value = listing.truncated;
    selected.value = new Set();
    rememberPath(listing.path);
  } catch (failure) {
    if (seq !== loadSeq) return;
    error.value = userFacingMessage(failure, "Couldn't read the remote folder.");
    pathInput.value = path.value;
    notifications.showError("Couldn't open the remote folder", failure, { workspaceId: props.workspaceId });
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

function goUp(): void {
  if (path.value) void load(parentPath(path.value));
}

function open(entry: SshFileEntry): void {
  if (isNavigable(entry)) void load(joinRemote(path.value, entry.name));
}

function toggleSort(key: SftpSortKey): void {
  sort.value = { key, dir: sort.value.key === key && sort.value.dir === "asc" ? "desc" : "asc" };
}

function onRowClick(event: MouseEvent, entry: SshFileEntry): void {
  closeMenu();
  const next = new Set(event.ctrlKey || event.metaKey ? selected.value : []);
  if (event.shiftKey && anchorName) {
    const names = sortedEntries.value.map((item) => item.name);
    const from = names.indexOf(anchorName);
    const to = names.indexOf(entry.name);
    if (from >= 0 && to >= 0)
      for (const name of names.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(name);
  } else if ((event.ctrlKey || event.metaKey) && next.has(entry.name)) {
    next.delete(entry.name);
  } else {
    next.add(entry.name);
    anchorName = entry.name;
  }
  selected.value = next;
}

function onContextMenu(event: MouseEvent, entry: SshFileEntry): void {
  if (!selected.value.has(entry.name)) {
    selected.value = new Set([entry.name]);
    anchorName = entry.name;
  }
  const bounds = paneRoot.value?.getBoundingClientRect();
  menu.value = {
    x: event.clientX - (bounds?.left ?? 0),
    y: event.clientY - (bounds?.top ?? 0),
    names: [...selected.value],
  };
}

function closeMenu(): void {
  menu.value = null;
}

function menuAction(run: (targets: SshFileEntry[]) => unknown): void {
  const targets = menuTargets.value;
  closeMenu();
  void run(targets);
}

function onKeydown(event: KeyboardEvent): void {
  const targetElement = event.target as HTMLElement | null;
  if (targetElement && ["INPUT", "TEXTAREA", "SELECT"].includes(targetElement.tagName)) return;
  if (event.key === "Escape") closeMenu();
  else if (event.key === "Delete" && selectedEntries.value.length) void remove(selectedEntries.value);
  else if (event.key === "F2" && selectedEntries.value.length === 1) void rename(selectedEntries.value[0]!);
  else if (event.key === "Enter" && selectedEntries.value.length === 1) open(selectedEntries.value[0]!);
}

function onHeaderAction(action: { action: string }): void {
  if (action.action === "refresh") void load(path.value || undefined);
}

// ---- transfers --------------------------------------------------------------

function askConflict(conflicts: string[]): Promise<"overwrite" | "skip" | null> {
  return new Promise((resolve) => {
    appStore.openDialog("SftpConflictDialog", {
      conflicts,
      onCancel: () => {
        appStore.closeDialog();
        resolve(null);
      },
      onChoose: (policy: "overwrite" | "skip") => {
        appStore.closeDialog();
        resolve(policy);
      },
    });
  });
}

type TransferBase =
  | { direction: "upload"; localPaths: string[]; remoteDir: string }
  | { direction: "download"; remotePaths: string[]; localDir: string };

async function runTransfer(base: TransferBase, conflict: "fail" | "overwrite" | "skip" = "fail"): Promise<void> {
  try {
    await whileBusy(base.direction === "upload" ? "Starting upload…" : "Starting download…", () =>
      base.direction === "upload"
        ? transfers.start(
            "upload",
            { ...target(), localPaths: base.localPaths, remoteDir: base.remoteDir, conflict },
            { hostLabel: hostLabel.value },
          )
        : transfers.start(
            "download",
            { ...target(), remotePaths: base.remotePaths, localDir: base.localDir, conflict },
            { hostLabel: hostLabel.value },
          ),
    );
  } catch (failure) {
    if (failure instanceof SshFileConflictError) {
      const choice = await askConflict(failure.conflicts);
      if (choice) await runTransfer(base, choice);
      return;
    }
    notifications.showError(
      base.direction === "upload" ? "Couldn't start the upload" : "Couldn't start the download",
      failure,
      { workspaceId: props.workspaceId },
    );
  }
}

async function startUpload(localPaths: string[]): Promise<void> {
  if (!path.value || !localPaths.length) return;
  await runTransfer({ direction: "upload", localPaths, remoteDir: path.value });
}

async function pick(options: { files: boolean; directories: boolean; title: string }): Promise<string[]> {
  try {
    return (await api().browsePaths(options)) || [];
  } catch (failure) {
    notifications.showError("Couldn't open the file picker", failure, { workspaceId: props.workspaceId });
    return [];
  }
}

async function uploadFiles(): Promise<void> {
  await startUpload(await pick({ files: true, directories: false, title: "Upload files" }));
}

async function uploadFolder(): Promise<void> {
  await startUpload(await pick({ files: false, directories: true, title: "Upload folder" }));
}

function workspaceRoots(): string[] {
  const profile = appStore.myActiveProfileId || "default";
  const workspaces = (appStore.payload?.appState?.workspaces || []) as Array<{
    profileId?: string;
    cwd?: string;
    gitRoots?: string[];
  }>;
  const roots = new Set<string>();
  for (const ws of workspaces) {
    if ((ws.profileId || "default") !== profile) continue;
    if (ws.cwd) roots.add(ws.cwd);
    for (const root of ws.gitRoots || []) if (root) roots.add(root);
  }
  return [...roots];
}

async function download(items: SshFileEntry[]): Promise<void> {
  if (isMobile.value || !items.length || !path.value) return;
  const remotePaths = items.map((entry) => joinRemote(path.value, entry.name));
  if (isRemote.value) {
    const roots = workspaceRoots();
    if (!roots.length) {
      notifications.showError("Couldn't start the download", "This profile has no workspace folder to save into.", {
        workspaceId: props.workspaceId,
      });
      return;
    }
    appStore.openDialog("SftpDownloadTargetDialog", {
      roots,
      onCancel: () => appStore.closeDialog(),
      onSubmit: (localDir: string) => {
        appStore.closeDialog();
        void runTransfer({ direction: "download", remotePaths, localDir });
      },
    });
    return;
  }
  let localDir: string | null;
  try {
    localDir = ((await api().browseDirectory?.()) as string | null) || null;
  } catch (failure) {
    notifications.showError("Couldn't open the folder picker", failure, { workspaceId: props.workspaceId });
    return;
  }
  if (localDir) await runTransfer({ direction: "download", remotePaths, localDir });
}

async function cancelTransfer(transferId: string): Promise<void> {
  await notifications.runWithToast("Couldn't cancel the transfer", () => transfers.cancel(transferId), {
    workspaceId: props.workspaceId,
  });
}

// ---- drop onto the list -----------------------------------------------------

function accepts(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes(PATHS_MIME) || types.includes("Files");
}

function onDragOver(event: DragEvent): void {
  if (!accepts(event) || !path.value) return;
  event.preventDefault();
  dragOver.value = true;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  if (!accepts(event) || !path.value) return;
  event.preventDefault();
  event.stopPropagation();
  const data = event.dataTransfer;
  let paths = readDragPaths(data);
  if (!paths && data?.files?.length) {
    if (isRemote.value || typeof api().getPathForDroppedFile !== "function") {
      notifications.pushEphemeralToast({
        title: "Cannot drop here",
        body: "Dropping files from this computer needs the desktop app. Drag them from the Files tab instead.",
        kind: "error",
        durationMs: 7000,
      });
      return;
    }
    paths = Array.from(data.files)
      .map((file) => api().getPathForDroppedFile(file))
      .filter((value): value is string => Boolean(value));
  }
  if (paths?.length) void startUpload(paths);
}

// ---- remote-side changes ----------------------------------------------------

function newFolder(): void {
  if (!path.value || busy.value) return;
  appStore.openDialog("PromptDialog", {
    eyebrow: "SFTP",
    title: "New folder",
    subtitle: path.value,
    label: "Folder name",
    placeholder: "new-folder",
    submitLabel: "Create",
    pattern: "^[^/\\u0000]+$",
    invalidHint: "A folder name cannot contain /.",
    onCancel: () => appStore.closeDialog(),
    onSubmit: async (name: string) => {
      if (busy.value) return;
      const ok = await whileBusy("Creating folder…", () =>
        notifications.runWithToast(
          "Couldn't create the folder",
          () => api().sshFileMkdir({ ...target(), path: joinRemote(path.value, name) }),
          { workspaceId: props.workspaceId },
        ),
      );
      if (!ok) return;
      appStore.closeDialog();
      await load(path.value);
    },
  });
}

function rename(entry: SshFileEntry): void {
  if (busy.value) return;
  appStore.openDialog("PromptDialog", {
    eyebrow: "SFTP",
    title: "Rename",
    subtitle: joinRemote(path.value, entry.name),
    label: "New name",
    value: entry.name,
    submitLabel: "Rename",
    pattern: "^[^/\\u0000]+$",
    invalidHint: "A name cannot contain /.",
    onCancel: () => appStore.closeDialog(),
    onSubmit: async (name: string) => {
      if (busy.value) return;
      if (name === entry.name) {
        appStore.closeDialog();
        return;
      }
      const ok = await whileBusy("Renaming…", () =>
        notifications.runWithToast(
          "Couldn't rename the item",
          () =>
            api().sshFileRename({
              ...target(),
              from: joinRemote(path.value, entry.name),
              to: joinRemote(path.value, name),
            }),
          { workspaceId: props.workspaceId },
        ),
      );
      if (!ok) return;
      appStore.closeDialog();
      await load(path.value);
    },
  });
}

async function remove(items: SshFileEntry[]): Promise<void> {
  if (!items.length || busy.value) return;
  const folders = items.filter((entry) => entry.type === "dir").length;
  const names = items
    .slice(0, 5)
    .map((entry) => `  ${entry.name}`)
    .join("\n");
  const more = items.length > 5 ? `\n  … and ${items.length - 5} more` : "";
  const confirmed = await appStore.confirmInApp({
    title: items.length === 1 ? `Delete ${items[0]!.name}` : `Delete ${items.length} items`,
    message:
      `${names}${more}\n\n` +
      (folders ? "Folders are deleted with everything inside them. " : "") +
      "This cannot be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!confirmed) return;
  await whileBusy("Deleting…", () =>
    notifications.runWithToast(
      "Couldn't delete the items",
      () =>
        api().sshFileDelete({
          ...target(),
          paths: items.map((entry) => joinRemote(path.value, entry.name)),
          recursive: folders > 0,
        }),
      { workspaceId: props.workspaceId },
    ),
  );
  await load(path.value);
}

async function copyPath(targets: SshFileEntry[]): Promise<void> {
  const [first] = targets;
  const value = first ? joinRemote(path.value, first.name) : path.value;
  await notifications.runWithToast("Couldn't copy the path", async () => {
    await navigator.clipboard.writeText(value);
  });
}

// A finished transfer changes what is on the host: read the folder again when one ends.
watch(runningCount, (now, before) => {
  if (now < before && path.value) void load(path.value);
});

onMounted(() => {
  void load();
});

onBeforeUnmount(() => {
  loadSeq += 1;
});
</script>

<style scoped>
.workspace-pane__body--sftp {
  container: sftp-pane / inline-size;
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  outline: none;
}

.sftp-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}

.sftp-toolbar__path {
  flex: 1 1 200px;
  min-width: 120px;
}

.sftp-toolbar__path input {
  width: 100%;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.sftp-toolbar__spacer {
  flex: 0 0 4px;
}

.sftp-busy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.sftp-crumbs {
  display: flex;
  flex-wrap: wrap;
  padding: 2px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

.sftp-crumbs__link {
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
}

.sftp-crumbs__link:hover {
  color: var(--text);
}

.sftp-hint {
  margin: 0;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--muted);
}

.sftp-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  --sftp-columns: minmax(0, 1fr) 80px 130px 90px;
}

.sftp-list--drop {
  outline: 2px dashed var(--accent);
  outline-offset: -4px;
}

.sftp-row {
  display: grid;
  grid-template-columns: var(--sftp-columns);
  gap: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: default;
  user-select: none;
}

.sftp-row--head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-pane);
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  color: var(--muted);
}

.sftp-row:not(.sftp-row--head):hover {
  background: var(--border);
}

.sftp-row--selected,
.sftp-row--selected:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

.sftp-cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sftp-cell--head {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.sftp-cell--size,
.sftp-cell--modified,
.sftp-cell--mode {
  text-align: right;
}

.sftp-icon {
  margin-right: 6px;
}

.sftp-link {
  margin-left: 6px;
  color: var(--muted);
}

.sftp-state {
  padding: 16px 10px;
  color: var(--muted);
  font-size: 13px;
}

.sftp-state--loading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sftp-state--error {
  color: var(--danger);
}

.sftp-menu {
  position: absolute;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 160px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--menu-bg);
  box-shadow: var(--menu-shadow);
}

.sftp-menu button {
  padding: 6px 10px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.sftp-menu button:hover:not(:disabled) {
  background: var(--border);
}

.sftp-menu button:disabled {
  color: var(--muted);
  cursor: default;
}

@container sftp-pane (max-width: 520px) {
  .sftp-list {
    --sftp-columns: minmax(96px, 1fr) 64px 100px;
  }

  .sftp-cell--mode {
    display: none;
  }
}
</style>
