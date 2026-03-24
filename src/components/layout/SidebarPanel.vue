<template>
  <div
    ref="listRef"
    class="workspace-list"
    data-role="workspace-list"
    @dragstart="dragDrop.onDragstart"
    @dragover.prevent="dragDrop.onDragover"
    @dragleave="dragDrop.onDragleave"
    @drop="dragDrop.onDrop"
    @dragend="dragDrop.onDragend"
  >
    <WorkspaceCard
      v-for="ws in workspaceCards"
      :key="ws.id"
      :workspace="ws"
      :data-workspace-id="ws.id"
      @activate="store.activateWorkspace(ws.id)"
      @quick-fix="store.openQuickFixWizard()"
      @create-worktree="$emit('create-worktree', ws.id)"
      @edit="$emit('edit-workspace', ws.id)"
      @delete="$emit('delete-workspace', ws.id)"
    />
    <div v-if="suggestions.length" class="workspace-suggestions">
      <p class="eyebrow workspace-suggestions__title">Available plugins</p>
      <button
        v-for="plugin in suggestions"
        :key="plugin.id"
        type="button"
        class="workspace-suggestion"
        :style="`--accent:${plugin.color}`"
        :title="`Add ${plugin.name}`"
        @click="$emit('add-plugin-workspace', plugin.id)"
      >
        <span class="workspace-card__badge" :style="`background:color-mix(in srgb, ${plugin.color}, transparent 76%);`">{{ plugin.icon }}</span>
        <span class="workspace-suggestion__meta">
          <strong>{{ plugin.name }}</strong>
          <small>Click to add</small>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useWorkspaceDragDrop } from "../../composables/useDragDrop.js";
import { buildWorkspaceCards } from "../../app/workspace-render.js";
import WorkspaceCard from "./WorkspaceCard.vue";

const store = useAppStore();
const listRef = ref(null);
const dragDrop = useWorkspaceDragDrop(listRef);

const workspaceCards = computed(() => {
  const payload = store.payload;
  if (!payload) return [];
  return buildWorkspaceCards({
    workspaces: store.filteredWorkspaces,
    activeWorkspaceId: payload.appState?.activeWorkspaceId || "",
    getGitSnapshot: (id) => store.getGitSnapshot(id),
    getWorkspaceAttention: (id) => store.getWorkspaceAttentionForId(id),
  });
});

const suggestions = computed(() => {
  const payload = store.payload;
  if (!payload) return [];
  const plugins = (payload.plugins || []).filter((p) => p.workspaceDefaults && !p.error);
  const existingNames = new Set(store.filteredWorkspaces.map((ws) => ws.name.toLowerCase()));
  return plugins
    .filter((p) => !existingNames.has((p.workspaceDefaults.name || p.name).toLowerCase()))
    .map((p) => ({ id: p.id, color: p.color, icon: p.icon, name: p.workspaceDefaults.name || p.name }));
});

defineEmits(["create-worktree", "edit-workspace", "delete-workspace", "add-plugin-workspace"]);
</script>
