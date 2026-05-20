<template>
  <div class="dialog new-workspace-picker" style="width: min(540px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">New Workspace</p>
        <h2>Choose a template</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <!-- Arrow-key navigation between the template buttons. Tab still works
         (native button focus order); ↑/↓/Home/End move within the list, Enter
         activates whatever is currently focused. -->
    <div
      ref="listRef"
      class="new-workspace-picker__list"
      role="listbox"
      aria-label="Workspace templates"
      @keydown="onListKeydown"
    >
      <button
        ref="firstItemRef"
        type="button"
        class="project new-workspace-picker__item"
        style="--accent: #ffa424"
        title="Open the workspace editor with no preset — pick a working directory, name, and tab list manually. The most flexible option."
        @click="emit('pick-empty')"
      >
        <span class="project__badge" style="background: rgba(255, 164, 36, 0.24); font-size: 16px">+</span>
        <span class="project__meta">
          <span class="project__title-row"><strong>Empty Workspace</strong></span>
          <small style="color: var(--muted)">Start from scratch with a blank terminal workspace.</small>
        </span>
      </button>
      <button
        type="button"
        class="project new-workspace-picker__item"
        style="--accent: #7c4dff"
        title="Create a Worker + Judge agent task workspace — supervised AI loop that runs a Worker agent against a project, runs verification commands between rounds, and asks an independent Judge to confirm completion."
        @click="emit('pick-task')"
      >
        <span class="project__badge" style="background: rgba(124, 77, 255, 0.24); font-size: 16px">&#x1F916;</span>
        <span class="project__meta">
          <span class="project__title-row"><strong>Agent Task Runner</strong></span>
          <small style="color: var(--muted)"
            >Worker + Judge dual-agent workspace with automated verification loop.</small
          >
        </span>
      </button>
      <button
        v-for="plugin in pluginsWithTemplates"
        :key="plugin.id"
        type="button"
        class="project new-workspace-picker__item"
        :style="`--accent:${plugin.color};`"
        :title="`Materialise the ${plugin.name} plugin's workspace template${plugin.description ? ' — ' + plugin.description : ''}.`"
        @click="emit('pick-plugin', plugin.id)"
      >
        <span class="project__badge">{{ plugin.icon }}</span>
        <span class="project__meta">
          <span class="project__title-row"
            ><strong>{{ plugin.name }}</strong></span
          >
          <small style="color: var(--muted)">{{ plugin.description || "Plugin workspace template" }}</small>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

interface PluginEntry {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  description?: string;
  workspaceDefaults?: unknown;
  error?: unknown;
}

interface Props {
  plugins?: PluginEntry[];
}

const props = withDefaults(defineProps<Props>(), {
  plugins: () => [],
});

const emit = defineEmits<{
  "pick-empty": [];
  "pick-plugin": [id: string];
  "pick-task": [];
  cancel: [];
}>();

const pluginsWithTemplates = computed(() => props.plugins.filter((p) => p.workspaceDefaults && !p.error));

const listRef = ref<HTMLElement | null>(null);
const firstItemRef = ref<HTMLButtonElement | null>(null);

function getItems(): HTMLButtonElement[] {
  return Array.from(listRef.value?.querySelectorAll<HTMLButtonElement>(".new-workspace-picker__item") || []);
}

function focusItemAt(index: number): void {
  const items = getItems();
  if (items.length === 0) return;
  const safe = ((index % items.length) + items.length) % items.length;
  items[safe]?.focus({ preventScroll: false });
}

function onListKeydown(event: KeyboardEvent): void {
  const items = getItems();
  if (items.length === 0) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusItemAt(currentIndex < 0 ? 0 : currentIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    focusItemAt(currentIndex < 0 ? items.length - 1 : currentIndex - 1);
  } else if (event.key === "Home") {
    event.preventDefault();
    focusItemAt(0);
  } else if (event.key === "End") {
    event.preventDefault();
    focusItemAt(items.length - 1);
  }
  // Enter / Space already activate a focused <button> natively.
}

onMounted(() => {
  // Override DialogOverlay's "first focusable" fallback (which would grab the
  // header Close button) — the user wants to land on a template immediately.
  requestAnimationFrame(() => firstItemRef.value?.focus({ preventScroll: true }));
});
</script>

<style scoped>
.new-workspace-picker__list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}
.new-workspace-picker__item {
  border: 1px solid var(--border);
  cursor: pointer;
}
.new-workspace-picker__item:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent), transparent 65%);
}
</style>
