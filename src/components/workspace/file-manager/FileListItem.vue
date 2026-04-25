<template>
  <div
    :class="[
      'fli',
      selected && 'fli--selected',
      viewMode === 'grid' ? 'fli--grid' : 'fli--list',
      gitStatus && `fli--git-${gitStatus}`,
      isDropTarget && 'fli--drop',
    ]"
    :title="gitStatus ? statusTitle(gitStatus) : entry.name"
    draggable="true"
    @click="$emit('click', $event)"
    @dblclick="$emit('dblclick', $event)"
    @contextmenu="$emit('contextmenu', $event)"
    @dragstart="onDragStart"
    @dragover.prevent="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <template v-if="viewMode === 'list'">
      <span class="fli__col fli__col--name">
        <span class="fli__icon">{{ icon }}</span>
        <span class="fli__fname">{{ entry.name }}</span>
        <span
          v-if="gitStatus"
          class="fli__status-dot"
          :style="{ background: statusColor(gitStatus) }"
          :aria-label="statusLabel(gitStatus)"
        ></span>
      </span>
      <span class="fli__col fli__col--size">{{ entry.kind === "directory" ? "" : formatSize(entry.size) }}</span>
      <span class="fli__col fli__col--modified">{{ formatDate(entry.modifiedAt) }}</span>
      <span class="fli__col fli__col--type">
        <span v-if="gitStatus" class="fli__status-badge" :style="{ color: statusColor(gitStatus) }">
          {{ statusBadge(gitStatus) }}
        </span>
        {{ entry.kind === "directory" ? "folder" : entry.extension || "file" }}
      </span>
    </template>
    <template v-else>
      <span class="fli__grid-icon">
        {{ icon }}
        <span v-if="gitStatus" class="fli__grid-status" :style="{ background: statusColor(gitStatus), color: '#fff' }">
          {{ statusBadge(gitStatus) }}
        </span>
      </span>
      <span class="fli__grid-name">{{ entry.name }}</span>
    </template>
  </div>
</template>

<script setup>
import { computed, inject, ref } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import { statusBadge, statusColor, statusLabel, statusTitle } from "./git-status-helpers.js";

const props = defineProps({
  entry: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  viewMode: { type: String, default: "list" },
});

defineEmits(["click", "dblclick", "contextmenu"]);

const store = useFileManagerStore();
const fmDragState = inject("fm-drag-state", null);
const isDropTarget = ref(false);

const FOLDER_ICONS = {
  node_modules: "📦",
  ".git": "🔒",
  src: "📁",
  dist: "📤",
  build: "📤",
};
const EXT_ICONS = {
  ".js": "⬢",
  ".mjs": "⬢",
  ".ts": "◇",
  ".vue": "◈",
  ".json": "{ }",
  ".md": "❖",
  ".css": "◎",
  ".html": "◆",
  ".py": "◉",
  ".go": "◈",
  ".rs": "⬣",
  ".java": "◆",
  ".sh": "$_",
  ".yml": "⚙",
  ".yaml": "⚙",
  ".png": "▣",
  ".jpg": "▣",
  ".jpeg": "▣",
  ".gif": "▣",
  ".svg": "▣",
  ".lock": "🔒",
};

const icon = computed(() => {
  if (props.entry.kind === "directory") {
    return FOLDER_ICONS[props.entry.name] || "📁";
  }
  return EXT_ICONS[props.entry.extension] || "📄";
});

const gitStatus = computed(() => {
  if (!store.gitIsRepo) return null;
  const rel = props.entry.relativePath;
  if (props.entry.kind === "directory") {
    return store.getDirectoryStatusFor(rel) || null;
  }
  return store.getStatusFor(rel)?.status || null;
});

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${mins}`;
}

function onDragStart(event) {
  if (fmDragState) fmDragState.value = props.entry;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", props.entry.relativePath);
}

function onDragOver(event) {
  if (!fmDragState?.value) return;
  if (props.entry.kind !== "directory") return;
  if (fmDragState.value.relativePath === props.entry.relativePath) return;
  event.dataTransfer.dropEffect = "move";
  isDropTarget.value = true;
}

function onDragLeave() {
  isDropTarget.value = false;
}

async function onDrop() {
  isDropTarget.value = false;
  const dragged = fmDragState?.value;
  if (!dragged) return;
  if (props.entry.kind !== "directory") return;
  await store.moveEntryTo(dragged, props.entry.relativePath);
  if (fmDragState) fmDragState.value = null;
}
</script>

<style scoped>
/* List mode */
.fli--list {
  display: grid;
  grid-template-columns: 1fr 80px 120px 90px;
  gap: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  align-items: center;
  position: relative;
}

.fli--list:hover {
  background: var(--border);
}

.fli--selected {
  background: rgba(255, 164, 36, 0.1) !important;
}

.fli--drop {
  outline: 1px dashed var(--accent);
  outline-offset: -1px;
  background: rgba(255, 164, 36, 0.16);
}

.fli--list.fli--git-modified::before,
.fli--list.fli--git-staged::before,
.fli--list.fli--git-untracked::before,
.fli--list.fli--git-conflict::before {
  content: "";
  position: absolute;
  left: 0;
  top: 2px;
  bottom: 2px;
  width: 3px;
  border-radius: 2px;
}
.fli--list.fli--git-modified::before {
  background: var(--fm-status-modified, #d8a14b);
}
.fli--list.fli--git-staged::before {
  background: var(--fm-status-staged, #6cb478);
}
.fli--list.fli--git-untracked::before {
  background: var(--fm-status-untracked, #5e9bd6);
}
.fli--list.fli--git-conflict::before {
  background: var(--fm-status-conflict, #e26b6b);
}

.fli--git-ignored {
  opacity: 0.5;
}

.fli__col--name {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}

.fli__icon {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-size: 11px;
}

.fli__fname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fli__status-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.fli__col--size,
.fli__col--modified,
.fli__col--type {
  text-align: right;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}

.fli__status-badge {
  font-weight: 700;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.06);
  margin-right: 4px;
}

/* Grid mode */
.fli--grid {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 90px;
  height: 70px;
  border-radius: 6px;
  cursor: pointer;
  text-align: center;
  gap: 4px;
  position: relative;
}

.fli--grid:hover {
  background: var(--border);
}

.fli--grid.fli--selected {
  background: rgba(255, 164, 36, 0.1);
}

.fli__grid-icon {
  font-size: 22px;
  position: relative;
}

.fli__grid-status {
  position: absolute;
  top: -4px;
  right: -10px;
  font-size: 9px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 8px;
  line-height: 1.4;
}

.fli__grid-name {
  font-size: 10px;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
