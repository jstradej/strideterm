<template>
  <div class="workspace-pane__body workspace-pane__body--files" tabindex="0" @keydown="onKeydownPane">
    <PaneShell
      v-if="showHeader"
      :title="'Files'"
      :status="store.currentPath || 'root'"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <FileToolbar
      :show-hidden="store.showHidden"
      :view-mode="store.viewMode"
      :filter-text="store.filterText"
      :git-is-repo="store.gitIsRepo"
      :dirty-count="store.dirtyCount"
      @create-file="onCreateFile"
      @create-dir="onCreateDir"
      @refresh="store.refresh()"
      @toggle-hidden="store.showHidden = !store.showHidden"
      @toggle-view="store.viewMode = store.viewMode === 'list' ? 'grid' : 'list'"
      @filter="store.setFilter($event)"
    />
    <FileBreadcrumb :items="store.breadcrumbs" @navigate="store.navigate" />
    <div class="file-manager__body">
      <Splitpanes class="default-theme fm-splitpanes">
        <Pane :size="20" :min-size="10" :max-size="50">
          <aside class="file-manager__tree" @dragover.prevent="onTreeRootDragOver" @drop.prevent="onTreeRootDrop">
            <FileTree />
          </aside>
        </Pane>
        <Pane :size="80">
          <Splitpanes horizontal class="default-theme fm-splitpanes">
            <Pane :size="50" :min-size="20">
              <FileList @navigate="store.navigate" @select="store.selectEntry" @open-edit="onOpenEdit" />
            </Pane>
            <Pane :size="50" :min-size="15">
              <FilePreview v-if="store.selectedEntry" @open-in-explorer="store.openInExplorer(store.selectedEntry)" />
              <div v-else class="file-manager__no-preview">Select a file to preview</div>
            </Pane>
          </Splitpanes>
        </Pane>
      </Splitpanes>
    </div>

    <!-- File context menu -->
    <Teleport to="body">
      <div
        v-if="fileContextMenu"
        ref="fileMenuRef"
        class="context-menu"
        :style="{ position: 'fixed', left: fileContextMenu.x + 'px', top: fileContextMenu.y + 'px', zIndex: 9999 }"
        @click.stop
      >
        <button
          v-if="fileContextMenu.entry.kind === 'file'"
          type="button"
          class="context-menu__item"
          @click="onCtxOpen"
        >
          Open
        </button>
        <button
          v-if="fileContextMenu.entry.kind === 'file' && isTextLikeEntry(fileContextMenu.entry)"
          type="button"
          class="context-menu__item"
          @click="onCtxEdit"
        >
          ✎ Edit
        </button>
        <button
          v-if="fileContextMenu.entry.kind === 'file'"
          type="button"
          class="context-menu__item"
          @click="onCtxDiff"
        >
          ⇄ Diff vs HEAD / branch / commit…
        </button>
        <button
          v-if="fileContextMenu.entry.kind === 'directory'"
          type="button"
          class="context-menu__item"
          @click="onCtxOpenTerminal"
        >
          ▸ Open in Terminal
        </button>
        <button type="button" class="context-menu__item" @click="onCtxReveal">📂 Open in Explorer</button>
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item" @click="onCtxCopyPath">📋 Copy Absolute Path</button>
        <button type="button" class="context-menu__item" @click="onCtxCopyRelativePath">📋 Copy Relative Path</button>
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item" @click="onCtxCopy">⎘ Copy</button>
        <button type="button" class="context-menu__item" @click="onCtxCut">✂ Cut</button>
        <button v-if="store.clipboard" type="button" class="context-menu__item" @click="onCtxPaste">
          ⎘ Paste here
        </button>
        <button type="button" class="context-menu__item" @click="onCtxRename">✎ Rename (F2)</button>
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item" @click="onCtxNewFile">+ New File…</button>
        <button type="button" class="context-menu__item" @click="onCtxNewFolder">+ New Folder…</button>
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item context-menu__item--danger" @click="onCtxDelete">
          ✕ Delete (Del)
        </button>
      </div>
    </Teleport>

    <!-- Diff modal -->
    <FileDiff />

    <!-- Toast for ephemeral feedback (copy path success, etc.) -->
    <Teleport to="body">
      <div v-if="toast" class="fm-toast">{{ toast }}</div>
    </Teleport>

    <!-- Create dialog -->
    <div v-if="createDialog" class="fm-dialog-backdrop" @mousedown.self="createDialog = null">
      <div class="fm-dialog">
        <h3>{{ createDialog.type === "file" ? "New File" : "New Folder" }}</h3>
        <input
          ref="createInput"
          v-model="createDialog.name"
          class="fm-dialog__input"
          :placeholder="createDialog.type === 'file' ? 'filename.txt' : 'folder-name'"
          @keydown.enter="confirmCreate"
          @keydown.escape="createDialog = null"
        />
        <p v-if="createDialog && store.error" class="fm-dialog__error">{{ store.error }}</p>
        <div class="fm-dialog__actions">
          <button type="button" class="button button--ghost" @click="createDialog = null">Cancel</button>
          <button type="button" class="button" :disabled="!createDialog.name.trim()" @click="confirmCreate">
            Create
          </button>
        </div>
      </div>
    </div>

    <!-- Rename dialog -->
    <div v-if="renameDialog" class="fm-dialog-backdrop" @mousedown.self="renameDialog = null">
      <div class="fm-dialog">
        <h3>Rename</h3>
        <input
          ref="renameInput"
          v-model="renameDialog.newName"
          class="fm-dialog__input"
          @keydown.enter="confirmRename"
          @keydown.escape="renameDialog = null"
        />
        <p v-if="store.error" class="fm-dialog__error">{{ store.error }}</p>
        <div class="fm-dialog__actions">
          <button type="button" class="button button--ghost" @click="renameDialog = null">Cancel</button>
          <button type="button" class="button" :disabled="!renameDialog.newName.trim()" @click="confirmRename">
            Rename
          </button>
        </div>
      </div>
    </div>

    <!-- Delete confirm -->
    <div v-if="deleteDialog" class="fm-dialog-backdrop" @mousedown.self="deleteDialog = null">
      <div class="fm-dialog">
        <h3>Delete {{ deleteDialog.entry.kind === "directory" ? "folder" : "file" }}?</h3>
        <p class="fm-dialog__text">
          Are you sure you want to delete <strong>{{ deleteDialog.entry.name }}</strong
          >?
        </p>
        <p v-if="store.error" class="fm-dialog__error">{{ store.error }}</p>
        <div class="fm-dialog__actions">
          <button type="button" class="button button--ghost" @click="deleteDialog = null">Cancel</button>
          <button type="button" class="button" style="background: var(--danger)" @click="confirmDelete">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick, provide, computed } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useAppStore } from "../../stores/app.js";
import { useFileManagerStore } from "../../stores/file-manager.js";
import { rlog } from "../../lib/renderer-log.js";
import PaneShell from "../layout/PaneShell.vue";
import FileToolbar from "./file-manager/FileToolbar.vue";
import FileBreadcrumb from "./file-manager/FileBreadcrumb.vue";
import FileTree from "./file-manager/FileTree.vue";
import FileList from "./file-manager/FileList.vue";
import FilePreview from "./file-manager/FilePreview.vue";
import FileDiff from "./file-manager/FileDiff.vue";
import { useContextMenu } from "../../composables/useContextMenu.js";

const props = withDefaults(defineProps<{ workspaceId: string; showHeader?: boolean }>(), { showHeader: false });

const appStore = useAppStore();
const store = useFileManagerStore();

// Dialogs
const createDialog = ref<{ type: string; name: string } | null>(null);
const createInput = ref<HTMLInputElement | null>(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renameDialog = ref<{ entry: Record<string, any>; newName: string } | null>(null);
const renameInput = ref<HTMLInputElement | null>(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deleteDialog = ref<{ entry: Record<string, any> } | null>(null);

// Context menu
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fileContextMenu = ref<{ x: number; y: number; entry: Record<string, any> } | null>(null);
const fileMenuRef = ref<HTMLElement | null>(null);

// Drag-drop state shared via provide
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmDragState = ref<Record<string, any> | null>(null);
provide("fm-drag-state", fmDragState);

// Toast for transient feedback
const toast = ref<string>("");
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string, ms = 1600) {
  toast.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = "";
  }, ms);
}

const TEXT_LIKE_EXT = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".vue",
  ".json",
  ".md",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".php",
  ".sh",
  ".bash",
  ".ps1",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".sql",
  ".txt",
  ".log",
  ".env",
  ".gitignore",
  ".lock",
  ".xml",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isTextLikeEntry(entry: Record<string, any> | null | undefined) {
  if (!entry || entry.kind !== "file") return false;
  if (!entry.extension) return true; // Allow editing extension-less files (Dockerfile, Makefile, etc.)
  return TEXT_LIKE_EXT.has((entry.extension as string).toLowerCase());
}

const headerActions = computed(() => [
  {
    className: "workspace-pane__icon-btn",
    action: "refresh",
    title:
      "Re-read the current directory listing from disk — picks up changes from external tools, builds, or git operations.",
    label: "↻",
  },
  {
    className: "workspace-pane__icon-btn",
    action: "select-tab",
    viewId: `files:${props.workspaceId}`,
    title: "Make the Files pane the active tab — same as left-clicking it in the tab bar.",
    label: "◉",
  },
  {
    className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
    action: "close-tab",
    viewId: `files:${props.workspaceId}`,
    title: "Close the Files tab. The pane reopens automatically when you re-activate this workspace.",
    label: "×",
  },
]);

// Provide context menu opener to children
// eslint-disable-next-line @typescript-eslint/no-explicit-any
provide("fm-context-menu", (event: MouseEvent, entry: Record<string, any>) => {
  fileContextMenu.value = { x: event.clientX, y: event.clientY, entry };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
provide("fm-rename", (entry: Record<string, any>) => {
  renameDialog.value = { entry, newName: entry.name as string };
  nextTick(() => renameInput.value?.focus());
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
provide("fm-delete", (entry: Record<string, any>) => {
  deleteDialog.value = { entry };
});

provide("fm-create-file", () => onCreateFile());
provide("fm-create-dir", () => onCreateDir());
provide("fm-toast", showToast);

// Viewport-clamp the context menu
watch(
  fileContextMenu,
  async (menu) => {
    if (!menu) return;
    await nextTick();
    if (!fileMenuRef.value) return;
    const rect = fileMenuRef.value.getBoundingClientRect();
    let { x, y } = menu;
    let changed = false;
    if (rect.right > window.innerWidth) {
      x = window.innerWidth - rect.width - 4;
      changed = true;
    }
    if (rect.bottom > window.innerHeight) {
      y = window.innerHeight - rect.height - 4;
      changed = true;
    }
    if (changed) fileContextMenu.value = { ...menu, x, y };
  },
  { flush: "post" },
);

// Context menu actions
function dismissMenu() {
  fileContextMenu.value = null;
}

useContextMenu({ isOpen: () => !!fileContextMenu.value, menuRef: fileMenuRef, onClose: dismissMenu });

function onCtxOpen() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (!entry) return;
  if (entry.kind === "directory") store.navigate(entry.relativePath as string);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  else store.selectEntry(entry as any);
}

function onCtxEdit() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (entry?.kind === "file")
    store
      .selectEntry(entry as any)
      .then(() => store.startEdit())
      .catch((err: unknown) => {
        rlog("warn", "file-manager: selectEntry before edit failed", { err: (err as Error)?.message || String(err) });
      });
}

function onCtxDiff() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (entry?.kind === "file") store.openDiff(entry as any);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function absolutePathFor(entry: Record<string, any> | null | undefined) {
  const root = store.rootPath.replace(/\\/g, "/");
  return entry?.relativePath ? `${root}/${entry.relativePath as string}` : root;
}

function onCtxCopyPath() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (!entry) return;
  const path = absolutePathFor(entry);
  copyText(path).then(() => showToast(`Copied: ${path}`));
}

function onCtxCopyRelativePath() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (!entry) return;
  const rel = entry.relativePath as string;
  copyText(rel).then(() => showToast(`Copied: ${rel}`));
}

function onCtxOpenTerminal() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (!entry || entry.kind !== "directory") return;
  const cwd = absolutePathFor(entry);
  if (typeof appStore.quickAddTab === "function") {
    appStore.quickAddTab(cwd);
  }
}

function onCtxCopy() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (entry) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.copyToClipboard(entry as any);
    showToast(`Copied "${entry.name as string}" to clipboard`);
  }
}

function onCtxCut() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (entry) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.cutToClipboard(entry as any);
    showToast(`Cut "${entry.name as string}"`);
  }
}

function onCtxPaste() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  const targetDir = entry?.kind === "directory" ? (entry.relativePath as string) : store.currentPath;
  store.pasteEntry(targetDir);
}

function onCtxRename() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (entry) {
    renameDialog.value = { entry, newName: entry.name as string };
    nextTick(() => renameInput.value?.focus());
  }
}

function onCtxDelete() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (entry) deleteDialog.value = { entry };
}

function onCtxReveal() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (entry) store.openInExplorer(entry as any);
}

function onCtxNewFile() {
  dismissMenu();
  onCreateFile();
}

function onCtxNewFolder() {
  dismissMenu();
  onCreateDir();
}

function onHeaderAction(action: { action: string }) {
  if (action.action === "refresh") store.refresh();
}

function onCreateFile() {
  createDialog.value = { type: "file", name: "" };
  nextTick(() => createInput.value?.focus());
}

function onCreateDir() {
  createDialog.value = { type: "dir", name: "" };
  nextTick(() => createInput.value?.focus());
}

async function confirmCreate() {
  if (!createDialog.value?.name.trim()) return;
  store.error = null;
  if (createDialog.value.type === "file") {
    await store.createFile(createDialog.value.name.trim());
  } else {
    await store.createDirectory(createDialog.value.name.trim());
  }
  if (store.error) return;
  createDialog.value = null;
}

async function confirmRename() {
  if (!renameDialog.value?.newName.trim()) return;
  store.error = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await store.renameEntry(renameDialog.value.entry as any, renameDialog.value.newName.trim());
  if (store.error) return;
  renameDialog.value = null;
}

async function confirmDelete() {
  if (!deleteDialog.value) return;
  store.error = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await store.deleteEntry(deleteDialog.value.entry as any);
  if (store.error) return;
  deleteDialog.value = null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onOpenEdit(entry: Record<string, any>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store
    .selectEntry(entry as any)
    .then(() => store.startEdit())
    .catch((err: unknown) => {
      rlog("warn", "file-manager: selectEntry before edit failed", { err: (err as Error)?.message || String(err) });
    });
}

// Drop on tree root area = move to repo root
function onTreeRootDragOver(event: DragEvent) {
  if (!fmDragState.value) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function onTreeRootDrop() {
  const dragged = fmDragState.value;
  if (!dragged) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store.moveEntryTo(dragged as any, "");
  fmDragState.value = null;
}

// Pane-level keyboard navigation: arrows, Enter, Backspace, Delete, F2, Ctrl+N, etc.
function onKeydownPane(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  // Don't intercept when typing in an input/textarea/contenteditable, nor when
  // the event came from inside an embedded Monaco editor (which routes input
  // through its own dispatcher rather than a plain textarea target).
  if (
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable ||
      target.closest?.(".monaco-editor"))
  ) {
    return;
  }
  // Don't fight with the diff modal.
  if (store.diffOpen) return;

  if (event.key === "F5") {
    event.preventDefault();
    store.refresh();
    return;
  }
  if (event.key === "F2") {
    event.preventDefault();
    if (store.selectedEntry) {
      renameDialog.value = { entry: store.selectedEntry, newName: store.selectedEntry.name };
      nextTick(() => renameInput.value?.focus());
    }
    return;
  }
  if (event.key === "Delete" && store.selectedEntry) {
    event.preventDefault();
    deleteDialog.value = { entry: store.selectedEntry };
    return;
  }
  if (event.key === "Backspace") {
    event.preventDefault();
    const parts = store.currentPath.split("/").filter(Boolean);
    parts.pop();
    store.navigate(parts.join("/"));
    return;
  }
  if (event.key === "Enter" && store.selectedEntry) {
    event.preventDefault();
    if (store.selectedEntry.kind === "directory") store.navigate(store.selectedEntry.relativePath);
    else if (isTextLikeEntry(store.selectedEntry)) onOpenEdit(store.selectedEntry);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n" && !event.shiftKey) {
    event.preventDefault();
    onCreateFile();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "n") {
    event.preventDefault();
    onCreateDir();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && store.selectedEntry) {
    event.preventDefault();
    store.copyToClipboard(store.selectedEntry);
    showToast(`Copied "${store.selectedEntry.name}"`);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x" && store.selectedEntry) {
    event.preventDefault();
    store.cutToClipboard(store.selectedEntry);
    showToast(`Cut "${store.selectedEntry.name}"`);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && store.clipboard) {
    event.preventDefault();
    store.pasteEntry(store.currentPath);
    return;
  }

  // Arrow key navigation through visible entries
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const list = store.sortedEntries;
    if (!list.length) return;
    const currentIdx = list.findIndex((e) => e.relativePath === store.selectedEntry?.relativePath);
    let nextIdx;
    if (event.key === "ArrowDown") {
      nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, list.length - 1);
    } else {
      nextIdx = currentIdx <= 0 ? 0 : currentIdx - 1;
    }
    const target = list[nextIdx];
    if (target) store.selectEntry(target);
    return;
  }
  if (event.key === "ArrowRight" && store.selectedEntry?.kind === "directory") {
    event.preventDefault();
    store.navigate(store.selectedEntry.relativePath);
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    const parts = store.currentPath.split("/").filter(Boolean);
    parts.pop();
    store.navigate(parts.join("/"));
    return;
  }
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through to legacy path
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  try {
    document.execCommand("copy");
  } catch {
    /* noop */
  }
  document.body.removeChild(el);
}

onMounted(() => {
  const api = appStore.getApi();
  store.setApi(api);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = appStore.payload?.workspace as any;
  const activeWs = ws?.workspace || ws?.project || null;
  const cwd = activeWs?.cwd || "";
  if (cwd) store.init(cwd);
});

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<style scoped>
.workspace-pane__body--files {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  outline: none;
}

.file-manager__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.file-manager__tree {
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0;
  height: 100%;
}

.file-manager__no-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: 12px;
}

/* Splitpanes theme overrides */
:deep(.fm-splitpanes) {
  background: transparent;
}

:deep(.fm-splitpanes > .splitpanes__pane) {
  background: transparent;
  overflow: hidden;
}

:deep(.fm-splitpanes > .splitpanes__splitter) {
  background: var(--border);
  min-width: 3px;
  min-height: 3px;
}

:deep(.fm-splitpanes > .splitpanes__splitter:hover) {
  background: var(--accent);
}

/* Dialogs */
.fm-dialog-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
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

.fm-dialog__input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.fm-dialog__input:focus {
  border-color: var(--accent);
}

.fm-dialog__text {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--muted);
}

.fm-dialog__error {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--danger);
}

.fm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.fm-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--panel, #222);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  z-index: 9100;
  pointer-events: none;
  opacity: 0.95;
}
</style>
