<template>
  <div
    ref="stripRef"
    class="tab-strip"
    :class="{ 'tab-strip--compact': compact }"
    data-role="tab-strip"
    @dragover.prevent="!compact && dragDrop.onDragover($event)"
    @dragleave="!compact && dragDrop.onDragleave($event)"
    @drop="!compact && dragDrop.onDrop($event)"
    @dragend="!compact && dragDrop.onDragend()"
  >
    <button
      v-for="tab in tabModels"
      :key="tab.id"
      type="button"
      class="tab"
      :class="{
        'tab--active': tab.active,
        'tab--grouped': tab.grouped,
        'tab--attention': tab.attention,
        'tab--attention-fresh': tab.attentionFresh,
        [`tab--${tab.tone}`]: true,
      }"
      :data-view-id="tab.id"
      :data-persistent="tab.persistent ? 'true' : 'false'"
      :title="tab.titleTooltip"
      :draggable="!compact && tab.persistent"
      @click="activateTab(tab.id)"
      @dblclick="!compact && tab.persistent && $emit('edit-tab', tab.id)"
      @dragstart="!compact && dragDrop.onDragstart($event)"
      @contextmenu.prevent="
        !compact && $emit('contextmenu-tab', { x: $event.clientX, y: $event.clientY, viewId: tab.id })
      "
    >
      <span>{{ tab.title }}</span>
      <small
        v-if="tab.taskBadge && tab.companionWorkspaceId"
        class="tab__task-badge tab__task-badge--linked"
        :title="tab.taskTooltip"
        @click.stop="goToCompanionLoop(tab.companionWorkspaceId)"
        >{{ tab.taskBadge }}</small
      >
      <small v-else-if="tab.taskBadge" class="tab__task-badge" :title="tab.taskTooltip">{{ tab.taskBadge }}</small>
      <small v-else>{{ tab.status }}</small>
      <span v-if="tab.attention" class="tab__attention" :title="tab.attentionTooltip">🔔</span>
      <span v-if="tab.notes" class="tab__notes" :title="tab.notes">📝</span>
      <span
        v-if="!compact"
        class="tab__menu"
        title="Open the tab actions menu (Focus, Edit, Save scrollback, Clear, Restart, Close, split moves) — same options as the right-click context menu but reachable on touch devices."
        @click.stop="onMenuClick($event, tab.id)"
        >☰</span
      >
    </button>

    <button
      v-if="compact"
      ref="compactPickerBtnRef"
      type="button"
      class="tab-strip-compact-picker__trigger"
      :title="`Switch tab — current: ${compactPickerLabel}`"
      @click.stop="toggleCompactPicker"
    >
      <span class="tab-strip-compact-picker__label">{{ compactPickerLabel }}</span>
      <span class="tab-strip-compact-picker__icon" aria-hidden="true">☰</span>
    </button>

    <Teleport v-if="compact" to="body">
      <div v-if="compactPickerOpen" class="tab-strip-compact-picker__backdrop" @click="closeCompactPicker"></div>
      <div v-if="compactPickerOpen" class="tab-strip-compact-picker__dropdown" :style="compactPickerStyle">
        <button
          v-for="tab in tabModels"
          :key="tab.id"
          type="button"
          class="tab-strip-compact-picker__item"
          :class="{
            'tab-strip-compact-picker__item--active': tab.active,
            'tab-strip-compact-picker__item--menu-target': compactContextMenuViewId === tab.id,
          }"
          :title="tab.titleTooltip"
          @click="activateTabFromCompactPicker(tab.id)"
        >
          <span class="tab-strip-compact-picker__item-title">{{ tab.title }}</span>
          <small
            v-if="tab.taskBadge && tab.companionWorkspaceId"
            class="tab-strip-compact-picker__item-status tab__task-badge--linked"
            :title="tab.taskTooltip"
            @click.stop="goToCompanionLoop(tab.companionWorkspaceId)"
            >{{ tab.taskBadge }}</small
          >
          <small v-else-if="tab.taskBadge" class="tab-strip-compact-picker__item-status">{{ tab.taskBadge }}</small>
          <small v-else class="tab-strip-compact-picker__item-status">{{ tab.status }}</small>
          <span v-if="tab.notes" :title="tab.notes">📝</span>
          <span
            class="tab-strip-compact-picker__item-menu"
            title="Open the tab actions menu."
            @click.stop="openCompactTabMenu($event, tab.id)"
            >☰</span
          >
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { useTabDragDrop } from "../../composables/useDragDrop.js";
import { isFreshAlert, tabAttentionTitle } from "../../app/helpers.js";
import { tabSessionId } from "../../app/selectors.js";
import {
  companionPrimaryHostedPanelIds,
  resolveCompanionPrimaryBinding,
} from "../../../electron/shared/companion-primary.js";

interface TaskRunnerState {
  workerPanelId?: string;
  judgePanelId?: string;
  state?: string;
  currentRound?: number;
  maxRounds?: number;
  mode?: string;
  workerWorkspaceId?: string;
  companionRole?: string;
}

// Short badge labels for a companion loop attached to a tab in a DIFFERENT
// (source) workspace — plan §3.5/§9.1 "role-aware badge (Review R2, Plan R2,
// Consult R2, Critique R2)".
const COMPANION_BADGE_LABELS: Record<string, string> = {
  reviewer: "Review",
  planner: "Plan",
  consultant: "Consult",
  critic: "Critique",
};

interface AttentionAlert {
  title?: string;
  kind?: string;
  exitCode?: number;
  at?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const props = withDefaults(
  defineProps<{
    compact?: boolean;
    workspaceId?: string;
  }>(),
  { compact: false, workspaceId: undefined },
);

const store = useAppStore();
const termStore = useTerminalStore();
const notifications = useNotificationStore();
const stripRef = ref<HTMLElement | null>(null);
const compactPickerBtnRef = ref<HTMLButtonElement | null>(null);
const compactPickerOpen = ref(false);
const compactContextMenuViewId = ref<string | null>(null);
const compactPickerAnchor = ref<{
  left: number;
  right: number;
  bottom: number;
  width: number;
} | null>(null);
const dragDrop = useTabDragDrop(stripRef);

// In compact mode for a non-active workspace, derive minimal tab models from persisted panels.
//
// Tab IDs MUST be the full `${wsId}:${panelId}` session-id form, not the bare
// panelId. The id is the value passed to `store.activateView(...)` on click,
// and activateView routes it to backend `activateSession`, which calls
// parseSessionId — that helper requires the workspace prefix. A bare panelId
// is rejected, the backend returns the unchanged payload, and the cell's
// pane never switches. (Also makes the `active` flag work at all: the
// persisted `wsEntry.activeViewId` is itself the full session-id form, so
// comparing it against the bare panelId always returned false.)
const compactTabModels = computed(() => {
  if (!props.compact || !props.workspaceId) return null;
  const wsId = props.workspaceId;
  const activeWsId = store.myActiveWorkspaceId;
  // If this cell is the active workspace, the normal tabModels computation handles it.
  if (wsId === activeWsId) return null;
  const workspaces = (store.payload as AnyApi)?.appState?.workspaces || [];
  const taskRunner = (store.payload as AnyApi)?.taskRunner || null;
  const wsEntry = workspaces.find((w: AnyApi) => w.id === wsId);
  if (!wsEntry) return [];
  const activeViewId = wsEntry.activeViewId || null;
  const panels: AnyApi[] = wsEntry.panels || [];
  // Same Companion Primary projection as the main strip — without it a grid
  // cell would keep showing the source tab that has moved, and would omit the
  // borrowed Primary from the cell it moved into.
  const hostedElsewhere = companionPrimaryHostedPanelIds(workspaces, taskRunner, wsId);
  const models = panels
    .filter((p: AnyApi) => !hostedElsewhere.has(p.id))
    .map((p: AnyApi) => {
      const viewId = `${wsId}:${p.id}`;
      return {
        id: viewId,
        sessionId: viewId,
        title: p.title || p.id,
        status: "",
        tone: "idle",
        active: viewId === activeViewId,
        grouped: false,
        persistent: true,
        closable: true,
        borrowed: false,
        attention: false,
        attentionFresh: false,
        attentionTooltip: "",
        taskBadge: "",
        taskTooltip: "",
        companionWorkspaceId: "",
        companionRoleLabel: "",
        notes: (p.notes as string) || "",
        titleTooltip: p.title || p.id,
      };
    });

  const binding = resolveCompanionPrimaryBinding(workspaces, taskRunner, wsId);
  if (binding) {
    models.splice(panels[0]?.command === "__task-dashboard__" ? 1 : 0, 0, {
      id: binding.viewId,
      sessionId: binding.sourceSessionId,
      title: "Primary",
      status: "",
      tone: "idle",
      active: binding.viewId === activeViewId,
      grouped: false,
      persistent: false,
      closable: false,
      borrowed: true,
      attention: false,
      attentionFresh: false,
      attentionTooltip: "",
      taskBadge: "",
      taskTooltip: "",
      companionWorkspaceId: "",
      companionRoleLabel: "",
      notes: "",
      titleTooltip: `Primary conversation — ${binding.sourcePanelTitle} in ${binding.sourceWorkspaceName}.`,
    });
  }
  return models;
});

const tabModels = computed(() => {
  if (compactTabModels.value !== null) return compactTabModels.value;

  const tabs = store.workspaceTabs;
  const activeViewId = store.activeViewId;
  const splitGroup = store.splitGroup;
  const splitVisible = store.visibleTabs.length > 1;

  const workspace = store.activeWorkspace;
  const taskState = store.payload?.taskRunner?.[workspace?.id] as TaskRunnerState | undefined;

  return tabs.map((tab) => {
    // Attention stays owned by the SOURCE session even when the tab is drawn
    // in another workspace — look it up by owner workspace + real session id.
    const sessionId = tabSessionId(tab);
    const tabAttention = store.getTabAttentionForView(tab.ownerWorkspaceId || workspace?.id || "", sessionId) as
      AttentionAlert | null | undefined;

    // Task runner badge for worker/judge panels
    let taskBadge = "";
    let taskTooltip = "";
    if (taskState && workspace?.task && !tab.borrowed) {
      const panelId = tab.id.includes(":") ? tab.id.split(":").pop() : tab.id;
      if (panelId === taskState.workerPanelId || panelId === taskState.judgePanelId) {
        const role = panelId === taskState.workerPanelId ? "Worker" : "Judge";
        const s = taskState.state;
        if (s === "running") taskBadge = `R${taskState.currentRound}`;
        else if (s === "evaluating") taskBadge = "...";
        else if (s === "judge-evaluating")
          taskBadge = panelId === taskState.judgePanelId ? "..." : `R${taskState.currentRound}`;
        else if (s === "refreshing") taskBadge = "\u21BB";
        else if (s === "completed") taskBadge = "\u2713";
        else if (s === "failed") taskBadge = "\u2717";
        else if (s === "paused") taskBadge = "||";
        taskTooltip = `${role} \u2014 ${s} (round ${taskState.currentRound}/${taskState.maxRounds})`;
      }
    }

    // Companion loop attached to THIS tab from a different (task) workspace:
    // the source Primary tab gets a small linked badge so it's obvious the
    // tab is being driven by an attached Reviewer/Planner/Consultant/Critic
    // loop elsewhere (plan section 3.5/9.1).
    let companionWorkspaceId = "";
    let companionRoleLabel = "";
    // A borrowed Primary is ALREADY inside its companion task workspace — the
    // "back to the loop" badge would point at the workspace it is drawn in.
    if (!taskBadge && workspace && !tab.borrowed) {
      const panelId = tab.id.includes(":") ? tab.id.split(":").pop() : tab.id;
      const allWorkspaces = store.payload?.appState?.workspaces || [];
      const companionWs = allWorkspaces.find(
        (w) =>
          w.kind === "task" &&
          w.task?.mode === "attached" &&
          w.task.workerWorkspaceId === workspace.id &&
          w.task.workerPanelId === panelId,
      );
      if (companionWs) {
        const companionState = store.payload?.taskRunner?.[companionWs.id] as TaskRunnerState | undefined;
        const s = companionState?.state || companionWs.task?.state || "idle";
        const round = companionState?.currentRound ?? companionWs.task?.currentRound ?? 0;
        const roleLabel = COMPANION_BADGE_LABELS[companionWs.task?.companionRole || "reviewer"];
        if (s === "awaiting-user") taskBadge = "Waiting for you";
        else if (s === "capturing-context") taskBadge = "Capturing\u2026";
        else if (s === "brief-ready") taskBadge = "Brief ready";
        else if (s === "completed") taskBadge = `${roleLabel} \u2713`;
        else if (s === "failed") taskBadge = `${roleLabel} \u2717`;
        else if (s === "paused") taskBadge = `${roleLabel} ||`;
        else taskBadge = `${roleLabel} R${round}`;
        taskTooltip = `Back to ${roleLabel} loop \u2014 ${s}`;
        // Mobile has no automatic split, so this badge doubles as the only
        // return path back to the loop besides browser Back (plan \u00a79.1).
        companionWorkspaceId = companionWs.id;
        companionRoleLabel = roleLabel;
      }
    }

    // When the tab has an attention alert, the bell already conveys
    // "agent needs input". Keeping the activity chip visible ("running")
    // contradicts that — suppress the chip so the bell speaks alone.
    const suppressStatus = !!tabAttention;
    return {
      id: tab.id,
      sessionId,
      title: tab.title,
      status: suppressStatus ? "" : tab.status,
      tone: suppressStatus ? "idle" : tab.tone,
      active: tab.id === activeViewId,
      grouped: splitVisible && tab.id !== activeViewId && (splitGroup?.viewIds.includes(tab.id) || false),
      persistent: !!tab.persistent,
      closable: tab.closable !== false,
      borrowed: !!tab.borrowed,
      attention: !!tabAttention,
      attentionFresh: isFreshAlert(tabAttention),
      attentionTooltip: tabAttentionTitle(tabAttention),
      taskBadge,
      taskTooltip,
      companionWorkspaceId,
      companionRoleLabel,
      // Free-text scratchpad from the tab's context menu. Surfaced as a 📝
      // marker so a workspace full of tabs shows which ones carry a note
      // without opening each one.
      notes:
        ((store.getPanelByViewId(tab.id) as { panel?: { notes?: string } } | undefined)?.panel?.notes as string) || "",
      titleTooltip:
        taskTooltip ||
        tabAttentionTitle(tabAttention) ||
        tab.tooltip ||
        (tab.persistent
          ? "Double click to edit. Drag to reorder."
          : `${tab.title}${tab.status ? `\n${tab.status}` : ""}`),
    };
  });
});

const activeTabModel = computed(() => tabModels.value.find((tab) => tab.active) || tabModels.value[0] || null);
const compactPickerLabel = computed(() => activeTabModel.value?.title || "Tabs");
const compactPickerStyle = computed(() => {
  const anchor = compactPickerAnchor.value;
  if (!anchor) return {};
  const viewportWidth = typeof window === "undefined" ? 320 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 480 : window.innerHeight;
  const width = Math.min(Math.max(anchor.width, 180), Math.max(180, viewportWidth - 8));
  const left = Math.min(Math.max(4, anchor.right - width), Math.max(4, viewportWidth - width - 4));
  const top = Math.min(anchor.bottom + 4, Math.max(4, viewportHeight - 8));
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(120, viewportHeight - top - 8)}px`,
  };
});

const emit = defineEmits<{
  (e: "edit-tab", viewId: string): void;
  (e: "contextmenu-tab", payload: { x: number; y: number; viewId: string }): void;
  (e: "menu-tab", payload: { x: number; y: number; viewId: string }): void;
}>();

watch(
  () => store.contextMenu?.viewId || "",
  (viewId) => {
    if (!compactContextMenuViewId.value) return;
    if (viewId === compactContextMenuViewId.value) return;
    compactContextMenuViewId.value = null;
    compactPickerOpen.value = false;
  },
);

function onMenuClick(event: MouseEvent, viewId: string): void {
  const btn = (event.currentTarget || event.target) as Element;
  const rect = btn.getBoundingClientRect();
  emit("menu-tab", { x: rect.left, y: rect.bottom + 4, viewId });
}

async function ensureCompactWorkspaceActive(): Promise<void> {
  if (!props.compact || !props.workspaceId) return;
  const activeWsId = store.myActiveWorkspaceId;
  if (activeWsId !== props.workspaceId) {
    await store.activateWorkspace(props.workspaceId);
  }
}

function activateTab(viewId: string): void {
  void notifications.runWithToast("Switch tab failed", async () => {
    await ensureCompactWorkspaceActive();
    await store.activateView(viewId);
    await nextTick();
    termStore.focusActiveTerminal();
  });
}

// The linked companion badge doubles as the "Back to <Role> loop" action
// (plan §9.1) — mobile has no automatic split, so this is the return path
// besides browser Back. Jumps straight to the companion task workspace
// instead of just activating this tab.
function goToCompanionLoop(workspaceId: string): void {
  void notifications.runWithToast("Couldn't open the companion loop", async () => {
    await store.activateWorkspace(workspaceId);
  });
}

function updateCompactPickerAnchor(): void {
  const rect = compactPickerBtnRef.value?.getBoundingClientRect();
  compactPickerAnchor.value = rect
    ? {
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
      }
    : null;
}

function toggleCompactPicker(): void {
  if (compactPickerOpen.value) {
    closeCompactPicker();
    return;
  }
  updateCompactPickerAnchor();
  compactPickerOpen.value = true;
}

function closeCompactPicker(): void {
  if (compactContextMenuViewId.value && store.contextMenu?.viewId === compactContextMenuViewId.value) {
    store.hideContextMenu();
  }
  compactContextMenuViewId.value = null;
  compactPickerOpen.value = false;
}

async function activateTabFromCompactPicker(viewId: string): Promise<void> {
  compactPickerOpen.value = false;
  await ensureCompactWorkspaceActive();
  activateTab(viewId);
}

async function openCompactTabMenu(event: MouseEvent, viewId: string): Promise<void> {
  const btn = (event.currentTarget || event.target) as Element;
  const rect = btn.getBoundingClientRect();
  await ensureCompactWorkspaceActive();
  compactContextMenuViewId.value = viewId;
  store.showContextMenu(rect.left, rect.bottom + 4, viewId);
}
</script>
