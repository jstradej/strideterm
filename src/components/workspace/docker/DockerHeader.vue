<template>
  <header class="docker-header">
    <div class="docker-header__title">
      <span class="docker-header__label">Docker</span>
      <span v-if="summary" class="docker-header__summary">{{ summary }}</span>
    </div>
    <DockerDiskUsage class="docker-header__df" @open="(k) => emit('open-list', k)" />
    <div class="docker-header__actions">
      <button
        type="button"
        :class="['button', 'button--ghost', 'button--icon', refreshing && 'button--busy']"
        :disabled="refreshing"
        title="Refresh Docker (re-probe backends and re-fetch containers)"
        @click="handleRefresh"
      >
        ↻
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ref } from "vue";
import DockerDiskUsage from "./DockerDiskUsage.vue";
import { useAppStore } from "../../../stores/app.js";

defineProps<{
  summary: string;
}>();

const emit = defineEmits<{
  /** Bubbled from DockerDiskUsage so DockerPane can route to the right
   * (backend, context) tuple. */
  "open-list": [kind: "images" | "volumes" | "networks" | "cache"];
}>();

const appStore = useAppStore();
const refreshing = ref(false);

async function handleRefresh(): Promise<void> {
  refreshing.value = true;
  try {
    await appStore.refreshDocker();
  } finally {
    refreshing.value = false;
  }
}
</script>

<style scoped>
.docker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  flex-shrink: 0;
  /* Match the disk-usage component's reserved height so the header itself
     doesn't pop in size when async df data lands. */
  min-height: 76px;
}

@media (max-width: 480px) {
  .docker-header {
    padding: 6px 8px;
    flex-wrap: wrap;
    gap: 6px;
  }
  .docker-header__title {
    flex: 1 1 auto;
    min-width: 0;
  }
  .docker-header__summary {
    font-size: 11px;
  }
}

.docker-header__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-shrink: 0;
  white-space: nowrap;
}

.docker-header__label {
  font-size: 13px;
  font-weight: 600;
}

.docker-header__summary {
  font-size: 12px;
  color: var(--text-dim, #888);
  white-space: nowrap;
}

.docker-header__df {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0 8px;
}

.docker-header__actions {
  flex-shrink: 0;
}

@media (max-width: 600px) {
  .docker-header__df {
    flex: 1 1 100%;
    order: 3;
    margin: 4px 0 0 0;
  }
  .docker-header {
    min-height: auto;
  }
}

.docker-header__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.button--sm {
  font-size: 12px;
  padding: 2px 8px;
}

.button--icon {
  width: 26px;
  height: 26px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
</style>
