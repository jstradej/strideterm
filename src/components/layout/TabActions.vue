<template>
  <div class="terminal-toolbar__actions" data-role="tab-actions">
    <button
      v-if="workspaceKind !== 'docker' && workspaceKind !== 'azure' && workspaceKind !== 'github'"
      type="button"
      class="button button--ghost"
      @click="$emit('toggle-tab-picker', $event)"
    >
      + Tab
    </button>
    <button v-if="store.splitGroup" type="button" class="button button--ghost" @click="$emit('disband-split')">
      Unsplit
    </button>
    <button
      type="button"
      class="button button--ghost"
      :class="{ 'button--active': currentLayout !== 'solo' }"
      :title="'Layout'"
      @click="$emit('open-layout-picker', $event)"
    >
      {{ currentLayout !== "solo" ? layouts[currentLayout]?.label || "Split" : "Split" }}
    </button>

    <span class="tab-actions__separator"></span>

    <button
      v-if="workspaceKind === 'azure' || workspaceKind === 'github'"
      type="button"
      class="tab-actions__icon"
      title="New branch"
      @click="$emit('quick-fix')"
    >
      &#x1FA84;
    </button>
    <button
      v-if="gitAvailable"
      type="button"
      class="tab-actions__icon"
      title="New worktree"
      @click="$emit('create-worktree')"
    >
      &#x1F33F;
    </button>
    <button
      v-if="workspaceKind !== 'task'"
      type="button"
      class="tab-actions__icon"
      title="Create task agent"
      @click="$emit('create-task')"
    >
      &#x1F916;
    </button>
    <button type="button" class="tab-actions__icon" title="Edit workspace" @click="$emit('edit-workspace')">
      &#x270E;
    </button>
    <button
      type="button"
      class="tab-actions__icon tab-actions__icon--danger"
      title="Delete workspace"
      @click="$emit('delete-workspace')"
    >
      &#x2715;
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";

const LAYOUTS = {
  solo: { slots: 1, label: "Solo" },
  cols: { slots: 2, label: "Side by side" },
  rows: { slots: 2, label: "Stacked" },
  "top-split": { slots: 3, label: "Top + 2 bottom" },
  "left-split": { slots: 3, label: "Left + 2 right" },
  grid: { slots: 4, label: "Grid" },
};

const store = useAppStore();

const workspaceKind = computed(() => store.activeWorkspace?.kind || "terminal");
const gitAvailable = computed(() => {
  const wsId = store.payload?.appState?.activeWorkspaceId;
  if (!wsId) return false;
  return !!(store.getGitSnapshot(wsId) as { available?: boolean } | null | undefined)?.available;
});
const layouts = LAYOUTS as Record<string, { slots: number; label: string } | undefined>;

const currentLayout = computed(() => {
  const sg = store.splitGroup;
  if (!sg) return "solo";
  return store.activeViewId && sg.viewIds.includes(store.activeViewId) ? sg.layout : "solo";
});

defineEmits<{
  (e: "toggle-tab-picker", event: MouseEvent): void;
  (e: "disband-split"): void;
  (e: "open-layout-picker", event: MouseEvent): void;
  (e: "quick-fix"): void;
  (e: "create-worktree"): void;
  (e: "create-task"): void;
  (e: "edit-workspace"): void;
  (e: "delete-workspace"): void;
}>();
</script>
