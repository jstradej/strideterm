<template>
  <section class="fcq">
    <div class="fcq__title">
      <span class="fcq__title-text" :title="view.title">{{ view.title }}</span>
      <button type="button" class="fcq__close" aria-label="Close compare" title="Close (Esc)" @click="$emit('close')">
        ×
      </button>
    </div>
    <div class="fcq__body">
      <p v-if="view.status === 'loading'" class="fcq__message">Loading…</p>
      <MonacoDiffPanel v-else :payload="view.payload" hide-labels initial-inline />
    </div>
  </section>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import type { CompareViewState } from "./commander-helpers.js";

const MonacoDiffPanel = defineAsyncComponent(() => import("../../shared/MonacoDiffPanel.vue"));

defineProps<{ view: CompareViewState }>();
defineEmits<{ (e: "close"): void }>();
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
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--border);
}

.fcq__message {
  margin: 0;
  padding: 14px;
  color: var(--muted);
  text-align: center;
}

@media (pointer: coarse) {
  .fcq__close {
    min-width: 36px;
    min-height: 32px;
  }
}
</style>
