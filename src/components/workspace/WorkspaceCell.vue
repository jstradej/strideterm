<template>
  <!-- Empty slot -->
  <div
    v-if="!workspaceId"
    class="workspace-cell workspace-cell--empty"
    :class="{ 'workspace-cell--drag-over': dragOver }"
    @mousedown.prevent="$emit('focus')"
    @dragover.prevent="onDragover"
    @dragleave="onDragleave"
    @drop.prevent="onDrop"
  >
    <button
      type="button"
      class="workspace-cell__pick-btn"
      title="Pick a workspace to display in this cell."
      @click.stop="showPicker = true"
    >
      + Pick workspace…
    </button>
    <WorkspacePickerPopover v-if="showPicker" :cell-index="cellIndex" @close="showPicker = false" />
  </div>

  <!-- Workspace slot -->
  <div
    v-else
    class="workspace-cell"
    :class="{
      'workspace-cell--focused': focused,
      'workspace-cell--drag-over': dragOver,
      'workspace-cell--swap-pending': isSwapPending,
    }"
    @mousedown.capture="onMousedown"
    @dragover.prevent="onDragover"
    @dragleave="onDragleave"
    @drop.prevent="onDrop"
  >
    <WorkspaceCellHeader
      :workspace-id="workspaceId"
      :cell-index="cellIndex"
      :focused="focused"
      :swap-pending="isSwapPending"
      @open-picker="showPicker = true"
      @clear="onClear"
      @swap-start="$emit('swap-start')"
    />

    <!-- Compact tab strip for this cell's workspace -->
    <TabStrip :workspace-id="workspaceId" compact />

    <!-- Active pane content -->
    <div class="workspace-cell__pane">
      <template v-if="activeViewType === 'terminal' && activeViewId">
        <TerminalPane :session-id="activeViewId" />
      </template>
      <template v-else-if="paneComponent">
        <component :is="paneComponent" v-bind="paneProps" :show-header="false" />
      </template>
      <div v-else class="workspace-cell__no-content">
        <span>Select a tab</span>
      </div>
    </div>

    <WorkspacePickerPopover v-if="showPicker" :cell-index="cellIndex" @close="showPicker = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import {
  isGitViewId,
  isDockerViewId,
  isAzureViewId,
  isGitHubViewId,
  isReviewViewId,
  isFilesViewId,
  isTaskDashboardViewId,
  isBrowserViewId,
} from "../../app/helpers.js";
import { resolvePaneComponent, resolvePaneProps } from "../../app/pane-resolver.js";
import WorkspaceCellHeader from "./WorkspaceCellHeader.vue";
import WorkspacePickerPopover from "./WorkspacePickerPopover.vue";
import TabStrip from "../layout/TabStrip.vue";
import TerminalPane from "./TerminalPane.vue";

const props = defineProps<{
  workspaceId: string | null;
  cellIndex: number;
  focused: boolean;
  swapPendingCell?: number | null;
}>();

const emit = defineEmits<{
  (e: "focus"): void;
  (e: "swap-start"): void;
}>();

const store = useAppStore();
const termStore = useTerminalStore();
const showPicker = ref(false);
const dragOver = ref(false);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const isSwapPending = computed(() => props.swapPendingCell != null && props.swapPendingCell === props.cellIndex);

const workspaceEntry = computed(() => {
  if (!props.workspaceId) return null;
  const wsId = props.workspaceId;
  return ((store.payload as AnyApi)?.appState?.workspaces || []).find((ws: AnyApi) => ws.id === wsId) ?? null;
});

const activeViewId = computed<string | null>(() => {
  if (!props.workspaceId) return null;
  // For focused cell, use live activeViewId from store
  if (props.focused) return store.activeViewId;
  // For non-focused, use the workspace's persisted activeViewId
  return workspaceEntry.value?.activeViewId ?? null;
});

const activeViewType = computed<string>(() => {
  const viewId = activeViewId.value;
  if (!viewId) return "";
  if (isGitViewId(viewId)) return "git";
  if (isDockerViewId(viewId)) return "docker";
  if (isAzureViewId(viewId)) return "azure";
  if (isGitHubViewId(viewId)) return "github";
  if (isReviewViewId(viewId)) return "review";
  if (isFilesViewId(viewId)) return "files";
  if (isTaskDashboardViewId(viewId)) return "task-dashboard";
  if (isBrowserViewId(viewId)) return "browser";
  // Check headless judge
  const wsId = props.workspaceId;
  if (wsId) {
    const taskState = (store.payload as AnyApi)?.taskRunner?.[wsId];
    if (taskState?.judgeExecutionMode === "headless-copilot") {
      const panelId = viewId.includes(":") ? viewId.split(":").pop() : viewId;
      if (panelId === taskState.judgePanelId) return "headless-judge";
    }
  }
  return "terminal";
});

const paneComponent = computed(() => resolvePaneComponent(activeViewType.value));

const paneProps = computed(() => resolvePaneProps(activeViewType.value, activeViewId.value || ""));

function onMousedown(event: MouseEvent): void {
  if (!props.focused) {
    emit("focus");
    // Also focus the workspace
    if (props.workspaceId) store.activateWorkspace(props.workspaceId);
  }
  // If clicking inside terminal area, also focus terminal
  const paneEl = (event.target as Element)?.closest(".workspace-cell__pane");
  if (paneEl && activeViewType.value === "terminal") {
    termStore.focusActiveTerminal();
  }
}

function onClear(): void {
  store.setGridCell(props.cellIndex, null);
}

function onGridCellPickerEvent(event: Event): void {
  const detail = (event as CustomEvent).detail as { cellIndex: number };
  if (detail.cellIndex === props.cellIndex) showPicker.value = true;
}

onMounted(() => {
  window.addEventListener("open-grid-cell-picker", onGridCellPickerEvent);
});
onUnmounted(() => {
  window.removeEventListener("open-grid-cell-picker", onGridCellPickerEvent);
});

function onDragover(event: DragEvent): void {
  if (event.dataTransfer?.types?.includes("workspace-id")) {
    dragOver.value = true;
    event.dataTransfer.dropEffect = "copy";
  }
}

function onDragleave(): void {
  dragOver.value = false;
}

async function onDrop(event: DragEvent): Promise<void> {
  dragOver.value = false;
  const wsId = event.dataTransfer?.getData("workspace-id");
  if (!wsId) return;
  await store.setGridCell(props.cellIndex, wsId);
  await store.activateWorkspace(wsId);
}
</script>
