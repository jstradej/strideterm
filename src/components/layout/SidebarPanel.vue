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
        @click="onMenuAction('quick-fix')"
      >
        &#x1FA84; New branch
      </button>
      <button
        v-if="wsMenu.ws.gitAvailable"
        type="button"
        class="context-menu__item"
        @click="onMenuAction('create-worktree')"
      >
        &#x1F33F; New worktree
      </button>
      <button
        v-if="wsMenu.ws.kind !== 'task'"
        type="button"
        class="context-menu__item"
        @click="onMenuAction('create-task')"
      >
        &#x1F916; Create task agent
      </button>
      <div class="context-menu__divider"></div>
      <button type="button" class="context-menu__item" @click="onMenuAction('edit')">&#x270E; Edit</button>
      <button type="button" class="context-menu__item context-menu__item--danger" @click="onMenuAction('delete')">
        &#x2715; Delete
      </button>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, ref, inject, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useWorkspaceDragDrop } from "../../composables/useDragDrop.js";
import { buildWorkspaceCards } from "../../app/workspace-render.js";
import WorkspaceCard from "./WorkspaceCard.vue";

const store = useAppStore();
const listRef = ref(null);
const dragDrop = useWorkspaceDragDrop(listRef);

function resolveParentId(ws, allWs) {
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

const workspaceCards = computed(() => {
  const payload = store.payload;
  if (!payload) return [];
  return buildWorkspaceCards({
    workspaces: store.filteredWorkspaces,
    activeWorkspaceId: payload.appState?.activeWorkspaceId || "",
    getGitSnapshot: (id) => store.getGitSnapshot(id),
    getWorkspaceAttention: (id) => store.getWorkspaceAttentionForId(id),
    taskRunnerSnapshot: payload.taskRunner || null,
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
  // Collect visible IDs
  const visible = new Set();
  for (const ws of allWs) {
    if (!ws.starred) continue;
    visible.add(ws.id);
    const pid = parentOf.get(ws.id);
    // Starred child → show parent too
    if (pid) visible.add(pid);
    // Starred parent → show all children
    const kids = childrenOf.get(ws.id);
    if (kids) for (const kid of kids) visible.add(kid);
  }
  return workspaceCards.value.filter((card) => visible.has(card.id));
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

const emit = defineEmits([
  "create-worktree",
  "edit-workspace",
  "delete-workspace",
  "add-plugin-workspace",
  "activate",
  "create-task",
]);

function onActivate(workspaceId) {
  store.activateWorkspace(workspaceId);
  emit("activate", workspaceId);
}

const api = inject("api");

function handleToggleStar(ws) {
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
    appState: { ...store.payload.appState, workspaces: nextWorkspaces },
  };

  // Persist in background
  api
    .saveWorkspace({ ...allWs[idx], starred: nextStarred })
    .then((result) => {
      if (result) store.handleBroadcastPayload(result);
    })
    .catch((err) => {
      console.error("[sidebar] toggle star failed:", err);
    });
}

async function handleTaskToggle(ws) {
  if (!api) return;
  const taskState = ws.taskState;
  try {
    if (
      taskState === "running" ||
      taskState === "evaluating" ||
      taskState === "judge-evaluating" ||
      taskState === "refreshing"
    ) {
      const result = await api.pauseTask({ workspaceId: ws.id });
      if (result?.payload) store.handleBroadcastPayload(result.payload);
    } else if (taskState === "paused") {
      const result = await api.resumeTask({ workspaceId: ws.id });
      if (result?.payload) store.handleBroadcastPayload(result.payload);
    } else {
      await store.startTaskWithHookCheck(ws.id);
    }
  } catch (err) {
    console.error("[sidebar] task toggle failed:", err);
  }
}

async function handleTaskStop(ws) {
  if (!api) return;
  try {
    const result = await api.stopTask({ workspaceId: ws.id });
    if (result?.payload) store.handleBroadcastPayload(result.payload);
  } catch (err) {
    console.error("[sidebar] task stop failed:", err);
  }
}

// --- Workspace actions menu ---

const wsMenu = ref(null); // { x, y, ws }
const wsMenuRef = ref(null);

function onOpenMenu(event, ws) {
  const btn = event.target.closest("button");
  if (btn) {
    const rect = btn.getBoundingClientRect();
    wsMenu.value = { x: rect.right + 4, y: rect.top, ws };
  } else {
    wsMenu.value = { x: event.clientX, y: event.clientY, ws };
  }
}

function dismissMenu() {
  wsMenu.value = null;
}

function onMenuAction(action) {
  const ws = wsMenu.value?.ws;
  dismissMenu();
  if (!ws) return;
  if (action === "quick-fix") {
    if (ws.kind === "github") store.openGitHubQuickFixWizard();
    else store.openQuickFixWizard();
  } else if (action === "create-worktree") {
    emit("create-worktree", ws.id);
  } else if (action === "create-task") {
    emit("create-task");
  } else if (action === "edit") {
    emit("edit-workspace", ws.id);
  } else if (action === "delete") {
    emit("delete-workspace", ws.id);
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

function onDocClick(e) {
  if (wsMenuRef.value && !wsMenuRef.value.contains(e.target)) dismissMenu();
}
function onKeydown(e) {
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
