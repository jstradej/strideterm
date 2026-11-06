<template>
  <section class="fcq">
    <div class="fcq__title">
      <span class="fcq__title-text" :title="name">Quick View: {{ name }}</span>
      <div v-if="view.status === 'text' && isMarkdown" class="fcq__modes" role="group" aria-label="Markdown view">
        <button
          type="button"
          class="fcq__mode"
          :class="{ 'fcq__mode--active': markdownPreview }"
          :aria-pressed="markdownPreview"
          title="Render this Markdown file for reading."
          @click="markdownPreview = true"
        >
          Preview
        </button>
        <button
          type="button"
          class="fcq__mode"
          :class="{ 'fcq__mode--active': !markdownPreview }"
          :aria-pressed="!markdownPreview"
          title="Show the Markdown source in the code editor."
          @click="markdownPreview = false"
        >
          Source
        </button>
      </div>
      <button type="button" class="fcq__close" aria-label="Close Quick View" title="Close (F3)" @click="$emit('close')">
        ×
      </button>
    </div>
    <div class="fcq__body">
      <div
        v-if="view.status === 'text'"
        class="fcq__code"
        :class="{ 'fcq__code--markdown': isMarkdown && markdownPreview }"
      >
        <MarkdownContent v-if="isMarkdown && markdownPreview" class="fcq__markdown" :text="view.content ?? ''" />
        <MonacoEditor v-else :model-value="view.content ?? ''" :language="language" read-only />
      </div>
      <img v-else-if="view.status === 'image'" class="fcq__image" :src="view.src" :alt="name" />
      <p v-else class="fcq__message" :class="{ 'fcq__message--error': view.status === 'error' }">
        {{ message }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import type { QuickViewState } from "./commander-helpers.js";
import { guessLanguageFromPath } from "./language-map.js";
import MarkdownContent from "../azure/MarkdownContent.vue";
import { isMarkdownFile } from "../azure/markdown-renderer.js";

const MonacoEditor = defineAsyncComponent(() => import("../../shared/MonacoEditor.vue"));

const props = defineProps<{ view: QuickViewState }>();
defineEmits<{ (e: "close"): void }>();

const name = computed(() => props.view.name || "");
const language = computed(() => guessLanguageFromPath(name.value));
const isMarkdown = computed(() => isMarkdownFile(name.value));
const markdownPreview = ref(true);
watch(name, () => (markdownPreview.value = true));
const message = computed(() => {
  switch (props.view.status) {
    case "loading":
      return "Loading…";
    case "empty":
      return "Empty file";
    case "binary":
      return "Binary file";
    case "directory":
      return "Folder";
    case "error":
      return props.view.message || "Preview failed";
    default:
      return "Nothing to show";
  }
});
</script>

<style scoped>
.fcq {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
}

.fcq__title {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 2px 4px 2px 8px;
  background: var(--panel);
  color: var(--muted);
}

.fcq__title-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fcq__modes {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}

.fcq__mode {
  padding: 2px 7px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--muted);
  font-size: 10px;
  cursor: pointer;
}

.fcq__mode:hover,
.fcq__mode--active {
  border-color: var(--border);
  color: var(--text);
}

.fcq__close {
  flex: 0 0 auto;
  min-width: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--muted);
  font-size: 15px;
  line-height: 18px;
  cursor: pointer;
}

.fcq__close:hover {
  background: var(--border);
  color: var(--text);
}

.fcq__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  border-top: 1px solid var(--border);
}

.fcq__code {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.fcq__markdown {
  display: block;
  min-height: 100%;
  padding: 12px 14px;
}

.fcq__code--markdown {
  height: auto;
  min-height: 100%;
  overflow: visible;
}

.fcq__code :deep(.monaco-editor-container) {
  border: 0;
  border-radius: 0;
}

.fcq__image {
  display: block;
  max-width: 100%;
  max-height: 100%;
  margin: 0 auto;
  object-fit: contain;
}

.fcq__message {
  margin: 0;
  padding: 14px;
  color: var(--muted);
  text-align: center;
}

.fcq__message--error {
  color: var(--danger);
}

@media (pointer: coarse) {
  .fcq__close {
    min-width: 36px;
    min-height: 32px;
  }
}
</style>
