<template>
  <div class="td__section td__section--files">
    <div class="td__file-tabs">
      <button
        v-for="f in taskFiles"
        :key="f.name"
        class="td__file-tab"
        :class="{ 'td__file-tab--active': activeFile === f.name }"
        :title="f.description || f.name"
        @click="switchFile(f.name)"
      >
        {{ f.label || f.name }}
        <span v-if="f.dirty" class="td__file-dirty">*</span>
      </button>
      <div class="td__editor-actions">
        <span
          v-if="fileSaveStatus"
          class="td__save-status"
          :class="{
            'td__save-status--ok': fileSaveStatus.includes('\u2713'),
            'td__save-status--err': fileSaveStatus.includes('\u2717'),
          }"
          >{{ fileSaveStatus }}</span
        >
        <button class="button button--sm" :disabled="!activeFileDirty" @click="saveActiveFile">Save</button>
        <button class="button button--ghost button--sm" :disabled="!activeFileDirty" @click="reloadActiveFile">
          Revert
        </button>
      </div>
    </div>
    <div v-if="fileLoading" class="td__empty">Loading...</div>
    <div v-else-if="fileError" class="td__empty">{{ fileError }}</div>
    <template v-else>
      <div class="td__editor-wrap">
        <MonacoEditor
          :model-value="activeFileContent"
          :language="editorLanguage"
          @update:model-value="onEditorChange"
          @save="saveActiveFile"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from "vue";

const MonacoEditor = defineAsyncComponent(() => import("../shared/MonacoEditor.vue"));

interface TaskFile {
  name: string;
  label?: string;
  description?: string;
  dirty?: boolean;
}

withDefaults(
  defineProps<{
    taskFiles: TaskFile[];
    activeFile: string;
    activeFileContent: string;
    activeFileDirty: boolean;
    editorLanguage: string;
    fileLoading?: boolean;
    fileError?: string;
    fileSaveStatus?: string;
  }>(),
  { fileLoading: false, fileError: "", fileSaveStatus: "" },
);

const emit = defineEmits<{
  (e: "switch-file", name: string): void;
  (e: "mark-dirty"): void;
  (e: "save"): void;
  (e: "reload"): void;
  (e: "update:activeFileContent", value: string): void;
}>();

function switchFile(name: string): void {
  emit("switch-file", name);
}
function onEditorChange(value: string): void {
  emit("update:activeFileContent", value);
  emit("mark-dirty");
}
function saveActiveFile(): void {
  emit("save");
}
function reloadActiveFile(): void {
  emit("reload");
}
</script>

<style scoped>
/* Grid item of .td__body (grid with minmax(0, 1fr)) — default
   align-self: stretch sizes us to the cell. Inside we use our own 2-row
   grid so file-tabs keep their natural height and editor-wrap takes 1fr. */
.td__section--files {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.td__empty {
  opacity: 0.5;
  padding: 24px 0;
  text-align: center;
  flex: 1;
}
.td__file-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border, #333);
  flex-shrink: 0;
}
.td__file-tab {
  background: none;
  border: none;
  color: var(--muted, #888);
  font-size: 12px;
  padding: 5px 10px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  font-family: monospace;
}
.td__file-tab:hover {
  color: var(--fg, #ccc);
}
.td__file-tab--active {
  color: var(--fg, #ccc);
  border-bottom-color: var(--accent, #7c4dff);
}
.td__file-dirty {
  color: #e57373;
  font-weight: bold;
  margin-left: 2px;
}
.td__editor-wrap {
  flex: 1 1 auto;
  min-height: 300px;
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.td__editor-wrap > :deep(.monaco-editor-container) {
  position: absolute;
  inset: 0;
}
.td__editor-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.td__save-status {
  font-size: 12px;
  font-weight: 600;
}
.td__save-status--ok {
  color: #81c784;
}
.td__save-status--err {
  color: #e57373;
}
</style>
