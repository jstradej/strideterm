<template>
  <div class="td__section">
    <div class="td__file-tabs">
      <button
        v-for="f in taskFiles"
        :key="f.name"
        class="td__file-tab"
        :class="{ 'td__file-tab--active': activeFile === f.name }"
        @click="switchFile(f.name)"
      >
        {{ f.name }}
        <span v-if="f.dirty" class="td__file-dirty">*</span>
      </button>
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
      <div class="td__editor-actions">
        <button class="button button--sm" :disabled="!activeFileDirty" @click="saveActiveFile">Save</button>
        <button class="button button--ghost button--sm" :disabled="!activeFileDirty" @click="reloadActiveFile">
          Revert
        </button>
        <span
          v-if="fileSaveStatus"
          class="td__save-status"
          :class="{
            'td__save-status--ok': fileSaveStatus.includes('\u2713'),
            'td__save-status--err': fileSaveStatus.includes('\u2717'),
          }"
          >{{ fileSaveStatus }}</span
        >
      </div>
    </template>
  </div>
</template>

<script setup>
import { defineAsyncComponent } from "vue";

const MonacoEditor = defineAsyncComponent(() => import("../shared/MonacoEditor.vue"));

defineProps({
  taskFiles: { type: Array, required: true },
  activeFile: { type: String, required: true },
  activeFileContent: { type: String, required: true },
  activeFileDirty: { type: Boolean, required: true },
  editorLanguage: { type: String, required: true },
  fileLoading: { type: Boolean, default: false },
  fileError: { type: String, default: "" },
  fileSaveStatus: { type: String, default: "" },
});

const emit = defineEmits(["switch-file", "mark-dirty", "save", "reload", "update:activeFileContent"]);

function switchFile(name) {
  emit("switch-file", name);
}
function onEditorChange(value) {
  emit("update:activeFileContent", value);
  emit("mark-dirty");
}
function saveActiveFile() {
  emit("save");
}
function reloadActiveFile() {
  emit("reload");
}
</script>

<style scoped>
.td__empty {
  opacity: 0.5;
  padding: 24px 0;
  text-align: center;
}
.td__file-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border, #333);
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
  flex: 1;
  min-height: 250px;
  border-radius: 4px;
  overflow: hidden;
}
.td__editor-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
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
