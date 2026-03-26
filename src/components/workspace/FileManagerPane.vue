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
      @create-file="onCreateFile"
      @create-dir="onCreateDir"
      @refresh="store.refresh()"
      @toggle-hidden="store.showHidden = !store.showHidden"
      @toggle-view="store.viewMode = store.viewMode === 'list' ? 'grid' : 'list'"
      :show-hidden="store.showHidden"
      :view-mode="store.viewMode"
    />
    <FileBreadcrumb :items="store.breadcrumbs" @navigate="store.navigate" />
    <div class="file-manager__body">
      <aside class="file-manager__tree">
        <FileTree />
      </aside>
      <div class="file-manager__content">
        <FileList @navigate="store.navigate" @select="store.selectEntry" @open-edit="onOpenEdit" />
        <FilePreview v-if="store.selectedEntry" @open-in-explorer="store.openInExplorer(store.selectedEntry)" />
      </div>
    </div>

    <!-- Create dialog -->
    <div v-if="createDialog" class="fm-dialog-backdrop" @mousedown.self="createDialog = null">
      <div class="fm-dialog">
        <h3>{{ createDialog.type === 'file' ? 'New File' : 'New Folder' }}</h3>
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
          <button type="button" class="button" @click="confirmCreate" :disabled="!createDialog.name.trim()">Create</button>
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
          <button type="button" class="button" @click="confirmRename" :disabled="!renameDialog.newName.trim()">Rename</button>
        </div>
      </div>
    </div>

    <!-- Delete confirm -->
    <div v-if="deleteDialog" class="fm-dialog-backdrop" @mousedown.self="deleteDialog = null">
      <div class="fm-dialog">
        <h3>Delete {{ deleteDialog.entry.kind === 'directory' ? 'folder' : 'file' }}?</h3>
        <p class="fm-dialog__text">Are you sure you want to delete <strong>{{ deleteDialog.entry.name }}</strong>?</p>
        <div class="fm-dialog__actions">
          <button type="button" class="button button--ghost" @click="deleteDialog = null">Cancel</button>
          <button type="button" class="button" style="background:var(--danger)" @click="confirmDelete">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick, provide } from "vue";
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

const headerActions = [
  { className: "workspace-pane__icon-btn", action: "refresh", title: "Refresh", label: "\u21bb" },
  { className: "workspace-pane__icon-btn", action: "select-tab", viewId: `files:${props.workspaceId}`, title: "Focus tab", label: "\u25c9" },
  { className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger", action: "close-tab", viewId: `files:${props.workspaceId}`, title: "Close tab", label: "\u00d7" },
];

// Provide dialog openers to child components
provide("fm-rename", (entry) => {
  renameDialog.value = { entry, newName: entry.name };
  nextTick(() => renameInput.value?.focus());
});

provide("fm-delete", (entry) => {
  deleteDialog.value = { entry };
});

provide("fm-create-file", () => onCreateFile());
provide("fm-create-dir", () => onCreateDir());

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
  const api = appStore.getApi();
  store.setApi(api);
  const ws = appStore.payload?.workspace;
  const activeWs = ws?.workspace || ws?.project || null;
  const cwd = activeWs?.cwd || "";
  if (cwd) {
    store.init(cwd);
  }
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
  display: grid;
  grid-template-columns: 220px 1fr;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.file-manager__tree {
  overflow-y: auto;
  overflow-x: hidden;
  border-right: 1px solid var(--border);
  padding: 4px 0;
  min-height: 0;
}

.file-manager__content {
  display: grid;
  grid-template-rows: 1fr 1fr;
  min-height: 0;
  overflow: hidden;
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
