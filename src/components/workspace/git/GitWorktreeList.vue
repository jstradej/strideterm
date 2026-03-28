<template>
  <ul v-if="siblings.length" class="git-sibling-list">
    <li v-for="entry in siblings" :key="entry.path" :class="{ 'git-sibling--current': entry.isCurrent }">
      <div class="git-sibling__meta">
        <strong>{{ entry.branch || "detached" }}</strong>
        <small>{{ entry.path }}</small>
      </div>
      <div class="git-sibling__badges">
        <span class="workspace-chip"
          ><strong>{{ entry.isMainWorktree ? "main" : "linked" }}</strong> worktree</span
        >
        <span class="workspace-chip"
          ><strong>{{ entry.dirty ? String(entry.dirtyCount || 0) : "0" }}</strong>
          {{ entry.dirty ? "dirty" : "clean" }}</span
        >
        <span v-if="entry.isCurrent" class="workspace-chip workspace-chip--alert"><strong>active</strong></span>
        <button
          v-else-if="getWorkspaceId(entry)"
          type="button"
          class="button button--ghost"
          @click="appStore.activateWorkspace(getWorkspaceId(entry))"
        >
          Open
        </button>
      </div>
    </li>
  </ul>
  <p v-else class="git-card__hint">No sibling worktrees detected.</p>
</template>

<script setup>
import { computed } from "vue";
import { useAppStore } from "../../../stores/app.js";

const props = defineProps({
  snapshot: { type: Object, required: true },
  workspaces: { type: Array, default: () => [] },
});

const appStore = useAppStore();

const siblings = computed(() => props.snapshot.siblingWorktrees || []);
const workspaceIdsByPath = computed(
  () => new Map(props.workspaces.map((ws) => [String(ws.cwd || "").toLowerCase(), ws.id])),
);

function getWorkspaceId(entry) {
  return workspaceIdsByPath.value.get(String(entry.path || "").toLowerCase()) || "";
}
</script>
