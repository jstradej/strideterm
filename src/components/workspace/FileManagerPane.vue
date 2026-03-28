<template>
  <div class="workspace-pane__body workspace-pane__body--files">
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
      @create-file="onCreateFile"
      @create-dir="onCreateDir"
      @refresh="store.refresh()"
      @toggle-hidden="store.showHidden = !store.showHidden"
      @toggle-view="store.viewMode = store.viewMode === 'list' ? 'grid' : 'list'"
    />
    <FileBreadcrumb :items="store.breadcrumbs" @navigate="store.navigate" />
    <div class="file-manager__body">
      <Splitpanes class="default-theme fm-splitpanes">
        <Pane :size="20" :min-size="10" :max-size="50">
          <aside class="file-manager__tree">
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
          @click="onCtxEdit"
        >
          &#x270E; Edit
        </button>
        <button type="button" class="context-menu__item" @click="onCtxCopy">&#x2398; Copy</button>
        <button v-if="store.clipboard" type="button" class="context-menu__item" @click="onCtxPaste">
          &#x2399; Paste here
        </button>
        <button type="button" class="context-menu__item" @click="onCtxRename">&#x270E; Rename</button>
        <button type="button" class="context-menu__item" @click="onCtxReveal">&#x1F4C2; Open in Explorer</button>
        <div class="context-menu__divider"></div>
        <button type="button" class="context-menu__item context-menu__item--danger" @click="onCtxDelete">
          &#x2715; Delete
        </button>
      </div>
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
        <div class="fm-dialog__actions">
          <button type="button" class="button button--ghost" @click="deleteDialog = null">Cancel</button>
          <button type="button" class="button" style="background: var(--danger)" @click="confirmDelete">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick, provide } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useAppStore } from "../../stores/app.js";
import { useFileManagerStore } from "../../stores/file-manager.js";
import PaneShell from "../layout/PaneShell.vue";
import FileToolbar from "./file-manager/FileToolbar.vue";
import FileBreadcrumb from "./file-manager/FileBreadcrumb.vue";
import FileTree from "./file-manager/FileTree.vue";
import FileList from "./file-manager/FileList.vue";
import FilePreview from "./file-manager/FilePreview.vue";

const props = defineProps({
  workspaceId: { type: String, required: true },
  showHeader: { type: Boolean, default: false },
});

const appStore = useAppStore();
const store = useFileManagerStore();

// Dialogs
const createDialog = ref(null);
const createInput = ref(null);
const renameDialog = ref(null);
const renameInput = ref(null);
const deleteDialog = ref(null);

// Context menu
const fileContextMenu = ref(null); // { x, y, entry }
const fileMenuRef = ref(null);

const headerActions = [
  { className: "workspace-pane__icon-btn", action: "refresh", title: "Refresh", label: "\u21bb" },
  {
    className: "workspace-pane__icon-btn",
    action: "select-tab",
    viewId: `files:${props.workspaceId}`,
    title: "Focus tab",
    label: "\u25c9",
  },
  {
    className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
    action: "close-tab",
    viewId: `files:${props.workspaceId}`,
    title: "Close tab",
    label: "\u00d7",
  },
];

// Provide context menu opener to children
provide("fm-context-menu", (event, entry) => {
  fileContextMenu.value = { x: event.clientX, y: event.clientY, entry };
});

provide("fm-rename", (entry) => {
  renameDialog.value = { entry, newName: entry.name };
  nextTick(() => renameInput.value?.focus());
});

provide("fm-delete", (entry) => {
  deleteDialog.value = { entry };
});

provide("fm-create-file", () => onCreateFile());
provide("fm-create-dir", () => onCreateDir());

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

// Close context menu on outside click / Escape
function onDocClick(e) {
  if (fileMenuRef.value && !fileMenuRef.value.contains(e.target)) {
    fileContextMenu.value = null;
  }
}
function onKeydown(e) {
  if (e.key === "Escape") fileContextMenu.value = null;
}

// Context menu actions
function dismissMenu() {
  fileContextMenu.value = null;
}

function onCtxEdit() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (entry?.kind === "file") store.selectEntry(entry).then(() => store.startEdit());
}

function onCtxCopy() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (entry) store.copyToClipboard(entry);
}

function onCtxPaste() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  const targetDir = entry?.kind === "directory" ? entry.relativePath : store.currentPath;
  store.pasteEntry(targetDir);
}

function onCtxRename() {
  const entry = fileContextMenu.value?.entry;
  dismissMenu();
  if (entry) {
    renameDialog.value = { entry, newName: entry.name };
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
  if (entry) store.openInExplorer(entry);
}

function onHeaderAction(action) {
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
  if (createDialog.value.type === "file") {
    await store.createFile(createDialog.value.name.trim());
  } else {
    await store.createDirectory(createDialog.value.name.trim());
  }
  createDialog.value = null;
}

async function confirmRename() {
  if (!renameDialog.value?.newName.trim()) return;
  await store.renameEntry(renameDialog.value.entry, renameDialog.value.newName.trim());
  renameDialog.value = null;
}

async function confirmDelete() {
  if (!deleteDialog.value) return;
  await store.deleteEntry(deleteDialog.value.entry);
  deleteDialog.value = null;
}

function onOpenEdit(entry) {
  store.selectEntry(entry).then(() => store.startEdit());
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);
  const api = appStore.getApi();
  store.setApi(api);
  const ws = appStore.payload?.workspace;
  const activeWs = ws?.workspace || ws?.project || null;
  const cwd = activeWs?.cwd || "";
  if (cwd) store.init(cwd);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<style scoped>
.workspace-pane__body--files {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
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

.fm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>
