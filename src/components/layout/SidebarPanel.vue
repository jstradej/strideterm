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
      @activate="onActivate(ws.id)"
      @quick-fix="ws.kind === 'github' ? store.openGitHubQuickFixWizard() : store.openQuickFixWizard()"
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
        <span
          class="workspace-card__badge"
          :style="`background:color-mix(in srgb, ${plugin.color}, transparent 76%);`"
          >{{ plugin.icon }}</span
        >
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
    getChecks: (workspace) => {
      const prKey = workspace.review?.prKey;
      if (!prKey) return null;
      const provider = workspace.review?.provider;
      if (provider === "azure-devops") return payload.azureDevops?.pullRequests?.[prKey]?.checks || null;
      if (provider === "github") return payload.github?.pullRequests?.[prKey]?.checks || null;
      return null;
    },
    getPrStatus: (workspace) => {
      const prKey = workspace.review?.prKey;
      if (!prKey) return null;
      const provider = workspace.review?.provider;
      if (provider === "azure-devops") {
        const prData = payload.azureDevops?.pullRequests?.[prKey]?.pullRequest;
        const status = prData?.status;
        if (status === "completed") return { status: "completed", closedDate: prData.closedDate || null };
        if (status === "abandoned") return { status: "abandoned", closedDate: prData.closedDate || null };
        return { status: "active" };
      }
      if (provider === "github") {
        const pr = payload.github?.pullRequests?.[prKey]?.pullRequest;
        if (pr?.mergedAt) return { status: "completed", closedDate: pr.mergedAt };
        if (pr && pr.state !== "open") return { status: "abandoned", closedDate: pr.closedAt || pr.updatedAt || null };
        return { status: "active" };
      }
      return null;
    },
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

const emit = defineEmits(["create-worktree", "edit-workspace", "delete-workspace", "add-plugin-workspace", "activate"]);

function onActivate(workspaceId) {
  store.activateWorkspace(workspaceId);
  emit("activate", workspaceId);
}
</script>
