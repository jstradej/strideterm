<template>
  <div
    ref="listRef"
    class="workspace-list"
    data-role="workspace-list"
    @dragstart="onListDragstart"
    @dragover="onListDragover"
    @dragleave="onListDragleave"
    @drop="onListDrop"
    @dragend="onListDragend"
  >
    <!-- "In split" group: workspaces currently displayed in the workspace grid -->
    <div
      v-if="splitGroupCards.length > 0"
      class="workspace-list__split-group"
      :title="'These workspaces are pinned to slots in the active workspace grid. Click ✕ to disband the grid.'"
    >
      <p class="eyebrow workspace-list__split-title">
        <span>In split ({{ splitGroupCards.length }})</span>
        <button
          type="button"
          class="workspace-list__split-disband"
          title="Disband the workspace grid — return to a single-workspace view."
          @click="store.disableWorkspaceGrid()"
        >
          ✕
        </button>
      </p>
      <WorkspaceCard
        v-for="entry in splitGroupCards"
        :key="`split-${entry.slotIndex}-${entry.card.id}`"
        :workspace="{ ...entry.card, depth: 0, inGrid: true, slotIndex: entry.slotIndex + 1 }"
        :data-workspace-id="entry.card.id"
        @activate="onActivate(entry.card.id)"
        @open-menu="onOpenMenu($event, entry.card)"
        @toggle-star="handleToggleStar(entry.card)"
        @task-toggle="handleTaskToggle(entry.card)"
        @task-stop="handleTaskStop(entry.card)"
      />
      <hr class="workspace-list__divider" />
    </div>
    <template v-if="!isRecentActive">
      <WorkspaceCard
        v-for="ws in treeCards"
        :key="ws.id"
        :workspace="ws"
        :data-workspace-id="ws.id"
        @activate="onActivate(ws.id)"
        @open-menu="onOpenMenu($event, ws)"
        @toggle-star="handleToggleStar(ws)"
        @task-toggle="handleTaskToggle(ws)"
        @task-stop="handleTaskStop(ws)"
      />
      <p v-if="searchQuery && treeCards.length === 0" class="workspace-list__no-match">
        No workspace matches “{{ store.workspaceSearchQuery.trim() }}”.
      </p>
    </template>
    <template v-else>
      <template v-for="item in visibleRecentItems" :key="item.key">
        <p v-if="item.type === 'section'" class="workspace-list__section-header">
          <button
            v-if="item.sectionKey === 'older'"
            type="button"
            class="workspace-list__section-toggle"
            :aria-expanded="!olderCollapsed"
            :title="olderCollapsed ? 'Expand Older' : 'Collapse Older'"
            @click="olderCollapsed = !olderCollapsed"
          >
            <span class="workspace-list__section-caret" aria-hidden="true">{{ olderCollapsed ? "▸" : "▾" }}</span>
            <span>{{ item.label }} ({{ item.count }})</span>
          </button>
          <span v-else>{{ item.label }}</span>
        </p>
        <WorkspaceContextRow
          v-else-if="item.type === 'context'"
          :name="item.name"
          :icon="item.icon"
          :depth="item.depth"
        />
        <WorkspaceCard
          v-else
          :workspace="item.card"
          :data-workspace-id="item.workspaceId"
          @activate="onActivate(item.workspaceId)"
          @open-menu="onOpenMenu($event, item.card)"
          @toggle-star="handleToggleStar(item.card)"
          @task-toggle="handleTaskToggle(item.card)"
          @task-stop="handleTaskStop(item.card)"
        />
      </template>
    </template>
    <button
      type="button"
      class="workspace-new-tile"
      title="Create a new empty workspace — opens the workspace editor with a blank draft. Pick a name, icon, working directory, and tabs."
      @click="onCreateEmptyWorkspace"
    >
      <span class="workspace-new-tile__plus" aria-hidden="true">+</span>
      <span class="workspace-new-tile__label">add new workspace</span>
    </button>
    <div v-if="suggestions.length && !searchQuery" class="workspace-suggestions">
      <p class="eyebrow workspace-suggestions__title">Available plugins</p>
      <button
        v-for="plugin in suggestions"
        :key="plugin.id"
        type="button"
        class="workspace-suggestion"
        :style="`--accent:${plugin.color}`"
        :title="`Materialise the ${plugin.name} plugin's workspace template — adds it to the active profile so it shows up in the workspace list above.`"
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

  <!-- Workspace-activation loading overlay: visible during async activateWorkspace
       so mobile users have feedback during multi-second workspace switches. -->
  <Teleport to="body">
    <div v-if="activatingWorkspaceId" class="overlay ws-activate-overlay" role="status" aria-label="Loading workspace">
      <div class="ws-activate-spinner"></div>
    </div>
  </Teleport>

  <!-- Workspace actions menu -->
  <Teleport to="body">
    <div
      v-if="wsMenu"
      ref="wsMenuRef"
      class="context-menu"
      :style="{ position: 'fixed', left: wsMenu.x + 'px', top: wsMenu.y + 'px', zIndex: 9999 }"
      @click.stop
    >
      <button
        v-if="wsMenu.ws.kind === 'azure' || wsMenu.ws.kind === 'github'"
        type="button"
        class="context-menu__item"
        title="Open the New Branch wizard for this connection — pick project / repo / base branch, type a name, and a fresh worktree workspace is created off the chosen base."
        @click="onMenuAction('quick-fix')"
      >
        &#x1FA84; New branch
      </button>
      <button
        v-if="wsMenu.ws.gitAvailable"
        type="button"
        class="context-menu__item"
        title="Create a git worktree for this repository on a new or existing branch and open it as its own workspace, leaving the main checkout untouched."
        @click="onMenuAction('create-worktree')"
      >
        &#x1F33F; New worktree
      </button>
      <button
        v-if="wsMenu.ws.kind !== 'task' && wsMenu.ws.kind !== 'docker'"
        type="button"
        class="context-menu__item"
        title="Spawn a task workspace bound to this project — runs a supervised Worker + Judge AI loop with auto-detected verification commands."
        @click="onMenuAction('create-task')"
      >
        &#x1F916; Create task agent
      </button>
      <button
        v-if="wsMenuHasChildren"
        type="button"
        class="context-menu__item"
        title="Open workspace grid with this workspace in slot 0 and its 3 most-recently-active children filling the remaining slots."
        @click="onMenuAction('open-in-grid')"
      >
        &#x22F6; Open in grid
      </button>
      <button
        v-if="wsMenuIsPrLinked"
        type="button"
        class="context-menu__item"
        title="Unlink this workspace from its pull request. The Review tab disappears, agent tabs stop getting the review MCP bridge, and git operations behave like a normal workspace again. The PR on the server is not touched."
        @click="onMenuAction('detach-review')"
      >
        &#x1F517; Detach from PR review
      </button>
      <div class="context-menu__divider"></div>
      <button
        type="button"
        class="context-menu__item"
        title="Open the workspace editor — rename, change icon/colour, edit notes, manage tabs, and configure multi-repo roots."
        @click="onMenuAction('edit')"
      >
        &#x270E; Edit
      </button>
      <button
        type="button"
        class="context-menu__item context-menu__item--danger"
        title="Remove this workspace from the sidebar and kill its PTY sessions. Review/quickfix worktrees prompt for cleanup separately."
        @click="onMenuAction('delete')"
      >
        &#x2715; Delete
      </button>
      <button
        type="button"
        class="context-menu__item"
        title="Remove only the sidebar entry — leaves files on disk untouched. Use when a regular Delete couldn't finish (locked files, missing directory, manually deleted worktree) so the orphan entry sticks around."
        @click="onMenuAction('force-remove')"
      >
        &#x21A9; Remove from list
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, inject, watch, nextTick, onMounted, onUnmounted } from "vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { useWorkspaceDragDrop } from "../../composables/useDragDrop.js";
import { useContextMenu } from "../../composables/useContextMenu.js";
import { buildWorkspaceCards } from "../../app/workspace-render.js";
import {
  resolveParentId,
  buildRecentProjection,
  type RecentRenderItem,
} from "../../app/workspace-sidebar-projection.js";
import type { Transport } from "../../transport.js";
import type { GitSnapshot, StatePayload, WorkspaceState } from "../../../electron/shared/types/state.js";
import WorkspaceCard from "./WorkspaceCard.vue";
import WorkspaceContextRow from "./WorkspaceContextRow.vue";

interface LiveTask {
  state?: string;
  currentRound?: number;
  maxRounds?: number;
}

interface AttentionLike {
  count?: number;
  alerts?: Array<{ title?: string; kind?: string; exitCode?: number; at?: string }>;
  latestAt?: string;
}

interface SessionActivityLike {
  workspaceId?: string;
  panelId?: string;
  activity?: string;
  agentLike?: boolean;
  hasUserInput?: boolean;
}

interface PrEntry {
  pullRequest?: {
    status?: string;
    closedDate?: string;
    mergedAt?: string;
    closedAt?: string;
    updatedAt?: string;
    state?: string;
  };
  checks?: { failedCount?: number; pendingCount?: number; passedCount?: number };
  lastActivityAt?: string | null;
}

interface AzureDevopsWithPrs {
  pullRequests?: Record<string, PrEntry>;
}

interface WorkspaceCardData {
  id: string;
  active: boolean;
  attentionCount: number;
  attentionFresh: boolean;
  depth: number;
  name: string;
  [key: string]: unknown;
}

interface PluginEntry {
  id: string;
  name: string;
  color: string;
  icon: string;
  error?: unknown;
  workspaceDefaults?: { name?: string };
}

const store = useAppStore();
const notifications = useNotificationStore();
const listRef = ref<HTMLElement | null>(null);
const dragDrop = useWorkspaceDragDrop(listRef);
const activatingWorkspaceId = ref<string | null>(null);

const workspaceCards = computed((): WorkspaceCardData[] => {
  const payload = store.payload;
  if (!payload) return [];
  const azureDevops = payload.azureDevops as AzureDevopsWithPrs | undefined;
  const github = payload.github as AzureDevopsWithPrs | undefined;
  return buildWorkspaceCards({
    workspaces: store.filteredWorkspaces,
    activeWorkspaceId: store.myActiveWorkspaceId || "",
    // Sidebar cards read only the six light git fields — pull from gitSummaries
    // (present for every workspace on the remote slim core) rather than the full
    // per-workspace snapshot, which is fetched on demand only for mounted panes.
    getGitSnapshot: (id) => store.getGitSummary(id) as GitSnapshot | null | undefined,
    getWorkspaceAttention: (id) => store.getWorkspaceAttentionForId(id) as AttentionLike | null | undefined,
    taskRunnerSnapshot: (payload.taskRunner as Record<string, LiveTask>) || null,
    sessionActivities: (payload.attention as { sessions?: Record<string, SessionActivityLike> })?.sessions || null,
    getChecks: (workspace) => {
      const prKey = workspace.review?.prKey;
      if (!prKey) return null;
      const provider = workspace.review?.provider;
      if (provider === "azure-devops") return azureDevops?.pullRequests?.[prKey]?.checks || null;
      if (provider === "github") return github?.pullRequests?.[prKey]?.checks || null;
      return null;
    },
    getPrStatus: (workspace) => {
      const prKey = workspace.review?.prKey;
      if (!prKey) return null;
      const provider = workspace.review?.provider;
      if (provider === "azure-devops") {
        const entry = azureDevops?.pullRequests?.[prKey];
        const prData = entry?.pullRequest;
        const status = prData?.status;
        const lastActivityAt = entry?.lastActivityAt;
        if (status === "completed")
          return { status: "completed", closedDate: prData?.closedDate || undefined, lastActivityAt };
        if (status === "abandoned")
          return { status: "abandoned", closedDate: prData?.closedDate || undefined, lastActivityAt };
        return { status: "active", lastActivityAt };
      }
      if (provider === "github") {
        const entry = github?.pullRequests?.[prKey];
        const pr = entry?.pullRequest;
        const lastActivityAt = entry?.lastActivityAt;
        if (pr?.mergedAt) return { status: "completed", closedDate: pr.mergedAt, lastActivityAt };
        if (pr && pr.state !== "open")
          return { status: "abandoned", closedDate: pr.closedAt || pr.updatedAt || undefined, lastActivityAt };
        return { status: "active", lastActivityAt };
      }
      return null;
    },
  }) as WorkspaceCardData[];
});

const hasAnyStarred = computed(() => store.filteredWorkspaces.some((ws) => ws.starred));

// Auto-deactivate star filter when no starred workspaces remain
watch(
  hasAnyStarred,
  (has) => {
    if (!has) store.starFilterActive = false;
  },
  { immediate: true },
);

const starFilteredCards = computed(() => {
  if (!store.starFilterActive) return workspaceCards.value;
  const allWs = store.filteredWorkspaces;
  // Build parent→children and child→parent maps
  const childrenOf = new Map(); // parentId → Set<childId>
  const parentOf = new Map(); // childId → parentId
  for (const ws of allWs) {
    const pid = resolveParentId(ws, allWs);
    if (pid) {
      parentOf.set(ws.id, pid);
      if (!childrenOf.has(pid)) childrenOf.set(pid, new Set());
      childrenOf.get(pid).add(ws.id);
    }
  }
  // Recursively collect all descendants of a workspace
  function addDescendants(id: string): void {
    const kids = childrenOf.get(id);
    if (!kids) return;
    for (const kid of kids) {
      visible.add(kid);
      addDescendants(kid);
    }
  }
  // Walk up to the root ancestor
  function addAncestors(id: string): void {
    const pid = parentOf.get(id);
    if (pid) {
      visible.add(pid);
      addAncestors(pid);
    }
  }
  // Collect visible IDs
  const visible = new Set();
  for (const ws of allWs) {
    if (!ws.starred) continue;
    visible.add(ws.id);
    addAncestors(ws.id);
    addDescendants(ws.id);
  }
  return workspaceCards.value.filter((card) => visible.has(card.id));
});

// Free-text name filter (sidebar profile row). Matches the query as a
// case-insensitive substring of the workspace name — i.e. *text*. Ancestors of
// a match are kept so an indented child never floats without its parent.
const searchQuery = computed(() => store.workspaceSearchQuery.trim().toLowerCase());

const displayedCards = computed(() => {
  const query = searchQuery.value;
  if (!query) return starFilteredCards.value;
  const allWs = store.filteredWorkspaces;
  const parentOf = new Map<string, string>();
  for (const ws of allWs) {
    const pid = resolveParentId(ws, allWs);
    if (pid) parentOf.set(ws.id, pid);
  }
  const visible = new Set<string>();
  for (const ws of allWs) {
    if (!ws.name.toLowerCase().includes(query)) continue;
    visible.add(ws.id);
    let pid = parentOf.get(ws.id);
    while (pid && !visible.has(pid)) {
      visible.add(pid);
      pid = parentOf.get(pid);
    }
  }
  return starFilteredCards.value.filter((card) => visible.has(card.id));
});

// --- "recent" workspace view ---------------------------------------------

const viewMode = computed<"tree" | "recent">(() =>
  (store.activeProfile as { sidebarWorkspaceViewMode?: string } | null)?.sidebarWorkspaceViewMode === "recent"
    ? "recent"
    : "tree",
);

// Active search always wins — it flattens buckets away entirely so an old
// (Older-bucket) workspace is never one profile-switch-away from findable.
const isRecentActive = computed(() => viewMode.value === "recent" && !searchQuery.value);

// One shared minute clock for the whole recent view (never per-card), so
// items cross the 1h/24h/7d boundaries live. Only ticks while recent mode
// is actually visible and the document isn't hidden.
const recentNow = ref(Date.now());
let recentClockTimer: ReturnType<typeof setInterval> | null = null;
function startRecentClock(): void {
  if (recentClockTimer) return;
  recentNow.value = Date.now();
  recentClockTimer = setInterval(() => {
    recentNow.value = Date.now();
  }, 60_000);
}
function stopRecentClock(): void {
  if (recentClockTimer) {
    clearInterval(recentClockTimer);
    recentClockTimer = null;
  }
}
function onRecentClockVisibilityChange(): void {
  if (document.hidden) stopRecentClock();
  else if (isRecentActive.value) startRecentClock();
}
watch(
  isRecentActive,
  (active) => {
    if (active && !document.hidden) startRecentClock();
    else stopRecentClock();
  },
  { immediate: true },
);
onMounted(() => {
  document.addEventListener("visibilitychange", onRecentClockVisibilityChange);
});
onUnmounted(() => {
  document.removeEventListener("visibilitychange", onRecentClockVisibilityChange);
  stopRecentClock();
});

// "Older" starts collapsed and is purely local UI state — not persisted.
const olderCollapsed = ref(true);

// Real-workspace ids eligible to show, post profile-scope + star filter —
// exactly the pipeline stage the recent projection is documented to run
// after. Context-path resolution below still uses the full profile-scoped
// list so a shared ancestor resolves even when the star filter hid it.
const recentVisibleIds = computed(() => new Set(starFilteredCards.value.map((card) => card.id)));

const rawRecentItems = computed((): RecentRenderItem[] => {
  if (!isRecentActive.value) return [];
  return buildRecentProjection({
    workspaces: store.filteredWorkspaces as WorkspaceState[],
    cards: workspaceCards.value,
    activeWorkspaceId: store.myActiveWorkspaceId || "",
    now: recentNow.value,
    visibleIds: recentVisibleIds.value,
  });
});

// Same in-grid ghost treatment as the tree view — a workspace pinned to a
// grid slot still renders in its recent-time section, just dimmed.
const recentItems = computed((): RecentRenderItem[] => {
  const occ = gridCellIds.value;
  const slotByWs = new Map<string, number>();
  const grid = store.workspaceGrid;
  if (grid) {
    (grid.cellWorkspaceIds as (string | null)[]).forEach((id, idx) => {
      if (id) slotByWs.set(id, idx + 1);
    });
  }
  return rawRecentItems.value.map((item) => {
    if (item.type !== "workspace") return item;
    return {
      ...item,
      card: {
        ...item.card,
        inGrid: occ.has(item.workspaceId),
        slotIndex: slotByWs.get(item.workspaceId),
      },
    };
  });
});

// What actually renders: "Older" hides its non-header rows while collapsed;
// the collapsed icon-strip sidebar drops section headers and context rows
// entirely — only real workspace icons remain, in recent order.
const visibleRecentItems = computed((): RecentRenderItem[] => {
  if (store.sidebarCollapsed) return recentItems.value.filter((item) => item.type === "workspace");
  return recentItems.value.filter(
    (item) => !(item.type !== "section" && item.sectionKey === "older" && olderCollapsed.value),
  );
});

// Drag-and-drop reordering only makes sense for the manually-ordered tree —
// recent order is derived from lastUsedAt and cannot be dragged. Wrapping
// (rather than conditionally binding the listeners) keeps tree-mode
// behaviour byte-for-byte identical to before this view existed.
function onListDragstart(event: DragEvent): void {
  if (isRecentActive.value) return;
  dragDrop.onDragstart(event);
}
function onListDragover(event: DragEvent): void {
  if (isRecentActive.value) return;
  dragDrop.onDragover(event);
}
function onListDragleave(event: DragEvent): void {
  if (isRecentActive.value) return;
  dragDrop.onDragleave(event);
}
function onListDrop(event: DragEvent): void {
  if (isRecentActive.value) return;
  dragDrop.onDrop(event);
}
function onListDragend(): void {
  if (isRecentActive.value) return;
  dragDrop.onDragend();
}

const suggestions = computed(() => {
  const payload = store.payload;
  if (!payload) return [];
  const plugins = (payload.plugins || []).filter((p) => {
    const pe = p as PluginEntry;
    return pe.workspaceDefaults && !pe.error;
  }) as PluginEntry[];
  const existingNames = new Set(store.filteredWorkspaces.map((ws) => ws.name.toLowerCase()));
  return plugins
    .filter((p) => !existingNames.has((p.workspaceDefaults?.name || p.name).toLowerCase()))
    .map((p) => ({ id: p.id, color: p.color, icon: p.icon, name: p.workspaceDefaults?.name || p.name }));
});

const emit = defineEmits<{
  (e: "create-worktree", id: string): void;
  (e: "edit-workspace", id: string): void;
  (e: "delete-workspace", id: string): void;
  (e: "force-remove-workspace", id: string): void;
  (e: "add-plugin-workspace", id: string): void;
  (e: "activate", id: string): void;
  (e: "create-task", id: string): void;
}>();

function onCreateEmptyWorkspace(): void {
  // Skip the New Workspace picker — go straight to the empty-workspace editor.
  // The picker is still reachable via the "+" button in the sidebar header.
  store.openWorkspaceDialog();
}

async function onActivate(workspaceId: string): Promise<void> {
  // Diagnostic: log every sidebar click so the dev log shows whether activation
  // was actually requested (vs e.g. swallowed by a parent handler). Routes
  // through preload's `log:renderer` → main logger → strideterm.log.
  try {
    (
      window as unknown as { strideterm?: { logRenderer?: (l: string, m: string, x?: unknown) => void } }
    ).strideterm?.logRenderer?.("debug", "sidebar: onActivate clicked", {
      workspaceId,
      prevActiveWsId: store.myActiveWorkspaceId,
      myProfileId: store.myActiveProfileId,
    });
  } catch {
    // logging never throws
  }
  // Show loading overlay before the async round-trip so mobile users have
  // feedback during multi-second activations (the overlay disappears in finally).
  activatingWorkspaceId.value = workspaceId;
  try {
    // Emit immediately so the mobile sidebar drawer closes without waiting for
    // the server round-trip.
    emit("activate", workspaceId);
    await notifications.runWithToast("Activate workspace failed", () => store.activateWorkspace(workspaceId));
  } finally {
    activatingWorkspaceId.value = null;
  }
}

const api = inject<Transport>(apiKey);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleToggleStar(ws: any): void {
  if (!api) return;
  const allWs = store.payload?.appState?.workspaces;
  if (!allWs) return;
  const idx = allWs.findIndex((w) => w.id === ws.id);
  if (idx < 0) return;

  // Optimistic UI update — flip starred immediately
  const nextStarred = !allWs[idx].starred;
  const nextWorkspaces = [...allWs];
  nextWorkspaces[idx] = { ...nextWorkspaces[idx], starred: nextStarred };
  store.payload = {
    ...store.payload,
    appState: { ...store.payload!.appState, workspaces: nextWorkspaces },
  } as StatePayload;

  // Persist in background
  api
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: partial workspace update cast; full type requires all fields
    .saveWorkspace?.({ ...allWs[idx], starred: nextStarred } as any)
    .then((result) => {
      if (result) store.handleBroadcastPayload(result as StatePayload);
    })
    .catch((err) => {
      console.error("[sidebar] toggle star failed:", err);
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleTaskToggle(ws: any): Promise<void> {
  if (!api) return;
  const taskState = ws.taskState;
  try {
    if (
      taskState === "running" ||
      taskState === "evaluating" ||
      taskState === "judge-evaluating" ||
      taskState === "refreshing"
    ) {
      const result = (await api.pauseTask?.({ workspaceId: ws.id })) as { payload?: StatePayload } | undefined;
      if (result?.payload) store.handleBroadcastPayload(result.payload);
    } else if (taskState === "paused") {
      const result = (await api.resumeTask?.({ workspaceId: ws.id })) as
        { ok?: boolean; payload?: StatePayload } | undefined;
      if (result?.payload) store.handleBroadcastPayload(result.payload);
      if (result && result.ok === false) {
        // Krok 7 — surface the failure instead of only console.error.
        const { useNotificationStore } = await import("../../stores/notifications.js");
        useNotificationStore().pushEphemeralToast({
          title: "Could not resume task",
          body: "The task isn't in a state that can be resumed.",
          kind: "error",
          durationMs: 5000,
        });
      }
    } else {
      await store.startTaskWithHookCheck(ws.id);
    }
  } catch (err) {
    console.error("[sidebar] task toggle failed:", err);
    const { useNotificationStore } = await import("../../stores/notifications.js");
    useNotificationStore().pushEphemeralToast({
      title: "Task action failed",
      body: (err as Error)?.message || "Unknown error",
      kind: "error",
      durationMs: 5000,
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleTaskStop(ws: any): Promise<void> {
  if (!api) return;
  try {
    const result = (await api.stopTask?.({ workspaceId: ws.id })) as { payload?: StatePayload } | undefined;
    if (result?.payload) store.handleBroadcastPayload(result.payload);
  } catch (err) {
    console.error("[sidebar] task stop failed:", err);
  }
}

// --- Grid cell IDs set (for inGrid indicator) ---

const gridCellIds = computed<Set<string>>(() => {
  const grid = store.workspaceGrid;
  if (!grid) return new Set();
  return new Set((grid.cellWorkspaceIds as (string | null)[]).filter(Boolean) as string[]);
});

// Cards for the workspaces currently in the grid, in slot order — rendered
// in a dedicated "In split" section at the top of the sidebar so the user
// can immediately see what is grouped vs. standalone. Always sourced from
// the unfiltered workspaceCards so a non-starred grid workspace stays
// visible even with the star filter on (the user explicitly placed it
// in the grid; hiding it would be confusing).
const splitGroupCards = computed<{ slotIndex: number; card: WorkspaceCardData }[]>(() => {
  const grid = store.workspaceGrid;
  if (!grid) return [];
  const ids = grid.cellWorkspaceIds as (string | null)[];
  const cardById = new Map(workspaceCards.value.map((c) => [c.id, c]));
  const out: { slotIndex: number; card: WorkspaceCardData }[] = [];
  ids.forEach((wsId, idx) => {
    if (!wsId) return;
    const card = cardById.get(wsId);
    if (card) out.push({ slotIndex: idx, card });
  });
  return out;
});

// Cards rendered in the regular tree underneath the "In split" group.
// Always returns the full displayed list — grid workspaces stay in their
// original parent/child position so the user can still see the hierarchy.
// Cards that are in the grid get inGrid:true + a slotIndex, which the
// CSS uses to render them as dimmed ghosts (with the slot indicator
// badge). Click on a ghost still works → activateWorkspace focuses the
// matching grid cell.
const treeCards = computed<WorkspaceCardData[]>(() => {
  const occ = gridCellIds.value;
  const slotByWs = new Map<string, number>();
  const grid = store.workspaceGrid;
  if (grid) {
    (grid.cellWorkspaceIds as (string | null)[]).forEach((id, idx) => {
      if (id) slotByWs.set(id, idx + 1);
    });
  }
  return displayedCards.value.map((c) => ({
    ...c,
    inGrid: occ.has(c.id),
    slotIndex: slotByWs.get(c.id),
  }));
});

// --- Workspace actions menu ---

interface WsMenuState {
  x: number;
  y: number;
  ws: Record<string, unknown>;
}
const wsMenu = ref<WsMenuState | null>(null);
const wsMenuRef = ref<HTMLElement | null>(null);

const wsMenuHasChildren = computed<boolean>(() => {
  const ws = wsMenu.value?.ws;
  if (!ws) return false;
  const allWs = store.filteredWorkspaces;
  return allWs.some((w) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = w as any;
    return (
      a.review?.parentWorkspaceId === ws.id ||
      a.quickfix?.parentWorkspaceId === ws.id ||
      a.task?.parentWorkspaceId === ws.id
    );
  });
});

// Any workspace carrying a PR review marker — managed review checkouts as well
// as normal workspaces that were attached to a PR via the inbox's "Attach"
// action. The Git tab only surfaces its detach button for review-locked
// (non-author) checkouts, so without this entry an author-attached workspace
// has no obvious way back out.
const wsMenuIsPrLinked = computed<boolean>(() => {
  const id = wsMenu.value?.ws?.id;
  if (!id) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = store.filteredWorkspaces.find((w) => w.id === id) as any;
  return !!ws?.review?.prKey;
});

function onOpenMenu(event: MouseEvent, ws: Record<string, unknown>): void {
  const btn = (event.target as Element).closest("button");
  if (btn) {
    const rect = btn.getBoundingClientRect();
    wsMenu.value = { x: rect.right + 4, y: rect.top, ws };
  } else {
    wsMenu.value = { x: event.clientX, y: event.clientY, ws };
  }
}

function dismissMenu(): void {
  wsMenu.value = null;
}

function onMenuAction(action: string): void {
  const ws = wsMenu.value?.ws;
  dismissMenu();
  if (!ws) return;
  if (action === "quick-fix") {
    if (ws.kind === "github") store.openGitHubQuickFixWizard();
    else store.openQuickFixWizard();
  } else if (action === "create-worktree") {
    emit("create-worktree", ws.id as string);
  } else if (action === "create-task") {
    emit("create-task", ws.id as string);
  } else if (action === "edit") {
    emit("edit-workspace", ws.id as string);
  } else if (action === "delete") {
    emit("delete-workspace", ws.id as string);
  } else if (action === "force-remove") {
    emit("force-remove-workspace", ws.id as string);
  } else if (action === "open-in-grid") {
    openInGrid(ws.id as string);
  } else if (action === "detach-review") {
    void detachReview(ws.id as string);
  }
}

async function detachReview(workspaceId: string): Promise<void> {
  const confirmed = await store.confirmInApp({
    title: "Detach from PR review?",
    message:
      "Unlink this workspace from its pull request. The Review tab disappears and agent tabs stop being launched with the review MCP bridge; git operations behave like a normal workspace again. The pull request on the server is not touched.",
    confirmLabel: "Detach",
  });
  if (!confirmed) return;
  try {
    await store.detachWorkspaceReview(workspaceId);
  } catch (err) {
    notifications.pushEphemeralToast({
      title: "Detach failed",
      body: (err as Error)?.message || "Could not detach the workspace from its PR review.",
      kind: "error",
      durationMs: 6000,
    });
  }
}

function openInGrid(parentId: string): void {
  const allWs = store.filteredWorkspaces;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = store.payload as any;
  const sessions = payload?.attention?.sessions || {};
  const taskRunner = payload?.taskRunner || {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function wsActivity(w: any): number {
    if (taskRunner[w.id]?.state === "running") return Infinity;
    let latest = 0;
    for (const panel of w.panels || []) {
      for (const key of [`${w.id}:${panel.id}`, panel.id]) {
        const t = sessions[key]?.lastActivity ? new Date(sessions[key].lastActivity).getTime() : 0;
        if (t > latest) latest = t;
      }
    }
    return latest;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children = allWs.filter((w: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = w as any;
    return (
      a.review?.parentWorkspaceId === parentId ||
      a.quickfix?.parentWorkspaceId === parentId ||
      a.task?.parentWorkspaceId === parentId
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any[];

  // Sort children: starred first, then by descending activity
  children.sort((a, b) => {
    const starA = a.starred ? 1 : 0;
    const starB = b.starred ? 1 : 0;
    if (starB !== starA) return starB - starA;
    return wsActivity(b) - wsActivity(a);
  });

  const top3 = children.slice(0, 3).map((w) => w.id);
  const slots: (string | null)[] = [parentId, ...top3];

  // Fill remaining slots with starred workspaces from same profile (not already included)
  if (slots.length < 4) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinned = allWs.filter((w: any) => w.starred && !slots.includes(w.id));
    for (const p of pinned) {
      if (slots.length >= 4) break;
      slots.push(p.id);
    }
  }

  while (slots.length < 4) slots.push(null);
  store.enableWorkspaceGrid("grid", { workspaceIds: slots.slice(0, 4) });
}

// Viewport-clamp the menu
watch(
  wsMenu,
  async (menu) => {
    if (!menu) return;
    await nextTick();
    if (!wsMenuRef.value) return;
    const rect = wsMenuRef.value.getBoundingClientRect();
    let { x, y } = menu;
    let changed = false;
    if (rect.right > window.innerWidth) {
      x = window.innerWidth - rect.width - 4;
      changed = true;
    }
    if (rect.bottom > window.innerHeight) {
      y = window.innerHeight - rect.height - 4;
      changed = true;
    }
    if (changed) wsMenu.value = { ...menu, x, y };
  },
  { flush: "post" },
);

useContextMenu({ isOpen: () => !!wsMenu.value, menuRef: wsMenuRef, onClose: dismissMenu });
</script>
