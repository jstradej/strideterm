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
      v-for="ws in displayedCards"
      :key="ws.id"
      :workspace="ws"
      :data-workspace-id="ws.id"
      @activate="onActivate(ws.id)"
      @open-menu="onOpenMenu($event, ws)"
      @toggle-star="handleToggleStar(ws)"
      @task-toggle="handleTaskToggle(ws)"
      @task-stop="handleTaskStop(ws)"
    />
    <div v-if="suggestions.length" class="workspace-suggestions">
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
        v-if="wsMenu.ws.kind !== 'task'"
        type="button"
        class="context-menu__item"
        title="Spawn a task workspace bound to this project — runs a supervised Worker + Judge AI loop with auto-detected verification commands."
        @click="onMenuAction('create-task')"
      >
        &#x1F916; Create task agent
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
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, inject, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useWorkspaceDragDrop } from "../../composables/useDragDrop.js";
import { buildWorkspaceCards } from "../../app/workspace-render.js";
import type { Transport } from "../../transport.js";
import type { GitSnapshot, StatePayload } from "../../../electron/shared/types/state.js";
import WorkspaceCard from "./WorkspaceCard.vue";

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
const listRef = ref<HTMLElement | null>(null);
const dragDrop = useWorkspaceDragDrop(listRef);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveParentId(ws: any, allWs: any[]): string | null {
  if (ws.review?.checkout?.mode === "managed-worktree" && ws.review?.parentWorkspaceId)
    return ws.review.parentWorkspaceId;
  if (ws.quickfix?.parentWorkspaceId) return ws.quickfix.parentWorkspaceId;
  if (ws.task?.parentWorkspaceId) return ws.task.parentWorkspaceId;
  // Legacy worktree: "Worktree of ParentName" — resolve parent by name (profile-aware)
  if ((ws.notes || "").startsWith("Worktree of ")) {
    const parentName = ws.name.split(" / ")[0];
    const wsProfile = ws.profileId || "default";
    const parent =
      allWs.find((c) => c.name === parentName && c.id !== ws.id && (c.profileId || "default") === wsProfile) ||
      allWs.find((c) => c.name === parentName && c.id !== ws.id);
    return parent?.id || null;
  }
  return null;
}

const workspaceCards = computed((): WorkspaceCardData[] => {
  const payload = store.payload;
  if (!payload) return [];
  const azureDevops = payload.azureDevops as AzureDevopsWithPrs | undefined;
  const github = payload.github as AzureDevopsWithPrs | undefined;
  return buildWorkspaceCards({
    workspaces: store.filteredWorkspaces,
    activeWorkspaceId: payload.appState?.activeWorkspaceId || "",
    getGitSnapshot: (id) => store.getGitSnapshot(id) as GitSnapshot | null | undefined,
    getWorkspaceAttention: (id) => store.getWorkspaceAttentionForId(id) as AttentionLike | null | undefined,
    taskRunnerSnapshot: (payload.taskRunner as Record<string, LiveTask>) || null,
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
        const prData = azureDevops?.pullRequests?.[prKey]?.pullRequest;
        const status = prData?.status;
        if (status === "completed") return { status: "completed", closedDate: prData?.closedDate || undefined };
        if (status === "abandoned") return { status: "abandoned", closedDate: prData?.closedDate || undefined };
        return { status: "active" };
      }
      if (provider === "github") {
        const pr = github?.pullRequests?.[prKey]?.pullRequest;
        if (pr?.mergedAt) return { status: "completed", closedDate: pr.mergedAt };
        if (pr && pr.state !== "open")
          return { status: "abandoned", closedDate: pr.closedAt || pr.updatedAt || undefined };
        return { status: "active" };
      }
      return null;
    },
  }) as WorkspaceCardData[];
});

const hasAnyStarred = computed(() => store.filteredWorkspaces.some((ws) => ws.starred));

// Auto-deactivate star filter when no starred workspaces remain
watch(hasAnyStarred, (has) => {
  if (!has) store.starFilterActive = false;
});

const displayedCards = computed(() => {
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
  (e: "add-plugin-workspace", id: string): void;
  (e: "activate", id: string): void;
  (e: "create-task"): void;
}>();

function onActivate(workspaceId: string): void {
  store.activateWorkspace(workspaceId);
  emit("activate", workspaceId);
}

const api = inject<Transport>("api");

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
      const result = (await api.resumeTask?.({ workspaceId: ws.id })) as { payload?: StatePayload } | undefined;
      if (result?.payload) store.handleBroadcastPayload(result.payload);
    } else {
      await store.startTaskWithHookCheck(ws.id);
    }
  } catch (err) {
    console.error("[sidebar] task toggle failed:", err);
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

// --- Workspace actions menu ---

interface WsMenuState {
  x: number;
  y: number;
  ws: Record<string, unknown>;
}
const wsMenu = ref<WsMenuState | null>(null);
const wsMenuRef = ref<HTMLElement | null>(null);

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
    emit("create-task");
  } else if (action === "edit") {
    emit("edit-workspace", ws.id as string);
  } else if (action === "delete") {
    emit("delete-workspace", ws.id as string);
  }
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

function onDocClick(e: MouseEvent): void {
  if (wsMenuRef.value && !wsMenuRef.value.contains(e.target as Node)) dismissMenu();
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") dismissMenu();
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>
