<template>
  <div
    v-if="store.workspaceGrid"
    class="workspace-grid"
    :class="narrowMode ? 'workspace-grid--solo' : `workspace-grid--${store.workspaceGrid.layout}`"
    :data-layout="store.workspaceGrid.layout"
  >
    <article
      v-for="(workspaceId, index) in store.workspaceGrid.cellWorkspaceIds"
      v-show="!narrowMode || index === store.focusedGridCellIndex"
      :key="index"
      class="workspace-grid__cell"
      :class="{
        'workspace-grid__cell--focused': index === store.focusedGridCellIndex,
        'workspace-grid__cell--empty': !workspaceId,
      }"
      :style="cellStyle(Number(index))"
    >
      <WorkspaceCell
        :workspace-id="workspaceId"
        :cell-index="Number(index)"
        :focused="index === store.focusedGridCellIndex"
        @focus="onCellFocus(Number(index))"
      />
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";
import { AREA_LAYOUTS, AREA_NAMES } from "../../app/layout-geometry.js";
import { isMobileViewport } from "../../composables/useIsNarrow.js";
import WorkspaceCell from "./WorkspaceCell.vue";

const store = useAppStore();

const narrowMode = computed(() => isMobileViewport.value);

function cellStyle(index: number): Record<string, string> {
  if (narrowMode.value) return {};
  const layout = store.workspaceGrid?.layout ?? "";
  if (!AREA_LAYOUTS.has(layout)) return {};
  const area = AREA_NAMES[index as 0 | 1 | 2 | 3];
  return area ? { gridArea: area } : {};
}

function onCellFocus(index: number): void {
  const ids = store.workspaceGrid?.cellWorkspaceIds;
  if (!ids) return;
  const wsId = ids[index];
  if (wsId) store.activateWorkspace(wsId);
}
</script>
