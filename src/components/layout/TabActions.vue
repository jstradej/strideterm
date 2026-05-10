<template>
  <div class="terminal-toolbar__actions" data-role="tab-actions">
    <button
      v-if="workspaceKind !== 'docker' && workspaceKind !== 'azure' && workspaceKind !== 'github'"
      type="button"
      class="button button--ghost"
      title="Add a new tab to this workspace — pick from your tab templates (Shell, Claude Code, Codex, Gemini, Files, Browser…)."
      @click="$emit('toggle-tab-picker', $event)"
    >
      + Tab
    </button>
    <button
      v-if="!isMobile"
      type="button"
      class="button button--ghost"
      :class="{ 'button--active': currentLayout !== 'solo' }"
      :title="
        store.isGridVisible
          ? 'Choose a workspace-grid layout (side by side, stacked, top + two below, left + two right, or 2×2 grid).'
          : 'Choose a split layout (side by side, stacked, top + two below, left + two right, or 2×2 grid) so this workspace shows multiple tabs at once.'
      "
      @click="$emit('open-layout-picker', $event)"
    >
      {{ currentLayout !== "solo" ? layouts[currentLayout]?.label || "Split" : "Split" }}
    </button>
    <button
      v-if="(store.splitGroup || store.isGridVisible) && !isMobile"
      type="button"
      class="button button--ghost"
      :title="
        store.isGridVisible
          ? 'Disband the workspace grid — the active workspace returns to a single full-width view.'
          : 'Disband the current split layout — the active view returns to a single full-width pane.'
      "
      @click="onDisband"
    >
      Unsplit
    </button>

    <span class="tab-actions__separator"></span>

    <button
      v-if="workspaceKind === 'azure' || workspaceKind === 'github'"
      type="button"
      class="tab-actions__icon"
      title="Open the New Branch wizard — pick a connection, project, repository and base branch, then create a fresh worktree for a new branch without leaving the IDE."
      @click="$emit('quick-fix')"
    >
      &#x1FA84;
    </button>
    <button
      v-if="gitAvailable"
      type="button"
      class="tab-actions__icon"
      title="Create a git worktree for an existing or new branch off this repository, opened as its own workspace so the main checkout stays untouched."
      @click="$emit('create-worktree')"
    >
      &#x1F33F;
    </button>
    <button
      v-if="workspaceKind !== 'task'"
      type="button"
      class="tab-actions__icon"
      title="Create a task workspace — runs a supervised Worker + Judge AI loop against a project directory until the task is verified complete."
      @click="$emit('create-task')"
    >
      &#x1F916;
    </button>
    <button
      type="button"
      class="tab-actions__icon"
      title="Edit this workspace — rename, change colour/icon, edit notes, manage tab templates, multi-repo roots, and per-tab startup."
      @click="$emit('edit-workspace')"
    >
      &#x270E;
    </button>
    <button
      type="button"
      class="tab-actions__icon tab-actions__icon--danger"
      title="Delete this workspace — kills running PTY sessions and removes it from the sidebar. Review/quickfix worktrees are offered for cleanup separately."
      @click="$emit('delete-workspace')"
    >
      &#x2715;
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useIsNarrow } from "../../composables/useIsNarrow.js";

const LAYOUTS = {
  solo: { slots: 1, label: "Solo" },
  cols: { slots: 2, label: "Side by side" },
  rows: { slots: 2, label: "Stacked" },
  "top-split": { slots: 3, label: "Top + 2 bottom" },
  "left-split": { slots: 3, label: "Left + 2 right" },
  grid: { slots: 4, label: "Grid" },
};

const store = useAppStore();
const { isMobile } = useIsNarrow();

const workspaceKind = computed(() => store.activeWorkspace?.kind || "terminal");
const gitAvailable = computed(() => {
  const wsId = store.payload?.appState?.activeWorkspaceId;
  if (!wsId) return false;
  return !!(store.getGitSnapshot(wsId) as { available?: boolean } | null | undefined)?.available;
});
const layouts = LAYOUTS as Record<string, { slots: number; label: string } | undefined>;

const currentLayout = computed(() => {
  if (store.isGridVisible) return store.workspaceGrid?.layout || "solo";
  const sg = store.splitGroup;
  if (!sg) return "solo";
  return store.activeViewId && sg.viewIds.includes(store.activeViewId) ? sg.layout : "solo";
});

const emit = defineEmits<{
  (e: "toggle-tab-picker", event: MouseEvent): void;
  (e: "disband-split"): void;
  (e: "open-layout-picker", event: MouseEvent): void;
  (e: "quick-fix"): void;
  (e: "create-worktree"): void;
  (e: "create-task"): void;
  (e: "edit-workspace"): void;
  (e: "delete-workspace"): void;
}>();

function onDisband(): void {
  if (store.isGridVisible) {
    store.disableWorkspaceGrid();
    return;
  }
  emit("disband-split");
}
</script>
