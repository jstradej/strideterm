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
      @click="store.activateView(tab.id).then(() => nextTick(() => termStore.focusActiveTerminal()))"
      @dblclick="!compact && tab.persistent && $emit('edit-tab', tab.id)"
      @dragstart="!compact && dragDrop.onDragstart($event)"
      @contextmenu.prevent="
        !compact && $emit('contextmenu-tab', { x: $event.clientX, y: $event.clientY, viewId: tab.id })
      "
    >
      <span>{{ tab.title }}</span>
      <small v-if="tab.taskBadge" class="tab__task-badge" :title="tab.taskTooltip">{{ tab.taskBadge }}</small>
      <small v-else>{{ tab.status }}</small>
      <span v-if="tab.attention" class="tab__attention" :title="tab.attentionTooltip">🔔</span>
      <span
        v-if="!compact"
        class="tab__menu"
        title="Open the tab actions menu (Focus, Edit, Save scrollback, Clear, Restart, Close, split moves) — same options as the right-click context menu but reachable on touch devices."
        @click.stop="onMenuClick($event, tab.id)"
        >☰</span
      >
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { useTabDragDrop } from "../../composables/useDragDrop.js";
import { isFreshAlert, tabAttentionTitle } from "../../app/helpers.js";

interface TaskRunnerState {
  workerPanelId?: string;
  judgePanelId?: string;
  state?: string;
  currentRound?: number;
  maxRounds?: number;
}

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
const stripRef = ref<HTMLElement | null>(null);
const dragDrop = useTabDragDrop(stripRef);

// In compact mode for a non-active workspace, derive minimal tab models from persisted panels.
const compactTabModels = computed(() => {
  if (!props.compact || !props.workspaceId) return null;
  const wsId = props.workspaceId;
  const activeWsId = (store.payload as AnyApi)?.appState?.activeWorkspaceId;
  // If this cell is the active workspace, the normal tabModels computation handles it.
  if (wsId === activeWsId) return null;
  const wsEntry = ((store.payload as AnyApi)?.appState?.workspaces || []).find((w: AnyApi) => w.id === wsId);
  if (!wsEntry) return [];
  const activeViewId = wsEntry.activeViewId || null;
  const panels: AnyApi[] = wsEntry.panels || [];
  return panels.map((p: AnyApi) => ({
    id: p.id,
    title: p.title || p.id,
    status: "",
    tone: "idle",
    active: p.id === activeViewId,
    grouped: false,
    persistent: true,
    closable: true,
    attention: false,
    attentionFresh: false,
    attentionTooltip: "",
    taskBadge: "",
    taskTooltip: "",
    titleTooltip: p.title || p.id,
  }));
});

const tabModels = computed(() => {
  if (compactTabModels.value !== null) return compactTabModels.value;

  const tabs = store.workspaceTabs;
  const activeViewId = store.activeViewId;
  const splitGroup = store.splitGroup;

  const workspace = store.activeWorkspace;
  const taskState = store.payload?.taskRunner?.[workspace?.id] as TaskRunnerState | undefined;

  return tabs.map((tab) => {
    const tabAttention = store.getTabAttentionForView(workspace?.id || "", tab.id) as AttentionAlert | null | undefined;

    // Task runner badge for worker/judge panels
    let taskBadge = "";
    let taskTooltip = "";
    if (taskState && workspace?.task) {
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

    // When the tab has an attention alert, the bell already conveys
    // "agent needs input". Keeping the activity chip visible ("running")
    // contradicts that — suppress the chip so the bell speaks alone.
    const suppressStatus = !!tabAttention;
    return {
      id: tab.id,
      title: tab.title,
      status: suppressStatus ? "" : tab.status,
      tone: suppressStatus ? "idle" : tab.tone,
      active: tab.id === activeViewId,
      grouped: splitGroup?.viewIds.includes(tab.id) || false,
      persistent: !!tab.persistent,
      closable: tab.closable !== false,
      attention: !!tabAttention,
      attentionFresh: isFreshAlert(tabAttention),
      attentionTooltip: tabAttentionTitle(tabAttention),
      taskBadge,
      taskTooltip,
      titleTooltip:
        taskTooltip ||
        tabAttentionTitle(tabAttention) ||
        (tab.persistent
          ? "Double click to edit. Drag to reorder."
          : `${tab.title}${tab.status ? `\n${tab.status}` : ""}`),
    };
  });
});

const emit = defineEmits<{
  (e: "edit-tab", viewId: string): void;
  (e: "contextmenu-tab", payload: { x: number; y: number; viewId: string }): void;
  (e: "menu-tab", payload: { x: number; y: number; viewId: string }): void;
}>();

function onMenuClick(event: MouseEvent, viewId: string): void {
  const btn = (event.currentTarget || event.target) as Element;
  const rect = btn.getBoundingClientRect();
  emit("menu-tab", { x: rect.left, y: rect.bottom + 4, viewId });
}
</script>
