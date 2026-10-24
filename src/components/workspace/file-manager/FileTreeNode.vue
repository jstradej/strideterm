<template>
  <div class="tree-node">
    <div
      class="tree-node__label"
      role="treeitem"
      :tabindex="0"
      :aria-expanded="node.entry.kind === 'directory' ? isExpanded : undefined"
      :class="{
        'tree-node__label--file': node.entry.kind === 'file',
        'tree-node__label--active': isActive,
        'tree-node__label--selected': isSelected,
        'tree-node__label--drop': isDropTarget,
        [`tree-node__label--git-${gitStatus}`]: !!gitStatus,
      }"
      :style="{ paddingLeft: depth * 16 + 6 + 'px' }"
      :title="gitStatus ? statusTitle(gitStatus) : node.entry.relativePath"
      :draggable="true"
      @click="onClick"
      @keydown="onKeydown"
      @contextmenu.prevent="showContextMenu"
      @dragstart="onDragStart"
      @dragover.stop.prevent="onDragOver"
      @dragleave="onDragLeave"
      @drop.stop.prevent="onDrop"
    >
      <span class="tree-node__chevron" :class="{ 'tree-node__chevron--expanded': isExpanded }">
        <svg v-if="node.entry.kind === 'directory'" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m4 2.5 3.5 3.5L4 9.5" />
        </svg>
      </span>
      <span class="tree-node__icon" :class="iconClass">
        <svg v-if="node.entry.kind === 'directory'" viewBox="0 0 18 16" aria-hidden="true">
          <path d="M1.5 3.25h5l1.5 1.5h8.5v8.75H1.5z" />
          <path d="M1.5 4.75V2.5h5l1.5 1.5" />
        </svg>
        <template v-else>{{ fileGlyph }}</template>
      </span>
      <span class="tree-node__name">{{ node.entry.name }}</span>
      <span
        v-if="gitStatus"
        class="tree-node__status"
        :style="{ color: statusColor(gitStatus) }"
        :aria-label="statusLabel(gitStatus)"
      >
        {{ statusBadge(gitStatus) }}
      </span>
    </div>
    <div v-if="isExpanded && visibleChildren.length" class="tree-node__children">
      <FileTreeNode
        v-for="child in visibleChildren"
        :key="child.entry.relativePath"
        :node="child"
        :depth="depth + 1"
        :editor-layout="editorLayout"
        @select-file="emit('select-file', $event)"
        @navigate-directory="emit('navigate-directory', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import { statusBadge, statusColor, statusLabel, statusTitle } from "./git-status-helpers.js";

const props = withDefaults(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineProps<{ node: Record<string, any>; depth?: number; editorLayout?: boolean }>(),
  { depth: 0 },
);
const emit = defineEmits<{
  (event: "select-file", entry: { name: string; relativePath: string; kind: string }): void;
  (event: "navigate-directory", entry: { name: string; relativePath: string; kind: string }): void;
}>();

const store = useFileManagerStore();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmContextMenu = inject<((event: MouseEvent, entry: any) => void) | null>("fm-context-menu", null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmDragState = inject<any>("fm-drag-state", null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmRename = inject<((entry: any) => void) | null>("fm-rename", null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmDelete = inject<((entry: any) => void) | null>("fm-delete", null);

const isDropTarget = ref<boolean>(false);

const isExpanded = computed(() => store.treeNodes.get(props.node.entry.relativePath)?.expanded || false);
const isActive = computed(() => store.currentPath === props.node.entry.relativePath);
const isSelected = computed(() => store.selectedEntry?.relativePath === props.node.entry.relativePath);
const iconClass = computed(() => {
  const ext = String(props.node.entry.extension || "")
    .toLowerCase()
    .replace(".", "");
  return props.node.entry.kind === "directory" ? "tree-node__icon--folder" : `tree-node__icon--${ext || "plain"}`;
});

const children = computed(() => {
  const path = props.node.entry.relativePath;
  const treeNode = store.treeNodes.get(path);
  return treeNode?.children || props.node.children || [];
});

const gitStatus = computed(() => {
  if (!store.gitIsRepo) return null;
  const path = props.node.entry.relativePath;
  // Directory rollup — show status of dirtiest descendant
  return props.node.entry.kind === "directory"
    ? store.getDirectoryStatusFor(path) || null
    : store.getStatusFor(path)?.status || null;
});

const fileGlyph = computed(() => {
  const extension = String(props.node.entry.extension || "").toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".vue"].includes(extension)) return "◈";
  if ([".json", ".yml", ".yaml", ".toml"].includes(extension)) return "{}";
  if ([".md", ".txt"].includes(extension)) return "≡";
  return "·";
});

const visibleChildren = computed(() => {
  const filter = store.filterText.trim().toLowerCase();
  const visible = props.editorLayout
    ? (children.value as Array<{ entry: { name: string; kind: string; relativePath: string } }>)
    : (children.value as Array<{ entry: { name: string; kind: string; relativePath: string } }>).filter(
        (child) => child.entry.kind === "directory",
      );
  return filter
    ? visible.filter((child) => child.entry.kind === "directory" || child.entry.name.toLowerCase().includes(filter))
    : visible;
});

async function toggleAndNavigate() {
  const path = props.node.entry.relativePath;
  if (isExpanded.value) {
    store.collapseTreeNode(path);
  } else {
    await store.expandTreeNode(path);
  }
  if (!props.editorLayout) store.navigate(path);
  else store.currentPath = path;
}

async function onClick() {
  if (props.node.entry.kind === "directory") {
    emit("navigate-directory", props.node.entry);
    await toggleAndNavigate();
    return;
  }
  emit("select-file", props.node.entry);
  if (store.selectedEntry?.relativePath === props.node.entry.relativePath && store.editMode) return;
  if (props.editorLayout) store.currentPath = props.node.entry.relativePath.split("/").slice(0, -1).join("/");
  const selected = await store.selectEntry(props.node.entry);
  if (!selected) return;
}

async function onKeydown(event: KeyboardEvent) {
  const row = event.currentTarget as HTMLElement;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    const rows = [...(row.closest(".file-tree")?.querySelectorAll<HTMLElement>(".tree-node__label") || [])];
    const index = rows.indexOf(row);
    const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    next?.focus();
  } else if (event.key === "ArrowRight" && props.node.entry.kind === "directory" && !isExpanded.value) {
    event.preventDefault();
    event.stopPropagation();
    await toggleAndNavigate();
  } else if (event.key === "ArrowLeft" && props.node.entry.kind === "directory" && isExpanded.value) {
    event.preventDefault();
    event.stopPropagation();
    store.collapseTreeNode(props.node.entry.relativePath);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    await onClick();
  } else if (event.key === "F2") {
    event.preventDefault();
    event.stopPropagation();
    fmRename?.(props.node.entry);
  } else if (event.key === "Delete") {
    event.preventDefault();
    event.stopPropagation();
    fmDelete?.(props.node.entry);
  }
}

function showContextMenu(event: MouseEvent) {
  if (fmContextMenu) fmContextMenu(event, props.node.entry);
}

function onDragStart(event: DragEvent) {
  if (fmDragState) fmDragState.value = props.node.entry;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", props.node.entry.relativePath);
  }
}

function onDragOver(event: DragEvent) {
  if (props.node.entry.kind !== "directory") return;
  if (!fmDragState?.value) return;
  if (fmDragState.value.relativePath === props.node.entry.relativePath) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  isDropTarget.value = true;
}

function onDragLeave() {
  isDropTarget.value = false;
}

async function onDrop() {
  if (props.node.entry.kind !== "directory") return;
  isDropTarget.value = false;
  const dragged = fmDragState?.value;
  if (!dragged) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await store.moveEntryTo(dragged as any, props.node.entry.relativePath);
  if (fmDragState) fmDragState.value = null;
}
</script>

<style scoped>
.tree-node__label {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 1px 8px 1px 5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 3px;
  margin: 0 2px;
  position: relative;
}

.tree-node__label:hover {
  background: color-mix(in srgb, var(--text), transparent 94%);
}

.tree-node__label--active {
  background: color-mix(in srgb, var(--accent), transparent 88%);
}

.tree-node__label--selected {
  background: rgba(255, 164, 36, 0.08);
}

.tree-node__label--drop {
  outline: 1px dashed var(--accent);
  background: rgba(255, 164, 36, 0.16);
}

.tree-node__label--git-ignored {
  opacity: 0.55;
}

.tree-node__chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 12px;
  height: 14px;
  color: var(--muted);
}

.tree-node__chevron svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 120ms ease;
}

.tree-node__chevron--expanded svg {
  transform: rotate(90deg);
}

.tree-node__icon {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  width: 14px;
  height: 16px;
  flex: 0 0 14px;
  font-size: 12px;
  line-height: 1;
  color: var(--muted);
}

.tree-node__icon--folder svg {
  width: 15px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.tree-node__icon--folder {
  color: #d3a95f;
  font-size: 17px;
}

.tree-node__icon--ts,
.tree-node__icon--tsx,
.tree-node__icon--js,
.tree-node__icon--jsx,
.tree-node__icon--vue {
  color: #69a7dd;
}

.tree-node__icon--json,
.tree-node__icon--yml,
.tree-node__icon--yaml,
.tree-node__icon--toml {
  color: #d8a14b;
}

.tree-node__icon--md,
.tree-node__icon--txt {
  color: #8da4bd;
}

.tree-node__icon--css,
.tree-node__icon--scss,
.tree-node__icon--html {
  color: #c87ac2;
}

.tree-node__name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-node__status {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
}
</style>
