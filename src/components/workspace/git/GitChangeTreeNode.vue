<template>
  <li class="gct-node" role="treeitem" :aria-expanded="isDir ? (expanded ? 'true' : 'false') : undefined">
    <div
      :class="[
        'gct-node__row',
        grouped && 'gct-node__row--grouped',
        isDir && 'gct-node__row--folder',
        stagingEnabled && node.kind === 'file' && 'gct-node__row--staging',
        node.kind === 'file' && isSelected && 'gct-node__row--selected',
        node.kind === 'file' && `gct-node__row--git-${node.status}`,
        node.kind === 'file' && node.scope === 'review' && node.code === 'D' && 'gct-node__row--review-deleted',
      ]"
      :style="{ paddingLeft: depth * (grouped ? 10 : 14) + 6 + 'px' }"
      :title="node.kind === 'file' ? `${node.statusTitle || statusTitle(node.status)}: ${node.path}` : node.path"
      :tabindex="isKeyboardTarget ? 0 : undefined"
      @click="onClick"
      @keydown.enter="onRowKeydown"
      @keydown.space="onRowKeydown"
      @contextmenu="contextMenuEnabled && onContextMenu($event)"
    >
      <span v-if="isDir" class="gct-node__chevron">{{ expanded ? "▾" : "▸" }}</span>
      <span v-else class="gct-node__chevron gct-node__chevron--leaf"></span>
      <label v-if="selectable && node.kind === 'file'" class="gct-node__check-target" @click.stop>
        <input
          type="checkbox"
          class="gct-node__check"
          :checked="isChecked"
          :aria-label="`Select ${node.path} for commit and stash`"
          @change="$emit('toggle-select', node.path)"
        />
      </label>
      <span class="gct-node__icon" aria-hidden="true">{{ isDir ? "📁" : "📄" }}</span>
      <span v-if="node.previousPath" class="gct-node__rename" :title="`${node.previousPath} → ${node.path}`"
        >{{ node.previousPath }} →</span
      >
      <span v-if="node.namePrefix" class="gct-node__prefix">{{ node.namePrefix }}</span>
      <span class="gct-node__name">{{ node.name }}</span>
      <span v-if="grouped && node.kind === 'file'" class="gct-node__scopes">
        <button
          v-for="entry in visibleScopes"
          :key="entry.scope"
          type="button"
          class="gct-node__scope"
          :class="{ 'gct-node__scope--active': selectedPath === node.path && selectedScope === entry.scope }"
          :aria-label="`Open ${node.path} ${entry.scope} diff`"
          :title="`${node.path} · ${entry.scope === 'staged' ? 'HEAD to index' : entry.scope === 'unstaged' ? 'HEAD to working tree' : 'Untracked file'}`"
          @click.stop="$emit('select', { ...node, scope: entry.scope })"
        >
          {{ entry.scope === "staged" ? "Idx" : entry.scope === "unstaged" ? "WT" : "New" }}
        </button>
      </span>
      <span
        v-if="node.kind === 'file' && stagingEnabled"
        class="gct-node__actions"
        :class="{ 'gct-node__actions--grouped': grouped }"
      >
        <span
          v-if="node.code"
          class="gct-node__code"
          :style="{ color: node.codeColor || statusColor(node.status) }"
          :title="node.statusTitle || statusTitle(node.status)"
        >
          {{ node.code }}
        </span>
        <template
          v-for="entry in visibleScopes.filter((item: ScopeEntry) => item.scope !== 'conflict')"
          :key="entry.scope"
        >
          <button
            type="button"
            class="gct-node__stage"
            :disabled="stagingBusy"
            :aria-label="`${entry.scope === 'staged' ? 'Unstage' : 'Stage'} ${node.path} ${entry.scope}`"
            @click.stop="$emit('stage-file', { path: node.path, staged: entry.scope === 'staged', scope: entry.scope })"
          >
            {{ entry.scope === "staged" ? "Unstage" : "Stage" }}
          </button>
        </template>
        <span
          v-if="!visibleScopes.some((item: ScopeEntry) => item.scope !== 'conflict')"
          class="gct-node__stage-spacer"
          aria-hidden="true"
        ></span>
      </span>
      <span
        v-else-if="node.kind === 'file' && node.code"
        class="gct-node__code"
        :style="{ color: node.codeColor || statusColor(node.status) }"
        :title="node.statusTitle || statusTitle(node.status)"
      >
        {{ node.code }}
      </span>
      <span v-if="grouped && isDir" class="gct-node__count">{{ node.fileCount }}</span>
    </div>
    <ul v-if="isDir && expanded && node.children.length" class="gct-node__children">
      <GitChangeTreeNode
        v-for="(child, idx) in node.children"
        :key="child.path + ':' + idx"
        :node="child"
        :depth="depth + 1"
        :selected-path="selectedPath"
        :selected-scope="selectedScope"
        :expanded-set="expandedSet"
        :selectable="selectable"
        :context-menu-enabled="contextMenuEnabled"
        :selected-set="selectedSet"
        :grouped="grouped"
        :scope-filter="scopeFilter"
        :staging-enabled="stagingEnabled"
        :staging-busy="stagingBusy"
        @toggle="(p) => $emit('toggle', p)"
        @select="(file) => $emit('select', file)"
        @toggle-select="(p) => $emit('toggle-select', p)"
        @context-menu="(p) => $emit('context-menu', p)"
        @stage-file="(p) => $emit('stage-file', p)"
      />
    </ul>
  </li>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { statusColor, statusTitle } from "../file-manager/git-status-helpers.js";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: Record<string, any>;
    depth?: number;
    selectedPath?: string;
    selectedScope?: string;
    expandedSet: Set<string>;
    selectable?: boolean;
    contextMenuEnabled?: boolean;
    selectedSet?: Set<string>;
    grouped?: boolean;
    scopeFilter?: string;
    stagingEnabled?: boolean;
    stagingBusy?: boolean;
  }>(),
  {
    depth: 0,
    selectedPath: "",
    selectedScope: "",
    selectable: false,
    contextMenuEnabled: true,
    selectedSet: () => new Set<string>(),
    grouped: false,
    scopeFilter: "all",
    stagingEnabled: false,
    stagingBusy: false,
  },
);

const emit = defineEmits<{
  (e: "toggle", path: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (e: "select", node: Record<string, any>): void;
  (e: "toggle-select", path: string): void;
  (e: "context-menu", payload: { path: string; name: string; kind: "file" | "dir"; x: number; y: number }): void;
  (e: "stage-file", payload: { path: string; staged: boolean; scope: string }): void;
}>();

interface ScopeEntry {
  scope: string;
}

const isDir = computed(() => props.node.kind === "dir");
const expanded = computed(() => props.expandedSet.has(props.node.path as string));
const isSelected = computed(
  () =>
    props.node.kind === "file" &&
    props.selectedPath === props.node.path &&
    (props.node.scopes || [{ scope: props.node.scope }]).some(
      (entry: Record<string, unknown>) => entry.scope === props.selectedScope,
    ),
);
const isChecked = computed(() => props.node.kind === "file" && !!props.selectedSet?.has(props.node.path as string));
const visibleScopes = computed(() => {
  const scopes = props.node.scopes || [{ scope: props.node.scope }];
  return props.scopeFilter === "all"
    ? scopes
    : scopes.filter((entry: Record<string, unknown>) => entry.scope === props.scopeFilter);
});
const isKeyboardTarget = computed(() => isDir.value || props.node.kind === "file");

function onClick() {
  if (isDir.value) emit("toggle", props.node.path as string);
  else emit("select", props.node);
}

function onRowKeydown(event: KeyboardEvent) {
  if (event.target !== event.currentTarget) return;
  event.preventDefault();
  onClick();
}

function onContextMenu(e: MouseEvent) {
  // Directories in this tree are synthetic groupings, but their path maps to
  // a real directory on disk, so delete / add-to-.gitignore work on them too.
  e.preventDefault();
  emit("context-menu", {
    path: props.node.path as string,
    name: props.node.name as string,
    kind: props.node.kind === "dir" ? "dir" : "file",
    x: e.clientX,
    y: e.clientY,
  });
}
</script>

<style scoped>
.gct-node {
  list-style: none;
}

.gct-node__row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 2px 6px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 3px;
  margin: 0 2px;
  position: relative;
}

.gct-node__row:hover {
  background: var(--border);
}

.gct-node__stage {
  flex: 0 0 50px;
  width: 50px;
  box-sizing: border-box;
  text-align: center;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 5px;
  color: var(--muted);
  background: var(--surface, var(--panel));
  font-size: 10px;
  cursor: pointer;
}

.gct-node__actions {
  display: flex;
  flex: 0 0 76px;
  width: 76px;
  align-items: center;
  gap: 0;
  margin-left: auto;
}

.gct-node__actions--grouped {
  flex-basis: 126px;
  width: 126px;
}

.gct-node__stage-spacer {
  flex: 0 0 50px;
}

.gct-node__row--selected {
  background: rgba(255, 164, 36, 0.16);
  color: var(--accent);
}

.gct-node__row--git-modified {
  border-left: 3px solid var(--fm-status-modified, #d8a14b);
  padding-left: 3px;
}
.gct-node__row--git-staged {
  border-left: 3px solid var(--fm-status-staged, #6cb478);
  padding-left: 3px;
}
.gct-node__row--git-untracked {
  border-left: 3px solid var(--fm-status-untracked, #5e9bd6);
  padding-left: 3px;
}
.gct-node__row--git-conflict {
  border-left: 3px solid var(--fm-status-conflict, #e26b6b);
  padding-left: 3px;
}
.gct-node__row--git-ignored {
  opacity: 0.55;
}
.gct-node__row--review-deleted {
  border-left: 3px solid var(--danger, #e26b6b);
  padding-left: 3px;
}

.gct-node__chevron {
  flex-shrink: 0;
  width: 10px;
  font-size: 10px;
  color: var(--muted);
  text-align: center;
}

.gct-node__chevron--leaf {
  visibility: hidden;
}

.gct-node__check {
  flex-shrink: 0;
  width: auto;
  margin: 0 2px 0 0;
  cursor: pointer;
}

.gct-node__icon {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.85;
}

.gct-node__name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.gct-node__row--staging .gct-node__name {
  flex: 1 1 0;
  min-width: 0;
}

.gct-node__row--staging .gct-node__scopes {
  margin-left: 0;
}

.gct-node__prefix {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
}

.gct-node__scopes {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 3px;
  margin-left: auto;
}

.gct-node__scope {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  min-height: 40px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 10px;
}

.gct-node__scope::before {
  position: absolute;
  inset: 7px 4px;
  content: "";
  border: 1px solid var(--border);
  border-radius: 10px;
  pointer-events: none;
}

.gct-node__scope--active::before {
  border-color: var(--accent);
}

.gct-node__scope--active {
  color: var(--accent);
}

.gct-node__row--grouped {
  min-height: 42px;
  padding-left: 6px;
  gap: 5px;
}

.gct-node__row--grouped {
  padding-left: 2px;
  gap: 4px;
}

.gct-node__row--grouped.gct-node__row--folder {
  min-height: 30px;
}

.gct-node__rename {
  flex: 0 1 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: 10px;
}

.gct-node__count {
  margin-left: auto;
  color: var(--muted);
  font-size: 10px;
}

.gct-node__row--grouped .gct-node__check {
  width: 16px;
  height: 16px;
  margin: 0;
}

.gct-node__check-target {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  cursor: pointer;
}

.gct-node__row--grouped .gct-node__check-target {
  width: 40px;
  height: 40px;
}

.gct-node__row--grouped .gct-node__chevron--leaf,
.gct-node__row--grouped:not(.gct-node__row--folder) .gct-node__icon {
  display: none;
}

.gct-node__code {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  font-variant-numeric: tabular-nums;
}

.gct-node__actions .gct-node__code {
  margin-left: 0;
  flex: 0 0 26px;
  width: 26px;
  box-sizing: border-box;
  text-align: center;
}

.gct-node__children {
  list-style: none;
  padding: 0;
  margin: 0;
}
</style>
