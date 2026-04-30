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
          <span
            v-if="entry.lastActivityMs"
            class="workspace-chip workspace-chip--muted"
            :title="`Last activity (HEAD/checkout/commit) at ${formatAbsolute(entry.lastActivityMs)}`"
          >
            <strong>{{ formatRelative(entry.lastActivityMs) }}</strong>
          </span>
        </div>
        <div class="git-sibling__actions">
          <button
            v-if="!entry.isCurrent && getWorkspaceId(entry)"
            type="button"
            class="button button--ghost button--small"
            :title="`Switch focus to the workspace at ${entry.path}.`"
            @click="appStore.activateWorkspace(getWorkspaceId(entry))"
          >
            Open
          </button>
          <button
            v-if="entry.isCurrent"
            type="button"
            class="button button--ghost button--small"
            disabled
            title="You are currently in this worktree — switch to a different workspace before removing it."
          >
            (active)
          </button>
          <!-- Per-row push: gated by same logic as toolbar Push; hidden in review workspace -->
          <button
            v-if="!entry.isCurrent && canPushWorktree(entry) && !isReviewWorkspace"
            type="button"
            class="button button--ghost button--small"
            :disabled="!!gitUi.busyAction"
            :title="`Push branch ${entry.branch} to its tracking remote.`"
            @click="onPushWorktree(entry)"
          >
            Push
          </button>
          <!-- Delete worktree: hidden in review workspace (UC-15); also disabled
               for the worktree the user is currently in (git refuses anyway). -->
          <button
            v-if="!isReviewWorkspace && !entry.isMainWorktree"
            type="button"
            class="button button--ghost button--small button--danger"
            :disabled="!!gitUi.busyAction || entry.isCurrent"
            :title="
              entry.isCurrent
                ? 'Cannot remove the worktree you are currently in. Switch to another workspace first.'
                : `Remove the worktree at ${entry.path}. You will be asked to confirm; the underlying branch is kept by default.`
            "
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

const siblings = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = [...(props.snapshot.siblingWorktrees || [])];
  // Sort: current first, then most recent activity, then main last among
  // never-touched ones. Keeps the user oriented when many worktrees exist.
  return items.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (b.isCurrent && !a.isCurrent) return 1;
    const aMs = Number(a.lastActivityMs) || 0;
    const bMs = Number(b.lastActivityMs) || 0;
    if (aMs !== bMs) return bMs - aMs;
    if (a.isMainWorktree !== b.isMainWorktree) return a.isMainWorktree ? -1 : 1;
    return String(a.branch || "").localeCompare(String(b.branch || ""));
  });
});
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

function formatRelative(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo ago`;
  const years = Math.round(days / 365);
  return `${years}y ago`;
}

function formatAbsolute(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toISOString();
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
