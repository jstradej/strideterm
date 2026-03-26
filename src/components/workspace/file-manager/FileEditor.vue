<template>
  <div class="file-editor">
    <div class="file-editor__gutter" ref="gutter">
      <div v-for="n in lineCount" :key="n" class="file-editor__line-number">{{ n }}</div>
    </div>
    <textarea
      ref="textarea"
      class="file-editor__input"
      :value="store.editContent"
      @input="onInput"
      @keydown.ctrl.s.prevent="store.saveEdit()"
      @keydown.escape="store.cancelEdit()"
      @scroll="syncGutterScroll"
      spellcheck="false"
      wrap="off"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";

const store = useFileManagerStore();
const textarea = ref(null);
const gutter = ref(null);

const lineCount = computed(() => {
  const lines = (store.editContent || "").split("\n").length;
  return Math.max(lines, 1);
});

function onInput(event) {
  store.editContent = event.target.value;
  store.editDirty = true;
}

function syncGutterScroll() {
  if (gutter.value && textarea.value) {
    gutter.value.scrollTop = textarea.value.scrollTop;
  }
}

onMounted(() => {
  nextTick(() => textarea.value?.focus());
});
</script>

<style scoped>
.file-editor {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", monospace;
  font-size: 12px;
  line-height: 1.5;
}

.file-editor__gutter {
  flex-shrink: 0;
  width: 44px;
  overflow: hidden;
  text-align: right;
  padding: 8px 6px 8px 0;
  color: var(--muted);
  background: var(--panel);
  border-right: 1px solid var(--border);
  user-select: none;
}

.file-editor__line-number {
  height: 1.5em;
  font-size: 11px;
}

.file-editor__input {
  flex: 1;
  resize: none;
  border: none;
  outline: none;
  padding: 8px 12px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  tab-size: 2;
  white-space: pre;
  overflow: auto;
}
</style>
