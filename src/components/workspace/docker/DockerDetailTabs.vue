<template>
  <div class="detail-tabs" role="tablist" aria-label="Open containers">
    <button
      v-for="tab in tabs"
      :key="tab.tabId"
      :class="['detail-tab', tab.tabId === activeTabId && 'detail-tab--active', tab.removed && 'detail-tab--removed']"
      role="tab"
      :aria-selected="tab.tabId === activeTabId"
      type="button"
      @click="emit('activate', tab.tabId)"
    >
      <span class="detail-tab__icon">{{ iconFor(tab.kind) }}</span>
      <span class="detail-tab__label">{{ tab.label }}</span>
      <span class="detail-tab__close" title="Close tab" @click.stop="emit('close', tab.tabId)">×</span>
    </button>
    <div v-if="tabs.length === 0" class="detail-tabs__empty">Click a container in the tree to open it</div>
  </div>
</template>

<script setup lang="ts">
import type { OpenTab, TabKind } from "../../../stores/docker-detail.js";

defineProps<{
  tabs: OpenTab[];
  activeTabId: string | null;
}>();

const emit = defineEmits<{
  activate: [tabId: string];
  close: [tabId: string];
}>();

function iconFor(kind: TabKind): string {
  if (kind === "project") return "▣";
  if (kind === "images-list") return "▦";
  if (kind === "volumes-list") return "▤";
  if (kind === "networks-list") return "◇";
  return "●";
}
</script>

<style scoped>
.detail-tabs {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  min-height: 34px;
  flex-shrink: 0;
  scrollbar-width: none;
  background: var(--bg-secondary, rgba(0, 0, 0, 0.15));
}
.detail-tabs::-webkit-scrollbar {
  display: none;
}

.detail-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--text-dim, #888);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  border-right: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  min-width: 0;
  max-width: 180px;
  outline: none;
  flex-shrink: 0;
}
.detail-tab:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.05));
  color: var(--text-primary, #e2e8f0);
}
.detail-tab:focus-visible {
  outline: 1px solid var(--accent, #63b3ed);
  outline-offset: -1px;
}

.detail-tab--active {
  background: var(--bg-primary, rgba(255, 255, 255, 0.04));
  color: var(--text-primary, #e2e8f0);
  border-bottom: 2px solid var(--accent, #63b3ed);
}

.detail-tab--removed {
  opacity: 0.6;
  font-style: italic;
}

.detail-tab__icon {
  font-size: 8px;
  flex-shrink: 0;
}

.detail-tab__label {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.detail-tab__close {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1;
  opacity: 0.5;
}
.detail-tab__close:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
}

.detail-tabs__empty {
  display: flex;
  align-items: center;
  padding: 0 14px;
  font-size: 12px;
  color: var(--text-dim, #888);
  font-style: italic;
}
</style>
