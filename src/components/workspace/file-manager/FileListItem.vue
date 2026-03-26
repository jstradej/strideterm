<template>
  <div
    :class="[
      'fli',
      selected && 'fli--selected',
      viewMode === 'grid' ? 'fli--grid' : 'fli--list',
    ]"
    @click="$emit('click', $event)"
    @dblclick="$emit('dblclick', $event)"
    @contextmenu="$emit('contextmenu', $event)"
  >
    <template v-if="viewMode === 'list'">
      <span class="fli__col fli__col--name">
        <span class="fli__icon">{{ icon }}</span>
        <span class="fli__fname">{{ entry.name }}</span>
      </span>
      <span class="fli__col fli__col--size">{{ entry.kind === 'directory' ? '' : formatSize(entry.size) }}</span>
      <span class="fli__col fli__col--modified">{{ formatDate(entry.modifiedAt) }}</span>
      <span class="fli__col fli__col--type">{{ entry.kind === 'directory' ? 'folder' : entry.extension || 'file' }}</span>
    </template>
    <template v-else>
      <span class="fli__grid-icon">{{ icon }}</span>
      <span class="fli__grid-name">{{ entry.name }}</span>
    </template>
  </div>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
  entry: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  viewMode: { type: String, default: "list" },
});

defineEmits(["click", "dblclick", "contextmenu"]);

const FOLDER_ICONS = { "node_modules": "\ud83d\udce6", ".git": "\ud83d\udd12", "src": "\ud83d\udcc1", "dist": "\ud83d\udce4", "build": "\ud83d\udce4" };
const EXT_ICONS = {
  ".js": "\u2b22", ".mjs": "\u2b22", ".ts": "\u25c7", ".vue": "\u25c8", ".json": "{ }",
  ".md": "\u2756", ".css": "\u25ce", ".html": "\u25c6", ".py": "\u25c9", ".go": "\u25c8",
  ".rs": "\u2b23", ".java": "\u25c6", ".sh": "$_", ".yml": "\u2699", ".yaml": "\u2699",
  ".png": "\u25a3", ".jpg": "\u25a3", ".jpeg": "\u25a3", ".gif": "\u25a3", ".svg": "\u25a3",
  ".lock": "\ud83d\udd12",
};

const icon = computed(() => {
  if (props.entry.kind === "directory") {
    return FOLDER_ICONS[props.entry.name] || "\ud83d\udcc1";
  }
  return EXT_ICONS[props.entry.extension] || "\ud83d\udcc4";
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
</script>

<style scoped>
/* List mode */
.fli--list {
  display: grid;
  grid-template-columns: 1fr 80px 120px 70px;
  gap: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  align-items: center;
}

.fli--list:hover {
  background: var(--border);
}

.fli--selected {
  background: rgba(255, 164, 36, 0.1) !important;
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

.fli__col--size,
.fli__col--modified,
.fli__col--type {
  text-align: right;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
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
}

.fli--grid:hover {
  background: var(--border);
}

.fli--grid.fli--selected {
  background: rgba(255, 164, 36, 0.1);
}

.fli__grid-icon {
  font-size: 22px;
}

.fli__grid-name {
  font-size: 10px;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
