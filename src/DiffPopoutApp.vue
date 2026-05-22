<template>
  <div class="diff-popout">
    <header class="diff-popout__header">
      <div class="diff-popout__title">
        <span class="diff-popout__title-text">{{ title }}</span>
        <span v-if="subtitle" class="diff-popout__subtitle">{{ subtitle }}</span>
      </div>
    </header>
    <main class="diff-popout__body">
      <div v-if="loading" class="diff-popout__placeholder">Loading diff…</div>
      <div v-else-if="error" class="diff-popout__placeholder diff-popout__placeholder--error">{{ error }}</div>
      <MonacoDiffPanel v-else-if="payload" :payload="payload" />
      <div v-else class="diff-popout__placeholder">No diff payload available.</div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import MonacoDiffPanel from "./components/shared/MonacoDiffPanel.vue";

interface DiffPopoutPayload {
  title?: string;
  filePath?: string;
  leftLabel?: string;
  rightLabel?: string;
  leftContent?: string;
  rightContent?: string;
  language?: string;
  leftMissing?: boolean;
  rightMissing?: boolean;
  ok?: boolean;
  leftError?: string;
  [key: string]: unknown;
}

const payload = ref<DiffPopoutPayload | null>(null);
const loading = ref(true);
const error = ref("");

const title = computed(() => {
  if (payload.value?.title) return payload.value.title;
  if (payload.value?.filePath) return payload.value.filePath as string;
  return "Diff";
});

// Show "OLD label → NEW label" under the title so the user knows which two
// versions of the file are being compared without rummaging in the toolbar.
const subtitle = computed(() => {
  const left = payload.value?.leftLabel || "";
  const right = payload.value?.rightLabel || "";
  if (!left && !right) return "";
  return `${left || "(empty)"} → ${right || "(empty)"}`;
});

onMounted(async () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (window as any).strideterm;
    if (!bridge?.getDiffPopoutInit) {
      error.value = "Diff popout bridge not available.";
      loading.value = false;
      return;
    }
    const data = (await bridge.getDiffPopoutInit()) as DiffPopoutPayload | null;
    if (!data) {
      error.value = "No diff data found for this window.";
    } else {
      payload.value = data;
      if (data.title || data.filePath) {
        document.title = String(data.title || data.filePath);
      }
    }
  } catch (err) {
    error.value = (err as Error)?.message || "Failed to load diff.";
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.diff-popout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--surface, #1d2026);
  color: var(--text, #e8e8e8);
  font-family:
    system-ui,
    -apple-system,
    "Segoe UI",
    Roboto,
    "Helvetica Neue",
    Arial,
    sans-serif;
}

.diff-popout__header {
  flex: 0 0 auto;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  background: rgba(255, 255, 255, 0.025);
}

.diff-popout__title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.diff-popout__title-text {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diff-popout__subtitle {
  font-size: 11px;
  color: var(--muted, rgba(255, 255, 255, 0.55));
  font-family: var(--font-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diff-popout__body {
  flex: 1 1 0;
  min-height: 0;
  position: relative;
  display: flex;
}

.diff-popout__body > :deep(.mdp) {
  flex: 1 1 0;
  min-height: 0;
}

.diff-popout__placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted, rgba(255, 255, 255, 0.55));
  font-style: italic;
}

.diff-popout__placeholder--error {
  color: var(--danger, #ff8585);
}
</style>
