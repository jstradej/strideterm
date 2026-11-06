<template>
  <section class="fce">
    <div class="fce__title">
      <span class="fce__title-text" :title="entry?.relativePath">
        Edit: {{ entry?.name }}<span v-if="store.editDirty" class="fce__dirty" aria-label="Unsaved changes"> ●</span>
      </span>
      <button
        v-if="canPopOut"
        type="button"
        class="fce__btn"
        aria-label="Open in a separate window"
        :disabled="store.editDirty"
        :title="
          store.editDirty
            ? 'Save or discard your changes before opening a separate window'
            : 'Open in a separate window'
        "
        @click="$emit('pop-out')"
      >
        ⧉
      </button>
      <button
        type="button"
        class="fce__btn fce__btn--close"
        aria-label="Close editor"
        title="Close (F4)"
        @click="$emit('close')"
      >
        ×
      </button>
    </div>
    <div class="fce__body">
      <FilePreview v-if="entry" @open-in-explorer="store.openInExplorer(entry)" />
      <p v-else class="fce__message">Loading…</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import FilePreview from "./FilePreview.vue";

defineProps<{ canPopOut?: boolean }>();
defineEmits<{ (e: "close"): void; (e: "pop-out"): void }>();

const store = useFileManagerStore();
const entry = computed(() => (store.selectedEntry?.kind === "file" ? store.selectedEntry : null));
</script>

<style scoped>
.fce {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
}

.fce__title {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  background: var(--panel);
  color: var(--muted);
}

.fce__title-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fce__dirty {
  color: var(--accent);
  font-weight: 700;
}

.fce__btn {
  flex: 0 0 auto;
  min-width: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font-size: 14px;
  line-height: 18px;
  cursor: pointer;
}

.fce__btn--close {
  font-size: 15px;
}

.fce__btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.fce__btn:hover:not(:disabled) {
  background: var(--border);
  color: var(--text);
}

.fce__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--border);
}

.fce__body > :deep(.file-preview) {
  flex: 1 1 auto;
  min-height: 0;
}

.fce__message {
  margin: 0;
  padding: 14px;
  color: var(--muted);
  text-align: center;
}

@media (pointer: coarse) {
  .fce__btn {
    min-width: 36px;
    min-height: 32px;
  }
}
</style>
