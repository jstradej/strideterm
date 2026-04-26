<template>
  <div>
    <!-- UC-14: empty state when main worktree with no siblings -->
    <div v-if="siblings.length === 0 && snapshot.isMainWorktree" class="git-card__hint">
      <p>No sibling worktrees. Create one to work on multiple branches in parallel.</p>
    </div>
    <ul v-else-if="siblings.length" class="git-sibling-list">
      <li v-for="entry in siblings" :key="entry.path" :class="{ 'git-sibling--current': entry.isCurrent }">
        <div class="git-sibling__meta">
          <strong>{{ entry.branch || "detached" }}</strong>
          <small>{{ entry.path }}</small>
        </div>
        <div class="git-sibling__badges">
          <span class="workspace-chip">
            <strong>{{ entry.isMainWorktree ? "main" : "linked" }}</strong> worktree
          </span>
          <span class="workspace-chip">
            <strong>{{ entry.dirty ? String(entry.dirtyCount || 0) : "0" }}</strong>
            {{ entry.dirty ? "dirty" : "clean" }}
          </span>
          <span v-if="entry.isCurrent" class="workspace-chip workspace-chip--alert"><strong>active</strong></span>
        </div>
        <div v-if="!entry.isCurrent" class="git-sibling__actions">
          <button
            v-if="getWorkspaceId(entry)"
            type="button"
            class="button button--ghost button--small"
            @click="appStore.activateWorkspace(getWorkspaceId(entry))"
          >
            Open
          </button>
          <!-- Per-row push: gated by same logic as toolbar Push; hidden in review workspace -->
          <button
            v-if="canPushWorktree(entry) && !isReviewWorkspace"
            type="button"
            class="button button--ghost button--small"
            :disabled="!!gitUi.busyAction"
            :title="`Push branch ${entry.branch}`"
            @click="onPushWorktree(entry)"
          >
            Push
          </button>
          <!-- Delete worktree: hidden in review workspace (UC-15) -->
          <button
            v-if="!isReviewWorkspace"
            type="button"
            class="button button--ghost button--small button--danger"
            :disabled="!!gitUi.busyAction"
            title="Remove this worktree (confirm required)"
            @click="onDeleteWorktree(entry)"
          >
            Delete
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="git-card__hint">No sibling worktrees detected.</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workspaces?: any[];
    workspaceId?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitUi?: Record<string, any>;
    pushRemote?: string;
    isReviewWorkspace?: boolean;
  }>(),
  { workspaces: () => [], workspaceId: "", gitUi: () => ({}), pushRemote: "origin", isReviewWorkspace: false },
);

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

const siblings = computed(() => props.snapshot.siblingWorktrees || []);
const workspaceIdsByPath = computed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  () => new Map(props.workspaces.map((ws: any) => [String(ws.cwd || "").toLowerCase(), ws.id])),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getWorkspaceId(entry: any) {
  return workspaceIdsByPath.value.get(String(entry.path || "").toLowerCase()) || "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function canPushWorktree(entry: any) {
  // Gate same as toolbar Push: has remote, not detached, not review workspace
  if (!entry.branch || entry.detached) return false;
  const remoteCount = Object.keys(props.snapshot.remotes || {}).filter((k: string) => !k.includes(":")).length;
  return remoteCount > 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onPushWorktree(entry: any) {
  const wsId = getWorkspaceId(entry);
  if (wsId) {
    gitUiStore.gitPush(wsId);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onDeleteWorktree(entry: any) {
  if (!props.workspaceId) return;
  gitUiStore.confirmRemoveWorktree(props.workspaceId, {
    worktreePath: entry.path,
    branch: entry.branch || "unknown",
    branchMerged: entry.branchMerged === true,
  });
}
</script>
