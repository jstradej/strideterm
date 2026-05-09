<template>
  <Teleport to="body">
    <div v-if="store.layoutPickerAnchor" ref="pickerRef" class="layout-picker" :style="pickerStyle" @click.stop>
      <div class="layout-picker__grid">
        <button
          v-for="[key, layout] in nonSoloLayouts"
          :key="key"
          type="button"
          :class="['layout-picker__item', currentLayout === key && 'layout-picker__item--active']"
          :title="
            store.isGridVisible
              ? `Switch the workspace grid to the ${layout.label} layout — ${layout.slots} workspaces side-by-side. Excess slots beyond ${layout.slots} are dropped; pick new workspaces for empty slots from the cell hamburger menu.`
              : `Switch the active workspace to the ${layout.label} layout — shows ${layout.slots} tabs side-by-side. Pick which tabs fill the slots from the tab bar; right-click an empty slot to add a tab.`
          "
          @click="pickLayout(key)"
        >
          <LayoutThumbnail :layout="key" />
          <span>{{ layout.label }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, type CSSProperties } from "vue";
import { useAppStore } from "../../stores/app.js";
import LayoutThumbnail from "./LayoutThumbnail.vue";

const LAYOUTS = {
  solo: { slots: 1, label: "Solo" },
  cols: { slots: 2, label: "Columns" },
  rows: { slots: 2, label: "Rows" },
  "top-split": { slots: 3, label: "Top split" },
  "left-split": { slots: 3, label: "Left split" },
  grid: { slots: 4, label: "Grid" },
};

const store = useAppStore();
const pickerRef = ref<HTMLElement | null>(null);

const nonSoloLayouts = computed(() => Object.entries(LAYOUTS).filter(([key]) => key !== "solo"));

const currentLayout = computed(() => {
  // In workspace-grid mode the picker controls the grid layout, not the
  // per-workspace splitGroup; reflect that so the active swatch matches.
  if (store.isGridVisible) return store.workspaceGrid?.layout || "solo";
  return store.splitGroup?.layout || "solo";
});

const pickerStyle = ref<CSSProperties>({ position: "fixed", top: "0px", right: "0px", zIndex: 9999 });

watch(
  () => store.layoutPickerAnchor,
  async (anchor) => {
    if (!anchor) return;
    // anchorRect is a serialized DOMRect { top, bottom, left, right, width, height }
    await nextTick();
    if (!pickerRef.value) return;
    const pickerRect = pickerRef.value.getBoundingClientRect();
    let top = anchor.bottom + 4;
    const right = window.innerWidth - anchor.right;
    if (pickerRect.left < 0) {
      pickerStyle.value = { position: "fixed", top: `${top}px`, left: "4px", zIndex: 9999 };
    } else if (pickerRect.bottom > window.innerHeight) {
      top = anchor.top - pickerRect.height - 4;
      pickerStyle.value = { position: "fixed", top: `${top}px`, right: `${right}px`, zIndex: 9999 };
    } else {
      pickerStyle.value = { position: "fixed", top: `${top}px`, right: `${right}px`, zIndex: 9999 };
    }
  },
);

function pickLayout(key: string): void {
  store.pickLayout(key);
  store.hideLayoutPicker();
}

function onDocumentClick(e: MouseEvent): void {
  // Ignore clicks on the Split button itself (it triggers showLayoutPicker)
  if ((e.target as Element).closest("[data-role='tab-actions']")) return;
  if (pickerRef.value && !pickerRef.value.contains(e.target as Node)) {
    store.hideLayoutPicker();
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") store.hideLayoutPicker();
}

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>
