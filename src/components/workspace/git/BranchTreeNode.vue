<template>
  <li :class="['branch-node', `branch-node--${node.kind}`]">
    <div
      :class="[
        'branch-node__row',
        isSelected && 'branch-node__row--selected',
        node.isCurrent && 'branch-node__row--current',
      ]"
      role="treeitem"
      :aria-expanded="hasChildren ? !!expanded[node.key] : undefined"
      :aria-selected="isLeaf ? isSelected : undefined"
      :style="{ paddingLeft: `${depth * 12 + 6}px` }"
      tabindex="0"
      :title="rowTitle"
      @click="onRowClick"
      @dblclick="onRowDoubleClick"
      @keydown="onKeyDown"
      @contextmenu.prevent="openMenu"
    >
      <span
        v-if="hasChildren"
        class="branch-node__toggle"
        :aria-label="expanded[node.key] ? 'Collapse' : 'Expand'"
        @click.stop="emit('toggle', node.key)"
        >{{ expanded[node.key] ? "▾" : "▸" }}</span
      >
      <span v-else class="branch-node__toggle branch-node__toggle--leaf" />

      <span :class="['branch-node__icon', `branch-node__icon--${iconKind}`]">{{ iconChar }}</span>

      <span class="branch-node__label" :class="{ 'branch-node__label--current': node.isCurrent }">{{
        node.label || "(root)"
      }}</span>

      <span v-if="!compact && upstreamSpan" class="branch-node__upstream" :title="`Tracks ${upstreamSpan}`">
        ↪ {{ upstreamSpan }}
      </span>

      <span v-if="!compact && aheadBehindBadge" :class="['branch-node__badge', aheadBehindBadge.class]">{{
        aheadBehindBadge.label
      }}</span>

      <span
        v-if="!compact && node.meta?.merged && node.kind === 'branch-local' && !node.isCurrent"
        class="branch-node__pill branch-node__pill--merged"
        >merged</span
      >

      <span
        v-if="!compact && node.meta?.isDefault && node.kind === 'branch-remote'"
        class="branch-node__pill branch-node__pill--default"
        title="This is the default branch for the remote (origin/HEAD points here)."
        >default</span
      >

      <span
        v-if="!compact && node.kind === 'section' && node.meta?.count != null"
        class="branch-node__count"
        :title="`${node.meta.count} item(s)`"
        >{{ node.meta.count }}</span
      >

      <span class="branch-node__spacer" />

      <span v-if="!compact && node.meta?.lastRelativeDate" class="branch-node__last">{{
        node.meta.lastRelativeDate
      }}</span>
    </div>

    <ul v-if="hasChildren && expanded[node.key]" role="group" class="branch-node__children">
      <BranchTreeNode
        v-for="child in node.children"
        :key="child.key"
        :node="child"
        :depth="depth + 1"
        :selected-ref="selectedRef"
        :head="head"
        :busy="busy"
        :is-dirty="isDirty"
        :expanded="expanded"
        :compact="compact"
        :can-create-pr="canCreatePr"
        @select="(ref) => emit('select', ref)"
        @toggle="(k) => emit('toggle', k)"
        @checkout="(ref) => emit('checkout', ref)"
        @checkout-remote="(ref) => emit('checkout-remote', ref)"
        @new-from="(ref) => emit('new-from', ref)"
        @rename="(ref) => emit('rename', ref)"
        @delete="(ref) => emit('delete', ref)"
        @delete-remote="(ref) => emit('delete-remote', ref)"
        @merge="(ref) => emit('merge', ref)"
        @rebase="(ref) => emit('rebase', ref)"
        @create-pr="(ref) => emit('create-pr', ref)"
      />
    </ul>

    <!-- Lightweight inline context menu (popover). Closes on outside click. -->
    <div v-if="menuOpen" ref="menuRef" class="branch-node__menu" role="menu" @click.stop>
      <template v-for="action in actions" :key="action.id">
        <button
          v-if="action.divider !== true"
          type="button"
          role="menuitem"
          :disabled="!!action.disabled"
          class="branch-node__menu-item"
          :class="action.danger && 'branch-node__menu-item--danger'"
          @click="runAction(action.id)"
        >
          {{ action.label }}
        </button>
        <hr v-else class="branch-node__menu-divider" />
      </template>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import type { BranchTreeNode as BranchTreeNodeType } from "./branch-tree-types";

const props = defineProps<{
  node: BranchTreeNodeType;
  depth: number;
  selectedRef: string;
  head: string;
  busy: boolean;
  isDirty: boolean;
  expanded: Record<string, boolean>;
  compact: boolean;
  canCreatePr?: boolean;
}>();

const emit = defineEmits<{
  (e: "select", ref: string): void;
  (e: "toggle", key: string): void;
  (e: "checkout", ref: string): void;
  (e: "checkout-remote", ref: string): void;
  (e: "new-from", ref: string): void;
  (e: "rename", ref: string): void;
  (e: "delete", ref: string): void;
  (e: "delete-remote", ref: string): void;
  (e: "merge", ref: string): void;
  (e: "rebase", ref: string): void;
  (e: "create-pr", ref: string): void;
}>();

const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

const hasChildren = computed(() => !!props.node.children && props.node.children.length > 0);
const isLeaf = computed(() => !hasChildren.value && props.node.kind !== "section" && props.node.kind !== "folder");

const isSelected = computed(() => {
  if (!isLeaf.value) return false;
  return !!props.node.ref && props.node.ref === props.selectedRef;
});

const iconKind = computed(() => {
  switch (props.node.kind) {
    case "section":
      return "section";
    case "folder":
      return "folder";
    case "branch-local":
      return props.node.isCurrent ? "current" : "branch";
    case "branch-remote":
      return "remote";
    case "tag":
      return "tag";
    default:
      return "branch";
  }
});

const iconChar = computed(() => {
  if (props.node.icon) return props.node.icon;
  switch (props.node.kind) {
    case "section":
      return "";
    case "folder":
      return props.expanded[props.node.key] ? "📂" : "📁";
    case "branch-local":
      return props.node.isCurrent ? "★" : "⎇";
    case "branch-remote":
      return "☁";
    case "tag":
      return "🏷";
    default:
      return "•";
  }
});

const upstreamSpan = computed(() => (props.node.kind === "branch-local" ? props.node.meta?.upstream || "" : ""));

const aheadBehindBadge = computed(() => {
  if (props.node.kind !== "branch-local") return null;
  const ahead = props.node.meta?.ahead || 0;
  const behind = props.node.meta?.behind || 0;
  if (!ahead && !behind) return null;
  if (ahead && behind) {
    return { label: `↑${ahead} ↓${behind}`, class: "branch-node__badge--diverged" };
  }
  if (ahead) return { label: `↑${ahead}`, class: "branch-node__badge--ahead" };
  return { label: `↓${behind}`, class: "branch-node__badge--behind" };
});

const rowTitle = computed(() => {
  const meta = props.node.meta;
  if (!meta) return props.node.label;
  const parts: string[] = [props.node.label];
  if (meta.lastSubject) parts.push(meta.lastSubject);
  if (meta.lastAuthor) parts.push(`by ${meta.lastAuthor}`);
  if (meta.lastRelativeDate) parts.push(meta.lastRelativeDate);
  if (meta.upstream) parts.push(`↪ ${meta.upstream}`);
  return parts.filter(Boolean).join(" — ");
});

interface MenuAction {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
}

const actions = computed<MenuAction[]>(() => {
  const list: MenuAction[] = [];
  const headRef = props.head;
  if (props.node.kind === "branch-local" && props.node.ref) {
    const ref = props.node.ref;
    list.push({
      id: "checkout",
      label: props.node.isCurrent
        ? "Already checked out"
        : props.isDirty
          ? "Checkout (working tree dirty)"
          : "Checkout",
      disabled: props.busy || !!props.node.isCurrent || props.isDirty,
    });
    list.push({ id: "new-from", label: "New branch from this…", disabled: props.busy });
    list.push({ id: "rename", label: "Rename…", disabled: props.busy });
    if (ref !== headRef) {
      list.push({ id: "merge", label: `Merge ${ref} into ${headRef || "HEAD"}`, disabled: props.busy || !headRef });
      list.push({ id: "rebase", label: `Rebase ${headRef || "HEAD"} onto ${ref}`, disabled: props.busy || !headRef });
    }
    if (props.canCreatePr) {
      list.push({ id: "_divPr", label: "", divider: true });
      list.push({ id: "create-pr", label: "Create pull request…", disabled: props.busy });
    }
    list.push({ id: "_div1", label: "", divider: true });
    list.push({ id: "delete", label: "Delete branch", disabled: props.busy || !!props.node.isCurrent, danger: true });
  } else if (props.node.kind === "branch-remote" && props.node.ref) {
    list.push({ id: "checkout-remote", label: "Checkout (track locally)", disabled: props.busy });
    list.push({ id: "new-from", label: "New branch from this…", disabled: props.busy });
    if (props.head) {
      list.push({ id: "merge", label: `Merge into ${props.head}`, disabled: props.busy });
      list.push({ id: "rebase", label: `Rebase ${props.head} onto this`, disabled: props.busy });
    }
    if (props.canCreatePr) {
      list.push({ id: "_divPr", label: "", divider: true });
      list.push({ id: "create-pr", label: "Create pull request…", disabled: props.busy });
    }
    list.push({ id: "_div1", label: "", divider: true });
    list.push({ id: "delete-remote", label: "Delete on remote…", disabled: props.busy, danger: true });
  } else if (props.node.kind === "tag" && props.node.ref) {
    list.push({ id: "new-from", label: "New branch from tag…", disabled: props.busy });
  }
  return list;
});

function onRowClick() {
  if (props.node.kind === "section" || props.node.kind === "folder") {
    emit("toggle", props.node.key);
    return;
  }
  if (props.node.ref) emit("select", props.node.ref);
}

function onRowDoubleClick() {
  if (props.busy) return;
  if (props.node.kind === "branch-local" && props.node.ref && !props.node.isCurrent && !props.isDirty) {
    emit("checkout", props.node.ref);
  } else if (props.node.kind === "branch-remote" && props.node.ref) {
    emit("checkout-remote", props.node.ref);
  }
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === "ArrowRight" && hasChildren.value && !props.expanded[props.node.key]) {
    event.preventDefault();
    emit("toggle", props.node.key);
  } else if (event.key === "ArrowLeft" && hasChildren.value && props.expanded[props.node.key]) {
    event.preventDefault();
    emit("toggle", props.node.key);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onRowClick();
  } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    openMenu();
  }
}

function openMenu() {
  if (props.node.kind === "section" || props.node.kind === "folder") return;
  if (!actions.value.length) return;
  menuOpen.value = true;
  nextTick(() => {
    document.addEventListener("click", closeMenuOnOutsideClick, { capture: true });
    document.addEventListener("keydown", closeMenuOnEsc, { capture: true });
  });
}

function closeMenu() {
  menuOpen.value = false;
  document.removeEventListener("click", closeMenuOnOutsideClick, { capture: true });
  document.removeEventListener("keydown", closeMenuOnEsc, { capture: true });
}

function closeMenuOnOutsideClick(event: Event) {
  if (!menuRef.value) return closeMenu();
  if (event.target instanceof Node && menuRef.value.contains(event.target)) return;
  closeMenu();
}

function closeMenuOnEsc(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu();
  }
}

onBeforeUnmount(() => {
  document.removeEventListener("click", closeMenuOnOutsideClick, { capture: true });
  document.removeEventListener("keydown", closeMenuOnEsc, { capture: true });
});

function runAction(id: string) {
  const ref = props.node.ref || "";
  closeMenu();
  if (!ref) return;
  switch (id) {
    case "checkout":
      emit("checkout", ref);
      break;
    case "checkout-remote":
      emit("checkout-remote", ref);
      break;
    case "new-from":
      emit("new-from", ref);
      break;
    case "rename":
      emit("rename", ref);
      break;
    case "delete":
      emit("delete", ref);
      break;
    case "delete-remote":
      emit("delete-remote", ref);
      break;
    case "merge":
      emit("merge", ref);
      break;
    case "rebase":
      emit("rebase", ref);
      break;
    case "create-pr":
      emit("create-pr", ref);
      break;
  }
}
</script>

<style scoped>
.branch-node {
  list-style: none;
  margin: 0;
  padding: 0;
  position: relative;
}

.branch-node__row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 6px;
  cursor: pointer;
  user-select: none;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  border-left: 2px solid transparent;
}

.branch-node__row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.branch-node__row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--accent);
}

.branch-node__row--selected {
  background: rgba(255, 164, 36, 0.15);
  border-left-color: var(--accent);
}

.branch-node__row--current {
  font-weight: 600;
}

.branch-node--section > .branch-node__row {
  padding-top: 6px;
  padding-bottom: 6px;
  border-top: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.025);
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  font-weight: 700;
  cursor: pointer;
}
.branch-node--section:first-child > .branch-node__row {
  border-top: none;
}

.branch-node__toggle {
  display: inline-block;
  width: 12px;
  text-align: center;
  flex: 0 0 12px;
  color: var(--muted);
  font-size: 10px;
}

.branch-node__toggle--leaf {
  visibility: hidden;
}

.branch-node__icon {
  flex: 0 0 auto;
  font-size: 12px;
  width: 14px;
  text-align: center;
  color: var(--muted);
}

.branch-node__icon--current {
  color: var(--accent);
}

.branch-node__icon--branch {
  color: #6dc070;
}

.branch-node__icon--remote {
  color: #80a8e0;
}

.branch-node__icon--tag {
  color: #d09fd9;
}

.branch-node__icon--section,
.branch-node__icon--folder {
  color: var(--muted);
}

.branch-node__label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  font-size: inherit;
}

.branch-node__label--current {
  color: var(--accent);
}

.branch-node__upstream {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--muted);
  margin-left: 2px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.branch-node__badge {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(var(--tint), 0.12);
  color: var(--muted);
  font-weight: 600;
}

.branch-node__badge--ahead {
  background: rgba(76, 175, 80, 0.22);
  color: #6dc070;
}

.branch-node__badge--behind {
  background: rgba(76, 110, 175, 0.22);
  color: #80a8e0;
}

.branch-node__badge--diverged {
  background: rgba(255, 164, 36, 0.22);
  color: var(--accent);
}

.branch-node__pill {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
}

.branch-node__pill--merged {
  background: rgba(170, 95, 200, 0.18);
  color: #d09fd9;
}

.branch-node__pill--default {
  background: rgba(76, 175, 80, 0.18);
  color: #6dc070;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.branch-node__count {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
}

.branch-node__spacer {
  flex: 1 0 0;
}

.branch-node__last {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.branch-node__children {
  list-style: none;
  margin: 0;
  padding: 0;
}

.branch-node__menu {
  position: absolute;
  z-index: 12;
  left: 24px;
  top: 100%;
  min-width: 200px;
  background: var(--surface, #1d2026);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.branch-node__menu-item {
  text-align: left;
  background: transparent;
  border: none;
  color: var(--text);
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

.branch-node__menu-item:hover:not(:disabled) {
  background: rgba(255, 164, 36, 0.15);
  color: var(--accent);
}

.branch-node__menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.branch-node__menu-item--danger {
  color: #e07b8e;
}
.branch-node__menu-item--danger:hover:not(:disabled) {
  background: rgba(224, 123, 142, 0.15);
  color: #ff8da0;
}

.branch-node__menu-divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: 4px 0;
}
</style>
