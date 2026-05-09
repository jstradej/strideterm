<template>
  <div class="workspace-cell-header" :class="{ 'workspace-cell-header--focused': focused }">
    <button
      type="button"
      class="workspace-cell-header__btn"
      title="Pick a workspace for this cell"
      @click="$emit('open-picker')"
    >
      ☰
    </button>
    <span class="workspace-cell-header__name" :title="wsName">
      <span v-if="wsIcon" class="workspace-cell-header__icon">{{ wsIcon }}</span>
      {{ wsName }}
    </span>
    <button
      type="button"
      class="workspace-cell-header__btn"
      :class="{ 'workspace-cell-header__btn--swap-active': swapPending }"
      :title="swapPending ? 'Cancel swap' : 'Swap this cell with another (click ↔ on a second cell to swap)'"
      @click="$emit('swap-start')"
    >
      ↔
    </button>
    <button
      type="button"
      class="workspace-cell-header__btn workspace-cell-header__btn--danger"
      title="Remove workspace from this cell"
      @click="$emit('clear')"
    >
      ×
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";

const props = defineProps<{
  workspaceId: string;
  cellIndex: number;
  focused: boolean;
  swapPending?: boolean;
}>();

defineEmits<{
  (e: "open-picker"): void;
  (e: "clear"): void;
  (e: "swap-start"): void;
}>();

const store = useAppStore();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const wsEntry = computed(() => {
  const wsId = props.workspaceId;
  return ((store.payload as AnyApi)?.appState?.workspaces || []).find((ws: AnyApi) => ws.id === wsId) ?? null;
});

const wsName = computed(() => wsEntry.value?.name || props.workspaceId);
const wsIcon = computed(() => wsEntry.value?.icon || "");
</script>
