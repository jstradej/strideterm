<template>
  <div
    v-if="store.workspaceGrid"
    class="workspace-grid"
    :class="narrowMode ? 'workspace-grid--solo' : `workspace-grid--${store.workspaceGrid.layout}`"
    :data-layout="store.workspaceGrid.layout"
  >
    <article
      v-for="cell in renderedCells"
      :key="cell.index"
      class="workspace-grid__cell"
      :class="{
        'workspace-grid__cell--focused': cell.index === store.focusedGridCellIndex,
        'workspace-grid__cell--empty': !cell.workspaceId,
      }"
      :style="cellStyle(cell.index)"
    >
      <WorkspaceCell
        :workspace-id="cell.workspaceId"
        :cell-index="cell.index"
        :focused="cell.index === store.focusedGridCellIndex"
        @focus="onCellFocus(cell.index)"
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

/**
 * The grid cells to actually MOUNT.
 *
 * Wide layout renders every cell. A narrow (mobile) layout shows only the
 * focused cell, so we render ONLY that one instead of hiding the rest with
 * `v-show`: a hidden-but-mounted cell keeps its non-terminal panes mounted, and
 * those panes declare detail interest (`useResourceInterest`) — so a phone would
 * keep fetching git/docker/inbox/review detail for panes it cannot see. Mounting
 * just the focused cell releases the hidden interests (a narrow layout
 * contributes only its focused visible pane, per the plan). Terminal views
 * survive in the terminal store across unmount and re-attach on remount, so no
 * terminal state is lost when the focused cell changes.
 */
const renderedCells = computed<Array<{ workspaceId: string | null; index: number }>>(() => {
  const ids = (store.workspaceGrid?.cellWorkspaceIds ?? []) as Array<string | null>;
  const cells = ids.map((workspaceId, index) => ({ workspaceId, index }));
  if (!narrowMode.value) return cells;
  const focused = store.focusedGridCellIndex;
  const cell = cells.find((c) => c.index === focused);
  return cell ? [cell] : cells.slice(0, 1);
});

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
