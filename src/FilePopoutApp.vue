<template>
  <div class="file-popout">
    <header class="file-popout__header">
      <div class="file-popout__title">
        <span class="file-popout__title-text">
          <span v-if="dirty" class="file-popout__dirty" title="Unsaved changes">●</span>{{ payload?.name || "File" }}
        </span>
        <span v-if="payload" class="file-popout__subtitle">{{ payload.relativePath }}</span>
      </div>
      <button type="button" class="file-popout__save" :disabled="!dirty || saving || !payload" @click="save()">
        {{ saving ? "Saving…" : "Save" }}
      </button>
    </header>
    <div v-if="error && payload" class="file-popout__error" role="alert">
      <span>{{ error }}</span>
      <span v-if="conflict" class="file-popout__conflict-actions">
        <button type="button" class="file-popout__save" :disabled="saving" @click="save(true)">Overwrite</button>
        <button type="button" class="file-popout__save" :disabled="saving" @click="dismissConflict">Cancel</button>
      </span>
    </div>
    <main class="file-popout__body">
      <div v-if="loading" class="file-popout__placeholder">Loading file…</div>
      <div v-else-if="error && !payload" class="file-popout__placeholder file-popout__placeholder--error">
        {{ error }}
      </div>
      <MonacoEditor v-else-if="payload" v-model="text" :language="language" auto-focus @save="save()" />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MonacoEditor from "./components/shared/MonacoEditor.vue";
import { guessLanguageFromPath } from "./components/workspace/file-manager/language-map.js";
import { rlog } from "./lib/renderer-log.js";
import { isFileChangedOnDiskError } from "../electron/shared/file-conflict.js";
import type { FilePopoutPayload } from "../electron/shared/ipc-bridge.js";

const payload = ref<FilePopoutPayload | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const text = ref("");
const baseline = ref("");
const startedDirty = ref(false);
const baselineMtimeMs = ref<number | undefined>(undefined);
const conflict = ref(false);

const dirty = computed(() => payload.value !== null && (startedDirty.value || text.value !== baseline.value));
const language = computed(() => guessLanguageFromPath(payload.value?.name ?? ""));

watch(
  [dirty, () => payload.value?.name],
  ([isDirty, name]) => {
    document.title = `${isDirty ? "● " : ""}${name || "File"}`;
  },
  { immediate: true },
);

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}

function dismissConflict(): void {
  conflict.value = false;
  error.value = "";
}

async function save(overwrite = false): Promise<void> {
  const p = payload.value;
  if (!p || saving.value || !dirty.value) return;
  const content = text.value;
  saving.value = true;
  error.value = "";
  conflict.value = false;
  try {
    const expected = overwrite ? undefined : baselineMtimeMs.value;
    const result = (await window.strideterm.fileWrite({
      rootPath: p.rootPath,
      relativePath: p.relativePath,
      content,
      ...(expected !== undefined ? { expectedMtimeMs: expected } : {}),
    })) as { mtimeMs?: number } | undefined;
    baseline.value = content;
    baselineMtimeMs.value = result?.mtimeMs;
    startedDirty.value = false;
  } catch (err) {
    const message = (err as Error)?.message || "Failed to save file.";
    if (isFileChangedOnDiskError(err)) {
      conflict.value = true;
      error.value = `${p.relativePath} changed on disk since you opened it.`;
      rlog("warn", "[renderer] [file-popout] save blocked, file changed on disk", { relativePath: p.relativePath });
    } else {
      error.value = `Save failed: ${message}`;
      rlog("error", "[renderer] [file-popout] save failed", { relativePath: p.relativePath, message });
    }
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  window.addEventListener("beforeunload", onBeforeUnload);
  try {
    const bridge = window.strideterm;
    if (!bridge?.getFilePopoutInit) throw new Error("File popout bridge not available.");
    const data = await bridge.getFilePopoutInit();
    if (!data) throw new Error("No file data found for this window.");
    if (typeof data.content === "string") {
      baseline.value = data.dirty ? "" : data.content;
      text.value = data.content;
      if (data.dirty && data.content === "") baseline.value = "\u0000";
    } else {
      const res = (await bridge.fileRead({ rootPath: data.rootPath, relativePath: data.relativePath })) as {
        content?: string;
        mtimeMs?: number;
      };
      const content = res?.content ?? "";
      baselineMtimeMs.value = res?.mtimeMs;
      baseline.value = content;
      text.value = content;
    }
    payload.value = data;
  } catch (err) {
    const message = (err as Error)?.message || "Failed to load file.";
    error.value = message;
    rlog("error", "[renderer] [file-popout] load failed", { message });
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => window.removeEventListener("beforeunload", onBeforeUnload));
</script>

<style scoped>
.file-popout {
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

.file-popout__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border, rgba(var(--tint), 0.08));
  background: rgba(var(--tint), 0.025);
}

.file-popout__title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.file-popout__title-text {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-popout__dirty {
  color: var(--accent, #ffa424);
  margin-right: 6px;
}

.file-popout__subtitle {
  font-size: 11px;
  color: var(--muted, rgba(255, 255, 255, 0.55));
  font-family: var(--font-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-popout__save {
  flex: 0 0 auto;
  padding: 4px 14px;
  font-size: 12px;
  color: inherit;
  background: rgba(var(--tint), 0.06);
  border: 1px solid var(--border, rgba(var(--tint), 0.15));
  border-radius: 6px;
  cursor: pointer;
}

.file-popout__save:disabled {
  opacity: 0.45;
  cursor: default;
}

.file-popout__error {
  flex: 0 0 auto;
  padding: 6px 14px;
  font-size: 12px;
  color: var(--danger, #ff8585);
  border-bottom: 1px solid var(--border, rgba(var(--tint), 0.08));
}

.file-popout__conflict-actions {
  display: inline-flex;
  gap: 8px;
  margin-left: 12px;
}

.file-popout__body {
  flex: 1 1 0;
  min-height: 0;
  position: relative;
  display: flex;
}

.file-popout__body > :deep(.monaco-editor-container) {
  flex: 1 1 0;
  min-height: 0;
}

.file-popout__placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted, rgba(255, 255, 255, 0.55));
  font-style: italic;
}

.file-popout__placeholder--error {
  color: var(--danger, #ff8585);
}
</style>
