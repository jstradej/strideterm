<template>
  <div class="file-preview">
    <div class="file-preview__header">
      <span class="file-preview__name">
        <span
          v-if="gitStatus"
          class="file-preview__status"
          :style="{ background: statusColor(gitStatus), color: '#fff' }"
          :title="statusTitle(gitStatus)"
        >
          {{ statusBadge(gitStatus) }} {{ statusLabel(gitStatus) }}
        </span>
        {{ entry.name }}
      </span>
      <span class="file-preview__meta">{{ formatSize(entry.size) }} · {{ formatDate(entry.modifiedAt) }}</span>
      <div class="file-preview__actions">
        <button
          v-if="gitStatus && entry?.kind === 'file'"
          type="button"
          class="button button--ghost file-preview__btn"
          title="Open the file's git diff against HEAD (or the configured comparison ref) in a Monaco side-by-side viewer — read-only, lets you inspect the staged and unstaged changes for this file."
          @click="store.openDiff(entry as any)"
        >
          Diff
        </button>
        <button
          v-if="isEditable && !store.editMode"
          type="button"
          class="button button--ghost file-preview__btn"
          title="Switch this file into the inline editor — type changes, then Save to persist or Cancel to discard. The file stays in the preview pane the whole time."
          @click="store.startEdit()"
        >
          Edit
        </button>
        <template v-if="store.editMode">
          <button
            type="button"
            class="button file-preview__btn"
            :disabled="!store.editDirty"
            title="Write the editor's contents back to disk and leave edit mode. Disabled when there are no unsaved changes."
            @click="store.saveEdit()"
          >
            Save
          </button>
          <button
            type="button"
            class="button button--ghost file-preview__btn"
            title="Discard pending edits and return to the read-only preview. Asks for confirmation if unsaved changes exist."
            @click="store.cancelEdit()"
          >
            Cancel
          </button>
        </template>
        <button
          type="button"
          class="button button--ghost file-preview__btn"
          title="Reveal this file in your operating system's file manager (Explorer on Windows, Finder on macOS, the default file browser on Linux) so you can drag it elsewhere or run it externally."
          @click="$emit('open-in-explorer')"
        >
          Reveal
        </button>
      </div>
    </div>

    <div class="file-preview__body" :class="gitStatus ? `file-preview__body--git-${gitStatus}` : ''">
      <!-- Text preview / editor -->
      <template v-if="preview?.kind === 'text'">
        <FileEditor v-if="store.editMode" />
        <pre v-else class="file-preview__text">{{ preview.content }}</pre>
      </template>

      <!-- Image preview -->
      <template v-else-if="preview?.kind === 'image'">
        <!-- eslint-disable-next-line @typescript-eslint/no-explicit-any -->
        <img :src="(preview as any).imageSrc" class="file-preview__image" />
      </template>

      <!-- Binary fallback -->
      <template v-else-if="preview?.kind === 'binary'">
        <div class="file-preview__binary">
          <p>Binary file · {{ formatSize(entry.size) }}</p>
          <button
            type="button"
            class="button button--ghost"
            title="Open this file in your OS's default application for its file type (image viewer, archive tool, PDF reader, etc.) — strIDEterm cannot preview binary content inline."
            @click="$emit('open-in-explorer')"
          >
            Open externally
          </button>
        </div>
      </template>

      <!-- Empty file -->
      <template v-else-if="preview?.kind === 'empty'">
        <FileEditor v-if="store.editMode" />
        <div v-else class="file-preview__binary">
          <p>Empty file</p>
          <button
            v-if="isEditable"
            type="button"
            class="button button--ghost"
            title="Start typing into this empty file — Save when you're ready to write the contents to disk."
            @click="store.startEdit()"
          >
            Edit
          </button>
        </div>
      </template>

      <!-- Error -->
      <template v-else-if="preview?.kind === 'error'">
        <div class="file-preview__binary">
          <p>{{ preview.content }}</p>
        </div>
      </template>

      <!-- Loading -->
      <template v-else>
        <div class="file-preview__binary"><p>Loading preview...</p></div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import FileEditor from "./FileEditor.vue";
import { statusBadge, statusColor, statusLabel, statusTitle } from "./git-status-helpers.js";
import { formatSize } from "./file-format.js";

defineEmits<{ (e: "open-in-explorer"): void }>();

const store = useFileManagerStore();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entry = computed<Record<string, any>>(() => store.selectedEntry || {});
const preview = computed(() => store.preview);

const isEditable = computed(() => {
  const kind = preview.value?.kind;
  return kind === "text" || kind === "empty";
});

const gitStatus = computed(() => {
  if (!store.gitIsRepo) return null;
  const rel = entry.value?.relativePath as string | undefined;
  if (!rel) return null;
  return store.getStatusFor(rel)?.status || null;
});

function formatDate(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
</script>

<style scoped>
.file-preview {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.file-preview__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  font-size: 12px;
}

.file-preview__name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.file-preview__status {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.3px;
}

.file-preview__meta {
  color: var(--muted);
  font-size: 11px;
  flex-shrink: 0;
}

.file-preview__actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.file-preview__btn {
  font-size: 11px !important;
  padding: 2px 8px !important;
}

.file-preview__body {
  flex: 1;
  overflow: auto;
  min-height: 0;
  position: relative;
}

.file-preview__body--git-modified::before,
.file-preview__body--git-staged::before,
.file-preview__body--git-untracked::before,
.file-preview__body--git-conflict::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  pointer-events: none;
}

.file-preview__body--git-modified::before {
  background: var(--fm-status-modified, #d8a14b);
}
.file-preview__body--git-staged::before {
  background: var(--fm-status-staged, #6cb478);
}
.file-preview__body--git-untracked::before {
  background: var(--fm-status-untracked, #5e9bd6);
}
.file-preview__body--git-conflict::before {
  background: var(--fm-status-conflict, #e26b6b);
}

.file-preview__text {
  margin: 0;
  padding: 8px 12px;
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  tab-size: 2;
  color: var(--text);
}

.file-preview__image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  margin: 8px auto;
}

.file-preview__binary {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
}

.file-preview__binary p {
  margin: 0;
}
</style>
