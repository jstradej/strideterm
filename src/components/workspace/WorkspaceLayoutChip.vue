<template>
  <!-- Inline layout picker chip + Unsplit-all action.
       Lives in WorkspaceHero so the user can rearrange the workspace grid /
       split layout from the persistent top strip — even when the regular
       terminal-toolbar is hidden (which happens whenever the multi-workspace
       grid is visible). Keeps the controls reachable without forcing the user
       to disband the grid first. -->
  <div v-if="!isMobile && store.activeWorkspace" class="workspace-layout-chip-group">
    <button
      ref="layoutBtnRef"
      type="button"
      class="workspace-layout-chip"
      :class="{ 'workspace-layout-chip--active': currentLayout !== 'solo' }"
      data-role="workspace-layout-chip"
      :title="layoutTitle"
      @click="onOpenPicker"
    >
      <LayoutThumbnail
        :layout="currentLayout"
        class-name="workspace-layout-chip__thumb"
        :primary-opacity="currentLayout === 'solo' ? 0.45 : 0.6"
        :secondary-opacity="0.3"
      />
      <span class="workspace-layout-chip__label">{{ layoutLabel }}</span>
    </button>

    <button
      v-if="canUnsplit"
      type="button"
      class="workspace-layout-chip workspace-layout-chip--unsplit"
      :title="unsplitTitle"
      @click="onUnsplit"
    >
      Unsplit
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import LayoutThumbnail from "../layout/LayoutThumbnail.vue";

const LAYOUTS = {
  solo: { label: "Solo" },
  cols: { label: "Side by side" },
  rows: { label: "Stacked" },
  "top-split": { label: "Top + 2 bottom" },
  "left-split": { label: "Left + 2 right" },
  grid: { label: "2 × 2 grid" },
} as const;
type LayoutKey = keyof typeof LAYOUTS;

const store = useAppStore();
const { isMobile } = useIsNarrow();
const layoutBtnRef = ref<HTMLButtonElement | null>(null);

const currentLayout = computed<LayoutKey>(() => {
  if (store.isGridVisible) return (store.workspaceGrid?.layout as LayoutKey) || "solo";
  const sg = store.splitGroup;
  if (!sg) return "solo";
  return store.activeViewId && sg.viewIds.includes(store.activeViewId) ? (sg.layout as LayoutKey) : "solo";
});

const layoutLabel = computed(() => LAYOUTS[currentLayout.value]?.label || "Solo");

const layoutTitle = computed(() =>
  store.isGridVisible
    ? `Workspace grid layout: ${layoutLabel.value}. Click to switch between side-by-side, stacked, top-split, left-split, and 2×2 grid arrangements of multiple workspaces.`
    : `Tab split layout: ${layoutLabel.value}. Click to split the active workspace's tabs across the cell — side-by-side, stacked, top-split, left-split, or 2×2 grid.`,
);

const canUnsplit = computed(() => store.isGridVisible || !!store.splitGroup);

const unsplitTitle = computed(() =>
  store.isGridVisible
    ? "Disband the multi-workspace grid — the active workspace returns to a single full-width view. Cell assignments are forgotten."
    : "Disband the current tab-split — the active tab returns to a single full-width pane and the other split tabs go back into the regular tab strip.",
);

function onOpenPicker(): void {
  const rect = layoutBtnRef.value?.getBoundingClientRect();
  if (!rect) return;
  // Always operate on the multi-workspace grid — the chip lives in the
  // workspace hero and represents "how many workspaces are visible". Tab
  // splitting stays on the terminal-toolbar Split button so the two
  // affordances stop competing for the same picker.
  store.showLayoutPicker(rect, "grid");
}

function onUnsplit(): void {
  if (store.isGridVisible) {
    store.disableWorkspaceGrid();
  } else {
    store.disbandSplit();
  }
}
</script>

<style>
.workspace-layout-chip-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.workspace-layout-chip {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid color-mix(in srgb, var(--accent), transparent 72%);
  background: rgba(var(--tint), 0.04);
  color: var(--text);
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
  transition:
    border-color 0.12s,
    background 0.12s,
    color 0.12s;
}

.workspace-layout-chip:hover {
  border-color: color-mix(in srgb, var(--accent), transparent 40%);
  background: rgba(var(--tint), 0.08);
}

.workspace-layout-chip--active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent), transparent 82%);
  color: var(--accent);
}

.workspace-layout-chip__thumb {
  width: 24px;
  height: 18px;
  flex-shrink: 0;
  color: currentColor;
}

.workspace-layout-chip__label {
  letter-spacing: 0.01em;
}

.workspace-layout-chip--unsplit {
  color: var(--muted);
  border-color: rgba(var(--tint), 0.12);
  background: transparent;
  font-size: 11px;
  padding: 2px 8px;
}

.workspace-layout-chip--unsplit:hover {
  color: var(--danger);
  border-color: rgba(255, 111, 141, 0.35);
  background: rgba(255, 111, 141, 0.06);
}
</style>
