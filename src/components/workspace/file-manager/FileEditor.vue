<template>
  <div class="file-editor">
    <MonacoEditor
      :model-value="store.editContent"
      :language="language"
      :column-selection="store.columnSelection"
      :auto-focus="store.focusNextEditor"
      @update:model-value="onChange"
      @save="store.saveEdit()"
      @ready="onEditorReady"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import { guessLanguageFromPath } from "./language-map.js";

const MonacoEditor = defineAsyncComponent(() => import("../../shared/MonacoEditor.vue"));

const store = useFileManagerStore();

const language = computed(() =>
  guessLanguageFromPath(store.selectedEntry?.name || store.selectedEntry?.relativePath || ""),
);

function onChange(value: string) {
  if (value === store.editContent) return;
  store.editContent = value;
  store.editDirty = true;
}

function onEditorReady() {
  if (store.focusNextEditor) store.focusNextEditor = false;
}
</script>

<style scoped>
.file-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.file-editor :deep(.monaco-editor-container) {
  flex: 1;
  min-height: 0;
  border: none;
  border-radius: 0;
}
</style>
