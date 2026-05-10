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

// The chip represents the multi-workspace grid layout only — tab-split
// (panes within a single workspace) is controlled by the terminal-toolbar
// Split button. Mixing the two here was confusing: the chip would say
// "Side by side" while the user was looking at a tab-split workspace,
// and the Unsplit button would disband whichever was active. Keeping
// the two affordances separate makes each control's scope obvious.
const currentLayout = computed<LayoutKey>(() => {
  if (store.isGridVisible) return (store.workspaceGrid?.layout as LayoutKey) || "solo";
  return "solo";
});

const layoutLabel = computed(() => LAYOUTS[currentLayout.value]?.label || "Solo");

const layoutTitle = computed(() =>
  store.isGridVisible
    ? `Workspace grid layout: ${layoutLabel.value}. Click to switch between side-by-side, stacked, top-split, left-split, and 2×2 grid arrangements of multiple workspaces.`
    : "Workspace grid: not active. Click to arrange multiple workspaces side-by-side, stacked, or in a 2×2 grid. Tab-splitting (panes within one workspace) is on the terminal toolbar below.",
);

const canUnsplit = computed(() => store.isGridVisible);

const unsplitTitle = computed(
  () =>
    "Disband the multi-workspace grid — the active workspace returns to a single full-width view. Cell assignments are forgotten.",
);

function onOpenPicker(): void {
  const rect = layoutBtnRef.value?.getBoundingClientRect();
  if (!rect) return;
  store.showLayoutPicker(rect, "grid");
}

function onUnsplit(): void {
  store.disableWorkspaceGrid();
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
