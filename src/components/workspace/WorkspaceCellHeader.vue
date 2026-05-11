<template>
  <div class="workspace-cell-header" :class="{ 'workspace-cell-header--focused': focused }">
    <button
      ref="pickerBtnRef"
      type="button"
      class="workspace-cell-header__picker"
      :title="`Pick a workspace for this cell — currently: ${wsName}`"
      @click="onOpenPicker"
    >
      <span v-if="wsIcon" class="workspace-cell-header__icon">{{ wsIcon }}</span>
      <span class="workspace-cell-header__name">{{ wsName }}</span>
      <span class="workspace-cell-header__chev" aria-hidden="true">▾</span>
    </button>

    <!-- Tab strip is injected via slot from WorkspaceCell so the cell's
         workspace tabs share the header row instead of stacking below it. -->
    <div class="workspace-cell-header__tabs">
      <slot />
    </div>

    <button
      ref="addTabBtnRef"
      type="button"
      class="workspace-cell-header__btn"
      title="Add a new tab to this workspace — pick a Shell, Claude Code, Codex, Gemini, Files, Browser, or any other tab template."
      @click="onAddTab"
    >
      +
    </button>
    <button
      v-for="action in swapActions"
      :key="action.targetIndex"
      type="button"
      class="workspace-cell-header__btn workspace-cell-header__btn--swap"
      :title="action.title"
      @click="$emit('swap', action.targetIndex)"
    >
      {{ action.label }}
    </button>
    <button
      type="button"
      class="workspace-cell-header__btn workspace-cell-header__btn--danger"
      title="Remove workspace from this cell"
      @mousedown.stop
      @click="$emit('clear')"
    >
      ×
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import { SLOT_BOXES, swapDirection, swapArrow } from "../../app/layout-geometry.js";

const props = defineProps<{
  workspaceId: string;
  cellIndex: number;
  focused: boolean;
}>();

const emit = defineEmits<{
  (e: "open-picker", anchorRect: DOMRect): void;
  (e: "clear"): void;
  (e: "swap", targetIndex: number): void;
  (e: "add-tab", anchorRect: DOMRect): void;
}>();

const store = useAppStore();
const pickerBtnRef = ref<HTMLButtonElement | null>(null);
const addTabBtnRef = ref<HTMLButtonElement | null>(null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const wsEntry = computed(() => {
  const wsId = props.workspaceId;
  return ((store.payload as AnyApi)?.appState?.workspaces || []).find((ws: AnyApi) => ws.id === wsId) ?? null;
});

const wsName = computed(() => wsEntry.value?.name || props.workspaceId);
const wsIcon = computed(() => wsEntry.value?.icon || "");

interface SwapAction {
  targetIndex: number;
  label: string;
  title: string;
}

const swapActions = computed<SwapAction[]>(() => {
  // Only the focused cell renders swap controls — otherwise a 4-cell grid
  // would show 4 × 3 = 12 arrow buttons across the workspace, which is
  // visually noisy and pointless (a swap is symmetric, you only need to
  // initiate it from one side).
  if (!props.focused) return [];
  const grid = store.workspaceGrid;
  if (!grid) return [];
  const layout = grid.layout;
  const ids = grid.cellWorkspaceIds as (string | null)[];
  const boxes = SLOT_BOXES[layout];
  if (!Array.isArray(boxes)) return [];
  const srcIdx = props.cellIndex;
  if (!boxes[srcIdx]) return [];
  const out: SwapAction[] = [];

  const allWs = ((store.payload as AnyApi)?.appState?.workspaces || []) as AnyApi[];
  for (let i = 0; i < ids.length; i += 1) {
    if (i === srcIdx || !boxes[i]) continue;
    const [dr, dc] = swapDirection(boxes[srcIdx], boxes[i]);
    const targetWsId = ids[i];
    const targetName = targetWsId ? allWs.find((w) => w.id === targetWsId)?.name || targetWsId : "(empty)";
    out.push({
      targetIndex: i,
      label: swapArrow(dr, dc),
      title: `Swap with ${targetName}`,
    });
  }
  return out;
});

function onOpenPicker(): void {
  if (!pickerBtnRef.value) return;
  emit("open-picker", pickerBtnRef.value.getBoundingClientRect());
}

function onAddTab(): void {
  if (!addTabBtnRef.value) return;
  emit("add-tab", addTabBtnRef.value.getBoundingClientRect());
}
</script>
