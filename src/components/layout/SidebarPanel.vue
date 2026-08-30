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
    @pointerenter="lock.onPointerEnter"
    @pointerleave="lock.onPointerLeave"
    @focusin="lock.onFocusIn"
    @focusout="lock.onFocusOut"
  >
    <!-- RUNNING surface: what is working RIGHT NOW and where, on a fixed
         position above the list in BOTH view modes. The canonical tree below
         is untouched — a running workspace also keeps its usual place there —
         but the top RECENT section is disjoint from this one, so the same task
         never fills a slot in both (V5 review, §4). -->
    <RunningAgentsPanel
      v-if="!store.sidebarCollapsed"
      :clusters="presentedRunningClusters"
      :now="recentNow"
      :active-workspace-id="store.myActiveWorkspaceId || ''"
      :attention-counts="recentAttentionCounts"
      :status-cues="workspaceStatusCues"
      @activate="onActivateAgentRow"
    />
    <!-- "In split" group: workspaces currently displayed in the workspace grid.
         SUSPENDED during a search, exactly like RUNNING and RECENT above: an
         unfiltered third shortcut surface would put workspaces that do not
         match the query above the results, and a matching grid workspace would
         appear twice — once here and once in the canonical search tree (V7
         review, §"P2 UX — `IN SPLIT` zůstává během search nefiltrovaný"). It is
         not filtered into a fourth variant of the list: the grid state stays
         readable because the card in the search tree still carries `inGrid` and
         its `slotIndex`, `workspaceGrid` itself is untouched, and clearing the
         query brings the section back in the same slot order. -->
    <div
      v-if="!searchActive && splitGroupCards.length > 0"
      class="workspace-list__split-group"
      data-role="split-group"
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
    <!-- RECENTLY WORKED: compact shortcuts to the workspaces the user really
         worked in during the last 24h, as a minimal activity forest — connected
         results share one cluster and each workspace is drawn exactly once.
         Purely additive: every one of them is also still in the canonical tree
         below, under its real parent. -->
    <div v-if="showRecentShortcuts" class="recent-shortcuts" data-role="recent-shortcuts">
      <p class="eyebrow recent-shortcuts__title">
        <button
          type="button"
          class="recent-shortcuts__toggle"
          :aria-expanded="!recentCollapsed"
          :title="recentCollapsed ? 'Expand recently worked' : 'Collapse recently worked'"
          @click="recentCollapsed = !recentCollapsed"
        >
          <span class="recent-shortcuts__caret" aria-hidden="true">{{ recentCollapsed ? "▸" : "▾" }}</span>
          <span>Recently worked · 24h ({{ recentTotal }})</span>
        </button>
      </p>
      <template v-if="!recentCollapsed">
        <WorkspaceActivityCluster
          v-for="cluster in recentRowsByCluster"
          :key="cluster.key"
          :cluster-key="cluster.key"
          :nodes="cluster.rows"
          @activate="onActivateRecentRow"
        />
        <button
          v-if="hiddenRecentCount > 0"
          type="button"
          class="recent-shortcuts__more"
          data-role="recent-shortcuts-more"
          @click="onToggleRecentExpanded"
        >
          {{ recentExpanded ? "Show less" : `Show ${hiddenRecentCount} more` }}
        </button>
      </template>
      <hr class="workspace-list__divider" />
    </div>
    <!-- ALL WORKSPACES: the canonical tree, always complete. Recent
         workspaces are NOT filtered out of it — doing so would turn the tree
         back into a fragment, with fresh children vanishing from their
         parents. -->
    <!-- ONE heading over the canonical tree, saying which question it is
         answering. During a search that is `Search results (N)` — both dynamic
         surfaces above are suspended, so this projection is the single answer,
         and N counts real MATCHES, never the parents kept for orientation
         (V6 review, §"P2 UX — search má být jeden explicitní režim"). With no
         results there is nothing to head, and the empty state below speaks
         alone.
         Otherwise it is labelled whenever the recent surface is the active
         mode, not merely when it has rows: RUNNING and RECENT are disjoint, so
         a moment where every recent workspace is busy is ordinary — and the
         canonical tree below still deserves its heading. -->
    <p
      v-if="searchActive && !store.sidebarCollapsed && searchMatchCount > 0"
      class="eyebrow recent-shortcuts__all-title"
      data-role="search-results-title"
    >
      Search results ({{ searchMatchCount }})
    </p>
    <p
      v-else-if="isRecentActive && !store.sidebarCollapsed"
      class="eyebrow recent-shortcuts__all-title"
      data-role="all-workspaces-title"
    >
      All workspaces ({{ treeCards.length }})
    </p>
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
import { buildRecentWorkspaceShortcuts, type RecentWorkspaceShortcut } from "../../app/workspace-sidebar-projection.js";
import { resolveParentId } from "../../app/workspace-tree.js";
import { buildActivityForest, type ActivityCluster, type ActivityRowView } from "../../app/workspace-activity-tree.js";
import { formatRelativeAge } from "../../app/relative-age.js";
import { resolveWorkspaceStatusCue, type WorkspaceStatusCue } from "../../app/workspace-status.js";
import type { Transport } from "../../transport.js";
import type { GitSnapshot, StatePayload, WorkspaceState } from "../../../electron/shared/types/state.js";
import { collectSupervisedAgents, type RunningAgentRow } from "../../app/selectors.js";
import {
  mergeRecentRowWhileLocked,
  mergeRunningRowWhileLocked,
  projectPresentedForest,
} from "../../app/sidebar-presented-rows.js";
import { useSidebarInteractionLock } from "../../composables/useSidebarInteractionLock.js";
import WorkspaceCard from "./WorkspaceCard.vue";
import WorkspaceActivityCluster from "./WorkspaceActivityCluster.vue";
import RunningAgentsPanel from "./RunningAgentsPanel.vue";

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

const props = defineProps<{
  /**
   * True while the mobile / narrow sidebar DRAWER is open. `sidebarOpen` lives
   * in App.vue, so it has to be handed down: on a touch drawer the user is
   * already committed to navigating the moment it opens, well before a pointer
   * lands on a row, so the whole open drawer is one interaction and the
   * dynamic surfaces stay frozen for its entire lifetime (V3 review, §2).
   */
  drawerOpen?: boolean;
}>();

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

/**
 * The star filter's TWO roles.
 *
 * `activityIds` is what the user actually pinned: a starred workspace and its
 * descendants. `contextIds` is the ancestors kept only so the canonical tree
 * keeps its shape — without them a starred child would float with no parent.
 *
 * The two used to be one set, and the recent surface took the whole union as
 * its activity allowlist. Star a nested child whose unstarred parent happens to
 * have its own `lastWorkedAt`, and that parent became a full recent ACTIVITY
 * row rather than the orientation row it is (V6 review, §"P2 — star filter
 * směšuje activity scope a context ancestry"). An ancestor that is itself
 * starred, or sits under another starred root, is in `activityIds` already and
 * legitimately keeps its time.
 *
 * `activityIds` is null when the filter is off — "everything qualifies", which
 * is a different statement from "this empty set qualifies".
 */
const starRoles = computed((): { activityIds: Set<string> | null; contextIds: Set<string> } => {
  if (!store.starFilterActive) return { activityIds: null, contextIds: new Set() };
  const allWs = store.filteredWorkspaces;
  const childrenOf = new Map<string, Set<string>>();
  const parentOf = new Map<string, string>();
  for (const ws of allWs) {
    const pid = resolveParentId(ws, allWs);
    if (pid) {
      parentOf.set(ws.id, pid);
      if (!childrenOf.has(pid)) childrenOf.set(pid, new Set());
      (childrenOf.get(pid) as Set<string>).add(ws.id);
    }
  }

  const activityIds = new Set<string>();
  function addDescendants(id: string): void {
    for (const kid of childrenOf.get(id) || []) {
      if (activityIds.has(kid)) continue;
      activityIds.add(kid);
      addDescendants(kid);
    }
  }
  for (const ws of allWs) {
    if (!ws.starred) continue;
    activityIds.add(ws.id);
    addDescendants(ws.id);
  }

  // Ancestors LAST, and never over an id that already earned its activity
  // role: the two sets are roles, not a priority list.
  const contextIds = new Set<string>();
  for (const id of activityIds) {
    let pid = parentOf.get(id);
    const walked = new Set<string>();
    while (pid && !walked.has(pid)) {
      walked.add(pid);
      if (!activityIds.has(pid)) contextIds.add(pid);
      pid = parentOf.get(pid);
    }
  }
  return { activityIds, contextIds };
});

const starFilteredCards = computed(() => {
  const { activityIds, contextIds } = starRoles.value;
  if (!activityIds) return workspaceCards.value;
  return workspaceCards.value.filter((card) => activityIds.has(card.id) || contextIds.has(card.id));
});

// Free-text name filter (sidebar profile row). Matches the query as a
// case-insensitive substring of the workspace name — i.e. *text*. Ancestors of
// a match are kept so an indented child never floats without its parent.
const searchQuery = computed(() => store.workspaceSearchQuery.trim().toLowerCase());

/**
 * SEARCH is its own presentation mode (V6 review, §"P2 UX — search má být jeden
 * explicitní režim, ne Recent plus další seznam").
 *
 * The 15:12 screenshot showed what was missing: the Recent heading simply
 * vanished, the tree below it gained no heading of its own, and RUNNING kept
 * rendering UNFILTERED above the results — so a task that matched the query
 * could appear twice, and nothing on screen said what had happened.
 *
 * So a non-empty query hides BOTH dynamic surfaces and labels the canonical
 * tree as the single answer. It does not touch `sidebarWorkspaceViewMode`:
 * recent mode is SUSPENDED, and clearing the query brings it back in the same
 * collapsed / Show-more state it had.
 */
const searchActive = computed(() => searchQuery.value.length > 0);

/**
 * The two roles again, for the search projection: workspaces whose NAME
 * matched, and the parents kept purely so the matches keep their place in the
 * tree. `SEARCH RESULTS (N)` counts the first kind only.
 *
 * ORDER MATTERS, and it used to be wrong (V7 review, §"P1 UX correctness —
 * star scope a search ancestry se skládají v nesprávném pořadí"). Matches were
 * collected over the whole profile and their ancestry closed first; the star
 * projection closed its own ancestry independently; `displayedCards` then
 * INTERSECTED the two finished closures. Two consequences, both visible:
 *
 *   - a root that sits in both closures survived even when every real match
 *     had been filtered out by the star scope, so the user got a lone parent
 *     with no match under it, no heading (the count was 0) and no empty state
 *     (the tree was not empty);
 *   - an unstarred ancestor present in the star projection only as CONTEXT
 *     could match the query itself and be counted as a genuine result,
 *     although it is not in `activityIds`.
 *
 * So the pipeline is now: scope → match → close. Eligibility is the star
 * filter's ACTIVITY ids alone (the whole profile when the filter is off);
 * ancestry is computed from the SURVIVING matches over the full
 * profile-scoped tree, so a parent returns only as an ancestor of a real
 * result. Star `contextIds` go back to their single meaning — orientation in
 * the canonical star tree — and are never implicitly searchable.
 */
const searchRoles = computed((): { matchIds: Set<string>; contextIds: Set<string> } => {
  const matchIds = new Set<string>();
  const contextIds = new Set<string>();
  const query = searchQuery.value;
  if (!query) return { matchIds, contextIds };
  const allWs = store.filteredWorkspaces;
  const parentOf = new Map<string, string>();
  for (const ws of allWs) {
    const pid = resolveParentId(ws, allWs);
    if (pid) parentOf.set(ws.id, pid);
  }
  // 1. The eligible scope, BEFORE any matching: everything in the profile, or
  //    — with the star filter on — only what the user actually pinned.
  const eligibleIds = starRoles.value.activityIds;
  // 2. Match inside that scope only.
  for (const ws of allWs) {
    if (eligibleIds && !eligibleIds.has(ws.id)) continue;
    if (
      !String(ws.name || "")
        .toLowerCase()
        .includes(query)
    )
      continue;
    matchIds.add(ws.id);
  }
  // 3. Ancestry, from the survivors only, over the full profile-scoped tree —
  //    so a match keeps its place even under a parent the star scope excluded.
  for (const id of matchIds) {
    let pid = parentOf.get(id);
    const walked = new Set<string>();
    while (pid && !walked.has(pid)) {
      walked.add(pid);
      if (!matchIds.has(pid)) contextIds.add(pid);
      pid = parentOf.get(pid);
    }
  }
  return { matchIds, contextIds };
});

// The search runs over the WHOLE profile, narrowed by the star scope that is
// already active — never over the recent list alone. During a search the
// projection comes STRAIGHT from `searchRoles`, not from an intersection with
// `starFilteredCards`: the star scope has already been applied, in step 1
// above, to the matches themselves.
const displayedCards = computed(() => {
  if (!searchActive.value) return starFilteredCards.value;
  const { matchIds, contextIds } = searchRoles.value;
  return workspaceCards.value.filter((card) => matchIds.has(card.id) || contextIds.has(card.id));
});

/**
 * Real matches — what the heading counts. The star scope is already inside
 * `matchIds`, and with no match there is no context either, so
 * `searchMatchCount === 0` and an empty tree are now the same statement: the
 * empty state below is the single thing on screen.
 */
const searchMatchCount = computed(() => searchRoles.value.matchIds.size);

// --- RUNNING agents surface ----------------------------------------------

// The one row model, shared verbatim with the dock's Agents tab and the hero
// chip — SUPERVISED runs only (a task agent or an attached/Companion task), so
// the three surfaces cannot disagree about the count and a plain Claude Code
// turn no longer appears and disappears here (V3 review, Fáze 1). The grid
// goes in as an explicit argument because it is viewer-owned: this window's
// slot numbers must not leak into another window's rows.
//
// This is the LIVE list. What the surface renders is
// `presentedRunningClusters`, which freezes it while the user is aiming.
const liveRunningRows = computed((): RunningAgentRow[] => {
  const payload = store.payload;
  if (!payload) return [];
  return collectSupervisedAgents({
    workspaces: store.filteredWorkspaces as WorkspaceState[],
    taskRunnerSnapshot: (payload.taskRunner as Record<string, { state?: string }>) || null,
    workspaceGrid: store.workspaceGrid,
  });
});

// The same activity-tree projection RECENT uses, so a nested task and a nested
// recent workspace get one hierarchy, one dedupe and one order (V5 review,
// §3). The metric is NEGATED start time: this surface has always put the
// longest-running agent on top — the ten-hour run the user is trying not to
// lose — while the forest sorts by "newest metric first", so an older start
// has to score higher. A row with no start time scores lowest and lands last,
// exactly as before.
const liveRunningClusters = computed((): ActivityCluster<RunningAgentRow>[] => {
  // Search is a single-answer mode: an unfiltered RUNNING section above the
  // results would show a matching task twice and answer a question the user
  // did not ask (V6 review, §"P2 UX — search má být jeden explicitní režim").
  // Suspended at the SOURCE, so the freeze, the shared clock and the section's
  // own visibility all follow from one decision.
  if (searchActive.value) return [];
  return buildActivityForest({
    selected: liveRunningRows.value.map((row) => ({
      key: row.key,
      workspaceId: row.hostWorkspaceId,
      metric: row.startedAtMs ? -row.startedAtMs : Number.NEGATIVE_INFINITY,
      payload: row,
    })),
    workspaces: store.filteredWorkspaces as WorkspaceState[],
  });
});

// Workspaces RUNNING is already speaking for. RECENT subtracts them, so the
// two top sections answer different questions and the limit of seven is spent
// on workspaces the user cannot already see above (V5 review, §4). Taken from
// the LIVE rows: while the lock holds, both presented sections are frozen
// anyway, so the exclusion can only take effect at the same atomic unlock.
const runningWorkspaceIds = computed(() => new Set(liveRunningRows.value.map((row) => row.hostWorkspaceId)));

// Re-uses the sidebar's existing `activate` emit (App.vue closes the mobile
// drawer on it) instead of inventing a reveal API, then navigates through the
// store. Nothing is acknowledged — a running agent is not a notification.
async function onActivateAgentRow(target: { hostWorkspaceId: string; viewId: string }): Promise<void> {
  emit("activate", target.hostWorkspaceId);
  const opened = await notifications.runWithToast("Open workspace failed", () =>
    store.activateWorkspaceInGrid(target.hostWorkspaceId),
  );
  if (!opened) return;
  if (target.viewId) {
    await notifications.runWithToast("Open tab failed", () => store.activateView(target.viewId));
  }
}

// --- "Recently worked" shortcuts -----------------------------------------

const viewMode = computed<"tree" | "recent">(() =>
  (store.activeProfile as { sidebarWorkspaceViewMode?: string } | null)?.sidebarWorkspaceViewMode === "recent"
    ? "recent"
    : "tree",
);

// The recent mode adds a shortcut list ABOVE the canonical tree; it never
// replaces it. An active search SUSPENDS it — two filtered result sets for one
// query would be indistinguishable, so the canonical tree is the single answer
// and it wears the `Search results (N)` heading while the query lasts. The mode
// itself is untouched, so clearing the query brings the section back in the
// same collapsed / Show-more state. The collapsed icon strip suppresses them
// too (see showRecentShortcuts) — two identical icons for the same workspace
// cannot be told apart.
const isRecentActive = computed(() => viewMode.value === "recent" && !searchActive.value);

// One shared minute clock for the recent shortcuts AND the RUNNING surface
// (never per-row), so rows drop out at the 24h boundary without a reload and
// every elapsed advances together. Only ticks while one of the two actually
// needs it and the document is not hidden.
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
// The collapsed icon strip renders neither surface, so a collapsed sidebar
// needs no clock at all.
const needsRecentClock = computed(
  () => !store.sidebarCollapsed && !searchActive.value && (isRecentActive.value || liveRunningRows.value.length > 0),
);
function onRecentClockVisibilityChange(): void {
  if (document.hidden) stopRecentClock();
  else if (needsRecentClock.value) startRecentClock();
}
watch(
  needsRecentClock,
  (needed) => {
    if (needed && !document.hidden) startRecentClock();
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

/**
 * How many shortcuts render before the "Show N more" affordance. The whole
 * point of the section is to stay small enough that the canonical tree is
 * still reachable underneath it.
 */
const DEFAULT_RECENT_VISIBLE_LIMIT = 7;

// Both are transient renderer state, deliberately not persisted: a reload
// starts back at the safe maximum of seven rows.
const recentCollapsed = ref(false);
const recentExpanded = ref(false);

// Ids eligible to be an ACTIVITY, post profile-scope + star filter. With the
// filter on that is the starred scope ONLY: an ancestor kept purely so the
// canonical tree keeps its shape must stay a context row even when it has its
// own `lastWorkedAt` (V6 review, §"P2 — star filter směšuje activity scope a
// context ancestry"). The forest re-adds whatever orientation it needs from
// the full profile-scoped tree, and breadcrumbs still resolve against that
// same list — so a star-filtered-out ancestor is still named.
const recentVisibleIds = computed(() => {
  const { activityIds } = starRoles.value;
  if (activityIds) return new Set(activityIds);
  return new Set(workspaceCards.value.map((card) => card.id));
});

// The COMPLETE qualifying set — never truncated, and MINUS anything RUNNING is
// already showing, so the two top sections stay disjoint. This is the LIVE
// list; what renders is `presentedRecentClusters`, which freezes during
// interaction.
const liveRecentRows = computed((): RecentWorkspaceShortcut[] => {
  if (!isRecentActive.value) return [];
  return buildRecentWorkspaceShortcuts({
    workspaces: store.filteredWorkspaces as WorkspaceState[],
    now: recentNow.value,
    visibleIds: recentVisibleIds.value,
  }).filter((row) => !runningWorkspaceIds.value.has(row.workspaceId));
});

// The limit is applied HERE, to real workspaces, BEFORE the forest adds any
// ancestor context — so seven still means seven workspaces the user worked in,
// however many orientation rows the resulting shape needs (V5 review, §"Limit
// 7 se vždy počítá z activity nodes"). `Show more` widens this set and the
// whole forest is rebuilt from it.
const selectedRecentRows = computed((): RecentWorkspaceShortcut[] =>
  recentExpanded.value ? liveRecentRows.value : liveRecentRows.value.slice(0, DEFAULT_RECENT_VISIBLE_LIMIT),
);

const liveRecentClusters = computed((): ActivityCluster<RecentWorkspaceShortcut>[] =>
  buildActivityForest({
    selected: selectedRecentRows.value.map((row) => ({
      key: row.workspaceId,
      workspaceId: row.workspaceId,
      metric: row.lastWorkedAtMs,
      payload: row,
    })),
    workspaces: store.filteredWorkspaces as WorkspaceState[],
  }),
);

// --- Interaction lock ----------------------------------------------------
//
// A navigation target must not move between the moment the user aims at it and
// the click (V3 review, §2). While the pointer is over the list, the focus is
// inside it, or the mobile drawer is open, both DYNAMIC surfaces keep the
// FOREST they had when the interaction started. Live data still flows into
// rows that are already presented, so attention, active/grid state, a fresher
// `lastWorkedAt` and the elapsed keep updating — none of which changes a row's
// height or position.
//
// The canonical tree is NOT locked: it sits in its manual order and ordinary
// status changes do not move it, so there is nothing to freeze. Explicit user
// commands (Show more, collapsing a section, disbanding the split) are never
// deferred either — the lock only holds back BACKGROUND reflow.
const lock = useSidebarInteractionLock({
  element: listRef,
  drawerOpen: computed(() => props.drawerOpen === true),
});
const interactionLocked = lock.locked;

// The frozen unit is the WHOLE FOREST, not a key order: cluster membership, a
// node's role, the parent-child edges and each row's navigation target are all
// derived from the live workspace list, so holding keys alone would still let
// a background reparent restructure the section under the pointer (V5 review,
// §2, last bullets). `total` is frozen alongside it so the section header
// cannot count something the list is not showing.
const lockedRunning = ref<ActivityCluster<RunningAgentRow>[] | null>(null);
const lockedRecent = ref<{ clusters: ActivityCluster<RecentWorkspaceShortcut>[]; total: number } | null>(null);

/** Take the frozen forest for both surfaces from their live state. */
function freezeSurfaces(): void {
  lockedRunning.value = liveRunningClusters.value;
  lockedRecent.value = { clusters: liveRecentClusters.value, total: liveRecentRows.value.length };
}

watch(
  interactionLocked,
  (isLocked) => {
    if (isLocked) freezeSurfaces();
    else {
      // Unlocking is one atomic step: dropping the frozen forests applies the
      // whole pending set at once, BOTH sections together — which is what makes
      // a task moving between RUNNING and RECENT a single commit rather than
      // two visible hops (V5 review, §4). Deliberately un-animated — an
      // animated reflow is as bad for an accurate click as an instant jump.
      lockedRunning.value = null;
      lockedRecent.value = null;
    }
  },
  // `immediate` matters for the narrow drawer: the sidebar can mount with
  // `drawerOpen` ALREADY true, and that open drawer is one interaction from
  // its very first frame.
  { immediate: true },
);

// An explicit user command lands immediately — the lock only holds back
// BACKGROUND reflow. Typing a search query, toggling the star filter,
// collapsing the sidebar and switching the view mode are all commands the user
// just gave, and they change which rows may exist at all. So instead of being
// deferred they RE-FREEZE both surfaces from their new live state, which
// becomes the baseline the rest of the interaction holds still. Without this,
// a search typed while the mouse happened to rest over the list would leave
// the stale shortcut list on screen next to the filtered tree — two answers to
// one query, which is exactly what the single-result-set rule forbids.
watch([() => store.workspaceSearchQuery, () => store.starFilterActive, () => store.sidebarCollapsed, viewMode], () => {
  if (interactionLocked.value) freezeSurfaces();
});

// Switching the ACTIVE PROFILE is the largest explicit command of them all: it
// replaces the whole workspace set. Deferring it was the worst case of the
// lock's reach — a narrow drawer holds the lock for its entire lifetime, so the
// old profile's rows stayed on screen and then decayed into `gone` placeholders
// as they fell out of `liveWorkspaceIds`, and the new profile only appeared
// once the drawer closed (V4 review, §"P2 — změna aktivního profilu"). The
// snapshot is rebuilt synchronously from the NEW profile, so no row of the old
// one survives in the frozen maps.
watch(
  () => store.myActiveProfileId,
  () => {
    // Every profile starts from the safe default of at most seven rows rather
    // than inheriting a "Show more" the user expanded in another one.
    recentExpanded.value = false;
    if (interactionLocked.value) freezeSurfaces();
  },
);

// Ids that still exist for this viewer — the test that separates "the run
// finished / the item aged out" (keep showing the frozen row) from "the
// workspace was hard-deleted" (show an inert, equally tall placeholder).
const liveWorkspaceIds = computed(() => new Set(store.filteredWorkspaces.map((ws) => ws.id)));

// `mergePayloadWhileLocked` is what makes the lock hold the ROW and not just
// its slot: while frozen, a node keeps its structure, its geometry and its
// navigation target, and only the values that render in reserved,
// dimension-stable slots keep flowing (V4 review, §"P2 — lock drží key a
// pořadí, ale ne strukturální význam stejného řádku").
const presentedRunningClusters = computed(() =>
  projectPresentedForest({
    live: liveRunningClusters.value,
    lockedForest: lockedRunning.value,
    isAlive: (node) => liveWorkspaceIds.value.has(node.workspaceId),
    mergePayloadWhileLocked: mergeRunningRowWhileLocked,
  }),
);

const presentedRecentClusters = computed(() =>
  projectPresentedForest({
    live: liveRecentClusters.value,
    lockedForest: lockedRecent.value?.clusters || null,
    isAlive: (node) => liveWorkspaceIds.value.has(node.workspaceId),
    mergePayloadWhileLocked: mergeRecentRowWhileLocked,
  }),
);

/** Recent workspaces in the window — the header's count, frozen with the list. */
const recentTotal = computed(() => lockedRecent.value?.total ?? liveRecentRows.value.length);

// The section only exists when it has something to show, and never in the
// collapsed icon strip. Driven by the PRESENTED forest so a frozen row cannot
// have its whole section pulled out from under it. The canonical tree below is
// unconditional.
const showRecentShortcuts = computed(() => !store.sidebarCollapsed && presentedRecentClusters.value.length > 0);

const hiddenRecentCount = computed(() => Math.max(0, recentTotal.value - DEFAULT_RECENT_VISIBLE_LIMIT));

/**
 * The recent forest as rows. Identity (accent, summary), active/grid state and
 * attention are joined from the ONE canonical `workspaceCards` mapping, so a
 * recent row is literally its tree card's twin; the hierarchy comes from the
 * forest, so this maps content only.
 */
const recentRowsByCluster = computed((): { key: string; rows: ActivityRowView[] }[] =>
  presentedRecentClusters.value.map((cluster) => ({
    key: cluster.key,
    rows: cluster.nodes.map((node): ActivityRowView => {
      const identity = recentCardIdentity.value.get(node.workspaceId);
      // Present on CONTEXT rows too when that parent has a state of its own —
      // the parent's dot is exactly as informative here as it is on its card.
      const statusCue = workspaceStatusCues.value.get(node.workspaceId) || null;
      // Named, never colour-only (V6 review, §"P2 UX", oprava 6).
      const status = statusCue ? ` — ${statusCue.label}` : "";
      const base = {
        key: node.key,
        workspaceId: node.workspaceId,
        depth: node.depth,
        icon: node.icon,
        color: identity?.color || node.color,
        active: node.workspaceId === store.myActiveWorkspaceId,
        attentionCount: recentAttentionCounts.value.get(node.workspaceId) || 0,
        statusCue,
        missing: node.missing,
      };
      if (node.role === "context") {
        const label = node.path.join(" › ");
        // The visible breadcrumb can be ellipsised by a narrow sidebar; the
        // accessible name spells out the whole chain, so two workspaces that
        // share a name are still told apart.
        const where = node.fullPath.join(" › ");
        return {
          ...base,
          role: "context" as const,
          label,
          ariaLabel: node.missing ? `${where} — no longer available` : `Open ${where}${status}`,
          title: node.missing
            ? `${where} — this workspace is no longer available.`
            : `${where} — click to open this workspace.${statusCue ? ` ${statusCue.label}.` : ""}`,
        };
      }
      const row = node.payload as RecentWorkspaceShortcut;
      const path = node.fullPath.join(" › ");
      const relativeAge = formatRelativeAge(row.lastWorkedAt, recentNow.value);
      // formatRelativeAge says "now" for anything under a minute, which does
      // not read as a duration — spell that case out instead of "now ago".
      const when = relativeAge === "now" ? "just now" : `${relativeAge} ago`;
      const slotIndex = gridSlotByWorkspace.value.get(node.workspaceId);
      const ariaLabel = node.missing
        ? `${row.name} — no longer available, ${path}`
        : `${row.name} — worked in ${when}, in ${path}${slotIndex ? `, grid slot ${slotIndex}` : ""}${status}`;
      return {
        ...base,
        role: "activity" as const,
        label: row.name,
        summary: identity?.summary || "",
        trailing: relativeAge,
        inGrid: gridCellIds.value.has(node.workspaceId),
        slotIndex,
        ariaLabel,
        // The tooltip IS the accessible name here: the row's own label can be
        // ellipsised by a narrow sidebar, and both readings should then give
        // the same complete path and time.
        title: ariaLabel,
      };
    }),
  })),
);

function onActivateRecentRow(node: ActivityRowView): void {
  // Opening a workspace is navigation, not work — nothing here stamps
  // `lastWorkedAt`, so a click can never reorder the list it was made in.
  void onActivate(node.workspaceId);
}

/** `Show more` changes which ACTIVITIES are selected, so the forest is rebuilt
 *  from the new set — an explicit command lands now, like every other one. */
function onToggleRecentExpanded(): void {
  recentExpanded.value = !recentExpanded.value;
  if (interactionLocked.value) freezeSurfaces();
}

// Card identity for a recent shortcut, joined from the ONE canonical
// `workspaceCards` mapping rather than re-derived — so the accent colour and
// the short summary are literally the tree card's (V3 review, §3).
const recentCardIdentity = computed((): Map<string, { color: string; summary: string }> => {
  const byId = new Map<string, { color: string; summary: string }>();
  for (const card of workspaceCards.value) {
    byId.set(card.id, { color: String(card.color || ""), summary: String(card.summary || "") });
  }
  return byId;
});

// The canonical status dot per workspace — the same `{ state, label,
// heartbeat }` the tree card draws, from the SAME card mapping and the SAME
// resolver (V6 review, §"P2 UX — Recent zahazuje kanonický status dot").
// Recent joins it here and RUNNING gets it as a prop, so there is exactly one
// place that decides what a workspace's state is.
//
// It is deliberately NOT an input to membership, ordering or `lastWorkedAt`:
// a plain Claude Code session flipping running/done still stays out of the
// task-only RUNNING section, and only ever changes a pixel-stable overlay.
const workspaceStatusCues = computed((): Map<string, WorkspaceStatusCue> => {
  const cues = new Map<string, WorkspaceStatusCue>();
  for (const card of workspaceCards.value) {
    // `workspaceCards` is typed with an index signature here, so the four
    // fields the resolver reads are narrowed at the boundary. This is a shape
    // adapter, not a second mapping — every condition still lives in
    // `resolveWorkspaceStatusCue`.
    const cue = resolveWorkspaceStatusCue({
      kind: card.kind === undefined ? undefined : String(card.kind),
      taskState: card.taskState == null ? null : String(card.taskState),
      prStatus: card.prStatus == null ? null : String(card.prStatus),
      agentActivityState: card.agentActivityState == null ? null : String(card.agentActivityState),
      agentActivityLabel: card.agentActivityLabel === undefined ? undefined : String(card.agentActivityLabel),
    });
    if (cue) cues.set(card.id, cue);
  }
  return cues;
});

// Grid slot number per workspace, 1-based to match what the cards show.
const gridSlotByWorkspace = computed((): Map<string, number> => {
  const slots = new Map<string, number>();
  const grid = store.workspaceGrid;
  if (grid) {
    (grid.cellWorkspaceIds as (string | null)[]).forEach((id, idx) => {
      if (id) slots.set(id, idx + 1);
    });
  }
  return slots;
});

// Attention counts for the recent rows — a subtle indicator only, never a
// membership or ordering input.
const recentAttentionCounts = computed((): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const card of workspaceCards.value) {
    if (card.attentionCount > 0) counts.set(card.id, card.attentionCount);
  }
  return counts;
});

// Drag-and-drop reordering belongs to the manually ordered canonical tree,
// which is now present in BOTH view modes — so the listeners are no longer
// gated on the mode. A recent shortcut is neither a drag source nor a drop
// target: it is a plain button outside `.workspace-card`, and any drag event
// originating in or landing on the shortcut list is dropped here.
function onListDragstart(event: DragEvent): void {
  if (isRecentRowEvent(event)) return;
  dragDrop.onDragstart(event);
}
function onListDragover(event: DragEvent): void {
  if (isRecentRowEvent(event)) return;
  dragDrop.onDragover(event);
}
function onListDragleave(event: DragEvent): void {
  if (isRecentRowEvent(event)) return;
  dragDrop.onDragleave(event);
}
function onListDrop(event: DragEvent): void {
  if (isRecentRowEvent(event)) return;
  dragDrop.onDrop(event);
}
function onListDragend(): void {
  dragDrop.onDragend();
}

/** True for any drag event that started on, or is over, a recent shortcut. */
function isRecentRowEvent(event: DragEvent): boolean {
  const target = event.target as Element | null;
  return Boolean(target?.closest?.(".recent-shortcuts"));
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

/** Write `starred` back onto one workspace in the local payload, by id. */
function setStarredLocally(workspaceId: string, starred: boolean): void {
  const allWs = store.payload?.appState?.workspaces;
  if (!allWs) return;
  const idx = allWs.findIndex((w) => w.id === workspaceId);
  if (idx < 0 || !!allWs[idx].starred === starred) return;
  const nextWorkspaces = [...allWs];
  nextWorkspaces[idx] = { ...nextWorkspaces[idx], starred };
  store.payload = {
    ...store.payload,
    appState: { ...store.payload!.appState, workspaces: nextWorkspaces },
  } as StatePayload;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleToggleStar(ws: any): void {
  if (!api) return;
  const allWs = store.payload?.appState?.workspaces;
  if (!allWs) return;
  const idx = allWs.findIndex((w) => w.id === ws.id);
  if (idx < 0) return;

  // Optimistic UI update — flip starred immediately
  const previousStarred = !!allWs[idx].starred;
  const nextStarred = !previousStarred;
  setStarredLocally(ws.id, nextStarred);

  // Starring is an explicit command, so its consequences land now rather than
  // at unlock. Under an active star filter an unstar REMOVES the workspace
  // from both surfaces, and a frozen recent list would otherwise keep showing
  // it until the pointer left the sidebar (V4 review, §"P2 — explicitní
  // unstar"). The re-freeze is bound to this local action only: watching
  // `starred` membership globally would reintroduce exactly the background
  // reflow the lock exists to block.
  if (interactionLocked.value) freezeSurfaces();

  // Persist in background
  api
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: partial workspace update cast; full type requires all fields
    .saveWorkspace?.({ ...allWs[idx], starred: nextStarred } as any)
    .then((result) => {
      if (result) store.handleBroadcastPayload(result as StatePayload);
    })
    .catch((err) => {
      console.error("[sidebar] toggle star failed:", err);
      // The optimistic flip never made it to disk — put it back, and re-freeze
      // so the frozen list tells the truth about what is starred again.
      setStarredLocally(ws.id, previousStarred);
      if (interactionLocked.value) freezeSurfaces();
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
